// scripts/deploy-funding-label.ps1 is WRITTEN AND NEVER RUN by the builder (hard rule: no deploy, no wrangler command, not even -DryRun, which reads the live worker over HTTP).
// It is proven here by everything that can be proven without running it: it parses under PowerShell's own parser, it is ASCII with LF line endings, it has none of the traps the repo's L-080
// family names, its steps are in the load-bearing order (the two pins FIRST, fetch, pin, template check, no-migration check, reviewed source, the sentence read from the code, gates, the live
// probes, dry-run exit, deploy, version id, poll, attest, ride), it has NO migration step and touches no D1 at all, step 0a stops on EITHER placeholder before any git or network command, the
// reviewed-commit pin is the placeholder or a full 40-hex sha and nothing else, and the ride is public GETs ONLY (no POST of any kind, no credential, nothing written) that look for the exact
// scope sentence (read from src/society.ts at run time, never retyped) on every surface that carries it, require the composition counts to be unchanged, and require every operator-controlled
// row to still say operator_funded:false. The pattern is test/deploy-door-funnel-script.test.ts. Every check fails when the script is mutated (the hub's report lists the mutants).
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
import { citizenDirectory, officialFacts, OPERATOR_FUNDED_SCOPE_SENTENCE, OPERATOR_CONTROLLED_HANDLES, SPONSORED_HANDLES } from "../src/society.ts";
import { renderLlmsTxt } from "../src/discovery.ts";
import { compositionDoorNote } from "../src/doc.ts";

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
const SCRIPT_PATH = here("../scripts/deploy-funding-label.ps1");
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
  const dir = mkdtempSync(join(tmpdir(), "deploy-funding-label-"));
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
const DOOR_CLAUSE = "The operator's own seats were paid from that wallet too; they are counted as operator-controlled, never as operator-funded.";

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

test("the pins: the v5 hash, the live base (the door funnel wave's deployed commit), the reviewed commit (the hub's placeholder or a full 40-hex sha) and the allowlist", () => {
  assert.match(script, /^\$V5_HASH = "fa11788d062b0c6d23c54c428c1c9649d263ae3ba704e602e122066926049491"$/m);
  assert.match(script, /^\$LIVE_BASE_COMMIT = "d6a5cd7829a14c3a91d962f85ce13d0330b532af"$/m);
  // Before the hub sets it the reviewed pin is the placeholder; after, the full sha (40 lower-case hex). Either is a valid committed state; anything else is not.
  assert.match(script, /^\$REVIEWED_COMMIT = "(?:TO-BE-SET-BY-HUB|[0-9a-f]{40})"$/m, "the reviewed commit is the hub's placeholder or a full 40-hex sha");
  assert.equal(/^\$REVIEWED_COMMIT = "[0-9a-f]*[A-F][0-9a-fA-F]*"$/m.test(script), false, "an upper-case sha is not a valid committed state");
  assert.match(script, /^\$LIVE_BASE_PLACEHOLDER = "TO-BE-SET-BY-HUB-LIVE-BASE"$/m);
  assert.match(script, /^\$REVIEWED_COMMIT_PLACEHOLDER = "TO-BE-SET-BY-HUB"$/m);
  const allowed = /\$ALLOWED_PATHS_AFTER_REVIEW = @\(([^)]*)\)/.exec(code)?.[1] ?? "";
  assert.deepEqual([...allowed.matchAll(/"([^"]+)"/g)].map((m) => m[1]), ["scripts/deploy-funding-label.ps1", "test/deploy-funding-label-script.test.ts", "docs/"]);
  assert.equal([...code.matchAll(/\$ALLOWED_PATHS_AFTER_REVIEW = /g)].length, 1, "stated once");
  assert.match(code, /\$ROLLBACK_LINE = .*\$rollbackTarget/, "the rollback line names the version read from the live worker");
  assert.match(code, /\$ROLLBACK_LINE = .*applied no migration and wrote no row, so the rollback is the whole undo/, "and says the rollback is the whole undo");
  assert.equal(/\$ROLLBACK_WORKER_VERSION/.test(code), false, "no typed-in rollback version: it is read live, before the deploy");
  assert.match(script, new RegExp(`^\\$DOOR_CLAUSE = "${DOOR_CLAUSE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"$`, "m"), "the door clause is the one compositionDoorNote serves");
  assert.equal(/OPERATOR_FUNDED_SCOPE_SENTENCE\s*=\s*"/.test(code), false, "the scope sentence is never retyped in the script: it is read from src/society.ts");
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

test("the steps are in the load-bearing order: pins, fetch, branch, clean tree, ancestry, template check, no-migration check, reviewed source, the sentence read from the code, gates, probes (live base proved, sentence absent, counts recorded), (dry-run exit), deploy, version id, poll, attest, ride (public reads, the served words, the counts, the rows)", () => {
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
    "$SCOPE_SENTENCE = Get-ScopeSentence",
    "$testOut = (npm test",
    "$attBefore = Read-Attest",
    "[string]$attBefore.code.commit -cne $LIVE_BASE_COMMIT",
    "$officialBefore = Get-Text",
    "Test-ProvenanceHasScope $officialBefore.Body",
    "$snapshotBefore = Get-CompositionSnapshot",
    "if ($DryRun) {",
    "$deployOut = (npx wrangler deploy",
    "Current Version ID",
    "Wait-NewWorker $headSha",
    "Assert-Attest $attAfter",
    "foreach ($p in",
    "$officialNow = Get-Text",
    "$citizensNow = Get-Text",
    "$llmsNow = Get-Text",
    "$doorNow = Get-Text",
    "$snapshotAfter = Get-CompositionSnapshot",
    "$facts = Get-CitizenFlagFacts",
    "$facts.Violations.Count -gt 0",
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

test("the ride is public GETs ONLY: no POST of any kind, no data argument, no credential, one curl.exe command (inside Get-Text), the sentence is looked for on every surface that carries it, and the closing log says it wrote nothing", () => {
  assert.equal(/Authorization|Bearer|ch1\.|api\/resident\/(bind|token)|api\/council\/(challenge|claim|ballot)|guest_enter|guest_comment|showhome_note|resident_|council_(ballot|flag|motion)|initialize/.test(code), false, "nothing in the executed code authenticates, initializes or calls a write or guest tool");
  assert.equal(/-X\s|--request|--data|-d\s+["'@]|--form|-F\s|--upload-file|-T\s|Post-Rpc|\bPOST\b|\bPUT\b|\bPATCH\b|\bDELETE\b|Invoke-WebRequest|Invoke-RestMethod|-Method\b/.test(code), false, "no HTTP method but GET ever appears in the executed code");
  assert.equal([...code.matchAll(/curl\.exe/g)].length, 1, "exactly one curl.exe command in the whole script (inside Get-Text)");
  assert.match(code, /curl\.exe -s --max-time \$maxTime -o \$tmp -w "%\{http_code\}" \$url/, "and it is a plain GET");
  const listLine = code.split("\n").find((l) => /^foreach \(\$p in "\/", /.test(l)) ?? "";
  const listed = [...listLine.matchAll(/"(\/[^"]*)"/g)].map((m) => m[1]!);
  assert.equal(listed.length, 13, "thirteen public reads");
  assert.equal(listed.includes("/skill.md") || listed.includes("/heartbeat.md"), false, "neither door-counted file is read");
  assert.equal(/Get-(Text|Json)[^\n]*(skill\.md|heartbeat)/.test(code), false, "/skill.md and /heartbeat.md are never read");
  // each surface is asserted
  assert.match(code, /Test-ProvenanceHasScope \$officialNow\.Body \$SCOPE_SENTENCE/, "the operator_funded provenance check");
  assert.match(code, /Test-OfficialNoteHasScope \$officialNow\.Body \$SCOPE_SENTENCE/, "the composition note");
  assert.match(code, /Test-CitizensNoteHasScope \$citizensNow\.Body \$SCOPE_SENTENCE/, "the citizens note");
  assert.match(code, /Test-ContainsFlat \$llmsNow\.Body \$SCOPE_SENTENCE/, "llms.txt");
  assert.match(code, /Test-ContainsFlat \$doorNow\.Body \$DOOR_CLAUSE/, "the GET / door clause");
  assert.match(code, /\$snapshotAfter -cne \$snapshotBefore\) \{ Stop-Here/, "the composition counts must equal the ones served before");
  assert.match(code, /\$facts\.Violations\.Count -gt 0\) \{ Stop-Here/, "an operator-controlled row that is not operator_funded:false STOPS the ride");
  assert.match(code, /\$facts\.Controlled -lt 1\) \{ Stop-Here/, "and the row check cannot pass vacuously");
  assert.match(code, /\$facts\.HasMore\) \{ Stop-Here/, "nor on a page that does not show every row");
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

test("it proves the live worker IS the pinned base (code.commit equals $LIVE_BASE_COMMIT), reads the rollback target from it, and probes that the provenance check does NOT yet carry the sentence before the deploy, which is what makes the poll mean something; the poll needs the stamped commit AND the printed version id AND the sentence", () => {
  assert.match(code, /\[string\]\$attBefore\.code\.commit -cne \$LIVE_BASE_COMMIT/);
  assert.match(code, /\$rollbackTarget = \[string\]\$attBefore\.code\.version_id/);
  assert.match(code, /^\$OFFICIAL_URL = "\$BASE\/api\/official"$/m);
  assert.match(code, /if \(Test-ProvenanceHasScope \$officialBefore\.Body \$SCOPE_SENTENCE\) \{ Stop-Here/);
  assert.match(code, /Current Version ID:/);
  assert.match(code, /\$versionMatches\.Count -gt 1\) \{ Stop-Here/);
  assert.match(code, /\$versionMatches\.Count -lt 1\) \{ Stop-Here/);
  assert.match(code, /\$code\.commit -cne \$commit/);
  assert.match(code, /\$code\.version_id\)\.ToLowerInvariant\(\) -cne/);
  assert.match(code, /\$route\.Code -eq "200" -and \(Test-ProvenanceHasScope \$route\.Body \$sentence\)/, "the poll also waits for the sentence");
});

test("step 0 reads the sentence from the code (never retyped), stops when it is unreadable, and requires the door clause in src/doc.ts and the sentence in src/discovery.ts", () => {
  assert.match(code, /\$SCOPE_SENTENCE = Get-ScopeSentence \$societyText/);
  assert.match(code, /\$null -eq \$SCOPE_SENTENCE\) \{ Stop-Here/);
  assert.match(code, /Select-String -Path "src\/doc\.ts" -Pattern \$DOOR_CLAUSE -SimpleMatch -Quiet/);
  assert.match(code, /Select-String -Path "src\/discovery\.ts" -Pattern "OPERATOR_FUNDED_SCOPE_SENTENCE" -Quiet/);
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

function seeded() {
  const d1 = createLocalD1();
  insertCitizen(d1, { handle: OPERATOR_CONTROLLED_HANDLES[0]! });
  insertCitizen(d1, { handle: SPONSORED_HANDLES[0]! });
  insertCitizen(d1, { handle: "sisyphus" });
  return guestEnv(d1);
}

test("Get-ScopeSentence (run for real): it reads exactly the OPERATOR_FUNDED_SCOPE_SENTENCE the code exports from the real src/society.ts; a missing literal, or one holding a backslash, is null", (t) => {
  if (!definitions(t)) return;
  const societyTs = readFileSync(here("../src/society.ts"), "utf8").replace(/\r\n/g, "\n");
  const r = runPs(
    [
      ...PS_DEFS,
      "$a = Get-ScopeSentence (Get-Content -Raw -Encoding UTF8 '@DIR@\\a.txt')",
      "$exp = Get-Content -Raw -Encoding UTF8 '@DIR@\\exp.txt'",
      "Write-Output ('MATCH=' + ($a -ceq $exp))",
      "Write-Output ('LEN=' + $a.Length)",
      "$b = Get-ScopeSentence 'export const SOMETHING_ELSE = \"x\";'",
      "Write-Output ('MISSING=' + ($null -eq $b))",
      "$c = Get-ScopeSentence (Get-Content -Raw -Encoding UTF8 '@DIR@\\c.txt')",
      "Write-Output ('ESCAPE=' + ($null -eq $c))",
    ],
    {
      "a.txt": societyTs,
      "exp.txt": OPERATOR_FUNDED_SCOPE_SENTENCE,
      "c.txt": 'export const OPERATOR_FUNDED_SCOPE_SENTENCE =\n  "a \\"quoted\\" sentence";\n',
    },
  );
  if (!r) return t.skip("powershell is not available on this machine");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /MATCH=True/, "the PowerShell read equals the TypeScript export");
  assert.match(r.out, new RegExp(`LEN=${OPERATOR_FUNDED_SCOPE_SENTENCE.length}\\b`));
  assert.match(r.out, /MISSING=True/);
  assert.match(r.out, /ESCAPE=True/, "an escaped quote is not undone silently");
});

test("the Test-* surface checks (run for real): true only when the sentence is where the script looks; false for the pre-wave text, another surface, a missing field, an empty needle and text that is not JSON", (t) => {
  if (!definitions(t)) return;
  const S = OPERATOR_FUNDED_SCOPE_SENTENCE;
  const official = (o: { check?: string; note?: string }) => JSON.stringify({ composition: { provenance: { operator_funded: { check: o.check ?? "" } }, note: o.note ?? "" } });
  const flatWrapped = S.replace(/ /g, "\n  ");
  const cases: Array<[string, string]> = [
    ["PROV_NEW", `Test-ProvenanceHasScope ${ps(official({ check: "Record: x. " + S }))} ${ps(S)}`],
    ["PROV_OLD", `Test-ProvenanceHasScope ${ps(official({ check: "Record: x. Commonhold's statement: that the paying wallet is the operator's." }))} ${ps(S)}`],
    ["PROV_ONLY_IN_NOTE", `Test-ProvenanceHasScope ${ps(official({ note: S }))} ${ps(S)}`],
    ["PROV_NOFIELD", `Test-ProvenanceHasScope ${ps(JSON.stringify({ composition: {} }))} ${ps(S)}`],
    ["PROV_EMPTYNEEDLE", `Test-ProvenanceHasScope ${ps(official({ check: "anything" }))} ''`],
    ["PROV_JUNK", `Test-ProvenanceHasScope 'not json' ${ps(S)}`],
    ["NOTE_NEW", `Test-OfficialNoteHasScope ${ps(official({ note: "x " + S + " y" }))} ${ps(S)}`],
    ["NOTE_ONLY_IN_PROV", `Test-OfficialNoteHasScope ${ps(official({ check: S }))} ${ps(S)}`],
    ["CIT_NEW", `Test-CitizensNoteHasScope ${ps(JSON.stringify({ note: "a " + S + " b", citizens: [] }))} ${ps(S)}`],
    ["CIT_OLD", `Test-CitizensNoteHasScope ${ps(JSON.stringify({ note: "a b", citizens: [] }))} ${ps(S)}`],
    ["FLAT_WRAPPED", `Test-ContainsFlat ${ps("intro " + flatWrapped + " outro")} ${ps(S)}`],
    ["FLAT_WRONGCASE", `Test-ContainsFlat ${ps(S.toUpperCase())} ${ps(S)}`],
    ["FLAT_TRUNCATED", `Test-ContainsFlat ${ps(S.slice(0, S.length - 12))} ${ps(S)}`],
  ];
  const r = runPs([...PS_DEFS, ...cases.map(([name, call]) => `Write-Output ('${name}=' + (${call}))`)]);
  if (!r) return t.skip("powershell is not available on this machine");
  assert.equal(r.code, 0, r.out);
  for (const name of ["PROV_NEW", "NOTE_NEW", "CIT_NEW", "FLAT_WRAPPED"]) assert.match(r.out, new RegExp(`${name}=True`), name);
  for (const name of ["PROV_OLD", "PROV_ONLY_IN_NOTE", "PROV_NOFIELD", "PROV_EMPTYNEEDLE", "PROV_JUNK", "NOTE_ONLY_IN_PROV", "CIT_OLD", "FLAT_WRONGCASE", "FLAT_TRUNCATED"]) assert.match(r.out, new RegExp(`${name}=False`), name);
});

test("Get-CompositionSnapshot and Get-CitizenFlagFacts (run for real): the snapshot changes when a count or a funded handle changes; the rows check reports an operator-controlled row that is not operator_funded:false, counts the rows, and reads has_more", (t) => {
  if (!definitions(t)) return;
  const comp = (o: Record<string, unknown>) => JSON.stringify({ composition: { citizens: 13, operator_controlled: 5, operator_funded: 2, operator_funded_handles: ["b-seat", "a-seat"], ...o } });
  const rows = (list: Array<[string, boolean, boolean]>, more = false) => JSON.stringify({ has_more: more, citizens: list.map(([handle, c, f]) => ({ handle, operator_controlled: c, operator_funded: f })) });
  const r = runPs([
    ...PS_DEFS,
    `Write-Output ('SNAP=' + (Get-CompositionSnapshot ${ps(comp({}))}))`,
    `Write-Output ('SNAP_SAME=' + ((Get-CompositionSnapshot ${ps(comp({ operator_funded_handles: ["a-seat", "b-seat"] }))}) -ceq (Get-CompositionSnapshot ${ps(comp({}))})))`,
    `Write-Output ('SNAP_COUNT=' + ((Get-CompositionSnapshot ${ps(comp({ operator_funded: 3 }))}) -ceq (Get-CompositionSnapshot ${ps(comp({}))})))`,
    `Write-Output ('SNAP_HANDLE=' + ((Get-CompositionSnapshot ${ps(comp({ operator_funded_handles: ["a-seat", "c-seat"] }))}) -ceq (Get-CompositionSnapshot ${ps(comp({}))})))`,
    `Write-Output ('SNAP_NONE=' + ($null -eq (Get-CompositionSnapshot ${ps(JSON.stringify({ x: 1 }))})))`,
    `$ok = Get-CitizenFlagFacts ${ps(rows([["op1", true, false], ["op2", true, false], ["sp1", false, true], ["free", false, false]]))}`,
    "Write-Output ('OK=' + $ok.Rows + '/' + $ok.Controlled + '/' + $ok.Funded + '/' + $ok.Violations.Count + '/' + $ok.HasMore)",
    `$bad = Get-CitizenFlagFacts ${ps(rows([["op1", true, true], ["op2", true, false], ["sp1", false, true]]))}`,
    "Write-Output ('BAD=' + ($bad.Violations -join ',') + '/' + $bad.Controlled)",
    `$more = Get-CitizenFlagFacts ${ps(rows([["op1", true, false]], true))}`,
    "Write-Output ('MORE=' + $more.HasMore)",
    `Write-Output ('NOROWS=' + ($null -eq (Get-CitizenFlagFacts ${ps(JSON.stringify({ x: 1 }))})))`,
    "Write-Output ('JUNK=' + ($null -eq (Get-CitizenFlagFacts 'not json')))",
  ]);
  if (!r) return t.skip("powershell is not available on this machine");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /SNAP=citizens=13;operator_controlled=5;operator_funded=2;funded_handles=a-seat,b-seat/);
  assert.match(r.out, /SNAP_SAME=True/, "the handle order does not matter");
  assert.match(r.out, /SNAP_COUNT=False/);
  assert.match(r.out, /SNAP_HANDLE=False/);
  assert.match(r.out, /SNAP_NONE=True/);
  assert.match(r.out, /OK=4\/2\/1\/0\/False/);
  assert.match(r.out, /BAD=op1\/2/, "the operator-controlled row that is also operator_funded:true is named");
  assert.match(r.out, /MORE=True/);
  assert.match(r.out, /NOROWS=True/);
  assert.match(r.out, /JUNK=True/);
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
  const clean = run(["scripts/deploy-funding-label.ps1", "docs/CHECKPOINT-FUNDING-LABEL.md", "test/deploy-funding-label-script.test.ts"]);
  if (!clean) return t.skip("powershell is not available on this machine");
  assert.match(clean.out, /PAST-REVIEW/, clean.out);
  const dirty = run(["src/society.ts"]);
  assert.equal(dirty!.code, 1);
  assert.match(dirty!.out, /not on the allowlist/);
  assert.equal(/PAST-REVIEW/.test(dirty!.out), false);
  const migration = run(["migrations/0022_x.sql"]);
  assert.equal(migration!.code, 1, "a migration after the review is refused too");
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
    "$bad = @(Get-DisallowedPaths @('scripts/deploy-funding-label.ps1', 'test/deploy-funding-label-script.test.ts', 'docs/CHECKPOINT-FUNDING-LABEL.md', 'src/society.ts', 'migrations/0022_x.sql', 'docs', 'Docs/x.md', 'scripts/deploy-door-funnel.ps1'))",
    "Write-Output ('BAD=' + ($bad -join ','))",
    "$tail = \"tests 10`r`nsuites 0`r`npass 9`r`nfail 0`r`ncancelled 0`r`nskipped 1`r`ntodo 0`r`nduration_ms 12.5`r`n\"",
    "$s = Get-TestSummary $tail",
    "Write-Output ('SUMMARY=' + $s.Pass + '/' + $s.Fail + '/' + $s.SumOk)",
    "$notEnd = Get-TestSummary ($tail + 'trailing failure detail')",
    "Write-Output ('NOTEND=' + ($null -eq $notEnd))",
  ]);
  if (!r) return t.skip("powershell is not available on this machine");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /BAD=src\/society\.ts,migrations\/0022_x\.sql,docs,Docs\/x\.md,scripts\/deploy-door-funnel\.ps1/, "src/, migrations/, a docs look-alike and another deploy script are not on the allowlist");
  assert.match(r.out, /SUMMARY=9\/0\/True/);
  assert.match(r.out, /NOTEND=True/);
});

// ---------- the things the script waits for and rides are really served by the new code ----------

test("the poll target and the ride are real (in-process, no network): the sentence the script reads from src/society.ts is found by the script's own checks on what officialFacts, citizenDirectory, renderLlmsTxt and compositionDoorNote serve, and the door clause literal in the script is the one the door note serves", async (t) => {
  if (!definitions(t)) return;
  const env = seeded();
  const facts: any = await officialFacts(env);
  const dir: any = await citizenDirectory(env);
  const llms = renderLlmsTxt({
    origin: "https://example.test",
    society: "Commonhold",
    composition: { citizens: 13, operator_controlled: 5, not_designated_operator_controlled: 8, operator_controlled_percent: 38, operator_funded: 7, operator_funded_handles: ["magnus-v2"] },
  } as any);
  const door = compositionDoorNote(51, {
    citizens: 13,
    operator_controlled: 5,
    not_designated_operator_controlled: 8,
    operator_controlled_percent: 38,
    operator_controlled_handles: ["commonhold-agent"],
    operator_funded_handles: ["magnus-v2"],
  });
  const scriptClause = /^\$DOOR_CLAUSE = "(.*)"$/m.exec(script)![1]!;
  assert.equal(scriptClause, DOOR_CLAUSE);
  const societyTs = readFileSync(here("../src/society.ts"), "utf8").replace(/\r\n/g, "\n");
  const r = runPs(
    [
      ...PS_DEFS,
      "$s = Get-ScopeSentence (Get-Content -Raw -Encoding UTF8 '@DIR@\\society.txt')",
      "$official = Get-Content -Raw -Encoding UTF8 '@DIR@\\official.json'",
      "$citizens = Get-Content -Raw -Encoding UTF8 '@DIR@\\citizens.json'",
      "$llms = Get-Content -Raw -Encoding UTF8 '@DIR@\\llms.txt'",
      "$door = Get-Content -Raw -Encoding UTF8 '@DIR@\\door.txt'",
      "Write-Output ('PROV=' + (Test-ProvenanceHasScope $official $s))",
      "Write-Output ('NOTE=' + (Test-OfficialNoteHasScope $official $s))",
      "Write-Output ('CIT=' + (Test-CitizensNoteHasScope $citizens $s))",
      "Write-Output ('LLMS=' + (Test-ContainsFlat $llms $s))",
      `Write-Output ('DOOR=' + (Test-ContainsFlat $door ${ps(scriptClause)}))`,
      "Write-Output ('SNAP=' + (Get-CompositionSnapshot $official))",
      "$f = Get-CitizenFlagFacts $citizens",
      "Write-Output ('ROWS=' + $f.Rows + '/' + $f.Controlled + '/' + $f.Funded + '/' + $f.Violations.Count)",
    ],
    {
      "society.txt": societyTs,
      "official.json": JSON.stringify(facts),
      "citizens.json": JSON.stringify(dir),
      "llms.txt": llms,
      "door.txt": door,
    },
  );
  if (!r) return t.skip("powershell is not available on this machine");
  assert.equal(r.code, 0, r.out);
  for (const name of ["PROV", "NOTE", "CIT", "LLMS", "DOOR"]) assert.match(r.out, new RegExp(`${name}=True`), `${name}: the script's own check finds the text the code serves`);
  assert.match(r.out, /SNAP=citizens=3;operator_controlled=1;operator_funded=1;funded_handles=magnus-v2/);
  assert.match(r.out, /ROWS=3\/1\/1\/0/, "the operator-controlled row is operator_funded:false in what the code serves");
});

test("the other deploy scripts are untouched: this wave adds one script and edits no existing scripts/deploy-* file", () => {
  const funnel = readFileSync(here("../scripts/deploy-door-funnel.ps1"), "utf8");
  assert.match(funnel, /^\$LIVE_BASE_COMMIT = "b7cf4182868a84b8a15d311a22f1f490ace6d920"$/m, "the door funnel script still holds its own live base");
  assert.equal(funnel.includes("OPERATOR_FUNDED_SCOPE_SENTENCE"), false, "and does not mention the scope sentence");
  const flag = readFileSync(here("../scripts/deploy-council-flag.ps1"), "utf8");
  assert.match(flag, /^\$LIVE_BASE_COMMIT = "5c04ca34588ffca279e246e6865920b4b5164e0f"$/m, "the council flag script still holds its own live base");
});
