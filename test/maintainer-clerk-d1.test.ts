// D1-backed tests for clerk.ts's own I-007 wiring (docs/BRIEF-FIRST-LAWS.md
// commit 4; commission notes flag 5): constitution detection and wake-side
// fidelity reconciliation, both run unconditionally before the API-key
// gate, bound to the wake's OWN reserved run_id. runClerkWake itself has
// no OTHER automated D1 coverage in this repo (test/maintainer-clerk.test.ts's
// own header: "accepted as manual/local-D1 coverage only") -- this file
// exists specifically for the new wiring, not a general reopening of that
// precedent.
//
// No network: every fixture here has no ANTHROPIC_API_KEY, so runClerkWake
// always takes the "no api key" branch immediately after the new
// constitution wiring runs -- this repo's own convention (test/maintainer-anthropic.test.ts,
// test/maintainer-clerk.test.ts headers) is no network in this suite.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, insertCitizen, type LocalD1 } from "./helpers/local-d1.ts";
import { runClerkWake } from "../src/maintainer/clerk.ts";
import type { Env } from "../src/society.ts";
import type { ConstitutionCache } from "../src/governance.ts";

// citizen #1 inserted first in a fresh DB is autoincrement id 1, matching
// the real MAINTAINER_ID -- the chained constitution_changed event (a
// non-genesis detection) hard-requires a real citizen_id FK.
function seedMaintainer(d1: LocalD1): number {
  const id = insertCitizen(d1, { handle: "commonhold-agent", model: "claude-fable-5" });
  assert.equal(id, 1, "test setup invariant: the maintainer must be citizen #1 (first insert into a fresh DB)");
  return id;
}

// A fresh cache per test -- the module-level default is a PROCESS-wide
// singleton shared by every test() in this file's one process (Node's
// test runner isolates each FILE, not each test() within it), even
// though each test here uses its own, unrelated local-D1 database.
function freshConstitutionCache(): ConstitutionCache {
  return { pairKey: null, versionRow: null };
}

function latestClerkRun(d1: LocalD1): { id: number; error: string | null; skipped_reason: string | null; overflow_dropped: number } {
  return d1.raw.prepare("SELECT * FROM maintainer_runs WHERE kind = 'clerk' ORDER BY id DESC LIMIT 1").get() as {
    id: number;
    error: string | null;
    skipped_reason: string | null;
    overflow_dropped: number;
  };
}

test("runClerkWake: genesis constitution detection runs even with no API key, and lands under the SAME run row skipped_reason/error are written to", async () => {
  const d1 = createLocalD1();
  try {
    seedMaintainer(d1);
    const env = { DB: d1.DB } as unknown as Env; // no ANTHROPIC_API_KEY
    await runClerkWake(env, freshConstitutionCache());

    const versions = d1.raw.prepare("SELECT changed_by FROM constitution_versions").all() as Array<{ changed_by: string }>;
    assert.equal(versions.length, 1, "the wake's own detection call lands genesis");
    assert.equal(versions[0].changed_by, "genesis");

    const run = latestClerkRun(d1);
    assert.equal(run.skipped_reason, "no api key");
    assert.equal(run.error, null, "a clean genesis detection must not manufacture an error on an otherwise healthy skip");

    const fidelityRows = d1.raw.prepare("SELECT COUNT(*) AS n FROM maintainer_queue WHERE kind = 'constitution_fidelity'").get() as { n: number };
    assert.equal(fidelityRows.n, 0, "genesis is excluded from fidelity reconciliation");
  } finally {
    d1.close();
  }
});

test("runClerkWake: a non-genesis constitution change queues its own fidelity row bound to THIS wake's real run_id", async () => {
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

    const env = { DB: d1.DB } as unknown as Env; // no ANTHROPIC_API_KEY
    await runClerkWake(env, freshConstitutionCache());

    const thisRun = latestClerkRun(d1);
    assert.equal(thisRun.skipped_reason, "no api key");
    assert.equal(thisRun.error, null);

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
    assert.equal(fidelityRow.run_id, thisRun.id, "bound to THIS wake's own run_id");
    assert.equal(fidelityRow.source_ref, `constitution_versions:${versions[0].id}`);
    assert.equal(fidelityRow.status, "pending");
  } finally {
    d1.close();
  }
});

test("runClerkWake: an exhausted/invariant-violation-shaped detection outcome surfaces into the run row's error field, never silently swallowed", async () => {
  const d1 = createLocalD1();
  try {
    seedMaintainer(d1);
    // A non-empty archive first -- genesis detection uses a single
    // prepare().run(), never batch(), so sabotaging batch() alone would
    // never fire on a fresh/empty archive. A seeded prior version forces
    // detection down the non-genesis path, which does batch().
    d1.raw
      .prepare(
        "INSERT INTO constitution_versions (template_hash, parameters_hash, full_text, parameters_text, first_seen_at, changed_by, mandate_proposal_ids) VALUES (?, ?, ?, ?, ?, 'genesis', '[]')",
      )
      .run("fake-prior-hash-1", "fake-prior-hash-2", "fake", "fake", Date.now());

    // Force detection to throw by handing runClerkWake a DB wrapper whose
    // batch() always rejects -- detectConstitutionChange's own try/catch
    // around env.DB.batch only re-throws non-UNIQUE errors, so this
    // reaches runClerkWake's own outer catch around the whole
    // detection+reconciliation block.
    const throwingEnv = {
      DB: {
        prepare: (sql: string) => d1.DB.prepare(sql),
        batch: () => {
          throw new Error("simulated: batch transport failure");
        },
      },
    } as unknown as Env;

    await runClerkWake(throwingEnv, freshConstitutionCache());

    const run = latestClerkRun(d1);
    assert.equal(run.skipped_reason, "no api key");
    assert.notEqual(run.error, null, "a thrown detection/reconciliation failure must reach the run row, not be silently swallowed");
    assert.match(run.error ?? "", /constitution detection\/reconciliation threw/);
  } finally {
    d1.close();
  }
});
