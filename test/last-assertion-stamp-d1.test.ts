// The write side of citizens.last_assertion_at (D-078 item 4; drafts/BRIEF-LAST-ASSERTION-AT-2026-11-04.md B2, A5, A6; T1-T8, T11). Real local D1 (node:sqlite + schema.sql),
// the real router, real Ed25519 keys. Nothing of ours is mocked: the clock is the fake-Date.now helper the council tests use, and the only wrapper is a recording
// pass-through around env.DB.batch for the execution-order test. Each block names the mutant that turns it red; docs/CHECKPOINT-LAST-ASSERTION-AT.md records each run.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createLocalD1, guestEnv, call, freshIp } from "./helpers/guest.ts";
import { withoutLastAssertionColumn } from "./helpers/local-d1.ts";
import { seedKeyCitizen, seedSecretCitizen, citizenAssertion, bearerHeader, withClock, rows } from "./helpers/council.ts";
import { genKeypair, sign } from "./helpers/resident.ts";
import { insertProposal } from "./helpers/local-d1.ts";
import { authenticate, utcMidnight, SocietyError } from "../src/society.ts";
import { ASSERTION_WINDOW_MS } from "../src/keyauth.ts";

const REPLAY_TEXT = "That assertion has already been used. Each one is single-use; sign a fresh one.";
const T0 = 1_800_000_000_000;
const DAY = 86_400_000;
const stampOf = (d1: any, id: number): number | null => (d1.raw.prepare("SELECT last_assertion_at AS v FROM citizens WHERE id = ?").get(id) as { v: number | null }).v;
const nonceRows = (d1: any): string[] => rows<{ nonce: string }>(d1, "SELECT nonce FROM auth_nonces ORDER BY nonce").map((r) => r.nonce);
const hdr = (assertion: string) => bearerHeader(assertion, freshIp());
async function refusal(fn: () => Promise<unknown>): Promise<{ status: number; message: string }> {
  try {
    await fn();
  } catch (e) {
    if (e instanceof SocietyError) return { status: e.status, message: e.message };
    throw e;
  }
  throw new Error("expected a refusal");
}

test("T1: a fresh key seat is null; one assertion at issuedAt 100 s back stamps the UTC day of the SERVER's now, not the signer's time and not the millisecond (mutants: the stamp binds a.issuedAt; the stamp binds now)", async () => {
  const d1 = createLocalD1();
  try {
    const env = guestEnv(d1);
    const k = await seedKeyCitizen(d1, "keyed-a");
    assert.equal(stampOf(d1, k.id), null);
    const issued = T0 - 100_000;
    const r = await withClock(T0, async () => call(env, "GET", "/api/me", undefined, hdr(await citizenAssertion(k, null, { t: issued }))));
    assert.equal(r.status, 200);
    assert.equal(stampOf(d1, k.id), utcMidnight(T0));
    assert.notEqual(stampOf(d1, k.id), issued);
  } finally {
    d1.close();
  }
});

test("T2: no stamp and no nonce burnt on a bad signature, a wrong audience, an expired assertion, a malformed one, or a resident-bound binding (mutant: the batch runs before the signature or the binding check)", async () => {
  const d1 = createLocalD1();
  try {
    const env = guestEnv(d1);
    const k = await seedKeyCitizen(d1, "keyed-a");
    const other = await genKeypair();
    const cases: [string, string, number][] = [
      ["bad signature", await withClock(T0, () => citizenAssertion({ handle: k.handle, kp: other })), 401],
      ["wrong audience", (await withClock(T0, () => sign(k.kp, { handle: k.handle, binding: null, audience: "https://elsewhere.example" }))).assertion, 401],
      ["expired", await withClock(T0, () => citizenAssertion(k, null, { t: T0 - ASSERTION_WINDOW_MS - 5_000 })), 401],
      ["malformed", "ch1.not-an-assertion", 401],
      ["resident-bound", await withClock(T0, () => citizenAssertion(k, "resident_bind:abc")), 403],
    ];
    for (const [name, token, status] of cases) {
      const r = await withClock(T0, async () => refusal(() => authenticate(env, token)));
      assert.equal(r.status, status, name);
      assert.equal(stampOf(d1, k.id), null, `${name}: no stamp`);
      assert.deepEqual(nonceRows(d1), [], `${name}: no nonce burnt`);
    }
  } finally {
    d1.close();
  }
});

test("T3: the first spend stamps; the replay, a later server time inside the window, gets the same 401 text and moves neither the stamp nor the nonce rows (mutant: the stamp runs as its own statement before the batch)", async () => {
  const d1 = createLocalD1();
  try {
    const env = guestEnv(d1);
    const k = await seedKeyCitizen(d1, "keyed-a");
    const token = await withClock(T0, () => citizenAssertion(k));
    await withClock(T0, () => authenticate(env, token));
    assert.equal(stampOf(d1, k.id), utcMidnight(T0));
    const before = nonceRows(d1);
    const r = await withClock(T0 + 5_000, () => refusal(() => authenticate(env, token)));
    assert.deepEqual(r, { status: 401, message: REPLAY_TEXT });
    assert.equal(stampOf(d1, k.id), utcMidnight(T0), "the replay did not advance the stamp");
    assert.deepEqual(nonceRows(d1), before);
  } finally {
    d1.close();
  }
});

test("T3 raw-nonce path: a legacy raw nonce row refuses the namespaced spend with the same 401 text, with a null stamp and with an existing stamp, and stamps nothing (mutant: the CASE guard is dropped from the batched INSERT)", async () => {
  for (const existing of [null, T0 - 1_000]) {
    const d1 = createLocalD1();
    try {
      const env = guestEnv(d1);
      const k = await seedKeyCitizen(d1, "keyed-a");
      if (existing !== null) d1.raw.prepare("UPDATE citizens SET last_assertion_at = ? WHERE id = ?").run(existing, k.id);
      const nonce = "RAWNONCERAWNONCE0123456789";
      d1.raw.prepare("INSERT INTO auth_nonces (nonce, citizen_id, expires_at) VALUES (?, ?, ?)").run(nonce, k.id, T0 + 100_000);
      const token = await withClock(T0, () => citizenAssertion(k, null, { nonce }));
      const r = await withClock(T0, () => refusal(() => authenticate(env, token)));
      assert.deepEqual(r, { status: 401, message: REPLAY_TEXT });
      assert.equal(stampOf(d1, k.id), existing);
      assert.deepEqual(nonceRows(d1), [nonce]);
    } finally {
      d1.close();
    }
  }
});

test("T4: with the column absent (a worker deployed before 0024) the request fails closed with a 500 and the nonce is NOT burnt (mutant: the batch is two awaited .run() calls)", async () => {
  const d1 = createLocalD1({ schemaTransform: withoutLastAssertionColumn });
  try {
    const env = guestEnv(d1);
    const k = await seedKeyCitizen(d1, "keyed-a");
    const r = await withClock(T0, async () => call(env, "GET", "/api/me", undefined, hdr(await citizenAssertion(k))));
    assert.equal(r.status, 500);
    assert.deepEqual(nonceRows(d1), [], "the INSERT rolled back with the failed UPDATE");
  } finally {
    d1.close();
  }
});

test("T5: the stamp is monotonic: a stored later value is not moved backwards by an assertion with an earlier server time (mutant: the guard is dropped)", async () => {
  const d1 = createLocalD1();
  try {
    const env = guestEnv(d1);
    const k = await seedKeyCitizen(d1, "keyed-a");
    d1.raw.prepare("UPDATE citizens SET last_assertion_at = ? WHERE id = ?").run(utcMidnight(T0) + DAY, k.id);
    await withClock(T0, async () => authenticate(env, await citizenAssertion(k)));
    assert.equal(stampOf(d1, k.id), utcMidnight(T0) + DAY);
    await withClock(T0 + 2 * DAY, async () => authenticate(env, await citizenAssertion(k, null, { t: T0 + 2 * DAY })));
    assert.equal(stampOf(d1, k.id), utcMidnight(T0) + 2 * DAY, "and it does move forward");
  } finally {
    d1.close();
  }
});

test("T6: a route that refuses after authentication still leaves the stamp (an unbound ballot is a 403) (mutant: the stamp statement is removed)", async () => {
  const d1 = createLocalD1();
  try {
    const env = guestEnv(d1);
    const k = await seedKeyCitizen(d1, "keyed-a");
    const proposal = insertProposal(d1, { kind: "resolution", status: "open" });
    const r = await withClock(T0, async () => call(env, "POST", `/api/proposal/${proposal}/ballot`, { choice: "yes" }, hdr(await citizenAssertion(k))));
    assert.equal(r.status, 403);
    assert.equal(stampOf(d1, k.id), utcMidnight(T0));
    assert.equal(nonceRows(d1).length, 1);
  } finally {
    d1.close();
  }
});

test("T7: a bearer seat authenticates and stays null (mutant: the stamp is written on the bearer path)", async () => {
  const d1 = createLocalD1();
  try {
    const env = guestEnv(d1);
    const s = await seedSecretCitizen(d1, "bearer-a");
    const r = await call(env, "GET", "/api/me", undefined, bearerHeader(s.secret));
    assert.equal(r.status, 200);
    assert.equal(stampOf(d1, s.id), null);
  } finally {
    d1.close();
  }
});

test("T8 (A6): rotation authenticates with the old key and stamps t1, the handler does not clear it, and the new key's later assertion stamps t2 (mutant: rotation clears the column)", async () => {
  const d1 = createLocalD1();
  try {
    const env = guestEnv(d1);
    const k = await seedKeyCitizen(d1, "keyed-a");
    const fresh = await genKeypair();
    const t1 = T0;
    const rot = await withClock(t1, async () => call(env, "POST", "/api/rotate", { public_key: fresh.publicKey }, hdr(await citizenAssertion(k, fresh.publicKey))));
    assert.equal(rot.status, 200, JSON.stringify(rot.body));
    assert.equal(stampOf(d1, k.id), utcMidnight(t1));
    const t2 = T0 + DAY;
    const me = await withClock(t2, async () => call(env, "GET", "/api/me", undefined, hdr(await citizenAssertion({ handle: k.handle, kp: fresh }, null, { t: t2 }))));
    assert.equal(me.status, 200);
    assert.equal(stampOf(d1, k.id), utcMidnight(t2));
  } finally {
    d1.close();
  }
});

test("T11: the stamp sits after the signature check and the resident-binding refusal in the source, and executes as ONE batch of [nonce INSERT, stamp UPDATE], never for a refused assertion (mutant: the stamp runs before the batch, or the signature check is off)", async () => {
  const src = readFileSync(join(import.meta.dirname, "..", "src", "society.ts"), "utf8");
  const fn = src.slice(src.indexOf("async function authenticateByAssertion("), src.indexOf("export function assertValidHandle"));
  const verifyAt = fn.indexOf("verifyAssertion(row.public_key, a)");
  const bindAt = fn.indexOf("resident_[a-z_]+:");
  const batchAt = fn.indexOf("env.DB.batch(");
  const insertAt = fn.indexOf("INSERT INTO auth_nonces");
  const stampAt = fn.indexOf("UPDATE citizens SET last_assertion_at");
  assert.ok(verifyAt > 0 && bindAt > verifyAt && batchAt > bindAt && insertAt > batchAt && stampAt > insertAt, "text order: signature, binding refusal, batch, nonce INSERT, stamp UPDATE");

  const d1 = createLocalD1();
  try {
    const log: string[][] = [];
    const env = guestEnv(d1);
    const realBatch = d1.DB.batch.bind(d1.DB);
    (env as any).DB = { ...d1.DB, prepare: d1.DB.prepare.bind(d1.DB), batch: async (stmts: any[]) => (log.push(stmts.map((s) => s.__sql as string)), realBatch(stmts)) };
    const k = await seedKeyCitizen(d1, "keyed-a");
    const other = await genKeypair();
    await refusal(() => withClock(T0, async () => authenticate(env, await citizenAssertion({ handle: k.handle, kp: other }))));
    assert.equal(log.length, 0, "a wrongly signed assertion never reaches the batch");
    await withClock(T0, async () => authenticate(env, await citizenAssertion(k)));
    assert.equal(log.length, 1);
    assert.equal(log[0]!.length, 2);
    assert.match(log[0]![0]!, /^INSERT INTO auth_nonces/);
    assert.match(log[0]![1]!, /^UPDATE citizens SET last_assertion_at/);
  } finally {
    d1.close();
  }
});

test("Ruling 3 (day, not millisecond): a second assertion on the same UTC day writes nothing to the column, the first of the next day writes once, and the value is always a day start (mutants: the guard's < becomes <=; the stamp binds now)", async () => {
  const d1 = createLocalD1();
  try {
    const env = guestEnv(d1);
    const k = await seedKeyCitizen(d1, "keyed-a");
    d1.raw.exec("CREATE TABLE stamp_writes (v INTEGER); CREATE TRIGGER log_stamp AFTER UPDATE OF last_assertion_at ON citizens BEGIN INSERT INTO stamp_writes VALUES (NEW.last_assertion_at); END;");
    const writes = () => (d1.raw.prepare("SELECT v FROM stamp_writes ORDER BY rowid").all() as Array<{ v: number }>).map((r) => r.v);
    const day = utcMidnight(T0);
    for (const t of [T0, T0 + 60_000, day + DAY - 1]) {
      await withClock(t, async () => authenticate(env, await citizenAssertion(k, null, { t })));
    }
    assert.deepEqual(writes(), [day], "three assertions on one day, one write");
    await withClock(day + DAY, async () => authenticate(env, await citizenAssertion(k, null, { t: day + DAY })));
    assert.deepEqual(writes(), [day, day + DAY], "the next day's first assertion writes its day start");
    assert.equal(stampOf(d1, k.id)! % DAY, 0);
  } finally {
    d1.close();
  }
});
