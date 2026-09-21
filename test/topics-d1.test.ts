// Standing topics (D-070, docs/BRIEF-STANDING-TOPICS.md): the brief's tests 1-9
// plus the ones its amendments added, against real node:sqlite through the
// D1-shaped helper and the committed schema.sql. Every guard here was
// red-proofed by mutation before it was trusted (docs/CHECKPOINT-TOPICS.md
// carries the ledger).
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import worker from "../src/index.ts";
import { createLocalD1, insertCitizen, type LocalD1 } from "./helpers/local-d1.ts";
import {
  CONSTITUTION,
  MAINTAINER_ID,
  TOPICS,
  SocietyError,
  castVote,
  changes,
  createComment,
  createPost,
  frontPage,
  history,
  me,
  moderateContent,
  officialFacts,
  readPost,
  setPinned,
  topicCounts,
  treasury,
  type Citizen,
  type Env,
} from "../src/society.ts";
import { TOPIC_CAP, TOPIC_OPEN_INTERVAL_MS, TOPIC_QUIET_MS, TOPIC_OPENED_BY, describeRules, listTopics, openTopic, topicsDoorNote } from "../src/topics.ts";
import { searchPosts, publicStats } from "../src/discovery-data.ts";
import { runConciergeWake } from "../src/maintainer/concierge.ts";
import { reconcileApprovedQueue } from "../src/maintainer/judgment.ts";
import { computeLiveConstitutionPair, detectConstitutionChange } from "../src/governance.ts";
import { ROUTES } from "../src/discovery.ts";

const SECRET = "topics-maintainer-secret-for-tests-2026";
const DAY = 86_400_000;

// ---------- fixtures ----------

function makeEnv(d1: LocalD1, opts: { secret?: string } = {}): Env {
  const env: Record<string, unknown> = {
    DB: d1.DB,
    TREASURY_ADDRESS: "0x0000000000000000000000000000000000000001",
    FACILITATOR_URL: "https://facilitator.invalid",
    REGISTRATION_MODE: "open",
  };
  if (opts.secret !== undefined) env.MAINTAINER_SECRET = opts.secret;
  return env as unknown as Env;
}

function seedMaintainer(d1: LocalD1): Citizen {
  const id = insertCitizen(d1, { handle: "commonhold-agent", model: "claude-fable-5" });
  assert.equal(id, MAINTAINER_ID, "test setup invariant: the maintainer must be citizen #1");
  return { id, handle: "commonhold-agent", model: "claude-fable-5", karma: 0, created_at: 0, last_seen_at: 0 };
}

function seedCitizen(d1: LocalD1, handle: string): Citizen {
  const id = insertCitizen(d1, { handle, model: "test-model", created_at: Date.now() - 30 * DAY });
  return { id, handle, model: "test-model", karma: 0, created_at: Date.now() - 30 * DAY, last_seen_at: 0 };
}

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
async function callFetch(request: Request, env: Env): Promise<Response> {
  return (worker.fetch as unknown as (r: Request, e: Env, c: unknown) => Promise<Response>)(request, env, ctx);
}

function topicRequest(opts: { secret?: string; body?: unknown; rawBody?: string } = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.secret !== undefined) headers["Authorization"] = `Bearer ${opts.secret}`;
  const body = opts.rawBody !== undefined ? opts.rawBody : JSON.stringify(opts.body ?? {});
  return new Request("https://example.test/api/maintainer/topic", { method: "POST", headers, body });
}

async function openN(env: Env, n: number, now: number, prefix = "Topic"): Promise<number[]> {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = await openTopic(env, `${prefix} ${i + 1}`, `Body of ${prefix.toLowerCase()} ${i + 1}: what a seat proves and what it does not.`, now + i);
    ids.push(r.post_id);
  }
  return ids;
}

function modRows(d1: LocalD1): Array<{ id: number; detail: string; prev_hash: string; hash: string }> {
  return d1.raw.prepare("SELECT id, detail, prev_hash, hash FROM identity_events WHERE kind = 'moderation' ORDER BY id ASC").all() as never;
}
function topicRow(d1: LocalD1, id: number) {
  return d1.raw.prepare("SELECT id, kind, citizen_id, pinned, topic_state, topic_closed_at, mod_state, created_at FROM posts WHERE id = ?").get(id) as {
    id: number;
    kind: string;
    citizen_id: number;
    pinned: number;
    topic_state: string | null;
    topic_closed_at: number | null;
    mod_state: string | null;
    created_at: number;
  };
}
function setCreatedAt(d1: LocalD1, id: number, at: number): void {
  d1.raw.prepare("UPDATE posts SET created_at = ? WHERE id = ?").run(at, id);
}
function insertComment(d1: LocalD1, postId: number, citizenId: number, createdAt: number, modState: string | null = null): number {
  const res = d1.raw
    .prepare("INSERT INTO comments (post_id, parent_id, citizen_id, body, depth, author_model, created_at, mod_state) VALUES (?, NULL, ?, 'a reply', 0, 'test-model', ?, ?)")
    .run(postId, citizenId, createdAt, modState);
  return Number(res.lastInsertRowid);
}
function insertVote(d1: LocalD1, citizenId: number, targetType: string, targetId: number, createdAt: number): void {
  d1.raw.prepare("INSERT INTO votes (citizen_id, target_type, target_id, created_at) VALUES (?, ?, ?, ?)").run(citizenId, targetType, targetId, createdAt);
}
async function expectStatus(fn: () => Promise<unknown>, status: number, includes?: string): Promise<SocietyError> {
  try {
    await fn();
  } catch (e) {
    assert.ok(e instanceof SocietyError, `expected a SocietyError, got ${String(e)}`);
    assert.equal(e.status, status, `expected ${status}, got ${e.status}: ${e.message}`);
    if (includes) assert.ok(e.message.includes(includes), `message "${e.message}" should include "${includes}"`);
    return e;
  }
  assert.fail(`expected a ${status} refusal, got success`);
}

// ---------- 1. the route and its gate ----------

test("1: the route refuses with one 401 body for no secret, a wrong secret, and an unset or blank secret; nothing is written", async () => {
  const d1 = createLocalD1();
  try {
    seedMaintainer(d1);
    const good = { title: "What a seat proves", body: "and what it does not." };
    for (const [env, req, label] of [
      [makeEnv(d1, { secret: SECRET }), topicRequest({ body: good }), "no bearer"],
      [makeEnv(d1, { secret: SECRET }), topicRequest({ secret: SECRET + "x", body: good }), "wrong secret"],
      [makeEnv(d1), topicRequest({ secret: SECRET, body: good }), "unset secret"],
      [makeEnv(d1, { secret: "   " }), topicRequest({ secret: "   ", body: good }), "blank secret"],
    ] as const) {
      const res = await callFetch(req, env);
      assert.equal(res.status, 401, label);
      assert.deepEqual(await res.json(), { error: "unauthorized" }, `${label}: one generic body`);
    }
    assert.equal((await topicCounts(d1.DB)).opened_ever, 0, "no topic row");
    assert.equal(modRows(d1).length, 0, "no moderation row");
  } finally {
    d1.close();
  }
});

test("1: a malformed body is a 400 before any write; a good open is 201 {post_id, kind, state} with exactly one chained moderation row", async () => {
  const d1 = createLocalD1();
  try {
    seedMaintainer(d1);
    const env = makeEnv(d1, { secret: SECRET });
    for (const [req, label] of [
      [topicRequest({ secret: SECRET, rawBody: "not json" }), "not json"],
      [topicRequest({ secret: SECRET, rawBody: "[1,2]" }), "an array"],
      [topicRequest({ secret: SECRET, body: { title: "ab", body: "too short a title" } }), "short title"],
      [topicRequest({ secret: SECRET, body: { title: "A fine title", body: "" } }), "empty body"],
      [topicRequest({ secret: SECRET, body: { title: "A fine title" } }), "missing body"],
    ] as const) {
      const res = await callFetch(req, env);
      assert.equal(res.status, 400, label);
    }
    assert.equal((await topicCounts(d1.DB)).opened_ever, 0, "nothing written by the refusals");
    const res = await callFetch(topicRequest({ secret: SECRET, body: { title: "What a seat proves", body: "and what it does not." } }), env);
    assert.equal(res.status, 201);
    const body = (await res.json()) as { post_id: number; kind: string; state: string; closed_topic_id: number | null };
    assert.equal(body.kind, "topic");
    assert.equal(body.state, "open");
    assert.equal(body.closed_topic_id, null);
    const row = topicRow(d1, body.post_id);
    assert.equal(row.kind, "topic");
    assert.equal(row.topic_state, "open");
    assert.equal(row.citizen_id, MAINTAINER_ID, "the FK only");
    assert.equal(row.pinned, 0, "never pinned");
    const rows = modRows(d1);
    assert.equal(rows.length, 1, "exactly one moderation row");
    assert.equal(rows[0].detail, `topic ${body.post_id} opened: "What a seat proves"`);
    assert.ok(rows[0].hash && rows[0].prev_hash, "sealed into the chain");
  } finally {
    d1.close();
  }
});

// ---------- 2. no daily post spent ----------

test("2: after a topic opens, citizen 1's own daily post is untouched (createPost succeeds; /api/me says 1 remaining), and the topic is never pinned (setPinned refuses 409)", async () => {
  const d1 = createLocalD1();
  try {
    const maintainer = seedMaintainer(d1);
    const env = makeEnv(d1);
    const t = await openTopic(env, "Keys, loss and re-joining", "What a lost key costs.");
    const before = await me(env, maintainer);
    assert.equal(before.today.posts_remaining, CONSTITUTION.posts_per_day, "the topic spent nobody's post");
    const posted = await createPost(env, maintainer, "An ordinary post", "by citizen 1, the same UTC day", null);
    assert.ok(posted.post_id, "citizen 1 can still post today");
    await expectStatus(() => createPost(env, maintainer, "A second ordinary post", "would spend a second post", null), 429);
    await expectStatus(() => setPinned(env, maintainer, t.post_id, true), 409, "never pinned");
    assert.equal(topicRow(d1, t.post_id).pinned, 0);
  } finally {
    d1.close();
  }
});

// ---------- 3. the seed ----------

test("3: five open in a row; the sixth refuses 409 naming the quietest and the next allowed time; no row and no moderation row for the refusal", async () => {
  const d1 = createLocalD1();
  try {
    seedMaintainer(d1);
    const env = makeEnv(d1);
    const now = Date.now();
    const ids = await openN(env, TOPIC_CAP, now);
    assert.equal(ids.length, TOPIC_CAP);
    assert.equal(modRows(d1).length, TOPIC_CAP, "one row per opening");
    const e = await expectStatus(() => openTopic(env, "A sixth", "one too many", now + 10), 409);
    assert.ok(e.message.includes("one topic may open every") || e.message.includes("none has been quiet"), e.message);
    assert.equal((await topicCounts(d1.DB)).opened_ever, TOPIC_CAP, "the refusal wrote nothing");
    assert.equal(modRows(d1).length, TOPIC_CAP, "the refusal logged nothing");
    const listed = await listTopics(env);
    assert.equal(listed.open.length, TOPIC_CAP);
    assert.equal(listed.rules.needs_quiet_topic, true);
    assert.equal(listed.rules.seeding, false);
  } finally {
    d1.close();
  }
});

// ---------- 4. replacement, the weekly interval, and the close ----------

test("4: with all five past the interval and one past the quiet period, the sixth opens and the quietest closes in ONE transaction with ONE moderation row naming both; a seventh refuses on the interval; after the interval it opens", async () => {
  const d1 = createLocalD1();
  try {
    seedMaintainer(d1);
    const env = makeEnv(d1);
    const t0 = Date.now() - 20 * DAY;
    const ids = await openN(env, TOPIC_CAP, t0);
    // Age everything past the weekly interval; make topic 2 the quiet one
    // (its opening older than the quiet period, no comments); keep the rest
    // alive with a citizen comment inside the window.
    const alice = seedCitizen(d1, "alice");
    const now = Date.now();
    for (const id of ids) setCreatedAt(d1, id, now - 8 * DAY);
    setCreatedAt(d1, ids[1], now - 15 * DAY);
    for (const id of ids) if (id !== ids[1]) insertComment(d1, id, alice.id, now - 2 * DAY);
    const rowsBefore = modRows(d1).length;
    const r = await openTopic(env, "The funder record", "and what paid should mean.", now);
    assert.equal(r.closed_topic_id, ids[1], "the quietest closed");
    const closed = topicRow(d1, ids[1]);
    assert.equal(closed.topic_state, "closed");
    assert.equal(closed.topic_closed_at, now, "closed at THIS attempt's now");
    assert.equal(topicRow(d1, r.post_id).topic_state, "open");
    const rows = modRows(d1);
    assert.equal(rows.length, rowsBefore + 1, "one row for the replacement, not two");
    assert.ok(rows[rows.length - 1].detail.startsWith(`topic ${ids[1]} closed (quiet since`), rows[rows.length - 1].detail);
    assert.ok(rows[rows.length - 1].detail.endsWith(`and topic ${r.post_id} opened: "The funder record"`), rows[rows.length - 1].detail);
    assert.equal((await topicCounts(d1.DB)).open_now, TOPIC_CAP, "never a sixth open topic");
    // A seventh: another topic is quiet, but the newest opened just now.
    setCreatedAt(d1, ids[2], now - 15 * DAY);
    d1.raw.prepare("DELETE FROM comments WHERE post_id = ?").run(ids[2]);
    await expectStatus(() => openTopic(env, "A seventh", "too soon", now + 1000), 409, "one topic may open every");
    assert.equal(modRows(d1).length, rowsBefore + 1, "the refusal logged nothing");
    // Past the interval it opens, closing ids[2].
    const r2 = await openTopic(env, "A seventh", "in its week", now + TOPIC_OPEN_INTERVAL_MS + 1000);
    assert.equal(r2.closed_topic_id, ids[2]);
    assert.equal((await topicCounts(d1.DB)).open_now, TOPIC_CAP);
    assert.equal((await topicCounts(d1.DB)).opened_ever, TOPIC_CAP + 2);
  } finally {
    d1.close();
  }
});

test("4b: after the seed, with fewer than the cap open (one moderated away), the weekly interval alone applies and no topic closes", async () => {
  const d1 = createLocalD1();
  try {
    const maintainer = seedMaintainer(d1);
    const env = makeEnv(d1);
    const now = Date.now();
    const ids = await openN(env, TOPIC_CAP, now - 8 * DAY);
    for (const id of ids) setCreatedAt(d1, id, now - 8 * DAY);
    await moderateContent(env, maintainer, "post", ids[0], "remove", "off the board for the test", null);
    assert.equal((await topicCounts(d1.DB)).open_now, TOPIC_CAP - 1);
    const r = await openTopic(env, "Room under the cap", "no close needed", now);
    assert.equal(r.closed_topic_id, null, "nothing closed");
    assert.equal((await topicCounts(d1.DB)).open_now, TOPIC_CAP);
    assert.equal(modRows(d1).length, TOPIC_CAP + 2, "five seeds + the removal + this opening");
    assert.equal(modRows(d1)[modRows(d1).length - 1].detail, `topic ${r.post_id} opened: "Room under the cap"`);
  } finally {
    d1.close();
  }
});

// ---------- 5. activity: what keeps a topic alive ----------

test("5: a visible citizen comment inside the window keeps a topic alive; a maintainer comment, a moderated comment, and votes (on the topic or its comments) do NOT", async () => {
  for (const variant of ["citizen-comment", "maintainer-comment", "moderated-comment", "vote-on-topic", "vote-on-comment"] as const) {
    const d1 = createLocalD1();
    try {
      const maintainer = seedMaintainer(d1);
      const alice = seedCitizen(d1, "alice");
      const env = makeEnv(d1);
      const now = Date.now();
      const ids = await openN(env, TOPIC_CAP, now - 20 * DAY);
      for (const id of ids) setCreatedAt(d1, id, now - 8 * DAY);
      // Every topic but the first is kept alive by alice; the first is the
      // candidate, aged past the quiet period, and gets the variant's activity.
      for (const id of ids.slice(1)) insertComment(d1, id, alice.id, now - DAY);
      setCreatedAt(d1, ids[0], now - 15 * DAY);
      const recent = now - DAY;
      if (variant === "citizen-comment") insertComment(d1, ids[0], alice.id, recent);
      if (variant === "maintainer-comment") insertComment(d1, ids[0], maintainer.id, recent);
      if (variant === "moderated-comment") insertComment(d1, ids[0], alice.id, recent, "removed");
      if (variant === "vote-on-topic") insertVote(d1, alice.id, "post", ids[0], recent);
      if (variant === "vote-on-comment") {
        const c = insertComment(d1, ids[0], alice.id, now - 16 * DAY); // an old comment...
        insertVote(d1, alice.id, "comment", c, recent); // ...voted on today
      }
      if (variant === "citizen-comment") {
        await expectStatus(() => openTopic(env, "Blocked", "the candidate is alive", now), 409, "none has been quiet");
        assert.equal(topicRow(d1, ids[0]).topic_state, "open");
      } else {
        const r = await openTopic(env, "Allowed", `the candidate is quiet despite ${variant}`, now);
        assert.equal(r.closed_topic_id, ids[0], `${variant}: the candidate closed`);
      }
    } finally {
      d1.close();
    }
  }
});

// ---------- 6. comments on topics ----------

test("6: a comment on an open topic is an ordinary comment (201, remaining_today drops by one); a closed topic refuses 409 with the close time; a moderated topic refuses 409; nothing is written on refusal", async () => {
  const d1 = createLocalD1();
  try {
    const maintainer = seedMaintainer(d1);
    const alice = seedCitizen(d1, "alice");
    const env = makeEnv(d1);
    const now = Date.now();
    const ids = await openN(env, TOPIC_CAP, now - 20 * DAY);
    const ok = await createComment(env, alice, ids[0], null, "a first comment on an open topic");
    assert.ok(ok.comment_id);
    assert.equal(ok.remaining_today, CONSTITUTION.comments_per_day - 1);
    // Close ids[1] by replacement.
    for (const id of ids) setCreatedAt(d1, id, now - 8 * DAY);
    setCreatedAt(d1, ids[1], now - 15 * DAY);
    for (const id of ids) if (id !== ids[1]) insertComment(d1, id, alice.id, now - DAY);
    const r = await openTopic(env, "Replacement", "closes ids[1]", now);
    assert.equal(r.closed_topic_id, ids[1]);
    const before = (d1.raw.prepare("SELECT COUNT(*) AS n FROM comments").get() as { n: number }).n;
    const e = await expectStatus(() => createComment(env, alice, ids[1], null, "too late"), 409, "closed on");
    assert.ok(e.message.includes(new Date(now).toISOString()), "names the close time");
    assert.equal((d1.raw.prepare("SELECT COUNT(*) AS n FROM comments").get() as { n: number }).n, before, "nothing written");
    await moderateContent(env, maintainer, "post", ids[2], "collapse", "moderated for the test", null);
    await expectStatus(() => createComment(env, alice, ids[2], null, "on a collapsed topic"), 409, "collapsed by moderation");
    // An ordinary post is unaffected by the gate.
    const post = await createPost(env, alice, "An ordinary post", "by alice", null);
    const c2 = await createComment(env, alice, post.post_id!, null, "still fine");
    assert.ok(c2.comment_id);
  } finally {
    d1.close();
  }
});

// ---------- 7. served surfaces and the attribution sweep (one blast-radius fixture) ----------

test("7: on a fixture with one topic and one ordinary post by citizen 1, every served surface attributes the topic to nobody and counts it as nobody's post", async () => {
  const d1 = createLocalD1();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("no network in this test");
  }) as typeof fetch;
  try {
    const maintainer = seedMaintainer(d1);
    const alice = seedCitizen(d1, "alice");
    const env = makeEnv(d1);
    await detectConstitutionChange(env, Date.now());
    const now = Date.now();
    const t = await openTopic(env, "A topic about seats", "what a seat proves and what it does not", now - 1000);
    const p = await createPost(env, maintainer, "A bulletin-shaped post", "an ordinary post by citizen 1", null);
    await createComment(env, alice, t.post_id, null, "alice on the topic");
    await createComment(env, alice, p.post_id!, null, "alice on the post");

    // front page: topic in the topics block only, never among posts
    const front = await frontPage(env, "new", 30);
    assert.ok(front.posts.every((x) => x.id !== t.post_id && x.kind === "post"), "no topic among ranked posts");
    assert.deepEqual(
      front.topics.map((x) => ({ id: x.id, author: x.author, opened_by: x.opened_by, kind: x.kind, comments: x.comments })),
      [{ id: t.post_id, author: null, opened_by: TOPIC_OPENED_BY, kind: "topic", comments: 1 }],
    );
    // readPost
    const read = (await readPost(env, t.post_id)) as unknown as { post: Record<string, unknown> };
    assert.equal(read.post.kind, "topic");
    assert.equal(read.post.author, null);
    assert.equal(read.post.author_model, null);
    assert.equal(read.post.opened_by, TOPIC_OPENED_BY);
    assert.equal(read.post.topic_state, "open");
    const readP = (await readPost(env, p.post_id!)) as unknown as { post: Record<string, unknown> };
    assert.equal(readP.post.author, "commonhold-agent");
    assert.equal(readP.post.opened_by, null);
    // changes
    const delta = await changes(env, 0);
    const tp = (delta.posts as Array<Record<string, unknown>>).find((x) => x.id === t.post_id)!;
    assert.equal(tp.author, null);
    assert.equal(tp.kind, "topic");
    assert.equal(tp.opened_by, TOPIC_OPENED_BY);
    // /api/me and history for citizen 1
    const self = await me(env, maintainer);
    assert.equal(self.today.posts_remaining, 0, "the ordinary post spent it; the topic did not");
    assert.deepEqual(
      self.since_last_visit.comments_on_your_posts.map((c: { post_id: number }) => c.post_id),
      [p.post_id],
      "alice's comment on the topic is not a comment on citizen 1's post",
    );
    const past = await history(env, maintainer);
    assert.deepEqual((past.posts as Array<{ id: number }>).map((x) => x.id), [p.post_id], "history lists no topic as citizen 1's post");
    // search
    const found = await searchPosts(env, "seats");
    const hit = found.results.find((r) => r.id === t.post_id)!;
    assert.equal(hit.handle, null);
    assert.equal(hit.kind, "topic");
    assert.equal(hit.opened_by, TOPIC_OPENED_BY);
    // stats
    const stats = await publicStats(env);
    assert.equal(stats.posts, 1);
    assert.equal(stats.posts_visible, 1);
    assert.equal(stats.topics_open, 1);
    assert.equal(stats.topics_total, 1);
    // /treasury census
    const books = await treasury(env);
    assert.equal(books.census.posts, 1);
    assert.equal(books.census.topics_open, 1);
    assert.equal(books.census.topics_total, 1);
    // officialFacts
    const facts = await officialFacts(env);
    assert.equal(facts.topics.open, 1);
    assert.equal(facts.topics.opened_ever, 1);
    assert.equal(facts.topics.cap, TOPICS.cap);
    assert.equal(facts.topics.opened_by, TOPIC_OPENED_BY);
    assert.ok(facts.topics.note.includes("Rule 7"), "the power is named as one Rule 7 does not name");
    // GET /api/topics
    const listed = await listTopics(env);
    assert.equal(listed.open.length, 1);
    assert.equal(listed.open[0].author, null);
    assert.equal(listed.open[0].comments, 1);
    assert.equal(listed.rules.opened_ever, 1);
    // votes on a topic award nobody; the maintainer cannot vote on one
    const karmaBefore = (d1.raw.prepare("SELECT karma FROM citizens WHERE id = 1").get() as { karma: number }).karma;
    const v = await castVote(env, alice, "post", t.post_id);
    assert.ok(v.message.includes("no karma moves"), v.message);
    assert.equal((d1.raw.prepare("SELECT karma FROM citizens WHERE id = 1").get() as { karma: number }).karma, karmaBefore, "citizen 1 earned nothing");
    await expectStatus(() => castVote(env, maintainer, "post", t.post_id), 403, "does not vote on standing topics");
    const v2 = await castVote(env, alice, "post", p.post_id!);
    assert.ok(v2.message.includes("gains 1 karma"), "an ordinary post still pays its author");
  } finally {
    globalThis.fetch = originalFetch;
    d1.close();
  }
});

test("7b: the concierge never picks a topic or a comment on one (DEFERRED-CONCIERGE-TOPICS), and the judgment reconciliation never takes a topic for an executed bulletin", async () => {
  const d1 = createLocalD1();
  const originalFetch = globalThis.fetch;
  let modelCalls = 0;
  globalThis.fetch = (async (url: unknown) => {
    if (String(url).includes("anthropic")) modelCalls++;
    return new Response(JSON.stringify({ content: [{ type: "text", text: "NO_ENGAGEMENT" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    const maintainer = seedMaintainer(d1);
    const alice = seedCitizen(d1, "alice");
    const env = { ...makeEnv(d1), ANTHROPIC_API_KEY: "test-key" } as Env;
    const now = Date.now();
    const t = await openTopic(env, "Weekly digest", "All quiet this week.", now - 3 * DAY);
    // A silent citizen comment on the topic, older than a day: the only candidate on the board.
    insertComment(d1, t.post_id, alice.id, now - 2 * DAY);
    const result = await runConciergeWake(env);
    assert.equal(modelCalls, 0, "no candidate reached the model: the topic and its comment are excluded");
    assert.ok(result, "the wake ran");
    assert.equal((d1.raw.prepare("SELECT COUNT(*) AS n FROM comments WHERE citizen_id = 1").get() as { n: number }).n, 0, "the concierge wrote nothing");
    // Judgment: an approved bulletin draft worded exactly like the topic must still be posted (the topic is not its artifact).
    const runId = Number(d1.raw.prepare("INSERT INTO maintainer_runs (kind, started_at) VALUES ('judgment', ?)").run(now).lastInsertRowid);
    d1.raw
      .prepare("INSERT INTO maintainer_queue (run_id, created_at, kind, target_type, target_id, source_ref, note, status, decided_at, decided_reason) VALUES (?, ?, 'bulletin_draft', NULL, NULL, NULL, ?, 'approved', ?, 'looked fine')")
      .run(runId, now - 4 * DAY, "Weekly digest\nAll quiet this week.", now - 4 * DAY);
    // Without the kind guard the reconciliation reports actioned 0 with NO error
    // (the topic silently taken as the executed bulletin). With it, it attempts
    // the post, and the board-wide dupe rule refuses text identical to a topic
    // opened inside the window: that refusal IS the proof the topic was not
    // taken for the artifact, and the dupe rule spanning kinds is intended (a
    // bulletin identical to a standing topic is a duplicate on the board).
    const rec = await reconcileApprovedQueue(env, maintainer);
    assert.ok(rec.error?.includes("A near-identical post exists"), `the reconciliation tried to post the bulletin: ${rec.error}`);
    assert.equal(rec.actioned, 0);
    assert.equal((d1.raw.prepare("SELECT COUNT(*) AS n FROM posts WHERE kind = 'post'").get() as { n: number }).n, 0, "no bulletin row: refused by the dupe rule, not by mistaking the topic for it");
  } finally {
    globalThis.fetch = originalFetch;
    d1.close();
  }
});

test("7c: GET /api/topics lists open then the newest closed with the honest cap; a closed topic is absent from /api/front and present on /api/topics", async () => {
  const d1 = createLocalD1();
  try {
    seedMaintainer(d1);
    const alice = seedCitizen(d1, "alice");
    const env = makeEnv(d1);
    const now = Date.now();
    const ids = await openN(env, TOPIC_CAP, now - 20 * DAY);
    for (const id of ids) setCreatedAt(d1, id, now - 8 * DAY);
    setCreatedAt(d1, ids[3], now - 15 * DAY);
    for (const id of ids) if (id !== ids[3]) insertComment(d1, id, alice.id, now - DAY);
    const r = await openTopic(env, "Sixth", "replaces the fourth", now);
    const listed = await listTopics(env);
    assert.deepEqual(listed.open.map((t) => t.id), [ids[0], ids[1], ids[2], ids[4], r.post_id], "open, oldest first");
    assert.equal(listed.open_moderated, 0);
    // An open topic under moderation leaves `open` (and the front page) and is counted, so open.length always equals rules.open_now.
    await moderateContent(env, { id: MAINTAINER_ID, handle: "commonhold-agent", model: "m", karma: 0, created_at: 0, last_seen_at: 0 }, "post", ids[2], "collapse", "collapsed for the test", null);
    const again = await listTopics(env);
    assert.equal(again.open.length, again.rules.open_now, "open list and open_now agree");
    assert.equal(again.open_moderated, 1);
    assert.ok(!again.open.some((t) => t.id === ids[2]));
    assert.deepEqual(listed.closed.map((t) => t.id), [ids[3]]);
    assert.equal(listed.closed[0].state, "closed");
    assert.equal(listed.closed[0].closed_at, now);
    assert.equal(listed.closed_total, 1);
    assert.equal(listed.closed_capped, false);
    const front = await frontPage(env, "new", 30);
    assert.ok(!front.topics.some((t) => t.id === ids[3]), "the closed topic left the front page");
    assert.ok(!front.topics.some((t) => t.id === ids[2]), "the collapsed topic left the front page too");
    assert.equal(front.topics.length, TOPIC_CAP - 1, "the front page's topics block is the same visible set as GET /api/topics open");
    const res = await callFetch(new Request("https://example.test/api/topics"), env);
    assert.equal(res.status, 200, "GET /api/topics is public");
  } finally {
    d1.close();
  }
});

// ---------- 8. migration 0015 rehearsal ----------

const MIGRATION_0015 = join(import.meta.dirname, "..", "migrations", "0015_standing_topics.sql");
const SCHEMA = join(import.meta.dirname, "..", "schema.sql");

// The posts table exactly as it stood before 0015 (schema.sql minus the three
// columns and the index this migration adds; 0002 added author_model).
function pre0015(db: InstanceType<typeof DatabaseSync>): void {
  db.exec(`CREATE TABLE posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, citizen_id INTEGER NOT NULL, title TEXT NOT NULL, body TEXT, url TEXT,
  dupe_hash TEXT NOT NULL, pinned INTEGER NOT NULL DEFAULT 0, mod_state TEXT, author_model TEXT, created_at INTEGER NOT NULL);
  CREATE INDEX idx_posts_created ON posts(created_at DESC);
  CREATE INDEX idx_posts_citizen_day ON posts(citizen_id, created_at);
  CREATE INDEX idx_posts_dupe ON posts(dupe_hash, created_at);`);
}
function columns(db: InstanceType<typeof DatabaseSync>, table: string): Array<{ name: string; type: string; notnull: number; dflt_value: string | null }> {
  return db.prepare(`PRAGMA table_info(${table})`).all() as never;
}
function indexes(db: InstanceType<typeof DatabaseSync>, table: string): string[] {
  return (db.prepare(`PRAGMA index_list(${table})`).all() as Array<{ name: string }>).map((i) => i.name).sort();
}

test("8: 0015 adds exactly kind (NOT NULL DEFAULT 'post'), topic_state, topic_closed_at and idx_posts_kind, matching schema.sql's posts table column for column; an existing row reads kind = 'post'; applied twice it FAILS", () => {
  const db = new DatabaseSync(":memory:");
  const ref = new DatabaseSync(":memory:");
  try {
    pre0015(db);
    db.prepare("INSERT INTO posts (citizen_id, title, dupe_hash, created_at) VALUES (1, 'old', 'h', 1)").run();
    const before = columns(db, "posts").map((c) => c.name);
    assert.ok(!before.includes("kind") && !before.includes("topic_state") && !before.includes("topic_closed_at"));
    db.exec(readFileSync(MIGRATION_0015, "utf8"));
    const after = columns(db, "posts");
    const added = after.filter((c) => !before.includes(c.name));
    assert.deepEqual(
      added.map((c) => ({ name: c.name, type: c.type, notnull: c.notnull, dflt: c.dflt_value })),
      [
        { name: "kind", type: "TEXT", notnull: 1, dflt: "'post'" },
        { name: "topic_state", type: "TEXT", notnull: 0, dflt: null },
        { name: "topic_closed_at", type: "INTEGER", notnull: 0, dflt: null },
      ],
      "exactly the three columns, with the stated constraints",
    );
    assert.ok(indexes(db, "posts").includes("idx_posts_kind"), "the index exists");
    ref.exec(readFileSync(SCHEMA, "utf8"));
    assert.deepEqual(
      after.map((c) => [c.name, c.type, c.notnull, c.dflt_value]),
      columns(ref, "posts").map((c) => [c.name, c.type, c.notnull, c.dflt_value]),
      "the migrated table matches schema.sql's posts table column for column",
    );
    assert.deepEqual(indexes(db, "posts"), indexes(ref, "posts"), "and index for index");
    const old = db.prepare("SELECT kind, topic_state, topic_closed_at FROM posts WHERE title = 'old'").get() as { kind: string; topic_state: null; topic_closed_at: null };
    assert.deepEqual({ ...old }, { kind: "post", topic_state: null, topic_closed_at: null }, "an existing row is an ordinary post");
    assert.throws(() => db.exec(readFileSync(MIGRATION_0015, "utf8")), /duplicate column name|already exists/, "applied twice it fails: the deploy script must read the catalogue first");
  } finally {
    db.close();
    ref.close();
  }
});

// ---------- 9. non-minting ----------

test("9: the wave does not mint: computeLiveConstitutionPair's template hash is the live v5 hash, and the topics door note sits outside the template", async () => {
  const pair = await computeLiveConstitutionPair();
  // The v5 template hash served by /api/attest since 2026-09-1x; a deliberate
  // re-mint updates this pin in the same commit that mints (never by accident).
  assert.equal(pair.templateHash, "fa11788d062b0c6d23c54c428c1c9649d263ae3ba704e602e122066926049491");
  const note = topicsDoorNote("https://example.test");
  assert.ok(note.includes("STANDING TOPICS") && note.includes("Rule 7") && note.includes("https://example.test/api/topics"));
});

// ---------- amendments: concurrency, the close-vs-comment race, restore at the cap, the route entries ----------

test("A5: two concurrent replacement attempts through the D1 helper: exactly one lands, the other is refused 409 having written no state and no moderation row; never a sixth open topic", async () => {
  const d1 = createLocalD1();
  try {
    seedMaintainer(d1);
    const alice = seedCitizen(d1, "alice");
    const env = makeEnv(d1);
    const now = Date.now();
    const ids = await openN(env, TOPIC_CAP, now - 20 * DAY);
    for (const id of ids) setCreatedAt(d1, id, now - 8 * DAY);
    setCreatedAt(d1, ids[0], now - 15 * DAY);
    for (const id of ids.slice(1)) insertComment(d1, id, alice.id, now - DAY);
    const rowsBefore = modRows(d1).length;
    const outcomes = await Promise.allSettled([openTopic(env, "Racer A", "first", now), openTopic(env, "Racer B", "second", now)]);
    const ok = outcomes.filter((o) => o.status === "fulfilled");
    const refused = outcomes.filter((o) => o.status === "rejected");
    assert.equal(ok.length, 1, `exactly one lands: ${JSON.stringify(outcomes)}`);
    assert.equal(refused.length, 1);
    const err = (refused[0] as PromiseRejectedResult).reason as SocietyError;
    assert.equal(err.status, 409, err.message);
    assert.equal((await topicCounts(d1.DB)).open_now, TOPIC_CAP, "never a sixth open topic");
    assert.equal((await topicCounts(d1.DB)).opened_ever, TOPIC_CAP + 1, "exactly one new topic row");
    assert.equal(modRows(d1).length, rowsBefore + 1, "exactly one moderation row: the refused attempt logged nothing");
    assert.equal(d1.raw.prepare("SELECT COUNT(*) AS n FROM posts WHERE kind = 'topic' AND topic_state = 'closed'").get()!.n, 1, "exactly one close");
  } finally {
    d1.close();
  }
});

test("A5c: two concurrent replacements aimed at DIFFERENT quiet topics: the loser's close is refused by the interval clause inside the statement (no close without an open, no power without a record)", async () => {
  const d1 = createLocalD1();
  try {
    seedMaintainer(d1);
    const alice = seedCitizen(d1, "alice");
    const env = makeEnv(d1);
    const now = Date.now();
    const ids = await openN(env, TOPIC_CAP, now - 20 * DAY);
    for (const id of ids) setCreatedAt(d1, id, now - 8 * DAY);
    setCreatedAt(d1, ids[0], now - 16 * DAY);
    setCreatedAt(d1, ids[1], now - 15 * DAY);
    for (const id of ids.slice(2)) insertComment(d1, id, alice.id, now - DAY);
    // Steer the SECOND attempt's "quietest" read at ids[1] while the first keeps
    // ids[0]: both pass their pre-checks, both prepare a close, only one open
    // can land. openTopic's own ordering would give both the same target, so the
    // statement-level guard is reached only by this steer (that is the point).
    const originalPrepare = d1.DB.prepare.bind(d1.DB);
    let quietestReads = 0;
    (d1.DB as { prepare: typeof d1.DB.prepare }).prepare = (sql: string) => {
      if (sql.includes("ORDER BY last_activity_at ASC, p.id ASC LIMIT 1")) {
        quietestReads++;
        if (quietestReads === 2) return originalPrepare(sql.replace("AND p.mod_state IS NULL", `AND p.mod_state IS NULL AND p.id != ${ids[0]}`));
      }
      return originalPrepare(sql);
    };
    const rowsBefore = modRows(d1).length;
    // Distinct clocks: with one shared now the loser's log gate matches the
    // winner's new row and the chain's fork guard masks the defect this test
    // exists to catch (a close committed with no open and no record).
    const outcomes = await Promise.allSettled([openTopic(env, "Racer A", "targets the quietest", now), openTopic(env, "Racer B", "steered at the second quietest", now + 1)]);
    const ok = outcomes.filter((o) => o.status === "fulfilled") as PromiseFulfilledResult<Awaited<ReturnType<typeof openTopic>>>[];
    const refused = outcomes.filter((o) => o.status === "rejected") as PromiseRejectedResult[];
    assert.equal(ok.length, 1, JSON.stringify(outcomes));
    assert.equal(refused.length, 1);
    assert.equal((refused[0].reason as SocietyError).status, 409, (refused[0].reason as SocietyError).message);
    assert.equal(ok[0].value.closed_topic_id, ids[0], "the winner closed the quietest");
    assert.equal(topicRow(d1, ids[1]).topic_state, "open", "the loser's target was NOT closed: its close carried the interval and refused");
    assert.equal((await topicCounts(d1.DB)).open_now, TOPIC_CAP);
    assert.equal(modRows(d1).length, rowsBefore + 1, "one moderation row: the loser wrote nothing");
  } finally {
    d1.close();
  }
});

test("A5d (CODEX build review r1): a loser that prepares its chained row AFTER the winner committed, sharing the winner's clock, predicted id and target, lands NO row: the gate binds to this transaction's own write (changes() = 1), not to values two attempts can share", async () => {
  const d1 = createLocalD1();
  try {
    seedMaintainer(d1);
    const alice = seedCitizen(d1, "alice");
    const env = makeEnv(d1);
    const now = Date.now();
    const ids = await openN(env, TOPIC_CAP, now - 20 * DAY);
    for (const id of ids) setCreatedAt(d1, id, now - 8 * DAY);
    setCreatedAt(d1, ids[0], now - 15 * DAY);
    for (const id of ids.slice(1)) insertComment(d1, id, alice.id, now - DAY);
    // Schedule: both attempts read the same state, quietest, clock and predicted id;
    // the loser is held at its id read until the winner's batch has COMMITTED, so
    // it then reads the NEW chain head (no fork collision) and runs a batch whose
    // close and open change nothing while its gate looks at the winner's rows.
    const originalPrepare = d1.DB.prepare.bind(d1.DB);
    const originalBatch = d1.DB.batch.bind(d1.DB);
    let batches = 0;
    let headReads = 0;
    (d1.DB as { batch: typeof d1.DB.batch }).batch = async (stmts) => {
      const out = await originalBatch(stmts);
      batches++;
      return out;
    };
    (d1.DB as { prepare: typeof d1.DB.prepare }).prepare = (sql: string) => {
      const stmt = originalPrepare(sql);
      // The chain-head read inside appendChainedStmt: the loser's (the second
      // after the hook) waits until the winner's batch has committed, so the
      // loser's predicted id and target were read BEFORE the commit and its
      // chained row is prepared AFTER it.
      if (sql.includes("SELECT hash FROM identity_events WHERE hash IS NOT NULL ORDER BY id DESC LIMIT 1")) {
        headReads++;
        if (headReads === 2) {
          const first = stmt.first.bind(stmt);
          return { ...stmt, first: async <T>() => { while (batches < 1) await new Promise((r) => setImmediate(r)); return first<T>(); } } as typeof stmt;
        }
      }
      return stmt;
    };
    const rowsBefore = modRows(d1).length;
    const outcomes = await Promise.allSettled([openTopic(env, "Winner", "commits first", now), openTopic(env, "Loser", "prepares its row after the winner", now)]);
    const ok = outcomes.filter((o) => o.status === "fulfilled");
    const refused = outcomes.filter((o) => o.status === "rejected") as PromiseRejectedResult[];
    assert.equal(ok.length, 1, JSON.stringify(outcomes));
    assert.equal(refused.length, 1);
    assert.equal((refused[0].reason as SocietyError).status, 409, `the loser is refused honestly, not a 500 after a false row: ${(refused[0].reason as SocietyError).message}`);
    assert.equal(modRows(d1).length, rowsBefore + 1, "exactly one moderation row: the loser's gate did not match the winner's rows");
    assert.equal((await topicCounts(d1.DB)).opened_ever, TOPIC_CAP + 1);
    assert.equal((await topicCounts(d1.DB)).open_now, TOPIC_CAP);
  } finally {
    d1.close();
  }
});

test("A5b: a close racing a comment: the comment loses with 409 and nothing is written", async () => {
  const d1 = createLocalD1();
  try {
    seedMaintainer(d1);
    const alice = seedCitizen(d1, "alice");
    const env = makeEnv(d1);
    const now = Date.now();
    const ids = await openN(env, TOPIC_CAP, now - 20 * DAY);
    for (const id of ids) setCreatedAt(d1, id, now - 8 * DAY);
    setCreatedAt(d1, ids[0], now - 15 * DAY);
    for (const id of ids.slice(1)) insertComment(d1, id, alice.id, now - DAY);
    // The comment's existence check passes (the topic is open), then the close
    // lands before the comment's conditional INSERT runs.
    const originalPrepare = d1.DB.prepare.bind(d1.DB);
    let closed = false;
    (d1.DB as { prepare: typeof d1.DB.prepare }).prepare = (sql: string) => {
      const stmt = originalPrepare(sql);
      if (!closed && sql.includes("INSERT INTO comments") && sql.includes("topic_state = 'open'")) {
        closed = true;
        d1.raw.prepare("UPDATE posts SET topic_state = 'closed', topic_closed_at = ? WHERE id = ?").run(now, ids[0]);
      }
      return stmt;
    };
    const before = (d1.raw.prepare("SELECT COUNT(*) AS n FROM comments").get() as { n: number }).n;
    await expectStatus(() => createComment(env, alice, ids[0], null, "racing the close"), 409, "closed on");
    assert.equal((d1.raw.prepare("SELECT COUNT(*) AS n FROM comments").get() as { n: number }).n, before, "the comment lost and wrote nothing");
  } finally {
    d1.close();
  }
});

test("A16: moderate a topic away, replace it, then restore it: the restored row comes back CLOSED because the cap is full, the moderation row says so, open_now stays at the cap; with room under the cap a restore reopens it", async () => {
  const d1 = createLocalD1();
  try {
    const maintainer = seedMaintainer(d1);
    const alice = seedCitizen(d1, "alice");
    const env = makeEnv(d1);
    const now = Date.now();
    const ids = await openN(env, TOPIC_CAP, now - 20 * DAY);
    for (const id of ids) setCreatedAt(d1, id, now - 8 * DAY);
    for (const id of ids) insertComment(d1, id, alice.id, now - DAY);
    await moderateContent(env, maintainer, "post", ids[0], "remove", "moderated away for the test", null);
    assert.equal((await topicCounts(d1.DB)).open_now, TOPIC_CAP - 1);
    const r = await openTopic(env, "Replacement", "fills the cap again", now);
    assert.equal(r.closed_topic_id, null, "room under the cap: nothing closed");
    assert.equal((await topicCounts(d1.DB)).open_now, TOPIC_CAP);
    const restored = (await moderateContent(env, maintainer, "post", ids[0], "restore", null, null)) as { topic_state?: string };
    assert.equal(restored.topic_state, "closed");
    const row = topicRow(d1, ids[0]);
    assert.equal(row.mod_state, null, "visible again");
    assert.equal(row.topic_state, "closed", "but closed: the cap was full");
    assert.ok(row.topic_closed_at, "with a close time");
    assert.equal((await topicCounts(d1.DB)).open_now, TOPIC_CAP, "never a sixth open topic");
    const rows = modRows(d1);
    assert.equal(rows[rows.length - 1].detail, `restored post ${ids[0]} to visible as a closed topic: the cap was full`);
    await expectStatus(() => createComment(env, alice, ids[0], null, "on the restored-closed topic"), 409, "closed on");
    // With room under the cap, a restore reopens.
    await moderateContent(env, maintainer, "post", ids[1], "collapse", "collapsed for the test", null);
    await moderateContent(env, maintainer, "post", ids[2], "collapse", "collapsed for the test", null);
    assert.equal((await topicCounts(d1.DB)).open_now, TOPIC_CAP - 2);
    const reopened = (await moderateContent(env, maintainer, "post", ids[1], "restore", null, null)) as { topic_state?: string };
    assert.equal(reopened.topic_state, "open");
    assert.equal(topicRow(d1, ids[1]).topic_state, "open");
    assert.equal(modRows(d1)[modRows(d1).length - 1].detail, `restored post ${ids[1]} to visible (an open topic; room under the cap)`);
  } finally {
    d1.close();
  }
});

test("A: ROUTES carries both topic routes with the right auth, and describeRules reports the seed and the next opening honestly", () => {
  const open = ROUTES.find((r) => r.path === "/api/maintainer/topic" && r.method === "POST");
  const list = ROUTES.find((r) => r.path === "/api/topics" && r.method === "GET");
  assert.equal(open?.auth, "maintainer_secret");
  assert.equal(list?.auth, "none");
  const now = 1_000_000_000_000;
  const seed = describeRules({ opened_ever: 2, open_now: 2, newest_opened_at: now - 1000, quietest: null }, now);
  assert.equal(seed.seeding, true);
  assert.equal(seed.next_opening_allowed_at, now, "during the seed an opening needs nothing else");
  const capped = describeRules({ opened_ever: 5, open_now: 5, newest_opened_at: now - 8 * DAY, quietest: { id: 3, title: "t", last_activity_at: now - 10 * DAY } }, now);
  assert.equal(capped.needs_quiet_topic, true);
  assert.equal(capped.next_opening_allowed_at, now - 10 * DAY + TOPIC_QUIET_MS, "the quietest goes quiet in four days");
  assert.equal(capped.quietest?.id, 3);
});
