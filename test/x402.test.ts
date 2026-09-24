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
import { buildPaymentRequirements, payAndSettle, assertPayloadMatchesRequirements, USDC_BASE } from "../src/x402.ts";
import { SocietyError, errorBody } from "../src/society.ts";
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

// ---------- A4 (docs/BRIEF-SERVER-SIDE-WALLET-PIN.md): the local payload check ----------
// payAndSettle compares the decoded payload's signed `to` and `value` with the
// requirements BEFORE /verify. It removes reliance on the facilitator for that
// comparison only; signature verification and settlement stay the
// facilitator's (the stub below never checks a signature).

function payloadFor(auth: unknown): unknown {
  return { x402Version: 1, scheme: "exact", network: "base", payload: { signature: "0x" + "11".repeat(65), authorization: auth } };
}
function authFor(reqs: { payTo: string; maxAmountRequired: string }, overrides: Record<string, unknown> = {}) {
  return { from: "0x00000000000000000000000000000000000000fa", to: reqs.payTo, value: reqs.maxAmountRequired, validAfter: "0", validBefore: "9999999999", nonce: "0x" + "00".repeat(32), ...overrides };
}
function assertMismatch(fn: () => void, fragment: RegExp) {
  assert.throws(fn, (e: unknown) => {
    assert.ok(e instanceof SocietyError, "a SocietyError");
    assert.equal(e.status, 400);
    assert.equal(e.code, "payment_payload_mismatch");
    assert.match(e.message, fragment);
    return true;
  });
}

test("A4: a payload signed for exactly the requirements passes; an EIP-55 checksum-cased `to` passes too (case is presentation)", () => {
  const reqs = testRequirements();
  assertPayloadMatchesRequirements(payloadFor(authFor(reqs)), reqs);
  assertPayloadMatchesRequirements(payloadFor(authFor(reqs, { to: "0xA7F7985EB19B8C44F12A0654DF1EF89D1DD527C9" })), reqs);
});

test("A4: a payload signed for another destination is refused 400 payment_payload_mismatch", () => {
  const reqs = testRequirements();
  assertMismatch(() => assertPayloadMatchesRequirements(payloadFor(authFor(reqs, { to: "0x00000000000000000000000000000000000bad00" })), reqs), /pays "0x00000000000000000000000000000000000bad00".*requires payTo/);
});

test("A4: a payload signed for another amount is refused, including the same amount carried as a number rather than the scheme's decimal string", () => {
  const reqs = testRequirements();
  assertMismatch(() => assertPayloadMatchesRequirements(payloadFor(authFor(reqs, { value: "999999" })), reqs), /value "999999".*requires exactly "1000000"/);
  assertMismatch(() => assertPayloadMatchesRequirements(payloadFor(authFor(reqs, { value: 1000000 })), reqs), /value 1000000/);
});

test("A4: an absent, null, array-shaped or field-less authorization is refused, never guessed at", () => {
  const reqs = testRequirements();
  for (const p of [{ fake: "payment-payload-for-a-test-stub" }, null, 42, "x", { payload: null }, payloadFor(null), payloadFor([authFor(reqs)])]) {
    assertMismatch(() => assertPayloadMatchesRequirements(p, reqs), /no payload\.authorization object/);
  }
  assertMismatch(() => assertPayloadMatchesRequirements(payloadFor({ value: reqs.maxAmountRequired }), reqs), /pays undefined/);
  assertMismatch(() => assertPayloadMatchesRequirements(payloadFor({ to: reqs.payTo }), reqs), /value undefined/);
});

test("A4 inside payAndSettle: a mismatched payload throws BEFORE the facilitator is called at all (no /verify, no afterVerify, no /settle)", async () => {
  const reqs = testRequirements();
  const original = globalThis.fetch;
  let fetches = 0;
  let afterVerifyCalls = 0;
  globalThis.fetch = (async () => {
    fetches++;
    return new Response(JSON.stringify({ isValid: true, success: true }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const bad = btoa(JSON.stringify(payloadFor(authFor(reqs, { to: "0x00000000000000000000000000000000000bad00" }))));
    const request = new Request("https://example.test/api/register", { method: "POST", headers: { "X-PAYMENT": bad } });
    await assert.rejects(
      () => payAndSettle(FAKE_ENV, request, reqs, async () => { afterVerifyCalls++; }),
      (e: unknown) => e instanceof SocietyError && e.status === 400 && e.code === "payment_payload_mismatch",
    );
    assert.equal(fetches, 0, "nothing reaches the facilitator");
    assert.equal(afterVerifyCalls, 0);
    // Positive control: the same harness with a matching payload DOES reach
    // the facilitator (so the zero above is the check, not a broken stub).
    const good = btoa(JSON.stringify(payloadFor(authFor(reqs))));
    const ok = await payAndSettle(FAKE_ENV, new Request("https://example.test/api/register", { method: "POST", headers: { "X-PAYMENT": good } }), reqs, async () => { afterVerifyCalls++; });
    assert.equal(ok.ok, true);
    assert.equal(fetches, 2, "/verify then /settle");
    assert.equal(afterVerifyCalls, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test("errorBody: an error with no code serialises exactly as before codes existed ({ error }); a coded one adds `code` and keeps the prose in `error`", () => {
  assert.deepEqual(errorBody(new SocietyError(409, "listing 3 is paid, not open")), { error: "listing 3 is paid, not open" });
  assert.deepEqual(Object.keys(errorBody(new SocietyError(409, "x"))), ["error"]);
  assert.deepEqual(errorBody(new SocietyError(400, "bad payload", "payment_payload_mismatch")), { error: "bad payload", code: "payment_payload_mismatch" });
});
