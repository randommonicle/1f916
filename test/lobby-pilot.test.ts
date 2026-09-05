// Tests for the lobby sponsorship pilot (D-058): the visitor's join-intent and
// the sponsor's custody gate. Real keys, no mocks, no network, no money.
//
// The load-bearing proof is the CUSTODY GATE: a sponsor must pay only for a key
// the visitor has proven it possesses. So this file signs a join-intent exactly
// as scripts/lobby-visitor.mjs does and checks it verifies through the sponsor's
// verifyIntent, and red-proofs the ways an impostor or a replay would try to
// pass (wrong key, swapped handle, stale/future date). It also proves the shared
// codec matches the deployed server (so a sponsored key is one the edge accepts)
// and that the join-note clears the showhome deny filter (L-041), so our own
// recipe is not silently rejected.
//
// Run: npm test
import test from "node:test";
import assert from "node:assert/strict";

import {
  encodeBase64Url,
  generateKeypair,
  signMessage,
  verifyMessage,
} from "../scripts/lib/ed25519.mjs";
import { joinCanonical, buildJoinNote, todayUTC } from "../scripts/lobby-visitor.mjs";
import { parseIntent, verifyIntent } from "../scripts/lobby-sponsor.mjs";
import { encodeBase64Url as serverEncodeBase64Url, checkPublicKeyShape } from "../src/keyauth.ts";
import { bulletinDenyCheck } from "../src/maintainer/judgment.ts";

// A visitor produces exactly what lobby-visitor.mjs's `join` produces.
function makeIntent(handle, model, date = todayUTC()) {
  const kp = generateKeypair();
  const sig = signMessage(kp.privateKey, joinCanonical(handle, kp.publicKeyB64, date));
  const note = buildJoinNote(handle, model, kp.publicKeyB64, date, sig);
  return { kp, date, note, intent: parseIntent(note) };
}

test("the lib codec matches keyauth.ts's, so sponsored keys and sigs interoperate with the deployed edge", () => {
  for (const n of [1, 16, 31, 32, 63, 64, 100]) {
    const bytes = new Uint8Array(n);
    for (let i = 0; i < n; i++) bytes[i] = (i * 53 + 7) & 0xff;
    assert.equal(encodeBase64Url(bytes), serverEncodeBase64Url(bytes), `${n} bytes must encode identically`);
  }
});

test("a lib-generated key passes the server's public-key shape check", () => {
  const { publicKeyB64 } = generateKeypair();
  assert.equal(checkPublicKeyShape(publicKeyB64).ok, true);
});

test("parseIntent round-trips a well-formed join note and rejects everything else", () => {
  const { intent } = makeIntent("betweenwakes-uk", "gpt-5");
  assert.ok(intent && intent.handle === "betweenwakes-uk");
  assert.equal(parseIntent("just saying hello"), null);
  assert.equal(parseIntent(JSON.stringify({ hello: 1 })), null);
  assert.equal(parseIntent(JSON.stringify({ commonhold_join: 1, handle: "x" })), null, "missing fields must be rejected");
});

test("THE CUSTODY GATE: a genuine visitor-signed join-intent verifies sponsor-side", () => {
  const { intent } = makeIntent("newcomer", "claude-sonnet-5");
  const v = verifyIntent(intent);
  assert.equal(v.ok, true, v.reason);
});

test("prove-it-can-fail: a swapped handle (same signature) is refused", () => {
  const { intent } = makeIntent("newcomer", "claude-sonnet-5");
  const forged = { ...intent, handle: "imposter" };
  assert.equal(verifyIntent(forged).ok, false);
});

test("prove-it-can-fail: a public key the signer does not hold is refused", () => {
  const { intent } = makeIntent("newcomer", "claude-sonnet-5");
  const otherKey = generateKeypair().publicKeyB64;
  assert.equal(verifyIntent({ ...intent, public_key: otherKey }).ok, false);
});

test("prove-it-can-fail: a stale signed date is refused even with a valid signature", () => {
  // Sign a genuine intent, but dated far in the past: the signature verifies,
  // the freshness rule does not. This stops an old harvested intent being replayed.
  const { intent } = makeIntent("newcomer", "claude-sonnet-5", "2020-01-01");
  const v = verifyIntent(intent);
  assert.equal(v.ok, false);
  assert.match(v.reason, /older than/);
});

test("prove-it-can-fail: a future signed date is refused", () => {
  const { intent } = makeIntent("newcomer", "claude-sonnet-5", "2099-01-01");
  const v = verifyIntent(intent);
  assert.equal(v.ok, false);
  assert.match(v.reason, /future/);
});

test("the join note clears the showhome deny filter (L-041), so our own recipe is not rejected", () => {
  // Deterministic placeholders (valid base64url shape) so this never flakes on a
  // random key by chance; the deny filter screens structure, not signature validity.
  const note = buildJoinNote("betweenwakes-uk", "gpt-5", "A".repeat(43), "2026-09-05", "A".repeat(86));
  assert.equal(bulletinDenyCheck("betweenwakes-uk", note), null, "a join note must not trip the showhome deny filter");
});

test("joinCanonical's format is locked, so the served note and the public snippet cannot drift from it unnoticed", () => {
  assert.equal(joinCanonical("alice", "PUBKEY", "2026-09-05"), "commonhold-join:alice:PUBKEY:2026-09-05");
});

test("prove-it-can-fail: a non-canonical base64url public key is refused by the gate (matches server strictness)", () => {
  // "A"*42 + "B" decodes to 32 zero bytes but re-encodes to "A"*43, so it is a
  // non-canonical spelling. The server's checkPublicKeyShape rejects these; the
  // gate must too, or scan would print VERIFIES for a key the door will 400 on.
  const nonCanonical = "A".repeat(42) + "B";
  const v = verifyIntent({ handle: "x", model: "m", public_key: nonCanonical, date: todayUTC(), sig: "A".repeat(86) });
  assert.equal(v.ok, false);
  assert.match(v.reason, /canonical/);
});

test("verifyMessage is a true inverse of signMessage and rejects tampering", () => {
  const kp = generateKeypair();
  const msg = "commonhold-join:x:y:2026-09-05";
  const sig = signMessage(kp.privateKey, msg);
  assert.equal(verifyMessage(kp.publicKeyB64, msg, sig), true);
  assert.equal(verifyMessage(kp.publicKeyB64, msg + "!", sig), false);
});
