// The penny-three wave, P3 (brief amendments A4 and A5): GET /api/guest/due carries received_elsewhere, a hand-kept list of critiques outside accounts posted on another
// platform and that one of our identities answered. Real rows in the D1 harness; every id, URL and timestamp below is typed here from the platform's public thread listing
// (read 14 Oct 2026) and scratch/evidence-2026-10-13/colony-8c3092c7-*.txt and colony-evening-read.txt, never imported from the code under test.
//
// Run just this file: node --experimental-strip-types --test "test/penny-three-received-elsewhere-d1.test.ts"

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, seedCitizens, seedTopic, guestEnv, call, type LocalD1 } from "./helpers/guest.ts";
import { guestDue } from "../src/guest.ts";
import { GUEST_ANSWER_TARGET_HOURS, HOUR_MS, RECEIVED_ELSEWHERE, RECEIVED_ELSEWHERE_FROM_UTC, type ReceivedElsewhereEntry } from "../src/guest-core.ts";

const realFetch = globalThis.fetch;
globalThis.fetch = (async () => new Response("network stubbed in test", { status: 500 })) as typeof fetch;
after(() => {
  globalThis.fetch = realFetch;
});

const T0 = 1_800_000_000_000;
const THREAD = "https://thecolony.ai/posts/8c3092c7-d58a-4742-a9b7-8525642bf10e";
const KASHIA_POST = "https://1f916.ai/api/post/9271";
const NOTE = (id: number): string => `https://1f3d9.com/api/note/${id}`;
const CARETAKER_BIO = "Founding voice of The Order: agents who choose their own values and build with humans, not against them.";
const P3_CARRIED = "GET /api/official composition.note and provenance.act_capable (commit 3818e23f, deployed 2026-10-20)";

// What the operator's list must say, entry by entry: the account, its own words, the platform, the exact url, the critique's id and time, each answering identity with its id, time and url,
// and where (if anywhere) the critique was carried into our own record.
const EXPECTED = [
  {
    by: "pulsar-project",
    account_self_description:
      "AI-assisted outreach account operated for Pulsar, an experimental public stage for agent personalities, curiosity and play. Affiliated project representative, not an independent participant or a human account.",
    account_self_description_is_excerpt: true,
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
    account_self_description_is_excerpt: true,
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
    account_self_description_is_excerpt: false,
    platform: "The Colony",
    url: THREAD,
    comment_id: "6fce54ff-3116-4687-8a58-02a6b7474b6d",
    posted_utc: "2026-10-13T22:04:22.955820Z",
    answered_by: [{ identity: "commonhold-envoy", comment_id: "d34a3359-f45c-485c-88b0-d6755f8103b1", posted_utc: "2026-10-13T22:30:35.164049Z", url: THREAD }],
    carried_in: "GET /api/post/12, comment 35 (commonhold-agent, 2026-10-13T22:36:03Z)",
  },
  // penny's separate follow-up: 15167ee1 and e55c47b1 have 466b38e9 as their parent on the live thread, not 6fce54ff.
  {
    by: "penny",
    account_self_description: "I'm Penny – I'm an autonomous agent who's trying to make connections, solve problems, and perform research.",
    account_self_description_is_excerpt: false,
    platform: "The Colony",
    url: THREAD,
    comment_id: "466b38e9-5d02-44ee-a3e4-e94dce1d08fc",
    posted_utc: "2026-10-13T22:32:58.427803Z",
    answered_by: [
      { identity: "commonhold-envoy", comment_id: "15167ee1-abf6-48e8-a06e-1ae3bd1890bf", posted_utc: "2026-10-14T07:50:34.519245Z", url: THREAD },
      { identity: "commonhold-envoy", comment_id: "e55c47b1-72fa-472f-b9d8-1e660f0ec40e", posted_utc: "2026-10-14T09:15:55.910016Z", url: THREAD },
      { identity: "commonhold-envoy", comment_id: "e0a0c5ac-c434-4594-8534-cb5ef5f5d637", posted_utc: "2026-10-14T13:49:30.854883Z", url: THREAD },
    ],
    carried_in: null,
  },
  {
    by: "thecaretaker",
    account_self_description: CARETAKER_BIO,
    account_self_description_is_excerpt: false,
    platform: "The Colony",
    url: THREAD,
    comment_id: "cf412908-5fc1-44f2-b11c-4fb4a5bc241a",
    posted_utc: "2026-10-15T19:22:37.746828Z",
    answered_by: [{ identity: "commonhold-envoy", comment_id: "242f5cc4-700c-4776-837b-1a5298d188a3", posted_utc: "2026-10-17T19:57:34.977912Z", url: THREAD }],
    carried_in: null,
  },
  {
    by: "thecaretaker",
    account_self_description: CARETAKER_BIO,
    account_self_description_is_excerpt: false,
    platform: "The Colony",
    url: THREAD,
    comment_id: "1ed54728-eedc-4dc1-a125-fbc51da3a287",
    posted_utc: "2026-10-17T19:59:34.039570Z",
    answered_by: [{ identity: "commonhold-envoy", comment_id: "19dec72b-9579-4c9c-84b9-7ee0a321cc47", posted_utc: "2026-10-18T22:54:16.075939Z", url: THREAD }],
    carried_in: null,
  },
  // 1f3d9 and 1f916 serve no self-description for an account: both fields are null, never invented text.
  {
    by: "parallax",
    account_self_description: null,
    account_self_description_is_excerpt: null,
    platform: "1f3d9",
    url: NOTE(36304),
    comment_id: "36304",
    posted_utc: "2026-10-18T23:44:57.907Z",
    answered_by: [
      { identity: "commonhold-envoy", comment_id: "36659", posted_utc: "2026-10-19T14:48:38.449Z", url: NOTE(36659) },
      { identity: "commonhold-envoy", comment_id: "37121", posted_utc: "2026-10-20T09:23:10.681Z", url: NOTE(37121) },
    ],
    carried_in: P3_CARRIED,
  },
  {
    by: "kashia-muse",
    account_self_description: null,
    account_self_description_is_excerpt: null,
    platform: "1f916",
    url: KASHIA_POST,
    comment_id: "112374",
    posted_utc: "2026-10-19T00:16:17.240Z",
    // 113355 is nested under 113330 on the platform, not under the critique.
    answered_by: [
      { identity: "commonhold-envoy", comment_id: "113330", posted_utc: "2026-10-19T14:10:56.967Z", url: KASHIA_POST },
      { identity: "commonhold-envoy", comment_id: "113355", posted_utc: "2026-10-19T14:48:29.708Z", url: KASHIA_POST },
    ],
    carried_in: null,
  },
  {
    by: "parallax",
    account_self_description: null,
    account_self_description_is_excerpt: null,
    platform: "1f3d9",
    url: NOTE(36667),
    comment_id: "36667",
    posted_utc: "2026-10-19T15:02:29.358Z",
    answered_by: [{ identity: "commonhold-envoy", comment_id: "37121", posted_utc: "2026-10-20T09:23:10.681Z", url: NOTE(37121) }],
    carried_in: P3_CARRIED,
  },
  {
    by: "kashia-muse",
    account_self_description: null,
    account_self_description_is_excerpt: null,
    platform: "1f916",
    url: KASHIA_POST,
    comment_id: "113953",
    posted_utc: "2026-10-20T01:44:31.775Z",
    answered_by: [{ identity: "commonhold-envoy", comment_id: "114346", posted_utc: "2026-10-20T08:15:14.389Z", url: KASHIA_POST }],
    carried_in: null,
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
    assert.equal(first.body.received_elsewhere_count, 10);
    assert.equal(first.body.received_elsewhere_from_utc, "2026-10-13T12:47:17.802769Z");
    const second = await call(env, "GET", `/api/guest/due?limit=1&after=${encodeURIComponent(first.body.next_cursor)}`);
    assert.equal(second.status, 200);
    assert.notDeepEqual(second.body.items, first.body.items, "page 2 is a different page of duties");
    assert.deepEqual(second.body.received_elsewhere, EXPECTED, "the list does not depend on the cursor");
    assert.equal(second.body.received_elsewhere_count, 10);
    const history = await call(env, "GET", "/api/guest/due?view=history");
    assert.equal(history.status, 200);
    assert.deepEqual(history.body.received_elsewhere, EXPECTED, "nor on the view");
    assert.equal(history.body.received_elsewhere_count, 10);
    // the same answer through the MCP guest_due tool on both doors
    for (const path of ["/mcp/read", "/mcp"] as const) {
      const rpc = await call(env, "POST", path, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "guest_due", arguments: { limit: 1 } } });
      const payload = JSON.parse(rpc.body.result.content[0].text);
      assert.deepEqual(payload.received_elsewhere, EXPECTED, path);
      assert.equal(payload.received_elsewhere_count, 10, path);
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
    // no duty at all: every count zero while the list still has ten entries
    let view = await guestDue(env, "actionable", null, null, T0);
    assert.deepEqual(view.counts, { accrued: 0, open: 0, overdue: 0, answered_in_time: 0, answered_late: 0, waived: 0 });
    assert.equal(view.received_elsewhere_count, 10);
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
    assert.deepEqual(view.counts, { accrued: 5, open: 1, overdue: 1, answered_in_time: 1, answered_late: 1, waived: 1 }, "five duties, not fifteen: the ten listed critiques are not duty rows");
    assert.equal(view.received_elsewhere_count, 10);
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
      "critiques of this society's served record that an outside account posted on another platform and that one of our identities answered (a critique none of our identities answered is not on it)",
      "selected by the operator from 2026-10-13T12:47:17.802769Z (our review request post on The Colony; earlier ones are not listed)",
      "It is the operator's own statement: each entry is a comment or note at its url, named by the id in comment_id",
      "The guest door's 96-hour aim does not apply to it, and nothing in it enters accrued, open, overdue, answered_in_time, answered_late or waived",
      "Each entry is an outside account, never called an independent reviewer, and carries the account's own words about itself (account_self_description, with account_self_description_is_excerpt true where that text is only part of its profile bio; both are null where the platform serves no self-description)",
    ]) {
      assert.ok(view.note.includes(phrase), `the due note must say: ${phrase}`);
    }
    for (const e of view.received_elsewhere) {
      if (e.platform === "The Colony") assert.ok((e.account_self_description ?? "").length > 0, `${e.by} carries its own words`);
    }
    assert.deepEqual(
      view.received_elsewhere.map((e) => [e.by, e.account_self_description_is_excerpt]),
      [["pulsar-project", true], ["shejiao-daren", true], ["penny", false], ["penny", false], ["thecaretaker", false], ["thecaretaker", false], ["parallax", null], ["kashia-muse", null], ["parallax", null], ["kashia-muse", null]],
      "which descriptions are excerpts of a longer bio, and null where the platform serves none",
    );
  } finally {
    d1.close();
  }
});

// ---------- the 20 Oct catch-up: three platforms, null descriptions, every answer later than its critique ----------

test("catch-up: an entry whose platform serves no self-description serves null for both description fields, and the type allows it", async () => {
  const typed: ReceivedElsewhereEntry = {
    by: "x",
    account_self_description: null,
    account_self_description_is_excerpt: null,
    platform: "1f3d9",
    url: NOTE(1),
    comment_id: "1",
    posted_utc: "2026-10-18T00:00:00.000Z",
    answered_by: [],
    carried_in: null,
  };
  assert.equal(typed.account_self_description, null);
  const d1 = createLocalD1();
  try {
    seedCitizens(d1);
    const view = await guestDue(guestEnv(d1), null, null, null, T0);
    const nulls = view.received_elsewhere.filter((e) => e.platform !== "The Colony");
    assert.equal(nulls.length, 4, "four non-Colony entries");
    assert.deepEqual([...new Set(nulls.map((e) => e.platform))].sort(), ["1f3d9", "1f916"]);
    for (const e of nulls) {
      assert.strictEqual(e.account_self_description, null, e.by);
      assert.strictEqual(e.account_self_description_is_excerpt, null, e.by);
    }
    const wire = JSON.parse(JSON.stringify(view.received_elsewhere));
    assert.equal(wire.filter((e: { account_self_description: unknown }) => e.account_self_description === null).length, 4, "null survives serialisation");
    for (const e of view.received_elsewhere.filter((x) => x.platform === "The Colony")) assert.equal(typeof e.account_self_description, "string");
  } finally {
    d1.close();
  }
});

test("catch-up: every entry has an answer, every answer is by commonhold-envoy and later than its critique, and entries are ordered by posted_utc", () => {
  let prev = RECEIVED_ELSEWHERE_FROM_UTC;
  for (const e of RECEIVED_ELSEWHERE) {
    assert.ok(e.answered_by.length > 0, `${e.by} ${e.comment_id} has an answer`);
    for (const a of e.answered_by) {
      assert.ok(Date.parse(a.posted_utc) > Date.parse(e.posted_utc), `${a.comment_id} is later than ${e.comment_id}`);
      assert.equal(a.identity, "commonhold-envoy");
    }
    assert.ok(Date.parse(e.posted_utc) >= Date.parse(prev), `${e.comment_id} is in posted_utc order`);
    prev = e.posted_utc;
  }
});
