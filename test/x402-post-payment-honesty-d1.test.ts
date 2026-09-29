// F8 and F9 (docs/CHECKPOINT-X402-SETTLE-HONESTY.md, "F8/F9 (build review round 3,
// CODEX)"): what a caller is told, and what they are still given, once their money
// has moved.
//
// F8a. Registration's paid-but-failed catch used to serve the inner error's text. When
// register()'s key_registered append exhausted appendChained AFTER the citizen row
// existed, a caller whose money moved read "retrying may succeed" (a second payment)
// while a citizen holding their key already existed. The served message now never
// contains inner text: one of two hub-worded messages, chosen by whether the request
// supplied a public key. The inner reason stays in the log.
//
// F8b. Invite mode only. The invite_redeemed append after register() sat outside any
// catch: if it threw, the caller got a raw 5xx after payment, ledger and citizen
// creation, and never received the credential register() had returned. It is now
// logged once and the 201 is served.
//
// F9. btoa(JSON.stringify(settlement)) for X-PAYMENT-RESPONSE throws on any character
// above U+00FF, a generic 500 after the money moved and was booked. The header is now
// built from UTF-8 bytes by encodePaymentResponseHeader.
//
// The facilitator is genuinely external, so its HTTP surface is stubbed via
// globalThis.fetch exactly as test/x402-post-settle-record-d1.test.ts stubs it.
// Nothing else is mocked: createLocalD1 is real SQLite with the real schema.sql, and
// each failed write is a real SQLite trigger raising, which is how a failed write
// looks to appendChained.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, type LocalD1 } from "./helpers/local-d1.ts";
import { paymentHeaderFor, TEST_PAYER } from "./helpers/x402-payload.ts";
import { encodeBase64Url } from "../src/keyauth.ts";
import { sha256Hex } from "../src/chain.ts";
import type { Env } from "../src/society.ts";
import worker from "../src/index.ts";

const TREASURY_ADDRESS = "0xa7f7985eb19b8c44f12a0654df1ef89d1dd527c9";
const FACILITATOR_URL = "https://facilitator.example.invalid";
const TX = "0x" + "ab".repeat(32);

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
function callWorker(request: Request, env: Env): Promise<Response> {
  return (worker.fetch as unknown as (r: Request, e: Env, c: unknown) => Promise<Response>)(request, env, ctx);
}

function testEnv(d1: LocalD1, extra: Record<string, unknown> = {}): Env {
  return { DB: d1.DB, TREASURY_ADDRESS, FACILITATOR_URL, REGISTRATION_MODE: "open", ...extra } as unknown as Env;
}

// A valid /verify and a settled /settle. `settleExtra` rides on the successful
// settlement body (the F9 tests put a non-Latin-1 character there).
function stubFacilitator(settleExtra: Record<string, unknown> = {}) {
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
      return new Response(JSON.stringify({ success: true, payer: TEST_PAYER, transaction: TX, ...settleExtra }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch in x402-post-payment-honesty-d1.test.ts: ${href}`);
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
const eventLines = (lines: string[], event: string) => logRecords(lines).filter((r) => r.event === event);

// Every INSERT matching `when` on `table` now fails with `message`, the way a failed
// write reaches appendChained: SQLite raises an Error whose message is exactly this text.
function failInserts(d1: LocalD1, name: string, table: string, when: string | null, message: string): void {
  assert.equal(message.includes("'"), false, "the message is embedded in a SQL string literal");
  d1.raw.exec(`CREATE TRIGGER ${name} BEFORE INSERT ON ${table} ${when ? `WHEN ${when}` : ""} BEGIN SELECT RAISE(ABORT, '${message}'); END;`);
}

// (a) an error whose text contains "UNIQUE": appendChained retries four times, then
// throws its own 503 ("... retrying may succeed."). (b) any other error: rethrown at
// once. `reasonOk` is what the logged reason must show, so the two flavours are proven
// to take different paths (registration's log line carries String(e) for a non-
// SocietyError, hence "includes" for (b)).
const VARIANTS: { tag: string; message: string; reasonOk: (reason: unknown) => boolean }[] = [
  {
    tag: "(a) UNIQUE conflict on every attempt, appendChained's 503",
    message: "UNIQUE constraint failed: identity_events.hash",
    reasonOk: (reason) => typeof reason === "string" && reason.startsWith("chain head for identity_events moved four times running"),
  },
  {
    tag: "(b) disk I/O error, rethrown at once",
    message: "disk I/O error",
    reasonOk: (reason) => typeof reason === "string" && reason.includes("disk I/O error"),
  },
];

// The hub's words (brief F8a), typed here rather than imported, so a change to the
// served wording fails these tests instead of silently passing them.
const hubWithKey = (tx: string, handle: string) =>
  `Your $1.00 payment settled (tx ${tx}) but registration did not complete. Do not sign again: this payment has already moved, and it is in the books (GET /treasury). A citizen may still have been created: GET /api/citizens lists each handle with the public key on record. The list is paged: while has_more is true, fetch GET /api/citizens?since=<next_since>&since_id=<next_since_id> and keep going. If "${handle}" is listed there with the public key you supplied, the seat is yours and your key already works. If it is not listed, or is listed with another key, no seat was created for you. This is logged for the maintainer to put right by hand: GET /api/official names how to reach it.`;
const hubNoKey = (tx: string) =>
  `Your $1.00 payment settled (tx ${tx}) but registration did not complete. Do not sign again: this payment has already moved, and it is in the books (GET /treasury). No credential was delivered to you, so no seat is usable by you. This is logged for the maintainer to put right by hand: GET /api/official names how to reach it.`;

// Words that were true of an inner error and are false for a caller whose money moved.
const FORBIDDEN_IN_SERVED = [/retrying may succeed/, /never committed/, /UNIQUE/, /disk I\/O/, /is taken/, /chain head/];

async function realPublicKey(): Promise<string> {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  return encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
}

function registerReq(body: Record<string, unknown>): Request {
  return new Request("https://example.test/api/register", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-PAYMENT": paymentHeaderFor(TREASURY_ADDRESS, "1000000") },
    body: JSON.stringify(body),
  });
}

async function answerOf(res: Response): Promise<{ status: number; error: string }> {
  return { status: res.status, error: String(((await res.json()) as { error?: unknown }).error) };
}

// ---------- F8a ----------

for (const variant of VARIANTS) {
  test(`F8a(i) public-key registration, key_registered append fails ${variant.tag}: 500 in the public-key hub words, no inner text, the citizen row exists, one registration_paid_but_failed line`, async () => {
    const d1 = createLocalD1();
    const stub = stubFacilitator();
    try {
      const publicKey = await realPublicKey();
      failInserts(d1, "f8a_fail_key_registered", "identity_events", "NEW.kind = 'key_registered'", variant.message);
      const handle = "f8a-keyed-seat";
      const { value: served, lines } = await captureLog(async () => answerOf(await callWorker(registerReq({ handle, model: "test-model", public_key: publicKey }), testEnv(d1))));

      assert.deepEqual(served, { status: 500, error: hubWithKey(TX, handle) }, "the public-key hub words, verbatim");
      for (const forbidden of FORBIDDEN_IN_SERVED) assert.doesNotMatch(served.error, forbidden, `no inner text: ${forbidden}`);
      assert.deepEqual(stub.calls, { verify: 1, settle: 1 }, "the payment was verified and settled once");

      // The state the message describes: the money is booked and a citizen with the key exists.
      assert.equal(count(d1, "ledger"), 1, "the payment is in the books");
      const citizen = d1.raw.prepare("SELECT handle, public_key FROM citizens WHERE handle = ?").get(handle) as { handle: string; public_key: string } | undefined;
      assert.ok(citizen, "the citizen row exists (documented state, not a failure)");
      assert.equal(citizen.public_key, publicKey, "with the key the caller supplied");
      assert.equal(count(d1, "identity_events WHERE kind = 'key_registered'"), 0, "the key_registered row is the write that failed");

      const failed = eventLines(lines, "registration_paid_but_failed");
      assert.equal(failed.length, 1, "exactly one registration_paid_but_failed line");
      assert.equal(failed[0].level, "error");
      assert.equal(failed[0].payer, TEST_PAYER);
      assert.equal(failed[0].tx, TX);
      assert.equal(failed[0].handle_attempted, handle);
      assert.ok(variant.reasonOk(failed[0].reason), `the inner reason is in the log: ${String(failed[0].reason)}`);
    } finally {
      stub.restore();
      d1.close();
    }
  });
}

test("F8a(ii) secret registration, the citizens INSERT fails: 500 in the no-key hub words, no inner text, no citizen row, one registration_paid_but_failed line", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator();
  try {
    failInserts(d1, "f8a_fail_citizens", "citizens", null, "disk I/O error");
    const { value: served, lines } = await captureLog(async () => answerOf(await callWorker(registerReq({ handle: "f8a-secret-seat", model: "test-model" }), testEnv(d1))));

    assert.deepEqual(served, { status: 500, error: hubNoKey(TX) }, "the no-key hub words, verbatim");
    for (const forbidden of FORBIDDEN_IN_SERVED) assert.doesNotMatch(served.error, forbidden, `no inner text: ${forbidden}`);
    assert.equal(count(d1, "citizens"), 0, "no citizen row");
    assert.equal(count(d1, "ledger"), 1, "the payment is in the books");

    const failed = eventLines(lines, "registration_paid_but_failed");
    assert.equal(failed.length, 1, "exactly one registration_paid_but_failed line");
    assert.ok(String(failed[0].reason).includes("disk I/O error"), "the inner reason is in the log");
  } finally {
    stub.restore();
    d1.close();
  }
});

// ---------- F8b ----------

const INVITE_CODE = "f8b-plaintext-invite-code-7c1d9e";
const inviteEnv = (d1: LocalD1) => testEnv(d1, { REGISTRATION_MODE: "invite_only", INVITE_CODES: `${INVITE_CODE},another-code` });
const inviteReq = () => registerReq({ handle: "f8b-invitee", model: "test-model", invite_code: INVITE_CODE });

test("F8b control: with a working identity chain an invite-mode registration is 201, marks the code spent (one invite_redeemed row holding the code's hash), and logs no invite_redeemed_unrecorded line", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator();
  try {
    const { value: res, lines } = await captureLog(() => callWorker(inviteReq(), inviteEnv(d1)));
    assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
    const rows = d1.raw.prepare("SELECT detail FROM identity_events WHERE kind = 'invite_redeemed'").all() as { detail: string }[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].detail, await sha256Hex("invite:" + INVITE_CODE), "the row holds the code's hash");
    assert.deepEqual(eventLines(lines, "invite_redeemed_unrecorded"), []);
  } finally {
    stub.restore();
    d1.close();
  }
});

for (const variant of VARIANTS) {
  test(`F8b invite-mode registration, the invite_redeemed append fails ${variant.tag}: 201 with the credential register() returned, the citizen exists, no invite_redeemed row, one invite_redeemed_unrecorded line, the code's plaintext nowhere in the log`, async () => {
    const d1 = createLocalD1();
    const stub = stubFacilitator();
    try {
      failInserts(d1, "f8b_fail_invite_redeemed", "identity_events", "NEW.kind = 'invite_redeemed'", variant.message);
      const { value: served, lines } = await captureLog(async () => {
        const res = await callWorker(inviteReq(), inviteEnv(d1));
        return { status: res.status, body: (await res.json()) as Record<string, unknown> };
      });

      assert.equal(served.status, 201, JSON.stringify(served.body));
      const secret = served.body.secret;
      assert.equal(typeof secret, "string", "the body carries the credential register() returned");
      const citizen = d1.raw.prepare("SELECT id, secret_hash FROM citizens WHERE handle = ?").get("f8b-invitee") as { id: number; secret_hash: string } | undefined;
      assert.ok(citizen, "the citizen row exists");
      assert.equal(citizen.secret_hash, await sha256Hex(secret as string), "and the credential served is the one that authenticates that row");
      assert.equal(served.body.citizen_id, citizen.id);
      assert.equal(count(d1, "identity_events WHERE kind = 'invite_redeemed'"), 0, "no invite_redeemed row: the write that failed");
      assert.equal(count(d1, "ledger"), 1, "the payment is in the books");
      assert.equal((served.body.payment as { tx: string }).tx, TX);

      const unrecorded = eventLines(lines, "invite_redeemed_unrecorded");
      assert.equal(unrecorded.length, 1, "exactly one invite_redeemed_unrecorded line");
      const record = unrecorded[0];
      assert.deepEqual(Object.keys(record).sort(), ["citizen_id", "event", "invite_hash", "level", "payer", "reason", "tx"]);
      assert.equal(record.level, "error");
      assert.equal(record.payer, TEST_PAYER);
      assert.equal(record.tx, TX);
      assert.equal(record.citizen_id, citizen.id);
      assert.equal(record.invite_hash, await sha256Hex("invite:" + INVITE_CODE), "the hash of the code, never the code");
      assert.ok(variant.reasonOk(record.reason), `the inner reason is in the log: ${String(record.reason)}`);
      assert.equal(lines.join("\n").includes(INVITE_CODE), false, "the invite code's plaintext appears nowhere in the captured log output");
      assert.deepEqual(eventLines(lines, "registration_paid_but_failed"), [], "this is not the paid-but-failed path");
    } finally {
      stub.restore();
      d1.close();
    }
  });
}
