// Migration 0025, citizens.assertion_objected_at (D-078 item 4 option B, O1, OT8). Real SQLite over schema.sql with the column dropped, then the REAL migration file
// applied; the verification SQL run over real rows. Proves: one nullable last column, no default, rows read NULL; schema.sql carries the identical column last;
// a second apply fails loudly; no index, REFERENCES or backfill; verify SQL returns the offending row (a stamp on a flagged seat) and zero rows otherwise.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createLocalD1, insertCitizen, withoutObjectionColumn } from "./helpers/local-d1.ts";

const ROOT = join(import.meta.dirname, "..");
const MIGRATION = readFileSync(join(ROOT, "migrations", "0025_assertion_objection.sql"), "utf8").replace(/\r\n/g, "\n");
const VERIFY = readFileSync(join(ROOT, "scripts", "verify-last-assertion-at.sql"), "utf8").replace(/\r\n/g, "\n");
type Col = { cid: number; name: string; type: string; notnull: number; dflt_value: unknown };
const cols = (raw: { prepare(s: string): { all(): unknown[] } }) => raw.prepare("PRAGMA table_info(citizens)").all() as Col[];

test("OT8: 0025 adds one nullable last column after last_assertion_at, rows read NULL, schema.sql matches, a second apply fails", () => {
  const d1 = createLocalD1();
  const pre = createLocalD1({ schemaTransform: withoutObjectionColumn });
  try {
    const schemaCols = cols(d1.raw);
    const last = schemaCols[schemaCols.length - 1]!;
    assert.equal(last.name, "assertion_objected_at", "schema.sql carries the column last");
    assert.equal(schemaCols[schemaCols.length - 2]!.name, "last_assertion_at");

    const id = insertCitizen(pre);
    const before = cols(pre.raw);
    assert.ok(!before.some((c) => c.name === "assertion_objected_at"));
    pre.raw.exec(MIGRATION);
    const after = cols(pre.raw);
    assert.equal(after.length, before.length + 1);
    assert.deepEqual(after[after.length - 1], last, "the migration yields the same column as schema.sql");
    assert.equal(last.notnull, 0);
    assert.equal(last.dflt_value, null);
    assert.equal(last.type, "INTEGER");
    const v = (pre.raw.prepare("SELECT assertion_objected_at AS v FROM citizens WHERE id = ?").get(id) as { v: number | null }).v;
    assert.equal(v, null);
    assert.throws(() => pre.raw.exec(MIGRATION), /duplicate column name/i, "a second apply fails loudly");
  } finally {
    d1.close();
    pre.close();
  }
});

test("OT8: the 0025 file adds no index, no REFERENCES, no backfill", () => {
  const code = MIGRATION.split("\n").filter((l) => !l.startsWith("--")).join("\n");
  assert.ok(!/INDEX/i.test(code));
  assert.ok(!/REFERENCES/i.test(code));
  assert.ok(!/UPDATE|INSERT/i.test(code));
  assert.match(code, /ALTER TABLE citizens ADD COLUMN assertion_objected_at INTEGER;/);
});

test("OT8: the verification SQL returns a stamp on a flagged seat and nothing for a clean or a correctly flagged seat", () => {
  const d1 = createLocalD1();
  try {
    const key = "A".repeat(43);
    const clean = insertCitizen(d1);
    d1.raw.prepare("UPDATE citizens SET public_key = ? WHERE id = ?").run(key, clean);
    const rows = () => d1.raw.prepare(VERIFY.replace(/;\s*$/, "")).all() as { id: number; handle: string }[];
    assert.equal(rows().length, 0);
    d1.raw.prepare("UPDATE citizens SET last_assertion_at = 1800000000000 WHERE id = ?").run(clean);
    assert.equal(rows().length, 0, "a stamp on an unflagged key seat is fine");
    d1.raw.prepare("UPDATE citizens SET assertion_objected_at = 1800000001000, last_assertion_at = NULL WHERE id = ?").run(clean);
    assert.equal(rows().length, 0, "a flagged seat with no stamp is the upheld state");
    d1.raw.prepare("UPDATE citizens SET last_assertion_at = 1800000002000 WHERE id = ?").run(clean);
    const bad = rows();
    assert.equal(bad.length, 1, "a stamp on a flagged seat is an offender");
    assert.equal(bad[0]!.id, clean);
  } finally {
    d1.close();
  }
});
