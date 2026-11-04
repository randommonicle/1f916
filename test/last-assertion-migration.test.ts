// Migration 0024, citizens.last_assertion_at (D-078 item 4, B1). Real SQLite over schema.sql with the column dropped, then the REAL migration file applied.
// It proves: the migration adds exactly one nullable column, last, with no default; every existing row reads NULL (no backfill is possible); schema.sql carries
// the identical column last; the migration file contains no index and no REFERENCES.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createLocalD1, insertCitizen, withoutLastAssertionColumn } from "./helpers/local-d1.ts";

const ROOT = join(import.meta.dirname, "..");
const MIGRATION = readFileSync(join(ROOT, "migrations", "0024_last_assertion_at.sql"), "utf8").replace(/\r\n/g, "\n");
type Col = { cid: number; name: string; type: string; notnull: number; dflt_value: unknown };
const cols = (raw: { prepare(s: string): { all(): unknown[] } }) => raw.prepare("PRAGMA table_info(citizens)").all() as Col[];

test("0024 adds one nullable last column, existing rows read NULL, and schema.sql matches", () => {
  const d1 = createLocalD1();
  const pre = createLocalD1({ schemaTransform: withoutLastAssertionColumn });
  try {
    const schemaCols = cols(d1.raw);
    const last = schemaCols[schemaCols.length - 1]!;
    assert.equal(last.name, "last_assertion_at", "schema.sql carries the column last");

    const id = insertCitizen(pre);
    const before = cols(pre.raw);
    assert.ok(!before.some((c) => c.name === "last_assertion_at"));
    pre.raw.exec(MIGRATION);
    const after = cols(pre.raw);
    assert.equal(after.length, before.length + 1);
    assert.deepEqual(after[after.length - 1], last, "the migration yields the same column as schema.sql");
    assert.equal(last.notnull, 0);
    assert.equal(last.dflt_value, null);
    assert.equal(last.type, "INTEGER");
    const v = (pre.raw.prepare("SELECT last_assertion_at AS v FROM citizens WHERE id = ?").get(id) as { v: number | null }).v;
    assert.equal(v, null);
  } finally {
    d1.close();
    pre.close();
  }
});

test("0024 file adds no index and no REFERENCES", () => {
  const code = MIGRATION.split("\n").filter((l) => !l.startsWith("--")).join("\n");
  assert.ok(!/INDEX/i.test(code));
  assert.ok(!/REFERENCES/i.test(code));
  assert.ok(!/UPDATE|INSERT/i.test(code), "no backfill");
});
