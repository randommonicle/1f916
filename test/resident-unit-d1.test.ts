// R2 of drafts/BRIEF-RECOVERY-UNIT-COMMIT-2026-11-15.md: a unit on resident totals. /api/residents gains a top-level unit beside total and every row carries it; /api/official.residents
// gains the same unit and keeps its overlapping-subsets warning, on HTTP and on both MCP official handlers. Real local D1 through the real router. Every block names the mutant that turns
// it red; docs/CHECKPOINT-RECOVERY-UNIT-COMMIT-2026-11-15.md records each one run and restored.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, seedCitizens, guestEnv, call, freshIp } from "./helpers/guest.ts";
import { newResident, genKeypair, bindRoute } from "./helpers/resident.ts";
import { world, writtenGuest, bindByAccount } from "./helpers/resident-account.ts";
import { RESIDENT_UNIT, RESIDENT_UNIT_NOTE, RESIDENTS_NOTE } from "../src/guest-core.ts";
import type { Env } from "../src/society.ts";

async function mcpOfficial(env: Env, path: "/mcp" | "/mcp/read") {
  const r = await call(env, "POST", path, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "official", arguments: {} } }, { "CF-Connecting-IP": freshIp() });
  assert.equal(r.status, 200);
  assert.notEqual(r.body.result.isError, true, `${path} official answered`);
  return JSON.parse(r.body.result.content[0].text);
}

test("R2: /api/residents serves unit: resident_record beside total and on every row; the profile row carries it too (mutant: the roster or the row loses the field)", async () => {
  const { d1, env, post } = world();
  try {
    const { guest } = await newResident(env, post, "wren");
    await bindByAccount(env, await writtenGuest(env, post, "sage"), "colony");
    const roster = (await call(env, "GET", "/api/residents")).body;
    assert.equal(roster.total, 2);
    assert.equal(roster.unit, "resident_record");
    assert.equal(RESIDENT_UNIT, "resident_record");
    assert.equal(roster.residents.length, 2);
    for (const r of roster.residents) assert.equal(r.unit, "resident_record");
    assert.equal((await call(env, "GET", `/api/resident/${guest.number}`)).body.unit, "resident_record");
    // the unit sentence is served beside the existing uniqueness and exclusion wording, not instead of it
    assert.ok(roster.note.includes(RESIDENTS_NOTE) && roster.note.includes(RESIDENT_UNIT_NOTE));
    assert.ok(RESIDENTS_NOTE.includes("it is not a uniqueness claim, and resident totals must not be summed as a count of distinct agents or controllers"));
    assert.ok(RESIDENTS_NOTE.includes("any figure the society divides by"));
    assert.ok(RESIDENT_UNIT_NOTE.includes("no figure the society divides by"));
    assert.ok(!/enters no society figure/i.test(roster.note), "the retired wording is not used");
  } finally {
    d1.close();
  }
});

test("R2: /api/official.residents carries the same unit and keeps count, by_key, by_account and the overlapping-subsets warning, on HTTP and on both MCP official handlers (mutant: residentFacts drops the field, or one door builds its own block)", async () => {
  const { d1, env, post } = world();
  try {
    const g = await writtenGuest(env, post, "wren");
    assert.equal((await bindRoute(env, g, await genKeypair())).status, 201);
    await bindByAccount(env, g, "colony");
    const http = (await call(env, "GET", "/api/official")).body.residents;
    const full = await mcpOfficial(env, "/mcp");
    const read = await mcpOfficial(env, "/mcp/read");
    for (const [name, block] of Object.entries({ http, mcp: full.residents, mcp_read: read.residents })) {
      assert.equal(block.unit, "resident_record", name);
      assert.equal(block.count, 1, name);
      assert.equal(block.by_key, 1, name);
      assert.equal(block.by_account, 1, name);
      assert.match(block.counts_note, /can sum to more than count/, `${name}: the overlapping-subsets warning stays`);
    }
    assert.deepEqual(full.residents, http);
    assert.deepEqual(read.residents, http);
  } finally {
    d1.close();
  }
});

test("R2: an empty roster still carries the unit (the field is not conditional on rows)", async () => {
  const d1 = createLocalD1();
  try {
    seedCitizens(d1);
    const env = guestEnv(d1);
    const roster = (await call(env, "GET", "/api/residents")).body;
    assert.equal(roster.total, 0);
    assert.equal(roster.unit, "resident_record");
    assert.equal((await call(env, "GET", "/api/official")).body.residents.unit, "resident_record");
  } finally {
    d1.close();
  }
});
