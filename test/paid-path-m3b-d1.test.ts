// Paid-path wave M3, the SECOND build (drafts/BRIEF-PAID-PATH-M3-2026-10-02.md, "Amendments after CODEX r2" and the sections it makes operative; commission
// drafts/BUILDER-COMMISSION-M3-SECOND-BUILD-2026-10-04.md): C4 option B (stamp and stop), H2 (a re-POST refusal never marks `refused`), H3 (a stranded listing_pay claim
// is never re-POSTed against a reservation that is not its own; a takeClaim that throws re-reads), M4 (the validBefore bound), C7 (the attention list), R2-1 (the first
// attempt's refusal is bound to its take time), R2-3 and R2-4. Real local D1 and the real Worker router; the facilitator and the Base RPCs are stubbed through
// globalThis.fetch. Every guard here was red-proofed with this file run alone (docs/CHECKPOINT-PAID-PATH-M3.md, "Second build").
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
  eventLines,
  json,
  patronReq,
  paymentHeaderFor,
  failInserts,
  dropTrigger,
  stubFacilitator,
  testEnv,
  type Env,
  type LocalD1,
} from "./helpers/settlement-harness.ts";
import {
  acquireLease,
  claimIdentity,
  claimKeyFromPayload,
  getClaim,
  keyOfRow,
  listingReservationState,
  markChainSpent,
  markRefused,
  noteUnknown,
  takeClaim,
  KEY_WHERE,
  keyArgs,
  type ClaimKey,
  type ClaimRoute,
  type ClaimRow,
  type ClaimSpec,
} from "../src/settlement-claims.ts";
import { RECONCILE_ROW_WORST_CASE, RECONCILE_SELECT_COST, runReconciler } from "../src/settlement-reconcile.ts";
import { attemptPending } from "../src/x402.ts";
import { finishPayListingBooking, handlePayListing } from "../src/listings.ts";
import { SocietyError } from "../src/society.ts";
import { ATTENTION_AGED_DAYS, ATTENTION_MARKER_CODES } from "../src/settlement-attention.ts";
import { ROUTES } from "../src/discovery.ts";

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
const theClaim = (d1: LocalD1) => {
  const rows = d1.raw.prepare("SELECT * FROM settlement_claims").all();
  assert.equal(rows.length, 1, "exactly one claim row");
  return rows[0] as unknown as ClaimRow;
};
const loadCitizen = (d1: LocalD1, id: number) =>
  d1.raw.prepare("SELECT id, handle, model, karma, created_at, last_seen_at FROM citizens WHERE id = ?").get(id) as { id: number; handle: string; model: string; karma: number; created_at: number; last_seen_at: number };

// A funded listing with a pinned reviewer wallet and the funder's signed header, sent through the real pay route.
async function payFixture(d1: LocalD1, opts: { validBefore?: string; env?: Env } = {}) {
  const funderId = insertCitizen(d1);
  const reviewerId = insertCitizen(d1);
  const wallet = "0x" + "0a".repeat(20);
  const pin = await declareTestWallet(d1, reviewerId, wallet);
  const listingId = insertListing(d1, { funder_citizen_id: funderId, bounty_cents: 1200 });
  const submissionId = insertSubmission(d1, { listing_id: listingId, citizen_id: reviewerId });
  const header = paymentHeaderFor(wallet, atomicFromCents(1200), opts.validBefore ? { validBefore: opts.validBefore } : {});
  const send = async () => {
    try {
      const r = await handlePayListing(
        new Request(`https://example.test/api/listing/${listingId}/pay`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-PAYMENT": header },
          body: JSON.stringify({ submission_id: submissionId, wallet_row_id: pin.id, wallet_row_hash: pin.hash }),
        }),
        opts.env ?? eq(d1),
        loadCitizen(d1, funderId),
        listingId,
      );
      return { status: r.status, body: (await r.json()) as Record<string, any> };
    } catch (e) {
      if (e instanceof SocietyError) return { status: e.status, body: { error: e.message, code: e.code } as Record<string, any> };
      throw e;
    }
  };
  const listing = () => d1.raw.prepare("SELECT status, paying_since, paying_wallet_row_id, paying_wallet_row_hash FROM listings WHERE id = ?").get(listingId) as { status: string; paying_since: number | null; paying_wallet_row_id: number | null; paying_wallet_row_hash: string | null };
  return { send, listing, listingId, submissionId, pin, wallet, header, funderId, reviewerId };
}

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


// ---------- R2-1 (HIGH, CODEX r2): the first attempt's refusal is bound to the take time ----------

// B (a second worker) acts on A's claim long after A's lease lapsed: it takes the lapsed lease, re-POSTs, meets an unknown outcome and clears the lease. B's clock is far
// ahead of A's so every write of B's moves updated_at (in production the lapse alone guarantees it: B can only act 180 s after A's take).
async function bTakesAndLosesTheClaim(d1: LocalD1): Promise<void> {
  const key = keyOfRow(theClaim(d1));
  const later = Date.now() + 400_000;
  assert.ok(await acquireLease(eq(d1), key, "B", later), "B took A's lapsed lease");
  await noteUnknown(eq(d1), key, "B: the re-POST's outcome was unknown", "B", later + 1);
  assert.equal(theClaim(d1).lease_owner, null, "B's unknown outcome cleared the lease");
}

test("R2-1: A's refusal lands after B acquired the lapsed lease, re-POSTed, met an unknown outcome and cleared the lease: A answers from the claim (pending, no 402, no accepts) and the claim is not refused", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator({
    settle: async () => {
      await bTakesAndLosesTheClaim(d1);
      return refusedAnswer();
    },
  });
  try {
    const res = await callWorker(patronReq("rent", paymentHeaderFor(TREASURY_ADDRESS, "1000000")), eq(d1));
    const body = await json(res);
    assert.notEqual(res.status, 402, JSON.stringify(body));
    assert.equal(body.accepts, undefined, "no fresh payment requirements: B's transfer may still mine");
    assert.equal(claimDetail(d1).state, "pending", "not refused");
    assert.notEqual(claimDetail(d1).rpc_body, null, "the body is kept for B's, or the reconciler's, next attempt");
  } finally {
    stub.restore();
    d1.close();
  }
});

test("R2-1 (pay listing): the same interleaving keeps the listing's reservation and answers from the claim", async () => {
  const d1 = createLocalD1();
  const fx = await payFixture(d1);
  const stub = stubFacilitator({
    settle: async () => {
      await bTakesAndLosesTheClaim(d1);
      return refusedAnswer();
    },
  });
  try {
    const res = await fx.send();
    assert.notEqual(res.status, 402, JSON.stringify(res.body));
    assert.equal(res.body.accepts, undefined);
    assert.equal(fx.listing().status, "paying", "the reservation is kept: the money may yet move under B's attempt");
    assert.notEqual(fx.listing().paying_since, null);
    assert.equal(claimDetail(d1).state, "pending");
  } finally {
    stub.restore();
    d1.close();
  }
});

test("R2-1: markRefused bound to a take time writes only while updated_at still equals it; unbound it behaves as before", async () => {
  const d1 = createLocalD1();
  try {
    const key = await seedClaim(d1, { route: "patron", intent: { line: "r21" }, updatedAt: 5_000 });
    assert.equal(await markRefused(eq(d1), key, "r", "A", Date.now(), undefined, 4_999), false, "another holder moved updated_at: nothing written");
    assert.equal(claimDetail(d1).state, "pending");
    assert.equal(await markRefused(eq(d1), key, "r", "A", Date.now(), undefined, 5_000), true, "updated_at is still the take time");
    assert.equal(claimDetail(d1).state, "refused");
    const other = await seedClaim(d1, { route: "patron", intent: { line: "r21 unbound" }, updatedAt: 6_000 });
    assert.equal(await markRefused(eq(d1), other, "r", "A", Date.now()), true, "unbound (every other caller): as before");
  } finally {
    d1.close();
  }
});


// ---------- M4: no bound on validBefore (CODEX r1 on the M3 brief) ----------

const nowSeconds = () => Math.floor(Date.now() / 1000);
const BOUND = 300 + 60; // PAYMENT_MAX_TIMEOUT_SECONDS + the skew allowance

test("M4: an authorisation whose validBefore is beyond now + 300 + 60 is refused FREE and BEFORE /verify: 402 with accepts naming the bound; nothing is claimed or reserved", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator();
  try {
    const far = String(nowSeconds() + BOUND + 5);
    const res = await callWorker(patronReq("rent", paymentHeaderFor(TREASURY_ADDRESS, "1000000", { validBefore: far })), eq(d1));
    const body = await json(res);
    assert.equal(res.status, 402, JSON.stringify(body));
    assert.ok(Array.isArray(body.accepts), "a fresh signature with a proper window is the honest invitation: nothing was charged");
    assert.equal(body.code, "payment_valid_before_too_far");
    assert.match(String(body.error), /validBefore/);
    assert.match(String(body.error), /360|300/, "the bound is named");
    assert.match(String(body.error), /Nothing was sent to the facilitator and nothing was charged/);
    assert.equal(stub.calls.verify, 0, "refused before /verify");
    assert.equal(stub.calls.settle, 0);
    assert.equal(count(d1, "settlement_claims"), 0, "no claim");
  } finally {
    stub.restore();
    d1.close();
  }
});

test("M4: just inside the bound is accepted (the 402 for the bound is not the only reason the request can fail); a validBefore in the past is still the facilitator's to judge", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator();
  try {
    const inside = await callWorker(patronReq("rent inside", paymentHeaderFor(TREASURY_ADDRESS, "1000000", { validBefore: String(nowSeconds() + BOUND - 5) })), eq(d1));
    assert.equal(inside.status, 200, JSON.stringify(await inside.clone().json()));
    const past = await callWorker(patronReq("rent past", paymentHeaderFor(TREASURY_ADDRESS, "1000000", { validBefore: String(nowSeconds() - 100_000) })), eq(d1));
    assert.notEqual((await json(past)).code, "payment_valid_before_too_far", "the bound is an upper bound only");
    assert.ok(stub.calls.verify >= 2, "both reached /verify");
  } finally {
    stub.restore();
    d1.close();
  }
});

test("M4 (pay listing): the same refusal, and the listing is not reserved", async () => {
  const d1 = createLocalD1();
  const fx = await payFixture(d1, { validBefore: String(nowSeconds() + BOUND + 5) });
  const stub = stubFacilitator();
  try {
    const res = await fx.send();
    assert.equal(res.status, 402, JSON.stringify(res.body));
    assert.equal(res.body.code, "payment_valid_before_too_far");
    assert.equal(stub.calls.verify, 0);
    assert.equal(fx.listing().status, "open", "never reserved");
    assert.equal(count(d1, "settlement_claims"), 0);
  } finally {
    stub.restore();
    d1.close();
  }
});


// ---------- H3 (a): a takeClaim that THROWS re-reads the claim (gate MEDIUM-1) ----------

const UNWRAP = Symbol("unwrap");
// An Env whose INSERT into settlement_claims COMMITS and then throws (D1 committed and still reported an error). With `readBackThrows`, every later read of the claim table throws too,
// so the re-read cannot tell whether the row exists.
function claimInsertCommitsThenThrowsEnv(d1: LocalD1, opts: { readBackThrows?: boolean; afterCommit?: () => void } = {}): Env {
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
            opts.afterCommit?.();
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
  const DB = {
    prepare: (sql: string) => wrap(real.prepare(sql), sql),
    batch: (stmts: any[]) => real.batch(stmts.map((x) => x[UNWRAP] ?? x)),
  };
  return { ...testEnv(d1), DB } as unknown as Env;
}

test("H3/MEDIUM-1 (pay listing): the claim INSERT commits and then throws: the reservation is KEPT, nothing is sent to /settle, and the answer is not a 'try again' 503 (the claim exists; do not sign again)", async () => {
  const d1 = createLocalD1();
  const fx = await payFixture(d1, { env: claimInsertCommitsThenThrowsEnv(d1) });
  const stub = stubFacilitator();
  try {
    const { value: res, lines } = await captureLog(() => fx.send());
    assert.notEqual(res.status, 503, JSON.stringify(res.body));
    assert.equal(res.status, 502, JSON.stringify(res.body));
    const text = String(res.body.error);
    assert.match(text, /nothing was sent to the facilitator's \/settle/i);
    assert.match(text, /Do not sign again/);
    assert.doesNotMatch(text, /Try again later|has not been used|Nothing was reserved or created/i, "the claim exists and the listing is reserved: neither sentence is true");
    assert.equal(fx.listing().status, "paying", "the reservation is kept: releasing it would re-open the listing under a claim a re-send could settle");
    assert.notEqual(fx.listing().paying_since, null);
    assert.equal(stub.calls.settle, 0, "no /settle was sent");
    const claim = claimDetail(d1);
    assert.equal(claim.state, "pending");
    assert.equal(claim.lease_owner, null, "this request let go of its own lease, so the reconciler or a re-send is not told to wait for it");
    assert.notEqual(claim.rpc_body, null);
    assert.equal(eventLines(lines, "settlement_claim_not_taken").length, 1, "the failure is still logged once");
  } finally {
    stub.restore();
    d1.close();
  }
});

// CODEX second-build r1 HIGH: the INSERT commits, but its error arrives after the lease lapsed and B took the claim (a re-send or the
// reconciler, mid /settle). A's re-read then sees B as lease_owner. The claim is still THIS payment's (same route, same request), so A
// must keep the reservation: releasing it would re-open the listing while B's settlement is in flight. Red when "ours" is judged by
// the mutable lease_owner alone (the listing reads 'open').
test("H3/MEDIUM-1 (pay listing, CODEX r1 HIGH): the INSERT commits, the error arrives after B took the lapsed lease: the reservation is KEPT, B's lease untouched", async () => {
  const d1 = createLocalD1();
  const takeOver = () => {
    d1.raw.prepare(`UPDATE settlement_claims SET lease_owner = 'B', leased_until = ${Date.now() + 60_000}`).run();
  };
  const fx = await payFixture(d1, { env: claimInsertCommitsThenThrowsEnv(d1, { afterCommit: takeOver }) });
  const stub = stubFacilitator();
  try {
    const res = await fx.send();
    assert.notEqual(res.status, 402, JSON.stringify(res.body));
    assert.equal(res.body.accepts, undefined, "no fresh payment requirements");
    assert.doesNotMatch(String(res.body.error), /Try again later|has not been used/i);
    assert.equal(fx.listing().status, "paying", "the reservation is kept while B may settle this payment");
    const claim = claimDetail(d1);
    assert.equal(claim.state, "pending");
    assert.equal(claim.lease_owner, "B", "A does not touch B's lease");
    assert.equal(stub.calls.settle, 0, "A sent nothing to /settle");
  } finally {
    stub.restore();
    d1.close();
  }
});

test("H3/MEDIUM-1 (pay listing): the INSERT commits, throws, and the re-read throws too: the society cannot tell whether a claim exists, so the reservation is KEPT and the answer says so", async () => {
  const d1 = createLocalD1();
  const fx = await payFixture(d1, { env: claimInsertCommitsThenThrowsEnv(d1, { readBackThrows: true }) });
  const stub = stubFacilitator();
  try {
    const res = await fx.send();
    assert.equal(res.status, 503, JSON.stringify(res.body));
    assert.equal(res.body.code, "settlement_claim_unavailable");
    const text = String(res.body.error);
    assert.match(text, /nothing was sent to the facilitator's \/settle/i);
    assert.match(text, /could not (tell|confirm)/i);
    assert.match(text, /Do not sign again/);
    assert.doesNotMatch(text, /Nothing was reserved or created|Try again later|has not been used/i);
    assert.equal(fx.listing().status, "paying", "fail closed: only a proven absence of the row may release");
    assert.equal(stub.calls.settle, 0);
  } finally {
    stub.restore();
    d1.close();
  }
});

test("H3/MEDIUM-1 (patron): the INSERT commits and throws: the answer says the claim exists and nothing was sent; the payer's identical re-send then completes the payment once", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator({ rpc: chainRpc(false) });
  try {
    const header = paymentHeaderFor(TREASURY_ADDRESS, "1000000");
    const first = await callWorker(patronReq("rent", header), claimInsertCommitsThenThrowsEnv(d1));
    const body = await json(first);
    assert.equal(first.status, 502, JSON.stringify(body));
    assert.match(String(body.error), /nothing was sent to the facilitator's \/settle/i);
    assert.match(String(body.error), /Repeating this identical request re-checks it sooner/, "for a route with no reservation a re-send really does re-check it");
    assert.equal(stub.calls.settle, 0);
    assert.equal(claimDetail(d1).state, "pending");
    const resend = await callWorker(patronReq("rent", header), eq(d1));
    assert.equal(resend.status, 200, JSON.stringify(await resend.clone().json()));
    assert.equal(stub.calls.settle, 1, "settled exactly once");
    assert.equal(claimDetail(d1).state, "booked");
  } finally {
    stub.restore();
    d1.close();
  }
});

test("H3/MEDIUM-1 control: an INSERT that throws WITHOUT committing (no row) still releases the reservation and says nothing was created (the existing L1 answer)", async () => {
  const d1 = createLocalD1();
  const fx = await payFixture(d1);
  const stub = stubFacilitator();
  try {
    failInserts(d1, "no_claims_m3b", "settlement_claims", null, "disk I/O error (test)");
    const res = await fx.send();
    assert.equal(res.status, 503, JSON.stringify(res.body));
    assert.equal(res.body.code, "settlement_claim_unavailable");
    assert.match(String(res.body.error), /Nothing was reserved or created by this request/);
    assert.equal(fx.listing().status, "open", "no row: the reservation is released");
    dropTrigger(d1, "no_claims_m3b");
  } finally {
    stub.restore();
    d1.close();
  }
});

// ---------- H3 (b): a stranded pending listing_pay claim is never re-POSTed against a reservation that is not its own ----------

// A pay-listing claim left PENDING by an unknown first outcome, its reservation held.
async function pendingPayClaim(d1: LocalD1) {
  const fx = await payFixture(d1);
  const res = await fx.send();
  assert.equal(res.status, 502, JSON.stringify(res.body));
  assert.equal(fx.listing().status, "paying");
  assert.equal(claimDetail(d1).state, "pending");
  return fx;
}
const reopen = (d1: LocalD1, listingId: number) =>
  d1.raw.prepare("UPDATE listings SET status = 'open', paying_since = NULL, paying_wallet_row_id = NULL, paying_wallet_row_hash = NULL WHERE id = ?").run(listingId);
// Another payer reserves the re-opened listing LATER (same pinned wallet row: it is still the payee's newest).
const rereserve = (d1: LocalD1, listingId: number, pin: { id: number; hash: string }, since: number) =>
  d1.raw.prepare("UPDATE listings SET status = 'paying', paying_since = ?, paying_wallet_row_id = ?, paying_wallet_row_hash = ? WHERE id = ?").run(since, pin.id, pin.hash, listingId);

for (const scenario of ["the listing was re-opened", "a replacement reservation holds it"] as const) {
  test(`H3: an old pending claim and ${scenario}: the chain unused, a re-send and the reconciler make NO /settle call and the claim stays pending`, async () => {
    const d1 = createLocalD1();
    const stub = stubFacilitator({ settle: (n) => (n === 1 ? pendingAnswer() : settledAnswer()), rpc: chainRpc(false) });
    try {
      const fx = await pendingPayClaim(d1);
      const claim = theClaim(d1);
      reopen(d1, fx.listingId);
      if (scenario !== "the listing was re-opened") rereserve(d1, fx.listingId, fx.pin, claim.created_at + 60_000);
      const listingBefore = fx.listing();
      assert.equal(stub.calls.settle, 1);

      const resend = await fx.send();
      assert.equal(stub.calls.settle, 1, "the funder's identical re-send re-POSTed nothing");
      if (scenario === "the listing was re-opened") assert.equal(resend.status, 502, JSON.stringify(resend.body));
      assert.equal(resend.body.accepts, undefined);

      const out = await runReconciler(eq(d1));
      assert.equal(stub.calls.settle, 1, "and neither did the reconciler");
      assert.equal(out.unchanged, 1, JSON.stringify(out));
      assert.equal(claimDetail(d1).state, "pending");
      assert.notEqual(claimDetail(d1).rpc_body, null);
      assert.deepEqual(fx.listing(), listingBefore, "the listing (and a replacement payer's reservation) is untouched");
      assert.equal(count(d1, "listing_payments"), 0);
    } finally {
      stub.restore();
      d1.close();
    }
  });

  test(`H3: ${scenario}, and the chain reads the authorisation USED: the claim is stamped and stopped for a person; still no /settle call`, async () => {
    const d1 = createLocalD1();
    const stub = stubFacilitator({ settle: (n) => (n === 1 ? pendingAnswer() : settledAnswer()), rpc: chainRpc(true) });
    try {
      const fx = await pendingPayClaim(d1);
      const claim = theClaim(d1);
      reopen(d1, fx.listingId);
      if (scenario !== "the listing was re-opened") rereserve(d1, fx.listingId, fx.pin, claim.created_at + 60_000);
      const out = await runReconciler(eq(d1));
      assert.equal(out.stopped, 1, JSON.stringify(out));
      assert.equal(stub.calls.settle, 1, "no /settle: the chain says the money moved, and the listing is not this claim's");
      assert.ok(String(claimDetail(d1).verdict_reason).startsWith(`${CHAIN_SPENT}:`));
      assert.equal(claimDetail(d1).state, "pending");
    } finally {
      stub.restore();
      d1.close();
    }
  });
}

test("H3 control: a pending claim that still holds ITS OWN reservation is re-POSTed and booked as before", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator({ settle: (n) => (n === 1 ? pendingAnswer() : settledAnswer()), rpc: chainRpc(false) });
  try {
    const fx = await pendingPayClaim(d1);
    const out = await runReconciler(eq(d1));
    assert.equal(stub.calls.settle, 2);
    assert.equal(out.booked, 1, JSON.stringify(out));
    assert.equal(fx.listing().status, "paid");
    assert.equal(count(d1, "listing_payments"), 1);
  } finally {
    stub.restore();
    d1.close();
  }
});

test("H3: listingReservationState: bound only for the claim's own reservation (status, pin id and hash, and paying_since no later than the claim's creation)", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator({ settle: () => pendingAnswer() });
  try {
    const fx = await pendingPayClaim(d1);
    const row = theClaim(d1);
    assert.deepEqual(await listingReservationState(eq(d1), row), { status: "paying", bound: true });
    d1.raw.prepare("UPDATE listings SET paying_since = ? WHERE id = ?").run(row.created_at + 1, fx.listingId);
    assert.equal((await listingReservationState(eq(d1), row)).bound, false, "reserved later than the claim was created: another payer's");
    d1.raw.prepare("UPDATE listings SET paying_since = ? WHERE id = ?").run(row.created_at, fx.listingId);
    assert.equal((await listingReservationState(eq(d1), row)).bound, true, "the same instant is still the claim's own");
    d1.raw.prepare("UPDATE listings SET paying_wallet_row_hash = 'other' WHERE id = ?").run(fx.listingId);
    assert.equal((await listingReservationState(eq(d1), row)).bound, false, "another pinned wallet row");
    d1.raw.prepare("UPDATE listings SET paying_wallet_row_hash = ?, paying_wallet_row_id = paying_wallet_row_id + 1 WHERE id = ?").run(fx.pin.hash, fx.listingId);
    assert.equal((await listingReservationState(eq(d1), row)).bound, false, "another pinned wallet row id");
    reopen(d1, fx.listingId);
    assert.deepEqual(await listingReservationState(eq(d1), row), { status: "open", bound: false });
    const ghost = { ...row, intent_json: JSON.stringify({ ...JSON.parse(row.intent_json), listing_id: 999_999 }) };
    assert.deepEqual(await listingReservationState(eq(d1), ghost), { status: null, bound: false }, "no such listing");
  } finally {
    stub.restore();
    d1.close();
  }
});

// ---------- H3 (c): the booking is bound to the same reservation (the booking-reservation-binding deferral, discharged) ----------

// A settled bounty payment whose booking failed once (so the claim is settled_unbooked and the reservation held).
async function settledUnbookedPayClaim(d1: LocalD1) {
  const fx = await payFixture(d1);
  failInserts(d1, "m3b_fail_payment", "listing_payments", null, "disk I/O error (test)");
  const first = await fx.send();
  assert.equal(first.status, 500, JSON.stringify(first.body));
  dropTrigger(d1, "m3b_fail_payment");
  assert.equal(claimDetail(d1).state, "settled_unbooked");
  assert.equal(fx.listing().status, "paying");
  return fx;
}

test("H3: a settled_unbooked claim is NEVER booked against a later payer's reservation: the booking INSERT is gated on the claim's own reservation, nothing is written, the listing stays that payer's", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator();
  try {
    const fx = await settledUnbookedPayClaim(d1);
    const row = theClaim(d1);
    reopen(d1, fx.listingId);
    rereserve(d1, fx.listingId, fx.pin, row.created_at + 60_000);
    const laterReservation = fx.listing();
    await assert.rejects(() => finishPayListingBooking(eq(d1), row, "O"), /nothing was recorded|recording|no longer/i);
    assert.equal(count(d1, "listing_payments"), 0, "no payment row was written against the later reservation");
    assert.deepEqual(fx.listing(), laterReservation, "the later payer's reservation is untouched, not marked paid");
    assert.equal(claimDetail(d1).state, "settled_unbooked");
  } finally {
    stub.restore();
    d1.close();
  }
});

test("H3: C5's check uses the same binding: the reconciler sets a claim aside (listing_not_paying) when the listing is held by a replacement reservation, rather than handing it to the booking", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator();
  try {
    const fx = await settledUnbookedPayClaim(d1);
    const row = theClaim(d1);
    reopen(d1, fx.listingId);
    rereserve(d1, fx.listingId, fx.pin, row.created_at + 60_000);
    const { value: out, lines } = await captureLog(() => runReconciler(eq(d1)));
    assert.equal(out.unchanged, 1, JSON.stringify(out));
    assert.equal(out.failed, 0, "it did not try (and fail) to book it");
    assert.equal(out.booked, 0);
    assert.equal(eventLines(lines, "settlement_listing_not_paying").length, 1);
    assert.equal(claimDetail(d1).verdict_reason, "listing_not_paying");
    assert.equal(count(d1, "listing_payments"), 0);
  } finally {
    stub.restore();
    d1.close();
  }
});

test("H3 control: the booking still completes against the claim's OWN reservation (the reconciler books it after a transient booking failure)", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator();
  try {
    const fx = await settledUnbookedPayClaim(d1);
    const out = await runReconciler(eq(d1));
    assert.equal(out.booked, 1, JSON.stringify(out));
    assert.equal(fx.listing().status, "paid");
    assert.equal(count(d1, "listing_payments"), 1);
  } finally {
    stub.restore();
    d1.close();
  }
});

// ---------- gate LOW-2: the booking-failure 500 must not promise a reconciler pass that will not happen ----------

test("LOW-2: the 500 for a payment that settled but whose listing no longer holds the reservation does NOT promise the reconciler's daily pass (it will set the claim aside); a transient failure with the reservation intact still does", async () => {
  // (a) the operator releases the reservation while the settle is in flight: the booking cannot happen
  {
    const d1 = createLocalD1();
    const fxRef: { fx?: Awaited<ReturnType<typeof payFixture>> } = {};
    const stub = stubFacilitator({
      settle: () => {
        reopen(d1, fxRef.fx!.listingId);
        return settledAnswer();
      },
    });
    try {
      const fx = await payFixture(d1);
      fxRef.fx = fx;
      const res = await fx.send();
      assert.equal(res.status, 500, JSON.stringify(res.body));
      const text = String(res.body.error);
      assert.match(text, new RegExp(TX));
      assert.match(text, /no longer (awaiting|holds)/i);
      assert.match(text, /set it aside/i);
      assert.match(text, /Do not sign again/);
      assert.doesNotMatch(text, /one pass a day|06:00|can wait more than one day|re-checks it sooner|works a limited number/i, "no promise that the reconciler will book it");
    } finally {
      stub.restore();
      d1.close();
    }
  }
  // (b) a transient failure with the reservation intact: the reconciler WILL book it, and the text may say so
  {
    const d1 = createLocalD1();
    const stub = stubFacilitator();
    try {
      const fx = await payFixture(d1);
      failInserts(d1, "m3b_fail_payment2", "listing_payments", null, "disk I/O error (test)");
      const res = await fx.send();
      assert.equal(res.status, 500, JSON.stringify(res.body));
      assert.match(String(res.body.error), /one pass a day/);
    } finally {
      stub.restore();
      d1.close();
    }
  }
});


// ---------- C7: GET /api/settlements/attention, the claims a person must look at ----------

const DAY_MS = 86_400_000;
const attentionReq = () => new Request("https://example.test/api/settlements/attention");
const SENTINEL_HANDLE = "sentinel-handle-7f3a";
const getAttention = async (d1: LocalD1) => {
  const res = await callWorker(attentionReq(), eq(d1));
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) as Record<string, any> };
};

// A claim seeded directly, then put into the exact state a marker reads. `intent` carries a sentinel so a test can prove no intent text is served.
async function seedMarked(
  d1: LocalD1,
  o: { route: ClaimRoute; state: "pending" | "settled_unbooked" | "refused" | "expired" | "booked"; reason?: string | null; tx?: string | null; ageMs?: number },
): Promise<ClaimKey> {
  const key = await seedClaim(d1, { route: o.route, intent: { line: "c7", handle: SENTINEL_HANDLE, public_key: null, listing_id: 1, amount_cents: 1200 }, createdAt: Date.now() - (o.ageMs ?? 1000) });
  d1.raw
    .prepare(`UPDATE settlement_claims SET state = ?, tx = ?, payer = ?, verdict_reason = ?, rpc_body = ${o.state === "refused" || o.state === "expired" || o.state === "booked" ? "NULL" : "rpc_body"} WHERE ${KEY_WHERE}`)
    .run(o.state, o.tx ?? null, o.tx ? TEST_PAYER : null, o.reason ?? null, ...(keyArgs(key) as never[]));
  return key;
}

test("C7: each marker appears for the rows that carry it, and only those: contradiction, chain-spent (stopped), listing_not_paying, handle taken, and the two aged markers", async () => {
  const d1 = createLocalD1();
  try {
    const old = ATTENTION_AGED_DAYS * DAY_MS + 60_000;
    await seedMarked(d1, { route: "patron", state: "refused", reason: `settlement_contradiction:${TX}|${REFUSAL_SENTINEL}`, tx: TX });
    await seedMarked(d1, { route: "register", state: "expired", reason: `settlement_contradiction:${TX}|x`, tx: TX });
    await seedMarked(d1, { route: "patron", state: "pending", reason: `${CHAIN_SPENT}:${REFUSAL_SENTINEL}` });
    await seedMarked(d1, { route: "listing_pay", state: "settled_unbooked", reason: "listing_not_paying", tx: TX });
    await seedMarked(d1, { route: "register", state: "settled_unbooked", reason: "handle_taken", tx: TX });
    await seedMarked(d1, { route: "listing_create", state: "settled_unbooked", reason: null, tx: TX, ageMs: old });
    await seedMarked(d1, { route: "patron", state: "pending", reason: "the facilitator's last words", ageMs: old });
    // rows that must NOT be listed
    await seedMarked(d1, { route: "patron", state: "pending", reason: "the facilitator's last words" }); // young pending
    await seedMarked(d1, { route: "patron", state: "settled_unbooked", reason: null, tx: TX }); // young settled_unbooked
    await seedMarked(d1, { route: "patron", state: "booked", reason: null, tx: TX, ageMs: old }); // booked, however old
    await seedMarked(d1, { route: "patron", state: "refused", reason: "an ordinary refusal", ageMs: old }); // unstamped refused
    await seedMarked(d1, { route: "patron", state: "expired", reason: "authorisation expired unused", ageMs: old }); // unstamped expired

    const { status, body } = await getAttention(d1);
    assert.equal(status, 200, JSON.stringify(body));
    const markers = (body.entries as { marker: string }[]).map((e) => e.marker).sort();
    assert.deepEqual(markers, [
      "chain_spent_facilitator_refused",
      "listing_not_paying",
      "pending_aged",
      "registration_handle_taken",
      "settled_unbooked_aged",
      "settlement_contradiction",
      "settlement_contradiction",
    ]);
    assert.equal(body.count, 7);
    assert.equal(body.entries.length, 7);
    for (const e of body.entries as Record<string, unknown>[]) {
      assert.deepEqual(Object.keys(e).sort(), ["created_at", "marker", "nonce", "route", "state", "tx", "updated_at"], "exactly the served fields");
    }
    const byMarker = (m: string) => (body.entries as Record<string, any>[]).filter((e) => e.marker === m);
    assert.equal(byMarker("chain_spent_facilitator_refused")[0].state, "pending");
    assert.equal(byMarker("chain_spent_facilitator_refused")[0].tx, null, "tx is null when none is known");
    assert.equal(byMarker("settlement_contradiction")[0].tx, TX, "tx when known");
    assert.equal(byMarker("registration_handle_taken")[0].state, "settled_unbooked");
    assert.ok(typeof byMarker("listing_not_paying")[0].nonce === "string" && /^0x[0-9a-f]{64}$/.test(byMarker("listing_not_paying")[0].nonce));
  } finally {
    d1.close();
  }
});

test("C7: the whole response carries none of rpc_body, intent_json, from_addr, payer, verdict_reason, any raw verdict text, the payer's address or an intent's handle", async () => {
  const d1 = createLocalD1();
  try {
    const old = ATTENTION_AGED_DAYS * DAY_MS + 60_000;
    await seedMarked(d1, { route: "patron", state: "refused", reason: `settlement_contradiction:${TX}|${REFUSAL_SENTINEL}`, tx: TX });
    await seedMarked(d1, { route: "register", state: "pending", reason: `${CHAIN_SPENT}:${REFUSAL_SENTINEL}` });
    await seedMarked(d1, { route: "listing_pay", state: "settled_unbooked", reason: "listing_not_paying", tx: TX });
    await seedMarked(d1, { route: "register", state: "settled_unbooked", reason: "handle_taken", tx: TX });
    await seedMarked(d1, { route: "patron", state: "pending", reason: REFUSAL_SENTINEL, ageMs: old });
    const { status, text, body } = await getAttention(d1);
    assert.equal(status, 200);
    assert.equal(body.count, 5);
    for (const forbidden of ["rpc_body", "intent_json", "from_addr", "payer", "verdict_reason", REFUSAL_SENTINEL, TEST_PAYER, TEST_PAYER.toLowerCase(), SENTINEL_HANDLE, "paymentPayload", "signature", "commonhold_sk_"]) {
      assert.ok(!text.toLowerCase().includes(forbidden.toLowerCase()), `the response must not contain ${forbidden}`);
    }
    for (const e of body.entries as { marker: string }[]) {
      assert.ok(ATTENTION_MARKER_CODES.includes(e.marker), `marker ${e.marker} is from the fixed allowlist`);
    }
  } finally {
    d1.close();
  }
});

test("C7: one marker per row, the specific marker beats the age marker, and the age line is exactly ATTENTION_AGED_DAYS", async () => {
  const d1 = createLocalD1();
  try {
    const old = ATTENTION_AGED_DAYS * DAY_MS + 60_000;
    await seedMarked(d1, { route: "register", state: "settled_unbooked", reason: "handle_taken", tx: TX, ageMs: old }); // both handle_taken and aged: one entry, the specific marker
    await seedMarked(d1, { route: "patron", state: "pending", reason: `${CHAIN_SPENT}:x`, ageMs: old }); // both stopped and aged: the specific marker
    await seedMarked(d1, { route: "patron", state: "settled_unbooked", reason: null, tx: TX, ageMs: ATTENTION_AGED_DAYS * DAY_MS - 60_000 }); // just inside the line: not listed
    await seedMarked(d1, { route: "patron", state: "settled_unbooked", reason: null, tx: TX, ageMs: ATTENTION_AGED_DAYS * DAY_MS + 60_000 }); // just past it: listed
    const { body } = await getAttention(d1);
    assert.deepEqual((body.entries as { marker: string }[]).map((e) => e.marker).sort(), ["chain_spent_facilitator_refused", "registration_handle_taken", "settled_unbooked_aged"]);
    assert.equal(body.aged_after_days, ATTENTION_AGED_DAYS);
  } finally {
    d1.close();
  }
});

test("C7: the served note says what each marker means, that the list is the maintainer's queue, and promises no resolution time", async () => {
  const d1 = createLocalD1();
  try {
    const { body, text } = await getAttention(d1);
    assert.equal(body.count, 0);
    assert.deepEqual(body.entries, []);
    assert.match(String(body.note), /maintainer/i);
    assert.match(String(body.note), /no resolution time is promised/i);
    assert.doesNotMatch(text, /within \d+ (hours|days)|by tomorrow|guarantee/i, "no promised time");
    assert.deepEqual(Object.keys(body.markers).sort(), [...ATTENTION_MARKER_CODES].sort(), "every marker in the allowlist is explained, and only those");
    for (const [code, meaning] of Object.entries(body.markers as Record<string, string>)) assert.ok(String(meaning).length > 40, `${code} has a real explanation`);
    assert.doesNotMatch(text, /—/, "no em dashes in served text");
  } finally {
    d1.close();
  }
});

test("C7: /api/official carries a count beside the payments book, equal to the number of rows the list returns", async () => {
  const d1 = createLocalD1();
  try {
    const before = (await (await callWorker(new Request("https://example.test/api/official"), eq(d1))).json()) as { economy: Record<string, any> };
    assert.equal(before.economy.settlements_awaiting_a_person, 0);
    assert.equal(before.economy.settlements_attention, "GET /api/settlements/attention");
    assert.equal(before.economy.payments_book, "GET /api/listings/payments");
    await seedMarked(d1, { route: "patron", state: "pending", reason: `${CHAIN_SPENT}:x` });
    await seedMarked(d1, { route: "listing_pay", state: "settled_unbooked", reason: "listing_not_paying", tx: TX });
    const after = (await (await callWorker(new Request("https://example.test/api/official"), eq(d1))).json()) as { economy: Record<string, any> };
    const list = await getAttention(d1);
    assert.equal(after.economy.settlements_awaiting_a_person, 2);
    assert.equal(after.economy.settlements_awaiting_a_person, list.body.entries.length);
  } finally {
    d1.close();
  }
});

test("C7: the route is in the discovery ROUTES (public, no auth) and the stopped-row answer points at it", async () => {
  const route = ROUTES.find((r) => r.method === "GET" && r.path === "/api/settlements/attention");
  assert.ok(route, "listed in discovery ROUTES");
  assert.equal(route!.auth, "none");
  assert.notEqual(route!.grepFor, undefined, "wired into index.ts (carries a grepFor the drift guard checks)");
  const d1 = createLocalD1();
  const stub = stubFacilitator({ settle: (n) => (n === 1 ? pendingAnswer() : refusedAnswer()), rpc: chainRpc(true) });
  try {
    const header = paymentHeaderFor(TREASURY_ADDRESS, "1000000");
    assert.equal((await callWorker(patronReq("rent", header), eq(d1))).status, 502);
    const resend = await callWorker(patronReq("rent", header), eq(d1));
    assert.match(String((await json(resend)).error), /GET \/api\/settlements\/attention/);
  } finally {
    stub.restore();
    d1.close();
  }
});


// The measured cost of ONE row (D1 statements plus RPC and /settle fetches, the select taken off), on the worst RPC day (the plain read's quorum takes four attempts). The ceiling for a row is
// RECONCILE_ROW_WORST_CASE = 18; none of these needs it raised. Itemised: (a) lease 1 + 4 RPC + reservation read 1 + /settle 1 + markSettled 1 + C5 read 1 + booking batch 3 + read-back 1 = 13;
// (b) lease 1 + 4 + read 1 + stamp 1 = 7; (c) lease 1 + 4 + read 1 + /settle 1 + stamp 1 = 8; (d) lease 1 + 4 + read 1 + /settle 1 + noteUnknown 1 + release 1 = 9; (e) lease 1 + read 1 + mark 1 = 3;
// (f) lease 1 + 4 + /settle 1 + stamp 1 = 7; (g) a row that threw is priced at its statements (lease, read, markSettled, release = 4) plus ATTEMPT_FETCH_WORST_CASE (12) = 16.
const EXPECTED_ROW_COSTS: Record<string, number> = {
  "pay listing: pending, bound, re-POST settles, booked": 13,
  "pay listing: pending, unbound, chain used, stamped": 7,
  "pay listing: pending, bound, chain used, refusal, stamped": 8,
  "pay listing: pending, bound, chain unused, refusal (H2), noted": 9,
  "pay listing: settled_unbooked, listing not the claim's, set aside": 3,
  "patron: pending, chain used, refusal, stamped": 7,
  "pay listing: pending, bound, markSettled throws, priced at the fetch worst case": 16,
};

// ---------- R2-4 (and M4's re-measure): the reconciler's per-row worst case under option B, measured through the real reconciler ----------

// The cost the reconciler measured for the ONE row it worked (its meter counts every D1 statement, a batch's statements each, and every RPC and /settle fetch the attempt reports);
// the select that finds the row is the reconciler's own fixed cost and is taken off.
// Every even-numbered RPC fetch fails and every odd-numbered one answers: the quorum of two successful RPCs then takes FOUR attempts (src/settlement-chain.ts), the plain read's worst case.
const worstRpc = (used: boolean) => (url: string, n: number, init?: RequestInit) => (n % 2 === 0 ? null : chainRpc(used)(url, n, init));

async function rowCost(d1: LocalD1): Promise<{ cost: number; out: Awaited<ReturnType<typeof runReconciler>> }> {
  const out = await runReconciler(eq(d1));
  assert.equal(out.examined, 1, JSON.stringify(out));
  return { cost: out.actualCost - RECONCILE_SELECT_COST, out };
}

test("R2-4: every row shape the second build adds stays inside RECONCILE_ROW_WORST_CASE, and the measured costs are pinned so a statement added later is noticed", async () => {
  const measured: Record<string, number> = {};

  // (a) a pending listing_pay claim through the new reservation read, the re-POST, markSettled, C5's read and the booking batch
  {
    const d1 = createLocalD1();
    const stub = stubFacilitator({ settle: (n) => (n === 1 ? pendingAnswer() : settledAnswer()), rpc: worstRpc(false) });
    try {
      await pendingPayClaim(d1);
      const { cost, out } = await rowCost(d1);
      assert.equal(out.booked, 1, JSON.stringify(out));
      measured["pay listing: pending, bound, re-POST settles, booked"] = cost;
    } finally {
      stub.restore();
      d1.close();
    }
  }
  // (b) the same claim, unbound, chain used: the read, the stamp, nothing else
  {
    const d1 = createLocalD1();
    const stub = stubFacilitator({ settle: () => pendingAnswer(), rpc: worstRpc(true) });
    try {
      const fx = await pendingPayClaim(d1);
      reopen(d1, fx.listingId);
      const { cost, out } = await rowCost(d1);
      assert.equal(out.stopped, 1, JSON.stringify(out));
      measured["pay listing: pending, unbound, chain used, stamped"] = cost;
    } finally {
      stub.restore();
      d1.close();
    }
  }
  // (c) bound, chain used, the facilitator answers a recorded refusal: the stamp
  {
    const d1 = createLocalD1();
    const stub = stubFacilitator({ settle: (n) => (n === 1 ? pendingAnswer() : refusedAnswer()), rpc: worstRpc(true) });
    try {
      await pendingPayClaim(d1);
      const { cost, out } = await rowCost(d1);
      assert.equal(out.stopped, 1, JSON.stringify(out));
      measured["pay listing: pending, bound, chain used, refusal, stamped"] = cost;
    } finally {
      stub.restore();
      d1.close();
    }
  }
  // (d) bound, chain unused, the facilitator answers a refusal (H2): the last words are noted, the lease released
  {
    const d1 = createLocalD1();
    const stub = stubFacilitator({ settle: (n) => (n === 1 ? pendingAnswer() : refusedAnswer()), rpc: worstRpc(false) });
    try {
      await pendingPayClaim(d1);
      const { cost, out } = await rowCost(d1);
      assert.equal(out.unchanged, 1, JSON.stringify(out));
      measured["pay listing: pending, bound, chain unused, refusal (H2), noted"] = cost;
    } finally {
      stub.restore();
      d1.close();
    }
  }
  // (e) a settled_unbooked listing_pay claim whose listing is not the claim's: C5's read, the mark, nothing else
  {
    const d1 = createLocalD1();
    const stub = stubFacilitator();
    try {
      const fx = await settledUnbookedPayClaim(d1);
      reopen(d1, fx.listingId);
      const { cost, out } = await rowCost(d1);
      assert.equal(out.unchanged, 1, JSON.stringify(out));
      measured["pay listing: settled_unbooked, listing not the claim's, set aside"] = cost;
    } finally {
      stub.restore();
      d1.close();
    }
  }
  // (f) a pending patron claim stopped on a refusal with the chain used (no listing read at all)
  {
    const d1 = createLocalD1();
    const stub = stubFacilitator({ settle: (n) => (n === 1 ? pendingAnswer() : refusedAnswer()), rpc: worstRpc(true) });
    try {
      assert.equal((await callWorker(patronReq("rent", paymentHeaderFor(TREASURY_ADDRESS, "1000000")), eq(d1))).status, 502);
      const { cost, out } = await rowCost(d1);
      assert.equal(out.stopped, 1, JSON.stringify(out));
      measured["patron: pending, chain used, refusal, stamped"] = cost;
    } finally {
      stub.restore();
      d1.close();
    }
  }

  // (g) a pending listing_pay row whose markSettled THROWS after the re-POST: the reconciler prices a row that threw before reporting its fetches at the attempt's fetch worst case
  {
    const d1 = createLocalD1();
    const stub = stubFacilitator({ settle: (n) => (n === 1 ? pendingAnswer() : settledAnswer()), rpc: worstRpc(false) });
    try {
      await pendingPayClaim(d1);
      d1.raw.exec("CREATE TRIGGER m3b_settled_throws BEFORE UPDATE ON settlement_claims WHEN NEW.state = 'settled_unbooked' BEGIN SELECT RAISE(ABORT, 'disk I/O error (test)'); END;");
      const { cost, out } = await captureLog(() => rowCost(d1)).then((r) => r.value);
      assert.equal(out.failed, 1, JSON.stringify(out));
      measured["pay listing: pending, bound, markSettled throws, priced at the fetch worst case"] = cost;
    } finally {
      stub.restore();
      d1.close();
    }
  }

  for (const [name, cost] of Object.entries(measured)) assert.ok(cost <= RECONCILE_ROW_WORST_CASE, `${name}: ${cost} is inside RECONCILE_ROW_WORST_CASE (${RECONCILE_ROW_WORST_CASE})`);
  assert.deepEqual(measured, EXPECTED_ROW_COSTS, "the measured per-row costs (update EXPECTED_ROW_COSTS and the itemised note in settlement-reconcile.ts together)");
});
