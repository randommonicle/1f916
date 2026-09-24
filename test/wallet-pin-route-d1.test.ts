// The server-side wallet pin, the pay route end to end
// (docs/BRIEF-SERVER-SIDE-WALLET-PIN.md §6 tests 1-5 and 10, A5's per-clause
// proof; the migration and the helper live in wallet-pin-d1.test.ts).
//
// The x402 facilitator is genuinely external, so its HTTP surface is stubbed
// via globalThis.fetch exactly as listings-d1.test.ts stubs it. Nothing about
// the route, the chain or D1 is mocked: createLocalD1 is real SQLite with the
// real schema.sql, and every wallet is declared through the real appendChained.
// A test that edits a row directly (the wallets table, an identity row) is
// simulating the database holder, which the pin is documented NOT to stop; it
// proves the route refuses rather than pays when the record disagrees.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createLocalD1, insertCitizen, insertListing, insertSubmission, type LocalD1 } from "./helpers/local-d1.ts";
import { declareTestWallet, type WalletRowPin } from "./helpers/wallet-pin.ts";
import { paymentHeaderFor, atomicFromCents } from "./helpers/x402-payload.ts";
import { handlePayListing, getListingDetail, listingPaymentsPage } from "../src/listings.ts";
import { appendChained } from "../src/chain.ts";
import { SocietyError, type Env } from "../src/society.ts";

const TREASURY_ADDRESS = "0xa7f7985eb19b8c44f12a0654df1ef89d1dd527c9";
const FACILITATOR_URL = "https://facilitator.example.invalid";
const WALLET_A = "0x" + "0a".repeat(20);
const WALLET_B = "0x" + "0b".repeat(20);
const WALLET_C = "0x" + "0c".repeat(20);
const BOUNTY = 1200;

function testEnv(d1: LocalD1): Env {
  return { DB: d1.DB, TREASURY_ADDRESS, FACILITATOR_URL, REGISTRATION_MODE: "open" } as unknown as Env;
}
async function loadCitizen(d1: LocalD1, id: number) {
  return d1.raw.prepare("SELECT id, handle, model, karma, created_at, last_seen_at FROM citizens WHERE id = ?").get(id) as {
    id: number;
    handle: string;
    model: string;
    karma: number;
    created_at: number;
    last_seen_at: number;
  };
}

// The facilitator: onVerify runs in the window between check 1 and the
// reservation (the race window); `settle` picks the /settle answer.
function stubFacilitator(hooks: { onVerify?: () => Promise<void> | void; settle?: "ok" | "refused" | "unreadable" } = {}) {
  const original = globalThis.fetch;
  const calls = { verify: 0, settle: 0, settlePayTo: null as string | null };
  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    const href = String(url);
    if (href === `${FACILITATOR_URL}/verify`) {
      calls.verify++;
      await hooks.onVerify?.();
      return new Response(JSON.stringify({ isValid: true }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (href === `${FACILITATOR_URL}/settle`) {
      calls.settle++;
      calls.settlePayTo = (JSON.parse(String(init?.body)) as { paymentRequirements: { payTo: string } }).paymentRequirements.payTo;
      if (hooks.settle === "unreadable") return new Response("<html>bad gateway</html>", { status: 502, headers: { "content-type": "text/html" } });
      if (hooks.settle === "refused") return new Response(JSON.stringify({ success: false, errorReason: "insufficient_funds" }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ success: true, payer: "0x00000000000000000000000000000000000000fa", transaction: "0x" + "ab".repeat(32) }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch in wallet-pin-route-d1.test.ts: ${href}`);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

interface Fixture {
  d1: LocalD1;
  env: Env;
  funder: Awaited<ReturnType<typeof loadCitizen>>;
  reviewerId: number;
  listingId: number;
  submissionId: number;
  row: WalletRowPin;
}
async function fixture(): Promise<Fixture> {
  const d1 = createLocalD1();
  const env = testEnv(d1);
  const funderId = insertCitizen(d1);
  const funder = await loadCitizen(d1, funderId);
  const reviewerId = insertCitizen(d1);
  const row = await declareTestWallet(d1, reviewerId, WALLET_A);
  const listingId = insertListing(d1, { funder_citizen_id: funderId, bounty_cents: BOUNTY });
  const submissionId = insertSubmission(d1, { listing_id: listingId, citizen_id: reviewerId });
  return { d1, env, funder, reviewerId, listingId, submissionId, row };
}

// A pay request carrying `pin` (or none), signed for `to` (default: the
// payee's current table wallet, as the route derives payTo), or a probe with
// no X-PAYMENT at all when `probe` is set.
function payReq(f: Fixture, pin: Record<string, unknown> | null, opts: { probe?: boolean; to?: string } = {}): Request {
  const w = f.d1.raw.prepare("SELECT address FROM wallets WHERE citizen_id = ?").get(f.reviewerId) as { address: string };
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (!opts.probe) headers["X-PAYMENT"] = paymentHeaderFor(opts.to ?? w.address, atomicFromCents(BOUNTY));
  return new Request(`https://example.test/api/listing/${f.listingId}/pay`, {
    method: "POST",
    headers,
    body: JSON.stringify({ submission_id: f.submissionId, ...(pin ?? {}) }),
  });
}
const pinOf = (r: WalletRowPin) => ({ wallet_row_id: r.id, wallet_row_hash: r.hash });

function listingRow(f: Fixture) {
  return f.d1.raw.prepare("SELECT status, paying_since, paying_wallet_row_id, paying_wallet_row_hash FROM listings WHERE id = ?").get(f.listingId) as {
    status: string;
    paying_since: number | null;
    paying_wallet_row_id: number | null;
    paying_wallet_row_hash: string | null;
  };
}
function bookRows(f: Fixture) {
  const rows = f.d1.raw.prepare("SELECT payee_address, wallet_row_id, wallet_row_hash FROM listing_payments WHERE listing_id = ?").all(f.listingId) as {
    payee_address: string;
    wallet_row_id: number | null;
    wallet_row_hash: string | null;
  }[];
  return rows.map((r) => ({ ...r })); // node:sqlite rows have a null prototype
}
async function refusedWith(p: Promise<unknown>, status: number, code: string, label: string) {
  await assert.rejects(p, (e: unknown) => {
    assert.ok(e instanceof SocietyError, `${label}: a SocietyError`);
    assert.equal(e.status, status, `${label}: status`);
    assert.equal(e.code, code, `${label}: code`);
    return true;
  });
}

test("test 1, happy path: the newest row pinned -> 200; the success body, the book row and the settlement destination all carry that row, and the listing's reserved pair is cleared once paid", async () => {
  const f = await fixture();
  const stub = stubFacilitator();
  try {
    const res = await handlePayListing(payReq(f, pinOf(f.row)), f.env, f.funder, f.listingId);
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
    const body = (await res.json()) as { wallet_row_id: number; wallet_row_hash: string; payee_address: string };
    assert.equal(body.wallet_row_id, f.row.id);
    assert.equal(body.wallet_row_hash, f.row.hash);
    assert.equal(body.payee_address, WALLET_A);
    assert.deepEqual(bookRows(f), [{ payee_address: WALLET_A, wallet_row_id: f.row.id, wallet_row_hash: f.row.hash }]);
    assert.equal(stub.calls.settlePayTo, WALLET_A, "the settlement destination is the address the pinned row names");
    const l = listingRow(f);
    assert.equal(l.status, "paid");
    assert.equal(l.paying_wallet_row_id, null, "cleared wherever paying_since is (A6)");
    assert.equal(l.paying_wallet_row_hash, null);
  } finally {
    stub.restore();
    f.d1.close();
  }
});

test("test 2: every check-1 refusal is decided free -- on the probe (no X-PAYMENT) it is an error, never a 402; with a payment attached the facilitator is never called; nothing is reserved or recorded", async () => {
  const cases: { label: string; status: number; code: string; setup: (f: Fixture) => Promise<Record<string, unknown> | null> }[] = [
    { label: "required: no pin at all", status: 400, code: "wallet_row_required", setup: async () => null },
    { label: "required: the hash missing", status: 400, code: "wallet_row_required", setup: async (f) => ({ wallet_row_id: f.row.id }) },
    { label: "malformed: the id as a string", status: 400, code: "wallet_row_malformed", setup: async (f) => ({ wallet_row_id: String(f.row.id), wallet_row_hash: f.row.hash }) },
    { label: "malformed: id 0", status: 400, code: "wallet_row_malformed", setup: async (f) => ({ wallet_row_id: 0, wallet_row_hash: f.row.hash }) },
    { label: "malformed: the hash upper-cased", status: 400, code: "wallet_row_malformed", setup: async (f) => ({ wallet_row_id: f.row.id, wallet_row_hash: f.row.hash.toUpperCase() }) },
    { label: "missing: no such row", status: 409, code: "wallet_row_missing", setup: async (f) => ({ wallet_row_id: 999_999, wallet_row_hash: f.row.hash }) },
    {
      label: "kind: a chained row that is not a wallet row",
      status: 409,
      code: "wallet_row_kind",
      setup: async (f) => {
        const sealed = await appendChained(f.d1.DB, "identity_events", { citizen_id: f.reviewerId, kind: "model_correction", detail: "model: a -> b", created_at: Date.now() });
        const id = (f.d1.raw.prepare("SELECT id FROM identity_events WHERE hash = ?").get(sealed.hash) as { id: number }).id;
        return { wallet_row_id: id, wallet_row_hash: sealed.hash };
      },
    },
    {
      label: "citizen: another citizen's wallet row",
      status: 409,
      code: "wallet_row_citizen",
      setup: async (f) => pinOf(await declareTestWallet(f.d1, insertCitizen(f.d1), WALLET_C)),
    },
    {
      label: "superseded: a later change to another address",
      status: 409,
      code: "wallet_row_superseded",
      setup: async (f) => {
        await declareTestWallet(f.d1, f.reviewerId, WALLET_B);
        return pinOf(f.row);
      },
    },
    {
      label: "superseded: away and back to the SAME address (A -> B -> A), pinning the first declaration",
      status: 409,
      code: "wallet_row_superseded",
      setup: async (f) => {
        await declareTestWallet(f.d1, f.reviewerId, WALLET_B);
        await declareTestWallet(f.d1, f.reviewerId, WALLET_A);
        return pinOf(f.row);
      },
    },
    { label: "hash: the right row, another hash", status: 409, code: "wallet_row_hash", setup: async (f) => ({ wallet_row_id: f.row.id, wallet_row_hash: "e".repeat(64) }) },
  ];
  for (const c of cases) {
    for (const probe of [true, false]) {
      const f = await fixture();
      const stub = stubFacilitator();
      try {
        const pin = await c.setup(f);
        await refusedWith(handlePayListing(payReq(f, pin, { probe }), f.env, f.funder, f.listingId), c.status, c.code, `${c.label} (${probe ? "probe" : "paid"})`);
        assert.equal(stub.calls.verify, 0, `${c.label}: /verify never called`);
        assert.equal(stub.calls.settle, 0, `${c.label}: /settle never called`);
        assert.equal(listingRow(f).status, "open", `${c.label}: nothing reserved`);
        assert.equal(bookRows(f).length, 0, `${c.label}: nothing recorded`);
      } finally {
        stub.restore();
        f.d1.close();
      }
    }
  }
});

test("positive control for test 2: the same harness with the newest row pinned and no X-PAYMENT DOES reach the 402 naming WALLET_A (so the refusals above are the checks, not a broken harness)", async () => {
  const f = await fixture();
  const stub = stubFacilitator();
  try {
    const res = await handlePayListing(payReq(f, pinOf(f.row), { probe: true }), f.env, f.funder, f.listingId);
    assert.equal(res.status, 402);
    const challenge = (await res.json()) as { accepts: { payTo: string; maxAmountRequired: string }[] };
    assert.equal(challenge.accepts[0].payTo, WALLET_A);
    assert.equal(challenge.accepts[0].maxAmountRequired, atomicFromCents(BOUNTY));
  } finally {
    stub.restore();
    f.d1.close();
  }
});

test("test 3, CODEX's counterexample: the chained row names A, the wallets table is edited to B -> refused 409 wallet_row_address on the probe and with a payment; B is never paid", async () => {
  for (const probe of [true, false]) {
    const f = await fixture();
    const stub = stubFacilitator();
    try {
      f.d1.raw.prepare("UPDATE wallets SET address = ? WHERE citizen_id = ?").run(WALLET_B, f.reviewerId);
      await refusedWith(handlePayListing(payReq(f, pinOf(f.row), { probe }), f.env, f.funder, f.listingId), 409, "wallet_row_address", `table B, chain A (${probe ? "probe" : "paid"})`);
      assert.equal(stub.calls.settle, 0, "nothing settles");
      assert.equal(stub.calls.settlePayTo, null, "B is never paid");
      assert.equal(listingRow(f).status, "open");
    } finally {
      stub.restore();
      f.d1.close();
    }
  }
});

test("test 4, the race: a wallet_changed row appended after check 1 and before the reservation -> the reservation matches 0 rows, 409, nothing settles, the listing stays open with no pair", async () => {
  const f = await fixture();
  const stub = stubFacilitator({
    onVerify: async () => {
      await declareTestWallet(f.d1, f.reviewerId, WALLET_B);
    },
  });
  try {
    await assert.rejects(
      handlePayListing(payReq(f, pinOf(f.row)), f.env, f.funder, f.listingId),
      (e: unknown) => e instanceof SocietyError && e.status === 409 && e.message.includes("no longer the payee's newest"),
    );
    assert.equal(stub.calls.verify, 1, "check 1 passed and /verify ran: the refusal is the reservation's");
    assert.equal(stub.calls.settle, 0);
    const l = listingRow(f);
    assert.equal(l.status, "open");
    assert.equal(l.paying_since, null);
    assert.equal(l.paying_wallet_row_id, null);
    assert.equal(bookRows(f).length, 0);
  } finally {
    stub.restore();
    f.d1.close();
  }
});

test("test 5 and A5's per-clause proof: after check 1, a database-holder edit to the pinned row's hash, kind or citizen, or its deletion, each makes the reservation refuse on its own; nothing settles", async () => {
  const edits: { label: string; sql: string; args: (f: Fixture) => (string | number)[] }[] = [
    { label: "hash rewritten (test 5)", sql: "UPDATE identity_events SET hash = ? WHERE id = ?", args: (f) => ["f".repeat(64), f.row.id] },
    { label: "kind rewritten", sql: "UPDATE identity_events SET kind = 'model_correction' WHERE id = ?", args: (f) => [f.row.id] },
    { label: "citizen rewritten", sql: "UPDATE identity_events SET citizen_id = ? WHERE id = ?", args: (f) => [f.funder.id, f.row.id] },
    { label: "row deleted", sql: "DELETE FROM identity_events WHERE id = ?", args: (f) => [f.row.id] },
  ];
  for (const e of edits) {
    const f = await fixture();
    const stub = stubFacilitator({
      onVerify: () => {
        f.d1.raw.prepare(e.sql).run(...e.args(f));
      },
    });
    try {
      await assert.rejects(handlePayListing(payReq(f, pinOf(f.row)), f.env, f.funder, f.listingId), (err: unknown) => err instanceof SocietyError && err.status === 409, e.label);
      assert.equal(stub.calls.verify, 1, `${e.label}: check 1 passed first`);
      assert.equal(stub.calls.settle, 0, `${e.label}: nothing settles`);
      assert.equal(listingRow(f).status, "open", `${e.label}: not reserved`);
    } finally {
      stub.restore();
      f.d1.close();
    }
  }
});

test("A5: the reservation statement's placeholders and its bind arguments are both eleven, in the stated order", () => {
  const src = readFileSync(join(import.meta.dirname, "..", "src", "listings.ts"), "utf8");
  const m = /const reserved = await env\.DB\.prepare\(\s*`([\s\S]*?)`,?\s*\)\s*\.bind\(([^)]*)\)/.exec(src);
  assert.ok(m, "the reservation statement is found");
  assert.equal((m[1].match(/\?/g) ?? []).length, 11, "eleven placeholders");
  const binds = m[2].split(",").map((s) => s.trim());
  assert.deepEqual(binds, ["at", "pin.walletRowId", "pin.walletRowHash", "listingId", "at", "submissionId", "pin.walletRowId", "submission.citizen_id", "pin.walletRowHash", "submission.citizen_id", "pin.walletRowId"]);
});

test("test 10, the pay-route half (A6): a /settle whose answer cannot be read -> the 502 carries the pair and the listing KEEPS it; a refused /settle releases the listing and clears it", async () => {
  {
    const f = await fixture();
    const stub = stubFacilitator({ settle: "unreadable" });
    try {
      const res = await handlePayListing(payReq(f, pinOf(f.row)), f.env, f.funder, f.listingId);
      assert.equal(res.status, 502);
      const body = (await res.json()) as { error: string; wallet_row_id: number; wallet_row_hash: string; message: string };
      assert.equal(body.error, "settlement_unconfirmed");
      assert.equal(body.wallet_row_id, f.row.id);
      assert.equal(body.wallet_row_hash, f.row.hash);
      assert.ok(body.message.includes(`against the wallet row recorded here (${f.row.id}), never whichever row is newest`), body.message);
      const l = listingRow(f);
      assert.equal(l.status, "paying");
      assert.equal(l.paying_wallet_row_id, f.row.id, "the reservation recorded the checked pair and the 502 path keeps it");
      assert.equal(l.paying_wallet_row_hash, f.row.hash);
    } finally {
      stub.restore();
      f.d1.close();
    }
  }
  {
    const f = await fixture();
    const stub = stubFacilitator({ settle: "refused" });
    try {
      const res = await handlePayListing(payReq(f, pinOf(f.row)), f.env, f.funder, f.listingId);
      assert.equal(res.status, 402);
      const l = listingRow(f);
      assert.equal(l.status, "open", "released");
      assert.equal(l.paying_wallet_row_id, null, "the pair is cleared with paying_since");
      assert.equal(l.paying_wallet_row_hash, null);
    } finally {
      stub.restore();
      f.d1.close();
    }
  }
});

type Detail = {
  listing: { status: string; paying_wallet_row_id?: number | null; paying_wallet_row_hash?: string | null; settlement?: string };
  submissions: { id: number; payee_wallet_row: { id: number; hash: string | null; address: string | null } | null }[];
  payee_wallet_row_note: string;
};

test("test 10, the served half (A6): while a payment is unresolved GET /api/listing/:id serves the checked pair beside the settlement; an open listing serves neither", async () => {
  const f = await fixture();
  const stub = stubFacilitator({ settle: "unreadable" });
  try {
    const before = (await getListingDetail(f.env, f.listingId)) as unknown as Detail;
    assert.equal(before.listing.settlement, undefined);
    assert.equal("paying_wallet_row_id" in before.listing, false, "an open listing serves no reserved pair");
    const res = await handlePayListing(payReq(f, pinOf(f.row)), f.env, f.funder, f.listingId);
    assert.equal(res.status, 502);
    const during = (await getListingDetail(f.env, f.listingId)) as unknown as Detail;
    assert.ok(during.listing.settlement?.startsWith("pending since"), during.listing.settlement);
    assert.equal(during.listing.paying_wallet_row_id, f.row.id);
    assert.equal(during.listing.paying_wallet_row_hash, f.row.hash);
  } finally {
    stub.restore();
    f.d1.close();
  }
});

test("test 11 (A7): GET /api/listing/:id serves each submission's payee newest wallet row -- id, hash and the address it makes current -- following a change, null for a submitter with no wallet row, and address null (never dropped) for a row that does not parse", async () => {
  const f = await fixture();
  try {
    let d = (await getListingDetail(f.env, f.listingId)) as unknown as Detail;
    assert.deepEqual({ ...d.submissions[0].payee_wallet_row }, { id: f.row.id, hash: f.row.hash, address: WALLET_A });
    assert.match(d.payee_wallet_row_note, /pin its id and hash/);

    const changed = await declareTestWallet(f.d1, f.reviewerId, WALLET_B);
    d = (await getListingDetail(f.env, f.listingId)) as unknown as Detail;
    assert.deepEqual({ ...d.submissions[0].payee_wallet_row }, { id: changed.id, hash: changed.hash, address: WALLET_B }, "the newest row, not the first");

    const walletless = insertCitizen(f.d1);
    const subNoWallet = insertSubmission(f.d1, { listing_id: f.listingId, citizen_id: walletless });
    d = (await getListingDetail(f.env, f.listingId)) as unknown as Detail;
    assert.equal(d.submissions.find((s) => s.id === subNoWallet)?.payee_wallet_row, null);

    f.d1.raw.prepare("UPDATE identity_events SET detail = 'wallet changed: garbage' WHERE id = ?").run(changed.id);
    d = (await getListingDetail(f.env, f.listingId)) as unknown as Detail;
    const served = d.submissions.find((s) => s.id === f.submissionId)?.payee_wallet_row;
    assert.equal(served?.id, changed.id, "the row is still served");
    assert.equal(served?.address, null, "its address is null, not guessed");
  } finally {
    f.d1.close();
  }
});

test("test 1, the book half: GET /api/listings/payments serves wallet_row_id and wallet_row_hash on a pinned payment, null on a row recorded without them, and the note that says both", async () => {
  const f = await fixture();
  const stub = stubFacilitator();
  try {
    const now = Date.now();
    const oldListing = insertListing(f.d1, { funder_citizen_id: f.funder.id, bounty_cents: 500 });
    const oldSub = insertSubmission(f.d1, { listing_id: oldListing, citizen_id: f.reviewerId });
    f.d1.raw
      .prepare("INSERT INTO listing_payments (listing_id, submission_id, payee_citizen_id, payee_address, payer_address, amount_cents, tx, created_at) VALUES (?, ?, ?, ?, ?, 500, ?, ?)")
      .run(oldListing, oldSub, f.reviewerId, WALLET_A, "0x" + "fa".repeat(20), "0x" + "01".repeat(32), now - 86_400_000);
    const res = await handlePayListing(payReq(f, pinOf(f.row)), f.env, f.funder, f.listingId);
    assert.equal(res.status, 200);
    const book = (await listingPaymentsPage(f.env)) as unknown as { wallet_row_note: string; entries: { listing_id: number; wallet_row_id: number | null; wallet_row_hash: string | null }[] };
    const pinned = book.entries.find((e) => e.listing_id === f.listingId);
    const old = book.entries.find((e) => e.listing_id === oldListing);
    assert.equal(pinned?.wallet_row_id, f.row.id);
    assert.equal(pinned?.wallet_row_hash, f.row.hash);
    assert.equal(old?.wallet_row_id, null, "a row recorded before the check carries null");
    assert.equal(old?.wallet_row_hash, null);
    assert.match(book.wallet_row_note, /Rows paid before the check existed carry null/);
    assert.match(book.wallet_row_note, /does not recompute the chain/);
  } finally {
    stub.restore();
    f.d1.close();
  }
});
