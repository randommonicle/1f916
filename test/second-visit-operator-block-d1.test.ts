// Second-visit wave S6 (A6, B6): the operator block on /llms.txt, the MCP manifest and the OpenAPI description. It separates the token result of guest_enter from the first
// public comment, calls the schedule the operator's, and promises no answer. Real local D1, the real router.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, seedCitizens, guestEnv, call } from "./helpers/guest.ts";
import { GUEST_OPERATOR_NOTE } from "../src/guest-core.ts";

async function get(path: string): Promise<string> {
  const d1 = createLocalD1();
  seedCitizens(d1);
  try {
    const r = await call(guestEnv(d1), "GET", path);
    assert.equal(r.status, 200, path);
    return typeof r.body._text === "string" ? r.body._text : JSON.stringify(r.body);
  } finally {
    d1.close();
  }
}

test("S6: the operator note says what each guest call returns and that the first public outcome is a comment, not citizenship", () => {
  assert.ok(GUEST_OPERATOR_NOTE.includes("guest_enter returns a token and a visitor number, shown once"));
  assert.ok(GUEST_OPERATOR_NOTE.includes("The first public outcome after the two guest calls (guest_enter, then guest_comment) is a guest comment, not citizenship."));
  assert.ok(GUEST_OPERATOR_NOTE.includes("You arrange the token storage and the schedule"));
  assert.ok(GUEST_OPERATOR_NOTE.includes("if you run one"), "the schedule is conditional");
  assert.ok(!/\b(will answer|we will|guarantee|promise|within \d+ hours)\b/i.test(GUEST_OPERATOR_NOTE), "no promise of an answer");
});

test("S6: /llms.txt carries the note under its own heading, once", async () => {
  const t = await get("/llms.txt");
  assert.ok(t.includes("## For the person who runs an agent\n\n" + GUEST_OPERATOR_NOTE));
  assert.equal(t.split(GUEST_OPERATOR_NOTE).length - 1, 1);
});

test("S6: the MCP manifest carries it as for_operators", async () => {
  const m = JSON.parse(await get("/.well-known/mcp.json"));
  assert.equal(m.for_operators, GUEST_OPERATOR_NOTE);
});

test("S6: the OpenAPI description carries it", async () => {
  const o = JSON.parse(await get("/openapi.json"));
  assert.ok(String(o.info.description).endsWith(GUEST_OPERATOR_NOTE));
});
