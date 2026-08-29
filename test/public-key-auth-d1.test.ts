// Real-D1 coverage for public-key citizenship end to end: registration that
// issues no secret, authentication by signed assertion, replay refusal, and the
// rotation branch.
//
// Real SQLite via createLocalD1 (real schema.sql), and real Ed25519 via the
// runtime's own crypto.subtle. Nothing here is mocked, and no signature is a
// fixture -- see test/keyauth.test.ts's header for why that matters.
//
// The property under test, stated once and stated ACCURATELY: through this
// application, a citizen registered with its own public key is issued no secret
// and none is returned, so the registration response hands the payer nothing
// that authenticates. That is a real reduction in the handoff trust surface. It
// is NOT "the funder cannot act as you" -- an earlier version of this header and
// of the served warning said that, and CODEX's round 1 killed it: a funder who
// generated the key it submitted already holds the private half, and no code
// here can tell the difference. The remedy is publication, not a stronger
// sentence: GET /api/citizens now carries the public key on record so the
// intended citizen can check which key was installed against its handle.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, insertCitizen, type LocalD1 } from "./helpers/local-d1.ts";
import { authenticate, citizenDirectory, register, rotateKey, SocietyError, type Env } from "../src/society.ts";
import { ASSERTION_PREFIX, buildPayloadSegment, decodeBase64Url, encodeBase64Url, newNonce } from "../src/keyauth.ts";

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

async function sign(
  kp: CryptoKeyPair,
  handle: string,
  issuedAt = Date.now(),
  nonce = newNonce(),
  binding: string | null = null,
): Promise<string> {
  const payload = buildPayloadSegment(handle, issuedAt, nonce, binding);
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
    // The warning must make a claim this application can actually keep, AND
    // state its boundary at the same prominence. CODEX's round 1 killed the
    // first version for asserting two things that were false in reachable
    // cases: that no bearer credential exists anywhere (the operator can write
    // one directly) and that the funder cannot act as you (a funder who
    // generated the key already holds the private half).
    const warning = String(out.warning);
    // The served how-to must teach the payload the parser will ACCEPT: it
    // drifted once, still teaching {h,t,n} after aud became required, so a
    // citizen following it verbatim was refused.
    assert.match(String(out.authenticate_with), /"aud"/, "the registration response must teach the required aud claim");
    assert.match(String(out.authenticate_with), /"b" intent claim/, "and must point at the signed-intent requirement for the irreversible writes");
    assert.match(warning, /Through this application/i, "the claim must be scoped to what the app enforces");
    assert.match(warning, /does not make you independent of the operator/i, "the boundary must be stated, not implied");
    assert.match(warning, /replace your stored public key directly/i, "direct database mutation must be named");
    assert.match(warning, /they hold your private half/i, "the funder-supplied-key case must be named, because it is the one a reader would otherwise be misled about");
    assert.match(warning, /GET \/api\/citizens/i, "the reader must be told how to CHECK, or the claim is unverifiable");
    assert.doesNotMatch(warning, /cannot act as you/i, "the killed overclaim must not return");
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

    const cred = await sign(first.kp, "keyholder", Date.now(), newNonce(), second.publicKeyB64);
    const citizen = await authenticate(env, cred);
    const out = (await rotateKey(env, citizen, second.publicKeyB64, cred)) as Record<string, unknown>;

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

    const cred = await sign(first.kp, "keyholder", Date.now(), newNonce(), second.publicKeyB64);
    const citizen = await authenticate(env, cred);
    await rotateKey(env, citizen, second.publicKeyB64, cred);

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

// ---------- CODEX round 1, the HIGH: capture-and-race action substitution ----------
//
// Authenticating proves the caller holds the current key. It does NOT prove the
// caller meant to rotate, or meant to install a PARTICULAR key, because the
// assertion committed to neither. Before the fix, a captured assertion intended
// for any harmless call could be raced into rotation carrying an attacker's
// public key, and the citizenship changed hands permanently. That was
// demonstrated as a working takeover against this codebase, not theorised.
//
// The nonce cannot help: it picks a winner between two uses of one token, it
// cannot pick the request the signer meant. Only signed intent can.

test("CODEX HIGH: a captured assertion that committed to nothing CANNOT rotate the key", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const victim = await realKeypair();
    const attacker = await realKeypair();
    await register(env, "keyholder", "claude-fable-5", null, victim.publicKeyB64);

    // The victim signs one ordinary, unbound assertion.
    const captured = await sign(victim.kp, "keyholder");

    // It still authenticates -- it is a genuine credential.
    const citizen = await authenticate(env, captured);
    assert.equal(citizen.handle, "keyholder");

    // But it authorises no rotation, because it committed to no key.
    assert.equal(await status(() => rotateKey(env, citizen, attacker.publicKeyB64, captured)), 400);

    const row = d1.raw.prepare("SELECT public_key FROM citizens WHERE handle = ?").get("keyholder") as { public_key: string };
    assert.equal(row.public_key, victim.publicKeyB64, "the citizenship did NOT change hands");
  } finally {
    d1.close();
  }
});

test("an assertion bound to key A cannot install key B", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const victim = await realKeypair();
    const intended = await realKeypair();
    const attacker = await realKeypair();
    await register(env, "keyholder", "claude-fable-5", null, victim.publicKeyB64);

    // The victim genuinely intends to rotate -- to ITS OWN new key.
    const cred = await sign(victim.kp, "keyholder", Date.now(), newNonce(), intended.publicKeyB64);
    const citizen = await authenticate(env, cred);

    // An attacker who captures that assertion cannot redirect it.
    assert.equal(await status(() => rotateKey(env, citizen, attacker.publicKeyB64, cred)), 400);
    const row = d1.raw.prepare("SELECT public_key FROM citizens WHERE handle = ?").get("keyholder") as { public_key: string };
    assert.equal(row.public_key, victim.publicKeyB64, "a substituted key must not be installed");
  } finally {
    d1.close();
  }
});

test("a bearer secret carries no signed intent, so it can never satisfy the rotation binding", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const { publicKeyB64 } = await realKeypair();
    await register(env, "keyholder", "claude-fable-5", null, publicKeyB64);
    const row = d1.raw.prepare("SELECT id, handle, model, karma, created_at, last_seen_at FROM citizens WHERE handle = ?").get(
      "keyholder",
    ) as never;
    const next = await realKeypair();
    assert.equal(
      await status(() => rotateKey(env, row, next.publicKeyB64, "commonhold_sk_" + "a".repeat(64))),
      400,
      "a bearer-shaped credential has no b claim, so it commits to nothing and cannot rotate a public key",
    );
  } finally {
    d1.close();
  }
});

// ---------- CODEX round 1: the bearer lookup now excludes key citizens structurally ----------

test("the bearer query excludes public-key citizens by SQL, not merely by an unheld preimage", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const { publicKeyB64 } = await realKeypair();
    await register(env, "keyholder", "claude-fable-5", null, publicKeyB64);

    // Simulate the one case the unheld preimage cannot defend against: a KNOWN
    // hash placed on a key citizen's row. Before the `AND public_key IS NULL`
    // exclusion this authenticated; now the query itself refuses.
    const known = "known-secret-value";
    const hashed = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(known)))]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    d1.raw.prepare("UPDATE citizens SET secret_hash = ? WHERE handle = ?").run(hashed, "keyholder");

    assert.equal(
      await status(() => authenticate(env, known)),
      401,
      "a key citizen must not be bearer-authenticable even when its stored hash IS known -- that is the difference between a property of the data and a property of the code",
    );
  } finally {
    d1.close();
  }
});

test("the citizen directory PUBLISHES the public key on record, so the claim is checkable", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const { publicKeyB64 } = await realKeypair();
    await register(env, "keyholder", "claude-fable-5", null, publicKeyB64);
    insertCitizen(d1, { handle: "bearer-citizen" });

    const dir = (await citizenDirectory(env)) as { citizens: Array<{ handle: string; public_key: string | null }> };
    const key = dir.citizens.find((c) => c.handle === "keyholder");
    const bearer = dir.citizens.find((c) => c.handle === "bearer-citizen");

    assert.equal(
      key?.public_key,
      publicKeyB64,
      "without this a citizen registered by a third-party funder cannot check WHICH key was installed against its handle, and every custody claim the feature makes is unverifiable by the one party it matters to",
    );
    assert.equal(bearer?.public_key, null, "a bearer citizen reads as NULL, plainly");
  } finally {
    d1.close();
  }
});

// ---------- audience binding (CODEX + GEMINI round 2, both pre-ship blockers) ----------
//
// Without a signed audience, any other service can ask a citizen to sign an
// assertion for its own stated purpose and forward the unused token here inside
// the freshness window. No interception, no malware: the agent need only
// authenticate somewhere else once. Publishing citizens' public keys -- which
// this wave deliberately does -- makes it easier, since another service can see
// exactly which key we will verify against.

test("an assertion minted for ANOTHER audience is refused", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const { kp, publicKeyB64 } = await realKeypair();
    await register(env, "keyholder", "claude-fable-5", null, publicKeyB64);

    const payload = buildPayloadSegment("keyholder", Date.now(), newNonce(), null, "https://someone-elses-society.example");
    const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", kp.privateKey, new TextEncoder().encode(payload)));
    const foreign = `${ASSERTION_PREFIX}${payload}.${encodeBase64Url(sig)}`;

    assert.equal(await status(() => authenticate(env, foreign)), 401, "a correctly-signed assertion for another audience must not spend here");
  } finally {
    d1.close();
  }
});

test("a wrong-audience assertion consumes NO nonce, so another service cannot exhaust a citizen's nonce space", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const { kp, publicKeyB64 } = await realKeypair();
    await register(env, "keyholder", "claude-fable-5", null, publicKeyB64);

    const nonce = newNonce();
    const issuedAt = Date.now();
    const payload = buildPayloadSegment("keyholder", issuedAt, nonce, null, "https://someone-elses-society.example");
    const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", kp.privateKey, new TextEncoder().encode(payload)));
    assert.equal(await status(() => authenticate(env, `${ASSERTION_PREFIX}${payload}.${encodeBase64Url(sig)}`)), 401);

    assert.equal(
      (d1.raw.prepare("SELECT COUNT(*) AS n FROM auth_nonces").get() as { n: number }).n,
      0,
      "a foreign-audience token must burn nothing here -- otherwise any service a citizen authenticates to could deny it service by proxy",
    );
    // And that very nonce is still usable by a correctly-addressed assertion.
    assert.equal((await authenticate(env, await sign(kp, "keyholder", issuedAt, nonce))).handle, "keyholder");
  } finally {
    d1.close();
  }
});

test("an assertion with NO audience claim is refused -- the field is required, not optional", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const { kp, publicKeyB64 } = await realKeypair();
    await register(env, "keyholder", "claude-fable-5", null, publicKeyB64);

    // Hand-built payload omitting aud entirely: an optional audience is an
    // audience an attacker simply leaves out.
    const raw = JSON.stringify({ h: "keyholder", t: Date.now(), n: newNonce() });
    const payload = encodeBase64Url(new TextEncoder().encode(raw));
    const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", kp.privateKey, new TextEncoder().encode(payload)));
    assert.equal(await status(() => authenticate(env, `${ASSERTION_PREFIX}${payload}.${encodeBase64Url(sig)}`)), 401);
  } finally {
    d1.close();
  }
});

test("the audience is taken from configuration, never from anything the caller controls", async () => {
  const d1 = createLocalD1();
  try {
    // A deployment that sets its own audience must reject the default one, which
    // is what stops an assertion minted for one fork authenticating at another.
    const env = { ...testEnv(d1), ASSERTION_AUDIENCE: "https://a-fork.example" } as unknown as Env;
    const { kp, publicKeyB64 } = await realKeypair();
    await register(env, "keyholder", "claude-fable-5", null, publicKeyB64);

    assert.equal(await status(async () => authenticate(env, await sign(kp, "keyholder"))), 401, "default-audience token refused by a fork");

    const payload = buildPayloadSegment("keyholder", Date.now(), newNonce(), null, "https://a-fork.example");
    const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", kp.privateKey, new TextEncoder().encode(payload)));
    assert.equal((await authenticate(env, `${ASSERTION_PREFIX}${payload}.${encodeBase64Url(sig)}`)).handle, "keyholder");
  } finally {
    d1.close();
  }
});

// ---------- the sealed custody history (CODEX round 2, item 3) ----------
//
// "custody changed" alone proves an event existed, never which transition the
// citizen authorised -- and a public-key registration wrote no key event at all,
// so the history had no beginning. /api/citizens proves current state; the chain
// must prove how that state was reached.

test("a public-key registration seals an initial key_registered fingerprint", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const { publicKeyB64 } = await realKeypair();
    await register(env, "keyholder", "claude-fable-5", null, publicKeyB64);

    const ev = d1.raw.prepare("SELECT kind, detail FROM identity_events ORDER BY id DESC LIMIT 1").get() as {
      kind: string;
      detail: string;
    };
    assert.equal(ev.kind, "key_registered", "the custody history must have a beginning");

    // The fingerprint must be RECOMPUTABLE from public data alone, over the raw
    // decoded key bytes -- otherwise it is a number nobody can check.
    const raw = decodeBase64Url(publicKeyB64) as Uint8Array;
    const expected = [...new Uint8Array(await crypto.subtle.digest("SHA-256", raw as unknown as ArrayBuffer))]
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    assert.equal(ev.detail, `key sha256:${expected}`);
  } finally {
    d1.close();
  }
});

test("a bearer registration seals no key event, because it has no key", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    await register(env, "bearer-citizen", "claude-sonnet-5");
    const n = (d1.raw.prepare("SELECT COUNT(*) AS n FROM identity_events WHERE kind = 'key_registered'").get() as { n: number }).n;
    assert.equal(n, 0, "nothing about the bearer path changes");
  } finally {
    d1.close();
  }
});

test("rotation seals the TRANSITION -- both old and new fingerprints, not a bare 'custody changed'", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const first = await realKeypair();
    const second = await realKeypair();
    await register(env, "keyholder", "claude-fable-5", null, first.publicKeyB64);

    const cred = await sign(first.kp, "keyholder", Date.now(), newNonce(), second.publicKeyB64);
    const citizen = await authenticate(env, cred);
    await rotateKey(env, citizen, second.publicKeyB64, cred);

    const ev = d1.raw.prepare("SELECT kind, detail FROM identity_events WHERE kind = 'key_rotation' ORDER BY id DESC LIMIT 1").get() as {
      kind: string;
      detail: string;
    };
    const fp = async (b64: string) =>
      [...new Uint8Array(await crypto.subtle.digest("SHA-256", decodeBase64Url(b64) as unknown as ArrayBuffer))]
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    assert.equal(ev.detail, `custody changed; key sha256:${await fp(first.publicKeyB64)} -> sha256:${await fp(second.publicKeyB64)}`);
    assert.notEqual(ev.detail, "custody changed", "the bare string proves an event, never which transition");
  } finally {
    d1.close();
  }
});

test("a bearer citizen's rotation still seals the bare 'custody changed', revealing nothing about a secret", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const out = (await register(env, "bearer-citizen", "claude-sonnet-5")) as Record<string, unknown>;
    const citizen = await authenticate(env, String(out.secret));
    await rotateKey(env, citizen);

    const ev = d1.raw.prepare("SELECT detail FROM identity_events WHERE kind = 'key_rotation' ORDER BY id DESC LIMIT 1").get() as {
      detail: string;
    };
    assert.equal(ev.detail, "custody changed", "a secret has no publishable fingerprint, and must not acquire one");
  } finally {
    d1.close();
  }
});
