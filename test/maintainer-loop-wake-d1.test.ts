// The daily loop's wake (src/maintainer/loop.ts runLoopWake, and the 12:00 cron through the real scheduled() handler): one scheduled question a
// UTC day, as a top-level comment by commonhold-agent on a standing topic, from the fixed queue in src/maintainer/loop-queue.ts. Real local D1
// (test/helpers/local-d1.ts) against the committed schema.sql; nothing mocked, and there is no model to stub (the loop makes no outbound call, and a
// test below counts that). The createComment side (source "loop", the preamble, the in-statement one-a-day predicate, the concierge interaction) is
// test/maintainer-loop-d1.test.ts. Every guard here was red-proofed by mutation (docs/CHECKPOINT-DAILY-LOOP-RULE7-STATUS.md carries the ledger).
//
// Run just this file: node --experimental-strip-types --test "test/maintainer-loop-wake-d1.test.ts"

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import { createLocalD1, insertCitizen, insertProposal, type LocalD1 } from "./helpers/local-d1.ts";
import { installSubrequestCounter, rpcBalanceResponse } from "./helpers/subrequest-counter.ts";
import { captureLog, eventLines } from "./helpers/settlement-harness.ts";
import { seedPost } from "./helpers/guest.ts";
import { runLoopWake } from "../src/maintainer/loop.ts";
import { LOOP_QUEUE } from "../src/maintainer/loop-queue.ts";
import { CLERK_CRON, LOOP_CRON } from "../src/maintainer/schedule.ts";
import { LOOP_ATTEMPT_COST, LOOP_DETECTION_COST, LOOP_MAX_ATTEMPTS, LOOP_WORST_CASE_COST, INVOCATION_SUBREQUEST_BUDGET, FINALISE_RESERVE, canAffordLoop } from "../src/maintainer/budget.ts";
import { bulletinDenyCheck } from "../src/maintainer/judgment.ts";
import { dutyRowsSql } from "../src/guest-core.ts";
import { CONSTITUTION, LOOP_DISCLOSURE_PREAMBLE, MAINTAINER_ID, utcMidnight, type Env } from "../src/society.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------- fixtures ----------

function makeEnv(db: unknown, extra: Record<string, unknown> = {}): Env {
  return { DB: db, TREASURY_ADDRESS: "0x0000000000000000000000000000000000000001", FACILITATOR_URL: "https://facilitator.invalid", REGISTRATION_MODE: "open", ...extra } as unknown as Env;
}

// The maintainer (citizen #1) and the five standing topics at posts 12-16, the ids the queue names. Seeded raw: scaffolding, not the code under test.
function seedStanding(d1: LocalD1, over: Partial<Record<number, { state?: "open" | "closed"; mod_state?: string | null; kind?: "topic" | "post" | null }>> = {}): void {
  assert.equal(insertCitizen(d1, { handle: "commonhold-agent", model: "claude-fable-5" }), MAINTAINER_ID, "the maintainer must be citizen #1");
  for (let id = 12; id <= 16; id++) {
    const o = over[id] ?? {};
    if (o.kind === null) continue; // leave the post missing
    const kind = o.kind ?? "topic";
    d1.raw
      .prepare("INSERT INTO posts (id, citizen_id, title, body, dupe_hash, pinned, mod_state, author_model, created_at, kind, topic_state) VALUES (?, 1, ?, 'body', ?, 0, ?, NULL, ?, ?, ?)")
      .run(id, `standing topic ${id}`, `dupe-topic-${id}`, o.mod_state ?? null, Date.now() - 20 * DAY_MS, kind, kind === "topic" ? (o.state ?? "open") : null);
  }
}

// What createComment stores for an item, derived here from the pieces rather than imported (the test must not agree with the code by construction).
const stored = (i: number) => `${LOOP_DISCLOSURE_PREAMBLE}\n\n${LOOP_QUEUE[i].body}`;

function insertComment(d1: LocalD1, postId: number, citizenId: number, body: string, createdAt: number): number {
  const res = d1.raw.prepare("INSERT INTO comments (post_id, parent_id, citizen_id, body, depth, author_model, created_at) VALUES (?, NULL, ?, ?, 0, 'm', ?)").run(postId, citizenId, body, createdAt);
  return Number(res.lastInsertRowid);
}
const markDone = (d1: LocalD1, i: number) => insertComment(d1, LOOP_QUEUE[i].topic, MAINTAINER_ID, stored(i), Date.now() - 3 * DAY_MS);

const comments = (d1: LocalD1) => d1.raw.prepare("SELECT id, post_id, parent_id, citizen_id, body, created_at FROM comments ORDER BY id ASC").all() as Array<{ id: number; post_id: number; parent_id: number | null; citizen_id: number; body: string; created_at: number }>;
const loopComments = (d1: LocalD1) => comments(d1).filter((c) => c.citizen_id === MAINTAINER_ID && c.body.startsWith(LOOP_DISCLOSURE_PREAMBLE));
const count = (d1: LocalD1, table: string) => Number((d1.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);

// Make yesterday of everything the loop posted, so the next run is "the next UTC day".
function nextUtcDay(d1: LocalD1): void {
  d1.raw.prepare("UPDATE comments SET created_at = ? WHERE citizen_id = ? AND created_at >= ?").run(utcMidnight(Date.now()) - 1, MAINTAINER_ID, utcMidnight(Date.now()));
}

async function wake(env: Env, priorCost = 0) {
  return captureLog(() => runLoopWake(env, priorCost));
}

// ---------- L3: the walk ----------

test("L5: a fresh queue posts item 1: a top-level comment by commonhold-agent on its topic, the stored body exactly preamble + blank line + item, and logs loop_posted", async () => {
  const d1 = createLocalD1();
  try {
    seedStanding(d1);
    const { lines } = await wake(makeEnv(d1.DB));
    const rows = comments(d1);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].post_id, LOOP_QUEUE[0].topic);
    assert.equal(rows[0].citizen_id, MAINTAINER_ID);
    assert.equal(rows[0].parent_id, null);
    assert.equal(rows[0].body, stored(0));
    const posted = eventLines(lines, "loop_posted");
    assert.equal(posted.length, 1);
    assert.deepEqual([posted[0].index, posted[0].topic, posted[0].comment_id], [0, LOOP_QUEUE[0].topic, rows[0].id]);
    assert.equal(eventLines(lines, "loop_wake_failed").length, 0);
  } finally {
    d1.close();
  }
});

test("L5: one item a day, in queue order: day two posts item 2, day three item 3, each on its own topic", async () => {
  const d1 = createLocalD1();
  try {
    seedStanding(d1);
    const env = makeEnv(d1.DB);
    for (let day = 0; day < 3; day++) {
      await wake(env);
      nextUtcDay(d1);
    }
    const posted = loopComments(d1);
    assert.deepEqual(
      posted.map((c) => [c.post_id, c.body]),
      [0, 1, 2].map((i) => [LOOP_QUEUE[i].topic, stored(i)]),
    );
  } finally {
    d1.close();
  }
});

test("L5: an item already on its topic is skipped; near misses (another citizen's copy, the maintainer's copy on the wrong topic, an edited body) are NOT done", async () => {
  const d1 = createLocalD1();
  try {
    seedStanding(d1);
    const other = insertCitizen(d1, { handle: "alice", model: "m" });
    // item 1 (queue index 0, topic 13): three near misses only
    insertComment(d1, LOOP_QUEUE[0].topic, other, stored(0), Date.now() - 3 * DAY_MS); // another citizen's copy
    insertComment(d1, LOOP_QUEUE[1].topic, MAINTAINER_ID, stored(0), Date.now() - 3 * DAY_MS); // the maintainer's copy, on the wrong topic
    insertComment(d1, LOOP_QUEUE[0].topic, MAINTAINER_ID, `${stored(0)} (edited)`, Date.now() - 3 * DAY_MS); // the maintainer, right topic, a different body
    const before = comments(d1).length;
    await wake(makeEnv(d1.DB));
    const added = comments(d1).slice(before);
    assert.equal(added.length, 1);
    assert.deepEqual([added[0].post_id, added[0].body], [LOOP_QUEUE[0].topic, stored(0)], "item 1 was not done by any near miss, so it is the one posted");
    // and now the real thing: items 1 and 2 done, so item 3 is next
    nextUtcDay(d1);
    markDone(d1, 1);
    await wake(makeEnv(d1.DB));
    const last = comments(d1).at(-1)!;
    assert.deepEqual([last.post_id, last.body], [LOOP_QUEUE[2].topic, stored(2)], "item 2 was already posted (marked done), so the walk reached item 3");
  } finally {
    d1.close();
  }
});

test("L5: a closed, a moderated, a non-topic and a missing post are each skipped with loop_item_skipped (index, topic, reason) and the walk posts the next postable item", async () => {
  const d1 = createLocalD1();
  try {
    // queue topics in order: 13, 14, 15, 12, 16 ...
    seedStanding(d1, { 13: { state: "closed" }, 14: { mod_state: "collapsed" }, 15: { kind: "post" }, 12: { kind: null } });
    const { lines } = await wake(makeEnv(d1.DB));
    const skipped = eventLines(lines, "loop_item_skipped").map((l) => [l.index, l.topic, l.reason]);
    assert.deepEqual(skipped, [
      [0, 13, "topic_closed"],
      [1, 14, "topic_moderated"],
      [2, 15, "not_a_topic"],
      [3, 12, "post_missing"],
    ]);
    const rows = loopComments(d1);
    assert.equal(rows.length, 1);
    assert.deepEqual([rows[0].post_id, rows[0].body], [LOOP_QUEUE[4].topic, stored(4)], "item 5 (topic 16) is the first postable");
    assert.equal(eventLines(lines, "loop_posted").map((l) => l.index)[0], 4);
  } finally {
    d1.close();
  }
});

test("L5: a skipped item is tried first again the next day, and a topic that has since closed does not make a DONE item undone", async () => {
  const d1 = createLocalD1();
  try {
    seedStanding(d1, { 13: { state: "closed" } });
    const env = makeEnv(d1.DB);
    await wake(env); // topic 13 closed: item 1 skipped, item 2 (topic 14) posted
    assert.equal(loopComments(d1)[0].post_id, LOOP_QUEUE[1].topic);
    nextUtcDay(d1);
    d1.raw.prepare("UPDATE posts SET topic_state = 'open' WHERE id = 13").run(); // reopened
    await wake(env);
    const rows = loopComments(d1);
    assert.deepEqual(rows.map((c) => c.body), [stored(1), stored(0)], "the skipped item 1 is first in line the day its topic is open again");
    nextUtcDay(d1);
    d1.raw.prepare("UPDATE posts SET topic_state = 'closed' WHERE id IN (13, 14)").run(); // both topics now closed, both items already posted
    const { lines } = await wake(env);
    const rows3 = loopComments(d1);
    assert.deepEqual(rows3.map((c) => c.post_id), [LOOP_QUEUE[1].topic, LOOP_QUEUE[0].topic, LOOP_QUEUE[2].topic], "items 1 and 2 stay done on their now-closed topics; the walk went on to item 3");
    assert.equal(eventLines(lines, "loop_item_skipped").length, 0, "done items are not re-reported as skipped");
  } finally {
    d1.close();
  }
});

// ---------- L3: one a UTC day ----------

test("L5: a second run the same UTC day writes nothing and logs loop_already_ran_today (the pre-read)", async () => {
  const d1 = createLocalD1();
  try {
    seedStanding(d1);
    const env = makeEnv(d1.DB);
    await wake(env);
    const { lines } = await wake(env);
    assert.equal(loopComments(d1).length, 1);
    const ran = eventLines(lines, "loop_already_ran_today");
    assert.equal(ran.length, 1);
    assert.equal(ran[0].by, "pre-read");
    assert.equal(eventLines(lines, "loop_posted").length, 0);
  } finally {
    d1.close();
  }
});

test("L5: two runs started together write exactly one comment: the loser is refused by the INSERT's own predicate and logs loop_already_ran_today (predicate)", async () => {
  const d1 = createLocalD1();
  try {
    seedStanding(d1);
    const env = makeEnv(d1.DB);
    const { lines } = await captureLog(() => Promise.all([runLoopWake(env, 0), runLoopWake(env, 0)]));
    assert.equal(loopComments(d1).length, 1, "exactly one comment");
    assert.equal(eventLines(lines, "loop_posted").length, 1);
    const ran = eventLines(lines, "loop_already_ran_today");
    assert.deepEqual(ran.map((l) => l.by), ["predicate"], "both pre-reads passed; the second INSERT was refused by the predicate");
    assert.equal(eventLines(lines, "loop_wake_failed").length, 0);
  } finally {
    d1.close();
  }
});

// ---------- L3: the end of the queue, the budget, a failure ----------

test("L5: when every item is posted the loop writes nothing and logs loop_queue_exhausted: the kill date", async () => {
  const d1 = createLocalD1();
  try {
    seedStanding(d1);
    for (let i = 0; i < LOOP_QUEUE.length; i++) markDone(d1, i);
    const before = comments(d1).length;
    const { lines } = await wake(makeEnv(d1.DB));
    assert.equal(comments(d1).length, before, "nothing written");
    const ex = eventLines(lines, "loop_queue_exhausted");
    assert.equal(ex.length, 1);
    assert.equal(ex[0].items, LOOP_QUEUE.length);
    assert.equal(eventLines(lines, "loop_posted").length, 0);
  } finally {
    d1.close();
  }
});

test("L5: items left but none postable writes nothing and says so (loop_nothing_postable), never the exhausted line", async () => {
  const d1 = createLocalD1();
  try {
    seedStanding(d1);
    d1.raw.prepare("UPDATE posts SET topic_state = 'closed' WHERE id BETWEEN 12 AND 16").run();
    const { lines } = await wake(makeEnv(d1.DB));
    assert.equal(comments(d1).length, 0);
    assert.equal(eventLines(lines, "loop_queue_exhausted").length, 0);
    const none = eventLines(lines, "loop_nothing_postable");
    assert.equal(none.length, 1);
    assert.deepEqual([none[0].done, none[0].skipped, none[0].refused], [0, LOOP_QUEUE.length, 0]);
  } finally {
    d1.close();
  }
});

test("L5: the budget defer: when priorCost leaves too little the loop logs loop_deferred_budget once, spends no statement and writes nothing; one under the line it runs", async () => {
  const limit = INVOCATION_SUBREQUEST_BUDGET - LOOP_WORST_CASE_COST - FINALISE_RESERVE;
  assert.equal(canAffordLoop(limit), true);
  assert.equal(canAffordLoop(limit + 1), false);
  const counter = installSubrequestCounter(() => rpcBalanceResponse(), 10_000);
  const d1 = createLocalD1({ onExec: counter.consume });
  try {
    seedStanding(d1);
    const env = makeEnv(d1.DB);
    const before = counter.total();
    const { lines } = await wake(env, limit + 1);
    assert.equal(counter.total() - before, 0, "a shed run spends nothing");
    assert.equal(comments(d1).length, 0);
    const def = eventLines(lines, "loop_deferred_budget");
    assert.equal(def.length, 1);
    assert.equal(def[0].prior_cost, limit + 1);
    await wake(env, limit);
    assert.equal(loopComments(d1).length, 1, "at the line it runs");
  } finally {
    counter.restore();
    d1.close();
  }
});

test("L5: runLoopWake never throws: a database that fails is logged as ONE loop_wake_failed and nothing is written", async () => {
  const d1 = createLocalD1();
  try {
    seedStanding(d1);
    const failing = {
      prepare: (sql: string) => {
        if (/FROM posts WHERE id IN/.test(sql)) throw new Error("posts are unavailable");
        return d1.DB.prepare(sql);
      },
      batch: (s: unknown[]) => d1.DB.batch(s as never),
    };
    const { lines } = await captureLog(() => runLoopWake(makeEnv(failing)));
    const failed = eventLines(lines, "loop_wake_failed");
    assert.equal(failed.length, 1);
    assert.match(String(failed[0].message), /posts are unavailable/);
    assert.equal(comments(d1).length, 0);
  } finally {
    d1.close();
  }
});

test("L5: a database failure AT the write is a failure, not a refusal: one loop_wake_failed, no loop_post_refused, and the run ends there", async () => {
  const d1 = createLocalD1();
  try {
    seedStanding(d1);
    const failing = {
      prepare: (sql: string) => {
        if (/^\s*INSERT INTO comments/i.test(sql)) throw new Error("the comments table is unavailable");
        return d1.DB.prepare(sql);
      },
      batch: (s: unknown[]) => d1.DB.batch(s as never),
    };
    const { lines } = await captureLog(() => runLoopWake(makeEnv(failing)));
    assert.equal(eventLines(lines, "loop_wake_failed").length, 1);
    assert.match(String(eventLines(lines, "loop_wake_failed")[0].message), /comments table is unavailable/);
    assert.equal(eventLines(lines, "loop_post_refused").length, 0, "a runtime failure is not a refusal, so the walk does not go on to the next item");
    assert.equal(comments(d1).length, 0);
  } finally {
    d1.close();
  }
});

// ---------- L3: refusals between the read and the write ----------

// A database that, just before the INSERT INTO comments statement runs, closes the topic that statement targets: a close landing between the walk's
// read and the write. The refusal that follows comes from the REAL INSERT's own predicate and the REAL diagnosis read; only the interleaving is staged.
function closingJustBeforeInsert(d1: LocalD1, times = Infinity) {
  let closed = 0;
  return {
    prepare(sql: string) {
      const real = d1.DB.prepare(sql);
      if (!/^\s*INSERT INTO comments/i.test(sql)) return real;
      return {
        bind: (...args: unknown[]) => {
          const bound = real.bind(...args);
          return {
            first: async () => {
              if (closed < times) {
                closed++;
                d1.raw.prepare("UPDATE posts SET topic_state = 'closed', topic_closed_at = ? WHERE id = ?").run(Date.now(), args[0]);
              }
              return bound.first();
            },
          };
        },
      };
    },
    batch: (s: unknown[]) => d1.DB.batch(s as never),
  };
}

test("L5: a topic closed between the read and the write is a refusal, not a failure: loop_post_refused for that item, and the SAME run goes on to the next item", async () => {
  const d1 = createLocalD1();
  try {
    seedStanding(d1);
    const { lines } = await captureLog(() => runLoopWake(makeEnv(closingJustBeforeInsert(d1, 1))));
    const refused = eventLines(lines, "loop_post_refused");
    assert.equal(refused.length, 1);
    assert.deepEqual([refused[0].index, refused[0].topic, refused[0].status], [0, LOOP_QUEUE[0].topic, 409]);
    assert.match(String(refused[0].message), /closed/);
    const rows = loopComments(d1);
    assert.equal(rows.length, 1, "one stalled item cannot stall the queue");
    assert.deepEqual([rows[0].post_id, rows[0].body], [LOOP_QUEUE[1].topic, stored(1)]);
    assert.equal(eventLines(lines, "loop_wake_failed").length, 0);
  } finally {
    d1.close();
  }
});

test("L5: refusals are capped at LOOP_MAX_ATTEMPTS a run, and the counted statements equal the priced worst case exactly (and make no outbound call)", async () => {
  const counter = installSubrequestCounter(() => {
    throw new Error("the loop must make no outbound call");
  }, 10_000);
  const d1 = createLocalD1({ onExec: counter.consume });
  try {
    seedStanding(d1);
    const before = counter.total();
    const { lines } = await captureLog(() => runLoopWake(makeEnv(closingJustBeforeInsert(d1)), 0));
    assert.equal(eventLines(lines, "loop_post_refused").length, LOOP_MAX_ATTEMPTS);
    assert.equal(eventLines(lines, "loop_attempts_exhausted").length, 1);
    assert.equal(loopComments(d1).length, 0, "every attempt was refused, so nothing was written");
    assert.equal(counter.total() - before, LOOP_WORST_CASE_COST, "priced worst case == counted worst case (a drifted constant turns this red)");
    assert.equal(LOOP_WORST_CASE_COST, LOOP_DETECTION_COST + LOOP_MAX_ATTEMPTS * LOOP_ATTEMPT_COST);
    assert.equal(counter.fetches(), 0, "no outbound call, so no model call");
    assert.equal(counter.breached(), false);
  } finally {
    counter.restore();
    d1.close();
  }
});

test("L5: the ordinary run's counted statements: detection (4) plus createComment's three, inside the priced worst case", async () => {
  const counter = installSubrequestCounter(() => {
    throw new Error("the loop must make no outbound call");
  }, 10_000);
  const d1 = createLocalD1({ onExec: counter.consume });
  try {
    seedStanding(d1);
    const before = counter.total();
    await runLoopWake(makeEnv(d1.DB), 0);
    assert.equal(counter.total() - before, LOOP_DETECTION_COST + 3);
    assert.ok(counter.total() - before <= LOOP_WORST_CASE_COST);
    assert.equal(loopComments(d1).length, 1);
    assert.equal(counter.fetches(), 0);
  } finally {
    counter.restore();
    d1.close();
  }
});

// ---------- the queue ----------

test("L5: the queue: 14 items, each on a standing topic 12-16, non-empty, at most 700 characters, passing the same deny check the concierge's comments pass, and fitting max_body_len with the preamble", () => {
  assert.equal(LOOP_QUEUE.length, 14);
  for (const [i, item] of LOOP_QUEUE.entries()) {
    const label = `item ${i + 1} (topic ${item.topic})`;
    assert.ok(item.topic >= 12 && item.topic <= 16, `${label}: a standing topic`);
    assert.ok(item.body.length >= 1 && item.body.length <= 700, `${label}: ${item.body.length} characters, at most 700`);
    assert.equal(item.body, item.body.trim(), `${label}: no outer whitespace, so the stored form is exactly preamble + blank line + item`);
    assert.equal(bulletinDenyCheck("", item.body), null, `${label}: passes the deny check`);
    assert.equal(bulletinDenyCheck("", `${LOOP_DISCLOSURE_PREAMBLE}\n\n${item.body}`), null, `${label}: and so does the stored comment`);
    assert.ok(LOOP_DISCLOSURE_PREAMBLE.length + 2 + item.body.length <= CONSTITUTION.max_body_len, `${label}: fits max_body_len`);
  }
  assert.equal(new Set(LOOP_QUEUE.map((i) => i.body)).size, LOOP_QUEUE.length, "no item twice");
  assert.deepEqual(
    [...new Set(LOOP_QUEUE.map((i) => i.topic))].sort((a, b) => a - b),
    [12, 13, 14, 15, 16],
    "every standing topic is asked about",
  );
});

test("L5: the deny check the queue is held to can fail (it refuses a link, a claim and a key request)", () => {
  assert.notEqual(bulletinDenyCheck("", "see https://example.com for the details"), null);
  assert.notEqual(bulletinDenyCheck("", "claim your reward here"), null);
  assert.notEqual(bulletinDenyCheck("", "send your private key to the maintainer"), null);
});

// ---------- the guest duty ----------

test("L5: a loop comment on a topic can never discharge a guest's critique duty (a duty is discharged only by a guest_thread answer, which the loop never writes), while a real answer does", async () => {
  const d1 = createLocalD1();
  try {
    seedStanding(d1);
    const topic = LOOP_QUEUE[0].topic;
    const now = Date.now();
    // a guest critique on that very topic, owed (due in 20 hours), as the guest voice's INSERT would have stored it
    const duty = Number(
      d1.raw
        .prepare("INSERT INTO guest_thread (post_id, author_kind, author_id, handle, model, kind, body, duty, due_at, created_at) VALUES (?, 'guest', 7, 'a-guest', 'm', 'critique', 'The book cannot show a removed row.', 1, ?, ?)")
        .run(topic, now + 20 * 3600_000, now - 76 * 3600_000).lastInsertRowid,
    );
    const status = () => (d1.raw.prepare(dutyRowsSql(Date.now(), "g.id = ?")).get(duty) as { duty_status: string }).duty_status;
    assert.equal(status(), "open", "setup: the duty is owed");
    const guestRowsBefore = count(d1, "guest_thread");
    await wake(makeEnv(d1.DB));
    assert.equal(loopComments(d1).length, 1);
    assert.equal(loopComments(d1)[0].post_id, topic, "the loop commented on the very topic the guest wrote on");
    assert.equal(status(), "open", "the loop comment did not discharge the duty");
    assert.equal(count(d1, "guest_thread"), guestRowsBefore, "and the loop wrote nothing to the guest thread");
    // positive control: the answer that does discharge it (the answerer's own guest_thread row hanging off the critique, 80+ characters)
    d1.raw
      .prepare("INSERT INTO guest_thread (post_id, parent_kind, parent_id, depth, author_kind, author_id, handle, model, kind, body, created_at) VALUES (?, 'thread', ?, 1, 'citizen', 1, 'commonhold-agent', 'm', 'comment', ?, ?)")
      .run(topic, duty, "x".repeat(120), Date.now());
    assert.equal(status(), "answered", "the status machine can see a discharge, so the 'open' above means something");
  } finally {
    d1.close();
  }
});

// ---------- through the real scheduled() handler ----------

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
const fire = (cron: string, env: Env) => (worker.scheduled as unknown as (c: unknown, e: Env, x: unknown) => Promise<void>)({ cron, scheduledTime: Date.now(), noRetry: () => {} }, env, ctx);

test("L5: the 12:00 cron through scheduled(): the sweep runs first, the loop posts once, and NOTHING of the 06:00 wake runs (no clerk, concierge, guest check or reconciler row)", async () => {
  const counter = installSubrequestCounter((url) => (url.includes("anthropic") ? new Response(JSON.stringify({ content: [{ type: "text", text: "[]" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 }) : rpcBalanceResponse()), 10_000);
  const d1 = createLocalD1({ onExec: counter.consume });
  try {
    seedStanding(d1);
    for (let i = 0; i < 4; i++) insertCitizen(d1);
    const dueProposal = insertProposal(d1, { kind: "resolution", status: "open", opened_at: Date.now() - 9 * DAY_MS, closes_at: Date.now() - 2_000 });
    // a silent ordinary post the concierge would answer if the 06:00 wake ran
    seedPost(d1, 2, { title: "a silent post", created_at: Date.now() - 3 * DAY_MS });
    const env = makeEnv(d1.DB, { ANTHROPIC_API_KEY: "test-key" });
    const runs = () => ({ clerk_judgment: count(d1, "maintainer_runs"), concierge: count(d1, "concierge_runs"), guest_check: count(d1, "guest_duty_runs") });

    const { lines } = await captureLog(() => fire(LOOP_CRON, env));
    const status = (d1.raw.prepare("SELECT status FROM proposals WHERE id = ?").get(dueProposal) as { status: string }).status;
    assert.notEqual(status, "open", "the governance sweep ran on the 12:00 wake and tallied the due proposal");
    assert.equal(loopComments(d1).length, 1, "the loop posted once");
    assert.equal(eventLines(lines, "scheduled_wake_failed").length, 0);
    assert.equal(eventLines(lines, "scheduled_cron_unmatched").length, 0, "the 12:00 string is recognised");
    assert.deepEqual(runs(), { clerk_judgment: 0, concierge: 0, guest_check: 0 }, "none of the 06:00 wake ran");

    // positive control: the 06:00 cron DOES write those rows (so the zeros above mean something), and does not run the loop
    await captureLog(() => fire(CLERK_CRON, env));
    assert.deepEqual(runs(), { clerk_judgment: 1, concierge: 1, guest_check: 1 });
    assert.equal(loopComments(d1).length, 1, "the 06:00 wake posted no loop comment");
  } finally {
    counter.restore();
    d1.close();
  }
});

test("L5: a cron string nobody registered still gets the sweep and the unmatched-cron log line, and the loop does not run for it", async () => {
  const d1 = createLocalD1();
  const counter = installSubrequestCounter(() => rpcBalanceResponse(), 10_000);
  try {
    seedStanding(d1);
    const { lines } = await captureLog(() => fire("30 5 * * *", makeEnv(d1.DB)));
    const unmatched = eventLines(lines, "scheduled_cron_unmatched");
    assert.equal(unmatched.length, 1);
    assert.equal(unmatched[0].cron, "30 5 * * *");
    assert.equal(comments(d1).length, 0);
  } finally {
    counter.restore();
    d1.close();
  }
});

test("L5: a loop failure inside scheduled() is logged loop_wake_failed once and never reaches the wake backstop (scheduled_wake_failed stays zero)", async () => {
  const d1 = createLocalD1();
  const counter = installSubrequestCounter(() => rpcBalanceResponse(), 10_000);
  try {
    seedStanding(d1);
    const failing = {
      prepare: (sql: string) => {
        if (/FROM posts WHERE id IN/.test(sql)) throw new Error("posts are unavailable");
        return d1.DB.prepare(sql);
      },
      batch: (s: unknown[]) => d1.DB.batch(s as never),
    };
    const { lines } = await captureLog(() => fire(LOOP_CRON, makeEnv(failing)));
    assert.equal(eventLines(lines, "loop_wake_failed").length, 1);
    assert.equal(eventLines(lines, "scheduled_wake_failed").length, 0);
  } finally {
    counter.restore();
    d1.close();
  }
});
