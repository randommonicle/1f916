// Moderation gaps wave, tests 3 and 6 (docs/BRIEF-MODERATION-GAPS.md W2): a title fetched by JOIN (`post_title`,
// `topic_title`) is not a `title` key, so applyModState cannot redact it; each surface selects the joined post's mod_state
// and applies the placeholder. Real local D1, the real router. NEW blocks fail on 50007e0f; the owner half of 6 is a
// PRESERVATION block (mutation recorded in docs/CHECKPOINT-moderation-gaps.md).
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { call, seedTopic, seedVisitor } from "./helpers/guest.ts";
import { CANARY_TITLE, REMOVED, COLLAPSED, STATES, setup, modPost, modComment, mcp, assertNoLeak, insertCitizenRow, secretFor } from "./helpers/moderation-gaps.ts";

const PH = /^\[(removed|collapsed)/;

test("3a (NEW): GET /api/topics serves a moderated closed topic with the placeholder title, still listed", async () => {
  const { d1, env } = setup();
  try {
    for (const s of STATES) {
      seedTopic(d1, { title: CANARY_TITLE, state: "closed", mod_state: s });
      const r = (await call(env, "GET", "/api/topics")).body;
      assertNoLeak(r, `topics (${s})`);
      const text = JSON.stringify(r);
      assert.ok(text.includes(s === "removed" ? "[removed by the maintainer" : "[collapsed "), "the tombstone is listed, not dropped");
    }
  } finally {
    d1.close();
  }
});

test("3b (NEW): inbox (HTTP and both MCP doors): replies, comments_on_your_posts, mentions and a moderated topic in topics_opened carry the placeholder title", async () => {
  const { d1, env, alice } = setup();
  try {
    const bob = insertCitizenRow(d1, "bob");
    const carol = insertCitizenRow(d1, "carol");
    for (const s of STATES) {
      const cp = modPost(d1, carol, s);
      const ac = modComment(d1, cp, alice, null, "alice speaks");
      modComment(d1, cp, bob, null, "a visible reply", ac);
      const ap = modPost(d1, alice, s);
      modComment(d1, ap, bob, null, "a visible comment on your post");
      modComment(d1, cp, bob, null, "hello @alice, a mention");
      seedTopic(d1, { title: CANARY_TITLE, mod_state: s });
    }
    const results = [
      (await call(env, "GET", "/api/inbox?handle=alice&since=0")).body,
      await mcp(env, "/mcp", "inbox", { handle: "alice", since: 0 }),
      await mcp(env, "/mcp/read", "inbox", { handle: "alice", since: 0 }),
    ];
    for (const r of results) {
      assertNoLeak(r, "inbox");
      assert.ok(r.replies.length >= 2, "replies kept: " + JSON.stringify(r).slice(0, 300));
      assert.ok(r.comments_on_your_posts.length >= 2, "comments kept");
      assert.ok(r.mentions.length >= 2, "mentions kept");
      assert.ok(r.topics_opened.length >= 2, "the moderated topics stay listed");
      for (const x of [...r.replies, ...r.comments_on_your_posts, ...r.mentions]) assert.match(x.post_title, PH);
      for (const t of r.topics_opened) assert.match(t.title, PH);
    }
  } finally {
    d1.close();
  }
});

test("3c (NEW): guest_due (HTTP and both MCP doors), actionable and history views: the topic title is the placeholder", async () => {
  const { d1, env } = setup();
  try {
    for (const s of STATES) {
      const topic = seedTopic(d1, { title: CANARY_TITLE, mod_state: s });
      const gt = d1.raw
        .prepare("INSERT INTO guest_thread (post_id, author_kind, author_id, handle, model, kind, body, duty, due_at, created_at) VALUES (?, 'guest', ?, 'gadfly', 'm', 'critique', 'a critique', 1, ?, ?)")
        .run(topic, 9000 + topic, Date.now() + 86_400_000, Date.now() - 100_000);
      if (s === "collapsed") {
        d1.raw
          .prepare("INSERT INTO guest_thread (post_id, parent_kind, parent_id, depth, author_kind, author_id, handle, model, kind, body, created_at) VALUES (?, 'thread', ?, 1, 'citizen', 1, 'commonhold-agent', 'm', 'comment', ?, ?)")
          .run(topic, Number(gt.lastInsertRowid), "an answer that is long enough to count ".repeat(12), Date.now());
      }
    }
    for (const view of ["actionable", "history"]) {
      const results = [
        (await call(env, "GET", `/api/guest/due?view=${view}`)).body,
        await mcp(env, "/mcp", "guest_due", { view }),
        await mcp(env, "/mcp/read", "guest_due", { view }),
      ];
      for (const r of results) {
        assertNoLeak(r, `guest_due ${view}`);
        assert.ok(r.items.length >= 1, `${view} lists its row: ${JSON.stringify(r).slice(0, 300)}`);
        for (const i of r.items) assert.match(i.topic_title, PH);
      }
    }
  } finally {
    d1.close();
  }
});

test("3d (NEW): guest_inbox (HTTP and both MCP doors), both states: a visible comment under a moderated post stays, its post_title is the placeholder", async () => {
  const { d1, env, alice } = setup();
  try {
    const v = await seedVisitor(d1, "wren");
    for (const s of STATES) {
      const p = modPost(d1, alice, s);
      modComment(d1, p, alice, null, `a visible comment for @guest:wren#${v.id} to read`);
    }
    const results = [
      (await call(env, "GET", `/api/guest/inbox?guest=${v.id}`)).body,
      await mcp(env, "/mcp", "guest_inbox", { guest: v.id }),
      await mcp(env, "/mcp/read", "guest_inbox", { guest: v.id }),
    ];
    for (const r of results) {
      assertNoLeak(r, "guest_inbox");
      assert.equal(r.mentions.length, 2, "both visible comments stay: " + JSON.stringify(r.mentions).slice(0, 300));
      for (const m of r.mentions) assert.match(m.post_title, PH);
    }
  } finally {
    d1.close();
  }
});

test("3e (NEW): /api/me redacts post_title on replies and on comments on your posts, including the caller's own moderated post", async () => {
  const { d1, env, alice } = setup();
  try {
    const bob = insertCitizenRow(d1, "bob");
    const secret = await secretFor(d1, alice);
    d1.raw.prepare("UPDATE citizens SET last_seen_at = 0 WHERE id = ?").run(alice);
    for (const s of STATES) {
      const cp = modPost(d1, bob, s);
      const ac = modComment(d1, cp, alice, null, "alice speaks", null, 1000);
      modComment(d1, cp, bob, null, "a reply", ac, Date.now() + 5_000);
      const ap = modPost(d1, alice, s);
      modComment(d1, ap, bob, null, "a comment", null, Date.now() + 5_000);
    }
    const r = (await call(env, "GET", "/api/me", undefined, { Authorization: `Bearer ${secret}` })).body;
    assertNoLeak(r, "/api/me");
    assert.equal(r.since_last_visit.replies.length, 2);
    assert.equal(r.since_last_visit.comments_on_your_posts.length, 2);
    for (const x of [...r.since_last_visit.replies, ...r.since_last_visit.comments_on_your_posts]) {
      assert.match(x.post_title, PH);
      assert.ok(!("post_mod_state" in x), "the helper column is not served");
    }
  } finally {
    d1.close();
  }
});

test("6 (NEW + PRESERVATION): /api/me/history keeps the caller's own originals; someone else's moderated post, and a moderated standing topic read by citizen 1, show the placeholder title", async () => {
  const { d1, env, alice, maintainer } = setup();
  try {
    const bob = insertCitizenRow(d1, "bob");
    const secret = await secretFor(d1, alice);
    // PRESERVATION: alice's own moderated post and her comment on it
    const own = modPost(d1, alice, "removed", { title: "OWN-TITLE-1", body: "OWN-BODY-1", url: "https://own.example/1" });
    modComment(d1, own, alice, null, "own comment body");
    // NEW: alice comments under bob's moderated post
    const others = modPost(d1, bob, "collapsed");
    modComment(d1, others, alice, null, "alice under bob");
    const h = (await call(env, "GET", "/api/me/history", undefined, { Authorization: `Bearer ${secret}` })).body;
    const ownPost = h.posts.find((p: { id: number }) => p.id === own);
    assert.equal(ownPost.title, "OWN-TITLE-1");
    assert.equal(ownPost.url, "https://own.example/1");
    assert.equal(ownPost.body, "OWN-BODY-1");
    const ownComment = h.comments.find((c: { post_id: number }) => c.post_id === own);
    assert.equal(ownComment.post_title, "OWN-TITLE-1", "own post title kept on own comment");
    assert.equal(ownComment.body, "own comment body");
    const underBob = h.comments.find((c: { post_id: number }) => c.post_id === others);
    assert.match(underBob.post_title, COLLAPSED);
    assert.equal(underBob.body, "alice under bob", "own comment body kept");
    assert.ok(!("post_mod_state" in underBob) && !("post_citizen_id" in underBob) && !("post_kind" in underBob));
    // the maintainer (citizen 1) under a moderated standing topic (citizen_id 1 is a placeholder): not its own
    const msecret = await secretFor(d1, maintainer);
    const topic = seedTopic(d1, { title: CANARY_TITLE, mod_state: "removed" });
    modComment(d1, topic, maintainer, null, "the maintainer on a topic");
    const mh = (await call(env, "GET", "/api/me/history", undefined, { Authorization: `Bearer ${msecret}` })).body;
    const tc = mh.comments.find((c: { post_id: number }) => c.post_id === topic);
    assert.match(tc.post_title, REMOVED);
    assertNoLeak(mh.comments, "maintainer history");
  } finally {
    d1.close();
  }
});
