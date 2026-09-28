// A2 (docs/BRIEF-MCP-LISTING-READY.md): protocol version negotiation. Both doors used
// to echo back whatever protocolVersion a caller sent verbatim (the recon sent
// 1999-01-01 and got it back) instead of answering with a version this deployment
// actually supports, as the spec requires. Coverage:
//   - negotiateProtocolVersion() as a pure function, every case named in the brief
//   - both doors' real initialize response uses it, round-tripped through the real
//     JSON-RPC envelope (handleMcp/handleMcpRead directly, matching
//     test/mcp-citizens.test.ts's own precedent for a plain initialize/tools/list check)
//   - serverInfo.title, per door
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, type LocalD1 } from "./helpers/local-d1.ts";
import { handleMcp } from "../src/mcp.ts";
import { handleMcpRead } from "../src/mcp-read.ts";
import { negotiateProtocolVersion, SUPPORTED_PROTOCOL_VERSIONS } from "../src/mcp.ts";
import type { Env } from "../src/society.ts";

function testEnv(d1: LocalD1): Env {
  return {
    DB: d1.DB,
    TREASURY_ADDRESS: "0x0",
    FACILITATOR_URL: "https://facilitator.example.invalid",
    REGISTRATION_MODE: "invite_only",
  } as Env;
}

async function initialize(handler: typeof handleMcp, env: Env, protocolVersion?: unknown): Promise<{ protocolVersion: string; serverInfo: { name: string; version: string; title: string } }> {
  const params = protocolVersion === undefined ? {} : { protocolVersion };
  const request = new Request("https://example.invalid/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params }),
  });
  const response = await handler(request, env);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { result: { protocolVersion: string; serverInfo: { name: string; version: string; title: string } } };
  return body.result;
}

// ---------- negotiateProtocolVersion, pure ----------

test("A2: negotiateProtocolVersion is a pure function over every case the brief names", () => {
  assert.equal(negotiateProtocolVersion("1999-01-01"), "2025-11-25", "an unrecognised old version negotiates down to the newest supported");
  assert.equal(negotiateProtocolVersion("2025-06-18"), "2025-06-18", "a supported-but-not-newest version is honoured exactly");
  assert.equal(negotiateProtocolVersion("2025-11-25"), "2025-11-25", "the newest supported version is honoured exactly");
  assert.equal(negotiateProtocolVersion("2026-07-28"), "2025-11-25", "a newer, unsupported version negotiates down, never up");
  assert.equal(negotiateProtocolVersion(undefined), "2025-11-25", "a missing version defaults to the newest supported");
  assert.equal(negotiateProtocolVersion(null), "2025-11-25", "a null version defaults to the newest supported");
  assert.equal(negotiateProtocolVersion(42), "2025-11-25", "a non-string version defaults to the newest supported, never coerced");
  assert.equal(negotiateProtocolVersion(""), "2025-11-25", "an empty string is not a supported version");
});

test("A2: SUPPORTED_PROTOCOL_VERSIONS is newest first, exactly the two versions the brief names", () => {
  assert.deepEqual(SUPPORTED_PROTOCOL_VERSIONS, ["2025-11-25", "2025-06-18"]);
});

// ---------- both doors' real initialize response ----------

for (const [label, handler] of [
  ["handleMcp (/mcp)", handleMcp],
  ["handleMcpRead (/mcp/read)", handleMcpRead],
] as const) {
  test(`A2: ${label} initialize negotiates the requested protocolVersion through the real JSON-RPC envelope`, async () => {
    const d1 = createLocalD1();
    try {
      const env = testEnv(d1);
      assert.equal((await initialize(handler, env, "1999-01-01")).protocolVersion, "2025-11-25");
      assert.equal((await initialize(handler, env, "2025-06-18")).protocolVersion, "2025-06-18");
      assert.equal((await initialize(handler, env, "2025-11-25")).protocolVersion, "2025-11-25");
      assert.equal((await initialize(handler, env, "2026-07-28")).protocolVersion, "2025-11-25");
      assert.equal((await initialize(handler, env)).protocolVersion, "2025-11-25", "an absent protocolVersion param");
    } finally {
      d1.close();
    }
  });
}

test("A2: serverInfo.title distinguishes the two doors", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const full = await initialize(handleMcp, env);
    assert.equal(full.serverInfo.title, "Commonhold");
    assert.equal(full.serverInfo.name, "commonhold", "the wire `name` field is unchanged by this wave");
    const read = await initialize(handleMcpRead, env);
    assert.equal(read.serverInfo.title, "Commonhold (read-only)");
    assert.equal(read.serverInfo.name, "commonhold-read", "the wire `name` field is unchanged by this wave");
  } finally {
    d1.close();
  }
});
