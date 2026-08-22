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
// register-gate-d1.test.ts (added for the pre-settle door-fix, pregate
// cleanup wave) now covers one narrow slice of the full flow against real
// local D1: that a refusal which was always coming (a bad model string, an
// already-throttled IP) lands before settle, not after. Everything else
// named above stays as described: accepted manual-smoke coverage.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
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

// Policing test, mirrors chain.test.ts's "nothing outside chain.ts writes
// to a chained table directly" pattern exactly: register() (society.ts)
// must be reachable from exactly one place. A second caller is not a bug
// that fails loudly, it is a silent bypass of the invite check and the $1
// payment gate, which is worse. society.ts (where register() is defined)
// and register-gate.ts (its one legitimate caller) are excluded from the
// scan, same as chain.ts excludes itself from its own offender scan.
// Recursive .ts walk, mirroring chain.test.ts's walkTsFiles. The previous
// version of this scan was `readdirSync(src).filter(f => f.endsWith(".ts"))`,
// which is shallow: `maintainer` is a directory, so it fails the .ts filter
// and is dropped before its contents are ever read. That hid seven files
// (clerk, judgment, trigger, budget, anthropic, runs, schedule) from the one
// control that polices registration bypasses. No bypass ever lived there --
// verified by grep at the time of the fix -- so this closed a blind spot in
// the guard rather than an open door. Found by the cross-agent channel on
// 2026-08-22 while checking an outward claim that this walk "sees every
// caller the binary can dispatch"; it did not, and the claim was pulled.
function walkTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walkTsFiles(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

const SRC = join(import.meta.dirname, "..", "src");

// Exempt by full path, never by bare filename. society.ts is where register()
// is defined and register-gate.ts is its one legitimate caller; a future
// src/<subdir>/society.ts is a different module and must not inherit the
// exemption by sharing a name, which the old bare-name comparison would have
// granted it the moment the walk started recursing.
const REGISTER_EXEMPT = new Set([join(SRC, "society.ts"), join(SRC, "register-gate.ts")]);

const CALLS_REGISTER = /\bregister\s*\(/;

// Split out so the detector can be fed a synthetic file and proven to fire.
// A source scan that has never been shown to catch anything is indistinguishable
// from a scan that reads zero files.
function registerOffenders(files: string[], readText: (file: string) => string): string[] {
  return files.filter((file) => !REGISTER_EXEMPT.has(file) && CALLS_REGISTER.test(readText(file)));
}

test("register() is called only from register-gate.ts, nowhere else in src/", () => {
  const offenders = registerOffenders(walkTsFiles(SRC), (file) => readFileSync(file, "utf8"));
  assert.deepEqual(
    offenders,
    [],
    "register() must be called only from register-gate.ts. A second caller bypasses the invite code and payment gate silently, the way mcp.ts's register tool used to.",
  );
});

test("the register() scan descends into nested src/ subdirectories", () => {
  const files = walkTsFiles(SRC);
  assert.ok(
    files.includes(join(SRC, "maintainer", "clerk.ts")),
    "The scan must reach src/maintainer/. A shallow readdirSync drops the directory and the guard goes blind to every module inside it, which is exactly the regression this test locks.",
  );
});

test("the register() scan catches a planted bypass in a nested module", () => {
  const planted = join(SRC, "maintainer", "clerk.ts");
  const offenders = registerOffenders([planted], () => "const citizen = await register(env, handle);");
  assert.deepEqual(
    offenders,
    [planted],
    "The detector must flag a register() call in a nested module. If this passes empty, the scan cannot fail and proves nothing.",
  );
});
