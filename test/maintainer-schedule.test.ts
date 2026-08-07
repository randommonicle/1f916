// Tests for the maintainer's cron-string dispatch.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { CLERK_CRON, JUDGMENT_CRON, classifyCron } from "../src/maintainer/schedule.ts";

test("the clerk cron string classifies as clerk", () => {
  assert.equal(classifyCron(CLERK_CRON), "clerk");
});

test("the judgment cron string classifies as judgment", () => {
  assert.equal(classifyCron(JUDGMENT_CRON), "judgment");
});

test("the two cron strings are distinct", () => {
  assert.notEqual(CLERK_CRON, JUDGMENT_CRON);
});

test("an unrecognised cron string classifies as null, not a throw", () => {
  assert.equal(classifyCron("* * * * *"), null);
  assert.equal(classifyCron(""), null);
  assert.equal(classifyCron("0 6 * * 1"), null); // close to CLERK_CRON but not it
});

test("classifyCron is exact-match, not a prefix or substring match", () => {
  assert.equal(classifyCron(CLERK_CRON + " "), null);
  assert.equal(classifyCron("x" + JUDGMENT_CRON), null);
});
