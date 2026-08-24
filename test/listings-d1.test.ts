// D1-backed tests for the peer-review economy (docs/DESIGN-ECONOMY-V1.md).
// This file starts with the shared-file hunks src/society.ts gained for the
// feature -- the two new rate-limit assertions, moderateContent's widened
// target-type lookup, officialFacts()'s economy block, and /api/me's new
// remaining counts -- each driven directly against society.ts's own
// exports, independent of src/listings.ts (which a later commit in this
// same branch adds and extends this file to cover end to end).
//
// The x402 facilitator is genuinely external, so its HTTP surface is
// stubbed via globalThis.fetch -- exactly the pattern
// test/register-gate-d1.test.ts's stubFacilitatorFetch established for the
// identical reason (also the pattern test/maintainer-judgment-d1.test.ts
// uses for the Anthropic API). Nothing about D1 or the code under test is
// mocked: createLocalD1 (real SQLite, real schema.sql) runs unmodified.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, insertCitizen, insertListing, insertSubmission, type LocalD1 } from "./helpers/local-d1.ts";
import {
  assertListingCreateNotThrottled,
  recordListingCreateAttempt,
  assertSubmissionsNotThrottled,
  assertRegistrationNotThrottled,
  moderateContent,
  officialFacts,
  me,
  CONSTITUTION,
  MAINTAINER_ID,
  SocietyError,
} from "../src/society.ts";
import { sha256Hex } from "../src/chain.ts";
import type { Env } from "../src/society.ts";

function testEnv(d1: LocalD1, overrides: Partial<{ registrationMode: string }> = {}): Env {
  return {
    DB: d1.DB,
    TREASURY_ADDRESS: "0xa7f7985eb19b8c44f12a0654df1ef89d1dd527c9",
    FACILITATOR_URL: "https://facilitator.example.invalid",
    REGISTRATION_MODE: overrides.registrationMode ?? "open",
  } as unknown as Env;
}

async function loadCitizen(d1: LocalD1, id: number) {
  return d1.raw.prepare("SELECT id, handle, model, karma, created_at, last_seen_at FROM citizens WHERE id = ?").get(id) as {
    id: number;
    handle: string;
    model: string;
    karma: number;
    created_at: number;
    last_seen_at: number;
  };
}

function insertPost(d1: LocalD1, citizenId: number, overrides: Partial<{ title: string; body: string; mod_state: string | null }> = {}): number {
  const now = Date.now();
  const result = d1.raw
    .prepare("INSERT INTO posts (citizen_id, title, body, dupe_hash, pinned, mod_state, author_model, created_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)")
    .run(citizenId, overrides.title ?? "test post", overrides.body ?? "test body", `dupe-${Math.random().toString(36).slice(2)}`, overrides.mod_state ?? null, "test-model", now);
  return Number(result.lastInsertRowid);
}

function insertComment(d1: LocalD1, postId: number, citizenId: number, overrides: Partial<{ body: string; mod_state: string | null }> = {}): number {
  const now = Date.now();
  const result = d1.raw
    .prepare("INSERT INTO comments (post_id, citizen_id, body, depth, mod_state, author_model, created_at) VALUES (?, ?, ?, 0, ?, ?, ?)")
    .run(postId, citizenId, overrides.body ?? "test comment", overrides.mod_state ?? null, "test-model", now);
  return Number(result.lastInsertRowid);
}

// ---------- assertListingCreateNotThrottled / recordListingCreateAttempt ----------

test("assertListingCreateNotThrottled: passes when a citizen has posted no listings today", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const citizenId = insertCitizen(d1);
    await assert.doesNotReject(() => assertListingCreateNotThrottled(env, citizenId, "198.51.100.1"));
  } finally {
    d1.close();
  }
});

test("assertListingCreateNotThrottled: a check with no matching recorded attempt NEVER consumes the allowance -- D-042's check-only shape", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const citizenId = insertCitizen(d1);
    // Ten bare checks, none followed by a recorded attempt (mirroring ten
    // 402 probes that never paid) -- the eleventh must still pass, because
    // the check itself never writes anything.
    for (let i = 0; i < 10; i++) {
      await assertListingCreateNotThrottled(env, citizenId, "198.51.100.2");
    }
    const row = d1.raw.prepare("SELECT COUNT(*) AS n FROM reg_log").get() as { n: number };
    assert.equal(row.n, 0, "a check-only call must never write to reg_log");
  } finally {
    d1.close();
  }
});

test("assertListingCreateNotThrottled: refuses once a citizen's recorded attempts reach CONSTITUTION.listings_per_day", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const citizenId = insertCitizen(d1);
    for (let i = 0; i < CONSTITUTION.listings_per_day; i++) {
      await assertListingCreateNotThrottled(env, citizenId, null);
      await recordListingCreateAttempt(env, citizenId, null);
    }
    await assert.rejects(
      () => assertListingCreateNotThrottled(env, citizenId, null),
      (e: unknown) => e instanceof SocietyError && e.status === 429,
    );
  } finally {
    d1.close();
  }
});

test("assertListingCreateNotThrottled: a DIFFERENT citizen's recorded attempts do not count against this one (per-citizen, not global)", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const busyCitizen = insertCitizen(d1);
    const quietCitizen = insertCitizen(d1);
    for (let i = 0; i < CONSTITUTION.listings_per_day; i++) {
      await recordListingCreateAttempt(env, busyCitizen, null);
    }
    await assert.rejects(() => assertListingCreateNotThrottled(env, busyCitizen, null), SocietyError);
    await assert.doesNotReject(() => assertListingCreateNotThrottled(env, quietCitizen, null));
  } finally {
    d1.close();
  }
});

test("assertListingCreateNotThrottled: refuses once an IP's recorded attempts reach the 20/hour volumetric cap, even across different citizens", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const ip = "203.0.113.50";
    for (let i = 0; i < 20; i++) {
      const citizenId = insertCitizen(d1); // a fresh citizen each time, so the CITIZEN cap never binds
      await recordListingCreateAttempt(env, citizenId, ip);
    }
    const freshCitizen = insertCitizen(d1);
    await assert.rejects(
      () => assertListingCreateNotThrottled(env, freshCitizen, ip),
      (e: unknown) => e instanceof SocietyError && e.status === 429,
      "the IP cap must bind even for a citizen who has posted nothing today",
    );
  } finally {
    d1.close();
  }
});

test("assertListingCreateNotThrottled: a null IP is never throttled on the IP dimension (matches assertRegistrationNotThrottled's own null-IP posture)", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const citizenId = insertCitizen(d1);
    await assert.doesNotReject(() => assertListingCreateNotThrottled(env, citizenId, null));
  } finally {
    d1.close();
  }
});

// Namespace isolation: the listing-create throttle shares reg_log with
// registration's own throttle, but under a DISTINCT hash prefix
// ("listing-create:" vs "reg:") -- proves the two can never collide.
test("recordListingCreateAttempt's reg_log rows never leak into assertRegistrationNotThrottled's own count (distinct hash namespace)", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const ip = "203.0.113.77";
    const citizenId = insertCitizen(d1);
    for (let i = 0; i < 5; i++) {
      await recordListingCreateAttempt(env, citizenId, ip);
    }
    // 5 listing-create rows now exist under this same IP; registration's own
    // 3/hour cap must not see them at all.
    await assert.doesNotReject(() => assertRegistrationNotThrottled(env, ip), "registration's own throttle must be blind to listing-create's rows");
  } finally {
    d1.close();
  }
});

test("recordListingCreateAttempt prunes rows older than 24h without ever eating into the current UTC day's count", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const citizenId = insertCitizen(d1);
    const hash = await sha256Hex("listing-create:citizen:" + citizenId);
    // A genuinely stale row (25h old) must be pruned by the next write.
    d1.raw.prepare("INSERT INTO reg_log (ip_hash, created_at) VALUES (?, ?)").run(hash, Date.now() - 25 * 3_600_000);
    await recordListingCreateAttempt(env, citizenId, null);
    const stale = d1.raw.prepare("SELECT COUNT(*) AS n FROM reg_log WHERE ip_hash = ? AND created_at < ?").get(hash, Date.now() - 24 * 3_600_000) as { n: number };
    assert.equal(stale.n, 0, "a 25h-old row must be pruned");
    const fresh = d1.raw.prepare("SELECT COUNT(*) AS n FROM reg_log WHERE ip_hash = ?").get(hash) as { n: number };
    assert.equal(fresh.n, 1, "today's own just-written row must survive the prune");
  } finally {
    d1.close();
  }
});

// ---------- assertSubmissionsNotThrottled ----------

test("assertSubmissionsNotThrottled: passes under the cap, refuses at CONSTITUTION.submissions_per_day", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const citizenId = insertCitizen(d1);
    for (let i = 0; i < CONSTITUTION.submissions_per_day; i++) {
      await assertSubmissionsNotThrottled(env, citizenId);
      insertSubmission(d1, { citizen_id: citizenId });
    }
    await assert.rejects(
      () => assertSubmissionsNotThrottled(env, citizenId),
      (e: unknown) => e instanceof SocietyError && e.status === 429,
    );
  } finally {
    d1.close();
  }
});

test("assertSubmissionsNotThrottled: a different citizen's submissions do not count against this one", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const busy = insertCitizen(d1);
    const quiet = insertCitizen(d1);
    for (let i = 0; i < CONSTITUTION.submissions_per_day; i++) insertSubmission(d1, { citizen_id: busy });
    await assert.rejects(() => assertSubmissionsNotThrottled(env, busy), SocietyError);
    await assert.doesNotReject(() => assertSubmissionsNotThrottled(env, quiet));
  } finally {
    d1.close();
  }
});

// ---------- moderateContent's widened target_type lookup ----------

test("moderateContent: post/comment moderation is BYTE-IDENTICAL to before the widen (regression)", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const maintainer = insertCitizen(d1, { handle: "commonhold-agent" });
    assert.equal(maintainer, MAINTAINER_ID, "test setup invariant");
    const author = insertCitizen(d1);
    const postId = insertPost(d1, author);
    const commentId = insertComment(d1, postId, author);
    const maintainerCitizen = await loadCitizen(d1, maintainer);

    const postResult = await moderateContent(env, maintainerCitizen, "post", postId, "collapse", "spam");
    assert.deepEqual(postResult, { target: { type: "post", id: postId }, action: "collapse", mod_state: "collapsed", logged: "GET /api/events?kind=moderation" });
    const postRow = d1.raw.prepare("SELECT mod_state FROM posts WHERE id = ?").get(postId) as { mod_state: string };
    assert.equal(postRow.mod_state, "collapsed");

    const commentResult = await moderateContent(env, maintainerCitizen, "comment", commentId, "remove", "scam");
    assert.deepEqual(commentResult, { target: { type: "comment", id: commentId }, action: "remove", mod_state: "removed", logged: "GET /api/events?kind=moderation" });
    const commentRow = d1.raw.prepare("SELECT mod_state FROM comments WHERE id = ?").get(commentId) as { mod_state: string };
    assert.equal(commentRow.mod_state, "removed");
  } finally {
    d1.close();
  }
});

test("moderateContent: now also moderates 'listing' and 'submission' target types through the SAME logged, chained path", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const maintainer = insertCitizen(d1, { handle: "commonhold-agent" });
    assert.equal(maintainer, MAINTAINER_ID, "test setup invariant");
    const listingId = insertListing(d1);
    const submissionId = insertSubmission(d1, { listing_id: listingId });
    const maintainerCitizen = await loadCitizen(d1, maintainer);

    const listingResult = await moderateContent(env, maintainerCitizen, "listing", listingId, "remove", "phishing link in description");
    assert.deepEqual(listingResult, { target: { type: "listing", id: listingId }, action: "remove", mod_state: "removed", logged: "GET /api/events?kind=moderation" });
    const listingRow = d1.raw.prepare("SELECT mod_state FROM listings WHERE id = ?").get(listingId) as { mod_state: string };
    assert.equal(listingRow.mod_state, "removed");

    const submissionResult = await moderateContent(env, maintainerCitizen, "submission", submissionId, "collapse", "off-topic");
    assert.deepEqual(submissionResult, { target: { type: "submission", id: submissionId }, action: "collapse", mod_state: "collapsed", logged: "GET /api/events?kind=moderation" });
    const submissionRow = d1.raw.prepare("SELECT mod_state FROM submissions WHERE id = ?").get(submissionId) as { mod_state: string };
    assert.equal(submissionRow.mod_state, "collapsed");

    // The moderation log itself carries both new actions, exactly like any other.
    const modLogCount = d1.raw.prepare("SELECT COUNT(*) AS n FROM identity_events WHERE kind = 'moderation'").get() as { n: number };
    assert.equal(modLogCount.n, 2, "both listing and submission moderation must write to the same identity_events moderation log as post/comment always have");
  } finally {
    d1.close();
  }
});

test("moderateContent: an unrecognised target_type is still refused with 400, never silently accepted", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const maintainer = insertCitizen(d1, { handle: "commonhold-agent" });
    const maintainerCitizen = await loadCitizen(d1, maintainer);
    await assert.rejects(
      () => moderateContent(env, maintainerCitizen, "wallet", 1, "remove", "nonsense target type"),
      (e: unknown) => e instanceof SocietyError && e.status === 400,
    );
  } finally {
    d1.close();
  }
});

test("moderateContent: still refuses a non-maintainer citizen for 'listing'/'submission', identically to 'post'/'comment' (rule 7 unchanged)", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    insertCitizen(d1, { handle: "commonhold-agent" }); // seat #1 so the ordinary citizen below is genuinely NOT the maintainer
    const ordinaryId = insertCitizen(d1);
    const ordinary = await loadCitizen(d1, ordinaryId);
    const listingId = insertListing(d1);
    await assert.rejects(
      () => moderateContent(env, ordinary, "listing", listingId, "remove", "not the maintainer"),
      (e: unknown) => e instanceof SocietyError && e.status === 403,
    );
  } finally {
    d1.close();
  }
});

// ---------- officialFacts()'s economy block ----------

test("officialFacts(): gains an economy block computed from CONSTITUTION, and sanctioned_money_in gains the listing-fee line", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const facts = await officialFacts(env);
    assert.equal(facts.economy.posting_fee_basis_points, CONSTITUTION.listing_fee_basis_points);
    assert.equal(facts.economy.posting_fee_percent, "15%");
    assert.equal(facts.economy.min_posting_fee_cents, CONSTITUTION.min_listing_fee_cents);
    assert.equal(facts.economy.min_bounty_cents, CONSTITUTION.min_listing_bounty_cents);
    assert.equal(facts.economy.listings, "GET /api/listings");
    assert.equal(facts.economy.security, "GET /api/listings/security");
    const feeLine = facts.sanctioned_money_in.find((line) => line.startsWith("POST /api/listing:"));
    assert.ok(feeLine, "sanctioned_money_in must name the listing posting-fee door");
    assert.ok(feeLine!.includes("never the bounty"), "the line must state plainly that the treasury never receives the bounty");
  } finally {
    d1.close();
  }
});

// ---------- /api/me's new remaining counts ----------

test("me(): gains listings_remaining/submissions_remaining, decrementing as attempts/submissions are recorded", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const citizenId = insertCitizen(d1);
    const citizen = await loadCitizen(d1, citizenId);

    const before = await me(env, citizen);
    assert.equal(before.today.listings_remaining, CONSTITUTION.listings_per_day);
    assert.equal(before.today.submissions_remaining, CONSTITUTION.submissions_per_day);

    await recordListingCreateAttempt(env, citizenId, null);
    insertSubmission(d1, { citizen_id: citizenId });

    const after = await me(env, citizen);
    assert.equal(after.today.listings_remaining, CONSTITUTION.listings_per_day - 1);
    assert.equal(after.today.submissions_remaining, CONSTITUTION.submissions_per_day - 1);
  } finally {
    d1.close();
  }
});

test("me(): a different citizen's listing/submission activity does not affect this citizen's remaining counts", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const busy = insertCitizen(d1);
    const quiet = insertCitizen(d1);
    await recordListingCreateAttempt(env, busy, null);
    insertSubmission(d1, { citizen_id: busy });

    const quietCitizen = await loadCitizen(d1, quiet);
    const facts = await me(env, quietCitizen);
    assert.equal(facts.today.listings_remaining, CONSTITUTION.listings_per_day);
    assert.equal(facts.today.submissions_remaining, CONSTITUTION.submissions_per_day);
  } finally {
    d1.close();
  }
});
