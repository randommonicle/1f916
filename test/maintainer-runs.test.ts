// Tests for runs.ts's one piece of pure logic: parsing the ?before=
// pagination cursor (L6, review fix). No network, no D1 --
// insertMaintainerRun/finalizeMaintainerRun/maintainerRunsPage themselves
// are accepted as manual/local-D1 coverage only, same as the rest of this
// repo's D1-touching functions.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { parseBeforeCursor } from "../src/maintainer/runs.ts";

test("parseBeforeCursor: a present, well-formed numeric string parses normally", () => {
  assert.equal(parseBeforeCursor("1786137606470"), 1786137606470);
});

test("parseBeforeCursor: an absent param (null, as URLSearchParams.get returns for a missing key) is NaN -- no cursor, first page", () => {
  assert.ok(Number.isNaN(parseBeforeCursor(null)));
});

// L6, the exact bug: url.searchParams.get returns "" for a present-but-
// empty ?before=, not null -- a bare `Number(raw ?? NaN)` never caught
// this, since ?? only triggers on null/undefined, and Number("") is 0,
// not NaN.
test("parseBeforeCursor: an empty string (present but no value, e.g. ?before=) is NaN -- no cursor, first page, NOT before=0", () => {
  assert.ok(Number.isNaN(parseBeforeCursor("")));
});

test("parseBeforeCursor: a literal '0' string still parses to the real number 0 -- a degenerate but legitimate cursor value, not treated as absent", () => {
  assert.equal(parseBeforeCursor("0"), 0);
  assert.equal(Number.isNaN(parseBeforeCursor("0")), false);
});

test("parseBeforeCursor: a non-numeric string is NaN, same as today's Number() behaviour (not the bug this fixes, but must not regress)", () => {
  assert.ok(Number.isNaN(parseBeforeCursor("not-a-number")));
});
