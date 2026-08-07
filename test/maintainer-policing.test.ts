// Policing tests for the maintainer runtime's cage (design doc S3, S10).
// Mirrors chain.test.ts's "nothing outside chain.ts writes to a chained
// table directly" and register-gate.test.ts's "register() is called only
// from register-gate.ts" pattern exactly: a source-level scan of the real
// files, not a fixture.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dirname, "..", "src");

// Recursive .ts file walker -- chain.test.ts's own scan predates
// src/maintainer/ and is a flat readdirSync; this one has to walk into
// subdirectories to see clerk.ts and judgment.ts at all.
function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walkTsFiles(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

const CLERK_PATH = join(SRC, "maintainer", "clerk.ts");

// Moderation-executing / money-moving exports the clerk must have no path
// to at all. Call-expression-shaped (name + optional whitespace + "(")
// deliberately, not a bare substring: chain.test.ts's own history
// (d1ab81e) shows a bare-word scan trips on a comment that merely
// discusses the function by name, and this file's own header comment does
// exactly that ("...to recordLedger/register/rotateKey regardless of what
// a queue row says").
const BANNED_CALLS = ["moderateContent", "recordPayout", "recordLedger", "setPinned", "rotateKey", "correctModel", "createPost"];
const BANNED_MODULE_IMPORTS = ["payouts", "wallets"];

test("clerk.ts calls no moderation-executing or money-moving export", () => {
  const text = readFileSync(CLERK_PATH, "utf8");
  const offenders: string[] = [];
  for (const name of BANNED_CALLS) {
    const pattern = new RegExp(`\\b${name}\\s*\\(`);
    if (pattern.test(text)) offenders.push(`clerk.ts calls ${name}(...)`);
  }
  assert.deepEqual(offenders, [], "The clerk drafts, it never disposes -- see design doc S3/S10. A call to any of these belongs in judgment.ts, never here.");
});

test("clerk.ts imports nothing from payouts.ts or wallets.ts", () => {
  const text = readFileSync(CLERK_PATH, "utf8");
  const offenders: string[] = [];
  for (const mod of BANNED_MODULE_IMPORTS) {
    const pattern = new RegExp(`from\\s*["'][^"']*\\b${mod}\\b[^"']*["']`);
    if (pattern.test(text)) offenders.push(`clerk.ts imports from a module matching "${mod}"`);
  }
  assert.deepEqual(offenders, [], "The clerk has no import path to payouts or moderation executors -- that IS the cage (design doc S3, point 1).");
});

// A chained table with two ways to write to it grows an unsealed writer
// (chain.test.ts's own lesson). The equivalent hazard here is a second
// path that stamps maintainer_queue's status/decided_at/decided_reason:
// judgment.ts is the ONLY place that may transition a queue row out of
// 'pending', because that transition is what "the judge reviewed this" is
// supposed to mean. clerk.ts INSERTs new pending rows, which is fine and
// expected -- only UPDATE (a status transition on an existing row) is
// policed here.
test("no file except judgment.ts writes a maintainer_queue status transition (UPDATE)", () => {
  const judgmentPath = join(SRC, "maintainer", "judgment.ts");
  const pattern = /UPDATE\s+maintainer_queue\b/i;
  const offenders: string[] = [];
  for (const file of walkTsFiles(SRC)) {
    if (file === judgmentPath) continue;
    const text = readFileSync(file, "utf8");
    if (pattern.test(text)) offenders.push(file);
  }
  assert.deepEqual(
    offenders,
    [],
    "maintainer_queue status transitions (approved/rejected, decided_at, decided_reason) happen only in judgment.ts's stampQueueRow. A second writer is a silent second judge.",
  );
});

// Sanity check that judgment.ts really is where the transition lives --
// if this ever goes red, the test above is vacuously true for the wrong
// reason (nobody writes the UPDATE at all, not "only the right file does").
test("judgment.ts itself does contain the maintainer_queue UPDATE (the positive control for the test above)", () => {
  const text = readFileSync(join(SRC, "maintainer", "judgment.ts"), "utf8");
  assert.match(text, /UPDATE\s+maintainer_queue\b/i);
});
