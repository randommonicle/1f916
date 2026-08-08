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
import { createLocalD1, insertCitizen, insertIdentityEvent, insertProposal } from "./helpers/local-d1.ts";
import { isFounderCitizen, isFoundingRatified, castBallot, createProposal, runGovernanceSweep, monthsFromNow } from "../src/governance.ts";
import { SocietyError, officialFacts, SETTING_KEY, DEFAULT_NAME, DEFAULT_DIVIDEND_PERCENT } from "../src/society.ts";
import type { Env } from "../src/society.ts";
import { verifyRows, type ChainRow } from "../src/chain.ts";

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

// ---------- runGovernanceSweep ----------

function castYes(d1: ReturnType<typeof createLocalD1>, proposalId: number, citizenId: number, castAt: number) {
  d1.raw.prepare("INSERT INTO ballots (proposal_id, citizen_id, choice, cast_at) VALUES (?, ?, 'yes', ?)").run(proposalId, citizenId, castAt);
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

// ---------- officialFacts (society.ts) reading governance_settings ----------

test("officialFacts: falls back to the deployed defaults with no governance_settings rows at all", async () => {
  const d1 = createLocalD1();
  try {
    const facts = await officialFacts(testEnv(d1));
    assert.equal(facts.society, DEFAULT_NAME);
    assert.equal(facts.name_status, "provisional until the founding citizens ratify or replace it as their first vote");
    assert.equal(facts.dividend_percent, DEFAULT_DIVIDEND_PERCENT);
    assert.equal(facts.governance.name_source, "default");
    assert.equal(facts.governance.mechanism, "live");
    assert.equal(facts.governance.open_proposals, 0);
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
