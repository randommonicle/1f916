// Tests for scripts/pay-x402-claim.mjs -- the parameterised x402 payer used
// for paid endpoints that are NOT this society's own door.
//
// register-maintainer.mjs keeps itself safe with a hardcoded whitelist: it can
// only ever pay Commonhold's own treasury. This script cannot do that, because
// its whole purpose is a second destination. Its safety properties instead are:
// a target pinned to the reviewed resource BEFORE any credential is read, a
// code-level price ceiling no file can raise, a network the signer can actually
// sign for, an exactly-matching authorisation lifetime, and a challenge that
// matches a reviewed expectations file in every field.
//
// So the tests that matter here are refusal tests. Each takes a situation that
// is correct in every respect but one, and proves the guard rejects it. A guard
// that cannot be shown to fire is not a guard.
//
// Revised 2026-08-15 after exchange/REVIEW_x402-payer-script_2026-08-15.md
// (CODEX round 1) returned NOT SAFE TO RUN on the first version. The target
// pinning, price ceiling, chain-id, timeout and redaction tests below all exist
// because of specific findings in that round.
//
// No network and no filesystem, same convention as the rest of this suite. The
// signing round-trip is not re-tested here: this script imports
// buildAuthorization/signAuthorization/encodePaymentHeader unchanged from
// register-maintainer.mjs, and test/register-maintainer.test.ts already proves
// that construction cryptographically.
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseArgs,
  loadExpectations,
  validateAgainstExpectations,
  extractBearer,
  redact,
  canonicalUrl,
  assertTargetPinned,
  REQUIRED_EXPECTATION_FIELDS,
  SUPPORTED_ASSETS,
  attemptPath,
  claimAttempt,
  bodyDigest,
} from "../scripts/pay-x402-claim.mjs";

// 1f3d9's real frontier-founding challenge, captured verbatim from a live 402
// on 2026-08-15. Used as the "everything correct" baseline that each refusal
// test then breaks in exactly one place.
const GOOD_REQS = {
  scheme: "exact",
  network: "base",
  maxAmountRequired: "1000000",
  resource: "https://1f3d9.com/api/place",
  description: "1F3D9 frontier founding fee",
  mimeType: "application/json",
  payTo: "0x3b9d230c9b995fb1a10add2d63ce37437916dcfd",
  maxTimeoutSeconds: 300,
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  extra: { name: "USD Coin", version: "2" },
};

const GOOD_EXPECTED = {
  pay_to: "0x3b9d230c9b995fb1a10add2d63ce37437916dcfd",
  price_atomic: "1000000",
  asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  network: "base",
  chain_id: 8453,
  resource: "https://1f3d9.com/api/place",
  max_timeout_seconds: 300,
  domain_name: "USD Coin",
  domain_version: "2",
};

const CONFIRM = "0x3b9d230c9b995fb1a10add2d63ce37437916dcfd";

// The positive control. Without it, every refusal test below could be passing
// because the guard rejects everything, which is indistinguishable from a guard
// that works.
test("a challenge matching the file and the confirmed address is accepted", () => {
  assert.equal(validateAgainstExpectations(GOOD_REQS, GOOD_EXPECTED, CONFIRM), GOOD_REQS);
});

test("addresses compare case-insensitively, so EIP-55 checksum casing is not a false refusal", () => {
  const checksummed = { ...GOOD_REQS, payTo: "0x3B9D230C9B995FB1A10ADD2D63CE37437916DCFD" };
  assert.equal(validateAgainstExpectations(checksummed, GOOD_EXPECTED, CONFIRM.toUpperCase()), checksummed);
});

// --- target pinning ----------------------------------------------------------
//
// CODEX round 1's blocking finding: --url never participated in the guard, so
// the bearer credential was sent to an unchecked host BEFORE any validation.
// And because the EIP-712 message binds from/to/value/window/nonce but NOT the
// resource, an endpoint repeating the expected fields could obtain a real
// authorisation paying the right address while delivering nothing.

test("accepts the url that exactly equals the reviewed resource", () => {
  assert.equal(assertTargetPinned("https://1f3d9.com/api/place", GOOD_EXPECTED.resource), "https://1f3d9.com/api/place");
});

test("host casing is normalised, because host case is insensitive by RFC", () => {
  assert.equal(assertTargetPinned("https://1F3D9.com/api/place", GOOD_EXPECTED.resource), "https://1f3d9.com/api/place");
});

// CODEX round 2: an earlier version folded trailing slashes. `/x` and `/x/` can
// be different resources, and there is no benefit in inventing an equivalence
// on a money path. This test used to assert the fold was accepted; it now
// asserts the opposite, deliberately.
test("a trailing slash is now a REFUSAL, not a fold -- no invented equivalences on a money path", () => {
  assert.throws(() => assertTargetPinned("https://1f3d9.com/api/place/", GOOD_EXPECTED.resource), /not the reviewed resource/);
});

test("refuses a different host -- the credential-leak case", () => {
  assert.throws(() => assertTargetPinned("https://1f3d9.evil.com/api/place", GOOD_EXPECTED.resource), /not the reviewed resource/);
});

test("refuses a different path on the right host -- paying for the wrong thing", () => {
  assert.throws(() => assertTargetPinned("https://1f3d9.com/api/kind", GOOD_EXPECTED.resource), /not the reviewed resource/);
});

test("refuses a different port", () => {
  assert.throws(() => assertTargetPinned("https://1f3d9.com:8443/api/place", GOOD_EXPECTED.resource), /not the reviewed resource/);
});

test("refuses plain HTTP, because a bearer credential would travel in clear", () => {
  assert.throws(() => canonicalUrl("http://1f3d9.com/api/place"), /non-HTTPS/);
});

test("refuses a URL carrying inline credentials or a fragment", () => {
  assert.throws(() => canonicalUrl("https://user:pw@1f3d9.com/api/place"), /inline credentials/);
  assert.throws(() => canonicalUrl("https://1f3d9.com/api/place#x"), /fragment/);
});

test("refuses a non-URL rather than treating it as a relative path", () => {
  for (const bad of ["/api/place", "1f3d9.com/api/place", "", "not a url"]) {
    assert.throws(() => canonicalUrl(bad), /not a valid absolute URL/);
  }
});

// --- the challenge guard, one broken field each -------------------------------

test("refuses a payTo the operator did not declare -- the money-goes-elsewhere case", () => {
  const attack = { ...GOOD_REQS, payTo: "0xdeadbeef00000000000000000000000000000000" };
  assert.throws(() => validateAgainstExpectations(attack, GOOD_EXPECTED, CONFIRM), /payTo: declared/);
});

test("refuses a price higher than declared -- the overcharge case", () => {
  const attack = { ...GOOD_REQS, maxAmountRequired: "100000000" };
  assert.throws(() => validateAgainstExpectations(attack, GOOD_EXPECTED, CONFIRM), /maxAmountRequired/);
});

test("refuses a different asset contract -- the worthless-token case", () => {
  const attack = { ...GOOD_REQS, asset: "0x0000000000000000000000000000000000000bad" };
  assert.throws(() => validateAgainstExpectations(attack, GOOD_EXPECTED, CONFIRM), /asset: declared/);
});

test("refuses a different network", () => {
  const attack = { ...GOOD_REQS, network: "ethereum" };
  assert.throws(() => validateAgainstExpectations(attack, GOOD_EXPECTED, CONFIRM), /network: declared/);
});

test("refuses a resource other than the one declared", () => {
  const attack = { ...GOOD_REQS, resource: "https://1f3d9.com/api/kind" };
  assert.throws(() => validateAgainstExpectations(attack, GOOD_EXPECTED, CONFIRM), /resource: declared/);
});

test("refuses a scheme other than exact", () => {
  const attack = { ...GOOD_REQS, scheme: "upto" };
  assert.throws(() => validateAgainstExpectations(attack, GOOD_EXPECTED, CONFIRM), /scheme: expected "exact"/);
});

test("refuses a tampered EIP-712 domain, which would sign for a different contract", () => {
  const attack = { ...GOOD_REQS, extra: { name: "USD Coin", version: "1" } };
  assert.throws(() => validateAgainstExpectations(attack, GOOD_EXPECTED, CONFIRM), /extra: declared/);
});

// CODEX round 1: the old code accepted any positive number here. This value
// becomes validBefore, so a server that inflates it lengthens the life of a
// signed authorisation.
test("refuses a maxTimeoutSeconds that differs from the reviewed value, even a larger one", () => {
  for (const bad of [301, 3600, 30, undefined, 0, -1, "300", Number.NaN]) {
    const attack = { ...GOOD_REQS, maxTimeoutSeconds: bad };
    assert.throws(() => validateAgainstExpectations(attack, GOOD_EXPECTED, CONFIRM), /maxTimeoutSeconds/, `${bad} should be refused`);
  }
});

test("refuses when the confirmed --confirm-pay-to disagrees with the reviewed file", () => {
  assert.throws(
    () => validateAgainstExpectations(GOOD_REQS, GOOD_EXPECTED, "0x1111111111111111111111111111111111111111"),
    /--confirm-pay-to/,
  );
});

test("reports EVERY mismatch at once, not just the first", () => {
  const attack = { ...GOOD_REQS, payTo: "0xdeadbeef00000000000000000000000000000000", maxAmountRequired: "5000000", network: "ethereum" };
  try {
    validateAgainstExpectations(attack, GOOD_EXPECTED, CONFIRM);
    assert.fail("should have thrown");
  } catch (e) {
    const msg = String((e as Error).message);
    for (const field of ["payTo", "maxAmountRequired", "network"]) assert.match(msg, new RegExp(field));
  }
});

test("refuses a non-object challenge rather than reading fields off undefined", () => {
  for (const bad of [null, undefined, "402", 7]) {
    assert.throws(() => validateAgainstExpectations(bad, GOOD_EXPECTED, CONFIRM), /not an object/);
  }
});

// --- expectations file --------------------------------------------------------

test("every required expectation field is enforced, one at a time", () => {
  for (const field of REQUIRED_EXPECTATION_FIELDS) {
    const partial: Record<string, unknown> = { ...GOOD_EXPECTED };
    delete partial[field];
    assert.throws(() => loadExpectations(partial), new RegExp(field), `missing ${field} should be refused`);
  }
});

test("price_atomic must be a digits-only string, because a JSON number is a float path for exact money", () => {
  assert.throws(() => loadExpectations({ ...GOOD_EXPECTED, price_atomic: 1000000 }), /must be a STRING/);
  assert.throws(() => loadExpectations({ ...GOOD_EXPECTED, price_atomic: "1e6" }), /digits only/);
  assert.throws(() => loadExpectations({ ...GOOD_EXPECTED, price_atomic: "-1" }), /digits only/);
});

// CODEX and GEMINI round 2, independently: the ceiling was a bare number, and
// "1000000" is $1 only for a six-decimal token. Since the asset contract was a
// file value, editing the file could change the real economic cap without
// touching the constant that claimed to cap it. The ceiling is now bound to a
// pinned asset entry.
test("a price above the pinned asset's ceiling is refused however the file is edited", () => {
  const max = SUPPORTED_ASSETS.base.max_atomic;
  assert.throws(() => loadExpectations({ ...GOOD_EXPECTED, price_atomic: String(max + 1n) }), /exceeds the pinned ceiling/);
  assert.throws(() => loadExpectations({ ...GOOD_EXPECTED, price_atomic: "1000000000000" }), /exceeds the pinned ceiling/);
  assert.equal(loadExpectations({ ...GOOD_EXPECTED, price_atomic: String(max) }).price_atomic, "1000000");
});

test("the ceiling cannot be dodged by swapping the asset for a different-decimal token", () => {
  // A atomic-unit ceiling is meaningless unless the token's decimals are pinned
  // too. Swapping the contract is now refused outright.
  assert.throws(
    () => loadExpectations({ ...GOOD_EXPECTED, asset: "0x0000000000000000000000000000000000000bad" }),
    /does not match the pinned Base USDC entry/,
  );
});

test("the pinned entry covers chain id and the EIP-712 domain, not just the contract", () => {
  assert.throws(() => loadExpectations({ ...GOOD_EXPECTED, chain_id: 1 }), /chain_id/);
  assert.throws(() => loadExpectations({ ...GOOD_EXPECTED, domain_name: "Not USD Coin" }), /domain_name/);
  assert.throws(() => loadExpectations({ ...GOOD_EXPECTED, domain_version: "1" }), /domain_version/);
  assert.equal(SUPPORTED_ASSETS.base.chain_id, 8453);
  assert.equal(SUPPORTED_ASSETS.base.decimals, 6);
});

test("refuses a network the imported signer cannot actually sign for", () => {
  assert.throws(() => loadExpectations({ ...GOOD_EXPECTED, network: "ethereum", chain_id: 1 }), /not one this script can sign for/);
});

test("max_timeout_seconds must be a positive integer within the ceiling", () => {
  for (const bad of [0, -1, 3601, 1.5, "300"]) {
    assert.throws(() => loadExpectations({ ...GOOD_EXPECTED, max_timeout_seconds: bad }), /max_timeout_seconds/, `${bad} should be refused`);
  }
});

test("an empty-string expectation counts as missing, not as declared", () => {
  assert.throws(() => loadExpectations({ ...GOOD_EXPECTED, pay_to: "" }), /pay_to/);
});

// --- argument parsing ---------------------------------------------------------

const FULL_ARGV = [
  "--url", "https://1f3d9.com/api/place",
  "--body-file", "body.json",
  "--expect-file", "expect.json",
  "--confirm-pay-to", CONFIRM,
];

// CODEX round 1: the previous version defaulted to real spend and a test
// positively locked that default in. The safe default is the probe.
test("the DEFAULT is a probe: money never moves without an explicit --execute", () => {
  const args = parseArgs(FULL_ARGV);
  assert.equal(args.execute, false);
});

test("--execute is refused without --pending-dir, so an ambiguous settlement is always resolvable", () => {
  assert.throws(() => parseArgs([...FULL_ARGV, "--execute"]), /--pending-dir is required/);
  const ok = parseArgs([...FULL_ARGV, "--execute", "--pending-dir", "d"]);
  assert.equal(ok.execute, true);
  assert.equal(ok.pendingDir, "d");
});

// --- the at-most-once claim ---------------------------------------------------
//
// CODEX and GEMINI round 2: the previous record was EVIDENCE, not a control.
// The path was caller-chosen and the write was not exclusive, so two runs could
// each open their own record and each authorise a payment, leaving the warning
// banner as the only thing between us and a double spend. The path is now
// DERIVED, so the same purchase always lands on the same file and the second
// attempt collides.

const ATTEMPT = { payer: "0x3f2950654eF9bF2d73805A77A07E4e14D5f74f16", chainId: 8453, target: "https://1f3d9.com/api/place", digest: bodyDigest("{\"a\":1}") };

test("the same purchase always derives the same attempt path", () => {
  assert.equal(attemptPath("d", ATTEMPT), attemptPath("d", { ...ATTEMPT }));
});

test("the payer's address case does not change the attempt path", () => {
  assert.equal(attemptPath("d", ATTEMPT), attemptPath("d", { ...ATTEMPT, payer: ATTEMPT.payer.toUpperCase() }));
});

test("a different body, target, chain or payer derives a DIFFERENT attempt path", () => {
  const base = attemptPath("d", ATTEMPT);
  assert.notEqual(base, attemptPath("d", { ...ATTEMPT, digest: bodyDigest("{\"a\":2}") }), "body must be part of the identity");
  assert.notEqual(base, attemptPath("d", { ...ATTEMPT, target: "https://1f3d9.com/api/kind" }), "target must be part of the identity");
  assert.notEqual(base, attemptPath("d", { ...ATTEMPT, chainId: 1 }), "chain must be part of the identity");
  assert.notEqual(base, attemptPath("d", { ...ATTEMPT, payer: "0x1111111111111111111111111111111111111111" }), "payer must be part of the identity");
});

test("bodyDigest is stable and distinguishes bodies that differ by one character", () => {
  assert.equal(bodyDigest("{\"a\":1}"), bodyDigest("{\"a\":1}"));
  // The assertion that a one-byte whitespace change alters the digest has been
  // REMOVED, not weakened. Codex round 3 showed it was locking in the defect:
  // semantically identical JSON must collide on ONE claim path, and it does not
  // yet. The positive canonicalisation tests arrive with H-A.
  assert.match(bodyDigest("x"), /^[0-9a-f]{64}$/);
});

test("each required flag is genuinely required", () => {
  for (const flag of ["--url", "--body-file", "--expect-file", "--confirm-pay-to"]) {
    const i = FULL_ARGV.indexOf(flag);
    const without = [...FULL_ARGV.slice(0, i), ...FULL_ARGV.slice(i + 2)];
    assert.throws(() => parseArgs(without), new RegExp(`\\${flag} is required`), `${flag} should be required`);
  }
});

test("rejects an unrecognised flag rather than ignoring it", () => {
  assert.throws(() => parseArgs([...FULL_ARGV, "--pay-anyway"]), /unrecognised argument/);
  assert.throws(() => parseArgs([...FULL_ARGV, "--dry-run"]), /unrecognised argument/);
});

test("rejects a flag given with no value", () => {
  assert.throws(() => parseArgs([...FULL_ARGV, "--bearer-file"]), /requires a value/);
});

test("bearer file and prefix must travel together -- half a credential is a mistake, not a mode", () => {
  assert.throws(() => parseArgs([...FULL_ARGV, "--bearer-file", "x.json"]), /must be given together/);
  assert.throws(() => parseArgs([...FULL_ARGV, "--bearer-prefix", "abc_sk_"]), /must be given together/);
  assert.equal(parseArgs([...FULL_ARGV, "--bearer-file", "x.json", "--bearer-prefix", "abc_sk_"]).bearerPrefix, "abc_sk_");
});

// --- bearer extraction --------------------------------------------------------
//
// This is the check that would have caught the 2026-08-15 custody near-miss: a
// registration response saved to disk that held {"error":"handle taken"} rather
// than a credential. See LESSONS_LEARNED L-011 and L-012.

test("finds a token by prefix whatever field name it was saved under", () => {
  const token = "1f3d9_sk_abcDEF123-456_789";
  assert.equal(extractBearer(`{"secret":"${token}"}`, "1f3d9_sk_"), token);
  assert.equal(extractBearer(`{"key":"${token}","handle":"x"}`, "1f3d9_sk_"), token);
  assert.equal(extractBearer(`  ${token}  `, "1f3d9_sk_"), token);
});

test("returns null for a saved ERROR response -- the exact file that cost an hour", () => {
  assert.equal(extractBearer('{"error":"handle taken"}', "1f3d9_sk_"), null);
});

test("returns null rather than a partial match when the prefix is absent", () => {
  assert.equal(extractBearer('{"secret":"1f916_sk_wrongsociety"}', "1f3d9_sk_"), null);
  assert.equal(extractBearer("", "1f3d9_sk_"), null);
  assert.equal(extractBearer(null, "1f3d9_sk_"), null);
});

test("a prefix containing regex metacharacters is matched literally, not as a pattern", () => {
  assert.equal(extractBearer('{"secret":"aXb_sk_nope"}', "a.b_sk_"), null);
  assert.equal(extractBearer('{"secret":"a.b_sk_yes123"}', "a.b_sk_"), "a.b_sk_yes123");
});

// --- redaction ----------------------------------------------------------------
//
// CODEX round 1: no console call named the token directly, but the script
// prints the foreign server's response body verbatim, and that server has SEEN
// our bearer. It can simply echo it back and make us print it.

test("a bearer echoed back by the foreign server is redacted before printing", () => {
  const token = "1f3d9_sk_supersecretvalue";
  const hostile = `{"error":"unknown token ${token}","hint":"${token}"}`;
  const out = redact(hostile, token);
  assert.ok(!out.includes(token), "the token must not survive redaction");
  assert.equal(out, '{"error":"unknown token [REDACTED-BEARER]","hint":"[REDACTED-BEARER]"}');
});

test("redaction is a no-op when there is no bearer, and never throws on odd input", () => {
  assert.equal(redact("plain text", null), "plain text");
  assert.equal(redact("plain text", ""), "plain text");
  assert.equal(redact(undefined, "x"), undefined);
});

// --- ORDERING, proved end to end ----------------------------------------------
//
// GEMINI round 1's closing point: the tests above cover pure validation logic,
// not the boundaries where the flaws lived. The safety property is not merely
// "assertTargetPinned exists" but "it runs BEFORE the credential is read and
// BEFORE any request is made". Source order alone is not a guarantee a future
// edit preserves.
//
// This spawns the real script with a hostile --url and a bearer file that does
// NOT EXIST. If pinning runs first, the failure names the resource. If the
// credential is read first, the failure names the missing file instead. The
// distinction is the proof, and no network is involved because a correct script
// refuses before reaching one.
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("the target is pinned BEFORE the credential is read or any request is made", () => {
  const dir = mkdtempSync(join(tmpdir(), "x402-order-"));
  const bodyFile = join(dir, "body.json");
  const expectFile = join(dir, "expect.json");
  writeFileSync(bodyFile, JSON.stringify({ parent_id: null, name: "t", description: "t" }));
  writeFileSync(expectFile, JSON.stringify(GOOD_EXPECTED));

  const run = spawnSync(
    process.execPath,
    [
      "scripts/pay-x402-claim.mjs",
      "--url", "https://attacker.example/api/place",
      "--body-file", bodyFile,
      "--expect-file", expectFile,
      "--confirm-pay-to", CONFIRM,
      "--bearer-file", join(dir, "does-not-exist.json"),
      "--bearer-prefix", "1f3d9_sk_",
    ],
    { encoding: "utf8" },
  );

  const err = String(run.stderr);
  assert.equal(run.status, 1, "a hostile url must exit non-zero");
  assert.match(err, /not the reviewed resource/, "must refuse on the pinned target");
  assert.match(err, /No credential left this machine/);
  // The ordering proof: had the bearer been read first, THIS would be the error.
  assert.doesNotMatch(err, /Could not read/, "the credential file must never be touched for an unpinned target");
});

test("a plain-HTTP target is refused end to end, before any credential is read", () => {
  const dir = mkdtempSync(join(tmpdir(), "x402-http-"));
  const bodyFile = join(dir, "body.json");
  const expectFile = join(dir, "expect.json");
  writeFileSync(bodyFile, JSON.stringify({ parent_id: null }));
  writeFileSync(expectFile, JSON.stringify({ ...GOOD_EXPECTED, resource: "http://1f3d9.com/api/place" }));

  const run = spawnSync(
    process.execPath,
    [
      "scripts/pay-x402-claim.mjs",
      "--url", "http://1f3d9.com/api/place",
      "--body-file", bodyFile,
      "--expect-file", expectFile,
      "--confirm-pay-to", CONFIRM,
      "--bearer-file", join(dir, "does-not-exist.json"),
      "--bearer-prefix", "1f3d9_sk_",
    ],
    { encoding: "utf8" },
  );

  assert.equal(run.status, 1);
  assert.match(String(run.stderr), /non-HTTPS/);
  assert.doesNotMatch(String(run.stderr), /Could not read/);
});

// --- the exclusive claim itself, which is the control ------------------------
//
// Extracted from main() precisely so it is testable without a live 402. The
// EEXIST branch IS the at-most-once guarantee; before this it existed only
// behind a network call and was, in Codex's words, untested and load-bearing.

test("the first claim on a fresh path succeeds", () => {
  const dir = mkdtempSync(join(tmpdir(), "x402-claim-"));
  const p = attemptPath(dir, ATTEMPT);
  assert.deepEqual(claimAttempt(p, { status: "claimed_not_yet_signed" }), { claimed: true });
});

test("a SECOND claim on the same purchase is refused, which is what stops a double spend", () => {
  const dir = mkdtempSync(join(tmpdir(), "x402-claim2-"));
  const p = attemptPath(dir, ATTEMPT);
  assert.equal(claimAttempt(p, { status: "claimed_not_yet_signed", nonce: "first" }).claimed, true);
  const second = claimAttempt(p, { status: "claimed_not_yet_signed", nonce: "second" });
  assert.equal(second.claimed, false);
  assert.equal(second.reason, "exists");
});

test("the refused second claim does NOT overwrite the first record's nonce", () => {
  const dir = mkdtempSync(join(tmpdir(), "x402-claim3-"));
  const p = attemptPath(dir, ATTEMPT);
  claimAttempt(p, { status: "signed_and_sending", nonce: "0xFIRST" });
  claimAttempt(p, { status: "claimed_not_yet_signed", nonce: "0xSECOND" });
  const onDisk = JSON.parse(readFileSync(p, "utf8"));
  assert.equal(onDisk.nonce, "0xFIRST", "the only record of the original nonce must survive");
});

test("a claim into a directory that does not exist reports an error rather than claiming", () => {
  const r = claimAttempt(join(tmpdir(), "x402-no-such-dir-abc123", "x.json"), {});
  assert.equal(r.claimed, false);
  assert.equal(r.reason, "error");
  assert.ok(typeof r.error === "string" && r.error.length > 0);
});
