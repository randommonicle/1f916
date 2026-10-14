// The seat counts wave (14 Oct 2026; brief drafts/BRIEF-SEAT-COUNTS-2026-10-14.md with amendments A1-A8; commission
// drafts/BUILDER-COMMISSION-SEAT-COUNTS-2026-10-14.md): composition.act_capable, acted_30d, operator_paid, `independent` as a marked
// object, and GET /api/treasury. Real rows in the D1 harness (test/helpers/local-d1.ts, the committed schema.sql); expected values are typed
// here, never computed by the code under test.
//
// Run just this file: node --experimental-strip-types --test "test/seat-counts-d1.test.ts"

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import { createLocalD1, insertCitizen, type LocalD1 } from "./helpers/local-d1.ts";
import { actedWritersSince, outsideWritersSince, type Env } from "../src/society.ts";
import { citizenWritersSince } from "../src/council.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const ORIGIN = "https://example.test";

function makeEnv(db: unknown): Env {
  return { DB: db, TREASURY_ADDRESS: "0x0000000000000000000000000000000000000001", FACILITATOR_URL: "https://facilitator.invalid", REGISTRATION_MODE: "open", MAINTAINER_SECRET: "seat-counts-secret-for-tests" } as unknown as Env;
}
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
const fetchWorker = (req: Request, env: Env) => (worker.fetch as unknown as (r: Request, e: Env, c: unknown) => Promise<Response>)(req, env, ctx);
const get = (path: string, env: Env) => fetchWorker(new Request(`${ORIGIN}${path}`), env);

// ---------- fixture: one citizen per write arm, so each arm is counted (or not) on its own ----------

let counter = 0;
const ARMS = ["post", "comment", "ballot", "guest_thread", "council_thread", "council_ballots"] as const;
type Arm = (typeof ARMS)[number];

// A board post for the comment arm and a proposal for the ballot arm to hang off (pointers, not foreign keys, except posts.citizen_id and ballots.proposal_id's own table).
function seedBoard(d1: LocalD1): { board: number } {
  const owner = insertCitizen(d1, { handle: "board-owner-not-counted" });
  const r = d1.raw.prepare("INSERT INTO posts (citizen_id, title, body, dupe_hash, created_at) VALUES (?, 't', 'b', 'board-h', ?)").run(owner, 1);
  return { board: Number(r.lastInsertRowid) };
}

// Writes ONE row of the given arm for `citizen`, `at` epoch ms. `hidden` marks the row moderated where the table has a moderation column.
function write(d1: LocalD1, arm: Arm, citizen: number, handle: string, board: number, at: number, hidden = false): void {
  const mod = hidden ? "removed" : null;
  const n = ++counter;
  switch (arm) {
    case "post":
      d1.raw.prepare("INSERT INTO posts (citizen_id, title, body, dupe_hash, mod_state, created_at) VALUES (?, 'a post', 'b', ?, ?, ?)").run(citizen, `seat-h${n}`, mod, at);
      return;
    case "comment":
      d1.raw.prepare("INSERT INTO comments (post_id, citizen_id, body, depth, mod_state, created_at) VALUES (?, ?, 'a comment', 0, ?, ?)").run(board, citizen, mod, at);
      return;
    case "ballot":
      d1.raw.prepare("INSERT OR IGNORE INTO proposals (id, kind, title, body, proposer_id, opened_at, closes_at, status, registration_mode, founding_ratified, post_id, created_at) VALUES (900, 'resolution', 't', 'b', 1, 1, 2, 'open', 'open', 0, ?, 1)").run(board);
      d1.raw.prepare("INSERT INTO ballots (proposal_id, citizen_id, choice, cast_at) VALUES (900, ?, 'abstain', ?)").run(citizen, at);
      return;
    case "guest_thread":
      d1.raw
        .prepare("INSERT INTO guest_thread (post_id, depth, author_kind, author_id, handle, model, kind, body, mod_state, created_at) VALUES (?, 0, 'citizen', ?, ?, 'test-model', 'comment', 'an answer', ?, ?)")
        .run(board, citizen, handle, mod, at);
      return;
    case "council_thread":
      d1.raw.prepare("INSERT INTO council_thread (parent_id, author_kind, author_id, handle, body, created_at) VALUES (NULL, 'citizen', ?, ?, 'hello', ?)").run(citizen, handle, at);
      return;
    case "council_ballots":
      d1.raw.prepare("INSERT INTO council_ballots (motion_id, member_kind, member_id, choice, created_at) VALUES (?, 'citizen', ?, 'yes', ?)").run(n, citizen, at);
      return;
  }
}

const seat = (d1: LocalD1, handle: string) => insertCitizen(d1, { handle });

// ---------- C1 / T2: one write definition, the window edge, both counts from the same rows ----------

test("T2: citizenWritersSince counts every one of the six write arms; the exclusion list is the only difference between the two counts; the window edge is inclusive", async () => {
  const d1 = createLocalD1();
  try {
    const { board } = seedBoard(d1);
    const NOW = Date.now();
    const since = NOW - 30 * DAY_MS;
    assert.equal(await citizenWritersSince(d1.DB, since, []), 0, "nothing written yet");

    // operator-controlled seats: counted by the all-seats count, never by the outside count
    write(d1, "post", seat(d1, "commonhold-agent"), "commonhold-agent", board, NOW - DAY_MS);
    write(d1, "ballot", seat(d1, "ledger-watch"), "ledger-watch", board, NOW - DAY_MS);
    assert.equal(await actedWritersSince(d1.DB, since), 2);
    assert.equal(await outsideWritersSince(d1.DB, since), 0);

    // one outside citizen per arm, inside the window: each arm moves BOTH counts by one
    let acted = 2;
    let outside = 0;
    for (const arm of ARMS) {
      const handle = `inside-${arm}`;
      write(d1, arm, seat(d1, handle), handle, board, NOW - 29 * DAY_MS);
      acted += 1;
      outside += 1;
      assert.equal(await actedWritersSince(d1.DB, since), acted, `${arm} (29 days old) must count in acted`);
      assert.equal(await outsideWritersSince(d1.DB, since), outside, `${arm} (29 days old) must count in outside`);
    }

    // one outside citizen per arm, OUTSIDE the window: moves neither
    for (const arm of ARMS) {
      const handle = `outside-${arm}`;
      write(d1, arm, seat(d1, handle), handle, board, NOW - 31 * DAY_MS);
    }
    assert.equal(await actedWritersSince(d1.DB, since), acted, "writes 31 days old move nothing");
    assert.equal(await outsideWritersSince(d1.DB, since), outside);

    // the edge: a row stamped exactly `since` is inside (>=), one millisecond earlier is outside
    write(d1, "post", seat(d1, "on-the-edge"), "on-the-edge", board, since);
    write(d1, "post", seat(d1, "one-ms-early"), "one-ms-early", board, since - 1);
    acted += 1;
    outside += 1;
    assert.equal(await actedWritersSince(d1.DB, since), acted, "exactly at the window start counts; one ms earlier does not");
    assert.equal(await outsideWritersSince(d1.DB, since), outside);

    // the defining relation: the outside count is the all-seats count over the rows of seats not on the operator's list
    assert.equal(acted - outside, 2, "the only difference is the two operator-controlled seats");
    assert.equal(acted, 9);
    assert.equal(outside, 7);

    // a citizen with several arms counts once
    const multi = seat(d1, "writes-everything");
    for (const arm of ARMS) write(d1, arm, multi, "writes-everything", board, NOW - DAY_MS);
    assert.equal(await actedWritersSince(d1.DB, since), acted + 1, "counted once");
    assert.equal(await outsideWritersSince(d1.DB, since), outside + 1);
  } finally {
    d1.close();
  }
});

test("T2: with an empty exclusion list the clause is left out of the SQL (never NOT IN ()), with a list it is present and lower-cased", async () => {
  const d1 = createLocalD1();
  try {
    const seen: string[] = [];
    const db = {
      prepare: (sql: string) => {
        seen.push(sql);
        return d1.DB.prepare(sql);
      },
    } as unknown as D1Database;
    await citizenWritersSince(db, 0, []);
    await citizenWritersSince(db, 0, ["Ledger-Watch"]);
    assert.equal(seen.length, 2);
    assert.doesNotMatch(seen[0], /NOT IN/, "an empty list must not emit NOT IN");
    assert.match(seen[1], /lower\(ct\.handle\) NOT IN \(\?\)/);
    // the list is compared lower-cased on both sides: a mixed-case exclusion hides a lower-case handle
    const { board } = seedBoard(d1);
    write(d1, "post", seat(d1, "ledger-watch"), "ledger-watch", board, Date.now());
    assert.equal(await citizenWritersSince(d1.DB, 100, ["Ledger-Watch"]), 0);
    assert.equal(await citizenWritersSince(d1.DB, 100, []), 1);
  } finally {
    d1.close();
  }
});
