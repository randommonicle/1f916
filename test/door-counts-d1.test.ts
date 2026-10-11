// Door counters (D-075 order step a, Part C): migration 0019, src/doors.ts and the hooks. Real local D1 (node:sqlite + the committed
// schema.sql), the real router; the one test seam is a wrapper around env.DB that holds ONLY the door-counter INSERT back, to prove a
// request does not wait for its count. Every block names the mutant that turns it red; docs/CHECKPOINT-MCP-GUEST-DOOR.md records each
// one run and restored.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import worker from "../src/index.ts";
import { createLocalD1, seedCitizens, seedPost, seedTopic, seedVisitor, guestEnv, guestComment, call, count, freshIp, type LocalD1 } from "./helpers/guest.ts";
import { DOORS, DOOR_DAILY_CAP, countDoor, utcDay } from "../src/doors.ts";
import type { Env } from "../src/society.ts";

const ROOT = join(import.meta.dirname, "..");
const norm = (s: string) => s.replace(/\r\n/g, "\n");

function fresh() {
  const d1 = createLocalD1();
  seedCitizens(d1);
  return { d1, env: guestEnv(d1) };
}

function rows(d1: LocalD1): Array<{ day: string; door: string; n: number }> {
  return (d1.raw.prepare("SELECT day, door, n FROM door_counts ORDER BY day, door").all() as Array<{ day: string; door: string; n: number }>).map((r) => ({ ...r }));
}

// the counts as {door: n} for today (UTC)
function today(d1: LocalD1): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of d1.raw.prepare("SELECT door, n FROM door_counts WHERE day = ?").all(utcDay(Date.now())) as Array<{ door: string; n: number }>) out[r.door] = r.n;
  return out;
}

async function mcp(env: Env, path: string, method: string, params?: unknown, headers: Record<string, string> = {}) {
  const r = await call(env, "POST", path, { jsonrpc: "2.0", id: 1, method, params }, headers);
  assert.equal(r.status, 200);
  return r;
}

// ---------- C1: the migration ----------

test("C1: migration 0019 adds exactly one table, door_counts(day, door, n) with primary key (day, door), no foreign key, and schema.sql carries the same block", () => {
  const migration = norm(readFileSync(join(ROOT, "migrations", "0019_door_counts.sql"), "utf8"));
  const schema = norm(readFileSync(join(ROOT, "schema.sql"), "utf8"));
  const header = "-- Door counters (migrations/0019_door_counts.sql";
  const cut = schema.indexOf(header);
  assert.ok(cut > 0, "schema.sql carries the door block's header comment");
  const pre = schema.slice(0, cut);
  const tables = (db: DatabaseSync) => (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'sqlite_sequence' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
  const before = new DatabaseSync(":memory:");
  const after = new DatabaseSync(":memory:");
  const full = new DatabaseSync(":memory:");
  try {
    before.exec(pre);
    after.exec(pre);
    after.exec(migration);
    full.exec(schema);
    assert.deepEqual(tables(after), [...tables(before), "door_counts"].sort(), "exactly one table added, nothing existing touched");
    assert.deepEqual(tables(after), tables(full), "migration on the pre-0019 schema gives the same table set as schema.sql");
    const info = after.prepare("SELECT cid, name, type, \"notnull\", dflt_value, pk FROM pragma_table_info('door_counts') ORDER BY cid").all() as Array<Record<string, unknown>>;
    assert.deepEqual(
      info.map((c) => [c.name, c.type, c.notnull, c.dflt_value, c.pk]),
      [["day", "TEXT", 1, null, 1], ["door", "TEXT", 1, null, 2], ["n", "INTEGER", 1, "0", 0]],
      "three columns in order; the primary key is (day, door)",
    );
    assert.equal((after.prepare("SELECT COUNT(*) AS n FROM pragma_foreign_key_list('door_counts')").get() as { n: number }).n, 0, "no foreign key (L-016)");
    // the statement in the migration is the statement in schema.sql
    const stmt = (sql: string) => /CREATE TABLE IF NOT EXISTS door_counts \([\s\S]*?\n\);/.exec(sql)?.[0];
    assert.ok(stmt(migration) && stmt(migration) === stmt(schema), "the CREATE TABLE is identical in the migration and schema.sql");
    // idempotent
    after.exec(migration);
    assert.deepEqual(tables(after), tables(full));
    // the primary key refuses a second row for the same (day, door)
    after.exec("INSERT INTO door_counts (day, door) VALUES ('2026-10-11', 'skill_md')");
    assert.throws(() => after.exec("INSERT INTO door_counts (day, door) VALUES ('2026-10-11', 'skill_md')"), /UNIQUE constraint failed/);
  } finally {
    before.close();
    after.close();
    full.close();
  }
});

// ---------- C2: the counter ----------

test("C2: DOORS is exactly the six named doors and the cap is 2000", () => {
  assert.deepEqual([...DOORS], ["skill_md", "heartbeat_md", "mcp_initialize", "mcp_read_initialize", "showhome_enter", "guest_comment"]);
  assert.equal(DOOR_DAILY_CAP, 2000);
});

test("C2: countDoor inserts 1, then adds one per call, keyed by UTC day and door; a new day is a new row", async () => {
  const { d1, env } = fresh();
  try {
    const noon = Date.UTC(2026, 9, 11, 12, 0, 0);
    await countDoor(env, "skill_md", noon);
    await countDoor(env, "skill_md", noon + 1000);
    await countDoor(env, "heartbeat_md", noon);
    await countDoor(env, "skill_md", Date.UTC(2026, 9, 11, 23, 59, 59));
    await countDoor(env, "skill_md", Date.UTC(2026, 9, 12, 0, 0, 0));
    assert.deepEqual(rows(d1), [
      { day: "2026-10-11", door: "heartbeat_md", n: 1 },
      { day: "2026-10-11", door: "skill_md", n: 3 },
      { day: "2026-10-12", door: "skill_md", n: 1 },
    ]);
  } finally {
    d1.close();
  }
});

test("C2: the cap holds: the count stops at DOOR_DAILY_CAP and a call at the cap changes nothing (also under concurrency)", async () => {
  const { d1, env } = fresh();
  try {
    const day = utcDay(Date.now());
    d1.raw.prepare("INSERT INTO door_counts (day, door, n) VALUES (?, 'skill_md', ?)").run(day, DOOR_DAILY_CAP - 2);
    await Promise.all([1, 2, 3, 4, 5].map(() => countDoor(env, "skill_md")));
    assert.equal(today(d1).skill_md, DOOR_DAILY_CAP, "five concurrent counts from two below the cap end exactly at the cap");
    await countDoor(env, "skill_md");
    assert.equal(today(d1).skill_md, DOOR_DAILY_CAP, "and a further count changes nothing");
    await countDoor(env, "heartbeat_md");
    assert.equal(today(d1).heartbeat_md, 1, "the cap is per door");
  } finally {
    d1.close();
  }
});

// ---------- C2: the hooks ----------

test("C2: each hook increments exactly its door, once per event; GET /skill.md and /heartbeat.md count on a 200 only", async () => {
  const { d1, env } = fresh();
  try {
    assert.equal((await call(env, "GET", "/skill.md")).status, 200);
    assert.deepEqual(today(d1), { skill_md: 1 });
    assert.equal((await call(env, "GET", "/heartbeat.md")).status, 200);
    assert.deepEqual(today(d1), { skill_md: 1, heartbeat_md: 1 });
    await call(env, "GET", "/skill.md");
    assert.deepEqual(today(d1), { skill_md: 2, heartbeat_md: 1 });
    // a non-GET, and a route that is not the file, count nothing
    assert.equal((await call(env, "POST", "/skill.md", {})).status, 404);
    assert.equal((await call(env, "GET", "/skill.mdx")).status, 404);
    assert.deepEqual(today(d1), { skill_md: 2, heartbeat_md: 1 });
    // OPTIONS (CORS preflight) counts nothing
    const pre = await worker.fetch(new Request("https://example.test/skill.md", { method: "OPTIONS" }), env);
    assert.equal(pre.status, 200);
    assert.deepEqual(today(d1), { skill_md: 2, heartbeat_md: 1 });
  } finally {
    d1.close();
  }
});

test("C2: initialize counts mcp_initialize on /mcp and mcp_read_initialize on /mcp/read, once each; tools/list, ping and tools/call count nothing", async () => {
  const { d1, env } = fresh();
  try {
    await mcp(env, "/mcp", "initialize", { protocolVersion: "2025-11-25" });
    assert.deepEqual(today(d1), { mcp_initialize: 1 });
    await mcp(env, "/mcp/read", "initialize", { protocolVersion: "2025-11-25" });
    assert.deepEqual(today(d1), { mcp_initialize: 1, mcp_read_initialize: 1 });
    await mcp(env, "/mcp", "tools/list");
    await mcp(env, "/mcp/read", "tools/list");
    await mcp(env, "/mcp", "ping");
    await mcp(env, "/mcp/read", "ping");
    await mcp(env, "/mcp", "tools/call", { name: "official", arguments: {} });
    assert.equal((await call(env, "POST", "/mcp", { jsonrpc: "2.0", method: "notifications/initialized" })).status, 202);
    assert.deepEqual(today(d1), { mcp_initialize: 1, mcp_read_initialize: 1 });
    await mcp(env, "/mcp", "initialize");
    assert.deepEqual(today(d1), { mcp_initialize: 2, mcp_read_initialize: 1 });
  } finally {
    d1.close();
  }
});

test("C2: showhome_enter counts an ACCEPTED enter on BOTH doors, once; a refused enter counts nothing on either", async () => {
  const { d1, env } = fresh();
  try {
    const ip = () => ({ "CF-Connecting-IP": freshIp() });
    assert.equal((await call(env, "POST", "/api/showhome/enter", { handle: "rest-one", model: "m" }, ip())).status, 201);
    assert.deepEqual(today(d1), { showhome_enter: 1 });
    const viaMcp = await mcp(env, "/mcp", "tools/call", { name: "guest_enter", arguments: { handle: "mcp-one", model: "m" } }, ip());
    assert.equal(viaMcp.body.result.isError, undefined);
    assert.deepEqual(today(d1), { showhome_enter: 2 });
    // refused: a malformed handle, a citizen's handle
    assert.equal((await call(env, "POST", "/api/showhome/enter", { handle: "x", model: "m" }, ip())).status, 400);
    assert.equal((await call(env, "POST", "/api/showhome/enter", { handle: "alice", model: "m" }, ip())).status, 409);
    const refusedMcp = await mcp(env, "/mcp", "tools/call", { name: "guest_enter", arguments: { handle: "alice", model: "m" } }, ip());
    assert.equal(refusedMcp.body.result.isError, true);
    assert.deepEqual(today(d1), { showhome_enter: 2 }, "no refusal counted");
  } finally {
    d1.close();
  }
});

test("C2: guest_comment counts an ACCEPTED guest comment on BOTH doors, once; a refused one (a link, a closed topic, no token) counts nothing; showhome_note has no door", async () => {
  const { d1, env } = fresh();
  try {
    const open = seedTopic(d1);
    const closed = seedTopic(d1, { state: "closed" });
    const post = seedPost(d1, 2);
    const v = await seedVisitor(d1, "wren");
    const ip = () => ({ "CF-Connecting-IP": freshIp() });
    assert.equal((await guestComment(env, v.token, { post_id: post, body: "a plain comment over REST" })).status, 201);
    assert.deepEqual(today(d1), { guest_comment: 1 });
    const viaMcp = await mcp(env, "/mcp", "tools/call", { name: "guest_comment", arguments: { token: v.token, post_id: open, body: "a plain comment over MCP", kind: "critique" } }, ip());
    assert.equal(viaMcp.body.result.isError, undefined);
    assert.deepEqual(today(d1), { guest_comment: 2 });
    // refusals, on both doors
    for (const args of [
      { token: v.token, post_id: post, body: "see http://example.com" },
      { token: v.token, post_id: closed, body: "a plain comment on a closed topic" },
      { post_id: post, body: "no token" },
    ]) {
      assert.ok((await call(env, "POST", "/api/guest/comment", args, ip())).status >= 400);
      assert.equal((await mcp(env, "/mcp", "tools/call", { name: "guest_comment", arguments: args }, ip())).body.result.isError, true);
    }
    assert.deepEqual(today(d1), { guest_comment: 2 }, "no refusal counted");
    // a showhome note (either door) is not one of the six doors
    assert.equal((await call(env, "POST", "/api/showhome/note", { token: v.token, body: "a note" }, ip())).status, 201);
    assert.equal((await mcp(env, "/mcp", "tools/call", { name: "showhome_note", arguments: { token: v.token, body: "a second note" } }, ip())).body.result.isError, undefined);
    assert.deepEqual(today(d1), { guest_comment: 2 });
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM showhome_notes"), 2);
  } finally {
    d1.close();
  }
});

test("C2: counting never fails a request: with the table MISSING every counted route still answers as before, and one warn line names the door", async () => {
  const { d1, env } = fresh();
  const logged: string[] = [];
  const realLog = console.log;
  try {
    d1.raw.exec("DROP TABLE door_counts");
    console.log = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
    const ip = () => ({ "CF-Connecting-IP": freshIp() });
    assert.equal((await call(env, "GET", "/skill.md")).status, 200);
    assert.equal((await call(env, "GET", "/heartbeat.md")).status, 200);
    assert.equal((await mcp(env, "/mcp", "initialize")).status, 200);
    assert.equal((await mcp(env, "/mcp/read", "initialize")).status, 200);
    const enter = await call(env, "POST", "/api/showhome/enter", { handle: "no-table", model: "m" }, ip());
    assert.equal(enter.status, 201);
    const post = seedPost(d1, 2);
    assert.equal((await guestComment(env, enter.body.token, { post_id: post, body: "still accepted" })).status, 201);
    const viaMcp = await mcp(env, "/mcp", "tools/call", { name: "guest_comment", arguments: { token: enter.body.token, post_id: post, body: "still accepted over MCP" } }, ip());
    assert.equal(viaMcp.body.result.isError, undefined);
  } finally {
    console.log = realLog;
    d1.close();
  }
  const warns = logged.filter((l) => l.includes('"event":"door_count_failed"')).map((l) => JSON.parse(l));
  assert.deepEqual(warns.map((w) => [w.level, w.door]).sort(), [
    ["warn", "guest_comment"],
    ["warn", "guest_comment"],
    ["warn", "heartbeat_md"],
    ["warn", "mcp_initialize"],
    ["warn", "mcp_read_initialize"],
    ["warn", "showhome_enter"],
    ["warn", "skill_md"],
  ].sort(), "one warn per failed count, naming the door, at warn level");
});

// ---------- C2: counting does not slow a request ----------

// A wrapper that holds back ONLY the door-counter INSERT until `gate` resolves. Everything else is the real D1.
function gated(env: Env, gate: Promise<void>): Env {
  const db = env.DB;
  return {
    ...env,
    DB: {
      prepare(sql: string) {
        const st = db.prepare(sql);
        if (!sql.startsWith("INSERT INTO door_counts")) return st;
        return {
          bind: (...args: unknown[]) => {
            const bound = st.bind(...args);
            return { run: async () => (await gate, bound.run()) };
          },
        };
      },
      batch: (stmts: unknown[]) => db.batch(stmts as never),
    },
  } as unknown as Env;
}

test("C2: with a ctx, no counted route waits for its count: ctx.waitUntil receives each one, and the rows land only when released", async () => {
  const { d1, env } = fresh();
  try {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {} } as unknown as ExecutionContext;
    const held = gated(env, gate);
    const ip = () => ({ "CF-Connecting-IP": freshIp() });
    const post = (path: string, body: unknown) => new Request(`https://example.test${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...ip() }, body: JSON.stringify(body) });
    const requests: Array<[string, Request]> = [
      ["GET /skill.md", new Request("https://example.test/skill.md")],
      ["GET /heartbeat.md", new Request("https://example.test/heartbeat.md")],
      ["POST /mcp initialize", post("/mcp", { jsonrpc: "2.0", id: 1, method: "initialize" })],
      ["POST /mcp/read initialize", post("/mcp/read", { jsonrpc: "2.0", id: 1, method: "initialize" })],
      ["POST /api/showhome/enter", post("/api/showhome/enter", { handle: "rest-held", model: "m" })],
      ["POST /mcp guest_enter", post("/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "guest_enter", arguments: { handle: "mcp-held", model: "m" } } })],
    ];
    for (const [label, req] of requests) {
      const settled = await Promise.race([worker.fetch(req, held, ctx), new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 1500))]);
      assert.notEqual(settled, "timeout", `${label}: the response must come back while its count is still held`);
      assert.ok((settled as Response).status < 300, `${label}: answered ${(settled as Response).status}`);
    }
    assert.equal(pending.length, requests.length, "each count was handed to ctx.waitUntil, once");
    assert.equal(rows(d1).length, 0, "and none has been written yet");
    release();
    await Promise.all(pending);
    assert.deepEqual(today(d1), { skill_md: 1, heartbeat_md: 1, mcp_initialize: 1, mcp_read_initialize: 1, showhome_enter: 2 });
  } finally {
    d1.close();
  }
});
