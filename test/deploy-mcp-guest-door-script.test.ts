// scripts/deploy-mcp-guest-door.ps1 is WRITTEN AND NEVER RUN by the builder (hard rule: no deploy, no wrangler command against anything
// remote, not even -DryRun, which reads the remote D1). It is proven here by everything that can be proven without running it: it parses
// under PowerShell's own parser, it is ASCII, it has none of the traps the repo's L-080 family names, its steps are in the load-bearing
// order (fetch, pin, reviewed source, gates, probes, dry-run exit, migration to the remote D1 FIRST, the catalogue read of door_counts,
// deploy, version id, poll, attest, ride), its column list is the migration's and schema.sql's (THREE columns, the key (day, door)),
// the catalogue check really stops on a fourth column, a wrong order or a wrong key, and the things it waits for and rides are really
// served by the new code. Every one of these fails when the script is mutated (docs/CHECKPOINT-MCP-GUEST-DOOR.md).
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
import { createLocalD1, seedCitizens, guestEnv, call } from "./helpers/guest.ts";
import { SKILL_VERSION } from "../src/inbox.ts";

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
const SCRIPT_PATH = here("../scripts/deploy-mcp-guest-door.ps1");
const script = readFileSync(SCRIPT_PATH, "utf8").replace(/\r\n/g, "\n");
const norm = (s: string) => s.replace(/\r\n/g, "\n");
const migration = norm(readFileSync(here("../migrations/0019_door_counts.sql"), "utf8"));
const schema = norm(readFileSync(here("../schema.sql"), "utf8"));
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
const reviewedBlock = block("REVIEWED-SOURCE-CHECK");

type PsRun = { code: number | null; out: string };
// A PowerShell 5.1 harness. The .ps1 is written ASCII-only; data goes in files read with -Encoding UTF8.
function runPs(lines: string[], files: Record<string, string> = {}): PsRun | null {
  const dir = mkdtempSync(join(tmpdir(), "deploy-mgd-"));
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
  // -and and -or have EQUAL precedence in PowerShell (left to right): a line that mixes them without parentheses means something else than it reads
  // Checked group by group, innermost parentheses first: a group may hold -and or -or, never both.
  const mixed = (s: string) => /\s-and\s/.test(s) && /\s-or\s/.test(s);
  for (const line of code.split("\n")) {
    let rest = line.replace(/"[^"]*"|'[^']*'/g, '""');
    for (let guard = 0; guard < 50 && /\([^()]*\)/.test(rest); guard++) {
      for (const m of rest.matchAll(/\(([^()]*)\)/g)) assert.equal(mixed(m[1]!), false, `a group mixes -and with -or: ${line.trim().slice(0, 120)}`);
      rest = rest.replace(/\([^()]*\)/g, "X");
    }
    assert.equal(mixed(rest), false, `a line mixes -and with -or: ${line.trim().slice(0, 120)}`);
  }
  // positive control: the check can fail
  assert.equal(mixed("if ($a -eq 1 -and $b -or $c)"), true);
});

test("parameters: -ExpectedCommit is mandatory; -DryRun and -MigrationAlreadyApplied exist", () => {
  assert.match(script, /\[Parameter\(Mandatory = \$true\)\]\[string\]\$ExpectedCommit/);
  assert.match(script, /\[switch\]\$DryRun/);
  assert.match(script, /\[switch\]\$MigrationAlreadyApplied/);
});

test("the pins: the live base commit, the rollback worker version, the v5 hash, the placeholder and the allowlist are exactly the commission's", () => {
  assert.match(script, /^\$LIVE_BASE_COMMIT = "07e9c57d9339a7a8a8acf4b3f9c28674b6eccbd4"$/m);
  assert.match(script, /^\$ROLLBACK_WORKER_VERSION = "0ed544ae-5ec0-4301-8910-2bcf255caffe"$/m);
  assert.match(script, /^\$V5_HASH = "fa11788d062b0c6d23c54c428c1c9649d263ae3ba704e602e122066926049491"$/m);
  // Before the merge the builder leaves the placeholder; after it the hub sets the full sha (40 lower-case hex). Either is
  // a valid committed state; anything else (a short sha, upper case, a stray value) is not. Step 0 of the script itself
  // refuses to run on the placeholder.
  assert.match(script, /^\$REVIEWED_COMMIT = "(?:TO-BE-SET-BY-HUB|[0-9a-f]{40})"$/m, "the reviewed commit is the builder's placeholder or the hub's full 40-hex sha");
  assert.match(script, /^\$REVIEWED_COMMIT_PLACEHOLDER = "TO-BE-SET-BY-HUB"$/m);
  const allowed = /\$ALLOWED_PATHS_AFTER_REVIEW = @\(([^)]*)\)/.exec(code)?.[1] ?? "";
  assert.deepEqual([...allowed.matchAll(/"([^"]+)"/g)].map((m) => m[1]), ["scripts/deploy-mcp-guest-door.ps1", "test/deploy-mcp-guest-door-script.test.ts", "docs/"]);
  assert.equal([...code.matchAll(/\$ALLOWED_PATHS_AFTER_REVIEW = /g)].length, 1, "stated once");
  assert.match(code, /\$ROLLBACK_LINE = .*\$ROLLBACK_WORKER_VERSION/, "the rollback line names the pinned worker version");
});

test("the steps are in the load-bearing order: fetch, pin, no-mint and migration checks, reviewed source, gates, probes, (dry-run exit), migration to the REMOTE D1, the catalogue read, deploy, version id, poll, attest, ride", () => {
  const order = [
    "git fetch origin --quiet",
    "rev-parse --abbrev-ref HEAD",
    "origin/main",
    "git status --porcelain",
    "git merge-base --is-ancestor $LIVE_BASE_COMMIT HEAD",
    "-- src/doc.ts",
    "--name-status --no-renames $LIVE_BASE_COMMIT HEAD -- migrations",
    "$REVIEWED_COMMIT -ceq $REVIEWED_COMMIT_PLACEHOLDER",
    "git merge-base --is-ancestor $REVIEWED_COMMIT HEAD",
    "Get-DisallowedPaths $afterReview",
    "$testOut = (npm test",
    "$attBefore = Read-Attest",
    "$routeBefore = Get-Text",
    "name IN ('guest_thread'",
    "if ($DryRun) {",
    "d1 execute commonhold --remote --file $migrationPath",
    "Assert-DoorTable\n",
    "$deployOut = (npx wrangler deploy",
    "Current Version ID",
    "Wait-NewWorker $headSha",
    "Assert-Attest $attAfter",
    "$enter = Post-Json",
  ];
  // the first mention of `pragma_table_info` is inside Assert-DoorTable's definition; the order test starts the body at the definitions' end
  const body = code.slice(code.indexOf("git fetch origin --quiet"));
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
  assert.ok(body.indexOf('Stop-Here "migration 0019 failed') < body.indexOf("$deployOut = (npx wrangler deploy"), "a failed migration stops before the deploy");
  assert.ok(body.indexOf("Assert-DoorTable\n", body.indexOf("d1 execute commonhold --remote --file")) < body.indexOf("$deployOut = (npx wrangler deploy"), "the catalogue is read BEFORE the worker deploys");
});

test("wrangler is used for exactly three things: D1 reads, the one migration apply, and the one stamped deploy; never rollback, secret, delete, tail or a second deploy", () => {
  // EXECUTED forms only: at the start of a line, or right after "$x = (". The rollback line is text inside a string and is not one of them.
  const calls = [...code.matchAll(/^\s*(?:\$\w+ = \()?npx wrangler ([a-z0-9]+)(?: ([a-z0-9]+))?/gm)].map((m) => `${m[1]}${m[2] ? " " + m[2] : ""}`);
  assert.ok(calls.length >= 3, `sanity: the scan found the d1 reads, the migration apply and the deploy, not ${calls.length}`);
  const allowed = new Set(["d1 execute", "deploy --var"]);
  const seen = new Set(calls.map((c) => (c.startsWith("deploy") ? "deploy --var" : c)));
  for (const c of seen) assert.ok(allowed.has(c) || c === "deploy", `unexpected wrangler subcommand: ${c}`);
  assert.equal(/npx wrangler (rollback|secret|delete|tail|versions|kv|r2|queues)/.test(code.replace(/\$ROLLBACK_LINE = "[^"]*"/, "")), false, "no other wrangler subcommand is ever executed (the rollback is only text for Ben)");
  assert.match(code, /npx wrangler deploy --var "CODE_COMMIT:\$headSha"/, "the deploy stamps the pinned full sha (served code identity)");
  assert.equal([...code.matchAll(/^\s*\$deployOut = \(npx wrangler deploy --var/gm)].length, 1, "one executed deploy line carries the stamp");
  assert.equal(/Invoke-D1Read\s+"(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)/i.test(code), false, "every D1 command with --command is a read");
  assert.equal(/--command[^\n]*\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b/i.test(code), false);
});

test("it stops unless main, origin/main and -ExpectedCommit are ONE commit, after a fetch, on a clean tree, and HEAD is 40 lower-case hex (the stamp)", () => {
  assert.match(code, /if \(\$branch -cne "main"\)/);
  assert.match(code, /\$mainSha -cne \$originSha -or \$mainSha -cne \$expectedSha -or \$headSha -cne \$expectedSha/);
  assert.match(code, /git status --porcelain/);
  assert.ok(at("git fetch origin --quiet") < at("git rev-parse origin/main"), "origin/main is read AFTER the fetch");
  assert.match(code, /\$headSha -cnotmatch '\^\[0-9a-f\]\{40\}\$'/);
});

test("non-minting and one migration: it stops if src/doc.ts moved, or if anything under migrations/ other than the one added 0019 moved, since the live code; it verifies v5 and every chain after the deploy", () => {
  assert.match(code, /git diff --name-only \$LIVE_BASE_COMMIT HEAD -- src\/doc\.ts/);
  assert.match(code, /if \(\$docMoves\.Count -gt 0\) \{ Stop-Here/);
  assert.match(code, /\$migMoves\.Count -ne 1 -or \$migMoves\[0\] -cne \("A`t" \+ \$MIGRATION_PATH_EXPECTED\)/);
  assert.match(code, /^\$MIGRATION_PATH_EXPECTED = "migrations\/0019_door_counts\.sql"$/m);
  assert.match(code, /\[string\]\$att\.constitution\.version -ne "5"/);
  assert.match(code, /\$att\.constitution\.template_hash -cne \$V5_HASH/);
  assert.match(code, /\$att\.ok -ne \$true/);
  for (const chain of ["identity_log", "treasury", "payouts", "ballots"]) assert.ok(code.includes(`"${chain}"`), `the ${chain} chain is checked`);
});

test("it refuses before door_counts' prerequisites are on prod (the guest voice and the showhome tables), reads door_counts' state strictly, and handles -MigrationAlreadyApplied both ways", () => {
  assert.match(code, /name IN \('guest_thread', 'guests', 'visitors', 'showhome_rate'\)/);
  assert.match(code, /\$guestRows\.Count -ne 4\) \{ Stop-Here/);
  assert.ok(at("name IN ('guest_thread'") < at("if ($DryRun) {"), "the prerequisite is checked even on a dry run");
  assert.match(code, /if \(\$doorPresent -eq 1 -and -not \$MigrationAlreadyApplied\) \{ Stop-Here/);
  assert.match(code, /if \(\$doorPresent -eq 0 -and \$MigrationAlreadyApplied\) \{ Stop-Here/);
  assert.match(code, /if \(-not \$MigrationAlreadyApplied\) \{[\s\S]*d1 execute commonhold --remote --file/, "the apply is skipped only under the flag");
});

test("the only pre-deploy probe of live code is that the new route is ABSENT (404), which is what makes the later poll mean something; the poll needs the stamped commit AND the printed version id AND the route", () => {
  assert.match(code, /^\$NEW_CODE_URL = "\$BASE\/api\/doors"$/m);
  assert.match(code, /if \(\$routeBefore\.Code -eq "200"\) \{ Stop-Here/);
  assert.match(code, /if \(\$routeBefore\.Code -ne "404"\) \{ Stop-Here/);
  assert.match(code, /Current Version ID:/);
  assert.match(code, /\$versionMatches\.Count -gt 1\) \{ Stop-Here/);
  assert.match(code, /\$versionMatches\.Count -lt 1\) \{ Stop-Here/);
  assert.match(code, /\$code\.commit -cne \$commit/);
  assert.match(code, /\$code\.version_id\)\.ToLowerInvariant\(\) -cne/);
  assert.match(code, /\$route\.Code -eq "200"/, "the poll also waits for GET /api/doors to answer 200");
});

test("the catalogue lists are the migration's and schema.sql's: THREE columns (day, door, n) and the key (day, door), stated once", () => {
  const listed = (name: string) => [...(new RegExp(`\\$${name} = @\\(([^)]*)\\)`).exec(script)?.[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  const columnsOf = (sql: string): string[] => {
    const body = /CREATE TABLE IF NOT EXISTS door_counts \(([\s\S]*?)\n\);/.exec(sql)?.[1] ?? "";
    return body
      .split("\n")
      .map((l) => /^\s{2}([a-z_]+)\s+(TEXT|INTEGER)\b/.exec(l)?.[1])
      .filter((c): c is string => !!c);
  };
  for (const [label, sql] of [["migration 0019", migration], ["schema.sql", schema]] as const) {
    assert.deepEqual(listed("DOOR_COLUMN_NAMES"), columnsOf(sql), `the script's columns equal ${label}'s, in table order`);
    assert.ok(sql.includes("PRIMARY KEY (day, door)"), `${label} carries the key (day, door)`);
  }
  assert.deepEqual(listed("DOOR_COLUMN_NAMES"), ["day", "door", "n"], "three columns, not four");
  assert.deepEqual(listed("DOOR_KEY_NAMES"), ["day", "door"]);
  assert.equal([...script.matchAll(/^\$DOOR_COLUMN_NAMES = /gm)].length, 1);
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

test("Assert-DoorTable (run for real against a stand-in for the remote read): the right three columns and key pass; a FOURTH column, a wrong order, a wrong key, a foreign key and a missing key index each STOP", (t) => {
  if (!definitions(t)) return;
  const col = (cid: number, name: string, type: string, pk: number) => ({ cid, name, type, pk });
  const good = [col(0, "day", "TEXT", 1), col(1, "door", "TEXT", 2), col(2, "n", "INTEGER", 0)];
  const run = (cols: unknown[], fk = 0, auto = 1) =>
    runPs(
      [
        ...PS_DEFS,
        "$cols = @(ConvertFrom-Json (Get-Content -Raw -Encoding UTF8 '@DIR@\\cols.json') | ForEach-Object { $_ })",
        `$fk = ${fk}`,
        `$auto = ${auto}`,
        "function Invoke-D1Read($sql) {",
        "  if ($sql -like '*pragma_table_info*') { return @($cols) }",
        "  if ($sql -like '*pragma_foreign_key_list*') { return @(@{ n = $fk }) }",
        "  if ($sql -like '*sqlite_master*') { return @(for ($i = 0; $i -lt $auto; $i++) { @{ name = 'sqlite_autoindex_door_counts_1' } }) }",
        "  throw ('unexpected read: ' + $sql)",
        "}",
        "Assert-DoorTable",
        "Write-Output 'CATALOGUE-OK'",
      ],
      { "cols.json": JSON.stringify(cols) },
    );
  const ok = run(good);
  if (!ok) return t.skip("powershell is not available on this machine");
  assert.match(ok.out, /CATALOGUE-OK/, ok.out);
  assert.equal(ok.code, 0);
  const stops: Array<[string, ReturnType<typeof run>, RegExp]> = [
    ["a fourth column", run([...good, col(3, "extra", "TEXT", 0)]), /door_counts has 4 columns, expected 3/],
    ["a missing column", run(good.slice(0, 2)), /door_counts has 2 columns, expected 3/],
    ["a wrong order", run([good[1]!, good[0]!, good[2]!]), /door_counts column 0 is 'door', expected 'day'/],
    ["a wrong key (day only)", run([col(0, "day", "TEXT", 1), col(1, "door", "TEXT", 0), col(2, "n", "INTEGER", 0)]), /primary key is \(day\), expected \(day, door\)/],
    ["a reversed key", run([col(0, "day", "TEXT", 2), col(1, "door", "TEXT", 1), col(2, "n", "INTEGER", 0)]), /primary key is \(door, day\), expected \(day, door\)/],
    ["a foreign key", run(good, 1), /carries a foreign key/],
    ["no key index", run(good, 0, 0), /carries 0 automatic indexes, expected 1/],
  ];
  for (const [label, r, pattern] of stops) {
    assert.ok(r, label);
    assert.equal(r.code, 1, `${label}: the script must exit 1, got ${r.code}: ${r.out}`);
    assert.match(r.out, /\[STOP\]/, label);
    assert.match(r.out, pattern, label);
    assert.equal(/CATALOGUE-OK/.test(r.out), false, `${label}: must not pass`);
  }
});

test("the reviewed-source check stops while $REVIEWED_COMMIT is the placeholder, and when it is not 40 lower-case hex", (t) => {
  if (!definitions(t)) return;
  const run = (reviewed: string) => runPs([...PS_DEFS, `$REVIEWED_COMMIT = '${reviewed}'`, "$headSha = '0000000000000000000000000000000000000000'", reviewedBlock, "Write-Output 'PAST-REVIEW'"]);
  const placeholder = run("TO-BE-SET-BY-HUB");
  if (!placeholder) return t.skip("powershell is not available on this machine");
  assert.equal(placeholder.code, 1);
  assert.match(placeholder.out, /\[STOP\].*still holds the placeholder/);
  assert.equal(/PAST-REVIEW/.test(placeholder.out), false);
  const notHex = run("ABCDEF");
  assert.equal(notHex!.code, 1);
  assert.match(notHex!.out, /\[STOP\].*is not 40 lower-case hex/);
});

test("Get-DisallowedPaths and Get-TestSummary (run for real): only this script, its test and docs/ pass the allowlist; a summary that does not end the output is not read", (t) => {
  if (!definitions(t)) return;
  const r = runPs([
    ...PS_DEFS,
    "$bad = @(Get-DisallowedPaths @('scripts/deploy-mcp-guest-door.ps1', 'test/deploy-mcp-guest-door-script.test.ts', 'docs/CHECKPOINT-MCP-GUEST-DOOR.md', 'src/doors.ts', 'migrations/0019_door_counts.sql', 'docs', 'Docs/x.md'))",
    "Write-Output ('BAD=' + ($bad -join ','))",
    "$tail = \"tests 10`r`nsuites 0`r`npass 9`r`nfail 0`r`ncancelled 0`r`nskipped 1`r`ntodo 0`r`nduration_ms 12.5`r`n\"",
    "$s = Get-TestSummary $tail",
    "Write-Output ('SUMMARY=' + $s.Pass + '/' + $s.Fail + '/' + $s.SumOk)",
    "$notEnd = Get-TestSummary ($tail + 'trailing failure detail')",
    "Write-Output ('NOTEND=' + ($null -eq $notEnd))",
  ]);
  if (!r) return t.skip("powershell is not available on this machine");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /BAD=src\/doors\.ts,migrations\/0019_door_counts\.sql,docs,Docs\/x\.md/, "src/ and migrations/ and a docs look-alike are not on the allowlist");
  assert.match(r.out, /SUMMARY=9\/0\/True/);
  assert.match(r.out, /NOTEND=True/);
});

// ---------- the things the script waits for and rides are really served by the new code ----------

test("the poll target and the ride are real: /api/doors answers 200 with rows and a note (and a route the router does not know answers 404, which is the pre-deploy state), /skill.md carries the version line, POST /mcp initialize carries the guest sentence, tools/list lists the three tools and /mcp/read none, guest_enter mints a token", async () => {
  const marker = /\$SKILL_VERSION_LINE = "([^"]+)"/.exec(script)?.[1] ?? "";
  // This script deploys wave a, whose skill is 1.2.0. The resident tier (D-075 step b) bumped the served skill to 1.3.0 on top of it, so on
  // this branch the marker is the version wave a shipped, no longer the current one; the script itself is not edited (it is wave a's record).
  assert.equal(marker, "version: 1.2.0", "the script's marker is the skill version wave a deployed");
  assert.notEqual(SKILL_VERSION, "1.2.0", "and the served skill has moved on since (wave b, 1.3.0): a later wave must not reuse this marker");
  const d1 = createLocalD1();
  try {
    seedCitizens(d1);
    const env = guestEnv(d1);
    const doors = await call(env, "GET", "/api/doors");
    assert.equal(doors.status, 200);
    assert.ok(Array.isArray(doors.body.rows) && typeof doors.body.note === "string" && doors.body.note.length > 0);
    assert.equal(doors.body.window_days, 30);
    assert.equal((await call(env, "GET", "/api/doors-not-a-route")).status, 404, "the pre-deploy 404 is the router's own catch-all");
    const skill = await call(env, "GET", "/skill.md");
    assert.ok((skill.body._text as string).includes(`version: ${SKILL_VERSION}`), "the served skill carries its own current version line (wave a's marker is history on this branch)");
    const init = await call(env, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } });
    assert.ok(JSON.stringify(init.body).includes("guest_enter returns a token"));
    const list = await call(env, "POST", "/mcp", { jsonrpc: "2.0", id: 2, method: "tools/list" });
    const raw = JSON.stringify(list.body);
    // the script greps the raw body for "name":"<tool>" (compact JSON), exactly as JSON.stringify writes it
    for (const tool of ["guest_enter", "guest_comment", "showhome_note"]) assert.ok(raw.includes(`"name":"${tool}"`), tool);
    const readList = JSON.stringify((await call(env, "POST", "/mcp/read", { jsonrpc: "2.0", id: 3, method: "tools/list" })).body);
    // the NAMES are checked, as the script checks them: the read tools' descriptions say where a guest writes, so the bare words are on /mcp/read by design
    for (const tool of ["guest_enter", "guest_comment", "showhome_note"]) assert.equal(readList.includes(`"name":"${tool}"`), false, `/mcp/read must not list ${tool}`);
    assert.ok(readList.includes("guest_enter"), "and the bare word IS there, which is why a bare-word check on this door would have stopped a good deploy");
    const enter = await call(env, "POST", "/mcp", { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "guest_enter", arguments: { handle: "deploy-ride", model: "deploy-script" } } }, { "CF-Connecting-IP": "198.51.100.77" });
    const text = enter.body.result.content[0].text as string;
    assert.equal(enter.body.result.isError, undefined);
    assert.ok(text.includes("commonhold_visit_"));
    // what the ride then reads back: the counts the ride itself caused
    const after = (await call(env, "GET", "/api/doors")).body.rows as Array<{ door: string; n: number }>;
    for (const door of ["skill_md", "mcp_initialize", "showhome_enter"]) assert.ok(after.some((r) => r.door === door && r.n >= 1), `the ride's own ${door} request is counted`);
  } finally {
    d1.close();
  }
});

test("the other deploy scripts are untouched: the retired settle-honesty script still stops", () => {
  const old = readFileSync(here("../scripts/deploy-x402-settle-honesty.ps1"), "utf8");
  assert.match(old, /RETIRED: this script shipped wave B once and must not be reused/);
});
