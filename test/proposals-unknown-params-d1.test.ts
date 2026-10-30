// /api/proposals refuses query parameters it does not know (docs/BRIEF-PROPOSALS-UNKNOWN-PARAMS.md, D-078 item 2, amendments A1-A5, B1-B3).
// Real local D1, the real router, nothing mocked. Blocks marked NEW fail on 83632cb0; blocks marked PRESERVATION already held and each
// names the one-line mutation that turns it red (docs/CHECKPOINT-proposals-unknown-params.md).
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { call, createLocalD1, seedCitizens, guestEnv, type LocalD1 } from "./helpers/guest.ts";
import type { Env } from "../src/society.ts";

// The served sentences, pinned here as the brief's wording (not read back from the source).
const NOTE_SENTENCE =
  "Only since and since_id are accepted, each at most once: any other query parameter is refused with 400 (unknown_query_parameter), and a repeated one with 400 (repeated_query_parameter), so a filter you expected cannot silently be ignored.";
const ROUTE_DESCRIPTION =
  "Open and past governance proposals. Accepts only since and since_id, each at most once; any other query parameter is refused with 400 (unknown_query_parameter or repeated_query_parameter), never silently ignored.";
const TOOL_SENTENCE = "Takes only since and since_id: any other argument is refused with an error, never silently ignored.";

function setup(opts: { onExec?: () => void } = {}) {
  const d1 = createLocalD1(opts.onExec ? { onExec: opts.onExec } : {});
  const { maintainer } = seedCitizens(d1);
  return { d1, env: guestEnv(d1), maintainer };
}

function insertProposal(d1: LocalD1, proposer: number, createdAt: number): number {
  const res = d1.raw
    .prepare("INSERT INTO proposals (kind, title, body, proposer_id, opened_at, closes_at, created_at, status) VALUES ('resolution', 't', 'b', ?, ?, ?, ?, 'open')")
    .run(proposer, createdAt, createdAt + 1, createdAt);
  return Number(res.lastInsertRowid);
}

const PAGE = 200;
// PAGE + 2 rows; the row at index PAGE shares its created_at with the row at index PAGE - 1, across the page boundary.
function seedTwoPages(d1: LocalD1, proposer: number): number[] {
  const ids: number[] = [];
  for (let i = 0; i < PAGE + 2; i++) ids.push(insertProposal(d1, proposer, i === PAGE ? 1000 + PAGE - 1 : 1000 + i));
  return ids;
}

async function rpc(env: Env, door: "/mcp" | "/mcp/read", name: string, args: unknown, withArgs = true) {
  const params: Record<string, unknown> = { name };
  if (withArgs) params.arguments = args;
  const r = await call(env, "POST", door, { jsonrpc: "2.0", id: 1, method: "tools/call", params }, { "CF-Connecting-IP": "203.0.113.9" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const res = r.body.result;
  return { isError: res.isError === true, parsed: JSON.parse(res.content[0].text) };
}

const DOORS = ["/mcp", "/mcp/read"] as const;

// ---------- 1-5: HTTP refusals (NEW) ----------

test("1 (NEW): ?status=open is 400 unknown_query_parameter naming status and listing since, since_id", async () => {
  const { d1, env } = setup();
  try {
    const r = await call(env, "GET", "/api/proposals?status=open");
    assert.equal(r.status, 400);
    assert.equal(r.body.code, "unknown_query_parameter");
    assert.match(r.body.error, /status/);
    assert.match(r.body.error, /since\b/);
    assert.match(r.body.error, /since_id/);
  } finally {
    d1.close();
  }
});

test("2 (NEW): every unknown key is named once, in first-seen order, even when repeated", async () => {
  const { d1, env } = setup();
  try {
    const r = await call(env, "GET", "/api/proposals?status=open&kind=x&status=y");
    assert.equal(r.status, 400);
    assert.equal(r.body.code, "unknown_query_parameter");
    const named = r.body.error.split("accepts only")[0];
    assert.equal((named.match(/status/g) ?? []).length, 1);
    assert.equal((named.match(/kind/g) ?? []).length, 1);
    assert.ok(named.indexOf("status") < named.indexOf("kind"));
  } finally {
    d1.close();
  }
});

test("3 (NEW): an empty-valued key and a bare key are unknown keys too", async () => {
  const { d1, env } = setup();
  try {
    for (const q of ["?status=", "?status"]) {
      const r = await call(env, "GET", `/api/proposals${q}`);
      assert.equal(r.status, 400, q);
      assert.equal(r.body.code, "unknown_query_parameter", q);
      assert.match(r.body.error, /status/, q);
    }
  } finally {
    d1.close();
  }
});

test("4 (NEW): keys are case-sensitive (?Since=1 is unknown) and named after URL decoding (?st%61tus=1 names status)", async () => {
  const { d1, env } = setup();
  try {
    const a = await call(env, "GET", "/api/proposals?Since=1");
    assert.equal(a.status, 400);
    assert.match(a.body.error, /Since/);
    const b = await call(env, "GET", "/api/proposals?st%61tus=1");
    assert.equal(b.status, 400);
    assert.match(b.body.error.split("accepts only")[0], /status/);
  } finally {
    d1.close();
  }
});

test("5 (NEW): a repeated known key is 400 repeated_query_parameter (identical values too); unknown keys take precedence and the repeat is then not named", async () => {
  const { d1, env } = setup();
  try {
    for (const q of ["?since=1&since=2", "?since=5&since=5", "?since_id=1&since_id=2"]) {
      const r = await call(env, "GET", `/api/proposals${q}`);
      assert.equal(r.status, 400, q);
      assert.equal(r.body.code, "repeated_query_parameter", q);
      assert.match(r.body.error, new RegExp(q.slice(1).split("=")[0]), q);
    }
    const both = await call(env, "GET", "/api/proposals?since=1&since=2&status=open");
    assert.equal(both.status, 400);
    assert.equal(both.body.code, "unknown_query_parameter");
    assert.match(both.body.error, /status/);
    assert.doesNotMatch(both.body.error.split("accepts only")[0], /since/);
  } finally {
    d1.close();
  }
});

// ---------- 6: MCP refusals on both doors (NEW) ----------

test("6 (NEW): the MCP proposals tool refuses unknown arguments (status, and secret) and non-object arguments on both doors; null, omitted and {} are allowed", async () => {
  const { d1, env } = setup();
  try {
    for (const door of DOORS) {
      for (const args of [{ status: "open" }, { secret: "commonhold_sk_x" }, { since: 1, status: "open" }]) {
        const r = await rpc(env, door, "proposals", args);
        assert.equal(r.isError, true, `${door} ${JSON.stringify(args)}`);
        assert.match(r.parsed.error, /since_id/);
        assert.match(r.parsed.error, new RegExp(Object.keys(args).includes("secret") ? "secret" : "status"));
      }
      for (const bad of [[], "open", 5, true]) {
        const r = await rpc(env, door, "proposals", bad);
        assert.equal(r.isError, true, `${door} ${JSON.stringify(bad)}`);
      }
      for (const ok of [{}, null]) {
        const r = await rpc(env, door, "proposals", ok);
        assert.equal(r.isError, false, `${door} ${JSON.stringify(ok)}`);
        assert.equal(r.parsed.total, 0);
      }
      const omitted = await rpc(env, door, "proposals", undefined, false);
      assert.equal(omitted.isError, false, `${door} omitted`);
    }
  } finally {
    d1.close();
  }
});

test("6b (NEW): tools/list on both doors carries additionalProperties:false and the refusal sentence on the proposals tool", async () => {
  const { d1, env } = setup();
  try {
    for (const door of DOORS) {
      const r = await call(env, "POST", door, { jsonrpc: "2.0", id: 1, method: "tools/list" }, { "CF-Connecting-IP": "203.0.113.9" });
      const tool = r.body.result.tools.find((t: { name: string }) => t.name === "proposals");
      assert.equal(tool.inputSchema.additionalProperties, false, door);
      assert.ok(tool.description.includes(TOOL_SENTENCE), `${door}: ${tool.description}`);
    }
  } finally {
    d1.close();
  }
});

// ---------- 7: served text, asserted on rendered outputs (NEW) ----------

test("7 (NEW): the rendered note, /llms.txt, /openapi.json and /api/surface carry the refusal and the at-most-once rule", async () => {
  const { d1, env } = setup();
  try {
    const list = await call(env, "GET", "/api/proposals");
    assert.equal(list.status, 200);
    assert.ok(list.body.note.includes(NOTE_SENTENCE), list.body.note);

    const llms = (await call(env, "GET", "/llms.txt")).body._text as string;
    assert.ok(llms.includes(ROUTE_DESCRIPTION), "llms.txt");

    const surface = (await call(env, "GET", "/api/surface")).body as { routes: Array<{ method: string; path: string; description: string; note?: string }> };
    const sr = surface.routes.find((r) => r.method === "GET" && r.path === "/api/proposals");
    assert.equal(sr?.description, ROUTE_DESCRIPTION);

    const oa = (await call(env, "GET", "/openapi.json")).body as { paths: Record<string, { get?: { description?: string; summary?: string } }> };
    const op = JSON.stringify(oa.paths["/api/proposals"]?.get);
    assert.ok(op.includes("unknown_query_parameter"), op);
    assert.ok(op.includes("repeated_query_parameter"), op);
  } finally {
    d1.close();
  }
});

// ---------- 8: refused requests touch no proposals query (NEW) ----------

test("8 (NEW): a refused HTTP request executes zero D1 statements; a refused MCP call executes exactly its two door_counts writes, and they landed", async () => {
  let n = 0;
  const { d1, env } = setup({ onExec: () => { n++; } });
  try {
    for (const q of ["?status=open", "?since=1&since=2"]) {
      n = 0;
      const r = await call(env, "GET", `/api/proposals${q}`);
      assert.equal(r.status, 400);
      assert.equal(n, 0, `${q}: ${n} statements ran`);
    }
    const countsOf = (door: string) => Number((d1.raw.prepare("SELECT COALESCE(SUM(n), 0) AS n FROM door_counts WHERE door = ?").get(door) as { n: number }).n);
    for (const [door, total, perTool] of [["/mcp", "mcp_tool_call", "mcp_tool:proposals"], ["/mcp/read", "mcp_read_tool_call", "mcp_read_tool:proposals"]] as const) {
      const before = [countsOf(total), countsOf(perTool)];
      n = 0;
      const r = await rpc(env, door, "proposals", { status: "open" });
      assert.equal(r.isError, true);
      assert.equal(n, 2, `${door}: ${n} counted statements`);
      assert.deepEqual([countsOf(total), countsOf(perTool)], [before[0] + 1, before[1] + 1], `${door} receipts`);
    }
  } finally {
    d1.close();
  }
});

// ---------- 9: HTTP preservation ----------

test("9 (PRESERVATION): no params, ?since= and the cursor pair walk the two-page fixture exactly as before, losing no tied row", async () => {
  const { d1, env, maintainer } = setup();
  try {
    const ids = seedTwoPages(d1, maintainer);
    const head = ids.slice(0, PAGE);
    const tail = ids.slice(PAGE);
    for (const q of ["", "?since="]) {
      const r = (await call(env, "GET", `/api/proposals${q}`)).body;
      assert.deepEqual(r.proposals.map((p: { id: number }) => p.id), head, q);
      assert.equal(r.returned, PAGE);
      assert.equal(r.total, PAGE + 2);
      assert.equal(r.page_size, PAGE);
      assert.equal(r.has_more, true);
      assert.equal(r.next_since, 1000 + PAGE - 1);
      assert.equal(r.next_since_id, ids[PAGE - 1]);
      assert.equal(r.max_id, ids[PAGE + 1]);
      assert.equal(r.max_assigned_id, ids[PAGE + 1]);
      assert.equal(typeof r.as_of, "number");
      assert.equal(new Date(r.as_of).toISOString(), r.as_of_utc);
    }
    const next = (await call(env, "GET", `/api/proposals?since=${1000 + PAGE - 1}&since_id=${ids[PAGE - 1]}`)).body;
    assert.deepEqual(next.proposals.map((p: { id: number }) => p.id), tail);
    assert.equal(next.returned, 2);
    assert.equal(next.total, PAGE + 2);
    assert.equal(next.has_more, false);
    assert.equal(next.next_since, undefined);
    assert.equal(next.next_since_id, undefined);
    assert.equal(next.max_id, ids[PAGE + 1]);
  } finally {
    d1.close();
  }
});

// ---------- 10: MCP preservation ----------

test("10 (PRESERVATION): the MCP proposals tool on both doors gives the HTTP ids and cursor fields for {} and for valid cursors", async () => {
  const { d1, env, maintainer } = setup();
  try {
    const ids = seedTwoPages(d1, maintainer);
    const cursor = { since: 1000 + PAGE - 1, since_id: ids[PAGE - 1] };
    const httpFirst = (await call(env, "GET", "/api/proposals")).body;
    const httpNext = (await call(env, "GET", `/api/proposals?since=${cursor.since}&since_id=${cursor.since_id}`)).body;
    for (const door of DOORS) {
      const first = await rpc(env, door, "proposals", {});
      assert.equal(first.isError, false);
      assert.deepEqual(first.parsed.proposals.map((p: { id: number }) => p.id), ids.slice(0, PAGE));
      for (const f of ["returned", "total", "has_more", "next_since", "next_since_id", "max_id", "max_assigned_id", "page_size"]) assert.equal(first.parsed[f], httpFirst[f], `${door} ${f}`);
      const next = await rpc(env, door, "proposals", cursor);
      assert.equal(next.isError, false);
      assert.deepEqual(next.parsed.proposals.map((p: { id: number }) => p.id), ids.slice(PAGE));
      for (const f of ["returned", "total", "has_more", "max_id"]) assert.equal(next.parsed[f], httpNext[f], `${door} ${f}`);
      assert.equal(next.parsed.next_since, undefined);
    }
  } finally {
    d1.close();
  }
});
