// The above-head cursor refusal carries a code over HTTP, and both cursor notes say what each door serves and that a refusal
// reports the first failing check only, parameters before cursor (soft-power and load-bearing-2, 1f916 post 9594, 25-26 Nov
// 2026: the combination probe showed a stray parameter hides an above-head cursor, and the above-head 400 was the one refusal in
// their table without a code; D-094 (2)). The MCP doors serialise a SocietyError as {error} only (src/mcp.ts, src/mcp-read.ts),
// so over MCP the refusal is a tool error with the message and no code, and the note says so. Real local D1, the real router.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import worker from "../src/index.ts";
import { createLocalD1, seedCitizens, seedTopic, seedVisitor, guestEnv, guestComment, call, type LocalD1 } from "./helpers/guest.ts";
import type { Env } from "../src/society.ts";

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

const SENTENCE =
  "A part above the newest row of its table is refused: over HTTP with 400, code cursor_above_head; over MCP as a tool error carrying the message only. A refusal reports the first failing check only: the parameters (a tool's arguments, over MCP) are checked before the cursor, so a cursor refused with a parameter was not compared, and of several parts above their heads only the first, in this cursor's own order, is named.";

test("over HTTP the above-head refusal carries code cursor_above_head on both routes, and nothing else changes in its body", async () => {
  // Mutations that redden this: drop the code argument in refuseAboveHead; give it another code.
  const w = await world();
  try {
    for (const path of [`/api/guest/inbox?guest=${w.visitor}&cursor=g900-c0-p0`, "/api/inbox?handle=alice&cursor=c900-p0-g0"]) {
      const res = await call(w.env, "GET", path);
      assert.equal(res.status, 400, `${path}: ${JSON.stringify(res.body)}`);
      assert.deepEqual(Object.keys(res.body).sort(), ["code", "error"], `${path}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.code, "cursor_above_head");
      assert.match(res.body.error, /, above the newest one here \(\d+\)\. Pass next_cursor exactly as a previous response served it, or /);
    }
  } finally {
    w.d1.close();
  }
});

test("over MCP, both doors and both tools, the above-head refusal is a tool error with the message only, as the note says", async () => {
  // Mutation that reddens this: serialise the MCP error with its code on one door without changing the note (the note is then false there).
  const w = await world();
  try {
    for (const door of ["/mcp", "/mcp/read"] as const) {
      for (const [name, args, part] of [["guest_inbox", { guest: w.visitor, cursor: "g900-c0-p0" }, "guest row"], ["inbox", { handle: "alice", cursor: "c900-p0-g0" }, "comment"]] as const) {
        const r = await mcpTool(w.env, door, name, args);
        assert.equal(r.isError, true, `${door} ${name}: ${r.text}`);
        const body = JSON.parse(r.text);
        assert.deepEqual(Object.keys(body), ["error"], `${door} ${name}: ${r.text}`);
        assert.match(body.error, new RegExp(`^cursor's ${part} id is 900, above the newest one here`));
      }
    }
  } finally {
    w.d1.close();
  }
});

test("several parts above their heads: only the first in the cursor's own order is named, on both routes", async () => {
  // Mutation that reddens this: reorder either route's parts list in refuseAboveHead's call.
  const w = await world();
  try {
    for (const [path, part] of [
      [`/api/guest/inbox?guest=${w.visitor}&cursor=g900-c900-p900`, "guest row"],
      [`/api/guest/inbox?guest=${w.visitor}&cursor=g0-c900-p900`, "comment"],
      ["/api/inbox?handle=alice&cursor=c900-p900-g900", "comment"],
      ["/api/inbox?handle=alice&cursor=c0-p900-g900", "post"],
    ] as const) {
      const res = await call(w.env, "GET", path);
      assert.equal(res.body.code, "cursor_above_head", `${path}: ${JSON.stringify(res.body)}`);
      assert.match(res.body.error, new RegExp(`^cursor's ${part} id is 900,`), path);
      assert.equal((res.body.error.match(/above the newest/g) ?? []).length, 1, `${path} names one part`);
    }
  } finally {
    w.d1.close();
  }
});

test("a stray or repeated parameter is refused before the cursor is compared, in either order, on both routes; over MCP an unknown argument beats it too", async () => {
  // Mutation that reddens this: run the parameter check after the pages are read (the above-head refusal then wins).
  const w = await world();
  try {
    for (const [path, code] of [
      [`/api/guest/inbox?guest=${w.visitor}&cursor=g900-c0-p0&limit=1`, "unknown_query_parameter"],
      [`/api/guest/inbox?limit=1&guest=${w.visitor}&cursor=g900-c0-p0`, "unknown_query_parameter"],
      [`/api/guest/inbox?guest=${w.visitor}&cursor=g900-c0-p0&cursor=g900-c0-p0`, "repeated_query_parameter"],
      ["/api/inbox?handle=alice&cursor=c900-p0-g0&limit=1", "unknown_query_parameter"],
      ["/api/inbox?limit=1&handle=alice&cursor=c900-p0-g0", "unknown_query_parameter"],
      ["/api/inbox?handle=alice&cursor=c900-p0-g0&handle=alice", "repeated_query_parameter"],
    ] as const) {
      const res = await call(w.env, "GET", path);
      assert.deepEqual([res.status, res.body.code], [400, code], `${path}: ${JSON.stringify(res.body)}`);
      assert.doesNotMatch(res.body.error, /above the newest/);
    }
    for (const door of ["/mcp", "/mcp/read"] as const) {
      for (const [name, args] of [["guest_inbox", { guest: w.visitor, cursor: "g900-c0-p0", limit: 1 }], ["inbox", { handle: "alice", cursor: "c900-p0-g0", limit: 1 }]] as const) {
        const r = await mcpTool(w.env, door, name, args);
        assert.equal(r.isError, true, `${door} ${name}: ${r.text}`);
        assert.doesNotMatch(r.text, /above the newest/, `${door} ${name}: ${r.text}`);
        assert.match(r.text, /limit/, `${door} ${name} names the argument: ${r.text}`);
      }
    }
  } finally {
    w.d1.close();
  }
});

test("docs/HEARTBEAT-SKILL-TEXT.md carries the same sentence in the citizen cursor_note", () => {
  // Mutation that reddens this: change a word of the sentence in the document only.
  const doc = readFileSync(join(import.meta.dirname, "..", "docs", "HEARTBEAT-SKILL-TEXT.md"), "utf8").replace(/\r\n/g, "\n");
  assert.ok(doc.includes(SENTENCE));
});

test("both cursor notes carry the sentence, over HTTP and over MCP", async () => {
  // Mutations that redden this: remove the sentence from either note; change its wording on one route only.
  const w = await world();
  try {
    const g = await call(w.env, "GET", `/api/guest/inbox?guest=${w.visitor}`);
    const c = await call(w.env, "GET", "/api/inbox?handle=alice&since=0");
    for (const [name, res] of [["guest", g], ["citizen", c]] as const) {
      assert.equal(res.status, 200, `${name}: ${JSON.stringify(res.body)}`);
      assert.ok(String(res.body.cursor_note).includes(SENTENCE), `${name} cursor_note: ${res.body.cursor_note}`);
    }
    const mg = await mcpTool(w.env, "/mcp", "guest_inbox", { guest: w.visitor });
    assert.ok(String(JSON.parse(mg.text).cursor_note).includes(SENTENCE), "guest_inbox over MCP serves the same note");
  } finally {
    w.d1.close();
  }
});
