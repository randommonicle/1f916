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
import { moderateContent, flagContent, type Env } from "../src/society.ts";
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
    await runJudgmentWake(env);

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
    await runJudgmentWake(env);

    const run = latestRun(d1);
    assert.equal(run.skipped_reason, "no api key");
    assert.notEqual(run.error, null, "a reconciliation error reaches the run row even when the model half never runs");
    assert.match(run.error ?? "", new RegExp(String(poisonedId)), "the error names the poisoned row");
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
