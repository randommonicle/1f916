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
// F10. Building that header must also never throw or change the outcome: a body
// JSON.stringify cannot serialise (20,000 nested arrays) or a header over
// PAYMENT_RESPONSE_HEADER_MAX makes the helper return null, log one warn line, and
// every site omits the header and serves its normal status and body.
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
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLocalD1, insertCitizen, insertListing, insertSubmission, type LocalD1 } from "./helpers/local-d1.ts";
import { declareTestWallet } from "./helpers/wallet-pin.ts";
import { paymentHeaderFor, atomicFromCents, TEST_PAYER } from "./helpers/x402-payload.ts";
import { encodeBase64Url } from "../src/keyauth.ts";
import { sha256Hex } from "../src/chain.ts";
import { encodePaymentResponseHeader, PAYMENT_RESPONSE_HEADER_MAX } from "../src/x402.ts";
import { handleCreateListing, computeListingFeeCents, handlePayListing } from "../src/listings.ts";
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
// settlement body (the F9 tests put a non-Latin-1 character there); `settleRaw`, when
// given, IS the settle answer's text (the F10 tests need a body JSON.stringify cannot
// build, so it is written as text).
function stubFacilitator(settleExtra: Record<string, unknown> = {}, settleRaw: string | null = null) {
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
      return new Response(settleRaw ?? JSON.stringify({ success: true, payer: TEST_PAYER, transaction: TX, ...settleExtra }), {
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

// ---------- F9 and F10 ----------

// The header value decoded the way a client must: base64 to bytes, the bytes as UTF-8.
function decodeSettlementHeader(header: string | null): string {
  assert.ok(header, "X-PAYMENT-RESPONSE is present");
  assert.match(header, /^[A-Za-z0-9+/]*={0,2}$/, "the header is plain base64, so ASCII");
  const binary = atob(header);
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

const EURO = "€"; // above U+00FF, so btoa applied to the JSON text throws
const CTX = { route: "unit", tx: TX };
// The helper's result for an input that must be encodable.
function enc(x: unknown): string {
  const header = encodePaymentResponseHeader(x, CTX);
  assert.notEqual(header, null, `encodable: ${JSON.stringify(x)}`);
  return header as string;
}

// A JSON value nested `depth` arrays deep, built without recursion (JSON.parse accepts
// this; JSON.stringify of the parsed value recurses and throws RangeError).
const DEEP = 20_000;
const deepArrayText = "[".repeat(DEEP) + "]".repeat(DEEP);

test("F9 unit: the helper round-trips a body with non-Latin-1 characters through UTF-8, and equals btoa(JSON.stringify(x)) for pure ASCII", async () => {
  const withEuro = { note: EURO, success: true };
  // The control: this input is exactly what the old encoding could not carry.
  assert.throws(() => btoa(JSON.stringify(withEuro)), "btoa on the raw JSON text throws for a character above U+00FF");
  const { value: encoded, lines } = await captureLog(async () => enc(withEuro));
  assert.match(encoded, /^[A-Za-z0-9+/]*={0,2}$/);
  assert.equal(new TextDecoder().decode(Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0))), JSON.stringify(withEuro));
  assert.deepEqual(JSON.parse(decodeSettlementHeader(encoded)), withEuro);
  assert.deepEqual(eventLines(lines, "payment_response_header_omitted"), [], "an encodable body logs nothing");

  // A supplementary-plane character (a surrogate pair in UTF-16, four UTF-8 bytes) survives too.
  const astral = { payer_name: "café 😀", success: true };
  assert.deepEqual(JSON.parse(decodeSettlementHeader(enc(astral))), astral);

  for (const ascii of [{ success: true, payer: TEST_PAYER, transaction: TX }, { note: "plain" }, [], "text", null, {}]) {
    assert.equal(enc(ascii), btoa(JSON.stringify(ascii)), `ASCII input is byte-identical to the old encoding: ${JSON.stringify(ascii)}`);
  }
});

test("F10 unit: a body JSON.stringify cannot serialise returns null with one warn line (unencodable, the inner message clipped), and a header over PAYMENT_RESPONSE_HEADER_MAX returns null with one warn line (too large, the encoded length), the cap itself being served", async () => {
  // The control: this input is what the pre-F10 helper threw on.
  const deep = JSON.parse(deepArrayText) as unknown;
  assert.throws(() => JSON.stringify(deep), RangeError, "JSON.stringify recurses and throws at this depth");

  const { value: unencodable, lines: deepLines } = await captureLog(async () => encodePaymentResponseHeader({ success: true, deep }, CTX));
  assert.equal(unencodable, null);
  const deepRecords = eventLines(deepLines, "payment_response_header_omitted");
  assert.equal(deepRecords.length, 1, "exactly one line");
  assert.deepEqual(Object.keys(deepRecords[0]).sort(), ["event", "level", "reason", "route", "tx"]);
  assert.equal(deepRecords[0].level, "warn", "warn, not error: the payment succeeded");
  assert.equal(deepRecords[0].route, "unit");
  assert.equal(deepRecords[0].tx, TX);
  assert.match(String(deepRecords[0].reason), /^unencodable: RangeError|^unencodable: Maximum call stack/, `reason: ${String(deepRecords[0].reason)}`);
  assert.ok(String(deepRecords[0].reason).length <= "unencodable: ".length + 200, "the inner message is clipped to 200");

  // The cap: {"a":"x...x"} is 8 bytes plus the string; base64 of 6144 bytes is exactly 8192 characters.
  assert.equal(PAYMENT_RESPONSE_HEADER_MAX, 8192);
  const atCap = enc({ a: "x".repeat(6136) });
  assert.equal(atCap.length, PAYMENT_RESPONSE_HEADER_MAX, "a header exactly at the cap is served");
  const { value: over, lines: overLines } = await captureLog(async () => encodePaymentResponseHeader({ a: "x".repeat(6137) }, CTX));
  assert.equal(over, null, "one byte more is 8196 characters, over the cap");
  const overRecords = eventLines(overLines, "payment_response_header_omitted");
  assert.equal(overRecords.length, 1);
  assert.equal(overRecords[0].reason, "too large: 8196 characters");
  assert.equal(overRecords[0].level, "warn");
});

const SETTLEMENT_WITH_EURO = { note: EURO };
function assertSettlementHeader(res: Response, label: string): void {
  const decoded = JSON.parse(decodeSettlementHeader(res.headers.get("X-PAYMENT-RESPONSE"))) as Record<string, unknown>;
  assert.deepEqual(decoded, { success: true, payer: TEST_PAYER, transaction: TX, note: EURO }, `${label}: the header decodes as UTF-8 to the facilitator's settlement body`);
  assert.ok(JSON.stringify(decoded).includes(EURO), `${label}: the character survives`);
}

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

// The three sites that serve X-PAYMENT-RESPONSE. `route` is the name each passes to the
// helper (and so the value of the omitted line's route field); `booked` counts the row
// the payment wrote, which must exist whatever happens to the header.
interface Site {
  name: string;
  route: string;
  status: number;
  call: (d1: LocalD1) => Promise<Response>;
  booked: (d1: LocalD1) => number;
}
const SITES: Site[] = [
  {
    name: "patron",
    route: "patron",
    status: 200,
    call: (d1) =>
      callWorker(
        new Request("https://example.test/api/patron", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-PAYMENT": paymentHeaderFor(TREASURY_ADDRESS, "1000000") },
          body: JSON.stringify({ message: "hello" }),
        }),
        testEnv(d1),
      ),
    booked: (d1) => count(d1, "ledger"),
  },
  {
    name: "listing create",
    route: "listing_fee",
    status: 201,
    call: async (d1) => {
      const bounty = 1000;
      const funder = await loadCitizen(d1, insertCitizen(d1));
      return handleCreateListing(
        new Request("https://example.test/api/listing", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-PAYMENT": paymentHeaderFor(TREASURY_ADDRESS, atomicFromCents(computeListingFeeCents(bounty))) },
          body: JSON.stringify({
            title: "Review my auth middleware",
            description: "Stuck on token refresh, please review for race conditions",
            acceptance_condition: "a reviewer identifies at least one real correctness issue or confirms none exist",
            bounty_cents: bounty,
            expires_at: Date.now() + 7 * 86_400_000,
          }),
        }),
        testEnv(d1),
        funder,
      );
    },
    booked: (d1) => count(d1, "ledger"),
  },
  {
    name: "pay listing",
    route: "listing_pay",
    status: 200,
    call: async (d1) => {
      const bounty = 1200;
      const reviewerWallet = "0x" + "0a".repeat(20);
      const funderId = insertCitizen(d1);
      const funder = await loadCitizen(d1, funderId);
      const reviewerId = insertCitizen(d1);
      const row = await declareTestWallet(d1, reviewerId, reviewerWallet);
      const listingId = insertListing(d1, { funder_citizen_id: funderId, bounty_cents: bounty });
      const submissionId = insertSubmission(d1, { listing_id: listingId, citizen_id: reviewerId });
      return handlePayListing(
        new Request(`https://example.test/api/listing/${listingId}/pay`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-PAYMENT": paymentHeaderFor(reviewerWallet, atomicFromCents(bounty)) },
          body: JSON.stringify({ submission_id: submissionId, wallet_row_id: row.id, wallet_row_hash: row.hash }),
        }),
        testEnv(d1),
        funder,
        listingId,
      );
    },
    booked: (d1) => count(d1, "listing_payments"),
  },
];

for (const site of SITES) {
  test(`F9 route, ${site.name}: a successful settlement body holding a non-Latin-1 character is ${site.status} with X-PAYMENT-RESPONSE decoding as UTF-8`, async () => {
    const d1 = createLocalD1();
    const stub = stubFacilitator(SETTLEMENT_WITH_EURO);
    try {
      const res = await site.call(d1);
      assert.equal(res.status, site.status, JSON.stringify(await res.clone().json()));
      assertSettlementHeader(res, site.name);
      assert.equal(site.booked(d1), 1, "and the payment is booked once");
    } finally {
      stub.restore();
      d1.close();
    }
  });
}

// F10: a settlement body the header cannot carry is a header omitted, never a changed outcome.
for (const site of SITES) {
  test(`F10 route, ${site.name}: a successful settlement body nested ${DEEP} arrays deep is ${site.status} with NO X-PAYMENT-RESPONSE, one payment_response_header_omitted line naming the route and tx, and the payment booked`, async () => {
    const d1 = createLocalD1();
    const stub = stubFacilitator({}, `{"success":true,"payer":"${TEST_PAYER}","transaction":"${TX}","deep":${deepArrayText}}`);
    try {
      const { value: res, lines } = await captureLog(() => site.call(d1));
      assert.equal(res.status, site.status, (await res.clone().text()).slice(0, 300));
      assert.equal(res.headers.get("X-PAYMENT-RESPONSE"), null, "the header is omitted");
      assert.equal(res.headers.get("Access-Control-Allow-Origin"), "*", "the other header is unchanged");
      const records = eventLines(lines, "payment_response_header_omitted");
      assert.equal(records.length, 1, "exactly one payment_response_header_omitted line");
      assert.equal(records[0].level, "warn");
      assert.equal(records[0].route, site.route);
      assert.equal(records[0].tx, TX);
      assert.match(String(records[0].reason), /^unencodable: /);
      assert.equal(site.booked(d1), 1, "the payment is booked");
      assert.deepEqual(stub.calls, { verify: 1, settle: 1 }, "settled once");
    } finally {
      stub.restore();
      d1.close();
    }
  });
}

test("F10 route, patron: a settlement body with a 10,000-character string field makes a header over the cap, so it is omitted with a 'too large' reason and the outcome is unchanged", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator({ big: "x".repeat(10_000) });
  try {
    const site = SITES[0];
    const { value: res, lines } = await captureLog(() => site.call(d1));
    assert.equal(res.status, 200, (await res.clone().text()).slice(0, 300));
    assert.equal(res.headers.get("X-PAYMENT-RESPONSE"), null, "the header is omitted");
    const records = eventLines(lines, "payment_response_header_omitted");
    assert.equal(records.length, 1, "exactly one line");
    assert.equal(records[0].route, "patron");
    assert.equal(records[0].tx, TX);
    assert.match(String(records[0].reason), /^too large: \d+ characters$/, String(records[0].reason));
    assert.ok(Number(String(records[0].reason).match(/\d+/)?.[0]) > PAYMENT_RESPONSE_HEADER_MAX);
    assert.equal(site.booked(d1), 1, "the payment is booked");
  } finally {
    stub.restore();
    d1.close();
  }
});

// The scan: any spelling of btoa applied straight to JSON.stringify's output is the
// bug, wherever it sits in src/ (a fourth site would be a fourth 500 after payment).
const RAW_BTOA_OF_JSON = /btoa\s*\(\s*JSON\s*\.\s*stringify\s*\(/;

test("F9 scan: no btoa(JSON.stringify( remains anywhere in src/ (comments included), and the pattern matches every spelling it is meant to catch", () => {
  for (const spelling of ["btoa(JSON.stringify(x))", "btoa( JSON.stringify( x ) )", 'h["X"] = btoa(\n  JSON . stringify(x))']) {
    assert.match(spelling, RAW_BTOA_OF_JSON, `the pattern catches: ${spelling}`);
  }
  assert.doesNotMatch("encodePaymentResponseHeader(x); btoa(binary)", RAW_BTOA_OF_JSON);

  const srcDir = fileURLToPath(new URL("../src/", import.meta.url));
  const files = (readdirSync(srcDir, { recursive: true }) as string[]).filter((f) => f.endsWith(".ts"));
  assert.ok(files.length > 10 && files.includes("x402.ts") && files.includes("listings.ts"), `the scan reads the source tree (${files.length} files)`);
  const offenders = files.filter((f) => RAW_BTOA_OF_JSON.test(readFileSync(join(srcDir, f), "utf8")));
  assert.deepEqual(offenders, [], "no src file applies btoa directly to JSON.stringify's output");
});
