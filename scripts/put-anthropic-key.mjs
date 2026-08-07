// Pipes the maintainer runtime's Anthropic API key into the Cloudflare
// Worker secret ANTHROPIC_API_KEY. Same custody pattern as
// put-treasury-key.mjs and put-maintainer-secret.mjs: the secret is read
// from disk and piped straight into `wrangler secret put`, never printed,
// never logged, and Worker secrets are write-only -- once stored, not even
// the operator can read it back through any dashboard or API.
//
// Unlike put-treasury-key.mjs (which GENERATES a keypair locally, since
// nothing outside this machine could), there is nothing to generate here:
// an Anthropic API key is minted in the Anthropic Console
// (MAINTAINER-RUNTIME-DESIGN.md S12 -- create a `commonhold` Workspace,
// set its monthly spend limit, create the key inside that workspace named
// `commonhold-maintainer`). Ben pastes it once into a local file; this
// script's only job is getting it into the Worker without it ever passing
// through a chat transcript, a shell argument, or shell history.
//
// Run from society/, after creating the key in the Anthropic Console and
// saving it to the file below:
//   node scripts/put-anthropic-key.mjs [--dry-run]
// --dry-run checks that the file exists and is non-empty and reports
// that, without ever reading its contents into this process (a size
// check via stat, not a read) -- so there is nothing to leak even by
// accident.
import { existsSync, statSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";

const dryRun = process.argv.includes("--dry-run");
const keyPath = resolve(process.cwd(), "..", "anthropic-api-key.local.txt");

if (!existsSync(keyPath)) {
  console.error(`No key file at ${keyPath}.`);
  console.error("Create it by hand: paste the key from console.anthropic.com into that file, nothing else, no trailing newline needed.");
  console.error("The key must come from a Workspace named 'commonhold' with a monthly spend limit set (MAINTAINER-RUNTIME-DESIGN.md S12) -- this script does not create the workspace or the key, only stores it.");
  process.exit(1);
}

if (dryRun) {
  const stat = statSync(keyPath);
  console.log(`dry run: ${keyPath} exists, ${stat.size} bytes`);
  console.log(stat.size > 0 ? "dry run: non-empty, looks usable" : "dry run: EMPTY -- would refuse to store this");
  console.log("dry run: file was not read into this output, only its size was checked");
  process.exit(0);
}

const key = readFileSync(keyPath, "utf8").trim();
if (key.length === 0) {
  console.error(`${keyPath} is empty. Refusing to store an empty key.`);
  process.exit(1);
}

console.log("Writing the Anthropic API key into Worker secret ANTHROPIC_API_KEY (write-only, never readable back)...");
const r = spawnSync("npx wrangler secret put ANTHROPIC_API_KEY", {
  input: key,
  stdio: ["pipe", "inherit", "inherit"],
  shell: true,
});
if (r.status !== 0) {
  console.error(`wrangler secret put failed. NOTHING was stored. ${keyPath} still holds the key -- fix the error and run again.`);
}
process.exit(r.status ?? 1);
