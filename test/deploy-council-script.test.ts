// scripts/deploy-council.ps1 is WRITTEN AND NEVER RUN by the builder (hard rule: no deploy, no wrangler command against anything remote, not even -DryRun, which reads the remote D1).
// It is proven here by everything that can be proven without running it: it parses under PowerShell's own parser, it is ASCII, it has none of the traps the repo's L-080 family names, its
// steps are in the load-bearing order (the two pins FIRST, fetch, pin, template check, reviewed source, gates, probes, dry-run exit, migration to the remote D1, the catalogue read, deploy,
// version id, poll, attest, ride), its catalogue lists are the migration's and schema.sql's, the catalogue check really stops on a missing column, a wrong order, a wrong key, a missing
// UNIQUE(platform, external_account_id), a missing index or a foreign key, the template extractor sees a byte inside FRONT_DOOR_TEMPLATE and ignores one outside it, step 0 stops on EITHER
// placeholder before any git or remote command, and the ride makes no live write except the door counts its own GETs add (CA6: /skill.md is fetched ONCE). Every one of these fails when
// the script is mutated (docs/CHECKPOINT-COUNCIL.md). The pattern is test/deploy-residents-script.test.ts; the differences are the council's.
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
import { councilCast, call } from "./helpers/council.ts";
import { SKILL_VERSION } from "../src/inbox.ts";
import { citizenRule } from "../src/council.ts";

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
const SCRIPT_PATH = here("../scripts/deploy-council.ps1");
const script = readFileSync(SCRIPT_PATH, "utf8").replace(/\r\n/g, "\n");
const norm = (s: string) => s.replace(/\r\n/g, "\n");
const migration = norm(readFileSync(here("../migrations/0021_council.sql"), "utf8"));
const schema = norm(readFileSync(here("../schema.sql"), "utf8"));
const docTs = readFileSync(here("../src/doc.ts"), "utf8");
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
  const dir = mkdtempSync(join(tmpdir(), "deploy-council-"));
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

test("no PowerShell traps: no two variables differing only by case ($COLS/$cols), no `$var:` drive reference, no stderr merged outside a Continue block, no -notmatch over a pipeline, no -and mixed with -or on one line", () => {
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

test("parameters: -ExpectedCommit is mandatory; -DryRun and -MigrationAlreadyApplied exist", () => {
  assert.match(script, /\[Parameter\(Mandatory = \$true\)\]\[string\]\$ExpectedCommit/);
  assert.match(script, /\[switch\]\$DryRun/);
  assert.match(script, /\[switch\]\$MigrationAlreadyApplied/);
});

test("the pins: the v5 hash, the live base (the commit the council was built on), the reviewed commit (the hub's placeholder or a full 40-hex sha) and the allowlist are exactly the commission's", () => {
  assert.match(script, /^\$V5_HASH = "fa11788d062b0c6d23c54c428c1c9649d263ae3ba704e602e122066926049491"$/m);
  assert.match(script, /^\$LIVE_BASE_COMMIT = "3ac2928976e2a3627207ed4c1d1b834ac5a5968a"$/m, "the live base is waves a and b's deployed commit, the commit this wave is built on");
  // Before the merge the builder leaves the reviewed placeholder; after it the hub sets the full sha (40 lower-case hex). Either is a valid committed state; anything else is not.
  assert.match(script, /^\$REVIEWED_COMMIT = "(?:TO-BE-SET-BY-HUB|[0-9a-f]{40})"$/m, "the reviewed commit is the hub's placeholder or a full 40-hex sha");
  assert.match(script, /^\$LIVE_BASE_PLACEHOLDER = "TO-BE-SET-BY-HUB-LIVE-BASE"$/m);
  assert.match(script, /^\$REVIEWED_COMMIT_PLACEHOLDER = "TO-BE-SET-BY-HUB"$/m);
  const allowed = /\$ALLOWED_PATHS_AFTER_REVIEW = @\(([^)]*)\)/.exec(code)?.[1] ?? "";
  assert.deepEqual([...allowed.matchAll(/"([^"]+)"/g)].map((m) => m[1]), ["scripts/deploy-council.ps1", "test/deploy-council-script.test.ts", "docs/"]);
  assert.equal([...code.matchAll(/\$ALLOWED_PATHS_AFTER_REVIEW = /g)].length, 1, "stated once");
  assert.match(code, /\$ROLLBACK_LINE = .*\$rollbackTarget/, "the rollback line names the version read from the live worker");
  assert.equal(/\$ROLLBACK_WORKER_VERSION/.test(code), false, "no typed-in rollback version: it is read live, before the deploy");
});

test("A7: step 0a STOPS before ANY git, npm, wrangler or network command while EITHER pin is its placeholder (or is not 40 lower-case hex); it is the first thing after the definitions", (t) => {
  assert.ok(pinBlock.length > 300, "the pin block exists");
  assert.ok(at("$LIVE_BASE_COMMIT -ceq $LIVE_BASE_PLACEHOLDER") < at("git fetch origin --quiet"), "the live-base pin is checked before the fetch");
  assert.ok(at("$REVIEWED_COMMIT -ceq $REVIEWED_COMMIT_PLACEHOLDER") < at("git fetch origin --quiet"), "the reviewed pin is checked before the fetch");
  assert.ok(at("$LIVE_BASE_COMMIT -cnotmatch") < at("git merge-base --is-ancestor $LIVE_BASE_COMMIT HEAD"), "a malformed live base can never reach git merge-base");
  for (const forbidden of ["git ", "npm ", "npx ", "curl.exe", "Invoke-D1Read", "Get-Text", "Read-Attest"]) {
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

test("the steps are in the load-bearing order: pins, fetch, branch, clean tree, ancestry, template check, migration check, reviewed source, gates, probes (live base proved), (dry-run exit), migration to the REMOTE D1, the catalogue read, deploy, version id, poll, attest, ride", () => {
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
    "--name-status --no-renames $LIVE_BASE_COMMIT HEAD -- migrations",
    "git merge-base --is-ancestor $REVIEWED_COMMIT HEAD",
    "Get-DisallowedPaths $afterReview",
    "$testOut = (npm test",
    "$attBefore = Read-Attest",
    "[string]$attBefore.code.commit -cne $LIVE_BASE_COMMIT",
    "$routeBefore = Get-Text",
    "name IN ('guest_thread'",
    "$residentColumns = @(Invoke-D1Read",
    "$tableRows = @(Invoke-D1Read",
    "if ($DryRun) {",
    "d1 execute commonhold --remote --file $migrationPath",
    "Assert-CouncilSchema\n",
    "$deployOut = (npx wrangler deploy",
    "Current Version ID",
    "Wait-NewWorker $headSha",
    "Assert-Attest $attAfter",
    "$council = Get-Json",
    "$list = Post-Json",
  ];
  const body = code.slice(code.indexOf('if ($LIVE_BASE_COMMIT -ceq $LIVE_BASE_PLACEHOLDER)'));
  let last = -1;
  for (const needle of order) {
    const i = body.indexOf(needle, last + 1);
    assert.ok(i > last, `"${needle}" must come after the previous step (found at ${i}, previous at ${last})`);
    last = i;
  }
  const dryExit = body.indexOf("exit 0", body.indexOf("if ($DryRun) {"));
  assert.ok(dryExit > 0 && dryExit < body.indexOf("d1 execute commonhold --remote --file"), "-DryRun exits before the migration");
  assert.ok(dryExit < body.indexOf("$deployOut = (npx wrangler deploy"), "-DryRun exits before the deploy");
  assert.equal(code.split("d1 execute commonhold --remote --file").length - 1, 1, "one remote migration apply");
  assert.equal(code.split("$deployOut = (npx wrangler deploy").length - 1, 1, "one deploy");
  assert.ok(body.indexOf('Stop-Here "migration 0021 failed') < body.indexOf("$deployOut = (npx wrangler deploy"), "a failed migration stops before the deploy");
  assert.ok(body.indexOf("Assert-CouncilSchema\n", body.indexOf("d1 execute commonhold --remote --file")) < body.indexOf("$deployOut = (npx wrangler deploy"), "the catalogue is read BEFORE the worker deploys");
});

test("wrangler is used for exactly three things: D1 reads, the one migration apply, and the one stamped deploy; never rollback, secret, delete, tail or a second deploy", () => {
  const calls = [...code.matchAll(/^\s*(?:\$\w+ = \()?npx wrangler ([a-z0-9]+)(?: ([a-z0-9]+))?/gm)].map((m) => `${m[1]}${m[2] ? " " + m[2] : ""}`);
  assert.ok(calls.length >= 3, `sanity: the scan found the d1 reads, the migration apply and the deploy, not ${calls.length}`);
  const seen = new Set(calls.map((c) => (c.startsWith("deploy") ? "deploy --var" : c)));
  for (const c of seen) assert.ok(c === "d1 execute" || c === "deploy --var" || c === "deploy", `unexpected wrangler subcommand: ${c}`);
  assert.equal(/npx wrangler (rollback|secret|delete|tail|versions|kv|r2|queues)/.test(code.replace(/\$ROLLBACK_LINE = "[^"]*"/, "")), false, "no other wrangler subcommand is ever executed (the rollback is only text for Ben)");
  assert.match(code, /npx wrangler deploy --var "CODE_COMMIT:\$headSha"/, "the deploy stamps the pinned full sha (served code identity)");
  assert.equal([...code.matchAll(/^\s*\$deployOut = \(npx wrangler deploy --var/gm)].length, 1, "one executed deploy line carries the stamp");
  assert.equal(/Invoke-D1Read\s+"(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)/i.test(code), false, "every D1 command with --command is a read");
  assert.equal(/--command[^\n]*\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b/i.test(code), false);
});

test("no SQL handed to wrangler contains a double quote (PowerShell 5.1 does not escape an embedded one in a native argument, so the argument splits): every Invoke-D1Read call is single-quoted SQL inside double-quoted strings", () => {
  const reads = code.split("\n").filter((l) => /Invoke-D1Read\s+[("]/.test(l));
  assert.ok(reads.length >= 10, `sanity: the scan found the catalogue reads, not ${reads.length}`);
  for (const l of reads) {
    assert.equal(/`"/.test(l), false, `an escaped double quote inside SQL: ${l.trim().slice(0, 120)}`);
    for (const m of l.matchAll(/"((?:[^"`]|`[^"])*)"/g)) assert.equal(/SELECT/i.test(m[1]!) && /[^'\w]"/.test(m[1]!), false, `a stray quote in SQL: ${l.trim().slice(0, 120)}`);
  }
  // positive control: the check can fail on the shape that was there before in another wave (the real query it replaced)
  assert.equal(/`"/.test('$idx = @(Invoke-D1Read "SELECT name, `"unique`" AS is_unique FROM pragma_index_list(\'guests\')")'), true);
  assert.match(code, /\$row\.unique/, "and the unique flag is read by its own column name from SELECT *");
});

test("the ride makes NO live write except the door counts its own GETs add (CA6): /skill.md and /heartbeat.md are fetched ONCE each, the header and the log say so, no POST but the two read-only tools/list calls, and no key, token or assertion is ever built", () => {
  const posts = [...code.matchAll(/Post-Json "[^"]+" '([^']*)'/g)].map((m) => m[1]!);
  assert.ok(posts.length === 2, "exactly two POSTs: the two tools/list calls");
  for (const p of posts) assert.match(p, /"method":"tools\/list"/, "each POST is a tools/list");
  assert.equal(
    /tools\/call|"initialize"|guest_enter"?\s*,\s*"arguments|showhome\/enter|api\/resident\/(bind|token)"|api\/council\/(challenge|claim|motion|ballot)"|--data-binary[^\n]*assertion|ch1\./.test(code.replace(/\$list\.Body\.Contains[^\n]*/g, "")),
    false,
    "nothing in the executed code writes",
  );
  assert.match(script, /THE RIDE MAKES NO LIVE WRITE EXCEPT THE DOOR COUNTS ITS OWN GETS ADD/, "the header says what the ride writes");
  assert.match(code, /No live write was made except the door counts the ride's own GETs add/, "and so does the log");
  assert.match(code, /counted GET \/skill\.md and GET \/heartbeat\.md once each/);
  // fetched once: the path is in the public-reads list exactly once, its response is kept from that loop, and no second GET names it
  const listLine = code.split("\n").find((l) => /^foreach \(\$p in "\/", /.test(l)) ?? "";
  assert.ok(listLine.length > 0, "the public-reads loop exists");
  const listed = [...listLine.matchAll(/"(\/[^"]*)"/g)].map((m) => m[1]!);
  assert.equal(listed.filter((p) => p === "/skill.md").length, 1, "/skill.md is in the list once");
  assert.equal(listed.filter((p) => p === "/heartbeat.md").length, 1, "/heartbeat.md is in the list once");
  assert.equal(new Set(listed).size, listed.length, "and no path is read twice");
  assert.match(code, /if \(\$p -ceq "\/skill\.md"\) \{ \$skill = \$r \}/, "the skill body is read from the loop's own response");
  assert.equal(/Get-Text "\$BASE\/skill\.md"|Get-Json "\$BASE\/skill\.md"/.test(code), false, "no second GET of /skill.md");
  assert.equal(code.replace(listLine, "").includes('"/heartbeat.md"'), false, "and none of /heartbeat.md");
  assert.equal(listed.length, 15, "fifteen public reads, as the log says");
});

test("it stops unless main, origin/main and -ExpectedCommit are ONE commit, after a fetch, on a clean tree, and HEAD is 40 lower-case hex (the stamp)", () => {
  assert.match(code, /if \(\$branch -cne "main"\)/);
  assert.match(code, /\$mainSha -cne \$originSha -or \$mainSha -cne \$expectedSha -or \$headSha -cne \$expectedSha/);
  assert.match(code, /git status --porcelain/);
  assert.ok(at("git fetch origin --quiet") < at("git rev-parse origin/main"), "origin/main is read AFTER the fetch");
  assert.match(code, /\$headSha -cnotmatch '\^\[0-9a-f\]\{40\}\$'/);
});

test("non-minting: it compares FRONT_DOOR_TEMPLATE itself between the live base and HEAD (this wave does not touch src/doc.ts at all, but the proof is the template text, not the file), stops on a difference, and verifies v5 and every chain after the deploy", () => {
  assert.match(code, /if \(\$liveTemplate -cne \$headTemplate\) \{ Stop-Here/);
  assert.equal(/git diff --name-only \$LIVE_BASE_COMMIT HEAD -- src\/doc\.ts/.test(code), false, "no blanket 'doc.ts unmoved' check: the template text is the proof");
  assert.match(code, /\$migMoves\.Count -ne 1 -or \$migMoves\[0\] -cne \("A`t" \+ \$MIGRATION_PATH_EXPECTED\)/);
  assert.match(code, /^\$MIGRATION_PATH_EXPECTED = "migrations\/0021_council\.sql"$/m);
  assert.match(code, /\[string\]\$att\.constitution\.version -ne "5"/);
  assert.match(code, /\$att\.constitution\.template_hash -cne \$V5_HASH/);
  assert.match(code, /\$att\.ok -ne \$true/);
  for (const chain of ["identity_log", "treasury", "payouts", "ballots"]) assert.ok(code.includes(`"${chain}"`), `the ${chain} chain is checked`);
});

test("it proves the live worker IS the pinned base (code.commit equals $LIVE_BASE_COMMIT), reads the rollback target from it, refuses before the resident tier's tables and columns are on prod, and treats 0021 as absent, applied or half-applied (the last stops)", () => {
  assert.match(code, /\[string\]\$attBefore\.code\.commit -cne \$LIVE_BASE_COMMIT/);
  assert.match(code, /\$rollbackTarget = \[string\]\$attBefore\.code\.version_id/);
  assert.match(code, /name IN \('guest_thread', 'guests', 'resident_nonces', 'door_counts', 'showhome_rate'\)/);
  assert.match(code, /\$prereqRows\.Count -ne 5\) \{ Stop-Here/);
  assert.match(code, /pragma_table_info\('guests'\) WHERE name IN \('public_key', 'resident_at'\)/);
  assert.match(code, /\$residentColumns\.Count -ne 2\) \{ Stop-Here/);
  assert.ok(at("name IN ('guest_thread'") < at("if ($DryRun) {"), "the prerequisite is checked even on a dry run");
  assert.match(code, /\$tablesPresent -eq 0\) \{ \$migrationState = "absent" \}/);
  assert.match(code, /\$tablesPresent -eq 5\) \{ \$migrationState = "applied" \}/);
  assert.match(code, /else \{ Stop-Here \("migration 0021 is half-applied on prod/);
  assert.match(code, /\$migrationState -ceq "applied" -and -not \$MigrationAlreadyApplied\) \{ Stop-Here/);
  assert.match(code, /\$migrationState -ceq "absent" -and \$MigrationAlreadyApplied\) \{ Stop-Here/);
  assert.match(code, /if \(-not \$MigrationAlreadyApplied\) \{[\s\S]*d1 execute commonhold --remote --file/, "the apply is skipped only under the flag");
});

test("the only pre-deploy probe of live code is that the new route is ABSENT (404), which is what makes the later poll mean something; the poll needs the stamped commit AND the printed version id AND the route", () => {
  assert.match(code, /^\$NEW_CODE_URL = "\$BASE\/api\/council"$/m);
  assert.match(code, /if \(\$routeBefore\.Code -eq "200"\) \{ Stop-Here/);
  assert.match(code, /if \(\$routeBefore\.Code -ne "404"\) \{ Stop-Here/);
  assert.match(code, /Current Version ID:/);
  assert.match(code, /\$versionMatches\.Count -gt 1\) \{ Stop-Here/);
  assert.match(code, /\$versionMatches\.Count -lt 1\) \{ Stop-Here/);
  assert.match(code, /\$code\.commit -cne \$commit/);
  assert.match(code, /\$code\.version_id\)\.ToLowerInvariant\(\) -cne/);
  assert.match(code, /\$route\.Code -eq "200"/, "the poll also waits for GET /api/council to answer 200");
});

// ---------- the catalogue lists are the migration's and schema.sql's ----------

interface ParsedTable {
  columns: string[];
  pk: string[];
  uniqueKeys: string[];
}
function parseTable(sql: string, table: string): ParsedTable {
  const body = new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`).exec(sql)?.[1] ?? "";
  assert.ok(body.length > 0, `${table} is defined`);
  const lines = body.split("\n");
  const columns = lines.map((l) => /^\s{2}([a-z0-9_]+)\s+(TEXT|INTEGER)\b/.exec(l)?.[1]).filter((c): c is string => !!c);
  const tablePk = /^\s{2}PRIMARY KEY \(([^)]*)\)/m.exec(body);
  const pk = tablePk ? tablePk[1]!.split(",").map((s) => s.trim()) : lines.map((l) => /^\s{2}([a-z0-9_]+)\s+(?:TEXT|INTEGER)\s+PRIMARY KEY\b/.exec(l)?.[1]).filter((c): c is string => !!c);
  const inlineUnique = lines.map((l) => /^\s{2}([a-z0-9_]+)\s+(?:TEXT|INTEGER)\s+NOT NULL UNIQUE\b/.exec(l)?.[1]).filter((c): c is string => !!c);
  const tableUnique = [...body.matchAll(/^\s{2}UNIQUE \(([^)]*)\)/gm)].map((m) => m[1]!.split(",").map((s) => s.trim()).join(","));
  return { columns, pk, uniqueKeys: [...inlineUnique, ...tableUnique] };
}
const TABLES = ["council_challenges", "council_claims", "council_thread", "council_motions", "council_ballots"] as const;
const LISTS: Record<(typeof TABLES)[number], [string, string]> = {
  council_challenges: ["CHALLENGES_COLUMNS", "CHALLENGES_KEY"],
  council_claims: ["CLAIMS_COLUMNS", "CLAIMS_KEY"],
  council_thread: ["THREAD_COLUMNS", "THREAD_KEY"],
  council_motions: ["MOTIONS_COLUMNS", "MOTIONS_KEY"],
  council_ballots: ["BALLOTS_COLUMNS", "BALLOTS_KEY"],
};
const listed = (name: string) => [...(new RegExp(`\\$${name} = @\\(([^)]*)\\)`).exec(script)?.[1] ?? "").matchAll(/"([A-Za-z0-9_,:]+)"/g)].map((m) => m[1]!);

test("the catalogue lists are the migration's and schema.sql's: each table's columns in order and its primary key, council_claims' two UNIQUE keys, and the four index names with their tables, each stated once", () => {
  assert.deepEqual(listed("COUNCIL_TABLES"), [...TABLES]);
  for (const table of TABLES) {
    const [colList, keyList] = LISTS[table];
    const m = parseTable(migration, table);
    const s = parseTable(schema, table);
    assert.deepEqual(listed(colList), m.columns, `${table}: the script's columns are the migration's, in order`);
    assert.deepEqual(listed(colList), s.columns, `${table}: and schema.sql's`);
    assert.deepEqual(listed(keyList), m.pk, `${table}: the script's primary key is the migration's`);
    assert.deepEqual(m.pk, s.pk);
    assert.equal([...script.matchAll(new RegExp(`^\\$${colList} = `, "gm"))].length, 1, `${colList} is stated once`);
  }
  assert.deepEqual(parseTable(migration, "council_claims").uniqueKeys.sort(), ["platform,external_account_id", "visitor_id"], "the migration declares exactly the two UNIQUE keys");
  assert.deepEqual([...listed("CLAIMS_UNIQUE_KEYS")].sort(), ["platform,external_account_id", "visitor_id"], "and the script verifies exactly those two");
  for (const t of ["council_challenges", "council_thread", "council_motions", "council_ballots"] as const) assert.deepEqual(parseTable(migration, t).uniqueKeys, [], `${t} has no UNIQUE key beyond its primary key`);
  const indexes = (sql: string) => [...sql.matchAll(/CREATE INDEX IF NOT EXISTS ([a-z_]+) ON ([a-z_]+)\(/g)].map((m) => `${m[1]}:${m[2]}`).filter((x) => /council_/.test(x));
  assert.deepEqual(listed("COUNCIL_INDEXES"), indexes(migration), "the script's indexes are the migration's");
  assert.deepEqual(indexes(schema), indexes(migration), "and schema.sql's");
  assert.ok(migration.includes("CHECK (length(record_body) <= 2000)") && code.includes("length(record_body) <= 2000"), "the 2000 character CHECK is in the migration and in the catalogue check");
  assert.ok(!parseTable(migration, "council_motions").columns.includes("concerns_operator"), "CA10: no concerns_operator column");
  for (const flagCol of ["operator_flagged_at", "operator_flagged_by_kind", "operator_flagged_by_id"]) assert.ok(listed("MOTIONS_COLUMNS").includes(flagCol), `CA11: the catalogue lists ${flagCol}`);
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

test("Assert-CouncilSchema (run for real against a stand-in for the remote read, built from the REAL migration): the right catalogue passes; a missing column, a wrong order, a wrong primary key, a missing or extra UNIQUE key, a missing CHECK, a missing index and a foreign key each STOP", (t) => {
  if (!definitions(t)) return;
  type Row = { cid: number; name: string; type: string; pk: number };
  const infoFor = (table: (typeof TABLES)[number]): Row[] => {
    const p = parseTable(migration, table);
    return p.columns.map((name, cid) => ({ cid, name, type: "TEXT", pk: p.pk.includes(name) ? p.pk.indexOf(name) + 1 : 0 }));
  };
  const tables = Object.fromEntries(TABLES.map((tb) => [tb, infoFor(tb)])) as Record<(typeof TABLES)[number], Row[]>;
  const good = {
    tables,
    claimsIndexes: [
      { name: "sqlite_autoindex_council_claims_1", unique: 1 },
      { name: "sqlite_autoindex_council_claims_2", unique: 1 },
    ],
    indexInfo: { sqlite_autoindex_council_claims_1: [{ name: "visitor_id" }], sqlite_autoindex_council_claims_2: [{ name: "platform" }, { name: "external_account_id" }] } as Record<string, Array<{ name: string }>>,
    claimsSql: "CREATE TABLE council_claims (... record_body TEXT NOT NULL CHECK (length(record_body) <= 2000) ...)",
    missingIndexes: [] as string[],
    fk: { council_challenges: 0, council_claims: 0, council_thread: 0, council_motions: 0, council_ballots: 0 } as Record<string, number>,
  };
  const run = (over: Partial<typeof good>) =>
    runPs(
      [
        ...PS_DEFS,
        "$cfg = Get-Content -Raw -Encoding UTF8 '@DIR@\\cfg.json' | ConvertFrom-Json",
        "function Invoke-D1Read($sql) {",
        "  foreach ($t in 'council_challenges', 'council_claims', 'council_thread', 'council_motions', 'council_ballots') {",
        "    if ($sql -like ('*pragma_table_info(''' + $t + ''')*')) { return @($cfg.tables.$t) }",
        "    if ($sql -like ('*pragma_foreign_key_list(''' + $t + ''')*')) { return @(@{ n = $cfg.fk.$t }) }",
        "  }",
        "  if ($sql -like '*pragma_index_list(''council_claims'')*') { return @($cfg.claimsIndexes) }",
        "  if ($sql -like '*pragma_index_info(*') { $n = [regex]::Match($sql, 'pragma_index_info\\(''([^'']+)''\\)').Groups[1].Value; return @($cfg.indexInfo.$n) }",
        "  if ($sql -like '*SELECT sql FROM sqlite_master*council_claims*') { return @(@{ sql = $cfg.claimsSql }) }",
        "  if ($sql -like '*type = ''index'' AND name = *') { $n = [regex]::Match($sql, 'name = ''([^'']+)''').Groups[1].Value; if (@($cfg.missingIndexes) -contains $n) { return @() } else { return @(@{ name = $n }) } }",
        "  throw ('unexpected read: ' + $sql)",
        "}",
        "Assert-CouncilSchema",
        "Write-Output 'CATALOGUE-OK'",
      ],
      { "cfg.json": JSON.stringify({ ...good, ...over }) },
    );
  const ok = run({});
  if (!ok) return t.skip("powershell is not available on this machine");
  assert.match(ok.out, /CATALOGUE-OK/, ok.out);
  assert.equal(ok.code, 0);
  const without = (table: (typeof TABLES)[number], name: string) => ({ ...tables, [table]: tables[table].filter((c) => c.name !== name) });
  const swapped = (table: (typeof TABLES)[number], a: number, b: number) => {
    const copy = tables[table].map((c) => ({ ...c }));
    [copy[a]!.name, copy[b]!.name] = [copy[b]!.name, copy[a]!.name];
    return { ...tables, [table]: copy };
  };
  const stops: Array<[string, ReturnType<typeof run>, RegExp]> = [
    ["a missing column on council_motions (a flag column)", run({ tables: without("council_motions", "operator_flagged_by_id") }), /council_motions has 12 columns, expected 13/],
    ["a stray concerns_operator column (CA10 dropped it)", run({ tables: { ...tables, council_motions: [...tables.council_motions, { cid: 13, name: "concerns_operator", type: "INTEGER", pk: 0 }] } }), /council_motions has 14 columns, expected 13/],
    ["a wrong column order on council_claims", run({ tables: swapped("council_claims", 2, 3) }), /council_claims column 2 is 'external_account_id', expected 'platform'/],
    ["a missing column on council_thread", run({ tables: without("council_thread", "parent_id") }), /council_thread has 6 columns, expected 7/],
    ["a wrong primary key on council_ballots (the member kind is out of the key)", run({ tables: { ...tables, council_ballots: tables.council_ballots.map((c) => (c.name === "member_kind" ? { ...c, pk: 0 } : c)) } }), /council_ballots primary key is \(motion_id, member_id\), expected \(motion_id, member_kind, member_id\)/],
    ["a wrong primary key on council_challenges", run({ tables: { ...tables, council_challenges: tables.council_challenges.map((c) => (c.name === "nonce" ? { ...c, pk: 0 } : c)) } }), /council_challenges primary key is \(\), expected \(nonce\)/],
    ["no UNIQUE(platform, external_account_id)", run({ claimsIndexes: [{ name: "sqlite_autoindex_council_claims_1", unique: 1 }] }), /council_claims has no UNIQUE key on \(platform,external_account_id\)/],
    ["no UNIQUE(visitor_id)", run({ claimsIndexes: [{ name: "sqlite_autoindex_council_claims_2", unique: 1 }] }), /council_claims has no UNIQUE key on \(visitor_id\)/],
    ["a UNIQUE key that is not unique (the flag is 0)", run({ claimsIndexes: [{ name: "sqlite_autoindex_council_claims_1", unique: 1 }, { name: "sqlite_autoindex_council_claims_2", unique: 0 }] }), /council_claims has no UNIQUE key on \(platform,external_account_id\)/],
    ["a third UNIQUE key", run({ claimsIndexes: [...good.claimsIndexes, { name: "sqlite_autoindex_council_claims_3", unique: 1 }], indexInfo: { ...good.indexInfo, sqlite_autoindex_council_claims_3: [{ name: "record_id" }] } }), /council_claims has 3 UNIQUE keys, expected 2/],
    ["the pair in the wrong order", run({ indexInfo: { ...good.indexInfo, sqlite_autoindex_council_claims_2: [{ name: "external_account_id" }, { name: "platform" }] } }), /council_claims has no UNIQUE key on \(platform,external_account_id\)/],
    ["no 2000 character CHECK", run({ claimsSql: "CREATE TABLE council_claims (record_body TEXT NOT NULL)" }), /does not CHECK the stored record body to 2000 characters/],
    ["a missing index", run({ missingIndexes: ["idx_council_motions_proposer"] }), /the index idx_council_motions_proposer on council_motions is missing/],
    ["a foreign key on council_thread", run({ fk: { ...good.fk, council_thread: 1 } }), /council_thread carries a foreign key/],
    ["a foreign key on council_claims", run({ fk: { ...good.fk, council_claims: 2 } }), /council_claims carries a foreign key/],
  ];
  for (const [label, r, pattern] of stops) {
    assert.ok(r, label);
    assert.equal(r.code, 1, `${label}: the script must exit 1, got ${r.code}: ${r.out}`);
    assert.match(r.out, /\[STOP\]/, label);
    assert.match(r.out, pattern, label);
    assert.equal(/CATALOGUE-OK/.test(r.out), false, `${label}: must not pass`);
  }
});

test("the reviewed-source check stops when HEAD does not contain the reviewed commit or a path outside the allowlist changed (the placeholder stop moved to step 0a)", (t) => {
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
  const clean = run(["scripts/deploy-council.ps1", "docs/CHECKPOINT-COUNCIL.md"]);
  if (!clean) return t.skip("powershell is not available on this machine");
  assert.match(clean.out, /PAST-REVIEW/, clean.out);
  const dirty = run(["src/council.ts"]);
  assert.equal(dirty!.code, 1);
  assert.match(dirty!.out, /not on the allowlist/);
  assert.equal(/PAST-REVIEW/.test(dirty!.out), false);
});

test("Get-TemplateText (run for real): it extracts FRONT_DOOR_TEMPLATE from the real src/doc.ts, a change OUTSIDE the template does not change it, a byte INSIDE it does, an escaped backtick does not end it, and a missing marker is null", (t) => {
  if (!definitions(t)) return;
  // the same extraction in TypeScript, from the committed file: the PowerShell function must return exactly this slice
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
  assert.notEqual(outsideEdit, doc, "the fixture edit outside the template really changed the file");
});

test("Get-DisallowedPaths and Get-TestSummary (run for real): only this script, its test and docs/ pass the allowlist; a summary that does not end the output is not read", (t) => {
  if (!definitions(t)) return;
  const r = runPs([
    ...PS_DEFS,
    "$bad = @(Get-DisallowedPaths @('scripts/deploy-council.ps1', 'test/deploy-council-script.test.ts', 'docs/CHECKPOINT-COUNCIL.md', 'src/council.ts', 'migrations/0021_council.sql', 'docs', 'Docs/x.md', 'scripts/deploy-residents.ps1'))",
    "Write-Output ('BAD=' + ($bad -join ','))",
    "$tail = \"tests 10`r`nsuites 0`r`npass 9`r`nfail 0`r`ncancelled 0`r`nskipped 1`r`ntodo 0`r`nduration_ms 12.5`r`n\"",
    "$s = Get-TestSummary $tail",
    "Write-Output ('SUMMARY=' + $s.Pass + '/' + $s.Fail + '/' + $s.SumOk)",
    "$notEnd = Get-TestSummary ($tail + 'trailing failure detail')",
    "Write-Output ('NOTEND=' + ($null -eq $notEnd))",
  ]);
  if (!r) return t.skip("powershell is not available on this machine");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /BAD=src\/council\.ts,migrations\/0021_council\.sql,docs,Docs\/x\.md,scripts\/deploy-residents\.ps1/, "src/, migrations/, a docs look-alike and another deploy script are not on the allowlist");
  assert.match(r.out, /SUMMARY=9\/0\/True/);
  assert.match(r.out, /NOTEND=True/);
});

// ---------- the things the script waits for and rides are really served by the new code ----------

test("the poll target and the ride are real (in-process, no network): GET /api/council answers 200 with its own shape (and a route the router does not know answers 404), /skill.md carries the version line and the section, ledger-watch and sisyphus are seated by rule, /api/official's council count equals the roster's and sits beside the composition, the room answers, tools/list lists the council tools on /mcp and only the read tool on /mcp/read", async () => {
  const marker = /\$SKILL_VERSION_LINE = "([^"]+)"/.exec(script)?.[1] ?? "";
  assert.equal(marker, `version: ${SKILL_VERSION}`, "the script's marker is the live skill version");
  assert.equal(marker, "version: 1.4.0");
  const c = await councilCast();
  try {
    const council = await call(c.env, "GET", "/api/council");
    assert.equal(council.status, 200);
    assert.ok(Array.isArray(council.body.members) && /^[0-9]+$/.test(String(council.body.counts.total)) && council.body.rules.self_paid.length > 0);
    assert.equal((await call(c.env, "GET", "/api/council-not-a-route")).status, 404, "the pre-deploy 404 is the router's own catch-all");
    const skill = (await call(c.env, "GET", "/skill.md")).body._text as string;
    assert.ok(skill.includes(marker) && skill.includes("## The council"));
    // the ride's expected members are what the rule gives today
    for (const want of listed("RIDE_MEMBERS")) {
      const [handle, rule] = want.split(":");
      assert.equal(citizenRule(handle!), rule, `${handle} is seated by rule ${rule}`);
      const seated = council.body.members.filter((m: { handle: string }) => m.handle === handle);
      assert.equal(seated.length, 1, `${handle} is listed once`);
      assert.equal(seated[0].rule, rule);
    }
    const official = (await call(c.env, "GET", "/api/official")).body;
    assert.equal(String(official.council.members), String(council.body.counts.total), "the two surfaces agree about one figure");
    assert.equal(Object.keys(official.composition).includes("council"), false, "and the council sits beside the composition, not in it");
    const thread = await call(c.env, "GET", "/api/council/thread");
    assert.equal(thread.status, 200);
    assert.ok(Array.isArray(thread.body.messages) && /^[0-9]+$/.test(String(thread.body.total)) && thread.body.note.length > 0);
    const list = JSON.stringify((await call(c.env, "POST", "/mcp", { jsonrpc: "2.0", id: 2, method: "tools/list" })).body);
    for (const tool of ["council", ...listed("COUNCIL_WRITE_TOOLS")]) assert.ok(list.includes(`"name":"${tool}"`), tool);
    const readList = JSON.stringify((await call(c.env, "POST", "/mcp/read", { jsonrpc: "2.0", id: 3, method: "tools/list" })).body);
    assert.ok(readList.includes('"name":"council"'), "the read door lists the read tool");
    for (const tool of listed("COUNCIL_WRITE_TOOLS")) assert.equal(readList.includes(`"name":"${tool}"`), false, `/mcp/read must not list ${tool}`);
    assert.deepEqual(listed("COUNCIL_WRITE_TOOLS"), ["council_challenge", "council_claim", "council_write", "council_motion", "council_ballot", "council_flag"], "CA11: all six write tools");
  } finally {
    c.d1.close();
  }
});

test("the other deploy scripts are untouched: the retired settle-honesty script still stops, wave a's script still marks 1.2.0, and wave b's script (the resident tier) still marks 1.3.0 with its own pins", () => {
  const old = readFileSync(here("../scripts/deploy-x402-settle-honesty.ps1"), "utf8");
  assert.match(old, /RETIRED: this script shipped wave B once and must not be reused/);
  const waveA = readFileSync(here("../scripts/deploy-mcp-guest-door.ps1"), "utf8");
  assert.match(waveA, /^\$SKILL_VERSION_LINE = "version: 1\.2\.0"$/m, "wave a's script still marks the skill version wave a deployed");
  const waveB = readFileSync(here("../scripts/deploy-residents.ps1"), "utf8");
  assert.match(waveB, /^\$SKILL_VERSION_LINE = "version: 1\.3\.0"$/m, "wave b's script still marks the skill version wave b deployed");
  assert.match(waveB, /^\$LIVE_BASE_COMMIT = "d266a3ae46aa2cb35e4ab7dabfebb4b1d95dccbe"$/m, "and its live base");
  assert.match(waveB, /^\$REVIEWED_COMMIT = "ae3a8ebcb54ca3db192e832fca318689b821ff20"$/m, "and its reviewed commit");
});
