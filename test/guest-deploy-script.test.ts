// scripts/deploy-guest-voice.ps1 is WRITTEN AND NEVER RUN by the builder (hard rule: no deploy, no wrangler command against anything
// remote). It is proven here by everything that can be proven without running it: it parses under PowerShell's own parser, it is ASCII,
// it has none of the traps the repo's L-080 family names, its steps are in the load-bearing order (fetch, pin, probes, dry-run exit,
// migration to the remote D1 FIRST, catalogue read of all three tables, deploy, version id, propagation poll, attest, ride), its column
// lists are the migration's and schema.sql's, it refuses to run before the settlement replay guard's migration 0017 is on prod, and the
// route it polls for and the things it rides are really served by the new code. Every one of these fails when the script is mutated
// (docs/CHECKPOINT-GUEST-VOICE.md).
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parsePowerShellFile } from "./helpers/ps-parse.ts";
import { fileURLToPath } from "node:url";
import { createLocalD1, seedCitizens, seedPost, guestEnv, call } from "./helpers/guest.ts";

const SCRIPT_PATH = fileURLToPath(new URL("../scripts/deploy-guest-voice.ps1", import.meta.url));
const script = readFileSync(SCRIPT_PATH, "utf8");
const norm = (s: string) => s.replace(/\r\n/g, "\n");
const migration = norm(readFileSync(fileURLToPath(new URL("../migrations/0018_guest_voice.sql", import.meta.url)), "utf8"));
const schema = norm(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
// Code lines only: a comment may name a trap it avoids.
const code = script
  .split(/\r?\n/)
  .filter((l) => !/^\s*#/.test(l))
  .join("\n");
const at = (needle: string) => {
  const i = code.indexOf(needle);
  assert.ok(i >= 0, `the script must contain: ${needle}`);
  return i;
};

test("the script parses under PowerShell's own parser with zero errors, and is ASCII only", (t) => {
  assert.equal(/[^\x00-\x7f]/.test(script), false, "5.1 reads a BOM-less UTF-8 script as the ANSI code page: ASCII only");
  const parsed = parsePowerShellFile(SCRIPT_PATH);
  if (!parsed.available) {
    t.skip(`${parsed.reason}; the static checks below still run`);
    return;
  }
  assert.equal(parsed.errors, 0, `parse errors: ${parsed.detail}`);
});

test("no PowerShell traps: no two variables differing only by case ($COLS/$cols), no `$var:` drive reference, no stderr merged outside a Continue block, no -notmatch over a pipeline", () => {
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
});

test("parameters: -ExpectedCommit is mandatory; -DryRun and -MigrationAlreadyApplied exist", () => {
  assert.match(script, /\[Parameter\(Mandatory = \$true\)\]\[string\]\$ExpectedCommit/);
  assert.match(script, /\[switch\]\$DryRun/);
  assert.match(script, /\[switch\]\$MigrationAlreadyApplied/);
});

test("the steps are in the load-bearing order: fetch, pin, gates, probes, (dry-run exit), migration to the REMOTE D1, all three catalogue reads, deploy, version id, poll, attest, ride", () => {
  const order = [
    "git fetch origin --quiet",
    "rev-parse --abbrev-ref HEAD",
    "origin/main",
    "-ExpectedCommit",
    "git status --porcelain",
    "npm test",
    "$attBefore = Read-Attest",
    "$routeBefore = Get-Text",
    "name = 'settlement_claims'",
    "if ($DryRun) {",
    "d1 execute commonhold --remote --file $migrationPath",
    'Assert-TableColumns "guest_thread"',
    'Assert-TableColumns "guest_duty_runs"',
    'Assert-TableColumns "guests"',
    "$deployOut = (npx wrangler deploy",
    "Current Version ID",
    "$poll = Get-Text $NEW_CODE_URL",
    "Assert-Attest $attAfter",
    "$post = Get-Json",
  ];
  let last = -1;
  for (const needle of order) {
    const i = code.indexOf(needle, last + 1);
    assert.ok(i > last, `"${needle}" must come after the previous step (found at ${i}, previous at ${last})`);
    last = i;
  }
  const dryExit = code.indexOf("exit 0", at("if ($DryRun) {"));
  assert.ok(dryExit > 0 && dryExit < at("d1 execute commonhold --remote --file"), "-DryRun exits before the migration");
  assert.ok(dryExit < at("$deployOut = (npx wrangler deploy"), "-DryRun exits before the deploy");
  assert.equal(code.split("d1 execute commonhold --remote --file").length - 1, 1, "one remote migration apply");
  assert.equal(code.split("$deployOut = (npx wrangler deploy").length - 1, 1, "one deploy");
  assert.ok(at('Stop-Here "migration 0018 failed') < at("$deployOut = (npx wrangler deploy"), "a failed migration stops before the deploy");
  // every catalogue read comes BEFORE the deploy: the worker must not deploy against a table that is not what it expects
  assert.ok(at('Assert-TableColumns "guests"') < at("$deployOut = (npx wrangler deploy"));
});

test("it stops unless main, origin/main and -ExpectedCommit are ONE commit, after a fetch, on a clean tree", () => {
  assert.match(code, /if \(\$branch -ne "main"\)/);
  assert.match(code, /\$mainSha -ne \$originSha -or \$mainSha -ne \$expectedSha -or \$headSha -ne \$expectedSha/);
  assert.match(code, /git status --porcelain/);
  assert.ok(at("git fetch origin --quiet") < at("git rev-parse origin/main"), "origin/main is read AFTER the fetch");
});

test("it refuses before the settlement replay guard's migration 0017 is on prod, reads the three tables' state strictly, and treats a partial state as a stop", () => {
  assert.match(code, /\$claimRows\.Count -ne 1\) \{ Stop-Here "settlement_claims is not on prod/);
  assert.ok(at("name = 'settlement_claims'") < at("if ($DryRun) {"), "the M2 precondition is checked even on a dry run");
  assert.match(code, /if \(\$tablesPresent -eq 3 -and -not \$MigrationAlreadyApplied\) \{ Stop-Here/);
  assert.match(code, /if \(\$tablesPresent -gt 0 -and \$tablesPresent -lt 3\) \{ Stop-Here/);
  assert.match(code, /if \(\$tablesPresent -eq 0 -and \$MigrationAlreadyApplied\) \{ Stop-Here/);
  assert.match(code, /if \(-not \$MigrationAlreadyApplied\) \{[\s\S]*d1 execute commonhold --remote --file/, "the apply is skipped only under the flag");
});

test("it is reusable: the only pre-deploy probe of live code is that the new route is ABSENT (404), which is what makes the later poll mean something", () => {
  assert.match(code, /if \(\$routeBefore\.Code -eq "200"\) \{ Stop-Here/);
  assert.match(code, /if \(\$routeBefore\.Code -ne "404"\) \{ Stop-Here/);
  assert.equal(/outputSchema/.test(code), false);
});

test("the catalogue check covers every column of all three tables in order, the primary keys, the six guest_thread indexes and both CHECKs: the script's lists are the migration's and schema.sql's", () => {
  const listed = (name: string) => [...(new RegExp(`\\$${name} = @\\(([^)]*)\\)`).exec(script)?.[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  const columnsOf = (sql: string, table: string): string[] => {
    const body = new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(([\\s\\S]*?)\\n\\);`).exec(sql)?.[1] ?? "";
    return body
      .split("\n")
      .map((l) => /^\s{2}([a-z_]+)\s+(TEXT|INTEGER)\b/.exec(l)?.[1])
      .filter((c): c is string => !!c);
  };
  for (const [label, sql] of [["migration 0018", migration], ["schema.sql", schema]] as const) {
    assert.deepEqual(listed("GUEST_THREAD_COLUMN_NAMES"), columnsOf(sql, "guest_thread"), `guest_thread columns equal ${label}'s, in table order`);
    assert.deepEqual(listed("GUEST_RUN_COLUMN_NAMES"), columnsOf(sql, "guest_duty_runs"), `guest_duty_runs columns equal ${label}'s`);
    assert.deepEqual(listed("GUEST_COLUMN_NAMES"), columnsOf(sql, "guests"), `guests columns equal ${label}'s`);
    const idx = [...sql.matchAll(/CREATE (?:UNIQUE )?INDEX IF NOT EXISTS (idx_guest_thread_[a-z_]+)/g)].map((m) => m[1]).sort();
    assert.deepEqual(listed("GUEST_INDEX_NAMES").sort(), idx, `the six guest_thread indexes are ${label}'s`);
    for (const check of ["CHECK ((parent_kind IS NULL) = (parent_id IS NULL))", "CHECK (duty = 0 OR (author_kind = 'guest' AND due_at IS NOT NULL))"]) {
      assert.ok(sql.includes(check), `${label} carries ${check}`);
      assert.ok(script.includes(check), `the script verifies ${check}`);
    }
  }
  assert.equal(listed("GUEST_THREAD_COLUMN_NAMES").length, 16);
  assert.match(code, /Where-Object \{ \[int\]\$_\.pk -gt 0 \}/);
  assert.match(code, /\$gotPk -join ","\) -ne "id"/);
  assert.match(code, /\$autoRows\.Count -ne 2/, "the guests table's two automatic unique indexes (visitor_id, token_hash)");
});

test("it captures the wrangler version id and stops if there is none; the poll waits for a route only this wave serves, and the script verifies non-minting (v5, template hash, every chain ok)", () => {
  assert.match(code, /Current Version ID:/);
  assert.match(code, /if \(-not \$versionId\) \{ Stop-Here/);
  assert.match(code, /fa11788d062b0c6d23c54c428c1c9649d263ae3ba704e602e122066926049491/);
  assert.match(code, /\$att\.ok -ne \$true/);
  for (const chain of ["identity_log", "treasury", "payouts", "ballots"]) assert.ok(code.includes(`"${chain}"`), `the ${chain} chain is checked`);
  assert.match(code, /\[string\]\$att\.constitution\.version -ne "5"/);
  assert.match(code, /\$NEW_CODE_URL = "\$BASE\/api\/guest\/due"/);
});

test("the things the script waits for and rides are really served by the new code (a poll target is tested, not assumed): the route, the skill version, guest_voice with its four corrections, a post read that carries guest_thread, the stats fields", async () => {
  const marker = /\$SKILL_VERSION_LINE = "([^"]+)"/.exec(script)?.[1] ?? "";
  assert.equal(marker, "version: 1.1.4");
  const d1 = createLocalD1();
  try {
    seedCitizens(d1);
    const post = seedPost(d1, 2);
    const env = guestEnv(d1);
    const due = await call(env, "GET", "/api/guest/due");
    assert.equal(due.status, 200, "the new route answers 200 (and, before this wave, the router's catch-all answers 404)");
    assert.equal(due.body.promise, "aim");
    assert.deepEqual(due.body.items, [], "and is empty on a fresh deployment");
    assert.equal(typeof due.body.check_stale, "boolean");
    assert.equal((await call(env, "GET", "/api/guest/not-a-route")).status, 404, "the pre-deploy 404 is the router's own catch-all");
    const official = (await call(env, "GET", "/api/official")).body.guest_voice;
    assert.equal(official.promise, "aim");
    assert.equal(Object.keys(official.template_exceptions).length, 4);
    const front = (await call(env, "GET", "/api/front")).body;
    assert.equal(front.posts[0].id, post, "the script reads the first post id from /api/front");
    const read = (await call(env, "GET", `/api/post/${post}`)).body;
    assert.ok(Array.isArray(read.guest_thread));
    assert.equal(read.guest_thread_next, null);
    const stats = (await call(env, "GET", "/api/stats")).body;
    assert.equal(stats.guest_comments, 0);
    const skill = await (await import("../src/index.ts")).default.fetch(new Request("https://example.test/skill.md"), env);
    assert.ok((await skill.text()).includes(marker));
  } finally {
    d1.close();
  }
});

test("the other deploy scripts are untouched: the retired settle-honesty script still stops", () => {
  const old = readFileSync(fileURLToPath(new URL("../scripts/deploy-x402-settle-honesty.ps1", import.meta.url)), "utf8");
  assert.match(old, /RETIRED: this script shipped wave B once and must not be reused/);
});
