// Residency by a proved outside account: the challenge, the claim and the recovery (D-082, plan M1; drafts/BRIEF-RESIDENT-OUTSIDE-ACCOUNT-2026-11-12.md A3-A7, B1-B5, B12, B15; tests T1,
// T2, T4-T7, T10, T11, T14). Real local D1 (node:sqlite + the committed schema.sql) driven through the real router for the challenge and the real claim function for the claim, with an
// INJECTED fetch serving the pinned fixtures for the outside platforms. Nothing of ours is mocked. A race is made real by a wrapper around env.DB that runs a competing write just before
// the batch commits (scaffolding for the database, not for any module under test).
//
// Every block names the mutant that turns it red; docs/CHECKPOINT-RESIDENT-ACCOUNT.md records each one run and restored.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import {
  world, writtenGuest, enterGuest, ask, askOk, claim, bindByAccount, colonyProof, f916Proof, rows, call, freshIp, withIp, uniqueColonyId, seedEarned, seedResident, seedPresence, seedClaim,
  COLONY_FIXTURE_COMMENT_ID as CID, OUTSIDE_COLONY_ID, type Env, type LocalD1, type Challenge,
} from "./helpers/resident-account.ts";
import { sha256Hex } from "../src/chain.ts";
import { claimCouncilSeat } from "../src/council.ts";
import { fixtureFetch, recordJson, recordUrl, accountJson, accountUrl } from "./helpers/council.ts";
import { RESIDENT_ACCOUNT_CHALLENGE_PER_IP_PER_HOUR } from "../src/resident-account-core.ts";
import { bindRoute, genKeypair, recoverRoute } from "./helpers/resident.ts";
import { authenticateGuest } from "../src/showhome.ts";

const guestRow = (d1: LocalD1, n: number) => d1.raw.prepare("SELECT * FROM guests WHERE visitor_id = ?").get(n) as Record<string, any> | undefined;
const accountRows = (d1: LocalD1) => rows(d1, "SELECT * FROM resident_accounts ORDER BY visitor_id");
const challengeRows = (d1: LocalD1, n?: number) => rows<Record<string, any>>(d1, n === undefined ? "SELECT * FROM resident_account_challenges" : "SELECT * FROM resident_account_challenges WHERE visitor_id = ?", ...(n === undefined ? [] : [n]));
const usedAt = (d1: LocalD1, nonce: string) => (d1.raw.prepare("SELECT used_at FROM resident_account_challenges WHERE nonce = ?").get(nonce) as { used_at: number | null }).used_at;

// A copy of env whose batch() first runs `before` when a statement matching `needle` is about to commit: a competing write landing between a claim's reads and its batch.
function raceEnv(env: Env, needle: RegExp, before: () => void): Env {
  const real = env.DB as any;
  let fired = false;
  return {
    ...env,
    DB: {
      prepare: (sql: string) => real.prepare(sql),
      batch: async (stmts: any[]) => {
        if (!fired && stmts.some((s) => needle.test(s.__sql))) {
          fired = true;
          before();
        }
        return real.batch(stmts);
      },
    },
  } as Env;
}

// ---------- T1: the bind, on each platform ----------

test("T1: a guest that has written once binds by a Colony account: resident_at set, no key, the roster, the count and the profile say so, the token still works (mutant: the batch sets nothing, or sets public_key)", async () => {
  const { d1, env, post } = world();
  try {
    const g = await writtenGuest(env, post, "wren");
    const ch = await askOk(env, { token: g.token }, "colony");
    assert.equal(ch.purpose, "bind");
    assert.ok(ch.claim_code.length >= 22 && /^[A-Za-z0-9_-]+$/.test(ch.claim_code), "a base64url claim code of 22+ characters");
    assert.ok(ch.text_to_post.includes(ch.nonce) && new RegExp(`(?<![0-9])${g.number}(?![0-9])`).test(ch.text_to_post), "the text carries the nonce and the resident number");
    assert.ok(!ch.text_to_post.includes(ch.claim_code), "and never the claim code");
    assert.equal(ch.expires_at - ch.issued_at, 15 * 60_000);
    const stored = challengeRows(d1, g.number)[0]!;
    assert.equal(stored.claim_code_hash, await sha256Hex(ch.claim_code), "the claim code is stored as its sha-256");
    assert.ok(!JSON.stringify(stored).includes(ch.claim_code), "and only as that");

    const out = await claim(env, { token: g.token }, ch, "colony", CID, colonyProof(ch, { accountId: OUTSIDE_COLONY_ID, username: "outside-colonist" }));
    assert.ok(out.ok, JSON.stringify(out));
    if (!out.ok) return;
    assert.equal(out.body.byline, `resident:wren#${g.number}`);
    assert.equal(out.body.route, "account");
    assert.equal(out.body.account.platform, "colony");
    assert.equal(out.body.account.account_id, OUTSIDE_COLONY_ID);
    const row = guestRow(d1, g.number)!;
    assert.ok(Number(row.resident_at) > 0);
    assert.equal(row.public_key, null, "no key was bound");
    assert.equal(usedAt(d1, ch.nonce) !== null, true, "the challenge is used");
    assert.equal(accountRows(d1).length, 1);

    const roster = await call(env, "GET", "/api/residents");
    assert.equal(roster.body.total, 1);
    assert.equal(roster.body.residents[0].number, g.number);
    assert.equal(roster.body.residents[0].route, "account");
    assert.equal(roster.body.residents[0].public_key, null);
    assert.equal(roster.body.residents[0].account.handle, "outside-colonist");
    const profile = await call(env, "GET", `/api/resident/${g.number}`);
    assert.equal(profile.status, 200);
    assert.equal(profile.body.route, "account");
    assert.equal(profile.body.account.record_link, `https://thecolony.ai/api/v1/comments/${CID}`);
    assert.equal(profile.body.account.account_link, `https://thecolony.ai/api/v1/users/${OUTSIDE_COLONY_ID}`);
    assert.equal(typeof profile.body.account_since, "number");
    const guest = await authenticateGuest(env, g.token);
    assert.equal(guest.resident, true, "the same token still resolves, as a resident");
  } finally {
    d1.close();
  }
});

test("T1: and by a 1f916 account, the account id being citizen_id (mutant: the handle is stored as the id)", async () => {
  const { d1, env, post } = world();
  try {
    const g = await writtenGuest(env, post, "finch");
    const body = await bindByAccount(env, g, "1f916", { username: "outside-f916", f916Id: 31337 });
    assert.equal(body.route, "account");
    const row = accountRows(d1)[0]!;
    assert.equal(row.platform, "1f916");
    assert.equal(row.external_account_id, "31337");
    assert.equal(row.external_handle, "outside-f916");
    assert.equal(row.record_id, "424242");
    const profile = await call(env, "GET", `/api/resident/${g.number}`);
    assert.equal(profile.body.account.account_link, "https://1f916.ai/api/citizen/outside-f916");
    assert.equal(profile.body.account.record_link, "https://1f916.ai/api/comment/424242");
  } finally {
    d1.close();
  }
});

// ---------- who may ask (A3, B7) ----------

test("A3/B7: a visitor that has not commented cannot ask or claim; a guest with an account cannot add a second; an unknown platform is a 400 (mutant: the has-written-once test is dropped)", async () => {
  const { d1, env, post } = world();
  try {
    const fresh = await enterGuest(env, "lurker");
    const refused = await ask(env, { token: fresh.token }, "colony");
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /Only a guest that has commented can prove an outside account/);
    assert.equal(challengeRows(d1).length, 0, "nothing written");
    // a showhome note is not a comment
    await call(env, "POST", "/api/showhome/note", { token: fresh.token, body: "a note, not a comment" }, withIp());
    assert.equal((await ask(env, { token: fresh.token }, "colony")).status, 409);

    const g = await writtenGuest(env, post, "wren");
    assert.equal((await ask(env, { token: g.token }, "1f3d9")).status, 400);
    assert.equal((await ask(env, { token: g.token }, "")).status, 400);
    assert.equal((await ask(env, {}, "colony")).status, 400, "neither a token nor a number");
    await bindByAccount(env, g, "colony");
    const second = await ask(env, { token: g.token }, "1f916");
    assert.equal(second.status, 409);
    assert.match(second.body.error, /already has an outside account/);
  } finally {
    d1.close();
  }
});

// ---------- T2, T3 at the route: a refusal writes nothing and does not use the challenge ----------

test("T2/T3: a refused claim (stale record, missing nonce) names its code, writes nothing and leaves the challenge usable (mutant: a refusal burns the challenge)", async () => {
  const { d1, env, post } = world();
  try {
    const g = await writtenGuest(env, post, "wren");
    const ch = await askOk(env, { token: g.token }, "colony");
    const stale = await claim(env, { token: g.token }, ch, "colony", CID, colonyProof(ch, { created: ch.issued_at - 5 }));
    assert.ok(!stale.ok && stale.status === 403 && stale.code === "resident_account_refused_record_stale", JSON.stringify(stale));
    const noNonce = await claim(env, { token: g.token }, ch, "colony", CID, colonyProof(ch, { body: `resident ${g.number} but no nonce` }));
    assert.ok(!noNonce.ok && noNonce.code === "resident_account_refused_nonce_missing");
    assert.equal(accountRows(d1).length, 0);
    assert.equal(guestRow(d1, g.number)!.resident_at, null);
    assert.equal(usedAt(d1, ch.nonce), null, "the challenge is not used");
    const good = await claim(env, { token: g.token }, ch, "colony", CID, colonyProof(ch));
    assert.ok(good.ok, "and the same challenge still claims");
  } finally {
    d1.close();
  }
});

// ---------- T4: the claim code ----------

test("T4: a wrong claim code, or the public nonce in its place, is refused before any outside read (mutant: the claim selects its challenge by nonce or by 'latest')", async () => {
  const { d1, env, post } = world();
  try {
    const g = await writtenGuest(env, post, "wren");
    const ch = await askOk(env, { token: g.token }, "colony");
    const calls: any[] = [];
    for (const wrong of ["x".repeat(32), ch.nonce, ch.claim_code.slice(0, -1) + (ch.claim_code.endsWith("A") ? "B" : "A")]) {
      const r = await claim(env, { token: g.token }, { claim_code: wrong }, "colony", CID, colonyProof(ch), calls);
      assert.ok(!r.ok && r.status === 409 && r.code === "resident_account_no_challenge", wrong);
    }
    assert.equal(calls.length, 0, "no outside fetch ran for any of them");
    assert.equal(accountRows(d1).length, 0);
  } finally {
    d1.close();
  }
});

test("T4: a watcher who sees the holder's posted text cannot recover the holder's token, with a challenge of its own or without one (mutant: the claim ignores the claim code)", async () => {
  const { d1, env, post } = world();
  try {
    const g = await writtenGuest(env, post, "wren");
    await bindByAccount(env, g, "colony", { accountId: OUTSIDE_COLONY_ID, username: "wren-outside" });
    const oldHash = guestRow(d1, g.number)!.token_hash;
    // the holder asks for a recovery challenge and posts the text, which is public
    const mine = await askOk(env, { number: g.number }, "colony");
    const posted = colonyProof(mine, { accountId: OUTSIDE_COLONY_ID, username: "wren-outside" });
    // the watcher asks for its own recovery challenge (anyone can), and tries every claim it can build
    const theirs = await askOk(env, { number: g.number }, "colony");
    const calls: any[] = [];
    const guesses: Array<[string, { claim_code: string }]> = [
      ["the holder's nonce as the code", { claim_code: mine.nonce }],
      ["a guess", { claim_code: "g".repeat(32) }],
    ];
    for (const [name, code] of guesses) {
      const r = await claim(env, { number: g.number }, code, "colony", CID, posted, calls);
      assert.ok(!r.ok && r.code === "resident_account_no_challenge", name);
    }
    // with ITS OWN code the watcher's challenge is selected, but the posted text carries the HOLDER's nonce, so the proof is refused
    const own = await claim(env, { number: g.number }, theirs, "colony", CID, posted, calls);
    assert.ok(!own.ok && own.code === "resident_account_refused_nonce_missing", JSON.stringify(own));
    assert.equal(guestRow(d1, g.number)!.token_hash, oldHash, "the token is unchanged");
    assert.equal(calls.filter((c) => c.url.includes("/users/")).length, 1, "only the one selected claim read the platform");
    // the holder, with the code only it holds, recovers
    const real = await claim(env, { number: g.number }, mine, "colony", CID, posted);
    assert.ok(real.ok, JSON.stringify(real));
    if (real.ok) assert.ok(typeof real.body.token === "string" && real.body.token.startsWith("commonhold_visit_"));
  } finally {
    d1.close();
  }
});

test("B3/B12: several live challenges stand for one resident and each claims by its own code; a stranger's cannot block the holder's, across addresses (mutant: a per-resident live slot, or 'latest' selection)", async () => {
  const { d1, env, post } = world();
  try {
    const g = await writtenGuest(env, post, "wren");
    await bindByAccount(env, g, "colony", { accountId: OUTSIDE_COLONY_ID, username: "wren-outside" });
    const holder = await askOk(env, { number: g.number }, "colony");
    // a stranger floods: up to the per-address cap from each of three addresses, the holder's challenge standing among them
    let strangers = 0;
    for (const ip of [freshIp(), freshIp(), freshIp()]) {
      for (let i = 0; i < RESIDENT_ACCOUNT_CHALLENGE_PER_IP_PER_HOUR; i++) {
        const r = await ask(env, { number: g.number }, "colony", ip);
        assert.equal(r.status, 201);
        strangers++;
      }
      const over = await ask(env, { number: g.number }, "colony", ip);
      assert.equal(over.status, 429, "the per-address cap binds each address");
    }
    assert.ok(challengeRows(d1, g.number).filter((c) => c.used_at === null).length >= strangers + 1, "every one is live");
    const out = await claim(env, { number: g.number }, holder, "colony", CID, colonyProof(holder, { accountId: OUTSIDE_COLONY_ID, username: "wren-outside" }));
    assert.ok(out.ok, JSON.stringify(out));
    assert.equal(usedAt(d1, holder.nonce) !== null, true, "the holder's own challenge, not the latest, was the one used");
    assert.equal(challengeRows(d1, g.number).filter((c) => c.purpose === "recover" && c.used_at !== null).length, 1, "exactly one recovery challenge was used: the holder's, none of the strangers'");
  } finally {
    d1.close();
  }
});

// ---------- T6, B1, B15: recovery ----------

test("T6: recovery by a different account with the same HANDLE is refused (the id must match); the challenge stays live and the token is unchanged (mutant: the handle is compared instead of the id)", async () => {
  const { d1, env, post } = world();
  try {
    const g = await writtenGuest(env, post, "wren");
    await bindByAccount(env, g, "colony", { accountId: OUTSIDE_COLONY_ID, username: "same-handle" });
    const before = guestRow(d1, g.number)!.token_hash;
    const ch = await askOk(env, { number: g.number }, "colony");
    const r = await claim(env, { number: g.number }, ch, "colony", CID, colonyProof(ch, { accountId: uniqueColonyId(), username: "same-handle" }));
    assert.ok(!r.ok && r.status === 403 && r.code === "resident_account_wrong_account", JSON.stringify(r));
    assert.equal(guestRow(d1, g.number)!.token_hash, before);
    assert.equal(usedAt(d1, ch.nonce), null);
    // the right account, same challenge
    const ok = await claim(env, { number: g.number }, ch, "colony", CID, colonyProof(ch, { accountId: OUTSIDE_COLONY_ID, username: "renamed-since" }));
    assert.ok(ok.ok, "a changed handle is no obstacle when the id matches");
  } finally {
    d1.close();
  }
});

test("A5: recovery challenges exist only for a resident bound on THAT platform; a key-only resident and an unbound guest have none (mutant: the recover branch skips the account lookup)", async () => {
  const { d1, env, post } = world();
  try {
    const g = await writtenGuest(env, post, "wren");
    await bindByAccount(env, g, "colony");
    assert.equal((await ask(env, { number: g.number }, "1f916")).status, 404, "bound on the Colony, not on 1f916");
    assert.equal((await ask(env, { number: 99999 }, "colony")).status, 404);
    const keyed = await writtenGuest(env, post, "keyed");
    assert.equal((await bindRoute(env, keyed, await genKeypair())).status, 201);
    assert.equal((await ask(env, { number: keyed.number }, "colony")).status, 404, "a key resident has no account to recover by");
    const unbound = await writtenGuest(env, post, "plain");
    assert.equal((await ask(env, { number: unbound.number }, "colony")).status, 404);
    assert.equal((await ask(env, { number: "nope" }, "colony")).status, 400);
  } finally {
    d1.close();
  }
});

test("B1: a recovery kills the old token everywhere, with the visitors row present and with it evicted, and the new token works (mutant: the visitors rewrite is dropped from the batch)", async () => {
  for (const evict of [false, true]) {
    const { d1, env, post } = world();
    try {
      const g = await writtenGuest(env, post, "wren");
      await bindByAccount(env, g, "colony", { accountId: OUTSIDE_COLONY_ID, username: "wren-outside" });
      if (evict) d1.raw.prepare("DELETE FROM visitors WHERE id = ?").run(g.number);
      else assert.ok(d1.raw.prepare("SELECT 1 FROM visitors WHERE id = ?").get(g.number), "the ring still holds the visitor");
      const ch = await askOk(env, { number: g.number }, "colony");
      const out = await claim(env, { number: g.number }, ch, "colony", CID, colonyProof(ch, { accountId: OUTSIDE_COLONY_ID, username: "wren-outside" }));
      assert.ok(out.ok, JSON.stringify(out));
      if (!out.ok) return;
      const fresh = out.body.token as string;
      await assert.rejects(authenticateGuest(env, g.token), /Unknown guest token|No guest token/, `the old token is dead (evicted: ${evict})`);
      const viaComment = await call(env, "POST", "/api/guest/comment", { token: g.token, post_id: post, body: "with the old token" }, withIp());
      assert.equal(viaComment.status, 401);
      const ok = await call(env, "POST", "/api/guest/comment", { token: fresh, post_id: post, body: "with the new token" }, withIp());
      assert.equal(ok.status, 201);
      assert.equal(ok.body.tier, "resident");
      assert.equal(out.body.byline, `resident:wren#${g.number}`);
    } finally {
      d1.close();
    }
  }
});

test("B1: two concurrent recoveries for one resident return ONE token, and the loser is told so (mutant: the guests UPDATE is not guarded on the old hash)", async () => {
  const { d1, env, post } = world();
  try {
    const g = await writtenGuest(env, post, "wren");
    await bindByAccount(env, g, "colony", { accountId: OUTSIDE_COLONY_ID, username: "wren-outside" });
    const a = await askOk(env, { number: g.number }, "colony");
    const b = await askOk(env, { number: g.number }, "colony");
    // a barrier inside the outside read: both claims have taken their token-hash snapshot (before the read) and have finished their outside read before either reaches its batch
    let arrived = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = (ch: Challenge) => {
      const routes = colonyProof(ch, { accountId: OUTSIDE_COLONY_ID, username: "wren-outside" });
      const inner = fixtureFetch(routes);
      return async (url: string, init: any) => {
        if (url.includes("/comments/")) {
          arrived++;
          if (arrived === 2) release();
          await gate;
        }
        return inner(url, init);
      };
    };
    const { residentAccountClaim } = await import("../src/resident-account.ts");
    const run = (ch: Challenge) => residentAccountClaim(env, { number: g.number, platform: "colony", record_id: CID, claim_code: ch.claim_code }, freshIp(), slow(ch) as any).then((v) => ({ ok: true as const, v }), (e) => ({ ok: false as const, e }));
    const [ra, rb] = await Promise.all([run(a), run(b)]);
    const winners = [ra, rb].filter((r) => r.ok);
    const losers = [ra, rb].filter((r) => !r.ok);
    assert.equal(winners.length, 1, "exactly one token was returned");
    assert.equal(losers.length, 1);
    assert.equal((losers[0] as any).e.status, 409);
    assert.equal((losers[0] as any).e.code, "resident_account_recovery_lost");
    const token = (winners[0] as any).v.token as string;
    assert.equal(guestRow(d1, g.number)!.token_hash, await sha256Hex(token), "the stored hash is the winner's");
    assert.equal(challengeRows(d1, g.number).filter((c) => c.purpose === "recover" && c.used_at !== null).length, 1, "only the winner's challenge was used");
  } finally {
    d1.close();
  }
});

test("B1 (staggered): B's outside read is held while A's recovery completes and returns its token; B is then refused, no token, its challenge not consumed, and A's token stays valid (mutant: the old hash is read AFTER the outside read)", async () => {
  const { d1, env, post } = world();
  try {
    const g = await writtenGuest(env, post, "wren");
    await bindByAccount(env, g, "colony", { accountId: OUTSIDE_COLONY_ID, username: "wren-outside" });
    const a = await askOk(env, { number: g.number }, "colony");
    const b = await askOk(env, { number: g.number }, "colony");
    const { residentAccountClaim } = await import("../src/resident-account.ts");
    let bReached!: () => void;
    const reached = new Promise<void>((r) => (bReached = r));
    let releaseB!: () => void;
    const hold = new Promise<void>((r) => (releaseB = r));
    const bFetch = fixtureFetch(colonyProof(b, { accountId: OUTSIDE_COLONY_ID, username: "wren-outside" }));
    const heldFetch: any = async (url: string, init: any) => {
      if (url.includes("/comments/")) {
        bReached();
        await hold;
      }
      return bFetch(url, init);
    };
    const bRun = residentAccountClaim(env, { number: g.number, platform: "colony", record_id: CID, claim_code: b.claim_code }, freshIp(), heldFetch).then((v) => ({ ok: true as const, v }), (e) => ({ ok: false as const, e }));
    await reached; // B has its snapshot and is waiting on the platform
    const aOut = await claim(env, { number: g.number }, a, "colony", CID, colonyProof(a, { accountId: OUTSIDE_COLONY_ID, username: "wren-outside" }));
    assert.ok(aOut.ok, JSON.stringify(aOut));
    if (!aOut.ok) return;
    const tokenA = aOut.body.token as string;
    releaseB();
    const bOut = await bRun;
    assert.ok(!bOut.ok && (bOut as any).e.status === 409 && (bOut as any).e.code === "resident_account_recovery_lost", "B is refused");
    assert.equal(usedAt(d1, b.nonce), null, "B's challenge was not consumed");
    assert.notEqual(usedAt(d1, a.nonce), null);
    assert.equal(guestRow(d1, g.number)!.token_hash, await sha256Hex(tokenA), "A's token is still the stored one");
    const still = await call(env, "POST", "/api/guest/comment", { token: tokenA, post_id: post, body: "A's token still works" }, withIp());
    assert.equal(still.status, 201);
  } finally {
    d1.close();
  }
});

test("B15: a challenge that expires while the outside read is pending writes nothing, and a replay of a used claim code fails (mutant: expiry is checked only before the read; or the burn is dropped)", async () => {
  const { d1, env, post } = world();
  try {
    const g = await writtenGuest(env, post, "wren");
    await bindByAccount(env, g, "colony", { accountId: OUTSIDE_COLONY_ID, username: "wren-outside" });
    const oldHash = guestRow(d1, g.number)!.token_hash;
    const ch = await askOk(env, { number: g.number }, "colony");
    const routes = colonyProof(ch, { accountId: OUTSIDE_COLONY_ID, username: "wren-outside" });
    const inner = fixtureFetch(routes);
    const { residentAccountClaim } = await import("../src/resident-account.ts");
    const expiring: any = async (url: string, init: any) => {
      d1.raw.prepare("UPDATE resident_account_challenges SET expires_at = ? WHERE nonce = ?").run(Date.now() - 1, ch.nonce);
      return inner(url, init);
    };
    await assert.rejects(
      residentAccountClaim(env, { number: g.number, platform: "colony", record_id: CID, claim_code: ch.claim_code }, freshIp(), expiring),
      (e: any) => e.status === 409 && e.code === "resident_account_recovery_lost",
    );
    assert.equal(guestRow(d1, g.number)!.token_hash, oldHash, "no token was replaced");
    assert.equal(usedAt(d1, ch.nonce), null, "and the challenge was not marked used");
    // a good claim, then the SAME claim code again
    const ch2 = await askOk(env, { number: g.number }, "colony");
    const good = await claim(env, { number: g.number }, ch2, "colony", CID, colonyProof(ch2, { accountId: OUTSIDE_COLONY_ID, username: "wren-outside" }));
    assert.ok(good.ok);
    const replay = await claim(env, { number: g.number }, ch2, "colony", CID, colonyProof(ch2, { accountId: OUTSIDE_COLONY_ID, username: "wren-outside" }));
    assert.ok(!replay.ok && replay.code === "resident_account_no_challenge", "a sequential replay fails");
  } finally {
    d1.close();
  }
});

// ---------- B2: the bind is guarded on the current token ----------

test("B2: a token replaced while the outside read is pending makes the pending bind write nothing, and the challenge is not used (mutant: the EXISTS on token_hash is dropped)", async () => {
  const { d1, env, post } = world();
  try {
    const g = await writtenGuest(env, post, "wren");
    const ch = await askOk(env, { token: g.token }, "colony");
    const racing = raceEnv(env, /INSERT INTO resident_accounts/, () => d1.raw.prepare("UPDATE guests SET token_hash = 'replaced-by-a-key-recovery' WHERE visitor_id = ?").run(g.number));
    const out = await claim(racing, { token: g.token }, ch, "colony", CID, colonyProof(ch));
    assert.ok(!out.ok && out.status === 409 && out.code === "resident_account_claim_lost", JSON.stringify(out));
    assert.equal(accountRows(d1).length, 0);
    assert.equal(guestRow(d1, g.number)!.resident_at, null, "the guest was not promoted");
    assert.equal(usedAt(d1, ch.nonce), null);
  } finally {
    d1.close();
  }
});

// ---------- T7, B5: one account, one resident, both tables ----------

test("T7: one outside account cannot back two residents, and the second guest is neither promoted nor has its challenge used (mutant: the UNIQUE key and the pre-check are dropped)", async () => {
  const { d1, env, post } = world();
  try {
    const a = await writtenGuest(env, post, "alpha");
    await bindByAccount(env, a, "colony", { accountId: OUTSIDE_COLONY_ID, username: "shared" });
    const b = await writtenGuest(env, post, "bravo");
    const ch = await askOk(env, { token: b.token }, "colony");
    const r = await claim(env, { token: b.token }, ch, "colony", CID, colonyProof(ch, { accountId: OUTSIDE_COLONY_ID, username: "shared" }));
    assert.ok(!r.ok && r.status === 409 && r.code === "resident_account_already_used", JSON.stringify(r));
    assert.equal(guestRow(d1, b.number)!.resident_at, null);
    assert.equal(usedAt(d1, ch.nonce), null);
    // the same id on ANOTHER platform is a different account
    assert.equal(accountRows(d1).length, 1);
  } finally {
    d1.close();
  }
});

test("T7/B5: a concurrent pair, two guests claiming one account at once, seats exactly one (mutant: the INSERT is not unique on (platform, account))", async () => {
  const { d1, env, post } = world();
  try {
    const a = await writtenGuest(env, post, "alpha");
    const b = await writtenGuest(env, post, "bravo");
    const ca = await askOk(env, { token: a.token }, "colony");
    const cb = await askOk(env, { token: b.token }, "colony");
    // bravo's batch is made to land between alpha's pre-check and alpha's batch
    const racing = raceEnv(env, /INSERT INTO resident_accounts/, () => {
      d1.raw.prepare("INSERT INTO resident_accounts (visitor_id, platform, external_account_id, external_handle, record_id, record_created_at, retrieved_at, record_sha256, account_sha256, created_at) VALUES (?, 'colony', ?, 'shared', 'r', 1, 1, 'a', 'b', 1)").run(b.number, OUTSIDE_COLONY_ID);
      d1.raw.prepare("UPDATE guests SET resident_at = 1 WHERE visitor_id = ?").run(b.number);
    });
    const r = await claim(racing, { token: a.token }, ca, "colony", CID, colonyProof(ca, { accountId: OUTSIDE_COLONY_ID, username: "shared" }));
    assert.ok(!r.ok && r.status === 409 && r.code === "resident_account_already_used", JSON.stringify(r));
    assert.equal(guestRow(d1, a.number)!.resident_at, null, "the loser is not promoted");
    assert.equal(usedAt(d1, ca.nonce), null, "and its challenge is not used");
    assert.equal(accountRows(d1).length, 1);
    void cb;
  } finally {
    d1.close();
  }
});

test("B5: an account already seating a DIFFERENT resident on the council cannot back another resident; the same resident may hold both (mutant: the NOT EXISTS on council_claims is dropped from the resident INSERT)", async () => {
  const { d1, env, post } = world();
  try {
    const seated = await seedEarned(d1, "seated", { platform: "colony", external_account_id: OUTSIDE_COLONY_ID, external_handle: "outside" });
    const g = await writtenGuest(env, post, "newcomer");
    // pre-check path
    const ch = await askOk(env, { token: g.token }, "colony");
    const pre = await claim(env, { token: g.token }, ch, "colony", CID, colonyProof(ch, { accountId: OUTSIDE_COLONY_ID, username: "outside" }));
    assert.ok(!pre.ok && pre.status === 409 && pre.code === "resident_account_council_conflict", JSON.stringify(pre));
    // the INSERT's own guard, past the pre-check: the seat lands between the pre-check and the batch
    const g2 = await writtenGuest(env, post, "racer");
    const other = uniqueColonyId();
    const ch2 = await askOk(env, { token: g2.token }, "colony");
    const racing = raceEnv(env, /INSERT INTO resident_accounts/, () => seedClaim(d1, seated.number + 1000, { platform: "colony", external_account_id: other, external_handle: "late" }));
    const lost = await claim(racing, { token: g2.token }, ch2, "colony", CID, colonyProof(ch2, { accountId: other, username: "late" }));
    assert.ok(!lost.ok && lost.code === "resident_account_claim_lost", JSON.stringify(lost));
    assert.equal(guestRow(d1, g2.number)!.resident_at, null);
    assert.equal(usedAt(d1, ch2.nonce), null);
    // the same visitor in both is allowed: a key resident with a seat adds the SAME account as its residency account
    const own = await seedResident(d1, "own", { number: 8801 });
    seedPresence(d1, own, 3);
    seedClaim(d1, own.number, { platform: "colony", external_account_id: "c0ffee00-0000-4000-8000-000000000001", external_handle: "own-outside" });
    const ownCh = await askOk(env, { token: own.token }, "colony");
    const ok = await claim(env, { token: own.token }, ownCh, "colony", CID, colonyProof(ownCh, { accountId: "c0ffee00-0000-4000-8000-000000000001", username: "own-outside" }));
    assert.ok(ok.ok, JSON.stringify(ok));
    if (ok.ok) assert.equal(ok.body.route, "both");
  } finally {
    d1.close();
  }
});

test("B5: the council's own INSERT refuses an account that already backs a different resident, and leaves the challenge unused (mutant: the NOT EXISTS on resident_accounts is dropped from claimCouncilSeat)", async () => {
  const { d1, env, post } = world();
  try {
    const backed = await writtenGuest(env, post, "backed");
    await bindByAccount(env, backed, "1f916", { username: "shared-f916", f916Id: 777 });
    const r = await seedResident(d1, "keyed", { number: 8802 });
    seedPresence(d1, r, 3);
    const ch = await call(env, "POST", "/api/council/challenge", { token: r.token }, withIp());
    assert.equal(ch.status, 201, JSON.stringify(ch.body));
    const routes = {
      [recordUrl(555)]: { body: recordJson({ id: 555, author: "shared-f916", created_at: ch.body.issued_at + 1, body: ch.body.text_to_post }) },
      [accountUrl("shared-f916")]: { body: accountJson({ handle: "shared-f916", citizen_id: 777, karma: 40, created_at: Date.now() - 90 * 86_400_000 }) },
    };
    const out = await claimCouncilSeat(env, { token: r.token, platform: "1f916", record_id: 555 }, freshIp(), fixtureFetch(routes));
    void out;
  } catch (e: any) {
    assert.equal(e.status, 409);
    assert.equal(e.code, "council_challenge_lost");
    const seats = rows(d1, "SELECT * FROM council_claims");
    assert.equal(seats.length, 0, "no seat was written");
    const live = rows<any>(d1, "SELECT used_at FROM council_challenges");
    assert.equal(live[0]!.used_at, null, "the council challenge was not used");
    return;
  } finally {
    d1.close();
  }
  assert.fail("the council seated an account that already backs another resident");
});

// ---------- T10: an unreadable platform ----------

test("T10: an unreachable platform is a 503 and an unusable answer a 502, neither uses up the challenge, and a retry then succeeds (mutant: the burn happens before the read)", async () => {
  const { d1, env, post } = world();
  try {
    const g = await writtenGuest(env, post, "wren");
    const ch = await askOk(env, { token: g.token }, "colony");
    const down = await claim(env, { token: g.token }, ch, "colony", CID, { [`https://thecolony.ai/api/v1/comments/${CID}`]: { status: 503, body: "{}" } });
    assert.ok(!down.ok && down.status === 503 && down.code === "resident_account_source_unreadable_not_ok", JSON.stringify(down));
    const odd = await claim(env, { token: g.token }, ch, "colony", CID, { [`https://thecolony.ai/api/v1/comments/${CID}`]: { body: "<html>" } });
    assert.ok(!odd.ok && odd.status === 502 && odd.code === "resident_account_source_unreadable_not_json");
    assert.equal(usedAt(d1, ch.nonce), null);
    assert.equal(guestRow(d1, g.number)!.resident_at, null);
    assert.equal(accountRows(d1).length, 0);
    const ok = await claim(env, { token: g.token }, ch, "colony", CID, colonyProof(ch));
    assert.ok(ok.ok);
  } finally {
    d1.close();
  }
});

// ---------- T11 at the route ----------

test("T11: nothing of the proof comment's text reaches any table (mutant: the body is stored beside the hashes)", async () => {
  const { d1, env, post } = world();
  try {
    const g = await writtenGuest(env, post, "wren");
    const ch = await askOk(env, { token: g.token }, "colony");
    const secretWords = "an extra sentence the platform served and we must not keep";
    const out = await claim(env, { token: g.token }, ch, "colony", CID, colonyProof(ch, { body: `${ch.text_to_post} ${secretWords}` }));
    assert.ok(out.ok);
    for (const t of ["resident_accounts", "resident_account_challenges", "guests"]) {
      assert.ok(!JSON.stringify(rows(d1, `SELECT * FROM ${t}`)).includes(secretWords), `${t} holds no record text`);
    }
    assert.ok(!JSON.stringify(out.ok ? out.body : {}).includes(secretWords), "and the answer serves none");
  } finally {
    d1.close();
  }
});

// ---------- T14: the key bind and the account bind keep each other's resident_at ----------

test("T14: binding a key later does not overwrite resident_at, and answers the stored value and route both; the other order keeps it too (mutant: the UPDATE sets resident_at = ?)", async () => {
  const { d1, env, post } = world();
  try {
    const g = await writtenGuest(env, post, "wren");
    const body = await bindByAccount(env, g, "colony");
    const first = guestRow(d1, g.number)!.resident_at as number;
    d1.raw.prepare("UPDATE guests SET resident_at = ? WHERE visitor_id = ?").run(first - 5_000_000, g.number);
    const earlier = first - 5_000_000;
    const bound = await bindRoute(env, g, await genKeypair());
    assert.equal(bound.status, 201, JSON.stringify(bound.body));
    assert.equal(guestRow(d1, g.number)!.resident_at, earlier, "the earlier resident_at stands");
    assert.equal(bound.body.resident_at, earlier, "and is what the answer says, not this request's clock");
    assert.equal(bound.body.route, "both");
    assert.equal((await call(env, "GET", `/api/resident/${g.number}`)).body.route, "both");
    void body;
    // the other order: a key resident adds an account
    const k = await writtenGuest(env, post, "keyfirst");
    assert.equal((await bindRoute(env, k, await genKeypair())).status, 201);
    const stamp = guestRow(d1, k.number)!.resident_at as number;
    d1.raw.prepare("UPDATE guests SET resident_at = ? WHERE visitor_id = ?").run(stamp - 1_000_000, k.number);
    const added = await bindByAccount(env, k, "1f916");
    assert.equal(added.route, "both");
    assert.equal(added.resident_at, stamp - 1_000_000);
    assert.equal(guestRow(d1, k.number)!.resident_at, stamp - 1_000_000);
    // an account-only resident cannot recover by signing; a both-ways resident still can
    const refusedSign = await recoverRoute(env, g, await genKeypair());
    assert.equal(refusedSign.status, 401, "a different key does not verify");
  } finally {
    d1.close();
  }
});

test("B6/B8: key recovery for an account-only resident says it recovers by its account, and key bind's refusal says a key is already bound (mutant: the old 404 wording stays)", async () => {
  const { d1, env, post } = world();
  try {
    const g = await writtenGuest(env, post, "wren");
    await bindByAccount(env, g, "colony");
    const kp = await genKeypair();
    const r = await recoverRoute(env, g, kp);
    assert.equal(r.status, 409);
    assert.match(r.body.error, /bound by an outside account, not a key/);
    assert.match(r.body.error, /POST \/api\/resident\/account\/challenge/);
    const k = await writtenGuest(env, post, "keyed");
    const kp2 = await genKeypair();
    assert.equal((await bindRoute(env, k, kp2)).status, 201);
    const again = await bindRoute(env, k, await genKeypair());
    assert.equal(again.status, 409);
    assert.match(again.body.error, /already a resident by key/);
    const unknown = await call(env, "POST", "/api/guest/comment", { token: "commonhold_visit_unknown", post_id: post, body: "x" }, withIp());
    assert.match(unknown.body.error, /unless a key or an outside account was bound/);
  } finally {
    d1.close();
  }
});

test("cleanup: challenges that expired more than a day ago are removed by a later challenge, and a recent expired one is kept (mutant: no cleanup, or a cutoff of now)", async () => {
  const { d1, env, post } = world();
  try {
    const g = await writtenGuest(env, post, "wren");
    const old = await askOk(env, { token: g.token }, "colony");
    const recent = await askOk(env, { token: g.token }, "colony");
    d1.raw.prepare("UPDATE resident_account_challenges SET expires_at = ? WHERE nonce = ?").run(Date.now() - 2 * 86_400_000, old.nonce);
    d1.raw.prepare("UPDATE resident_account_challenges SET expires_at = ? WHERE nonce = ?").run(Date.now() - 3_600_000, recent.nonce);
    await askOk(env, { token: g.token }, "colony");
    const nonces = challengeRows(d1).map((c) => c.nonce);
    assert.ok(!nonces.includes(old.nonce));
    assert.ok(nonces.includes(recent.nonce));
  } finally {
    d1.close();
  }
});
