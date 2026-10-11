// Migration 0020, the resident tier (D-075 order step b; docs/BRIEF-RESIDENT-TIER-2026-10-11.md R1). Real SQLite (node:sqlite) over the
// committed schema.sql and the real migration file. It proves, each red-proofed in docs/CHECKPOINT-RESIDENTS.md:
//   * the migration applied to the pre-0020 schema lands on exactly what schema.sql builds, column order included (ALTER appends);
//   * it is additive: two columns, one partial unique index, one table, one index; guests is not rebuilt and an existing row survives
//     with NULL key and NULL resident_at (an unbound guest, permanently a meaningful state);
//   * resident_nonces has a nonce PRIMARY KEY, NOT NULL attribution columns, an expiry index and NO foreign key;
//   * the partial unique index refuses a second guest with the same key and allows any number of NULLs;
//   * re-applying the migration fails loudly (ALTER TABLE is not idempotent) and changes nothing;
//   * schema.sql's block is the migration's block byte for byte (CRLF-normalised) and the 0018 guest block above it is untouched.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const norm = (s: string) => s.replace(/\r\n/g, "\n");
const migrationSql = () => norm(readFileSync(join(ROOT, "migrations", "0020_residents.sql"), "utf8"));
const schemaSql = () => norm(readFileSync(join(ROOT, "schema.sql"), "utf8"));
const HEADER = "-- The resident tier (migrations/0020_residents.sql";

type Db = InstanceType<typeof DatabaseSync>;
const columnsInOrder = (db: Db, table: string): string[] => (db.prepare("SELECT name FROM pragma_table_info(?)").all(table) as { name: string }[]).map((r) => r.name);
const names = (db: Db, type: "table" | "index"): string[] => (db.prepare("SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name").all(type) as { name: string }[]).map((r) => r.name);

function preResidentSchema(): string {
  const s = schemaSql();
  const i = s.indexOf(HEADER);
  assert.ok(i > 0, "schema.sql carries the resident block's header comment");
  return s.slice(0, i);
}

test("0020 on the pre-0020 schema lands on exactly what schema.sql builds, column order included (mutant: a column listed in a different order in the migration)", () => {
  const migrated = new DatabaseSync(":memory:");
  const fresh = new DatabaseSync(":memory:");
  try {
    migrated.exec(preResidentSchema());
    migrated.exec(migrationSql());
    fresh.exec(schemaSql());
    assert.deepEqual(columnsInOrder(migrated, "guests"), columnsInOrder(fresh, "guests"));
    assert.deepEqual(columnsInOrder(migrated, "guests").slice(-2), ["public_key", "resident_at"], "the two new columns are appended, in this order");
    assert.deepEqual(columnsInOrder(migrated, "resident_nonces"), ["nonce", "visitor_id", "expires_at"]);
    assert.deepEqual(names(migrated, "table"), names(fresh, "table"));
    assert.deepEqual(names(migrated, "index"), names(fresh, "index"));
  } finally {
    migrated.close();
    fresh.close();
  }
});

test("0020 is additive: guests is not rebuilt, an existing guest survives as an unbound guest, and exactly one table and two indexes appear (mutant: the migration drops or recreates guests)", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(preResidentSchema());
    db.prepare("INSERT INTO guests (visitor_id, token_hash, handle, model, created_at) VALUES (7, 'abc', 'wren', 'm', 1)").run();
    const tablesBefore = names(db, "table");
    const indexesBefore = names(db, "index");
    db.exec(migrationSql());
    const tablesAfter = names(db, "table");
    assert.deepEqual(tablesAfter.filter((t) => !tablesBefore.includes(t)), ["resident_nonces"], "exactly one table is added");
    assert.deepEqual(tablesBefore.filter((t) => !tablesAfter.includes(t)), [], "no table is dropped or renamed");
    assert.deepEqual(names(db, "index").filter((i) => !indexesBefore.includes(i)), ["idx_guests_public_key", "idx_resident_nonces_expiry"]);
    const row = db.prepare("SELECT visitor_id, token_hash, handle, public_key, resident_at FROM guests WHERE visitor_id = 7").get() as Record<string, unknown>;
    assert.deepEqual({ ...row }, { visitor_id: 7, token_hash: "abc", handle: "wren", public_key: null, resident_at: null });
  } finally {
    db.close();
  }
});

test("guests carries no foreign key after 0020, and resident_nonces carries none either (an attribution pointer, like auth_nonces.citizen_id)", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(schemaSql());
    for (const t of ["guests", "resident_nonces"]) {
      assert.equal((db.prepare("SELECT COUNT(*) AS n FROM pragma_foreign_key_list(?)").get(t) as { n: number }).n, 0, `${t}: no foreign key (L-016)`);
    }
    const info = db.prepare("SELECT name, \"notnull\" AS nn, pk FROM pragma_table_info('resident_nonces') ORDER BY cid").all() as Array<{ name: string; nn: number; pk: number }>;
    assert.deepEqual(info.map((c) => [c.name, c.nn, c.pk]), [["nonce", 0, 1], ["visitor_id", 1, 0], ["expires_at", 1, 0]], "the nonce is the PRIMARY KEY; the other two are NOT NULL");
  } finally {
    db.close();
  }
});

test("the nonce PRIMARY KEY is the replay check (a reused nonce is a UNIQUE violation), and the partial unique index refuses a second guest with the same key but allows many unbound guests (mutant: the index is not partial, or not unique)", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(schemaSql());
    const nonce = db.prepare("INSERT INTO resident_nonces (nonce, visitor_id, expires_at) VALUES (?, ?, ?)");
    nonce.run("n-one-0123456789abcdef", 1, 10);
    assert.throws(() => nonce.run("n-one-0123456789abcdef", 2, 10), /UNIQUE constraint failed: resident_nonces\.nonce/);
    const guest = db.prepare("INSERT INTO guests (visitor_id, token_hash, handle, model, created_at, public_key) VALUES (?, ?, 'h', 'm', 1, ?)");
    guest.run(1, "t1", null);
    guest.run(2, "t2", null);
    guest.run(3, "t3", null); // any number of unbound guests: NULLs do not collide
    guest.run(4, "t4", "K");
    assert.throws(() => guest.run(5, "t5", "K"), /UNIQUE constraint failed: guests\.public_key/);
  } finally {
    db.close();
  }
});

test("re-applying 0020 fails LOUDLY and changes nothing: ALTER TABLE ADD COLUMN is not idempotent, so the deploy script reads the catalogue first", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(preResidentSchema());
    db.exec(migrationSql());
    const before = JSON.stringify([columnsInOrder(db, "guests"), names(db, "table"), names(db, "index")]);
    assert.throws(() => db.exec(migrationSql()), /duplicate column name/i);
    assert.equal(JSON.stringify([columnsInOrder(db, "guests"), names(db, "table"), names(db, "index")]), before);
  } finally {
    db.close();
  }
});

test("schema.sql carries the migration's statements byte for byte (CRLF-normalised) from the first ALTER to the end of the file, and the 0018 guests table above it is unchanged (mutant: one character differs)", () => {
  const mig = migrationSql();
  const block = mig.slice(mig.indexOf("ALTER TABLE guests ADD COLUMN public_key"));
  assert.ok(block.length > 400, "the migration's statements were found");
  const schema = schemaSql();
  assert.ok(schema.endsWith(block), "schema.sql ends with exactly the migration's block");
  assert.ok(!schema.replace("resident_at INTEGER;", "resident_at  INTEGER;").endsWith(block), "a one-character drift in either copy fails the comparison");
  // the 0018 guests table is still exactly as that migration made it (nothing was spliced into it)
  const m18 = norm(readFileSync(join(ROOT, "migrations", "0018_guest_voice.sql"), "utf8"));
  const guestsTable = /CREATE TABLE IF NOT EXISTS guests \([\s\S]*?\n\);/.exec(m18)![0];
  assert.ok(schema.includes(guestsTable), "the guests CREATE TABLE in schema.sql is still 0018's, byte for byte");
  assert.doesNotMatch(guestsTable, /public_key|resident_at/);
});
