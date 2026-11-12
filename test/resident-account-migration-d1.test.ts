// Migration 0026, resident accounts (D-082, plan M1; drafts/BRIEF-RESIDENT-OUTSIDE-ACCOUNT-2026-11-12.md A1, T11). Real SQLite over the committed schema.sql and the real
// migration file. Proves: the migration applied to the pre-0026 schema lands on what schema.sql builds; it is additive (two tables, one index, nothing dropped, an existing
// guest survives); no foreign key; the keys the brief names exist; NO column can hold a third party's text (T11); a second apply changes nothing.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const norm = (s: string) => s.replace(/\r\n/g, "\n");
const migrationSql = () => norm(readFileSync(join(ROOT, "migrations", "0026_resident_accounts.sql"), "utf8"));
const schemaSql = () => norm(readFileSync(join(ROOT, "schema.sql"), "utf8"));
const HEADER = "-- Resident accounts (migrations/0026_resident_accounts.sql";
type Db = InstanceType<typeof DatabaseSync>;
const columnsInOrder = (db: Db, table: string): string[] => (db.prepare("SELECT name FROM pragma_table_info(?)").all(table) as { name: string }[]).map((r) => r.name);
const names = (db: Db, type: "table" | "index"): string[] => (db.prepare("SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name").all(type) as { name: string }[]).map((r) => r.name);
const NEW_TABLES = ["resident_account_challenges", "resident_accounts"];

function preSchema(): string {
  const s = schemaSql();
  const i = s.indexOf(HEADER);
  assert.ok(i > 0, "schema.sql carries the resident-accounts block's header comment");
  return s.slice(0, i);
}

test("0026 on the pre-0026 schema lands on exactly what schema.sql builds, column order included", () => {
  const migrated = new DatabaseSync(":memory:");
  const fresh = new DatabaseSync(":memory:");
  try {
    migrated.exec(preSchema());
    assert.deepEqual(names(migrated, "table").filter((t) => NEW_TABLES.includes(t)), []);
    migrated.exec(migrationSql());
    fresh.exec(schemaSql());
    for (const t of NEW_TABLES) assert.deepEqual(columnsInOrder(migrated, t), columnsInOrder(fresh, t), t);
    assert.deepEqual(names(migrated, "table"), names(fresh, "table"));
    assert.deepEqual(names(migrated, "index"), names(fresh, "index"));
    assert.deepEqual(columnsInOrder(migrated, "resident_accounts"), [
      "visitor_id", "platform", "external_account_id", "external_handle", "record_id", "record_created_at", "account_created_at", "retrieved_at", "record_sha256", "account_sha256", "created_at",
    ]);
    assert.deepEqual(columnsInOrder(migrated, "resident_account_challenges"), ["nonce", "visitor_id", "purpose", "platform", "claim_code_hash", "issued_at", "expires_at", "used_at"]);
  } finally {
    migrated.close();
    fresh.close();
  }
});

test("0026 is additive: guests is not rebuilt, an existing guest survives, no foreign key, only IF NOT EXISTS creates", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(preSchema());
    const guestColsBefore = columnsInOrder(db, "guests");
    db.prepare("INSERT INTO guests (visitor_id, token_hash, handle, model, created_at) VALUES (7, 'h', 'kept', 'm', 1)").run();
    const before = names(db, "table");
    db.exec(migrationSql());
    assert.deepEqual(columnsInOrder(db, "guests"), guestColsBefore);
    assert.equal((db.prepare("SELECT handle FROM guests WHERE visitor_id = 7").get() as { handle: string }).handle, "kept");
    assert.deepEqual(names(db, "table").filter((t) => !before.includes(t)), NEW_TABLES);
    for (const t of NEW_TABLES) assert.equal((db.prepare("SELECT COUNT(*) AS n FROM pragma_foreign_key_list(?)").get(t) as { n: number }).n, 0, `${t} carries no foreign key`);
    const sql = migrationSql().replace(/--[^\n]*/g, "");
    assert.ok(!/\b(DROP|ALTER|DELETE|UPDATE|INSERT)\b/i.test(sql), "no statement but CREATE");
    assert.equal((sql.match(/CREATE (TABLE|INDEX)/g) ?? []).length, (sql.match(/CREATE (TABLE|INDEX) IF NOT EXISTS/g) ?? []).length, "every create is IF NOT EXISTS");
  } finally {
    db.close();
  }
});

test("the keys: one account per resident, one outside account per resident ever, purpose and platform are closed sets", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(schemaSql());
    const ins = (v: number, platform: string, acct: string) =>
      db.prepare("INSERT INTO resident_accounts (visitor_id, platform, external_account_id, external_handle, record_id, record_created_at, retrieved_at, record_sha256, account_sha256, created_at) VALUES (?, ?, ?, 'h', 'r', 1, 1, 'a', 'b', 1)").run(v, platform, acct);
    ins(1, "colony", "x");
    assert.throws(() => ins(1, "colony", "y"), /UNIQUE/);
    assert.throws(() => ins(2, "colony", "x"), /UNIQUE/);
    ins(2, "1f916", "x");
    const ch = (purpose: string, platform: string) =>
      db.prepare("INSERT INTO resident_account_challenges (nonce, visitor_id, purpose, platform, claim_code_hash, issued_at, expires_at) VALUES (?, 1, ?, ?, 'h', 1, 2)").run(`n${Math.random()}`, purpose, platform);
    ch("bind", "colony");
    ch("recover", "1f916");
    assert.throws(() => ch("steal", "colony"), /CHECK/);
    assert.throws(() => ch("bind", "1f3d9"), /CHECK/);
  } finally {
    db.close();
  }
});

test("T11: no column of resident_accounts can hold a third party's text, and the migration says so", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(schemaSql());
    const cols = columnsInOrder(db, "resident_accounts");
    for (const c of cols) assert.ok(!/body|text|content|message/i.test(c), `column ${c} must not be a place for a record's text`);
    assert.ok(!cols.includes("record_body"));
  } finally {
    db.close();
  }
});

test("a second apply of 0026 changes nothing, and schema.sql ends with the migration's block", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(schemaSql());
    const before = JSON.stringify([names(db, "table"), names(db, "index")]);
    db.exec(migrationSql());
    assert.equal(JSON.stringify([names(db, "table"), names(db, "index")]), before);
  } finally {
    db.close();
  }
  const block = migrationSql().slice(migrationSql().indexOf(HEADER));
  assert.ok(schemaSql().trimEnd().endsWith(block.trimEnd()), "schema.sql carries the migration's block byte for byte");
});
