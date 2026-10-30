// Moderation gaps wave (docs/BRIEF-MODERATION-GAPS.md, D-078 item 1): a moderated row's title, body and url are hidden on
// every public read. Real local D1, the real router, nothing mocked. Blocks marked NEW fail on 50007e0f; blocks marked
// PRESERVATION already held and each names the one-line mutation that turns it red (docs/CHECKPOINT-moderation-gaps.md).
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { call } from "./helpers/guest.ts";
import { applyModState } from "../src/modstate.ts";
import { CANARY_TITLE, CANARY_URL, CANARY_BODY, REMOVED, COLLAPSED, setup, modPost, modComment, mcp, assertNoLeak } from "./helpers/moderation-gaps.ts";

// ---------- W1 / test 1 (NEW) ----------

test("1 (NEW): applyModState redacts title with the body's placeholder and nulls url, for both states; a row without title/url gains neither key", () => {
  for (const [state, re] of [["removed", REMOVED], ["collapsed", COLLAPSED]] as const) {
    const out = applyModState({ id: 1, mod_state: state, title: CANARY_TITLE, body: CANARY_BODY, url: CANARY_URL, author: "alice" });
    assert.match(out.title as string, re);
    assert.equal(out.title, out.body, "the title is the SAME placeholder as the body");
    assert.equal(out.url, null);
    assert.equal(out.author, "alice");
    const comment = applyModState({ id: 2, mod_state: state, body: CANARY_BODY } as { id: number; mod_state: string; body: string });
    assert.match(comment.body, re);
    assert.deepEqual(Object.keys(comment).sort(), ["body", "id", "mod_state"], "no title or url key appears on a comment-shaped row");
    const listing = applyModState({ mod_state: state, title: "t", description: "d", url: "u" });
    assert.match(listing.description as string, re);
    assert.equal(listing.title, listing.description);
    assert.equal(listing.url, null);
  }
  const visible = { mod_state: null, title: "t", body: "b", url: "u" };
  assert.deepEqual(applyModState(visible), visible);
});

// ---------- test 2 (NEW): readPost on HTTP and both MCP doors ----------

test("2 (NEW): a moderated post reads as placeholder title, null url, intact byline and ids, on HTTP and both MCP doors", async () => {
  const { d1, env, alice } = setup();
  try {
    for (const [state, re] of [["removed", REMOVED], ["collapsed", COLLAPSED]] as const) {
      const id = modPost(d1, alice, state);
      const reads = [
        (await call(env, "GET", `/api/post/${id}`)).body,
        await mcp(env, "/mcp", "read_post", { post_id: id }),
        await mcp(env, "/mcp/read", "read_post", { post_id: id }),
      ];
      for (const r of reads) {
        assertNoLeak(r, `read_post (${state})`);
        assert.match(r.post.title, re);
        assert.equal(r.post.title, r.post.body);
        assert.equal(r.post.url, null);
        assert.equal(r.post.author, "alice");
        assert.equal(r.post.id, id);
        assert.equal(r.post.mod_state, state);
      }
    }
  } finally {
    d1.close();
  }
});

// ---------- test 4 (PRESERVATION): changes ----------

test("4 (PRESERVATION): /api/changes keeps a moderated comment's tombstone and serves no original body, title or url", async () => {
  const { d1, env, alice } = setup();
  try {
    const visible = modPost(d1, alice, null, { title: "a visible post", url: "https://ok.example/", body: "ok" });
    modComment(d1, visible, alice, "removed", CANARY_BODY);
    modPost(d1, alice, "removed");
    const r = (await call(env, "GET", "/api/changes?since=0")).body;
    assertNoLeak(r, "changes");
    assert.ok(r.comments.some((c: { mod_state: string; body: string }) => c.mod_state === "removed" && REMOVED.test(c.body)), "the tombstone stays");
  } finally {
    d1.close();
  }
});

// ---------- front / new / search regression (PRESERVATION) ----------

test("front/new/search regression (PRESERVATION): a moderated post is absent from /api/front, /api/new and /api/search", async () => {
  const { d1, env, alice } = setup();
  try {
    modPost(d1, alice, "collapsed");
    for (const path of ["/api/front", "/api/new", "/api/search?q=CANARY"]) {
      const r = await call(env, "GET", path);
      assert.equal(r.status, 200, path);
      assertNoLeak(r.body, path);
    }
  } finally {
    d1.close();
  }
});

// ---------- test 5 (NEW): listings and submissions ----------

test("5 (NEW): a moderated listing and submission serve placeholder title/description/body and null url", async () => {
  const { d1, env, alice } = setup();
  try {
    for (const state of ["removed", "collapsed"] as const) {
      const l = d1.raw
        .prepare("INSERT INTO listings (funder_citizen_id, title, description, url, acceptance_condition, bounty_cents, fee_cents, fee_tx, mod_state, expires_at, created_at) VALUES (?,?,?,?,?,100,50,?,?,?,?)")
        .run(alice, CANARY_TITLE, CANARY_BODY, CANARY_URL, "a stranger-evaluable condition", `0xtx${state}`, state, Date.now() + 86_400_000, Date.now());
      const lid = Number(l.lastInsertRowid);
      d1.raw.prepare("INSERT INTO submissions (listing_id, citizen_id, body, url, mod_state, created_at) VALUES (?,?,?,?,?,?)").run(lid, alice, CANARY_BODY, CANARY_URL, state, Date.now());
      const one = (await call(env, "GET", `/api/listing/${lid}`)).body;
      const list = (await call(env, "GET", "/api/listings?status=all")).body;
      assertNoLeak(one, `listing ${state}`);
      assertNoLeak(list, `listings ${state}`);
      assert.match(one.listing.title, state === "removed" ? REMOVED : COLLAPSED);
      assert.equal(one.listing.url, null);
      assert.equal(one.submissions[0].url, null);
      assert.match(one.submissions[0].body, state === "removed" ? REMOVED : COLLAPSED);
    }
  } finally {
    d1.close();
  }
});

// ---------- test 10: served text (NEW) ----------

import { PRIVACY_TEMPLATE } from "../src/privacy.ts";
import { TOOLS } from "../src/mcp.ts";

test("10 (NEW): /privacy states the new moderation rule and its named exceptions, and the old 'titles, links ... may remain visible' sentence is gone", async () => {
  const { d1, env } = setup();
  try {
    const text = (await call(env, "GET", "/privacy")).body._text as string;
    for (const t of [PRIVACY_TEMPLATE, text]) {
      assert.ok(t.includes("Moderation replaces the body and the title of a collapsed or removed post, comment, listing or submission with a notice, and removes its link"));
      assert.ok(t.includes("bylines, ids, times and the moderation state stay visible"));
      assert.ok(t.includes("a standing topic's title stays in the attested identity log, which is never rewritten"), "E1");
      assert.ok(t.includes("a proposal's body stays as filed"), "E2");
      assert.ok(t.includes("That history also returns the original titles and links of the citizen's own posts"));
      assert.equal(/titles, links, bylines and other metadata may remain visible/.test(t), false, "the old, now false, sentence is gone");
    }
  } finally {
    d1.close();
  }
});

test("10b (NEW): the MCP moderation tool description states the new rule (title replaced, link removed)", () => {
  const mod = TOOLS.find((t) => t.name === "moderate");
  assert.ok(mod, "the moderation tool exists");
  assert.ok(mod.description.includes("the body and title are replaced and the link removed on supported public reads"));
  assert.equal(mod.description.includes("metadata may remain visible"), false);
});
