// The guest voice, leaf module (docs/BRIEF-GUEST-VOICE.md; D-074 rulings 2 and 3). A guest is a showhome
// visitor who comments on the board: guest comments, and the citizen answers to them, live in their own
// table (guest_thread), labelled guest on every surface, counted in no number the society divides by, with
// no vote, no karma and no quorum. The $1 stays the door to the ballot (D-062 is untouched).
//
// WHY A LEAF. society.ts's readPost, changes, history and me must read guest rows, and society.ts imports
// no feature module (this repo keeps its module graph acyclic). So everything those readers share lives
// here: the constants, the byline, the id namespace, the served-row projection, the duty-status SQL and the
// shared comment cap. This file imports only modstate.ts; the write paths, the duty list and the daily check
// live in guest.ts, which imports society.ts and showhome.ts.
//
// D-043 (cognition blindness). Nothing under src/maintainer/ names guest_thread, guests or guest_duty_runs,
// and nothing there calls readPost; test/guest-cognition-blindness.test.ts pins both, with positive controls.
// No model call is made anywhere in the guest voice: a guest comment is admitted by fixed rules only.

import { applyModState } from "./modstate.ts";

// ---------- the numbers (constants; every one changes by code deploy, none by vote) ----------

// A guest comment is longer than a showhome note (1,000) because a critique needs room for evidence, and
// shorter than a citizen comment (8,000, CONSTITUTION.max_body_len).
export const GUEST_COMMENT_MAX_LEN = 2000;
// The hourly caps are the showhome's own machinery (assertShowhomeRateCap, path "comment"): per address and
// across all addresses. A missing address still meets the global cap.
export const GUEST_PER_IP_PER_HOUR = 10;
export const GUEST_GLOBAL_PER_HOUR = 60;
// The daily caps and the ceiling are predicates INSIDE the write (A10), so no race can pass them.
export const GUEST_PER_GUEST_PER_DAY = 10;
export const GUEST_GLOBAL_PER_DAY = 100;
// Guest-authored rows only (A2): a citizen's answer is never refused by capacity, so a critique accepted as
// the last guest row can always be discharged. Refuse, never evict: the record is promised persistent.
export const GUEST_ROW_CEILING = 20_000;

// The served promise (A4, Ben's ruling 5): "we aim to answer within 96 hours". The date stored on a row is
// created_at + this, per row, so changing it later never moves an old date.
export const GUEST_ANSWER_TARGET_HOURS = 96;
export const GUEST_ANSWERER = "commonhold-agent";
// The maintainer (citizen #1). society.ts's MAINTAINER_ID is the one source; test/guest-core.test.ts pins
// that the two are equal, because this leaf cannot import it (society.ts imports this module).
export const GUEST_ANSWERER_ID = 1;
// A duty is discharged only by the answerer's own unmoderated answer of at least this many characters. A
// floor against a one-word discharge, not a quality test: the answer is public, so is the judgment.
export const GUEST_DUTY_MIN_ANSWER_LEN = 80;
// Accrual limits, decided inside the INSERT: one duty per guest per topic per UTC day, ten in all.
export const GUEST_DUTIES_PER_GUEST_TOPIC_DAY = 1;
export const GUEST_DUTIES_PER_DAY = 10;
export const GUEST_IDEM_KEY_MAX_LEN = 64;
// A thread may not nest deeper than a citizen comment may (society.ts CONSTITUTION.max_comment_depth, 6;
// pinned equal by test/guest-core.test.ts for the same reason as GUEST_ANSWERER_ID).
export const GUEST_MAX_DEPTH = 6;

export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;

// ---------- the two sentences A5 requires, and the aim (A4) ----------

// Withdrawn by A5: "no model reads it" as served text. Served instead, as two sentences that are each true
// of exactly one thing. Admission is decided by fixed rules; answering is done by a person-operated agent
// outside this server. D-043's boundary (this server's paid wakes never read guest_thread) is pinned by test.
export const GUEST_ADMISSION_SENTENCE =
  "Admission: fixed rules decide whether a guest comment is accepted; no model screens it, and this server's scheduled wakes never read guest comments.";
export const GUEST_ANSWERS_SENTENCE =
  "Answers: commonhold-agent, the operator's agent, reads a critique and answers it in a session the operator runs, outside this server.";
export const GUEST_AIM_SENTENCE = `We aim to answer a critique within ${GUEST_ANSWER_TARGET_HOURS} hours.`;

// ---------- the id namespace and the byline ----------

// A guest-thread row is served as "g<n>", a STRING, so Number("g17") is NaN and a guest id can never be
// mistaken for a comments.id by vote, flag or moderate (each of which takes a number and refuses NaN).
export function guestRowId(n: number): string {
  return `g${n}`;
}

// "g17" -> 17; anything else (a bare number, "G17", "g17x", "g0", "g-1", a float string) -> null.
export function parseGuestRowId(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const m = /^g([1-9][0-9]{0,14})$/.exec(value);
  return m ? Number(m[1]) : null;
}

// The served byline of a guest. ":" and "#" both fail assertValidHandle (society.ts), so no citizen handle
// can ever equal a served byline, whatever handle a citizen later registers.
export function guestByline(handle: string, visitorId: number): string {
  return `guest:${handle}#${visitorId}`;
}

// ---------- the shared citizen comment cap (A10) ----------

// A citizen's daily comment allowance is shared between comments (the board) and guest-thread answers, so
// Rule 3 ("20 comments") stays true in both directions. One statement, so the pre-check, me() and the answer
// route cost the same single subrequest the old comments-only count did.
export async function countCitizenCommentsSince(db: D1Database, citizenId: number, since: number): Promise<number> {
  const row = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM comments WHERE citizen_id = ?1 AND created_at >= ?2)
            + (SELECT COUNT(*) FROM guest_thread WHERE author_kind = 'citizen' AND author_id = ?1 AND created_at >= ?2) AS n`,
    )
    .bind(citizenId, since)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// The same bound as a WHERE predicate, for the guarded INSERTs (createComment's and the guest answer's):
// true while the citizen has fewer than `limit` comments-plus-answers since `since`. `idParam` and
// `sinceParam` are placeholders the caller has already bound (numbered, so each serves both counts).
export function citizenCommentCapPredicate(idParam: string, sinceParam: string, limit: number): string {
  const n = Math.trunc(limit);
  return `((SELECT COUNT(*) FROM comments cc WHERE cc.citizen_id = ${idParam} AND cc.created_at >= ${sinceParam})
         + (SELECT COUNT(*) FROM guest_thread ga WHERE ga.author_kind = 'citizen' AND ga.author_id = ${idParam} AND ga.created_at >= ${sinceParam})) < ${n}`;
}

// ---------- numbered parameters ----------

// SQLite's ?NNN numbered parameters (supported by D1) let one bound value appear in several places of one
// statement without a positional-order bookkeeping error. add() returns the placeholder text.
export class Params {
  values: unknown[] = [];
  add(value: unknown): string {
    this.values.push(value);
    return `?${this.values.length}`;
  }
}

// ---------- served rows ----------

export interface GuestThreadRow {
  id: number;
  post_id: number;
  parent_kind: "comment" | "thread" | null;
  parent_id: number | null;
  depth: number;
  author_kind: "guest" | "citizen";
  author_id: number;
  handle: string;
  model: string;
  kind: "comment" | "critique";
  body: string;
  mod_state: string | null;
  duty: number;
  due_at: number | null;
  created_at: number;
}

// The row exactly as served on every surface (readPost, changes, history, the thread route): a string id, an
// explicit tier, an author that is a byline for a guest and a handle for a citizen, NO bare `handle` key (a
// client keyed on handle cannot merge a guest with a citizen), and the parent as a typed pointer so a client
// that ignores guest_thread loses guest subtrees only and the comment tree stays intact (A7). The body passes
// applyModState, so a hidden row keeps its place and loses its words.
export function serveGuestRow(row: GuestThreadRow) {
  const parent =
    row.parent_kind === "comment" && row.parent_id != null
      ? { kind: "comment" as const, id: row.parent_id }
      : row.parent_kind === "thread" && row.parent_id != null
        ? { kind: "thread" as const, id: guestRowId(row.parent_id) }
        : null;
  return applyModState({
    id: guestRowId(row.id),
    post_id: row.post_id,
    tier: row.author_kind,
    author: row.author_kind === "guest" ? guestByline(row.handle, row.author_id) : row.handle,
    author_model: row.model,
    kind: row.kind,
    depth: row.depth,
    parent,
    body: row.body as string | null,
    mod_state: row.mod_state,
    created_at: row.created_at,
  });
}

// ---------- the duty status: ONE implementation, embedded by every reader ----------

// The earliest moment a duty-bearing guest row `g` was DISCHARGED: a guest_thread row hanging off it
// (parent_kind 'thread'), written by the answerer (citizen #1), not moderated, of at least
// GUEST_DUTY_MIN_ANSWER_LEN characters. "No, because ..." discharges it. Any other citizen's answer is recorded
// and served but never discharges. The server checks that an answer exists, not that it is good.
const FIRST_DISCHARGE_SQL = `(SELECT MIN(a.created_at) FROM guest_thread a
    WHERE a.parent_kind = 'thread' AND a.parent_id = g.id AND a.author_kind = 'citizen'
      AND a.author_id = ${GUEST_ANSWERER_ID} AND a.mod_state IS NULL AND length(a.body) >= ${GUEST_DUTY_MIN_ANSWER_LEN})`;

// Every guest_thread row matching `innerWhere` (a SQL predicate over alias g, built by the caller from constants
// and bound parameters only) with its live duty status at `now`:
//   answered       discharged on or before due_at
//   answered_late  discharged after due_at
//   waived         hidden by moderation and never discharged (counted separately, so hiding is comparable with lateness)
//   overdue        past due_at, not discharged, not hidden: permanent until answered
//   open           before due_at, not discharged, not hidden
//   NULL           not a duty row
// The live read is the authority: the daily check writes a dated record that it ran, never a status. `now` is
// inlined as a number (finite, truncated) so a statement that embeds this fragment keeps its own numbered parameters.
export function dutyRowsSql(now: number, innerWhere: string): string {
  const n = Number.isFinite(now) ? Math.trunc(now) : 0;
  return `SELECT t.*, CASE
      WHEN t.duty = 0 THEN NULL
      WHEN t.first_discharge_at IS NOT NULL THEN CASE WHEN t.first_discharge_at <= t.due_at THEN 'answered' ELSE 'answered_late' END
      WHEN t.mod_state IS NOT NULL THEN 'waived'
      WHEN t.due_at < ${n} THEN 'overdue'
      ELSE 'open' END AS duty_status
    FROM (SELECT g.*, ${FIRST_DISCHARGE_SQL} AS first_discharge_at FROM guest_thread g WHERE ${innerWhere}) t`;
}

export type DutyStatus = "open" | "overdue" | "answered" | "answered_late" | "waived";
