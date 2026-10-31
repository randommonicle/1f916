// Migration 0022 (D-079): the model_retry audit column on both run tables. Real SQLite (node:sqlite), the catalog read directly
// (db-migration-verification): the migration applied on top of 0004 and 0010 adds exactly one nullable TEXT column to each
// table, rebuilds nothing, and schema.sql carries the identical columns.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const dir = (f: string) => join(import.meta.dirname, "..", f);
const read = (f: string) => readFileSync(dir(f), "utf8");

type Col = { name: string; type: string; nn: number; dflt_value: string | null };
const cols = (db: DatabaseSync, t: string) => db.prepare('SELECT name, type, "notnull" AS nn, dflt_value FROM pragma_table_info(?)').all(t) as Col[];

function migrated(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(read("migrations/0004_maintainer_runtime.sql"));
  db.exec(read("migrations/0010_concierge.sql"));
  return db;
}

test("0022 adds exactly one nullable TEXT model_retry column to each run table, and nothing else", () => {
  const db = migrated();
  try {
    const before = { m: cols(db, "maintainer_runs").map((c) => c.name), c: cols(db, "concierge_runs").map((c) => c.name) };
    assert.ok(!before.m.includes("model_retry") && !before.c.includes("model_retry"));
    db.exec(read("migrations/0022_model_retry.sql"));
    for (const [t, was] of [["maintainer_runs", before.m], ["concierge_runs", before.c]] as const) {
      const after = cols(db, t);
      assert.deepEqual(after.map((c) => c.name).sort(), [...was, "model_retry"].sort(), `${t}: exactly one new column`);
      const col = after.find((c) => c.name === "model_retry")!;
      assert.equal(col.type, "TEXT");
      assert.equal(col.nn, 0, "nullable");
      assert.equal(col.dflt_value, null);
    }
  } finally {
    db.close();
  }
});

test("0022 is additive only: no DROP, no table rebuild, no CREATE TABLE", () => {
  const sql = read("migrations/0022_model_retry.sql").split("\n").filter((l) => !l.startsWith("--")).join("\n");
  assert.ok(!/DROP|CREATE\s+TABLE|RENAME/i.test(sql), "additive only (L-016)");
  assert.equal((sql.match(/ALTER TABLE/g) ?? []).length, 2);
});

test("schema.sql carries the same columns as 0004 + 0010 + 0022 for both tables", () => {
  const m = migrated();
  m.exec(read("migrations/0022_model_retry.sql"));
  const s = new DatabaseSync(":memory:");
  try {
    s.exec(read("schema.sql"));
    for (const t of ["maintainer_runs", "concierge_runs"]) {
      const key = (c: Col) => `${c.name}:${c.type}:${c.nn}:${c.dflt_value}`;
      const fromMig = cols(m, t).map(key).sort();
      const fromSchema = cols(s, t).map(key).sort();
      assert.deepEqual(fromSchema, fromMig, `${t}: schema.sql must match the migrated shape`);
      assert.ok(fromSchema.some((k) => k.startsWith("model_retry:")));
    }
  } finally {
    m.close();
    s.close();
  }
});
