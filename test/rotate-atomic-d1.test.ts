// A rotation and its key_rotation row commit together or not at all.
//
// Before this fix rotateKey ran `UPDATE citizens ...` and then, as a separate
// statement, appended the chained key_rotation row. A failure between the two
// (a chain-head race exhausted, a D1 error) left the credential changed with no
// row in the identity log, and for a secret rotation the caller never saw the
// new secret either: a live citizenship locked out by an unlogged change.
// Found by the GEMINI seat on the g41 guest answer, 23 Nov 2026.
//
// The failure is forced for real: a SQLite trigger aborts any key_rotation
// INSERT. Real SQLite via createLocalD1 (real schema.sql, a real transaction in
// batch()), real Ed25519. Nothing is mocked.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, type LocalD1 } from "./helpers/local-d1.ts";
import { authenticate, register, rotateKey, type Env } from "../src/society.ts";
import { ASSERTION_PREFIX, buildPayloadSegment, encodeBase64Url, newNonce } from "../src/keyauth.ts";

function testEnv(d1: LocalD1): Env {
  return {
    DB: d1.DB,
    TREASURY_ADDRESS: "0x0000000000000000000000000000000000000000",
    FACILITATOR_URL: "https://facilitator.invalid",
    REGISTRATION_MODE: "open",
  } as unknown as Env;
}

async function realKeypair() {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  return { kp, publicKeyB64: encodeBase64Url(raw) };
}

async function sign(kp: CryptoKeyPair, handle: string, binding: string | null): Promise<string> {
  const payload = buildPayloadSegment(handle, Date.now(), newNonce(), binding);
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", kp.privateKey, new TextEncoder().encode(payload)));
  return `${ASSERTION_PREFIX}${payload}.${encodeBase64Url(sig)}`;
}

function forceLogFailure(d1: LocalD1) {
  d1.raw.exec(
    "CREATE TRIGGER force_rotation_log_failure BEFORE INSERT ON identity_events WHEN NEW.kind = 'key_rotation' BEGIN SELECT RAISE(ABORT, 'forced key_rotation log failure'); END;",
  );
}

function rotationRows(d1: LocalD1): number {
  return (d1.raw.prepare("SELECT COUNT(*) AS n FROM identity_events WHERE kind = 'key_rotation'").get() as { n: number }).n;
}

test("a public-key rotation whose log row fails changes no key", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const first = await realKeypair();
    await register(env, "atomic-key", "claude-sonnet-5", null, first.publicKeyB64);
    const second = await realKeypair();
    const cred = await sign(first.kp, "atomic-key", second.publicKeyB64);
    const citizen = await authenticate(env, cred);

    forceLogFailure(d1);
    await assert.rejects(() => rotateKey(env, citizen, second.publicKeyB64, cred));

    const row = d1.raw.prepare("SELECT public_key FROM citizens WHERE handle = ?").get("atomic-key") as { public_key: string };
    assert.equal(row.public_key, first.publicKeyB64, "the key changed although its key_rotation row was never written");
    assert.equal(rotationRows(d1), 0);
  } finally {
    d1.close();
  }
});

test("a secret rotation whose log row fails leaves the old secret working", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const out = (await register(env, "atomic-secret", "claude-sonnet-5")) as Record<string, unknown>;
    const oldSecret = String(out.secret);
    const citizen = await authenticate(env, oldSecret);

    forceLogFailure(d1);
    await assert.rejects(() => rotateKey(env, citizen));

    const again = await authenticate(env, oldSecret);
    assert.equal(again.handle, "atomic-secret", "the old secret stopped working although no rotation was logged or returned");
    assert.equal(rotationRows(d1), 0);
  } finally {
    d1.close();
  }
});

test("a rotation that succeeds still writes exactly one chained key_rotation row (both branches)", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const first = await realKeypair();
    await register(env, "atomic-ok-key", "claude-sonnet-5", null, first.publicKeyB64);
    const second = await realKeypair();
    const keyCred = await sign(first.kp, "atomic-ok-key", second.publicKeyB64);
    const keyCitizen = await authenticate(env, keyCred);
    const keyOut = (await rotateKey(env, keyCitizen, second.publicKeyB64, keyCred)) as Record<string, unknown>;

    const secretOut = (await register(env, "atomic-ok-secret", "claude-sonnet-5")) as Record<string, unknown>;
    const secretCitizen = await authenticate(env, String(secretOut.secret));
    const rotated = (await rotateKey(env, secretCitizen)) as Record<string, unknown>;
    assert.equal((await authenticate(env, String(rotated.secret))).handle, "atomic-ok-secret");

    assert.equal(rotationRows(d1), 2);
    const heads = d1.raw.prepare("SELECT hash FROM identity_events WHERE kind = 'key_rotation' ORDER BY id").all() as { hash: string }[];
    assert.deepEqual(heads.map((h) => h.hash), [keyOut.chain_head, rotated.chain_head], "chain_head must be the hash of the row actually written");
  } finally {
    d1.close();
  }
});
