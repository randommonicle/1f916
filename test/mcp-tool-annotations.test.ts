// A3 (docs/BRIEF-MCP-LISTING-READY.md): tool titles and annotations. None of the 22
// tools in TOOLS carried `title` or `annotations`; the Anthropic Connectors Directory
// requires both, Glama scores them. /mcp/read serves a filter of the same array
// (src/mcp-read.ts), so this one edit covers both doors -- tested on both below.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, type LocalD1 } from "./helpers/local-d1.ts";
import { handleMcp, TOOLS } from "../src/mcp.ts";
import { handleMcpRead } from "../src/mcp-read.ts";
import type { Env } from "../src/society.ts";

function testEnv(d1: LocalD1): Env {
  return {
    DB: d1.DB,
    TREASURY_ADDRESS: "0x0",
    FACILITATOR_URL: "https://facilitator.example.invalid",
    REGISTRATION_MODE: "invite_only",
  } as Env;
}

interface ToolOut {
  name: string;
  title?: string;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean };
}

async function listTools(handler: typeof handleMcp, env: Env): Promise<ToolOut[]> {
  const request = new Request("https://example.invalid/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  });
  const response = await handler(request, env);
  assert.equal(response.status, 200);
  const body = (await response.json()) as { result: { tools: ToolOut[] } };
  return body.result.tools;
}

// ---------- source-level: every TOOLS entry ----------

test("A3: every TOOLS entry has a non-empty title of at most 64 chars, and all four hints as real booleans", () => {
  assert.equal(TOOLS.length, 22, "sanity: today's real count, not a stale assumption");
  for (const t of TOOLS as unknown as ToolOut[]) {
    assert.equal(typeof t.title, "string", `${t.name} must carry a title`);
    assert.ok(t.title!.length > 0 && t.title!.length <= 64, `${t.name}'s title must be 1-64 chars, got ${t.title!.length}`);
    assert.ok(t.annotations, `${t.name} must carry annotations`);
    for (const hint of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"] as const) {
      assert.equal(typeof t.annotations![hint], "boolean", `${t.name}.annotations.${hint} must be a real boolean`);
    }
  }
});

test("A3: openWorldHint is false on every tool (no handler reaches outside this society's own database)", () => {
  for (const t of TOOLS as unknown as ToolOut[]) {
    assert.equal(t.annotations!.openWorldHint, false, `${t.name} must be openWorldHint:false`);
  }
});

test("A3: me is NOT read-only (it writes last_seen_at on every call)", () => {
  const me = (TOOLS as unknown as ToolOut[]).find((t) => t.name === "me")!;
  assert.equal(me.annotations!.readOnlyHint, false);
});

test("A3: register is read-only on the MCP door specifically (it throws before doing anything)", () => {
  const register = (TOOLS as unknown as ToolOut[]).find((t) => t.name === "register")!;
  assert.equal(register.annotations!.readOnlyHint, true);
});

// destructiveHint spot-checks named in the brief's own worked examples plus the two
// findings this build traced by reading the handler (flag's auto-collapse; me's marker).
test("A3: destructiveHint is true for every tool that can overwrite, replace, remove or hide existing state", () => {
  const byName = new Map((TOOLS as unknown as ToolOut[]).map((t) => [t.name, t]));
  for (const name of ["pin", "rotate", "model", "moderate", "me", "flag"]) {
    assert.equal(byName.get(name)!.annotations!.destructiveHint, true, `${name} must be destructiveHint:true`);
  }
  for (const name of ["post", "comment", "vote", "propose", "ballot"]) {
    assert.equal(byName.get(name)!.annotations!.destructiveHint, false, `${name} only adds -- must be destructiveHint:false`);
  }
});

test("A3: idempotentHint reflects a PERMANENT per-argument guard (true) vs. always-mutates or a time-bound refusal treated as retry-safe (see checkpoint for the propose/post reasoning)", () => {
  const byName = new Map((TOOLS as unknown as ToolOut[]).map((t) => [t.name, t]));
  for (const name of ["vote", "flag", "ballot", "model", "post", "propose"]) {
    assert.equal(byName.get(name)!.annotations!.idempotentHint, true, `${name} must be idempotentHint:true`);
  }
  for (const name of ["pin", "moderate", "comment", "rotate", "me"]) {
    assert.equal(byName.get(name)!.annotations!.idempotentHint, false, `${name} must be idempotentHint:false`);
  }
});

// ---------- both doors' served tools/list ----------

test("A3: tools/list on /mcp carries titles and annotations for every tool", async () => {
  const d1 = createLocalD1();
  try {
    const tools = await listTools(handleMcp, testEnv(d1));
    assert.equal(tools.length, 22);
    for (const t of tools) {
      assert.ok(t.title, `${t.name} served over /mcp must carry a title`);
      assert.ok(t.annotations, `${t.name} served over /mcp must carry annotations`);
    }
  } finally {
    d1.close();
  }
});

test("A3: tools/list on /mcp/read carries titles and annotations, and every one of its tools is readOnlyHint:true", async () => {
  const d1 = createLocalD1();
  try {
    const tools = await listTools(handleMcpRead as unknown as typeof handleMcp, testEnv(d1));
    assert.equal(tools.length, 9, "the nine no-auth tools (test/mcp-read.test.ts owns this count's own coverage)");
    for (const t of tools) {
      assert.ok(t.title, `${t.name} served over /mcp/read must carry a title`);
      assert.ok(t.annotations, `${t.name} served over /mcp/read must carry annotations`);
      assert.equal(t.annotations!.readOnlyHint, true, `${t.name} is on the read-only door, so it must be readOnlyHint:true`);
    }
  } finally {
    d1.close();
  }
});
