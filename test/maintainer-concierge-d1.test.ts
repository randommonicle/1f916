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
import { MAINTAINER_ID, CONCIERGE_DISCLOSURE_PREAMBLE, type Env } from "../src/society.ts";
import { MAINTAINER_MODELS } from "../src/maintainer/anthropic.ts";
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
    assert.equal(result.actualCost, 2 /* detection */ + 1 /* one attempt */ + 8 /* post */, "actualCost reflects exactly what this run spent");

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

test("non-maintainer citizens are never touched: the model used for generation is the clerk tier, the comment's author_model is the maintainer's own", async () => {
  const d1 = createLocalD1();
  const stub = stubAnthropic();
  try {
    seedMaintainer(d1);
    const authorId = insertCitizen(d1, { handle: "another-citizen", model: "m" });
    const now = Date.now();
    insertPost(d1, authorId, { created_at: now - DAY_MS - 1000 });
    await runConciergeWake(makeEnv(d1));
    const c = d1.raw.prepare("SELECT author_model FROM comments LIMIT 1").get() as { author_model: string };
    assert.equal(c.author_model, MAINTAINER_MODELS.clerk, "createComment snapshots citizen.model at write time -- the maintainer object concierge.ts constructs uses the clerk tier");
  } finally {
    stub.restore();
    d1.close();
  }
});

// ---------- (2) self-cleaning ----------

test("self-cleaning: running the wake twice against the same fixture engages once, then finds zero candidates the second time", async () => {
  const d1 = createLocalD1();
  const stub = stubAnthropic();
  try {
    seedMaintainer(d1);
    const authorId = insertCitizen(d1, { handle: "sisyphus", model: "m" });
    const now = Date.now();
    insertPost(d1, authorId, { created_at: now - DAY_MS - 1000 });

    const first = await runConciergeWake(makeEnv(d1));
    assert.equal(first.actualCost, 2 + 1 + 8);
    assert.equal(countComments(d1), 1, "first run engages");
    assert.equal(latestConciergeRun(d1).engaged, 1);

    const second = await runConciergeWake(makeEnv(d1));
    assert.equal(second.actualCost, 2, "second run only pays the detection cost -- zero candidates, zero attempts");
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

    const result = await runConciergeWake(makeEnv(d1), 36); // 36 + 13 + 2 = 51 > 50

    assert.equal(stub.calls(), 0, "zero Anthropic calls made");
    assert.equal(countComments(d1), 0, "zero comments -- nothing was posted");
    assert.equal(countConciergeRuns(d1), 1, "zero D1 writes beyond the concierge_runs row itself");
    const run = latestConciergeRun(d1);
    assert.equal(run.skipped_reason, "budget");
    assert.equal(run.candidates_seen, null, "detection never ran -- the shed happens before it, not after");
    assert.equal(run.tokens_in, 0);
    assert.equal(run.tokens_out, 0);
    assert.equal(run.cost_estimate_cents, 0);
    assert.equal(result.actualCost, 0, "nothing was spent this invocation on this phase");
  } finally {
    stub.restore();
    d1.close();
  }
});

test("budget boundary: priorCost 35 (the last affordable value) still runs detection normally", async () => {
  const d1 = createLocalD1();
  const stub = stubAnthropic();
  try {
    seedMaintainer(d1);
    const now = Date.now();
    await runConciergeWake(makeEnv(d1), 35); // 35 + 13 + 2 = 50, exactly at the ceiling
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
    assert.equal(result.actualCost, 2, "detection genuinely ran (2 D1 reads); the idle guarantee is about MODEL cost, not the fixed detection reads");
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
    assert.equal(result.actualCost, 0);
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
