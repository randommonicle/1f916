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
  type ProposalKind,
  type EligibilityInput,
} from "../src/governance.ts";
import { ALLOWED_QUEUE_KINDS } from "../src/maintainer/clerk.ts";
import { SocietyError } from "../src/society.ts";

const isBadRequest = (e: unknown) => e instanceof SocietyError && e.status === 400;
const isForbidden = (e: unknown) => e instanceof SocietyError && e.status === 403;

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

test("governance.ts never references MAINTAINER_ID -- the maintainer's ballot holds no tie-break or veto (design doc §4)", () => {
  const text = readFileSync(join(import.meta.dirname, "..", "src", "governance.ts"), "utf8");
  assert.doesNotMatch(text, /MAINTAINER_ID/);
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

const ctx = { currentName: "Commonhold", currentControlFloorPercent: 51 };

test("validatePayload: set_name accepts 3-40 printable ASCII chars, rejects outside the boundary", () => {
  assert.deepEqual(validatePayload("set_name", { name: "Hallmoot" }, ctx), { name: "Hallmoot" });
  assert.deepEqual(validatePayload("set_name", { name: "abc" }, ctx), { name: "abc" }); // 3 chars, lower boundary
  assert.throws(() => validatePayload("set_name", { name: "ab" }, ctx), isBadRequest); // 2 chars
  assert.deepEqual(validatePayload("set_name", { name: "a".repeat(40) }, ctx), { name: "a".repeat(40) }); // 40 chars, upper boundary
  assert.throws(() => validatePayload("set_name", { name: "a".repeat(41) }, ctx), isBadRequest); // 41 chars
  assert.throws(() => validatePayload("set_name", { name: "tab\ttab" }, ctx), isBadRequest); // non-printable
  assert.throws(() => validatePayload("set_name", { name: "Commonhold" }, ctx), isBadRequest); // equals current
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
  const higherCtx = { currentName: "Commonhold", currentControlFloorPercent: 70 };
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

test("assertEligible: founding carve-out blocks a non-founder on set_name/text_amendment while unratified", () => {
  for (const kind of ["set_name", "text_amendment"] as const) {
    assert.throws(
      () => assertEligible(baseInput({ kind, voteClass: "constitutional", foundingRatified: false, isFounder: false, registrationMode: "invite_only" })),
      isForbidden,
    );
    assert.doesNotThrow(() =>
      assertEligible(baseInput({ kind, voteClass: "constitutional", foundingRatified: false, isFounder: true, registrationMode: "invite_only" })),
    );
  }
});

test("assertEligible: founding carve-out does not extend to other constitutional kinds", () => {
  // official_token is constitutional but not in the founding-gated list --
  // a non-founder must be eligible here even while founding is unratified,
  // proving the carve-out is scoped to exactly set_name/text_amendment.
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
