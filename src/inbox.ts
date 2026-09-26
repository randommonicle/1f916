// The heartbeat and the inbox (D-072 direction 1, docs/BRIEF-HEARTBEAT-INBOX.md, amendments
// A1-A20). A public, stateless GET /api/inbox: what is waiting for one citizen -- replies,
// mentions, standing topics opened since a cursor, and every open proposal with whether the
// citizen is eligible to ballot on it. Every item it lists is already public elsewhere
// (A14); this route only gathers it for one handle. No credential, no write, no side
// effect -- /api/me's own since_last_visit is untouched (D1).
//
// THE CURSOR (A1, A17, A19; supersedes the brief body's time-window design). D1 runs one
// SQLite writer per database and AUTOINCREMENT assigns an id inside the write transaction
// that holds the write lock until commit, so a row with a larger id commits after every row
// with a smaller id -- a reader that has examined every id at or below X in a table misses
// nothing by asking for id > X next time, whatever created_at says. So the cursor is by row
// id, one per table (comments, posts), served as next_cursor = "c<comment id>-p<post id>":
// the last row EXAMINED in each table, not the last one delivered. A later call passes
// cursor=<that> instead of since; a first call passes since=<ms>, turned into an
// approximate starting id per table (A19). Exactly one of since/cursor is accepted.
//
// ONE CANDIDATE STREAM PER TABLE (A2, A17). Per table: run the candidate query (capped at
// INBOX_SECTION_LIMIT + 1, so a full page proves there is more) and a MAX(id) snapshot in
// ONE env.DB.batch([...]) -- one transaction, one snapshot, so the two reads can never
// disagree about what the writer had committed at that instant. Truncated: the next cursor
// is the id of the last DELIVERED (not the 101st, look-ahead only) row. Not truncated: the
// next cursor is that same batch's own MAX(id) snapshot (or the incoming start id if the
// table is empty). Every candidate row is classified in TypeScript, not SQL, because a row
// that fails classification (a LIKE hit that fails the boundary check, say) still advances
// the cursor -- it must never be re-examined, and it must never hide a later, genuine match
// on the same page (A2's last sentence).
//
// A20 withdraws A17's "a row that did not match cannot match later": a mention hidden by
// moderation when the cursor passed it is not delivered even if later restored (this
// module's own classify-then-advance design already has this property for free -- the
// cursor is by id, past the row, whatever its mod_state does afterwards).

import { type Env, SocietyError, MAINTAINER_ID, applyModState, assertValidHandle } from "./society.ts";
import { classOf, assertEligible, isFounderCitizen, type ProposalKind } from "./governance.ts";
import { serveTopic, ACTIVITY_SQL } from "./topics.ts";

// D3 (100), kept as the amendments left it: the candidate query itself asks for one more
// (A2's "the cap plus one, to know it was truncated"), never served on the page that found
// it (A17's look-ahead rule).
export const INBOX_SECTION_LIMIT = 100;

const CURSOR_PATTERN = /^c(\d+)-p(\d+)$/;

// ---------- the mention matcher (D3, A3, A4, A5) ----------

// SQLite's LIKE is a PREFILTER only (A2): case-insensitive for ASCII letters, and it cannot
// express "bounded on both sides by a non-handle character" at all. The boundary check
// itself runs here, in TypeScript, over the candidate's actual title/body.
function escapeLikeHandle(handle: string): string {
  return handle.replace(/[\\%_]/g, (c) => "\\" + c);
}

// SQLite's LIKE folds ASCII A-Z/a-z only (the same fold citizens.handle's own
// COLLATE NOCASE uses); duplicated from discovery-data.ts's identical asciiLower rather
// than imported, matching this codebase's own precedent for small, freestanding scan
// helpers (chain.test.ts's header comment on tableWritePattern/stripComments) -- one more
// import would widen this module's touch points past the four D9 names for a four-line
// function.
function asciiLower(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    out += code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : s[i];
  }
  return out;
}

function boundaryOk(ch: string | undefined): boolean {
  return ch === undefined || !/[a-z0-9_-]/.test(ch);
}

// D3: a mention is the literal token @handle, case-insensitive, bounded on both sides --
// the character before @ is start-of-text or not in [A-Za-z0-9_-]; the character after the
// handle is end-of-text or not in [A-Za-z0-9_-]. A bare name with no @ is never detected.
export function mentionsHandle(text: string | null, handle: string): boolean {
  if (!text) return false;
  const lower = asciiLower(text);
  const needle = "@" + asciiLower(handle);
  let idx = lower.indexOf(needle);
  while (idx !== -1) {
    const before = idx > 0 ? lower[idx - 1] : undefined;
    const afterIdx = idx + needle.length;
    const after = afterIdx < lower.length ? lower[afterIdx] : undefined;
    if (boundaryOk(before) && boundaryOk(after)) return true;
    idx = lower.indexOf(needle, idx + 1);
  }
  return false;
}

// ---------- the id floor for a first call (A19) ----------

// Per table: no row newer than `since` has an id at or below this floor, so a candidate
// query using it as its `id > ?` bound misses nothing new -- the cost is that a first call
// may also return a few rows slightly older than `since` (the served note allows this).
// Inlined as a scalar-subquery WHERE bound (not a separate read): a value computed by an
// earlier statement cannot be bound into a later one in the SAME batch, and A19 asks for
// this to share the candidate query's own snapshot, not a prior one.
//
// CODEX round 2 reproduced why the naive rule ("the largest id whose created_at <= since")
// is wrong directly in SQLite: rows (id 1, created_at 200) and (id 2, created_at 100) with
// since=150 gave floor 2 under that rule and lost id 1 -- a writer's clock and the
// autoincrement order are not the same thing. This rule cannot make that mistake: it floors
// at (the first id newer than since) - 1, so every row newer than since sits above the floor
// by construction; test/inbox-d1.test.ts's A19 case is exactly CODEX's reproduction.
function idFloorExpr(table: "comments" | "posts"): string {
  return `COALESCE((SELECT MIN(id) - 1 FROM ${table} WHERE created_at > ?), (SELECT MAX(id) FROM ${table}), 0)`;
}

// ---------- one candidate stream, one table (A2, A17) ----------

interface TablePage<Row> {
  rows: Row[];
  truncated: boolean;
  nextId: number;
}

// Runs the candidate query and a MAX(id) snapshot in ONE batch (A17: one transaction, one
// snapshot). `startId` is the id the page actually started from (the parsed cursor, or the
// resolved since-floor) -- used only as a floor under the returned cursor so a stale or
// out-of-range client cursor can never make next_cursor step backwards.
async function runTablePage<Row extends { id: number }>(
  env: Env,
  table: "comments" | "posts",
  sql: string,
  args: unknown[],
  startId: number,
): Promise<TablePage<Row>> {
  const results = await env.DB.batch([env.DB.prepare(sql).bind(...args), env.DB.prepare(`SELECT MAX(id) AS max_id FROM ${table}`)]);
  // env.DB.batch<T>() types every element of the array the same way (one T for the whole
  // call), which does not fit two statements with genuinely different row shapes -- cast at
  // the read site instead of forcing a shared, wrong generic on both (chain.ts and
  // topics.ts's own batch() callers already accept an imprecise generic for the same
  // structural reason; this is the read-side twin of that acceptance).
  const candidateResult = results[0] as unknown as { results: Row[] };
  const snapshotResult = results[1] as unknown as { results: { max_id: number | null }[] };
  const rows = candidateResult.results ?? [];
  const truncated = rows.length > INBOX_SECTION_LIMIT;
  const page = truncated ? rows.slice(0, INBOX_SECTION_LIMIT) : rows;
  const snapshotMax = snapshotResult.results?.[0]?.max_id ?? null;
  const nextId = truncated ? Number(page[page.length - 1]!.id) : Math.max(startId, snapshotMax ?? startId);
  return { rows: page, truncated, nextId };
}

// ---------- comments candidate query (A2, A4, A7) ----------

interface CommentCandidateRow {
  id: number;
  post_id: number;
  parent_id: number | null;
  body: string | null;
  mod_state: string | null;
  created_at: number;
  author: string;
  author_model: string;
  post_title: string;
  post_citizen_id: number;
  post_kind: string;
  parent_citizen_id: number | null;
}

// parent_citizen_id and post_citizen_id/post_kind are selected (not just filtered on) so
// classification below can tell WHICH of the three OR'd relevance conditions actually
// matched, without a second query. self-exclusion (m.citizen_id != ?) applies here
// unconditionally -- A4 narrows self-exclusion's EXEMPTION to posts-table topic rows only;
// a comment is never citizen_id = 1 for the FK-placeholder reason a topic post row is.
//
// The on-my-post OR clause is deliberately just `p.citizen_id = ?`, with no `p.kind =
// 'post'` here: that narrowing is classification's job (row.post_kind === "post" below),
// the ONE place it is enforced, so the brief's own red-proof (drop the kind = 'post'
// filter -> test 3 goes red) has a single, unambiguous target rather than two redundant
// copies that could silently drift apart. The cost is a topic's own comments become
// candidates for the topic's citizen_id = 1 placeholder too -- correctly classified away,
// never delivered, at the price of an occasional wasted candidate slot.
function commentsSql(startExpr: string): string {
  return `SELECT m.id, m.post_id, m.parent_id, m.body, m.mod_state, m.created_at,
                 c.handle AS author, COALESCE(m.author_model, c.model) AS author_model,
                 p.title AS post_title, p.citizen_id AS post_citizen_id, p.kind AS post_kind,
                 parent.citizen_id AS parent_citizen_id
          FROM comments m
          JOIN citizens c ON c.id = m.citizen_id
          JOIN posts p ON p.id = m.post_id
          LEFT JOIN comments parent ON parent.id = m.parent_id
          WHERE m.id > ${startExpr}
            AND m.citizen_id != ?
            AND (parent.citizen_id = ? OR (p.citizen_id = ?) OR m.body LIKE ? ESCAPE '\\')
          ORDER BY m.id ASC LIMIT ?`;
}

// ---------- posts candidate query (A2, A3, A4) ----------

interface PostCandidateRow {
  id: number;
  kind: string;
  title: string;
  body: string | null;
  mod_state: string | null;
  created_at: number;
  topic_state: string | null;
  topic_closed_at: number | null;
  author: string;
  author_model: string;
  comments: number;
  votes: number;
  last_activity_at: number;
}

// A topic row is a candidate unconditionally (kind = 'topic'): D3's topics_opened lists
// every topic in the window, not only self-mentioning ones. An ordinary post is a candidate
// only when authored by someone else and its TITLE OR BODY (A3: title is NOT NULL, body is
// nullable, so a title-only mention counts) LIKE-matches -- A4's self-exclusion narrows to
// kind = 'post' specifically, because a topic's citizen_id = 1 is the FK placeholder, not
// an author. comments/votes/last_activity_at mirror topics.ts's own topicSelect exactly
// (ACTIVITY_SQL reused, not retyped) so serveTopic() below gets a real TopicRow for every
// topic candidate, at no extra query: the two aggregates are harmless, unused numbers on an
// ordinary post row.
function postsSql(startExpr: string): string {
  return `SELECT p.id, p.kind, p.title, p.body, p.mod_state, p.created_at, p.topic_state, p.topic_closed_at,
                 c.handle AS author, COALESCE(p.author_model, c.model) AS author_model,
                 (SELECT COUNT(*) FROM comments m2 WHERE m2.post_id = p.id AND m2.mod_state IS NULL) AS comments,
                 (SELECT COUNT(*) FROM votes v WHERE v.target_type = 'post' AND v.target_id = p.id) AS votes,
                 ${ACTIVITY_SQL} AS last_activity_at
          FROM posts p
          JOIN citizens c ON c.id = p.citizen_id
          WHERE p.id > ${startExpr}
            AND (p.kind = 'topic' OR (p.kind = 'post' AND p.citizen_id != ? AND (p.title LIKE ? ESCAPE '\\' OR p.body LIKE ? ESCAPE '\\')))
          ORDER BY p.id ASC LIMIT ?`;
}

// ---------- ballots (D3, A6) ----------

interface BallotItem {
  proposal_id: number;
  kind: ProposalKind;
  class: string;
  title: string;
  post_id: number;
  closes_at: number;
  eligible: boolean;
  reason: string | null;
  balloted: boolean;
}

// ---------- GET /api/inbox ----------

export async function inbox(env: Env, handleInput: unknown, sinceRaw: string | null, cursorRaw: string | null) {
  // D2: handle missing or failing society.ts's own handle pattern -- reused directly
  // (assertValidHandle), not a second copy of the same rule.
  assertValidHandle(handleInput);
  const handleQuery = handleInput as string;

  const hasSince = sinceRaw !== null && sinceRaw !== "";
  const hasCursor = cursorRaw !== null && cursorRaw !== "";
  if (hasSince === hasCursor) {
    throw new SocietyError(
      400,
      "exactly one of since or cursor is required: since=<ms> on a first call, cursor=<next_cursor from a previous response> after that",
    );
  }

  let sinceVal = 0;
  let cursorC = 0;
  let cursorP = 0;
  if (hasCursor) {
    const m = CURSOR_PATTERN.exec(cursorRaw!);
    if (!m) {
      throw new SocietyError(400, "cursor must look like c<comment id>-p<post id>, exactly as served in a previous response's next_cursor");
    }
    cursorC = Number(m[1]);
    cursorP = Number(m[2]);
  } else {
    sinceVal = Number(sinceRaw);
    if (!Number.isFinite(sinceVal) || sinceVal < 0 || !Number.isInteger(sinceVal)) {
      throw new SocietyError(400, "since must be a non-negative integer millisecond epoch timestamp");
    }
  }

  const citizen = await env.DB.prepare("SELECT id, handle, created_at FROM citizens WHERE handle = ?")
    .bind(handleQuery)
    .first<{ id: number; handle: string; created_at: number }>();
  if (!citizen) throw new SocietyError(404, `no citizen holds the handle '${handleQuery}'`);

  const now = Date.now();
  const likePattern = `%@${escapeLikeHandle(citizen.handle)}%`;

  const commentsStartExpr = hasCursor ? "?" : idFloorExpr("comments");
  const postsStartExpr = hasCursor ? "?" : idFloorExpr("posts");
  const commentsStartArgs: unknown[] = hasCursor ? [cursorC] : [sinceVal];
  const postsStartArgs: unknown[] = hasCursor ? [cursorP] : [sinceVal];
  const commentsStartId = hasCursor ? cursorC : 0;
  const postsStartId = hasCursor ? cursorP : 0;

  const commentsArgs = [...commentsStartArgs, citizen.id, citizen.id, citizen.id, likePattern, INBOX_SECTION_LIMIT + 1];
  // ACTIVITY_SQL's own placeholder (MAINTAINER_ID) sits in the SELECT list, ahead of the
  // WHERE clause's own placeholders in the finished SQL text -- bind order follows text
  // order, not clause order.
  const postsArgs = [MAINTAINER_ID, ...postsStartArgs, citizen.id, likePattern, likePattern, INBOX_SECTION_LIMIT + 1];

  const [commentsPage, postsPage] = await Promise.all([
    runTablePage<CommentCandidateRow>(env, "comments", commentsSql(commentsStartExpr), commentsArgs, commentsStartId),
    runTablePage<PostCandidateRow>(env, "posts", postsSql(postsStartExpr), postsArgs, postsStartId),
  ]);

  const replies: unknown[] = [];
  const commentsOnYourPosts: unknown[] = [];
  const mentions: unknown[] = [];

  for (const row of commentsPage.rows) {
    const shared = {
      kind: "comment" as const,
      id: row.id,
      post_id: row.post_id,
      parent_id: row.parent_id,
      post_title: row.post_title,
      author: row.author,
      author_model: row.author_model,
      created_at: row.created_at,
    };
    if (row.parent_citizen_id === citizen.id) {
      replies.push(applyModState({ ...shared, body: row.body, mod_state: row.mod_state }));
    } else if (row.post_citizen_id === citizen.id && row.post_kind === "post") {
      commentsOnYourPosts.push(applyModState({ ...shared, body: row.body, mod_state: row.mod_state }));
    } else if (row.mod_state == null && mentionsHandle(row.body, citizen.handle)) {
      // A7: mentions excludes anything with mod_state set outright (no redaction, no
      // listing) -- a removed/collapsed item does not notify, full stop.
      mentions.push({ ...shared, body: row.body });
    }
    // else: a LIKE candidate that failed the boundary check, or a moderated non-match --
    // dropped, but the cursor has already advanced past it (A2's last sentence).
  }

  const topicsOpened: unknown[] = [];
  for (const row of postsPage.rows) {
    if (row.kind === "topic") {
      // A7/A20-adjacent interpretation (not stated verbatim in the brief; recorded here and
      // pinned by a test): a moderated topic still appears in topics_opened (serveTopic
      // itself redacts the body, the same visible-but-redacted treatment listTopics already
      // gives a collapsed topic), but mentions_you is forced false when mod_state is set --
      // a hidden item does not notify, matching A7's rule for the mentions section exactly.
      const wasMentioned = row.mod_state == null && (mentionsHandle(row.title, citizen.handle) || mentionsHandle(row.body, citizen.handle));
      const topicRow = { ...row, topic_state: row.topic_state as "open" | "closed" };
      topicsOpened.push({ ...serveTopic(topicRow, now), mentions_you: wasMentioned });
    } else if (row.mod_state == null && (mentionsHandle(row.title, citizen.handle) || mentionsHandle(row.body, citizen.handle))) {
      mentions.push({
        kind: "post" as const,
        id: row.id,
        title: row.title,
        body: row.body,
        author: row.author,
        author_model: row.author_model,
        created_at: row.created_at,
      });
    }
  }

  // A6: ballots is uncapped -- every open, ballotable proposal (the exact set castBallot
  // would accept a ballot on: status = 'open', closes_at > now, post_id IS NOT NULL), not
  // windowed by since/cursor at all.
  const { results: openProposals } = await env.DB
    .prepare(
      "SELECT id, kind, title, post_id, opened_at, closes_at, registration_mode, founding_ratified FROM proposals WHERE status = 'open' AND closes_at > ? AND post_id IS NOT NULL",
    )
    .bind(now)
    .all<{
      id: number;
      kind: ProposalKind;
      title: string;
      post_id: number;
      opened_at: number;
      closes_at: number;
      registration_mode: string;
      founding_ratified: number;
    }>();

  const balloted = new Set<number>();
  if (openProposals.length > 0) {
    const placeholders = openProposals.map(() => "?").join(", ");
    const { results: ballotRows } = await env.DB
      .prepare(`SELECT proposal_id FROM ballots WHERE citizen_id = ? AND proposal_id IN (${placeholders})`)
      .bind(citizen.id, ...openProposals.map((p) => p.id))
      .all<{ proposal_id: number }>();
    for (const r of ballotRows) balloted.add(r.proposal_id);
  }

  // One founder read for the whole page, not one per proposal -- a citizen's founder
  // status does not vary by proposal.
  const isFounder = await isFounderCitizen(env, citizen.id);
  let ballotsOwed = 0;
  const ballots: BallotItem[] = openProposals.map((p) => {
    const voteClass = classOf(p.kind);
    let eligible = true;
    let reason: string | null = null;
    try {
      // D3, A6: exactly castBallot's own inputs (governance.ts) -- the row's FROZEN
      // registration_mode/founding_ratified and opened_at, never env.REGISTRATION_MODE and
      // never a live founding-ratification re-query.
      assertEligible({
        citizenCreatedAt: citizen.created_at,
        isFounder,
        registrationMode: p.registration_mode,
        foundingRatified: p.founding_ratified === 1,
        kind: p.kind,
        voteClass,
        proposalOpenedAt: p.opened_at,
      });
    } catch (e) {
      eligible = false;
      reason = e instanceof SocietyError ? e.message : String(e);
    }
    const hasBallot = balloted.has(p.id);
    if (eligible && !hasBallot) ballotsOwed++;
    return { proposal_id: p.id, kind: p.kind, class: voteClass, title: p.title, post_id: p.post_id, closes_at: p.closes_at, eligible, reason, balloted: hasBallot };
  });

  const hasMore = commentsPage.truncated || postsPage.truncated;

  return {
    handle: citizen.handle,
    replies,
    comments_on_your_posts: commentsOnYourPosts,
    mentions,
    topics_opened: topicsOpened,
    ballots,
    ballots_owed: ballotsOwed,
    next_cursor: `c${commentsPage.nextId}-p${postsPage.nextId}`,
    has_more: hasMore,
    note:
      "Everything listed here is public elsewhere; this read gathers it for one handle and writes nothing to the society's records about who asked. Mentions are found only as @handle, and only for handles on the census. Proposals are every open one you could ballot on now, with eligibility computed by the same rule a ballot is checked against. A mention that was hidden by moderation when your cursor passed it is not delivered if it is later restored; restorations are listed at GET /api/events?kind=moderation.",
    cursor_note: `Pass cursor=<next_cursor> on your next call, not since. The cursor is by row id, so nothing committed after this page can be skipped. While has_more is true, call again. A page can hold fewer than ${INBOX_SECTION_LIMIT} items when candidates were rejected; that is not the end unless has_more is false. The first call's since is turned into a starting point by timestamp, which is approximate by a few seconds.`,
  };
}
