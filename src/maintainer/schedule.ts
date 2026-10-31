// Cron-string dispatch for the maintainer's wakes (clerk, judgment, and the daily loop). Kept as its own
// tiny pure module rather than inline in index.ts's scheduled() handler so
// it is directly testable without importing the Worker's default export
// (no other test in this repo reaches into index.ts, and this keeps that
// precedent).
//
// Defaults ratified by Ben, 2026-08-07 evening (MAINTAINER-RUNTIME-DESIGN.md
// S9): clerk daily 06:00 UTC, judgment Sundays 07:00 UTC. The cron string
// below was written under the Unix day-of-week convention (1=Monday), but
// Cloudflare parses day-of-week Quartz-style (1-7, 1=Sunday), so it has
// always actually fired Sundays -- D-021 (DECISIONS.md), a docs-only
// correction: nothing about the schedule itself changed, only what this
// comment calls it.

export const CLERK_CRON = "0 6 * * *";
export const JUDGMENT_CRON = "0 7 * * 1";
// The daily loop (src/maintainer/loop.ts; Ben's ruling 1 of D-074's 8 Oct fourth note, shape per BEN-ASKS 9 Oct item 2): one scheduled
// question a day, as a comment on a standing topic, at 12:00 UTC. Its own cron so it never takes budget from the 06:00 clerk wake, and
// it runs neither the concierge, the guest check, the reconciler nor the clerk: the governance sweep (every wake) and nothing else.
//
// DEFERRED-LOOP-CRON-REGISTRATION: the worker only fires this if wrangler.jsonc's triggers.crons carries the string. That file is under a project
// deny rule for edits by the builder, so the line is applied by the hub with Ben's per-action approval (a verified patch is named in
// docs/CHECKPOINT-DAILY-LOOP-RULE7-STATUS.md note 2). Tripwire: test/guest-check-d1.test.ts "the cron registration" is red until it is there.
export const LOOP_CRON = "0 12 * * *";

// D-079 (docs/BRIEF-MODEL-CALL-RETRY.md Part B, R6, R14, R19): the CATCH-UP wakes. Half an hour after the clerk and judgment crons, a separate
// invocation reads ONE row and runs the wake again only when the morning's wake ended on a model-call failure a fresh invocation could cure
// (maintainer_runs.model_retry begins `rerun:`). Otherwise it does nothing: no row, no model call. A separate invocation is a chance of a different
// placement, not a certainty (whether a 06:30 invocation leaves from a different data centre than the 06:00 one is belief, not known).
//
// DEFERRED-CATCHUP-CRON-REGISTRATION: the worker fires these only if wrangler.jsonc's triggers.crons carries the strings; that file is the operator's,
// so the line is Ben's to apply before the deploy script's $REVIEWED_COMMIT is set. Until then they are inert code. The numeric day-of-week follows
// JUDGMENT_CRON (Quartz numbering, 1 = Sunday).
export const CLERK_CATCHUP_CRON = "30 6 * * *";
export const JUDGMENT_CATCHUP_CRON = "30 7 * * 1";

export type WakeKind = "clerk" | "judgment" | "loop" | "clerk_catchup" | "judgment_catchup";

// Pure. Unrecognised cron strings return null rather than throwing --
// wrangler.jsonc's triggers.crons is the only thing that can ever invoke
// scheduled(), so in practice only the three strings above ever arrive, but a
// dispatch table that answers "nothing to do" for anything else is safer
// than one that assumes its own completeness.
export function classifyCron(cron: string): WakeKind | null {
  if (cron === CLERK_CRON) return "clerk";
  if (cron === JUDGMENT_CRON) return "judgment";
  if (cron === LOOP_CRON) return "loop";
  if (cron === CLERK_CATCHUP_CRON) return "clerk_catchup";
  if (cron === JUDGMENT_CATCHUP_CRON) return "judgment_catchup";
  return null;
}
