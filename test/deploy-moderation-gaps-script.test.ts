// scripts/deploy-moderation-gaps.ps1 is WRITTEN AND NEVER RUN by the builder (no deploy, no wrangler, not even -DryRun, which reads the live worker over HTTP). It is proven here by what can be
// proven without running it: it parses under PowerShell's own parser, is ASCII with LF endings, has none of the repo's PowerShell traps, has the load-bearing step order, no migration or D1 step,
// a single wrangler use, a ride of public GETs with no request body at all, step 0a stops on the placeholder before any git or network command, and the /privacy marker check
// (Test-PrivacyServed) is run for real against good and bad answers. Pattern: test/deploy-proposals-note-epoch-script.test.ts.
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
const SCRIPT_PATH = here("../scripts/deploy-moderation-gaps.ps1");
const rawScript = readFileSync(SCRIPT_PATH, "utf8");
const script = rawScript.replace(/\r\n/g, "\n");
const code = script.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
const defs = script.slice(script.indexOf('$ErrorActionPreference = "Stop"'), script.indexOf("# END-OF-DEFINITIONS"));
const pinBlock = script.slice(script.indexOf("# BEGIN-PIN-CHECK"), script.indexOf("# END-PIN-CHECK"));

const NEW_MARKER = "Three things moderation does not reach";
const OLD_MARKER = "titles, links, bylines and other metadata may remain visible";

function runPs(lines: string[]): { code: number | null; out: string } | null {
  const dir = mkdtempSync(join(tmpdir(), "deploy-moderation-gaps-"));
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

test("the pins: the v6 hash, the live base is the full sha of 50007e0f, the reviewed commit is the full sha of c336c117, the allowlist is this script, its test and docs/, the parameters are -ExpectedCommit (mandatory) and -DryRun", () => {
  assert.match(script, /^\$V6_HASH = "dc5f48213c29bcf844e0fbe7daf1bdb5416b3d57fbd06a8bd03f1061f34092b3"$/m);
  assert.match(script, /^\$LIVE_BASE_COMMIT = "50007e0f7785e6fa55dfd716ec42077a6a011c67"$/m);
  assert.match(script, /^\$REVIEWED_COMMIT = "c336c117bbbce0d27228a298a20b982c8a0e36e3"$/m);
  assert.match(script, /^\$ALLOWED_PATHS_AFTER_REVIEW = @\("scripts\/deploy-moderation-gaps\.ps1", "test\/deploy-moderation-gaps-script\.test\.ts", "docs\/"\)$/m);
  assert.match(script, /\[Parameter\(Mandatory = \$true\)\]\[string\]\$ExpectedCommit/);
  assert.match(script, /\[switch\]\$DryRun/);
});

test("step 0a STOPS on either placeholder or a malformed pin before ANY git, npm, wrangler or network command (the pin block is run for real), and the same block passes full shas", (t) => {
  const stubs = ["git", "npm", "npx", "curl.exe"].map((n) => `function ${n} { throw "${n} must not run in step 0a" }`);
  const harness = (live: string, reviewed: string): string[] => [
    "$ErrorActionPreference = 'Stop'",
    ...stubs,
    "function Stop-Here($msg) { Write-Host \"[STOP] $msg\"; exit 1 }",
    `$LIVE_BASE_COMMIT = "${live}"`,
    '$LIVE_BASE_PLACEHOLDER = "TO-BE-SET-BY-HUB-LIVE-BASE"',
    `$REVIEWED_COMMIT = "${reviewed}"`,
    '$REVIEWED_COMMIT_PLACEHOLDER = "TO-BE-SET-BY-HUB"',
    pinBlock,
    'Write-Host "[PASSED-PINS]"',
  ];
  const LIVE = "50007e0f7785e6fa55dfd716ec42077a6a011c67";
  const FULL = "0123456789abcdef0123456789abcdef01234567";
  const stopped = runPs(harness(LIVE, "TO-BE-SET-BY-HUB"));
  if (!stopped) return t.skip("no PowerShell available");
  assert.equal(stopped.code, 1);
  assert.match(stopped.out, /\[STOP\].*REVIEWED_COMMIT still holds the placeholder/);
  assert.match(runPs(harness("TO-BE-SET-BY-HUB-LIVE-BASE", FULL))!.out, /\[STOP\].*LIVE_BASE_COMMIT still holds the placeholder/);
  assert.match(runPs(harness(LIVE, "ABCDEF0123456789ABCDEF0123456789ABCDEF01"))!.out, /\[STOP\].*not 40 lower-case hex/);
  assert.match(runPs(harness("50007e0f", FULL))!.out, /\[STOP\].*LIVE_BASE_COMMIT.*not 40 lower-case hex/);
  const ok = runPs(harness(LIVE, FULL))!;
  assert.equal(ok.code, 0);
  assert.match(ok.out, /\[PASSED-PINS\]/);
});

test("the steps are in the load-bearing order, there is no migration or D1 step, wrangler is used once (the stamped deploy), and the ride sends no POST and no request body", () => {
  const order = ["BEGIN-PIN-CHECK", "git fetch origin", "BEGIN-REVIEWED-SOURCE-CHECK", "BEGIN-GATES", 'Read-Attest "before the deploy"', "if ($DryRun)", "BEGIN-DEPLOY-AND-POLL", 'Read-Attest "after the deploy"', "Test-PrivacyServed $privacyNow"];
  let last = -1;
  for (const needle of order) {
    const i = script.indexOf(needle.startsWith("BEGIN-") ? "# " + needle : needle);
    assert.ok(i > last, `${needle} comes after the previous step`);
    last = i;
  }
  assert.equal(/\bd1\b|migrations apply|execute --remote/i.test(code.replace(/migrations\b/g, "").replace(/schema\.sql/g, "")), false, "no D1 command");
  assert.equal((code.match(/= \(npx wrangler /g) ?? []).length, 1, "exactly one executed wrangler command (the other mentions are text in messages)");
  assert.match(code, /npx wrangler deploy --var "CODE_COMMIT:\$headSha"/);
  assert.equal(/Invoke-WebRequest|Invoke-RestMethod|-Method\s+Post/i.test(code), false, "no PowerShell web cmdlets");
  assert.equal(/-X\s+POST|--data/.test(code), false, "no POST and no request body (PS 5.1 strips inner quotes from native arguments, Addendum 104 s8)");
  assert.ok(code.includes("src/doc.ts") && code.includes("migrations schema.sql"), "the no-mint and no-migration check names src/doc.ts, migrations and schema.sql");
});

test("the markers are the exact strings the served /privacy carries: the new one is in src/privacy.ts, the old one is not, and the script pins both", () => {
  const priv = readFileSync(here("../src/privacy.ts"), "utf8");
  assert.ok(priv.includes(NEW_MARKER), "src/privacy.ts carries the new marker");
  assert.equal(priv.includes(OLD_MARKER), false, "src/privacy.ts no longer carries the old sentence");
  assert.ok(script.includes(`$PRIVACY_NEW_MARKER = "${NEW_MARKER}"`));
  assert.ok(script.includes(`$PRIVACY_OLD_MARKER = "${OLD_MARKER}"`));
});

test("the source checks name literals the checkout carries: src/modstate.ts has modPlaceholder, and every governance.ts literal is in src/governance.ts", () => {
  assert.ok(code.includes('Select-String -Path "src/modstate.ts" -Pattern "export function modPlaceholder("'));
  assert.ok(readFileSync(here("../src/modstate.ts"), "utf8").includes("export function modPlaceholder("));
  const gov = readFileSync(here("../src/governance.ts"), "utf8");
  for (const m of code.matchAll(/Select-String -Path "src\/governance\.ts" -Pattern "([^"]+)" -SimpleMatch/g)) {
    assert.ok(gov.includes(m[1]), `src/governance.ts carries '${m[1]}'`);
  }
  assert.ok(gov.includes('PROPOSALS_SEQUENCE_BASELINE = { migration: "0007_first_laws", applied: "2026-08-18" }'));
});

test("Test-PrivacyServed, run for real, passes the new text and fails: old text still served, new marker absent, both present, bad status", (t) => {
  const fn = defs.slice(defs.indexOf("function Test-PrivacyServed"), defs.indexOf("# Polls (GETs only)"));
  const q = (s: string): string => "'" + s.replace(/'/g, "''") + "'";
  const good = `Moderation replaces the body. ${NEW_MARKER}: a, b, c.`;
  const cases: Array<[string, string, string]> = [
    ["good", good, ""],
    ["old", `Moderation: ${OLD_MARKER}; nothing else.`, "does not yet contain"],
    ["empty", "", "does not yet contain"],
    ["both", `${good} also ${OLD_MARKER}`, "still contains the old moderation sentence"],
    ["case", good.replace("Three", "three"), "does not yet contain"],
  ];
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    `$PRIVACY_NEW_MARKER = ${q(NEW_MARKER)}`,
    `$PRIVACY_OLD_MARKER = ${q(OLD_MARKER)}`,
    fn,
    ...cases.map(([name, body]) => `Write-Host ("RESULT ${name} [" + (Test-PrivacyServed @{ Code = "200"; Body = ${q(body)} }) + "]")`),
    `Write-Host ("RESULT status [" + (Test-PrivacyServed @{ Code = "503"; Body = ${q(good)} }) + "]")`,
  ];
  const run = runPs(lines);
  if (!run) return t.skip("no PowerShell available");
  for (const [name, , expect] of [...cases, ["status", "", "answered 503"] as [string, string, string]]) {
    const m = new RegExp(`RESULT ${name} \\[(.*)\\]`).exec(run.out);
    assert.ok(m, `${name} produced a result: ${run.out}`);
    if (expect === "") assert.equal(m![1], "");
    else assert.ok(m![1].includes(expect), `${name}: '${m![1]}' mentions '${expect}'`);
  }
});

test("the before-read refuses a worker already serving the new sentence and one serving neither; the poll and the ride both use Test-PrivacyServed", () => {
  assert.ok(code.includes("Contains($PRIVACY_NEW_MARKER)) { Stop-Here"));
  assert.ok(code.includes("-not ([string]$privacyBefore.Body).Contains($PRIVACY_OLD_MARKER)"));
  assert.ok(code.includes("Test-PrivacyServed (Get-Text $PRIVACY_URL 30)"));
  assert.ok(code.includes("Wait-NewWorker $headSha $versionId $POLL_TRIES"));
  assert.ok(code.includes('"/privacy"') && code.includes('"/api/proposal/8"'));
});
