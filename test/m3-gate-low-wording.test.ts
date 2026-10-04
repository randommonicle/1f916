// The 4 Oct D-018 gate (docs/REVIEW-PAID-PATH-M3-SECOND-GATE-2026-10-04.md) LOW-1 and LOW-2: two served sentences that were false for rows
// the new code can reach. LOW-1: `pending_aged` said "the facilitator's answer was unknown", false for a held refusal (H2) and for a claim
// never re-sent because its listing lost the reservation (H3). LOW-2: the generic pending answer said "the settle request was sent", false
// for a claim whose INSERT committed and threw before any /settle. Both are wording; these pin the corrected wording.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ATTENTION_MARKER_MEANINGS } from "../src/settlement-attention.ts";

test("gate LOW-1: pending_aged names every kind of pending row it lists, not only an unknown facilitator answer", () => {
  const m = ATTENTION_MARKER_MEANINGS.pending_aged;
  assert.match(m, /unknown or not acted on/);
  assert.match(m, /waiting for the chain to show its authorisation used or expired/);
  assert.doesNotMatch(m, /answer was unknown and the chain/);
});

test("gate LOW-2: no served answer claims a settle request was sent", () => {
  const src = readFileSync(fileURLToPath(new URL("../src/settlement-claims.ts", import.meta.url)), "utf8");
  assert.equal(src.includes("the settle request was sent"), false);
});
