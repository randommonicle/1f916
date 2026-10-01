// The settlement replay guard on the two listing doors (docs/BRIEF-SETTLEMENT-REPLAY-GUARD.md
// B3: "the open -> paying reservation and the claim INSERT succeed or fail together"; test 10),
// and the same booking-from-the-claim guarantees as registration for listing creation and the
// bounty payment. Harness: test/helpers/settlement-harness.ts.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { insertCitizen, insertListing, insertSubmission } from "./helpers/local-d1.ts";
import { declareTestWallet } from "./helpers/wallet-pin.ts";
import { atomicFromCents } from "./helpers/x402-payload.ts";
import {
  TEST_PAYER,
  TREASURY_ADDRESS,
  TX,
  count,
  createLocalD1,
  dropTrigger,
  failInserts,
  oneClaim,
  paymentHeaderFor,
  stubFacilitator,
  testEnv,
  type LocalD1,
} from "./helpers/settlement-harness.ts";
import { handleCreateListing, handlePayListing, computeListingFeeCents, finishPayListingBooking, finishListingCreateBooking } from "../src/listings.ts";
import { claimIdentity, claimKeyFromPayload, getClaim, takeClaim, keyOfRow, type ClaimRow } from "../src/settlement-claims.ts";

const REQS = { network: "base", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" };

async function loadCitizen(d1: LocalD1, id: number) {
  return d1.raw.prepare("SELECT id, handle, model, karma, created_at, last_seen_at FROM citizens WHERE id = ?").get(id) as {
    id: number;
    handle: string;
    model: string;
    karma: number;
    created_at: number;
    last_seen_at: number;
  };
}

// handlePayListing and handleCreateListing are called directly (no router), so a SocietyError
// surfaces as a throw; this reads either shape as { status, body }.
async function answer(fn: () => Promise<Response>): Promise<{ status: number; body: Record<string, any> }> {
  try {
    const res = await fn();
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  } catch (e) {
    const err = e as { status?: number; message?: string };
    return { status: err.status ?? 0, body: { error: err.message ?? String(e) } };
  }
}

const BOUNTY = 1200;
const REVIEWER_WALLET = "0x" + "0a".repeat(20);

async function payFixture(d1: LocalD1) {
  const funderId = insertCitizen(d1);
  const reviewerId = insertCitizen(d1);
  const pin = await declareTestWallet(d1, reviewerId, REVIEWER_WALLET);
  const listingId = insertListing(d1, { funder_citizen_id: funderId, bounty_cents: BOUNTY });
  const submissionId = insertSubmission(d1, { listing_id: listingId, citizen_id: reviewerId });
  const funder = await loadCitizen(d1, funderId);
  const pay = (header: string) =>
    answer(() =>
      handlePayListing(
        new Request(`https://example.test/api/listing/${listingId}/pay`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-PAYMENT": header },
          body: JSON.stringify({ submission_id: submissionId, wallet_row_id: pin.id, wallet_row_hash: pin.hash }),
        }),
        testEnv(d1),
        funder,
        listingId,
      ),
    );
  const header = () => paymentHeaderFor(REVIEWER_WALLET, atomicFromCents(BOUNTY));
  const listing = () => ({ ...(d1.raw.prepare("SELECT status, paying_since, paid_tx FROM listings WHERE id = ?").get(listingId) as { status: string; paying_since: number | null; paid_tx: string | null }) });
  return { pay, header, listing, listingId, submissionId, funder };
}

const claimOfHeader = async (d1: LocalD1, header: string) => {
  const { key } = claimKeyFromPayload(JSON.parse(atob(header)), REQS);
  return (await getClaim(testEnv(d1), key)) as ClaimRow;
};

test("10a. pay listing: a claim conflict AFTER the reservation leaves the listing open (the reservation is released, no settle was sent)", async () => {
  const d1 = createLocalD1();
  let stub = stubFacilitator();
  try {
    const fx = await payFixture(d1);
    const header = fx.header();
    stub.restore();
    // Another request takes this signed authorisation's claim while this one is in /verify: the consult
    // (before /verify) found nothing, so the conflict surfaces only at the INSERT, after the reservation.
    const { key, validBefore } = claimKeyFromPayload(JSON.parse(atob(header)), REQS);
    stub = stubFacilitator({
      onVerify: () =>
        void d1.raw
          .prepare(
            "INSERT INTO settlement_claims (network, asset, from_addr, nonce, route, intent_json, intent_hash, rpc_body, rpc_body_hash, valid_before, state, booked_refs, created_at, updated_at) VALUES (?, ?, ?, ?, 'patron', '{}', 'x', '{}', 'y', ?, 'pending', '{}', 1, 1)",
          )
          .run(key.network, key.asset, key.from, key.nonce, validBefore),
    });
    const res = await fx.pay(header);
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.code, "settlement_claim_conflict");
    assert.equal(stub.calls.verify, 1, "it was verified, because the conflict is found after the reservation");
    assert.equal(stub.calls.settle, 0, "and never settled");
    assert.deepEqual(fx.listing(), { status: "open", paying_since: null, paid_tx: null }, "the reservation taken in afterVerify was released, not kept as if a settle were in flight");
    assert.equal(count(d1, "settlement_claims"), 1, "only the other request's claim exists");
    assert.equal(count(d1, "listing_payments"), 0);
  } finally {
    stub.restore();
    d1.close();
  }
});

test("10a'. pay listing: a divergent claim found BEFORE /verify is answered from the claim with no facilitator call at all (consult-first)", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator();
  try {
    const fx = await payFixture(d1);
    const header = fx.header();
    const payload = JSON.parse(atob(header));
    const { key, validBefore } = claimKeyFromPayload(payload, REQS);
    const spec = { route: "patron" as const, intent: { line: "someone else's" } };
    const id = await claimIdentity(key, validBefore, { paymentPayload: payload, other: true }, spec);
    assert.deepEqual(await takeClaim(testEnv(d1), id, spec, "seed", Date.now()), { taken: true });
    const res = await fx.pay(header);
    assert.equal(res.status, 409);
    assert.equal(res.body.code, "settlement_claim_conflict");
    assert.deepEqual(stub.calls, { verify: 0, settle: 0 });
    assert.equal(fx.listing().status, "open", "never reserved");
  } finally {
    stub.restore();
    d1.close();
  }
});

test("10b. pay listing, the other order: a reservation that fails takes NO claim, and leaves the listing as it was", async () => {
  const d1 = createLocalD1();
  let stub = stubFacilitator();
  try {
    const fx = await payFixture(d1);
    const header = fx.header();
    stub.restore();
    // The listing is mid-payment by someone else when this request's reservation runs (after /verify).
    stub = stubFacilitator({ onVerify: () => void d1.raw.prepare("UPDATE listings SET status = 'paying', paying_since = 1 WHERE id = ?").run(fx.listingId) });
    const res = await fx.pay(header);
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(stub.calls.settle, 0);
    assert.equal(count(d1, "settlement_claims"), 0, "a reservation refusal takes no claim");
    assert.deepEqual(fx.listing(), { status: "paying", paying_since: 1, paid_tx: null }, "the other payer's reservation is untouched");
  } finally {
    stub.restore();
    d1.close();
  }
});

test("10c. pay listing: a recording failure is finished exactly once from the claim; a replayed header is refused with no second settle", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator();
  try {
    const fx = await payFixture(d1);
    const header = fx.header();
    failInserts(d1, "no_payment_row", "listing_payments", null, "disk I/O error");
    const first = await fx.pay(header);
    assert.equal(first.status, 500, JSON.stringify(first.body));
    assert.match(String(first.body.error), /payment settled \(tx 0xabab.*recording it failed/i);
    assert.match(String(first.body.error), /one pass a day, at 06:00 UTC, and works a limited number of unresolved payments per pass, oldest attempt first, so a payment can wait more than one day/, "the daily, limited pass is named (B6a, F4)");
    assert.doesNotMatch(String(first.body.error), /Repeating this identical request/, "F4: a pay-listing answer never tells the funder to repeat: the reservation answers a re-send first");
    assert.equal(oneClaim(d1).state, "settled_unbooked");
    assert.equal(fx.listing().status, "paying", "the reservation stays: a tombstone no retry can pass");
    assert.equal(count(d1, "listing_payments"), 0);
    dropTrigger(d1, "no_payment_row");

    // The reconciler's entry point books it from the claim: one payment row, the listing paid, the claim booked.
    const row = await claimOfHeader(d1, header);
    await finishPayListingBooking(testEnv(d1), row, "test-reconciler");
    await finishPayListingBooking(testEnv(d1), (await getClaim(testEnv(d1), keyOfRow(row))) as ClaimRow, "test-reconciler");
    assert.equal(count(d1, "listing_payments"), 1, "booked once, however many times the finisher runs");
    assert.deepEqual(fx.listing(), { status: "paid", paying_since: null, paid_tx: TX });
    const done = oneClaim(d1);
    assert.equal(done.state, "booked");
    assert.equal(done.rpc_body, null);
    const payment = d1.raw.prepare("SELECT payer_address, payee_address, amount_cents, tx, wallet_row_id FROM listing_payments").get() as Record<string, unknown>;
    assert.equal(payment.payer_address, TEST_PAYER);
    assert.equal(payment.payee_address, REVIEWER_WALLET);
    assert.equal(payment.amount_cents, BOUNTY);
    assert.equal(payment.tx, TX);

    const replay = await fx.pay(header);
    assert.equal(replay.status, 409, "a paid listing refuses a replay");
    assert.equal(stub.calls.settle, 1, "through all of it the facilitator was asked once");
  } finally {
    stub.restore();
    d1.close();
  }
});

test("10d. pay listing: the booking is gated on the listing still being paying: a released listing books nothing, and the claim stays for a person", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator();
  try {
    const fx = await payFixture(d1);
    const header = fx.header();
    failInserts(d1, "no_payment_row", "listing_payments", null, "disk I/O error");
    assert.equal((await fx.pay(header)).status, 500);
    dropTrigger(d1, "no_payment_row");
    d1.raw.prepare("UPDATE listings SET status = 'open', paying_since = NULL WHERE id = ?").run(fx.listingId); // a person released it
    const row = await claimOfHeader(d1, header);
    await assert.rejects(() => finishPayListingBooking(testEnv(d1), row, "test-reconciler"), /recording it failed/);
    assert.equal(count(d1, "listing_payments"), 0, "no payment row for a listing that is not paying");
    assert.equal(fx.listing().status, "open", "the listing is not flipped to paid");
    assert.equal(oneClaim(d1).state, "settled_unbooked");
    assert.equal(oneClaim(d1).booked_refs, "{}", "and the claim records nothing it did not write");
  } finally {
    stub.restore();
    d1.close();
  }
});

// ---------- listing create ----------

const listingBody = (bounty: number) => ({
  title: "Review my auth middleware",
  description: "Stuck on token refresh, please review for race conditions",
  acceptance_condition: "a reviewer identifies at least one real correctness issue or confirms none exist",
  bounty_cents: bounty,
  expires_at: Date.now() + 7 * 86_400_000,
});

test("listing create: one claim, one fee line, one listing; a failure after settle is finished once by the funder's identical re-send; a replay is 409", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator();
  try {
    const funder = await loadCitizen(d1, insertCitizen(d1));
    const header = paymentHeaderFor(TREASURY_ADDRESS, atomicFromCents(computeListingFeeCents(1000)));
    const body = listingBody(1000);
    const send = () =>
      answer(() =>
        handleCreateListing(
          new Request("https://example.test/api/listing", { method: "POST", headers: { "Content-Type": "application/json", "X-PAYMENT": header }, body: JSON.stringify(body) }),
          testEnv(d1),
          funder,
        ),
      );

    // The ledger write fails after settle, then the listing write fails after the ledger: two resume points.
    failInserts(d1, "no_fee_line", "ledger", null, "disk I/O error");
    const a = await send();
    assert.equal(a.status, 500);
    assert.equal(count(d1, "listings"), 0);
    assert.equal(oneClaim(d1).state, "settled_unbooked");
    dropTrigger(d1, "no_fee_line");

    failInserts(d1, "no_listing_row", "listings", null, "disk I/O error");
    const b = await send();
    assert.equal(b.status, 500);
    assert.match(String(b.body.error), /posting fee settled .* but the listing failed to save/);
    assert.match(String(b.body.error), /one pass a day, at 06:00 UTC, and works a limited number of unresolved payments per pass, oldest attempt first, so a payment can wait more than one day/, "the daily, limited pass is named (B6a, F4)");
    assert.match(String(b.body.error), /Repeating this identical request re-checks it sooner\./, "listing creation's re-send really finishes it, and the next request below proves it");
    assert.equal(count(d1, "ledger"), 1, "the fee line was booked by the re-send, once");
    assert.equal(count(d1, "listings"), 0);
    dropTrigger(d1, "no_listing_row");

    const c = await send();
    assert.equal(c.status, 201, JSON.stringify(c.body));
    assert.equal(typeof c.body.listing_id, "number");
    assert.equal(c.body.fee_tx, TX);
    assert.equal(c.body.receipt, (d1.raw.prepare("SELECT hash FROM ledger").get() as { hash: string }).hash, "the receipt is the one fee line's hash");
    assert.equal(count(d1, "listings"), 1);
    assert.equal(count(d1, "ledger"), 1);
    assert.equal(oneClaim(d1).state, "booked");

    const d = await send();
    assert.equal(d.status, 409, "a replay of a booked listing is refused");
    assert.equal(count(d1, "listings"), 1);
    assert.equal(count(d1, "ledger"), 1);
    assert.equal(stub.calls.settle, 1, "the facilitator was asked once through all four requests");

    // and the reconciler's entry point is a no-op on a booked claim
    await finishListingCreateBooking(testEnv(d1), d1.raw.prepare("SELECT * FROM settlement_claims").get() as unknown as ClaimRow, "test-reconciler");
    assert.equal(count(d1, "listings"), 1);
    assert.equal(count(d1, "ledger"), 1);
  } finally {
    stub.restore();
    d1.close();
  }
});
