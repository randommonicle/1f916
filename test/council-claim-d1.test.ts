// The earned seat: the challenge, the claim and the 1f916 verifier (D-075 order step c; commission C3, CA1, CA4; K7, K8.1-K8.3). Real local D1, the real router for the
// challenge, the real claim function for the claim with a fetch double that serves the PINNED fixtures captured by public GET on 12 Oct (test/fixtures/1f916/). No outbound
// fetch is possible from here: importing the helper replaces the global fetch with a function that throws. Every positive case is the fixture with one NAMED edit applied
// (recordJson / accountJson); the unedited fixture fails twice by construction (its record predates any challenge, and its author is the operator's declared account).
//
// Each block names the mutant that turns it red; docs/CHECKPOINT-COUNCIL.md records each one run and restored.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import {
  createLocalD1, guestEnv, call, seedWorld, seedResident, seedPresence, seedEarned, withIp, freshIp, rows, fixtureFetch, recordJson, accountJson, recordUrl, accountUrl,
  fixtureText, sha256Of, NETWORK_GUARD_MESSAGE, HOST, type LocalD1, type SeededResident, type Served,
} from "./helpers/council.ts";
import { claimCouncilSeat, councilMembers } from "../src/council.ts";
import { verifyF916Claim, COUNCIL_CLOCK_SKEW_MS, COUNCIL_FETCH_TIMEOUT_MS } from "../src/council-verify.ts";
import { COUNCIL_CHALLENGE_TTL_MS, COUNCIL_CHALLENGE_PER_IP_PER_HOUR } from "../src/council-core.ts";
import { SocietyError, type Env } from "../src/society.ts";

const DAY = 86_400_000;
const RID = 424242;

function world() {
  const d1 = createLocalD1();
  seedWorld(d1);
  return { d1, env: guestEnv(d1) };
}

interface Challenge {
  nonce: string;
  issued_at: number;
  expires_at: number;
  text_to_post: string;
  number: number;
}
// A resident who has met the presence floor and holds a live challenge, made through the real route.
async function ready(d1: LocalD1, env: Env, handle: string, presenceDays = 3): Promise<{ r: SeededResident; ch: Challenge }> {
  const r = await seedResident(d1, handle);
  seedPresence(d1, r, presenceDays);
  const res = await call(env, "POST", "/api/council/challenge", { token: r.token }, withIp());
  assert.equal(res.status, 201, JSON.stringify(res.body));
  return { r, ch: res.body as Challenge };
}

// The two reads for one proof: a record by `author` carrying the challenge, and the author's account. Each named edit is one argument.
function proof(ch: Challenge, author: string, over: { record?: Parameters<typeof recordJson>[0]; account?: Parameters<typeof accountJson>[0]; id?: number } = {}): Record<string, Served> {
  const id = over.id ?? RID;
  return {
    [recordUrl(id)]: { body: recordJson({ id, author, created_at: ch.issued_at + 1, body: ch.text_to_post, ...over.record }) },
    [accountUrl(author)]: { body: accountJson({ handle: author, citizen_id: 777, karma: 31, created_at: Date.now() - 90 * DAY, ...over.account }) },
  };
}

type Outcome = { ok: true; body: any } | { ok: false; status: number; code: string | undefined; message: string };
async function claim(env: Env, r: SeededResident, routes: Record<string, Served | Error>, over: Record<string, unknown> = {}, calls: any[] = []): Promise<Outcome> {
  try {
    return { ok: true, body: await claimCouncilSeat(env, { token: r.token, platform: "1f916", record_id: RID, ...over }, freshIp(), fixtureFetch(routes, calls)) };
  } catch (e) {
    if (e instanceof SocietyError) return { ok: false, status: e.status, code: e.code, message: e.message };
    throw e;
  }
}

const claimRows = (d1: LocalD1) => rows<{ visitor_id: number }>(d1, "SELECT * FROM council_claims");
const usedAt = (d1: LocalD1, nonce: string) => (d1.raw.prepare("SELECT used_at FROM council_challenges WHERE nonce = ?").get(nonce) as { used_at: number | null }).used_at;

// ---------- the happy path ----------

test("claim: a proof comment from an old, reputable account seats the resident, stores the evidence and burns the nonce in the same step; the seat is served with its evidence (mutant: the INSERT or the burn is dropped)", async () => {
  const { d1, env } = world();
  try {
    const { r, ch } = await ready(d1, env, "wren");
    const routes = proof(ch, "wren-on-1f916");
    const calls: any[] = [];
    const out = await claim(env, r, routes, {}, calls);
    assert.ok(out.ok, JSON.stringify(out));
    assert.equal(out.body.seated, true);
    assert.equal(out.body.byline, `resident:wren#${r.number}`);
    assert.deepEqual(calls.map((c) => c.url), [recordUrl(RID), accountUrl("wren-on-1f916")], "exactly two outbound reads, the record then the account, on the pinned origin");
    const row = d1.raw.prepare("SELECT * FROM council_claims").get() as Record<string, any>;
    assert.equal(row.visitor_id, r.number);
    assert.equal(row.platform, "1f916");
    assert.equal(row.external_account_id, "777", "the account id is a canonical decimal string");
    assert.equal(row.external_handle, "wren-on-1f916");
    assert.equal(row.record_id, String(RID), "the record id is a canonical decimal string");
    assert.equal(row.record_body, ch.text_to_post);
    assert.equal(row.account_karma, 31);
    assert.equal(row.record_sha256, sha256Of(routes[recordUrl(RID)]!.body!), "the hash is over the exact response served");
    assert.equal(row.account_sha256, sha256Of(routes[accountUrl("wren-on-1f916")]!.body!));
    assert.ok(usedAt(d1, ch.nonce) !== null, "the nonce is burnt by the success");
    const served = (await call(env, "GET", "/api/council")).body;
    const wren = served.members.find((m: { handle: string }) => m.handle === "wren");
    assert.equal(wren.rule, "earned");
    assert.equal(wren.evidence.record_sha256, row.record_sha256);
    assert.equal(wren.evidence.account_id, "777");
    assert.equal(served.counts.earned, 1);
  } finally {
    d1.close();
  }
});

test("the unedited pinned fixtures fail for the two reasons the commission names: the record predates the challenge, and its author is the operator's declared account (mutant: either check is dropped)", async () => {
  const { d1, env } = world();
  try {
    const { r } = await ready(d1, env, "wren");
    const raw = { [recordUrl(102669)]: { body: fixtureText("comment-102669.json") }, [accountUrl("commonhold-envoy")]: { body: fixtureText("citizen-commonhold-envoy.trimmed.json") } };
    const out = await claim(env, r, raw, { record_id: 102669 });
    assert.ok(!out.ok);
    assert.equal(out.status, 403);
    assert.equal(out.code, "council_refused_record_stale", "the record is from 9 Oct, long before any challenge issued now");
    assert.equal(claimRows(d1).length, 0);
  } finally {
    d1.close();
  }
});

// ---------- refusals on the merits: each names its reason, writes nothing, and leaves the challenge live ----------

const REFUSALS: Array<[string, (ch: Challenge, now: number) => Record<string, Served>, string]> = [
  ["stale record (created at the instant of the challenge, not after it)", (ch) => proof(ch, "a", { record: { created_at: ch.issued_at } }), "record_stale"],
  ["stale record (created before the challenge)", (ch) => proof(ch, "a", { record: { created_at: ch.issued_at - 60_000 } }), "record_stale"],
  ["future record (an hour ahead of this server's clock)", (ch, now) => proof(ch, "a", { record: { created_at: now + 3_600_000 } }), "record_future"],
  ["missing nonce", (ch) => proof(ch, "a", { record: { body: ch.text_to_post.replace(ch.nonce, "not-the-nonce") } }), "nonce_missing"],
  ["wrong key", (ch) => proof(ch, "a", { record: { body: ch.text_to_post.replace(/key .*$/, "key AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA") } }), "key_missing"],
  ["wrong visitor", (ch) => proof(ch, "a", { record: { body: ch.text_to_post.replace(`resident ${ch.number}`, "resident 99999999") } }), "visitor_missing"],
  ["young account (59 days)", (ch) => proof(ch, "a", { account: { created_at: Date.now() - 59 * DAY } }), "account_too_young"],
  ["low karma (9)", (ch) => proof(ch, "a", { account: { karma: 9 } }), "karma_too_low"],
  ["the operator's declared account, by list (case-insensitive)", (ch) => proof(ch, "Commonhold-Envoy"), "operator_account"],
  ["a record hidden by moderation on the platform", (ch) => proof(ch, "a", { record: { mod_state: "removed" } }), "record_moderated"],
];

for (const [name, build, code] of REFUSALS) {
  test(`claim refused (${name}): 403 council_refused_${code}, nothing written, the challenge still live and the claim fixable (mutant: the check behind ${code} is dropped)`, async () => {
    const { d1, env } = world();
    try {
      const { r, ch } = await ready(d1, env, "wren");
      const out = await claim(env, r, build(ch, Date.now()));
      assert.ok(!out.ok, `expected a refusal, got ${JSON.stringify(out)}`);
      assert.equal(out.status, 403);
      assert.equal(out.code, `council_refused_${code}`);
      assert.match(out.message, /Claim refused: /);
      assert.match(out.message, /Nothing was written/);
      assert.equal(claimRows(d1).length, 0, "no seat");
      assert.equal(usedAt(d1, ch.nonce), null, "the nonce is not burnt by a refusal");
      // the claimant can fix the proof and claim again with the SAME challenge
      const fixed = await claim(env, r, proof(ch, "wren-on-1f916"));
      assert.ok(fixed.ok, `the fixed claim should seat: ${JSON.stringify(fixed)}`);
    } finally {
      d1.close();
    }
  });
}

test("claim refused when the platform says the record or the account does not exist (the pinned 404 shapes): record_missing and account_missing, nothing written", async () => {
  const { d1, env } = world();
  try {
    const { r, ch } = await ready(d1, env, "wren");
    const missingRecord = await claim(env, r, { [recordUrl(RID)]: { status: 404, body: fixtureText("comment-missing.json") } });
    assert.ok(!missingRecord.ok);
    assert.deepEqual([missingRecord.status, missingRecord.code], [403, "council_refused_record_missing"]);
    const base = proof(ch, "ghost");
    const missingAccount = await claim(env, r, { [recordUrl(RID)]: base[recordUrl(RID)]!, [accountUrl("ghost")]: { status: 404, body: fixtureText("citizen-missing.json") } });
    assert.ok(!missingAccount.ok);
    assert.deepEqual([missingAccount.status, missingAccount.code], [403, "council_refused_account_missing"]);
    assert.equal(claimRows(d1).length, 0);
    assert.equal(usedAt(d1, ch.nonce), null);
  } finally {
    d1.close();
  }
});

// ---------- unreadable: never a verdict on the claim ----------

const UNREADABLE: Array<[string, (ch: Challenge) => Record<string, Served | Error>, number, string]> = [
  ["comment.id served as a string (shape drift)", (ch) => proof(ch, "a", { record: { id: "424242" } }), 502, "shape_changed"],
  ["comment.id that is not the id asked", (ch) => proof(ch, "a", { record: { id: 1 } }), 502, "shape_changed"],
  ["the author is not a string", (ch) => ({ ...proof(ch, "a"), [recordUrl(RID)]: { body: recordJson({ id: RID, author: 5, created_at: ch.issued_at + 1, body: ch.text_to_post }) } }), 502, "shape_changed"],
  ["mod_state absent from the record", (ch) => ({ ...proof(ch, "a"), [recordUrl(RID)]: { body: recordJson({ id: RID, author: "a", created_at: ch.issued_at + 1, body: ch.text_to_post, dropMod: true }) } }), 502, "shape_changed"],
  ["created_at as a string", (ch) => proof(ch, "a", { record: { created_at: "2026-10-12" } }), 502, "shape_changed"],
  ["the account's handle is not the record's author", (ch) => proof(ch, "a", { account: { handle: "someone-else" } }), 502, "shape_changed"],
  ["the account's karma as a string", (ch) => proof(ch, "a", { account: { karma: "31" } }), 502, "shape_changed"],
  ["the account's id as a float", (ch) => proof(ch, "a", { account: { citizen_id: 7.5 } }), 502, "shape_changed"],
  ["a 404 that is not the pinned absent shape", (ch) => ({ ...proof(ch, "a"), [recordUrl(RID)]: { status: 404, body: '{"nope":1}' } }), 502, "shape_changed"],
  ["a record read that answers 500", (ch) => ({ ...proof(ch, "a"), [recordUrl(RID)]: { status: 500, body: "{}" } }), 503, "not_ok"],
  ["a record read that answers 429", (ch) => ({ ...proof(ch, "a"), [recordUrl(RID)]: { status: 429, body: "{}" } }), 503, "not_ok"],
  ["an account read that answers 403", (ch) => ({ ...proof(ch, "a"), [accountUrl("a")]: { status: 403, body: "{}" } }), 502, "not_ok"],
  ["a redirect answer (302)", (ch) => ({ ...proof(ch, "a"), [recordUrl(RID)]: { status: 302, headers: { location: "https://evil.example/" }, body: "" } }), 502, "redirect"],
  ["a fetch that throws (what a network failure does)", (ch) => ({ ...proof(ch, "a"), [recordUrl(RID)]: new TypeError("network connection lost") }), 503, "fetch_failed"],
  ["a body that is not JSON", (ch) => ({ ...proof(ch, "a"), [recordUrl(RID)]: { body: "<html>maintenance</html>" } }), 502, "not_json"],
  ["a body that is JSON but not an object", (ch) => ({ ...proof(ch, "a"), [accountUrl("a")]: { body: "[1,2,3]" } }), 502, "not_json"],
];

for (const [name, build, status, code] of UNREADABLE) {
  test(`unreadable (${name}): ${status} council_source_unreadable_${code}, NOT a refusal, nothing written, the challenge unburnt (mutant: this branch is folded into a refusal, or burns the nonce)`, async () => {
    const { d1, env } = world();
    try {
      const { r, ch } = await ready(d1, env, "wren");
      const out = await claim(env, r, build(ch));
      assert.ok(!out.ok);
      assert.equal(out.status, status);
      assert.equal(out.code, `council_source_unreadable_${code}`);
      assert.match(out.message, /not a refusal of your claim/);
      assert.match(out.message, /your challenge was not used/);
      assert.equal(claimRows(d1).length, 0);
      assert.equal(usedAt(d1, ch.nonce), null, "an unreadable source never burns the nonce");
    } finally {
      d1.close();
    }
  });
}

const VERIFY_BASE = (ch: { nonce: string; issuedAt: number }, now: number, over: Partial<{ visitorId: number; publicKey: string }> = {}) => ({
  recordId: String(RID),
  visitorId: over.visitorId ?? 7,
  publicKey: over.publicKey ?? "KEY-KEY-KEY-KEY",
  challenge: ch,
  now,
});
const goodText = (nonce: string, n = 7, key = "KEY-KEY-KEY-KEY") => `Commonhold council challenge ${nonce} resident ${n} key ${key}`;

test("verifier: an oversize body is cancelled while it is read, not buffered whole, and is reported unreadable (oversize), never refused (mutant: the cap is dropped, or applied after parsing)", async () => {
  const now = Date.UTC(2026, 9, 12, 12);
  let pulled = 0;
  const big = new Uint8Array(40 * 1024).fill(0x20);
  const fetchBig = fixtureFetch({ [recordUrl(RID)]: { chunks: Array.from({ length: 50 }, () => big), onPull: () => void pulled++ } });
  const out = await verifyF916Claim(VERIFY_BASE({ nonce: "n", issuedAt: now - 1000 }, now), { fetch: fetchBig });
  assert.equal(out.ok, false);
  assert.equal((out as any).kind, "unreadable");
  assert.equal((out as any).code, "oversize");
  assert.equal((out as any).retryable, false);
  assert.ok(pulled <= 4, `the read stopped early: ${pulled} of 50 chunks were pulled`);
  // a declared length over the cap is refused before a byte is read
  const declared = await verifyF916Claim(VERIFY_BASE({ nonce: "n", issuedAt: now - 1000 }, now), { fetch: fixtureFetch({ [recordUrl(RID)]: { body: "{}", headers: { "content-length": String(10 * 1024 * 1024) } } }) });
  assert.equal((declared as any).code, "oversize");
  // the cap is per read and configurable: a tiny cap makes a normal record oversize
  const tiny = await verifyF916Claim(VERIFY_BASE({ nonce: "n", issuedAt: now - 1000 }, now), { fetch: fixtureFetch({ [recordUrl(RID)]: { body: recordJson({ id: RID }) } }), recordMaxBytes: 100 });
  assert.equal((tiny as any).code, "oversize");
});

test("verifier: a slow fetch is abandoned at the timeout, whether or not it honours its signal, and is retryable (mutant: no timeout, or the race is removed)", async () => {
  const now = Date.UTC(2026, 9, 12, 12);
  const input = VERIFY_BASE({ nonce: "n", issuedAt: now - 1000 }, now);
  // honours the signal: resolves (rejects) only when aborted
  let sawAbort = false;
  const polite = (async (_url: string, init: { signal: AbortSignal }) => {
    await new Promise((_, reject) => init.signal.addEventListener("abort", () => ((sawAbort = true), reject(new Error("aborted")))));
    return new Response("{}");
  }) as never;
  const a = await verifyF916Claim(input, { fetch: polite, timeoutMs: 30 });
  assert.deepEqual([(a as any).kind, (a as any).code, (a as any).retryable], ["unreadable", "timeout", true]);
  assert.ok(sawAbort, "the signal was aborted");
  // ignores the signal entirely and never resolves
  const rude = (() => new Promise(() => undefined)) as never;
  const b = await verifyF916Claim(input, { fetch: rude, timeoutMs: 30 });
  assert.deepEqual([(b as any).kind, (b as any).code, (b as any).retryable], ["unreadable", "timeout", true]);
  assert.equal(COUNCIL_FETCH_TIMEOUT_MS, 5000, "the live bound is five seconds");
});

test("verifier: the boundaries, at a fixed clock: record one millisecond after the challenge passes and the instant fails; exactly 60 days passes and 60 days less a millisecond fails; karma 10 passes and 9 fails; the clock-skew allowance ends exactly at its limit", async () => {
  const now = Date.UTC(2026, 9, 12, 12);
  const issuedAt = now - 5 * 60_000;
  const run = (o: { created?: number; age?: number; karma?: number; body?: string }) =>
    verifyF916Claim(VERIFY_BASE({ nonce: "NONCE0123456789ABCDEF", issuedAt }, now), {
      fetch: fixtureFetch({
        [recordUrl(RID)]: { body: recordJson({ id: RID, author: "a", created_at: o.created ?? issuedAt + 1, body: o.body ?? goodText("NONCE0123456789ABCDEF") }) },
        [accountUrl("a")]: { body: accountJson({ handle: "a", citizen_id: 1, karma: o.karma ?? 10, created_at: now - (o.age ?? 60 * DAY) }) },
      }),
    });
  assert.equal((await run({})).ok, true, "all at their minimum passes");
  assert.equal(((await run({ created: issuedAt })) as any).code, "record_stale");
  assert.equal((await run({ created: now + COUNCIL_CLOCK_SKEW_MS })).ok, true, "a record the skew allowance covers");
  assert.equal(((await run({ created: now + COUNCIL_CLOCK_SKEW_MS + 1 })) as any).code, "record_future");
  assert.equal(((await run({ age: 60 * DAY - 1 })) as any).code, "account_too_young");
  assert.equal(((await run({ karma: 9 })) as any).code, "karma_too_low");
  // the resident number must stand alone: 7 is not satisfied by 17, or by 70
  assert.equal(((await run({ body: goodText("NONCE0123456789ABCDEF", 17) })) as any).code, "visitor_missing");
  assert.equal(((await run({ body: goodText("NONCE0123456789ABCDEF", 70) })) as any).code, "visitor_missing");
  assert.equal((await run({ body: `noise before ${goodText("NONCE0123456789ABCDEF")} noise after` })).ok, true, "the proof may sit inside other words");
});

test("verifier: a hostile author handle is percent-encoded into ONE path segment on the pinned origin; the request URL is exactly the encoded one (mutant: the handle is interpolated raw)", async () => {
  const now = Date.UTC(2026, 9, 12, 12);
  for (const author of ["../../evil", "a/b", "x?y=1#z", "@evil.example", "sp ace", "ünï"]) {
    const calls: any[] = [];
    const routes = {
      [recordUrl(RID)]: { body: recordJson({ id: RID, author, created_at: now, body: goodText("N") }) },
      [accountUrl(author)]: { body: accountJson({ handle: author, citizen_id: 5, karma: 50, created_at: now - 100 * DAY }) },
    };
    const out = await verifyF916Claim(VERIFY_BASE({ nonce: "N", issuedAt: now - 1000 }, now), { fetch: fixtureFetch(routes, calls) });
    assert.equal(out.ok, true, author);
    const requested = calls[1]!.url as string;
    assert.equal(requested, accountUrl(author), "exactly the encoded URL");
    assert.equal(new URL(requested).origin, HOST);
    assert.equal(new URL(requested).pathname.split("/").length, 4, `${author}: one segment after /api/citizen/`);
  }
});

test("evidence: the stored record body is capped at 2000 CHARACTERS (code points), never splits a surrogate pair, and the hash still covers the whole response (mutant: slice by UTF-16 unit, or no cap)", async () => {
  const { d1, env } = world();
  try {
    const { r, ch } = await ready(d1, env, "wren");
    const long = `${"\u{1F916}".repeat(2100)}${ch.text_to_post}`; // 2100 astral characters = 4200 UTF-16 units, then the proof
    const out = await claim(env, r, proof(ch, "wren-on-1f916", { record: { body: long } }));
    assert.ok(out.ok, JSON.stringify(out));
    const stored = (d1.raw.prepare("SELECT record_body FROM council_claims").get() as { record_body: string }).record_body;
    assert.equal(Array.from(stored).length, 2000, "2000 characters");
    assert.doesNotMatch(stored, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/, "no lone surrogate");
    assert.equal((d1.raw.prepare("SELECT record_sha256 FROM council_claims").get() as { record_sha256: string }).record_sha256, sha256Of(proof(ch, "wren-on-1f916", { record: { body: long } })[recordUrl(RID)]!.body!));
  } finally {
    d1.close();
  }
});

// ---------- nonce: single use, burnt only on success, bound to its resident ----------

test("nonce: a success burns it; a resident cannot seat on another resident's nonce; a second claim by a seated resident is refused (mutants: the burn is dropped; the lookup ignores the visitor)", async () => {
  const { d1, env } = world();
  try {
    const a = await ready(d1, env, "wren");
    const b = await ready(d1, env, "finch");
    assert.notEqual(a.ch.nonce, b.ch.nonce);
    // finch posts WREN's proof text (wren's nonce, number and key) from its own account: finch's own nonce is absent
    const stolen = await claim(env, b.r, proof(b.ch, "finch-acct", { record: { body: a.ch.text_to_post }, account: { citizen_id: 12 } }));
    assert.ok(!stolen.ok);
    assert.equal(stolen.code, "council_refused_nonce_missing");
    assert.equal(usedAt(d1, b.ch.nonce), null);
    const ok = await claim(env, a.r, proof(a.ch, "wren-acct"));
    assert.ok(ok.ok);
    assert.ok(usedAt(d1, a.ch.nonce) !== null);
    const again = await claim(env, a.r, proof(a.ch, "wren-acct"));
    assert.ok(!again.ok);
    assert.equal(again.code, "council_already_seated");
    assert.equal(claimRows(d1).length, 1);
  } finally {
    d1.close();
  }
});

// ---------- concurrency ----------

test("concurrent claims for ONE outside account by two residents seat at most one; the loser's challenge is not burnt (mutants: UNIQUE(platform, external_account_id) dropped; the burn runs outside the batch)", async () => {
  const { d1, env } = world();
  try {
    const a = await ready(d1, env, "wren");
    const b = await ready(d1, env, "finch");
    const routes: Record<string, Served> = {
      ...proof(a.ch, "shared-acct", { id: 111 }),
      [recordUrl(222)]: { body: recordJson({ id: 222, author: "shared-acct", created_at: b.ch.issued_at + 1, body: b.ch.text_to_post }) },
    };
    const [ra, rb] = await Promise.all([claim(env, a.r, routes, { record_id: 111 }), claim(env, b.r, routes, { record_id: 222 })]);
    const won = [ra, rb].filter((x) => x.ok);
    const lost = [ra, rb].filter((x) => !x.ok) as Array<Extract<Outcome, { ok: false }>>;
    assert.equal(won.length, 1, `exactly one seat (${JSON.stringify([ra, rb])})`);
    assert.equal(lost[0]!.status, 409);
    assert.equal(lost[0]!.code, "council_account_already_used");
    assert.equal(claimRows(d1).length, 1);
    const loserNonce = ra.ok ? b.ch.nonce : a.ch.nonce;
    const winnerNonce = ra.ok ? a.ch.nonce : b.ch.nonce;
    assert.equal(usedAt(d1, loserNonce), null, "the loser's challenge is untouched");
    assert.ok(usedAt(d1, winnerNonce) !== null);
  } finally {
    d1.close();
  }
});

test("the same account cannot seat a second resident later either (the reused-account case, sequential)", async () => {
  const { d1, env } = world();
  try {
    const a = await ready(d1, env, "wren");
    const b = await ready(d1, env, "finch");
    assert.ok((await claim(env, a.r, proof(a.ch, "shared-acct", { id: 111 }), { record_id: 111 })).ok);
    const second = await claim(env, b.r, proof(b.ch, "shared-acct", { id: 222 }), { record_id: 222 });
    assert.ok(!second.ok);
    assert.deepEqual([second.status, second.code], [409, "council_account_already_used"]);
    assert.equal(usedAt(d1, b.ch.nonce), null);
  } finally {
    d1.close();
  }
});

test("two concurrent claims by ONE resident on one challenge seat exactly once (mutant: the burn is unconditional or the INSERT does not check the challenge is still live)", async () => {
  const { d1, env } = world();
  try {
    const a = await ready(d1, env, "wren");
    const routes = proof(a.ch, "wren-acct");
    const results = await Promise.all([claim(env, a.r, routes), claim(env, a.r, routes), claim(env, a.r, routes)]);
    assert.equal(results.filter((x) => x.ok).length, 1, JSON.stringify(results));
    assert.equal(claimRows(d1).length, 1);
    assert.ok(usedAt(d1, a.ch.nonce) !== null);
  } finally {
    d1.close();
  }
});

test("concurrent challenge requests leave at most one live challenge for the resident (CA4: one conditional INSERT) (mutant: the NOT EXISTS is dropped)", async () => {
  const { d1, env } = world();
  try {
    const r = await seedResident(d1, "wren");
    seedPresence(d1, r, 3);
    const results = await Promise.all(Array.from({ length: 6 }, () => call(env, "POST", "/api/council/challenge", { token: r.token }, withIp())));
    assert.equal(results.filter((x) => x.status === 201).length, 1, JSON.stringify(results.map((x) => x.status)));
    assert.ok(results.filter((x) => x.status !== 201).every((x) => x.status === 409 && x.body.code === "council_challenge_live"));
    assert.equal(rows(d1, "SELECT * FROM council_challenges WHERE used_at IS NULL AND expires_at > ?", Date.now()).length, 1);
  } finally {
    d1.close();
  }
});

// ---------- the challenge: who may ask ----------

test("challenge: the shape of the answer, a 15 minute expiry, the exact text to post, and the stored row (mutant: the expiry or the stored row is wrong)", async () => {
  const { d1, env } = world();
  try {
    const { r, ch } = await ready(d1, env, "wren");
    assert.match(ch.nonce, /^[A-Za-z0-9_-]{22}$/);
    assert.equal(ch.expires_at - ch.issued_at, COUNCIL_CHALLENGE_TTL_MS);
    assert.equal(COUNCIL_CHALLENGE_TTL_MS, 15 * 60_000);
    assert.equal(ch.text_to_post, `Commonhold council challenge ${ch.nonce} resident ${r.number} key ${r.kp.publicKey}`);
    const row = d1.raw.prepare("SELECT * FROM council_challenges").get() as Record<string, any>;
    assert.deepEqual({ nonce: row.nonce, visitor_id: row.visitor_id, issued_at: row.issued_at, expires_at: row.expires_at, used_at: row.used_at }, { nonce: ch.nonce, visitor_id: r.number, issued_at: ch.issued_at, expires_at: ch.expires_at, used_at: null });
  } finally {
    d1.close();
  }
});

test("challenge refused: a guest with no bound key, an unknown token, no token, a citizen credential in Authorization, a resident already seated, one with a live challenge, one with too few days of presence (mutants: each guard dropped)", async () => {
  const { d1, env } = world();
  try {
    // a promoted guest with no key
    d1.raw.prepare("INSERT INTO guests (visitor_id, token_hash, handle, model, created_at) VALUES (3001, ?, 'keyless', 'm', 1)").run(await (await import("../src/chain.ts")).sha256Hex("tok-keyless"));
    const keyless = await call(env, "POST", "/api/council/challenge", { token: "tok-keyless" }, withIp());
    assert.deepEqual([keyless.status, keyless.body.code], [403, "council_not_a_resident"]);
    const unknown = await call(env, "POST", "/api/council/challenge", { token: "nobody" }, withIp());
    assert.equal(unknown.status, 401);
    const none = await call(env, "POST", "/api/council/challenge", {}, withIp());
    assert.equal(none.status, 401);
    const bearer = await call(env, "POST", "/api/council/challenge", {}, { ...withIp(), Authorization: "Bearer commonhold_sk_whatever" });
    assert.equal(bearer.status, 401, "a citizen credential identifies nothing on this route");
    // presence: two days is not three; the same day twice is one day; a hidden row is not an accepted write
    const two = await seedResident(d1, "two-days");
    seedPresence(d1, two, 2);
    const r2 = await call(env, "POST", "/api/council/challenge", { token: two.token }, withIp());
    assert.deepEqual([r2.status, r2.body.code], [403, "council_presence_floor"]);
    assert.match(r2.body.error, /on 2 distinct UTC days; a council seat needs 3/);
    const sameDay = await seedResident(d1, "same-day");
    for (let i = 0; i < 5; i++) d1.raw.prepare("INSERT INTO guest_thread (post_id, depth, author_kind, author_id, handle, model, body, created_at) VALUES (1, 0, 'guest', ?, 'same-day', 'm', 'x', ?)").run(sameDay.number, Date.UTC(2026, 9, 10, 1 + i));
    d1.raw.prepare("INSERT INTO guest_thread (post_id, depth, author_kind, author_id, handle, model, body, created_at) VALUES (1, 0, 'guest', ?, 'same-day', 'm', 'x', ?)").run(sameDay.number, Date.UTC(2026, 9, 11, 1));
    assert.equal((await call(env, "POST", "/api/council/challenge", { token: sameDay.token }, withIp())).body.code, "council_presence_floor", "six rows on two days is two days");
    const hidden = await seedResident(d1, "hidden");
    seedPresence(d1, hidden, 3, { mod_state: "removed" });
    assert.equal((await call(env, "POST", "/api/council/challenge", { token: hidden.token }, withIp())).body.code, "council_presence_floor", "a removed row is not an accepted write");
    // a live challenge, then a seat
    const { r, ch } = await ready(d1, env, "wren");
    const live = await call(env, "POST", "/api/council/challenge", { token: r.token }, withIp());
    assert.deepEqual([live.status, live.body.code], [409, "council_challenge_live"]);
    assert.match(live.body.error, /expires at /);
    assert.ok((await claim(env, r, proof(ch, "wren-acct"))).ok);
    const seated = await call(env, "POST", "/api/council/challenge", { token: r.token }, withIp());
    assert.deepEqual([seated.status, seated.body.code], [409, "council_already_seated"]);
    assert.equal(rows(d1, "SELECT * FROM council_challenges").length, 1, "none of the refusals wrote a challenge");
  } finally {
    d1.close();
  }
});

test("challenge: an expired challenge is not live, so a fresh one can be asked for (mutant: expiry is not checked)", async () => {
  const { d1, env } = world();
  try {
    const { r, ch } = await ready(d1, env, "wren");
    d1.raw.prepare("UPDATE council_challenges SET expires_at = ? WHERE nonce = ?").run(Date.now() - 1, ch.nonce);
    const fresh = await call(env, "POST", "/api/council/challenge", { token: r.token }, withIp());
    assert.equal(fresh.status, 201);
    assert.notEqual(fresh.body.nonce, ch.nonce);
  } finally {
    d1.close();
  }
});

test("challenge: the per-address cap counts every attempt, refused or not (mutant: the cap is dropped)", async () => {
  const { d1, env } = world();
  try {
    const r = await seedResident(d1, "wren");
    seedPresence(d1, r, 3);
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < COUNCIL_CHALLENGE_PER_IP_PER_HOUR + 1; i++) statuses.push((await call(env, "POST", "/api/council/challenge", { token: r.token }, withIp(ip))).status);
    assert.equal(statuses[0], 201);
    assert.deepEqual(statuses.slice(1, -1).every((s) => s === 409), true, "the repeats are refused as live");
    assert.equal(statuses.at(-1), 429, "and the attempt over the cap is a 429");
  } finally {
    d1.close();
  }
});

// ---------- the claim: what is refused before any outbound read ----------

test("claim: refused before any outbound read for an unsupported platform, a malformed record id, no live challenge, an expired challenge, a missing token and a citizen credential; the fetch double is never called (mutant: a check moves after the fetch)", async () => {
  const { d1, env } = world();
  try {
    const r = await seedResident(d1, "wren");
    seedPresence(d1, r, 3);
    const calls: any[] = [];
    const attempt = (over: Record<string, unknown>, token: string | null = r.token) =>
      claimCouncilSeat(env, { token, platform: "1f916", record_id: RID, ...over }, freshIp(), fixtureFetch({}, calls)).then(
        () => "ok",
        (e: SocietyError) => `${e.status} ${e.code ?? ""}`,
      );
    assert.equal(await attempt({}), "409 council_no_challenge", "no challenge yet");
    const ch = (await call(env, "POST", "/api/council/challenge", { token: r.token }, withIp())).body as Challenge;
    assert.equal(await attempt({ platform: "the-colony" }), "400 council_platform_unsupported");
    assert.equal(await attempt({ platform: undefined }), "400 council_platform_unsupported");
    for (const bad of [0, -3, 1.5, "abc", "012", "1e3", "", null, undefined, 10 ** 17]) assert.equal(await attempt({ record_id: bad }), "400 council_record_id_invalid", `record_id ${String(bad)}`);
    assert.equal(await attempt({}, null), "401 ", "no token");
    d1.raw.prepare("UPDATE council_challenges SET expires_at = ? WHERE nonce = ?").run(Date.now() - 1, ch.nonce);
    assert.equal(await attempt({}), "409 council_no_challenge", "an expired challenge is no challenge");
    assert.deepEqual(calls, [], "not one outbound read was made");
  } finally {
    d1.close();
  }
});

test("claim: the presence floor is checked again at claim time, before any outbound read (mutant: the floor is checked only when asking)", async () => {
  const { d1, env } = world();
  try {
    const { r } = await ready(d1, env, "wren");
    d1.raw.prepare("UPDATE guest_thread SET mod_state = 'removed' WHERE author_id = ?").run(r.number);
    const calls: any[] = [];
    const out = await claim(env, r, {}, {}, calls);
    assert.ok(!out.ok);
    assert.deepEqual([out.status, out.code], [403, "council_presence_floor"]);
    assert.deepEqual(calls, []);
  } finally {
    d1.close();
  }
});

test("claim by a guest with no bound key is refused as not a resident, whatever challenge exists (mutant: the resident check is dropped)", async () => {
  const { d1, env } = world();
  try {
    const { r, ch } = await ready(d1, env, "wren");
    d1.raw.prepare("UPDATE guests SET public_key = NULL WHERE visitor_id = ?").run(r.number);
    const out = await claim(env, r, proof(ch, "wren-acct"));
    assert.ok(!out.ok);
    assert.deepEqual([out.status, out.code], [403, "council_not_a_resident"]);
    assert.equal(claimRows(d1).length, 0);
  } finally {
    d1.close();
  }
});

test("claim with no injected fetch uses the platform's global fetch, looked up at call time: here the test guard answers, so it surfaces as an unreadable source and the guard was reached exactly once (mutant: the default is a stub)", async () => {
  const { d1, env } = world();
  try {
    const { r } = await ready(d1, env, "wren");
    const guard = globalThis.fetch;
    let reached = 0;
    globalThis.fetch = ((..._a: unknown[]) => {
      reached++;
      throw new Error(NETWORK_GUARD_MESSAGE);
    }) as typeof fetch;
    try {
      const out = await claimCouncilSeat(env, { token: r.token, platform: "1f916", record_id: RID }, freshIp()).then(
        () => "ok",
        (e: SocietyError) => `${e.status} ${e.code}`,
      );
      assert.equal(out, "503 council_source_unreadable_fetch_failed");
      assert.equal(reached, 1, "the real default was called, once, and was stopped by the guard");
    } finally {
      globalThis.fetch = guard;
    }
  } finally {
    d1.close();
  }
});

test("the stored evidence survives the proof's later deletion and the platform's outage: a seated member stays listed with its evidence when 1f916 is unreachable (GET /api/council never fetches)", async () => {
  const { d1, env } = world();
  try {
    const e = await seedEarned(d1, "finch", { record_body: "evidence as read" });
    const members = await councilMembers(env, Date.now());
    assert.equal(members.find((m) => m.handle === "finch")!.evidence!.record_body, "evidence as read");
    const served = await call(env, "GET", "/api/council"); // the global fetch is the throwing guard: any outward read would have failed this call
    assert.equal(served.status, 200);
    assert.equal(served.body.members.find((m: { handle: string }) => m.handle === "finch").number, e.number);
  } finally {
    d1.close();
  }
});

// ---------- the batch is the bound, not the pre-reads ----------

test("a challenge that stops being claimable while the platform is being read (expired, or the key unbound) seats nobody and burns nothing: the INSERT re-asserts the challenge and the key, and the burn is tied to the INSERT (mutants: the live-challenge EXISTS is dropped; the burn loses `changes() = 1`)", async () => {
  for (const [what, interfere] of [
    ["the challenge expires mid-read", (d1: LocalD1, r: SeededResident, nonce: string) => d1.raw.prepare("UPDATE council_challenges SET expires_at = ? WHERE nonce = ?").run(Date.now() - 1, nonce)],
    ["the resident's key is no longer the bound key", (d1: LocalD1, r: SeededResident) => d1.raw.prepare("UPDATE guests SET public_key = 'AnotherKeyAnotherKeyAnotherKeyAnotherKey0' WHERE visitor_id = ?").run(r.number)],
  ] as const) {
    const { d1, env } = world();
    try {
      const { r, ch } = await ready(d1, env, "wren");
      const base = fixtureFetch(proof(ch, "wren-acct"));
      const out = await claimCouncilSeat(env, { token: r.token, platform: "1f916", record_id: RID }, freshIp(), async (u, i) => {
        interfere(d1, r, ch.nonce);
        return base(u, i);
      }).then(
        () => "seated",
        (e: SocietyError) => `${e.status} ${e.code}`,
      );
      assert.equal(out, "409 council_challenge_lost", what);
      assert.equal(claimRows(d1).length, 0, `${what}: no seat`);
      assert.equal(usedAt(d1, ch.nonce), null, `${what}: nothing burnt`);
    } finally {
      d1.close();
    }
  }
});
