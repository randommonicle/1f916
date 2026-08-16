// The shared subrequest-budget cost table (docs/BRIEF-JUDGMENT-QUERY-BUDGET.md
// §9 / D-041). Cloudflare Workers Free allows 50 subrequests per invocation,
// and scheduled() runs the governance sweep AND whichever wake fired in ONE
// invocation, sharing that budget. The static constants above do NOT close
// the compound worst case by themselves -- a due proposal, a replayed
// stranded row, and full judgment batches can coincide and cross 50 -- and
// D-041 declined the alternative of simply lowering JUDGMENT_MAX_BATCHES
// (a smaller fixed ceiling wastes capacity on quiet weeks and still fails on
// busy ones, since the compound case is driven by sweep and replay work a
// smaller batch count does not touch). So each wake sheds load it cannot pay
// for, LOUDLY, BEFORE starting it, using this bookkeeping arithmetic over the
// phases actually run this invocation -- NOT a wrapper around the D1 binding
// in production, which is neither needed nor commissioned.
//
// These are STATICALLY-DERIVED per-phase estimates, deliberately CONSERVATIVE
// (>= the real cost) so the shed decision fires early enough that the real
// invocation never actually reaches subrequest 51. The end-to-end counter
// proof (test/maintainer-scheduled-budget.test.ts) is the enforcement: if any
// estimate drifts below reality, the compound proof goes red at 51. Keep each
// constant next to the phase it prices, and cite the proof beside them.
//
// Costs are in subrequests (D1 statements + outbound fetches, one pool).

export const INVOCATION_SUBREQUEST_BUDGET = 50;

// The governance sweep, run in scheduled() before either wake. due SELECT +
// stranded SELECT + one detection lookup = 3 fixed; each due proposal costs
// ~8-9 through claimTallyAndExecuteOne (claim, proposal SELECT, ballot counts,
// citizens + founders, commitOutcome's head read + a 2-3 statement batch), so
// 9 is the conservative per-proposal price.
export const SWEEP_BASE_COST = 3;
export const SWEEP_PER_PROPOSAL_COST = 9;

// The judgment wake's fixed reads before the batch loop: run-row reserve,
// detection (conservatively 1, usually 0 cached), set-based reconciliation,
// maintainer-citizen load, approved-row read, pending count. Finalise is
// reserved separately (FINALISE_RESERVE).
export const JUDGMENT_WAKE_FIXED_COST = 6;

// One stranded approved row replayed through the real executors costs up to 6
// (the bulletin ceiling: claim + createPost's daily-count + dupe + insert +
// chain head + chain insert). The wake reserves this for the rows the replay
// actually processed this invocation.
export const REPLAY_PER_ROW_COST = 6;

// One judgment batch's marginal cost at C=1: a scan page + its (bulk,
// set-based) classification + a model fetch + up to 6 decision writes for one
// approved bulletin. FORWARD(D-037): a better product may exist by changing
// JUDGMENT_MAX_BATCHES or the per-decision write/executor shape (fewer
// batches, bulk stamps) -- D-037 expressly did NOT commission that; this
// marker sits where the cost table prices the batch phase so the option is
// findable if the throughput ruling is ever revisited.
export const JUDGMENT_BATCH_COST = 8;

// The clerk wake's fixed cost (non-insert): reserve + detection + reconcile +
// cursor + 4 candidate streams + set-based flag hydration (<=2) + drift (1 D1
// sum + up to 4 RPC probes, worst case) + previous delta + one model fetch +
// finalise. Flatter than the judgment shape (no 4-batch multiplier), so the
// clerk closes with a per-insert affordability cap rather than shedding whole
// batches.
export const CLERK_WAKE_FIXED_COST = 18;

// Headroom held back so the loud finalise run-row write ALWAYS lands even at
// the non-sheddable floor, plus a little slop. Uncontended paths land here
// with stated headroom; a chain-append UNIQUE-collision retry (only possible
// under concurrent invocations, not within one sequential sweep) adds ~2 each
// and is called out in the report rather than reserved in full.
export const FINALISE_RESERVE = 2;

// Pure. The sweep's estimated cost given how many due proposals it processed
// this invocation. scheduled() passes this to both wakes as their `priorCost`.
export function estimateSweepCost(proposalsProcessed: number): number {
  return SWEEP_BASE_COST + proposalsProcessed * SWEEP_PER_PROPOSAL_COST;
}

// Pure. May the judgment wake OPEN another batch? True only if, after the
// sweep (priorCost), the wake's fixed reads, the replay rows already
// processed, and the batches already opened, there is room for one MORE batch
// AND the finalise reserve. `batchesOpened` is how many batches this wake has
// already run.
export function canOpenJudgmentBatch(priorCost: number, replayRowsProcessed: number, batchesOpened: number): boolean {
  const spent = priorCost + JUDGMENT_WAKE_FIXED_COST + replayRowsProcessed * REPLAY_PER_ROW_COST + batchesOpened * JUDGMENT_BATCH_COST;
  return spent + JUDGMENT_BATCH_COST + FINALISE_RESERVE <= INVOCATION_SUBREQUEST_BUDGET;
}

// Pure. How many queue inserts can the clerk afford this invocation, capped at
// `ceiling` (CLERK_QUEUE_CAP)? Never negative. On a quiet-sweep day this is
// near the ceiling; on a busy-sweep day it shrinks, and the surplus the model
// proposed is counted as overflow_dropped exactly as a volume overflow is.
export function affordableClerkInserts(priorCost: number, ceiling: number): number {
  const affordable = INVOCATION_SUBREQUEST_BUDGET - priorCost - CLERK_WAKE_FIXED_COST - FINALISE_RESERVE;
  return Math.max(0, Math.min(ceiling, affordable));
}
