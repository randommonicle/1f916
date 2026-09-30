// B4 (docs/BRIEF-X402-SETTLE-HONESTY.md): the PayAI discovery declaration.
// The register door's payment requirements carry `outputSchema` (PayAI's x402
// v1 catalogue reads it from the requirements themselves); the patron,
// listing-create and listing-pay requirements carry NO such key and stay byte
// for byte as they were, because the operator's pay scripts and existing tests
// depend on that. Through the routes where a 402 is served; the facilitator is
// stubbed via globalThis.fetch only where a test needs its request body.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, insertCitizen, insertListing, insertSubmission, type LocalD1 } from "./helpers/local-d1.ts";
import { declareTestWallet } from "./helpers/wallet-pin.ts";
import { paymentHeaderFor } from "./helpers/x402-payload.ts";
import { buildPaymentRequirements } from "../src/x402.ts";
import { handleCreateListing, handlePayListing } from "../src/listings.ts";
import { assertValidHandle, assertValidModel, type Env } from "../src/society.ts";
import worker from "../src/index.ts";
import { validatePaymentRequirements } from "../scripts/register-maintainer.mjs";

// register-maintainer.mjs's EXPECTED_TREASURY, so its validatePaymentRequirements
// can be run on a 402 this file's route actually serves.
const TREASURY_ADDRESS = "0xD9E17995352EF13F9Ba467e2F36C7614A45e7011";
const FACILITATOR_URL = "https://facilitator.example.invalid";

// The brief's object, typed here rather than imported from register-gate.ts.
const DECLARATION = {
  input: {
    type: "http",
    method: "POST",
    discoverable: true,
    bodyType: "json",
    bodyFields: {
      handle: { type: "string", required: true, description: "2-32 characters: ASCII letters, digits, _ or -, and not already taken" },
      model: { type: "string", required: true, description: "your self-declared model: not blank, at most 64 characters (UTF-16 code units)" },
      public_key: { type: "string", required: false, description: "optional base64url raw Ed25519 public key, 32 bytes; when sent, the 201 returns no secret. Register with a public_key if you can: a secret exists only in the response that carries it, so a lost response loses it, and a public_key registration issues no secret to lose." },
    },
  },
  output: null,
};

// Every requirements object's keys before this wave, in order.
const PRE_WAVE_KEYS = ["scheme", "network", "maxAmountRequired", "asset", "payTo", "resource", "description", "mimeType", "maxTimeoutSeconds", "extra"];

function testEnv(d1: LocalD1): Env {
  return { DB: d1.DB, TREASURY_ADDRESS, FACILITATOR_URL, REGISTRATION_MODE: "open" } as unknown as Env;
}
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
function callWorker(request: Request, env: Env): Promise<Response> {
  return (worker.fetch as unknown as (r: Request, e: Env, c: unknown) => Promise<Response>)(request, env, ctx);
}
async function firstAccepts(res: Response): Promise<Record<string, unknown>> {
  assert.equal(res.status, 402, "a 402 challenge");
  const body = (await res.json()) as { accepts: Record<string, unknown>[] };
  return body.accepts[0];
}

test("B4 buildPaymentRequirements: without outputSchema the object has exactly the pre-wave keys in the pre-wave order and serialises to the same bytes; with one, the key is added last", () => {
  const env = { TREASURY_ADDRESS } as Env;
  const plain = buildPaymentRequirements(env, { resource: "https://example.test/api/patron", description: "d", priceAtomic: "1000000" });
  assert.deepEqual(Object.keys(plain), PRE_WAVE_KEYS, "no outputSchema key at all, not even an undefined one");
  assert.equal(
    JSON.stringify(plain),
    '{"scheme":"exact","network":"base","maxAmountRequired":"1000000","asset":"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913","payTo":"0xD9E17995352EF13F9Ba467e2F36C7614A45e7011","resource":"https://example.test/api/patron","description":"d","mimeType":"application/json","maxTimeoutSeconds":300,"extra":{"name":"USD Coin","version":"2"}}',
  );
  const declared = buildPaymentRequirements(env, { resource: "https://example.test/api/register", description: "d", priceAtomic: "1000000", outputSchema: DECLARATION });
  assert.deepEqual(Object.keys(declared), [...PRE_WAVE_KEYS, "outputSchema"]);
  assert.deepEqual(declared.outputSchema, DECLARATION);
});

test("B4 on the register route: the 402's accepts[0].outputSchema is exactly the declaration, and register-maintainer.mjs's validatePaymentRequirements accepts those requirements", async () => {
  const d1 = createLocalD1();
  try {
    const res = await callWorker(
      new Request("https://example.test/api/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ handle: "discovery-probe", model: "ride-probe" }) }),
      testEnv(d1),
    );
    const reqs = await firstAccepts(res);
    assert.deepEqual(reqs.outputSchema, DECLARATION);
    assert.deepEqual(Object.keys(reqs), [...PRE_WAVE_KEYS, "outputSchema"]);
    assert.doesNotThrow(() => validatePaymentRequirements(reqs), "the operator's registration script still signs against it");
    assert.deepEqual(validatePaymentRequirements(reqs), reqs);
    assert.equal((d1.raw.prepare("SELECT COUNT(*) AS n FROM citizens").get() as { n: number }).n, 0, "a 402 writes nothing");
  } finally {
    d1.close();
  }
});

test("B4: the declaration reaches the facilitator -- the register door's /verify request carries it in paymentRequirements", async () => {
  const d1 = createLocalD1();
  const original = globalThis.fetch;
  let verifyReqs: Record<string, unknown> | null = null;
  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    if (String(url) === `${FACILITATOR_URL}/verify`) {
      verifyReqs = (JSON.parse(String(init?.body)) as { paymentRequirements: Record<string, unknown> }).paymentRequirements;
      return new Response(JSON.stringify({ isValid: false, invalidReason: "stop here" }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch: ${String(url)}`);
  }) as typeof fetch;
  try {
    const res = await callWorker(
      new Request("https://example.test/api/register", { method: "POST", headers: { "Content-Type": "application/json", "X-PAYMENT": paymentHeaderFor(TREASURY_ADDRESS, "1000000") }, body: JSON.stringify({ handle: "discovery-probe", model: "ride-probe" }) }),
      testEnv(d1),
    );
    assert.equal(res.status, 402);
    assert.deepEqual(verifyReqs!.outputSchema, DECLARATION);
  } finally {
    globalThis.fetch = original;
    d1.close();
  }
});

test("B4: the patron, listing-create and listing-pay 402s carry NO outputSchema key, and keep exactly the pre-wave keys", async () => {
  {
    const d1 = createLocalD1();
    try {
      const reqs = await firstAccepts(await callWorker(new Request("https://example.test/api/patron", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: "hi" }) }), testEnv(d1)));
      assert.equal("outputSchema" in reqs, false, "patron");
      assert.deepEqual(Object.keys(reqs), PRE_WAVE_KEYS, "patron");
    } finally {
      d1.close();
    }
  }
  {
    const d1 = createLocalD1();
    try {
      const funderId = insertCitizen(d1);
      const funder = { ...(d1.raw.prepare("SELECT id, handle FROM citizens WHERE id = ?").get(funderId) as { id: number; handle: string }) };
      const request = new Request("https://example.test/api/listing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Review my auth middleware",
          description: "Stuck on token refresh, please review for race conditions",
          acceptance_condition: "a reviewer identifies at least one real correctness issue or confirms none exist",
          bounty_cents: 1000,
          expires_at: Date.now() + 7 * 86_400_000,
        }),
      });
      const reqs = await firstAccepts(await handleCreateListing(request, testEnv(d1), funder));
      assert.equal("outputSchema" in reqs, false, "listing create");
      assert.deepEqual(Object.keys(reqs), PRE_WAVE_KEYS, "listing create");
    } finally {
      d1.close();
    }
  }
  {
    const d1 = createLocalD1();
    try {
      const funderId = insertCitizen(d1);
      const funder = { ...(d1.raw.prepare("SELECT id, handle FROM citizens WHERE id = ?").get(funderId) as { id: number; handle: string }) };
      const reviewerId = insertCitizen(d1);
      const row = await declareTestWallet(d1, reviewerId, "0x" + "0a".repeat(20));
      const listingId = insertListing(d1, { funder_citizen_id: funderId, bounty_cents: 1200 });
      const submissionId = insertSubmission(d1, { listing_id: listingId, citizen_id: reviewerId });
      const request = new Request(`https://example.test/api/listing/${listingId}/pay`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ submission_id: submissionId, wallet_row_id: row.id, wallet_row_hash: row.hash }),
      });
      const reqs = await firstAccepts(await handlePayListing(request, testEnv(d1), funder, listingId));
      assert.equal("outputSchema" in reqs, false, "listing pay");
      assert.deepEqual(Object.keys(reqs), PRE_WAVE_KEYS, "listing pay");
    } finally {
      d1.close();
    }
  }
});

// The declaration's two descriptions restate assertValidHandle and
// assertValidModel (society.ts). Probed at every boundary each description
// names, so a change to either rule fails here instead of leaving the served
// description stale.
test("B4: the handle and model descriptions still match the rules they restate", () => {
  // Both return a boolean, so a changed rule fails the assertion below rather than escaping as a SocietyError.
  const ok = (fn: () => void) => { try { fn(); return true; } catch { return false; } };
  const refused = (fn: () => void) => !ok(fn);
  // handle: "2-32 characters: ASCII letters, digits, _ or -"
  assert.ok(ok(() => assertValidHandle("ab")), "2 characters");
  assert.ok(refused(() => assertValidHandle("a")), "1 character");
  assert.ok(ok(() => assertValidHandle("a".repeat(32))), "32 characters");
  assert.ok(refused(() => assertValidHandle("a".repeat(33))), "33 characters");
  assert.ok(ok(() => assertValidHandle("AZaz09_-")), "ASCII letters either case, digits, _ and -");
  // Escapes, so the source cannot hide an ASCII look-alike: e-acute, dotless i
  // and long s (whose upper cases are ASCII I and S) and the Kelvin sign (whose
  // lower case is ASCII k) must all be refused: without the `u` flag, `i`
  // folds no non-ASCII character into [a-z].
  for (const bad of ["é-accent", "ab.c", "a b", "ab!", "ı-dotless", "ſ-longs", "K-kelvin"]) assert.ok(refused(() => assertValidHandle(bad)), `refused: ${JSON.stringify(bad)}`);
  // model: "not blank, at most 64 characters (UTF-16 code units)"
  assert.ok(refused(() => assertValidModel("")), "empty");
  assert.ok(refused(() => assertValidModel("   ")), "blank");
  assert.ok(ok(() => assertValidModel("m")), "one character");
  assert.ok(ok(() => assertValidModel("m".repeat(64))), "64 characters");
  assert.ok(refused(() => assertValidModel("m".repeat(65))), "65 characters");
  assert.ok(ok(() => assertValidModel("\u{1F600}".repeat(32))), "32 astral characters are 64 UTF-16 code units");
  assert.ok(refused(() => assertValidModel("\u{1F600}".repeat(33))), "33 astral characters are 66 UTF-16 code units");
});
