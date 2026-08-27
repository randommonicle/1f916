// Tests for scripts/post-listing.mjs's pure money-critical logic: the fee
// formula (must match the server's), the canonical at-most-once key over the
// PURCHASE identity (HIGH-fix #1, plus Gemini finding A: expires_at excluded),
// the listing-body extraction, the 402 sanity gate with STRICT resource binding
// (Gemini finding C), and tombstone classification (HIGH-fix #2).
//
// The live HTTP round trip in main() is not covered here, same convention as
// register-maintainer.test.ts: only a real payment proves the facilitator's
// verdict, and that is the operator's step, not this suite's.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  computeListingFeeCents,
  canonicalize,
  buildListingBody,
  purchaseIdentity,
  attemptKey,
  validateListingPaymentRequirements,
  classifyTombstone,
  parseArgs,
  postListing,
  TARGET,
} from "../scripts/post-listing.mjs";
import { computeListingFeeCents as serverComputeFee } from "../src/listings.ts";

const URL = "https://commonhold.randommonicle.workers.dev/api/listing";
const validSource = {
  title: "Adversarially review our settlement path",
  description: "do the thing, cite the lines",
  url: null,
  acceptance_condition: "name a defect with lines and input, or argue soundness",
  bounty_cents: 1500,
  expires_at: 1788000000000,
};

// End-to-end: source file -> validated body -> purchase identity -> key.
function keyOf(source: any, url = URL, funder = "commonhold-agent") {
  return attemptKey("POST", url, funder, purchaseIdentity(buildListingBody(source)));
}

function validReqs(feeCents: number) {
  return {
    scheme: "exact",
    network: "base",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    payTo: "0xD9E17995352EF13F9Ba467e2F36C7614A45e7011",
    maxAmountRequired: String(feeCents * 10000),
    resource: URL,
    extra: { name: "USD Coin", version: "2" },
    maxTimeoutSeconds: 300,
  };
}

// ---------- fee formula (drift guard) ----------

test("fee: matches society/src/listings.ts across a range (incl. floor and ceil)", () => {
  for (const b of [100, 333, 400, 1000, 1500, 9999, 100000]) {
    assert.equal(computeListingFeeCents(b), serverComputeFee(b));
  }
});

test("fee: known values", () => {
  assert.equal(computeListingFeeCents(1500), 225);
  assert.equal(computeListingFeeCents(100), 50);
  assert.equal(computeListingFeeCents(333), 50);
  assert.equal(computeListingFeeCents(334), 51);
});

// ---------- canonical at-most-once key (HIGH-fix #1 + finding A) ----------

test("key: reformatting (whitespace, CRLF, key order) yields ONE key; raw bytes would NOT", () => {
  const s1 =
    '{"title":"Review X","description":"des","url":null,"acceptance_condition":"acc","bounty_cents":1500,"expires_at":1788000000000}';
  const s2 =
    '{\r\n  "expires_at": 1788000000000,\r\n  "bounty_cents": 1500,\r\n  "acceptance_condition": "acc",\r\n  "url": null,\r\n  "description": "des",\r\n  "title": "Review X"\r\n}';
  assert.equal(keyOf(JSON.parse(s1)), keyOf(JSON.parse(s2)));
  const rawKey = (s: string) => createHash("sha256").update(s).digest("hex");
  assert.notEqual(rawKey(s1), rawKey(s2)); // the OLD raw-byte approach split these
});

test("key: bumping expires_at does NOT change the key (finding A fix -- no double-pay on retry)", () => {
  assert.equal(keyOf(validSource), keyOf({ ...validSource, expires_at: 1799999999999 }));
});

test("key: extra non-endpoint fields (_note, expires_days) do not affect it", () => {
  assert.equal(keyOf(validSource), keyOf({ ...validSource, _note: "ignore", expires_days: 7 }));
});

test("key: a real purchase change diverges it (bounty sets the fee, title/desc are content)", () => {
  const k = keyOf(validSource);
  assert.notEqual(keyOf({ ...validSource, bounty_cents: 1600 }), k);
  assert.notEqual(keyOf({ ...validSource, title: "Review Y and Z" }), k);
});

test("key: a different endpoint or funder diverges it", () => {
  const k = keyOf(validSource);
  assert.notEqual(keyOf(validSource, "https://evil.example/api/listing"), k);
  assert.notEqual(keyOf(validSource, URL, "someone-else"), k);
});

test("purchaseIdentity: drops expires_at, keeps the fee-setting bounty and the content", () => {
  const p = purchaseIdentity(buildListingBody(validSource));
  assert.equal("expires_at" in p, false);
  assert.equal(p.bounty_cents, 1500);
  assert.equal(p.title, validSource.title);
});

test("canonicalize: sorts nested keys, preserves primitives and in-string CRLF", () => {
  assert.equal(canonicalize({ b: 1, a: 2 }), canonicalize({ a: 2, b: 1 }));
  assert.equal(canonicalize({ a: 2, b: 1 }), '{"a":2,"b":1}');
  assert.equal(canonicalize("x\r\ny"), '"x\\r\\ny"');
});

// ---------- buildListingBody ----------

test("body: extracts only the allowed fields, in fixed order", () => {
  const body = buildListingBody({ ...validSource, _note: "x", expires_days: 7 } as any);
  assert.deepEqual(Object.keys(body), ["title", "description", "url", "acceptance_condition", "bounty_cents", "expires_at"]);
});

test("body: throws on a missing required field", () => {
  const { title, ...rest } = validSource as any;
  assert.throws(() => buildListingBody(rest), /missing required field: title/);
});

test("body: throws on a non-integer or too-small bounty", () => {
  assert.throws(() => buildListingBody({ ...validSource, bounty_cents: 1500.5 }), /bounty_cents/);
  assert.throws(() => buildListingBody({ ...validSource, bounty_cents: 99 }), /bounty_cents/);
});

test("body: throws when expires_at is not an integer epoch", () => {
  assert.throws(() => buildListingBody({ ...validSource, expires_at: "soon" } as any), /expires_at/);
});

test("body: throws on an over-long title or acceptance_condition", () => {
  assert.throws(() => buildListingBody({ ...validSource, title: "x".repeat(121) }), /title/);
  assert.throws(() => buildListingBody({ ...validSource, acceptance_condition: "y".repeat(501) }), /acceptance_condition/);
});

// ---------- 402 sanity gate (with STRICT resource binding, finding C) ----------

test("402: passes a well-formed challenge whose fee matches, is under cap, and resource is exact", () => {
  assert.doesNotThrow(() => validateListingPaymentRequirements(validReqs(225), 225, 300, URL));
});

test("402: refuses a non-USDC asset", () => {
  assert.throws(() => validateListingPaymentRequirements({ ...validReqs(225), asset: "0x0000000000000000000000000000000000000001" }, 225, 300, URL), /asset/);
});

test("402: refuses a payTo that is not the treasury", () => {
  assert.throws(() => validateListingPaymentRequirements({ ...validReqs(225), payTo: "0x000000000000000000000000000000000000dEaD" }, 225, 300, URL), /payTo/);
});

test("402: refuses when the charged amount is not exactly our computed fee (overcharge)", () => {
  assert.throws(() => validateListingPaymentRequirements(validReqs(250), 225, 300, URL), /maxAmountRequired/);
});

test("402: refuses when the fee exceeds the hard cap", () => {
  assert.throws(() => validateListingPaymentRequirements(validReqs(400), 400, 300, URL), /cap/);
});

test("402: refuses a wrong EIP-712 domain", () => {
  assert.throws(() => validateListingPaymentRequirements({ ...validReqs(225), extra: { name: "Fake Coin", version: "2" } }, 225, 300, URL), /domain/);
});

test("402: STRICT resource -- a look-alike host ending /api/listing is refused (finding C)", () => {
  // endsWith('/api/listing') would have PASSED this; strict equality refuses it.
  assert.throws(() => validateListingPaymentRequirements({ ...validReqs(225), resource: "https://evil.example/api/listing" }, 225, 300, URL), /resource/);
  assert.throws(() => validateListingPaymentRequirements({ ...validReqs(225), resource: "https://commonhold.randommonicle.workers.dev/api/register" }, 225, 300, URL), /resource/);
});

// ---------- tombstone (HIGH-fix #2) ----------

test("tombstone: a settled record is terminal and carries its receipt", () => {
  const t = classifyTombstone(JSON.stringify({ status: "settled", listing_id: 7, fee_tx: "0xabc" }));
  assert.equal(t.status, "settled");
  assert.equal(t.listing_id, 7);
  assert.equal(t.fee_tx, "0xabc");
});

test("tombstone: a signing record is flagged for on-chain verification", () => {
  assert.equal(classifyTombstone(JSON.stringify({ status: "signing" })).status, "signing");
});

test("tombstone: corrupt content is reported, never treated as settled", () => {
  assert.equal(classifyTombstone("{not json").status, "corrupt");
});

// ---------- args ----------

test("args: defaults to a DRY RUN (execute false) and the $3 fee cap", () => {
  const a = parseArgs(["--listing-file", "x.json"]);
  assert.equal(a.execute, false);
  assert.equal(a.maxFeeCents, 300);
});

test("args: --execute opts in to paying", () => {
  assert.equal(parseArgs(["--listing-file", "x.json", "--execute"]).execute, true);
});

test("args: requires --listing-file", () => {
  assert.throws(() => parseArgs([]), /--listing-file/);
});

test("args: rejects a non-positive-integer fee cap", () => {
  assert.throws(() => parseArgs(["--listing-file", "x.json", "--max-fee-cents", "0"]), /max-fee-cents/);
});

test("args: --url and --tombstone-dir are rejected (pinned, no override)", () => {
  assert.throws(() => parseArgs(["--listing-file", "x.json", "--url", "https://evil.example"]), /unrecognised argument/);
  assert.throws(() => parseArgs(["--listing-file", "x.json", "--tombstone-dir", "/tmp"]), /unrecognised argument/);
});

// ---------- injectable orchestration: the money-code call order (Codex #3) ----------

test("TARGET is the pinned Commonhold listing endpoint", () => {
  assert.equal(TARGET, URL);
});

function bodyOf(overrides: any = {}) {
  return buildListingBody({ ...validSource, ...overrides });
}

// Fake fetch/fs/signer that records the call order. A fetch carrying X-PAYMENT
// is leg 2; otherwise leg 1. writes.signing/settled capture the tombstone.
function makeDeps(opts: any = {}) {
  const calls: string[] = [];
  const writes: any = {};
  let fi = 0;
  const deps = {
    fetch: async (_url: string, o: any) => {
      const leg = o?.headers?.["X-PAYMENT"] ? "leg2" : "leg1";
      calls.push(`fetch:${leg}:redirect=${o?.redirect}`);
      const r = (opts.responses ?? [])[fi++];
      if (!r) throw new Error("no canned response");
      if (r.throw) throw new Error("network");
      return { status: r.status, text: async () => (typeof r.body === "string" ? r.body : JSON.stringify(r.body)) };
    },
    exists: () => { calls.push("exists"); return !!opts.seededExists; },
    readFile: () => { calls.push("readFile"); return opts.seededTomb ?? "{}"; },
    writeExclusive: (_p: string, data: string) => {
      calls.push("writeExclusive");
      if (opts.wxThrows) { const e: any = new Error("exists"); e.code = opts.wxThrows; throw e; }
      writes.signing = data;
    },
    writeAtomic: (_p: string, data: string) => { calls.push("writeAtomic"); writes.settled = data; },
    mkdir: () => { calls.push("mkdir"); },
    sign: async () => { calls.push("sign"); if (opts.signThrows) throw new Error("sign fail"); return "PAYHDR"; },
  };
  return { calls, writes, deps };
}

const params = (execute: boolean, body = bodyOf()) => ({ body, target: TARGET, funderSecret: "sek", maxFeeCents: 300, execute });
const ok402 = { status: 402, body: { x402Version: 1, accepts: [validReqs(225)] } };
const ok201 = { status: 201, body: { listing_id: 42, fee_tx: "0xabc", fee_cents: 225, bounty_cents: 1500 } };

test("orchestrate: an evil (non-pinned) target is refused before any bearer, fetch, or sign", async () => {
  const m = makeDeps({ responses: [ok402] });
  const r = await postListing({ ...params(true), target: "https://evil.example/api/listing" }, m.deps);
  assert.equal(r.reason, "target_not_pinned");
  assert.deepEqual(m.calls, []);
});

test("orchestrate: a settled tombstone short-circuits with no fetch, no sign", async () => {
  const m = makeDeps({ seededExists: true, seededTomb: JSON.stringify({ status: "settled", listing_id: 9, fee_tx: "0xf" }) });
  const r = await postListing(params(true), m.deps);
  assert.equal(r.reason, "already_settled");
  assert.equal(r.listingId, 9);
  assert.deepEqual(m.calls, ["exists", "readFile"]);
});

test("orchestrate: a signing tombstone blocks execute (no fetch, no sign)", async () => {
  const m = makeDeps({ seededExists: true, seededTomb: JSON.stringify({ status: "signing" }) });
  const r = await postListing(params(true), m.deps);
  assert.equal(r.reason, "tombstone_blocks");
  assert.ok(!m.calls.some((c) => c.startsWith("fetch")));
  assert.ok(!m.calls.includes("sign"));
});

test("orchestrate: dry-run reaches the 402 with redirect:error and NEVER signs or writes", async () => {
  const m = makeDeps({ responses: [ok402] });
  const r = await postListing(params(false), m.deps);
  assert.equal(r.reason, "dry_run");
  assert.equal(m.calls[0], "fetch:leg1:redirect=error");
  assert.ok(!m.calls.includes("sign"));
  assert.ok(!m.calls.includes("writeExclusive"));
});

test("orchestrate: execute writes the wx tombstone BEFORE signing, both legs redirect:error, settles on a valid 201", async () => {
  const m = makeDeps({ responses: [ok402, ok201] });
  const r = await postListing(params(true), m.deps);
  assert.equal(r.reason, "settled");
  assert.equal(r.listingId, 42);
  const wx = m.calls.indexOf("writeExclusive"), sg = m.calls.indexOf("sign"), wa = m.calls.indexOf("writeAtomic");
  assert.ok(wx >= 0 && wx < sg, "wx tombstone must precede sign");
  assert.ok(sg < wa, "settle must follow sign");
  assert.ok(m.calls.includes("fetch:leg2:redirect=error"));
  assert.equal(JSON.parse(m.writes.signing).status, "signing");
  assert.equal(JSON.parse(m.writes.settled).status, "settled");
});

test("orchestrate: a non-201 leaves the tombstone 'signing' and never settles", async () => {
  const m = makeDeps({ responses: [ok402, { status: 500, body: { error: "paid but failed" } }] });
  const r = await postListing(params(true), m.deps);
  assert.equal(r.reason, "leg2_not_201");
  assert.ok(m.writes.signing);
  assert.ok(!m.writes.settled);
});

test("orchestrate: a 201 lacking listing_id/fee_tx does NOT settle (Codex #3)", async () => {
  const m = makeDeps({ responses: [ok402, { status: 201, body: { ok: true } }] });
  const r = await postListing(params(true), m.deps);
  assert.equal(r.reason, "leg2_bad_body");
  assert.ok(!m.writes.settled);
});

test("orchestrate: a 201 whose fee_cents != the authorised fee does NOT settle (Codex round 2 #2)", async () => {
  const m = makeDeps({ responses: [ok402, { status: 201, body: { listing_id: 42, fee_tx: "0xabc", fee_cents: 999, bounty_cents: 1500 } }] });
  const r = await postListing(params(true), m.deps); // authorised fee is 225
  assert.equal(r.reason, "leg2_bad_body");
  assert.ok(!m.writes.settled);
});

test("orchestrate: a durable-write failure aborts before signing (tombstone_write_failed)", async () => {
  const m = makeDeps({ responses: [ok402], wxThrows: "EIO" });
  const r = await postListing(params(true), m.deps);
  assert.equal(r.reason, "tombstone_write_failed");
  assert.ok(!m.calls.includes("sign"));
  assert.ok(!m.calls.includes("fetch:leg2:redirect=error"));
});

test("orchestrate: fee over cap refuses before any fetch", async () => {
  const m = makeDeps({});
  const r = await postListing(params(true, bodyOf({ bounty_cents: 100000 })), m.deps); // $1000 -> $150 fee > $3 cap
  assert.equal(r.reason, "fee_over_cap");
  assert.deepEqual(m.calls, []);
});

test("orchestrate: sign failure aborts with the tombstone left 'signing', no leg 2", async () => {
  const m = makeDeps({ responses: [ok402], signThrows: true });
  const r = await postListing(params(true), m.deps);
  assert.equal(r.reason, "sign_failed");
  assert.ok(m.writes.signing);
  assert.ok(!m.calls.includes("fetch:leg2:redirect=error"));
});
