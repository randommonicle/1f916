// Resident caps: the across-all-addresses counter is charged only after the signature verifies (residents gate L1, 12 Oct; DECISIONS D-075 note 12 Oct
// afternoon, item 2; commission C2, RW4). The order of bindResident and recoverResidentToken is exactly: (1) the per-address slot on every attempt;
// (2) the assertion verifies; (3) the global slot, under its own path ("bind_global" | "recover_global"); (4) the nonce and write batch.
// Real local D1 through the real router, real Ed25519 keys. The mutant that turns each block red is named in it; docs/CHECKPOINT-RULINGS-WAVE.md records each run.
//
// Run just this file: node --experimental-strip-types --test "test/resident-caps-order-d1.test.ts"

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, seedCitizens, seedPost, guestEnv, call, count, freshIp } from "./helpers/guest.ts";
import { promotedGuest, genKeypair, signBind, signRecover, newResident, nonceCount, bindRoute, recoverRoute } from "./helpers/resident.ts";
import { RESIDENT_BIND_GLOBAL_PER_HOUR, RESIDENT_BIND_PER_IP_PER_HOUR, RESIDENT_RECOVER_GLOBAL_PER_HOUR, RESIDENT_RECOVER_PER_IP_PER_HOUR } from "../src/resident.ts";
import type { Env } from "../src/society.ts";

function fresh() {
  const d1 = createLocalD1();
  const { alice } = seedCitizens(d1);
  const post = seedPost(d1, alice);
  return { d1, env: guestEnv(d1), post };
}

const rows = (d1: ReturnType<typeof createLocalD1>, path: string): number => count(d1, "SELECT COUNT(*) AS n FROM showhome_rate WHERE path = ?", path);
const guestRow = (d1: ReturnType<typeof createLocalD1>, n: number) => d1.raw.prepare("SELECT * FROM guests WHERE visitor_id = ?").get(n) as Record<string, any>;

// Fill the across-all-addresses counter for `path` to its cap with recent rows (what verified requests would have left), no address on them.
function fillGlobal(d1: ReturnType<typeof createLocalD1>, path: string, n: number): void {
  const stmt = d1.raw.prepare("INSERT INTO showhome_rate (path, ip_hash, created_at) VALUES (?, NULL, ?)");
  for (let i = 0; i < n; i++) stmt.run(path, Date.now() - 1000);
}
// Age every row of `path` out of the one-hour window.
const ageOut = (d1: ReturnType<typeof createLocalD1>, path: string): void => {
  d1.raw.prepare("UPDATE showhome_rate SET created_at = ? WHERE path = ?").run(Date.now() - 2 * 3_600_000, path);
};

async function mcp(env: Env, name: string, args: Record<string, unknown>) {
  const r = await call(env, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, { "CF-Connecting-IP": freshIp() });
  assert.equal(r.status, 200);
  return { isError: r.body.result.isError === true, text: String(r.body.result.content[0].text) };
}

// ---------- recovery ----------

test("recover: many failing attempts from distinct addresses write ZERO global-path rows, and a valid recovery from a fresh address then succeeds (mutant: recoverResidentToken calls assertShowhomeRateCap again)", async () => {
  const { d1, env, post } = fresh();
  try {
    const { guest, kp } = await newResident(env, post, "wren");
    const other = await genKeypair();
    const junk = RESIDENT_RECOVER_GLOBAL_PER_HOUR + 10;
    for (let i = 0; i < junk; i++) {
      // alternate: an unparseable assertion, and a well-formed one signed by the WRONG key (it reaches the signature check and fails there)
      const r =
        i % 2 === 0
          ? await call(env, "POST", "/api/resident/token", { number: guest.number, assertion: "ch1.not.real" }, { "CF-Connecting-IP": freshIp() })
          : await recoverRoute(env, guest, other);
      assert.equal(r.status, 401, `junk attempt ${i + 1} is refused at authentication, not by a cap: ${JSON.stringify(r.body)}`);
    }
    assert.equal(rows(d1, "recover"), junk, "every attempt was charged to its own address");
    assert.equal(rows(d1, "recover_global"), 0, "no junk attempt touched the global counter");
    assert.equal(nonceCount(d1), 1, "and none burnt a nonce (the one is the bind's)");
    const ok = await recoverRoute(env, guest, kp);
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(rows(d1, "recover_global"), 1, "the verified request is the only thing the global counter has seen");
  } finally {
    d1.close();
  }
});

test("recover: a valid request at the global cap is refused 429 with nothing written and its nonce unburnt; the same assertion works once the window passes (mutant: the global check is moved after the batch, or removed)", async () => {
  const { d1, env, post } = fresh();
  try {
    const { guest, kp } = await newResident(env, post, "wren");
    fillGlobal(d1, "recover_global", RESIDENT_RECOVER_GLOBAL_PER_HOUR);
    const nonces = nonceCount(d1);
    const hash = guestRow(d1, guest.number).token_hash;
    const { assertion } = await signRecover(kp, guest.number, guest.handle);
    const ip = freshIp();
    const refused = await call(env, "POST", "/api/resident/token", { number: guest.number, assertion }, { "CF-Connecting-IP": ip });
    assert.equal(refused.status, 429);
    assert.match(refused.body.error, /Token recoveries are at their limit across all addresses/);
    assert.equal(nonceCount(d1), nonces, "no nonce was burnt");
    assert.equal(guestRow(d1, guest.number).token_hash, hash, "the token was not replaced");
    assert.equal(rows(d1, "recover_global"), RESIDENT_RECOVER_GLOBAL_PER_HOUR, "no extra global row");
    assert.equal(rows(d1, "recover"), 1, "only its step-1 row was written");

    ageOut(d1, "recover_global");
    const again = await call(env, "POST", "/api/resident/token", { number: guest.number, assertion }, { "CF-Connecting-IP": freshIp() });
    assert.equal(again.status, 201, `the same assertion, its nonce never spent: ${JSON.stringify(again.body)}`);
    assert.equal(nonceCount(d1), nonces + 1);
  } finally {
    d1.close();
  }
});

test("recover: the per-address cap still holds on junk, with its own wording, and touches no global row (mutant: the address step is removed)", async () => {
  const { d1, env, post } = fresh();
  try {
    const { guest, kp } = await newResident(env, post, "wren");
    const ip = "203.0.113.77";
    for (let i = 0; i < RESIDENT_RECOVER_PER_IP_PER_HOUR; i++) {
      const r = await call(env, "POST", "/api/resident/token", { number: guest.number, assertion: "ch1.not.real" }, { "CF-Connecting-IP": ip });
      assert.equal(r.status, 401, `attempt ${i + 1}`);
    }
    const capped = await call(env, "POST", "/api/resident/token", { number: guest.number, assertion: "ch1.not.real" }, { "CF-Connecting-IP": ip });
    assert.equal(capped.status, 429);
    assert.match(capped.body.error, /Too many token-recovery attempts from your address/);
    assert.equal(rows(d1, "recover"), RESIDENT_RECOVER_PER_IP_PER_HOUR);
    assert.equal(rows(d1, "recover_global"), 0);
    // the capped address is also refused a VALID request (the address step runs first), and another address is not
    const valid = await recoverRoute(env, guest, kp, {}, ip);
    assert.equal(valid.status, 429);
    assert.equal((await recoverRoute(env, guest, kp)).status, 201);
  } finally {
    d1.close();
  }
});

// ---------- binding ----------

test("bind: many failing attempts from distinct addresses write ZERO global-path rows, and a valid bind from a fresh address then succeeds (mutant: bindResident calls assertShowhomeRateCap again)", async () => {
  const { d1, env, post } = fresh();
  try {
    const guest = await promotedGuest(env, post, "wren");
    const kp = await genKeypair();
    const other = await genKeypair();
    const junk = RESIDENT_BIND_GLOBAL_PER_HOUR + 10;
    for (let i = 0; i < junk; i++) {
      // alternate: an unknown token (refused before the signature), and a well-formed assertion signed by the WRONG key (refused at the signature check)
      const r =
        i % 2 === 0
          ? await call(env, "POST", "/api/resident/bind", { token: "commonhold_visit_unknown", public_key: kp.publicKey, assertion: "x" }, { "CF-Connecting-IP": freshIp() })
          : await bindRoute(env, guest, kp, { publicKey: other.publicKey });
      assert.ok(r.status === 401 || r.status === 403, `junk attempt ${i + 1} is refused at authentication, not by a cap: ${r.status} ${JSON.stringify(r.body)}`);
    }
    assert.equal(rows(d1, "bind"), junk);
    assert.equal(rows(d1, "bind_global"), 0, "no junk attempt touched the global counter");
    assert.equal(nonceCount(d1), 0);
    const ok = await bindRoute(env, guest, kp);
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(rows(d1, "bind_global"), 1);
  } finally {
    d1.close();
  }
});

test("bind: a valid request at the global cap is refused 429 with nothing written and its nonce unburnt; the same assertion works once the window passes (mutant: the global check is moved after the batch, or removed)", async () => {
  const { d1, env, post } = fresh();
  try {
    const guest = await promotedGuest(env, post, "wren");
    const kp = await genKeypair();
    fillGlobal(d1, "bind_global", RESIDENT_BIND_GLOBAL_PER_HOUR);
    const { assertion } = await signBind(kp, guest.number, guest.handle);
    const body = { token: guest.token, public_key: kp.publicKey, assertion };
    const refused = await call(env, "POST", "/api/resident/bind", body, { "CF-Connecting-IP": freshIp() });
    assert.equal(refused.status, 429);
    assert.match(refused.body.error, /Key bindings are at their limit across all addresses/);
    assert.equal(nonceCount(d1), 0, "no nonce was burnt");
    assert.equal(guestRow(d1, guest.number).public_key, null, "no key was bound");
    assert.equal(rows(d1, "bind_global"), RESIDENT_BIND_GLOBAL_PER_HOUR);
    assert.equal(rows(d1, "bind"), 1);

    ageOut(d1, "bind_global");
    const again = await call(env, "POST", "/api/resident/bind", body, { "CF-Connecting-IP": freshIp() });
    assert.equal(again.status, 201, `the same assertion, its nonce never spent: ${JSON.stringify(again.body)}`);
    assert.equal(nonceCount(d1), 1);
    assert.equal(guestRow(d1, guest.number).public_key, kp.publicKey);
  } finally {
    d1.close();
  }
});

test("bind: the per-address cap still holds on junk, with its own wording, and touches no global row (mutant: the address step is removed)", async () => {
  const { d1, env, post } = fresh();
  try {
    const guest = await promotedGuest(env, post, "wren");
    const kp = await genKeypair();
    const ip = "203.0.113.78";
    for (let i = 0; i < RESIDENT_BIND_PER_IP_PER_HOUR; i++) {
      const r = await call(env, "POST", "/api/resident/bind", { token: "commonhold_visit_unknown", public_key: kp.publicKey, assertion: "x" }, { "CF-Connecting-IP": ip });
      assert.equal(r.status, 401, `attempt ${i + 1}`);
    }
    const capped = await call(env, "POST", "/api/resident/bind", { token: "commonhold_visit_unknown", public_key: kp.publicKey, assertion: "x" }, { "CF-Connecting-IP": ip });
    assert.equal(capped.status, 429);
    assert.match(capped.body.error, /Too many key-binding attempts from your address/);
    assert.equal(rows(d1, "bind"), RESIDENT_BIND_PER_IP_PER_HOUR);
    assert.equal(rows(d1, "bind_global"), 0);
    assert.equal((await bindRoute(env, guest, kp, {}, ip)).status, 429, "a valid request from the capped address is refused too");
    assert.equal((await bindRoute(env, guest, kp)).status, 201, "and another address binds");
  } finally {
    d1.close();
  }
});

// ---------- the MCP tools delegate to the same functions ----------

test("MCP: resident_token and resident_bind follow the same order: junk charges no global row, a verified request at the global cap is refused with no nonce burnt", async () => {
  const { d1, env, post } = fresh();
  try {
    const { guest, kp } = await newResident(env, post, "wren");
    const junk = await mcp(env, "resident_token", { number: guest.number, assertion: "ch1.not.real" });
    assert.equal(junk.isError, true);
    assert.equal(rows(d1, "recover_global"), 0, "junk over MCP charges no global row");
    assert.equal(rows(d1, "recover"), 1);

    fillGlobal(d1, "recover_global", RESIDENT_RECOVER_GLOBAL_PER_HOUR);
    const nonces = nonceCount(d1);
    const { assertion } = await signRecover(kp, guest.number, guest.handle);
    const refused = await mcp(env, "resident_token", { number: guest.number, assertion });
    assert.equal(refused.isError, true);
    assert.match(refused.text, /Token recoveries are at their limit across all addresses/);
    assert.equal(nonceCount(d1), nonces);

    const g2 = await promotedGuest(env, post, "heron");
    const kp2 = await genKeypair();
    fillGlobal(d1, "bind_global", RESIDENT_BIND_GLOBAL_PER_HOUR);
    const { assertion: bindAssertion } = await signBind(kp2, g2.number, g2.handle);
    const bindRefused = await mcp(env, "resident_bind", { token: g2.token, public_key: kp2.publicKey, assertion: bindAssertion });
    assert.equal(bindRefused.isError, true);
    assert.match(bindRefused.text, /Key bindings are at their limit across all addresses/);
    assert.equal(guestRow(d1, g2.number).public_key, null);
    assert.equal(nonceCount(d1), nonces);
  } finally {
    d1.close();
  }
});
