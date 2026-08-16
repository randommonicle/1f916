// D1-backed tests for I-007, the attested constitution
// (docs/FIRST-LAWS-DESIGN.md §5, docs/BRIEF-FIRST-LAWS.md commit 4): the
// CONCURRENT-WINNER detection batch (genesis, mandate-linked, operator
// changed_by branches; the retry-then-lose/retry-then-win races), the
// wake-side fidelity queue reconciliation, the per-isolate cache, and the
// public attest/versions read surfaces. Split out from
// governance-d1.test.ts (already large before this arc) as its own file,
// the same precedent maintainer-judgment-d1.test.ts/society-votes-d1.test.ts
// already set for a big, distinct D1-backed feature area.
//
// Uses test/helpers/local-d1.ts (node:sqlite, the real schema.sql), same
// as every other D1-backed test in this repo.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, insertCitizen, insertProposal, type LocalD1 } from "./helpers/local-d1.ts";
import { installSubrequestCounter } from "./helpers/subrequest-counter.ts";
import {
  computeLiveConstitutionPair,
  getConstitutionAttestation,
  detectConstitutionChange,
  reconcileConstitutionFidelityQueue,
  listConstitutionVersions,
  runGovernanceSweep,
  type ConstitutionCache,
} from "../src/governance.ts";
import { MAINTAINER_ID } from "../src/society.ts";
import type { Env } from "../src/society.ts";

function testEnv(d1: ReturnType<typeof createLocalD1>): Env {
  return {
    DB: d1.DB,
    TREASURY_ADDRESS: "0x0",
    FACILITATOR_URL: "https://facilitator.example.invalid",
    REGISTRATION_MODE: "invite_only",
  } as Env;
}

// A fresh cache per test -- module-level state would otherwise leak
// between tests sharing this file's one process (Node's test runner
// isolates each FILE into its own process, not each test() within it).
function freshCache(): ConstitutionCache {
  return { pairKey: null, versionRow: null };
}

// A guaranteed-different-from-any-real-sha256 pair, for seeding a "some
// OTHER template/parameters were live before" prior version directly --
// stands in for "the template was mutated" without needing to literally
// edit governance.ts/doc.ts's own source at test time (buildConstitutionTemplate
// takes no parameters; it is not injectable). sha256 hex digests are
// always exactly 64 lowercase hex characters, so a plainly non-hex string
// can never collide with a real one. A per-call counter keeps multiple
// seeded fakes within one test from colliding with EACH OTHER on the
// table's own UNIQUE(template_hash, parameters_hash) index.
let fakeVersionCounter = 0;

function seedFakePriorVersion(d1: LocalD1, overrides: Partial<{ changed_by: string; mandate_proposal_ids: string; first_seen_at: number }> = {}): number {
  fakeVersionCounter++;
  const result = d1.raw
    .prepare(
      "INSERT INTO constitution_versions (template_hash, parameters_hash, full_text, parameters_text, first_seen_at, changed_by, mandate_proposal_ids) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      `fake-prior-template-hash-not-real-sha256-${fakeVersionCounter}`,
      `fake-prior-parameters-hash-not-real-sha256-${fakeVersionCounter}`,
      "fake full text",
      "fake parameters text",
      overrides.first_seen_at ?? Date.now(),
      overrides.changed_by ?? "genesis",
      overrides.mandate_proposal_ids ?? "[]",
    );
  return Number(result.lastInsertRowid);
}

// MAINTAINER_ID (citizen #1) must exist before any NON-genesis detection
// (the chained constitution_changed event's own citizen_id FK), matching
// how a real deployment always seeds the maintainer as citizen #1 before
// anything else runs (SEEDING.md). Genesis itself needs no citizen at
// all (no chained event) -- only tests that exercise the non-genesis
// path need this called first, and it must be the FIRST citizens INSERT
// in the test so AUTOINCREMENT actually assigns it id 1.
function seedMaintainerCitizen(d1: LocalD1): number {
  const id = insertCitizen(d1, { handle: "commonhold-agent" });
  assert.equal(id, MAINTAINER_ID, "fixture sanity: the maintainer fixture must land as citizen #1 (first citizens insert in the test)");
  return id;
}

// ---------- genesis ----------

test("detectConstitutionChange: genesis -- an empty archive lands exactly one version, changed_by 'genesis', empty mandate_proposal_ids, and NO chained identity_events row", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const before = await d1.DB.prepare("SELECT COUNT(*) AS n FROM constitution_versions").first<{ n: number }>();
    assert.equal(before!.n, 0, "fixture sanity: genuinely empty");

    const outcome = await detectConstitutionChange(env, Date.now(), freshCache());
    assert.equal(outcome.status, "landed");
    if (outcome.status !== "landed") throw new Error("unreachable");
    assert.equal(outcome.changedBy, "genesis");
    assert.deepEqual(outcome.mandateIds, []);

    const row = await d1.DB.prepare("SELECT changed_by, mandate_proposal_ids FROM constitution_versions WHERE id = ?")
      .bind(outcome.versionId)
      .first<{ changed_by: string; mandate_proposal_ids: string }>();
    assert.equal(row!.changed_by, "genesis");
    assert.equal(row!.mandate_proposal_ids, "[]");

    const count = await d1.DB.prepare("SELECT COUNT(*) AS n FROM constitution_versions").first<{ n: number }>();
    assert.equal(count!.n, 1, "exactly one version row");

    const events = await d1.DB.prepare("SELECT COUNT(*) AS n FROM identity_events WHERE kind = 'constitution_changed'").first<{ n: number }>();
    assert.equal(events!.n, 0, "genesis carries NO chained event, per design doc §5");
  } finally {
    d1.close();
  }
});

test("detectConstitutionChange: a second call after genesis is idempotent -- 'already_current', no new row, no new event", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const cache = freshCache();
    const first = await detectConstitutionChange(env, Date.now(), cache);
    assert.equal(first.status, "landed");

    const second = await detectConstitutionChange(env, Date.now(), cache);
    assert.equal(second.status, "already_current");
    if (second.status !== "already_current") throw new Error("unreachable");
    if (first.status === "landed") assert.equal(second.versionId, first.versionId);

    const count = await d1.DB.prepare("SELECT COUNT(*) AS n FROM constitution_versions").first<{ n: number }>();
    assert.equal(count!.n, 1);
  } finally {
    d1.close();
  }
});

test("detectConstitutionChange: a second call with a FRESH cache (simulating a different isolate) still resolves 'already_current' via a real DB read, not a stale miss", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const first = await detectConstitutionChange(env, Date.now(), freshCache());
    assert.equal(first.status, "landed");

    // A brand new cache, exactly as a different isolate would start --
    // must still find the real row via a fresh DB lookup, not report
    // genesis a second time.
    const second = await detectConstitutionChange(env, Date.now(), freshCache());
    assert.equal(second.status, "already_current");
  } finally {
    d1.close();
  }
});

// ---------- non-genesis: operator vs mandate_linked ----------

test("detectConstitutionChange: non-genesis, zero passed mandates -> changed_by 'operator', WITH a chained constitution_changed event this time", async () => {
  const d1 = createLocalD1();
  try {
    seedMaintainerCitizen(d1);
    seedFakePriorVersion(d1); // makes the archive non-empty -- isGenesis becomes false
    const env = testEnv(d1);
    const now = Date.now();
    const outcome = await detectConstitutionChange(env, now, freshCache());
    assert.equal(outcome.status, "landed");
    if (outcome.status !== "landed") throw new Error("unreachable");
    assert.equal(outcome.changedBy, "operator");
    assert.deepEqual(outcome.mandateIds, []);

    const events = await d1.DB.prepare("SELECT citizen_id, kind, detail FROM identity_events WHERE kind = 'constitution_changed'").all<{
      citizen_id: number;
      kind: string;
      detail: string;
    }>();
    assert.equal(events.results.length, 1, "a non-genesis change DOES carry a chained event");
    assert.equal(events.results[0].citizen_id, MAINTAINER_ID, "commission notes flag 9: authored by the maintainer (citizen #1)");
    assert.match(events.results[0].detail, /operator/);
    // design doc §5: "detail old_hash -> new_hash" -- the seeded fake
    // prior version's own hash prefix (template_hash.slice(0,12) is
    // "fake-prior-t") must appear as the OLD side, and the live-computed
    // pair's own real hex prefix as the NEW side, in that order.
    assert.match(events.results[0].detail, /fake-prior-t\.\.\..* -> [0-9a-f]{12}\.\.\./);

    const count = await d1.DB.prepare("SELECT COUNT(*) AS n FROM constitution_versions").first<{ n: number }>();
    assert.equal(count!.n, 2, "the seeded fake prior version plus the newly-landed real one");
  } finally {
    d1.close();
  }
});

test("detectConstitutionChange: non-genesis, two passed mandates (first_laws_amendment + text_amendment) -> changed_by 'mandate_linked', BOTH flipped to executed and BOTH listed [G1-2 drain]", async () => {
  const d1 = createLocalD1();
  try {
    seedFakePriorVersion(d1);
    // First laws already ratified (a prerequisite for first_laws_amendment
    // to have ever been created honestly -- not re-enforced at detection
    // time, but seeded realistically regardless).
    d1.raw.prepare("INSERT INTO governance_settings (key, value, updated_at) VALUES (?, ?, ?)").run("first_laws_ratified", "1", Date.now());

    const proposer = insertCitizen(d1);
    const mandate1 = insertProposal(d1, { kind: "first_laws_amendment", status: "passed", proposer_id: proposer });
    const mandate2 = insertProposal(d1, { kind: "text_amendment", status: "passed", proposer_id: proposer });
    // A control: a THIRD passed proposal of an unrelated kind must never
    // be swept up into the mandate linkage.
    const unrelated = insertProposal(d1, { kind: "resolution", status: "passed", proposer_id: proposer });

    const env = testEnv(d1);
    const outcome = await detectConstitutionChange(env, Date.now(), freshCache());
    assert.equal(outcome.status, "landed");
    if (outcome.status !== "landed") throw new Error("unreachable");
    assert.equal(outcome.changedBy, "mandate_linked");
    assert.deepEqual([...outcome.mandateIds].sort((a, b) => a - b), [mandate1, mandate2].sort((a, b) => a - b));

    const { results: flipped } = await d1.DB.prepare("SELECT id, status FROM proposals WHERE id IN (?, ?, ?) ORDER BY id").bind(mandate1, mandate2, unrelated).all<{
      id: number;
      status: string;
    }>();
    const byId = new Map(flipped.map((r) => [r.id, r.status]));
    assert.equal(byId.get(mandate1), "executed");
    assert.equal(byId.get(mandate2), "executed");
    assert.equal(byId.get(unrelated), "passed", "an unrelated passed proposal must never be flipped by this linkage");

    const versionRow = await d1.DB.prepare("SELECT mandate_proposal_ids FROM constitution_versions WHERE changed_by = 'mandate_linked'").first<{
      mandate_proposal_ids: string;
    }>();
    assert.deepEqual(JSON.parse(versionRow!.mandate_proposal_ids).sort(), [mandate1, mandate2].sort());
  } finally {
    d1.close();
  }
});

// ---------- concurrency: the CONCURRENT-WINNER CONTRACT ----------

// Reused verbatim from governance-d1.test.ts's own N1/N6 helper (this
// project's own working agreement for small policing/race helpers:
// copied, not shared, so one file's edit can never silently change
// another's behaviour) -- intercepts the exact head-read SELECT
// appendChainedStmt issues for `table` and, the first time it runs,
// hands the caller a value read a moment "before" a concurrent write
// completes underneath it: a deterministic reproduction of "another
// caller ran to completion in the gap between this caller's own read and
// its write."
function withChainedHeadReadTriggering(DB: LocalD1["DB"], table: string, duringRead: () => Promise<unknown>): LocalD1["DB"] {
  const headSql = `SELECT hash FROM ${table} WHERE hash IS NOT NULL ORDER BY id DESC LIMIT 1`;
  let fired = false;
  return {
    prepare: (sql: string) => {
      const real = DB.prepare(sql);
      if (fired || sql !== headSql) return real;
      return {
        ...real,
        async first<T>(): Promise<T | null> {
          const captured = await real.first<T>();
          fired = true;
          await duringRead();
          return captured;
        },
      };
    },
    batch: (stmts) => DB.batch(stmts),
  };
}

test("detectConstitutionChange: two concurrent detections yield exactly one version row, one chained event, one queue-eligible archive entry -- the loser leaves ZERO partial writes, including on the mandate rows specifically", async () => {
  const d1 = createLocalD1();
  try {
    seedFakePriorVersion(d1);
    d1.raw.prepare("INSERT INTO governance_settings (key, value, updated_at) VALUES (?, ?, ?)").run("first_laws_ratified", "1", Date.now());
    const proposer = insertCitizen(d1);
    const mandate = insertProposal(d1, { kind: "first_laws_amendment", status: "passed", proposer_id: proposer });

    const now = Date.now();
    const bEnv = testEnv(d1);
    // B runs to completion the FIRST time A's own identity_events
    // head-read fires -- a real land, real batch, real commit.
    const aEnv = {
      ...testEnv(d1),
      DB: withChainedHeadReadTriggering(d1.DB, "identity_events", () => detectConstitutionChange(bEnv, now, freshCache())),
    };

    const aOutcome = await detectConstitutionChange(aEnv, now, freshCache());
    // A's own identity_events append races against B's already-landed
    // one: A retries against the fresh head (a real chain-head race, the
    // "continue" branch), and on retry finds the version row already
    // exists -- lost_claim.
    assert.equal(aOutcome.status, "lost_claim", "A must not report landed for a row B actually committed");

    const versions = await d1.DB.prepare("SELECT COUNT(*) AS n FROM constitution_versions").first<{ n: number }>();
    assert.equal(versions!.n, 2, "the seeded fake prior version plus exactly ONE newly-landed real one -- not two");

    const events = await d1.DB.prepare("SELECT COUNT(*) AS n FROM identity_events WHERE kind = 'constitution_changed'").first<{ n: number }>();
    assert.equal(events!.n, 1, "exactly one chained event, not two");

    const mandateRow = await d1.DB.prepare("SELECT status FROM proposals WHERE id = ?").bind(mandate).first<{ status: string }>();
    assert.equal(mandateRow!.status, "executed", "the mandate is flipped exactly once by the real winner");
  } finally {
    d1.close();
  }
});

test("detectConstitutionChange: a chain-head race from ORDINARY unrelated identity_events traffic (not another detection) is retried, not mistaken for a lost claim", async () => {
  const d1 = createLocalD1();
  try {
    seedFakePriorVersion(d1);
    const proposer = insertCitizen(d1);
    const now = Date.now();

    // An unrelated identity_events append (a key rotation, standing in
    // for any ordinary chained write) lands in the gap between this
    // call's own head-read and its write -- must be retried, not
    // reported as if constitution_versions itself already held the row.
    const env = {
      ...testEnv(d1),
      DB: withChainedHeadReadTriggering(d1.DB, "identity_events", async () => {
        const { appendChained } = await import("../src/chain.ts");
        await appendChained(d1.DB, "identity_events", { citizen_id: proposer, kind: "key_rotation", detail: "unrelated", created_at: now });
      }),
    };

    const outcome = await detectConstitutionChange(env, now, freshCache());
    assert.equal(outcome.status, "landed", "the retry must succeed once the unrelated write is no longer in the way");

    const events = await d1.DB.prepare("SELECT kind FROM identity_events ORDER BY id ASC").all<{ kind: string }>();
    assert.deepEqual(events.results.map((r) => r.kind).sort(), ["constitution_changed", "key_rotation"].sort());
  } finally {
    d1.close();
  }
});

// ---------- the stale-cache case ----------

test("per-isolate cache: a version landing after an earlier 'not found' answer is served correctly on the next call, never a stale null (compute the live pair FIRST, serve the cached row only when it matches)", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const cache = freshCache();

    const before = await getConstitutionAttestation(env, cache);
    assert.equal(before.version, null, "nothing detected yet");
    assert.equal(cache.versionRow, null, "a 'not found' answer must never be cached");

    const detection = await detectConstitutionChange(env, Date.now(), cache);
    assert.equal(detection.status, "landed");

    const after = await getConstitutionAttestation(env, cache);
    assert.notEqual(after.version, null, "the SAME cache object, reused, must see the version detectConstitutionChange just landed -- not a stale cached miss");
    assert.equal(after.version, (detection as { versionId: number }).versionId);
  } finally {
    d1.close();
  }
});

test("per-isolate cache: once resolved, a second lookup does not re-query the database (the actual caching, not just correctness of the fallback)", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const cache = freshCache();
    await detectConstitutionChange(env, Date.now(), cache);

    let selects = 0;
    const countingEnv = {
      ...env,
      DB: {
        prepare: (sql: string) => {
          if (/SELECT id, first_seen_at, changed_by FROM constitution_versions/.test(sql)) selects++;
          return d1.DB.prepare(sql);
        },
        batch: (stmts: Parameters<LocalD1["DB"]["batch"]>[0]) => d1.DB.batch(stmts),
      },
    };

    await getConstitutionAttestation(countingEnv as Env, cache);
    assert.equal(selects, 0, "a resolved cache hit must not issue the version lookup SELECT at all");
  } finally {
    d1.close();
  }
});

// ---------- attest parity ----------

test("getConstitutionAttestation: template_hash/parameters_hash match computeLiveConstitutionPair exactly, and version/first_seen_at/changed_by are honestly null before any detection has ever run", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const pair = await computeLiveConstitutionPair();
    const attestation = await getConstitutionAttestation(env, freshCache());
    assert.equal(attestation.template_hash, pair.templateHash);
    assert.equal(attestation.parameters_hash, pair.parametersHash);
    assert.equal(attestation.version, null);
    assert.equal(attestation.first_seen_at, null);
    assert.equal(attestation.changed_by, null);
  } finally {
    d1.close();
  }
});

test("getConstitutionAttestation: after detection, reports the real version id, first_seen_at, and changed_by", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const now = Date.now();
    await detectConstitutionChange(env, now, freshCache());
    const attestation = await getConstitutionAttestation(env, freshCache());
    assert.notEqual(attestation.version, null);
    assert.equal(attestation.first_seen_at, now);
    assert.equal(attestation.changed_by, "genesis");
  } finally {
    d1.close();
  }
});

// ---------- runGovernanceSweep: detection wired in, detection_stranded ----------

test("runGovernanceSweep: also runs detection (idempotent double-invocation is harmless) and carries detection_stranded:false on the ordinary path", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const result = await runGovernanceSweep(env, Date.now(), freshCache());
    assert.equal(result.detection_stranded, false);
    const count = await d1.DB.prepare("SELECT COUNT(*) AS n FROM constitution_versions").first<{ n: number }>();
    assert.equal(count!.n, 1, "the sweep's own call to detection lands genesis even with nothing due to tally");
  } finally {
    d1.close();
  }
});

// ---------- wake-side fidelity queue reconciliation ----------

test("reconcileConstitutionFidelityQueue: a serve-path-landed (non-genesis) version gets exactly one fidelity row at the next wake, bound to the wake's own run_id", async () => {
  const d1 = createLocalD1();
  try {
    seedMaintainerCitizen(d1);
    seedFakePriorVersion(d1);
    const env = testEnv(d1);
    const detection = await detectConstitutionChange(env, Date.now(), freshCache()); // simulates a serve-path (GET /) landing
    assert.equal(detection.status, "landed");

    const runId = d1.raw.prepare("INSERT INTO maintainer_runs (kind, started_at) VALUES ('clerk', ?)").run(Date.now()).lastInsertRowid;
    const result = await reconcileConstitutionFidelityQueue(env, Number(runId), Date.now());
    assert.equal(result.queued, 1);
    assert.equal(result.error, null);

    const row = await d1.DB.prepare("SELECT run_id, kind, target_type, target_id, source_ref, status FROM maintainer_queue WHERE kind = 'constitution_fidelity'").first<{
      run_id: number;
      kind: string;
      target_type: string | null;
      target_id: number | null;
      source_ref: string;
      status: string;
    }>();
    assert.ok(row);
    assert.equal(row!.run_id, Number(runId));
    assert.equal(row!.target_type, null);
    assert.equal(row!.target_id, null);
    assert.equal(row!.status, "pending");
    assert.match(row!.source_ref, /^constitution_versions:\d+$/);
  } finally {
    d1.close();
  }
});

test("reconcileConstitutionFidelityQueue: a wake-path fresh change gets its fidelity row the SAME wake (detection then reconciliation, one call each)", async () => {
  const d1 = createLocalD1();
  try {
    seedMaintainerCitizen(d1);
    seedFakePriorVersion(d1);
    const env = testEnv(d1);
    const now = Date.now();
    const runId = d1.raw.prepare("INSERT INTO maintainer_runs (kind, started_at) VALUES ('judgment', ?)").run(now).lastInsertRowid;

    await detectConstitutionChange(env, now, freshCache());
    const result = await reconcileConstitutionFidelityQueue(env, Number(runId), now);
    assert.equal(result.queued, 1);
  } finally {
    d1.close();
  }
});

test("reconcileConstitutionFidelityQueue: two wakes never duplicate the same version's fidelity row", async () => {
  const d1 = createLocalD1();
  try {
    seedMaintainerCitizen(d1);
    seedFakePriorVersion(d1);
    const env = testEnv(d1);
    await detectConstitutionChange(env, Date.now(), freshCache());

    const run1 = d1.raw.prepare("INSERT INTO maintainer_runs (kind, started_at) VALUES ('clerk', ?)").run(Date.now()).lastInsertRowid;
    const first = await reconcileConstitutionFidelityQueue(env, Number(run1), Date.now());
    assert.equal(first.queued, 1);

    const run2 = d1.raw.prepare("INSERT INTO maintainer_runs (kind, started_at) VALUES ('judgment', ?)").run(Date.now()).lastInsertRowid;
    const second = await reconcileConstitutionFidelityQueue(env, Number(run2), Date.now());
    assert.equal(second.queued, 0, "the version already has a fidelity row -- the second wake's own attempt must no-op");

    const count = await d1.DB.prepare("SELECT COUNT(*) AS n FROM maintainer_queue WHERE kind = 'constitution_fidelity'").first<{ n: number }>();
    assert.equal(count!.n, 1);
  } finally {
    d1.close();
  }
});

test("reconcileConstitutionFidelityQueue: the genesis version never gets a fidelity row -- reconciliation is per NON-genesis version only", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const detection = await detectConstitutionChange(env, Date.now(), freshCache());
    assert.equal((detection as { changedBy: string }).changedBy, "genesis");

    const runId = d1.raw.prepare("INSERT INTO maintainer_runs (kind, started_at) VALUES ('clerk', ?)").run(Date.now()).lastInsertRowid;
    const result = await reconcileConstitutionFidelityQueue(env, Number(runId), Date.now());
    assert.equal(result.queued, 0);

    const count = await d1.DB.prepare("SELECT COUNT(*) AS n FROM maintainer_queue").first<{ n: number }>();
    assert.equal(count!.n, 0);
  } finally {
    d1.close();
  }
});

test("reconcileConstitutionFidelityQueue costs ONE D1 statement regardless of how many non-genesis versions it queues (docs/BRIEF-JUDGMENT-QUERY-BUDGET.md §3: the 1+N subrequest multiplier collapses to 1)", async () => {
  const counter = installSubrequestCounter(() => new Response("{}", { status: 200 }));
  const d1 = createLocalD1({ onExec: counter.consume });
  try {
    // Five distinct non-genesis versions, none yet queued -- the old loop
    // shape cost 1 (whole-table SELECT) + 5 (one INSERT per version) = 6
    // subrequests here; the set-based INSERT ... SELECT costs exactly 1.
    // Seeded via d1.raw, uncounted (fixture scaffolding, not code under test).
    for (let i = 0; i < 5; i++) seedFakePriorVersion(d1, { changed_by: "operator", first_seen_at: 1000 + i });
    const runId = d1.raw.prepare("INSERT INTO maintainer_runs (kind, started_at) VALUES ('judgment', ?)").run(Date.now()).lastInsertRowid;
    const env = testEnv(d1);

    const result = await reconcileConstitutionFidelityQueue(env, Number(runId), Date.now());

    assert.equal(result.queued, 5, "all five non-genesis versions get their fidelity row");
    assert.equal(result.error, null);
    assert.equal(counter.fetches(), 0, "reconciliation makes no outbound fetch");
    assert.equal(
      counter.d1(),
      1,
      "ONE D1 statement for five versions -- the whole-table read moved INSIDE the insert. The old 1-per-version loop would report 6 here, so this catches a per-row regression.",
    );
  } finally {
    counter.restore();
    d1.close();
  }
});

// ---------- listConstitutionVersions ----------

test("listConstitutionVersions: total/returned/has_more, and mandate_proposal_ids parses back to a real array", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    seedFakePriorVersion(d1, { mandate_proposal_ids: "[7,9]", first_seen_at: 1000 });
    seedFakePriorVersion(d1, { changed_by: "operator", first_seen_at: 2000 });

    const page = await listConstitutionVersions(env);
    assert.equal(page.total, 2);
    assert.equal(page.returned, 2);
    assert.equal(page.has_more, false);
    assert.equal(page.next_since, undefined);
    const first = page.versions.find((v) => v.first_seen_at === 1000);
    assert.deepEqual(first!.mandate_proposal_ids, [7, 9]);
  } finally {
    d1.close();
  }
});

test("listConstitutionVersions: pagination cursor (since/since_id) actually filters, and a page-boundary millisecond tie is not silently dropped", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const idA = seedFakePriorVersion(d1, { first_seen_at: 1000 });
    seedFakePriorVersion(d1, { first_seen_at: 1000 }); // same millisecond as A -- the tie-break case
    seedFakePriorVersion(d1, { first_seen_at: 2000 });

    const firstPage = await listConstitutionVersions(env, NaN, NaN);
    assert.equal(firstPage.total, 3);

    // Ask for everything strictly after id A's own (first_seen_at, id) --
    // must return the OTHER same-millisecond row plus the later one, not
    // silently drop the tie the way a first_seen_at-only cursor would.
    const rest = await listConstitutionVersions(env, 1000, idA);
    assert.equal(rest.returned, 2);
  } finally {
    d1.close();
  }
});
