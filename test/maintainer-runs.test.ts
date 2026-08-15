// Tests for runs.ts's pure logic: parsing the ?before= pagination cursor
// (L6, review fix) and the NaN guard applied before every numeric field
// is bound (L8, review fix). No network, no D1 --
// insertMaintainerRun/finalizeMaintainerRun/maintainerRunsPage themselves
// are accepted as manual/local-D1 coverage only, same as the rest of this
// repo's D1-touching functions.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseBeforeCursor, finiteOrNull } from "../src/maintainer/runs.ts";

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

// ---------- finiteOrNull: the NaN guard before binding (L8) ----------

test("finiteOrNull passes an ordinary finite number through unchanged", () => {
  assert.equal(finiteOrNull(500), 500);
  assert.equal(finiteOrNull(0), 0);
  assert.equal(finiteOrNull(-12), -12);
});

test("finiteOrNull passes null and undefined through as null, unchanged", () => {
  assert.equal(finiteOrNull(null), null);
  assert.equal(finiteOrNull(undefined), null);
});

test("finiteOrNull coerces NaN to null -- NaN has no SQLite representation", () => {
  assert.equal(finiteOrNull(NaN), null);
});

test("finiteOrNull coerces Infinity and -Infinity to null", () => {
  assert.equal(finiteOrNull(Infinity), null);
  assert.equal(finiteOrNull(-Infinity), null);
});

// ---------- D-035 (docs/BRIEF-FIRST-LAWS-FIXES.md item 4, gate finding
// L-7): the served note's honesty, and the FORWARD marker for the real
// fix (option C). maintainerRunsPage's own `note` string is a hardcoded
// literal, not derived from any D1 state -- this file's own header
// already accepts maintainerRunsPage itself as manual/local-D1 coverage
// only -- so its CONTENT is tested here as static source text, the same
// technique register-gate.test.ts's own "register() is called only from
// register-gate.ts" policing test uses, rather than standing up a D1
// harness this file has never otherwise needed. ----------

function readRunsSource(): string {
  return readFileSync(join(import.meta.dirname, "..", "src", "maintainer", "runs.ts"), "utf8");
}

test("runs.ts's served note honestly describes error as carrying BOTH unresolved faults and designed fail-closed outcomes, not only faults (D-035 option B)", () => {
  const src = readRunsSource();
  const noteMatch = /note:\s*\n?\s*"([^"]*)"/.exec(src);
  assert.ok(noteMatch, "could not find the served note string literal in runs.ts");
  const note = noteMatch![1];

  assert.match(note, /error/, "the note must still describe the error field");
  assert.match(
    note,
    /designed|fail.?closed/i,
    "the note must name a designed/fail-closed outcome as part of what error carries, not only unresolved faults -- the D-018 gate's L-7 finding",
  );
  assert.match(
    note,
    /withh|scan.?limit/i,
    "the note should point at the concrete example outcomes (an evidence withhold, a scan-limit line), not only an abstract claim",
  );
  assert.doesNotMatch(
    note,
    /error is set when a wake, or its reconciliation pass, hit something it could not resolve on its own; it still wrote this row rather than failing silently\./,
    "the pre-fix sentence, verbatim, must be gone -- it is the exact misdescription D-035 rules on",
  );
});

test("runs.ts plants a grep-able FORWARD(D-035) marker beside error's use, naming the real fix (a separate designed-outcomes column) and that it waits on the next migration -- a deferral with no marker is a deferral that disappears", () => {
  const src = readRunsSource();
  assert.match(src, /FORWARD\(D-035\)/, "the FORWARD(D-035) marker must be present, grep-able, beside the error column's use");

  const markerIdx = src.indexOf("FORWARD(D-035)");
  const markerContext = src.slice(markerIdx, markerIdx + 400);
  assert.match(markerContext, /column/i, "the marker must say the real fix is a separate designed-outcomes column");
  assert.match(markerContext, /migration/i, "the marker must say the real fix waits on the next migration");
});
