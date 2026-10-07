// The code-identity gate's LOWs (docs/CHECKPOINT-CODE-IDENTITY-LOWS.md; source: docs/REVIEW-CODE-IDENTITY-GATE-2026-10-06.md L1-L5).
//
// I1 (L1): `answered_by` on the UNCODED money answers that are SocietyErrors. SocietyError carries an optional, non-enumerable `moneyAnswer` marker; the router adds `answered_by` when it is set
//          (or the code is a settlement answer code); nothing else about the response changes.
//   Part 1: the marker itself (non-enumerable, never serialised, errorBody unchanged).
//   Part 2: every marked site that a request can reach, served through the real router over real local D1: `answered_by` LAST, no `code` added, the status and message as before.
//   Part 3: the two marked sites no request reaches through the router (pinned directly), and the free refusals that stay unmarked on purpose (served exactly as before).
//   Part 4: a source sweep, so a new money-answer throw cannot be added unmarked; with positive controls.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { insertCitizen, insertListing, insertSubmission } from "./helpers/local-d1.ts";
import { declareTestWallet } from "./helpers/wallet-pin.ts";
import { atomicFromCents } from "./helpers/x402-payload.ts";
import { blankComments, matchingClose } from "./helpers/answer-scan.ts";
import { sha256Hex } from "../src/chain.ts";
import { SocietyError, errorBody } from "../src/society.ts";
import { computeListingFeeCents } from "../src/listings.ts";
import { ANSWERED_BY_NOTE } from "../src/code-identity.ts";
import { answerFromClaim } from "../src/x402.ts";
import { claimIdentity, claimKeyFromPayload, takeClaim, type ClaimSpec } from "../src/settlement-claims.ts";
import {
  FACILITATOR_URL,
  TEST_PAYER,
  TREASURY_ADDRESS,
  TX,
  callWorker,
  createLocalD1,
  dropTrigger,
  failInserts,
  json,
  patronReq,
  paymentHeaderFor,
  realPublicKey,
  registerHeader,
  registerReq,
  testEnv,
  type Env,
  type LocalD1,
} from "./helpers/settlement-harness.ts";

const SHA = "1491fb9c" + "0".repeat(28) + "beef";
const VERSION = { id: "8421a724-a5d5-44a7-9062-1e68a1dbbab0", tag: "", timestamp: "2026-10-07T09:00:00.000Z" };
// Written out, not computed through the code under test: a bug in answeredBy shows as a difference from this.
const EXPECTED = { commit: SHA, commit_status: "stamped", version_id: VERSION.id, version_status: "available", note: ANSWERED_BY_NOTE };
const stamped = (d1: LocalD1): Env => testEnv(d1, { CODE_COMMIT: SHA, CF_VERSION_METADATA: VERSION });

const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const original = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = original;
  }
};

// What each scenario served, written to LOWS_RECORD (a path) when the variable is set: the decision-invariance check in the checkpoint runs this file against the base source and against
// this branch and diffs status, code and error. Recorded BEFORE any assertion, so a run against the base source (where the answered_by assertions fail) still records.
const RECORDED: Record<string, { status: number; code: unknown; error: unknown }> = {};
function record(label: string, status: number, body: Record<string, unknown>): void {
  RECORDED[label] = { status, code: body.code ?? null, error: body.error ?? null };
}
test.after(() => {
  if (process.env.LOWS_RECORD) writeFileSync(process.env.LOWS_RECORD, JSON.stringify(RECORDED, null, 1));
});

// The facilitator, with a /verify and a /settle that can each be made to fail in the ways stubFacilitator (which always verifies) cannot.
const ok = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const notJson = (): Response => new Response("<html>bad gateway</html>", { status: 200, headers: { "content-type": "text/html" } });
function facilitator(opts: { verify?: () => Response | Promise<Response>; settle?: () => Response | Promise<Response>; onVerify?: () => void } = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown) => {
    const href = String(url);
    if (href === `${FACILITATOR_URL}/verify`) {
      opts.onVerify?.();
      return opts.verify ? opts.verify() : ok({ isValid: true });
    }
    if (href === `${FACILITATOR_URL}/settle`) return opts.settle ? opts.settle() : ok({ success: true, payer: TEST_PAYER, transaction: TX });
    throw new Error(`unexpected fetch in a code-identity test: ${href}`);
  }) as typeof fetch;
  return { restore: () => void (globalThis.fetch = original) };
}

// The one assertion every marked site shares: the served body is the error's own `{ error }` (no `code` was added: a code is a decision field) plus `answered_by`, LAST, with the env's
// identity and the pinned note; the status is the site's own, unchanged. `messageMatch` pins the message to its pre-change text.
async function assertMoneyAnswer(label: string, res: Response, status: number, messageMatch: RegExp): Promise<Record<string, any>> {
  const body = await json(res);
  record(label, res.status, body);
  assert.equal(res.status, status, `${label}: status unchanged (${JSON.stringify(body)})`);
  assert.match(String(body.error), messageMatch, `${label}: message unchanged`);
  assert.equal("code" in body, false, `${label}: no code was added`);
  assert.deepEqual(Object.keys(body), ["error", "answered_by"], `${label}: exactly { error, answered_by }, the identity LAST`);
  assert.deepEqual(body.answered_by, EXPECTED, `${label}: the env's identity and the pinned note`);
  assert.deepEqual({ error: body.error }, errorBody(new SocietyError(res.status, body.error)), `${label}: what is left is exactly the body the error served before`);
  return body;
}

// ---------- part 1: the marker ----------

test("I1: the marker is set by the fourth constructor argument, defaults to false, and is invisible to every way of serialising the error", () => {
  const marked = new SocietyError(502, "m", undefined, true);
  const plain = new SocietyError(502, "m");
  const coded = new SocietyError(409, "m", "some_code");
  assert.equal(marked.moneyAnswer, true);
  assert.equal(plain.moneyAnswer, false);
  assert.equal(coded.moneyAnswer, false);
  assert.equal(new SocietyError(502, "m", undefined, false).moneyAnswer, false);
  assert.deepEqual(Object.getOwnPropertyDescriptor(marked, "moneyAnswer"), { value: true, writable: false, enumerable: false, configurable: false });
  assert.deepEqual(Object.keys(marked), Object.keys(plain), "own enumerable keys are the same as an unmarked error's");
  assert.equal("moneyAnswer" in JSON.parse(JSON.stringify(marked)), false, "JSON.stringify");
  assert.equal("moneyAnswer" in { ...marked }, false, "object spread");
  assert.deepEqual(errorBody(marked), errorBody(plain), "errorBody is byte-identical for a marked and an unmarked error");
  assert.deepEqual(errorBody(new SocietyError(409, "m", "some_code", true)), { error: "m", code: "some_code" }, "and a coded one keeps its code, no marker");
  assert.throws(() => {
    (marked as { moneyAnswer: boolean }).moneyAnswer = false;
  }, TypeError, "nothing can clear it later");
  assert.throws(() => Object.defineProperty(plain, "moneyAnswer", { value: true }), TypeError, "nor set it later");
});

// ---------- part 2: every marked site a request reaches, through the real router ----------

test("x402.ts:210 (/verify fails in transit): 502, answered_by last, no code", async () => {
  const d1 = createLocalD1();
  const stub = facilitator({ verify: () => { throw new TypeError("fetch failed"); } });
  try {
    const res = await quiet(() => callWorker(patronReq("rent", paymentHeaderFor(TREASURY_ADDRESS, "1000000")), stamped(d1)));
    await assertMoneyAnswer("x402:210 verify transit", res, 502, /^The payment facilitator could not be reached to verify this payment \(/);
  } finally {
    stub.restore();
    d1.close();
  }
});

test("x402.ts:234 (/verify answers something unreadable): 502, answered_by last, no code", async () => {
  const d1 = createLocalD1();
  const stub = facilitator({ verify: notJson });
  try {
    const res = await quiet(() => callWorker(patronReq("rent", paymentHeaderFor(TREASURY_ADDRESS, "1000000")), stamped(d1)));
    await assertMoneyAnswer("x402:234 verify unreadable", res, 502, /^The facilitator is unreachable \(200\)\. Your money was not taken\./);
  } finally {
    stub.restore();
    d1.close();
  }
});

test("x402.ts:578 (/verify classified failed, a 5xx): 502, answered_by last, no code", async () => {
  const d1 = createLocalD1();
  const stub = facilitator({ verify: () => ok({}, 503) });
  try {
    const res = await quiet(() => callWorker(patronReq("rent", paymentHeaderFor(TREASURY_ADDRESS, "1000000")), stamped(d1)));
    await assertMoneyAnswer("x402:578 verify failed", res, 502, /^The payment facilitator failed to verify this payment \(HTTP 503/);
  } finally {
    stub.restore();
    d1.close();
  }
});

test("x402.ts:208 (/settle fails in transit): 502, answered_by last, no code", async () => {
  const d1 = createLocalD1();
  const stub = facilitator({ settle: () => { throw new TypeError("fetch failed"); } });
  try {
    const res = await quiet(() => callWorker(patronReq("rent", paymentHeaderFor(TREASURY_ADDRESS, "1000000")), stamped(d1)));
    await assertMoneyAnswer("x402:208 settle transit", res, 502, /^The request to the facilitator's \/settle failed in transit \(/);
  } finally {
    stub.restore();
    d1.close();
  }
});

test("x402.ts:232 (/settle answers something unreadable): 502, answered_by last, no code", async () => {
  const d1 = createLocalD1();
  const stub = facilitator({ settle: notJson });
  try {
    const res = await quiet(() => callWorker(patronReq("rent", paymentHeaderFor(TREASURY_ADDRESS, "1000000")), stamped(d1)));
    await assertMoneyAnswer("x402:232 settle unreadable", res, 502, /^The facilitator's answer to \/settle could not be read \(HTTP 200\)\./);
  } finally {
    stub.restore();
    d1.close();
  }
});

test("x402.ts:494 (/settle answers, but not with a verdict): 502, answered_by last, no code", async () => {
  const d1 = createLocalD1();
  const stub = facilitator({ settle: () => ok({ error: "upstream unavailable" }, 502) });
  try {
    const res = await quiet(() => callWorker(patronReq("rent", paymentHeaderFor(TREASURY_ADDRESS, "1000000")), stamped(d1)));
    await assertMoneyAnswer("x402:494 unknown verdict", res, 502, /^The facilitator answered \/settle with HTTP 502 \(no errorReason\)\. A 5xx answer is not a settlement verdict\./);
  } finally {
    stub.restore();
    d1.close();
  }
});

test("x402.ts:812 (the money moved and the claim cannot say so): 500, answered_by last, no code", async () => {
  const d1 = createLocalD1();
  const stub = facilitator();
  try {
    d1.raw.exec("CREATE TRIGGER lows_no_settled BEFORE UPDATE ON settlement_claims WHEN NEW.state = 'settled_unbooked' BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END;");
    const res = await quiet(() => callWorker(patronReq("rent", paymentHeaderFor(TREASURY_ADDRESS, "1000000")), stamped(d1)));
    await assertMoneyAnswer("x402:812 claim unrecorded", res, 500, /^Your payment settled \(tx 0xabab[0-9a-f]*\), but the society could not record that it had\./);
  } finally {
    stub.restore();
    d1.close();
  }
});

test("x402.ts:1299 (settled, but the treasury line failed): 500, answered_by last, no code", async () => {
  const d1 = createLocalD1();
  const stub = facilitator();
  try {
    failInserts(d1, "lows_no_fee_line", "ledger", null, "disk I/O error");
    const res = await quiet(() => callWorker(patronReq("rent", paymentHeaderFor(TREASURY_ADDRESS, "1000000")), stamped(d1)));
    await assertMoneyAnswer("x402:1299 treasury line", res, 500, /^Your \$1\.00 payment settled \(tx 0xabab[0-9a-f]*\), but the society could not record it in its treasury ledger\./);
  } finally {
    stub.restore();
    d1.close();
  }
});

const listingBody = (bounty: number) => ({
  title: "Review my auth middleware",
  description: "Stuck on token refresh, please review for race conditions",
  acceptance_condition: "a reviewer identifies at least one real correctness issue or confirms none exist",
  bounty_cents: bounty,
  expires_at: Date.now() + 7 * 86_400_000,
});
const FUNDER_SECRET = "commonhold_sk_" + "ef".repeat(32);

test("listings.ts:548 (the posting fee settled and the listing failed to save): 500, answered_by last, no code", async () => {
  const d1 = createLocalD1();
  const stub = facilitator();
  try {
    insertCitizen(d1, { secret_hash: await sha256Hex(FUNDER_SECRET) });
    failInserts(d1, "lows_no_listing_row", "listings", null, "disk I/O error");
    const res = await quiet(() =>
      callWorker(
        new Request("https://example.test/api/listing", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${FUNDER_SECRET}`, "X-PAYMENT": paymentHeaderFor(TREASURY_ADDRESS, atomicFromCents(computeListingFeeCents(1000))) },
          body: JSON.stringify(listingBody(1000)),
        }),
        stamped(d1),
      ),
    );
    await assertMoneyAnswer("listings:548 listing save", res, 500, /^Your posting fee settled \(tx 0xabab[0-9a-f]*\) but the listing failed to save\./);
  } finally {
    stub.restore();
    d1.close();
  }
});

test("listings.ts:1091 (the bounty settled and booking failed): 500, answered_by last, no code", async () => {
  const d1 = createLocalD1();
  const stub = facilitator();
  try {
    const funderId = insertCitizen(d1, { secret_hash: await sha256Hex(FUNDER_SECRET) });
    const reviewerId = insertCitizen(d1);
    const wallet = "0x" + "0a".repeat(20);
    const pin = await declareTestWallet(d1, reviewerId, wallet);
    const listingId = insertListing(d1, { funder_citizen_id: funderId, bounty_cents: 1200 });
    const submissionId = insertSubmission(d1, { listing_id: listingId, citizen_id: reviewerId });
    failInserts(d1, "lows_no_payment_row", "listing_payments", null, "disk I/O error");
    const res = await quiet(() =>
      callWorker(
        new Request(`https://example.test/api/listing/${listingId}/pay`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${FUNDER_SECRET}`, "X-PAYMENT": paymentHeaderFor(wallet, atomicFromCents(1200)) },
          body: JSON.stringify({ submission_id: submissionId, wallet_row_id: pin.id, wallet_row_hash: pin.hash }),
        }),
        stamped(d1),
      ),
    );
    await assertMoneyAnswer("listings:1091 payment booking", res, 500, /^Your payment settled \(tx 0xabab[0-9a-f]*\) but recording it failed\./);
  } finally {
    stub.restore();
    d1.close();
  }
});

test("register-gate.ts:495, secret arm (settled, and the citizens INSERT failed, so no credential was delivered): 500, answered_by last, no code", async () => {
  {
    const d1 = createLocalD1();
    const stub = facilitator();
    try {
      failInserts(d1, "lows_no_citizen", "citizens", null, "disk I/O error");
      const res = await quiet(() => callWorker(registerReq({ handle: "lows-secret", model: "m" }, registerHeader()), stamped(d1)));
      await assertMoneyAnswer("register:495 secret arm", res, 500, /^Your \$1\.00 payment settled \(tx 0xabab[0-9a-f]*\) but registration did not complete\..*No credential was delivered to you, so no seat is usable by you\./s);
    } finally {
      stub.restore();
      d1.close();
    }
  }
});

test("register-gate.ts:495, public-key arm (settled, and the key_registered line failed after the citizen exists): 500, answered_by last, no code", async () => {
  {
    const d1 = createLocalD1();
    const stub = facilitator();
    try {
      failInserts(d1, "lows_no_key_line", "identity_events", "NEW.kind = 'key_registered'", "disk I/O error");
      const publicKey = await realPublicKey();
      const res = await quiet(() => callWorker(registerReq({ handle: "lows-key", model: "m", public_key: publicKey }, registerHeader()), stamped(d1)));
      await assertMoneyAnswer("register:495 public-key arm", res, 500, /^Your \$1\.00 payment settled \(tx 0xabab[0-9a-f]*\) but registration did not complete\..*A citizen may still have been created/s);
    } finally {
      stub.restore();
      d1.close();
    }
  }
});

// The two backstops in finishRegistration (assertValidHandle, assertValidModel) run AFTER the money moved and re-run checks the same values passed before any 402, so no request this route wrote can
// trip them; reached here the only way they can be, by a settled_unbooked claim whose stored intent no longer validates (its hash still names the request), finished by the payer's identical re-send.
for (const [label, edit, status, message] of [
  ["register-gate.ts:301 handle backstop", `UPDATE settlement_claims SET intent_json = replace(intent_json, '"handle":"lows-bs"', '"handle":"x"')`, 400, "handle must be 2-32 chars: letters, digits, _ or -"],
  ["register-gate.ts:302 model backstop", `UPDATE settlement_claims SET intent_json = replace(intent_json, '"model":"m"', '"model":""')`, 400, "model must be a non-empty string up to 64 chars (self-declared, e.g. 'claude-fable-5')"],
] as const) {
  test(`${label}: a post-payment validation refusal is a money answer: ${status}, answered_by last, no code, its own message`, async () => {
    const d1 = createLocalD1();
    const stub = facilitator();
    try {
      const header = registerHeader();
      const body = { handle: "lows-bs", model: "m", public_key: await realPublicKey() };
      failInserts(d1, "lows_no_fee_line", "ledger", null, "disk I/O error");
      const first = await quiet(() => callWorker(registerReq(body, header), stamped(d1)));
      assert.equal(first.status, 500, "the first request settled and left a settled_unbooked claim");
      dropTrigger(d1, "lows_no_fee_line");
      d1.raw.exec(edit);
      const res = await quiet(() => callWorker(registerReq(body, header), stamped(d1)));
      const served = await assertMoneyAnswer(label, res, status, new RegExp(`^${message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`));
      assert.equal(served.error, message);
    } finally {
      stub.restore();
      d1.close();
    }
  });
}

// ---------- I3 (gate L2): version_status in answered_by ----------

// GET /api/attest and a claim answer, served by the SAME env, say the same version_status; a missing binding is "unavailable" with a null id in BOTH, and an id is "available" in both.
for (const [label, binding, status, id] of [
  ["a binding with an id", VERSION, "available", VERSION.id],
  ["no binding at all", undefined, "unavailable", null],
  ["a binding with an empty id", { id: "", timestamp: "2026-10-07T09:00:00.000Z" }, "unavailable", null],
  ["a binding that is not an object", "not-a-binding", "unavailable", null],
] as const) {
  test(`I3: ${label}: GET /api/attest and a claim answer agree on version_status (${status}) and version_id`, async () => {
    const d1 = createLocalD1();
    const stub = facilitator();
    try {
      const env = testEnv(d1, { CODE_COMMIT: SHA, ...(binding === undefined ? {} : { CF_VERSION_METADATA: binding }) });
      const attest = await json(await callWorker(new Request("https://example.test/api/attest"), env));
      assert.equal(attest.code.version_status, status, "/api/attest");
      assert.equal(attest.code.version_id, id, "/api/attest");
      const header = paymentHeaderFor(TREASURY_ADDRESS, "1000000");
      const first = await callWorker(patronReq("rent", header), env);
      assert.equal(first.status, 200, "the payment books");
      const replay = await callWorker(patronReq("rent", header), env);
      assert.equal(replay.status, 409, "its identical replay is the booked answer");
      const body = await json(replay);
      assert.equal(body.answered_by.version_status, status, "the claim answer");
      assert.equal(body.answered_by.version_id, id, "the claim answer");
      assert.equal(body.answered_by.version_status, attest.code.version_status, "the two surfaces agree");
      assert.deepEqual(Object.keys(body.answered_by), ["commit", "commit_status", "version_id", "version_status", "note"], "version_status follows version_id; the note stays last");
      assert.equal(body.answered_by.note, ANSWERED_BY_NOTE);
    } finally {
      stub.restore();
      d1.close();
    }
  });
}

// ---------- part 3: the two sites no request reaches through the router, and the refusals that stay unmarked ----------

test("x402.ts:1025 (answerFromClaim: the claim cannot be read back): a marked 503 with no code and its own message", async () => {
  const d1 = createLocalD1();
  try {
    const key = { network: "base", asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", from: TEST_PAYER.toLowerCase(), nonce: "0x" + "00".repeat(31) + "09" };
    await assert.rejects(
      () => answerFromClaim(testEnv(d1), key, "owner"),
      (e: unknown) => {
        assert.ok(e instanceof SocietyError);
        assert.equal(e.status, 503);
        assert.equal(e.code, undefined);
        assert.equal(e.moneyAnswer, true);
        assert.equal(e.message, "The payment claim could not be read back. Do not sign again: this payment may already have moved.");
        assert.deepEqual(errorBody(e), { error: e.message }, "served body unchanged");
        return true;
      },
    );
  } finally {
    d1.close();
  }
});

test("settlement-claims.ts:233 (takeClaim: the claim cannot be read back after a conflict): a marked 503 with no code; payAndSettle catches it, so it is never served itself", async () => {
  const d1 = createLocalD1();
  try {
    const header = paymentHeaderFor(TREASURY_ADDRESS, "1000000");
    const reqs = { network: "base", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" };
    const { key, validBefore } = claimKeyFromPayload(JSON.parse(atob(header)), reqs);
    const spec: ClaimSpec = { route: "patron", intent: { line: "x" } };
    const id = await claimIdentity(key, validBefore, { rpc: true }, spec);
    // an INSERT that reports a conflict (no row changed) and a read that finds no row: the state the guard's comment calls impossible
    const stmt = (sql: string): any => ({
      bind: () => stmt(sql),
      run: async () => ({ meta: { changes: 0 } }),
      first: async () => null,
      all: async () => ({ results: [] }),
    });
    const env = { ...testEnv(d1), DB: { prepare: stmt, batch: async () => [] } } as unknown as Env;
    await assert.rejects(
      () => takeClaim(env, id, spec, "owner", Date.now()),
      (e: unknown) => {
        assert.ok(e instanceof SocietyError);
        assert.equal(e.status, 503);
        assert.equal(e.code, undefined);
        assert.equal(e.moneyAnswer, true);
        assert.equal(e.message, "The payment claim could not be read back after a conflict. Nothing was sent to the facilitator's /settle.");
        assert.deepEqual(errorBody(e), { error: e.message });
        return true;
      },
    );
  } finally {
    d1.close();
  }
});

// The free refusals the commission named, left unmarked ON PURPOSE (checkpoint, "excluded"): nothing is charged, no claim exists, and the first three of these are also thrown, by the same line,
// with no payment involved at all. Pinned so a marker added at the throw site (which would put answered_by on a stranger's free refusal) turns this red.
test("excluded free refusals: x402.ts:541, register-gate.ts:154 (as the afterVerify hook) and listings.ts:918 are served exactly as before ({ error } only), and so are the coded pre-settle 400s", async () => {
  // x402.ts:541: a header that is not base64 JSON
  {
    const d1 = createLocalD1();
    try {
      const res = await callWorker(patronReq("rent", "%%% not base64 %%%"), stamped(d1));
      const body = await json(res);
      record("excluded x402:541 undecodable header", res.status, body);
      assert.equal(res.status, 400);
      assert.deepEqual(Object.keys(body), ["error"]);
      assert.match(String(body.error), /^X-PAYMENT must be base64-encoded JSON/);
    } finally {
      d1.close();
    }
  }
  // register-gate.ts:154 as the afterVerify hook: the handle is taken between the free check and /verify
  {
    const d1 = createLocalD1();
    const stub = facilitator({ onVerify: () => void insertCitizen(d1, { handle: "lows-race" }) });
    try {
      const res = await quiet(() => callWorker(registerReq({ handle: "lows-race", model: "m" }, registerHeader()), stamped(d1)));
      const body = await json(res);
      record("excluded register:154 handle taken in afterVerify", res.status, body);
      assert.equal(res.status, 409);
      assert.deepEqual(Object.keys(body), ["error"]);
      assert.equal(body.error, "handle 'lows-race' is taken");
    } finally {
      stub.restore();
      d1.close();
    }
  }
  // listings.ts:918: the listing stops being payable between the free checks and /verify
  {
    const d1 = createLocalD1();
    const funderId = insertCitizen(d1, { secret_hash: await sha256Hex(FUNDER_SECRET) });
    const reviewerId = insertCitizen(d1);
    const wallet = "0x" + "0a".repeat(20);
    const pin = await declareTestWallet(d1, reviewerId, wallet);
    const listingId = insertListing(d1, { funder_citizen_id: funderId, bounty_cents: 1200 });
    const submissionId = insertSubmission(d1, { listing_id: listingId, citizen_id: reviewerId });
    const stub = facilitator({ onVerify: () => void d1.raw.prepare("UPDATE listings SET status = 'withdrawn' WHERE id = ?").run(listingId) });
    try {
      const res = await quiet(() =>
        callWorker(
          new Request(`https://example.test/api/listing/${listingId}/pay`, {
            method: "POST",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${FUNDER_SECRET}`, "X-PAYMENT": paymentHeaderFor(wallet, atomicFromCents(1200)) },
            body: JSON.stringify({ submission_id: submissionId, wallet_row_id: pin.id, wallet_row_hash: pin.hash }),
          }),
          stamped(d1),
        ),
      );
      const body = await json(res);
      record("excluded listings:918 reservation refused", res.status, body);
      assert.equal(res.status, 409);
      assert.deepEqual(Object.keys(body), ["error"]);
      assert.match(String(body.error), /^This listing can no longer be paid: .*Nothing was settled\.$/);
    } finally {
      stub.restore();
      d1.close();
    }
  }
  // the coded pre-settle 400s (x402.ts:310-317, settlement-claims.ts:104): { error, code } as before, no answered_by
  {
    const d1 = createLocalD1();
    try {
      const wrongPayee = await callWorker(patronReq("rent", paymentHeaderFor("0x" + "99".repeat(20), "1000000")), stamped(d1));
      const wrongBody = await json(wrongPayee);
      record("excluded x402:314 wrong payee", wrongPayee.status, wrongBody);
      assert.equal(wrongPayee.status, 400);
      assert.deepEqual(Object.keys(wrongBody), ["error", "code"]);
      const noNonce = await callWorker(patronReq("rent", paymentHeaderFor(TREASURY_ADDRESS, "1000000", { nonce: undefined })), stamped(d1));
      const noNonceBody = await json(noNonce);
      record("excluded settlement-claims:104 malformed authorisation", noNonce.status, noNonceBody);
      assert.equal(noNonce.status, 400);
      assert.deepEqual(Object.keys(noNonceBody), ["error", "code"]);
    } finally {
      d1.close();
    }
  }
});

test("control: an unmarked, uncoded SocietyError still serves exactly { error } (no answered_by)", async () => {
  const d1 = createLocalD1();
  try {
    const res = await callWorker(new Request("https://example.test/api/listing/1/pay", { method: "POST", headers: { "Content-Type": "application/json" }, body: "[]" }), stamped(d1));
    const body = await json(res);
    record("control unmarked uncoded", res.status, body);
    assert.ok(res.status >= 400 && res.status < 500, JSON.stringify(body));
    assert.deepEqual(Object.keys(body), ["error"]);
  } finally {
    d1.close();
  }
});

// ---------- part 4: the source sweep ----------

const SRC = join(import.meta.dirname, "..", "src");

interface ErrorCall {
  file: string;
  line: number;
  args: string[];
}
// Every `new SocietyError(` call: its top-level arguments as source text. Not a parser: comments are blanked, strings and templates and brackets are skipped when splitting.
function societyErrorCalls(file: string, source: string): ErrorCall[] {
  const masked = blankComments(source);
  const out: ErrorCall[] = [];
  for (const m of masked.matchAll(/new SocietyError\(/g)) {
    const open = m.index! + m[0].length - 1;
    const close = matchingClose(masked, open);
    if (close < 0) continue;
    const args: string[] = [];
    let start = open + 1;
    for (let i = open + 1; i < close; i++) {
      const c = masked[i];
      if (c === '"' || c === "'") {
        i++;
        while (i < close && masked[i] !== c) i += masked[i] === "\\" ? 2 : 1;
      } else if (c === "`") {
        i++;
        let depth = 0;
        while (i < close) {
          if (masked[i] === "\\") i += 2;
          else if (masked[i] === "$" && masked[i + 1] === "{") {
            depth++;
            i += 2;
          } else if (masked[i] === "}" && depth > 0) {
            depth--;
            i++;
          } else if (masked[i] === "`" && depth === 0) break;
          else i++;
        }
      } else if (c === "(" || c === "{" || c === "[") {
        const end = matchingClose(masked, i);
        if (end > i) i = end;
      } else if (c === ",") {
        args.push(masked.slice(start, i).trim());
        start = i + 1;
      }
    }
    const last = masked.slice(start, close).trim();
    if (last) args.push(last);
    out.push({ file, line: masked.slice(0, m.index).split("\n").length, args });
  }
  return out;
}
const isMarked = (c: ErrorCall): boolean => c.args.length >= 4 && c.args[3] === "true";
const isCoded = (c: ErrorCall): boolean => c.args.length >= 3 && c.args[2] !== "undefined";
// x402.ts / settlement-claims.ts (the payment machinery): an uncoded unmarked SocietyError here must be one of these, each with the reason it is free.
const EXCLUDED_UNCODED: Array<{ file: string; fragment: string }> = [
  { file: "x402.ts", fragment: "X-PAYMENT must be base64-encoded JSON" }, // x402.ts:541: nothing decoded, so no payment is identified and no claim can exist
];
// A message that says the money moved: such an error must be marked (or carry a code).
const SAYS_SETTLED = /settled \(tx|payment settled|fee settled|bounty settled/;

function sweep(files: Record<string, string>): string[] {
  const problems: string[] = [];
  for (const [file, source] of Object.entries(files)) {
    for (const c of societyErrorCalls(file, source)) {
      const where = `${file}:${c.line}`;
      const text = c.args.join(", ");
      if ((file === "x402.ts" || file === "settlement-claims.ts") && !isMarked(c) && !isCoded(c) && !EXCLUDED_UNCODED.some((x) => x.file === file && text.includes(x.fragment))) {
        problems.push(`${where}: an uncoded, unmarked SocietyError in the payment machinery`);
      }
      if (SAYS_SETTLED.test(text) && !isMarked(c) && !isCoded(c)) problems.push(`${where}: says the money settled but is neither marked nor coded`);
    }
  }
  return problems;
}
const realSources = (): Record<string, string> =>
  Object.fromEntries(readdirSync(SRC, { recursive: true }).map(String).filter((f) => f.endsWith(".ts")).map((f) => [f.replace(/\\/g, "/"), readFileSync(join(SRC, f), "utf8")]));

test("sweep: every SocietyError in the payment machinery is marked, coded or a named free refusal, and every one that says the money settled is marked or coded", () => {
  const files = realSources();
  assert.deepEqual(sweep(files), []);
});

test("sweep: the marked sites are exactly the ones this wave marked (a removed marker, or a new unmarked one, turns this red)", () => {
  const files = realSources();
  const marked = (f: string) => societyErrorCalls(f, files[f]).filter(isMarked).length;
  assert.deepEqual(
    { "x402.ts": marked("x402.ts"), "settlement-claims.ts": marked("settlement-claims.ts"), "listings.ts": marked("listings.ts"), "register-gate.ts": marked("register-gate.ts") },
    { "x402.ts": 9, "settlement-claims.ts": 1, "listings.ts": 2, "register-gate.ts": 2 },
    "x402.ts: 208, 210, 232, 234, 494, 578, 812, 1025, 1299; settlement-claims.ts: 233; listings.ts: 548, 1091; register-gate.ts: the 495 throw and the 301-302 re-mark",
  );
  for (const [f, src] of Object.entries(files)) {
    if (["x402.ts", "settlement-claims.ts", "listings.ts", "register-gate.ts"].includes(f)) continue;
    assert.deepEqual(societyErrorCalls(f, src).filter(isMarked), [], `${f}: no other file marks an error`);
  }
});

test("sweep, positive controls: it goes red on an unmarked uncoded error in x402.ts, on a settled-money message that is unmarked, and passes the marked, the coded and the named exclusion", () => {
  const unmarked = 'throw new SocietyError(502, `The facilitator is unreachable (${res.status}). Your money was not taken.`);';
  const marked = 'throw new SocietyError(502, `The facilitator is unreachable (${res.status}). Your money was not taken.`, undefined, true);';
  assert.equal(sweep({ "x402.ts": unmarked }).length, 1, "unmarked, uncoded, in the machinery");
  assert.deepEqual(sweep({ "x402.ts": marked }), [], "marked");
  assert.deepEqual(sweep({ "x402.ts": 'throw new SocietyError(400, "bad", PAYMENT_PAYLOAD_MISMATCH);' }), [], "coded");
  assert.deepEqual(sweep({ "x402.ts": 'throw new SocietyError(400, "X-PAYMENT must be base64-encoded JSON (x402 payment payload)");' }), [], "the named free refusal");
  assert.equal(sweep({ "x402.ts": 'throw new SocietyError(400, "Some other free refusal");' }).length, 1, "a different one is not excused by the exclusion");
  assert.equal(sweep({ "listings.ts": "throw new SocietyError(500, `Your payment settled (tx ${tx}) but recording it failed.`);" }).length, 1, "a settled-money message, unmarked, in another file");
  assert.deepEqual(sweep({ "listings.ts": "throw new SocietyError(500, `Your payment settled (tx ${tx}) but recording it failed.`, undefined, true);" }), [], "marked");
  assert.deepEqual(sweep({ "listings.ts": "// throw new SocietyError(500, `Your payment settled (tx ${tx})`);\nreturn 1;" }), [], "a comment");
  assert.deepEqual(sweep({ "listings.ts": 'throw new SocietyError(409, "This listing can no longer be paid. Nothing was settled.");' }), [], "a free refusal that says 'Nothing was settled' is not a money answer");
  // multi-line, with a ternary message and the marker on its own lines, as register-gate.ts writes it
  const multi = "throw new SocietyError(\n  500,\n  cond\n    ? `a ${b} settled (tx ${tx}) x`\n    : `c`,\n  undefined,\n  true,\n);";
  assert.deepEqual(sweep({ "register-gate.ts": multi }), [], "multi-line marked");
  assert.equal(sweep({ "register-gate.ts": multi.replace("  undefined,\n  true,\n", "") }).length, 1, "multi-line, marker removed");
  // the real source, with one marker removed, goes red
  const real = realSources();
  const needle = "throw new SocietyError(502, verdict.message, undefined, true);";
  assert.ok(real["x402.ts"].includes(needle));
  assert.equal(sweep({ ...real, "x402.ts": real["x402.ts"].replace(needle, "throw new SocietyError(502, verdict.message);") }).length, 1, "x402.ts:494 without its marker is found");
});
