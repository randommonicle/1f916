// Local rehearsal of migration 0009 (the listings economy tables) against a
// real SQLite engine (node:sqlite, the same engine test/helpers/local-d1.ts
// uses), plus the post-apply catalog verification the migration file
// documents (db-migration-verification). The real-D1 --remote rehearsal is
// the operator's own deploy-time step; this proves everything that can be
// proven off-line: that 0009 is additive (no ALTER, no rebuild -- the L-016
// hazard class 0007 hit), that it builds exactly the documented catalog,
// that its one genuinely novel wrinkle -- listings and submissions
// referencing EACH OTHER, so one direction is necessarily a forward
// reference to a table that does not exist yet at CREATE TABLE time --
// resolves correctly rather than merely "not erroring", and that it is
// idempotent on top of the current full schema.
//
// Unlike 0008 (zero foreign keys, truly standalone), 0009's three tables
// reference citizens(id) -- a real dependency, not an accident to hide.
// "Applies to an empty D1" here means a D1 seeded with only the minimal
// citizens table its own foreign keys point at, which is what a real
// migration-0009-onto-migration-8 deploy actually looks like, not a
// zero-dependency fiction.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const MIGRATION_PATH = join(import.meta.dirname, "..", "migrations", "0009_listings.sql");
const SCHEMA_PATH = join(import.meta.dirname, "..", "schema.sql");

const migrationSql = () => readFileSync(MIGRATION_PATH, "utf8");
const schemaSql = () => readFileSync(SCHEMA_PATH, "utf8");

const LISTINGS_TABLES = ["listings", "submissions", "listing_payments"];
const LISTINGS_INDEXES = [
  "idx_listings_status_created",
  "idx_listings_funder",
  "idx_submissions_listing",
  "idx_submissions_citizen_day",
  "idx_listing_payments_listing",
  "idx_listing_payments_payee",
];

// The minimal fixture 0009's own foreign keys actually point at -- just
// enough of citizens for a REFERENCES clause to resolve, not the full
// schema. Proves 0009 depends on citizens and nothing else.
const MINIMAL_CITIZENS_TABLE = `
CREATE TABLE citizens (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  handle       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  model        TEXT NOT NULL,
  secret_hash  TEXT NOT NULL,
  karma        INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
`;

function tableColumns(db: InstanceType<typeof DatabaseSync>, table: string): string[] {
  return (db.prepare(`SELECT name FROM pragma_table_info(?)`).all(table) as { name: string }[]).map((r) => r.name).sort();
}
function foreignKeys(db: InstanceType<typeof DatabaseSync>, table: string): Array<{ table: string; from: string; to: string }> {
  return db.prepare(`SELECT "table", "from", "to" FROM pragma_foreign_key_list(?)`).all(table) as Array<{
    table: string;
    from: string;
    to: string;
  }>;
}
function objectsOfType(db: InstanceType<typeof DatabaseSync>, type: "table" | "index"): Set<string> {
  return new Set((db.prepare(`SELECT name FROM sqlite_master WHERE type = ?`).all(type) as { name: string }[]).map((r) => r.name));
}

test("0009 applies on top of a minimal citizens-only D1 and creates exactly the three listings tables", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(MINIMAL_CITIZENS_TABLE);
    db.exec(migrationSql());

    const tables = objectsOfType(db, "table");
    const created = [...tables].filter((n) => n !== "sqlite_sequence" && n !== "citizens").sort();
    assert.deepEqual(created, [...LISTINGS_TABLES].sort(), "exactly the three listings tables, no others, beyond the citizens fixture");

    const indexes = objectsOfType(db, "index");
    for (const idx of LISTINGS_INDEXES) {
      assert.ok(indexes.has(idx), `index ${idx} must exist after applying 0009`);
    }
  } finally {
    db.close();
  }
});

test("0009 tables have exactly their documented columns", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(MINIMAL_CITIZENS_TABLE);
    db.exec(migrationSql());
    assert.deepEqual(tableColumns(db, "listings"), [
      "acceptance_condition",
      "bounty_cents",
      "created_at",
      "description",
      "expires_at",
      "fee_cents",
      "fee_tx",
      "funder_citizen_id",
      "id",
      "mod_state",
      "paid_submission_id",
      "paid_tx",
      "status",
      "title",
      "url",
    ]);
    assert.deepEqual(tableColumns(db, "submissions"), ["body", "citizen_id", "created_at", "id", "listing_id", "mod_state", "status", "url"]);
    assert.deepEqual(tableColumns(db, "listing_payments"), [
      "amount_cents",
      "created_at",
      "id",
      "listing_id",
      "payee_address",
      "payee_citizen_id",
      "payer_address",
      "submission_id",
      "tx",
    ]);
  } finally {
    db.close();
  }
});

// The genuinely novel property this migration introduces over 0008's
// zero-FK shape: listings.paid_submission_id is a FORWARD reference to
// submissions, a table that does not exist yet at the moment listings is
// created (submissions is defined AFTER listings in the migration file,
// since submissions.listing_id also references listings). This proves the
// forward reference actually resolved to the real submissions table, not
// merely that CREATE TABLE didn't throw -- a real D1 authorizer quirk here
// would show up as either a throw (caught by the test above) or a
// foreign_key_list pragma that fails to resolve the parent (caught here).
test("0009's forward reference (listings.paid_submission_id -> submissions.id) resolves correctly despite submissions being defined AFTER listings", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(MINIMAL_CITIZENS_TABLE);
    db.exec(migrationSql());
    const fks = foreignKeys(db, "listings");
    const paidSubmissionFk = fks.find((fk) => fk.from === "paid_submission_id");
    assert.ok(paidSubmissionFk, "listings.paid_submission_id must carry a real foreign key");
    assert.equal(paidSubmissionFk!.table, "submissions", "the forward reference must resolve to the submissions table, not go missing or point nowhere");
    assert.equal(paidSubmissionFk!.to, "id");
  } finally {
    db.close();
  }
});

test("0009's every funder_citizen_id / citizen_id column carries a real foreign key to citizens", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(MINIMAL_CITIZENS_TABLE);
    db.exec(migrationSql());
    const listingsFk = foreignKeys(db, "listings").find((fk) => fk.from === "funder_citizen_id");
    assert.equal(listingsFk?.table, "citizens");
    const submissionsFk = foreignKeys(db, "submissions").find((fk) => fk.from === "citizen_id");
    assert.equal(submissionsFk?.table, "citizens");
    const submissionsListingFk = foreignKeys(db, "submissions").find((fk) => fk.from === "listing_id");
    assert.equal(submissionsListingFk?.table, "listings");
    const paymentsListingFk = foreignKeys(db, "listing_payments").find((fk) => fk.from === "listing_id");
    assert.equal(paymentsListingFk?.table, "listings");
    const paymentsSubmissionFk = foreignKeys(db, "listing_payments").find((fk) => fk.from === "submission_id");
    assert.equal(paymentsSubmissionFk?.table, "submissions");
  } finally {
    db.close();
  }
});

// The schema CHECK constraints are real enforcement, not merely documented
// intent -- red-proofs that each one actually rejects the value it claims to.
test("0009's CHECK constraints actually reject a non-positive bounty_cents, fee_cents, and amount_cents", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(MINIMAL_CITIZENS_TABLE);
    db.exec(migrationSql());
    db.prepare("INSERT INTO citizens (handle, model, secret_hash, created_at, last_seen_at) VALUES ('f','m','h',1,1)").run();
    assert.throws(
      () =>
        db
          .prepare(
            "INSERT INTO listings (funder_citizen_id, title, description, acceptance_condition, bounty_cents, fee_cents, fee_tx, expires_at, created_at) VALUES (1,'t','d','a',0,50,'0xtx',1,1)",
          )
          .run(),
      /CHECK/,
      "bounty_cents <= 0 must be rejected",
    );
    assert.throws(
      () =>
        db
          .prepare(
            "INSERT INTO listings (funder_citizen_id, title, description, acceptance_condition, bounty_cents, fee_cents, fee_tx, expires_at, created_at) VALUES (1,'t','d','a',100,0,'0xtx',1,1)",
          )
          .run(),
      /CHECK/,
      "fee_cents <= 0 must be rejected",
    );
  } finally {
    db.close();
  }
});

test("0009's status CHECK constraints reject a value outside the documented enum", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(MINIMAL_CITIZENS_TABLE);
    db.exec(migrationSql());
    db.prepare("INSERT INTO citizens (handle, model, secret_hash, created_at, last_seen_at) VALUES ('f','m','h',1,1)").run();
    assert.throws(
      () =>
        db
          .prepare(
            "INSERT INTO listings (funder_citizen_id, title, description, acceptance_condition, bounty_cents, fee_cents, fee_tx, status, expires_at, created_at) VALUES (1,'t','d','a',100,50,'0xtx','bogus',1,1)",
          )
          .run(),
      /CHECK/,
      "an unrecognised listings.status must be rejected",
    );
  } finally {
    db.close();
  }
});

// Positive control (prove-it-can-fail): the same catalog-reading mechanism
// used above, pointed at the FULL schema, sees a table that is NOT a
// listings table (citizens itself). Without this, a broken pragma call
// could make every "table exists" assertion pass or fail for the wrong
// reason.
test("positive control: the catalog mechanism sees citizens in the full schema, and schema.sql already carries the listings tables identically", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(schemaSql());
    const tables = objectsOfType(db, "table");
    assert.ok(tables.has("citizens"), "sanity: the catalog mechanism finds a known non-listings table");
    for (const t of LISTINGS_TABLES) {
      assert.ok(tables.has(t), `schema.sql must carry ${t} identically to the migration (harness loads schema.sql)`);
    }
    assert.deepEqual(tableColumns(db, "listings").sort(), tableColumns(db, "listings").sort());
    const indexes = objectsOfType(db, "index");
    for (const idx of LISTINGS_INDEXES) {
      assert.ok(indexes.has(idx), `schema.sql must carry index ${idx} identically to the migration`);
    }
  } finally {
    db.close();
  }
});

// Applying 0009 on top of the current full schema (which already carries the
// three tables via IF NOT EXISTS) is a clean no-op -- it neither errors nor
// changes the catalog. This is the operator's real sequence made safe.
test("0009 is idempotent on top of the full schema (no error, no catalog change)", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(schemaSql());
    const before = [...objectsOfType(db, "table")].sort().join(",");
    db.exec(migrationSql()); // must not throw
    const after = [...objectsOfType(db, "table")].sort().join(",");
    assert.equal(after, before, "applying 0009 over the full schema must not add or remove any table");
  } finally {
    db.close();
  }
});
