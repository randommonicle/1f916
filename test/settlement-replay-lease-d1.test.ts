// Lease ownership through booking (docs/REVIEW-SETTLEMENT-REPLAY-GUARD-GATE-2026-09-30.md, M1 and C2; builder commission
// drafts/BUILDER-COMMISSION-M2-LEASE-2026-10-01.md, "fix pass 3"). The lease bounds nothing by itself: a holder that is slow can be mid-write when its lease
// lapses and another worker takes it. R1 puts the ownership condition INSIDE every write a holder makes, so the stale holder writes nothing; R2/R3 make
// every finisher answer from its OWN applied step or from the claim, never from values it computed for a step that wrote nothing (a fresh `secret` the
// database does not hold). Real local D1 throughout; the facilitator is stubbed, and worker B acts INSIDE the stubbed /settle (after A took the claim and
// before A's markSettled) or at function level, with explicit lease times.
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
  authStateAnswer,
  callWorker,
  captureLog,
  claimRows,
  count,
  createLocalD1,
  eventLines,
  json,
  oneClaim,
  patronReq,
  paymentHeaderFor,
  realPublicKey,
  registerHeader,
  registerReq,
  stubFacilitator,
  testEnv,
  type Env,
  type LocalD1,
} from "./helpers/settlement-harness.ts";
import { sha256Hex } from "../src/chain.ts";
import { finishRegistration } from "../src/register-gate.ts";
import { attemptPending, finishPatronBooking } from "../src/x402.ts";
import { runReconciler } from "../src/settlement-reconcile.ts";
import { finishListingCreateBooking, finishPayListingBooking, handleCreateListing, handlePayListing, computeListingFeeCents } from "../src/listings.ts";
import {
  acquireLease,
  claimIdentity,
  claimKeyFromPayload,
  getClaim,
  keyOfRow,
  markExpired,
  markHandleTaken,
  markRefused,
  markSettled,
  noteUnknown,
  refsOf,
  releaseLease,
  runBookingStep,
  takeClaim,
  CLAIM_LEASE_TTL_MS,
  KEY_WHERE,
  keyArgs,
  type ClaimKey,
  type ClaimRow,
  type ClaimSpec,
} from "../src/settlement-claims.ts";

const REQS = { network: "base", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" };
const settledAnswer = () => new Response(JSON.stringify({ success: true, payer: TEST_PAYER, transaction: TX }), { status: 200, headers: { "content-type": "application/json" } });
const refusedAnswer = () => new Response(JSON.stringify({ success: false, errorReason: "insufficient_funds" }), { status: 200, headers: { "content-type": "application/json" } });

// ---------- worker B, as a test acts for it ----------

const theClaim = (d1: LocalD1) => {
  const rows = claimRows(d1);
  assert.equal(rows.length, 1, "exactly one claim row");
  return rows[0] as unknown as ClaimRow;
};
// A's lease lapses (nobody has taken it yet).
const lapse = (d1: LocalD1) => {
  const row = theClaim(d1);
  d1.raw.prepare(`UPDATE settlement_claims SET leased_until = 1 WHERE ${KEY_WHERE}`).run(...(keyArgs(keyOfRow(row)) as never[]));
  return keyOfRow(row);
};
// A's lease lapses and worker B takes it: B holds a LIVE lease.
async function bTakesTheLease(d1: LocalD1): Promise<ClaimKey> {
  const key = lapse(d1);
  const leased = await acquireLease(testEnv(d1), key, "B", Date.now());
  assert.equal(leased?.lease_owner, "B", "B took the lapsed lease");
  return key;
}
const eq = (d1: LocalD1) => testEnv(d1);

// ---------- function-level fixtures ----------

let nonceSeq = 0x7000;
function payloadFor(over: Record<string, unknown> = {}) {
  const nonce = "0x" + (++nonceSeq).toString(16).padStart(64, "0");
  return { payload: { authorization: { from: TEST_PAYER, to: "0x1", value: "1000000", validBefore: "9999999999", nonce, ...over } } };
}
// A claim taken and settled by worker A (the lease A holds is live from `now`).
async function claimSettledByA(d1: LocalD1, spec: ClaimSpec, now = Date.now()) {
  const payload = payloadFor();
  const { key, validBefore } = claimKeyFromPayload(payload, REQS);
  const id = await claimIdentity(key, validBefore, { paymentPayload: payload }, spec);
  assert.deepEqual(await takeClaim(eq(d1), id, spec, "A", now), { taken: true });
  assert.equal(await markSettled(eq(d1), key, TX, TEST_PAYER, "A", now), true);
  return { key, snapshotA: (await getClaim(eq(d1), key)) as ClaimRow };
}
const registerSpec = (publicKey: string | null): ClaimSpec => ({ route: "register", intent: { handle: "lease-seat", model: "m", public_key: publicKey } });
const identityLines = (d1: LocalD1, kind: string) => count(d1, `identity_events WHERE kind = '${kind}'`);

// ---------- T1: a lapsed lease mid-booking, registration ----------

for (const mode of ["secret", "public-key"] as const) {
  test(`T1 (${mode}): a finisher whose lease was taken by another writes NOTHING and answers from the claim; the new holder books once and gets the answer`, async () => {
    const d1 = createLocalD1();
    try {
      const publicKey = mode === "public-key" ? await realPublicKey() : null;
      const { key, snapshotA } = await claimSettledByA(d1, registerSpec(publicKey));
      await bTakesTheLease(d1); // A's booking is delayed past its lease; B (a re-send) holds a live lease and has not written yet

      // A resumes with its stale row. B's lease is live and the claim is still settled_unbooked with no step recorded: only the OWNERSHIP condition
      // stops A, not the state or the ref.
      const stale = await finishRegistration(eq(d1), snapshotA, { ip: null, inviteCode: null, deliver: true, owner: "A" });
      assert.deepEqual(stale, { done: false, reason: "claim_moved" }, "A has no answer of its own");
      assert.equal("body" in stale, false, "and so no secret");
      assert.equal(count(d1, "ledger"), 0, "A's batches wrote no ledger line");
      assert.equal(count(d1, "citizens"), 0, "and no citizen");
      assert.equal(identityLines(d1, "key_registered"), 0, "and no identity line");
      assert.equal(theClaim(d1).booked_refs, "{}", "and the claim records nothing A did");

      // B finishes under its own lease.
      const rowB = (await getClaim(eq(d1), key)) as ClaimRow;
      const b = await finishRegistration(eq(d1), rowB, { ip: null, inviteCode: null, deliver: true, owner: "B" });
      assert.equal(b.done, true, "B's answer is the registration");
      assert.equal(count(d1, "citizens"), 1, "exactly one citizen");
      assert.equal(count(d1, "ledger"), 1, "exactly one ledger row");
      assert.equal(identityLines(d1, "key_registered"), mode === "public-key" ? 1 : 0, "exactly one identity line (public-key mode)");
      if (b.done && mode === "secret") {
        const stored = (d1.raw.prepare("SELECT secret_hash FROM citizens").get() as { secret_hash: string }).secret_hash;
        assert.equal(await sha256Hex(String(b.body.secret)), stored, "B's secret is the one the database holds");
      }
      const done = oneClaim(d1);
      assert.equal(done.state, "booked");
      assert.equal(done.lease_owner, null);
    } finally {
      d1.close();
    }
  });

  test(`T1c (${mode}): a stale finisher that runs AFTER the new holder booked the whole act answers from the claim, never with a secret the database does not hold`, async () => {
    const d1 = createLocalD1();
    try {
      const publicKey = mode === "public-key" ? await realPublicKey() : null;
      const { key, snapshotA } = await claimSettledByA(d1, registerSpec(publicKey));
      await bTakesTheLease(d1);
      const rowB = (await getClaim(eq(d1), key)) as ClaimRow;
      const b = await finishRegistration(eq(d1), rowB, { ip: null, inviteCode: null, deliver: true, owner: "B" });
      assert.equal(b.done, true);
      assert.equal(oneClaim(d1).state, "booked");

      // A's stale snapshot still says settled_unbooked with nothing recorded: its ledger step is gated out ("take theirs"), its citizen step is gated out,
      // and the secret A generated for that step is a value for a step that wrote nothing.
      const stale = await finishRegistration(eq(d1), snapshotA, { ip: null, inviteCode: null, deliver: true, owner: "A" });
      assert.deepEqual(stale, { done: false, reason: "claim_moved" });
      assert.equal("body" in stale, false, "no secret leaves a finisher whose own final step did not apply");
      assert.equal(count(d1, "citizens"), 1);
      assert.equal(count(d1, "ledger"), 1);
      assert.equal(identityLines(d1, "key_registered"), mode === "public-key" ? 1 : 0);
    } finally {
      d1.close();
    }
  });
}

// ---------- T2: the same for patron, listing creation and pay listing (the route, A answering from the claim) ----------

test("T2 patron: B takes the lapsed lease inside A's /settle and books the line; A's answer comes from the claim (409, nothing charged again), one ledger line", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator({
    settle: async () => {
      const key = await bTakesTheLease(d1);
      assert.equal(await markSettled(eq(d1), key, TX, TEST_PAYER, "B", Date.now()), true);
      await finishPatronBooking(eq(d1), (await getClaim(eq(d1), key)) as ClaimRow, "B");
      return settledAnswer();
    },
  });
  try {
    const res = await callWorker(patronReq("rent", paymentHeaderFor(TREASURY_ADDRESS, "1000000")), eq(d1));
    assert.equal(res.status, 409, JSON.stringify(await res.clone().json()));
    const body = await json(res);
    assert.equal(body.code, "settlement_already_booked");
    assert.match(String(body.error), /nothing was charged again/);
    assert.equal(count(d1, "ledger"), 1, "one ledger line: B's");
    assert.equal(oneClaim(d1).state, "booked");
    assert.equal(stub.calls.settle, 1);
  } finally {
    stub.restore();
    d1.close();
  }
});

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
const BOUNTY = 1200;
const REVIEWER_WALLET = "0x" + "0a".repeat(20);
async function payFixture(d1: LocalD1) {
  const funderId = insertCitizen(d1);
  const reviewerId = insertCitizen(d1);
  const pin = await declareTestWallet(d1, reviewerId, REVIEWER_WALLET);
  const listingId = insertListing(d1, { funder_citizen_id: funderId, bounty_cents: BOUNTY });
  const submissionId = insertSubmission(d1, { listing_id: listingId, citizen_id: reviewerId });
  const funder = await loadCitizen(d1, funderId);
  const pay = async (env: Env = eq(d1)) => {
    const res = await handlePayListing(
      new Request(`https://example.test/api/listing/${listingId}/pay`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-PAYMENT": paymentHeaderFor(REVIEWER_WALLET, atomicFromCents(BOUNTY)) },
        body: JSON.stringify({ submission_id: submissionId, wallet_row_id: pin.id, wallet_row_hash: pin.hash }),
      }),
      env,
      funder,
      listingId,
    );
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const listing = () => d1.raw.prepare("SELECT status, paying_since, paid_tx FROM listings WHERE id = ?").get(listingId) as { status: string; paying_since: number | null; paid_tx: string | null };
  return { pay, listing, listingId, pin };
}

test("T2 pay listing: B books the bounty inside A's /settle; A answers from the claim and the listing stays PAID (A releases nothing), one payment row", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator({
    settle: async () => {
      const key = await bTakesTheLease(d1);
      assert.equal(await markSettled(eq(d1), key, TX, TEST_PAYER, "B", Date.now()), true);
      await finishPayListingBooking(eq(d1), (await getClaim(eq(d1), key)) as ClaimRow, "B");
      return settledAnswer();
    },
  });
  try {
    const fx = await payFixture(d1);
    const res = await fx.pay();
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.code, "settlement_already_booked");
    assert.equal(count(d1, "listing_payments"), 1, "one payment row: B's");
    assert.equal(fx.listing().status, "paid");
    assert.equal(oneClaim(d1).state, "booked");
  } finally {
    stub.restore();
    d1.close();
  }
});

test("T2 pay listing: B holds a live lease and is still booking when A's /settle returns; A answers 'not finished, do not sign again' and KEEPS the reservation; A's stale finisher writes nothing; B then books once", async () => {
  const d1 = createLocalD1();
  let staleRow: ClaimRow | null = null;
  const stub = stubFacilitator({
    settle: async () => {
      const key = await bTakesTheLease(d1);
      assert.equal(await markSettled(eq(d1), key, TX, TEST_PAYER, "B", Date.now()), true);
      staleRow = (await getClaim(eq(d1), key)) as ClaimRow;
      return settledAnswer();
    },
  });
  try {
    const fx = await payFixture(d1);
    const res = await fx.pay();
    assert.equal(res.status, 500, JSON.stringify(res.body));
    assert.equal(res.body.code, "settlement_unresolved");
    assert.match(String(res.body.error), /Do not sign again/);
    assert.equal(fx.listing().status, "paying", "the reservation is KEPT: B is still booking against it");
    assert.equal(count(d1, "listing_payments"), 0);
    assert.equal(oneClaim(d1).state, "settled_unbooked");

    // A's stale finisher, run by itself, writes nothing while B holds the lease.
    await finishPayListingBooking(eq(d1), staleRow as unknown as ClaimRow, "A");
    assert.equal(count(d1, "listing_payments"), 0, "A's batch wrote no payment row");
    assert.equal(fx.listing().status, "paying");
    assert.equal(oneClaim(d1).booked_refs, "{}");

    // B books once.
    await finishPayListingBooking(eq(d1), (await getClaim(eq(d1), keyOfRow(staleRow as unknown as ClaimRow))) as ClaimRow, "B");
    assert.equal(count(d1, "listing_payments"), 1);
    assert.equal(fx.listing().status, "paid");
    assert.equal(oneClaim(d1).state, "booked");
  } finally {
    stub.restore();
    d1.close();
  }
});

const listingBody = (bounty: number) => ({
  title: "Review my auth middleware",
  description: "Stuck on token refresh, please review for race conditions",
  acceptance_condition: "a reviewer identifies at least one real correctness issue or confirms none exist",
  bounty_cents: bounty,
  expires_at: Date.now() + 7 * 86_400_000,
});

test("T2 listing create: B holds a live lease and is still booking when A's /settle returns; A answers from the claim, A's stale finisher writes nothing, B then books once", async () => {
  const d1 = createLocalD1();
  let staleRow: ClaimRow | null = null;
  const stub = stubFacilitator({
    settle: async () => {
      const key = await bTakesTheLease(d1);
      assert.equal(await markSettled(eq(d1), key, TX, TEST_PAYER, "B", Date.now()), true);
      staleRow = (await getClaim(eq(d1), key)) as ClaimRow;
      return settledAnswer();
    },
  });
  try {
    const funder = await loadCitizen(d1, insertCitizen(d1));
    const header = paymentHeaderFor(TREASURY_ADDRESS, atomicFromCents(computeListingFeeCents(1000)));
    const res = await handleCreateListing(
      new Request("https://example.test/api/listing", { method: "POST", headers: { "Content-Type": "application/json", "X-PAYMENT": header }, body: JSON.stringify(listingBody(1000)) }),
      eq(d1),
      funder,
    );
    assert.equal(res.status, 500);
    assert.equal((await res.json() as Record<string, any>).code, "settlement_unresolved");
    assert.equal(count(d1, "listings"), 0);
    assert.equal(count(d1, "ledger"), 0, "A wrote no fee line");

    await finishListingCreateBooking(eq(d1), staleRow as unknown as ClaimRow, "A");
    assert.equal(count(d1, "listings"), 0, "A's stale finisher wrote no listing");
    assert.equal(count(d1, "ledger"), 0, "and no fee line");
    assert.equal(count(d1, "reg_log"), 0, "and no throttle record");

    await finishListingCreateBooking(eq(d1), (await getClaim(eq(d1), keyOfRow(staleRow as unknown as ClaimRow))) as ClaimRow, "B");
    assert.equal(count(d1, "listings"), 1, "B books once");
    assert.equal(count(d1, "ledger"), 1);
    assert.equal(count(d1, "reg_log"), 1, "with its one throttle record");
    assert.equal(oneClaim(d1).state, "booked");
  } finally {
    stub.restore();
    d1.close();
  }
});

// ---------- T1r/T2r: the lease lapses INSIDE A's booking batch (the route, a database seam) ----------

// An Env whose DB runs `hook(n)` immediately BEFORE its nth batch(): worker B acts at exactly the moment A's booking is "delayed past its lease".
function hookedEnv(d1: LocalD1, hook: (n: number) => Promise<void>): Env {
  const real = d1.DB;
  let n = 0;
  const DB = {
    prepare: (sql: string) => real.prepare(sql),
    batch: async (stmts: never[]) => {
      await hook(++n);
      return real.batch(stmts);
    },
  };
  return { ...testEnv(d1), DB } as unknown as Env;
}
// B (a re-send or the reconciler) takes the lapsed lease and runs `work` with its own plain env, once, before A's first batch.
function bActsBeforeFirstBatch(d1: LocalD1, work: (row: ClaimRow) => Promise<void>) {
  return async (n: number) => {
    if (n !== 1) return;
    const key = await bTakesTheLease(d1);
    await work((await getClaim(eq(d1), key)) as ClaimRow);
  };
}

for (const mode of ["secret", "public-key"] as const) {
  test(`T1r (${mode}): A's booking batch is delayed past its lease and B books the whole registration first; A answers from the claim (409), with NO secret, and B's secret is the one stored`, async () => {
    const d1 = createLocalD1();
    const stub = stubFacilitator();
    try {
      const publicKey = mode === "public-key" ? await realPublicKey() : null;
      let bAnswer: Awaited<ReturnType<typeof finishRegistration>> | null = null;
      const env = hookedEnv(
        d1,
        bActsBeforeFirstBatch(d1, async (row) => {
          bAnswer = await finishRegistration(eq(d1), row, { ip: null, inviteCode: null, deliver: true, owner: "B" });
        }),
      );
      const res = await callWorker(registerReq({ handle: "delayed-seat", model: "m", ...(publicKey ? { public_key: publicKey } : {}) }, registerHeader()), env);
      assert.equal(res.status, 409, JSON.stringify(await res.clone().json()));
      const body = await json(res);
      assert.equal(body.code, "settlement_already_booked", "A answers as an identical replay would");
      assert.equal(body.secret, undefined, "A's answer carries no secret");
      assert.ok(bAnswer && (bAnswer as { done: boolean }).done, "B's answer is the registration");
      assert.equal(count(d1, "citizens"), 1, "exactly one citizen");
      assert.equal(count(d1, "ledger"), 1, "exactly one ledger row");
      assert.equal(identityLines(d1, "key_registered"), mode === "public-key" ? 1 : 0, "exactly one identity line (public-key mode)");
      if (mode === "secret") {
        const stored = (d1.raw.prepare("SELECT secret_hash FROM citizens").get() as { secret_hash: string }).secret_hash;
        assert.equal(await sha256Hex(String((bAnswer as unknown as { body: { secret: string } }).body.secret)), stored, "B's secret is the one the database holds");
      }
      assert.equal(oneClaim(d1).state, "booked");
      assert.equal(stub.calls.settle, 1);
    } finally {
      stub.restore();
      d1.close();
    }
  });
}

test("T2r patron: A's booking batch is delayed past its lease and B books the line first; A answers from the claim (409), one ledger line", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator();
  try {
    const env = hookedEnv(d1, bActsBeforeFirstBatch(d1, (row) => finishPatronBooking(eq(d1), row, "B")));
    const res = await callWorker(patronReq("rent", paymentHeaderFor(TREASURY_ADDRESS, "1000000")), env);
    assert.equal(res.status, 409, JSON.stringify(await res.clone().json()));
    assert.equal((await json(res)).code, "settlement_already_booked");
    assert.equal(count(d1, "ledger"), 1);
    assert.equal(oneClaim(d1).state, "booked");
  } finally {
    stub.restore();
    d1.close();
  }
});

test("T2r pay listing: A's booking batch is delayed past its lease and B books the bounty first; A answers from the claim (409), one payment row, the listing PAID", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator();
  try {
    const fx = await payFixture(d1);
    const env = hookedEnv(d1, bActsBeforeFirstBatch(d1, (row) => finishPayListingBooking(eq(d1), row, "B")));
    const res = await fx.pay(env);
    assert.equal(res.status, 409, JSON.stringify(res.body));
    assert.equal(res.body.code, "settlement_already_booked");
    assert.equal(count(d1, "listing_payments"), 1);
    assert.equal(fx.listing().status, "paid");
    assert.equal(oneClaim(d1).state, "booked");
  } finally {
    stub.restore();
    d1.close();
  }
});

test("T2r listing create: A's booking batch is delayed past its lease and B books the fee line and the listing first; A answers from the claim (409) and writes no second throttle record", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator();
  try {
    const funder = await loadCitizen(d1, insertCitizen(d1));
    const env = hookedEnv(d1, bActsBeforeFirstBatch(d1, (row) => finishListingCreateBooking(eq(d1), row, "B")));
    const res = await handleCreateListing(
      new Request("https://example.test/api/listing", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-PAYMENT": paymentHeaderFor(TREASURY_ADDRESS, atomicFromCents(computeListingFeeCents(1000))) },
        body: JSON.stringify(listingBody(1000)),
      }),
      env,
      funder,
    );
    assert.equal(res.status, 409, JSON.stringify(await res.clone().json()));
    assert.equal((await res.json() as Record<string, any>).code, "settlement_already_booked");
    assert.equal(count(d1, "listings"), 1);
    assert.equal(count(d1, "ledger"), 1);
    assert.equal(count(d1, "reg_log"), 1, "B's throttle record only: A's answer came from the claim, so A wrote none");
    assert.equal(oneClaim(d1).state, "booked");
  } finally {
    stub.restore();
    d1.close();
  }
});

// ---------- T3: markSettled returns false ----------

test("T3a: another holder has a live lease on the still-pending claim when A's /settle returns: A's markSettled is refused by the OWNERSHIP condition, A answers 'unknown, do not sign again' and books nothing", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator({
    settle: async () => {
      await bTakesTheLease(d1);
      return settledAnswer();
    },
  });
  try {
    const res = await callWorker(registerReq({ handle: "held-elsewhere", model: "m", public_key: await realPublicKey() }, registerHeader()), eq(d1));
    assert.equal(res.status, 502, JSON.stringify(await res.clone().json()));
    const body = await json(res);
    assert.equal(body.code, "settlement_unresolved");
    assert.match(String(body.error), /Do not sign again/);
    const row = theClaim(d1);
    assert.equal(row.state, "pending", "A did not move the claim: B holds the lease");
    assert.equal(row.lease_owner, "B");
    assert.equal(count(d1, "citizens"), 0);
    assert.equal(count(d1, "ledger"), 0);
    // and B, the holder, can move it
    assert.equal(await markSettled(eq(d1), keyOfRow(row), TX, TEST_PAYER, "B", Date.now()), true);
  } finally {
    stub.restore();
    d1.close();
  }
});

for (const terminal of ["refused", "expired"] as const) {
  test(`T3b (${terminal}): the claim is ${terminal} for a settle the facilitator called successful: ONE settlement_contradiction error line, and an answer that never says nothing was charged`, async () => {
    const d1 = createLocalD1();
    const stub = stubFacilitator({
      settle: async () => {
        const key = await bTakesTheLease(d1);
        const moved = terminal === "refused" ? await markRefused(eq(d1), key, "The facilitator reports that this settlement failed", "B", Date.now()) : await markExpired(eq(d1), key, "B", Date.now());
        assert.equal(moved, true);
        return settledAnswer();
      },
    });
    try {
      const { value: res, lines } = await captureLog(() => callWorker(registerReq({ handle: "contradicted", model: "m", public_key: undefined }, registerHeader()), eq(d1)));
      assert.equal(res.status, 500, JSON.stringify(await res.clone().json()));
      const body = await json(res);
      assert.equal(body.code, "settlement_contradiction");
      assert.match(String(body.error), new RegExp(TX), "it names the transaction");
      assert.match(String(body.error), /may have moved/);
      assert.match(String(body.error), /Do not sign again/);
      assert.doesNotMatch(String(body.error), /nothing was charged/i, "it never says nothing was charged");
      const contradictions = eventLines(lines, "settlement_contradiction");
      assert.equal(contradictions.length, 1, "exactly one contradiction line");
      assert.equal(contradictions[0].level, "error");
      assert.equal(contradictions[0].state, terminal);
      assert.equal(contradictions[0].tx, TX);
      assert.equal(contradictions[0].payer, TEST_PAYER);
      assert.equal(contradictions[0].claim_from, TEST_PAYER);
      assert.equal(typeof contradictions[0].claim_nonce, "string");
      assert.equal(count(d1, "citizens"), 0);
      assert.equal(count(d1, "ledger"), 0, "nothing was booked on a terminal claim");
      assert.equal(eventLines(lines, "payment_settled_unrecorded").length, 0, "and the old 'could not record it in the ledger' answer is not the one given");
    } finally {
      stub.restore();
      d1.close();
    }
  });
}

test("T3c: this request read a RECORDED REFUSAL while another holder has a live lease on the pending claim: A does not tell the payer to sign again; the claim stays pending", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator({
    settle: async () => {
      await bTakesTheLease(d1);
      return refusedAnswer();
    },
  });
  try {
    const res = await callWorker(registerReq({ handle: "refused-but-held", model: "m", public_key: await realPublicKey() }, registerHeader()), eq(d1));
    assert.equal(res.status, 502, JSON.stringify(await res.clone().json()));
    const body = await json(res);
    assert.equal(body.code, "settlement_unresolved");
    assert.equal(body.accepts, undefined, "no 402 inviting a fresh signature over a claim another holder may still settle");
    assert.equal(theClaim(d1).state, "pending");
  } finally {
    stub.restore();
    d1.close();
  }
});

// D-018 re-gate LOW-3 (docs/REVIEW-SETTLEMENT-REPLAY-GUARD-REGATE-2026-10-01.md, the gate's probe P-E, committed as written): T3c is a
// registration test, so without this the keepReservation on payAndSettle's markRefused-false answer (src/x402.ts) could be deleted with the
// whole suite green; a pay request that read a refusal while B was mid-attempt would then release its reservation and B's booking would be
// gated out of a listing no longer 'paying'.
test("P-E: pay listing, refusal read under another holder's live lease: A answers 502 and KEEPS the reservation", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator({
    settle: async () => {
      await bTakesTheLease(d1);
      return refusedAnswer();
    },
  });
  try {
    const fx = await payFixture(d1);
    const res = await fx.pay();
    assert.equal(res.status, 502);
    assert.equal(res.body.accepts, undefined);
    assert.equal(fx.listing().status, "paying", "reservation kept while B may still settle");
    assert.equal(oneClaim(d1).state, "pending");
  } finally {
    stub.restore();
    d1.close();
  }
});

// CODEX M3-build r1 HIGH (pre-existing since M2): A's markRefused THROWS after B took the lapsed lease and settled A's claim. The throw used
// to skip the claim re-read, so the 402 released A's reservation and re-opened a listing whose claim is settled_unbooked (a later payer could
// then reserve it and the old claim book against that reservation). Mutant: restore `if (!wrote && !threw)` -> 402, listing 'open'.
test("M3 HIGH: pay listing, A reads a refusal after B settled the claim, and A's refusal write THROWS: A keeps the reservation and offers no fresh payment", async () => {
  const d1 = createLocalD1();
  let armed = false;
  const stub = stubFacilitator({
    settle: async () => {
      const key = await bTakesTheLease(d1);
      assert.equal(await markSettled(eq(d1), key, TX, TEST_PAYER, "B", Date.now()), true);
      armed = true;
      return refusedAnswer();
    },
  });
  const base = eq(d1);
  const injected = () => new Error("D1_ERROR: injected failure of the refusal write");
  const failingDb = new Proxy(base.DB as object, {
    get(t: any, p: string | symbol) {
      if (p === "prepare") {
        return (sql: string) => {
          if (armed && sql.includes("SET state = 'refused'")) {
            armed = false;
            const boom: any = { bind: () => boom, run: async () => { throw injected(); }, first: async () => { throw injected(); }, all: async () => { throw injected(); } };
            return boom;
          }
          return t.prepare(sql);
        };
      }
      const v = t[p];
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  try {
    const fx = await payFixture(d1);
    const res = await fx.pay({ ...base, DB: failingDb } as unknown as Env);
    assert.notEqual(res.status, 402, JSON.stringify(res.body));
    assert.equal(res.body.accepts, undefined, "no fresh payment requirements are offered");
    assert.equal(armed, false, "the refusal write was attempted and failed");
    assert.equal(fx.listing().status, "paying", "the reservation is kept: B's claim is settled_unbooked");
    assert.equal(oneClaim(d1).state, "settled_unbooked");
  } finally {
    stub.restore();
    d1.close();
  }
});

// D-018 gate C2 (3 Oct, probe P1 committed): the commonest input to d4f25eb0's fix, a refusal write that THROWS with nobody else involved.
// Mutants: let a thrown write fall through to the 402 (`if (!wrote && !threw)`) -> 402 and the listing re-opens; hard-code leaseHeld: true
// again -> the answer claims an attempt in progress that does not exist.
test("gate C2: pay listing, a recorded refusal whose write THROWS with nobody else involved: no 402, the reservation kept, and no claim of another attempt", async () => {
  const d1 = createLocalD1();
  let armed = true;
  const stub = stubFacilitator({ settle: () => refusedAnswer() });
  const base = eq(d1);
  const failingDb = new Proxy(base.DB as object, {
    get(t: any, p: string | symbol) {
      if (p === "prepare") {
        return (sql: string) => {
          if (armed && sql.includes("SET state = 'refused'")) {
            armed = false;
            const boom: any = { bind: () => boom, run: async () => { throw new Error("D1_ERROR: injected"); }, first: async () => { throw new Error("D1_ERROR: injected"); }, all: async () => { throw new Error("D1_ERROR: injected"); } };
            return boom;
          }
          return t.prepare(sql);
        };
      }
      const v = t[p];
      return typeof v === "function" ? v.bind(t) : v;
    },
  });
  try {
    const fx = await payFixture(d1);
    const res = await fx.pay({ ...base, DB: failingDb } as unknown as Env);
    const row = d1.raw.prepare("SELECT state, lease_owner FROM settlement_claims").get() as { state: string; lease_owner: string | null };
    assert.equal(armed, false, "the refusal write was attempted and failed");
    assert.notEqual(res.status, 402, JSON.stringify(res.body));
    assert.equal(res.body.accepts, undefined);
    assert.equal(fx.listing().status, "paying", "the reservation is kept: the claim's state is unconfirmed");
    assert.equal(row.state, "pending");
    assert.equal(row.lease_owner, null, "this request released its own lease; nobody holds one");
    assert.doesNotMatch(String(res.body.error), /Another attempt to resolve it is in progress/, "no attempt is in progress, so none is claimed");
  } finally {
    stub.restore();
    d1.close();
  }
});

test("T3d: the control: with nobody else involved, a recorded refusal still answers 402 and refuses the claim", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator({ settle: () => refusedAnswer() });
  try {
    const res = await callWorker(registerReq({ handle: "plain-refusal", model: "m", public_key: await realPublicKey() }, registerHeader()), eq(d1));
    assert.equal(res.status, 402);
    assert.equal(oneClaim(d1).state, "refused");
  } finally {
    stub.restore();
    d1.close();
  }
});

// ---------- T5: a lapsed lease nobody took does not block its holder ----------

for (const mode of ["secret", "public-key"] as const) {
  test(`T5 (${mode}): a merely slow holder whose lease lapsed with nobody taking it still writes and finishes (no stuck pending)`, async () => {
    const d1 = createLocalD1();
    const stub = stubFacilitator({
      settle: async () => {
        lapse(d1); // the lease lapses during a slow /settle; no second worker comes
        return settledAnswer();
      },
    });
    try {
      const publicKey = mode === "public-key" ? await realPublicKey() : null;
      const res = await callWorker(registerReq({ handle: "slow-but-alone", model: "m", ...(publicKey ? { public_key: publicKey } : {}) }, registerHeader()), eq(d1));
      assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
      const body = await json(res);
      if (publicKey === null) {
        const stored = (d1.raw.prepare("SELECT secret_hash FROM citizens").get() as { secret_hash: string }).secret_hash;
        assert.equal(await sha256Hex(String(body.secret)), stored, "the 201 carries the stored secret");
      }
      assert.equal(count(d1, "citizens"), 1);
      assert.equal(count(d1, "ledger"), 1);
      const done = oneClaim(d1);
      assert.equal(done.state, "booked");
      assert.equal(done.lease_owner, null);
    } finally {
      stub.restore();
      d1.close();
    }
  });
}

// ---------- T4: renewal, and the primitives' ownership condition ----------

const spec: ClaimSpec = { route: "patron", intent: { line: "lease" } };
async function take(d1: LocalD1, owner: string, now: number) {
  const payload = payloadFor();
  const { key, validBefore } = claimKeyFromPayload(payload, REQS);
  const id = await claimIdentity(key, validBefore, { paymentPayload: payload }, spec);
  assert.deepEqual(await takeClaim(eq(d1), id, spec, owner, now), { taken: true });
  return key;
}
const ledgerStep = (d1: LocalD1, final: boolean) => ({
  ref: "ledger_id" as const,
  final,
  statements: async (gate: { sql: string; args: readonly unknown[] }) => [
    d1.DB.prepare("INSERT INTO ledger (entry_date, description, amount_cents, created_at) SELECT ?, ?, ?, ? WHERE EXISTS (" + gate.sql + ")").bind("2026-10-01", "lease", 1, 1, ...gate.args) as unknown as D1PreparedStatement,
  ],
});
const paymentStep = (d1: LocalD1) => ({
  ref: "payment_id" as const,
  final: true,
  statements: async (gate: { sql: string; args: readonly unknown[] }) => [
    d1.DB.prepare("INSERT INTO ledger (entry_date, description, amount_cents, created_at) SELECT ?, ?, ?, ? WHERE EXISTS (" + gate.sql + ")").bind("2026-10-01", "other", 1, 1, ...gate.args) as unknown as D1PreparedStatement,
  ],
});

test("T4a: a holder whose markSettled runs INSIDE its lease (taken_at + 170 s) renews it: a second worker at taken_at + 200 s cannot acquire", async () => {
  const d1 = createLocalD1();
  try {
    const key = await take(d1, "A", 1_000);
    assert.equal(await markSettled(eq(d1), key, TX, TEST_PAYER, "A", 1_000 + 170_000), true);
    const row = (await getClaim(eq(d1), key)) as ClaimRow;
    assert.equal(row.lease_owner, "A");
    assert.equal(row.leased_until, 1_000 + 170_000 + CLAIM_LEASE_TTL_MS, "the lease was renewed from the write, not left at taken_at + 180 s");
    assert.equal(await acquireLease(eq(d1), key, "B", 1_000 + 200_000), null, "the lease is live at taken_at + 200 s");
  } finally {
    d1.close();
  }
});

test("T4b: a non-final booking step inside the lease renews it (B cannot acquire, and B's own step writes nothing); a final step clears it", async () => {
  const d1 = createLocalD1();
  try {
    const key = await take(d1, "A", 1_000);
    assert.equal(await markSettled(eq(d1), key, TX, TEST_PAYER, "A", 1_000), true);
    assert.equal((await runBookingStep(eq(d1), key, ledgerStep(d1, false), "A", 1_000 + 170_000)).applied, true);
    const row = (await getClaim(eq(d1), key)) as ClaimRow;
    assert.equal(row.leased_until, 1_000 + 170_000 + CLAIM_LEASE_TTL_MS, "the step renewed the lease");
    assert.equal(row.lease_owner, "A");
    assert.equal(await acquireLease(eq(d1), key, "B", 1_000 + 200_000), null, "B cannot acquire at taken_at + 200 s");
    assert.equal((await runBookingStep(eq(d1), key, paymentStep(d1), "B", 1_000 + 200_000)).applied, false, "and B's step is gated out by the ownership condition");
    assert.equal(count(d1, "ledger"), 1, "B wrote nothing");
    assert.equal((await runBookingStep(eq(d1), key, paymentStep(d1), "A", 1_000 + 201_000)).applied, true, "A, the holder, finishes");
    const booked = (await getClaim(eq(d1), key)) as ClaimRow;
    assert.equal(booked.state, "booked");
    assert.equal(booked.lease_owner, null, "the final step clears the lease");
    assert.equal(booked.leased_until, null);
    assert.deepEqual(refsOf(booked), { ledger_id: 1, payment_id: 2 });
  } finally {
    d1.close();
  }
});

test("T4c: the stale holder's booking step AFTER another worker took the lapsed lease writes nothing; a third owner is blocked the same way; a lapsed lease with nobody holding it blocks no one", async () => {
  const d1 = createLocalD1();
  try {
    const key = await take(d1, "A", 1_000);
    assert.equal(await markSettled(eq(d1), key, TX, TEST_PAYER, "A", 1_000), true);
    // A's lease (renewed to 181_000) lapses; B takes it at 200_000
    assert.equal((await acquireLease(eq(d1), key, "B", 200_000))?.lease_owner, "B");
    assert.equal((await runBookingStep(eq(d1), key, ledgerStep(d1, false), "A", 201_000)).applied, false, "A is no longer the holder");
    assert.equal((await runBookingStep(eq(d1), key, ledgerStep(d1, false), "C", 201_000)).applied, false, "nor is anyone else");
    assert.equal(count(d1, "ledger"), 0);
    assert.equal((await runBookingStep(eq(d1), key, ledgerStep(d1, false), "B", 201_000)).applied, true, "B is");
    // B's (renewed) lease lapses and nobody takes it: the old holder is not locked out
    assert.equal((await runBookingStep(eq(d1), key, paymentStep(d1), "A", 201_000 + CLAIM_LEASE_TTL_MS + 1)).applied, true);
    assert.equal((await getClaim(eq(d1), key))?.state, "booked");
  } finally {
    d1.close();
  }
});

test("every transition a holder makes (markSettled, markRefused, markExpired, noteUnknown, markHandleTaken) is refused while ANOTHER owner holds a live lease, and passes for the holder", async () => {
  const d1 = createLocalD1();
  try {
    // pending claims, taken by A at 1_000; A's lease lapses and B takes it at 200_000 (live until 380_000)
    const heldBy = async () => {
      const key = await take(d1, "A", 1_000);
      assert.equal((await acquireLease(eq(d1), key, "B", 200_000))?.lease_owner, "B");
      return key;
    };
    const state = async (key: ClaimKey) => (await getClaim(eq(d1), key)) as ClaimRow;

    let key = await heldBy();
    assert.equal(await markSettled(eq(d1), key, TX, TEST_PAYER, "A", 201_000), false, "markSettled by the stale holder");
    assert.equal((await state(key)).state, "pending");
    assert.equal(await markSettled(eq(d1), key, TX, TEST_PAYER, "B", 201_000), true, "markSettled by the holder");

    key = await heldBy();
    assert.equal(await markRefused(eq(d1), key, "no", "A", 201_000), false, "markRefused by the stale holder");
    assert.equal((await state(key)).state, "pending");
    assert.equal(await markRefused(eq(d1), key, "no", "B", 201_000), true, "markRefused by the holder");

    key = await heldBy();
    assert.equal(await markExpired(eq(d1), key, "A", 201_000), false, "markExpired by the stale holder");
    assert.equal((await state(key)).state, "pending");
    assert.equal(await markExpired(eq(d1), key, "B", 201_000), true, "markExpired by the holder");

    key = await heldBy();
    await noteUnknown(eq(d1), key, "a stale note", "A", 201_000);
    assert.equal((await state(key)).verdict_reason, null, "noteUnknown by the stale holder writes nothing");
    assert.equal((await state(key)).lease_owner, "B", "and does not let go of B's lease");
    await noteUnknown(eq(d1), key, "B's note", "B", 201_000);
    assert.equal((await state(key)).verdict_reason, "B's note");

    key = await heldBy();
    assert.equal(await markSettled(eq(d1), key, TX, TEST_PAYER, "B", 201_000), true);
    // markSettled renewed B's lease to 381_000; A is still not the holder
    assert.equal(await markHandleTaken(eq(d1), key, "A", 202_000), false, "markHandleTaken by the stale holder");
    assert.equal((await state(key)).verdict_reason, null);
    assert.equal(await markHandleTaken(eq(d1), key, "B", 202_000), true, "markHandleTaken by the holder");

    // a lapsed lease nobody holds blocks no one: a pending claim A took at 1_000 and nobody touched, written at 200_000
    key = await take(d1, "A", 1_000);
    assert.equal(await markSettled(eq(d1), key, TX, TEST_PAYER, "C", 200_000), true, "no live lease: the write passes");

    // H3 (fix pass 4): noteUnknown CLEARS the lease, so it is strictly holder-only, lapsed lease or not. The other transitions pass on an unheld lapsed
    // lease; this one does not pass for anyone but the owner the lease is named for.
    key = await take(d1, "A", 1_000);
    await noteUnknown(eq(d1), key, "a note from C", "C", 200_000);
    assert.equal((await state(key)).verdict_reason, null, "a lapsed lease named for A is not cleared by C");
    assert.equal((await state(key)).lease_owner, "A");
    await noteUnknown(eq(d1), key, "A's note", "A", 200_000);
    assert.equal((await state(key)).verdict_reason, "A's note", "but A, whose name it carries, may");
    key = await take(d1, "A", 1_000);
    assert.equal((await acquireLease(eq(d1), key, "B", 200_000))?.lease_owner, "B");
    await releaseLease(eq(d1), key, "B"); // B took the lapsed lease and let go of it: lease_owner is now NULL
    await noteUnknown(eq(d1), key, "a late note from A", "A", 201_000);
    assert.equal((await state(key)).verdict_reason, null, "a holder whose lease was taken and released by another writes nothing");
  } finally {
    d1.close();
  }
});

// ---------- T6: the reconciler's attempt, writing under a lease that is no longer its own ----------

for (const kind of ["expired", "refused"] as const) {
  test(`T6 (${kind}): a stale attempt whose terminal write is refused by the ownership condition reports 'unchanged', never '${kind}', and the claim stays pending for its holder`, async () => {
    const d1 = createLocalD1();
    const stub = stubFacilitator({ settle: () => refusedAnswer(), rpc: () => authStateAnswer(false) });
    try {
      const payload = payloadFor({ validBefore: kind === "expired" ? "1000" : "9999999999" });
      const { key, validBefore } = claimKeyFromPayload(payload, REQS);
      const id = await claimIdentity(key, validBefore, { paymentPayload: payload, paymentRequirements: { resource: "https://example.test/api/patron", payTo: TREASURY_ADDRESS, maxAmountRequired: "1000000" } }, spec);
      assert.deepEqual(await takeClaim(eq(d1), id, spec, "A", Date.now()), { taken: true });
      await bTakesTheLease(d1);
      const row = (await getClaim(eq(d1), key)) as ClaimRow;
      const out = await attemptPending(eq(d1), row, "A");
      assert.equal(out.kind, "unchanged", JSON.stringify(out));
      assert.equal((await getClaim(eq(d1), key))?.state, "pending");
      assert.equal((await getClaim(eq(d1), key))?.lease_owner, "B");
      // the holder's own attempt resolves it
      const mine = await attemptPending(eq(d1), (await getClaim(eq(d1), key)) as ClaimRow, "B");
      assert.equal(mine.kind, kind);
    } finally {
      stub.restore();
      d1.close();
    }
  });
}

// ---------- H1 (fix pass 4): a stale refusal must not release a NEWER payer's reservation ----------

test("H1: A reserves, B refuses A's claim and (F2) releases A's reservation, C reserves the reopened listing, A's refusal then arrives: A's release is bound to A's own reservation, so C's stands", async () => {
  const d1 = createLocalD1();
  const fxRef: { fx?: Awaited<ReturnType<typeof payFixture>> } = {};
  let cSince = 0;
  const stub = stubFacilitator({
    settle: async () => {
      const fx = fxRef.fx!;
      const aSince = fx.listing().paying_since as number;
      assert.ok(aSince > 0, "A holds the reservation");
      const key = await bTakesTheLease(d1);
      const row = (await getClaim(eq(d1), key)) as ClaimRow;
      // B refuses the claim; the same batch releases A's reservation (F2)
      assert.equal(await markRefused(eq(d1), key, "The facilitator reports that this settlement failed", "B", Date.now(), row), true);
      assert.equal(fx.listing().status, "open", "B's refusal released A's reservation");
      // C reserves the reopened listing under the same pinned wallet row, LATER than A's reservation
      cSince = aSince + 5;
      d1.raw
        .prepare("UPDATE listings SET status = 'paying', paying_since = ?, paying_wallet_row_id = ?, paying_wallet_row_hash = ? WHERE id = ? AND status = 'open'")
        .run(cSince, fx.pin.id, fx.pin.hash, fx.listingId);
      return refusedAnswer(); // A's own /settle reads a recorded refusal
    },
  });
  try {
    fxRef.fx = await payFixture(d1);
    const res = await fxRef.fx.pay();
    assert.equal(res.status, 402, "A is told its payment was refused (the claim agrees)");
    const listing = fxRef.fx.listing();
    assert.equal(listing.status, "paying", "C's reservation is intact");
    assert.equal(listing.paying_since, cSince, "and it is C's instance, not A's");
    const pinned = d1.raw.prepare("SELECT paying_wallet_row_id AS id, paying_wallet_row_hash AS hash FROM listings WHERE id = ?").get(fxRef.fx.listingId) as { id: number; hash: string };
    assert.deepEqual({ ...pinned }, { id: fxRef.fx.pin.id, hash: fxRef.fx.pin.hash }, "with its pinned wallet row");
  } finally {
    stub.restore();
    d1.close();
  }
});

// ---------- H2 (fix pass 4): attemptPending must not discard a successful settlement ----------

const pendingAnswer = () => new Response(JSON.stringify({ success: false, errorReason: "settlement_pending" }), { status: 200, headers: { "content-type": "application/json" } });

// B (a second worker) takes the lapsed lease inside the re-POST and makes the claim terminal-without-money.
async function bTerminates(d1: LocalD1, kind: "refused" | "expired") {
  const key = await bTakesTheLease(d1);
  const moved = kind === "refused" ? await markRefused(eq(d1), key, "The facilitator reports that this settlement failed", "B", Date.now()) : await markExpired(eq(d1), key, "B", Date.now());
  assert.equal(moved, true);
}

for (const kind of ["refused", "expired"] as const) {
  test(`H2 re-send (${kind}): the re-POST answers SUCCESS after another holder made the claim ${kind}: one contradiction line, a 500 that does not invite a second signature, the claim stays ${kind} and is stamped with the contradiction (C1)`, async () => {
    const d1 = createLocalD1();
    const stub = stubFacilitator({
      settle: async (n) => {
        if (n === 1) return pendingAnswer(); // the first request: outcome unknown, the claim stays pending
        await bTerminates(d1, kind); // inside the re-send's re-POST: its lease lapses, B terminates the claim
        return settledAnswer();
      },
      rpc: () => authStateAnswer(false),
    });
    try {
      const header = paymentHeaderFor(TREASURY_ADDRESS, "1000000");
      const first = await callWorker(patronReq("rent", header), eq(d1));
      assert.equal(first.status, 502);
      assert.equal(oneClaim(d1).state, "pending");

      const { value: res, lines } = await captureLog(() => callWorker(patronReq("rent", header), eq(d1)));
      const body = await json(res);
      assert.equal(res.status, 500, JSON.stringify(body));
      assert.equal(body.code, "settlement_contradiction");
      assert.equal(body.accepts, undefined, "no fresh payment requirements");
      assert.match(String(body.error), new RegExp(TX));
      assert.match(String(body.error), /Do not sign again/);
      assert.match(String(body.error), /may have moved/);
      assert.doesNotMatch(String(body.error), /nothing was charged|sign a fresh one/i);
      const c = eventLines(lines, "settlement_contradiction");
      assert.equal(c.length, 1, "exactly one contradiction line");
      assert.equal(c[0].level, "error");
      assert.equal(c[0].state, kind);
      assert.equal(c[0].tx, TX);
      assert.equal(c[0].payer, TEST_PAYER);
      const row = oneClaim(d1);
      assert.equal(row.state, kind, "the claim row is still in the terminal state B left it");
      // C1 (A1): the contradiction stamped the row: the facilitator's tx, and a verdict_reason marker that keeps B's own reason inside it.
      assert.equal(row.tx, TX);
      assert.ok(String((row as { verdict_reason?: string }).verdict_reason).startsWith(`settlement_contradiction:${TX}|`), "stamped with the contradiction marker");
      assert.equal(row.rpc_body, null);
      assert.equal(count(d1, "ledger"), 0, "nothing was booked");
      assert.equal(stub.calls.settle, 2);
    } finally {
      stub.restore();
      d1.close();
    }
  });

  test(`H2 reconciler (${kind}): the same race inside the scheduled reconciler is counted as contradicted (never booked, resolved or unchanged), logged once, and leaves the claim ${kind}, now stamped (C1)`, async () => {
    const d1 = createLocalD1();
    const stub = stubFacilitator({
      settle: async (n) => {
        if (n === 1) return pendingAnswer();
        await bTerminates(d1, kind);
        return settledAnswer();
      },
      rpc: () => authStateAnswer(false),
    });
    try {
      const first = await callWorker(patronReq("rent", paymentHeaderFor(TREASURY_ADDRESS, "1000000")), eq(d1));
      assert.equal(first.status, 502);
      const { value: out, lines } = await captureLog(() => runReconciler(eq(d1)));
      assert.equal(out.contradicted, 1);
      assert.equal(out.booked, 0);
      assert.equal(out.resolved, 0);
      assert.equal(out.unchanged, 0);
      assert.equal(out.failed, 0);
      const c = eventLines(lines, "settlement_contradiction");
      assert.equal(c.length, 1, "exactly one contradiction line");
      assert.equal(c[0].state, kind);
      assert.equal(c[0].tx, TX);
      const row = oneClaim(d1);
      assert.equal(row.state, kind);
      assert.equal(row.tx, TX, "C1: stamped with the facilitator's tx");
      assert.ok(String((row as { verdict_reason?: string }).verdict_reason).startsWith(`settlement_contradiction:${TX}|`), "and the marker");
      assert.equal(count(d1, "ledger"), 0);
    } finally {
      stub.restore();
      d1.close();
    }
  });
}
