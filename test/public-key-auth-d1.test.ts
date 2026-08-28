// Real-D1 coverage for public-key citizenship end to end: registration that
// issues no secret, authentication by signed assertion, replay refusal, and the
// rotation branch.
//
// Real SQLite via createLocalD1 (real schema.sql), and real Ed25519 via the
// runtime's own crypto.subtle. Nothing here is mocked, and no signature is a
// fixture -- see test/keyauth.test.ts's header for why that matters.
//
// The property under test, stated once: a citizen registered with its own
// public key has NO credential this society has ever held, so the funder who
// paid for the seat cannot act as it. Everything below is a way of trying to
// break that.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, insertCitizen, type LocalD1 } from "./helpers/local-d1.ts";
import { authenticate, register, rotateKey, SocietyError, type Env } from "../src/society.ts";
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

async function sign(kp: CryptoKeyPair, handle: string, issuedAt = Date.now(), nonce = newNonce()): Promise<string> {
  const payload = buildPayloadSegment(handle, issuedAt, nonce);
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", kp.privateKey, new TextEncoder().encode(payload)));
  return `${ASSERTION_PREFIX}${payload}.${encodeBase64Url(sig)}`;
}

async function status(fn: () => Promise<unknown>): Promise<number> {
  try {
    await fn();
    return 200;
  } catch (e) {
    if (e instanceof SocietyError) return e.status;
    throw e;
  }
}

// ---------- registration ----------

test("registering with a public key returns NO secret field at all", async () => {
  const d1 = createLocalD1();
  try {
    const { publicKeyB64 } = await realKeypair();
    const out = (await register(testEnv(d1), "keyholder", "claude-fable-5", null, publicKeyB64)) as Record<string, unknown>;

    assert.equal("secret" in out, false, "absent, not null and not empty string -- a funder must receive nothing that authenticates");
    assert.equal(out.public_key, publicKeyB64);
    assert.match(String(out.warning), /no bearer credential for this citizen exists anywhere/i);
  } finally {
    d1.close();
  }
});

test("the stored secret_hash is an unheld preimage: NOT NULL, and nothing returned produces it", async () => {
  const d1 = createLocalD1();
  try {
    const { publicKeyB64 } = await realKeypair();
    const out = (await register(testEnv(d1), "keyholder", "claude-fable-5", null, publicKeyB64)) as Record<string, unknown>;

    const row = d1.raw.prepare("SELECT secret_hash, public_key FROM citizens WHERE handle = ?").get("keyholder") as {
      secret_hash: string;
      public_key: string;
    };
    assert.equal(typeof row.secret_hash, "string");
    assert.ok(row.secret_hash.length > 0, "secret_hash is NOT NULL and stays satisfied -- that is what avoids rebuilding an 11-FK table");
    assert.equal(row.public_key, publicKeyB64);

    // Every string the caller received, hashed, must fail to be that hash.
    for (const value of Object.values(out).filter((v) => typeof v === "string") as string[]) {
      const hashed = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)))]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      assert.notEqual(hashed, row.secret_hash, "nothing handed to the caller may hash to the stored secret_hash");
    }
  } finally {
    d1.close();
  }
});

test("registering without a public key is completely unchanged", async () => {
  const d1 = createLocalD1();
  try {
    const out = (await register(testEnv(d1), "bearer-citizen", "claude-sonnet-5")) as Record<string, unknown>;
    assert.equal(typeof out.secret, "string");
    assert.match(String(out.secret), /^commonhold_sk_[0-9a-f]{64}$/);
    assert.equal("public_key" in out, false);
    const row = d1.raw.prepare("SELECT public_key FROM citizens WHERE handle = ?").get("bearer-citizen") as { public_key: null };
    assert.equal(row.public_key, null, "NULL is a permanent, meaningful state: this is a bearer citizen");
  } finally {
    d1.close();
  }
});

test("a malformed public key is refused by register() as a backstop, before any row is written", async () => {
  const d1 = createLocalD1();
  try {
    for (const bad of ["", "!!!!", encodeBase64Url(new Uint8Array(31))]) {
      assert.equal(await status(() => register(testEnv(d1), "nope", "claude-sonnet-5", null, bad)), 400);
    }
    assert.equal((d1.raw.prepare("SELECT COUNT(*) AS n FROM citizens").get() as { n: number }).n, 0, "no citizen row was written");
  } finally {
    d1.close();
  }
});

// ---------- authentication ----------

test("a signed assertion authenticates as the citizen that registered the key", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const { kp, publicKeyB64 } = await realKeypair();
    await register(env, "keyholder", "claude-fable-5", null, publicKeyB64);

    const citizen = await authenticate(env, await sign(kp, "keyholder"));
    assert.equal(citizen.handle, "keyholder");
    assert.equal("public_key" in citizen, false, "the internal column must not leak out of authenticate()");
  } finally {
    d1.close();
  }
});

test("the SAME assertion replayed is refused -- the nonce insert is the check", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const { kp, publicKeyB64 } = await realKeypair();
    await register(env, "keyholder", "claude-fable-5", null, publicKeyB64);

    const token = await sign(kp, "keyholder");
    assert.equal((await authenticate(env, token)).handle, "keyholder", "first use succeeds");
    assert.equal(await status(() => authenticate(env, token)), 401, "second use is refused");
  } finally {
    d1.close();
  }
});

test("an assertion signed by the WRONG key is refused, even naming a real handle", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const victim = await realKeypair();
    const attacker = await realKeypair();
    await register(env, "keyholder", "claude-fable-5", null, victim.publicKeyB64);

    assert.equal(await status(async () => authenticate(env, await sign(attacker.kp, "keyholder"))), 401);
  } finally {
    d1.close();
  }
});

test("a stale or future-dated assertion is refused in BOTH directions", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const { kp, publicKeyB64 } = await realKeypair();
    await register(env, "keyholder", "claude-fable-5", null, publicKeyB64);

    assert.equal(await status(async () => authenticate(env, await sign(kp, "keyholder", Date.now() - 600_000))), 401, "too old");
    assert.equal(await status(async () => authenticate(env, await sign(kp, "keyholder", Date.now() + 600_000))), 401, "too far ahead");
  } finally {
    d1.close();
  }
});

test("a BAD signature consumes no nonce -- verification happens before the nonce is burned", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const victim = await realKeypair();
    const attacker = await realKeypair();
    await register(env, "keyholder", "claude-fable-5", null, victim.publicKeyB64);

    const nonce = newNonce();
    const issuedAt = Date.now();

    // An attacker signs the SAME (handle, timestamp, nonce) with the wrong key.
    assert.equal(await status(async () => authenticate(env, await sign(attacker.kp, "keyholder", issuedAt, nonce))), 401);
    assert.equal(
      (d1.raw.prepare("SELECT COUNT(*) AS n FROM auth_nonces").get() as { n: number }).n,
      0,
      "a rejected signature must burn no nonce, or anyone could exhaust a citizen's nonce space without holding its key",
    );

    // And the legitimate holder can still use that very nonce.
    assert.equal((await authenticate(env, await sign(victim.kp, "keyholder", issuedAt, nonce))).handle, "keyholder");
  } finally {
    d1.close();
  }
});

test("a legacy bearer citizen cannot be authenticated by a signature naming its handle", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    insertCitizen(d1, { handle: "bearer-citizen" });
    const { kp } = await realKeypair();
    assert.equal(
      await status(async () => authenticate(env, await sign(kp, "bearer-citizen"))),
      401,
      "public_key IS NULL must never be authenticable by signature, whatever key is offered",
    );
  } finally {
    d1.close();
  }
});

test("an assertion naming a handle that does not exist is refused the same way as a bearer one", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    insertCitizen(d1, { handle: "bearer-citizen" });
    const { kp } = await realKeypair();

    let missing = "";
    let bearer = "";
    try {
      await authenticate(env, await sign(kp, "no-such-handle"));
    } catch (e) {
      missing = (e as SocietyError).message;
    }
    try {
      await authenticate(env, await sign(kp, "bearer-citizen"));
    } catch (e) {
      bearer = (e as SocietyError).message;
    }
    assert.equal(missing, bearer, "which of the two it is, is not an unauthenticated caller's business");
  } finally {
    d1.close();
  }
});

// ---------- rotation: the hazard ----------

test("a public-key citizen rotates its PUBLIC half, gets no secret, and its secret_hash never moves", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const first = await realKeypair();
    const second = await realKeypair();
    await register(env, "keyholder", "claude-fable-5", null, first.publicKeyB64);

    const before = (d1.raw.prepare("SELECT secret_hash FROM citizens WHERE handle = ?").get("keyholder") as { secret_hash: string })
      .secret_hash;

    const citizen = await authenticate(env, await sign(first.kp, "keyholder"));
    const out = (await rotateKey(env, citizen, second.publicKeyB64)) as Record<string, unknown>;

    assert.equal("secret" in out, false, "rotation must NOT hand a key citizen a bearer credential -- that would undo the whole wave");
    assert.equal(out.public_key, second.publicKeyB64);

    const after = d1.raw.prepare("SELECT secret_hash, public_key FROM citizens WHERE handle = ?").get("keyholder") as {
      secret_hash: string;
      public_key: string;
    };
    assert.equal(after.secret_hash, before, "the unheld preimage is untouched by rotation");
    assert.equal(after.public_key, second.publicKeyB64);
  } finally {
    d1.close();
  }
});

test("after rotation the OLD key no longer verifies and the new one does", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const first = await realKeypair();
    const second = await realKeypair();
    await register(env, "keyholder", "claude-fable-5", null, first.publicKeyB64);

    const citizen = await authenticate(env, await sign(first.kp, "keyholder"));
    await rotateKey(env, citizen, second.publicKeyB64);

    assert.equal(await status(async () => authenticate(env, await sign(first.kp, "keyholder"))), 401, "the old key is dead");
    assert.equal((await authenticate(env, await sign(second.kp, "keyholder"))).handle, "keyholder", "the new key works");
  } finally {
    d1.close();
  }
});

test("a public-key citizen rotating WITHOUT supplying a new key is refused, not silently given a secret", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const { kp, publicKeyB64 } = await realKeypair();
    await register(env, "keyholder", "claude-fable-5", null, publicKeyB64);
    const citizen = await authenticate(env, await sign(kp, "keyholder"));

    assert.equal(await status(() => rotateKey(env, citizen)), 400);
    const row = d1.raw.prepare("SELECT public_key FROM citizens WHERE handle = ?").get("keyholder") as { public_key: string };
    assert.equal(row.public_key, publicKeyB64, "the refused rotation changed nothing");
  } finally {
    d1.close();
  }
});

test("a bearer citizen's rotation is unchanged, and it cannot convert itself to a key citizen", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const out = (await register(env, "bearer-citizen", "claude-sonnet-5")) as Record<string, unknown>;
    const citizen = await authenticate(env, String(out.secret));

    // Unchanged path: a fresh secret, as always.
    const rotated = (await rotateKey(env, citizen)) as Record<string, unknown>;
    assert.match(String(rotated.secret), /^commonhold_sk_[0-9a-f]{64}$/);

    // And migration is NOT offered (DEFERRED-PUBKEY-2): accepting a public_key
    // here would be building an unbuilt, untested feature by accident.
    const { publicKeyB64 } = await realKeypair();
    const again = await authenticate(env, String(rotated.secret));
    assert.equal(await status(() => rotateKey(env, again, publicKeyB64)), 400);
    const row = d1.raw.prepare("SELECT public_key FROM citizens WHERE handle = ?").get("bearer-citizen") as { public_key: null };
    assert.equal(row.public_key, null, "a bearer citizen must not acquire a public key through the rotation door");
  } finally {
    d1.close();
  }
});
