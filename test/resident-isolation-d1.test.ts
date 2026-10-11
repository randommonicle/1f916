// The resident tier, isolation (D-075 order step b; docs/BRIEF-RESIDENT-TIER-2026-10-11.md R2, R3; DECISIONS D-043). A resident must
// never reach a citizen capability, a citizen credential must identify nothing on a resident route, and no resident write may touch a
// table the society divides by. Real local D1, the real router, nothing mocked. Every block names the mutant that turns it red;
// docs/CHECKPOINT-RESIDENTS.md records each one run and restored.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createLocalD1, seedCitizens, seedPost, insertCitizen, guestEnv, guestComment, call, count, freshIp } from "./helpers/guest.ts";
import { promotedGuest, genKeypair, bindRoute, newResident, signBind, signRecover, recoverRoute } from "./helpers/resident.ts";
import { sha256Hex } from "../src/chain.ts";
import { INTENT_OPS } from "../src/keyauth.ts";
import type { Env } from "../src/society.ts";

const SRC = join(import.meta.dirname, "..", "src");
const CITIZEN_SECRET = "commonhold_sk_" + "ab".repeat(32);

async function fresh() {
  const d1 = createLocalD1();
  const { alice } = seedCitizens(d1);
  const post = seedPost(d1, alice);
  const carol = insertCitizen(d1, { handle: "carol", secret_hash: await sha256Hex(CITIZEN_SECRET) });
  return { d1, env: guestEnv(d1), alice, carol, post };
}

async function mcp(env: Env, name: string, args: Record<string, unknown>, headers: Record<string, string> = {}) {
  const r = await call(env, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, { "CF-Connecting-IP": freshIp(), ...headers });
  assert.equal(r.status, 200);
  return { isError: r.body.result.isError === true, body: JSON.parse(r.body.result.content[0].text) as Record<string, any> };
}

// The citizen credential works on a citizen route, so "it identifies nothing here" is a statement about the resident route, not a dead credential.
test("isolation: the fixture's citizen secret is a REAL citizen credential (positive control), and a resident's token and assertion are not", async () => {
  const { d1, env, post } = await fresh();
  try {
    const me = await call(env, "GET", "/api/me", undefined, { Authorization: `Bearer ${CITIZEN_SECRET}` });
    assert.equal(me.status, 200, "the citizen secret authenticates on a citizen route");
    const { guest, kp } = await newResident(env, post, "wren");
    const asBearer = (token: string) => call(env, "GET", "/api/me", undefined, { Authorization: `Bearer ${token}` });
    assert.equal((await asBearer(guest.token)).status, 401, "a resident token is no citizen credential");
    const { assertion } = await signRecover(kp, guest.number, guest.handle);
    assert.equal((await asBearer(assertion)).status, 401, "nor is a resident assertion (no citizen has that handle)");
    const post2 = await call(env, "POST", "/api/post", { title: "x", body: "y" }, { Authorization: `Bearer ${guest.token}` });
    assert.equal(post2.status, 401, "and a resident token cannot write a citizen post");
  } finally {
    d1.close();
  }
});

test("isolation: a resident assertion cannot authenticate as a citizen even when a citizen LATER takes the same handle with a different key (mutant: none, this is the property)", async () => {
  const { d1, env, post } = await fresh();
  try {
    const { guest, kp } = await newResident(env, post, "wren");
    const other = await genKeypair();
    const citizenId = insertCitizen(d1, { handle: "wren" }); // a citizen registers "wren" after the resident exists
    d1.raw.prepare("UPDATE citizens SET public_key = ? WHERE id = ?").run(other.publicKey, citizenId);
    const { assertion } = await signRecover(kp, guest.number, guest.handle);
    const me = await call(env, "GET", "/api/me", undefined, { Authorization: `Bearer ${assertion}` });
    assert.equal(me.status, 401);
    assert.match(me.body.error, /Signature does not verify against that citizen's registered public key/);
    // and the citizen's own assertion (no resident binding) cannot recover the resident's token
    const citizenSigned = await signRecover(other, guest.number, "wren", { binding: null });
    const r = await call(env, "POST", "/api/resident/token", { number: guest.number, assertion: citizenSigned.assertion }, { "CF-Connecting-IP": freshIp() });
    assert.equal(r.status, 403, "no resident binding, so no recovery, whatever the key");
  } finally {
    d1.close();
  }
});

test("isolation: a citizen credential on a resident call is ignored (Authorization header AND the token field), and a resident call with only a citizen credential is a plain 401/400", async () => {
  const { d1, env, post } = await fresh();
  try {
    const g = await promotedGuest(env, post, "wren");
    const kp = await genKeypair();
    const { assertion } = await signBind(kp, g.number, g.handle);
    const hdr = { Authorization: `Bearer ${CITIZEN_SECRET}`, "CF-Connecting-IP": freshIp() };
    // no token, only a citizen bearer: the bearer identifies no guest
    const noToken = await call(env, "POST", "/api/resident/bind", { public_key: kp.publicKey, assertion }, hdr);
    assert.equal(noToken.status, 401);
    assert.match(noToken.body.error, /No guest token/);
    // the citizen secret in the token field: not a guest token
    const asToken = await call(env, "POST", "/api/resident/bind", { token: CITIZEN_SECRET, public_key: kp.publicKey, assertion }, { "CF-Connecting-IP": freshIp() });
    assert.equal(asToken.status, 401);
    assert.match(asToken.body.error, /Unknown guest token/);
    // a bearer beside a REAL token and assertion changes nothing: the guest is who the token says, bound to the assertion's key
    const ok = await call(env, "POST", "/api/resident/bind", { token: g.token, public_key: kp.publicKey, assertion }, hdr);
    assert.equal(ok.status, 201);
    assert.equal(ok.body.byline, `resident:wren#${g.number}`);
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM citizens WHERE handle = 'wren'"), 0, "no citizen row was made or touched");
    // recovery with only a citizen bearer and no assertion: an unbound guest has no key to recover with (404); once bound, the missing assertion is a 400
    const before = await call(env, "POST", "/api/resident/token", { number: g.number }, hdr);
    assert.equal(before.status, 400);
  } finally {
    d1.close();
  }
});

test("isolation: the MCP resident tools take no `secret` argument and ignore one, and ignore an Authorization header, exactly as the REST routes do", async () => {
  const { d1, env, post } = await fresh();
  try {
    const g = await promotedGuest(env, post, "wren");
    const kp = await genKeypair();
    const { assertion } = await signBind(kp, g.number, g.handle);
    const hdr = { Authorization: `Bearer ${CITIZEN_SECRET}` };
    const noToken = await mcp(env, "resident_bind", { secret: CITIZEN_SECRET, public_key: kp.publicKey, assertion }, hdr);
    assert.equal(noToken.isError, true, "a citizen secret in `secret` and a bearer header are not a guest token");
    assert.match(noToken.body.error, /No guest token/);
    const ok = await mcp(env, "resident_bind", { secret: "garbage", token: g.token, public_key: kp.publicKey, assertion }, hdr);
    assert.equal(ok.isError, false, JSON.stringify(ok.body));
    assert.equal(ok.body.tier, "resident");
    const rec = await signRecover(kp, g.number, g.handle);
    const noAssertion = await mcp(env, "resident_token", { number: g.number, secret: CITIZEN_SECRET }, hdr);
    assert.equal(noAssertion.isError, true);
    const recovered = await mcp(env, "resident_token", { number: g.number, assertion: rec.assertion, secret: "ignored" }, hdr);
    assert.equal(recovered.isError, false, JSON.stringify(recovered.body));
    assert.match(recovered.body.token, /^commonhold_visit_/);
  } finally {
    d1.close();
  }
});

test("isolation: a whole resident life (enter, comment, bind, recover, roster, profile) writes only the guest, showhome and resident tables; every other table's row count is unchanged (mutant: a resident write touches citizens, a ballot, a chain or the treasury)", async () => {
  const { d1, env, post } = await fresh();
  try {
    const resident = new Set(["guests", "guest_thread", "visitors", "showhome_notes", "showhome_replies", "showhome_rate", "resident_nonces", "door_counts", "sqlite_sequence"]);
    const tables = (d1.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map((t) => t.name);
    assert.ok(tables.length > 25, "the census of tables is real");
    const snap = () => Object.fromEntries(tables.filter((t) => !resident.has(t)).map((t) => [t, count(d1, `SELECT COUNT(*) AS n FROM ${t}`)]));
    const before = snap();
    const { guest, kp } = await newResident(env, post, "wren");
    const rec = await recoverRoute(env, guest, kp);
    assert.equal(rec.status, 201);
    await call(env, "GET", "/api/residents");
    await call(env, "GET", `/api/resident/${guest.number}`);
    await call(env, "POST", "/api/showhome/note", { token: rec.body.token, body: "a note" }, { "CF-Connecting-IP": freshIp() });
    assert.deepEqual(snap(), before, "no citizen, chain, ballot, treasury, listing or settlement table moved");
    assert.ok(count(d1, "SELECT COUNT(*) AS n FROM guests WHERE public_key IS NOT NULL") === 1 && count(d1, "SELECT COUNT(*) AS n FROM resident_nonces") === 2, "positive control: the resident tables DID change");
    // the citizen replay table is a different table from the resident one
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM auth_nonces"), 0);
  } finally {
    d1.close();
  }
});

// ---------- static fences ----------

const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));

test("isolation (static): src/resident.ts never names the citizen authenticator, the citizen intent verifier, buildIntentBinding, INTENT_OPS or the citizens table, and keyauth's INTENT_OPS is still exactly the six citizen ops (R2)", () => {
  const code = stripComments(readFileSync(join(SRC, "resident.ts"), "utf8"));
  for (const banned of ["authenticate", "requireSignedIntent", "buildIntentBinding", "INTENT_OPS", "credentialBinding", "authenticateByAssertion"]) {
    assert.equal(new RegExp(`\\b${banned}\\b`).test(code), false, `resident.ts must not use ${banned}`);
  }
  assert.equal(/\b(FROM|JOIN|INTO|UPDATE)\s+citizens\b/i.test(code), false, "resident.ts reads and writes no citizens row");
  assert.equal(/\bauth_nonces\b/.test(code), false, "and not the citizen nonce table");
  assert.deepEqual([...INTENT_OPS], ["ballot", "proposal", "moderate", "wallet", "payout", "ledger"], "the resident ops were NOT added to the citizen intent list");
  // positive control: the same scan sees a real mention elsewhere
  assert.ok(/\bauthenticate\b/.test(stripComments(readFileSync(join(SRC, "society.ts"), "utf8"))));
});

test("isolation (static): nothing under src/maintainer/ names the resident tables or imports the resident module (D-043: no paid cognition reads resident content)", () => {
  const offenders: string[] = [];
  const files = walk(join(SRC, "maintainer"));
  assert.ok(files.length >= 8);
  for (const f of files) {
    const text = stripComments(readFileSync(f, "utf8"));
    for (const word of ["resident_nonces", "resident.ts", "bindResident", "recoverResidentToken", "residentRoster"]) if (text.includes(word)) offenders.push(`${f} names ${word}`);
  }
  assert.deepEqual(offenders, []);
  assert.ok(stripComments(readFileSync(join(SRC, "index.ts"), "utf8")).includes("bindResident"), "positive control: the scan sees a real use elsewhere");
});

test("isolation (static): the resident write paths in index.ts and mcp.ts never read the Authorization header and never call the citizen authenticate()", () => {
  const index = readFileSync(join(SRC, "index.ts"), "utf8");
  const start = index.indexOf('path === "/api/resident/bind"');
  const end = index.indexOf('path === "/api/residents"');
  assert.ok(start > 0 && end > start);
  const block = stripComments(index.slice(start, end));
  assert.equal(/\bauthenticate\b|\bbearer\(|Authorization/.test(block), false, "the two resident write routes read only the body and the address");
  const mcp = readFileSync(join(SRC, "mcp.ts"), "utf8");
  const fn = stripComments(mcp.slice(mcp.indexOf("async function callGuestTool"), mcp.indexOf("async function callTool")));
  assert.ok(fn.includes("bindResident") && fn.includes("recoverResidentToken"));
  assert.equal(/\bauthenticate\b|\bsecret\b|Authorization/.test(fn), false, "callGuestTool computes no citizen credential");
  // order: the guest/resident branch is dispatched before callTool can compute `secret` (R7)
  const guestBranch = mcp.indexOf("GUEST_TOOL_NAMES.includes(name)");
  const citizenBranch = mcp.indexOf("result = await callTool(");
  assert.ok(guestBranch > 0 && citizenBranch > guestBranch, "the resident tools dispatch before any citizen credential is read");
  assert.match(mcp, /const GUEST_TOOL_NAMES: readonly string\[\] = \[[^\]]*"resident_bind"[^\]]*"resident_token"/);
});

void guestComment;
void bindRoute;
