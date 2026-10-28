// GET /api/proposals serves max_assigned_id_since: the last migration that
// rebuilt the proposals table (and so re-derived its sqlite_sequence row).
// That value is hand-kept, so this test holds it to the migrations directory:
// a newer migration that rebuilds the table without moving the constant fails
// here (load-bearing-2, 1f916 9594 c123559). The scanner is a guard on the
// forms SQLite accepts for creating or renaming to the table, not a parser:
// the synthetic cases below are the forms it is proved against (CODEX r1,
// exchange/REVIEW_proposals-note-epoch-2026-10-28.md).
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PROPOSALS_SEQUENCE_BASELINE } from "../src/governance.ts";

// Removes -- and /* */ comments and the contents of '...' strings (except a
// literal 'proposals', which SQLite accepts as the table's name), and turns
// each quoted identifier ("x", `x`, [x]) into "proposals" when it names the
// table and "x" otherwise, so the patterns below read only real tokens.
export function stripSqlNoise(sql: string): string {
  let out = "";
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const n = sql[i + 1];
    if (c === "-" && n === "-") { while (i < sql.length && sql[i] !== "\n") i++; continue; }
    if (c === "/" && n === "*") { const end = sql.indexOf("*/", i + 2); i = end < 0 ? sql.length : end + 2; out += " "; continue; }
    if (c === "'") {
      i++;
      const start = i;
      while (i < sql.length) { if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; } if (sql[i] === "'") break; i++; }
      // SQLite also accepts 'proposals' as a table name (legacy quoting), so a
      // literal whose whole text is the name stays a name token (CODEX r3).
      const lit = sql.slice(start, i).replace(/''/g, "'");
      i++; out += lit.toLowerCase() === "proposals" ? '"proposals"' : "''"; continue;
    }
    const close = c === '"' ? '"' : c === "`" ? "`" : c === "[" ? "]" : null;
    if (close) {
      // A quoted identifier is one token: its text never reads as SQL (CODEX r2).
      let j = i + 1;
      let name = "";
      while (j < sql.length) { if (sql[j] === close && close !== "]" && sql[j + 1] === close) { name += close; j += 2; continue; } if (sql[j] === close) break; name += sql[j]; j++; }
      out += name.toLowerCase() === "proposals" ? '"proposals"' : '"x"';
      i = j + 1; continue;
    }
    out += c; i++;
  }
  return out;
}

// [schema.]proposals, each part bare or quoted with "", ``, or [].
// '' is any other single-quoted literal after stripping: SQLite accepts 'main' as a schema name (CODEX r4).
const PART = String.raw`(?:"[^"]*"|\x60[^\x60]*\x60|\[[^\]]*\]|''|[A-Za-z_][A-Za-z0-9_]*)`;
const NAME = String.raw`(?:${PART}\s*\.\s*)?(?:"proposals"|\x60proposals\x60|\[proposals\]|proposals)(?![A-Za-z0-9_$\u0080-\uFFFF])`; // SQLite identifiers also continue with $ and non-ASCII (DEEPSEEK r1)
const REBUILD = new RegExp(
  String.raw`\bRENAME\s+TO\s+${NAME}|\bCREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?${NAME}`,
  "i",
);

export function rebuildsProposals(sql: string): boolean {
  return REBUILD.test(stripSqlNoise(sql));
}

export function lastProposalsRebuild(dir: string): string | null {
  const files = readdirSync(dir).filter((f) => f.toLowerCase().endsWith(".sql")).sort();
  let last: string | null = null;
  for (const f of files) if (rebuildsProposals(readFileSync(join(dir, f), "utf8"))) last = f.replace(/\.sql$/i, "");
  return last;
}

test("max_assigned_id_since names the newest migration that rebuilds the proposals table", () => {
  const last = lastProposalsRebuild(join(import.meta.dirname, "..", "migrations"));
  assert.equal(PROPOSALS_SEQUENCE_BASELINE.migration, last);
});

test("the scanner sees every form of creating or renaming to proposals and none of the near misses", () => {
  const hits = [
    "ALTER TABLE proposals_new RENAME TO proposals;",
    "ALTER TABLE proposals_new RENAME TO proposals",
    'ALTER TABLE x RENAME TO "proposals"',
    "ALTER TABLE x RENAME TO `proposals`",
    "ALTER TABLE x RENAME TO [proposals]",
    "alter table x rename to main.proposals",
    "CREATE TABLE proposals (id INTEGER PRIMARY KEY AUTOINCREMENT)",
    "CREATE TABLE IF NOT EXISTS proposals(id INTEGER)",
    "CREATE TABLE main.proposals (id INTEGER)",
    'CREATE TABLE "main"."proposals" (id INTEGER)',
    "CREATE TABLE proposals AS SELECT * FROM old",
    "CREATE TEMP TABLE proposals (id INTEGER)",
    "SELECT '--'; CREATE TABLE proposals (id INTEGER)",
    "/* note */ CREATE TABLE proposals (id INTEGER)",
    'CREATE TABLE "PROPOSALS" (id INTEGER)',
    "CREATE TABLE 'proposals' (id INTEGER)",
    "ALTER TABLE old RENAME TO 'proposals'",
    "CREATE TABLE 'main'.'proposals' (id INTEGER)",
    "CREATE TABLE 'main'.proposals (id INTEGER)",
    "ALTER TABLE old RENAME TO main.'proposals'",
    'CREATE TABLE "pro""posals" (id INTEGER); CREATE TABLE [proposals] (id INTEGER)',
  ];
  const misses = [
    "CREATE TABLE proposals_new (id INTEGER)",
    "ALTER TABLE x RENAME TO proposals_old",
    "INSERT INTO proposals (title) VALUES ('CREATE TABLE proposals (')",
    "-- ALTER TABLE x RENAME TO proposals;",
    "/* CREATE TABLE proposals (id) */ SELECT 1",
    "CREATE TABLE ballots (proposal_id INTEGER REFERENCES proposals(id))",
    "DROP TABLE proposals",
    "CREATE TABLE notes ([CREATE TABLE proposals (id INTEGER)] TEXT)",
    'CREATE TABLE notes ("RENAME TO proposals" TEXT)',
    "CREATE TABLE notes (`CREATE TABLE main.proposals (` TEXT)",
    'CREATE TABLE "proposals_v2" (id INTEGER)',
    "INSERT INTO t (name) VALUES ('proposals')",
    "CREATE TABLE proposals$archive (id INTEGER)",
    "ALTER TABLE old RENAME TO proposals\u00e9",
    "CREATE TABLE t (k TEXT DEFAULT 'CREATE TABLE proposals (')",
  ];
  for (const s of hits) assert.equal(rebuildsProposals(s), true, `sees: ${s}`);
  for (const s of misses) assert.equal(rebuildsProposals(s), false, `ignores: ${s}`);
});
