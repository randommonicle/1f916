// The parked list (drafts/BRIEF-PARKED-LIST-2026-11-16.md, D-083; migration 0028_maintainer_declines.sql).
//
// The judgment wake records each model decline of a queue item (judgment.ts, the refusal branch). An item that is still pending and has at least PARK_AFTER
// recorded declines is PARKED: the wake no longer offers it to the model. GET /api/maintainer/parked serves one row per item with a recorded decline.
//
// One definition of "eligible" lives here and nowhere else: DECLINES_UNDER_PARK_SQL. The judgment queue scan (both cursor variants), the overflow baseline, the
// cursor trigger and the "nothing pending" skip all go through it (judgment.ts); the route derives `parked` from the same PARK_AFTER.

import type { Env } from "../society.ts";
import { parseNumberParam } from "../queryParams.ts";

// Ruling R1 (Ben, 16 Nov 2026): two recorded declines park an item.
export const PARK_AFTER = 2;

// Where the record starts. Nothing is backfilled: the one decline before it (15 November 2026) is named only in that wake's row on GET /api/maintainer-runs.
// MUST be re-set to the deploy date at pin time.
export const PARKED_SINCE = "17 November 2026";

// A queue row (alias-free: the statement selects FROM maintainer_queue) has fewer than PARK_AFTER recorded declines.
export const DECLINES_UNDER_PARK_SQL = `(SELECT COUNT(*) FROM maintainer_declines d WHERE d.queue_id = maintainer_queue.id) < ${PARK_AFTER}`;

// The eligible pending cohort: pending, and under PARK_AFTER recorded declines. The approved-row reconciliation is NOT filtered by this.
export const ELIGIBLE_PENDING_SQL = `status = 'pending' AND ${DECLINES_UNDER_PARK_SQL}`;

// DEFERRED-PARKED-HAND-DECISION-ROUTE (ruling R3a, 16 Nov 2026): a maintainer-secret route to decide a parked item by hand would be a new authority-bearing write and needs its own
// brief, so a person decides a parked item by raw SQL under the live-data-surgery protocol, and this list says "decided" without saying by whom. It would land beside the route below.

// One statement, one subrequest. A second write for the same (item, wake) writes nothing.
export async function recordDecline(env: Pick<Env, "DB">, queueId: number, runId: number, now: number): Promise<void> {
  await env.DB.prepare("INSERT INTO maintainer_declines (queue_id, run_id, declined_at) VALUES (?, ?, ?) ON CONFLICT (queue_id, run_id) DO NOTHING").bind(queueId, runId, now).run();
}

export const PARKED_PAGE = 50;
export const PARKED_MAX_LIMIT = 100;

export const PARKED_NOTE =
  `Counts are of recorded declines since ${PARKED_SINCE}: a judgment wake records a decline when the model declines to judge a queued item, and a failed write can leave a decline unrecorded, so a count can be lower than the number of times the model declined. ` +
  `An item is parked (parked: true) while it is pending with at least ${PARK_AFTER} recorded declines; a parked item is not offered to the model again. A parked item waits for the operator, and no response time is promised. ` +
  `An item stops being parked when it is decided: by the model on a later wake (only while it is under ${PARK_AFTER} recorded declines), by a person, or, for a bulletin draft only, by the existing seven-day expiry of pending bulletin drafts. This list does not say which: it shows the status and decided_at. ` +
  `declining_runs are wake ids; each is a row on GET /api/maintainer-runs, and a declining run may be unfinished (a wake that stopped after the decline was recorded). ` +
  `Nothing before ${PARKED_SINCE} is listed: one item declined on 15 November 2026 is named only in that wake's row on GET /api/maintainer-runs. ` +
  `The item's text, target and reason are not served. total is every item with at least one recorded decline, whatever its status; parked_now is those currently parked. Rows run by id ascending; page with after=<next_cursor>.`;

export interface ParkedRow {
  id: number;
  kind: string;
  first_declined_at: number;
  last_declined_at: number;
  declines: number;
  declining_runs: number[];
  parked: boolean;
  status: string;
  decided_at: number | null;
}

export async function parkedPage(env: Pick<Env, "DB">, afterRaw: string | null, limitRaw: string | null) {
  const after = parseNumberParam(afterRaw, 0);
  const afterId = Number.isFinite(after) && after > 0 ? Math.floor(after) : 0;
  const lim = parseNumberParam(limitRaw, PARKED_PAGE);
  const limit = Number.isFinite(lim) ? Math.min(PARKED_MAX_LIMIT, Math.max(1, Math.floor(lim))) : PARKED_PAGE;

  const totals = await env.DB.prepare(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(CASE WHEN status = 'pending' AND n >= ${PARK_AFTER} THEN 1 ELSE 0 END), 0) AS parked_now
       FROM (SELECT q.status AS status, COUNT(*) AS n FROM maintainer_queue q JOIN maintainer_declines d ON d.queue_id = q.id GROUP BY q.id)`,
  ).first<{ total: number; parked_now: number }>();

  const { results } = await env.DB.prepare(
    `SELECT q.id AS id, q.kind AS kind, q.status AS status, q.decided_at AS decided_at,
            MIN(d.declined_at) AS first_declined_at, MAX(d.declined_at) AS last_declined_at, COUNT(*) AS declines,
            GROUP_CONCAT(d.run_id) AS runs
       FROM maintainer_queue q JOIN maintainer_declines d ON d.queue_id = q.id
      WHERE q.id > ?
      GROUP BY q.id
      ORDER BY q.id ASC
      LIMIT ?`,
  )
    .bind(afterId, limit + 1)
    .all<{ id: number; kind: string; status: string; decided_at: number | null; first_declined_at: number; last_declined_at: number; declines: number; runs: string }>();

  const has_more = results.length > limit;
  const page = has_more ? results.slice(0, limit) : results;
  const items: ParkedRow[] = page.map((r) => ({
    id: Number(r.id),
    kind: r.kind,
    first_declined_at: Number(r.first_declined_at),
    last_declined_at: Number(r.last_declined_at),
    declines: Number(r.declines),
    declining_runs: String(r.runs).split(",").map(Number).sort((a, b) => a - b),
    parked: r.status === "pending" && Number(r.declines) >= PARK_AFTER,
    status: r.status,
    decided_at: r.decided_at == null ? null : Number(r.decided_at),
  }));
  return {
    note: PARKED_NOTE,
    since: PARKED_SINCE,
    park_after: PARK_AFTER,
    total: Number(totals?.total ?? 0),
    parked_now: Number(totals?.parked_now ?? 0),
    returned: items.length,
    has_more,
    next_cursor: has_more ? items[items.length - 1].id : null,
    items,
  };
}
