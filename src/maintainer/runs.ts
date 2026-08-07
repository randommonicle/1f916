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
import { parseNumberParam } from "../queryParams.ts";

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
  // M5, review fix: clerk only. The on-chain-vs-booked drift this run
  // observed. null (explicit or omitted -- both bind to SQL NULL) means
  // "could not read live this run", never a guessed 0; judgment never
  // sets this at all. See shouldSkipIdleClerkWake in clerk.ts.
  driftDeltaCents?: number | null;
}

// L8, review fix (NaN guard): NaN/Infinity/-Infinity have no SQLite
// representation. Anything derived from an upstream number this codebase
// does not fully control (Anthropic's own usage.input_tokens/output_tokens,
// or arithmetic over them) could in principle produce one, and binding it
// to D1 would either throw at the driver level or store something
// meaningless -- neither of which is the honest "we don't have a real
// number for this" signal every other optional numeric field already
// uses. Coerced to null, same as an omitted field. null/undefined pass
// through unchanged; only applied to the OPTIONAL numeric fields below --
// `kind` and `startedAt` are required, always Date.now() in every real
// call site, and started_at is NOT NULL in the schema, so coercing IT to
// null would only trade one failure for a less diagnosable one.
export function finiteOrNull(n: number | null | undefined): number | null {
  if (n == null) return null;
  return Number.isFinite(n) ? n : null;
}

// D1-touching. Every call site in clerk.ts/judgment.ts writes exactly one
// of these per wake, success or failure -- "both wrapped so any throw
// lands in the runs row's error column" (the build brief) means this is
// the write that must never itself be skipped.
export async function insertMaintainerRun(env: Pick<Env, "DB">, fields: RunFields): Promise<number> {
  const res = await env.DB.prepare(
    `INSERT INTO maintainer_runs
      (kind, started_at, finished_at, tokens_in, tokens_out, cost_estimate_cents, items_drafted, items_actioned, overflow_dropped, skipped_reason, error, cursor_advanced_to, drift_delta_cents)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     RETURNING id`,
  )
    .bind(
      fields.kind,
      fields.startedAt,
      finiteOrNull(fields.finishedAt),
      finiteOrNull(fields.tokensIn),
      finiteOrNull(fields.tokensOut),
      finiteOrNull(fields.costEstimateCents),
      finiteOrNull(fields.itemsDrafted),
      finiteOrNull(fields.itemsActioned),
      finiteOrNull(fields.overflowDropped) ?? 0,
      fields.skippedReason ?? null,
      fields.error ?? null,
      finiteOrNull(fields.cursorAdvancedTo),
      finiteOrNull(fields.driftDeltaCents),
    )
    .first<{ id: number }>();
  return res!.id;
}

// M2: the clerk wake reserves a runs row (via insertMaintainerRun, kind +
// startedAt only) BEFORE it writes any maintainer_queue rows -- it has to,
// since queue.run_id is a NOT NULL foreign key to this table -- and
// finalizes that SAME row afterward, once it knows how many queue rows
// actually landed. A row left unfinalized (finished_at still NULL) reads
// exactly as the finished_at column's own comment already anticipates: a
// process that started and did not get to record its own outcome.
export type RunUpdateFields = Omit<RunFields, "kind" | "startedAt">;

export async function finalizeMaintainerRun(env: Pick<Env, "DB">, id: number, fields: RunUpdateFields): Promise<void> {
  await env.DB.prepare(
    `UPDATE maintainer_runs
      SET finished_at = ?, tokens_in = ?, tokens_out = ?, cost_estimate_cents = ?, items_drafted = ?, items_actioned = ?, overflow_dropped = ?, skipped_reason = ?, error = ?, cursor_advanced_to = ?, drift_delta_cents = ?
     WHERE id = ?`,
  )
    .bind(
      finiteOrNull(fields.finishedAt),
      finiteOrNull(fields.tokensIn),
      finiteOrNull(fields.tokensOut),
      finiteOrNull(fields.costEstimateCents),
      finiteOrNull(fields.itemsDrafted),
      finiteOrNull(fields.itemsActioned),
      finiteOrNull(fields.overflowDropped) ?? 0,
      fields.skippedReason ?? null,
      fields.error ?? null,
      finiteOrNull(fields.cursorAdvancedTo),
      finiteOrNull(fields.driftDeltaCents),
      id,
    )
    .run();
}

// L6, review fix: url.searchParams.get returns "" for a present-but-empty
// ?before= (e.g. a pagination client whose cursor state starts as an
// empty string before any page has loaded), not null -- so a bare
// `Number(raw ?? NaN)` at the call site never caught it (?? only
// triggers on null/undefined). Number("") is 0, not NaN, so an empty
// ?before= silently meant "runs older than started_at=0" (an
// always-empty result, since no run is that old) rather than "no
// cursor, first page". Pure so index.ts's route can call it and this can
// still be unit tested despite index.ts itself having no test file.
//
// Follow-up review fix: the same shape turned up at four more call sites
// in index.ts (?limit on /api/front and /api/new, ?since on
// /api/changes and /api/citizens), so the actual check now lives once,
// in the general src/queryParams.ts. This keeps its own name and NaN
// fallback -- "the before cursor, specifically" reads better at its call
// site than a bare parseNumberParam(raw, NaN) would, and every existing
// test written against parseBeforeCursor keeps passing unchanged.
export function parseBeforeCursor(raw: string | null): number {
  return parseNumberParam(raw, NaN);
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
