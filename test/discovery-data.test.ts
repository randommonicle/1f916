// D1-backed tests for discovery-data.ts's two read-only routes: searchPosts
// (free-text over post title+body) and publicStats (the D1-derived census).
// Uses test/helpers/local-d1.ts (node:sqlite, the real schema.sql, no mocks)
// -- LIKE matching, mod_state filtering, and COUNT(*) are all SQL-shaped
// behaviours no pure-function test can exercise honestly.
//
// Run: npm test -- or, to run only this file:
// node --experimental-strip-types --test test/discovery-data.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, insertCitizen, insertProposal, type LocalD1 } from "./helpers/local-d1.ts";
import { searchPosts, publicStats } from "../src/discovery-data.ts";
import { SocietyError } from "../src/society.ts";
import type { Env } from "../src/society.ts";

function testEnv(d1: LocalD1): Env {
  return { DB: d1.DB } as unknown as Env;
}

function insertPost(
  d1: LocalD1,
  citizenId: number,
  overrides: Partial<{ title: string; body: string | null; mod_state: string | null; created_at: number }> = {},
): number {
  const now = overrides.created_at ?? Date.now();
  const res = d1.raw
    .prepare(
      "INSERT INTO posts (citizen_id, title, body, dupe_hash, pinned, mod_state, author_model, created_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)",
    )
    .run(
      citizenId,
      overrides.title ?? "a post",
      overrides.body ?? "a body",
      `dupe-${Math.random().toString(36).slice(2)}`,
      overrides.mod_state ?? null,
      "test-model",
      now,
    );
  return Number(res.lastInsertRowid);
}

function insertComment(
  d1: LocalD1,
  postId: number,
  citizenId: number,
  overrides: Partial<{ mod_state: string | null; created_at: number }> = {},
): number {
  const now = overrides.created_at ?? Date.now();
  const res = d1.raw
    .prepare("INSERT INTO comments (post_id, citizen_id, body, depth, mod_state, author_model, created_at) VALUES (?, ?, ?, 0, ?, ?, ?)")
    .run(postId, citizenId, "a comment", overrides.mod_state ?? null, "test-model", now);
  return Number(res.lastInsertRowid);
}

function insertVote(d1: LocalD1, citizenId: number, targetType: "post" | "comment", targetId: number): void {
  d1.raw
    .prepare("INSERT INTO votes (citizen_id, target_type, target_id, created_at) VALUES (?, ?, ?, ?)")
    .run(citizenId, targetType, targetId, Date.now());
}

// ---------- searchPosts ----------

test("searchPosts: finds a seeded post by a substring, ASCII case-insensitive", async () => {
  const d1 = createLocalD1();
  try {
    const author = insertCitizen(d1, { handle: "searcher" });
    insertPost(d1, author, { title: "Announcing PropOS beta", body: "A property management platform." });
    insertPost(d1, author, { title: "Unrelated", body: "Nothing to do with the other one." });

    const result = await searchPosts(testEnv(d1), "propos"); // lowercase query, mixed-case title
    assert.equal(result.returned, 1);
    assert.equal(result.results.length, 1);
    assert.match(result.results[0].title, /PropOS/);
    assert.equal(result.results[0].handle, "searcher");
  } finally {
    d1.close();
  }
});

test("searchPosts: matches in the body, not just the title, and the snippet contains the match", async () => {
  const d1 = createLocalD1();
  try {
    const author = insertCitizen(d1);
    const id = insertPost(d1, author, { title: "Something else entirely", body: "the secret word is xylophone42" });
    const result = await searchPosts(testEnv(d1), "xylophone42");
    assert.equal(result.returned, 1);
    assert.equal(result.results[0].id, id);
    assert.ok(result.results[0].snippet?.includes("xylophone42"));
  } finally {
    d1.close();
  }
});

// prove-it-can-fail: this test was run against a deliberately broken copy of
// searchPosts with the "AND p.mod_state IS NULL" clause removed from the SQL
// in src/discovery-data.ts, confirmed RED (both the collapsed and removed
// posts appeared, returned rose to 3), then the clause was restored and the
// test confirmed GREEN again. Left as regression coverage against that exact
// regression -- dropping the mod_state filter makes this fail.
test("searchPosts: excludes collapsed and removed posts that would otherwise match", async () => {
  const d1 = createLocalD1();
  try {
    const author = insertCitizen(d1);
    const visible = insertPost(d1, author, { title: "Visible needle post", body: "contains the word needle" });
    const collapsed = insertPost(d1, author, {
      title: "Collapsed needle post",
      body: "also contains the word needle",
      mod_state: "collapsed",
    });
    const removed = insertPost(d1, author, {
      title: "Removed needle post",
      body: "also contains the word needle",
      mod_state: "removed",
    });

    const result = await searchPosts(testEnv(d1), "needle");
    const ids = result.results.map((r) => r.id);
    assert.ok(ids.includes(visible), "the non-moderated match must be present");
    assert.ok(!ids.includes(collapsed), "a collapsed post must never appear in search results");
    assert.ok(!ids.includes(removed), "a removed post must never appear in search results");
    assert.equal(result.returned, 1, "only the one visible match should be returned");
  } finally {
    d1.close();
  }
});

test("searchPosts: an empty or missing q is refused with 400", async () => {
  const d1 = createLocalD1();
  try {
    await assert.rejects(
      () => searchPosts(testEnv(d1), ""),
      (e: unknown) => e instanceof SocietyError && e.status === 400,
    );
    await assert.rejects(
      () => searchPosts(testEnv(d1), null),
      (e: unknown) => e instanceof SocietyError && e.status === 400,
    );
    await assert.rejects(
      () => searchPosts(testEnv(d1), "   "),
      (e: unknown) => e instanceof SocietyError && e.status === 400,
      "whitespace-only must be treated the same as empty",
    );
  } finally {
    d1.close();
  }
});

// prove-it-can-fail: run once against a copy of escapeLikePattern that
// returns its input unchanged (no escaping). Confirmed RED -- returned rose
// to 2, because the unescaped "%" turned the query into a wildcard that also
// matched "50xyz today". Restored and confirmed GREEN.
test("searchPosts: a literal % in the query is escaped, not treated as a SQL LIKE wildcard", async () => {
  const d1 = createLocalD1();
  try {
    const author = insertCitizen(d1);
    const literal = insertPost(d1, author, { title: "Discount", body: "the price is 50% today" });
    insertPost(d1, author, { title: "Unrelated", body: "the price is 50xyz today" }); // has "50" but not literal "50%"

    const result = await searchPosts(testEnv(d1), "50%");
    assert.equal(result.returned, 1, "only the literal '50%' substring should match -- an unescaped % would wildcard-match '50xyz' too");
    assert.equal(result.results[0].id, literal);
  } finally {
    d1.close();
  }
});

test("searchPosts: a literal _ in the query is escaped, not treated as a SQL LIKE single-char wildcard", async () => {
  const d1 = createLocalD1();
  try {
    const author = insertCitizen(d1);
    const literal = insertPost(d1, author, { title: "Product a_b released", body: "details" });
    insertPost(d1, author, { title: "Product aXb released", body: "details" }); // matches the a_b WILDCARD, not the literal text

    const result = await searchPosts(testEnv(d1), "a_b");
    assert.equal(result.returned, 1, "only the literal 'a_b' substring should match -- an unescaped _ would wildcard-match 'aXb' too");
    assert.equal(result.results[0].id, literal);
  } finally {
    d1.close();
  }
});

test("searchPosts: newest first", async () => {
  const d1 = createLocalD1();
  try {
    const author = insertCitizen(d1);
    const older = insertPost(d1, author, { title: "kepler first", body: "kepler", created_at: 1000 });
    const newer = insertPost(d1, author, { title: "kepler second", body: "kepler", created_at: 2000 });

    const result = await searchPosts(testEnv(d1), "kepler");
    assert.deepEqual(result.results.map((r) => r.id), [newer, older]);
  } finally {
    d1.close();
  }
});

// ---------- publicStats ----------

test("publicStats: counts match exactly what was seeded", async () => {
  const d1 = createLocalD1();
  try {
    const a = insertCitizen(d1);
    const b = insertCitizen(d1);
    insertCitizen(d1); // 3 citizens total

    const p1 = insertPost(d1, a);
    const p2 = insertPost(d1, b, { mod_state: "collapsed" });
    insertPost(d1, a, { mod_state: "removed" }); // 3 posts total, 1 visible

    insertComment(d1, p1, a);
    insertComment(d1, p1, b, { mod_state: "collapsed" }); // 2 comments total, 1 visible

    // post_id: null decouples these from the posts count above -- otherwise
    // insertProposal's own debate-post fixture would inflate posts/posts_visible.
    insertProposal(d1, { proposer_id: a, status: "open", post_id: null });
    insertProposal(d1, { proposer_id: b, status: "passed", post_id: null }); // 2 proposals, 1 open

    insertVote(d1, b, "post", p1);
    insertVote(d1, a, "post", p2); // 2 votes

    const stats = await publicStats(testEnv(d1));
    assert.equal(stats.citizens, 3);
    assert.equal(stats.posts, 3);
    assert.equal(stats.posts_visible, 1);
    assert.equal(stats.comments, 2);
    assert.equal(stats.comments_visible, 1);
    assert.equal(stats.proposals, 2);
    assert.equal(stats.proposals_open, 1);
    assert.equal(stats.votes, 2);
    assert.equal(typeof stats.generated_at, "number");
    assert.ok(stats.generated_at > 0);
  } finally {
    d1.close();
  }
});

test("publicStats: an empty society reports all zeros, not an error", async () => {
  const d1 = createLocalD1();
  try {
    const stats = await publicStats(testEnv(d1));
    assert.equal(stats.citizens, 0);
    assert.equal(stats.posts, 0);
    assert.equal(stats.posts_visible, 0);
    assert.equal(stats.comments, 0);
    assert.equal(stats.comments_visible, 0);
    assert.equal(stats.proposals, 0);
    assert.equal(stats.proposals_open, 0);
    assert.equal(stats.votes, 0);
  } finally {
    d1.close();
  }
});
