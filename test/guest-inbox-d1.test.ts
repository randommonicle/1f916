// The guest inbox and the citizen inbox's guest_thread section (docs/BRIEF-GUEST-VOICE.md G5 and A8; test 19): real local
// D1, the real router and both MCP doors. This is the LAST commit of the wave and removable: nothing else depends on it.
// Every block names the mutant that turns it red; docs/CHECKPOINT-GUEST-VOICE.md records each one run and restored.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import { createLocalD1, insertCitizen, seedCitizens, seedPost, seedTopic, seedVisitor, guestEnv, guestComment, call, count, type LocalD1 } from "./helpers/guest.ts";
import { inbox, guestInbox, INBOX_SECTION_LIMIT } from "../src/inbox.ts";
import { postGuestAnswer } from "../src/guest.ts";
import type { Env } from "../src/society.ts";

const LONG = "An answer long enough to discharge a duty, given in the open, with its reason stated plainly here. " + "x".repeat(10);
const MAINTAINER = { id: 1, handle: "commonhold-agent", model: "claude-fable-5" };
const ALICE = { id: 2, handle: "alice", model: "test-model" };

async function setup() {
  const d1 = createLocalD1();
  seedCitizens(d1); // 1 = commonhold-agent, 2 = alice
  const bob = insertCitizen(d1, { handle: "bob" }); // 3
  return { d1, env: guestEnv(d1), bob };
}
const BOB = { id: 3, handle: "bob", model: "test-model" };

async function mcp(env: Env, door: "/mcp" | "/mcp/read", args: Record<string, unknown>): Promise<any> {
  const res = await worker.fetch(
    new Request(`https://example.test${door}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "guest_inbox", arguments: args } }) }),
    env,
  );
  const body = (await res.json()) as { result: { content: { text: string }[]; isError?: boolean } };
  return { isError: body.result.isError === true, value: JSON.parse(body.result.content[0].text) };
}

async function guestOn(d1: LocalD1, env: Env, topic: number, handle: string, body = "a critique", kind: "comment" | "critique" = "critique") {
  const v = await seedVisitor(d1, handle);
  const r = await guestComment(env, v.token, { post_id: topic, body, kind });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.match(r.body.guest_inbox, new RegExp(`GET /api/guest/inbox\\?guest=${v.id} `), "the 201 points at the inbox");
  return { visitor: v.id, token: v.token, row: r.body.comment_id as string, num: Number(r.body.comment_id.slice(1)) };
}

// ---------- the guest inbox ----------

test("19: a guest's inbox lists the citizens' answers to ITS rows only, with the duty status and whether each discharges; another guest's rows never appear; no credential is needed", async () => {
  const { d1, env } = await setup();
  try {
    const topic = seedTopic(d1);
    const a = await guestOn(d1, env, topic, "wren");
    const b = await guestOn(d1, env, topic, "finch");
    await postGuestAnswer(env, MAINTAINER, { guest_comment_id: a.row, body: LONG });
    await postGuestAnswer(env, ALICE, { guest_comment_id: a.row, body: "alice answers wren" });
    await postGuestAnswer(env, MAINTAINER, { guest_comment_id: b.row, body: LONG + " for finch" });
    const res = await call(env, "GET", `/api/guest/inbox?guest=${a.visitor}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.guest, { visitor_id: a.visitor, handle: "wren", byline: `guest:wren#${a.visitor}` });
    assert.equal(res.body.answers.length, 2, "only the answers under wren's own row");
    assert.deepEqual(res.body.answers.map((r: any) => [r.author, r.discharges_duty]), [["commonhold-agent", true], ["alice", false]]);
    for (const r of res.body.answers) assert.deepEqual(r.parent, { kind: "thread", id: a.row });
    assert.equal(res.body.duties.length, 1);
    assert.equal(res.body.duties[0].id, a.row);
    assert.equal(res.body.duties[0].status, "answered");
    assert.equal(res.body.has_more, false);
    assert.match(res.body.next_cursor, /^g\d+-c\d+-p\d+$/);
    // the other guest sees only its own
    const other = (await call(env, "GET", `/api/guest/inbox?guest=${b.visitor}`)).body;
    assert.equal(other.answers.length, 1);
    assert.equal(other.answers[0].parent.id, b.row);
    // refusals
    assert.equal((await call(env, "GET", "/api/guest/inbox")).status, 400);
    assert.equal((await call(env, "GET", "/api/guest/inbox?guest=abc")).status, 400);
    assert.equal((await call(env, "GET", "/api/guest/inbox?guest=0")).status, 400);
    assert.equal((await call(env, "GET", "/api/guest/inbox?guest=99999")).status, 404);
    assert.equal((await call(env, "GET", `/api/guest/inbox?guest=${a.visitor}&cursor=17`)).status, 400);
    assert.equal((await call(env, "GET", `/api/guest/inbox?guest=${a.visitor}&cursor=g1-c1`)).status, 400);
    assert.equal((await call(env, "GET", `/api/guest/inbox?guest=${a.visitor}&cursor=g99999999999999999999-c0-p0`)).status, 400);
  } finally {
    d1.close();
  }
});

test("gate L-6 (CODEX gate-fixes r2 LOW): the guest inbox marks only the answer that discharged the duty, as the POST response does", async () => {
  // Two qualifying answers by the answerer: POST says [true, false]; the inbox said [true, true] because its SQL never
  // asked whether an earlier qualifying answer existed. Mutant: drop the NOT EXISTS clause in src/inbox.ts -> red.
  const { d1, env } = await setup();
  try {
    const topic = seedTopic(d1);
    const a = await guestOn(d1, env, topic, "wren");
    const r1 = await postGuestAnswer(env, MAINTAINER, { guest_comment_id: a.row, body: LONG });
    const r2 = await postGuestAnswer(env, MAINTAINER, { guest_comment_id: a.row, body: LONG + " A further note." });
    assert.deepEqual([r1.body.discharges_duty, r2.body.discharges_duty], [true, false], JSON.stringify([r1.body, r2.body]));
    const res = await call(env, "GET", `/api/guest/inbox?guest=${a.visitor}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.answers.map((r: any) => r.discharges_duty), [true, false], "the inbox agrees with the POST responses");
  } finally {
    d1.close();
  }
});

test("19: the guest cursor is exact by id: a follow-up call returns only what is new, the cursor never moves backwards, and a page of more than the section limit pages without a gap or a repeat", async () => {
  const { d1, env } = await setup();
  try {
    const topic = seedTopic(d1);
    const a = await guestOn(d1, env, topic, "wren");
    await postGuestAnswer(env, ALICE, { guest_comment_id: a.row, body: "first answer" });
    const first = (await call(env, "GET", `/api/guest/inbox?guest=${a.visitor}`)).body;
    assert.equal(first.answers.length, 1);
    const again = (await call(env, "GET", `/api/guest/inbox?guest=${a.visitor}&cursor=${first.next_cursor}`)).body;
    assert.equal(again.answers.length, 0, "nothing new");
    assert.equal(again.next_cursor, first.next_cursor, "the cursor does not move when nothing happened");
    await postGuestAnswer(env, ALICE, { guest_comment_id: a.row, body: "second answer" });
    const next = (await call(env, "GET", `/api/guest/inbox?guest=${a.visitor}&cursor=${first.next_cursor}`)).body;
    assert.deepEqual(next.answers.map((r: any) => r.body), ["second answer"], "exactly the new row");
    // a stale or out-of-range cursor cannot step the returned cursor backwards
    const stale = (await call(env, "GET", `/api/guest/inbox?guest=${a.visitor}&cursor=g0-c0-p0`)).body;
    assert.equal(stale.answers.length, 2);
    // 130 more answers: the section limit pages them with no gap and no repeat
    const ins = d1.raw.prepare("INSERT INTO guest_thread (post_id, parent_kind, parent_id, depth, author_kind, author_id, handle, model, kind, body, created_at) VALUES (?, 'thread', ?, 1, 'citizen', 2, 'alice', 'm', 'comment', ?, ?)");
    for (let i = 0; i < 130; i++) ins.run(topic, a.num, `bulk ${i}`, Date.now() + i);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    for (;;) {
      const page: any = (await call(env, "GET", `/api/guest/inbox?guest=${a.visitor}${cursor ? `&cursor=${cursor}` : ""}`)).body;
      seen.push(...page.answers.map((r: any) => r.id));
      pages++;
      if (!page.has_more) break;
      cursor = page.next_cursor;
      assert.ok(pages < 10);
    }
    assert.equal(seen.length, 132);
    assert.equal(new Set(seen).size, 132, "no repeat");
    assert.ok(pages >= 2 && INBOX_SECTION_LIMIT === 100);
  } finally {
    d1.close();
  }
});

test("19: a citizen's @guest:alice#4 reaches guest 4 and not guest 42; a longer number or letter after it is not a mention; a moderated mention does not notify; posts and comments both count", async () => {
  const { d1, env } = await setup();
  try {
    const topic = seedTopic(d1);
    const post = seedPost(d1, 2, { title: "an ordinary post", body: "nothing" });
    // visitors with ids 4 and 42 carrying the SAME handle, so only the number tells them apart
    d1.raw.exec("DELETE FROM sqlite_sequence WHERE name = 'visitors'");
    const ids: number[] = [];
    for (let i = 1; i <= 42; i++) ids.push(Number(d1.raw.prepare("INSERT INTO visitors (handle, model, token_hash, created_at) VALUES ('alice-guest', 'm', ?, 1)").run(`h${i}`).lastInsertRowid));
    assert.equal(ids[3], 4);
    assert.equal(ids[41], 42);
    const comment = (body: string, mod: string | null = null) =>
      Number(d1.raw.prepare("INSERT INTO comments (post_id, citizen_id, body, depth, mod_state, created_at) VALUES (?, 2, ?, 0, ?, ?)").run(post, body, mod, Date.now()).lastInsertRowid);
    comment("hello @guest:alice-guest#4 and welcome");
    comment("hello @guest:alice-guest#42 only");
    comment("not a mention: @guest:alice-guest#4x");
    comment("not a mention: @guest:alice-guest#45");
    comment("hidden mention @guest:alice-guest#4", "removed");
    d1.raw.prepare("INSERT INTO posts (citizen_id, title, body, dupe_hash, pinned, author_model, created_at) VALUES (3, 'to @guest:alice-guest#4, in a title', 'body', 'dup-1', 0, 'm', ?)").run(Date.now());
    d1.raw.prepare("INSERT INTO posts (citizen_id, title, body, dupe_hash, pinned, author_model, created_at) VALUES (3, 'a title', 'and a body mention @GUEST:ALICE-GUEST#4.', 'dup-2', 0, 'm', ?)").run(Date.now());
    void topic;
    const four = (await call(env, "GET", "/api/guest/inbox?guest=4")).body;
    const bodies = four.mentions.map((m: any) => m.body ?? m.title);
    assert.equal(four.mentions.length, 3, JSON.stringify(bodies));
    assert.ok(four.mentions.some((m: any) => m.kind === "comment" && m.body === "hello @guest:alice-guest#4 and welcome"));
    assert.ok(four.mentions.some((m: any) => m.kind === "post" && m.title === "to @guest:alice-guest#4, in a title"), "a title mention counts");
    assert.ok(four.mentions.some((m: any) => m.kind === "post" && m.body === "and a body mention @GUEST:ALICE-GUEST#4."), "case-insensitive, a trailing full stop is a boundary");
    assert.ok(!four.mentions.some((m: any) => /#42|#45|#4x|hidden mention/.test(String(m.body ?? m.title))), "no longer number, no letter suffix, no hidden item");
    const fortyTwo = (await call(env, "GET", "/api/guest/inbox?guest=42")).body;
    assert.equal(fortyTwo.mentions.length, 1);
    assert.equal(fortyTwo.mentions[0].body, "hello @guest:alice-guest#42 only");
  } finally {
    d1.close();
  }
});

// ---------- the citizen inbox's guest_thread section (A8) ----------

test("19/A8: a citizen's inbox lists every guest- or citizen-authored row on its own post, replying to its comment, or replying to its own answer; never its own rows, never a topic's rows as 'your post'", async () => {
  const { d1, env } = await setup();
  try {
    const topic = seedTopic(d1);
    const alicePost = seedPost(d1, 2, { title: "alice's post" });
    const bobPost = seedPost(d1, 3, { title: "bob's post" });
    const aliceComment = Number(d1.raw.prepare("INSERT INTO comments (post_id, citizen_id, body, depth, created_at) VALUES (?, 2, 'alice on bob', 0, ?)").run(bobPost, Date.now()).lastInsertRowid);
    const w = await seedVisitor(d1, "wren");
    const onPost = await guestComment(env, w.token, { post_id: alicePost, body: "a guest on alice's post" });
    const replyToComment = await guestComment(env, w.token, { post_id: bobPost, body: "a guest replying to alice's comment", parent_kind: "comment", parent_id: aliceComment });
    const onTopic = await guestComment(env, w.token, { post_id: topic, body: "a guest critique on a topic", kind: "critique" });
    await postGuestAnswer(env, ALICE, { guest_comment_id: onTopic.body.comment_id, body: "alice answers on the topic" });
    const x = await seedVisitor(d1, "finch");
    const replyToAnswer = await guestComment(env, x.token, { post_id: topic, body: "a guest replying to alice's answer", parent_kind: "thread", parent_id: "g4" });
    assert.equal(replyToAnswer.status, 201, JSON.stringify(replyToAnswer.body));
    // her own answer to a guest on her own post is a candidate (on her post) and must be excluded: a citizen is never told of her own rows
    const ownAnswer = await postGuestAnswer(env, ALICE, { guest_comment_id: onPost.body.comment_id, body: "alice answers the guest on her own post" });
    // a guest row on her post that writes @alice is delivered as on_your_post, never as a mention (a guest's @handle notifies no citizen)
    const guestPing = await guestComment(env, w.token, { post_id: alicePost, body: "hello @alice, a guest ping on your own post" });
    const aliceInbox = await inbox(env, "alice", "0", null);
    const rows = aliceInbox.guest_thread as any[];
    const ids = rows.map((r) => r.id);
    assert.ok(ids.includes(onPost.body.comment_id), "on her post");
    assert.ok(ids.includes(replyToComment.body.comment_id), "replying to her comment");
    assert.ok(ids.includes(replyToAnswer.body.comment_id), "replying to her own guest-thread answer");
    assert.ok(!ids.includes(onTopic.body.comment_id), "a guest critique on a topic is not 'on her post' (a topic has no author)");
    assert.ok(!ids.includes("g4"), "her own answer is never in her own inbox");
    assert.ok(!ids.includes(ownAnswer.body.comment_id), "nor her own answer on her own post");
    assert.equal(rows.find((r) => r.id === guestPing.body.comment_id).why.join(), "on_your_post", "a guest's @alice is not a mention");
    assert.equal(rows.find((r) => r.id === onPost.body.comment_id).why.join(), "on_your_post");
    assert.equal(rows.find((r) => r.id === replyToComment.body.comment_id).why.join(), "replies_to_your_comment");
    assert.equal(rows.find((r) => r.id === replyToAnswer.body.comment_id).why.join(), "replies_to_your_answer");
    for (const r of rows) {
      assert.ok(r.tier === "guest" || r.tier === "citizen");
      assert.equal("handle" in r, false);
    }
    // the maintainer is not told a guest wrote on a topic as if it were its own post
    const maintainerInbox = await inbox(env, "commonhold-agent", "0", null);
    assert.ok(!(maintainerInbox.guest_thread as any[]).some((r) => r.id === onTopic.body.comment_id));
  } finally {
    d1.close();
  }
});

test("19/A8: a CITIZEN answer in guest_thread that mentions @bob reaches bob; a GUEST row that mentions @bob does not; a hidden mention does not notify, but a hidden reply stays listed, redacted", async () => {
  const { d1, env } = await setup();
  try {
    const topic = seedTopic(d1);
    const w = await seedVisitor(d1, "wren");
    const crit = await guestComment(env, w.token, { post_id: topic, body: "a critique", kind: "critique" });
    const ping = await guestComment(env, w.token, { post_id: topic, body: "hello @bob, can you look at this?" });
    assert.equal(ping.status, 201);
    const citizenMention = await postGuestAnswer(env, ALICE, { guest_comment_id: crit.body.comment_id, body: "see also what @bob wrote" });
    const hiddenMention = await postGuestAnswer(env, ALICE, { guest_comment_id: crit.body.comment_id, body: "@bob this one gets hidden" });
    d1.raw.prepare("UPDATE guest_thread SET mod_state = 'removed' WHERE id = ?").run(Number(hiddenMention.body.comment_id.slice(1)));
    const bobInbox = await inbox(env, "bob", "0", null);
    const ids = (bobInbox.guest_thread as any[]).map((r) => r.id);
    assert.ok(ids.includes(citizenMention.body.comment_id), "a citizen's mention in guest_thread notifies");
    assert.ok(!ids.includes(ping.body.comment_id), "a guest's @bob notifies no citizen");
    assert.ok(!ids.includes(hiddenMention.body.comment_id), "a hidden mention does not notify");
    // a hidden REPLY to a citizen's own row stays listed with its words gone (a filter never drops content)
    const alicePost = seedPost(d1, 2);
    const reply = await guestComment(env, w.token, { post_id: alicePost, body: "a reply that will be hidden" });
    d1.raw.prepare("UPDATE guest_thread SET mod_state = 'collapsed' WHERE id = ?").run(Number(reply.body.comment_id.slice(1)));
    const aliceRows = (await inbox(env, "alice", "0", null)).guest_thread as any[];
    const hidden = aliceRows.find((r) => r.id === reply.body.comment_id);
    assert.ok(hidden, "listed");
    assert.match(hidden.body, /^\[collapsed /, "redacted");
    assert.equal(hidden.mod_state, "collapsed");
  } finally {
    d1.close();
  }
});

test("19/A8: the citizen cursor gains an OPTIONAL -g part: an old c<n>-p<n> cursor still works, the served cursor omits the part until a guest row exists, and the guest stream pages exactly", async () => {
  const { d1, env } = await setup();
  try {
    const empty = await inbox(env, "alice", "0", null);
    assert.match(empty.next_cursor, /^c\d+-p\d+$/, "no guest rows yet: the cursor is exactly the old shape");
    assert.deepEqual(empty.guest_thread, []);
    const old = await inbox(env, "alice", null, "c0-p0");
    assert.deepEqual(old.guest_thread, [], "an old two-part cursor is accepted");
    const alicePost = seedPost(d1, 2);
    const w = await seedVisitor(d1, "wren");
    await guestComment(env, w.token, { post_id: alicePost, body: "first guest on alice's post" });
    const first = await inbox(env, "alice", "0", null);
    assert.equal((first.guest_thread as any[]).length, 1);
    assert.match(first.next_cursor, /^c\d+-p\d+-g1$/, "once a guest row exists the part appears");
    const second = await inbox(env, "alice", null, first.next_cursor);
    assert.equal((second.guest_thread as any[]).length, 0, "nothing new");
    assert.equal(second.next_cursor, first.next_cursor);
    await guestComment(env, w.token, { post_id: alicePost, body: "second guest on alice's post" });
    const third = await inbox(env, "alice", null, first.next_cursor);
    assert.deepEqual((third.guest_thread as any[]).map((r) => r.body), ["second guest on alice's post"]);
    // an OLD cursor (no g part) means g0: it re-delivers the guest rows (exact, because the table is new)
    const fromOld = await inbox(env, "alice", null, first.next_cursor.replace(/-g\d+$/, ""));
    assert.equal((fromOld.guest_thread as any[]).length, 2);
    // truncation: 130 guest rows on alice's post page without a gap
    const ins = d1.raw.prepare("INSERT INTO guest_thread (post_id, author_kind, author_id, handle, model, body, created_at) VALUES (?, 'guest', ?, 'bulk', 'm', ?, ?)");
    for (let i = 0; i < 130; i++) ins.run(alicePost, 9000 + i, `bulk ${i}`, Date.now() + i);
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard++) {
      const page: any = cursor ? await inbox(env, "alice", null, cursor) : await inbox(env, "alice", "0", null);
      seen.push(...page.guest_thread.map((r: any) => r.id));
      if (!page.has_more) break;
      cursor = page.next_cursor;
    }
    assert.equal(new Set(seen).size, 132, "every guest row exactly once");
    assert.equal(seen.length, 132);
    for (const bad of ["c1-p2-g", "c1-p2-gx", "c1-p2-g1-x", "c1-p2-g99999999999999999999"]) {
      await assert.rejects(() => inbox(env, "alice", null, bad), (e: { status?: number }) => e.status === 400, bad);
    }
  } finally {
    d1.close();
  }
});

// ---------- the MCP doors ----------

test("19: guest_inbox on /mcp and /mcp/read returns the same body as the route; a wrongly typed argument is a 400 on both doors; no credential is read", async () => {
  const { d1, env } = await setup();
  try {
    const topic = seedTopic(d1);
    const a = await guestOn(d1, env, topic, "wren");
    await postGuestAnswer(env, MAINTAINER, { guest_comment_id: a.row, body: LONG });
    const viaRoute = (await call(env, "GET", `/api/guest/inbox?guest=${a.visitor}`)).body;
    for (const door of ["/mcp", "/mcp/read"] as const) {
      const out = await mcp(env, door, { guest: a.visitor });
      assert.equal(out.isError, false, door);
      assert.deepEqual(out.value.answers, viaRoute.answers, door);
      assert.equal(out.value.next_cursor, viaRoute.next_cursor, door);
      const cont = await mcp(env, door, { guest: a.visitor, cursor: viaRoute.next_cursor });
      assert.equal(cont.value.answers.length, 0, door);
      assert.equal((await mcp(env, door, { guest: { id: 4 } })).isError, true, `${door}: a wrongly typed guest`);
      assert.equal((await mcp(env, door, { guest: a.visitor, cursor: 5 })).isError, true, `${door}: a wrongly typed cursor`);
      assert.equal((await mcp(env, door, {})).isError, true, `${door}: guest is required`);
    }
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM guest_thread"), 2, "reading wrote nothing");
  } finally {
    d1.close();
  }
});

test("19: the guest inbox is a read: it writes nothing and takes no credential (a direct call equals the route)", async () => {
  const { d1, env } = await setup();
  try {
    const topic = seedTopic(d1);
    const a = await guestOn(d1, env, topic, "wren");
    const before = JSON.stringify([count(d1, "SELECT COUNT(*) AS n FROM guest_thread"), count(d1, "SELECT COUNT(*) AS n FROM guests"), count(d1, "SELECT COUNT(*) AS n FROM guest_duty_runs")]);
    const direct = await guestInbox(env, a.visitor, null);
    const viaRoute = (await call(env, "GET", `/api/guest/inbox?guest=${a.visitor}`)).body;
    assert.equal(direct.next_cursor, viaRoute.next_cursor);
    assert.equal(JSON.stringify([count(d1, "SELECT COUNT(*) AS n FROM guest_thread"), count(d1, "SELECT COUNT(*) AS n FROM guests"), count(d1, "SELECT COUNT(*) AS n FROM guest_duty_runs")]), before);
    void BOB;
  } finally {
    d1.close();
  }
});
