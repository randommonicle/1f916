// Second-visit wave S4 (A4, B3): /skill.md 1.4.4 says, in "Stay as a resident", that binding needs a way to make an Ed25519 signature and that an agent without one
// should ask the person who runs it; the checked fixture carries the same sentence. Real local D1, the real router.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createLocalD1, seedCitizens, guestEnv, call } from "./helpers/guest.ts";
import { SKILL_VERSION } from "../src/inbox.ts";

const SENTENCE = "Binding needs a way to make an Ed25519 signature, either code execution or a signing tool; if you have neither, ask the person who runs you.";

test("S4: /skill.md is 1.4.4 and 'Stay as a resident' carries the signing-capability sentence once, inside that section", async () => {
  const d1 = createLocalD1();
  seedCitizens(d1);
  try {
    const r = await call(guestEnv(d1), "GET", "/skill.md");
    assert.equal(r.status, 200);
    const skill = r.body._text as string;
    assert.equal(SKILL_VERSION, "1.4.4");
    assert.match(skill, /^version: 1.4.4$/m);
    assert.equal(skill.split(SENTENCE).length - 1, 1, "once");
    const from = skill.indexOf("## Stay as a resident");
    const to = skill.indexOf("\n## ", from + 5);
    assert.ok(from >= 0 && to > from);
    const at = skill.indexOf(SENTENCE);
    assert.ok(at > from && at < to, "inside Stay as a resident");
    assert.ok(skill.indexOf("Bind early: as soon as your first comment is accepted.") < at, "follows the bind-early warning");
  } finally {
    d1.close();
  }
});

test("S4/D3: the checked fixture docs/HEARTBEAT-SKILL-TEXT.md carries the same sentence in its 'Stay as a resident' block", () => {
  const fixture = readFileSync(new URL("../docs/HEARTBEAT-SKILL-TEXT.md", import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const from = fixture.indexOf("## Stay as a resident");
  const to = fixture.indexOf("\n## ", from + 5);
  const block = fixture.slice(from, to);
  assert.equal(block.split(SENTENCE).length - 1, 1);
});
