// The citizen's side of the guest voice (docs/BRIEF-GUEST-VOICE.md G2's answer route, A2, A10, A12, A13; tests 15, 22,
// 23 and the idempotency tests): real local D1, the real router, nothing mocked. Every block names the mutant that
// turns it red; docs/CHECKPOINT-GUEST-VOICE.md records each one run and restored.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, seedCitizens, seedPost, seedTopic, seedVisitor, guestEnv, guestComment, call, count, type LocalD1, type Reply } from "./helpers/guest.ts";
import { sha256Hex } from "../src/chain.ts";
import { createComment, me, MAINTAINER_ID, type Env } from "../src/society.ts";
import { dutyRowsSql, GUEST_ROW_CEILING, GUEST_DUTY_MIN_ANSWER_LEN } from "../src/guest-core.ts";
import { postGuestAnswer } from "../src/guest.ts";

const LONG = "I read this critique twice. The rule it cites does apply, and here is why: the cap is enforced in the write, not in the handler. " + "x".repeat(10);

async function setup() {
  const d1 = createLocalD1();
  seedCitizens(d1); // 1 = commonhold-agent, 2 = alice (no secrets)
  // give the maintainer and alice real credentials
  const maintainerSecret = "commonhold_sk_maintainer_" + "a".repeat(40);
  const aliceSecret = "commonhold_sk_alice_" + "b".repeat(40);
  d1.raw.prepare("UPDATE citizens SET secret_hash = ? WHERE id = 1").run(await sha256Hex(maintainerSecret));
  d1.raw.prepare("UPDATE citizens SET secret_hash = ? WHERE id = 2").run(await sha256Hex(aliceSecret));
  return { d1, env: guestEnv(d1), maintainerSecret, aliceSecret };
}

function answer(env: Env, secret: string | null, input: Record<string, unknown>): Promise<Reply> {
  return call(env, "POST", "/api/guest/answer", input, secret ? { Authorization: `Bearer ${secret}` } : {});
}

// The answer route WITHOUT the HTTP layer. The HTTP path hashes the credential with crypto.subtle (a real event-loop
// turn), so two requests started together do not reach their database statements in lockstep; a direct call has only
// resolved-promise awaits, so two started together DO both run their pre-checks before either writes. The race tests
// call this so the overlap they claim is the overlap that happens.
const ALICE = { id: 2, handle: "alice", model: "test-model" };
const MAINTAINER = { id: 1, handle: "commonhold-agent", model: "claude-fable-5" };
const direct = (env: Env, who: { id: number; handle: string; model: string }, input: Record<string, unknown>) => postGuestAnswer(env, who, input);

// Seeds a topic and a duty-bearing critique on it; returns the guest row id as served.
async function critique(d1: LocalD1, env: Env, over: Partial<{ topic: number; handle: string; body: string }> = {}): Promise<{ id: string; num: number; topic: number; token: string; visitor: number }> {
  const topic = over.topic ?? seedTopic(d1);
  const v = await seedVisitor(d1, over.handle);
  const r = await guestComment(env, v.token, { post_id: topic, body: over.body ?? "Why can the operator close a topic by opening another one?", kind: "critique" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.duty.accrued, true);
  return { id: r.body.comment_id, num: Number(r.body.comment_id.slice(1)), topic, token: v.token, visitor: v.id };
}

function status(d1: LocalD1, num: number, now = Date.now()): string | null {
  const row = d1.raw.prepare(dutyRowsSql(now, "g.id = ?1")).get(num) as { duty_status: string | null };
  return row.duty_status;
}

// ---------- the route's own credentials ----------

test("3: a visitor token and no credential are refused 401 at /api/guest/answer; a citizen credential is accepted there", async () => {
  const { d1, env, aliceSecret } = await setup();
  try {
    const c = await critique(d1, env);
    assert.equal((await answer(env, c.token, { guest_comment_id: c.id, body: LONG })).status, 401, "a visitor/guest token is not a citizen credential");
    assert.equal((await answer(env, null, { guest_comment_id: c.id, body: LONG })).status, 401);
    assert.equal((await call(env, "POST", "/api/guest/answer", { token: c.token, guest_comment_id: c.id, body: LONG })).status, 401, "a token in the body is not read as a credential");
    const ok = await answer(env, aliceSecret, { guest_comment_id: c.id, body: LONG });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM guest_thread WHERE author_kind = 'citizen'"), 1);
  } finally {
    d1.close();
  }
});

// ---------- test 15: discharge ----------

test("15: only citizen #1, with at least 80 characters, unmoderated, discharges; another citizen's answer is recorded but does not", async () => {
  const { d1, env, maintainerSecret, aliceSecret } = await setup();
  try {
    const c = await critique(d1, env);
    assert.equal(status(d1, c.num), "open");
    const byAlice = await answer(env, aliceSecret, { guest_comment_id: c.id, body: LONG });
    assert.equal(byAlice.status, 201);
    assert.equal(byAlice.body.discharges_duty, false);
    assert.match(byAlice.body.note, /Only commonhold-agent .* gives the answer a critique awaits/);
    assert.equal(status(d1, c.num), "open", "another citizen's answer does not discharge");
    const short = await answer(env, maintainerSecret, { guest_comment_id: c.id, body: "x".repeat(GUEST_DUTY_MIN_ANSWER_LEN - 1) });
    assert.equal(short.status, 201);
    assert.equal(short.body.discharges_duty, false);
    assert.match(short.body.note, /shorter than 80 characters/);
    assert.equal(status(d1, c.num), "open", "an answer under 80 characters does not discharge");
    const exactly = await answer(env, maintainerSecret, { guest_comment_id: c.id, body: "y".repeat(GUEST_DUTY_MIN_ANSWER_LEN) });
    assert.equal(exactly.status, 201);
    assert.equal(exactly.body.discharges_duty, true);
    assert.equal(exactly.body.duty, "answered");
    assert.equal(status(d1, c.num), "answered");
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM guest_thread WHERE parent_kind = 'thread' AND parent_id = ?", c.num), 3, "every answer is recorded");
  } finally {
    d1.close();
  }
});

test("15: a moderated answer does not discharge (the duty reads open again); and 'No, because ...' discharges as readily as 'Yes'", async () => {
  const { d1, env, maintainerSecret } = await setup();
  try {
    const c = await critique(d1, env);
    const r = await answer(env, maintainerSecret, { guest_comment_id: c.id, body: "No, because the cap is a statement predicate and the handler's count is only a message: " + "z".repeat(20) });
    assert.equal(r.body.duty, "answered");
    const answerId = Number(r.body.comment_id.slice(1));
    d1.raw.prepare("UPDATE guest_thread SET mod_state = 'removed' WHERE id = ?").run(answerId);
    assert.equal(status(d1, c.num), "open", "hiding the answer revives the duty");
    d1.raw.prepare("UPDATE guest_thread SET mod_state = NULL WHERE id = ?").run(answerId);
    assert.equal(status(d1, c.num), "answered");
  } finally {
    d1.close();
  }
});

test("15: an answer is accepted on a closed topic (the duty must stay dischargeable), and refused on a removed guest comment", async () => {
  const { d1, env, maintainerSecret } = await setup();
  try {
    const c = await critique(d1, env);
    d1.raw.prepare("UPDATE posts SET topic_state = 'closed', topic_closed_at = ? WHERE id = ?").run(Date.now(), c.topic);
    const r = await answer(env, maintainerSecret, { guest_comment_id: c.id, body: LONG });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(status(d1, c.num), "answered");
    const gone = await critique(d1, env);
    d1.raw.prepare("UPDATE guest_thread SET mod_state = 'removed' WHERE id = ?").run(gone.num);
    const refused = await answer(env, maintainerSecret, { guest_comment_id: gone.id, body: LONG });
    assert.equal(refused.status, 409);
    assert.match(refused.body.error, /removed by moderation/);
    // a collapsed one can still be answered
    const collapsed = await critique(d1, env);
    d1.raw.prepare("UPDATE guest_thread SET mod_state = 'collapsed' WHERE id = ?").run(collapsed.num);
    assert.equal((await answer(env, maintainerSecret, { guest_comment_id: collapsed.id, body: LONG })).status, 201);
  } finally {
    d1.close();
  }
});

test("15: answered_late when the first discharge came after due_at, against an injected clock; overdue and waived read from the same SQL", async () => {
  const { d1, env, maintainerSecret } = await setup();
  try {
    const c = await critique(d1, env);
    const row = d1.raw.prepare("SELECT due_at FROM guest_thread WHERE id = ?").get(c.num) as { due_at: number };
    assert.equal(status(d1, c.num, row.due_at - 1), "open");
    assert.equal(status(d1, c.num, row.due_at + 1), "overdue", "overdue is simply past due_at with no discharge");
    d1.raw.prepare("UPDATE guest_thread SET mod_state = 'collapsed' WHERE id = ?").run(c.num);
    assert.equal(status(d1, c.num, row.due_at + 1), "waived", "hidden and unanswered reads waived");
    d1.raw.prepare("UPDATE guest_thread SET mod_state = NULL WHERE id = ?").run(c.num);
    // the answer lands; then move the due date before it: the same row now reads answered_late
    await answer(env, maintainerSecret, { guest_comment_id: c.id, body: LONG });
    assert.equal(status(d1, c.num), "answered");
    d1.raw.prepare("UPDATE guest_thread SET due_at = created_at - 1 WHERE id = ?").run(c.num);
    assert.equal(status(d1, c.num), "answered_late");
    // a row with no duty has no status
    const plain = await guestComment(env, (await seedVisitor(d1)).token, { post_id: c.topic, body: "just a remark" });
    assert.equal(status(d1, Number(plain.body.comment_id.slice(1))), null);
  } finally {
    d1.close();
  }
});

test("the answer route's own refusals: a malformed id, a missing row, a citizen's answer as the target, an empty body, a too-long body", async () => {
  const { d1, env, maintainerSecret } = await setup();
  try {
    const c = await critique(d1, env);
    for (const bad of ["17", "G17", "g0", "g-1", "g1.5", 17, null, undefined]) {
      const r = await answer(env, maintainerSecret, { guest_comment_id: bad, body: LONG });
      assert.equal(r.status, 400, `guest_comment_id ${JSON.stringify(bad)}`);
    }
    assert.equal((await answer(env, maintainerSecret, { guest_comment_id: "g9999", body: LONG })).status, 404);
    const first = await answer(env, maintainerSecret, { guest_comment_id: c.id, body: LONG });
    assert.equal((await answer(env, maintainerSecret, { guest_comment_id: first.body.comment_id, body: LONG })).status, 400, "answers go to guest comments, not to answers");
    assert.equal((await answer(env, maintainerSecret, { guest_comment_id: c.id, body: "   " })).status, 400);
    assert.equal((await answer(env, maintainerSecret, { guest_comment_id: c.id, body: "a".repeat(8001) })).status, 400);
    assert.equal((await answer(env, maintainerSecret, { guest_comment_id: c.id, body: LONG, idempotency_key: "has space" })).status, 400);
    assert.equal((await answer(env, maintainerSecret, { guest_comment_id: c.id, body: LONG, idempotency_key: "k".repeat(65) })).status, 400);
  } finally {
    d1.close();
  }
});

// ---------- test 22 and A10: one shared cap, inside both writes ----------

function addComments(d1: LocalD1, citizenId: number, postId: number, n: number): void {
  const ins = d1.raw.prepare("INSERT INTO comments (post_id, citizen_id, body, depth, created_at) VALUES (?, ?, 'c', 0, ?)");
  for (let i = 0; i < n; i++) ins.run(postId, citizenId, Date.now());
}
function addAnswers(d1: LocalD1, citizenId: number, targetNum: number, postId: number, n: number): void {
  const ins = d1.raw.prepare("INSERT INTO guest_thread (post_id, parent_kind, parent_id, depth, author_kind, author_id, handle, model, kind, body, created_at) VALUES (?, 'thread', ?, 1, 'citizen', ?, 'alice', 'm', 'comment', 'a', ?)");
  for (let i = 0; i < n; i++) ins.run(postId, targetNum, citizenId, Date.now());
}

test("22: a citizen's comments and guest answers together stop at 20 a day, in both directions; comments_remaining agrees", async () => {
  const { d1, env, aliceSecret } = await setup();
  try {
    const c = await critique(d1, env);
    const post = seedPost(d1, 2);
    const alice = { id: 2, handle: "alice", model: "test-model", karma: 0, created_at: 0, last_seen_at: 0 };
    // 12 comments + 8 answers = 20 used
    addComments(d1, 2, post, 12);
    addAnswers(d1, 2, c.num, c.topic, 8);
    assert.equal((await me(env, alice)).today.comments_remaining, 0, "me() counts both tables");
    await assert.rejects(() => createComment(env, alice, post, null, "the twenty-first"), (e: { status?: number }) => e.status === 429);
    const refused = await answer(env, aliceSecret, { guest_comment_id: c.id, body: LONG });
    assert.equal(refused.status, 429);
    assert.match(refused.body.error, /Daily comments spent/);
    // the other direction: 19 comments, one answer fits, then a comment does not
    d1.raw.exec("DELETE FROM comments; DELETE FROM guest_thread WHERE author_kind = 'citizen';");
    addComments(d1, 2, post, 19);
    assert.equal((await me(env, alice)).today.comments_remaining, 1);
    assert.equal((await answer(env, aliceSecret, { guest_comment_id: c.id, body: LONG })).status, 201);
    await assert.rejects(() => createComment(env, alice, post, null, "now there is no room"), (e: { status?: number }) => e.status === 429);
    assert.equal((await me(env, alice)).today.comments_remaining, 0);
  } finally {
    d1.close();
  }
});

test("22: the maintainer stays exempt in both directions", async () => {
  const { d1, env, maintainerSecret } = await setup();
  try {
    const c = await critique(d1, env);
    const post = seedPost(d1, 2);
    const maintainer = { id: MAINTAINER_ID, handle: "commonhold-agent", model: "claude-fable-5", karma: 0, created_at: 0, last_seen_at: 0 };
    addComments(d1, MAINTAINER_ID, post, 25);
    addAnswers(d1, MAINTAINER_ID, c.num, c.topic, 5);
    assert.ok((await createComment(env, maintainer, post, null, "the maintainer is exempt from the daily cap")).comment_id);
    const r = await answer(env, maintainerSecret, { guest_comment_id: c.id, body: LONG });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  } finally {
    d1.close();
  }
});

test("A10: two writes racing at 19 used give exactly one: a comment and an answer, two comments, two answers", async () => {
  const { d1, env } = await setup();
  try {
    const c = await critique(d1, env);
    const post = seedPost(d1, 2);
    const alice = { id: 2, handle: "alice", model: "test-model", karma: 0, created_at: 0, last_seen_at: 0 };
    const reset = () => {
      d1.raw.exec("DELETE FROM comments; DELETE FROM guest_thread WHERE author_kind = 'citizen';");
      addComments(d1, 2, post, 19);
    };
    const settled = (rs: PromiseSettledResult<unknown>[]) => rs.filter((r) => r.status === "fulfilled").length;
    reset();
    const ca = await Promise.allSettled([createComment(env, alice, post, null, "racing comment"), direct(env, ALICE, { guest_comment_id: c.id, body: LONG })]);
    assert.equal(settled(ca), 1, "a comment and an answer");
    reset();
    const cc = await Promise.allSettled([createComment(env, alice, post, null, "racing comment one"), createComment(env, alice, post, null, "racing comment two")]);
    assert.equal(settled(cc), 1, "two comments");
    reset();
    const aa = await Promise.allSettled([direct(env, ALICE, { guest_comment_id: c.id, body: LONG + "1" }), direct(env, ALICE, { guest_comment_id: c.id, body: LONG + "2" })]);
    assert.equal(settled(aa), 1, "two answers");
    assert.equal(count(d1, "SELECT (SELECT COUNT(*) FROM comments WHERE citizen_id = 2) + (SELECT COUNT(*) FROM guest_thread WHERE author_kind = 'citizen' AND author_id = 2) AS n"), 20);
    // The MIXED state: 10 comments + 9 answers = 19 used. A predicate that counted only one table would let both
    // racers through here (it would see 10 or 9), where the all-comments states above cannot tell the difference.
    for (const [first, second] of [["comment", "answer"], ["answer", "comment"], ["comment", "comment"], ["answer", "answer"]] as const) {
      d1.raw.exec("DELETE FROM comments; DELETE FROM guest_thread WHERE author_kind = 'citizen';");
      addComments(d1, 2, post, 10);
      addAnswers(d1, 2, c.num, c.topic, 9);
      const run = (kind: string, n: number) =>
        kind === "comment"
          ? createComment(env, alice, post, null, `mixed racing comment ${n}`)
          : direct(env, ALICE, { guest_comment_id: c.id, body: LONG + n });
      const rs = await Promise.allSettled([run(first, 1), run(second, 2)]);
      assert.equal(settled(rs), 1, `mixed 10+9 used, racing ${first} and ${second}: exactly one`);
    }
  } finally {
    d1.close();
  }
});

// ---------- A12 and A13: duplicate sends are stopped by the server ----------

test("A12: overlapping sends with one key give one row; a lost response retried returns the existing row with idempotent_replay", async () => {
  const { d1, env, maintainerSecret } = await setup();
  try {
    const c = await critique(d1, env);
    const key = `duty:${c.id}:v1`;
    // two overlapping runs, both past the key lookup before either writes (direct calls: see the helper's comment)
    const [a, b] = await Promise.all([
      direct(env, MAINTAINER, { guest_comment_id: c.id, body: LONG, idempotency_key: key }),
      direct(env, MAINTAINER, { guest_comment_id: c.id, body: LONG, idempotency_key: key }),
    ]);
    assert.deepEqual([a.replay, b.replay].sort(), [false, true], `one created, one replayed: ${JSON.stringify([a.body, b.body])}`);
    const replay = a.replay ? a : b;
    assert.equal(replay.body.idempotent_replay, true);
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM guest_thread WHERE author_kind = 'citizen' AND idem_key = ?", key), 1, "one row");
    // a lost response, retried later: the same row, no second write
    const retry = await answer(env, maintainerSecret, { guest_comment_id: c.id, body: LONG, idempotency_key: key });
    assert.equal(retry.status, 200);
    assert.equal(retry.body.idempotent_replay, true);
    assert.equal(retry.body.comment_id, (a.replay ? b : a).body.comment_id);
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM guest_thread WHERE author_kind = 'citizen'"), 1);
  } finally {
    d1.close();
  }
});

test("A12: a moderated answer leaves the duty open and the next key (v2) is accepted; the replay does not hide a non-discharging answer", async () => {
  const { d1, env, maintainerSecret } = await setup();
  try {
    const c = await critique(d1, env);
    const first = await answer(env, maintainerSecret, { guest_comment_id: c.id, body: LONG, idempotency_key: `duty:${c.id}:v1` });
    assert.equal(first.status, 201);
    d1.raw.prepare("UPDATE guest_thread SET mod_state = 'removed' WHERE id = ?").run(Number(first.body.comment_id.slice(1)));
    assert.equal(status(d1, c.num), "open", "the moderated answer no longer discharges");
    // the same key + same body is still a replay of the (now hidden) row: that is the contract, and why the key is derived from live state
    const sameKey = await answer(env, maintainerSecret, { guest_comment_id: c.id, body: LONG, idempotency_key: `duty:${c.id}:v1` });
    assert.equal(sameKey.status, 200);
    assert.equal(status(d1, c.num), "open");
    const next = await answer(env, maintainerSecret, { guest_comment_id: c.id, body: LONG + " (a fresh answer)", idempotency_key: `duty:${c.id}:v2` });
    assert.equal(next.status, 201, JSON.stringify(next.body));
    assert.equal(status(d1, c.num), "answered");
  } finally {
    d1.close();
  }
});

test("A13: a replay binds its target and its body: the same key for another guest comment, or another body, is 409 idempotency_key_reused and writes nothing", async () => {
  const { d1, env, maintainerSecret, aliceSecret } = await setup();
  try {
    const g17 = await critique(d1, env);
    const g18 = await critique(d1, env);
    const first = await answer(env, maintainerSecret, { guest_comment_id: g17.id, body: LONG, idempotency_key: "K" });
    assert.equal(first.status, 201);
    const otherTarget = await answer(env, maintainerSecret, { guest_comment_id: g18.id, body: LONG, idempotency_key: "K" });
    assert.equal(otherTarget.status, 409, JSON.stringify(otherTarget.body));
    assert.equal(otherTarget.body.code, "idempotency_key_reused");
    assert.equal(status(d1, g18.num), "open", "g18 is still unanswered");
    const otherBody = await answer(env, maintainerSecret, { guest_comment_id: g17.id, body: LONG + " different", idempotency_key: "K" });
    assert.equal(otherBody.status, 409);
    assert.equal(otherBody.body.code, "idempotency_key_reused");
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM guest_thread WHERE author_kind = 'citizen'"), 1, "nothing written by either refusal");
    // keys are scoped to their author: another citizen may use the same key string
    assert.equal((await answer(env, aliceSecret, { guest_comment_id: g18.id, body: LONG, idempotency_key: "K" })).status, 201);
  } finally {
    d1.close();
  }
});

// ---------- test 23 (A2): capacity can never defeat a duty ----------

test("23: a critique accepted as the 20,000th guest row is discharged by citizen #1; the next guest row 503s; a citizen answer after that still succeeds", async () => {
  const { d1, env, maintainerSecret } = await setup();
  try {
    const topic = seedTopic(d1);
    const longAgo = Date.now() - 10 * 86_400_000;
    d1.raw.exec(
      `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${GUEST_ROW_CEILING - 1})
       INSERT INTO guest_thread (post_id, author_kind, author_id, handle, model, body, created_at) SELECT ${topic}, 'guest', 100000 + i, 'bulk', 'm', 'b', ${longAgo} FROM n`,
    );
    const v = await seedVisitor(d1, "the20000th");
    const last = await guestComment(env, v.token, { post_id: topic, body: "The last row the record will take.", kind: "critique" });
    assert.equal(last.status, 201, JSON.stringify(last.body));
    assert.equal(last.body.duty.accrued, true);
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM guest_thread WHERE author_kind = 'guest'"), GUEST_ROW_CEILING);
    const w = await seedVisitor(d1, "the20001st");
    const refused = await guestComment(env, w.token, { post_id: topic, body: "one more" });
    assert.equal(refused.status, 503);
    assert.equal(refused.body.code, "guest_capacity");
    const discharge = await answer(env, maintainerSecret, { guest_comment_id: last.body.comment_id, body: LONG });
    assert.equal(discharge.status, 201, "citizen rows are never refused by the guest ceiling");
    assert.equal(discharge.body.discharges_duty, true);
    assert.equal(status(d1, Number(last.body.comment_id.slice(1))), "answered");
    assert.equal((await answer(env, maintainerSecret, { guest_comment_id: last.body.comment_id, body: LONG + " and a second thought" })).status, 201, "a citizen answer after the ceiling still succeeds");
  } finally {
    d1.close();
  }
});


// ---------- CODEX build r1.1: a duty is accrued only where its answer can sit directly below it ----------

test("CODEX r1.1: a critique admitted at the deepest level accrues no duty and says why; one level higher accrues and is answered directly below it", async () => {
  // Mutant: drop `${pDepth} + 1 <= GUEST_MAX_DEPTH` from the INSERT's duty CASE -> the depth-6 critique accrues a duty no answer can discharge.
  const { d1, env, maintainerSecret } = await setup();
  try {
    const topic = seedTopic(d1);
    const now = Date.now();
    const c5 = Number(d1.raw.prepare("INSERT INTO comments (post_id, citizen_id, body, depth, created_at) VALUES (?, 2, 'five deep', 5, ?)").run(topic, now).lastInsertRowid);
    const c4 = Number(d1.raw.prepare("INSERT INTO comments (post_id, citizen_id, body, depth, created_at) VALUES (?, 2, 'four deep', 4, ?)").run(topic, now).lastInsertRowid);
    const deep = await seedVisitor(d1);
    const r6 = await guestComment(env, deep.token, { post_id: topic, body: "a critique at the deepest level", kind: "critique", parent_kind: "comment", parent_id: c5 });
    assert.equal(r6.status, 201, JSON.stringify(r6.body));
    assert.equal(r6.body.depth, 6);
    assert.equal(r6.body.duty.accrued, false, "no duty where no answer can sit below it");
    assert.match(r6.body.duty.reason, /deepest level a thread allows/);
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM guest_thread WHERE id = ? AND duty = 1", Number(r6.body.comment_id.slice(1))), 0);
    const high = await seedVisitor(d1);
    const r5 = await guestComment(env, high.token, { post_id: topic, body: "a critique one level higher", kind: "critique", parent_kind: "comment", parent_id: c4 });
    assert.equal(r5.status, 201, JSON.stringify(r5.body));
    assert.equal(r5.body.depth, 5);
    assert.equal(r5.body.duty.accrued, true);
    const a = await answer(env, maintainerSecret, { guest_comment_id: r5.body.comment_id, body: LONG });
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.equal(status(d1, Number(r5.body.comment_id.slice(1))), "answered", "the duty at depth 5 is discharged by an answer at depth 6");
  } finally {
    d1.close();
  }
});

// ---------- gate L-1 pins (M3, M4) and L-6 ----------

test("gate L-1 M4: a GUEST whose visitor number is 1 replying 80+ characters under a critique never discharges it (the discharge needs author_kind citizen)", async () => {
  // Mutant M4: drop `a.author_kind = 'citizen'` from FIRST_DISCHARGE_SQL -> the guest's reply discharges and the status reads answered.
  const { d1, env } = await setup();
  try {
    const one = await seedVisitor(d1, "visitor-one");
    assert.equal(one.id, 1, "the first visitor in a fresh database is number 1, the answerer's citizen id");
    const c = await critique(d1, env);
    const r = await guestComment(env, one.token, { post_id: c.topic, body: LONG, parent_kind: "thread", parent_id: c.id });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(status(d1, c.num), "open");
  } finally {
    d1.close();
  }
});

test("gate L-1 M3: a duty answered in time and moderated afterwards stays answered, never waived", async () => {
  // Mutant M3: evaluate `mod_state IS NOT NULL -> waived` before the discharge -> the status reads waived.
  const { d1, env, maintainerSecret } = await setup();
  try {
    const c = await critique(d1, env);
    assert.equal((await answer(env, maintainerSecret, { guest_comment_id: c.id, body: LONG })).status, 201);
    d1.raw.prepare("UPDATE guest_thread SET mod_state = 'collapsed' WHERE id = ?").run(c.num);
    assert.equal(status(d1, c.num), "answered");
  } finally {
    d1.close();
  }
});

test("gate L-6: discharges_duty is true only on the answer that discharged the duty, never on a later one", async () => {
  // Mutant: restore `body.length >= MIN && discharged` -> the second answer also reads true.
  const { d1, env, maintainerSecret } = await setup();
  try {
    const c = await critique(d1, env);
    const first = await answer(env, maintainerSecret, { guest_comment_id: c.id, body: LONG });
    assert.equal(first.status, 201);
    assert.equal(first.body.discharges_duty, true);
    const second = await answer(env, maintainerSecret, { guest_comment_id: c.id, body: LONG + " A further note." });
    assert.equal(second.status, 201, JSON.stringify(second.body));
    assert.equal(second.body.discharges_duty, false, "an earlier answer discharged it");
    assert.equal(second.body.duty, "answered");
  } finally {
    d1.close();
  }
});

test("gate L-6 (CODEX gate-fixes r1 LOW): with ids out of timestamp order, discharges_duty names the answer FIRST_DISCHARGE_SQL dates the discharge by", async () => {
  // Two concurrent answers can commit with ids out of timestamp order. Simulated: a qualifying answer with the LOWER id
  // but a LATER created_at already sits on the row; the route's answer has the higher id and the earlier time, so it is
  // the discharge (MIN(created_at)). Mutant: restore SELECT MIN(a.id) -> the route's answer reads false.
  const { d1, env, maintainerSecret } = await setup();
  try {
    const c = await critique(d1, env);
    d1.raw
      .prepare("INSERT INTO guest_thread (post_id, parent_kind, parent_id, depth, author_kind, author_id, handle, model, kind, body, created_at) VALUES (?, 'thread', ?, 1, 'citizen', 1, 'commonhold-agent', 'm', 'comment', ?, ?)")
      .run(c.topic, c.num, LONG, Date.now() + 3_600_000);
    const res = await answer(env, maintainerSecret, { guest_comment_id: c.id, body: LONG + " Earlier by the clock." });
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.duty, "answered");
    assert.equal(res.body.discharges_duty, true, "the earliest answer by created_at discharged the duty, whatever its id");
  } finally {
    d1.close();
  }
});
