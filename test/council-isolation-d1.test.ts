// The council's fences (D-075 order step c; commission "Class"; D-043; K1). Static scans over src/, each with a positive control so a scan that cannot see anything cannot pass.
//   * D-043: nothing under src/maintainer/ names a council table or imports the council (a resident's council writes are guest-class content, and no paid cognition reads it);
//   * the council tables are read and written by src/council.ts alone (and the schema/migration): no other module touches them, so no other module can count a council ballot
//     into a figure the society divides by;
//   * K1: no module imports the council to act on a motion: the only importers of src/council.ts are the router, the two MCP doors, the official-facts block (dynamically)
//     and the skill text, none of which calls anything that changes a rule, a membership, the constitution or the treasury;
//   * the intent vocabularies stay separate: council.ts reaches the citizen verifier through exactly the two functions the commission names.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dirname, "..", "src");
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((e) => {
    const full = join(dir, e);
    return statSync(full).isDirectory() ? walk(full) : e.endsWith(".ts") ? [full] : [];
  });
const code = (path: string): string => readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
const rel = (p: string): string => p.replace(/\\/g, "/").replace(/^.*\/src\//, "");
const TABLES = /\bcouncil_(challenges|claims|thread|motions|ballots)\b/;

test("D-043: no file under src/maintainer/ names a council table or imports a council module (positive control: src/council.ts does name them)", () => {
  const maintainer = walk(join(SRC, "maintainer"));
  assert.ok(maintainer.length >= 8, "sanity: the walk found the maintainer directory");
  const offenders = maintainer.filter((f) => TABLES.test(code(f)) || /from\s+["'][^"']*council[^"']*["']/.test(readFileSync(f, "utf8")));
  assert.deepEqual(offenders.map(rel), [], "paid cognition reads no council content");
  assert.ok(TABLES.test(code(join(SRC, "council.ts"))), "positive control: the scan sees a council table in the module that owns them");
});

test("the council tables are named by src/council.ts alone (and nowhere else in src/): no other module can count a council row into a figure the society divides by", () => {
  const named = walk(SRC).filter((f) => TABLES.test(code(f))).map(rel).sort();
  assert.deepEqual(named, ["council.ts"]);
});

test("K1: the council is imported only by the router, the two MCP doors, the route table and the skill text; officialFacts reads it by a DYNAMIC import so society.ts stays a leaf (no cycle); nothing that changes a rule, a membership, the constitution or the treasury imports it", () => {
  const importers = walk(SRC)
    .filter((f) => !/\/council[^/]*\.ts$/.test(f.replace(/\\/g, "/")))
    .filter((f) => /from\s+["']\.\.?\/council(?:-core|-verify)?\.ts["']/.test(readFileSync(f, "utf8")))
    .map(rel)
    .sort();
  assert.deepEqual(importers, ["discovery.ts", "inbox.ts", "index.ts", "mcp-read.ts", "mcp.ts"]);
  const society = readFileSync(join(SRC, "society.ts"), "utf8");
  assert.ok(!/from\s+["']\.\/council(?:-core|-verify)?\.ts["']/.test(society), "society.ts has no static import of the council");
  assert.ok(/await import\(["']\.\/council\.ts["']\)/.test(society), "and reads the council block by a dynamic import");
  // the powers a motion must never reach are not importable from the council: it names none of the writers of rules, membership, the constitution or the treasury
  for (const f of ["council.ts", "council-core.ts", "council-verify.ts"]) {
    const text = code(join(SRC, f));
    for (const banned of ["castBallot", "createProposal", "governance.ts", "setSetting", "governance_settings", "constitution_versions", "recordLedger", "recordPayout", "declareWallet", "payAndSettle", "INSERT INTO citizens", "UPDATE citizens"]) {
      assert.equal(new RegExp(banned.replace(/\./g, "\\.")).test(text), false, `${f} must not name ${banned}`);
    }
  }
});

test("the citizen verifier is touched by the council wave in exactly one place: a single narrowing check in authenticateByAssertion (CA5); authenticate, requireSignedIntent and the citizen ballot are byte-for-byte what they were (the gate examines the one edit first)", () => {
  const society = readFileSync(join(SRC, "society.ts"), "utf8");
  const CA5 = "/^resident_[a-z_]+:/.test(a.binding)"; // the whole-binding form (gate L1)
  assert.equal(society.split(CA5).length - 1, 1, "one resident_ binding check in all of society.ts");
  assert.equal(society.includes('startsWith("resident_")'), false, "no bare prefix check anywhere");
  const fn = society.slice(society.indexOf("async function authenticateByAssertion("), society.indexOf("export function assertValidHandle"));
  const verifyAt = fn.indexOf("verifyAssertion(row.public_key, a)");
  const checkAt = fn.indexOf(CA5);
  const nonceAt = fn.indexOf("INSERT INTO auth_nonces");
  assert.ok(verifyAt > 0 && checkAt > verifyAt && nonceAt > checkAt, "the check sits after the signature check and before the nonce INSERT, nowhere else");
  assert.equal(readFileSync(join(SRC, "governance.ts"), "utf8").includes("council"), false, "the citizen ballot and proposal paths never mention the council");
});
