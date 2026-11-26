// Both cursor_notes list which refusals of their route carry a code and which are prose only (load-bearing-2, 1f916 post 9594,
// c161017; operator's word 26 Nov 2026, D-094 note). The list is checked against the routes themselves: every refusal it names
// as coded answers with that code over HTTP, every one it names as prose only answers {error} alone with the named status, and
// over MCP none carries a code. Real local D1, the real router.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import worker from "../src/index.ts";
import { createLocalD1, seedCitizens, seedTopic, seedVisitor, guestEnv, guestComment, call, type LocalD1 } from "./helpers/guest.ts";
import type { Env } from "../src/society.ts";

const TAIL = " A prose-only refusal says nothing about checks it did not run, and a client that keeps only the first refusal never learns of a later failure: fix what it names and call again.";
const CITIZEN = "Over HTTP three refusals of this route carry a code: unknown_query_parameter, repeated_query_parameter and cursor_above_head; over MCP none does. The rest carry prose only: a missing or malformed handle, since and cursor both or neither, a malformed or out-of-range since or cursor (400), and an unknown handle (404)." + TAIL;
const GUEST = "Over HTTP three refusals of this route carry a code: unknown_query_parameter, repeated_query_parameter and cursor_above_head; over MCP none does. The rest carry prose only: a missing or malformed guest number, a malformed or out-of-range cursor (400), and an unknown guest number (404)." + TAIL;

async function world(): Promise<{ d1: LocalD1; env: Env; visitor: number }> {
  const d1 = createLocalD1();
  seedCitizens(d1);
  const env = guestEnv(d1);
  const topic = seedTopic(d1);
  const v = await seedVisitor(d1, "wren");
  const g = await guestComment(env, v.token, { post_id: topic, body: "a critique", kind: "critique" });
  assert.equal(g.status, 201, JSON.stringify(g.body));
  return { d1, env, visitor: v.id };
}

async function mcpTool(env: Env, door: "/mcp" | "/mcp/read", name: "guest_inbox" | "inbox", args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> {
  const res = await worker.fetch(
    new Request(`https://example.test${door}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }),
    env,
  );
  const body = (await res.json()) as { result: { content: { text: string }[]; isError?: boolean } };
  return { isError: body.result.isError === true, text: body.result.content[0].text };
}

test("both cursor_notes carry their route's list, over HTTP and over MCP, and the citizen one is mirrored in docs/HEARTBEAT-SKILL-TEXT.md", async () => {
  // Mutations that redden this: drop either sentence from src/inbox.ts; swap the two lists; change a word in the doc only.
  const w = await world();
  try {
    const c = await call(w.env, "GET", "/api/inbox?handle=alice&since=0");
    const g = await call(w.env, "GET", `/api/guest/inbox?guest=${w.visitor}`);
    assert.ok(String(c.body.cursor_note).includes(CITIZEN), c.body.cursor_note);
    assert.ok(String(g.body.cursor_note).includes(GUEST), g.body.cursor_note);
    assert.ok(!String(c.body.cursor_note).includes(GUEST) && !String(g.body.cursor_note).includes(CITIZEN), "each route carries its own list");
    const mg = await mcpTool(w.env, "/mcp/read", "guest_inbox", { guest: w.visitor });
    assert.ok(String(JSON.parse(mg.text).cursor_note).includes(GUEST));
    const doc = readFileSync(join(import.meta.dirname, "..", "docs", "HEARTBEAT-SKILL-TEXT.md"), "utf8").replace(/\r\n/g, "\n");
    assert.ok(doc.includes(CITIZEN));
  } finally {
    w.d1.close();
  }
});

test("the list is true over HTTP: the three named codes answer with them, and every refusal named prose only answers {error} alone with its status", async () => {
  // Mutations that redden this: give any listed prose-only refusal a code (the list is then false); drop a code from a coded one.
  const w = await world();
  try {
    const v = w.visitor;
    const coded: Array<[string, string]> = [
      ["/api/inbox?handle=alice&since=0&limit=1", "unknown_query_parameter"],
      ["/api/inbox?handle=alice&handle=alice&since=0", "repeated_query_parameter"],
      ["/api/inbox?handle=alice&cursor=c900-p0-g0", "cursor_above_head"],
      [`/api/guest/inbox?guest=${v}&limit=1`, "unknown_query_parameter"],
      [`/api/guest/inbox?guest=${v}&guest=${v}`, "repeated_query_parameter"],
      [`/api/guest/inbox?guest=${v}&cursor=g900-c0-p0`, "cursor_above_head"],
    ];
    for (const [path, code] of coded) {
      const r = await call(w.env, "GET", path);
      assert.deepEqual([r.status, r.body.code], [400, code], `${path}: ${JSON.stringify(r.body)}`);
    }
    const prose: Array<[string, number]> = [
      ["/api/inbox?since=0", 400], // missing handle
      ["/api/inbox?handle=!!&since=0", 400], // malformed handle
      ["/api/inbox?handle=alice&since=0&cursor=c0-p0", 400], // since and cursor both
      ["/api/inbox?handle=alice", 400], // neither
      ["/api/inbox?handle=alice&since=abc", 400], // malformed since
      ["/api/inbox?handle=alice&since=99999999999999999999", 400], // out-of-range since
      ["/api/inbox?handle=alice&cursor=zz", 400], // malformed cursor
      ["/api/inbox?handle=alice&cursor=c99999999999999999999-p0", 400], // out-of-range cursor
      ["/api/inbox?handle=nobody-here&since=0", 404], // unknown handle
      ["/api/guest/inbox", 400], // missing guest number
      ["/api/guest/inbox?guest=abc", 400], // malformed guest number
      [`/api/guest/inbox?guest=${v}&cursor=zz`, 400], // malformed cursor
      [`/api/guest/inbox?guest=${v}&cursor=g99999999999999999999-c0-p0`, 400], // out-of-range cursor
      ["/api/guest/inbox?guest=99999", 404], // unknown guest number
    ];
    for (const [path, status] of prose) {
      const r = await call(w.env, "GET", path);
      assert.equal(r.status, status, `${path}: ${JSON.stringify(r.body)}`);
      assert.deepEqual(Object.keys(r.body), ["error"], `${path} is prose only: ${JSON.stringify(r.body)}`);
    }
  } finally {
    w.d1.close();
  }
});

test("the list is true over MCP: none of the coded refusals carries a code on either door", async () => {
  // Mutation that reddens this: serialise SocietyError.code on either MCP door (the note's "over MCP none does" is then false).
  const w = await world();
  try {
    for (const door of ["/mcp", "/mcp/read"] as const) {
      for (const [name, args] of [["inbox", { handle: "alice", cursor: "c900-p0-g0" }], ["guest_inbox", { guest: w.visitor, cursor: "g900-c0-p0" }], ["inbox", { handle: "alice", since: "0", limit: 1 }]] as const) {
        const r = await mcpTool(w.env, door, name, args);
        assert.equal(r.isError, true, `${door} ${name}: ${r.text}`);
        assert.deepEqual(Object.keys(JSON.parse(r.text)), ["error"], `${door} ${name}: ${r.text}`);
      }
    }
  } finally {
    w.d1.close();
  }
});
