// D1-backed tests for governance.ts's founder/founding-ratification
// derivation and the ballot-casting concurrency behaviours design doc §13
// item 3 names explicitly. Uses test/helpers/local-d1.ts (node:sqlite,
// the real schema.sql, no new dependency) rather than a mock -- the
// architect's ruling on isFounderCitizen/isFoundingRatified, and design
// doc §13 item 3's own test list, both name D1-dependent behaviours no
// pure-function test can exercise honestly.
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
import { isFounderCitizen, isFoundingRatified, castBallot, createProposal } from "../src/governance.ts";
import { SocietyError } from "../src/society.ts";
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
