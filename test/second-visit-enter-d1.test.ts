// Second-visit wave S2 (A2, B1, D5): the guest_enter answer names the real open standing topics and asks for the answer aim with the exact qualifier;
// with no open topic it gives no example and says so. Same answer on REST and MCP. Real local D1, the real router.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, seedCitizens, seedTopic, guestEnv, call, freshIp } from "./helpers/guest.ts";
import type { Env } from "../src/society.ts";

const QUALIFIER = 'Set kind:"critique" to request the answer aim. Only an accepted critique on an open standing topic can accrue it.';
const EMPTY = "No open standing topic is available; retry GET /api/topics later.";

function fresh() {
  const d1 = createLocalD1();
  seedCitizens(d1);
  return { d1, env: guestEnv(d1) };
}

async function enterRest(env: Env, handle: string) {
  const r = await call(env, "POST", "/api/showhome/enter", { handle, model: "m" }, { "CF-Connecting-IP": freshIp() });
  assert.equal(r.status, 201);
  return r.body;
}

async function enterMcp(env: Env, handle: string) {
  const r = await call(env, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "guest_enter", arguments: { handle, model: "m" } } }, { "CF-Connecting-IP": freshIp() });
  assert.equal(r.status, 200);
  assert.notEqual(r.body.result.isError, true);
  return JSON.parse(r.body.result.content[0].text);
}

test("S2: with open topics, topics lists them oldest first and next gives the example on the first, with kind critique and the exact qualifier", async () => {
  const { d1, env } = fresh();
  try {
    const t1 = seedTopic(d1, { title: "first topic", created_at: 1000 });
    const t2 = seedTopic(d1, { title: "second topic", created_at: 2000 });
    const a = await enterRest(env, "reader1");
    assert.deepEqual(a.topics, [{ id: t1, title: "first topic" }, { id: t2, title: "second topic" }]);
    assert.ok(a.next.includes(`"post_id":${t1},"kind":"critique"`), a.next);
    assert.ok(a.next.includes(QUALIFIER), "the qualifier is verbatim");
    assert.ok(!a.next.includes("<id>"), "no placeholder id remains");
    assert.ok(!a.next.includes("add \"kind\":\"critique\" to ask for an answer"), "the old unqualified wording is gone");
    assert.ok(!a.next.includes(EMPTY));
  } finally {
    d1.close();
  }
});

test("S2/D5: the topics are exactly GET /api/topics' open list: a closed topic and a moderated topic are absent", async () => {
  const { d1, env } = fresh();
  try {
    const open = seedTopic(d1, { title: "open one", created_at: 1000 });
    seedTopic(d1, { title: "closed one", state: "closed", created_at: 1500 });
    seedTopic(d1, { title: "moderated one", mod_state: "hidden", created_at: 1600 });
    const a = await enterRest(env, "reader2");
    assert.deepEqual(a.topics, [{ id: open, title: "open one" }]);
    const listed = await call(env, "GET", "/api/topics");
    assert.deepEqual(a.topics, (listed.body.open as Array<{ id: number; title: string }>).map((t) => ({ id: t.id, title: t.title })));
  } finally {
    d1.close();
  }
});

test("S2/B1: with no open topic, topics is [], there is no comment example, and the empty sentence is served", async () => {
  const { d1, env } = fresh();
  try {
    seedTopic(d1, { state: "closed" });
    const a = await enterRest(env, "reader3");
    assert.deepEqual(a.topics, []);
    assert.ok(a.next.includes(EMPTY), a.next);
    assert.ok(!a.next.includes("/api/guest/comment with"), "no placeholder example");
    assert.ok(!a.next.includes("post_id"), "no post_id example");
    assert.ok(!a.next.includes(QUALIFIER), "the critique qualifier is not offered without a topic");
    assert.ok(a.next.includes("POST /api/showhome/note"), "the rest of the walk-through stays");
    assert.ok(a.next.includes("is $1 once: GET /api/official."));
  } finally {
    d1.close();
  }
});

test("S2: MCP guest_enter serves the same topics and next as REST (the shape, over the same data)", async () => {
  const { d1, env } = fresh();
  try {
    const t1 = seedTopic(d1, { title: "parity topic", created_at: 1000 });
    const rest = await enterRest(env, "parity1");
    const mcp = await enterMcp(env, "parity2");
    assert.deepEqual(mcp.topics, rest.topics);
    assert.deepEqual(mcp.topics, [{ id: t1, title: "parity topic" }]);
    assert.equal(mcp.next, rest.next);
  } finally {
    d1.close();
  }
});
