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
//   A FIRST(refused) leaves the claim PENDING with the facilitator's words (option B); it is answered 502 with no `accepts`.
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
//   `accepts` comes only from a row that is `refused` or `expired` and not contradicted; (I4) NO TRACE PRODUCES `refused`. Since option B
//   (docs/BRIEF-REFUSED-CHAIN-RECHECK.md, ruled 5 Oct 2026) nothing writes that state: payAndSettle's first /settle keeps a rule-7 refusal PENDING (markFirstRefusal),
//   and a re-POST refusal while the chain reads unused was never written as `refused` (H2). Before B, I4 allowed `refused` after a first-step refusal and exempted
//   a rival's `refused`; the `refused` rows production still holds are pre-B history, and this fixture starts from an empty table, so none can appear. I4 is what catches
//   either producer coming back (H2 undone, or a first refusal written terminal again): a refused row is never re-read, so I1-I3 cannot see it. It is a provenance
//   clause about the code's own producers, not about the world.
//
// THE FORMER KNOWN EXCEPTION (DEFERRED-REFUSED-CHAIN-RECHECK) IS CLOSED by option B: the last test pins what it became, "after a first-attempt refusal: no `accepts` on any answer
// until the C6 expiry proof marks the claim `expired`", through the three paths that can resolve the row (the payer's re-send, the reconciler, and a transfer that was mined).
//
// THE RIVAL HOLDER (a follow-on, 5 Oct 2026). Without a second holder the contradiction stamp (settlement_contradiction) is unreachable, so the
// mutations that undo it (claimAnswer ignoring isContradicted; respondToExistingClaim not re-reading a held success) stayed green. A RESEND or
// RECONCILE step that re-POSTs with v = success may therefore carry a RIVAL: a second holder after the first holder's lease lapsed, acting
// through the production lease and terminal writes. Inside the facilitator stub's /settle callback (the attempt is waiting there) the fake
// clock is advanced past CLAIM_LEASE_TTL_MS so the attempt's lease lapses; the rival then takes the lease with acquireLease under its own
// owner and writes only through markExpired under that owner (passing the leased claim row as `release`, as the reconciler
// does). There is no raw SQL write to settlement_claims anywhere in this file. Two placements. The rival's end is always `expired`: before option B it could
// also write `refused` (a second holder's recorded refusal), but nothing writes that state now, so a rival `refused` would be a state production cannot reach (L-126).
//   RIVAL_TERMINATES_DURING_SETTLE   the rival takes the lapsed lease and terminates the row while the attempt still waits on /settle; the
//                                    facilitator then answers success. Expected: markSettled changes nothing, the moved row is terminal, the
//                                    contradiction is logged and stamped, and every later identical re-send gets the contradiction.
//   RIVAL_HOLDS_THEN_TERMINATES      the rival takes the lapsed lease and KEEPS it (markSettled fails on the live foreign lease), and terminates the row
//                                    after the attempt's first re-read and before holdSuccessAgainstTerminal's. There is no fetch in that window, so the
//                                    seam is the D1 BINDING the test passes in env: a wrapper that writes nothing, only watches: after the markSettled
//                                    UPDATE reports 0 changes it lets the next claim SELECT through and then runs the rival's production terminal write.
//                                    It wraps the database, not one of our modules.
// A rival trace is a DISAGREEMENT world by construction: the facilitator reports a settlement while the society's own record (written by a
// worker that read the chain unused) says the authorisation is dead. The monotone-chain physics above is not applied to the rival's write; that
// disagreement is exactly what the contradiction stamp exists for. v is success for every rival step (the designed scenario), and rival steps
// are only generated at the first RIVAL_MAX_STEP_INDEX steps after FIRST so the enumeration does not multiply. The clock advance of a rival
// step stays in force for the rest of the trace (time does not run backwards).
//
// NOT COVERED (so the harness flag stays): booking-step failure (a public-key registration books in the same request), duplicate delivery,
// stale replay, and a rival at FIRST or at the booking step. At most one rival acts per trace in practice: it leaves the row terminal, and a terminal
// row is not re-POSTed, so no later step offers a second one.
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
import {
  CHAIN_SPENT_MARKER,
  CLAIM_LEASE_TTL_MS,
  acquireLease,
  isContradicted,
  keyOfRow,
  markExpired,
  releaseLease,
  type ClaimKey,
  type ClaimRow,
} from "../src/settlement-claims.ts";
import { runReconciler } from "../src/settlement-reconcile.ts";
import { RECONCILE_EXPIRY_MARGIN_SECONDS } from "../src/x402.ts";

type Verdict = "success" | "refused" | "unknown";
type Read = "used" | "unused" | "unreadable";
// A rival holder: where it acts (see THE RIVAL HOLDER above). It always terminates the row as `expired`.
interface Rival {
  at: "settle" | "hold";
}
type Step =
  | { kind: "FIRST"; v: Verdict }
  | { kind: "RESEND" | "RECONCILE"; v: Verdict; c: Read; rival?: Rival }
  | { kind: "EXPIRE" }
  | { kind: "CHAIN_TRANSFER" };

const VERDICTS: Verdict[] = ["success", "refused", "unknown"];
const rivalLabel = (r: Rival): string => `+${r.at === "settle" ? "RIVAL_TERMINATES_DURING_SETTLE" : "RIVAL_HOLDS_THEN_TERMINATES"}`;
const stepLabel = (s: Step): string =>
  s.kind === "FIRST" ? `FIRST(${s.v})` : s.kind === "RESEND" || s.kind === "RECONCILE" ? `${s.kind}(${s.v},${s.c})${s.rival ? rivalLabel(s.rival) : ""}` : s.kind;
const traceLabel = (t: Step[]): string => t.map(stepLabel).join(" > ");

// How many steps follow FIRST.
const MAX_AFTER_FIRST = 3;
// A rival step is generated only as one of the first RIVAL_MAX_STEP_INDEX steps after FIRST (index 1 is the first step after FIRST), so it does not multiply every trace.
const RIVAL_MAX_STEP_INDEX = 2;
// A refactor that silently enumerates nothing (or a fraction) goes red. Floors sit a little below what the enumeration measured when written
// (the main test writes the measured numbers in one log line). Re-set for option B (6 Oct 2026): a first-attempt refusal now leaves a PENDING row that the re-send and the reconciler can work,
// so the enumeration grew. Measured before: 2266 traces (792 with a rival), 8612 step checks, floors 2000 / 7500 / 700. Measured after: 3572 traces (792 with a rival, the rival now ending
// `expired` only), 13672 step checks; floors 3150 / 12000 / 700 (each about 88% of the measure, the ratio the old floors kept).
const MIN_TRACES = 3150;
const MIN_STEP_CHECKS = 12000;
const MIN_RIVAL_TRACES = 700;

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
}
// The one definition of the invariants. Pure, so the self-test below can prove each clause can fail.
function stepViolations(view: StepView): string[] {
  const out: string[] = [];
  const invites = view.response !== null && view.response.status === 402 && Array.isArray(view.response.body.accepts);
  const liveTerminal = isTerminal(view.row.state) && !isContradicted(view.row);
  if (view.evidence && invites) out.push("I1: a 402 with accepts after the society observed settlement evidence");
  if (view.evidence && liveTerminal && !view.terminalBeforeEvidence) out.push(`I2: claim is ${view.row.state} without the contradiction stamp after the society observed settlement evidence`);
  if (invites && !liveTerminal) out.push(`I3: a 402 with accepts from a row that is ${view.row.state}${isContradicted(view.row) ? " (contradicted)" : ""}, not a live refused or expired one`);
  if (view.row.state === "refused") out.push("I4: claim is refused, but since option B no production path writes `refused` (a first-attempt refusal stays pending; a re-POST refusal while the chain reads unused is not acted on)");
  return out;
}

// ---------- running one trace ----------

interface StepRecord {
  step: Step;
  status: number | null;
  body: Record<string, any> | null;
  settleCalls: number;
  rpcFetches: number;
  // The step carried a rival and the rival's terminal write really happened.
  rivalFired: boolean;
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
  // The rival holder (see THE RIVAL HOLDER above). `active` is the rival the current step carries; `holding` means it has taken the lease on the still-pending row;
  // `armed` means the attempt's markSettled has just changed nothing, so the next claim SELECT is the attempt's re-read; `fired` means the rival's terminal write happened.
  // The rival acts ONLY through the production functions (acquireLease with its own owner, then markExpired / markRefused with that owner), on an env whose DB is NOT the watched wrapper.
  // `key` and `leased` are the claim's key and the row as the rival's acquireLease returned it.
  const RIVAL_OWNER = "rival-holder";
  const rivalEnv = testEnv(d1);
  const rival = { active: null as Rival | null, holding: false, armed: false, fired: false, key: null as ClaimKey | null, leased: null as ClaimRow | null };
  // The first holder's lease lapses: the clock moves past CLAIM_LEASE_TTL_MS (the attempt took its lease at the start of the step), then the rival takes the lease through acquireLease,
  // exactly as a second worker or the reconciler would. Returns false if production refused it (the rival then does nothing).
  const rivalTakesOver = async (): Promise<boolean> => {
    clockOffsetMs += CLAIM_LEASE_TTL_MS + 1000;
    const key = keyOfRow((claimRows(d1) as unknown as ClaimRow[])[0]);
    const leased = await acquireLease(rivalEnv, key, RIVAL_OWNER, Date.now());
    if (!leased) return false;
    rival.key = key;
    rival.leased = leased;
    rival.holding = true;
    return true;
  };
  const rivalTerminate = async (): Promise<void> => {
    if (!(await markExpired(rivalEnv, rival.key!, RIVAL_OWNER, Date.now(), rival.leased!))) return;
    rival.fired = true;
  };
  // The timing seam for RIVAL_HOLDS_THEN_TERMINATES, and the ONLY thing the D1 wrapper does: a wrapper around the D1 BINDING (not one of our modules, and it writes nothing). After the
  // markSettled UPDATE reports 0 changes it arms; the next claim SELECT (the attempt's re-read) is let through, and the rival's production terminal write lands right after it, before
  // holdSuccessAgainstTerminal's read.
  const SETTLED_UPDATE = /^\s*UPDATE settlement_claims SET state = 'settled_unbooked'/;
  const CLAIM_SELECT = /^\s*SELECT \* FROM settlement_claims WHERE/;
  const watch = (stmt: any, sql: string): any => ({
    ...stmt,
    bind: (...a: unknown[]) => watch(stmt.bind(...a), sql),
    first: async () => {
      const r = await stmt.first();
      if (rival.armed && CLAIM_SELECT.test(sql)) {
        rival.armed = false;
        await rivalTerminate();
      }
      return r;
    },
    run: async () => {
      const r = await stmt.run();
      if (rival.holding && !rival.fired && rival.active?.at === "hold" && SETTLED_UPDATE.test(sql) && r.meta.changes === 0) rival.armed = true;
      return r;
    },
  });
  const needsWatchedDb = steps.some((s) => (s.kind === "RESEND" || s.kind === "RECONCILE") && s.rival?.at === "hold");
  const env = needsWatchedDb ? { ...testEnv(d1), DB: { prepare: (sql: string) => watch(d1.DB.prepare(sql), sql), batch: (stmts: any[]) => d1.DB.batch(stmts) } as any } : testEnv(d1);
  const stub = stubFacilitator({
    settle: async () => {
      const rv = rival.active;
      if (rv && !rival.fired && !rival.holding) {
        if ((await rivalTakesOver()) && rv.at === "settle") await rivalTerminate();
      }
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

  let previousTerminal = false;
  let checks = 0;
  try {
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const before = { settle: stub.calls.settle, successes: seen.successes, used: seen.used, rpc: seen.rpcFetches };
      let response: { status: number; body: Record<string, any> } | null = null;
      rival.active = step.kind === "RESEND" || step.kind === "RECONCILE" ? (step.rival ?? null) : null;
      rival.holding = false;
      rival.armed = false;
      rival.fired = false;
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
      // A rival that took the lease but never got to terminate (the code never reached the seam) lets go, so later steps meet the claim as the code left it.
      if (rival.holding && !rival.fired) await releaseLease(rivalEnv, rival.key!, RIVAL_OWNER);
      const rivalFired = rival.fired;
      rival.active = null;
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
      for (const found of stepViolations({ response, row, evidence, terminalBeforeEvidence })) {
        violations.push(
          `${traceLabel(steps.slice(0, i + 1))}\n    ${found}\n    response: ${response ? `${response.status} ${JSON.stringify(response.body).slice(0, 240)}` : "(reconciler pass)"}\n    row: state=${row.state} tx=${row.tx} verdict_reason=${String(row.verdict_reason).slice(0, 160)}`,
        );
      }
      previousTerminal = isTerminal(row.state);
      records.push({ step, status: response?.status ?? null, body: response?.body ?? null, settleCalls: stub.calls.settle - before.settle, rpcFetches, rivalFired, row });
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
  // Traces carrying at least one rival step.
  rivalTraces: number;
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
  if (r.steps.some((x) => (x.kind === "RESEND" || x.kind === "RECONCILE") && x.rival)) tally.rivalTraces++;
  const last = r.records[r.records.length - 1].row;
  const tag = last.state === "pending" && typeof last.verdict_reason === "string" && last.verdict_reason.startsWith(CHAIN_SPENT_MARKER) ? "pending(stopped)" : last.state;
  tally.finalStates.set(tag, (tally.finalStates.get(tag) ?? 0) + 1);
  for (const rec of r.records) {
    if (rec.status === 402 && rec.step.kind === "RESEND") bump(tally.coverage, "resend-invitation");
    if (rec.status === 502 && rec.step.kind === "RESEND") bump(tally.coverage, "resend-do-not-sign-again");
    if (rec.settleCalls > 0 && rec.step.kind === "RECONCILE") bump(tally.coverage, "reconciler-repost");
    if (rec.settleCalls > 0 && rec.step.kind === "RESEND") bump(tally.coverage, "resend-repost");
    if ((rec.step.kind === "RESEND" || rec.step.kind === "RECONCILE") && rec.step.rival) {
      const tag = `${rec.step.kind}:${rec.step.rival.at}`;
      if (rec.rivalFired) bump(tally.coverage, `rival-fired ${tag}`);
      // The rival's write must have led to the contradiction stamp: that is the branch the rival exists to reach.
      if (rec.rivalFired && isContradicted(rec.row)) bump(tally.coverage, `rival-stamped ${tag}`);
    }
  }
}

async function enumerate(publicKey: string, maxAfterFirst: number): Promise<Tally> {
  const tally: Tally = { traces: 0, checks: 0, violations: [], maxLength: 0, finalStates: new Map(), evidenceTraces: 0, rivalTraces: 0, coverage: {} };
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
        // The rival holder: only where the attempt re-POSTs (it waits on /settle there), only with v = success (the designed disagreement), only early in the trace.
        if (rec.settleCalls > 0 && steps.length <= RIVAL_MAX_STEP_INDEX) {
          for (const at of ["settle", "hold"] as const) await visit([...steps, { kind, v: "success", c, rival: { at } }]);
        }
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
    `settlement claim orderings: ${tally.traces} traces (${tally.rivalTraces} with a rival, ${tally.traces - tally.rivalTraces} without; longest ${tally.maxLength} steps), ${tally.checks} per-step invariant checks, ${tally.evidenceTraces} traces observed evidence, ${((performance.now() - started) / 1000).toFixed(1)}s; final states: ${states}; coverage: ${JSON.stringify(tally.coverage)}`,
  );
  // A violation is reported first and by name: it is the most specific failure, and a changed enumeration size must not mask it.
  assert.deepEqual(tally.violations.slice(0, 5), [], `${tally.violations.length} violation(s); the first ones:\n${tally.violations.slice(0, 5).join("\n")}`);
  // The zero-failure read must prove it ran (L-121): floors, and every branch the invariant is about must have been reached.
  assert.ok(tally.traces >= MIN_TRACES, `only ${tally.traces} traces ran (floor ${MIN_TRACES}): the enumeration shrank`);
  assert.ok(tally.checks >= MIN_STEP_CHECKS, `only ${tally.checks} step checks ran (floor ${MIN_STEP_CHECKS})`);
  assert.equal(tally.maxLength, MAX_AFTER_FIRST + 1, "the longest trace reaches the bound");
  for (const state of ["booked", "expired", "pending", "pending(stopped)"]) assert.ok((tally.finalStates.get(state) ?? 0) > 0, `no trace ended ${state}: the enumeration does not reach it`);
  assert.equal(tally.finalStates.get("refused") ?? 0, 0, "no trace ended refused: since option B nothing writes that state (I4 checks it after every step)");
  for (const k of ["resend-invitation", "resend-do-not-sign-again", "reconciler-repost", "resend-repost"]) assert.ok((tally.coverage[k] ?? 0) > 0, `coverage: ${k} never happened`);
  assert.ok(tally.evidenceTraces > 0, "no trace observed evidence");
  // The rival traces must really have run and really have reached the contradiction stamp, for both placements and both kinds of attempt.
  assert.ok(tally.rivalTraces >= MIN_RIVAL_TRACES, `only ${tally.rivalTraces} rival traces ran (floor ${MIN_RIVAL_TRACES})`);
  for (const kind of ["RESEND", "RECONCILE"]) for (const at of ["settle", "hold"]) {
    assert.ok((tally.coverage[`rival-fired ${kind}:${at}`] ?? 0) > 0, `coverage: the rival never fired for ${kind}:${at}`);
    assert.ok((tally.coverage[`rival-stamped ${kind}:${at}`] ?? 0) > 0, `coverage: no rival trace of ${kind}:${at} reached the contradiction stamp`);
  }
});

test("the invariant can fail: each clause fires on a synthetic step that breaks it and stays silent on one that does not (prove-it-can-fail)", () => {
  const invite = { status: 402, body: { accepts: [{}] } };
  const row = (state: string, verdict_reason: string | null = null) => ({ state, verdict_reason }) as Pick<ClaimRow, "state" | "verdict_reason">;
  const stamped = "settlement_contradiction:0xabc|insufficient_funds";
  const has = (v: string[], tag: string) => v.some((x) => x.startsWith(tag));
  const view = (response: StepView["response"], r: ReturnType<typeof row>, evidence: boolean, terminalBeforeEvidence = false): StepView => ({ response, row: r, evidence, terminalBeforeEvidence });

  assert.ok(has(stepViolations(view(invite, row("expired"), true)), "I1"));
  assert.ok(has(stepViolations(view(invite, row("expired"), true)), "I2"));
  assert.ok(has(stepViolations(view(null, row("refused"), true)), "I2"), "a reconciler pass has no response and I2 still applies");
  assert.ok(has(stepViolations(view(invite, row("pending"), false)), "I3"));
  assert.ok(has(stepViolations(view(invite, row("expired", stamped), false)), "I3"), "an invitation from a contradicted row is a violation");
  assert.ok(has(stepViolations(view(invite, row("booked"), false)), "I3"));
  // I4 (option B): no trace produces `refused`, whatever came before it, stamped or not, after evidence or not.
  assert.ok(has(stepViolations(view(null, row("refused"), false)), "I4"), "a refused row is a violation: nothing writes that state any more");
  assert.ok(has(stepViolations(view(invite, row("refused", stamped), false)), "I4"), "a stamped refused row is one too");
  assert.ok(has(stepViolations(view(null, row("refused", stamped), true, true)), "I4"), "and I4 has no exemption for terminal-before-evidence");

  assert.deepEqual(stepViolations(view(invite, row("expired"), false)), [], "a live expired row may invite when no evidence was observed");
  assert.deepEqual(stepViolations(view(null, row("expired"), false)), [], "I4 is about refused only: an expired row is the production terminal state");
  assert.deepEqual(stepViolations(view(null, row("pending"), true)), []);
  assert.deepEqual(stepViolations(view(null, row("booked"), true)), []);
  assert.deepEqual(stepViolations(view({ status: 502, body: { error: "do not sign again" } }, row("pending"), true)), []);
  assert.deepEqual(stepViolations(view({ status: 500, body: {} }, row("expired", stamped), true)), [], "a stamped terminal row after evidence is the correct state");
  assert.deepEqual(stepViolations(view(null, row("expired"), true, true)), [], "terminal before the evidence was observed is exempt from I2");
});

// OPTION B (docs/BRIEF-REFUSED-CHAIN-RECHECK.md, ruled 5 Oct 2026), flipped from "DEFERRED-REFUSED-CHAIN-RECHECK: a refused claim is never re-read, so an unreported on-chain transfer still
// gets a 402 with accepts". That test pinned today's known gap and said it would go red when the remedy landed; it has. A first-attempt refusal is now a PENDING claim (the facilitator's word
// alone does not prove the authorisation can no longer move money), so NO answer carries `accepts` until the C6 expiry proof marks the claim `expired`. Three paths can resolve it; each is
// pinned below on the real router and the real reconciler.
async function quietTrace(steps: Step[]): Promise<TraceResult> {
  const publicKey = await realPublicKey();
  return quietWithFakeClock(() => runTrace(steps, publicKey));
}
const hasAccepts = (rec: StepRecord): boolean => Array.isArray(rec.body?.accepts);

test("after a first-attempt refusal: an unreported on-chain transfer is BOOKED by the payer's re-send (no accepts, the money is not stranded), and the reconciler has nothing left to do", async () => {
  const r = await quietTrace([
    { kind: "FIRST", v: "refused" },
    { kind: "CHAIN_TRANSFER" },
    { kind: "RESEND", v: "success", c: "used" },
    { kind: "RECONCILE", v: "success", c: "used" },
  ]);
  const [first, transfer, resend, reconcile] = r.records;
  assert.equal(first.status, 502, "the first /settle was a recorded refusal, answered as an unresolved payment");
  assert.equal(hasAccepts(first), false, "no invitation to sign");
  assert.equal(first.row.state, "pending");
  assert.notEqual(first.row.rpc_body, null, "the authorisation body is kept for the expiry proof");
  assert.match(String(first.row.verdict_reason), /insufficient_funds/, "the facilitator's words are the claim's last words");
  assert.equal(transfer.row.state, "pending", "an unreported transfer changes nothing the society can see");
  assert.equal(resend.status, 201, "the re-send read the chain used, re-POSTed, was told settled and booked it");
  assert.equal(resend.row.state, "booked");
  assert.ok(resend.rpcFetches > 0 && resend.settleCalls === 1, "it re-read the chain and re-POSTed the stored authorisation");
  assert.equal(reconcile.row.state, "booked");
  assert.equal(reconcile.rpcFetches, 0, "nothing for the reconciler to select");
  assert.equal(reconcile.settleCalls, 0);
  assert.equal(r.world.spent, true);
  assert.deepEqual(r.violations, [], "and the enumeration's invariant holds on this trace");
});

test("after a first-attempt refusal: no accepts on any answer before the expiry proof, and the payer's re-send after the proof is the 402 that invites a fresh signature", async () => {
  const r = await quietTrace([
    { kind: "FIRST", v: "refused" },
    { kind: "RESEND", v: "refused", c: "unused" },
    { kind: "RECONCILE", v: "refused", c: "unused" },
    { kind: "EXPIRE" },
    { kind: "RESEND", v: "unknown", c: "unused" },
  ]);
  const [first, beforeExpiry, reconcileBefore, expire, afterExpiry] = r.records;
  assert.equal(first.status, 502);
  assert.equal(hasAccepts(first), false);
  assert.equal(beforeExpiry.status, 502, "a re-send before validBefore + margin: the chain reads unused, the re-POST is refused again (H2), nothing is decided");
  assert.equal(hasAccepts(beforeExpiry), false, "still no invitation to sign");
  assert.equal(beforeExpiry.row.state, "pending");
  assert.equal(beforeExpiry.settleCalls, 1);
  assert.equal(reconcileBefore.row.state, "pending", "the reconciler's pass before the expiry decides nothing either");
  assert.equal(expire.row.state, "pending", "time passing is not a decision");
  assert.equal(afterExpiry.status, 402, "after the chain's own clock is past validBefore + margin and the authorisation reads unused, the claim expires");
  assert.equal(hasAccepts(afterExpiry), true, "and only then does an answer carry `accepts`");
  assert.equal(afterExpiry.row.state, "expired");
  assert.equal(afterExpiry.row.rpc_body, null, "the body is cleared with the terminal state");
  assert.equal(afterExpiry.settleCalls, 0, "the expiry proof re-POSTs nothing");
  assert.deepEqual(r.violations, []);
});

test("after a first-attempt refusal: the reconciler's pass after the expiry proof expires the claim, and the next re-send is the invitation (the second resolving path)", async () => {
  const r = await quietTrace([
    { kind: "FIRST", v: "refused" },
    { kind: "EXPIRE" },
    { kind: "RECONCILE", v: "unknown", c: "unused" },
    { kind: "RESEND", v: "unknown", c: "unused" },
  ]);
  const [first, expire, reconcile, resend] = r.records;
  assert.equal(hasAccepts(first), false);
  assert.equal(expire.row.state, "pending");
  assert.equal(reconcile.row.state, "expired", "the daily pass resolved it by the C6 proof");
  assert.equal(reconcile.settleCalls, 0);
  assert.equal(resend.status, 402);
  assert.equal(hasAccepts(resend), true, "an expired claim invites the fresh signature, with the chain's proof behind it");
  assert.equal(resend.row.state, "expired");
  assert.deepEqual(r.violations, []);
});
