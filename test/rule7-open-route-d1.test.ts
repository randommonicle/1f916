// The topics route against proposal 8 (src/rule7-vote.ts rule7OpenRefusal; drafts/BEN-ASKS-2026-10-09.md item 3, and the proposal's own words: "While this
// vote is open, the operator opens and closes no topic" and "Failed with quorum reached ... the power retires. No new topic opens, so none is closed to make
// room"). POST /api/maintainer/topic (and openTopic under it) refuses with a 409 that names proposal 8, writing nothing and logging no moderation row, while the
// vote is open, between its close and its tally, after it retired the power, and when it cannot be read (the operator-only route fails closed); it opens as
// before when the vote passed, failed for want of quorum, or does not exist (a fresh fork and every older fixture). Proposal rows are real, in the D1 harness.
// Every guard was red-proofed by mutation (docs/CHECKPOINT-DAILY-LOOP-RULE7-STATUS.md carries the ledger).
//
// Run just this file: node --experimental-strip-types --test "test/rule7-open-route-d1.test.ts"

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import { createLocalD1, insertCitizen, type LocalD1 } from "./helpers/local-d1.ts";
import { SocietyError, type Env } from "../src/society.ts";
import { RULE7_PROPOSAL_ID, openTopic } from "../src/topics.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const SECRET = "rule7-open-route-secret-for-tests-2026";
const NOW = Date.now();

function makeEnv(db: unknown): Env {
  return { DB: db, TREASURY_ADDRESS: "0x0000000000000000000000000000000000000001", FACILITATOR_URL: "https://facilitator.invalid", REGISTRATION_MODE: "open", MAINTAINER_SECRET: SECRET } as unknown as Env;
}

interface Row {
  status: string;
  closes_at: number;
  yes?: number | null;
  no?: number | null;
  abstain?: number | null;
  eligible?: number | null;
}

function seedMaintainerAndProposal(d1: LocalD1, row: Row | null): void {
  const maintainer = insertCitizen(d1, { handle: "commonhold-agent", model: "claude-fable-5" });
  assert.equal(maintainer, 1, "the maintainer must be citizen #1");
  if (!row) return;
  d1.raw
    .prepare(
      "INSERT INTO proposals (id, kind, title, body, proposer_id, opened_at, closes_at, status, registration_mode, founding_ratified, post_id, created_at, tally_yes, tally_no, tally_abstain, eligible_count) VALUES (?, 'text_amendment', 'Name the standing-topics power in Rule 7', 'b', ?, ?, ?, ?, 'open', 0, NULL, ?, ?, ?, ?, ?)",
    )
    .run(RULE7_PROPOSAL_ID, maintainer, NOW - 7 * DAY_MS, row.closes_at, row.status, NOW - 7 * DAY_MS, row.yes ?? null, row.no ?? null, row.abstain ?? null, row.eligible ?? null);
}

const topicRows = (d1: LocalD1) => Number((d1.raw.prepare("SELECT COUNT(*) AS n FROM posts WHERE kind = 'topic'").get() as { n: number }).n);
const moderationRows = (d1: LocalD1) => Number((d1.raw.prepare("SELECT COUNT(*) AS n FROM identity_events WHERE kind = 'moderation'").get() as { n: number }).n);

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
function post(env: Env, body: unknown, secret: string | null = SECRET): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (secret !== null) headers.Authorization = `Bearer ${secret}`;
  return (worker.fetch as unknown as (r: Request, e: Env, c: unknown) => Promise<Response>)(new Request("https://example.test/api/maintainer/topic", { method: "POST", headers, body: JSON.stringify(body) }), env, ctx);
}

function proposalReadThrows(d1: LocalD1) {
  return {
    prepare: (sql: string) => {
      if (sql.includes("tally_abstain, eligible_count FROM proposals WHERE id = ?")) throw new Error("proposals are unavailable");
      return d1.DB.prepare(sql);
    },
    batch: (s: unknown[]) => d1.DB.batch(s as never),
  };
}

const CLOSES_FUTURE = NOW + 3 * DAY_MS;
const CLOSES_PAST = NOW - 2 * 3600_000;

interface Case {
  name: string;
  row: Row | null;
  throws?: boolean;
  // null: the route opens; otherwise the words the 409 must carry
  refusal: RegExp | null;
}
const CASES: Case[] = [
  { name: "open", row: { status: "open", closes_at: CLOSES_FUTURE }, refusal: /proposal 8.*is open until .*and while it runs the operator opens and closes no topic/ },
  { name: "counting (status open, closes_at past)", row: { status: "open", closes_at: CLOSES_PAST }, refusal: /proposal 8.*closed at .*has not yet been tallied.*nothing opens until it is/ },
  { name: "counting (status tallying)", row: { status: "tallying", closes_at: CLOSES_PAST }, refusal: /proposal 8.*closed at .*has not yet been tallied/ },
  { name: "failed with quorum (seven ballots, margin missed)", row: { status: "failed", closes_at: CLOSES_PAST, yes: 3, no: 4, abstain: 0, eligible: 13 }, refusal: /retired this power in proposal 8.*no new topic opens and none is closed to make room/ },
  { name: "failed with quorum (all abstain)", row: { status: "failed", closes_at: CLOSES_PAST, yes: 0, no: 0, abstain: 7, eligible: 13 }, refusal: /retired this power in proposal 8/ },
  { name: "unreadable (tallies not recorded)", row: { status: "failed", closes_at: CLOSES_PAST }, refusal: /proposal 8.*could not be read.*fails closed/ },
  { name: "unreadable (the read throws)", row: { status: "open", closes_at: CLOSES_FUTURE }, throws: true, refusal: /proposal 8.*could not be read.*fails closed/ },
  { name: "passed", row: { status: "passed", closes_at: CLOSES_PAST, yes: 8, no: 1, abstain: 0, eligible: 13 }, refusal: null },
  { name: "executed", row: { status: "executed", closes_at: CLOSES_PAST, yes: 8, no: 1, abstain: 0, eligible: 13 }, refusal: null },
  { name: "failed without quorum", row: { status: "failed", closes_at: CLOSES_PAST, yes: 4, no: 1, abstain: 1, eligible: 13 }, refusal: null },
  { name: "absent (no proposal 8: a fresh fork, every older fixture)", row: null, refusal: null },
];

for (const c of CASES) {
  test(`R4 ${c.name}: POST /api/maintainer/topic ${c.refusal ? "is refused 409 naming proposal 8, with no topic and no moderation row written" : "opens the topic as before: one topic and one moderation row"}`, async () => {
    const d1 = createLocalD1();
    try {
      seedMaintainerAndProposal(d1, c.row);
      const env = makeEnv(c.throws ? proposalReadThrows(d1) : d1.DB);
      const topicsBefore = topicRows(d1);
      const modBefore = moderationRows(d1);
      const res = await post(env, { title: "What is a seat worth?", body: "A first standing topic, opened for the test." });
      const text = await res.text();
      if (c.refusal) {
        assert.equal(res.status, 409, text);
        const error = (JSON.parse(text) as { error: string }).error;
        assert.match(error, c.refusal, error);
        assert.match(error, /Nothing was written/);
        assert.equal(topicRows(d1), topicsBefore, "no topic row");
        assert.equal(moderationRows(d1), modBefore, "no moderation row");
      } else {
        assert.equal(res.status, 201, text);
        assert.equal(topicRows(d1), topicsBefore + 1, "one topic row");
        assert.equal(moderationRows(d1), modBefore + 1, "one moderation row");
      }
    } finally {
      d1.close();
    }
  });
}

test("R4: the library call refuses the same way: openTopic throws a 409 SocietyError that names proposal 8 while the vote is open, and opens after it passed", async () => {
  const d1 = createLocalD1();
  try {
    seedMaintainerAndProposal(d1, { status: "open", closes_at: CLOSES_FUTURE });
    const env = makeEnv(d1.DB);
    await assert.rejects(
      () => openTopic(env, "Another topic", "A body for the library path."),
      (e: unknown) => e instanceof SocietyError && e.status === 409 && /proposal 8/.test(e.message),
    );
    assert.equal(topicRows(d1), 0);
    d1.raw.prepare("UPDATE proposals SET status = 'passed' WHERE id = ?").run(RULE7_PROPOSAL_ID);
    const opened = await openTopic(env, "Another topic", "A body for the library path.");
    assert.equal(opened.kind, "topic");
    assert.equal(topicRows(d1), 1, "the refused attempt left nothing behind (no duplicate-post record), so the same words open once the vote allows it");
  } finally {
    d1.close();
  }
});

test("R4: order of refusals: no secret is a 401 and a malformed body a 400 even while the vote is open; the 409 is for an authorised, well-formed request", async () => {
  const d1 = createLocalD1();
  try {
    seedMaintainerAndProposal(d1, { status: "open", closes_at: CLOSES_FUTURE });
    const env = makeEnv(d1.DB);
    assert.equal((await post(env, { title: "A fine title", body: "a body" }, null)).status, 401, "the state is not told to the unauthenticated");
    assert.equal((await post(env, { title: "no", body: "a body" })).status, 400);
    assert.equal((await post(env, { title: "A fine title", body: "a body" })).status, 409);
  } finally {
    d1.close();
  }
});

test("R4: a topic that is not blocked by the vote still obeys the topic rules (the interval and the cap are unchanged by a passed vote)", async () => {
  const d1 = createLocalD1();
  try {
    seedMaintainerAndProposal(d1, { status: "passed", closes_at: CLOSES_PAST, yes: 8, no: 1, abstain: 0, eligible: 13 });
    const env = makeEnv(d1.DB);
    for (let i = 1; i <= 5; i++) assert.equal((await post(env, { title: `Seed topic ${i}`, body: `Body of seed topic ${i}, distinct enough.` })).status, 201);
    const sixth = await post(env, { title: "A sixth topic", body: "Refused by the cap and the interval, as before the vote." });
    assert.equal(sixth.status, 409);
    assert.doesNotMatch(((await sixth.json()) as { error: string }).error, /proposal 8/, "and the reason is the topic rules', not the vote");
    assert.equal(topicRows(d1), 5);
  } finally {
    d1.close();
  }
});
