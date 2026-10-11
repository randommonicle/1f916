// The resident tier, the bind (D-075 order step b; docs/BRIEF-RESIDENT-TIER-2026-10-11.md R1-R4, R7; hub amendments A4, A5, A8).
// Real local D1 (node:sqlite + the committed schema.sql) driven through the real router, real Ed25519 keys signed by the runtime's own
// WebCrypto. Nothing is mocked. Every block names the mutant that turns it red; docs/CHECKPOINT-RESIDENTS.md records each one run and
// restored.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, seedCitizens, seedPost, guestEnv, guestComment, call, count, freshIp } from "./helpers/guest.ts";
import { enterGuest, promotedGuest, genKeypair, signBind, signRecover, bindRoute, recoverRoute, newResident, nonceCount } from "./helpers/resident.ts";
import { sha256Hex } from "../src/chain.ts";
import { encodeBase64Url, decodeBase64Url, ASSERTION_WINDOW_MS } from "../src/keyauth.ts";
import { RESIDENT_BIND_PER_IP_PER_HOUR } from "../src/resident.ts";

function fresh() {
  const d1 = createLocalD1();
  const { maintainer, alice } = seedCitizens(d1);
  const post = seedPost(d1, alice);
  return { d1, env: guestEnv(d1), maintainer, alice, post };
}

const guestRow = (d1: ReturnType<typeof createLocalD1>, n: number) => d1.raw.prepare("SELECT * FROM guests WHERE visitor_id = ?").get(n) as Record<string, any> | undefined;

// ---------- the happy path ----------

test("bind: a promoted guest binds its key; the same token keeps writing; its rows then read resident (mutant: the UPDATE writes nothing, or the reader ignores public_key)", async () => {
  const { d1, env, post } = fresh();
  try {
    const g = await promotedGuest(env, post, "wren");
    const kp = await genKeypair();
    const r = await bindRoute(env, g, kp);
    assert.equal(r.status, 201);
    assert.equal(r.body.byline, `resident:wren#${g.number}`);
    assert.equal(r.body.tier, "resident");
    assert.equal(r.body.public_key, kp.publicKey);
    const row = guestRow(d1, g.number)!;
    assert.equal(row.public_key, kp.publicKey);
    assert.ok(Number(row.resident_at) > 0, "resident_at is stamped");
    assert.equal(nonceCount(d1), 1, "the nonce was burnt in the same batch");
    // the token is unchanged and still writes, and the row it writes reads resident
    const c = await guestComment(env, g.token, { post_id: post, body: "a second comment, after binding" });
    assert.equal(c.status, 201);
    assert.equal(c.body.byline, `resident:wren#${g.number}`);
    assert.equal(c.body.tier, "resident");
    assert.equal(c.body.resident.bound, true);
    // no citizen row, no chain row, no citizen nonce
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM citizens"), 2);
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM auth_nonces"), 0);
  } finally {
    d1.close();
  }
});

// ---------- R3: who may bind ----------

test("bind: an unpromoted visitor (a REAL token from enter, zero comments) is refused, and nothing is written (mutant: the promoted check is dropped)", async () => {
  const { d1, env } = fresh();
  try {
    const v = await enterGuest(env, "lurker");
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM guests"), 0, "the visitor has not been promoted");
    const kp = await genKeypair();
    const r = await bindRoute(env, v, kp);
    assert.equal(r.status, 409);
    assert.match(r.body.error, /Only a guest that has commented can bind/);
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM guests"), 0);
    assert.equal(nonceCount(d1), 0, "no nonce burnt for a refusal that precedes verification");
  } finally {
    d1.close();
  }
});

test("bind: an unknown token and a missing token are 401 with nothing written (the token proves the guest)", async () => {
  const { d1, env } = fresh();
  try {
    const kp = await genKeypair();
    const g = { number: 99, handle: "ghost", token: "commonhold_visit_nothing" };
    const unknown = await bindRoute(env, g, kp);
    assert.equal(unknown.status, 401);
    assert.match(unknown.body.error, /Unknown guest token/);
    const { assertion } = await signBind(kp, 1, "ghost");
    const missing = await call(env, "POST", "/api/resident/bind", { public_key: kp.publicKey, assertion }, { "CF-Connecting-IP": freshIp() });
    assert.equal(missing.status, 401);
    assert.match(missing.body.error, /No guest token/);
    assert.equal(nonceCount(d1), 0);
  } finally {
    d1.close();
  }
});

test("bind: a second bind is refused and the first key stays (mutant: the UPDATE loses `AND public_key IS NULL`)", async () => {
  const { d1, env, post } = fresh();
  try {
    const { guest, kp } = await newResident(env, post, "wren");
    const second = await genKeypair();
    const r = await bindRoute(env, guest, second);
    assert.equal(r.status, 409);
    assert.match(r.body.error, /already a resident/);
    assert.equal(guestRow(d1, guest.number)!.public_key, kp.publicKey, "the first key is still the bound key");
  } finally {
    d1.close();
  }
});

test("bind: two concurrent binds with different keys, exactly one wins and the stored key is the winner's (the conditional UPDATE is the bound, changes() = 1)", async () => {
  const { d1, env, post } = fresh();
  try {
    const g = await promotedGuest(env, post, "wren");
    const a = await genKeypair();
    const b = await genKeypair();
    const [ra, rb] = await Promise.all([bindRoute(env, g, a), bindRoute(env, g, b)]);
    const won = [ra, rb].filter((r) => r.status === 201);
    const lost = [ra, rb].filter((r) => r.status !== 201);
    assert.equal(won.length, 1, `exactly one bind wins (${ra.status}, ${rb.status})`);
    assert.equal(lost[0]!.status, 409);
    assert.equal(guestRow(d1, g.number)!.public_key, won[0]!.body.public_key, "the stored key is the winner's");
  } finally {
    d1.close();
  }
});

test("bind: a key already bound to another guest is refused (the unique index), and that guest stays unbound with no nonce burnt (mutant: the unique index is dropped)", async () => {
  const { d1, env, post } = fresh();
  try {
    const { guest: first, kp } = await newResident(env, post, "wren");
    const second = await promotedGuest(env, post, "finch");
    const nonces = nonceCount(d1);
    const r = await bindRoute(env, second, kp); // the same key, validly signed for the second guest
    assert.equal(r.status, 409);
    assert.match(r.body.error, /already bound to another resident/);
    assert.equal(guestRow(d1, second.number)!.public_key, null);
    assert.equal(guestRow(d1, first.number)!.public_key, kp.publicKey);
    assert.equal(nonceCount(d1), nonces, "the failed batch rolled back whole, including the nonce");
  } finally {
    d1.close();
  }
});

// ---------- the assertion: what it must commit to ----------

test("bind: an assertion signed by a DIFFERENT key than the one supplied is refused 401 (mutant: the signature is checked against a stored or absent key)", async () => {
  const { d1, env, post } = fresh();
  try {
    const g = await promotedGuest(env, post, "wren");
    const claimed = await genKeypair();
    const other = await genKeypair();
    // the binding names `claimed`, the signature is by `other`
    const { assertion } = await signBind(other, g.number, g.handle, { publicKey: claimed.publicKey });
    const r = await call(env, "POST", "/api/resident/bind", { token: g.token, public_key: claimed.publicKey, assertion }, { "CF-Connecting-IP": freshIp() });
    assert.equal(r.status, 401);
    assert.match(r.body.error, /Signature does not verify/);
    assert.equal(guestRow(d1, g.number)!.public_key, null);
    assert.equal(nonceCount(d1), 0);
  } finally {
    d1.close();
  }
});

test("bind: a resident_recover assertion presented to bind is refused 403, and a bind assertion presented to recover is refused 403 (the two ops cannot be swapped)", async () => {
  const { d1, env, post } = fresh();
  try {
    const g = await promotedGuest(env, post, "wren");
    const kp = await genKeypair();
    // a recover-shaped assertion (right key, right handle, the other op's binding) at the bind door
    const { assertion } = await signRecover(kp, g.number, g.handle);
    const r = await call(env, "POST", "/api/resident/bind", { token: g.token, public_key: kp.publicKey, assertion }, { "CF-Connecting-IP": freshIp() });
    assert.equal(r.status, 403);
    assert.match(r.body.error, /commits to a different act/);
    assert.equal(guestRow(d1, g.number)!.public_key, null);
    // and the other way round, on a real resident
    const { guest, kp: key } = await newResident(env, post, "finch");
    const before = guestRow(d1, guest.number)!.token_hash;
    const bindShaped = await signBind(key, guest.number, guest.handle);
    const back = await call(env, "POST", "/api/resident/token", { number: guest.number, assertion: bindShaped.assertion }, { "CF-Connecting-IP": freshIp() });
    assert.equal(back.status, 403);
    assert.equal(guestRow(d1, guest.number)!.token_hash, before, "the token did not move");
  } finally {
    d1.close();
  }
});

test("bind: an assertion with no signed intent is refused 403 and teaches the exact binding; one for another guest's number is refused (the binding names this guest)", async () => {
  const { d1, env, post } = fresh();
  try {
    const g = await promotedGuest(env, post, "wren");
    const other = await promotedGuest(env, post, "finch");
    const kp = await genKeypair();
    const none = await signBind(kp, g.number, g.handle, { binding: null });
    const r1 = await call(env, "POST", "/api/resident/bind", { token: g.token, public_key: kp.publicKey, assertion: none.assertion }, { "CF-Connecting-IP": freshIp() });
    assert.equal(r1.status, 403);
    assert.match(r1.body.error, /carries no signed intent/);
    assert.match(r1.body.error, /resident_bind:[0-9a-f]{64}/);
    // signed for `other`'s number, presented with g's token
    const wrongNumber = await signBind(kp, other.number, g.handle);
    const r2 = await call(env, "POST", "/api/resident/bind", { token: g.token, public_key: kp.publicKey, assertion: wrongNumber.assertion }, { "CF-Connecting-IP": freshIp() });
    assert.equal(r2.status, 403);
    assert.equal(guestRow(d1, g.number)!.public_key, null);
  } finally {
    d1.close();
  }
});

test("bind: claims.h must equal the stored guest handle exactly (R7); a different spelling, even case, is refused (mutant: the handle check is dropped)", async () => {
  const { d1, env, post } = fresh();
  try {
    const g = await promotedGuest(env, post, "Wren");
    const kp = await genKeypair();
    const wrongCase = await bindRoute(env, g, kp, { claimHandle: "wren" });
    assert.equal(wrongCase.status, 401);
    assert.match(wrongCase.body.error, /payload\.h must be this guest's handle exactly/);
    const wrongName = await bindRoute(env, g, kp, { claimHandle: "somebody-else" });
    assert.equal(wrongName.status, 401);
    assert.equal(guestRow(d1, g.number)!.public_key, null);
    assert.equal((await bindRoute(env, g, kp)).status, 201, "and the exact handle binds");
  } finally {
    d1.close();
  }
});

test("bind: the audience is checked before anything is read or written: an assertion minted for another service is refused and spends no nonce", async () => {
  const { d1, env, post } = fresh();
  try {
    const g = await promotedGuest(env, post, "wren");
    const kp = await genKeypair();
    const r = await bindRoute(env, g, kp, { audience: "https://another.example" });
    assert.equal(r.status, 401);
    assert.match(r.body.error, /different audience/);
    assert.equal(nonceCount(d1), 0);
    assert.equal(guestRow(d1, g.number)!.public_key, null);
  } finally {
    d1.close();
  }
});

// ---------- R1: the nonce ----------

test("bind: a nonce already used by another guest's bind is refused as a replay, and the second guest stays unbound (mutant: the nonce insert is dropped from the batch)", async () => {
  const { d1, env, post } = fresh();
  try {
    const a = await promotedGuest(env, post, "wren");
    const b = await promotedGuest(env, post, "finch");
    const ka = await genKeypair();
    const kb = await genKeypair();
    const nonce = "shared-nonce-0123456789abcdef";
    assert.equal((await bindRoute(env, a, ka, { nonce })).status, 201);
    const replay = await bindRoute(env, b, kb, { nonce });
    assert.equal(replay.status, 401);
    assert.match(replay.body.error, /already been used/);
    assert.equal(guestRow(d1, b.number)!.public_key, null, "the replay rolled the write back with the nonce");
    // a fresh nonce binds the same guest
    assert.equal((await bindRoute(env, b, kb)).status, 201);
  } finally {
    d1.close();
  }
});

test("bind: A4 nonce ordering. An attempt with nonce N and an INVALID signature is refused and burns nothing; a VALID signature with the SAME N then succeeds (mutant: the nonce is burnt before the signature is verified)", async () => {
  const { d1, env, post } = fresh();
  try {
    const g = await promotedGuest(env, post, "wren");
    const kp = await genKeypair();
    const imposter = await genKeypair();
    const nonce = "ordering-nonce-0123456789abcdef";
    // bound to kp's key but signed by the imposter: parse, audience, window, handle and binding all pass; only the signature fails
    const forged = await signBind(imposter, g.number, g.handle, { publicKey: kp.publicKey, nonce });
    const bad = await call(env, "POST", "/api/resident/bind", { token: g.token, public_key: kp.publicKey, assertion: forged.assertion }, { "CF-Connecting-IP": freshIp() });
    assert.equal(bad.status, 401);
    assert.equal(nonceCount(d1), 0, "an invalid signature spends no nonce");
    const good = await bindRoute(env, g, kp, { nonce });
    assert.equal(good.status, 201, "the genuine signer can still use the nonce the forger tried");
    assert.equal(nonceCount(d1), 1);
  } finally {
    d1.close();
  }
});

test("bind: A5 freshness. An expired assertion and a future-dated one are both refused; one inside the window is accepted (mutant: the window check is dropped)", async () => {
  const { d1, env, post } = fresh();
  try {
    const g = await promotedGuest(env, post, "wren");
    const kp = await genKeypair();
    const expired = await bindRoute(env, g, kp, { t: Date.now() - ASSERTION_WINDOW_MS - 5000 });
    assert.equal(expired.status, 401);
    assert.match(expired.body.error, /freshness window/);
    const future = await bindRoute(env, g, kp, { t: Date.now() + ASSERTION_WINDOW_MS + 5000 });
    assert.equal(future.status, 401);
    assert.match(future.body.error, /freshness window/);
    assert.equal(nonceCount(d1), 0);
    assert.equal(guestRow(d1, g.number)!.public_key, null);
    const inside = await bindRoute(env, g, kp, { t: Date.now() - 60_000 });
    assert.equal(inside.status, 201, "a minute old is inside the window");
  } finally {
    d1.close();
  }
});

// ---------- A5: the key's shape ----------

test("bind: A5 a non-canonical spelling of a valid key is refused with its reason, and the canonical spelling binds (mutant: checkPublicKeyShape is dropped)", async () => {
  const { d1, env, post } = fresh();
  try {
    const g = await promotedGuest(env, post, "wren");
    const kp = await genKeypair();
    // 32 bytes encode to 43 base64url characters whose last character carries 4 padding bits that must be zero; set one of them.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = alphabet.indexOf(kp.publicKey[kp.publicKey.length - 1]!);
    const variant = kp.publicKey.slice(0, -1) + alphabet[last | 1];
    assert.notEqual(variant, kp.publicKey, "the fixture really differs from the canonical key");
    assert.deepEqual(decodeBase64Url(variant), decodeBase64Url(kp.publicKey), "and decodes to the same bytes, which is exactly the trap");
    const r = await bindRoute(env, g, kp, { publicKey: variant });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /canonical base64url/);
    assert.equal(guestRow(d1, g.number)!.public_key, null);
    // other shape failures are 400 too, never a 500
    for (const bad of ["", "not-a-key", "A".repeat(200), 12345 as unknown as string, encodeBase64Url(new Uint8Array(31))]) {
      const { assertion } = await signBind(kp, g.number, g.handle);
      const x = await call(env, "POST", "/api/resident/bind", { token: g.token, public_key: bad, assertion }, { "CF-Connecting-IP": freshIp() });
      assert.equal(x.status, 400, `public_key ${JSON.stringify(bad).slice(0, 30)} is a 400`);
    }
    assert.equal((await bindRoute(env, g, kp)).status, 201);
  } finally {
    d1.close();
  }
});

test("bind: a missing or non-string assertion is a 400, and a malformed one a 401 (never a 500)", async () => {
  const { d1, env, post } = fresh();
  try {
    const g = await promotedGuest(env, post, "wren");
    const kp = await genKeypair();
    const none = await call(env, "POST", "/api/resident/bind", { token: g.token, public_key: kp.publicKey }, { "CF-Connecting-IP": freshIp() });
    assert.equal(none.status, 400);
    const junk = await call(env, "POST", "/api/resident/bind", { token: g.token, public_key: kp.publicKey, assertion: "ch1.not.real" }, { "CF-Connecting-IP": freshIp() });
    assert.equal(junk.status, 401);
    const wrongType = await call(env, "POST", "/api/resident/bind", { token: g.token, public_key: kp.publicKey, assertion: { x: 1 } }, { "CF-Connecting-IP": freshIp() });
    assert.equal(wrongType.status, 400);
    assert.equal(guestRow(d1, g.number)!.public_key, null);
  } finally {
    d1.close();
  }
});

// ---------- the cap ----------

test("bind: the per-address cap binds with its own wording (not the showhome note's), and a refusal still consumes the budget (mutant: the cap call is removed)", async () => {
  const { d1, env } = fresh();
  try {
    const ip = "203.0.113.200";
    const kp = await genKeypair();
    for (let i = 0; i < RESIDENT_BIND_PER_IP_PER_HOUR; i++) {
      const r = await call(env, "POST", "/api/resident/bind", { token: "commonhold_visit_unknown", public_key: kp.publicKey, assertion: "x" }, { "CF-Connecting-IP": ip });
      assert.equal(r.status, 401, `attempt ${i + 1} reaches authentication`);
    }
    const capped = await call(env, "POST", "/api/resident/bind", { token: "commonhold_visit_unknown", public_key: kp.publicKey, assertion: "x" }, { "CF-Connecting-IP": ip });
    assert.equal(capped.status, 429);
    assert.match(capped.body.error, /key-binding attempts/);
    assert.doesNotMatch(capped.body.error, /showhome notes/);
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM showhome_rate WHERE path = 'bind'"), RESIDENT_BIND_PER_IP_PER_HOUR);
  } finally {
    d1.close();
  }
});

// ---------- the sibling recovery route shares the verifier: one smoke here, the full set in resident-recover-d1.test.ts ----------

test("a bound resident's recover assertion round-trips through the same verifier (smoke)", async () => {
  const { d1, env, post } = fresh();
  try {
    const { guest, kp } = await newResident(env, post, "wren");
    const r = await recoverRoute(env, guest, kp);
    assert.equal(r.status, 201);
    assert.match(r.body.token, /^commonhold_visit_[0-9a-f]{64}$/);
    assert.equal(guestRow(d1, guest.number)!.token_hash, await sha256Hex(r.body.token));
  } finally {
    d1.close();
  }
});
