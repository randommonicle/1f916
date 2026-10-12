// The council serves an earned seat's evidence WITHOUT the stored record text (council gate L3, 12 Oct; DECISIONS D-075 note 12 Oct afternoon, item 10; commission C3, RW5, RW6).
// The record is a third party's words: no deny check reads it and no route can remove it, so it is not served on any surface. REST GET /api/council and the MCP `council` tool (both
// doors) are one projection. The claim response is covered in test/council-claim-d1.test.ts. Real rows in the D1 harness. Mutant for every block: record_body is put back into
// the SELECT and the projection in src/council.ts councilMembers.
//
// Run just this file: node --experimental-strip-types --test "test/council-evidence-body-d1.test.ts"

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, guestEnv, call, seedWorld, seedEarned } from "./helpers/council.ts";
import { handleMcp } from "../src/mcp.ts";
import { handleMcpRead } from "../src/mcp-read.ts";
import type { Env } from "../src/society.ts";

const SENTINEL = "SENTINEL-RECORD-TEXT-9f3a: a third party's words that must never be served";

async function mcpCouncil(handler: typeof handleMcp, env: Env): Promise<string> {
  const res = await handler(
    new Request("https://example.test/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", "CF-Connecting-IP": "198.51.100.9" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "council", arguments: {} } }),
    }),
    env,
  );
  const out = (await res.json()) as any;
  assert.equal(out.result.isError === true, false);
  return out.result.content[0].text as string;
}

test("the stored record text is in no served council answer: REST, the MCP council tool on both doors; the link, hashes and proof flags are", async () => {
  const d1 = createLocalD1();
  try {
    seedWorld(d1);
    const env = guestEnv(d1);
    const finch = await seedEarned(d1, "finch", { external_handle: "finch-on-1f916", record_id: "424242", record_body: SENTINEL });

    const rest = await call(env, "GET", "/api/council");
    assert.equal(rest.status, 200);
    const member = rest.body.members.find((m: { handle: string }) => m.handle === "finch");
    assert.equal(member.number, finch.number);
    assert.deepEqual(member.evidence.proof_found, { nonce: true, resident_number: true, public_key: true });
    assert.equal(member.evidence.record_link, "https://1f916.ai/api/comment/424242");
    assert.match(member.evidence.record_sha256, /^[a-z0-9]{64}$/);
    assert.match(member.evidence.account_sha256, /^[a-z0-9]{64}$/);

    const texts = [JSON.stringify(rest.body), await mcpCouncil(handleMcp, env), await mcpCouncil(handleMcpRead as unknown as typeof handleMcp, env)];
    for (const [i, t] of texts.entries()) {
      assert.ok(!t.includes(SENTINEL), `surface ${i} serves the record text`);
      assert.ok(!t.includes("record_body"), `surface ${i} still names a record_body key`);
    }
    // and /api/official's council block never carried it either
    const official = JSON.stringify((await call(env, "GET", "/api/official")).body);
    assert.ok(!official.includes(SENTINEL) && !official.includes("record_body"));

    // the column itself stays: the proof stays checkable by hash if the 1f916 record is later edited or deleted (K8.3)
    assert.equal((d1.raw.prepare("SELECT record_body FROM council_claims").get() as { record_body: string }).record_body, SENTINEL);
  } finally {
    d1.close();
  }
});

test("no served sentence says the record text is served: the roster note and the claim note say it is stored and not served", async () => {
  const d1 = createLocalD1();
  try {
    seedWorld(d1);
    const env = guestEnv(d1);
    const note = (await call(env, "GET", "/api/council")).body.note as string;
    assert.match(note, /proof_found/);
    assert.match(note, /record's stored text is not served/);
    assert.doesNotMatch(note, /what this server read from the other platform/);
  } finally {
    d1.close();
  }
});
