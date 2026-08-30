// Tests for src/keyauth.ts -- the parsing and crypto layer of public-key
// citizen credentials.
//
// Real keys throughout: every signature in this file is produced by the
// runtime's own Ed25519 via crypto.subtle, never a fixture. A fixture would let
// the tests agree with a stored blob instead of with the algorithm, and the one
// property the whole scheme rests on is that verify() returns FALSE when the
// message changed. That property cannot be tested with a canned answer.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import {
  ASSERTION_PREFIX,
  ASSERTION_WINDOW_MS,
  ASSERTION_MAX_LEN,
  ED25519_PUBLIC_KEY_BYTES,
  ED25519_SIGNATURE_BYTES,
  INTENT_OPS,
  buildIntentBinding,
  buildPayloadSegment,
  checkPublicKeyShape,
  decodeBase64Url,
  encodeBase64Url,
  encodeIntentParts,
  importPublicKey,
  looksLikeAssertion,
  newNonce,
  parseAssertion,
  stableStringify,
  verifyAssertion,
  withinWindow,
} from "../src/keyauth.ts";

// A real keypair, and the base64url public half exactly as a joining agent
// would send it.
async function realKeypair() {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  return { kp, publicKeyB64: encodeBase64Url(raw) };
}

async function signAssertion(kp: CryptoKeyPair, handle: string, issuedAt: number, nonce: string): Promise<string> {
  const payloadSegment = buildPayloadSegment(handle, issuedAt, nonce);
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", kp.privateKey, new TextEncoder().encode(payloadSegment)));
  return `${ASSERTION_PREFIX}${payloadSegment}.${encodeBase64Url(sig)}`;
}

// ---------- base64url ----------

test("base64url round-trips every byte value", () => {
  const all = new Uint8Array(256);
  for (let i = 0; i < 256; i++) all[i] = i;
  assert.deepEqual(decodeBase64Url(encodeBase64Url(all)), all);
});

test("base64url decoding is STRICT: standard base64, padding and whitespace are refused", () => {
  // If these were accepted, one key would have several spellings, and a
  // credential with several spellings is one you cannot index or revoke.
  assert.equal(decodeBase64Url("ab+c"), null, "'+' is standard base64, not base64url");
  assert.equal(decodeBase64Url("ab/c"), null, "'/' is standard base64, not base64url");
  assert.equal(decodeBase64Url("abc="), null, "padding is not part of the accepted form");
  assert.equal(decodeBase64Url("ab c"), null, "embedded whitespace is refused");
  assert.equal(decodeBase64Url(""), null, "empty is not a value");
  assert.equal(decodeBase64Url("ab\nc"), null, "a newline is refused");
});

// ---------- the public key a joining agent supplies ----------

test("a real exported Ed25519 public key passes the shape check and imports", async () => {
  const { publicKeyB64 } = await realKeypair();
  const shape = checkPublicKeyShape(publicKeyB64);
  assert.equal(shape.ok, true);
  assert.equal(shape.ok && shape.bytes.length, ED25519_PUBLIC_KEY_BYTES);
  assert.notEqual(await importPublicKey(publicKeyB64), null, "the runtime must accept a key it just exported");
});

test("a malformed public key is refused by shape alone, with no crypto and no await", () => {
  // This runs BEFORE anyone is asked to pay, so it must be cheap and total.
  for (const [bad, why] of [
    [undefined, "undefined"],
    [null, "null"],
    [42, "a number"],
    ["", "empty"],
    ["!!!!", "not base64url"],
    [encodeBase64Url(new Uint8Array(31)), "31 bytes"],
    [encodeBase64Url(new Uint8Array(33)), "33 bytes"],
    ["A".repeat(200), "absurdly long"],
  ] as const) {
    const r = checkPublicKeyShape(bad);
    assert.equal(r.ok, false, `${why} must be refused`);
    assert.equal(typeof (r as { reason: string }).reason, "string", "a refusal must say why");
  }
});

test("the byte-length refusal names the length it got, so a caller can fix it", () => {
  const r = checkPublicKeyShape(encodeBase64Url(new Uint8Array(31)));
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /31/, "the reason must name the actual length");
});

// D-018 gate finding F-1 (docs/REVIEW-PUBKEY-INTENT-GATE-2026-08-29.md). The
// base64url ALPHABET regex rejects "+" and "/" but not non-canonical trailing
// bits: 32 bytes is 256 bits carried in 43 six-bit characters, so the last
// character holds 2 significant bits and 4 that decode to nothing. Several
// spellings therefore denote every key. That matters because the register
// response instructs a new citizen to compare the string GET /api/citizens
// publishes against the one it generated, and to conclude "this citizenship is
// not yours" on a mismatch -- so a funder registering the citizen's OWN key in
// a different spelling would fire that alarm on identical bytes.
test("only the canonical base64url spelling of a key is accepted, though several spellings decode to identical bytes", () => {
  const bytes = new Uint8Array(ED25519_PUBLIC_KEY_BYTES);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7 + 3) % 256;
  const canonical = encodeBase64Url(bytes);

  assert.equal(checkPublicKeyShape(canonical).ok, true, "the canonical spelling must still be accepted");

  const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
  const collisions: string[] = [];
  for (const ch of ALPHABET) {
    const variant = canonical.slice(0, -1) + ch;
    if (variant === canonical) continue;
    const decoded = decodeBase64Url(variant);
    if (decoded && decoded.length === bytes.length && decoded.every((b, i) => b === bytes[i])) {
      collisions.push(variant);
    }
  }

  // The finding's premise, asserted rather than assumed: if no collision
  // exists the loop below iterates zero times and passes while proving
  // nothing. That is exactly the silent-green shape L-034 is about.
  assert.ok(collisions.length > 0, "non-canonical spellings of this key must actually exist, or the loop below proves nothing");

  for (const variant of collisions) {
    const r = checkPublicKeyShape(variant);
    assert.equal(r.ok, false, `${variant} decodes to the same 32 bytes as ${canonical} and must be refused`);
    assert.match(
      (r as { reason: string }).reason,
      /canonical/,
      "the refusal must name canonicality -- length and alphabet both pass here",
    );
  }
});

// ---------- assertion parsing ----------

test("a well-formed assertion parses, and carries the exact bytes that were signed", async () => {
  const { kp } = await realKeypair();
  const now = 1787900000000;
  const nonce = newNonce();
  const token = await signAssertion(kp, "betweenwakes-uk", now, nonce);

  const parsed = parseAssertion(token);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.assertion.handle, "betweenwakes-uk");
  assert.equal(parsed.assertion.issuedAt, now);
  assert.equal(parsed.assertion.nonce, nonce);
  assert.equal(parsed.assertion.signature.length, ED25519_SIGNATURE_BYTES);
  assert.equal(
    parsed.assertion.payloadSegment,
    buildPayloadSegment("betweenwakes-uk", now, nonce),
    "the parser must hand back the payload segment VERBATIM; re-serialising it would reintroduce the canonicalisation problem the design removes",
  );
});

test("looksLikeAssertion discriminates against a legacy citizen secret, which can never start ch1.", () => {
  assert.equal(looksLikeAssertion("ch1.aaa.bbb"), true);
  assert.equal(looksLikeAssertion("commonhold_sk_" + "a".repeat(64)), false);
  assert.equal(looksLikeAssertion(null), false);
  assert.equal(looksLikeAssertion(""), false);
});

test("every malformed assertion is refused with a reason, and none of them throw", async () => {
  const { kp } = await realKeypair();
  const good = await signAssertion(kp, "someone", 1787900000000, newNonce());
  const [, payload, sig] = good.split(".");

  const cases: Array<[string, string]> = [
    ["commonhold_sk_abc", "a legacy secret is not an assertion"],
    ["ch1.only-one-part", "two segments are required"],
    [`ch1.${payload}.${sig}.extra`, "three segments is not the format"],
    [`ch1.${payload}.${encodeBase64Url(new Uint8Array(63))}`, "a 63-byte signature"],
    [`ch1.${payload}.${encodeBase64Url(new Uint8Array(65))}`, "a 65-byte signature"],
    [`ch1.${payload}.not+base64url`, "a non-base64url signature"],
    [`ch1.!!!!.${sig}`, "a non-base64url payload"],
    [`ch1.${encodeBase64Url(new TextEncoder().encode("not json"))}.${sig}`, "a payload that is not JSON"],
    [`ch1.${encodeBase64Url(new TextEncoder().encode("[1,2,3]"))}.${sig}`, "a JSON array payload"],
    [`ch1.${encodeBase64Url(new TextEncoder().encode('"a string"'))}.${sig}`, "a JSON string payload"],
    [`ch1.${encodeBase64Url(new TextEncoder().encode('{"t":1,"n":"' + "a".repeat(22) + '"}'))}.${sig}`, "no handle"],
    [`ch1.${encodeBase64Url(new TextEncoder().encode('{"h":"has space","t":1,"n":"' + "a".repeat(22) + '"}'))}.${sig}`, "an invalid handle"],
    [`ch1.${encodeBase64Url(new TextEncoder().encode('{"h":"ok","t":"1","n":"' + "a".repeat(22) + '"}'))}.${sig}`, "a string timestamp"],
    [`ch1.${encodeBase64Url(new TextEncoder().encode('{"h":"ok","t":1.5,"n":"' + "a".repeat(22) + '"}'))}.${sig}`, "a fractional timestamp"],
    [`ch1.${encodeBase64Url(new TextEncoder().encode('{"h":"ok","t":-1,"n":"' + "a".repeat(22) + '"}'))}.${sig}`, "a negative timestamp"],
    [`ch1.${encodeBase64Url(new TextEncoder().encode('{"h":"ok","t":1,"n":"short"}'))}.${sig}`, "a too-short nonce"],
    [`ch1.${encodeBase64Url(new TextEncoder().encode('{"h":"ok","t":1,"n":"' + "a".repeat(65) + '"}'))}.${sig}`, "a too-long nonce"],
    [`ch1.${encodeBase64Url(new TextEncoder().encode('{"h":"ok","t":1,"n":"' + "!".repeat(22) + '"}'))}.${sig}`, "a non-base64url nonce"],
    [`ch1.${"a".repeat(ASSERTION_MAX_LEN)}.${sig}`, "an oversized token"],
  ];

  for (const [token, why] of cases) {
    const r = parseAssertion(token);
    assert.equal(r.ok, false, `${why} must be refused`);
    assert.equal(typeof (r as { reason: string }).reason, "string", `${why} must be refused WITH a reason`);
  }
});

test("a NaN or Infinity timestamp cannot survive JSON and is refused if hand-built", async () => {
  const { kp } = await realKeypair();
  const good = await signAssertion(kp, "someone", 1787900000000, newNonce());
  const sig = good.split(".")[2];
  // JSON.stringify turns NaN/Infinity into null, so the realistic attack is a
  // hand-written payload. Either way it must not parse.
  for (const raw of ['{"h":"ok","t":null,"n":"' + "a".repeat(22) + '"}', '{"h":"ok","n":"' + "a".repeat(22) + '"}']) {
    const r = parseAssertion(`ch1.${encodeBase64Url(new TextEncoder().encode(raw))}.${sig}`);
    assert.equal(r.ok, false);
  }
});

// ---------- the freshness window ----------

test("the window is symmetric: a future timestamp buys no extra life", () => {
  const now = 1787900000000;
  assert.equal(withinWindow(now, now), true);
  assert.equal(withinWindow(now - ASSERTION_WINDOW_MS, now), true, "exactly at the edge is inside");
  assert.equal(withinWindow(now + ASSERTION_WINDOW_MS, now), true);
  assert.equal(withinWindow(now - ASSERTION_WINDOW_MS - 1, now), false, "one ms too old");
  assert.equal(
    withinWindow(now + ASSERTION_WINDOW_MS + 1, now),
    false,
    "one ms too far ahead -- a far-future timestamp must not mint a long-lived credential",
  );
});

// ---------- verification, the part everything rests on ----------

test("a genuine assertion verifies against the key that signed it", async () => {
  const { kp, publicKeyB64 } = await realKeypair();
  const token = await signAssertion(kp, "sisyphus", 1787900000000, newNonce());
  const parsed = parseAssertion(token);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(await verifyAssertion(publicKeyB64, parsed.assertion), true);
});

test("an assertion signed by a DIFFERENT key does not verify", async () => {
  const alice = await realKeypair();
  const mallory = await realKeypair();
  const token = await signAssertion(mallory.kp, "alice", 1787900000000, newNonce());
  const parsed = parseAssertion(token);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(
    await verifyAssertion(alice.publicKeyB64, parsed.assertion),
    false,
    "signing someone else's handle with your own key must not authenticate as them",
  );
});

test("a TAMPERED payload does not verify -- the property the whole scheme rests on", async () => {
  const { kp, publicKeyB64 } = await realKeypair();
  const nonce = newNonce();
  const token = await signAssertion(kp, "alice", 1787900000000, nonce);
  const parsed = parseAssertion(token);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;

  // Swap the handle for another, keeping the original signature: the exact
  // escalation this design exists to prevent.
  const forgedSegment = buildPayloadSegment("commonhold-agent", 1787900000000, nonce);
  assert.notEqual(forgedSegment, parsed.assertion.payloadSegment, "the fixture must actually differ, or this test proves nothing");
  const forged = { ...parsed.assertion, payloadSegment: forgedSegment };
  assert.equal(await verifyAssertion(publicKeyB64, forged), false);
});

test("a tampered signature does not verify", async () => {
  const { kp, publicKeyB64 } = await realKeypair();
  const token = await signAssertion(kp, "alice", 1787900000000, newNonce());
  const parsed = parseAssertion(token);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const bent = new Uint8Array(parsed.assertion.signature);
  bent[0] ^= 0x01;
  assert.equal(await verifyAssertion(publicKeyB64, { ...parsed.assertion, signature: bent }), false);
});

test("a corrupt STORED key is an auth failure, never a thrown 500", async () => {
  const { kp } = await realKeypair();
  const token = await signAssertion(kp, "alice", 1787900000000, newNonce());
  const parsed = parseAssertion(token);
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  for (const stored of ["", "!!!!", encodeBase64Url(new Uint8Array(31))]) {
    assert.equal(await verifyAssertion(stored, parsed.assertion), false);
  }
});

test("nonces are base64url, long enough to index, and do not repeat", () => {
  const seen = new Set<string>();
  for (let i = 0; i < 500; i++) {
    const n = newNonce();
    assert.match(n, /^[A-Za-z0-9_-]+$/);
    assert.ok(n.length >= 16 && n.length <= 64, `nonce length ${n.length} outside the indexable band`);
    assert.equal(seen.has(n), false, "a repeated nonce would be a replay the store could not distinguish");
    seen.add(n);
  }
});

// ---------- signed intent (D-056) ----------

test("encodeIntentParts is injective: the one-part-that-looks-like-two trap cannot collide", () => {
  // "a,1:b" as ONE part must never encode the same as "a" and "b" as TWO.
  // Without length prefixes these would both be "a,1:b" and a signer could be
  // held to arguments it never supplied.
  assert.notEqual(encodeIntentParts(["a,1:b"]), encodeIntentParts(["a", "b"]));
  // And the prefix is BYTE length, not UTF-16 code units: "é" is one code unit
  // but two UTF-8 bytes, and the digest runs over UTF-8 bytes.
  assert.equal(encodeIntentParts(["é"]), "2:é");
  assert.equal(encodeIntentParts([]), "");
  assert.equal(encodeIntentParts(["", ""]), "0:,0:");
});

test("buildIntentBinding: op and every argument move the digest (the swapped-choice case at unit level)", async () => {
  const base = await buildIntentBinding("ballot", ["5", "yes"]);
  assert.match(base, /^ballot:[0-9a-f]{64}$/);
  // Same parts, same answer -- both transports and the client must be able to
  // recompute it.
  assert.equal(await buildIntentBinding("ballot", ["5", "yes"]), base);
  // CODEX round 2: op-only binding is insufficient because a captured ballot
  // assertion could have its proposal or choice swapped. Every argument must
  // therefore move the digest.
  assert.notEqual(await buildIntentBinding("ballot", ["5", "no"]), base);
  assert.notEqual(await buildIntentBinding("ballot", ["6", "yes"]), base);
  assert.notEqual(await buildIntentBinding("proposal", ["5", "yes"]), base);
});

test("an intent binding is never a valid public key, and a public key never carries an op prefix (rotate cross-shape disjointness, both directions)", async () => {
  const { publicKeyB64 } = await realKeypair();
  for (const op of INTENT_OPS) {
    const binding = await buildIntentBinding(op, ["42", "anything"]);
    // Direction one: a captured intent-bound assertion replayed into
    // /api/rotate would need its "b" to pass the public-key shape check.
    // ":" is outside the base64url alphabet, so it cannot.
    assert.ok(binding.includes(":"));
    assert.equal(checkPublicKeyShape(binding).ok, false, `a ${op} binding must never be installable as a key`);
  }
  // Direction two: a captured ROTATE assertion (b = a bare key) replayed into a
  // bound write would need "op:" at the start of a base64url string, which the
  // alphabet forbids.
  assert.doesNotMatch(publicKeyB64, /:/);
});

test("stableStringify: one spelling per value -- key order collapses, array order and types do not", () => {
  assert.equal(stableStringify({ a: 1, b: 2 }), stableStringify({ b: 2, a: 1 }));
  assert.equal(stableStringify({ outer: { z: true, a: null } }), '{"outer":{"a":null,"z":true}}');
  // Array order is meaning, not spelling.
  assert.notEqual(stableStringify([1, 2]), stableStringify([2, 1]));
  // A number and its string are different commitments.
  assert.notEqual(stableStringify({ n: 1 }), stableStringify({ n: "1" }));
  assert.equal(stableStringify(null), "null");
  assert.equal(stableStringify("x"), '"x"');
});
