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
  CLASS_MIN_BALLOTS,
  DEFAULT_NAME,
  DEFAULT_CONTROL_FLOOR_PERCENT,
  quorumThreshold,
  tally,
  validatePayload,
  assertEligible,
  countEligible,
  monthsFromNow,
  type ProposalKind,
  type EligibilityInput,
} from "../src/governance.ts";
import { SocietyError } from "../src/society.ts";

const isBadRequest = (e: unknown) => e instanceof SocietyError && e.status === 400;
const isForbidden = (e: unknown) => e instanceof SocietyError && e.status === 403;

// ---------- vote classes ----------

test("every one of the 9 proposal kinds has exactly the class design doc §3 names", () => {
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
  };
  for (const kind of PROPOSAL_KINDS) {
    assert.equal(classOf(kind), expected[kind], `${kind} should be ${expected[kind]}`);
  }
  assert.equal(PROPOSAL_KINDS.length, 9);
  assert.equal(Object.keys(KIND_CLASS).length, 9);
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

test("CLASS_MIN_BALLOTS matches design doc §3's table (3/2/1)", () => {
  assert.deepEqual(CLASS_MIN_BALLOTS, { constitutional: 3, parameter: 2, advisory: 1 });
});

test("defaults match doc.ts's published starting values", () => {
  assert.equal(DEFAULT_NAME, "Commonhold");
  assert.equal(DEFAULT_CONTROL_FLOOR_PERCENT, 51);
});

// Drift guard: the application's closed kind list and the migration's CHECK
// constraint must name exactly the same 9 kinds, or the DB backstop and the
// app allowlist silently diverge -- the exact failure mode
// DEMOCRACY-SURFACE.md §8 gotcha 10 already found once in this codebase
// (GET /api/events's stale kinds list).
test("PROPOSAL_KINDS matches the CHECK constraint in migrations/0005_governance.sql exactly", () => {
  const migrationPath = join(import.meta.dirname, "..", "migrations", "0005_governance.sql");
  const text = readFileSync(migrationPath, "utf8");
  const match = text.match(/CREATE TABLE IF NOT EXISTS proposals[\s\S]*?kind\s+TEXT NOT NULL CHECK \(kind IN \(([^)]+)\)\)/);
  assert.ok(match, "could not find the proposals.kind CHECK constraint in the migration file");
  const inMigration = match[1]
    .split(",")
    .map((s) => s.trim().replace(/^'|'$/g, ""))
    .sort();
  const inCode = [...PROPOSAL_KINDS].sort();
  assert.deepEqual(inMigration, inCode);
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

test("validatePayload: the five {body only} kinds accept a null/absent payload and reject a structured one", () => {
  const bodyOnly: ProposalKind[] = ["handler_arrangement", "buyout_terms", "official_token", "text_amendment", "resolution"];
  for (const kind of bodyOnly) {
    assert.equal(validatePayload(kind, null, ctx), null);
    assert.equal(validatePayload(kind, undefined, ctx), null);
    assert.throws(() => validatePayload(kind, { anything: true }, ctx), isBadRequest, `${kind} should refuse a structured payload`);
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

test("monthsFromNow: a month-end source date can overflow into the following month (documented JS Date behaviour, not a governance rule)", () => {
  // Jan 31 + 1 month: February has no 31st, so JS Date's setUTCMonth
  // overflows into early March rather than clamping to Feb 28/29. Named
  // and pinned here so this is a known, tested behaviour rather than a
  // silent surprise the first time a dividend-uplift proposal happens to
  // pass on the 31st of a month.
  const jan31 = Date.UTC(2026, 0, 31);
  const result = monthsFromNow(jan31, 1);
  const d = new Date(result);
  assert.equal(d.getUTCMonth(), 2, "overflows into March (month index 2), does not clamp to the end of February");
});
