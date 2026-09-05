// D1-backed tests for M1 of the funder non-payment mitigations
// (D-059 / drafts/SPEC-FUNDER-MITIGATIONS-2026-09-04.md): the read-time
// funder_record aggregate that getListingDetail and listListings publish next
// to a listing, same disclosure posture as same_operator_both_sides -- state a
// fact a reader can re-derive, draw no conclusion.
//
// Every metric is pinned by a fixture row whose removal would change exactly
// one count, and three of the tests exist to make a specific SQL clause
// load-bearing (the paid_submission_id IS NULL clause, the status='open'
// clause, and the mod_state IS NULL filter), so dropping any of them turns a
// test red -- see the red-proof note at the foot of this file.
//
// Real SQLite, real schema.sql via createLocalD1; nothing about D1 is mocked.
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, insertCitizen, insertListing, insertSubmission, type LocalD1 } from "./helpers/local-d1.ts";
import { getListingDetail, listListings, FUNDER_RECORD_NOTE } from "../src/listings.ts";
import type { Env } from "../src/society.ts";

function readEnv(d1: LocalD1): Env {
  return { DB: d1.DB } as unknown as Env;
}

const DAY = 86_400_000;

// Seed a fully-paid listing for `funderId`, paid to `payeeId`'s wallet `addr`,
// exactly as handlePayListing would leave it: status='paid', paid_submission_id
// set, and one listing_payments row carrying the facilitator-verified payee
// address. Returns the listing id.
function paidListing(d1: LocalD1, funderId: number, payeeId: number, addr: string, expiresAt: number): number {
  const lid = insertListing(d1, { funder_citizen_id: funderId, status: "open", expires_at: expiresAt });
  const sid = insertSubmission(d1, { listing_id: lid, citizen_id: payeeId });
  d1.raw.prepare("UPDATE listings SET status = 'paid', paid_submission_id = ? WHERE id = ?").run(sid, lid);
  d1.raw
    .prepare(
      "INSERT INTO listing_payments (listing_id, submission_id, payee_citizen_id, payee_address, payer_address, amount_cents, tx, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(lid, sid, payeeId, addr, "0xpayer", 1000, "0xtx" + lid, Date.now());
  return lid;
}

const ADDR_A = "0xaaaa000000000000000000000000000000000001";
const ADDR_B = "0xbbbb000000000000000000000000000000000002";

test("getListingDetail exposes funder_record with each metric over a mixed history", async () => {
  const d1 = createLocalD1();
  try {
    const now = Date.now();
    const past = now - DAY;
    const future = now + 7 * DAY;
    const funder = insertCitizen(d1, { handle: "funder-mix" });
    const r1 = insertCitizen(d1, { handle: "rev-1" });
    const r2 = insertCitizen(d1, { handle: "rev-2" });

    paidListing(d1, funder, r1, ADDR_A, future); // paid, wallet A
    paidListing(d1, funder, r1, ADDR_A, future); // paid, wallet A again (repeat -> still 1 distinct)
    paidListing(d1, funder, r2, ADDR_B, future); // paid, wallet B
    const open = insertListing(d1, { funder_citizen_id: funder, status: "open", expires_at: future }); // live, not lapsed
    insertListing(d1, { funder_citizen_id: funder, status: "open", expires_at: past }); // lapsed: open + expired + unpaid
    insertListing(d1, { funder_citizen_id: funder, status: "open", expires_at: past, mod_state: "removed" }); // excluded entirely

    const detail = await getListingDetail(readEnv(d1), open);
    assert.deepEqual(detail.funder_record, { posted: 5, paid: 3, paid_distinct_wallets: 2, lapsed_unpaid: 1 });
    assert.equal(detail.funder_record_note, FUNDER_RECORD_NOTE);
  } finally {
    d1.close();
  }
});

test("listListings carries a per-row funder_record and the shared note, scoped per funder", async () => {
  const d1 = createLocalD1();
  try {
    const now = Date.now();
    const future = now + 7 * DAY;
    const past = now - DAY;

    const fBig = insertCitizen(d1, { handle: "funder-big" });
    const r1 = insertCitizen(d1, { handle: "big-rev" });
    paidListing(d1, fBig, r1, ADDR_A, future); // paid
    const bigOpen = insertListing(d1, { funder_citizen_id: fBig, status: "open", expires_at: future }); // the one that lists as open
    insertListing(d1, { funder_citizen_id: fBig, status: "open", expires_at: past }); // lapsed, not on the open page

    const fSmall = insertCitizen(d1, { handle: "funder-small" });
    const smallOpen = insertListing(d1, { funder_citizen_id: fSmall, status: "open", expires_at: future });

    const res = await listListings(readEnv(d1), "open", Number.NaN);
    assert.equal(res.funder_record_note, FUNDER_RECORD_NOTE);

    const bigRow = res.listings.find((l) => l.id === bigOpen);
    const smallRow = res.listings.find((l) => l.id === smallOpen);
    assert.ok(bigRow, "big funder's open listing is on the page");
    assert.ok(smallRow, "small funder's open listing is on the page");
    // Two funders on one page get their own records, not a shared/leaked one.
    assert.deepEqual(bigRow.funder_record, { posted: 3, paid: 1, paid_distinct_wallets: 1, lapsed_unpaid: 1 });
    assert.deepEqual(smallRow.funder_record, { posted: 1, paid: 0, paid_distinct_wallets: 0, lapsed_unpaid: 0 });
  } finally {
    d1.close();
  }
});

test("a paid listing never reads as lapsed_unpaid (the paid_submission_id IS NULL clause is load-bearing)", async () => {
  const d1 = createLocalD1();
  try {
    const now = Date.now();
    const past = now - DAY;
    const funder = insertCitizen(d1, { handle: "funder-paid-expired" });
    const rev = insertCitizen(d1, { handle: "pe-rev" });
    // Contrived on purpose: status stays 'open' while paid_submission_id is set,
    // so ONLY the paid_submission_id IS NULL clause keeps it out of lapsed_unpaid.
    const lid = insertListing(d1, { funder_citizen_id: funder, status: "open", expires_at: past });
    const sid = insertSubmission(d1, { listing_id: lid, citizen_id: rev });
    d1.raw.prepare("UPDATE listings SET paid_submission_id = ? WHERE id = ?").run(sid, lid);

    const detail = await getListingDetail(readEnv(d1), lid);
    assert.equal(detail.funder_record.lapsed_unpaid, 0, "an expired-but-paid listing is not a lapse");
    assert.equal(detail.funder_record.paid, 1);
  } finally {
    d1.close();
  }
});

test("a withdrawn listing never reads as lapsed_unpaid (the status='open' clause is load-bearing)", async () => {
  const d1 = createLocalD1();
  try {
    const now = Date.now();
    const past = now - DAY;
    const funder = insertCitizen(d1, { handle: "funder-withdrawn" });
    const lid = insertListing(d1, { funder_citizen_id: funder, status: "withdrawn", expires_at: past });

    const detail = await getListingDetail(readEnv(d1), lid);
    assert.equal(detail.funder_record.lapsed_unpaid, 0, "a withdrawn listing is not a lapse");
    assert.deepEqual(detail.funder_record, { posted: 1, paid: 0, paid_distinct_wallets: 0, lapsed_unpaid: 0 });
  } finally {
    d1.close();
  }
});

test("a moderated listing is excluded from every count (the mod_state IS NULL filter is load-bearing)", async () => {
  const d1 = createLocalD1();
  try {
    const now = Date.now();
    const past = now - DAY;
    const funder = insertCitizen(d1, { handle: "funder-all-moderated" });
    // The funder's only listing is removed: a reader paging /api/listings would
    // never see it, so it must count for nothing.
    const lid = insertListing(d1, { funder_citizen_id: funder, status: "open", expires_at: past, mod_state: "removed" });

    const detail = await getListingDetail(readEnv(d1), lid);
    assert.deepEqual(detail.funder_record, { posted: 0, paid: 0, paid_distinct_wallets: 0, lapsed_unpaid: 0 });
  } finally {
    d1.close();
  }
});
