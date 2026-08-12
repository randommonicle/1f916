// Served-schema coverage for src/mcp.ts's governance tools
// (docs/BRIEF-FIRST-LAWS.md commit 5, drift item 6): the "propose" tool's
// own kind enum used to be a hardcoded nine-literal array, independent of
// PROPOSAL_KINDS -- exactly the shape that let first_laws_ratify and
// first_laws_amendment go undocumented to every MCP client the moment
// they were added to governance.ts, with no test anywhere to catch it.
// This is the test that was missing when that drift landed. mcp.ts is now
// built BY CONSTRUCTION (kind.enum spreads PROPOSAL_KINDS directly), so
// this test is a regression guard against the enum ever being hand-edited
// back into a parallel literal, not a guard against today's specific
// eleven kinds.
//
// Mirrors test/mcp-citizens.test.ts's own precedent: round-trips through
// the real JSON-RPC envelope handleMcp actually parses, not a shortcut
// that reads TOOLS directly.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { handleMcp } from "../src/mcp.ts";
import { PROPOSAL_KINDS } from "../src/governance.ts";
import { createLocalD1 } from "./helpers/local-d1.ts";
import type { Env } from "../src/society.ts";

function testEnv(): Env {
  return {
    DB: {} as D1Database, // tools/list never touches the database
    TREASURY_ADDRESS: "0x0",
    FACILITATOR_URL: "https://facilitator.example.invalid",
    REGISTRATION_MODE: "invite_only",
  } as Env;
}

async function listTools(env: Env): Promise<Array<{ name: string; description: string; inputSchema: unknown }>> {
  const request = new Request("https://example.invalid/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const response = await handleMcp(request, env);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { result: { tools: Array<{ name: string; description: string; inputSchema: unknown }> } };
  return body.result.tools;
}

test("MCP tools/list: the propose tool's kind enum is exactly PROPOSAL_KINDS, in the same order, not a parallel literal list", async () => {
  const tools = await listTools(testEnv());
  const propose = tools.find((t) => t.name === "propose");
  assert.ok(propose, "the propose tool must be listed");
  const schema = propose!.inputSchema as { properties: { kind: { enum: string[] } } };
  assert.deepEqual(schema.properties.kind.enum, [...PROPOSAL_KINDS]);
  assert.equal(schema.properties.kind.enum.length, 11, "sanity: today's real count, not a stale assumption baked into this test");
  assert.ok(schema.properties.kind.enum.includes("first_laws_ratify"));
  assert.ok(schema.properties.kind.enum.includes("first_laws_amendment"));
});

test("MCP tools/list: the propose tool's description states the entrenched window is 14 days, not just a flat 7", async () => {
  const tools = await listTools(testEnv());
  const propose = tools.find((t) => t.name === "propose");
  assert.match(propose!.description, /14/);
  assert.match(propose!.description, /first_laws_ratify/);
});

test("MCP tools/list: the propose tool's payload guidance names both new payload-less kinds", async () => {
  const tools = await listTools(testEnv());
  const propose = tools.find((t) => t.name === "propose");
  const schema = propose!.inputSchema as { properties: { payload: { description: string } } };
  assert.match(schema.properties.payload.description, /first_laws_ratify/);
  assert.match(schema.properties.payload.description, /first_laws_amendment/);
});

// Red-proof precondition, re-derived directly rather than assumed: this
// test only means something if PROPOSAL_KINDS itself genuinely has eleven
// entries including the two First Laws kinds at this point in the wave.
test("precondition: PROPOSAL_KINDS itself carries the two First Laws kinds (governance.ts, not mcp.ts)", () => {
  assert.equal(PROPOSAL_KINDS.length, 11);
  assert.ok(PROPOSAL_KINDS.includes("first_laws_ratify"));
  assert.ok(PROPOSAL_KINDS.includes("first_laws_amendment"));
});

// ---------- the new constitution_versions tool (design doc §8: "versions tool if cheap") ----------

test("MCP tools/list: the constitution_versions tool is listed, no auth required, with the same since/since_id cursor shape as proposals", async () => {
  const tools = await listTools(testEnv());
  const versionsTool = tools.find((t) => t.name === "constitution_versions");
  assert.ok(versionsTool, "the constitution_versions tool must be listed");
  const schema = versionsTool!.inputSchema as { properties: { since: unknown; since_id: unknown } };
  assert.ok(schema.properties.since);
  assert.ok(schema.properties.since_id);
});

test("MCP constitution_versions tool: actually callable, mirrors the HTTP GET /api/constitution/versions contract", async () => {
  const d1 = createLocalD1();
  try {
    d1.raw
      .prepare(
        "INSERT INTO constitution_versions (template_hash, parameters_hash, full_text, parameters_text, first_seen_at, changed_by, mandate_proposal_ids) VALUES (?, ?, ?, ?, ?, 'genesis', '[]')",
      )
      .run("hash-a", "hash-b", "full text", "params text", 1000);

    const env: Env = {
      DB: d1.DB,
      TREASURY_ADDRESS: "0x0",
      FACILITATOR_URL: "https://facilitator.example.invalid",
      REGISTRATION_MODE: "invite_only",
    } as Env;

    const request = new Request("https://example.invalid/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "constitution_versions", arguments: {} } }),
    });
    const response = await handleMcp(request, env);
    assert.equal(response.status, 200);
    const body = (await response.json()) as { result: { content: Array<{ type: string; text: string }> } };
    const result = JSON.parse(body.result.content[0].text) as { total: number; returned: number; versions: Array<{ changed_by: string }> };
    assert.equal(result.total, 1);
    assert.equal(result.returned, 1);
    assert.equal(result.versions[0].changed_by, "genesis");
  } finally {
    d1.close();
  }
});
