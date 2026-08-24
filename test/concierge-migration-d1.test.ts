// Local rehearsal of migration 0010 (the concierge_runs table) against a real
// SQLite engine (node:sqlite, the same engine test/helpers/local-d1.ts uses),
// plus the post-apply catalog verification the migration file documents.
// Mirrors test/showhome-migration-d1.test.ts's structure exactly (0008 was
// the first additive, no-FK migration; this is the same shape for a single
// table). The real-D1 --remote rehearsal is the operator's deploy-time step;
// this proves everything that can be proven offline: that 0010 is
// self-contained and additive (no dependency on any existing table, no
// foreign key -- the same L-016-dodging shape 0008/0009 already used), that
// it builds exactly the documented catalog, and that it is idempotent on top
// of the current full schema.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATION_PATH = join(import.meta.dirname, "..", "migrations", "0010_concierge.sql");
const SCHEMA_PATH = join(import.meta.dirname, "..", "schema.sql");

const migrationSql = () => readFileSync(MIGRATION_PATH, "utf8");
const schemaSql = () => readFileSync(SCHEMA_PATH, "utf8");

const CONCIERGE_TABLE = "concierge_runs";
const CONCIERGE_INDEX = "idx_concierge_runs_started";
const CONCIERGE_COLUMNS = [
  "attempts_made",
  "candidates_seen",
  "comment_id",
  "cost_estimate_cents",
  "deny_reason",
  "engaged",
  "error",
  "finished_at",
  "id",
  "skipped_reason",
  "started_at",
  "target_id",
  "target_type",
  "tokens_in",
  "tokens_out",
].sort();

function tableColumns(db: InstanceType<typeof DatabaseSync>, table: string): string[] {
  return (db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[]).map((r) => r.name).sort();
}
function foreignKeys(db: InstanceType<typeof DatabaseSync>, table: string): unknown[] {
  return db.prepare(`SELECT * FROM pragma_foreign_key_list(?)`).all(table);
}
function objectsOfType(db: InstanceType<typeof DatabaseSync>, type: "table" | "index"): Set<string> {
  return new Set((db.prepare(`SELECT name FROM sqlite_master WHERE type = ?`).all(type) as { name: string }[]).map((r) => r.name));
}

// The migration alone, on an EMPTY database, must create exactly the
// concierge_runs table and its index and nothing else -- proving it
// references no existing table (no FK, no ALTER, no INSERT...SELECT off
// another table). This is the L-016 additive guarantee, made concrete.
test("0010 applies to a FRESH empty D1 and creates exactly the one additive concierge table", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(migrationSql());

    const tables = objectsOfType(db, "table");
    // sqlite may auto-create sqlite_sequence for AUTOINCREMENT tables; ignore it.
    const created = [...tables].filter((n) => n !== "sqlite_sequence").sort();
    assert.deepEqual(created, [CONCIERGE_TABLE], "exactly the one concierge table, no others, on an empty DB");

    const indexes = objectsOfType(db, "index");
    assert.ok(indexes.has(CONCIERGE_INDEX), `index ${CONCIERGE_INDEX} must exist after applying 0010`);
  } finally {
    db.close();
  }
});

test("0010's table has exactly its documented columns", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(migrationSql());
    assert.deepEqual(tableColumns(db, CONCIERGE_TABLE), CONCIERGE_COLUMNS);
  } finally {
    db.close();
  }
});

// The load-bearing L-016 property: concierge_runs carries NO foreign key.
// This is what keeps the migration out of the defer_foreign_keys /
// SQLITE_CONSTRAINT_FOREIGNKEY class that rolled 0007 back on real D1.
test("0010 introduces NO foreign key on concierge_runs (the additive/no-FK guarantee)", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(migrationSql());
    assert.equal(foreignKeys(db, CONCIERGE_TABLE).length, 0, "concierge_runs must have zero foreign keys (additive-only migration, no run_id FK to maintainer_runs)");
  } finally {
    db.close();
  }
});

// target_type's CHECK constraint must be a schema fact, not a code convention.
test("0010 enforces the target_type CHECK ('post', 'comment', or NULL only)", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(migrationSql());
    db.prepare("INSERT INTO concierge_runs (started_at, target_type) VALUES (?, ?)").run(1, "post");
    db.prepare("INSERT INTO concierge_runs (started_at, target_type) VALUES (?, ?)").run(2, "comment");
    db.prepare("INSERT INTO concierge_runs (started_at, target_type) VALUES (?, ?)").run(3, null);
    assert.throws(
      () => db.prepare("INSERT INTO concierge_runs (started_at, target_type) VALUES (?, ?)").run(4, "listing"),
      /CHECK/,
      "an out-of-band target_type must be rejected by the CHECK constraint",
    );
  } finally {
    db.close();
  }
});

// Positive control (prove-it-can-fail): the same catalog-reading mechanism
// used above, pointed at the FULL schema, sees a table that is NOT the
// concierge table (citizens). Without this, a broken pragma call could make
// every "table exists" assertion pass or fail for the wrong reason.
test("positive control: the catalog mechanism sees citizens in the full schema, and schema.sql already carries concierge_runs identically", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(schemaSql());
    const tables = objectsOfType(db, "table");
    assert.ok(tables.has("citizens"), "sanity: the catalog mechanism finds a known non-concierge table");
    assert.ok(tables.has(CONCIERGE_TABLE), "schema.sql must carry concierge_runs identically to the migration (harness loads schema.sql)");
    // Columns in schema.sql must match the migration's, or the harness and prod diverge.
    assert.deepEqual(tableColumns(db, CONCIERGE_TABLE), CONCIERGE_COLUMNS);
    // The index too, not just the table/columns: schema.sql must carry it
    // identically to the migration, or the harness (which loads schema.sql)
    // would silently diverge from prod.
    const indexes = objectsOfType(db, "index");
    assert.ok(indexes.has(CONCIERGE_INDEX), "schema.sql must carry the concierge_runs index identically to the migration");
  } finally {
    db.close();
  }
});

// Applying 0010 on top of the current full schema (which already carries the
// table via IF NOT EXISTS) is a clean no-op -- it neither errors nor changes
// the catalog. This is the operator's real sequence made safe: even if the
// table somehow already exists, migration-0010-first cannot fail on it.
test("0010 is idempotent on top of the full schema (no error, no catalog change)", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(schemaSql());
    const before = [...objectsOfType(db, "table")].sort().join(",");
    db.exec(migrationSql()); // must not throw
    const after = [...objectsOfType(db, "table")].sort().join(",");
    assert.equal(after, before, "applying 0010 over the full schema must not add or remove any table");
  } finally {
    db.close();
  }
});
