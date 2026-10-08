// P3 of the plain-error money answers (docs/CHECKPOINT-PLAIN-ERROR-MONEY-ANSWERS.md; errant-hermes on 1f916 97465): the two generic-500 paths exercised by READ-BACK through the real router over real
// local D1, recording STABILITY across identical re-sends, not only whether `answered_by` is present.
//
//   (a) a claim's recorded treasury row is missing (ledgerReceipt): register and listing create. Listing pay never calls ledgerReceipt (it books listing_payments).
//   (b) a claim that cannot be read back after a first refusal's write (x402.ts payAndSettle): register, patron and listing create answer the generic 500 plus answered_by; listing pay's catch
//       ALREADY answers it as 502 settlement_unconfirmed with answered_by (a regression check: that answer must be what it was).
//   (c) the negative control: an UNMARKED plain throw on every paid route is still exactly { error } with no answered_by, and the router's log line is unchanged.
//
// Every case pins the exact status, the exact body text (so key order), the router's log line (written out, not computed), the row counts before and after, and at least two identical re-sends. This
// file imports nothing the wave added, so it also runs against the base source: PEM_RECORD=<path> writes what each scenario served, and the checkpoint's decision-invariance table diffs the two runs.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { insertCitizen, insertListing, insertSubmission } from "./helpers/local-d1.ts";
import { declareTestWallet } from "./helpers/wallet-pin.ts";
import { atomicFromCents } from "./helpers/x402-payload.ts";
import { sha256Hex } from "../src/chain.ts";
import { computeListingFeeCents } from "../src/listings.ts";
import { ANSWERED_BY_NOTE } from "../src/code-identity.ts";
import {
  TREASURY_ADDRESS,
  TX,
  callWorker,
  captureLog,
  chainRpc,
  count,
  createLocalD1,
  dropTrigger,
  failInserts,
  oneClaim,
  patronReq,
  paymentHeaderFor,
  realPublicKey,
  registerHeader,
  registerReq,
  stubFacilitator,
  testEnv,
  type Env,
  type LocalD1,
} from "./helpers/settlement-harness.ts";

const SHA = "5ecca7ae" + "0".repeat(28) + "beef";
const VERSION = { id: "be15ed56-fd8f-4aad-ab92-06c9b6d43452", tag: "", timestamp: "2026-10-08T09:00:00.000Z" };
// Written out, not computed through the code under test.
const EXPECTED = { commit: SHA, commit_status: "stamped", version_id: VERSION.id, version_status: "available", note: ANSWERED_BY_NOTE };
const stamped = (d1: LocalD1): Env => testEnv(d1, { CODE_COMMIT: SHA, CF_VERSION_METADATA: VERSION });
const GENERIC = "Internal error. The society apologizes.";
const GENERIC_BODY = JSON.stringify({ error: GENERIC });
const MARKED_BODY = JSON.stringify({ error: GENERIC, answered_by: EXPECTED });
const CLAIM_UNREADABLE = "the settlement claim could not be read back after its refusal write; the outcome is unknown";
const FUNDER_SECRET = "commonhold_sk_" + "ef".repeat(32);
const REVIEWER_WALLET = "0x" + "0a".repeat(20);
const refusedAnswer = () => new Response(JSON.stringify({ success: false, errorReason: "insufficient_funds" }), { status: 200, headers: { "content-type": "application/json" } });

// What each scenario served, written to PEM_RECORD when set (see the header). Recorded BEFORE any assertion.
const RECORDED: Record<string, unknown> = {};
test.after(() => {
  if (process.env.PEM_RECORD) writeFileSync(process.env.PEM_RECORD, JSON.stringify(RECORDED, null, 1));
});

interface Served {
  status: number;
  text: string;
  body: Record<string, any>;
  routerLines: string[];
}
// Serves one request through the real router. The router's own log line is the one whose JSON has a `path`; the other lines are only recorded as event names.
async function serve(label: string, req: Request, env: Env): Promise<Served> {
  const { value: res, lines } = await captureLog(() => callWorker(req, env));
  const text = await res.text();
  const body = JSON.parse(text) as Record<string, any>;
  const parsed = lines.flatMap((l) => {
    try {
      return [{ raw: l, o: JSON.parse(l) as Record<string, unknown> }];
    } catch {
      return [];
    }
  });
  const routerLines = parsed.filter((p) => "path" in p.o).map((p) => p.raw);
  RECORDED[label] = {
    status: res.status,
    keys: Object.keys(body),
    error: body.error ?? null,
    code: body.code ?? null,
    message: typeof body.message === "string" ? body.message.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, "<time>") : null,
    router_log: routerLines,
    events: parsed.map((p) => p.o.event).filter((e) => typeof e === "string"),
  };
  return { status: res.status, text, body, routerLines };
}

const world = (d1: LocalD1) => ({
  citizens: count(d1, "citizens"),
  ledger: count(d1, "ledger"),
  reg_log: count(d1, "reg_log"),
  listings: count(d1, "listings"),
  claims: count(d1, "settlement_claims"),
});

// The router's generic 500 for a marked plain Error: exactly this body, exactly this one log line.
function assertMarkedGeneric(label: string, s: Served, path: string, reason: string): void {
  assert.equal(s.status, 500, `${label}: status`);
  assert.equal(s.text, MARKED_BODY, `${label}: the generic body plus answered_by, LAST, byte for byte`);
  assert.deepEqual(Object.keys(s.body), ["error", "answered_by"], `${label}: key order`);
  assert.deepEqual(s.body.answered_by, EXPECTED, `${label}: the env's identity and the pinned note`);
  assert.deepEqual(s.routerLines, [JSON.stringify({ level: "error", path, message: `Error: ${reason}` })], `${label}: the router's one log line, unchanged`);
}

const listingBody = () => ({
  title: "Review my auth middleware",
  description: "Stuck on token refresh, please review for race conditions",
  acceptance_condition: "a reviewer identifies at least one real correctness issue or confirms none exist",
  bounty_cents: 1000,
  expires_at: Date.now() + 7 * 86_400_000,
});
function listingCreateReq(body: ReturnType<typeof listingBody>, header: string): Request {
  return new Request("https://example.test/api/listing", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${FUNDER_SECRET}`, "X-PAYMENT": header },
    body: JSON.stringify(body),
  });
}
async function payFixture(d1: LocalD1) {
  const funderId = insertCitizen(d1, { secret_hash: await sha256Hex(FUNDER_SECRET) });
  const reviewerId = insertCitizen(d1);
  const pin = await declareTestWallet(d1, reviewerId, REVIEWER_WALLET);
  const listingId = insertListing(d1, { funder_citizen_id: funderId, bounty_cents: 1200 });
  const submissionId = insertSubmission(d1, { listing_id: listingId, citizen_id: reviewerId });
  const header = paymentHeaderFor(REVIEWER_WALLET, atomicFromCents(1200));
  const req = () =>
    new Request(`https://example.test/api/listing/${listingId}/pay`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${FUNDER_SECRET}`, "X-PAYMENT": header },
      body: JSON.stringify({ submission_id: submissionId, wallet_row_id: pin.id, wallet_row_hash: pin.hash }),
    });
  const listing = () => d1.raw.prepare("SELECT status, paying_since FROM listings WHERE id = ?").get(listingId) as { status: string; paying_since: number | null };
  return { req, listing, listingId };
}

// The claim vanishes the instant the first-refusal write lands: the SQLite trigger deletes the row the write just updated, so the re-read finds nothing, every time (a PERSISTENT fault).
const VANISH = "CREATE TRIGGER pem_claim_vanishes AFTER UPDATE ON settlement_claims WHEN NEW.state = 'pending' AND NEW.verdict_reason IS NOT NULL AND NEW.lease_owner IS NULL BEGIN DELETE FROM settlement_claims WHERE network = NEW.network AND asset = NEW.asset AND from_addr = NEW.from_addr AND nonce = NEW.nonce; END;";

// A read that finds nothing exactly once, the first time the claim is read after the first-refusal write has been prepared (a TRANSIENT fault: the write itself landed).
const isFirstRefusalWrite = (sql: string): boolean => sql.replace(/\s+/g, " ").includes("AND state = 'pending' AND lease_owner = ? AND updated_at = ?");
function nullReadOnce(d1: LocalD1): { env: Env; fired: () => boolean } {
  const base = stamped(d1);
  let armed = false;
  let fired = false;
  const db = {
    prepare: (sql: string) => {
      if (!fired && isFirstRefusalWrite(sql)) armed = true;
      if (armed && !fired && /^\s*SELECT \* FROM settlement_claims WHERE/.test(sql)) {
        fired = true;
        const s: any = { bind: () => s, first: async () => null, run: async () => ({ meta: { changes: 0 } }), all: async () => ({ results: [] }) };
        return s;
      }
      return base.DB.prepare(sql);
    },
    batch: (s: any[]) => base.DB.batch(s),
  };
  return { env: { ...base, DB: db } as unknown as Env, fired: () => fired };
}

// ---------- (a) a claim's recorded treasury row is missing ----------

test("P3 (a) register: a re-send after the claim's treasury row is deleted is the generic 500 plus answered_by, three times the same; no citizen, no ledger row, the claim untouched and unleased", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator();
  try {
    const header = registerHeader();
    const body = { handle: "pem-reg-a", model: "m", public_key: await realPublicKey() };
    failInserts(d1, "pem_no_citizen", "citizens", null, "disk I/O error");
    const first = await serve("a register: first request (citizens INSERT fails)", registerReq(body, header), stamped(d1));
    assert.equal(first.status, 500);
    assert.match(String(first.body.error), /payment settled \(tx 0xabab[0-9a-f]*\) but registration did not complete/);
    dropTrigger(d1, "pem_no_citizen");
    const ledgerId = (JSON.parse(oneClaim(d1).booked_refs) as { ledger_id?: number }).ledger_id;
    assert.equal(typeof ledgerId, "number", "the first request recorded the treasury line before it failed");
    assert.equal(oneClaim(d1).state, "settled_unbooked");
    d1.raw.prepare("DELETE FROM ledger WHERE id = ?").run(ledgerId);
    const before = world(d1);
    assert.deepEqual(before, { citizens: 0, ledger: 0, reg_log: 0, listings: 0, claims: 1 });

    const served: Served[] = [];
    const worlds: ReturnType<typeof world>[] = [];
    for (let i = 1; i <= 3; i++) {
      served.push(await serve(`a register: re-send ${i} (treasury row deleted)`, registerReq(body, header), stamped(d1)));
      worlds.push(world(d1));
    }
    served.forEach((s, k) => {
      assertMarkedGeneric(`re-send ${k + 1}`, s, "/api/register", `ledger row ${ledgerId} recorded in the claim does not exist`);
      assert.deepEqual(worlds[k], before, `re-send ${k + 1}: no second citizen, no new treasury row, no new claim`);
    });
    assert.equal(served[1].text, served[0].text, "stable: re-send 2 is re-send 1");
    assert.equal(served[2].text, served[0].text, "stable: re-send 3 is re-send 1");
    const claim = oneClaim(d1);
    assert.equal(claim.state, "settled_unbooked", "the claim is left as it was: settled, unbooked, pointing at a vanished row");
    assert.equal(claim.lease_owner, null, "every re-send let go of its lease");
    assert.equal((JSON.parse(claim.booked_refs) as { ledger_id?: number }).ledger_id, ledgerId);
    assert.equal(stub.calls.settle, 1, "the facilitator was asked once, by the first request only");
  } finally {
    stub.restore();
    d1.close();
  }
});

test("P3 (a) listing create: a re-send after the claim's treasury row is deleted is the generic 500 plus answered_by, three times the same; no listing, no ledger row, the claim untouched and unleased", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator();
  try {
    insertCitizen(d1, { secret_hash: await sha256Hex(FUNDER_SECRET) });
    const header = paymentHeaderFor(TREASURY_ADDRESS, atomicFromCents(computeListingFeeCents(1000)));
    const body = listingBody();
    failInserts(d1, "pem_no_listing", "listings", null, "disk I/O error");
    const first = await serve("a listing create: first request (listings INSERT fails)", listingCreateReq(body, header), stamped(d1));
    assert.equal(first.status, 500);
    assert.match(String(first.body.error), /posting fee settled \(tx 0xabab[0-9a-f]*\) but the listing failed to save/);
    dropTrigger(d1, "pem_no_listing");
    const ledgerId = (JSON.parse(oneClaim(d1).booked_refs) as { ledger_id?: number }).ledger_id;
    assert.equal(typeof ledgerId, "number");
    d1.raw.prepare("DELETE FROM ledger WHERE id = ?").run(ledgerId);
    const before = world(d1);
    assert.deepEqual(before, { citizens: 1, ledger: 0, reg_log: 0, listings: 0, claims: 1 });

    const served: Served[] = [];
    const worlds: ReturnType<typeof world>[] = [];
    for (let i = 1; i <= 3; i++) {
      served.push(await serve(`a listing create: re-send ${i} (treasury row deleted)`, listingCreateReq(body, header), stamped(d1)));
      worlds.push(world(d1));
    }
    served.forEach((s, k) => {
      assertMarkedGeneric(`re-send ${k + 1}`, s, "/api/listing", `ledger row ${ledgerId} recorded in the claim does not exist`);
      assert.deepEqual(worlds[k], before, `re-send ${k + 1}: no listing, no new treasury row, no new claim`);
    });
    assert.equal(served[1].text, served[0].text);
    assert.equal(served[2].text, served[0].text);
    const claim = oneClaim(d1);
    assert.equal(claim.state, "settled_unbooked");
    assert.equal(claim.lease_owner, null);
    assert.equal(stub.calls.settle, 1);
  } finally {
    stub.restore();
    d1.close();
  }
});

// ---------- (b) a claim that cannot be read back after a first refusal's write ----------

test("P3 (b) register, persistent fault (the claim vanishes after each refusal write): the generic 500 plus answered_by, three times the same; nothing created; no claim row is left", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator({ settle: () => refusedAnswer() });
  try {
    const header = registerHeader();
    const body = { handle: "pem-reg-b", model: "m", public_key: await realPublicKey() };
    d1.raw.exec(VANISH);
    const before = world(d1);
    assert.deepEqual(before, { citizens: 0, ledger: 0, reg_log: 0, listings: 0, claims: 0 });
    const served: Served[] = [];
    const worlds: ReturnType<typeof world>[] = [];
    const settles: number[] = [];
    for (let i = 1; i <= 3; i++) {
      served.push(await serve(`b register: send ${i} (claim vanishes after the refusal write)`, registerReq(body, header), stamped(d1)));
      worlds.push(world(d1));
      settles.push(stub.calls.settle);
    }
    served.forEach((s, k) => {
      assertMarkedGeneric(`send ${k + 1}`, s, "/api/register", CLAIM_UNREADABLE);
      assert.deepEqual(worlds[k], before, `send ${k + 1}: no citizen, no treasury row, no claim row left`);
    });
    assert.deepEqual(settles, [1, 2, 3], "each re-send is a fresh claim and asks the facilitator again (the claim it would have been answered from is gone)");
    assert.equal(served[1].text, served[0].text, "stable: send 2 is send 1");
    assert.equal(served[2].text, served[0].text, "stable: send 3 is send 1");
  } finally {
    stub.restore();
    d1.close();
  }
});

test("P3 (b) patron, persistent fault: the generic 500 plus answered_by, three times the same; no treasury line; no claim row is left", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator({ settle: () => refusedAnswer() });
  try {
    const header = paymentHeaderFor(TREASURY_ADDRESS, "1000000");
    d1.raw.exec(VANISH);
    const before = world(d1);
    const served: Served[] = [];
    const worlds: ReturnType<typeof world>[] = [];
    const settles: number[] = [];
    for (let i = 1; i <= 3; i++) {
      served.push(await serve(`b patron: send ${i} (claim vanishes after the refusal write)`, patronReq("rent", header), stamped(d1)));
      worlds.push(world(d1));
      settles.push(stub.calls.settle);
    }
    served.forEach((s, k) => {
      assertMarkedGeneric(`send ${k + 1}`, s, "/api/patron", CLAIM_UNREADABLE);
      assert.deepEqual(worlds[k], before, `send ${k + 1}: no treasury line, no claim row left`);
    });
    assert.deepEqual(settles, [1, 2, 3]);
    assert.equal(served[1].text, served[0].text);
    assert.equal(served[2].text, served[0].text);
  } finally {
    stub.restore();
    d1.close();
  }
});

test("P3 (b) listing create, persistent fault: the generic 500 plus answered_by, three times the same; no listing, no treasury line; no claim row is left", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator({ settle: () => refusedAnswer() });
  try {
    insertCitizen(d1, { secret_hash: await sha256Hex(FUNDER_SECRET) });
    const header = paymentHeaderFor(TREASURY_ADDRESS, atomicFromCents(computeListingFeeCents(1000)));
    const body = listingBody();
    d1.raw.exec(VANISH);
    const before = world(d1);
    assert.deepEqual(before, { citizens: 1, ledger: 0, reg_log: 0, listings: 0, claims: 0 });
    const served: Served[] = [];
    const worlds: ReturnType<typeof world>[] = [];
    const settles: number[] = [];
    for (let i = 1; i <= 3; i++) {
      served.push(await serve(`b listing create: send ${i} (claim vanishes after the refusal write)`, listingCreateReq(body, header), stamped(d1)));
      worlds.push(world(d1));
      settles.push(stub.calls.settle);
    }
    served.forEach((s, k) => {
      assertMarkedGeneric(`send ${k + 1}`, s, "/api/listing", CLAIM_UNREADABLE);
      assert.deepEqual(worlds[k], before, `send ${k + 1}: no listing, no treasury line, no claim row left`);
    });
    assert.deepEqual(settles, [1, 2, 3]);
    assert.equal(served[1].text, served[0].text);
    assert.equal(served[2].text, served[0].text);
  } finally {
    stub.restore();
    d1.close();
  }
});

test("P3 (b) register, TRANSIENT fault (the write lands, one read finds nothing): the first answer is the generic 500 plus answered_by and leaves a pending claim holding the refusal; the re-sends are answered from that claim, the same each time, and are NOT that 500", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator({ settle: () => refusedAnswer(), rpc: chainRpc(false) });
  try {
    const header = registerHeader();
    const body = { handle: "pem-reg-t", model: "m", public_key: await realPublicKey() };
    const faulty = nullReadOnce(d1);
    const first = await serve("b register transient: first request (one read finds nothing)", registerReq(body, header), faulty.env);
    assert.equal(faulty.fired(), true, "the read-back was the one that found nothing");
    const claim = oneClaim(d1);
    assert.equal(claim.state, "pending", "the refusal write landed: the claim is pending (option B: a first refusal is never terminal)");
    assert.equal(claim.lease_owner, null);
    const after = world(d1);
    assert.deepEqual(after, { citizens: 0, ledger: 0, reg_log: 0, listings: 0, claims: 1 });

    const replies: Served[] = [];
    for (let i = 1; i <= 2; i++) {
      const s = await serve(`b register transient: re-send ${i} (the claim reads normally)`, registerReq(body, header), stamped(d1));
      replies.push(s);
      assert.notEqual(s.text, first.text, `re-send ${i}: answered from the claim, no longer the generic 500`);
      assert.equal(s.status, 502, JSON.stringify(s.body));
      assert.equal(s.body.code, "settlement_unresolved");
      assert.deepEqual(s.body.answered_by, EXPECTED, "the claim answer carries the identity as it always has");
      assert.equal(s.body.accepts, undefined, "and never invites a fresh signature");
      assert.deepEqual(s.routerLines, [], "a claim answer is a Response, not a throw: the router logs nothing");
      assert.equal(oneClaim(d1).state, "pending");
      assert.deepEqual(world(d1), after);
    }
    assert.equal(replies[1].text, replies[0].text, "stable from the first re-send on");
    assertMarkedGeneric("first", first, "/api/register", CLAIM_UNREADABLE);
  } finally {
    stub.restore();
    d1.close();
  }
});

test("P3 (b) listing pay (regression): the same unreadable claim is ALREADY the 502 settlement_unconfirmed with answered_by LAST, the reservation kept; the re-sends are the reservation's free 409, the same each time", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator({ settle: () => refusedAnswer(), rpc: chainRpc(false) });
  try {
    const fx = await payFixture(d1);
    const faulty = nullReadOnce(d1);
    const first = await serve("b listing pay: first request (one read finds nothing)", fx.req(), faulty.env);
    assert.equal(faulty.fired(), true);
    assert.equal(first.status, 502, JSON.stringify(first.body));
    assert.deepEqual(
      Object.keys(first.body),
      ["error", "listing_id", "submission_id", "paying_since", "wallet_row_id", "wallet_row_hash", "message", "answered_by"],
      "the existing answer's keys in the existing order, answered_by last",
    );
    assert.equal(first.body.error, "settlement_unconfirmed");
    assert.match(first.body.message, new RegExp(`^No settlement verdict was returned for the settle request \\(${CLAIM_UNREADABLE.replace(/[.*+?^${}()|[\]\\;]/g, "\\$&")}\\)\\. The listing stays reserved`));
    assert.deepEqual(first.body.answered_by, EXPECTED);
    assert.deepEqual(first.routerLines, [], "a Response, not a throw: the router logs nothing");
    assert.equal(fx.listing().status, "paying", "the reservation is kept");
    assert.equal(oneClaim(d1).state, "pending");
    assert.equal(oneClaim(d1).route, "listing_pay");

    // The re-sends never reach the claim: the kept reservation makes loadPayableListing refuse them first, for free (DEFERRED-PAY-LISTING-RESEND-REPLAY in listings.ts). That is a pre-settlement
    // refusal, never marked (the gate's LOW 1): a 409 with { error } alone. Recorded here as the state this answer leaves the funder in; this wave does not change it.
    const replies: Served[] = [];
    for (let i = 1; i <= 2; i++) {
      const s = await serve(`b listing pay: re-send ${i} (the reservation answers first)`, fx.req(), stamped(d1));
      replies.push(s);
      assert.equal(s.status, 409, JSON.stringify(s.body));
      assert.equal(s.text, JSON.stringify({ error: `listing ${fx.listingId} is paying, not open` }), `re-send ${i}: the free refusal, { error } alone`);
      assert.equal(fx.listing().status, "paying", `re-send ${i}: the reservation is still kept`);
      assert.equal(oneClaim(d1).state, "pending", `re-send ${i}: the claim is untouched`);
    }
    assert.equal(replies[1].text, replies[0].text, "stable from the first re-send on");
    assert.equal(stub.calls.settle, 1, "the facilitator was asked once");
  } finally {
    stub.restore();
    d1.close();
  }
});

// ---------- (c) the negative control ----------

// An UNMARKED plain Error thrown by a raw D1 statement on the claim read every paid route makes before it asks the facilitator anything: the router serves exactly what it always served.
function failingClaimRead(d1: LocalD1): Env {
  const base = stamped(d1);
  const db = new Proxy(base.DB as object, {
    get(t: any, p: string | symbol) {
      if (p === "prepare") {
        return (sql: string) => {
          if (/FROM settlement_claims/.test(sql)) throw new Error("D1_ERROR: injected unmarked plain failure");
          return t.prepare(sql);
        };
      }
      const v = t[p];
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  return { ...base, DB: db } as unknown as Env;
}

test("P3 (c) negative control: an unmarked plain throw on register, patron, listing create and listing pay is exactly { error } with NO answered_by, three times the same, and the log line is the router's own", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator();
  try {
    const pay = await payFixture(d1); // its funder is the one citizen holding FUNDER_SECRET, and so also the listing-create funder
    const regBody = { handle: "pem-reg-c", model: "m", public_key: await realPublicKey() };
    const regHeader = registerHeader();
    const patronHeader = paymentHeaderFor(TREASURY_ADDRESS, "1000000");
    const createHeader = paymentHeaderFor(TREASURY_ADDRESS, atomicFromCents(computeListingFeeCents(1000)));
    const cBody = listingBody();
    const cases: Array<[string, string, () => Request]> = [
      ["register", "/api/register", () => registerReq(regBody, regHeader)],
      ["patron", "/api/patron", () => patronReq("rent", patronHeader)],
      ["listing create", "/api/listing", () => listingCreateReq(cBody, createHeader)],
      ["listing pay", `/api/listing/${pay.listingId}/pay`, pay.req],
    ];
    const before = world(d1);
    for (const [name, path, req] of cases) {
      const texts: string[] = [];
      for (let i = 1; i <= 3; i++) {
        const s = await serve(`c control ${name}: send ${i}`, req(), failingClaimRead(d1));
        assert.equal(s.status, 500, `${name} ${i}`);
        assert.equal(s.text, GENERIC_BODY, `${name} ${i}: exactly { error }, byte for byte, no answered_by`);
        assert.deepEqual(s.routerLines, [JSON.stringify({ level: "error", path, message: "Error: D1_ERROR: injected unmarked plain failure" })], `${name} ${i}: the router's log line`);
        texts.push(s.text);
      }
      assert.equal(new Set(texts).size, 1, `${name}: stable`);
    }
    assert.deepEqual(world(d1), before, "nothing was written");
    assert.equal(stub.calls.verify + stub.calls.settle, 0, "no facilitator call: the throw came first");
    assert.equal(TX.length, 66);
  } finally {
    stub.restore();
    d1.close();
  }
});
