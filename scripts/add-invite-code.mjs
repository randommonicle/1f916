// Adds ONE new phase-0 invite code without disturbing the others.
//
// generate-invite-codes.mjs regenerates the whole cohort and OVERWRITES the
// secret -- correct for first provisioning, wrong for "one registrant needs a
// replacement": it would silently invalidate the other nine. This appends.
//
// The Worker secret is write-only, so it cannot be the source of truth for an
// append: we rebuild the full comma-separated list from the operator's local
// file (../invite-codes.local.txt, the same file generate-invite-codes.mjs
// writes) and push that. If that file is missing we REFUSE -- pushing a
// one-code list would invalidate every existing code, the exact footgun this
// script exists to avoid.
//
// Run from society/, after generate-invite-codes.mjs has been run at least once:
//   node scripts/add-invite-code.mjs [--dry-run]
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const dryRun = process.argv.includes("--dry-run");
const filePath = resolve(process.cwd(), "..", "invite-codes.local.txt");

if (!existsSync(filePath)) {
  console.error(
    `refusing: ${filePath} not found. That file is the source of truth for the\n` +
      `full code list; without it, pushing INVITE_CODES would drop every existing\n` +
      `code. Run scripts/generate-invite-codes.mjs first, or restore the file.`,
  );
  process.exit(1);
}

// Same format as generate-invite-codes.mjs: "ch-" + 9 random bytes, base64url.
const newCode = "ch-" + randomBytes(9).toString("base64url");

// Existing codes, in file order, de-duplicated and whitespace-trimmed -- the
// same normalisation register-gate.ts's configuredCodes() applies, so what we
// push matches what the gate will compare against.
const existing = readFileSync(filePath, "utf8")
  .split("\n")
  .map((c) => c.trim())
  .filter(Boolean);
const codes = [...new Set([...existing, newCode])];

if (dryRun) {
  console.log(`dry run: would append 1 code (list ${existing.length} -> ${codes.length}) and put secret INVITE_CODES; nothing written`);
  console.log(`new code (dry run, not stored): ${newCode}`);
  process.exit(0);
}

writeFileSync(filePath, codes.join("\n") + "\n");
console.log(`Appended 1 code to ${filePath} (${existing.length} -> ${codes.length}). Keep that file, it is the only copy.`);
console.log("Writing the full list into Worker secret INVITE_CODES (existing codes preserved)...");
const r = spawnSync("npx wrangler secret put INVITE_CODES", {
  input: codes.join(","),
  stdio: ["pipe", "inherit", "inherit"],
  shell: true,
});
if (r.status !== 0) {
  console.error("wrangler secret put failed; the file above still holds the codes, re-run to store them.");
  process.exit(r.status ?? 1);
}
// Printed last, alone, so it is easy to copy cleanly -- send it in a code block
// or as an attachment, never inline in Markdown (an '_' in a base64url code is
// an italic marker and gets eaten on copy; a '-' can autocorrect to an en-dash).
console.log("\nThe new code to send the registrant (transmit verbatim, in a code block):\n");
console.log(newCode);
