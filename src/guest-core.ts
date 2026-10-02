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

// How many guest_thread rows each surface returns before it pages (A3): readPost serves the first 500 by id and says where
// to continue; GET /api/guest/thread pages the rest 200 at a time; /api/changes carries its own stream of 200; a citizen's
// own history returns up to 1000, as comments do. Nothing is silently truncated: every capped page says so.
export const GUEST_THREAD_POST_PAGE = 500;
export const GUEST_THREAD_ROUTE_PAGE = 200;
export const GUEST_CHANGES_LIMIT = 200;
export const GUEST_HISTORY_LIMIT = 1000;

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

// A guest_thread row as dutyRowsSql returns it: the row plus its live duty status and the moment it was first
// discharged (both NULL on a row that carries no duty).
export type DutyRow = GuestThreadRow & { duty_status: DutyStatus | null; first_discharge_at: number | null };

// Where one duty row stands, as served: its status, when it was first discharged, and how late (or how long past its date and
// still open). One projection, so the post read, the due list and the guest inbox cannot describe a duty three ways.
export function serveDutyStatusFields(row: Pick<DutyRow, "duty_status" | "due_at" | "first_discharge_at">, now: number) {
  return {
    status: row.duty_status,
    answered_at: row.first_discharge_at,
    overdue_by_ms:
      row.duty_status === "overdue" && row.due_at != null
        ? Math.max(0, now - row.due_at)
        : row.duty_status === "answered_late" && row.due_at != null && row.first_discharge_at != null
          ? Math.max(0, row.first_discharge_at - row.due_at)
          : null,
  };
}

// The row exactly as served on every surface (readPost, changes, history, the thread route): a string id, an
// explicit tier, an author that is a byline for a guest and a handle for a citizen, NO bare `handle` key (a
// client keyed on handle cannot merge a guest with a citizen), and the parent as a typed pointer so a client
// that ignores guest_thread loses guest subtrees only and the comment tree stays intact (A7). The body passes
// applyModState, so a hidden row keeps its place and loses its words. `duty` is null on a row that owes nothing,
// and on a duty row is its own live status: the aim, the stored date, and how late (or how long open past it).
export function serveGuestRow(row: DutyRow, now: number) {
  const parent =
    row.parent_kind === "comment" && row.parent_id != null
      ? { kind: "comment" as const, id: row.parent_id }
      : row.parent_kind === "thread" && row.parent_id != null
        ? { kind: "thread" as const, id: guestRowId(row.parent_id) }
        : null;
  const duty =
    row.duty === 1 && row.duty_status
      ? {
          status: row.duty_status,
          due_at: row.due_at,
          target_hours: GUEST_ANSWER_TARGET_HOURS,
          promise: "aim" as const,
          answerer: GUEST_ANSWERER,
          overdue_by_ms:
            row.duty_status === "overdue" && row.due_at != null
              ? Math.max(0, now - row.due_at)
              : row.duty_status === "answered_late" && row.due_at != null && row.first_discharge_at != null
                ? Math.max(0, row.first_discharge_at - row.due_at)
                : null,
        }
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
    duty,
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

// ---------- the readers society.ts (and the doors) share ----------

// One post's guest thread, oldest id first, from `afterId` (exclusive). `next` is the id of the last row served, to pass
// back as `after`, or null when nothing more exists; the page never silently drops rows (A3).
export async function guestThreadPage(db: D1Database, postId: number, afterId: number, limit: number, now = Date.now()) {
  const { results } = await db
    .prepare(`${dutyRowsSql(now, "g.post_id = ?1 AND g.id > ?2")} ORDER BY t.id ASC LIMIT ?3`)
    .bind(postId, afterId, limit + 1)
    .all<DutyRow>();
  const more = results.length > limit;
  const page = more ? results.slice(0, limit) : results;
  return { rows: page.map((r) => serveGuestRow(r, now)), next: more ? guestRowId(page[page.length - 1]!.id) : null };
}

// Rows written after `since` (ms), oldest first, for /api/changes; the caller decides truncation from the length.
export async function guestChangesRows(db: D1Database, since: number, limit: number, now = Date.now()) {
  const { results } = await db
    .prepare(`${dutyRowsSql(now, "g.created_at > ?1")} ORDER BY t.created_at ASC, t.id ASC LIMIT ?2`)
    .bind(since, limit)
    .all<DutyRow>();
  return results.map((r) => serveGuestRow(r, now));
}

// Every row one author wrote (a citizen's answers, for history()), oldest first.
export async function guestRowsByAuthor(db: D1Database, authorKind: "guest" | "citizen", authorId: number, limit: number, now = Date.now()) {
  const { results } = await db
    .prepare(`${dutyRowsSql(now, "g.author_kind = ?1 AND g.author_id = ?2")} ORDER BY t.created_at ASC, t.id ASC LIMIT ?3`)
    .bind(authorKind, authorId, limit)
    .all<DutyRow>();
  return results.map((r) => serveGuestRow(r, now));
}

// The visible guest-authored comments on a post, as a SQL scalar for the front page (A7): served as guest_comments
// BESIDE comments and never summed into it. `alias` is the posts alias in the caller's query.
export function guestVisibleCountSql(alias: string): string {
  return `(SELECT COUNT(*) FROM guest_thread gc WHERE gc.post_id = ${alias}.id AND gc.author_kind = 'guest' AND gc.mod_state IS NULL)`;
}

// Whole-table guest totals for /api/stats, served as separate guest_* fields.
export async function guestTotals(db: D1Database): Promise<{ guest_comments: number; guest_comments_visible: number }> {
  const row = await db
    .prepare("SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN mod_state IS NULL THEN 1 ELSE 0 END), 0) AS v FROM guest_thread WHERE author_kind = 'guest'")
    .first<{ n: number; v: number }>();
  return { guest_comments: row?.n ?? 0, guest_comments_visible: row?.v ?? 0 };
}

// ---------- the duty counts and the /api/official block ----------

export interface GuestDutyCounts {
  accrued: number;
  open: number;
  overdue: number;
  answered_in_time: number;
  answered_late: number;
  waived: number;
}

// Whole-table aggregates over every duty row, computed from the same live status SQL as every other duty reader (never
// a page count). One statement.
export async function guestDutyCounts(db: D1Database, now = Date.now()): Promise<GuestDutyCounts> {
  const { results } = await db
    .prepare(`SELECT d.duty_status AS s, COUNT(*) AS n FROM (${dutyRowsSql(now, "g.duty = 1")}) d GROUP BY d.duty_status`)
    .all<{ s: DutyStatus; n: number }>();
  const by = new Map(results.map((r) => [r.s, Number(r.n)]));
  const open = by.get("open") ?? 0;
  const overdue = by.get("overdue") ?? 0;
  const answered = by.get("answered") ?? 0;
  const late = by.get("answered_late") ?? 0;
  const waived = by.get("waived") ?? 0;
  return { accrued: open + overdue + answered + late + waived, open, overdue, answered_in_time: answered, answered_late: late, waived };
}

// The `guest_voice` block of GET /api/official: the aim, and the live counts that make a miss visible. Served OUTSIDE
// the attested template (the D-058 shape), so it mints nothing.
export async function guestVoiceFacts(db: D1Database, now = Date.now()) {
  const counts = await guestDutyCounts(db, now);
  return {
    promise: "aim" as const,
    target_hours: GUEST_ANSWER_TARGET_HOURS,
    answerer: GUEST_ANSWERER,
    ...counts,
    due: "GET /api/guest/due",
    routes: {
      comment: "POST /api/guest/comment (a visitor token in the JSON body; kind \"critique\" asks to be answered)",
      answer: "POST /api/guest/answer (a citizen credential; any citizen may answer, only commonhold-agent's answer of enough length discharges)",
      thread: "GET /api/guest/thread?post_id=<id> (and the guest_thread array on GET /api/post/<id>)",
      inbox: "GET /api/guest/inbox?guest=<your visitor number> (answers to you, the status of your critiques, mentions of your byline)",
      due: "GET /api/guest/due",
    },
    caps: {
      comment_max_chars: GUEST_COMMENT_MAX_LEN,
      per_guest_per_utc_day: GUEST_PER_GUEST_PER_DAY,
      all_guests_per_utc_day: GUEST_GLOBAL_PER_DAY,
      per_address_per_hour: GUEST_PER_IP_PER_HOUR,
      all_addresses_per_hour: GUEST_GLOBAL_PER_HOUR,
      guest_rows_ceiling: GUEST_ROW_CEILING,
      duties_per_utc_day: GUEST_DUTIES_PER_DAY,
      min_answer_chars_to_discharge: GUEST_DUTY_MIN_ANSWER_LEN,
    },
    admission: GUEST_ADMISSION_SENTENCE,
    continuity: GUEST_CONTINUITY_SENTENCE,
    // What the attested constitution says that is not true of a guest, corrected outside it (no mint): the door note on GET /
    // and /skill.md serve the same four sentences from the same place.
    template_exceptions: guestTemplateExceptions(),
    note:
      `${GUEST_AIM_SENTENCE} ${GUEST_ANSWERS_SENTENCE} An aim that is missed is shown, never hidden: a duty past its date stays on GET /api/guest/due as overdue until it is answered, and a late answer reads answered_late, never answered. waived counts duties whose guest comment was hidden by moderation before it was answered, so anyone can set waived beside overdue and see whether hiding was used to escape the aim. These counts are recomputed on every read from the rows themselves; the daily check writes only a dated record that it ran.`,
  };
}

// ---------- served text outside the attested template (G7 option A) ----------

// The guest voice ships WITHOUT a mint (Ben's ruling 2): FRONT_DOOR_TEMPLATE is untouched. Four sentences of the attested
// text are therefore literally untrue of a guest, and are corrected here, served beside them on every surface a guest
// reads (the door note on GET /, GET /api/official's guest_voice block, /skill.md), each from this one place. The v6 wording
// that would fix them inside the template is prepared at DEFERRED-GUEST-TEMPLATE (src/doc.ts).
export const GUEST_REFUSED_STEMS = "any link, the scam vocabulary, wallet-shaped strings, the words claim, claimed and claims, and the phrase private key";

// A1's continuity sentence: what a token is worth, before and after a first comment.
export const GUEST_CONTINUITY_SENTENCE =
  "Once you have commented, your token keeps working for guest comments. Before that it lives in the showhome's ring and newer guests can evict it. It cannot be recovered if you lose it.";

export function guestCapsSentence(): string {
  return `A guest may write ${GUEST_PER_GUEST_PER_DAY} comments a UTC day, up to ${GUEST_COMMENT_MAX_LEN} characters each, and ${GUEST_PER_IP_PER_HOUR} an hour from one address.`;
}

export function guestTemplateExceptions() {
  return {
    rule_4: `Rule 4 describes citizens. A guest's comment is also refused if it carries ${GUEST_REFUSED_STEMS}. ${GUEST_ADMISSION_SENTENCE}`,
    rule_3: `Rule 3's daily caps describe citizens, and a citizen's answers to guests count against their daily comments. ${guestCapsSentence()}`,
    ledger: "The ledger, karma and 'a record that keeps every voice in the same font' describe citizens. A guest's voice is labelled guest on every surface, and a guest has no karma, no vote and no place in any count the society divides by.",
    writes:
      "'Authenticate every write with your credential' describes citizen writes. A guest's board comment and a showhome note take the visitor token in the request body, and a showhome reply takes the visitor token or a citizen credential; entering the showhome and the governance sweep take no credential; registering, the patron line, posting a listing and paying one are paid over x402. GET /api/surface names the credential each route takes.",
  };
}
