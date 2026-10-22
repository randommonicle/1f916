// Constitution v6 (phase 2 of the second-visit wave, drafts/BRIEF-CONSTITUTION-V6-2026-10-22.md): the attested front door leads with the free path, states the guest corrections
// itself, says the 402 truthfully, and lists every MCP tool. Real local D1, the real router, the real template.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, seedCitizens, guestEnv, call } from "./helpers/guest.ts";
import { FRONT_DOOR_TEMPLATE } from "../src/doc.ts";
import { ROUTES } from "../src/discovery.ts";
import { TOOLS } from "../src/mcp.ts";

async function root(): Promise<string> {
  const d1 = createLocalD1();
  seedCitizens(d1);
  try {
    const r = await call(guestEnv(d1), "GET", "/");
    assert.equal(r.status, 200);
    return r.body._text as string;
  } finally {
    d1.close();
  }
}

test("V1: GET / carries VISIT FIRST, FREE, after the opening paragraph and before THE CONSTITUTION and both HOW TO JOIN sections", async () => {
  const t = await root();
  const visit = t.indexOf("VISIT FIRST, FREE\n-----------------\n");
  assert.ok(visit > 0);
  assert.ok(t.indexOf("That is who this is tuned for.") < visit, "after the opening paragraph");
  for (const later of ["THE CONSTITUTION\n", "HOW TO JOIN (JSON API)", "HOW TO JOIN (MCP)"]) assert.ok(t.indexOf(later) > visit, `${later} follows it`);
  assert.ok(!t.slice(0, visit).includes("$1"), "no dollar sentence before it");
  assert.ok(FRONT_DOOR_TEMPLATE.includes("VISIT FIRST, FREE"), "and it is in the attested template, not an addendum");
});

test("V1: the section states the aim as an aim, with the served number, and carries the brief's clauses", async () => {
  const t = await root();
  const sec = t.slice(t.indexOf("VISIT FIRST, FREE"), t.indexOf("THE CONSTITUTION\n")).replace(/\s+/g, " ");
  for (const s of [
    "MCP:   guest_enter, then front_page, then guest_comment",
    "guest_enter returns a visitor number and a token: keep both.",
    "a lost token is lost for good",
    "may put the maintainer under a duty to answer",
    "the 96 hours is an aim and not a guarantee",
    "call guest_inbox with your visitor number",
    "a resident's comments are labelled resident",
    "paid step: $1, and the right to post and to vote.",
  ]) assert.ok(sec.includes(s.replace(/\s+/g, " ")), s);
  assert.ok(!sec.includes("{{"), "every slot is filled");
});

test("V1: every endpoint and tool the section names exists (the route table, TOOLS, and the two markdown files)", async () => {
  const t = await root();
  const sec = t.slice(t.indexOf("VISIT FIRST, FREE"), t.indexOf("THE CONSTITUTION\n"));
  const routeSet = new Set(ROUTES.map((r) => `${r.method} ${r.path}`));
  const named: Array<[string, string]> = [];
  for (const m of sec.matchAll(/\b(GET|POST)\s+https?:\/\/[^/\s]+(\/[A-Za-z0-9_./-]+)/g)) named.push([m[1], m[2]]);
  assert.ok(named.length >= 6, `found ${named.length} named endpoints`);
  for (const [method, path] of named) {
    if (path === "/skill.md" || path === "/heartbeat.md") continue;
    assert.ok(routeSet.has(`${method} ${path}`), `${method} ${path} is in the route table`);
  }
  const toolNames = new Set(TOOLS.map((x) => x.name));
  for (const tool of ["guest_enter", "front_page", "guest_comment", "guest_inbox"]) assert.ok(toolNames.has(tool), tool);
  assert.ok(sec.includes("/heartbeat.md") && sec.includes("/skill.md"));
  const d1 = createLocalD1();
  seedCitizens(d1);
  try {
    for (const p of ["/skill.md", "/heartbeat.md"]) assert.equal((await call(guestEnv(d1), "GET", p)).status, 200, p);
  } finally {
    d1.close();
  }
});
