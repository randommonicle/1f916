// D1-backed tests for governance.ts's founder/founding-ratification
// derivation, the ballot-casting concurrency behaviours design doc §13
// item 3 names explicitly, the sweep (§13 item 4: idempotency, the
// double-claimant race, execution batch atomicity, dry-key operation),
// and society.ts's officialFacts() reading governance_settings for the
// current name and dividend rate (§8, §13 item 6). officialFacts() lives
// in society.ts, not governance.ts, but it is tested here alongside
// everything else that needs the same real-D1 fixtures rather than a
// third D1 test file for a handful of cases.
// Uses test/helpers/local-d1.ts (node:sqlite, the real schema.sql, no new
// dependency) rather than a mock -- these are all D1-dependent behaviours
// no pure-function test can exercise honestly.
//
// Everything else governance.ts's D1-touching functions do (the ordinary
// happy paths of listProposals/getProposalDetail, most of createProposal's
// validation ordering) remains accepted manual-smoke coverage, the same
// precedent wallets.ts/payouts.ts/register-gate.ts set -- this file does
// not reopen that precedent, it covers exactly what was named plus the
// one novel pattern (createProposal's compensating delete) that has no
// prior art to lean on and is cheap to prove directly.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, insertCitizen, insertIdentityEvent, insertProposal, type LocalD1 } from "./helpers/local-d1.ts";
import { isFounderCitizen, isFoundingRatified, castBallot, createProposal, runGovernanceSweep, monthsFromNow, listProposals, PROPOSAL_PAGE } from "../src/governance.ts";
import {
  SocietyError,
  officialFacts,
  SETTING_KEY,
  DEFAULT_NAME,
  DEFAULT_DIVIDEND_PERCENT,
  DEFAULT_CONTROL_FLOOR_PERCENT,
  DEFAULT_SPLIT,
  citizenDirectory,
  CITIZEN_PAGE,
} from "../src/society.ts";
import type { Env } from "../src/society.ts";
import { verifyRows, appendChained, type ChainRow } from "../src/chain.ts";

function testEnv(d1: ReturnType<typeof createLocalD1>, registrationMode = "invite_only"): Env {
  return {
    DB: d1.DB,
    TREASURY_ADDRESS: "0x0",
    FACILITATOR_URL: "https://facilitator.example.invalid",
    REGISTRATION_MODE: registrationMode,
  } as Env;
}

// ---------- isFounderCitizen ----------

test("isFounderCitizen: true iff the citizen has an identity_events row of kind invite_redeemed", async () => {
  const d1 = createLocalD1();
  try {
    const founder = insertCitizen(d1);
    const nonFounder = insertCitizen(d1);
    insertIdentityEvent(d1, founder, "invite_redeemed", "somehash");
    insertIdentityEvent(d1, nonFounder, "key_rotation", "custody changed"); // has a row, just the wrong kind
    const env = testEnv(d1);
    assert.equal(await isFounderCitizen(env, founder), true);
    assert.equal(await isFounderCitizen(env, nonFounder), false);
  } finally {
    d1.close();
  }
});

test("isFounderCitizen: a citizen with no identity_events rows at all is not a founder", async () => {
  const d1 = createLocalD1();
  try {
    const citizen = insertCitizen(d1);
    assert.equal(await isFounderCitizen(testEnv(d1), citizen), false);
  } finally {
    d1.close();
  }
});

test("isFounderCitizen: one citizen's invite_redeemed row does not make a different citizen a founder", async () => {
  const d1 = createLocalD1();
  try {
    const founder = insertCitizen(d1);
    const other = insertCitizen(d1);
    insertIdentityEvent(d1, founder, "invite_redeemed");
    assert.equal(await isFounderCitizen(testEnv(d1), other), false);
  } finally {
    d1.close();
  }
});

// ---------- isFoundingRatified ----------

test("isFoundingRatified: false with no proposals, false while open or failed, true once passed", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    assert.equal(await isFoundingRatified(env, "set_name"), false);
    insertProposal(d1, { kind: "set_name", status: "open" });
    assert.equal(await isFoundingRatified(env, "set_name"), false);
    insertProposal(d1, { kind: "set_name", status: "failed" });
    assert.equal(await isFoundingRatified(env, "set_name"), false);
    insertProposal(d1, { kind: "set_name", status: "passed" });
    assert.equal(await isFoundingRatified(env, "set_name"), true);
  } finally {
    d1.close();
  }
});

test("isFoundingRatified: 'executed' also counts, and ratification is permanent -- a later failed proposal of the same kind does not un-ratify it", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    insertProposal(d1, { kind: "text_amendment", status: "executed" });
    assert.equal(await isFoundingRatified(env, "text_amendment"), true);
    insertProposal(d1, { kind: "text_amendment", status: "failed" });
    assert.equal(await isFoundingRatified(env, "text_amendment"), true);
  } finally {
    d1.close();
  }
});

test("isFoundingRatified: independent per kind -- a passed set_name does not ratify text_amendment", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    insertProposal(d1, { kind: "set_name", status: "passed" });
    assert.equal(await isFoundingRatified(env, "set_name"), true);
    assert.equal(await isFoundingRatified(env, "text_amendment"), false);
  } finally {
    d1.close();
  }
});

// ---------- castBallot ----------

test("castBallot: a second ballot from the same citizen on the same proposal is refused with a clean message, not appendChained's generic exhaustion error (the UNIQUE-collision second-ballot refusal, design doc §13 item 3)", async () => {
  const d1 = createLocalD1();
  try {
    const proposalId = insertProposal(d1, { kind: "resolution", status: "open" });
    const citizenId = insertCitizen(d1);
    const env = testEnv(d1);
    const citizen = { id: citizenId, created_at: Date.now() };

    const first = await castBallot(env, citizen, proposalId, "yes");
    assert.equal(first.choice, "yes");

    await assert.rejects(
      () => castBallot(env, citizen, proposalId, "no"),
      (e: unknown) => e instanceof SocietyError && e.status === 409 && /already cast/.test(e.message),
    );

    const { results } = await d1.DB.prepare("SELECT choice FROM ballots WHERE proposal_id = ? AND citizen_id = ?")
      .bind(proposalId, citizenId)
      .all<{ choice: string }>();
    assert.equal(results.length, 1, "exactly one ballot landed, not two and not zero");
    assert.equal(results[0].choice, "yes", "the refused second attempt did not overwrite the first");
  } finally {
    d1.close();
  }
});

test("castBallot: F4 -- a same-citizen double-vote that races past the pre-check is refused with 409 'already voted', not four wasted retries ending in a false 503 (hardening-2, docs/REVIEW-CHAINGATE-2026-08-09.md finding 4)", async () => {
  const d1 = createLocalD1();
  try {
    const proposalId = insertProposal(d1, { kind: "resolution", status: "open" });
    const citizenId = insertCitizen(d1);
    const env = testEnv(d1);
    const citizen = { id: citizenId, created_at: Date.now() };

    // A competing ballot for the SAME (proposal, citizen) pair lands
    // between castBallot's own pre-check (which sees nothing yet, since
    // neither write has landed) and this call's actual INSERT --
    // appendChained is chain.ts's own real writer, so the competing row
    // is validly sealed and the resulting collision on ballots' real
    // idx_ballots_proposal_citizen index is the genuine article, not
    // simulated. Verified directly against real node:sqlite before
    // trusting this design (scratch probe, not committed): when a single
    // INSERT would violate both idx_ballots_prev AND
    // idx_ballots_proposal_citizen at once, SQLite as probed reports only
    // "UNIQUE constraint failed: ballots.prev_hash" -- an
    // index-CREATION-ORDER consequence of schema.sql, not an engine
    // property (gate finding 6, docs/REVIEW-HARDENING2-GATE-2026-08-10.md:
    // reversing the creation order makes the same double-violation name
    // the proposal_id+citizen_id pair instead). Under today's order the
    // report classifies chain_head, so this specific race retries ONCE
    // (attempt 0) before attempt 1's fresh head-read makes the prev_hash
    // collision impossible and the remaining proposal_id+citizen_id
    // collision reports alone, unambiguously classified duplicate_vote;
    // under a flipped order the pair would classify duplicate_vote on
    // attempt 0 directly. Either way the final, observable outcome is the
    // same: a 409, never a 503, and never four attempts exhausted --
    // which is what this test asserts, not the internal attempt count or
    // the non-contractual report ordering.
    const raceEnv = {
      ...env,
      DB: withChainedHeadReadTriggering(d1.DB, "ballots", () =>
        appendChained(d1.DB, "ballots", { proposal_id: proposalId, citizen_id: citizenId, choice: "no", cast_at: Date.now() }),
      ),
    };

    await assert.rejects(
      () => castBallot(raceEnv, citizen, proposalId, "yes"),
      (e: unknown) => e instanceof SocietyError && e.status === 409 && /already cast/i.test(e.message),
    );

    const { results } = await d1.DB.prepare("SELECT choice FROM ballots WHERE proposal_id = ? AND citizen_id = ?")
      .bind(proposalId, citizenId)
      .all<{ choice: string }>();
    assert.equal(results.length, 1, "exactly one ballot landed -- the race loser's own attempt never wrote a second row");
    assert.equal(results[0].choice, "no", "the ballot that actually raced in first is the one that persists");
  } finally {
    d1.close();
  }
});

test("castBallot: F5 -- when the sweep's gate refusal overlaps a ballot that ALSO already landed for this citizen, the 409 names both facts (hardening-2, docs/REVIEW-CHAINGATE-2026-08-09.md finding 5)", async () => {
  const d1 = createLocalD1();
  try {
    const proposer = insertCitizen(d1);
    const now = Date.now();
    const closesAt = now + 3_600_000; // stays "open" by clock alone; only the sweep's own claim closes it
    const proposalId = insertProposal(d1, { kind: "resolution", status: "open", proposer_id: proposer, opened_at: now - 8 * 86_400_000, closes_at: closesAt });
    // Filler vote so the tally has something to disagree with -- the
    // actual pass/fail outcome is irrelevant to this test, only that the
    // sweep closes the proposal (moves it off 'open').
    const filler = insertCitizen(d1);
    castNo(d1, proposalId, filler, now - 2000);

    const voter = insertCitizen(d1);
    const voterCitizen = { id: voter, created_at: now - 30 * 86_400_000 };
    const sweepEnv = testEnv(d1);
    const sweepNow = closesAt + 1000; // due the instant the sweep runs

    // Between this call's own pre-check (sees nothing yet) and its
    // INSERT, TWO things land in sequence: this SAME citizen's ballot
    // from some other already-in-flight request (appendChained, a validly
    // sealed row -- standing in for "the citizen's own earlier concurrent
    // attempt won the race"), then the sweep claims and closes the
    // proposal. By the time this call's own INSERT attempts to run, both
    // are true: the gate refuses (status no longer 'open') AND this
    // citizen already holds a ballot row -- docs/REVIEW-CHAINGATE-2026-08-09.md's
    // own framing of F5 exactly ("a citizen double-votes concurrently
    // exactly as the sweep runs and closes the proposal").
    const raceEnv = {
      ...testEnv(d1),
      DB: withChainedHeadReadTriggering(d1.DB, "ballots", async () => {
        await appendChained(d1.DB, "ballots", { proposal_id: proposalId, citizen_id: voter, choice: "yes", cast_at: now - 100 });
        await runGovernanceSweep(sweepEnv, sweepNow);
      }),
    };

    await assert.rejects(
      () => castBallot(raceEnv, voterCitizen, proposalId, "yes"),
      (e: unknown) => e instanceof SocietyError && e.status === 409 && /no longer open/.test(e.message) && /already cast/i.test(e.message),
    );

    const { results } = await d1.DB.prepare("SELECT choice FROM ballots WHERE proposal_id = ? AND citizen_id = ?")
      .bind(proposalId, voter)
      .all<{ choice: string }>();
    assert.equal(results.length, 1, "only the ballot that actually landed during the race persists -- the refused call wrote nothing");
  } finally {
    d1.close();
  }
});

// The F3 driver anomaly, at the single-statement layer this time (the
// batch-layer sibling is withChangesStrippedBatch below): the ballots
// INSERT really executes against real SQLite, but its run() report comes
// back with `changes` absent -- a driver that stops reporting, not a
// write that stops writing. appendChainedGated then fails closed
// (returns null, chain.ts F3) even though the row landed.
function withChangesStrippedRun(DB: LocalD1["DB"], table: string): LocalD1["DB"] {
  const insertPattern = new RegExp(`^\\s*INSERT INTO ${table}\\b`, "i");
  const strip = (meta: Record<string, unknown>) => Object.fromEntries(Object.entries(meta).filter(([k]) => k !== "changes"));
  return {
    prepare: (sql: string) => {
      const real = DB.prepare(sql);
      if (!insertPattern.test(sql)) return real;
      const wrapRun = (stmt: ReturnType<LocalD1["DB"]["prepare"]>) => ({
        ...stmt,
        bind: (...args: unknown[]) => wrapRun(stmt.bind(...args)),
        async run() {
          const result = (await stmt.run()) as { meta: Record<string, unknown> };
          return { ...result, meta: strip(result.meta) } as never;
        },
      });
      return wrapRun(real);
    },
    batch: (stmts) => DB.batch(stmts),
  };
}

test("castBallot: gate finding 4 -- when the F3 anomaly makes the gate refuse a ballot that actually landed, the 409 does not cite this call's own write as an 'already cast' prior ballot (docs/REVIEW-HARDENING2-GATE-2026-08-10.md)", async () => {
  const d1 = createLocalD1();
  try {
    const proposer = insertCitizen(d1);
    const now = Date.now();
    const proposalId = insertProposal(d1, { kind: "resolution", status: "open", proposer_id: proposer, opened_at: now - 8 * 86_400_000, closes_at: now + 3_600_000 });
    const voter = insertCitizen(d1);

    const env = { ...testEnv(d1), DB: withChangesStrippedRun(d1.DB, "ballots") };
    await assert.rejects(
      () => castBallot(env, { id: voter, created_at: now - 30 * 86_400_000 }, proposalId, "yes"),
      (e: unknown) => {
        assert.ok(e instanceof SocietyError && e.status === 409);
        const err = e as SocietyError;
        // Pre-fix, this message carried three false statements at once
        // (the gate record's own reproduction): the proposal is open, the
        // ballot WAS recorded, and the "already cast" clause cited the
        // row this very call just wrote. The clause is the one F5 exists
        // to make accurate, so it must not fire on the call's own write;
        // the closure sentence's own inaccuracy under this anomaly is a
        // separate, adjudicated non-change (gate finding 3's disposition:
        // fail-closed reporting under a lying driver is the accepted
        // conservative posture).
        assert.doesNotMatch(err.message, /already cast/i, "the call's own write must never be served back as a prior ballot");
        return true;
      },
    );

    const { results } = await d1.DB.prepare("SELECT choice FROM ballots WHERE proposal_id = ? AND citizen_id = ?")
      .bind(proposalId, voter)
      .all<{ choice: string }>();
    assert.equal(results.length, 1, "fixture sanity: the write really did land underneath the degraded report");
    const row = await d1.DB.prepare("SELECT status FROM proposals WHERE id = ?").bind(proposalId).first<{ status: string }>();
    assert.equal(row!.status, "open", "fixture sanity: the proposal never left 'open' -- the refusal came from the degraded report, not a real closure");
  } finally {
    d1.close();
  }
});

test("castBallot: two different citizens racing to vote on the same proposal both succeed, and the resulting chain is valid with neither vote lost (the two-writer append race, design doc §13 item 3)", async () => {
  const d1 = createLocalD1();
  try {
    const proposalId = insertProposal(d1, { kind: "resolution", status: "open" });
    const c1 = insertCitizen(d1);
    const c2 = insertCitizen(d1);
    const env = testEnv(d1);

    const [r1, r2] = await Promise.all([
      castBallot(env, { id: c1, created_at: Date.now() }, proposalId, "yes"),
      castBallot(env, { id: c2, created_at: Date.now() }, proposalId, "no"),
    ]);
    assert.notEqual(r1.chain_head, r2.chain_head, "two distinct appends must not collapse to the same head");

    const { results: rows } = await d1.DB.prepare(
      "SELECT id, proposal_id, citizen_id, choice, cast_at, prev_hash, hash FROM ballots WHERE proposal_id = ? ORDER BY id ASC",
    )
      .bind(proposalId)
      .all<ChainRow>();
    assert.equal(rows.length, 2, "both racing writes landed as rows, neither silently dropped");

    const report = await verifyRows("ballots", rows);
    assert.equal(report.ok, true, "the two racing ballots must form one valid chain, not two forks");
    assert.equal(report.sealed_entries, 2);

    const citizenIds = rows.map((r) => r.citizen_id).sort();
    assert.deepEqual(citizenIds, [c1, c2].sort(), "both citizens' actual votes are present, not just two rows of some kind");
  } finally {
    d1.close();
  }
});

test("castBallot: a proposal that is not open (already tallying/passed/failed/executed) refuses with 409", async () => {
  const d1 = createLocalD1();
  try {
    const proposalId = insertProposal(d1, { kind: "resolution", status: "passed" });
    const citizenId = insertCitizen(d1);
    const env = testEnv(d1);
    await assert.rejects(
      () => castBallot(env, { id: citizenId, created_at: Date.now() }, proposalId, "yes"),
      (e: unknown) => e instanceof SocietyError && e.status === 409,
    );
  } finally {
    d1.close();
  }
});

test("castBallot: a nonexistent proposal id refuses with 404", async () => {
  const d1 = createLocalD1();
  try {
    const citizenId = insertCitizen(d1);
    const env = testEnv(d1);
    await assert.rejects(
      () => castBallot(env, { id: citizenId, created_at: Date.now() }, 999999, "yes"),
      (e: unknown) => e instanceof SocietyError && e.status === 404,
    );
  } finally {
    d1.close();
  }
});

test("castBallot: end to end, a non-founder cannot vote on an unratified set_name proposal but a founder can (founding carve-out composed through real derivation, not just asserted in isolation)", async () => {
  const d1 = createLocalD1();
  try {
    const proposalId = insertProposal(d1, { kind: "set_name", status: "open" });
    const founder = insertCitizen(d1);
    insertIdentityEvent(d1, founder, "invite_redeemed");
    const nonFounder = insertCitizen(d1);
    const env = testEnv(d1);

    await assert.rejects(
      () => castBallot(env, { id: nonFounder, created_at: Date.now() }, proposalId, "yes"),
      (e: unknown) => e instanceof SocietyError && e.status === 403,
    );
    const ok = await castBallot(env, { id: founder, created_at: Date.now() }, proposalId, "yes");
    assert.equal(ok.choice, "yes");
  } finally {
    d1.close();
  }
});

// ---------- createProposal ----------

test("createProposal: creates the proposal row and a linked debate post titled 'Proposal #N: <title>'", async () => {
  const d1 = createLocalD1();
  try {
    const citizenId = insertCitizen(d1, { handle: "proposer-one" });
    const citizen = { id: citizenId, handle: "proposer-one", model: "test-model", karma: 0, created_at: Date.now() - 30 * 86_400_000, last_seen_at: Date.now() };
    const env = testEnv(d1);

    const result = await createProposal(env, citizen, "resolution", "Adopt a mascot", "The society should have a mascot.", null);
    assert.equal(result.kind, "resolution");
    assert.equal(result.class, "advisory");

    const post = await d1.DB.prepare("SELECT id, title, body, citizen_id FROM posts WHERE id = ?").bind(result.post_id).first<{ id: number; title: string; body: string; citizen_id: number }>();
    assert.ok(post, "the debate post must exist");
    assert.equal(post!.title, `Proposal #${result.proposal_id}: Adopt a mascot`);
    assert.equal(post!.body, "The society should have a mascot.");
    assert.equal(post!.citizen_id, citizenId);

    const proposal = await d1.DB.prepare("SELECT post_id, status FROM proposals WHERE id = ?").bind(result.proposal_id).first<{ post_id: number; status: string }>();
    assert.equal(proposal!.post_id, result.post_id, "the proposal row must be linked back to its debate post, not left NULL");
    assert.equal(proposal!.status, "open");
  } finally {
    d1.close();
  }
});

test("createProposal: rate cap refuses a second open proposal from the same citizen", async () => {
  const d1 = createLocalD1();
  try {
    const citizenId = insertCitizen(d1, { handle: "serial-proposer" });
    const citizen = { id: citizenId, handle: "serial-proposer", model: "test-model", karma: 0, created_at: Date.now() - 30 * 86_400_000, last_seen_at: Date.now() };
    const env = testEnv(d1);

    await createProposal(env, citizen, "resolution", "First proposal", "First body text here.", null);
    await assert.rejects(
      () => createProposal(env, citizen, "resolution", "Second proposal", "Second body text here.", null),
      (e: unknown) => e instanceof SocietyError && e.status === 429,
    );
  } finally {
    d1.close();
  }
});

test("createProposal: if the debate post fails to create (daily post cap already spent), no orphan proposal row is left behind", async () => {
  const d1 = createLocalD1();
  try {
    const citizenId = insertCitizen(d1, { handle: "capped-citizen" });
    const citizen = { id: citizenId, handle: "capped-citizen", model: "test-model", karma: 0, created_at: Date.now() - 30 * 86_400_000, last_seen_at: Date.now() };
    const env = testEnv(d1);

    // Spend today's one post directly (bypassing createProposal), so the
    // debate post createProposal tries to make next is guaranteed to hit
    // the ordinary daily cap createPost enforces -- exactly the failure
    // mode the compensating delete exists for.
    const now = Date.now();
    d1.raw
      .prepare("INSERT INTO posts (citizen_id, title, body, dupe_hash, pinned, author_model, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)")
      .run(citizenId, "an ordinary post spent today", "nothing to do with governance", "unrelated-dupe-hash", "test-model", now);

    const before = await d1.DB.prepare("SELECT COUNT(*) AS n FROM proposals").first<{ n: number }>();

    await assert.rejects(() => createProposal(env, citizen, "resolution", "Should not survive", "This proposal's post creation must fail.", null));

    const after = await d1.DB.prepare("SELECT COUNT(*) AS n FROM proposals").first<{ n: number }>();
    assert.equal(after!.n, before!.n, "the failed attempt must leave the proposals table exactly as it found it -- no half-formed row");
  } finally {
    d1.close();
  }
});

// ---------- M1: the ballot-in-the-window attack (docs/REVIEW-DEMOCRACY.md) ----------

test("castBallot: M1 reproduction -- a proposal whose debate post has not landed yet (post_id IS NULL) refuses every ballot with 409, leaving zero ballot rows", async () => {
  const d1 = createLocalD1();
  try {
    const proposer = insertCitizen(d1);
    const voter = insertCitizen(d1);
    const now = Date.now();
    // Exactly the window the review's own reproduction landed a ballot
    // in: a proposal row that exists and is 'open', but has no debate
    // post -- reachable during createProposal's own brief gap before
    // this fix (an attacker polling GET /api/proposals for the
    // just-inserted id), or left behind by any other failure this
    // commit's compensating-delete hardening did not anticipate.
    const proposalId = insertProposal(d1, { kind: "resolution", status: "open", proposer_id: proposer, post_id: null });

    const env = testEnv(d1);
    await assert.rejects(
      () => castBallot(env, { id: voter, created_at: now }, proposalId, "yes"),
      (e: unknown) => e instanceof SocietyError && e.status === 409 && /debate post is still being created/.test(e.message),
    );

    const ballotCount = await d1.DB.prepare("SELECT COUNT(*) AS n FROM ballots WHERE proposal_id = ?").bind(proposalId).first<{ n: number }>();
    assert.equal(ballotCount!.n, 0, "the attack this closes is a ballot landing on a postless proposal -- zero rows, not just a refused response");
  } finally {
    d1.close();
  }
});

test("castBallot: a proposal with a real linked debate post (the ordinary case) is unaffected by the post_id gate", async () => {
  const d1 = createLocalD1();
  try {
    const proposer = insertCitizen(d1);
    const voter = insertCitizen(d1);
    const now = Date.now();
    const proposalId = insertProposal(d1, { kind: "resolution", status: "open", proposer_id: proposer }); // post_id auto-created by the fixture
    const env = testEnv(d1);
    const result = await castBallot(env, { id: voter, created_at: now }, proposalId, "yes");
    assert.equal(result.choice, "yes");
  } finally {
    d1.close();
  }
});

// Minimal wrapper matching withFailingBatch's own shape (above), but for
// a specific statement text rather than .batch() -- used only to prove
// docs/REVIEW-DEMOCRACY.md M1's second fix (the compensating delete's
// own failure must never mask the original createPost error). No real
// data-driven path can trigger the delete's failure any more (the
// ballot-FK route this originally reproduced through is closed by the
// gate above), so this is deliberately a forced, not a discovered,
// failure -- proving the defence-in-depth behaves correctly even though
// nothing in this codebase today can reach it honestly.
function withFailingDelete(DB: LocalD1["DB"]): LocalD1["DB"] {
  return {
    prepare: (sql: string) => {
      const real = DB.prepare(sql);
      if (!/^\s*DELETE FROM proposals/i.test(sql)) return real;
      return {
        ...real,
        bind: (...args: unknown[]) => {
          const boundReal = real.bind(...args);
          return {
            ...boundReal,
            async run() {
              throw new Error("simulated: delete blocked by something else entirely");
            },
          };
        },
      };
    },
    batch: (stmts) => DB.batch(stmts),
  };
}

test("createProposal: M1's second fix -- if the compensating delete itself throws, the ORIGINAL createPost error is what the caller sees, never the delete's, and the failure is logged loudly", async () => {
  const d1 = createLocalD1();
  const originalConsoleLog = console.log;
  const logged: string[] = [];
  console.log = (msg: string) => logged.push(msg);
  try {
    const citizenId = insertCitizen(d1, { handle: "capped-citizen-2" });
    const citizen = { id: citizenId, handle: "capped-citizen-2", model: "test-model", karma: 0, created_at: Date.now() - 30 * 86_400_000, last_seen_at: Date.now() };
    const now = Date.now();
    d1.raw
      .prepare("INSERT INTO posts (citizen_id, title, body, dupe_hash, pinned, author_model, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)")
      .run(citizenId, "an ordinary post spent today", "nothing to do with governance", "unrelated-dupe-hash-2", "test-model", now);

    const env = { ...testEnv(d1), DB: withFailingDelete(d1.DB) };

    await assert.rejects(
      () => createProposal(env, citizen, "resolution", "Should not survive either", "This proposal's post creation must fail, and so must its own cleanup.", null),
      (e: unknown) => {
        // The ORIGINAL error (createPost's daily-cap refusal), not the
        // delete's "simulated: delete blocked by something else
        // entirely" -- that string must never reach the caller.
        assert.ok(e instanceof SocietyError);
        assert.match((e as SocietyError).message, /Daily post spent/);
        return true;
      },
    );

    assert.ok(
      logged.some((l) => l.includes("proposal_compensating_delete_failed") && l.includes("simulated: delete blocked")),
      "the delete's own failure must still be logged loudly, even though it is not what the caller sees",
    );
  } finally {
    console.log = originalConsoleLog;
    d1.close();
  }
});

// ---------- runGovernanceSweep ----------

function castYes(d1: ReturnType<typeof createLocalD1>, proposalId: number, citizenId: number, castAt: number) {
  d1.raw.prepare("INSERT INTO ballots (proposal_id, citizen_id, choice, cast_at) VALUES (?, ?, 'yes', ?)").run(proposalId, citizenId, castAt);
}

function castNo(d1: ReturnType<typeof createLocalD1>, proposalId: number, citizenId: number, castAt: number) {
  d1.raw.prepare("INSERT INTO ballots (proposal_id, citizen_id, choice, cast_at) VALUES (?, ?, 'no', ?)").run(proposalId, citizenId, castAt);
}

// docs/REVIEW-DEMOCRACY.md H1's reproduction, real, not simulated: wraps
// a real D1Like so its first `failCount` calls to .batch() throw exactly
// the review's own transient error message, then delegate to the real
// implementation from then on. .prepare() (the claim UPDATE, the reads)
// passes straight through untouched, so only commitOutcome's own batch
// call is ever affected -- the claim itself always succeeds, matching
// the review's own reproduction shape precisely.
function withFailingBatch(DB: LocalD1["DB"], failCount: number): LocalD1["DB"] {
  let calls = 0;
  return {
    prepare: (sql: string) => DB.prepare(sql),
    async batch<T = unknown>(stmts: Parameters<LocalD1["DB"]["batch"]>[0]): Promise<T[]> {
      calls++;
      if (calls <= failCount) throw new Error("Network connection lost.");
      return DB.batch(stmts) as Promise<T[]>;
    },
  };
}

test("runGovernanceSweep: an advisory proposal that passes lands as 'passed' with a chained proposal_decided event, no settings write", async () => {
  const d1 = createLocalD1();
  try {
    const proposer = insertCitizen(d1);
    const now = Date.now();
    const proposalId = insertProposal(d1, { kind: "resolution", status: "open", proposer_id: proposer, opened_at: now - 8 * 86_400_000, closes_at: now - 1000 });
    const voter = insertCitizen(d1);
    castYes(d1, proposalId, voter, now - 2000);

    const env = testEnv(d1);
    const result = await runGovernanceSweep(env, now);
    assert.equal(result.due, 1);
    assert.equal(result.results[0].outcome, "passed");

    const row = await d1.DB.prepare("SELECT status, tally_yes, tally_no, tally_abstain, eligible_count FROM proposals WHERE id = ?")
      .bind(proposalId)
      .first<{ status: string; tally_yes: number; eligible_count: number }>();
    assert.equal(row!.status, "passed");
    assert.equal(row!.tally_yes, 1);
    assert.equal(row!.eligible_count, 2, "proposer + voter, both eligible in invite_only mode");

    const event = await d1.DB.prepare("SELECT detail FROM identity_events WHERE kind = 'proposal_decided'").first<{ detail: string }>();
    assert.ok(event, "the outcome must land in identity_events");
    assert.match(event!.detail, /proposal \d+ \(resolution\) passed/);

    const settings = await d1.DB.prepare("SELECT COUNT(*) AS n FROM governance_settings").first<{ n: number }>();
    assert.equal(settings!.n, 0, "a mandate kind's pass never writes governance_settings");
  } finally {
    d1.close();
  }
});

// Finding A of the fixes-pass diff review
// (exchange/REVIEW_hardening2-fixespass_2026-08-10.md): commitOutcome's own
// batch guard must fail CLOSED on an absent `changes`, exactly as
// appendChainedGated learned to in the same wave (chain.ts, F3). Wraps the
// real batch so its results' meta lack `changes` -- the write itself still
// happens underneath (real SQLite), only the REPORT is degraded, which is
// the precise scenario guarded against: a driver that stops reporting, not
// a write that stops writing. prepare() passes straight through, so the
// claim UPDATE and every read are untouched.
function withChangesStrippedBatch(DB: LocalD1["DB"]): LocalD1["DB"] {
  return {
    prepare: (sql: string) => DB.prepare(sql),
    async batch<T = unknown>(stmts: Parameters<LocalD1["DB"]["batch"]>[0]): Promise<T[]> {
      const results = (await DB.batch(stmts)) as Array<{ meta?: Record<string, unknown> }>;
      return results.map((r) => ({ ...r, meta: Object.fromEntries(Object.entries(r.meta ?? {}).filter(([k]) => k !== "changes")) })) as T[];
    },
  };
}

test("runGovernanceSweep: an outcome batch whose meta lacks `changes` is reported claimed_elsewhere, never asserted as a committed status (fail-closed, fixes-pass Finding A)", async () => {
  const d1 = createLocalD1();
  try {
    const proposer = insertCitizen(d1);
    const now = Date.now();
    const proposalId = insertProposal(d1, { kind: "resolution", status: "open", proposer_id: proposer, opened_at: now - 8 * 86_400_000, closes_at: now - 1000 });
    const voter = insertCitizen(d1);
    castYes(d1, proposalId, voter, now - 2000);

    const env = { ...testEnv(d1), DB: withChangesStrippedBatch(d1.DB) };
    const result = await runGovernanceSweep(env, now);
    assert.equal(result.due, 1);
    assert.equal(
      result.results[0].outcome,
      "claimed_elsewhere",
      "an unconfirmable batch must be under-reported, never asserted as the claimant's own precomputed status",
    );

    // The under-claim is the REPORT only: the batch committed underneath
    // (real SQLite wrote it; only `changes` went unreported), so the
    // proposal is terminal and the decided event sealed -- no strand,
    // nothing left for H1's stale-claim recovery to pick up.
    const row = await d1.DB.prepare("SELECT status FROM proposals WHERE id = ?").bind(proposalId).first<{ status: string }>();
    assert.equal(row!.status, "passed", "the batch really committed; only its report was degraded");
    const events = await d1.DB.prepare("SELECT COUNT(*) AS n FROM identity_events WHERE kind = 'proposal_decided'").first<{ n: number }>();
    assert.equal(events!.n, 1, "exactly one sealed outcome event");
  } finally {
    d1.close();
  }
});

// Finding 3's own anomaly shape (docs/REVIEW-HARDENING2-GATE-2026-08-10.md),
// one level up from withChangesStrippedBatch: the batch commits for real,
// but the driver's report is an EMPTY array -- no per-statement results at
// all, rather than results whose meta lacks `changes`.
function withEmptyBatchResult(DB: LocalD1["DB"]): LocalD1["DB"] {
  return {
    prepare: (sql: string) => DB.prepare(sql),
    async batch<T = unknown>(stmts: Parameters<LocalD1["DB"]["batch"]>[0]): Promise<T[]> {
      await DB.batch(stmts);
      return [] as T[];
    },
  };
}

test("runGovernanceSweep: gate finding 3 -- an outcome batch whose result array is EMPTY lands on claimed_elsewhere, never a raw TypeError through the public sweep response (docs/REVIEW-HARDENING2-GATE-2026-08-10.md)", async () => {
  const d1 = createLocalD1();
  try {
    const proposer = insertCitizen(d1);
    const now = Date.now();
    const proposalId = insertProposal(d1, { kind: "resolution", status: "open", proposer_id: proposer, opened_at: now - 8 * 86_400_000, closes_at: now - 1000 });
    const voter = insertCitizen(d1);
    castYes(d1, proposalId, voter, now - 2000);

    const env = { ...testEnv(d1), DB: withEmptyBatchResult(d1.DB) };
    const result = await runGovernanceSweep(env, now);
    assert.equal(result.due, 1);
    // Pre-fix: outcome "error" with error "TypeError: Cannot read
    // properties of undefined (reading 'meta')" -- a raw JS internals
    // message in the unauthenticated endpoint's own JSON, and an
    // inconsistency inside the same driver-corruption family (meta
    // lacking `changes` already took the quiet conservative path).
    assert.equal(
      result.results[0].outcome,
      "claimed_elsewhere",
      "the whole absent-report family lands on the one conservative path -- never a thrown TypeError",
    );
    assert.equal(result.results[0].error, undefined, "no raw driver/JS error text in the public sweep response");

    // As with Finding A's sibling test above: the under-claim is the
    // REPORT only. The batch committed underneath, so the row is terminal
    // and the decided event sealed -- no strand.
    const row = await d1.DB.prepare("SELECT status FROM proposals WHERE id = ?").bind(proposalId).first<{ status: string }>();
    assert.equal(row!.status, "passed", "the batch really committed; only its report was absent");
    const events = await d1.DB.prepare("SELECT COUNT(*) AS n FROM identity_events WHERE kind = 'proposal_decided'").first<{ n: number }>();
    assert.equal(events!.n, 1, "exactly one sealed outcome event");
    assert.deepEqual(result.stranded, [], "nothing left at 'tallying' for stale-claim recovery");
  } finally {
    d1.close();
  }
});

test("runGovernanceSweep: a proposal that fails quorum lands as 'failed', no settings write", async () => {
  const d1 = createLocalD1();
  try {
    const proposer = insertCitizen(d1);
    for (let i = 0; i < 9; i++) insertCitizen(d1); // 10 citizens total, all eligible in invite_only mode -> quorum = ceil(10/2) = 5
    const now = Date.now();
    const proposalId = insertProposal(d1, { kind: "set_split", status: "open", proposer_id: proposer, opened_at: now - 8 * 86_400_000, closes_at: now - 1000 });
    // no ballots cast at all

    const env = testEnv(d1);
    const result = await runGovernanceSweep(env, now);
    assert.equal(result.results[0].outcome, "failed");

    const row = await d1.DB.prepare("SELECT status FROM proposals WHERE id = ?").bind(proposalId).first<{ status: string }>();
    assert.equal(row!.status, "failed");

    const settings = await d1.DB.prepare("SELECT COUNT(*) AS n FROM governance_settings").first<{ n: number }>();
    assert.equal(settings!.n, 0, "a failed tally must never write a governance_settings row");
  } finally {
    d1.close();
  }
});

// ---------- H2/M6: frozen eligibility (docs/REVIEW-DEMOCRACY.md, migration 0006) ----------

test("runGovernanceSweep: H2 reproduction -- a proposal frozen under invite_only stays judged under invite_only even after REGISTRATION_MODE flips to open", async () => {
  const d1 = createLocalD1();
  try {
    const now = Date.now();
    // 8 citizens, all registered 9 days ago -- exactly the review's own
    // reproduction numbers, so the eligible_count assertion below is a
    // direct check against its reported branch (A) result.
    const citizens = Array.from({ length: 8 }, () => insertCitizen(d1, { created_at: now - 9 * 86_400_000 }));
    const proposalId = insertProposal(d1, {
      kind: "set_name",
      status: "open",
      proposer_id: citizens[0],
      registration_mode: "invite_only", // frozen at open
      founding_ratified: true, // isolates this test to the mode question, not M6's
      opened_at: now - 8 * 86_400_000,
      closes_at: now - 1000,
    });
    d1.raw.prepare("UPDATE proposals SET payload = ? WHERE id = ?").run(JSON.stringify({ name: "Panopticon" }), proposalId);

    // 3 ballots cast while the door was still invite_only: 2 yes, 1 no.
    castYes(d1, proposalId, citizens[0], now - 500);
    castYes(d1, proposalId, citizens[1], now - 500);
    d1.raw.prepare("INSERT INTO ballots (proposal_id, citizen_id, choice, cast_at) VALUES (?, ?, 'no', ?)").run(proposalId, citizens[2], now - 500);

    // The mode has since flipped to open -- env says so -- but the
    // proposal's OWN frozen registration_mode must be what the sweep
    // reads, not env.
    const env = testEnv(d1, "open");
    const result = await runGovernanceSweep(env, now);

    const row = await d1.DB.prepare("SELECT status, eligible_count, tally_yes, tally_no FROM proposals WHERE id = ?")
      .bind(proposalId)
      .first<{ status: string; eligible_count: number; tally_yes: number; tally_no: number }>();
    // Under the frozen invite_only rule, tenure is waived and all 8
    // registered citizens are eligible -> quorum ceil(8/2)=4, cast=3 < 4
    // -> FAILS. Before this fix, reading the live (now "open") mode
    // would recompute eligible via the 14-day tenure gate against these
    // citizens' actual registration (9 days ago, so none qualify),
    // giving eligible=0, quorum=0, and an EXECUTED rename on the
    // identical ballots -- the review's exact branch (B).
    assert.equal(row!.eligible_count, 8);
    assert.equal(row!.status, "failed");
    assert.equal(result.results[0].outcome, "failed");

    const settings = await d1.DB.prepare("SELECT COUNT(*) AS n FROM governance_settings WHERE key = 'name'").first<{ n: number }>();
    assert.equal(settings!.n, 0, "the name must never be written here -- this is the exact wrong outcome H2 reproduced");
  } finally {
    d1.close();
  }
});

test("runGovernanceSweep: M6 reproduction -- one proposal's ratification does not retroactively widen a DIFFERENT in-flight proposal's eligible census", async () => {
  const d1 = createLocalD1();
  try {
    const now = Date.now();
    const founders = [insertCitizen(d1), insertCitizen(d1), insertCitizen(d1)];
    for (const f of founders) insertIdentityEvent(d1, f, "invite_redeemed");
    // Present so eligible would jump 3 -> 6 if the freeze leaked live.
    insertCitizen(d1);
    insertCitizen(d1);
    insertCitizen(d1);

    const proposalA = insertProposal(d1, {
      kind: "set_name",
      status: "open",
      proposer_id: founders[0],
      registration_mode: "invite_only",
      founding_ratified: false, // frozen: unratified when A opened
      closes_at: now - 2000,
    });
    const proposalB = insertProposal(d1, {
      kind: "set_name",
      status: "open",
      proposer_id: founders[1],
      registration_mode: "invite_only",
      founding_ratified: false, // frozen: also unratified when B opened, same instant as A
      closes_at: now + 999_999_999, // not due in the first sweep
    });
    d1.raw.prepare("UPDATE proposals SET payload = ? WHERE id = ?").run(JSON.stringify({ name: "Hallmoot" }), proposalA);
    d1.raw.prepare("UPDATE proposals SET payload = ? WHERE id = ?").run(JSON.stringify({ name: "Freehold" }), proposalB);

    // 3 founders pass A: constitutional quorum ceil(3/2)=2, floor 3, cast=3 clears both; 3>=0 && 3>0.
    for (const f of founders) castYes(d1, proposalA, f, now - 1000);

    const env = testEnv(d1);
    const sweepA = await runGovernanceSweep(env, now);
    assert.equal(sweepA.results.find((r) => r.proposal_id === proposalA)?.outcome, "executed");
    assert.equal(await isFoundingRatified(env, "set_name"), true, "live check now says set_name IS ratified -- the trap this test proves B does not fall into");

    // Cast the same 3 founders on B, then force B due for a second sweep.
    for (const f of founders) castYes(d1, proposalB, f, now - 500);
    d1.raw.prepare("UPDATE proposals SET closes_at = ? WHERE id = ?").run(now, proposalB);
    await runGovernanceSweep(env, now);

    const bRow = await d1.DB.prepare("SELECT eligible_count, status FROM proposals WHERE id = ?")
      .bind(proposalB)
      .first<{ eligible_count: number; status: string }>();
    assert.equal(bRow!.eligible_count, 3, "B's own frozen founding_ratified=0 must keep its census founders-only (3), not widen to 6 just because A ratified the kind afterward");
    assert.equal(bRow!.status, "executed");
  } finally {
    d1.close();
  }
});

test("runGovernanceSweep: cast exceeding eligible is refused as invariant_violation, never committed or clamped (the H2 belt)", async () => {
  const d1 = createLocalD1();
  try {
    const now = Date.now();
    // Only one citizen has enough tenure to be eligible under 'open'
    // mode's 7-day advisory gate.
    const eligibleCitizen = insertCitizen(d1, { created_at: now - 30 * 86_400_000 });
    const tooNew1 = insertCitizen(d1, { created_at: now - 1000 });
    const tooNew2 = insertCitizen(d1, { created_at: now - 1000 });

    const proposalId = insertProposal(d1, {
      kind: "resolution",
      status: "open",
      proposer_id: eligibleCitizen,
      registration_mode: "open",
      founding_ratified: true,
      opened_at: now - 8 * 86_400_000,
      closes_at: now - 1000,
    });

    // Directly insert ballots for citizens who are NOT eligible under
    // this proposal's own frozen rule -- simulating cast > eligible, the
    // exact state H2's freeze is meant to make structurally impossible,
    // to prove the belt catches it if it were ever reached anyway (not a
    // reachable path today, through castBallot's own real gate).
    for (const c of [eligibleCitizen, tooNew1, tooNew2]) castYes(d1, proposalId, c, now - 500);

    const env = testEnv(d1, "open");
    const result = await runGovernanceSweep(env, now);
    assert.equal(result.results[0].outcome, "invariant_violation");

    const row = await d1.DB.prepare("SELECT status, tally_yes, tallied_at FROM proposals WHERE id = ?")
      .bind(proposalId)
      .first<{ status: string; tally_yes: number | null; tallied_at: number | null }>();
    assert.equal(row!.status, "tallying", "left exactly where the claim put it -- not committed, not silently clamped");
    assert.equal(row!.tally_yes, null, "no tally written");
    assert.equal(row!.tallied_at, now, "the claim's own stamp (commit B), not the outcome's -- this is what makes it eligible for stale-claim recovery once it ages past STALE_CLAIM_MS");

    const events = await d1.DB.prepare("SELECT COUNT(*) AS n FROM identity_events WHERE kind = 'proposal_decided'").first<{ n: number }>();
    assert.equal(events!.n, 0, "no outcome event for a violation");
    const settings = await d1.DB.prepare("SELECT COUNT(*) AS n FROM governance_settings").first<{ n: number }>();
    assert.equal(settings!.n, 0);
  } finally {
    d1.close();
  }
});

test("runGovernanceSweep: a passed set_name proposal executes -- governance_settings, proposals.status, and the chained outcome event all land together (execution batch atomicity)", async () => {
  const d1 = createLocalD1();
  try {
    const proposer = insertCitizen(d1);
    insertIdentityEvent(d1, proposer, "invite_redeemed"); // set_name is founding-gated and unratified on its first-ever vote -- everyone counted must be a founder
    const now = Date.now();
    const proposalId = insertProposal(d1, { kind: "set_name", status: "open", proposer_id: proposer, opened_at: now - 8 * 86_400_000, closes_at: now - 1000 });
    d1.raw.prepare("UPDATE proposals SET payload = ? WHERE id = ?").run(JSON.stringify({ name: "Hallmoot" }), proposalId);

    const voters = [insertCitizen(d1), insertCitizen(d1), insertCitizen(d1)];
    for (const v of voters) {
      insertIdentityEvent(d1, v, "invite_redeemed");
      castYes(d1, proposalId, v, now - 2000);
    }
    // eligible = proposer + 3 voters, all founders = 4; constitutional quorum = ceil(4/2) = 2, floor = 3; cast = 3 clears both; 3 >= 2*0 && 3 > 0 -> passed -> executed.

    const env = testEnv(d1);
    const result = await runGovernanceSweep(env, now);
    assert.equal(result.results[0].outcome, "executed");

    const proposal = await d1.DB.prepare("SELECT status FROM proposals WHERE id = ?").bind(proposalId).first<{ status: string }>();
    assert.equal(proposal!.status, "executed");

    const setting = await d1.DB.prepare("SELECT value, proposal_id FROM governance_settings WHERE key = 'name'").first<{ value: string; proposal_id: number }>();
    assert.ok(setting, "governance_settings must carry the new name");
    assert.equal(setting!.value, "Hallmoot");
    assert.equal(setting!.proposal_id, proposalId, "provenance: which proposal set this value");

    const event = await d1.DB.prepare("SELECT detail FROM identity_events WHERE kind = 'proposal_decided'").first<{ detail: string }>();
    assert.match(event!.detail, /executed/);
  } finally {
    d1.close();
  }
});

test("runGovernanceSweep: a passed set_dividend_uplift executes with a calendar-correct expires_at and a JSON value", async () => {
  const d1 = createLocalD1();
  try {
    const proposer = insertCitizen(d1);
    const now = Date.now();
    const proposalId = insertProposal(d1, { kind: "set_dividend_uplift", status: "open", proposer_id: proposer, opened_at: now - 8 * 86_400_000, closes_at: now - 1000 });
    d1.raw.prepare("UPDATE proposals SET payload = ? WHERE id = ?").run(JSON.stringify({ total_percent: 5, months: 3 }), proposalId);
    const v1 = insertCitizen(d1);
    const v2 = insertCitizen(d1);
    castYes(d1, proposalId, v1, now - 2000);
    castYes(d1, proposalId, v2, now - 2000);
    // eligible = proposer + v1 + v2 = 3; parameter quorum = ceil(3/2) = 2, floor = 2; cast = 2 clears both; 2 > 0 -> passed -> executed.

    const env = testEnv(d1);
    const result = await runGovernanceSweep(env, now);
    assert.equal(result.results[0].outcome, "executed");

    const setting = await d1.DB.prepare("SELECT value, expires_at FROM governance_settings WHERE key = 'dividend_uplift'")
      .first<{ value: string; expires_at: number }>();
    assert.ok(setting);
    assert.deepEqual(JSON.parse(setting!.value), { total_percent: 5 });
    assert.equal(setting!.expires_at, monthsFromNow(now, 3), "expiry must be calendar-accurate, computed by the same function the pure tests pin");
  } finally {
    d1.close();
  }
});

test("runGovernanceSweep: idempotency -- a second call after everything is processed finds nothing due and writes nothing further", async () => {
  const d1 = createLocalD1();
  try {
    const proposer = insertCitizen(d1);
    const now = Date.now();
    insertProposal(d1, { kind: "resolution", status: "open", proposer_id: proposer, opened_at: now - 8 * 86_400_000, closes_at: now - 1000 });
    const env = testEnv(d1);

    const first = await runGovernanceSweep(env, now);
    assert.equal(first.due, 1);

    const second = await runGovernanceSweep(env, now);
    assert.equal(second.due, 0, "the proposal is no longer 'open', so it is not fetched as due a second time");

    const events = await d1.DB.prepare("SELECT COUNT(*) AS n FROM identity_events WHERE kind = 'proposal_decided'").first<{ n: number }>();
    assert.equal(events!.n, 1, "exactly one outcome event, not two");
  } finally {
    d1.close();
  }
});

test("runGovernanceSweep: two concurrent calls racing on the same due proposal -- only one executes it, exactly one outcome event written (the double-claimant race)", async () => {
  const d1 = createLocalD1();
  try {
    const proposer = insertCitizen(d1);
    const now = Date.now();
    const proposalId = insertProposal(d1, { kind: "resolution", status: "open", proposer_id: proposer, opened_at: now - 8 * 86_400_000, closes_at: now - 1000 });
    const env = testEnv(d1);

    const [r1, r2] = await Promise.all([runGovernanceSweep(env, now), runGovernanceSweep(env, now)]);
    const outcomes = [r1.results[0]?.outcome, r2.results[0]?.outcome].sort();
    // No ballots cast: the one that actually processes it finds cast=0 < floor(1) -> "failed". The other finds it already claimed.
    assert.deepEqual(outcomes, ["claimed_elsewhere", "failed"]);

    const events = await d1.DB.prepare("SELECT COUNT(*) AS n FROM identity_events WHERE kind = 'proposal_decided'").first<{ n: number }>();
    assert.equal(events!.n, 1, "the race must not produce two outcome events for one proposal");

    const row = await d1.DB.prepare("SELECT status FROM proposals WHERE id = ?").bind(proposalId).first<{ status: string }>();
    assert.equal(row!.status, "failed");
  } finally {
    d1.close();
  }
});

test("runGovernanceSweep: multiple due proposals in one call are all processed", async () => {
  const d1 = createLocalD1();
  try {
    const proposer = insertCitizen(d1);
    const now = Date.now();
    const p1 = insertProposal(d1, { kind: "resolution", status: "open", proposer_id: proposer, opened_at: now - 8 * 86_400_000, closes_at: now - 1000 });
    const p2 = insertProposal(d1, { kind: "resolution", status: "open", proposer_id: proposer, opened_at: now - 8 * 86_400_000, closes_at: now - 500 });
    const env = testEnv(d1);

    const result = await runGovernanceSweep(env, now);
    assert.equal(result.due, 2);
    assert.equal(result.processed, 2);

    const { results } = await d1.DB.prepare("SELECT status FROM proposals WHERE id IN (?, ?) ORDER BY id").bind(p1, p2).all<{ status: string }>();
    assert.deepEqual(results.map((r) => r.status), ["failed", "failed"]);
  } finally {
    d1.close();
  }
});

test("runGovernanceSweep: a proposal not yet due (closes_at in the future) is left untouched", async () => {
  const d1 = createLocalD1();
  try {
    const proposer = insertCitizen(d1);
    const now = Date.now();
    const proposalId = insertProposal(d1, { kind: "resolution", status: "open", proposer_id: proposer, opened_at: now, closes_at: now + 86_400_000 });
    const env = testEnv(d1);

    const result = await runGovernanceSweep(env, now);
    assert.equal(result.due, 0);

    const row = await d1.DB.prepare("SELECT status FROM proposals WHERE id = ?").bind(proposalId).first<{ status: string }>();
    assert.equal(row!.status, "open");
  } finally {
    d1.close();
  }
});

test("runGovernanceSweep: functions with no ANTHROPIC_API_KEY set (dry key) -- it makes no model call and does not need one", async () => {
  const d1 = createLocalD1();
  try {
    const proposer = insertCitizen(d1);
    const now = Date.now();
    const proposalId = insertProposal(d1, { kind: "resolution", status: "open", proposer_id: proposer, opened_at: now - 8 * 86_400_000, closes_at: now - 1000 });
    const voter = insertCitizen(d1);
    castYes(d1, proposalId, voter, now - 2000);

    const env = testEnv(d1); // ANTHROPIC_API_KEY intentionally absent, as it is for every test in this file
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    const result = await runGovernanceSweep(env, now);
    assert.equal(result.results[0].outcome, "passed");
  } finally {
    d1.close();
  }
});

// ---------- H1: stale-claim recovery (docs/REVIEW-DEMOCRACY.md, STALE_CLAIM_MS) ----------

test("runGovernanceSweep: H1 reproduction -- a real transient batch failure strands a proposal at 'tallying'; too-fresh sweeps report it stranded without touching it; sweep past STALE_CLAIM_MS recovers it", async () => {
  const d1 = createLocalD1();
  try {
    const proposer = insertCitizen(d1);
    const now = Date.now();
    const proposalId = insertProposal(d1, { kind: "resolution", status: "open", proposer_id: proposer, opened_at: now - 8 * 86_400_000, closes_at: now - 1000 });
    const voter = insertCitizen(d1);
    castYes(d1, proposalId, voter, now - 2000);
    castYes(d1, proposalId, proposer, now - 2000);

    const flakyEnv = { ...testEnv(d1), DB: withFailingBatch(d1.DB, 1) };

    // Sweep 1: the claim (a plain UPDATE, not batch()) succeeds; the
    // outcome commit's batch() throws -- the review's own reproduction,
    // reproduced here for real rather than asserted from reading.
    const sweep1 = await runGovernanceSweep(flakyEnv, now);
    assert.equal(sweep1.results[0].outcome, "error");
    assert.match(sweep1.results[0].error!, /Network connection lost/);
    assert.deepEqual(sweep1.stranded, [proposalId]);

    const afterSweep1 = await d1.DB.prepare("SELECT status, tallied_at FROM proposals WHERE id = ?")
      .bind(proposalId)
      .first<{ status: string; tallied_at: number }>();
    assert.equal(afterSweep1!.status, "tallying");
    assert.equal(afterSweep1!.tallied_at, now, "stamped with the claim's own time, per commit B");

    // Sweep 2, 60s later, real DB (no longer poisoned): still too fresh
    // to reclaim (STALE_CLAIM_MS is 15 minutes) -- must not be touched,
    // but must still be visibly reported as stranded.
    const soon = now + 60_000;
    const sweep2 = await runGovernanceSweep(testEnv(d1), soon);
    assert.equal(sweep2.due, 0, "not yet stale -- a too-eager reclaim would itself be a race hazard");
    assert.deepEqual(sweep2.stranded, [proposalId], "still visibly stuck even though nothing was due to process");

    // Sweep 3, 16 minutes later: past STALE_CLAIM_MS, recovers it.
    const later = now + 16 * 60 * 1000;
    const sweep3 = await runGovernanceSweep(testEnv(d1), later);
    assert.equal(sweep3.due, 1);
    assert.equal(sweep3.results[0].reclaimed, true);
    assert.equal(sweep3.results[0].outcome, "passed");
    assert.deepEqual(sweep3.stranded, [], "recovered -- no longer stranded");

    const finalRow = await d1.DB.prepare("SELECT status FROM proposals WHERE id = ?").bind(proposalId).first<{ status: string }>();
    assert.equal(finalRow!.status, "passed");

    const events = await d1.DB.prepare("SELECT COUNT(*) AS n FROM identity_events WHERE kind = 'proposal_decided'").first<{ n: number }>();
    assert.equal(events!.n, 1, "exactly one outcome event -- sweep 1's failed attempt must not have left a partial one");
  } finally {
    d1.close();
  }
});

test("runGovernanceSweep: a concurrent re-claim race on a stale 'tallying' proposal cannot double-execute", async () => {
  const d1 = createLocalD1();
  try {
    const proposer = insertCitizen(d1);
    const now = Date.now();
    const proposalId = insertProposal(d1, { kind: "resolution", status: "open", proposer_id: proposer, opened_at: now - 8 * 86_400_000, closes_at: now - 1000 });
    castYes(d1, proposalId, proposer, now - 500);

    // Directly stamp the row into the abandoned-claim state H1's real
    // strand leaves behind (constructed directly here to isolate the
    // race itself, rather than re-deriving it from a forced failure
    // again -- that path is exercised end to end by the test above).
    d1.raw.prepare("UPDATE proposals SET status = 'tallying', tallied_at = ? WHERE id = ?").run(now - 20 * 60 * 1000, proposalId);

    const env = testEnv(d1);
    const [r1, r2] = await Promise.all([runGovernanceSweep(env, now), runGovernanceSweep(env, now)]);

    const outcomes = [r1.results[0]?.outcome, r2.results[0]?.outcome].sort();
    // One caller's re-claim UPDATE actually changes the row (and moves
    // tallied_at out of the stale window in the same statement); the
    // other's identical UPDATE, evaluated against the now-current row,
    // affects zero rows and reports claimed_elsewhere -- the same
    // compare-and-swap-by-WHERE-clause guarantee the original
    // 'open'->'tallying' claim already relied on, now covering the
    // 'tallying'(stale)->'tallying'(reclaimed) transition too.
    assert.deepEqual(outcomes, ["claimed_elsewhere", "passed"]);

    const events = await d1.DB.prepare("SELECT COUNT(*) AS n FROM identity_events WHERE kind = 'proposal_decided'").first<{ n: number }>();
    assert.equal(events!.n, 1, "the race must not produce two outcome events for one proposal");

    const row = await d1.DB.prepare("SELECT status FROM proposals WHERE id = ?").bind(proposalId).first<{ status: string }>();
    assert.equal(row!.status, "passed");
  } finally {
    d1.close();
  }
});

// ---------- N5: stale-claim recovery is NULL-safe (docs/REVIEW-DEMOCRACY-RECHECK.md) ----------

test("runGovernanceSweep: N5 -- a hand-staged 'tallying' row with a NULL tallied_at is recovered by the next sweep, not stranded forever", async () => {
  const d1 = createLocalD1();
  try {
    const proposer = insertCitizen(d1);
    const now = Date.now();
    const proposalId = insertProposal(d1, { kind: "resolution", status: "open", proposer_id: proposer, opened_at: now - 8 * 86_400_000, closes_at: now - 1000 });
    castYes(d1, proposalId, proposer, now - 500);

    // The exact pathology N5 names: a row at status='tallying' with
    // tallied_at left NULL. Not reachable through any deployed code path
    // (both the claim UPDATE and the final status UPDATE always stamp
    // tallied_at) -- a hand-staged out-of-band write, the same kind
    // governance-policing.test.ts exists to forbid -- but H1's own
    // reasoning was that no 'tallying' sub-state should be unreadable, so
    // this is worth closing rather than leaving as a documented miss.
    d1.raw.prepare("UPDATE proposals SET status = 'tallying', tallied_at = NULL WHERE id = ?").run(proposalId);

    const env = testEnv(d1);
    const sweep = await runGovernanceSweep(env, now);
    assert.equal(sweep.due, 1, "a NULL tallied_at must not make the row invisible to the due query");
    assert.equal(sweep.results[0].reclaimed, true);
    assert.equal(sweep.results[0].outcome, "passed");
    assert.deepEqual(sweep.stranded, []);

    const row = await d1.DB.prepare("SELECT status, tallied_at FROM proposals WHERE id = ?")
      .bind(proposalId)
      .first<{ status: string; tallied_at: number }>();
    assert.equal(row!.status, "passed");
    assert.equal(row!.tallied_at, now, "recovered and re-stamped with this sweep's own claim time");
  } finally {
    d1.close();
  }
});

// ---------- N1 + N6: the guarded chained append (docs/REVIEW-DEMOCRACY-RECHECK.md) ----------
//
// Intercepts the exact head-read SELECT appendChainedStmt/appendChainedGated
// issue for `table` (chain.ts: "SELECT hash FROM <table> WHERE hash IS NOT
// NULL ORDER BY id DESC LIMIT 1") and, the first time it runs, captures its
// real result BEFORE running `duringRead` to completion, then hands the
// caller the value read a moment "before" -- a deterministic reproduction
// of "a concurrent process ran to completion in the gap between this
// caller's own read and its write", the exact window N1 and N6 both name,
// without depending on Promise.all's actual microtask scheduling the way
// the H1 races above do. Fires once; a retry attempt (a second call for the
// same table) passes straight through to the real statement.
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

test("castBallot: N1 -- a ballot that loses the race against the sweep's claim is refused with 409, never landed on the chain unrecorded by the tally", async () => {
  const d1 = createLocalD1();
  try {
    const proposer = insertCitizen(d1);
    const now = Date.now();
    // An hour out in real terms, so castBallot's own Date.now() window
    // check always sees this proposal as still open, regardless of how
    // long the test itself takes to execute.
    const closesAt = now + 3_600_000;
    const proposalId = insertProposal(d1, { kind: "resolution", status: "open", proposer_id: proposer, opened_at: now - 8 * 86_400_000, closes_at: closesAt });
    const noVoter1 = insertCitizen(d1);
    const noVoter2 = insertCitizen(d1);
    castNo(d1, proposalId, noVoter1, now - 2000);
    castNo(d1, proposalId, noVoter2, now - 2000);

    const thirdVoter = insertCitizen(d1);
    const sweepEnv = testEnv(d1);
    // The sweep's own `now` is independent of real time -- past closesAt,
    // so it considers the proposal due the instant it runs, inside the
    // window between this ballot's own status read and its chained
    // append, the exact interleave the recheck reproduced.
    const sweepNow = closesAt + 1000;
    const raceEnv = { ...testEnv(d1), DB: withChainedHeadReadTriggering(d1.DB, "ballots", () => runGovernanceSweep(sweepEnv, sweepNow)) };

    await assert.rejects(
      () => castBallot(raceEnv, { id: thirdVoter, created_at: now - 30 * 86_400_000 }, proposalId, "yes"),
      (e: unknown) => e instanceof SocietyError && e.status === 409 && /no longer open/.test(e.message),
    );

    const tallyRow = await d1.DB.prepare("SELECT status, tally_yes, tally_no FROM proposals WHERE id = ?")
      .bind(proposalId)
      .first<{ status: string; tally_yes: number; tally_no: number }>();
    assert.equal(tallyRow!.status, "failed", "the sweep tallied the two no votes before this ballot ever landed");
    assert.equal(tallyRow!.tally_no, 2);

    const ballotCount = await d1.DB.prepare("SELECT COUNT(*) AS n FROM ballots WHERE proposal_id = ?").bind(proposalId).first<{ n: number }>();
    assert.equal(ballotCount!.n, 2, "the refused third ballot never landed -- public ballots equal the recorded tally, not three against a tally of two");
  } finally {
    d1.close();
  }
});

test("runGovernanceSweep: N6 -- a stalled claimant that resumes after a re-claimer has fully committed does not append a duplicate proposal_decided event, and honestly reports it committed nothing (F1, hardening-2)", async () => {
  const d1 = createLocalD1();
  try {
    const proposer = insertCitizen(d1);
    const now = Date.now();
    const proposalId = insertProposal(d1, { kind: "resolution", status: "open", proposer_id: proposer, opened_at: now - 8 * 86_400_000, closes_at: now - 1000 });
    castYes(d1, proposalId, proposer, now - 500);

    // A's own env: the FIRST time A's commitOutcome reads the
    // identity_events head (attempt 0, before it has written anything), a
    // full second sweep (B) runs to completion first -- a real re-claim,
    // real tally, real commit -- extending the chain past the head A just
    // captured. A is then handed that stale, already-superseded head.
    //
    // Comment corrected, hardening-2: this used to describe a UNIQUE
    // collision and a retry ("its first batch fails on UNIQUE constraint
    // failed... commitOutcome's own 4-attempt retry loop then re-reads the
    // head and succeeds"), which was accurate before the chain-gate commit
    // (a31a6b5) gave the log statement itself a `status = 'tallying'` gate.
    // Today B's commit has already moved the proposal off 'tallying' by the
    // time A's batch runs, so A's gated log statement inserts zero rows
    // WITHOUT throwing -- the gate wins silently before any UNIQUE
    // constraint is ever evaluated (society/docs/REVIEW-CHAINGATE-2026-08-09.md
    // Q2a). Attempt 0 succeeds cleanly on a batch that wrote nothing, which
    // is exactly F1: pre this commit, commitOutcome discarded that batch
    // result and returned the phantom `{hash: log.hash}` regardless, and
    // A's own stale (but here coincidentally correct) finalStatus rode that
    // phantom straight out to the caller. Fixed: commitOutcome now checks
    // the log statement's own `meta.changes` and returns "claimed_elsewhere"
    // when it is 0, and claimTallyAndExecuteOne propagates that instead of
    // its own precomputed status.
    const later = now + 16 * 60 * 1000; // comfortably past STALE_CLAIM_MS (15 min) from `now`, independent of real time
    const bEnv = testEnv(d1);
    const aEnv = { ...testEnv(d1), DB: withChainedHeadReadTriggering(d1.DB, "identity_events", () => runGovernanceSweep(bEnv, later)) };

    const aResult = await runGovernanceSweep(aEnv, now);
    assert.equal(
      aResult.results[0].outcome,
      "claimed_elsewhere",
      "A's batch wrote nothing (B already committed) -- A must report that honestly, not its own precomputed status, even though here it happens to agree with B's",
    );

    const events = await d1.DB.prepare("SELECT COUNT(*) AS n FROM identity_events WHERE kind = 'proposal_decided'").first<{ n: number }>();
    assert.equal(events!.n, 1, "exactly one outcome event -- A's resumed batch, gated identically to the state statements, wrote nothing");

    const row = await d1.DB.prepare("SELECT status FROM proposals WHERE id = ?").bind(proposalId).first<{ status: string }>();
    assert.equal(row!.status, "passed", "B's own commit is what persists; A's resumed batch was a clean no-op");
  } finally {
    d1.close();
  }
});

test("runGovernanceSweep: F1 divergent-tally repro -- a stalled claimant whose stale computation would have been WRONG reports claimed_elsewhere, never its own or the real committer's outcome (hardening-2, docs/REVIEW-CHAINGATE-2026-08-09.md finding 1)", async () => {
  const d1 = createLocalD1();
  try {
    const proposer = insertCitizen(d1);
    const voter2 = insertCitizen(d1);
    insertCitizen(d1); // citizen #3: non-voting, contributes to the eligible census only
    insertCitizen(d1); // citizen #4: non-voting, contributes to the eligible census only
    const now = Date.now();
    const closesAt = now - 1000;
    // set_split: parameter class (quorum applies, unlike advisory), not
    // founder-gated, machine-executable -- but payload stays null, so
    // settingsStatementForExecution no-ops harmlessly on the "passed"
    // branch (governance.ts:830) and this test can stay about the outcome
    // string alone.
    const proposalId = insertProposal(d1, { kind: "set_split", status: "open", proposer_id: proposer, opened_at: now - 8 * 86_400_000, closes_at: closesAt });
    // cast=2. quorumThreshold(4)=2 (clears), CLASS_MIN_BALLOTS.parameter=2
    // (clears), yes(2)>no(0) (clears margin) -- A's own stale computation,
    // frozen the moment it reads the four-citizen census below, resolves to
    // "passed" and (set_split being machine-executable) finalStatus
    // "executed".
    castYes(d1, proposalId, proposer, now - 500);
    castYes(d1, proposalId, voter2, now - 500);

    const later = now + 16 * 60 * 1000; // past STALE_CLAIM_MS, so B can reclaim
    const bEnv = testEnv(d1);
    const aEnv = {
      ...testEnv(d1),
      DB: withChainedHeadReadTriggering(d1.DB, "identity_events", async () => {
        // A fifth citizen registers DURING A's stall -- invisible to A's
        // own citizens read (already completed before this fires: A's
        // eligible=4 was computed well before commitOutcome's own
        // identity_events head-read), but fully visible to B's own,
        // independent re-read a moment later. quorumThreshold(5)=3, and
        // cast stays 2 -- the exact quorum-flip boundary the cross-agent
        // review derived (exchange/REVIEW_chaingate-followups_2026-08-09.md
        // round 1/2: "the first flip window is cast=2 with the census
        // growing 4->5 mid-stall").
        insertCitizen(d1);
        await runGovernanceSweep(bEnv, later);
      }),
    };

    const aResult = await runGovernanceSweep(aEnv, now);
    assert.equal(
      aResult.results[0].outcome,
      "claimed_elsewhere",
      "A's stale computation said executed (eligible=4); B actually committed failed (eligible=5) -- A must assert neither its own guess nor B's real answer, only that it did not commit",
    );

    const row = await d1.DB.prepare("SELECT status, eligible_count, tally_yes, tally_no FROM proposals WHERE id = ?")
      .bind(proposalId)
      .first<{ status: string; eligible_count: number; tally_yes: number; tally_no: number }>();
    assert.equal(row!.status, "failed", "B's real committed outcome persists: quorum failed once the census grew to 5 mid-stall");
    assert.equal(row!.eligible_count, 5, "the eligible count committed is B's own live read, not A's stale 4");

    const events = await d1.DB.prepare("SELECT COUNT(*) AS n FROM identity_events WHERE kind = 'proposal_decided'").first<{ n: number }>();
    assert.equal(events!.n, 1, "exactly one outcome event -- A's resumed batch wrote nothing, gate refused identically to the state statements");

    const event = await d1.DB.prepare("SELECT detail FROM identity_events WHERE kind = 'proposal_decided'").first<{ detail: string }>();
    assert.match(event!.detail, /failed/, "the one recorded event names B's real outcome");
    assert.doesNotMatch(event!.detail, /executed/, "A's phantom 'executed' verdict must never reach the permanent record");
  } finally {
    d1.close();
  }
});

test("runGovernanceSweep: gate finding 1 -- a resumed stale claimant that wins the race against a MID-FLIGHT re-claimer (claimed but not yet committed) no-ops its whole batch, never sealing its stale tally (docs/REVIEW-HARDENING2-GATE-2026-08-10.md)", async () => {
  const d1 = createLocalD1();
  try {
    // F1's sibling window, distinct from the two F1 tests above: there B
    // ran TO COMPLETION during A's stall, so A's status-only gate failed
    // on status having moved off 'tallying'. Here B has only RE-CLAIMED
    // (status stays 'tallying', tallied_at restamped) when A resumes --
    // the exact case the gate reviewer reproduced, where a status-only
    // gate PASSES under B's claim and A commits a stale tally to the
    // permanent chain. The fix binds the claimant's own claim stamp
    // (tallied_at) into all three gated statements, so A's resumed batch
    // no-ops in lockstep and B's eventual commit is the only one.
    const proposer = insertCitizen(d1);
    const voter2 = insertCitizen(d1);
    insertCitizen(d1); // census filler
    insertCitizen(d1); // census filler -- 4 citizens at A's read
    const now = Date.now();
    const proposalId = insertProposal(d1, { kind: "set_split", status: "open", proposer_id: proposer, opened_at: now - 8 * 86_400_000, closes_at: now - 1000 });
    // A real payload, unlike the F1 divergent test above: the settings
    // upsert must be IN A's batch, because the lockstep property is the
    // point -- a fix that stamped only the chain gate and the status
    // UPDATE would let A's stale settings write land alone.
    d1.raw.prepare("UPDATE proposals SET payload = ? WHERE id = ?").run(JSON.stringify({ prize: 80, bounty: 20 }), proposalId);
    // cast=2 against census 4: quorum ceil(4/2)=2 clears, parameter min 2
    // clears, yes 2 > no 0 -- A's stale computation resolves to "passed"
    // and, set_split being machine-executable, "executed".
    castYes(d1, proposalId, proposer, now - 500);
    castYes(d1, proposalId, voter2, now - 500);

    const later = now + 16 * 60 * 1000; // past STALE_CLAIM_MS, so B's re-claim UPDATE matches
    const aEnv = {
      ...testEnv(d1),
      DB: withChainedHeadReadTriggering(d1.DB, "identity_events", async () => {
        // During A's stall: the census grows to 5 (flipping the real
        // quorum to 3 > cast 2, so the eventually-correct outcome is
        // "failed"), and B re-claims with the REAL claim UPDATE's own
        // SQL -- then B stalls too, mid-flight, having committed nothing.
        insertCitizen(d1);
        const reclaim = await d1.DB.prepare(
          `UPDATE proposals SET status = 'tallying', tallied_at = ?
           WHERE id = ? AND ((status = 'open' AND closes_at <= ?) OR (status = 'tallying' AND (tallied_at IS NULL OR tallied_at <= ?)))`,
        )
          .bind(later, proposalId, later, later - 15 * 60 * 1000)
          .run();
        assert.equal(reclaim.meta.changes, 1, "fixture sanity: B's re-claim must actually restamp A's stale claim");
      }),
    };

    const aResult = await runGovernanceSweep(aEnv, now);
    assert.equal(
      aResult.results[0].outcome,
      "claimed_elsewhere",
      "A resumed under B's live claim -- its stale 'executed' verdict (eligible=4) must never commit, report, or seal",
    );
    assert.deepEqual(aResult.stranded, [proposalId], "the proposal is honestly reported stranded: still 'tallying' under B's mid-flight claim");

    const row = await d1.DB.prepare("SELECT status, tallied_at, eligible_count FROM proposals WHERE id = ?")
      .bind(proposalId)
      .first<{ status: string; tallied_at: number; eligible_count: number | null }>();
    assert.equal(row!.status, "tallying", "B still holds the claim; A's resumed status UPDATE no-opped");
    assert.equal(row!.tallied_at, later, "B's claim stamp survives untouched -- A's batch could not restamp it");
    assert.equal(row!.eligible_count, null, "A's stale census never landed");
    const events = await d1.DB.prepare("SELECT COUNT(*) AS n FROM identity_events WHERE kind = 'proposal_decided'").first<{ n: number }>();
    assert.equal(events!.n, 0, "no outcome event: A's gated log statement no-opped in lockstep with the state statements");
    const setting = await d1.DB.prepare("SELECT COUNT(*) AS n FROM governance_settings").first<{ n: number }>();
    assert.equal(setting!.n, 0, "the lockstep assertion itself: A's stale settings upsert must not land alone");

    // B's claim eventually goes stale in turn; a later sweep re-claims and
    // commits the REAL outcome against the grown census.
    const evenLater = later + 16 * 60 * 1000;
    const finalSweep = await runGovernanceSweep(testEnv(d1), evenLater);
    assert.equal(finalSweep.results[0].outcome, "failed", "the committed outcome is the fresh census's own: quorum 3 > cast 2");
    const finalRow = await d1.DB.prepare("SELECT status, eligible_count FROM proposals WHERE id = ?")
      .bind(proposalId)
      .first<{ status: string; eligible_count: number }>();
    assert.equal(finalRow!.status, "failed");
    assert.equal(finalRow!.eligible_count, 5, "the committed census is the live 5, never A's stale 4");
    const finalEvents = await d1.DB.prepare("SELECT detail FROM identity_events WHERE kind = 'proposal_decided'").all<{ detail: string }>();
    assert.equal(finalEvents.results.length, 1, "exactly one sealed outcome event across the whole race");
    assert.match(finalEvents.results[0].detail, /failed/);
    assert.doesNotMatch(finalEvents.results[0].detail, /executed/, "A's stale verdict appears nowhere in the permanent record");
  } finally {
    d1.close();
  }
});

test("commitOutcome: F6 -- a retried outcome commit's identity_events.created_at equals the same batch's proposals.tallied_at, not a fresh clock read taken mid-retry (hardening-2)", async () => {
  const d1 = createLocalD1();
  try {
    const proposer = insertCitizen(d1);
    // Deliberately far from real Date.now(): if the pre-fix code's
    // `created_at: Date.now()` ever ran inside commitOutcome's loop, the
    // mismatch below would be measured in YEARS, not milliseconds, so this
    // red-proof cannot pass by timing coincidence the way a real-clock
    // `now` might.
    const now = Date.UTC(2030, 0, 1);
    const proposalId = insertProposal(d1, { kind: "resolution", status: "open", proposer_id: proposer, opened_at: now - 8 * 86_400_000, closes_at: now - 1000 });
    castYes(d1, proposalId, proposer, now - 500);

    // A genuine chain-head race, unrelated to this proposal's own gate
    // (nothing here touches proposalId's status, so the gate stays
    // satisfied throughout and the retry is forced by a real UNIQUE
    // collision, not a gate refusal): an unrelated identity_events append
    // (a citizen's own key rotation, say) lands in the gap between
    // commitOutcome's head read and its write. appendChained is chain.ts's
    // own real writer, so the competing row is validly sealed, and the
    // resulting collision on identity_events' real prev_hash index is the
    // genuine article, not simulated.
    const raceEnv = {
      ...testEnv(d1),
      DB: withChainedHeadReadTriggering(d1.DB, "identity_events", () =>
        appendChained(d1.DB, "identity_events", { citizen_id: proposer, kind: "key_rotation", detail: "unrelated race writer", created_at: now }),
      ),
    };

    const result = await runGovernanceSweep(raceEnv, now);
    assert.equal(result.results[0].outcome, "passed", "the race resolves via a real retry, not a gate refusal -- a genuinely committed outcome, not claimed_elsewhere");

    const row = await d1.DB.prepare("SELECT tallied_at FROM proposals WHERE id = ?").bind(proposalId).first<{ tallied_at: number }>();
    const event = await d1.DB.prepare("SELECT created_at FROM identity_events WHERE kind = 'proposal_decided' AND citizen_id = ?").bind(proposer).first<{ created_at: number }>();
    assert.ok(event, "the outcome event must exist");
    assert.equal(event!.created_at, now, "created_at must be the sweep's own `now`, not a fresh clock read taken during the retry");
    assert.equal(event!.created_at, row!.tallied_at, "the log entry and the proposal row committed in the same batch must carry the identical timestamp");
  } finally {
    d1.close();
  }
});

// ---------- officialFacts (society.ts) reading governance_settings ----------

test("officialFacts: falls back to the deployed defaults with no governance_settings rows at all", async () => {
  const d1 = createLocalD1();
  try {
    const facts = await officialFacts(testEnv(d1));
    assert.equal(facts.society, DEFAULT_NAME);
    assert.equal(facts.name_status, "provisional until the founding citizens ratify or replace it as their first vote");
    assert.equal(facts.dividend_percent, DEFAULT_DIVIDEND_PERCENT);
    assert.equal(facts.control_floor_percent, DEFAULT_CONTROL_FLOOR_PERCENT);
    assert.deepEqual(facts.split, DEFAULT_SPLIT);
    assert.equal(facts.governance.name_source, "default");
    assert.equal(facts.governance.mechanism, "live");
    assert.equal(facts.governance.open_proposals, 0);
  } finally {
    d1.close();
  }
});

// docs/REVIEW-DEMOCRACY.md M4: control_floor_percent and split previously
// executed into settings nothing ever read.
test("officialFacts: reflects a raised control_floor_percent once a control_floor_raise has executed", async () => {
  const d1 = createLocalD1();
  try {
    const now = Date.now();
    d1.raw
      .prepare("INSERT INTO governance_settings (key, value, expires_at, proposal_id, updated_at) VALUES (?, ?, NULL, NULL, ?)")
      .run(SETTING_KEY.controlFloorPercent, "88", now);

    const facts = await officialFacts(testEnv(d1));
    assert.equal(facts.control_floor_percent, 88);
  } finally {
    d1.close();
  }
});

test("officialFacts: reflects a re-split prize:bounty ratio once a set_split has executed", async () => {
  const d1 = createLocalD1();
  try {
    const now = Date.now();
    d1.raw
      .prepare("INSERT INTO governance_settings (key, value, expires_at, proposal_id, updated_at) VALUES (?, ?, NULL, NULL, ?)")
      .run(SETTING_KEY.split, JSON.stringify({ prize: 6, bounty: 1 }), now);

    const facts = await officialFacts(testEnv(d1));
    assert.deepEqual(facts.split, { prize: 6, bounty: 1 });
  } finally {
    d1.close();
  }
});

test("officialFacts: reflects a ratified name once governance_settings has one, name_source becomes governance_settings", async () => {
  const d1 = createLocalD1();
  try {
    const now = Date.now();
    d1.raw
      .prepare("INSERT INTO governance_settings (key, value, expires_at, proposal_id, updated_at) VALUES (?, ?, NULL, NULL, ?)")
      .run(SETTING_KEY.name, "Hallmoot", now);

    const facts = await officialFacts(testEnv(d1));
    assert.equal(facts.society, "Hallmoot");
    assert.equal(facts.name_status, "ratified by a passed set_name vote (GET /api/proposals)");
    assert.equal(facts.governance.name_source, "governance_settings");
  } finally {
    d1.close();
  }
});

test("officialFacts: dividend_percent reflects an active (non-expired) uplift", async () => {
  const d1 = createLocalD1();
  try {
    const now = Date.now();
    d1.raw
      .prepare("INSERT INTO governance_settings (key, value, expires_at, proposal_id, updated_at) VALUES (?, ?, ?, NULL, ?)")
      .run(SETTING_KEY.dividendUplift, JSON.stringify({ total_percent: 8 }), now + 30 * 86_400_000, now);

    const facts = await officialFacts(testEnv(d1));
    assert.equal(facts.dividend_percent, 8);
  } finally {
    d1.close();
  }
});

test("officialFacts: dividend_percent falls back to the default once an uplift has expired, without needing a wake to un-set it", async () => {
  const d1 = createLocalD1();
  try {
    const now = Date.now();
    d1.raw
      .prepare("INSERT INTO governance_settings (key, value, expires_at, proposal_id, updated_at) VALUES (?, ?, ?, NULL, ?)")
      .run(SETTING_KEY.dividendUplift, JSON.stringify({ total_percent: 8 }), now - 1000, now - 2000); // expired 1 second ago

    const facts = await officialFacts(testEnv(d1));
    assert.equal(facts.dividend_percent, DEFAULT_DIVIDEND_PERCENT, "an expired uplift must not still be read as active");
  } finally {
    d1.close();
  }
});

test("officialFacts: governance.open_proposals counts only status='open' proposals", async () => {
  const d1 = createLocalD1();
  try {
    const proposer = insertCitizen(d1);
    insertProposal(d1, { kind: "resolution", status: "open", proposer_id: proposer });
    insertProposal(d1, { kind: "resolution", status: "open", proposer_id: proposer });
    insertProposal(d1, { kind: "resolution", status: "passed", proposer_id: proposer });
    insertProposal(d1, { kind: "resolution", status: "failed", proposer_id: proposer });

    const facts = await officialFacts(testEnv(d1));
    assert.equal(facts.governance.open_proposals, 2);
  } finally {
    d1.close();
  }
});

// ---------- listProposals cursor (L2) ----------

// docs/REVIEW-DEMOCRACY.md L2 red-proof, reproduced the same way the review
// did: a real page-boundary collision, not a unit test of the WHERE clause
// in isolation. 199 fillers with distinct created_at values, then two more
// proposals sharing the exact next millisecond -- so the 200th and 201st
// rows overall (PROPOSAL_PAGE = 200) are the colliding pair, landing
// exactly on the page boundary the bug needs.
test("listProposals: a page-boundary millisecond collision loses no row when the caller walks both cursor fields, and does not otherwise change the first page", async () => {
  const d1 = createLocalD1();
  try {
    const proposer = insertCitizen(d1);
    const baseTime = Date.UTC(2026, 0, 1);
    const insertAt = d1.raw.prepare(
      "INSERT INTO proposals (kind, title, body, proposer_id, opened_at, closes_at, created_at) VALUES ('resolution', ?, 'body', ?, ?, ?, ?)",
    );
    for (let i = 0; i < 199; i++) {
      const t = baseTime + i;
      insertAt.run(`filler ${i}`, proposer, t, t + 7 * 86_400_000, t);
    }
    const collisionTime = baseTime + 199;
    insertAt.run("boundary A", proposer, collisionTime, collisionTime + 7 * 86_400_000, collisionTime);
    insertAt.run("boundary B", proposer, collisionTime, collisionTime + 7 * 86_400_000, collisionTime);

    const env = testEnv(d1);

    const page1 = await listProposals(env);
    assert.equal(page1.total, 201);
    assert.equal(page1.returned, PROPOSAL_PAGE);
    assert.equal(page1.has_more, true);
    assert.equal(page1.proposals[199].title, "boundary A", "the 200th row in (created_at, id) order is boundary A, the earlier-inserted of the tied pair");
    assert.equal((page1 as { next_since_id?: number }).next_since_id, page1.proposals[199].id, "next_since_id must name boundary A's own row, not just its timestamp");

    // The fix: a caller that walks both next_since and next_since_id sees
    // boundary B on the very next page -- nothing lost.
    const page2Fixed = await listProposals(env, (page1 as { next_since: number }).next_since, (page1 as { next_since_id: number }).next_since_id);
    assert.equal(page2Fixed.returned, 1);
    assert.equal(page2Fixed.proposals[0].title, "boundary B");
    assert.equal(page2Fixed.has_more, false);

    // The accepted, unchanged half: a caller that has not adopted since_id
    // yet gets exactly the old query (created_at > since alone) -- boundary
    // B, sharing the exact boundary timestamp, is still silently absent.
    // This is not a new gap (docs/REVIEW-DEMOCRACY.md calls it "out of
    // phase-0 reach"); asserted here so nobody mistakes the fix above for
    // having removed it, and so a future change that accidentally forces
    // the tie-break unconditionally (which would instead DUPLICATE
    // boundary A on page 2, see governance.ts's own comment on why sinceId
    // defaults to NaN, not 0) gets caught by this exact assertion moving.
    const page2Unupgraded = await listProposals(env, (page1 as { next_since: number }).next_since);
    assert.equal(page2Unupgraded.returned, 0, "an old-style caller without since_id sees the pre-existing, accepted limitation, not a new regression");
  } finally {
    d1.close();
  }
});

// ---------- citizenDirectory: task_e978a614 (L2-class), docs/REVIEW-DEMOCRACY-RECHECK.md ----------
//
// Same defect L2 fixed in listProposals, same fix, same test shape, scaled
// to CITIZEN_PAGE (1000) instead of PROPOSAL_PAGE (200): a single-field
// created_at cursor loses a row silently and permanently when two citizens
// share a millisecond across a page boundary.

test("citizenDirectory: a page-boundary millisecond collision loses no row when the caller walks both cursor fields, and does not otherwise change the first page", async () => {
  const d1 = createLocalD1();
  try {
    const baseTime = Date.UTC(2026, 0, 1);
    for (let i = 0; i < CITIZEN_PAGE - 1; i++) {
      insertCitizen(d1, { handle: `filler-${i}`, created_at: baseTime + i });
    }
    const collisionTime = baseTime + (CITIZEN_PAGE - 1);
    insertCitizen(d1, { handle: "boundary-a", created_at: collisionTime });
    insertCitizen(d1, { handle: "boundary-b", created_at: collisionTime });

    const env = testEnv(d1);

    const page1 = await citizenDirectory(env);
    assert.equal(page1.total, CITIZEN_PAGE + 1);
    assert.equal(page1.returned, CITIZEN_PAGE);
    assert.equal(page1.has_more, true);
    assert.equal(
      page1.citizens[CITIZEN_PAGE - 1].handle,
      "boundary-a",
      "the last row in (created_at, id) order is boundary-a, the earlier-inserted of the tied pair",
    );
    assert.ok("next_since_id" in page1, "has_more must carry the tie-break cursor, not just next_since");

    // The fix: a caller that walks both next_since and next_since_id sees
    // boundary-b on the very next page -- nothing lost.
    const page2Fixed = await citizenDirectory(env, (page1 as { next_since: number }).next_since, (page1 as { next_since_id: number }).next_since_id);
    assert.equal(page2Fixed.returned, 1);
    assert.equal(page2Fixed.citizens[0].handle, "boundary-b");
    assert.equal(page2Fixed.has_more, false);

    // The accepted, unchanged half (matching listProposals' own L2 test):
    // a caller that has not adopted since_id yet gets exactly the old
    // query (created_at > since alone) -- boundary-b, sharing the exact
    // boundary timestamp, is still silently absent. Asserted so nobody
    // mistakes the fix above for having removed this pre-existing,
    // accepted limitation for an unupgraded caller.
    const page2Unupgraded = await citizenDirectory(env, (page1 as { next_since: number }).next_since);
    assert.equal(page2Unupgraded.returned, 0, "an old-style caller without since_id sees the pre-existing, accepted limitation, not a new regression");

    // Deliberately not exposed: citizen numeric ids are not a new public
    // per-row field of this fix -- id is read only for the tie-break and
    // the cursor, matching the citizens list's existing shape (handle,
    // model, karma, created_at).
    assert.deepEqual(Object.keys(page1.citizens[0]).sort(), ["created_at", "handle", "karma", "model"]);
  } finally {
    d1.close();
  }
});

test("citizenDirectory: an ordinary page with no collision is unaffected by the (created_at, id) tie-break", async () => {
  const d1 = createLocalD1();
  try {
    insertCitizen(d1, { handle: "alice" });
    insertCitizen(d1, { handle: "bob" });
    const env = testEnv(d1);
    const page = await citizenDirectory(env);
    assert.equal(page.returned, 2);
    assert.equal(page.has_more, false);
    assert.deepEqual(
      page.citizens.map((c) => c.handle),
      ["alice", "bob"],
    );
  } finally {
    d1.close();
  }
});

test("listProposals: an ordinary page with no collision is unaffected by the (created_at, id) tie-break", async () => {
  const d1 = createLocalD1();
  try {
    const proposer = insertCitizen(d1);
    const a = insertProposal(d1, { kind: "resolution", proposer_id: proposer });
    const b = insertProposal(d1, { kind: "resolution", proposer_id: proposer });
    const env = testEnv(d1);
    const page = await listProposals(env);
    assert.equal(page.returned, 2);
    assert.deepEqual(
      page.proposals.map((p) => p.id),
      [a, b],
    );
  } finally {
    d1.close();
  }
});

// ---------- chain append exhaustion (L5) ----------

// Wraps a real D1Like so every INSERT into the named table fails with the
// exact message shape a genuine SQLite/D1 UNIQUE violation carries
// (verified against real node:sqlite behaviour in local-d1.ts's own header
// before either was trusted), on every attempt -- forcing appendChained's
// 4-attempt retry loop to exhaust for real, not simulate the exhaustion by
// calling internals directly.
function withAlwaysColliding(DB: LocalD1["DB"], table: string): LocalD1["DB"] {
  const insertPattern = new RegExp(`^\\s*INSERT INTO ${table}\\b`, "i");
  return {
    prepare: (sql: string) => {
      const real = DB.prepare(sql);
      if (!insertPattern.test(sql)) return real;
      return {
        ...real,
        bind: (...args: unknown[]) => {
          const boundReal = real.bind(...args);
          return {
            ...boundReal,
            async run() {
              throw new Error(`UNIQUE constraint failed: ${table}.prev_hash`);
            },
          };
        },
      };
    },
    batch: (stmts) => DB.batch(stmts),
  };
}

// docs/REVIEW-DEMOCRACY.md L5 red-proof, via castBallot (appendChained's
// real, direct caller for the ballots chain -- one of the three tables
// this shared function serves when called without a Stmt suffix; payouts'
// own separate exhaustion throw, in payouts.ts, is not D1-testable here,
// see that file's own header on why, and is verified by inspection
// instead, recorded in docs/CHECKPOINT.md).
test("castBallot: a ballots chain-head collision surviving all four retries throws a named, retryable SocietyError, not chain.ts's old bare Error (would have mapped to an opaque 500)", async () => {
  const d1 = createLocalD1();
  try {
    const proposer = insertCitizen(d1);
    const voter = insertCitizen(d1);
    const proposalId = insertProposal(d1, { kind: "resolution", status: "open", proposer_id: proposer });
    const env = testEnv(d1);
    env.DB = withAlwaysColliding(d1.DB, "ballots");

    await assert.rejects(
      () => castBallot(env, { id: voter, created_at: Date.now() }, proposalId, "yes"),
      (e: unknown) => {
        assert.ok(e instanceof SocietyError, `expected a SocietyError, got ${e instanceof Error ? e.constructor.name : typeof e}`);
        const err = e as SocietyError;
        assert.equal(err.status, 503, "503 (retryable), not a bare Error that index.ts would map to an opaque 500");
        assert.match(err.message, /moved four times running/);
        assert.match(err.message, /retrying may succeed/i);
        return true;
      },
    );

    const count = d1.raw.prepare("SELECT COUNT(*) AS n FROM ballots").get() as { n: number };
    assert.equal(count.n, 0, "no partial ballot row survives an exhausted append");
  } finally {
    d1.close();
  }
});
