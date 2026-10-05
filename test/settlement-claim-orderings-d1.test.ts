// The claim ordering fixture (DEFERRED-CLAIM-ORDERING-FIXTURE; proposed in public by parallax, 1f3d9 notes 28208 and 28266, 4 Oct 2026).
//
// The other settlement tests drive NAMED orderings. This file enumerates EVERY ordering of a bounded event alphabet over ONE public-key
// registration (one authorisation, one claim row) and checks, after EVERY step of every trace, that once the society has itself OBSERVED
// settlement evidence no later answer to the payer invites a fresh signature (a 402 whose body carries `accepts`).
//
// Real local D1, the real Worker router, the real reconciler (runReconciler). Only `fetch` is stubbed (the facilitator and the Base RPCs),
// as everywhere in test/settlement-replay-*-d1.test.ts. One deviation, named: `Date.now` is given a restorable offset for the duration of
// the enumeration, because attemptPending reads the wall clock directly (x402.ts) and a mid-trace EXPIRE must make the SAME authorisation
// live at one step and expired at the next; a per-trace validBefore cannot do that. The offset is 0 until EXPIRE fires.
//
// ALPHABET (each event is one step; every trace starts with FIRST):
//   FIRST(v)          the payer's first paid request; the facilitator's first /settle answers v.
//   RESEND(v, c)      the payer's identical re-send; the chain reads c; if the code re-POSTs, the facilitator answers v.
//   RECONCILE(v, c)   one runReconciler pass under the same two dials.
//   EXPIRE            from here the wall clock and the chain's block timestamps are past validBefore + RECONCILE_EXPIRY_MARGIN_SECONDS.
//   CHAIN_TRANSFER    from here the chain reads the authorisation USED; nobody tells the society.
//   v in { success, refused (a rule-7 recorded refusal), unknown (settlement_pending) }; c in { used, unused, unreadable (every RPC fails) }.
//
// PHYSICS the enumeration respects (an unconstrained product would manufacture violations in worlds that cannot exist):
//   - the chain is monotone: an authorisation that reads used stays used (EIP-3009's nonce state never reverts), so a later `unused` is pruned
//     once the world is spent, and a `used` dial sets the world spent;
//   - nothing mines after validBefore: CHAIN_TRANSFER is pruned after EXPIRE, and once an `unused` read has been answered after EXPIRE the
//     authorisation was never spent, so a later `used` is pruned;
//   - EXPIRE and CHAIN_TRANSFER each happen at most once.
//
// ADAPTIVE DEDUPLICATION: a step's dials are varied only where the code reads them. A step that makes no RPC fetch behaves the same under
// every c; a step that makes no /settle call behaves the same under every v. Each such step is run once (the probe) and not multiplied.
//
// INVARIANT, checked after every step (stepViolations below is the one definition):
//   EVIDENCE becomes true at the first step in which the society OBSERVED settlement evidence: a facilitator `success` answered to any request
//   or reconciler pass, or an RPC eth_call answered `used` (counted in the RPC stub: a CHAIN_TRANSFER the code never read is NOT observed).
//   Once EVIDENCE is true: (I1) no response to the payer is a 402 with `accepts`; (I2) the claim is never `refused` or `expired` without the
//   contradiction stamp, unless it was already terminal before the evidence was observed. At every step, evidence or not: (I3) a 402 with
//   `accepts` comes only from a row that is `refused` or `expired` and not contradicted; (I4) the claim reads `refused` only in a trace whose
//   FIRST step was a refusal (today's single producer is payAndSettle's first /settle: markRefused has one caller). I4 is what catches the H2 fix
//   undone (a re-POST refusal while the chain reads unused written as `refused`): that branch is reachable only with EVIDENCE false and the row it
//   wrongly refuses is never re-read, so I1-I3 cannot see it. I4 is a provenance clause about the code's own producers, not about the world.
//
// THE KNOWN EXCEPTION is named, not hidden, in the last test: DEFERRED-REFUSED-CHAIN-RECHECK (src/settlement-reconcile.ts).
//
// NOT COVERED (so the harness flag stays): booking steps (a public-key registration books in the same request), a second holder racing a
// terminal write, duplicate delivery, stale replay. The contradiction stamp (settlement_contradiction) is reachable only through a second
// holder, so no trace here reaches it; the clauses of I2 and I3 that mention it are checked but not exercised by this alphabet.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import {
  TEST_PAYER,
  TREASURY_ADDRESS,
  TX,
  callWorker,
  chainRpc,
  claimRows,
  createLocalD1,
  paymentHeaderFor,
  realPublicKey,
  registerReq,
  stubFacilitator,
  testEnv,
} from "./helpers/settlement-harness.ts";
import { CHAIN_SPENT_MARKER, isContradicted, type ClaimRow } from "../src/settlement-claims.ts";
import { runReconciler } from "../src/settlement-reconcile.ts";
import { RECONCILE_EXPIRY_MARGIN_SECONDS } from "../src/x402.ts";

type Verdict = "success" | "refused" | "unknown";
type Read = "used" | "unused" | "unreadable";
type Step =
  | { kind: "FIRST"; v: Verdict }
  | { kind: "RESEND" | "RECONCILE"; v: Verdict; c: Read }
  | { kind: "EXPIRE" }
  | { kind: "CHAIN_TRANSFER" };

const VERDICTS: Verdict[] = ["success", "refused", "unknown"];
const stepLabel = (s: Step): string => (s.kind === "FIRST" ? `FIRST(${s.v})` : s.kind === "RESEND" || s.kind === "RECONCILE" ? `${s.kind}(${s.v},${s.c})` : s.kind);
const traceLabel = (t: Step[]): string => t.map(stepLabel).join(" > ");

// How many steps follow FIRST.
const MAX_AFTER_FIRST = 3;
// A refactor that silently enumerates nothing (or a fraction) goes red. Floors sit a little below what the enumeration measured when written
// (the main test writes the measured numbers in one log line).
const MIN_TRACES = 1300;
const MIN_STEP_CHECKS = 5000;

// ---------- the facilitator's three answers ----------

const jsonOk = (o: unknown): Response => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
const FACILITATOR: Record<Verdict, () => Response> = {
  success: () => jsonOk({ success: true, payer: TEST_PAYER, transaction: TX }),
  refused: () => jsonOk({ success: false, errorReason: "insufficient_funds" }),
  unknown: () => jsonOk({ success: false, errorReason: "settlement_pending" }),
};

// ---------- the clock ----------

const realNow = Date.now.bind(Date);
let clockOffsetMs = 0;
const fakeNow = (): number => realNow() + clockOffsetMs;

// ---------- the world and the invariants ----------

interface World {
  // The authorisation has been used on chain (or read used): monotone.
  spent: boolean;
  // The clock is past validBefore + margin.
  expired: boolean;
  // A readable `unused` was answered after EXPIRE: nothing can have been mined since, so the authorisation was never spent.
  neverSpent: boolean;
}
const freshWorld = (): World => ({ spent: false, expired: false, neverSpent: false });
const isTerminal = (state: string): boolean => state === "refused" || state === "expired";

interface StepView {
  // The payer's response (FIRST and RESEND only); null for a reconciler pass.
  response: { status: number; body: Record<string, any> } | null;
  row: Pick<ClaimRow, "state" | "verdict_reason">;
  evidence: boolean;
  terminalBeforeEvidence: boolean;
  // The trace's FIRST step was a recorded refusal (the only way a claim may become `refused`).
  firstWasRefused: boolean;
}
// The one definition of the invariants. Pure, so the self-test below can prove each clause can fail.
function stepViolations(view: StepView): string[] {
  const out: string[] = [];
  const invites = view.response !== null && view.response.status === 402 && Array.isArray(view.response.body.accepts);
  const liveTerminal = isTerminal(view.row.state) && !isContradicted(view.row);
  if (view.evidence && invites) out.push("I1: a 402 with accepts after the society observed settlement evidence");
  if (view.evidence && liveTerminal && !view.terminalBeforeEvidence) out.push(`I2: claim is ${view.row.state} without the contradiction stamp after the society observed settlement evidence`);
  if (invites && !liveTerminal) out.push(`I3: a 402 with accepts from a row that is ${view.row.state}${isContradicted(view.row) ? " (contradicted)" : ""}, not a live refused or expired one`);
  if (view.row.state === "refused" && !view.firstWasRefused) out.push("I4: claim is refused although the trace's FIRST step was not a refusal (only the first /settle may write refused)");
  return out;
}

// ---------- running one trace ----------

interface StepRecord {
  step: Step;
  status: number | null;
  body: Record<string, any> | null;
  settleCalls: number;
  rpcFetches: number;
  row: ClaimRow;
}
interface TraceResult {
  steps: Step[];
  records: StepRecord[];
  world: World;
  evidence: boolean;
  violations: string[];
  checks: number;
}

async function runTrace(steps: Step[], publicKey: string): Promise<TraceResult> {
  clockOffsetMs = 0;
  const d1 = createLocalD1();
  const world = freshWorld();
  const dial = { v: "unknown" as Verdict, c: "unreadable" as Read };
  const seen = { successes: 0, used: 0, rpcFetches: 0 };
  const validBefore = Math.floor(realNow() / 1000) + 60;
  const header = paymentHeaderFor(TREASURY_ADDRESS, "1000000", { validBefore: String(validBefore) });
  const body = { handle: "ordering-seat", model: "m", public_key: publicKey };
  const env = testEnv(d1);
  const stub = stubFacilitator({
    settle: () => {
      if (dial.v === "success") seen.successes++;
      return FACILITATOR[dial.v]();
    },
    rpc: (url, n, init) => {
      seen.rpcFetches++;
      if (dial.c === "unreadable") return null;
      const used = world.spent || dial.c === "used";
      let method: string | undefined;
      try {
        method = (JSON.parse(String(init?.body ?? "{}")) as { method?: string }).method;
      } catch {
        method = undefined;
      }
      if (method === "eth_call" && used) seen.used++;
      return chainRpc(used)(url, n, init);
    },
  });
  const records: StepRecord[] = [];
  const violations: string[] = [];
  let evidence = false;
  let terminalBeforeEvidence = false;
  const firstWasRefused = steps[0].kind === "FIRST" && steps[0].v === "refused";
  let previousTerminal = false;
  let checks = 0;
  try {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const before = { settle: stub.calls.settle, successes: seen.successes, used: seen.used, rpc: seen.rpcFetches };
      let response: { status: number; body: Record<string, any> } | null = null;
      if (step.kind === "FIRST" || step.kind === "RESEND") {
        dial.v = step.v;
        dial.c = step.kind === "FIRST" ? "unreadable" : step.c;
        const res = await callWorker(registerReq(body, header), env);
        response = { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, any> };
      } else if (step.kind === "RECONCILE") {
        dial.v = step.v;
        dial.c = step.c;
        await runReconciler(env);
      } else if (step.kind === "EXPIRE") {
        clockOffsetMs = (validBefore + RECONCILE_EXPIRY_MARGIN_SECONDS + 30) * 1000 - realNow();
        world.expired = true;
      } else {
        world.spent = true;
      }
      const rpcFetches = seen.rpcFetches - before.rpc;
      // What the step's reads established about the world (only when the code really asked, and the RPCs answered).
      if ((step.kind === "RESEND" || step.kind === "RECONCILE") && rpcFetches > 0 && step.c !== "unreadable") {
        if (step.c === "used") world.spent = true;
        if (step.c === "unused" && world.expired) world.neverSpent = true;
      }
      const rows = claimRows(d1) as unknown as ClaimRow[];
      assert.equal(rows.length, 1, `${traceLabel(steps)}: exactly one claim row after ${stepLabel(step)}`);
      const row = rows[0];
      if ((seen.successes > before.successes || seen.used > before.used) && !evidence) {
        evidence = true;
        terminalBeforeEvidence = previousTerminal;
      }
      checks++;
      for (const found of stepViolations({ response, row, evidence, terminalBeforeEvidence, firstWasRefused })) {
        violations.push(
          `${traceLabel(steps.slice(0, i + 1))}\n    ${found}\n    response: ${response ? `${response.status} ${JSON.stringify(response.body).slice(0, 240)}` : "(reconciler pass)"}\n    row: state=${row.state} tx=${row.tx} verdict_reason=${String(row.verdict_reason).slice(0, 160)}`,
        );
      }
      previousTerminal = isTerminal(row.state);
      records.push({ step, status: response?.status ?? null, body: response?.body ?? null, settleCalls: stub.calls.settle - before.settle, rpcFetches, row });
    }
  } finally {
    stub.restore();
    d1.close();
  }
  return { steps, records, world, evidence, violations, checks };
}

// ---------- the enumeration ----------

const allowedReads = (w: World): Read[] => {
  const reads: Read[] = ["unreadable"];
  if (!w.neverSpent) reads.push("used");
  if (!w.spent) reads.push("unused");
  return reads;
};

interface Tally {
  traces: number;
  checks: number;
  violations: string[];
  maxLength: number;
  finalStates: Map<string, number>;
  evidenceTraces: number;
  // Each of these must be reached, or the fixture is not exercising what it claims.
  coverage: Record<string, number>;
}
const bump = (m: Record<string, number>, k: string) => void (m[k] = (m[k] ?? 0) + 1);

function record(tally: Tally, r: TraceResult): void {
  tally.traces++;
  tally.checks += r.checks;
  tally.maxLength = Math.max(tally.maxLength, r.steps.length);
  tally.violations.push(...r.violations);
  if (r.evidence) tally.evidenceTraces++;
  const last = r.records[r.records.length - 1].row;
  const tag = last.state === "pending" && typeof last.verdict_reason === "string" && last.verdict_reason.startsWith(CHAIN_SPENT_MARKER) ? "pending(stopped)" : last.state;
  tally.finalStates.set(tag, (tally.finalStates.get(tag) ?? 0) + 1);
  for (const rec of r.records) {
    if (rec.status === 402 && rec.step.kind === "RESEND") bump(tally.coverage, "resend-invitation");
    if (rec.status === 502 && rec.step.kind === "RESEND") bump(tally.coverage, "resend-do-not-sign-again");
    if (rec.settleCalls > 0 && rec.step.kind === "RECONCILE") bump(tally.coverage, "reconciler-repost");
    if (rec.settleCalls > 0 && rec.step.kind === "RESEND") bump(tally.coverage, "resend-repost");
  }
}

async function enumerate(publicKey: string, maxAfterFirst: number): Promise<Tally> {
  const tally: Tally = { traces: 0, checks: 0, violations: [], maxLength: 0, finalStates: new Map(), evidenceTraces: 0, coverage: {} };
  const visit = async (steps: Step[]): Promise<TraceResult> => {
    const r = await runTrace(steps, publicKey);
    record(tally, r);
    if (steps.length - 1 < maxAfterFirst) await extend(steps, r.world);
    return r;
  };
  const extend = async (steps: Step[], world: World): Promise<void> => {
    for (const kind of ["RESEND", "RECONCILE"] as const) {
      for (const c of allowedReads(world)) {
        const probe = await visit([...steps, { kind, v: "unknown", c }]);
        const rec = probe.records[probe.records.length - 1];
        // No RPC fetch: the code never read the chain at this point, so c (and v) are irrelevant and this one run stands for all of them.
        if (rec.rpcFetches === 0) break;
        // No /settle call under this c: v is irrelevant. Otherwise v is varied.
        if (rec.settleCalls > 0) for (const v of VERDICTS.filter((x) => x !== "unknown")) await visit([...steps, { kind, v, c }]);
      }
    }
    if (!world.expired) await visit([...steps, { kind: "EXPIRE" }]);
    if (!world.spent && !world.expired) await visit([...steps, { kind: "CHAIN_TRANSFER" }]);
  };
  for (const v of VERDICTS) await visit([{ kind: "FIRST", v }]);
  return tally;
}

// Silences the Worker's own structured log lines (thousands of them) and gives Date.now its offset while `fn` runs; restores both in `finally`.
async function quietWithFakeClock<T>(fn: () => Promise<T>): Promise<T> {
  const log = console.log;
  console.log = () => {};
  Date.now = fakeNow;
  try {
    return await fn();
  } finally {
    Date.now = realNow;
    clockOffsetMs = 0;
    console.log = log;
  }
}

// ---------- the tests ----------

test("every ordering of FIRST / RESEND / RECONCILE / EXPIRE / CHAIN_TRANSFER keeps the invariant after every step (the society never invites a fresh signature once it has observed settlement evidence)", { timeout: 300_000 }, async () => {
  const publicKey = await realPublicKey();
  const started = performance.now();
  const tally = await quietWithFakeClock(() => enumerate(publicKey, MAX_AFTER_FIRST));
  const states = [...tally.finalStates.entries()].map(([k, n]) => `${k}=${n}`).join(" ");
  console.log(
    `settlement claim orderings: ${tally.traces} traces (longest ${tally.maxLength} steps), ${tally.checks} per-step invariant checks, ${tally.evidenceTraces} traces observed evidence, ${((performance.now() - started) / 1000).toFixed(1)}s; final states: ${states}; coverage: ${JSON.stringify(tally.coverage)}`,
  );
  // A violation is reported first and by name: it is the most specific failure, and a changed enumeration size must not mask it.
  assert.deepEqual(tally.violations.slice(0, 5), [], `${tally.violations.length} violation(s); the first ones:\n${tally.violations.slice(0, 5).join("\n")}`);
  // The zero-failure read must prove it ran (L-121): floors, and every branch the invariant is about must have been reached.
  assert.ok(tally.traces >= MIN_TRACES, `only ${tally.traces} traces ran (floor ${MIN_TRACES}): the enumeration shrank`);
  assert.ok(tally.checks >= MIN_STEP_CHECKS, `only ${tally.checks} step checks ran (floor ${MIN_STEP_CHECKS})`);
  assert.equal(tally.maxLength, MAX_AFTER_FIRST + 1, "the longest trace reaches the bound");
  for (const state of ["booked", "refused", "expired", "pending", "pending(stopped)"]) assert.ok((tally.finalStates.get(state) ?? 0) > 0, `no trace ended ${state}: the enumeration does not reach it`);
  for (const k of ["resend-invitation", "resend-do-not-sign-again", "reconciler-repost", "resend-repost"]) assert.ok((tally.coverage[k] ?? 0) > 0, `coverage: ${k} never happened`);
  assert.ok(tally.evidenceTraces > 0, "no trace observed evidence");
});

test("the invariant can fail: each clause fires on a synthetic step that breaks it and stays silent on one that does not (prove-it-can-fail)", () => {
  const invite = { status: 402, body: { accepts: [{}] } };
  const row = (state: string, verdict_reason: string | null = null) => ({ state, verdict_reason }) as Pick<ClaimRow, "state" | "verdict_reason">;
  const stamped = "settlement_contradiction:0xabc|insufficient_funds";
  const has = (v: string[], tag: string) => v.some((x) => x.startsWith(tag));
  const view = (response: StepView["response"], r: ReturnType<typeof row>, evidence: boolean, terminalBeforeEvidence = false, firstWasRefused = true): StepView => ({ response, row: r, evidence, terminalBeforeEvidence, firstWasRefused });

  assert.ok(has(stepViolations(view(invite, row("expired"), true)), "I1"));
  assert.ok(has(stepViolations(view(invite, row("expired"), true)), "I2"));
  assert.ok(has(stepViolations(view(null, row("refused"), true)), "I2"), "a reconciler pass has no response and I2 still applies");
  assert.ok(has(stepViolations(view(invite, row("pending"), false)), "I3"));
  assert.ok(has(stepViolations(view(invite, row("expired", stamped), false)), "I3"), "an invitation from a contradicted row is a violation");
  assert.ok(has(stepViolations(view(invite, row("booked"), false)), "I3"));
  assert.ok(has(stepViolations(view(null, row("refused"), false, false, false)), "I4"), "a refused row in a trace that did not start with a refusal is a violation");
  assert.ok(has(stepViolations(view(invite, row("refused", stamped), false, false, false)), "I4"), "a stamped refused row still has to come from a first refusal");

  assert.deepEqual(stepViolations(view(invite, row("expired"), false)), [], "a live expired row may invite when no evidence was observed");
  assert.deepEqual(stepViolations(view(invite, row("refused"), false)), []);
  assert.deepEqual(stepViolations(view(null, row("expired"), false, false, false)), [], "I4 is about refused only: an expired row needs no refusal");
  assert.deepEqual(stepViolations(view(null, row("pending"), true, false, false)), []);
  assert.deepEqual(stepViolations(view({ status: 502, body: { error: "do not sign again" } }, row("pending"), true)), []);
  assert.deepEqual(stepViolations(view({ status: 500, body: {} }, row("expired", stamped), true)), [], "a stamped terminal row after evidence is the correct state");
  assert.deepEqual(stepViolations(view(null, row("refused"), true, true)), [], "terminal before the evidence was observed is exempt from I2");
});

test("DEFERRED-REFUSED-CHAIN-RECHECK: a refused claim is never re-read, so an unreported on-chain transfer still gets a 402 with accepts", async () => {
  // THIS TEST ASSERTS TODAY'S KNOWN GAP AND IS EXPECTED TO GO RED WHEN THE REMEDY LANDS (src/settlement-reconcile.ts, DEFERRED-REFUSED-CHAIN-RECHECK:
  // re-read a refused row's authorisation until validBefore + RECONCILE_EXPIRY_MARGIN_SECONDS and stamp it settlement_contradiction if the chain reads it used).
  // Whoever lands that remedy flips this test: the re-send after CHAIN_TRANSFER must then NOT be a 402 with accepts. It does not violate the enumeration's invariant
  // (the society never observed the transfer); it is the gap a ground-truth version of the invariant would catch.
  const publicKey = await realPublicKey();
  const log = console.log;
  console.log = () => {};
  let r: TraceResult;
  try {
    r = await runTrace(
      [
        { kind: "FIRST", v: "refused" },
        { kind: "CHAIN_TRANSFER" },
        { kind: "RESEND", v: "success", c: "used" },
        { kind: "RECONCILE", v: "success", c: "used" },
      ],
      publicKey,
    );
  } finally {
    console.log = log;
  }
  const [first, transfer, resend, reconcile] = r.records;
  assert.equal(first.status, 402, "the first /settle was a recorded refusal");
  assert.equal(first.row.state, "refused");
  assert.equal(transfer.row.state, "refused");
  assert.equal(resend.status, 402, "the re-send after an unreported transfer is still told to sign again");
  assert.ok(Array.isArray(resend.body?.accepts) && resend.body.accepts.length === 1, "with an invitation to sign: `accepts`");
  assert.equal(resend.row.state, "refused");
  assert.equal(isContradicted(resend.row), false);
  assert.equal(resend.rpcFetches, 0, "nothing re-read the chain for the refused row");
  assert.equal(resend.settleCalls, 0, "and nothing re-POSTed the authorisation");
  assert.equal(reconcile.rpcFetches, 0, "the reconciler never selects a refused row");
  assert.equal(reconcile.settleCalls, 0);
  assert.equal(reconcile.row.state, "refused");
  assert.equal(r.world.spent, true, "while the chain reads the authorisation used");
  assert.equal(r.evidence, false, "the society never observed it");
  assert.deepEqual(r.violations, [], "so the enumeration's invariant is not broken by this trace");
});
