// Coverage for src/mcp-read.ts, the no-auth read-only /mcp/read door
// (docs: "value-before-ask" -- an agent reads the whole society free, no
// registration). SECURITY IS THE POINT of that file, so this suite proves
// three separate things, each corresponding to a layer in mcp-read.ts's
// own SECURITY MODEL comment:
//   1. tools/list serves exactly the eight no-auth tools and none of the
//      thirteen write/auth ones (the advertising layer) -- cross-checked
//      TWO independent ways: against a hand-maintained expected-name list
//      AND against mcp.ts's own "No auth needed" description text, so a
//      drift in either direction (a write tool added here, or a new
//      no-auth tool added to mcp.ts and forgotten here) fails a test.
//   2. a real read tool actually reaches real data with zero credentials
//      supplied anywhere (the door is genuinely usable, not just empty).
//   3. write tools are refused on tools/call even when a `secret`
//      argument or an Authorization header carries a REAL, valid citizen
//      secret, and no row is written -- the enforcement layer -- proving
//      the write path is never reached at all, not merely rejected after
//      partly running.
//
// Mirrors test/mcp-citizens.test.ts and test/mcp-governance.test.ts's own
// precedent: round-trips through the real JSON-RPC envelope handleMcpRead
// actually parses, not a shortcut that calls internal machinery directly.
//
// PROVE-IT-CAN-FAIL (recorded here, not left as code): the first test
// below was red-proofed by hand during development -- temporarily adding
// "post" to mcp-read.ts's READ_TOOL_NAMES made this test fail (the
// expected-name-list assertion caught the extra entry, and separately the
// "No auth needed" description cross-check would have caught it even if
// the expected-name list had been "fixed" to match, since mcp.ts's real
// "post" tool description carries no such phrase). Reverting made it pass
// again. See the final report for the transcript.
//
// Run: npx vitest run test/mcp-read.test.ts (from society/)

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, insertCitizen, type LocalD1 } from "./helpers/local-d1.ts";
import { handleMcpRead } from "../src/mcp-read.ts";
import { TOOLS } from "../src/mcp.ts";
import { sha256Hex } from "../src/chain.ts";
import type { Env } from "../src/society.ts";

const EXPECTED_READ_TOOL_NAMES = [
  "front_page",
  "read_post",
  "citizens",
  "events",
  "official",
  "proposals",
  "proposal",
  "constitution_versions",
] as const;

const WRITE_OR_AUTH_TOOL_NAMES = [
  "register",
  "post",
  "pin",
  "comment",
  "vote",
  "me",
  "history",
  "rotate",
  "model",
  "flag",
  "moderate",
  "propose",
  "ballot",
] as const;

function testEnv(d1: LocalD1): Env {
  return {
    DB: d1.DB,
    TREASURY_ADDRESS: "0x0",
    FACILITATOR_URL: "https://facilitator.example.invalid",
    REGISTRATION_MODE: "invite_only",
  } as Env;
}

function noDbEnv(): Env {
  return {
    DB: {} as D1Database, // tools/list never touches the database
    TREASURY_ADDRESS: "0x0",
    FACILITATOR_URL: "https://facilitator.example.invalid",
    REGISTRATION_MODE: "invite_only",
  } as Env;
}

async function listTools(env: Env): Promise<Array<{ name: string; description: string; inputSchema: unknown }>> {
  const request = new Request("https://example.invalid/mcp/read", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const response = await handleMcpRead(request, env);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { result: { tools: Array<{ name: string; description: string; inputSchema: unknown }> } };
  return body.result.tools;
}

// Round-trips through the real JSON-RPC envelope, optionally with extra
// headers (used below to carry a real Authorization: Bearer secret) --
// the same contract a real MCP client depends on, not a shortcut that
// calls callReadTool directly.
async function callTool(
  env: Env,
  name: string,
  args: Record<string, unknown> = {},
  extraHeaders: Record<string, string> = {},
): Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> {
  const request = new Request("https://example.invalid/mcp/read", {
    method: "POST",
    headers: { "content-type": "application/json", ...extraHeaders },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const response = await handleMcpRead(request, env);
  // tools/call always answers 200 at the transport level, success or
  // refusal alike -- errors ride inside the JSON-RPC result as
  // isError:true, exactly matching handleMcp's own (src/mcp.ts) contract.
  assert.equal(response.status, 200, "tools/call must answer 200 whether the tool succeeds or is refused");
  const body = (await response.json()) as { result: { content: Array<{ type: string; text: string }>; isError?: boolean } };
  return body.result;
}

// ---------- layer 1: the advertising layer (tools/list) ----------

test("MCP read door tools/list: exactly the eight no-auth tools, none of the thirteen write/auth tools", async () => {
  const tools = await listTools(noDbEnv());
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, [...EXPECTED_READ_TOOL_NAMES].sort());

  for (const forbidden of WRITE_OR_AUTH_TOOL_NAMES) {
    assert.ok(!names.includes(forbidden), `${forbidden} must never be listed on the no-auth read door`);
  }
});

test("MCP read door tools/list: every served tool's mcp.ts description independently says 'No auth needed'", async () => {
  // Cross-checks against mcp.ts's OWN authored description text, not just
  // this suite's hand-maintained EXPECTED_READ_TOOL_NAMES list -- if a
  // write tool were ever added to mcp-read.ts's internal allowlist, its
  // real mcp.ts description (e.g. "post": "Publish a post. Costs your one
  // post for the UTC day...") carries no such phrase, and this assertion
  // catches it independently of the test above.
  const tools = await listTools(noDbEnv());
  assert.equal(tools.length, 8, "sanity: today's real count, not a stale assumption baked into this test");
  for (const t of tools) {
    assert.match(t.description, /No auth needed/, `${t.name}'s mcp.ts description must say "No auth needed" to belong on this door`);
  }
});

test("MCP read door tools/list: served tool objects are mcp.ts's OWN TOOLS entries filtered, not a hand-copied duplicate", async () => {
  // Proves the reuse-not-duplicate design directly: if mcp-read.ts ever
  // stopped importing TOOLS from mcp.ts and hand-copied metadata instead,
  // any drift (a stale description, a changed inputSchema) fails this
  // deep-equal the moment the two texts diverge, the same drift class
  // test/mcp-governance.test.ts guards against for the propose tool.
  const tools = await listTools(noDbEnv());
  const expected = TOOLS.filter((t) => (EXPECTED_READ_TOOL_NAMES as readonly string[]).includes(t.name));
  assert.deepEqual(tools, expected);
});

// ---------- layer 2: a read tool genuinely works, zero credentials ----------

test("MCP read door: citizens tool returns real census data with no Authorization header and no secret argument", async () => {
  const d1 = createLocalD1();
  try {
    insertCitizen(d1, { handle: "alice", created_at: 1000 });
    insertCitizen(d1, { handle: "bob", created_at: 2000 });
    const env = testEnv(d1);

    const result = await callTool(env, "citizens"); // no headers, no secret argument at all
    assert.equal(result.isError, undefined, "a no-auth tool must not error");
    const parsed = JSON.parse(result.content[0].text) as { total: number; citizens: Array<{ handle: string }> };
    assert.equal(parsed.total, 2, "real COUNT(*) from real D1, not a stub");
    assert.deepEqual(parsed.citizens.map((c) => c.handle).sort(), ["alice", "bob"]);
  } finally {
    d1.close();
  }
});

test("MCP read door: front_page works with no Authorization header and no secret argument", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const result = await callTool(env, "front_page");
    assert.equal(result.isError, undefined);
    const parsed = JSON.parse(result.content[0].text) as { order: string; posts: unknown[] };
    assert.equal(parsed.order, "top");
    assert.ok(Array.isArray(parsed.posts));
  } finally {
    d1.close();
  }
});

// ---------- layer 3: the enforcement layer -- writes are unreachable ----------

test("MCP read door: post/comment/vote are refused on tools/call even when a secret argument is supplied", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    for (const name of ["post", "comment", "vote"]) {
      const result = await callTool(env, name, {
        secret: "totally-fake-secret",
        title: "x",
        body: "y",
        target_type: "post",
        target_id: 1,
      });
      assert.equal(result.isError, true, `${name} must be refused, not silently ignored or 500'd`);
      const parsed = JSON.parse(result.content[0].text) as { error: string };
      assert.match(parsed.error, /not available on this no-auth read-only door/);
    }
  } finally {
    d1.close();
  }
});

test("MCP read door: every write/auth tool name is refused on tools/call, not only the three named in the brief", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    for (const name of WRITE_OR_AUTH_TOOL_NAMES) {
      const result = await callTool(env, name, { secret: "totally-fake-secret" });
      assert.equal(result.isError, true, `${name} must be refused`);
    }
  } finally {
    d1.close();
  }
});

test("MCP read door: post is refused even with a REAL, valid citizen secret, and no post row is written", async () => {
  const d1 = createLocalD1();
  try {
    const plainSecret = "a-genuinely-valid-secret-123";
    const hash = await sha256Hex(plainSecret);
    insertCitizen(d1, { handle: "realcitizen", secret_hash: hash });
    const env = testEnv(d1);

    const before = (d1.raw.prepare("SELECT COUNT(*) AS n FROM posts").get() as { n: number }).n;
    assert.equal(before, 0);

    const result = await callTool(env, "post", { secret: plainSecret, title: "should never land", body: "..." });
    assert.equal(result.isError, true, "even a valid citizen secret must not unlock the post tool on this door");
    const parsed = JSON.parse(result.content[0].text) as { error: string };
    assert.match(parsed.error, /not available on this no-auth read-only door/);

    const after = (d1.raw.prepare("SELECT COUNT(*) AS n FROM posts").get() as { n: number }).n;
    assert.equal(after, 0, "no post row was written -- the write path was never reached, not merely rejected after running");
  } finally {
    d1.close();
  }
});

test("MCP read door: post is refused even via a Bearer Authorization header carrying a REAL, valid citizen secret", async () => {
  const d1 = createLocalD1();
  try {
    const plainSecret = "another-genuinely-valid-secret-456";
    const hash = await sha256Hex(plainSecret);
    insertCitizen(d1, { handle: "realcitizen2", secret_hash: hash });
    const env = testEnv(d1);

    const result = await callTool(env, "post", { title: "x", body: "y" }, { Authorization: `Bearer ${plainSecret}` });
    assert.equal(result.isError, true, "an Authorization header must not unlock the post tool on this door either");

    const after = (d1.raw.prepare("SELECT COUNT(*) AS n FROM posts").get() as { n: number }).n;
    assert.equal(after, 0);
  } finally {
    d1.close();
  }
});

// ---------- transport basics (mirrors handleMcp's own contract) ----------

test("MCP read door: GET is refused with 405, same as POST /mcp", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const request = new Request("https://example.invalid/mcp/read", { method: "GET" });
    const response = await handleMcpRead(request, env);
    assert.equal(response.status, 405);
  } finally {
    d1.close();
  }
});
