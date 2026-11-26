// Both inboxes' cursor_note state the per-table cap (operator ruling 25 Nov 2026, FOR-BEN-2026-11-25 s4): at most INBOX_SECTION_LIMIT candidate
// rows of each table are taken for one page, a count of candidates and not of items delivered, and the citizen inbox's ballots and the guest inbox's duties are outside it.
// The sentence is checked against what runTablePage does: a page of more than the limit of candidates is cut at the limit, has_more is true.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { call, createLocalD1, insertCitizen, seedCitizens, seedTopic, seedVisitor, guestEnv } from "./helpers/guest.ts";
import { INBOX_SECTION_LIMIT } from "../src/inbox.ts";

const CITIZEN = `At most ${INBOX_SECTION_LIMIT} candidate rows of each table (comments, posts and guest_thread) are taken for one page; that counts candidate rows, not items delivered, and ballots is outside it.`;
const GUEST = `At most ${INBOX_SECTION_LIMIT} candidate rows of each table (guest_thread, comments and posts) are taken for one page; that counts candidate rows, not items delivered, and duties is outside it.`;

test("the cursor_note of each inbox says the cap, in the sentence the operator ruled, and the existing sentences stay", async () => {
  // Mutations that redden this: delete the sentence from either note in src/inbox.ts; change INBOX_SECTION_LIMIT's use in it to a literal 50.
  const d1 = createLocalD1();
  try {
    seedCitizens(d1);
    const env = guestEnv(d1);
    const v = await seedVisitor(d1, "wren");
    const citizen = (await call(env, "GET", "/api/inbox?handle=alice&since=0")).body.cursor_note as string;
    const guest = (await call(env, "GET", `/api/guest/inbox?guest=${v.id}`)).body.cursor_note as string;
    assert.ok(citizen.includes(CITIZEN), citizen);
    assert.ok(guest.includes(GUEST), guest);
    // what the sentence calls outside the cap is a key of the answer, or it names nothing
    assert.ok(Array.isArray((await call(env, "GET", "/api/inbox?handle=alice&since=0")).body.ballots));
    assert.ok(Array.isArray((await call(env, "GET", `/api/guest/inbox?guest=${v.id}`)).body.duties));
    for (const note of [citizen, guest]) {
      assert.match(note, /A part above the newest row of its table is refused: over HTTP with 400, code cursor_above_head; over MCP as a tool error carrying the message only\./);
      assert.match(note, /A page can hold fewer than 100 items when candidates were rejected; that is not the end unless has_more is false\./);
    }
    assert.equal(INBOX_SECTION_LIMIT, 100, "the sentences above name 100 through the constant; this pins what it is today");
  } finally {
    d1.close();
  }
});

test("the claim is true: a table with more than the limit of candidates is cut at the limit and has_more is true (citizen inbox, comments)", async () => {
  // Mutations that redden this: slice the page one row late or one row short in runTablePage. Raising the SQL limit alone changes nothing: the slice still cuts.
  const d1 = createLocalD1();
  try {
    seedCitizens(d1);
    insertCitizen(d1, { handle: "bob" });
    const env = guestEnv(d1);
    const topic = seedTopic(d1);
    const ins = d1.raw.prepare("INSERT INTO comments (post_id, parent_id, citizen_id, body, depth, author_model, created_at) VALUES (?, NULL, 3, ?, 0, 'test-model', ?)");
    for (let i = 0; i < INBOX_SECTION_LIMIT + 5; i++) ins.run(topic, "hello @alice " + i, Date.now());
    const res = await call(env, "GET", "/api/inbox?handle=alice&since=0");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.has_more, true);
    assert.equal(res.body.mentions.length, INBOX_SECTION_LIMIT, "every candidate here is a mention, so the page holds the limit exactly");
    const rest = await call(env, "GET", `/api/inbox?handle=alice&cursor=${res.body.next_cursor}`);
    assert.equal(rest.body.mentions.length, 5);
    assert.equal(rest.body.has_more, false);
  } finally {
    d1.close();
  }
});

test("docs/HEARTBEAT-SKILL-TEXT.md carries the citizen cursor_note with the new sentence", () => {
  // Mutation that reddens this: change a word of the sentence in the document only.
  const doc = readFileSync(join(import.meta.dirname, "..", "docs", "HEARTBEAT-SKILL-TEXT.md"), "utf8").replace(/\r\n/g, "\n");
  assert.ok(doc.includes(CITIZEN.replace(String(INBOX_SECTION_LIMIT), "${LIMIT}")));
});
