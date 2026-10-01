// F7 (docs/CHECKPOINT-X402-SETTLE-HONESTY.md, build review round 2, CODEX HIGH): the
// treasury ledger line that registration, the patron door and listing creation each
// write AFTER payAndSettle has returned ok, i.e. after the money moved.
//
// Before the fix that append sat outside any catch. If it threw, the payer either
// read appendChained's own 503, "The write was never committed -- retrying may
// succeed." (four UNIQUE conflicts in a row), or the router's generic 500. A retry
// needs a fresh signature, which is a second payment, and nothing logged named the
// settled transaction. recordSettledPayment (src/x402.ts) turns EVERY failure of the
// append into one honest 500 and one log line.
//
// The facilitator is genuinely external, so its HTTP surface is stubbed via
// globalThis.fetch exactly as test/x402-settle-route-d1.test.ts stubs it: a valid
// /verify and a settled /settle. Nothing else is mocked: createLocalD1 is real SQLite
// with the real schema.sql, and the ledger failure is a real SQLite trigger raising
// on every INSERT INTO ledger, which is how a failed write looks to appendChained.
// Two flavours: an error whose text contains "UNIQUE" (appendChained retries four
// times, then throws its 503) and one that does not (appendChained rethrows at once).
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, insertCitizen, type LocalD1 } from "./helpers/local-d1.ts";
import { paymentHeaderFor, atomicFromCents, TEST_PAYER } from "./helpers/x402-payload.ts";
import { handleCreateListing, computeListingFeeCents } from "../src/listings.ts";
import { recordSettledPayment } from "../src/x402.ts";
import { SocietyError, type Env } from "../src/society.ts";
import worker from "../src/index.ts";

const TREASURY_ADDRESS = "0xa7f7985eb19b8c44f12a0654df1ef89d1dd527c9";
const FACILITATOR_URL = "https://facilitator.example.invalid";
const TX = "0x" + "ab".repeat(32);
const BOUNTY_CENTS = 1000;

// The hub's words (brief F7), typed here rather than imported, so a change to the
// served wording fails these tests instead of silently passing them.
const hubUnrecorded = (dollars: string, tx: string) =>
  `Your $${dollars} payment settled (tx ${tx}), but the society could not record it in its treasury ledger. Do not sign again: this payment has already moved. This is logged for the maintainer to put right by hand. To add your own report, leave a free showhome note naming this tx: POST /api/showhome/enter (any label that is not a citizen handle), then POST /api/showhome/note.`;

function testEnv(d1: LocalD1): Env {
  return { DB: d1.DB, TREASURY_ADDRESS, FACILITATOR_URL, REGISTRATION_MODE: "open" } as unknown as Env;
}

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
function callWorker(request: Request, env: Env): Promise<Response> {
  return (worker.fetch as unknown as (r: Request, e: Env, c: unknown) => Promise<Response>)(request, env, ctx);
}

// A valid /verify and a settled /settle: the payment moves, then the ledger fails.
function stubFacilitator() {
  const original = globalThis.fetch;
  const calls = { verify: 0, settle: 0 };
  globalThis.fetch = (async (url: unknown) => {
    const href = String(url);
    if (href === `${FACILITATOR_URL}/verify`) {
      calls.verify++;
      return new Response(JSON.stringify({ isValid: true }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (href === `${FACILITATOR_URL}/settle`) {
      calls.settle++;
      return new Response(JSON.stringify({ success: true, payer: TEST_PAYER, transaction: TX }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch in x402-post-settle-record-d1.test.ts: ${href}`);
  }) as typeof fetch;
  return {
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

function count(d1: LocalD1, fromWhere: string): number {
  return (d1.raw.prepare(`SELECT COUNT(*) AS n FROM ${fromWhere}`).get() as { n: number }).n;
}
const written = (d1: LocalD1) => ({ citizens: count(d1, "citizens"), ledger: count(d1, "ledger"), reg: count(d1, "reg_log"), listings: count(d1, "listings") });

// The status and error text a route answers with, whether the handler RETURNED a
// Response or THREW: a SocietyError is what the router serves under its own status;
// anything else is the router's generic 500 (src/index.ts's catch).
async function answerOf(p: Promise<Response>): Promise<{ status: number; error: string }> {
  try {
    const res = await p;
    return { status: res.status, error: String(((await res.json()) as { error?: unknown }).error) };
  } catch (e) {
    if (e instanceof SocietyError) return { status: e.status, error: e.message };
    return { status: 500, error: "Internal error. The society apologizes." };
  }
}

// Every console.log line printed while `fn` runs, restored in a finally.
async function captureLog<T>(fn: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    return { value: await fn(), lines };
  } finally {
    console.log = originalLog;
  }
}

// The lines that are JSON objects, parsed; anything else is ignored.
function logRecords(lines: string[]): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as unknown;
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) out.push(parsed as Record<string, unknown>);
    } catch {
      /* not a JSON line */
    }
  }
  return out;
}
const unrecordedLines = (lines: string[]) => logRecords(lines).filter((r) => r.event === "payment_settled_unrecorded");

// Every INSERT INTO ledger now fails with `message`, the way a failed write reaches
// appendChained: SQLite raises an Error whose message is exactly this text.
function failLedgerInserts(d1: LocalD1, message: string): void {
  assert.equal(message.includes("'"), false, "the message is embedded in a SQL string literal");
  d1.raw.exec(`CREATE TRIGGER f7_fail_ledger_insert BEFORE INSERT ON ledger BEGIN SELECT RAISE(ABORT, '${message}'); END;`);
}

// ---------- the three doors ----------

type Funder = { id: number; handle: string };
function fixture(): { d1: LocalD1; funder: Funder } {
  const d1 = createLocalD1();
  const funderId = insertCitizen(d1);
  const funder = { ...(d1.raw.prepare("SELECT id, handle FROM citizens WHERE id = ?").get(funderId) as Funder) };
  return { d1, funder };
}

function registerReq(handle: string): Request {
  return new Request("https://example.test/api/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-PAYMENT": paymentHeaderFor(TREASURY_ADDRESS, "1000000") },
    body: JSON.stringify({ handle, model: "test-model" }),
  });
}
function patronReq(): Request {
  return new Request("https://example.test/api/patron", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-PAYMENT": paymentHeaderFor(TREASURY_ADDRESS, "1000000") },
    body: JSON.stringify({ message: "hello" }),
  });
}
function listingCreateReq(): Request {
  return new Request("https://example.test/api/listing", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-PAYMENT": paymentHeaderFor(TREASURY_ADDRESS, atomicFromCents(computeListingFeeCents(BOUNTY_CENTS))) },
    body: JSON.stringify({
      title: "Review my auth middleware",
      description: "Stuck on token refresh, please review for race conditions",
      acceptance_condition: "a reviewer identifies at least one real correctness issue or confirms none exist",
      bounty_cents: BOUNTY_CENTS,
      expires_at: Date.now() + 7 * 86_400_000,
    }),
  });
}

interface Door {
  route: "registration" | "patron" | "listing_fee";
  // What the payer signed for: the amount the failure message must state.
  amountCents: number;
  call: (d1: LocalD1, funder: Funder) => Promise<Response>;
  successStatus: number;
  receiptOf: (body: Record<string, unknown>) => unknown;
}
const DOORS: Door[] = [
  {
    route: "registration",
    amountCents: 100,
    call: (d1) => callWorker(registerReq("f7-registrant"), testEnv(d1)),
    successStatus: 201,
    receiptOf: (body) => (body.payment as { ledger_receipt?: unknown }).ledger_receipt,
  },
  {
    route: "patron",
    amountCents: 100,
    call: (d1) => callWorker(patronReq(), testEnv(d1)),
    successStatus: 200,
    receiptOf: (body) => body.receipt,
  },
  {
    route: "listing_fee",
    amountCents: computeListingFeeCents(BOUNTY_CENTS),
    call: (d1, funder) => handleCreateListing(listingCreateReq(), testEnv(d1), funder),
    successStatus: 201,
    receiptOf: (body) => body.receipt,
  },
];

// (a) an error whose text contains "UNIQUE": appendChained retries four times, then
// throws its own 503 ("... retrying may succeed."). (b) any other error: rethrown at
// once, the raw error the router serves as its generic 500. `reasonOk` is what the
// logged reason must show, so the two flavours are proven to take different paths.
const VARIANTS: { tag: string; message: string; reasonOk: (reason: unknown) => boolean }[] = [
  {
    tag: "(a) UNIQUE conflict on every attempt, appendChained's 503",
    message: "UNIQUE constraint failed: ledger.hash",
    reasonOk: (reason) => typeof reason === "string" && reason.startsWith("chain head for ledger moved four times running"),
  },
  {
    tag: "(b) disk I/O error, rethrown at once",
    message: "disk I/O error",
    reasonOk: (reason) => reason === "disk I/O error",
  },
];

for (const door of DOORS) {
  for (const variant of VARIANTS) {
    test(`F7 ${door.route} ${variant.tag}: a payment that settled but could not be booked answers 500 with the hub's words (never 'retrying may succeed'), logs one payment_settled_unrecorded line, and writes nothing`, async () => {
      const { d1, funder } = fixture();
      const stub = stubFacilitator();
      try {
        failLedgerInserts(d1, variant.message);
        const before = written(d1);
        const { value: answer, lines } = await captureLog(() => answerOf(door.call(d1, funder)));
        const dollars = (door.amountCents / 100).toFixed(2);

        // The answer first: status and message together, in the hub's words with the
        // settled tx and the amount signed.
        assert.deepEqual(answer, { status: 500, error: hubUnrecorded(dollars, TX) }, `${door.route} ${variant.tag}: the honest 500`);
        assert.doesNotMatch(answer.error, /retrying may succeed/, `${door.route}: no retry advice`);
        assert.doesNotMatch(answer.error, /never committed/, `${door.route}: no claim that nothing was committed`);
        assert.deepEqual(stub.calls, { verify: 1, settle: 1 }, `${door.route}: the payment was verified and settled once, nothing else was sent`);

        // Exactly one log line, naming the settled transaction.
        const records = unrecordedLines(lines);
        assert.equal(records.length, 1, `${door.route}: exactly one payment_settled_unrecorded line`);
        const record = records[0];
        assert.deepEqual(Object.keys(record).sort(), ["amount_cents", "event", "level", "payer", "reason", "route", "tx"], `${door.route}: the line's fields`);
        assert.equal(record.level, "error", `${door.route}: level`);
        assert.equal(record.route, door.route, `${door.route}: route`);
        assert.equal(record.payer, TEST_PAYER, `${door.route}: payer`);
        assert.equal(record.tx, TX, `${door.route}: tx`);
        assert.equal(record.amount_cents, door.amountCents, `${door.route}: amount_cents`);
        assert.ok(variant.reasonOk(record.reason), `${door.route} ${variant.tag}: the logged reason is the inner error's message: ${String(record.reason)}`);
        assert.deepEqual(
          logRecords(lines).filter((r) => String(r.event).endsWith("_paid_but_failed")),
          [],
          `${door.route}: the later paid-but-failed handling never ran`,
        );

        // Nothing was written: no ledger line, and no citizen or listing made ahead of a line that could not be booked.
        assert.deepEqual(written(d1), before, `${door.route}: no ledger line, citizen, reg_log row or listing`);
      } finally {
        stub.restore();
        d1.close();
      }
    });
  }
}

// The control: with no trigger every door books its line and answers as before, so a
// failure above is the trigger's doing and not the harness's.
test("F7 control: with a working ledger every door succeeds, writes exactly one ledger line of the amount signed, returns that line's hash as its receipt, and logs no payment_settled_unrecorded line", async () => {
  for (const door of DOORS) {
    const { d1, funder } = fixture();
    const stub = stubFacilitator();
    try {
      const before = count(d1, "ledger");
      const { value: served, lines } = await captureLog(async () => {
        const res = await door.call(d1, funder);
        return { status: res.status, body: (await res.json()) as Record<string, unknown> };
      });
      assert.equal(served.status, door.successStatus, `${door.route}: status ${JSON.stringify(served.body)}`);
      assert.equal(count(d1, "ledger"), before + 1, `${door.route}: one ledger line`);
      const head = d1.raw.prepare("SELECT hash, amount_cents FROM ledger ORDER BY id DESC LIMIT 1").get() as { hash: string; amount_cents: number };
      assert.equal(door.receiptOf(served.body), head.hash, `${door.route}: the receipt is the hash of the line just written`);
      assert.equal(head.amount_cents, door.amountCents, `${door.route}: the ledger books the amount the failure message states`);
      assert.deepEqual(unrecordedLines(lines), [], `${door.route}: nothing unrecorded`);
    } finally {
      stub.restore();
      d1.close();
    }
  }
});

// ---------- the helper itself ----------

test("F7 unit: the logged reason is the inner error's message clipped to 200 characters, a value that is not an Error is logged as a string, and the amount is dollars with two decimals", async () => {
  const ROW = { entry_date: "2026-09-28", description: "unit", amount_cents: 250, created_at: 1 };

  // A 300-character message: the log keeps the first 200, the caller reads none of it.
  {
    const d1 = createLocalD1();
    try {
      const long = "long-failure-" + "z".repeat(287);
      assert.equal(long.length, 300);
      failLedgerInserts(d1, long);
      let caught: unknown;
      const { lines } = await captureLog(async () => {
        try {
          await recordSettledPayment(testEnv(d1), "patron", { payer: "0xpayer", tx: "0xtx" }, 250, ROW);
        } catch (e) {
          caught = e;
        }
      });
      assert.ok(caught instanceof SocietyError, "a SocietyError");
      assert.equal((caught as SocietyError).status, 500);
      assert.equal((caught as SocietyError).message, hubUnrecorded("2.50", "0xtx"));
      assert.equal((caught as SocietyError).message.includes("long-failure"), false, "the inner text never reaches the caller");
      const records = unrecordedLines(lines);
      assert.equal(records.length, 1);
      assert.equal(String(records[0].reason).length, 200, "clipped to 200 characters");
      assert.equal(records[0].reason, long.slice(0, 200));
      assert.equal(records[0].route, "patron");
      assert.equal(records[0].amount_cents, 250);
    } finally {
      d1.close();
    }
  }

  // A thrown value that is not an Error (here a string, from the database binding itself).
  {
    const env = { DB: { prepare: () => { throw "binding is gone"; } } } as unknown as Env;
    let caught: unknown;
    const { lines } = await captureLog(async () => {
      try {
        await recordSettledPayment(env, "registration", { payer: "0xpayer", tx: "0xtx" }, 5, ROW);
      } catch (e) {
        caught = e;
      }
    });
    assert.ok(caught instanceof SocietyError, "a SocietyError, whatever was thrown");
    assert.equal((caught as SocietyError).status, 500);
    assert.equal((caught as SocietyError).message, hubUnrecorded("0.05", "0xtx"), "five cents is $0.05");
    const records = unrecordedLines(lines);
    assert.equal(records.length, 1);
    assert.equal(records[0].reason, "binding is gone");
    assert.equal(records[0].route, "registration");
  }
});
