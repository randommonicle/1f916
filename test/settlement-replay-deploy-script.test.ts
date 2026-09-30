// scripts/deploy-settlement-replay-guard.ps1 is WRITTEN AND NEVER RUN by the builder (hard rule: no deploy, no wrangler
// command against anything remote). It is proven here by everything that can be proven without running it: it parses
// under PowerShell's own parser, it is ASCII, it has none of the traps the gate's L6 and the repo's L-080 family name, its
// steps are in the load-bearing order (fetch, pin, migration to the remote D1 FIRST, catalogue read, deploy, version id,
// propagation poll, attest), its column list is the migration's and schema.sql's, and the string it polls for is one only the
// new worker serves. Every one of these fails when the script is mutated (docs/CHECKPOINT-SETTLEMENT-REPLAY-GUARD.md).
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { callWorker, createLocalD1, json, stubFacilitator, testEnv } from "./helpers/settlement-harness.ts";

const SCRIPT_PATH = fileURLToPath(new URL("../scripts/deploy-settlement-replay-guard.ps1", import.meta.url));
const script = readFileSync(SCRIPT_PATH, "utf8");
const migration = readFileSync(fileURLToPath(new URL("../migrations/0017_settlement_claims.sql", import.meta.url)), "utf8");
const schema = readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8");
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
  const probe = spawnSync(
    "powershell",
    ["-NoProfile", "-Command", `$e = $null; $null = [System.Management.Automation.Language.Parser]::ParseFile('${SCRIPT_PATH}', [ref]$null, [ref]$e); $e.Count`],
    { encoding: "utf8" },
  );
  if (probe.error) {
    t.skip("powershell is not available on this machine; the static checks below still run");
    return;
  }
  assert.equal(probe.stdout.trim(), "0", `parse errors: ${probe.stdout}${probe.stderr}`);
});

test("no PowerShell traps: no two variables differing only by case ($COLS/$cols), no `$var:` drive reference, no stderr merged on a native command", () => {
  const names = new Map<string, Set<string>>();
  for (const m of code.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)) {
    const set = names.get(m[1].toLowerCase()) ?? new Set<string>();
    set.add(m[1]);
    names.set(m[1].toLowerCase(), set);
  }
  const clashes = [...names.values()].filter((s) => s.size > 1).map((s) => [...s].join(" / "));
  assert.deepEqual(clashes, [], "a variable name is case-insensitive in PowerShell: one spelling each");
  assert.equal(/\$[A-Za-z_][A-Za-z0-9_]*:/.test(code.replace(/\$\(/g, "")), false, '"$var:" is a drive reference: write "${var}:"');
  // 2>&1 is only ever used inside a block that has set ErrorActionPreference to Continue.
  for (const m of code.matchAll(/2>&1/g)) {
    const before = code.slice(0, m.index);
    const lastContinue = before.lastIndexOf('$ErrorActionPreference = "Continue"');
    const lastStop = before.lastIndexOf('$ErrorActionPreference = "Stop"');
    assert.ok(lastContinue > lastStop, "a native command's stderr is merged only while ErrorActionPreference is Continue");
  }
  assert.equal(/-notmatch\s+"[^"]*"\s*\)?\s*\{/.test(code) && /\$\w+\s*\|\s*Where-Object[^\n]*-notmatch/.test(code), false, "no -notmatch over a pipeline of lines");
});

test("parameters: -ExpectedCommit is mandatory; -DryRun and -MigrationAlreadyApplied exist", () => {
  assert.match(script, /\[Parameter\(Mandatory = \$true\)\]\[string\]\$ExpectedCommit/);
  assert.match(script, /\[switch\]\$DryRun/);
  assert.match(script, /\[switch\]\$MigrationAlreadyApplied/);
});

test("the steps are in the load-bearing order: fetch, pin, gates, probes, (dry-run exit), migration to the REMOTE D1, catalogue, deploy, version id, poll, attest, ride", () => {
  const order = [
    "git fetch origin --quiet",
    "rev-parse --abbrev-ref HEAD",
    "origin/main",
    "-ExpectedCommit",
    "git status --porcelain",
    "npm test",
    "$attBefore = Read-Attest",
    "if ($DryRun) {",
    "d1 execute commonhold --remote --file $migrationPath",
    "pragma_table_info('settlement_claims')",
    "$deployOut = (npx wrangler deploy",
    "Current Version ID",
    "$NEW_CODE_MARKER)",
    "Assert-Attest $attAfter",
  ];
  let last = -1;
  for (const needle of order) {
    const i = code.indexOf(needle, last + 1);
    assert.ok(i > last, `"${needle}" must come after the previous step (found at ${i}, previous at ${last})`);
    last = i;
  }
  // the dry run exits before anything remote is written: before the migration, and before the deploy
  const dryExit = code.indexOf("exit 0", at("if ($DryRun) {"));
  assert.ok(dryExit > 0 && dryExit < at("d1 execute commonhold --remote --file"), "-DryRun exits before the migration");
  assert.ok(dryExit < at("$deployOut = (npx wrangler deploy"), "-DryRun exits before the deploy");
  // exactly one remote write of each kind
  assert.equal(code.split("d1 execute commonhold --remote --file").length - 1, 1, "one remote migration apply");
  assert.equal(code.split("$deployOut = (npx wrangler deploy").length - 1, 1, "one deploy");
  // every stop before the deploy: the migration apply failure, the catalogue mismatch
  assert.ok(at("Stop-Here \"migration 0017 failed") < at("$deployOut = (npx wrangler deploy"));
});

test("it stops unless main, origin/main and -ExpectedCommit are ONE commit, after a fetch, on a clean tree (gate L6: it pinned nothing and fetched nothing)", () => {
  assert.match(code, /if \(\$branch -ne "main"\)/);
  assert.match(code, /\$mainSha -ne \$originSha -or \$mainSha -ne \$expectedSha -or \$headSha -ne \$expectedSha/);
  assert.match(code, /git status --porcelain/);
  assert.ok(at("git fetch origin --quiet") < at("git rev-parse origin/main"), "origin/main is read AFTER the fetch");
});

test("it stops if migration 0017 is already applied unless -MigrationAlreadyApplied, and the flag is an assertion that the table exists", () => {
  assert.match(code, /if \(\$tablePresent -and -not \$MigrationAlreadyApplied\) \{ Stop-Here/);
  assert.match(code, /if \(-not \$tablePresent -and \$MigrationAlreadyApplied\) \{ Stop-Here/);
  assert.match(code, /if \(-not \$MigrationAlreadyApplied\) \{[\s\S]*d1 execute commonhold --remote --file/, "the apply is skipped only under the flag");
});

test("it is reusable: it does not gate on a literal that the deployed wave itself makes true (gate L6/C2 stopped on outputSchema)", () => {
  assert.equal(/outputSchema/.test(code), false);
  // The only pre-deploy probe of live code is that the marker is ABSENT, which is what makes the later poll mean something.
  assert.match(code, /if \(\$frontBefore\.Body\.Contains\(\$NEW_CODE_MARKER\)\) \{ Stop-Here/);
});

test("the catalogue check covers every B1 column in order, the primary key, the B7 CHECK and the index: the script's lists are the migration's and schema.sql's", () => {
  const listed = (name: string) => [...(new RegExp(`\\$${name} = @\\(([^)]*)\\)`).exec(script)?.[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  const scriptColumns = listed("CLAIM_COLUMN_NAMES");
  const scriptPk = listed("CLAIM_PK_NAMES");
  for (const [label, sql] of [["migration 0017", migration], ["schema.sql", schema]] as const) {
    const body = /CREATE TABLE IF NOT EXISTS settlement_claims \(([\s\S]*?)\n\);/.exec(sql)?.[1] ?? "";
    const cols = body
      .split("\n")
      .map((l) => /^\s{2}([a-z_]+)\s+(TEXT|INTEGER)\b/.exec(l)?.[1])
      .filter((c): c is string => !!c);
    assert.deepEqual(scriptColumns, cols, `the script's column list is ${label}'s, in table order`);
    const pk = /PRIMARY KEY \(([^)]*)\)/.exec(body)?.[1].split(",").map((s) => s.trim());
    assert.deepEqual(scriptPk, pk, `the script's primary key is ${label}'s`);
    assert.ok(body.includes("CHECK (state IN ('pending', 'settled_unbooked') OR rpc_body IS NULL)"), `${label} carries the B7 CHECK`);
  }
  assert.equal(scriptColumns.length, 19);
  assert.ok(script.includes("CHECK (state IN ('pending', 'settled_unbooked') OR rpc_body IS NULL)"), "the script verifies the same CHECK text");
  assert.match(code, /idx_settlement_claims_open/);
  assert.match(migration, /CREATE INDEX IF NOT EXISTS idx_settlement_claims_open/);
});

test("it captures the wrangler version id and stops if there is none; the propagation poll waits for a string only this wave serves, and the script verifies non-minting (v5, template hash, every chain ok)", () => {
  assert.match(code, /Current Version ID:/);
  assert.match(code, /if \(-not \$versionId\) \{ Stop-Here/);
  assert.match(code, /fa11788d062b0c6d23c54c428c1c9649d263ae3ba704e602e122066926049491/);
  assert.match(code, /\$att\.ok -ne \$true/);
  for (const chain of ["identity_log", "treasury", "payouts", "ballots"]) assert.ok(code.includes(`"${chain}"`), `the ${chain} chain is checked`);
  assert.match(code, /\[string\]\$att\.constitution\.version -ne "5"/);
});

test("the strings the script waits for and probes are really served by the new code (L-109: a poll target is tested, not assumed)", async () => {
  const marker = /\$NEW_CODE_MARKER = "([^"]+)"/.exec(script)?.[1] ?? "";
  const probeMarker = /\$NEW_402_MARKER = "([^"]+)"/.exec(script)?.[1] ?? "";
  assert.equal(marker, "pilot PAUSED");
  assert.ok(probeMarker.length > 10);
  const d1 = createLocalD1();
  const stub = stubFacilitator();
  try {
    const front = await (await callWorker(new Request("https://example.test/"), testEnv(d1))).text();
    assert.ok(front.includes(marker), "GET / serves the marker");
    const register = await callWorker(new Request("https://example.test/api/register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ handle: "ride-probe-202609301200", model: "ride-probe" }) }), testEnv(d1));
    assert.equal(register.status, 402, "the unpaid register probe is a 402 challenge");
    assert.ok(JSON.stringify(await json(register)).includes(probeMarker), "and it carries the public_key advice");
    assert.equal(d1.raw.prepare("SELECT COUNT(*) AS n FROM settlement_claims").get()?.n, 0, "the unpaid probe writes no claim");
    assert.equal(d1.raw.prepare("SELECT COUNT(*) AS n FROM citizens").get()?.n, 0, "and creates nothing");
    assert.equal(stub.calls.settle, 0);
  } finally {
    stub.restore();
    d1.close();
  }
});

test("the other deploy scripts are untouched: the retired settle-honesty script still stops (C2)", () => {
  const old = readFileSync(fileURLToPath(new URL("../scripts/deploy-x402-settle-honesty.ps1", import.meta.url)), "utf8");
  assert.match(old, /RETIRED: this script shipped wave B once and must not be reused/);
});
