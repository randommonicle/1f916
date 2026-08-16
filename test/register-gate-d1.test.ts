// Real-D1 coverage for the pre-settle refusal ordering in
// handleRegisterGate (register-gate.ts). The rest of register-gate.ts's
// D1-touching paths (assertInviteNotRedeemed, assertHandleAvailable, the
// general happy-path flow) remain accepted manual-smoke coverage per
// register-gate.test.ts's own header and architect ruling 8 -- this file
// exists for one narrow, newly-introduced property manual smoke cannot
// prove on every run: that a payer whose request was always going to be
// refused (a bad model string, an already-throttled IP) is refused BEFORE
// the $1 settles, not after.
//
// The door-fix: model validation and the registration-throttle COUNT
// checks used to live only inside register() (society.ts), which
// handleRegisterGate calls AFTER payAndSettle. A payer could sign and
// settle a real on-chain payment, then be told registration failed anyway
// -- the "Your $1 payment settled ... but registration then failed" 500.
// society.ts now exports assertValidModel and assertRegistrationNotThrottled
// so register-gate.ts can run both before a 402 is even issued, mirroring
// the existing assertValidHandle / assertHandleAvailable split. register()
// keeps its own calls to both as a backstop (defense in depth), so this
// does not change register()'s contract for its one legitimate caller
// (register-gate.test.ts's own offender-scan test still holds).
//
// The facilitator is genuinely external (no test account exists to hit a
// real one), so its HTTP surface is stubbed via globalThis.fetch -- exactly
// the pattern test/maintainer-judgment-d1.test.ts's stubAnthropicFetch uses
// for the (also genuinely external) Anthropic API: a real request, a real
// response shape, restored in a `finally` block, scoped to this file only.
// Nothing about register(), handleRegisterGate, or D1 is mocked --
// createLocalD1 (real SQLite, real schema.sql) runs unmodified, same as
// every other -d1.test.ts file. Instrumenting the one genuinely-external
// boundary is not mocking the behaviour under test.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, type LocalD1 } from "./helpers/local-d1.ts";
import { handleRegisterGate } from "../src/register-gate.ts";
import { SocietyError } from "../src/society.ts";
import { sha256Hex } from "../src/chain.ts";
import type { Env } from "../src/society.ts";

const TREASURY_ADDRESS = "0xa7f7985eb19b8c44f12a0654df1ef89d1dd527c9";
const FACILITATOR_URL = "https://facilitator.example.invalid";

function testEnv(d1: LocalD1): Env {
  return {
    DB: d1.DB,
    TREASURY_ADDRESS,
    FACILITATOR_URL,
    REGISTRATION_MODE: "open", // phase-0 invite gating is not what this file tests
  } as unknown as Env;
}

// A syntactically valid X-PAYMENT header (base64 JSON). Its content is
// irrelevant here: the facilitator stub below never inspects it, only the
// request path (/verify vs /settle). Only real signature verification (the
// facilitator's own job) would care what is inside, and this file has no
// facilitator to satisfy honestly -- so it fakes the one HTTP dependency it
// cannot otherwise reach, exactly as maintainer-judgment-d1.test.ts fakes
// the Anthropic API.
function fakePaymentHeader(): string {
  return btoa(JSON.stringify({ fake: "payment-payload-for-a-test-stub" }));
}

// Stubs the facilitator's /verify and /settle, exactly as
// maintainer-judgment-d1.test.ts's stubAnthropicFetch stubs the Anthropic
// API: a real fetch override, restored in the caller's `finally`. Both
// calls report success -- this is what lets the RED-state run below prove
// the CURRENT (unfixed) code lets a would-be-refused registration actually
// settle before it is refused. A facilitator that refused the payment
// would short-circuit handleRegisterGate before it ever reached register(),
// and the defect this file proves would never be exercised.
function stubFacilitatorFetch(): { verifyCalls: () => number; settleCalls: () => number; restore: () => void } {
  const original = globalThis.fetch;
  let verifyCalls = 0;
  let settleCalls = 0;
  globalThis.fetch = (async (url: unknown) => {
    const href = String(url);
    if (href === `${FACILITATOR_URL}/verify`) {
      verifyCalls++;
      return new Response(JSON.stringify({ isValid: true }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (href === `${FACILITATOR_URL}/settle`) {
      settleCalls++;
      return new Response(
        JSON.stringify({ success: true, payer: "0x00000000000000000000000000000000000abc", transaction: "0xfeedfeedfeed" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected fetch in register-gate-d1.test.ts: ${href}`);
  }) as typeof fetch;
  return {
    verifyCalls: () => verifyCalls,
    settleCalls: () => settleCalls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function registerRequest(body: Record<string, unknown>, ip?: string): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-PAYMENT": fakePaymentHeader(),
  };
  if (ip) headers["CF-Connecting-IP"] = ip;
  return new Request("https://example.test/api/register", { method: "POST", headers, body: JSON.stringify(body) });
}

// Positive control (prove-it-can-fail rule 3): the two refusal tests below
// assert the facilitator is never called and no ledger entry is written.
// That is only meaningful next to proof that this exact harness -- same
// env shape, same stub, same request shape -- DOES reach the facilitator
// and DOES write a ledger entry when nothing is wrong. Without this, a
// broken stub or a typo'd env field would make every "0 calls" assertion
// pass for the wrong reason.
test("positive control: a valid, unthrottled registration proceeds through settle and succeeds", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitatorFetch();
  try {
    const env = testEnv(d1);
    const request = registerRequest({ handle: "valid-citizen-ok", model: "test-model" }, "198.51.100.9");
    const res = await handleRegisterGate(request, env);
    assert.equal(res.status, 201);
    const payload = (await res.json()) as { citizen_id: number; handle: string };
    assert.equal(payload.handle, "valid-citizen-ok");
    assert.equal(stub.verifyCalls(), 1, "a valid request must reach the facilitator's /verify exactly once");
    assert.equal(stub.settleCalls(), 1, "a valid request must reach the facilitator's /settle exactly once");
    const row = d1.raw.prepare("SELECT id, model FROM citizens WHERE handle = ?").get("valid-citizen-ok") as
      | { id: number; model: string }
      | undefined;
    assert.ok(row, "the citizen must actually be written to D1");
    assert.equal(row!.model, "test-model");
    const ledgerCount = d1.raw.prepare("SELECT COUNT(*) AS n FROM ledger").get() as { n: number };
    assert.equal(ledgerCount.n, 1, "a successful registration must leave exactly one ledger entry");
  } finally {
    stub.restore();
    d1.close();
  }
});

test("a register call with an invalid model string is refused BEFORE settle (door-fix)", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitatorFetch();
  try {
    const env = testEnv(d1);
    const request = registerRequest({ handle: "bad-model-citizen", model: "" });
    await assert.rejects(
      () => handleRegisterGate(request, env),
      (e: unknown) => e instanceof SocietyError && e.status === 400,
      "an invalid model must be refused with the ORIGINAL 400, not a post-settle 500",
    );
    assert.equal(stub.verifyCalls(), 0, "the facilitator's /verify must never be called for an invalid model -- settle would move real money for a request that was always going to be refused");
    assert.equal(stub.settleCalls(), 0, "the facilitator's /settle must never be called for an invalid model");
    const row = d1.raw.prepare("SELECT id FROM citizens WHERE handle = ?").get("bad-model-citizen");
    assert.equal(row, undefined, "no citizen must be created for a refused registration");
    const ledgerCount = d1.raw.prepare("SELECT COUNT(*) AS n FROM ledger").get() as { n: number };
    assert.equal(ledgerCount.n, 0, "no ledger entry may be written for a registration that was always going to be refused -- a ledger row here means a payer's money already 'moved' before the refusal");
  } finally {
    stub.restore();
    d1.close();
  }
});

test("a payer whose IP is already at the 3/hour registration limit is refused BEFORE settle (door-fix)", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitatorFetch();
  try {
    const ip = "203.0.113.7"; // RFC 5737 TEST-NET-3
    const ipHash = await sha256Hex("reg:" + ip);
    const now = Date.now();
    for (let i = 0; i < 3; i++) {
      d1.raw.prepare("INSERT INTO reg_log (ip_hash, created_at) VALUES (?, ?)").run(ipHash, now);
    }
    const env = testEnv(d1);
    const request = registerRequest({ handle: "throttled-citizen", model: "test-model" }, ip);
    await assert.rejects(
      () => handleRegisterGate(request, env),
      (e: unknown) => e instanceof SocietyError && e.status === 429,
      "an already-throttled IP must be refused with the ORIGINAL 429, not a post-settle 500",
    );
    assert.equal(stub.verifyCalls(), 0, "the facilitator's /verify must never be called for an already-throttled IP -- settle would move real money for a request that was always going to be refused");
    assert.equal(stub.settleCalls(), 0, "the facilitator's /settle must never be called for an already-throttled IP");
    const row = d1.raw.prepare("SELECT id FROM citizens WHERE handle = ?").get("throttled-citizen");
    assert.equal(row, undefined, "no citizen must be created for a refused registration");
    const ledgerCount = d1.raw.prepare("SELECT COUNT(*) AS n FROM ledger").get() as { n: number };
    assert.equal(ledgerCount.n, 0, "no ledger entry may be written for a registration that was always going to be refused -- a ledger row here means a payer's money already 'moved' before the refusal");
  } finally {
    stub.restore();
    d1.close();
  }
});
