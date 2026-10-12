// H2, H3 and H4 of the 12 Oct hardening wave (docs/CHECKPOINT-HARDENING.md C2; drafts/BRIEF-HARDENING-SEATS-2026-10-12.md H2-H4, HW5-HW7): the resident per-address step is one
// conditional INSERT that decides the per-address cap, the attempt-row ceiling and the reservation; requests with no address share one bucket; each helper collects only its own
// path, by the index; and a replayed, signature-valid assertion is refused before it takes a global slot.
// Real local D1 through the real router, real Ed25519 keys. Each block names the mutant that turns it red; the checkpoint records each run.
//
// Run just this file: node --experimental-strip-types --test "test/resident-attempt-ceiling-d1.test.ts"

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createLocalD1, seedCitizens, seedPost, guestEnv, call, count, freshIp } from "./helpers/guest.ts";
import { promotedGuest, genKeypair, newResident, nonceCount, bindRoute, recoverRoute } from "./helpers/resident.ts";
import { sha256Hex } from "../src/chain.ts";
import {
  RESIDENT_ATTEMPT_ROWS_PER_HOUR,
  RESIDENT_BIND_GLOBAL_PER_HOUR,
  RESIDENT_BIND_PER_IP_PER_HOUR,
  RESIDENT_RECOVER_PER_IP_PER_HOUR,
  residentNonceKey,
} from "../src/resident.ts";
import { assertShowhomeAddressCap } from "../src/showhome.ts";
import { SocietyError, type Env } from "../src/society.ts";

type D1 = ReturnType<typeof createLocalD1>;
const HOUR = 3_600_000;
const DAY = 86_400_000;

function fresh() {
  const d1 = createLocalD1();
  const { alice } = seedCitizens(d1);
  const post = seedPost(d1, alice);
  return { d1, env: guestEnv(d1), post };
}
const pathRows = (d1: D1, path: string): number => count(d1, "SELECT COUNT(*) AS n FROM showhome_rate WHERE path = ?", path);
const guestRow = (d1: D1, n: number) => d1.raw.prepare("SELECT * FROM guests WHERE visitor_id = ?").get(n) as Record<string, any>;

// `n` recent attempt rows for `path`, each from its own address (what many addresses' junk would have left).
async function fillAttempts(d1: D1, path: string, n: number, createdAt = Date.now() - 1000): Promise<void> {
  const stmt = d1.raw.prepare("INSERT INTO showhome_rate (path, ip_hash, created_at) VALUES (?, ?, ?)");
  for (let i = 0; i < n; i++) stmt.run(path, await sha256Hex("showhome:10.255." + Math.floor(i / 250) + "." + (i % 250)), createdAt);
}
// Rows of `path` aged out of the window and past the day.
const seedOld = (d1: D1, path: string, n = 3): void => {
  const stmt = d1.raw.prepare("INSERT INTO showhome_rate (path, ip_hash, created_at) VALUES (?, ?, ?)");
  for (let i = 0; i < n; i++) stmt.run(path, "oldhash" + i, Date.now() - 2 * DAY);
};

// ---------- the ceiling (H2, HW6) ----------

test("the ceiling: at RESIDENT_ATTEMPT_ROWS_PER_HOUR rows for the path, a valid bind from a fresh address proceeds to verify, adds NO attempt row and is NOT refused (mutants: the ceiling is dropped, so the address count alone decides and a row is added; the ceiling refuses 429)", async () => {
  const { d1, env, post } = fresh();
  try {
    const g = await promotedGuest(env, post, "wren");
    await fillAttempts(d1, "bind", RESIDENT_ATTEMPT_ROWS_PER_HOUR);
    assert.equal(pathRows(d1, "bind"), RESIDENT_ATTEMPT_ROWS_PER_HOUR);
    const r = await bindRoute(env, g, await genKeypair());
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(pathRows(d1, "bind"), RESIDENT_ATTEMPT_ROWS_PER_HOUR, "the per-address step wrote no row at the ceiling");
    assert.equal(pathRows(d1, "bind_global"), 1, "the verified request still met the global cap");
    assert.ok(guestRow(d1, g.number).public_key, "and bound");
  } finally {
    d1.close();
  }
});

test("the ceiling: one below it a row is written; an address already at its OWN cap is then bypassed rather than refused (the stated give-up); the unverified request writes nothing more (mutants: the ceiling is off by one; the bypass still applies the per-address cap)", async () => {
  const { d1, env, post } = fresh();
  try {
    const ip = freshIp();
    // the address is at its own cap before the ceiling is reached
    for (let i = 0; i < RESIDENT_BIND_PER_IP_PER_HOUR; i++) {
      const r = await call(env, "POST", "/api/resident/bind", { token: "x" }, { "CF-Connecting-IP": ip });
      assert.equal(r.status, 401, "an unknown token is refused at authentication, not by a cap");
    }
    const sixth = await call(env, "POST", "/api/resident/bind", { token: "x" }, { "CF-Connecting-IP": ip });
    assert.equal(sixth.status, 429, "under the ceiling the per-address cap refuses");
    assert.match(sixth.body.error, /Too many key-binding attempts from your address/);
    assert.equal(pathRows(d1, "bind"), RESIDENT_BIND_PER_IP_PER_HOUR);
    // bring the path to one row below the ceiling: one more attempt is recorded
    await fillAttempts(d1, "bind", RESIDENT_ATTEMPT_ROWS_PER_HOUR - 1 - RESIDENT_BIND_PER_IP_PER_HOUR);
    assert.equal(pathRows(d1, "bind"), RESIDENT_ATTEMPT_ROWS_PER_HOUR - 1);
    const other = await call(env, "POST", "/api/resident/bind", { token: "x" }, { "CF-Connecting-IP": freshIp() });
    assert.equal(other.status, 401);
    assert.equal(pathRows(d1, "bind"), RESIDENT_ATTEMPT_ROWS_PER_HOUR, "that one wrote its row, reaching the ceiling");
    // now the same address, still at its own cap, goes on to verify instead of being refused
    const bypassed = await call(env, "POST", "/api/resident/bind", { token: "x" }, { "CF-Connecting-IP": ip });
    assert.equal(bypassed.status, 401, `the ceiling bypasses the per-address cap: ${JSON.stringify(bypassed.body)}`);
    assert.equal(pathRows(d1, "bind"), RESIDENT_ATTEMPT_ROWS_PER_HOUR, "no row added above the ceiling");
  } finally {
    d1.close();
  }
});

// The local D1 runs a statement to completion before the next starts, so a test cannot make two requests overlap. It CAN land other requests' rows in the exact window between a
// helper's last read and its INSERT: this wraps env.DB so `beforeInsert` runs immediately before any INSERT INTO showhome_rate executes (the database is still the real one).
function racingEnv(d1: D1, beforeInsert: () => void): Env {
  const db = d1.DB as any;
  const DB = {
    ...db,
    prepare(sql: string) {
      const st = db.prepare(sql);
      if (!/INSERT INTO showhome_rate/.test(sql)) return st;
      return {
        ...st,
        bind: (...a: unknown[]) => {
          const bound = st.bind(...a);
          return { ...bound, run: async () => (beforeInsert(), bound.run()) };
        },
      };
    },
  };
  return { ...guestEnv(d1), DB } as unknown as Env;
}

test("the ceiling and the per-address cap are decided INSIDE the one INSERT: rows that land after the helper's last read but before its INSERT are still counted (ceiling of 3 filled in that window: no row, no refusal; a per-address cap of 2 filled in that window: refused 429) (mutants: the ceiling is a separate count read before an unconditional insert; the per-address count is read before the insert)", async () => {
  const { d1 } = fresh();
  try {
    const fillCeiling = () => {
      const stmt = d1.raw.prepare("INSERT INTO showhome_rate (path, ip_hash, created_at) VALUES ('bind', ?, ?)");
      for (let i = 0; i < 3; i++) stmt.run("racer" + i, Date.now() - 100);
    };
    await assertShowhomeAddressCap(racingEnv(d1, fillCeiling), "192.0.2.50", "bind", 5, 3);
    assert.equal(pathRows(d1, "bind"), 3, "the racing rows filled the ceiling; this request wrote none and was not refused");

    const ip = "198.51.100.9";
    const key = await sha256Hex("showhome:" + ip);
    const fillAddress = () => {
      const stmt = d1.raw.prepare("INSERT INTO showhome_rate (path, ip_hash, created_at) VALUES ('recover', ?, ?)");
      for (let i = 0; i < 2; i++) stmt.run(key, Date.now() - 100);
    };
    await assert.rejects(() => assertShowhomeAddressCap(racingEnv(d1, fillAddress), ip, "recover", 2, 100), (e: unknown) => e instanceof SocietyError && e.status === 429);
    assert.equal(pathRows(d1, "recover"), 2, "and it wrote no third row");
  } finally {
    d1.close();
  }
});

test("the ceiling: attempts from many addresses against a ceiling of 3 leave exactly 3 rows and refuse nobody; attempts from ONE address against a per-address cap of 2 leave 2 rows and refuse 3, each a 429", async () => {
  const { d1, env } = fresh();
  try {
    const many = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => assertShowhomeAddressCap(env, `192.0.2.${i + 1}`, "bind", 5, 3)));
    assert.deepEqual(many.map((m) => m.status), Array(8).fill("fulfilled"), "no attempt is refused by the ceiling");
    assert.equal(pathRows(d1, "bind"), 3, "the ceiling held exactly");
    const same = await Promise.allSettled(Array.from({ length: 5 }, () => assertShowhomeAddressCap(env, "198.51.100.7", "recover", 2, 100)));
    assert.equal(same.filter((s) => s.status === "fulfilled").length, 2);
    const refused = same.filter((s) => s.status === "rejected") as PromiseRejectedResult[];
    assert.equal(refused.length, 3);
    assert.ok(refused.every((s) => s.reason instanceof SocietyError && s.reason.status === 429), "the per-address refusals are 429s, not ceiling bypasses");
    assert.equal(pathRows(d1, "recover"), 2);
  } finally {
    d1.close();
  }
});

// ---------- requests with no address (H3, HW7) ----------

test("no address: such requests share ONE per-address allowance (a recorded row keyed to a fixed hash), the sixth bind attempt is refused, and an addressed caller is unaffected (mutant: a missing address returns early and meets no cap)", async () => {
  const { d1, env } = fresh();
  try {
    for (let i = 0; i < RESIDENT_BIND_PER_IP_PER_HOUR; i++) {
      const r = await call(env, "POST", "/api/resident/bind", { token: "x" });
      assert.equal(r.status, 401);
    }
    const key = await sha256Hex("showhome:no-address");
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM showhome_rate WHERE path = 'bind' AND ip_hash = ?", key), RESIDENT_BIND_PER_IP_PER_HOUR, "every no-address attempt is on the shared bucket");
    const sixth = await call(env, "POST", "/api/resident/bind", { token: "x" });
    assert.equal(sixth.status, 429);
    const addressed = await call(env, "POST", "/api/resident/bind", { token: "x" }, { "CF-Connecting-IP": freshIp() });
    assert.equal(addressed.status, 401, "an addressed caller is not denied by the no-address bucket");
    // recovery: the same shape
    for (let i = 0; i < RESIDENT_RECOVER_PER_IP_PER_HOUR; i++) assert.equal((await call(env, "POST", "/api/resident/token", { number: 1, assertion: "x" })).status, 404);
    assert.equal((await call(env, "POST", "/api/resident/token", { number: 1, assertion: "x" })).status, 429);
  } finally {
    d1.close();
  }
});

// ---------- collection by path (HW5) ----------

test("collection: the per-address helper collects only its OWN path's rows older than a day (bind clears bind, leaves recover, bind_global and the guest paths), and uses the path index", async () => {
  const { d1, env } = fresh();
  try {
    for (const p of ["bind", "recover", "bind_global", "recover_global", "enter", "post", "comment", "council"]) seedOld(d1, p);
    await call(env, "POST", "/api/resident/bind", { token: "x" }, { "CF-Connecting-IP": freshIp() });
    assert.equal(pathRows(d1, "bind"), 1, "the three old bind rows are gone, this attempt's row remains");
    for (const p of ["recover", "bind_global", "recover_global", "enter", "post", "comment", "council"]) assert.equal(pathRows(d1, p), 3, `${p} rows are not touched by the bind helper`);
    await call(env, "POST", "/api/resident/token", { number: 1, assertion: "x" }, { "CF-Connecting-IP": freshIp() });
    assert.equal(pathRows(d1, "recover"), 1, "the recover helper clears recover");
    assert.equal(pathRows(d1, "bind_global"), 3);
    // the scoped DELETE is a range scan on idx_showhome_rate_path, not a table scan
    const plan = d1.raw.prepare("EXPLAIN QUERY PLAN DELETE FROM showhome_rate WHERE path = ? AND created_at < ?").all("bind", 0).map((r: any) => String(r.detail)).join(" | ");
    assert.match(plan, /SEARCH .*idx_showhome_rate_path/, plan);
  } finally {
    d1.close();
  }
});

test("collection: the global helper collects its own path (bind_global, recover_global) after a verified request, including when the ceiling bypassed the per-address row; no helper issues the old unscoped full-scan delete (mutants: the global helper stops collecting; a helper reverts to DELETE ... WHERE created_at < ?)", async () => {
  const { d1, env, post } = fresh();
  try {
    const g = await promotedGuest(env, post, "wren");
    seedOld(d1, "bind_global");
    seedOld(d1, "recover_global");
    await fillAttempts(d1, "bind", RESIDENT_ATTEMPT_ROWS_PER_HOUR);
    const kp = await genKeypair();
    assert.equal((await bindRoute(env, g, kp)).status, 201);
    assert.equal(pathRows(d1, "bind"), RESIDENT_ATTEMPT_ROWS_PER_HOUR, "the ceiling bypassed the per-address row");
    assert.equal(pathRows(d1, "bind_global"), 1, "old bind_global rows collected by the global helper itself");
    assert.equal(pathRows(d1, "recover_global"), 3, "another path's rows are not its business");
    assert.equal((await recoverRoute(env, g, kp)).status, 201);
    assert.equal(pathRows(d1, "recover_global"), 1);
    // structure: the two helpers carry no unscoped delete
    const src = readFileSync(join(import.meta.dirname, "..", "src", "showhome.ts"), "utf8").replace(/\r\n/g, "\n");
    const helpers = src.slice(src.indexOf("export async function assertShowhomeAddressCap"), src.indexOf("// ---------- the door: enter"));
    assert.equal(helpers.includes("DELETE FROM showhome_rate WHERE created_at < ?"), false, "no unscoped delete in the resident helpers");
    assert.equal(helpers.split("DELETE FROM showhome_rate WHERE path = ? AND created_at < ?").length - 1, 2, "one scoped delete in each helper");
    // and the guest/council helper still has its own, unchanged
    assert.equal(src.includes('"DELETE FROM showhome_rate WHERE created_at < ?"'), true);
  } finally {
    d1.close();
  }
});

// ---------- the resident replay pre-check (H4) ----------

test("replay pre-check: a replayed, signature-valid recovery is refused 401 WITHOUT taking a global slot, namespaced or raw (mutant: the pre-check is removed, so the replay charges recover_global before the batch refuses it)", async () => {
  const { d1, env, post } = fresh();
  try {
    const { guest, kp } = await newResident(env, post, "wren");
    const nonce = "DDDDDDDDDDDDDDDDDDDDDD";
    assert.equal((await recoverRoute(env, guest, kp, { nonce })).status, 201);
    assert.equal(pathRows(d1, "recover_global"), 1);
    const hash = guestRow(d1, guest.number).token_hash;
    const replay = await recoverRoute(env, guest, kp, { nonce });
    assert.equal(replay.status, 401);
    assert.match(replay.body.error, /already been used/);
    assert.equal(pathRows(d1, "recover_global"), 1, "the replay took no global slot");
    // a raw row from the previous worker is read by the pre-check too
    const raw = "EEEEEEEEEEEEEEEEEEEEEE";
    d1.raw.prepare("INSERT INTO resident_nonces (nonce, visitor_id, expires_at) VALUES (?, ?, ?)").run(raw, guest.number, Date.now() + 100_000);
    const rawReplay = await recoverRoute(env, guest, kp, { nonce: raw });
    assert.equal(rawReplay.status, 401);
    assert.equal(pathRows(d1, "recover_global"), 1, "nor did the raw replay");
    assert.equal(guestRow(d1, guest.number).token_hash, hash, "token unchanged");
    assert.equal(nonceCount(d1), 3, "bind's nonce, the recovery's, and the seeded raw row: nothing else burnt");
  } finally {
    d1.close();
  }
});

test("replay pre-check, bind: a replayed bind assertion is refused before the global slot (a namespaced row stands from the same visitor), and a fresh nonce still binds (mutant: the pre-check is removed from bindResident)", async () => {
  const { d1, env, post } = fresh();
  try {
    const g = await promotedGuest(env, post, "wren");
    const nonce = "FFFFFFFFFFFFFFFFFFFFFF";
    d1.raw.prepare("INSERT INTO resident_nonces (nonce, visitor_id, expires_at) VALUES (?, ?, ?)").run(residentNonceKey(g.number, nonce), g.number, Date.now() + 100_000);
    const kp = await genKeypair();
    const r = await bindRoute(env, g, kp, { nonce });
    assert.equal(r.status, 401);
    assert.equal(pathRows(d1, "bind_global"), 0, "no global slot was taken by the replay");
    assert.equal(guestRow(d1, g.number).public_key, null);
    assert.equal((await bindRoute(env, g, kp)).status, 201);
    assert.equal(pathRows(d1, "bind_global"), 1);
    assert.ok(RESIDENT_BIND_GLOBAL_PER_HOUR > 1);
  } finally {
    d1.close();
  }
});
