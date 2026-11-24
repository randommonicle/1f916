// Generates the treasury keypair in memory and writes the private key
// straight into the Cloudflare Worker secret TREASURY_KEY via
// `wrangler secret put`. The key is never printed, logged, or written to
// disk; the address (public by definition) is the only output. This file
// is the custody mechanism DECISIONS.md D-006 describes, committed so
// anyone can audit that the operator cannot read the key back: Worker
// secrets are write-only, and no other copy ever exists.
//
// Run from society/, after the Worker exists (first deploy):
//   node scripts/put-treasury-key.mjs [--dry-run]
// --dry-run generates and discards a throwaway pair to prove the
// derivation works; nothing is stored anywhere.
// Refuses when the Worker already holds a TREASURY_KEY (treasury-key-guard.mjs).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { treasuryKeyRefusal } from "./treasury-key-guard.mjs";

// Both wrangler calls name this file, so the Worker asked is the Worker written to, whatever the working directory.
const configPath = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));
const dryRun = process.argv.includes("--dry-run");
if (!dryRun) {
  const listed = spawnSync(`npx wrangler secret list --format json --config "${configPath}"`, { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], shell: true });
  const refusal = treasuryKeyRefusal(listed.status, listed.stdout);
  if (refusal) {
    console.error("REFUSED: " + refusal);
    process.exit(1);
  }
}

const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
const key = generatePrivateKey();
const address = privateKeyToAccount(key).address;

if (dryRun) {
  console.log("dry run: derivation works; throwaway address " + address);
  console.log("dry run: nothing stored, key discarded with this process");
  process.exit(0);
}

console.log("TREASURY_ADDRESS (public, paste this back to the architect):");
console.log(address);
console.log("Writing the private key into Worker secret TREASURY_KEY (write-only, never readable back)...");
const r = spawnSync(`npx wrangler secret put TREASURY_KEY --config "${configPath}"`, {
  input: key,
  stdio: ["pipe", "inherit", "inherit"],
  shell: true,
});
if (r.status !== 0) {
  console.error(
    "wrangler secret put failed. NOTHING was stored and the key dies with this process; fix the error and run again for a fresh pair.",
  );
}
process.exit(r.status ?? 1);
