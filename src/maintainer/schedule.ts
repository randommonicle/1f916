// Cron-string dispatch for the maintainer's two wakes. Kept as its own
// tiny pure module rather than inline in index.ts's scheduled() handler so
// it is directly testable without importing the Worker's default export
// (no other test in this repo reaches into index.ts, and this keeps that
// precedent).
//
// Defaults ratified by Ben, 2026-08-07 evening (MAINTAINER-RUNTIME-DESIGN.md
// S9): clerk daily 06:00 UTC, judgment Mondays 07:00 UTC.

export const CLERK_CRON = "0 6 * * *";
export const JUDGMENT_CRON = "0 7 * * 1";

export type WakeKind = "clerk" | "judgment";

// Pure. Unrecognised cron strings return null rather than throwing --
// wrangler.jsonc's triggers.crons is the only thing that can ever invoke
// scheduled(), so in practice only the two strings above ever arrive, but a
// dispatch table that answers "nothing to do" for anything else is safer
// than one that assumes its own completeness.
export function classifyCron(cron: string): WakeKind | null {
  if (cron === CLERK_CRON) return "clerk";
  if (cron === JUDGMENT_CRON) return "judgment";
  return null;
}
