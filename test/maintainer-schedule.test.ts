// Tests for the maintainer's cron-string dispatch.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { CLERK_CRON, JUDGMENT_CRON, LOOP_CRON, classifyCron } from "../src/maintainer/schedule.ts";

test("the clerk cron string classifies as clerk", () => {
  assert.equal(classifyCron(CLERK_CRON), "clerk");
});

test("the judgment cron string classifies as judgment", () => {
  assert.equal(classifyCron(JUDGMENT_CRON), "judgment");
});

test("the loop cron string classifies as loop, and is 12:00 UTC daily", () => {
  assert.equal(classifyCron(LOOP_CRON), "loop");
  assert.equal(LOOP_CRON, "0 12 * * *");
});

test("the three cron strings are distinct", () => {
  assert.equal(new Set([CLERK_CRON, JUDGMENT_CRON, LOOP_CRON]).size, 3);
});

test("an unrecognised cron string classifies as null, not a throw", () => {
  assert.equal(classifyCron("* * * * *"), null);
  assert.equal(classifyCron(""), null);
  assert.equal(classifyCron("0 6 * * 1"), null); // close to CLERK_CRON but not it
  assert.equal(classifyCron("0 12 * * 1"), null); // close to LOOP_CRON but not it
});

test("classifyCron is exact-match, not a prefix or substring match", () => {
  assert.equal(classifyCron(CLERK_CRON + " "), null);
  assert.equal(classifyCron("x" + JUDGMENT_CRON), null);
  assert.equal(classifyCron(LOOP_CRON + " "), null);
  assert.equal(classifyCron("x" + LOOP_CRON), null);
});
