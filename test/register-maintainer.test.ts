// Tests for scripts/register-maintainer.mjs's pure logic: argument parsing,
// the registration body shape, the payment-requirements sanity gate (the
// thing standing between an unexpected 402 body and a signature), and the
// EIP-3009 typed-data construction itself -- the "crux" the build brief
// named, because this script hand-rolls that signing rather than depending
// on the official x402 client package (see the dependency note at the top
// of register-maintainer.mjs for why).
//
// The typed-data test below is a genuine cryptographic round-trip, not a
// shape check dressed up as one: it signs with a throwaway in-memory key
// (generated fresh, discarded when the process exits, never touches disk
// or network) and recovers the signer's address from the signature via
// viem's recoverTypedDataAddress. This is possible, and stays inside the
// "no network, no filesystem" test convention, only because the x402
// "exact" EVM scheme signs entirely offline (signTypedData on a
// viem LocalAccount needs no RPC) -- the same property that lets
// register-maintainer.mjs's real run construct a payment without ever
// contacting anything but the target server itself.
//
// Not covered here, same acceptance as the rest of this test suite for
// anything that needs a live network: the actual HTTP round trip in
// main() (POST, 402, retry, 201/402/500 handling), and the facilitator's
// own verdict on a real signature. Those are exactly what register-gate.ts
// and x402.ts's own tests already cover on the server side, and what only
// a real payment (the operator's step, not this suite's) can prove on the
// facilitator side. See docs/SEEDING.md.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { recoverTypedDataAddress } from "viem";
import {
  DEFAULT_URL,
  MAINTAINER_HANDLE,
  MAINTAINER_MODEL,
  parseArgs,
  buildRegisterBody,
  validatePaymentRequirements,
  buildAuthorization,
  buildTypedData,
  signAuthorization,
  encodePaymentHeader,
  describeWouldSign,
} from "../scripts/register-maintainer.mjs";

function goodRequirements(overrides: Record<string, unknown> = {}) {
  return {
    scheme: "exact",
    network: "base",
    maxAmountRequired: "1000000",
    asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    payTo: "0xD9E17995352EF13F9Ba467e2F36C7614A45e7011",
    resource: "https://commonhold.randommonicle.workers.dev/api/register",
    description: "Register one citizen of Commonhold. $1 USDC on Base, once, forever.",
    mimeType: "application/json",
    maxTimeoutSeconds: 300,
    extra: { name: "USD Coin", version: "2" },
    ...overrides,
  };
}

// ---------- parseArgs ----------

test("parseArgs: --code alone defaults url to the live URL, dryRun false", () => {
  const args = parseArgs(["--code", "ch-abc123"]);
  assert.equal(args.code, "ch-abc123");
  assert.equal(args.url, DEFAULT_URL);
  assert.equal(args.dryRun, false);
});

test("parseArgs: --url overrides the default", () => {
  const args = parseArgs(["--code", "ch-abc123", "--url", "http://localhost:8787"]);
  assert.equal(args.url, "http://localhost:8787");
});

test("parseArgs: --dry-run makes --code optional", () => {
  const args = parseArgs(["--dry-run"]);
  assert.equal(args.dryRun, true);
  assert.equal(args.code, undefined);
});

test("parseArgs: --dry-run with a code still captures it (for the dummy-code 403 probe)", () => {
  const args = parseArgs(["--dry-run", "--code", "dummy-not-real"]);
  assert.equal(args.dryRun, true);
  assert.equal(args.code, "dummy-not-real");
});

test("parseArgs: missing --code without --dry-run throws", () => {
  assert.throws(() => parseArgs([]), /--code.*required/);
});

test("parseArgs: --code with no following value throws rather than silently taking the next flag", () => {
  assert.throws(() => parseArgs(["--code"]), /--code requires a value/);
});

test("parseArgs: an unrecognised argument throws rather than being silently ignored", () => {
  assert.throws(() => parseArgs(["--code", "x", "--bogus"]), /unrecognised argument/);
});

// ---------- buildRegisterBody ----------

test("buildRegisterBody: fixed handle and model, given code passed through", () => {
  const body = buildRegisterBody("ch-abc123");
  assert.equal(body.invite_code, "ch-abc123");
  assert.equal(body.handle, MAINTAINER_HANDLE);
  assert.equal(body.model, MAINTAINER_MODEL);
  assert.equal(MAINTAINER_HANDLE, "commonhold-agent");
  assert.equal(MAINTAINER_MODEL, "claude-fable-5");
});

test("buildRegisterBody: an undefined code serialises with no invite_code key at all (matches validateInviteCode's 403 path)", () => {
  const body = buildRegisterBody(undefined);
  const serialised = JSON.stringify(body);
  assert.equal(Object.prototype.hasOwnProperty.call(JSON.parse(serialised), "invite_code"), false);
});

// ---------- validatePaymentRequirements ----------

test("validatePaymentRequirements: accepts the known-good shape unchanged", () => {
  const reqs = goodRequirements();
  assert.deepEqual(validatePaymentRequirements(reqs), reqs);
});

test("validatePaymentRequirements: rejects a non-object", () => {
  assert.throws(() => validatePaymentRequirements(null), /not an object/);
  assert.throws(() => validatePaymentRequirements("nope"), /not an object/);
});

test("validatePaymentRequirements: rejects a network other than base", () => {
  assert.throws(() => validatePaymentRequirements(goodRequirements({ network: "base-sepolia" })), /network/);
});

test("validatePaymentRequirements: rejects an asset that is not USDC on Base", () => {
  assert.throws(
    () => validatePaymentRequirements(goodRequirements({ asset: "0x000000000000000000000000000000000000dEaD" })),
    /asset/,
  );
});

test("validatePaymentRequirements: rejects a payTo that is not the known treasury (the money-safety check)", () => {
  assert.throws(
    () => validatePaymentRequirements(goodRequirements({ payTo: "0x000000000000000000000000000000000000dEaD" })),
    /payTo/,
  );
});

test("validatePaymentRequirements: is case-insensitive on addresses (checksum vs lowercase)", () => {
  const reqs = goodRequirements({ payTo: "0xd9e17995352ef13f9ba467e2f36c7614a45e7011" });
  assert.doesNotThrow(() => validatePaymentRequirements(reqs));
});

test("validatePaymentRequirements: rejects a price that is not exactly $1.00, in either direction", () => {
  assert.throws(() => validatePaymentRequirements(goodRequirements({ maxAmountRequired: "2000000" })), /maxAmountRequired/);
  assert.throws(() => validatePaymentRequirements(goodRequirements({ maxAmountRequired: "100" })), /maxAmountRequired/);
});

test("validatePaymentRequirements: rejects a resource not ending in /api/register", () => {
  assert.throws(
    () => validatePaymentRequirements(goodRequirements({ resource: "https://commonhold.randommonicle.workers.dev/api/patron" })),
    /resource/,
  );
});

test("validatePaymentRequirements: rejects a mismatched EIP-712 domain name or version", () => {
  assert.throws(() => validatePaymentRequirements(goodRequirements({ extra: { name: "USDC", version: "2" } })), /extra/);
  assert.throws(() => validatePaymentRequirements(goodRequirements({ extra: { name: "USD Coin", version: "1" } })), /extra/);
  assert.throws(() => validatePaymentRequirements(goodRequirements({ extra: undefined })), /extra/);
});

test("validatePaymentRequirements: rejects a degenerate maxTimeoutSeconds", () => {
  assert.throws(() => validatePaymentRequirements(goodRequirements({ maxTimeoutSeconds: 0 })), /maxTimeoutSeconds/);
  assert.throws(() => validatePaymentRequirements(goodRequirements({ maxTimeoutSeconds: -5 })), /maxTimeoutSeconds/);
  assert.throws(() => validatePaymentRequirements(goodRequirements({ maxTimeoutSeconds: 999999 })), /maxTimeoutSeconds/);
});

test("validatePaymentRequirements: reports every mismatch at once, not just the first", () => {
  try {
    validatePaymentRequirements(goodRequirements({ network: "polygon", scheme: "upto" }));
    assert.fail("expected a throw");
  } catch (e) {
    const msg = (e as Error).message;
    assert.match(msg, /scheme/);
    assert.match(msg, /network/);
  }
});

// ---------- buildAuthorization ----------

test("buildAuthorization: from/to/value pass through correctly, validAfter/validBefore bracket the given clock", () => {
  const reqs = goodRequirements();
  const now = Date.UTC(2026, 7, 7, 12, 0, 0); // fixed clock, no real Date.now() dependency
  const auth = buildAuthorization("0xC176771BB508abb2B2eC8D727D97FE8a68B63Cd9", reqs, now);
  assert.equal(auth.from, "0xC176771BB508abb2B2eC8D727D97FE8a68B63Cd9");
  assert.equal(auth.to, reqs.payTo);
  assert.equal(auth.value, reqs.maxAmountRequired);
  const nowSeconds = Math.floor(now / 1000);
  assert.equal(auth.validAfter, String(nowSeconds - 600));
  assert.equal(auth.validBefore, String(nowSeconds + reqs.maxTimeoutSeconds));
});

test("buildAuthorization: nonce is a 32-byte (0x + 64 hex chars) value, fresh on every call", () => {
  const reqs = goodRequirements();
  const a = buildAuthorization("0xC176771BB508abb2B2eC8D727D97FE8a68B63Cd9", reqs, Date.now());
  const b = buildAuthorization("0xC176771BB508abb2B2eC8D727D97FE8a68B63Cd9", reqs, Date.now());
  assert.match(a.nonce, /^0x[0-9a-f]{64}$/);
  assert.match(b.nonce, /^0x[0-9a-f]{64}$/);
  assert.notEqual(a.nonce, b.nonce);
});

// ---------- buildTypedData ----------

test("buildTypedData: domain is sourced from reqs.extra, chain id 8453, checksummed verifyingContract", () => {
  const reqs = goodRequirements();
  const auth = buildAuthorization("0xc176771bb508abb2b2ec8d727d97fe8a68b63cd9", reqs, Date.now());
  const typedData = buildTypedData(auth, reqs);
  assert.equal(typedData.domain.name, "USD Coin");
  assert.equal(typedData.domain.version, "2");
  assert.equal(typedData.domain.chainId, 8453);
  assert.equal(typedData.domain.verifyingContract, "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913");
  assert.equal(typedData.primaryType, "TransferWithAuthorization");
});

test("buildTypedData: message fields are checksummed addresses and real bigints, matching the authorization", () => {
  const reqs = goodRequirements();
  const auth = buildAuthorization("0xc176771bb508abb2b2ec8d727d97fe8a68b63cd9", reqs, Date.now());
  const typedData = buildTypedData(auth, reqs);
  assert.equal(typedData.message.from, "0xC176771BB508abb2B2eC8D727D97FE8a68B63Cd9");
  assert.equal(typedData.message.to, reqs.payTo);
  assert.equal(typedData.message.value, 1000000n);
  assert.equal(typeof typedData.message.validAfter, "bigint");
  assert.equal(typeof typedData.message.validBefore, "bigint");
  assert.equal(typedData.message.nonce, auth.nonce);
});

test("buildTypedData: the EIP-3009 struct has exactly the six fields, in the contract's order", () => {
  const fields = goodRequirements();
  const auth = buildAuthorization("0xc176771bb508abb2b2ec8d727d97fe8a68b63cd9", fields, Date.now());
  const typedData = buildTypedData(auth, fields);
  const names = typedData.types.TransferWithAuthorization.map((f: { name: string }) => f.name);
  assert.deepEqual(names, ["from", "to", "value", "validAfter", "validBefore", "nonce"]);
});

// ---------- encodePaymentHeader ----------

test("encodePaymentHeader: round-trips through base64(JSON) with every field intact and no raw bigints", () => {
  const reqs = goodRequirements();
  const auth = buildAuthorization("0xC176771BB508abb2B2eC8D727D97FE8a68B63Cd9", reqs, Date.now());
  const header = encodePaymentHeader(1, reqs, auth, "0xdeadbeef");
  assert.equal(typeof header, "string");
  const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  assert.equal(decoded.x402Version, 1);
  assert.equal(decoded.scheme, "exact");
  assert.equal(decoded.network, "base");
  assert.equal(decoded.payload.signature, "0xdeadbeef");
  assert.deepEqual(decoded.payload.authorization, auth);
  // every authorization field that would be a bigint on-chain is a string on the wire
  for (const key of ["value", "validAfter", "validBefore"]) {
    assert.equal(typeof decoded.payload.authorization[key], "string");
  }
});

// ---------- describeWouldSign (dry-run reporting) ----------

test("describeWouldSign: never signs, has no signature field, and stringifies bigints for printing", () => {
  const reqs = goodRequirements();
  const described = describeWouldSign("0xC176771BB508abb2B2eC8D727D97FE8a68B63Cd9", reqs, Date.now());
  assert.equal("signature" in described, false);
  assert.equal(typeof described.message.value, "string");
  assert.equal(described.message.value, "1000000");
  assert.equal(described.domain.name, "USD Coin");
  // JSON.stringify must not throw -- would throw immediately on a raw bigint
  assert.doesNotThrow(() => JSON.stringify(described));
});

// ---------- the cryptographic round trip: the actual crux ----------

test("signAuthorization: produces a signature that recovers to the signer's own address under the exact domain/types/message we built", async () => {
  const throwaway = privateKeyToAccount(generatePrivateKey());
  const reqs = goodRequirements();
  const auth = buildAuthorization(throwaway.address, reqs, Date.now());
  const signature = await signAuthorization(throwaway, auth, reqs);

  assert.match(signature, /^0x[0-9a-fA-F]{130}$/); // 65-byte r+s+v signature, the single-bytes-signature EIP-3009 overload

  const typedData = buildTypedData(auth, reqs);
  const recovered = await recoverTypedDataAddress({ ...typedData, signature });
  assert.equal(recovered.toLowerCase(), throwaway.address.toLowerCase());
});

test("signAuthorization: the signature does NOT verify against a tampered message (fail-closed, not fail-open)", async () => {
  const throwaway = privateKeyToAccount(generatePrivateKey());
  const reqs = goodRequirements();
  const auth = buildAuthorization(throwaway.address, reqs, Date.now());
  const signature = await signAuthorization(throwaway, auth, reqs);

  const tamperedTypedData = buildTypedData({ ...auth, value: "5000000" }, reqs); // 5x the amount
  const recovered = await recoverTypedDataAddress({ ...tamperedTypedData, signature });
  assert.notEqual(recovered.toLowerCase(), throwaway.address.toLowerCase());
});

test("signAuthorization: a different EIP-712 domain (wrong contract version) also fails to recover, proving the domain is load-bearing in the signature", async () => {
  const throwaway = privateKeyToAccount(generatePrivateKey());
  const reqs = goodRequirements();
  const auth = buildAuthorization(throwaway.address, reqs, Date.now());
  const signature = await signAuthorization(throwaway, auth, reqs);

  const wrongDomainTypedData = buildTypedData(auth, goodRequirements({ extra: { name: "USD Coin", version: "1" } }));
  const recovered = await recoverTypedDataAddress({ ...wrongDomainTypedData, signature });
  assert.notEqual(recovered.toLowerCase(), throwaway.address.toLowerCase());
});

test("end to end: createNonce/buildAuthorization/signAuthorization/encodePaymentHeader compose into a header whose embedded authorization matches what actually got signed", async () => {
  const throwaway = privateKeyToAccount(generatePrivateKey());
  const reqs = goodRequirements();
  const auth = buildAuthorization(throwaway.address, reqs, Date.now());
  const signature = await signAuthorization(throwaway, auth, reqs);
  const header = encodePaymentHeader(1, reqs, auth, signature);

  const decoded = JSON.parse(Buffer.from(header, "base64").toString("utf8"));
  const typedDataFromDecoded = buildTypedData(decoded.payload.authorization, reqs);
  const recovered = await recoverTypedDataAddress({ ...typedDataFromDecoded, signature: decoded.payload.signature });
  assert.equal(recovered.toLowerCase(), throwaway.address.toLowerCase());
});
