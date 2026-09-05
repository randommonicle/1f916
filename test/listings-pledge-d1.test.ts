// D1-backed tests for M2 of the funder non-payment mitigations
// (D-059 / drafts/SPEC-FUNDER-MITIGATIONS-2026-09-04.md): the optional,
// allow-listed pay-pledge on a listing. A self-declared promise the society
// SERVES and never ENFORCES.
//
// Three parts:
//   1. migration 0013 rehearsed off-line against real node:sqlite -- additive
//      ADD COLUMN (the L-016-safe shape, no rebuild), the schema.sql/migration
//      drift detector, existing rows left NULL, and the ALTER's once-only
//      nature made explicit.
//   2. assertValidPledge, the free (D-042) allowlist validator, as a unit.
//   3. the write/read path end to end through handleCreateListing +
//      getListingDetail + listListings, with the x402 facilitator stubbed
//      exactly as listings-d1.test.ts stubs it.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createLocalD1, insertCitizen, type LocalD1 } from "./helpers/local-d1.ts";
import { handleCreateListing, getListingDetail, listListings, assertValidPledge } from "../src/listings.ts";
import { SocietyError, type Env } from "../src/society.ts";

// ---------- part 1: migration 0013 rehearsal ----------

const MIGRATION_0009 = join(import.meta.dirname, "..", "migrations", "0009_listings.sql");
const MIGRATION_0013 = join(import.meta.dirname, "..", "migrations", "0013_listing_pledge.sql");
const SCHEMA_PATH = join(import.meta.dirname, "..", "schema.sql");
const read = (p: string) => readFileSync(p, "utf8");

// Just enough of citizens for 0009's foreign keys to resolve (mirrors
// listings-migration-d1.test.ts's own minimal fixture).
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

function listingsColumns(db: InstanceType<typeof DatabaseSync>): string[] {
  return (db.prepare("SELECT name FROM pragma_table_info('listings')").all() as { name: string }[]).map((r) => r.name).sort();
}
// No migration between 0009 and 0013 touches listings, so the pre-0013 table is
// exactly what 0009 builds.
function pre0013(db: InstanceType<typeof DatabaseSync>) {
  db.exec(MINIMAL_CITIZENS_TABLE);
  db.exec(read(MIGRATION_0009));
}

test("0013 adds exactly the pledge column to listings, nullable TEXT, and nothing else", () => {
  const db = new DatabaseSync(":memory:");
  try {
    pre0013(db);
    const before = listingsColumns(db);
    assert.ok(!before.includes("pledge"), "pre-0013 listings must NOT have pledge");

    db.exec(read(MIGRATION_0013));
    const after = listingsColumns(db);
    assert.deepEqual(
      after.filter((c) => !before.includes(c)),
      ["pledge"],
      "0013 adds exactly one column, pledge",
    );

    const info = db.prepare(`SELECT "type", "notnull", "dflt_value" FROM pragma_table_info('listings') WHERE name = 'pledge'`).get() as {
      type: string;
      notnull: number;
      dflt_value: unknown;
    };
    assert.equal(info.type, "TEXT");
    assert.equal(info.notnull, 0, "pledge must be nullable");
    assert.equal(info.dflt_value, null, "pledge must have no default (NULL)");
  } finally {
    db.close();
  }
});

test("0013 leaves an existing listing row untouched, reading pledge = NULL", () => {
  const db = new DatabaseSync(":memory:");
  try {
    pre0013(db);
    db.prepare("INSERT INTO citizens (handle, model, secret_hash, created_at, last_seen_at) VALUES ('f','m','h',1,1)").run();
    db.prepare(
      "INSERT INTO listings (funder_citizen_id, title, description, acceptance_condition, bounty_cents, fee_cents, fee_tx, expires_at, created_at) VALUES (1,'t','d','a',100,50,'0xtx',9,1)",
    ).run();

    db.exec(read(MIGRATION_0013));
    const row = db.prepare("SELECT pledge FROM listings WHERE fee_tx = '0xtx'").get() as { pledge: unknown };
    assert.equal(row.pledge, null, "a row that existed before 0013 reads pledge = NULL, never a fabricated value");
  } finally {
    db.close();
  }
});

test("0013 touches only listings -- submissions and listing_payments are unchanged", () => {
  const only09 = new DatabaseSync(":memory:");
  const with13 = new DatabaseSync(":memory:");
  try {
    pre0013(only09);
    pre0013(with13);
    with13.exec(read(MIGRATION_0013));
    for (const t of ["submissions", "listing_payments"]) {
      const a = (only09.prepare(`SELECT name FROM pragma_table_info('${t}')`).all() as { name: string }[]).map((r) => r.name).sort();
      const b = (with13.prepare(`SELECT name FROM pragma_table_info('${t}')`).all() as { name: string }[]).map((r) => r.name).sort();
      assert.deepEqual(b, a, `${t} must be identical after 0013`);
    }
  } finally {
    only09.close();
    with13.close();
  }
});

test("schema.sql and 0009+0013 build IDENTICAL listings columns (the drift detector)", () => {
  const migrationDb = new DatabaseSync(":memory:");
  const schemaDb = new DatabaseSync(":memory:");
  try {
    pre0013(migrationDb);
    migrationDb.exec(read(MIGRATION_0013));
    schemaDb.exec(read(SCHEMA_PATH));
    assert.deepEqual(
      listingsColumns(migrationDb),
      listingsColumns(schemaDb),
      "listings columns must be IDENTICAL between (0009+0013) and schema.sql -- they must never drift",
    );
    assert.ok(listingsColumns(schemaDb).includes("pledge"), "schema.sql must carry pledge (the harness loads schema.sql)");
  } finally {
    migrationDb.close();
    schemaDb.close();
  }
});

test("0013 is once-only: re-applying it throws (duplicate column), so it is not idempotent and must run exactly once", () => {
  const db = new DatabaseSync(":memory:");
  try {
    pre0013(db);
    db.exec(read(MIGRATION_0013)); // first apply: adds pledge
    assert.throws(() => db.exec(read(MIGRATION_0013)), /duplicate column/i, "a second apply must throw -- ADD COLUMN is not IF NOT EXISTS");
  } finally {
    db.close();
  }
});

// ---------- part 2: assertValidPledge (the free allowlist validator) ----------

test("assertValidPledge accepts the one allow-listed value and normalises absence to null", () => {
  assert.equal(assertValidPledge("pay_one_qualifying"), "pay_one_qualifying");
  assert.equal(assertValidPledge(undefined), null);
  assert.equal(assertValidPledge(null), null);
  assert.equal(assertValidPledge(""), null);
});

test("assertValidPledge rejects anything outside the allowlist with a 400 (the allowlist is load-bearing)", () => {
  for (const bad of ["pay_all", "PAY_ONE_QUALIFYING", "yes", 1, true, {}, []]) {
    assert.throws(
      () => assertValidPledge(bad),
      (e: unknown) => e instanceof SocietyError && e.status === 400,
      `pledge value ${JSON.stringify(bad)} must be refused with a 400`,
    );
  }
});

// ---------- part 3: the write/read path end to end ----------

const TREASURY_ADDRESS = "0xa7f7985eb19b8c44f12a0654df1ef89d1dd527c9";
const FACILITATOR_URL = "https://facilitator.example.invalid";

function testEnv(d1: LocalD1): Env {
  return { DB: d1.DB, TREASURY_ADDRESS, FACILITATOR_URL, REGISTRATION_MODE: "open" } as unknown as Env;
}

function fakePaymentHeader(): string {
  return btoa(JSON.stringify({ fake: "payment-payload-for-a-test-stub" }));
}

function listingCreateRequest(bodyOverrides: Record<string, unknown> = {}, withPayment = true): Request {
  const now = Date.now();
  const body = {
    title: "Review my auth middleware",
    description: "Stuck on token refresh, please review for race conditions",
    acceptance_condition: "a reviewer identifies at least one real correctness issue or confirms none exist",
    bounty_cents: 1000,
    expires_at: now + 7 * 86_400_000,
    ...bodyOverrides,
  };
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (withPayment) headers["X-PAYMENT"] = fakePaymentHeader();
  return new Request("https://example.test/api/listing", { method: "POST", headers, body: JSON.stringify(body) });
}

function stubFacilitatorFetch() {
  const original = globalThis.fetch;
  let verifyCalls = 0;
  let settleCalls = 0;
  globalThis.fetch = (async (url: unknown) => {
    const href = String(url);
    if (href === `${FACILITATOR_URL}/verify`) {
      verifyCalls++;
      return new Response(JSON.stringify({ isValid: true }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (href === `${FACILITATOR_URL}/settle`) {
      settleCalls++;
      return new Response(JSON.stringify({ success: true, payer: "0x00000000000000000000000000000000000abc", transaction: "0xfeedfeedfeed" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch: ${href}`);
  }) as typeof fetch;
  return {
    verifyCalls: () => verifyCalls,
    settleCalls: () => settleCalls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

test("handleCreateListing stores and serves a valid pledge, on both the detail and the list", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitatorFetch();
  try {
    const env = testEnv(d1);
    const funderId = insertCitizen(d1, { handle: "funder-pledge" });
    const funder = { id: funderId, handle: "funder-pledge" };

    const res = await handleCreateListing(listingCreateRequest({ pledge: "pay_one_qualifying" }), env, funder);
    assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
    const { listing_id } = (await res.json()) as { listing_id: number };

    const stored = d1.raw.prepare("SELECT pledge FROM listings WHERE id = ?").get(listing_id) as { pledge: string };
    assert.equal(stored.pledge, "pay_one_qualifying");

    const detail = await getListingDetail(env, listing_id);
    assert.equal(detail.listing.pledge, "pay_one_qualifying", "the pledge is served on the detail");

    const list = await listListings(env, "open", Number.NaN);
    const row = list.listings.find((l) => l.id === listing_id);
    assert.equal(row?.pledge, "pay_one_qualifying", "the pledge is served on the list row");
  } finally {
    stub.restore();
    d1.close();
  }
});

test("handleCreateListing without a pledge stores and serves NULL (no pledge is the default)", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitatorFetch();
  try {
    const env = testEnv(d1);
    const funderId = insertCitizen(d1, { handle: "funder-nopledge" });
    const funder = { id: funderId, handle: "funder-nopledge" };

    const res = await handleCreateListing(listingCreateRequest({}), env, funder);
    assert.equal(res.status, 201);
    const { listing_id } = (await res.json()) as { listing_id: number };

    const detail = await getListingDetail(env, listing_id);
    assert.equal(detail.listing.pledge, null, "an unpledged listing serves pledge: null, not a fabricated value");
  } finally {
    stub.restore();
    d1.close();
  }
});

test("handleCreateListing refuses an invalid pledge FREE -- 400 before any facilitator call, no listing row", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitatorFetch();
  try {
    const env = testEnv(d1);
    const funderId = insertCitizen(d1, { handle: "funder-badpledge" });
    const funder = { id: funderId, handle: "funder-badpledge" };

    await assert.rejects(
      () => handleCreateListing(listingCreateRequest({ pledge: "pay_everyone" }), env, funder),
      (e: unknown) => e instanceof SocietyError && e.status === 400,
      "an invalid pledge is a 400",
    );
    // The whole point of validating free (D-042): the refusal costs nothing.
    assert.equal(stub.verifyCalls(), 0, "no facilitator verify on a free refusal");
    assert.equal(stub.settleCalls(), 0, "no facilitator settle on a free refusal");
    const count = d1.raw.prepare("SELECT COUNT(*) AS n FROM listings").get() as { n: number };
    assert.equal(count.n, 0, "no listing row is written when the pledge is refused");
  } finally {
    stub.restore();
    d1.close();
  }
});
