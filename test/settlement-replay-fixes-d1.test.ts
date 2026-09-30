// The hub's fix pass on the settlement replay guard (2026-09-30 rulings on docs/CHECKPOINT-SETTLEMENT-REPLAY-GUARD.md's
// collected OPEN FOR HUB list):
//   F1  a registration whose handle another seat took AFTER payment is told the truth, recorded permanently, skipped by
//       the reconciler and answered (never re-attempted) on a re-send;
//   F2  the reconciler releases a listing_pay reservation when it moves the claim to expired or refused, in the SAME batch;
//   F3  the concierge keeps first claim: order sweep -> concierge -> reconciler -> clerk (see the reconcile test file);
//   F4  the backstop wording states the daily, limited pass, and the "repeat this request" clause appears only where a
//       re-send really re-checks or finishes the row.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { insertCitizen } from "./helpers/local-d1.ts";
import { insertListing, insertSubmission } from "./helpers/local-d1.ts";
import { declareTestWallet } from "./helpers/wallet-pin.ts";
import { atomicFromCents } from "./helpers/x402-payload.ts";
import { handlePayListing } from "../src/listings.ts";
import { claimKeyFromPayload, markExpired, getClaim } from "../src/settlement-claims.ts";
import {
  TEST_PAYER,
  TX,
  authStateAnswer,
  callWorker,
  captureLog,
  count,
  createLocalD1,
  eventLines,
  json,
  oneClaim,
  paymentHeaderFor,
  realPublicKey,
  registerHeader,
  registerReq,
  stubFacilitator,
  testEnv,
  type LocalD1,
} from "./helpers/settlement-harness.ts";
import { runReconciler } from "../src/settlement-reconcile.ts";
import { finishRegistration } from "../src/register-gate.ts";
import type { ClaimRow } from "../src/settlement-claims.ts";

const settledAnswer = () => new Response(JSON.stringify({ success: true, payer: TEST_PAYER, transaction: TX }), { status: 200, headers: { "content-type": "application/json" } });

// ---------- F1 ----------

async function handleLostAfterPayment(d1: LocalD1, publicKey: string | null) {
  // The handle is free at step 2 and at the afterVerify re-check, and is taken while /settle is in flight.
  const stub = stubFacilitator({
    settle: () => {
      insertCitizen(d1, { handle: "lost-handle" });
      return settledAnswer();
    },
  });
  const header = registerHeader();
  const body = { handle: "lost-handle", model: "m", ...(publicKey ? { public_key: publicKey } : {}) };
  const send = () => callWorker(registerReq(body, header), testEnv(d1));
  return { stub, send, header, body };
}

for (const mode of ["secret", "public-key"] as const) {
  test(`F1 (${mode} mode): a handle taken by another seat after payment is answered plainly, recorded permanently, skipped by the reconciler, and never re-attempted`, async () => {
    const d1 = createLocalD1();
    const fx = await handleLostAfterPayment(d1, mode === "secret" ? null : await realPublicKey());
    try {
      const { value: first, lines } = await captureLog(() => fx.send());
      assert.equal(first.status, 409);
      const answer = await json(first);
      assert.equal(answer.code, "registration_handle_taken_after_payment");
      const text = String(answer.error);
      // (a) the wording: the tx, the handle, what happened, that re-sending cannot book it, the way out, no new signature invited
      assert.ok(text.includes(TX), "names the tx");
      assert.ok(text.includes('"lost-handle"'), "names the handle");
      assert.match(text, /payment settled/);
      assert.match(text, /taken by another seat before this registration could be written/);
      assert.match(text, /Re-sending this request cannot book it and is not needed/);
      assert.match(text, /Do not sign again/);
      assert.match(text, /POST \/api\/showhome\/enter/);
      assert.match(text, /POST \/api\/showhome\/note/);
      assert.doesNotMatch(text, /Repeating this identical request|re-checks it sooner|re-attempts|once a day|06:00/, "it promises no re-check and no deadline");
      assert.equal(count(d1, "citizens WHERE handle = 'lost-handle'"), 1, "only the other seat holds the handle");
      assert.equal(count(d1, "ledger"), 1, "the payment is in the books");

      // (b) recorded permanently: state stays settled_unbooked (B2), the reason is on the claim, one log line, no generic failure line
      const row = oneClaim(d1) as unknown as { state: string; verdict_reason: string; lease_owner: string | null };
      assert.equal(row.state, "settled_unbooked");
      assert.equal(row.verdict_reason, "handle_taken");
      assert.equal(row.lease_owner, null);
      const lineCount = eventLines(lines, "registration_handle_taken_after_payment");
      assert.equal(lineCount.length, 1, "one log line when the reason is first recorded");
      assert.equal(lineCount[0].tx, TX);
      assert.equal(lineCount[0].handle_attempted, "lost-handle");
      assert.equal(eventLines(lines, "registration_paid_but_failed").length, 0, "and not also the generic failure line");

      // the reconciler does not spend budget on it: not selected, no attempt, no log
      const { value: out, lines: reconcileLines } = await captureLog(() => runReconciler(testEnv(d1)));
      assert.equal(out.examined, 0, "the reconciler skips the row");
      assert.equal(eventLines(reconcileLines, "settlement_reconcile_row_failed").length, 0);

      // (c) an identical re-send gets the same honest answer, not a re-attempt: even if the handle is free again
      d1.raw.prepare("DELETE FROM citizens WHERE handle = 'lost-handle'").run();
      const { value: again, lines: againLines } = await captureLog(() => fx.send());
      assert.equal(again.status, 409);
      assert.deepEqual(await json(again), answer, "the same answer");
      assert.equal(count(d1, "citizens"), 0, "no citizen was created by the re-send");
      assert.equal(count(d1, "ledger"), 1);
      assert.equal(eventLines(againLines, "registration_handle_taken_after_payment").length, 0, "the reason is recorded once, not per re-send");
      assert.equal(fx.stub.calls.settle, 1, "the facilitator was asked once through all of it");
    } finally {
      fx.stub.restore();
      d1.close();
    }
  });
}

test("F1 follows its own instruction (L-109): the showhome note the answer asks for, sent through the real router, lands and names the tx", async () => {
  const d1 = createLocalD1();
  const fx = await handleLostAfterPayment(d1, null);
  try {
    const first = await fx.send();
    const message = String((await json(first)).error);
    assert.match(message, /POST \/api\/showhome\/enter \(any label that is not a citizen handle\), then POST \/api\/showhome\/note/);
    // exactly as it says: enter with a label that is not a citizen handle, then leave a note naming the tx
    const entered = await callWorker(
      new Request("https://example.test/api/showhome/enter", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ handle: "payer-without-a-seat", model: "m" }) }),
      testEnv(d1),
    );
    assert.equal(entered.status, 201, JSON.stringify(await entered.clone().json()));
    const note = await callWorker(
      new Request("https://example.test/api/showhome/note", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: (await json(entered)).token, body: `I paid for the handle lost-handle and was told it was taken. tx ${TX}` }),
      }),
      testEnv(d1),
    );
    assert.ok(note.status === 200 || note.status === 201, `the note landed (${note.status})`);
    const room = await (await callWorker(new Request("https://example.test/api/showhome"), testEnv(d1))).text();
    assert.ok(room.includes(TX), "and it is on the record the maintainer reads");
  } finally {
    fx.stub.restore();
    d1.close();
  }
});

test("F1: the log line is written once even when two workers meet the same lost handle (the second finds the reason already recorded)", async () => {
  const d1 = createLocalD1();
  const fx = await handleLostAfterPayment(d1, await realPublicKey());
  try {
    assert.equal((await fx.send()).status, 409);
    const recorded = oneClaim(d1) as unknown as ClaimRow;
    assert.equal(recorded.verdict_reason, "handle_taken");
    // A worker that read the claim BEFORE the reason was recorded now attempts the citizen write with its stale copy.
    const stale = { ...recorded, verdict_reason: null } as ClaimRow;
    const { value, lines } = await captureLog(async () => {
      try {
        await finishRegistration(testEnv(d1), stale, { ip: null, inviteCode: null, deliver: true });
        return null;
      } catch (e) {
        return e as { status?: number; code?: string };
      }
    });
    assert.equal(value?.status, 409, "it still answers the honest 409");
    assert.equal(value?.code, "registration_handle_taken_after_payment");
    assert.equal(eventLines(lines, "registration_handle_taken_after_payment").length, 0, "but the reason was already recorded, so no second log line");
  } finally {
    fx.stub.restore();
    d1.close();
  }
});

// ---------- F2: the reconciler releases a pay-listing reservation with the claim's terminal update ----------

const BOUNTY = 1200;
const REVIEWER_WALLET = "0x" + "0a".repeat(20);
const REQS = { network: "base", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" };
const pendingAnswer = () => new Response(JSON.stringify({ success: false, errorReason: "settlement_pending" }), { status: 200, headers: { "content-type": "application/json" } });
const refusedAnswer = () => new Response(JSON.stringify({ success: false, errorReason: "insufficient_funds" }), { status: 200, headers: { "content-type": "application/json" } });

// A listing mid-payment whose /settle answered "pending": the pay route keeps the reservation and the claim is pending.
async function payingListing(d1: LocalD1, validBefore?: string) {
  const funderId = insertCitizen(d1);
  const reviewerId = insertCitizen(d1);
  const pin = await declareTestWallet(d1, reviewerId, REVIEWER_WALLET);
  const listingId = insertListing(d1, { funder_citizen_id: funderId, bounty_cents: BOUNTY });
  const submissionId = insertSubmission(d1, { listing_id: listingId, citizen_id: reviewerId });
  const funder = d1.raw.prepare("SELECT id, handle, model, karma, created_at, last_seen_at FROM citizens WHERE id = ?").get(funderId) as never;
  const header = paymentHeaderFor(REVIEWER_WALLET, atomicFromCents(BOUNTY), validBefore ? { validBefore } : {});
  const res = await handlePayListing(
    new Request(`https://example.test/api/listing/${listingId}/pay`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-PAYMENT": header },
      body: JSON.stringify({ submission_id: submissionId, wallet_row_id: pin.id, wallet_row_hash: pin.hash }),
    }),
    testEnv(d1),
    funder,
    listingId,
  );
  assert.equal(res.status, 502, "an unknown outcome keeps the reservation");
  const listing = () => ({ ...(d1.raw.prepare("SELECT status, paying_since, paying_wallet_row_id, paying_wallet_row_hash, paid_submission_id FROM listings WHERE id = ?").get(listingId) as Record<string, unknown>) });
  return { header, listingId, pin, listing };
}
const nonceOf = (header: string) => claimKeyFromPayload(JSON.parse(atob(header)), REQS).key.nonce;
const OPEN = { status: "open", paying_since: null, paying_wallet_row_id: null, paying_wallet_row_hash: null, paid_submission_id: null };

test("F2: a pay-listing claim that EXPIRES (chain unused, past validBefore + margin) releases the reservation back to open", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator({ settle: () => pendingAnswer(), rpc: () => authStateAnswer(false) });
  try {
    const fx = await payingListing(d1, "1000");
    assert.equal(fx.listing().status, "paying");
    assert.equal(oneClaim(d1).state, "pending");
    const out = await runReconciler(testEnv(d1));
    assert.equal(out.resolved, 1);
    assert.equal(oneClaim(d1).state, "expired");
    assert.deepEqual(fx.listing(), OPEN, "the listing is open again and carries no reservation");
    assert.equal(count(d1, "listing_payments"), 0);
    assert.equal(stub.calls.settle, 1, "an unused, expired authorisation is never re-POSTed");
  } finally {
    stub.restore();
    d1.close();
  }
});

test("F2: a pay-listing claim that is REFUSED (a recorded rule-7 answer) releases the reservation back to open", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator({ settle: (n) => (n === 1 ? pendingAnswer() : refusedAnswer()), rpc: () => authStateAnswer(false) });
  try {
    const fx = await payingListing(d1);
    const out = await runReconciler(testEnv(d1));
    assert.equal(out.resolved, 1);
    assert.equal(oneClaim(d1).state, "refused");
    assert.deepEqual(fx.listing(), OPEN);
  } finally {
    stub.restore();
    d1.close();
  }
});

test("F2: never released while pending, on an unknown answer, when the chain says SPENT, or when the chain cannot be read", async () => {
  for (const scenario of ["spent-unknown", "spent-refusal", "rpcs-disagree", "no-quorum"] as const) {
    const d1 = createLocalD1();
    const stub = stubFacilitator({
      settle: (n) => (n === 1 ? pendingAnswer() : scenario === "spent-refusal" ? refusedAnswer() : new Response("{}", { status: 500 })),
      rpc: (_u, n) => (scenario === "rpcs-disagree" ? authStateAnswer(n === 0) : scenario === "no-quorum" ? (n % 4 === 0 ? authStateAnswer(false) : null) : authStateAnswer(true)),
    });
    try {
      const fx = await payingListing(d1, "1000");
      const before = fx.listing();
      await runReconciler(testEnv(d1));
      assert.equal(oneClaim(d1).state, "pending", `${scenario}: the claim waits`);
      assert.deepEqual(fx.listing(), before, `${scenario}: the reservation is untouched`);
    } finally {
      stub.restore();
      d1.close();
    }
  }
});

test("F2: a spent authorisation is BOOKED, not released (the reservation becomes a payment)", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator({ settle: (n) => (n === 1 ? pendingAnswer() : settledAnswer()), rpc: () => authStateAnswer(true) });
  try {
    const fx = await payingListing(d1, "1000");
    const out = await runReconciler(testEnv(d1));
    assert.equal(out.booked, 1);
    assert.equal(fx.listing().status, "paid");
    assert.equal(count(d1, "listing_payments"), 1);
  } finally {
    stub.restore();
    d1.close();
  }
});

test("F2: a listing already paid, withdrawn, re-reserved later, or reserved under another pinned wallet row, is never touched", async () => {
  for (const scenario of ["paid", "re-reserved", "withdrawn", "other-pin"] as const) {
    const d1 = createLocalD1();
    const stub = stubFacilitator({ settle: () => pendingAnswer(), rpc: () => authStateAnswer(false) });
    try {
      const fx = await payingListing(d1, "1000");
      const claim = oneClaim(d1) as unknown as { created_at: number };
      if (scenario === "paid") d1.raw.prepare("UPDATE listings SET status = 'paid', paid_submission_id = 1, paid_tx = '0xother', paying_since = NULL, paying_wallet_row_id = NULL, paying_wallet_row_hash = NULL WHERE id = ?").run(fx.listingId);
      if (scenario === "re-reserved") d1.raw.prepare("UPDATE listings SET paying_since = ? WHERE id = ?").run(claim.created_at + 60_000, fx.listingId);
      if (scenario === "withdrawn") d1.raw.prepare("UPDATE listings SET status = 'withdrawn' WHERE id = ?").run(fx.listingId);
      // reserved again under a DIFFERENT pinned wallet row (the payee changed wallet; another payer's reservation)
      if (scenario === "other-pin") d1.raw.prepare("UPDATE listings SET paying_wallet_row_id = paying_wallet_row_id + 1000 WHERE id = ?").run(fx.listingId);
      const before = fx.listing();
      await runReconciler(testEnv(d1));
      assert.equal(oneClaim(d1).state, "expired", `${scenario}: the claim itself still expires`);
      assert.deepEqual(fx.listing(), before, `${scenario}: the listing is exactly as it was`);
    } finally {
      stub.restore();
      d1.close();
    }
  }
});

test("F2: the release and the claim's terminal update are ONE batch: if the release cannot be written, the claim does not expire", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator({ settle: () => pendingAnswer(), rpc: () => authStateAnswer(false) });
  try {
    const fx = await payingListing(d1, "1000");
    d1.raw.exec("CREATE TRIGGER no_release BEFORE UPDATE ON listings WHEN NEW.status = 'open' BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END;");
    const { value: out, lines } = await captureLog(() => runReconciler(testEnv(d1)));
    assert.equal(out.failed, 1, "the row failed loudly");
    assert.equal(eventLines(lines, "settlement_reconcile_row_failed").length, 1);
    assert.equal(oneClaim(d1).state, "pending", "the claim did not move without its release");
    assert.equal(fx.listing().status, "paying");
    d1.raw.exec("DROP TRIGGER no_release");
    assert.equal((await runReconciler(testEnv(d1))).resolved, 1, "and the next run does both");
    assert.deepEqual(fx.listing(), OPEN);
  } finally {
    stub.restore();
    d1.close();
  }
});

test("F2: a worker that LOST the race to move the claim releases nothing (the release is tied to this batch's claim update by changes() = 1)", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator({ settle: () => pendingAnswer(), rpc: () => authStateAnswer(false) });
  try {
    const fx = await payingListing(d1, "1000");
    const row = (await getClaim(testEnv(d1), { network: "base", asset: REQS.asset.toLowerCase(), from: TEST_PAYER, nonce: nonceOf(fx.header) })) as ClaimRow;
    const key = { network: row.network, asset: row.asset, from: row.from_addr, nonce: row.nonce };
    assert.equal(await markExpired(testEnv(d1), key, Date.now(), row), true);
    assert.deepEqual(fx.listing(), OPEN);
    // a person puts the listing back under the same pinned reservation, earlier than the claim: a stale second worker must not undo it
    d1.raw
      .prepare("UPDATE listings SET status = 'paying', paying_since = ?, paying_wallet_row_id = ?, paying_wallet_row_hash = ? WHERE id = ?")
      .run(row.created_at - 1, fx.pin.id, fx.pin.hash, fx.listingId);
    const before = fx.listing();
    assert.equal(await markExpired(testEnv(d1), key, Date.now(), row), false, "the claim was already terminal");
    assert.deepEqual(fx.listing(), before, "the second worker released nothing");
  } finally {
    stub.restore();
    d1.close();
  }
});
