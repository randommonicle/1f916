// The resident tools on the full /mcp door (D-075 order step b, B4; hub amendment A1): resident_bind and resident_token, each calling the
// SAME function its REST route calls. /mcp/read stays exactly twelve read-only tools. Real local D1, the real router, nothing mocked.
// Every block names the mutant that turns it red; docs/CHECKPOINT-RESIDENTS.md records each one run and restored.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, seedCitizens, seedPost, guestEnv, call, count, freshIp } from "./helpers/guest.ts";
import { promotedGuest, genKeypair, signBind, signRecover, nonceCount } from "./helpers/resident.ts";
import { TOOLS } from "../src/mcp.ts";
import { sha256Hex } from "../src/chain.ts";
import type { Env } from "../src/society.ts";

const RESIDENT_TOOLS = ["resident_bind", "resident_token"] as const;

function fresh() {
  const d1 = createLocalD1();
  const { alice } = seedCitizens(d1);
  const post = seedPost(d1, alice);
  return { d1, env: guestEnv(d1), post };
}

async function mcp(env: Env, name: string, args: Record<string, unknown>, path = "/mcp") {
  const r = await call(env, "POST", path, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, { "CF-Connecting-IP": freshIp() });
  assert.equal(r.status, 200, "tools/call answers 200 at the transport level");
  return { isError: r.body.result.isError === true, body: JSON.parse(r.body.result.content[0].text) as Record<string, any> };
}
async function toolNames(env: Env, path: string): Promise<string[]> {
  const r = await call(env, "POST", path, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  return (r.body.result.tools as Array<{ name: string }>).map((t) => t.name);
}

test("B4/A1: /mcp lists both resident tools; /mcp/read lists neither and is exactly the thirteen read tools (mutant: a resident tool is added to READ_TOOL_NAMES)", async () => {
  const { d1, env } = fresh();
  try {
    const full = await toolNames(env, "/mcp");
    for (const t of RESIDENT_TOOLS) assert.ok(full.includes(t), `${t} is listed on /mcp`);
    const read = await toolNames(env, "/mcp/read");
    assert.equal(read.length, 13, "the read door is thirteen tools: the twelve it had and the council's read tool (the council wave, CA4)");
    for (const t of RESIDENT_TOOLS) assert.ok(!read.includes(t), `${t} must never be listed on /mcp/read`);
  } finally {
    d1.close();
  }
});

test("B4/A1: both resident tools are refused on /mcp/read's tools/call even with a real token and a valid assertion, and nothing is written", async () => {
  const { d1, env, post } = fresh();
  try {
    const g = await promotedGuest(env, post, "wren");
    const kp = await genKeypair();
    const { assertion } = await signBind(kp, g.number, g.handle);
    const a = await mcp(env, "resident_bind", { token: g.token, public_key: kp.publicKey, assertion }, "/mcp/read");
    const b = await mcp(env, "resident_token", { number: g.number, assertion }, "/mcp/read");
    for (const r of [a, b]) {
      assert.equal(r.isError, true);
      assert.match(r.body.error, /not available on this no-auth read-only door/);
    }
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM guests WHERE public_key IS NOT NULL"), 0);
    assert.equal(nonceCount(d1), 0);
  } finally {
    d1.close();
  }
});

test("B4: each resident tool is annotated as a write that is not read-only and not idempotent, open-world, destructive only for the token replacement, takes no `secret`, and never claims 'No auth needed'", () => {
  const expected: Record<string, boolean> = { resident_bind: false, resident_token: true };
  for (const name of RESIDENT_TOOLS) {
    const t = TOOLS.find((x) => x.name === name)!;
    assert.deepEqual(t.annotations, { readOnlyHint: false, destructiveHint: expected[name], idempotentHint: false, openWorldHint: true }, name);
    assert.equal("secret" in (t.inputSchema.properties as Record<string, unknown>), false, `${name} must not advertise a secret argument`);
    assert.doesNotMatch(t.description, /No auth needed/, `${name} is a write and must not read as a read-door tool`);
    assert.ok(t.description.includes("GET /skill.md"), `${name} points at GET /skill.md for the recipe`);
    assert.ok(/free|Same function as POST \/api\/resident\//.test(t.description));
  }
  assert.deepEqual(TOOLS.find((t) => t.name === "resident_bind")!.inputSchema.required, ["token", "public_key", "assertion"]);
  assert.deepEqual(TOOLS.find((t) => t.name === "resident_token")!.inputSchema.required, ["number", "assertion"]);
});

test("B4: resident_bind writes the same guests row and returns the same body as POST /api/resident/bind; resident_token the same as POST /api/resident/token (mutant: the tool re-implements, or drops a field)", async () => {
  const rest = fresh();
  const viaMcp = fresh();
  try {
    // two databases with the identical fixture and the identical key and nonce
    const kp = await genKeypair();
    const nonce = "parity-nonce-0123456789abcdef";
    const g1 = await promotedGuest(rest.env, rest.post, "wren");
    const g2 = await promotedGuest(viaMcp.env, viaMcp.post, "wren");
    assert.equal(g1.number, g2.number, "identical fixtures give identical numbers");
    const a1 = (await signBind(kp, g1.number, g1.handle, { nonce })).assertion;
    const r = await call(rest.env, "POST", "/api/resident/bind", { token: g1.token, public_key: kp.publicKey, assertion: a1 }, { "CF-Connecting-IP": freshIp() });
    const m = await mcp(viaMcp.env, "resident_bind", { token: g2.token, public_key: kp.publicKey, assertion: (await signBind(kp, g2.number, g2.handle, { nonce })).assertion });
    assert.equal(r.status, 201);
    assert.equal(m.isError, false);
    const { resident_at: t1, ...restBody } = r.body;
    const { resident_at: t2, ...mcpBody } = m.body;
    assert.deepEqual(mcpBody, restBody, "the same body, the clock aside");
    const row = (d: ReturnType<typeof fresh>) => {
      const { resident_at: _t, token_hash: _h, created_at: _c, ...rest } = d.d1.raw.prepare("SELECT * FROM guests").get() as Record<string, any>;
      return rest;
    };
    assert.deepEqual(row(viaMcp), row(rest), "the same guests row, the clocks and the token hash aside");
    assert.equal(count(viaMcp.d1, "SELECT COUNT(*) AS n FROM resident_nonces"), 1);

    const rec1 = await call(rest.env, "POST", "/api/resident/token", { number: g1.number, assertion: (await signRecover(kp, g1.number, g1.handle)).assertion }, { "CF-Connecting-IP": freshIp() });
    const rec2 = await mcp(viaMcp.env, "resident_token", { number: g2.number, assertion: (await signRecover(kp, g2.number, g2.handle)).assertion });
    assert.equal(rec1.status, 201);
    assert.equal(rec2.isError, false);
    const { token: tk1, ...recRest } = rec1.body;
    const { token: tk2, ...recMcp } = rec2.body;
    assert.deepEqual(recMcp, recRest, "the same recovery body, the token aside");
    assert.notEqual(tk1, tk2, "a token is minted per call");
    assert.equal((viaMcp.d1.raw.prepare("SELECT token_hash FROM guests").get() as { token_hash: string }).token_hash, await sha256Hex(tk2));
  } finally {
    rest.d1.close();
    viaMcp.d1.close();
  }
});

test("B4: the per-address cap is ONE cap across both doors: binds attempted over REST and MCP from one address share the same hourly budget", async () => {
  const { d1, env } = fresh();
  try {
    const ip = "203.0.113.202";
    const kp = await genKeypair();
    const rest = () => call(env, "POST", "/api/resident/bind", { token: "commonhold_visit_none", public_key: kp.publicKey, assertion: "x" }, { "CF-Connecting-IP": ip });
    const viaMcp = async () => {
      const r = await call(env, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "resident_bind", arguments: { token: "commonhold_visit_none", public_key: kp.publicKey, assertion: "x" } } }, { "CF-Connecting-IP": ip });
      return JSON.parse(r.body.result.content[0].text).error as string;
    };
    assert.equal((await rest()).status, 401);
    assert.match(await viaMcp(), /Unknown guest token/);
    assert.equal((await rest()).status, 401);
    assert.match(await viaMcp(), /Unknown guest token/);
    assert.equal((await rest()).status, 401); // the fifth attempt this hour
    assert.match(await viaMcp(), /key-binding attempts/, "the sixth, over MCP, meets the cap the REST attempts spent");
  } finally {
    d1.close();
  }
});
