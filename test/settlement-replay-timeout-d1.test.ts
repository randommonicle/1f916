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
