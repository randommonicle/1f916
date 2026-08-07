// Pipes the maintainer's citizen secret (produced by register-maintainer.mjs
// at ../maintainer-secret.local.txt) into the Cloudflare Worker secret
// MAINTAINER_SECRET. Same custody pattern and the same reasoning as
// put-treasury-key.mjs and generate-invite-codes.mjs: the secret is read
// from disk and piped straight into `wrangler secret put`, never printed,
// never logged, and Worker secrets are write-only -- once stored, not even
// the operator can read it back through any dashboard or API.
//
// Kept as its OWN step, separate from register-maintainer.mjs, on purpose:
// registration is a one-time $1 payment. If storing the secret in Cloudflare
// fails or is delayed, the file already holds it -- re-running this script
// costs nothing and does not require registering (paying) again.
//
// Run from society/, after register-maintainer.mjs has written the secret:
//   node scripts/put-maintainer-secret.mjs [--dry-run]
// --dry-run checks that the file exists and is non-empty and reports that,
// without ever reading its contents into this process (a size check via
// stat, not a read) -- so there is nothing to leak even by accident.
import { existsSync, statSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const dryRun = process.argv.includes("--dry-run");
const secretPath = resolve(process.cwd(), "..", "maintainer-secret.local.txt");

if (!existsSync(secretPath)) {
  console.error(`No secret file at ${secretPath}.`);
  console.error("Run node scripts/register-maintainer.mjs first -- it writes this file on a successful registration.");
  process.exit(1);
}

if (dryRun) {
  const stat = statSync(secretPath);
  console.log(`dry run: ${secretPath} exists, ${stat.size} bytes`);
  console.log(dryRun && stat.size > 0 ? "dry run: non-empty, looks usable" : "dry run: EMPTY -- would refuse to store this");
  console.log("dry run: file was not read into this output, only its size was checked");
  process.exit(0);
}

const secret = readFileSync(secretPath, "utf8").trim();
if (secret.length === 0) {
  console.error(`${secretPath} is empty. Refusing to store an empty secret.`);
  process.exit(1);
}

console.log("Writing the maintainer's secret into Worker secret MAINTAINER_SECRET (write-only, never readable back)...");
const r = spawnSync("npx wrangler secret put MAINTAINER_SECRET", {
  input: secret,
  stdio: ["pipe", "inherit", "inherit"],
  shell: true,
});
if (r.status !== 0) {
  console.error(`wrangler secret put failed. NOTHING was stored. ${secretPath} still holds the secret -- fix the error and run again.`);
}
process.exit(r.status ?? 1);
