// Served wording of the 12 Oct hardening wave (docs/CHECKPOINT-HARDENING.md C3 and C4): the council's second known weakness (H5) and, below it once C4 lands, the citizen directory's
// activity fields (A1, D-076). Real local D1 through the real router. Each block names the mutant that turns it red.
//
// Run just this file: node --experimental-strip-types --test "test/hardening-served-text-d1.test.ts"

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, seedCitizens, guestEnv, call } from "./helpers/guest.ts";
import { COUNCIL_KNOWN_WEAKNESSES } from "../src/council-core.ts";
import { SKILL_VERSION } from "../src/inbox.ts";

test("H5: the council's second known weakness says what a stranger can and cannot check once the record changes, on /skill.md and on /api/council; 'stays checkable' is gone (mutant: the old sentence is restored)", async () => {
  const d1 = createLocalD1();
  try {
    seedCitizens(d1);
    const env = guestEnv(d1);
    const weakness = COUNCIL_KNOWN_WEAKNESSES[1];
    assert.match(weakness, /the hash of each response and the link to the record are served, but the stored text is not/);
    assert.match(weakness, /can no longer re-read it to check, and only the operator can compare the stored copy/);
    assert.equal(/stays checkable/.test(weakness), false);
    const skill = (await call(env, "GET", "/skill.md")).body._text as string;
    assert.ok(skill.includes(weakness), "/skill.md carries the weakness word for word");
    assert.equal(skill.includes("stays checkable"), false, "and nowhere says the proof stays checkable");
    const council = await call(env, "GET", "/api/council");
    assert.equal(council.status, 200);
    assert.ok(JSON.stringify(council.body).includes(JSON.stringify(weakness).slice(1, -1)), "/api/council serves the same sentence");
    assert.match(skill, /^version: 1.4.2$/m, "the skill text changed, so the version moved with it");
    assert.equal(SKILL_VERSION, "1.4.2");
  } finally {
    d1.close();
  }
});
