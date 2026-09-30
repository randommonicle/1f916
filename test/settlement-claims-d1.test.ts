// The settlement claim module (src/settlement-claims.ts) against a real SQLite
// engine and the real schema.sql: the key's identity, the INSERT that is the
// claim, the lease, the state transitions, and the one-batch booking step. The
// route-level guarantees (tests 1-14 of docs/BRIEF-SETTLEMENT-REPLAY-GUARD.md)
// live in test/settlement-replay-routes-d1.test.ts; this file proves the
// primitives they stand on, each of which is red-proofed (docs/CHECKPOINT-SETTLEMENT-REPLAY-GUARD.md).
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, type LocalD1 } from "./helpers/local-d1.ts";
import { appendChainedStmt, sha256Hex } from "../src/chain.ts";
import type { Env } from "../src/society.ts";
import {
  acquireLease,
  canonicalJson,
  claimIdentity,
  claimKeyFromPayload,
  getClaim,
  keyArgs,
  KEY_WHERE,
  markExpired,
  markRefused,
  markSettled,
  refsOf,
  releaseLease,
  runBookingStep,
  takeClaim,
  CLAIM_LEASE_TTL_MS,
  type ClaimSpec,
} from "../src/settlement-claims.ts";

const REQS = { network: "base", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" };
const FROM = "0x00000000000000000000000000000000000000Fa";
const NONCE = "0x" + "AB".repeat(32);

function env(d1: LocalD1): Env {
  return { DB: d1.DB } as unknown as Env;
}
function payload(over: Record<string, unknown> = {}) {
  return { payload: { authorization: { from: FROM, to: "0x1", value: "1000000", validBefore: "9999999999", nonce: NONCE, ...over } } };
}
const SPEC: ClaimSpec = { route: "patron", intent: { line: "hello" } };

async function take(d1: LocalD1, spec: ClaimSpec = SPEC, over: Record<string, unknown> = {}, owner = "w1", now = 1_000) {
  const { key, validBefore } = claimKeyFromPayload(payload(over), REQS);
  const id = await claimIdentity(key, validBefore, { paymentPayload: payload(over) }, spec);
  return { key, id, result: await takeClaim(env(d1), id, spec, owner, now) };
}

test("the key folds EIP-55 casing: a replay that re-cases from or nonce lands on the same key", () => {
  const a = claimKeyFromPayload(payload(), REQS).key;
  const b = claimKeyFromPayload(payload({ from: FROM.toLowerCase(), nonce: NONCE.toLowerCase() }), REQS).key;
  assert.deepEqual(a, b);
  assert.equal(a.from, FROM.toLowerCase());
  assert.equal(a.nonce, NONCE.toLowerCase());
  assert.equal(a.asset, REQS.asset.toLowerCase());
});

test("a malformed authorisation (no from, short nonce, no validBefore) is refused 400 before anything is sent", () => {
  for (const over of [{ from: undefined }, { from: "0x12" }, { nonce: "0x12" }, { nonce: undefined }, { validBefore: undefined }, { validBefore: "soon" }]) {
    assert.throws(
      () => claimKeyFromPayload(payload(over), REQS),
      (e: unknown) => (e as { status?: number; code?: string }).status === 400 && (e as { code?: string }).code === "payment_authorization_malformed",
      JSON.stringify(over),
    );
  }
  assert.throws(() => claimKeyFromPayload({ payload: {} }, REQS), /missing/);
});

test("validBefore is unix seconds as an integer and is clamped, not overflowed", () => {
  assert.equal(claimKeyFromPayload(payload({ validBefore: "1735689600" }), REQS).validBefore, 1735689600);
  assert.equal(claimKeyFromPayload(payload({ validBefore: "9".repeat(60) }), REQS).validBefore, Number.MAX_SAFE_INTEGER);
});

test("canonicalJson is key-order independent", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [2, { y: 1, x: 2 }], c: null } }), canonicalJson({ a: { c: null, d: [2, { x: 2, y: 1 }] }, b: 1 }));
  assert.notEqual(canonicalJson({ a: 1 }), canonicalJson({ a: 2 }));
});

test("the INSERT is the claim: the first taker wins, an identical replay conflicts, a re-cased replay conflicts, a divergent intent is not identical", async () => {
  const d1 = createLocalD1();
  try {
    const first = await take(d1);
    assert.deepEqual(first.result, { taken: true });
    const row = await getClaim(env(d1), first.key);
    assert.equal(row?.state, "pending");
    assert.equal(row?.lease_owner, "w1", "the taker holds the lease from the first instant");
    assert.equal(row?.leased_until, 1_000 + CLAIM_LEASE_TTL_MS);
    assert.equal(row?.booked_refs, "{}");

    const again = await take(d1, SPEC, {}, "w2", 2_000);
    assert.equal(again.result.taken, false);
    assert.equal(again.result.taken === false && again.result.identical, true);

    const recased = await take(d1, SPEC, { from: FROM.toLowerCase(), nonce: NONCE.toLowerCase() }, "w3", 3_000);
    assert.equal(recased.result.taken, false, "casing is presentation, not identity");

    const divergent = await take(d1, { route: "patron", intent: { line: "a different line" } }, {}, "w4", 4_000);
    assert.equal(divergent.result.taken === false && divergent.result.identical, false, "same rpc_body, different intent: divergent (B4a)");

    const otherRoute = await take(d1, { route: "register", intent: { line: "hello" } }, {}, "w5", 5_000);
    assert.equal(otherRoute.result.taken === false && otherRoute.result.identical, false, "a second route reusing one nonce is divergent");

    const fresh = await take(d1, SPEC, { nonce: "0x" + "cd".repeat(32) }, "w6", 6_000);
    assert.deepEqual(fresh.result, { taken: true }, "a fresh authorisation (new nonce) claims normally");
    assert.equal((d1.raw.prepare("SELECT COUNT(*) AS n FROM settlement_claims").get() as { n: number }).n, 2);
  } finally {
    d1.close();
  }
});

test("lease: a live lease blocks a second holder; an expired one does not; release is scoped to its owner", async () => {
  const d1 = createLocalD1();
  try {
    const { key } = await take(d1, SPEC, {}, "w1", 10_000);
    assert.equal(await acquireLease(env(d1), key, "w2", 10_000 + 1), null, "the taker's lease is live");
    assert.equal(await acquireLease(env(d1), key, "w2", 10_000 + CLAIM_LEASE_TTL_MS - 1), null, "still live one ms before it lapses");
    const got = await acquireLease(env(d1), key, "w2", 10_000 + CLAIM_LEASE_TTL_MS);
    assert.equal(got?.lease_owner, "w2", "a lapsed lease is takeable");
    assert.equal(got?.updated_at, 10_000 + CLAIM_LEASE_TTL_MS, "acquiring moves updated_at (fair ordering)");
    await releaseLease(env(d1), key, "someone-else");
    assert.equal((await getClaim(env(d1), key))?.lease_owner, "w2", "another owner's release changes nothing");
    await releaseLease(env(d1), key, "w2");
    assert.equal((await getClaim(env(d1), key))?.leased_until, null);
    assert.equal((await acquireLease(env(d1), key, "w3", 10_001))?.lease_owner, "w3");
  } finally {
    d1.close();
  }
});

test("transitions are conditional on the state they leave; terminal rows hold no authorisation body", async () => {
  const d1 = createLocalD1();
  try {
    const a = await take(d1, SPEC, { nonce: "0x" + "01".repeat(32) });
    assert.ok((await getClaim(env(d1), a.key))?.rpc_body, "a pending row keeps the body it may need to re-POST");
    assert.equal(await markSettled(env(d1), a.key, "0xTX", "0xPAYER", 2_000), true);
    assert.equal(await markSettled(env(d1), a.key, "0xTX2", "0xPAYER", 2_001), false, "settled_unbooked cannot be settled again");
    assert.equal(await markRefused(env(d1), a.key, "no", 2_002), false, "settled_unbooked cannot become refused");
    assert.equal(await markExpired(env(d1), a.key, 2_003), false);
    const settled = await getClaim(env(d1), a.key);
    assert.equal(settled?.state, "settled_unbooked");
    assert.equal(settled?.tx, "0xTX");
    assert.equal(settled?.payer, "0xPAYER");

    const b = await take(d1, SPEC, { nonce: "0x" + "02".repeat(32) });
    assert.equal(await markRefused(env(d1), b.key, "The facilitator reports that this settlement failed", 3_000), true);
    const refused = await getClaim(env(d1), b.key);
    assert.equal(refused?.state, "refused");
    assert.equal(refused?.rpc_body, null, "B7: refused clears the authorisation body");
    assert.equal(await markExpired(env(d1), b.key, 3_001), false, "a terminal row does not move");

    const c = await take(d1, SPEC, { nonce: "0x" + "03".repeat(32) });
    assert.equal(await markExpired(env(d1), c.key, 4_000), true);
    assert.equal((await getClaim(env(d1), c.key))?.rpc_body, null, "B7: expired clears it too");
  } finally {
    d1.close();
  }
});

test("B7 is a property of the table: no statement can leave a body on a terminal row", async () => {
  const d1 = createLocalD1();
  try {
    const { key } = await take(d1);
    for (const state of ["booked", "refused", "expired"]) {
      assert.throws(
        () => d1.raw.prepare(`UPDATE settlement_claims SET state = '${state}' WHERE ${KEY_WHERE}`).run(...(keyArgs(key) as never[])),
        /CHECK constraint failed/,
        `${state} with rpc_body still set must be refused by the table`,
      );
    }
    assert.throws(() => d1.raw.prepare(`UPDATE settlement_claims SET state = 'nonsense' WHERE ${KEY_WHERE}`).run(...(keyArgs(key) as never[])), /CHECK constraint failed/);
  } finally {
    d1.close();
  }
});

// A step that books one ledger row and records it.
function ledgerStep(d1: LocalD1, final: boolean, description = "a booked act") {
  return {
    ref: "ledger_id" as const,
    final,
    chain: "ledger" as const,
    statements: async (gate: { sql: string; args: readonly unknown[] }) => [
      (await appendChainedStmt(d1.DB as unknown as D1Database, "ledger", { entry_date: "2026-09-30", description, amount_cents: 100, created_at: 1 }, gate)).stmt,
    ],
  };
}
const ledgerCount = (d1: LocalD1) => (d1.raw.prepare("SELECT COUNT(*) AS n FROM ledger").get() as { n: number }).n;

test("a booking step writes its row and records it in ONE batch, once: a repeat writes nothing", async () => {
  const d1 = createLocalD1();
  try {
    const { key } = await take(d1);
    // Not settled yet: the gate is closed, so the step writes nothing at all.
    assert.deepEqual(await runBookingStep(env(d1), key, ledgerStep(d1, false), 5_000), { applied: false });
    assert.equal(ledgerCount(d1), 0, "a pending claim books nothing");

    await markSettled(env(d1), key, "0xTX", "0xPAYER", 2_000);
    assert.deepEqual(await runBookingStep(env(d1), key, ledgerStep(d1, false), 5_001), { applied: true });
    assert.equal(ledgerCount(d1), 1);
    const row = await getClaim(env(d1), key);
    assert.equal(refsOf(row!).ledger_id, 1, "the ledger row's id is recorded in the claim");
    assert.equal(row?.state, "settled_unbooked", "a non-final step does not book the act");

    assert.deepEqual(await runBookingStep(env(d1), key, ledgerStep(d1, false), 5_002), { applied: false });
    assert.equal(ledgerCount(d1), 1, "the same step run again books nothing more");

    // The final step moves the claim to booked and clears the body, in the same batch.
    const second = {
      ref: "payment_id" as const,
      final: true,
      statements: async (gate: { sql: string; args: readonly unknown[] }) => [
        d1.DB.prepare("INSERT INTO ledger (entry_date, description, amount_cents, created_at) SELECT ?, ?, ?, ? WHERE EXISTS (" + gate.sql + ")").bind("2026-09-30", "unchained", 1, 2, ...gate.args) as unknown as D1PreparedStatement,
      ],
    };
    assert.deepEqual(await runBookingStep(env(d1), key, second, 5_003), { applied: true });
    const booked = await getClaim(env(d1), key);
    assert.equal(booked?.state, "booked");
    assert.equal(booked?.rpc_body, null, "B7: booked clears the body");
    assert.equal(booked?.leased_until, null);
    assert.equal(ledgerCount(d1), 2);
    assert.deepEqual(await runBookingStep(env(d1), key, second, 5_004), { applied: false }, "a booked claim is final: nothing more is ever written");
    assert.equal(ledgerCount(d1), 2);
  } finally {
    d1.close();
  }
});

test("a crash inside the step leaves neither the row nor the reference (B5a/B5c): the batch fails as a unit", async () => {
  const d1 = createLocalD1();
  try {
    const { key } = await take(d1);
    await markSettled(env(d1), key, "0xTX", "0xPAYER", 2_000);

    // (a) the row insert fails
    d1.raw.exec("CREATE TRIGGER crash_ledger BEFORE INSERT ON ledger BEGIN SELECT RAISE(ABORT, 'disk on fire'); END;");
    await assert.rejects(() => runBookingStep(env(d1), key, ledgerStep(d1, false), 5_000), /disk on fire/);
    d1.raw.exec("DROP TRIGGER crash_ledger");
    assert.equal(ledgerCount(d1), 0);
    assert.equal(refsOf((await getClaim(env(d1), key))!).ledger_id, undefined);

    // (b) the row insert succeeds and the REFERENCE update fails: the row must not survive either
    d1.raw.exec("CREATE TRIGGER crash_claim BEFORE UPDATE OF booked_refs ON settlement_claims BEGIN SELECT RAISE(ABORT, 'power cut'); END;");
    await assert.rejects(() => runBookingStep(env(d1), key, ledgerStep(d1, false), 5_001), /power cut/);
    d1.raw.exec("DROP TRIGGER crash_claim");
    assert.equal(ledgerCount(d1), 0, "the created row is rolled back with the failed reference update");
    assert.equal(refsOf((await getClaim(env(d1), key))!).ledger_id, undefined);

    // and the step still completes afterwards, once
    assert.deepEqual(await runBookingStep(env(d1), key, ledgerStep(d1, false), 5_002), { applied: true });
    assert.equal(ledgerCount(d1), 1);
  } finally {
    d1.close();
  }
});

test("a chain-head race inside the step is retried against the new head, not lost", async () => {
  const d1 = createLocalD1();
  try {
    const { key } = await take(d1);
    await markSettled(env(d1), key, "0xTX", "0xPAYER", 2_000);
    let raced = false;
    const racing = {
      ...ledgerStep(d1, true),
      statements: async (gate: { sql: string; args: readonly unknown[] }) => {
        const built = await appendChainedStmt(d1.DB as unknown as D1Database, "ledger", { entry_date: "2026-09-30", description: "racing", amount_cents: 100, created_at: 1 }, gate);
        if (!raced) {
          raced = true;
          // Another writer appends after this attempt read the head: its prev_hash is now taken.
          const head = await sha256Hex("someone else");
          d1.raw.prepare("INSERT INTO ledger (entry_date, description, amount_cents, created_at, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?)").run("2026-09-30", "rival", 1, 1, built.prev_hash, head);
        }
        return [built.stmt];
      },
    };
    assert.deepEqual(await runBookingStep(env(d1), key, racing, 5_000), { applied: true });
    assert.equal(ledgerCount(d1), 2, "the rival row and ours, chained after it");
    assert.equal((await getClaim(env(d1), key))?.state, "booked");
  } finally {
    d1.close();
  }
});
