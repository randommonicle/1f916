// Local rehearsal of migration 0012 (public_key + auth_nonces) against a real
// SQLite engine (node:sqlite, the same engine test/helpers/local-d1.ts uses).
//
// HOW THIS DIFFERS FROM 0008/0009/0010's tests, and why it matters. Those
// migrations were entirely self-contained: applied to an EMPTY database they
// built their whole catalog, which is what made them trivially L-016-safe. 0012
// is NOT self-contained, because it carries an ALTER TABLE against citizens. So
// this file cannot make the same claim and does not pretend to. What it proves
// instead is the property that actually matters here:
//
//     migration(pre-0012 schema) is IDENTICAL to a fresh load of schema.sql
//
// including COLUMN ORDER, because ALTER TABLE ADD COLUMN appends and a
// schema.sql that lists public_key anywhere but last would silently disagree
// with production the moment the operator ran the migration. That divergence
// would not show up in any behavioural test; it would show up as a confusing
// PRAGMA diff during the deploy-time rehearsal, or not at all.
//
// The real-D1 --remote rehearsal against prod's own dumped DDL remains the
// operator's deploy-time step (L-016: node:sqlite cannot see D1's authorizer or
// its FK-defer behaviour). This proves everything provable offline.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATION_PATH = join(import.meta.dirname, "..", "migrations", "0012_public_key_registration.sql");
const SCHEMA_PATH = join(import.meta.dirname, "..", "schema.sql");

const migrationSql = () => readFileSync(MIGRATION_PATH, "utf8");
const schemaSql = () => readFileSync(SCHEMA_PATH, "utf8");

// The citizens table EXACTLY as it stood before 0012, written out rather than
// derived, so this test still means something after schema.sql moves on.
const CITIZENS_BEFORE_0012 = `
CREATE TABLE IF NOT EXISTS citizens (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  handle       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  model        TEXT NOT NULL,
  secret_hash  TEXT NOT NULL,
  karma        INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);`;

// Ordered, NOT sorted: order is the thing under test.
function columnsInOrder(db: InstanceType<typeof DatabaseSync>, table: string): string[] {
  return (db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[]).map((r) => r.name);
}
function foreignKeys(db: InstanceType<typeof DatabaseSync>, table: string): unknown[] {
  return db.prepare(`SELECT * FROM pragma_foreign_key_list(?)`).all(table);
}
function objectsOfType(db: InstanceType<typeof DatabaseSync>, type: "table" | "index"): Set<string> {
  return new Set((db.prepare(`SELECT name FROM sqlite_master WHERE type = ?`).all(type) as { name: string }[]).map((r) => r.name));
}

test("0012 is NOT self-contained: on an empty database it fails, because it alters citizens", () => {
  const db = new DatabaseSync(":memory:");
  try {
    assert.throws(
      () => db.exec(migrationSql()),
      /no such table: citizens/i,
      "0012 carries an ALTER TABLE and therefore depends on citizens existing. Recording this deliberately: 0008-0010 were self-contained and this one is not, so it must never be described as the same shape.",
    );
  } finally {
    db.close();
  }
});

test("migrating the pre-0012 schema lands on exactly what schema.sql builds, column order included", () => {
  const migrated = new DatabaseSync(":memory:");
  const fresh = new DatabaseSync(":memory:");
  try {
    migrated.exec(CITIZENS_BEFORE_0012);
    migrated.exec(migrationSql());
    fresh.exec(schemaSql());

    assert.deepEqual(
      columnsInOrder(migrated, "citizens"),
      columnsInOrder(fresh, "citizens"),
      "schema.sql and migration 0012 must produce the same citizens table IN THE SAME ORDER. ALTER TABLE ADD COLUMN appends, so public_key must be listed LAST in schema.sql; if this fails, the operator's production table and the test harness's table have quietly diverged.",
    );
    assert.equal(columnsInOrder(migrated, "citizens").at(-1), "public_key", "public_key must be the appended, final column");

    assert.deepEqual(columnsInOrder(migrated, "auth_nonces"), columnsInOrder(fresh, "auth_nonces"));
  } finally {
    migrated.close();
    fresh.close();
  }
});

test("0012 is additive: it adds one column and one table, and disturbs nothing else", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(CITIZENS_BEFORE_0012);
    db.exec(`CREATE TABLE IF NOT EXISTS bystander (id INTEGER PRIMARY KEY, note TEXT);`);
    db.prepare("INSERT INTO bystander (note) VALUES (?)").run("untouched");
    db.prepare(
      "INSERT INTO citizens (handle, model, secret_hash, karma, created_at, last_seen_at) VALUES (?,?,?,0,?,?)",
    ).run("legacy-bearer", "claude-sonnet-5", "deadbeef", 1, 1);

    const tablesBefore = objectsOfType(db, "table");
    db.exec(migrationSql());
    const tablesAfter = objectsOfType(db, "table");

    const added = [...tablesAfter].filter((t) => !tablesBefore.has(t));
    const removed = [...tablesBefore].filter((t) => !tablesAfter.has(t));
    assert.deepEqual(added, ["auth_nonces"], "exactly one table is added");
    assert.deepEqual(removed, [], "no table is dropped -- citizens is NOT rebuilt (L-016: eleven FKs reference it)");

    // The existing row survived, and its new column is NULL, which is the
    // permanent, meaningful state for a legacy bearer citizen.
    const row = db.prepare("SELECT handle, secret_hash, public_key FROM citizens WHERE handle = ?").get("legacy-bearer") as {
      handle: string;
      secret_hash: string;
      public_key: string | null;
    };
    assert.equal(row.secret_hash, "deadbeef", "an existing citizen's credential is untouched");
    assert.equal(row.public_key, null, "an existing citizen becomes a NULL-public_key bearer citizen, not a broken one");
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM bystander").get() as { n: number }).n, 1);
  } finally {
    db.close();
  }
});

test("auth_nonces carries NO foreign key, which is the whole L-016 point", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(schemaSql());
    assert.deepEqual(
      foreignKeys(db, "auth_nonces"),
      [],
      "auth_nonces.citizen_id is an attribution pointer, deliberately not an FK: this is the hottest write path in the codebase and an FK would put it inside the citizens FK graph that 0012 exists to stay out of.",
    );
    assert.ok(objectsOfType(db, "index").has("idx_auth_nonces_expiry"), "the GC index must exist");
  } finally {
    db.close();
  }
});

test("re-applying 0012 fails LOUDLY and changes nothing -- it is not idempotent and does not pretend to be", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(CITIZENS_BEFORE_0012);
    db.exec(migrationSql());
    const columnsAfterFirst = columnsInOrder(db, "citizens");

    assert.throws(
      () => db.exec(migrationSql()),
      /duplicate column name/i,
      "SQLite has no ADD COLUMN IF NOT EXISTS. A second apply must fail loudly rather than half-succeed. Migrations 0001, 0002 and 0006 share this property.",
    );
    assert.deepEqual(columnsInOrder(db, "citizens"), columnsAfterFirst, "the failed re-apply changed nothing");
  } finally {
    db.close();
  }
});

test("the nonce store round-trips, and a replayed nonce is refused by the PRIMARY KEY itself", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(schemaSql());
    const insert = db.prepare("INSERT INTO auth_nonces (nonce, citizen_id, expires_at) VALUES (?,?,?)");
    insert.run("abcdefghijklmnop", 7, 1787900120000);

    const got = db.prepare("SELECT citizen_id, expires_at FROM auth_nonces WHERE nonce = ?").get("abcdefghijklmnop") as {
      citizen_id: number;
      expires_at: number;
    };
    assert.equal(got.citizen_id, 7);
    assert.equal(got.expires_at, 1787900120000);

    // The INSERT is the replay check. Not SELECT-then-INSERT, which is
    // check-then-act and loses the race under concurrency.
    assert.throws(
      () => insert.run("abcdefghijklmnop", 7, 1787900120000),
      /UNIQUE constraint failed|PRIMARY KEY/i,
      "a replayed nonce must collide on the primary key -- that collision IS the replay defence",
    );

    // And the GC predicate the index exists for actually selects.
    db.prepare("DELETE FROM auth_nonces WHERE expires_at < ?").run(1787900200000);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM auth_nonces").get() as { n: number }).n, 0, "expired nonces are collectable");
  } finally {
    db.close();
  }
});
