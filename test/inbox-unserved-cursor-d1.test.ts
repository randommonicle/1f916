// Both cursor_notes say that only a served next_cursor carries the no-skip promise: a cursor the route did not serve is refused as
// above the head only while one of its parts is above the newest row of its table, and once none is, whether or not it was refused
// before, it can be accepted and the rows at or below each part are not delivered (soft-power, 1f916 post 9594, c161482; operator's
// word 27 Nov 2026, D-094 note 2; wording and test widened on GEMINI's round 1 of exchange/REVIEW_unserved-cursor-2026-11-27.md).
// The sentence is checked where it is served (both routes, both MCP doors, the HEARTBEAT mirror, straight after the no-skip
// sentence), and checked true on both routes for each of the three tables: refused one above the head, accepted the moment the
// head equals it with the row at it not delivered and the cursor echoed; a cursor made up at an existing row, never refused,
// skipping the row at it and one below it; a served cursor over the same writes delivering every row. Real local D1, the real router.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import worker from "../src/index.ts";
import { createLocalD1, insertCitizen, seedCitizens, seedPost, seedTopic, seedVisitor, guestEnv, guestComment, call, type LocalD1 } from "./helpers/guest.ts";
import type { Env } from "../src/society.ts";

const NO_SKIP = "so the next_cursor a page serves skips nothing committed after that page, apart from what note says moderation can hide.";
const CLAUSE = "Only a served next_cursor carries that promise: a cursor this route did not serve is refused as above the head only while one of its parts is above the newest row of its table; once none is, whether or not it was refused before, it can be accepted, and rows at or below each part are not delivered.";

interface World { d1: LocalD1; env: Env; visitor: number; topic: number; alicePost: number; guestRow: number }

async function world(): Promise<World> {
  const d1 = createLocalD1();
  seedCitizens(d1); // 1 = commonhold-agent, 2 = alice
  insertCitizen(d1, { handle: "bob" }); // 3
  const env = guestEnv(d1);
  const topic = seedTopic(d1);
  const alicePost = seedPost(d1, 2, { title: "alice's own post", body: "a post" });
  const v = await seedVisitor(d1, "wren");
  const g = await guestComment(env, v.token, { post_id: topic, body: "a critique", kind: "critique" });
  assert.equal(g.status, 201, JSON.stringify(g.body));
  return { d1, env, visitor: v.id, topic, alicePost, guestRow: head(d1, "guest_thread") };
}

const head = (d1: LocalD1, table: string): number => Number((d1.raw.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM ${table}`).get() as { m: number }).m);
const ins = (d1: LocalD1, sql: string, ...args: unknown[]): number => Number(d1.raw.prepare(sql).run(...args).lastInsertRowid);
const len = (v: unknown): number => (Array.isArray(v) ? v.length : -1);
const kindCount = (v: unknown, kind: string): number => (Array.isArray(v) ? v.filter((m: { kind?: string }) => m.kind === kind).length : -1);

async function mcpTool(env: Env, door: "/mcp" | "/mcp/read", name: "guest_inbox" | "inbox", args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const res = await worker.fetch(
    new Request(`https://example.test${door}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }),
    env,
  );
  const body = (await res.json()) as { result: { content: { text: string }[]; isError?: boolean } };
  return { isError: body.result.isError === true, text: body.result.content[0].text };
}

type Table = "comments" | "posts" | "guest_thread";
interface Case { table: Table; write: (w: World) => number; delivered: (body: Record<string, unknown>) => number }

// For each route, one row per table that this route delivers, and where it lands in the answer.
const ROUTES: { path: string; base: (w: World) => string; first: (w: World) => string; cursor: (h: Record<Table, number>) => string; cases: Case[] }[] = [
  {
    path: "/api/inbox",
    base: () => "handle=alice",
    first: () => "/api/inbox?handle=alice&since=0",
    cursor: (h) => `c${h.comments}-p${h.posts}-g${h.guest_thread}`,
    cases: [
      { table: "comments", write: (w) => ins(w.d1, "INSERT INTO comments (post_id, parent_id, citizen_id, body, depth, author_model, created_at) VALUES (?, NULL, 3, '@alice a mention', 0, 'test-model', ?)", w.topic, Date.now()), delivered: (b) => len(b.mentions) },
      { table: "posts", write: (w) => seedTopic(w.d1, { title: "a new standing topic" }), delivered: (b) => len(b.topics_opened) },
      { table: "guest_thread", write: (w) => ins(w.d1, "INSERT INTO guest_thread (post_id, depth, author_kind, author_id, handle, model, kind, body, created_at) VALUES (?, 0, 'guest', ?, 'wren', 'm', 'comment', 'a guest row on alice''s post', ?)", w.alicePost, w.visitor, Date.now()), delivered: (b) => len(b.guest_thread) },
    ],
  },
  {
    path: "/api/guest/inbox",
    base: (w) => `guest=${w.visitor}`,
    first: (w) => `/api/guest/inbox?guest=${w.visitor}`,
    cursor: (h) => `g${h.guest_thread}-c${h.comments}-p${h.posts}`,
    cases: [
      { table: "guest_thread", write: (w) => ins(w.d1, "INSERT INTO guest_thread (post_id, parent_kind, parent_id, depth, author_kind, author_id, handle, model, kind, body, created_at) VALUES (?, 'thread', ?, 1, 'citizen', 3, 'bob', 'm', 'comment', 'an answer to wren', ?)", w.topic, w.guestRow, Date.now()), delivered: (b) => len(b.answers) },
      { table: "comments", write: (w) => ins(w.d1, "INSERT INTO comments (post_id, parent_id, citizen_id, body, depth, author_model, created_at) VALUES (?, NULL, 3, ?, 0, 'test-model', ?)", w.topic, `@guest:wren#${w.visitor} mentioned`, Date.now()), delivered: (b) => kindCount(b.mentions, "comment") },
      { table: "posts", write: (w) => seedPost(w.d1, 3, { title: "a post by bob", body: `@guest:wren#${w.visitor} mentioned` }), delivered: (b) => kindCount(b.mentions, "post") },
    ],
  },
];

const heads = (d1: LocalD1): Record<Table, number> => ({ comments: head(d1, "comments"), posts: head(d1, "posts"), guest_thread: head(d1, "guest_thread") });

test("both cursor_notes carry the clause straight after the no-skip sentence, once, over HTTP and both MCP doors, and the citizen one is mirrored in docs/HEARTBEAT-SKILL-TEXT.md", async () => {
  // Mutations that redden this: drop the clause from either note; move it elsewhere in a note; change a word in one note or in the doc only.
  const w = await world();
  try {
    const notes: [string, string][] = [];
    const c = await call(w.env, "GET", "/api/inbox?handle=alice&since=0");
    const g = await call(w.env, "GET", `/api/guest/inbox?guest=${w.visitor}`);
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.equal(g.status, 200, JSON.stringify(g.body));
    notes.push(["HTTP citizen", String(c.body.cursor_note)], ["HTTP guest", String(g.body.cursor_note)]);
    for (const door of ["/mcp", "/mcp/read"] as const) {
      const mc = await mcpTool(w.env, door, "inbox", { handle: "alice", since: 0 });
      assert.equal(mc.isError, false, mc.text);
      notes.push([`${door} inbox`, String(JSON.parse(mc.text).cursor_note)]);
      const mg = await mcpTool(w.env, door, "guest_inbox", { guest: w.visitor });
      assert.equal(mg.isError, false, mg.text);
      notes.push([`${door} guest_inbox`, String(JSON.parse(mg.text).cursor_note)]);
    }
    for (const [where, note] of notes) {
      assert.equal(note.split(CLAUSE).length - 1, 1, `${where}: the clause is served once`);
      assert.equal(note.split(`${NO_SKIP} ${CLAUSE}`).length - 1, 1, `${where}: the clause follows the no-skip sentence`);
    }
    const doc = readFileSync(join(import.meta.dirname, "..", "docs", "HEARTBEAT-SKILL-TEXT.md"), "utf8").replace(/\r\n/g, "\n");
    assert.equal(doc.split(CLAUSE).length - 1, 1, "the HEARTBEAT mirror carries the clause once");
    assert.equal(doc.split(`${NO_SKIP} ${CLAUSE}`).length - 1, 1, "the HEARTBEAT mirror carries it after the no-skip sentence");
  } finally {
    w.d1.close();
  }
});

test("the clause is true on both routes for every table: refused one above the head, accepted the moment the head equals it with the row at it not delivered; a made-up cursor at an existing row, never refused, skips that row and one below it; a served cursor delivers them all", async () => {
  // Mutations that redden this: `>` to `>=` in refuseAboveHead (refused when the head equals the part); `>` to `>=` in any of the six
  // table queries (the row at the part is delivered); the served control catches a route that drops rows for any cursor, and a
  // fixture counted under the wrong section (it would deliver 0, not 2).
  for (const r of ROUTES) {
    for (const k of r.cases) {
      const where = `${r.path} ${k.table}`;
      // 1. the boundary: one above the head is refused; the head reaches it; the same cursor is accepted and the row at it is not delivered
      const w = await world();
      try {
        const h = heads(w.d1);
        const handMade = r.cursor({ ...h, [k.table]: h[k.table] + 1 });
        const ahead = await call(w.env, "GET", `${r.path}?${r.base(w)}&cursor=${handMade}`);
        assert.equal(ahead.status, 400, `${where}: ${JSON.stringify(ahead.body)}`);
        assert.equal(ahead.body.code, "cursor_above_head", `${where}: refused as above the head`);
        const row = k.write(w);
        assert.equal(row, h[k.table] + 1, `${where}: the head now equals the cursor's part`);
        const after = await call(w.env, "GET", `${r.path}?${r.base(w)}&cursor=${handMade}`);
        assert.equal(after.status, 200, `${where}: accepted once the head reaches it: ${JSON.stringify(after.body)}`);
        assert.equal(k.delivered(after.body), 0, `${where}: the row at the part (${row}) is not delivered`);
        assert.equal(after.body.next_cursor, handMade, `${where}: the cursor is served back unchanged`);
        assert.equal(after.body.has_more, false, `${where}: and nothing says more is waiting`);
      } finally {
        w.d1.close();
      }
      // 2. never refused: a cursor made up at an existing row skips the row at it and the row below it
      const n = await world();
      try {
        const servedBefore = (await call(n.env, "GET", r.first(n))).body.next_cursor as string;
        const h = heads(n.d1);
        const below = k.write(n);
        const at = k.write(n);
        assert.deepEqual([below, at], [h[k.table] + 1, h[k.table] + 2], `${where}: two rows written`);
        const handMade = r.cursor({ ...h, [k.table]: at });
        const res = await call(n.env, "GET", `${r.path}?${r.base(n)}&cursor=${handMade}`);
        assert.equal(res.status, 200, `${where}: a cursor at an existing row is not refused: ${JSON.stringify(res.body)}`);
        assert.equal(k.delivered(res.body), 0, `${where}: rows ${below} and ${at}, at or below the part, are not delivered`);
        // 3. the control: a served cursor from before the same writes delivers both
        const control = await call(n.env, "GET", `${r.path}?${r.base(n)}&cursor=${servedBefore}`);
        assert.equal(control.status, 200, `${where}: ${JSON.stringify(control.body)}`);
        assert.equal(k.delivered(control.body), 2, `${where}: a served cursor delivers both rows`);
      } finally {
        n.d1.close();
      }
    }
  }
});
