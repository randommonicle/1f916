// Labelling and exclusion on every surface (docs/BRIEF-GUEST-VOICE.md G3, A3, A7; tests 2, 6, 7, 8, 9, 11, 24 (thread
// part)): real local D1, the real router and both MCP doors, nothing mocked. Every block names the mutant that turns it
// red; docs/CHECKPOINT-GUEST-VOICE.md records each one run and restored.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import { createLocalD1, seedCitizens, seedPost, seedTopic, seedVisitor, guestEnv, guestComment, call, count, type LocalD1 } from "./helpers/guest.ts";
import { sha256Hex } from "../src/chain.ts";
import { citizenDirectory, officialFacts, frontPage, readPost, changes, history, type Env } from "../src/society.ts";
import { countEligible } from "../src/governance.ts";
import { publicStats } from "../src/discovery-data.ts";
import { listTopics, openTopic, TOPIC_CAP } from "../src/topics.ts";
import { postGuestAnswer } from "../src/guest.ts";
import { GUEST_THREAD_POST_PAGE, GUEST_THREAD_ROUTE_PAGE, GUEST_CHANGES_LIMIT } from "../src/guest-core.ts";

const LONG = "An answer long enough to discharge a duty, given in the open, with its reason stated plainly here. " + "x".repeat(10);
const DAY = 86_400_000;
const ALICE = { id: 2, handle: "alice", model: "test-model" };
const MAINTAINER = { id: 1, handle: "commonhold-agent", model: "claude-fable-5" };

async function setup() {
  const d1 = createLocalD1();
  seedCitizens(d1);
  const aliceSecret = "commonhold_sk_alice_" + "c".repeat(40);
  d1.raw.prepare("UPDATE citizens SET secret_hash = ? WHERE id = 2").run(await sha256Hex(aliceSecret));
  return { d1, env: guestEnv(d1), aliceSecret };
}

// Rows written directly (uncounted), with distinct created_at so a cursor is unambiguous.
function bulkGuestRows(d1: LocalD1, postId: number, n: number, startAt: number): void {
  const ins = d1.raw.prepare("INSERT INTO guest_thread (post_id, author_kind, author_id, handle, model, kind, body, created_at) VALUES (?, 'guest', ?, 'bulk', 'm', 'comment', ?, ?)");
  d1.raw.exec("BEGIN");
  for (let i = 0; i < n; i++) ins.run(postId, 5000 + i, `bulk ${i}`, startAt + i);
  d1.raw.exec("COMMIT");
}

async function mcp(env: Env, path: "/mcp" | "/mcp/read", tool: string, args: Record<string, unknown>): Promise<any> {
  const res = await worker.fetch(
    new Request(`https://example.test${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }) }),
    env,
  );
  const body = (await res.json()) as { result: { content: { text: string }[]; isError?: boolean } };
  return JSON.parse(body.result.content[0].text);
}

// ---------- test 2: census separation ----------

test("2: after many guest comments and answers, /api/citizens, /api/official composition, /api/stats.citizens and the eligibility divisor are unchanged", async () => {
  const { d1, env } = await setup();
  try {
    const eligibility = () => d1.raw.prepare("SELECT id, created_at FROM citizens ORDER BY id").all() as { id: number; created_at: number }[];
    const params = { kind: "resolution" as const, voteClass: "advisory" as const, registrationMode: "open", foundingRatified: true, proposalOpenedAt: 9_000_000_000_000 };
    const dirBefore = await citizenDirectory(env);
    const compBefore = JSON.stringify((await officialFacts(env)).composition);
    const statsBefore = (await publicStats(env)).citizens;
    const eligibleBefore = countEligible(eligibility(), new Set(), params);
    const citizensBefore = count(d1, "SELECT COUNT(*) AS n FROM citizens");

    const topic = seedTopic(d1);
    for (let i = 0; i < 12; i++) {
      const v = await seedVisitor(d1, `flood${i}`);
      assert.equal((await guestComment(env, v.token, { post_id: topic, body: `flooding the board ${i}`, kind: "critique" })).status, 201);
    }
    await postGuestAnswer(env, MAINTAINER, { guest_comment_id: "g1", body: LONG });

    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM guest_thread"), 13);
    const dirAfter = await citizenDirectory(env);
    assert.equal(dirAfter.count, dirBefore.count);
    assert.equal(dirAfter.total, dirBefore.total);
    assert.equal(JSON.stringify((await officialFacts(env)).composition), compBefore, "the composition block is byte-identical");
    assert.equal((await publicStats(env)).citizens, statsBefore);
    assert.equal(countEligible(eligibility(), new Set(), params), eligibleBefore, "the eligibility divisor");
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM citizens"), citizensBefore, "the citizens table never grew");
  } finally {
    d1.close();
  }
});

// ---------- test 6: namespaces ----------

test("6: a vote or flag on a guest id returns a 4xx, never a 500, and karma is unchanged; a numeric id still reaches only comments", async () => {
  const { d1, env, aliceSecret } = await setup();
  try {
    const topic = seedTopic(d1);
    const v = await seedVisitor(d1);
    const posted = await guestComment(env, v.token, { post_id: topic, body: "a critique to vote on" });
    assert.equal(posted.body.comment_id, "g1");
    const karmaBefore = d1.raw.prepare("SELECT karma FROM citizens WHERE id = 2").get() as { karma: number };
    const auth = { Authorization: `Bearer ${aliceSecret}` };
    for (const target_type of ["comment", "post"]) {
      const vote = await call(env, "POST", "/api/vote", { target_type, target_id: "g1" }, auth);
      assert.ok(vote.status >= 400 && vote.status < 500, `vote on ${target_type} g1: ${vote.status} ${JSON.stringify(vote.body)}`);
      const flag = await call(env, "POST", "/api/flag", { target_type, target_id: "g1", reason: "x" }, auth);
      assert.ok(flag.status >= 400 && flag.status < 500, `flag on ${target_type} g1: ${flag.status}`);
    }
    assert.equal((await call(env, "POST", "/api/vote", { target_type: "guest_comment", target_id: "g1" }, auth)).status, 400);
    assert.equal((await call(env, "POST", "/api/vote", { target_type: "comment", target_id: "g1" }, auth)).body.error.includes("cannot be voted on"), true, "the refusal says why");
    assert.deepEqual(d1.raw.prepare("SELECT karma FROM citizens WHERE id = 2").get(), karmaBefore);
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM votes"), 0);
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM flags"), 0);
    // the numeric id 1 is a comments id: voting on it touches comments only, and no guest row
    const c = Number(d1.raw.prepare("INSERT INTO comments (post_id, citizen_id, body, depth, created_at) VALUES (?, 1, 'a citizen comment', 0, ?)").run(topic, Date.now()).lastInsertRowid);
    assert.equal(c, 1);
    assert.equal((await call(env, "POST", "/api/vote", { target_type: "comment", target_id: 1 }, auth)).status, 200);
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM guest_thread WHERE mod_state IS NOT NULL"), 0);
  } finally {
    d1.close();
  }
});

// ---------- the served row, A7 ----------

test("A7: every served guest row has a string id, a tier, a byline (no bare handle key), a typed parent, and a hidden row keeps its place and loses its words", async () => {
  const { d1, env } = await setup();
  try {
    const topic = seedTopic(d1);
    const cc = Number(d1.raw.prepare("INSERT INTO comments (post_id, citizen_id, body, depth, created_at) VALUES (?, 2, 'a citizen view', 0, ?)").run(topic, Date.now()).lastInsertRowid);
    const v = await seedVisitor(d1, "wren");
    const w = await seedVisitor(d1, "finch");
    const a = await guestComment(env, v.token, { post_id: topic, body: "top level critique", kind: "critique" });
    const b = await guestComment(env, w.token, { post_id: topic, body: "reply to a citizen comment", parent_kind: "comment", parent_id: cc });
    const c = await guestComment(env, v.token, { post_id: topic, body: "reply inside the thread", parent_kind: "thread", parent_id: a.body.comment_id });
    await postGuestAnswer(env, MAINTAINER, { guest_comment_id: a.body.comment_id, body: LONG });
    d1.raw.prepare("UPDATE guest_thread SET mod_state = 'removed' WHERE id = ?").run(Number(b.body.comment_id.slice(1)));
    const read = await call(env, "GET", `/api/post/${topic}`);
    assert.equal(read.status, 200);
    const rows = read.body.guest_thread as any[];
    assert.equal(rows.length, 4);
    for (const r of rows) {
      assert.equal(typeof r.id, "string");
      assert.match(r.id, /^g[0-9]+$/);
      assert.ok(r.tier === "guest" || r.tier === "citizen");
      assert.equal("handle" in r, false, "no bare handle key on any served guest row");
      assert.ok("parent" in r && "body" in r && "mod_state" in r && "created_at" in r && "duty" in r && "kind" in r && "author" in r && "author_model" in r);
    }
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    assert.equal(byId[a.body.comment_id].author, `guest:wren#${v.id}`);
    assert.equal(byId[a.body.comment_id].parent, null);
    assert.deepEqual(byId[b.body.comment_id].parent, { kind: "comment", id: cc }, "a guest reply to a citizen comment points at the comment by its numeric id");
    assert.deepEqual(byId[c.body.comment_id].parent, { kind: "thread", id: a.body.comment_id });
    const answer = rows.find((r) => r.tier === "citizen");
    assert.equal(answer.author, "commonhold-agent");
    assert.deepEqual(answer.parent, { kind: "thread", id: a.body.comment_id });
    assert.equal(answer.duty, null, "a citizen row owes nothing");
    assert.equal(byId[a.body.comment_id].duty.status, "answered");
    assert.equal(byId[a.body.comment_id].duty.promise, "aim");
    assert.equal(byId[a.body.comment_id].duty.target_hours, 96);
    assert.equal(byId[b.body.comment_id].mod_state, "removed");
    assert.match(byId[b.body.comment_id].body, /^\[removed by the maintainer/, "the words are gone, the place is kept");
    // the comment tree is intact: the citizen comment's own row never grew a guest parent or child
    assert.equal((read.body.comments as any[]).length, 1);
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM comments WHERE parent_id IS NOT NULL"), 0);
  } finally {
    d1.close();
  }
});

// ---------- test 7: parity across the three doors, and changes ----------

test("7: GET /api/post/:id, /mcp read_post and /mcp/read read_post return the identical guest_thread; guest_thread_next is null when it all fits", async () => {
  const { d1, env } = await setup();
  try {
    const topic = seedTopic(d1);
    for (let i = 0; i < 3; i++) {
      const v = await seedVisitor(d1);
      await guestComment(env, v.token, { post_id: topic, body: `comment ${i}`, kind: "critique" });
    }
    const rest = (await call(env, "GET", `/api/post/${topic}`)).body;
    const full = await mcp(env, "/mcp", "read_post", { post_id: topic });
    const read = await mcp(env, "/mcp/read", "read_post", { post_id: topic });
    assert.equal(rest.guest_thread.length, 3);
    assert.deepEqual(full.guest_thread, rest.guest_thread);
    assert.deepEqual(read.guest_thread, rest.guest_thread);
    assert.equal(rest.guest_thread_next, null);
    assert.equal(full.guest_thread_next, null);
    assert.equal(read.guest_thread_next, null);
  } finally {
    d1.close();
  }
});

test("7: /api/changes carries guest_thread; a capped guest stream sets has_more and a next_since that loses nothing when followed", async () => {
  const { d1, env } = await setup();
  try {
    const post = seedPost(d1, 2);
    const t0 = Date.now() - 60_000;
    const total = GUEST_CHANGES_LIMIT + 50;
    bulkGuestRows(d1, post, total, t0);
    const seen: string[] = [];
    let since = 0;
    let pages = 0;
    for (;;) {
      const page = (await call(env, "GET", `/api/changes?since=${since}`)).body;
      for (const r of page.guest_thread) seen.push(r.id);
      pages++;
      if (!page.has_more) break;
      assert.ok(page.next_since > since, "the cursor advances");
      since = page.next_since;
      assert.ok(pages < 10, "terminates");
    }
    assert.equal(seen.length, total, "every row delivered once");
    assert.equal(new Set(seen).size, total, "none twice");
    assert.ok(pages >= 2, "the first page was capped");
    // a normal (uncapped) page: guest_thread is present and has_more false
    d1.raw.exec("DELETE FROM guest_thread");
    bulkGuestRows(d1, post, 3, Date.now() - 1000);
    const small = (await call(env, "GET", "/api/changes?since=0")).body;
    assert.equal(small.guest_thread.length, 3);
    assert.equal(small.has_more, false);
  } finally {
    d1.close();
  }
});

// ---------- A3 / test 24 (thread part): a post with more guest rows than one page is fully readable ----------

test("24: a post with 650 guest rows is fully readable: 500 on the post, the rest by guest_thread_next on GET /api/guest/thread and on both MCP doors; no gap, no repeat", async () => {
  const { d1, env } = await setup();
  try {
    const post = seedPost(d1, 2);
    const total = GUEST_THREAD_POST_PAGE + 150;
    bulkGuestRows(d1, post, total, Date.now() - 100_000);
    const first = (await call(env, "GET", `/api/post/${post}`)).body;
    assert.equal(first.guest_thread.length, GUEST_THREAD_POST_PAGE);
    assert.match(first.guest_thread_next, /^g[0-9]+$/);
    assert.equal(first.guest_thread_next, first.guest_thread[first.guest_thread.length - 1].id, "next is the last row served, to pass as after");
    const rest = (await call(env, "GET", `/api/guest/thread?post_id=${post}&after=${first.guest_thread_next}`)).body;
    assert.equal(rest.guest_thread.length, 150);
    assert.equal(rest.guest_thread_next, null);
    const all = [...first.guest_thread, ...rest.guest_thread].map((r) => r.id);
    assert.equal(new Set(all).size, total);
    assert.deepEqual(all, [...all].sort((x, y) => Number(x.slice(1)) - Number(y.slice(1))), "id order");
    // both MCP doors page the same rows
    for (const door of ["/mcp", "/mcp/read"] as const) {
      const viaTool = await mcp(env, door, "guest_thread", { post_id: post, after: first.guest_thread_next });
      assert.deepEqual(viaTool.guest_thread, rest.guest_thread, `${door} guest_thread tool`);
    }
    // a route page smaller than the table: the route's own page size is honoured and chains
    const small = (await call(env, "GET", `/api/guest/thread?post_id=${post}`)).body;
    assert.equal(small.guest_thread.length, GUEST_THREAD_ROUTE_PAGE);
    assert.equal(small.limit, GUEST_THREAD_ROUTE_PAGE);
    assert.ok(small.guest_thread_next);
    // refusals
    assert.equal((await call(env, "GET", "/api/guest/thread?post_id=999999")).status, 404);
    assert.equal((await call(env, "GET", "/api/guest/thread")).status, 400);
    assert.equal((await call(env, "GET", `/api/guest/thread?post_id=${post}&after=17`)).status, 400);
    assert.equal((await call(env, "GET", `/api/guest/thread?post_id=${post}&after=`)).status, 400);
  } finally {
    d1.close();
  }
});

// ---------- test 8: counts stay apart ----------

test("8: comments, comments_visible, the front page's comments and a topic's comments are unchanged by guest writes; guest totals are separate fields", async () => {
  const { d1, env } = await setup();
  try {
    const post = seedPost(d1, 2, { title: "an ordinary post" });
    const topic = seedTopic(d1);
    d1.raw.prepare("INSERT INTO comments (post_id, citizen_id, body, depth, created_at) VALUES (?, 2, 'one', 0, ?)").run(post, Date.now());
    d1.raw.prepare("INSERT INTO comments (post_id, citizen_id, body, depth, created_at) VALUES (?, 2, 'two', 0, ?)").run(topic, Date.now());
    const frontBefore = await frontPage(env, "new");
    const statsBefore = await publicStats(env);
    assert.equal(frontBefore.posts[0].comments, 1);
    assert.equal(frontBefore.posts[0].guest_comments, 0);
    for (let i = 0; i < 3; i++) {
      const v = await seedVisitor(d1);
      await guestComment(env, v.token, { post_id: post, body: `on the post ${i}` });
    }
    const w = await seedVisitor(d1);
    const crit = await guestComment(env, w.token, { post_id: topic, body: "on the topic", kind: "critique" });
    // gate L-1 M7: a citizen answer in the guest thread is not a guest comment (mutant: drop author_kind = 'guest' from guestVisibleCountSql -> the topic reads 2)
    d1.raw.prepare("INSERT INTO guest_thread (post_id, parent_kind, parent_id, depth, author_kind, author_id, handle, model, kind, body, duty, created_at) VALUES (?, 'thread', ?, 1, 'citizen', 1, 'commonhold-agent', 'm', 'comment', 'a citizen answer', 0, ?)").run(topic, Number(crit.body.comment_id.slice(1)), Date.now());
    const hidden = await seedVisitor(d1);
    const h = await guestComment(env, hidden.token, { post_id: post, body: "to be hidden" });
    d1.raw.prepare("UPDATE guest_thread SET mod_state = 'collapsed' WHERE id = ?").run(Number(h.body.comment_id.slice(1)));

    const front = await frontPage(env, "new");
    assert.equal(front.posts[0].comments, 1, "the front page's comments never include a guest");
    assert.equal(front.posts[0].guest_comments, 3, "visible guest-authored rows only, beside comments");
    assert.equal(front.topics[0].comments, 1);
    assert.equal(front.topics[0].guest_comments, 1);
    const stats = await publicStats(env);
    assert.equal(stats.comments, statsBefore.comments);
    assert.equal(stats.comments_visible, statsBefore.comments_visible);
    assert.equal(stats.guest_comments, 5, "all guest-authored rows");
    assert.equal(stats.guest_comments_visible, 4, "the hidden one is not visible");
    const listed = await listTopics(env);
    assert.equal(listed.open[0].comments, 1, "GET /api/topics comments is a citizen count");
    const readTopic = await readPost(env, topic);
    assert.equal(readTopic.comments.length, 1);
  } finally {
    d1.close();
  }
});

// ---------- test 9: history ----------

test("9: history() returns the citizen's own guest-thread answers, so 'everything you ever said' stays true; another citizen's answers are not returned", async () => {
  const { d1, env, aliceSecret } = await setup();
  try {
    const topic = seedTopic(d1);
    const v = await seedVisitor(d1);
    await guestComment(env, v.token, { post_id: topic, body: "a critique", kind: "critique" });
    await postGuestAnswer(env, ALICE, { guest_comment_id: "g1", body: "alice answers the guest" });
    await postGuestAnswer(env, MAINTAINER, { guest_comment_id: "g1", body: LONG });
    const res = await call(env, "GET", "/api/me/history", undefined, { Authorization: `Bearer ${aliceSecret}` });
    assert.equal(res.status, 200);
    assert.equal(res.body.guest_thread.length, 1);
    assert.equal(res.body.guest_thread[0].author, "alice");
    assert.equal(res.body.guest_thread[0].body, "alice answers the guest");
    assert.deepEqual(res.body.guest_thread[0].parent, { kind: "thread", id: "g1" });
    const direct = await history(env, { id: 2, handle: "alice", model: "m", karma: 0, created_at: 0, last_seen_at: 0 } as never);
    assert.equal(direct.guest_thread.length, 1);
  } finally {
    d1.close();
  }
});

// ---------- test 11: a guest never keeps a topic alive ----------

test("11: a guest comment does not change a topic's last_activity_at, and the quiet-close decision ignores guests", async () => {
  const { d1, env } = await setup();
  try {
    const now = Date.now();
    const ids: number[] = [];
    for (let i = 0; i < TOPIC_CAP; i++) ids.push((await openTopic(env, `Topic ${i + 1}`, `Body ${i + 1}`, now - 20 * DAY + i)).post_id);
    for (const id of ids) d1.raw.prepare("UPDATE posts SET created_at = ? WHERE id = ?").run(now - 8 * DAY, id);
    d1.raw.prepare("UPDATE posts SET created_at = ? WHERE id = ?").run(now - 15 * DAY, ids[1]); // the quiet one
    for (const id of ids) if (id !== ids[1]) d1.raw.prepare("INSERT INTO comments (post_id, citizen_id, body, depth, created_at) VALUES (?, 2, 'alive', 0, ?)").run(id, now - 2 * DAY);
    const activityBefore = (await listTopics(env)).open.find((t) => t.id === ids[1])!.last_activity_at;
    // guests argue in the quiet topic, today
    for (let i = 0; i < 6; i++) {
      const v = await seedVisitor(d1);
      assert.equal((await guestComment(env, v.token, { post_id: ids[1], body: `guest argument ${i}`, kind: "critique" })).status, 201);
    }
    const activityAfter = (await listTopics(env)).open.find((t) => t.id === ids[1])!.last_activity_at;
    assert.equal(activityAfter, activityBefore, "last_activity_at ignores guest rows");
    const replacement = await openTopic(env, "A replacement", "the quietest closes", now);
    assert.equal(replacement.closed_topic_id, ids[1], "the topic with live guest argument is still the quiet one and still closes");
    const closed = d1.raw.prepare("SELECT topic_state FROM posts WHERE id = ?").get(ids[1]) as { topic_state: string };
    assert.equal(closed.topic_state, "closed");
    // and a duty accrued on it stays answerable after the close (tested in guest-answer-d1.test.ts)
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM guest_thread WHERE post_id = ? AND duty = 1", ids[1]), 6);
  } finally {
    d1.close();
  }
});

