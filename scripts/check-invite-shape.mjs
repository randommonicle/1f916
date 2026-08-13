// Send-time shape guard for invite codes: run this on any code before it
// is pasted into a message to a recruit. Exists to catch a malformed code
// BEFORE it reaches someone, rather than relying on the live door's 403 to
// catch it after send -- docs/HANDOVER-INVITE-GATE-403.md is the incident
// this closes: a 12-hex-character value with no "ch-" prefix
// (9a12646a14f7) was pasted into an onboarding message and correctly
// rejected at the door, for free and before any payment, but only after it
// had already reached the recruit and cost a wasted round trip.
//
// This is a SHAPE check only. It proves a code LOOKS like something
// generate-invite-codes.mjs / add-invite-code.mjs could have produced:
// "ch-" + randomBytes(9).toString("base64url"), which is always exactly 12
// base64url characters after the prefix (9 bytes is a multiple of 3, so
// base64 needs no padding: 9 bytes * 8 bits / 6 bits-per-char = 12 exactly).
// It does NOT check whether the code is currently configured or already
// redeemed -- this script has no access to INVITE_CODES (write-only,
// D-006) and never will. A shape-valid string can still be rejected at the
// door (wrong, spent, or rotated out); a shape-invalid string is never
// valid, so this is a cheap, free, pre-send filter, not a substitute for
// the server's own gate (validateInviteCode in src/register-gate.ts).
//
// No trimming, deliberately: whitespace accidentally carried alongside a
// pasted code is itself a shape defect worth catching here, even though
// register-gate.ts trims server-side and would still accept a
// whitespace-padded real code. This tool is stricter than the door on
// purpose -- it is checking the paste, not just the code.
//
// Run from society/:
//   node scripts/check-invite-shape.mjs <code>
// Prints "ok" and exits 0 on a well-formed code. Otherwise prints why on
// stderr and exits 1.
import { pathToFileURL } from "node:url";

// "ch-" + exactly 12 base64url characters. See the header comment for why
// 12 is exact, not approximate, for every code the generators can produce.
export const INVITE_CODE_SHAPE = /^ch-[A-Za-z0-9_-]{12}$/;

export function checkInviteShape(code) {
  if (typeof code === "string" && INVITE_CODE_SHAPE.test(code)) {
    return { ok: true };
  }
  const shown = code === undefined ? "(no argument given)" : JSON.stringify(code);
  return {
    ok: false,
    message:
      `not a valid invite code shape: ${shown}\n` +
      `expected "ch-" followed by exactly 12 base64url characters ` +
      `(letters, digits, "_" or "-"), e.g. ch-AbCdEf012345\n` +
      `real codes come from scripts/generate-invite-codes.mjs or scripts/add-invite-code.mjs -- ` +
      `if this one doesn't match, re-copy it from there rather than editing it by hand.`,
  };
}

function main() {
  const result = checkInviteShape(process.argv[2]);
  if (result.ok) {
    console.log("ok");
    process.exit(0);
  }
  console.error(result.message);
  process.exit(1);
}

// Same direct-execution guard as register-maintainer.mjs (see its header
// comment for why pathToFileURL, not a hand-rolled string comparison, is
// needed on Windows): only run main() when this file is the thing node was
// invoked on, not when a test imports it as a module.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
