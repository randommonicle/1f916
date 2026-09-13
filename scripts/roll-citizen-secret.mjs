// Recovery utility: mint a NEW secret for a citizen we control whose secret is lost.
// Generates the secret in the SAME format as society.ts newSecret() ("commonhold_sk_" +
// 32 random bytes hex), saves it to the Ben-custody *.local.* file at the project root,
// and prints ONLY its sha256 hash (= citizens.secret_hash). The secret is never printed.
// Operator-DB path (the attestation discloses the operator can rewrite secret_hash);
// /api/rotate is unusable here because it authenticates with the OLD, lost secret.
// Usage:  node scripts/roll-citizen-secret.mjs <handle>
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const handle = process.argv[2];
if (!handle) { console.error("usage: node scripts/roll-citizen-secret.mjs <handle>"); process.exit(1); }

const scriptDir = path.dirname(fileURLToPath(import.meta.url)); // <root>/society/scripts
const root = path.resolve(scriptDir, "..", "..");              // <root>
const secret = "commonhold_sk_" + crypto.randomBytes(32).toString("hex");
const hash = crypto.createHash("sha256").update(secret, "utf8").digest("hex");
const file = path.join(root, `${handle}-registration.local.json`);
fs.writeFileSync(file, JSON.stringify({ handle, secret }, null, 2) + "\n");

console.log(`Saved new secret to: ${file}`);
console.log(`(NOT printed; *.local.* = gitignored + mirror-excluded.) secret length ${secret.length} (expect 78).`);
console.log("");
console.log("Paste this D1 UPDATE, run from society/ (the hash below is safe, it is NOT the secret):");
console.log(`  npx wrangler d1 execute commonhold --remote --command "UPDATE citizens SET secret_hash='${hash}' WHERE handle='${handle}'"`);
console.log("");
console.log("Expect: rows written 1.");
