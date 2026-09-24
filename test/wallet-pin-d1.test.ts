// The server-side wallet pin (DEFERRED-SERVER-SIDE-WALLET-PIN,
// docs/BRIEF-SERVER-SIDE-WALLET-PIN.md including amendments A1-A9; Ben's
// rulings 2026-09-23: the pin is REQUIRED, A4 ships in the same wave).
//
// Parts:
//   1. migration 0016 rehearsed off-line against real node:sqlite: four
//      additive nullable columns, existing rows left NULL (brief §6 test 7),
//      and the ALTER's once-only nature made explicit.
//   2. walletAddressFromRow, the exact inverse of walletLogEntry (test 6), and
//      its parity with the pay script's own parser on one fixture set.
//   3. the pay route end to end (tests 1-5, 10, 11, A5's per-clause refusals),
//      with the x402 facilitator stubbed exactly as listings-d1.test.ts
//      stubs it.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { walletAddressFromRow, walletLogEntry } from "../src/wallets.ts";
import { walletRowAddress } from "../scripts/pay-listing.mjs";

// ---------- part 1: migration 0016 rehearsal ----------

const MIGRATIONS = join(import.meta.dirname, "..", "migrations");
const read = (name: string) => readFileSync(join(MIGRATIONS, name), "utf8");

// Just enough of citizens for 0009's foreign keys to resolve (mirrors
// listings-pledge-d1.test.ts's own minimal fixture).
const MINIMAL_CITIZENS_TABLE = `
CREATE TABLE citizens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  handle TEXT NOT NULL UNIQUE COLLATE NOCASE,
  model TEXT NOT NULL,
  secret_hash TEXT NOT NULL,
  karma INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);`;

function columns(db: InstanceType<typeof DatabaseSync>, table: string): string[] {
  return (db.prepare("SELECT name FROM pragma_table_info(?)").all(table) as { name: string }[]).map((r) => r.name).sort();
}

// The listings tables exactly as production has them before 0016: 0009, then
// 0013 and 0014 (no other migration touches them).
function pre0016(): InstanceType<typeof DatabaseSync> {
  const db = new DatabaseSync(":memory:");
  db.exec(MINIMAL_CITIZENS_TABLE);
  db.exec(read("0009_listings.sql"));
  db.exec(read("0013_listing_pledge.sql"));
  db.exec(read("0014_listing_paying_since.sql"));
  return db;
}

test("0016 adds exactly four nullable columns -- two on listings, two on listing_payments -- and touches nothing else", () => {
  const db = pre0016();
  try {
    const before = { listings: columns(db, "listings"), listing_payments: columns(db, "listing_payments"), submissions: columns(db, "submissions") };
    db.exec(read("0016_wallet_pin.sql"));
    assert.deepEqual(columns(db, "listings").filter((c) => !before.listings.includes(c)), ["paying_wallet_row_hash", "paying_wallet_row_id"]);
    assert.deepEqual(columns(db, "listing_payments").filter((c) => !before.listing_payments.includes(c)), ["wallet_row_hash", "wallet_row_id"]);
    assert.deepEqual(columns(db, "submissions"), before.submissions, "submissions untouched");
    for (const [t, c, type] of [["listings", "paying_wallet_row_id", "INTEGER"], ["listings", "paying_wallet_row_hash", "TEXT"], ["listing_payments", "wallet_row_id", "INTEGER"], ["listing_payments", "wallet_row_hash", "TEXT"]]) {
      const info = db.prepare(`SELECT "type", "notnull", "dflt_value" FROM pragma_table_info(?) WHERE name = ?`).get(t, c) as { type: string; notnull: number; dflt_value: unknown };
      assert.equal(info.type, type, `${t}.${c} type`);
      assert.equal(info.notnull, 0, `${t}.${c} is nullable`);
      assert.equal(info.dflt_value, null, `${t}.${c} has no default`);
    }
  } finally {
    db.close();
  }
});

test("0016 on a DB that already holds a paid listing and a paying one: every existing row reads NULL in the new columns (brief §6 test 7)", () => {
  const db = pre0016();
  try {
    const now = Date.now();
    db.prepare("INSERT INTO citizens (handle, model, secret_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)").run("funder", "m", "h", now, now);
    db.prepare("INSERT INTO citizens (handle, model, secret_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)").run("payee", "m", "h", now, now);
    const insListing = db.prepare("INSERT INTO listings (funder_citizen_id, title, description, acceptance_condition, bounty_cents, fee_cents, fee_tx, status, expires_at, created_at, paying_since) VALUES (1, 't', 'd', 'a', 1200, 100, '0xfee', ?, ?, ?, ?)");
    insListing.run("paid", now + 86_400_000, now, null);
    insListing.run("paying", now + 86_400_000, now, now - 1000);
    db.prepare("INSERT INTO submissions (listing_id, citizen_id, body, status, created_at) VALUES (1, 2, 'review', 'open', ?)").run(now);
    db.prepare("INSERT INTO listing_payments (listing_id, submission_id, payee_citizen_id, payee_address, payer_address, amount_cents, tx, created_at) VALUES (1, 1, 2, ?, ?, 1200, '0xabc', ?)").run("0x" + "b".repeat(40), "0x" + "c".repeat(40), now);

    db.exec(read("0016_wallet_pin.sql"));

    const listings = db.prepare("SELECT status, paying_since, paying_wallet_row_id, paying_wallet_row_hash FROM listings ORDER BY id").all() as { status: string; paying_since: number | null; paying_wallet_row_id: number | null; paying_wallet_row_hash: string | null }[];
    assert.equal(listings.length, 2);
    for (const l of listings) {
      assert.equal(l.paying_wallet_row_id, null, `${l.status}: no checked row recorded before the check existed`);
      assert.equal(l.paying_wallet_row_hash, null);
    }
    assert.equal(listings[1].paying_since, now - 1000, "0016 leaves 0014's column alone");
    const pay = db.prepare("SELECT amount_cents, wallet_row_id, wallet_row_hash FROM listing_payments").get() as { amount_cents: number; wallet_row_id: number | null; wallet_row_hash: string | null };
    assert.equal(pay.amount_cents, 1200, "the existing book row is intact");
    assert.equal(pay.wallet_row_id, null, "a row paid before the check carries NULL, as the served note says");
    assert.equal(pay.wallet_row_hash, null);
  } finally {
    db.close();
  }
});

test("0016 is once-only: applied a second time it FAILS (duplicate column), which is why the deploy script reads the catalogue first", () => {
  const db = pre0016();
  try {
    db.exec(read("0016_wallet_pin.sql"));
    assert.throws(() => db.exec(read("0016_wallet_pin.sql")), /duplicate column/i);
  } finally {
    db.close();
  }
});

// ---------- part 2: the address helper (test 6) and its parity with the script ----------

const A = "0x" + "a1".repeat(20);
const B = "0x" + "b2".repeat(20);

test("walletAddressFromRow: the exact inverse of walletLogEntry, for both kinds -- a change gives the NEW address, never the previous one", () => {
  const declared = walletLogEntry(null, A);
  const changed = walletLogEntry(A, B);
  assert.equal(walletAddressFromRow(declared.kind, declared.detail), A);
  assert.equal(walletAddressFromRow(changed.kind, changed.detail), B);
  assert.notEqual(walletAddressFromRow(changed.kind, changed.detail), A, "the previous address must never read as current");
});

// Every shape the application writes, and the malformed ones a hand edit could
// leave. `app` marks what walletLogEntry can produce; for those the server and
// the script MUST agree exactly.
const FIXTURES: { kind: string; detail: string; server: string | null; script: string | null; note: string }[] = [
  { kind: "wallet_declared", detail: `wallet declared: ${A}`, server: A, script: A, note: "app: declaration" },
  { kind: "wallet_changed", detail: `wallet changed: ${A} -> ${B}`, server: B, script: B, note: "app: change" },
  { kind: "wallet_declared", detail: `wallet declared: ${A} `, server: null, script: null, note: "trailing space" },
  { kind: "wallet_declared", detail: `wallet declared: ${A.slice(0, 41)}`, server: null, script: null, note: "39 hex digits" },
  { kind: "wallet_changed", detail: `wallet changed: ${B}`, server: null, script: null, note: "change without an arrow" },
  { kind: "wallet_changed", detail: `wallet changed: ${A} ->${B}`, server: null, script: null, note: "arrow spacing" },
  { kind: "wallet_declared", detail: `wallet changed: ${A} -> ${B}`, server: null, script: null, note: "kind and detail disagree" },
  { kind: "wallet_changed", detail: `wallet declared: ${A}`, server: null, script: null, note: "kind and detail disagree, the other way" },
  { kind: "key_rotated", detail: `wallet declared: ${A}`, server: null, script: null, note: "not a wallet kind" },
  { kind: "wallet_declared", detail: "", server: null, script: null, note: "empty detail" },
  // The one deliberate difference: a mixed-case address cannot be written by
  // the application (normalizeAddress lowercases first). The server refuses it
  // (null -> wallet_row_address); the script lowercases it and would then be
  // refused by the server anyway. Stricter on the server is the safe side.
  { kind: "wallet_declared", detail: `wallet declared: ${A.toUpperCase().replace("0X", "0x")}`, server: null, script: A, note: "mixed case (not app-producible)" },
];

test("walletAddressFromRow and the pay script's walletRowAddress agree on every application-written shape and every malformed one; the only difference is the stated mixed-case case", () => {
  for (const f of FIXTURES) {
    assert.equal(walletAddressFromRow(f.kind, f.detail), f.server, `server, ${f.note}`);
    assert.equal(walletRowAddress({ kind: f.kind, detail: f.detail }), f.script, `script, ${f.note}`);
    if (f.note.startsWith("app:") || f.server === null && f.script === null) {
      assert.equal(walletAddressFromRow(f.kind, f.detail), walletRowAddress({ kind: f.kind, detail: f.detail }), `parity, ${f.note}`);
    }
  }
});
