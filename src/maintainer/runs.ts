// Shared helpers for maintainer_runs: both wakes write one row per run
// (insertMaintainerRun), and GET /api/maintainer-runs reads them back
// (maintainerRunsPage). Kept as its own file rather than owned by either
// clerk.ts or judgment.ts, since both write here and neither should have
// to import the other's module just to log its own outcome.
//
// maintainer_runs is a plain table, not chained -- see
// migrations/0004_maintainer_runtime.sql's header for why. Plain INSERT is
// correct here, unlike appendChained elsewhere in this codebase.

import type { Env } from "../society.ts";

export interface RunFields {
  kind: "clerk" | "judgment";
  startedAt: number;
  finishedAt?: number;
  tokensIn?: number;
  tokensOut?: number;
  costEstimateCents?: number;
  itemsDrafted?: number;
  itemsActioned?: number;
  overflowDropped?: number;
  skippedReason?: string;
  error?: string;
  cursorAdvancedTo?: number;
}

// D1-touching. Every call site in clerk.ts/judgment.ts writes exactly one
// of these per wake, success or failure -- "both wrapped so any throw
// lands in the runs row's error column" (the build brief) means this is
// the write that must never itself be skipped.
export async function insertMaintainerRun(env: Pick<Env, "DB">, fields: RunFields): Promise<number> {
  const res = await env.DB.prepare(
    `INSERT INTO maintainer_runs
      (kind, started_at, finished_at, tokens_in, tokens_out, cost_estimate_cents, items_drafted, items_actioned, overflow_dropped, skipped_reason, error, cursor_advanced_to)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING id`,
  )
    .bind(
      fields.kind,
      fields.startedAt,
      fields.finishedAt ?? null,
      fields.tokensIn ?? null,
      fields.tokensOut ?? null,
      fields.costEstimateCents ?? null,
      fields.itemsDrafted ?? null,
      fields.itemsActioned ?? null,
      fields.overflowDropped ?? 0,
      fields.skippedReason ?? null,
      fields.error ?? null,
      fields.cursorAdvancedTo ?? null,
    )
    .first<{ id: number }>();
  return res!.id;
}

// The public accountability surface (design doc S2): "the books-are-public
// ethos applies to the maintainer's own cost line". Mirrors
// citizenDirectory's / changes()'s honest-cap-with-has_more shape rather
// than payoutsPage's/treasury()'s bare LIMIT-200-and-stop, since the task
// specifically asked for has_more here.
export const RUNS_PAGE = 50;

export async function maintainerRunsPage(env: Pick<Env, "DB">, before?: number) {
  const hasBefore = Number.isFinite(before);
  const stmt = hasBefore
    ? env.DB.prepare("SELECT * FROM maintainer_runs WHERE started_at < ? ORDER BY started_at DESC LIMIT ?").bind(before, RUNS_PAGE + 1)
    : env.DB.prepare("SELECT * FROM maintainer_runs ORDER BY started_at DESC LIMIT ?").bind(RUNS_PAGE + 1);
  const { results } = await stmt.all<{ started_at: number }>();
  const has_more = results.length > RUNS_PAGE;
  const runs = has_more ? results.slice(0, RUNS_PAGE) : results;
  return {
    note:
      "Every clerk (daily) and judgment (weekly) wake writes one row here, success or failure. skipped_reason is set (and cost is zero) on a day with nothing to do -- 'no api key' means the office is dry, not broken. error is set when a wake threw; it still wrote this row rather than failing silently. This is the maintainer's own line in the books-are-public ethos: GET /treasury for money, this for the cognition that runs the place.",
    returned: runs.length,
    page_size: RUNS_PAGE,
    has_more,
    ...(has_more ? { next_before: runs[runs.length - 1].started_at } : {}),
    runs,
  };
}
