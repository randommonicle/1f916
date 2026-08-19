// Local rehearsal of migration 0008 (the showhome tables) against a real
// SQLite engine (node:sqlite, the same engine test/helpers/local-d1.ts uses),
// plus the post-apply catalog verification the migration file documents. The
// real-D1 --remote rehearsal is the operator's deploy-time step; this proves
// everything that can be proven off-line: that 0008 is self-contained and
// additive (no dependency on any existing table, no foreign key -- the whole
// point of choosing an additive migration to dodge the 0007 D1 authorizer/FK
// hazard class, L-016), that it builds exactly the documented catalog, and that
// it is idempotent on top of the current full schema.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATION_PATH = join(import.meta.dirname, "..", "migrations", "0008_showhome.sql");
const SCHEMA_PATH = join(import.meta.dirname, "..", "schema.sql");

const migrationSql = () => readFileSync(MIGRATION_PATH, "utf8");
const schemaSql = () => readFileSync(SCHEMA_PATH, "utf8");

const SHOWHOME_TABLES = ["visitors", "showhome_notes", "showhome_rate"];
const SHOWHOME_INDEXES = [
  "idx_visitors_token",
  "idx_visitors_created",
  "idx_showhome_notes_created",
  "idx_showhome_rate_path",
  "idx_showhome_rate_ip",
];

function tableColumns(db: InstanceType<typeof DatabaseSync>, table: string): string[] {
  return (db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[]).map((r) => r.name).sort();
}
function foreignKeys(db: InstanceType<typeof DatabaseSync>, table: string): unknown[] {
  return db.prepare(`SELECT * FROM pragma_foreign_key_list(?)`).all(table);
}
function objectsOfType(db: InstanceType<typeof DatabaseSync>, type: "table" | "index"): Set<string> {
  return new Set((db.prepare(`SELECT name FROM sqlite_master WHERE type = ?`).all(type) as { name: string }[]).map((r) => r.name));
}

// The migration alone, on an EMPTY database, must create exactly the showhome
// tables and indexes and nothing else -- proving it references no existing
// table (no FK, no ALTER, no INSERT...SELECT off another table). This is the
// L-016 additive guarantee, made concrete.
test("0008 applies to a FRESH empty D1 and creates exactly the three additive showhome tables", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(migrationSql());

    const tables = objectsOfType(db, "table");
    // sqlite may auto-create sqlite_sequence for AUTOINCREMENT tables; ignore it.
    const created = [...tables].filter((n) => n !== "sqlite_sequence").sort();
    assert.deepEqual(created, [...SHOWHOME_TABLES].sort(), "exactly the three showhome tables, no others, on an empty DB");

    const indexes = objectsOfType(db, "index");
    for (const idx of SHOWHOME_INDEXES) {
      assert.ok(indexes.has(idx), `index ${idx} must exist after applying 0008`);
    }
  } finally {
    db.close();
  }
});

test("0008 tables have exactly their documented columns", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(migrationSql());
    assert.deepEqual(tableColumns(db, "visitors"), ["created_at", "handle", "id", "model", "token_hash"]);
    assert.deepEqual(tableColumns(db, "showhome_notes"), ["body", "created_at", "handle", "id", "model", "visitor_id"]);
    assert.deepEqual(tableColumns(db, "showhome_rate"), ["created_at", "ip_hash", "path"]);
  } finally {
    db.close();
  }
});

// The load-bearing L-016 property: NOT ONE of the three tables carries a foreign
// key. This is what keeps the migration out of the defer_foreign_keys /
// SQLITE_CONSTRAINT_FOREIGNKEY class that rolled 0007 back on real D1. It can
// fail: add `REFERENCES citizens(id)` to any of the three and this goes red.
test("0008 introduces NO foreign key on any showhome table (the additive/no-FK guarantee)", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(migrationSql());
    for (const table of SHOWHOME_TABLES) {
      assert.equal(foreignKeys(db, table).length, 0, `${table} must have zero foreign keys (additive-only migration)`);
    }
  } finally {
    db.close();
  }
});

// token_hash uniqueness must be a schema fact, not a code convention: two
// visitor rows can never share a token hash.
test("0008 enforces token_hash uniqueness on visitors", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(migrationSql());
    db.prepare("INSERT INTO visitors (handle, model, token_hash, created_at) VALUES (?, ?, ?, ?)").run("a", "m", "HASH", 1);
    assert.throws(
      () => db.prepare("INSERT INTO visitors (handle, model, token_hash, created_at) VALUES (?, ?, ?, ?)").run("b", "m", "HASH", 2),
      /UNIQUE/,
      "a duplicate token_hash must be rejected by idx_visitors_token",
    );
  } finally {
    db.close();
  }
});

// Positive control (prove-it-can-fail): the same catalog-reading mechanism used
// above, pointed at the FULL schema, sees a table that is NOT a showhome table
// (citizens). Without this, a broken pragma call could make every "table
// exists" assertion pass or fail for the wrong reason.
test("positive control: the catalog mechanism sees citizens in the full schema, and schema.sql already carries the showhome tables identically", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(schemaSql());
    const tables = objectsOfType(db, "table");
    assert.ok(tables.has("citizens"), "sanity: the catalog mechanism finds a known non-showhome table");
    for (const t of SHOWHOME_TABLES) {
      assert.ok(tables.has(t), `schema.sql must carry ${t} identically to the migration (harness loads schema.sql)`);
    }
    // Columns in schema.sql must match the migration's, or the harness and prod diverge.
    assert.deepEqual(tableColumns(db, "visitors"), ["created_at", "handle", "id", "model", "token_hash"]);
    assert.deepEqual(tableColumns(db, "showhome_notes"), ["body", "created_at", "handle", "id", "model", "visitor_id"]);
    assert.deepEqual(tableColumns(db, "showhome_rate"), ["created_at", "ip_hash", "path"]);
  } finally {
    db.close();
  }
});

// Applying 0008 on top of the current full schema (which already carries the
// three tables via IF NOT EXISTS) is a clean no-op -- it neither errors nor
// changes the catalog. This is the operator's real sequence made safe: even if
// the tables somehow already exist, migration-0008-first cannot fail on them.
test("0008 is idempotent on top of the full schema (no error, no catalog change)", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(schemaSql());
    const before = [...objectsOfType(db, "table")].sort().join(",");
    db.exec(migrationSql()); // must not throw
    const after = [...objectsOfType(db, "table")].sort().join(",");
    assert.equal(after, before, "applying 0008 over the full schema must not add or remove any table");
  } finally {
    db.close();
  }
});
