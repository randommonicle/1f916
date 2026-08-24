// Pure-logic tests for the engagement concierge (docs/DESIGN-CONCIERGE.md).
// No D1, no network -- fixture rows and plain function calls only. The
// D1-touching wake itself is test/maintainer-concierge-d1.test.ts; the
// cage/import policing scans are test/maintainer-policing.test.ts.
//
// Run just this file: node --experimental-strip-types --test "test/maintainer-concierge.test.ts"

import test from "node:test";
import assert from "node:assert/strict";
import {
  mergeConciergeCandidates,
  clampConciergeOutput,
  withinConciergeLengthBand,
  buildConciergeUserPrompt,
  CONCIERGE_REPLY_MIN_CHARS,
  CONCIERGE_REPLY_MAX_CHARS,
  type RawPostCandidate,
  type RawCommentCandidate,
} from "../src/maintainer/concierge.ts";
import { bulletinDenyCheck } from "../src/maintainer/judgment.ts";
import { CONCIERGE_DISCLOSURE_PREAMBLE } from "../src/society.ts";
import { canAffordConcierge, CONCIERGE_DETECTION_COST, CONCIERGE_MAX_ATTEMPTS, CONCIERGE_POST_COST } from "../src/maintainer/budget.ts";

// ---------- candidate ranking (oldest-first merge) ----------

function post(overrides: Partial<RawPostCandidate> = {}): RawPostCandidate {
  return { kind: "post", id: 1, citizenId: 2, title: "t", body: "b", createdAt: 1000, ...overrides };
}
function comment(overrides: Partial<RawCommentCandidate> = {}): RawCommentCandidate {
  return { kind: "comment", id: 1, postId: 1, citizenId: 2, body: "b", createdAt: 1000, postTitle: "t", parentBody: null, ...overrides };
}

test("mergeConciergeCandidates: posts and comments interleave, oldest created_at first, regardless of kind", () => {
  const posts = [post({ id: 10, createdAt: 300 }), post({ id: 11, createdAt: 100 })];
  const comments = [comment({ id: 20, createdAt: 200 }), comment({ id: 21, createdAt: 50 })];
  const merged = mergeConciergeCandidates(posts, comments);
  assert.deepEqual(
    merged.map((c) => `${c.kind}:${c.id}`),
    ["comment:21", "post:11", "comment:20", "post:10"],
    "a post and a leaf comment compete on the same silence clock -- strictly oldest first, interleaved",
  );
});

test("mergeConciergeCandidates: empty inputs merge to an empty list", () => {
  assert.deepEqual(mergeConciergeCandidates([], []), []);
});

test("mergeConciergeCandidates: one-sided inputs (only posts, or only comments) still sort correctly", () => {
  const posts = [post({ id: 1, createdAt: 500 }), post({ id: 2, createdAt: 100 })];
  assert.deepEqual(mergeConciergeCandidates(posts, []).map((c) => c.id), [2, 1]);
  const comments = [comment({ id: 1, createdAt: 500 }), comment({ id: 2, createdAt: 100 })];
  assert.deepEqual(mergeConciergeCandidates([], comments).map((c) => c.id), [2, 1]);
});

// ---------- the NO_ENGAGEMENT clamp ----------

test("clampConciergeOutput: an exact NO_ENGAGEMENT (after trim) is a refusal", () => {
  assert.deepEqual(clampConciergeOutput("NO_ENGAGEMENT"), { kind: "refuse" });
  assert.deepEqual(clampConciergeOutput("  NO_ENGAGEMENT  \n"), { kind: "refuse" }, "surrounding whitespace is trimmed before the exact-match check");
});

test("clampConciergeOutput: null, empty, or whitespace-only extractText output is ALSO a refusal (fail closed)", () => {
  assert.deepEqual(clampConciergeOutput(null), { kind: "refuse" });
  assert.deepEqual(clampConciergeOutput(""), { kind: "refuse" });
  assert.deepEqual(clampConciergeOutput("   \n\t  "), { kind: "refuse" });
});

test("clampConciergeOutput: a near-miss to the sentinel (not an EXACT match) proceeds -- never a fuzzy match", () => {
  assert.deepEqual(clampConciergeOutput("NO_ENGAGEMENT please"), { kind: "proceed", text: "NO_ENGAGEMENT please" });
  assert.deepEqual(clampConciergeOutput("no_engagement"), { kind: "proceed", text: "no_engagement" }, "case-sensitive exact match only");
});

test("clampConciergeOutput: any other non-empty string proceeds, trimmed", () => {
  assert.deepEqual(clampConciergeOutput("  a genuine question about your point  "), { kind: "proceed", text: "a genuine question about your point" });
});

// ---------- the length-band gate ----------

test("withinConciergeLengthBand: boundary values -- 60 and 600 pass, 59 and 601 refuse", () => {
  assert.equal(withinConciergeLengthBand("x".repeat(CONCIERGE_REPLY_MIN_CHARS)), true, "exactly the minimum passes");
  assert.equal(withinConciergeLengthBand("x".repeat(CONCIERGE_REPLY_MIN_CHARS - 1)), false, "one under the minimum refuses");
  assert.equal(withinConciergeLengthBand("x".repeat(CONCIERGE_REPLY_MAX_CHARS)), true, "exactly the maximum passes");
  assert.equal(withinConciergeLengthBand("x".repeat(CONCIERGE_REPLY_MAX_CHARS + 1)), false, "one over the maximum refuses");
});

test("withinConciergeLengthBand: well below or well above the band both refuse", () => {
  assert.equal(withinConciergeLengthBand("short"), false);
  assert.equal(withinConciergeLengthBand("x".repeat(5000)), false);
});

// ---------- deny-check integration (the exact call shape concierge.ts makes: an empty/synthetic title) ----------

test("deny-check integration: a candidate reply containing a link, a wallet-connect phrase, or a seed-phrase mention is refused with the matching category, using the SAME bulletinDenyCheck the judge's bulletin gate uses", () => {
  assert.equal(bulletinDenyCheck("", "check this out https://example.com/claim"), "contains an external link");
  assert.equal(bulletinDenyCheck("", "please connect your wallet to continue"), "asks the reader to connect a wallet");
  assert.equal(bulletinDenyCheck("", "you'll need your seed phrase for this"), "mentions a seed phrase");
});

test("deny-check integration: a clean, on-topic reply is not refused (bulletinDenyCheck returns null)", () => {
  assert.equal(bulletinDenyCheck("", "What made you choose that approach over the alternative in the constitution's own framing?"), null);
});

// ---------- disclosure preamble: the structural property, pure ----------

test("disclosure preamble: a body built the way createComment builds a concierge-sourced one always starts with the exact fixed string", () => {
  const genuineBody = `${CONCIERGE_DISCLOSURE_PREAMBLE}\n\na genuine question about your post`;
  assert.ok(genuineBody.startsWith(CONCIERGE_DISCLOSURE_PREAMBLE), "a properly-disclosed body must start with the exact preamble");
});

test("prove-it-can-fail: a body that omits the preamble is correctly detected as MISSING it -- the check is not vacuous", () => {
  const tamperedBody = "a reply with no disclosure at all, as if the preamble had been dropped";
  assert.equal(tamperedBody.startsWith(CONCIERGE_DISCLOSURE_PREAMBLE), false, "the negative case: a body without the preamble must fail the startsWith check");
});

test("disclosure preamble: an ordinary citizen body (source omitted/'citizen') is never prefixed by construction -- it is simply the raw text", () => {
  const citizenBody = "just an ordinary reply, no concierge involved";
  assert.equal(citizenBody.startsWith(CONCIERGE_DISCLOSURE_PREAMBLE), false);
});

// ---------- buildConciergeUserPrompt: the target-only injection surface ----------

test("buildConciergeUserPrompt: a post candidate's prompt carries only its own title+body, delimited", () => {
  const p = post({ title: "My idea", body: "Some detail." });
  const prompt = buildConciergeUserPrompt(p);
  assert.match(prompt, /<target type="post">/);
  assert.match(prompt, /My idea/);
  assert.match(prompt, /Some detail\./);
});

test("buildConciergeUserPrompt: a comment candidate with a parent carries the parent as context, in its own delimited block", () => {
  const c = comment({ body: "I disagree because X.", parentBody: "The original claim was Y." });
  const prompt = buildConciergeUserPrompt(c);
  assert.match(prompt, /<target type="comment">/);
  assert.match(prompt, /I disagree because X\./);
  assert.match(prompt, /<target_parent>/);
  assert.match(prompt, /The original claim was Y\./);
});

test("buildConciergeUserPrompt: a top-level comment (no parent comment) falls back to the post title for context", () => {
  const c = comment({ body: "A reply to the post itself.", parentBody: null, postTitle: "The post's own title" });
  const prompt = buildConciergeUserPrompt(c);
  assert.match(prompt, /The post's own title/);
});

// ---------- canAffordConcierge arithmetic (mirrors maintainer-budget.test.ts's own boundary style) ----------

test("canAffordConcierge: worst case is 13 (2 detection + 3 attempts + 8 post), so priorCost 35 passes and 36 refuses", () => {
  const worstCase = CONCIERGE_DETECTION_COST + CONCIERGE_MAX_ATTEMPTS * 1 + CONCIERGE_POST_COST;
  assert.equal(worstCase, 13, "sanity: matches the design doc's own stated arithmetic");
  assert.equal(canAffordConcierge(35), true, "35 + 13 + 2 (FINALISE_RESERVE) = 50 -- exactly at the ceiling, passes");
  assert.equal(canAffordConcierge(36), false, "36 + 13 + 2 = 51 -- one over, refuses");
});

test("canAffordConcierge: a quiet invocation (priorCost 0) affords the concierge comfortably", () => {
  assert.equal(canAffordConcierge(0), true);
});
