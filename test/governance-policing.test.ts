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
function readSourceWithoutComments(path: string): string {
  const text = readFileSync(path, "utf8");
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function scanForOffenders(): string[] {
  const offenders: string[] = [];
  for (const file of walkTsFiles(SRC)) {
    if (file === GOVERNANCE_PATH) continue;
    const text = readSourceWithoutComments(file);
    for (const table of GOVERNANCE_TABLES) {
      const pattern = new RegExp(`(INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+${table}\\b`, "i");
      if (pattern.test(text)) offenders.push(`${file} writes ${table} directly`);
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
