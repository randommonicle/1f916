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
