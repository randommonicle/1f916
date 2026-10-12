// H1 of the 12 Oct hardening wave (docs/CHECKPOINT-HARDENING.md C1; drafts/BRIEF-HARDENING-SEATS-2026-10-12.md H1, HW2-HW4, HW9): nonces are stored per signer
// ("c:<citizen_id>:<nonce>" in auth_nonces, "r:<visitor_id>:<nonce>" in resident_nonces), so one key holder cannot spend another's nonce first; and a raw-nonce row left by the
// previous worker still refuses its nonce, on all four consumers (the citizen verifier, bind, recover, the resident council ballot), by a constraint failure that aborts the
// write it guards. Real local D1 (node:sqlite + schema.sql), the real router, real Ed25519 keys. Nothing of ours is mocked.
//
// What the guard tests prove is the batch guard ITSELF: the direct-statement tests at the end run nonceStatement inside a batch with a mutation after it, so they hold whether or
// not the advisory pre-check (H4, resident.ts assertResidentNonceUnspent) sits in front. Each block names the mutant that turns it red; the checkpoint records each run.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, guestEnv, seedPost, seedCitizens, count } from "./helpers/guest.ts";
import { bindRoute, recoverRoute, genKeypair, newResident, promotedGuest, nonceCount } from "./helpers/resident.ts";
import { councilCast, openMotion, castBallot, rows, seedKeyCitizen, seedEarned, citizenAssertion } from "./helpers/council.ts";
import { authenticate, SocietyError } from "../src/society.ts";
import { newNonce, ASSERTION_WINDOW_MS, type ParsedAssertion } from "../src/keyauth.ts";
import { nonceStatement, nonceGcStatement, residentNonceKey } from "../src/resident.ts";

const SHARED = "AAAAAAAAAAAAAAAAAAAAAA"; // 22 base64url characters: a nonce a careless signer might pick
const nonceRows = (d1: any, table: "auth_nonces" | "resident_nonces") => rows<{ nonce: string }>(d1, `SELECT nonce FROM ${table} ORDER BY nonce`).map((r) => r.nonce);
const seedRaw = (d1: any, table: "auth_nonces" | "resident_nonces", nonce: string, owner: number, expiresAt = Date.now() + 100_000) =>
  d1.raw.prepare(`INSERT INTO ${table} (nonce, ${table === "auth_nonces" ? "citizen_id" : "visitor_id"}, expires_at) VALUES (?, ?, ?)`).run(nonce, owner, expiresAt);
const statusOf = async (fn: () => Promise<unknown>): Promise<number> => {
  try {
    await fn();
    return 200;
  } catch (e) {
    if (e instanceof SocietyError) return e.status;
    throw e;
  }
};

function fresh() {
  const d1 = createLocalD1();
  const { alice } = seedCitizens(d1);
  const post = seedPost(d1, alice);
  return { d1, env: guestEnv(d1), post };
}

// ---------- the citizen verifier ----------

test("citizen: two citizens signing the SAME nonce string both authenticate; the stored keys are namespaced by citizen id (mutant: the key is the raw nonce again)", async () => {
  const { d1, env } = fresh();
  try {
    const a = await seedKeyCitizen(d1, "keyed-a");
    const b = await seedKeyCitizen(d1, "keyed-b");
    assert.equal((await authenticate(env, await citizenAssertion(a, null, { nonce: SHARED }))).handle, "keyed-a");
    assert.equal((await authenticate(env, await citizenAssertion(b, null, { nonce: SHARED }))).handle, "keyed-b", "b's identical nonce string was not spent by a");
    assert.deepEqual(nonceRows(d1, "auth_nonces"), [`c:${a.id}:${SHARED}`, `c:${b.id}:${SHARED}`].sort());
  } finally {
    d1.close();
  }
});

test("citizen: the same citizen reusing a nonce is refused as a replay and adds no row (mutant: the constraint is lost)", async () => {
  const { d1, env } = fresh();
  try {
    const a = await seedKeyCitizen(d1, "keyed-a");
    await authenticate(env, await citizenAssertion(a, null, { nonce: SHARED }));
    const again = await citizenAssertion(a, null, { nonce: SHARED });
    assert.equal(await statusOf(() => authenticate(env, again)), 401);
    await assert.rejects(() => authenticate(env, again), /already been used/);
    assert.equal(nonceRows(d1, "auth_nonces").length, 1);
  } finally {
    d1.close();
  }
});

test("citizen: a raw-nonce row left by the previous worker refuses its nonce, even for a different citizen than the one who spent it, before authenticate returns (mutant: the CASE is a plain namespaced value)", async () => {
  const { d1, env } = fresh();
  try {
    const a = await seedKeyCitizen(d1, "keyed-a");
    const b = await seedKeyCitizen(d1, "keyed-b");
    seedRaw(d1, "auth_nonces", SHARED, a.id);
    assert.equal(await statusOf(async () => authenticate(env, await citizenAssertion(a, null, { nonce: SHARED }))), 401, "the spender's own replay");
    assert.equal(await statusOf(async () => authenticate(env, await citizenAssertion(b, null, { nonce: SHARED }))), 401, "and the other citizen's, as the old worker would have refused it");
    assert.deepEqual(nonceRows(d1, "auth_nonces"), [SHARED], "nothing was written");
    // a different nonce is unaffected
    assert.equal((await authenticate(env, await citizenAssertion(a, null, { nonce: newNonce() }))).handle, "keyed-a");
  } finally {
    d1.close();
  }
});

test("citizen, transition: a raw row from an assertion the old worker accepted just before the deploy, future-dated 119 s, still refuses a replay 100 s later; once expired it is collected, and its nonce is then free (mutant: the guard is dropped)", async () => {
  const { d1, env } = fresh();
  try {
    const a = await seedKeyCitizen(d1, "keyed-a");
    const acceptedAt = Date.now();
    const issuedAt = acceptedAt + 119_000; // the old worker's window allows an assertion dated up to 120 s ahead
    const expiresAt = issuedAt + ASSERTION_WINDOW_MS; // 239 s after acceptance
    seedRaw(d1, "auth_nonces", SHARED, a.id, expiresAt);
    // 100 s after acceptance, the new worker: the same assertion is within its own window (dated 19 s ahead) and must be refused
    const later = acceptedAt + 100_000;
    const real = Date.now;
    Date.now = () => later;
    try {
      assert.equal(await statusOf(async () => authenticate(env, await citizenAssertion(a, null, { nonce: SHARED, t: issuedAt }))), 401);
    } finally {
      Date.now = real;
    }
    assert.deepEqual(nonceRows(d1, "auth_nonces"), [SHARED]);
    // after its expiry, any later write collects it (a fake clock past expiry), and the nonce is free again
    Date.now = () => expiresAt + 1_000;
    try {
      assert.equal((await authenticate(env, await citizenAssertion(a, null, { nonce: newNonce(), t: expiresAt + 1_000 }))).handle, "keyed-a");
      assert.equal(nonceRows(d1, "auth_nonces").includes(SHARED), false, "the expired raw row was collected");
    } finally {
      Date.now = real;
    }
  } finally {
    d1.close();
  }
});

// ---------- the three resident consumers ----------

test("resident: two residents binding with the SAME nonce string both succeed; recovery with a reused nonce is refused; keys are namespaced by visitor id (mutant: the key is the raw nonce again)", async () => {
  const { d1, env, post } = fresh();
  try {
    const g1 = await promotedGuest(env, post, "wren");
    const g2 = await promotedGuest(env, post, "robin");
    const kp1 = await genKeypair();
    const kp2 = await genKeypair();
    assert.equal((await bindRoute(env, g1, kp1, { nonce: SHARED })).status, 201);
    assert.equal((await bindRoute(env, g2, kp2, { nonce: SHARED })).status, 201, "the second resident's identical nonce string was not spent by the first");
    assert.deepEqual(nonceRows(d1, "resident_nonces"), [residentNonceKey(g1.number, SHARED), residentNonceKey(g2.number, SHARED)].sort());
    // recovery: one resident reusing its own nonce is refused, the other resident's use of the same string is not
    assert.equal((await recoverRoute(env, g1, kp1, { nonce: "BBBBBBBBBBBBBBBBBBBBBB" })).status, 201);
    const replay = await recoverRoute(env, g1, kp1, { nonce: "BBBBBBBBBBBBBBBBBBBBBB" });
    assert.equal(replay.status, 401);
    assert.match(replay.body.error, /already been used/);
    assert.equal((await recoverRoute(env, g2, kp2, { nonce: "BBBBBBBBBBBBBBBBBBBBBB" })).status, 201);
  } finally {
    d1.close();
  }
});

test("resident bind: a raw-nonce row from the previous worker refuses its nonce and writes nothing (the guest stays unbound; mutant: the CASE is a plain namespaced value)", async () => {
  const { d1, env, post } = fresh();
  try {
    const g = await promotedGuest(env, post, "wren");
    seedRaw(d1, "resident_nonces", SHARED, g.number);
    const r = await bindRoute(env, g, await genKeypair(), { nonce: SHARED });
    assert.equal(r.status, 401);
    assert.match(r.body.error, /already been used/);
    assert.equal(d1.raw.prepare("SELECT public_key FROM guests WHERE visitor_id = ?").get(g.number)!.public_key, null, "no key was bound");
    assert.deepEqual(nonceRows(d1, "resident_nonces"), [SHARED]);
  } finally {
    d1.close();
  }
});

test("resident recover: a raw-nonce row from the previous worker refuses its nonce and the stored token is unchanged (mutant: the CASE is a plain namespaced value)", async () => {
  const { d1, env, post } = fresh();
  try {
    const { guest, kp } = await newResident(env, post, "wren");
    const before = d1.raw.prepare("SELECT token_hash FROM guests WHERE visitor_id = ?").get(guest.number)!.token_hash;
    const visitorBefore = rows(d1, "SELECT * FROM visitors");
    seedRaw(d1, "resident_nonces", SHARED, guest.number);
    const r = await recoverRoute(env, guest, kp, { nonce: SHARED });
    assert.equal(r.status, 401);
    assert.match(r.body.error, /already been used/);
    assert.equal(r.body.token, undefined, "no replacement token was returned");
    assert.equal(d1.raw.prepare("SELECT token_hash FROM guests WHERE visitor_id = ?").get(guest.number)!.token_hash, before, "the token hash is unchanged");
    assert.deepEqual(rows(d1, "SELECT * FROM visitors"), visitorBefore, "the visitors fallback is unchanged too");
    assert.equal(nonceRows(d1, "resident_nonces").filter((n) => n === SHARED).length, 1);
  } finally {
    d1.close();
  }
});

test("resident council ballot: a raw-nonce row from the previous worker refuses its nonce and no ballot row is written (mutant: the CASE is a plain namespaced value)", async () => {
  const c = await councilCast();
  try {
    const m = (await openMotion(c.env, c.sis, "statement", "Nonce")).body.id as number;
    seedRaw(c.d1, "resident_nonces", SHARED, c.wren.number);
    const r = await castBallot(c.env, c.wren, m, "yes", { nonce: SHARED });
    assert.equal(r.status, 401, JSON.stringify(r.body));
    assert.match(r.body.error, /already been used/);
    assert.equal(rows(c.d1, "SELECT * FROM council_ballots").length, 0, "no ballot was written");
    // a fresh nonce still votes
    assert.equal((await castBallot(c.env, c.wren, m, "yes")).status, 201);
  } finally {
    c.d1.close();
  }
});

test("resident council ballot: two residents voting with the SAME nonce string both succeed (mutant: the key is the raw nonce again)", async () => {
  const c = await councilCast();
  try {
    const other = await seedEarned(c.d1, "robin"); // seated before the motion opens: the eligible members are frozen at open
    const m = (await openMotion(c.env, c.sis, "statement", "Shared nonce")).body.id as number;
    assert.equal((await castBallot(c.env, c.wren, m, "yes", { nonce: SHARED })).status, 201);
    assert.equal((await castBallot(c.env, other, m, "no", { nonce: SHARED })).status, 201);
  } finally {
    c.d1.close();
  }
});

// ---------- the batch guard on its own, with a write after it (HW9) ----------

test("the nonce statement is the guard: run in a batch before an UPDATE, a raw collision aborts the batch and the UPDATE does not commit; a namespaced collision too; a fresh nonce commits both (mutants: the CASE is a plain namespaced value; the CASE yields NULL)", async () => {
  const { d1, env, post } = fresh();
  try {
    const g = await promotedGuest(env, post, "wren");
    const a = { nonce: SHARED, issuedAt: Date.now() } as ParsedAssertion;
    const marker = () => d1.raw.prepare("SELECT karma FROM citizens WHERE id = 1").get()!.karma as number;
    const batch = (assertion: ParsedAssertion) => env.DB.batch([nonceStatement(env, assertion, g.number), env.DB.prepare("UPDATE citizens SET karma = karma + 1 WHERE id = 1"), nonceGcStatement(env)]);

    // raw collision
    seedRaw(d1, "resident_nonces", SHARED, g.number);
    const k0 = marker();
    await assert.rejects(() => batch(a), /UNIQUE/);
    assert.equal(marker(), k0, "the UPDATE after a raw collision did not commit");
    assert.deepEqual(nonceRows(d1, "resident_nonces"), [SHARED]);
    d1.raw.prepare("DELETE FROM resident_nonces").run();

    // a fresh nonce commits both, then the same namespaced key collides
    const b = { nonce: "CCCCCCCCCCCCCCCCCCCCCC", issuedAt: Date.now() } as ParsedAssertion;
    await batch(b);
    assert.equal(marker(), k0 + 1);
    await assert.rejects(() => batch(b), /UNIQUE/);
    assert.equal(marker(), k0 + 1, "the namespaced replay's UPDATE did not commit either");
    assert.deepEqual(nonceRows(d1, "resident_nonces"), [residentNonceKey(g.number, "CCCCCCCCCCCCCCCCCCCCCC")]);
  } finally {
    d1.close();
  }
});

test("garbage collection deletes expired rows of BOTH shapes in both tables, and leaves live ones (mutant: the GC predicate is narrowed to one shape)", async () => {
  const { d1, env, post } = fresh();
  try {
    const a = await seedKeyCitizen(d1, "keyed-a");
    const g = await promotedGuest(env, post, "wren");
    const past = Date.now() - 10_000;
    seedRaw(d1, "auth_nonces", "RAWEXPIRED_AUTH_NONCE1", a.id, past);
    seedRaw(d1, "auth_nonces", `c:${a.id}:NAMESPACEDEXPIRED_AUTH`, a.id, past);
    seedRaw(d1, "resident_nonces", "RAWEXPIRED_RESIDENT_NO1", g.number, past);
    seedRaw(d1, "resident_nonces", residentNonceKey(g.number, "NAMESPACEDEXPIRED_RESIDENT"), g.number, past);
    seedRaw(d1, "auth_nonces", "RAWLIVE_AUTH_NONCE_0001", a.id);
    seedRaw(d1, "resident_nonces", "RAWLIVE_RESIDENT_NONCE1", g.number);
    await authenticate(env, await citizenAssertion(a, null, { nonce: newNonce() }));
    assert.equal(nonceRows(d1, "auth_nonces").some((n) => n.includes("EXPIRED")), false, "both expired auth_nonces shapes are gone");
    assert.equal(nonceRows(d1, "auth_nonces").includes("RAWLIVE_AUTH_NONCE_0001"), true);
    assert.equal((await bindRoute(env, g, await genKeypair())).status, 201);
    assert.equal(nonceRows(d1, "resident_nonces").some((n) => n.includes("EXPIRED")), false, "both expired resident_nonces shapes are gone");
    assert.equal(nonceRows(d1, "resident_nonces").includes("RAWLIVE_RESIDENT_NONCE1"), true);
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM resident_nonces"), nonceCount(d1));
  } finally {
    d1.close();
  }
});
