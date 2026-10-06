// wrangler.jsonc carries the version_metadata binding the code identity reads, and does NOT carry the commit stamp (docs/BRIEF-SERVED-CODE-IDENTITY.md section 1, A6): each `wrangler deploy`
// replaces the version's vars (--keep-vars defaults false), so a CODE_COMMIT written into "vars" would be served by every later deploy that forgot the flag, as a stale sha stamped "stamped".
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { blankComments } from "./helpers/answer-scan.ts";

const config = (text: string) => JSON.parse(blankComments(text.replace(/\r\n/g, "\n"))) as Record<string, any>;
const real = readFileSync(join(import.meta.dirname, "..", "wrangler.jsonc"), "utf8");

test("the version_metadata binding is declared under the name the code reads (CF_VERSION_METADATA)", () => {
  assert.deepEqual(config(real).version_metadata, { binding: "CF_VERSION_METADATA" });
  assert.match(readFileSync(join(import.meta.dirname, "..", "src", "society.ts"), "utf8"), /CF_VERSION_METADATA\?: VersionMetadata;/, "and Env types the same name");
});

test("CODE_COMMIT is not a configured var anywhere: it exists only as the deploy script's --var, so a forgotten flag serves not_stamped", () => {
  const cfg = config(real);
  assert.ok(!("CODE_COMMIT" in (cfg.vars ?? {})));
  assert.ok(!JSON.stringify(cfg).includes("CODE_COMMIT"), "not under any environment either");
});

test("positive controls: the checks can fail (a config with the stamp in vars, a config with the wrong binding name)", () => {
  const stale = config('{ "vars": { "CODE_COMMIT": "0000000000000000000000000000000000000000" } }');
  assert.ok("CODE_COMMIT" in stale.vars, "the parse sees a stamp placed in vars");
  const wrong = config('{ "version_metadata": { "binding": "VERSION" } } // comment');
  assert.notDeepEqual(wrong.version_metadata, { binding: "CF_VERSION_METADATA" });
});
