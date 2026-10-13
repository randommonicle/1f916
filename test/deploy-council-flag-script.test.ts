// scripts/deploy-council-flag.ps1 is WRITTEN AND NEVER RUN by the builder (hard rule: no deploy, no wrangler command, not even -DryRun, which reads the live worker over HTTP).
// It is proven here by everything that can be proven without running it: it parses under PowerShell's own parser, it is ASCII, it has none of the traps the repo's L-080 family names, its
// steps are in the load-bearing order (the two pins FIRST, fetch, pin, template check, no-migration check, reviewed source, gates, the live probes, dry-run exit, deploy, version id, poll,
// attest, ride), it has NO migration step and touches no D1 at all, step 0a stops on EITHER placeholder before any git or network command, the reviewed-commit pin is the placeholder or a
// full 40-hex sha and nothing else, and the ride is public GETs plus EXACTLY ONE refused unbound flag POST that holds no credential, then reads /skill.md exactly once, last, after saying that
// read adds one door count. The pattern is test/deploy-hardening-script.test.ts. Every check fails when the script is mutated (docs/CHECKPOINT-COUNCIL-FLAG.md).
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
import { councilCast, call, rows } from "./helpers/council.ts";
import { SKILL_VERSION } from "../src/inbox.ts";

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
const SCRIPT_PATH = here("../scripts/deploy-council-flag.ps1");
const script = readFileSync(SCRIPT_PATH, "utf8").replace(/\r\n/g, "\n");
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
  const dir = mkdtempSync(join(tmpdir(), "deploy-council-flag-"));
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

test("the script parses under PowerShell's own parser with zero errors, and is ASCII only", (t) => {
  assert.equal(/[^\x00-\x7f]/.test(script), false, "5.1 reads a BOM-less UTF-8 script as the ANSI code page: ASCII only");
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

test("the pins: the v5 hash, the live base (the hardening wave's deployed commit), the reviewed commit (the hub's placeholder or a full 40-hex sha) and the allowlist", () => {
  assert.match(script, /^\$V5_HASH = "fa11788d062b0c6d23c54c428c1c9649d263ae3ba704e602e122066926049491"$/m);
  assert.match(script, /^\$LIVE_BASE_COMMIT = "5c04ca34588ffca279e246e6865920b4b5164e0f"$/m);
  // Before the merge the builder leaves the reviewed placeholder; after it the hub sets the full sha (40 lower-case hex). Either is a valid committed state; anything else is not.
  assert.match(script, /^\$REVIEWED_COMMIT = "(?:TO-BE-SET-BY-HUB|[0-9a-f]{40})"$/m, "the reviewed commit is the hub's placeholder or a full 40-hex sha");
  assert.equal(/^\$REVIEWED_COMMIT = "[0-9a-f]*[A-F][0-9a-fA-F]*"$/m.test(script), false, "an upper-case sha is not a valid committed state");
  assert.match(script, /^\$LIVE_BASE_PLACEHOLDER = "TO-BE-SET-BY-HUB-LIVE-BASE"$/m);
  assert.match(script, /^\$REVIEWED_COMMIT_PLACEHOLDER = "TO-BE-SET-BY-HUB"$/m);
  const allowed = /\$ALLOWED_PATHS_AFTER_REVIEW = @\(([^)]*)\)/.exec(code)?.[1] ?? "";
  assert.deepEqual([...allowed.matchAll(/"([^"]+)"/g)].map((m) => m[1]), ["scripts/deploy-council-flag.ps1", "test/deploy-council-flag-script.test.ts", "docs/"]);
  assert.equal([...code.matchAll(/\$ALLOWED_PATHS_AFTER_REVIEW = /g)].length, 1, "stated once");
  assert.match(code, /\$ROLLBACK_LINE = .*\$rollbackTarget/, "the rollback line names the version read from the live worker");
  assert.match(code, /\$ROLLBACK_LINE = .*applied no migration, so the rollback is the whole undo/, "and says the rollback is the whole undo");
  assert.match(code, /\$ROLLBACK_LINE = .*restores the previous worker's unbound flag/, "and names what a rollback restores: the unbound flag");
  assert.match(code, /\$ROLLBACK_LINE = .*a flag already set stays set, because a flag is one-way/, "and that a flag already set stays set");
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

test("the steps are in the load-bearing order: pins, fetch, branch, clean tree, ancestry, template check, no-migration check, reviewed source, gates, probes (live base proved, new notes absent), (dry-run exit), deploy, version id, poll, attest, ride (surface, llms.txt, manifest, earlier waves, the one unbound POST, /skill.md last)", () => {
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
    "$testOut = (npm test",
    "$attBefore = Read-Attest",
    "[string]$attBefore.code.commit -cne $LIVE_BASE_COMMIT",
    "$surfaceBefore = Get-Text",
    "if ($DryRun) {",
    "$deployOut = (npx wrangler deploy",
    "Current Version ID",
    "Wait-NewWorker $headSha",
    "Assert-Attest $attAfter",
    "$surface = Get-Json",
    "$llms = Get-Text",
    "$manifest = Get-Text",
    "$official = Get-Json",
    "$councilRaw = Get-Text",
    "$unbound = Post-Unbound",
    "$councilAfter = Get-Json",
    "$skill = Get-Text",
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

test("NO migration and NO D1 access of any kind: no wrangler d1, no Invoke-D1Read, no catalogue function, no migration apply; the one wrangler command is the stamped deploy (and a rollback is only text for Ben)", () => {
  assert.equal(/wrangler d1|d1 execute|Invoke-D1Read|Assert-CouncilSchema|--file|migrationPath|MIGRATION_/.test(code), false, "no D1 and no migration in the executed code");
  const calls = [...code.matchAll(/^\s*(?:\$\w+ = \()?npx wrangler ([a-z0-9]+)/gm)].map((m) => m[1]);
  assert.deepEqual(calls, ["deploy"], "exactly one executed wrangler subcommand, and it is deploy");
  assert.equal(/npx wrangler (rollback|secret|delete|tail|versions|kv|r2|queues|d1)/.test(code.replace(/\$ROLLBACK_LINE = "[^"]*"/, "").replace(/\$ErrorActionPreference[^\n]*/g, "")), false, "no other wrangler subcommand is ever executed");
  assert.match(code, /npx wrangler deploy --var "CODE_COMMIT:\$headSha"/, "the deploy stamps the pinned full sha (served code identity)");
  assert.equal([...code.matchAll(/^\s*\$deployOut = \(npx wrangler deploy --var/gm)].length, 1, "one executed deploy line carries the stamp");
  // step 0 STOPS if the wave grew a migration or a schema change: this script could not apply it
  assert.match(code, /\$schemaMoves = @\(git diff --name-status --no-renames \$LIVE_BASE_COMMIT HEAD -- migrations schema\.sql\)/);
  assert.match(code, /\$schemaMoves\.Count -gt 0\) \{ Stop-Here/);
});

test("the ride is public GETs plus EXACTLY ONE refused unbound POST, and builds no key, token or assertion: the one POST has no body fields, no Authorization, targets motion 999999 and is made once; /heartbeat.md is never read; /skill.md is read exactly once, last, after a line saying that read adds one door count", () => {
  assert.equal(/Post-Json|--data-binary|tools\/call|tools\/list|"initialize"|api\/resident\/(bind|token)|api\/council\/(challenge|claim|ballot)|ch1\.|Authorization|Bearer/.test(code), false, "nothing in the executed code writes, authenticates or builds a credential");
  assert.equal([...code.matchAll(/-X POST/g)].length, 1, "exactly one POST in the whole script");
  assert.equal([...code.matchAll(/Post-Unbound \$UNBOUND_FLAG_URL/g)].length, 1, "and it is called once");
  assert.match(code, /-X POST -H "content-type: application\/json" -d "\{\}"/, "an empty JSON body and nothing else");
  assert.match(code, /^\$UNBOUND_FLAG_URL = "\$BASE\/api\/council\/motion\/999999\/flag"$/m, "against a motion that does not exist");
  const listLine = code.split("\n").find((l) => /^foreach \(\$p in "\/", /.test(l)) ?? "";
  assert.ok(listLine.length > 0, "the public-reads loop exists");
  const listed = [...listLine.matchAll(/"(\/[^"]*)"/g)].map((m) => m[1]!);
  assert.equal(listed.includes("/skill.md") || listed.includes("/heartbeat.md"), false, "neither door-counted path is in the 14-read loop");
  assert.equal(new Set(listed).size, listed.length, "no path is read twice");
  assert.equal(listed.length, 14, "fourteen public reads, as the log says");
  assert.match(code, /\[ride\] 14 public reads/);
  assert.equal(/Get-(Text|Json)[^\n]*heartbeat/.test(code), false, "/heartbeat.md is never read (it is named only in log text)");
  assert.equal(code.split('Get-Text "$BASE/skill.md" 30').length - 1, 1, "/skill.md is read exactly once");
  const sayAt = at("reading /skill.md now, ONCE");
  const readAt = at('Get-Text "$BASE/skill.md" 30');
  assert.ok(sayAt < readAt, "and the script says so BEFORE it reads");
  assert.match(code, /that one 200 adds ONE to today's door_counts row/, "naming the door count");
  assert.ok(readAt > at("$councilRaw = Get-Text"), "after every other read");
  assert.ok(readAt > at("$unbound = Post-Unbound"), "and after the one POST");
  assert.ok(at("making ONE refused POST now") < at("$unbound = Post-Unbound"), "the POST is announced before it is made");
  assert.match(script, /THE RIDE IS PUBLIC GETs PLUS EXACTLY ONE REFUSED POST/, "the header says so");
  assert.match(script, /THE BINDINGS THEMSELVES[\s\S]*?ARE PROVED BY TESTS ONLY/, "and that the bindings are proved by tests only");
  assert.match(script, /Its only trace is the one rate-cap reservation row/, "and names the POST's only trace");
  assert.match(code, /Writes made by this ride: the one door count the \/skill\.md read added, and the one rate-cap row the refused unbound flag made/, "the closing log names both writes");
  assert.equal(/No live write was made\. /.test(code), false, "the log does not claim no write at all");
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

test("it proves the live worker IS the pinned base (code.commit equals $LIVE_BASE_COMMIT), reads the rollback target from it, and probes that the flag route's two bindings are ABSENT from GET /api/surface before the deploy, which is what makes the poll mean something; the poll needs the stamped commit AND the printed version id AND the bindings", () => {
  assert.match(code, /\[string\]\$attBefore\.code\.commit -cne \$LIVE_BASE_COMMIT/);
  assert.match(code, /\$rollbackTarget = \[string\]\$attBefore\.code\.version_id/);
  assert.match(code, /^\$NEW_CODE_URL = "\$BASE\/api\/surface"$/m);
  assert.match(code, /^\$FLAG_ROUTE_PATH = "\/api\/council\/motion\/:id\/flag"$/m);
  assert.match(code, /^\$SURFACE_CITIZEN_PHRASE = "intent binding 'council_flag' over \[motion_id\]"$/m);
  assert.match(code, /^\$SURFACE_RESIDENT_PHRASE = "intent binding 'resident_council_flag' over \[resident number, motion_id\]"$/m);
  assert.match(code, /if \(Test-SurfaceCarriesFlagBinding \$surfaceBefore\.Body\) \{ Stop-Here/);
  assert.match(code, /Current Version ID:/);
  assert.match(code, /\$versionMatches\.Count -gt 1\) \{ Stop-Here/);
  assert.match(code, /\$versionMatches\.Count -lt 1\) \{ Stop-Here/);
  assert.match(code, /\$code\.commit -cne \$commit/);
  assert.match(code, /\$code\.version_id\)\.ToLowerInvariant\(\) -cne/);
  assert.match(code, /\$route\.Code -eq "200" -and \(Test-SurfaceCarriesFlagBinding \$route\.Body\)/, "the poll also waits for the bindings on /api/surface");
});

test("the ride's checks are the wave's own: the flag route's note names both bindings and no token; /llms.txt carries the credential sentence; the MCP manifest says a ballot and a flag are signed; /api/council still has no record_body and says a flag is one-way and public; the unbound POST must be 401 naming resident_council_flag with the motions total unmoved; /skill.md 1.4.2", () => {
  assert.match(code, /\$flagNote\.Contains\(\$SURFACE_CITIZEN_PHRASE\)/);
  assert.match(code, /\$flagNote\.Contains\(\$SURFACE_RESIDENT_PHRASE\)/);
  assert.match(code, /\$flagNote\.Contains\("no token is read"\)/);
  assert.match(code, /\$flagNote\.Contains\("\{token\}"\)\) \{ Stop-Here/);
  assert.match(code, /\$llms\.Body\.Contains\(\$CREDENTIAL_PHRASE\)/);
  assert.match(code, /\$manifest\.Body\.Contains\(\$MCP_MANIFEST_PHRASE\)/);
  assert.match(code, /-cnotcontains "rule7_revote"/);
  assert.match(code, /\$councilRaw\.Body\.Contains\("record_body"\)/);
  assert.match(code, /\$councilRaw\.Body\.Contains\("a flag is one-way and public"\)/);
  assert.match(code, /\$unbound\.Code -notmatch '\^4\[0-9\]\[0-9\]\$'/);
  assert.match(code, /\$unbound\.Code -ne "401"/);
  assert.match(code, /\$unbound\.Body\.Contains\("resident_council_flag"\)/);
  assert.match(code, /\$unbound\.Body\.Contains\("council_flag_unbound"\)/);
  assert.match(code, /\[string\]\$councilAfter\.motions\.total -cne \[string\]\$councilBefore\.motions\.total/);
  assert.match(code, /^\$SKILL_VERSION_LINE = "version: 1\.4\.2"$/m);
  assert.match(code, /^\$SKILL_FLAG_PHRASE = "council_flag: plus the digest of \[<motion id>\] for a flag"$/m);
  assert.match(code, /^\$SKILL_RESIDENT_PHRASE = "resident_council_flag: plus the digest of \[<your number>,<motion id>\]"$/m);
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

test("the definitions region runs nothing, and the poll is bounded (12 tries, 5 s apart)", (t) => {
  const d = definitions(t);
  if (!d) return;
  assert.equal(d.TRIES, "12");
  assert.equal(d.DELAY, "5");
});

test("Test-SurfaceCarriesFlagBinding (run for real): true only when the flag route's note carries BOTH binding phrases; false for the pre-wave note, either phrase alone, the phrases on another route, a wrong-case phrase, no routes and text that is not JSON", (t) => {
  if (!definitions(t)) return;
  const ps = (s: string) => "'" + s.replace(/'/g, "''") + "'";
  const citizen = "intent binding 'council_flag' over [motion_id]";
  const resident = "intent binding 'resident_council_flag' over [resident number, motion_id]";
  const doc = (path: string, note: string) => JSON.stringify({ routes: [{ method: "POST", path, note }] });
  const flag = "/api/council/motion/:id/flag";
  const cases: Array<[string, string]> = [
    ["NEW", doc(flag, `a ${citizen}. b ${resident}. no token is read`)],
    ["OLD", doc(flag, "body: for a resident {token}; a citizen credential in Authorization wins when both are present; the operator's seat cannot flag")],
    ["CITIZENONLY", doc(flag, `a ${citizen}`)],
    ["RESIDENTONLY", doc(flag, `b ${resident}`)],
    ["OTHERROUTE", doc("/api/council/ballot", `a ${citizen}. b ${resident}`)],
    ["WRONGCASE", doc(flag, `a ${citizen.replace("intent", "Intent")}. b ${resident}`)],
    ["NOROUTES", JSON.stringify({ routes: [] })],
  ];
  const r = runPs([
    ...PS_DEFS,
    ...cases.map(([name, json]) => `Write-Output ('${name}=' + (Test-SurfaceCarriesFlagBinding ${ps(json)}))`),
    "Write-Output ('JUNK=' + (Test-SurfaceCarriesFlagBinding 'not json'))",
  ]);
  if (!r) return t.skip("powershell is not available on this machine");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /NEW=True/);
  for (const name of ["OLD", "CITIZENONLY", "RESIDENTONLY", "OTHERROUTE", "WRONGCASE", "NOROUTES", "JUNK"]) assert.match(r.out, new RegExp(`${name}=False`), name);
});

test("the reviewed-source check stops when HEAD does not contain the reviewed commit or a path outside the allowlist changed (the placeholder stop lives in step 0a)", (t) => {
  if (!definitions(t)) return;
  assert.equal(/still holds the placeholder/.test(reviewedBlock), false, "the placeholder stop lives in the pin block now, before any git command");
  const run = (changed: string[]) =>
    runPs([
      ...PS_DEFS,
      "$REVIEWED_COMMIT = '0123456789abcdef0123456789abcdef01234567'",
      "$headSha = 'fedcba9876543210fedcba9876543210fedcba98'",
      "function git { $global:LASTEXITCODE = 0; if ($args -contains '--name-only') { return @('" + changed.join("','") + "') } }",
      reviewedBlock,
      "Write-Output 'PAST-REVIEW'",
    ]);
  const clean = run(["scripts/deploy-council-flag.ps1", "docs/CHECKPOINT-COUNCIL-FLAG.md"]);
  if (!clean) return t.skip("powershell is not available on this machine");
  assert.match(clean.out, /PAST-REVIEW/, clean.out);
  const dirty = run(["src/resident.ts"]);
  assert.equal(dirty!.code, 1);
  assert.match(dirty!.out, /not on the allowlist/);
  assert.equal(/PAST-REVIEW/.test(dirty!.out), false);
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
  assert.ok(docTs.slice(end + 1).includes("showhomeDoorNote"), "and the door notes lie AFTER it");
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
    "$bad = @(Get-DisallowedPaths @('scripts/deploy-council-flag.ps1', 'test/deploy-council-flag-script.test.ts', 'docs/CHECKPOINT-COUNCIL-FLAG.md', 'src/resident.ts', 'migrations/0022_x.sql', 'docs', 'Docs/x.md', 'scripts/deploy-hardening.ps1'))",
    "Write-Output ('BAD=' + ($bad -join ','))",
    "$tail = \"tests 10`r`nsuites 0`r`npass 9`r`nfail 0`r`ncancelled 0`r`nskipped 1`r`ntodo 0`r`nduration_ms 12.5`r`n\"",
    "$s = Get-TestSummary $tail",
    "Write-Output ('SUMMARY=' + $s.Pass + '/' + $s.Fail + '/' + $s.SumOk)",
    "$notEnd = Get-TestSummary ($tail + 'trailing failure detail')",
    "Write-Output ('NOTEND=' + ($null -eq $notEnd))",
  ]);
  if (!r) return t.skip("powershell is not available on this machine");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /BAD=src\/resident\.ts,migrations\/0022_x\.sql,docs,Docs\/x\.md,scripts\/deploy-hardening\.ps1/, "src/, migrations/, a docs look-alike and another deploy script are not on the allowlist");
  assert.match(r.out, /SUMMARY=9\/0\/True/);
  assert.match(r.out, /NOTEND=True/);
});

// ---------- the things the script waits for and rides are really served by the new code ----------

test("the poll target and the ride are real (in-process, no network): every phrase the script waits for and rides is served by the new code, read from the script's own pins; the unbound POST is refused 401 naming resident_council_flag and moves the motions total not at all; /skill.md is 1.4.2", async () => {
  const c = await councilCast();
  try {
    const pin = (name: string): string => new RegExp(`^\\$${name} = "(.*)"$`, "m").exec(script)![1]!;
    const env = c.env;
    const motionsBefore = ((await call(env, "GET", "/api/council")).body as any).motions.total;

    // the poll target: GET /api/surface, the flag route, both phrases, no {token}, "no token is read"
    const surface = (await call(env, "GET", "/api/surface")).body as any;
    const route = surface.routes.find((r: any) => r.path === pin("FLAG_ROUTE_PATH"));
    assert.ok(route, "the flag route is served");
    assert.ok(String(route.note).includes(pin("SURFACE_CITIZEN_PHRASE")));
    assert.ok(String(route.note).includes(pin("SURFACE_RESIDENT_PHRASE")));
    assert.ok(String(route.note).includes("no token is read"));
    assert.equal(String(route.note).includes("{token}"), false);

    // /llms.txt
    const llms = (await call(env, "GET", "/llms.txt")).body._text as string;
    assert.ok(llms.includes(pin("CREDENTIAL_PHRASE")), "/llms.txt carries the credential sentence");

    // the MCP manifest
    const manifest = JSON.stringify((await call(env, "GET", "/.well-known/mcp.json")).body);
    assert.ok(manifest.includes(pin("MCP_MANIFEST_PHRASE")), "the manifest carries the line");

    // the earlier waves
    const official = (await call(env, "GET", "/api/official")).body;
    assert.ok("rule7_revote" in official);
    const councilText = JSON.stringify((await call(env, "GET", "/api/council")).body);
    assert.equal(councilText.includes("record_body"), false);
    assert.ok(councilText.includes("a flag is one-way and public"));

    // the one POST: no Authorization, no body fields, a motion that does not exist
    const unbound = await call(env, "POST", new URL(pin("UNBOUND_FLAG_URL").replace("$BASE", "https://x.test")).pathname, {}, { "CF-Connecting-IP": "203.0.113.9" });
    assert.equal(unbound.status, 401);
    assert.equal(unbound.body.code, "council_flag_unbound");
    assert.ok(JSON.stringify(unbound.body).includes("resident_council_flag"));
    assert.equal(((await call(env, "GET", "/api/council")).body as any).motions.total, motionsBefore, "the motions total did not move");
    assert.equal(rows(c.d1, "SELECT * FROM resident_nonces").length + rows(c.d1, "SELECT * FROM auth_nonces").length, 0, "and no nonce was spent");
    assert.equal(rows(c.d1, "SELECT * FROM council_ballots").length, 0);

    // /skill.md
    const skill = (await call(env, "GET", "/skill.md")).body._text as string;
    assert.equal(pin("SKILL_VERSION_LINE"), `version: ${SKILL_VERSION}`, "the script's marker is the version this checkout serves");
    assert.match(skill, new RegExp("^" + pin("SKILL_VERSION_LINE").replace(/\./g, "\\.") + "$", "m"));
    for (const p of ["SKILL_FLAG_PHRASE", "SKILL_RESIDENT_PHRASE", "CREDENTIAL_PHRASE"]) assert.ok(skill.includes(pin(p)), `/skill.md carries ${p}`);
  } finally {
    c.d1.close();
  }
});

test("the flag binding phrases appear in no earlier deploy script (the earlier scripts are the records of earlier waves)", () => {
  for (const name of ["deploy-hardening.ps1", "deploy-council.ps1", "deploy-rulings-wave.ps1"]) {
    const other = readFileSync(here(`../scripts/${name}`), "utf8");
    assert.equal(other.includes("intent binding 'council_flag' over"), false, `${name} does not mention the flag binding`);
  }
});

test("the other deploy scripts are untouched: this wave adds one script and edits no existing scripts/deploy-* file", () => {
  const council = readFileSync(here("../scripts/deploy-council.ps1"), "utf8");
  assert.match(council, /^\$SKILL_VERSION_LINE = "version: 1\.4\.0"$/m, "the council's script still marks the skill version it deployed");
  assert.match(council, /^\$LIVE_BASE_COMMIT = "3ac2928976e2a3627207ed4c1d1b834ac5a5968a"$/m, "and its live base");
  const rulings = readFileSync(here("../scripts/deploy-rulings-wave.ps1"), "utf8");
  assert.match(rulings, /^\$LIVE_BASE_COMMIT = "fded8bc0cc9987063a9fe1f7114492bc62e19bd9"$/m, "and the rulings wave's script its own");
  const hardening = readFileSync(here("../scripts/deploy-hardening.ps1"), "utf8");
  assert.match(hardening, /^\$LIVE_BASE_COMMIT = "763f6666741a83aabd41ec5f0b917cd33d722a8d"$/m, "and the hardening script its own");
  assert.match(hardening, /^\$SKILL_VERSION_LINE = "version: 1\.4\.1"$/m, "with the skill version it deployed");
});
