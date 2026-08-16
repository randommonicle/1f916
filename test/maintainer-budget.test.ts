// The §9 (D-041) shared subrequest-budget cost table, proven at its exact
// boundaries (docs/BRIEF-JUDGMENT-QUERY-BUDGET.md). These are pure arithmetic
// pins: every assertion fixes an exact output, so a drift in any constant
// moves a boundary and reddens a test. The invocation-level enforcement (the
// counter throwing at 51) lives in test/maintainer-scheduled-budget.test.ts;
// this file pins the arithmetic those proofs rely on.
//
// Run just this file: node --experimental-strip-types --test "test/maintainer-budget.test.ts"

import test from "node:test";
import assert from "node:assert/strict";
import { INVOCATION_SUBREQUEST_BUDGET, estimateSweepCost, canOpenJudgmentBatch, affordableClerkInserts } from "../src/maintainer/budget.ts";
import { CLERK_QUEUE_CAP } from "../src/maintainer/clerk.ts";

test("the invocation budget is the Free-plan ceiling of 50 subrequests", () => {
  assert.equal(INVOCATION_SUBREQUEST_BUDGET, 50);
});

test("estimateSweepCost: base 3 at zero due, +9 per processed due proposal (the conservative per-proposal price)", () => {
  assert.equal(estimateSweepCost(0), 3);
  assert.equal(estimateSweepCost(1), 12);
  assert.equal(estimateSweepCost(2), 21);
});

test("canOpenJudgmentBatch: a quiet invocation (zero-due sweep, no replay) can open all four batches", () => {
  const priorCost = estimateSweepCost(0); // 3
  assert.equal(canOpenJudgmentBatch(priorCost, 0, 0), true, "batch 1");
  assert.equal(canOpenJudgmentBatch(priorCost, 0, 1), true, "batch 2");
  assert.equal(canOpenJudgmentBatch(priorCost, 0, 2), true, "batch 3");
  assert.equal(canOpenJudgmentBatch(priorCost, 0, 3), true, "batch 4 -- the JUDGMENT_MAX_BATCHES ceiling, still affordable when nothing else ran");
});

test("canOpenJudgmentBatch: the D-041 COMPOUND worst case (2-due sweep + 3 replay rows) sheds even the FIRST batch", () => {
  // 21 (sweep) + 6 (wake fixed) + 18 (3 replay x 6) = 45 already spent; a batch
  // (8) + finalise reserve (2) = 55 > 50. This is the exact case §9 exists for:
  // the seams coincide and the invocation must shed, loudly, before starting.
  assert.equal(canOpenJudgmentBatch(estimateSweepCost(2), 3, 0), false);
});

test("canOpenJudgmentBatch: a one-due sweep with no replay opens 3 batches then sheds the 4th", () => {
  const priorCost = estimateSweepCost(1); // 12
  assert.equal(canOpenJudgmentBatch(priorCost, 0, 0), true);
  assert.equal(canOpenJudgmentBatch(priorCost, 0, 1), true);
  assert.equal(canOpenJudgmentBatch(priorCost, 0, 2), true, "3rd batch: 12+6+16+8+2=44 <= 50");
  assert.equal(canOpenJudgmentBatch(priorCost, 0, 3), false, "4th batch: 12+6+24+8+2=52 > 50 -- shed");
});

test("affordableClerkInserts: near the ceiling on a quiet sweep, shrinking as the sweep gets busier, never negative, never above the ceiling", () => {
  // 50 - priorCost - 18 (clerk fixed) - 2 (reserve).
  assert.equal(affordableClerkInserts(estimateSweepCost(0), CLERK_QUEUE_CAP), 27, "quiet sweep: 50-3-18-2 = 27, under the 50 ceiling");
  assert.equal(affordableClerkInserts(estimateSweepCost(2), CLERK_QUEUE_CAP), 9, "busy sweep: 50-21-18-2 = 9");
  assert.equal(affordableClerkInserts(estimateSweepCost(0), 5), 5, "never above the supplied ceiling");
  assert.equal(affordableClerkInserts(60, CLERK_QUEUE_CAP), 0, "never negative when the prior cost already blows the budget");
});
