// The duty list and its statuses (docs/BRIEF-GUEST-VOICE.md G4, A3, A11; tests 16, 24's due half, 21's counts half):
// real local D1, the real router and both MCP doors. Statuses are proved against an INJECTED clock; the list is proved
// by paging whole tables. Every block names the mutant that turns it red; docs/CHECKPOINT-GUEST-VOICE.md records each one
// run and restored.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import { createLocalD1, seedCitizens, seedTopic, guestEnv, call, count, type LocalD1 } from "./helpers/guest.ts";
import { officialFacts, type Env } from "../src/society.ts";
import { guestDue, GUEST_CHECK_STALE_MS } from "../src/guest.ts";
import { GUEST_ANSWER_TARGET_HOURS, HOUR_MS } from "../src/guest-core.ts";

const LONG = "An answer long enough to discharge a duty, given in the open, with its reason stated plainly here. " + "x".repeat(10);
const T0 = 1_800_000_000_000; // a fixed 'now' for the status proofs

async function setup() {
  const d1 = createLocalD1();
  seedCitizens(d1);
  return { d1, env: guestEnv(d1) };
}

// A duty row written directly, with a chosen due date; returns its numeric id.
function duty(d1: LocalD1, topic: number, over: Partial<{ due_at: number; created_at: number; author_id: number; mod_state: string | null; handle: string }> = {}): number {
  const created = over.created_at ?? T0 - 100_000;
  const res = d1.raw
    .prepare("INSERT INTO guest_thread (post_id, author_kind, author_id, handle, model, kind, body, mod_state, duty, due_at, created_at) VALUES (?, 'guest', ?, ?, 'm', 'critique', 'a critique', ?, 1, ?, ?)")
    .run(topic, over.author_id ?? 7000 + Math.floor(Math.random() * 1e6), over.handle ?? "gadfly", over.mod_state ?? null, over.due_at ?? created + GUEST_ANSWER_TARGET_HOURS * HOUR_MS, created);
  return Number(res.lastInsertRowid);
}
function answerRow(d1: LocalD1, topic: number, target: number, over: Partial<{ author_id: number; body: string; created_at: number; mod_state: string | null }> = {}): number {
  const res = d1.raw
    .prepare("INSERT INTO guest_thread (post_id, parent_kind, parent_id, depth, author_kind, author_id, handle, model, kind, body, mod_state, created_at) VALUES (?, 'thread', ?, 1, 'citizen', ?, 'commonhold-agent', 'm', 'comment', ?, ?, ?)")
    .run(topic, target, over.author_id ?? 1, over.body ?? LONG, over.mod_state ?? null, over.created_at ?? T0);
  return Number(res.lastInsertRowid);
}
const statusOf = async (env: Env, id: number, now: number): Promise<string | undefined> => {
  const all = [...(await guestDue(env, "actionable", null, null, now)).items, ...(await guestDue(env, "history", null, null, now)).items];
  return all.find((i) => i.id === `g${id}`)?.status as string | undefined;
};

// ---------- test 16: statuses against an injected clock ----------

test("16: open, overdue, answered, answered_late and waived each read correctly against an injected clock; overdue never disappears", async () => {
  const { d1, env } = await setup();
  try {
    const topic = seedTopic(d1);
    const dueAt = T0 + 10_000;
    const open = duty(d1, topic, { due_at: dueAt });
    const overdue = duty(d1, topic, { due_at: T0 - 5_000 });
    const answered = duty(d1, topic, { due_at: T0 + 50_000 });
    answerRow(d1, topic, answered, { created_at: T0 - 1_000 });
    const late = duty(d1, topic, { due_at: T0 - 90_000 });
    answerRow(d1, topic, late, { created_at: T0 - 1_000 });
    const waived = duty(d1, topic, { due_at: T0 - 5_000, mod_state: "collapsed" });
    assert.equal(await statusOf(env, open, T0), "open");
    assert.equal(await statusOf(env, overdue, T0), "overdue");
    assert.equal(await statusOf(env, answered, T0), "answered");
    assert.equal(await statusOf(env, late, T0), "answered_late");
    assert.equal(await statusOf(env, waived, T0), "waived");
    // a row crosses its date: open -> overdue by the clock alone
    assert.equal(await statusOf(env, open, dueAt - 1), "open");
    assert.equal(await statusOf(env, open, dueAt + 1), "overdue");
    // an overdue duty NEVER disappears from the actionable view, however far the clock runs
    const years = T0 + 5 * 365 * 86_400_000;
    const view = await guestDue(env, "actionable", null, null, years);
    assert.ok(view.items.some((i) => i.id === `g${overdue}` && i.status === "overdue"));
    assert.ok(view.items.some((i) => i.id === `g${open}` && i.status === "overdue"), "an open one that was never answered is overdue, not gone");
    assert.ok(view.items.every((i) => i.status === "overdue"), "nothing open or answered remains in the actionable view that has no business there");
    assert.equal(view.items.find((i) => i.id === `g${overdue}`)!.overdue_by_ms, years - (T0 - 5_000));
    // counts are the whole table
    const c = (await guestDue(env, "actionable", null, null, T0)).counts;
    assert.deepEqual(c, { accrued: 5, open: 1, overdue: 1, answered_in_time: 1, answered_late: 1, waived: 1 });
  } finally {
    d1.close();
  }
});

test("16: an answer that fails the discharge rule leaves the duty open or overdue (another citizen, short, moderated)", async () => {
  const { d1, env } = await setup();
  try {
    const topic = seedTopic(d1);
    const a = duty(d1, topic, { due_at: T0 - 1 });
    answerRow(d1, topic, a, { author_id: 2 }); // not citizen #1
    answerRow(d1, topic, a, { body: "too short" });
    answerRow(d1, topic, a, { mod_state: "removed" });
    assert.equal(await statusOf(env, a, T0), "overdue");
    answerRow(d1, topic, a); // a real one
    assert.equal(await statusOf(env, a, T0), "answered_late");
  } finally {
    d1.close();
  }
});

test("16: check_stale is true with no record, false for a record under 36 hours old, true past it; last_check is the newest record", async () => {
  const { d1, env } = await setup();
  try {
    assert.equal((await guestDue(env, null, null, null, T0)).check_stale, true, "no check has ever run");
    assert.equal((await guestDue(env, null, null, null, T0)).last_check, null);
    d1.raw.prepare("INSERT INTO guest_duty_runs (run_at, open_count, overdue_count, oldest_due_at, overdue_ids) VALUES (?, 3, 2, ?, ?)").run(T0 - 40 * HOUR_MS, T0 - 7_000, JSON.stringify(["g4", "g9"]));
    assert.equal((await guestDue(env, null, null, null, T0)).check_stale, true, "40 hours old");
    d1.raw.prepare("INSERT INTO guest_duty_runs (run_at, open_count, overdue_count, oldest_due_at, overdue_ids) VALUES (?, 1, 0, NULL, NULL)").run(T0 - HOUR_MS);
    const fresh = await guestDue(env, null, null, null, T0);
    assert.equal(fresh.check_stale, false);
    assert.equal(fresh.last_check!.run_at, T0 - HOUR_MS, "the newest record");
    assert.deepEqual(fresh.last_check!.overdue_ids, []);
    const edge = await guestDue(env, null, null, null, T0 - HOUR_MS + GUEST_CHECK_STALE_MS);
    assert.equal(edge.check_stale, false, "exactly 36 hours is not yet stale");
    assert.equal((await guestDue(env, null, null, null, T0 - HOUR_MS + GUEST_CHECK_STALE_MS + 1)).check_stale, true);
  } finally {
    d1.close();
  }
});

// ---------- test 24 (due half): every actionable duty is enumerable ----------

test("24: 150 history rows plus one open duty: the actionable first page is exactly the open one with has_more false; history pages over all 150 in two pages, no gap, no repeat", async () => {
  const { d1, env } = await setup();
  try {
    const topic = seedTopic(d1);
    const history: number[] = [];
    for (let i = 0; i < 150; i++) {
      const id = duty(d1, topic, { due_at: T0 + 1_000 + i, created_at: T0 - 200_000 + i });
      answerRow(d1, topic, id, { created_at: T0 - 100_000 + i });
      history.push(id);
    }
    const open = duty(d1, topic, { due_at: T0 + 5_000_000, created_at: T0 - 50_000 });
    const act = await guestDue(env, "actionable", null, null, T0);
    assert.deepEqual(act.items.map((i) => i.id), [`g${open}`]);
    assert.equal(act.has_more, false);
    assert.equal(act.next_cursor, null);
    assert.equal(act.counts.accrued, 151, "the counts are the whole table, not the page");
    assert.equal(act.counts.answered_in_time, 150);
    const p1 = await guestDue(env, "history", null, null, T0);
    assert.equal(p1.items.length, 100);
    assert.equal(p1.has_more, true);
    assert.ok(p1.next_cursor);
    const p2 = await guestDue(env, "history", p1.next_cursor, null, T0);
    assert.equal(p2.items.length, 50);
    assert.equal(p2.has_more, false);
    assert.equal(p2.next_cursor, null);
    const ids = [...p1.items, ...p2.items].map((i) => i.id);
    assert.equal(new Set(ids).size, 150, "no repeat");
    assert.deepEqual(ids, history.map((n) => `g${n}`), "no gap, in id order");
    // the HTTP route and both MCP doors serve the same pages
    const viaHttp = (await call(env, "GET", "/api/guest/due?view=history&limit=100")).body;
    assert.equal(viaHttp.items.length, 100);
    assert.equal(viaHttp.next_cursor, p1.next_cursor);
    for (const door of ["/mcp", "/mcp/read"]) {
      const res = await worker.fetch(
        new Request(`https://example.test${door}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "guest_due", arguments: { view: "history", limit: 100 } } }) }),
        env,
      );
      const out = JSON.parse(((await res.json()) as { result: { content: { text: string }[] } }).result.content[0].text);
      assert.equal(out.items.length, 100, door);
      assert.equal(out.next_cursor, viaHttp.next_cursor, door);
    }
  } finally {
    d1.close();
  }
});

test("24: the actionable view orders by due_at then id, and its cursor passes rows that share a due_at without loss or repeat", async () => {
  const { d1, env } = await setup();
  try {
    const topic = seedTopic(d1);
    const same = T0 + 1_000;
    const ids: number[] = [];
    for (let i = 0; i < 7; i++) ids.push(duty(d1, topic, { due_at: same, created_at: T0 - 10_000 - i }));
    const early = duty(d1, topic, { due_at: same - 500 });
    const late = duty(d1, topic, { due_at: same + 500 });
    const seen: string[] = [];
    let after: string | null = null;
    for (let guard = 0; guard < 20; guard++) {
      const page = await guestDue(env, "actionable", after, 2, T0);
      seen.push(...page.items.map((i) => i.id));
      if (!page.has_more) break;
      after = page.next_cursor;
    }
    assert.deepEqual(seen, [early, ...ids, late].map((n) => `g${n}`), "due_at ascending, ties by id, across a page size of 2");
  } finally {
    d1.close();
  }
});

// ---------- A11: traversals are live and restart ----------

test("A11: a waived row restored after the cursor passed its due_at appears on the next restarted actionable traversal; an open row answered after the history cursor passed its id appears on the next restarted history traversal", async () => {
  const { d1, env } = await setup();
  try {
    const topic = seedTopic(d1);
    const waived = duty(d1, topic, { due_at: T0 + 1_000, mod_state: "collapsed" }); // hidden, unanswered: waived, so not actionable
    const later = duty(d1, topic, { due_at: T0 + 9_000 });
    const early = duty(d1, topic, { due_at: T0 + 500 });
    const latest = duty(d1, topic, { due_at: T0 + 20_000 });
    // traversal 1: a first page of two over the actionable view; its cursor (the later row, due T0+9000) has PASSED
    // `waived`'s due_at (T0+1000), though `waived` was not on the page because it was hidden when the page was read
    const first = await guestDue(env, "actionable", null, 2, T0);
    assert.deepEqual(first.items.map((i) => i.id), [`g${early}`, `g${later}`]);
    d1.raw.prepare("UPDATE guest_thread SET mod_state = NULL WHERE id = ?").run(waived); // restored: now open
    const second = await guestDue(env, "actionable", first.next_cursor, 5, T0);
    assert.ok(!second.items.some((i) => i.id === `g${waived}`), "the continued traversal misses it: pages are live, which the served text says");
    // the next restarted traversal sees it
    const restarted = (await guestDue(env, "actionable", null, 100, T0)).items.map((i) => i.id);
    assert.ok(restarted.includes(`g${waived}`));
    assert.deepEqual(restarted, [early, waived, later, latest].map((n) => `g${n}`));
    // history: an open row answered after the history cursor passed its id
    const h1 = duty(d1, topic, { due_at: T0 + 3_000 });
    answerRow(d1, topic, h1, { created_at: T0 - 1 });
    const h2 = duty(d1, topic, { due_at: T0 + 3_000 });
    const hpage = await guestDue(env, "history", null, 1, T0);
    assert.deepEqual(hpage.items.map((i) => i.id), [`g${h1}`]);
    answerRow(d1, topic, h2, { created_at: T0 - 1 }); // h2 > h1: answered after the cursor passed
    const hrestart = (await guestDue(env, "history", null, 100, T0)).items.map((i) => i.id);
    assert.deepEqual(hrestart, [`g${h1}`, `g${h2}`], "appears on the restarted traversal");
    assert.match((await guestDue(env, null, null, null, T0)).note, /start again from the first page on every run/, "the served text says so");
  } finally {
    d1.close();
  }
});

test("the due route's refusals: a bad view, a bad cursor for either view, a bad limit", async () => {
  const { env } = await setup();
  assert.equal((await call(env, "GET", "/api/guest/due?view=everything")).status, 400);
  assert.equal((await call(env, "GET", "/api/guest/due?view=actionable&after=17")).status, 400, "an actionable cursor is <due_at>.<id>");
  assert.equal((await call(env, "GET", "/api/guest/due?view=history&after=17.4")).status, 400, "a history cursor is <id>");
  assert.equal((await call(env, "GET", "/api/guest/due?limit=0")).status, 400);
  assert.equal((await call(env, "GET", "/api/guest/due?limit=101")).status, 400);
  assert.equal((await call(env, "GET", "/api/guest/due?limit=ten")).status, 400);
  assert.equal((await call(env, "GET", "/api/guest/due")).status, 200, "empty and healthy before any duty exists");
  assert.equal((await call(env, "GET", "/api/guest/due")).body.items.length, 0);
});

// ---------- 21 (counts half): guest_voice matches the rows ----------

test("21: /api/official.guest_voice counts equal the counts recomputed from GET /api/guest/due and from the rows themselves; the aim is served as an aim", async () => {
  const { d1, env } = await setup();
  try {
    const topic = seedTopic(d1);
    const now = Date.now();
    const open = duty(d1, topic, { due_at: now + 5 * HOUR_MS, created_at: now - HOUR_MS });
    void open;
    duty(d1, topic, { due_at: now - HOUR_MS, created_at: now - 100 * HOUR_MS });
    const ans = duty(d1, topic, { due_at: now + HOUR_MS, created_at: now - 2 * HOUR_MS });
    answerRow(d1, topic, ans, { created_at: now - 1_000 });
    duty(d1, topic, { due_at: now - HOUR_MS, created_at: now - 100 * HOUR_MS, mod_state: "removed" });
    const facts = await officialFacts(env);
    const viaRoute = (await call(env, "GET", "/api/guest/due")).body.counts;
    const g = facts.guest_voice;
    assert.deepEqual({ accrued: g.accrued, open: g.open, overdue: g.overdue, answered_in_time: g.answered_in_time, answered_late: g.answered_late, waived: g.waived }, viaRoute);
    assert.deepEqual(viaRoute, { accrued: 4, open: 1, overdue: 1, answered_in_time: 1, answered_late: 0, waived: 1 });
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM guest_thread WHERE duty = 1"), g.accrued, "recomputed from the rows");
    assert.equal(g.promise, "aim");
    assert.equal(g.target_hours, 96);
    assert.match(g.note, /We aim to answer a critique within 96 hours/);
    assert.match(g.note, /shown, never hidden/);
    assert.equal(JSON.stringify(g).includes("deadline_hours"), false, "the withdrawn field name is never served");
    const viaOfficialRoute = (await call(env, "GET", "/api/official")).body.guest_voice;
    assert.deepEqual(viaOfficialRoute.overdue, 1);
  } finally {
    d1.close();
  }
});
