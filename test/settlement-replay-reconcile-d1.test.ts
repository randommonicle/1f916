// The settlement reconciler and the payer's re-send on an unresolved claim
// (docs/BRIEF-SETTLEMENT-REPLAY-GUARD.md B6, B6a, B6b, B7; tests 7, 8, 11 and 14): the chain
// decides, two RPCs must agree, the stored body is re-POSTed exactly as PayAI's documentation
// prescribes, a lease keeps it single-holder, and a failing row never stops the next.
//
// The facilitator and the Base RPCs are stubbed through globalThis.fetch; D1 is real SQLite with
// the real schema.sql; every request goes through the real Worker router, and the reconciler runs
// through its real entry points (runReconciler, and scheduled() for the budget proof).
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import { insertCitizen, insertProposal } from "./helpers/local-d1.ts";
import { installSubrequestCounter, makeModelRpcResponder } from "./helpers/subrequest-counter.ts";
import {
  FACILITATOR_URL,
  TEST_PAYER,
  TREASURY_ADDRESS,
  TX,
  authStateAnswer,
  callWorker,
  captureLog,
  count,
  createLocalD1,
  eventLines,
  json,
  oneClaim,
  patronReq,
  paymentHeaderFor,
  realPublicKey,
  registerReq,
  stubFacilitator,
  testEnv,
  type Env,
  type LocalD1,
} from "./helpers/settlement-harness.ts";
import { claimAnswer, claimKeyFromPayload, getClaim, acquireLease, CLAIM_LEASE_TTL_MS, type ClaimRow } from "../src/settlement-claims.ts";
import {
  runReconciler,
  RECONCILE_BATCH_ROWS,
  RECONCILE_ROW_WORST_CASE,
  RECONCILE_SELECT_COST,
  RECONCILE_SUBREQUEST_CEILING,
} from "../src/settlement-reconcile.ts";
import { RECONCILE_EXPIRY_MARGIN_SECONDS } from "../src/x402.ts";
import { MAINTAINER_MODELS } from "../src/maintainer/anthropic.ts";
import { CLERK_CRON } from "../src/maintainer/schedule.ts";

const REQS = { network: "base", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" };
const pendingAnswer = () => new Response(JSON.stringify({ success: false, errorReason: "settlement_pending" }), { status: 200, headers: { "content-type": "application/json" } });
const settledAnswer = () => new Response(JSON.stringify({ success: true, payer: TEST_PAYER, transaction: TX }), { status: 200, headers: { "content-type": "application/json" } });
const refusedAnswer = () => new Response(JSON.stringify({ success: false, errorReason: "insufficient_funds" }), { status: 200, headers: { "content-type": "application/json" } });
const bothRpcs = (used: boolean) => () => authStateAnswer(used);

// A registration whose /settle answers "pending": the claim is left `pending` and the caller is told not to sign again.
async function pendingRegistration(d1: LocalD1, over: { handle?: string; publicKey?: string | null; validBefore?: string } = {}) {
  const publicKey = over.publicKey === undefined ? await realPublicKey() : over.publicKey;
  const header = paymentHeaderFor(TREASURY_ADDRESS, "1000000", over.validBefore ? { validBefore: over.validBefore } : {});
  const body = { handle: over.handle ?? "pending-seat", model: "m", ...(publicKey ? { public_key: publicKey } : {}) };
  return { header, body, send: () => callWorker(registerReq(body, header), testEnv(d1)) };
}

const claimOf = async (d1: LocalD1, header: string) => (await getClaim(testEnv(d1), claimKeyFromPayload(JSON.parse(atob(header)), REQS).key)) as ClaimRow;

// ---------- 7. the reconciler ----------

test("7a. chain says USED -> the stored body is re-POSTed byte-for-byte -> settled_unbooked -> booked (public-key registration)", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator({ settle: (n) => (n === 1 ? pendingAnswer() : settledAnswer()), rpc: bothRpcs(true) });
  try {
    const seat = await pendingRegistration(d1);
    const first = await seat.send();
    assert.equal(first.status, 502);
    assert.match(String((await json(first)).error), /do not sign again/i);
    const pending = oneClaim(d1);
    assert.equal(pending.state, "pending");
    assert.ok(pending.rpc_body, "a pending row keeps the body it may need to re-POST");
    assert.equal(pending.lease_owner, null, "the unknown outcome let go of the lease");
    assert.equal(count(d1, "citizens"), 0);

    const out = await runReconciler(testEnv(d1));
    assert.equal(out.booked, 1);
    assert.equal(stub.rpcUrls.length, 2, "two RPCs were asked");
    assert.equal(new Set(stub.rpcUrls).size, 2, "and they are distinct");
    assert.equal(stub.calls.settle, 2);
    assert.equal(stub.settleBodies[1], stub.settleBodies[0], "the re-POST is the exact same payload (PayAI's documented reconciliation)");
    assert.equal(count(d1, "citizens WHERE handle = 'pending-seat'"), 1);
    assert.equal(count(d1, "ledger"), 1);
    assert.equal(count(d1, "identity_events WHERE kind = 'key_registered'"), 1);
    const done = oneClaim(d1);
    assert.equal(done.state, "booked");
    assert.equal(done.tx, TX);
    assert.equal(done.rpc_body, null, "B7");
    assert.equal(done.lease_owner, null);

    // and the payer's own identical re-send now meets a booked claim
    const again = await seat.send();
    assert.equal(again.status, 409);
    assert.equal(stub.calls.settle, 2);
  } finally {
    stub.restore();
    d1.close();
  }
});

test("7a'. a secret-mode registration: the reconciler settles it and books NOTHING; the payer's identical re-send finishes it and receives the secret (B5, B6b)", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator({ settle: (n) => (n === 1 ? pendingAnswer() : settledAnswer()), rpc: bothRpcs(true) });
  try {
    const seat = await pendingRegistration(d1, { publicKey: null, handle: "secret-seat" });
    assert.equal((await seat.send()).status, 502);
    const out = await runReconciler(testEnv(d1));
    assert.equal(out.booked, 0, "the reconciler cannot deliver a secret, so it books nothing");
    const waiting = oneClaim(d1);
    assert.equal(waiting.state, "settled_unbooked");
    assert.equal(waiting.tx, TX);
    assert.equal(count(d1, "citizens"), 0);
    assert.equal(count(d1, "ledger"), 0, "not even the treasury line: nothing is booked past settled_unbooked");

    // B6b: this message waits for the re-send and names no deadline; a public-key row's does name one.
    const text = String((claimAnswer(waiting, true, {}).body as { error: string }).error);
    assert.match(text, /identical re-send/);
    assert.doesNotMatch(text, /06:00/);
    const keyed = { ...waiting, intent_json: JSON.stringify({ handle: "x", model: "m", public_key: "AAAA" }) };
    assert.match(String((claimAnswer(keyed, true, {}).body as { error: string }).error), /06:00 UTC/);

    const resend = await seat.send();
    assert.equal(resend.status, 201, JSON.stringify(await resend.clone().json()));
    const booked = await json(resend);
    assert.match(String(booked.secret), /^commonhold_sk_[0-9a-f]{64}$/, "the re-send receives a fresh secret");
    assert.equal(count(d1, "citizens"), 1);
    assert.equal(count(d1, "ledger"), 1);
    assert.equal(oneClaim(d1).state, "booked");
    assert.equal(stub.calls.settle, 2, "the facilitator was asked once by the request and once by the reconciler");
  } finally {
    stub.restore();
    d1.close();
  }
});

test("7b. chain says UNUSED and validBefore (plus the margin) has passed -> expired; no settle, no citizen; the re-send is told to sign fresh", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator({ settle: () => pendingAnswer(), rpc: bothRpcs(false) });
  try {
    const seat = await pendingRegistration(d1, { validBefore: "1000" });
    assert.equal((await seat.send()).status, 502);
    const out = await runReconciler(testEnv(d1));
    assert.equal(out.resolved, 1);
    assert.equal(stub.calls.settle, 1, "an unused, expired authorisation is never re-POSTed");
    const row = oneClaim(d1);
    assert.equal(row.state, "expired");
    assert.equal(row.rpc_body, null, "B7: the authorisation can no longer move money and is not kept");
    assert.equal(count(d1, "citizens"), 0);
    assert.equal(count(d1, "ledger"), 0);

    const resend = await seat.send();
    assert.equal(resend.status, 402);
    const answer = await json(resend);
    assert.match(String(answer.error), /expired unused/);
    assert.match(String(answer.error), /Sign a fresh one/);
    assert.ok(Array.isArray(answer.accepts), "a 402 a client can act on");
    assert.equal(stub.calls.settle, 1);
  } finally {
    stub.restore();
    d1.close();
  }
});

test("7c. the two RPCs DISAGREE -> no transition, nothing re-POSTed; fewer than two answering is no transition either", async () => {
  const d1 = createLocalD1();
  let mode: "disagree" | "one" = "disagree";
  const stub = stubFacilitator({
    settle: () => pendingAnswer(),
    rpc: (_url, n) => (mode === "disagree" ? authStateAnswer(n === 0) : n % 4 === 0 ? authStateAnswer(true) : null),
  });
  try {
    const seat = await pendingRegistration(d1, { validBefore: "1000" });
    assert.equal((await seat.send()).status, 502);

    const a = await runReconciler(testEnv(d1));
    assert.equal(a.unchanged, 1);
    assert.equal(stub.rpcUrls.length, 2, "a disagreement stops at two answers");
    assert.equal(oneClaim(d1).state, "pending", "a disagreement moves nothing, not even to expired");
    assert.equal(stub.calls.settle, 1);

    mode = "one";
    const before = stub.rpcUrls.length;
    const b = await runReconciler(testEnv(d1));
    assert.equal(b.unchanged, 1);
    assert.equal(stub.rpcUrls.length - before, 4, "every distinct RPC was tried, and only one answered");
    assert.equal(oneClaim(d1).state, "pending", "one answer is not a quorum");
    assert.equal(stub.calls.settle, 1);
  } finally {
    stub.restore();
    d1.close();
  }
});

test("7d. chain says UNUSED and validBefore is ahead -> the stored body is re-POSTed and classified as today: settled books it, a recorded refusal (rule 7) refuses it", async () => {
  for (const verdict of ["settled", "refused"] as const) {
    const d1 = createLocalD1();
    const stub = stubFacilitator({ settle: (n) => (n === 1 ? pendingAnswer() : verdict === "settled" ? settledAnswer() : refusedAnswer()), rpc: bothRpcs(false) });
    try {
      const seat = await pendingRegistration(d1, { handle: `seat-${verdict}` });
      assert.equal((await seat.send()).status, 502);
      const out = await runReconciler(testEnv(d1));
      assert.equal(stub.calls.settle, 2);
      const row = oneClaim(d1);
      if (verdict === "settled") {
        assert.equal(out.booked, 1);
        assert.equal(row.state, "booked");
        assert.equal(count(d1, "citizens"), 1);
      } else {
        assert.equal(out.resolved, 1);
        assert.equal(row.state, "refused");
        assert.equal(row.rpc_body, null, "B7");
        assert.equal(count(d1, "citizens"), 0);
        assert.equal(count(d1, "ledger"), 0);
        const resend = await seat.send();
        assert.equal(resend.status, 402, "the recorded refusal is served back, with requirements to sign again");
        assert.match(String((await json(resend)).error), /insufficient_funds/);
        assert.equal(stub.calls.settle, 2, "and is not asked again");
      }
    } finally {
      stub.restore();
      d1.close();
    }
  }
});

test("7e. chain says USED but the facilitator's answer is unknown, or a refusal: the claim stays pending (a spent authorisation is never refused)", async () => {
  for (const second of [() => new Response("{}", { status: 500 }), refusedAnswer]) {
    const d1 = createLocalD1();
    const stub = stubFacilitator({ settle: (n) => (n === 1 ? pendingAnswer() : second()), rpc: bothRpcs(true) });
    try {
      const seat = await pendingRegistration(d1);
      assert.equal((await seat.send()).status, 502);
      const out = await runReconciler(testEnv(d1));
      assert.equal(out.unchanged, 1);
      assert.equal(oneClaim(d1).state, "pending");
      assert.equal(count(d1, "citizens"), 0);
    } finally {
      stub.restore();
      d1.close();
    }
  }
});

test("7f. unused and past validBefore but inside the margin: the society waits, it does not call it expired (expired invites a second signature)", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator({ settle: () => pendingAnswer(), rpc: bothRpcs(false) });
  try {
    const justPast = String(Math.floor(Date.now() / 1000) - 10);
    assert.ok(10 < RECONCILE_EXPIRY_MARGIN_SECONDS);
    const seat = await pendingRegistration(d1, { validBefore: justPast });
    assert.equal((await seat.send()).status, 502);
    const out = await runReconciler(testEnv(d1));
    assert.equal(out.unchanged, 1);
    assert.equal(oneClaim(d1).state, "pending");
    assert.equal(stub.calls.settle, 1, "and nothing is re-POSTed for an authorisation that can no longer execute");
  } finally {
    stub.restore();
    d1.close();
  }
});

test("7g. the payer's identical re-send on a pending claim runs ONE attempt itself (B6): used -> settled -> booked in that request", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator({ settle: (n) => (n === 1 ? pendingAnswer() : settledAnswer()), rpc: bothRpcs(true) });
  try {
    const seat = await pendingRegistration(d1, { publicKey: null, handle: "resend-seat" });
    assert.equal((await seat.send()).status, 502);
    const resend = await seat.send();
    assert.equal(resend.status, 201, JSON.stringify(await resend.clone().json()));
    assert.match(String((await json(resend)).secret), /^commonhold_sk_/);
    assert.equal(count(d1, "citizens"), 1);
    assert.equal(count(d1, "ledger"), 1);
    assert.equal(stub.calls.settle, 2);
    assert.equal(oneClaim(d1).state, "booked");
  } finally {
    stub.restore();
    d1.close();
  }
});

// ---------- 8. the lease ----------

test("8. a live lease blocks a second worker; an expired lease does not; a re-send meets a live lease with 'in progress'", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator({ settle: (n) => (n === 1 ? pendingAnswer() : settledAnswer()), rpc: bothRpcs(true) });
  try {
    const seat = await pendingRegistration(d1);
    assert.equal((await seat.send()).status, 502);
    const row = await claimOf(d1, seat.header);
    const key = { network: row.network, asset: row.asset, from: row.from_addr, nonce: row.nonce };

    // A worker holds the lease: the reconciler does not see the row; the re-send is told so, and asks nobody.
    assert.ok(await acquireLease(testEnv(d1), key, "other-worker", Date.now()));
    const blocked = await runReconciler(testEnv(d1));
    assert.equal(blocked.examined, 0, "a row under a live lease is not selected");
    assert.equal(stub.rpcUrls.length, 0);
    const resend = await seat.send();
    assert.equal(resend.status, 502);
    assert.match(String((await json(resend)).error), /Another attempt .* in progress/);
    assert.equal(stub.rpcUrls.length, 0, "the re-send did not race the holder");
    assert.equal(stub.calls.settle, 1);

    // The holder crashed: its lease lapses and the next worker takes over.
    d1.raw.prepare("UPDATE settlement_claims SET leased_until = ?").run(Date.now() - 1);
    const took = await runReconciler(testEnv(d1));
    assert.equal(took.examined, 1);
    assert.equal(took.booked, 1);
    assert.equal(oneClaim(d1).state, "booked");
  } finally {
    stub.restore();
    d1.close();
  }
});

test("8b. two reconcilers racing for one row: exactly one takes the lease, the facilitator is re-POSTed once", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator({ settle: (n) => (n === 1 ? pendingAnswer() : settledAnswer()), rpc: bothRpcs(true), settleDelayMs: 30 });
  try {
    const seat = await pendingRegistration(d1);
    assert.equal((await seat.send()).status, 502);
    const [a, b] = await Promise.all([runReconciler(testEnv(d1)), runReconciler(testEnv(d1))]);
    assert.equal(a.booked + b.booked, 1, "one worker booked it");
    assert.equal(stub.calls.settle, 2, "the original settle plus exactly one re-POST");
    assert.equal(count(d1, "citizens"), 1);
    assert.equal(count(d1, "ledger"), 1);
    assert.equal(CLAIM_LEASE_TTL_MS > 100_000, true, "the lease outlasts PayAI's worst settle wait");
  } finally {
    stub.restore();
    d1.close();
  }
});

// ---------- 11. rpc_body reaches no response ----------

test("11. rpc_body is NULL on every terminal row and appears in NO route's response: every route that can touch a claim, walked", async () => {
  const d1 = createLocalD1();
  // One claim per state, through the real routes: A pending, B refused, C booked, D expired, E a pending patron line.
  const answers = [pendingAnswer, refusedAnswer, settledAnswer, pendingAnswer, pendingAnswer];
  let chainUsed = true;
  const stub = stubFacilitator({ settle: (n) => (answers[n - 1] ?? settledAnswer)(), rpc: () => authStateAnswer(chainUsed) });
  try {
    const marker = "0x" + "11".repeat(65); // the payload signature every test header carries: part of every stored rpc_body
    insertCitizen(d1, { handle: "commonhold-agent" });
    const seatA = await pendingRegistration(d1, { handle: "s-pending" });
    assert.equal((await seatA.send()).status, 502);
    const seatB = await pendingRegistration(d1, { handle: "s-refused" });
    assert.equal((await seatB.send()).status, 402);
    const seatC = await pendingRegistration(d1, { handle: "s-booked" });
    assert.equal((await seatC.send()).status, 201);
    const seatD = await pendingRegistration(d1, { handle: "s-expired", validBefore: "1000" });
    assert.equal((await seatD.send()).status, 502);
    const patronHeader = paymentHeaderFor(TREASURY_ADDRESS, "1000000");
    assert.equal((await callWorker(patronReq("walk", patronHeader), testEnv(d1))).status, 502);

    // D expires (chain: unused); A's lease is held so the reconciler leaves it, and E is the patron claim it also leaves.
    chainUsed = false;
    d1.raw.prepare("UPDATE settlement_claims SET leased_until = ? WHERE state = 'pending' AND nonce != ?").run(Date.now() + 60_000, claimKeyFromPayload(JSON.parse(atob(seatD.header)), REQS).key.nonce);
    const out = await runReconciler(testEnv(d1));
    assert.equal(out.resolved, 1);

    const states = (d1.raw.prepare("SELECT state, rpc_body, route FROM settlement_claims").all() as { state: string; rpc_body: string | null; route: string }[]).map((c) => ({ ...c }));
    assert.deepEqual(states.map((c) => c.state).sort(), ["booked", "expired", "pending", "pending", "refused"]);
    for (const c of states) {
      if (c.state === "pending") assert.ok(c.rpc_body?.includes(marker), "a pending claim holds its authorisation body");
      else assert.equal(c.rpc_body, null, `${c.state} holds no body`);
    }

    // Every response any route gives about these claims: each registration replayed in its state, the patron door replayed,
    // a register header replayed at the patron door, and every public GET in the route table.
    const { ROUTES } = await import("../src/discovery.ts");
    const responses: { where: string; text: string }[] = [];
    for (const seat of [seatA, seatB, seatC, seatD]) {
      const r = await seat.send();
      responses.push({ where: `POST /api/register replay (${String(seat.body.handle)})`, text: await r.text() });
    }
    const patronReplay = await callWorker(patronReq("walk", patronHeader), testEnv(d1));
    responses.push({ where: "POST /api/patron replay of a pending patron claim", text: await patronReplay.text() });
    const crossDoor = await callWorker(patronReq("walk", seatA.header), testEnv(d1));
    responses.push({ where: "POST /api/patron replaying a pending register header", text: await crossDoor.text() });
    const env = testEnv(d1);
    for (const r of ROUTES) {
      if (r.method !== "GET" || r.auth !== "none" || r.path.includes(":")) continue;
      const res = await callWorker(new Request(`https://example.test${r.path}`), env);
      responses.push({ where: `GET ${r.path}`, text: await res.text() });
    }
    assert.ok(responses.length > 25, `the walk covered many routes (${responses.length})`);
    for (const { where, text } of responses) {
      assert.equal(text.includes(marker), false, `${where} must not contain an authorisation body (its signature)`);
      assert.equal(text.includes("paymentPayload"), false, `${where} must not contain a stored /settle body`);
    }
    // The claims table is on no route: nothing answers for it.
    assert.equal((await callWorker(new Request("https://example.test/api/settlement_claims"), env)).status, 404);
  } finally {
    stub.restore();
    d1.close();
  }
});

// ---------- 14. a failing row never stops later rows; the fixed batch; fairness ----------

test("14. a failing row never stops the rows after it: one log line per failure, a fixed batch of RECONCILE_BATCH_ROWS, and the failing row goes to the back", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator({ settle: (n) => (n <= 3 ? pendingAnswer() : settledAnswer()), rpc: (_url, n) => authStateAnswer(n >= 0) });
  try {
    // Three claims, oldest attempt first: A (settled, but its booking can never succeed), B (pending; the chain says used, so it re-POSTs and books), C (pending, beyond this run's batch).
    const a = await pendingRegistration(d1, { handle: "row-a", validBefore: "1000" });
    const b = await pendingRegistration(d1, { handle: "row-b", validBefore: "1000" });
    const c = await pendingRegistration(d1, { handle: "row-c" });
    for (const seat of [a, b, c]) assert.equal((await seat.send()).status, 502);
    const byHeader = (h: string) => claimKeyFromPayload(JSON.parse(atob(h)), REQS).key.nonce;
    d1.raw.prepare("UPDATE settlement_claims SET updated_at = 1000 WHERE nonce = ?").run(byHeader(a.header));
    d1.raw.prepare("UPDATE settlement_claims SET updated_at = 2000 WHERE nonce = ?").run(byHeader(b.header));
    d1.raw.prepare("UPDATE settlement_claims SET updated_at = 3000 WHERE nonce = ?").run(byHeader(c.header));
    assert.equal(count(d1, "settlement_claims"), 3);
    // A is already settled_unbooked and its booking can never succeed (the citizen insert is refused).
    d1.raw.prepare("UPDATE settlement_claims SET state = 'settled_unbooked', tx = ?, payer = ? WHERE nonce = ?").run(TX, TEST_PAYER, byHeader(a.header));
    d1.raw.exec("CREATE TRIGGER no_row_a BEFORE INSERT ON citizens WHEN NEW.handle = 'row-a' BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END;");

    assert.equal(RECONCILE_BATCH_ROWS, 2);
    const { value: first, lines } = await captureLog(() => runReconciler(testEnv(d1)));
    assert.equal(first.examined, 2, "a fixed batch: two rows this run, not three");
    assert.equal(first.failed, 1, "row A failed");
    const failures = eventLines(lines, "settlement_reconcile_row_failed");
    assert.equal(failures.length, 1, "one log line per row failure");
    assert.equal(failures[0].route, "register");
    assert.equal(failures[0].claim_nonce, byHeader(a.header));
    assert.equal(JSON.stringify(failures[0]).includes("paymentPayload"), false, "the line never carries the body");
    const rows = d1.raw.prepare("SELECT nonce, state FROM settlement_claims").all() as { nonce: string; state: string }[];
    const state = (h: string) => rows.find((r) => r.nonce === byHeader(h))?.state;
    assert.notEqual(state(b.header), "pending", "row B, after the failing row, was still worked");
    assert.equal(state(c.header), "pending", "row C is beyond this run's batch and untouched");

    // Fairness: the failing row A was just attempted, so it is now behind C.
    const second = await runReconciler(testEnv(d1));
    const rows2 = d1.raw.prepare("SELECT nonce, state FROM settlement_claims").all() as { nonce: string; state: string }[];
    assert.notEqual(rows2.find((r) => r.nonce === byHeader(c.header))?.state, "pending", "C is reached on the next run, ahead of the row that keeps failing");
    assert.ok(second.examined >= 1);
  } finally {
    stub.restore();
    d1.close();
  }
});

// ---------- the budget: priced, and proven by counting the real subrequests ----------

// The facilitator, the Base RPCs and the model behind ONE responder, so every outbound call is counted.
function worstCaseResponder() {
  let rpcN = 0;
  const models = makeModelRpcResponder({ judgmentModel: MAINTAINER_MODELS.judgment, clerkModel: MAINTAINER_MODELS.clerk });
  return (url: string, init: { body?: unknown } | undefined): Response => {
    if (url === `${FACILITATOR_URL}/settle`) return settledAnswer();
    const body = typeof init?.body === "string" ? init.body : "";
    if (body.includes("e94a0102")) {
      // authorizationState: the first two RPCs are unreachable, the next two answer "used": the four-fetch worst case.
      if (rpcN++ < 2) throw new Error("rpc unreachable");
      return authStateAnswer(true);
    }
    return models(url, init);
  };
}

test("budget: the worst-case row (a pending public-key registration through every step) costs no more than its price, and scheduled() with it stays within 50", async () => {
  // ---- the row alone, counted
  {
    const d1 = createLocalD1();
    const stub = stubFacilitator({ settle: () => pendingAnswer(), rpc: bothRpcs(true) });
    let headerHolder: { send: () => Promise<Response> };
    try {
      headerHolder = await pendingRegistration(d1);
      assert.equal((await headerHolder.send()).status, 502);
    } finally {
      stub.restore();
    }
    let counting = false;
    const counter = installSubrequestCounter(worstCaseResponder());
    const counted = createLocalD1({ onExec: (k) => counting && counter.consume(k) });
    try {
      // copy the pending claim into the counted database (seeding is scaffolding: uncounted)
      const row = d1.raw.prepare("SELECT * FROM settlement_claims").get() as Record<string, unknown>;
      counted.raw
        .prepare(`INSERT INTO settlement_claims (${Object.keys(row).join(", ")}) VALUES (${Object.keys(row).map(() => "?").join(", ")})`)
        .run(...(Object.values(row) as never[]));
      counting = true;
      const env = { ...testEnv(counted) };
      const result = await runReconciler(env as Env);
      counting = false;
      assert.equal(counter.breached(), false);
      assert.equal(result.booked, 1, "the whole path ran: lease, four RPC fetches, /settle, and every booking step");
      assert.equal(counter.fetches(), 5, "four RPC fetches and one /settle: the worst case is exercised, not skipped");
      assert.ok(counter.total() <= RECONCILE_SELECT_COST + RECONCILE_ROW_WORST_CASE, `one row really cost ${counter.total()} subrequests, priced at ${RECONCILE_SELECT_COST + RECONCILE_ROW_WORST_CASE}`);
      assert.equal(counter.total(), 17, "the measured worst case (16 for the row, 1 for the select) that RECONCILE_ROW_WORST_CASE's itemisation adds one chain-head retry to");
      assert.ok(result.actualCost >= counter.total(), `the metered cost ${result.actualCost} covers the real ${counter.total()}`);
      assert.ok(result.actualCost <= RECONCILE_SUBREQUEST_CEILING);
    } finally {
      counter.restore();
      counted.close();
      d1.close();
    }
  }

  // ---- scheduled(), the clerk cron: the worst row AND two due proposals AND the wake, in one invocation
  {
    const d1 = createLocalD1();
    const stub = stubFacilitator({ settle: () => pendingAnswer(), rpc: bothRpcs(true) });
    let seat: { send: () => Promise<Response> };
    try {
      insertCitizen(d1, { handle: "commonhold-agent", model: "claude-fable-5" });
      for (let i = 0; i < 4; i++) insertCitizen(d1);
      seat = await pendingRegistration(d1);
      assert.equal((await seat.send()).status, 502);
    } finally {
      stub.restore();
    }
    let counting = false;
    const counter = installSubrequestCounter(worstCaseResponder());
    const counted = createLocalD1({ onExec: (k) => counting && counter.consume(k) });
    try {
      // a fresh database that carries the pending claim and the maintainer, two due proposals, and the cohort
      const claim = d1.raw.prepare("SELECT * FROM settlement_claims").get() as Record<string, unknown>;
      insertCitizen(counted, { handle: "commonhold-agent", model: "claude-fable-5" });
      for (let i = 0; i < 4; i++) insertCitizen(counted);
      counted.raw
        .prepare(`INSERT INTO settlement_claims (${Object.keys(claim).join(", ")}) VALUES (${Object.keys(claim).map(() => "?").join(", ")})`)
        .run(...(Object.values(claim) as never[]));
      const now = Date.now();
      insertProposal(counted, { kind: "resolution", status: "open", opened_at: now - 9 * 86_400_000, closes_at: now - 3_000 });
      insertProposal(counted, { kind: "resolution", status: "open", opened_at: now - 9 * 86_400_000, closes_at: now - 2_000 });
      const env = { ...testEnv(counted), ANTHROPIC_API_KEY: "test-key", REGISTRATION_MODE: "invite_only" } as unknown as Env;
      counting = true;
      await (worker.scheduled as unknown as (c: unknown, e: Env, x: unknown) => Promise<void>)({ cron: CLERK_CRON, scheduledTime: Date.now(), noRetry: () => {} }, env, { waitUntil: () => {}, passThroughOnException: () => {} });
      counting = false;
      assert.equal(counter.breached(), false, `scheduled() with the worst reconcile row, a 2-due sweep and the clerk wake stayed within 50 (total ${counter.total()}, d1 ${counter.d1()}, fetch ${counter.fetches()})`);
      assert.ok(counter.total() <= 50, `total ${counter.total()} <= 50`);
      const row = counted.raw.prepare("SELECT state FROM settlement_claims").get() as { state: string };
      assert.equal(row.state, "booked", "the reconciler really ran inside scheduled(), so the proof is not vacuous");
    } finally {
      counter.restore();
      counted.close();
      d1.close();
    }
  }
});

test("the reconciler runs on the 06:00 clerk cron only, never on the Sunday judgment cron", async () => {
  const { JUDGMENT_CRON } = await import("../src/maintainer/schedule.ts");
  const d1 = createLocalD1();
  const stub = stubFacilitator({ settle: () => pendingAnswer(), rpc: bothRpcs(true) });
  try {
    const seat = await pendingRegistration(d1);
    assert.equal((await seat.send()).status, 502);
    const env = { ...testEnv(d1) } as unknown as Env;
    const fire = (cron: string) => (worker.scheduled as unknown as (c: unknown, e: Env, x: unknown) => Promise<void>)({ cron, scheduledTime: Date.now(), noRetry: () => {} }, env, { waitUntil: () => {}, passThroughOnException: () => {} });
    await fire(JUDGMENT_CRON);
    assert.equal(stub.rpcUrls.length, 0, "the judgment wake did not reconcile");
    assert.equal(oneClaim(d1).state, "pending");
    await fire(CLERK_CRON);
    assert.ok(stub.rpcUrls.length >= 2, "the clerk run did");
  } finally {
    stub.restore();
    d1.close();
  }
});
