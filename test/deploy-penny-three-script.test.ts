// scripts/deploy-penny-three.ps1 is WRITTEN AND NEVER RUN by the builder (hard rule: no deploy, no wrangler command, not even -DryRun, which reads the live worker over HTTP).
// It is proven here by everything that can be proven without running it: it parses under PowerShell's own parser, it is ASCII with LF line endings, it has none of the traps the repo's L-080
// family names, its steps are in the load-bearing order (the two pins FIRST, fetch, pin, template check, no-migration check, reviewed source, the penny-three code present, gates, the live probes,
// dry-run exit, deploy, version id, poll, attest, ride), it has NO migration step and touches no D1 at all, step 0a stops on EITHER placeholder before any git or network command, the reviewed-commit
// pin is the placeholder or a full 40-hex sha and nothing else, and the ride is public GETs ONLY (no POST of any kind, no credential, nothing written). Its decision functions are run for real under
// PowerShell against what the real code serves (officialFacts, citizenDirectory over real ledger rows, guestDue), and each is shown to answer differently on a body that breaks one thing. The pattern
// is test/deploy-seat-counts-script.test.ts. Every check fails when the script is mutated (the checkpoint lists the mutants).
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
import { createLocalD1, guestEnv } from "./helpers/guest.ts";
import { insertCitizen } from "./helpers/local-d1.ts";
import { citizenDirectory, officialFacts, OPERATOR_CONTROLLED_HANDLES, SPONSORED_HANDLES } from "../src/society.ts";
import { registrationRowText } from "./helpers/registration-row.ts";
import { guestDue } from "../src/guest.ts";

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
const SCRIPT_PATH = here("../scripts/deploy-penny-three.ps1");
const rawScript = readFileSync(SCRIPT_PATH, "utf8");
const script = rawScript.replace(/\r\n/g, "\n");
// Code lines only: a comment may name a trap it avoids.
const code = script
  .split("\n")
  .filter((l) => !/^\s*#/.test(l))
  .join("\n");
const at = (needle: string, from = 0) => {
  const i = code.indexOf(needle, from);
  assert.ok(i >= 0, `the script must contain: ${needle}`);
  return i;
};
const DEFS_END = "# END-OF-DEFINITIONS";
const block = (name: string): string => script.slice(script.indexOf(`# BEGIN-${name}`), script.indexOf(`# END-${name}`));
const defs = script.slice(script.indexOf('$ErrorActionPreference = "Stop"'), script.indexOf(DEFS_END));
const pinBlock = block("PIN-CHECK");
const reviewedBlock = block("REVIEWED-SOURCE-CHECK");

type PsRun = { code: number | null; out: string };
// A PowerShell 5.1 harness. The .ps1 is written ASCII-only; data goes in files read with -Encoding UTF8.
function runPs(lines: string[], files: Record<string, string> = {}): PsRun | null {
  const dir = mkdtempSync(join(tmpdir(), "deploy-penny-three-"));
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

// ---------- the static proofs ----------

test("the script parses under PowerShell's own parser with zero errors, is ASCII only and has LF line endings", (t) => {
  assert.equal(/[^\x00-\x7f]/.test(rawScript), false, "5.1 reads a BOM-less UTF-8 script as the ANSI code page: ASCII only");
  assert.equal(rawScript.includes("\r"), false, "LF line endings only");
  const parsed = parsePowerShellFile(SCRIPT_PATH);
  if (!parsed.available) {
    t.skip(`${parsed.reason}; the static checks below still run`);
    return;
  }
  assert.equal(parsed.errors, 0, `parse errors: ${parsed.detail}`);
});

test("no PowerShell traps: no two variables differing only by case, no `$var:` drive reference, no stderr merged outside a Continue block, no -notmatch over a pipeline, no -and mixed with -or on one line", () => {
  const names = new Map<string, Set<string>>();
  for (const m of code.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)) {
    const set = names.get(m[1].toLowerCase()) ?? new Set<string>();
    set.add(m[1]);
    names.set(m[1].toLowerCase(), set);
  }
  const clashes = [...names.values()].filter((s) => s.size > 1).map((s) => [...s].join(" / "));
  assert.deepEqual(clashes, [], "a variable name is case-insensitive in PowerShell: one spelling each");
  assert.equal(/\$[A-Za-z_][A-Za-z0-9_]*:/.test(code.replace(/\$\(/g, "")), false, '"$var:" is a drive reference: write "${var}:"');
  for (const m of code.matchAll(/2>&1/g)) {
    const before = code.slice(0, m.index);
    assert.ok(before.lastIndexOf('$ErrorActionPreference = "Continue"') > before.lastIndexOf('$ErrorActionPreference = "Stop"'), "a native command's stderr is merged only while ErrorActionPreference is Continue");
  }
  assert.equal(/\$\w+\s*\|\s*Where-Object[^\n]*-notmatch/.test(code), false, "no -notmatch over a pipeline of lines");
  assert.equal(/-notcontains|-notin\b/.test(code.replace(/-cnotcontains/g, "")), false, "a case-insensitive membership test would pass a key spelled in another case: use -cnotcontains");
  const mixed = (s: string) => /\s-and\s/.test(s) && /\s-or\s/.test(s);
  for (const line of code.split("\n")) {
    let rest = line.replace(/"[^"]*"|'[^']*'/g, '""');
    for (let guard = 0; guard < 50 && /\([^()]*\)/.test(rest); guard++) {
      for (const m of rest.matchAll(/\(([^()]*)\)/g)) assert.equal(mixed(m[1]!), false, `a group mixes -and with -or: ${line.trim().slice(0, 120)}`);
      rest = rest.replace(/\([^()]*\)/g, "X");
    }
    assert.equal(mixed(rest), false, `a line mixes -and with -or: ${line.trim().slice(0, 120)}`);
  }
  assert.equal(mixed("if ($a -eq 1 -and $b -or $c)"), true, "positive control: the check can fail");
});

test("parameters: -ExpectedCommit is mandatory and -DryRun exists; there is NO -MigrationAlreadyApplied, because there is no migration", () => {
  assert.match(script, /\[Parameter\(Mandatory = \$true\)\]\[string\]\$ExpectedCommit/);
  assert.match(script, /\[switch\]\$DryRun/);
  assert.equal(/MigrationAlreadyApplied/.test(script), false);
});

test("the pins: the v5 hash, the live base (the seat counts wave's deployed commit), the reviewed commit (the hub's placeholder or a full 40-hex sha), the operator's stated wallet and the allowlist", () => {
  assert.match(script, /^\$V5_HASH = "fa11788d062b0c6d23c54c428c1c9649d263ae3ba704e602e122066926049491"$/m);
  assert.match(script, /^\$LIVE_BASE_COMMIT = "8f866a64c14cd19451a7b9e58e6fcd1ff5075eb2"$/m);
  // Before the hub sets it the reviewed pin is the placeholder; after, the full sha (40 lower-case hex). Either is a valid committed state; anything else is not.
  assert.match(script, /^\$REVIEWED_COMMIT = "(?:TO-BE-SET-BY-HUB|[0-9a-f]{40})"$/m, "the reviewed commit is the hub's placeholder or a full 40-hex sha");
  assert.equal(/^\$REVIEWED_COMMIT = "[0-9a-f]*[A-F][0-9a-fA-F]*"$/m.test(script), false, "an upper-case sha is not a valid committed state");
  assert.match(script, /^\$LIVE_BASE_PLACEHOLDER = "TO-BE-SET-BY-HUB-LIVE-BASE"$/m);
  assert.match(script, /^\$REVIEWED_COMMIT_PLACEHOLDER = "TO-BE-SET-BY-HUB"$/m);
  assert.match(script, /^\$OPERATOR_WALLET = "0x3f2950654ef9bf2d73805a77a07e4e14d5f74f16"$/m, "the operator's stated wallet, typed in the script itself so the ride recomputes the flag");
  const allowed = /\$ALLOWED_PATHS_AFTER_REVIEW = @\(([^)]*)\)/.exec(code)?.[1] ?? "";
  assert.deepEqual([...allowed.matchAll(/"([^"]+)"/g)].map((m) => m[1]), ["scripts/deploy-penny-three.ps1", "test/deploy-penny-three-script.test.ts", "docs/"]);
  assert.equal([...code.matchAll(/\$ALLOWED_PATHS_AFTER_REVIEW = /g)].length, 1, "stated once");
  assert.match(code, /\$ROLLBACK_LINE = .*\$rollbackTarget/, "the rollback line names the version read from the live worker");
  assert.match(code, /\$ROLLBACK_LINE = .*applied no migration and wrote no row, so the rollback is the whole undo/, "and says the rollback is the whole undo");
  assert.equal(/\$ROLLBACK_WORKER_VERSION/.test(code), false, "no typed-in rollback version: it is read live, before the deploy");
});

test("the committed-state check accepts the placeholder OR 40 lower-case hex and rejects an upper-case sha, and the same check can fail", () => {
  const accepts = (line: string) => /^\$REVIEWED_COMMIT = "(?:TO-BE-SET-BY-HUB|[0-9a-f]{40})"$/m.test(line);
  assert.equal(accepts('$REVIEWED_COMMIT = "TO-BE-SET-BY-HUB"'), true);
  assert.equal(accepts('$REVIEWED_COMMIT = "' + "0123456789abcdef".repeat(2) + "01234567" + '"'), true);
  assert.equal(accepts('$REVIEWED_COMMIT = "' + "0123456789ABCDEF".repeat(2) + "01234567" + '"'), false, "an upper-case sha is refused");
  assert.equal(accepts('$REVIEWED_COMMIT = "0123456"'), false, "a short sha is refused");
  assert.equal(accepts('$REVIEWED_COMMIT = "TO-BE-SET-BY-HUB-LIVE-BASE"'), false, "another placeholder is refused");
});

test("step 0a STOPS before ANY git, npm, wrangler or network command while EITHER pin is its placeholder (or is not 40 lower-case hex); it is the first thing after the definitions", (t) => {
  assert.ok(pinBlock.length > 300, "the pin block exists");
  assert.ok(at("$LIVE_BASE_COMMIT -ceq $LIVE_BASE_PLACEHOLDER") < at("git fetch origin --quiet"), "the live-base pin is checked before the fetch");
  assert.ok(at("$REVIEWED_COMMIT -ceq $REVIEWED_COMMIT_PLACEHOLDER") < at("git fetch origin --quiet"), "the reviewed pin is checked before the fetch");
  assert.ok(at("$LIVE_BASE_COMMIT -cnotmatch") < at("git merge-base --is-ancestor $LIVE_BASE_COMMIT HEAD"), "a malformed live base can never reach git merge-base");
  for (const forbidden of ["git ", "npm ", "npx ", "curl.exe", "Get-Text", "Read-Attest"]) {
    assert.equal(pinBlock.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n").includes(forbidden), false, `the pin block never calls ${forbidden.trim()}`);
  }
  const run = (live: string, reviewed: string) => runPs([...PS_DEFS, `$LIVE_BASE_COMMIT = '${live}'`, `$REVIEWED_COMMIT = '${reviewed}'`, pinBlock, "Write-Output 'PAST-PINS'"]);
  const sha40 = "0123456789abcdef0123456789abcdef01234567";
  const both = run("TO-BE-SET-BY-HUB-LIVE-BASE", "TO-BE-SET-BY-HUB");
  if (!both) return t.skip("powershell is not available on this machine");
  const liveOnly = run("TO-BE-SET-BY-HUB-LIVE-BASE", sha40);
  const reviewedOnly = run(sha40, "TO-BE-SET-BY-HUB");
  const shortLive = run("abc1234", sha40);
  const upperReviewed = run(sha40, sha40.toUpperCase());
  const good = run(sha40, sha40);
  for (const [label, r, pattern] of [
    ["both placeholders", both, /\[STOP\].*LIVE_BASE_COMMIT still holds the placeholder/],
    ["the live-base placeholder alone", liveOnly, /\[STOP\].*LIVE_BASE_COMMIT still holds the placeholder/],
    ["the reviewed placeholder alone (the state this script is committed in)", reviewedOnly, /\[STOP\].*REVIEWED_COMMIT still holds the placeholder/],
    ["a short live base", shortLive, /\[STOP\].*LIVE_BASE_COMMIT 'abc1234' is not 40 lower-case hex/],
    ["an upper-case reviewed sha", upperReviewed, /\[STOP\].*REVIEWED_COMMIT '[0-9A-F]{40}' is not 40 lower-case hex/],
  ] as const) {
    assert.equal(r!.code, 1, `${label}: exit 1, got ${r!.code}: ${r!.out}`);
    assert.match(r!.out, pattern, label);
    assert.match(r!.out, /Nothing was read or written/, `${label}: says so`);
    assert.equal(/PAST-PINS/.test(r!.out), false, `${label}: must not pass`);
    assert.equal(/must not run while the definitions/.test(r!.out), false, `${label}: touched git, npm, wrangler or curl before stopping`);
  }
  assert.equal(good!.code, 0, good!.out);
  assert.match(good!.out, /PAST-PINS/, "positive control: two real shas pass the block");
});

test("as committed, the pins block decides on the value the file holds: the hub's placeholder STOPS at step 0a before anything is fetched, tested, read or deployed; a full 40-hex sha set by the hub after the review passes it", (t) => {
  const reviewed = /^\$REVIEWED_COMMIT = "([^"]+)"$/m.exec(script)![1];
  const isPlaceholder = reviewed === "TO-BE-SET-BY-HUB";
  assert.ok(isPlaceholder || /^[0-9a-f]{40}$/.test(reviewed), "$REVIEWED_COMMIT is the placeholder or a full 40-hex sha, not '" + reviewed + "'");
  const r = runPs([
    ...PS_DEFS,
    `$LIVE_BASE_COMMIT = '${/^\$LIVE_BASE_COMMIT = "([^"]+)"$/m.exec(script)![1]}'`,
    `$REVIEWED_COMMIT = '${reviewed}'`,
    pinBlock,
    "Write-Output 'PAST-PINS'",
  ]);
  if (!r) return t.skip("powershell is not available on this machine");
  if (isPlaceholder) {
    assert.equal(r.code, 1);
    assert.match(r.out, /REVIEWED_COMMIT still holds the placeholder/);
    assert.equal(/PAST-PINS/.test(r.out), false);
  } else {
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /PAST-PINS/, "the hub's sha passes the pins block");
  }
});

test("the steps are in the load-bearing order: pins, fetch, branch, clean tree, ancestry, template check, no-migration check, reviewed source, the penny-three code present, gates, probes (live base proved, new fields absent, figures recorded), (dry-run exit), deploy, version id, poll, attest, ride (public reads, the counts, the figures, the payer trace, the list, the served words)", () => {
  const order = [
    "$LIVE_BASE_COMMIT -ceq $LIVE_BASE_PLACEHOLDER",
    "$REVIEWED_COMMIT -ceq $REVIEWED_COMMIT_PLACEHOLDER",
    "git fetch origin --quiet",
    "rev-parse --abbrev-ref HEAD",
    "origin/main",
    "git status --porcelain",
    "git merge-base --is-ancestor $LIVE_BASE_COMMIT HEAD",
    'git show ($LIVE_BASE_COMMIT + ":src/doc.ts")',
    'git show ($headSha + ":src/doc.ts")',
    "$liveTemplate -cne $headTemplate",
    "--name-status --no-renames $LIVE_BASE_COMMIT HEAD -- migrations schema.sql",
    "git merge-base --is-ancestor $REVIEWED_COMMIT HEAD",
    "Get-DisallowedPaths $afterReview",
    "export async function everWrittenSeats",
    "$testOut = (npm test",
    "$attBefore = Read-Attest",
    "[string]$attBefore.code.commit -cne $LIVE_BASE_COMMIT",
    "$officialBefore = Get-Text",
    "Test-EverWrittenAbsent $officialBefore.Body",
    "Test-PayerTraceAbsent $citizensBefore.Body",
    "Test-ReceivedElsewhereAbsent $dueBefore.Body",
    "$snapshotBefore = Get-CompositionSnapshot",
    "if ($DryRun) {",
    "$deployOut = (npx wrangler deploy",
    "Current Version ID",
    "Wait-NewWorker $headSha",
    "Assert-Attest $attAfter",
    "foreach ($p in",
    "$officialNow = Get-Text",
    "$servedWhy = Test-EverWrittenServed",
    "$snapshotAfter = Get-CompositionSnapshot",
    "$traceWhy = Test-PayerTraceServed",
    "$dueWhy = Test-ReceivedElsewhereServed",
    "$llmsNow = Get-Text",
  ];
  const body = code.slice(code.indexOf('if ($LIVE_BASE_COMMIT -ceq $LIVE_BASE_PLACEHOLDER)'));
  let last = -1;
  for (const needle of order) {
    const i = body.indexOf(needle, last + 1);
    assert.ok(i > last, `"${needle}" must come after the previous step (found at ${i}, previous at ${last})`);
    last = i;
  }
  const dryExit = body.indexOf("exit 0", body.indexOf("if ($DryRun) {"));
  assert.ok(dryExit > 0 && dryExit < body.indexOf("$deployOut = (npx wrangler deploy"), "-DryRun exits before the deploy");
  assert.equal(code.split("$deployOut = (npx wrangler deploy").length - 1, 1, "one deploy");
});

test("NO migration and NO D1 access of any kind: no wrangler d1, no migration apply; the one wrangler command is the stamped deploy (and a rollback is only text for Ben)", () => {
  assert.equal(/wrangler d1|d1 execute|Invoke-D1Read|--file|migrationPath|MIGRATION_/.test(code), false, "no D1 and no migration in the executed code");
  const calls = [...code.matchAll(/^\s*(?:\$\w+ = \()?npx wrangler ([a-z0-9]+)/gm)].map((m) => m[1]);
  assert.deepEqual(calls, ["deploy"], "exactly one executed wrangler subcommand, and it is deploy");
  assert.equal(/npx wrangler (rollback|secret|delete|tail|versions|kv|r2|queues|d1)/.test(code.replace(/\$ROLLBACK_LINE = "[^"]*"/, "").replace(/\$ErrorActionPreference[^\n]*/g, "")), false, "no other wrangler subcommand is ever executed");
  assert.match(code, /npx wrangler deploy --var "CODE_COMMIT:\$headSha"/, "the deploy stamps the pinned full sha (served code identity)");
  assert.equal([...code.matchAll(/^\s*\$deployOut = \(npx wrangler deploy --var/gm)].length, 1, "one executed deploy line carries the stamp");
  // step 0 STOPS if the wave grew a migration or a schema change: this script could not apply it
  assert.match(code, /\$schemaMoves = @\(git diff --name-status --no-renames \$LIVE_BASE_COMMIT HEAD -- migrations schema\.sql\)/);
  assert.match(code, /\$schemaMoves\.Count -gt 0\) \{ Stop-Here/);
});

test("the ride is public GETs ONLY: no POST of any kind, no data argument, no credential, one curl.exe command (inside Get-Text), every changed surface is asserted, and the closing log says it wrote nothing", () => {
  assert.equal(/Authorization|Bearer|ch1\.|api\/resident\/(bind|token)|api\/council\/(challenge|claim|ballot)|guest_enter|guest_comment|showhome_note|resident_|council_(ballot|flag|motion)|initialize/.test(code), false, "nothing in the executed code authenticates, initializes or calls a write or guest tool");
  assert.equal(/-X\s|--request|--data|-d\s+["'@]|--form|-F\s|--upload-file|-T\s|Post-Rpc|\bPOST\b|\bPUT\b|\bPATCH\b|\bDELETE\b|Invoke-WebRequest|Invoke-RestMethod|-Method\b/.test(code), false, "no HTTP method but GET ever appears in the executed code");
  assert.equal([...code.matchAll(/curl\.exe/g)].length, 1, "exactly one curl.exe command in the whole script (inside Get-Text)");
  assert.match(code, /curl\.exe -s --max-time \$maxTime -o \$tmp -w "%\{http_code\}" \$url/, "and it is a plain GET");
  const listLine = code.split("\n").find((l) => /^foreach \(\$p in "\/", /.test(l)) ?? "";
  const listed = [...listLine.matchAll(/"(\/[^"]*)"/g)].map((m) => m[1]!);
  assert.equal(listed.length, 14, "fourteen public reads");
  assert.equal(listed.includes("/skill.md") || listed.includes("/heartbeat.md"), false, "neither door-counted file is read");
  assert.equal(/Get-(Text|Json)[^\n]*(skill\.md|heartbeat)/.test(code), false, "/skill.md and /heartbeat.md are never read");
  // each surface is asserted
  assert.match(code, /\$servedWhy = Test-EverWrittenServed \$officialNow\.Body/, "the counts, their consistency and their provenance");
  assert.match(code, /\$servedWhy -ne ""\) \{ Stop-Here/, "and a reason STOPS the ride");
  assert.match(code, /Test-OfficialNoteNamesEverWritten \$officialNow\.Body/, "the composition note");
  assert.match(code, /\$snapshotAfter -cne \$snapshotBefore\) \{ Stop-Here/, "the composition figures must equal the ones served before");
  assert.match(code, /\$traceWhy = Test-PayerTraceServed \$citizensNow\.Body \$comp\.operator_paid/, "payer_trace on every row, checked against operator_paid");
  assert.match(code, /\$traceWhy -ne ""\) \{ Stop-Here/);
  assert.match(code, /Test-CitizensNoteNamesPayerTrace \$citizensNow\.Body\)\) \{ Stop-Here/, "the citizens note");
  assert.match(code, /\$dueWhy = Test-ReceivedElsewhereServed \$dueNow\.Body/, "received_elsewhere");
  assert.match(code, /\$dueWhy -ne ""\) \{ Stop-Here/);
  assert.match(code, /Test-DueNoteSeparatesList \$dueNow\.Body\)\) \{ Stop-Here/, "the due note");
  assert.match(code, /\$llmsNow\.Body\.Contains\(\$name\)\) \{ Stop-Here/, "llms.txt names each new field");
  for (const name of ["ever_written", "not_designated_ever_written", "payer_trace", "direct_payer_is_operator_wallet", "beyond_direct_payer", "received_elsewhere"]) {
    assert.ok(/foreach \(\$name in ([^)\n]*)/.exec(code)![1]!.includes(`"${name}"`), `the llms.txt loop names ${name}`);
  }
  assert.match(code, /Writes made by this ride: NONE\. Every request was a GET/, "the closing log says it wrote nothing");
  assert.match(script, /WRITES NOTHING/, "the header says so");
  assert.match(script, /NO POST OF ANY KIND/, "and that there is no POST");
});

test("it stops unless main, origin/main and -ExpectedCommit are ONE commit, after a fetch, on a clean tree, and HEAD is 40 lower-case hex (the stamp)", () => {
  assert.match(code, /if \(\$branch -cne "main"\)/);
  assert.match(code, /\$mainSha -cne \$originSha -or \$mainSha -cne \$expectedSha -or \$headSha -cne \$expectedSha/);
  assert.match(code, /git status --porcelain/);
  assert.ok(at("git fetch origin --quiet") < at("git rev-parse origin/main"), "origin/main is read AFTER the fetch");
  assert.match(code, /\$headSha -cnotmatch '\^\[0-9a-f\]\{40\}\$'/);
});

test("non-minting: it compares FRONT_DOOR_TEMPLATE itself between the live base and HEAD, stops on a difference, and verifies v5 and every chain before and after the deploy", () => {
  assert.match(code, /if \(\$liveTemplate -cne \$headTemplate\) \{ Stop-Here/);
  assert.match(code, /\[string\]\$att\.constitution\.version -ne "5"/);
  assert.match(code, /\$att\.constitution\.template_hash -cne \$V5_HASH/);
  assert.match(code, /\$att\.ok -ne \$true/);
  for (const chain of ["identity_log", "treasury", "payouts", "ballots"]) assert.ok(code.includes(`"${chain}"`), `the ${chain} chain is checked`);
  assert.ok(at("Assert-Attest $attBefore") < at("$deployOut = (npx wrangler deploy"), "checked before");
  assert.ok(at("Assert-Attest $attAfter") > at("$deployOut = (npx wrangler deploy"), "and after");
});

test("it proves the live worker IS the pinned base (code.commit equals $LIVE_BASE_COMMIT), reads the rollback target from it, and probes that the new fields are ABSENT on all three answers before the deploy, which is what makes the poll mean something; the poll needs the stamped commit AND the printed version id AND the three served answers", () => {
  assert.match(code, /\[string\]\$attBefore\.code\.commit -cne \$LIVE_BASE_COMMIT/);
  assert.match(code, /\$rollbackTarget = \[string\]\$attBefore\.code\.version_id/);
  assert.match(code, /^\$OFFICIAL_URL = "\$BASE\/api\/official"$/m);
  assert.match(code, /^\$CITIZENS_URL = "\$BASE\/api\/citizens"$/m);
  assert.match(code, /^\$DUE_URL = "\$BASE\/api\/guest\/due"$/m);
  assert.match(code, /if \(-not \(Test-EverWrittenAbsent \$officialBefore\.Body\)\) \{ Stop-Here/);
  assert.match(code, /if \(-not \(Test-PayerTraceAbsent \$citizensBefore\.Body\)\) \{ Stop-Here/);
  assert.match(code, /if \(-not \(Test-ReceivedElsewhereAbsent \$dueBefore\.Body\)\) \{ Stop-Here/);
  assert.match(code, /Current Version ID:/);
  assert.match(code, /\$versionMatches\.Count -gt 1\) \{ Stop-Here/);
  assert.match(code, /\$versionMatches\.Count -lt 1\) \{ Stop-Here/);
  assert.match(code, /\$code\.commit -cne \$commit/);
  assert.match(code, /\$code\.version_id\)\.ToLowerInvariant\(\) -cne/);
  const poll = /function Wait-NewWorker[\s\S]*?\n}\n/.exec(code)![0];
  assert.ok(poll.includes("Test-CodeIdentityServed (Get-ServedCode) $commit $versionId") && poll.includes("Get-NewSurfacesReason"), "the poll waits for the stamped identity AND the three served answers");
  const surfaces = /function Get-NewSurfacesReason[\s\S]*?\n}\n/.exec(code)![0];
  for (const needle of ["Test-EverWrittenServed", "Test-PayerTraceServed", "Test-ReceivedElsewhereServed", "$OFFICIAL_URL", "$CITIZENS_URL", "$DUE_URL"]) assert.ok(surfaces.includes(needle), `the poll's surface check reads ${needle}`);
});

test("step 0 requires the penny-three code in the checkout (so a stale tree cannot ride this script) and the earlier waves it must not drop", () => {
  assert.match(code, /Select-String -Path "src\/society\.ts" -Pattern "export async function everWrittenSeats"/);
  assert.match(code, /Select-String -Path "src\/society\.ts" -Pattern "export async function payerTracesFor"/);
  assert.match(code, /Select-String -Path "src\/register-gate\.ts" -Pattern "export function parseRegistrationDescription"/);
  assert.match(code, /Select-String -Path "src\/guest-core\.ts" -Pattern "export const RECEIVED_ELSEWHERE:" -SimpleMatch -Quiet/);
  assert.match(code, /Select-String -Path "src\/society\.ts" -Pattern "export async function actedWritersSince"/);
  for (const real of [
    ["src/society.ts", "export async function everWrittenSeats"],
    ["src/society.ts", "export async function payerTracesFor"],
    ["src/register-gate.ts", "export function parseRegistrationDescription"],
    ["src/guest-core.ts", "export const RECEIVED_ELSEWHERE:"],
    ["src/society.ts", "export async function actedWritersSince"],
    ["src/council.ts", "export async function citizenWritersSince"],
    ["src/index.ts", 'path === "/api/treasury" && method === "GET"'],
    ["src/society.ts", "export const OPERATOR_FUNDED_SCOPE_SENTENCE"],
    ["src/doors.ts", '"mcp_read_tool_call"'],
    ["src/council-core.ts", "export const citizenCouncilFlagParts"],
    ["src/council.ts", "export async function claimCouncilSeat"],
  ] as const) {
    assert.ok(readFileSync(here(`../${real[0]}`), "utf8").includes(real[1]), `${real[0]} really contains: ${real[1]}`);
  }
});

// ---------- the definitions, run for real (stubs for npx, git, npm and curl: a stray top-level command turns this red) ----------

let evaluated: Record<string, string> | null | undefined;
function definitions(t: { skip: (m: string) => void }): Record<string, string> | null {
  if (evaluated === undefined) {
    const r = runPs([...PS_DEFS, 'Write-Output ("TRIES=" + $POLL_TRIES)', 'Write-Output ("DELAY=" + $POLL_DELAY_SECONDS)', 'Write-Output "EVALUATED-OK"']);
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

test("the definitions region runs nothing, and the poll is bounded (12 tries 5 s apart)", (t) => {
  const d = definitions(t);
  if (!d) return;
  assert.equal(d.TRIES, "12");
  assert.equal(d.DELAY, "5");
});

// The live shape: the 5 operator seats, the 7 sponsored seats and sisyphus (13 citizens, one key-lost). Three of them wrote a day ago (an operator seat, sisyphus, a sponsored seat), so
// ever_written 3, not_designated_ever_written 2, acted_30d 3. Every seat has a registration row in the ledger: the 12 operator-controlled and sponsored ones paid from the operator's wallet, sisyphus from another.
const OPERATOR = "0x3f2950654ef9bf2d73805a77a07e4e14d5f74f16";
const OUTSIDE = "0xb54bb69b0d61b1f4083ec4d3992d84d85564d398";
function seeded() {
  const d1 = createLocalD1();
  const ids = new Map<string, number>();
  const all = [...OPERATOR_CONTROLLED_HANDLES, ...SPONSORED_HANDLES, "sisyphus"];
  for (const h of all) ids.set(h, insertCitizen(d1, { handle: h }));
  const ago = Date.now() - 86_400_000;
  const post = (handle: string, n: number) => d1.raw.prepare("INSERT INTO posts (citizen_id, title, body, dupe_hash, created_at) VALUES (?, 't', 'b', ?, ?)").run(ids.get(handle)!, `seed-h${n}`, ago);
  post("commonhold-agent", 1);
  post("sisyphus", 2);
  post("boundary-auditor-v2", 3);
  all.forEach((h, i) => {
    d1.raw.prepare("INSERT INTO ledger (entry_date, description, amount_cents, created_at) VALUES ('2026-10-14', ?, 100, ?)").run(registrationRowText(h === "sisyphus" ? OUTSIDE : OPERATOR, h, "0x" + "cd".repeat(32)), i + 1);
  });
  return { d1, env: guestEnv(d1) };
}

const deepCopy = <T>(o: T): T => JSON.parse(JSON.stringify(o)) as T;
const getFile = (f: string) => `(Get-Content -Raw -Encoding UTF8 '@DIR@\\${f}')`;

test("Test-EverWrittenServed and Test-EverWrittenAbsent (run for real): the body officialFacts really serves passes; every body that breaks one thing named by the wave is refused with its own reason; the pre-wave shape is 'absent'", async (t) => {
  if (!definitions(t)) return;
  const { d1, env } = seeded();
  try {
    const facts: any = await officialFacts(env);
    const c = facts.composition;
    assert.equal(c.acted_30d, 3);
    assert.equal(c.ever_written, 3);
    assert.equal(c.not_designated_ever_written, 2);
    const mutants: Record<string, (o: any) => void> = {
      acted_null: (o) => (o.composition.acted_30d = null),
      ever_null: (o) => (o.composition.ever_written = null),
      not_designated_null: (o) => (o.composition.not_designated_ever_written = null),
      ever_absent: (o) => delete o.composition.ever_written,
      not_designated_absent: (o) => delete o.composition.not_designated_ever_written,
      ever_over_citizens: (o) => (o.composition.ever_written = 99),
      ever_under_acted: (o) => (o.composition.ever_written = 2),
      not_designated_over_ever: (o) => (o.composition.not_designated_ever_written = 4),
      not_designated_over_complement: (o) => {
        o.composition.ever_written = 13;
        o.composition.not_designated_ever_written = 9;
      },
      difference_over_operator: (o) => {
        o.composition.ever_written = 13;
        o.composition.not_designated_ever_written = 7;
      },
      outside_over_not_designated: (o) => (o.rule7_revote.outside_writers_30d = 99),
      prov_missing: (o) => delete o.composition.provenance.ever_written,
      prov_source_wrong: (o) => (o.composition.provenance.not_designated_ever_written.source = ["commonhold_statement"]),
      prov_check_empty: (o) => (o.composition.provenance.ever_written.check = ""),
      prov_hidden_missing: (o) => (o.composition.provenance.ever_written.check = "Distinct citizens with any write at any time."),
      prov_bound_missing: (o) => (o.composition.provenance.not_designated_ever_written.check = "ever_written with the operator's handles left out."),
    };
    const files: Record<string, string> = { "ok.json": JSON.stringify(facts), "junk.json": "not json" };
    const lines = [...PS_DEFS, `Write-Output ('OK=[' + (Test-EverWrittenServed ${getFile("ok.json")}) + ']')`, `Write-Output ('JUNK=[' + (Test-EverWrittenServed ${getFile("junk.json")}) + ']')`];
    for (const [name, mutate] of Object.entries(mutants)) {
      const o = deepCopy(facts);
      mutate(o);
      files[`m_${name}.json`] = JSON.stringify(o);
      lines.push(`Write-Output ('M_${name}=[' + (Test-EverWrittenServed ${getFile(`m_${name}.json`)}) + ']')`);
    }
    // the pre-wave shape: composition without the two fields
    const pre = deepCopy(facts);
    for (const f of ["ever_written", "not_designated_ever_written"]) delete pre.composition[f];
    files["pre.json"] = JSON.stringify(pre);
    lines.push(`Write-Output ('ABSENT_PRE=' + (Test-EverWrittenAbsent ${getFile("pre.json")}))`);
    lines.push(`Write-Output ('ABSENT_NEW=' + (Test-EverWrittenAbsent ${getFile("ok.json")}))`);
    lines.push("Write-Output ('ABSENT_JUNK=' + (Test-EverWrittenAbsent 'not json'))");
    lines.push(`Write-Output ('SERVED_PRE=[' + (Test-EverWrittenServed ${getFile("pre.json")}) + ']')`);
    for (const name of Object.keys(mutants)) lines.push(`Write-Output ('NULLKEY_${name}=' + (Test-IsNullReason (Test-EverWrittenServed ${getFile(`m_${name}.json`)})))`);
    const r = runPs(lines, files);
    if (!r) return t.skip("powershell is not available on this machine");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /OK=\[\]/, "what the code really serves passes, with no reason");
    assert.match(r.out, /JUNK=\[GET \/api\/official did not return JSON\]/);
    const reasons: Record<string, RegExp> = {
      acted_null: /composition\.acted_30d is ''.*whole number/,
      ever_null: /composition\.ever_written is ''.*whole number/,
      not_designated_null: /composition\.not_designated_ever_written is ''.*whole number/,
      ever_absent: /composition\.ever_written is absent/,
      not_designated_absent: /composition\.not_designated_ever_written is absent/,
      ever_over_citizens: /ever_written 99 is more than citizens 13/,
      ever_under_acted: /ever_written 2 is less than acted_30d 3/,
      not_designated_over_ever: /not_designated_ever_written 4 is more than ever_written 3/,
      not_designated_over_complement: /not_designated_ever_written 9 is more than not_designated_operator_controlled 8/,
      difference_over_operator: /ever_written 13 minus not_designated_ever_written 7 is more than operator_controlled 5/,
      outside_over_not_designated: /rule7_revote\.outside_writers_30d 99 is more than not_designated_ever_written 2/,
      prov_missing: /provenance\.ever_written is missing/,
      prov_source_wrong: /provenance\.not_designated_ever_written\.source is 'commonhold_statement', expected record/,
      prov_check_empty: /provenance\.ever_written has no check/,
      prov_hidden_missing: /ever_written\.check does not say a hidden row does not count/,
      prov_bound_missing: /not_designated_ever_written\.check does not say it does not establish who controls those seats/,
    };
    for (const name of Object.keys(mutants)) assert.match(r.out, new RegExp(`M_${name}=\\[[^\\]\\r\\n]+\\]`), `${name}: refused with a reason`);
    for (const [name, pattern] of Object.entries(reasons)) {
      const line = r.out.split("\n").find((l) => l.startsWith(`M_${name}=`)) ?? "";
      assert.match(line, pattern, `${name}: the reason names the broken thing`);
    }
    // The ride's retry key, run on the REAL reasons: true for the three null mutants and false for every other refusal (a key that never matches is a dead retry).
    for (const name of Object.keys(mutants)) {
      const want = name === "acted_null" || name === "ever_null" || name === "not_designated_null" ? "True" : "False";
      assert.match(r.out, new RegExp(`NULLKEY_${name}=${want}`), `${name}: Test-IsNullReason must answer ${want} on the reason Test-EverWrittenServed really gives`);
    }
    assert.match(r.out, /ABSENT_PRE=True/, "the live pre-wave composition is 'absent'");
    assert.match(r.out, /ABSENT_NEW=False/, "the new composition is not");
    assert.match(r.out, /ABSENT_JUNK=False/, "an unreadable body is not 'absent' either");
    assert.match(r.out, /SERVED_PRE=\[composition\.ever_written is absent\]/, "the pre-wave shape is not 'served'");
  } finally {
    d1.close();
  }
});

test("Test-PayerTraceServed and Test-PayerTraceAbsent (run for real, over real ledger rows): the page citizenDirectory really serves passes; every body that breaks one thing named by the wave is refused with its own reason; the pre-wave shape is 'absent'", async (t) => {
  if (!definitions(t)) return;
  const { d1, env } = seeded();
  try {
    const dir: any = await citizenDirectory(env);
    assert.equal(dir.citizens.length, 13);
    assert.equal(dir.citizens.filter((r: any) => r.payer_trace.direct_payer_is_operator_wallet === true).length, 12);
    const sis = (o: any) => o.citizens.find((r: any) => r.handle === "sisyphus");
    const ops = (o: any) => o.citizens.find((r: any) => r.handle === "commonhold-agent");
    const mutants: Record<string, (o: any) => void> = {
      row_without_trace: (o) => delete o.citizens[3].payer_trace,
      field_absent: (o) => delete o.citizens[0].payer_trace.beyond_direct_payer,
      reach_wrong: (o) => (o.citizens[0].payer_trace.beyond_direct_payer = "checked"),
      null_payer_with_flag: (o) => {
        ops(o).payer_trace.direct_payer = null;
        ops(o).payer_trace.direct_payer_is_operator_wallet = false;
      },
      bad_wallet: (o) => (sis(o).payer_trace.direct_payer = "0x1234"),
      flag_not_bool: (o) => (ops(o).payer_trace.direct_payer_is_operator_wallet = "yes"),
      flag_wrong_for_outside: (o) => (sis(o).payer_trace.direct_payer_is_operator_wallet = true),
      flag_wrong_for_operator: (o) => (ops(o).payer_trace.direct_payer_is_operator_wallet = false),
      paged: (o) => (o.has_more = true),
      total_mismatch: (o) => (o.total = 99),
      no_rows: (o) => (o.citizens = []),
    };
    const files: Record<string, string> = { "ok.json": JSON.stringify(dir), "junk.json": "not json" };
    const lines = [
      ...PS_DEFS,
      `Write-Output ('OK=[' + (Test-PayerTraceServed ${getFile("ok.json")} 12) + ']')`,
      `Write-Output ('PAID11=[' + (Test-PayerTraceServed ${getFile("ok.json")} 11) + ']')`,
      `Write-Output ('JUNK=[' + (Test-PayerTraceServed ${getFile("junk.json")} 12) + ']')`,
    ];
    for (const [name, mutate] of Object.entries(mutants)) {
      const o = deepCopy(dir);
      mutate(o);
      files[`m_${name}.json`] = JSON.stringify(o);
      lines.push(`Write-Output ('M_${name}=[' + (Test-PayerTraceServed ${getFile(`m_${name}.json`)} 12) + ']')`);
    }
    const pre = deepCopy(dir);
    for (const row of pre.citizens) delete row.payer_trace;
    files["pre.json"] = JSON.stringify(pre);
    const empty = deepCopy(dir);
    empty.citizens = [];
    files["empty.json"] = JSON.stringify(empty);
    lines.push(`Write-Output ('ABSENT_PRE=' + (Test-PayerTraceAbsent ${getFile("pre.json")}))`);
    lines.push(`Write-Output ('ABSENT_NEW=' + (Test-PayerTraceAbsent ${getFile("ok.json")}))`);
    lines.push(`Write-Output ('ABSENT_EMPTY=' + (Test-PayerTraceAbsent ${getFile("empty.json")}))`);
    lines.push("Write-Output ('ABSENT_JUNK=' + (Test-PayerTraceAbsent 'not json'))");
    const r = runPs(lines, files);
    if (!r) return t.skip("powershell is not available on this machine");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /OK=\[\]/, "what the code really serves passes, with no reason");
    assert.match(r.out, /PAID11=\[the 12 rows with direct_payer_is_operator_wallet true are not composition\.operator_paid 11/, "the operator-wallet rows must equal operator_paid");
    assert.match(r.out, /JUNK=\[GET \/api\/citizens did not return JSON\]/);
    const reasons: Record<string, RegExp> = {
      row_without_trace: /row .* carries no payer_trace/,
      field_absent: /payer_trace\.beyond_direct_payer is absent/,
      reach_wrong: /beyond_direct_payer is 'checked', expected not_checkable_by_us/,
      null_payer_with_flag: /has no direct_payer but direct_payer_is_operator_wallet is 'False', expected null/,
      bad_wallet: /direct_payer '0x1234' is not a 20-byte address/,
      flag_not_bool: /expected true or false/,
      flag_wrong_for_outside: /row sisyphus direct_payer_is_operator_wallet is True but direct_payer .* gives False/,
      flag_wrong_for_operator: /row commonhold-agent direct_payer_is_operator_wallet is False but direct_payer .* gives True/,
      paged: /has more than one page/,
      total_mismatch: /carries 13 rows but total is 99/,
      no_rows: /carries no rows/,
    };
    for (const name of Object.keys(mutants)) assert.match(r.out, new RegExp(`M_${name}=\\[[^\\]\\r\\n]+\\]`), `${name}: refused with a reason`);
    for (const [name, pattern] of Object.entries(reasons)) {
      const line = r.out.split("\n").find((l) => l.startsWith(`M_${name}=`)) ?? "";
      assert.match(line, pattern, `${name}: the reason names the broken thing`);
    }
    assert.match(r.out, /ABSENT_PRE=True/, "the pre-wave census is 'absent'");
    assert.match(r.out, /ABSENT_NEW=False/);
    assert.match(r.out, /ABSENT_EMPTY=False/, "a census with no rows proves nothing");
    assert.match(r.out, /ABSENT_JUNK=False/);
  } finally {
    d1.close();
  }
});

test("Test-ReceivedElsewhereServed and Test-ReceivedElsewhereAbsent (run for real): the body guestDue really serves passes; every body that breaks one thing named by the wave is refused with its own reason; the pre-wave shape is 'absent'", async (t) => {
  if (!definitions(t)) return;
  const { d1, env } = seeded();
  try {
    const due: any = await guestDue(env, null, null, null, Date.now());
    assert.equal(due.received_elsewhere_count, 3);
    const mutants: Record<string, (o: any) => void> = {
      absent: (o) => delete o.received_elsewhere,
      count_wrong: (o) => (o.received_elsewhere_count = 2),
      count_a_string: (o) => (o.received_elsewhere_count = "3"),
      list_short: (o) => {
        o.received_elsewhere = o.received_elsewhere.slice(0, 2);
        o.received_elsewhere_count = 2;
      },
      entry_without_url: (o) => (o.received_elsewhere[0].url = ""),
      entry_without_answer: (o) => (o.received_elsewhere[1].answered_by = []),
      answer_without_id: (o) => (o.received_elsewhere[2].answered_by[0].comment_id = ""),
      accrued_wrong: (o) => (o.counts.accrued = 99),
      count_key_missing: (o) => delete o.counts.waived,
    };
    const files: Record<string, string> = { "ok.json": JSON.stringify(due), "junk.json": "not json" };
    const lines = [...PS_DEFS, `Write-Output ('OK=[' + (Test-ReceivedElsewhereServed ${getFile("ok.json")}) + ']')`, `Write-Output ('JUNK=[' + (Test-ReceivedElsewhereServed ${getFile("junk.json")}) + ']')`];
    for (const [name, mutate] of Object.entries(mutants)) {
      const o = deepCopy(due);
      mutate(o);
      files[`m_${name}.json`] = JSON.stringify(o);
      lines.push(`Write-Output ('M_${name}=[' + (Test-ReceivedElsewhereServed ${getFile(`m_${name}.json`)}) + ']')`);
    }
    const pre = deepCopy(due);
    delete pre.received_elsewhere;
    delete pre.received_elsewhere_count;
    files["pre.json"] = JSON.stringify(pre);
    lines.push(`Write-Output ('ABSENT_PRE=' + (Test-ReceivedElsewhereAbsent ${getFile("pre.json")}))`);
    lines.push(`Write-Output ('ABSENT_NEW=' + (Test-ReceivedElsewhereAbsent ${getFile("ok.json")}))`);
    lines.push("Write-Output ('ABSENT_JUNK=' + (Test-ReceivedElsewhereAbsent 'not json'))");
    const r = runPs(lines, files);
    if (!r) return t.skip("powershell is not available on this machine");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /OK=\[\]/, "what the code really serves passes, with no reason");
    assert.match(r.out, /JUNK=\[GET \/api\/guest\/due did not return JSON\]/);
    const reasons: Record<string, RegExp> = {
      absent: /received_elsewhere is absent/,
      count_wrong: /received_elsewhere_count 2 is not the list length 3/,
      count_a_string: /received_elsewhere_count is '3', expected a whole number/,
      list_short: /received_elsewhere has 2 entries, expected at least 3/,
      entry_without_url: /a received_elsewhere entry has no url/,
      entry_without_answer: /received_elsewhere entry shejiao-daren names no answering comment/,
      answer_without_id: /received_elsewhere entry penny has an answering comment without an identity or an id/,
      accrued_wrong: /counts\.accrued 99 is not the sum of the other five/,
      count_key_missing: /counts\.waived is '', expected a whole number/,
    };
    for (const name of Object.keys(mutants)) assert.match(r.out, new RegExp(`M_${name}=\\[[^\\]\\r\\n]+\\]`), `${name}: refused with a reason`);
    for (const [name, pattern] of Object.entries(reasons)) {
      const line = r.out.split("\n").find((l) => l.startsWith(`M_${name}=`)) ?? "";
      assert.match(line, pattern, `${name}: the reason names the broken thing`);
    }
    assert.match(r.out, /ABSENT_PRE=True/);
    assert.match(r.out, /ABSENT_NEW=False/);
    assert.match(r.out, /ABSENT_JUNK=False/);
  } finally {
    d1.close();
  }
});

test("Get-CompositionSnapshot and the three note checks (run for real): the snapshot moves when a figure moves; the notes the code serves pass and a note without the new fields does not", async (t) => {
  if (!definitions(t)) return;
  const { d1, env } = seeded();
  try {
    const facts: any = await officialFacts(env);
    const dir: any = await citizenDirectory(env);
    const due: any = await guestDue(env, null, null, null, Date.now());
    const moved = deepCopy(facts);
    moved.composition.operator_funded_handles = moved.composition.operator_funded_handles.slice(1);
    const keyLostMoved = deepCopy(facts);
    keyLostMoved.composition.key_lost = 0;
    const paidMoved = deepCopy(facts);
    paidMoved.composition.operator_paid = 11;
    const oldNote = deepCopy(facts);
    oldNote.composition.note = oldNote.composition.note.replaceAll("ever_written", "x");
    const oldCit = deepCopy(dir);
    oldCit.note = oldCit.note.replaceAll("payer_trace", "x");
    const oldDue = deepCopy(due);
    oldDue.note = oldDue.note.replace("received_elsewhere is a separate, hand-kept list and counts nothing here", "x");
    const files = {
      "a.json": JSON.stringify(facts),
      "moved.json": JSON.stringify(moved),
      "keylost.json": JSON.stringify(keyLostMoved),
      "paid.json": JSON.stringify(paidMoved),
      "oldnote.json": JSON.stringify(oldNote),
      "cit.json": JSON.stringify(dir),
      "oldcit.json": JSON.stringify(oldCit),
      "due.json": JSON.stringify(due),
      "olddue.json": JSON.stringify(oldDue),
    };
    const r = runPs(
      [
        ...PS_DEFS,
        `Write-Output ('SNAP=' + (Get-CompositionSnapshot ${getFile("a.json")}))`,
        `Write-Output ('SNAP_SAME=' + ((Get-CompositionSnapshot ${getFile("a.json")}) -ceq (Get-CompositionSnapshot ${getFile("a.json")})))`,
        `Write-Output ('SNAP_HANDLE=' + ((Get-CompositionSnapshot ${getFile("moved.json")}) -ceq (Get-CompositionSnapshot ${getFile("a.json")})))`,
        `Write-Output ('SNAP_KEYLOST=' + ((Get-CompositionSnapshot ${getFile("keylost.json")}) -ceq (Get-CompositionSnapshot ${getFile("a.json")})))`,
        `Write-Output ('SNAP_PAID=' + ((Get-CompositionSnapshot ${getFile("paid.json")}) -ceq (Get-CompositionSnapshot ${getFile("a.json")})))`,
        "Write-Output ('SNAP_NONE=' + ($null -eq (Get-CompositionSnapshot 'not json')))",
        `Write-Output ('NOTE_NEW=' + (Test-OfficialNoteNamesEverWritten ${getFile("a.json")}))`,
        `Write-Output ('NOTE_OLD=' + (Test-OfficialNoteNamesEverWritten ${getFile("oldnote.json")}))`,
        `Write-Output ('CIT_NEW=' + (Test-CitizensNoteNamesPayerTrace ${getFile("cit.json")}))`,
        `Write-Output ('CIT_OLD=' + (Test-CitizensNoteNamesPayerTrace ${getFile("oldcit.json")}))`,
        "Write-Output ('CIT_JUNK=' + (Test-CitizensNoteNamesPayerTrace 'not json'))",
        `Write-Output ('DUE_NEW=' + (Test-DueNoteSeparatesList ${getFile("due.json")}))`,
        `Write-Output ('DUE_OLD=' + (Test-DueNoteSeparatesList ${getFile("olddue.json")}))`,
      ],
      files,
    );
    if (!r) return t.skip("powershell is not available on this machine");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /SNAP=citizens=13;act_capable=12;operator_paid=12;operator_controlled=5;operator_funded=7;not_designated=8;key_lost=1;funded_handles=babydov-earn-20260919,boundary-auditor-917,boundary-auditor-v2,cincoforge-codex,magnus-v2,midas-jt3,spreecode/);
    assert.match(r.out, /SNAP_SAME=True/);
    assert.match(r.out, /SNAP_HANDLE=False/);
    assert.match(r.out, /SNAP_KEYLOST=False/);
    assert.match(r.out, /SNAP_PAID=False/);
    assert.match(r.out, /SNAP_NONE=True/);
    assert.match(r.out, /NOTE_NEW=True/);
    assert.match(r.out, /NOTE_OLD=False/);
    assert.match(r.out, /CIT_NEW=True/);
    assert.match(r.out, /CIT_OLD=False/);
    assert.match(r.out, /CIT_JUNK=False/);
    assert.match(r.out, /DUE_NEW=True/);
    assert.match(r.out, /DUE_OLD=False/);
  } finally {
    d1.close();
  }
});

test("the reviewed-source check stops when HEAD does not contain the reviewed commit or a path outside the allowlist changed (the placeholder stop lives in step 0a)", (t) => {
  if (!definitions(t)) return;
  assert.equal(/still holds the placeholder/.test(reviewedBlock), false, "the placeholder stop lives in the pin block, before any git command");
  const run = (changed: string[]) =>
    runPs([
      ...PS_DEFS,
      "$REVIEWED_COMMIT = '0123456789abcdef0123456789abcdef01234567'",
      "$headSha = 'fedcba9876543210fedcba9876543210fedcba98'",
      "function git { $global:LASTEXITCODE = 0; if ($args -contains '--name-only') { return @('" + changed.join("','") + "') } }",
      reviewedBlock,
      "Write-Output 'PAST-REVIEW'",
    ]);
  const clean = run(["scripts/deploy-penny-three.ps1", "docs/CHECKPOINT-PENNY-THREE.md", "test/deploy-penny-three-script.test.ts"]);
  if (!clean) return t.skip("powershell is not available on this machine");
  assert.match(clean.out, /PAST-REVIEW/, clean.out);
  const dirty = run(["src/society.ts"]);
  assert.equal(dirty!.code, 1);
  assert.match(dirty!.out, /not on the allowlist/);
  assert.equal(/PAST-REVIEW/.test(dirty!.out), false);
  const migration = run(["migrations/0022_x.sql"]);
  assert.equal(migration!.code, 1, "a migration after the review is refused too");
  const other = run(["scripts/deploy-seat-counts.ps1"]);
  assert.equal(other!.code, 1, "another deploy script is not on this script's allowlist");
});

test("Get-TemplateText (run for real): it extracts FRONT_DOOR_TEMPLATE from the real src/doc.ts, a change OUTSIDE the template does not change it, a byte INSIDE it does, an escaped backtick does not end it, and a missing marker is null", (t) => {
  if (!definitions(t)) return;
  const docTs = readFileSync(here("../src/doc.ts"), "utf8");
  const marker = "export const FRONT_DOOR_TEMPLATE = `";
  const start = docTs.indexOf(marker);
  assert.ok(start > 0, "the template marker is in src/doc.ts");
  let i = start + marker.length;
  let end = -1;
  while (end < 0) {
    const j = docTs.indexOf("`", i);
    assert.ok(j > 0, "the template has a closing backtick");
    if (docTs[j - 1] === "\\") i = j + 1;
    else end = j;
  }
  const expected = docTs.slice(start, end + 1).replace(/\r\n/g, "\n");
  assert.ok(expected.length > 10_000, "the attested template is large; the extraction is not vacuous");
  const doc = docTs.replace(/\r\n/g, "\n");
  const outsideEdit = doc.replace("export function showhomeDoorNote", "// an edit outside the template\nexport function showhomeDoorNote");
  const insideEdit = doc.replace("export const FRONT_DOOR_TEMPLATE = `", "export const FRONT_DOOR_TEMPLATE = `X");
  assert.ok(outsideEdit.indexOf("// an edit outside the template") > end, "the outside edit really lies after the template");
  const r = runPs(
    [
      ...PS_DEFS,
      "$a = Get-TemplateText (Get-Content -Raw -Encoding UTF8 '@DIR@\\a.txt')",
      "$b = Get-TemplateText (Get-Content -Raw -Encoding UTF8 '@DIR@\\b.txt')",
      "$c = Get-TemplateText (Get-Content -Raw -Encoding UTF8 '@DIR@\\c.txt')",
      "$d = Get-TemplateText (Get-Content -Raw -Encoding UTF8 '@DIR@\\d.txt')",
      "$e = Get-TemplateText 'no marker here'",
      "Write-Output ('LEN=' + $a.Length)",
      "Write-Output ('OUTSIDE-SAME=' + ($a -ceq $b))",
      "Write-Output ('INSIDE-DIFFERS=' + ($a -cne $c))",
      "Write-Output ('ESCAPED-OK=' + ($d -ceq ('export const FRONT_DOOR_TEMPLATE = ' + [char]96 + 'one ' + [char]92 + [char]96 + ' two' + [char]96)))",
      "Write-Output ('MISSING=' + ($null -eq $e))",
    ],
    {
      "a.txt": doc,
      "b.txt": outsideEdit,
      "c.txt": insideEdit,
      "d.txt": "head\nexport const FRONT_DOOR_TEMPLATE = `one \\` two`;\nexport function after() { return `x`; }\n",
    },
  );
  if (!r) return t.skip("powershell is not available on this machine");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`LEN=${expected.length}`), "the PowerShell slice has the TypeScript slice's length");
  assert.match(r.out, /OUTSIDE-SAME=True/);
  assert.match(r.out, /INSIDE-DIFFERS=True/);
  assert.match(r.out, /ESCAPED-OK=True/);
  assert.match(r.out, /MISSING=True/);
});

test("Get-DisallowedPaths and Get-TestSummary (run for real): only this script, its test and docs/ pass the allowlist; a summary that does not end the output is not read", (t) => {
  if (!definitions(t)) return;
  const r = runPs([
    ...PS_DEFS,
    "$bad = @(Get-DisallowedPaths @('scripts/deploy-penny-three.ps1', 'test/deploy-penny-three-script.test.ts', 'docs/CHECKPOINT-PENNY-THREE.md', 'src/society.ts', 'migrations/0022_x.sql', 'docs', 'Docs/x.md', 'scripts/deploy-seat-counts.ps1'))",
    "Write-Output ('BAD=' + ($bad -join ','))",
    "$tail = \"tests 10`r`nsuites 0`r`npass 9`r`nfail 0`r`ncancelled 0`r`nskipped 1`r`ntodo 0`r`nduration_ms 12.5`r`n\"",
    "$s = Get-TestSummary $tail",
    "Write-Output ('SUMMARY=' + $s.Pass + '/' + $s.Fail + '/' + $s.SumOk)",
    "$notEnd = Get-TestSummary ($tail + 'trailing failure detail')",
    "Write-Output ('NOTEND=' + ($null -eq $notEnd))",
  ]);
  if (!r) return t.skip("powershell is not available on this machine");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /BAD=src\/society\.ts,migrations\/0022_x\.sql,docs,Docs\/x\.md,scripts\/deploy-seat-counts\.ps1/, "src/, migrations/, a docs look-alike and another deploy script are not on the allowlist");
  assert.match(r.out, /SUMMARY=9\/0\/True/);
  assert.match(r.out, /NOTEND=True/);
});

test("the other deploy scripts are untouched: the seat counts script still holds its own pins", () => {
  const seatCounts = readFileSync(here("../scripts/deploy-seat-counts.ps1"), "utf8");
  assert.match(seatCounts, /^\$LIVE_BASE_COMMIT = "cfa70103a07f4aeb12ecd4b3297022ab2355e276"$/m, "the seat counts script still holds its own live base");
  assert.match(seatCounts, /^\$REVIEWED_COMMIT = "6ce0a8172bf34e3dc9688c716bdaf7f07a257b0f"$/m, "and its own reviewed commit");
  const funding = readFileSync(here("../scripts/deploy-funding-label.ps1"), "utf8");
  assert.match(funding, /^\$LIVE_BASE_COMMIT = "d6a5cd7829a14c3a91d962f85ce13d0330b532af"$/m, "the funding label script still holds its own live base");
});

test("the ride reads GET /api/official up to three times when a writer count is null (a transient writer-read failure), keyed on the exact reason Test-EverWrittenServed gives, and stops if it stays null", () => {
  const loop = code.indexOf("for ($try = 1; $try -le 3; $try++)");
  assert.ok(loop > 0 && loop > code.indexOf("Wait-NewWorker $headSha"), "the ride, after the poll, must carry the three-read loop");
  assert.ok(code.includes("-not (Test-IsNullReason $servedWhy)"), "the retry must key on Test-IsNullReason (run for real against Test-EverWrittenServed's own null reason in the run-for-real test)");
  // The key must be the text Test-EverWrittenServed really produces for a null count, or the retry never fires.
  assert.ok(defs.includes(`return ("composition." + $f + " is '" + $v.Value + "', expected a whole number (null means the count was unreadable for that response)")`), "Test-EverWrittenServed's null reason format changed: the ride's retry key must follow it");
  // After the loop, a reason that is still set stops the script.
  const after = code.slice(loop);
  assert.ok(/if \(\$servedWhy -ne ""\) \{ Stop-Here "GET \/api\/official does not serve the ever-written counts as defined/.test(after), "a null that survives three reads must stop the script");
});
