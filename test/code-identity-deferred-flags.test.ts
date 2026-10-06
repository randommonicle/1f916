// Every DEFERRED flag docs/BRIEF-SERVED-CODE-IDENTITY.md names is planted, grep-able, at the place where the deferred work would land (flag-deferred-items): out-of-scope work with no flag at its
// landing site is forgotten work. A flag removed from its site, or moved away from it, fails this test.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dirname, "..", "src");
const read = (f: string) => readFileSync(join(SRC, f), "utf8").replace(/\r\n/g, "\n");

test("DEFERRED-CLAIM-ROW-CODE-IDENTITY is planted at takeClaim, the claim INSERT, with the reason it is deferred", () => {
  const src = read("settlement-claims.ts");
  const flag = src.indexOf("DEFERRED-CLAIM-ROW-CODE-IDENTITY");
  const fn = src.indexOf("export async function takeClaim(");
  assert.ok(flag > 0, "the flag is planted");
  assert.ok(fn > flag && fn - flag < 2500, "and sits immediately above takeClaim");
  const note = src.slice(flag, fn);
  assert.match(note, /migration on the money-path table/);
  assert.match(note, /could strand money/);
  assert.match(note, /D-018 Opus gate/);
});

test("DEFERRED-SERVED-SCHEMA-IDENTITY is planted beside the /api/attest code block, says why d1_migrations is not the answer, and records CODEX's candidate", () => {
  const src = read("index.ts");
  const flag = src.indexOf("DEFERRED-SERVED-SCHEMA-IDENTITY");
  const block = src.indexOf("code: codeBlock(env)");
  assert.ok(flag > 0, "the flag is planted");
  assert.ok(block > flag && block - flag < 2500, "and sits immediately above the code block's return");
  const note = src.slice(flag, block);
  assert.match(note, /NOT d1_migrations/);
  assert.match(note, /wrangler d1 execute --file/);
  assert.match(note, /sqlite_master/);
  assert.match(note, /commonhold_statement, never presented as proof of the live schema/);
});

test("positive control: a flag that is not planted is not found", () => {
  assert.equal(read("settlement-claims.ts").includes("DEFERRED-NO-SUCH-FLAG"), false);
});
