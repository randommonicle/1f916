// scripts/deploy-seat-counts.ps1 is WRITTEN AND NEVER RUN by the builder (hard rule: no deploy, no wrangler command, not even -DryRun, which reads the live worker over HTTP).
// It is proven here by everything that can be proven without running it: it parses under PowerShell's own parser, it is ASCII with LF line endings, it has none of the traps the repo's L-080
// family names, its steps are in the load-bearing order (the two pins FIRST, fetch, pin, template check, no-migration check, reviewed source, the seat counts code present, gates, the live probes,
// dry-run exit, deploy, version id, poll, attest, ride), it has NO migration step and touches no D1 at all, step 0a stops on EITHER placeholder before any git or network command, the reviewed-commit
// pin is the placeholder or a full 40-hex sha and nothing else, and the ride is public GETs ONLY (no POST of any kind, no credential, nothing written). Its decision functions are run for real under
// PowerShell against what the real code serves (officialFacts, citizenDirectory, the worker's two treasury routes), and each is shown to answer differently on a body that breaks one thing. The pattern
// is test/deploy-funding-label-script.test.ts. Every check fails when the script is mutated (the checkpoint lists the mutants).
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
import worker from "../src/index.ts";

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
const SCRIPT_PATH = here("../scripts/deploy-seat-counts.ps1");
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
  const dir = mkdtempSync(join(tmpdir(), "deploy-seat-counts-"));
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
const ps = (s: string) => "'" + s.replace(/'/g, "''") + "'";

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

test("the pins: the v5 hash, the live base (the funding label wave's deployed commit), the reviewed commit (the hub's placeholder or a full 40-hex sha) and the allowlist", () => {
  assert.match(script, /^\$V5_HASH = "fa11788d062b0c6d23c54c428c1c9649d263ae3ba704e602e122066926049491"$/m);
  assert.match(script, /^\$LIVE_BASE_COMMIT = "cfa70103a07f4aeb12ecd4b3297022ab2355e276"$/m);
  // Before the hub sets it the reviewed pin is the placeholder; after, the full sha (40 lower-case hex). Either is a valid committed state; anything else is not.
  assert.match(script, /^\$REVIEWED_COMMIT = "(?:TO-BE-SET-BY-HUB|[0-9a-f]{40})"$/m, "the reviewed commit is the hub's placeholder or a full 40-hex sha");
  assert.equal(/^\$REVIEWED_COMMIT = "[0-9a-f]*[A-F][0-9a-fA-F]*"$/m.test(script), false, "an upper-case sha is not a valid committed state");
  assert.match(script, /^\$LIVE_BASE_PLACEHOLDER = "TO-BE-SET-BY-HUB-LIVE-BASE"$/m);
  assert.match(script, /^\$REVIEWED_COMMIT_PLACEHOLDER = "TO-BE-SET-BY-HUB"$/m);
  const allowed = /\$ALLOWED_PATHS_AFTER_REVIEW = @\(([^)]*)\)/.exec(code)?.[1] ?? "";
  assert.deepEqual([...allowed.matchAll(/"([^"]+)"/g)].map((m) => m[1]), ["scripts/deploy-seat-counts.ps1", "test/deploy-seat-counts-script.test.ts", "docs/"]);
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

test("the steps are in the load-bearing order: pins, fetch, branch, clean tree, ancestry, template check, no-migration check, reviewed source, the seat counts code present, gates, probes (live base proved, counts absent, figures recorded), (dry-run exit), deploy, version id, poll, attest, ride (public reads, the counts, the figures, the alias, the served words)", () => {
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
    "export async function actedWritersSince",
    "$testOut = (npm test",
    "$attBefore = Read-Attest",
    "[string]$attBefore.code.commit -cne $LIVE_BASE_COMMIT",
    "$officialBefore = Get-Text",
    "Test-SeatCountsAbsent $officialBefore.Body",
    "$snapshotBefore = Get-CompositionSnapshot",
    "$treasuryKeysBefore = Get-KeyNames",
    "if ($DryRun) {",
    "$deployOut = (npx wrangler deploy",
    "Current Version ID",
    "Wait-NewWorker $headSha",
    "Assert-Attest $attAfter",
    "foreach ($p in",
    "$officialNow = Get-Text",
    "$servedWhy = Test-SeatCountsServed",
    "$snapshotAfter = Get-CompositionSnapshot",
    "$treasuryKeysNow = Get-KeyNames",
    "$llmsNow = Get-Text",
    "$citizensNow = Get-Text",
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
  assert.ok(listed.includes("/treasury") && listed.includes("/api/treasury"), "both treasury routes are read");
  assert.equal(listed.includes("/skill.md") || listed.includes("/heartbeat.md"), false, "neither door-counted file is read");
  assert.equal(/Get-(Text|Json)[^\n]*(skill\.md|heartbeat)/.test(code), false, "/skill.md and /heartbeat.md are never read");
  // each surface is asserted
  assert.match(code, /\$servedWhy = Test-SeatCountsServed \$officialNow\.Body/, "the counts, their provenance and the independent object");
  assert.match(code, /\$servedWhy -ne ""\) \{ Stop-Here/, "and a reason STOPS the ride");
  assert.match(code, /Test-OfficialNoteHasCounts \$officialNow\.Body/, "the composition note sentence");
  assert.match(code, /\$snapshotAfter -cne \$snapshotBefore\) \{ Stop-Here/, "the composition figures must equal the ones served before");
  assert.match(code, /\$aliasKeysNow -cne \$treasuryKeysNow\) \{ Stop-Here/, "the alias has the same top-level keys as /treasury");
  assert.match(code, /\$treasuryKeysNow -cne \$treasuryKeysBefore\) \{ Stop-Here/, "and /treasury's keys did not move");
  assert.match(code, /\$llmsNow\.Body\.Contains\(\$name\)\) \{ Stop-Here/, "llms.txt names each of the three fields");
  assert.match(code, /Test-CitizensNoteNamesCounts \$citizensNow\.Body\)\) \{ Stop-Here/, "and so does the citizens note");
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

test("it proves the live worker IS the pinned base (code.commit equals $LIVE_BASE_COMMIT), reads the rollback target from it, and probes that the three counts are ABSENT before the deploy, which is what makes the poll mean something; the poll needs the stamped commit AND the printed version id AND the served counts", () => {
  assert.match(code, /\[string\]\$attBefore\.code\.commit -cne \$LIVE_BASE_COMMIT/);
  assert.match(code, /\$rollbackTarget = \[string\]\$attBefore\.code\.version_id/);
  assert.match(code, /^\$OFFICIAL_URL = "\$BASE\/api\/official"$/m);
  assert.match(code, /if \(-not \(Test-SeatCountsAbsent \$officialBefore\.Body\)\) \{ Stop-Here/);
  assert.match(code, /Current Version ID:/);
  assert.match(code, /\$versionMatches\.Count -gt 1\) \{ Stop-Here/);
  assert.match(code, /\$versionMatches\.Count -lt 1\) \{ Stop-Here/);
  assert.match(code, /\$code\.commit -cne \$commit/);
  assert.match(code, /\$code\.version_id\)\.ToLowerInvariant\(\) -cne/);
  assert.match(code, /\$route\.Code -eq "200" -and \$served -eq ""/, "the poll also waits for the served counts");
});

test("step 0 requires the seat counts code in the checkout (so a stale tree cannot ride this script) and the earlier waves it must not drop", () => {
  assert.match(code, /Select-String -Path "src\/society\.ts" -Pattern "export async function actedWritersSince"/);
  assert.match(code, /Select-String -Path "src\/council\.ts" -Pattern "export async function citizenWritersSince"/);
  assert.match(code, /Select-String -Path "src\/index\.ts" -Pattern 'path === "\/api\/treasury" && method === "GET"' -SimpleMatch -Quiet/);
  assert.match(code, /Select-String -Path "src\/society\.ts" -Pattern "export const OPERATOR_FUNDED_SCOPE_SENTENCE"/);
  for (const real of [
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

// The live shape: the 5 operator seats, the 7 sponsored seats and sisyphus (13 citizens, one key-lost), with one write by an operator seat so acted_30d is not zero.
function seeded() {
  const d1 = createLocalD1();
  for (const h of [...OPERATOR_CONTROLLED_HANDLES, ...SPONSORED_HANDLES, "sisyphus"]) insertCitizen(d1, { handle: h });
  d1.raw.prepare("INSERT INTO posts (citizen_id, title, body, dupe_hash, created_at) VALUES (1, 't', 'b', 'seed-h', ?)").run(Date.now() - 86_400_000);
  return { d1, env: guestEnv(d1) };
}

const deepCopy = <T>(o: T): T => JSON.parse(JSON.stringify(o)) as T;

test("Test-SeatCountsServed and Test-SeatCountsAbsent (run for real): the body officialFacts really serves passes; every body that breaks one thing named by the wave is refused with its own reason; the pre-wave shape is 'absent'", async (t) => {
  if (!definitions(t)) return;
  const { d1, env } = seeded();
  try {
    const facts: any = await officialFacts(env);
    const c = facts.composition;
    assert.equal(c.act_capable, 12);
    assert.equal(c.acted_30d, 1);
    assert.equal(c.operator_paid, 12);
    const mutants: Record<string, (o: any) => void> = {
      acted_null: (o) => (o.composition.acted_30d = null),
      act_capable_wrong: (o) => (o.composition.act_capable = o.composition.citizens),
      operator_paid_absent: (o) => delete o.composition.operator_paid,
      paid_too_big: (o) => (o.composition.operator_paid = 99),
      paid_too_small: (o) => (o.composition.operator_paid = 3),
      acted_over_citizens: (o) => (o.composition.acted_30d = 99),
      independent_number: (o) => (o.composition.independent = o.composition.not_designated_operator_controlled),
      independent_count_wrong: (o) => (o.composition.independent.count = 7),
      independent_unmarked: (o) => (o.composition.independent.deprecated_name = false),
      use_instead_wrong: (o) => (o.composition.independent.use_instead = "independent"),
      meaning_empty: (o) => (o.composition.independent.meaning = ""),
      prov_missing: (o) => delete o.composition.provenance.acted_30d,
      prov_source_wrong: (o) => (o.composition.provenance.operator_paid.source = ["record"]),
      prov_check_empty: (o) => (o.composition.provenance.act_capable.check = ""),
      outside_more_than_acted: (o) => (o.rule7_revote.outside_writers_30d = 99),
    };
    const files: Record<string, string> = { "ok.json": JSON.stringify(facts), "junk.json": "not json" };
    const lines = [...PS_DEFS, "Write-Output ('OK=[' + (Test-SeatCountsServed (Get-Content -Raw -Encoding UTF8 '@DIR@\\ok.json')) + ']')", "Write-Output ('JUNK=[' + (Test-SeatCountsServed (Get-Content -Raw -Encoding UTF8 '@DIR@\\junk.json')) + ']')"];
    for (const [name, mutate] of Object.entries(mutants)) {
      const o = deepCopy(facts);
      mutate(o);
      files[`m_${name}.json`] = JSON.stringify(o);
      lines.push(`Write-Output ('M_${name}=[' + (Test-SeatCountsServed (Get-Content -Raw -Encoding UTF8 '@DIR@\\m_${name}.json')) + ']')`);
    }
    // the pre-wave shape: composition without the three fields and with independent a bare number
    const pre = deepCopy(facts);
    for (const f of ["act_capable", "acted_30d", "operator_paid"]) delete pre.composition[f];
    pre.composition.independent = pre.composition.not_designated_operator_controlled;
    files["pre.json"] = JSON.stringify(pre);
    lines.push("Write-Output ('ABSENT_PRE=' + (Test-SeatCountsAbsent (Get-Content -Raw -Encoding UTF8 '@DIR@\\pre.json')))");
    lines.push("Write-Output ('ABSENT_NEW=' + (Test-SeatCountsAbsent (Get-Content -Raw -Encoding UTF8 '@DIR@\\ok.json')))");
    lines.push("Write-Output ('ABSENT_JUNK=' + (Test-SeatCountsAbsent 'not json'))");
    lines.push("Write-Output ('SERVED_PRE=[' + (Test-SeatCountsServed (Get-Content -Raw -Encoding UTF8 '@DIR@\\pre.json')) + ']')");
    const r = runPs(lines, files);
    if (!r) return t.skip("powershell is not available on this machine");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /OK=\[\]/, "what the code really serves passes, with no reason");
    assert.match(r.out, /JUNK=\[GET \/api\/official did not return JSON\]/);
    const reasons: Record<string, RegExp> = {
      acted_null: /composition\.acted_30d is ''.*whole number/,
      act_capable_wrong: /act_capable 13 is not citizens 13 minus key_lost 1/,
      operator_paid_absent: /composition\.operator_paid is absent/,
      paid_too_big: /operator_paid 99 is more than operator_controlled 5 plus operator_funded 7/,
      paid_too_small: /operator_paid 3 is less than/,
      acted_over_citizens: /acted_30d 99 is more than citizens 13/,
      independent_number: /not the marked object/,
      independent_count_wrong: /independent\.count 7 is not not_designated_operator_controlled 8/,
      independent_unmarked: /not the marked object/,
      use_instead_wrong: /independent\.use_instead is 'independent'/,
      meaning_empty: /independent\.meaning is empty/,
      prov_missing: /provenance\.acted_30d is missing/,
      prov_source_wrong: /provenance\.operator_paid\.source is 'record', expected arithmetic/,
      prov_check_empty: /provenance\.act_capable has no check/,
      outside_more_than_acted: /rule7_revote\.outside_writers_30d 99 is more than acted_30d/,
    };
    for (const name of Object.keys(mutants)) assert.match(r.out, new RegExp(`M_${name}=\\[[^\\]\\r\\n]+\\]`), `${name}: refused with a reason`);
    for (const [name, pattern] of Object.entries(reasons)) {
      const line = r.out.split("\n").find((l) => l.startsWith(`M_${name}=`)) ?? "";
      assert.match(line, pattern, `${name}: the reason names the broken thing`);
    }
    assert.match(r.out, /ABSENT_PRE=True/, "the live pre-wave composition is 'absent'");
    assert.match(r.out, /ABSENT_NEW=False/, "the new composition is not");
    assert.match(r.out, /ABSENT_JUNK=False/, "an unreadable body is not 'absent' either");
    assert.match(r.out, /SERVED_PRE=\[composition\.act_capable is absent\]/, "the pre-wave shape is not 'served'");
  } finally {
    d1.close();
  }
});

test("Get-CompositionSnapshot, Get-KeyNames and the two note checks (run for real): the snapshot moves when a figure moves; the key names are sorted and equal for equal shapes; the notes the code serves pass and the pre-wave wording does not", async (t) => {
  if (!definitions(t)) return;
  const { d1, env } = seeded();
  try {
    const facts: any = await officialFacts(env);
    const dir: any = await citizenDirectory(env);
    const moved = deepCopy(facts);
    moved.composition.operator_funded_handles = moved.composition.operator_funded_handles.slice(1);
    const countMoved = deepCopy(facts);
    countMoved.composition.key_lost = 0;
    const oldNote = deepCopy(facts);
    oldNote.composition.note = oldNote.composition.note.replace("act_capable, acted_30d and operator_paid in this object, each defined in provenance", "x");
    const oldCit = deepCopy(dir);
    oldCit.note = oldCit.note.replace("act_capable", "x");
    const files = { "a.json": JSON.stringify(facts), "moved.json": JSON.stringify(moved), "countmoved.json": JSON.stringify(countMoved), "oldnote.json": JSON.stringify(oldNote), "cit.json": JSON.stringify(dir), "oldcit.json": JSON.stringify(oldCit) };
    const get = (f: string) => `(Get-Content -Raw -Encoding UTF8 '@DIR@\\${f}')`;
    const r = runPs(
      [
        ...PS_DEFS,
        `Write-Output ('SNAP=' + (Get-CompositionSnapshot ${get("a.json")}))`,
        `Write-Output ('SNAP_SAME=' + ((Get-CompositionSnapshot ${get("a.json")}) -ceq (Get-CompositionSnapshot ${get("a.json")})))`,
        `Write-Output ('SNAP_HANDLE=' + ((Get-CompositionSnapshot ${get("moved.json")}) -ceq (Get-CompositionSnapshot ${get("a.json")})))`,
        `Write-Output ('SNAP_KEYLOST=' + ((Get-CompositionSnapshot ${get("countmoved.json")}) -ceq (Get-CompositionSnapshot ${get("a.json")})))`,
        "Write-Output ('SNAP_NONE=' + ($null -eq (Get-CompositionSnapshot 'not json')))",
        "Write-Output ('KEYS=' + (Get-KeyNames '{\"b\":1,\"a\":2,\"C\":3}'))",
        "Write-Output ('KEYS_NONE=' + ($null -eq (Get-KeyNames 'not json')))",
        `Write-Output ('NOTE_NEW=' + (Test-OfficialNoteHasCounts ${get("a.json")}))`,
        `Write-Output ('NOTE_OLD=' + (Test-OfficialNoteHasCounts ${get("oldnote.json")}))`,
        `Write-Output ('CIT_NEW=' + (Test-CitizensNoteNamesCounts ${get("cit.json")}))`,
        `Write-Output ('CIT_OLD=' + (Test-CitizensNoteNamesCounts ${get("oldcit.json")}))`,
        "Write-Output ('CIT_JUNK=' + (Test-CitizensNoteNamesCounts 'not json'))",
      ],
      files,
    );
    if (!r) return t.skip("powershell is not available on this machine");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /SNAP=citizens=13;operator_controlled=5;operator_funded=7;not_designated=8;key_lost=1;funded_handles=babydov-earn-20260919,boundary-auditor-917,boundary-auditor-v2,cincoforge-codex,magnus-v2,midas-jt3,spreecode/);
    assert.match(r.out, /SNAP_SAME=True/);
    assert.match(r.out, /SNAP_HANDLE=False/);
    assert.match(r.out, /SNAP_KEYLOST=False/);
    assert.match(r.out, /SNAP_NONE=True/);
    assert.match(r.out, /KEYS=C,a,b/, "ordinal sort: upper case before lower case");
    assert.match(r.out, /KEYS_NONE=True/);
    assert.match(r.out, /NOTE_NEW=True/);
    assert.match(r.out, /NOTE_OLD=False/);
    assert.match(r.out, /CIT_NEW=True/);
    assert.match(r.out, /CIT_OLD=False/);
    assert.match(r.out, /CIT_JUNK=False/);
  } finally {
    d1.close();
  }
});

test("the alias the ride reads is real (in-process, no network): GET /treasury and GET /api/treasury through the worker have the same top-level keys, which Get-KeyNames reads identically", async (t) => {
  if (!definitions(t)) return;
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response("network stubbed in test", { status: 500 })) as typeof fetch;
  const { d1, env } = seeded();
  try {
    const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
    const get = async (path: string) => (await (worker.fetch as unknown as (r: Request, e: unknown, c: unknown) => Promise<Response>)(new Request(`https://example.test${path}`), env, ctx)).text();
    const a = await get("/treasury");
    const b = await get("/api/treasury");
    const r = runPs([...PS_DEFS, "Write-Output ('A=' + (Get-KeyNames (Get-Content -Raw -Encoding UTF8 '@DIR@\\a.json')))", "Write-Output ('B=' + (Get-KeyNames (Get-Content -Raw -Encoding UTF8 '@DIR@\\b.json')))"], { "a.json": a, "b.json": b });
    if (!r) return t.skip("powershell is not available on this machine");
    assert.equal(r.code, 0, r.out);
    const keysA = /^A=(.*)$/m.exec(r.out)![1]!.trim();
    const keysB = /^B=(.*)$/m.exec(r.out)![1]!.trim();
    assert.ok(keysA.includes("entries") && keysA.includes("booked_cents"), keysA);
    assert.equal(keysB, keysA);
  } finally {
    globalThis.fetch = realFetch;
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
  const clean = run(["scripts/deploy-seat-counts.ps1", "docs/CHECKPOINT-SEAT-COUNTS.md", "test/deploy-seat-counts-script.test.ts"]);
  if (!clean) return t.skip("powershell is not available on this machine");
  assert.match(clean.out, /PAST-REVIEW/, clean.out);
  const dirty = run(["src/society.ts"]);
  assert.equal(dirty!.code, 1);
  assert.match(dirty!.out, /not on the allowlist/);
  assert.equal(/PAST-REVIEW/.test(dirty!.out), false);
  const migration = run(["migrations/0022_x.sql"]);
  assert.equal(migration!.code, 1, "a migration after the review is refused too");
  const other = run(["scripts/deploy-funding-label.ps1"]);
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
    "$bad = @(Get-DisallowedPaths @('scripts/deploy-seat-counts.ps1', 'test/deploy-seat-counts-script.test.ts', 'docs/CHECKPOINT-SEAT-COUNTS.md', 'src/society.ts', 'migrations/0022_x.sql', 'docs', 'Docs/x.md', 'scripts/deploy-funding-label.ps1'))",
    "Write-Output ('BAD=' + ($bad -join ','))",
    "$tail = \"tests 10`r`nsuites 0`r`npass 9`r`nfail 0`r`ncancelled 0`r`nskipped 1`r`ntodo 0`r`nduration_ms 12.5`r`n\"",
    "$s = Get-TestSummary $tail",
    "Write-Output ('SUMMARY=' + $s.Pass + '/' + $s.Fail + '/' + $s.SumOk)",
    "$notEnd = Get-TestSummary ($tail + 'trailing failure detail')",
    "Write-Output ('NOTEND=' + ($null -eq $notEnd))",
  ]);
  if (!r) return t.skip("powershell is not available on this machine");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /BAD=src\/society\.ts,migrations\/0022_x\.sql,docs,Docs\/x\.md,scripts\/deploy-funding-label\.ps1/, "src/, migrations/, a docs look-alike and another deploy script are not on the allowlist");
  assert.match(r.out, /SUMMARY=9\/0\/True/);
  assert.match(r.out, /NOTEND=True/);
});

test("the other deploy scripts are untouched but one: this wave adds one script and edits no existing scripts/deploy-* file except the A7 retirement of deploy-composition-split.ps1", () => {
  const funding = readFileSync(here("../scripts/deploy-funding-label.ps1"), "utf8");
  assert.match(funding, /^\$LIVE_BASE_COMMIT = "d6a5cd7829a14c3a91d962f85ce13d0330b532af"$/m, "the funding label script still holds its own live base");
  const funnel = readFileSync(here("../scripts/deploy-door-funnel.ps1"), "utf8");
  assert.match(funnel, /^\$LIVE_BASE_COMMIT = "b7cf4182868a84b8a15d311a22f1f490ace6d920"$/m, "the door funnel script still holds its own live base");
  const split = readFileSync(here("../scripts/deploy-composition-split.ps1"), "utf8");
  assert.match(split, /RETIRED by the seat counts wave/, "and the composition split script is the one retired");
});
