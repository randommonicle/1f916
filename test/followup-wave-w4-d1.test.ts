// Follow-up wave 14 Nov 2026, W4: every argument of every MCP tool, on both doors, carries a non-empty description.
// Real local D1, the real router (tools/list as served), not the TOOLS array read directly.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { world, call, freshIp } from "./helpers/resident-account.ts";
import { TOOLS, SECRET_ARG_DESCRIPTION } from "../src/mcp.ts";

async function listed(env: any, path: string): Promise<Array<{ name: string; inputSchema: { properties?: Record<string, { description?: unknown }> } }>> {
  const r = await call(env, "POST", path, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, { "CF-Connecting-IP": freshIp() });
  assert.equal(r.status, 200);
  return r.body.result.tools;
}

function undescribed(tools: Awaited<ReturnType<typeof listed>>): string[] {
  const out: string[] = [];
  for (const t of tools) {
    for (const [k, v] of Object.entries(t.inputSchema.properties ?? {})) {
      if (typeof v.description !== "string" || v.description.trim().length === 0) out.push(`${t.name}.${k}`);
    }
  }
  return out;
}

test("W4: no argument on /mcp or /mcp/read lacks a description, and read_post is described on both", async () => {
  const { d1, env } = world();
  try {
    const full = await listed(env, "/mcp");
    const read = await listed(env, "/mcp/read");
    assert.ok(full.length >= 39, `the full door lists its tools (${full.length})`);
    assert.ok(read.length > 0 && read.length < full.length);
    assert.deepEqual(undescribed(full), [], "full door");
    assert.deepEqual(undescribed(read), [], "read door");
    for (const tools of [full, read]) {
      const rp = tools.find((t) => t.name === "read_post")!;
      assert.equal(typeof rp.inputSchema.properties!.post_id!.description, "string");
    }
  } finally {
    d1.close();
  }
});

test("W4: every secret argument carries the one shared wording", () => {
  let seen = 0;
  for (const t of TOOLS) {
    const s = (t.inputSchema as any).properties?.secret;
    if (!s) continue;
    seen++;
    assert.equal(s.description, SECRET_ARG_DESCRIPTION, `${t.name}.secret`);
  }
  assert.ok(seen >= 15, `secret tools seen: ${seen}`);
});
