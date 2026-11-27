// Both cursor_notes say that only a served next_cursor carries the no-skip promise: a cursor the route did not serve can be refused
// as above the head and then accepted once the head reaches it, and the rows the client was never sent are skipped (soft-power,
// 1f916 post 9594, c161482; operator's word 27 Nov 2026, D-094 note 2). The sentence is checked where it is served (both routes,
// both MCP doors, the HEARTBEAT mirror, straight after the no-skip sentence), and checked true on both routes at the exact boundary
// GEMINI named on 27 Nov: refused while one above the head, accepted the moment the head reaches it, the row at it not delivered,
// while a served cursor over the same writes delivers it. Real local D1, the real router.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import worker from "../src/index.ts";
import { createLocalD1, insertCitizen, seedCitizens, seedTopic, seedVisitor, guestEnv, guestComment, call, type LocalD1 } from "./helpers/guest.ts";
import type { Env } from "../src/society.ts";

const NO_SKIP = "so the next_cursor a page serves skips nothing committed after that page, apart from what note says moderation can hide.";
const CLAUSE = "Only a served next_cursor carries that promise: a cursor this route did not serve can be refused as above the head and then accepted once the head reaches it, and rows the client was never sent are skipped.";

interface World { d1: LocalD1; env: Env; visitor: number; topic: number }

async function world(): Promise<World> {
  const d1 = createLocalD1();
  seedCitizens(d1); // 1 = commonhold-agent, 2 = alice
  insertCitizen(d1, { handle: "bob" }); // 3
  const env = guestEnv(d1);
  const topic = seedTopic(d1);
  const v = await seedVisitor(d1, "wren");
  const g = await guestComment(env, v.token, { post_id: topic, body: "a critique", kind: "critique" });
  assert.equal(g.status, 201, JSON.stringify(g.body));
  return { d1, env, visitor: v.id, topic };
}

function addComment(d1: LocalD1, post: number, citizen: number, body: string): number {
  return Number(
    d1.raw
      .prepare("INSERT INTO comments (post_id, parent_id, citizen_id, body, depth, author_model, created_at) VALUES (?, NULL, ?, ?, 0, 'test-model', ?)")
      .run(post, citizen, body, Date.now()).lastInsertRowid,
  );
}

const head = (d1: LocalD1, table: string): number => Number((d1.raw.prepare(`SELECT COALESCE(MAX(id), 0) AS m FROM ${table}`).get() as { m: number }).m);

async function mcpTool(env: Env, door: "/mcp" | "/mcp/read", name: "guest_inbox" | "inbox", args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const res = await worker.fetch(
    new Request(`https://example.test${door}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }),
    env,
  );
  const body = (await res.json()) as { result: { content: { text: string }[]; isError?: boolean } };
  return { isError: body.result.isError === true, text: body.result.content[0].text };
}

const ROUTES = [
  { path: "/api/guest/inbox", base: (w: World) => `guest=${w.visitor}`, first: (w: World) => `/api/guest/inbox?guest=${w.visitor}`, cursor: (g: number, c: number, p: number) => `g${g}-c${c}-p${p}` },
  { path: "/api/inbox", base: () => "handle=alice", first: () => "/api/inbox?handle=alice&since=0", cursor: (g: number, c: number, p: number) => `c${c}-p${p}-g${g}` },
] as const;

test("both cursor_notes carry the clause straight after the no-skip sentence, once, over HTTP and both MCP doors, and the citizen one is mirrored in docs/HEARTBEAT-SKILL-TEXT.md", async () => {
  // Mutations that redden this: drop the clause from either note; move it elsewhere in a note; change a word in one note or in the doc only.
  const w = await world();
  try {
    const notes: [string, string][] = [];
    notes.push(["HTTP citizen", String((await call(w.env, "GET", "/api/inbox?handle=alice&since=0")).body.cursor_note)]);
    notes.push(["HTTP guest", String((await call(w.env, "GET", `/api/guest/inbox?guest=${w.visitor}`)).body.cursor_note)]);
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
    assert.equal(doc.split(`${NO_SKIP} ${CLAUSE}`).length - 1, 1, "the HEARTBEAT mirror carries the clause after the no-skip sentence");
  } finally {
    w.d1.close();
  }
});

test("the clause is true on both routes at the boundary: one above the head is refused, the same cursor is accepted the moment the head reaches it and the row at it is not delivered; a served cursor over the same writes delivers it", async () => {
  // Mutations that redden this: `>` to `>=` in refuseAboveHead (the cursor is still refused when the head equals it); `>` to `>=` in the
  // comments query (the row at the cursor is delivered, so the clause would be false); the served control catches a route that drops rows for any cursor.
  for (const r of ROUTES) {
    const mention = (w: World) => `@alice @guest:wren#${w.visitor} mentioned`;
    const w = await world();
    try {
      const g = head(w.d1, "guest_thread"), c = head(w.d1, "comments"), p = head(w.d1, "posts");
      const handMade = r.cursor(g, c + 1, p);
      const ahead = await call(w.env, "GET", `${r.path}?${r.base(w)}&cursor=${handMade}`);
      assert.equal(ahead.status, 400, `${r.path}: ${JSON.stringify(ahead.body)}`);
      assert.equal(ahead.body.code, "cursor_above_head", `${r.path}: refused as above the head`);
      const reached = addComment(w.d1, w.topic, 3, mention(w));
      assert.equal(reached, c + 1, "the head now equals the cursor's comment part");
      const after = await call(w.env, "GET", `${r.path}?${r.base(w)}&cursor=${handMade}`);
      assert.equal(after.status, 200, `${r.path}: accepted once the head reaches it: ${JSON.stringify(after.body)}`);
      assert.deepEqual(after.body.mentions.map((m: { id: number }) => m.id), [], `${r.path}: the row at the cursor (${reached}) was never sent and is skipped`);
    } finally {
      w.d1.close();
    }
    const s = await world();
    try {
      const served = (await call(s.env, "GET", r.first(s))).body.next_cursor as string;
      const row = addComment(s.d1, s.topic, 3, mention(s));
      const res = await call(s.env, "GET", `${r.path}?${r.base(s)}&cursor=${served}`);
      assert.equal(res.status, 200, `${r.path}: ${JSON.stringify(res.body)}`);
      assert.deepEqual(res.body.mentions.map((m: { id: number }) => m.id), [row], `${r.path}: a served cursor delivers the row`);
    } finally {
      s.d1.close();
    }
  }
});
