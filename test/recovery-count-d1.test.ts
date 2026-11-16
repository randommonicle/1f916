// R1 of drafts/BRIEF-RECOVERY-UNIT-COMMIT-2026-11-15.md: resident recoveries, served. Migration 0027 adds guests.recoveries and guests.last_recovered_at; BOTH recovery writes bump them in
// the same UPDATE that replaces the token. Real local D1 (node:sqlite over schema.sql) through the real router and the real claim function; the only scaffolding is raw SQL for a trigger that
// makes a later statement of the batch fail, and a gate that decides WHEN a real batch runs. Every block names the mutant that turns it red; docs/CHECKPOINT-RECOVERY-UNIT-COMMIT-2026-11-15.md
// records each one run and restored.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createLocalD1, seedCitizens, seedPost, guestEnv, call, freshIp, guestComment } from "./helpers/guest.ts";
import { newResident, recoverRoute, bindRoute, genKeypair } from "./helpers/resident.ts";
import { world, writtenGuest, bindByAccount, askOk, claim, colonyProof, OUTSIDE_COLONY_ID, COLONY_FIXTURE_COMMENT_ID as CID } from "./helpers/resident-account.ts";
import { RECOVERIES_NOTE, RECOVERIES_SINCE } from "../src/resident.ts";
import type { Env } from "../src/society.ts";

const ROOT = join(import.meta.dirname, "..");
const norm = (s: string) => s.replace(/\r\n/g, "\n");
const migrationSql = () => norm(readFileSync(join(ROOT, "migrations", "0027_resident_recoveries.sql"), "utf8"));
const schemaSql = () => norm(readFileSync(join(ROOT, "schema.sql"), "utf8"));
const HEADER_0027 = "-- Recovery counts and commit days (migrations/0027_resident_recoveries.sql";

function fresh() {
  const d1 = createLocalD1();
  const { maintainer, alice } = seedCitizens(d1);
  const post = seedPost(d1, alice);
  return { d1, env: guestEnv(d1), maintainer, alice, post };
}
type D = ReturnType<typeof createLocalD1>;
const rec = (d1: D, n: number) => d1.raw.prepare("SELECT recoveries, last_recovered_at, token_hash FROM guests WHERE visitor_id = ?").get(n) as { recoveries: number; last_recovered_at: number | null; token_hash: string };
const profile = async (env: Env, n: number) => (await call(env, "GET", `/api/resident/${n}`)).body;

// ---------- the migration ----------

test("R1 migration: 0027 on the pre-0027 schema adds exactly two guests columns (recoveries INTEGER NOT NULL DEFAULT 0, last_recovered_at INTEGER) after resident_at, guests keeps its rows, and the schema.sql tail is the migration's block byte for byte (mutant: one character differs)", () => {
  const full = schemaSql();
  const cut = full.indexOf(HEADER_0027);
  assert.ok(cut > 0, "schema.sql carries the 0027 header");
  const mig = migrationSql();
  const block = mig.slice(mig.indexOf("ALTER TABLE guests ADD COLUMN recoveries"));
  // The 0028 block follows the 0027 block (migrations/0028_maintainer_declines.sql); the 0027 block ends where the 0028 header begins.
  const end0028 = full.indexOf("-- The parked list (migrations/0028_maintainer_declines.sql");
  assert.ok(end0028 > cut, "schema.sql carries the 0028 header after the 0027 block");
  const tail = full.slice(full.indexOf("ALTER TABLE guests ADD COLUMN recoveries", cut), end0028).trimEnd() + "\n";
  assert.equal(tail, block, "schema.sql carries the migration's statements byte for byte, from the first ALTER to the end of the file");
  assert.notEqual(tail.replace("last_recovered_at INTEGER", "last_recovered_at  INTEGER"), block, "a one-character drift fails the comparison");

  const migrated = new DatabaseSync(":memory:");
  const built = new DatabaseSync(":memory:");
  try {
    migrated.exec(full.slice(0, cut));
    migrated.prepare("INSERT INTO guests (visitor_id, token_hash, handle, model, created_at) VALUES (7, 'h', 'kept', 'm', 1)").run();
    const before = (migrated.prepare("SELECT name FROM pragma_table_info('guests')").all() as { name: string }[]).map((c) => c.name);
    migrated.exec(mig);
    built.exec(full);
    const info = (db: DatabaseSync) => db.prepare("SELECT name, type, \"notnull\" AS nn, dflt_value AS d FROM pragma_table_info('guests')").all() as { name: string; type: string; nn: number; d: unknown }[];
    assert.deepEqual(info(migrated), info(built), "the migration lands on what schema.sql builds");
    const cols = info(migrated);
    assert.deepEqual(cols.slice(before.length).map((c) => c.name), ["recoveries", "last_recovered_at"]);
    assert.equal(cols[before.length - 1]!.name, "resident_at");
    assert.deepEqual({ ...cols[before.length]! }, { name: "recoveries", type: "INTEGER", nn: 1, d: "0" });
    assert.deepEqual({ ...cols[before.length + 1]! }, { name: "last_recovered_at", type: "INTEGER", nn: 0, d: null });
    assert.deepEqual({ ...(migrated.prepare("SELECT handle, recoveries, last_recovered_at FROM guests WHERE visitor_id = 7").get() as object) }, { handle: "kept", recoveries: 0, last_recovered_at: null });
    assert.throws(() => migrated.exec(mig.slice(mig.indexOf("ALTER TABLE"))), /duplicate column name/i, "a second apply of the ALTERs fails loudly (the deploy script checks the catalogue first)");
  } finally {
    migrated.close();
    built.close();
  }
});

// ---------- the key route ----------

test("R1 key route: a fresh resident reads recoveries 0 and last_recovered_at null; a recovery bumps both in the same write as the new token, a second makes 2, and the roster and profile serve them (mutant: the UPDATE does not bump)", async () => {
  const { d1, env, post } = fresh();
  try {
    const { guest, kp } = await newResident(env, post, "wren");
    assert.deepEqual({ r: rec(d1, guest.number).recoveries, t: rec(d1, guest.number).last_recovered_at }, { r: 0, t: null });
    const p0 = await profile(env, guest.number);
    assert.equal(p0.recoveries, 0);
    assert.equal(p0.last_recovered_at, null);

    const t1 = Date.now();
    const a = await recoverRoute(env, guest, kp);
    assert.equal(a.status, 201);
    const t2 = Date.now();
    const row = rec(d1, guest.number);
    assert.equal(row.recoveries, 1);
    assert.ok(row.last_recovered_at! >= t1 && row.last_recovered_at! <= t2, "last_recovered_at is the write-time server clock");
    const b = await recoverRoute(env, { ...guest, token: a.body.token }, kp);
    assert.equal(b.status, 201);
    assert.equal(rec(d1, guest.number).recoveries, 2);
    assert.ok(rec(d1, guest.number).last_recovered_at! >= row.last_recovered_at!);

    const p = await profile(env, guest.number);
    assert.equal(p.recoveries, 2);
    assert.equal(p.last_recovered_at, rec(d1, guest.number).last_recovered_at);
    const roster = (await call(env, "GET", "/api/residents")).body;
    assert.equal(roster.residents[0].recoveries, 2);
    assert.equal(roster.residents[0].last_recovered_at, p.last_recovered_at);
    // the definition is served next to counts_toward, makes no history claim beyond its own date, and says what null means
    assert.ok(roster.note.includes(RECOVERIES_NOTE) && p.note.includes(RECOVERIES_NOTE), "the definition is served on the roster and the profile");
    assert.ok(roster.note.indexOf("counts_toward lists") < roster.note.indexOf("recoveries counts"));
    assert.match(RECOVERIES_NOTE, new RegExp(`^recoveries counts the successful token replacements recorded by either recovery route since this field shipped on ${RECOVERIES_SINCE}; last_recovered_at is the latest recorded one, null when none is recorded\\.$`));
    assert.ok(!/never|no earlier/i.test(RECOVERIES_NOTE), "no stronger history claim");
  } finally {
    d1.close();
  }
});

test("R1 mirror: the visitors-token mirror does not bump again, with the visitors row present and with it evicted: one recovery is exactly one (mutant: the mirror statement also bumps)", async () => {
  for (const evict of [false, true]) {
    const { d1, env, post } = fresh();
    try {
      const { guest, kp } = await newResident(env, post, "wren");
      if (evict) d1.raw.prepare("DELETE FROM visitors WHERE id = ?").run(guest.number);
      else assert.ok(d1.raw.prepare("SELECT 1 FROM visitors WHERE id = ?").get(guest.number), "the ring holds the visitor");
      assert.equal((await recoverRoute(env, guest, kp)).status, 201);
      assert.equal(rec(d1, guest.number).recoveries, 1, `evicted: ${evict}`);
      assert.ok(!(d1.raw.prepare("SELECT name FROM pragma_table_info('visitors')").all() as { name: string }[]).some((c) => c.name === "recoveries"), "visitors carries no counter of its own");
    } finally {
      d1.close();
    }
  }
});

test("R1 no bump: a bind (key) and a refused, a replayed, a wrong-key and a lost-race recovery all leave the counters where they were (mutant: the bump moves to the bind, or out of the old-hash condition)", async () => {
  const { d1, env, post } = fresh();
  try {
    const { guest, kp } = await newResident(env, post, "wren"); // a bind happened here
    assert.equal(rec(d1, guest.number).recoveries, 0, "the bind did not bump");
    assert.equal(rec(d1, guest.number).last_recovered_at, null);
    const wrong = await recoverRoute(env, guest, await genKeypair());
    assert.notEqual(wrong.status, 201);
    assert.equal(rec(d1, guest.number).recoveries, 0, "a refused recovery (a key other than the bound one) records nothing");

    const ok = await recoverRoute(env, guest, kp);
    assert.equal(ok.status, 201);
    const afterOne = rec(d1, guest.number);
    assert.equal(afterOne.recoveries, 1);
    // a replay of the same assertion
    const { signRecover } = await import("./helpers/resident.ts");
    const { assertion } = await signRecover(kp, guest.number, guest.handle);
    const send = () => call(env, "POST", "/api/resident/token", { number: guest.number, assertion }, { "CF-Connecting-IP": freshIp() });
    assert.equal((await send()).status, 201);
    assert.equal(rec(d1, guest.number).recoveries, 2);
    const replay = await send();
    assert.ok(replay.status >= 400 && replay.status < 500, `replay refused (${replay.status})`);
    assert.equal(rec(d1, guest.number).recoveries, 2, "a replayed assertion records nothing");

    // a lost race: B is parked at its batch, A completes, B's conditional UPDATE then matches nothing and records nothing
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const db = env.DB;
    const gatedEnv = { ...env, DB: { prepare: (s: string) => db.prepare(s), batch: async (stmts: any) => { await gate; return db.batch(stmts); } } } as unknown as Env;
    const pendingB = recoverRoute(gatedEnv, { ...guest, token: "unused" }, kp);
    await new Promise((r) => setTimeout(r, 30));
    const a = await recoverRoute(env, guest, kp);
    assert.equal(a.status, 201);
    assert.equal(rec(d1, guest.number).recoveries, 3);
    release();
    assert.equal((await pendingB).status, 409);
    assert.equal(rec(d1, guest.number).recoveries, 3, "the loser of a lost race added nothing: one token replaced, one recovery recorded");
  } finally {
    d1.close();
  }
});

test("R1 rollback: a batch that fails after the token UPDATE rolls the counters back with the token (a trigger on visitors makes the mirror statement fail; mutant: the bump runs as a separate write outside the batch)", async () => {
  const { d1, env, post } = fresh();
  try {
    const { guest, kp } = await newResident(env, post, "wren");
    const before = rec(d1, guest.number);
    d1.raw.exec("CREATE TRIGGER boom BEFORE UPDATE ON visitors BEGIN SELECT RAISE(ABORT, 'forced failure'); END");
    const r = await recoverRoute(env, guest, kp);
    assert.notEqual(r.status, 201, "the recovery did not succeed");
    assert.deepEqual({ ...rec(d1, guest.number) }, { ...before }, "token hash, recoveries and last_recovered_at are all as they were");
    d1.raw.exec("DROP TRIGGER boom");
    assert.equal((await guestComment(env, guest.token, { post_id: post, body: "the original token still works" })).status, 201);
  } finally {
    d1.close();
  }
});

// ---------- the account route ----------

test("R1 account route: a recovery by the bound account bumps both fields in the token-replacing UPDATE; the bind does not; a lost-race loser and a failed batch record nothing (mutant: the account UPDATE does not bump)", async () => {
  const { d1, env, post } = world();
  try {
    const g = await writtenGuest(env, post, "wren");
    await bindByAccount(env, g, "colony", { accountId: OUTSIDE_COLONY_ID, username: "wren-outside" });
    assert.deepEqual({ ...rec(d1, g.number) }.recoveries, 0, "the account bind did not bump");
    assert.equal(rec(d1, g.number).last_recovered_at, null);

    const t1 = Date.now();
    const ch = await askOk(env, { number: g.number }, "colony");
    const out = await claim(env, { number: g.number }, ch, "colony", CID, colonyProof(ch, { accountId: OUTSIDE_COLONY_ID, username: "wren-outside" }));
    assert.ok(out.ok, JSON.stringify(out));
    const row = rec(d1, g.number);
    assert.equal(row.recoveries, 1);
    assert.ok(row.last_recovered_at! >= t1 && row.last_recovered_at! <= Date.now());
    const p = await profile(env, g.number);
    assert.equal(p.recoveries, 1);
    assert.equal(p.last_recovered_at, row.last_recovered_at);

    // a failed batch (trigger on the visitors mirror) rolls the bump back with the token
    d1.raw.exec("CREATE TRIGGER boom BEFORE UPDATE ON visitors BEGIN SELECT RAISE(ABORT, 'forced failure'); END");
    const before = rec(d1, g.number);
    const ch2 = await askOk(env, { number: g.number }, "colony");
    await assert.rejects(claim(env, { number: g.number }, ch2, "colony", CID, colonyProof(ch2, { accountId: OUTSIDE_COLONY_ID, username: "wren-outside" })).then((o) => { if (o.ok) throw new Error("unexpected success"); throw new Error(`refused ${o.status}`); }), /refused|forced failure/);
    assert.deepEqual({ ...rec(d1, g.number) }, { ...before }, "a failed batch records nothing");
    d1.raw.exec("DROP TRIGGER boom");

    // a lost race: a competing recovery lands between the claim's reads and its batch
    const real = env.DB as any;
    let fired = false;
    const raced = { ...env, DB: { prepare: (s: string) => real.prepare(s), batch: async (stmts: any[]) => {
      if (!fired && stmts.some((s) => /UPDATE guests SET token_hash/.test(s.__sql))) { fired = true; d1.raw.prepare("UPDATE guests SET token_hash = 'replaced-by-a-key-recovery', recoveries = recoveries + 1 WHERE visitor_id = ?").run(g.number); }
      return real.batch(stmts);
    } } } as Env;
    const ch3 = await askOk(env, { number: g.number }, "colony");
    const lost = await claim(raced, { number: g.number }, ch3, "colony", CID, colonyProof(ch3, { accountId: OUTSIDE_COLONY_ID, username: "wren-outside" }));
    assert.ok(!lost.ok && lost.status === 409, "the loser is refused");
    assert.equal(rec(d1, g.number).recoveries, 2, "only the competing recovery counted: 1 + 1, the loser added nothing");
  } finally {
    d1.close();
  }
});

test("R1 account bind in a key resident: binding an account to a key resident does not bump (mutant: the bump is on every guests UPDATE)", async () => {
  const { d1, env, post } = world();
  try {
    const g = await writtenGuest(env, post, "wren");
    assert.equal((await bindRoute(env, g, await genKeypair())).status, 201);
    await bindByAccount(env, g, "colony", { accountId: OUTSIDE_COLONY_ID, username: "wren-outside" });
    assert.equal(rec(d1, g.number).recoveries, 0);
    assert.equal(rec(d1, g.number).last_recovered_at, null);
  } finally {
    d1.close();
  }
});
