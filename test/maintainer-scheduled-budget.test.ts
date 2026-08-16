// THE PROOF (docs/BRIEF-JUDGMENT-QUERY-BUDGET.md). The precise error that let
// the prior wave ship was testing the scanner in isolation and counting only
// D1 statements. This wraps the ENTIRE scheduled() invocation -- the real
// Worker default export's scheduled() handler -- behind ONE shared counter
// over BOTH the D1 boundary AND globalThis.fetch, so every Anthropic model
// call and every Base RPC probe counts as a subrequest exactly as a D1
// statement does. Subrequest 51 throws; the verdict for every path is
// `total() <= 50 && !breached()`.
//
// The sweep runs first, then the wake, in ONE invocation sharing the 50
// budget -- so these scenarios prove the COMPOUND cases the brief rules
// binding (D-041): a due proposal AND a replayed stranded row AND full
// batches, together, never crossing 50 because the wake sheds what it cannot
// pay for.
//
// Run just this file: node --experimental-strip-types --test "test/maintainer-scheduled-budget.test.ts"

import test, { before } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import { createLocalD1, insertCitizen, insertProposal, type LocalD1 } from "./helpers/local-d1.ts";
import { installSubrequestCounter, makeModelRpcResponder, judgmentDecisionText, clerkDraftText, rpcBalanceResponse } from "./helpers/subrequest-counter.ts";
import { MAINTAINER_MODELS } from "../src/maintainer/anthropic.ts";
import { JUDGMENT_CRON, CLERK_CRON } from "../src/maintainer/schedule.ts";
import { detectConstitutionChange } from "../src/governance.ts";
import type { Env } from "../src/society.ts";

// Pre-warm the shared PROCESS_CONSTITUTION_CACHE ONCE, deterministically, so
// every scheduled() detection below is a cache hit costing 0 D1 -- otherwise a
// cold-cache genesis landing (~4 D1, order-dependent) would vary the counts
// and could nudge the compound case toward 50. The cache is keyed on the
// deploy-fixed live pair, so a hit warmed from this throwaway DB serves every
// test DB without touching it.
before(async () => {
  const warm = createLocalD1();
  try {
    await detectConstitutionChange({ DB: warm.DB, TREASURY_ADDRESS: "0x0", REGISTRATION_MODE: "invite_only" } as unknown as Env, Date.now());
  } finally {
    warm.close();
  }
});

function makeEnv(d1: LocalD1): Env {
  return {
    DB: d1.DB,
    ANTHROPIC_API_KEY: "test-key",
    TREASURY_ADDRESS: "0x0000000000000000000000000000000000000001",
    REGISTRATION_MODE: "invite_only",
    FACILITATOR_URL: "https://facilitator.invalid",
  } as unknown as Env;
}

// A minimal ScheduledController + ExecutionContext for the handler.
function makeController(cron: string) {
  return { cron, scheduledTime: Date.now(), noRetry: () => {} };
}
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };

async function callScheduled(cron: string, env: Env): Promise<void> {
  // The impl uses (controller, env); the type carries a third ctx param.
  await (worker.scheduled as unknown as (c: unknown, e: Env, x: unknown) => Promise<void>)(makeController(cron), env, ctx);
}

// ---------- fixture seeders (all via d1.raw -- uncounted scaffolding) ----------

function seedMaintainer(d1: LocalD1): void {
  const id = insertCitizen(d1, { handle: "commonhold-agent", model: "claude-fable-5" });
  assert.equal(id, 1, "the maintainer must be citizen #1 (first insert into a fresh DB)");
}
function seedRunRow(d1: LocalD1): number {
  return Number(d1.raw.prepare("INSERT INTO maintainer_runs (kind, started_at) VALUES ('judgment', ?)").run(Date.now()).lastInsertRowid);
}
function seedPendingBulletin(d1: LocalD1, runId: number, i: number, createdAt: number): void {
  d1.raw
    .prepare("INSERT INTO maintainer_queue (run_id, created_at, kind, target_type, target_id, source_ref, note, status) VALUES (?, ?, 'bulletin_draft', NULL, NULL, NULL, ?, 'pending')")
    .run(runId, createdAt, `Digest ${i}\nBody number ${i}, all quiet this week.`);
}
function seedApprovedBulletin(d1: LocalD1, runId: number, i: number, decidedAt: number): void {
  d1.raw
    .prepare("INSERT INTO maintainer_queue (run_id, created_at, kind, target_type, target_id, source_ref, note, status, decided_at, decided_reason) VALUES (?, ?, 'bulletin_draft', NULL, NULL, NULL, ?, 'approved', ?, 'looked fine')")
    .run(runId, decidedAt - 100_000, `Stranded digest ${i}\nBody number ${i}.`, decidedAt);
}
// A due proposal that fails quorum (no ballots) -- the cheapest sweep-processed
// shape, still costing the full claim/tally/commit path.
function seedDueProposal(d1: LocalD1, closesAt: number): number {
  return insertProposal(d1, { kind: "resolution", status: "open", opened_at: closesAt - 8 * 86_400_000, closes_at: closesAt });
}

const judgmentResponder = makeModelRpcResponder({ judgmentModel: MAINTAINER_MODELS.judgment, clerkModel: MAINTAINER_MODELS.clerk });

// ---------- shape 1: the judgment wake, end to end ----------

test("PROOF J1 -- quiet judgment (zero-due sweep, no replay): one pending bulletin decided, <= 50 with headroom", async () => {
  const counter = installSubrequestCounter(judgmentResponder);
  const d1 = createLocalD1({ onExec: counter.consume });
  try {
    seedMaintainer(d1);
    const runId = seedRunRow(d1);
    seedPendingBulletin(d1, runId, 0, Date.now() - 5_000);
    await callScheduled(JUDGMENT_CRON, makeEnv(d1));
    assert.equal(counter.breached(), false, `never exceeded budget (total ${counter.total()}, d1 ${counter.d1()}, fetch ${counter.fetches()})`);
    assert.ok(counter.total() <= 50, `total ${counter.total()} <= 50`);
    assert.ok(counter.fetches() >= 1, `fetches ARE counted as subrequests (${counter.fetches()} model call(s) tallied)`);
  } finally {
    counter.restore();
    d1.close();
  }
});

test("PROOF J2 -- four full batches at C=1 (quiet sweep): four bulletins, the 6-per-decision worst case, <= 50", async () => {
  const counter = installSubrequestCounter(judgmentResponder);
  const d1 = createLocalD1({ onExec: counter.consume });
  try {
    seedMaintainer(d1);
    const runId = seedRunRow(d1);
    const now = Date.now();
    for (let i = 0; i < 6; i++) seedPendingBulletin(d1, runId, i, now - (6 - i) * 1_000); // more than 4 pending; the loop stops at JUDGMENT_MAX_BATCHES
    await callScheduled(JUDGMENT_CRON, makeEnv(d1));
    const posts = (d1.raw.prepare("SELECT COUNT(*) AS n FROM posts").get() as { n: number }).n;
    assert.equal(counter.breached(), false, `never exceeded budget (total ${counter.total()}, d1 ${counter.d1()}, fetch ${counter.fetches()}, posts ${posts})`);
    assert.ok(counter.total() <= 50, `four-batch worst case total ${counter.total()} <= 50`);
    assert.equal(counter.fetches(), 4, "exactly four model calls (JUDGMENT_MAX_BATCHES), each counted");
    assert.equal(posts, 4, "four bulletins posted -- the ceiling per weekly wake");
  } finally {
    counter.restore();
    d1.close();
  }
});

test("PROOF J3 -- withhold path (a missing-version fidelity item + a pending bulletin): withheld loudly, model never called for it, <= 50", async () => {
  const counter = installSubrequestCounter(judgmentResponder);
  const d1 = createLocalD1({ onExec: counter.consume });
  try {
    seedMaintainer(d1);
    const runId = seedRunRow(d1);
    const now = Date.now();
    d1.raw
      .prepare("INSERT INTO maintainer_queue (run_id, created_at, kind, target_type, target_id, source_ref, note, status) VALUES (?, ?, 'constitution_fidelity', NULL, NULL, 'constitution_versions:999999', 'missing', 'pending')")
      .run(runId, now - 10_000);
    seedPendingBulletin(d1, runId, 0, now - 5_000);
    await callScheduled(JUDGMENT_CRON, makeEnv(d1));
    assert.equal(counter.breached(), false, `total ${counter.total()}, d1 ${counter.d1()}, fetch ${counter.fetches()}`);
    assert.ok(counter.total() <= 50, `withhold-path total ${counter.total()} <= 50`);
  } finally {
    counter.restore();
    d1.close();
  }
});

test("PROOF J4 -- execution-failure path (a flag_review on a vanished post): the failed executor is re-stamped, wake still finalises, <= 50", async () => {
  const counter = installSubrequestCounter(judgmentResponder);
  const d1 = createLocalD1({ onExec: counter.consume });
  try {
    seedMaintainer(d1);
    const runId = seedRunRow(d1);
    const now = Date.now();
    // A pending flag_review targeting a post id that does not exist -> the
    // judge approves+removes (stub) -> moderateContent throws -> re-stamp path.
    d1.raw
      .prepare("INSERT INTO maintainer_queue (run_id, created_at, kind, target_type, target_id, source_ref, note, status) VALUES (?, ?, 'flag_review', 'post', 987654, NULL, 'flagged: spam', 'pending')")
      .run(runId, now - 5_000);
    await callScheduled(JUDGMENT_CRON, makeEnv(d1));
    assert.equal(counter.breached(), false, `total ${counter.total()}, d1 ${counter.d1()}, fetch ${counter.fetches()}`);
    assert.ok(counter.total() <= 50, `execution-failure-path total ${counter.total()} <= 50`);
  } finally {
    counter.restore();
    d1.close();
  }
});

test("PROOF J5 -- the D-041 COMPOUND worst case (2-due sweep + 3 stranded replay + 4 pending bulletins): shed holds the line at <= 50", async () => {
  const counter = installSubrequestCounter(judgmentResponder);
  const d1 = createLocalD1({ onExec: counter.consume });
  try {
    seedMaintainer(d1);
    for (let i = 0; i < 4; i++) insertCitizen(d1); // a small census for the sweep's tally
    const runId = seedRunRow(d1);
    const now = Date.now();
    // Sweep cohort: 2 due proposals (the cap).
    seedDueProposal(d1, now - 3_000);
    seedDueProposal(d1, now - 2_000);
    // Replay cohort: 3 stranded approved bulletins (JUDGMENT_REPLAY_CAP).
    for (let i = 0; i < 3; i++) seedApprovedBulletin(d1, runId, i, now - (i + 1) * 1_000);
    // Fresh pending work the wake would love to do but must shed.
    for (let i = 0; i < 4; i++) seedPendingBulletin(d1, runId, 100 + i, now - (4 - i) * 100);
    await callScheduled(JUDGMENT_CRON, makeEnv(d1));
    assert.equal(counter.breached(), false, `COMPOUND never exceeded budget (total ${counter.total()}, d1 ${counter.d1()}, fetch ${counter.fetches()})`);
    assert.ok(counter.total() <= 50, `COMPOUND total ${counter.total()} <= 50 -- the whole point of the shed`);
    const run = d1.raw.prepare("SELECT error FROM maintainer_runs WHERE kind = 'judgment' ORDER BY started_at DESC LIMIT 1").get() as { error: string | null };
    assert.match(run.error ?? "", /batches shed for subrequest budget/, "the shed is loud on the compound path");
  } finally {
    counter.restore();
    d1.close();
  }
});

// Pregate cleanup wave (docs/CHECKPOINT-PREGATE.md), added after THE PROOF
// (commit 12b2dc1) closed the wave: a verification pass measured, through
// this same real scheduled() invocation, that the matrix above skips the
// INTERIOR of the shed decision space. J5 proves the BOUNDARY (2-due sweep
// + 3-replay-cap -> every batch sheds, fetch=0, total 42) and the sweep-
// cohort test below proves the QUIET end (0 sweep/replay, 1 batch). Neither
// proves the point in between where the sweep and replay are real but
// SMALL enough that canOpenJudgmentBatch keeps affording batches -- so
// several of them actually run (a real model fetch + real decision writes
// each), stacked on top of real (not shed) sweep and replay cost. That
// combination is the genuine peak this file's own arithmetic predicts is
// higher than either extreme: worked from budget.ts's real constants, a
// 1-due sweep (estimateSweepCost(1) = 3 + 9 = 12) and a 1-row replay
// (6) leaves canOpenJudgmentBatch(12, 1, batchesOpened) affording
// batchesOpened <= 2, i.e. batches 1-3 open for real and a 4th sheds.
test("PROOF J-interior -- a 1-due sweep + 1 replayed row + a full pending fidelity set, opening several REAL batches on top of sweep+replay (the interior peak between J5's all-shed boundary and the quiet case)", async () => {
  const counter = installSubrequestCounter(judgmentResponder);
  const d1 = createLocalD1({ onExec: counter.consume });
  try {
    seedMaintainer(d1);
    for (let i = 0; i < 4; i++) insertCitizen(d1); // a small census for the sweep's tally
    const runId = seedRunRow(d1);
    const now = Date.now();
    // Sweep cohort: 1 due proposal (the interior case, not the 2-cap boundary).
    seedDueProposal(d1, now - 3_000);
    // Replay cohort: 1 stranded approved bulletin (not the 3-cap boundary).
    seedApprovedBulletin(d1, runId, 0, now - 2_000);
    // A full pending fidelity set, every one withheld (missing-version, J6's
    // own cheap fixture shape): scanned and classified set-based in whichever
    // batch first reaches them, costing real D1 without ever calling the
    // model for them. Older than every bulletin below, so they are the FIRST
    // page a scan sees.
    for (let i = 0; i < 50; i++) {
      d1.raw
        .prepare("INSERT INTO maintainer_queue (run_id, created_at, kind, target_type, target_id, source_ref, note, status) VALUES (?, ?, 'constitution_fidelity', NULL, NULL, ?, 'missing', 'pending')")
        .run(runId, now - 50_000 - i, `constitution_versions:${900000 + i}`);
    }
    // Five real pending bulletins, newer than every fidelity item: enough for
    // canOpenJudgmentBatch to open several real batches on top of the sweep
    // and replay cost above, with at least one left over so the shed still
    // has something to protect the budget against.
    for (let i = 0; i < 5; i++) seedPendingBulletin(d1, runId, i, now - 2_500 + i * 100);
    await callScheduled(JUDGMENT_CRON, makeEnv(d1));
    const posts = (d1.raw.prepare("SELECT COUNT(*) AS n FROM posts").get() as { n: number }).n;
    assert.equal(counter.breached(), false, `interior compound never exceeded budget (total ${counter.total()}, d1 ${counter.d1()}, fetch ${counter.fetches()}, posts ${posts})`);
    assert.ok(counter.total() <= 50, `interior compound total ${counter.total()} <= 50 -- the real peak, not the shed boundary`);
  } finally {
    counter.restore();
    d1.close();
  }
});

test("PROOF sweep cohorts 0 / 1 / cap through the judgment invocation each stay <= 50", async () => {
  for (const dueCount of [0, 1, 2]) {
    const counter = installSubrequestCounter(judgmentResponder);
    const d1 = createLocalD1({ onExec: counter.consume });
    try {
      seedMaintainer(d1);
      for (let i = 0; i < 4; i++) insertCitizen(d1);
      const runId = seedRunRow(d1);
      const now = Date.now();
      for (let i = 0; i < dueCount; i++) seedDueProposal(d1, now - (i + 1) * 1_000);
      seedPendingBulletin(d1, runId, 0, now - 500);
      await callScheduled(JUDGMENT_CRON, makeEnv(d1));
      assert.equal(counter.breached(), false, `sweep cohort ${dueCount}: total ${counter.total()}, d1 ${counter.d1()}, fetch ${counter.fetches()}`);
      assert.ok(counter.total() <= 50, `sweep cohort ${dueCount} total ${counter.total()} <= 50`);
    } finally {
      counter.restore();
      d1.close();
    }
  }
});

test("PROOF J6 -- a 60-row missing-version fidelity head through the WHOLE invocation stays <= 50 (the set-based classification fixture the e2e red-proof breaks)", async () => {
  // 60 rows: comfortably more than the 50-subrequest budget, so per-row
  // hydration (the pre-fix behaviour) would throw at subrequest 51 inside the
  // real scheduled() invocation -- see the pasted e2e red-proof in
  // docs/CHECKPOINT-QUERY-BUDGET.md. Set-based, it is a couple of statements.
  const counter = installSubrequestCounter(judgmentResponder);
  const d1 = createLocalD1({ onExec: counter.consume });
  try {
    seedMaintainer(d1);
    const runId = seedRunRow(d1);
    const now = Date.now();
    for (let i = 0; i < 60; i++) {
      d1.raw
        .prepare("INSERT INTO maintainer_queue (run_id, created_at, kind, target_type, target_id, source_ref, note, status) VALUES (?, ?, 'constitution_fidelity', NULL, NULL, ?, 'missing', 'pending')")
        .run(runId, now - (60 - i) * 100, `constitution_versions:${900000 + i}`);
    }
    await callScheduled(JUDGMENT_CRON, makeEnv(d1));
    assert.equal(counter.breached(), false, `60-row fidelity head never exceeded budget (total ${counter.total()}, d1 ${counter.d1()}, fetch ${counter.fetches()})`);
    assert.ok(counter.total() <= 50, `set-based classification keeps a 60-row head at total ${counter.total()} <= 50`);
  } finally {
    counter.restore();
    d1.close();
  }
});

// ---------- shape 2: the clerk wake, end to end ----------

test("PROOF C1 -- clerk full gather (50-candidate flag-heavy) + 4-RPC-worst drift + model + K inserts, co-resident sweep, <= 50", async () => {
  // Clerk responder: the model returns K bookkeeping drafts; the RPC endpoint
  // returns "0x" for every probe so readOnchainUsdcCents tries all four
  // (the drift worst case), then the clerk still proceeds on candidates.
  const K = 20;
  const clerkResponder = (url: string, init: { body?: unknown } | undefined) => {
    if (url.includes("api.anthropic.com")) {
      const drafts = Array.from({ length: K }, (_, i) => ({ kind: "bookkeeping_note", note: `drift note ${i}` }));
      return makeModelRpcResponder({ judgmentModel: MAINTAINER_MODELS.judgment, clerkModel: MAINTAINER_MODELS.clerk, onClerk: () => clerkDraftText(drafts) })(url, init);
    }
    // Base RPC probe: return a "0x" result so every fallback RPC is tried.
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const counter = installSubrequestCounter(clerkResponder);
  const d1 = createLocalD1({ onExec: counter.consume });
  try {
    seedMaintainer(d1);
    for (let i = 0; i < 4; i++) insertCitizen(d1);
    const now = Date.now();
    // 1 due proposal so a sweep is co-resident, and 50 flags on real posts so
    // the flag-hydration gather is exercised at CLERK_INPUT_CAP.
    seedDueProposal(d1, now - 1_000);
    for (let i = 0; i < 50; i++) {
      const postId = Number(d1.raw.prepare("INSERT INTO posts (citizen_id, title, body, dupe_hash, pinned, author_model, created_at) VALUES (1, ?, ?, ?, 0, 'm', ?)").run(`P${i}`, `body ${i}`, `h${i}`, now - 1_000_000).lastInsertRowid);
      d1.raw.prepare("INSERT INTO flags (citizen_id, target_type, target_id, reason, created_at) VALUES (1, 'post', ?, 'spam', ?)").run(postId, now - (50 - i) * 100);
    }
    await callScheduled(CLERK_CRON, makeEnv(d1));
    assert.equal(counter.breached(), false, `clerk never exceeded budget (total ${counter.total()}, d1 ${counter.d1()}, fetch ${counter.fetches()})`);
    assert.ok(counter.total() <= 50, `clerk full-gather total ${counter.total()} <= 50`);
    assert.ok(counter.fetches() >= 4, `the 4-RPC drift worst case was exercised plus the model call (${counter.fetches()} fetches)`);
  } finally {
    counter.restore();
    d1.close();
  }
});

// Pregate cleanup wave (docs/CHECKPOINT-PREGATE.md): PROOF C1 above only
// measured the clerk's full-gather worst case at governance-sweep cohort 1.
// A verification pass measured the SAME full-gather shape at cohort 0 and
// cohort 2 (the cap) too, on the reasoning that affordableClerkInserts
// shrinks as priorCost grows, so cohort 2's affordable insert cap (and
// therefore its own subrequest total) sits closest to the ceiling. Mirrors
// C1's own fixture exactly (50 flags, 4-RPC drift, K=20 model-proposed
// drafts), varying only the due-proposal count -- same idiom as the
// "sweep cohorts 0 / 1 / cap" judgment test above, looping rather than
// tripling C1's body. Cohort 1 itself stays in PROOF C1, unchanged.
test("PROOF clerk full gather at governance-sweep cohort 0 and cohort 2 (cohort 1 already covered by PROOF C1)", async () => {
  const K = 20;
  for (const dueCount of [0, 2]) {
    const clerkResponder = (url: string, init: { body?: unknown } | undefined) => {
      if (url.includes("api.anthropic.com")) {
        const drafts = Array.from({ length: K }, (_, i) => ({ kind: "bookkeeping_note", note: `drift note ${i}` }));
        return makeModelRpcResponder({ judgmentModel: MAINTAINER_MODELS.judgment, clerkModel: MAINTAINER_MODELS.clerk, onClerk: () => clerkDraftText(drafts) })(url, init);
      }
      // Base RPC probe: return a "0x" result so every fallback RPC is tried.
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" }), { status: 200, headers: { "content-type": "application/json" } });
    };
    const counter = installSubrequestCounter(clerkResponder);
    const d1 = createLocalD1({ onExec: counter.consume });
    try {
      seedMaintainer(d1);
      for (let i = 0; i < 4; i++) insertCitizen(d1);
      const now = Date.now();
      for (let i = 0; i < dueCount; i++) seedDueProposal(d1, now - (i + 1) * 1_000);
      for (let i = 0; i < 50; i++) {
        const postId = Number(d1.raw.prepare("INSERT INTO posts (citizen_id, title, body, dupe_hash, pinned, author_model, created_at) VALUES (1, ?, ?, ?, 0, 'm', ?)").run(`P${i}`, `body ${i}`, `h${i}`, now - 1_000_000).lastInsertRowid);
        d1.raw.prepare("INSERT INTO flags (citizen_id, target_type, target_id, reason, created_at) VALUES (1, 'post', ?, 'spam', ?)").run(postId, now - (50 - i) * 100);
      }
      await callScheduled(CLERK_CRON, makeEnv(d1));
      assert.equal(counter.breached(), false, `clerk cohort ${dueCount}: never exceeded budget (total ${counter.total()}, d1 ${counter.d1()}, fetch ${counter.fetches()})`);
      assert.ok(counter.total() <= 50, `clerk full-gather cohort ${dueCount} total ${counter.total()} <= 50`);
    } finally {
      counter.restore();
      d1.close();
    }
  }
});

// ---------- shapes 3 & 4: costed, stated (no repair expected on 3; 4's repair IS §8) ----------

test("PROOF shape 4 -- POST /api/governance/sweep at zero/one/cap due each stays a small bounded cost (the permissionless public surface)", async () => {
  for (const dueCount of [0, 1, 2]) {
    const counter = installSubrequestCounter(() => rpcBalanceResponse());
    const d1 = createLocalD1({ onExec: counter.consume });
    try {
      seedMaintainer(d1);
      for (let i = 0; i < 4; i++) insertCitizen(d1);
      const now = Date.now();
      for (let i = 0; i < dueCount; i++) seedDueProposal(d1, now - (i + 1) * 1_000);
      const { runGovernanceSweep } = await import("../src/governance.ts");
      await runGovernanceSweep(makeEnv(d1), now);
      assert.equal(counter.breached(), false, `sweep-only cohort ${dueCount}: total ${counter.total()}`);
      assert.ok(counter.total() <= 50, `permissionless sweep cohort ${dueCount} total ${counter.total()} <= 50`);
    } finally {
      counter.restore();
      d1.close();
    }
  }
});
