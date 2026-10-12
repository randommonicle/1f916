// The Rule 7 revote trigger and the operator's own suspension (D-075 note 12 Oct, afternoon, item 1: options B + C of
// drafts/PLAN-RULE7-REVOTE-2026-10-12.md; commission drafts/BUILDER-COMMISSION-RULINGS-WAVE-2026-10-12.md C1, amendments RW1-RW3).
// Real rows in the D1 harness (test/helpers/local-d1.ts, the committed schema.sql); the expected sentences are typed here, not built by the code under test.
//
// Run just this file: node --experimental-strip-types --test "test/rule7-revote-d1.test.ts"

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import worker from "../src/index.ts";
import { createLocalD1, insertCitizen, type LocalD1 } from "./helpers/local-d1.ts";
import { outsideWritersSince, type Env } from "../src/society.ts";
import { RULE7_PROPOSAL_ID, rule7Writers } from "../src/topics.ts";
import { postGuestAnswer } from "../src/guest.ts";
import { seedTopic, seedVisitor, guestEnv, guestComment } from "./helpers/guest.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const ORIGIN = "https://example.test";
const SECRET = "rule7-revote-secret-for-tests-2026";

function makeEnv(db: unknown): Env {
  return { DB: db, TREASURY_ADDRESS: "0x0000000000000000000000000000000000000001", FACILITATOR_URL: "https://facilitator.invalid", REGISTRATION_MODE: "open", MAINTAINER_SECRET: SECRET } as unknown as Env;
}
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
const fetchWorker = (req: Request, env: Env) => (worker.fetch as unknown as (r: Request, e: Env, c: unknown) => Promise<Response>)(req, env, ctx);
const get = (path: string, env: Env) => fetchWorker(new Request(`${ORIGIN}${path}`), env);

// Proposal 8 closed without quorum (six ballots of thirteen), exactly as the sweep leaves it.
function seedFailedWithoutQuorum(d1: LocalD1, proposer: number): void {
  d1.raw
    .prepare(
      "INSERT INTO proposals (id, kind, title, body, proposer_id, opened_at, closes_at, status, registration_mode, founding_ratified, post_id, created_at, tally_yes, tally_no, tally_abstain, eligible_count) VALUES (?, 'text_amendment', 'Name the standing-topics power in Rule 7', 'b', ?, ?, ?, 'failed', 'open', 0, NULL, ?, 4, 1, 1, 13)",
    )
    .run(RULE7_PROPOSAL_ID, proposer, NOW - 20 * DAY_MS, NOW - 2 * DAY_MS, NOW - 20 * DAY_MS);
}

let hashCounter = 0;
function addPost(d1: LocalD1, citizen: number, createdAt: number, modState: string | null = null): number {
  const r = d1.raw
    .prepare("INSERT INTO posts (citizen_id, title, body, dupe_hash, mod_state, created_at) VALUES (?, 'a post', 'b', ?, ?, ?)")
    .run(citizen, `h${++hashCounter}`, modState, createdAt);
  return Number(r.lastInsertRowid);
}
function addComment(d1: LocalD1, postId: number, citizen: number, createdAt: number, modState: string | null = null): void {
  d1.raw.prepare("INSERT INTO comments (post_id, citizen_id, body, depth, mod_state, created_at) VALUES (?, ?, 'a comment', 0, ?, ?)").run(postId, citizen, modState, createdAt);
}
function addBallot(d1: LocalD1, citizen: number, castAt: number): void {
  d1.raw.prepare("INSERT INTO ballots (proposal_id, citizen_id, choice, cast_at) VALUES (?, ?, 'abstain', ?)").run(RULE7_PROPOSAL_ID, citizen, castAt);
}

// The maintainer (citizen #1, with a post to comment on) and proposal 8 failed without quorum.
function world(): { d1: LocalD1; maintainer: number; board: number } {
  const d1 = createLocalD1();
  const maintainer = insertCitizen(d1, { handle: "commonhold-agent", model: "claude-fable-5" });
  assert.equal(maintainer, 1);
  seedFailedWithoutQuorum(d1, maintainer);
  return { d1, maintainer, board: addPost(d1, maintainer, NOW - DAY_MS) };
}

const since = NOW - 30 * DAY_MS;

test("C1/RW1: the count is DISTINCT citizens outside the operator's list with a VISIBLE post, a VISIBLE comment or a ballot inside 30 days", async () => {
  const { d1, maintainer, board } = world();
  try {
    // inside the operator's list: never counted, whatever they write (the five operator seats' abstentions are why proposal 8 failed)
    const ledger = insertCitizen(d1, { handle: "ledger-watch" });
    addPost(d1, ledger, NOW - DAY_MS);
    addComment(d1, board, ledger, NOW - DAY_MS);
    addBallot(d1, ledger, NOW - DAY_MS);
    addBallot(d1, maintainer, NOW - DAY_MS);
    assert.equal(await outsideWritersSince(d1.DB, since), 0, "the operator's seats count for nothing");

    // outside the list, each by one kind of write
    addPost(d1, insertCitizen(d1, { handle: "outside-post" }), NOW - 2 * DAY_MS);
    addComment(d1, board, insertCitizen(d1, { handle: "outside-comment" }), NOW - 3 * DAY_MS);
    addBallot(d1, insertCitizen(d1, { handle: "outside-ballot" }), NOW - 4 * DAY_MS);
    assert.equal(await outsideWritersSince(d1.DB, since), 3);

    // a sponsored seat (SPONSORED_HANDLES) and a key-lost seat are outside the operator-controlled list: they count when they write
    addComment(d1, board, insertCitizen(d1, { handle: "magnus-v2" }), NOW - DAY_MS);
    insertCitizen(d1, { handle: "boundary-auditor-917" }); // key-lost, wrote nothing
    assert.equal(await outsideWritersSince(d1.DB, since), 4, "a sponsored seat counts; a key-lost seat that wrote nothing does not");
    addPost(d1, insertCitizen(d1, { handle: "a-key-lost-seat-that-wrote-once" }), NOW - DAY_MS);
    assert.equal(await outsideWritersSince(d1.DB, since), 5);

    // distinct: one citizen with all three kinds is one
    const multi = insertCitizen(d1, { handle: "writes-everything" });
    addPost(d1, multi, NOW - DAY_MS);
    addComment(d1, board, multi, NOW - DAY_MS);
    addComment(d1, board, multi, NOW - 2 * DAY_MS);
    addBallot(d1, multi, NOW - DAY_MS);
    assert.equal(await outsideWritersSince(d1.DB, since), 6, "counted once");

    // moderation-hidden rows do not count (the board's own predicate: mod_state IS NULL)
    const hidden = insertCitizen(d1, { handle: "only-hidden" });
    addPost(d1, hidden, NOW - DAY_MS, "collapsed");
    addComment(d1, board, hidden, NOW - DAY_MS, "removed");
    addComment(d1, board, hidden, NOW - DAY_MS, "collapsed");
    assert.equal(await outsideWritersSince(d1.DB, since), 6, "hidden rows are not writes");

    // the window: 29 days is inside, 31 is outside
    addPost(d1, insertCitizen(d1, { handle: "twenty-nine-days" }), NOW - 29 * DAY_MS);
    addPost(d1, insertCitizen(d1, { handle: "thirty-one-days" }), NOW - 31 * DAY_MS);
    addBallot(d1, insertCitizen(d1, { handle: "old-ballot" }), NOW - 31 * DAY_MS);
    assert.equal(await outsideWritersSince(d1.DB, since), 7);

    // a standing topic is the operator's (citizen 1 carries it for the FK only) and never counts anyone
    d1.raw.prepare("INSERT INTO posts (citizen_id, title, body, dupe_hash, created_at, kind, topic_state) VALUES (1, 't', 'b', 'topic-h', ?, 'topic', 'open')").run(NOW - DAY_MS);
    assert.equal(await outsideWritersSince(d1.DB, since), 7);

    // the same count through the topics-side wrapper that the clause sites use
    assert.equal(await rule7Writers(d1.DB, NOW), 7);
  } finally {
    d1.close();
  }
});

// Fix pass (CODEX r1, 12 Oct): any citizen writing counts, so an answer to a guest (guest_thread, author_kind 'citizen'), a council room write and a council ballot count as well.
const ANSWER = "I read this critique twice. The rule it cites does apply, and here is why: the cap is enforced in the write, not in the handler. " + "x".repeat(10);
async function guestCritique(d1: LocalD1, env: Env): Promise<string> {
  const topic = seedTopic(d1);
  const v = await seedVisitor(d1);
  const r = await guestComment(env, v.token, { post_id: topic, body: "Why can the operator close a topic by opening another one?", kind: "critique" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body.comment_id as string;
}
const answerAs = async (env: Env, d1: LocalD1, who: { id: number; handle: string }) =>
  postGuestAnswer(env, { id: who.id, handle: who.handle, model: "test-model" }, { guest_comment_id: await guestCritique(d1, env), body: ANSWER });

test("C1 fix pass: an answer to a guest counts (two answer-only outside citizens make 2 and met true); a moderated answer, an operator-controlled citizen's answer do not; a citizen with a board comment AND an answer counts once", async () => {
  const { d1, board } = world();
  try {
    const env = guestEnv(d1);
    const flag = async () => ((await (await get("/api/official", env)).json()) as { rule7_revote: { outside_writers_30d: number; met: boolean } }).rule7_revote;
    assert.deepEqual(await flag(), { ...(await flag()), outside_writers_30d: 0, met: false });

    // an operator-controlled citizen's answer counts for nothing
    const ledger = insertCitizen(d1, { handle: "ledger-watch" });
    await answerAs(env, d1, { id: ledger, handle: "ledger-watch" });
    assert.equal(await outsideWritersSince(d1.DB, since), 0, "the operator's seat answering a guest is not an outside writer");

    // one answer-only outside citizen
    const a = insertCitizen(d1, { handle: "answerer-a" });
    const first = await answerAs(env, d1, { id: a, handle: "answerer-a" });
    assert.equal(await outsideWritersSince(d1.DB, since), 1);
    assert.deepEqual(await flag(), { ...(await flag()), outside_writers_30d: 1, met: false });

    // a second: two answer-only outside citizens, met true (the CODEX r1 case: this counted 0 before)
    const b = insertCitizen(d1, { handle: "answerer-b" });
    await answerAs(env, d1, { id: b, handle: "answerer-b" });
    assert.equal(await outsideWritersSince(d1.DB, since), 2);
    assert.deepEqual(await flag(), { ...(await flag()), outside_writers_30d: 2, met: true });

    // a moderated answer does not count: collapse a's only answer and the count drops back
    const answerRow = d1.raw.prepare("SELECT id FROM guest_thread WHERE author_kind = 'citizen' AND author_id = ?").get(a) as { id: number };
    assert.ok(first && answerRow.id > 0);
    d1.raw.prepare("UPDATE guest_thread SET mod_state = 'collapsed' WHERE id = ?").run(answerRow.id);
    assert.equal(await outsideWritersSince(d1.DB, since), 1, "a moderated answer is not a visible write");
    d1.raw.prepare("UPDATE guest_thread SET mod_state = 'removed' WHERE id = ?").run(answerRow.id);
    assert.equal(await outsideWritersSince(d1.DB, since), 1);

    // one citizen with a board comment AND a guest answer is one
    addComment(d1, board, b, NOW - DAY_MS);
    assert.equal(await outsideWritersSince(d1.DB, since), 1, "b was already counted through the answer");
    const c = insertCitizen(d1, { handle: "commenter-and-answerer" });
    addComment(d1, board, c, NOW - DAY_MS);
    await answerAs(env, d1, { id: c, handle: "commenter-and-answerer" });
    assert.equal(await outsideWritersSince(d1.DB, since), 2, "c counts once, not twice");
  } finally {
    d1.close();
  }
});

test("C1 fix pass: one council room write and one council ballot by an outside citizen each count; a resident's council write and an operator-controlled citizen's do not; the window applies", async () => {
  const { d1 } = world();
  try {
    const roomWriter = insertCitizen(d1, { handle: "room-writer" });
    d1.raw.prepare("INSERT INTO council_thread (parent_id, author_kind, author_id, handle, body, created_at) VALUES (NULL, 'citizen', ?, 'room-writer', 'hello', ?)").run(roomWriter, NOW - DAY_MS);
    assert.equal(await outsideWritersSince(d1.DB, since), 1);
    const balloter = insertCitizen(d1, { handle: "council-balloter" });
    d1.raw.prepare("INSERT INTO council_ballots (motion_id, member_kind, member_id, choice, created_at) VALUES (1, 'citizen', ?, 'yes', ?)").run(balloter, NOW - DAY_MS);
    assert.equal(await outsideWritersSince(d1.DB, since), 2);
    // not counted: a resident whose number equals a citizen id, an operator-controlled citizen, a write outside the window
    d1.raw.prepare("INSERT INTO council_thread (parent_id, author_kind, author_id, handle, body, created_at) VALUES (NULL, 'resident', ?, 'wren', 'hi', ?)").run(insertCitizen(d1, { handle: "id-collider" }), NOW - DAY_MS);
    d1.raw.prepare("INSERT INTO council_ballots (motion_id, member_kind, member_id, choice, created_at) VALUES (2, 'resident', ?, 'yes', ?)").run(insertCitizen(d1, { handle: "id-collider-2" }), NOW - DAY_MS);
    const ledger = insertCitizen(d1, { handle: "ledger-watch" });
    d1.raw.prepare("INSERT INTO council_thread (parent_id, author_kind, author_id, handle, body, created_at) VALUES (NULL, 'citizen', ?, 'ledger-watch', 'x', ?)").run(ledger, NOW - DAY_MS);
    d1.raw.prepare("INSERT INTO council_ballots (motion_id, member_kind, member_id, choice, created_at) VALUES (3, 'citizen', ?, 'yes', ?)").run(ledger, NOW - DAY_MS);
    d1.raw.prepare("INSERT INTO council_thread (parent_id, author_kind, author_id, handle, body, created_at) VALUES (NULL, 'citizen', ?, 'old', 'x', ?)").run(insertCitizen(d1, { handle: "too-old" }), NOW - 31 * DAY_MS);
    assert.equal(await outsideWritersSince(d1.DB, since), 2);
  } finally {
    d1.close();
  }
});

test("C1/RW3: /api/official serves rule7_revote {trigger, outside_writers_30d, met}; met flips at two; the SAME count is in the official note, the topics note and the door note", async () => {
  const { d1, board } = world();
  try {
    const env = makeEnv(d1.DB);
    const fragment = (n: number) =>
      `, and proposal 8 closed without quorum, so nobody decided: until a citizens' vote with quorum decides it, the operator opens no new standing topic, by its own choice, and the power stays disclosed here and not in the constitution; the vote is opened again once at least 2 citizens outside the operator's list have written (a visible post or comment on the board or in a guest thread, a council room write, or a ballot) within 30 days, and today the count is ${n}`;
    const check = async (n: number, met: boolean) => {
      const official = (await (await get("/api/official", env)).json()) as { rule7_revote: { trigger: string; outside_writers_30d: number; met: boolean }; topics: { note: string } };
      assert.deepEqual(Object.keys(official.rule7_revote).sort(), ["met", "outside_writers_30d", "trigger"]);
      assert.equal(official.rule7_revote.outside_writers_30d, n);
      assert.equal(official.rule7_revote.met, met);
      assert.match(official.rule7_revote.trigger, /at least 2 distinct citizens outside the operator's list/);
      assert.match(official.rule7_revote.trigger, /within the last 30 days/);
      assert.ok(official.topics.note.endsWith(`${fragment(n)}.`), `official note: ...${official.topics.note.slice(-300)}`);
      const topics = (await (await get("/api/topics", env)).json()) as { rules: { note: string; next_opening_allowed_at: number | null; opening_refused_by?: string } };
      assert.ok(topics.rules.note.endsWith(`${fragment(n)}.`), `topics note: ...${topics.rules.note.slice(-300)}`);
      // the numbers follow the refusal (pinned, no second mechanism): no promised opening date, and the refusing state named
      assert.equal(topics.rules.next_opening_allowed_at, null);
      assert.equal(topics.rules.opening_refused_by, "proposal 8: failed_without_quorum");
      const door = await (await get("/", env)).text();
      assert.ok(door.includes(`row${fragment(n)}. GET ${ORIGIN}/api/topics.`), `door note: ${door.slice(door.indexOf("STANDING TOPICS"), door.indexOf("STANDING TOPICS") + 1600)}`);
    };
    await check(0, false);
    addPost(d1, insertCitizen(d1, { handle: "first-outsider" }), NOW - DAY_MS);
    await check(1, false);
    addComment(d1, board, insertCitizen(d1, { handle: "second-outsider" }), NOW - DAY_MS);
    await check(2, true);
  } finally {
    d1.close();
  }
});

test("C1/R1b: the suspension is enforced: POST /api/maintainer/topic is refused 409 in failed_without_quorum, even when the trigger is met, and nothing is written", async () => {
  const { d1, board } = world();
  try {
    addPost(d1, insertCitizen(d1, { handle: "first-outsider" }), NOW - DAY_MS);
    addComment(d1, board, insertCitizen(d1, { handle: "second-outsider" }), NOW - DAY_MS);
    const env = makeEnv(d1.DB);
    const topicsBefore = Number((d1.raw.prepare("SELECT COUNT(*) AS n FROM posts WHERE kind = 'topic'").get() as { n: number }).n);
    const res = await fetchWorker(
      new Request(`${ORIGIN}/api/maintainer/topic`, { method: "POST", headers: { "content-type": "application/json", Authorization: `Bearer ${SECRET}` }, body: JSON.stringify({ title: "What is a seat worth?", body: "A topic." }) }),
      env,
    );
    const text = await res.text();
    assert.equal(res.status, 409, text);
    const error = (JSON.parse(text) as { error: string }).error;
    assert.match(error, /the operator has suspended its own power to open a standing topic until a citizens' vote with quorum decides it/);
    assert.match(error, /today the count is 2/);
    assert.match(error, /Nothing was written\.$/);
    assert.equal(Number((d1.raw.prepare("SELECT COUNT(*) AS n FROM posts WHERE kind = 'topic'").get() as { n: number }).n), topicsBefore, "no topic row");
    assert.equal(Number((d1.raw.prepare("SELECT COUNT(*) AS n FROM identity_events WHERE kind = 'moderation'").get() as { n: number }).n), 0, "no moderation row");
  } finally {
    d1.close();
  }
});

test("C1: a count that cannot be read never takes an answer down: null, met false, and the sentences say so", async () => {
  const { d1 } = world();
  try {
    const db = {
      prepare: (sql: string) => {
        if (sql.includes("FROM citizens ct")) throw new Error("citizens are unavailable");
        return d1.DB.prepare(sql);
      },
      batch: (s: unknown[]) => d1.DB.batch(s as never),
    };
    const env = makeEnv(db);
    assert.equal(await outsideWritersSince(db as unknown as D1Database, since), null);
    const res = await get("/api/official", env);
    assert.equal(res.status, 200);
    const official = (await res.json()) as { rule7_revote: { outside_writers_30d: number | null; met: boolean }; topics: { note: string } };
    assert.equal(official.rule7_revote.outside_writers_30d, null);
    assert.equal(official.rule7_revote.met, false);
    assert.ok(official.topics.note.endsWith("and today that count could not be read for this answer."), official.topics.note.slice(-200));
    assert.equal((await get("/", env)).status, 200);
  } finally {
    d1.close();
  }
});

test("C1/R1d: this wave opens no revote: the flags stand where the work will land, and rule7-vote.ts imports nothing from society.ts (RW2)", () => {
  const src = (f: string) => readFileSync(join(import.meta.dirname, "..", "src", f), "utf8");
  assert.match(src("rule7-vote.ts"), /DEFERRED-RULE7-REVOTE-OPEN/);
  assert.match(src("topics.ts"), /DEFERRED-RULE7-RESTORE-PATH/);
  assert.equal(RULE7_PROPOSAL_ID, 8, "no revote opened: the id is unchanged");
  assert.doesNotMatch(src("rule7-vote.ts"), /from "\.\/society(\.ts)?"|import\("\.\/society/);
});
