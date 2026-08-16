// judgment.ts's D1-touching surface against a real local-D1 harness (see
// test/helpers/local-d1.ts's own header for why node:sqlite over a real
// schema.sql is trusted here). Two things this file exists for:
//
// 1. Wake-start reconciliation (docs/BRIEF-WAKE-RECONCILIATION.md):
//    an approved queue row whose execution artifact never landed --
//    because the process died between the claim and the execution, or
//    because stampQueueRow's own meta.changes dereference throws AFTER
//    its UPDATE already committed (the exact anomaly
//    exchange/REVIEW_hardening2-fixespass_2026-08-10.md CODEX round 3 /
//    CLAUDE round 4 traced) -- is otherwise PERMANENT: every later wake
//    only ever selects status = 'pending'. reconcileApprovedQueue heals
//    this at the start of every wake, before the new pending batch.
// 2. The loud catch (part a of the same brief): the claim/execution
//    catch path in executeJudgmentDecisions must reach the run row's
//    error field rather than swallowing the anomaly into a console log
//    only.
//
// No network: runJudgmentWake's own batch loop calls callAnthropic
// unconditionally once it has a non-empty pending batch, and this repo's
// own convention (test/maintainer-anthropic.test.ts,
// test/maintainer-judgment.test.ts headers) is no network in this suite.
// Every fixture here seeds ZERO pending rows, so runJudgmentWake always
// takes the "nothing pending" branch after reconciliation and never
// reaches callAnthropic -- except test 6, which calls
// executeJudgmentDecisions directly (it takes already-parsed decisions,
// no model call inside it at all) rather than going through
// runJudgmentWake, specifically to exercise the claim catch without a
// pending batch or a model call.
//
// Run: npm test
// Run just this file: node --experimental-strip-types --test "test/maintainer-judgment-d1.test.ts"

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, insertCitizen, insertProposal, type LocalD1 } from "./helpers/local-d1.ts";
import { installSubrequestCounter } from "./helpers/subrequest-counter.ts";
import { estimateSweepCost } from "../src/maintainer/budget.ts";
import {
  runJudgmentWake,
  executeJudgmentDecisions,
  reconcileApprovedQueue,
  encodeFlagReviewDecision,
  scanPendingQueueBatch,
  buildJudgmentPrompt,
  JUDGMENT_SYSTEM_PROMPT,
  JUDGMENT_QUEUE_CAP,
  JUDGMENT_MAX_SCAN,
  JUDGMENT_REPLAY_CAP,
  TOTAL_PROMPT_REQUEST_MAX_BYTES,
} from "../src/maintainer/judgment.ts";
import { moderateContent, flagContent, type Env } from "../src/society.ts";
import type { QueueRow, JudgmentDecision } from "../src/maintainer/judgment.ts";
import { detectConstitutionChange, type ConstitutionCache } from "../src/governance.ts";
import { MAINTAINER_MODELS, buildRequestBody } from "../src/maintainer/anthropic.ts";

// ---------- local fixture helpers (this file's own, per society-votes-d1.test.ts's precedent -- no edits to the shared test/helpers/local-d1.ts) ----------

// I-007's detection is now unconditionally wired into every runJudgmentWake
// call (docs/BRIEF-FIRST-LAWS.md commit 4), and its own per-isolate cache
// (governance.ts) defaults to a PROCESS-wide module singleton -- shared by
// every test() in this file's one process, even though each test uses its
// own, unrelated local-D1 database. Every runJudgmentWake call in this file
// passes a fresh one, so an earlier test's own detection can never make a
// later test's detection silently short-circuit to "already_current"
// against a database it never actually touched.
function freshConstitutionCache(): ConstitutionCache {
  return { pairKey: null, versionRow: null };
}

// F4/F7/F8/F9 fixtures (below) construct their own constitution_versions
// rows with SYNTHETIC template/parameters hashes -- deliberately, so their
// SIZE stays fully test-controlled rather than depending on the real
// buildConstitutionTemplate() output. But a bare freshConstitutionCache()
// makes runJudgmentWake's own I-007 detection (unconditional on every
// wake) compare against the REAL, deploy-fixed live pair, which a
// synthetic fixture hash can never match -- so the wake's OWN internal
// detectConstitutionChange call lands a genuine second "operator" version
// (real content) alongside whatever the fixture already seeded, and
// reconcileConstitutionFidelityQueue then queues an UNRELATED second
// constitution_fidelity row for it, whose own previous-version lookup can
// land on the fixture's deliberately oversized version -- pure
// cross-feature noise this file's own earlier test ("queues its own
// fidelity row...") exercises deliberately, but that these tests must
// suppress to keep precise control over exactly which queue rows exist.
// (Found the hard way: an early run of the F8 lone-item red-proof below
// showed TWO withheld items, not the one it seeded.)
//
// Calling detectConstitutionChange once, directly, before any fixture is
// seeded, lands the REAL genesis row and populates a cache matching the
// real live pair; passing THAT SAME cache into runJudgmentWake later
// means its own internal call is a cache hit ("already_current"), so it
// inserts nothing further. Genesis rows are excluded from
// reconcileConstitutionFidelityQueue by construction (`changed_by !=
// 'genesis'`), so this is harmless even for fixtures that never touch
// constitution_versions at all.
async function establishRealGenesisCache(d1: LocalD1): Promise<ConstitutionCache> {
  const cache: ConstitutionCache = { pairKey: null, versionRow: null };
  const env = { DB: d1.DB } as unknown as Env;
  await detectConstitutionChange(env, Date.now(), cache);
  return cache;
}

function insertMaintainerRunRow(d1: LocalD1, kind: "clerk" | "judgment" = "judgment"): number {
  const res = d1.raw.prepare("INSERT INTO maintainer_runs (kind, started_at) VALUES (?, ?)").run(kind, Date.now());
  return Number(res.lastInsertRowid);
}

function insertPost(
  d1: LocalD1,
  citizenId: number,
  overrides: Partial<{ title: string; body: string; mod_state: string | null; created_at: number }> = {},
): number {
  const res = d1.raw
    .prepare("INSERT INTO posts (citizen_id, title, body, dupe_hash, pinned, author_model, created_at, mod_state) VALUES (?, ?, ?, ?, 0, ?, ?, ?)")
    .run(
      citizenId,
      overrides.title ?? "a flagged post",
      overrides.body ?? "some body text",
      `dupe-${Math.random().toString(36).slice(2)}`,
      "test-model",
      overrides.created_at ?? Date.now(),
      overrides.mod_state ?? null,
    );
  return Number(res.lastInsertRowid);
}

interface QueueRowOverrides {
  kind: string;
  target_type: string | null;
  target_id: number | null;
  note: string;
  status: string;
  decided_at: number | null;
  decided_reason: string | null;
  // F4/F7/F8/F9 additions (docs/BRIEF-FIRST-LAWS-REPAIR.md §8): both
  // additive, optional, default to the exact pre-existing behaviour
  // (source_ref NULL, created_at now-10s) -- no existing caller passes
  // either, so nothing above this changes.
  source_ref: string | null;
  created_at: number;
}

function insertQueueRow(d1: LocalD1, runId: number, overrides: Partial<QueueRowOverrides> = {}): number {
  const now = Date.now();
  const res = d1.raw
    .prepare(
      "INSERT INTO maintainer_queue (run_id, created_at, kind, target_type, target_id, source_ref, note, status, decided_at, decided_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      runId,
      overrides.created_at ?? now - 10_000,
      overrides.kind ?? "flag_review",
      overrides.target_type ?? null,
      overrides.target_id ?? null,
      overrides.source_ref ?? null,
      overrides.note ?? "a note",
      overrides.status ?? "approved",
      overrides.decided_at === undefined ? now - 5_000 : overrides.decided_at,
      overrides.decided_reason ?? null,
    );
  return Number(res.lastInsertRowid);
}

function getQueueRow(d1: LocalD1, id: number): { status: string; decided_reason: string | null } {
  return d1.raw.prepare("SELECT status, decided_reason FROM maintainer_queue WHERE id = ?").get(id) as { status: string; decided_reason: string | null };
}

// ---------- F4/F7/F8/F9 fixture helpers (docs/BRIEF-FIRST-LAWS-REPAIR.md §8) ----------

// A raw constitution_versions row, deliberately NOT built through
// detectConstitutionChange -- these tests need precise control over
// full_text/parameters_text SIZE (to construct near-budget and
// over-budget evidence deterministically), which the real detection path
// does not expose.
function insertConstitutionVersion(
  d1: LocalD1,
  overrides: Partial<{
    full_text: string;
    parameters_text: string;
    first_seen_at: number;
    changed_by: "genesis" | "mandate_linked" | "operator";
    mandate_proposal_ids: number[];
  }> = {},
): number {
  const res = d1.raw
    .prepare(
      "INSERT INTO constitution_versions (template_hash, parameters_hash, full_text, parameters_text, first_seen_at, changed_by, mandate_proposal_ids) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      `hash-${Math.random().toString(36).slice(2)}`,
      `hash-${Math.random().toString(36).slice(2)}`,
      overrides.full_text ?? "a small constitution text",
      overrides.parameters_text ?? '{"classes":[]}',
      overrides.first_seen_at ?? Date.now(),
      overrides.changed_by ?? "operator",
      JSON.stringify(overrides.mandate_proposal_ids ?? []),
    );
  return Number(res.lastInsertRowid);
}

// A complete, VALID constitution_fidelity fixture: a genesis-like
// previous version, a real new version with the given full_text and
// linked mandates, and the maintainer_queue row pointing at it -- exactly
// what reconcileConstitutionFidelityQueue would have produced, but with
// deterministic, test-controlled sizes rather than the real
// buildConstitutionTemplate()/serializeConstitutionParameters() output.
function insertValidFidelityFixture(
  d1: LocalD1,
  runId: number,
  overrides: Partial<{ newFullText: string; mandateProposalIds: number[]; createdAt: number; firstSeenAt: number }> = {},
): { queueId: number; versionId: number } {
  const now = Date.now();
  // The dedicated "previous version" sits exactly 1ms before THIS
  // fixture's own new version -- not an arbitrary large gap -- so that
  // when more than one fixture is seeded in the same test (the F8
  // aggregate-split red-proof seeds two), each fixture's own previous-
  // version lookup ((first_seen_at, id) DESC, the closest STRICTLY OLDER
  // row) resolves to ITS OWN dedicated prior, never to a different
  // fixture's own new version that happens to sit chronologically
  // between them.
  const newFirstSeenAt = overrides.firstSeenAt ?? now;
  insertConstitutionVersion(d1, { changed_by: "genesis", first_seen_at: newFirstSeenAt - 1 });
  const versionId = insertConstitutionVersion(d1, {
    full_text: overrides.newFullText ?? "the new constitution text",
    first_seen_at: newFirstSeenAt,
    changed_by: "operator",
    mandate_proposal_ids: overrides.mandateProposalIds ?? [],
  });
  const queueId = insertQueueRow(d1, runId, {
    kind: "constitution_fidelity",
    source_ref: `constitution_versions:${versionId}`,
    note: `constitution changed to version ${versionId}`,
    status: "pending",
    decided_at: null,
    decided_reason: null,
    created_at: overrides.createdAt ?? now - 10_000,
  });
  return { queueId, versionId };
}

// A constitution_fidelity row that WILL be withheld: its source_ref names
// a constitution_versions id that does not exist. The cheapest, most
// direct way to construct §8.2's "named version row is missing"
// fail-closed condition.
function insertWithheldFidelityRow(d1: LocalD1, runId: number, missingVersionId: number, createdAt: number): number {
  return insertQueueRow(d1, runId, {
    kind: "constitution_fidelity",
    source_ref: `constitution_versions:${missingVersionId}`,
    note: `constitution changed to version ${missingVersionId}`,
    status: "pending",
    decided_at: null,
    decided_reason: null,
    created_at: createdAt,
  });
}

// docs/BRIEF-FIRST-LAWS-REPAIR.md §8.5's own required red-proof technique:
// "SPY on callAnthropic and assert ZERO invocations." That needs the REAL
// callAnthropic (and the real fetch-body-construction code beneath it) in
// the call graph -- not a mock of the thing under test -- with only the
// actual network boundary intercepted. This project's existing "no
// network in this suite" convention (test/maintainer-anthropic.test.ts's
// own header) predates this requirement and exists to avoid live, costly,
// flaky network traffic; a stubbed global fetch serves the identical
// practical goal (zero real network calls, zero cost, zero flakiness)
// while proving what these tests must prove: that a withhold/defer
// decision made by the scanner genuinely prevents callAnthropic's own
// underlying fetch from ever firing, not merely that some counter claims
// it should have. Scoped to this file only; every test using it restores
// the original fetch in a `finally` block.
//
// The stub is intentionally response-shaped, not call-count-only: it
// parses the REAL request body's queue_item id="N" markers and returns a
// syntactically valid judge decision (approve, reason, no action) for
// every id found, so runJudgmentWake's own parseJudgmentDecisions and
// executeJudgmentDecisions run for real against a realistic response,
// for every batch a test drives through more than one model call.
function stubAnthropicFetch(): { callCount: () => number; restore: () => void } {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (_url: unknown, init?: { body?: unknown }) => {
    calls++;
    const bodyText = typeof init?.body === "string" ? init.body : "";
    // The real request body is JSON (buildRequestBody's own shape: the
    // prompt lives at messages[0].content as a STRING VALUE) -- every
    // queue_item's id="N" attribute's own quote characters are therefore
    // JSON-escaped to \" in the raw body bytes. Matching the raw text
    // directly hunts for a literal " that is never there (found during
    // this file's own red-proof run: every call resolved zero ids, so
    // the stub always returned an empty decision array and nothing was
    // ever actually decided) -- parsing first and matching against the
    // real, unescaped prompt string is what buildJudgmentPrompt's own
    // output actually looks like.
    let promptText = "";
    try {
      const parsed = JSON.parse(bodyText) as { messages?: Array<{ content?: string }> };
      promptText = parsed.messages?.[0]?.content ?? "";
    } catch {
      promptText = "";
    }
    const ids = [...promptText.matchAll(/queue_item id="(\d+)"/g)].map((m) => Number(m[1]));
    const decisions = ids.map((queue_id) => ({ queue_id, decision: "approve", reason: "stubbed decision for a red-proof test", action: null }));
    const body = {
      content: [{ type: "text", text: JSON.stringify(decisions) }],
      stop_reason: "end_turn",
      usage: { input_tokens: 100, output_tokens: 50 },
    };
    return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return {
    callCount: () => calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

// The real byte measurement, replicated from judgment.ts's own private
// measureRequestBytes using only already-exported symbols -- lets a test
// compute what SHOULD happen (admit/defer/withhold) from the real
// production code path (buildJudgmentPrompt, buildRequestBody, the real
// system prompt) rather than hand-guessing a byte count against
// implementation details (the system prompt's own length, the JSON
// envelope overhead) that could drift.
function realRequestBytes(rows: QueueRow[]): number {
  const prompt = buildJudgmentPrompt(rows);
  const body = buildRequestBody(MAINTAINER_MODELS.judgment, JUDGMENT_SYSTEM_PROMPT, prompt);
  return new TextEncoder().encode(JSON.stringify(body)).byteLength;
}

function getPost(d1: LocalD1, id: number): { mod_state: string | null } {
  return d1.raw.prepare("SELECT mod_state FROM posts WHERE id = ?").get(id) as { mod_state: string | null };
}

function countPosts(d1: LocalD1): number {
  return (d1.raw.prepare("SELECT COUNT(*) AS c FROM posts").get() as { c: number }).c;
}

function countModerationEvents(d1: LocalD1): number {
  return (d1.raw.prepare("SELECT COUNT(*) AS c FROM identity_events WHERE kind = 'moderation'").get() as { c: number }).c;
}

function latestRun(d1: LocalD1): { error: string | null; items_actioned: number | null; skipped_reason: string | null; overflow_dropped: number } {
  return d1.raw.prepare("SELECT * FROM maintainer_runs ORDER BY id DESC LIMIT 1").get() as {
    error: string | null;
    items_actioned: number | null;
    skipped_reason: string | null;
    overflow_dropped: number;
  };
}

// citizen #1 inserted first in a fresh DB is autoincrement id 1, matching
// the real MAINTAINER_ID -- moderateContent/createPost both hard-require
// citizen.id === MAINTAINER_ID (society.ts), so every test below seeds
// the maintainer FIRST.
function seedMaintainer(d1: LocalD1): { id: number; handle: string; model: string; karma: number; created_at: number; last_seen_at: number } {
  const id = insertCitizen(d1, { handle: "commonhold-agent", model: "claude-fable-5" });
  assert.equal(id, 1, "test setup invariant: the maintainer must be citizen #1 (first insert into a fresh DB)");
  return { id, handle: "commonhold-agent", model: "claude-fable-5", karma: 0, created_at: 0, last_seen_at: 0 };
}

// Strips `meta.changes` from the maintainer_queue UPDATE's run() result --
// same idiom as governance-d1.test.ts's withChainedHeadReadTriggering and
// society-votes-d1.test.ts's withChangesStrippedVotesInsert -- the write
// itself proceeds underneath (real SQLite; a driver that stops REPORTING,
// not a write that stops writing).
// Strips `meta` ENTIRELY from the maintainer_queue UPDATE's run() result --
// deliberately NOT the same shape as society-votes-d1.test.ts's
// withChangesStrippedVotesInsert (which strips only the `changes` KEY,
// reproducing a quiet wrong-answer defect: `undefined === 0` is false,
// no throw). judgment.ts's defect is specifically a THROW: the exchange
// traced `res.meta` itself absent, so `res.meta.changes` at
// stampQueueRow's return line dereferences `undefined.changes` and
// raises a real TypeError -- that is what reaches
// executeJudgmentDecisions's claim catch. The write itself proceeds
// underneath either way (real SQLite; a driver that stops REPORTING).
function withQueueUpdateMetaStripped(DB: LocalD1["DB"]): LocalD1["DB"] {
  return {
    prepare: (sql: string) => {
      const real = DB.prepare(sql);
      if (!/UPDATE\s+maintainer_queue/i.test(sql)) return real;
      return {
        bind: (...args: unknown[]) => {
          const bound = real.bind(...args);
          return {
            run: async () => {
              await bound.run(); // the real write commits; only the reported result is corrupted below
              return { meta: undefined } as unknown as { meta: { changes: number; last_row_id: number } };
            },
          };
        },
      } as unknown as ReturnType<LocalD1["DB"]["prepare"]>;
    },
    batch: (stmts) => DB.batch(stmts),
  };
}

// ---------- 1. RED-PROOF OF THE DEFECT ----------

test("wake-start reconciliation: an approved flag_review with no artifact is driven to completion by the next wake", async () => {
  const d1 = createLocalD1();
  try {
    seedMaintainer(d1);
    const authorId = insertCitizen(d1, { handle: "author" });
    const postId = insertPost(d1, authorId, { mod_state: null });
    const runId = insertMaintainerRunRow(d1);
    insertQueueRow(d1, runId, {
      kind: "flag_review",
      target_type: "post",
      target_id: postId,
      note: "flagged as spam",
      status: "approved",
      decided_reason: encodeFlagReviewDecision("remove", "confirmed spam"),
    });

    const env = { DB: d1.DB, ANTHROPIC_API_KEY: "test-key-unused" } as unknown as Env;
    await runJudgmentWake(env, freshConstitutionCache());

    const post = getPost(d1, postId);
    const run = latestRun(d1);
    assert.equal(post.mod_state, "removed", "the recorded decision (remove) must be driven to completion");
    assert.equal(countModerationEvents(d1), 1, "exactly one moderation artifact lands in identity_events");
    assert.equal(run.items_actioned, 1, "the reconciled execution counts in the run row's items_actioned");
    assert.equal(run.error, null, "a healthy reconciliation leaves no error");
  } finally {
    d1.close();
  }
});

// ---------- 6. LOUD CATCH ----------

test("loud catch: a claim UPDATE that commits but reports no meta reaches executeJudgmentDecisions's own returned error (part a)", async () => {
  const d1 = createLocalD1();
  try {
    const maintainer = seedMaintainer(d1);
    const authorId = insertCitizen(d1, { handle: "author" });
    const postId = insertPost(d1, authorId, { mod_state: null });
    const runId = insertMaintainerRunRow(d1);
    const queueId = insertQueueRow(d1, runId, {
      kind: "flag_review",
      target_type: "post",
      target_id: postId,
      note: "flagged as spam",
      status: "pending",
      decided_at: null,
      decided_reason: null,
    });

    const queueRow: QueueRow = {
      id: queueId,
      kind: "flag_review",
      target_type: "post",
      target_id: postId,
      source_ref: null,
      note: "flagged as spam",
      target_content: null,
      target_mod_state: null,
    };
    const batchMap = new Map<number, QueueRow>([[queueId, queueRow]]);
    const decisions: JudgmentDecision[] = [{ queue_id: queueId, decision: "approve", reason: "confirmed spam", action: "remove" }];

    const env = { DB: withQueueUpdateMetaStripped(d1.DB) } as unknown as Env;
    const result = await executeJudgmentDecisions(env, maintainer, batchMap, decisions);

    // The claim UPDATE committed for real (verified directly against the
    // unwrapped DB) even though the code could not tell -- the exact
    // anomaly the exchange traced.
    const row = getQueueRow(d1, queueId);
    assert.equal(row.status, "approved", "the claim UPDATE commits despite the corrupted meta result");
    assert.equal(getPost(d1, postId).mod_state, null, "execution is correctly skipped -- claimed reads as unknown, control flow is unchanged (part a: loudness, not control flow)");
    assert.equal(result.actioned, 0, "nothing is counted for a claim executeJudgmentDecisions could not confirm");
    assert.notEqual(result.error, null, "the anomaly must reach executeJudgmentDecisions's own returned error, not only a console log");
    assert.match(result.error ?? "", new RegExp(String(queueId)), "the error names the queue row it happened on");
  } finally {
    d1.close();
  }
});

// ---------- 2. BULLETIN RECONCILIATION ----------

test("bulletin reconciliation: an approved draft with no post gets one created via the same deny-check the primary path uses", async () => {
  const d1 = createLocalD1();
  try {
    const maintainer = seedMaintainer(d1);
    const runId = insertMaintainerRunRow(d1);
    insertQueueRow(d1, runId, {
      kind: "bulletin_draft",
      note: "Weekly digest\nAll quiet this week.",
      status: "approved",
      decided_reason: "looked fine to the judge",
    });

    const env = { DB: d1.DB } as unknown as Env;
    const result = await reconcileApprovedQueue(env, maintainer);

    assert.equal(result.actioned, 1);
    assert.equal(result.error, null);
    assert.equal(countPosts(d1), 1);
    const post = d1.raw.prepare("SELECT title, body, pinned, citizen_id FROM posts LIMIT 1").get() as { title: string; body: string; pinned: number; citizen_id: number };
    assert.equal(post.title, "Weekly digest");
    assert.equal(post.body, "All quiet this week.");
    assert.equal(post.pinned, 1, "a bulletin is auto-pinned, same as the primary path");
    assert.equal(post.citizen_id, maintainer.id);
  } finally {
    d1.close();
  }
});

test("§6 replay cap: reconcileApprovedQueue replays at most JUDGMENT_REPLAY_CAP stranded rows per wake, newest-decided first; the rest wait for the next wake (docs/BRIEF-JUDGMENT-QUERY-BUDGET.md §6)", async () => {
  const d1 = createLocalD1();
  try {
    const maintainer = seedMaintainer(d1);
    const runId = insertMaintainerRunRow(d1);
    const now = Date.now();
    // JUDGMENT_REPLAY_CAP + 2 stranded approved bulletin drafts, each with a
    // distinct title/body (so no dupe_hash collision) and a distinct
    // decided_at. i=0 is the newest decision, i=cap+1 the oldest.
    const total = JUDGMENT_REPLAY_CAP + 2;
    const ids: number[] = [];
    for (let i = 0; i < total; i++) {
      ids.push(
        insertQueueRow(d1, runId, {
          kind: "bulletin_draft",
          note: `Digest ${i}\nBody number ${i}, all quiet.`,
          status: "approved",
          decided_at: now - i * 1_000,
          decided_reason: "looked fine to the judge",
        }),
      );
    }

    const env = { DB: d1.DB } as unknown as Env;
    const result = await reconcileApprovedQueue(env, maintainer);

    assert.equal(result.actioned, JUDGMENT_REPLAY_CAP, "exactly JUDGMENT_REPLAY_CAP rows replay this wake -- the cohort is bounded so a backlog cannot exhaust the invocation before the pending batch");
    assert.equal(countPosts(d1), JUDGMENT_REPLAY_CAP, "exactly that many bulletins posted, not the whole backlog");
    // A successful bulletin replay does not re-stamp the row (idempotency
    // comes from bulletinArtifactExists finding the post next time), so every
    // row is still 'approved'. The meaningful distinction is which rows got a
    // POST: the newest JUDGMENT_REPLAY_CAP were replayed (newest-decided first
    // is load-bearing against gate reproduction G1), the oldest two were never
    // fetched and so wait for the next wake.
    for (let i = 0; i < total; i++) {
      const posted = (d1.raw.prepare("SELECT COUNT(*) AS n FROM posts WHERE title = ?").get(`Digest ${i}`) as { n: number }).n;
      if (i < JUDGMENT_REPLAY_CAP) {
        assert.equal(posted, 1, `the newest-decided row (rank ${i}) was replayed -- its bulletin exists`);
      } else {
        assert.equal(posted, 0, `the oldest-decided row (rank ${i}) was never fetched -- no bulletin, it waits for the next wake`);
      }
      assert.equal(getQueueRow(d1, ids[i]).status, "approved", `row ${ids[i]} stays approved (a replay does not re-stamp; deferral is safe)`);
    }
  } finally {
    d1.close();
  }
});

test("bulletin reconciliation: a deny-tripping draft flips to rejected with the deny reason, never posts (H2 re-run on the reconciliation path)", async () => {
  const d1 = createLocalD1();
  try {
    const maintainer = seedMaintainer(d1);
    const runId = insertMaintainerRunRow(d1);
    const queueId = insertQueueRow(d1, runId, {
      kind: "bulletin_draft",
      note: "Claim your reward\nSign here to continue",
      status: "approved",
      decided_reason: "looked fine to the judge (the judge was wrong -- exactly what H2 exists for)",
    });

    const env = { DB: d1.DB } as unknown as Env;
    const result = await reconcileApprovedQueue(env, maintainer);

    assert.equal(result.actioned, 1, "the reject-flip itself is the completed job, same counting convention as the primary path");
    assert.equal(result.error, null);
    assert.equal(countPosts(d1), 0, "never posts once the deny-check hits, on the reconciliation path exactly as on the primary path");
    const row = getQueueRow(d1, queueId);
    assert.equal(row.status, "rejected");
    assert.match(row.decided_reason ?? "", /^deny-check: /);
  } finally {
    d1.close();
  }
});

// ---------- 3. IDEMPOTENCY ----------

test("idempotency: running reconciliation twice on the same rows actions nothing the second time, no duplicate artifacts", async () => {
  const d1 = createLocalD1();
  try {
    const maintainer = seedMaintainer(d1);
    const authorId = insertCitizen(d1, { handle: "author" });
    const postId = insertPost(d1, authorId, { mod_state: null });
    const runId = insertMaintainerRunRow(d1);
    insertQueueRow(d1, runId, {
      kind: "flag_review",
      target_type: "post",
      target_id: postId,
      note: "flagged as spam",
      status: "approved",
      decided_reason: encodeFlagReviewDecision("collapse", "borderline, collapse pending review"),
    });
    insertQueueRow(d1, runId, {
      kind: "bulletin_draft",
      note: "Weekly digest\nAll quiet this week.",
      status: "approved",
      decided_reason: "looked fine",
    });

    const env = { DB: d1.DB } as unknown as Env;

    const first = await reconcileApprovedQueue(env, maintainer);
    assert.equal(first.actioned, 2, "both rows execute on the first pass");
    // countPosts is 2: the pre-existing flagged post fixture PLUS the one
    // new bulletin post reconciliation just created -- moderating a post
    // does not create a new row, only createPost does. countModerationEvents
    // is also 2, not 1: createPost's OWN logModeration call for a bulletin
    // writes its own kind='moderation' row too ("bulletin post <id>
    // (cap-exempt, auto-pinned)") -- a real second source of that kind,
    // found via this exact assertion catching flagReviewArtifactExists's
    // first, too-loose marker (fixed to require the collapsed/removed/
    // restored verb prefix, see that function's own comment).
    assert.equal(countPosts(d1), 2);
    assert.equal(countModerationEvents(d1), 2);

    const second = await reconcileApprovedQueue(env, maintainer);
    assert.equal(second.actioned, 0, "both artifacts already exist -- nothing double-executes");
    assert.equal(second.error, null);
    assert.equal(countPosts(d1), 2, "still exactly two posts (flagged + bulletin), not three");
    assert.equal(countModerationEvents(d1), 2, "still exactly two moderation-kind events, not four");
    assert.equal(getPost(d1, postId).mod_state, "collapsed");
  } finally {
    d1.close();
  }
});

// ---------- 4. OUT-OF-SCOPE KINDS ----------

test("out-of-scope kinds: approved bookkeeping_note/registration_check rows are never selected or touched by reconciliation", async () => {
  const d1 = createLocalD1();
  try {
    const maintainer = seedMaintainer(d1);
    const authorId = insertCitizen(d1, { handle: "author" });
    const flaggedCitizenId = insertCitizen(d1, { handle: "similar-name" });
    const postId = insertPost(d1, authorId, { mod_state: null });
    const runId = insertMaintainerRunRow(d1);

    insertQueueRow(d1, runId, {
      kind: "flag_review",
      target_type: "post",
      target_id: postId,
      note: "flagged as spam",
      status: "approved",
      decided_reason: encodeFlagReviewDecision("remove", "confirmed spam"),
    });
    insertQueueRow(d1, runId, {
      kind: "bulletin_draft",
      note: "Weekly digest\nAll quiet this week.",
      status: "approved",
      decided_reason: "looked fine",
    });
    const bookkeepingId = insertQueueRow(d1, runId, {
      kind: "bookkeeping_note",
      note: "a small drift observed",
      status: "approved",
      decided_reason: "noted, dust from a routine deposit",
    });
    const registrationId = insertQueueRow(d1, runId, {
      kind: "registration_check",
      target_type: "citizen",
      target_id: flaggedCitizenId,
      note: "a similarly-named citizen registered",
      status: "approved",
      decided_reason: "confirmed benign, just a similar name",
    });

    const beforeBookkeeping = getQueueRow(d1, bookkeepingId);
    const beforeRegistration = getQueueRow(d1, registrationId);

    const env = { DB: d1.DB } as unknown as Env;
    const result = await reconcileApprovedQueue(env, maintainer);

    assert.equal(result.actioned, 2, "only the flag_review and bulletin_draft rows are actioned");
    assert.equal(result.error, null);

    const afterBookkeeping = getQueueRow(d1, bookkeepingId);
    const afterRegistration = getQueueRow(d1, registrationId);
    assert.deepEqual(afterBookkeeping, beforeBookkeeping, "bookkeeping_note is completely untouched, not merely not-actioned");
    assert.deepEqual(afterRegistration, beforeRegistration, "registration_check is completely untouched, not merely not-actioned");
  } finally {
    d1.close();
  }
});

// ---------- 5. POISONED ROW ----------

test("poisoned row: a flag_review targeting a vanished post errors loudly but does not stop a sibling bulletin row, and does not throw", async () => {
  const d1 = createLocalD1();
  try {
    const maintainer = seedMaintainer(d1);
    const runId = insertMaintainerRunRow(d1);
    const poisonedId = insertQueueRow(d1, runId, {
      kind: "flag_review",
      target_type: "post",
      target_id: 999_999, // no such post
      note: "flagged as spam",
      status: "approved",
      decided_reason: encodeFlagReviewDecision("remove", "confirmed spam"),
    });
    insertQueueRow(d1, runId, {
      kind: "bulletin_draft",
      note: "Weekly digest\nAll quiet this week.",
      status: "approved",
      decided_reason: "looked fine",
    });

    const env = { DB: d1.DB } as unknown as Env;
    const result = await reconcileApprovedQueue(env, maintainer);

    assert.equal(result.actioned, 1, "the sibling bulletin row still executes despite the poisoned flag_review");
    assert.notEqual(result.error, null, "the poisoned row's failure is loud, not silently swallowed");
    assert.match(result.error ?? "", new RegExp(String(poisonedId)), "the error names the poisoned row");
    assert.equal(countPosts(d1), 1, "the sibling's artifact exists -- one poisoned row never starves the office");
    assert.equal(getQueueRow(d1, poisonedId).status, "approved", "the poisoned row is left alone, not guessed at, for the next wake");
  } finally {
    d1.close();
  }
});

test("poisoned row: a reconciliation error does not prevent runJudgmentWake from reaching and reporting the pending-queue state", async () => {
  const d1 = createLocalD1();
  try {
    seedMaintainer(d1);
    const runId = insertMaintainerRunRow(d1);
    const poisonedId = insertQueueRow(d1, runId, {
      kind: "flag_review",
      target_type: "post",
      target_id: 999_999, // no such post
      note: "flagged as spam",
      status: "approved",
      decided_reason: encodeFlagReviewDecision("remove", "confirmed spam"),
    });
    // No pending rows seeded: proves the wake reaches the "nothing
    // pending" branch (not an early return before it) even though
    // reconciliation errored -- the ONLY way to prove continuation past
    // reconciliation without a real pending batch (this repo's own
    // convention is no network in tests; see the file header).

    const env = { DB: d1.DB, ANTHROPIC_API_KEY: "test-key-unused" } as unknown as Env;
    await runJudgmentWake(env, freshConstitutionCache());

    const run = latestRun(d1);
    assert.equal(run.skipped_reason, "nothing pending", "the wake reached and correctly reported the pending-queue state, not an early bail-out");
    assert.notEqual(run.error, null, "the reconciliation failure still reaches the run row");
    assert.match(run.error ?? "", new RegExp(String(poisonedId)), "the error names the poisoned row");
  } finally {
    d1.close();
  }
});

// ---------- FIXES PASS (exchange/REVIEW_wake-reconciliation_2026-08-11.md
// CLAUDE round 2, amending the round-1 ratification): the external
// pre-gate review reproduced three blockers against 9214511 -- these
// tests are each blocker's own red-proof, permanent regression tests
// from here on. ----------

// ---------- 1.1 FALSE-SKIP / SUPERSEDED ----------

test("superseded: a later, different decision on the same target is never silently masked, and the stale approval is never blindly replayed (Codex round 1, later-restore-masks-stranded-remove, verbatim reproduction)", async () => {
  const d1 = createLocalD1();
  try {
    const maintainer = seedMaintainer(d1);
    const authorId = insertCitizen(d1, { handle: "author" });
    const postId = insertPost(d1, authorId, { mod_state: null });
    const runId = insertMaintainerRunRow(d1);
    const queueId = insertQueueRow(d1, runId, {
      kind: "flag_review",
      target_type: "post",
      target_id: postId,
      note: "flagged as spam",
      status: "approved",
      decided_reason: encodeFlagReviewDecision("remove", "confirmed spam"),
    });

    const env = { DB: d1.DB } as unknown as Env;
    // A LATER, legitimate, unrelated decision restores the same post --
    // executed for real through the same executor the primary path uses,
    // producing a genuine identity_events artifact after decided_at.
    await moderateContent(env, maintainer, "post", postId, "restore", "restored after appeal, the flag was mistaken");

    const result = await reconcileApprovedQueue(env, maintainer);

    assert.equal(getPost(d1, postId).mod_state, null, "the stranded remove never executes -- the later restore is not silently overwritten");
    assert.equal(result.actioned, 1, "the supersede re-stamp is itself the completed job, same counting convention as an executed action");
    assert.equal(result.error, null, "supersession is a named, counted exit, not an error");
    const row = getQueueRow(d1, queueId);
    assert.equal(row.status, "rejected", "re-stamped rejected -- the only terminal status the CHECK constraint offers without a migration");
    assert.equal(row.decided_reason, "superseded: a later restore decision executed after this approval was stranded");

    // "the superseded row must never be re-selected in later wakes" --
    // prove it, not just assert the immediate state.
    const second = await reconcileApprovedQueue(env, maintainer);
    assert.equal(second.actioned, 0, "a 'rejected' row is excluded by fetchReconcilableApprovedRows's own status='approved' filter -- never reprocessed");
    assert.equal(countModerationEvents(d1), 1, "still exactly the one restore event -- no duplicate action, no phantom remove");
    assert.equal(getQueueRow(d1, queueId).status, "rejected", "status is stable across a second pass, not reverted or reprocessed");
  } finally {
    d1.close();
  }
});

test("an exact-action artifact anywhere in the window wins over an earlier different-action event -- idempotent skip, not a supersede", async () => {
  const d1 = createLocalD1();
  try {
    const maintainer = seedMaintainer(d1);
    const authorId = insertCitizen(d1, { handle: "author" });
    const postId = insertPost(d1, authorId, { mod_state: null });
    const runId = insertMaintainerRunRow(d1);
    const queueId = insertQueueRow(d1, runId, {
      kind: "flag_review",
      target_type: "post",
      target_id: postId,
      note: "flagged as spam",
      status: "approved",
      decided_reason: encodeFlagReviewDecision("remove", "confirmed spam"),
    });

    const env = { DB: d1.DB } as unknown as Env;
    // A different action lands first (an interim collapse)...
    await moderateContent(env, maintainer, "post", postId, "collapse", "interim collapse pending review");
    // ...then the SAME exact action this row decided also lands for real,
    // through a route this test does not need to name.
    await moderateContent(env, maintainer, "post", postId, "remove", "confirmed after review");

    const result = await reconcileApprovedQueue(env, maintainer);

    assert.equal(result.actioned, 0, "the exact artifact already exists -- idempotent skip, not a re-execution and not a supersede");
    assert.equal(getQueueRow(d1, queueId).status, "approved", "an idempotent skip leaves the row exactly as it was, unlike a supersede");
  } finally {
    d1.close();
  }
});

// ---------- 1.2 FALSE-DECODE ----------

test("false-decode: a pre-encoding free-text decided_reason that mimics the action-prefix shape is never executed (Codex round 1 Ask 1.2, verbatim reproduction)", async () => {
  const d1 = createLocalD1();
  try {
    const maintainer = seedMaintainer(d1);
    const authorId = insertCitizen(d1, { handle: "author" });
    const postId = insertPost(d1, authorId, { mod_state: null });
    const runId = insertMaintainerRunRow(d1);
    const queueId = insertQueueRow(d1, runId, {
      kind: "flag_review",
      target_type: "post",
      target_id: postId,
      note: "flagged as spam",
      status: "approved",
      // Codex's exact probe text: ordinary prose written before action
      // encoding existed, which happens to begin with a real action word.
      decided_reason: "collapse: prose written before action encoding existed",
    });

    const env = { DB: d1.DB } as unknown as Env;
    const result = await reconcileApprovedQueue(env, maintainer);

    assert.equal(getPost(d1, postId).mod_state, null, "no action a judge never machine-recorded via mq1 is ever executed");
    assert.equal(countModerationEvents(d1), 0, "no artifact is fabricated from prose alone");
    // D-018 gate, F-3 ruling (a), artifact ABSENT: no real moderation
    // exists anywhere for this target, so this is genuinely unrecoverable,
    // not merely undecodable -- reported ONCE (this pass) and re-stamped
    // so the report does not repeat every wake forever (gate reproduction
    // F1, "completed-pre-deploy-row-errors-every-wake"). Re-stamping IS
    // now the completed job for this pass, same counting convention as a
    // supersede.
    assert.equal(result.actioned, 1, "the retirement re-stamp is the completed job");
    assert.notEqual(result.error, null, "reported once, loud, not silently guessed at");
    assert.match(result.error ?? "", new RegExp(String(queueId)), "the error names the row it happened on");
    const row = getQueueRow(d1, queueId);
    assert.equal(row.status, "rejected", "re-stamped so this exit becomes real instead of a standing weekly repetition");
    assert.equal(row.decided_reason, "unrecoverable: no machine-readable action; left for the operator");

    // F-1/F-2 door probes named "three passes must yield the error/report
    // at most once, then silence" -- prove it, not just the first pass.
    const second = await reconcileApprovedQueue(env, maintainer);
    assert.equal(second.actioned, 0, "already rejected -- excluded from selection now, nothing left to retire");
    assert.equal(second.error, null, "the report does not repeat on the second pass");
    const third = await reconcileApprovedQueue(env, maintainer);
    assert.equal(third.actioned, 0);
    assert.equal(third.error, null, "still silent on the third pass");
  } finally {
    d1.close();
  }
});

test("false-decode: the dead bare '<action>: <reason>' shape (this file's own predecessor commit, never deployed) is likewise never executed", async () => {
  const d1 = createLocalD1();
  try {
    const maintainer = seedMaintainer(d1);
    const authorId = insertCitizen(d1, { handle: "author" });
    const postId = insertPost(d1, authorId, { mod_state: null });
    const runId = insertMaintainerRunRow(d1);
    const queueId = insertQueueRow(d1, runId, {
      kind: "flag_review",
      target_type: "post",
      target_id: postId,
      note: "flagged as spam",
      status: "approved",
      decided_reason: "remove: confirmed spam", // the OLD bare encoding, 9214511 -- dead, no legacy support
    });

    const env = { DB: d1.DB } as unknown as Env;
    const result = await reconcileApprovedQueue(env, maintainer);

    assert.equal(getPost(d1, postId).mod_state, null, "the dead bare-prefix shape decodes to null -- nothing executes");
    assert.notEqual(result.error, null, "left loud for manual review, same as any other undecodable row");
    // D-018 gate, F-3 ruling (a), artifact ABSENT (no artifact exists for
    // this target either): re-stamped rejected, same as the mimicking-prose
    // case above, so this stops being re-reported every wake too.
    assert.equal(result.actioned, 1);
    const row = getQueueRow(d1, queueId);
    assert.equal(row.status, "rejected");
    assert.equal(row.decided_reason, "unrecoverable: no machine-readable action; left for the operator");
  } finally {
    d1.close();
  }
});

// ---------- NO-KEY BYPASS ----------

test("no-key wake still runs reconciliation: a dry ANTHROPIC_API_KEY must not skip healing a stranded approved row (Codex round 1, no-key-bypasses-reconciliation, verbatim reproduction)", async () => {
  const d1 = createLocalD1();
  try {
    seedMaintainer(d1);
    const authorId = insertCitizen(d1, { handle: "author" });
    const postId = insertPost(d1, authorId, { mod_state: null });
    const runId = insertMaintainerRunRow(d1);
    insertQueueRow(d1, runId, {
      kind: "flag_review",
      target_type: "post",
      target_id: postId,
      note: "flagged as spam",
      status: "approved",
      decided_reason: encodeFlagReviewDecision("remove", "confirmed spam"),
    });

    const env = { DB: d1.DB } as unknown as Env; // ANTHROPIC_API_KEY intentionally absent
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    await runJudgmentWake(env, freshConstitutionCache());

    const post = getPost(d1, postId);
    const run = latestRun(d1);
    assert.equal(post.mod_state, "removed", "reconciliation heals the stranded row even with no API key -- replay needs no model call");
    assert.equal(countModerationEvents(d1), 1);
    assert.equal(run.skipped_reason, "no api key", "the skip reason still names the model half honestly");
    assert.equal(run.items_actioned, 1, "the no-key run row carries reconciliation's results exactly as a keyed wake's does");
    assert.equal(run.error, null);
  } finally {
    d1.close();
  }
});

test("no-key wake still surfaces a reconciliation error: a poisoned row is loud even with no API key, matching a keyed wake exactly", async () => {
  const d1 = createLocalD1();
  try {
    seedMaintainer(d1);
    const runId = insertMaintainerRunRow(d1);
    const poisonedId = insertQueueRow(d1, runId, {
      kind: "flag_review",
      target_type: "post",
      target_id: 999_999, // no such post
      note: "flagged as spam",
      status: "approved",
      decided_reason: encodeFlagReviewDecision("remove", "confirmed spam"),
    });

    const env = { DB: d1.DB } as unknown as Env; // no ANTHROPIC_API_KEY
    await runJudgmentWake(env, freshConstitutionCache());

    const run = latestRun(d1);
    assert.equal(run.skipped_reason, "no api key");
    assert.notEqual(run.error, null, "a reconciliation error reaches the run row even when the model half never runs");
    assert.match(run.error ?? "", new RegExp(String(poisonedId)), "the error names the poisoned row");
  } finally {
    d1.close();
  }
});

// ---------- I-007: constitution detection + wake-side fidelity reconciliation
// wired into runJudgmentWake, bound to the wake's OWN run_id
// (docs/BRIEF-FIRST-LAWS.md commit 4; commission notes flag 5) ----------

test("runJudgmentWake: genesis constitution detection runs even with no API key and nothing pending, and the run row it lands under is the SAME row skipped_reason/error are written to", async () => {
  const d1 = createLocalD1();
  try {
    seedMaintainer(d1);
    const env = { DB: d1.DB } as unknown as Env; // no ANTHROPIC_API_KEY, nothing pending
    await runJudgmentWake(env, freshConstitutionCache());

    const versions = d1.raw.prepare("SELECT changed_by FROM constitution_versions").all() as Array<{ changed_by: string }>;
    assert.equal(versions.length, 1, "the wake's own detection call lands genesis");
    assert.equal(versions[0].changed_by, "genesis");

    const run = latestRun(d1);
    assert.equal(run.skipped_reason, "no api key");
    assert.equal(run.error, null, "a clean genesis detection must not manufacture an error on an otherwise healthy skip");

    const fidelityRows = d1.raw.prepare("SELECT COUNT(*) AS n FROM maintainer_queue WHERE kind = 'constitution_fidelity'").get() as { n: number };
    assert.equal(fidelityRows.n, 0, "genesis is excluded from fidelity reconciliation");
  } finally {
    d1.close();
  }
});

test("runJudgmentWake: a non-genesis constitution change queues its own fidelity row bound to THIS wake's real run_id, alongside an ordinary reconciliation", async () => {
  const d1 = createLocalD1();
  try {
    seedMaintainer(d1);
    // A fake prior version makes the archive non-empty, so this wake's
    // own detection takes the non-genesis path and lands a real,
    // fidelity-eligible version.
    d1.raw
      .prepare(
        "INSERT INTO constitution_versions (template_hash, parameters_hash, full_text, parameters_text, first_seen_at, changed_by, mandate_proposal_ids) VALUES (?, ?, ?, ?, ?, 'genesis', '[]')",
      )
      .run("fake-prior-hash-1", "fake-prior-hash-2", "fake", "fake", Date.now());

    const authorId = insertCitizen(d1, { handle: "author" });
    const postId = insertPost(d1, authorId, { mod_state: null });
    const priorRunId = insertMaintainerRunRow(d1);
    insertQueueRow(d1, priorRunId, {
      kind: "flag_review",
      target_type: "post",
      target_id: postId,
      note: "flagged as spam",
      status: "approved",
      decided_reason: encodeFlagReviewDecision("remove", "confirmed spam"),
    });

    const env = { DB: d1.DB } as unknown as Env; // no ANTHROPIC_API_KEY -- isolates this test to the DB-only paths
    await runJudgmentWake(env, freshConstitutionCache());

    const thisRun = d1.raw.prepare("SELECT id FROM maintainer_runs WHERE kind = 'judgment' ORDER BY id DESC LIMIT 1").get() as { id: number };
    assert.notEqual(thisRun.id, priorRunId, "sanity: the wake's own reserved row is a NEW row, not the pre-seeded fixture one");

    const versions = d1.raw.prepare("SELECT id, changed_by FROM constitution_versions WHERE changed_by != 'genesis'").all() as Array<{
      id: number;
      changed_by: string;
    }>;
    assert.equal(versions.length, 1, "the wake's own detection lands exactly one real (non-genesis) version");
    assert.equal(versions[0].changed_by, "operator");

    const fidelityRow = d1.raw.prepare("SELECT run_id, source_ref, status FROM maintainer_queue WHERE kind = 'constitution_fidelity'").get() as {
      run_id: number;
      source_ref: string;
      status: string;
    };
    assert.ok(fidelityRow, "the non-genesis version must get a fidelity row");
    assert.equal(fidelityRow.run_id, thisRun.id, "bound to THIS wake's own run_id, not the pre-seeded fixture run");
    assert.equal(fidelityRow.source_ref, `constitution_versions:${versions[0].id}`);
    assert.equal(fidelityRow.status, "pending");

    // The ordinary reconciliation (the pre-existing feature) still ran
    // too -- the two mechanisms coexist in the same wake without
    // interfering with each other.
    const post = getPost(d1, postId);
    assert.equal(post.mod_state, "removed");
  } finally {
    d1.close();
  }
});

// ---------- D-018 GATE FIXES PASS (docs/REVIEW-WAKE-RECONCILIATION-GATE-2026-08-11.md):
// a fresh Opus adversarial gate on `9214511` + `c35dfbd`, found NOT
// DEPLOYABLE (two HIGH findings, F-1/F-2, plus F-3/F-7 among the
// strongly-recommended items). Each finding's own red-proof, permanent
// regression tests from here on. ----------

// ---------- F-1 / F-5: the artifact marker is anchored to the START of
// detail, not merely word-bounded before the verb (judgment.ts's
// moderationArtifactsForTarget). The gate's own fix table: every real
// moderateContent shape still matches; flagContent's auto-collapse
// ("auto-collapsed post N: ...") and a reason quoting another target's id
// no longer do; "post 42" vs "post 429" still doesn't. ----------

test("F-1: a real community-flag auto-collapse never masks a stranded approved remove (real flagContent path, five distinct citizens, gate D1 reproduction)", async () => {
  const d1 = createLocalD1();
  try {
    const maintainer = seedMaintainer(d1);
    const authorId = insertCitizen(d1, { handle: "author" });
    const postId = insertPost(d1, authorId, { mod_state: null });
    const runId = insertMaintainerRunRow(d1);
    const queueId = insertQueueRow(d1, runId, {
      kind: "flag_review",
      target_type: "post",
      target_id: postId,
      note: "flagged as spam",
      status: "approved",
      decided_reason: encodeFlagReviewDecision("remove", "confirmed spam"),
      decided_at: Date.now() - 10_000,
    });

    const env = { DB: d1.DB } as unknown as Env;
    // Five DISTINCT citizens flag the same post through the REAL public
    // flagContent path -- society.ts's own FLAG_COLLAPSE_THRESHOLD (5)
    // fires the auto-collapse for real, writing its own genuine
    // identity_events row ("auto-collapsed post <id>: reached 5 community
    // flags"), not a planted string -- driving the exact path the gate's
    // own D1 probe used rather than trusting a fixture.
    for (let i = 0; i < 5; i++) {
      const flaggerId = insertCitizen(d1, { handle: `flagger-${i}` });
      await flagContent(env, { id: flaggerId, handle: `flagger-${i}`, model: "test-model", karma: 0, created_at: 0, last_seen_at: 0 }, "post", postId, "spam");
    }
    assert.equal(getPost(d1, postId).mod_state, "collapsed", "test setup invariant: the real auto-collapse fired");

    const result = await reconcileApprovedQueue(env, maintainer);

    assert.equal(getPost(d1, postId).mod_state, "removed", "the judge's approved remove executes -- an auto-collapse must never read as a superseding decision");
    assert.equal(result.actioned, 1, "the replay is the completed job");
    assert.equal(result.error, null, "no supersede, no error -- the auto-collapse is simply not this row's own artifact");
    assert.equal(getQueueRow(d1, queueId).status, "approved", "a successful replay leaves the row exactly as before, same as any other 'none' outcome");
  } finally {
    d1.close();
  }
});

test("F-5: a moderation reason that quotes another target's id inside its own text never forges that target's artifact (gate D3, verbatim reproduction)", async () => {
  const d1 = createLocalD1();
  try {
    const maintainer = seedMaintainer(d1);
    const authorId = insertCitizen(d1, { handle: "author" });
    const strandedPostId = insertPost(d1, authorId, { mod_state: null }); // "post 1" in the gate's own numbering
    const otherPostId = insertPost(d1, authorId, { mod_state: null }); // "post 2"
    const runId = insertMaintainerRunRow(d1);
    const queueId = insertQueueRow(d1, runId, {
      kind: "flag_review",
      target_type: "post",
      target_id: strandedPostId,
      note: "flagged as spam",
      status: "approved",
      decided_reason: encodeFlagReviewDecision("remove", "confirmed spam"),
      decided_at: Date.now() - 10_000,
    });

    const env = { DB: d1.DB } as unknown as Env;
    // A real, unrelated moderation on a DIFFERENT post, whose own reason
    // text happens to name the stranded post's id right after the word
    // "removed" -- the gate's own D3 reproduction, verbatim shape.
    await moderateContent(env, maintainer, "post", otherPostId, "remove", `duplicate of removed post ${strandedPostId} spam`);
    assert.equal(countModerationEvents(d1), 1, "test setup invariant: exactly the one real moderation exists so far");

    const result = await reconcileApprovedQueue(env, maintainer);

    assert.equal(getPost(d1, strandedPostId).mod_state, "removed", "the stranded approval must still execute -- a reason-embedded id on a DIFFERENT target is not this target's own artifact");
    assert.equal(countModerationEvents(d1), 2, "a real, new moderation event lands for the stranded post -- the old bug silently skipped this and left the count at 1");
    assert.equal(result.actioned, 1, "the replay is counted");
    assert.equal(result.error, null);
    assert.equal(getQueueRow(d1, queueId).status, "approved", "a successful replay leaves the row exactly as before");
  } finally {
    d1.close();
  }
});

test("boundary control: a target id that is a numeric prefix of another target's id is never confused with it (non-regression check for the F-1/F-5 anchoring fix)", async () => {
  const d1 = createLocalD1();
  try {
    const maintainer = seedMaintainer(d1);
    const authorId = insertCitizen(d1, { handle: "author" });
    const strandedPostId = insertPost(d1, authorId, { mod_state: null });
    assert.equal(strandedPostId, 1, "test setup invariant");
    for (let i = 0; i < 8; i++) insertPost(d1, authorId); // ids 2..9, filler
    const otherPostId = insertPost(d1, authorId, { mod_state: null });
    assert.equal(otherPostId, 10, "test setup invariant: id 10 textually contains id 1 as a prefix");

    const runId = insertMaintainerRunRow(d1);
    const queueId = insertQueueRow(d1, runId, {
      kind: "flag_review",
      target_type: "post",
      target_id: strandedPostId,
      note: "flagged as spam",
      status: "approved",
      decided_reason: encodeFlagReviewDecision("remove", "confirmed spam"),
      decided_at: Date.now() - 10_000,
    });

    const env = { DB: d1.DB } as unknown as Env;
    await moderateContent(env, maintainer, "post", otherPostId, "remove", "unrelated spam on a different post");

    const result = await reconcileApprovedQueue(env, maintainer);

    assert.equal(getPost(d1, strandedPostId).mod_state, "removed", "post 1's own stranded approval executes -- 'removed post 10' must never be read as post 1's artifact");
    assert.equal(result.actioned, 1);
    assert.equal(getQueueRow(d1, queueId).status, "approved");
  } finally {
    d1.close();
  }
});

// ---------- F-2: fetchReconcilableApprovedRows orders decided_at DESC
// (newest first), not ASC, so an older stranded row's replay can never be
// mistaken for "a later decision" by a newer row processed afterward. ----------

test("F-2: within one pass, the newer decision executes and the older one is correctly superseded, not the reverse (gate G1, verbatim reproduction)", async () => {
  const d1 = createLocalD1();
  try {
    const maintainer = seedMaintainer(d1);
    const authorId = insertCitizen(d1, { handle: "author" });
    const postId = insertPost(d1, authorId, { mod_state: null });
    const runId = insertMaintainerRunRow(d1);
    const now = Date.now();
    const olderQueueId = insertQueueRow(d1, runId, {
      kind: "flag_review",
      target_type: "post",
      target_id: postId,
      note: "flagged as spam (first review)",
      status: "approved",
      decided_reason: encodeFlagReviewDecision("collapse", "borderline, collapse it"),
      decided_at: now - 14 * 24 * 60 * 60 * 1000,
    });
    const newerQueueId = insertQueueRow(d1, runId, {
      kind: "flag_review",
      target_type: "post",
      target_id: postId,
      note: "flagged as spam (escalated)",
      status: "approved",
      decided_reason: encodeFlagReviewDecision("remove", "confirmed spam on re-review"),
      decided_at: now - 7 * 24 * 60 * 60 * 1000,
    });

    const env = { DB: d1.DB } as unknown as Env;
    const result = await reconcileApprovedQueue(env, maintainer);

    assert.equal(getPost(d1, postId).mod_state, "removed", "the society's most recent judgment (remove) must win, not the week-older collapse");
    assert.equal(result.actioned, 2, "the newer row replays for real, the older row is correctly superseded -- both are completed work");
    assert.equal(result.error, null);

    const newerRow = getQueueRow(d1, newerQueueId);
    assert.equal(newerRow.status, "approved", "the newer decision actually executed -- a successful replay leaves the row as-is, same as any other 'none' outcome");

    const olderRow = getQueueRow(d1, olderQueueId);
    assert.equal(olderRow.status, "rejected", "the older decision is correctly recognised as superseded");
    assert.equal(
      olderRow.decided_reason,
      "superseded: a later remove decision executed after this approval was stranded",
      "the reason correctly names remove (the real later decision), not collapse asserting the opposite of what happened",
    );
  } finally {
    d1.close();
  }
});

test("F-2 control: two stranded decisions with the SAME verb on one target behave correctly regardless of processing order (gate G2)", async () => {
  const d1 = createLocalD1();
  try {
    const maintainer = seedMaintainer(d1);
    const authorId = insertCitizen(d1, { handle: "author" });
    const postId = insertPost(d1, authorId, { mod_state: null });
    const runId = insertMaintainerRunRow(d1);
    const now = Date.now();
    const olderQueueId = insertQueueRow(d1, runId, {
      kind: "flag_review",
      target_type: "post",
      target_id: postId,
      note: "flagged as spam (first review)",
      status: "approved",
      decided_reason: encodeFlagReviewDecision("remove", "confirmed spam"),
      decided_at: now - 14 * 24 * 60 * 60 * 1000,
    });
    const newerQueueId = insertQueueRow(d1, runId, {
      kind: "flag_review",
      target_type: "post",
      target_id: postId,
      note: "flagged as spam (re-reported)",
      status: "approved",
      decided_reason: encodeFlagReviewDecision("remove", "confirmed spam, re-reported"),
      decided_at: now - 7 * 24 * 60 * 60 * 1000,
    });

    const env = { DB: d1.DB } as unknown as Env;
    const result = await reconcileApprovedQueue(env, maintainer);

    assert.equal(getPost(d1, postId).mod_state, "removed", "the target ends up removed either way -- both rows agree on the action");
    assert.equal(countModerationEvents(d1), 1, "only ONE real remove event -- the second row's replay is an idempotent skip against the first's own artifact, not a duplicate action");
    assert.equal(result.actioned, 1, "exactly one row does the real work; the other is a silent exact-match skip, not a second execution");

    const statuses = [getQueueRow(d1, olderQueueId).status, getQueueRow(d1, newerQueueId).status].sort();
    assert.deepEqual(statuses, ["approved", "approved"], "neither row is ever rejected -- an exact-match agreement is never a supersede, whichever one happens to replay first");
  } finally {
    d1.close();
  }
});

// ---------- F-3: the selection SQL excludes flag_review rows with no
// post/comment target (ruling b), and a row whose decided_reason fails to
// decode is now split into two named exits by whether its target already
// carries a real artifact (ruling a). ----------

test("F-3 ruling (a), artifact PRESENT: a pre-encoding row whose target already carries a real moderation artifact is retired silently, not reported (D-018 gate)", async () => {
  const d1 = createLocalD1();
  try {
    const maintainer = seedMaintainer(d1);
    const authorId = insertCitizen(d1, { handle: "author" });
    const postId = insertPost(d1, authorId, { mod_state: null });
    const runId = insertMaintainerRunRow(d1);
    const queueId = insertQueueRow(d1, runId, {
      kind: "flag_review",
      target_type: "post",
      target_id: postId,
      note: "flagged as spam",
      status: "approved",
      decided_reason: "confirmed spam, take it down", // ordinary pre-mq1 prose, decodes to null
      decided_at: Date.now() - 10_000,
    });

    const env = { DB: d1.DB } as unknown as Env;
    // The act really did happen, through a route this test does not need
    // to name -- its own real artifact exists in the public log, dated
    // after decided_at, for this exact target.
    await moderateContent(env, maintainer, "post", postId, "remove", "confirmed spam, take it down");

    const result = await reconcileApprovedQueue(env, maintainer);

    assert.equal(result.actioned, 1, "retiring the row is the completed job");
    assert.equal(result.error, null, "PRESENT is silent -- the public record already carries the true outcome, retiring the row is bookkeeping, not news");
    const row = getQueueRow(d1, queueId);
    assert.equal(row.status, "rejected");
    assert.equal(row.decided_reason, "retired pre-encoding (artifact present): confirmed spam, take it down", "the old reason is preserved after the prefix, not discarded");
  } finally {
    d1.close();
  }
});

test("F-3 ruling (b): an approved flag_review with no post/comment target is never selected by reconciliation at all -- terminal by design, not stranded (gate F2, clean-approval-poisons-every-later-run-row)", async () => {
  const d1 = createLocalD1();
  try {
    const maintainer = seedMaintainer(d1);
    const runId = insertMaintainerRunRow(d1);
    const queueId = insertQueueRow(d1, runId, {
      kind: "flag_review",
      target_type: null,
      target_id: null,
      note: "a similarly-named citizen registered",
      status: "approved",
      decided_reason: "the flag is well founded", // plain: resolveExecution's own execute:null claim reason, unprefixed
      decided_at: Date.now() - 10_000,
    });
    const before = getQueueRow(d1, queueId);

    const env = { DB: d1.DB } as unknown as Env;
    const first = await reconcileApprovedQueue(env, maintainer);
    const second = await reconcileApprovedQueue(env, maintainer);
    const third = await reconcileApprovedQueue(env, maintainer);

    for (const result of [first, second, third]) {
      assert.equal(result.actioned, 0, "never selected, so never actioned");
      assert.equal(result.error, null, "never selected, so never reported -- the old bug reported this identically on every pass forever");
    }
    assert.deepEqual(getQueueRow(d1, queueId), before, "completely untouched across three passes, not merely unreported");
  } finally {
    d1.close();
  }
});

// ---------- F-7: stampQueueRow's boolean is honoured at every
// reconciliation re-stamp, so items_actioned cannot over-count a claim
// that did not really land. ----------

// Simulates the conditional UPDATE's own WHERE clause excluding the row
// (as if something else already changed it) -- a synthetic stand-in,
// since no real code path in this repo can naturally produce it today
// (every reconciliation re-stamp uses requirePending: false, so the real
// WHERE is bare `id = ?`, which cannot fail to match a row this same loop
// just read moments earlier). Proves the CALLER respects the boolean,
// independent of whether today's code can ever actually trigger it --
// same idiom as withQueueUpdateMetaStripped above, reporting a clean
// zero-changes result instead of a corrupted/missing meta.
function withQueueUpdateAlwaysReportsZeroChanges(DB: LocalD1["DB"]): LocalD1["DB"] {
  return {
    prepare: (sql: string) => {
      const real = DB.prepare(sql);
      if (!/UPDATE\s+maintainer_queue/i.test(sql)) return real;
      return {
        bind: () => ({
          run: async () => ({ meta: { changes: 0, last_row_id: 0 } }),
        }),
      } as unknown as ReturnType<LocalD1["DB"]["prepare"]>;
    },
    batch: (stmts) => DB.batch(stmts),
  };
}

test("F-7: the supersede re-stamp counts actioned only if stampQueueRow's UPDATE actually changed a row", async () => {
  const d1 = createLocalD1();
  try {
    const maintainer = seedMaintainer(d1);
    const authorId = insertCitizen(d1, { handle: "author" });
    const postId = insertPost(d1, authorId, { mod_state: null });
    const runId = insertMaintainerRunRow(d1);
    const queueId = insertQueueRow(d1, runId, {
      kind: "flag_review",
      target_type: "post",
      target_id: postId,
      note: "flagged as spam",
      status: "approved",
      decided_reason: encodeFlagReviewDecision("remove", "confirmed spam"),
    });

    const realEnv = { DB: d1.DB } as unknown as Env;
    // A real later restore, so this row's own artifact check lands on the
    // SUPERSEDE branch specifically.
    await moderateContent(realEnv, maintainer, "post", postId, "restore", "restored after appeal");

    const wrappedEnv = { DB: withQueueUpdateAlwaysReportsZeroChanges(d1.DB) } as unknown as Env;
    const result = await reconcileApprovedQueue(wrappedEnv, maintainer);

    assert.equal(result.actioned, 0, "the UPDATE reported zero rows changed -- must not be counted, even though this is the supersede branch");
    assert.equal(getQueueRow(d1, queueId).status, "approved", "consistent with the reported zero -- nothing really changed either");
  } finally {
    d1.close();
  }
});

test("F-7: the bulletin deny-check re-stamp counts actioned only if stampQueueRow's UPDATE actually changed a row", async () => {
  const d1 = createLocalD1();
  try {
    const maintainer = seedMaintainer(d1);
    const runId = insertMaintainerRunRow(d1);
    const queueId = insertQueueRow(d1, runId, {
      kind: "bulletin_draft",
      note: "Claim your reward\nSign here to continue",
      status: "approved",
      decided_reason: "looked fine to the judge",
    });

    const wrappedEnv = { DB: withQueueUpdateAlwaysReportsZeroChanges(d1.DB) } as unknown as Env;
    const result = await reconcileApprovedQueue(wrappedEnv, maintainer);

    assert.equal(result.actioned, 0, "the UPDATE reported zero rows changed -- must not be counted, even on the deny-check branch");
    assert.equal(getQueueRow(d1, queueId).status, "approved", "consistent with the reported zero -- nothing really changed either");
    assert.equal(countPosts(d1), 0, "never posts regardless -- the deny-check itself still holds");
  } finally {
    d1.close();
  }
});

// ---------- F4/F7/F8/F9: the fidelity hydrator + progress-safe withhold +
// aggregate byte budget (docs/BRIEF-FIRST-LAWS-REPAIR.md §8) ----------

test("F4/F7 red-proof: an oldest withheld fidelity item is reported and stays pending while a newer ordinary row is reached and decided", async () => {
  const d1 = createLocalD1();
  const stub = stubAnthropicFetch();
  try {
    seedMaintainer(d1);
    const cache = await establishRealGenesisCache(d1);
    const runId = insertMaintainerRunRow(d1);
    const now = Date.now();
    // Oldest: a withheld fidelity row -- its named version does not exist
    // (§8.2's own "named version row is missing" fail-closed condition).
    const withheldId = insertWithheldFidelityRow(d1, runId, 999_999, now - 20_000);
    // Newer: an ordinary pending row, trivially decidable.
    const ordinaryId = insertQueueRow(d1, runId, {
      kind: "bookkeeping_note",
      note: "routine drift, nothing to action",
      status: "pending",
      decided_at: null,
      decided_reason: null,
      created_at: now - 10_000,
    });

    const env = { DB: d1.DB, ANTHROPIC_API_KEY: "test-key" } as unknown as Env;
    await runJudgmentWake(env, cache);

    assert.equal(stub.callCount(), 1, "exactly one real model call: the withheld row never reaches a batch on its own, the ordinary row's own batch does");
    assert.equal(getQueueRow(d1, ordinaryId).status, "approved", "the ordinary row reached a model batch and was decided");
    assert.equal(getQueueRow(d1, withheldId).status, "pending", "the withheld row stays pending -- never decided, never silently dropped");

    const run = latestRun(d1);
    assert.match(run.error ?? "", /withheld 1 constitution_fidelity item/);
    assert.match(run.error ?? "", new RegExp(`id=${withheldId} `), "the run row names the withheld id");
    assert.doesNotMatch(run.error ?? "", new RegExp(`\\bid=${ordinaryId}\\b`), "the decided, non-withheld row's id must never appear in the withheld report");
  } finally {
    stub.restore();
    d1.close();
  }
});

test("F7 red-proof: a large head cohort of withheld fidelity rows does not starve newer ordinary rows behind it (JUDGMENT_MAX_SCAN comfortably covers the whole fixture)", async () => {
  const d1 = createLocalD1();
  const stub = stubAnthropicFetch();
  try {
    seedMaintainer(d1);
    const cache = await establishRealGenesisCache(d1);
    const runId = insertMaintainerRunRow(d1);
    const now = Date.now();
    // A cohort deliberately far larger than JUDGMENT_QUEUE_CAP (now 1), so the
    // starvation this rules out is a real many-rows-ahead cohort, not a
    // one-row nicety. Comfortably under JUDGMENT_MAX_SCAN (1000): one scan
    // walks past the whole cohort, withholding each, and still reaches the
    // ordinary rows. Decoupled from the cap on purpose -- the cap governs how
    // many DECISIONS a batch makes, not how many withheld rows a scan skips.
    const WITHHELD_COHORT = 100;
    const withheldIds: number[] = [];
    for (let i = 0; i < WITHHELD_COHORT; i++) {
      withheldIds.push(insertWithheldFidelityRow(d1, runId, 999_000 + i, now - (WITHHELD_COHORT - i) * 1_000 - 50_000));
    }
    const ordinaryIds: number[] = [];
    for (let i = 0; i < 3; i++) {
      ordinaryIds.push(
        insertQueueRow(d1, runId, {
          kind: "bookkeeping_note",
          note: `ordinary row ${i}`,
          status: "pending",
          decided_at: null,
          decided_reason: null,
          created_at: now - (3 - i) * 1_000,
        }),
      );
    }

    const env = { DB: d1.DB, ANTHROPIC_API_KEY: "test-key" } as unknown as Env;
    await runJudgmentWake(env, cache);

    const run = latestRun(d1);
    // This fixture's 103 pending rows sit comfortably under JUDGMENT_MAX_SCAN
    // (1000) -- the scan-limit branch must never bind here; if it did, that
    // would itself be the starvation this test exists to rule out.
    assert.doesNotMatch(run.error ?? "", /scan limit reached/);
    for (const id of ordinaryIds) {
      assert.equal(getQueueRow(d1, id).status, "approved", `ordinary row ${id} must be reached and decided, not starved behind the withheld head cohort`);
    }
    for (const id of withheldIds) {
      assert.equal(getQueueRow(d1, id).status, "pending", `withheld row ${id} must stay pending, never silently dropped or re-decided`);
    }
    assert.match(run.error ?? "", new RegExp(`withheld ${WITHHELD_COHORT} constitution_fidelity items`));
    assert.ok(stub.callCount() >= 1, "at least one real model call must have reached the ordinary rows");
  } finally {
    stub.restore();
    d1.close();
  }
});

test("F8 red-proof: two individually-admissible fidelity items whose COMBINED real request body exceeds the budget land in separate scans, never concatenated", async () => {
  const d1 = createLocalD1();
  try {
    seedMaintainer(d1);
    const runId = insertMaintainerRunRow(d1);
    const now = Date.now();
    // Each item alone comfortably fits (~150KB of full_text plus fixed
    // overhead, well under the 256,000-byte budget); the two together do
    // not.
    const bigText = "X".repeat(150_000);
    const { queueId: id1 } = insertValidFidelityFixture(d1, runId, { newFullText: bigText, createdAt: now - 20_000, firstSeenAt: now - 20_000 });
    const { queueId: id2 } = insertValidFidelityFixture(d1, runId, { newFullText: bigText, createdAt: now - 10_000, firstSeenAt: now - 10_000 });

    const env = { DB: d1.DB } as unknown as Env; // no ANTHROPIC_API_KEY -- this test drives scanPendingQueueBatch directly, no model call anywhere in it

    const batch1 = await scanPendingQueueBatch(env, null, JUDGMENT_QUEUE_CAP, JUDGMENT_MAX_SCAN);
    assert.equal(batch1.admissible.length, 1, "only the first item fits in the first scan");
    assert.equal(batch1.admissible[0].id, id1);
    assert.equal(batch1.withheld.length, 0, "the second item is DEFERRED, not withheld -- it fits fine on its own, just not alongside the first");
    assert.equal(batch1.drained, false, "the deferred second item means there is more left to scan");

    const bytes1 = realRequestBytes(batch1.admissible);
    assert.ok(bytes1 <= TOTAL_PROMPT_REQUEST_MAX_BYTES, `batch 1's real request body (${bytes1} bytes) must not exceed the budget`);

    const batch2 = await scanPendingQueueBatch(env, batch1.nextCursor, JUDGMENT_QUEUE_CAP, JUDGMENT_MAX_SCAN);
    assert.equal(batch2.admissible.length, 1, "the deferred second item is admitted alone once it gets a fresh, empty batch");
    assert.equal(batch2.admissible[0].id, id2);
    assert.equal(batch2.withheld.length, 0);
    assert.equal(batch2.drained, true, "nothing left after the second item");

    const bytes2 = realRequestBytes(batch2.admissible);
    assert.ok(bytes2 <= TOTAL_PROMPT_REQUEST_MAX_BYTES, `batch 2's real request body (${bytes2} bytes) must not exceed the budget`);

    // Sanity precondition: the scenario is genuinely meaningful --
    // concatenating what the scanner deliberately kept split really would
    // have broken the budget, measured the same real way.
    const combinedBytes = realRequestBytes([...batch1.admissible, ...batch2.admissible]);
    assert.ok(
      combinedBytes > TOTAL_PROMPT_REQUEST_MAX_BYTES,
      `the whole point of the split: concatenated (${combinedBytes} bytes) must exceed the budget even though each half alone (${bytes1} + ${bytes2}) does not`,
    );
  } finally {
    d1.close();
  }
});

test("F8 red-proof: a lone fidelity item whose real request body exceeds the budget even alone is withheld loudly, never a silent forever-defer, and NEVER reaches the model (spy)", async () => {
  const d1 = createLocalD1();
  const stub = stubAnthropicFetch();
  try {
    seedMaintainer(d1);
    const cache = await establishRealGenesisCache(d1);
    const runId = insertMaintainerRunRow(d1);
    const now = Date.now();
    const hugeText = "X".repeat(260_000); // alone, already past TOTAL_PROMPT_REQUEST_MAX_BYTES (256,000) before any fixed overhead
    const { queueId } = insertValidFidelityFixture(d1, runId, { newFullText: hugeText, createdAt: now - 10_000, firstSeenAt: now - 10_000 });

    const env = { DB: d1.DB, ANTHROPIC_API_KEY: "test-key" } as unknown as Env;
    await runJudgmentWake(env, cache);

    assert.equal(stub.callCount(), 0, "callAnthropic's own underlying fetch must NEVER fire for a wake whose only candidate cannot fit even an empty batch -- a config-only assertion could not establish this, only a real spy can");
    assert.equal(getQueueRow(d1, queueId).status, "pending", "stays pending -- never a silent forever-defer");

    const run = latestRun(d1);
    assert.match(run.error ?? "", /withheld 1 constitution_fidelity item/);
    assert.match(run.error ?? "", new RegExp(`id=${queueId} \\(evidence exceeds request budget\\)`), "the run row names the exact §8.5 reason phrase for this id");
  } finally {
    stub.restore();
    d1.close();
  }
});

test("F9 red-proof: an accepted control/quote-heavy mandate body (8000 code units, the real proposal acceptance cap) is bounded by the real byte measure -- admitted and judged, or withheld with ZERO model calls, never truncated-and-judged", async () => {
  const d1 = createLocalD1();
  const stub = stubAnthropicFetch();
  try {
    seedMaintainer(d1);
    const cache = await establishRealGenesisCache(d1);
    const runId = insertMaintainerRunRow(d1);
    const now = Date.now();
    const proposerId = insertCitizen(d1, { handle: "mandate-proposer" });
    // A body createProposal itself would accept (governance.ts:640, cap
    // society.ts:42 = 8000 code units), filled with control characters
    // and quotes -- the exact hostile-but-legitimate shape F9 reproduced:
    // JSON.stringify expands a control-char run roughly 6x.
    const hostileBody = (String.fromCharCode(1) + '"').repeat(4_000);
    assert.equal(hostileBody.length, 8_000, "sanity: the fixture body sits exactly at the real acceptance cap");
    const mandateId = insertProposal(d1, {
      kind: "text_amendment",
      status: "passed",
      proposer_id: proposerId,
      title: "A hostile-shaped but accepted mandate",
      body: hostileBody,
    });
    const { queueId } = insertValidFidelityFixture(d1, runId, { mandateProposalIds: [mandateId], createdAt: now - 10_000, firstSeenAt: now - 10_000 });

    const env = { DB: d1.DB, ANTHROPIC_API_KEY: "test-key" } as unknown as Env;
    await runJudgmentWake(env, cache);

    const status = getQueueRow(d1, queueId).status;
    if (status === "pending") {
      assert.equal(stub.callCount(), 0, "if withheld, the model must never have been called");
      const run = latestRun(d1);
      assert.match(run.error ?? "", new RegExp(`id=${queueId} \\(evidence exceeds request budget\\)`));
    } else {
      assert.equal(status, "approved", "if not withheld, it must have been genuinely judged (approved), never a silent third state");
      assert.ok(stub.callCount() >= 1, "if judged, a real model call must have happened");
    }
  } finally {
    stub.restore();
    d1.close();
  }
});

test("F9 red-proof: a CJK-heavy mandate body whose CODE-UNIT length looks safely under budget but whose real UTF-8 BYTE length is not is withheld on the byte measure, never wrongly admitted on a code-unit measure", async () => {
  const d1 = createLocalD1();
  try {
    seedMaintainer(d1);
    const runId = insertMaintainerRunRow(d1);
    const now = Date.now();
    const proposerId = insertCitizen(d1, { handle: "cjk-mandate-proposer" });
    // Each CJK character is ONE UTF-16 code unit (.length) but THREE
    // UTF-8 bytes -- 90,000 code units is comfortably "under budget" by a
    // naive .length comparison against TOTAL_PROMPT_REQUEST_MAX_BYTES
    // (256,000), but its real byteLength (~270,000+) is not. This is the
    // exact F9 shape: a code-unit metric would wrongly admit this; the
    // real byte metric correctly does not. (Not capped at the real 8000
    // proposal-body limit -- this fixture is inserted directly, the same
    // "untrusted archive text" threat model §8.5 names, to demonstrate
    // the metric itself, not to claim this exact size is reachable
    // through createProposal today.)
    const cjkBody = "あ".repeat(90_000); // U+3042 HIRAGANA LETTER A, 3 bytes in UTF-8
    assert.ok(cjkBody.length < TOTAL_PROMPT_REQUEST_MAX_BYTES, "sanity: the naive code-unit length alone looks safely under budget");
    const mandateId = insertProposal(d1, {
      kind: "text_amendment",
      status: "passed",
      proposer_id: proposerId,
      title: "A CJK-heavy mandate",
      body: cjkBody,
    });
    const { queueId } = insertValidFidelityFixture(d1, runId, { mandateProposalIds: [mandateId], createdAt: now - 10_000, firstSeenAt: now - 10_000 });

    const env = { DB: d1.DB } as unknown as Env; // no ANTHROPIC_API_KEY -- drives the scanner directly, no model call anywhere in it

    const outcome = await scanPendingQueueBatch(env, null, JUDGMENT_QUEUE_CAP, JUDGMENT_MAX_SCAN);

    assert.equal(outcome.admissible.length, 0, "the CJK item must NOT be admitted -- its real byte length exceeds the budget even though its code-unit length does not");
    assert.equal(outcome.withheld.length, 1);
    assert.equal(outcome.withheld[0].id, queueId);
    assert.equal(outcome.withheld[0].reason, "evidence exceeds request budget");
  } finally {
    d1.close();
  }
});

// ---------- §1 regression fixture (docs/BRIEF-JUDGMENT-QUERY-BUDGET.md §1):
// the set-based classification cost, PINNED. The whole reason this wave
// exists is that per-row hydration made a page of malformed fidelity rows
// cost O(rows) D1 statements; the pin proves classification is now a fixed
// constant regardless of how many rows are malformed. Measured at HEAD, not
// estimated. Drives the scanner at the boundary AND counts every D1
// statement it issues -- a D1-only floor here, deliberately (the brief keeps
// Codex's own D1 costing alive as exactly this regression fixture); the
// subrequest matrix that shares the budget with model calls is proven at the
// invocation level in test/maintainer-scheduled-budget.test.ts. ----------

test("§1 regression fixture: a 1,000-row missing-version pending head classifies in a PINNED 11 D1 statements, never O(rows) -- 1 page read + ceil(1000/100) version-existence chunks", async () => {
  const counter = installSubrequestCounter(() => new Response("{}", { status: 200 }));
  const d1 = createLocalD1({ onExec: counter.consume });
  try {
    seedMaintainer(d1);
    const runId = insertMaintainerRunRow(d1);
    const now = Date.now();
    // 1,000 constitution_fidelity rows whose named version does not exist --
    // all withheld at the version-existence step, before any predecessor or
    // mandate query runs. Seeded via d1.raw, uncounted (fixture scaffolding).
    for (let i = 0; i < 1000; i++) insertWithheldFidelityRow(d1, runId, 900_000 + i, now - (1000 - i) * 1_000);

    const env = { DB: d1.DB } as unknown as Env; // no ANTHROPIC_API_KEY -- drives the scanner directly, no model call
    const outcome = await scanPendingQueueBatch(env, null, JUDGMENT_QUEUE_CAP, JUDGMENT_MAX_SCAN);

    assert.equal(outcome.admissible.length, 0, "every missing-version row is withheld, none admissible");
    assert.equal(outcome.withheld.length, 1000, "all 1,000 rows are classified and withheld in one scan");
    assert.equal(counter.fetches(), 0, "classification makes no outbound fetch");
    assert.equal(
      counter.d1(),
      11,
      "PINNED: 1 page read + ceil(1000/100)=10 version-existence chunks = 11 D1 statements, INDEPENDENT of the 1,000 rows. The per-row hydrator would issue 1,000+ here and the 50-subrequest counter would throw long before finishing.",
    );
  } finally {
    counter.restore();
    d1.close();
  }
});

// ---------- M-1 (docs/BRIEF-FIRST-LAWS-FIXES.md; gate
// REVIEW-FIRST-LAWS-GATE-2026-08-15.md; brief §8.3 items 2 and 3): the
// two brief-mandated red-proofs the gate and Codex both found missing.
// Every withheld fixture ABOVE this point is built by
// insertWithheldFidelityRow, whose named constitution_versions id simply
// does not exist -- the FIRST of hydrateFidelityEvidence's fail-closed
// conditions, which short-circuits before the hydrator ever reaches a
// real version row, a real predecessor, or a real linked mandate. So
// nothing above this point ever asserted the CONTENT the hydrator
// carries when it succeeds, nor the specific case of a linked mandate id
// that is absent from `proposals`. Both reviewers drove these branches
// manually and found the behaviour already correct -- this is a coverage
// defect, not a behaviour defect, but as the gate put it,
// buildFidelityEvidenceBlock could drop a whole section and the suite
// would stay green. ----------

test("M-1 red-proof (docs/BRIEF-FIRST-LAWS-REPAIR.md §8.3 item 2): the hydrator carries REAL archive rows into fidelity_evidence -- v1's full_text and parameters_text, v2's full_text and parameters_text, and the linked mandate's real proposal body, all three evidence-block sections present with real content, not merely the queue row's own note", async () => {
  const d1 = createLocalD1();
  try {
    seedMaintainer(d1);
    const runId = insertMaintainerRunRow(d1);
    const now = Date.now();

    const proposerId = insertCitizen(d1, { handle: "mandate-proposer" });
    const mandateId = insertProposal(d1, {
      kind: "text_amendment",
      status: "passed",
      proposer_id: proposerId,
      title: "Tidy section 4",
      body: "MANDATE BODY the judge must see verbatim, not merely the queue note.",
    });

    // Two real constitution_versions rows, built directly (not via
    // insertValidFidelityFixture) so BOTH the previous and the new
    // version carry their own distinguishable full_text AND
    // parameters_text -- proving all four named pieces (v1.full_text,
    // v2.full_text, v2.parameters_text per §8.3 item 2, plus v1's own
    // parameters_text, the other half of the <previous_version> block)
    // independently, not merely that SOME content reached the evidence.
    insertConstitutionVersion(d1, {
      full_text: "V1 PREVIOUS FULL TEXT",
      parameters_text: "V1 PREVIOUS PARAMETERS TEXT",
      changed_by: "genesis",
      first_seen_at: now - 20_000,
    });
    const v2Id = insertConstitutionVersion(d1, {
      full_text: "V2 NEW FULL TEXT",
      parameters_text: "V2 NEW PARAMETERS TEXT",
      changed_by: "mandate_linked",
      first_seen_at: now - 10_000,
      mandate_proposal_ids: [mandateId],
    });
    const queueId = insertQueueRow(d1, runId, {
      kind: "constitution_fidelity",
      source_ref: `constitution_versions:${v2Id}`,
      note: `constitution changed to version ${v2Id}`,
      status: "pending",
      decided_at: null,
      decided_reason: null,
      created_at: now - 5_000,
    });

    const env = { DB: d1.DB } as unknown as Env; // no ANTHROPIC_API_KEY -- drives the scanner directly, no model call anywhere in it
    const outcome = await scanPendingQueueBatch(env, null, JUDGMENT_QUEUE_CAP, JUDGMENT_MAX_SCAN);

    assert.equal(outcome.withheld.length, 0, "a fully-formed fixture must never withhold");
    assert.equal(outcome.admissible.length, 1);
    assert.equal(outcome.admissible[0].id, queueId);
    const evidence = outcome.admissible[0].fidelity_evidence;
    assert.ok(evidence, "fidelity_evidence must be populated, not null -- today's gap (M-1): the field exists but no D1 test ever asserted its content");
    assert.ok(evidence!.includes("V1 PREVIOUS FULL TEXT"), "the PREVIOUS version's real full_text must reach the evidence (§8.3 item 2: v1.full_text)");
    assert.ok(evidence!.includes("V1 PREVIOUS PARAMETERS TEXT"), "the PREVIOUS version's real parameters_text must reach the evidence -- the other half of the <previous_version> block");
    assert.ok(evidence!.includes("V2 NEW FULL TEXT"), "the NEW version's real full_text must reach the evidence (§8.3 item 2: v2.full_text)");
    assert.ok(evidence!.includes("V2 NEW PARAMETERS TEXT"), "the NEW version's real parameters_text must reach the evidence (§8.3 item 2: v2.parameters_text)");
    assert.ok(evidence!.includes("MANDATE BODY the judge must see verbatim"), "the linked mandate's real proposal body must reach the evidence, not merely its id (§8.3 item 2: p.body)");
    assert.ok(evidence!.includes(`<linked_mandate id="${mandateId}" status="passed">`), "the linked mandate block must be tagged with the real proposal id and status");

    // The three evidence-block SECTIONS, in the order buildFidelityEvidenceBlock emits them.
    assert.ok(evidence!.includes("<previous_version>"), "the previous_version section tag must be present");
    assert.ok(evidence!.includes("<new_version>"), "the new_version section tag must be present");
    assert.ok(evidence!.includes("<linked_mandate"), "the linked_mandate section tag must be present");
  } finally {
    d1.close();
  }
});

test("M-1 red-proof (docs/BRIEF-FIRST-LAWS-REPAIR.md §8.3 item 3): a linked mandate proposal absent from `proposals` withholds the item loudly -- never handed to the model with only the note", async () => {
  const d1 = createLocalD1();
  const stub = stubAnthropicFetch();
  try {
    seedMaintainer(d1);
    const cache = await establishRealGenesisCache(d1);
    const runId = insertMaintainerRunRow(d1);
    const now = Date.now();

    // A genuine, well-formed fixture in every respect EXCEPT the linked
    // mandate: mandateProposalIds names an id with no row in `proposals`
    // at all -- distinct from insertWithheldFidelityRow's own "named
    // version row is missing" case (this version row IS real, and its
    // predecessor IS real; only the linked mandate is absent).
    const missingMandateId = 999_888;
    const { queueId } = insertValidFidelityFixture(d1, runId, {
      mandateProposalIds: [missingMandateId],
      createdAt: now - 10_000,
      firstSeenAt: now - 10_000,
    });

    const env = { DB: d1.DB, ANTHROPIC_API_KEY: "test-key" } as unknown as Env;
    await runJudgmentWake(env, cache);

    assert.equal(stub.callCount(), 0, "the model must never be called with an item whose linked mandate is missing -- today (pre-fix coverage) this assertion is untested, not unenforced");
    assert.equal(getQueueRow(d1, queueId).status, "pending", "the item stays pending, never silently dropped or wrongly decided");

    const run = latestRun(d1);
    assert.match(
      run.error ?? "",
      new RegExp(`id=${queueId} \\(a linked mandate proposal for constitution_versions row \\d+ is missing from proposals\\)`),
      "the run row's withheld report must name the real reason (the hydrator's own fail-closed message), not a generic failure",
    );
  } finally {
    stub.restore();
    d1.close();
  }
});

// ---------- §9 (D-041): the budget-aware batch loop sheds batches it cannot
// pay for, LOUDLY, before opening them. Driven at the wake level with an
// explicit priorCost (the co-resident sweep's estimated cost); the full
// scheduled() compound proof lives in test/maintainer-scheduled-budget.test.ts.
// ----------

test("§9 control: a quiet invocation (priorCost = zero-due sweep) opens all four batches -- four bulletins decided, no shed clause", async () => {
  const d1 = createLocalD1();
  const stub = stubAnthropicFetch();
  try {
    const maintainer = seedMaintainer(d1);
    const cache = await establishRealGenesisCache(d1);
    const runId = insertMaintainerRunRow(d1);
    const now = Date.now();
    for (let i = 0; i < 4; i++) {
      insertQueueRow(d1, runId, { kind: "bulletin_draft", note: `Quiet digest ${i}\nBody number ${i}, all calm.`, status: "pending", decided_at: null, decided_reason: null, created_at: now - (4 - i) * 1_000 });
    }
    const env = { DB: d1.DB, ANTHROPIC_API_KEY: "test-key" } as unknown as Env;

    await runJudgmentWake(env, cache, estimateSweepCost(0)); // priorCost = 3

    assert.equal(countPosts(d1), 4, "all four bulletins decided across four batches -- the JUDGMENT_MAX_BATCHES ceiling, affordable when nothing else ran");
    assert.equal(stub.callCount(), 4, "four real model calls, one per batch");
    const run = latestRun(d1);
    assert.doesNotMatch(run.error ?? "", /batches shed for subrequest budget/, "no shed on a quiet invocation");
    assert.equal(run.overflow_dropped, 0, "nothing deferred");
  } finally {
    stub.restore();
    d1.close();
  }
});

test("§9 shed: a busy co-resident sweep (priorCost = 2-due sweep) sheds later batches -- fewer decisions, the rest deferred and counted, with the loud clause", async () => {
  const d1 = createLocalD1();
  const stub = stubAnthropicFetch();
  try {
    seedMaintainer(d1);
    const cache = await establishRealGenesisCache(d1);
    const runId = insertMaintainerRunRow(d1);
    const now = Date.now();
    // Same four pending bulletins as the control; only priorCost differs.
    for (let i = 0; i < 4; i++) {
      insertQueueRow(d1, runId, { kind: "bulletin_draft", note: `Busy digest ${i}\nBody number ${i}, all calm.`, status: "pending", decided_at: null, decided_reason: null, created_at: now - (4 - i) * 1_000 });
    }
    const env = { DB: d1.DB, ANTHROPIC_API_KEY: "test-key" } as unknown as Env;

    // priorCost = estimateSweepCost(2) = 21. canOpenJudgmentBatch: batch 1 (37)
    // and batch 2 (45) fit; batch 3 (53) does not -> shed after 2 batches.
    await runJudgmentWake(env, cache, estimateSweepCost(2));

    assert.equal(countPosts(d1), 2, "only two bulletins decided before the loop shed the rest for budget");
    assert.equal(stub.callCount(), 2, "exactly two real model calls -- the shed happens BEFORE opening batch 3, so no wasted model call");
    const pending = d1.raw.prepare("SELECT COUNT(*) AS n FROM maintainer_queue WHERE status = 'pending'").get() as { n: number };
    assert.equal(pending.n, 2, "the two undecided bulletins stay pending -- deferred, never lost");
    const run = latestRun(d1);
    assert.match(run.error ?? "", /judgment batches shed for subrequest budget after 2 batches/, "the shed is loud, one clause, naming how many batches ran");
    assert.equal(run.overflow_dropped, 2, "the deferred pending rows are counted by computeOverflowDropped, exactly like a JUDGMENT_MAX_BATCHES overflow");
  } finally {
    stub.restore();
    d1.close();
  }
});
