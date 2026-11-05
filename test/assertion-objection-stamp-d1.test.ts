// The write side of an upheld objection (D-078 item 4 option B; drafts/BRIEF-ASSERTION-OBJECTION-2026-11-05.md O2, O3, O7; OT1-OT7). Real local D1 (node:sqlite + schema.sql),
// the real router and both real MCP doors, real Ed25519 keys, the fake-Date.now helper. The operator's statements are READ OUT OF scripts/assertion-objection.ps1 (its two SQL templates, the
// handle substituted as the script does), so what runs here is the exact text the script sends; the flag time is the database's own clock. Each block names the mutant that turns it red;
// docs/CHECKPOINT-LAST-ASSERTION-AT.md records each run.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, seedCitizens, guestEnv, call, freshIp } from "./helpers/guest.ts";
import { seedKeyCitizen, seedSecretCitizen, citizenAssertion, bearerHeader, withClock, rows } from "./helpers/council.ts";
import { genKeypair } from "./helpers/resident.ts";
import { authenticate, SocietyError } from "../src/society.ts";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PS = readFileSync(join(import.meta.dirname, "..", "scripts", "assertion-objection.ps1"), "utf8").split("\r\n").join("\n");
const template = (name: string): string => {
  const m = PS.match(new RegExp("^[$]" + name + ' = "(.*)"$', "m"));
  if (!m) throw new Error("template not found in the script: " + name);
  return m[1]!;
};
export const UPHOLD_TEMPLATE = template("UPHOLD_SQL_TEMPLATE");
export const WITHDRAW_TEMPLATE = template("WITHDRAW_SQL_TEMPLATE");

const REPLAY_TEXT = "That assertion has already been used. Each one is single-use; sign a fresh one.";
const T0 = 1_800_000_000_000;
const stampOf = (d1: any, id: number): number | null => (d1.raw.prepare("SELECT last_assertion_at AS v FROM citizens WHERE id = ?").get(id) as { v: number | null }).v;
const flagOf = (d1: any, id: number): number | null => (d1.raw.prepare("SELECT assertion_objected_at AS v FROM citizens WHERE id = ?").get(id) as { v: number | null }).v;
const nonceRows = (d1: any): string[] => rows<{ nonce: string }>(d1, "SELECT nonce FROM auth_nonces ORDER BY nonce").map((r) => r.nonce);
const hdr = (assertion: string) => bearerHeader(assertion, freshIp());
const uphold = (d1: any, handle: string) => Number(d1.raw.prepare(UPHOLD_TEMPLATE.replace("@HANDLE@", handle)).run().changes);
const withdraw = (d1: any, handle: string) => Number(d1.raw.prepare(WITHDRAW_TEMPLATE.replace("@HANDLE@", handle)).run().changes);
const isFlag = (v: number | null): boolean => typeof v === "number" && Number.isInteger(v) && v > 0;
const row = (body: any, handle: string) => body.citizens.find((c: { handle: string }) => c.handle === handle);

async function door(env: any, path: string): Promise<any> {
  const r = await call(env, "POST", path, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "citizens", arguments: {} } }, { "CF-Connecting-IP": "203.0.113.9" });
  assert.equal(r.status, 200, path);
  return JSON.parse(r.body.result.content[0].text);
}

test("OT1: a flagged seat authenticates, acts and spends its nonce, and the stamp stays NULL (mutant: the O2 condition is dropped from the stamp UPDATE)", async () => {
  const d1 = createLocalD1();
  try {
    const env = guestEnv(d1);
    const k = await seedKeyCitizen(d1, "keyed-a");
    assert.equal(uphold(d1, "keyed-a"), 1);
    const r = await withClock(T0 + 10_000, async () => call(env, "GET", "/api/me", undefined, hdr(await citizenAssertion(k, null, { t: T0 + 10_000 }))));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(stampOf(d1, k.id), null, "no stamp for a flagged seat");
    assert.equal(nonceRows(d1).length, 1, "the nonce was spent exactly as before");
    assert.ok(isFlag(flagOf(d1, k.id)), "and the flag is untouched by authenticating");
  } finally {
    d1.close();
  }
});

test("OT2: the uphold statement clears an existing value and sets the flag in ONE row; a secret-held seat and an unknown handle change zero rows (mutant: the clear is omitted)", async () => {
  const d1 = createLocalD1();
  try {
    const env = guestEnv(d1);
    const k = await seedKeyCitizen(d1, "keyed-a");
    const other = await seedKeyCitizen(d1, "keyed-b");
    const s = await seedSecretCitizen(d1, "bearer-a");
    await withClock(T0, async () => authenticate(env, await citizenAssertion(k)));
    await withClock(T0, async () => authenticate(env, await citizenAssertion(other)));
    assert.equal(stampOf(d1, k.id), T0, "a stamp exists before the objection");
    assert.equal(uphold(d1, "keyed-a"), 1);
    assert.equal(stampOf(d1, k.id), null, "the stored value is gone, not masked");
    assert.ok(isFlag(flagOf(d1, k.id)), "the flag is the database clock, a whole number of ms");
    assert.ok(Math.abs((flagOf(d1, k.id) as number) - Date.now()) < 60_000, "and it is recent");
    assert.equal(stampOf(d1, other.id), T0, "another seat is untouched");
    assert.equal(flagOf(d1, other.id), null);
    assert.equal(uphold(d1, "bearer-a"), 0, "a secret-held seat has no value to object to");
    assert.equal(flagOf(d1, s.id), null);
    assert.equal(uphold(d1, "no-such-handle"), 0);
    assert.equal(uphold(d1, "KEYED-B"), 1, "handle matching is the column's NOCASE");
  } finally {
    d1.close();
  }
});

test("OT4: a replay on a flagged seat still gets the same 401 and writes nothing (mutant: the O2 condition is dropped, which stamps the replayed-then-flagged seat)", async () => {
  const d1 = createLocalD1();
  try {
    const env = guestEnv(d1);
    const k = await seedKeyCitizen(d1, "keyed-a");
    uphold(d1, "keyed-a");
    const token = await withClock(T0, () => citizenAssertion(k));
    await withClock(T0, () => authenticate(env, token));
    const before = nonceRows(d1);
    assert.equal(before.length, 1);
    let got: unknown;
    try {
      await withClock(T0 + 5_000, () => authenticate(env, token));
    } catch (e) {
      got = e instanceof SocietyError ? { status: e.status, message: e.message } : e;
    }
    assert.deepEqual(got, { status: 401, message: REPLAY_TEXT });
    assert.deepEqual(nonceRows(d1), before);
    assert.equal(stampOf(d1, k.id), null);
    assert.ok(isFlag(flagOf(d1, k.id)));
  } finally {
    d1.close();
  }
});

test("OT5: the census, /mcp and /mcp/read all serve null for a flagged seat with the key present on every row, even where a stamp was taken first (mutant: the stamp condition dropped)", async () => {
  const d1 = createLocalD1();
  try {
    seedCitizens(d1);
    const env = guestEnv(d1);
    const k = await seedKeyCitizen(d1, "keyed-a");
    const other = await seedKeyCitizen(d1, "keyed-b");
    await withClock(T0, async () => authenticate(env, await citizenAssertion(k)));
    await withClock(T0, async () => authenticate(env, await citizenAssertion(other)));
    uphold(d1, "keyed-a");
    await withClock(T0 + 20_000, async () => authenticate(env, await citizenAssertion(k, null, { t: T0 + 20_000 })));
    const rest = await call(env, "GET", "/api/citizens");
    for (const c of rest.body.citizens) assert.ok("last_assertion_at" in c, `${c.handle} carries the key`);
    assert.equal(row(rest.body, "keyed-a").last_assertion_at, null);
    assert.equal(row(rest.body, "keyed-b").last_assertion_at, T0, "a seat that did not object still shows its time");
    for (const p of ["/mcp", "/mcp/read"]) {
      const body = await door(env, p);
      assert.deepEqual(body, rest.body, `${p} serves what REST serves`);
      assert.equal(row(body, "keyed-a").last_assertion_at, null);
      assert.ok(body.citizens.every((c: any) => "last_assertion_at" in c));
    }
    assert.equal(JSON.stringify(rest.body).includes("assertion_objected_at"), false, "no marker is published");
    assert.equal(JSON.stringify(rest.body).includes("objected"), false);
  } finally {
    d1.close();
  }
});

test("OT6: withdraw clears the flag, the value stays NULL, and the next assertion stamps again (mutant: withdraw clears the stamp column instead of the flag)", async () => {
  const d1 = createLocalD1();
  try {
    const env = guestEnv(d1);
    const k = await seedKeyCitizen(d1, "keyed-a");
    await withClock(T0, async () => authenticate(env, await citizenAssertion(k)));
    uphold(d1, "keyed-a");
    assert.equal(withdraw(d1, "keyed-a"), 1);
    assert.equal(flagOf(d1, k.id), null);
    assert.equal(stampOf(d1, k.id), null, "the withdrawal does not restore the cleared value");
    const t2 = T0 + 30_000;
    await withClock(t2, async () => authenticate(env, await citizenAssertion(k, null, { t: t2 })));
    assert.equal(stampOf(d1, k.id), t2);
    assert.equal(withdraw(d1, "bearer-nobody"), 0);
  } finally {
    d1.close();
  }
});

test("OT7: the flag is per seat: rotating the key leaves it set and an assertion from the new key does not stamp (mutant: rotation clears the flag)", async () => {
  const d1 = createLocalD1();
  try {
    const env = guestEnv(d1);
    const k = await seedKeyCitizen(d1, "keyed-a");
    uphold(d1, "keyed-a");
    const fresh = await genKeypair();
    const rot = await withClock(T0 + 1_000, async () => call(env, "POST", "/api/rotate", { public_key: fresh.publicKey }, hdr(await citizenAssertion(k, fresh.publicKey, { t: T0 + 1_000 }))));
    assert.equal(rot.status, 200, JSON.stringify(rot.body));
    assert.ok(isFlag(flagOf(d1, k.id)), "rotation did not clear the flag");
    assert.equal(stampOf(d1, k.id), null);
    const t2 = T0 + 60_000;
    const me = await withClock(t2, async () => call(env, "GET", "/api/me", undefined, hdr(await citizenAssertion({ handle: k.handle, kp: fresh }, null, { t: t2 }))));
    assert.equal(me.status, 200);
    assert.equal(stampOf(d1, k.id), null, "the new key does not stamp either");
    assert.ok(isFlag(flagOf(d1, k.id)));
  } finally {
    d1.close();
  }
});
