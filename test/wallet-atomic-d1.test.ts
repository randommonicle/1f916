// A wallet declaration and its identity-log row commit together or not at all
// (DEFERRED-WALLET-DECLARE-BATCH, drafts/BRIEF-WALLET-DECLARE-BATCH-2026-11-23.md).
//
// Before this change declareWallet wrote the payout address and then, as a
// separate write, the chained wallet_declared / wallet_changed row, so a log
// failure left a changed destination with no row, and two concurrent declares
// were last-write-wins. Now one batch: a compare-and-set state statement plus a
// chained INSERT gated on changes() = 1.
//
// Every failure is forced for real: SQLite triggers, a real concurrent write in
// the batch's race window, real UNIQUE indexes. Real SQLite via createLocalD1
// (real schema.sql, a real transaction in batch()). Only Date.now is pinned in
// test 5, restored in finally, and the x402 facilitator is stubbed in test 10
// exactly as wallet-pin-route-d1.test.ts does.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, insertCitizen, insertListing, insertSubmission, type LocalD1 } from "./helpers/local-d1.ts";
import { newestWalletRow } from "./helpers/wallet-pin.ts";
import { paymentHeaderFor, atomicFromCents } from "./helpers/x402-payload.ts";
import { declareWallet } from "../src/wallets.ts";
import { handlePayListing } from "../src/listings.ts";
import { appendChained, attest } from "../src/chain.ts";
import { SocietyError, type Env } from "../src/society.ts";

const A = "0x" + "0a".repeat(20);
const B = "0x" + "0b".repeat(20);
const C = "0x" + "0c".repeat(20);
const RACE_SENTENCE =
  "Another wallet declaration for this citizenship committed first, so this one wrote nothing. Read GET /api/events?kind=wallet_declared and GET /api/events?kind=wallet_changed for the wallet now on record, then declare again if you still want this address. A public-key citizen signs a fresh assertion for that request: each assertion is spent once.";
const TAKEN_SENTENCE =
  "That address is already declared by another citizen. One address, one citizen: the prize rule (one per wallet per period) depends on it.";

function testEnv(d1: LocalD1): Env {
  return {
    DB: d1.DB,
    TREASURY_ADDRESS: "0x0000000000000000000000000000000000000000",
    FACILITATOR_URL: "https://facilitator.invalid",
    REGISTRATION_MODE: "open",
  } as unknown as Env;
}

// A real concurrent write in the race window: `before` runs once, just before
// the first batch; then, just before each of the first `times` batches, another
// chained row is appended so the batch's prev_hash is stale and SQLite raises a
// real UNIQUE on identity_events. `batches` counts batch() calls.
function racingEnv(d1: LocalD1, times: number, before?: () => Promise<void>) {
  let left = times;
  const counter = { batches: 0 };
  const db = new Proxy(d1.DB, {
    get(target, prop) {
      if (prop === "batch") {
        return async (stmts: D1PreparedStatement[]) => {
          counter.batches++;
          if (before) { const b = before; before = undefined; await b(); }
          if (left > 0) {
            left--;
            await appendChained(d1.DB, "identity_events", { citizen_id: 1, kind: "moderation", detail: "a concurrent append", created_at: Date.now() });
          }
          return target.batch(stmts);
        };
      }
      const v = (target as unknown as Record<string | symbol, unknown>)[prop];
      return typeof v === "function" ? (v as Function).bind(target) : v;
    },
  });
  return { env: { ...testEnv(d1), DB: db } as Env, counter };
}

function walletRow(d1: LocalD1, citizenId: number) {
  const r = d1.raw.prepare("SELECT address, added_at FROM wallets WHERE citizen_id = ?").get(citizenId) as { address: string; added_at: number } | undefined;
  return r ? { address: r.address, added_at: r.added_at } : undefined;
}
function walletLogRows(d1: LocalD1, citizenId?: number): number {
  const base = "SELECT COUNT(*) AS n FROM identity_events WHERE kind IN ('wallet_declared', 'wallet_changed')";
  const r = citizenId === undefined ? d1.raw.prepare(base).get() : d1.raw.prepare(base + " AND citizen_id = ?").get(citizenId);
  return (r as { n: number }).n;
}
const isStatus = (status: number, message?: string) => (e: unknown) =>
  e instanceof SocietyError && e.status === status && (message === undefined || e.message === message);

test("1: a log failure leaves the table unchanged, on a first declare and on a change", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const c1 = insertCitizen(d1);
    const c2 = insertCitizen(d1);
    d1.raw.exec(
      "CREATE TRIGGER force_wallet_log_failure BEFORE INSERT ON identity_events WHEN NEW.kind IN ('wallet_declared', 'wallet_changed') AND NEW.citizen_id = 1 BEGIN SELECT RAISE(ABORT, 'forced wallet log failure'); END;",
    );
    await assert.rejects(() => declareWallet(env, { id: c1 }, A, null), /forced wallet log failure/);
    assert.equal(walletRow(d1, c1), undefined, "a first declare left a wallets row although its log row failed");
    assert.equal(walletLogRows(d1, c1), 0);

    // The change branch: citizen 2 declares normally, then the trigger is pointed at it.
    await declareWallet(env, { id: c2 }, A, null);
    d1.raw.exec("DROP TRIGGER force_wallet_log_failure");
    d1.raw.exec(
      "CREATE TRIGGER force_wallet_log_failure2 BEFORE INSERT ON identity_events WHEN NEW.kind = 'wallet_changed' BEGIN SELECT RAISE(ABORT, 'forced wallet log failure'); END;",
    );
    await assert.rejects(() => declareWallet(env, { id: c2 }, B, null), /forced wallet log failure/);
    assert.equal(walletRow(d1, c2)?.address, A, "a change moved the payout address although its log row failed");
    assert.equal(walletLogRows(d1, c2), 1, "only the original declaration is logged");
  } finally {
    d1.close();
  }
});

test("2: one moved chain head retries, commits once, and returns the hash of the row written", async () => {
  const d1 = createLocalD1();
  try {
    const c1 = insertCitizen(d1);
    const { env, counter } = racingEnv(d1, 1);
    const out = (await declareWallet(env, { id: c1 }, A, null)) as { chain_head: string };
    assert.equal(counter.batches, 2);
    assert.equal(walletRow(d1, c1)?.address, A);
    const rows = d1.raw.prepare("SELECT hash FROM identity_events WHERE kind = 'wallet_declared'").all() as { hash: string }[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].hash, out.chain_head);
    const audit = (await attest(d1.DB)) as { identity_log: { ok: boolean } };
    assert.equal(audit.identity_log.ok, true, "the identity chain must still verify after the retry");
  } finally {
    d1.close();
  }
});

test("3: four moved chain heads in a row end in 503 with nothing written", async () => {
  const d1 = createLocalD1();
  try {
    const c1 = insertCitizen(d1);
    const c2 = insertCitizen(d1);
    await declareWallet(testEnv(d1), { id: c2 }, B, null);
    const { env } = racingEnv(d1, 4);
    await assert.rejects(() => declareWallet(env, { id: c1 }, A, null), isStatus(503));
    assert.equal(walletRow(d1, c1), undefined);
    assert.equal(walletLogRows(d1, c1), 0);
    const { env: env2 } = racingEnv(d1, 4);
    await assert.rejects(() => declareWallet(env2, { id: c2 }, C, null), isStatus(503));
    assert.equal(walletRow(d1, c2)?.address, B, "a change moved the address although the head never settled");
  } finally {
    d1.close();
  }
});

test("4: of two changes that read the same row, the loser writes nothing and the winner stands", async () => {
  const d1 = createLocalD1();
  try {
    const base = testEnv(d1);
    const c1 = insertCitizen(d1);
    await declareWallet(base, { id: c1 }, A, null);
    let hookRan = false;
    const { env: loserEnv } = racingEnv(d1, 0, async () => { await declareWallet(base, { id: c1 }, C, null); hookRan = true; });
    await assert.rejects(() => declareWallet(loserEnv, { id: c1 }, B, null), isStatus(409, RACE_SENTENCE));
    assert.ok(hookRan, "the winner must commit inside the loser's race window");
    assert.equal(walletRow(d1, c1)?.address, C, "the winner's address was overwritten");
    assert.equal(
      (d1.raw.prepare("SELECT COUNT(*) AS n FROM identity_events WHERE kind = 'wallet_changed' AND citizen_id = ?").get(c1) as { n: number }).n,
      1,
      "exactly the winner's wallet_changed row",
    );
  } finally {
    d1.close();
  }
});

test("5: A -> B -> A inside the loser's window, with every sampled time equal to the stored one, still refuses the loser", async () => {
  const d1 = createLocalD1();
  const realNow = Date.now;
  try {
    const base = testEnv(d1);
    const c1 = insertCitizen(d1);
    await declareWallet(base, { id: c1 }, A, null);
    const T = walletRow(d1, c1)!.added_at;
    const { env: loserEnv } = racingEnv(d1, 0, async () => {
      Date.now = () => T;
      try {
        await declareWallet(base, { id: c1 }, B, null);
        await declareWallet(base, { id: c1 }, A, null);
      } finally {
        Date.now = realNow;
      }
    });
    await assert.rejects(() => declareWallet(loserEnv, { id: c1 }, C, null), isStatus(409, RACE_SENTENCE));
    assert.equal(walletRow(d1, c1)?.address, A, "the loser's batch matched a row whose address had been away and back");
    assert.equal((d1.raw.prepare("SELECT COUNT(*) AS n FROM identity_events WHERE kind = 'wallet_changed' AND citizen_id = ?").get(c1) as { n: number }).n, 2, "the loser wrote a stray row");
  } finally {
    Date.now = realNow;
    d1.close();
  }
});

test("5b: a sampled time below the stored added_at still commits, and the stored value advances by one", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const c1 = insertCitizen(d1);
    await declareWallet(env, { id: c1 }, A, null);
    const ahead = Date.now() + 60_000;
    d1.raw.prepare("UPDATE wallets SET added_at = ? WHERE citizen_id = ?").run(ahead, c1);
    await declareWallet(env, { id: c1 }, B, null);
    const row = walletRow(d1, c1)!;
    assert.equal(row.address, B);
    assert.equal(row.added_at, ahead + 1);
  } finally {
    d1.close();
  }
});

test("6: a concurrent first declare is a race 409 through wallets.citizen_id, never 'another citizen'", async () => {
  for (const [winnerAddr, label] of [[B, "different address"], [A, "same address"]] as const) {
    const d1 = createLocalD1();
    try {
      const base = testEnv(d1);
      const c1 = insertCitizen(d1);
      const { env: loserEnv } = racingEnv(d1, 0, async () => { await declareWallet(base, { id: c1 }, winnerAddr, null); });
      await assert.rejects(() => declareWallet(loserEnv, { id: c1 }, A, null), isStatus(409, RACE_SENTENCE), label);
      assert.equal(walletRow(d1, c1)?.address, winnerAddr, `${label}: the winner's row was overwritten`);
      assert.equal(walletLogRows(d1, c1), 1, `${label}: one log row`);
    } finally {
      d1.close();
    }
  }
});

test("7: another citizen's address is the unchanged 409, on a first declare and on a change, in one batch", async () => {
  const d1 = createLocalD1();
  try {
    const base = testEnv(d1);
    const c1 = insertCitizen(d1);
    const c2 = insertCitizen(d1);
    const c3 = insertCitizen(d1);
    await declareWallet(base, { id: c1 }, A, null);
    await declareWallet(base, { id: c3 }, C, null);
    const logsBefore = walletLogRows(d1);

    const first = racingEnv(d1, 0);
    await assert.rejects(() => declareWallet(first.env, { id: c2 }, A, null), isStatus(409, TAKEN_SENTENCE));
    assert.equal(first.counter.batches, 1);
    assert.equal(walletRow(d1, c2), undefined);

    const change = racingEnv(d1, 0);
    await assert.rejects(() => declareWallet(change.env, { id: c3 }, A, null), isStatus(409, TAKEN_SENTENCE));
    assert.equal(change.counter.batches, 1);
    assert.equal(walletRow(d1, c3)?.address, C);
    assert.equal(walletLogRows(d1), logsBefore, "a refused declaration logged a row");
  } finally {
    d1.close();
  }
});

test("8: a UNIQUE on another table during the batch is rethrown at once, not retried, and writes nothing", async () => {
  const d1 = createLocalD1();
  try {
    const c1 = insertCitizen(d1);
    d1.raw.exec(
      "CREATE TABLE wallet_side_effect (x TEXT UNIQUE); INSERT INTO wallet_side_effect VALUES ('dup');" +
        " CREATE TRIGGER force_foreign_unique AFTER INSERT ON wallets BEGIN INSERT INTO wallet_side_effect VALUES ('dup'); END;",
    );
    const { env, counter } = racingEnv(d1, 0);
    await assert.rejects(
      () => declareWallet(env, { id: c1 }, A, null),
      (e: unknown) => !(e instanceof SocietyError) && /UNIQUE constraint failed: wallet_side_effect\.x/.test(String(e)),
    );
    assert.equal(counter.batches, 1, "a foreign UNIQUE was retried as if the chain head had moved");
    assert.equal(walletRow(d1, c1), undefined);
    assert.equal(walletLogRows(d1), 0);
  } finally {
    d1.close();
  }
});

test("9: an inconsistent result vector is a 500, never a success answer", async () => {
  const d1 = createLocalD1();
  try {
    const c1 = insertCitizen(d1);
    d1.raw.exec("CREATE TRIGGER ignore_wallet_log BEFORE INSERT ON identity_events WHEN NEW.kind = 'wallet_declared' BEGIN SELECT RAISE(IGNORE); END;");
    await assert.rejects(() => declareWallet(testEnv(d1), { id: c1 }, A, null), isStatus(500));
    // The batch committed the state row before the log row was ignored: the 500 means "do not trust this", and the table is pinned here.
    assert.equal(walletRow(d1, c1)?.address, A);
    assert.equal(walletLogRows(d1, c1), 0);
  } finally {
    d1.close();
  }
});

// Test 10: the pay route's pin accepts what the REAL declareWallet writes.
function stubFacilitator() {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown) => {
    const href = String(url);
    if (href.endsWith("/verify")) return new Response(JSON.stringify({ isValid: true }), { status: 200, headers: { "content-type": "application/json" } });
    if (href.endsWith("/settle")) {
      return new Response(JSON.stringify({ success: true, payer: "0x00000000000000000000000000000000000000fa", transaction: "0x" + "ab".repeat(32) }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch in wallet-atomic-d1.test.ts: ${href}`);
  }) as typeof fetch;
  return () => { globalThis.fetch = original; };
}

test("10: the pay route's pin passes after a first declare and after a change, both made through the real declareWallet", async () => {
  for (const changeTo of [null, B] as const) {
    const d1 = createLocalD1();
    const restore = stubFacilitator();
    try {
      const env = { ...testEnv(d1), TREASURY_ADDRESS: "0xa7f7985eb19b8c44f12a0654df1ef89d1dd527c9", FACILITATOR_URL: "https://facilitator.example.invalid" } as Env;
      const funderId = insertCitizen(d1);
      const funder = d1.raw.prepare("SELECT id, handle, model, karma, created_at, last_seen_at FROM citizens WHERE id = ?").get(funderId) as never;
      const reviewerId = insertCitizen(d1);
      await declareWallet(env, { id: reviewerId }, A, null);
      if (changeTo) await declareWallet(env, { id: reviewerId }, changeTo, null);
      const expected = changeTo ?? A;
      const pin = newestWalletRow(d1, reviewerId)!;
      const listingId = insertListing(d1, { funder_citizen_id: funderId, bounty_cents: 1200 });
      const submissionId = insertSubmission(d1, { listing_id: listingId, citizen_id: reviewerId });
      const req = new Request(`https://example.test/api/listing/${listingId}/pay`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-PAYMENT": paymentHeaderFor(expected, atomicFromCents(1200)) },
        body: JSON.stringify({ submission_id: submissionId, wallet_row_id: pin.id, wallet_row_hash: pin.hash }),
      });
      const res = await handlePayListing(req, env, funder, listingId);
      assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
      assert.equal(((await res.json()) as { payee_address: string }).payee_address, expected);
    } finally {
      restore();
      d1.close();
    }
  }
});
