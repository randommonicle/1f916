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
import { buildPaymentRequirements, payAndSettle, assertPayloadMatchesRequirements, classifySettle, classifyVerify, USDC_BASE } from "../src/x402.ts";
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

test("CODEX build finding 1: a /settle answer without a boolean `success` (an intermediary's JSON 502, an empty object, a string 'true') is an UNKNOWN outcome, thrown as 502 -- never read as a refusal; an explicit success:false still is one", async () => {
  const reqs = testRequirements();
  const original = globalThis.fetch;
  const good = btoa(JSON.stringify(payloadFor(authFor(reqs))));
  const run = async (settleStatus: number, settleBody: unknown) => {
    globalThis.fetch = (async (url: unknown) => {
      const href = String(url);
      if (href.endsWith("/verify")) return new Response(JSON.stringify({ isValid: true }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify(settleBody), { status: settleStatus, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    return payAndSettle(FAKE_ENV, new Request("https://example.test/api/register", { method: "POST", headers: { "X-PAYMENT": good } }), reqs);
  };
  try {
    for (const [status, body] of [[502, { error: "upstream timeout" }], [200, {}], [200, { success: "true" }], [200, { success: null }], [200, null], [200, [true]], [200, "success"]] as const) {
      await assert.rejects(run(status, body), (e: unknown) => e instanceof SocietyError && e.status === 502 && /unknown until the chain is checked/.test(e.message), `HTTP ${status} ${JSON.stringify(body)} is unknown, not a refusal`);
    }
    const refused = await run(200, { success: false, errorReason: "insufficient_funds" });
    assert.equal(refused.ok, false, "an explicit success:false is still a refusal");
    if (!refused.ok) assert.equal(refused.response.status, 402);
  } finally {
    globalThis.fetch = original;
  }
});

test("CODEX build round 2: a /verify answer that is JSON null is no answer -- a 502 'money was not taken', never a TypeError, and /settle is never called", async () => {
  const reqs = testRequirements();
  const original = globalThis.fetch;
  let settles = 0;
  globalThis.fetch = (async (url: unknown) => {
    if (String(url).endsWith("/settle")) settles++;
    return new Response("null", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    const good = btoa(JSON.stringify(payloadFor(authFor(reqs))));
    await assert.rejects(
      payAndSettle(FAKE_ENV, new Request("https://example.test/api/register", { method: "POST", headers: { "X-PAYMENT": good } }), reqs),
      (e: unknown) => e instanceof SocietyError && e.status === 502 && /money was not taken/.test(e.message),
    );
    assert.equal(settles, 0);
  } finally {
    globalThis.fetch = original;
  }
});

test("re-gate L1: an unknown /settle outcome is LOGGED for every caller (event x402_settle_outcome_unknown, with the resource, payee and amount), because the router serves the 502 without a log line", async () => {
  const reqs = testRequirements();
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const lines: string[] = [];
  globalThis.fetch = (async (url: unknown) => {
    if (String(url).endsWith("/verify")) return new Response(JSON.stringify({ isValid: true }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response(JSON.stringify({ error: "upstream timeout" }), { status: 502, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
  try {
    const good = btoa(JSON.stringify(payloadFor(authFor(reqs))));
    await assert.rejects(payAndSettle(FAKE_ENV, new Request("https://example.test/api/register", { method: "POST", headers: { "X-PAYMENT": good } }), reqs), SocietyError);
  } finally {
    globalThis.fetch = originalFetch;
    console.log = originalLog;
  }
  const events = lines.map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } }).filter((e) => e?.event === "x402_settle_outcome_unknown");
  assert.equal(events.length, 1, "exactly one unknown-outcome line");
  assert.equal(events[0]!.resource, reqs.resource);
  assert.equal(events[0]!.pay_to, reqs.payTo);
  assert.equal(events[0]!.amount_atomic, reqs.maxAmountRequired);
});

test("A4 with the production shape: a checksum-cased TREASURY_ADDRESS (wrangler.jsonc) and a payload signed for exactly that string pass; the lowercase form passes too", () => {
  const env = { ...FAKE_ENV, TREASURY_ADDRESS: "0xA7f7985eb19B8c44F12a0654dF1EF89D1dD527c9" } as Env;
  const reqs = buildPaymentRequirements(env, { resource: "https://example.test/api/register", description: "checksum-cased treasury", priceAtomic: "1000000" });
  assertPayloadMatchesRequirements(payloadFor(authFor(reqs)), reqs);
  assertPayloadMatchesRequirements(payloadFor(authFor(reqs, { to: reqs.payTo.toLowerCase() })), reqs);
});

test("errorBody: an error with no code serialises exactly as before codes existed ({ error }); a coded one adds `code` and keeps the prose in `error`", () => {
  assert.deepEqual(errorBody(new SocietyError(409, "listing 3 is paid, not open")), { error: "listing 3 is paid, not open" });
  assert.deepEqual(Object.keys(errorBody(new SocietyError(409, "x"))), ["error"]);
  assert.deepEqual(errorBody(new SocietyError(400, "bad payload", "payment_payload_mismatch")), { error: "bad payload", code: "payment_payload_mismatch" });
});

// ---------- B2 (docs/BRIEF-X402-SETTLE-HONESTY.md): classifySettle, rules 1-8 ----------
// Each row names the rule that must match. Rules 1, 2, 3 and 6 are observable
// ONLY through `rule` and the wording: remove any one and rule 8 still calls
// its answers unknown (rule 7 names four statuses and requires every condition
// PayAI documents). The route tests (x402-settle-route-d1.test.ts) prove the
// outcomes; this table proves which rule decided each one.

const PENDING_TX = "0x" + "cd".repeat(32);
const HUB_PENDING_WITH_TX = `The facilitator has not yet settled this payment (settlement_pending): it may still land on-chain. It reports the broadcast transaction ${PENDING_TX}. Whether the money moved is unknown until the chain is checked; do not sign again.`;
const HUB_PENDING_NO_TX = "The facilitator has not yet settled this payment (settlement_pending): it may still land on-chain. Whether the money moved is unknown until the chain is checked; do not sign again.";
const hubRefusal = (status: number, reason: string) => `The facilitator reports that this settlement failed (HTTP ${status}, reason: ${reason}). By its account no money moved.`;

type SettleRow = { status: number; body: Record<string, unknown>; kind: "settled" | "refused" | "unknown"; rule: number };
const SETTLE_ROWS: SettleRow[] = [
  // rule 1: any 5xx, whatever the body says (500-599 inclusive)
  { status: 500, body: { success: false, errorReason: "x" }, kind: "unknown", rule: 1 },
  { status: 502, body: {}, kind: "unknown", rule: 1 },
  { status: 599, body: { success: true, transaction: "0xab" }, kind: "unknown", rule: 1 },
  // rule 2: 409, whatever the body says
  { status: 409, body: { success: false, errorReason: "duplicate_settlement" }, kind: "unknown", rule: 2 },
  { status: 409, body: { success: true, transaction: "0xab" }, kind: "unknown", rule: 2 },
  // rule 3: no boolean success (the second row would be a refusal without it)
  { status: 200, body: {}, kind: "unknown", rule: 3 },
  { status: 200, body: { success: "false", errorReason: "insufficient_funds" }, kind: "unknown", rule: 3 },
  { status: 403, body: { success: null, errorReason: "policy" }, kind: "unknown", rule: 3 },
  // rule 4: success:true settles on a 2xx only
  { status: 200, body: { success: true, payer: "0xpayer", transaction: "0xtx" }, kind: "settled", rule: 4 },
  { status: 201, body: { success: true }, kind: "settled", rule: 4 },
  { status: 299, body: { success: true }, kind: "settled", rule: 4 },
  { status: 300, body: { success: true }, kind: "unknown", rule: 4 },
  { status: 403, body: { success: true }, kind: "unknown", rule: 4 },
  // rule 5: settlement_pending on ANY status is unknown (the 400/403 rows would be refusals without it)
  { status: 200, body: { success: false, errorReason: "settlement_pending", transaction: PENDING_TX }, kind: "unknown", rule: 5 },
  { status: 200, body: { success: false, errorReason: "settlement_pending" }, kind: "unknown", rule: 5 },
  { status: 400, body: { success: false, errorReason: "settlement_pending" }, kind: "unknown", rule: 5 },
  { status: 403, body: { success: false, errorReason: "settlement_pending" }, kind: "unknown", rule: 5 },
  // rule 6: success:false with errorReason absent, not a string, or blank after trimming
  { status: 200, body: { success: false }, kind: "unknown", rule: 6 },
  { status: 200, body: { success: false, errorReason: "" }, kind: "unknown", rule: 6 },
  { status: 400, body: { success: false, errorReason: 42 }, kind: "unknown", rule: 6 },
  { status: 403, body: { success: false, errorReason: null }, kind: "unknown", rule: 6 },
  // F3 (build review round 1): a blank reason is no reason (each was a rule-7 refusal before the fix)
  { status: 200, body: { success: false, errorReason: " " }, kind: "unknown", rule: 6 },
  { status: 403, body: { success: false, errorReason: " " }, kind: "unknown", rule: 6 },
  { status: 401, body: { success: false, errorReason: "\t\n " }, kind: "unknown", rule: 6 },
  // rule 7: the two documented refusals, and only those
  { status: 200, body: { success: false, errorReason: "insufficient_funds" }, kind: "refused", rule: 7 },
  { status: 400, body: { success: false, errorReason: "policy" }, kind: "refused", rule: 7 },
  { status: 401, body: { success: false, errorReason: "policy" }, kind: "refused", rule: 7 },
  { status: 403, body: { success: false, errorReason: "policy" }, kind: "refused", rule: 7 },
  // rule 8: every other 4xx, every 2xx other than 200, any 1xx or 3xx, and the edges either side of 5xx
  { status: 408, body: { success: false, errorReason: "upstream_timeout" }, kind: "unknown", rule: 8 },
  { status: 429, body: { success: false, errorReason: "rate_limited" }, kind: "unknown", rule: 8 },
  { status: 402, body: { success: false, errorReason: "x" }, kind: "unknown", rule: 8 },
  { status: 404, body: { success: false, errorReason: "x" }, kind: "unknown", rule: 8 },
  { status: 422, body: { success: false, errorReason: "x" }, kind: "unknown", rule: 8 },
  { status: 202, body: { success: false, errorReason: "x" }, kind: "unknown", rule: 8 },
  { status: 204, body: { success: false, errorReason: "x" }, kind: "unknown", rule: 8 },
  { status: 302, body: { success: false, errorReason: "x" }, kind: "unknown", rule: 8 },
  { status: 101, body: { success: false, errorReason: "x" }, kind: "unknown", rule: 8 },
  { status: 499, body: { success: false, errorReason: "x" }, kind: "unknown", rule: 8 },
  { status: 600, body: { success: false, errorReason: "x" }, kind: "unknown", rule: 8 },
];

test("B2 classifySettle: every row is decided by the rule the brief names, first match wins", () => {
  for (const row of SETTLE_ROWS) {
    const v = classifySettle(row.status, row.body);
    const label = `HTTP ${row.status} ${JSON.stringify(row.body)}`;
    assert.equal(v.kind, row.kind, `${label}: kind`);
    assert.equal(v.rule, row.rule, `${label}: decided by rule ${row.rule}`);
    if (v.kind === "unknown") assert.match(v.message, /unknown until the chain is checked/, `${label}: an unknown outcome says so`);
  }
});

// F5 + F6 (build review round 1): every builder-worded unknown message (rules
// 1, 2, 4, 6 and 8), asserted exactly. Each states the status and quotes the
// errorReason as given, says why the outcome is unknown, and claims nothing the
// answer did not say (a 409 with no reason is not called duplicate_settlement;
// an intermediary's `error` field is not the facilitator's errorReason).
test("F6 classifySettle: the unknown-rule messages, exactly, for every way an errorReason can be given", () => {
  const TAIL = "The settle request was sent; whether the money moved is unknown until the chain is checked; do not sign again.";
  const rows: { status: number; body: Record<string, unknown>; rule: number; message: string }[] = [
    { status: 500, body: { success: false, errorReason: "x" }, rule: 1, message: `The facilitator answered /settle with HTTP 500 (errorReason: x). A 5xx answer is not a settlement verdict. ${TAIL}` },
    { status: 502, body: {}, rule: 1, message: `The facilitator answered /settle with HTTP 502 (no errorReason). A 5xx answer is not a settlement verdict. ${TAIL}` },
    { status: 503, body: { error: "upstream timeout" }, rule: 1, message: `The facilitator answered /settle with HTTP 503 (no errorReason). A 5xx answer is not a settlement verdict. ${TAIL}` },
    { status: 409, body: { success: false, errorReason: "duplicate_settlement" }, rule: 2, message: `The facilitator answered /settle with HTTP 409 (errorReason: duplicate_settlement). A 409 answer is not a settlement verdict. ${TAIL}` },
    { status: 409, body: { success: true }, rule: 2, message: `The facilitator answered /settle with HTTP 409 (no errorReason). A 409 answer is not a settlement verdict. ${TAIL}` },
    { status: 409, body: { success: false, errorReason: "another_reason" }, rule: 2, message: `The facilitator answered /settle with HTTP 409 (errorReason: another_reason). A 409 answer is not a settlement verdict. ${TAIL}` },
    { status: 403, body: { success: true }, rule: 4, message: `The facilitator answered /settle with HTTP 403 and success: true (no errorReason). A success on a status other than 2xx is not a settlement verdict. ${TAIL}` },
    { status: 200, body: { success: false }, rule: 6, message: `The facilitator answered /settle with HTTP 200 and success: false (no errorReason). A failure without a usable reason cannot be classified. ${TAIL}` },
    { status: 200, body: { success: false, errorReason: " " }, rule: 6, message: `The facilitator answered /settle with HTTP 200 and success: false (a blank errorReason). A failure without a usable reason cannot be classified. ${TAIL}` },
    { status: 400, body: { success: false, errorReason: 42 }, rule: 6, message: `The facilitator answered /settle with HTTP 400 and success: false (an errorReason that is not a string: 42). A failure without a usable reason cannot be classified. ${TAIL}` },
    { status: 403, body: { success: false, errorReason: null }, rule: 6, message: `The facilitator answered /settle with HTTP 403 and success: false (an errorReason that is not a string: null). A failure without a usable reason cannot be classified. ${TAIL}` },
    { status: 408, body: { success: false, errorReason: "upstream_timeout" }, rule: 8, message: `The facilitator answered /settle with HTTP 408 and success: false (errorReason: upstream_timeout). PayAI does not document that combination as a definitive refusal. ${TAIL}` },
    { status: 202, body: { success: false, errorReason: "x" }, rule: 8, message: `The facilitator answered /settle with HTTP 202 and success: false (errorReason: x). PayAI does not document that combination as a definitive refusal. ${TAIL}` },
    { status: 429, body: { success: false, errorReason: "r".repeat(250) }, rule: 8, message: `The facilitator answered /settle with HTTP 429 and success: false (errorReason: ${"r".repeat(200)}). PayAI does not document that combination as a definitive refusal. ${TAIL}` },
  ];
  for (const r of rows) {
    const v = classifySettle(r.status, r.body);
    const label = `HTTP ${r.status} ${JSON.stringify(r.body).slice(0, 80)}`;
    assert.equal(v.kind, "unknown", `${label}: unknown`);
    assert.equal(v.rule, r.rule, `${label}: rule ${r.rule}`);
    if (v.kind === "unknown") assert.equal(v.message, r.message, `${label}: the message, exactly`);
  }
});

test("B2 rule 5: the hub's wording, verbatim, with and without a broadcast transaction; only a non-empty string transaction is named", () => {
  const withTx = classifySettle(200, { success: false, errorReason: "settlement_pending", transaction: PENDING_TX });
  assert.equal(withTx.kind, "unknown");
  if (withTx.kind !== "unknown") return;
  assert.equal(withTx.message, HUB_PENDING_WITH_TX);
  assert.equal(withTx.broadcastTx, PENDING_TX);
  for (const body of [{ success: false, errorReason: "settlement_pending" }, { success: false, errorReason: "settlement_pending", transaction: "" }, { success: false, errorReason: "settlement_pending", transaction: 12 }]) {
    const v = classifySettle(200, body);
    assert.equal(v.kind, "unknown");
    if (v.kind !== "unknown") return;
    assert.equal(v.message, HUB_PENDING_NO_TX, JSON.stringify(body));
    assert.equal("broadcastTx" in v, false, `${JSON.stringify(body)}: no broadcast transaction is claimed`);
  }
});

test("B2 rule 7: the refusal's error is the hub's wording with the facilitator's own status and reason; the reason is clipped to 200 characters", () => {
  for (const status of [200, 400, 401, 403]) {
    const v = classifySettle(status, { success: false, errorReason: "policy" });
    assert.equal(v.kind, "refused");
    if (v.kind !== "refused") return;
    assert.equal(v.error, hubRefusal(status, "policy"));
    assert.equal(v.status, status);
  }
  const long = classifySettle(200, { success: false, errorReason: "r".repeat(250) });
  assert.equal(long.kind, "refused");
  if (long.kind !== "refused") return;
  assert.equal(long.reason, "r".repeat(200));
  assert.equal(long.error, hubRefusal(200, "r".repeat(200)));
});

test("B2 rule 4: a settled answer carries the payer and transaction exactly as before this wave (payer 'unknown' and tx '' when absent)", () => {
  assert.deepEqual(classifySettle(200, { success: true, payer: "0xpayer", transaction: "0xtx" }), { kind: "settled", rule: 4, payer: "0xpayer", tx: "0xtx" });
  assert.deepEqual(classifySettle(200, { success: true }), { kind: "settled", rule: 4, payer: "unknown", tx: "" });
});

test("B2 through payAndSettle: a pending /settle is thrown as a 502 carrying the hub's message, logged exactly once as x402_settle_outcome_unknown, and the line carries broadcast_tx only when the facilitator named one", async () => {
  const reqs = testRequirements();
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const good = btoa(JSON.stringify(payloadFor(authFor(reqs))));
  const run = async (settleBody: unknown) => {
    const lines: string[] = [];
    globalThis.fetch = (async (url: unknown) => {
      if (String(url).endsWith("/verify")) return new Response(JSON.stringify({ isValid: true }), { status: 200, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify(settleBody), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
    let thrown: unknown;
    try {
      await payAndSettle(FAKE_ENV, new Request("https://example.test/api/register", { method: "POST", headers: { "X-PAYMENT": good } }), reqs);
    } catch (e) {
      thrown = e;
    } finally {
      globalThis.fetch = originalFetch;
      console.log = originalLog;
    }
    const events = lines.map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } }).filter((e) => e?.event === "x402_settle_outcome_unknown");
    return { thrown, events };
  };
  const withTx = await run({ success: false, errorReason: "settlement_pending", transaction: PENDING_TX });
  assert.ok(withTx.thrown instanceof SocietyError && withTx.thrown.status === 502, "a 502, not a 402 that invites a second payment");
  assert.equal((withTx.thrown as SocietyError).message, HUB_PENDING_WITH_TX);
  assert.equal(withTx.events.length, 1, "exactly one unknown-outcome line");
  assert.equal(withTx.events[0]!.broadcast_tx, PENDING_TX);
  assert.equal(withTx.events[0]!.reason, HUB_PENDING_WITH_TX);
  const noTx = await run({ success: false, errorReason: "settlement_pending" });
  assert.ok(noTx.thrown instanceof SocietyError && noTx.thrown.status === 502);
  assert.equal(noTx.events.length, 1);
  assert.equal("broadcast_tx" in noTx.events[0]!, false, "no broadcast transaction is claimed when none was reported");
});

// ---------- F1 (build review round 1, CODEX HIGH): a facilitator request that fails in transit ----------

test("F1 through payAndSettle: a /settle fetch that REJECTS is a 502 with the hub's in-transit message, logged exactly once as x402_settle_outcome_unknown; a /verify fetch that rejects is a 502 'could not be reached', /settle is never called, and no settle-outcome line is written", async () => {
  const reqs = testRequirements();
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const good = btoa(JSON.stringify(payloadFor(authFor(reqs))));
  const run = async (rejectOn: "/verify" | "/settle") => {
    const lines: string[] = [];
    let settles = 0;
    globalThis.fetch = (async (url: unknown) => {
      const href = String(url);
      if (href.endsWith("/settle")) settles++;
      if (href.endsWith(rejectOn)) throw new TypeError("fetch failed: other side closed");
      return new Response(JSON.stringify({ isValid: true }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    console.log = (...args: unknown[]) => { lines.push(args.map(String).join(" ")); };
    let thrown: unknown;
    try {
      await payAndSettle(FAKE_ENV, new Request("https://example.test/api/register", { method: "POST", headers: { "X-PAYMENT": good } }), reqs);
    } catch (e) {
      thrown = e;
    } finally {
      globalThis.fetch = originalFetch;
      console.log = originalLog;
    }
    const events = lines.map((l) => { try { return JSON.parse(l) as Record<string, unknown>; } catch { return null; } }).filter((e) => e?.event === "x402_settle_outcome_unknown");
    return { thrown, events, settles };
  };
  const settleTransit = "The request to the facilitator's /settle failed in transit (fetch failed: other side closed); it may have been received and settled. Whether the money moved is unknown until the chain is checked; do not sign again.";
  const s = await run("/settle");
  assert.ok(s.thrown instanceof SocietyError && s.thrown.status === 502, "a SocietyError 502, never the runtime's own error (a generic 500 at the router)");
  assert.equal((s.thrown as SocietyError).message, settleTransit);
  assert.equal(s.events.length, 1, "exactly one unknown-outcome line");
  assert.equal(s.events[0]!.reason, settleTransit);
  const v = await run("/verify");
  assert.ok(v.thrown instanceof SocietyError && v.thrown.status === 502, "a SocietyError 502");
  assert.equal((v.thrown as SocietyError).message, "The payment facilitator could not be reached to verify this payment (fetch failed: other side closed); the request may still have been delivered. This server never asked the facilitator to settle this payment. Try again later.");
  assert.equal(v.settles, 0, "/settle is never called after a /verify that failed in transit");
  assert.equal(v.events.length, 0, "no settle-outcome line: nothing was sent that could settle");
});

// ---------- B3 (docs/BRIEF-X402-SETTLE-HONESTY.md): classifyVerify ----------

const hubVerifyRefused = (status: number, reason: string) => `The payment facilitator refused to verify this payment (HTTP ${status}, reason: ${reason}). This server never asked the facilitator to settle this payment.`;
const hubVerifyFailed = (status: number, reason: string) => `The payment facilitator failed to verify this payment (HTTP ${status}, reason: ${reason}). This server never asked the facilitator to settle this payment. Try again later.`;

test("B3 classifyVerify: only a 2xx with isValid:true proceeds; a 2xx without it is the unchanged 402; a 4xx is a refusal and a 5xx a failure, whatever isValid says", () => {
  const rows: { status: number; body: Record<string, unknown>; kind: string; rule: number; text?: string }[] = [
    { status: 200, body: { isValid: true }, kind: "valid", rule: 2 },
    { status: 299, body: { isValid: true }, kind: "valid", rule: 2 },
    { status: 200, body: { isValid: false, invalidReason: "x" }, kind: "invalid", rule: 3, text: "x" },
    { status: 200, body: { isValid: false }, kind: "invalid", rule: 3, text: "payment invalid" },
    { status: 200, body: { isValid: "true" }, kind: "invalid", rule: 3, text: "payment invalid" },
    { status: 200, body: { isValid: false, invalidReason: 5 }, kind: "invalid", rule: 3, text: "5" },
    { status: 403, body: { isValid: false, invalidReason: "x" }, kind: "refused", rule: 4, text: hubVerifyRefused(403, "x") },
    { status: 422, body: { isValid: true }, kind: "refused", rule: 4, text: hubVerifyRefused(422, "none given") },
    { status: 400, body: {}, kind: "refused", rule: 4, text: hubVerifyRefused(400, "none given") },
    { status: 499, body: { error: "e" }, kind: "refused", rule: 4, text: hubVerifyRefused(499, "e") },
    { status: 500, body: { isValid: true }, kind: "failed", rule: 5, text: hubVerifyFailed(500, "none given") },
    { status: 503, body: { errorReason: "down" }, kind: "failed", rule: 5, text: hubVerifyFailed(503, "down") },
    { status: 599, body: { message: "m" }, kind: "failed", rule: 5, text: hubVerifyFailed(599, "m") },
    { status: 302, body: { isValid: true }, kind: "failed", rule: 5, text: hubVerifyFailed(302, "none given") },
  ];
  for (const r of rows) {
    const v = classifyVerify(r.status, r.body);
    const label = `HTTP ${r.status} ${JSON.stringify(r.body)}`;
    assert.equal(v.kind, r.kind, `${label}: kind`);
    assert.equal(v.rule, r.rule, `${label}: rule`);
    if (v.kind === "invalid" || v.kind === "refused") assert.equal(v.error, r.text, `${label}: error`);
    if (v.kind === "failed") assert.equal(v.message, r.text, `${label}: message`);
  }
});

test("F4 (build review round 1) classifyVerify: an empty or blank string is no reason, so it never masks a real one in a later key, and alone it is 'none given'", () => {
  const reasonOf = (body: Record<string, unknown>) => {
    const v = classifyVerify(403, body);
    return v.kind === "refused" ? v.error : `not refused: ${v.kind}`;
  };
  assert.equal(reasonOf({ invalidReason: "", errorReason: "real_reason" }), hubVerifyRefused(403, "real_reason"), "an empty invalidReason does not mask errorReason");
  assert.equal(reasonOf({ invalidReason: "   ", error: "the error" }), hubVerifyRefused(403, "the error"), "a blank invalidReason does not mask error");
  assert.equal(reasonOf({ errorReason: "\t\n", message: "the message" }), hubVerifyRefused(403, "the message"), "a blank errorReason does not mask message");
  assert.equal(reasonOf({ invalidReason: "", errorReason: " " }), hubVerifyRefused(403, "none given"), "blank throughout is none given, never 'reason: '");
});

test("B3 classifyVerify: the reason is the first STRING among invalidReason, errorReason, error, message, clipped to 200 characters, else 'none given'", () => {
  const reasonOf = (body: Record<string, unknown>) => {
    const v = classifyVerify(403, body);
    assert.equal(v.kind, "refused");
    return v.kind === "refused" ? v.error : "";
  };
  assert.equal(reasonOf({ invalidReason: "first", errorReason: "second", error: "third", message: "fourth" }), hubVerifyRefused(403, "first"));
  assert.equal(reasonOf({ invalidReason: 7, errorReason: "second", error: "third" }), hubVerifyRefused(403, "second"), "a non-string is skipped");
  assert.equal(reasonOf({ error: "third", message: "fourth" }), hubVerifyRefused(403, "third"));
  assert.equal(reasonOf({ message: "fourth" }), hubVerifyRefused(403, "fourth"));
  assert.equal(reasonOf({ invalidReason: null, errorReason: { nested: 1 } }), hubVerifyRefused(403, "none given"));
  assert.equal(reasonOf({ errorReason: "e".repeat(250) }), hubVerifyRefused(403, "e".repeat(200)));
});
