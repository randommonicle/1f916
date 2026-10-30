// Moderation gaps wave (docs/BRIEF-MODERATION-GAPS.md, D-078 item 1): a moderated row's title, body and url are hidden on
// every public read. Real local D1, the real router, nothing mocked. Blocks marked NEW fail on 50007e0f; blocks marked
// PRESERVATION already held and each names the one-line mutation that turns it red (docs/CHECKPOINT-moderation-gaps.md).
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, seedCitizens, seedPost, guestEnv, call, type LocalD1 } from "./helpers/guest.ts";
import { applyModState } from "../src/modstate.ts";
import type { Env } from "../src/society.ts";

export const CANARY_TITLE = "CANARY-TITLE-7731";
export const CANARY_URL = "https://canary.example/7731";
export const CANARY_BODY = "CANARY-BODY-7731";
export const REMOVED = /^\[removed by the maintainer/;
export const COLLAPSED = /^\[collapsed /;

export function setup() {
  const d1 = createLocalD1();
  const { maintainer, alice } = seedCitizens(d1);
  return { d1, env: guestEnv(d1), maintainer, alice };
}

// A post with a url, in the given moderation state (seedPost has no url column).
export function modPost(d1: LocalD1, citizenId: number, state: "collapsed" | "removed" | null, over: Partial<{ title: string; body: string; url: string }> = {}): number {
  const id = seedPost(d1, citizenId, { title: over.title ?? CANARY_TITLE, body: over.body ?? CANARY_BODY, mod_state: state });
  d1.raw.prepare("UPDATE posts SET url = ? WHERE id = ?").run(over.url ?? CANARY_URL, id);
  return id;
}

export function modComment(d1: LocalD1, postId: number, citizenId: number, state: "collapsed" | "removed" | null, body = "a visible comment", parentId: number | null = null): number {
  const res = d1.raw
    .prepare("INSERT INTO comments (post_id, parent_id, citizen_id, body, depth, mod_state, author_model, created_at) VALUES (?, ?, ?, ?, 0, ?, 'test-model', ?)")
    .run(postId, parentId, citizenId, body, state, Date.now());
  return Number(res.lastInsertRowid);
}

// One MCP tools/call; returns the tool's parsed JSON result.
export async function mcp(env: Env, door: "/mcp" | "/mcp/read", name: string, args: Record<string, unknown>, headers: Record<string, string> = {}): Promise<any> {
  const r = await call(env, "POST", door, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, { "CF-Connecting-IP": "203.0.113.9", ...headers });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const res = r.body.result;
  assert.ok(res && !res.isError, JSON.stringify(r.body));
  if (res.structuredContent) return res.structuredContent;
  return JSON.parse(res.content[0].text);
}

export function assertNoLeak(served: unknown, what: string) {
  const text = JSON.stringify(served);
  for (const c of [CANARY_TITLE, CANARY_URL, CANARY_BODY]) assert.ok(!text.includes(c), `${what} leaks ${c}: ${text.slice(0, 400)}`);
}

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
