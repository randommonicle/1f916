// scripts/deploy-proposals-max-id.ps1 is WRITTEN AND NEVER RUN by the builder (no deploy, no wrangler, not even -DryRun, which reads the live worker over HTTP). It is proven here by what can be
// proven without running it: it parses under PowerShell's own parser, is ASCII with LF endings, has none of the repo's PowerShell traps, has the load-bearing step order, no migration or D1 step,
// a single wrangler use, a ride of public GETs only, step 0a stops on the placeholder before any git or network command, and the ride's max_id check (Test-MaxIdServed) is run for real against
// good and bad answers. Pattern: test/deploy-privacy-script.test.ts.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parsePowerShellFile } from "./helpers/ps-parse.ts";

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
const SCRIPT_PATH = here("../scripts/deploy-proposals-max-id.ps1");
const rawScript = readFileSync(SCRIPT_PATH, "utf8");
const script = rawScript.replace(/\r\n/g, "\n");
const code = script.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
const defs = script.slice(script.indexOf('$ErrorActionPreference = "Stop"'), script.indexOf("# END-OF-DEFINITIONS"));
const pinBlock = script.slice(script.indexOf("# BEGIN-PIN-CHECK"), script.indexOf("# END-PIN-CHECK"));

function runPs(lines: string[]): { code: number | null; out: string } | null {
  const dir = mkdtempSync(join(tmpdir(), "deploy-max-id-"));
  try {
    const ps1 = join(dir, "harness.ps1");
    writeFileSync(ps1, lines.join("\r\n"));
    const r = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1], { encoding: "utf8" });
    if (r.error) return null;
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the script parses under PowerShell's own parser with zero errors, is ASCII only and has LF line endings", (t) => {
  assert.equal(/[^\x00-\x7f]/.test(rawScript), false, "ASCII only");
  assert.equal(rawScript.includes("\r"), false, "LF line endings");
  const parsed = parsePowerShellFile(SCRIPT_PATH);
  if (!parsed.available) {
    t.skip(`${parsed.reason}; the static checks still run`);
    return;
  }
  assert.equal(parsed.errors, 0, `parse errors: ${parsed.detail}`);
});

test("no PowerShell traps: one spelling per variable, no `$var:` drive reference, stderr merged only under Continue, no -notmatch over a pipeline", () => {
  const names = new Map<string, Set<string>>();
  for (const m of code.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)) {
    const set = names.get(m[1].toLowerCase()) ?? new Set<string>();
    set.add(m[1]);
    names.set(m[1].toLowerCase(), set);
  }
  assert.deepEqual([...names.values()].filter((s) => s.size > 1).map((s) => [...s].join(" / ")), []);
  assert.equal(/\$[A-Za-z_][A-Za-z0-9_]*:/.test(code.replace(/\$\(/g, "")), false);
  for (const m of code.matchAll(/2>&1/g)) {
    const before = code.slice(0, m.index);
    assert.ok(before.lastIndexOf('$ErrorActionPreference = "Continue"') > before.lastIndexOf('$ErrorActionPreference = "Stop"'));
  }
  assert.equal(/\$\w+\s*\|\s*Where-Object[^\n]*-notmatch/.test(code), false);
});

test("the pins: the v6 hash, the live base is the full sha of 1dbb61fe, the reviewed commit is the hub's placeholder or a full 40-hex sha, the parameters are -ExpectedCommit (mandatory) and -DryRun", () => {
  assert.match(script, /^\$V6_HASH = "dc5f48213c29bcf844e0fbe7daf1bdb5416b3d57fbd06a8bd03f1061f34092b3"$/m);
  assert.match(script, /^\$LIVE_BASE_COMMIT = "1dbb61fedf529df311cf2b8fe2313b824c090492"$/m);
  assert.match(script, /^\$REVIEWED_COMMIT = "(?:TO-BE-SET-BY-HUB|[0-9a-f]{40})"$/m);
  assert.match(script, /\[Parameter\(Mandatory = \$true\)\]\[string\]\$ExpectedCommit/);
  assert.match(script, /\[switch\]\$DryRun/);
});

test("step 0a STOPS on the placeholder before ANY git, npm, wrangler or network command (the pin block is run for real), and the same block passes a full sha", (t) => {
  const stubs = ["git", "npm", "npx", "curl.exe"].map((n) => `function ${n} { throw "${n} must not run in step 0a" }`);
  const harness = (reviewed: string): string[] => [
    "$ErrorActionPreference = 'Stop'",
    ...stubs,
    "function Stop-Here($msg) { Write-Host \"[STOP] $msg\"; exit 1 }",
    '$LIVE_BASE_COMMIT = "1dbb61fedf529df311cf2b8fe2313b824c090492"',
    '$LIVE_BASE_PLACEHOLDER = "TO-BE-SET-BY-HUB-LIVE-BASE"',
    `$REVIEWED_COMMIT = "${reviewed}"`,
    '$REVIEWED_COMMIT_PLACEHOLDER = "TO-BE-SET-BY-HUB"',
    pinBlock,
    'Write-Host "[PASSED-PINS]"',
  ];
  const stopped = runPs(harness("TO-BE-SET-BY-HUB"));
  if (!stopped) return t.skip("no PowerShell available");
  assert.equal(stopped.code, 1);
  assert.match(stopped.out, /\[STOP\].*REVIEWED_COMMIT still holds the placeholder/);
  const bad = runPs(harness("ABCDEF0123456789ABCDEF0123456789ABCDEF01"))!;
  assert.match(bad.out, /\[STOP\].*not 40 lower-case hex/);
  const ok = runPs(harness("0123456789abcdef0123456789abcdef01234567"))!;
  assert.equal(ok.code, 0);
  assert.match(ok.out, /\[PASSED-PINS\]/);
});

test("the steps are in the load-bearing order, there is no migration or D1 step, wrangler is used once (the stamped deploy), and the ride makes GETs only", () => {
  const order = ["BEGIN-PIN-CHECK", "git fetch origin", "BEGIN-REVIEWED-SOURCE-CHECK", "BEGIN-GATES", 'Read-Attest "before the deploy"', "if ($DryRun)", "BEGIN-DEPLOY-AND-POLL", 'Read-Attest "after the deploy"', "Test-MaxIdServed $proposalsNow"];
  let last = -1;
  for (const needle of order) {
    const i = script.indexOf(needle.startsWith("BEGIN-") ? "# " + needle : needle);
    assert.ok(i > last, `${needle} comes after the previous step`);
    last = i;
  }
  assert.equal(/\bd1\b|migrations apply|execute --remote/i.test(code.replace(/migrations\b/g, "").replace(/schema\.sql/g, "")), false, "no D1 command");
  assert.equal((code.match(/= \(npx wrangler /g) ?? []).length, 1, "exactly one executed wrangler command (the other mentions are text in messages)");
  assert.match(code, /npx wrangler deploy --var "CODE_COMMIT:\$headSha"/);
  assert.equal(/-X\s+POST|--data|Invoke-WebRequest|Invoke-RestMethod|-Method\s+Post/i.test(code), false, "public GETs only");
  assert.ok(code.includes("src/doc.ts") && code.includes("migrations schema.sql"), "the no-mint and no-migration check names src/doc.ts, migrations and schema.sql");
});

test("Test-MaxIdServed, run for real, passes the live shape (ids 1 2 5 6 7 8, total 6, max_id 8) and fails each way it can be wrong", (t) => {
  const fn = defs.slice(defs.indexOf("function Test-MaxIdServed"), defs.indexOf("# Polls until the served block"));
  const body = (o: object): string => "'" + JSON.stringify(o).replace(/'/g, "''") + "'";
  const rows = (ids: number[]) => ids.map((id) => ({ id }));
  const good = { total: 6, max_id: 8, max_id_note: "n", has_more: false, proposals: rows([1, 2, 5, 6, 7, 8]) };
  const cases: Array<[string, string, string]> = [
    ["good", `@{ Code = "200"; Body = ${body(good)} }`, ""],
    ["status", `@{ Code = "500"; Body = ${body(good)} }`, "answered 500"],
    ["notjson", `@{ Code = "200"; Body = 'oops' }`, "did not return JSON"],
    ["absent", `@{ Code = "200"; Body = ${body({ ...good, max_id: undefined })} }`, "no max_id field"],
    ["nonote", `@{ Code = "200"; Body = ${body({ ...good, max_id_note: undefined })} }`, "no max_id_note"],
    ["null", `@{ Code = "200"; Body = ${body({ ...good, max_id: null })} }`, "whole number"],
    ["string", `@{ Code = "200"; Body = ${body({ ...good, max_id: "8" })} }`, "whole number"],
    ["more",`@{ Code = "200"; Body = ${body({ ...good, has_more: true })} }`, "has_more"],
    ["count", `@{ Code = "200"; Body = ${body({ ...good, total: 5 })} }`, "carries 6 rows"],
    ["above", `@{ Code = "200"; Body = ${body({ ...good, max_id: 7, total: 6 })} }`, "above max_id"],
    ["top", `@{ Code = "200"; Body = ${body({ ...good, max_id: 9 })} }`, "no served row carries max_id"],
    ["twice", `@{ Code = "200"; Body = ${body({ ...good, proposals: rows([1, 2, 5, 6, 8, 8]) })} }`, "twice"],
  ];
  const lines = ["$ErrorActionPreference = 'Stop'", fn, ...cases.map(([name, r]) => `Write-Host ("RESULT ${name} [" + (Test-MaxIdServed ${r}) + "]")`)];
  const run = runPs(lines);
  if (!run) return t.skip("no PowerShell available");
  for (const [name, , expect] of cases) {
    const m = new RegExp(`RESULT ${name} \\[(.*)\\]`).exec(run.out);
    assert.ok(m, `${name} produced a result: ${run.out}`);
    if (expect === "") assert.equal(m![1], "");
    else assert.ok(m![1].includes(expect), `${name}: '${m![1]}' mentions '${expect}'`);
  }
});

test("the before-read refuses a live worker already serving max_id, and the ride sweeps the proposal detail route too", () => {
  assert.ok(code.includes(`Contains('"max_id"')`));
  assert.ok(code.includes('"/api/proposal/8"'));
});
