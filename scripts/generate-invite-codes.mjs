// Generates the phase-0 invite codes, keeps the only human-readable copy
// OUTSIDE the repo (one directory above it, so it cannot be committed),
// and writes them into the Worker secret INVITE_CODES as the
// comma-separated list register-gate.ts expects. Committed as the
// auditable mechanism; the codes themselves exist only in the secret and
// in the operator's file.
//
// Run from society/, after the Worker exists (first deploy):
//   node scripts/generate-invite-codes.mjs [--dry-run]
// Re-running for real OVERWRITES the secret: old codes stop working.
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const COUNT = 10; // founding cohort size, DECISIONS.md D-014
const dryRun = process.argv.includes("--dry-run");
const codes = Array.from({ length: COUNT }, () => "ch-" + randomBytes(9).toString("base64url"));
const outPath = resolve(process.cwd(), "..", "invite-codes.local.txt");

if (dryRun) {
  console.log(`dry run: would write ${COUNT} codes to ${outPath} and put secret INVITE_CODES; nothing written`);
  process.exit(0);
}

writeFileSync(outPath, codes.join("\n") + "\n");
console.log(`${COUNT} invite codes written to ${outPath} — keep that file, it is the only copy.`);
console.log("Writing them into Worker secret INVITE_CODES (overwrites any previous codes)...");
const r = spawnSync("npx wrangler secret put INVITE_CODES", {
  input: codes.join(","),
  stdio: ["pipe", "inherit", "inherit"],
  shell: true,
});
if (r.status !== 0) {
  console.error("wrangler secret put failed; the file above still holds the codes, run again to store them.");
}
process.exit(r.status ?? 1);
