// The catch-up wakes (docs/BRIEF-MODEL-CALL-RETRY.md Part B, D-079). Recognised at the TOP of scheduled(), before the unconditional governance
// sweep (R14): when the morning's wake did not end on a rerunnable model-call failure, the whole invocation is ONE D1 read and a log line.
//
// When it does run (R19) it runs the sweep (idempotent: the failed wake's sweep already ran, a second finds nothing due) and then the plain wake for
// that kind directly, with the sweep's cost as priorCost. It does NOT run the concierge, the guest check or the reconciler: each writes a daily row or
// spends a budget the 06:00 invocation already used.
//
// Named residual (R22): handleManualTrigger has no single-flight claim (trigger.ts), so a manual wake started between this read and the wake below can
// run alongside it. The worst outcome is one duplicate wake, whose duplicate drafts are visible under M2 (clerk.ts). No claim table in this wave.
// Named residual (R6): an open row (a wake in flight, or killed before it finalised) stops the catch-up too, so a killed wake is not caught up.

import { type Env, utcMidnight } from "../society.ts";
import { runGovernanceSweep, SWEEP_COHORT_CAP } from "../governance.ts";
import { CATCHUP_PRECHECK_COST, estimateSweepCost } from "./budget.ts";
import { runClerkWake } from "./clerk.ts";
import { runJudgmentWake } from "./judgment.ts";

export type CatchupKind = "clerk" | "judgment";

// D1-touching, exactly one read. True only when the NEWEST row of this kind started since UTC midnight is finished and its audit begins `rerun:`.
// A later successful manual wake is the newest row and so stops it; a 401 (note null) never triggers it (R15, R18).
export async function catchupWanted(env: Pick<Env, "DB">, kind: CatchupKind, now: number): Promise<boolean> {
  const row = await env.DB.prepare("SELECT finished_at, model_retry FROM maintainer_runs WHERE kind = ? AND started_at >= ? ORDER BY started_at DESC, id DESC LIMIT 1")
    .bind(kind, utcMidnight(now))
    .first<{ finished_at: number | null; model_retry: string | null }>();
  return row != null && row.finished_at != null && row.model_retry != null && row.model_retry.startsWith("rerun:");
}

// Never throws: scheduled() relies on that. Logs one structured line per outcome.
export async function runCatchup(env: Env, kind: CatchupKind, cron: string, now = Date.now()): Promise<void> {
  try {
    if (!(await catchupWanted(env, kind, now))) {
      console.log(JSON.stringify({ level: "info", event: "catchup_skipped", kind, cron }));
      return;
    }
    console.log(JSON.stringify({ level: "info", event: "catchup_running", kind, cron }));
    let priorCost = estimateSweepCost(SWEEP_COHORT_CAP) + CATCHUP_PRECHECK_COST;
    try {
      priorCost = estimateSweepCost((await runGovernanceSweep(env)).processed) + CATCHUP_PRECHECK_COST;
    } catch (e) {
      console.log(JSON.stringify({ level: "error", event: "governance_sweep_failed", cron, message: String(e) }));
    }
    if (kind === "clerk") await runClerkWake(env, undefined, priorCost);
    else await runJudgmentWake(env, undefined, priorCost);
  } catch (e) {
    console.log(JSON.stringify({ level: "error", event: "catchup_failed", kind, cron, message: String(e) }));
  }
}
