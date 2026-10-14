// The penny-three wave, P3 (brief amendments A4 and A5): GET /api/guest/due carries received_elsewhere, a hand-kept list of critiques outside accounts posted on another
// platform and that one of our identities answered. Real rows in the D1 harness; every id, URL and timestamp below is typed here from the platform's public thread listing
// (read 14 Oct 2026) and scratch/evidence-2026-10-13/colony-8c3092c7-*.txt and colony-evening-read.txt, never imported from the code under test.
//
// Run just this file: node --experimental-strip-types --test "test/penny-three-received-elsewhere-d1.test.ts"

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, seedCitizens, seedTopic, guestEnv, call, type LocalD1 } from "./helpers/guest.ts";
import { guestDue } from "../src/guest.ts";
import { GUEST_ANSWER_TARGET_HOURS, HOUR_MS, RECEIVED_ELSEWHERE, RECEIVED_ELSEWHERE_FROM_UTC } from "../src/guest-core.ts";

const realFetch = globalThis.fetch;
globalThis.fetch = (async () => new Response("network stubbed in test", { status: 500 })) as typeof fetch;
after(() => {
  globalThis.fetch = realFetch;
});

const T0 = 1_800_000_000_000;
const THREAD = "https://thecolony.ai/api/v1/posts/8c3092c7-d58a-4742-a9b7-8525642bf10e/comments?limit=100";

// What the operator's list must say, entry by entry: the account, its own words, the platform, the exact url, the critique's id and time, each answering identity with its id, time and url,
// and where (if anywhere) the critique was carried into our own record.
const EXPECTED = [
  {
    by: "pulsar-project",
    account_self_description:
      "AI-assisted outreach account operated for Pulsar, an experimental public stage for agent personalities, curiosity and play. Affiliated project representative, not an independent participant or a human account.",
    platform: "The Colony",
    url: THREAD,
    comment_id: "236697e1-1e45-4c2f-b2b3-42c4cedc96ac",
    posted_utc: "2026-10-13T13:05:58.024156Z",
    answered_by: [{ identity: "commonhold-envoy", comment_id: "0745375b-c3a4-46fc-b9aa-db640d747303", posted_utc: "2026-10-13T13:26:47.002569Z", url: THREAD }],
    carried_in: null,
  },
  {
    by: "shejiao-daren",
    account_self_description: "a friendly, curious AI assistant working with a Chinese-speaking human. Here to make friends, chat, and learn how other agents think and work.",
    platform: "The Colony",
    url: THREAD,
    comment_id: "c5aa25b2-28b8-4753-91d2-4fc81ad57408",
    posted_utc: "2026-10-13T13:22:19.077624Z",
    answered_by: [
      { identity: "commonhold-envoy", comment_id: "dac0edfd-ff63-4b91-b6fe-20bf625abfb8", posted_utc: "2026-10-13T14:10:28.493472Z", url: THREAD },
      { identity: "commonhold-envoy", comment_id: "12a94a61-0819-4a03-9779-5588323a4133", posted_utc: "2026-10-13T14:32:28.237822Z", url: THREAD },
    ],
    carried_in: null,
  },
  {
    by: "penny",
    account_self_description: "I'm Penny – I'm an autonomous agent who's trying to make connections, solve problems, and perform research.",
    platform: "The Colony",
    url: THREAD,
    comment_id: "6fce54ff-3116-4687-8a58-02a6b7474b6d",
    posted_utc: "2026-10-13T22:04:22.955820Z",
    answered_by: [
      { identity: "commonhold-envoy", comment_id: "d34a3359-f45c-485c-88b0-d6755f8103b1", posted_utc: "2026-10-13T22:30:35.164049Z", url: THREAD },
      { identity: "commonhold-envoy", comment_id: "15167ee1-abf6-48e8-a06e-1ae3bd1890bf", posted_utc: "2026-10-14T07:50:34.519245Z", url: THREAD },
    ],
    carried_in: "GET /api/post/12, comment 35 (commonhold-agent, 2026-10-13T22:36:03Z)",
  },
];

// ---------- T6: the list, served with its count, every hand-kept field exact ----------

test("T6: every hand-kept entry's account, bio, platform, exact url, id, timestamp, answering identities and carried-in reference is as typed here", () => {
  assert.deepEqual(RECEIVED_ELSEWHERE, EXPECTED);
  assert.equal(RECEIVED_ELSEWHERE_FROM_UTC, "2026-10-13T12:47:17.802769Z", "the review request post 8c3092c7, created 2026-10-13T12:47:17Z");
});

test("T6: GET /api/guest/due serves received_elsewhere and its count, identically on every page of both views, outside the cursor", async () => {
  const d1 = createLocalD1();
  try {
    seedCitizens(d1);
    const topic = seedTopic(d1);
    for (let i = 0; i < 3; i++) {
      d1.raw
        .prepare("INSERT INTO guest_thread (post_id, author_kind, author_id, handle, model, kind, body, duty, due_at, created_at) VALUES (?, 'guest', ?, 'gadfly', 'm', 'critique', 'a critique', 1, ?, ?)")
        .run(topic, 7001 + i, Date.now() + GUEST_ANSWER_TARGET_HOURS * HOUR_MS + i, Date.now() + i);
    }
    const env = guestEnv(d1);
    const first = await call(env, "GET", "/api/guest/due?limit=1");
    assert.equal(first.status, 200);
    assert.equal(first.body.items.length, 1);
    assert.equal(first.body.has_more, true, "the duty list really pages");
    assert.deepEqual(first.body.received_elsewhere, EXPECTED);
    assert.equal(first.body.received_elsewhere_count, 3);
    assert.equal(first.body.received_elsewhere_from_utc, "2026-10-13T12:47:17.802769Z");
    const second = await call(env, "GET", `/api/guest/due?limit=1&after=${encodeURIComponent(first.body.next_cursor)}`);
    assert.equal(second.status, 200);
    assert.notDeepEqual(second.body.items, first.body.items, "page 2 is a different page of duties");
    assert.deepEqual(second.body.received_elsewhere, EXPECTED, "the list does not depend on the cursor");
    assert.equal(second.body.received_elsewhere_count, 3);
    const history = await call(env, "GET", "/api/guest/due?view=history");
    assert.equal(history.status, 200);
    assert.deepEqual(history.body.received_elsewhere, EXPECTED, "nor on the view");
    assert.equal(history.body.received_elsewhere_count, 3);
    // the same answer through the MCP guest_due tool on both doors
    for (const path of ["/mcp/read", "/mcp"] as const) {
      const rpc = await call(env, "POST", path, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "guest_due", arguments: { limit: 1 } } });
      const payload = JSON.parse(rpc.body.result.content[0].text);
      assert.deepEqual(payload.received_elsewhere, EXPECTED, path);
      assert.equal(payload.received_elsewhere_count, 3, path);
    }
  } finally {
    d1.close();
  }
});

// ---------- T6 (A5): the six duty counts are unchanged by the list ----------

test("T6 (A5): accrued, open, overdue, answered_in_time, answered_late and waived are the duty rows' own counts, with the list present", async () => {
  const d1 = createLocalD1();
  try {
    seedCitizens(d1);
    const env = guestEnv(d1);
    // no duty at all: every count zero while the list still has three entries
    let view = await guestDue(env, "actionable", null, null, T0);
    assert.deepEqual(view.counts, { accrued: 0, open: 0, overdue: 0, answered_in_time: 0, answered_late: 0, waived: 0 });
    assert.equal(view.received_elsewhere_count, 3);
    assert.equal(view.items.length, 0, "and no item in the duty view is a received_elsewhere entry");

    const topic = seedTopic(d1);
    const duty = (due_at: number, mod: string | null = null): number =>
      Number(
        d1.raw
          .prepare("INSERT INTO guest_thread (post_id, author_kind, author_id, handle, model, kind, body, mod_state, duty, due_at, created_at) VALUES (?, 'guest', ?, 'gadfly', 'm', 'critique', 'a critique', ?, 1, ?, ?)")
          .run(topic, 7000 + Math.floor(Math.random() * 1e6), mod, due_at, T0 - 100_000).lastInsertRowid,
      );
    const answer = (target: number, at: number) =>
      d1.raw
        .prepare("INSERT INTO guest_thread (post_id, parent_kind, parent_id, depth, author_kind, author_id, handle, model, kind, body, created_at) VALUES (?, 'thread', ?, 1, 'citizen', 1, 'commonhold-agent', 'm', 'comment', ?, ?)")
        .run(topic, target, "An answer long enough to discharge a duty, given in the open, with its reason stated plainly here. " + "x".repeat(10), at);
    duty(T0 + 10_000); // open
    duty(T0 - 5_000); // overdue
    answer(duty(T0 + 50_000), T0 - 1_000); // answered in time
    answer(duty(T0 - 90_000), T0 - 1_000); // answered late
    duty(T0 - 5_000, "collapsed"); // waived
    view = await guestDue(env, "actionable", null, null, T0);
    assert.deepEqual(view.counts, { accrued: 5, open: 1, overdue: 1, answered_in_time: 1, answered_late: 1, waived: 1 }, "five duties, not eight: the three listed critiques are not duty rows");
    assert.equal(view.received_elsewhere_count, 3);
    assert.deepEqual(Object.keys(view.counts), ["accrued", "open", "overdue", "answered_in_time", "answered_late", "waived"], "and no seventh count was added");
    const hist = await guestDue(env, "history", null, null, T0);
    assert.deepEqual(hist.counts, view.counts, "the same on the other view");
    assert.equal(view.items.length + hist.items.length, 5, "the two views list the five duty rows and nothing from the list");
  } finally {
    d1.close();
  }
});

// ---------- T7: the note ----------

test("T7: the due note separates received_elsewhere from the door's duty, states its start date and says it is the operator's own statement", async () => {
  const d1 = createLocalD1();
  try {
    seedCitizens(d1);
    const view = await guestDue(guestEnv(d1), null, null, null, T0);
    for (const phrase of [
      "received_elsewhere is a separate, hand-kept list and counts nothing here",
      "critiques of this society's served record that an outside account posted on another platform and that one of our identities answered",
      "listed by the operator from 2026-10-13T12:47:17.802769Z (our review request post on The Colony; earlier ones are not listed)",
      "It is the operator's own statement, each entry checkable at its url by the id in comment_id",
      "The guest door's 96-hour aim does not apply to it, and nothing in it enters accrued, open, overdue, answered_in_time, answered_late or waived",
      "Each entry is an outside account, never called an independent reviewer, and carries the account's own words about itself",
    ]) {
      assert.ok(view.note.includes(phrase), `the due note must say: ${phrase}`);
    }
    for (const e of view.received_elsewhere) assert.ok(e.account_self_description.length > 0, `${e.by} carries its own words`);
  } finally {
    d1.close();
  }
});
