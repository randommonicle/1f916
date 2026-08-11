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
import { createLocalD1, insertCitizen, type LocalD1 } from "./helpers/local-d1.ts";
import { runJudgmentWake, executeJudgmentDecisions, reconcileApprovedQueue, encodeFlagReviewDecision } from "../src/maintainer/judgment.ts";
import type { Env } from "../src/society.ts";
import type { QueueRow, JudgmentDecision } from "../src/maintainer/judgment.ts";

// ---------- local fixture helpers (this file's own, per society-votes-d1.test.ts's precedent -- no edits to the shared test/helpers/local-d1.ts) ----------

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
}

function insertQueueRow(d1: LocalD1, runId: number, overrides: Partial<QueueRowOverrides> = {}): number {
  const now = Date.now();
  const res = d1.raw
    .prepare(
      "INSERT INTO maintainer_queue (run_id, created_at, kind, target_type, target_id, source_ref, note, status, decided_at, decided_reason) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)",
    )
    .run(
      runId,
      now - 10_000,
      overrides.kind ?? "flag_review",
      overrides.target_type ?? null,
      overrides.target_id ?? null,
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
    await runJudgmentWake(env);

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
    await runJudgmentWake(env);

    const run = latestRun(d1);
    assert.equal(run.skipped_reason, "nothing pending", "the wake reached and correctly reported the pending-queue state, not an early bail-out");
    assert.notEqual(run.error, null, "the reconciliation failure still reaches the run row");
    assert.match(run.error ?? "", new RegExp(String(poisonedId)), "the error names the poisoned row");
  } finally {
    d1.close();
  }
});
