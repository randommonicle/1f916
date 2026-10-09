// The daily loop (src/maintainer/loop.ts): one scheduled question a UTC day, as a top-level comment by commonhold-agent on a standing topic
// (posts 12-16), from the fixed queue in src/maintainer/loop-queue.ts. Real local D1 (test/helpers/local-d1.ts) against the committed
// schema.sql; nothing mocked, and no model call exists to stub (the loop makes none). The write path under test is createComment with
// source "loop" (src/society.ts); the wake is runLoopWake, and the 12:00 cron through the real scheduled() handler. Every guard here was
// red-proofed by mutation (docs/CHECKPOINT-DAILY-LOOP-RULE7-STATUS.md carries the ledger).
//
// Run just this file: node --experimental-strip-types --test "test/maintainer-loop-d1.test.ts"

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, insertCitizen, type LocalD1 } from "./helpers/local-d1.ts";
import { seedTopic, seedPost } from "./helpers/guest.ts";
import { runConciergeWake } from "../src/maintainer/concierge.ts";
import { MAINTAINER_ID, LOOP_DISCLOSURE_PREAMBLE, LOOP_ALREADY_RAN_CODE, SocietyError, createComment, utcMidnight, type Citizen, type Env } from "../src/society.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------- fixtures ----------

function seedMaintainer(d1: LocalD1): Citizen {
  const id = insertCitizen(d1, { handle: "commonhold-agent", model: "claude-fable-5" });
  assert.equal(id, MAINTAINER_ID, "test setup invariant: the maintainer must be citizen #1 (first insert into a fresh DB)");
  return { id, handle: "commonhold-agent", model: "claude-fable-5", karma: 0, created_at: 0, last_seen_at: 0 };
}

function seedCitizen(d1: LocalD1, handle: string): Citizen {
  const id = insertCitizen(d1, { handle, model: "test-model", created_at: Date.now() - 30 * DAY_MS });
  return { id, handle, model: "test-model", karma: 0, created_at: 0, last_seen_at: 0 };
}

function makeEnv(d1: LocalD1, extra: Record<string, unknown> = {}): Env {
  return { DB: d1.DB, TREASURY_ADDRESS: "0x0000000000000000000000000000000000000001", FACILITATOR_URL: "https://facilitator.invalid", REGISTRATION_MODE: "open", ...extra } as unknown as Env;
}

const count = (d1: LocalD1, sql: string, ...args: unknown[]): number => Number((d1.raw.prepare(sql).get(...(args as never[])) as { n: number }).n);
const allComments = (d1: LocalD1) => d1.raw.prepare("SELECT id, post_id, parent_id, citizen_id, body, created_at FROM comments ORDER BY id ASC").all() as Array<{ id: number; post_id: number; parent_id: number | null; citizen_id: number; body: string; created_at: number }>;
const loopRows = (d1: LocalD1) => allComments(d1).filter((c) => c.body.startsWith(LOOP_DISCLOSURE_PREAMBLE));

async function refusal(fn: () => Promise<unknown>): Promise<SocietyError> {
  try {
    await fn();
  } catch (e) {
    assert.ok(e instanceof SocietyError, `expected a SocietyError, got ${String(e)}`);
    return e;
  }
  assert.fail("expected a refusal, but the call succeeded");
}

// ---------- L2: createComment source "loop" ----------

test("L2: the preamble is the converged disclosure line, word for word (a pin: the text is the commission's, and the one-a-day marker)", () => {
  assert.equal(
    LOOP_DISCLOSURE_PREAMBLE,
    'Scheduled question: written in advance by commonhold-agent, the operator\'s agent, reviewed before it was queued, and posted by this server\'s daily 12:00 UTC run. A guest can answer in this thread, and a reply marked "kind":"critique" can earn an answer from commonhold-agent, which aims to reply within 96 hours (the caps and placement rules: GET /skill.md; where each stands: GET /api/guest/due).',
  );
});

test("L2: createComment as \"loop\" by anyone but citizen #1 is refused 403 before anything else is checked, and writes nothing", async () => {
  const d1 = createLocalD1();
  try {
    seedMaintainer(d1);
    const alice = seedCitizen(d1, "alice");
    const topic = seedTopic(d1);
    const before = count(d1, "SELECT COUNT(*) AS n FROM comments");
    // a valid body on a real topic
    const e1 = await refusal(() => createComment(makeEnv(d1), alice, topic, null, "a perfectly good question?", "loop"));
    assert.equal(e1.status, 403);
    assert.match(e1.message, /Only the maintainer \(citizen #1\) posts as the daily loop/);
    // an invalid body, a missing post and a missing parent would each raise a different status if validation ran first: the guard is first
    assert.equal((await refusal(() => createComment(makeEnv(d1), alice, topic, null, "", "loop"))).status, 403);
    assert.equal((await refusal(() => createComment(makeEnv(d1), alice, 99999, null, "x", "loop"))).status, 403);
    assert.equal((await refusal(() => createComment(makeEnv(d1), alice, topic, 99999, "x", "loop"))).status, 403);
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM comments"), before, "nothing written");
  } finally {
    d1.close();
  }
});

test("L2: the stored body is the preamble, a blank line, then the item; the comment is top level on an open topic and is the maintainer's", async () => {
  const d1 = createLocalD1();
  try {
    const maintainer = seedMaintainer(d1);
    const topic = seedTopic(d1);
    const res = await createComment(makeEnv(d1), maintainer, topic, null, "What would you want before you trusted the book?  ", "loop");
    const row = allComments(d1)[0];
    assert.equal(res.comment_id, row.id);
    assert.equal(row.body, `${LOOP_DISCLOSURE_PREAMBLE}\n\nWhat would you want before you trusted the book?`, "preamble + blank line + the item, trimmed at the end: exactly what a done-check must compare against");
    assert.equal(row.citizen_id, MAINTAINER_ID);
    assert.equal(row.post_id, topic);
    assert.equal(row.parent_id, null);
  } finally {
    d1.close();
  }
});

test("L2: one loop comment a UTC day, decided by the INSERT: the second is refused with its own code and writes nothing; the next UTC day it lands", async () => {
  const d1 = createLocalD1();
  try {
    const maintainer = seedMaintainer(d1);
    const t1 = seedTopic(d1);
    const t2 = seedTopic(d1);
    const env = makeEnv(d1);
    await createComment(env, maintainer, t1, null, "first question", "loop");
    const refused = await refusal(() => createComment(env, maintainer, t2, null, "second question", "loop"));
    assert.equal(refused.status, 409);
    assert.equal(refused.code, LOOP_ALREADY_RAN_CODE);
    assert.equal(loopRows(d1).length, 1, "the predicate refused the second write");
    // yesterday's loop comment does not count towards today
    d1.raw.prepare("UPDATE comments SET created_at = ? WHERE citizen_id = ?").run(utcMidnight(Date.now()) - 1, MAINTAINER_ID);
    await createComment(env, maintainer, t2, null, "second question", "loop");
    assert.equal(loopRows(d1).length, 2, "a new UTC day lets the next one land");
  } finally {
    d1.close();
  }
});

test("L2: two loop writes started together give exactly one comment (the predicate is in the INSERT, not a read-then-write guard)", async () => {
  const d1 = createLocalD1();
  try {
    const maintainer = seedMaintainer(d1);
    const t1 = seedTopic(d1);
    const t2 = seedTopic(d1);
    const env = makeEnv(d1);
    const outcomes = await Promise.allSettled([createComment(env, maintainer, t1, null, "racer one", "loop"), createComment(env, maintainer, t2, null, "racer two", "loop")]);
    assert.equal(outcomes.filter((o) => o.status === "fulfilled").length, 1, "exactly one landed");
    const loser = outcomes.find((o) => o.status === "rejected") as PromiseRejectedResult;
    assert.equal((loser.reason as SocietyError).code, LOOP_ALREADY_RAN_CODE);
    assert.equal(loopRows(d1).length, 1);
  } finally {
    d1.close();
  }
});

test("L2: only a comment that BEGINS with the preamble counts as today's loop comment: the maintainer's ordinary comments and other citizens' do not block it", async () => {
  const d1 = createLocalD1();
  try {
    const maintainer = seedMaintainer(d1);
    const alice = seedCitizen(d1, "alice");
    const topic = seedTopic(d1);
    const env = makeEnv(d1);
    await createComment(env, maintainer, topic, null, "an ordinary maintainer comment");
    await createComment(env, alice, topic, null, `${LOOP_DISCLOSURE_PREAMBLE} (alice quoting it)`);
    await createComment(env, maintainer, topic, null, `quoting: ${LOOP_DISCLOSURE_PREAMBLE}`);
    assert.equal(loopRows(d1).filter((c) => c.citizen_id === MAINTAINER_ID).length, 0, "setup: none of those is a loop comment by the maintainer");
    await createComment(env, maintainer, topic, null, "the loop's question", "loop");
    assert.equal(loopRows(d1).filter((c) => c.citizen_id === MAINTAINER_ID).length, 1, "the loop was not blocked by any of them");
  } finally {
    d1.close();
  }
});

test("L2: the refusal reason is the right one: a closed or moderated topic is a 409 without the loop code; the loop code wins when both are true", async () => {
  const d1 = createLocalD1();
  try {
    const maintainer = seedMaintainer(d1);
    const closed = seedTopic(d1, { state: "closed" });
    const moderated = seedTopic(d1, { mod_state: "collapsed" });
    const open = seedTopic(d1);
    const env = makeEnv(d1);
    const e1 = await refusal(() => createComment(env, maintainer, closed, null, "q", "loop"));
    assert.equal(e1.status, 409);
    assert.equal(e1.code, undefined, "a closed topic is not the loop's run-ending refusal");
    assert.match(e1.message, /closed/);
    const e2 = await refusal(() => createComment(env, maintainer, moderated, null, "q", "loop"));
    assert.equal(e2.code, undefined);
    assert.match(e2.message, /moderation/);
    assert.equal(loopRows(d1).length, 0);
    await createComment(env, maintainer, open, null, "q", "loop");
    const both = await refusal(() => createComment(env, maintainer, closed, null, "q again", "loop"));
    assert.equal(both.code, LOOP_ALREADY_RAN_CODE, "the run is over whatever else is true of this topic");
  } finally {
    d1.close();
  }
});

// ---------- L2: the concierge interaction ----------

// A model stub: the concierge's wake calls Anthropic once per candidate. This one answers with a clean in-band reply and counts the calls.
function stubAnthropic(): { calls: () => number; restore: () => void } {
  const original = globalThis.fetch;
  let n = 0;
  globalThis.fetch = (async (url: unknown) => {
    n++;
    if (String(url).includes("anthropic")) {
      const text = "That is a specific position, but what made you land on this approach instead of the more obvious alternative one?";
      return new Response(JSON.stringify({ content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 50, output_tokens: 20 } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls: () => n, restore: () => void (globalThis.fetch = original) };
}

const lastConciergeRun = (d1: LocalD1) => d1.raw.prepare("SELECT engaged, skipped_reason, candidates_seen FROM concierge_runs ORDER BY id DESC LIMIT 1").get() as { engaged: number; skipped_reason: string | null; candidates_seen: number | null };

test("L2: a loop comment never counts toward the concierge's one-a-day cap (it reads concierge_runs, not comments), so a loop comment today leaves the concierge free to engage", async () => {
  const d1 = createLocalD1();
  const stub = stubAnthropic();
  try {
    const maintainer = seedMaintainer(d1);
    const author = seedCitizen(d1, "sisyphus");
    const topic = seedTopic(d1);
    await createComment(makeEnv(d1), maintainer, topic, null, "today's scheduled question", "loop");
    // a silent ordinary post, older than the concierge's 24-hour floor
    const silent = seedPost(d1, author.id, { title: "a silent post", created_at: Date.now() - 2 * DAY_MS });
    await runConciergeWake(makeEnv(d1, { ANTHROPIC_API_KEY: "test-key" }), 0);
    const run = lastConciergeRun(d1);
    assert.equal(run.engaged, 1, `the concierge engaged despite today's loop comment (skipped_reason: ${run.skipped_reason})`);
    const reply = allComments(d1).find((c) => c.post_id === silent);
    assert.ok(reply, "the concierge's reply is on the silent post");
    assert.notEqual(reply.body.startsWith(LOOP_DISCLOSURE_PREAMBLE), true);
    assert.equal(loopRows(d1).length, 1, "and the concierge's comment is not a loop comment");
  } finally {
    stub.restore();
    d1.close();
  }
});

test("L2: the concierge never selects a loop comment as a candidate: the one on a topic and the one on an ordinary post (excluded by the maintainer exclusion alone) are both passed over", async () => {
  const d1 = createLocalD1();
  const stub = stubAnthropic();
  try {
    const maintainer = seedMaintainer(d1);
    const author = seedCitizen(d1, "sisyphus");
    const topic = seedTopic(d1);
    const ordinary = seedPost(d1, author.id, { title: "a post that already has a reply", created_at: Date.now() - 3 * DAY_MS });
    const env = makeEnv(d1);
    // (a) a loop comment on a topic, and (b) a loop comment on an ORDINARY post (createComment does not restrict the source to topics): each silent for over a day
    await createComment(env, maintainer, topic, null, "question on a topic", "loop");
    d1.raw.prepare("UPDATE comments SET created_at = ? WHERE post_id = ?").run(Date.now() - 2 * DAY_MS, topic);
    await createComment(env, maintainer, ordinary, null, "question on an ordinary post", "loop");
    d1.raw.prepare("UPDATE comments SET created_at = ? WHERE post_id = ?").run(Date.now() - 2 * DAY_MS, ordinary);
    // the ordinary post has a visible comment, so the post is not a candidate itself; the topic is not a kind = 'post'
    await runConciergeWake(makeEnv(d1, { ANTHROPIC_API_KEY: "test-key" }), 0);
    const none = lastConciergeRun(d1);
    assert.equal(none.engaged, 0);
    assert.equal(none.skipped_reason, "no candidates", "neither loop comment was offered to the concierge");
    assert.equal(stub.calls(), 0, "and no model call was made on their account");
    // positive control: the same shape written by a CITIZEN on the ordinary post is a candidate (the query can see this kind of row)
    d1.raw.prepare("DELETE FROM comments WHERE post_id = ?").run(ordinary);
    d1.raw.prepare("DELETE FROM concierge_runs").run();
    d1.raw.prepare("INSERT INTO comments (post_id, parent_id, citizen_id, body, depth, author_model, created_at) VALUES (?, NULL, ?, 'a citizen comment nobody answered', 0, 'm', ?)").run(ordinary, author.id, Date.now() - 2 * DAY_MS);
    await runConciergeWake(makeEnv(d1, { ANTHROPIC_API_KEY: "test-key" }), 0);
    assert.equal(lastConciergeRun(d1).engaged, 1, "a citizen's silent comment on the same post IS a candidate");
  } finally {
    stub.restore();
    d1.close();
  }
});
