// MCP tool coverage for src/mcp.ts's "citizens" tool (docs/BRIEF-HARDENING-2.md
// commit 6, HANDOVER Addendum 10's hardening-pass builder flag): the MCP
// door served the census with no pagination at all -- `case "citizens":
// return citizenDirectory(env);` called the same function GET /api/citizens
// (society.ts) uses, but never forwarded a since/since_id cursor, so an MCP
// client had no way to see past the first CITIZEN_PAGE (1000) rows. Fixed
// by mirroring the HTTP contract: the MCP tool's inputSchema gained
// since/since_id, and the handler now forwards them exactly as the
// "proposals" tool already did (mcp.ts:346-347).
//
// This is the first test in this codebase to import mcp.ts directly (every
// prior mcp.ts reference is a source-scan, e.g. register-gate.test.ts's
// offender scan) -- and mcp.ts could not actually be imported under the
// strip-types test runner until this commit: its own `from "./society"` /
// `from "./governance"` imports lacked the .ts extension, the identical
// class of bug fd9403a fixed for society.ts's own imports (fine for
// tsc/esbuild, fatal under Node's raw --experimental-strip-types ESM
// loader). Verified directly before trusting it: `node --experimental-strip-types
// -e "import('./src/mcp.ts')"` failed with "Cannot find module '.../society'"
// before the extensions were added, and succeeded after.
//
// citizenDirectory's OWN pagination arithmetic (the page-boundary
// millisecond collision, the (created_at, id) tie-break) is already proven
// correct in test/governance-d1.test.ts -- this file does not re-test that
// logic, only that the MCP tool actually forwards the cursor to it, which
// is the one thing this commit changes.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, insertCitizen, type LocalD1 } from "./helpers/local-d1.ts";
import { handleMcp } from "../src/mcp.ts";
import type { Env } from "../src/society.ts";

function testEnv(d1: LocalD1): Env {
  return {
    DB: d1.DB,
    TREASURY_ADDRESS: "0x0",
    FACILITATOR_URL: "https://facilitator.example.invalid",
    REGISTRATION_MODE: "invite_only",
  } as Env;
}

// Round-trips through the real JSON-RPC envelope handleMcp actually parses
// and produces, not a shortcut that calls internal machinery directly --
// the same contract a real MCP client depends on.
async function callCitizensTool(env: Env, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
  const request = new Request("https://example.invalid/mcp", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "citizens", arguments: args } }),
  });
  const response = await handleMcp(request, env);
  assert.equal(response.status, 200, "tools/call must succeed for a well-formed citizens call");
  const body = (await response.json()) as { result: { content: Array<{ type: string; text: string }> } };
  return JSON.parse(body.result.content[0].text);
}

test("MCP citizens: mirrors the HTTP census contract -- real total/COUNT, has_more, page_size, not a bare unpaginated array", async () => {
  const d1 = createLocalD1();
  try {
    insertCitizen(d1, { created_at: 1000 });
    insertCitizen(d1, { created_at: 2000 });
    insertCitizen(d1, { created_at: 3000 });
    const env = testEnv(d1);

    const result = await callCitizensTool(env);
    assert.equal(result.total, 3, "total is a real COUNT(*), same field GET /api/citizens serves");
    assert.equal(result.returned, 3);
    assert.equal(result.has_more, false, "3 rows on a 1000-row page is not more");
    assert.equal(result.page_size, 1000);
    assert.ok(Array.isArray(result.citizens) && result.citizens.length === 3);
    assert.equal(result.next_since, undefined, "no cursor is offered when there is nothing more to page through");
  } finally {
    d1.close();
  }
});

test("MCP citizens: a since/since_id cursor from a previous page is actually forwarded, not silently dropped", async () => {
  const d1 = createLocalD1();
  try {
    insertCitizen(d1, { handle: "first", created_at: 1000 });
    const second = insertCitizen(d1, { handle: "second", created_at: 2000 });
    insertCitizen(d1, { handle: "third", created_at: 3000 });
    const env = testEnv(d1);

    // Ask for everything strictly after "second" -- only "third" should
    // come back. If the cursor were silently dropped (the pre-fix
    // behaviour), all three would come back instead.
    const result = await callCitizensTool(env, { since: 2000, since_id: second });
    assert.equal(result.returned, 1, "only the one citizen registered after the cursor should be returned");
    const handles = (result.citizens as Array<{ handle: string }>).map((c) => c.handle);
    assert.deepEqual(handles, ["third"]);
    assert.equal(result.total, 3, "total stays the true COUNT(*) regardless of the cursor -- it is not scoped to the page");
  } finally {
    d1.close();
  }
});

// Seeding a full 1000-row page to observe a genuine has_more:true/next_since
// round trip is impractical in a local unit test (docs/BRIEF-HARDENING-2.md
// commit 6's own acknowledged shortcut: "assert cursor fields correct on
// small data if seeding a full page is impractical locally"). What IS
// practical, and is what this commit actually changes, is proving the
// cursor is forwarded at all -- the test above -- and citizenDirectory's
// own has_more/next_since arithmetic is already proven correct against
// real paging behaviour in test/governance-d1.test.ts's citizenDirectory
// suite, which this file does not duplicate.
