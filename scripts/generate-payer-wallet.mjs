// Generates the payer wallet that will fund the maintainer's own founding
// registration -- the "penny test" (docs/DEPLOY-2026-08-07.md "Known gaps";
// MAINTAINER-RUNTIME-DESIGN.md section 4). Unlike the treasury key
// (put-treasury-key.mjs), this key does NOT go into a write-only Worker
// secret: it has to stay readable so register-maintainer.mjs can load it
// back up and sign a payment with it. So the custody line here is
// different, not weaker: the file is written ONE LEVEL ABOVE this repo
// (`../payer-wallet.local.json`), the same place invite-codes.local.txt
// already lives, so it can never be committed even by accident. It never
// touches a Worker secret at all -- there is nothing here for Cloudflare to
// hold, and nothing for this script to ever read back out of the cloud.
//
// This wallet is meant to hold a few dollars, once, for one purpose. It is
// not the treasury. Losing this key loses a few dollars, not the society's
// money.
//
// Run from society/, before the wallet is funded or used:
//   node scripts/generate-payer-wallet.mjs [--dry-run]
// --dry-run generates and discards a throwaway pair to prove the
// derivation works; nothing is written anywhere.
//
// Refuses to run for real if the output file already exists: overwriting it
// would throw away the key to any funds already sent to that address, with
// no recovery. If you genuinely need a fresh payer wallet, move or delete
// the old file yourself, after checking its balance is zero or the funds
// are otherwise accounted for.
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const dryRun = process.argv.includes("--dry-run");
const outPath = resolve(process.cwd(), "..", "payer-wallet.local.json");

if (!dryRun && existsSync(outPath)) {
  console.error(`Refusing to run: ${outPath} already exists.`);
  console.error("Overwriting it would destroy the key to any funds already sent to its address, permanently.");
  console.error("If you genuinely want a fresh payer wallet, move or delete that file yourself first, after");
  console.error("checking its balance is zero (or its funds are otherwise accounted for).");
  process.exit(1);
}

const privateKey = generatePrivateKey();
const address = privateKeyToAccount(privateKey).address;

if (dryRun) {
  console.log("dry run: derivation works; throwaway address " + address);
  console.log("dry run: nothing written, existing file (if any) untouched");
  process.exit(0);
}

const wallet = { address, privateKey, created: new Date().toISOString() };
writeFileSync(outPath, JSON.stringify(wallet, null, 2) + "\n");

console.log("Payer wallet generated and written to:");
console.log(outPath);
console.log("(one level above this repo -- it cannot be committed, and nothing here sends it anywhere)");
console.log("");
console.log("Fund THIS address with about $5 of USDC on the BASE network (not Ethereum mainnet, not any");
console.log("other chain -- the same address exists on every EVM chain, but only a Base-network transfer");
console.log("is usable here):");
console.log(address);
console.log("");
console.log("Next: node scripts/register-maintainer.mjs --code <an invite code>");
