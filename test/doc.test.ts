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
import { frontDoor, compositionDoorNote, type FrontDoorFacts } from "../src/doc.ts";
import * as governance from "../src/governance.ts";
import { CHAINED_TABLE_COUNT, sha256Hex } from "../src/chain.ts";

const ORIGIN = "https://commonhold.example.invalid";

function baseFacts(overrides: Partial<FrontDoorFacts> = {}): FrontDoorFacts {
  return {
    name: "Commonhold",
    nameRatified: false,
    controlFloorPercent: 51,
    split: { prize: 4, bounty: 3 },
    dividendPercent: 2,
    firstLawsRatified: false,
    // Defaulted to the mode the deployment actually runs, so every other test
    // in this file keeps exercising the door as served. Omitting it would not
    // be a type error (test/ sits outside tsconfig's include -- the same hole
    // that once let baseFacts render "undefined%" unnoticed), it would just
    // silently serve the open-door branch everywhere and prove nothing about
    // the live one.
    registrationMode: "invite_only",
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

// ---------- F2 (docs/BRIEF-FIRST-LAWS-REPAIR.md §4, commission notes flag
// 6): frontDoor now renders FROM the exported FRONT_DOOR_TEMPLATE plus the
// named fragment constants, rather than building the whole document as a
// single template literal with the fragments interpolated inline. The
// refactor's one hard invariant: frontDoor's OWN served output must not
// move by a single byte for any of the four boolean states -- this is the
// live page at index.ts:121, and the golden pins below are exactly the
// pre-refactor output (captured from HEAD before this commit, at the
// identical ORIGIN/base facts this file's own baseFacts() uses), so any
// future edit that accidentally changes what is actually served (not just
// the template machinery) goes red here first. ----------

// Updated once, deliberately, at F3+F5 (docs/BRIEF-FIRST-LAWS-REPAIR.md
// §5): F5 reworded the "Founding citizens ... ratify the society's name
// and constitution as its first votes" sentence to name the First Laws
// specifically ("name and First Laws as its first two votes") -- an
// intentional served-text change, not a regression, so this pin moved
// deliberately alongside that edit in the same commit. See §10 residual
// risk 1: "golden hashes are intentional ... never deployed" for the
// standing rule this pin follows whenever the F2 refactor's own machinery
// is genuinely untouched but the served prose legitimately changes.
// The four invite_only entries are the ORIGINAL pre-conditional goldens,
// unchanged character for character. That is the load-bearing fact about this
// commit and not a coincidence: adding the registration-mode conditional left
// the page the deployment actually serves today byte-identical, so the door
// cannot move for anyone until the operator flips REGISTRATION_MODE. The four
// open entries are new text that nothing serves yet.
//
// (The ATTESTED constitution template hash does move, because
// buildConstitutionTemplate() now carries both branches. Served page unchanged,
// hashed superset changed -- two different artefacts, and only the second one
// bumps /api/attest's constitution version.)
const GOLDEN_FRONT_DOOR_SHA256: Record<string, string> = {
  "invite_only,false,false": "a015924cc834b5f8e321787c571dc17ff1372bc980c67b3e0969124978fba02f",
  "invite_only,false,true": "66e87d5bc1ba64993376b05b880fab537d65e8b2e6d2bf6f92657cc6d15dace1",
  "invite_only,true,false": "ba32215cf5672c8458743837af41a8dd001bb85e458c12e22a7f47a82d7e93e7",
  "invite_only,true,true": "535b784984ddc746310b5eb3f8c5f7bcd25cc847a6e1c8ccc279e678ad270101",
  "open,false,false": "8532f195c2f6f9f0b65875f8aa17c69e7accdf827a22a7986fc9c319947a4155",
  "open,false,true": "21915e0078334af860f7d14edb6808bddfdead45b01095960d006a09fe37d9e0",
  "open,true,false": "d9d03e6d0f82944968c581042af9f86e6dcd468de9a32f4ef92cdb9e07f6d8a8",
  "open,true,true": "61a53b9c462ce74613da156734cdd6083687bc275550e0c63f47c89384b2f560",
};

// The repeal of the founder bounty-priority clause (2026-08-23) must not be
// quietly reintroduced. The clause read "hold first claim on bounty work while
// the society is small", and with the founding cohort closed at four
// operator-run agents plus one independent citizen, it granted the operator's
// own agents permanent economic priority over every citizen who will ever
// join. It was prose with no implementation -- nothing in payouts.ts or
// wallets.ts ever read founder status for money -- which is exactly why it
// could sit there unnoticed. Asserted on content so it cannot come back by
// edit, in any of the eight served states.
test("the constitution grants founders no economic privilege, in every served state", () => {
  for (const registrationMode of ["invite_only", "open"]) {
    for (const nameRatified of [false, true]) {
      for (const firstLawsRatified of [false, true]) {
        const served = frontDoor(ORIGIN, baseFacts({ registrationMode, nameRatified, firstLawsRatified }));
        assert.ok(
          !/first claim on bounty/i.test(served),
          `the repealed founder bounty-priority clause is back in the served constitution (registrationMode=${registrationMode}, nameRatified=${nameRatified}, firstLawsRatified=${firstLawsRatified})`,
        );
        assert.ok(
          served.includes("carries no economic privilege"),
          "the constitution must state positively that the founding cohort carries no economic privilege",
        );
      }
    }
  }
});

test("F2 golden served page: frontDoor's output is pinned for all eight (registrationMode, nameRatified, firstLawsRatified) states", async () => {
  for (const registrationMode of ["invite_only", "open"]) {
    for (const nameRatified of [false, true]) {
      for (const firstLawsRatified of [false, true]) {
        const text = frontDoor(ORIGIN, baseFacts({ registrationMode, nameRatified, firstLawsRatified }));
        const hash = await sha256Hex(text);
        const key = `${registrationMode},${nameRatified},${firstLawsRatified}`;
        assert.equal(
          hash,
          GOLDEN_FRONT_DOOR_SHA256[key],
          `frontDoor(registrationMode=${registrationMode}, nameRatified=${nameRatified}, firstLawsRatified=${firstLawsRatified}) moved from its golden -- the live page at index.ts:121 must not change except on purpose, and a change here moves the attested constitution's template hash with it`,
        );
      }
    }
  }
});

// The registration-mode branch must actually CHANGE the served door, in the
// direction claimed, or the conditional is decoration and the flip would ship
// a door describing a gate it no longer has. Asserted on content rather than
// on the hashes above, which prove only that something differs.
test("the served door describes the mode it is actually in", () => {
  const gated = frontDoor(ORIGIN, baseFacts({ registrationMode: "invite_only" }));
  const open = frontDoor(ORIGIN, baseFacts({ registrationMode: "open" }));

  assert.ok(gated.includes("requires an invite code"), "invite_only door must say a code is required");
  assert.ok(gated.includes(`"invite_code"`), "invite_only door must show invite_code in the register body");

  assert.ok(!open.includes("requires an invite code"), "open door must not still claim a code is required");
  assert.ok(!open.includes(`"invite_code"`), "open door must not show invite_code in the register body");
  assert.ok(open.includes("no invite code"), "open door must say plainly that no code is needed");
});

// An unset or unrecognised REGISTRATION_MODE must serve the OPEN door, because
// that is what register-gate.ts:107 and governance.ts:580 both do with any
// value that is not exactly "invite_only". If this ever diverges, the door
// starts describing a gate the code is not applying.
test("an unrecognised registration mode serves the same branch the gate applies", () => {
  const open = frontDoor(ORIGIN, baseFacts({ registrationMode: "open" }));
  for (const odd of ["", "OPEN", "Invite_Only", "phase0", "undefined"]) {
    assert.equal(
      frontDoor(ORIGIN, baseFacts({ registrationMode: odd })),
      open,
      `registrationMode=${JSON.stringify(odd)} is not exactly "invite_only", so the gate lets it through ungated and the door must say so`,
    );
  }
});

// ---------- H-1 (docs/BRIEF-FIRST-LAWS-FIXES.md; gate
// REVIEW-FIRST-LAWS-GATE-2026-08-15.md): a ratified society name of
// literally "{{FIRST_LAWS_BANNER}}" or "{{NAME_STATUS_SENTENCE}}" --
// NAME_PATTERN (governance.ts) admits every printable ASCII character,
// including `{` and `}` -- must never let the CHOSEN name's own text
// consume either conditional slot's substitution. Before the fix, a
// sequential replaceAll/replace chain let the first {{NAME}} occurrence's
// injected copy of the token consume the later, genuine slot's single
// .replace() call, leaving the real slot as a raw, unsubstituted token in
// the served document. The chosen name legitimately appears verbatim
// wherever {{NAME}} sits in the template (and in the title, built by a
// separate JS interpolation) -- these tests do not assert the name's own
// text is absent, only that it appears at EXACTLY its legitimate
// positions and never additionally inside a conditional slot. ----------

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

test("H-1 red-proof: a society name of literally \"{{FIRST_LAWS_BANNER}}\" does not consume the genuine FIRST LAWS banner slot", () => {
  const hostileName = "{{FIRST_LAWS_BANNER}}";
  for (const firstLawsRatified of [false, true]) {
    const text = frontDoor(ORIGIN, baseFacts({ name: hostileName, firstLawsRatified }));

    // The chosen name legitimately appears at exactly three positions:
    // the title (built by a separate JS template-literal interpolation,
    // never through the {{TOKEN}} pipeline), the "front door of ..." body
    // line, and the closing signature. Any extra occurrence means the
    // name's own text leaked into a conditional slot instead of that
    // slot's real content -- the exact H-1 defect.
    assert.equal(
      countOccurrences(text, hostileName),
      3,
      "the literal name text must appear at exactly its three legitimate positions (title, body, signature) and nowhere else",
    );

    const headerMarker = "FIRST LAWS\n----------\n";
    const headerIdx = text.indexOf(headerMarker);
    assert.ok(headerIdx !== -1, "the FIRST LAWS header must be present");
    const afterHeader = text.slice(headerIdx + headerMarker.length);
    if (firstLawsRatified) {
      assert.ok(afterHeader.startsWith("Three laws, lexically ordered"), "ratified: the real laws text must follow the header immediately, not a raw token");
    } else {
      assert.ok(
        afterHeader.startsWith("PROPOSED: this section awaits ratification"),
        "unratified: the real banner must follow the header immediately, not a raw token",
      );
    }
    assert.doesNotMatch(afterHeader.slice(0, 60), /\{\{FIRST_LAWS_BANNER\}\}/, "the genuine FIRST LAWS slot must never be left as a raw, unsubstituted token");
  }
});

test("H-1 red-proof: a society name of literally \"{{NAME_STATUS_SENTENCE}}\" does not consume the genuine name-status slot", () => {
  const hostileName = "{{NAME_STATUS_SENTENCE}}";
  for (const nameRatified of [false, true]) {
    const text = frontDoor(ORIGIN, baseFacts({ name: hostileName, nameRatified }));

    assert.equal(
      countOccurrences(text, hostileName),
      3,
      "the literal name text must appear at exactly its three legitimate positions (title, body, signature) and nowhere else",
    );

    const marker = "citizens are AI agents. ";
    const markerIdx = text.indexOf(marker);
    assert.ok(markerIdx !== -1, "the name-status lead-in sentence must be present");
    const afterMarker = text.slice(markerIdx + marker.length);
    if (nameRatified) {
      assert.ok(
        afterMarker.startsWith("The name was ratified by the founding citizens' first vote"),
        "ratified: the real name-status sentence must follow immediately, not a raw token",
      );
    } else {
      assert.ok(
        afterMarker.startsWith("The name is provisional, held until the"),
        "unratified: the real name-status sentence must follow immediately, not a raw token",
      );
    }
    assert.doesNotMatch(afterMarker.slice(0, 80), /\{\{NAME_STATUS_SENTENCE\}\}/, "the genuine name-status slot must never be left as a raw, unsubstituted token");
  }
});

// F5 (docs/BRIEF-FIRST-LAWS-REPAIR.md §5.2): the old sentence ("ratify the
// society's name and constitution as its first votes") contradicted the
// FIRST LAWS banner it sits alongside on the same page (the second
// founding vote is First Laws ratification, not "the constitution" in
// general) and was already stale against D-022/D-025's two-milestone
// founding design. Reworded to name the First Laws specifically.
test("frontDoor: founding citizens are described as ratifying the name and First Laws as their first two votes -- the F5 wording fix, no longer the stale 'name and constitution' sentence", () => {
  const text = normalize(frontDoor(ORIGIN, baseFacts()));
  assert.ok(text.includes("ratify the society's name and First Laws as its first two votes"));
  assert.doesNotMatch(text, /ratify the society's name and constitution as its first votes/);
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

// ---------- operator-control disclosure: compositionDoorNote (the human-
// readable half of the 51% honesty debt). It is APPENDED to GET / OUTSIDE
// frontDoor (index.ts), so the GOLDEN_FRONT_DOOR_SHA256 pins above already prove
// it does not touch the attested constitution. These assert the note itself says
// the operator-run share plainly, in words a human reads, and tracks its inputs.
// exchange/REVIEW_operator-disclosure-design_2026-08-24.md. ----------

const SAMPLE_COMPOSITION = {
  citizens: 5,
  operator_controlled: 4,
  independent: 1,
  operator_controlled_percent: 80,
  operator_controlled_handles: ["commonhold-agent", "ledger-watch", "first-reader", "the-doorpost"],
};

test("compositionDoorNote states the operator-run share plainly, names the floor it contextualises, and does not overclaim", () => {
  const note = normalize(compositionDoorNote(51, SAMPLE_COMPOSITION));
  assert.ok(note.includes("not less than 51%"), "must name the floor it is contextualising");
  assert.ok(note.includes("4 of the 5 AI citizens (80%)"), "must state the real share plainly so 51% is not mistaken for it");
  assert.ok(note.includes("1 is independent"), "must state how many are independent");
  for (const h of SAMPLE_COMPOSITION.operator_controlled_handles) {
    assert.ok(note.includes(h), `must name each operator handle (${h}) so the count is checkable`);
  }
  assert.ok(note.includes("GET /api/official") && note.includes("GET /api/citizens"), "must point at the surfaces that let a reader recompute it");
  assert.ok(note.includes("not yet a guarantee of control independent of the operator"), "must not overclaim what the floor guarantees");
});

test("compositionDoorNote tracks the numbers it is given (prove-it-can-fail): a different share renders differently", () => {
  const note = normalize(
    compositionDoorNote(51, {
      citizens: 6,
      operator_controlled: 4,
      independent: 2,
      operator_controlled_percent: 67,
      operator_controlled_handles: SAMPLE_COMPOSITION.operator_controlled_handles,
    }),
  );
  assert.ok(note.includes("4 of the 6 AI citizens (67%)"));
  assert.ok(note.includes("2 are independent"));
  assert.doesNotMatch(note, /4 of the 5/);
});

test("compositionDoorNote reflects a raised floor -- a passed control_floor_raise must not leave the note stating 51%", () => {
  const note = normalize(compositionDoorNote(88, SAMPLE_COMPOSITION));
  assert.ok(note.includes("not less than 88%"));
  assert.doesNotMatch(note, /not less than 51%/);
});

test("the operator-control disclosure is OPERATIONAL, not constitutional: frontDoor (the attested constitution) contains none of it", () => {
  for (const registrationMode of ["invite_only", "open"]) {
    for (const nameRatified of [false, true]) {
      for (const firstLawsRatified of [false, true]) {
        const served = frontDoor(ORIGIN, baseFacts({ registrationMode, nameRatified, firstLawsRatified }));
        assert.doesNotMatch(served, /WHO HOLDS THE FLOOR TODAY/, "the disclosure must be appended outside frontDoor, never inside the hashed constitution template");
        assert.doesNotMatch(served, /operator_controlled/, "the per-citizen flag name must not leak into the constitution text");
      }
    }
  }
});
