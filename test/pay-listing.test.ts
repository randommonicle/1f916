// Tests for scripts/pay-listing.mjs's money-critical logic: the pinned target,
// the purchase-identity key, the 402 gate (payTo MUST equal the operator-pinned
// payee -- the load-bearing negative -- plus amount, resource, asset, domain),
// the 200 receipt gate, tombstone classification, and the orchestration's call
// ORDER with fakes (dry run never signs; the tombstone precedes the sign; a
// contradictory receipt leaves 'signing'; a non-402 first leg signs nothing).
//
// The live HTTP round trip in main() is not covered here, same convention as
// post-listing.test.ts: only a real payment proves the facilitator's verdict,
// and that is the operator's step, not this suite's.
import test from "node:test";
import assert from "node:assert/strict";
import {
  payTarget,
  isAddress,
  purchaseIdentity,
  attemptKey,
  validatePayRequirements,
  validatePayReceipt,
  checkSettlementHeader,
  decodeSentAuthorization,
  refusedRetryDecision,
  RETRY_MARGIN_SECONDS,
  decideAuthorizationUsed,
  AUTHORIZATION_QUORUM,
  classifyTombstone,
  parseArgs,
  readFunderSecret,
  payListing,
  DEFAULT_URL,
  IDENTITY_HASH_RE,
  recomputeIdentityRowHash,
  checkWalletRow,
  checkWitness,
} from "../scripts/pay-listing.mjs";
import { createHash } from "node:crypto";

const PAYEE = "0xb7c76e6a9422ae6a6d610be0e7b8fc1b18b7369e";
const TARGET = `${DEFAULT_URL}/api/listing/3/pay`;
const PURCHASE = { listingId: 3, submissionId: 1, payee: PAYEE, amountCents: 1200 };

// The wallet-row pin fixture: the live shape of GET /api/events?kind=wallet_declared row 24
// (midas-jt3, citizen 8, 2026-09-14), with the hash recomputed from its own preimage so the
// pin's recomputation and the fixture agree by construction, not by copying a served value.
const SUBMITTER_ID = 8;
const WALLET_ROW_ID = 24;
const WALLET_ROW_BASE = { id: WALLET_ROW_ID, citizen_id: SUBMITTER_ID, kind: "wallet_declared", detail: `wallet declared: ${PAYEE}`, created_at: 1789348708252, prev_hash: "9a8ef67f791d236a49a847c57147ca3a3b8693eb6a4c024779d665bb185deb71", citizen: "midas-jt3" };
const WALLET_ROW_HASH = createHash("sha256").update(WALLET_ROW_BASE.prev_hash + "\n" + JSON.stringify([WALLET_ROW_BASE.citizen_id, WALLET_ROW_BASE.kind, WALLET_ROW_BASE.detail, WALLET_ROW_BASE.created_at])).digest("hex");
const WALLET_ROW = { ...WALLET_ROW_BASE, hash: WALLET_ROW_HASH };
const PIN = { walletRow: WALLET_ROW_ID, walletRowHash: WALLET_ROW_HASH };
function goodListingDoc() {
  return { listing: { id: 3, status: "open" }, submissions: [{ id: 1, citizen_id: SUBMITTER_ID, submitter_handle: "midas-jt3", status: "open", mod_state: null }] };
}
function goodEventsDoc(rows: unknown[] = [WALLET_ROW]) {
  return { kinds: ["key_rotation", "model_correction", "moderation"], count: rows.length, events: rows };
}
function goodAttestDoc(overrides: Record<string, unknown> = {}) {
  return { ok: true, identity_log: { ok: true, status: "verified", head: "0x" + "cd".repeat(32), expected: WALLET_ROW_HASH, anchor_at_from: WALLET_ROW_HASH, expect_matches: true, ...overrides } };
}

function goodReqs(overrides: Record<string, unknown> = {}) {
  return {
    scheme: "exact",
    network: "base",
    maxAmountRequired: "12000000",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    payTo: PAYEE,
    resource: TARGET,
    description: "Pay the bounty",
    mimeType: "application/json",
    maxTimeoutSeconds: 300,
    extra: { name: "USD Coin", version: "2" },
    ...overrides,
  };
}
const gate = { payee: PAYEE, amountCents: 1200, maxAmountCents: 2000, resource: TARGET };

test("payTarget pins the real Commonhold origin and the listing id", () => {
  assert.equal(payTarget(3), "https://commonhold.randommonicle.workers.dev/api/listing/3/pay");
  assert.equal(payTarget(42), "https://commonhold.randommonicle.workers.dev/api/listing/42/pay");
});

test("isAddress accepts a 20-byte hex address and nothing else", () => {
  assert.equal(isAddress(PAYEE), true);
  assert.equal(isAddress(PAYEE.toUpperCase().replace("0X", "0x")), true);
  assert.equal(isAddress(PAYEE.slice(0, 41)), false);
  assert.equal(isAddress("b7c76e6a9422ae6a6d610be0e7b8fc1b18b7369e"), false);
  assert.equal(isAddress(undefined), false);
});

test("purchase identity lowercases the payee so checksum casing cannot mint a second key", () => {
  const a = attemptKey("POST", TARGET, "commonhold-agent", purchaseIdentity(PURCHASE));
  const b = attemptKey("POST", TARGET, "commonhold-agent", purchaseIdentity({ ...PURCHASE, payee: "0xB7C76E6A9422AE6A6D610BE0E7B8FC1B18B7369E" }));
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test("changing any of listing, submission, payee or amount changes the key", () => {
  const base = attemptKey("POST", TARGET, "commonhold-agent", purchaseIdentity(PURCHASE));
  for (const variant of [
    { ...PURCHASE, listingId: 4 },
    { ...PURCHASE, submissionId: 2 },
    { ...PURCHASE, payee: "0x3f2950654ef9bf2d73805a77a07e4e14d5f74f16" },
    { ...PURCHASE, amountCents: 1201 },
  ]) {
    assert.notEqual(attemptKey("POST", TARGET, "commonhold-agent", purchaseIdentity(variant)), base);
  }
});

test("validatePayRequirements accepts the exact expected 402", () => {
  assert.deepEqual(validatePayRequirements(goodReqs(), gate), goodReqs());
  // payTo casing is not a mismatch (addresses are case-insensitive hex)
  validatePayRequirements(goodReqs({ payTo: PAYEE.toUpperCase().replace("0X", "0x") }), gate);
});

test("validatePayRequirements REFUSES a payTo that is not the pinned payee (the wallet-swap defence)", () => {
  assert.throws(
    () => validatePayRequirements(goodReqs({ payTo: "0x3f2950654ef9bf2d73805a77a07e4e14d5f74f16" }), gate),
    /payTo: expected the pinned payee/,
  );
  assert.throws(() => validatePayRequirements(goodReqs({ payTo: "0xD9E17995352EF13F9Ba467e2F36C7614A45e7011" }), gate), /payTo/); // the treasury is NOT a valid payee here
  assert.throws(() => validatePayRequirements(goodReqs({ payTo: undefined }), gate), /payTo/);
});

test("validatePayRequirements refuses any amount other than the pinned bounty, and one over the cap", () => {
  assert.throws(() => validatePayRequirements(goodReqs({ maxAmountRequired: "12000001" }), gate), /maxAmountRequired: expected exactly "12000000"/);
  assert.throws(() => validatePayRequirements(goodReqs({ maxAmountRequired: "1200" }), gate), /maxAmountRequired/);
  // the gate follows the PINNED amount, not a hardcoded $12: a $5 pin accepts a $5 402
  assert.doesNotThrow(() => validatePayRequirements(goodReqs({ maxAmountRequired: "5000000" }), { ...gate, amountCents: 500 }));
});

test("validatePayRequirements refuses a resource that is not the exact target, wrong asset, wrong network, wrong domain", () => {
  assert.throws(() => validatePayRequirements(goodReqs({ resource: `${DEFAULT_URL}/api/listing/4/pay` }), gate), /resource: expected exactly/);
  assert.throws(() => validatePayRequirements(goodReqs({ resource: "https://commonhold.randommonicle.workers.dev.evil.example/api/listing/3/pay" }), gate), /resource/);
  assert.throws(() => validatePayRequirements(goodReqs({ asset: "0x0000000000000000000000000000000000000001" }), gate), /asset: expected USDC on Base/);
  assert.throws(() => validatePayRequirements(goodReqs({ network: "base-sepolia" }), gate), /network/);
  assert.throws(() => validatePayRequirements(goodReqs({ extra: { name: "USD Coin", version: "1" } }), gate), /extra: expected EIP-712 domain/);
  assert.throws(() => validatePayRequirements(goodReqs({ maxTimeoutSeconds: 86400 }), gate), /maxTimeoutSeconds/);
  // GEMINI r1 p4: the worker emits 300; a wider window is refused
  assert.throws(() => validatePayRequirements(goodReqs({ maxTimeoutSeconds: 3600 }), gate), /maxTimeoutSeconds: expected a positive integer <= 300/);
  assert.doesNotThrow(() => validatePayRequirements(goodReqs({ maxTimeoutSeconds: 300 }), gate));
});

test("validatePayRequirements collects every mismatch in one refusal", () => {
  try {
    validatePayRequirements(goodReqs({ payTo: "0x3f2950654ef9bf2d73805a77a07e4e14d5f74f16", maxAmountRequired: "1" }), gate);
    assert.fail("should have thrown");
  } catch (e: any) {
    assert.match(e.message, /payTo/);
    assert.match(e.message, /maxAmountRequired/);
  }
});

test("validatePayRequirements refuses an amount over --max-amount-cents even when the 402 agrees with it", () => {
  assert.throws(() => validatePayRequirements(goodReqs({ maxAmountRequired: "30000000" }), { ...gate, amountCents: 3000, maxAmountCents: 2000 }), /exceeds the --max-amount-cents cap/);
});

function goodReceipt(overrides: Record<string, unknown> = {}) {
  return {
    listing_id: 3,
    submission_id: 1,
    payee_citizen_id: 8,
    payee_address: PAYEE,
    payer_address: "0x3f2950654ef9bf2d73805a77a07e4e14d5f74f16",
    amount_cents: 1200,
    tx: "0x" + "ab".repeat(32),
    listing_marked_paid: true,
    ...overrides,
  };
}

test("validatePayReceipt accepts the receipt that describes our purchase", () => {
  assert.deepEqual(validatePayReceipt(goodReceipt(), { ...PURCHASE, payer: PAYER }), []);
  // GEMINI r1 p3: a receipt naming another payer is a contradiction
  assert.match(validatePayReceipt(goodReceipt({ payer_address: PAYEE }), { ...PURCHASE, payer: PAYER }).join(), /payer_address: expected the signing account/);
  assert.match(validatePayReceipt(goodReceipt(), PURCHASE as any).join(), /payer_address/, "no payer supplied means no receipt can pass");
});

test("validatePayReceipt names every contradiction", () => {
  const PURCHASE = { listingId: 3, submissionId: 1, payee: PAYEE, amountCents: 1200, payer: PAYER };
  assert.match(validatePayReceipt(goodReceipt({ payee_address: "0x3f2950654ef9bf2d73805a77a07e4e14d5f74f16" }), PURCHASE).join("\n"), /payee_address/);
  assert.match(validatePayReceipt(goodReceipt({ amount_cents: 1199 }), PURCHASE).join("\n"), /amount_cents/);
  assert.match(validatePayReceipt(goodReceipt({ submission_id: 2 }), PURCHASE).join("\n"), /submission_id/);
  assert.match(validatePayReceipt(goodReceipt({ listing_id: 4 }), PURCHASE).join("\n"), /listing_id/);
  assert.match(validatePayReceipt(goodReceipt({ tx: "" }), PURCHASE).join("\n"), /tx/);
  assert.match(validatePayReceipt(goodReceipt({ tx: "0x1234" }), PURCHASE).join("\n"), /tx/);
  assert.match(validatePayReceipt(goodReceipt({ listing_marked_paid: false }), PURCHASE).join("\n"), /listing_marked_paid/);
  assert.deepEqual(validatePayReceipt(null, PURCHASE), ["receipt is not a JSON object"]);
});

test("classifyTombstone: settled, signing, corrupt, unknown", () => {
  assert.deepEqual(classifyTombstone(JSON.stringify({ status: "settled", tx: "0xab", listing_id: 3, submission_id: 1 })), { status: "settled", tx: "0xab", listing_id: 3, submission_id: 1 });
  assert.equal(classifyTombstone(JSON.stringify({ status: "signing", key: "k" })).status, "signing");
  assert.equal(classifyTombstone("{not json").status, "corrupt");
  assert.equal(classifyTombstone(JSON.stringify({ status: "weird" })).status, "unknown");
});

test("parseArgs requires all six pin flags (four purchase + the wallet row and its hash), refuses --url, and validates the payee and the hash", () => {
  const pinArgv = ["--wallet-row", String(WALLET_ROW_ID), "--wallet-row-hash", WALLET_ROW_HASH];
  const ok = parseArgs(["--listing", "3", "--submission", "1", "--payee", PAYEE, "--amount-cents", "1200", ...pinArgv]);
  assert.deepEqual(ok, { listingId: 3, submissionId: 1, payee: PAYEE, amountCents: 1200, maxAmountCents: 2000, walletRow: WALLET_ROW_ID, walletRowHash: WALLET_ROW_HASH, execute: false });
  assert.equal(parseArgs(["--listing", "3", "--submission", "1", "--payee", PAYEE, "--amount-cents", "1200", ...pinArgv, "--execute", "--max-amount-cents", "1500"]).execute, true);
  assert.throws(() => parseArgs(["--submission", "1", "--payee", PAYEE, "--amount-cents", "1200", ...pinArgv]), /--listing is required/);
  assert.throws(() => parseArgs(["--listing", "3", "--payee", PAYEE, "--amount-cents", "1200", ...pinArgv]), /--submission is required/);
  assert.throws(() => parseArgs(["--listing", "3", "--submission", "1", "--amount-cents", "1200", ...pinArgv]), /--payee is required/);
  assert.throws(() => parseArgs(["--listing", "3", "--submission", "1", "--payee", PAYEE, ...pinArgv]), /--amount-cents is required/);
  assert.throws(() => parseArgs(["--listing", "3", "--submission", "1", "--payee", PAYEE, "--amount-cents", "1200"]), /--wallet-row is required/);
  assert.throws(() => parseArgs(["--listing", "3", "--submission", "1", "--payee", PAYEE, "--amount-cents", "1200", "--wallet-row", "24"]), /--wallet-row-hash is required/);
  assert.throws(() => parseArgs(["--listing", "3", "--submission", "1", "--payee", PAYEE, "--amount-cents", "1200", "--wallet-row", "24", "--wallet-row-hash", WALLET_ROW_HASH.toUpperCase()]), /--wallet-row-hash must be the row's 64-hex/);
  assert.throws(() => parseArgs(["--listing", "3", "--submission", "1", "--payee", PAYEE, "--amount-cents", "1200", "--wallet-row", "24", "--wallet-row-hash", "0x" + WALLET_ROW_HASH]), /--wallet-row-hash must be the row's 64-hex/);
  assert.throws(() => parseArgs(["--listing", "3", "--submission", "1", "--payee", PAYEE, "--amount-cents", "1200", "--wallet-row", "0", "--wallet-row-hash", WALLET_ROW_HASH]), /--wallet-row must be a positive integer/);
  assert.throws(() => parseArgs(["--listing", "3", "--submission", "1", "--payee", "not-an-address", "--amount-cents", "1200", ...pinArgv]), /--payee must be a 0x-prefixed/);
  assert.throws(() => parseArgs(["--listing", "0", "--submission", "1", "--payee", PAYEE, "--amount-cents", "1200", ...pinArgv]), /--listing must be a positive integer/);
  assert.throws(() => parseArgs(["--listing", "3", "--submission", "1", "--payee", PAYEE, "--amount-cents", "12.5", ...pinArgv]), /--amount-cents must be a positive integer/);
  assert.throws(() => parseArgs(["--listing", "3", "--submission", "1", "--payee", PAYEE, "--amount-cents", "1200", ...pinArgv, "--url", "https://evil.example"]), /unrecognised argument: --url/);
});

test("readFunderSecret accepts only commonhold-agent's custody file with a well-formed secret", () => {
  const secret = "commonhold_sk_" + "0".repeat(64);
  assert.equal(readFunderSecret(JSON.stringify({ handle: "commonhold-agent", secret })), secret);
  assert.throws(() => readFunderSecret(JSON.stringify({ handle: "ledger-watch", secret })), /is for "ledger-watch", not commonhold-agent/);
  assert.throws(() => readFunderSecret(JSON.stringify({ handle: "commonhold-agent", secret: "commonhold_sk_short" })), /expected length/);
  assert.throws(() => readFunderSecret(JSON.stringify({ handle: "commonhold-agent" })), /expected length/);
});

// ---------- orchestration with fakes ----------

type Call = { kind: string; [k: string]: unknown };

function settlementHeader(tx: string) {
  return Buffer.from(JSON.stringify({ success: true, transaction: tx, network: "base", payer: "0x3f2950654ef9bf2d73805a77a07e4e14d5f74f16" })).toString("base64");
}

const PAYER = "0x3f2950654ef9bf2d73805a77a07e4e14d5f74f16";
const NONCE = "0x" + "11".repeat(32);
const VALID_BEFORE = 1_800_000_300;
function sentHeader(from = PAYER, nonce = NONCE, validBefore = VALID_BEFORE) {
  return Buffer.from(JSON.stringify({ x402Version: 1, scheme: "exact", network: "base", payload: { signature: "0xsig", authorization: { from, to: PAYEE, value: "12000000", validAfter: "1", validBefore: String(validBefore), nonce } } })).toString("base64");
}

function fakeDeps(opts: { first?: { status: number; body: unknown }; second?: { status: number; body: unknown; header?: string | null }; existing?: string | null; signThrows?: boolean; writeExclusiveThrows?: any; balance?: bigint | Error; nonceUsed?: boolean | Error; now?: number; listing?: unknown | Error; events?: unknown | Error; attest?: unknown | Error } = {}) {
  const calls: Call[] = [];
  let store: string | null = opts.existing ?? null;
  const deps = {
    // the three public reads the wallet-row pin makes; recorded as fetch:* so every
    // "no network call" assertion below counts them
    readJson: async (url: string) => {
      const which = url.includes("/api/listing/") ? "listing" : url.includes("/api/events") ? "events" : url.includes("/api/attest") ? "attest" : "other";
      calls.push({ kind: `fetch:json:${which}`, url });
      const v = which === "listing" ? (opts.listing ?? goodListingDoc()) : which === "events" ? (opts.events ?? goodEventsDoc()) : which === "attest" ? (opts.attest ?? goodAttestDoc()) : undefined;
      if (v instanceof Error) throw v;
      return v;
    },
    fetch: async (url: string, init: any) => {
      const leg = init.headers["X-PAYMENT"] ? "leg2" : "leg1";
      calls.push({ kind: `fetch:${leg}`, url, redirect: init.redirect, hasBearer: String(init.headers.Authorization).startsWith("Bearer "), body: init.body });
      const r: any = leg === "leg1" ? (opts.first ?? { status: 402, body: { x402Version: 1, accepts: [goodReqs()] } }) : (opts.second ?? { status: 200, body: goodReceipt() });
      // leg 2 carries X-PAYMENT-RESPONSE naming the body's tx unless the test says otherwise
      const hdr = leg === "leg2" ? ("header" in r ? r.header : settlementHeader((r.body as any)?.tx ?? "")) : null;
      return { status: r.status, headers: { get: (k: string) => (k === "X-PAYMENT-RESPONSE" ? hdr : null) }, text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)) };
    },
    exists: (p: string) => { calls.push({ kind: "exists", p }); return store !== null; },
    readFile: (p: string) => { calls.push({ kind: "readFile", p }); return store ?? ""; },
    writeExclusive: (p: string, data: string) => {
      calls.push({ kind: "writeExclusive", p, data });
      if (opts.writeExclusiveThrows) throw opts.writeExclusiveThrows;
      if (store !== null) { const e: any = new Error("EEXIST"); e.code = "EEXIST"; throw e; }
      store = data;
    },
    writeAtomic: (p: string, data: string) => { calls.push({ kind: "writeAtomic", p, data }); store = data; },
    mkdir: (d: string) => { calls.push({ kind: "mkdir", d }); },
    sign: async (reqs: unknown) => { calls.push({ kind: "sign", reqs }); if (opts.signThrows) throw new Error("no key"); return sentHeader(); },
    usdcBalanceAtomic: async (addr: string) => { calls.push({ kind: "usdcBalanceAtomic", addr }); const b = opts.balance ?? 12_000_000n; if (b instanceof Error) throw b; return b; },
    authorizationUsed: async (from: string, nonce: string) => { calls.push({ kind: "authorizationUsed", from, nonce }); const u = opts.nonceUsed ?? false; if (u instanceof Error) throw u; return u; },
    nowSeconds: () => opts.now ?? 1_800_000_000,
  };
  return { deps, calls, store: () => store };
}

const RUN = { ...PURCHASE, ...PIN, maxAmountCents: 2000, target: TARGET, funderSecret: "commonhold_sk_" + "1".repeat(64), payer: PAYER };
const PIN_READS = ["fetch:json:listing", "fetch:json:events", "fetch:json:attest"];

test("dry run: one authenticated 402 probe with redirect:error, requirements validated, NEVER signs, writes nothing", async () => {
  const { deps, calls } = fakeDeps();
  const r = await payListing({ ...RUN, execute: false }, deps);
  assert.equal(r.ok, true);
  assert.equal(r.reason, "dry_run");
  assert.deepEqual(calls.map((c) => c.kind), [...PIN_READS, "fetch:leg1"]);
  const leg1 = calls[PIN_READS.length];
  assert.equal(leg1.redirect, "error");
  assert.equal(leg1.hasBearer, true);
  assert.equal(leg1.body, JSON.stringify({ submission_id: 1 }));
});

test("execute: mkdir + exclusive tombstone BEFORE sign, then leg 2, then the settled receipt", async () => {
  const { deps, calls, store } = fakeDeps();
  const r = await payListing({ ...RUN, execute: true }, deps);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.reason, "settled");
  assert.equal(r.tx, "0x" + "ab".repeat(32));
  const order = calls.map((c) => c.kind);
  assert.deepEqual(order, ["exists", ...PIN_READS, "fetch:leg1", "usdcBalanceAtomic", "mkdir", "writeExclusive", "sign", "fetch:leg2", "writeAtomic"]);
  const settled = JSON.parse(store()!);
  assert.equal(settled.status, "settled");
  assert.equal(settled.payee, PAYEE);
  assert.equal(settled.amount_cents, 1200);
  assert.equal(settled.submission_id, 1);
});

test("execute: a 402 whose payTo is another wallet is refused with nothing signed and no tombstone", async () => {
  const { deps, calls } = fakeDeps({ first: { status: 402, body: { x402Version: 1, accepts: [goodReqs({ payTo: "0x3f2950654ef9bf2d73805a77a07e4e14d5f74f16" })] } } });
  const r = await payListing({ ...RUN, execute: true }, deps);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "reqs_rejected");
  assert.match(String(r.message), /payTo: expected the pinned payee/);
  assert.ok(!calls.some((c) => c.kind === "sign" || c.kind === "writeExclusive"));
});

test("execute: a non-402 first leg (e.g. 409 'no declared wallet') ends the run with nothing signed", async () => {
  const { deps, calls } = fakeDeps({ first: { status: 409, body: { error: "Citizen 8 (the submitter) has no declared wallet." } } });
  const r = await payListing({ ...RUN, execute: true }, deps);
  assert.equal(r.reason, "leg1_not_402");
  assert.match(String(r.detail), /no declared wallet/);
  assert.deepEqual(calls.map((c) => c.kind), ["exists", ...PIN_READS, "fetch:leg1"]);
});

test("execute: a contradictory 200 (payee_address differs) leaves the tombstone 'signing'", async () => {
  const { deps, store } = fakeDeps({ second: { status: 200, body: goodReceipt({ payee_address: "0x3f2950654ef9bf2d73805a77a07e4e14d5f74f16" }) } });
  const r = await payListing({ ...RUN, execute: true }, deps);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "leg2_bad_body");
  assert.match(String(r.message), /payee_address/);
  assert.equal(JSON.parse(store()!).status, "signing");
});

test("execute: the server's settled-but-unrecorded 500 leaves the tombstone 'signing' with the recovery message", async () => {
  // money moved, so the chain reports our nonce as USED: the record must stay 'signing'
  const { deps, store } = fakeDeps({ second: { status: 500, body: { error: "Your payment settled (tx 0xabc) but recording it failed." } }, nonceUsed: true });
  const r = await payListing({ ...RUN, execute: true }, deps);
  assert.equal(r.reason, "leg2_not_200");
  assert.match(String(r.message), /DO NOT re-run/);
  assert.equal(JSON.parse(store()!).status, "signing");
});

// 2026-09-19 (finding 3, exchange items 15-16): the worker's 502
// settlement_unconfirmed keeps the listing reserved; the script must NOT
// label the attempt 'refused' on a chain read that merely has not seen the
// transfer yet. The record stays 'signing' and gains the authorisation
// identity the later reconciliation needs. Red-proof: without the branch the
// same 502 (nonce unused) falls into the generic non-200 path and writes
// 'refused'.
test("execute: a 502 settlement_unconfirmed keeps the tombstone 'signing', rewrites it with from/nonce/valid_before, and never writes 'refused'", async () => {
  const { deps, store, calls } = fakeDeps({ second: { status: 502, body: { error: "settlement_unconfirmed", listing_id: 3, submission_id: 1, paying_since: 1789800000000, message: "The settle request was sent and no answer was read." } }, nonceUsed: false });
  const r = await payListing({ ...RUN, execute: true }, deps);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "leg2_unconfirmed");
  assert.match(String(r.message), /AMBIGUOUS/);
  assert.match(String(r.message), /DO NOT re-run/);
  const t = JSON.parse(store()!);
  assert.equal(t.status, "signing", "never 'refused' on an unconfirmed settle");
  assert.equal(typeof t.from, "string");
  assert.match(t.nonce, /^0x[0-9a-f]{64}$/i);
  assert.equal(typeof t.valid_before, "number");
  assert.equal(t.http_status, 502);
  assert.match(t.detail, /settlement_unconfirmed/);
  assert.ok(!calls.some((c) => c.kind === "authorizationUsed"), "the chain is not consulted to label an unconfirmed settle");
});

// The same 502 WITHOUT the code follows the old branch: chain says unused -> 'refused'.
test("execute: a 502 without the settlement_unconfirmed code still takes the generic non-200 branch (chain says unused -> 'refused')", async () => {
  const { deps, store } = fakeDeps({ second: { status: 502, body: { error: "The facilitator is unreachable (502). Your money was not taken. Try again later." } }, nonceUsed: false });
  const r = await payListing({ ...RUN, execute: true }, deps);
  assert.equal(r.reason, "leg2_refused");
  assert.equal(JSON.parse(store()!).status, "refused");
});

test("execute: an existing 'signing' tombstone refuses before any network call; a 'settled' one is idempotent success", async () => {
  const blocked = fakeDeps({ existing: JSON.stringify({ status: "signing", key: "k" }) });
  const r1 = await payListing({ ...RUN, execute: true }, blocked.deps);
  assert.equal(r1.reason, "tombstone_blocks");
  assert.ok(!blocked.calls.some((c) => c.kind.startsWith("fetch")));

  const done = fakeDeps({ existing: JSON.stringify({ status: "settled", tx: "0xdead", listing_id: 3, submission_id: 1 }) });
  const r2 = await payListing({ ...RUN, execute: true }, done.deps);
  assert.equal(r2.ok, true);
  assert.equal(r2.reason, "already_settled");
  assert.equal(r2.tx, "0xdead");
  assert.ok(!done.calls.some((c) => c.kind.startsWith("fetch")));
});

test("execute: a tombstone write failure refuses to sign", async () => {
  const { deps, calls } = fakeDeps({ writeExclusiveThrows: Object.assign(new Error("disk full"), { code: "ENOSPC" }) });
  const r = await payListing({ ...RUN, execute: true }, deps);
  assert.equal(r.reason, "tombstone_write_failed");
  assert.ok(!calls.some((c) => c.kind === "sign"));
});

test("an unpinned target or an invalid payee is refused before the bearer is ever used", async () => {
  const { deps, calls } = fakeDeps();
  const r = await payListing({ ...RUN, target: "https://evil.example/api/listing/3/pay", execute: true }, deps);
  assert.equal(r.reason, "target_not_pinned");
  const r2 = await payListing({ ...RUN, target: `${DEFAULT_URL}/api/listing/4/pay`, execute: true }, deps); // listing 4's URL for a listing-3 purchase
  assert.equal(r2.reason, "target_not_pinned");
  const r3 = await payListing({ ...RUN, payee: "0x123", execute: true }, deps);
  assert.equal(r3.reason, "payee_invalid");
  assert.deepEqual(calls, []);
});

test("an amount over the cap is refused before any network call", async () => {
  const { deps, calls } = fakeDeps();
  const r = await payListing({ ...RUN, amountCents: 2500, execute: true }, deps);
  assert.equal(r.reason, "amount_over_cap");
  assert.deepEqual(calls, []);
});

test("checkSettlementHeader: present + success + same tx passes; missing, undecodable, failed, or a different tx are named", () => {
  const tx = "0x" + "ab".repeat(32);
  assert.deepEqual(checkSettlementHeader(settlementHeader(tx), tx, PAYER), []);
  assert.deepEqual(checkSettlementHeader(settlementHeader(tx.toUpperCase().replace("0X", "0x")), tx, PAYER.toUpperCase().replace("0X", "0x")), [], "tx hashes and addresses are case-insensitive hex");
  assert.match(checkSettlementHeader(null, tx, PAYER).join(), /header missing/);
  assert.match(checkSettlementHeader("%%%not-base64-json", tx, PAYER).join(), /not base64-encoded JSON/);
  assert.match(checkSettlementHeader(Buffer.from(JSON.stringify({ success: false, transaction: tx, network: "base", payer: PAYER })).toString("base64"), tx, PAYER).join(), /success is not true/);
  assert.match(checkSettlementHeader(settlementHeader("0x" + "cd".repeat(32)), tx, PAYER).join(), /does not match the body's tx/);
  // GEMINI r1 p5: network and payer are checked too
  assert.match(checkSettlementHeader(Buffer.from(JSON.stringify({ success: true, transaction: tx, network: "base-sepolia", payer: PAYER })).toString("base64"), tx, PAYER).join(), /network "base-sepolia" is not "base"/);
  assert.match(checkSettlementHeader(Buffer.from(JSON.stringify({ success: true, transaction: tx, network: "base", payer: PAYEE })).toString("base64"), tx, PAYER).join(), /payer .* is not the account that signed/);
});

test("execute: a 402 carrying MORE than one payment alternative is refused with nothing signed (CODEX finding 1)", async () => {
  const { deps, calls } = fakeDeps({ first: { status: 402, body: { x402Version: 1, accepts: [goodReqs(), goodReqs({ payTo: "0x3f2950654ef9bf2d73805a77a07e4e14d5f74f16" })] } } });
  const r = await payListing({ ...RUN, execute: true }, deps);
  assert.equal(r.reason, "leg1_bad_402");
  assert.match(String(r.message), /2 payment alternatives/);
  assert.ok(!calls.some((c) => c.kind === "sign" || c.kind === "writeExclusive"));
});

test("execute: a 200 whose X-PAYMENT-RESPONSE is missing or names another tx leaves the tombstone 'signing'", async () => {
  const missing = fakeDeps({ second: { status: 200, body: goodReceipt(), header: null } });
  const r1 = await payListing({ ...RUN, execute: true }, missing.deps);
  assert.equal(r1.reason, "leg2_bad_body");
  assert.match(String(r1.message), /header missing/);
  assert.equal(JSON.parse(missing.store()!).status, "signing");

  const other = fakeDeps({ second: { status: 200, body: goodReceipt(), header: settlementHeader("0x" + "cd".repeat(32)) } });
  const r2 = await payListing({ ...RUN, execute: true }, other.deps);
  assert.equal(r2.reason, "leg2_bad_body");
  assert.match(String(r2.message), /does not match the body's tx/);
  assert.equal(JSON.parse(other.store()!).status, "signing");
});

test("payListing re-validates its numeric arguments at the exported boundary, before the bearer is used", async () => {
  const { deps, calls } = fakeDeps();
  const noPayer = await payListing({ ...RUN, payer: null, execute: true }, deps);
  assert.equal(noPayer.reason, "argument_invalid");
  assert.match(String(noPayer.message), /payer/);
  for (const bad of [{ listingId: 3.5 }, { submissionId: 0 }, { amountCents: -1200 }, { maxAmountCents: Number.NaN }, { amountCents: 2 ** 53 }, { walletRow: 0 }, { walletRow: "24" }, { walletRowHash: undefined }, { walletRowHash: WALLET_ROW_HASH.slice(1) }, { walletRowHash: WALLET_ROW_HASH.toUpperCase() }]) {
    const r = await payListing({ ...RUN, ...bad, target: payTarget((bad as any).listingId ?? 3), execute: true }, deps);
    assert.equal(r.reason, "argument_invalid", JSON.stringify(bad));
  }
  assert.deepEqual(calls, []);
});

// ---------- the wallet-row pin: what the desk refuses when the published head moves (1f916 69513, chit402) ----------

test("pin: the three public reads run BEFORE the bearer is used, in dry run and execute alike, and the dry run reports what was checked", async () => {
  const dry = fakeDeps();
  const r1 = await payListing({ ...RUN, execute: false }, dry.deps);
  assert.equal(r1.reason, "dry_run", JSON.stringify(r1));
  assert.deepEqual(dry.calls.slice(0, 3).map((c) => c.kind), PIN_READS);
  assert.match(dry.calls[0].url, new RegExp(`^${DEFAULT_URL}/api/listing/3$`));
  assert.equal(dry.calls[1].url, `${DEFAULT_URL}/api/events?kind=wallet_declared`);
  assert.equal(dry.calls[2].url, `${DEFAULT_URL}/api/attest?identity_from=${WALLET_ROW_ID}&identity_expect=${WALLET_ROW_HASH}`);
  assert.deepEqual(r1.walletRowCheck, { row: WALLET_ROW_ID, citizen_id: SUBMITTER_ID, citizen: "midas-jt3", submitter_handle: "midas-jt3", attest_status: "verified", identity_head: "0x" + "cd".repeat(32) });

  const exec = fakeDeps();
  const r2 = await payListing({ ...RUN, execute: true }, exec.deps);
  assert.equal(r2.reason, "settled", JSON.stringify(r2));
  const order = exec.calls.map((c) => c.kind);
  assert.ok(order.indexOf("fetch:json:attest") < order.indexOf("fetch:leg1"), "the witness is asked before the bearer is used");
  assert.equal(r2.walletRowCheck?.row, WALLET_ROW_ID);
});

test("pin: a chain that no longer holds the pinned hash at the pinned row (expect_matches:false, the moved head) is refused with nothing signed, no bearer used and no tombstone", async () => {
  const { deps, calls, store } = fakeDeps({ attest: goodAttestDoc({ status: "mismatch", expect_matches: false, anchor_at_from: "0x" + "ee".repeat(32), ok: false }) });
  const r = await payListing({ ...RUN, execute: true }, deps);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "wallet_row_moved");
  assert.match(String(r.message), /published head moved under the row the desk pinned/);
  assert.ok(!calls.some((c) => c.kind === "fetch:leg1" || c.kind === "sign" || c.kind === "writeExclusive"), JSON.stringify(calls.map((c) => c.kind)));
  assert.equal(store(), null);
  // the dry run refuses on the same answer
  const dry = fakeDeps({ attest: goodAttestDoc({ status: "mismatch", expect_matches: false, ok: false }) });
  assert.equal((await payListing({ ...RUN, execute: false }, dry.deps)).reason, "wallet_row_moved");
});

test("pin: a broken chain after the row, or an attest answer with no identity_log, refuses even when expect_matches is true", () => {
  assert.equal(checkWitness(goodAttestDoc({ status: "broken", ok: false, reason: "row 27 does not chain from row 26" }), WALLET_ROW_ID, WALLET_ROW_HASH).reason, "wallet_row_chain_broken");
  assert.equal(checkWitness({ ok: true }, WALLET_ROW_ID, WALLET_ROW_HASH).reason, "wallet_row_unreadable");
  assert.equal(checkWitness(null, WALLET_ROW_ID, WALLET_ROW_HASH).reason, "wallet_row_unreadable");
  assert.equal(checkWitness(goodAttestDoc({ expect_matches: undefined }), WALLET_ROW_ID, WALLET_ROW_HASH).reason, "wallet_row_moved");
  // 'incomplete' with the match is accepted: the page limit is not a tamper report, the match is the pin
  const inc = checkWitness(goodAttestDoc({ status: "incomplete", ok: false, next_from: 20000 }), WALLET_ROW_ID, WALLET_ROW_HASH);
  assert.equal(inc.ok, true);
  assert.equal(inc.status, "incomplete");
});

test("pin: checkWalletRow refuses a missing row, a row of another kind, a row naming another wallet, another citizen's row, a superseded declaration, and a row that does not recompute to the pinned hash", () => {
  const good = { rows: [WALLET_ROW], walletRow: WALLET_ROW_ID, walletRowHash: WALLET_ROW_HASH, payee: PAYEE, submitterCitizenId: SUBMITTER_ID };
  assert.equal(checkWalletRow(good).ok, true);
  // the payee comparison is case-insensitive: the served detail is lowercase, the command line may be checksummed
  assert.equal(checkWalletRow({ ...good, payee: "0xB7C76E6A9422AE6A6D610BE0E7B8FC1B18B7369E" }).ok, true);
  assert.equal(checkWalletRow({ ...good, walletRow: 25 }).reason, "wallet_row_missing");
  assert.equal(checkWalletRow({ ...good, rows: [{ ...WALLET_ROW, kind: "key_registered" }] }).reason, "wallet_row_kind");
  assert.equal(checkWalletRow({ ...good, payee: "0x3f2950654ef9bf2d73805a77a07e4e14d5f74f16" }).reason, "wallet_row_payee");
  assert.equal(checkWalletRow({ ...good, submitterCitizenId: 12 }).reason, "wallet_row_citizen");
  const later = { ...WALLET_ROW, id: 31, prev_hash: WALLET_ROW_HASH, detail: "wallet declared: 0x2e9bfe770d8fac9e3cfed9c67f260922ef0614a0" };
  const superseded = checkWalletRow({ ...good, rows: [WALLET_ROW, { ...later, hash: recomputeIdentityRowHash(later) }] });
  assert.equal(superseded.reason, "wallet_row_superseded");
  assert.match(String(superseded.message), /row 31/);
  // another citizen's later declaration does not supersede this one
  assert.equal(checkWalletRow({ ...good, rows: [WALLET_ROW, { ...later, citizen_id: 12 }] }).ok, true);
  // the served hash field is ignored; the preimage is what is recomputed
  assert.equal(checkWalletRow({ ...good, rows: [{ ...WALLET_ROW, hash: "0".repeat(64) }] }).ok, true);
  assert.equal(checkWalletRow({ ...good, rows: [{ ...WALLET_ROW, created_at: WALLET_ROW.created_at + 1 }] }).reason, "wallet_row_hash");
  assert.equal(checkWalletRow({ ...good, walletRowHash: "f".repeat(64) }).reason, "wallet_row_hash");
});

test("pin: recomputeIdentityRowHash is the identity log's own preimage, and IDENTITY_HASH_RE is lowercase 64-hex only", () => {
  assert.equal(recomputeIdentityRowHash(WALLET_ROW_BASE), WALLET_ROW_HASH);
  assert.notEqual(recomputeIdentityRowHash({ ...WALLET_ROW_BASE, detail: WALLET_ROW_BASE.detail + " " }), WALLET_ROW_HASH);
  assert.equal(IDENTITY_HASH_RE.test(WALLET_ROW_HASH), true);
  assert.equal(IDENTITY_HASH_RE.test(WALLET_ROW_HASH.toUpperCase()), false);
  assert.equal(IDENTITY_HASH_RE.test("0x" + WALLET_ROW_HASH), false);
  assert.equal(IDENTITY_HASH_RE.test(WALLET_ROW_HASH.slice(0, 63)), false);
});

test("pin: through payListing, a row naming another wallet, another citizen's row, or a superseded row refuses before the attest read and before the bearer", async () => {
  const otherWallet = fakeDeps({ events: goodEventsDoc([{ ...WALLET_ROW, detail: "wallet declared: 0x3f2950654ef9bf2d73805a77a07e4e14d5f74f16" }]) });
  const r1 = await payListing({ ...RUN, execute: true }, otherWallet.deps);
  assert.equal(r1.reason, "wallet_row_payee");
  assert.deepEqual(otherWallet.calls.map((c) => c.kind), ["exists", "fetch:json:listing", "fetch:json:events"]);

  const otherCitizen = fakeDeps({ listing: { listing: { id: 3 }, submissions: [{ id: 1, citizen_id: 12, submitter_handle: "boundary-auditor-v2" }] } });
  const r2 = await payListing({ ...RUN, execute: true }, otherCitizen.deps);
  assert.equal(r2.reason, "wallet_row_citizen");

  const later = { ...WALLET_ROW, id: 31, prev_hash: WALLET_ROW_HASH };
  const superseded = fakeDeps({ events: goodEventsDoc([WALLET_ROW, { ...later, hash: recomputeIdentityRowHash(later) }]) });
  const r3 = await payListing({ ...RUN, execute: true }, superseded.deps);
  assert.equal(r3.reason, "wallet_row_superseded");

  const unknownSubmission = fakeDeps({ listing: { listing: { id: 3 }, submissions: [] } });
  const r4 = await payListing({ ...RUN, execute: true }, unknownSubmission.deps);
  assert.equal(r4.reason, "submission_unknown");
  for (const d of [otherWallet, otherCitizen, superseded, unknownSubmission]) {
    assert.ok(!d.calls.some((c) => c.kind === "fetch:leg1" || c.kind === "fetch:json:attest" || c.kind === "sign" || c.kind === "writeExclusive"));
    assert.equal(d.store(), null);
  }
});

test("pin: an unreadable public row refuses (fail closed), with nothing signed and no tombstone", async () => {
  for (const opts of [{ listing: new Error("HTTP 503") }, { events: new Error("HTTP 503") }, { attest: new Error("timeout") }, { events: { events: "not-an-array" } }]) {
    const { deps, calls, store } = fakeDeps(opts);
    const r = await payListing({ ...RUN, execute: true }, deps);
    assert.equal(r.reason, "wallet_row_unreadable", JSON.stringify(opts));
    assert.ok(!calls.some((c) => c.kind === "fetch:leg1" || c.kind === "sign" || c.kind === "writeExclusive"));
    assert.equal(store(), null);
  }
});

// ---------- GEMINI round 1: balance pre-check, refused leg 2, retry rule ----------

test("execute: the balance is read BEFORE the tombstone and the sign; an underfunded payer is refused with nothing written (the live $5.17 case)", async () => {
  const { deps, calls, store } = fakeDeps({ balance: 5_174_821n });
  const r = await payListing({ ...RUN, execute: true }, deps);
  assert.equal(r.reason, "balance_insufficient");
  assert.match(String(r.message), /holds 5.174821 USDC, less than the 12.00 USDC/);
  assert.deepEqual(calls.map((c) => c.kind), ["exists", ...PIN_READS, "fetch:leg1", "usdcBalanceAtomic"]);
  assert.equal(store(), null);
});

test("execute: an unreadable balance refuses to sign (fail closed)", async () => {
  const { deps, calls } = fakeDeps({ balance: new Error("every RPC refused") });
  const r = await payListing({ ...RUN, execute: true }, deps);
  assert.equal(r.reason, "balance_unknown");
  assert.ok(!calls.some((c) => c.kind === "sign" || c.kind === "writeExclusive"));
});

test("execute: a 402 second leg whose nonce the chain says is UNUSED becomes a 'refused' tombstone, not a wedge", async () => {
  const { deps, calls, store } = fakeDeps({ second: { status: 402, body: { x402Version: 1, error: "insufficient funds", accepts: [goodReqs()] } }, nonceUsed: false });
  const r = await payListing({ ...RUN, execute: true }, deps);
  assert.equal(r.reason, "leg2_refused");
  assert.match(String(r.message), /Nothing was paid/);
  // the time the operator is told to wait for is the gate's time: validBefore + margin
  assert.match(String(r.message), new RegExp("re-run is allowed after " + new Date((VALID_BEFORE + RETRY_MARGIN_SECONDS) * 1000).toISOString().replace(/[.]/g, "[.]")));
  const t = JSON.parse(store()!);
  assert.equal(t.status, "refused");
  assert.equal(t.nonce, NONCE);
  assert.equal(t.from, PAYER);
  assert.equal(t.valid_before, VALID_BEFORE);
  assert.ok(calls.some((c) => c.kind === "authorizationUsed" && c.nonce === NONCE && c.from === PAYER));
});

test("execute: a non-200 second leg whose nonce the chain says IS used, or cannot be checked, keeps 'signing'", async () => {
  const used = fakeDeps({ second: { status: 500, body: { error: "settled but unrecorded" } }, nonceUsed: true });
  const r1 = await payListing({ ...RUN, execute: true }, used.deps);
  assert.equal(r1.reason, "leg2_not_200");
  assert.equal(JSON.parse(used.store()!).status, "signing");

  const dark = fakeDeps({ second: { status: 402, body: { error: "x" } }, nonceUsed: new Error("rpc down") });
  const r2 = await payListing({ ...RUN, execute: true }, dark.deps);
  assert.equal(r2.reason, "leg2_not_200");
  assert.equal(JSON.parse(dark.store()!).status, "signing");
});

test("refusedRetryDecision: retry only after valid_before PLUS the clock-skew margin, and never if the chain now says the nonce was used or gave no definite answer", () => {
  const refused = { status: "refused", valid_before: VALID_BEFORE };
  assert.equal(RETRY_MARGIN_SECONDS, 300);
  assert.equal(refusedRetryDecision(refused, VALID_BEFORE - 1, false).retry, false);
  assert.equal(refusedRetryDecision(refused, VALID_BEFORE + 1, false).retry, false, "inside the margin: a fast local clock could still be inside the on-chain validity window");
  assert.equal(refusedRetryDecision(refused, VALID_BEFORE + RETRY_MARGIN_SECONDS, false).retry, false);
  assert.equal(refusedRetryDecision(refused, VALID_BEFORE + RETRY_MARGIN_SECONDS + 1, false).retry, true);
  assert.match(refusedRetryDecision(refused, VALID_BEFORE + 1000, true).reason, /HAS been executed/);
  assert.match(refusedRetryDecision(refused, VALID_BEFORE + 1000, undefined as any).reason, /not a definite 'unexecuted'/);
  assert.equal(refusedRetryDecision({ status: "refused" }, VALID_BEFORE + 1000, false).retry, false);
});

test("execute: a 'refused' tombstone blocks a re-run while the earlier authorization is still valid, and allows one (atomic replace, not wx) after it expires", async () => {
  const refusedRecord = JSON.stringify({ status: "refused", key: "k", from: PAYER, nonce: NONCE, valid_before: VALID_BEFORE });
  const early = fakeDeps({ existing: refusedRecord, now: VALID_BEFORE - 10 });
  const r1 = await payListing({ ...RUN, execute: true }, early.deps);
  assert.equal(r1.reason, "tombstone_blocks");
  assert.match(String(r1.message), /still valid until/);
  assert.ok(!early.calls.some((c) => c.kind.startsWith("fetch")));

  const late = fakeDeps({ existing: refusedRecord, now: VALID_BEFORE + RETRY_MARGIN_SECONDS + 10 });
  const r2 = await payListing({ ...RUN, execute: true }, late.deps);
  assert.equal(r2.reason, "settled", JSON.stringify(r2));
  const order = late.calls.map((c) => c.kind);
  assert.ok(order.indexOf("authorizationUsed") < order.indexOf("fetch:leg1"), "the chain is asked before any network call");
  assert.ok(order.includes("writeAtomic") && !order.slice(0, order.indexOf("sign")).includes("writeExclusive"), "the refused record is REPLACED atomically, never wx'd over");
  assert.equal(JSON.parse(late.store()!).status, "settled");

  const executedMeanwhile = fakeDeps({ existing: refusedRecord, now: VALID_BEFORE + RETRY_MARGIN_SECONDS + 10, nonceUsed: true });
  const r3 = await payListing({ ...RUN, execute: true }, executedMeanwhile.deps);
  assert.equal(r3.reason, "tombstone_blocks");
  assert.match(String(r3.message), /HAS been executed/);
});

test("decodeSentAuthorization reads from, nonce and validBefore back out of the header we sent, and rejects a malformed one", () => {
  assert.deepEqual(decodeSentAuthorization(sentHeader()), { from: PAYER, nonce: NONCE, validBefore: VALID_BEFORE });
  assert.throws(() => decodeSentAuthorization(Buffer.from(JSON.stringify({ payload: { authorization: { from: PAYER, nonce: "0x12" } } })).toString("base64")), /well-formed authorization/);
});

test("decideAuthorizationUsed: any 'true' wins; 'false' needs a quorum of agreeing endpoints; anything less is an error (never a silent 'unexecuted')", () => {
  assert.equal(AUTHORIZATION_QUORUM, 2);
  assert.equal(decideAuthorizationUsed([false, false, new Error("down"), new Error("down")]), false);
  assert.equal(decideAuthorizationUsed([false, true, false, false]), true, "one endpoint seeing the execution is enough to refuse a retry");
  assert.equal(decideAuthorizationUsed([true, new Error("down"), new Error("down"), new Error("down")]), true);
  assert.throws(() => decideAuthorizationUsed([false, new Error("down"), new Error("down"), new Error("down")]), /only 1 endpoint\(s\) gave a definite answer/);
  assert.throws(() => decideAuthorizationUsed([new Error("a"), new Error("b"), new Error("c"), new Error("d")]), /only 0 endpoint/);
});

