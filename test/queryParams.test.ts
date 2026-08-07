// Tests for the shared query-string number parser (follow-up review fix,
// generalising L6's parseBeforeCursor to the four other call sites that
// shared its exact bug shape: an empty-but-present query param slipping
// past `?? fallback` because URLSearchParams.get returns "" for it, not
// null). No network, no D1.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { parseNumberParam } from "../src/queryParams.ts";

// ---------- the ?limit shape (fallback 30, e.g. /api/front, /api/new) ----------

test("parseNumberParam: a present, well-formed numeric string parses normally (limit shape)", () => {
  assert.equal(parseNumberParam("15", 30), 15);
});

test("parseNumberParam: an absent param (null) returns the fallback (limit shape)", () => {
  assert.equal(parseNumberParam(null, 30), 30);
});

// The exact bug: url.searchParams.get returns "" for a present-but-empty
// param, not null -- the old `Number(raw ?? 30)` never caught it, since
// ?? only triggers on null/undefined, and Number("") is 0, not 30.
test("parseNumberParam: an empty string (present but no value, e.g. ?limit=) returns the fallback, NOT 0 (limit shape)", () => {
  assert.equal(parseNumberParam("", 30), 30);
});

// ---------- the ?since shape (fallback NaN, e.g. /api/changes, /api/citizens) ----------

test("parseNumberParam: a present, well-formed numeric string parses normally (since shape)", () => {
  assert.equal(parseNumberParam("1786137606470", NaN), 1786137606470);
});

test("parseNumberParam: an absent param (null) returns NaN (since shape)", () => {
  assert.ok(Number.isNaN(parseNumberParam(null, NaN)));
});

test("parseNumberParam: an empty string returns NaN, NOT 0 (since shape) -- the exact bug this fixes", () => {
  assert.ok(Number.isNaN(parseNumberParam("", NaN)));
});

// ---------- shape-independent edge cases ----------

test("parseNumberParam: a literal '0' string still parses to the real number 0 -- a legitimate value, not treated as absent", () => {
  assert.equal(parseNumberParam("0", 30), 0);
  assert.equal(Number.isNaN(parseNumberParam("0", NaN)), false);
  assert.equal(parseNumberParam("0", NaN), 0);
});

test("parseNumberParam: a non-numeric string is NaN, same as plain Number() -- not the bug this fixes, must not regress", () => {
  assert.ok(Number.isNaN(parseNumberParam("not-a-number", 30)));
});
