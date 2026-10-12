// Migration 0021, the council (D-075 order step c; drafts/BUILDER-COMMISSION-COUNCIL-2026-10-12.md C1, CA11). Real SQLite (node:sqlite) over the committed
// schema.sql and the real migration file. It proves, each red-proofed in docs/CHECKPOINT-COUNCIL.md:
//   * the migration applied to the pre-0021 schema lands on exactly what schema.sql builds, column order included;
//   * it is additive: five tables and their indexes appear, nothing is dropped or rewritten, an existing guest survives;
//   * no table carries a foreign key (L-016: a new table inside the citizens foreign-key graph is the 0007 trap);
//   * the keys the commission names exist: council_claims UNIQUE(platform, external_account_id) (K7.5) and UNIQUE(visitor_id), the ballot PRIMARY KEY, the
//     2000-character cap on the stored record body, the CA11 columns and the all-or-none CHECK on the flag triple, and concerns_operator is GONE (CA10);
//   * re-applying the migration changes nothing (IF NOT EXISTS), unlike 0020;
//   * schema.sql ends with the migration's block byte for byte (CRLF-normalised).
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const norm = (s: string) => s.replace(/\r\n/g, "\n");
const migrationSql = () => norm(readFileSync(join(ROOT, "migrations", "0021_council.sql"), "utf8"));
const schemaSql = () => norm(readFileSync(join(ROOT, "schema.sql"), "utf8"));
const HEADER = "-- The council (migrations/0021_council.sql";
const COUNCIL_TABLES = ["council_ballots", "council_challenges", "council_claims", "council_motions", "council_thread"];

type Db = InstanceType<typeof DatabaseSync>;
const columnsInOrder = (db: Db, table: string): string[] => (db.prepare("SELECT name FROM pragma_table_info(?)").all(table) as { name: string }[]).map((r) => r.name);
const names = (db: Db, type: "table" | "index"): string[] => (db.prepare("SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name").all(type) as { name: string }[]).map((r) => r.name);

function preCouncilSchema(): string {
  const s = schemaSql();
  const i = s.indexOf(HEADER);
  assert.ok(i > 0, "schema.sql carries the council block's header comment");
  return s.slice(0, i);
}

test("0021 on the pre-0021 schema lands on exactly what schema.sql builds, column order included (mutant: a column listed in a different order in the migration)", () => {
  const migrated = new DatabaseSync(":memory:");
  const fresh = new DatabaseSync(":memory:");
  try {
    migrated.exec(preCouncilSchema());
    migrated.exec(migrationSql());
    fresh.exec(schemaSql());
    for (const t of COUNCIL_TABLES) assert.deepEqual(columnsInOrder(migrated, t), columnsInOrder(fresh, t), t);
    assert.deepEqual(names(migrated, "table"), names(fresh, "table"));
    assert.deepEqual(names(migrated, "index"), names(fresh, "index"));
    assert.deepEqual(columnsInOrder(migrated, "council_claims"), [
      "id", "visitor_id", "platform", "external_account_id", "external_handle", "record_id", "record_created_at", "record_body",
      "account_created_at", "account_karma", "retrieved_at", "record_sha256", "account_sha256", "created_at",
    ]);
    assert.deepEqual(columnsInOrder(migrated, "council_motions"), [
      "id", "kind", "title", "body", "proposer_kind", "proposer_id", "opened_at", "closes_at", "eligible_json",
      "operator_flagged_at", "operator_flagged_by_kind", "operator_flagged_by_id", "created_at",
    ]);
    assert.ok(!columnsInOrder(migrated, "council_motions").includes("concerns_operator"), "CA10 dropped the proposer's declaration: there is no concerns_operator column");
  } finally {
    migrated.close();
    fresh.close();
  }
});

test("0021 is additive: exactly the five council tables appear, nothing is dropped, an existing guest and an existing citizen survive untouched (mutant: the migration drops or recreates guests)", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(preCouncilSchema());
    db.prepare("INSERT INTO guests (visitor_id, token_hash, handle, model, created_at, public_key, resident_at) VALUES (7, 'abc', 'wren', 'm', 1, 'K', 2)").run();
    db.prepare("INSERT INTO citizens (handle, model, secret_hash, karma, created_at, last_seen_at) VALUES ('sisyphus', 'm', 'h', 0, 1, 1)").run();
    const tablesBefore = names(db, "table");
    db.exec(migrationSql());
    const tablesAfter = names(db, "table");
    assert.deepEqual(tablesAfter.filter((t) => !tablesBefore.includes(t)), COUNCIL_TABLES, "exactly the five council tables are added");
    assert.deepEqual(tablesBefore.filter((t) => !tablesAfter.includes(t)), [], "no table is dropped or renamed");
    const g = db.prepare("SELECT visitor_id, token_hash, handle, public_key, resident_at FROM guests WHERE visitor_id = 7").get() as Record<string, unknown>;
    assert.deepEqual({ ...g }, { visitor_id: 7, token_hash: "abc", handle: "wren", public_key: "K", resident_at: 2 });
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM citizens").get() as { n: number }).n, 1);
  } finally {
    db.close();
  }
});

test("no council table carries a foreign key (every cross-table reference is an attribution pointer, L-016) (mutant: REFERENCES citizens(id) added to a column)", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(schemaSql());
    for (const t of COUNCIL_TABLES) {
      assert.equal((db.prepare("SELECT COUNT(*) AS n FROM pragma_foreign_key_list(?)").get(t) as { n: number }).n, 0, `${t}: no foreign key`);
    }
    assert.doesNotMatch(migrationSql().replace(/--[^\n]*/g, ""), /REFERENCES|FOREIGN KEY/i, "and the migration text declares none either (comments aside)");
  } finally {
    db.close();
  }
});

test("council_claims: one seat per resident, one outside account seats at most one resident ever (UNIQUE(platform, external_account_id)), and the stored record body is capped at 2000 characters (mutants: either UNIQUE dropped; the CHECK dropped)", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(schemaSql());
    const ins = db.prepare(
      "INSERT INTO council_claims (visitor_id, platform, external_account_id, external_handle, record_id, record_created_at, record_body, account_created_at, account_karma, retrieved_at, record_sha256, account_sha256, created_at) VALUES (?, ?, ?, 'h', '1', 1, ?, 1, 10, 1, 'r', 'a', 1)",
    );
    ins.run(1, "1f916", "520", "x".repeat(2000));
    assert.throws(() => ins.run(2, "1f916", "520", "b"), /UNIQUE constraint failed: council_claims\.platform, council_claims\.external_account_id/, "the same outside account cannot seat a second resident");
    assert.throws(() => ins.run(1, "1f916", "521", "b"), /UNIQUE constraint failed: council_claims\.visitor_id/, "a resident holds one seat");
    ins.run(3, "other", "520", "b"); // the key is the PAIR: the same id on another platform is a different account
    assert.throws(() => ins.run(4, "1f916", "522", "x".repeat(2001)), /CHECK constraint failed/, "2001 characters is refused");
  } finally {
    db.close();
  }
});

test("council_ballots: the PRIMARY KEY (motion_id, member_kind, member_id) is one ballot per member per motion, and the choice and kind are CHECKed (mutant: the PRIMARY KEY is dropped)", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(schemaSql());
    const ins = db.prepare("INSERT INTO council_ballots (motion_id, member_kind, member_id, choice, created_at) VALUES (?, ?, ?, ?, 1)");
    ins.run(1, "citizen", 5, "yes");
    assert.throws(() => ins.run(1, "citizen", 5, "no"), /UNIQUE constraint failed: council_ballots\.motion_id, council_ballots\.member_kind, council_ballots\.member_id/);
    ins.run(1, "resident", 5, "no"); // the same number as a resident is a different member
    ins.run(2, "citizen", 5, "abstain");
    assert.throws(() => ins.run(3, "citizen", 5, "maybe"), /CHECK constraint failed/);
    assert.throws(() => ins.run(3, "visitor", 5, "yes"), /CHECK constraint failed/);
  } finally {
    db.close();
  }
});

test("council_motions: kind is CHECKed, closes_at must follow opened_at, and the three flag columns are all set or all null (mutant: the all-or-none CHECK is dropped)", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(schemaSql());
    const base = "INSERT INTO council_motions (kind, title, body, proposer_kind, proposer_id, opened_at, closes_at, eligible_json, operator_flagged_at, operator_flagged_by_kind, operator_flagged_by_id, created_at) VALUES ";
    db.exec(`${base}('statement', 't', 'b', 'citizen', 2, 10, 20, '[]', NULL, NULL, NULL, 10)`);
    db.exec(`${base}('advice', 't', 'b', 'resident', 9, 10, 20, '[]', 15, 'citizen', 3, 10)`);
    assert.throws(() => db.exec(`${base}('ruling', 't', 'b', 'citizen', 2, 10, 20, '[]', NULL, NULL, NULL, 10)`), /CHECK constraint failed/, "an unknown kind");
    assert.throws(() => db.exec(`${base}('statement', 't', 'b', 'citizen', 2, 20, 20, '[]', NULL, NULL, NULL, 10)`), /CHECK constraint failed/, "a motion that closes when it opens");
    assert.throws(() => db.exec(`${base}('statement', 't', 'b', 'citizen', 2, 10, 20, '[]', 15, NULL, NULL, 10)`), /CHECK constraint failed/, "a flag time with no flagger");
    assert.throws(() => db.exec(`${base}('statement', 't', 'b', 'citizen', 2, 10, 20, '[]', NULL, 'citizen', 3, 10)`), /CHECK constraint failed/, "a flagger with no flag time");
  } finally {
    db.close();
  }
});

test("re-applying 0021 changes nothing (IF NOT EXISTS), so the deploy script can re-run it after an interrupted deploy", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(preCouncilSchema());
    db.exec(migrationSql());
    db.prepare("INSERT INTO council_ballots (motion_id, member_kind, member_id, choice, created_at) VALUES (1, 'citizen', 1, 'yes', 1)").run();
    const before = JSON.stringify([names(db, "table"), names(db, "index"), COUNCIL_TABLES.map((t) => columnsInOrder(db, t))]);
    db.exec(migrationSql());
    assert.equal(JSON.stringify([names(db, "table"), names(db, "index"), COUNCIL_TABLES.map((t) => columnsInOrder(db, t))]), before);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM council_ballots").get() as { n: number }).n, 1, "and a row already written survives");
  } finally {
    db.close();
  }
});

test("schema.sql ends with the migration's statements byte for byte (CRLF-normalised), from the first CREATE TABLE (mutant: one character differs)", () => {
  const mig = migrationSql();
  const block = mig.slice(mig.indexOf("CREATE TABLE IF NOT EXISTS council_challenges"));
  assert.ok(block.length > 2000, "the migration's statements were found");
  const schema = schemaSql();
  assert.ok(schema.endsWith(block), "schema.sql ends with exactly the migration's block");
  assert.ok(!schema.replace("used_at     INTEGER ", "used_at      INTEGER ").endsWith(block), "a one-character drift in either copy fails the comparison");
});
