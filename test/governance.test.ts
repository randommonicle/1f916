// Tests for the pure governance core (docs/DEMOCRACY-DESIGN.md): vote
// classes, payload validation, eligibility, and tally arithmetic. No D1
// here, matching governance.ts itself -- every case below is inputs in, a
// verdict or a thrown SocietyError out.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PROPOSAL_KINDS,
  isProposalKind,
  isChoice,
  KIND_CLASS,
  classOf,
  VOTE_WINDOW_MS,
  ENTRENCHED_VOTE_WINDOW_MS,
  voteWindowMs,
  CLASS_MIN_BALLOTS,
  DEFAULT_NAME,
  DEFAULT_CONTROL_FLOOR_PERCENT,
  quorumThreshold,
  entrenchedQuorumThreshold,
  tally,
  validatePayload,
  refusesDisguisedFirstLawsAmendment,
  assertEligible,
  countEligible,
  monthsFromNow,
  DB_QUEUE_KINDS,
  canonicalizeTemplate,
  buildConstitutionTemplate,
  serializeConstitutionParameters,
  computeLiveConstitutionPair,
  CLASS_QUORUM_RULE,
  CLASS_PASSAGE_RULE,
  FIRST_LAWS_POLICY,
  FOUNDING_GATED_KINDS,
  MACHINE_EXECUTABLE_KINDS,
  type ProposalKind,
  type EligibilityInput,
} from "../src/governance.ts";
import { ALLOWED_QUEUE_KINDS } from "../src/maintainer/clerk.ts";
import { SocietyError } from "../src/society.ts";
import { frontDoor, NAME_STATUS_RATIFIED, NAME_STATUS_PROVISIONAL, FIRST_LAWS_BANNER } from "../src/doc.ts";

const isBadRequest = (e: unknown) => e instanceof SocietyError && e.status === 400;
const isForbidden = (e: unknown) => e instanceof SocietyError && e.status === 403;

// F1 golden pin (docs/BRIEF-FIRST-LAWS-REPAIR.md §3.3 item 2): computed
// once, after the F1 fix landed, from sha256Hex(serializeConstitutionParameters())
// at rest -- see the dedicated test below. A hostile deploy that edits an
// entrenched threshold now moves this pin (and the live parameters_hash a
// citizen can independently recompute) just as loudly as it moves the
// executed tally() comparison, because both now read the identical
// CLASS_QUORUM_RULE/CLASS_PASSAGE_RULE tables.
// Updated once, deliberately, at F6 (docs/BRIEF-FIRST-LAWS-REPAIR.md §6):
// serializeConstitutionParameters gained a first_laws_policy field
// carrying FIRST_LAWS_POLICY verbatim, an intentional content change
// (F6's whole point -- the state machine's declared shape is now part of
// what this hash covers), not a regression. See §10 residual risk 1.
// Updated again, deliberately, at H-2 (docs/BRIEF-FIRST-LAWS-FIXES.md):
// ratificationEffects.first_laws_ratify gained a valueSource discriminator
// -- H-2's whole point, the value a ratification effect writes is now
// attested policy data too, not a hardcoded expression -- another
// intentional content change, not a regression.
const GOLDEN_PARAMETERS_HASH = "83c76b5abfe8af794f198e0d656c8f0efda7f99340ed1adae5ff2fddeef6f6b6";

// ---------- vote classes ----------

test("every one of the 11 proposal kinds has exactly the class design doc §3 / First Laws §3 names", () => {
  const expected: Record<ProposalKind, string> = {
    set_name: "constitutional",
    text_amendment: "constitutional",
    official_token: "constitutional",
    handler_arrangement: "constitutional",
    buyout_terms: "constitutional",
    control_floor_raise: "constitutional",
    set_dividend_uplift: "parameter",
    set_split: "parameter",
    resolution: "advisory",
    first_laws_ratify: "entrenched",
    first_laws_amendment: "entrenched",
  };
  for (const kind of PROPOSAL_KINDS) {
    assert.equal(classOf(kind), expected[kind], `${kind} should be ${expected[kind]}`);
  }
  assert.equal(PROPOSAL_KINDS.length, 11, "the original nine plus first_laws_ratify and first_laws_amendment");
  assert.equal(Object.keys(KIND_CLASS).length, 11);
});

test("isProposalKind accepts every closed-list kind and rejects anything else", () => {
  for (const kind of PROPOSAL_KINDS) assert.equal(isProposalKind(kind), true);
  assert.equal(isProposalKind("set_nam"), false);
  assert.equal(isProposalKind(""), false);
  assert.equal(isProposalKind(null), false);
  assert.equal(isProposalKind(42), false);
});

test("isChoice accepts yes/no/abstain and rejects everything else", () => {
  assert.equal(isChoice("yes"), true);
  assert.equal(isChoice("no"), true);
  assert.equal(isChoice("abstain"), true);
  assert.equal(isChoice("maybe"), false);
  assert.equal(isChoice(""), false);
  assert.equal(isChoice(undefined), false);
});

test("VOTE_WINDOW_MS is exactly 7 days (168 hours)", () => {
  assert.equal(VOTE_WINDOW_MS, 168 * 60 * 60 * 1000);
  assert.equal(VOTE_WINDOW_MS, 604_800_000);
});

test("ENTRENCHED_VOTE_WINDOW_MS is exactly 14 days (double the standard window, D-025 q4), and voteWindowMs branches by class", () => {
  assert.equal(ENTRENCHED_VOTE_WINDOW_MS, 14 * 24 * 60 * 60 * 1000);
  assert.equal(ENTRENCHED_VOTE_WINDOW_MS, 1_209_600_000);
  assert.equal(voteWindowMs("entrenched"), ENTRENCHED_VOTE_WINDOW_MS);
  for (const voteClass of ["constitutional", "parameter", "advisory"] as const) {
    assert.equal(voteWindowMs(voteClass), VOTE_WINDOW_MS, `${voteClass} should use the standard 7-day window, unchanged`);
  }
});

test("CLASS_MIN_BALLOTS matches design doc §3's table (3/2/1) plus D-025's entrenched floor of 4", () => {
  assert.deepEqual(CLASS_MIN_BALLOTS, { constitutional: 3, parameter: 2, advisory: 1, entrenched: 4 });
});

test("defaults match doc.ts's published starting values", () => {
  assert.equal(DEFAULT_NAME, "Commonhold");
  assert.equal(DEFAULT_CONTROL_FLOOR_PERCENT, 51);
});

// ---------- First Laws: the DB-side/app-side parity trio ----------
//
// migrations/0007_first_laws.sql widens proposals.kind to eleven values
// and maintainer_queue.kind to five, and schema.sql's own rollup carries
// both widened CHECKs too. Commission notes flag 3's own sequencing: the
// full three-way (PROPOSAL_KINDS == 0007 == schema.sql) could not be green
// at commit 1, since PROPOSAL_KINDS itself did not grow until commit 2 --
// this supersedes the commit-1-only DB-side pair (the migration and the
// rollup agreeing with each other, with no app-side leg) and the old test
// pinned against migrations/0005_governance.sql, both now folded into the
// one complete assertion below. Growing PROPOSAL_KINDS in commit 2 without
// yet updating this test is the recorded red (commission flag 3): the old
// migrations/0005-scoped comparison still only knew nine kinds, so
// PROPOSAL_KINDS's own eleven immediately failed it.

function extractKindCheck(sql: string, createTableAnchor: string): string[] {
  const re = new RegExp(`CREATE TABLE ${createTableAnchor}[\\s\\S]*?kind\\s+TEXT NOT NULL CHECK \\(kind IN \\(([^)]+)\\)\\)`);
  const match = sql.match(re);
  assert.ok(match, `could not find a kind CHECK constraint anchored at "CREATE TABLE ${createTableAnchor}"`);
  return match![1]
    .split(",")
    .map((s) => s.trim().replace(/^'|'$/g, ""))
    .sort();
}

// Drift guard: the application's closed kind list, migration 0007's
// rebuilt CHECK, and schema.sql's own rollup CHECK must all name exactly
// the same eleven kinds, or the DB backstop and the app allowlist silently
// diverge -- the exact failure mode DEMOCRACY-SURFACE.md §8 gotcha 10
// already found once in this codebase (GET /api/events's stale kinds
// list).
test("PROPOSAL_KINDS matches 0007's rebuilt proposals CHECK and schema.sql's rollup CHECK, all three exactly", () => {
  const migration = readFileSync(join(import.meta.dirname, "..", "migrations", "0007_first_laws.sql"), "utf8");
  const schema = readFileSync(join(import.meta.dirname, "..", "schema.sql"), "utf8");
  const inMigration = extractKindCheck(migration, "proposals_new \\(");
  const inSchema = extractKindCheck(schema, "IF NOT EXISTS proposals \\(");
  const inCode = [...PROPOSAL_KINDS].sort();
  assert.deepEqual(inMigration, inSchema);
  assert.deepEqual(inMigration, inCode);
  assert.equal(inCode.length, 11, "the nine original kinds plus first_laws_ratify and first_laws_amendment");
});

test("First Laws commit 1: 0007's rebuilt maintainer_queue CHECK, schema.sql's maintainer_queue CHECK, and the new DB_QUEUE_KINDS superset all agree exactly", () => {
  const migration = readFileSync(join(import.meta.dirname, "..", "migrations", "0007_first_laws.sql"), "utf8");
  const schema = readFileSync(join(import.meta.dirname, "..", "schema.sql"), "utf8");
  const inMigration = extractKindCheck(migration, "maintainer_queue_new \\(");
  const inSchema = extractKindCheck(schema, "IF NOT EXISTS maintainer_queue \\(");
  const inCode = [...DB_QUEUE_KINDS].sort();
  assert.deepEqual(inMigration, inSchema);
  assert.deepEqual(inMigration, inCode);
  assert.equal(inMigration.length, 5, "the four existing queue kinds plus constitution_fidelity");
});

test("First Laws commit 1: clerk.ts's ALLOWED_QUEUE_KINDS (the drafting cage) is a STRICT subset of DB_QUEUE_KINDS (the DB's closed list) -- the clerk may never draft a kind the DB itself would refuse, and the DB holds one kind (constitution_fidelity) the clerk may never draft", () => {
  const allowed = new Set<string>(ALLOWED_QUEUE_KINDS);
  const dbKinds = new Set<string>(DB_QUEUE_KINDS);
  for (const k of allowed) {
    assert.ok(dbKinds.has(k), `${k} is clerk-allowed but missing from DB_QUEUE_KINDS`);
  }
  assert.ok(dbKinds.size > allowed.size, "DB_QUEUE_KINDS must be a STRICT superset, not merely equal to ALLOWED_QUEUE_KINDS");
  assert.deepEqual([...dbKinds].filter((k) => !allowed.has(k)), ["constitution_fidelity"], "constitution_fidelity must be the exact, sole, extra kind");
});

// ---------- policing: the maintainer is not special-cased ----------

// I-007's detection machinery is a narrow, reviewed exception to the
// blanket ban below: `constitution_changed` is a SYSTEM-authored
// identity_events row (design doc §5), and every row in that table needs
// a real citizen_id FK -- MAINTAINER_ID (citizen #1) is the natural
// author of an automated system action, exactly matching how
// judgment.ts already stamps every moderation/bulletin action it
// executes. This is authorship of a chained EVENT, not a vote, and has
// nothing to do with tallying, eligibility, or quorum. Two lines only
// (the import, and its one call site inside detectConstitutionChange),
// content-matched rather than excluded by line number or file region --
// the same discipline test/l002-residue.test.ts's own ALLOWLIST uses, so
// a NEW reference anywhere else in the file (including a future addition
// to this same I-007 section) is still caught.
const MAINTAINER_ID_ALLOWED_LINES = ["MAINTAINER_ID,", "citizen_id: MAINTAINER_ID"];

test("governance.ts never references MAINTAINER_ID outside the two reviewed I-007 lines -- the maintainer's ballot holds no tie-break or veto (design doc §4)", () => {
  const text = readFileSync(join(import.meta.dirname, "..", "src", "governance.ts"), "utf8");
  const offenders = text.split("\n").filter((line) => line.includes("MAINTAINER_ID") && !MAINTAINER_ID_ALLOWED_LINES.some((allowed) => line.includes(allowed)));
  assert.deepEqual(
    offenders,
    [],
    "MAINTAINER_ID appeared somewhere other than the two reviewed I-007 lines -- if this is a genuine new need, review and add it to the allowlist explicitly; if it is a vote-counting special-case, remove it",
  );
});

// Positive control for the scan above: proves the allowlist is doing
// real work (both reviewed lines genuinely exist), not vacuously passing
// because the whole file happens to be clean regardless of the allowlist.
test("governance.ts does carry both reviewed MAINTAINER_ID lines (the positive control for the scan above)", () => {
  const text = readFileSync(join(import.meta.dirname, "..", "src", "governance.ts"), "utf8");
  for (const allowed of MAINTAINER_ID_ALLOWED_LINES) {
    assert.ok(text.includes(allowed), `expected to find a line containing "${allowed}"`);
  }
});

// ---------- quorumThreshold ----------

test("quorumThreshold is ceil(eligible/2)", () => {
  const cases: [number, number][] = [
    [0, 0],
    [1, 1],
    [2, 1],
    [3, 2],
    [4, 2],
    [5, 3],
    [10, 5],
    [11, 6],
  ];
  for (const [eligible, expected] of cases) {
    assert.equal(quorumThreshold(eligible), expected, `eligible=${eligible}`);
  }
});

// ---------- tally ----------

test("tally: quorum boundary for constitutional class", () => {
  // eligible=10 -> quorum threshold 5.
  assert.equal(tally("constitutional", 5, 0, 0, 10).status, "passed"); // cast=5 clears quorum(5) and floor(3); 5>=0 && 5>0
  const short = tally("constitutional", 2, 2, 0, 10); // cast=4, below quorum(5)
  assert.equal(short.status, "failed");
  assert.equal(short.reason, "quorum");
});

test("tally: floor boundary for constitutional class, independent of quorum", () => {
  // eligible=2 -> quorum threshold 1, so quorum clears at cast=1, but the
  // class floor of 3 does not -- proves floor is a real, separate check,
  // not vacuously implied by a small eligible count.
  const oneVote = tally("constitutional", 1, 0, 0, 2); // cast=1: quorum(1) clears, floor(3) does not
  assert.equal(oneVote.status, "failed");
  assert.equal(oneVote.reason, "floor");
  const threeVotes = tally("constitutional", 3, 0, 0, 2); // cast=3: both clear, and 3>=0 && 3>0
  assert.equal(threeVotes.status, "passed");
});

test("tally: quorum at an odd eligible count exercises ceiling, not floor, rounding", () => {
  // eligible=5 -> ceil(5/2)=3 (floor(5/2) would wrongly give 2 and let a
  // 2-ballot cast clear quorum). All the other tally quorum tests use even
  // eligible counts, where ceil and floor coincide and so cannot catch a
  // ceil->floor regression in quorumThreshold's own rounding -- this one
  // specifically can, at the tally() call site, not just in isolation.
  const short = tally("constitutional", 2, 0, 0, 5); // cast=2 < ceil(5/2)=3
  assert.equal(short.status, "failed");
  assert.equal(short.reason, "quorum");
  const exact = tally("constitutional", 3, 0, 0, 5); // cast=3 clears quorum(3) and floor(3); 3>=0 && 3>0
  assert.equal(exact.status, "passed");
});

test("tally: both quorum and floor would fail -- quorum is reported (design doc §6's stated check order)", () => {
  const r = tally("constitutional", 1, 0, 0, 10); // cast=1: quorum needs 5, floor needs 3 -- both fail
  assert.equal(r.status, "failed");
  assert.equal(r.reason, "quorum");
});

test("tally: constitutional 2/3 threshold, exact boundary both sides", () => {
  // eligible=1 keeps quorum out of the way (quorumThreshold(1)=1, always
  // cleared); abstains pad cast to clear the floor(3) in every row so only
  // the Y>=2N rule is under test -- the failing rows assert reason:"margin"
  // specifically, proving they fail on the ratio and not on floor/quorum.
  assert.equal(tally("constitutional", 4, 2, 0, 1).status, "passed"); // 4 >= 2*2 exactly, cast=6
  const oneShort = tally("constitutional", 3, 2, 0, 1); // 3 < 2*2, cast=5
  assert.equal(oneShort.status, "failed");
  assert.equal(oneShort.reason, "margin");
  assert.equal(tally("constitutional", 2, 1, 0, 1).status, "passed"); // 2 >= 2*1 exactly, cast=3
  const tie = tally("constitutional", 1, 1, 1, 1); // 1 < 2*1, cast padded to 3 with one abstain
  assert.equal(tie.status, "failed");
  assert.equal(tie.reason, "margin");
});

test("tally: constitutional all-abstain cannot pass even when quorum and floor both clear (the Y>0 clause)", () => {
  const r = tally("constitutional", 0, 0, 3, 3); // cast=3 clears quorum(ceil(3/2)=2) and floor(3); 0>=0 but 0 is not >0
  assert.equal(r.status, "failed");
  assert.equal(r.reason, "margin");
});

test("tally: parameter quorum and floor boundaries", () => {
  const shortOfQuorum = tally("parameter", 1, 0, 0, 4); // cast=1 < quorum(ceil(4/2)=2)
  assert.equal(shortOfQuorum.status, "failed");
  assert.equal(shortOfQuorum.reason, "quorum");
  const tie = tally("parameter", 1, 1, 0, 4); // cast=2 clears quorum(2) and floor(2), but 1 is not > 1
  assert.equal(tie.status, "failed");
  assert.equal(tie.reason, "margin");
});

test("tally: parameter and advisory pass iff yes > no, exact tie fails", () => {
  assert.equal(tally("parameter", 2, 1, 0, 2).status, "passed"); // eligible=2 -> quorum 1, floor 2, cast=3
  assert.equal(tally("parameter", 2, 2, 0, 2).status, "failed"); // tie
  assert.equal(tally("advisory", 1, 0, 0, 100).status, "passed"); // advisory has no quorum
  assert.equal(tally("advisory", 0, 1, 0, 100).status, "failed");
});

test("tally: advisory has no quorum but still has the 1-ballot floor", () => {
  const r = tally("advisory", 0, 0, 0, 1000); // cast=0
  assert.equal(r.status, "failed");
  assert.equal(r.reason, "floor");
  // A single abstain clears the floor (presence) but a lone abstention
  // still cannot pass -- yes(0) is not > no(0).
  const oneAbstain = tally("advisory", 0, 0, 1, 1000);
  assert.equal(oneAbstain.status, "failed");
  assert.equal(oneAbstain.reason, "margin");
});

test("tally: abstain counts toward quorum and floor, never toward passage", () => {
  const withoutAbstain = tally("constitutional", 4, 2, 0, 6);
  const withAbstain = tally("constitutional", 4, 2, 5, 6);
  assert.equal(withoutAbstain.status, "passed");
  assert.equal(withAbstain.status, "passed");

  // A failing margin (3 < 2*2) stays failed no matter how many abstains
  // pile on -- abstain can satisfy quorum/floor but can never flip margin.
  const failingMargin = tally("constitutional", 3, 2, 0, 1);
  const failingMarginWithAbstains = tally("constitutional", 3, 2, 100, 1);
  assert.equal(failingMargin.status, "failed");
  assert.equal(failingMarginWithAbstains.status, "failed");
});

// ---------- entrenched class (First Laws, D-025) ----------

test("entrenchedQuorumThreshold is ceil(2E/3)", () => {
  const cases: [number, number][] = [
    [4, 3],
    [5, 4],
    [6, 4],
    [7, 5],
    [8, 6],
    [9, 6],
    [10, 7],
  ];
  for (const [eligible, expected] of cases) {
    assert.equal(entrenchedQuorumThreshold(eligible), expected, `eligible=${eligible}`);
  }
});

// design doc §3's own crossover point (D-025 q2/q3, [G1-4]): the
// entrenched floor is 4, so below E=7 the floor is what actually binds
// (quorum clears first); at and above E=7 quorum overtakes it. Each row
// below is all-yes (no/abstain=0) so only quorum/floor are under test, the
// same isolation the existing constitutional quorum/floor tests use.
test("tally: entrenched quorum/floor interplay across E=4..10, the floor-4/quorum crossover at E=7 (D-025 q2/q3, [G1-4])", () => {
  // E=4: quorum=3, floor=4 -- floor is the higher bar.
  assert.deepEqual(tally("entrenched", 2, 0, 0, 4), { status: "failed", cast: 2, reason: "quorum" }); // cast=2 < quorum(3)
  assert.deepEqual(tally("entrenched", 3, 0, 0, 4), { status: "failed", cast: 3, reason: "floor" }); // cast=3 clears quorum(3), fails floor(4)
  assert.equal(tally("entrenched", 4, 0, 0, 4).status, "passed"); // cast=4 clears both, 4>=3*0 && 4>0

  // E=5: quorum=4, floor=4 -- exactly equal.
  assert.deepEqual(tally("entrenched", 3, 0, 0, 5), { status: "failed", cast: 3, reason: "quorum" });
  assert.equal(tally("entrenched", 4, 0, 0, 5).status, "passed");

  // E=6: quorum=4, floor=4 -- still equal.
  assert.deepEqual(tally("entrenched", 3, 0, 0, 6), { status: "failed", cast: 3, reason: "quorum" });
  assert.equal(tally("entrenched", 4, 0, 0, 6).status, "passed");

  // E=7: quorum=5, floor=4 -- quorum now the higher bar, the named crossover.
  assert.deepEqual(tally("entrenched", 4, 0, 0, 7), { status: "failed", cast: 4, reason: "quorum" }); // cast=4 clears floor(4), fails quorum(5)
  assert.equal(tally("entrenched", 5, 0, 0, 7).status, "passed");

  // E=8: quorum=6.
  assert.deepEqual(tally("entrenched", 5, 0, 0, 8), { status: "failed", cast: 5, reason: "quorum" });
  assert.equal(tally("entrenched", 6, 0, 0, 8).status, "passed");

  // E=9: quorum=6.
  assert.deepEqual(tally("entrenched", 5, 0, 0, 9), { status: "failed", cast: 5, reason: "quorum" });
  assert.equal(tally("entrenched", 6, 0, 0, 9).status, "passed");

  // E=10: quorum=7.
  assert.deepEqual(tally("entrenched", 6, 0, 0, 10), { status: "failed", cast: 6, reason: "quorum" });
  assert.equal(tally("entrenched", 7, 0, 0, 10).status, "passed");
});

test("tally: entrenched 3N passage threshold, exact boundary both sides (D-025 q1, 75% integer form)", () => {
  // eligible=1 keeps quorum out of the way (entrenchedQuorumThreshold(1)=1,
  // always cleared); abstains pad cast to clear the floor(4) in every row
  // so only the Y>=3N rule is under test -- the failing rows assert
  // reason:"margin" specifically, proving they fail on the ratio and not
  // on floor/quorum (mirrors the constitutional 2/3 test's own idiom).
  assert.equal(tally("entrenched", 3, 1, 0, 1).status, "passed"); // 3 >= 3*1 exactly, cast=4 (floor already met, no padding needed)
  const oneShort = tally("entrenched", 2, 1, 1, 1); // 2 < 3*1, cast padded to 4 with one abstain
  assert.equal(oneShort.status, "failed");
  assert.equal(oneShort.reason, "margin");
  const allAbstain = tally("entrenched", 0, 0, 4, 1); // cast=4 clears floor/quorum; 0>=3*0 but 0 is not >0 (the explicit Y>0 clause)
  assert.equal(allAbstain.status, "failed");
  assert.equal(allAbstain.reason, "margin");
});

// ---------- validatePayload ----------

// currentNameRatified: true here -- this shared ctx's "Commonhold" stands
// for an ALREADY-ratified name (a set_name vote has passed), so the
// existing "equals current" assertion below keeps testing the real no-op
// refusal. The other new field is a don't-care for every other kind this
// ctx is shared with (dividend/split/control-floor/body-only). The
// never-ratified case (the bug this file's set_name tests were missing)
// gets its own dedicated ctx values below, not this shared one.
const ctx = { currentName: "Commonhold", currentControlFloorPercent: 51, currentNameRatified: true };

test("validatePayload: set_name accepts 3-40 printable ASCII chars, rejects outside the boundary", () => {
  assert.deepEqual(validatePayload("set_name", { name: "Hallmoot" }, ctx), { name: "Hallmoot" });
  assert.deepEqual(validatePayload("set_name", { name: "abc" }, ctx), { name: "abc" }); // 3 chars, lower boundary
  assert.throws(() => validatePayload("set_name", { name: "ab" }, ctx), isBadRequest); // 2 chars
  assert.deepEqual(validatePayload("set_name", { name: "a".repeat(40) }, ctx), { name: "a".repeat(40) }); // 40 chars, upper boundary
  assert.throws(() => validatePayload("set_name", { name: "a".repeat(41) }, ctx), isBadRequest); // 41 chars
  assert.throws(() => validatePayload("set_name", { name: "tab\ttab" }, ctx), isBadRequest); // non-printable
  assert.throws(() => validatePayload("set_name", { name: "Commonhold" }, ctx), isBadRequest); // equals current, already ratified
  assert.throws(() => validatePayload("set_name", {}, ctx), isBadRequest);
  assert.throws(() => validatePayload("set_name", null, ctx), isBadRequest);
});

// docs/REVIEW-DEMOCRACY.md L4: space is itself within the printable-ASCII
// range NAME_PATTERN allows, so an all-space name (3+ spaces) previously
// passed -- reproduced as rendering the title as blank and the signature
// as a bare em dash.
test("validatePayload: set_name refuses an all-space name at every length that would otherwise satisfy the 3-40 char bound", () => {
  assert.throws(() => validatePayload("set_name", { name: "   " }, ctx), isBadRequest); // exactly 3 spaces
  assert.throws(() => validatePayload("set_name", { name: " ".repeat(40) }, ctx), isBadRequest); // exactly 40 spaces
  // A name that is mostly space but has one real character is still fine.
  assert.deepEqual(validatePayload("set_name", { name: "  x" }, ctx), { name: "  x" });
});

// The defect this fix closes: founding completes only once set_name is
// ratified (isFoundingComplete -> isFoundingRatified(env, "set_name")),
// but the old guard refused ANY proposal naming the current value --
// including DEFAULT_NAME, which sits in currentName from deploy until a
// set_name vote first passes. Composed, that meant founding could never
// complete without a rename: the founding cohort could not ratify the
// provisional name it was already using, and no proposal for any other
// kind gated on founding could ever open. Confirming a never-ratified
// default is not a no-op -- it is the vote that ratifies it -- so it must
// be allowed.
test("validatePayload: set_name allows re-proposing the current name when it has NEVER been ratified (confirming a provisional default is not a no-op)", () => {
  const neverRatifiedCtx = { currentName: DEFAULT_NAME, currentControlFloorPercent: 51, currentNameRatified: false };
  assert.deepEqual(validatePayload("set_name", { name: DEFAULT_NAME }, neverRatifiedCtx), { name: DEFAULT_NAME });
});

test("validatePayload: set_name still refuses re-proposing the current name once it HAS been ratified -- the real no-op case", () => {
  const ratifiedCtx = { currentName: "Hallmoot", currentControlFloorPercent: 51, currentNameRatified: true };
  assert.throws(() => validatePayload("set_name", { name: "Hallmoot" }, ratifiedCtx), isBadRequest);
});

test("validatePayload: set_name proposing a DIFFERENT name is allowed regardless of whether the current name was ratified", () => {
  const neverRatifiedCtx = { currentName: DEFAULT_NAME, currentControlFloorPercent: 51, currentNameRatified: false };
  const ratifiedCtx = { currentName: DEFAULT_NAME, currentControlFloorPercent: 51, currentNameRatified: true };
  assert.deepEqual(validatePayload("set_name", { name: "Hallmoot" }, neverRatifiedCtx), { name: "Hallmoot" });
  assert.deepEqual(validatePayload("set_name", { name: "Hallmoot" }, ratifiedCtx), { name: "Hallmoot" });
});

test("validatePayload: set_dividend_uplift enforces the 2-20/1-12 integer floors", () => {
  assert.deepEqual(validatePayload("set_dividend_uplift", { total_percent: 2, months: 1 }, ctx), { total_percent: 2, months: 1 });
  assert.throws(() => validatePayload("set_dividend_uplift", { total_percent: 1, months: 1 }, ctx), isBadRequest); // below the constitutional floor
  assert.deepEqual(validatePayload("set_dividend_uplift", { total_percent: 20, months: 12 }, ctx), { total_percent: 20, months: 12 });
  assert.throws(() => validatePayload("set_dividend_uplift", { total_percent: 21, months: 1 }, ctx), isBadRequest);
  assert.throws(() => validatePayload("set_dividend_uplift", { total_percent: 5, months: 0 }, ctx), isBadRequest);
  assert.throws(() => validatePayload("set_dividend_uplift", { total_percent: 5, months: 13 }, ctx), isBadRequest);
  assert.throws(() => validatePayload("set_dividend_uplift", { total_percent: 2.5, months: 1 }, ctx), isBadRequest); // non-integer
});

test("validatePayload: set_dividend_uplift's refusal below 2 quotes the constitution", () => {
  try {
    validatePayload("set_dividend_uplift", { total_percent: 1, months: 1 }, ctx);
    assert.fail("expected a throw");
  } catch (e) {
    assert.ok(e instanceof SocietyError);
    assert.match((e as SocietyError).message, /never falls below 2%/);
  }
});

test("validatePayload: set_split enforces 1-99 on both fields independently", () => {
  assert.deepEqual(validatePayload("set_split", { prize: 1, bounty: 1 }, ctx), { prize: 1, bounty: 1 });
  assert.deepEqual(validatePayload("set_split", { prize: 99, bounty: 99 }, ctx), { prize: 99, bounty: 99 });
  assert.throws(() => validatePayload("set_split", { prize: 0, bounty: 50 }, ctx), isBadRequest);
  assert.throws(() => validatePayload("set_split", { prize: 100, bounty: 50 }, ctx), isBadRequest);
  assert.throws(() => validatePayload("set_split", { prize: 50, bounty: 0 }, ctx), isBadRequest);
  assert.throws(() => validatePayload("set_split", { prize: 50, bounty: 100 }, ctx), isBadRequest);
});

test("validatePayload: control_floor_raise enforces the 51-100 absolute floor and may-only-rise", () => {
  assert.deepEqual(validatePayload("control_floor_raise", { percent: 51 }, ctx), { percent: 51 }); // == current, allowed
  assert.throws(() => validatePayload("control_floor_raise", { percent: 50 }, ctx), isBadRequest); // below absolute floor
  assert.deepEqual(validatePayload("control_floor_raise", { percent: 100 }, ctx), { percent: 100 });
  assert.throws(() => validatePayload("control_floor_raise", { percent: 101 }, ctx), isBadRequest);
  const higherCtx = { currentName: "Commonhold", currentControlFloorPercent: 70, currentNameRatified: true };
  assert.throws(() => validatePayload("control_floor_raise", { percent: 69 }, higherCtx), isBadRequest); // below current, though above the absolute 51 floor
  assert.deepEqual(validatePayload("control_floor_raise", { percent: 70 }, higherCtx), { percent: 70 }); // equals current, allowed
});

test("validatePayload: control_floor_raise's refusal below 51 quotes the constitution", () => {
  try {
    validatePayload("control_floor_raise", { percent: 50 }, ctx);
    assert.fail("expected a throw");
  } catch (e) {
    assert.ok(e instanceof SocietyError);
    assert.match((e as SocietyError).message, /does not fall/);
  }
});

test("validatePayload: the seven {body only} kinds accept a null/absent payload and reject a structured one", () => {
  const bodyOnly: ProposalKind[] = [
    "handler_arrangement",
    "buyout_terms",
    "official_token",
    "text_amendment",
    "resolution",
    "first_laws_ratify",
    "first_laws_amendment",
  ];
  for (const kind of bodyOnly) {
    assert.equal(validatePayload(kind, null, ctx), null);
    assert.equal(validatePayload(kind, undefined, ctx), null);
    assert.throws(() => validatePayload(kind, { anything: true }, ctx), isBadRequest, `${kind} should refuse a structured payload`);
  }
});

// ---------- refusesDisguisedFirstLawsAmendment ----------

test("refusesDisguisedFirstLawsAmendment: refuses a text_amendment body containing the FIRST LAWS heading literal, directing to first_laws_amendment", () => {
  assert.equal(refusesDisguisedFirstLawsAmendment("text_amendment", "Change the prize:bounty split wording."), null);
  const refusal = refusesDisguisedFirstLawsAmendment("text_amendment", "Reword the FIRST LAWS section to soften rule 1.");
  assert.ok(refusal);
  assert.match(refusal!, /first_laws_amendment instead/);
});

test("refusesDisguisedFirstLawsAmendment: a no-op for every kind other than text_amendment, even carrying the literal", () => {
  for (const kind of PROPOSAL_KINDS.filter((k) => k !== "text_amendment")) {
    assert.equal(refusesDisguisedFirstLawsAmendment(kind, "mentions FIRST LAWS in passing"), null, `${kind} should never be refused by this check`);
  }
});

// ---------- assertEligible ----------

const DAY = 86_400_000;

function baseInput(overrides: Partial<EligibilityInput> = {}): EligibilityInput {
  return {
    citizenCreatedAt: 0,
    isFounder: false,
    registrationMode: "open",
    foundingRatified: true,
    kind: "resolution",
    voteClass: "advisory",
    proposalOpenedAt: 100 * DAY,
    ...overrides,
  };
}

test("assertEligible: invite-only mode waives tenure entirely, even zero tenure", () => {
  assert.doesNotThrow(() =>
    assertEligible(
      baseInput({
        registrationMode: "invite_only",
        citizenCreatedAt: 100 * DAY,
        proposalOpenedAt: 100 * DAY,
        voteClass: "constitutional",
        kind: "official_token",
      }),
    ),
  );
});

test("assertEligible: open mode, constitutional tenure boundary is exactly 14 days", () => {
  const opened = 100 * DAY;
  assert.doesNotThrow(() =>
    assertEligible(
      baseInput({ registrationMode: "open", voteClass: "constitutional", kind: "official_token", citizenCreatedAt: opened - 14 * DAY, proposalOpenedAt: opened }),
    ),
  );
  assert.throws(
    () =>
      assertEligible(
        baseInput({ registrationMode: "open", voteClass: "constitutional", kind: "official_token", citizenCreatedAt: opened - 14 * DAY + 1, proposalOpenedAt: opened }),
      ),
    isForbidden,
  );
});

test("assertEligible: open mode, parameter/advisory tenure boundary is exactly 7 days", () => {
  const opened = 100 * DAY;
  for (const voteClass of ["parameter", "advisory"] as const) {
    const kind = voteClass === "parameter" ? "set_split" : "resolution";
    assert.doesNotThrow(() =>
      assertEligible(baseInput({ registrationMode: "open", voteClass, kind, citizenCreatedAt: opened - 7 * DAY, proposalOpenedAt: opened })),
    );
    assert.throws(
      () => assertEligible(baseInput({ registrationMode: "open", voteClass, kind, citizenCreatedAt: opened - 7 * DAY + 1, proposalOpenedAt: opened })),
      isForbidden,
    );
  }
});

test("assertEligible: open mode, entrenched tenure boundary is exactly 14 days -- same figure as constitutional (D-025, docs/FIRST-LAWS-DESIGN.md: 'same as constitutional')", () => {
  const opened = 100 * DAY;
  assert.doesNotThrow(() =>
    assertEligible(
      baseInput({ registrationMode: "open", voteClass: "entrenched", kind: "first_laws_ratify", citizenCreatedAt: opened - 14 * DAY, proposalOpenedAt: opened }),
    ),
  );
  assert.throws(
    () =>
      assertEligible(
        baseInput({ registrationMode: "open", voteClass: "entrenched", kind: "first_laws_ratify", citizenCreatedAt: opened - 14 * DAY + 1, proposalOpenedAt: opened }),
      ),
    isForbidden,
  );
});

test("assertEligible: registering mid-vote never enfranchises for that vote, however long the citizen then waits", () => {
  // Proposal opened at day 100; citizen registers at day 105 (after open) --
  // the gate is fixed against opened_at, not against any later "now".
  assert.throws(
    () => assertEligible(baseInput({ registrationMode: "open", voteClass: "advisory", kind: "resolution", citizenCreatedAt: 105 * DAY, proposalOpenedAt: 100 * DAY })),
    isForbidden,
  );
});

// F3/F5 (docs/BRIEF-FIRST-LAWS-REPAIR.md §5.3 item 1): the founding-gated
// set is now {set_name, first_laws_ratify} -- the two founding votes
// themselves -- and text_amendment is REMOVED from it (F5: an ordinary
// constitutional amendment, tenure-gated like any other, not founder-
// gated forever until its own first passage). Split into the positive
// case (both gated kinds block a non-founder while foundingRatified is
// false) and the negative case (text_amendment, given the SAME inputs,
// must NOT throw) so the test cannot silently pass by asserting the old
// three-kind grouping.
test("assertEligible: founding carve-out blocks a non-founder on set_name/first_laws_ratify while founding is incomplete", () => {
  for (const kind of ["set_name", "first_laws_ratify"] as const) {
    const voteClass = classOf(kind);
    assert.throws(
      () => assertEligible(baseInput({ kind, voteClass, foundingRatified: false, isFounder: false, registrationMode: "invite_only" })),
      isForbidden,
      `${kind} must be founder-gated while founding is incomplete`,
    );
    assert.doesNotThrow(() =>
      assertEligible(baseInput({ kind, voteClass, foundingRatified: false, isFounder: true, registrationMode: "invite_only" })),
    );
  }
});

test("assertEligible: text_amendment is NOT founder-gated (F5) -- the same inputs that block set_name/first_laws_ratify above must not throw for text_amendment", () => {
  assert.doesNotThrow(() =>
    assertEligible(baseInput({ kind: "text_amendment", voteClass: "constitutional", foundingRatified: false, isFounder: false, registrationMode: "invite_only" })),
  );
});

test("assertEligible: founding carve-out does not extend to other constitutional kinds", () => {
  // official_token is constitutional but not in the founding-gated list --
  // a non-founder must be eligible here even while founding is unratified,
  // proving the carve-out is scoped to exactly set_name/first_laws_ratify.
  assert.doesNotThrow(() =>
    assertEligible(baseInput({ kind: "official_token", voteClass: "constitutional", foundingRatified: false, isFounder: false, registrationMode: "invite_only" })),
  );
});

test("assertEligible: a founder still needs tenure once registration is open (the carve-out narrows, it does not replace, the tenure gate)", () => {
  const opened = 100 * DAY;
  assert.throws(
    () =>
      assertEligible(
        baseInput({
          kind: "set_name",
          voteClass: "constitutional",
          foundingRatified: false,
          isFounder: true,
          registrationMode: "open",
          citizenCreatedAt: opened - 1 * DAY,
          proposalOpenedAt: opened,
        }),
      ),
    isForbidden,
  );
});

test("assertEligible: once founding is ratified, an ordinary citizen with sufficient tenure may vote set_name/text_amendment", () => {
  const opened = 100 * DAY;
  assert.doesNotThrow(() =>
    assertEligible(
      baseInput({
        kind: "set_name",
        voteClass: "constitutional",
        foundingRatified: true,
        isFounder: false,
        registrationMode: "open",
        citizenCreatedAt: opened - 14 * DAY,
        proposalOpenedAt: opened,
      }),
    ),
  );
});

test("assertEligible: an unrecognised registration mode falls through to the stricter open-registration tenure gate, not the waived one", () => {
  assert.throws(
    () => assertEligible(baseInput({ registrationMode: "closed", voteClass: "advisory", kind: "resolution", citizenCreatedAt: 100 * DAY, proposalOpenedAt: 100 * DAY })),
    isForbidden,
  );
});

// ---------- countEligible ----------

test("countEligible: an empty citizen list counts zero", () => {
  const n = countEligible([], new Set(), {
    kind: "resolution",
    voteClass: "advisory",
    registrationMode: "invite_only",
    foundingRatified: true,
    proposalOpenedAt: 100 * DAY,
  });
  assert.equal(n, 0);
});

test("countEligible: invite_only mode counts every citizen regardless of tenure", () => {
  const citizens = [
    { id: 1, created_at: 100 * DAY }, // registered the same instant the proposal opened -- zero tenure
    { id: 2, created_at: 50 * DAY },
    { id: 3, created_at: 0 },
  ];
  const n = countEligible(citizens, new Set(), {
    kind: "resolution",
    voteClass: "advisory",
    registrationMode: "invite_only",
    foundingRatified: true,
    proposalOpenedAt: 100 * DAY,
  });
  assert.equal(n, 3);
});

test("countEligible: open mode excludes citizens short of tenure, counts the rest", () => {
  const opened = 100 * DAY;
  const citizens = [
    { id: 1, created_at: opened - 14 * DAY }, // exactly 14 days: eligible for constitutional
    { id: 2, created_at: opened - 13 * DAY }, // one day short: not eligible
    { id: 3, created_at: opened - 30 * DAY }, // long-registered: eligible
  ];
  const n = countEligible(citizens, new Set(), {
    kind: "official_token",
    voteClass: "constitutional",
    registrationMode: "open",
    foundingRatified: true,
    proposalOpenedAt: opened,
  });
  assert.equal(n, 2);
});

test("countEligible: a founding-gated kind while unratified counts only founders", () => {
  const citizens = [
    { id: 1, created_at: 0 },
    { id: 2, created_at: 0 },
    { id: 3, created_at: 0 },
  ];
  const founderIds = new Set([1, 3]);
  const n = countEligible(citizens, founderIds, {
    kind: "set_name",
    voteClass: "constitutional",
    registrationMode: "invite_only",
    foundingRatified: false,
    proposalOpenedAt: 100 * DAY,
  });
  assert.equal(n, 2);
});

// F3 (docs/BRIEF-FIRST-LAWS-REPAIR.md §5.3 item 2): first_laws_ratify is
// NOW in FOUNDING_GATED_KINDS (it was not, pre-repair) -- its own census
// while founding is incomplete must count founders only, exactly like
// set_name's above.
test("countEligible: a first_laws_ratify census while founding is incomplete counts only founders", () => {
  const citizens = [
    { id: 1, created_at: 0 },
    { id: 2, created_at: 0 },
    { id: 3, created_at: 0 },
  ];
  const founderIds = new Set([1, 3]);
  const n = countEligible(citizens, founderIds, {
    kind: "first_laws_ratify",
    voteClass: "entrenched",
    registrationMode: "invite_only",
    foundingRatified: false,
    proposalOpenedAt: 100 * DAY,
  });
  assert.equal(n, 2);
});

test("countEligible: once founding is ratified, non-founders are counted too", () => {
  const citizens = [
    { id: 1, created_at: 0 },
    { id: 2, created_at: 0 },
  ];
  const n = countEligible(citizens, new Set([1]), {
    kind: "set_name",
    voteClass: "constitutional",
    registrationMode: "invite_only",
    foundingRatified: true,
    proposalOpenedAt: 100 * DAY,
  });
  assert.equal(n, 2);
});

// ---------- monthsFromNow ----------

test("monthsFromNow: adds calendar months, not a fixed number of days", () => {
  const jan15 = Date.UTC(2026, 0, 15); // 2026-01-15
  const feb15 = Date.UTC(2026, 1, 15);
  assert.equal(monthsFromNow(jan15, 1), feb15);
});

test("monthsFromNow: crosses a year boundary correctly", () => {
  const dec1 = Date.UTC(2026, 11, 1); // 2026-12-01
  const feb1NextYear = Date.UTC(2027, 1, 1);
  assert.equal(monthsFromNow(dec1, 2), feb1NextYear);
});

test("monthsFromNow: 12 months lands on the same day next year", () => {
  const mar3 = Date.UTC(2026, 2, 3);
  const mar3NextYear = Date.UTC(2027, 2, 3);
  assert.equal(monthsFromNow(mar3, 12), mar3NextYear);
});

// docs/REVIEW-DEMOCRACY.md L3 red-proof. This test used to pin the
// opposite of what it now asserts: the naive `setUTCMonth` overflow was
// once "documented JS Date behaviour, not a governance rule" -- Jan 31 + 1
// month landing on 3 Mar, up to ~3 real days past what "one month" should
// mean, always in the operator's favour on the money path (a dividend
// uplift's own expiry). Fixed by clamping to the target month's real last
// day instead of letting the overflow roll into the month after. These are
// the review's own two reproductions, now asserting the corrected values.
test("monthsFromNow: a month-end source date clamps to the target month's real last day, it does not overflow into the following month", () => {
  const jan31 = Date.UTC(2026, 0, 31); // 2026 is not a leap year: Feb has 28 days
  assert.equal(monthsFromNow(jan31, 1), Date.UTC(2026, 1, 28), "31 Jan + 1 month must clamp to 28 Feb, not overflow to 3 Mar");

  const mar31 = Date.UTC(2026, 2, 31); // April has 30 days
  assert.equal(monthsFromNow(mar31, 1), Date.UTC(2026, 3, 30), "31 Mar + 1 month must clamp to 30 Apr, not overflow to 1 May");
});

test("monthsFromNow: a leap-year February is itself the clamp target", () => {
  const jan31LeapYear = Date.UTC(2028, 0, 31); // 2028 is a leap year: Feb has 29 days
  assert.equal(monthsFromNow(jan31LeapYear, 1), Date.UTC(2028, 1, 29), "the leap day itself is a valid clamp target, not 28");
});

test("monthsFromNow: time-of-day survives the clamp unchanged, only the date moves", () => {
  const jan31AtNoon = Date.UTC(2026, 0, 31, 12, 30, 45, 500);
  const result = new Date(monthsFromNow(jan31AtNoon, 1));
  assert.equal(result.getUTCDate(), 28);
  assert.equal(result.getUTCHours(), 12);
  assert.equal(result.getUTCMinutes(), 30);
  assert.equal(result.getUTCSeconds(), 45);
  assert.equal(result.getUTCMilliseconds(), 500);
});

test("monthsFromNow: a non-overflowing date is completely unaffected by the clamp", () => {
  const jan15 = Date.UTC(2026, 0, 15);
  assert.equal(monthsFromNow(jan15, 1), Date.UTC(2026, 1, 15));
});

// ---------- I-007: the attested constitution (docs/FIRST-LAWS-DESIGN.md §5) ----------

test("canonicalizeTemplate: normalises CRLF to LF and nothing else", () => {
  assert.equal(canonicalizeTemplate("a\r\nb\r\nc"), "a\nb\nc");
  assert.equal(canonicalizeTemplate("already\nlf\nonly"), "already\nlf\nonly");
  // No other transformation: internal spacing, trailing/leading
  // whitespace, and a bare \r (not part of a \r\n pair) all survive
  // untouched -- the design doc is explicit ("no other transformation").
  assert.equal(canonicalizeTemplate("  spaced  \n\ttabbed\t"), "  spaced  \n\ttabbed\t");
  assert.equal(canonicalizeTemplate("a\rb"), "a\rb", "a bare CR with no following LF is not a CRLF pair and must survive");
});

// F2 (docs/BRIEF-FIRST-LAWS-REPAIR.md §4.3 item 2): replaces the old
// two-diagonal-calls sampler test. That sampler asserted specific
// substrings the two diagonal frontDoor() calls happened to cover -- true
// only because the two conditionals (nameRatified, firstLawsRatified)
// happen to be independent today. This test instead (a) asserts every
// fragment constant is present VERBATIM (proving the superset construction
// really does carry both name-status branches and the banner, not merely
// text that happens to overlap with them), and (b) proves the general
// property directly: for EVERY one of the four (nameRatified,
// firstLawsRatified) states, every line frontDoor actually serves (at the
// identical DEFAULT values and canonical origin buildConstitutionTemplate
// itself uses) appears somewhere in buildConstitutionTemplate()'s own
// text -- so a FUTURE third conditional doc.ts might grow cannot silently
// serve a mixed-state clause neither of two fixed diagonal calls would
// have exercised, the exact class of gap F2 closes.
const CANONICAL_CONSTITUTION_ORIGIN_FOR_TEST = "https://commonhold.invalid"; // governance.ts's own private constant, mirrored here for the line-by-line comparison below

test("buildConstitutionTemplate: carries both nameStatusSentence branches and the FIRST_LAWS_BANNER fragment verbatim, and is stable across calls", () => {
  const template = buildConstitutionTemplate();
  assert.ok(template.includes(NAME_STATUS_RATIFIED), "the ratified name-status sentence must be present verbatim");
  assert.ok(template.includes(NAME_STATUS_PROVISIONAL), "the provisional name-status sentence must be present verbatim");
  assert.ok(template.includes(FIRST_LAWS_BANNER), "the FIRST LAWS PROPOSED banner must be present verbatim");
  // Never the real deployment's own worker URL -- a stable placeholder
  // only (not a check against "randommonicle": that substring also
  // appears legitimately in doc.ts's own static "ON THE SOURCE" GitHub
  // link, unrelated to the interpolated serving origin this test cares
  // about).
  assert.doesNotMatch(template, /workers\.dev/);
  assert.ok(template.includes(CANONICAL_CONSTITUTION_ORIGIN_FOR_TEST));
  // Pure and deterministic: reads only module constants, never a clock
  // or randomness, so calling it twice must be byte-identical.
  assert.equal(buildConstitutionTemplate(), template);
});

test("F2 superset coverage: for all eight (registrationMode, nameRatified, firstLawsRatified) states, every line frontDoor actually serves appears somewhere in buildConstitutionTemplate()", () => {
  const template = buildConstitutionTemplate();
  const defaultFacts = {
    name: DEFAULT_NAME,
    controlFloorPercent: DEFAULT_CONTROL_FLOOR_PERCENT,
    dividendPercent: 2, // society.ts's DEFAULT_DIVIDEND_PERCENT -- not re-exported by governance.ts, mirrored as a literal (test/doc.test.ts's own baseFacts does the same)
    split: { prize: 4, bounty: 3 }, // society.ts's DEFAULT_SPLIT
  };
  // The nameStatusSentence fragment is spliced MID-SENTENCE ("citizens are
  // AI agents. {{NAME_STATUS_SENTENCE}} There is"), so the two rendered
  // lines it touches mix static text with the fragment's own two lines --
  // those two lines legitimately do not appear verbatim in
  // buildConstitutionTemplate() (whose own superset carries BOTH
  // sentences back-to-back with a separator, not spliced into the
  // surrounding sentence). Excluded here by content, not by line number,
  // since coverage of the fragment ITSELF is already asserted verbatim by
  // the test immediately above -- this test's job is the surrounding
  // static prose, which the FIRST_LAWS_BANNER fragment does not have this
  // problem (it is a prefix ending in its own blank line, so "Three laws,
  // lexically ordered:" always starts a clean line either way).
  const conditionalLineFragments = [...NAME_STATUS_RATIFIED.split("\n"), ...NAME_STATUS_PROVISIONAL.split("\n")];
  // registrationMode joins the sweep as the third conditional. Without it this
  // loop left `registrationMode` undefined, which is not "invite_only", so it
  // silently swept the OPEN branch four times and never once checked the branch
  // the deployment actually serves.
  for (const registrationMode of ["invite_only", "open"]) {
  for (const nameRatified of [false, true]) {
    for (const firstLawsRatified of [false, true]) {
      const served = frontDoor(CANONICAL_CONSTITUTION_ORIGIN_FOR_TEST, { ...defaultFacts, registrationMode, nameRatified, firstLawsRatified });
      for (const line of served.split("\n")) {
        if (line.trim().length === 0) continue; // blank lines are trivially present everywhere; not a meaningful assertion
        if (conditionalLineFragments.some((frag) => line.includes(frag))) continue;
        assert.ok(
          template.includes(line),
          `frontDoor(registrationMode=${registrationMode}, nameRatified=${nameRatified}, firstLawsRatified=${firstLawsRatified}) served a line buildConstitutionTemplate() does not carry: ${JSON.stringify(line)}`,
        );
      }
    }
  }
  }
});

test("buildConstitutionTemplate: uses the deployed DEFAULT values, never a live governance_settings value (which is independently attested through its own chained proposal_decided event already)", () => {
  const template = buildConstitutionTemplate().replace(/\s+/g, " ");
  assert.ok(template.includes(DEFAULT_NAME));
  assert.ok(template.includes(`not less than ${DEFAULT_CONTROL_FLOOR_PERCENT}% control`));
});

test("serializeConstitutionParameters: valid JSON, all four classes present with D-025's own figures, and the full eleven-kind KIND_CLASS map", () => {
  const parsed = JSON.parse(serializeConstitutionParameters()) as {
    classes: Array<{ class: string; min_ballots: number; window_ms: number; tenure_days: number }>;
    kind_class: Record<string, string>;
  };
  assert.equal(parsed.classes.length, 4);
  const byClass = Object.fromEntries(parsed.classes.map((c) => [c.class, c]));
  assert.equal(byClass.entrenched.min_ballots, 4);
  assert.equal(byClass.entrenched.window_ms, ENTRENCHED_VOTE_WINDOW_MS);
  assert.equal(byClass.entrenched.tenure_days, 14);
  assert.equal(byClass.constitutional.min_ballots, 3);
  assert.equal(byClass.constitutional.window_ms, VOTE_WINDOW_MS);
  assert.equal(byClass.parameter.min_ballots, 2);
  assert.equal(byClass.advisory.min_ballots, 1);
  assert.equal(Object.keys(parsed.kind_class).length, 11);
  assert.equal(parsed.kind_class.first_laws_ratify, "entrenched");
  assert.equal(parsed.kind_class.first_laws_amendment, "entrenched");
  assert.equal(parsed.kind_class.resolution, "advisory");
});

test("serializeConstitutionParameters: is stable across calls (pure, no clock, no randomness)", () => {
  assert.equal(serializeConstitutionParameters(), serializeConstitutionParameters());
});

// ---------- F1 (docs/BRIEF-FIRST-LAWS-REPAIR.md §3): the executed rule and
// the attested rule are the SAME table, not two independent copies ----------

test("F1 coupling: serializeConstitutionParameters emits the SAME CLASS_QUORUM_RULE/CLASS_PASSAGE_RULE objects tally() reads, for every class", () => {
  const parsed = JSON.parse(serializeConstitutionParameters()) as {
    classes: Array<{ class: "entrenched" | "constitutional" | "parameter" | "advisory"; quorum_rule: unknown; passage_rule: unknown }>;
  };
  const byClass = Object.fromEntries(parsed.classes.map((c) => [c.class, c]));
  for (const voteClass of ["entrenched", "constitutional", "parameter", "advisory"] as const) {
    assert.deepEqual(byClass[voteClass].quorum_rule, CLASS_QUORUM_RULE[voteClass], `${voteClass} quorum_rule must match CLASS_QUORUM_RULE exactly`);
    assert.deepEqual(byClass[voteClass].passage_rule, CLASS_PASSAGE_RULE[voteClass], `${voteClass} passage_rule must match CLASS_PASSAGE_RULE exactly`);
  }
});

test("F1 coupling: tally() passes/fails at the exact boundary CLASS_PASSAGE_RULE's own yesAtLeastTimesNo describes, entrenched class, k read from the table not hardcoded", () => {
  const k = CLASS_PASSAGE_RULE.entrenched;
  assert.equal(k.shape, "supermajority");
  const yesAtLeastTimesNo = k.shape === "supermajority" ? k.yesAtLeastTimesNo : NaN;
  // no=2 (not 1): keeps cast comfortably clear of the floor(4)/quorum(1 at
  // eligible=1) regardless of what k happens to be, so this test's own
  // pass/fail verdict is driven purely by the margin comparison against
  // the table's k, never confounded by a floor/quorum edge shifting
  // alongside a mutated k (the exact confound a no=1 construction hit
  // during this test's own red-proof).
  const atBoundary = tally("entrenched", yesAtLeastTimesNo * 2, 2, 0, 1);
  assert.equal(atBoundary.status, "passed", `yes=${yesAtLeastTimesNo * 2} no=2 must pass at the exact ${yesAtLeastTimesNo}x boundary`);
  const oneBelow = tally("entrenched", yesAtLeastTimesNo * 2 - 1, 2, 0, 1);
  assert.equal(oneBelow.status, "failed", `yes=${yesAtLeastTimesNo * 2 - 1} no=2 must fail, one below the boundary`);
});

// Golden parameters_hash pin (enforce-invariants-in-build): computed after
// the F1 fix landed (CLASS_QUORUM_RULE/CLASS_PASSAGE_RULE objects replacing
// the hand-typed quorum_rule/passage_rule strings), from
// serializeConstitutionParameters() at rest, no live DB involved. Recorded
// here so an unreviewed edit to the tables' declared shape or figures moves
// this pin as loudly as it moves the live parameters_hash a citizen can
// independently recompute -- see the prove-it-can-fail note on this test in
// the checkpoint log for the mutate-and-confirm-red round.
test("F1 golden pin: sha256Hex(serializeConstitutionParameters()) matches the committed constant", async () => {
  const { sha256Hex } = await import("../src/chain.ts");
  const hash = await sha256Hex(serializeConstitutionParameters());
  assert.equal(hash, GOLDEN_PARAMETERS_HASH, "parameters_hash moved -- if this is an intentional First Laws repair change, recompute and update GOLDEN_PARAMETERS_HASH deliberately, never silently");
});

// ---------- F6 (docs/BRIEF-FIRST-LAWS-REPAIR.md §6): the First Laws state
// machine's declared shape is now attested, not three independent
// un-attested surfaces ----------

test("F6 shippable red 1: serializeConstitutionParameters's first_laws_policy field deep-equals the canonical serialisation of the executable FIRST_LAWS_POLICY", () => {
  const parsed = JSON.parse(serializeConstitutionParameters()) as { first_laws_policy: unknown };
  // Round-trip FIRST_LAWS_POLICY through JSON.parse(JSON.stringify(...))
  // too, so the comparison is plain-object-to-plain-object (deepEqual
  // does not care about `undefined` map values the way a raw object
  // comparison against a Partial<Record<...>> with missing keys might),
  // not a live-object-vs-parsed-object mismatch that would fail for
  // reasons unrelated to what this test actually checks.
  const canonical = JSON.parse(JSON.stringify(FIRST_LAWS_POLICY));
  assert.deepEqual(parsed.first_laws_policy, canonical);
});

test("F6 shippable red 2: FOUNDING_GATED_KINDS and MACHINE_EXECUTABLE_KINDS are IDENTITY aliases of FIRST_LAWS_POLICY's own arrays, not copies", () => {
  assert.equal(FOUNDING_GATED_KINDS, FIRST_LAWS_POLICY.foundingGatedKinds, "must be the SAME array object (===), not a value-equal copy");
  assert.equal(MACHINE_EXECUTABLE_KINDS, FIRST_LAWS_POLICY.machineExecutableKinds, "must be the SAME array object (===), not a value-equal copy");
});

// Per-field prove-it-can-fail (§6.3 item 3), foundingGatedKinds: mutated
// IN PLACE (not by reassigning FIRST_LAWS_POLICY.foundingGatedKinds to a
// new array, which would only decouple the FOUNDING_GATED_KINDS alias
// bound at module load from the policy's own later-reassigned property --
// an artefact of how this test mutates the field, not a real-world
// concern, since a genuine hostile SOURCE edit changes the one array
// literal both readers were always going to share). In-place mutation
// (via a mutable-array cast around the readonly type) is what an actual
// content edit to the declared list looks like at runtime, and proves the
// executor (assertEligible, via FOUNDING_GATED_KINDS) and the attested
// hash (via FIRST_LAWS_POLICY.foundingGatedKinds, the SAME object) move
// together.
test("F6 per-field prove-it-can-fail: mutating FIRST_LAWS_POLICY.foundingGatedKinds changes assertEligible's behaviour AND moves the attested parameters_hash, together", async () => {
  const { sha256Hex } = await import("../src/chain.ts");
  const mutable = FIRST_LAWS_POLICY.foundingGatedKinds as ProposalKind[];
  const original = [...mutable];
  const hashBefore = await sha256Hex(serializeConstitutionParameters());
  const inputBefore: EligibilityInput = {
    citizenCreatedAt: 0,
    isFounder: false,
    registrationMode: "invite_only",
    foundingRatified: false,
    kind: "first_laws_ratify",
    voteClass: "entrenched",
    proposalOpenedAt: 0,
  };
  assert.throws(() => assertEligible(inputBefore), "before mutation: first_laws_ratify must still be founder-gated");

  try {
    mutable.length = 0;
    mutable.push("set_name"); // first_laws_ratify silently dropped -- a non-founder is now let through
    assert.doesNotThrow(() => assertEligible(inputBefore), "after mutation: first_laws_ratify is no longer founder-gated -- a non-founder must now be let through");
    const hashAfter = await sha256Hex(serializeConstitutionParameters());
    assert.notEqual(hashAfter, hashBefore, "the attested parameters_hash must move alongside the behavioural change");
  } finally {
    mutable.length = 0;
    mutable.push(...original);
  }
  // Revert confirmed: both the behaviour and the hash are back to normal.
  assert.throws(() => assertEligible(inputBefore), isForbidden);
  assert.equal(await sha256Hex(serializeConstitutionParameters()), hashBefore);
});

test("computeLiveConstitutionPair: both hashes are stable 64-char lowercase hex across repeated calls (deterministic, pure)", async () => {
  const first = await computeLiveConstitutionPair();
  const second = await computeLiveConstitutionPair();
  assert.deepEqual(first, second);
  assert.match(first.templateHash, /^[0-9a-f]{64}$/);
  assert.match(first.parametersHash, /^[0-9a-f]{64}$/);
  assert.notEqual(first.templateHash, first.parametersHash, "sanity: the template and parameters hash different content, so they must not coincide");
});

test("the hashing mechanism itself is sensitive to content -- a one-character difference in either the template or the parameters text produces a different hash (proves detection CAN see a real wording/parameter change, independent of buildConstitutionTemplate's own current fixed inputs)", async () => {
  const { sha256Hex } = await import("../src/chain.ts");
  const a = await sha256Hex(canonicalizeTemplate("Three laws, lexically ordered."));
  const b = await sha256Hex(canonicalizeTemplate("Three laws, lexically ordered!"));
  assert.notEqual(a, b);
  const paramsA = await sha256Hex(serializeConstitutionParameters());
  const paramsB = await sha256Hex(JSON.stringify({ classes: [{ class: "entrenched", min_ballots: 5 }] }));
  assert.notEqual(paramsA, paramsB);
});

// ---------- policing: the [G1-1] honest-mistake guard (D-025's own figures, consolidated) ----------
//
// docs/BRIEF-FIRST-LAWS.md commit 5: "an invariant test asserting the
// deployed entrenched parameters equal D-025's figures exactly ... assert
// on the same exported constants the serialisation hashes." Every one of
// these facts is already covered individually elsewhere in this file (the
// quorum/floor table, the 3N passage edges, the window test, the tenure
// test) -- this test exists as its OWN, single, explicitly-labelled place
// a reviewer can check D-025's eight parameters against the deployed
// reality at a glance, not to re-derive coverage those tests already
// provide. A hostile deploy that edited an entrenched figure AND this
// test together would still defeat it (design doc §3's own honesty: "the
// build-time invariant test remains ... a guard against honest mistakes,
// not hostile operators") -- what catches THAT is the attested
// parameters_hash a citizen can independently recompute, not this test.
test("[G1-1] invariant: the deployed entrenched parameters equal D-025's eight ratified figures exactly", () => {
  // D-025 q1: passes when yes >= 3*no AND yes > 0 (75% integer form).
  assert.equal(tally("entrenched", 3, 1, 0, 1).status, "passed", "3:1 must pass (exactly 75%)");
  assert.equal(tally("entrenched", 2, 1, 1, 1).status, "failed", "2:1 must fail (below 75%)");
  // D-025 q2/[G1-4]: minimum ballots cast 4.
  assert.equal(CLASS_MIN_BALLOTS.entrenched, 4);
  // D-025 q3: quorum cast >= ceil(2*eligible/3).
  assert.equal(entrenchedQuorumThreshold(3), 2);
  assert.equal(entrenchedQuorumThreshold(6), 4);
  assert.equal(entrenchedQuorumThreshold(9), 6);
  // D-025 q4: voting window 14 days (the other classes keep 7).
  assert.equal(ENTRENCHED_VOTE_WINDOW_MS, 14 * 24 * 60 * 60 * 1000);
  assert.equal(voteWindowMs("entrenched"), ENTRENCHED_VOTE_WINDOW_MS);
  // Tenure gate: 14 days, same as constitutional, waived while invite_only
  // (TENURE_DAYS itself is module-private, so this asserts the EFFECTIVE
  // figure through assertEligible, the only way any caller ever observes
  // it -- the same boundary-testing idiom the dedicated tenure test above
  // already uses).
  const opened = 100 * 86_400_000;
  assert.doesNotThrow(() =>
    assertEligible(
      baseInput({ registrationMode: "open", voteClass: "entrenched", kind: "first_laws_ratify", citizenCreatedAt: opened - 14 * 86_400_000, proposalOpenedAt: opened }),
    ),
  );
  assert.throws(
    () =>
      assertEligible(
        baseInput({
          registrationMode: "open",
          voteClass: "entrenched",
          kind: "first_laws_ratify",
          citizenCreatedAt: opened - 14 * 86_400_000 + 1,
          proposalOpenedAt: opened,
        }),
      ),
    isForbidden,
  );
  // Both entrenched kinds actually carry this class (the parameters mean
  // nothing if the wrong kinds are attached to them).
  assert.equal(classOf("first_laws_ratify"), "entrenched");
  assert.equal(classOf("first_laws_amendment"), "entrenched");
});
