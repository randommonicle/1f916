// scripts/deploy-code-identity.ps1 is run only by Ben (D-017). Proven here by what can be proven without wrangler, the network or a deploy (docs/BRIEF-SERVED-CODE-IDENTITY.md, T6):
// it parses and is ASCII; its steps are in the load-bearing order; it reads nothing from prod D1 and runs no wrangler command but the deploy; the deploy line passes `--var CODE_COMMIT:<the
// pinned sha>` (run for real against a stand-in for npx); the propagation poll compares BOTH code.commit and code.version_id with what wrangler printed and STOPS on a mismatch, a missing
// block, a bad status or a read that never succeeds; the test-count regex is anchored (it takes the summary, not a test titled "pass 5", and survives a code-page-mangled prefix); step 0's
// reviewed-source block, with its placeholder guard, is run for real against a throwaway git repository; and the constants it carries are each pinned to a source of truth. The
// definitions region is evaluated with throwing stubs for npx, git, npm and curl, so a stray top-level command there turns this test red instead of running.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parsePowerShellFile } from "./helpers/ps-parse.ts";
import { computeLiveConstitutionPair } from "../src/governance.ts";

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
const SCRIPT_PATH = here("../scripts/deploy-code-identity.ps1");
const script = readFileSync(SCRIPT_PATH, "utf8").replace(/\r\n/g, "\n");
const code = script
  .split("\n")
  .filter((l) => !/^\s*#/.test(l))
  .join("\n");

const DEFS_END = "# END-OF-DEFINITIONS";
const block = (name: string): string => script.slice(script.indexOf(`# BEGIN-${name}`), script.indexOf(`# END-${name}`));
const defs = script.slice(script.indexOf('$ErrorActionPreference = "Stop"'), script.indexOf(DEFS_END));
const reviewedBlock = block("REVIEWED-SOURCE-CHECK");
const gatesBlock = block("GATES");
const deployBlock = block("DEPLOY-AND-POLL");

const SHA = "69730d99c573b874f3acaecf34cf239fc90d252f";
const VERSION = "a672490d-1b8b-4457-9e34-b23dfb5c6c4d";
const OTHER_VERSION = "11111111-2222-3333-4444-555555555555";
const PLACEHOLDER = "TO-BE-SET-BY-HUB";

type PsRun = { code: number | null; out: string };
// A PowerShell 5.1 harness. The .ps1 is written ASCII-only (a BOM-less file is read as the ANSI code page); anything non-ASCII goes in a data file read with -Encoding UTF8.
function runPs(lines: string[], files: Record<string, string> = {}): PsRun | null {
  const dir = mkdtempSync(join(tmpdir(), "deploy-ci-"));
  try {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    const ps1 = join(dir, "harness.ps1");
    writeFileSync(ps1, lines.map((l) => l.replaceAll("@DIR@", dir)).join("\r\n"));
    const r = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1], { encoding: "utf8" });
    if (r.error) return null;
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const THROWING_STUBS = ["npx", "git", "npm", "curl.exe"].map((n) => `function ${n} { throw "${n} must not run while the definitions are evaluated" }`);
const PS_DEFS = ["$ErrorActionPreference = 'Stop'", ...THROWING_STUBS, defs];

let evaluated: Record<string, string> | null | undefined;
function definitions(t: { skip: (m: string) => void }): Record<string, string> | null {
  if (evaluated === undefined) {
    const r = runPs([
      ...PS_DEFS,
      'Write-Output ("V5=" + $V5_HASH)',
      'Write-Output ("LIVE_BASE=" + $LIVE_BASE_COMMIT)',
      'Write-Output ("REVIEWED=" + $REVIEWED_COMMIT)',
      'Write-Output ("PLACEHOLDER=" + $REVIEWED_COMMIT_PLACEHOLDER)',
      'Write-Output ("TRIES=" + $POLL_TRIES)',
      'Write-Output ("DELAY=" + $POLL_DELAY_SECONDS)',
      'Write-Output "EVALUATED-OK"',
    ]);
    if (!r) evaluated = null;
    else {
      assert.equal(r.code, 0, `the definitions region must evaluate cleanly: ${r.out}`);
      assert.match(r.out, /EVALUATED-OK/);
      evaluated = Object.fromEntries([...r.out.matchAll(/^([A-Z0-9_]+)=(.*)$/gm)].map((m) => [m[1], m[2].replace(/\r$/, "")]));
    }
  }
  if (evaluated === null) t.skip("powershell is not available on this machine");
  return evaluated ?? null;
}
const skipNoPs = (t: { skip: (m: string) => void }) => t.skip("powershell is not available on this machine");

// ---------- the file itself ----------

test("deploy-code-identity.ps1 parses under PowerShell's own parser with zero errors, and is ASCII only", (t) => {
  assert.equal(/[^\x00-\x7f]/.test(readFileSync(SCRIPT_PATH, "utf8")), false, "5.1 reads a BOM-less UTF-8 script as the ANSI code page: ASCII only");
  const parsed = parsePowerShellFile(SCRIPT_PATH);
  if (!parsed.available) {
    t.skip(`${parsed.reason}; the static checks below still run`);
    return;
  }
  assert.equal(parsed.errors, 0, `parse errors: ${parsed.detail}`);
});

test("deploy-code-identity.ps1: one spelling per variable, no stderr merged under Stop, and the only wrangler command is the deploy (no D1, no migration file, no rollback, no secret, no write SQL)", () => {
  const names = new Map<string, Set<string>>();
  for (const m of code.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)) {
    const set = names.get(m[1].toLowerCase()) ?? new Set<string>();
    set.add(m[1]);
    names.set(m[1].toLowerCase(), set);
  }
  assert.deepEqual([...names.values()].filter((s) => s.size > 1).map((s) => [...s].join(" / ")), [], "PowerShell variable names are case-insensitive");
  for (const m of code.matchAll(/2>&1/g)) {
    const before = code.slice(0, m.index);
    assert.ok(before.lastIndexOf('$ErrorActionPreference = "Continue"') > before.lastIndexOf('$ErrorActionPreference = "Stop"'), "stderr merged only under Continue");
  }
  assert.deepEqual([...code.matchAll(/= \(npx wrangler ([a-z0-9]+)/g)].map((m) => m[1]), ["deploy"], "wrangler is CALLED for the deploy and nothing else, so -DryRun never calls it");
  // strings are blanked first: the messages name `npx wrangler rollback` and `deployments list` for Ben to run by hand, which is not the script running them
  const blanked = code.replace(/"[^"]*"/g, '""');
  assert.equal(/Invoke-D1Read|d1 execute|--file\b|wrangler secret|npx wrangler (?!deploy)/.test(blanked), false, "no D1 read, no migration file, no secret, no other wrangler call: this wave reads nothing from prod D1");
  assert.equal(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b/.test(code), false, "no write SQL anywhere in the script");
  assert.equal(/git push|git merge |git commit/.test(code), false, "the script never pushes, merges or commits");
});

test("deploy-code-identity.ps1: the steps are in the load-bearing order, and the dry run exits before the deploy", () => {
  const order = [
    "# END-OF-DEFINITIONS",
    "git fetch origin --quiet",
    "rev-parse --abbrev-ref HEAD",
    "-ExpectedCommit",
    "$headSha -cnotmatch",
    "git status --porcelain",
    "git merge-base --is-ancestor $LIVE_BASE_COMMIT HEAD",
    "git diff --name-only $LIVE_BASE_COMMIT HEAD -- migrations schema.sql src/doc.ts",
    "# BEGIN-REVIEWED-SOURCE-CHECK",
    "-ceq $REVIEWED_COMMIT_PLACEHOLDER",
    "git merge-base --is-ancestor $REVIEWED_COMMIT HEAD",
    "git diff --name-only --no-renames $REVIEWED_COMMIT HEAD",
    "Get-DisallowedPaths $afterReview",
    "# END-REVIEWED-SOURCE-CHECK",
    'Test-Path "src/code-identity.ts"',
    "export async function markFirstRefusal",
    '"version_metadata"',
    "# BEGIN-GATES",
    "npm test",
    "Get-TestSummary $testOut",
    "# END-GATES",
    "$attBefore = Read-Attest",
    "Assert-Attest $attBefore",
    "$totalBefore = Read-AttentionAndOfficial",
    "if ($DryRun)",
    "# BEGIN-DEPLOY-AND-POLL",
    "$deployOut = (npx wrangler deploy --var",
    "Current Version ID",
    "$ROLLBACK_LINE =",
    "Wait-CodeIdentity $headSha",
    "# END-DEPLOY-AND-POLL",
    "$attAfter = Read-Attest",
    "Assert-Attest $attAfter",
    "/api/guest/due",
    "$totalAfter = Read-AttentionAndOfficial",
  ];
  let last = -1;
  for (const needle of order) {
    const i = script.indexOf(needle, last + 1);
    assert.ok(i > last, `step out of order or missing: ${needle}`);
    last = i;
  }
  assert.ok(code.indexOf("exit 0") > 0, "the dry run has its exit 0");
  assert.ok(code.indexOf("exit 0") < code.indexOf("$deployOut = (npx wrangler deploy"), "the dry run exits before the deploy");
  assert.match(code, /if \(\$DryRun\) \{\n[^\n]*\n  exit 0\n\}/, "and the exit is the dry-run block's own");
  assert.equal([...code.matchAll(/= \(npx wrangler deploy/g)].length, 1, "exactly one deploy call");
});

test("deploy-code-identity.ps1: every git read whose output is judged checks its exit code first", () => {
  const lines = code.split("\n");
  const reads = lines.map((l, i) => [l, i] as const).filter(([l]) => /= @\(git /.test(l));
  assert.ok(reads.length >= 3, "the clean-tree, no-migration and changes-since-review reads are found");
  for (const [l, i] of reads) assert.match(lines[i + 1], /^if \(\$LASTEXITCODE -ne 0\) \{ Stop-Here/, `no exit check after: ${l}`);
});

test("deploy-code-identity.ps1: the definitions region runs nothing (throwing stubs for npx, git, npm and curl pass through it)", (t) => {
  const d = definitions(t);
  if (!d) return;
  assert.equal(d.TRIES, "12", "the brief's bounded poll: 12 tries");
  assert.equal(d.DELAY, "5", "5 s apart");
});

// ---------- T6: the deploy line stamps the pinned sha ----------

const served = (code: Record<string, unknown> | null) =>
  JSON.stringify({ ok: true, constitution: { version: 5 }, ...(code === null ? {} : { code }) });
const goodCode = (over: Record<string, unknown> = {}) => ({ commit: SHA, commit_status: "stamped", version_id: VERSION, version_timestamp: "2026-10-06T17:00:00.000Z", version_status: "available", ...over });
type Reply = { code: string; body: string };
const ok = (c: Record<string, unknown> | null): Reply => ({ code: "200", body: served(c) });
const WRANGLER_OK = `Total Upload: 1000 KiB\nUploaded commonhold (3.0 sec)\nDeployed commonhold triggers (1.0 sec)\n  https://commonhold.randommonicle.workers.dev\nCurrent Version ID: ${VERSION}\n`;

// Runs the deploy-and-poll block with a stand-in for npx (records its arguments, answers with `wrangler`) and for Get-Text (answers /api/attest from `replies` in order, the last one repeating).
function runDeploy(replies: Reply[], wrangler: { text: string; exit?: number } = { text: WRANGLER_OK }): { run: PsRun } | null {
  const run = runPs(
    [
      ...PS_DEFS,
      `$headSha = '${SHA}'`,
      "$POLL_DELAY_SECONDS = 0",
      // PowerShell 5.1's ConvertFrom-Json emits a JSON array as ONE object; piping it on unrolls the elements
      "$replies = @(ConvertFrom-Json (Get-Content -Raw -Encoding UTF8 '@DIR@\\replies.json') | ForEach-Object { $_ })",
      "$wr = (Get-Content -Raw -Encoding UTF8 '@DIR@\\wrangler.json' | ConvertFrom-Json)",
      "$script:reads = 0",
      "function npx { Write-Host ('NPXARGS=' + ($args -join '|')); $global:LASTEXITCODE = [int]$wr.exit; return $wr.text }",
      "function Get-Text($url, $maxTime) { $i = [Math]::Min($script:reads, $replies.Count - 1); $script:reads++; return @{ Code = [string]$replies[$i].code; Body = [string]$replies[$i].body } }",
      deployBlock,
      'Write-Host ("READS=" + $script:reads)',
      'Write-Host "REACHED-END"',
      "exit 0",
    ],
    { "replies.json": JSON.stringify(replies), "wrangler.json": JSON.stringify({ text: wrangler.text, exit: wrangler.exit ?? 0 }) },
  );
  if (!run) return null;
  return { run };
}

test("T6: the deploy passes --var CODE_COMMIT:<the pinned sha> (the full 40 hex) and nothing else but wrangler deploy", (t) => {
  const r = runDeploy([ok(goodCode())]);
  if (!r) return skipNoPs(t);
  assert.equal(r.run.code, 0, r.run.out);
  assert.match(r.run.out, /REACHED-END/);
  assert.equal(r.run.out.match(/^NPXARGS=(.*)$/m)?.[1].trim(), `wrangler|deploy|--var|CODE_COMMIT:${SHA}`, "the exact arguments npx receives");
  assert.equal([...r.run.out.matchAll(/^NPXARGS=/gm)].length, 1, "npx is called once");
  assert.match(r.run.out, /\[poll\] try 1 of 12: GET \/api\/attest serves code\.commit 69730d99 and code\.version_id a672490d-/);
});

test("T6: the deploy STOPS, before any poll, when wrangler fails or prints no Current Version ID", (t) => {
  const failed = runDeploy([ok(goodCode())], { text: "Error: Authentication error", exit: 1 });
  if (!failed) return skipNoPs(t);
  assert.equal(failed.run.code, 1, failed.run.out);
  assert.match(failed.run.out, /\[STOP\] wrangler deploy failed \(exit 1\)/);
  assert.doesNotMatch(failed.run.out, /\[poll\]|REACHED-END/);
  const noId = runDeploy([ok(goodCode())], { text: "Uploaded commonhold\nDeployed commonhold triggers\n" });
  assert.ok(noId);
  assert.equal(noId.run.code, 1, noId.run.out);
  assert.match(noId.run.out, /\[STOP\] wrangler deploy exited 0 but printed no 'Current Version ID'/);
  assert.doesNotMatch(noId.run.out, /\[poll\]|REACHED-END/);
});

// ---------- I5 (code-identity gate L4): the Current Version ID capture is anchored to its own line and must be unique; the sha comparisons are case-sensitive ----------

const wranglerWith = (...idLines: string[]): string => `Total Upload: 1000 KiB\nUploaded commonhold (3.0 sec)\nDeployed commonhold triggers (1.0 sec)\n  https://commonhold.randommonicle.workers.dev\n${idLines.join("\n")}\n`;

test("I5: the Current Version ID is taken from its own line: CRLF output, an indented line, and a mid-line mention printed BEFORE the real line (which a first-match unanchored pattern captured) all give the real id", (t) => {
  const cases: Array<[string, string]> = [
    ["CRLF line endings, as wrangler prints them on Windows", WRANGLER_OK.replace(/\n/g, "\r\n")],
    ["an indented line", wranglerWith(`    Current Version ID: ${VERSION}`)],
    ["trailing spaces", wranglerWith(`Current Version ID: ${VERSION}   `)],
    ["a mid-line mention of another id before the real line", wranglerWith(`Rolled forward from Current Version ID: ${OTHER_VERSION} earlier`, `Current Version ID: ${VERSION}`)],
  ];
  for (const [name, text] of cases) {
    const r = runDeploy([ok(goodCode())], { text });
    if (!r) return skipNoPs(t);
    assert.equal(r.run.code, 0, `${name}: ${r.run.out}`);
    assert.match(r.run.out, new RegExp(`\\[deploy\\] worker version id ${VERSION} \\(commit 69730d99\\)`), `${name}: the real id was read`);
    assert.match(r.run.out, /\[poll\] try 1 of 12: GET \/api\/attest serves code\.commit 69730d99 and code\.version_id a672490d-/, name);
    assert.match(r.run.out, /REACHED-END/, name);
  }
});

test("I5: more than one Current Version ID line STOPS before any poll (identical or not), and a line that is not exactly the id, or only a mid-line mention, is no id", (t) => {
  const stops: Array<[string, string, RegExp]> = [
    ["two different ids", wranglerWith(`Current Version ID: ${OTHER_VERSION}`, `Current Version ID: ${VERSION}`), /\[STOP\] wrangler deploy printed 'Current Version ID' on 2 lines/],
    ["the same id twice", wranglerWith(`Current Version ID: ${VERSION}`, `Current Version ID: ${VERSION}`), /\[STOP\] wrangler deploy printed 'Current Version ID' on 2 lines/],
    ["three lines", wranglerWith(`Current Version ID: ${VERSION}`, `Current Version ID: ${VERSION}`, `Current Version ID: ${OTHER_VERSION}`), /on 3 lines/],
    ["a line with text after the id", wranglerWith(`Current Version ID: ${VERSION} (the previous deployment)`), /\[STOP\] wrangler deploy exited 0 but printed no 'Current Version ID'/],
    ["a line with text before the label", wranglerWith(`Previously Current Version ID: ${VERSION}`), /\[STOP\] wrangler deploy exited 0 but printed no 'Current Version ID'/],
    ["only a mid-line mention", wranglerWith(`See Current Version ID: ${VERSION} in the dashboard`), /\[STOP\] wrangler deploy exited 0 but printed no 'Current Version ID'/],
    ["an id one character short", wranglerWith(`Current Version ID: ${VERSION.slice(0, 35)}`), /\[STOP\] wrangler deploy exited 0 but printed no 'Current Version ID'/],
  ];
  for (const [name, text, expected] of stops) {
    const r = runDeploy([ok(goodCode())], { text });
    if (!r) return skipNoPs(t);
    assert.equal(r.run.code, 1, `${name}: ${r.run.out}`);
    assert.match(r.run.out, expected, name);
    assert.match(r.run.out, /Check 'npx wrangler deployments list' by hand/, `${name}: it names the hand check`);
    assert.doesNotMatch(r.run.out, /\[poll\]|REACHED-END|worker version id/, `${name}: nothing was polled and no id was adopted`);
  }
});

test("I5: the three sha comparisons in step 0 are case-sensitive (-cne): a sha differing only by case is a MISMATCH, and no variable-to-variable -ne/-eq remains in the script", (t) => {
  const line = code.split("\n").find((l) => l.startsWith("if ($mainSha "));
  assert.ok(line, "the main / origin / expected / HEAD comparison is there");
  const condition = line.replace(/^if \(/, "").replace(/\) \{$/, "");
  assert.equal(condition, "$mainSha -cne $originSha -or $mainSha -cne $expectedSha -or $headSha -cne $expectedSha");
  const evaluate = (main: string, origin: string, expected: string, head: string) =>
    runPs([`$mainSha = '${main}'`, `$originSha = '${origin}'`, `$expectedSha = '${expected}'`, `$headSha = '${head}'`, `Write-Output ("MISMATCH=" + [bool](${condition}))`]);
  const same = evaluate("abc123", "abc123", "abc123", "abc123");
  if (!same) return skipNoPs(t);
  assert.match(same.out, /MISMATCH=False/, "identical shas: no mismatch");
  for (const [name, args] of [
    ["origin differs by case", ["abc123", "ABC123", "abc123", "abc123"]],
    ["expected differs by case", ["abc123", "abc123", "ABC123", "abc123"]],
    ["HEAD differs by case", ["abc123", "abc123", "abc123", "aBc123"]],
  ] as const) {
    const r = evaluate(...args);
    assert.ok(r);
    assert.match(r.out, /MISMATCH=True/, name);
  }
  const bare = code.split("\n").filter((l) => /\$(?!null\b)\w+\s+-(?:ne|eq)\s+\$\w+/.test(l));
  assert.deepEqual(bare, [], "every comparison of two variables (a null check is not one) is -ceq / -cne (the header promises it)");
  assert.match(code, /if \(\$branch -cne "main"\)/, "and the branch name is compared case-sensitively");
});

test("T6: the poll compares BOTH code.commit and code.version_id and STOPS with the rollback line on any mismatch, after exactly 12 reads", (t) => {
  const cases: Array<[string, Reply[], RegExp]> = [
    ["the commit is not the pinned sha", [ok(goodCode({ commit: "a".repeat(40) }))], /code\.commit is 'a{40}', expected the pinned sha 69730d99/],
    ["the version id is not the one wrangler printed", [ok(goodCode({ version_id: OTHER_VERSION }))], /code\.version_id is '11111111-[^']*', expected the Current Version ID wrangler printed \(a672490d-/],
    ["the commit matches and the version id NEVER does (A4)", [ok(goodCode({ version_id: null }))], /code\.version_id is '', expected the Current Version ID/],
    ["the stamp reads not_stamped", [ok(goodCode({ commit: null, commit_status: "not_stamped" }))], /code\.commit_status is 'not_stamped', expected stamped/],
    ["the stamp reads malformed_stamp", [ok(goodCode({ commit: null, commit_status: "malformed_stamp" }))], /code\.commit_status is 'malformed_stamp'/],
    ["the version binding is unavailable", [ok(goodCode({ version_id: null, version_status: "unavailable" }))], /code\.version_status is 'unavailable', expected available/],
    ["the old worker: no code block at all", [ok(null)], /serves no code block/],
    ["every read fails (HTTP 500)", [{ code: "500", body: "oops" }], /serves no code block/],
    ["every read is not JSON", [{ code: "200", body: "<html>" }], /serves no code block/],
    ["an upper-case commit is not the pinned sha (case-sensitive)", [ok(goodCode({ commit: SHA.toUpperCase() }))], /code\.commit is '69730D99/],
  ];
  for (const [name, replies, expected] of cases) {
    const r = runDeploy(replies);
    if (!r) return skipNoPs(t);
    assert.equal(r.run.code, 1, `${name}: ${r.run.out}`);
    assert.match(r.run.out, /\[STOP\] GET \/api\/attest never served this deploy's identity in 12 reads/, name);
    assert.match(r.run.out, expected, name);
    assert.match(r.run.out, /ROLL BACK THE WORKER \(npx wrangler rollback/, `${name}: the rollback line`);
    assert.equal([...r.run.out.matchAll(/\[poll\] try \d+ of 12: not yet/g)].length, 12, `${name}: 12 reads, no more, no fewer`);
    assert.doesNotMatch(r.run.out, /REACHED-END/, name);
  }
});

test("T6: the poll tolerates a slow propagation (old worker, a failed read, a half-matching block) and passes on the first read that is this deploy's, comparing the version id case-insensitively", (t) => {
  const r = runDeploy([ok(null), { code: "502", body: "bad gateway" }, ok(goodCode({ version_id: OTHER_VERSION })), ok(goodCode({ version_id: VERSION.toUpperCase() }))]);
  if (!r) return skipNoPs(t);
  assert.equal(r.run.code, 0, r.run.out);
  assert.match(r.run.out, /\[poll\] try 1 of 12: not yet: GET \/api\/attest serves no code block/);
  assert.match(r.run.out, /\[poll\] try 3 of 12: not yet: code\.version_id is '11111111/);
  assert.match(r.run.out, /\[poll\] try 4 of 12: GET \/api\/attest serves code\.commit 69730d99/);
  assert.match(r.run.out, /READS=4/, "it stops reading once it has its answer");
  assert.match(r.run.out, /REACHED-END/);
});

test("T6: the poll's two comparisons are separate (a commit that matches does not excuse a version id that does not, and the reverse)", () => {
  assert.match(code, /\$code\.commit -cne \$commit/);
  assert.match(code, /ToLowerInvariant\(\) -cne \(\[string\]\$versionId\)\.ToLowerInvariant\(\)/);
  assert.match(code, /\$code\.commit_status -cne "stamped"/);
  assert.match(code, /\$code\.version_status -cne "available"/);
  assert.match(code, /Wait-CodeIdentity \$headSha \$versionId \$POLL_TRIES \$POLL_DELAY_SECONDS/);
});

// ---------- T6: the anchored test-count regex ----------

const SAMPLE = (prefix: string, eol: string) =>
  [
    `${prefix} some earlier suite`,
    "✔ pass 5 (0.4ms)",
    "✔ the poll tolerates fail 3 and pass 9 (1.1ms)",
    `${prefix} tests 1860`,
    `${prefix} suites 0`,
    `${prefix} pass 1860`,
    `${prefix} fail 0`,
    `${prefix} cancelled 0`,
    `${prefix} skipped 0`,
    `${prefix} todo 0`,
    `${prefix} duration_ms 33725.1949`,
    "",
  ].join(eol);

const summaryOf = (sample: string, t: { skip: (m: string) => void }): { pass: string; fail: string; old: string; sumOk: string } | null => {
  const r = runPs(
    [...PS_DEFS, "$out = Get-Content -Raw -Encoding UTF8 '@DIR@\\sample.txt'", 'if ($null -eq $out) { $out = "" }', "$s = Get-TestSummary $out", 'if ($null -eq $s) { Write-Output "NONE" } else { Write-Output ("PASS=" + $s.Pass + " FAIL=" + $s.Fail + " SUMOK=" + $s.SumOk) }', "Write-Output (\"OLD=\" + [regex]::Match([string]$out, 'pass (\\d+)').Groups[1].Value)"],
    { "sample.txt": `﻿${sample}` },
  );
  if (!r) {
    t.skip("powershell is not available on this machine");
    return null;
  }
  assert.equal(r.code, 0, r.out);
  return { pass: r.out.match(/PASS=(\d*)/)?.[1] ?? "NONE", fail: r.out.match(/FAIL=(\d*)/)?.[1] ?? "NONE", sumOk: r.out.match(/SUMOK=(\w+)/)?.[1] ?? "NONE", old: r.out.match(/OLD=(\d*)/)?.[1] ?? "" };
};

// node's summary block as the hub captured it from a real `npm test` here, where it ENDS the output: eight lines, the last a decimal.
const BLOCK8 = (tests: number, pass: number, fail: number, others: { cancelled?: number; skipped?: number; todo?: number } = {}, prefix = "ℹ", eol = "\n") =>
  [
    `${prefix} tests ${tests}`,
    `${prefix} suites 0`,
    `${prefix} pass ${pass}`,
    `${prefix} fail ${fail}`,
    `${prefix} cancelled ${others.cancelled ?? 0}`,
    `${prefix} skipped ${others.skipped ?? 0}`,
    `${prefix} todo ${others.todo ?? 0}`,
    `${prefix} duration_ms 50020.1725`,
    "",
  ].join(eol);

test("T6: the anchored summary takes 1860 from npm output that also contains a test titled 'pass 5' (the unanchored pattern the older scripts carry takes 5)", (t) => {
  const r = summaryOf(SAMPLE("ℹ", "\n"), t);
  if (!r) return;
  assert.deepEqual([r.pass, r.fail], ["1860", "0"]);
  assert.equal(r.old, "5", "the old 'pass (\\d+)' takes the FIRST match, here the title: this is the defect (Add 86 s17)");
});

test("T6: the summary survives CRLF line endings and the info mark mangled by a console code page (a letter-bearing prefix token)", (t) => {
  const crlf = summaryOf(SAMPLE("ℹ", "\r\n"), t);
  if (!crlf) return;
  assert.deepEqual([crlf.pass, crlf.fail], ["1860", "0"], "CRLF");
  const mangled = summaryOf(SAMPLE("Γä╣", "\r\n"), t);
  assert.ok(mangled);
  assert.deepEqual([mangled.pass, mangled.fail], ["1860", "0"], "CP437 mojibake of the U+2139 mark: letters in the prefix, which a \\W* anchor would refuse");
  const bare = summaryOf("tests 12\nsuites 0\npass 12\nfail 0\ncancelled 0\nskipped 0\ntodo 0\nduration_ms 5\n", t);
  assert.ok(bare);
  assert.deepEqual([bare.pass, bare.fail], ["12", "0"], "no prefix at all, and an integer duration");
  const trailing = summaryOf(BLOCK8(12, 12, 0).replace("pass 12", "pass 12 (ms)"), t);
  assert.ok(trailing);
  assert.equal(trailing.pass, "NONE", "anything after the number but whitespace is not the summary");
  const noTrailingNewline = summaryOf(BLOCK8(12, 12, 0).trimEnd(), t);
  assert.ok(noTrailingNewline);
  assert.deepEqual([noTrailingNewline.pass, noTrailingNewline.fail], ["12", "0"], "the final newline is not required");
  const blankLinesAfter = summaryOf(BLOCK8(12, 12, 0) + "\n\n  \n", t);
  assert.ok(blankLinesAfter);
  assert.deepEqual([blankLinesAfter.pass, blankLinesAfter.fail], ["12", "0"], "only whitespace may follow");
});

test("F2 (CODEX build r1): test TITLES are never the summary: consecutive titles 'pass 5' and 'fail 0' (with or without durations), the old pair and broken blocks are no summary", (t) => {
  const title = (eol: string, durations: boolean) => ["✔ pass 5" + (durations ? " (0.4ms)" : ""), "✔ fail 0" + (durations ? " (0.1ms)" : "")].join(eol);
  for (const [name, text] of [
    ["no durations", title("\n", false) + "\n"],
    ["durations", title("\n", true) + "\n"],
    ["no durations, CRLF", title("\r\n", false) + "\r\n"],
    ["the old pair with no tests/suites lines above it", "ℹ pass 1860\nℹ fail 0\n"],
    ["a pair with a suites line but no tests line", "ℹ suites 0\nℹ pass 1860\nℹ fail 0\n"],
    ["a block with a line between its lines", "ℹ tests 7\nℹ suites 0\nsomething\nℹ pass 7\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\nℹ duration_ms 1.5\n"],
    ["the first four lines only (no cancelled/skipped/todo/duration_ms)", "ℹ tests 7\nℹ suites 0\nℹ pass 7\nℹ fail 0\n"],
    ["seven of the eight lines (no duration_ms)", BLOCK8(7, 7, 0).replace(/ℹ duration_ms .*\n/, "")],
    ["a non-numeric duration", BLOCK8(7, 7, 0).replace("50020.1725", "fast")],
  ] as const) {
    const r = summaryOf(text, t);
    if (!r) return;
    assert.equal(r.pass, "NONE", `${name}: not a summary`);
  }
});

test("F2b (CODEX build r2): the summary is the full eight-line block at the END of the output: four forged titles shaped like its first four lines, wherever they sit, are never it", (t) => {
  const FORGED = ["✔ tests 5", "✔ suites 0", "✔ pass 5", "✔ fail 0"].join("\n") + "\n";
  // the CODEX four-title block followed by a real block: the real one is read
  const before = summaryOf(FORGED + BLOCK8(1860, 1860, 0), t);
  if (!before) return;
  assert.deepEqual([before.pass, before.fail, before.sumOk], ["1860", "0", "True"], "forged titles before the real block lose to it");
  const titlesAndPrefixed = summaryOf(["ℹ tests 5", "ℹ suites 0", "ℹ pass 5", "ℹ fail 0"].join("\n") + "\n" + BLOCK8(1860, 1860, 0), t);
  assert.ok(titlesAndPrefixed);
  assert.deepEqual([titlesAndPrefixed.pass, titlesAndPrefixed.fail], ["1860", "0"], "the same with the info mark");
  // the four-title block ALONE at the end, with no real summary: no match (the script STOPs)
  const alone = summaryOf("ℹ some earlier output\n" + FORGED, t);
  assert.ok(alone);
  assert.equal(alone.pass, "NONE", "four forged titles at the end are not the eight-line block");
  const aloneWithDurations = summaryOf(["✔ tests 5 (0.1ms)", "✔ suites 0 (0.1ms)", "✔ pass 5 (0.1ms)", "✔ fail 0 (0.1ms)"].join("\n") + "\n", t);
  assert.ok(aloneWithDurations);
  assert.equal(aloneWithDurations.pass, "NONE");
  // a forged EIGHT-line block before the real one still loses to it (only the block that ends the output counts)
  const eightForged = summaryOf(BLOCK8(5, 5, 0) + BLOCK8(1860, 1860, 0), t);
  assert.ok(eightForged);
  assert.deepEqual([eightForged.pass, eightForged.fail], ["1860", "0"]);
  // a real block followed by a stray non-whitespace line: no match (node prints failure detail after the summary of a FAILING run, so this is also what that looks like)
  for (const [name, tail] of [
    ["a stray line", "stray\n"],
    ["a title", "✔ pass 5 (0.4ms)\n"],
    ["node's failure heading", "✖ failing tests:\n"],
    ["a stray character on the last line", "x"],
  ] as const) {
    const r = summaryOf(BLOCK8(1860, 1860, 0) + tail, t);
    assert.ok(r);
    assert.equal(r.pass, "NONE", `${name} after the block: no match`);
  }
  // the real block with the number-bearing lines in the wrong order is no block
  const swapped = summaryOf(BLOCK8(1860, 1860, 0).replace("ℹ pass 1860\nℹ fail 0\n", "ℹ fail 0\nℹ pass 1860\n"), t);
  assert.ok(swapped);
  assert.equal(swapped.pass, "NONE", "the order of the lines is part of the block");
});

test("F2b: the counts must add up: tests == pass + fail + cancelled + skipped + todo (a sum that does not is reported, never read as a pass)", (t) => {
  const ok = summaryOf(BLOCK8(1865, 1860, 2, { cancelled: 1, skipped: 1, todo: 1 }), t);
  if (!ok) return;
  assert.deepEqual([ok.pass, ok.fail, ok.sumOk], ["1860", "2", "True"], "all five terms are in the sum");
  for (const [name, text] of [
    ["tests is one too many", BLOCK8(1861, 1860, 0)],
    ["tests is one too few", BLOCK8(1859, 1860, 0)],
    ["a cancelled count not in tests", BLOCK8(1860, 1860, 0, { cancelled: 1 })],
    ["a skipped count not in tests", BLOCK8(1860, 1860, 0, { skipped: 1 })],
    ["a todo count not in tests", BLOCK8(1860, 1860, 0, { todo: 1 })],
  ] as const) {
    const r = summaryOf(text, t);
    assert.ok(r);
    assert.equal(r.sumOk, "False", `${name}: the sum does not hold`);
  }
});

test("T6: a failing run is read as failing, and output with no summary is read as no summary (never as a pass)", (t) => {
  const failing = summaryOf(SAMPLE("ℹ", "\n").replace("pass 1860", "pass 1858").replace(/(\S+) fail 0/, "$1 fail 2"), t);
  if (!failing) return;
  assert.deepEqual([failing.pass, failing.fail], ["1858", "2"]);
  const none = summaryOf("✔ pass 5 (0.4ms)\n✔ fail 0 (0.1ms)\nnot a summary\n", t);
  assert.ok(none);
  assert.equal(none.pass, "NONE", "titles with durations are not a summary");
  assert.equal(summaryOf("", t)?.pass, "NONE");
});

test("T6: step 1 (the gates block), run for real with a stand-in for npm: it reports 1860 from that output, and STOPS on a failing run, an npm exit code, no summary, or a failing typecheck", (t) => {
  const run = (testOut: string, testExit: number, tscExit = 0) =>
    runPs(
      [
        ...PS_DEFS,
        "$out = Get-Content -Raw -Encoding UTF8 '@DIR@\\npm.txt'",
        `function npm { if ($args[0] -eq 'test') { $global:LASTEXITCODE = ${testExit}; return $out } else { $global:LASTEXITCODE = ${tscExit}; return 'tsc output' } }`,
        gatesBlock,
        'Write-Host "REACHED-END"',
        "exit 0",
      ],
      { "npm.txt": `﻿${testOut}` },
    );
  const good = run(SAMPLE("ℹ", "\n"), 0);
  if (!good) return skipNoPs(t);
  assert.equal(good.code, 0, good.out);
  assert.match(good.out, /\[tests\] pass 1860, fail 0; typecheck clean/);
  const cases: Array<[string, PsRun | null, RegExp]> = [
    ["a failing run", run(SAMPLE("ℹ", "\n").replace("pass 1860", "pass 1858").replace(/(\S+) fail 0/, "$1 fail 2"), 1), /\[STOP\] npm test: exit 1, pass '1858', fail '2'/],
    ["a failing summary although npm's exit code is 0 (the summary is judged on its own)", run(SAMPLE("ℹ", "\n").replace("pass 1860", "pass 1858").replace(/(\S+) fail 0/, "$1 fail 2"), 0), /\[STOP\] npm test: exit 0, pass '1858', fail '2'/],
    ["npm's exit code is non-zero although the summary says fail 0", run(SAMPLE("ℹ", "\n"), 1), /\[STOP\] npm test: exit 1/],
    ["no summary", run("✔ pass 5 (0.4ms)\nsomething else\n", 0), /\[STOP\] npm test: exit 0, the output does not END with node's eight-line summary/],
    ["no summary and a non-zero exit", run("Error: cannot find module\n", 1), /\[STOP\] npm test: exit 1, the output does not END with node's eight-line summary/],
    ["CODEX r2: four forged titles alone at the end, no real summary", run("ℹ earlier output\n✔ tests 5\n✔ suites 0\n✔ pass 5\n✔ fail 0\n", 0), /\[STOP\] npm test: exit 0, the output does not END with node's eight-line summary/],
    ["a real summary followed by a stray line (what a failing run's detail looks like)", run(BLOCK8(1858, 1856, 2) + "✖ failing tests:\n", 1), /\[STOP\] npm test: exit 1, the output does not END with node's eight-line summary/],
    ["a sum mismatch (tests is not pass + fail + cancelled + skipped + todo)", run(BLOCK8(1861, 1860, 0), 0), /\[STOP\] npm test: the summary's tests count \(1861\) is not pass \+ fail \+ cancelled \+ skipped \+ todo \(1860 \+ 0 \+ 0 \+ 0 \+ 0\)/],
    ["a sum mismatch through a cancelled count", run(BLOCK8(1860, 1860, 0, { cancelled: 1 }), 0), /\[STOP\] npm test: the summary's tests count \(1860\) is not pass \+ fail \+ cancelled \+ skipped \+ todo \(1860 \+ 0 \+ 1 \+ 0 \+ 0\)/],
    ["a failing typecheck", run(SAMPLE("ℹ", "\n"), 0, 2), /\[STOP\] typecheck failed: tsc output/],
  ];
  for (const [name, r, expected] of cases) {
    assert.ok(r);
    assert.equal(r.code, 1, `${name}: ${r.out}`);
    assert.match(r.out, expected, name);
    assert.doesNotMatch(r.out, /REACHED-END/, name);
  }
});

test("T6: the two older scripts carry the SAME anchored pattern (unless their tests pinned the old text; they did not), and not the unanchored one", (t) => {
  const d = definitions(t);
  if (!d) return;
  const pattern = script.match(/^\$TEST_SUMMARY_PATTERN = '(.*)'$/m)?.[1];
  assert.ok(pattern, "the new script's pattern is found");
  for (const f of ["deploy-refused-option-b.ps1", "deploy-m3-treasury.ps1"]) {
    const text = readFileSync(here(`../scripts/${f}`), "utf8").replace(/\r\n/g, "\n");
    assert.ok(text.includes(`[regex]::Matches($testOut, '${pattern}')`), `${f} carries the anchored pattern`);
    assert.equal(text.includes("[regex]::Match($testOut, 'pass (\\d+)')"), false, `${f} no longer takes the first 'pass N' anywhere`);
    assert.match(text, /if \(\$summary\.Count -gt 0 -and \[int64\]\$summary\[\$summary\.Count - 1\]\.Groups\[1\]\.Value -ne \(/, `${f} carries the tests == pass + fail + cancelled + skipped + todo check`);
    assert.match(text, /if \(\$summary\.Count -gt 0\) \{ \$pass = \$summary\[\$summary\.Count - 1\]\.Groups\[3\]\.Value; \$fail = \$summary\[\$summary\.Count - 1\]\.Groups\[4\]\.Value \}/, `${f} takes pass and fail from the LAST block`);
  }
});

// ---------- step 0's reviewed-source block, with its placeholder guard, run for real against a throwaway git repository ----------

const git = (cwd: string, ...args: string[]) => spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
const lines = (s: string): string[] => s.split(/\r?\n/).filter((l) => l.length > 0);

type Repo = { dir: string; reviewed: string; side: string };
const G = (dir: string, ...a: string[]) => {
  const r = spawnSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...a], { encoding: "utf8" });
  assert.equal(r.status, 0, `git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const putIn = (dir: string) => (p: string, text: string) => {
  mkdirSync(dirname(join(dir, p)), { recursive: true });
  writeFileSync(join(dir, p), text);
};
function makeRepo(): Repo {
  const dir = mkdtempSync(join(tmpdir(), "deploy-ci-repo-"));
  const put = putIn(dir);
  G(dir, "init", "-q", "-b", "main");
  put("src/x402.ts", "export const a = 1;\n");
  put("wrangler.jsonc", "{}\n");
  put("docs/a.md", "a\n");
  put("scripts/deploy-code-identity.ps1", "# script\n");
  put("test/deploy-code-identity-script.test.ts", "// test\n");
  G(dir, "add", "-A");
  G(dir, "commit", "-q", "-m", "the reviewed code");
  const reviewed = G(dir, "rev-parse", "HEAD");
  G(dir, "branch", "side");
  G(dir, "checkout", "-q", "side");
  put("docs/side.md", "side\n");
  G(dir, "add", "-A");
  G(dir, "commit", "-q", "-m", "side branch without the reviewed commit");
  const side = G(dir, "rev-parse", "HEAD");
  G(dir, "checkout", "-q", "main");
  return { dir, reviewed, side };
}
function onTop(repo: Repo, change: (put: (p: string, text: string) => void, g: (...a: string[]) => void) => void): void {
  change(putIn(repo.dir), (...a: string[]) => void G(repo.dir, ...a));
  G(repo.dir, "add", "-A");
  G(repo.dir, "commit", "-q", "--allow-empty", "-m", "after review");
}
function runReviewed(repo: Repo, reviewedCommit: string): PsRun | null {
  return runPs([
    "$ErrorActionPreference = 'Stop'",
    `Set-Location '${repo.dir}'`,
    defs,
    `$REVIEWED_COMMIT = '${reviewedCommit}'`,
    reviewedBlock,
    'Write-Host "REACHED-END"',
    "exit 0",
  ]);
}
const gone = (dir: string) => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* a read-only git object on Windows; the temp folder is the OS's to clear */
  }
};

test("the placeholder guard: while $REVIEWED_COMMIT still holds 'TO-BE-SET-BY-HUB' the script STOPS, whatever else is true of the repository", (t) => {
  const repo = makeRepo();
  try {
    const r = runReviewed(repo, PLACEHOLDER);
    if (!r) return skipNoPs(t);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /\[STOP\] \$REVIEWED_COMMIT still holds the placeholder 'TO-BE-SET-BY-HUB'/);
    assert.doesNotMatch(r.out, /REACHED-END|reviewed source:/);
  } finally {
    gone(repo.dir);
  }
});

test("the placeholder guard is pinned in the file: the constant is the placeholder or 40 lower-case hex, the placeholder text is the commission's, and the guard compares case-sensitively", (t) => {
  const d = definitions(t);
  if (!d) return;
  assert.equal(d.PLACEHOLDER, PLACEHOLDER);
  assert.match(d.REVIEWED, /^(TO-BE-SET-BY-HUB|[0-9a-f]{40})$/, "the hub sets it to a full sha; nothing else is valid");
  assert.match(script, /^\$REVIEWED_COMMIT = "[^"]+"$/m);
  assert.match(code, /if \(\$REVIEWED_COMMIT -ceq \$REVIEWED_COMMIT_PLACEHOLDER\) \{ Stop-Here/);
  assert.match(code, /if \(\$REVIEWED_COMMIT -cnotmatch '\^\[0-9a-f\]\{40\}\$'\) \{ Stop-Here/);
  if (/^[0-9a-f]{40}$/.test(d.REVIEWED)) {
    const root = here("..");
    const shallow = git(root, "rev-parse", "--is-shallow-repository");
    if (!shallow.error && shallow.status === 0 && shallow.stdout.trim() === "false") {
      assert.equal(git(root, "cat-file", "-t", d.REVIEWED).stdout.trim(), "commit", "once set, the reviewed commit is in this history");
      assert.equal(git(root, "merge-base", "--is-ancestor", d.REVIEWED, "HEAD").status, 0, "and HEAD descends from it");
    }
  }
});

// I5 (code-identity gate L4, commission): the script ships with $REVIEWED_COMMIT reset to the placeholder; the hub sets it to the merge sha after review. While the file holds the placeholder,
// the block AS SHIPPED (the constant read from the file, not injected as the tests above do) must STOP. Once the hub has set a sha this test has nothing to say about the placeholder and skips
// (the :559 pin above accepts either, on purpose, so the hub's edit does not turn a test red).
test("I5: the script as shipped holds the placeholder, and its step 0 block, run with the constant read from the FILE, STOPS on it", (t) => {
  const d = definitions(t);
  if (!d) return;
  if (d.REVIEWED !== PLACEHOLDER) return t.skip(`the hub has set the reviewed commit (${d.REVIEWED.slice(0, 8)}); the injected-value placeholder test above still exercises the guard`);
  assert.match(script, /^\$REVIEWED_COMMIT = "TO-BE-SET-BY-HUB"$/m, "the shipped constant is the placeholder, exactly");
  const repo = makeRepo();
  try {
    const r = runPs(["$ErrorActionPreference = 'Stop'", `Set-Location '${repo.dir}'`, defs, reviewedBlock, 'Write-Host "REACHED-END"', "exit 0"]);
    if (!r) return skipNoPs(t);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /\[STOP\] \$REVIEWED_COMMIT still holds the placeholder 'TO-BE-SET-BY-HUB'/);
    assert.doesNotMatch(r.out, /REACHED-END|reviewed source:/);
  } finally {
    gone(repo.dir);
  }
});

test("step 0 reviewed-source check: a malformed reviewed commit STOPS (upper case, 39 hex, a branch name, empty)", (t) => {
  const repo = makeRepo();
  try {
    for (const bad of [repo.reviewed.toUpperCase(), repo.reviewed.slice(0, 39), "main", " "]) {
      const r = runReviewed(repo, bad);
      if (!r) return skipNoPs(t);
      assert.equal(r.code, 1, `${JSON.stringify(bad)}: ${r.out}`);
      assert.match(r.out, /\[STOP\] \$REVIEWED_COMMIT '.*' is not 40 lower-case hex/, JSON.stringify(bad));
      assert.doesNotMatch(r.out, /REACHED-END/);
    }
  } finally {
    gone(repo.dir);
  }
});

test("step 0 reviewed-source check: HEAD = the reviewed commit plus only this script, its test and docs/ passes (and HEAD = the reviewed commit itself)", (t) => {
  const exact = makeRepo();
  const withAllowed = makeRepo();
  try {
    onTop(withAllowed, (put) => {
      put("docs/new.md", "new\n");
      put("docs/sub/deep.md", "deep\n");
      put("scripts/deploy-code-identity.ps1", "# script, edited\n");
      put("test/deploy-code-identity-script.test.ts", "// test, edited\n");
    });
    const a = runReviewed(exact, exact.reviewed);
    if (!a) return skipNoPs(t);
    assert.equal(a.code, 0, a.out);
    assert.match(a.out, /HEAD differs from [0-9a-f]{8} in 0 path\(s\)/);
    const b = runReviewed(withAllowed, withAllowed.reviewed);
    assert.ok(b);
    assert.equal(b.code, 0, b.out);
    assert.match(b.out, /in 4 path\(s\), all on the allowlist/);
    assert.match(b.out, /REACHED-END/);
  } finally {
    gone(exact.dir);
    gone(withAllowed.dir);
  }
});

test("step 0 reviewed-source check: a path outside the allowlist STOPS, naming it (src/, wrangler.jsonc, a migration, package files, a rename out of src/, one bad path among good ones)", (t) => {
  const cases: Record<string, { change: (put: (p: string, text: string) => void, g: (...a: string[]) => void) => void; names: string[] }> = {
    "src/x402.ts edited": { change: (put) => put("src/x402.ts", "export const a = 3;\n"), names: ["src/x402.ts"] },
    "wrangler.jsonc edited": { change: (put) => put("wrangler.jsonc", '{"vars":{"CODE_COMMIT":"0"}}\n'), names: ["wrangler.jsonc"] },
    "src/code-identity.ts added": { change: (put) => put("src/code-identity.ts", "export {};\n"), names: ["src/code-identity.ts"] },
    "package-lock.json added": { change: (put) => put("package-lock.json", "{}\n"), names: ["package-lock.json"] },
    "a new migration": { change: (put) => put("migrations/0099_x.sql", "SELECT 1;\n"), names: ["migrations/0099_x.sql"] },
    "src/x402.ts renamed into docs/ (both paths must be seen)": { change: (_p, g) => g("mv", "src/x402.ts", "docs/x402.md"), names: ["src/x402.ts"] },
    "an older deploy script edited": { change: (put) => put("scripts/deploy-refused-option-b.ps1", "# x\n"), names: ["scripts/deploy-refused-option-b.ps1"] },
    "one bad path among allowed ones": {
      change: (put) => {
        put("docs/new.md", "new\n");
        put("test/deploy-code-identity-script.test.ts", "// edited\n");
        put("src/sneaky.ts", "export {};\n");
      },
      names: ["src/sneaky.ts"],
    },
  };
  for (const [name, c] of Object.entries(cases)) {
    const repo = makeRepo();
    try {
      onTop(repo, c.change);
      const r = runReviewed(repo, repo.reviewed);
      if (!r) return skipNoPs(t);
      assert.equal(r.code, 1, `${name}: ${r.out}`);
      assert.match(r.out, /\[STOP\] these paths changed since the reviewed commit/, name);
      for (const p of c.names) assert.ok(r.out.includes(p), `${name}: the STOP names ${p}: ${r.out}`);
      assert.doesNotMatch(r.out, /REACHED-END/, name);
    } finally {
      gone(repo.dir);
    }
  }
});

test("step 0 reviewed-source check: a HEAD that does not contain the reviewed commit, and a sha that is no commit, each STOP", (t) => {
  const repo = makeRepo();
  try {
    const notContained = runReviewed(repo, repo.side);
    if (!notContained) return skipNoPs(t);
    assert.equal(notContained.code, 1, notContained.out);
    assert.match(notContained.out, /\[STOP\] HEAD does not contain the reviewed commit/);
    const unknown = runReviewed(repo, "0".repeat(40));
    assert.ok(unknown);
    assert.equal(unknown.code, 1, unknown.out);
    assert.match(unknown.out, /\[STOP\]/);
    assert.doesNotMatch(unknown.out, /REACHED-END/);
  } finally {
    gone(repo.dir);
  }
});

test("the allowlist is one constant of exactly this script, its test, and docs/; every other tracked path is refused", (t) => {
  const root = here("..");
  const listed = git(root, "ls-files");
  if (listed.error || listed.status !== 0) return t.skip("git is not available here");
  const allowedConst = code.match(/\$ALLOWED_PATHS_AFTER_REVIEW = @\(([^)]*)\)/);
  assert.ok(allowedConst, "the allowlist is one constant");
  assert.deepEqual([...allowedConst[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]), ["scripts/deploy-code-identity.ps1", "test/deploy-code-identity-script.test.ts", "docs/"]);
  assert.equal([...code.matchAll(/\$ALLOWED_PATHS_AFTER_REVIEW = /g)].length, 1, "stated once");
  assert.ok(existsSync(here("../scripts/deploy-code-identity.ps1")) && existsSync(here("../test/deploy-code-identity-script.test.ts")));
  const tracked = lines(listed.stdout);
  assert.ok(tracked.length > 100, "the whole tree is listed");
  const named = ["src/x402.ts", "src/code-identity.ts", "src/docs/evil.ts", "src/doc.ts", "migrations/0099_x.sql", "schema.sql", "package.json", "package-lock.json", "wrangler.jsonc", "tsconfig.json", ".claude/skills/x.md", "README.md",
    "docs", "docsx/a.md", "Docs/a.md", "scripts/deploy-code-identity.ps1.bak", "scripts/deploy-refused-option-b.ps1", "test/deploy-code-identity-script.test.ts/x", "test/other.test.ts"];
  const allowed = ["docs/BRIEF-SERVED-CODE-IDENTITY.md", "docs/a/b/c.md", "scripts/deploy-code-identity.ps1", "test/deploy-code-identity-script.test.ts"];
  const r = runPs(
    [
      ...PS_DEFS,
      "$all = @(Get-Content -Encoding UTF8 '@DIR@\\paths.txt')",
      "$cut = [array]::IndexOf($all, '---')",
      "$toCheck = @($all[0..($cut - 1)])",
      "$ok = @($all[($cut + 1)..($all.Count - 1)])",
      "$bad = @(Get-DisallowedPaths $toCheck)",
      'Write-Output ("REFUSED=" + $bad.Count)',
      "Write-Output (\"ALLOWEDREFUSED=\" + @(Get-DisallowedPaths $ok).Count)",
      "$bad | ForEach-Object { Write-Output (\"BAD:\" + $_) }",
    ],
    { "paths.txt": `﻿${[...tracked, ...named, "---", ...allowed].join("\n")}` },
  );
  if (!r) return skipNoPs(t);
  assert.equal(r.code, 0, r.out);
  const shouldAllow = (p: string) => p === "scripts/deploy-code-identity.ps1" || p === "test/deploy-code-identity-script.test.ts" || p.startsWith("docs/");
  const expectRefused = [...tracked, ...named].filter((p) => !shouldAllow(p));
  const refused = new Set([...r.out.matchAll(/^BAD:(.*)$/gm)].map((m) => m[1].replace(/\r$/, "")));
  assert.deepEqual(expectRefused.filter((p) => !refused.has(p)), [], "every tracked or named path outside the allowlist is refused");
  assert.match(r.out, /ALLOWEDREFUSED=0/, "the allowed paths are not refused");
  assert.equal(Number(r.out.match(/REFUSED=(\d+)/)?.[1]), expectRefused.length, "and nothing allowed was refused along the way");
});

// ---------- the constants, each pinned to a source of truth ----------

test("$V5_HASH is the live constitution's template hash (a re-mint turns this red, as it should)", async (t) => {
  const d = definitions(t);
  if (!d) return;
  assert.equal(d.V5, (await computeLiveConstitutionPair()).templateHash);
});

test("$LIVE_BASE_COMMIT is a full sha, names the option B deploy script's merge, and is an ancestor of HEAD", (t) => {
  const d = definitions(t);
  if (!d) return;
  assert.match(d.LIVE_BASE, /^[0-9a-f]{40}$/);
  assert.ok(d.LIVE_BASE.startsWith("ecbd51ff"), "main at the served-code-identity deploy (HANDOVER Addendum 87 s9)");
  assert.ok(script.includes("worker 8421a724 per HANDOVER Addendum 87 s9"), "the base comment names the worker version that deploy produced");
  assert.ok(script.includes("which should be 8421a724 per HANDOVER Addendum 87 s9"), "the rollback hint names the worker version that deploy produced");
  const root = here("..");
  const head = git(root, "rev-parse", "HEAD");
  const shallow = git(root, "rev-parse", "--is-shallow-repository");
  if (head.error || head.status !== 0 || shallow.error || shallow.status !== 0 || shallow.stdout.trim() !== "false") return t.skip("this checkout has no full git history to check the live base commit against");
  assert.equal(git(root, "cat-file", "-t", d.LIVE_BASE).stdout.trim(), "commit", `${d.LIVE_BASE} must be a commit in this repository`);
  assert.match(git(root, "log", "-1", "--format=%s", d.LIVE_BASE).stdout, /option B deploy script/);
  assert.equal(git(root, "merge-base", "--is-ancestor", d.LIVE_BASE, "HEAD").status, 0, "HEAD descends from the live worker's code");
});

test("step 0's sentinels: every one the script checks for is true of this source, and none was dropped", () => {
  const found: Array<{ file: string; pattern: string; positive: boolean }> = [];
  for (const line of code.split("\n")) {
    const m = line.match(/Select-String -Path "([^"]+)" -Pattern (?:"([^"]+)"|'([^']+)') -Quiet/);
    if (m) found.push({ file: m[1], pattern: m[2] ?? m[3], positive: /if \(-not \(Select-String/.test(line) });
  }
  assert.deepEqual(
    found.map((f) => `${f.positive ? "+" : "-"} ${f.file} :: ${f.pattern}`),
    [
      "+ src/settlement-claims.ts :: export function claimResponse\\(answer: ClaimAnswer, identity: CodeIdentity\\)",
      "+ src/settlement-claims.ts :: export async function markFirstRefusal",
      "+ src/society.ts :: export function parseLedgerCursor",
      "+ src/guest.ts :: export async function postGuestComment",
      '+ wrangler.jsonc :: "version_metadata"',
      '- wrangler.jsonc :: "CODE_COMMIT"',
    ],
    "the checkout sentinels, in order",
  );
  for (const f of found) {
    const present = new RegExp(f.pattern).test(readFileSync(here(`../${f.file}`), "utf8"));
    assert.equal(present, f.positive, `${f.file} :: ${f.pattern} must be ${f.positive ? "present" : "absent"} in this source`);
  }
  for (const p of ["src/code-identity.ts", "src/settlement-attention.ts"]) assert.ok(code.includes(`Test-Path "${p}"`) && existsSync(here(`../${p}`)), p);
});

test("the header says what the script proves and what it does not: the answered_by field is proved by tests until a real claim answer rides it, and nothing proves the bytes match the commit", () => {
  assert.match(script, /answered_by` on a claim answer cannot be staged/);
  assert.match(script, /Nothing served proves the running bytes were built from the commit/);
  assert.match(script, /it never calls wrangler/);
  assert.match(script, /NO MIGRATION, NON-MINTING/);
});

test("F2b: the older scripts' inline summary lines, extracted and run for real, read the block at the END, STOP on a sum mismatch, and read nothing from forged titles or a stray tail", (t) => {
  const outputs: Array<[string, string, RegExp]> = [
    ["the real block", BLOCK8(1860, 1860, 0), /PASS=1860 FAIL=0$/m],
    ["four forged titles then the real block", "✔ tests 5\n✔ suites 0\n✔ pass 5\n✔ fail 0\n" + BLOCK8(1860, 1860, 0), /PASS=1860 FAIL=0$/m],
    ["four forged titles alone at the end", "✔ tests 5\n✔ suites 0\n✔ pass 5\n✔ fail 0\n", /PASS= FAIL=$/m],
    ["the real block then a stray line", BLOCK8(1860, 1860, 0) + "stray\n", /PASS= FAIL=$/m],
    ["a sum mismatch", BLOCK8(1861, 1860, 0), /\[STOP\] npm test: the summary's tests count is not pass \+ fail \+ cancelled \+ skipped \+ todo\./],
  ];
  for (const f of ["deploy-refused-option-b.ps1", "deploy-m3-treasury.ps1"]) {
    const text = readFileSync(here(`../scripts/${f}`), "utf8").replace(/\r\n/g, "\n");
    const start = text.indexOf("$summary = [regex]::Matches($testOut,");
    const endLine = text.indexOf("\n", text.indexOf("if ($summary.Count -gt 0 -and "));
    assert.ok(start > 0 && endLine > start, `${f}: the inline summary lines are found`);
    const chunk = text.slice(start, endLine);
    assert.ok(chunk.split("\n").length <= 6, `${f}: the extracted chunk is only the summary lines`);
    for (const [name, out, expected] of outputs) {
      const r = runPs(
        ["$ErrorActionPreference = 'Stop'", 'function Stop-Here($msg) { Write-Host "[STOP] $msg"; exit 1 }', "$testOut = Get-Content -Raw -Encoding UTF8 '@DIR@\\out.txt'", chunk, 'Write-Output ("PASS=" + $pass + " FAIL=" + $fail)'],
        { "out.txt": `\uFEFF${out}` },
      );
      if (!r) return skipNoPs(t);
      assert.match(r.out.replace(/\r/g, ""), expected, `${f}: ${name}: ${r.out}`);
    }
  }
});
