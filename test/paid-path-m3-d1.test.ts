// Paid-path wave M3, the choice-free subset (C1, C2, C3, C5, C6, C8): the residuals of the M2 gates
// (drafts/BRIEF-PAID-PATH-M3-2026-10-02.md with its amendments; docs/REVIEW-SETTLEMENT-REPLAY-GUARD-GATE-2026-09-30.md and
// docs/REVIEW-SETTLEMENT-REPLAY-GUARD-REGATE-2026-10-01.md). Real local D1 and the real Worker router; the facilitator and the Base RPCs are
// stubbed through globalThis.fetch. Every guard here was red-proofed with its file run alone (docs/CHECKPOINT-PAID-PATH-M3.md carries each mutant
// and the test that went red).
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import {
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
  stubFacilitator,
  testEnv,
  type LocalD1,
} from "./helpers/settlement-harness.ts";
import {
  acquireLease,
  claimIdentity,
  claimKeyFromPayload,
  getClaim,
  keyOfRow,
  markContradiction,
  markExpired,
  markRefused,
  takeClaim,
  KEY_WHERE,
  keyArgs,
  type ClaimKey,
  type ClaimRow,
  type ClaimSpec,
} from "../src/settlement-claims.ts";
import { runReconciler } from "../src/settlement-reconcile.ts";

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
  const moved = kind === "refused" ? await markRefused(eq(d1), key, B_REFUSAL, "B", Date.now()) : await markExpired(eq(d1), key, "B", Date.now());
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

test("C1 control: an UNSTAMPED refused claim still answers a replay with the 402 and accepts, and an unstamped expired one with the expiry 402", async () => {
  // refused, by a plain recorded refusal (no contradiction anywhere)
  {
    const d1 = createLocalD1();
    const stub = stubFacilitator({ settle: () => new Response(JSON.stringify({ success: false, errorReason: "insufficient_funds" }), { status: 200, headers: { "content-type": "application/json" } }) });
    try {
      const header = paymentHeaderFor(TREASURY_ADDRESS, "1000000");
      assert.equal((await callWorker(patronReq("rent", header), eq(d1))).status, 402);
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

test("C2 control: an ordinary unknown outcome (no verdict in hand) still says this request changed nothing and writes no settlement_success_unrecorded line", async () => {
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
    assert.match(String((await json(res[1])).error), /changed nothing/);
    assert.equal(eventLines(lines, "settlement_success_unrecorded").length, 0, "no success verdict, no success line");
  } finally {
    stub.restore();
    d1.close();
  }
});
