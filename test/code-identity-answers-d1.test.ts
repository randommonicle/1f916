// Served code identity in every settlement answer (docs/BRIEF-SERVED-CODE-IDENTITY.md A1, A2, A3, A7, A8; T4, T4a, T4b, T4c, T5).
//
// Part 1: every shape claimAnswer can build, served through claimResponse, carries `answered_by` equal to the env's identity and changes nothing else (status, code, accepts).
// Part 2: the real router over real local D1, with a stamped env: the 409 conflict, the booked replay, the handle-taken first answer and its replay, the listing-no-longer-awaiting answer (a
//         SocietyError the router serves), and the three answers payAndSettle builds directly (T4a), CORS kept.
// Part 3: a source scan that fails if a settlement answer is built outside the identity helpers or passes the wrong identity; its own positive controls.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { insertCitizen, insertListing, insertSubmission } from "./helpers/local-d1.ts";
import { declareTestWallet } from "./helpers/wallet-pin.ts";
import { atomicFromCents } from "./helpers/x402-payload.ts";
import { scanForBypasses } from "./helpers/answer-scan.ts";
import { sha256Hex } from "../src/chain.ts";
import {
  TEST_PAYER,
  TREASURY_ADDRESS,
  TX,
  callWorker,
  chainRpc,
  createLocalD1,
  failInserts,
  dropTrigger,
  json,
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
import * as claims from "../src/settlement-claims.ts";
import {
  REGISTRATION_HANDLE_TAKEN_AFTER_PAYMENT,
  SETTLEMENT_ALREADY_BOOKED,
  SETTLEMENT_ANSWER_CODES,
  SETTLEMENT_CLAIM_CONFLICT,
  SETTLEMENT_CLAIM_UNAVAILABLE,
  SETTLEMENT_CONTRADICTION,
  SETTLEMENT_UNRESOLVED,
  claimAnswer,
  claimIdentity,
  claimKeyFromPayload,
  claimResponse,
  contradictionAnswer,
  takeClaim,
  type ClaimAnswer,
  type ClaimRow,
  type ClaimSpec,
} from "../src/settlement-claims.ts";
import { CHAIN_SPENT_MARKER, CLAIM_HANDLE_TAKEN, CLAIM_LISTING_NOT_PAYING, CONTRADICTION_MARKER } from "../src/settlement-attention.ts";
import { ANSWERED_BY_NOTE, codeIdentity } from "../src/code-identity.ts";

const SHA = "69730d99c573b874f3acaecf34cf239fc90d252f";
const VERSION = { id: "a672490d-1b8b-4457-9e34-b23dfb5c6c4d", tag: "", timestamp: "2026-10-06T17:00:00.000Z" };
const IDENTITY_ENV = { CODE_COMMIT: SHA, CF_VERSION_METADATA: VERSION };
// Written out, not computed through the code under test: a bug in answeredBy shows as a difference from this.
const EXPECTED = { commit: SHA, commit_status: "stamped", version_id: VERSION.id, note: ANSWERED_BY_NOTE };
const NO_STAMP = { commit: null, commit_status: "not_stamped", version_id: null, note: ANSWERED_BY_NOTE };
const REQS = { payTo: "x" };
const IDENTITY = codeIdentity(IDENTITY_ENV);

// ---------- T4c: the sentence is the brief's ----------

test("T4c: ANSWERED_BY_NOTE is exactly the text the brief pins (A7, corrected by CODEX round 3): it is quoted verbatim in the brief and says the null is for absent OR malformed", () => {
  const brief = readFileSync(join(import.meta.dirname, "..", "docs", "BRIEF-SERVED-CODE-IDENTITY.md"), "utf8").replace(/\r\n/g, "\n");
  assert.ok(brief.includes(`"${ANSWERED_BY_NOTE}"`), "the brief quotes the constant byte for byte");
  assert.match(ANSWERED_BY_NOTE, /and null when no valid commit stamp is served, including when the stamp is absent or malformed \(commit_status says which\)\./);
  assert.match(ANSWERED_BY_NOTE, /This payment's claim may have been decided earlier by other code; the claim row does not record which\.$/);
  assert.doesNotMatch(ANSWERED_BY_NOTE, /null when the deploy did not stamp one/, "the sentence CODEX r3 found false for a malformed stamp");
});

// ---------- part 1: every claimAnswer shape ----------

const row = (route: ClaimRow["route"], state: ClaimRow["state"], intent: Record<string, unknown>, over: Partial<ClaimRow> = {}): ClaimRow => ({
  network: "base", asset: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", from_addr: TEST_PAYER, nonce: "0x" + "00".repeat(31) + "01", route,
  intent_json: JSON.stringify(intent), intent_hash: "x", rpc_body: "{}", rpc_body_hash: "y", valid_before: 9_999_999_999, state, tx: state === "pending" ? null : TX,
  payer: TEST_PAYER, verdict_reason: null, booked_refs: "{}", created_at: 1, updated_at: 1, lease_owner: null, leased_until: null, ...over,
});
const PATRON = { line: "hello" };
const REGISTER_SECRET = { handle: "h", model: "m", public_key: null };
const LISTING_PAY = { listing_id: 3, amount_cents: 1200 };

const SHAPES: [string, ClaimAnswer][] = [
  ["409 conflict (a different request)", claimAnswer(row("patron", "pending", PATRON), false, REQS)],
  ["booked", claimAnswer(row("patron", "booked", PATRON), true, REQS)],
  ["booked, secret-mode registration", claimAnswer(row("register", "booked", REGISTER_SECRET), true, REQS)],
  ["refused (pre-B history, with accepts)", claimAnswer(row("patron", "refused", PATRON, { verdict_reason: "refused by the facilitator" }), true, REQS)],
  ["refused, contradicted", claimAnswer(row("patron", "refused", PATRON, { verdict_reason: `${CONTRADICTION_MARKER}${TX}|x` }), true, REQS)],
  ["expired (with accepts)", claimAnswer(row("patron", "expired", PATRON), true, REQS)],
  ["expired, contradicted", claimAnswer(row("patron", "expired", PATRON, { verdict_reason: `${CONTRADICTION_MARKER}${TX}|x` }), true, REQS)],
  ["pending", claimAnswer(row("patron", "pending", PATRON), true, REQS)],
  ["pending, lease held", claimAnswer(row("patron", "pending", PATRON), true, REQS, { leaseHeld: true })],
  ["pending, success in hand (settledTx)", claimAnswer(row("patron", "pending", PATRON), true, REQS, { settledTx: TX })],
  ["pending, first-attempt refusal", claimAnswer(row("patron", "pending", PATRON), true, REQS, { detail: "the facilitator refused", firstRefusalRecheckAfter: "2027-01-15T08:05:00.000Z" })],
  ["pending, stopped (the chain reads it used)", claimAnswer(row("patron", "pending", PATRON, { verdict_reason: `${CHAIN_SPENT_MARKER}the chain reads it used` }), true, REQS)],
  ["settled_unbooked", claimAnswer(row("patron", "settled_unbooked", PATRON), true, REQS)],
  ["settled_unbooked, secret-mode registration", claimAnswer(row("register", "settled_unbooked", REGISTER_SECRET), true, REQS)],
  ["settled_unbooked, handle taken", claimAnswer(row("register", "settled_unbooked", REGISTER_SECRET, { verdict_reason: CLAIM_HANDLE_TAKEN }), true, REQS)],
  ["settled_unbooked, listing not paying", claimAnswer(row("listing_pay", "settled_unbooked", LISTING_PAY, { verdict_reason: CLAIM_LISTING_NOT_PAYING }), true, REQS)],
  ["the contradiction answer", contradictionAnswer(TX, "refused")],
];

test("T4/T5: every claim answer shape, served through claimResponse, carries answered_by equal to the env's identity, with status, code, accepts and every other field exactly as the answer built them", async () => {
  const codes = new Set<unknown>();
  for (const [label, answer] of SHAPES) {
    const res = claimResponse(answer, IDENTITY);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(res.status, answer.status, label);
    assert.equal(res.headers.get("access-control-allow-origin"), "*", `${label}: CORS kept`);
    assert.deepEqual(body.answered_by, EXPECTED, `${label}: answered_by is the env's identity and the pinned note`);
    const { answered_by: _ignored, ...rest } = body;
    assert.deepEqual(rest, JSON.parse(JSON.stringify(answer.body)), `${label}: nothing but answered_by was added`);
    assert.equal("accepts" in body, "accepts" in answer.body, `${label}: accepts is present exactly when the answer carries it`);
    codes.add(answer.body.code);
  }
  for (const c of [SETTLEMENT_CLAIM_CONFLICT, SETTLEMENT_ALREADY_BOOKED, SETTLEMENT_UNRESOLVED, SETTLEMENT_CONTRADICTION, REGISTRATION_HANDLE_TAKEN_AFTER_PAYMENT]) {
    assert.ok(codes.has(c), `the shape list reaches ${c}`);
  }
  assert.ok(SHAPES.some(([, a]) => a.status === 402 && Array.isArray(a.body.accepts)), "and a 402 with accepts");
  assert.ok(SHAPES.some(([, a]) => a.body.facilitator_refused === true), "and the first-attempt refusal's discriminator");
});

test("T4: with no stamp and no binding every answer says not_stamped and a null version, never a default", async () => {
  for (const [label, answer] of SHAPES) {
    const body = (await claimResponse(answer, codeIdentity({})).json()) as Record<string, unknown>;
    assert.deepEqual(body.answered_by, NO_STAMP, label);
  }
});

test("T4b (A3, CODEX): spread order: a body that itself carries an answered_by key is served with the identity's value, never the body's", async () => {
  const hostile: ClaimAnswer = { status: 409, body: { error: "x", code: SETTLEMENT_CLAIM_CONFLICT, answered_by: { commit: "f".repeat(40), commit_status: "stamped", version_id: "forged", note: "forged" }, extra: 1 } };
  const body = (await claimResponse(hostile, IDENTITY).json()) as Record<string, unknown>;
  assert.deepEqual(body.answered_by, EXPECTED);
  assert.equal(body.extra, 1, "the other fields are kept");
  assert.equal(body.code, SETTLEMENT_CLAIM_CONFLICT);
});

test("claimAnswer is still pure: it takes no env and its body carries no answered_by (the identity is added at response construction only)", () => {
  for (const [label, answer] of SHAPES) assert.ok(!("answered_by" in answer.body), label);
});

// ---------- part 2: the real router ----------

const stamped = (d1: LocalD1, extra: Record<string, unknown> = {}): Env => testEnv(d1, { ...IDENTITY_ENV, ...extra });
const UNWRAP = Symbol("unwrap");

// An Env whose INSERT into settlement_claims COMMITS and then throws (D1 committed and still reported an error); with readBackThrows the re-read throws too.
function claimInsertCommitsThenThrowsEnv(d1: LocalD1, opts: { readBackThrows?: boolean } = {}): Env {
  const real = d1.DB;
  let inserted = false;
  const wrap = (stmt: any, sql: string): any =>
    new Proxy(stmt, {
      get(target, prop) {
        if (prop === UNWRAP) return target;
        if (prop === "bind") return (...a: unknown[]) => wrap(target.bind(...a), sql);
        if (prop === "run" && /^\s*INSERT INTO settlement_claims/.test(sql)) {
          return async (...a: unknown[]) => {
            await target.run(...a);
            inserted = true;
            throw new Error("D1 reported an error after the commit (test)");
          };
        }
        if (prop === "first" && opts.readBackThrows && inserted && /FROM settlement_claims WHERE/.test(sql)) {
          return async () => {
            throw new Error("D1 read failed after the commit (test)");
          };
        }
        const v = target[prop];
        return typeof v === "function" ? v.bind(target) : v;
      },
    });
  const DB = { prepare: (sql: string) => wrap(real.prepare(sql), sql), batch: (stmts: any[]) => real.batch(stmts.map((x) => x[UNWRAP] ?? x)) };
  return { ...stamped(d1), DB } as unknown as Env;
}

const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const original = console.log;
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.log = original;
  }
};

test("T4 (route): the 409 conflict, the answer dash-agent named, carries the commit and version id of the deploy that answered", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator();
  try {
    const header = paymentHeaderFor(TREASURY_ADDRESS, "1000000");
    const payload = JSON.parse(atob(header));
    const reqs = { network: "base", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" };
    const { key, validBefore } = claimKeyFromPayload(payload, reqs);
    const spec: ClaimSpec = { route: "register", intent: { handle: "someone-else", model: "m", public_key: null } };
    const id = await claimIdentity(key, validBefore, { paymentPayload: payload, other: true }, spec);
    assert.deepEqual(await takeClaim(testEnv(d1), id, spec, "seed", Date.now()), { taken: true });
    const res = await callWorker(patronReq("rent", header), stamped(d1));
    const body = await json(res);
    assert.equal(res.status, 409, JSON.stringify(body));
    assert.equal(body.code, SETTLEMENT_CLAIM_CONFLICT);
    assert.deepEqual(body.answered_by, EXPECTED);
    assert.deepEqual(stub.calls, { verify: 0, settle: 0 });
  } finally {
    stub.restore();
    d1.close();
  }
});

test("T4 (route): a paid request answers 200 as before (no answered_by on a success), and its identical replay is the booked 409 carrying answered_by", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator();
  try {
    const header = paymentHeaderFor(TREASURY_ADDRESS, "1000000");
    const first = await callWorker(patronReq("rent", header), stamped(d1));
    const firstBody = await json(first);
    assert.equal(first.status, 200, JSON.stringify(firstBody));
    assert.ok(!("answered_by" in firstBody), "a success is not a claim answer and is unchanged");
    const replay = await callWorker(patronReq("rent", header), stamped(d1));
    const body = await json(replay);
    assert.equal(replay.status, 409);
    assert.equal(body.code, SETTLEMENT_ALREADY_BOOKED);
    assert.deepEqual(body.answered_by, EXPECTED);
  } finally {
    stub.restore();
    d1.close();
  }
});

test("T4 (route, router): the handle-taken answer is served by the router as a SocietyError, and carries answered_by exactly as its replay does: the first answer and the replay are the same answer", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator({
    settle: () => {
      insertCitizen(d1, { handle: "lost-handle" });
      return new Response(JSON.stringify({ success: true, payer: TEST_PAYER, transaction: TX }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  try {
    const header = registerHeader();
    const body = { handle: "lost-handle", model: "m", public_key: await realPublicKey() };
    const first = await quiet(() => callWorker(registerReq(body, header), stamped(d1)));
    const firstBody = await json(first);
    assert.equal(first.status, 409, JSON.stringify(firstBody));
    assert.equal(firstBody.code, REGISTRATION_HANDLE_TAKEN_AFTER_PAYMENT);
    assert.deepEqual(firstBody.answered_by, EXPECTED, "the router adds it to the thrown answer");
    const again = await quiet(() => callWorker(registerReq(body, header), stamped(d1)));
    assert.deepEqual(await json(again), firstBody);
  } finally {
    stub.restore();
    d1.close();
  }
});

test("T4 (route, router): the listing-no-longer-awaiting answer (a settlement_unresolved SocietyError) carries answered_by; a SocietyError with another code does not", async () => {
  const d1 = createLocalD1();
  const FUNDER_SECRET = "commonhold_sk_" + "ab".repeat(32);
  const funderId = insertCitizen(d1, { secret_hash: await sha256Hex(FUNDER_SECRET) });
  const reviewerId = insertCitizen(d1);
  const wallet = "0x" + "0a".repeat(20);
  const pin = await declareTestWallet(d1, reviewerId, wallet);
  const listingId = insertListing(d1, { funder_citizen_id: funderId, bounty_cents: 1200 });
  const submissionId = insertSubmission(d1, { listing_id: listingId, citizen_id: reviewerId });
  const stub = stubFacilitator({
    settle: () => {
      // the operator releases the reservation while /settle is in flight: the listing is no longer 'paying'
      d1.raw.prepare("UPDATE listings SET status = 'open', paying_since = NULL, paying_wallet_row_id = NULL, paying_wallet_row_hash = NULL WHERE id = ?").run(listingId);
      return new Response(JSON.stringify({ success: true, payer: TEST_PAYER, transaction: TX }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
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
    assert.equal(res.status, 500, JSON.stringify(body));
    assert.equal(body.code, SETTLEMENT_UNRESOLVED);
    assert.match(String(body.error), /no longer awaiting this payment/);
    assert.deepEqual(body.answered_by, EXPECTED);
    // the control: a SocietyError that is not a settlement answer is served exactly as before
    const other = await callWorker(new Request("https://example.test/api/listing/1/pay", { method: "POST", headers: { "Content-Type": "application/json" }, body: "[]" }), stamped(d1));
    const otherBody = await json(other);
    assert.ok(other.status >= 400 && other.status < 500, JSON.stringify(otherBody));
    assert.ok(!("answered_by" in otherBody), "an ordinary error carries no answered_by");
  } finally {
    stub.restore();
    d1.close();
  }
});

// CODEX build r1 F1: handlePayListing's own 502 (the /settle request was sent and its answer never read as a verdict) is built with a bare Response.json in listings.ts and carries its code in
// `error`, which scripts/pay-listing.mjs keys on. It is a settlement answer, so it carries answered_by too, LAST, and nothing else about it changes.
test("F1 (CODEX build r1): the pay-listing 502 settlement_unconfirmed carries answered_by LAST, and its status, error, fields, message and CORS header are exactly as before", async () => {
  const d1 = createLocalD1();
  const FUNDER_SECRET = "commonhold_sk_" + "cd".repeat(32);
  const funderId = insertCitizen(d1, { secret_hash: await sha256Hex(FUNDER_SECRET) });
  const reviewerId = insertCitizen(d1);
  const wallet = "0x" + "0a".repeat(20);
  const pin = await declareTestWallet(d1, reviewerId, wallet);
  const listingId = insertListing(d1, { funder_citizen_id: funderId, bounty_cents: 1200 });
  const submissionId = insertSubmission(d1, { listing_id: listingId, citizen_id: reviewerId });
  // a JSON 502 with no success field: not a verdict, so the reservation is kept and the route answers settlement_unconfirmed
  const stub = stubFacilitator({ settle: () => new Response(JSON.stringify({ error: "upstream unavailable" }), { status: 502, headers: { "content-type": "application/json" } }) });
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
    assert.equal(res.status, 502, JSON.stringify(body));
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.equal(body.error, "settlement_unconfirmed", "scripts/pay-listing.mjs keys on exactly this");
    assert.equal(body.listing_id, listingId);
    assert.equal(body.submission_id, submissionId);
    assert.equal(typeof body.paying_since, "number");
    assert.equal(body.wallet_row_id, pin.id);
    assert.equal(body.wallet_row_hash, pin.hash);
    assert.ok(String(body.message).startsWith("No settlement verdict was returned for the settle request ("), String(body.message));
    assert.deepEqual(body.answered_by, EXPECTED);
    assert.deepEqual(Object.keys(body), ["error", "listing_id", "submission_id", "paying_since", "wallet_row_id", "wallet_row_hash", "message", "answered_by"], "the identity is the LAST property; no other field was added or removed");
    assert.equal(body.accepts, undefined, "no fresh payment requirements: the money may have moved");
    assert.equal(d1.raw.prepare("SELECT status FROM listings WHERE id = ?").get(listingId)?.status, "paying", "and the reservation is kept, as before");
  } finally {
    stub.restore();
    d1.close();
  }
});

// T4a (A2, A8): the three answers payAndSettle builds directly. Each is driven through the patron route; each keeps its status, its code and its CORS header.
test("T4a: the claim INSERT commits then throws (a 502 settlement_unresolved built directly in x402.ts): answered_by, status, code and CORS", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator({ rpc: chainRpc(false) });
  try {
    const res = await quiet(() => callWorker(patronReq("rent", paymentHeaderFor(TREASURY_ADDRESS, "1000000")), claimInsertCommitsThenThrowsEnv(d1)));
    const body = await json(res);
    assert.equal(res.status, 502, JSON.stringify(body));
    assert.equal(body.code, SETTLEMENT_UNRESOLVED);
    assert.match(String(body.error), /recorded a claim for this payment authorisation/);
    assert.deepEqual(body.answered_by, EXPECTED);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.equal(body.accepts, undefined);
  } finally {
    stub.restore();
    d1.close();
  }
});

test("T4a: the claim INSERT commits, throws, and the re-read throws too (a 503 settlement_claim_unavailable built directly): answered_by, status, code and CORS", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator({ rpc: chainRpc(false) });
  try {
    const res = await quiet(() => callWorker(patronReq("rent", paymentHeaderFor(TREASURY_ADDRESS, "1000000")), claimInsertCommitsThenThrowsEnv(d1, { readBackThrows: true })));
    const body = await json(res);
    assert.equal(res.status, 503, JSON.stringify(body));
    assert.equal(body.code, SETTLEMENT_CLAIM_UNAVAILABLE);
    assert.match(String(body.error), /could not confirm whether a claim/);
    assert.deepEqual(body.answered_by, EXPECTED);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.equal(body.accepts, undefined);
  } finally {
    stub.restore();
    d1.close();
  }
});

test("T4a: the claim INSERT throws without committing, no row (a 503 settlement_claim_unavailable built directly): answered_by, status, code and CORS", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator({ rpc: chainRpc(false) });
  try {
    failInserts(d1, "no_claims_identity", "settlement_claims", null, "disk I/O error (test)");
    const res = await quiet(() => callWorker(patronReq("rent", paymentHeaderFor(TREASURY_ADDRESS, "1000000")), stamped(d1)));
    const body = await json(res);
    assert.equal(res.status, 503, JSON.stringify(body));
    assert.equal(body.code, SETTLEMENT_CLAIM_UNAVAILABLE);
    assert.match(String(body.error), /could not record a claim/);
    assert.deepEqual(body.answered_by, EXPECTED);
    assert.equal(res.headers.get("access-control-allow-origin"), "*");
    assert.equal(body.accepts, undefined);
    assert.equal(stub.calls.settle, 0);
    dropTrigger(d1, "no_claims_identity");
  } finally {
    stub.restore();
    d1.close();
  }
});

// ---------- part 3: the source scan ----------

const SRC = join(import.meta.dirname, "..", "src");
const resolveName = (name: string): string | undefined => {
  const v = (claims as Record<string, unknown>)[name];
  return typeof v === "string" ? v : undefined;
};

test("T4 scan: no settlement answer in src/ is built outside claimResponse / claimErrorResponse (or, for a thrown SocietyError, outside the router's list)", () => {
  const files = readdirSync(SRC, { recursive: true }).map(String).filter((f) => f.endsWith(".ts"));
  assert.ok(files.includes("x402.ts") && files.includes("settlement-claims.ts") && files.includes("index.ts") && files.includes("listings.ts"), "the scan reaches the files that matter");
  const violations = files.flatMap((f) => scanForBypasses(f.replace(/\\/g, "/"), readFileSync(join(SRC, f), "utf8"), SETTLEMENT_ANSWER_CODES, resolveName));
  assert.deepEqual(violations, [], violations.map((v) => `${v.rule} ${v.file}:${v.line} ${v.text}`).join("\n"));
});

test("T4 scan, positive controls: it fails on a bare Response.json carrying a settlement code, on a json(), on a claimAnswer served raw, on a SocietyError with a code the router does not list, and on a call that passes the wrong identity", () => {
  const list = SETTLEMENT_ANSWER_CODES;
  const scan = (file: string, src: string) => scanForBypasses(file, src, list, resolveName).map((v) => v.rule);
  assert.deepEqual(scan("x402.ts", 'return Response.json({ error: "x", code: SETTLEMENT_UNRESOLVED }, { status: 502 });'), ["R1"], "a bare Response.json");
  assert.deepEqual(scan("x402.ts", 'return Response.json({ error: "x", code: "settlement_claim_unavailable" }, { status: 503 });'), ["R1"], "the string form");
  assert.deepEqual(scan("index.ts", "return json({ error: e, code: SETTLEMENT_NEW_THING }, 500);"), ["R1"], "a NEW settlement code, in a json()");
  assert.deepEqual(scan("x402.ts", "return new Response(JSON.stringify(claimAnswer(row, true, reqs).body));"), ["R2"], "an answer served without claimResponse");
  assert.deepEqual(scan("listings.ts", 'throw new SocietyError(500, "x", SETTLEMENT_NEW_THING);'), ["R3"], "an unlisted code thrown as a SocietyError");
  assert.deepEqual(scan("listings.ts", 'throw new SocietyError(500, "x", "settlement_new_thing");'), ["R3"], "an unlisted string code");
  assert.deepEqual(scan("x402.ts", "return claimResponse(claimAnswer(row, true, reqs), codeIdentity({}));"), ["R4"], "the wrong identity argument");
  assert.deepEqual(scan("x402.ts", "return claimResponse(claimAnswer(row, true, reqs), IDENTITY);"), ["R4"], "a constant identity");
  assert.deepEqual(scan("x402.ts", "return claimErrorResponse({ error: 'x', code: SETTLEMENT_UNRESOLVED }, 502);"), ["R4"], "no identity argument at all");
  assert.deepEqual(scan("x402.ts", "return claimResponse(claimAnswer(row, true, reqs),\n  codeIdentity(env),\n);"), [], "the sanctioned form, across lines and with a trailing comma");
  // and it does not cry wolf: the sanctioned shapes, comments and unrelated codes pass
  assert.deepEqual(scan("x402.ts", 'return claimResponse({ status: 502, body: { error: "x", code: SETTLEMENT_UNRESOLVED } }, codeIdentity(env));'), []);
  assert.deepEqual(scan("x402.ts", 'return claimErrorResponse({ error: "(a database error)", code: SETTLEMENT_CLAIM_UNAVAILABLE }, 503, codeIdentity(env));'), []);
  assert.deepEqual(scan("x402.ts", '// return Response.json({ code: SETTLEMENT_UNRESOLVED });\nreturn 1;'), [], "a comment");
  assert.deepEqual(scan("x402.ts", 'return Response.json({ error: "x", code: PAYMENT_VALID_BEFORE_TOO_FAR }, { status: 402 });'), [], "a code that is not a settlement code");
  assert.deepEqual(scan("listings.ts", "throw new SocietyError(500, msg, SETTLEMENT_UNRESOLVED);"), [], "a listed code thrown as a SocietyError");
});

test("F1 scan (CODEX build r1): a settlement string served as `error:` is a bypass unless the body ends with the identity; the REAL unfixed listings.ts line goes red, the fixed one green", () => {
  const list = SETTLEMENT_ANSWER_CODES;
  const scan = (file: string, src: string) => scanForBypasses(file, src, list, resolveName);
  const rules = (file: string, src: string) => scan(file, src).map((v) => v.rule);
  const LAST = "answered_by: answeredBy(codeIdentity(env)),";
  // positive controls on synthetic text
  assert.deepEqual(rules("listings.ts", 'return Response.json({ error: "settlement_unconfirmed", listing_id: 1 }, { status: 502 });'), ["R1"], "the string form, as `error`");
  assert.deepEqual(rules("listings.ts", "return Response.json({ error: SETTLEMENT_UNRESOLVED, listing_id: 1 }, { status: 502 });"), ["R1"], "the constant form, as `error`");
  assert.deepEqual(rules("index.ts", 'return json({ error: "settlement_unconfirmed" }, 502);'), ["R1"], "through a json()");
  assert.deepEqual(rules("listings.ts", `return Response.json({ error: "settlement_unconfirmed", ${LAST} }, { status: 502 });`), [], "the identity last: accepted");
  assert.deepEqual(rules("listings.ts", `return Response.json({\n  error: "settlement_unconfirmed",\n  message: \`a (b) \${reason}\`,\n  ${LAST}\n}, { status: 502 });`), [], "across lines, with a template literal before it");
  assert.deepEqual(rules("listings.ts", `return Response.json({ ${LAST} error: "settlement_unconfirmed", message: "m" }, { status: 502 });`), ["R1"], "the identity NOT last: a later field could override it");
  assert.deepEqual(rules("listings.ts", 'return Response.json({ error: "settlement_unconfirmed", answered_by: answeredBy(codeIdentity({})) }, { status: 502 });'), ["R1"], "the wrong env");
  assert.deepEqual(rules("listings.ts", 'return Response.json({ error: "settlement_unconfirmed", answered_by: someOtherThing }, { status: 502 });'), ["R1"], "some other value under the same key");
  assert.deepEqual(rules("listings.ts", '// return Response.json({ error: "settlement_unconfirmed" });\nreturn 1;'), [], "a comment");
  assert.deepEqual(rules("listings.ts", 'return Response.json({ error: "an ordinary message", code: PAYMENT_VALID_BEFORE_TOO_FAR }, { status: 402 });'), [], "not a settlement code");
  // the real source: green as it is, red with the line removed, red with the identity moved off the end
  const real = readFileSync(join(SRC, "listings.ts"), "utf8").replace(/\r\n/g, "\n");
  assert.deepEqual(scan("listings.ts", real), [], "the fixed listings.ts is clean");
  const line = /^ {8}answered_by: answeredBy\(codeIdentity\(env\)\),\n/m;
  assert.equal([...real.matchAll(new RegExp(line.source, "gm"))].length, 1, "the identity line is there exactly once");
  const unfixed = real.replace(line, "");
  assert.notEqual(unfixed, real);
  const red = scan("listings.ts", unfixed);
  assert.deepEqual(red.map((v) => [v.rule, v.text]), [["R1", 'error: "settlement_unconfirmed"']], "the unfixed line is found, by name");
  const movedUp = real.replace(line, "").replace('        error: "settlement_unconfirmed",\n', `        error: "settlement_unconfirmed",\n        answered_by: answeredBy(codeIdentity(env)),\n`);
  assert.deepEqual(scan("listings.ts", movedUp).map((v) => v.rule), ["R1"], "and the identity placed before the other fields is refused");
});
