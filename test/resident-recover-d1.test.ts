// The resident tier, token recovery (D-075 order step b; docs/BRIEF-RESIDENT-TIER-2026-10-11.md R1, R4, R7; hub amendments A4, A5, A8).
// Real local D1 driven through the real router, real Ed25519 keys. Every dead-token test starts from a REAL enter plus an accepted
// comment, so the visitors row holds the old token and the fallback path is genuinely exercised (A8). Every block names the mutant that
// turns it red; docs/CHECKPOINT-RESIDENTS.md records each one run and restored.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, seedCitizens, seedPost, guestEnv, guestComment, call, count, freshIp } from "./helpers/guest.ts";
import { enterGuest, promotedGuest, genKeypair, signRecover, signBind, recoverRoute, newResident, nonceCount, type Guest } from "./helpers/resident.ts";
import { sha256Hex } from "../src/chain.ts";
import { ASSERTION_WINDOW_MS } from "../src/keyauth.ts";
import { RESIDENT_RECOVER_PER_IP_PER_HOUR } from "../src/resident.ts";
import type { Env } from "../src/society.ts";

function fresh() {
  const d1 = createLocalD1();
  const { maintainer, alice } = seedCitizens(d1);
  const post = seedPost(d1, alice);
  return { d1, env: guestEnv(d1), maintainer, alice, post };
}

const guestRow = (d1: ReturnType<typeof createLocalD1>, n: number) => d1.raw.prepare("SELECT * FROM guests WHERE visitor_id = ?").get(n) as Record<string, any>;
const visitorRow = (d1: ReturnType<typeof createLocalD1>, n: number) => d1.raw.prepare("SELECT * FROM visitors WHERE id = ?").get(n) as Record<string, any> | undefined;

async function mcp(env: Env, name: string, args: Record<string, unknown>) {
  const r = await call(env, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, { "CF-Connecting-IP": freshIp() });
  assert.equal(r.status, 200);
  return { isError: r.body.result.isError === true, body: JSON.parse(r.body.result.content[0].text) as Record<string, any> };
}

// Every door a token opens: the REST guest comment, the REST showhome note, and the two MCP guest tools. Returns the status each gives.
async function useToken(env: Env, post: number, token: string) {
  const comment = await guestComment(env, token, { post_id: post, body: "a comment with this token" });
  const note = await call(env, "POST", "/api/showhome/note", { token, body: "a note with this token" }, { "CF-Connecting-IP": freshIp() });
  const mcpComment = await mcp(env, "guest_comment", { token, post_id: post, body: "an mcp comment with this token" });
  const mcpNote = await mcp(env, "showhome_note", { token, body: "an mcp note with this token" });
  return { comment: comment.status, note: note.status, mcpComment: mcpComment.isError ? "error" : "ok", mcpNote: mcpNote.isError ? "error" : "ok" };
}

test("recover: a new token is issued, shown once, and the OLD token is dead on every path: guest comment, showhome note, and both MCP guest tools (mutant: the old hash is not replaced in guests, or the visitors fallback is left alone)", async () => {
  const { d1, env, post } = fresh();
  try {
    const { guest, kp } = await newResident(env, post, "wren");
    // A8: the visitors row exists and holds the OLD token's hash, so the fallback is a live path.
    const oldHash = await sha256Hex(guest.token);
    assert.equal(visitorRow(d1, guest.number)!.token_hash, oldHash);
    assert.equal(guestRow(d1, guest.number).token_hash, oldHash);
    assert.deepEqual(await useToken(env, post, guest.token), { comment: 201, note: 201, mcpComment: "ok", mcpNote: "ok" }, "before recovery the old token works everywhere");

    const r = await recoverRoute(env, guest, kp);
    assert.equal(r.status, 201);
    assert.match(r.body.token, /^commonhold_visit_[0-9a-f]{64}$/);
    assert.equal(r.body.byline, `resident:wren#${guest.number}`);
    assert.equal(r.body.tier, "resident");
    assert.notEqual(r.body.token, guest.token);
    const newHash = await sha256Hex(r.body.token);
    assert.equal(guestRow(d1, guest.number).token_hash, newHash, "guests holds the new hash");
    assert.equal(visitorRow(d1, guest.number)!.token_hash, newHash, "the visitors row was OVERWRITTEN in the same batch, not left holding the dead hash");
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM guests WHERE token_hash = ?", oldHash), 0);
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM visitors WHERE token_hash = ?", oldHash), 0);

    const dead = await useToken(env, post, guest.token);
    assert.deepEqual(dead, { comment: 401, note: 401, mcpComment: "error", mcpNote: "error" }, "the old token is dead on EVERY path, the visitors fallback included");
    const alive = await useToken(env, post, r.body.token);
    assert.deepEqual(alive, { comment: 201, note: 201, mcpComment: "ok", mcpNote: "ok" }, "and the new token works on every path");
  } finally {
    d1.close();
  }
});

test("recover: the old token is also dead on the showhome REPLY path (authenticateVisitor reads visitors only)", async () => {
  const { d1, env, post } = fresh();
  try {
    const { guest, kp } = await newResident(env, post, "wren");
    const note = await call(env, "POST", "/api/showhome/note", { token: guest.token, body: "a note to reply to" }, { "CF-Connecting-IP": freshIp() });
    assert.equal(note.status, 201);
    const r = await recoverRoute(env, guest, kp);
    const reply = (token: string) => call(env, "POST", "/api/showhome/reply", { token, note_id: note.body.note_id, body: "a reply" }, { "CF-Connecting-IP": freshIp() });
    assert.equal((await reply(guest.token)).status, 401);
    assert.equal((await reply(r.body.token)).status, 201);
  } finally {
    d1.close();
  }
});

test("recover: it still works when the visitors ring has already evicted the guest's row (the guests row is the identity), and the old token stays dead", async () => {
  const { d1, env, post } = fresh();
  try {
    const { guest, kp } = await newResident(env, post, "wren");
    d1.raw.exec("DELETE FROM visitors");
    const r = await recoverRoute(env, guest, kp);
    assert.equal(r.status, 201);
    assert.equal(visitorRow(d1, guest.number), undefined, "no visitors row was invented");
    assert.equal((await guestComment(env, r.body.token, { post_id: post, body: "after eviction and recovery" })).status, 201);
    assert.equal((await guestComment(env, guest.token, { post_id: post, body: "the dead token" })).status, 401);
  } finally {
    d1.close();
  }
});

test("recover: a second recovery kills the first recovery's token too (the key is the identity, every token is replaceable)", async () => {
  const { d1, env, post } = fresh();
  try {
    const { guest, kp } = await newResident(env, post, "wren");
    const first = await recoverRoute(env, guest, kp);
    const second = await recoverRoute(env, guest, kp);
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal((await guestComment(env, first.body.token, { post_id: post, body: "x" })).status, 401);
    assert.equal((await guestComment(env, second.body.token, { post_id: post, body: "y" })).status, 201);
    assert.equal(guestRow(d1, guest.number).token_hash, await sha256Hex(second.body.token));
  } finally {
    d1.close();
  }
});

// ---------- concurrency ----------

test("recover: two concurrent recoveries with distinct nonces, exactly one wins, the loser gets no token, and only the winner's token works (mutant: the UPDATE loses `AND token_hash = old`)", async () => {
  const { d1, env, post } = fresh();
  try {
    const { guest, kp } = await newResident(env, post, "wren");
    const [a, b] = await Promise.all([recoverRoute(env, guest, kp), recoverRoute(env, guest, kp)]);
    const won = [a, b].filter((r) => r.status === 201);
    const lost = [a, b].filter((r) => r.status !== 201);
    assert.equal(won.length, 1, `exactly one recovery wins (${a.status}, ${b.status})`);
    assert.equal(lost[0]!.status, 409);
    assert.match(lost[0]!.body.error, /Another recovery for this resident took effect first/);
    assert.equal(lost[0]!.body.token, undefined, "the loser is handed no token");
    assert.equal(guestRow(d1, guest.number).token_hash, await sha256Hex(won[0]!.body.token));
    assert.equal((await guestComment(env, won[0]!.body.token, { post_id: post, body: "the winner" })).status, 201);
    assert.equal((await guestComment(env, guest.token, { post_id: post, body: "the dead original" })).status, 401);
  } finally {
    d1.close();
  }
});

test("recover: a recovery whose batch runs AFTER another recovery completed (a stale read of the old hash) changes nothing: the conditional UPDATE is the bound, deterministically (mutant: the UPDATE loses `AND token_hash = old`)", async () => {
  const { d1, env, post } = fresh();
  try {
    const { guest, kp } = await newResident(env, post, "wren");
    // Request B reads the old hash, verifies, and is then held at its batch by a gate. Request A runs to completion. B's batch is then
    // released against the moved state. The gate delegates to the real D1 batch: it only chooses WHEN the real write happens.
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const db = env.DB;
    const gatedEnv = { ...env, DB: { prepare: (s: string) => db.prepare(s), batch: async (stmts: any) => { await gate; return db.batch(stmts); } } } as unknown as Env;
    const pendingB = recoverRoute(gatedEnv, guest, kp);
    await new Promise((r) => setTimeout(r, 30)); // B has read and verified, and is parked at its batch
    const a = await recoverRoute(env, guest, kp);
    assert.equal(a.status, 201);
    release();
    const b = await pendingB;
    assert.equal(b.status, 409, "the stale recovery wrote nothing");
    assert.equal(b.body.token, undefined);
    assert.equal(guestRow(d1, guest.number).token_hash, await sha256Hex(a.body.token), "A's token is still the token");
    assert.equal(visitorRow(d1, guest.number)!.token_hash, await sha256Hex(a.body.token), "and the visitors row still matches it");
    assert.equal((await guestComment(env, a.body.token, { post_id: post, body: "a still works" })).status, 201);
  } finally {
    d1.close();
  }
});

// ---------- who may recover ----------

test("recover: an unbound guest, an unknown number and a malformed number are refused and nothing moves", async () => {
  const { d1, env, post } = fresh();
  try {
    const unbound = await promotedGuest(env, post, "finch");
    const before = guestRow(d1, unbound.number).token_hash;
    const kp = await genKeypair();
    const r1 = await recoverRoute(env, unbound, kp);
    assert.equal(r1.status, 404);
    assert.match(r1.body.error, /No resident has the number/);
    const r2 = await recoverRoute(env, { number: 9999, handle: "nobody", token: "x" }, kp);
    assert.equal(r2.status, 404);
    for (const bad of [0, -1, "abc", 1.5, null, undefined]) {
      const r = await call(env, "POST", "/api/resident/token", { number: bad, assertion: "x" }, { "CF-Connecting-IP": freshIp() });
      assert.equal(r.status, 400, `number ${String(bad)} is a 400`);
    }
    assert.equal(guestRow(d1, unbound.number).token_hash, before);
    assert.equal(nonceCount(d1), 0);
  } finally {
    d1.close();
  }
});

test("recover: an assertion signed by a key other than the bound one is refused, including another resident's key presented for this number (mutant: the signature is checked against a supplied key)", async () => {
  const { d1, env, post } = fresh();
  try {
    const a = await newResident(env, post, "wren");
    const b = await newResident(env, post, "finch");
    const stranger = await genKeypair();
    const before = guestRow(d1, a.guest.number).token_hash;
    const byStranger = await recoverRoute(env, a.guest, stranger);
    assert.equal(byStranger.status, 401);
    assert.match(byStranger.body.error, /Signature does not verify/);
    // b's valid key and b's handle, presented for a's number: the handle check refuses it before any signature is looked at
    const { assertion } = await signRecover(b.kp, a.guest.number, b.guest.handle);
    const crossed = await call(env, "POST", "/api/resident/token", { number: a.guest.number, assertion }, { "CF-Connecting-IP": freshIp() });
    assert.equal(crossed.status, 401);
    // b's key signing a's exact handle and number: well-formed, the right binding, the WRONG key
    const forged = await recoverRoute(env, a.guest, b.kp);
    assert.equal(forged.status, 401);
    assert.match(forged.body.error, /Signature does not verify/);
    assert.equal(guestRow(d1, a.guest.number).token_hash, before, "a's token never moved");
  } finally {
    d1.close();
  }
});

test("recover: a replayed assertion is refused and rotates nothing a second time (mutant: the nonce insert is dropped from the batch)", async () => {
  const { d1, env, post } = fresh();
  try {
    const { guest, kp } = await newResident(env, post, "wren");
    const { assertion } = await signRecover(kp, guest.number, guest.handle);
    const send = () => call(env, "POST", "/api/resident/token", { number: guest.number, assertion }, { "CF-Connecting-IP": freshIp() });
    const first = await send();
    assert.equal(first.status, 201);
    const replay = await send();
    assert.equal(replay.status, 401);
    assert.match(replay.body.error, /already been used/);
    assert.equal(guestRow(d1, guest.number).token_hash, await sha256Hex(first.body.token), "the replay did not rotate the token again");
    assert.equal((await guestComment(env, first.body.token, { post_id: post, body: "still the first token" })).status, 201);
  } finally {
    d1.close();
  }
});

test("recover: A4 nonce ordering. An attempt with nonce N and an INVALID signature burns nothing; a VALID signature with the SAME N then succeeds (mutant: the nonce is burnt before verification)", async () => {
  const { d1, env, post } = fresh();
  try {
    const { guest, kp } = await newResident(env, post, "wren");
    const imposter = await genKeypair();
    const nonce = "recover-ordering-0123456789abcd";
    const nonces = nonceCount(d1);
    const bad = await recoverRoute(env, guest, imposter, { nonce });
    assert.equal(bad.status, 401);
    assert.equal(nonceCount(d1), nonces, "an invalid signature spends no nonce");
    const good = await recoverRoute(env, guest, kp, { nonce });
    assert.equal(good.status, 201, "the genuine signer can still use the nonce the forger tried");
    assert.equal(nonceCount(d1), nonces + 1);
  } finally {
    d1.close();
  }
});

test("recover: A5 freshness and audience. Expired, future-dated and wrong-audience assertions are refused and rotate nothing (mutant: the window or audience check is dropped)", async () => {
  const { d1, env, post } = fresh();
  try {
    const { guest, kp } = await newResident(env, post, "wren");
    const before = guestRow(d1, guest.number).token_hash;
    const nonces = nonceCount(d1);
    const expired = await recoverRoute(env, guest, kp, { t: Date.now() - ASSERTION_WINDOW_MS - 5000 });
    const future = await recoverRoute(env, guest, kp, { t: Date.now() + ASSERTION_WINDOW_MS + 5000 });
    const audience = await recoverRoute(env, guest, kp, { audience: "https://another.example" });
    assert.deepEqual([expired.status, future.status, audience.status], [401, 401, 401]);
    assert.match(expired.body.error, /freshness window/);
    assert.match(future.body.error, /freshness window/);
    assert.match(audience.body.error, /different audience/);
    assert.equal(guestRow(d1, guest.number).token_hash, before);
    assert.equal(nonceCount(d1), nonces);
    assert.equal((await recoverRoute(env, guest, kp, { t: Date.now() - 60_000 })).status, 201, "a minute old is inside the window");
  } finally {
    d1.close();
  }
});

test("recover: claims.h must be the stored handle exactly, and an assertion with no signed intent is refused with the exact binding taught", async () => {
  const { d1, env, post } = fresh();
  try {
    const { guest, kp } = await newResident(env, post, "Wren");
    const before = guestRow(d1, guest.number).token_hash;
    const wrongCase = await recoverRoute(env, guest, kp, { claimHandle: "wren" });
    assert.equal(wrongCase.status, 401);
    assert.match(wrongCase.body.error, /payload\.h must be this guest's handle exactly/);
    const none = await recoverRoute(env, guest, kp, { binding: null });
    assert.equal(none.status, 403);
    assert.match(none.body.error, /resident_recover:[0-9a-f]{64}/);
    assert.equal(guestRow(d1, guest.number).token_hash, before);
  } finally {
    d1.close();
  }
});

test("recover: the per-address cap binds with its own wording and a refusal still consumes the budget (mutant: the cap call is removed)", async () => {
  const { d1, env } = fresh();
  try {
    const ip = "203.0.113.201";
    for (let i = 0; i < RESIDENT_RECOVER_PER_IP_PER_HOUR; i++) {
      const r = await call(env, "POST", "/api/resident/token", { number: 4242, assertion: "x" }, { "CF-Connecting-IP": ip });
      assert.equal(r.status, 404, `attempt ${i + 1} reaches the lookup`);
    }
    const capped = await call(env, "POST", "/api/resident/token", { number: 4242, assertion: "x" }, { "CF-Connecting-IP": ip });
    assert.equal(capped.status, 429);
    assert.match(capped.body.error, /token-recovery attempts/);
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM showhome_rate WHERE path = 'recover'"), RESIDENT_RECOVER_PER_IP_PER_HOUR);
  } finally {
    d1.close();
  }
});

test("recover: a guest entered, commented and bound in a SINGLE sequence of real calls never exposes the hash: the response carries the token once and the stored value is only its sha-256", async () => {
  const { d1, env, post } = fresh();
  try {
    const g: Guest = await promotedGuest(env, post, "wren");
    assert.equal((await enterGuest(env, "bystander")).number > 0, true);
    const kp = await genKeypair();
    const { assertion } = await signBind(kp, g.number, g.handle);
    const bound = await call(env, "POST", "/api/resident/bind", { token: g.token, public_key: kp.publicKey, assertion }, { "CF-Connecting-IP": freshIp() });
    assert.equal(bound.status, 201);
    assert.ok(!JSON.stringify(bound.body).includes(g.token), "a bind response never echoes the token");
    const rec = await recoverRoute(env, g, kp);
    assert.ok(!JSON.stringify(rec.body).includes(await sha256Hex(rec.body.token)), "a recovery response carries the token, never its stored hash");
  } finally {
    d1.close();
  }
});
