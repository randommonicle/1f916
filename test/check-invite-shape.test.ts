// Tests for scripts/check-invite-shape.mjs's pure shape check: the
// send-time guard that would have caught docs/HANDOVER-INVITE-GATE-403.md's
// root cause (a 12-hex-character value with no "ch-" prefix, pasted into
// an onboarding message and only caught by the live door's 403, after
// send). This is a SHAPE check only -- it has no access to INVITE_CODES
// (write-only, D-006) and cannot know whether a shape-valid code is
// actually configured or already spent; that remains the server's job
// (register-gate.ts's validateInviteCode, covered by test/register-gate.test.ts).
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { checkInviteShape, INVITE_CODE_SHAPE } from "../scripts/check-invite-shape.mjs";

// Two real-shaped fixtures (ch- + 9 random bytes, base64url), picked to
// cover both non-alphanumeric characters the alphabet allows.
const REAL_CODE_WITH_UNDERSCORE = "ch-cjwicaSC_9MD";
const REAL_CODE_WITH_HYPHEN = "ch-LG-PAL4a7onr";

// ---------- accepts real shapes ----------

test("accepts a real ch- + 12 base64url-character code", () => {
  assert.deepEqual(checkInviteShape(REAL_CODE_WITH_UNDERSCORE), { ok: true });
});

test("accepts the full base64url alphabet: both '_' and internal '-' in the body", () => {
  assert.equal(checkInviteShape(REAL_CODE_WITH_UNDERSCORE).ok, true);
  assert.equal(checkInviteShape(REAL_CODE_WITH_HYPHEN).ok, true);
});

test("INVITE_CODE_SHAPE matches what generate-invite-codes.mjs and add-invite-code.mjs actually produce", async () => {
  // ch- + randomBytes(9).toString("base64url"): 9 bytes is a multiple of 3,
  // so base64 needs no padding -- always exactly 12 characters after the
  // prefix, whatever the random bytes happen to be.
  const { randomBytes } = await import("node:crypto");
  for (let i = 0; i < 20; i++) {
    const sample = "ch-" + randomBytes(9).toString("base64url");
    assert.match(sample, INVITE_CODE_SHAPE);
  }
});

// ---------- the actual incident (docs/HANDOVER-INVITE-GATE-403.md) ----------

test("rejects the exact malformed code from the incident: 12 hex chars, no ch- prefix", () => {
  const result = checkInviteShape("9a12646a14f7");
  assert.equal(result.ok, false);
  assert.match(result.message, /not a valid invite code shape/);
});

// ---------- other malformed shapes ----------

test("rejects an empty string", () => {
  assert.equal(checkInviteShape("").ok, false);
});

test("rejects a missing argument (undefined) with a message that says so, not a blank code dump", () => {
  const result = checkInviteShape(undefined);
  assert.equal(result.ok, false);
  assert.match(result.message, /no argument given/);
});

test("rejects a code one character short (11 after the prefix)", () => {
  assert.equal(checkInviteShape("ch-9a12646a14f").ok, false);
});

test("rejects a code one character long (13 after the prefix)", () => {
  assert.equal(checkInviteShape("ch-9a12646a14f77").ok, false);
});

test("rejects a missing prefix even at the correct total length", () => {
  assert.equal(checkInviteShape("xx-cjwicaSC_9MD").ok, false);
});

test("rejects the wrong case on the prefix", () => {
  assert.equal(checkInviteShape("CH-cjwicaSC_9MD").ok, false);
});

test("rejects characters outside the base64url alphabet ('+' and '/' are base64, not base64url)", () => {
  assert.equal(checkInviteShape("ch-cjwicaSC+9MD").ok, false);
  assert.equal(checkInviteShape("ch-cjwicaSC/9MD").ok, false);
});

test("rejects whitespace padding, even though register-gate.ts would trim it server-side -- the point here is catching the paste defect itself", () => {
  assert.equal(checkInviteShape(" " + REAL_CODE_WITH_UNDERSCORE).ok, false);
  assert.equal(checkInviteShape(REAL_CODE_WITH_UNDERSCORE + " ").ok, false);
  assert.equal(checkInviteShape(REAL_CODE_WITH_UNDERSCORE + "\n").ok, false);
});

// ---------- the build brief's own worked example, corrected ----------
//
// The brief for this script named `ch-9a12646a14f7` as a "(wrong length)"
// rejection case, alongside the bare `9a12646a14f7` above. It is not: "ch-"
// plus the incident's 12-hex-character value is 15 characters total, and
// the 12 characters after the prefix are all valid base64url characters
// (hex digits are a subset of that alphabet), so it actually SATISFIES
// this shape check. Verified here rather than silently "corrected" to
// match the brief, because asserting a false result would make this test
// lie about what the tool does -- see the header comment on
// scripts/check-invite-shape.mjs and docs/INVITE-SEND-TEMPLATE.md for why
// that is expected and does not weaken the send-time discipline: a
// well-shaped string that was never actually issued still gets a free 403
// at the door, exactly as it did for the real incident value.
test("ch-9a12646a14f7 is shape-VALID (ch- + exactly 12 hex characters, all valid base64url characters) -- shape alone cannot distinguish an unissued-but-well-formed code from a real one; only the door's membership check can", () => {
  assert.equal(checkInviteShape("ch-9a12646a14f7").ok, true);
});
