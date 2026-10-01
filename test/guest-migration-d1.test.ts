// Migration 0018 (the guest voice): proven against a real SQLite engine (node:sqlite, the engine
// test/helpers/local-d1.ts uses) and the committed schema.sql. The real-D1 --remote rehearsal is the
// operator's deploy-time step (scripts/deploy-guest-voice.ps1 applies it BEFORE the worker and reads the
// catalogue after); this proves everything provable off-line: the migration is additive (no existing table
// is touched, exactly three tables are added), builds exactly the documented catalogue, carries no foreign
// key (the L-016 class), enforces its own invariants as CHECKs and unique indexes, and is the same block as
// the one at the end of schema.sql.
//
// Test 1 of docs/BRIEF-GUEST-VOICE.md. Every check below can fail: `catalogueOffenders` is run on a
// deliberately mutated migration (one that touches `comments`, one that adds a fourth table) and must report
// them, so a checker that cannot go red cannot pass quietly (prove-it-can-fail).
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");
const norm = (s: string) => s.replace(/\r\n/g, "\n");
const migrationSql = () => norm(readFileSync(join(ROOT, "migrations", "0018_guest_voice.sql"), "utf8"));
const schemaSql = () => norm(readFileSync(join(ROOT, "schema.sql"), "utf8"));

const GUEST_TABLES = ["guest_duty_runs", "guest_thread", "guests"] as const;
const GUEST_BLOCK_START = "CREATE TABLE IF NOT EXISTS guest_thread";
const SCHEMA_GUEST_HEADER = "-- The guest voice (migrations/0018_guest_voice.sql";

// schema.sql as it stood before this wave: everything above the guest block's own header comment.
function preGuestSchema(): string {
  const s = schemaSql();
  const i = s.indexOf(SCHEMA_GUEST_HEADER);
  assert.ok(i > 0, "schema.sql carries the guest block's header comment");
  return s.slice(0, i);
}

type Db = InstanceType<typeof DatabaseSync>;

interface Catalogue {
  tables: Map<string, { sql: string; columns: string; indexes: string[] }>;
}

function catalogue(db: Db): Catalogue {
  const rows = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name != 'sqlite_sequence' ORDER BY name").all() as { name: string; sql: string }[];
  const tables = new Map<string, { sql: string; columns: string; indexes: string[] }>();
  for (const r of rows) {
    const columns = JSON.stringify(db.prepare("SELECT cid, name, type, \"notnull\", dflt_value, pk FROM pragma_table_info(?) ORDER BY cid").all(r.name));
    const indexes = (db.prepare("SELECT name FROM pragma_index_list(?) ORDER BY name").all(r.name) as { name: string }[]).map((i) => i.name);
    tables.set(r.name, { sql: r.sql, columns, indexes });
  }
  return { tables };
}

// Applies `migration` on top of the pre-0018 schema and returns every way it differs from "exactly three
// tables added, nothing existing touched". Empty means additive.
function catalogueOffenders(migration: string): string[] {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(preGuestSchema());
    const before = catalogue(db);
    db.exec(migration);
    const after = catalogue(db);
    const offenders: string[] = [];
    for (const [name, was] of before.tables) {
      const now = after.tables.get(name);
      if (!now) {
        offenders.push(`table ${name} disappeared`);
        continue;
      }
      if (now.sql !== was.sql) offenders.push(`table ${name}: its CREATE statement changed`);
      if (now.columns !== was.columns) offenders.push(`table ${name}: its columns changed`);
      if (JSON.stringify(now.indexes) !== JSON.stringify(was.indexes)) offenders.push(`table ${name}: its indexes changed`);
    }
    const added = [...after.tables.keys()].filter((n) => !before.tables.has(n)).sort();
    if (JSON.stringify(added) !== JSON.stringify([...GUEST_TABLES])) offenders.push(`tables added are [${added.join(", ")}], expected [${GUEST_TABLES.join(", ")}]`);
    return offenders;
  } finally {
    db.close();
  }
}

test("1: 0018 is additive: every existing table's CREATE statement, columns and indexes are unchanged and exactly guest_duty_runs, guest_thread and guests are added", () => {
  assert.deepEqual(catalogueOffenders(migrationSql()), []);
});

test("1 (red): the checker goes red on a migration that touches comments, one that adds a fourth table, and one that drops an index", () => {
  const touchesComments = catalogueOffenders(migrationSql() + "\nALTER TABLE comments ADD COLUMN guest_flag INTEGER;\n");
  assert.ok(touchesComments.some((o) => o.startsWith("table comments")), `a migration that alters comments must be reported, got ${JSON.stringify(touchesComments)}`);
  const fourthTable = catalogueOffenders(migrationSql() + "\nCREATE TABLE IF NOT EXISTS guest_extra (id INTEGER PRIMARY KEY);\n");
  assert.ok(fourthTable.some((o) => o.startsWith("tables added")), `a fourth table must be reported, got ${JSON.stringify(fourthTable)}`);
  const dropsIndex = catalogueOffenders(migrationSql() + "\nDROP INDEX IF EXISTS idx_comments_post;\n");
  assert.ok(dropsIndex.some((o) => o.startsWith("table comments")), `a dropped index on an existing table must be reported, got ${JSON.stringify(dropsIndex)}`);
});

test("1: on an EMPTY database the migration alone builds exactly the three tables and its documented indexes, and references no existing table", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(migrationSql());
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name != 'sqlite_sequence' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    assert.deepEqual(tables, [...GUEST_TABLES]);
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_guest_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    assert.deepEqual(indexes, [
      "idx_guest_thread_author",
      "idx_guest_thread_due",
      "idx_guest_thread_idem",
      "idx_guest_thread_kind_day",
      "idx_guest_thread_parent",
      "idx_guest_thread_post",
    ]);
  } finally {
    db.close();
  }
});

test("1: the three tables have exactly their documented columns, in order", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(migrationSql());
    const cols = (t: string) => (db.prepare("SELECT name FROM pragma_table_info(?) ORDER BY cid").all(t) as { name: string }[]).map((r) => r.name);
    assert.deepEqual(cols("guest_thread"), ["id", "post_id", "parent_kind", "parent_id", "depth", "author_kind", "author_id", "handle", "model", "kind", "body", "mod_state", "duty", "due_at", "created_at", "idem_key"]);
    assert.deepEqual(cols("guest_duty_runs"), ["id", "run_at", "open_count", "overdue_count", "oldest_due_at", "overdue_ids"]);
    assert.deepEqual(cols("guests"), ["id", "visitor_id", "token_hash", "handle", "model", "created_at"]);
  } finally {
    db.close();
  }
});

// The L-016 property: not one of the three tables carries a foreign key, so the migration stays out of
// the defer_foreign_keys class that rolled 0007 back on real D1.
test("1: none of the three tables carries a foreign key (the additive, no-FK guarantee)", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(migrationSql());
    for (const t of GUEST_TABLES) {
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM pragma_foreign_key_list(?)").get(t)!.n, 0, `${t} must have zero foreign keys`);
    }
    // positive control: the same pragma sees a real foreign key on a table that has one.
    const full = new DatabaseSync(":memory:");
    try {
      full.exec(schemaSql());
      assert.ok((full.prepare("SELECT COUNT(*) AS n FROM pragma_foreign_key_list('comments')").get() as { n: number }).n > 0, "the pragma finds comments' foreign keys, so a zero above means something");
    } finally {
      full.close();
    }
  } finally {
    db.close();
  }
});

test("1: schema.sql carries the migration's block byte for byte (CRLF-normalised), at its very end", () => {
  const mig = migrationSql();
  const block = mig.slice(mig.indexOf(GUEST_BLOCK_START));
  assert.ok(block.length > 500, "the migration's block was found");
  const schema = schemaSql();
  assert.ok(schema.endsWith(block), "schema.sql ends with exactly the migration's block");
  // red: one changed character in the schema's copy is caught by the same comparison.
  assert.ok(!(schema.replace("idem_key     TEXT,", "idem_key     TEXT ,") ).endsWith(block), "a one-character drift in either copy fails the comparison");
});

test("1: 0018 is idempotent on top of the full schema (no error, no catalogue change)", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(schemaSql());
    const before = JSON.stringify([...catalogue(db).tables]);
    db.exec(migrationSql());
    assert.equal(JSON.stringify([...catalogue(db).tables]), before);
  } finally {
    db.close();
  }
});

test("the table's own invariants are structural: parent coherence, hidden-state values, a duty only on a guest row with a due date, and one idempotency key per author", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(migrationSql());
    const insert = (over: Record<string, unknown>) => {
      const row = { post_id: 1, parent_kind: null, parent_id: null, depth: 0, author_kind: "guest", author_id: 1, handle: "h", model: "m", kind: "comment", body: "b", mod_state: null, duty: 0, due_at: null, created_at: 1, idem_key: null, ...over };
      const cols = Object.keys(row);
      db.prepare(`INSERT INTO guest_thread (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...(Object.values(row) as never[]));
    };
    insert({});
    insert({ parent_kind: "thread", parent_id: 1 });
    assert.throws(() => insert({ parent_kind: "thread", parent_id: null }), /CHECK/, "a parent kind with no parent id is refused");
    assert.throws(() => insert({ parent_kind: null, parent_id: 3 }), /CHECK/, "a parent id with no parent kind is refused");
    assert.throws(() => insert({ parent_kind: "post", parent_id: 3 }), /CHECK/, "only 'comment' and 'thread' are parent kinds");
    assert.throws(() => insert({ mod_state: "hidden" }), /CHECK/, "a hidden row is 'collapsed' or 'removed'");
    insert({ mod_state: "collapsed" });
    assert.throws(() => insert({ duty: 1 }), /CHECK/, "a duty needs a due date");
    assert.throws(() => insert({ duty: 1, due_at: 5, author_kind: "citizen" }), /CHECK/, "a citizen row can never carry a duty");
    assert.throws(() => insert({ duty: 2, due_at: 5 }), /CHECK/, "duty is 0 or 1");
    insert({ duty: 1, due_at: 5 });
    assert.throws(() => insert({ author_kind: "visitor" }), /CHECK/, "author_kind is 'guest' or 'citizen'");
    assert.throws(() => insert({ kind: "praise" }), /CHECK/, "kind is 'comment' or 'critique'");
    insert({ author_kind: "citizen", author_id: 1, idem_key: "k1" });
    assert.throws(() => insert({ author_kind: "citizen", author_id: 1, idem_key: "k1" }), /UNIQUE/, "one idempotency key per author");
    insert({ author_kind: "citizen", author_id: 2, idem_key: "k1" });
    insert({ author_kind: "citizen", author_id: 1, idem_key: null });
    insert({ author_kind: "citizen", author_id: 1, idem_key: null });
    db.prepare("INSERT INTO guests (visitor_id, token_hash, handle, model, created_at) VALUES (4, 'H', 'a', 'm', 1)").run();
    assert.throws(() => db.prepare("INSERT INTO guests (visitor_id, token_hash, handle, model, created_at) VALUES (4, 'H2', 'a', 'm', 1)").run(), /UNIQUE/, "one guests row per visitor");
    assert.throws(() => db.prepare("INSERT INTO guests (visitor_id, token_hash, handle, model, created_at) VALUES (5, 'H', 'a', 'm', 1)").run(), /UNIQUE/, "one guests row per token");
  } finally {
    db.close();
  }
});
