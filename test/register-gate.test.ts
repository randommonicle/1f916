// Tests for the pure invite-code logic: shape/membership validation and
// the hash used to check and record redemption. Not covered here, same
// acceptance as wallets.ts and payouts.ts (docs/PHASE0-PLAN.md section 6,
// architect ruling 8): assertInviteNotRedeemed, assertHandleAvailable, and
// the full handleRegisterGate flow, all of which need D1. Manual coverage
// is in docs/SMOKE-PHASE0.md. The single most safety-critical behaviour,
// "no payment means no registration", is tested against the shared core
// directly in test/x402.test.ts, since register-gate.ts only calls it and
// does not reimplement it.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { validateInviteCode, inviteCodeHash } from "../src/register-gate.ts";
import { SocietyError } from "../src/society.ts";
import type { Env } from "../src/society.ts";

function envWithCodes(codes: string): Env {
  return {
    TREASURY_ADDRESS: "0x0",
    FACILITATOR_URL: "https://facilitator.example.invalid",
    REGISTRATION_MODE: "invite_only",
    INVITE_CODES: codes,
  } as Env;
}

const isForbidden = (e: unknown) => e instanceof SocietyError && e.status === 403;

test("a code present in INVITE_CODES is accepted", () => {
  const env = envWithCodes("alpha,beta,gamma");
  assert.equal(validateInviteCode(env, "beta"), "beta");
});

test("whitespace around a submitted code and around configured codes is trimmed", () => {
  const env = envWithCodes(" alpha , beta ,gamma");
  assert.equal(validateInviteCode(env, "  beta  "), "beta");
});

test("a code not in INVITE_CODES is rejected, forbidden not bad-request", () => {
  const env = envWithCodes("alpha,beta");
  assert.throws(() => validateInviteCode(env, "not-a-real-code"), isForbidden);
});

test("a missing, empty, or whitespace-only code is rejected", () => {
  const env = envWithCodes("alpha");
  assert.throws(() => validateInviteCode(env, undefined), isForbidden);
  assert.throws(() => validateInviteCode(env, ""), isForbidden);
  assert.throws(() => validateInviteCode(env, "   "), isForbidden);
});

test("an unset INVITE_CODES rejects every code: fails closed, not open", () => {
  const env = envWithCodes("");
  assert.throws(() => validateInviteCode(env, "anything"), isForbidden);
});

test("inviteCodeHash is deterministic and does not just echo the code back", async () => {
  const a = await inviteCodeHash("same-code");
  const b = await inviteCodeHash("same-code");
  assert.equal(a, b);
  assert.notEqual(a, "same-code");
  assert.match(a, /^[0-9a-f]{64}$/);
});

test("inviteCodeHash gives different codes different hashes", async () => {
  const a = await inviteCodeHash("code-one");
  const b = await inviteCodeHash("code-two");
  assert.notEqual(a, b);
});
