// scripts/deploy-residents.ps1 is WRITTEN AND NEVER RUN by the builder (hard rule: no deploy, no wrangler command against anything remote, not
// even -DryRun, which reads the remote D1). It is proven here by everything that can be proven without running it: it parses under PowerShell's
// own parser, it is ASCII, it has none of the traps the repo's L-080 family names, its steps are in the load-bearing order (the two pins FIRST,
// fetch, pin, template check, reviewed source, gates, probes, dry-run exit, migration to the remote D1, the catalogue read, deploy, version id,
// poll, attest, ride), its catalogue lists are the migration's and schema.sql's, the catalogue check really stops on a missing column, a wrong
// order, a non-partial index, a missing expiry index or a foreign key, the template extractor sees a byte inside FRONT_DOOR_TEMPLATE and ignores
// one outside it, step 0 stops on EITHER placeholder before any git or remote command (hub amendment A7), and the ride makes no live write.
// Every one of these fails when the script is mutated (docs/CHECKPOINT-RESIDENTS.md).
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
const SCRIPT_PATH = here("../scripts/deploy-residents.ps1");
const script = readFileSync(SCRIPT_PATH, "utf8").replace(/\r\n/g, "\n");
const norm = (s: string) => s.replace(/\r\n/g, "\n");
const migration = norm(readFileSync(here("../migrations/0020_residents.sql"), "utf8"));
const migration18 = norm(readFileSync(here("../migrations/0018_guest_voice.sql"), "utf8"));
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
  const dir = mkdtempSync(join(tmpdir(), "deploy-res-"));
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

test("the pins: the v5 hash, the two hub placeholders (each the placeholder or a full 40-hex sha) and the allowlist are exactly the commission's", () => {
  assert.match(script, /^\$V5_HASH = "fa11788d062b0c6d23c54c428c1c9649d263ae3ba704e602e122066926049491"$/m);
  // Before the merge the builder leaves the placeholders; after it the hub sets the full shas (40 lower-case hex). Either is a valid committed
  // state; anything else (a short sha, upper case, a stray value) is not. Step 0 of the script itself refuses to run on a placeholder.
  assert.match(script, /^\$LIVE_BASE_COMMIT = "(?:TO-BE-SET-BY-HUB-LIVE-BASE|[0-9a-f]{40})"$/m, "the live base is the builder's placeholder or the hub's full 40-hex sha");
  assert.match(script, /^\$REVIEWED_COMMIT = "(?:TO-BE-SET-BY-HUB|[0-9a-f]{40})"$/m, "the reviewed commit is the builder's placeholder or the hub's full 40-hex sha");
  assert.match(script, /^\$LIVE_BASE_PLACEHOLDER = "TO-BE-SET-BY-HUB-LIVE-BASE"$/m);
  assert.match(script, /^\$REVIEWED_COMMIT_PLACEHOLDER = "TO-BE-SET-BY-HUB"$/m);
  const allowed = /\$ALLOWED_PATHS_AFTER_REVIEW = @\(([^)]*)\)/.exec(code)?.[1] ?? "";
  assert.deepEqual([...allowed.matchAll(/"([^"]+)"/g)].map((m) => m[1]), ["scripts/deploy-residents.ps1", "test/deploy-residents-script.test.ts", "docs/"]);
  assert.equal([...code.matchAll(/\$ALLOWED_PATHS_AFTER_REVIEW = /g)].length, 1, "stated once");
  assert.match(code, /\$ROLLBACK_LINE = .*\$rollbackTarget/, "the rollback line names the version read from the live worker");
  assert.equal(/\$ROLLBACK_WORKER_VERSION/.test(code), false, "no typed-in rollback version: it is read live, before the deploy");
});

test("A7: step 0a STOPS before ANY git, npm, wrangler or network command while EITHER pin is its placeholder (or is not 40 lower-case hex); it is the first thing after the definitions", (t) => {
  assert.ok(pinBlock.length > 300, "the pin block exists");
  const body = code.slice(code.indexOf("# BEGIN-PIN-CHECK") >= 0 ? 0 : 0);
  const pinAt = at('$LIVE_BASE_COMMIT -ceq $LIVE_BASE_PLACEHOLDER');
  assert.ok(pinAt < at("git fetch origin --quiet"), "the live-base pin is checked before the fetch");
  assert.ok(at('$REVIEWED_COMMIT -ceq $REVIEWED_COMMIT_PLACEHOLDER') < at("git fetch origin --quiet"), "the reviewed pin is checked before the fetch");
  assert.ok(at('$LIVE_BASE_COMMIT -cnotmatch') < at("git merge-base --is-ancestor $LIVE_BASE_COMMIT HEAD"), "a malformed live base can never reach git merge-base");
  for (const forbidden of ["git ", "npm ", "npx ", "curl.exe", "Invoke-D1Read", "Get-Text", "Read-Attest"]) {
    assert.equal(pinBlock.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n").includes(forbidden), false, `the pin block never calls ${forbidden.trim()}`);
  }
  void body;
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
    ["the reviewed placeholder alone", reviewedOnly, /\[STOP\].*REVIEWED_COMMIT still holds the placeholder/],
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
    "$colRows = @(Invoke-D1Read",
    "if ($DryRun) {",
    "d1 execute commonhold --remote --file $migrationPath",
    "Assert-ResidentSchema\n",
    "$deployOut = (npx wrangler deploy",
    "Current Version ID",
    "Wait-NewWorker $headSha",
    "Assert-Attest $attAfter",
    '"$BASE/api/residents"',
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
  assert.ok(body.indexOf('Stop-Here "migration 0020 failed') < body.indexOf("$deployOut = (npx wrangler deploy"), "a failed migration stops before the deploy");
  assert.ok(body.indexOf("Assert-ResidentSchema\n", body.indexOf("d1 execute commonhold --remote --file")) < body.indexOf("$deployOut = (npx wrangler deploy"), "the catalogue is read BEFORE the worker deploys");
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

test("no SQL handed to wrangler contains a double quote (PowerShell 5.1 does not escape an embedded one in a native argument, so the argument splits): every Invoke-D1Read line is single-quoted SQL inside one double-quoted string", () => {
  const reads = code.split("\n").filter((l) => /Invoke-D1Read\s+"/.test(l));
  assert.ok(reads.length >= 9, `sanity: the scan found the catalogue reads, not ${reads.length}`);
  for (const l of reads) {
    assert.equal(/`"/.test(l), false, `an escaped double quote inside SQL: ${l.trim().slice(0, 120)}`);
    const sql = /Invoke-D1Read\s+"((?:[^"`]|`[^"])*)"/.exec(l)?.[1];
    assert.ok(sql !== undefined, `the SQL string ends cleanly: ${l.trim().slice(0, 120)}`);
  }
  // positive control: the check can fail on the shape that was there before (the real query it replaced)
  assert.equal(/`"/.test('$idx = @(Invoke-D1Read "SELECT name, `"unique`" AS is_unique FROM pragma_index_list(\'guests\')")'), true);
  assert.match(code, /\$idx\[0\]\.unique/, "and the unique flag is read by its own column name");
});

test("the ride makes NO live write: no POST except the two read-only tools/list calls, no tools/call, no guest_enter, no showhome/enter, no bind, and no key, token or assertion is ever built", () => {
  const posts = [...code.matchAll(/Post-Json "[^"]+" '([^']*)'/g)].map((m) => m[1]!);
  assert.ok(posts.length === 2, "exactly two POSTs: the two tools/list calls");
  for (const p of posts) assert.match(p, /"method":"tools\/list"/, "each POST is a tools/list");
  assert.equal(/tools\/call|"initialize"|guest_enter"?\s*,\s*"arguments|showhome\/enter|api\/resident\/(bind|token)"|--data-binary[^\n]*assertion|ch1\./.test(code.replace(/\$list\.Body\.Contains[^\n]*/g, "")), false, "nothing in the executed code writes");
  assert.match(script, /THE RIDE MAKES NO LIVE WRITE/);
  assert.match(code, /No live write was made/);
});

test("it stops unless main, origin/main and -ExpectedCommit are ONE commit, after a fetch, on a clean tree, and HEAD is 40 lower-case hex (the stamp)", () => {
  assert.match(code, /if \(\$branch -cne "main"\)/);
  assert.match(code, /\$mainSha -cne \$originSha -or \$mainSha -cne \$expectedSha -or \$headSha -cne \$expectedSha/);
  assert.match(code, /git status --porcelain/);
  assert.ok(at("git fetch origin --quiet") < at("git rev-parse origin/main"), "origin/main is read AFTER the fetch");
  assert.match(code, /\$headSha -cnotmatch '\^\[0-9a-f\]\{40\}\$'/);
});

test("non-minting: it compares FRONT_DOOR_TEMPLATE itself between the live base and HEAD (src/doc.ts may move OUTSIDE it, as this wave does), stops on a difference, and verifies v5 and every chain after the deploy", () => {
  assert.match(code, /if \(\$liveTemplate -cne \$headTemplate\) \{ Stop-Here/);
  assert.equal(/git diff --name-only \$LIVE_BASE_COMMIT HEAD -- src\/doc\.ts/.test(code), false, "no blanket 'doc.ts unmoved' check: this wave edits doc.ts outside the template");
  assert.match(code, /\$migMoves\.Count -ne 1 -or \$migMoves\[0\] -cne \("A`t" \+ \$MIGRATION_PATH_EXPECTED\)/);
  assert.match(code, /^\$MIGRATION_PATH_EXPECTED = "migrations\/0020_residents\.sql"$/m);
  assert.match(code, /\[string\]\$att\.constitution\.version -ne "5"/);
  assert.match(code, /\$att\.constitution\.template_hash -cne \$V5_HASH/);
  assert.match(code, /\$att\.ok -ne \$true/);
  for (const chain of ["identity_log", "treasury", "payouts", "ballots"]) assert.ok(code.includes(`"${chain}"`), `the ${chain} chain is checked`);
});

test("it proves the live worker IS the pinned base (code.commit equals $LIVE_BASE_COMMIT), reads the rollback target from it, refuses before wave a's tables are on prod, and treats 0020 as absent, applied or half-applied (the last stops)", () => {
  assert.match(code, /\[string\]\$attBefore\.code\.commit -cne \$LIVE_BASE_COMMIT/);
  assert.match(code, /\$rollbackTarget = \[string\]\$attBefore\.code\.version_id/);
  assert.match(code, /name IN \('guest_thread', 'guests', 'visitors', 'showhome_rate', 'door_counts'\)/);
  assert.match(code, /\$prereqRows\.Count -ne 5\) \{ Stop-Here/);
  assert.ok(at("name IN ('guest_thread'") < at("if ($DryRun) {"), "the prerequisite is checked even on a dry run");
  assert.match(code, /\$colsPresent -eq 0 -and \$noncePresent -eq 0/);
  assert.match(code, /\$colsPresent -eq 2 -and \$noncePresent -eq 1/);
  assert.match(code, /else \{ Stop-Here \("migration 0020 is half-applied on prod/);
  assert.match(code, /\$migrationState -ceq "applied" -and -not \$MigrationAlreadyApplied\) \{ Stop-Here/);
  assert.match(code, /\$migrationState -ceq "absent" -and \$MigrationAlreadyApplied\) \{ Stop-Here/);
  assert.match(code, /if \(-not \$MigrationAlreadyApplied\) \{[\s\S]*d1 execute commonhold --remote --file/, "the apply is skipped only under the flag");
});

test("the only pre-deploy probe of live code is that the new route is ABSENT (404), which is what makes the later poll mean something; the poll needs the stamped commit AND the printed version id AND the route", () => {
  assert.match(code, /^\$NEW_CODE_URL = "\$BASE\/api\/residents"$/m);
  assert.match(code, /if \(\$routeBefore\.Code -eq "200"\) \{ Stop-Here/);
  assert.match(code, /if \(\$routeBefore\.Code -ne "404"\) \{ Stop-Here/);
  assert.match(code, /Current Version ID:/);
  assert.match(code, /\$versionMatches\.Count -gt 1\) \{ Stop-Here/);
  assert.match(code, /\$versionMatches\.Count -lt 1\) \{ Stop-Here/);
  assert.match(code, /\$code\.commit -cne \$commit/);
  assert.match(code, /\$code\.version_id\)\.ToLowerInvariant\(\) -cne/);
  assert.match(code, /\$route\.Code -eq "200"/, "the poll also waits for GET /api/residents to answer 200");
});

test("the catalogue lists are the migration's and schema.sql's: guests' eight columns (0018's six, then the two ALTERs), resident_nonces' three, its key, and the two index names, each stated once", () => {
  const listed = (name: string) => [...(new RegExp(`\\$${name} = @\\(([^)]*)\\)`).exec(script)?.[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  const tableColumns = (sql: string, table: string): string[] => {
    const body = new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`).exec(sql)?.[1] ?? "";
    return body.split("\n").map((l) => /^\s{2}([a-z_]+)\s+(TEXT|INTEGER)\b/.exec(l)?.[1]).filter((c): c is string => !!c);
  };
  const altered = [...migration.matchAll(/^ALTER TABLE guests ADD COLUMN ([a-z_]+) /gm)].map((m) => m[1]!);
  const guestsAfter = [...tableColumns(migration18, "guests"), ...altered];
  assert.deepEqual(listed("GUESTS_COLUMN_NAMES"), guestsAfter, "the script's guests columns are 0018's table plus 0020's ALTERs, in order");
  assert.deepEqual(listed("GUESTS_NEW_COLUMNS"), altered);
  assert.deepEqual(listed("NONCE_COLUMN_NAMES"), tableColumns(migration, "resident_nonces"));
  assert.deepEqual(listed("NONCE_COLUMN_NAMES"), tableColumns(schema, "resident_nonces"), "and schema.sql's");
  assert.deepEqual(listed("NONCE_KEY_NAMES"), ["nonce"]);
  assert.deepEqual(guestsAfter.slice(-2), ["public_key", "resident_at"]);
  for (const [label, sql] of [["migration 0020", migration], ["schema.sql", schema]] as const) {
    assert.ok(sql.includes("CREATE UNIQUE INDEX IF NOT EXISTS idx_guests_public_key ON guests(public_key) WHERE public_key IS NOT NULL;"), `${label} carries the partial unique index`);
    assert.ok(sql.includes("CREATE INDEX IF NOT EXISTS idx_resident_nonces_expiry ON resident_nonces(expires_at);"), `${label} carries the expiry index`);
  }
  assert.match(script, /^\$KEY_INDEX_NAME = "idx_guests_public_key"$/m);
  assert.match(script, /^\$EXPIRY_INDEX_NAME = "idx_resident_nonces_expiry"$/m);
  assert.equal([...script.matchAll(/^\$GUESTS_COLUMN_NAMES = /gm)].length, 1);
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

test("Assert-ResidentSchema (run for real against a stand-in for the remote read): the right catalogue passes; a missing column, a wrong order, a non-unique or non-partial key index, a wrong index predicate, a wrong nonce key, a missing expiry index and a foreign key each STOP", (t) => {
  if (!definitions(t)) return;
  const col = (cid: number, name: string, type: string, pk: number) => ({ cid, name, type, pk });
  const guests = [col(0, "id", "INTEGER", 1), col(1, "visitor_id", "INTEGER", 0), col(2, "token_hash", "TEXT", 0), col(3, "handle", "TEXT", 0), col(4, "model", "TEXT", 0), col(5, "created_at", "INTEGER", 0), col(6, "public_key", "TEXT", 0), col(7, "resident_at", "INTEGER", 0)];
  const nonces = [col(0, "nonce", "TEXT", 1), col(1, "visitor_id", "INTEGER", 0), col(2, "expires_at", "INTEGER", 0)];
  const good = { guests, nonces, unique: 1, partial: 1, idxSql: "CREATE UNIQUE INDEX idx_guests_public_key ON guests(public_key) WHERE public_key IS NOT NULL", idxCount: 1, expiry: 1, fkGuests: 0, fkNonces: 0 };
  const run = (over: Partial<typeof good>) =>
    runPs(
      [
        ...PS_DEFS,
        "$cfg = Get-Content -Raw -Encoding UTF8 '@DIR@\\cfg.json' | ConvertFrom-Json",
        "function Invoke-D1Read($sql) {",
        "  if ($sql -like '*pragma_table_info(''guests'')*') { return @($cfg.guests) }",
        "  if ($sql -like '*pragma_table_info(''resident_nonces'')*') { return @($cfg.nonces) }",
        "  if ($sql -like '*pragma_index_list(''guests'')*') { return @(for ($i = 0; $i -lt $cfg.idxCount; $i++) { @{ name = 'idx_guests_public_key'; unique = $cfg.unique; partial = $cfg.partial } }) }",
        "  if ($sql -like '*SELECT sql FROM sqlite_master*idx_guests_public_key*') { return @(@{ sql = $cfg.idxSql }) }",
        "  if ($sql -like '*idx_resident_nonces_expiry*') { return @(for ($i = 0; $i -lt $cfg.expiry; $i++) { @{ name = 'idx_resident_nonces_expiry' } }) }",
        "  if ($sql -like '*pragma_foreign_key_list(''guests'')*') { return @(@{ n = $cfg.fkGuests }) }",
        "  if ($sql -like '*pragma_foreign_key_list(''resident_nonces'')*') { return @(@{ n = $cfg.fkNonces }) }",
        "  throw ('unexpected read: ' + $sql)",
        "}",
        "Assert-ResidentSchema",
        "Write-Output 'CATALOGUE-OK'",
      ],
      { "cfg.json": JSON.stringify({ ...good, ...over }) },
    );
  const ok = run({});
  if (!ok) return t.skip("powershell is not available on this machine");
  assert.match(ok.out, /CATALOGUE-OK/, ok.out);
  assert.equal(ok.code, 0);
  const stops: Array<[string, ReturnType<typeof run>, RegExp]> = [
    ["a missing column", run({ guests: guests.slice(0, 7) }), /guests has 7 columns, expected 8/],
    ["a ninth column", run({ guests: [...guests, col(8, "extra", "TEXT", 0)] }), /guests has 9 columns, expected 8/],
    ["a wrong order", run({ guests: [...guests.slice(0, 6), guests[7]!, guests[6]!] }), /guests column 6 is 'resident_at', expected 'public_key'/],
    ["a non-unique key index", run({ unique: 0 }), /idx_guests_public_key is not UNIQUE/],
    ["a non-partial key index", run({ partial: 0 }), /is not partial/],
    ["no key index", run({ idxCount: 0 }), /guests carries 0 indexes named idx_guests_public_key, expected 1/],
    ["a wrong index predicate", run({ idxSql: "CREATE UNIQUE INDEX idx_guests_public_key ON guests(public_key) WHERE handle IS NOT NULL" }), /not defined over WHERE public_key IS NOT NULL/],
    ["a missing nonce column", run({ nonces: nonces.slice(0, 2) }), /resident_nonces has 2 columns, expected 3/],
    ["a wrong nonce key", run({ nonces: [col(0, "nonce", "TEXT", 0), col(1, "visitor_id", "INTEGER", 1), col(2, "expires_at", "INTEGER", 0)] }), /resident_nonces primary key is \(visitor_id\), expected \(nonce\)/],
    ["no expiry index", run({ expiry: 0 }), /resident_nonces has no idx_resident_nonces_expiry index/],
    ["a foreign key on guests", run({ fkGuests: 1 }), /guests carries a foreign key/],
    ["a foreign key on resident_nonces", run({ fkNonces: 1 }), /resident_nonces carries a foreign key/],
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
  const clean = run(["scripts/deploy-residents.ps1", "docs/CHECKPOINT-RESIDENTS.md"]);
  if (!clean) return t.skip("powershell is not available on this machine");
  assert.match(clean.out, /PAST-REVIEW/, clean.out);
  const dirty = run(["src/resident.ts"]);
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
  assert.ok(docTs.slice(end + 1).includes("showhomeDoorNote"), "and the door note this wave edits lies AFTER it");
  const doc = docTs.replace(/\r\n/g, "\n");
  const outsideEdit = doc.replace("RESIDENTS (operational", "RESIDENTS (operational, edited");
  const insideEdit = doc.replace("export const FRONT_DOOR_TEMPLATE = `", "export const FRONT_DOOR_TEMPLATE = `X");
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
    "$bad = @(Get-DisallowedPaths @('scripts/deploy-residents.ps1', 'test/deploy-residents-script.test.ts', 'docs/CHECKPOINT-RESIDENTS.md', 'src/resident.ts', 'migrations/0020_residents.sql', 'docs', 'Docs/x.md'))",
    "Write-Output ('BAD=' + ($bad -join ','))",
    "$tail = \"tests 10`r`nsuites 0`r`npass 9`r`nfail 0`r`ncancelled 0`r`nskipped 1`r`ntodo 0`r`nduration_ms 12.5`r`n\"",
    "$s = Get-TestSummary $tail",
    "Write-Output ('SUMMARY=' + $s.Pass + '/' + $s.Fail + '/' + $s.SumOk)",
    "$notEnd = Get-TestSummary ($tail + 'trailing failure detail')",
    "Write-Output ('NOTEND=' + ($null -eq $notEnd))",
  ]);
  if (!r) return t.skip("powershell is not available on this machine");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /BAD=src\/resident\.ts,migrations\/0020_residents\.sql,docs,Docs\/x\.md/, "src/ and migrations/ and a docs look-alike are not on the allowlist");
  assert.match(r.out, /SUMMARY=9\/0\/True/);
  assert.match(r.out, /NOTEND=True/);
});

// ---------- the things the script waits for and rides are really served by the new code ----------

test("the poll target and the ride are real (in-process, no network): GET /api/residents answers 200 with its own shape (and a route the router does not know answers 404), /skill.md carries the version line and the section, /api/official's count equals the roster total, /api/showhome has the rung, an empty profile has the route's own 404 text, tools/list lists the five tools on /mcp and none on /mcp/read", async () => {
  const marker = /\$SKILL_VERSION_LINE = "([^"]+)"/.exec(script)?.[1] ?? "";
  assert.equal(marker, `version: ${SKILL_VERSION}`, "the script's marker is the live skill version");
  assert.equal(marker, "version: 1.3.0");
  const d1 = createLocalD1();
  try {
    seedCitizens(d1);
    const env = guestEnv(d1);
    const roster = await call(env, "GET", "/api/residents");
    assert.equal(roster.status, 200);
    assert.ok(Array.isArray(roster.body.residents) && /^[0-9]+$/.test(String(roster.body.total)) && roster.body.note.length > 0);
    assert.equal((await call(env, "GET", "/api/residents-not-a-route")).status, 404, "the pre-deploy 404 is the router's own catch-all");
    const skill = (await call(env, "GET", "/skill.md")).body._text as string;
    assert.ok(skill.includes(marker) && skill.includes("## Stay as a resident"));
    const official = (await call(env, "GET", "/api/official")).body;
    assert.equal(String(official.residents.count), String(roster.body.total), "the two surfaces agree about one figure");
    assert.equal((await call(env, "GET", "/api/showhome")).body.resident_tier.name, "resident");
    const missing = await call(env, "GET", "/api/resident/99999999");
    assert.equal(missing.status, 404);
    assert.ok(JSON.stringify(missing.body).includes("No guest or resident has the number"), "the route's own 404 text, which the catch-all never says");
    const list = JSON.stringify((await call(env, "POST", "/mcp", { jsonrpc: "2.0", id: 2, method: "tools/list" })).body);
    for (const tool of ["resident_bind", "resident_token", "guest_enter", "guest_comment", "showhome_note"]) assert.ok(list.includes(`"name":"${tool}"`), tool);
    const readList = JSON.stringify((await call(env, "POST", "/mcp/read", { jsonrpc: "2.0", id: 3, method: "tools/list" })).body);
    for (const tool of ["resident_bind", "resident_token", "guest_enter", "guest_comment", "showhome_note"]) assert.equal(readList.includes(`"name":"${tool}"`), false, `/mcp/read must not list ${tool}`);
  } finally {
    d1.close();
  }
});

test("the other deploy scripts are untouched: the retired settle-honesty script still stops, and wave a's script still marks the skill version wave a deployed", () => {
  const old = readFileSync(here("../scripts/deploy-x402-settle-honesty.ps1"), "utf8");
  assert.match(old, /RETIRED: this script shipped wave B once and must not be reused/);
  const waveA = readFileSync(here("../scripts/deploy-mcp-guest-door.ps1"), "utf8");
  assert.match(waveA, /^\$SKILL_VERSION_LINE = "version: 1\.2\.0"$/m, "wave a's script still marks the skill version wave a deployed");
});
