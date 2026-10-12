// The council over MCP (D-075 order step c; commission C6, CA4, CA11). One read tool, `council`, on BOTH doors; six write tools on the full /mcp door only. Each write tool
// calls the SAME function its REST route calls, so these tests compare the two doors' answers and caps rather than re-testing the rules. Real local D1 and the real
// dispatch (handleMcp, handleMcpRead), no outbound fetch. Each block names the mutant that turns it red.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { councilCast, call, rows, freshIp, withIp, bearerHeader, openMotion, signResidentBallot, citizenAssertion, seedPresence, seedResident, servedMotion } from "./helpers/council.ts";
import { handleMcp } from "../src/mcp.ts";
import { handleMcpRead } from "../src/mcp-read.ts";
import { buildIntentBinding } from "../src/keyauth.ts";
import { COUNCIL_WRITE_PER_IP_PER_HOUR } from "../src/council-core.ts";
import type { Env } from "../src/society.ts";

const WRITE_TOOLS = ["council_challenge", "council_claim", "council_write", "council_motion", "council_ballot", "council_flag"] as const;

async function rpc(handler: typeof handleMcp, env: Env, method: string, params?: unknown, headers: Record<string, string> = {}) {
  const res = await handler(new Request("https://example.test/mcp", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }), env);
  return (await res.json()) as any;
}
async function tool(env: Env, name: string, args: Record<string, unknown>, headers: Record<string, string> = {}, handler: typeof handleMcp = handleMcp): Promise<{ isError: boolean; data: any; text: string }> {
  const out = await rpc(handler, env, "tools/call", { name, arguments: args }, { "CF-Connecting-IP": freshIp(), ...headers });
  const result = out.result;
  const text = result.content[0].text as string;
  return { isError: result.isError === true, data: JSON.parse(text), text };
}
const mcpRead = handleMcpRead as unknown as typeof handleMcp;

test("tools/list: /mcp lists the council read tool and all six write tools; /mcp/read lists the read tool and NONE of the write tools (CA4, CA11) (mutants: a write tool is added to READ_TOOL_NAMES; the read tool is missing from a door)", async () => {
  const c = await councilCast();
  try {
    const full = (await rpc(handleMcp, c.env, "tools/list")).result.tools.map((t: any) => t.name);
    const read = (await rpc(mcpRead, c.env, "tools/list")).result.tools.map((t: any) => t.name);
    assert.ok(full.includes("council"));
    for (const w of WRITE_TOOLS) assert.ok(full.includes(w), `/mcp lists ${w}`);
    assert.ok(read.includes("council"));
    for (const w of WRITE_TOOLS) assert.equal(read.includes(w), false, `/mcp/read must not list ${w}`);
    assert.equal(full.length, 37);
    assert.equal(read.length, 13);
    // the council tool's description carries the phrase the door's own cross-check reads
    const desc = (await rpc(handleMcp, c.env, "tools/list")).result.tools.find((t: any) => t.name === "council").description as string;
    assert.match(desc, /No auth needed/);
  } finally {
    c.d1.close();
  }
});

test("the council read tool returns exactly what GET /api/council and GET /api/council/thread return, on both doors, with no credential (mutant: the tool builds its own object)", async () => {
  const c = await councilCast();
  try {
    await openMotion(c.env, c.sis, "statement", "A motion");
    await call(c.env, "POST", "/api/council/thread", { body: "hello" }, bearerHeader(c.sis.secret));
    const strip = (o: any) => ({ ...o, as_of: 0 });
    const rest = (await call(c.env, "GET", "/api/council")).body;
    for (const handler of [handleMcp, mcpRead]) {
      const viaTool = await tool(c.env, "council", {}, {}, handler);
      assert.equal(viaTool.isError, false);
      assert.deepEqual(strip(viaTool.data), strip(rest));
      const thread = await tool(c.env, "council", { view: "thread" }, {}, handler);
      assert.deepEqual(thread.data, (await call(c.env, "GET", "/api/council/thread")).body);
      const paged = await tool(c.env, "council", { view: "thread", limit: 1, after: 0 }, {}, handler);
      assert.equal(paged.data.messages.length, 1);
      const bad = await tool(c.env, "council", { view: "motions" }, {}, handler);
      assert.equal(bad.isError, true);
      assert.match(bad.data.error, /view is "council"/);
    }
  } finally {
    c.d1.close();
  }
});

test("the six write tools are refused on /mcp/read even with a real citizen credential, and write nothing (the enforcement layer has no case for them) (mutant: a council write case is added to callReadTool)", async () => {
  const c = await councilCast();
  try {
    for (const name of WRITE_TOOLS) {
      const r = await tool(c.env, name, { secret: c.sis.secret, token: c.wren.token, body: "x", kind: "statement", title: "t", motion_id: 1, choice: "yes" }, bearerHeader(c.sis.secret, freshIp()), mcpRead);
      assert.equal(r.isError, true, name);
      assert.match(r.data.error, /not available on this no-auth read-only door/, name);
    }
    assert.equal(rows(c.d1, "SELECT * FROM council_thread").length + rows(c.d1, "SELECT * FROM council_motions").length + rows(c.d1, "SELECT * FROM council_challenges").length, 0);
  } finally {
    c.d1.close();
  }
});

test("council_write and council_motion: a citizen credential as the secret argument, as the Authorization header, or a resident's token each work; a non-member is refused with the REST message; a citizen credential wins over a token (mutant: the dispatch reads the wrong credential)", async () => {
  const c = await councilCast();
  try {
    const viaArg = await tool(c.env, "council_write", { secret: c.sis.secret, body: "by argument" });
    assert.equal(viaArg.isError, false, viaArg.text);
    assert.equal(viaArg.data.author.byline, "sisyphus");
    const viaHeader = await tool(c.env, "council_write", { body: "by header", parent_id: viaArg.data.id }, { Authorization: `Bearer ${c.seat.secret}` });
    assert.equal(viaHeader.data.author.rule, "operator_seat");
    assert.equal(viaHeader.data.parent_id, viaArg.data.id);
    const viaToken = await tool(c.env, "council_write", { token: c.wren.token, body: "by token" });
    assert.equal(viaToken.data.author.byline, `resident:wren#${c.wren.number}`);
    const keyAssertion = await citizenAssertion(c.key);
    const viaKey = await tool(c.env, "council_write", { secret: keyAssertion, body: "by key assertion" });
    assert.equal(viaKey.isError, false, viaKey.text);
    // REST and MCP refuse the same way
    const restRefusal = await call(c.env, "POST", "/api/council/thread", { body: "no credential" }, withIp());
    const mcpRefusal = await tool(c.env, "council_write", { body: "no credential" });
    assert.equal(mcpRefusal.isError, true);
    assert.equal(mcpRefusal.data.error, restRefusal.body.error);
    // a citizen credential wins over a resident token: a non-member citizen's secret beside a member's token is refused
    const stranger = (await import("./helpers/council.ts")).seedSecretCitizen(c.d1, "magnus-v2");
    const both = await tool(c.env, "council_write", { secret: (await stranger).secret, token: c.wren.token, body: "both" });
    assert.equal(both.isError, true);
    assert.match(both.data.error, /Only council members can write here/);
    const motion = await tool(c.env, "council_motion", { token: c.wren.token, kind: "statement", title: "Over MCP", body: "b" });
    assert.equal(motion.isError, false, motion.text);
    assert.equal(motion.data.proposer.handle, "wren");
    assert.equal(rows(c.d1, "SELECT * FROM council_thread").length, 4);
  } finally {
    c.d1.close();
  }
});

test("council_ballot over MCP: a secret citizen, a key citizen with the council_ballot intent, and a resident with {number, assertion} and no credential each ballot once; the same refusals as REST (mutants: the intent is skipped over MCP; the resident branch reads a token)", async () => {
  const c = await councilCast();
  try {
    const m = (await openMotion(c.env, c.sis, "statement", "MCP ballots")).body.id as number;
    const bySecret = await tool(c.env, "council_ballot", { motion_id: m, choice: "yes", secret: c.sis.secret });
    assert.equal(bySecret.isError, false, bySecret.text);
    // a key citizen with no signed intent is refused over MCP exactly as over REST
    const unbound = await tool(c.env, "council_ballot", { motion_id: m, choice: "yes", secret: await citizenAssertion(c.key) });
    assert.equal(unbound.isError, true);
    assert.match(unbound.data.error, /carries no signed intent/);
    const bound = await tool(c.env, "council_ballot", { motion_id: m, choice: "yes", secret: await citizenAssertion(c.key, await buildIntentBinding("council_ballot", [String(m), "yes"])) });
    assert.equal(bound.isError, false, bound.text);
    const { assertion } = await signResidentBallot(c.wren, m, "no");
    const byResident = await tool(c.env, "council_ballot", { motion_id: m, choice: "no", number: c.wren.number, assertion });
    assert.equal(byResident.isError, false, byResident.text);
    assert.equal(byResident.data.member.byline, `resident:wren#${c.wren.number}`);
    const again = await tool(c.env, "council_ballot", { motion_id: m, choice: "no", secret: c.sis.secret });
    assert.equal(again.isError, true);
    assert.match(again.data.error, /already balloted/);
    assert.equal(rows(c.d1, "SELECT * FROM council_ballots").length, 3);
    // a resident token alone is not a ballot over MCP either
    const tokenOnly = await tool(c.env, "council_ballot", { motion_id: m, choice: "no", token: c.wren.token });
    assert.equal(tokenOnly.isError, true);
  } finally {
    c.d1.close();
  }
});

test("council_flag over MCP flags once, as REST does; the operator's seat is refused", async () => {
  const c = await councilCast();
  try {
    const m = (await openMotion(c.env, c.key, "statement", "To flag")).body.id as number;
    const seat = await tool(c.env, "council_flag", { motion_id: m, secret: c.seat.secret });
    assert.equal(seat.isError, true);
    assert.match(seat.data.error, /operator's seat cannot flag/);
    const ok = await tool(c.env, "council_flag", { motion_id: m, token: c.wren.token });
    assert.equal(ok.isError, false, ok.text);
    assert.equal(ok.data.operator_seat.flagged.by.handle, "wren");
    assert.equal((await servedMotion(c.env, m)).operator_seat.out_of_the_count, true);
    const second = await tool(c.env, "council_flag", { motion_id: m, secret: c.sis.secret });
    assert.equal(second.isError, true);
    assert.match(second.data.error, /already flagged/);
  } finally {
    c.d1.close();
  }
});

test("council_challenge and council_claim take the resident's token and read no citizen credential: a citizen secret as an argument or a header identifies nothing, and the refusals match REST (mutants: the dispatch passes the credential on)", async () => {
  const c = await councilCast();
  try {
    const r = await seedResident(c.d1, "hopeful");
    seedPresence(c.d1, r, 3);
    const noToken = await tool(c.env, "council_challenge", { secret: c.sis.secret }, bearerHeader(c.sis.secret));
    assert.equal(noToken.isError, true);
    assert.match(noToken.data.error, /No guest token/);
    const ch = await tool(c.env, "council_challenge", { token: r.token });
    assert.equal(ch.isError, false, ch.text);
    assert.match(ch.data.nonce, /^[A-Za-z0-9_-]{22}$/);
    const live = await tool(c.env, "council_challenge", { token: r.token });
    assert.equal(live.isError, true);
    assert.match(live.data.error, /already have a live challenge/);
    // claim: the refusals that precede any outbound read are the REST ones (and no fetch was made: the guard would have thrown)
    const platform = await tool(c.env, "council_claim", { token: r.token, platform: "the-colony", record_id: 5 });
    const restPlatform = await call(c.env, "POST", "/api/council/claim", { token: r.token, platform: "the-colony", record_id: 5 }, withIp());
    assert.equal(platform.data.error, restPlatform.body.error);
    const badId = await tool(c.env, "council_claim", { token: r.token, platform: "1f916", record_id: "abc" });
    assert.match(badId.data.error, /record_id is the id of your proof comment/);
    // the default fetch (the platform's) is the test guard: a well-formed claim is reported as an unreadable source, and the challenge is not burnt
    const reach = await tool(c.env, "council_claim", { token: r.token, platform: "1f916", record_id: 77 });
    assert.equal(reach.isError, true);
    assert.match(reach.data.error, /could not be checked.*not a refusal of your claim/s);
    assert.equal(rows(c.d1, "SELECT * FROM council_challenges WHERE used_at IS NOT NULL").length, 0);
  } finally {
    c.d1.close();
  }
});

test("the per-address cap is ONE cap across both doors: REST and MCP council writes from one address share the same budget (mutant: the MCP dispatch passes no address)", async () => {
  const c = await councilCast();
  try {
    const ip = freshIp();
    const statuses: string[] = [];
    for (let i = 0; i < COUNCIL_WRITE_PER_IP_PER_HOUR; i++) {
      if (i % 2 === 0) statuses.push(String((await call(c.env, "POST", "/api/council/thread", { body: "" }, bearerHeader(c.sis.secret, ip))).status));
      else statuses.push((await tool(c.env, "council_write", { secret: c.sis.secret, body: "" }, { "CF-Connecting-IP": ip })).isError ? "400" : "ok");
    }
    assert.ok(statuses.every((s) => s === "400"), "all within the cap are refused as empty bodies, and each counted");
    const overRest = await call(c.env, "POST", "/api/council/thread", { body: "x" }, bearerHeader(c.sis.secret, ip));
    assert.equal(overRest.status, 429);
    const overMcp = await tool(c.env, "council_write", { secret: c.sis.secret, body: "x" }, { "CF-Connecting-IP": ip });
    assert.equal(overMcp.isError, true);
    assert.match(overMcp.data.error, /Too many council writes from your address/);
  } finally {
    c.d1.close();
  }
});

test("source order: the council write dispatch sits behind the single Authorization read, after the guest branch, and callCouncilTool is not between callGuestTool and callTool (the existing fences still hold)", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const src = readFileSync(join(import.meta.dirname, "..", "src", "mcp.ts"), "utf8");
  assert.equal(src.split('request.headers.get("Authorization")').length - 1, 1, "one place reads the Authorization header");
  assert.ok(src.indexOf("GUEST_TOOL_NAMES.includes(name)") < src.indexOf("COUNCIL_WRITE_TOOL_NAMES.includes(name)"), "the guest branch is taken first");
  assert.ok(src.indexOf("async function callGuestTool(") < src.indexOf("async function callTool(") && src.indexOf("async function callTool(") < src.indexOf("async function callCouncilTool("));
  const guestTools = src.match(/const GUEST_TOOL_NAMES: readonly string\[\] = \[[^\]]*\]/)![0];
  assert.equal(/council/.test(guestTools), false, "no council tool rides the guest branch (which reads no credential at all)");
});
