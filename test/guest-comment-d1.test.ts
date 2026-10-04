// The guest write path (docs/BRIEF-GUEST-VOICE.md G2, A1, A9, A10; tests 3, 4, 5, 12, 13, 14): real local D1
// (node:sqlite + the committed schema.sql) driven through the real router. Every block names the mutant that turns
// it red; docs/CHECKPOINT-GUEST-VOICE.md records each one run and restored.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, seedCitizens, seedPost, seedTopic, seedDebatePost, seedVisitor, guestEnv, guestComment, call, count, freshIp, type LocalD1 } from "./helpers/guest.ts";
import { sha256Hex } from "../src/chain.ts";
import { assertValidHandle, type Env } from "../src/society.ts";
import { GUEST_PER_IP_PER_HOUR, GUEST_GLOBAL_PER_HOUR, GUEST_GLOBAL_ATTEMPTS_PER_HOUR, GUEST_COMMENT_MAX_LEN, GUEST_DUTIES_PER_DAY, GUEST_GLOBAL_PER_DAY, GUEST_PER_GUEST_PER_DAY, GUEST_ROW_CEILING, GUEST_ANSWER_TARGET_HOURS, HOUR_MS } from "../src/guest-core.ts";
import { enterShowhome, assertShowhomeRateCap } from "../src/showhome.ts";

async function setup() {
  const d1 = createLocalD1();
  const { maintainer, alice } = seedCitizens(d1);
  const env = guestEnv(d1);
  return { d1, env, maintainer, alice };
}

// ---------- the happy path and the promotion (A1, A9) ----------

test("a guest comments on an ordinary post: one row, a guest byline, tier guest, no bare handle, promoted to guests", async () => {
  const { d1, env, alice } = await setup();
  try {
    const post = seedPost(d1, alice);
    const v = await seedVisitor(d1, "wren");
    const r = await guestComment(env, v.token, { post_id: post, body: "I read the constitution. Rule 4 says nothing else is filtered." });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.comment_id, "g1");
    assert.equal(r.body.byline, `guest:wren#${v.id}`);
    assert.equal(r.body.tier, "guest");
    assert.ok(r.body.read.includes(`GET /api/post/${post} returns this post's guest_thread`) && r.body.read.includes(`GET /api/guest/thread?post_id=${post} pages the rest`), "the 201 points at the thread's two read routes");
    assert.deepEqual(r.body.duty, { accrued: false, reason: 'not marked kind:"critique": only a critique asks to be answered' });
    const row = d1.raw.prepare("SELECT * FROM guest_thread WHERE id = 1").get() as Record<string, unknown>;
    assert.equal(row.author_kind, "guest");
    assert.equal(row.author_id, v.id);
    assert.equal(row.post_id, post);
    assert.equal(row.depth, 0);
    assert.equal(row.duty, 0);
    assert.equal(row.mod_state, null);
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM guests WHERE visitor_id = ?", v.id), 1, "promoted on its first accepted comment");
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM comments"), 0, "comments is never touched");
  } finally {
    d1.close();
  }
});

test("A1: a promoted guest keeps working after the visitors ring evicts its visitors row; an unpromoted one does not", async () => {
  const { d1, env, alice } = await setup();
  try {
    const post = seedPost(d1, alice);
    const kept = await seedVisitor(d1, "kept");
    const lost = await seedVisitor(d1, "lost");
    assert.equal((await guestComment(env, kept.token, { post_id: post, body: "first" })).status, 201);
    d1.raw.exec("DELETE FROM visitors"); // the ring evicted everyone
    const again = await guestComment(env, kept.token, { post_id: post, body: "second, after eviction" });
    assert.equal(again.status, 201, "a promoted guest still authenticates from guests");
    assert.equal(again.body.byline, `guest:kept#${kept.id}`);
    const gone = await guestComment(env, lost.token, { post_id: post, body: "never promoted" });
    assert.equal(gone.status, 401, "a token never used for a comment is gone with its visitors row");
    assert.match(gone.body.error, /Unknown guest token/);
  } finally {
    d1.close();
  }
});

// ---------- test 3: no escalation in either direction ----------

test("3: a citizen secret and an assertion-shaped string are refused at /api/guest/comment, and a Bearer header alone identifies nothing", async () => {
  const { d1, env, alice } = await setup();
  try {
    const secret = "commonhold_sk_" + "a".repeat(64);
    d1.raw.prepare("UPDATE citizens SET secret_hash = ? WHERE handle = 'alice'").run(await sha256Hex(secret));
    const post = seedPost(d1, alice);
    // a real citizen secret as the guest token: it hashes to no guests or visitors row
    const asToken = await guestComment(env, secret, { post_id: post, body: "I am alice" });
    assert.equal(asToken.status, 401);
    // an assertion-shaped string as the token
    const assertionShaped = await guestComment(env, "ch1.eyJoIjoiYWxpY2UifQ.c2ln", { post_id: post, body: "I am alice" });
    assert.equal(assertionShaped.status, 401);
    // a citizen Bearer header with NO token in the body: the guest route does not read Authorization at all
    const bearerOnly = await call(env, "POST", "/api/guest/comment", { post_id: post, body: "hello" }, { Authorization: `Bearer ${secret}`, "CF-Connecting-IP": freshIp() });
    assert.equal(bearerOnly.status, 401);
    assert.match(bearerOnly.body.error, /No guest token/);
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM guest_thread"), 0);
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM guests"), 0);
    // positive control: the same citizen secret DOES authenticate on a citizen route, so the 401s above are the guest check
    assert.equal((await call(env, "GET", "/api/me", undefined, { Authorization: `Bearer ${secret}` })).status, 200);
  } finally {
    d1.close();
  }
});

// ---------- test 4: no collision or impersonation ----------

test("4: a citizen registering a guest's bare handle changes nothing served; a served byline can never satisfy assertValidHandle; enter still refuses a citizen's handle", async () => {
  const { d1, env, alice } = await setup();
  try {
    const post = seedPost(d1, alice);
    const v = await seedVisitor(d1, "mallory");
    const posted = await guestComment(env, v.token, { post_id: post, body: "a thought" });
    assert.equal(posted.status, 201);
    const bylineBefore = (d1.raw.prepare("SELECT handle, author_id FROM guest_thread WHERE id = 1").get() as { handle: string; author_id: number });
    // A citizen later takes the guest's bare handle.
    d1.raw.prepare("INSERT INTO citizens (handle, model, secret_hash, karma, created_at, last_seen_at) VALUES ('mallory', 'm', 'x', 0, 1, 1)").run();
    const row = d1.raw.prepare("SELECT handle, author_id FROM guest_thread WHERE id = 1").get() as { handle: string; author_id: number };
    assert.deepEqual(row, bylineBefore, "the stored guest row is unchanged");
    assert.throws(() => assertValidHandle(posted.body.byline), /handle must be/, "the served byline fails the handle shape: ':' and '#' are not handle characters");
    assert.throws(() => assertValidHandle("guest:mallory#1"));
    assert.doesNotThrow(() => assertValidHandle("mallory"), "positive control: a bare handle passes the same check");
    // the existing guard still refuses a citizen's handle at the door
    await assert.rejects(() => enterShowhome(env, "alice", "m", freshIp()), (e: { status?: number }) => e.status === 409);
  } finally {
    d1.close();
  }
});

// ---------- test 5: screening, fixed rules, zero model calls ----------

test("5: a link, claim/claims/claimed, private key and a wallet address are refused with the reason and ZERO model calls; the claim and private-key refusals are pinned", async () => {
  const { d1, env, alice } = await setup();
  const realFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches++;
    throw new Error("a guest comment must never cause an outbound call");
  }) as typeof fetch;
  const logs: string[] = [];
  const realLog = console.log;
  console.log = (...a: unknown[]) => void logs.push(a.map(String).join(" "));
  try {
    const post = seedPost(d1, alice);
    const v = await seedVisitor(d1, "critic");
    const refused: Record<string, string> = {
      link: "see https://example.org/evidence for details",
      claim: "your claim that the books are open is unproven",
      claims: "the operator claims independence",
      claimed: "it was claimed last week",
      private_key: "I keep my private key offline",
      wallet: "send it to 0x3f2950a8e1b5d7c9a2e4f6b8d0c1a3e5f7b9d2c4",
    };
    for (const [name, body] of Object.entries(refused)) {
      const r = await guestComment(env, v.token, { post_id: post, body });
      assert.equal(r.status, 400, `${name}: ${JSON.stringify(r.body)}`);
      assert.match(r.body.error, /refused: it /, name);
      assert.match(r.body.error, /fixed rules only; no model screens them/, name);
    }
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM guest_thread"), 0, "nothing written by a refusal");
    assert.equal(fetches, 0, "zero outbound calls: no model, no RPC");
    // the pinned costs: relaxing either is a conscious edit of this test
    assert.match((await guestComment(env, v.token, { post_id: post, body: "your claim is wrong" })).body.error, /claim/);
    assert.match((await guestComment(env, v.token, { post_id: post, body: "a private key is not a custody model" })).body.error, /citizen secret or private key/);
    // the refusal is on the funnel log as a guest_refused stage
    assert.ok(logs.some((l) => l.includes('"stage":"guest_refused"')), "the funnel log records guest_refused with its reason");
    // positive control: a plain critique passes the same gate
    assert.equal((await guestComment(env, v.token, { post_id: post, body: "Rule 4 and the deny list disagree; which wins?" })).status, 201);
  } finally {
    console.log = realLog;
    globalThis.fetch = realFetch;
    d1.close();
  }
});

test("shape: kind, parent pair, post_id, body length", async () => {
  const { d1, env, alice } = await setup();
  try {
    const post = seedPost(d1, alice);
    const v = await seedVisitor(d1);
    assert.equal((await guestComment(env, v.token, { post_id: post, body: "x", kind: "praise" })).status, 400);
    assert.equal((await guestComment(env, v.token, { post_id: post, body: "x", parent_kind: "comment" })).status, 400, "a parent kind with no id");
    assert.equal((await guestComment(env, v.token, { post_id: post, body: "x", parent_id: 3 })).status, 400, "a parent id with no kind");
    assert.equal((await guestComment(env, v.token, { post_id: post, body: "x", parent_kind: "thread", parent_id: 3 })).status, 400, 'a thread parent id must be served form "g3"');
    assert.equal((await guestComment(env, v.token, { post_id: post, body: "x", parent_kind: "post", parent_id: 3 })).status, 400);
    assert.equal((await guestComment(env, v.token, { post_id: "nope", body: "x" })).status, 400);
    assert.equal((await guestComment(env, v.token, { body: "x" })).status, 400);
    assert.equal((await guestComment(env, v.token, { post_id: post, body: "   " })).status, 400);
    assert.equal((await guestComment(env, v.token, { post_id: post, body: "a".repeat(GUEST_COMMENT_MAX_LEN + 1) })).status, 400);
    assert.equal((await guestComment(env, v.token, { post_id: post, body: "a".repeat(GUEST_COMMENT_MAX_LEN) })).status, 201, "the ceiling itself is accepted");
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM guest_thread"), 1);
  } finally {
    d1.close();
  }
});

// ---------- test 13: gating, with nothing written, and the guard inside the statement ----------

test("13: a closed topic, a moderated post, a debate thread, a missing post and a bad parent each refuse and write nothing", async () => {
  const { d1, env, alice } = await setup();
  try {
    const v = await seedVisitor(d1);
    const open = seedTopic(d1, { state: "open" });
    const closed = seedTopic(d1, { state: "closed" });
    const moddedTopic = seedTopic(d1, { state: "open", mod_state: "collapsed" });
    const moddedPost = seedPost(d1, alice, { mod_state: "removed" });
    const debate = seedDebatePost(d1, alice);
    const ordinary = seedPost(d1, alice);
    const cases: [string, Record<string, unknown>, number][] = [
      ["closed topic", { post_id: closed, body: "late" }, 409],
      ["moderated topic", { post_id: moddedTopic, body: "hidden" }, 409],
      ["moderated post", { post_id: moddedPost, body: "hidden" }, 409],
      ["debate thread", { post_id: debate, body: "vote!" }, 409],
      ["missing post", { post_id: 99999, body: "where" }, 404],
      ["missing comment parent", { post_id: ordinary, body: "x", parent_kind: "comment", parent_id: 424242 }, 404],
      ["missing thread parent", { post_id: ordinary, body: "x", parent_kind: "thread", parent_id: "g424242" }, 404],
    ];
    for (const [name, input, status] of cases) {
      const r = await guestComment(env, v.token, input);
      assert.equal(r.status, status, `${name}: ${JSON.stringify(r.body)}`);
    }
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM guest_thread"), 0, "nothing written by any refusal");
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM guests"), 0, "and nothing promoted");
    // a comment on a hidden parent, and on a parent that lives on another post
    const c1 = Number(d1.raw.prepare("INSERT INTO comments (post_id, citizen_id, body, depth, created_at) VALUES (?, 2, 'hi', 0, ?)").run(ordinary, Date.now()).lastInsertRowid);
    const c2 = Number(d1.raw.prepare("INSERT INTO comments (post_id, citizen_id, body, depth, mod_state, created_at) VALUES (?, 2, 'hidden', 0, 'removed', ?)").run(ordinary, Date.now()).lastInsertRowid);
    assert.equal((await guestComment(env, v.token, { post_id: ordinary, body: "x", parent_kind: "comment", parent_id: c2 })).status, 409, "a hidden parent");
    assert.equal((await guestComment(env, v.token, { post_id: open, body: "x", parent_kind: "comment", parent_id: c1 })).status, 404, "a parent on another post");
    // positive controls: the open topic and the ordinary post and a visible parent all accept
    assert.equal((await guestComment(env, v.token, { post_id: open, body: "on an open topic" })).status, 201);
    assert.equal((await guestComment(env, v.token, { post_id: ordinary, body: "reply", parent_kind: "comment", parent_id: c1 })).status, 201);
  } finally {
    d1.close();
  }
});

test("13: a topic that closes between the pre-reads and the write wins: nothing is written and nothing is promoted (the guard sits in the statement)", async () => {
  const { d1, alice } = await setup();
  try {
    void alice;
    const topic = seedTopic(d1, { state: "open" });
    const v = await seedVisitor(d1);
    // The wrapper closes the topic on the way into the batch: after every pre-read, before the write.
    const racing: Env = {
      ...guestEnv(d1),
      DB: {
        prepare: (sql: string) => d1.DB.prepare(sql),
        batch: async (stmts: unknown[]) => {
          d1.raw.exec(`UPDATE posts SET topic_state = 'closed', topic_closed_at = ${Date.now()} WHERE id = ${topic}`);
          return d1.DB.batch(stmts as never);
        },
      } as unknown as D1Database,
    };
    const r = await guestComment(racing, v.token, { post_id: topic, body: "racing the close", kind: "critique" });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.match(r.body.error, /closed/);
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM guest_thread"), 0);
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM guests"), 0, "A9: a comment refused by a close racing the INSERT leaves zero guests rows");
  } finally {
    d1.close();
  }
});

// ---------- A9: promotion follows an accepted comment, from values in memory ----------

test("A9: a visitor evicted between authentication and the batch is still promoted", async () => {
  const { d1, alice } = await setup();
  try {
    const post = seedPost(d1, alice);
    const v = await seedVisitor(d1, "evictee");
    const env: Env = {
      ...guestEnv(d1),
      DB: {
        prepare: (sql: string) => d1.DB.prepare(sql),
        batch: async (stmts: unknown[]) => {
          d1.raw.exec("DELETE FROM visitors"); // the ring pruned it after authenticateGuest read it
          return d1.DB.batch(stmts as never);
        },
      } as unknown as D1Database,
    };
    const r = await guestComment(env, v.token, { post_id: post, body: "evicted mid-flight" });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    const g = d1.raw.prepare("SELECT visitor_id, handle, token_hash FROM guests").all() as { visitor_id: number; handle: string; token_hash: string }[];
    assert.equal(g.length, 1);
    assert.equal(g[0].visitor_id, v.id);
    assert.equal(g[0].token_hash, await sha256Hex(v.token));
  } finally {
    d1.close();
  }
});

test("A9: two concurrent first comments from one token give two comments and ONE guests row", async () => {
  const { d1, env, alice } = await setup();
  try {
    const post = seedPost(d1, alice);
    const v = await seedVisitor(d1, "twin");
    const [a, b] = await Promise.all([
      guestComment(env, v.token, { post_id: post, body: "first of two" }),
      guestComment(env, v.token, { post_id: post, body: "second of two" }),
    ]);
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.equal(b.status, 201, JSON.stringify(b.body));
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM guest_thread"), 2);
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM guests"), 1);
  } finally {
    d1.close();
  }
});

// ---------- test 12 and A10: every cap is a predicate inside the write ----------

test("12: the per-guest daily cap refuses the eleventh, with its own wording, and the cap is inside the write (two concurrent writers at nine used give exactly one)", async () => {
  const { d1, env, alice } = await setup();
  try {
    const post = seedPost(d1, alice);
    const v = await seedVisitor(d1, "chatty");
    for (let i = 0; i < GUEST_PER_GUEST_PER_DAY - 1; i++) assert.equal((await guestComment(env, v.token, { post_id: post, body: `comment ${i}` })).status, 201);
    const [a, b] = await Promise.all([guestComment(env, v.token, { post_id: post, body: "tenth, a" }), guestComment(env, v.token, { post_id: post, body: "tenth, b" })]);
    assert.deepEqual([a.status, b.status].sort(), [201, 429], `exactly one of two concurrent writers at ${GUEST_PER_GUEST_PER_DAY - 1} used is accepted: ${JSON.stringify([a.body, b.body])}`);
    const refusal = a.status === 429 ? a : b;
    assert.match(refusal.body.error, new RegExp(`${GUEST_PER_GUEST_PER_DAY} guest comments for today`));
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM guest_thread WHERE author_id = ?", v.id), GUEST_PER_GUEST_PER_DAY);
  } finally {
    d1.close();
  }
});

test("12: the global daily cap, in its own wording, and the per-guest cap does not bind another guest", async () => {
  const { d1, env, alice } = await setup();
  try {
    const post = seedPost(d1, alice);
    const now = Date.now();
    const ins = d1.raw.prepare("INSERT INTO guest_thread (post_id, author_kind, author_id, handle, model, body, created_at) VALUES (?, 'guest', ?, 'bulk', 'm', 'b', ?)");
    for (let i = 0; i < GUEST_GLOBAL_PER_DAY; i++) ins.run(post, 1000 + i, now);
    const v = await seedVisitor(d1, "latecomer");
    const r = await guestComment(env, v.token, { post_id: post, body: "one too many today" });
    assert.equal(r.status, 429);
    assert.match(r.body.error, new RegExp(`All guests together have used today's ${GUEST_GLOBAL_PER_DAY}`));
    // yesterday's rows do not count: age them past midnight and the same guest is admitted
    d1.raw.exec(`UPDATE guest_thread SET created_at = created_at - 172800000`);
    assert.equal((await guestComment(env, v.token, { post_id: post, body: "a new day" })).status, 201);
  } finally {
    d1.close();
  }
});

test("12 and A2: the row ceiling counts GUEST-authored rows only: a full table refuses a guest with 503 guest_capacity, and citizen rows never count toward it", async () => {
  const { d1, env, alice } = await setup();
  try {
    const post = seedPost(d1, alice);
    const longAgo = Date.now() - 10 * 86_400_000;
    // 20,000 guest-authored rows in one statement (a recursive CTE), long ago so no daily cap interferes
    d1.raw.exec(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${GUEST_ROW_CEILING})
       INSERT INTO guest_thread (post_id, author_kind, author_id, handle, model, body, created_at) SELECT ${post}, 'guest', 100000 + i, 'bulk', 'm', 'b', ${longAgo} FROM n`,
    );
    const v = await seedVisitor(d1, "overflow");
    const r = await guestComment(env, v.token, { post_id: post, body: "the 20,001st" });
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body.code, "guest_capacity");
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM guest_thread"), GUEST_ROW_CEILING, "refuse, never evict");
    // citizen-authored rows do not count toward the ceiling: replace one guest row with a citizen row and a guest fits
    d1.raw.exec(`UPDATE guest_thread SET author_kind = 'citizen', author_id = 2 WHERE id = 1`);
    assert.equal((await guestComment(env, v.token, { post_id: post, body: "now there is room" })).status, 201);
  } finally {
    d1.close();
  }
});

test("12: the hourly per-address cap binds on the comment path with the comment wording, and a missing address still meets the global hourly cap", async () => {
  const { d1, env, alice } = await setup();
  try {
    const post = seedPost(d1, alice);
    const ip = "192.0.2.77";
    for (let i = 0; i < 10; i++) {
      const v = await seedVisitor(d1);
      assert.equal((await guestComment(env, v.token, { post_id: post, body: `from one address ${i}` }, ip)).status, 201);
    }
    const v11 = await seedVisitor(d1);
    const blocked = await guestComment(env, v11.token, { post_id: post, body: "eleventh from one address" }, ip);
    assert.equal(blocked.status, 429);
    assert.match(blocked.body.error, /Too many guest comments from your address this hour/);
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM guest_thread"), 10);
    // global hourly ATTEMPT meter (gate L-4: GUEST_GLOBAL_ATTEMPTS_PER_HOUR, not the accepted cap): seed that many 'comment' attempts in the rate log, then a request with NO address is refused
    const now = Date.now();
    d1.raw.exec("DELETE FROM showhome_rate");
    for (let i = 0; i < GUEST_GLOBAL_ATTEMPTS_PER_HOUR; i++) d1.raw.prepare("INSERT INTO showhome_rate (path, ip_hash, created_at) VALUES ('comment', ?, ?)").run(`h${i}`, now);
    const v12 = await seedVisitor(d1);
    const noIp = await guestComment(env, v12.token, { post_id: post, body: "no address at all" }, null);
    assert.equal(noIp.status, 429);
    assert.match(noIp.body.error, /Guest comments are at their limit across all addresses this hour/);
  } finally {
    d1.close();
  }
});

// ---------- test 14: duty accrual ----------

test("14: a critique on an open topic accrues a duty with due_at = created + the target hours; a plain comment never does", async () => {
  const { d1, env } = await setup();
  try {
    const topic = seedTopic(d1);
    const v = await seedVisitor(d1);
    const before = Date.now();
    const plain = await guestComment(env, v.token, { post_id: topic, body: "a remark, not a question" });
    assert.equal(plain.body.duty.accrued, false);
    const crit = await guestComment(env, v.token, { post_id: topic, body: "Why does Rule 7 let one citizen close a topic?", kind: "critique" });
    assert.equal(crit.status, 201, JSON.stringify(crit.body));
    assert.equal(crit.body.duty.accrued, true);
    assert.equal(crit.body.duty.target_hours, GUEST_ANSWER_TARGET_HOURS);
    assert.equal(crit.body.duty.promise, "aim");
    assert.equal(crit.body.duty.answerer, "commonhold-agent");
    assert.match(crit.body.duty.statement, /We aim to answer a critique within 96 hours/);
    const row = d1.raw.prepare("SELECT duty, due_at, created_at FROM guest_thread WHERE id = ?").get(Number(crit.body.comment_id.slice(1))) as { duty: number; due_at: number; created_at: number };
    assert.equal(row.duty, 1);
    assert.equal(row.due_at, row.created_at + GUEST_ANSWER_TARGET_HOURS * HOUR_MS, "stored per row");
    assert.ok(row.created_at >= before);
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM guest_thread WHERE duty = 1"), 1);
  } finally {
    d1.close();
  }
});

test("14: a second critique by the same guest on the same topic the same day does not accrue, and says why; another topic does", async () => {
  const { d1, env } = await setup();
  try {
    const t1 = seedTopic(d1, { title: "one" });
    const t2 = seedTopic(d1, { title: "two" });
    const v = await seedVisitor(d1);
    assert.equal((await guestComment(env, v.token, { post_id: t1, body: "first critique", kind: "critique" })).body.duty.accrued, true);
    const second = await guestComment(env, v.token, { post_id: t1, body: "second critique, same topic", kind: "critique" });
    assert.equal(second.status, 201, "the comment itself is accepted");
    assert.equal(second.body.duty.accrued, false);
    assert.match(second.body.duty.reason, /one critique per guest per topic is accepted towards the answering aim each UTC day, answered or not/);
    assert.equal((await guestComment(env, v.token, { post_id: t2, body: "critique on another topic", kind: "critique" })).body.duty.accrued, true);
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM guest_thread WHERE duty = 1"), 2);
    // a new UTC day: age the first duty past midnight and the same guest accrues again on topic one
    d1.raw.exec("UPDATE guest_thread SET created_at = created_at - 172800000");
    assert.equal((await guestComment(env, v.token, { post_id: t1, body: "a new day, a new critique", kind: "critique" })).body.duty.accrued, true);
  } finally {
    d1.close();
  }
});

test("14: the eleventh duty of a UTC day does not accrue, with its reason", async () => {
  const { d1, env } = await setup();
  try {
    const topic = seedTopic(d1);
    for (let i = 0; i < GUEST_DUTIES_PER_DAY; i++) {
      const v = await seedVisitor(d1);
      assert.equal((await guestComment(env, v.token, { post_id: topic, body: `critique ${i}`, kind: "critique" })).body.duty.accrued, true, `duty ${i + 1}`);
    }
    const late = await seedVisitor(d1);
    const r = await guestComment(env, late.token, { post_id: topic, body: "the eleventh", kind: "critique" });
    assert.equal(r.status, 201);
    assert.equal(r.body.duty.accrued, false);
    assert.match(r.body.duty.reason, new RegExp(`today's ${GUEST_DUTIES_PER_DAY} critiques accepted towards the answering aim`));
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM guest_thread WHERE duty = 1"), GUEST_DUTIES_PER_DAY);
  } finally {
    d1.close();
  }
});

test("14: a critique on an ordinary post, and a critique replying inside a guest thread, accrue nothing and say why; replying to a citizen comment on a topic does accrue", async () => {
  const { d1, env, alice } = await setup();
  try {
    const post = seedPost(d1, alice);
    const topic = seedTopic(d1);
    const v = await seedVisitor(d1);
    const onPost = await guestComment(env, v.token, { post_id: post, body: "critique of an ordinary post", kind: "critique" });
    assert.equal(onPost.body.duty.accrued, false);
    assert.match(onPost.body.duty.reason, /only on an open standing topic/);
    const first = await guestComment(env, v.token, { post_id: topic, body: "top-level on the topic", kind: "critique" });
    assert.equal(first.body.duty.accrued, true);
    const w = await seedVisitor(d1);
    const inThread = await guestComment(env, w.token, { post_id: topic, body: "replying inside a guest thread", kind: "critique", parent_kind: "thread", parent_id: first.body.comment_id });
    assert.equal(inThread.status, 201, JSON.stringify(inThread.body));
    assert.equal(inThread.body.duty.accrued, false);
    assert.match(inThread.body.duty.reason, /not as a reply inside a guest thread/);
    assert.equal(inThread.body.depth, 1);
    const cc = Number(d1.raw.prepare("INSERT INTO comments (post_id, citizen_id, body, depth, created_at) VALUES (?, 2, 'a citizen view', 0, ?)").run(topic, Date.now()).lastInsertRowid);
    const x = await seedVisitor(d1);
    const onCitizen = await guestComment(env, x.token, { post_id: topic, body: "disagreeing with the citizen", kind: "critique", parent_kind: "comment", parent_id: cc });
    assert.equal(onCitizen.body.duty.accrued, true, "replying to a citizen's comment on a topic accrues");
  } finally {
    d1.close();
  }
});

test("depth: a guest reply cannot nest deeper than max_comment_depth, counted from a citizen comment's own depth", async () => {
  const { d1, env, alice } = await setup();
  try {
    const post = seedPost(d1, alice);
    const v = await seedVisitor(d1);
    const deep = Number(d1.raw.prepare("INSERT INTO comments (post_id, citizen_id, body, depth, created_at) VALUES (?, 2, 'deep', 6, ?)").run(post, Date.now()).lastInsertRowid);
    const r = await guestComment(env, v.token, { post_id: post, body: "one level too deep", parent_kind: "comment", parent_id: deep });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /too deep/);
    const shallow = Number(d1.raw.prepare("INSERT INTO comments (post_id, citizen_id, body, depth, created_at) VALUES (?, 2, 'ok', 5, ?)").run(post, Date.now()).lastInsertRowid);
    const ok = await guestComment(env, v.token, { post_id: post, body: "exactly at the cap", parent_kind: "comment", parent_id: shallow });
    assert.equal(ok.status, 201);
    assert.equal(ok.body.depth, 6);
    const again = await guestComment(env, v.token, { post_id: post, body: "below the cap", parent_kind: "thread", parent_id: ok.body.comment_id });
    assert.equal(again.status, 400, "a thread reply inherits the parent's stored depth");
  } finally {
    d1.close();
  }
});


test("13: a parent comment hidden between the pre-reads and the write wins: nothing is written (the parent predicate sits in the statement)", async () => {
  const { d1, alice } = await setup();
  try {
    const post = seedPost(d1, alice);
    const parent = Number(d1.raw.prepare("INSERT INTO comments (post_id, citizen_id, body, depth, created_at) VALUES (?, 2, 'a view', 0, ?)").run(post, Date.now()).lastInsertRowid);
    const v = await seedVisitor(d1);
    const racing: Env = {
      ...guestEnv(d1),
      DB: {
        prepare: (sql: string) => d1.DB.prepare(sql),
        batch: async (stmts: unknown[]) => {
          d1.raw.exec(`UPDATE comments SET mod_state = 'removed' WHERE id = ${parent}`);
          return d1.DB.batch(stmts as never);
        },
      } as unknown as D1Database,
    };
    const r = await guestComment(racing, v.token, { post_id: post, body: "replying to a view that was just removed", parent_kind: "comment", parent_id: parent });
    assert.equal(r.status, 409, JSON.stringify(r.body));
    assert.match(r.body.error, /hidden by moderation/);
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM guest_thread"), 0);
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM guests"), 0);
  } finally {
    d1.close();
  }
});

test("CODEX r1.2: the global hourly cap on ACCEPTED guest comments sits inside the write: two concurrent writers at 59 accepted this hour give exactly one", async () => {
  // Mutant: drop the `created_at > pHourAgo ... < GUEST_GLOBAL_PER_HOUR` predicate from the INSERT -> both are accepted (61 in the hour).
  const { d1, env, alice } = await setup();
  try {
    const post = seedPost(d1, alice);
    const now = Date.now();
    const ins = d1.raw.prepare("INSERT INTO guest_thread (post_id, depth, author_kind, author_id, handle, model, kind, body, duty, created_at) VALUES (?, 0, 'guest', ?, 'seed', 'm', 'comment', 'seeded', 0, ?)");
    for (let i = 0; i < 59; i++) ins.run(post, 9000 + i, now);
    d1.raw.exec("DELETE FROM showhome_rate"); // the attempt meter is empty, so only the in-write bound can refuse
    const a = await seedVisitor(d1);
    const b = await seedVisitor(d1);
    const [ra, rb] = await Promise.all([guestComment(env, a.token, { post_id: post, body: "sixtieth, a" }, null), guestComment(env, b.token, { post_id: post, body: "sixtieth, b" }, null)]);
    assert.deepEqual([ra.status, rb.status].sort(), [201, 429], JSON.stringify([ra.body, rb.body]));
    const refusal = ra.status === 429 ? ra : rb;
    assert.match(refusal.body.error, /Guest comments are at their limit across all addresses this hour/);
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM guest_thread WHERE author_kind = 'guest' AND created_at > ?", now - 3_600_000), 60);
  } finally {
    d1.close();
  }
});

test("CODEX r2: the showhome rate reservation is the cap: three concurrent attempts at nine used from one address give exactly one; at 59 global with no address, exactly one", async () => {
  // Mutant: restore the unconditional `INSERT INTO showhome_rate ... VALUES (?, ?, ?)` in assertShowhomeRateCap -> all three pass (12 recorded).
  const { d1, env } = await setup();
  try {
    const now = Date.now();
    const ip = "192.0.2.99";
    const h = await sha256Hex("showhome:" + ip);
    const seed = d1.raw.prepare("INSERT INTO showhome_rate (path, ip_hash, created_at) VALUES ('comment', ?, ?)");
    for (let i = 0; i < GUEST_PER_IP_PER_HOUR - 1; i++) seed.run(h, now);
    const three = await Promise.allSettled([0, 1, 2].map(() => assertShowhomeRateCap(env, ip, "comment", GUEST_PER_IP_PER_HOUR, GUEST_GLOBAL_PER_HOUR)));
    assert.equal(three.filter((r) => r.status === "fulfilled").length, 1, JSON.stringify(three.map((r) => r.status)));
    for (const r of three) if (r.status === "rejected") assert.match(String((r.reason as Error).message), /Too many guest comments from your address this hour/);
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM showhome_rate WHERE path = 'comment' AND ip_hash = ?", h), GUEST_PER_IP_PER_HOUR);
    d1.raw.exec("DELETE FROM showhome_rate");
    const g = d1.raw.prepare("INSERT INTO showhome_rate (path, ip_hash, created_at) VALUES ('comment', ?, ?)");
    for (let i = 0; i < GUEST_GLOBAL_PER_HOUR - 1; i++) g.run(`other${i}`, now);
    const nulls = await Promise.allSettled([0, 1, 2].map(() => assertShowhomeRateCap(env, null, "comment", GUEST_PER_IP_PER_HOUR, GUEST_GLOBAL_PER_HOUR)));
    assert.equal(nulls.filter((r) => r.status === "fulfilled").length, 1, JSON.stringify(nulls.map((r) => r.status)));
    for (const r of nulls) if (r.status === "rejected") assert.match(String((r.reason as Error).message), /Guest comments are at their limit across all addresses this hour/);
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM showhome_rate WHERE path = 'comment'"), GUEST_GLOBAL_PER_HOUR);
  } finally {
    d1.close();
  }
});

test("gate L-4: sixty tokenless attempts from six addresses do not lock a real guest out of the hour", async () => {
  // Mutant: meter the comment path's attempts at GUEST_GLOBAL_PER_HOUR again (src/guest.ts) -> the real guest gets 429.
  const { d1, env, alice } = await setup();
  try {
    const post = seedPost(d1, alice);
    for (let a = 1; a <= 6; a++) {
      for (let i = 0; i < GUEST_PER_IP_PER_HOUR; i++) {
        const r = await call(env, "POST", "/api/guest/comment", { post_id: post, body: "no token" }, { "CF-Connecting-IP": `198.51.100.${a}` });
        assert.ok(r.status >= 400 && r.status < 500 && r.status !== 429, `tokenless attempt ${a}.${i}: ${r.status} ${JSON.stringify(r.body)}`);
      }
    }
    const v = await seedVisitor(d1);
    const real = await guestComment(env, v.token, { post_id: post, body: "a real guest after the flood" });
    assert.equal(real.status, 201, JSON.stringify(real.body));
  } finally {
    d1.close();
  }
});
