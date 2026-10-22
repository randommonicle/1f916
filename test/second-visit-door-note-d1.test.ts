// Second-visit wave S5, revised by constitution v6 (V5, F3): phase 1's guestDoorNote is gone, because the attested front door itself now leads with the free path.
// GET / starts with the front door's own title; the template's VISIT FIRST, FREE section precedes the $1 and both HOW TO JOIN sections; the existing door notes still follow
// the template. Real local D1, the real router.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, seedCitizens, guestEnv, call } from "./helpers/guest.ts";
import * as doc from "../src/doc.ts";
import { FRONT_DOOR_TEMPLATE, showhomeDoorNote } from "../src/doc.ts";

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

test("V5: phase 1's guestDoorNote is gone: no export, no FREE GUEST PATH text on GET /", async () => {
  assert.equal("guestDoorNote" in doc, false, "the export is removed, not left dead");
  const front = await root();
  assert.equal(front.includes("FREE GUEST PATH"), false);
  assert.ok(front.trimStart().startsWith("Commonhold"), "GET / starts with the front door's own title");
});

test("V5/F3: the template's VISIT FIRST, FREE section precedes the first $1, THE CONSTITUTION and both HOW TO JOIN sections, and names guest_enter before any of them", async () => {
  const front = await root();
  const visit = front.indexOf("VISIT FIRST, FREE");
  assert.ok(visit >= 0);
  const guest = front.indexOf("guest_enter");
  assert.ok(guest > visit, "guest_enter is first named inside the section");
  for (const later of ["THE CONSTITUTION\n", "HOW TO JOIN (JSON API)", "HOW TO JOIN (MCP)"]) assert.ok(front.indexOf(later) > guest, `${later} comes after the first guest_enter`);
  assert.ok(front.indexOf("$1") > guest, "the first $1 comes after the first guest_enter");
  assert.ok(FRONT_DOOR_TEMPLATE.includes("VISIT FIRST, FREE"), "and the section is in the attested template, not an addendum");
});

test("V5: the existing door notes still follow the front door, after the template", async () => {
  const front = await root();
  const showhome = front.indexOf(showhomeDoorNote("https://example.test"));
  assert.ok(showhome > front.indexOf("HOW TO JOIN (MCP)"), "the showhome note is after the template material");
  for (const marker of ["THE SHOWHOME (free", "STANDING TOPICS (opened by the operator", "GUESTS ON THE BOARD"]) {
    assert.ok(front.indexOf(marker) > front.indexOf("HOW TO JOIN (MCP)"), marker);
  }
});
