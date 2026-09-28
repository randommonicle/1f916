// x402 settle honesty (docs/BRIEF-X402-SETTLE-HONESTY.md B2 and B6), through the
// routes: the pay route (handlePayListing), the register route and the patron
// door (through the worker's own fetch, so the router's JSON error body is what
// is asserted), and listing creation (handleCreateListing).
//
// The facilitator is genuinely external, so its HTTP surface is stubbed via
// globalThis.fetch exactly as test/wallet-pin-route-d1.test.ts stubs it: each
// case picks the status AND the body of the /settle answer, because the whole
// point of B2 is that the two are read together. Nothing about the routes, the
// chain or D1 is mocked: createLocalD1 is real SQLite with the real schema.sql.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, insertCitizen, insertListing, insertSubmission, type LocalD1 } from "./helpers/local-d1.ts";
import { declareTestWallet, type WalletRowPin } from "./helpers/wallet-pin.ts";
import { paymentHeaderFor, atomicFromCents } from "./helpers/x402-payload.ts";
import { handlePayListing, handleCreateListing, computeListingFeeCents } from "../src/listings.ts";
import { SocietyError, type Env } from "../src/society.ts";
import worker from "../src/index.ts";

const TREASURY_ADDRESS = "0xa7f7985eb19b8c44f12a0654df1ef89d1dd527c9";
const FACILITATOR_URL = "https://facilitator.example.invalid";
const WALLET_A = "0x" + "0a".repeat(20);
const BOUNTY = 1200;
const PENDING_TX = "0x" + "cd".repeat(32);

// The hub's words (brief B2), typed here rather than imported, so a change to
// the served wording fails these tests instead of silently passing them.
const HUB_PENDING_WITH_TX = `The facilitator has not yet settled this payment (settlement_pending): it may still land on-chain. It reports the broadcast transaction ${PENDING_TX}. Whether the money moved is unknown until the chain is checked; do not sign again.`;
const hubRefusal = (status: number, reason: string) => `The facilitator reports that this settlement failed (HTTP ${status}, reason: ${reason}). By its account no money moved.`;

function testEnv(d1: LocalD1): Env {
  return { DB: d1.DB, TREASURY_ADDRESS, FACILITATOR_URL, REGISTRATION_MODE: "open" } as unknown as Env;
}

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
function callWorker(request: Request, env: Env): Promise<Response> {
  return (worker.fetch as unknown as (r: Request, e: Env, c: unknown) => Promise<Response>)(request, env, ctx);
}

type Answer = { status: number; body: unknown };
const SETTLED: Answer = { status: 200, body: { success: true, payer: "0x00000000000000000000000000000000000000fa", transaction: "0x" + "ab".repeat(32) } };

// Each call answers with the given status and JSON body; the defaults are a
// valid /verify and a settled /settle.
function stubFacilitator(answers: { verify?: Answer; settle?: Answer } = {}) {
  const original = globalThis.fetch;
  const calls = { verify: 0, settle: 0 };
  const respond = (a: Answer) => new Response(JSON.stringify(a.body), { status: a.status, headers: { "content-type": "application/json" } });
  globalThis.fetch = (async (url: unknown) => {
    const href = String(url);
    if (href === `${FACILITATOR_URL}/verify`) {
      calls.verify++;
      return respond(answers.verify ?? { status: 200, body: { isValid: true } });
    }
    if (href === `${FACILITATOR_URL}/settle`) {
      calls.settle++;
      return respond(answers.settle ?? SETTLED);
    }
    throw new Error(`unexpected fetch in x402-settle-route-d1.test.ts: ${href}`);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function count(d1: LocalD1, fromWhere: string): number {
  return (d1.raw.prepare(`SELECT COUNT(*) AS n FROM ${fromWhere}`).get() as { n: number }).n;
}

// ---------- the pay route ----------

interface PayFixture {
  d1: LocalD1;
  env: Env;
  funder: { id: number; handle: string };
  listingId: number;
  submissionId: number;
  row: WalletRowPin;
}
async function payFixture(): Promise<PayFixture> {
  const d1 = createLocalD1();
  const env = testEnv(d1);
  const funderId = insertCitizen(d1);
  const funder = { ...(d1.raw.prepare("SELECT id, handle FROM citizens WHERE id = ?").get(funderId) as { id: number; handle: string }) };
  const reviewerId = insertCitizen(d1);
  const row = await declareTestWallet(d1, reviewerId, WALLET_A);
  const listingId = insertListing(d1, { funder_citizen_id: funderId, bounty_cents: BOUNTY });
  const submissionId = insertSubmission(d1, { listing_id: listingId, citizen_id: reviewerId });
  return { d1, env, funder, listingId, submissionId, row };
}
function payReq(f: PayFixture): Request {
  return new Request(`https://example.test/api/listing/${f.listingId}/pay`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-PAYMENT": paymentHeaderFor(WALLET_A, atomicFromCents(BOUNTY)) },
    body: JSON.stringify({ submission_id: f.submissionId, wallet_row_id: f.row.id, wallet_row_hash: f.row.hash }),
  });
}
function listingRow(f: PayFixture) {
  return { ...(f.d1.raw.prepare("SELECT status, paying_since, paying_wallet_row_id, paying_wallet_row_hash FROM listings WHERE id = ?").get(f.listingId) as { status: string; paying_since: number | null; paying_wallet_row_id: number | null; paying_wallet_row_hash: string | null }) };
}

type UnknownCase = { label: string; status: number; body: Record<string, unknown>; namesTx?: boolean };

// Brief B6's list.
const UNKNOWN_SETTLES: UnknownCase[] = [
  { label: "200 settlement_pending with a transaction", status: 200, body: { success: false, errorReason: "settlement_pending", transaction: PENDING_TX }, namesTx: true },
  { label: "200 settlement_pending without a transaction", status: 200, body: { success: false, errorReason: "settlement_pending" } },
  { label: "409 duplicate_settlement (success:false, so rule 3 cannot mask rule 2)", status: 409, body: { success: false, errorReason: "duplicate_settlement" } },
  { label: "500 success:false", status: 500, body: { success: false, errorReason: "x" } },
  { label: "200 success:false with no reason", status: 200, body: { success: false } },
  { label: "403 success:true", status: 403, body: { success: true } },
  { label: "408 upstream_timeout", status: 408, body: { success: false, errorReason: "upstream_timeout" } },
  { label: "429 rate_limited", status: 429, body: { success: false, errorReason: "rate_limited" } },
  { label: "202 success:false", status: 202, body: { success: false, errorReason: "x" } },
];

// One unknown /settle answer on the pay route: 502 settlement_unconfirmed, the
// listing kept paying with its pinned pair, no payment row, and a retry refused
// at the reservation before it can reach /settle again.
async function assertUnknownKeepsReservation(c: UnknownCase): Promise<void> {
  const f = await payFixture();
  const stub = stubFacilitator({ settle: { status: c.status, body: c.body } });
  try {
    const res = await handlePayListing(payReq(f), f.env, f.funder, f.listingId);
    assert.equal(res.status, 502, `${c.label}: 502, not a 402 that releases`);
    const body = (await res.json()) as { error: string; message: string; wallet_row_id: number; wallet_row_hash: string };
    assert.equal(body.error, "settlement_unconfirmed", c.label);
    assert.ok(body.message.startsWith("The settle request was sent and no settlement verdict was returned ("), `${c.label}: ${body.message}`);
    if (c.namesTx) assert.ok(body.message.includes(`It reports the broadcast transaction ${PENDING_TX}.`), `${c.label}: the message names the broadcast transaction: ${body.message}`);
    else assert.equal(body.message.includes("broadcast transaction"), false, `${c.label}: no broadcast transaction is claimed`);
    assert.equal(body.wallet_row_id, f.row.id, c.label);
    assert.equal(body.wallet_row_hash, f.row.hash, c.label);
    const l = listingRow(f);
    assert.equal(l.status, "paying", `${c.label}: the reservation is kept`);
    assert.equal(l.paying_wallet_row_id, f.row.id, `${c.label}: with its pinned pair`);
    assert.equal(l.paying_wallet_row_hash, f.row.hash, c.label);
    assert.equal(count(f.d1, `listing_payments WHERE listing_id = ${f.listingId}`), 0, `${c.label}: no payment row`);
    await assert.rejects(handlePayListing(payReq(f), f.env, f.funder, f.listingId), (e: unknown) => e instanceof SocietyError && e.status === 409, `${c.label}: a retry is refused at the reservation`);
    assert.equal(stub.calls.settle, 1, `${c.label}: the retry never reaches /settle: no second payment`);
  } finally {
    stub.restore();
    f.d1.close();
  }
}

test("B2 on the pay route: every /settle answer that is not a verdict answers 502 settlement_unconfirmed, KEEPS the listing paying with its pinned pair, records no payment, and a retry never reaches /settle again", async () => {
  for (const c of UNKNOWN_SETTLES) await assertUnknownKeepsReservation(c);
});

// Rule 5 holds on ANY status. These two are the answers rule 7 (400 and 403
// with a non-empty reason) would release if rule 5 were not above it.
test("B2 rule 5 on the pay route: settlement_pending on a 400 or a 403 also keeps the reservation", async () => {
  for (const status of [400, 403]) {
    await assertUnknownKeepsReservation({ label: `${status} settlement_pending`, status, body: { success: false, errorReason: "settlement_pending" } });
  }
});

test("B2 on the pay route: a recorded failure (HTTP 200) and a documented refusal (400, 401, 403) RELEASE the listing and answer 402 naming the facilitator's status and reason", async () => {
  for (const c of [
    { status: 200, reason: "insufficient_funds" },
    { status: 400, reason: "policy" },
    { status: 401, reason: "policy" },
    { status: 403, reason: "policy" },
  ]) {
    const label = `HTTP ${c.status} ${c.reason}`;
    const f = await payFixture();
    const stub = stubFacilitator({ settle: { status: c.status, body: { success: false, errorReason: c.reason } } });
    try {
      const res = await handlePayListing(payReq(f), f.env, f.funder, f.listingId);
      assert.equal(res.status, 402, `${label}: a refusal is a 402`);
      const body = (await res.json()) as { error: string; accepts: { payTo: string }[] };
      assert.equal(body.error, hubRefusal(c.status, c.reason), label);
      assert.equal(body.accepts[0].payTo, WALLET_A, label);
      const l = listingRow(f);
      assert.equal(l.status, "open", `${label}: released`);
      assert.equal(l.paying_since, null, label);
      assert.equal(l.paying_wallet_row_id, null, `${label}: the pair is cleared`);
      assert.equal(count(f.d1, `listing_payments WHERE listing_id = ${f.listingId}`), 0, label);
      assert.equal(stub.calls.settle, 1, label);
    } finally {
      stub.restore();
      f.d1.close();
    }
  }
});

// ---------- the register route, through the worker's own router ----------

function registerReq(handle: string): Request {
  return new Request("https://example.test/api/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-PAYMENT": paymentHeaderFor(TREASURY_ADDRESS, "1000000") },
    body: JSON.stringify({ handle, model: "test-model" }),
  });
}

test("B2 on the register route: a settlement_pending /settle answers 502 with the hub's message naming the broadcast transaction, and no citizen, ledger or reg_log row is written", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator({ settle: { status: 200, body: { success: false, errorReason: "settlement_pending", transaction: PENDING_TX } } });
  try {
    const before = { citizens: count(d1, "citizens"), ledger: count(d1, "ledger"), reg: count(d1, "reg_log") };
    const res = await callWorker(registerReq("pending-payer"), testEnv(d1));
    assert.equal(res.status, 502, "a 502, never a 402 that invites a second payment");
    assert.equal(((await res.json()) as { error: string }).error, HUB_PENDING_WITH_TX);
    assert.equal(stub.calls.settle, 1, "the settle request was sent");
    assert.deepEqual({ citizens: count(d1, "citizens"), ledger: count(d1, "ledger"), reg: count(d1, "reg_log") }, before, "nothing is written");
  } finally {
    stub.restore();
    d1.close();
  }
});

test("B2 on the register route: a recorded failure answers 402 naming the facilitator's status and reason, and nothing is written", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator({ settle: { status: 200, body: { success: false, errorReason: "insufficient_funds" } } });
  try {
    const before = { citizens: count(d1, "citizens"), ledger: count(d1, "ledger"), reg: count(d1, "reg_log") };
    const res = await callWorker(registerReq("refused-payer"), testEnv(d1));
    assert.equal(res.status, 402);
    assert.equal(((await res.json()) as { error: string }).error, hubRefusal(200, "insufficient_funds"));
    assert.deepEqual({ citizens: count(d1, "citizens"), ledger: count(d1, "ledger"), reg: count(d1, "reg_log") }, before, "nothing is written");
  } finally {
    stub.restore();
    d1.close();
  }
});

// ---------- the patron door and listing creation (F1's other two callers) ----------

test("B2 on the patron and listing-create doors: a settlement_pending /settle is a 502, never a 402, and neither writes a ledger line or a listing", async () => {
  {
    const d1 = createLocalD1();
    const stub = stubFacilitator({ settle: { status: 200, body: { success: false, errorReason: "settlement_pending" } } });
    try {
      const res = await callWorker(
        new Request("https://example.test/api/patron", { method: "POST", headers: { "Content-Type": "application/json", "X-PAYMENT": paymentHeaderFor(TREASURY_ADDRESS, "1000000") }, body: JSON.stringify({ message: "hello" }) }),
        testEnv(d1),
      );
      assert.equal(res.status, 502, "patron: a 502");
      assert.match(((await res.json()) as { error: string }).error, /\(settlement_pending\): it may still land on-chain/);
      assert.equal(count(d1, "ledger"), 0, "patron: no ledger line");
    } finally {
      stub.restore();
      d1.close();
    }
  }
  {
    const d1 = createLocalD1();
    const stub = stubFacilitator({ settle: { status: 200, body: { success: false, errorReason: "settlement_pending" } } });
    try {
      const funderId = insertCitizen(d1);
      const funder = { ...(d1.raw.prepare("SELECT id, handle FROM citizens WHERE id = ?").get(funderId) as { id: number; handle: string }) };
      const bounty = 1000;
      const request = new Request("https://example.test/api/listing", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-PAYMENT": paymentHeaderFor(TREASURY_ADDRESS, atomicFromCents(computeListingFeeCents(bounty))) },
        body: JSON.stringify({
          title: "Review my auth middleware",
          description: "Stuck on token refresh, please review for race conditions",
          acceptance_condition: "a reviewer identifies at least one real correctness issue or confirms none exist",
          bounty_cents: bounty,
          expires_at: Date.now() + 7 * 86_400_000,
        }),
      });
      await assert.rejects(handleCreateListing(request, testEnv(d1), funder), (e: unknown) => e instanceof SocietyError && e.status === 502 && /\(settlement_pending\)/.test(e.message), "listing create: a 502");
      assert.equal(stub.calls.settle, 1, "listing create: the settle request was sent");
      assert.equal(count(d1, "ledger"), 0, "listing create: no ledger line");
      assert.equal(count(d1, "listings"), 0, "listing create: no listing");
    } finally {
      stub.restore();
      d1.close();
    }
  }
});

// ---------- B3: the /verify answer, through the routes ----------

const hubVerifyRefused = (status: number, reason: string) => `The payment facilitator refused to verify this payment (HTTP ${status}, reason: ${reason}). No money moved: nothing that could settle was sent.`;
const hubVerifyFailed = (status: number, reason: string) => `The payment facilitator failed to verify this payment (HTTP ${status}, reason: ${reason}). No money moved: nothing that could settle was sent. Try again later.`;

test("B3 on the register route: a 403 from /verify answers 402 naming 403 and the reason, a 503 answers 502, an invalid 200 keeps its old 402 -- and none of them reaches /settle or writes anything", async () => {
  const cases: { label: string; verify: Answer; status: number; error: string }[] = [
    { label: "verify 403", verify: { status: 403, body: { isValid: false, errorReason: "policy_refusal" } }, status: 402, error: hubVerifyRefused(403, "policy_refusal") },
    { label: "verify 503", verify: { status: 503, body: { error: "unavailable" } }, status: 502, error: hubVerifyFailed(503, "unavailable") },
    { label: "verify 200 invalid", verify: { status: 200, body: { isValid: false, invalidReason: "x" } }, status: 402, error: "x" },
  ];
  for (const c of cases) {
    const d1 = createLocalD1();
    const stub = stubFacilitator({ verify: c.verify });
    try {
      const before = { citizens: count(d1, "citizens"), ledger: count(d1, "ledger"), reg: count(d1, "reg_log") };
      const res = await callWorker(registerReq("verify-case"), testEnv(d1));
      assert.equal(res.status, c.status, `${c.label}: status`);
      assert.equal(((await res.json()) as { error: string }).error, c.error, `${c.label}: error`);
      assert.equal(stub.calls.verify, 1, `${c.label}: /verify was asked`);
      assert.equal(stub.calls.settle, 0, `${c.label}: /settle is never called`);
      assert.deepEqual({ citizens: count(d1, "citizens"), ledger: count(d1, "ledger"), reg: count(d1, "reg_log") }, before, `${c.label}: nothing is written`);
    } finally {
      stub.restore();
      d1.close();
    }
  }
});

// The status and error text a route answers with, whether the handler RETURNED
// a Response or THREW a SocietyError (the router serves both the same way), so a
// change that swaps one for the other fails this test's own assertion instead of
// escaping it as an exception.
async function answerOf(p: Promise<Response>): Promise<{ status: number; error: string }> {
  try {
    const res = await p;
    return { status: res.status, error: String(((await res.json()) as { error?: unknown }).error) };
  } catch (e) {
    if (e instanceof SocietyError) return { status: e.status, error: e.message };
    throw e;
  }
}

test("B3 on the pay route: a 403 or a 503 from /verify never reserves the listing and never reaches /settle (402 and 502 respectively)", async () => {
  for (const c of [
    { label: "verify 403", verify: { status: 403, body: { isValid: false, errorReason: "policy_refusal" } }, answer: { status: 402, error: hubVerifyRefused(403, "policy_refusal") } },
    { label: "verify 503", verify: { status: 503, body: { error: "unavailable" } }, answer: { status: 502, error: hubVerifyFailed(503, "unavailable") } },
  ]) {
    const f = await payFixture();
    const stub = stubFacilitator({ verify: c.verify });
    try {
      assert.deepEqual(await answerOf(handlePayListing(payReq(f), f.env, f.funder, f.listingId)), c.answer, `${c.label}: the route's answer`);
      assert.equal(stub.calls.settle, 0, `${c.label}: /settle is never called`);
      assert.deepEqual(listingRow(f), { status: "open", paying_since: null, paying_wallet_row_id: null, paying_wallet_row_hash: null }, `${c.label}: never reserved`);
    } finally {
      stub.restore();
      f.d1.close();
    }
  }
});
