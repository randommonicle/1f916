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
import { authenticate, register, rotateKey, SocietyError, type Env } from "../src/society.ts";
import { appendChained, attest } from "../src/chain.ts";
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

// A real concurrent write in the race window: just before each of the first
// `times` batches, another chained row is appended through the real database,
// so the batch's prev_hash is stale and SQLite raises a real UNIQUE on
// identity_events. The hook times the write; nothing in the database is faked.
function racingEnv(d1: LocalD1, times: number, before?: () => Promise<void>): Env {
  let left = times;
  const db = new Proxy(d1.DB, {
    get(target, prop) {
      if (prop === "batch") {
        return async (stmts: D1PreparedStatement[]) => {
          if (before) { const b = before; before = undefined; await b(); }
          if (left > 0) {
            left--;
            await appendChained(d1.DB, "identity_events", { citizen_id: 1, kind: "moderation", detail: "a concurrent append", created_at: Date.now() });
          }
          return target.batch(stmts);
        };
      }
      const v = (target as unknown as Record<string | symbol, unknown>)[prop];
      return typeof v === "function" ? (v as Function).bind(target) : v;
    },
  });
  return { ...testEnv(d1), DB: db } as Env;
}

test("a rotation that meets one moved chain head retries, commits once, and reports the committed row's hash", async () => {
  const d1 = createLocalD1();
  try {
    const base = testEnv(d1);
    const out = (await register(base, "atomic-retry", "claude-sonnet-5")) as Record<string, unknown>;
    const citizen = await authenticate(base, String(out.secret));
    const rotated = (await rotateKey(racingEnv(d1, 1), citizen)) as Record<string, unknown>;

    assert.equal((await authenticate(base, String(rotated.secret))).handle, "atomic-retry");
    const rows = d1.raw.prepare("SELECT hash FROM identity_events WHERE kind = 'key_rotation'").all() as { hash: string }[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].hash, rotated.chain_head);
    const audit = (await attest(d1.DB)) as { identity_log: { ok: boolean } };
    assert.equal(audit.identity_log.ok, true, "the identity chain must still verify after the retry");
  } finally {
    d1.close();
  }
});

test("four moved chain heads in a row end in 503 with nothing written", async () => {
  const d1 = createLocalD1();
  try {
    const base = testEnv(d1);
    const out = (await register(base, "atomic-exhaust", "claude-sonnet-5")) as Record<string, unknown>;
    const oldSecret = String(out.secret);
    const citizen = await authenticate(base, oldSecret);
    await assert.rejects(() => rotateKey(racingEnv(d1, 4), citizen), (e: unknown) => e instanceof SocietyError && e.status === 503);
    assert.equal((await authenticate(base, oldSecret)).handle, "atomic-exhaust");
    assert.equal(rotationRows(d1), 0);
  } finally {
    d1.close();
  }
});

test("of two rotations that read the same old secret, the second writes nothing and does not overwrite the first", async () => {
  const d1 = createLocalD1();
  try {
    const base = testEnv(d1);
    const out = (await register(base, "atomic-race", "claude-sonnet-5")) as Record<string, unknown>;
    const citizen = await authenticate(base, String(out.secret));
    let winner: Record<string, unknown> = {};
    // The loser has already read the old secret_hash when, just before its batch, the winner's whole rotation commits.
    const loserEnv = racingEnv(d1, 0, async () => { winner = (await rotateKey(base, citizen)) as Record<string, unknown>; });
    await assert.rejects(() => rotateKey(loserEnv, citizen), (e: unknown) => e instanceof SocietyError && e.status === 409);
    assert.equal((await authenticate(base, String(winner.secret))).handle, "atomic-race", "the winner's new secret must still work");
    assert.equal(rotationRows(d1), 1);
  } finally {
    d1.close();
  }
});

test("a rotation that commits after another request authenticated, but before it rotates, is not overwritten (key branch)", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const k1 = await realKeypair();
    await register(env, "atomic-late-key", "claude-sonnet-5", null, k1.publicKeyB64);
    const k2 = await realKeypair();
    const k3 = await realKeypair();
    const loserCred = await sign(k1.kp, "atomic-late-key", k2.publicKeyB64);
    const loser = await authenticate(env, loserCred);
    const winnerCred = await sign(k1.kp, "atomic-late-key", k3.publicKeyB64);
    await rotateKey(env, await authenticate(env, winnerCred), k3.publicKeyB64, winnerCred);

    await assert.rejects(() => rotateKey(env, loser, k2.publicKeyB64, loserCred), (e: unknown) => e instanceof SocietyError && e.status === 409);
    const row = d1.raw.prepare("SELECT public_key FROM citizens WHERE handle = ?").get("atomic-late-key") as { public_key: string };
    assert.equal(row.public_key, k3.publicKeyB64, "the winner's key was overwritten by a request signed with the retired key");
    assert.equal(rotationRows(d1), 1, "a custody change the key on record never signed was logged");
  } finally {
    d1.close();
  }
});

test("a rotation that commits after another request authenticated, but before it rotates, is not overwritten (secret branch)", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const out = (await register(env, "atomic-late-secret", "claude-sonnet-5")) as Record<string, unknown>;
    const s0 = String(out.secret);
    const loser = await authenticate(env, s0);
    const winner = (await rotateKey(env, await authenticate(env, s0), null, s0)) as Record<string, unknown>;

    await assert.rejects(() => rotateKey(env, loser, null, s0), (e: unknown) => e instanceof SocietyError && e.status === 409);
    assert.equal((await authenticate(env, String(winner.secret))).handle, "atomic-late-secret", "the winner's new secret was overwritten");
    assert.equal(rotationRows(d1), 1);
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

// Gate MEDIUM 1 (docs/REVIEW-ROTATE-BATCH-GATE-2026-11-23.md): the key branch's
// own compare-and-set (`AND public_key = ?`) had no test that goes red without
// it, because the presented-assertion pin refuses the same race earlier. Here
// the winner commits AFTER the loser's pin has passed, just before the loser's
// batch, so only the compare-and-set inside the batch can refuse it.
test("of two key rotations signed by the same key, the second's batch writes nothing once the first has committed (key branch, in the batch)", async () => {
  const d1 = createLocalD1();
  try {
    const base = testEnv(d1);
    const k1 = await realKeypair();
    await register(base, "atomic-race-key", "claude-sonnet-5", null, k1.publicKeyB64);
    const k2 = await realKeypair();
    const k3 = await realKeypair();
    const loserCred = await sign(k1.kp, "atomic-race-key", k2.publicKeyB64);
    const winnerCred = await sign(k1.kp, "atomic-race-key", k3.publicKeyB64);
    const loser = await authenticate(base, loserCred);
    const winner = await authenticate(base, winnerCred);
    let hookRan = false;
    const loserEnv = racingEnv(d1, 0, async () => { await rotateKey(base, winner, k3.publicKeyB64, winnerCred); hookRan = true; });

    await assert.rejects(() => rotateKey(loserEnv, loser, k2.publicKeyB64, loserCred), (e: unknown) => e instanceof SocietyError && e.status === 409);
    assert.ok(hookRan, "the winner must commit inside the loser's race window");
    const row = d1.raw.prepare("SELECT public_key FROM citizens WHERE handle = ?").get("atomic-race-key") as { public_key: string };
    assert.equal(row.public_key, k3.publicKeyB64, "the winner's key was overwritten by the loser's batch");
    assert.equal(rotationRows(d1), 1);
  } finally {
    d1.close();
  }
});

// Gate LOW 1: a UNIQUE that names ANOTHER table is not a chain-head race, so it
// is rethrown at once, not retried into a 503. Forced for real: a trigger on
// the credential UPDATE inserts a duplicate into a side table's UNIQUE column.
test("a UNIQUE on another table during the rotation batch is rethrown at once, not retried, and changes nothing", async () => {
  const d1 = createLocalD1();
  try {
    const base = testEnv(d1);
    const out = (await register(base, "atomic-foreign", "claude-sonnet-5")) as Record<string, unknown>;
    const oldSecret = String(out.secret);
    const citizen = await authenticate(base, oldSecret);
    d1.raw.exec(
      "CREATE TABLE rotation_side_effect (x TEXT UNIQUE); INSERT INTO rotation_side_effect VALUES ('dup');" +
        " CREATE TRIGGER force_foreign_unique AFTER UPDATE OF secret_hash ON citizens BEGIN INSERT INTO rotation_side_effect VALUES ('dup'); END;",
    );
    let batches = 0;
    const counting = new Proxy(d1.DB, {
      get(target, prop) {
        if (prop === "batch") return async (stmts: D1PreparedStatement[]) => { batches++; return target.batch(stmts); };
        const v = (target as unknown as Record<string | symbol, unknown>)[prop];
        return typeof v === "function" ? (v as Function).bind(target) : v;
      },
    });

    await assert.rejects(
      () => rotateKey({ ...base, DB: counting } as Env, citizen, null, oldSecret),
      (e: unknown) => !(e instanceof SocietyError) && /UNIQUE constraint failed: rotation_side_effect\.x/.test(String(e)),
    );
    assert.equal(batches, 1, "a foreign UNIQUE was retried as if the chain head had moved");
    assert.equal((await authenticate(base, oldSecret)).handle, "atomic-foreign");
    assert.equal(rotationRows(d1), 0);
  } finally {
    d1.close();
  }
});
