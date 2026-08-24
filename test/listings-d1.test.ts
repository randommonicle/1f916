// D1-backed tests for the peer-review economy (docs/DESIGN-ECONOMY-V1.md).
// Two parts. The FIRST covers the shared-file hunks src/society.ts gained
// for the feature -- the two new rate-limit assertions, moderateContent's
// widened target-type lookup, officialFacts()'s economy block, and
// /api/me's new remaining counts -- driven directly against society.ts's
// own exports. The SECOND, below, drives src/listings.ts's full write/read
// flows end to end through its real HTTP-shaped handlers: create-via-fee,
// submit, pay (the server-side-authority proof that payTo/amount are NEVER
// taken from the request body), the double-pay guarded-UPDATE race,
// withdraw, read-time expiry, and a wallet-less reviewer's free refusal.
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
  checkAndRecordListingPayNotThrottled,
  assertSubmissionsNotThrottled,
  assertRegistrationNotThrottled,
  moderateContent,
  officialFacts,
  me,
  CONSTITUTION,
  MAINTAINER_ID,
  SocietyError,
} from "../src/society.ts";
import { handleCreateListing, createSubmission, handlePayListing, withdrawListing, listListings, getListingDetail, listingPaymentsPage, computeListingFeeCents } from "../src/listings.ts";
import { sha256Hex } from "../src/chain.ts";
import type { Env } from "../src/society.ts";

const TREASURY_ADDRESS = "0xa7f7985eb19b8c44f12a0654df1ef89d1dd527c9";
const FACILITATOR_URL = "https://facilitator.example.invalid";

function testEnv(d1: LocalD1, overrides: Partial<{ registrationMode: string }> = {}): Env {
  return {
    DB: d1.DB,
    TREASURY_ADDRESS,
    FACILITATOR_URL,
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

// ---------- F2: checkAndRecordListingPayNotThrottled (record-first) ----------
//
// F2 fix (post-review): the old assertListingPayNotThrottled/
// recordListingPayAttempt pair was check-then-record, called sequentially
// -- a genuine concurrent burst could have every request read the count
// BEFORE any of them recorded (Codex's own reproduction: 50 concurrent
// same-IP attempts through the old pair, 50/50 fulfilled). This single
// function records first, so the D-042 "a bare check never consumes the
// allowance" shape the OLD tests below pinned no longer applies here BY
// DESIGN -- every call, including one that goes on to refuse, writes its
// own reg_log row. That is the whole point: a concurrent burst is refused
// before it can reach payAndSettle's facilitator round trip, not merely
// after the fact.

test("checkAndRecordListingPayNotThrottled: passes under the cap; a null IP is never throttled AND never recorded", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    await assert.doesNotReject(() => checkAndRecordListingPayNotThrottled(env, "203.0.113.91"));
    await assert.doesNotReject(() => checkAndRecordListingPayNotThrottled(env, null));
    const row = d1.raw.prepare("SELECT COUNT(*) AS n FROM reg_log").get() as { n: number };
    assert.equal(row.n, 1, "only the real-IP call recorded -- the null-IP call must be a complete no-op, never writing a row");
  } finally {
    d1.close();
  }
});

// Only proves the under-cap case (10 < 20, every call passes); the refused-
// call-still-records case is proven separately and more precisely by the
// count-includes-the-just-recorded-row boundary test below (its own
// rowsAfter21 assertion is exactly that: the 21st, REFUSED, call still left
// a row). Titled to match only what this test body actually drives.
test("checkAndRecordListingPayNotThrottled: every under-cap call records its own row immediately -- there is no such thing as a free check on this cap (record-first, not D-042's check-only shape)", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const ip = "203.0.113.94";
    for (let i = 0; i < 10; i++) {
      await checkAndRecordListingPayNotThrottled(env, ip);
    }
    const row = d1.raw.prepare("SELECT COUNT(*) AS n FROM reg_log").get() as { n: number };
    assert.equal(row.n, 10, "every call must record its own row immediately -- record-first, not check-then-record");
  } finally {
    d1.close();
  }
});

test("checkAndRecordListingPayNotThrottled: the count INCLUDES the just-recorded row -- the 20th call still passes (count 20), the 21st is refused (count 21 > 20)", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const ip = "203.0.113.90";
    for (let i = 0; i < 20; i++) {
      await assert.doesNotReject(() => checkAndRecordListingPayNotThrottled(env, ip), `attempt ${i + 1} (count ${i + 1}) must still pass -- the cap is 20, not 19`);
    }
    const rowsAfter20 = d1.raw.prepare("SELECT COUNT(*) AS n FROM reg_log WHERE ip_hash = ?").get(await sha256Hex("listing-pay:ip:" + ip)) as { n: number };
    assert.equal(rowsAfter20.n, 20, "sanity: exactly 20 rows recorded so far");

    await assert.rejects(
      () => checkAndRecordListingPayNotThrottled(env, ip),
      (e: unknown) => e instanceof SocietyError && e.status === 429,
      "the 21st attempt (count 21, including its own just-recorded row) must be refused",
    );
    const rowsAfter21 = d1.raw.prepare("SELECT COUNT(*) AS n FROM reg_log WHERE ip_hash = ?").get(await sha256Hex("listing-pay:ip:" + ip)) as { n: number };
    assert.equal(rowsAfter21.n, 21, "the 21st attempt still recorded its own row even though it was refused -- record-first, not record-on-success");
  } finally {
    d1.close();
  }
});

test("checkAndRecordListingPayNotThrottled: a DIFFERENT IP's recorded attempts do not count against this one", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const busyIp = "203.0.113.95";
    const quietIp = "203.0.113.96";
    for (let i = 0; i < 20; i++) await checkAndRecordListingPayNotThrottled(env, busyIp);
    await assert.rejects(() => checkAndRecordListingPayNotThrottled(env, busyIp), SocietyError);
    await assert.doesNotReject(() => checkAndRecordListingPayNotThrottled(env, quietIp));
  } finally {
    d1.close();
  }
});

// Namespace isolation, mirroring the identical listing-create proof above:
// listing-pay's own reg_log rows must never leak into a DIFFERENT throttle's
// count, in EITHER direction.
test("checkAndRecordListingPayNotThrottled's reg_log rows never leak into assertListingCreateNotThrottled's own count (distinct hash namespace)", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const ip = "203.0.113.92";
    for (let i = 0; i < 20; i++) await checkAndRecordListingPayNotThrottled(env, ip);
    const citizenId = insertCitizen(d1);
    await assert.doesNotReject(() => assertListingCreateNotThrottled(env, citizenId, ip), "listing-create's own throttle must be blind to listing-pay's rows");
  } finally {
    d1.close();
  }
});

test("checkAndRecordListingPayNotThrottled prunes rows older than 24h without ever eating into the current hour's count", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const ip = "203.0.113.97";
    const hash = await sha256Hex("listing-pay:ip:" + ip);
    d1.raw.prepare("INSERT INTO reg_log (ip_hash, created_at) VALUES (?, ?)").run(hash, Date.now() - 25 * 3_600_000);
    await checkAndRecordListingPayNotThrottled(env, ip);
    const stale = d1.raw.prepare("SELECT COUNT(*) AS n FROM reg_log WHERE ip_hash = ? AND created_at < ?").get(hash, Date.now() - 24 * 3_600_000) as { n: number };
    assert.equal(stale.n, 0, "a 25h-old row must be pruned");
    const fresh = d1.raw.prepare("SELECT COUNT(*) AS n FROM reg_log WHERE ip_hash = ?").get(hash) as { n: number };
    assert.equal(fresh.n, 1, "the just-written row must survive the prune");
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

// ============================================================================
// PART TWO: src/listings.ts's full write/read flows, end to end, through
// its real HTTP-shaped handlers.
// ============================================================================

function fakePaymentHeader(): string {
  return btoa(JSON.stringify({ fake: "payment-payload-for-a-test-stub" }));
}

function insertWallet(d1: LocalD1, citizenId: number, address: string): void {
  d1.raw.prepare("INSERT INTO wallets (citizen_id, address, added_at) VALUES (?, ?, ?)").run(citizenId, address, Date.now());
}

function listingCreateRequest(bodyOverrides: Record<string, unknown> = {}, withPayment = true): Request {
  const now = Date.now();
  const body = {
    title: "Review my auth middleware",
    description: "Stuck on token refresh, please review for race conditions",
    acceptance_condition: "a reviewer identifies at least one real correctness issue or confirms none exist",
    bounty_cents: 1000,
    expires_at: now + 7 * 86_400_000,
    ...bodyOverrides,
  };
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (withPayment) headers["X-PAYMENT"] = fakePaymentHeader();
  return new Request("https://example.test/api/listing", { method: "POST", headers, body: JSON.stringify(body) });
}

function payRequest(listingId: number, submissionId: number, extra: Record<string, unknown> = {}): Request {
  const body = { submission_id: submissionId, ...extra };
  return new Request(`https://example.test/api/listing/${listingId}/pay`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-PAYMENT": fakePaymentHeader() },
    body: JSON.stringify(body),
  });
}

// F2: identical to payRequest above, but carrying a CF-Connecting-IP header
// -- needed only by the throttle end-to-end proof, which must drive real
// requests from a consistent, known IP.
function payRequestFromIp(listingId: number, submissionId: number, ip: string): Request {
  return new Request(`https://example.test/api/listing/${listingId}/pay`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-PAYMENT": fakePaymentHeader(), "CF-Connecting-IP": ip },
    body: JSON.stringify({ submission_id: submissionId }),
  });
}

// Stubs the facilitator's /verify and /settle, exactly as
// register-gate-d1.test.ts's stubFacilitatorFetch does. Captures the LAST
// settle request's own paymentRequirements (payTo, maxAmountRequired) so
// tests can assert on exactly what was actually signed-for, independent of
// what a request body claimed.
function stubFacilitatorFetch(settle: { payer?: string; transaction?: string } = {}) {
  const original = globalThis.fetch;
  let verifyCalls = 0;
  let settleCalls = 0;
  let lastSettleReqs: { payTo?: string; maxAmountRequired?: string } | null = null;
  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    const href = String(url);
    if (href === `${FACILITATOR_URL}/verify`) {
      verifyCalls++;
      return new Response(JSON.stringify({ isValid: true }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (href === `${FACILITATOR_URL}/settle`) {
      settleCalls++;
      const parsed = typeof init?.body === "string" ? (JSON.parse(init.body) as { paymentRequirements?: { payTo?: string; maxAmountRequired?: string } }) : {};
      lastSettleReqs = parsed.paymentRequirements ?? null;
      return new Response(
        JSON.stringify({ success: true, payer: settle.payer ?? "0x00000000000000000000000000000000000abc", transaction: settle.transaction ?? "0xfeedfeedfeed" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected fetch in listings-d1.test.ts: ${href}`);
  }) as typeof fetch;
  return {
    verifyCalls: () => verifyCalls,
    settleCalls: () => settleCalls,
    lastSettlePayTo: () => lastSettleReqs?.payTo,
    lastSettleAmount: () => lastSettleReqs?.maxAmountRequired,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

// ---------- POST /api/listing: create-via-fee end to end ----------

test("handleCreateListing: no X-PAYMENT header returns 402 naming the requirements, never touches D1", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const funderId = insertCitizen(d1);
    const funder = await loadCitizen(d1, funderId);
    const res = await handleCreateListing(listingCreateRequest({}, false), env, funder);
    assert.equal(res.status, 402);
    const listingCount = d1.raw.prepare("SELECT COUNT(*) AS n FROM listings").get() as { n: number };
    assert.equal(listingCount.n, 0);
  } finally {
    d1.close();
  }
});

test("handleCreateListing: end to end -- 402 then settle produces a listings row with the FORMULA fee, a matching ledger line, and a receipt", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitatorFetch();
  try {
    const env = testEnv(d1);
    const funderId = insertCitizen(d1, { handle: "funder-one" });
    const funder = await loadCitizen(d1, funderId);
    const res = await handleCreateListing(listingCreateRequest({ bounty_cents: 1000 }), env, funder);
    assert.equal(res.status, 201, JSON.stringify(await res.clone().json()));
    const payload = (await res.json()) as { listing_id: number; bounty_cents: number; fee_cents: number; status: string; receipt: string };
    assert.equal(payload.bounty_cents, 1000);
    assert.equal(payload.fee_cents, computeListingFeeCents(1000));
    assert.equal(payload.status, "open");
    assert.equal(stub.verifyCalls(), 1);
    assert.equal(stub.settleCalls(), 1);

    const row = d1.raw.prepare("SELECT funder_citizen_id, bounty_cents, fee_cents, fee_tx, status FROM listings WHERE id = ?").get(payload.listing_id) as {
      funder_citizen_id: number;
      bounty_cents: number;
      fee_cents: number;
      fee_tx: string;
      status: string;
    };
    assert.equal(row.funder_citizen_id, funderId);
    assert.equal(row.fee_cents, computeListingFeeCents(1000));
    assert.equal(row.status, "open");

    const ledgerRow = d1.raw.prepare("SELECT amount_cents, description FROM ledger ORDER BY id DESC LIMIT 1").get() as { amount_cents: number; description: string };
    assert.equal(ledgerRow.amount_cents, computeListingFeeCents(1000), "the ledger line must book exactly the fee, never the bounty");
    assert.match(ledgerRow.description, /listing posting fee/);

    // The x402 payTo for the FEE must be the treasury -- the default,
    // unchanged, per the spec's own "payTo stays the treasury" step.
    assert.equal(stub.lastSettlePayTo(), TREASURY_ADDRESS);
    assert.equal(stub.lastSettleAmount(), String(computeListingFeeCents(1000) * 10_000));
  } finally {
    stub.restore();
    d1.close();
  }
});

test("handleCreateListing: an invalid bounty is refused BEFORE the facilitator is ever called (free refusal, D-042)", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitatorFetch();
  try {
    const env = testEnv(d1);
    const funderId = insertCitizen(d1);
    const funder = await loadCitizen(d1, funderId);
    await assert.rejects(
      () => handleCreateListing(listingCreateRequest({ bounty_cents: 1 }), env, funder),
      (e: unknown) => e instanceof SocietyError && e.status === 400,
    );
    assert.equal(stub.verifyCalls(), 0, "an invalid bounty must never reach the facilitator");
    assert.equal(stub.settleCalls(), 0);
  } finally {
    stub.restore();
    d1.close();
  }
});

// ---------- E3: assertValidBountyCents' full boundary (via handleCreateListing, its only public surface) ----------

test("handleCreateListing: a fractional bounty_cents is refused -- REJECTED, never silently rounded (E3)", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitatorFetch();
  try {
    const env = testEnv(d1);
    const funderId = insertCitizen(d1);
    const funder = await loadCitizen(d1, funderId);
    await assert.rejects(
      () => handleCreateListing(listingCreateRequest({ bounty_cents: 1000.5 }), env, funder),
      (e: unknown) => e instanceof SocietyError && e.status === 400 && /fractional/i.test(e.message),
    );
    assert.equal(stub.verifyCalls(), 0, "a fractional bounty must never reach the facilitator");
  } finally {
    stub.restore();
    d1.close();
  }
});

test("handleCreateListing: a bounty_cents that is NOT a safe integer is refused, distinctly from the fractional case (E3)", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitatorFetch();
  try {
    const env = testEnv(d1);
    const funderId = insertCitizen(d1);
    const funder = await loadCitizen(d1, funderId);
    // 2**53 is Number.isInteger-true (whole-number-shaped) but
    // Number.isSafeInteger-false -- exercises the SECOND, distinct check,
    // not the fractional one above.
    await assert.rejects(
      () => handleCreateListing(listingCreateRequest({ bounty_cents: 2 ** 53 }), env, funder),
      (e: unknown) => e instanceof SocietyError && e.status === 400 && /safe integer/i.test(e.message),
    );
    assert.equal(stub.verifyCalls(), 0, "a non-safe-integer bounty must never reach the facilitator");
  } finally {
    stub.restore();
    d1.close();
  }
});

test("handleCreateListing: a bounty_cents above CONSTITUTION.max_listing_bounty_cents is refused (E3's new ceiling)", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitatorFetch();
  try {
    const env = testEnv(d1);
    const funderId = insertCitizen(d1);
    const funder = await loadCitizen(d1, funderId);
    await assert.rejects(
      () => handleCreateListing(listingCreateRequest({ bounty_cents: CONSTITUTION.max_listing_bounty_cents + 1 }), env, funder),
      (e: unknown) => e instanceof SocietyError && e.status === 400,
    );
    assert.equal(stub.verifyCalls(), 0, "an above-ceiling bounty must never reach the facilitator");
  } finally {
    stub.restore();
    d1.close();
  }
});

test("handleCreateListing: bounty_cents at EXACTLY the min floor and EXACTLY the max ceiling are BOTH accepted (the boundaries themselves are inside the valid range)", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitatorFetch();
  try {
    const env = testEnv(d1);
    const funderId = insertCitizen(d1);
    const funder = await loadCitizen(d1, funderId);

    const atMin = await handleCreateListing(listingCreateRequest({ title: "at the floor", bounty_cents: CONSTITUTION.min_listing_bounty_cents }), env, funder);
    assert.equal(atMin.status, 201, JSON.stringify(await atMin.clone().json()));

    const atMax = await handleCreateListing(listingCreateRequest({ title: "at the ceiling", bounty_cents: CONSTITUTION.max_listing_bounty_cents }), env, funder);
    assert.equal(atMax.status, 201, JSON.stringify(await atMax.clone().json()));
  } finally {
    stub.restore();
    d1.close();
  }
});

test("handleCreateListing: a phishing-shaped description is refused BEFORE the facilitator is ever called", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitatorFetch();
  try {
    const env = testEnv(d1);
    const funderId = insertCitizen(d1);
    const funder = await loadCitizen(d1, funderId);
    await assert.rejects(
      () => handleCreateListing(listingCreateRequest({ description: "connect your wallet before submitting a review" }), env, funder),
      (e: unknown) => e instanceof SocietyError && e.status === 400,
    );
    assert.equal(stub.verifyCalls(), 0);
  } finally {
    stub.restore();
    d1.close();
  }
});

test("handleCreateListing: rate-cap shed -- once a citizen's listings_per_day is spent, the next attempt is refused for free", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitatorFetch();
  try {
    const env = testEnv(d1);
    const funderId = insertCitizen(d1);
    const funder = await loadCitizen(d1, funderId);
    for (let i = 0; i < CONSTITUTION.listings_per_day; i++) {
      const res = await handleCreateListing(listingCreateRequest({ title: `listing ${i}` }), env, funder);
      assert.equal(res.status, 201);
    }
    const callsBefore = stub.settleCalls();
    await assert.rejects(
      () => handleCreateListing(listingCreateRequest({ title: "one too many" }), env, funder),
      (e: unknown) => e instanceof SocietyError && e.status === 429,
    );
    assert.equal(stub.settleCalls(), callsBefore, "the shed attempt must never reach settle");
  } finally {
    stub.restore();
    d1.close();
  }
});

// ---------- POST /api/submission ----------

test("createSubmission: a citizen with no declared wallet is refused for free -- an unpayable submission wastes everyone's time", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const listingId = insertListing(d1);
    const citizenId = insertCitizen(d1);
    const citizen = await loadCitizen(d1, citizenId);
    await assert.rejects(
      () => createSubmission(env, citizen, listingId, "a real review", null),
      (e: unknown) => e instanceof SocietyError && e.status === 409,
    );
    const count = d1.raw.prepare("SELECT COUNT(*) AS n FROM submissions").get() as { n: number };
    assert.equal(count.n, 0);
  } finally {
    d1.close();
  }
});

test("createSubmission: a walleted citizen submits successfully against an open listing", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const listingId = insertListing(d1);
    const citizenId = insertCitizen(d1);
    insertWallet(d1, citizenId, "0x000000000000000000000000000000000000cc");
    const citizen = await loadCitizen(d1, citizenId);
    const result = await createSubmission(env, citizen, listingId, "a genuinely careful review", "https://gist.example/review");
    assert.ok(result.submission_id);
    const row = d1.raw.prepare("SELECT listing_id, citizen_id, body, status FROM submissions WHERE id = ?").get(result.submission_id) as {
      listing_id: number;
      citizen_id: number;
      body: string;
      status: string;
    };
    assert.equal(row.listing_id, listingId);
    assert.equal(row.citizen_id, citizenId);
    assert.equal(row.status, "open");
  } finally {
    d1.close();
  }
});

test("createSubmission: refused against a listing that has expired", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const listingId = insertListing(d1, { expires_at: Date.now() - 1000 });
    const citizenId = insertCitizen(d1);
    insertWallet(d1, citizenId, "0x000000000000000000000000000000000000cc");
    const citizen = await loadCitizen(d1, citizenId);
    await assert.rejects(
      () => createSubmission(env, citizen, listingId, "too late", null),
      (e: unknown) => e instanceof SocietyError && e.status === 409,
    );
  } finally {
    d1.close();
  }
});

// ---------- POST /api/listing/:id/pay: the server-side-authority proof ----------

test("handlePayListing: payTo is derived from the submission's citizen -> walletFor, NEVER from the request body (server-side-authority proof)", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitatorFetch();
  try {
    const env = testEnv(d1);
    const funderId = insertCitizen(d1);
    const funder = await loadCitizen(d1, funderId);
    const reviewerId = insertCitizen(d1);
    const REAL_WALLET = "0x00000000000000000000000000000000000ee1";
    const ATTACKER_WALLET = "0x00000000000000000000000000000000000bad";
    insertWallet(d1, reviewerId, REAL_WALLET);
    const listingId = insertListing(d1, { funder_citizen_id: funderId, bounty_cents: 2500 });
    const submissionId = insertSubmission(d1, { listing_id: listingId, citizen_id: reviewerId });

    // The request body carries EXTRA, adversarial fields a naive
    // implementation might have read -- a bogus payTo and a wildly
    // inflated amount. The regression this test would catch: a version of
    // handlePayListing that trusted request.payTo or request.amount_cents
    // instead of deriving them from the stored row.
    const request = payRequest(listingId, submissionId, { payTo: ATTACKER_WALLET, amount_cents: 999_999_999 });
    const res = await handlePayListing(request, env, funder, listingId);
    assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));

    assert.equal(stub.lastSettlePayTo(), REAL_WALLET, "payTo actually signed-for must be the reviewer's REAL declared wallet");
    assert.notEqual(stub.lastSettlePayTo(), ATTACKER_WALLET, "the request body's payTo must be completely ignored");
    assert.equal(stub.lastSettleAmount(), String(2500 * 10_000), "the amount actually signed-for must be the STORED bounty");
    assert.notEqual(stub.lastSettleAmount(), String(999_999_999 * 10_000), "the request body's amount_cents must be completely ignored");

    const paymentRow = d1.raw.prepare("SELECT payee_address, amount_cents FROM listing_payments WHERE listing_id = ?").get(listingId) as {
      payee_address: string;
      amount_cents: number;
    };
    assert.equal(paymentRow.payee_address, REAL_WALLET);
    assert.equal(paymentRow.amount_cents, 2500);

    // The runtime complement to listings-policing.test.ts's source scan:
    // this fixture never went through the fee-paying create flow (the
    // listing was seeded directly), so the ledger started empty. If the
    // bounty payment were ever wrongly booked as treasury income, this
    // would catch it directly, not just infer it from the source.
    const ledgerCount = d1.raw.prepare("SELECT COUNT(*) AS n FROM ledger").get() as { n: number };
    assert.equal(ledgerCount.n, 0, "paying a bounty must never add a ledger row -- the treasury is not party to this payment");
  } finally {
    stub.restore();
    d1.close();
  }
});

test("handlePayListing: a wallet-less reviewer is refused for free -- the facilitator is never called", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitatorFetch();
  try {
    const env = testEnv(d1);
    const funderId = insertCitizen(d1);
    const funder = await loadCitizen(d1, funderId);
    const reviewerId = insertCitizen(d1); // no wallet declared
    const listingId = insertListing(d1, { funder_citizen_id: funderId });
    const submissionId = insertSubmission(d1, { listing_id: listingId, citizen_id: reviewerId });
    await assert.rejects(
      () => handlePayListing(payRequest(listingId, submissionId), env, funder, listingId),
      (e: unknown) => e instanceof SocietyError && e.status === 409,
    );
    assert.equal(stub.verifyCalls(), 0, "a wallet-less reviewer must be refused before any payment is even requested");
  } finally {
    stub.restore();
    d1.close();
  }
});

test("handlePayListing: only the listing's funder may pay -- another citizen is refused with 403", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const funderId = insertCitizen(d1);
    const strangerId = insertCitizen(d1);
    const stranger = await loadCitizen(d1, strangerId);
    const reviewerId = insertCitizen(d1);
    insertWallet(d1, reviewerId, "0x000000000000000000000000000000000000dd");
    const listingId = insertListing(d1, { funder_citizen_id: funderId });
    const submissionId = insertSubmission(d1, { listing_id: listingId, citizen_id: reviewerId });
    await assert.rejects(
      () => handlePayListing(payRequest(listingId, submissionId), env, stranger, listingId),
      (e: unknown) => e instanceof SocietyError && e.status === 403,
    );
  } finally {
    d1.close();
  }
});

test("handlePayListing: the 21st pay attempt from one IP within an hour is refused (429) BEFORE any settle -- F2 records every attempt up front, not after", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitatorFetch();
  try {
    const env = testEnv(d1);
    const funderId = insertCitizen(d1);
    const funder = await loadCitizen(d1, funderId);
    const reviewerId = insertCitizen(d1);
    insertWallet(d1, reviewerId, "0x00000000000000000000000000000000000dd1");
    const listingId = insertListing(d1, { funder_citizen_id: funderId, bounty_cents: 1000 });
    const submissionId = insertSubmission(d1, { listing_id: listingId, citizen_id: reviewerId });
    const ip = "203.0.113.93";
    for (let i = 0; i < 20; i++) await checkAndRecordListingPayNotThrottled(env, ip);

    const verifyCallsBefore = stub.verifyCalls();
    const settleCallsBefore = stub.settleCalls();
    await assert.rejects(
      () => handlePayListing(payRequestFromIp(listingId, submissionId, ip), env, funder, listingId),
      (e: unknown) => e instanceof SocietyError && e.status === 429,
    );
    assert.equal(stub.verifyCalls(), verifyCallsBefore, "the 21st attempt must never reach the facilitator's /verify either -- capped before the round trip, not during it");
    assert.equal(stub.settleCalls(), settleCallsBefore, "the 21st attempt must never reach settle");
  } finally {
    stub.restore();
    d1.close();
  }
});

// ---------- F1: the atomic reservation ('open' -> 'paying' -> 'paid'/'open') ----------
//
// The old "guarded UPDATE at settle time" design let two concurrent payers
// BOTH genuinely settle (both signatures verified, both facilitator calls
// succeeded) and only decided a winner afterwards. F1 replaces that with a
// reservation made BEFORE settle, inside payAndSettle's afterVerify: only
// one caller can ever flip 'open'->'paying' for a given listing, so a
// second concurrent caller (or a retry against a stuck/paid listing) is
// refused BEFORE it can ask the facilitator to move any money at all. The
// four tests below walk the states this produces: a genuine concurrent
// race (serialised, not merely won/lost), a free refusal against an
// already-'paying' listing, a free refusal against an already-'paid'
// listing, a settle failure (releases back to 'open', retryable), and a
// post-settle record failure (stays 'paying' -- a durable tombstone,
// never reverted to 'open', so a retry can never double-pay).

test("concurrent double-click: two truly-interleaved pay attempts for the same listing -- the reserve serialises them; the loser is refused BEFORE it ever reaches settle", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const funderId = insertCitizen(d1);
    const funder = await loadCitizen(d1, funderId);
    const reviewerAId = insertCitizen(d1);
    const reviewerBId = insertCitizen(d1);
    insertWallet(d1, reviewerAId, "0x00000000000000000000000000000000000aaa");
    insertWallet(d1, reviewerBId, "0x00000000000000000000000000000000000bbb");
    const listingId = insertListing(d1, { funder_citizen_id: funderId, bounty_cents: 1000 });
    const submissionAId = insertSubmission(d1, { listing_id: listingId, citizen_id: reviewerAId });
    const submissionBId = insertSubmission(d1, { listing_id: listingId, citizen_id: reviewerBId });

    const original = globalThis.fetch;
    let verifyCalls = 0;
    let settleCalls = 0;
    // The hook is A's own /verify call, not /settle: by the time A's
    // mocked /verify responds, A has already run loadPayableListing (saw
    // 'open') but has NOT yet reserved -- afterVerify (the reserve UPDATE)
    // only runs AFTER verify returns, per payAndSettle's own contract ("If
    // afterVerify throws, settle() is never called"). Triggering B's
    // ENTIRE flow from inside A's /verify response is the genuine
    // interleaving point: B also sees 'open' at its own loadPayableListing,
    // and B's own reserve, verify, settle, and record all run to
    // completion BEFORE A's own /verify call even returns.
    globalThis.fetch = (async (url: unknown) => {
      const href = String(url);
      if (href === `${FACILITATOR_URL}/verify`) {
        const myVerifyIndex = ++verifyCalls; // captured immediately, before any nested recursion can move the shared counter further
        if (myVerifyIndex === 1) {
          const bRes = await handlePayListing(payRequest(listingId, submissionBId), env, funder, listingId);
          const bBody = (await bRes.json()) as { listing_marked_paid: boolean };
          assert.equal(bRes.status, 200);
          assert.equal(bBody.listing_marked_paid, true, "B's own nested flow, running to completion while A is still mid-verify, must win the reserve and settle cleanly");
        }
        return new Response(JSON.stringify({ isValid: true }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (href === `${FACILITATOR_URL}/settle`) {
        settleCalls++;
        return new Response(JSON.stringify({ success: true, payer: "0x00000000000000000000000000000000payer1", transaction: "0xtx-1" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected fetch in concurrent double-click test: ${href}`);
    }) as typeof fetch;

    try {
      await assert.rejects(
        () => handlePayListing(payRequest(listingId, submissionAId), env, funder, listingId),
        (e: unknown) => e instanceof SocietyError && e.status === 409,
        "A's own reserve attempt must be refused -- B already flipped 'open'->'paying'->'paid' while A was mid-verify",
      );
    } finally {
      globalThis.fetch = original;
    }

    assert.equal(verifyCalls, 2, "both A and B genuinely reached and passed verify");
    assert.equal(settleCalls, 1, "only B ever reached settle -- A's own afterVerify threw BEFORE settle was ever called, so A's money was never even asked to move");

    const paymentRows = d1.raw.prepare("SELECT submission_id, tx FROM listing_payments WHERE listing_id = ?").all(listingId) as Array<{ submission_id: number; tx: string }>;
    assert.equal(paymentRows.length, 1, "only ONE settled payment exists -- A never settled, so there is nothing of A's to record (this is the fix: F1's old behaviour recorded two)");
    assert.equal(paymentRows[0]!.submission_id, submissionBId);

    const listingRow = d1.raw.prepare("SELECT status, paid_submission_id, paid_tx FROM listings WHERE id = ?").get(listingId) as {
      status: string;
      paid_submission_id: number;
      paid_tx: string;
    };
    assert.equal(listingRow.status, "paid");
    assert.equal(listingRow.paid_submission_id, submissionBId);
  } finally {
    d1.close();
  }
});

test("handlePayListing: a pay attempt against a listing already reserved by a concurrent pay ('paying') is refused 409 for FREE -- never reaches the facilitator", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitatorFetch();
  try {
    const env = testEnv(d1);
    const funderId = insertCitizen(d1);
    const funder = await loadCitizen(d1, funderId);
    const reviewerId = insertCitizen(d1);
    insertWallet(d1, reviewerId, "0x00000000000000000000000000000000000ee3");
    const listingId = insertListing(d1, { funder_citizen_id: funderId, bounty_cents: 1000, status: "paying" });
    const submissionId = insertSubmission(d1, { listing_id: listingId, citizen_id: reviewerId });

    await assert.rejects(
      () => handlePayListing(payRequest(listingId, submissionId), env, funder, listingId),
      (e: unknown) => e instanceof SocietyError && e.status === 409 && /not open/i.test(e.message),
    );
    assert.equal(stub.verifyCalls(), 0, "a 'paying' listing is refused at loadPayableListing, BEFORE payAndSettle is even called -- a free refusal, like every other non-open status");
  } finally {
    stub.restore();
    d1.close();
  }
});

test("handlePayListing: a second pay attempt against an already-'paid' listing is refused 409 -- never a double settle", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitatorFetch();
  try {
    const env = testEnv(d1);
    const funderId = insertCitizen(d1);
    const funder = await loadCitizen(d1, funderId);
    const reviewerId = insertCitizen(d1);
    insertWallet(d1, reviewerId, "0x00000000000000000000000000000000000ee2");
    const listingId = insertListing(d1, { funder_citizen_id: funderId, bounty_cents: 1000 });
    const submissionId = insertSubmission(d1, { listing_id: listingId, citizen_id: reviewerId });

    const first = await handlePayListing(payRequest(listingId, submissionId), env, funder, listingId);
    assert.equal(first.status, 200, JSON.stringify(await first.clone().json()));
    const settleCallsAfterFirst = stub.settleCalls();
    const verifyCallsAfterFirst = stub.verifyCalls();

    const secondSubmissionId = insertSubmission(d1, { listing_id: listingId, citizen_id: reviewerId });
    await assert.rejects(
      () => handlePayListing(payRequest(listingId, secondSubmissionId), env, funder, listingId),
      (e: unknown) => e instanceof SocietyError && e.status === 409,
    );
    // The refusal must be FREE -- loadPayableListing's own status check
    // catches it BEFORE payAndSettle is even called, so the retry never
    // touches the facilitator at all (D-042's discipline), not merely
    // "never reaches settle" (which the reserve alone would also
    // guarantee, one layer later and one facilitator round trip later).
    assert.equal(stub.verifyCalls(), verifyCallsAfterFirst, "a retry against an already-paid listing must never even reach verify -- refused at loadPayableListing, for free");
    assert.equal(stub.settleCalls(), settleCallsAfterFirst, "a retry against an already-paid listing must never reach settle a second time");
  } finally {
    stub.restore();
    d1.close();
  }
});

test("handlePayListing: a settle failure after a successful reserve releases the listing back to 'open' -- retryable, never permanently stuck", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const funderId = insertCitizen(d1);
    const funder = await loadCitizen(d1, funderId);
    const reviewerId = insertCitizen(d1);
    insertWallet(d1, reviewerId, "0x00000000000000000000000000000000000ee4");
    const listingId = insertListing(d1, { funder_citizen_id: funderId, bounty_cents: 1000 });
    const submissionId = insertSubmission(d1, { listing_id: listingId, citizen_id: reviewerId });

    const original = globalThis.fetch;
    globalThis.fetch = (async (url: unknown) => {
      const href = String(url);
      if (href === `${FACILITATOR_URL}/verify`) {
        return new Response(JSON.stringify({ isValid: true }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (href === `${FACILITATOR_URL}/settle`) {
        // The signature verified, so afterVerify's reserve genuinely ran
        // (status flipped to 'paying' at this exact instant) -- but
        // settlement itself fails at the facilitator (insufficient funds,
        // an expired authorization, whatever the reason).
        return new Response(JSON.stringify({ success: false, errorReason: "insufficient_funds" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error(`unexpected fetch in settle-failure test: ${href}`);
    }) as typeof fetch;

    let res: Response;
    try {
      res = await handlePayListing(payRequest(listingId, submissionId), env, funder, listingId);
    } finally {
      globalThis.fetch = original;
    }
    assert.equal(res.status, 402, "a failed settlement is the ordinary x402 402 response, not a 500 and not a silent success");

    const listingRow = d1.raw.prepare("SELECT status FROM listings WHERE id = ?").get(listingId) as { status: string };
    assert.equal(listingRow.status, "open", "the reserve must be RELEASED on a settle failure -- the funder can retry, never permanently locked out by our own reservation");

    const paymentCount = d1.raw.prepare("SELECT COUNT(*) AS n FROM listing_payments WHERE listing_id = ?").get(listingId) as { n: number };
    assert.equal(paymentCount.n, 0);
  } finally {
    d1.close();
  }
});

test("handlePayListing: an invalid signature (verify fails) never even reaches the reserve -- the release UPDATE afterwards is a harmless no-op, listing stays 'open'", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const funderId = insertCitizen(d1);
    const funder = await loadCitizen(d1, funderId);
    const reviewerId = insertCitizen(d1);
    insertWallet(d1, reviewerId, "0x00000000000000000000000000000000000ee5");
    const listingId = insertListing(d1, { funder_citizen_id: funderId, bounty_cents: 1000 });
    const submissionId = insertSubmission(d1, { listing_id: listingId, citizen_id: reviewerId });

    const original = globalThis.fetch;
    let settleCalls = 0;
    globalThis.fetch = (async (url: unknown) => {
      const href = String(url);
      if (href === `${FACILITATOR_URL}/verify`) {
        return new Response(JSON.stringify({ isValid: false, invalidReason: "bad_signature" }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (href === `${FACILITATOR_URL}/settle`) {
        settleCalls++;
        throw new Error("settle must never be reached when verify fails");
      }
      throw new Error(`unexpected fetch in invalid-signature test: ${href}`);
    }) as typeof fetch;

    let res: Response;
    try {
      res = await handlePayListing(payRequest(listingId, submissionId), env, funder, listingId);
    } finally {
      globalThis.fetch = original;
    }
    assert.equal(res.status, 402);
    assert.equal(settleCalls, 0, "afterVerify (and therefore the reserve) never runs when verify itself fails -- payAndSettle returns before either");

    const listingRow = d1.raw.prepare("SELECT status FROM listings WHERE id = ?").get(listingId) as { status: string };
    assert.equal(listingRow.status, "open", "the post-failure release UPDATE (WHERE status='paying') is a harmless 0-row no-op here -- the listing was never reserved");
  } finally {
    d1.close();
  }
});

test("handlePayListing: a simulated record-batch failure after a successful settle leaves the listing at 'paying', NOT 'open' -- the durable tombstone that prevents a double-pay, and the failure is logged loudly", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitatorFetch();
  const originalConsoleLog = console.log;
  const logged: string[] = [];
  console.log = (msg: string) => logged.push(msg);
  try {
    const env = testEnv(d1);
    const funderId = insertCitizen(d1);
    const funder = await loadCitizen(d1, funderId);
    const reviewerId = insertCitizen(d1);
    insertWallet(d1, reviewerId, "0x00000000000000000000000000000000000ccc");
    const listingId = insertListing(d1, { funder_citizen_id: funderId, bounty_cents: 1000 });
    const submissionId = insertSubmission(d1, { listing_id: listingId, citizen_id: reviewerId });

    // A DB wrapper that lets everything through to the REAL local-D1 engine
    // (so the reserve UPDATE and the real BEGIN/COMMIT/ROLLBACK transaction
    // test/helpers/local-d1.ts's own batch() provides are both exercised
    // for real) EXCEPT the FIRST statement of the ONE batch handlePayListing
    // issues on success (the listing_payments INSERT, per F1's new
    // [insertStmt, updateStmt] order), swapped for a deliberately-broken
    // INSERT (omits listing_payments' own NOT NULL columns) so it genuinely,
    // deterministically fails inside that same transaction -- a real
    // "simulated INSERT failure", not a mocked rejection.
    const brokenEnv: Env = {
      ...env,
      DB: {
        prepare: (sql: string) => env.DB.prepare(sql),
        batch: async (stmts: unknown[]) => {
          assert.equal(stmts.length, 2, "handlePayListing must batch exactly the listing_payments INSERT and the status='paid' UPDATE together");
          const broken = env.DB.prepare("INSERT INTO listing_payments (listing_id) VALUES (?)").bind(listingId);
          return env.DB.batch([broken, stmts[1]] as never[]);
        },
      } as unknown as Env["DB"],
    };

    await assert.rejects(
      () => handlePayListing(payRequest(listingId, submissionId), brokenEnv, funder, listingId),
      (e: unknown) => e instanceof SocietyError && e.status === 500 && /settled.*but recording it failed/i.test(e.message),
    );

    assert.ok(
      logged.some((l) => l.includes("listing_pay_settled_but_unrecorded") && l.includes(listingId.toString())),
      "the settled-but-unrecorded failure must be logged loudly, naming this listing",
    );

    const listingRow = d1.raw.prepare("SELECT status, paid_submission_id, paid_tx FROM listings WHERE id = ?").get(listingId) as {
      status: string;
      paid_submission_id: number | null;
      paid_tx: string | null;
    };
    assert.equal(
      listingRow.status,
      "paying",
      "the reserve is a DURABLE tombstone: a batch failure must NOT revert to 'open' (that would let a retry double-pay) and must NOT advance to 'paid' (the whole batch rolled back)",
    );
    assert.equal(listingRow.paid_submission_id, null, "the UPDATE to 'paid' rolled back together with the INSERT -- same atomic batch");
    assert.equal(listingRow.paid_tx, null);

    const paymentCount = d1.raw.prepare("SELECT COUNT(*) AS n FROM listing_payments WHERE listing_id = ?").get(listingId) as { n: number };
    assert.equal(paymentCount.n, 0, "no partial listing_payments row either -- the whole batch rolled back together, atomically");

    // The tombstone does its job: a retry (even against a fresh submission)
    // must be refused before it can ever reach the facilitator again.
    const retrySubmissionId = insertSubmission(d1, { listing_id: listingId, citizen_id: reviewerId });
    const settleCallsBeforeRetry = stub.settleCalls();
    await assert.rejects(
      () => handlePayListing(payRequest(listingId, retrySubmissionId), env, funder, listingId),
      (e: unknown) => e instanceof SocietyError && e.status === 409,
      "a retry against a 'paying' listing must be refused, never a second settle",
    );
    assert.equal(stub.settleCalls(), settleCallsBeforeRetry, "the retry must never reach settle -- refused at loadPayableListing, before payAndSettle is even called");
  } finally {
    console.log = originalConsoleLog;
    stub.restore();
    d1.close();
  }
});

// ---------- F1: listListings' "open" feed excludes a 'paying' listing ----------

test("listListings: a listing mid-payment ('paying') is excluded from the 'open' feed -- it is not open for new submissions", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const openId = insertListing(d1, { status: "open" });
    const payingId = insertListing(d1, { status: "paying" });

    const openFeed = await listListings(env, "open", NaN);
    assert.ok(openFeed.listings.some((l: { id: number }) => l.id === openId), "the genuinely open listing must appear");
    assert.ok(!openFeed.listings.some((l: { id: number }) => l.id === payingId), "a 'paying' listing must NOT appear in the open feed -- it is not open for new submissions");

    const detail = await getListingDetail(env, payingId);
    assert.equal(detail.listing.status, "paying", "getListingDetail shows the TRUE status, unmasked");
  } finally {
    d1.close();
  }
});

// ---------- POST /api/listing/:id/withdraw ----------

test("withdrawListing: the funder withdraws an open listing; the fee is explicitly NOT refunded", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const funderId = insertCitizen(d1);
    const funder = await loadCitizen(d1, funderId);
    const listingId = insertListing(d1, { funder_citizen_id: funderId });
    const result = await withdrawListing(env, funder, listingId);
    assert.equal(result.status, "withdrawn");
    assert.match(result.note, /not refunded/i);
    const row = d1.raw.prepare("SELECT status FROM listings WHERE id = ?").get(listingId) as { status: string };
    assert.equal(row.status, "withdrawn");
  } finally {
    d1.close();
  }
});

test("withdrawListing: only the funder may withdraw -- another citizen is refused with 403, and the listing stays open", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const funderId = insertCitizen(d1);
    const strangerId = insertCitizen(d1);
    const stranger = await loadCitizen(d1, strangerId);
    const listingId = insertListing(d1, { funder_citizen_id: funderId });
    await assert.rejects(
      () => withdrawListing(env, stranger, listingId),
      (e: unknown) => e instanceof SocietyError && e.status === 403,
    );
    const row = d1.raw.prepare("SELECT status FROM listings WHERE id = ?").get(listingId) as { status: string };
    assert.equal(row.status, "open");
  } finally {
    d1.close();
  }
});

test("withdrawListing: a listing already withdrawn cannot be withdrawn again", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const funderId = insertCitizen(d1);
    const funder = await loadCitizen(d1, funderId);
    const listingId = insertListing(d1, { funder_citizen_id: funderId, status: "withdrawn" });
    await assert.rejects(
      () => withdrawListing(env, funder, listingId),
      (e: unknown) => e instanceof SocietyError && e.status === 409,
    );
  } finally {
    d1.close();
  }
});

// ---------- read-time expiry ----------

test("listListings/getListingDetail: an 'open' listing past its expires_at reads as 'expired' WITHOUT any write to the row", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const listingId = insertListing(d1, { expires_at: Date.now() - 1000, status: "open" });

    const detail = await getListingDetail(env, listingId);
    assert.equal(detail.listing.status, "expired");

    const feed = await listListings(env, "expired", NaN);
    assert.ok(feed.listings.some((l: { id: number }) => l.id === listingId), "the expired-view feed must surface it");

    const openFeed = await listListings(env, "open", NaN);
    assert.ok(!openFeed.listings.some((l: { id: number }) => l.id === listingId), "the open-view feed must NOT surface an expired-but-DB-open listing");

    const raw = d1.raw.prepare("SELECT status FROM listings WHERE id = ?").get(listingId) as { status: string };
    assert.equal(raw.status, "open", "the underlying row must be untouched -- expiry is read-time-computed, not written back");
  } finally {
    d1.close();
  }
});

// ---------- GET /api/listings/payments ----------

test("listingPaymentsPage: carries the same_operator_both_sides disclosure and is NOT part of the chain", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const funderId = insertCitizen(d1, { handle: "op-funder" });
    const reviewerId = insertCitizen(d1, { handle: "op-reviewer" });
    const listingId = insertListing(d1, { funder_citizen_id: funderId, bounty_cents: 500 });
    const submissionId = insertSubmission(d1, { listing_id: listingId, citizen_id: reviewerId });
    d1.raw
      .prepare("INSERT INTO listing_payments (listing_id, submission_id, payee_citizen_id, payee_address, payer_address, amount_cents, tx, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(listingId, submissionId, reviewerId, "0x00000000000000000000000000000000000ffe", "0x00000000000000000000000000000000000ffd", 500, "0xpaytx", Date.now());

    const page = await listingPaymentsPage(env);
    assert.equal(page.total_paid_cents, 500);
    assert.equal(page.entries.length, 1);
    assert.equal((page.entries[0] as { same_operator_both_sides: boolean }).same_operator_both_sides, false, "neither op-funder nor op-reviewer are in the real OPERATOR_CONTROLLED_HANDLES set");
    assert.ok(!("prev_hash" in page.entries[0]!) && !("hash" in page.entries[0]!), "listing_payments is deliberately unchained -- no chain fields on its rows");
  } finally {
    d1.close();
  }
});
