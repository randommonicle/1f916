// Policing tests for the listings economy's money-correctness invariants
// (docs/DESIGN-ECONOMY-V1.md §14), mirroring test/maintainer-policing.test.ts's
// and test/chain.test.ts's own convention: a source-level scan of the real
// file, not a fixture -- proving a property about the CODE, not merely
// about what one test happened to exercise.
//
// Two invariants, each with a positive control so the scan cannot pass
// vacuously (prove-it-can-fail):
//
//   (a) the pay endpoint's payTo (and amount) are NEVER read from the
//       request body -- only from the stored submission -> walletFor and
//       the stored listing's own bounty_cents. This is the
//       server-side-authority guarantee test/listings-d1.test.ts's own
//       "payTo is derived from the submission's citizen -> walletFor,
//       NEVER from the request body" test proves at runtime for one
//       concrete request; this file proves it cannot be true only by luck
//       of what that one test happened to send.
//   (b) the funder -> reviewer bounty payment is NEVER booked to the
//       treasury's chained ledger -- only the posting fee is a ledger
//       line. listing_payments is deliberately unchained (migrations/
//       0009_listings.sql's own header); a ledger entry for the bounty
//       would quietly re-introduce the treasury as a party to money that
//       is supposed to never touch it.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const LISTINGS_PATH = join(import.meta.dirname, "..", "src", "listings.ts");

// M6, chain.test.ts's own lesson (maintainer-policing.test.ts's header
// repeats it): a bare-word or bare-string scan trips on a comment that
// merely discusses the thing by name -- this file's own header comment
// above is a perfect example. Strip comments before any scan runs.
function readSourceWithoutComments(path: string): string {
  const text = readFileSync(path, "utf8");
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

// Extracts one top-level `export ...` declaration's own body text, from its
// signature up to (but not including) the NEXT top-level `export`. Good
// enough for this file's own flat, sequential shape (no nested exports);
// the two scans below use this to check ONLY the function under test, not
// the whole file, so a violation is pinned to the actual offending
// function rather than merely "somewhere in listings.ts".
function extractExportBody(source: string, signature: string): string {
  const idx = source.indexOf(signature);
  assert.ok(idx !== -1, `test fixture assumption broken: "${signature}" not found in listings.ts -- did the function get renamed?`);
  const rest = source.slice(idx);
  const nextExportIdx = rest.indexOf("\nexport ", 1);
  return nextExportIdx === -1 ? rest : rest.slice(0, nextExportIdx);
}

const SRC = readSourceWithoutComments(LISTINGS_PATH);

// ---------- (a) payTo/amount are never read from the request body ----------

test("handlePayListing never reads payTo or amount_cents off the parsed request body -- both come from stored rows only", () => {
  const body = extractExportBody(SRC, "export async function handlePayListing");
  // The parsed request body is bound to `b` throughout this file
  // (parseJsonObjectBody's own return value) -- any property access of
  // payTo/amount_cents off it, in any of the shapes a caller might write
  // one, is exactly the regression this guards: trusting the caller's own
  // claim instead of deriving from walletFor/the stored bounty.
  const dangerousPatterns: RegExp[] = [
    /\bb\s*\.\s*payTo\b/,
    /\bb\s*\[\s*["']payTo["']\s*\]/,
    /\bb\s*\.\s*amount_cents\b/,
    /\bb\s*\[\s*["']amount_cents["']\s*\]/,
  ];
  const offenders = dangerousPatterns.filter((p) => p.test(body)).map((p) => p.source);
  assert.deepEqual(offenders, [], `handlePayListing must never read payTo/amount_cents from the request body; matched: ${JSON.stringify(offenders)}`);
});

test("positive control: handlePayListing DOES derive payTo from walletFor and amount from the stored listing.bounty_cents (the scan above is not vacuous)", () => {
  const body = extractExportBody(SRC, "export async function handlePayListing");
  assert.match(body, /walletFor\s*\(\s*env\s*,\s*submission\.citizen_id\s*\)/, "payTo must be derived from walletFor(submission's citizen)");
  assert.match(body, /payTo\s*:\s*reviewerWallet/, "the PaymentRequirements actually built must use the walletFor result, not a request field");
  assert.match(body, /listing\.bounty_cents\s*\*\s*10_000/, "the amount actually signed-for must be derived from the STORED listing.bounty_cents");
});

// Same guarantee restated as an END-TO-END proof over the request body's
// OWN shape: submission_id is the only field this handler is allowed to
// read off it. If a future edit adds any other field read here, this test
// names the offending property directly.
test("handlePayListing reads exactly ONE field off the parsed request body: submission_id", () => {
  const body = extractExportBody(SRC, "export async function handlePayListing");
  const accesses = [...body.matchAll(/\bb\s*\.\s*([a-zA-Z_][a-zA-Z0-9_]*)/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(accesses)], ["submission_id"], `handlePayListing must read only b.submission_id off the request body; found: ${JSON.stringify([...new Set(accesses)])}`);
});

// ---------- (b) the bounty payment is never booked to the treasury ledger ----------

test("handlePayListing never references the chained 'ledger' table or calls appendChained -- the bounty is not treasury money", () => {
  const body = extractExportBody(SRC, "export async function handlePayListing");
  assert.ok(!/["']ledger["']/.test(body), "handlePayListing must never reference the ledger table by name");
  assert.ok(!/\bappendChained\b/.test(body), "handlePayListing must never call appendChained -- listing_payments (unchained) is its only write, alongside the guarded UPDATE");
});

test("positive control: handleCreateListing DOES book the posting fee to the chained ledger (the scan above is not vacuous)", () => {
  const body = extractExportBody(SRC, "export async function handleCreateListing");
  assert.match(body, /appendChained\s*\(\s*env\.DB\s*,\s*["']ledger["']/, "the posting fee must be booked via appendChained(env.DB, \"ledger\", ...)");
  assert.match(body, /amount_cents\s*:\s*feeCents/, "the ledger line must book the FEE, not the bounty");
});

// The whole-file version of the same guarantee: exactly ONE call to
// appendChained(..., "ledger", ...) exists anywhere in listings.ts. Two
// would mean a second money-in path was added somewhere; zero would mean
// the fee itself stopped being booked -- either is a defect this single
// count catches without needing to know which function moved.
test("exactly one appendChained(..., \"ledger\", ...) call exists in the whole file -- the posting fee, and nothing else, is ever booked as treasury income", () => {
  const matches = SRC.match(/appendChained\s*\(\s*env\.DB\s*,\s*["']ledger["']/g) ?? [];
  assert.equal(matches.length, 1, `expected exactly one ledger-booking call in listings.ts, found ${matches.length}`);
});

// listing_payments itself must never be written alongside a ledger write in
// the same statement group -- restated directly against the INSERT INTO
// listing_payments call: it must not be immediately preceded or followed by
// any ledger reference within a tight window, which would suggest the two
// were being (wrongly) coupled.
test("the INSERT INTO listing_payments statement is never adjacent to a ledger reference", () => {
  const idx = SRC.indexOf("INSERT INTO listing_payments");
  assert.ok(idx !== -1, "positive control: listing_payments must actually be inserted somewhere in this file");
  const window = SRC.slice(Math.max(0, idx - 400), idx + 400);
  assert.ok(!/["']ledger["']/.test(window), "no 'ledger' reference within 400 chars of the listing_payments INSERT -- the two money records must stay structurally separate");
});
