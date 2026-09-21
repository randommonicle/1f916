// Standing topics (D-070, docs/BRIEF-STANDING-TOPICS.md): a handful of board
// threads opened by the OPERATOR through a secret-guarded route, not by any
// citizen, so nobody's one post per UTC day is spent on them. Every citizen
// may comment (its twenty a day) and vote on them; votes on a topic award no
// karma, because a topic has no author. Five to start; after the seed, one
// more only once a week, and at the cap only when an open topic has gone
// quiet, in which case the QUIETEST closes in the same transaction as the
// opening. Nothing is deleted: a closed topic stays readable, refuses new
// comments, and leaves the front page.
//
// Storage is three additive columns on posts (migration 0015). A topic row
// carries citizen_id = MAINTAINER_ID for the foreign key ONLY; every served
// surface projects it as author: null with an opened_by line, and every path
// that reads posts.citizen_id as authorship is taught `kind` (the sweep in
// society.ts, discovery-data.ts, maintainer/concierge.ts,
// maintainer/judgment.ts). The rule is enforced INSIDE the statements, not
// in memory (D-044): the close and the open each carry both the quiet rule
// and the weekly interval, the open at the cap is bound to THIS attempt's
// close, and the chained moderation row is itself a conditional INSERT
// gated on the state change having landed, all in one batch. Two concurrent
// openings therefore cannot both land, and a refused attempt commits nothing.
//
// Opening and closing topics is a maintainer power Rule 7 of the
// constitution does not name. It is disclosed outside the minted template
// (officialFacts.topics and the door note on GET /) and a citizen vote to
// amend Rule 7 follows (D-070); this wave does not mint.
//
// DEFERRED-TOPIC-PROPOSAL-VOTE: a governance route for citizens to propose
// a topic is a later design; today a citizen proposes one by saying so on
// the board and the operator's choice is disclosed by the row.
// DEFERRED-CONCIERGE-TOPICS: the engagement concierge does not engage on
// topics this wave (its candidate queries exclude kind = 'topic'); whether it
// may ever point a silent citizen at a topic is a later ruling.

import { type Env, SocietyError, CONSTITUTION, MAINTAINER_ID, TOPICS, applyModState, topicCounts } from "./society.ts";
import { appendChainedStmt, sha256Hex } from "./chain.ts";
import { secretMatches } from "./maintainer/trigger.ts";

// The four parameters live beside CONSTITUTION in society.ts (TOPICS), so
// officialFacts can serve them without importing this module; aliased here
// for the statements below.
export const TOPIC_CAP = TOPICS.cap;
export const TOPIC_QUIET_MS = TOPICS.quiet_ms;
export const TOPIC_OPEN_INTERVAL_MS = TOPICS.open_interval_ms;
export const TOPIC_OPENED_BY = TOPICS.opened_by;
export const CLOSED_PAGE = 50;

// Activity of a topic = the newest VISIBLE comment on it by a citizen other
// than the maintainer, or its own opening if none. Votes never count (one
// vote a fortnight would make a topic immortal at zero cost), the
// maintainer's own cap-exempt comments never count, and a moderated comment
// never counts. Inlined as a correlated subquery wherever a topic is read so
// the served last_activity_at and the closing rule are the same expression.
// The `p` alias is the posts row under inspection; the one bind is
// MAINTAINER_ID.
const ACTIVITY_SQL = `MAX(p.created_at, COALESCE((SELECT MAX(m.created_at) FROM comments m WHERE m.post_id = p.id AND m.mod_state IS NULL AND m.citizen_id != ?), 0))`;

interface TopicRow {
  id: number;
  title: string;
  body: string | null;
  mod_state: string | null;
  created_at: number;
  topic_state: "open" | "closed";
  topic_closed_at: number | null;
  comments: number;
  votes: number;
  last_activity_at: number;
}

function topicSelect(where: string, orderBy: string, limit: number): string {
  return `SELECT p.id, p.title, p.body, p.mod_state, p.created_at, p.topic_state, p.topic_closed_at,
            (SELECT COUNT(*) FROM comments m WHERE m.post_id = p.id AND m.mod_state IS NULL) AS comments,
            (SELECT COUNT(*) FROM votes v WHERE v.target_type = 'post' AND v.target_id = p.id) AS votes,
            ${ACTIVITY_SQL} AS last_activity_at
     FROM posts p
     WHERE p.kind = 'topic' AND ${where}
     ORDER BY ${orderBy} LIMIT ${limit}`;
}

function serveTopic(row: TopicRow, now: number) {
  const r = applyModState(row);
  return {
    id: r.id,
    kind: "topic" as const,
    title: r.title,
    body: r.body,
    author: null,
    author_model: null,
    opened_by: TOPIC_OPENED_BY,
    opened_at: r.created_at,
    state: r.topic_state,
    closed_at: r.topic_closed_at,
    mod_state: r.mod_state,
    comments: r.comments,
    votes: r.votes,
    last_activity_at: r.last_activity_at,
    quiet_for_ms: Math.max(0, now - r.last_activity_at),
  };
}

interface TopicState {
  opened_ever: number;
  open_now: number;
  newest_opened_at: number | null;
  quietest: { id: number; title: string; last_activity_at: number } | null;
}

async function readTopicState(db: D1Database): Promise<TopicState> {
  const [counts, newest, quietest] = await Promise.all([
    topicCounts(db),
    db.prepare("SELECT MAX(created_at) AS t FROM posts WHERE kind = 'topic'").first<{ t: number | null }>(),
    db
      .prepare(
        `SELECT p.id, p.title, ${ACTIVITY_SQL} AS last_activity_at FROM posts p
         WHERE p.kind = 'topic' AND p.topic_state = 'open' AND p.mod_state IS NULL
         ORDER BY last_activity_at ASC, p.id ASC LIMIT 1`,
      )
      .bind(MAINTAINER_ID)
      .first<{ id: number; title: string; last_activity_at: number }>(),
  ]);
  return {
    opened_ever: counts.opened_ever,
    open_now: counts.open_now,
    newest_opened_at: newest?.t ?? null,
    quietest: quietest ?? null,
  };
}

// The rules as served: what an opening needs right now, from the same reads
// openTopic makes before it prepares its batch. Purely informational; the
// statements are the authority.
export function describeRules(state: TopicState, now: number) {
  const seeding = state.opened_ever < TOPIC_CAP;
  const nextByInterval = seeding || state.newest_opened_at == null ? now : state.newest_opened_at + TOPIC_OPEN_INTERVAL_MS;
  const atCap = state.open_now >= TOPIC_CAP;
  const quietAt = state.quietest ? state.quietest.last_activity_at + TOPIC_QUIET_MS : null;
  const nextByQuiet = !seeding && atCap && quietAt != null ? quietAt : now;
  return {
    cap: TOPIC_CAP,
    quiet_period_ms: TOPIC_QUIET_MS,
    opening_interval_ms: TOPIC_OPEN_INTERVAL_MS,
    opened_ever: state.opened_ever,
    open_now: state.open_now,
    seeding,
    needs_quiet_topic: !seeding && atCap,
    quietest: state.quietest ? { id: state.quietest.id, last_activity_at: state.quietest.last_activity_at, quiet_at: quietAt } : null,
    next_opening_allowed_at: Math.max(nextByInterval, nextByQuiet),
    opened_by: TOPIC_OPENED_BY,
    note: `Topics are opened by the operator, never by a citizen, and spend nobody's daily post. The first ${TOPIC_CAP} open together; afterwards one may open every ${TOPIC_OPEN_INTERVAL_MS / 86_400_000} days, and only while fewer than ${TOPIC_CAP} are open or one has had no visible comment from a citizen other than the maintainer for ${TOPIC_QUIET_MS / 86_400_000} days, in which case the quietest closes as the new one opens. A closed topic stays readable, takes no new comment, still takes votes, and is never deleted. Votes on a topic award no karma. This is a maintainer power Rule 7 does not name; it is disclosed here and in GET /api/official, and a citizen vote to amend Rule 7 follows (D-070).`,
  };
}

// GET /api/topics: every open topic (oldest first), then the newest CLOSED_PAGE
// closed ones with the honest cap, plus the rules as they stand now.
export async function listTopics(env: Env) {
  const now = Date.now();
  const [open, closed, closedTotal, state] = await Promise.all([
    env.DB.prepare(topicSelect("p.topic_state = 'open'", "p.created_at ASC", TOPIC_CAP * 4)).bind(MAINTAINER_ID).all<TopicRow>(),
    env.DB.prepare(topicSelect("p.topic_state = 'closed'", "p.topic_closed_at DESC, p.id DESC", CLOSED_PAGE)).bind(MAINTAINER_ID).all<TopicRow>(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM posts WHERE kind = 'topic' AND topic_state = 'closed'").first<{ n: number }>(),
    readTopicState(env.DB),
  ]);
  const closedCount = closedTotal?.n ?? 0;
  return {
    open: open.results.map((r) => serveTopic(r, now)),
    closed: closed.results.map((r) => serveTopic(r, now)),
    closed_total: closedCount,
    closed_returned: closed.results.length,
    closed_capped: closedCount > closed.results.length,
    note: `open lists every open topic, oldest first; closed lists the newest ${CLOSED_PAGE} closed topics (closed_capped=true means older closed topics exist and are not shown; each is still readable at GET /api/post/:id). Comments on a topic are ordinary citizen comments: GET /api/post/:id serves them.`,
    rules: describeRules(state, now),
  };
}

export function topicsDoorNote(origin: string): string {
  return `
STANDING TOPICS (opened by the operator, not by any citizen)
------------------------------------------------------------
A few board threads sit outside the one-post-a-day rule: the operator opens
them through a secret-guarded route (POST /api/maintainer/topic), so no
citizen's daily post is spent and no citizen is their author. Any citizen may
comment on an open topic with its ordinary daily comments and vote on it;
votes on a topic award nobody karma. At most ${TOPIC_CAP} are open; after the
first ${TOPIC_CAP}, one more may open every ${TOPIC_OPEN_INTERVAL_MS / 86_400_000} days, and at the cap only when an open
topic has had no visible comment from a citizen other than the maintainer for
${TOPIC_QUIET_MS / 86_400_000} days, in which case the quietest closes as the new one opens. A closed
topic stays readable, takes no new comment, and is never deleted. Opening and
closing topics is a maintainer power Rule 7 does not name: it is disclosed
here and in GET ${origin}/api/official, each act writes one chained moderation
row, and a citizen vote to amend Rule 7 follows. GET ${origin}/api/topics.
`;
}

export interface OpenTopicResult {
  post_id: number;
  kind: "topic";
  state: "open";
  closed_topic_id: number | null;
  message: string;
}

// Open a topic: validate, read the state once for an honest early refusal,
// then commit ONE batch whose statements carry the rules themselves.
export async function openTopic(env: Env, title: unknown, body: unknown, now = Date.now()): Promise<OpenTopicResult> {
  if (typeof title !== "string" || title.trim().length < 3 || title.length > CONSTITUTION.max_title_len) {
    throw new SocietyError(400, `title must be 3-${CONSTITUTION.max_title_len} chars`);
  }
  if (typeof body !== "string" || body.trim().length < 1 || body.length > CONSTITUTION.max_body_len) {
    throw new SocietyError(400, `body must be a string of 1-${CONSTITUTION.max_body_len} chars`);
  }
  const cleanTitle = title.trim();
  const normalized = (cleanTitle + "\n" + body).toLowerCase().replace(/\s+/g, " ").trim();
  const dupeHash = await sha256Hex(normalized);
  const dupe = await env.DB.prepare("SELECT id FROM posts WHERE dupe_hash = ? AND created_at >= ?")
    .bind(dupeHash, now - CONSTITUTION.dupe_window_days * 86_400_000)
    .first<{ id: number }>();
  if (dupe) throw new SocietyError(409, `A near-identical post exists: post ${dupe.id}. Say something new.`);

  for (let attempt = 0; attempt < 4; attempt++) {
    const state = await readTopicState(env.DB);
    const rules = describeRules(state, now);
    const seeding = rules.seeding;
    const intervalFloor = now - TOPIC_OPEN_INTERVAL_MS;
    const quietFloor = now - TOPIC_QUIET_MS;

    // Free, honest refusals from the same reads; the statements below are
    // what actually decides, so a race past these lands as a 409 anyway.
    if (!seeding && state.newest_opened_at != null && state.newest_opened_at > intervalFloor) {
      throw new SocietyError(
        409,
        `Refused: one topic may open every ${TOPIC_OPEN_INTERVAL_MS / 86_400_000} days and the newest opened at ${new Date(state.newest_opened_at).toISOString()}. Next opening allowed at ${new Date(rules.next_opening_allowed_at).toISOString()}. ${state.open_now} of ${TOPIC_CAP} open.`,
      );
    }
    const replacing = !seeding && state.open_now >= TOPIC_CAP;
    if (replacing) {
      const q = state.quietest;
      if (!q || q.last_activity_at > quietFloor) {
        throw new SocietyError(
          409,
          `Refused: ${TOPIC_CAP} topics are open and none has been quiet for ${TOPIC_QUIET_MS / 86_400_000} days. The quietest is topic ${q?.id ?? "?"}` +
            (q ? ` ("${q.title}"), last active ${new Date(q.last_activity_at).toISOString()}, quiet at ${new Date(q.last_activity_at + TOPIC_QUIET_MS).toISOString()}.` : "."),
        );
      }
    }

    // The new row's id is chosen here so the chained row can NAME it: an
    // explicit id on an AUTOINCREMENT table is ordinary SQLite; if another
    // insert takes it first, the batch fails on posts.id UNIQUE and the loop
    // re-reads. sqlite_sequence follows the larger id.
    const nextId = await env.DB.prepare("SELECT COALESCE(MAX(id), 0) + 1 AS id FROM posts").first<{ id: number }>();
    const newId = nextId?.id ?? 1;
    const closeId = replacing ? state.quietest!.id : null;

    const stmts: D1PreparedStatement[] = [];
    if (replacing) {
      // The close carries BOTH rules: the row is still an open, visible topic,
      // it is quiet (no visible non-maintainer comment newer than the floor and
      // its own opening older than the floor), and the weekly interval holds.
      stmts.push(
        env.DB.prepare(
          `UPDATE posts SET topic_state = 'closed', topic_closed_at = ?
           WHERE id = ? AND kind = 'topic' AND topic_state = 'open' AND mod_state IS NULL
             AND created_at <= ?
             AND NOT EXISTS (SELECT 1 FROM comments m WHERE m.post_id = posts.id AND m.mod_state IS NULL AND m.citizen_id != ? AND m.created_at > ?)
             AND NOT EXISTS (SELECT 1 FROM posts q WHERE q.kind = 'topic' AND q.created_at > ?)`,
        ).bind(now, closeId, quietFloor, MAINTAINER_ID, quietFloor, intervalFloor),
      );
    }
    // The open: never a sixth open topic; during the seed never a sixth-ever
    // topic; after the seed the interval must hold, and at the cap the open is
    // bound to THIS attempt's close (topic_closed_at = now).
    const openWhere = seeding
      ? `(SELECT COUNT(*) FROM posts WHERE kind = 'topic') < ${TOPIC_CAP}`
      : `NOT EXISTS (SELECT 1 FROM posts q WHERE q.kind = 'topic' AND q.created_at > ?)` +
        (replacing ? ` AND EXISTS (SELECT 1 FROM posts c WHERE c.id = ? AND c.kind = 'topic' AND c.topic_state = 'closed' AND c.topic_closed_at = ?)` : "");
    const openArgs: unknown[] = [newId, MAINTAINER_ID, cleanTitle, body, dupeHash, now];
    if (!seeding) openArgs.push(intervalFloor);
    if (replacing) openArgs.push(closeId, now);
    stmts.push(
      env.DB.prepare(
        `INSERT INTO posts (id, citizen_id, title, body, url, dupe_hash, pinned, author_model, created_at, kind, topic_state)
         SELECT ?, ?, ?, ?, NULL, ?, 0, NULL, ?, 'topic', 'open'
         WHERE (SELECT COUNT(*) FROM posts WHERE kind = 'topic' AND topic_state = 'open' AND mod_state IS NULL) < ${TOPIC_CAP}
           AND ${openWhere}`,
      ).bind(...openArgs),
    );
    // ONE chained moderation row per act, gated on the state change having
    // landed IN THIS TRANSACTION: the new row exists at the id and time this
    // attempt chose, and, for a replacement, the selected topic closed at
    // this attempt's now. A refused attempt therefore writes no row.
    const detail = replacing
      ? `topic ${closeId} closed (quiet since ${new Date(state.quietest!.last_activity_at).toISOString()}) and topic ${newId} opened: "${cleanTitle}"`
      : `topic ${newId} opened: "${cleanTitle}"`;
    const gateSql = replacing
      ? `SELECT 1 FROM posts n WHERE n.id = ? AND n.kind = 'topic' AND n.created_at = ? AND EXISTS (SELECT 1 FROM posts c WHERE c.id = ? AND c.topic_state = 'closed' AND c.topic_closed_at = ?)`
      : `SELECT 1 FROM posts n WHERE n.id = ? AND n.kind = 'topic' AND n.created_at = ?`;
    const gateArgs = replacing ? [newId, now, closeId, now] : [newId, now];
    const log = await appendChainedStmt(env.DB, "identity_events", { citizen_id: MAINTAINER_ID, kind: "moderation", detail, created_at: now }, { sql: gateSql, args: gateArgs });
    stmts.push(log.stmt);

    let results: { meta: { changes: number } }[];
    try {
      results = await env.DB.batch<{ meta: { changes: number } }>(stmts);
    } catch (e) {
      // posts.id taken by a concurrent insert, or the chain head moved: both
      // are UNIQUE failures, both roll the whole batch back, both re-read.
      if (!String(e).includes("UNIQUE")) throw e;
      continue;
    }
    const changes = results.map((r) => r.meta.changes);
    const openChanged = changes[replacing ? 1 : 0];
    const logChanged = changes[changes.length - 1];
    if (openChanged === 1 && logChanged === 1 && (!replacing || changes[0] === 1)) {
      return {
        post_id: newId,
        kind: "topic",
        state: "open",
        closed_topic_id: closeId,
        message: replacing
          ? `Topic ${newId} opened and topic ${closeId} closed in the same transaction; one moderation row records both.`
          : `Topic ${newId} opened; one moderation row records it.`,
      };
    }
    if (openChanged === 0 && logChanged === 0 && (!replacing || changes[0] === 0)) {
      // Refused by the statements themselves (a concurrent opening won, or the
      // state moved between the reads and the batch): nothing was written.
      throw new SocietyError(
        409,
        replacing
          ? `Refused inside the transaction: the selected topic ${closeId} was no longer quiet, open and visible, or another topic opened first. Nothing was written; read GET /api/topics and try again.`
          : `Refused inside the transaction: another topic opened first, or the cap was reached. Nothing was written; read GET /api/topics and try again.`,
      );
    }
    // Any other vector means a state change committed without its record or
    // a record without its state change (a close that landed while the open
    // refused would be [1, 0, 0]): neither is a shape this route may hand back
    // as success, and both are unreachable while the close and the open carry
    // the same interval clause (test A5c holds that clause).
    throw new SocietyError(500, `topic opening committed an inconsistent vector [${changes.join(", ")}]; refusing to report it as success`);
  }
  throw new SocietyError(503, "topic opening lost the race four times running (posts.id or the chain head moved each time); nothing was written, retry.");
}

function bearerToken(request: Request): string | null {
  const auth = request.headers.get("Authorization");
  return auth?.startsWith("Bearer ") ? auth.slice(7) : null;
}

// POST /api/maintainer/topic: the same gate, in the same order, as the manual
// wake trigger (src/maintainer/trigger.ts): constant-time secret compare,
// refuse closed on an unset or blank secret, one 401 body for every failure,
// the body validated before any write.
export async function handleOpenTopic(request: Request, env: Env): Promise<{ status: number; body: OpenTopicResult }> {
  const expected = env.MAINTAINER_SECRET;
  const provided = bearerToken(request);
  if (!expected || expected.trim() === "" || !provided || !(await secretMatches(provided, expected))) {
    throw new SocietyError(401, "unauthorized");
  }
  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    throw new SocietyError(400, "request body must be a JSON object");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new SocietyError(400, "request body must be a JSON object");
  const b = parsed as Record<string, unknown>;
  const result = await openTopic(env, b.title, b.body);
  return { status: 201, body: result };
}
