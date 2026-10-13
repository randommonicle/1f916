// Door funnel (docs/BRIEF-DOOR-FUNNEL-2026-10-13.md C1-C3, amendments A1-A7): a tools/list and a tools/call are counted on each MCP door,
// beside the initialize. Real local D1 (node:sqlite + the committed schema.sql), the real router; nothing mocked except one env wrapper that
// makes every statement but the door-counter INSERT throw, to reach the "unexpected exception" branch. Every block names the mutant that
// turns it red; docs/CHECKPOINT-DOOR-FUNNEL.md records each one run and restored.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, seedCitizens, guestEnv, call, freshIp, type LocalD1 } from "./helpers/guest.ts";
import { DOORS, DOORS_NOTE, utcDay } from "../src/doors.ts";
import { TOOLS } from "../src/mcp.ts";
import { ROUTES } from "../src/discovery.ts";
import type { Env } from "../src/society.ts";

const NEW_DOORS = ["mcp_tools_list", "mcp_read_tools_list", "mcp_tool_call", "mcp_read_tool_call"] as const;

function fresh() {
  const d1 = createLocalD1();
  seedCitizens(d1);
  return { d1, env: guestEnv(d1) };
}

function today(d1: LocalD1): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of d1.raw.prepare("SELECT door, n FROM door_counts WHERE day = ?").all(utcDay(Date.now())) as Array<{ door: string; n: number }>) out[r.door] = r.n;
  return out;
}

async function rpc(env: Env, path: string, method: string, params?: unknown) {
  return call(env, "POST", path, { jsonrpc: "2.0", id: 1, method, params }, { "CF-Connecting-IP": freshIp() });
}

// An env whose database throws on every statement except the door-counter INSERT: a tool that reaches the database throws a plain Error.
function throwing(env: Env): Env {
  const db = env.DB;
  return {
    ...env,
    DB: {
      prepare(sql: string) {
        if (!sql.startsWith("INSERT INTO door_counts")) throw new Error("boom: the database is down");
        return db.prepare(sql);
      },
      batch: () => Promise.reject(new Error("boom: the database is down")),
    },
  } as unknown as Env;
}

test("C1: DOORS carries the four new doors after the six old ones", () => {
  for (const d of NEW_DOORS) assert.ok((DOORS as readonly string[]).includes(d), d);
  assert.equal(DOORS.length, 10);
});

test("C1: tools/list counts mcp_tools_list on /mcp and mcp_read_tools_list on /mcp/read, once each, never on the other door", async () => {
  const { d1, env } = fresh();
  try {
    assert.equal((await rpc(env, "/mcp", "tools/list")).status, 200);
    assert.deepEqual(today(d1), { mcp_tools_list: 1 });
    assert.equal((await rpc(env, "/mcp/read", "tools/list")).status, 200);
    assert.deepEqual(today(d1), { mcp_tools_list: 1, mcp_read_tools_list: 1 });
    await rpc(env, "/mcp", "tools/list");
    assert.deepEqual(today(d1), { mcp_tools_list: 2, mcp_read_tools_list: 1 });
  } finally {
    d1.close();
  }
});

test("C1: a tools/call of a listed tool counts mcp_tool_call on /mcp and mcp_read_tool_call on /mcp/read, once each, never on the other door", async () => {
  const { d1, env } = fresh();
  try {
    const a = await rpc(env, "/mcp", "tools/call", { name: "front_page", arguments: {} });
    assert.equal(a.status, 200);
    assert.equal(a.body.result.isError, undefined);
    assert.deepEqual(today(d1), { mcp_tool_call: 1 });
    const b = await rpc(env, "/mcp/read", "tools/call", { name: "front_page", arguments: {} });
    assert.equal(b.body.result.isError, undefined);
    assert.deepEqual(today(d1), { mcp_tool_call: 1, mcp_read_tool_call: 1 });
    // a tool /mcp advertises and /mcp/read does not: on /mcp/read it is refused AND not counted (membership is THAT door's own list)
    const refused = await rpc(env, "/mcp/read", "tools/call", { name: "guest_enter", arguments: { handle: "wren-x", model: "m" } });
    assert.equal(refused.body.result.isError, true);
    assert.deepEqual(today(d1), { mcp_tool_call: 1, mcp_read_tool_call: 1 });
  } finally {
    d1.close();
  }
});

test("C1: an unknown tool name, an empty name or no name counts nothing on either door", async () => {
  const { d1, env } = fresh();
  try {
    for (const path of ["/mcp", "/mcp/read"]) {
      for (const params of [{ name: "not_a_tool", arguments: {} }, { name: "", arguments: {} }, { arguments: {} }, undefined, { name: "FRONT_PAGE" }, { name: "front_page " }]) {
        await rpc(env, path, "tools/call", params);
      }
    }
    assert.deepEqual(today(d1), {});
  } finally {
    d1.close();
  }
});

test("C1: a listed tool that REFUSES (a SocietyError) counts once, and counts none of the guest write doors", async () => {
  const { d1, env } = fresh();
  try {
    const a = await rpc(env, "/mcp", "tools/call", { name: "read_post", arguments: { post_id: 999999 } });
    assert.equal(a.body.result.isError, true);
    assert.deepEqual(today(d1), { mcp_tool_call: 1 });
    const b = await rpc(env, "/mcp", "tools/call", { name: "guest_comment", arguments: { post_id: 1, body: "no token" } });
    assert.equal(b.body.result.isError, true);
    assert.deepEqual(today(d1), { mcp_tool_call: 2 }, "the refused guest_comment is a received call and not an accepted guest comment");
    const c = await rpc(env, "/mcp/read", "tools/call", { name: "read_post", arguments: { post_id: 999999 } });
    assert.equal(c.body.result.isError, true);
    assert.deepEqual(today(d1), { mcp_tool_call: 2, mcp_read_tool_call: 1 });
  } finally {
    d1.close();
  }
});

test("C1: a listed tool whose call THROWS a generic error counts once on each door (mutant: the hook moved after dispatch)", async () => {
  const { d1, env } = fresh();
  const logged: string[] = [];
  const realLog = console.log;
  try {
    console.log = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
    const broken = throwing(env);
    const a = await rpc(broken, "/mcp", "tools/call", { name: "front_page", arguments: {} });
    assert.ok(a.status >= 500, `the call really failed (status ${a.status})`);
    const b = await rpc(broken, "/mcp/read", "tools/call", { name: "front_page", arguments: {} });
    assert.ok(b.status >= 500, `the call really failed (status ${b.status})`);
  } finally {
    console.log = realLog;
  }
  try {
    assert.deepEqual(today(d1), { mcp_tool_call: 1, mcp_read_tool_call: 1 });
  } finally {
    d1.close();
  }
});

test("C1: membership is each door's own advertised list: every tool tools/list names counts once when called, on that door only", async () => {
  const { d1, env } = fresh();
  const realLog = console.log;
  try {
    console.log = () => {};
    const broken = throwing(env); // nothing executes: each call refuses or throws, and is counted before either
    for (const path of ["/mcp", "/mcp/read"]) {
      const listed = (await rpc(env, path, "tools/list")).body.result.tools as Array<{ name: string }>;
      assert.ok(listed.length >= 13, `${path} lists tools`);
      if (path === "/mcp") assert.deepEqual(listed.map((t) => t.name), TOOLS.map((t) => t.name), "/mcp lists TOOLS");
      const before = today(d1)[path === "/mcp" ? "mcp_tool_call" : "mcp_read_tool_call"] ?? 0;
      for (const t of listed) await rpc(broken, path, "tools/call", { name: t.name, arguments: {} });
      const after = today(d1)[path === "/mcp" ? "mcp_tool_call" : "mcp_read_tool_call"] ?? 0;
      assert.equal(after - before, listed.length, `${path}: one count per listed tool`);
    }
    const t = today(d1);
    assert.equal(t.mcp_tools_list, 1);
    assert.equal(t.mcp_read_tools_list, 1);
    assert.equal(t.showhome_enter, undefined, "no tool call reached a write, so no guest door counted");
    assert.equal(t.guest_comment, undefined);
  } finally {
    console.log = realLog;
    d1.close();
  }
});

test("C3: the six old doors count exactly as before: /skill.md, /heartbeat.md and the two initializes touch none of the four new doors", async () => {
  const { d1, env } = fresh();
  try {
    await call(env, "GET", "/skill.md");
    await call(env, "GET", "/heartbeat.md");
    await rpc(env, "/mcp", "initialize", { protocolVersion: "2025-11-25" });
    await rpc(env, "/mcp/read", "initialize", { protocolVersion: "2025-11-25" });
    await rpc(env, "/mcp", "ping");
    await rpc(env, "/mcp/read", "ping");
    assert.deepEqual(today(d1), { skill_md: 1, heartbeat_md: 1, mcp_initialize: 1, mcp_read_initialize: 1 });
  } finally {
    d1.close();
  }
});

test("C3: counting never fails a request: with door_counts MISSING tools/list and tools/call still answer, and one warn line names each new door", async () => {
  const { d1, env } = fresh();
  const logged: string[] = [];
  const realLog = console.log;
  try {
    d1.raw.exec("DROP TABLE door_counts");
    console.log = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
    for (const path of ["/mcp", "/mcp/read"]) {
      const list = await rpc(env, path, "tools/list");
      assert.equal(list.status, 200);
      assert.ok(list.body.result.tools.length > 0);
      const c = await rpc(env, path, "tools/call", { name: "official", arguments: {} });
      assert.equal(c.status, 200);
      assert.equal(c.body.result.isError, undefined);
    }
  } finally {
    console.log = realLog;
    d1.close();
  }
  const warns = logged.filter((l) => l.includes('"event":"door_count_failed"')).map((l) => JSON.parse(l));
  assert.deepEqual(warns.map((w) => w.door).sort(), [...NEW_DOORS].sort());
});

test("C3: GET /api/doors serves the four new door names and a note that names them and says what they count; so does the route description", async () => {
  const { d1, env } = fresh();
  try {
    await rpc(env, "/mcp", "tools/list");
    await rpc(env, "/mcp/read", "tools/list");
    await rpc(env, "/mcp", "tools/call", { name: "front_page", arguments: {} });
    await rpc(env, "/mcp/read", "tools/call", { name: "front_page", arguments: {} });
    const r = await call(env, "GET", "/api/doors");
    assert.equal(r.status, 200);
    const doors = (r.body.rows as Array<{ door: string; n: number; at_cap: boolean }>).map((x) => x.door).sort();
    assert.deepEqual(doors, [...NEW_DOORS].sort());
    for (const row of r.body.rows as Array<{ n: number }>) assert.equal(row.n, 1);
    for (const d of NEW_DOORS) assert.ok((r.body.note as string).includes(d), `the served note names ${d}`);
    assert.equal(r.body.note, DOORS_NOTE);
    assert.match(r.body.note as string, /received/i);
    assert.match(r.body.note as string, /any outcome/i);
    assert.match(r.body.note as string, /requests, not agents/i);
    const spec = ROUTES.find((x) => x.path === "/api/doors")!;
    for (const d of NEW_DOORS) assert.ok(spec.description.includes(d), `the route description names ${d}`);
    // the same description is what /api/surface serves
    const surface = (await call(env, "GET", "/api/surface")).body;
    const entry = (surface.routes as Array<Record<string, unknown>>).find((x) => x.path === "/api/doors");
    for (const d of NEW_DOORS) assert.ok(String(entry?.description).includes(d), `/api/surface names ${d}`);
  } finally {
    d1.close();
  }
});
