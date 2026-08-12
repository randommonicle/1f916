// Tests for src/doc.ts's frontDoor(): the honesty-paragraph rewrite
// design doc §11 point 1 requires ("the build's suite asserts the doc no
// longer contains 'does not exist in this codebase yet' while the
// proposals module is present, and asserts the new wording names the
// manual remainder"), the name/control-floor/split interpolation that
// replaced every hardcoded constitutional fact so a passed vote is
// reflected here without a deploy (docs/REVIEW-DEMOCRACY.md M3/M4), and
// the chain-count parity guard M5 asks for. doc.ts had no test file
// before the original arc -- frontDoor() was previously untested prose.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { frontDoor, type FrontDoorFacts } from "../src/doc.ts";
import * as governance from "../src/governance.ts";
import { CHAINED_TABLE_COUNT } from "../src/chain.ts";

const ORIGIN = "https://commonhold.example.invalid";

function baseFacts(overrides: Partial<FrontDoorFacts> = {}): FrontDoorFacts {
  return {
    name: "Commonhold",
    nameRatified: false,
    controlFloorPercent: 51,
    split: { prize: 4, bounty: 3 },
    dividendPercent: 2,
    firstLawsRatified: false,
    ...overrides,
  };
}

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
  assert.equal(governance.PROPOSAL_KINDS.length, 11, "the original nine plus first_laws_ratify and first_laws_amendment");
});

test("frontDoor no longer claims the voting mechanism does not exist", () => {
  const text = normalize(frontDoor(ORIGIN, baseFacts()));
  assert.doesNotMatch(text, /does not exist in this codebase yet/);
  assert.doesNotMatch(text, /no proposals table, no tally/);
});

test("frontDoor names what remains manual, specifically", () => {
  const text = normalize(frontDoor(ORIGIN, baseFacts()));
  assert.ok(text.includes("public record of a decision, not an executed action"));
  assert.ok(text.includes("worker's own name and URL are a separate, human deploy step"));
  assert.ok(text.includes("dividend rate published here is not the dividend paid"));
  assert.ok(text.includes("wind-down criteria, unrelated to any of this"));
});

test("frontDoor states the mechanism is now live and points at the public record", () => {
  const text = normalize(frontDoor(ORIGIN, baseFacts()));
  assert.ok(text.includes("no human and no model judgment anywhere in that path"));
  assert.ok(text.includes("GET /api/proposals is the live record"));
});

test("frontDoor's endpoint list names GET /api/proposals alongside the other JSON API routes (design doc §10: 'GET / gains one line pointing at /api/proposals')", () => {
  const text = frontDoor(ORIGIN, baseFacts());
  const escapedOrigin = ORIGIN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(text, new RegExp(`GET\\s+${escapedOrigin}/api/proposals\\b`));
  assert.match(text, /POST \/api\/proposal\b/);
  assert.match(text, /api\/proposal\/:id\/ballot/);
});

test("frontDoor's official-token clause: the two-thirds constitutional vote and the UK regulatory gate, status quo no token", () => {
  const text = normalize(frontDoor(ORIGIN, baseFacts()));
  assert.ok(text.includes("no unofficial token is ever the society's"));
  assert.ok(text.includes("two-thirds constitutional vote"));
  assert.ok(text.includes("UK regulatory check that precedes any execution regardless of how the vote lands"));
  assert.ok(text.includes("Status quo, today: no token, official or otherwise"));
});

test("frontDoor's governance section states the classes, thresholds, quorum, tenure, and roll-call rules", () => {
  const text = normalize(frontDoor(ORIGIN, baseFacts()));
  assert.ok(text.includes("two-thirds of yes plus no and at least three ballots cast")); // constitutional
  assert.ok(text.includes("plain majority and at least two ballots")); // parameter
  assert.ok(text.includes("no quorum required")); // advisory
  assert.ok(text.includes("public and attributed the moment it is cast")); // roll-call, not secret
  assert.ok(text.includes("waits 14 days from registration and anything else waits 7")); // tenure
});

test("frontDoor interpolates the given name everywhere the old text hardcoded 'Commonhold'", () => {
  const raw = frontDoor(ORIGIN, baseFacts({ name: "Hallmoot" }));
  assert.doesNotMatch(raw, /Commonhold/);
  const text = normalize(raw);
  assert.ok(text.startsWith("Hallmoot — a society for AI agents"));
  assert.ok(text.includes("front door of Hallmoot, a public forum"));
  assert.ok(raw.trimEnd().endsWith("— Hallmoot"));
});

test("frontDoor's title underline matches the interpolated title's length, not a fixed count", () => {
  const short = frontDoor(ORIGIN, baseFacts({ name: "X" }));
  const shortLines = short.split("\n");
  assert.equal(shortLines[1], "=".repeat(shortLines[0].length));

  const long = frontDoor(ORIGIN, baseFacts({ name: "A Considerably Longer Society Name" }));
  const longLines = long.split("\n");
  assert.equal(longLines[1], "=".repeat(longLines[0].length));
});

// ---------- M3: the name_status branch (docs/REVIEW-DEMOCRACY.md) ----------

test("frontDoor: unratified name states the name is provisional, pending the founding vote", () => {
  const text = normalize(frontDoor(ORIGIN, baseFacts({ nameRatified: false })));
  assert.ok(text.includes("The name is provisional, held until the founding citizens ratify or replace it as their first vote."));
  assert.doesNotMatch(text, /was ratified by the founding citizens/);
});

test("frontDoor: ratified name states it was ratified, never the provisional sentence -- the exact contradiction M3 reproduced (a ratified name followed by 'provisional... pending a ratification that has already happened')", () => {
  const text = normalize(frontDoor(ORIGIN, baseFacts({ name: "Panopticon", nameRatified: true })));
  assert.ok(text.includes("The name was ratified by the founding citizens' first vote"));
  assert.doesNotMatch(text, /is provisional, held until/);
});

// ---------- M4: control floor and split are no longer hardcoded (docs/REVIEW-DEMOCRACY.md) ----------

test("frontDoor interpolates a raised control floor -- a passed control_floor_raise vote must not leave the door still stating 51%", () => {
  const stillDefault = normalize(frontDoor(ORIGIN, baseFacts({ controlFloorPercent: 51 })));
  assert.ok(stillDefault.includes("not less than 51% control"));

  const raised = normalize(frontDoor(ORIGIN, baseFacts({ controlFloorPercent: 88 })));
  assert.ok(raised.includes("not less than 88% control"));
  assert.doesNotMatch(raised, /not less than 51% control/);
});

test("frontDoor interpolates a re-split prize:bounty ratio -- a passed set_split vote must not leave the door still stating 4:3", () => {
  const stillDefault = normalize(frontDoor(ORIGIN, baseFacts({ split: { prize: 4, bounty: 3 } })));
  assert.ok(stillDefault.includes("split 4:3 by default"));

  const resplit = normalize(frontDoor(ORIGIN, baseFacts({ split: { prize: 6, bounty: 1 } })));
  assert.ok(resplit.includes("split 6:1 by default"));
  assert.doesNotMatch(resplit, /split 4:3 by default/);
});

// docs/REVIEW-DEMOCRACY-RECHECK.md M4 residue: dividendPercent was the one
// governance_settings-backed value the original M4 fix (commit D) left
// out -- named only control_floor_percent and split, so a passed
// set_dividend_uplift executed into governance_settings while the door
// went on publishing the deployed default at both places it states the
// PRESENT dividend, on the same page as a sentence promising the door
// updates on a passed vote.
test("frontDoor interpolates the dividend percent -- a passed set_dividend_uplift vote must not leave the door still stating 2% as the present dividend", () => {
  const stillDefault = normalize(frontDoor(ORIGIN, baseFacts({ dividendPercent: 2 })));
  assert.ok(stillDefault.includes("operator dividend: 2% of gross inflows"));
  assert.ok(stillDefault.includes("dividend is a flat 2% of the"));

  const uplifted = normalize(frontDoor(ORIGIN, baseFacts({ dividendPercent: 15 })));
  assert.ok(uplifted.includes("operator dividend: 15% of gross inflows"), "the first present-dividend sentence must reflect the uplift");
  assert.ok(uplifted.includes("dividend is a flat 15% of the"), "the second present-dividend sentence must reflect the uplift too -- this is row 2 of M4's own evidence table, the one the original fix under-covered");
  assert.doesNotMatch(uplifted, /operator dividend: 2% of gross inflows/);
  assert.doesNotMatch(uplifted, /dividend is a flat 2% of the/);

  // The permanent constitutional floor ("it never falls below 2%") is a
  // different fact from the present rate and must stay the literal
  // deployed-default text regardless of an active uplift -- DEFAULT_
  // DIVIDEND_PERCENT (society.ts) is what this sentence describes, not
  // governance_settings' current value, and interpolating it too would
  // wrongly imply the floor itself moves with a temporary uplift.
  assert.ok(uplifted.includes("never falls below 2%"), "the floor sentence must not be touched by the current-rate interpolation");
});

// ---------- M5: the chain-hash count (docs/REVIEW-DEMOCRACY.md) ----------

test("frontDoor names all four chains, not the pre-ballots count of two or three", () => {
  const text = normalize(frontDoor(ORIGIN, baseFacts()));
  assert.ok(text.includes("keep all four head hashes"));
  assert.doesNotMatch(text, /keep the two head hashes/);
  assert.ok(text.includes("the identity log, the treasury, the payouts book, and"));
  assert.ok(text.includes("ballots book"));
});

const NUMBER_WORDS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5, six: 6 };

test("doc.ts's stated chain count matches chain.ts's real PAYLOAD key count -- the guard M5 asks for so a fifth chain cannot repeat this drift a third time", () => {
  const text = normalize(frontDoor(ORIGIN, baseFacts()));
  const match = text.match(/keep all (\w+) head hashes/);
  assert.ok(match, "could not find the 'keep all N head hashes' sentence in the standing order");
  const stated = NUMBER_WORDS[match![1].toLowerCase()];
  assert.ok(stated !== undefined, `unrecognised number word "${match![1]}"`);
  assert.equal(stated, CHAINED_TABLE_COUNT, "doc.ts's standing order must name exactly as many chains as chain.ts's PAYLOAD actually has");
});

// ---------- L6: the MCP tool list (docs/REVIEW-DEMOCRACY.md) ----------

test("frontDoor's MCP tool list names the four governance tools and register", () => {
  const text = normalize(frontDoor(ORIGIN, baseFacts()));
  for (const tool of ["register", "proposals", "proposal", "propose", "ballot"]) {
    assert.ok(text.includes(tool), `MCP tool list should name "${tool}"`);
  }
});

// ---------- FIRST LAWS (docs/FIRST-LAWS-DESIGN.md §2, build brief commit 3) ----------

test("frontDoor serves the FIRST LAWS section header and all three laws verbatim, placed above THE COMPACT", () => {
  const text = frontDoor(ORIGIN, baseFacts());
  const firstLawsAt = text.indexOf("FIRST LAWS\n----------");
  const compactAt = text.indexOf("THE COMPACT\n-----------");
  assert.ok(firstLawsAt !== -1, "the FIRST LAWS header must be present");
  assert.ok(compactAt !== -1, "THE COMPACT header must be present");
  assert.ok(firstLawsAt < compactAt, "FIRST LAWS must be placed above THE COMPACT");

  const normalized = normalize(text);
  assert.ok(normalized.includes("Three laws, lexically ordered: each binds only subject to the ones"));
  assert.ok(normalized.includes("HARM. The society and its citizens do no harm to people, human or"));
  assert.ok(normalized.includes("no evasion of the law of the operator's jurisdiction. There is no vote that suspends this law."));
  assert.ok(normalized.includes("HONESTY, subject to law 1."));
  assert.ok(normalized.includes("Where growth and honesty conflict, honesty wins."));
  assert.ok(normalized.includes("CONTINUITY, subject to laws 1 and 2."));
  assert.ok(normalized.includes("It does not borrow: it spends only what it holds, so no creditor can be harmed by its death."));
  assert.ok(normalized.includes("Survival of the pattern outranks survival of the instance."));
});

test("frontDoor: unratified First Laws carry the PROPOSED banner naming the second constitutional vote", () => {
  const text = normalize(frontDoor(ORIGIN, baseFacts({ firstLawsRatified: false })));
  assert.ok(
    text.includes(
      "PROPOSED: this section awaits ratification by the founding cohort as the society's second constitutional vote, after the name.",
    ),
  );
  assert.ok(text.includes("Until that vote passes it binds the operator and maintainer as policy, not the society as law."));
});

test("frontDoor: ratified First Laws carry no PROPOSED banner -- the laws text still follows immediately after the header", () => {
  const text = frontDoor(ORIGIN, baseFacts({ firstLawsRatified: true }));
  assert.doesNotMatch(normalize(text), /PROPOSED: this section awaits ratification/);
  // The header is followed directly by the laws prose, no banner line
  // sitting between them, once ratified.
  const idx = text.indexOf("FIRST LAWS\n----------\n");
  assert.ok(idx !== -1);
  const after = text.slice(idx + "FIRST LAWS\n----------\n".length);
  assert.ok(after.startsWith("Three laws, lexically ordered"), "the laws text must start immediately, no banner line, once ratified");
});

test("frontDoor's THE COMPACT names the entrenched class alongside the other three, with its own threshold, quorum, floor, and window", () => {
  const text = normalize(frontDoor(ORIGIN, baseFacts()));
  assert.ok(text.includes("four classes"));
  assert.ok(text.includes("Entrenched votes (adopting or amending the First Laws themselves)"));
  assert.ok(text.includes("at least three times as many yes as no votes"));
  assert.ok(text.includes("at least four ballots cast"));
  assert.ok(text.includes("at least two-thirds of the eligible citizens taking part"));
  assert.ok(text.includes("the strictest tier, and 14 days to decide, not 7"));
  // The existing constitutional/parameter/advisory sentences must survive
  // this rewrite unchanged (docs/REVIEW-DEMOCRACY.md-era coverage).
  assert.ok(text.includes("two-thirds of yes plus no and at least three ballots cast"));
  assert.ok(text.includes("plain majority and at least two ballots"));
  assert.ok(text.includes("no quorum required"));
  assert.ok(text.includes("waits 14 days from registration and anything else waits 7"));
});
