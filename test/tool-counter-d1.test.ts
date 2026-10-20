// Per-tool call counters (docs/BRIEF-TOOL-CALL-COUNTER-2026-10-19.md B1-B6, amendments A1-A10): a counted tools/call also adds one to
// mcp_tool:<name> / mcp_read_tool:<name>, under its own cap. Real local D1, the real router. Every block names the mutant that turns it red;
// docs/CHECKPOINT-TOOL-COUNTER.md records each one run and restored.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import { createLocalD1, seedCitizens, guestEnv, call, freshIp, type LocalD1 } from "./helpers/guest.ts";
import { DOORS, DOOR_DAILY_CAP, TOOL_DOOR_DAILY_CAP, DOORS_NOTE, countDoor, doorsReport, toolDoor, utcDay } from "../src/doors.ts";
import { TOOLS } from "../src/mcp.ts";
import { ROUTES } from "../src/discovery.ts";
import type { Env } from "../src/society.ts";

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

const rpc = (env: Env, path: string, method: string, params?: unknown) => call(env, "POST", path, { jsonrpc: "2.0", id: 1, method, params }, { "CF-Connecting-IP": freshIp() });

// Wraps env.DB: the door-counter INSERT for the doors in `failing` throws; `gate` (if given) holds every door-counter INSERT back;
// others: "throw" makes every other statement throw (a tool that reaches the database then fails with a plain Error).
function wrapped(env: Env, opts: { failing?: string[]; gate?: Promise<void>; others?: "throw" | "real" } = {}): Env {
  const db = env.DB;
  return {
    ...env,
    DB: {
      prepare(sql: string) {
        const st = db.prepare(sql);
        if (!sql.startsWith("INSERT INTO door_counts")) {
          if (opts.others === "throw") throw new Error("boom: the database is down");
          return st;
        }
        return {
          bind: (...args: unknown[]) => {
            const bound = st.bind(...args);
            return {
              run: async () => {
                if (opts.gate) await opts.gate;
                if (opts.failing?.includes(String(args[1]))) throw new Error("boom: the counter is down");
                return bound.run();
              },
            };
          },
        };
      },
      batch: (stmts: unknown[]) => db.batch(stmts as never),
    },
  } as unknown as Env;
}

async function readToolCount(env: Env): Promise<number> {
  return ((await rpc(env, "/mcp/read", "tools/list")).body.result.tools as unknown[]).length;
}

test("T1: a listed tool adds one to its call door AND to its per-tool door, on its own door only (/mcp: mcp_tool:<name>; /mcp/read: mcp_read_tool:<name>)", async () => {
  const { d1, env } = fresh();
  try {
    await rpc(env, "/mcp", "tools/call", { name: "front_page", arguments: {} });
    await rpc(env, "/mcp", "tools/call", { name: "front_page", arguments: {} });
    await rpc(env, "/mcp", "tools/call", { name: "official", arguments: {} });
    assert.deepEqual(today(d1), { mcp_tool_call: 3, "mcp_tool:front_page": 2, "mcp_tool:official": 1 });
    await rpc(env, "/mcp/read", "tools/call", { name: "front_page", arguments: {} });
    assert.deepEqual(today(d1), { mcp_tool_call: 3, "mcp_tool:front_page": 2, "mcp_tool:official": 1, mcp_read_tool_call: 1, "mcp_read_tool:front_page": 1 });
  } finally {
    d1.close();
  }
});

test("T2: an unlisted name adds no row on either door; a tool the other door does not list adds none there (membership is that door's own list)", async () => {
  const { d1, env } = fresh();
  try {
    for (const path of ["/mcp", "/mcp/read"]) {
      for (const params of [{ name: "not_a_tool" }, { name: "" }, { name: "FRONT_PAGE" }, { name: "front_page " }, { arguments: {} }, undefined]) await rpc(env, path, "tools/call", params);
    }
    assert.deepEqual(today(d1), {});
    // guest_enter is on /mcp, not on /mcp/read
    await rpc(env, "/mcp/read", "tools/call", { name: "guest_enter", arguments: { handle: "wren-y", model: "m" } });
    assert.equal(Object.keys(today(d1)).some((d) => d.includes("guest_enter")), false);
  } finally {
    d1.close();
  }
});

test("T2b: toolDoor is the membership test: it names a listed tool and returns null for any other name; the fixed door names never look like a per-tool door", () => {
  assert.equal(toolDoor("mcp_tool", "front_page", TOOLS), "mcp_tool:front_page");
  assert.equal(toolDoor("mcp_read_tool", "front_page", TOOLS), "mcp_read_tool:front_page");
  assert.equal(toolDoor("mcp_tool", "not_a_tool", TOOLS), null);
  assert.equal(toolDoor("mcp_tool", "", TOOLS), null);
  for (const d of DOORS) assert.equal(d.includes(":"), false, `${d}: a fixed door has no colon, so it can never take the per-tool cap`);
});

test("T3: the per-tool cap is 100, bound in the SQL (not just the read): the row stops rising at 100 and /api/doors says at_cap; the fixed ten still cap at 2000", async () => {
  const { d1, env } = fresh();
  try {
    const day = utcDay(Date.now());
    d1.raw.prepare("INSERT INTO door_counts (day, door, n) VALUES (?, 'mcp_tool:front_page', ?)").run(day, TOOL_DOOR_DAILY_CAP - 2);
    d1.raw.prepare("INSERT INTO door_counts (day, door, n) VALUES (?, 'mcp_tool_call', ?)").run(day, DOOR_DAILY_CAP - 2);
    for (let i = 0; i < 4; i++) await rpc(env, "/mcp", "tools/call", { name: "front_page", arguments: {} });
    assert.equal(today(d1)["mcp_tool:front_page"], TOOL_DOOR_DAILY_CAP, "the per-tool row stopped at 100");
    assert.equal(today(d1)["mcp_tool_call"], DOOR_DAILY_CAP, "the fixed door stopped at 2000, not 100");
    // concurrency: 30 parallel counts on a row at 90 land at exactly 100
    d1.raw.prepare("INSERT INTO door_counts (day, door, n) VALUES (?, 'mcp_read_tool:official', 90)").run(day);
    const door = toolDoor("mcp_read_tool", "official", TOOLS)!;
    await Promise.all(Array.from({ length: 30 }, () => countDoor(env, door)));
    assert.equal(today(d1)["mcp_read_tool:official"], TOOL_DOOR_DAILY_CAP);
    // a fixed door sitting at 100 keeps counting (the per-tool cap does not leak onto it)
    d1.raw.prepare("INSERT INTO door_counts (day, door, n) VALUES (?, 'skill_md', 100)").run(day);
    await countDoor(env, "skill_md");
    assert.equal(today(d1)["skill_md"], 101);
    const rows = (await call(env, "GET", "/api/doors")).body.rows as Array<{ door: string; n: number; at_cap: boolean }>;
    const by = Object.fromEntries(rows.map((r) => [r.door, r]));
    assert.equal(by["mcp_tool:front_page"]!.at_cap, true);
    assert.equal(by["mcp_read_tool:official"]!.at_cap, true);
    assert.equal(by["mcp_tool_call"]!.at_cap, true);
    assert.equal(by["skill_md"]!.at_cap, false, "101 of 2000 is not at cap");
    // and the read's own rule: 99 on a per-tool door is not at_cap
    d1.raw.prepare("UPDATE door_counts SET n = 99 WHERE door = 'mcp_tool:front_page'").run();
    const again = (await doorsReport(env)).rows.find((r) => r.door === "mcp_tool:front_page")!;
    assert.equal(again.at_cap, false);
  } finally {
    d1.close();
  }
});

test("T4: a failing counter write never changes the tool's answer, and either counter failing ALONE leaves the other counted", async () => {
  const { d1, env } = fresh();
  const realLog = console.log;
  const logged: string[] = [];
  try {
    console.log = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
    const healthy = await rpc(env, "/mcp", "tools/call", { name: "official", arguments: {} });
    assert.equal(healthy.status, 200);
    const onlyPerTool = await rpc(wrapped(env, { failing: ["mcp_tool:official"] }), "/mcp", "tools/call", { name: "official", arguments: {} });
    assert.equal(onlyPerTool.status, 200);
    assert.equal(onlyPerTool.body.result.isError, undefined);
    assert.deepEqual(onlyPerTool.body.result.content, healthy.body.result.content, "the answer is unchanged");
    assert.deepEqual(today(d1), { mcp_tool_call: 2, "mcp_tool:official": 1 }, "the receipt count landed, the failed per-tool write did not");
    const onlyReceipt = await rpc(wrapped(env, { failing: ["mcp_tool_call"] }), "/mcp", "tools/call", { name: "official", arguments: {} });
    assert.equal(onlyReceipt.status, 200);
    assert.deepEqual(today(d1), { mcp_tool_call: 2, "mcp_tool:official": 2 }, "the per-tool write landed, the failed receipt write did not");
    const both = await rpc(wrapped(env, { failing: ["mcp_tool_call", "mcp_tool:official"] }), "/mcp", "tools/call", { name: "official", arguments: {} });
    assert.equal(both.status, 200);
    assert.deepEqual(today(d1), { mcp_tool_call: 2, "mcp_tool:official": 2 });
    // the read door too
    const read = await rpc(wrapped(env, { failing: ["mcp_read_tool:official"] }), "/mcp/read", "tools/call", { name: "official", arguments: {} });
    assert.equal(read.status, 200);
    assert.deepEqual(today(d1), { mcp_tool_call: 2, "mcp_tool:official": 2, mcp_read_tool_call: 1 });
  } finally {
    console.log = realLog;
    d1.close();
  }
  const warns = logged.filter((l) => l.includes('"event":"door_count_failed"')).map((l) => (JSON.parse(l) as { door: string }).door);
  assert.deepEqual(warns.sort(), ["mcp_read_tool:official", "mcp_tool:official", "mcp_tool:official", "mcp_tool_call", "mcp_tool_call"].sort(), "one warn per failed write, naming the door");
});

test("A5: a refused call and a call whose dispatch throws both count BOTH rows (receipt counting), on both doors", async () => {
  const { d1, env } = fresh();
  const realLog = console.log;
  try {
    console.log = () => {};
    const refused = await rpc(env, "/mcp", "tools/call", { name: "read_post", arguments: { post_id: 999999 } });
    assert.equal(refused.body.result.isError, true);
    assert.deepEqual(today(d1), { mcp_tool_call: 1, "mcp_tool:read_post": 1 });
    const readRefused = await rpc(env, "/mcp/read", "tools/call", { name: "read_post", arguments: { post_id: 999999 } });
    assert.equal(readRefused.body.result.isError, true);
    const broken = wrapped(env, { others: "throw" });
    const thrown = await rpc(broken, "/mcp", "tools/call", { name: "front_page", arguments: {} });
    assert.ok(thrown.status >= 500, `the call really failed (${thrown.status})`);
    const readThrown = await rpc(broken, "/mcp/read", "tools/call", { name: "front_page", arguments: {} });
    assert.ok(readThrown.status >= 500);
    assert.deepEqual(today(d1), {
      mcp_tool_call: 2,
      "mcp_tool:read_post": 1,
      "mcp_tool:front_page": 1,
      mcp_read_tool_call: 2,
      "mcp_read_tool:read_post": 1,
      "mcp_read_tool:front_page": 1,
    });
  } finally {
    console.log = realLog;
    d1.close();
  }
});

test("A5: both counter writes of one tools/call go through ctx.waitUntil: the response is back while both are held, and the rows land only on release", async () => {
  const { d1, env } = fresh();
  try {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {} } as unknown as ExecutionContext;
    const held = wrapped(env, { gate });
    for (const path of ["/mcp", "/mcp/read"]) {
      const req = new Request(`https://example.test${path}`, { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": freshIp() }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "front_page", arguments: {} } }) });
      const settled = await Promise.race([worker.fetch(req, held, ctx), new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 1500))]);
      assert.notEqual(settled, "timeout", `${path}: answered while the counts were held`);
      assert.equal((settled as Response).status, 200);
    }
    assert.equal(pending.length, 4, "two counter writes per call, each handed to waitUntil");
    assert.deepEqual(today(d1), {}, "none written yet");
    release();
    await Promise.all(pending);
    assert.deepEqual(today(d1), { mcp_tool_call: 1, "mcp_tool:front_page": 1, mcp_read_tool_call: 1, "mcp_read_tool:front_page": 1 });
  } finally {
    d1.close();
  }
});

test("T5: the write budget: (every listed tool x the per-tool cap + every fixed door x its cap) x2 for index writes stays under 60,000 of the 100,000 daily D1 writes; list sizes are derived, never typed", async () => {
  const { d1, env } = fresh();
  try {
    const readTools = await readToolCount(env);
    assert.ok(TOOLS.length >= 37 && readTools >= 13, "the lists are the ones being counted");
    const increments = (TOOLS.length + readTools) * TOOL_DOOR_DAILY_CAP + DOORS.length * DOOR_DAILY_CAP;
    assert.ok(increments * 2 < 60_000, `${increments} increments x2 = ${increments * 2} must stay under 60000`);
    assert.equal(TOOL_DOOR_DAILY_CAP, 100);
  } finally {
    d1.close();
  }
});

test("T6: DOORS_NOTE names the per-tool doors, both caps in one sentence, and that the rows need not reconcile; the route description names them; /api/doors serves the note verbatim", async () => {
  assert.ok(DOORS_NOTE.includes("mcp_tool:<name>") && DOORS_NOTE.includes("mcp_read_tool:<name>"));
  assert.ok(DOORS_NOTE.includes("Each fixed door stops counting at 2000 a UTC day and each per-tool door (mcp_tool:<name>, mcp_read_tool:<name>) at 100"));
  assert.equal(DOORS_NOTE.includes("Each door stops counting at 2000"), false, "the old single-cap sentence is gone");
  assert.ok(DOORS_NOTE.includes("need not reconcile exactly"));
  const spec = ROUTES.find((r) => r.path === "/api/doors")!;
  assert.ok(spec.description.includes("mcp_tool:<name>") && spec.description.includes("mcp_read_tool:<name>"), "the route description names the per-tool rows");
  assert.ok(spec.description.includes("100"), "and their cap");
  const { d1, env } = fresh();
  try {
    assert.equal((await call(env, "GET", "/api/doors")).body.note, DOORS_NOTE);
    const surface = (await call(env, "GET", "/api/surface")).body;
    const entry = (surface.routes as Array<Record<string, unknown>>).find((x) => x.path === "/api/doors");
    assert.ok(String(entry?.description).includes("mcp_tool:<name>"));
  } finally {
    d1.close();
  }
});
