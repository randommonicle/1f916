// Fix pass 2 (docs/REVIEW-SETTLEMENT-REPLAY-GUARD-GATE-2026-09-30.md):
//   C1  the facilitator fetch is bounded below the claim lease, and the invariant is asserted in one place;
//   L1  a claim INSERT that throws after the pay-listing reservation releases the reservation and says nothing was sent;
//   (L2 is routes test 3 in test/settlement-replay-routes-d1.test.ts.)
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { insertCitizen, insertListing, insertSubmission } from "./helpers/local-d1.ts";
import { declareTestWallet } from "./helpers/wallet-pin.ts";
import { atomicFromCents } from "./helpers/x402-payload.ts";
import {
  TREASURY_ADDRESS,
  callWorker,
  captureLog,
  count,
  createLocalD1,
  eventLines,
  json,
  oneClaim,
  paymentHeaderFor,
  patronReq,
  realPublicKey,
  registerHeader,
  registerReq,
  stubFacilitator,
  testEnv,
  type LocalD1,
} from "./helpers/settlement-harness.ts";
import { CLAIM_BOOKING_ALLOWANCE_MS, FACILITATOR_SETTLE_TIMEOUT_MS, FACILITATOR_VERIFY_TIMEOUT_MS, facilitatorTimeoutMs } from "../src/x402.ts";
import { CLAIM_LEASE_TTL_MS } from "../src/settlement-claims.ts";
import { handlePayListing } from "../src/listings.ts";

// ---------- C1 ----------

test("C1 invariant: the /settle bound plus the booking allowance stays below the claim lease, and clears PayAI's documented wait", () => {
  assert.ok(
    FACILITATOR_SETTLE_TIMEOUT_MS + CLAIM_BOOKING_ALLOWANCE_MS < CLAIM_LEASE_TTL_MS,
    `${FACILITATOR_SETTLE_TIMEOUT_MS} + ${CLAIM_BOOKING_ALLOWANCE_MS} must be < ${CLAIM_LEASE_TTL_MS}: the request that took a claim must not outlive its own lease (gate M1)`,
  );
  assert.ok(FACILITATOR_SETTLE_TIMEOUT_MS > 100_000, "above PayAI's documented ~100 s wait before it answers settlement_pending");
  assert.ok(FACILITATOR_VERIFY_TIMEOUT_MS < FACILITATOR_SETTLE_TIMEOUT_MS, "/verify, with no claim behind it, fails faster than /settle");
  assert.ok(FACILITATOR_VERIFY_TIMEOUT_MS > 0);
});

test("C1: the Env can only SHORTEN the bounds, never lengthen them", () => {
  const env = (extra: Record<string, unknown>) => ({ FACILITATOR_URL: "x", ...extra }) as never;
  assert.equal(facilitatorTimeoutMs(env({}), "/settle"), FACILITATOR_SETTLE_TIMEOUT_MS);
  assert.equal(facilitatorTimeoutMs(env({}), "/verify"), FACILITATOR_VERIFY_TIMEOUT_MS);
  assert.equal(facilitatorTimeoutMs(env({ FACILITATOR_SETTLE_TIMEOUT_MS: 250 }), "/settle"), 250);
  assert.equal(facilitatorTimeoutMs(env({ FACILITATOR_SETTLE_TIMEOUT_MS: "250" }), "/settle"), 250);
  assert.equal(facilitatorTimeoutMs(env({ FACILITATOR_SETTLE_TIMEOUT_MS: 10 * 60_000 }), "/settle"), FACILITATOR_SETTLE_TIMEOUT_MS, "a longer setting is ignored");
  assert.equal(facilitatorTimeoutMs(env({ FACILITATOR_VERIFY_TIMEOUT_MS: 10 * 60_000 }), "/verify"), FACILITATOR_VERIFY_TIMEOUT_MS);
  for (const bad of [0, -5, "soon", NaN, null, undefined]) assert.equal(facilitatorTimeoutMs(env({ FACILITATOR_SETTLE_TIMEOUT_MS: bad }), "/settle"), FACILITATOR_SETTLE_TIMEOUT_MS, `${String(bad)} falls back to the built-in bound`);
});

test("C1: a /settle that never answers is ABORTED inside its bound and takes the unknown-outcome path: claim pending, lease released, 'do not sign again'", async () => {
  const d1 = createLocalD1();
  // The facilitator holds /settle for 2 s; the bound is 200 ms. Without a timeout this request would wait the 2 s and settle.
  const stub = stubFacilitator({ settleDelayMs: 2_000 });
  try {
    const started = Date.now();
    const { value: res, lines } = await captureLog(() =>
      callWorker(registerReq({ handle: "hung-settle", model: "m", public_key: undefined as never }, registerHeader()), testEnv(d1, { FACILITATOR_SETTLE_TIMEOUT_MS: 200 })),
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1_500, `the request ended inside the bound (${elapsed} ms), not after the facilitator's 2 s`);
    assert.equal(stub.aborts.settle, 1, "the /settle fetch was aborted by the code's own timeout");
    assert.equal(res.status, 502, JSON.stringify(await res.clone().json()));
    const message = String((await json(res)).error);
    assert.match(message, /\/settle failed in transit \(no answer within 0\.2 s\)/);
    assert.match(message, /do not sign again/i);
    const row = oneClaim(d1) as unknown as { state: string; lease_owner: string | null; leased_until: number | null; rpc_body: string | null };
    assert.equal(row.state, "pending", "the money may have moved: the claim waits for the chain");
    assert.equal(row.lease_owner, null, "and the lease is released, so an identical re-send can re-check at once");
    assert.equal(row.leased_until, null);
    assert.ok(row.rpc_body, "the stored body is kept for the re-POST");
    assert.equal(count(d1, "citizens"), 0);
    assert.equal(count(d1, "ledger"), 0);
    assert.equal(eventLines(lines, "x402_settle_outcome_unknown").length, 1, "logged once, as every unknown outcome is");
  } finally {
    stub.restore();
    d1.close();
  }
});

test("C1: a /verify that never answers is ABORTED inside its bound and takes the verify-transit path: nothing claimed, nothing settled", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator({ verifyDelayMs: 2_000 });
  try {
    const started = Date.now();
    const res = await callWorker(registerReq({ handle: "hung-verify", model: "m" }, registerHeader()), testEnv(d1, { FACILITATOR_VERIFY_TIMEOUT_MS: 200 }));
    assert.ok(Date.now() - started < 1_500, "ended inside the bound");
    assert.equal(stub.aborts.verify, 1);
    assert.equal(res.status, 502);
    const message = String((await json(res)).error);
    assert.match(message, /could not be reached to verify this payment \(no answer within 0\.2 s\)/);
    assert.match(message, /never asked the facilitator to settle this payment/);
    assert.equal(stub.calls.settle, 0);
    assert.equal(count(d1, "settlement_claims"), 0, "a /verify failure takes no claim");
  } finally {
    stub.restore();
    d1.close();
  }
});

test("C1: the bound also covers the patron door, and a normal answer is not disturbed by it (the timer is cleared)", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator({ settleDelayMs: 2_000 });
  try {
    const res = await callWorker(patronReq("hung patron", paymentHeaderFor(TREASURY_ADDRESS, "1000000")), testEnv(d1, { FACILITATOR_SETTLE_TIMEOUT_MS: 200 }));
    assert.equal(res.status, 502);
    assert.equal(oneClaim(d1).state, "pending");
  } finally {
    stub.restore();
  }
  const fast = stubFacilitator({ settleDelayMs: 20 });
  try {
    const ok = await callWorker(patronReq("quick patron", paymentHeaderFor(TREASURY_ADDRESS, "1000000")), testEnv(d1, { FACILITATOR_SETTLE_TIMEOUT_MS: 5_000 }));
    assert.equal(ok.status, 200, "an answer inside the bound is served as before");
    assert.equal(fast.aborts.settle, 0);
  } finally {
    fast.restore();
    d1.close();
  }
});

// ---------- L1 ----------

const BOUNTY = 1200;
const REVIEWER_WALLET = "0x" + "0a".repeat(20);

async function payFixture(d1: LocalD1) {
  const funderId = insertCitizen(d1);
  const reviewerId = insertCitizen(d1);
  const pin = await declareTestWallet(d1, reviewerId, REVIEWER_WALLET);
  const listingId = insertListing(d1, { funder_citizen_id: funderId, bounty_cents: BOUNTY });
  const submissionId = insertSubmission(d1, { listing_id: listingId, citizen_id: reviewerId });
  const funder = d1.raw.prepare("SELECT id, handle, model, karma, created_at, last_seen_at FROM citizens WHERE id = ?").get(funderId) as never;
  const pay = () =>
    handlePayListing(
      new Request(`https://example.test/api/listing/${listingId}/pay`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-PAYMENT": paymentHeaderFor(REVIEWER_WALLET, atomicFromCents(BOUNTY)) },
        body: JSON.stringify({ submission_id: submissionId, wallet_row_id: pin.id, wallet_row_hash: pin.hash }),
      }),
      testEnv(d1),
      funder,
      listingId,
    );
  const listing = () => ({ ...(d1.raw.prepare("SELECT status, paying_since, paying_wallet_row_id, paying_wallet_row_hash FROM listings WHERE id = ?").get(listingId) as Record<string, unknown>) });
  return { pay, listing };
}

test("L1: a claim INSERT that THROWS after the pay-listing reservation releases the reservation and says plainly that nothing was sent to /settle", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator();
  try {
    const fx = await payFixture(d1);
    d1.raw.exec("CREATE TRIGGER no_claims BEFORE INSERT ON settlement_claims BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END;");
    const { value: res, lines } = await captureLog(() => fx.pay());
    assert.equal(res.status, 503, JSON.stringify(await res.clone().json()));
    const body = (await json(res)) as { error: string; code?: string };
    assert.equal(body.code, "settlement_claim_unavailable");
    assert.match(body.error, /nothing was sent to the facilitator's \/settle/i);
    assert.match(body.error, /nothing was charged/i);
    assert.doesNotMatch(body.error, /may have moved/i, "the old answer claimed the money may have moved; no /settle was sent");
    assert.deepEqual(fx.listing(), { status: "open", paying_since: null, paying_wallet_row_id: null, paying_wallet_row_hash: null }, "the reservation was released, not stranded in paying");
    assert.equal(count(d1, "settlement_claims"), 0);
    assert.equal(stub.calls.settle, 0, "no /settle was sent");
    assert.equal(eventLines(lines, "settlement_claim_not_taken").length, 1, "one loud log line names the failure");

    // and the funder can simply try again once the database is healthy
    d1.raw.exec("DROP TRIGGER no_claims");
    const again = await fx.pay();
    assert.equal(again.status, 200, JSON.stringify(await again.clone().json()));
  } finally {
    stub.restore();
    d1.close();
  }
});

test("L1 (register): the same failure on the registration door is a plain 503 with nothing sent, nothing created, and the header reusable", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator();
  try {
    const header = registerHeader();
    const body = { handle: "claim-down", model: "m", public_key: await realPublicKey() };
    d1.raw.exec("CREATE TRIGGER no_claims BEFORE INSERT ON settlement_claims BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END;");
    const res = await callWorker(registerReq(body, header), testEnv(d1));
    assert.equal(res.status, 503);
    assert.match(String((await json(res)).error), /nothing was sent to the facilitator's \/settle/i);
    assert.equal(stub.calls.settle, 0);
    assert.equal(count(d1, "citizens"), 0);
    d1.raw.exec("DROP TRIGGER no_claims");
    assert.equal((await callWorker(registerReq(body, header), testEnv(d1))).status, 201, "the same signed header registers once the database is healthy");
  } finally {
    stub.restore();
    d1.close();
  }
});
