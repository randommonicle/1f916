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
  classifyTombstone,
  parseArgs,
  readFunderSecret,
  payListing,
  DEFAULT_URL,
} from "../scripts/pay-listing.mjs";

const PAYEE = "0xb7c76e6a9422ae6a6d610be0e7b8fc1b18b7369e";
const TARGET = `${DEFAULT_URL}/api/listing/3/pay`;
const PURCHASE = { listingId: 3, submissionId: 1, payee: PAYEE, amountCents: 1200 };

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
  assert.deepEqual(validatePayReceipt(goodReceipt(), PURCHASE), []);
});

test("validatePayReceipt names every contradiction", () => {
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

test("parseArgs requires all four purchase flags, refuses --url, and validates the payee", () => {
  const ok = parseArgs(["--listing", "3", "--submission", "1", "--payee", PAYEE, "--amount-cents", "1200"]);
  assert.deepEqual(ok, { listingId: 3, submissionId: 1, payee: PAYEE, amountCents: 1200, maxAmountCents: 2000, execute: false });
  assert.equal(parseArgs(["--listing", "3", "--submission", "1", "--payee", PAYEE, "--amount-cents", "1200", "--execute", "--max-amount-cents", "1500"]).execute, true);
  assert.throws(() => parseArgs(["--submission", "1", "--payee", PAYEE, "--amount-cents", "1200"]), /--listing is required/);
  assert.throws(() => parseArgs(["--listing", "3", "--payee", PAYEE, "--amount-cents", "1200"]), /--submission is required/);
  assert.throws(() => parseArgs(["--listing", "3", "--submission", "1", "--amount-cents", "1200"]), /--payee is required/);
  assert.throws(() => parseArgs(["--listing", "3", "--submission", "1", "--payee", PAYEE]), /--amount-cents is required/);
  assert.throws(() => parseArgs(["--listing", "3", "--submission", "1", "--payee", "not-an-address", "--amount-cents", "1200"]), /--payee must be a 0x-prefixed/);
  assert.throws(() => parseArgs(["--listing", "0", "--submission", "1", "--payee", PAYEE, "--amount-cents", "1200"]), /--listing must be a positive integer/);
  assert.throws(() => parseArgs(["--listing", "3", "--submission", "1", "--payee", PAYEE, "--amount-cents", "12.5"]), /--amount-cents must be a positive integer/);
  assert.throws(() => parseArgs(["--listing", "3", "--submission", "1", "--payee", PAYEE, "--amount-cents", "1200", "--url", "https://evil.example"]), /unrecognised argument: --url/);
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

function fakeDeps(opts: { first?: { status: number; body: unknown }; second?: { status: number; body: unknown; header?: string | null }; existing?: string | null; signThrows?: boolean; writeExclusiveThrows?: any } = {}) {
  const calls: Call[] = [];
  let store: string | null = opts.existing ?? null;
  const deps = {
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
    sign: async (reqs: unknown) => { calls.push({ kind: "sign", reqs }); if (opts.signThrows) throw new Error("no key"); return "PAYMENT-HEADER"; },
  };
  return { deps, calls, store: () => store };
}

const RUN = { ...PURCHASE, maxAmountCents: 2000, target: TARGET, funderSecret: "commonhold_sk_" + "1".repeat(64) };

test("dry run: one authenticated 402 probe with redirect:error, requirements validated, NEVER signs, writes nothing", async () => {
  const { deps, calls } = fakeDeps();
  const r = await payListing({ ...RUN, execute: false }, deps);
  assert.equal(r.ok, true);
  assert.equal(r.reason, "dry_run");
  assert.deepEqual(calls.map((c) => c.kind), ["fetch:leg1"]);
  assert.equal(calls[0].redirect, "error");
  assert.equal(calls[0].hasBearer, true);
  assert.equal(calls[0].body, JSON.stringify({ submission_id: 1 }));
});

test("execute: mkdir + exclusive tombstone BEFORE sign, then leg 2, then the settled receipt", async () => {
  const { deps, calls, store } = fakeDeps();
  const r = await payListing({ ...RUN, execute: true }, deps);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.reason, "settled");
  assert.equal(r.tx, "0x" + "ab".repeat(32));
  const order = calls.map((c) => c.kind);
  assert.deepEqual(order, ["exists", "fetch:leg1", "mkdir", "writeExclusive", "sign", "fetch:leg2", "writeAtomic"]);
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
  assert.deepEqual(calls.map((c) => c.kind), ["exists", "fetch:leg1"]);
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
  const { deps, store } = fakeDeps({ second: { status: 500, body: { error: "Your payment settled (tx 0xabc) but recording it failed." } } });
  const r = await payListing({ ...RUN, execute: true }, deps);
  assert.equal(r.reason, "leg2_not_200");
  assert.match(String(r.message), /DO NOT re-run/);
  assert.equal(JSON.parse(store()!).status, "signing");
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
  assert.deepEqual(checkSettlementHeader(settlementHeader(tx), tx), []);
  assert.deepEqual(checkSettlementHeader(settlementHeader(tx.toUpperCase().replace("0X", "0x")), tx), [], "tx hashes are case-insensitive hex");
  assert.match(checkSettlementHeader(null, tx).join(), /header missing/);
  assert.match(checkSettlementHeader("%%%not-base64-json", tx).join(), /not base64-encoded JSON/);
  assert.match(checkSettlementHeader(Buffer.from(JSON.stringify({ success: false, transaction: tx })).toString("base64"), tx).join(), /success is not true/);
  assert.match(checkSettlementHeader(settlementHeader("0x" + "cd".repeat(32)), tx).join(), /does not match the body's tx/);
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
  for (const bad of [{ listingId: 3.5 }, { submissionId: 0 }, { amountCents: -1200 }, { maxAmountCents: Number.NaN }, { amountCents: 2 ** 53 }]) {
    const r = await payListing({ ...RUN, ...bad, target: payTarget((bad as any).listingId ?? 3), execute: true }, deps);
    assert.equal(r.reason, "argument_invalid", JSON.stringify(bad));
  }
  assert.deepEqual(calls, []);
});

