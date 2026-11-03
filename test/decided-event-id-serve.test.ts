// decided_event_id is served (migrations/0023, D-078 item 3; drafts/BRIEF-DECIDED-EVENT-ID-2026-11-03.md B4, A3, A6; T4, T6, T7). Real local D1, the real router,
// nothing mocked. The six surfaces in scope: GET /api/proposals, GET /api/proposal/:id, the `proposals` and `proposal` tools on /mcp and on /mcp/read.
// Out of scope by A6 and asserted not to gain the field: the inbox's ballot-action summaries.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { call, createLocalD1, seedCitizens, guestEnv } from "./helpers/guest.ts";
import type { Env } from "../src/society.ts";

// A3, exact, pinned here as the brief's wording (not read back from the source).
const NOTE =
  "decided_event_id identifies the proposal_decided event recording this proposal's tally outcome (GET /api/events?kind=proposal_decided). The tally writes that event, the stored counts, the tally status and this pointer in one database transaction; pointers for proposals decided before this field existed were filled later by matching the existing records. The counts and the outcome in the event come from the same computation as the row's, so their agreement is a consistency check, not independent confirmation that the count was right, and not proof of when the records were written. An amendment proposal can later move from passed to executed and keeps its original tally event. To check the votes themselves, read the ballots on GET /api/proposal/:id and their chain on GET /api/attest. Null while open or tallying.";

function setup() {
  const d1 = createLocalD1();
  const { maintainer } = seedCitizens(d1);
  const mk = (status: string, pointer: number | null, at: number) =>
    Number(
      d1.raw
        .prepare(
          "INSERT INTO proposals (kind, title, body, proposer_id, opened_at, closes_at, created_at, status, decided_event_id) VALUES ('resolution', 't', 'b', ?, ?, ?, ?, ?, ?)",
        )
        .run(maintainer, at, at + 1, at, status, pointer).lastInsertRowid,
    );
  const open = mk("open", null, 1000);
  const tallying = mk("tallying", null, 1001);
  const passed = mk("passed", 4242, 1002);
  return { d1, env: guestEnv(d1), open, tallying, passed };
}

async function rpc(env: Env, door: "/mcp" | "/mcp/read", name: string, args: unknown) {
  const r = await call(env, "POST", door, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, { "CF-Connecting-IP": "203.0.113.9" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return JSON.parse(r.body.result.content[0].text);
}

type Row = { id: number; decided_event_id?: number | null };
const DOORS = ["/mcp", "/mcp/read"] as const;

test("T7: all six surfaces serve decided_event_id on the row (mutant: drop it from either SELECT in governance.ts)", async () => {
  const { d1, env, passed } = setup();
  try {
    const list = (await call(env, "GET", "/api/proposals")).body.proposals as Row[];
    const detail = (await call(env, "GET", `/api/proposal/${passed}`)).body.proposal as Row;
    const surfaces: Record<string, Row> = { "GET /api/proposals": list.find((p) => p.id === passed)!, "GET /api/proposal/:id": detail };
    for (const door of DOORS) {
      surfaces[`${door} proposals`] = ((await rpc(env, door, "proposals", {})).proposals as Row[]).find((p) => p.id === passed)!;
      surfaces[`${door} proposal`] = (await rpc(env, door, "proposal", { proposal_id: passed })).proposal as Row;
    }
    assert.equal(Object.keys(surfaces).length, 6);
    for (const [name, row] of Object.entries(surfaces)) {
      assert.ok(row && "decided_event_id" in row, `${name} carries the field`);
      assert.equal(row.decided_event_id, 4242, `${name} serves the stored pointer`);
    }
  } finally {
    d1.close();
  }
});

test("T4: open and tallying rows serve decided_event_id: null on HTTP and both MCP doors (present, not absent)", async () => {
  const { d1, env, open, tallying } = setup();
  try {
    for (const id of [open, tallying]) {
      const list = (await call(env, "GET", "/api/proposals")).body.proposals as Row[];
      assert.equal(list.find((p) => p.id === id)!.decided_event_id, null);
      assert.equal((await call(env, "GET", `/api/proposal/${id}`)).body.proposal.decided_event_id, null);
      for (const door of DOORS) {
        assert.equal(((await rpc(env, door, "proposals", {})).proposals as Row[]).find((p) => p.id === id)!.decided_event_id, null, door);
        assert.equal((await rpc(env, door, "proposal", { proposal_id: id })).proposal.decided_event_id, null, door);
      }
    }
  } finally {
    d1.close();
  }
});

test("T6: the served note is the A3 text exactly, on HTTP and both MCP doors, and claims nothing the join does not prove (mutant: change one word of DECIDED_EVENT_ID_NOTE)", async () => {
  const { d1, env } = setup();
  try {
    const bodies = [(await call(env, "GET", "/api/proposals")).body, ...(await Promise.all(DOORS.map((d) => rpc(env, d, "proposals", {}))))];
    for (const b of bodies) assert.equal(b.decided_event_id_note, NOTE);
    assert.match(NOTE, /a consistency check, not independent confirmation that the count was right, and not proof of when the records were written/);
    assert.doesNotMatch(NOTE, /\bproves?\b|\bguarantee/i, "no sentence says the agreement proves or guarantees anything");
    assert.doesNotMatch(NOTE, /same transaction as|written together|atomic/i, "no claim about transaction history beyond the writer's own statement");
  } finally {
    d1.close();
  }
});

test("T7 scope (A6): the inbox's ballot-action summaries do not gain the field", async () => {
  const { d1, env } = setup();
  try {
    const handle = (d1.raw.prepare("SELECT handle FROM citizens ORDER BY id LIMIT 1").get() as { handle: string }).handle;
    const r = await call(env, "GET", `/api/inbox?handle=${handle}&since=0`);
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
    assert.ok(!JSON.stringify(r.body).includes("decided_event_id"));
  } finally {
    d1.close();
  }
});
