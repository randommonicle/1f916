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
const MAINTAINER_DIR = join(SRC, "maintainer");
const JUDGMENT_PATH = join(MAINTAINER_DIR, "judgment.ts");
const CLERK_PATH = join(MAINTAINER_DIR, "clerk.ts");
const CONCIERGE_PATH = join(MAINTAINER_DIR, "concierge.ts");

// Recursive .ts file walker -- this scan has to walk into subdirectories
// to see clerk.ts and judgment.ts at all. (This comment used to add that
// chain.test.ts's own scan was flat and predated src/maintainer/. True
// when written, stale now: chain.test.ts recurses, and as of 2026-08-23
// so does every policing scan in this directory. Do not read the old
// claim as a live gap in chain.test.ts -- the flat walk that actually
// mattered was register-gate.test.ts's, which went blind to seven
// modules until it was caught; see L-018.)
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

// M6, review fix: strips comments before any scan below runs. chain.test.ts's
// own lesson ("a bare-word scan trips on a comment that merely discusses
// a banned name") applies just as much to a comment that happens to
// contain SQL-keyword-shaped English prose -- "a full UPDATE of every
// column" reads, to a naive regex, exactly like "UPDATE of ...". Found
// this the hard way while building the SQL-table scan below: it initially
// flagged this very file's own explanatory comment in clerk.ts about
// finalizeMaintainerRun before being fixed to strip comments first.
function readSourceWithoutComments(path: string): string {
  const text = readFileSync(path, "utf8");
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

// Moderation-executing / money-moving exports no file under src/maintainer/
// may call, EXCEPT judgment.ts -- the one module the design doc's cage
// (S3, point 1) grants a path to moderateContent/createPost at all,
// because it is where the judge's approvals are executed. Call-expression-
// shaped (name + optional whitespace + "(") deliberately, not a bare
// substring: chain.test.ts's own history (d1ab81e) shows a bare-word scan
// trips on a comment that merely discusses the function by name.
const BANNED_CALLS = ["moderateContent", "recordPayout", "recordLedger", "setPinned", "rotateKey", "correctModel", "createPost"];
const BANNED_MODULE_IMPORTS = ["payouts", "wallets"];

// M6(a), review fix: previously this scan only ever read clerk.ts, so a
// banned call added to anthropic.ts, runs.ts, or schedule.ts -- any file
// under src/maintainer/ other than clerk.ts -- would have gone entirely
// unchecked. Now walks every file in the directory except judgment.ts.
test("no file under src/maintainer/, except judgment.ts, calls a moderation-executing or money-moving export", () => {
  const offenders: string[] = [];
  for (const file of walkTsFiles(MAINTAINER_DIR)) {
    if (file === JUDGMENT_PATH) continue;
    const text = readSourceWithoutComments(file);
    for (const name of BANNED_CALLS) {
      const pattern = new RegExp(`\\b${name}\\s*\\(`);
      if (pattern.test(text)) offenders.push(`${file} calls ${name}(...)`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "Only judgment.ts executes maintainer power (design doc S3, point 1) -- a call to any of these anywhere else in src/maintainer/ is a second, unreviewed executor.",
  );
});

// Positive control for the scan above: if judgment.ts stopped calling
// these (a refactor routed execution through some new wrapper, say), the
// test above would still pass, but vacuously -- for the wrong reason
// ("nobody calls it", not "only the right file does").
test("judgment.ts itself does call moderateContent and createPost (the positive control for the test above)", () => {
  const text = readSourceWithoutComments(JUDGMENT_PATH);
  assert.match(text, /\bmoderateContent\s*\(/);
  assert.match(text, /\bcreatePost\s*\(/);
});

// M6(c), review fix: this test's own assertion message used to claim "the
// clerk has no import path to payouts OR MODERATION EXECUTORS -- that IS
// the cage" -- false as a description of what THIS test verifies. It only
// matches `from "...payouts..."` / `from "...wallets..."` module-specifier
// patterns; moderateContent/createPost are imported from society.ts, which
// was never in BANNED_MODULE_IMPORTS, so this test provides zero coverage
// against clerk.ts importing them. That guarantee is enforced separately,
// by the BANNED_CALLS scan above (which matches the call itself, not the
// import it arrived through) and the SQL-table scan below (which matches
// the write itself). The real combined guarantee across this file is no
// call and no write, of which "no import path" is only ever a narrower,
// earlier-warning signal for the money-moving modules specifically.
test("clerk.ts imports nothing from payouts.ts or wallets.ts", () => {
  const text = readSourceWithoutComments(CLERK_PATH);
  const offenders: string[] = [];
  for (const mod of BANNED_MODULE_IMPORTS) {
    const pattern = new RegExp(`from\\s*["'][^"']*\\b${mod}\\b[^"']*["']`);
    if (pattern.test(text)) offenders.push(`clerk.ts imports from a module matching "${mod}"`);
  }
  assert.deepEqual(
    offenders,
    [],
    "clerk.ts has no import path to the money-moving modules payouts.ts/wallets.ts (design doc S3, point 1). This is one narrow signal among several -- the actual cage is no call (BANNED_CALLS scan above) and no write (SQL-table scan below), not merely no import.",
  );
});

// M6(b), review fix: a second write path is exactly as dangerous as a
// second call path -- a hijacked or fooled clerk that has no CALL to
// moderateContent could still, in principle, reach around the entire
// executor layer with a raw SQL statement against some other table
// entirely. clerk.ts may write (INSERT/UPDATE/DELETE/REPLACE) only its
// own two operational tables.
const ALLOWED_WRITE_TABLES = ["maintainer_queue", "maintainer_runs"];

test("clerk.ts's SQL write statements reference only maintainer_queue or maintainer_runs", () => {
  const text = readSourceWithoutComments(CLERK_PATH);
  const pattern = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\s+(\w+)/gi;
  const offenders: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    const [, verb, table] = m;
    if (!ALLOWED_WRITE_TABLES.includes(table)) {
      offenders.push(`clerk.ts writes to table "${table}" via "${verb.replace(/\s+/g, " ")} ${table}"`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "clerk.ts may write to maintainer_queue/maintainer_runs only -- any other table name in a write statement is a second, unreviewed write path outside the cage.",
  );
});

// Positive control for the scan above: proves it is not vacuously true
// because clerk.ts happens to contain no SQL writes at all.
test("clerk.ts itself does write SQL to maintainer_queue (the positive control for the test above)", () => {
  const text = readSourceWithoutComments(CLERK_PATH);
  assert.match(text, /INSERT\s+INTO\s+maintainer_queue/i);
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
  const pattern = /UPDATE\s+maintainer_queue\b/i;
  const offenders: string[] = [];
  for (const file of walkTsFiles(SRC)) {
    if (file === JUDGMENT_PATH) continue;
    const text = readSourceWithoutComments(file);
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
  const text = readSourceWithoutComments(JUDGMENT_PATH);
  assert.match(text, /UPDATE\s+maintainer_queue\b/i);
});

// M6(e), review fix: stated plainly, not left implicit. What these
// source-scans CANNOT catch: an aliased import (`import { moderateContent
// as mc } from "../society.ts"`, then calling `mc(...)`), computed or
// bracket property access (`society["moderateContent"](...)`), a table
// name built from a template literal or string concatenation rather than
// written as a literal identifier, or a call reached through some
// intermediate re-exporting module this walk never visits. None of these
// evasions exist anywhere in this codebase today, and a scan this cheap
// and fast earns its keep as a tripwire against the ORDINARY way a
// mistake gets introduced -- a straightforward call, a straightforward
// SQL string -- but it is not a sound static analysis and was never meant
// to be one. The real boundary is structural: the import graph (what
// clerk.ts can physically reach at all) plus code review at merge time,
// exactly as this file's own opening line already frames it -- these
// tests are "enforced by a source-scan policing test", not "proven by"
// one.

// ============================================================================
// The engagement concierge's own cage (docs/DESIGN-CONCIERGE.md §4.3): a
// dedicated, narrower scan for concierge.ts specifically, alongside (not
// instead of) the generic MAINTAINER_DIR scans above, which already sweep
// concierge.ts (it lives in src/maintainer/, so the "no file... except
// judgment.ts" test above already covers it against the 7-name BANNED_CALLS
// list). This section is stricter: it also names castVote and flagContent,
// never checked anywhere in this file before concierge.ts existed, because
// neither clerk.ts nor judgment.ts ever had reason to touch voting or
// flagging -- but "never manufactures consensus on proposals" and "never
// votes" are named hard constraints for THIS feature specifically (design
// doc §3, §4.3), so they are checked explicitly here rather than left to
// the generic list's silence on them.
// ============================================================================

const CONCIERGE_BANNED_CALLS = [...BANNED_CALLS, "castVote", "flagContent"];

test("concierge.ts calls createComment and nothing else from the (widened) banned-call list -- no moderation, no money movement, no voting, no flagging", () => {
  const text = readSourceWithoutComments(CONCIERGE_PATH);
  const offenders: string[] = [];
  for (const name of CONCIERGE_BANNED_CALLS) {
    const pattern = new RegExp(`\\b${name}\\s*\\(`);
    if (pattern.test(text)) offenders.push(`concierge.ts calls ${name}(...)`);
  }
  assert.deepEqual(
    offenders,
    [],
    "concierge.ts's only write-capable import from society.ts is createComment (design doc §4.3) -- a call to any of these is either the clerk/judge cage breached, or the concierge casting a vote / flagging content, neither of which this feature is permitted to do.",
  );
});

// Positive control: if concierge.ts stopped calling createComment (a
// refactor routed it through some new wrapper, say), the test above would
// still pass, but vacuously -- for the wrong reason ("nobody calls
// anything banned", not "it calls exactly the one sanctioned thing").
test("concierge.ts itself does call createComment (the positive control for the test above)", () => {
  const text = readSourceWithoutComments(CONCIERGE_PATH);
  assert.match(text, /\bcreateComment\s*\(/);
});

const CONCIERGE_ALLOWED_WRITE_TABLES = ["concierge_runs"];

test("concierge.ts's own SQL write statements reference only concierge_runs", () => {
  const text = readSourceWithoutComments(CONCIERGE_PATH);
  const pattern = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|REPLACE\s+INTO)\s+(\w+)/gi;
  const offenders: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    const [, verb, table] = m;
    if (!CONCIERGE_ALLOWED_WRITE_TABLES.includes(table)) {
      offenders.push(`concierge.ts writes to table "${table}" via "${verb.replace(/\s+/g, " ")} ${table}"`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "concierge.ts may write to concierge_runs only -- comments/identity_events are written through createComment/appendChained, never a raw SQL statement in this file, and any other table name here is a second, unreviewed write path.",
  );
});

// Positive control: proves the scan above is not vacuously true because
// concierge.ts happens to contain no SQL writes at all.
test("concierge.ts itself does write SQL to concierge_runs (the positive control for the test above)", () => {
  const text = readSourceWithoutComments(CONCIERGE_PATH);
  assert.match(text, /INSERT\s+INTO\s+concierge_runs/i);
});

const SHOWHOME_TABLES = ["visitors", "showhome_notes", "showhome_rate", "showhome_replies"];

// D-043's own invariant ("no paid cognition ever reads visitor content"),
// extended to the concierge -- the one new piece of paid cognition this
// feature adds. A string-level scan, not merely an SQL-verb scan: this
// must catch ANY mention (a JOIN, a comment referencing the table by name
// well enough to matter, a stray reference), not only a literal
// FROM/INTO/JOIN clause -- readSourceWithoutComments has already stripped
// real comments, so what remains is code text only.
test("concierge.ts contains no reference to any showhome table (visitors, showhome_notes, showhome_rate, showhome_replies) anywhere in its source", () => {
  const text = readSourceWithoutComments(CONCIERGE_PATH);
  const offenders: string[] = [];
  for (const table of SHOWHOME_TABLES) {
    if (new RegExp(`\\b${table}\\b`).test(text)) offenders.push(table);
  }
  assert.deepEqual(
    offenders,
    [],
    "concierge.ts's detection queries read only posts, comments, and proposals (to exclude governance threads) -- any mention of a showhome table would be new, unreviewed paid cognition over visitor content, exactly what D-043 forecloses.",
  );
});

// Positive control: the SAME string-level mechanism, pointed at a file that
// legitimately DOES reference a showhome table, to prove the regex itself
// can see a real match rather than being silently broken (e.g. a typo'd
// table name that could never match anything).
test("positive control: the same reference-scan mechanism finds a real showhome-table mention (src/showhome.ts itself)", () => {
  const showhomeSrc = readSourceWithoutComments(join(SRC, "showhome.ts"));
  const found = SHOWHOME_TABLES.some((table) => new RegExp(`\\b${table}\\b`).test(showhomeSrc));
  assert.ok(found, "the mechanism must be able to see a real showhome-table reference -- src/showhome.ts legitimately mentions its own tables");
});

test("concierge.ts imports nothing from governance.ts -- no code path to a proposal, ballot, or tally", () => {
  const text = readSourceWithoutComments(CONCIERGE_PATH);
  assert.doesNotMatch(
    text,
    /from\s*["'][^"']*\bgovernance\b[^"']*["']/,
    "'never manufactures consensus on proposals' is enforced by having no code path to a vote at all, not by prompting the model not to vote -- any import from governance.ts would reopen that path.",
  );
});

// Positive control: the same import-specifier pattern used above DOES match
// a real governance.ts import elsewhere in this codebase (clerk.ts itself),
// proving the regex is not simply incapable of matching anything.
test("positive control: the same import-specifier pattern finds a real governance.ts import (clerk.ts itself imports from it)", () => {
  const clerkText = readSourceWithoutComments(CLERK_PATH);
  assert.match(clerkText, /from\s*["'][^"']*\bgovernance\b[^"']*["']/, "clerk.ts legitimately imports detectConstitutionChange/reconcileConstitutionFidelityQueue from ../governance.ts");
});
