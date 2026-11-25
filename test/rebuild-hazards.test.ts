// Reproductions of two table-rebuild hazards named in public on 11 Aug 2026 (1f916 post 480, comment 5200: "reproductions to follow in the repo when the wave lands"). The wave landed on
// 18 Aug as migrations/0007_first_laws.sql; these are late. They run on plain SQLite (node:sqlite), from the migrations' own text, and prove what SQLite does, not what D1 does.
//
// The third class named there (deferred foreign-key enforcement needing its explicit end) is NOT here: node:sqlite passes the shape that failed on D1, so a test of it here would be green on the
// broken shape. The written record of that failure is the header of migrations/0007_first_laws.sql.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

const sql = (name: string) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8").replace(/--.*$/gm, "");
// One statement of a migration, by its first words; there must be exactly one.
function statement(text: string, start: string): string {
  const found = text.split(";").map((s) => s.trim()).filter((s) => s.replace(/\s+/g, " ").startsWith(start));
  assert.equal(found.length, 1, `exactly one statement starts with: ${start}`);
  return found[0]!;
}
const m5 = sql("0005_governance.sql");
const m6 = sql("0006_freeze_eligibility.sql");
const m7 = sql("0007_first_laws.sql");
const LIVE = [
  statement(m5, "CREATE TABLE IF NOT EXISTS proposals"),
  statement(m6, "ALTER TABLE proposals ADD COLUMN registration_mode"),
  statement(m6, "ALTER TABLE proposals ADD COLUMN founding_ratified"),
];
const CREATE_NEW = statement(m7, "CREATE TABLE proposals_new");
const NAMED_COPY = statement(m7, "INSERT INTO proposals_new");
const DROP = statement(m7, "DROP TABLE proposals");
const RENAME = statement(m7, "ALTER TABLE proposals_new RENAME TO proposals");
const POSITIONAL_COPY = "INSERT INTO proposals_new SELECT * FROM proposals";

type Row = Record<string, unknown>;
// The table as it stood live before 0007. Foreign keys are off: neither hazard is about them.
function live() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = OFF");
  for (const s of LIVE) db.exec(s);
  const insert = (tally: Row = {}) =>
    Number(
      db
        .prepare("INSERT INTO proposals (kind, title, body, payload, proposer_id, post_id, opened_at, closes_at, status, tally_yes, tally_no, tally_abstain, eligible_count, tallied_at, created_at) VALUES ('resolution', 't', 'b', NULL, 7, 9, 100, 200, ?, ?, ?, ?, ?, ?, 101)")
        .run((tally.status as string) ?? "open", (tally.yes as number) ?? null, (tally.no as number) ?? null, (tally.abstain as number) ?? null, (tally.eligible as number) ?? null, (tally.at as number) ?? null).lastInsertRowid,
    );
  const rows = (table: string): Row[] => db.prepare(`SELECT * FROM ${table} ORDER BY id`).all().map((r) => ({ ...r }));
  const columns = (table: string) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => (c as { name: string }).name);
  const seq = () => (db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'proposals'").get() as { seq: number }).seq;
  return { db, insert, rows, columns, seq };
}
const DECIDED = { status: "failed", yes: 3, no: 1, abstain: 2, eligible: 13, at: 205 };

test("class 1, the cause: the live table and its replacement hold the same columns in different orders", () => {
  const t = live();
  t.db.exec(CREATE_NEW);
  const before = t.columns("proposals");
  const after = t.columns("proposals_new");
  assert.deepEqual([...before].sort(), [...after].sort(), "the same eighteen names");
  assert.notDeepEqual(before, after);
  assert.equal(before.indexOf("tally_yes"), after.indexOf("registration_mode"), "a positional copy binds tally_yes into registration_mode");
  t.db.close();
});

test("class 1, reproduced: a positional copy of a DECIDED proposal succeeds, keeps the row count, and is wrong in every column after status", () => {
  const t = live();
  t.insert(DECIDED);
  const [was] = t.rows("proposals");
  t.db.exec(CREATE_NEW);
  t.db.exec(POSITIONAL_COPY);
  const copied = t.rows("proposals_new");
  assert.equal(copied.length, 1, "row-count parity holds, so a count check passes");
  const [now] = copied;
  assert.deepEqual(
    { registration_mode: now!.registration_mode, founding_ratified: now!.founding_ratified, tally_yes: now!.tally_yes, tally_no: now!.tally_no, tally_abstain: now!.tally_abstain, eligible_count: now!.eligible_count, tallied_at: now!.tallied_at, created_at: now!.created_at },
    // yes 3, no 1, abstain 2 of 13 eligible, tallied at 205, created at 101, becomes:
    { registration_mode: "3", founding_ratified: 1, tally_yes: 2, tally_no: 13, tally_abstain: 205, eligible_count: 101, tallied_at: "invite_only", created_at: 0 },
  );
  const wrong = Object.keys(was!).filter((k) => was![k] !== now![k]);
  assert.deepEqual(wrong.sort(), ["created_at", "eligible_count", "founding_ratified", "registration_mode", "tallied_at", "tally_abstain", "tally_no", "tally_yes"]);
  t.db.close();
});

test("class 1, its limit: a positional copy of an OPEN proposal is refused by NOT NULL, loudly, because its tally is still NULL", () => {
  const t = live();
  t.insert();
  t.db.exec(CREATE_NEW);
  assert.throws(() => t.db.exec(POSITIONAL_COPY), /NOT NULL constraint failed: proposals_new\.registration_mode/);
  assert.equal(t.rows("proposals_new").length, 0);
  t.db.close();
});

test("class 1, the copy 0007 ships: named columns on both sides carry every value, decided and open", () => {
  const t = live();
  t.insert(DECIDED);
  t.insert();
  const was = t.rows("proposals");
  t.db.exec(CREATE_NEW);
  t.db.exec(NAMED_COPY);
  assert.equal(was.length, 2);
  for (const [i, row] of t.rows("proposals_new").entries()) for (const k of Object.keys(was[i]!)) assert.equal(row[k], was[i]![k], k);
  t.db.close();
});

// Class 3. Proposal creation commits the row first and deletes it again if the debate post cannot be made (src/governance.ts), so the highest id ever given can have no row.
function withDeletedHighest() {
  const t = live();
  for (let i = 0; i < 3; i++) t.insert();
  t.db.exec("DELETE FROM proposals WHERE id = 3");
  return t;
}
const rebuild = (db: DatabaseSync) => {
  for (const s of [CREATE_NEW, NAMED_COPY, DROP, RENAME]) db.exec(s);
};

test("class 3, the control: without a rebuild AUTOINCREMENT does not give a deleted highest id out again", () => {
  const t = withDeletedHighest();
  assert.equal(t.seq(), 3);
  assert.equal(t.insert(), 4);
  t.db.close();
});

test("class 3, reproduced: 0007's own rebuild of proposals forgets the deleted highest id, and the next proposal is given it again", () => {
  const t = withDeletedHighest();
  const was = t.rows("proposals");
  rebuild(t.db);
  assert.deepEqual(t.rows("proposals").map((r) => r.id), was.map((r) => r.id), "every surviving row kept its id");
  assert.equal(t.seq(), 2, "the mark is the largest id copied, not the largest ever given");
  assert.equal(t.insert(), 3, "id 3 was given before and is given again");
  t.db.close();
});

test("class 3, its limit: where the highest id still has its row, the same rebuild loses nothing", () => {
  const t = live();
  for (let i = 0; i < 3; i++) t.insert();
  t.db.exec("DELETE FROM proposals WHERE id = 2");
  rebuild(t.db);
  assert.equal(t.seq(), 3);
  assert.equal(t.insert(), 4);
  t.db.close();
});
