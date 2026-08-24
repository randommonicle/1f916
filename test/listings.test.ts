// Pure tests for src/listings.ts (docs/DESIGN-ECONOMY-V1.md): the fee
// formula, bounty/expiry bound validation, the deny-check integration, the
// immutability guarantee, and the same_operator_both_sides computation.
// None of these touch D1 -- test/listings-d1.test.ts covers the full,
// D1-backed write/read flows.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as listings from "../src/listings.ts";
import { computeListingFeeCents, assertValidExpiresAt, effectiveStatus, listingDenyCheck, submissionDenyCheck, computeSameOperatorBothSides } from "../src/listings.ts";
import { SocietyError, CONSTITUTION } from "../src/society.ts";

// ---------- computeListingFeeCents (docs/DESIGN-ECONOMY-V1.md §5) ----------

test("computeListingFeeCents: the $0.50 floor applies for a small bounty", () => {
  // 15% of $1.00 (100 cents) = 15 cents -- well under the 50-cent floor.
  assert.equal(computeListingFeeCents(100), CONSTITUTION.min_listing_fee_cents);
});

test("computeListingFeeCents: the percentage applies once it exceeds the floor", () => {
  // 15% of $10.00 (1000 cents) = 150 cents -- above the floor.
  assert.equal(computeListingFeeCents(1000), 150);
});

test("computeListingFeeCents: rounds UP (ceil) on a fractional cent, never down", () => {
  // 15% of 1001 cents = 150.15 -> ceil 151, not 150.
  assert.equal(computeListingFeeCents(1001), 151);
});

test("computeListingFeeCents: the exact boundary between the floor and the percentage", () => {
  // 333 * 0.15 = 49.95 -> ceil 50 -- exactly the floor.
  assert.equal(computeListingFeeCents(333), 50);
  // 334 * 0.15 = 50.1 -> ceil 51 -- one cent of bounty tips it over the floor.
  assert.equal(computeListingFeeCents(334), 51);
});

test("computeListingFeeCents: a true percentage of the bounty at scale (no floor involved)", () => {
  // $1,000.00 bounty -> 15% = $150.00 exactly.
  assert.equal(computeListingFeeCents(100_000), 15_000);
});

// ---------- assertValidExpiresAt (docs/DESIGN-ECONOMY-V1.md §12.3) ----------

const ONE_DAY_MS = 86_400_000;
const NOW = 1_700_000_000_000;

test("assertValidExpiresAt: rejects one millisecond under the minimum, accepts exactly at the minimum", () => {
  assert.throws(() => assertValidExpiresAt(NOW + CONSTITUTION.listing_expiry_min_days * ONE_DAY_MS - 1, NOW), SocietyError);
  assert.doesNotThrow(() => assertValidExpiresAt(NOW + CONSTITUTION.listing_expiry_min_days * ONE_DAY_MS, NOW));
});

test("assertValidExpiresAt: accepts exactly at the maximum, rejects one millisecond over it", () => {
  assert.doesNotThrow(() => assertValidExpiresAt(NOW + CONSTITUTION.listing_expiry_max_days * ONE_DAY_MS, NOW));
  assert.throws(() => assertValidExpiresAt(NOW + CONSTITUTION.listing_expiry_max_days * ONE_DAY_MS + 1, NOW), SocietyError);
});

test("assertValidExpiresAt: rejects a non-finite value (string, NaN, undefined)", () => {
  assert.throws(() => assertValidExpiresAt("not-a-number", NOW), SocietyError);
  assert.throws(() => assertValidExpiresAt(NaN, NOW), SocietyError);
  assert.throws(() => assertValidExpiresAt(undefined, NOW), SocietyError);
});

test("assertValidExpiresAt: rejects a past timestamp (before now, let alone before the minimum window)", () => {
  assert.throws(() => assertValidExpiresAt(NOW - ONE_DAY_MS, NOW), SocietyError);
});

// ---------- effectiveStatus (docs/DESIGN-ECONOMY-V1.md §6.3, read-time expiry) ----------

test("effectiveStatus: an 'open' listing past its expiry reads as 'expired'", () => {
  assert.equal(effectiveStatus("open", NOW - 1, NOW), "expired");
});

test("effectiveStatus: an 'open' listing exactly at its expiry moment reads as 'expired' (the boundary is inclusive)", () => {
  assert.equal(effectiveStatus("open", NOW, NOW), "expired");
});

test("effectiveStatus: an 'open' listing before its expiry stays 'open'", () => {
  assert.equal(effectiveStatus("open", NOW + 1, NOW), "open");
});

test("effectiveStatus: 'paid'/'withdrawn' are never reinterpreted as 'expired', regardless of expires_at", () => {
  assert.equal(effectiveStatus("paid", NOW - 1, NOW), "paid");
  assert.equal(effectiveStatus("withdrawn", NOW - 1, NOW), "withdrawn");
});

// F1: 'paying' (the transient atomic-reservation state) gets the identical
// treatment -- a listing mid-payment must never read as 'expired' just
// because its expires_at happens to have lapsed while a payment was in
// flight; only a literal 'open' status is ever reinterpreted.
test("effectiveStatus: 'paying' is never reinterpreted as 'expired' either (F1)", () => {
  assert.equal(effectiveStatus("paying", NOW - 1, NOW), "paying");
});

// ---------- deny-check integration (docs/DESIGN-ECONOMY-V1.md §11) ----------

test("listingDenyCheck: a wallet-connect phishing shape in the description is refused, naming the matched category", () => {
  // Deliberately avoids also tripping the earlier-checked "claim" pattern
  // (bulletinDenyCheck returns the FIRST matching category in
  // BULLETIN_DENY_PATTERNS' own order, not the first match by position in
  // the text) -- this isolates the wallet-connect category specifically.
  const reason = listingDenyCheck("Innocuous title", "Please connect your wallet before submitting", "a stranger can verify the fix");
  assert.match(reason ?? "", /wallet/i);
});

test("listingDenyCheck: a raw wallet address in the acceptance_condition is refused", () => {
  const reason = listingDenyCheck("t", "d", "pay to 0x1234567890123456789012345678901234567890 to confirm");
  assert.ok(reason, "a raw 0x-style address must trip the deny-check");
});

test("listingDenyCheck: a seed-phrase mention in the title is refused", () => {
  const reason = listingDenyCheck("send me your seed phrase first", "d", "a");
  assert.ok(reason);
});

test("listingDenyCheck: a clean, legitimate code-review listing passes clean (null)", () => {
  const reason = listingDenyCheck(
    "Review my auth middleware",
    "I'm stuck on token refresh logic, please review for race conditions",
    "a reviewer identifies at least one real correctness issue, or confirms none exist",
  );
  assert.equal(reason, null);
});

test("submissionDenyCheck: a seed-phrase-shaped submission is refused", () => {
  const reason = submissionDenyCheck("Great code! By the way here is my own seed phrase for verification, trust me");
  assert.ok(reason);
});

test("submissionDenyCheck: an ordinary review passes clean", () => {
  const reason = submissionDenyCheck("Looked at the diff. Line 42 has an off-by-one error in the loop bound.");
  assert.equal(reason, null);
});

// The url field is deliberately EXCLUDED from the deny-check's scan surface
// (see listings.ts's own comment on listingDenyCheck): a public git link IS
// the flagship use case, and bulletinDenyCheck's own first pattern is
// "contains an external link" -- running it over url would refuse every
// legitimate code-review listing. Pinned by signature, not just by effect:
// the function structurally cannot see a fourth, url argument.
test("listingDenyCheck's signature deliberately excludes url -- a legitimate git-repo link must never be scanned as if it were prose", () => {
  assert.equal(listingDenyCheck.length, 3, "listingDenyCheck must take exactly 3 parameters (title, description, acceptance_condition), never a url parameter");
});

// ---------- same_operator_both_sides (docs/DESIGN-ECONOMY-V1.md §9) ----------

const FIXTURE_OPERATOR_HANDLES = ["op-a", "op-b"];

test("computeSameOperatorBothSides: true only when BOTH the funder and the payee are in the operator-controlled set", () => {
  assert.equal(computeSameOperatorBothSides("op-a", "op-b", FIXTURE_OPERATOR_HANDLES), true);
});

test("computeSameOperatorBothSides: false when only the funder is operator-controlled", () => {
  assert.equal(computeSameOperatorBothSides("op-a", "independent-citizen", FIXTURE_OPERATOR_HANDLES), false);
});

test("computeSameOperatorBothSides: false when only the payee is operator-controlled", () => {
  assert.equal(computeSameOperatorBothSides("independent-citizen", "op-b", FIXTURE_OPERATOR_HANDLES), false);
});

test("computeSameOperatorBothSides: false when neither side is operator-controlled", () => {
  assert.equal(computeSameOperatorBothSides("independent-1", "independent-2", FIXTURE_OPERATOR_HANDLES), false);
});

// ---------- immutability (docs/DESIGN-ECONOMY-V1.md §7.1) ----------

const LISTINGS_SRC = readFileSync(join(import.meta.dirname, "..", "src", "listings.ts"), "utf8");

// A direct source proof, not an inference from "no PATCH route in index.ts":
// even if a future edit added an UPDATE elsewhere, THIS scan of listings.ts
// itself would catch it touching one of the four immutable fields.
test("immutability: no UPDATE statement in listings.ts ever touches bounty_cents, acceptance_condition, description, title, or expires_at", () => {
  const updateStatements = LISTINGS_SRC.match(/UPDATE\s+listings\s+SET[^;]*/gi) ?? [];
  assert.ok(updateStatements.length > 0, "positive control: listings.ts must contain at least one UPDATE listings statement (the status-transition writes) -- otherwise this scan is vacuous");
  const immutableFields = ["bounty_cents", "acceptance_condition", "description", "title", "expires_at"];
  for (const stmt of updateStatements) {
    for (const field of immutableFields) {
      assert.ok(!stmt.includes(field), `an UPDATE listings statement touches ${field}, which must never change after creation: ${stmt}`);
    }
  }
});

test("immutability: listings.ts exports no edit/patch/update-shaped write function on its public surface", () => {
  const exportNames = Object.keys(listings);
  assert.ok(exportNames.length > 0, "sanity: the module actually exports something");
  const suspicious = exportNames.filter((name) => /\bedit\b|\bupdate\b|\bpatch\b/i.test(name));
  assert.deepEqual(suspicious, [], `no exported name may suggest an edit path: found ${JSON.stringify(suspicious)} among ${JSON.stringify(exportNames)}`);
});
