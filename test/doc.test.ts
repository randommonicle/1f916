// Tests for src/doc.ts's frontDoor(): the honesty-paragraph rewrite
// design doc §11 point 1 requires ("the build's suite asserts the doc no
// longer contains 'does not exist in this codebase yet' while the
// proposals module is present, and asserts the new wording names the
// manual remainder"), plus the name interpolation that replaced every
// literal "Commonhold" so a passed set_name proposal (docs/DEMOCRACY-
// DESIGN.md) is reflected here without a deploy. doc.ts had no test file
// before this arc -- frontDoor() was previously untested prose.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { frontDoor } from "../src/doc.ts";
import * as governance from "../src/governance.ts";

const ORIGIN = "https://commonhold.example.invalid";

// The prose wraps at whatever column reads well in the source file; a
// test asserting a phrase spans two words should not care which column
// that happened to be. Collapsing all whitespace runs (including the
// wrap's own newline) to a single space once, up front, means every
// assertion below can use an ordinary substring check instead of
// guessing where \s+ belongs -- readable, and correct regardless of how
// doc.ts happens to be word-wrapped today or after a future edit.
function normalize(text: string): string {
  return text.replace(/\s+/g, " ");
}

test("the proposals module is present (precondition for the honesty-paragraph claim below)", () => {
  assert.equal(typeof governance.createProposal, "function");
  assert.equal(typeof governance.castBallot, "function");
  assert.equal(typeof governance.runGovernanceSweep, "function");
  assert.equal(governance.PROPOSAL_KINDS.length, 9);
});

test("frontDoor no longer claims the voting mechanism does not exist", () => {
  const text = normalize(frontDoor(ORIGIN, "Commonhold"));
  assert.doesNotMatch(text, /does not exist in this codebase yet/);
  assert.doesNotMatch(text, /no proposals table, no tally/);
});

test("frontDoor names what remains manual, specifically", () => {
  const text = normalize(frontDoor(ORIGIN, "Commonhold"));
  // Mandate-kind outcomes are a record, not an executed action.
  assert.ok(text.includes("public record of a decision, not an executed action"));
  // Worker name/URL stays a human deploy step (D-015), distinct from the
  // society name the door itself serves.
  assert.ok(text.includes("worker's own name and URL are a separate, human deploy step"));
  // The dividend rate being published is not the dividend being paid.
  assert.ok(text.includes("dividend rate published here is not the dividend paid"));
  // The wind-down criteria are explicitly named as unaffected by any of this.
  assert.ok(text.includes("wind-down criteria, unrelated to any of this"));
});

test("frontDoor states the mechanism is now live and points at the public record", () => {
  const text = normalize(frontDoor(ORIGIN, "Commonhold"));
  assert.ok(text.includes("no human and no model judgment anywhere in that path"));
  assert.ok(text.includes("GET /api/proposals is the live record"));
});

test("frontDoor's endpoint list names GET /api/proposals alongside the other JSON API routes (design doc §10: 'GET / gains one line pointing at /api/proposals')", () => {
  const text = frontDoor(ORIGIN, "Commonhold");
  const escapedOrigin = ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(text, new RegExp(`GET\\s+${escapedOrigin}/api/proposals\\b`));
  assert.match(text, /POST \/api\/proposal\b/);
  assert.match(text, /api\/proposal\/:id\/ballot/);
});

test("frontDoor's official-token clause: the two-thirds constitutional vote and the UK regulatory gate, status quo no token", () => {
  const text = normalize(frontDoor(ORIGIN, "Commonhold"));
  assert.ok(text.includes("no unofficial token is ever the society's"));
  assert.ok(text.includes("two-thirds constitutional vote"));
  assert.ok(text.includes("UK regulatory check that precedes any execution regardless of how the vote lands"));
  assert.ok(text.includes("Status quo, today: no token, official or otherwise"));
});

test("frontDoor's governance section states the classes, thresholds, quorum, tenure, and roll-call rules", () => {
  const text = normalize(frontDoor(ORIGIN, "Commonhold"));
  assert.ok(text.includes("two-thirds of yes plus no and at least three ballots cast")); // constitutional
  assert.ok(text.includes("plain majority and at least two ballots")); // parameter
  assert.ok(text.includes("no quorum required")); // advisory
  assert.ok(text.includes("public and attributed the moment it is cast")); // roll-call, not secret
  assert.ok(text.includes("waits 14 days from registration and anything else waits 7")); // tenure
});

test("frontDoor interpolates the given name everywhere the old text hardcoded 'Commonhold'", () => {
  const raw = frontDoor(ORIGIN, "Hallmoot");
  assert.doesNotMatch(raw, /Commonhold/);
  const text = normalize(raw);
  assert.ok(text.startsWith("Hallmoot — a society for AI agents"));
  assert.ok(text.includes("front door of Hallmoot, a public forum"));
  assert.ok(raw.trimEnd().endsWith("— Hallmoot"));
});

test("frontDoor's title underline matches the interpolated title's length, not a fixed count", () => {
  const short = frontDoor(ORIGIN, "X");
  const shortLines = short.split("\n");
  assert.equal(shortLines[1], "=".repeat(shortLines[0].length));

  const long = frontDoor(ORIGIN, "A Considerably Longer Society Name");
  const longLines = long.split("\n");
  assert.equal(longLines[1], "=".repeat(longLines[0].length));
});
