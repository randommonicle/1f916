// Tests for scripts/keyauth-ride.mjs, the public-key one-real-ride client.
//
// The point of this file is ANTI-DRIFT and CROSS-IMPLEMENTATION AGREEMENT, and
// it earns that with real keys, no mocks, no network, no money:
//
//   * the client's base64url codec and payload-segment builder are byte-for-byte
//     copies of src/keyauth.ts's; here we PROVE they still produce identical
//     bytes, so a future edit to one side that forgets the other fails loudly.
//   * the client signs with Node's crypto.sign (raw Ed25519); the DEPLOYED
//     server verifies with crypto.subtle. This file signs with the client and
//     verifies with keyauth.ts's own verifyAssertion, so it proves the two
//     implementations interoperate before a dollar is ever spent. If they did
//     not, the $1 registration would succeed and the signed write would then be
//     rejected at the edge -- the exact failure one-real-ride exists to catch,
//     moved to an offline test.
//
// Run: npm test
import test from "node:test";
import assert from "node:assert/strict";

import {
  encodeBase64Url,
  decodeBase64Url,
  buildPayloadSegment as clientBuildPayloadSegment,
  newNonce,
  generateKeypair,
  buildAssertion,
  privateKeyFromJwk,
  publicKeyB64FromPrivate,
  publicKeyFingerprint as clientFingerprint,
  AUDIENCE,
} from "../scripts/keyauth-ride.mjs";

import {
  encodeBase64Url as serverEncodeBase64Url,
  buildPayloadSegment as serverBuildPayloadSegment,
  parseAssertion,
  verifyAssertion,
  checkPublicKeyShape,
  publicKeyFingerprint as serverFingerprint,
  withinWindow,
  ASSERTION_WINDOW_MS,
  DEFAULT_AUDIENCE,
} from "../src/keyauth.ts";

import { OPERATOR_CONTROLLED_HANDLES } from "../src/society.ts";

test("the client audience equals the server's DEFAULT_AUDIENCE (a wrong one is refused at the edge)", () => {
  assert.equal(AUDIENCE, DEFAULT_AUDIENCE);
});

test("client and server base64url codecs agree across sizes, including the 32- and 64-byte cases", () => {
  // 0 is excluded deliberately: an empty value encodes to "" and the codec
  // returns null for "" by design (keyauth.ts), so it has no round-trip. The
  // sizes that matter here are 32 (a public key) and 64 (a signature).
  for (const n of [1, 15, 16, 31, 32, 63, 64, 100]) {
    const bytes = new Uint8Array(n);
    for (let i = 0; i < n; i++) bytes[i] = (i * 37 + 11) & 0xff;
    assert.equal(encodeBase64Url(bytes), serverEncodeBase64Url(bytes), `${n} bytes must encode identically`);
    // and the client's own decode is a true inverse
    assert.deepEqual(decodeBase64Url(encodeBase64Url(bytes)), bytes, `${n} bytes must round-trip`);
  }
});

test("client and server build byte-identical payload segments, bound and unbound", () => {
  const h = "keyholder";
  const t = 1788600000000;
  const n = newNonce();
  // unbound (a social write, which is what the ride uses). Both builders share
  // keyauth.ts's argument order (handle, issuedAt, nonce, binding, audience).
  assert.equal(
    clientBuildPayloadSegment(h, t, n, null, AUDIENCE),
    serverBuildPayloadSegment(h, t, n, null, DEFAULT_AUDIENCE),
    "unbound payloads must match",
  );
  // bound (an irreversible write; out of scope for the ride, but the builder
  // must still agree, or a later intent-bound client would drift silently)
  const b = "ballot:" + "0".repeat(64);
  assert.equal(
    clientBuildPayloadSegment(h, t, n, b, AUDIENCE),
    serverBuildPayloadSegment(h, t, n, b, DEFAULT_AUDIENCE),
    "bound payloads must match",
  );
});

test("a client-generated key is canonical and the server shape check accepts it", () => {
  const { publicKeyB64 } = generateKeypair();
  const shape = checkPublicKeyShape(publicKeyB64);
  assert.equal(shape.ok, true, "the server must accept a key the client just generated");
  assert.equal(shape.bytes.length, 32);
});

test("client and server public-key fingerprints agree", async () => {
  const { publicKeyB64 } = generateKeypair();
  assert.equal(clientFingerprint(publicKeyB64), await serverFingerprint(publicKeyB64));
});

test("THE CRUX: an assertion the client signs verifies under the server's verifier", async () => {
  const { publicKeyB64, privateKey } = generateKeypair();
  const { token } = buildAssertion("keyholder", privateKey, AUDIENCE, null);

  const parsed = parseAssertion(token);
  assert.equal(parsed.ok, true, `the server parser must accept the client's token: ${parsed.ok ? "" : parsed.reason}`);
  assert.equal(parsed.assertion.audience, DEFAULT_AUDIENCE);
  assert.equal(parsed.assertion.binding, null, "a ride post is a social write and carries no signed intent");
  assert.equal(await verifyAssertion(publicKeyB64, parsed.assertion), true, "the signature must verify against the registered key");
});

test("the JWK-reconstructed private key (the exact path `post` uses) signs a verifiable assertion", async () => {
  // generateKeypair hands back an in-memory KeyObject, but the real `post` leg
  // signs with a key rebuilt from the stored JWK (loadPrivateKey). Prove that
  // reconstruction path signs something the server verifies (LOW-1, Opus review).
  const { publicKeyB64, privateKeyJwk } = generateKeypair();
  const reloaded = privateKeyFromJwk(privateKeyJwk);
  assert.equal(publicKeyB64FromPrivate(reloaded), publicKeyB64, "the reloaded key must derive the same public key");
  const { token } = buildAssertion("keyholder", reloaded, AUDIENCE, null);
  const parsed = parseAssertion(token);
  assert.equal(parsed.ok, true);
  assert.equal(await verifyAssertion(publicKeyB64, parsed.assertion), true);
});

test("prove-it-can-fail: a signature checked against the WRONG key does not verify", async () => {
  const signer = generateKeypair();
  const other = generateKeypair();
  const { token } = buildAssertion("keyholder", signer.privateKey, AUDIENCE, null);
  const parsed = parseAssertion(token);
  assert.equal(parsed.ok, true);
  assert.equal(await verifyAssertion(other.publicKeyB64, parsed.assertion), false);
});

test("prove-it-can-fail: a tampered payload (same signature) does not verify", async () => {
  const { publicKeyB64, privateKey } = generateKeypair();
  const { token, nonce, issuedAt } = buildAssertion("keyholder", privateKey, AUDIENCE, null);
  const sigSegment = token.split(".")[2];
  // Forge: keep the real signature but swap the handle the payload claims.
  const forgedPayload = clientBuildPayloadSegment("someone-else", issuedAt, nonce, null, AUDIENCE);
  const forged = `ch1.${forgedPayload}.${sigSegment}`;
  const parsed = parseAssertion(forged);
  assert.equal(parsed.ok, true, "the forged token is still well-formed; only the signature is wrong");
  assert.equal(await verifyAssertion(publicKeyB64, parsed.assertion), false);
});

test("prove-it-can-fail: the server freshness window rejects stale and future timestamps", () => {
  const now = Date.now();
  assert.equal(withinWindow(now, now), true);
  assert.equal(withinWindow(now - (ASSERTION_WINDOW_MS + 1000), now), false, "stale must be rejected");
  assert.equal(withinWindow(now + (ASSERTION_WINDOW_MS + 1000), now), false, "a future timestamp buys no extra life");
});

test("census honesty: the ride handle 'keyholder' is disclosed as operator-controlled", () => {
  // The ride mints a real citizen whose private key Ben holds; it is
  // operator-controlled by definition. The census counts a citizen as
  // operator-controlled only if its handle is in this list (society.ts), so
  // without this entry /api/official would report the ride citizen as
  // independent -- a false statement on the front door. This test locks the
  // disclosure: dropping 'keyholder' from the list turns it red.
  assert.equal(OPERATOR_CONTROLLED_HANDLES.includes("keyholder"), true);
});
