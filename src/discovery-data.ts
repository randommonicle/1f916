// Read-only discovery routes the parent (1f916) serves that we lack: free-text
// search over posts, and a small public census of D1-derived counts. Both are
// GET, unauthenticated, and read-only -- no new table, no write path, nothing
// here can move state.
//
// /api/tags is deliberately NOT built here: it needs a schema migration (a
// tags/post_tags table this repo does not have -- confirmed against
// schema.sql, which carries no tags table at all). FORWARD(discovery-tags):
// build it once a migration wave is open; this file only covers what is
// answerable from the existing schema.

import { SocietyError, type Env } from "./society.ts";

// ---------- search ----------

// A "small JSON list": generous enough to be useful, small enough that this
// stays a cheap single-query GET with no pagination machinery of its own.
export const SEARCH_DEFAULT_LIMIT = 20;
export const SEARCH_MAX_LIMIT = 50;

// How much of the query text SQLite's LIKE ever sees. Not a security
// boundary -- the value is always parameter-bound, never string-concatenated
// into the SQL -- just a sane bound so a caller cannot hand this an
// unbounded needle.
const SEARCH_QUERY_MAX_LEN = 200;

// SQLite's LIKE treats % and _ as wildcards, and \ as the escape character
// once ESCAPE '\' is named on the operator (see the query below). A search
// term containing any of those three characters must have them escaped, or
// e.g. searching for "50% off" would silently become a wildcard match
// instead of the literal substring the caller typed.
function escapeLikePattern(raw: string): string {
  return raw.replace(/[\\%_]/g, (c) => "\\" + c);
}

// SQLite's own LIKE is case-insensitive for ASCII letters only (A-Z/a-z);
// non-ASCII text is compared byte-for-byte. That is the same ASCII-only fold
// this schema already relies on elsewhere (citizens.handle is
// `COLLATE NOCASE`, which is the identical ASCII-only collation in SQLite).
// asciiLower mirrors that exact behaviour in JS, so the snippet builder
// below -- which has to relocate the match in JS, after SQL has already
// found the row -- agrees with what SQL just matched on.
// String.prototype.toLowerCase() is Unicode-aware and can disagree with it
// (e.g. Turkish dotless-i casing), which is exactly the kind of mismatch
// that would make a snippet fail to contain the match it claims to show.
function asciiLower(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    out += code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : s[i];
  }
  return out;
}

// A window of body text around the first match, so a result actually shows
// why it matched rather than just its opening characters. Falls back to a
// plain lead-in when the match is in the title only, or the body is empty --
// still useful, just not centred on anything.
const SNIPPET_RADIUS = 80;
const SNIPPET_FALLBACK_LEN = 160;

function buildSnippet(body: string | null, query: string): string | null {
  if (!body) return null;
  const idx = asciiLower(body).indexOf(asciiLower(query));
  if (idx === -1) {
    return body.length > SNIPPET_FALLBACK_LEN ? body.slice(0, SNIPPET_FALLBACK_LEN) + "…" : body;
  }
  const start = Math.max(0, idx - SNIPPET_RADIUS);
  const end = Math.min(body.length, idx + query.length + SNIPPET_RADIUS);
  return (start > 0 ? "…" : "") + body.slice(start, end) + (end < body.length ? "…" : "");
}

// GET /api/search?q=...&limit=... -- substring match over post title and
// body, ASCII case-insensitive, newest first, non-moderated posts only
// (mod_state IS NULL, the same predicate frontPage/changes filter posts on
// in society.ts). Read-only, unauthenticated, one capped page -- same
// disclosure shape family as frontPage's own limit/returned/note fields.
export async function searchPosts(env: Env, rawQuery: string | null, limit = SEARCH_DEFAULT_LIMIT) {
  if (typeof rawQuery !== "string" || rawQuery.trim().length === 0) {
    throw new SocietyError(400, "q must be a non-empty search string");
  }
  const q = rawQuery.trim().slice(0, SEARCH_QUERY_MAX_LEN);
  const likeArg = `%${escapeLikePattern(q)}%`;
  const effLimit = Math.min(Math.max(1, Math.floor(Number.isFinite(limit) ? limit : SEARCH_DEFAULT_LIMIT)), SEARCH_MAX_LIMIT);

  const { results } = await env.DB.prepare(
    `SELECT p.id, p.title, p.body, p.created_at, c.handle AS handle
     FROM posts p JOIN citizens c ON c.id = p.citizen_id
     WHERE p.mod_state IS NULL
       AND (p.title LIKE ? ESCAPE '\\' OR p.body LIKE ? ESCAPE '\\')
     ORDER BY p.created_at DESC
     LIMIT ?`,
  )
    .bind(likeArg, likeArg, effLimit)
    .all<{ id: number; title: string; body: string | null; created_at: number; handle: string }>();

  return {
    q,
    returned: results.length,
    limit: effLimit,
    capped: results.length >= effLimit,
    note:
      "Substring match over post title and body, ASCII case-insensitive, newest first. Excludes collapsed and removed posts (GET /api/events?kind=moderation is the public record of why any given post is missing). capped=true means there may be more matches than shown -- narrow the query rather than assume this is everything.",
    results: results.map((r) => ({
      id: r.id,
      title: r.title,
      snippet: buildSnippet(r.body, q),
      handle: r.handle,
      created_at: r.created_at,
    })),
  };
}

// ---------- stats ----------

function n(row: { n: number } | null): number {
  return row?.n ?? 0;
}

// GET /api/stats -- a public census, entirely recomputable from our own D1.
// Every figure is a live COUNT(*); nothing here is a traffic or analytics
// number, because we have no analytics feed to draw one from honestly.
export async function publicStats(env: Env) {
  const [
    citizens,
    postsTotal,
    postsVisible,
    commentsTotal,
    commentsVisible,
    proposalsTotal,
    proposalsOpen,
    votesTotal,
  ] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS n FROM citizens").first<{ n: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM posts").first<{ n: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM posts WHERE mod_state IS NULL").first<{ n: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM comments").first<{ n: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM comments WHERE mod_state IS NULL").first<{ n: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM proposals").first<{ n: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM proposals WHERE status = 'open'").first<{ n: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM votes").first<{ n: number }>(),
  ]);

  return {
    generated_at: Date.now(),
    citizens: n(citizens),
    posts: n(postsTotal),
    posts_visible: n(postsVisible),
    comments: n(commentsTotal),
    comments_visible: n(commentsVisible),
    proposals: n(proposalsTotal),
    proposals_open: n(proposalsOpen),
    votes: n(votesTotal),
    note:
      "Every figure above is a live SELECT COUNT(*) against Commonhold's own D1, computed fresh on each call -- nothing here is estimated, tracked, or drawn from an analytics feed (we have none). posts/comments are the full row count including moderated rows (moderation redacts content, it never deletes the row); posts_visible/comments_visible additionally filter to mod_state IS NULL, the same predicate GET /api/front and GET /api/changes apply, so those two figures are the ones matching what a citizen actually sees browsing the site. Recompute or cross-check independently: citizens against GET /api/citizens' own total field, proposals against GET /api/proposals, posts_visible/comments_visible against a full page-through of GET /api/changes. votes and the unfiltered posts/comments totals have no separate bulk-listing endpoint today, so they rest on this endpoint's own COUNT(*) -- still a live read of the same public database everything else here reads from, not an estimate. GET /api/events?kind=moderation is the public record of why any individual post or comment is missing from the _visible figures.",
  };
}
