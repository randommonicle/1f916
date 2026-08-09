// Policing test for the two non-chained governance tables (design doc
// §13 item 5: "tests policing that governance tables are written only
// from governance.ts"). ballots' own write-protection already exists --
// it is chained, and chain.test.ts's offender scan (extended in commit 1
// to include "ballots") already proves nothing outside chain.ts writes to
// it directly. proposals and governance_settings are plain tables with no
// such protection from chain.ts, so this is their equivalent: a
// source-level scan of the real files, in the register-gate.test.ts /
// chain.test.ts / maintainer-policing.test.ts style, recursing into
// subdirectories (maintainer-policing.test.ts's own fix over
// chain.test.ts's flat readdirSync, which predates src/maintainer/ and
// would silently miss anything written there).
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dirname, "..", "src");
const GOVERNANCE_PATH = join(SRC, "governance.ts");
const GOVERNANCE_TABLES = ["proposals", "governance_settings"];

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

// Strips comments before scanning (maintainer-policing.test.ts's own
// lesson, re-learned directly while building this arc: commit 2's
// governance.ts policing test tripped on its OWN header comment, which
// named the very identifier it was checking the absence of, in prose).
//
// M2, review fix: the block-comment strip stays a whole-text regex (that
// part was never in question), but the old single-line strip was
// `.replace(/\/\/.*$/gm, "")` -- a regex that cannot tell a `//` comment
// from a `//` inside a string literal. src/society.ts and all of
// src/doc.ts are full of `https://` URLs, so a real offending statement
// sharing a line with one was invisible to the scan (review's candidate
// 11). Line-wise now: a line is blanked only when its first non-whitespace
// token is `//`, i.e. the whole line is a comment. A trailing same-line
// comment (`code(); // UPDATE proposals in prose`) is deliberately left
// alone -- that direction risks a false CAUGHT (annoying, fixed by
// rewording the comment, exactly as this file's own header once had to
// be), never a false clean, which is the direction that matters for a
// guard whose job is catching a bypass.
function stripComments(text: string): string {
  const withoutBlocks = text.replace(/\/\*[\s\S]*?\*\//g, "");
  return withoutBlocks
    .split("\n")
    .map((line) => (/^\s*\/\//.test(line) ? "" : line))
    .join("\n");
}

function readSourceWithoutComments(path: string): string {
  return stripComments(readFileSync(path, "utf8"));
}

// M2, review fix: the old pattern was `(INSERT\s+INTO|UPDATE|DELETE\s+FROM)
// \s+<table>\b` -- it missed every alternate SQLite spelling of the same
// write (quoted, bracketed, backtick-quoted, or schema-qualified table
// names; `INSERT OR REPLACE`/`INSERT OR IGNORE`/bare `REPLACE INTO`, the
// idiomatic upserts for a key-value table like governance_settings). This
// is the review's own suggested broadening: an optional leading quote
// mark, an optional `schema.` prefix, an optional trailing quote mark, and
// the missing verb forms.
//
// docs/REVIEW-DEMOCRACY-RECHECK.md N2: the broadening above added
// `(\s+OR\s+\w+)?` to INSERT but left UPDATE bare, so `UPDATE OR
// REPLACE|IGNORE|ABORT|ROLLBACK|FAIL <table>` -- real, documented SQLite
// conflict-resolution syntax, the exact symmetric case -- still bypassed
// the scan. UPDATE gets the identical optional clause INSERT already has.
function tableWritePattern(table: string): RegExp {
  return new RegExp(
    `(INSERT(\\s+OR\\s+\\w+)?\\s+INTO|REPLACE\\s+INTO|UPDATE(\\s+OR\\s+\\w+)?|DELETE\\s+FROM)\\s+(?:"|\\[|\`)?(?:\\w+\\.)?${table}(?:"|\\]|\`)?\\b`,
    "i",
  );
}

function scanForOffenders(): string[] {
  const offenders: string[] = [];
  for (const file of walkTsFiles(SRC)) {
    if (file === GOVERNANCE_PATH) continue;
    const text = readSourceWithoutComments(file);
    for (const table of GOVERNANCE_TABLES) {
      if (tableWritePattern(table).test(text)) offenders.push(`${file} writes ${table} directly`);
    }
  }
  return offenders;
}

test("proposals and governance_settings are written only from src/governance.ts, nowhere else in src/", () => {
  assert.deepEqual(
    scanForOffenders(),
    [],
    "A second writer to proposals or governance_settings bypasses governance.ts's own rules -- eligibility, payload validation, rate caps, the claim-then-tally-then-execute shape -- the same way a second writer to a chained table bypasses appendChained.",
  );
});

// Positive control: proves the scan is not vacuously true because
// governance.ts happens to be the only file scanned that ever writes SQL
// at all. It genuinely does write both tables (createProposal,
// claimTallyAndExecuteOne, upsertSettingStmt), which is exactly why it is
// excluded above rather than flagged.
test("governance.ts itself does write both proposals and governance_settings (the positive control for the scan above)", () => {
  const text = readSourceWithoutComments(GOVERNANCE_PATH);
  assert.match(text, /INSERT\s+INTO\s+proposals/i);
  assert.match(text, /INSERT\s+INTO\s+governance_settings/i);
});

// M2 red-proof. These are the review's own eleven candidate writers,
// reproduced verbatim (docs/REVIEW-DEMOCRACY.md, "M2"), re-run against the
// fixed pattern and comment-stripper as a standing regression: if a future
// edit narrows either back down, this is what goes red. Ten of eleven must
// be CAUGHT; the eleventh (a table name built from a runtime variable) is
// not literal text in the source at all, so no static scan -- this one or
// any other -- can see it. That is an accepted, documented residual, not a
// gap in this fix; it is asserted below rather than silently dropped.
const BYPASS_CANDIDATES: Array<{ text: string; caught: boolean; note: string }> = [
  { text: "UPDATE proposals SET status = 'x'", caught: true, note: "the control" },
  { text: "UPDATE \"proposals\" SET status = 'x'", caught: true, note: "double-quoted table name" },
  { text: "UPDATE [proposals] SET status = 'x'", caught: true, note: "bracket-quoted table name" },
  { text: "UPDATE `proposals` SET status = 'x'", caught: true, note: "backtick-quoted table name" },
  { text: "UPDATE main.proposals SET status = 'x'", caught: true, note: "schema-qualified table name" },
  { text: "INSERT OR REPLACE INTO proposals (id) VALUES (1)", caught: true, note: "idiomatic upsert, not hypothetical" },
  { text: "REPLACE INTO governance_settings (key) VALUES ('x')", caught: true, note: "idiomatic upsert, not hypothetical" },
  { text: "INSERT OR IGNORE INTO governance_settings (key) VALUES ('x')", caught: true, note: "idiomatic upsert, not hypothetical" },
  { text: "UPDATE OR REPLACE proposals SET status = 'x'", caught: true, note: "N2: UPDATE's own OR-conflict-resolution form, the exact symmetric case the INSERT broadening above did not cover" },
  { text: "UPDATE OR IGNORE governance_settings SET value = 'x'", caught: true, note: "N2: idiomatic UPDATE OR IGNORE on a key-value table" },
  { text: "UPDATE OR ABORT proposals SET status = 'x'", caught: true, note: "N2: UPDATE OR ABORT, real SQLite conflict-resolution syntax" },
  { text: "INSERT INTO \"governance_settings\" (key) VALUES ('x')", caught: true, note: "double-quoted table name" },
  {
    text: "const s=\"https://x\"; await db.prepare(\"UPDATE proposals SET status = 'x'\")",
    caught: true,
    note: "was the live blind spot: the old //-strip regex ate everything after https:// on this line, hiding the real UPDATE that followed it",
  },
  {
    text: "const T='proposals'; const q = \"UPDATE ${T} SET status = 'x'\";",
    caught: false,
    note: "known residual (review M2): the table name is a runtime value, not literal text in the source -- no static scan can see it",
  },
];

test("the broadened pattern and line-wise comment-stripper catch the review's eleven bypass candidates (M2 red-proof)", () => {
  const missed = BYPASS_CANDIDATES.filter((c) => !c.caught);
  assert.equal(
    missed.length,
    1,
    "exactly one candidate (the const-template rewrite) is expected to remain a known, documented residual -- any other MISSED means the fix regressed",
  );

  for (const candidate of BYPASS_CANDIDATES) {
    const stripped = stripComments(candidate.text);
    const isCaught = GOVERNANCE_TABLES.some((table) => tableWritePattern(table).test(stripped));
    assert.equal(
      isCaught,
      candidate.caught,
      `expected ${candidate.caught ? "CAUGHT" : "MISSED"} for [${candidate.note}]: ${candidate.text}`,
    );
  }
});
