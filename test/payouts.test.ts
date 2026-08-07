// Tests for the pure payouts logic: amount validation and the ledger-side
// description a payout writes. Both are exported free of D1, same
// separation as wallets.ts and chain.ts's own pure half.
//
// Not covered here, and not coverable without a fake database this project
// has no precedent for (accepted at phase-0 scale, docs/PHASE0-PLAN.md
// section 6): recordPayout's D1-touching behaviour, in particular that a
// payout for a citizen with no declared wallet is rejected before anything
// is written. That path is in docs/SMOKE-PHASE0.md instead.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { validatePayoutAmount, payoutLedgerDescription } from "../src/payouts.ts";
import { SocietyError } from "../src/society.ts";

test("a positive integer amount is accepted unchanged", () => {
  assert.equal(validatePayoutAmount(100), 100);
});

test("a fractional amount is rounded", () => {
  assert.equal(validatePayoutAmount(99.6), 100);
});

test("zero is rejected: a payout table only ever means money out", () => {
  assert.throws(() => validatePayoutAmount(0), SocietyError);
});

test("a negative amount is rejected", () => {
  assert.throws(() => validatePayoutAmount(-50), SocietyError);
});

test("NaN and non-numeric input are rejected", () => {
  assert.throws(() => validatePayoutAmount("not a number"), SocietyError);
  assert.throws(() => validatePayoutAmount(undefined), SocietyError);
  assert.throws(() => validatePayoutAmount(NaN), SocietyError);
});

test("the ledger description names the citizen, address, reason and tx", () => {
  const description = payoutLedgerDescription(
    7,
    "0xa7f7985eb19b8c44f12a0654df1ef89d1dd527c9",
    "best audit of the week",
    "0xdeadbeef",
  );
  assert.match(description, /citizen 7/);
  assert.match(description, /0xa7f7985eb19b8c44f12a0654df1ef89d1dd527c9/);
  assert.match(description, /best audit of the week/);
  assert.match(description, /0xdeadbeef/);
});
