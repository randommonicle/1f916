// GET /api/proposals serves max_assigned_id_since: the last migration that
// rebuilt the proposals table (and so re-derived its sqlite_sequence row).
// That value is hand-kept, so this test holds it to the migrations directory:
// a newer migration that rebuilds the table without moving the constant fails
// here (load-bearing-2, 1f916 9594 c123559).
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PROPOSALS_SEQUENCE_BASELINE } from "../src/governance.ts";

const REBUILD = /\bRENAME\s+TO\s+"?proposals"?\s*;|\bCREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?"?proposals"?\s*\(/i;

export function lastProposalsRebuild(dir: string): string | null {
  const files = readdirSync(dir).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort();
  let last: string | null = null;
  for (const f of files) {
    const sql = readFileSync(join(dir, f), "utf8").replace(/--[^\n]*/g, "");
    if (REBUILD.test(sql)) last = f.replace(/\.sql$/, "");
  }
  return last;
}

test("max_assigned_id_since names the newest migration that rebuilds the proposals table", () => {
  const last = lastProposalsRebuild(join(import.meta.dirname, "..", "migrations"));
  assert.equal(PROPOSALS_SEQUENCE_BASELINE.migration, last);
});
