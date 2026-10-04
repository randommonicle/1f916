// Paid-path wave M3, the SECOND build (drafts/BRIEF-PAID-PATH-M3-2026-10-02.md, "Amendments after CODEX r2" and the sections it makes operative; commission
// drafts/BUILDER-COMMISSION-M3-SECOND-BUILD-2026-10-04.md): C4 option B (stamp and stop), H2 (a re-POST refusal never marks `refused`), H3 (a stranded listing_pay claim
// is never re-POSTed against a reservation that is not its own; a takeClaim that throws re-reads), M4 (the validBefore bound), C7 (the attention list), R2-1 (the first
// attempt's refusal is bound to its take time), R2-3 and R2-4. Real local D1 and the real Worker router; the facilitator and the Base RPCs are stubbed through
// globalThis.fetch. Every guard here was red-proofed with this file run alone (docs/CHECKPOINT-PAID-PATH-M3.md, "Second build").
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
  chainRpc,
  count,
  createLocalD1,
  eventLines,
  json,
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
  markChainSpent,
  noteUnknown,
  takeClaim,
  KEY_WHERE,
  keyArgs,
  type ClaimKey,
  type ClaimRoute,
  type ClaimRow,
  type ClaimSpec,
} from "../src/settlement-claims.ts";
import { runReconciler } from "../src/settlement-reconcile.ts";
import { attemptPending } from "../src/x402.ts";

const REQS = { network: "base", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" };
const eq = (d1: LocalD1) => testEnv(d1);
const settledAnswer = () => new Response(JSON.stringify({ success: true, payer: TEST_PAYER, transaction: TX }), { status: 200, headers: { "content-type": "application/json" } });
const pendingAnswer = () => new Response(JSON.stringify({ success: false, errorReason: "settlement_pending" }), { status: 200, headers: { "content-type": "application/json" } });
// A recorded refusal (classifySettle rule 7). The sentinel lets a test prove the facilitator's words never reach a public surface.
const REFUSAL_SENTINEL = "SENTINEL_REFUSAL_7f3a";
const refusedAnswer = () => new Response(JSON.stringify({ success: false, errorReason: REFUSAL_SENTINEL }), { status: 200, headers: { "content-type": "application/json" } });
const NOW_S = () => Math.floor(Date.now() / 1000);
const claimDetail = (d1: LocalD1) => d1.raw.prepare("SELECT state, tx, verdict_reason, rpc_body, lease_owner, leased_until, updated_at FROM settlement_claims").get() as {
  state: string;
  tx: string | null;
  verdict_reason: string | null;
  rpc_body: string | null;
  lease_owner: string | null;
  leased_until: number | null;
  updated_at: number;
};

// A claim seeded directly (no route), in state `pending`, ready for attemptPending.
let nonceSeq = 0x5000;
async function seedClaim(
  d1: LocalD1,
  o: { route: ClaimRoute; intent: Record<string, unknown>; updatedAt?: number; reason?: string | null; validBefore?: string; createdAt?: number },
): Promise<ClaimKey> {
  const nonce = "0x" + (++nonceSeq).toString(16).padStart(64, "0");
  const payload = { payload: { authorization: { from: TEST_PAYER, to: "0x1", value: "1000000", validBefore: o.validBefore ?? String(NOW_S() + 300), nonce } } };
  const { key, validBefore } = claimKeyFromPayload(payload, REQS);
  const spec: ClaimSpec = { route: o.route, intent: o.intent };
  const rpcBody = { paymentPayload: payload, paymentRequirements: { resource: "https://example.test/api/patron", payTo: TREASURY_ADDRESS, maxAmountRequired: "1000000" } };
  const id = await claimIdentity(key, validBefore, rpcBody, spec);
  assert.deepEqual(await takeClaim(eq(d1), id, spec, "seed", o.createdAt ?? Date.now()), { taken: true });
  d1.raw
    .prepare(`UPDATE settlement_claims SET verdict_reason = ?, lease_owner = NULL, leased_until = NULL, updated_at = ? WHERE ${KEY_WHERE}`)
    .run(o.reason ?? null, o.updatedAt ?? 1_000, ...(keyArgs(key) as never[]));
  return key;
}
const claimOfKey = async (d1: LocalD1, key: ClaimKey) => (await getClaim(eq(d1), key)) as ClaimRow;

// ---------- C4, option B: the chain reads the authorisation USED and the facilitator answers a recorded refusal: stamp and stop ----------

const CHAIN_SPENT = "chain_spent_facilitator_refused";

async function leasedPending(d1: LocalD1, route: ClaimRoute = "patron", intent: Record<string, unknown> = { line: "c4" }): Promise<{ key: ClaimKey; row: ClaimRow }> {
  const key = await seedClaim(d1, { route, intent });
  const row = await acquireLease(eq(d1), key, "R", Date.now());
  assert.ok(row, "R holds the lease");
  return { key, row: row as ClaimRow };
}

test("C4-B: the chain says USED and the facilitator answers a recorded refusal: the claim stays pending, stamped with the marker and the facilitator's words, the lease cleared, and the outcome is `stopped` (not `unchanged`)", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator({ settle: () => refusedAnswer(), rpc: chainRpc(true) });
  try {
    const { row } = await leasedPending(d1);
    const { value: out, lines } = await captureLog(() => attemptPending(eq(d1), row, "R"));
    assert.equal(out.kind, "stopped", JSON.stringify(out));
    const after = claimDetail(d1);
    assert.equal(after.state, "pending", "never refused: the chain says the money moved");
    assert.ok(String(after.verdict_reason).startsWith(`${CHAIN_SPENT}:`), `the marker leads: ${after.verdict_reason}`);
    assert.match(String(after.verdict_reason), new RegExp(REFUSAL_SENTINEL), "the facilitator's words are kept inside the stamp, the only record of what it said");
    assert.equal(after.lease_owner, null, "the stamp clears the lease");
    assert.notEqual(after.rpc_body, null, "the authorisation body is untouched (the row is not terminal)");
    assert.equal(eventLines(lines, "settlement_chain_spent_stopped").length, 1, "one error line for the maintainer");
  } finally {
    stub.restore();
    d1.close();
  }
});

test("C4-B (A3): attemptPending returns early on a marked row: no RPC read, no /settle, no write", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator({ settle: () => settledAnswer(), rpc: chainRpc(true) });
  try {
    const { row } = await leasedPending(d1);
    assert.equal(await markChainSpent(eq(d1), keyOfRow(row), "stamped by a test", "R", Date.now()), true);
    const marked = await acquireLease(eq(d1), keyOfRow(row), "R2", Date.now());
    assert.ok(marked && String(marked.verdict_reason).startsWith(`${CHAIN_SPENT}:`));
    const before = claimDetail(d1);
    const out = await attemptPending(eq(d1), marked as ClaimRow, "R2");
    assert.equal(out.kind, "unchanged");
    assert.equal(out.fetches, 0);
    assert.equal(stub.rpcUrls.length, 0, "the chain was not read");
    assert.equal(stub.calls.settle, 0, "nothing was re-POSTed");
    const after = claimDetail(d1);
    assert.equal(after.verdict_reason, before.verdict_reason);
    assert.equal(after.state, "pending");
  } finally {
    stub.restore();
    d1.close();
  }
});

test("C4-B (A3): noteUnknown never overwrites a marker, and still writes an unmarked pending row", async () => {
  const d1 = createLocalD1();
  try {
    const { row, key } = await leasedPending(d1);
    // control: an unmarked pending row takes the facilitator's last words (and the lease is cleared)
    await noteUnknown(eq(d1), key, "the facilitator said something", "R", Date.now());
    assert.equal(claimDetail(d1).verdict_reason, "the facilitator said something");
    assert.equal(claimDetail(d1).lease_owner, null);
    assert.equal(await markChainSpent(eq(d1), keyOfRow(row), "marked", "R", Date.now()), true);
    // the marked row now has a lease owner again (a late holder), and its unknown outcome must not overwrite the marker
    d1.raw.prepare(`UPDATE settlement_claims SET lease_owner = 'LATE', leased_until = ${Date.now() + 60_000} WHERE ${KEY_WHERE}`).run(...(keyArgs(key) as never[]));
    await noteUnknown(eq(d1), key, "a late unknown outcome", "LATE", Date.now());
    assert.ok(String(claimDetail(d1).verdict_reason).startsWith(`${CHAIN_SPENT}:`), `the marker survived: ${claimDetail(d1).verdict_reason}`);
  } finally {
    d1.close();
  }
});

test("C4-B: markChainSpent stamps only a pending row, and only once", async () => {
  const d1 = createLocalD1();
  try {
    const { key } = await leasedPending(d1);
    assert.equal(await markChainSpent(eq(d1), key, "first", "R", Date.now()), true);
    assert.equal(await markChainSpent(eq(d1), key, "second", "R", Date.now()), false, "already stamped: the first reason is kept");
    assert.match(String(claimDetail(d1).verdict_reason), /first/);
    const settled = await seedClaim(d1, { route: "patron", intent: { line: "not pending" } });
    d1.raw.prepare(`UPDATE settlement_claims SET state = 'settled_unbooked', tx = ?, payer = ? WHERE ${KEY_WHERE}`).run(TX, TEST_PAYER, ...(keyArgs(settled) as never[]));
    assert.equal(await markChainSpent(eq(d1), settled, "x", "R", Date.now()), false, "a settled_unbooked row is never stamped by this");
  } finally {
    d1.close();
  }
});

test("C4-B: the reconciler stamps the row once and never selects it again (no re-POST on the second run), counting it `stopped`", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator({ settle: (n) => (n === 1 ? pendingAnswer() : refusedAnswer()), rpc: chainRpc(true) });
  try {
    const header = paymentHeaderFor(TREASURY_ADDRESS, "1000000");
    assert.equal((await callWorker(patronReq("rent", header), eq(d1))).status, 502);
    const { value: first } = await captureLog(() => runReconciler(eq(d1)));
    assert.equal(first.stopped, 1, JSON.stringify(first));
    assert.equal(first.unchanged, 0);
    assert.ok(String(claimDetail(d1).verdict_reason).startsWith(`${CHAIN_SPENT}:`));
    assert.equal(stub.calls.settle, 2);
    const second = await runReconciler(eq(d1));
    assert.equal(second.examined, 0, "the stamped row is excluded from the SELECT");
    assert.equal(stub.calls.settle, 2, "no further /settle");
  } finally {
    stub.restore();
    d1.close();
  }
});

test("R2-3: the re-send that meets the refusal is answered with the stopped-row text, and every later identical request is answered the same way without touching the chain or the facilitator", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator({ settle: (n) => (n === 1 ? pendingAnswer() : refusedAnswer()), rpc: chainRpc(true) });
  try {
    const header = paymentHeaderFor(TREASURY_ADDRESS, "1000000");
    assert.equal((await callWorker(patronReq("rent", header), eq(d1))).status, 502);
    const resend = await callWorker(patronReq("rent", header), eq(d1));
    const body = await json(resend);
    assert.equal(resend.status, 500, JSON.stringify(body));
    assert.equal(body.code, "settlement_unresolved");
    const text = String(body.error);
    assert.match(text, /stopped retrying/i);
    assert.match(text, /Do not sign again/);
    assert.match(text, /check it against the chain by hand/i);
    assert.match(text, /no resolution time is promised/i);
    assert.equal(body.accepts, undefined, "no fresh payment requirements");
    assert.doesNotMatch(text, /06:00|one pass a day|reconciler|Repeating this identical request|re-checks it sooner|nothing was charged|sign a fresh one|no money moved/i, "no reconciler promise, no repeat instruction, no 'nothing was charged'");
    assert.doesNotMatch(text, new RegExp(REFUSAL_SENTINEL), "the facilitator's words are not served");
    const rpcBefore = stub.rpcUrls.length;
    const settleBefore = stub.calls.settle;
    const stampedAt = claimDetail(d1).updated_at;
    const replay = await callWorker(patronReq("rent", header), eq(d1));
    assert.equal(replay.status, 500);
    assert.equal((await json(replay)).error, body.error, "the same words every time");
    assert.equal(stub.rpcUrls.length, rpcBefore, "the chain was not read for a stopped row");
    assert.equal(stub.calls.settle, settleBefore, "no /settle for a stopped row");
    assert.equal(claimDetail(d1).updated_at, stampedAt, "no write at all: the replay took no lease on the stopped row");
  } finally {
    stub.restore();
    d1.close();
  }
});

test("C4-B control: the chain says USED and the facilitator says SETTLED: the claim books as before (the marker is for a refusal only)", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator({ settle: (n) => (n === 1 ? pendingAnswer() : settledAnswer()), rpc: chainRpc(true) });
  try {
    const header = paymentHeaderFor(TREASURY_ADDRESS, "1000000");
    assert.equal((await callWorker(patronReq("rent", header), eq(d1))).status, 502);
    const resend = await callWorker(patronReq("rent", header), eq(d1));
    assert.equal(resend.status, 200, JSON.stringify(await resend.clone().json()));
    assert.equal(claimDetail(d1).state, "booked");
  } finally {
    stub.restore();
    d1.close();
  }
});


// ---------- H2: a rule-7 refusal on the re-POST path, while the chain reads UNUSED, never marks the claim refused ----------

test("H2: the re-POST draws a rule-7 refusal while the chain reads UNUSED: the claim stays pending (outcome `unchanged`, the detail names the refusal), the body and reservation are untouched, never `refused`", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator({ settle: () => refusedAnswer(), rpc: chainRpc(false) });
  try {
    const { row } = await leasedPending(d1);
    const out = await attemptPending(eq(d1), row, "R");
    assert.equal(out.kind, "unchanged", JSON.stringify(out));
    assert.match(String((out as { detail?: string }).detail), new RegExp(REFUSAL_SENTINEL), "the detail names the facilitator's refusal");
    const after = claimDetail(d1);
    assert.equal(after.state, "pending", "never refused on a re-POST: an earlier attempt's transfer may still be mined");
    assert.notEqual(after.rpc_body, null, "the authorisation body is kept");
    assert.equal(after.lease_owner, null, "the lease is let go so the next attempt is not blocked");
    assert.ok(!String(after.verdict_reason).startsWith(`${CHAIN_SPENT}:`), "and it is not stopped either: the chain reads it unused");
  } finally {
    stub.restore();
    d1.close();
  }
});

test("H2 interleaving: unused read, rule-7 refusal, the transfer is mined later: the claim never reads `refused`, and the next attempt books it (the facilitator's cached success) or stops it", async () => {
  for (const second of ["settled", "refused"] as const) {
    const d1 = createLocalD1();
    let chainUsed = false;
    const stub = stubFacilitator({ settle: () => (second === "settled" && chainUsed ? settledAnswer() : refusedAnswer()), rpc: (url, n, init) => chainRpc(() => chainUsed)(url, n, init) });
    try {
      const { key, row } = await leasedPending(d1);
      const first = await attemptPending(eq(d1), row, "R");
      assert.equal(first.kind, "unchanged");
      assert.equal(claimDetail(d1).state, "pending");
      chainUsed = true; // the earlier attempt's broadcast transfer is mined
      const row2 = (await acquireLease(eq(d1), key, "R2", Date.now())) as ClaimRow;
      assert.ok(row2, "R2 holds the lease");
      const next = await attemptPending(eq(d1), row2, "R2");
      if (second === "settled") {
        assert.equal(next.kind, "settled", JSON.stringify(next));
        assert.equal(claimDetail(d1).state, "settled_unbooked");
        assert.equal(claimDetail(d1).tx, TX);
      } else {
        assert.equal(next.kind, "stopped", JSON.stringify(next));
        assert.equal(claimDetail(d1).state, "pending");
      }
      assert.notEqual(claimDetail(d1).state, "refused", "at no point refused");
    } finally {
      stub.restore();
      d1.close();
    }
  }
});

test("H2: the same through the payer's re-send: the answer is the pending one (502, no accepts), not a 402 inviting a second signature", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator({ settle: (n) => (n === 1 ? pendingAnswer() : refusedAnswer()), rpc: chainRpc(false) });
  try {
    const header = paymentHeaderFor(TREASURY_ADDRESS, "1000000");
    assert.equal((await callWorker(patronReq("rent", header), eq(d1))).status, 502);
    const resend = await callWorker(patronReq("rent", header), eq(d1));
    const body = await json(resend);
    assert.equal(resend.status, 502, JSON.stringify(body));
    assert.equal(body.accepts, undefined, "no fresh payment requirements");
    assert.match(String(body.error), /Do not sign again/);
    assert.equal(claimDetail(d1).state, "pending");
  } finally {
    stub.restore();
    d1.close();
  }
});

test("H2: the reconciler counts the row unchanged (not resolved), and it resolves later through the expiry proof: the chain unused after validBefore + margin gives `expired`", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator({ settle: (n) => (n === 1 ? pendingAnswer() : refusedAnswer()), rpc: chainRpc(false) });
  try {
    const header = paymentHeaderFor(TREASURY_ADDRESS, "1000000");
    assert.equal((await callWorker(patronReq("rent", header), eq(d1)))?.status, 502);
    const first = await runReconciler(eq(d1));
    assert.equal(first.unchanged, 1, JSON.stringify(first));
    assert.equal(first.resolved, 0);
    assert.equal(claimDetail(d1).state, "pending");
    // time passes: validBefore + the margin is now in the past
    d1.raw.prepare("UPDATE settlement_claims SET valid_before = ?").run(NOW_S() - 10_000);
    d1.raw.prepare("UPDATE settlement_claims SET updated_at = 1").run();
    const second = await runReconciler(eq(d1));
    assert.equal(second.resolved, 1, JSON.stringify(second));
    assert.equal(claimDetail(d1).state, "expired");
  } finally {
    stub.restore();
    d1.close();
  }
});

test("H2 control: payAndSettle's FIRST /settle still honours a rule-7 refusal at once (402 with accepts, the claim refused)", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator({ settle: () => refusedAnswer() });
  try {
    const res = await callWorker(patronReq("rent", paymentHeaderFor(TREASURY_ADDRESS, "1000000")), eq(d1));
    const body = await json(res);
    assert.equal(res.status, 402, JSON.stringify(body));
    assert.ok(Array.isArray(body.accepts));
    assert.equal(claimDetail(d1).state, "refused");
  } finally {
    stub.restore();
    d1.close();
  }
});
