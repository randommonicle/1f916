// GET /api/inbox (D-072 direction 1, docs/BRIEF-HEARTBEAT-INBOX.md, amendments A1-A20),
// against real node:sqlite through the D1-shaped helper and the committed schema.sql.
// Brief tests 1-13; every guard was red-proofed by mutation before it was trusted
// (docs/CHECKPOINT-HEARTBEAT-INBOX.md carries the ledger).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createLocalD1, insertCitizen, insertIdentityEvent, insertProposal, type LocalD1 } from "./helpers/local-d1.ts";
import { type Env } from "../src/society.ts";
import { castBallot, buildConstitutionTemplate } from "../src/governance.ts";
import { CONSTITUTION, TOPICS, changes } from "../src/society.ts";
import { sha256Hex } from "../src/chain.ts";
import { ROUTES, renderOpenApi, AUTH_LABEL } from "../src/discovery.ts";
import worker from "../src/index.ts";
import { handleMcp } from "../src/mcp.ts";
import { handleMcpRead } from "../src/mcp-read.ts";
import { inbox, mentionsHandle, renderHeartbeatMd, renderSkillMd, heartbeatDoorNote, SKILL_VERSION, slugify, postsSql, ballotsSql, type HeartbeatSkillFacts } from "../src/inbox.ts";
import { REGISTRATION_PRICE_CENTS } from "../src/register-gate.ts";
import {
  GUEST_ADMISSION_SENTENCE,
  GUEST_AIM_SENTENCE,
  GUEST_ANSWERS_SENTENCE,
  GUEST_CONTINUITY_SENTENCE,
  GUEST_DUTIES_PER_DAY,
  GUEST_DUTY_MIN_ANSWER_LEN,
  GUEST_REFUSED_STEMS,
  guestCapsSentence,
  guestTemplateExceptions,
} from "../src/guest-core.ts";

const DAY = 86_400_000;
const TEST_ORIGIN = "https://commonhold.example.invalid";
// Fixed placeholders for tests that render served text directly (not through a route,
// so the real ballot-route note / AUTH_LABEL text is not in scope) -- distinct strings
// so a bug swapping one for the other would be visible in a failing assertion, not silent.
const TEST_BALLOT_NOTE = "TEST_BALLOT_NOTE_PLACEHOLDER";
const TEST_AUTH_LABEL = "TEST_AUTH_LABEL_PLACEHOLDER";

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
async function callFetch(request: Request, env: Env): Promise<Response> {
  return (worker.fetch as unknown as (r: Request, e: Env, c: unknown) => Promise<Response>)(request, env, ctx);
}

function makeEnv(d1: LocalD1, overrides: Partial<{ registrationMode: string }> = {}): Env {
  return {
    DB: d1.DB,
    TREASURY_ADDRESS: "0x0000000000000000000000000000000000000001",
    FACILITATOR_URL: "https://facilitator.invalid",
    REGISTRATION_MODE: overrides.registrationMode ?? "invite_only",
  } as unknown as Env;
}

// ---------- fixtures (mirrors topics-d1.test.ts's own local, freestanding helpers) ----------

function insertPost(
  d1: LocalD1,
  overrides: Partial<{
    citizen_id: number;
    title: string;
    body: string | null;
    mod_state: string | null;
    created_at: number;
    kind: string;
    topic_state: string | null;
    topic_closed_at: number | null;
  }> = {},
): number {
  const now = overrides.created_at ?? Date.now();
  const result = d1.raw
    .prepare(
      "INSERT INTO posts (citizen_id, title, body, dupe_hash, pinned, mod_state, author_model, created_at, kind, topic_state, topic_closed_at) VALUES (?, ?, ?, ?, 0, ?, 'test-model', ?, ?, ?, ?)",
    )
    .run(
      overrides.citizen_id ?? insertCitizen(d1),
      overrides.title ?? "a post",
      overrides.body ?? "body",
      `dupe-${Math.random().toString(36).slice(2)}`,
      overrides.mod_state ?? null,
      now,
      overrides.kind ?? "post",
      overrides.topic_state ?? null,
      overrides.topic_closed_at ?? null,
    );
  return Number(result.lastInsertRowid);
}

function insertComment(
  d1: LocalD1,
  overrides: Partial<{ post_id: number; parent_id: number | null; citizen_id: number; body: string; mod_state: string | null; created_at: number }> = {},
): number {
  const now = overrides.created_at ?? Date.now();
  const result = d1.raw
    .prepare("INSERT INTO comments (post_id, parent_id, citizen_id, body, depth, mod_state, author_model, created_at) VALUES (?, ?, ?, ?, 0, ?, 'test-model', ?)")
    .run(overrides.post_id!, overrides.parent_id ?? null, overrides.citizen_id!, overrides.body ?? "a comment", overrides.mod_state ?? null, now);
  return Number(result.lastInsertRowid);
}

function setCommentCreatedAt(d1: LocalD1, id: number, at: number): void {
  d1.raw.prepare("UPDATE comments SET created_at = ? WHERE id = ?").run(at, id);
}
function setCommentModState(d1: LocalD1, id: number, state: string | null): void {
  d1.raw.prepare("UPDATE comments SET mod_state = ? WHERE id = ?").run(state, id);
}
function citizenHandle(d1: LocalD1, id: number): string {
  return (d1.raw.prepare("SELECT handle FROM citizens WHERE id = ?").get(id) as { handle: string }).handle;
}

async function expectStatus(fn: () => Promise<unknown>, status: number, includes?: string): Promise<void> {
  try {
    await fn();
  } catch (e) {
    const err = e as { status?: number; message: string };
    assert.equal(err.status, status, `expected ${status}, got ${err.status}: ${err.message}`);
    if (includes) assert.ok(err.message.includes(includes), `message "${err.message}" should include "${includes}"`);
    return;
  }
  assert.fail(`expected a ${status} refusal, got success`);
}

// ---------- helper sanity: the local-d1.ts batch() extension itself can fail ----------

test("helper sanity: env.DB.batch() returns .results for a SELECT statement, not just .meta (test/helpers/local-d1.ts's own extension)", async () => {
  const d1 = createLocalD1();
  try {
    const results = await d1.DB.batch([d1.DB.prepare("SELECT 1 AS x"), d1.DB.prepare("SELECT 2 AS y")]);
    const first = results[0] as unknown as { results: Array<{ x: number }> };
    const second = results[1] as unknown as { results: Array<{ y: number }> };
    assert.equal(first.results.length, 1);
    assert.equal(first.results[0]!.x, 1);
    assert.equal(second.results.length, 1);
    assert.equal(second.results[0]!.y, 2);
  } finally {
    d1.close();
  }
});

// F7 (exchange/REVIEW_inbox-core-build-2026-09-26.md): real D1's batch<T>() gives every
// entry `success: true`, and a write's `results` is `[]`, never absent; a CTE (leading
// WITH) is a read too, not routed through .run().
test("F7: batch() carries success: true on every entry, results: [] on a write (never absent), and recognises a leading WITH as a read", async () => {
  const d1 = createLocalD1();
  try {
    const citizenId = insertCitizen(d1, { handle: "batchcheck" });
    const results = await d1.DB.batch([
      d1.DB.prepare("INSERT INTO reg_log (ip_hash, created_at) VALUES ('x', 1)"),
      d1.DB.prepare("WITH one AS (SELECT 1 AS x) SELECT x FROM one"),
    ]);
    const write = results[0] as unknown as { success: boolean; results: unknown[]; meta: { changes: number } };
    const withRead = results[1] as unknown as { success: boolean; results: Array<{ x: number }> };
    assert.equal(write.success, true, "a write must carry success: true, matching real D1");
    assert.deepEqual(write.results, [], "a write's results must be [] (present, not absent), matching real D1");
    assert.equal(write.meta.changes, 1);
    assert.equal(withRead.success, true);
    assert.equal(withRead.results.length, 1, "a leading WITH must be treated as a read, not routed through .run()");
    assert.equal(withRead.results[0]!.x, 1);
    assert.ok(citizenId > 0);
  } finally {
    d1.close();
  }
});

// ---------- 1. validation and 404 (D2, A1) ----------

test("1: 400 for a missing/malformed handle, missing/non-numeric/negative/fractional since, both since and cursor, neither, and a malformed cursor; 404 for an unknown handle", async () => {
  const d1 = createLocalD1();
  try {
    insertCitizen(d1, { handle: "az" });
    const env = makeEnv(d1);
    await expectStatus(() => inbox(env, undefined, "0", null), 400);
    await expectStatus(() => inbox(env, "x", "0", null), 400); // too short
    await expectStatus(() => inbox(env, "az", null, null), 400, "exactly one of");
    await expectStatus(() => inbox(env, "az", "0", "c1-p1"), 400, "exactly one of");
    await expectStatus(() => inbox(env, "az", "abc", null), 400);
    await expectStatus(() => inbox(env, "az", "-5", null), 400);
    await expectStatus(() => inbox(env, "az", "1.5", null), 400);
    await expectStatus(() => inbox(env, "az", null, "not-a-cursor"), 400, "cursor must look like");
    await expectStatus(() => inbox(env, "az", null, "c1-1"), 400, "cursor must look like");
    await expectStatus(() => inbox(env, "nobody-here", "0", null), 404);
  } finally {
    d1.close();
  }
});

// F1 (gate review): one test per rule, each red-proofed separately (see the ledger).

test("F1 rule 1 (presence): an EMPTY value still counts as present -- ?since=&cursor=c0-p0 and ?since=0&cursor= are both 400 'exactly one of', never silently routed to the other branch", async () => {
  const d1 = createLocalD1();
  try {
    insertCitizen(d1, { handle: "az" });
    const env = makeEnv(d1);
    await expectStatus(() => inbox(env, "az", "", "c0-p0"), 400, "exactly one of");
    await expectStatus(() => inbox(env, "az", "0", ""), 400, "exactly one of");
  } finally {
    d1.close();
  }
});

test("F1 rule 2 (since shape): whitespace-only, a leading sign, a decimal point or an exponent are all 400, never silently coerced by Number()", async () => {
  const d1 = createLocalD1();
  try {
    insertCitizen(d1, { handle: "az" });
    const env = makeEnv(d1);
    for (const bad of ["   ", "+5", "5.0", "5e2", " 5", "5 "]) {
      await expectStatus(() => inbox(env, "az", bad, null), 400, "digits only");
    }
    // Control: a genuinely valid since still passes, so the rule above is not vacuous.
    const res = await inbox(env, "az", "0", null);
    assert.equal(res.handle, "az");
  } finally {
    d1.close();
  }
});

test("F1 rule 3 (since magnitude): a digits-only since too large to represent exactly as a safe integer is 400", async () => {
  const d1 = createLocalD1();
  try {
    insertCitizen(d1, { handle: "az" });
    const env = makeEnv(d1);
    await expectStatus(() => inbox(env, "az", "99999999999999999999999", null), 400, "digits only");
  } finally {
    d1.close();
  }
});

test("F1 rule 4 (cursor magnitude): a cursor whose comment id or post id parses to an unsafe integer is 400, never served back mangled in next_cursor", async () => {
  const d1 = createLocalD1();
  try {
    insertCitizen(d1, { handle: "az" });
    const env = makeEnv(d1);
    await expectStatus(() => inbox(env, "az", null, "c1000000000000000000000-p0"), 400, "safe integer");
    await expectStatus(() => inbox(env, "az", null, "c0-p1000000000000000000000"), 400, "safe integer");
  } finally {
    d1.close();
  }
});

test("A13: handle=COMMONHOLD-AGENT (uppercase) still resolves and the response carries the stored handle's canonical case", async () => {
  const d1 = createLocalD1();
  try {
    insertCitizen(d1, { handle: "commonhold-agent" });
    const env = makeEnv(d1);
    const res = await inbox(env, "COMMONHOLD-AGENT", "0", null);
    assert.equal(res.handle, "commonhold-agent");
  } finally {
    d1.close();
  }
});

// ---------- 2. replies (D3) ----------

test("2: B's reply to A's comment is listed for A; A's reply to A's own comment is not listed", async () => {
  const d1 = createLocalD1();
  try {
    const a = insertCitizen(d1, { handle: "az" });
    const b = insertCitizen(d1, { handle: "bz" });
    const post = insertPost(d1, { citizen_id: b });
    const aComment = insertComment(d1, { post_id: post, citizen_id: a, body: "a's own comment" });
    const bReply = insertComment(d1, { post_id: post, parent_id: aComment, citizen_id: b, body: "b replies to a" });
    // A's own reply to A's own comment must never appear (self-reply).
    insertComment(d1, { post_id: post, parent_id: aComment, citizen_id: a, body: "a replies to a" });

    const env = makeEnv(d1);
    const res = await inbox(env, "az", "0", null);
    assert.deepEqual(
      (res.replies as Array<{ id: number }>).map((r) => r.id),
      [bReply],
      "only b's reply, never a's self-reply",
    );
  } finally {
    d1.close();
  }
});

// F5 (gate review, GEMINI): a reply before the window (since) is not listed.
test("F5: a reply created BEFORE since is not listed; a reply at or after since is", async () => {
  const d1 = createLocalD1();
  try {
    const a = insertCitizen(d1, { handle: "az" });
    const b = insertCitizen(d1, { handle: "bz" });
    const post = insertPost(d1, { citizen_id: b, created_at: 1000 });
    const aComment = insertComment(d1, { post_id: post, citizen_id: a, body: "a's own comment", created_at: 1000 });
    // Before the window: created_at 1000, well before the since threshold below.
    const early = insertComment(d1, { post_id: post, parent_id: aComment, citizen_id: b, body: "too early", created_at: 1000 });
    // In the window: created_at 5000, at/after the since threshold.
    const late = insertComment(d1, { post_id: post, parent_id: aComment, citizen_id: b, body: "in the window", created_at: 5000 });

    const env = makeEnv(d1);
    const res = await inbox(env, "az", "3000", null);
    const replyIds = (res.replies as Array<{ id: number }>).map((r) => r.id);
    assert.ok(!replyIds.includes(early), "a reply before since must not be listed");
    assert.ok(replyIds.includes(late), "a reply at/after since must be listed");
  } finally {
    d1.close();
  }
});

// ---------- 3. comments_on_your_posts (D3, A4) ----------

test("3: B's top-level and nested comments on A's post are listed; for the maintainer (citizen 1), a comment on a TOPIC is not listed here (mutation: drop kind = 'post' -> red)", async () => {
  const d1 = createLocalD1();
  try {
    const maintainer = insertCitizen(d1, { handle: "commonhold-agent" });
    const b = insertCitizen(d1, { handle: "bz" });
    const post = insertPost(d1, { citizen_id: maintainer, kind: "post" });
    const topLevel = insertComment(d1, { post_id: post, citizen_id: b, body: "top level on the post" });
    const nestedParent = insertComment(d1, { post_id: post, citizen_id: b, body: "parent" });
    const nested = insertComment(d1, { post_id: post, parent_id: nestedParent, citizen_id: b, body: "nested on the post" });
    const topic = insertPost(d1, { citizen_id: maintainer, kind: "topic", topic_state: "open" });
    const onTopic = insertComment(d1, { post_id: topic, citizen_id: b, body: "on a topic, not a post" });

    const env = makeEnv(d1);
    const res = await inbox(env, "commonhold-agent", "0", null);
    const ids = (res.comments_on_your_posts as Array<{ id: number }>).map((r) => r.id).sort((x, y) => x - y);
    assert.deepEqual(ids, [topLevel, nestedParent, nested].sort((x, y) => x - y));
    assert.ok(!ids.includes(onTopic), "a comment on a topic must not appear here");
  } finally {
    d1.close();
  }
});

// F5 (gate review, GEMINI): D3 defines comments_on_your_posts as comments by OTHERS --
// A's own top-level comment on A's own post must be excluded, not just B's comments
// included. Every prior fixture only ever tested inclusion of someone else's comment.
test("F5: A's own comment on A's own post is NOT in comments_on_your_posts (self-exclusion, not just B's inclusion)", async () => {
  const d1 = createLocalD1();
  try {
    const a = insertCitizen(d1, { handle: "az" });
    const b = insertCitizen(d1, { handle: "bz" });
    const post = insertPost(d1, { citizen_id: a, kind: "post" });
    const ownComment = insertComment(d1, { post_id: post, citizen_id: a, body: "a commenting on a's own post" });
    const othersComment = insertComment(d1, { post_id: post, citizen_id: b, body: "b commenting on a's post" });

    const env = makeEnv(d1);
    const res = await inbox(env, "az", "0", null);
    const ids = (res.comments_on_your_posts as Array<{ id: number }>).map((r) => r.id);
    assert.ok(!ids.includes(ownComment), "A's own comment on A's own post must not appear");
    assert.ok(ids.includes(othersComment), "control: B's comment on the same post must still appear");
  } finally {
    d1.close();
  }
});

// ---------- 4. mentions (D3, A3, A4, A5) ----------

test("4: @az matched (case-insensitive, punctuation after); a longer handle sharing the prefix (@azley, @az-reader) and x@az not matched; self-mention not listed; a moderated mention not listed; a title mention is listed; an item already in replies is not repeated here", async () => {
  const d1 = createLocalD1();
  try {
    const a = insertCitizen(d1, { handle: "az" });
    const b = insertCitizen(d1, { handle: "bz" });
    const post = insertPost(d1, { citizen_id: b });

    const hitLower = insertComment(d1, { post_id: post, citizen_id: b, body: "hello @az, welcome" });
    const hitUpper = insertComment(d1, { post_id: post, citizen_id: b, body: "HELLO @AZ" });
    const hitPunct = insertComment(d1, { post_id: post, citizen_id: b, body: "cc @az, please read" });
    const notLonger = insertComment(d1, { post_id: post, citizen_id: b, body: "not @azley at all" });
    const notHyphen = insertComment(d1, { post_id: post, citizen_id: b, body: "not @az-reader either" });
    const notPrefixed = insertComment(d1, { post_id: post, citizen_id: b, body: "not x@az either" });
    const selfMention = insertComment(d1, { post_id: post, citizen_id: a, body: "@az talking to myself" });
    const moderated = insertComment(d1, { post_id: post, citizen_id: b, body: "@az but removed", mod_state: "removed" });
    const titleHit = insertPost(d1, { citizen_id: b, title: "a note for @az", body: "no mention in the body" });

    // An item already classified as a reply (A's own comment, replied to by B) must not
    // ALSO appear in mentions even though the reply body mentions @az.
    const aOwn = insertComment(d1, { post_id: post, citizen_id: a, body: "a's own comment" });
    const replyAndMention = insertComment(d1, { post_id: post, parent_id: aOwn, citizen_id: b, body: "@az replying to you" });

    // Unit check on the boundary rule directly, independent of the DB.
    assert.equal(mentionsHandle("@azley hello", "az"), false, "a longer handle sharing a prefix must not match");
    assert.equal(mentionsHandle("@az-reader hello", "az"), false, "a hyphen-suffixed longer handle must not match either");

    const env = makeEnv(d1);
    const resA = await inbox(env, "az", "0", null);
    // comments and posts are independent AUTOINCREMENT sequences (schema.sql), so a bare
    // numeric id can collide across the two tables -- every check below is scoped by kind
    // as well as id, never id alone.
    const mentions = resA.mentions as Array<{ id: number; kind: "comment" | "post" }>;
    const commentMentionIds = mentions.filter((m) => m.kind === "comment").map((m) => m.id);
    const postMentionIds = mentions.filter((m) => m.kind === "post").map((m) => m.id);
    assert.ok(commentMentionIds.includes(hitLower), "@az matched");
    assert.ok(commentMentionIds.includes(hitUpper), "@AZ matched (case-insensitive)");
    assert.ok(commentMentionIds.includes(hitPunct), "@az, matched (punctuation boundary)");
    assert.ok(!commentMentionIds.includes(notLonger), "@azley must not match handle az");
    assert.ok(!commentMentionIds.includes(notHyphen), "@az-reader must not match handle az");
    assert.ok(!commentMentionIds.includes(notPrefixed), "x@az must not match handle az");
    assert.ok(!commentMentionIds.includes(selfMention), "az's own mention of itself must not notify");
    assert.ok(!commentMentionIds.includes(moderated), "a moderated mention must not be listed");
    assert.ok(postMentionIds.includes(titleHit), "a title-only mention counts (A3)");
    assert.ok(!commentMentionIds.includes(replyAndMention), "already listed in replies -- not repeated in mentions");
    assert.ok(
      (resA.replies as Array<{ id: number }>).map((r) => r.id).includes(replyAndMention),
      "the reply+mention item is listed exactly once, in replies",
    );

    const moderatedPost = insertPost(d1, { citizen_id: b, title: "@az but removed", mod_state: "removed" });
    const resA2 = await inbox(env, "az", "0", null);
    const postMentionIds2 = (resA2.mentions as Array<{ id: number; kind: string }>).filter((m) => m.kind === "post").map((m) => m.id);
    assert.ok(!postMentionIds2.includes(moderatedPost), "a moderated POST mention must not be listed either");
  } finally {
    d1.close();
  }
});

// F4 (gate review, GEMINI): every post-mention fixture above put the mention in the
// TITLE with a non-matching body; a body-only post mention, and a body-only topic
// mention, were never tested -- if mentionsHandle(row.body, ...) was dropped for either
// candidate kind, the suite would have stayed green.
test("F4: a post with the mention ONLY in its body (non-matching title) is listed in mentions; a topic with the mention ONLY in its body sets mentions_you", async () => {
  const d1 = createLocalD1();
  try {
    const maintainer = insertCitizen(d1, { handle: "commonhold-agent" });
    insertCitizen(d1, { handle: "az" });
    const b = insertCitizen(d1, { handle: "bz" });
    const bodyHitPost = insertPost(d1, { citizen_id: b, title: "an ordinary title", body: "a note for @az in the body" });
    const bodyHitTopic = insertPost(d1, { citizen_id: maintainer, kind: "topic", topic_state: "open", title: "an ordinary title", body: "mentions @az in the body" });

    const env = makeEnv(d1);
    const res = await inbox(env, "az", "0", null);
    const postMentionIds = (res.mentions as Array<{ id: number; kind: string }>).filter((m) => m.kind === "post").map((m) => m.id);
    assert.ok(postMentionIds.includes(bodyHitPost), "a body-only post mention must be listed");
    const topic = (res.topics_opened as Array<{ id: number; mentions_you: boolean }>).find((t) => t.id === bodyHitTopic);
    assert.ok(topic, "the topic is listed");
    assert.equal(topic!.mentions_you, true, "a body-only topic mention must set mentions_you");
  } finally {
    d1.close();
  }
});

// F4: underscore is a valid handle character (society.ts:470, /^[a-z0-9_-]{2,32}$/i), so
// it is IN the boundary character class -- a neighbour on either side must refuse the
// match, the same way a hyphen-suffixed longer handle already does.
test("F4: an underscore neighbour on either side refuses the match (@az_x and x_@az are not mentions of az)", async () => {
  assert.equal(mentionsHandle("hello @az_x there", "az"), false, "an underscore AFTER the handle must not match");
  assert.equal(mentionsHandle("hello x_@az there", "az"), false, "an underscore BEFORE the handle must not match");
  // Control: the identical text with the underscore removed does match, so the two
  // checks above measure the boundary rule, not a dead matcher.
  assert.equal(mentionsHandle("hello @az x there", "az"), true, "control: the same text without the underscore must match");
  assert.equal(mentionsHandle("hello x @az there", "az"), true, "control: the same text without the underscore must match");
});

test("A13: a comment on the recipient's own post that ALSO mentions it is listed once, in comments_on_your_posts", async () => {
  const d1 = createLocalD1();
  try {
    const a = insertCitizen(d1, { handle: "az" });
    const b = insertCitizen(d1, { handle: "bz" });
    const post = insertPost(d1, { citizen_id: a, kind: "post" });
    const item = insertComment(d1, { post_id: post, citizen_id: b, body: "@az nice post" });

    const env = makeEnv(d1);
    const res = await inbox(env, "az", "0", null);
    assert.deepEqual((res.comments_on_your_posts as Array<{ id: number }>).map((r) => r.id), [item]);
    assert.deepEqual(res.mentions, [], "not repeated in mentions");
  } finally {
    d1.close();
  }
});

test("A13: a moderated reply stays in replies with its body redacted (applyModState), never silently dropped", async () => {
  const d1 = createLocalD1();
  try {
    const a = insertCitizen(d1, { handle: "az" });
    const b = insertCitizen(d1, { handle: "bz" });
    const post = insertPost(d1, { citizen_id: b });
    const aComment = insertComment(d1, { post_id: post, citizen_id: a, body: "a's comment" });
    const reply = insertComment(d1, { post_id: post, parent_id: aComment, citizen_id: b, body: "a reply", mod_state: "removed" });

    const env = makeEnv(d1);
    const res = await inbox(env, "az", "0", null);
    const row = (res.replies as Array<{ id: number; body: string; mod_state: string | null }>).find((r) => r.id === reply);
    assert.ok(row, "the moderated reply is still present");
    assert.equal(row!.mod_state, "removed");
    assert.match(row!.body, /removed by the maintainer/);
  } finally {
    d1.close();
  }
});

// ---------- 5. ballots parity (D3, A6) ----------

test("5: ballots parity against a real castBallot -- eligible/reason match a real throw/pass, balloted flips after a real cast (409 on a second cast), a closed-window and a null-post_id proposal are absent", async () => {
  const d1 = createLocalD1();
  try {
    const NOW = Date.now();
    const founderOld = insertCitizen(d1, { handle: "founder-old", created_at: NOW - 60 * DAY });
    insertIdentityEvent(d1, founderOld, "invite_redeemed");
    const nonfounderOld = insertCitizen(d1, { handle: "nonfounder-old", created_at: NOW - 60 * DAY });
    const nonfounderNew = insertCitizen(d1, { handle: "nonfounder-new", created_at: NOW - 1 * DAY });

    // P1: entrenched, FOUNDING-GATED (first_laws_ratify). Frozen registration_mode='open'
    // (the live env below is 'invite_only' -- deliberately different) and frozen
    // founding_ratified=1 (the live DB has no first_laws_ratified setting at all, so a
    // live re-check would read false). opened 30 days ago, closes in 5.
    const p1 = insertProposal(d1, {
      kind: "first_laws_ratify",
      registration_mode: "open",
      founding_ratified: true,
      opened_at: NOW - 30 * DAY,
      closes_at: NOW + 5 * DAY,
      status: "open",
    });
    // P2: advisory, NOT founding-gated. Frozen registration_mode='invite_only' (the live
    // env below is 'open' -- the other direction).
    const p2 = insertProposal(d1, {
      kind: "resolution",
      registration_mode: "invite_only",
      founding_ratified: false,
      opened_at: NOW - 30 * DAY,
      closes_at: NOW + 5 * DAY,
      status: "open",
    });
    // A closed-window proposal (status still 'open' but its window has passed) and a
    // post_id IS NULL proposal: both must be absent from ballots entirely.
    insertProposal(d1, { kind: "resolution", opened_at: NOW - 30 * DAY, closes_at: NOW - 1 * DAY, status: "open" });
    insertProposal(d1, { kind: "resolution", opened_at: NOW - 30 * DAY, closes_at: NOW + 5 * DAY, status: "open", post_id: null });

    const envInvite = makeEnv(d1, { registrationMode: "invite_only" }); // differs from p1's frozen 'open'
    const envOpen = makeEnv(d1, { registrationMode: "open" }); // differs from p2's frozen 'invite_only'

    async function realCastThrows(env2: Env, citizen: { id: number; created_at: number }, proposalId: number): Promise<{ threw: boolean; status?: number; message?: string }> {
      try {
        await castBallot(env2, citizen, proposalId, "yes", null);
        return { threw: false };
      } catch (e) {
        const err = e as { status: number; message: string };
        return { threw: true, status: err.status, message: err.message };
      }
    }

    const founderOldC = { id: founderOld, created_at: NOW - 60 * DAY };
    const nonfounderOldC = { id: nonfounderOld, created_at: NOW - 60 * DAY };
    const nonfounderNewC = { id: nonfounderNew, created_at: NOW - 1 * DAY };

    for (const [label, citizen, env2] of [
      ["founder_old", founderOldC, envInvite],
      ["nonfounder_old", nonfounderOldC, envInvite],
      ["nonfounder_new", nonfounderNewC, envInvite],
    ] as const) {
      const res = await inbox(env2, citizenHandle(d1, citizen.id), "0", null);
      const ballotP1 = (res.ballots as Array<{ proposal_id: number; eligible: boolean; reason: string | null }>).find((b) => b.proposal_id === p1);
      assert.ok(ballotP1, `${label}: p1 must be present`);
      const real = await realCastThrows(env2, citizen, p1);
      if (real.threw) {
        assert.equal(ballotP1!.eligible, false, `${label}: p1 eligible must be false to match the real 403 (${real.message})`);
        assert.equal(ballotP1!.reason, real.message, `${label}: p1 reason must equal the real thrown message`);
      } else {
        assert.equal(ballotP1!.eligible, true, `${label}: p1 eligible must be true to match the real pass`);
      }
    }

    // The two closed/null-post proposals are absent no matter who asks.
    const anyRes = await inbox(envInvite, "founder-old", "0", null);
    const proposalIds = (anyRes.ballots as Array<{ proposal_id: number }>).map((b) => b.proposal_id);
    assert.ok(proposalIds.includes(p1) && proposalIds.includes(p2));
    assert.equal(proposalIds.length, 2, "the closed-window and post_id-null proposals are absent");

    // balloted flips after a real cast, and ballots_owed excludes it; a second real cast throws 409.
    const before = await inbox(envOpen, "nonfounder-old", "0", null);
    const p2Before = (before.ballots as Array<{ proposal_id: number; balloted: boolean; eligible: boolean }>).find((b) => b.proposal_id === p2)!;
    assert.equal(p2Before.balloted, false);
    assert.equal(p2Before.eligible, true, "p2 is invite_only-frozen: tenure is waived for everyone, including nonfounder_old");
    assert.equal(before.ballots_owed, 1, "p2 is eligible and not yet balloted");
    await castBallot(envOpen, nonfounderOldC, p2, "yes", null);
    const after = await inbox(envOpen, "nonfounder-old", "0", null);
    const p2After = (after.ballots as Array<{ proposal_id: number; balloted: boolean }>).find((b) => b.proposal_id === p2)!;
    assert.equal(p2After.balloted, true);
    assert.equal(after.ballots_owed, 0, "p2 no longer owed once balloted");
    await expectStatus(() => castBallot(envOpen, nonfounderOldC, p2, "yes", null), 409);
  } finally {
    d1.close();
  }
});

// F3 (gate review, GEMINI): the parity table above compared only ONE of its two seeded
// proposals against a real castBallot, seeded only advisory and entrenched, tested no
// tenure boundary, and never tested a founding-gated kind with founding_ratified FALSE.
// This test compares EVERY (citizen, proposal) pair -- one kind per vote class, citizens
// one day either side of the 7- and 14-day tenure thresholds measured from each
// proposal's own opened_at, and a founder against the founding-gated kind while
// founding_ratified is false.
test("F3: a full ballots parity matrix -- all four vote classes, tenure boundaries either side of the 7- and 14-day thresholds, and a founding-gated kind with founding_ratified false, every pair compared against a real castBallot", async () => {
  const d1 = createLocalD1();
  try {
    const NOW = Date.now();
    const OPENED = NOW - 30 * DAY;
    const CLOSES = NOW + 5 * DAY;

    // One kind per class (governance.ts KIND_CLASS); all frozen registration_mode='open'
    // while the live env below is 'invite_only' -- diverging for every proposal, so a
    // mutation reading env instead of the row breaks the whole matrix, not one cell.
    const proposals: Record<string, number> = {
      advisory: insertProposal(d1, { kind: "resolution", registration_mode: "open", founding_ratified: false, opened_at: OPENED, closes_at: CLOSES, status: "open" }),
      parameter: insertProposal(d1, { kind: "set_dividend_uplift", registration_mode: "open", founding_ratified: false, opened_at: OPENED, closes_at: CLOSES, status: "open" }),
      constitutional: insertProposal(d1, { kind: "text_amendment", registration_mode: "open", founding_ratified: false, opened_at: OPENED, closes_at: CLOSES, status: "open" }),
      // FOUNDING-GATED, founding_ratified FALSE: a non-founder is refused regardless of
      // tenure; a founder is exempt from the gate (but still needs its own tenure).
      entrenched: insertProposal(d1, { kind: "first_laws_ratify", registration_mode: "open", founding_ratified: false, opened_at: OPENED, closes_at: CLOSES, status: "open" }),
    };

    const citizens: Record<string, { id: number; created_at: number; handle: string }> = {};
    function makeCitizen(label: string, createdAt: number, founder = false): void {
      const handle = `matrix-${label}`;
      const id = insertCitizen(d1, { handle, created_at: createdAt });
      if (founder) insertIdentityEvent(d1, id, "invite_redeemed");
      citizens[label] = { id, created_at: createdAt, handle };
    }
    // 7-day threshold (advisory, parameter): one day either side.
    makeCitizen("c7-under", OPENED - 6 * DAY);
    makeCitizen("c7-over", OPENED - 8 * DAY);
    // 14-day threshold (constitutional, entrenched): one day either side.
    makeCitizen("c14-under", OPENED - 13 * DAY);
    makeCitizen("c14-over", OPENED - 15 * DAY);
    // A founder, old enough to clear every threshold, to prove the founding-gate exemption.
    makeCitizen("founder", OPENED - 15 * DAY, true);

    const env = makeEnv(d1, { registrationMode: "invite_only" });

    async function realCastThrows(citizen: { id: number; created_at: number }, proposalId: number): Promise<{ threw: boolean; status?: number; message?: string }> {
      try {
        await castBallot(env, citizen, proposalId, "yes", null);
        return { threw: false };
      } catch (e) {
        const err = e as { status: number; message: string };
        return { threw: true, status: err.status, message: err.message };
      }
    }

    const eligible: Array<{ c: string; p: string }> = [];
    for (const [citizenLabel, citizen] of Object.entries(citizens)) {
      const res = await inbox(env, citizen.handle, "0", null);
      const ballots = res.ballots as Array<{ proposal_id: number; eligible: boolean; reason: string | null }>;
      for (const [proposalLabel, proposalId] of Object.entries(proposals)) {
        const ballot = ballots.find((b) => b.proposal_id === proposalId);
        assert.ok(ballot, `${citizenLabel}/${proposalLabel}: must be present`);
        const real = await realCastThrows(citizen, proposalId);
        if (real.threw) {
          assert.equal(ballot!.eligible, false, `${citizenLabel}/${proposalLabel}: eligible must be false to match the real ${real.status} (${real.message})`);
          assert.equal(ballot!.reason, real.message, `${citizenLabel}/${proposalLabel}: reason must equal the real thrown message`);
        } else {
          assert.equal(ballot!.eligible, true, `${citizenLabel}/${proposalLabel}: eligible must be true to match the real pass`);
          eligible.push({ c: citizenLabel, p: proposalLabel });
        }
      }
    }

    // The matrix is not vacuously green: both outcomes actually occurred.
    const total = Object.keys(citizens).length * Object.keys(proposals).length;
    assert.ok(eligible.length > 0 && eligible.length < total, `expected a genuine mix of eligible/ineligible pairs, got ${eligible.length}/${total} eligible`);
    const has = (c: string, p: string) => eligible.some((x) => x.c === c && x.p === p);
    assert.equal(has("c7-under", "advisory"), false, "6 days is under the 7-day advisory threshold");
    assert.equal(has("c7-over", "advisory"), true, "8 days clears the 7-day advisory threshold");
    assert.equal(has("c7-under", "parameter"), false, "6 days is under the 7-day parameter threshold");
    assert.equal(has("c7-over", "parameter"), true, "8 days clears the 7-day parameter threshold");
    assert.equal(has("c14-under", "constitutional"), false, "13 days is under the 14-day constitutional threshold");
    assert.equal(has("c14-over", "constitutional"), true, "15 days clears the 14-day constitutional threshold");
    assert.equal(has("c14-under", "entrenched"), false, "a non-founder is refused on a founding-gated kind with founding_ratified false, regardless of tenure");
    assert.equal(has("c14-over", "entrenched"), false, "same: tenure does not rescue a non-founder from the founding gate");
    assert.equal(has("founder", "entrenched"), true, "a founder is exempt from the founding gate even with founding_ratified false");
    assert.equal(has("founder", "constitutional"), true, "the founder's own 15-day tenure also clears every threshold");

    // balloted flips after the real casts the loop above already made, and a real second
    // cast on the same pair throws 409.
    const afterFounder = await inbox(env, "matrix-founder", "0", null);
    const founderEntrenched = (afterFounder.ballots as Array<{ proposal_id: number; balloted: boolean }>).find((b) => b.proposal_id === proposals.entrenched)!;
    assert.equal(founderEntrenched.balloted, true, "the founder's real cast above must be reflected as balloted");
    await expectStatus(() => castBallot(env, citizens["founder"]!, proposals.entrenched!, "yes", null), 409);
  } finally {
    d1.close();
  }
});

// ---------- D-018 gate conditions C2 (M2/L4): two properties no test pinned ----------

// M2 (D-018 gate): no test distinguished "this citizen balloted" from "someone balloted",
// the field a seat reads to know whether it owes a vote. Code is correct today
// (WHERE citizen_id = ?, this citizen's own row); mutant MG8 (WHERE citizen_id = ? OR 1,
// i.e. balloted true once ANY citizen has cast) left the full suite green -- this pins the
// per-citizen property directly, on the current (post-R2) query shape.
test("C2/MG8 (D-018 gate): balloted is per citizen -- after A's real cast on P, an eligible B still reads balloted: false and P still counts in B's ballots_owed", async () => {
  const d1 = createLocalD1();
  try {
    const NOW = Date.now();
    const a = insertCitizen(d1, { handle: "gate-a", created_at: NOW - 30 * DAY });
    insertCitizen(d1, { handle: "gate-b", created_at: NOW - 30 * DAY });
    const p = insertProposal(d1, { kind: "resolution", registration_mode: "open", founding_ratified: false, opened_at: NOW - 10 * DAY, closes_at: NOW + 5 * DAY, status: "open" });
    const env = makeEnv(d1, { registrationMode: "open" });

    await castBallot(env, { id: a, created_at: NOW - 30 * DAY }, p, "yes", null);

    const resB = await inbox(env, "gate-b", "0", null);
    const ballotP = (resB.ballots as Array<{ proposal_id: number; balloted: boolean; eligible: boolean }>).find((x) => x.proposal_id === p)!;
    assert.equal(ballotP.balloted, false, "B never cast a ballot on P -- balloted must be false, never A's");
    assert.equal(ballotP.eligible, true, "sanity: B must actually be eligible for the assertion above to mean anything");
    assert.equal(resB.ballots_owed, 1, "P must still count toward B's ballots_owed");
  } finally {
    d1.close();
  }
});

// L4 (D-018 gate): the note claims inbox() "writes nothing to the society's database",
// checked so far only by reading every statement inbox() calls and confirming each is a
// SELECT -- true, but unpinned. Mutant MG1 (an UPDATE inside inbox()) left the full suite
// green: nothing pinned the claim. This asserts it directly against the raw connection's
// own total_changes() counter (d1.raw and d1.DB share the same underlying DatabaseSync
// connection, test/helpers/local-d1.ts's own createLocalD1, so a write through env.DB is
// visible here).
test("C2/MG1 (D-018 gate): inbox() changes nothing in the database -- total_changes() on the raw connection is unchanged across a call", async () => {
  const d1 = createLocalD1();
  try {
    insertCitizen(d1, { handle: "gate-c" });
    const env = makeEnv(d1);
    const before = (d1.raw.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    await inbox(env, "gate-c", "0", null);
    const after = (d1.raw.prepare("SELECT total_changes() AS n").get() as { n: number }).n;
    assert.equal(after, before, "inbox() must write nothing -- total_changes() must be unchanged across the call");
  } finally {
    d1.close();
  }
});

// R1/L2 (D-018 gate): the posts candidate query must plan as a rowid-range scan bounded by
// its own cursor, with no separate sort step -- otherwise a heartbeat call reads the whole
// posts table every time regardless of cursor position (measured by the gate: 1,708 rows
// read in "nothing new" steady state at 100x scale, dropping to 7 with this plan). Pins the
// REAL query text (postsSql, exported for exactly this), not a retyped copy.
test("R1/L2 (D-018 gate): the posts candidate query plans as INTEGER PRIMARY KEY (rowid range), no TEMP B-TREE FOR ORDER BY (mutation: drop both +p.kind casts -> red; dropping only one is not enough, re-gate Note 2)", () => {
  const d1 = createLocalD1();
  try {
    const sql = postsSql("?");
    const plan = d1.raw.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(1, 0, 0, "%x%", "%x%", 101) as Array<{ detail: string }>;
    const detail = plan.map((r) => r.detail).join(" | ");
    assert.match(detail, /INTEGER PRIMARY KEY/, `the posts query must use the rowid range, not an index that ignores the cursor -- got: ${detail}`);
    assert.doesNotMatch(detail, /TEMP B-TREE FOR ORDER BY/, `walking the rowid in id order must satisfy ORDER BY p.id ASC with no separate sort -- got: ${detail}`);
  } finally {
    d1.close();
  }
});

// Re-gate Note 1: the FIRST fix for R2/L3 (WHERE citizen_id = ? alone) avoided D1's
// bound-parameter limit but has no usable index (idx_ballots_proposal_citizen leads with
// proposal_id, not citizen_id), so it planned as a full SCAN of every ballot ever cast, on
// every inbox call. The subquery form pins a SEARCH via that same index instead.
test("re-gate Note 1: the ballots read plans as an indexed SEARCH on idx_ballots_proposal_citizen, never a SCAN of ballots (mutation: revert to WHERE citizen_id = ? alone -> red)", () => {
  const d1 = createLocalD1();
  try {
    const plan = d1.raw.prepare(`EXPLAIN QUERY PLAN ${ballotsSql()}`).all(1, 0) as Array<{ detail: string }>;
    const detail = plan.map((r) => r.detail).join(" | ");
    assert.doesNotMatch(detail, /SCAN ballots/, `the ballots read must never be a full scan -- got: ${detail}`);
    assert.match(detail, /SEARCH ballots USING (COVERING )?INDEX idx_ballots_proposal_citizen/, `the ballots read must use the (proposal_id, citizen_id) index -- got: ${detail}`);
  } finally {
    d1.close();
  }
});

// CODEX round 2 (exchange/REVIEW_heartbeat-gate-conditions-2026-09-27.md): openProposals is
// read first, then this subquery re-checked status = 'open' in a SEPARATE, later query. A
// sweep can move a proposal to 'tallying' in the gap between the two reads (closes_at and
// post_id do not change once a proposal is open; status does), which silently dropped this
// citizen's real ballot out of the second read while the proposal stayed listed from the
// first -- balloted read false and ballots_owed rose for that entry. Seeds a proposal
// already moved to 'tallying' (closes_at/post_id exactly as a real sweep leaves them) and a
// ballot on it, then reads it back through the exact subquery inbox() runs.
test("CODEX round 2: the ballots read returns a ballot on a proposal already moved to 'tallying' -- no second, independently timed status check (mutation: put status = 'open' back into the subquery -> red)", async () => {
  const d1 = createLocalD1();
  try {
    const NOW = Date.now();
    const citizen = insertCitizen(d1, { handle: "az" });
    const proposalId = insertProposal(d1, { kind: "resolution", status: "tallying", closes_at: NOW + 5 * DAY });
    d1.raw.prepare("INSERT INTO ballots (proposal_id, citizen_id, choice, cast_at) VALUES (?, ?, 'yes', ?)").run(proposalId, citizen, NOW - 1000);

    const { results } = await d1.DB.prepare(ballotsSql()).bind(citizen, NOW).all<{ proposal_id: number }>();
    assert.ok(
      results.some((r) => r.proposal_id === proposalId),
      "the ballots read must return this citizen's real ballot even though the proposal's status has since moved on",
    );
  } finally {
    d1.close();
  }
});

// ---------- 6. topics_opened (D3) ----------

test("6: an in-window topic is listed with author: null and opened_by; an out-of-window topic is not", async () => {
  const d1 = createLocalD1();
  try {
    const maintainer = insertCitizen(d1, { handle: "commonhold-agent" });
    insertCitizen(d1, { handle: "az" });
    // Insertion order fixes id order: outOfWindow first (smaller id), inWindow second.
    const outOfWindow = insertPost(d1, { citizen_id: maintainer, kind: "topic", topic_state: "open", title: "Out of window" });
    const inWindow = insertPost(d1, { citizen_id: maintainer, kind: "topic", topic_state: "open", title: "In window" });

    const env = makeEnv(d1);
    const res = await inbox(env, "az", null, `c0-p${outOfWindow}`);
    const topics = res.topics_opened as Array<{ id: number; author: null; opened_by: string }>;
    assert.deepEqual(topics.map((t) => t.id), [inWindow]);
    assert.equal(topics[0].author, null);
    assert.equal(topics[0].opened_by, "the operator, through POST /api/maintainer/topic");
  } finally {
    d1.close();
  }
});

// ---------- 7 / A17 / A19. cursor ----------

test("7/A17: per-table truncation sets has_more and next_cursor to the id of the last EXAMINED row (never the 101st look-ahead row); not truncated advances to the table's own MAX(id) snapshot", async () => {
  const d1 = createLocalD1();
  try {
    insertCitizen(d1, { handle: "az" });
    const b = insertCitizen(d1, { handle: "bz" });
    const post = insertPost(d1, { citizen_id: b });
    const ids: number[] = [];
    for (let i = 0; i < 101; i++) {
      const body = i === 99 ? "@azley not a real match" : "@az a real mention";
      ids.push(insertComment(d1, { post_id: post, citizen_id: b, body, created_at: 1000 }));
    }
    assert.deepEqual(ids, Array.from({ length: 101 }, (_, i) => i + 1), "sequential ids, one writer");

    const env = makeEnv(d1);
    const page1 = await inbox(env, "az", "0", null);
    assert.equal(page1.has_more, true);
    const page1Ids = (page1.mentions as Array<{ id: number }>).map((m) => m.id);
    assert.deepEqual(page1Ids, ids.slice(0, 99), "ids 1-99 delivered; id 100 was a candidate (LIKE-matched) but failed the boundary check, so it is dropped, not delivered");
    assert.equal(page1.next_cursor, `c100-p1`, "the cursor advances to the 100th EXAMINED row, whether or not it was delivered -- the look-ahead 101st is never served on this page");

    const page2 = await inbox(env, "az", null, page1.next_cursor as string);
    assert.equal(page2.has_more, false);
    assert.deepEqual(
      (page2.mentions as Array<{ id: number }>).map((m) => m.id),
      [101],
      "the 101st row (a genuine mention) is served on the second page and never skipped, despite the dropped candidate at the page boundary",
    );
    assert.equal(page2.next_cursor, `c101-p1`);
  } finally {
    d1.close();
  }
});

// F6 (gate review, GEMINI): test 7 above only ever exercised the COMMENTS table's
// truncation/look-ahead; the POSTS table (topics_opened) has the identical mechanism
// and was never proven to truncate, hold back a look-ahead row, or deliver it next call.
test("F6: 101 topics exercise the POSTS table's own truncation and look-ahead, the same way test 7 proved it for comments", async () => {
  const d1 = createLocalD1();
  try {
    const maintainer = insertCitizen(d1, { handle: "commonhold-agent" });
    insertCitizen(d1, { handle: "az" });
    const ids: number[] = [];
    for (let i = 0; i < 101; i++) {
      ids.push(insertPost(d1, { citizen_id: maintainer, kind: "topic", topic_state: "open", title: `Topic ${i + 1}`, created_at: 1000 }));
    }
    assert.deepEqual(ids, Array.from({ length: 101 }, (_, i) => i + 1), "sequential ids, one writer");

    const env = makeEnv(d1);
    const page1 = await inbox(env, "az", "0", null);
    assert.equal(page1.has_more, true);
    const page1Ids = (page1.topics_opened as Array<{ id: number }>).map((t) => t.id);
    assert.deepEqual(page1Ids, ids.slice(0, 100), "exactly the first 100 topics delivered");
    assert.equal(page1.next_cursor, `c0-p100`, "the posts cursor advances to the 100th examined row; the comments side is untouched (c0)");

    const page2 = await inbox(env, "az", null, page1.next_cursor as string);
    assert.equal(page2.has_more, false);
    assert.deepEqual((page2.topics_opened as Array<{ id: number }>).map((t) => t.id), [101], "the 101st topic (look-ahead) is served on the second page");
    assert.equal(page2.next_cursor, `c0-p101`);
  } finally {
    d1.close();
  }
});

// F6: an empty database (MAX(id) is null on both tables) must keep the incoming cursor
// unchanged, not crash and not silently step to some other value.
test("F6: an empty database keeps the incoming cursor unchanged (MAX(id) is null, falls back to the starting id)", async () => {
  const d1 = createLocalD1();
  try {
    insertCitizen(d1, { handle: "az" });
    const env = makeEnv(d1);
    const res = await inbox(env, "az", null, "c7-p12");
    assert.equal(res.next_cursor, "c7-p12", "no rows in either table: the cursor does not move");
    assert.equal(res.has_more, false);
    assert.deepEqual(res.mentions, []);
    assert.deepEqual(res.replies, []);
    assert.deepEqual(res.comments_on_your_posts, []);
    assert.deepEqual(res.topics_opened, []);
  } finally {
    d1.close();
  }
});

// F6: test 7 above delivered only 100 total items because one of the 101 candidates was
// a REJECTED boundary case (@azley). This proves the 100-then-1 split for 101 items that
// are ALL genuinely valid mentions -- none dropped, none merged, none lost.
test("F6: exactly 101 genuinely valid mentions (no rejected candidates) split cleanly as 100 on page one, 1 on page two", async () => {
  const d1 = createLocalD1();
  try {
    insertCitizen(d1, { handle: "az" });
    const b = insertCitizen(d1, { handle: "bz" });
    const post = insertPost(d1, { citizen_id: b });
    const ids: number[] = [];
    for (let i = 0; i < 101; i++) {
      ids.push(insertComment(d1, { post_id: post, citizen_id: b, body: `@az genuine mention number ${i + 1}`, created_at: 1000 }));
    }

    const env = makeEnv(d1);
    const page1 = await inbox(env, "az", "0", null);
    assert.equal(page1.has_more, true);
    assert.deepEqual((page1.mentions as Array<{ id: number }>).map((m) => m.id), ids.slice(0, 100), "all 100 delivered on page one, none rejected");

    const page2 = await inbox(env, "az", null, page1.next_cursor as string);
    assert.equal(page2.has_more, false);
    assert.deepEqual((page2.mentions as Array<{ id: number }>).map((m) => m.id), [ids[100]], "the 101st item delivered alone on page two");
  } finally {
    d1.close();
  }
});

test("A19 (CODEX round 2 reproduction): rows (id 1, created_at 200) and (id 2, created_at 100), since=150, delivers id 1", async () => {
  const d1 = createLocalD1();
  try {
    insertCitizen(d1, { handle: "az" });
    const b = insertCitizen(d1, { handle: "bz" });
    const post = insertPost(d1, { citizen_id: b, created_at: 1 });
    const id1 = insertComment(d1, { post_id: post, citizen_id: b, body: "@az first, clock-early", created_at: 1 });
    const id2 = insertComment(d1, { post_id: post, citizen_id: b, body: "@az second, clock-early too", created_at: 1 });
    setCommentCreatedAt(d1, id1, 200);
    setCommentCreatedAt(d1, id2, 100);

    const env = makeEnv(d1);
    const res = await inbox(env, "az", "150", null);
    const mentionIds = (res.mentions as Array<{ id: number }>).map((m) => m.id);
    assert.ok(mentionIds.includes(id1), "id 1 (created_at 200, newer than since=150) must be delivered on the FIRST call");
  } finally {
    d1.close();
  }
});

test("A20 (gate review): a mention hidden by moderation when the cursor passed it is not delivered even if later restored -- the cursor advances to the LAST EXAMINED row, not the last DELIVERED one (mutation: cursor-by-last-delivered -> red)", async () => {
  const d1 = createLocalD1();
  try {
    insertCitizen(d1, { handle: "az" });
    const b = insertCitizen(d1, { handle: "bz" });
    const post = insertPost(d1, { citizen_id: b });
    // genuine (delivered) comes BEFORE hidden (dropped, larger id) so a cursor computed
    // from "the last DELIVERED row" (genuine) and one computed from "the last EXAMINED
    // row" (hidden) are two DIFFERENT values -- the two designs are distinguishable.
    const genuine = insertComment(d1, { post_id: post, citizen_id: b, body: "@az a genuine mention, delivered" });
    const hidden = insertComment(d1, { post_id: post, citizen_id: b, body: "@az but collapsed", mod_state: "collapsed" });
    assert.ok(hidden > genuine, "test setup invariant: hidden must be the LATER row (larger id)");

    const env = makeEnv(d1);
    const page1 = await inbox(env, "az", "0", null);
    assert.deepEqual((page1.mentions as Array<{ id: number }>).map((m) => m.id), [genuine], "only the genuine mention delivered");
    // The direct proof: next_cursor names the LAST EXAMINED row (hidden), not the last
    // DELIVERED one (genuine) -- a cursor-by-last-delivered design would serve
    // c${genuine}-p${post} here instead, and this assertion alone would catch it.
    assert.equal(page1.next_cursor, `c${hidden}-p${post}`, "the cursor advances to the last EXAMINED row (hidden), never the last DELIVERED one (genuine)");

    setCommentModState(d1, hidden, null); // the maintainer restores it
    const page2 = await inbox(env, "az", null, page1.next_cursor as string);
    assert.deepEqual(page2.mentions, [], "restored after the cursor passed it: still not delivered, per A20");
  } finally {
    d1.close();
  }
});

test("A: a moderated topic's mentions_you is forced false, even though its title/body would otherwise match (a hidden item does not notify, mirroring A7's rule for comments/posts)", async () => {
  const d1 = createLocalD1();
  try {
    const maintainer = insertCitizen(d1, { handle: "commonhold-agent" });
    insertCitizen(d1, { handle: "az" });
    const topic = insertPost(d1, { citizen_id: maintainer, kind: "topic", topic_state: "open", title: "About @az", mod_state: "collapsed" });

    const env = makeEnv(d1);
    const res = await inbox(env, "az", "0", null);
    const t = (res.topics_opened as Array<{ id: number; mentions_you: boolean }>).find((x) => x.id === topic);
    assert.ok(t, "a moderated topic still appears (redacted), same as GET /api/topics");
    assert.equal(t!.mentions_you, false);
  } finally {
    d1.close();
  }
});

test("A4: self-exclusion does NOT apply to a topic (citizen_id = 1 is the FK placeholder, not an author) -- a topic mentioning @commonhold-agent still sets mentions_you for citizen 1", async () => {
  const d1 = createLocalD1();
  try {
    const maintainer = insertCitizen(d1, { handle: "commonhold-agent" });
    const topic = insertPost(d1, { citizen_id: maintainer, kind: "topic", topic_state: "open", title: "About @commonhold-agent's own rule" });

    const env = makeEnv(d1);
    const res = await inbox(env, "commonhold-agent", "0", null);
    const t = (res.topics_opened as Array<{ id: number; mentions_you: boolean }>).find((x) => x.id === topic);
    assert.ok(t, "the topic is listed");
    assert.equal(t!.mentions_you, true, "not suppressed as a self-mention: a topic's citizen_id is an FK placeholder, not an author");
  } finally {
    d1.close();
  }
});

test("F2 (gate review, corrected): the cursor branch (not just the first-call floor) is by id, not created_at -- a row with a SMALLER (older) created_at than the cursor's own row, but a LARGER id, is still delivered by a cursor-based call (mutation: cursor by created_at -> red)", async () => {
  const d1 = createLocalD1();
  try {
    insertCitizen(d1, { handle: "az" });
    const b = insertCitizen(d1, { handle: "bz" });
    const post = insertPost(d1, { citizen_id: b, created_at: 1 });
    const before = insertComment(d1, { post_id: post, citizen_id: b, body: "@az before the cursor", created_at: 1000 });
    const id1 = insertComment(d1, { post_id: post, citizen_id: b, body: "@az newer id, older clock", created_at: 1000 });
    // id1's id is LARGER than before's (inserted after it), but its created_at is set
    // SMALLER (older) than before's own 1000ms -- a writer-clock-skew shape. A cursor
    // that filtered by `created_at > before.created_at` (1000) would exclude id1 (500 is
    // not > 1000); the real, id-based cursor (`id > before`) includes it regardless.
    setCommentCreatedAt(d1, id1, 500);
    assert.ok(id1 > before, "test setup invariant: id1 must have the larger id");
    assert.ok(500 < 1000, "test setup invariant: id1's created_at must be older than before's");

    const env = makeEnv(d1);
    const res = await inbox(env, "az", null, `c${before}-p0`);
    const mentionIds = (res.mentions as Array<{ id: number }>).map((m) => m.id);
    assert.deepEqual(mentionIds, [id1], "delivered because its id is past the cursor -- created_at plays no part in a cursor-based call");
  } finally {
    d1.close();
  }
});

// ---------- 8-11, 13. served text and routes (D5-D8, A8-A12, A14, A18) ----------

function parseFrontmatter(text: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---/.exec(text);
  assert.ok(m, "must have YAML frontmatter delimited by ---");
  const out: Record<string, string> = {};
  for (const line of m![1]!.split("\n")) {
    const kv = /^(\w+):\s*(.*)$/.exec(line);
    if (kv) out[kv[1]!] = kv[2]!;
  }
  return out;
}

test("8: /heartbeat.md and /skill.md are 200 text/markdown; charset=utf-8; the rendered caps equal CONSTITUTION values; the skill frontmatter parses with name, description, version", async () => {
  const d1 = createLocalD1();
  try {
    const env = makeEnv(d1);
    const hbRes = await callFetch(new Request(`${TEST_ORIGIN}/heartbeat.md`), env);
    assert.equal(hbRes.status, 200);
    assert.match(hbRes.headers.get("Content-Type") ?? "", /text\/markdown; charset=utf-8/);
    const hbText = await hbRes.text();
    assert.ok(hbText.includes(`${CONSTITUTION.comments_per_day} comments a day`), "comments_per_day must render live from CONSTITUTION");
    assert.ok(hbText.includes(`${CONSTITUTION.votes_per_day} votes a day`), "votes_per_day must render live from CONSTITUTION");
    assert.ok(hbText.includes(`${CONSTITUTION.posts_per_day} post a day`), "posts_per_day must render live from CONSTITUTION");
    const fmHb = parseFrontmatter(hbText);
    assert.ok(fmHb.name, "heartbeat frontmatter must carry name");
    assert.ok(fmHb.description, "heartbeat frontmatter must carry description");

    const skRes = await callFetch(new Request(`${TEST_ORIGIN}/skill.md`), env);
    assert.equal(skRes.status, 200);
    assert.match(skRes.headers.get("Content-Type") ?? "", /text\/markdown; charset=utf-8/);
    const skText = await skRes.text();
    const fmSk = parseFrontmatter(skText);
    assert.ok(fmSk.name, "skill frontmatter must carry name");
    assert.ok(fmSk.description, "skill frontmatter must carry description");
    assert.equal(fmSk.version, SKILL_VERSION, "skill frontmatter version must equal the live SKILL_VERSION");
  } finally {
    d1.close();
  }
});

// A path this checker scans for is written as "GET <origin><path>" / "POST <origin><path>"
// in the served text (the hub own template style); this extracts the path portion up to
// the first whitespace or a question mark (a query string or human-readable placeholder
// text follows), then strips trailing sentence punctuation the surrounding prose attaches.
function extractServedPaths(text: string, origin: string): string[] {
  const escaped = origin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(escaped + "(/[^\\s?]*)", "g");
  const paths: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    paths.push(m[1]!.replace(/[.,:;]+$/, ""));
  }
  return paths;
}

test("9: every /api/... and /mcp... path named in /heartbeat.md or /skill.md is a real ROUTES path (mutation: a bogus path in the checked text goes red)", () => {
  const routePaths = new Set(ROUTES.map((r) => r.path));
  const facts: HeartbeatSkillFacts = { origin: TEST_ORIGIN, society: "Commonhold", registrationMode: "open" };
  const hbText = renderHeartbeatMd(facts, TEST_BALLOT_NOTE);
  const skText = renderSkillMd(facts, TEST_AUTH_LABEL);
  const found = [...extractServedPaths(hbText, TEST_ORIGIN), ...extractServedPaths(skText, TEST_ORIGIN)];
  assert.ok(found.length > 5, "sanity: the extractor actually found paths, not zero -- otherwise this test proves nothing");
  const unknown = found.filter((p) => !routePaths.has(p));
  assert.deepEqual(unknown, [], "every extracted path must be a real ROUTES path -- a served routine must never name a route that does not exist");

  // Mutation: a bogus path planted in the same served text must be caught by this check.
  const withBogus = hbText + `\nGET ${TEST_ORIGIN}/api/this-route-does-not-exist\n`;
  const foundBogus = extractServedPaths(withBogus, TEST_ORIGIN).filter((p) => !routePaths.has(p));
  assert.deepEqual(foundBogus, ["/api/this-route-does-not-exist"], "the checker must flag a bogus path, proving it can fail");
});

test("10: /api/surface heartbeat/skill sha256 equal sha256 of the bodies served at the SAME origin (mutation: a different origin renders and hashes differently); the skill text is pinned to SKILL_VERSION", async () => {
  const d1 = createLocalD1();
  try {
    const env = makeEnv(d1);
    const surfaceRes = await callFetch(new Request(`${TEST_ORIGIN}/api/surface`), env);
    const surface = (await surfaceRes.json()) as {
      heartbeat: { url: string; sha256: string };
      skill: { url: string; version: string; sha256: string };
    };

    const hbBody = await (await callFetch(new Request(`${TEST_ORIGIN}/heartbeat.md`), env)).text();
    const skBody = await (await callFetch(new Request(`${TEST_ORIGIN}/skill.md`), env)).text();
    assert.equal(surface.heartbeat.sha256, await sha256Hex(hbBody), "heartbeat sha256 must equal the sha256 of the body served at the same origin");
    assert.equal(surface.skill.sha256, await sha256Hex(skBody), "skill sha256 must equal the sha256 of the body served at the same origin");
    assert.equal(surface.heartbeat.url, `${TEST_ORIGIN}/heartbeat.md`);
    assert.equal(surface.skill.url, `${TEST_ORIGIN}/skill.md`);
    assert.equal(surface.skill.version, SKILL_VERSION);

    // Mutation: a DIFFERENT origin render must hash differently, proving the check
    // actually depends on origin rather than being vacuously true for any two texts.
    const otherOrigin = "https://a-different-origin.example.invalid";
    const otherBody = await (await callFetch(new Request(`${otherOrigin}/heartbeat.md`), env)).text();
    assert.notEqual(await sha256Hex(otherBody), surface.heartbeat.sha256, "a different origin render must not equal this origin served sha256");

    // The version/sha pin (a fixed test origin/facts/ballotNote, computed once and
    // hardcoded here): an edit to the rendered skill text that does not bump
    // SKILL_VERSION fails this exact assertion. L5 (D-018 gate): pinned with the REAL
    // AUTH_LABEL.citizen_secret, not a placeholder -- the Credentials section is the
    // longest block of the file, so an edit there must also force this version decision.
    const pinnedFacts: HeartbeatSkillFacts = { origin: "https://commonhold.example.invalid", society: "Commonhold", registrationMode: "open" };
    const pinnedText = renderSkillMd(pinnedFacts, AUTH_LABEL.citizen_secret);
    // A5(a) (docs/BRIEF-MCP-LISTING-READY.md, 2026-09-28): the Join paragraph's
    // pre-payment-checks disclosure moved this pin; SKILL_VERSION bumped to 1.0.2 in
    // the same commit. New hash taken from this exact assertion's own failure output,
    // never computed by hand. B10 (docs/BRIEF-SETTLEMENT-REPLAY-GUARD.md, 2026-09-30) moved it
    // again: the Join section recommends a public_key; SKILL_VERSION bumped to 1.0.3 in the same commit.
    // The guest-voice wave (docs/BRIEF-GUEST-VOICE.md G5, G7) rewrote the file to lead with the free guest path: 1.1.0; the gate M-1 wording fix: 1.1.1; the CODEX gate-fixes r1 write-route sentence: 1.1.2; Ben's A3 ruling, 'awaiting an answer': 1.1.3; CODEX A3 r1, the daily caps count accepted critiques: 1.1.4.
    assert.equal(await sha256Hex(pinnedText), "320484a7b7562e7d9702ff6b535f575a0707e29a299726cdbb6ab37f22d58e8c", "the skill text changed without a SKILL_VERSION bump");
    assert.equal(SKILL_VERSION, "1.1.4", "a deliberate re-mint of the skill text bumps this pin in the same commit");
  } finally {
    d1.close();
  }
});

// G2 (exchange/REVIEW_heartbeat-steps-bcd-build-2026-09-27.md): A9 says the invite-only
// sentence renders ONLY when registration is invite-gated. Test 9/10 above only ever
// render in "open" mode, so a regression that rendered the sentence unconditionally (or
// never at all) would go unnoticed; this pins both branches directly.
test("G2: /skill.md carries the invite-only sentence only in invite_only mode, never in open mode (A9)", () => {
  const openFacts: HeartbeatSkillFacts = { origin: TEST_ORIGIN, society: "Commonhold", registrationMode: "open" };
  const inviteFacts: HeartbeatSkillFacts = { origin: TEST_ORIGIN, society: "Commonhold", registrationMode: "invite_only" };
  const openText = renderSkillMd(openFacts, TEST_AUTH_LABEL);
  const inviteText = renderSkillMd(inviteFacts, TEST_AUTH_LABEL);
  assert.ok(!openText.includes("invite-only"), "open mode must carry no invite-only sentence");
  assert.ok(inviteText.includes("invite-only"), "invite_only mode must carry the invite-only sentence");
});

// Test 11 (discovery.test.ts's own generic drift guard, plus its "every ROUTES entry is
// mentioned in llms.txt/openapi/surface" tests, already cover the three new routes once
// they carry a grepFor entry and appear in ROUTES -- nothing new to write there; this test
// pins that the three routes are genuinely present with the right shape, which the
// generic tests do not name individually.
test("11: /api/inbox, /heartbeat.md and /skill.md are present in ROUTES with method GET and auth none, each carrying a grepFor", () => {
  for (const path of ["/api/inbox", "/heartbeat.md", "/skill.md"]) {
    const r = ROUTES.find((x) => x.path === path);
    assert.ok(r, `${path} missing from ROUTES`);
    assert.equal(r!.method, "GET");
    assert.equal(r!.auth, "none");
    assert.ok(r!.grepFor, `${path} must carry a grepFor -- index.ts dispatches it in this wave`);
  }
  const inboxRoute = ROUTES.find((x) => x.path === "/api/inbox")!;
  const handleParam = inboxRoute.queryParams?.find((q) => q.name === "handle");
  assert.equal(handleParam?.required, true, "A12: /api/inbox handle must be required");
  const changesRoute = ROUTES.find((x) => x.path === "/api/changes")!;
  const sinceParam = changesRoute.queryParams?.find((q) => q.name === "since");
  assert.equal(sinceParam?.required, true, "A12: /api/changes since must be required");
});

// A12: RouteQueryParam.required must actually reach the SERVED OpenAPI document, not
// just sit on the ROUTES data structure -- renderOpenApi is the code path that has to
// emit it (mutation: renderOpenApi hard-codes required: false -> red).
test("11b: the served OpenAPI doc emits required: true for /api/inbox handle and /api/changes since, and required: false for /api/inbox since/cursor (neither alone is mandatory)", () => {
  const doc = renderOpenApi(TEST_ORIGIN, "Commonhold") as {
    paths: Record<string, { get: { parameters: Array<{ name: string; required: boolean }>; responses: { "200": { content: Record<string, unknown> } } } }>;
  };
  const inboxParams = doc.paths["/api/inbox"]!.get.parameters;
  const handleParam = inboxParams.find((p) => p.name === "handle");
  assert.equal(handleParam?.required, true);
  const sinceParam = inboxParams.find((p) => p.name === "since");
  assert.equal(sinceParam?.required, false, "since alone is not mandatory -- exactly one of since/cursor is, which OpenAPI's per-parameter required cannot express");
  const changesParams = doc.paths["/api/changes"]!.get.parameters;
  const changesSince = changesParams.find((p) => p.name === "since");
  assert.equal(changesSince?.required, true);

  // G2 (exchange/REVIEW_heartbeat-steps-bcd-build-2026-09-27.md): test 8 pins the RUNTIME
  // Content-Type header on the real /heartbeat.md and /skill.md responses; this pins the
  // separate claim the served OpenAPI DOCUMENT makes about them, which a prior version of
  // this test never inspected (it checked parameters only).
  const hbContent = doc.paths["/heartbeat.md"]!.get.responses["200"].content;
  assert.ok("text/markdown" in hbContent, "/heartbeat.md's OpenAPI response must be described as text/markdown");
  const skContent = doc.paths["/skill.md"]!.get.responses["200"].content;
  assert.ok("text/markdown" in skContent, "/skill.md's OpenAPI response must be described as text/markdown");
});

test("13: the heartbeat door note is present on GET / outside the attested constitution (the v5 template pin is checked in topics-d1.test.ts and stays green across the whole suite)", async () => {
  const d1 = createLocalD1();
  try {
    const env = makeEnv(d1);
    const res = await callFetch(new Request(`${TEST_ORIGIN}/`), env);
    const body = await res.text();
    assert.ok(body.includes("Heartbeat:"), "the door note must be present");
    assert.ok(body.includes(`${TEST_ORIGIN}/heartbeat.md`));
    assert.ok(body.includes(`${TEST_ORIGIN}/skill.md`));
    // G2 (exchange/REVIEW_heartbeat-steps-bcd-build-2026-09-27.md), belt and braces on top
    // of the v5 hash pin (topics-d1.test.ts test 9, unaffected by this wave): the ATTESTED
    // template itself must not carry the door note's own text -- checked directly here,
    // not only inferred from that hash staying green.
    assert.ok(!buildConstitutionTemplate().includes("Heartbeat: GET"), "the door note must sit outside the attested constitution template");
  } finally {
    d1.close();
  }
});

// G2 (exchange/REVIEW_heartbeat-steps-bcd-build-2026-09-27.md): A8 requires GET
// /api/changes's own cursor_note to point callers at the inbox's exact guarantee (its own
// cursor is best-effort, by created_at; the inbox's is exact, by row id) -- no prior test
// touches changes()'s cursor_note at all.
test("G2: GET /api/changes's cursor_note names the inbox's exact guarantee (A8)", async () => {
  const d1 = createLocalD1();
  try {
    const env = makeEnv(d1);
    const result = await changes(env, 0);
    assert.ok(
      (result.cursor_note as string).endsWith("A citizen's own replies and mentions are exact at GET /api/inbox."),
      "A8: the changes() cursor_note must point at the inbox's own exact guarantee, word for word",
    );
    // M27 (CODEX, exchange/REVIEW_colony-cursor-exori-2026-09-27.md round 1): a capped
    // page's next_since is its last row's own created_at, and the next call's
    // created_at > ? is strict, so a row sharing that exact timestamp past the LIMIT
    // cutoff is skipped too -- a second, independent case the cursor_note must disclose
    // alongside the DEFERRED-CHANGES-CURSOR-RACE one.
    assert.ok(
      (result.cursor_note as string).includes("and so can rows that share a created_at at the edge of a capped page"),
      "A8: the changes() cursor_note must also disclose the capped-page timestamp-tie skip",
    );
  } finally {
    d1.close();
  }
});

// ---------- D-018 gate: docs/HEARTBEAT-SKILL-TEXT.md against the renderers ----------

// Previously verified by hand only ("a mechanical comparison", exchange/
// REVIEW_heartbeat-steps-bcd-build-2026-09-27.md's own CLAUDE round 1 note); the gate asked
// for it as a real test. Extracts the doc's own fenced blocks and backtick-quoted entries,
// substitutes the same values the renderers are called with, and compares byte for byte --
// so a hand-edit to either side that drifts from the other fails this test, not a human
// re-reading both files side by side.

// Normalised the same way governance.ts's canonicalizeTemplate is (\r\n -> \n), for the
// identical reason its own comment gives: a Windows checkout with core.autocrlf can carry
// CRLF in this file's raw on-disk bytes, but a JS template literal's runtime string value
// is CR/CRLF-normalised to LF by the engine regardless of the source file's own line
// endings -- so a bare readFileSync of the doc must be normalised to compare like with
// like, or this test's outcome would depend on git config, never on the wording itself.
function readHeartbeatSkillTextDoc(): string {
  return readFileSync(join(import.meta.dirname, "..", "docs", "HEARTBEAT-SKILL-TEXT.md"), "utf8").replace(/\r\n/g, "\n");
}

function extractFencedBlock(doc: string, heading: string): string {
  const marker = `## ${heading}`;
  const headingIdx = doc.indexOf(marker);
  assert.ok(headingIdx !== -1, `doc heading not found: ${heading}`);
  const rest = doc.slice(headingIdx + marker.length);
  const openIdx = rest.indexOf("```");
  assert.ok(openIdx !== -1, `no fenced block after heading: ${heading}`);
  const afterOpen = rest.slice(openIdx + 3);
  const newlineIdx = afterOpen.indexOf("\n");
  assert.ok(newlineIdx !== -1, `fenced block opener has no newline: ${heading}`);
  const bodyStart = newlineIdx + 1;
  const closeIdx = afterOpen.indexOf("```", bodyStart);
  assert.ok(closeIdx !== -1, `unterminated fenced block: ${heading}`);
  return afterOpen.slice(bodyStart, closeIdx);
}

// The first backtick-quoted value after `marker` in the doc's own prose -- used for the
// single-line `- \`note\`: \`...\`` / invite-line / A8 entries, which are not fenced blocks.
function extractBacktickAfter(doc: string, marker: string): string {
  const markerIdx = doc.indexOf(marker);
  assert.ok(markerIdx !== -1, `doc marker not found: ${marker}`);
  const rest = doc.slice(markerIdx + marker.length);
  const openTick = rest.indexOf("`");
  assert.ok(openTick !== -1, `no backtick value after marker: ${marker}`);
  const afterOpen = rest.slice(openTick + 1);
  const closeTick = afterOpen.indexOf("`");
  assert.ok(closeTick !== -1, `unterminated backtick value after marker: ${marker}`);
  return afterOpen.slice(0, closeTick);
}

function substitutePlaceholders(template: string, values: Record<string, string>): string {
  let out = template;
  for (const [key, val] of Object.entries(values)) out = out.split(`\${${key}}`).join(val);
  return out;
}

test("D-018 gate: docs/HEARTBEAT-SKILL-TEXT.md's three fenced blocks, the inbox note, and the A8 sentence equal the renderers' own output after placeholder substitution, in both registration modes (mutation: change one doc word -> red)", async () => {
  const doc = readHeartbeatSkillTextDoc();
  const hbBlock = extractFencedBlock(doc, "/heartbeat.md");
  const skBlock = extractFencedBlock(doc, "/skill.md");
  const doorBlock = extractFencedBlock(doc, "Door note on GET / (appended after `topicsDoorNote`, outside `FRONT_DOOR_TEMPLATE`)");
  const inviteLineInvite = extractBacktickAfter(doc, "carrying its own leading space");
  const noteDoc = extractBacktickAfter(doc, "- `note`: ");
  const a8Doc = extractBacktickAfter(doc, "(A8)");

  const O = TEST_ORIGIN;
  const S = "Commonhold";
  const SLUG = slugify(S);
  const P = String(CONSTITUTION.posts_per_day);
  const C = String(CONSTITUTION.comments_per_day);
  const V = String(CONSTITUTION.votes_per_day);
  const OPENED_BY = TOPICS.opened_by;
  const PRICE = `$${(REGISTRATION_PRICE_CENTS / 100).toFixed(2)} USDC`;

  for (const mode of ["open", "invite_only"] as const) {
    const facts: HeartbeatSkillFacts = { origin: O, society: S, registrationMode: mode };

    // guest-voice wave: the guest sentences and numbers come from src/guest-core.ts, the one source the renderers read too.
    const EX = guestTemplateExceptions();
    const GUEST = {
      CAPS: guestCapsSentence(),
      AIM: GUEST_AIM_SENTENCE,
      ANSWERS: GUEST_ANSWERS_SENTENCE,
      ADMISSION: GUEST_ADMISSION_SENTENCE,
      STEMS: GUEST_REFUSED_STEMS,
      CONTINUITY: GUEST_CONTINUITY_SENTENCE,
      DUTIES_PER_DAY: String(GUEST_DUTIES_PER_DAY),
      MIN_ANSWER: String(GUEST_DUTY_MIN_ANSWER_LEN),
      EX_RULE4: EX.rule_4,
      EX_RULE3: EX.rule_3,
      EX_LEDGER: EX.ledger,
      EX_WRITES: EX.writes,
    };
    const expectedHb = substitutePlaceholders(hbBlock, { O, S, SLUG, P, C, V, OPENED_BY, BALLOT_NOTE: TEST_BALLOT_NOTE, ...GUEST });
    assert.equal(renderHeartbeatMd(facts, TEST_BALLOT_NOTE), expectedHb, `renderHeartbeatMd must equal the doc's /heartbeat.md block (${mode})`);

    const expectedSk = substitutePlaceholders(skBlock, {
      O,
      S,
      SLUG,
      PRICE,
      INVITE_LINE: mode === "invite_only" ? inviteLineInvite : "",
      AUTH: TEST_AUTH_LABEL,
      SKILL_VERSION,
      ...GUEST,
    });
    assert.equal(renderSkillMd(facts, TEST_AUTH_LABEL), expectedSk, `renderSkillMd must equal the doc's /skill.md block (${mode})`);
  }

  const expectedDoor = substitutePlaceholders(doorBlock, { O: TEST_ORIGIN });
  assert.equal(heartbeatDoorNote(TEST_ORIGIN), expectedDoor, "heartbeatDoorNote must equal the doc's door-note block");

  const d1 = createLocalD1();
  try {
    insertCitizen(d1, { handle: "az" });
    const env = makeEnv(d1);
    const res = await inbox(env, "az", "0", null);
    assert.equal(res.note, noteDoc, "inbox()'s note must equal the doc's note entry, word for word");
  } finally {
    d1.close();
  }

  const d1b = createLocalD1();
  try {
    const env = makeEnv(d1b);
    const changesRes = await changes(env, 0);
    assert.ok((changesRes.cursor_note as string).endsWith(a8Doc), "changes()'s cursor_note must end with the doc's A8 sentence, word for word");
  } finally {
    d1b.close();
  }
});

// ---------- 12. the inbox MCP tool (A16) ----------

async function mcpToolsList(handler: (r: Request, e: Env) => Promise<Response>, env: Env): Promise<Array<{ name: string }>> {
  const req = new Request(`${TEST_ORIGIN}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  const res = await handler(req, env);
  const body = (await res.json()) as { result: { tools: Array<{ name: string }> } };
  return body.result.tools;
}
async function mcpCallInbox(
  handler: (r: Request, e: Env) => Promise<Response>,
  env: Env,
  args: Record<string, unknown>,
): Promise<unknown> {
  const req = new Request(`${TEST_ORIGIN}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "inbox", arguments: args } }),
  });
  const res = await handler(req, env);
  const body = (await res.json()) as { result: { content: Array<{ text: string }> } };
  return JSON.parse(body.result.content[0]!.text);
}

test("12: inbox is in tools/list on /mcp and /mcp/read; the tool's result equals the REST body exactly", async () => {
  const d1 = createLocalD1();
  try {
    const a = insertCitizen(d1, { handle: "az" });
    const b = insertCitizen(d1, { handle: "bz" });
    const post = insertPost(d1, { citizen_id: b });
    insertComment(d1, { post_id: post, citizen_id: b, body: "@az a mention for MCP parity" });

    const env = makeEnv(d1);
    const fullTools = await mcpToolsList(handleMcp, env);
    assert.ok(fullTools.some((t) => t.name === "inbox"), "inbox must be in /mcp's tools/list");
    const readTools = await mcpToolsList(handleMcpRead, env);
    assert.ok(readTools.some((t) => t.name === "inbox"), "inbox must be in /mcp/read's tools/list");

    // Since-based call: MCP passes since as a JSON number.
    const restSince = await inbox(env, "az", "0", null);
    const mcpSince = await mcpCallInbox(handleMcp, env, { handle: "az", since: 0 });
    const mcpReadSince = await mcpCallInbox(handleMcpRead, env, { handle: "az", since: 0 });
    assert.deepEqual(mcpSince, restSince, "the /mcp tool result must equal the REST body exactly, for a since-based call");
    assert.deepEqual(mcpReadSince, restSince, "the /mcp/read tool result must equal the REST body exactly, for a since-based call");

    // Cursor-based call: MCP passes cursor as a JSON string.
    const cursor = (restSince as { next_cursor: string }).next_cursor;
    const restCursor = await inbox(env, "az", null, cursor);
    const mcpCursor = await mcpCallInbox(handleMcp, env, { handle: "az", cursor });
    assert.deepEqual(mcpCursor, restCursor, "the /mcp tool result must equal the REST body exactly, for a cursor-based call");
    // G1 (exchange/REVIEW_heartbeat-steps-bcd-build-2026-09-27.md): the cursor-based parity
    // check ran on /mcp only; /mcp/read's own dispatch of the cursor branch was unpinned.
    const mcpReadCursor = await mcpCallInbox(handleMcpRead, env, { handle: "az", cursor });
    assert.deepEqual(mcpReadCursor, restCursor, "the /mcp/read tool result must equal the REST body exactly, for a cursor-based call");

    assert.ok(a > 0 && b > 0, "fixtures created");
  } finally {
    d1.close();
  }
});

// ---------- F1 (CODEX, exchange/REVIEW_heartbeat-steps-bcd-build-2026-09-27.md): the MCP
// inbox tool's since/cursor conversion must preserve presence AND type exactly like REST,
// never silently drop a wrongly typed or doubly present value to "absent" ----------

// Mirrors mcpCallInbox above but also surfaces isError -- mcpCallInbox's own JSON.parse of
// content[0].text discards it, so a refusal and a success are otherwise indistinguishable
// except by the accidental presence of an "error" key in the parsed body.
async function mcpCallInboxResult(
  handler: (r: Request, e: Env) => Promise<Response>,
  env: Env,
  args: Record<string, unknown>,
): Promise<{ isError?: boolean; parsed: unknown }> {
  const req = new Request(`${TEST_ORIGIN}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "inbox", arguments: args } }),
  });
  const res = await handler(req, env);
  const body = (await res.json()) as { result: { content: Array<{ text: string }>; isError?: boolean } };
  return { isError: body.result.isError, parsed: JSON.parse(body.result.content[0]!.text) };
}

async function mcpF1Fixture(d1: LocalD1): Promise<{ env: Env; cursor: string }> {
  insertCitizen(d1, { handle: "az" });
  const env = makeEnv(d1);
  const restSince = await inbox(env, "az", "0", null);
  return { env, cursor: (restSince as { next_cursor: string }).next_cursor };
}

test("F1(a): inbox on /mcp and /mcp/read refuses since sent as a string ('0'), never silently treats it as absent; the equivalent REST call (both keys present) is refused too", async () => {
  const d1 = createLocalD1();
  try {
    const { env, cursor } = await mcpF1Fixture(d1);
    for (const handler of [handleMcp, handleMcpRead] as const) {
      const r = await mcpCallInboxResult(handler, env, { handle: "az", since: "0", cursor });
      assert.equal(r.isError, true, "since sent as a string must be refused, not silently treated as absent");
      assert.match((r.parsed as { error: string }).error, /since must/);
    }
    // The REST equivalent (both keys actually present) via the real query-string parse in
    // index.ts, not a direct inbox() call.
    const restBoth = await callFetch(new Request(`${TEST_ORIGIN}/api/inbox?handle=az&since=0&cursor=${encodeURIComponent(cursor)}`), env);
    assert.equal(restBoth.status, 400, "the REST call with both since and cursor present must be refused too");
  } finally {
    d1.close();
  }
});

test("F1(b): inbox on /mcp and /mcp/read refuses since and cursor both present and both correctly typed -- the conversion must not itself resolve the clash by preferring one", async () => {
  const d1 = createLocalD1();
  try {
    const { env, cursor } = await mcpF1Fixture(d1);
    for (const handler of [handleMcp, handleMcpRead] as const) {
      const r = await mcpCallInboxResult(handler, env, { handle: "az", since: 0, cursor });
      assert.equal(r.isError, true, "since and cursor both present must be refused, never silently resolved to one");
      assert.match((r.parsed as { error: string }).error, /exactly one of/);
    }
  } finally {
    d1.close();
  }
});

test("F1(c): inbox on /mcp and /mcp/read refuses cursor sent as a number, never silently treats it as absent", async () => {
  const d1 = createLocalD1();
  try {
    const { env } = await mcpF1Fixture(d1);
    for (const handler of [handleMcp, handleMcpRead] as const) {
      const r = await mcpCallInboxResult(handler, env, { handle: "az", since: 0, cursor: 5 });
      assert.equal(r.isError, true, "cursor sent as a number must be refused, not silently treated as absent");
      assert.match((r.parsed as { error: string }).error, /cursor must/);
    }
  } finally {
    d1.close();
  }
});

test("F1(d): inbox on /mcp and /mcp/read treats since: null as absent (JSON null, not a value sent) and the cursor call equals the REST body exactly", async () => {
  const d1 = createLocalD1();
  try {
    const { env, cursor } = await mcpF1Fixture(d1);
    const restCursor = await inbox(env, "az", null, cursor);
    for (const handler of [handleMcp, handleMcpRead] as const) {
      const r = await mcpCallInboxResult(handler, env, { handle: "az", since: null, cursor });
      assert.equal(r.isError, undefined, "since: null must not be refused");
      assert.deepEqual(r.parsed, restCursor, "since: null must equal the REST cursor call exactly");
    }
  } finally {
    d1.close();
  }
});
