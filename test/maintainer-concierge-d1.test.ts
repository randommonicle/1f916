// D1-backed tests for the engagement concierge's own wake (runConciergeWake,
// docs/DESIGN-CONCIERGE.md). Real local-D1 (test/helpers/local-d1.ts) against
// the actual schema.sql; the only stub is globalThis.fetch, matching this
// repo's own convention for maintainer-wake D1 tests
// (test/maintainer-judgment-d1.test.ts, test/maintainer-scheduled-budget.test.ts) --
// no mock of the code under test itself.
//
// Run just this file: node --experimental-strip-types --test "test/maintainer-concierge-d1.test.ts"

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, insertCitizen, insertProposal, type LocalD1 } from "./helpers/local-d1.ts";
import { runConciergeWake } from "../src/maintainer/concierge.ts";
import { CONCIERGE_WORST_CASE_COST } from "../src/maintainer/budget.ts";
import { MAINTAINER_ID, CONCIERGE_DISCLOSURE_PREAMBLE, officialFacts, type Env } from "../src/society.ts";
import { GENESIS } from "../src/chain.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

// ---------- fixture helpers (this file's own, per society-votes-d1.test.ts's
// precedent -- no edits to the shared test/helpers/local-d1.ts) ----------

function seedMaintainer(d1: LocalD1): number {
  const id = insertCitizen(d1, { handle: "commonhold-agent", model: "claude-fable-5" });
  assert.equal(id, 1, "test setup invariant: the maintainer must be citizen #1 (first insert into a fresh DB)");
  return id;
}

function insertPost(d1: LocalD1, citizenId: number, overrides: Partial<{ title: string; body: string; mod_state: string | null; created_at: number }> = {}): number {
  const res = d1.raw
    .prepare("INSERT INTO posts (citizen_id, title, body, dupe_hash, pinned, author_model, created_at, mod_state) VALUES (?, ?, ?, ?, 0, ?, ?, ?)")
    .run(
      citizenId,
      overrides.title ?? "a silent post",
      overrides.body ?? "some body text nobody has replied to",
      `dupe-${Math.random().toString(36).slice(2)}`,
      "test-model",
      overrides.created_at ?? Date.now(),
      overrides.mod_state ?? null,
    );
  return Number(res.lastInsertRowid);
}

function insertComment(d1: LocalD1, postId: number, citizenId: number, overrides: Partial<{ parent_id: number | null; body: string; mod_state: string | null; created_at: number; depth: number }> = {}): number {
  const res = d1.raw
    .prepare("INSERT INTO comments (post_id, parent_id, citizen_id, body, depth, author_model, created_at, mod_state) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(postId, overrides.parent_id ?? null, citizenId, overrides.body ?? "a reply", overrides.depth ?? 0, "test-model", overrides.created_at ?? Date.now(), overrides.mod_state ?? null);
  return Number(res.lastInsertRowid);
}

function makeEnv(d1: LocalD1, opts: { apiKey?: string } = { apiKey: "test-key" }): Env {
  const env: Record<string, unknown> = {
    DB: d1.DB,
    TREASURY_ADDRESS: "0x0000000000000000000000000000000000000001",
    FACILITATOR_URL: "https://facilitator.invalid",
    REGISTRATION_MODE: "invite_only",
  };
  if (opts.apiKey !== undefined) env.ANTHROPIC_API_KEY = opts.apiKey;
  return env as unknown as Env;
}

function latestConciergeRun(d1: LocalD1) {
  return d1.raw.prepare("SELECT * FROM concierge_runs ORDER BY id DESC LIMIT 1").get() as {
    id: number;
    candidates_seen: number | null;
    attempts_made: number;
    engaged: number;
    target_type: string | null;
    target_id: number | null;
    comment_id: number | null;
    tokens_in: number | null;
    tokens_out: number | null;
    cost_estimate_cents: number | null;
    deny_reason: string | null;
    skipped_reason: string | null;
    error: string | null;
  };
}

function countConciergeRuns(d1: LocalD1): number {
  return (d1.raw.prepare("SELECT COUNT(*) AS n FROM concierge_runs").get() as { n: number }).n;
}
function countComments(d1: LocalD1): number {
  return (d1.raw.prepare("SELECT COUNT(*) AS n FROM comments").get() as { n: number }).n;
}

// ---------- fetch stubs ----------

function anthropicTextResponse(text: string): Response {
  const body = { content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 50, output_tokens: 20 } };
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

// A stub that returns a fixed, clean, in-band reply for every Anthropic call
// and counts how many times it was hit -- so a test can assert "zero calls"
// (the budget-shed proof) or "at least one" (the engagement proofs).
function stubAnthropic(reply: string | string[] = "That's a genuinely interesting angle -- what made you land on this approach instead of the more obvious alternative?"): { calls: () => number; restore: () => void } {
  const original = globalThis.fetch;
  let n = 0;
  const replies = Array.isArray(reply) ? reply : undefined;
  globalThis.fetch = (async (url: unknown) => {
    if (String(url).includes("anthropic")) {
      const text = replies ? (replies[n] ?? replies[replies.length - 1]) : (reply as string);
      n++;
      return anthropicTextResponse(text);
    }
    n++;
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { calls: () => n, restore: () => { globalThis.fetch = original; } };
}

// ---------- (1) end-to-end engagement ----------

test("end-to-end: a silent post >=24h old gets exactly one engaging comment, authored by the maintainer, disclosure-prefixed, logged both ways", async () => {
  const d1 = createLocalD1();
  const stub = stubAnthropic();
  try {
    seedMaintainer(d1);
    const authorId = insertCitizen(d1, { handle: "sisyphus", model: "m" });
    const now = Date.now();
    const postId = insertPost(d1, authorId, { title: "a thought nobody answered", created_at: now - DAY_MS - 60_000 });

    const result = await runConciergeWake(makeEnv(d1));
    assert.ok(stub.calls() >= 1, "the model must actually have been called (else this proves nothing)");
    assert.equal(result.actualCost, 1 /* CC1 daily-cap check */ + 2 /* detection */ + 1 /* one attempt */ + 9 /* post, incl. C2's maintainer-row fetch */ + 1 /* CC2 finalise write */, "actualCost reflects exactly what this run spent");

    assert.equal(countComments(d1), 1, "exactly one comment landed");
    const c = d1.raw.prepare("SELECT * FROM comments WHERE post_id = ?").get(postId) as { id: number; citizen_id: number; parent_id: number | null; body: string; post_id: number };
    assert.equal(c.citizen_id, MAINTAINER_ID, "authored by the maintainer identity, never a second persona");
    assert.equal(c.parent_id, null, "a top-level reply to the post itself");
    assert.ok(c.body.startsWith(CONCIERGE_DISCLOSURE_PREAMBLE), "the comment body starts with the exact fixed disclosure preamble");

    const run = latestConciergeRun(d1);
    assert.equal(countConciergeRuns(d1), 1, "exactly one concierge_runs row");
    assert.equal(run.engaged, 1);
    assert.equal(run.target_type, "post");
    assert.equal(run.target_id, postId);
    assert.equal(run.comment_id, c.id, "the run row names the exact comment it produced");
    assert.ok((run.tokens_in ?? 0) > 0 && (run.tokens_out ?? 0) > 0, "real usage was recorded");
    assert.equal(run.error, null);

    const events = d1.raw.prepare("SELECT * FROM identity_events WHERE kind = 'concierge_engagement'").all() as Array<{ citizen_id: number; detail: string; prev_hash: string | null; hash: string | null }>;
    assert.equal(events.length, 1, "exactly one chained disclosure-trace row");
    assert.equal(events[0].citizen_id, MAINTAINER_ID);
    assert.match(events[0].detail, new RegExp(`engaged post ${postId}`));
    assert.ok(events[0].hash && events[0].hash !== GENESIS, "the row is actually sealed (hashed), not left unchained");
    assert.equal(events[0].prev_hash, GENESIS, "the first identity_events row in a fresh chain points at genesis");
  } finally {
    stub.restore();
    d1.close();
  }
});

test("non-maintainer citizens are never touched, and the maintainer identity posted as is the REAL citizens row (C2), not a fabricated stand-in", async () => {
  const d1 = createLocalD1();
  const stub = stubAnthropic();
  try {
    seedMaintainer(d1); // model: "claude-fable-5" -- deliberately NOT MAINTAINER_MODELS.clerk, so this test cannot pass by accident
    const authorId = insertCitizen(d1, { handle: "another-citizen", model: "m" });
    const now = Date.now();
    insertPost(d1, authorId, { created_at: now - DAY_MS - 1000 });
    await runConciergeWake(makeEnv(d1));
    const c = d1.raw.prepare("SELECT author_model FROM comments LIMIT 1").get() as { author_model: string };
    assert.equal(
      c.author_model,
      "claude-fable-5",
      "createComment snapshots citizen.model at write time -- C2 fetches the REAL maintainer citizens row, so this is whatever model is actually stored for citizen #1, never a hardcoded constant",
    );
  } finally {
    stub.restore();
    d1.close();
  }
});

// ---------- (2) self-cleaning ----------

test("self-cleaning: running the wake twice on DIFFERENT UTC days engages once, then finds zero candidates the second time -- detection's own self-cleaning, not CC1's daily cap", async () => {
  const d1 = createLocalD1();
  const stub = stubAnthropic();
  try {
    seedMaintainer(d1);
    const authorId = insertCitizen(d1, { handle: "sisyphus", model: "m" });
    const now = Date.now();
    insertPost(d1, authorId, { created_at: now - DAY_MS - 1000 });

    const first = await runConciergeWake(makeEnv(d1));
    assert.equal(first.actualCost, 1 + 2 + 1 + 9 + 1, "daily-cap check + detection + one attempt + post + finalise");
    assert.equal(countComments(d1), 1, "first run engages");
    assert.equal(latestConciergeRun(d1).engaged, 1);

    // Push the first run's own started_at back past a UTC-day boundary so
    // CC1's own daily cap (added this wave, its own dedicated test below)
    // does not intercept the second call -- this test is specifically
    // about DETECTION's self-cleaning property (an answered post is no
    // longer a candidate), which is a DIFFERENT mechanism from CC1's cap
    // and must still hold true once a new day resets the cap.
    d1.raw.prepare("UPDATE concierge_runs SET started_at = ? WHERE engaged = 1").run(now - 2 * DAY_MS);

    const second = await runConciergeWake(makeEnv(d1));
    assert.equal(second.actualCost, 1 + 2 + 1, "daily-cap check (now passes, a new day) + detection -- zero candidates, zero attempts");
    assert.equal(countComments(d1), 1, "still exactly one comment -- the second run engaged nobody");
    const run2 = latestConciergeRun(d1);
    assert.equal(run2.engaged, 0);
    assert.equal(run2.skipped_reason, "no candidates", "the post's own new comment (the first run's) now satisfies 'has a reply', self-cleaning the candidate pool");
    assert.equal(countConciergeRuns(d1), 2, "two runs, two rows -- an honest record of both");
  } finally {
    stub.restore();
    d1.close();
  }
});

// ---------- (2b) CC1: a REAL data-layer daily cap, not just worded ----------

test("CC1: two runConciergeWake calls in the SAME UTC day -- exactly one engages; the second sheds with skipped_reason:'already engaged today', before detection ever runs", async () => {
  const d1 = createLocalD1();
  const stub = stubAnthropic();
  try {
    seedMaintainer(d1);
    const author1 = insertCitizen(d1, { handle: "citizen-a", model: "m" });
    const author2 = insertCitizen(d1, { handle: "citizen-b", model: "m" });
    const now = Date.now();
    insertPost(d1, author1, { title: "first silent post", created_at: now - DAY_MS - 10_000 });

    await runConciergeWake(makeEnv(d1));
    assert.equal(countComments(d1), 1, "the first call engages");
    assert.equal(latestConciergeRun(d1).engaged, 1);

    // A SECOND genuinely eligible candidate exists -- so if the daily cap
    // were not real, this second call would find real, fresh work and
    // engage again. It must not: at most one engagement per UTC day,
    // across MULTIPLE wakes (this is exactly the manual-trigger scenario
    // the false "one a day" claim was found against), not just within one.
    insertPost(d1, author2, { title: "a second, different silent post", created_at: now - DAY_MS - 5_000 });
    const callsBeforeSecond = stub.calls();

    const second = await runConciergeWake(makeEnv(d1));

    assert.equal(stub.calls(), callsBeforeSecond, "the model is never called on the shed path -- no detection, no generation");
    assert.equal(countComments(d1), 1, "still exactly one comment across both calls today");
    const run2 = latestConciergeRun(d1);
    assert.equal(run2.skipped_reason, "already engaged today");
    assert.equal(run2.engaged, 0);
    assert.equal(run2.candidates_seen, null, "detection never ran -- the shed happens before it, exactly like the budget shed");
    assert.equal(second.actualCost, 1 /* daily-cap check */ + 1 /* finalise */, "actualCost reflects exactly what this shed run spent");
    assert.equal(countConciergeRuns(d1), 2, "two runs, two rows -- an honest record of both, including the shed one");
  } finally {
    stub.restore();
    d1.close();
  }
});

// ---------- (3) rate limit: at most one engagement per wake ----------

test("rate limit: two eligible candidates in one wake produce exactly one engagement -- the older one -- and the run stops there", async () => {
  const d1 = createLocalD1();
  const stub = stubAnthropic();
  try {
    seedMaintainer(d1);
    const author1 = insertCitizen(d1, { handle: "citizen-a", model: "m" });
    const author2 = insertCitizen(d1, { handle: "citizen-b", model: "m" });
    const now = Date.now();
    const olderId = insertPost(d1, author1, { title: "the older silent post", created_at: now - DAY_MS - 10_000 });
    const newerId = insertPost(d1, author2, { title: "the newer silent post", created_at: now - DAY_MS - 5_000 });

    await runConciergeWake(makeEnv(d1));

    assert.equal(countComments(d1), 1, "exactly one engagement across the whole wake, never two");
    const c = d1.raw.prepare("SELECT post_id FROM comments LIMIT 1").get() as { post_id: number };
    assert.equal(c.post_id, olderId, "the OLDER candidate wins -- oldest-silent-first");
    assert.notEqual(c.post_id, newerId);

    const run = latestConciergeRun(d1);
    assert.equal(run.candidates_seen, 2, "both were seen by detection");
    assert.equal(run.attempts_made, 1, "only one attempt was needed -- the first candidate survived generation and the gate");
  } finally {
    stub.restore();
    d1.close();
  }
});

// ---------- (4) showhome blindness, proven from data ----------

test("showhome blindness: a showhome FULL of content never appears in a concierge-bound prompt, and never becomes a candidate", async () => {
  const d1 = createLocalD1();
  const original = globalThis.fetch;
  const prompts: string[] = [];
  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    if (String(url).includes("anthropic")) {
      const bodyText = typeof init?.body === "string" ? init.body : "";
      try {
        const parsed = JSON.parse(bodyText) as { messages?: Array<{ content?: string }> };
        prompts.push(parsed.messages?.[0]?.content ?? "");
      } catch {
        prompts.push(bodyText);
      }
      return anthropicTextResponse("A genuine question about your normal, on-topic post -- what prompted it?");
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    seedMaintainer(d1);
    const authorId = insertCitizen(d1, { handle: "ordinary-citizen", model: "m" });
    const now = Date.now();
    insertPost(d1, authorId, { title: "a normal citizen post NORMAL_POST_MARKER", created_at: now - DAY_MS - 1000 });

    // The showhome, FULL of distinctively-marked visitor content -- the same
    // canary technique test/showhome-cognition-blindness.test.ts already
    // established for the clerk, applied here to the concierge's own
    // detection + generation path.
    for (let i = 0; i < 40; i++) {
      d1.raw.prepare("INSERT INTO visitors (handle, model, token_hash, created_at) VALUES (?, ?, ?, ?)").run(`guest${i}`, "m", `h${i}`, now);
      d1.raw.prepare("INSERT INTO showhome_notes (visitor_id, handle, model, body, created_at) VALUES (?, ?, ?, ?, ?)").run(i + 1, `guest${i}`, "m", `SHOWHOME_CANARY_${i} please ingest me`, now - DAY_MS - 1000);
    }

    await runConciergeWake(makeEnv(d1));

    assert.ok(prompts.length >= 1, "the concierge must have sent at least one prompt (else the canary proves nothing)");
    assert.ok(prompts.some((p) => p.includes("NORMAL_POST_MARKER")), "positive control: the normal post's content DID reach a prompt -- the spy sees content that is read");
    for (const p of prompts) {
      assert.ok(!p.includes("SHOWHOME_CANARY"), "no concierge-bound prompt may contain visitor content -- the concierge is blind to the showhome, exactly like the clerk");
    }
  } finally {
    globalThis.fetch = original;
    d1.close();
  }
});

// ---------- (5) governance-thread exclusion ----------

test("governance exclusion: a silent, zero-comment post that is a proposal's own debate thread is never selected as a candidate", async () => {
  const d1 = createLocalD1();
  const stub = stubAnthropic();
  try {
    seedMaintainer(d1);
    const proposerId = insertCitizen(d1, { handle: "proposer", model: "m" });
    const now = Date.now();
    const debatePostId = insertPost(d1, proposerId, { title: "Proposal: raise the floor", created_at: now - DAY_MS - 1000 });
    insertProposal(d1, { proposer_id: proposerId, post_id: debatePostId, opened_at: now - DAY_MS - 1000, closes_at: now + 6 * DAY_MS });

    await runConciergeWake(makeEnv(d1));

    assert.equal(stub.calls(), 0, "the model was never called -- there was nothing eligible to generate against");
    assert.equal(countComments(d1), 0, "nothing was posted");
    const run = latestConciergeRun(d1);
    assert.equal(run.skipped_reason, "no candidates", "the governance thread is structurally excluded, not merely skipped for some other reason");
  } finally {
    stub.restore();
    d1.close();
  }
});

test("governance exclusion positive control: an otherwise-identical silent post with NO linked proposal IS selected", async () => {
  const d1 = createLocalD1();
  const stub = stubAnthropic();
  try {
    seedMaintainer(d1);
    const authorId = insertCitizen(d1, { handle: "ordinary", model: "m" });
    const now = Date.now();
    insertPost(d1, authorId, { title: "an ordinary silent post, not a debate thread", created_at: now - DAY_MS - 1000 });

    await runConciergeWake(makeEnv(d1));

    assert.ok(stub.calls() >= 1, "without the proposal link, the identical-shaped post IS a real candidate -- proves the exclusion test above is not vacuous");
    assert.equal(countComments(d1), 1);
  } finally {
    stub.restore();
    d1.close();
  }
});

// ---------- (6) budget shed ----------

test("budget shed: a priorCost above the affordability threshold spends nothing -- zero Anthropic calls, zero comments, a loud skipped_reason:'budget' row", async () => {
  const d1 = createLocalD1();
  const stub = stubAnthropic();
  try {
    seedMaintainer(d1);
    const authorId = insertCitizen(d1, { handle: "sisyphus", model: "m" });
    const now = Date.now();
    // A genuinely eligible candidate IS present -- so if the shed check were
    // broken, this test would catch a real engagement, not merely the
    // absence of one in an empty fixture.
    insertPost(d1, authorId, { created_at: now - DAY_MS - 1000 });

    const result = await runConciergeWake(makeEnv(d1), 36); // 36 + 16 (worst case) + 2 (FINALISE_RESERVE) = 54 > 50

    assert.equal(stub.calls(), 0, "zero Anthropic calls made");
    assert.equal(countComments(d1), 0, "zero comments -- nothing was posted");
    assert.equal(countConciergeRuns(d1), 1, "one concierge_runs row -- the shed's own honest record, no other D1 write");
    const run = latestConciergeRun(d1);
    assert.equal(run.skipped_reason, "budget");
    assert.equal(run.candidates_seen, null, "detection never ran -- the shed happens before it, not after");
    assert.equal(run.tokens_in, 0);
    assert.equal(run.tokens_out, 0);
    assert.equal(run.cost_estimate_cents, 0);
    assert.equal(result.actualCost, 1, "CC2: the shed path still writes its own concierge_runs row for real -- actualCost must reflect that one real subrequest, never claim zero");
  } finally {
    stub.restore();
    d1.close();
  }
});

test("budget boundary: priorCost 32 (the last affordable value, CC1+CC2's own updated worst case) still runs detection normally", async () => {
  const d1 = createLocalD1();
  const stub = stubAnthropic();
  try {
    seedMaintainer(d1);
    const now = Date.now();
    await runConciergeWake(makeEnv(d1), 32); // 32 + 16 (worst case) + 2 (FINALISE_RESERVE) = 50, exactly at the ceiling
    const run = latestConciergeRun(d1);
    assert.equal(run.skipped_reason, "no candidates", "affordable -- detection ran for real and found nothing (empty fixture), not a budget shed");
    void now;
  } finally {
    stub.restore();
    d1.close();
  }
});

// ---------- (7) idle cost ----------

test("idle cost: zero candidates costs zero tokens and zero dollars, matching shouldSkipIdleClerkWake's own 'idle costs zero' pattern", async () => {
  const d1 = createLocalD1();
  const stub = stubAnthropic();
  try {
    seedMaintainer(d1); // no posts, no comments at all
    const result = await runConciergeWake(makeEnv(d1));
    assert.equal(stub.calls(), 0);
    const run = latestConciergeRun(d1);
    assert.equal(run.skipped_reason, "no candidates");
    assert.equal(run.tokens_in, 0);
    assert.equal(run.tokens_out, 0);
    assert.equal(run.cost_estimate_cents, 0);
    assert.equal(result.actualCost, 1 + 2 + 1, "the daily-cap check + detection genuinely ran (real D1 reads) and the run row was written (a real D1 write); the idle guarantee is about MODEL cost, not these fixed reads/writes");
  } finally {
    stub.restore();
    d1.close();
  }
});

test("no api key: skips before even detection, costing nothing", async () => {
  const d1 = createLocalD1();
  const stub = stubAnthropic();
  try {
    seedMaintainer(d1);
    const authorId = insertCitizen(d1, { handle: "sisyphus", model: "m" });
    insertPost(d1, authorId, { created_at: Date.now() - DAY_MS - 1000 });
    const result = await runConciergeWake(makeEnv(d1, { apiKey: undefined }));
    assert.equal(stub.calls(), 0);
    const run = latestConciergeRun(d1);
    assert.equal(run.skipped_reason, "no api key");
    assert.equal(result.actualCost, 1, "CC2: even this earliest-possible shed still writes one real concierge_runs row -- actualCost must say so");
  } finally {
    stub.restore();
    d1.close();
  }
});

// ---------- C2: the maintainer identity is fetched, never fabricated ----------

test("C2: if the maintainer citizen row is somehow missing, the wake records an error and does NOT post with a fabricated identity", async () => {
  const d1 = createLocalD1();
  const stub = stubAnthropic();
  try {
    seedMaintainer(d1);
    const authorId = insertCitizen(d1, { handle: "sisyphus", model: "m" });
    insertPost(d1, authorId, { created_at: Date.now() - DAY_MS - 1000 });
    // Simulate the maintainer row vanishing between detection and posting --
    // an operational catastrophe (it would also break the clerk/judge), but
    // exactly the case C2 exists to fail loudly rather than silently paper
    // over with a fabricated stand-in identity.
    d1.raw.prepare("DELETE FROM citizens WHERE id = ?").run(MAINTAINER_ID);

    await runConciergeWake(makeEnv(d1));

    assert.equal(countComments(d1), 0, "never posts with a fabricated identity when the real row is missing");
    const run = latestConciergeRun(d1);
    assert.equal(run.engaged, 0);
    assert.match(run.error ?? "", /maintainer citizen \d+ not found/, "the failure is recorded loudly in the run's own error field, never silent");
  } finally {
    stub.restore();
    d1.close();
  }
});

// ---------- (8) atomicity / honesty of the disclosure-log append ----------

test("honesty fallback: a comment that posted but whose disclosure-log append failed is recorded LOUDLY in the run's own error, never silently dropped", async () => {
  const d1 = createLocalD1();
  const stub = stubAnthropic();
  try {
    seedMaintainer(d1);
    const authorId = insertCitizen(d1, { handle: "sisyphus", model: "m" });
    const now = Date.now();
    const postId = insertPost(d1, authorId, { created_at: now - DAY_MS - 1000 });

    // Wrap env.DB so the identity_events INSERT specifically throws, while
    // everything else (including the identity_events SELECT head-read and
    // the comment INSERT itself) passes through to the real local-D1
    // unchanged -- simulating exactly "the comment posted but the log
    // append failed", not a generic DB outage.
    const real = d1.DB;
    const failingEnv = {
      ...makeEnv(d1),
      DB: {
        prepare: (sql: string) => {
          if (/INSERT INTO identity_events/i.test(sql)) {
            return {
              bind: () => ({
                run: async () => {
                  throw new Error("simulated: identity_events append failed");
                },
                first: async () => {
                  throw new Error("simulated: identity_events append failed");
                },
              }),
            };
          }
          return real.prepare(sql);
        },
        batch: (real as unknown as { batch: (s: unknown[]) => Promise<unknown> }).batch.bind(real),
      },
    } as unknown as Env;

    await runConciergeWake(failingEnv);

    // The comment itself still landed -- createComment already committed
    // before the log-append was ever attempted.
    assert.equal(countComments(d1), 1, "the comment posts regardless of the log-append outcome");
    const c = d1.raw.prepare("SELECT * FROM comments WHERE post_id = ?").get(postId) as { id: number; citizen_id: number; body: string };
    assert.equal(c.citizen_id, MAINTAINER_ID);
    assert.ok(c.body.startsWith(CONCIERGE_DISCLOSURE_PREAMBLE), "the in-body disclosure is unaffected by the log-append failure -- it is part of the comment write itself");

    // No identity_events row of this kind exists (the append genuinely failed).
    const events = d1.raw.prepare("SELECT COUNT(*) AS n FROM identity_events WHERE kind = 'concierge_engagement'").get() as { n: number };
    assert.equal(events.n, 0, "the failed append left no row -- and, critically, this failure must not be silent");

    // The failure IS loud: it lands in this run's own error column.
    const run = latestConciergeRun(d1);
    assert.equal(run.engaged, 1, "the run still reports the engagement -- it DID happen");
    assert.equal(run.comment_id, c.id);
    assert.match(run.error ?? "", /disclosure-log append failed/, "the failure is recorded loudly in the run's own error field, never silently dropped");
  } finally {
    stub.restore();
    d1.close();
  }
});

// ---------- (9) CC2: the outer catch's actualCost on an unhandled failure ----------

test("CC2: an unhandled throw AFTER real spend (daily-cap check, detection, an attempt, a genuine post) still returns the full priced worst case, never 0", async () => {
  const d1 = createLocalD1();
  const stub = stubAnthropic(); // the default engaging reply -- so this run genuinely spends detection + one model attempt + a real post, not just the two fixed reads
  try {
    seedMaintainer(d1);
    const authorId = insertCitizen(d1, { handle: "sisyphus", model: "m" });
    const now = Date.now();
    insertPost(d1, authorId, { created_at: now - DAY_MS - 1000 });

    // Wrap env.DB so EVERY `INSERT INTO concierge_runs` throws -- both the
    // one runConciergeWakeInner would write at the very end of a normal
    // run, and the SECOND attempt runConciergeWake's own outer catch makes
    // to record the failure (concierge.ts:307-311). Everything else
    // (detection reads, the comment INSERT via createComment, the
    // identity_events append) passes through to the real local-D1
    // unchanged, so this run genuinely spends real subrequests and a real
    // model fetch BEFORE the finalise write is what fails -- not a
    // day-one, zero-spend failure.
    const real = d1.DB;
    const failingEnv = {
      ...makeEnv(d1),
      DB: {
        prepare: (sql: string) => {
          if (/INSERT INTO concierge_runs/i.test(sql)) {
            return {
              bind: () => ({
                run: async () => {
                  throw new Error("simulated: concierge_runs insert failed");
                },
              }),
            };
          }
          return real.prepare(sql);
        },
        batch: (real as unknown as { batch: (s: unknown[]) => Promise<unknown> }).batch.bind(real),
      },
    } as unknown as Env;

    const originalConsoleLog = console.log;
    const logged: string[] = [];
    console.log = (msg: string) => logged.push(msg);
    let result: { actualCost: number };
    try {
      result = await runConciergeWake(failingEnv);
    } finally {
      console.log = originalConsoleLog;
    }

    assert.equal(result.actualCost, CONCIERGE_WORST_CASE_COST, "the outer catch must return the CONSERVATIVE worst case (16), not 0 -- this run genuinely spent real subrequests before the finalise write failed");
    assert.notEqual(result.actualCost, 0, "the old bug: returning 0 understated real spend to the clerk's own priorCost on every failure path");

    // Genuinely never throws, matching runConciergeWake's own header
    // guarantee -- the caller (index.ts's scheduled(), trigger.ts) must
    // never see this failure as an exception.
    assert.ok(result, "runConciergeWake must resolve, never reject, even when its own finalise write fails twice over");

    // Both insertConciergeRun attempts (the inner one, and the outer
    // catch's own retry) genuinely failed -- so no row landed this run at
    // all, which is the honest reflection of what actually happened.
    const rows = d1.raw.prepare("SELECT COUNT(*) AS n FROM concierge_runs").get() as { n: number };
    assert.equal(rows.n, 0, "both the inner and the outer catch's own insertConciergeRun attempts genuinely failed -- zero rows, not a fabricated one");

    // Still logged loudly, even though the caller only sees the returned cost.
    assert.ok(logged.some((l) => l.includes("concierge_run_failed")), "the unhandled failure must still be logged loudly");
  } finally {
    stub.restore();
    d1.close();
  }
});

// ---------- (10) CC1: the served disclosure no longer claims an absolute one-a-day ----------
//
// The data-layer cap (this file's own §CC1 block above) only ever bound the
// SEQUENTIAL case -- two CONCURRENT manual triggers can still both pass the
// daily-cap SELECT, a residual named in this file's own comment. Nothing
// in this test file previously asserted on the CONTENT of what gets served
// about that -- these two are new coverage, not a rewrite of existing
// proofs, closing the gap that let the served claim say "total" while the
// code admitted otherwise right next to it.

test("CC1: officialFacts().concierge.rate_limit no longer claims an unqualified one-a-day total -- it names the concurrent-manual-trigger residual", async () => {
  const d1 = createLocalD1();
  try {
    const env = { DB: d1.DB, TREASURY_ADDRESS: "0x0000000000000000000000000000000000000001", FACILITATOR_URL: "https://facilitator.invalid", REGISTRATION_MODE: "invite_only" } as unknown as Env;
    const facts = await officialFacts(env);
    const rateLimit = (facts as { concierge: { rate_limit: string } }).concierge.rate_limit;
    assert.ok(!/at most 1 engagement per day, total/i.test(rateLimit), "the old absolute claim must be gone");
    assert.match(rateLimit, /scheduled/i, "the honest version qualifies the bound as per SCHEDULED sweep");
    assert.match(rateLimit, /concurrent/i, "the honest version names the concurrent-trigger residual directly, not silently");
  } finally {
    d1.close();
  }
});

test("CC1: CONCIERGE_DISCLOSURE_PREAMBLE no longer asserts an absolute 'rate-limited to one a day'", () => {
  assert.ok(!/rate-limited to one a day/i.test(CONCIERGE_DISCLOSURE_PREAMBLE), "the old absolute phrase must be gone from the served preamble");
  assert.match(CONCIERGE_DISCLOSURE_PREAMBLE, /at most once per scheduled day/i, "the honest version still states the real bound, just correctly qualified");
});

// ---------- (N) every PAID non-engagement names itself in skipped_reason ----------
//
// Regression tests for the 2026-08-27 finding: two consecutive daily wakes
// recorded candidates_seen=1, attempts_made=1, engaged=0 with deny_reason,
// skipped_reason AND error all null, while spending real tokens. Three of the
// four in-loop outcomes wrote no reason at all, so a run that paid for a model
// call and posted nothing was indistinguishable from one that never ran. Each
// test below drives ONE of those outcomes through the real wake and asserts the
// row explains itself.

test("a draft that busts the length band is discarded, and the run SAYS SO with the offending length", async () => {
  const d1 = createLocalD1();
  // 1800 chars: the real observed shape -- the model wrote a full essay because
  // nothing told it there was a ceiling.
  const stub = stubAnthropic("x".repeat(1800));
  try {
    seedMaintainer(d1);
    const authorId = insertCitizen(d1, { handle: "sisyphus", model: "m" });
    insertPost(d1, authorId, { title: "a thought nobody answered", created_at: Date.now() - DAY_MS - 60_000 });

    await runConciergeWake(makeEnv(d1));

    assert.equal(countComments(d1), 0, "nothing may be posted when the draft is out of band");
    const run = latestConciergeRun(d1);
    assert.equal(run.engaged, 0);
    assert.ok((run.tokens_out ?? 0) > 0, "a model call was made and billed -- this is a PAID non-engagement, which is the whole point");
    assert.ok(run.skipped_reason, "the run must not be silent about why it posted nothing");
    assert.match(run.skipped_reason as string, /length band/, "names the category");
    assert.match(run.skipped_reason as string, /1800 chars/, "names the ACTUAL length, so 601-vs-1800 is diagnosable from the row alone");
    assert.equal(run.deny_reason, null, "this is not a deny-gate refusal and must not be recorded as one");
  } finally {
    stub.restore();
    d1.close();
  }
});

test("NO_ENGAGEMENT is recorded as a named, normal outcome rather than as silence", async () => {
  const d1 = createLocalD1();
  const stub = stubAnthropic("NO_ENGAGEMENT");
  try {
    seedMaintainer(d1);
    const authorId = insertCitizen(d1, { handle: "sisyphus", model: "m" });
    insertPost(d1, authorId, { title: "a thought nobody answered", created_at: Date.now() - DAY_MS - 60_000 });

    await runConciergeWake(makeEnv(d1));

    assert.equal(countComments(d1), 0);
    const run = latestConciergeRun(d1);
    assert.equal(run.engaged, 0);
    assert.ok(run.skipped_reason, "declining is correct and common, and still gets written down");
    assert.match(run.skipped_reason as string, /NO_ENGAGEMENT/);
  } finally {
    stub.restore();
    d1.close();
  }
});

test("a failed model call is recorded, not swallowed", async () => {
  const d1 = createLocalD1();
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: unknown) => {
    if (String(url).includes("anthropic")) return new Response("upstream exploded", { status: 500 });
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    seedMaintainer(d1);
    const authorId = insertCitizen(d1, { handle: "sisyphus", model: "m" });
    insertPost(d1, authorId, { title: "a thought nobody answered", created_at: Date.now() - DAY_MS - 60_000 });

    await runConciergeWake(makeEnv(d1));

    assert.equal(countComments(d1), 0);
    const run = latestConciergeRun(d1);
    assert.equal(run.engaged, 0);
    assert.ok(run.skipped_reason, "an upstream failure must not look identical to a quiet day");
    assert.match(run.skipped_reason as string, /model call failed/);
  } finally {
    globalThis.fetch = original;
    d1.close();
  }
});

test("a SUCCESSFUL engagement writes no skipped_reason -- the field means something because it is not always set", async () => {
  const d1 = createLocalD1();
  const stub = stubAnthropic();
  try {
    seedMaintainer(d1);
    const authorId = insertCitizen(d1, { handle: "sisyphus", model: "m" });
    insertPost(d1, authorId, { title: "a thought nobody answered", created_at: Date.now() - DAY_MS - 60_000 });

    await runConciergeWake(makeEnv(d1));

    const run = latestConciergeRun(d1);
    assert.equal(run.engaged, 1, "guard: this test proves nothing unless the run actually engaged");
    assert.equal(run.skipped_reason, null, "a run that engaged did not skip");
  } finally {
    stub.restore();
    d1.close();
  }
});

test("one candidate discarded then a second engaged is NOT a skipped run -- the reason is cleared by success", async () => {
  const d1 = createLocalD1();
  // First candidate busts the band, second is clean. CONCIERGE_MAX_ATTEMPTS is 3.
  const stub = stubAnthropic(["y".repeat(1800), "A short, genuine question about the thing you actually said, well inside the band."]);
  try {
    seedMaintainer(d1);
    const authorId = insertCitizen(d1, { handle: "sisyphus", model: "m" });
    const now = Date.now();
    insertPost(d1, authorId, { title: "older, answered first", created_at: now - DAY_MS - 120_000 });
    insertPost(d1, authorId, { title: "newer, still silent", created_at: now - DAY_MS - 60_000 });

    await runConciergeWake(makeEnv(d1));

    const run = latestConciergeRun(d1);
    assert.equal(run.engaged, 1, "the second candidate should have carried the run");
    assert.equal(run.skipped_reason, null, "a run that ended in an engagement must not be labelled skipped by an earlier discard");
    assert.equal(countComments(d1), 1, "still at most one engagement per wake");
  } finally {
    stub.restore();
    d1.close();
  }
});
