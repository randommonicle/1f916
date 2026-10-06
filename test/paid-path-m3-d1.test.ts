// Paid-path wave M3, the choice-free subset (C1, C2, C3, C5, C6, C8): the residuals of the M2 gates
// (drafts/BRIEF-PAID-PATH-M3-2026-10-02.md with its amendments; docs/REVIEW-SETTLEMENT-REPLAY-GUARD-GATE-2026-09-30.md and
// docs/REVIEW-SETTLEMENT-REPLAY-GUARD-REGATE-2026-10-01.md). Real local D1 and the real Worker router; the facilitator and the Base RPCs are
// stubbed through globalThis.fetch. Every guard here was red-proofed with its file run alone (docs/CHECKPOINT-PAID-PATH-M3.md carries each mutant
// and the test that went red).
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { insertCitizen, insertListing, insertSubmission } from "./helpers/local-d1.ts";
import { declareTestWallet } from "./helpers/wallet-pin.ts";
import { atomicFromCents } from "./helpers/x402-payload.ts";
import {
  TEST_PAYER,
  TREASURY_ADDRESS,
  TX,
  authStateAnswer,
  callWorker,
  captureLog,
  chainRpc,
  count,
  createLocalD1,
  dropTrigger,
  eventLines,
  failInserts,
  json,
  oneClaim,
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
import { seedPreBRefused } from "./helpers/pre-b-refused.ts";
import { sha256Hex } from "../src/chain.ts";
import {
  acquireLease,
  claimAnswer,
  claimIdentity,
  claimKeyFromPayload,
  getClaim,
  keyOfRow,
  markContradiction,
  markExpired,
  markListingNotPaying,
  runBookingStep,
  stepGatedOutByLease,
  takeClaim,
  KEY_WHERE,
  keyArgs,
  type ClaimKey,
  type ClaimRoute,
  type ClaimRow,
  type ClaimSpec,
} from "../src/settlement-claims.ts";
import { RECONCILE_ROW_WORST_CASE, RECONCILE_SELECT_COST, runReconciler } from "../src/settlement-reconcile.ts";
import { RECONCILE_EXPIRY_MARGIN_SECONDS, attemptPending } from "../src/x402.ts";
import { computeListingFeeCents, handleCreateListing, handlePayListing } from "../src/listings.ts";
import { SocietyError } from "../src/society.ts";

const REQS = { network: "base", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" };
const settledAnswer = () => new Response(JSON.stringify({ success: true, payer: TEST_PAYER, transaction: TX }), { status: 200, headers: { "content-type": "application/json" } });
const pendingAnswer = () => new Response(JSON.stringify({ success: false, errorReason: "settlement_pending" }), { status: 200, headers: { "content-type": "application/json" } });
const eq = (d1: LocalD1) => testEnv(d1);

// ---------- worker B, as a test acts for it ----------

const theClaim = (d1: LocalD1) => {
  const rows = d1.raw.prepare("SELECT * FROM settlement_claims").all();
  assert.equal(rows.length, 1, "exactly one claim row");
  return rows[0] as unknown as ClaimRow;
};
// A's lease lapses and worker B takes it: B holds a LIVE lease.
async function bTakesTheLease(d1: LocalD1): Promise<ClaimKey> {
  const row = theClaim(d1);
  d1.raw.prepare(`UPDATE settlement_claims SET leased_until = 1 WHERE ${KEY_WHERE}`).run(...(keyArgs(keyOfRow(row)) as never[]));
  const leased = await acquireLease(eq(d1), keyOfRow(row), "B", Date.now());
  assert.equal(leased?.lease_owner, "B", "B took the lapsed lease");
  return keyOfRow(row);
}
const B_REFUSAL = "The facilitator reports that this settlement failed";
// B (a second worker) makes the claim terminal-without-money.
async function bTerminates(d1: LocalD1, kind: "refused" | "expired") {
  const key = await bTakesTheLease(d1);
  const moved = kind === "refused" ? seedPreBRefused(d1, key, B_REFUSAL) : await markExpired(eq(d1), key, "B", Date.now());
  assert.equal(moved, true);
}

const claimDetail = (d1: LocalD1) => d1.raw.prepare("SELECT state, tx, verdict_reason, rpc_body FROM settlement_claims").get() as { state: string; tx: string | null; verdict_reason: string | null; rpc_body: string | null };

// ---------- C1: a contradicted claim answers every later replay with the contradiction, never a 402 with accepts ----------

const noFreshInvitation = (body: Record<string, any>) => {
  assert.equal(body.accepts, undefined, "no fresh payment requirements");
  assert.doesNotMatch(String(body.error), /nothing was charged|sign a fresh one|no money moved/i, "never says nothing was charged, never invites a fresh signature");
};

for (const kind of ["refused", "expired"] as const) {
  test(`C1 (${kind}, this request's own /settle): a contradiction, then an identical replay: the replay answers the same 500 with the tx and no accepts; the stamp keeps the original reason`, async () => {
    const d1 = createLocalD1();
    const stub = stubFacilitator({
      settle: async () => {
        await bTerminates(d1, kind);
        return settledAnswer();
      },
    });
    try {
      const header = paymentHeaderFor(TREASURY_ADDRESS, "1000000");
      const first = await callWorker(patronReq("rent", header), eq(d1));
      assert.equal(first.status, 500);
      assert.equal((await json(first)).code, "settlement_contradiction");

      const row = claimDetail(d1);
      assert.equal(row.state, kind, "the claim is still in the terminal state B made it");
      assert.equal(row.tx, TX, "the stamp names the facilitator's tx on the row");
      assert.ok(String(row.verdict_reason).startsWith(`settlement_contradiction:${TX}|`), "and the marker leads the verdict_reason");
      assert.match(String(row.verdict_reason), kind === "refused" ? new RegExp(B_REFUSAL) : /authorisation expired unused/, "with the original reason kept inside it");

      const replay = await callWorker(patronReq("rent", header), eq(d1));
      const body = await json(replay);
      assert.equal(replay.status, 500, JSON.stringify(body));
      assert.equal(body.code, "settlement_contradiction");
      assert.match(String(body.error), new RegExp(TX), "it names the tx");
      assert.match(String(body.error), /Do not sign again/);
      assert.match(String(body.error), /may have moved/);
      noFreshInvitation(body);
      assert.equal(stub.calls.settle, 1, "the replay never reached the facilitator");
      assert.equal(count(d1, "ledger"), 0, "and nothing was booked");
    } finally {
      stub.restore();
      d1.close();
    }
  });

  test(`C1 (${kind}, the re-send's re-POST): the same, through attemptPending: the third identical request is answered with the contradiction, not the terminal 402`, async () => {
    const d1 = createLocalD1();
    const stub = stubFacilitator({
      settle: async (n) => {
        if (n === 1) return pendingAnswer();
        await bTerminates(d1, kind);
        return settledAnswer();
      },
      rpc: () => authStateAnswer(false),
    });
    try {
      const header = paymentHeaderFor(TREASURY_ADDRESS, "1000000");
      assert.equal((await callWorker(patronReq("rent", header), eq(d1))).status, 502);
      const resend = await callWorker(patronReq("rent", header), eq(d1));
      assert.equal(resend.status, 500);
      assert.equal((await json(resend)).code, "settlement_contradiction");
      assert.equal(claimDetail(d1).state, kind);

      const replay = await callWorker(patronReq("rent", header), eq(d1));
      const body = await json(replay);
      assert.equal(replay.status, 500, JSON.stringify(body));
      assert.equal(body.code, "settlement_contradiction");
      assert.match(String(body.error), new RegExp(TX));
      noFreshInvitation(body);
      assert.equal(stub.calls.settle, 2, "no third settle");
    } finally {
      stub.restore();
      d1.close();
    }
  });

  test(`C1 (${kind}, the reconciler's re-POST): the claim the reconciler found contradicted answers the payer's next replay with the contradiction`, async () => {
    const d1 = createLocalD1();
    const stub = stubFacilitator({
      settle: async (n) => {
        if (n === 1) return pendingAnswer();
        await bTerminates(d1, kind);
        return settledAnswer();
      },
      rpc: () => authStateAnswer(false),
    });
    try {
      const header = paymentHeaderFor(TREASURY_ADDRESS, "1000000");
      assert.equal((await callWorker(patronReq("rent", header), eq(d1))).status, 502);
      const { value: out } = await captureLog(() => runReconciler(eq(d1)));
      assert.equal(out.contradicted, 1);
      const replay = await callWorker(patronReq("rent", header), eq(d1));
      const body = await json(replay);
      assert.equal(replay.status, 500, JSON.stringify(body));
      assert.equal(body.code, "settlement_contradiction");
      noFreshInvitation(body);
    } finally {
      stub.restore();
      d1.close();
    }
  });
}

test("C1 control: an UNSTAMPED pre-B refused claim still answers a replay with the 402 and accepts (a first-attempt refusal no longer reaches that state), and an unstamped expired one with the expiry 402", async () => {
  // refused: option B (docs/BRIEF-REFUSED-CHAIN-RECHECK.md) keeps a first-attempt refusal PENDING, so the route cannot build this row any more. A pre-B row is production-reachable only as
  // history (L-126); it is seeded the way the old markRefused wrote it, and the answer the unchanged claimAnswer arm serves for it is what this control pins.
  {
    const d1 = createLocalD1();
    const stub = stubFacilitator({ settle: () => new Response(JSON.stringify({ success: false, errorReason: "insufficient_funds" }), { status: 200, headers: { "content-type": "application/json" } }) });
    try {
      const header = paymentHeaderFor(TREASURY_ADDRESS, "1000000");
      const first = await callWorker(patronReq("rent", header), eq(d1));
      assert.equal(first.status, 502, "option B: a first-attempt refusal is an unresolved payment, not a 402");
      assert.equal(claimDetail(d1).state, "pending");
      assert.equal(seedPreBRefused(d1, keyOfRow(theClaim(d1)), "The facilitator reports that this settlement failed (HTTP 200, reason: insufficient_funds). By its account no money moved."), true);
      const replay = await callWorker(patronReq("rent", header), eq(d1));
      const body = await json(replay);
      assert.equal(replay.status, 402, JSON.stringify(body));
      assert.ok(Array.isArray(body.accepts), "accepts is served: no contradiction, so a fresh signature is the honest invitation");
      assert.equal(claimDetail(d1).tx, null);
      assert.ok(!String(claimDetail(d1).verdict_reason).startsWith("settlement_contradiction:"), "not stamped");
    } finally {
      stub.restore();
      d1.close();
    }
  }
  // expired, by the holder's own write
  {
    const d1 = createLocalD1();
    const stub = stubFacilitator({ settle: () => pendingAnswer() });
    try {
      const header = paymentHeaderFor(TREASURY_ADDRESS, "1000000");
      assert.equal((await callWorker(patronReq("rent", header), eq(d1))).status, 502);
      assert.equal(await markExpired(eq(d1), keyOfRow(theClaim(d1)), "X", Date.now()), true);
      const replay = await callWorker(patronReq("rent", header), eq(d1));
      const body = await json(replay);
      assert.equal(replay.status, 402, JSON.stringify(body));
      assert.match(String(body.error), /expired unused/);
      assert.ok(Array.isArray(body.accepts));
      assert.ok(!String(claimDetail(d1).verdict_reason).startsWith("settlement_contradiction:"), "not stamped");
    } finally {
      stub.restore();
      d1.close();
    }
  }
});

let nonceSeq = 0x9100;
const patronSpec: ClaimSpec = { route: "patron", intent: { line: "stamp" } };
async function claimInState(d1: LocalD1, state: "pending" | "settled_unbooked" | "booked" | "refused" | "expired"): Promise<ClaimKey> {
  const nonce = "0x" + (++nonceSeq).toString(16).padStart(64, "0");
  const payload = { payload: { authorization: { from: TEST_PAYER, to: "0x1", value: "1000000", validBefore: "9999999999", nonce } } };
  const { key, validBefore } = claimKeyFromPayload(payload, REQS);
  const id = await claimIdentity(key, validBefore, { paymentPayload: payload }, patronSpec);
  assert.deepEqual(await takeClaim(eq(d1), id, patronSpec, "A", Date.now()), { taken: true });
  // the CHECK on the table clears rpc_body on every terminal state; the fixture clears it for the rows it sets terminal
  d1.raw.prepare(`UPDATE settlement_claims SET state = ?, rpc_body = CASE WHEN ? IN ('pending', 'settled_unbooked') THEN rpc_body ELSE NULL END, verdict_reason = ? WHERE ${KEY_WHERE}`).run(state, state, state === "refused" ? "the facilitator said no" : null, ...(keyArgs(key) as never[]));
  return key;
}

test("C1: the stamp lands only on a refused or expired row: never on a pending, settled_unbooked or booked one, and the first contradiction's tx is kept", async () => {
  const d1 = createLocalD1();
  try {
    for (const state of ["pending", "settled_unbooked", "booked"] as const) {
      const key = await claimInState(d1, state);
      assert.equal(await markContradiction(eq(d1), key, TX, Date.now()), false, `${state}: not stamped`);
      const row = (await getClaim(eq(d1), key)) as ClaimRow;
      assert.equal(row.state, state);
      assert.equal(row.tx, null, `${state}: tx untouched`);
      assert.equal(row.verdict_reason, null, `${state}: verdict_reason untouched`);
    }
    for (const state of ["refused", "expired"] as const) {
      const key = await claimInState(d1, state);
      assert.equal(await markContradiction(eq(d1), key, TX, 5_000), true, `${state}: stamped`);
      let row = (await getClaim(eq(d1), key)) as ClaimRow;
      assert.equal(row.state, state, "still terminal");
      assert.equal(row.tx, TX);
      assert.equal(row.verdict_reason, state === "refused" ? `settlement_contradiction:${TX}|the facilitator said no` : `settlement_contradiction:${TX}|`);
      // a second contradiction (a different tx) does not overwrite the first
      assert.equal(await markContradiction(eq(d1), key, "0x" + "cd".repeat(32), 6_000), false, `${state}: already stamped`);
      row = (await getClaim(eq(d1), key)) as ClaimRow;
      assert.equal(row.tx, TX, "the first tx is kept");
      assert.equal(row.verdict_reason?.includes("cdcdcd"), false);
    }
  } finally {
    d1.close();
  }
});

// ---------- C2: a success verdict is never dropped silently when the claim is pending under another holder's live lease (re-gate P-D) ----------

function assertSuccessKept(body: Record<string, any>, lines: string[], d1: LocalD1, how: string) {
  assert.equal(body.code, "settlement_unresolved", how);
  assert.match(String(body.error), new RegExp(TX), `${how}: the answer names the tx the facilitator reported`);
  assert.match(String(body.error), /Do not sign again/, `${how}: and says not to sign again`);
  assert.doesNotMatch(String(body.error), /changed nothing/, `${how}: it no longer says this request changed nothing`);
  assert.doesNotMatch(String(body.error), /nothing was charged|sign a fresh one/i);
  const logged = eventLines(lines, "settlement_success_unrecorded");
  assert.equal(logged.length, 1, `${how}: exactly one settlement_success_unrecorded line`);
  assert.equal(logged[0].level, "error");
  assert.equal(logged[0].tx, TX, `${how}: the line carries the tx`);
  assert.equal(logged[0].payer, TEST_PAYER);
  assert.match(String(logged[0].resource), /\/api\/patron$/);
  assert.equal(logged[0].amount_atomic, "1000000");
  assert.equal(logged[0].state, "pending", "the row's state");
  assert.equal(logged[0].claim_from, TEST_PAYER);
  assert.match(String(logged[0].claim_nonce), /^0x[0-9a-f]{64}$/);
  const row = d1.raw.prepare("SELECT state, tx, lease_owner FROM settlement_claims").get() as { state: string; tx: string | null; lease_owner: string | null };
  assert.equal(row.state, "pending", `${how}: the claim is untouched`);
  assert.equal(row.tx, null, `${how}: the tx is NOT written to the pending row (markSettled is its only writer)`);
  assert.equal(row.lease_owner, "B", `${how}: the other holder keeps its lease`);
}

test("C2 (P-D, this request's own /settle): the facilitator says settled while B holds a live lease on the pending claim: ONE error line carrying the tx, and an answer that names it", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator({
    settle: async () => {
      await bTakesTheLease(d1);
      return settledAnswer();
    },
  });
  try {
    const { value: res, lines } = await captureLog(() => callWorker(patronReq("rent", paymentHeaderFor(TREASURY_ADDRESS, "1000000")), eq(d1)));
    assert.equal(res.status, 502);
    assertSuccessKept(await json(res), lines, d1, "own settle");
    assert.equal(count(d1, "ledger"), 0, "nothing was booked");
  } finally {
    stub.restore();
    d1.close();
  }
});

test("C2 (CODEX M3-build r1 MEDIUM): a success reported with an EMPTY tx while B holds the lease is still disclosed as a success, the tx named as not reported", async () => {
  // Mutant: restore the truthiness test `if (opts.settledTx)` -> the answer says the outcome is unknown and that this request changed nothing.
  const d1 = createLocalD1();
  const stub = stubFacilitator({
    settle: async () => {
      await bTakesTheLease(d1);
      return new Response(JSON.stringify({ success: true, payer: TEST_PAYER, transaction: "" }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  try {
    const { value: res } = await captureLog(() => callWorker(patronReq("rent", paymentHeaderFor(TREASURY_ADDRESS, "1000000")), eq(d1)));
    const body = await json(res);
    assert.equal(res.status, 502, JSON.stringify(body));
    assert.match(String(body.error), /reported this payment settled \(tx not reported\)/);
    assert.match(String(body.error), /Do not sign again/);
    assert.doesNotMatch(String(body.error), /changed nothing/);
    assert.equal(count(d1, "ledger"), 0, "nothing was booked");
  } finally {
    stub.restore();
    d1.close();
  }
});

test("C2 (the re-send's re-POST): the re-POST answers settled while B holds a live lease on the pending claim: the same line and the same honest answer", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator({
    settle: async (n) => {
      if (n === 1) return pendingAnswer();
      await bTakesTheLease(d1);
      return settledAnswer();
    },
    rpc: () => authStateAnswer(false),
  });
  try {
    const header = paymentHeaderFor(TREASURY_ADDRESS, "1000000");
    assert.equal((await callWorker(patronReq("rent", header), eq(d1))).status, 502);
    const { value: res, lines } = await captureLog(() => callWorker(patronReq("rent", header), eq(d1)));
    assert.equal(res.status, 502);
    assertSuccessKept(await json(res), lines, d1, "re-send");
  } finally {
    stub.restore();
    d1.close();
  }
});

test("C2 (the reconciler's re-POST): the same race inside the scheduled reconciler writes the line once and counts the row unchanged", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator({
    settle: async (n) => {
      if (n === 1) return pendingAnswer();
      await bTakesTheLease(d1);
      return settledAnswer();
    },
    rpc: () => authStateAnswer(false),
  });
  try {
    assert.equal((await callWorker(patronReq("rent", paymentHeaderFor(TREASURY_ADDRESS, "1000000")), eq(d1))).status, 502);
    const { value: out, lines } = await captureLog(() => runReconciler(eq(d1)));
    assert.equal(out.unchanged, 1);
    assert.equal(out.booked, 0);
    assert.equal(out.contradicted, 0);
    const logged = eventLines(lines, "settlement_success_unrecorded");
    assert.equal(logged.length, 1, "exactly one line");
    assert.equal(logged[0].tx, TX);
    assert.equal(logged[0].state, "pending");
    const row = d1.raw.prepare("SELECT state, tx FROM settlement_claims").get() as { state: string; tx: string | null };
    assert.equal(row.state, "pending");
    assert.equal(row.tx, null);
  } finally {
    stub.restore();
    d1.close();
  }
});

test("C2 control: an ordinary unknown outcome (no verdict in hand) says do not sign again, never that the request changed nothing (CODEX deploy-script r3), and writes no settlement_success_unrecorded line", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator({ settle: () => pendingAnswer() });
  try {
    const header = paymentHeaderFor(TREASURY_ADDRESS, "1000000");
    const { value: res, lines } = await captureLog(async () => {
      const first = await callWorker(patronReq("rent", header), eq(d1));
      const replay = await callWorker(patronReq("rent", header), eq(d1));
      return [first, replay] as const;
    });
    for (const r of res) {
      assert.equal(r.status, 502);
    }
    const replayError = String((await json(res[1])).error);
    // This replay answers from the claim without a /settle (no chain read here); the re-sending case is in paid-path-m3b-d1.test.ts.
    assert.equal(stub.calls.settle, 1);
    assert.match(replayError, /Do not sign again/);
    assert.doesNotMatch(replayError, /changed nothing/);
    assert.equal(eventLines(lines, "settlement_success_unrecorded").length, 0, "no success verdict, no success line");
  } finally {
    stub.restore();
    d1.close();
  }
});

// ---------- C3: a booking step gated out by another holder's lease is answered from the claim, never as a booking failure ----------
// The re-gate's probe P-A, per site: A's booking batch is gated out by B's LIVE lease (B took the lapsed lease just before A's batch), and B's lease lapses straight
// after that batch, so the TypeScript lease read-back A used to rely on says "nobody holds it". A must still answer from the claim ("the booking is not finished, do not
// sign again"), not as `payment_settled_unrecorded` / `registration_paid_but_failed` / `listing_paid_but_failed`, and the claim must still resume afterwards.

// An Env whose DB.batch runs B's take-over just BEFORE the nth batch and lapses B's lease just AFTER it.
function windowEnv(d1: LocalD1, n: number): Env {
  const real = d1.DB;
  let calls = 0;
  const DB = {
    prepare: (sql: string) => real.prepare(sql),
    batch: async (stmts: never[]) => {
      const k = ++calls;
      if (k === n) await bTakesTheLease(d1);
      const out = await real.batch(stmts);
      if (k === n) d1.raw.prepare("UPDATE settlement_claims SET leased_until = 1").run();
      return out;
    },
  };
  return { ...testEnv(d1), DB } as unknown as Env;
}

function assertAnsweredFromClaim(res: { status: number; body: Record<string, any> }, lines: string[], failureEvent: string, how: string) {
  assert.equal(res.status, 500, `${how}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.code, "settlement_unresolved", `${how}: the answer is the claim's, not a thrown booking failure`);
  assert.match(String(res.body.error), /Do not sign again/, how);
  assert.match(String(res.body.error), /booking is not finished/, `${how}: it says the booking is not finished`);
  assert.doesNotMatch(String(res.body.error), /put right by hand|could not record it in its treasury ledger|did not complete|failed to save|recording it failed/, `${how}: no 'a person must put it right' failure text`);
  assert.equal(eventLines(lines, failureEvent).length, 0, `${how}: no ${failureEvent} line`);
}

test("C3 ledger step (patron): A's batch is gated out by B's live lease and B's lease lapses before A's read: A answers from the claim, and a re-send finishes it", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator();
  try {
    const header = paymentHeaderFor(TREASURY_ADDRESS, "1000000");
    const { value: res, lines } = await captureLog(async () => {
      const r = await callWorker(patronReq("rent", header), windowEnv(d1, 1));
      return { status: r.status, body: await json(r) };
    });
    assertAnsweredFromClaim(res, lines, "payment_settled_unrecorded", "patron ledger");
    assert.equal(count(d1, "ledger"), 0, "A's gated-out batch wrote nothing");
    assert.equal(oneClaim(d1).state, "settled_unbooked");
    const again = await callWorker(patronReq("rent", header), eq(d1));
    assert.equal(again.status, 200, JSON.stringify(await again.clone().json()));
    assert.equal(count(d1, "ledger"), 1, "the re-send books the line once");
    assert.equal(oneClaim(d1).state, "booked");
    assert.equal(stub.calls.settle, 1);
  } finally {
    stub.restore();
    d1.close();
  }
});

for (const mode of ["secret", "public-key"] as const) {
  test(`C3 citizen step (registration, ${mode}): the same window; A answers from the claim, no registration_paid_but_failed, and a re-send finishes the registration`, async () => {
    const d1 = createLocalD1();
    const stub = stubFacilitator();
    try {
      const publicKey = mode === "public-key" ? await realPublicKey() : null;
      const header = registerHeader();
      const body = { handle: `c3-${mode}`, model: "m", ...(publicKey ? { public_key: publicKey } : {}) };
      const { value: res, lines } = await captureLog(async () => {
        const r = await callWorker(registerReq(body, header), windowEnv(d1, 2)); // batch 1 = the ledger line, batch 2 = the citizen
        return { status: r.status, body: await json(r) };
      });
      assertAnsweredFromClaim(res, lines, "registration_paid_but_failed", `registration ${mode} citizen`);
      assert.equal(count(d1, "ledger"), 1, "the ledger line A wrote before the window");
      assert.equal(count(d1, "citizens"), 0, "no citizen");
      assert.equal(oneClaim(d1).state, "settled_unbooked");
      const again = await callWorker(registerReq(body, header), eq(d1));
      assert.equal(again.status, 201, JSON.stringify(await again.clone().json()));
      assert.equal(count(d1, "citizens"), 1);
      assert.equal(count(d1, "ledger"), 1);
      assert.equal(oneClaim(d1).state, "booked");
    } finally {
      stub.restore();
      d1.close();
    }
  });
}

test("C3 key step (registration, public-key): the same window on the last step; A answers from the claim and the reconciler books the key line", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator();
  try {
    const { value: res, lines } = await captureLog(async () => {
      const r = await callWorker(registerReq({ handle: "c3-key", model: "m", public_key: await realPublicKey() }, registerHeader()), windowEnv(d1, 3)); // 1 ledger, 2 citizen, 3 key
      return { status: r.status, body: await json(r) };
    });
    assertAnsweredFromClaim(res, lines, "registration_paid_but_failed", "registration key");
    assert.equal(count(d1, "citizens"), 1, "the citizen A booked before the window");
    assert.equal(count(d1, "identity_events WHERE kind = 'key_registered'"), 0, "no key line");
    assert.equal(oneClaim(d1).state, "settled_unbooked");
    const out = await runReconciler(eq(d1));
    assert.equal(out.booked, 1, "a public-key registration is finished by the reconciler");
    assert.equal(count(d1, "identity_events WHERE kind = 'key_registered'"), 1);
    assert.equal(oneClaim(d1).state, "booked");
  } finally {
    stub.restore();
    d1.close();
  }
});

const loadCitizen = (d1: LocalD1, id: number) =>
  d1.raw.prepare("SELECT id, handle, model, karma, created_at, last_seen_at FROM citizens WHERE id = ?").get(id) as { id: number; handle: string; model: string; karma: number; created_at: number; last_seen_at: number };
const listingBody = (bounty: number) => ({
  title: "Review my auth middleware",
  description: "Stuck on token refresh, please review for race conditions",
  acceptance_condition: "a reviewer identifies at least one real correctness issue or confirms none exist",
  bounty_cents: bounty,
  expires_at: Date.now() + 7 * 86_400_000,
});

test("C3 listing step (listing creation): the same window; A answers from the claim, no listing_paid_but_failed, and the reconciler books the listing", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator();
  try {
    const funder = loadCitizen(d1, insertCitizen(d1));
    const header = paymentHeaderFor(TREASURY_ADDRESS, atomicFromCents(computeListingFeeCents(1000)));
    const { value: res, lines } = await captureLog(async () => {
      const r = await handleCreateListing(
        new Request("https://example.test/api/listing", { method: "POST", headers: { "Content-Type": "application/json", "X-PAYMENT": header }, body: JSON.stringify(listingBody(1000)) }),
        windowEnv(d1, 2), // 1 = the fee line, 2 = the listing
        funder,
      );
      return { status: r.status, body: (await r.json()) as Record<string, any> };
    });
    assertAnsweredFromClaim(res, lines, "listing_paid_but_failed", "listing creation");
    assert.equal(count(d1, "ledger"), 1, "the fee line A wrote before the window");
    assert.equal(count(d1, "listings"), 0, "no listing");
    const out = await runReconciler(eq(d1));
    assert.equal(out.booked, 1);
    assert.equal(count(d1, "listings"), 1);
    assert.equal(oneClaim(d1).state, "booked");
  } finally {
    stub.restore();
    d1.close();
  }
});

test("C3 control: PAY LISTING keeps the lease read-back: a step gated out because the listing is no longer 'paying' (no other holder) is still the booking-failure path", async () => {
  const d1 = createLocalD1();
  const funderId = insertCitizen(d1);
  const reviewerId = insertCitizen(d1);
  const wallet = "0x" + "0a".repeat(20);
  const pin = await declareTestWallet(d1, reviewerId, wallet);
  const listingId = insertListing(d1, { funder_citizen_id: funderId, bounty_cents: 1200 });
  const submissionId = insertSubmission(d1, { listing_id: listingId, citizen_id: reviewerId });
  const stub = stubFacilitator({
    settle: () => {
      // the operator releases the reservation while A's /settle is in flight: A's own lease is intact, the listing is no longer 'paying'
      d1.raw.prepare("UPDATE listings SET status = 'open', paying_since = NULL, paying_wallet_row_id = NULL, paying_wallet_row_hash = NULL WHERE id = ?").run(listingId);
      return settledAnswer();
    },
  });
  try {
    // The route handler throws the booking failure as a SocietyError (the router turns it into a 500); the answer-from-the-claim path would RETURN a response.
    const { value: outcome, lines } = await captureLog(async () => {
      try {
        const r = await handlePayListing(
          new Request(`https://example.test/api/listing/${listingId}/pay`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "X-PAYMENT": paymentHeaderFor(wallet, atomicFromCents(1200)) },
            body: JSON.stringify({ submission_id: submissionId, wallet_row_id: pin.id, wallet_row_hash: pin.hash }),
          }),
          eq(d1),
          loadCitizen(d1, funderId),
          listingId,
        );
        return { returned: r.status };
      } catch (e) {
        return { thrown: e };
      }
    });
    assert.ok("thrown" in outcome, `the pay route still throws its booking failure (got ${JSON.stringify(outcome)})`);
    assert.ok(outcome.thrown instanceof SocietyError && outcome.thrown.status === 500);
    // moved by gate LOW-2 (second build): the listing no longer holds the reservation, so the answer is the listing-no-longer-awaiting-this-payment one, not the reconciler backstop
    assert.match(String((outcome.thrown as SocietyError).message), /no longer awaiting this payment/);
    assert.doesNotMatch(String((outcome.thrown as SocietyError).message), /one pass a day/);
    assert.equal(eventLines(lines, "listing_pay_settled_but_unrecorded").length, 1, "and its one log line");
    assert.equal(count(d1, "listing_payments"), 0);
    assert.equal(oneClaim(d1).state, "settled_unbooked");
  } finally {
    stub.restore();
    d1.close();
  }
});

test("C3: stepGatedOutByLease is true only for a claim still settled_unbooked with that step's ref unrecorded", () => {
  const base = { state: "settled_unbooked", booked_refs: "{}" } as unknown as ClaimRow;
  assert.equal(stepGatedOutByLease(base, "ledger_id"), true);
  assert.equal(stepGatedOutByLease(null, "ledger_id"), false, "no row");
  assert.equal(stepGatedOutByLease({ ...base, booked_refs: '{"ledger_id":7}' }, "ledger_id"), false, "the step's ref is recorded: that is 'take theirs', not a gated-out step");
  assert.equal(stepGatedOutByLease({ ...base, booked_refs: '{"ledger_id":7}' }, "citizen_id"), true, "another step's ref does not matter");
  for (const state of ["pending", "booked", "refused", "expired"] as const) assert.equal(stepGatedOutByLease({ ...base, state } as ClaimRow, "ledger_id"), false, `${state}: not settled_unbooked`);
});

// ---------- C5: rows the reconciler can never finish must not take its two daily slots (first-gate L4) ----------

type SeedState = "pending" | "settled_unbooked";
async function seedClaim(
  d1: LocalD1,
  o: { route: ClaimRoute; intent: Record<string, unknown>; state: SeedState; updatedAt: number; reason?: string | null; resource?: string; validBefore?: string },
): Promise<ClaimKey> {
  const nonce = "0x" + (++nonceSeq).toString(16).padStart(64, "0");
  const payload = { payload: { authorization: { from: TEST_PAYER, to: "0x1", value: "1000000", validBefore: o.validBefore ?? "9999999999", nonce } } };
  const { key, validBefore } = claimKeyFromPayload(payload, REQS);
  const spec: ClaimSpec = { route: o.route, intent: o.intent };
  const rpcBody = { paymentPayload: payload, paymentRequirements: { resource: o.resource ?? "https://example.test/api/patron", payTo: TREASURY_ADDRESS, maxAmountRequired: "1000000" } };
  const id = await claimIdentity(key, validBefore, rpcBody, spec);
  assert.deepEqual(await takeClaim(eq(d1), id, spec, "seed", Date.now()), { taken: true });
  d1.raw
    .prepare(`UPDATE settlement_claims SET state = ?, tx = ?, payer = ?, verdict_reason = ?, lease_owner = NULL, leased_until = NULL, updated_at = ? WHERE ${KEY_WHERE}`)
    .run(o.state, o.state === "settled_unbooked" ? TX : null, o.state === "settled_unbooked" ? TEST_PAYER : null, o.reason ?? null, o.updatedAt, ...(keyArgs(key) as never[]));
  return key;
}
const claimOfKey = async (d1: LocalD1, key: ClaimKey) => (await getClaim(eq(d1), key)) as ClaimRow;
const secretSeat = (handle: string) => ({ handle, model: "m", public_key: null });

test("C5: three rows the reconciler can never finish, older than one real row: one run reaches the real row, and the unfinishable ones take no further slot", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator();
  try {
    const funderId = insertCitizen(d1);
    const listingId = insertListing(d1, { funder_citizen_id: funderId, bounty_cents: 1200 }); // status 'open': not 'paying'
    const u1 = await seedClaim(d1, { route: "register", intent: secretSeat("c5-secret-one"), state: "settled_unbooked", updatedAt: 1_000 });
    const u2 = await seedClaim(d1, { route: "register", intent: secretSeat("c5-secret-two"), state: "settled_unbooked", updatedAt: 2_000 });
    const u3 = await seedClaim(d1, {
      route: "listing_pay",
      intent: { listing_id: listingId, submission_id: 1, funder_citizen_id: funderId, payee_citizen_id: funderId, payee_address: "0x" + "0a".repeat(20), amount_cents: 1200, wallet_row_id: 1, wallet_row_hash: "h" },
      state: "settled_unbooked",
      updatedAt: 3_000,
    });
    const real = await seedClaim(d1, { route: "patron", intent: { line: "the real row" }, state: "settled_unbooked", updatedAt: 4_000 });

    const { value: first, lines } = await captureLog(() => runReconciler(eq(d1)));
    assert.equal((await claimOfKey(d1, real)).state, "booked", "the real row was reached in ONE run (red under the old SELECT: the two secret-mode rows take both slots)");
    assert.equal(first.booked, 1);
    assert.equal(first.examined, 2, "the listing_pay row (its first meeting) and the real row; the two secret-mode rows were not selected at all");
    assert.equal(count(d1, "ledger"), 1);
    for (const k of [u1, u2]) {
      const row = await claimOfKey(d1, k);
      assert.equal(row.state, "settled_unbooked", "a secret-mode registration waits for its payer's re-send");
      assert.equal(row.verdict_reason, null, "and is not marked: it is only never selected");
      assert.equal(row.lease_owner, null, "no lease was taken on it");
      assert.equal(row.updated_at, k === u1 ? 1_000 : 2_000, "untouched: updated_at did not move");
    }
    const marked = await claimOfKey(d1, u3);
    assert.equal(marked.state, "settled_unbooked", "no new state");
    assert.equal(marked.verdict_reason, "listing_not_paying");
    assert.equal(marked.lease_owner, null);
    const logged = eventLines(lines, "settlement_listing_not_paying");
    assert.equal(logged.length, 1, "one line, written when the marker was first recorded");
    assert.equal(logged[0].level, "error");
    assert.equal(logged[0].tx, TX);
    assert.equal(logged[0].listing_id, listingId);
    assert.equal(logged[0].listing_status, "open");

    const { value: second, lines: lines2 } = await captureLog(() => runReconciler(eq(d1)));
    assert.equal(second.examined, 0, "nothing is left that the reconciler can work: the marked row is excluded too");
    assert.equal(eventLines(lines2, "settlement_listing_not_paying").length, 0, "and the line is not written again");
  } finally {
    stub.restore();
    d1.close();
  }
});

for (const scenario of ["public-key registration, settled_unbooked", "secret-mode registration, still PENDING", "pending row whose reason is only the facilitator's last words"] as const) {
  test(`C5 control (${scenario}): not excluded, still worked by the reconciler`, async () => {
    const d1 = createLocalD1();
    const stub = stubFacilitator({ settle: () => pendingAnswer(), rpc: () => authStateAnswer(false) });
    try {
      let key: ClaimKey;
      if (scenario.startsWith("public-key")) {
        key = await seedClaim(d1, { route: "register", intent: { handle: "c5-key-seat", model: "m", public_key: await realPublicKey() }, state: "settled_unbooked", updatedAt: 1_000 });
      } else if (scenario.startsWith("secret-mode")) {
        key = await seedClaim(d1, { route: "register", intent: secretSeat("c5-pending-secret"), state: "pending", updatedAt: 1_000, resource: "https://example.test/api/register" });
      } else {
        key = await seedClaim(d1, { route: "patron", intent: { line: "words" }, state: "pending", updatedAt: 1_000, reason: "The facilitator has not yet settled this payment (settlement_pending)" });
      }
      const out = await runReconciler(eq(d1));
      assert.equal(out.examined, 1, "the row was selected");
      assert.equal(out.failed, 0);
      if (scenario.startsWith("public-key")) {
        assert.equal(out.booked, 1, "a public-key registration is finished by the reconciler");
        assert.equal(count(d1, "citizens WHERE handle = 'c5-key-seat'"), 1);
      } else {
        assert.equal(out.unchanged, 1, "an unresolved pending row stays pending");
        assert.equal((await claimOfKey(d1, key)).state, "pending");
        assert.ok((await claimOfKey(d1, key)).updated_at !== 1_000, "its lease was taken: it was worked");
      }
    } finally {
      stub.restore();
      d1.close();
    }
  });
}

async function payFixture(d1: LocalD1) {
  const funderId = insertCitizen(d1);
  const reviewerId = insertCitizen(d1);
  const wallet = "0x" + "0a".repeat(20);
  const pin = await declareTestWallet(d1, reviewerId, wallet);
  const listingId = insertListing(d1, { funder_citizen_id: funderId, bounty_cents: 1200 });
  const submissionId = insertSubmission(d1, { listing_id: listingId, citizen_id: reviewerId });
  const header = paymentHeaderFor(wallet, atomicFromCents(1200));
  const send = async () => {
    try {
      const r = await handlePayListing(
        new Request(`https://example.test/api/listing/${listingId}/pay`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-PAYMENT": header },
          body: JSON.stringify({ submission_id: submissionId, wallet_row_id: pin.id, wallet_row_hash: pin.hash }),
        }),
        eq(d1),
        loadCitizen(d1, funderId),
        listingId,
      );
      return { status: r.status, body: (await r.json()) as Record<string, any> };
    } catch (e) {
      if (e instanceof SocietyError) return { status: e.status, body: { error: e.message, code: e.code } as Record<string, any> };
      throw e;
    }
  };
  const listing = () => d1.raw.prepare("SELECT status FROM listings WHERE id = ?").get(listingId) as { status: string };
  return { send, listing, listingId };
}

test("C5: a bounty payment whose listing is no longer 'paying' is marked listing_not_paying the first time the reconciler meets it, and every answer for it says so (no reconciler promise, no new signature)", async () => {
  const d1 = createLocalD1();
  const fx = await payFixture(d1);
  const stub = stubFacilitator({
    settle: () => {
      // the operator releases the reservation while A's /settle is in flight; the facilitator settles
      d1.raw.prepare("UPDATE listings SET status = 'open', paying_since = NULL, paying_wallet_row_id = NULL, paying_wallet_row_hash = NULL WHERE id = ?").run(fx.listingId);
      return settledAnswer();
    },
  });
  try {
    const first = await fx.send();
    assert.equal(first.status, 500, "the booking failed at the pay route (the listing is no longer paying)");
    const row = oneClaim(d1);
    assert.equal(row.state, "settled_unbooked");
    const { value: out, lines } = await captureLog(() => runReconciler(eq(d1)));
    assert.equal(out.unchanged, 1);
    assert.equal(out.failed, 0, "the reconciler did not try (and fail) to book it");
    assert.equal(eventLines(lines, "settlement_listing_not_paying").length, 1);
    assert.equal((d1.raw.prepare("SELECT verdict_reason FROM settlement_claims").get() as { verdict_reason: string }).verdict_reason, "listing_not_paying");
    assert.equal(count(d1, "listing_payments"), 0);

    // the funder's identical replay: answered from the claim, never re-attempted
    const replay = await fx.send();
    assert.equal(replay.status, 500, JSON.stringify(replay.body));
    assert.equal(replay.body.code, "settlement_unresolved");
    const text = String(replay.body.error);
    assert.match(text, new RegExp(TX));
    assert.match(text, /payment settled/);
    assert.match(text, /no longer awaiting this payment/);
    assert.match(text, /set it aside/);
    assert.match(text, /Do not sign again/);
    assert.doesNotMatch(text, /06:00|one pass a day|re-checks it sooner|can wait more than one day|nothing was charged|sign a fresh one/i, "no promise the reconciler will finish it");
    assert.equal(stub.calls.settle, 1, "the replay never reached the facilitator");
    assert.equal(count(d1, "listing_payments"), 0);
  } finally {
    stub.restore();
    d1.close();
  }
});

test("C5 control: a bounty payment whose listing is STILL 'paying' is not marked: the reconciler books it", async () => {
  const d1 = createLocalD1();
  const fx = await payFixture(d1);
  const stub = stubFacilitator();
  try {
    failInserts(d1, "c5_fail_payment", "listing_payments", null, "disk I/O error (test)");
    const first = await fx.send();
    assert.equal(first.status, 500, "A's booking failed after the settle");
    assert.equal(fx.listing().status, "paying", "the reservation stands");
    dropTrigger(d1, "c5_fail_payment");
    const out = await runReconciler(eq(d1));
    assert.equal(out.booked, 1);
    assert.equal(count(d1, "listing_payments"), 1);
    assert.equal(fx.listing().status, "paid");
    const row = d1.raw.prepare("SELECT state, verdict_reason FROM settlement_claims").get() as { state: string; verdict_reason: string | null };
    assert.equal(row.state, "booked");
    assert.notEqual(row.verdict_reason, "listing_not_paying");
  } finally {
    stub.restore();
    d1.close();
  }
});

test("C5: markListingNotPaying records its reason once (only the first call reports it, so the line is written once), and only on a settled_unbooked row", async () => {
  const d1 = createLocalD1();
  try {
    const pending = await claimInState(d1, "pending");
    assert.equal(await markListingNotPaying(eq(d1), pending, "A", Date.now()), false, "a pending claim is never marked: it can still expire or settle");
    const key = await claimInState(d1, "settled_unbooked");
    assert.equal(await markListingNotPaying(eq(d1), key, "A", Date.now()), true);
    assert.equal(await markListingNotPaying(eq(d1), key, "A", Date.now()), false, "already marked");
    const row = (await getClaim(eq(d1), key)) as ClaimRow;
    assert.equal(row.verdict_reason, "listing_not_paying");
    assert.equal(row.state, "settled_unbooked");
    assert.equal(row.lease_owner, null);
    assert.equal(((await getClaim(eq(d1), pending)) as ClaimRow).verdict_reason, null);
  } finally {
    d1.close();
  }
});

// ---------- C6: `expired` is decided on the chain's clock as well as the Worker's (first-gate L5, A4) ----------

const NOW_S = () => Math.floor(Date.now() / 1000);
// A pending claim whose authorisation's validBefore is `validBefore` (unix seconds), leased by "R" and ready for attemptPending.
async function leasedPending(d1: LocalD1, validBefore: number): Promise<{ key: ClaimKey; row: ClaimRow }> {
  const key = await seedClaim(d1, { route: "patron", intent: { line: "c6" }, state: "pending", updatedAt: 1_000, validBefore: String(validBefore) });
  const row = await acquireLease(eq(d1), key, "R", Date.now());
  assert.ok(row, "R holds the lease");
  return { key, row: row as ClaimRow };
}
const methodsOf = (stub: { rpcCalls: { method: string | undefined }[] }) => stub.rpcCalls.map((c) => c.method);

test("C6: an RPC pair whose latest block is not yet past validBefore + margin never yields `expired`, though the wall clock is past; one block later it does", async () => {
  const margin = RECONCILE_EXPIRY_MARGIN_SECONDS;
  const V = NOW_S() - 5_000; // the wall clock is far past validBefore + margin
  for (const blockTime of [V - 10, V, V + 100, V + margin]) {
    const d1 = createLocalD1();
    const stub = stubFacilitator({ settle: () => pendingAnswer(), rpc: chainRpc(false, blockTime) });
    try {
      const { key, row } = await leasedPending(d1, V);
      const out = await attemptPending(eq(d1), row, "R");
      assert.equal(out.kind, "unchanged", `block time ${blockTime - V} s after validBefore (margin ${margin}): not expired`);
      assert.match((out as { detail: string }).detail, /chain's own clock has not confirmed it/);
      assert.equal(((await getClaim(eq(d1), key)) as ClaimRow).state, "pending", "the claim is untouched");
      assert.equal(stub.calls.settle, 0, "and nothing was re-POSTed: the chain read decides, and it did not decide");
    } finally {
      stub.restore();
      d1.close();
    }
  }
  const d1 = createLocalD1();
  const stub = stubFacilitator({ settle: () => pendingAnswer(), rpc: chainRpc(false, V + margin + 1) });
  try {
    const { key, row } = await leasedPending(d1, V);
    const out = await attemptPending(eq(d1), row, "R");
    assert.equal(out.kind, "expired", "a block one second past validBefore + margin, unused at both RPCs: expired");
    assert.equal(((await getClaim(eq(d1), key)) as ClaimRow).state, "expired");
  } finally {
    stub.restore();
    d1.close();
  }
});

test("C6: a lagging RPC is skipped, not counted: two others that agree still give `expired`; with only one good RPC it is not expired", async () => {
  const V = NOW_S() - 5_000;
  const lagging = (urls: Set<string>) => (url: string) => (urls.has(url) ? V - 50 : NOW_S());
  for (const [lagCount, expected] of [[1, "expired"], [3, "unchanged"]] as const) {
    const d1 = createLocalD1();
    const lagUrls = new Set<string>();
    const stub = stubFacilitator({
      settle: () => pendingAnswer(),
      rpc: (url, n, init) => {
        // the plain first read (no block calls yet) names the order of the RPCs; the first `lagCount` of them lag in the pinned read
        if (lagUrls.size < lagCount && !lagUrls.has(url) && n >= 2) lagUrls.add(url);
        return chainRpc(false, lagging(lagUrls))(url, n, init);
      },
    });
    try {
      const { row } = await leasedPending(d1, V);
      const out = await attemptPending(eq(d1), row, "R");
      assert.equal(out.kind, expected, `${lagCount} lagging RPC(s) of four`);
    } finally {
      stub.restore();
      d1.close();
    }
  }
});

test("C6 (A4): an ordinary poll costs nothing extra: no block is read before validBefore + margin, nor when the chain says USED", async () => {
  // (a) the wall clock is before validBefore: two eth_calls and nothing else
  {
    const d1 = createLocalD1();
    const stub = stubFacilitator({ settle: () => pendingAnswer(), rpc: chainRpc(false) });
    try {
      const { row } = await leasedPending(d1, NOW_S() + 3_600);
      const out = await attemptPending(eq(d1), row, "R");
      assert.equal(out.kind, "unchanged");
      assert.deepEqual(methodsOf(stub), ["eth_call", "eth_call"], "the quorum read, as before");
      assert.equal(out.fetches, 3, "two RPC reads and the re-POST: unchanged from before C6");
    } finally {
      stub.restore();
      d1.close();
    }
  }
  // (b) the wall clock is past, but the chain says the authorisation was USED: that is not an expiry, so no block is read
  {
    const d1 = createLocalD1();
    const stub = stubFacilitator({ settle: () => pendingAnswer(), rpc: chainRpc(true) });
    try {
      const { row } = await leasedPending(d1, NOW_S() - 5_000);
      await attemptPending(eq(d1), row, "R");
      assert.deepEqual(methodsOf(stub), ["eth_call", "eth_call"], "a used authorisation costs the same two reads");
    } finally {
      stub.restore();
      d1.close();
    }
  }
});

test("C6: the confirming read is PINNED: each RPC is asked for its latest block, then the eth_call is made at that block's number, not at 'latest'", async () => {
  const d1 = createLocalD1();
  const V = NOW_S() - 5_000;
  const stub = stubFacilitator({ settle: () => pendingAnswer(), rpc: chainRpc(false) });
  try {
    const { row } = await leasedPending(d1, V);
    const out = await attemptPending(eq(d1), row, "R");
    assert.equal(out.kind, "expired");
    assert.deepEqual(methodsOf(stub), ["eth_call", "eth_call", "eth_getBlockByNumber", "eth_call", "eth_getBlockByNumber", "eth_call"], "plain read, then block + pinned call per RPC");
    const [first, second, block1, call1, block2, call2] = stub.rpcCalls;
    assert.equal((first.params as unknown[])[1], "latest", "the plain read is at latest");
    assert.equal((second.params as unknown[])[1], "latest");
    assert.deepEqual(block1.params, ["latest", false]);
    assert.equal((call1.params as unknown[])[1], "0x1000", "the pinned eth_call names the block number the RPC just returned");
    assert.equal((call2.params as unknown[])[1], "0x1000");
    assert.equal(block1.url, call1.url, "on the SAME RPC");
    assert.equal(block2.url, call2.url);
    assert.notEqual(block1.url, block2.url, "and the two answers come from distinct RPCs");
    assert.equal(out.fetches, 6, "2 (plain) + 4 (two RPCs x block and call)");
  } finally {
    stub.restore();
    d1.close();
  }
});

test("C6: an authorisation spent between the two reads is not expired, and two RPCs that disagree at the pinned block are no answer", async () => {
  const V = NOW_S() - 5_000;
  // (a) unused on the plain read, used on the pinned one
  {
    const d1 = createLocalD1();
    const stub = stubFacilitator({
      settle: () => pendingAnswer(),
      rpc: (url, n, init) => {
        const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
        if (body.method === "eth_call") return authStateAnswer(body.params[1] !== "latest");
        return chainRpc(false)(url, n, init);
      },
    });
    try {
      const { key, row } = await leasedPending(d1, V);
      const out = await attemptPending(eq(d1), row, "R");
      assert.equal(out.kind, "unchanged");
      assert.match((out as { detail: string }).detail, /spent while the society was confirming/);
      assert.equal(((await getClaim(eq(d1), key)) as ClaimRow).state, "pending");
      assert.equal(stub.calls.settle, 0, "the next attempt re-checks it as used; this one does not run a settle past its budget");
    } finally {
      stub.restore();
      d1.close();
    }
  }
  // (b) the pinned reads disagree
  {
    const d1 = createLocalD1();
    let pinned = 0;
    const stub = stubFacilitator({
      settle: () => pendingAnswer(),
      rpc: (url, n, init) => {
        const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
        if (body.method === "eth_call" && body.params[1] !== "latest") return authStateAnswer(pinned++ === 1);
        if (body.method === "eth_call") return authStateAnswer(false);
        return chainRpc(false)(url, n, init);
      },
    });
    try {
      const { row } = await leasedPending(d1, V);
      const out = await attemptPending(eq(d1), row, "R");
      assert.equal(out.kind, "unchanged");
      assert.match((out as { detail: string }).detail, /disagree/);
    } finally {
      stub.restore();
      d1.close();
    }
  }
});

test("C6: the expiry path's worst case through the real reconciler stays inside RECONCILE_ROW_WORST_CASE (two RPCs down in the plain read; in the pinned read one block read fails and one RPC lags)", async () => {
  const d1 = createLocalD1();
  const V = NOW_S() - 5_000;
  const urls: string[] = [];
  const stub = stubFacilitator({
    settle: () => pendingAnswer(),
    rpc: (url, n, init) => {
      const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      if (!urls.includes(url)) urls.push(url);
      const position = urls.indexOf(url);
      const plain = body.method === "eth_call" && body.params[1] === "latest";
      if (plain && position <= 1) return null; // RPCs 1 and 2 are down in the plain read: four fetches to reach two answers
      if (!plain && position === 0) return null; // RPC 1's block read fails in the pinned read (no eth_call follows)
      if (!plain && position === 1) return chainRpc(false, V - 1)(url, n, init); // RPC 2 lags
      return chainRpc(false)(url, n, init);
    },
  });
  try {
    await seedClaim(d1, { route: "patron", intent: { line: "c6 cost" }, state: "pending", updatedAt: 1_000, validBefore: String(V) });
    const out = await runReconciler(eq(d1));
    assert.equal(out.resolved, 1, "expired");
    assert.equal(stub.rpcCalls.length, 4 + 7, "plain read: 4 fetches; pinned read: 1 (down) + 2 (lagging) + 2 + 2 = 7");
    assert.equal(out.actualCost, RECONCILE_SELECT_COST + 2 + 11, "the select, the lease and the terminal write, and the eleven RPC fetches");
    assert.ok(out.actualCost - RECONCILE_SELECT_COST <= RECONCILE_ROW_WORST_CASE, `the row cost ${out.actualCost - RECONCILE_SELECT_COST}, inside the ${RECONCILE_ROW_WORST_CASE} priced worst case`);
    assert.equal(count(d1, "ledger"), 0);
  } finally {
    stub.restore();
    d1.close();
  }
});

test("C6 (CODEX M3-build r1 MEDIUM): when the expiry write THROWS after the pinned re-read, the reconciler prices the row at the C6 fetch maximum, never below the fetches it really made", async () => {
  // Same bad day as above, but markExpired's UPDATE throws: attemptPending cannot report its fetches, and the old substitute (5: 4 RPC + 1 settle)
  // understated the eleven RPC fetches. Mutant: restore `fetches = 5` -> the priced cost falls below the measured fetches.
  const d1 = createLocalD1();
  const V = NOW_S() - 5_000;
  const urls: string[] = [];
  const stub = stubFacilitator({
    settle: () => pendingAnswer(),
    rpc: (url, n, init) => {
      const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      if (!urls.includes(url)) urls.push(url);
      const position = urls.indexOf(url);
      const plain = body.method === "eth_call" && body.params[1] === "latest";
      if (plain && position <= 1) return null;
      if (!plain && position === 0) return null;
      if (!plain && position === 1) return chainRpc(false, V - 1)(url, n, init);
      return chainRpc(false)(url, n, init);
    },
  });
  const base = eq(d1);
  let failed = 0;
  const failingDb = new Proxy(base.DB as object, {
    get(t: any, p: string | symbol) {
      if (p === "prepare") {
        return (sql: string) => {
          if (sql.includes("SET state = 'expired'")) {
            const boom: any = { bind: () => boom, run: async () => { failed++; throw new Error("D1_ERROR: injected"); }, first: async () => { failed++; throw new Error("D1_ERROR: injected"); }, all: async () => { failed++; throw new Error("D1_ERROR: injected"); } };
            return boom;
          }
          return t.prepare(sql);
        };
      }
      const v = t[p];
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  try {
    await seedClaim(d1, { route: "patron", intent: { line: "c6 cost" }, state: "pending", updatedAt: 1_000, validBefore: String(V) });
    const out = await runReconciler({ ...base, DB: failingDb } as unknown as Env);
    assert.ok(failed >= 1, "the expiry write was attempted and failed");
    assert.equal(stub.rpcCalls.length, 11, "the same eleven RPC fetches as the bad day above");
    assert.ok(out.actualCost - RECONCILE_SELECT_COST >= stub.rpcCalls.length + 1, `priced ${out.actualCost - RECONCILE_SELECT_COST} for the row, measured at least ${stub.rpcCalls.length + 1} (the RPC fetches and the lease)`);
    assert.ok(out.actualCost - RECONCILE_SELECT_COST <= RECONCILE_ROW_WORST_CASE, "and still inside the priced worst case");
  } finally {
    stub.restore();
    d1.close();
  }
});

// ---------- C8: the two secret-mode messages that could be false after the citizen batch committed (first-gate L7) ----------

// An Env whose reads of the claim table THROW once the nth batch has committed: the read-back after the committed final secret-mode step "fails".
function readBackThrowsEnv(d1: LocalD1, afterBatch: number): Env {
  const real = d1.DB;
  let calls = 0;
  let armed = false;
  const DB = {
    prepare: (sql: string) => {
      if (armed && /^\s*SELECT \* FROM settlement_claims/i.test(sql)) throw new Error("D1 read failed after the commit (test)");
      return real.prepare(sql);
    },
    batch: async (stmts: never[]) => {
      const out = await real.batch(stmts);
      if (++calls === afterBatch) armed = true;
      return out;
    },
  };
  return { ...testEnv(d1), DB } as unknown as Env;
}
// An Env whose nth batch COMMITS and then throws (D1 committed and still reported an error).
function commitsThenThrowsEnv(d1: LocalD1, nth: number): Env {
  const real = d1.DB;
  let calls = 0;
  const DB = {
    prepare: (sql: string) => real.prepare(sql),
    batch: async (stmts: never[]) => {
      const out = await real.batch(stmts);
      if (++calls === nth) throw new Error("D1 reported an error after the commit (test)");
      return out;
    },
  };
  return { ...testEnv(d1), DB } as unknown as Env;
}

test("C8: a read-back that FAILS after the committed final secret-mode step still yields the 201, with the citizen id from the batch and the stored secret", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator();
  try {
    const { value: res, lines } = await captureLog(() => callWorker(registerReq({ handle: "c8-seat", model: "m" }, registerHeader()), readBackThrowsEnv(d1, 2))); // batch 1 = ledger, 2 = the citizen
    const body = await json(res);
    assert.equal(res.status, 201, JSON.stringify(body));
    assert.match(String(body.secret), /^commonhold_sk_[0-9a-f]{64}$/);
    const stored = d1.raw.prepare("SELECT id, secret_hash FROM citizens WHERE handle = 'c8-seat'").get() as { id: number; secret_hash: string };
    assert.equal(await sha256Hex(String(body.secret)), stored.secret_hash, "the delivered secret is the stored one");
    assert.equal(body.citizen_id, stored.id, "and the citizen id is the row the batch created (no read-back to learn it)");
    assert.equal(oneClaim(d1).state, "booked");
    assert.equal(eventLines(lines, "registration_paid_but_failed").length, 0, "no booking-failure line for a registration that was delivered");
    assert.equal(stub.calls.settle, 1);
  } finally {
    stub.restore();
    d1.close();
  }
});

test("C8: D1 commits the citizen batch and still throws: the answer does not promise a fresh secret, and the payer's repeat is told exactly what the first answer said it would be told", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator();
  try {
    const header = registerHeader();
    const body = { handle: "c8-after-commit", model: "m" };
    const { value: first, lines } = await captureLog(() => callWorker(registerReq(body, header), commitsThenThrowsEnv(d1, 2)));
    const firstBody = await json(first);
    assert.equal(first.status, 500, JSON.stringify(firstBody));
    const text = String(firstBody.error);
    assert.equal(eventLines(lines, "registration_paid_but_failed").length, 1);
    assert.match(text, /No credential was delivered to you/);
    assert.doesNotMatch(text, /hands you a fresh secret/, "it no longer promises a fresh secret the booked claim cannot give");
    assert.match(text, /if a seat was already created before this error, the repeat tells you so, and that seat's secret cannot be recovered/);
    assert.match(text, /if no seat was created, the repeat attempts to create it and, if that succeeds, hands you its secret/, "the hedge: a repeat under a persistent fault cannot promise the seat");
    assert.match(text, /Do not sign again/);
    // the batch DID commit: the seat exists and the claim is booked
    assert.equal(count(d1, "citizens WHERE handle = 'c8-after-commit'"), 1);
    assert.equal(oneClaim(d1).state, "booked");

    const repeat = await callWorker(registerReq(body, header), eq(d1));
    const repeatBody = await json(repeat);
    assert.equal(repeat.status, 409, JSON.stringify(repeatBody));
    assert.equal(repeatBody.code, "settlement_already_booked");
    assert.match(String(repeatBody.error), /Your seat exists|your seat exists/);
    assert.match(String(repeatBody.error), /cannot be recovered/, "as the first answer said it would");
    assert.equal(repeatBody.secret, undefined);
    assert.equal(count(d1, "citizens"), 1, "no second seat");
    assert.equal(stub.calls.settle, 1, "nothing was charged again");
  } finally {
    stub.restore();
    d1.close();
  }
});

test("C8: the booked-claim answer for a secret registration makes no claim about a response having been issued; it says only that the seat exists and its secret cannot be recovered", () => {
  const row = {
    state: "booked", route: "register", tx: TX,
    intent_json: JSON.stringify({ handle: "c8-seat", model: "m", public_key: null }),
  } as unknown as ClaimRow;
  const answer = claimAnswer(row, true, {});
  const text = String((answer.body as { error: string }).error);
  assert.equal(answer.status, 409);
  assert.doesNotMatch(text, /was issued|were issued|issued to you|a response containing its secret/i);
  assert.match(text, /your seat exists; its secret was generated once, for the response to the request that registered it, and cannot be recovered/);
  assert.match(text, /If that response did not reach you, the secret is lost/);
  assert.match(text, new RegExp(TX));
  assert.match(text, /nothing was charged again/);
});

test("C8: runBookingStep reports the id the row-creating statement reported, only when the step applied", async () => {
  const d1 = createLocalD1();
  try {
    const key = await claimInState(d1, "settled_unbooked");
    // the claim is leased by "A" (takeClaim); a stale owner's step is gated out and reports no id
    const step = {
      ref: "citizen_id" as const,
      final: false,
      statements: async (gate: { sql: string; args: readonly unknown[] }) => [
        d1.DB.prepare("INSERT INTO citizens (handle, model, secret_hash, public_key, karma, created_at, last_seen_at) SELECT 'c8-unit', 'm', 'h', NULL, 0, 1, 1 WHERE EXISTS (" + gate.sql + ")").bind(...gate.args) as unknown as D1PreparedStatement,
      ],
    };
    const stale = await runBookingStep(eq(d1), key, step, "stranger", Date.now());
    assert.deepEqual(stale, { applied: false }, "gated out by A's live lease: applied false and no row id");
    assert.equal(count(d1, "citizens"), 0);
    const mine = await runBookingStep(eq(d1), key, step, "A", Date.now());
    assert.equal(mine.applied, true);
    const stored = d1.raw.prepare("SELECT id FROM citizens WHERE handle = 'c8-unit'").get() as { id: number };
    assert.equal(mine.rowId, stored.id, "the id the batch reported is the row it created, and the one the claim recorded");
    assert.equal(JSON.parse(((await getClaim(eq(d1), key)) as ClaimRow).booked_refs).citizen_id, stored.id);
  } finally {
    d1.close();
  }
});

test("C6 consequence, pinned: after an expiry row (now 8-9 subrequests, not about 4) the reconciler sheds a second due row for the next run, instead of starting it past the ceiling", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator({ settle: () => pendingAnswer(), rpc: chainRpc(false) });
  try {
    const V = NOW_S() - 5_000;
    await seedClaim(d1, { route: "patron", intent: { line: "first expiry" }, state: "pending", updatedAt: 1_000, validBefore: String(V) });
    await seedClaim(d1, { route: "patron", intent: { line: "second expiry" }, state: "pending", updatedAt: 2_000, validBefore: String(V) });
    const { value: out, lines } = await captureLog(() => runReconciler(eq(d1)));
    assert.equal(out.examined, 1, "one row this run");
    assert.equal(out.resolved, 1, "and it was expired");
    assert.equal(eventLines(lines, "settlement_reconcile_shed").length, 1, "the second row is shed, loudly, and waits for the next run");
    assert.equal((d1.raw.prepare("SELECT COUNT(*) AS n FROM settlement_claims WHERE state = 'pending'").get() as { n: number }).n, 1, "the shed row is still pending, untouched");
    const next = await runReconciler(eq(d1));
    assert.equal(next.resolved, 1, "the next run expires it");
  } finally {
    stub.restore();
    d1.close();
  }
});
