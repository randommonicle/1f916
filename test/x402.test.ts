// Tests for x402.ts's shared verify/settle core. The case that matters
// most: a request with no X-PAYMENT header must come back as a 402 naming
// what is required, must never call the facilitator, and must never call
// an afterVerify hook -- never a silent bypass. Both handlePatron and the
// registration gate (register-gate.ts) depend on this holding, which is
// exactly why it is tested once here against the shared core rather than
// once per caller.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { buildPaymentRequirements, payAndSettle, USDC_BASE } from "../src/x402.ts";
import { SocietyError } from "../src/society.ts";
import type { Env } from "../src/society.ts";

const FAKE_ENV = {
  TREASURY_ADDRESS: "0xa7f7985eb19b8c44f12a0654df1ef89d1dd527c9",
  FACILITATOR_URL: "https://facilitator.example.invalid",
  REGISTRATION_MODE: "invite_only",
} as Env;

function testRequirements() {
  return buildPaymentRequirements(FAKE_ENV, {
    resource: "https://example.test/api/register",
    description: "test payment requirements",
    priceAtomic: "1000000",
  });
}

test("payment requirements name the treasury address, USDC on Base, and the given price", () => {
  const reqs = testRequirements();
  assert.equal(reqs.network, "base");
  assert.equal(reqs.asset, USDC_BASE);
  assert.equal(reqs.payTo, FAKE_ENV.TREASURY_ADDRESS);
  assert.equal(reqs.maxAmountRequired, "1000000");
  assert.equal(reqs.resource, "https://example.test/api/register");
});

// docs/DESIGN-ECONOMY-V1.md §6.2/§13: buildPaymentRequirements gains an
// OPTIONAL payTo, defaulting to the treasury -- this pair of tests is the
// money-correctness proof that the generalisation is byte-identical for
// every caller that predates it (handlePatron, handleRegisterGate, both of
// which omit payTo) while genuinely honouring an explicit payTo when one is
// given (the listings economy's funder-pays-reviewer flow, listings.ts).
test("buildPaymentRequirements with no payTo defaults to the treasury address -- every existing caller is unaffected", () => {
  const reqs = buildPaymentRequirements(FAKE_ENV, {
    resource: "https://example.test/api/patron",
    description: "no payTo given",
    priceAtomic: "1000000",
  });
  assert.equal(reqs.payTo, FAKE_ENV.TREASURY_ADDRESS);
});

test("buildPaymentRequirements with an explicit payTo uses it INSTEAD of the treasury -- the one new money-path surface the listings economy adds", () => {
  const reviewerWallet = "0x00000000000000000000000000000000000bee";
  const reqs = buildPaymentRequirements(FAKE_ENV, {
    resource: "https://example.test/api/listing/1/pay",
    description: "bounty payment, not a treasury inflow",
    priceAtomic: "10000000",
    payTo: reviewerWallet,
  });
  assert.equal(reqs.payTo, reviewerWallet);
  assert.notEqual(reqs.payTo, FAKE_ENV.TREASURY_ADDRESS, "an explicit payTo must never silently fall back to the treasury");
});

test("a request with no X-PAYMENT header is refused with 402 and the requirements", async () => {
  const reqs = testRequirements();
  const request = new Request("https://example.test/api/register", { method: "POST" });
  const result = await payAndSettle(FAKE_ENV, request, reqs);
  assert.equal(result.ok, false);
  if (result.ok) return; // unreachable, narrows for TS below
  assert.equal(result.response.status, 402);
  const payload = (await result.response.json()) as { error: string; accepts: unknown[] };
  assert.equal(payload.error, "Payment required. Sign an x402 payment and retry with the X-PAYMENT header.");
  assert.deepEqual(payload.accepts, [reqs]);
});

test("no X-PAYMENT header means afterVerify is never called (nothing settles without a signature)", async () => {
  const reqs = testRequirements();
  const request = new Request("https://example.test/api/register", { method: "POST" });
  let called = false;
  await payAndSettle(FAKE_ENV, request, reqs, async () => {
    called = true;
  });
  assert.equal(called, false);
});

test("a malformed X-PAYMENT header throws a 400, not a silent pass or an opaque 500", async () => {
  const reqs = testRequirements();
  const request = new Request("https://example.test/api/register", {
    method: "POST",
    headers: { "X-PAYMENT": "not-valid-base64-json!!!" },
  });
  await assert.rejects(() => payAndSettle(FAKE_ENV, request, reqs), SocietyError);
});
