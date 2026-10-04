// scripts/deploy-m3-treasury.ps1 is written by the hub and run only by Ben. Proven here by what can be proven without running it: it parses
// under PowerShell's own parser and is ASCII; its steps are in the load-bearing order (fetch, pin, no-migration check, gates, probes, dry-run
// exit, deploy, version id, poll, attest, ride); the column list it checks on prod is migration 0017's; the marker allowlist it rides is the
// code's; and the forbidden keys it looks for are really absent from the list the code serves, even for a row that carries every one of them.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createLocalD1 } from "./helpers/local-d1.ts";
import { ATTENTION_MARKER_CODES, settlementsAttention } from "../src/settlement-attention.ts";

const SCRIPT_PATH = fileURLToPath(new URL("../scripts/deploy-m3-treasury.ps1", import.meta.url));
const script = readFileSync(SCRIPT_PATH, "utf8");
const migration0017 = readFileSync(fileURLToPath(new URL("../migrations/0017_settlement_claims.sql", import.meta.url)), "utf8");
const code = script
  .split(/\r?\n/)
  .filter((l) => !/^\s*#/.test(l))
  .join("\n");
const listOf = (name: string): string[] => {
  const m = code.match(new RegExp(`\\$${name} = @\\(([^)]*)\\)`));
  assert.ok(m, `the script must define $${name} as a list`);
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
};

test("deploy-m3-treasury.ps1 parses under PowerShell's own parser with zero errors, and is ASCII only", (t) => {
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

test("deploy-m3-treasury.ps1: one spelling per variable name, no stderr merged under Stop, and no write SQL", () => {
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
  assert.equal(/--file\b/.test(code), false, "this wave applies no migration file");
  for (const m of code.matchAll(/Invoke-D1Read "([^"]*)"/g)) assert.match(m[1], /^SELECT /, `D1 reads only: ${m[1]}`);
  assert.equal(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b/.test(code), false, "no write SQL anywhere in the script");
});

test("deploy-m3-treasury.ps1: the steps are in the load-bearing order", () => {
  const order = [
    "git fetch origin --quiet",
    "rev-parse --abbrev-ref HEAD",
    "-ExpectedCommit",
    "git status --porcelain",
    "git merge-base --is-ancestor $LIVE_BASE_COMMIT HEAD",
    "git diff --name-only $LIVE_BASE_COMMIT HEAD -- migrations schema.sql src/doc.ts",
    "npm test",
    "$attBefore = Read-Attest",
    "$routeBefore = Get-Text $NEW_CODE_URL",
    "pragma_table_info('settlement_claims')",
    "if ($DryRun)",
    "$deployOut = (npx wrangler deploy",
    "Current Version ID",
    "$poll = Get-Text $NEW_CODE_URL",
    "$attAfter = Read-Attest",
    "$FORBIDDEN_KEYS",
    "settlements_awaiting_a_person",
    "$BASE/treasury?before_entry_date=",
  ];
  let last = -1;
  for (const needle of order) {
    const i = code.indexOf(needle, last + 1);
    assert.ok(i > last, `step out of order or missing: ${needle}`);
    last = i;
  }
  assert.ok(code.indexOf("exit 0") < code.indexOf("$deployOut = (npx wrangler deploy"), "the dry run exits before the deploy");
});

test("deploy-m3-treasury.ps1: $CLAIM_COLUMN_NAMES are migration 0017's columns, every one", () => {
  const body = migration0017.slice(migration0017.indexOf("CREATE TABLE IF NOT EXISTS settlement_claims"));
  const cols = [...body.slice(0, body.indexOf(");")).matchAll(/^\s+([a-z_]+)\s+(TEXT|INTEGER)\b/gm)].map((m) => m[1]);
  assert.ok(cols.length >= 19, `parsed ${cols.length} columns from 0017`);
  assert.deepEqual(listOf("CLAIM_COLUMN_NAMES"), cols);
});

test("deploy-m3-treasury.ps1: $MARKER_CODES is the code's ATTENTION_MARKER_CODES, and the poll route is served", () => {
  assert.deepEqual(listOf("MARKER_CODES"), [...ATTENTION_MARKER_CODES]);
  const index = readFileSync(fileURLToPath(new URL("../src/index.ts", import.meta.url)), "utf8");
  assert.ok(index.includes('path === "/api/settlements/attention" && method === "GET"'));
  assert.ok(code.includes('$NEW_CODE_URL = "$BASE/api/settlements/attention"'));
});

test("deploy-m3-treasury.ps1: the forbidden keys it rides for are absent from the served list, for a row carrying every one of them", async () => {
  const d1 = createLocalD1();
  const now = Date.UTC(2026, 9, 4, 12);
  const old = now - 5 * 86_400_000;
  d1.raw
    .prepare(
      `INSERT INTO settlement_claims (network, asset, from_addr, nonce, route, intent_json, intent_hash, rpc_body, rpc_body_hash, valid_before, state, tx, payer, verdict_reason, booked_refs, created_at, updated_at, lease_owner, leased_until)
       VALUES ('base', 'usdc', '0xSECRETFROM', '0x01', 'register', '{"secret":"INTENTSECRET"}', 'ihash', 'RPCSECRET', 'rhash', ?, 'pending', NULL, '0xSECRETPAYER', 'VERDICTSECRET', '{}', ?, ?, 'LEASESECRET', NULL)`,
    )
    .run(old + 360_000, old, old);
  const served = JSON.stringify(await settlementsAttention(d1.DB as never, null, now));
  const listed = JSON.parse(served);
  assert.equal(listed.count, 1, "the aged pending row is listed (else this test proves nothing)");
  assert.equal(listed.entries[0].marker, "pending_aged");
  for (const key of listOf("FORBIDDEN_KEYS")) assert.equal(served.includes(`"${key}"`), false, `served key ${key}`);
  for (const secret of ["SECRETFROM", "INTENTSECRET", "RPCSECRET", "SECRETPAYER", "VERDICTSECRET", "LEASESECRET"]) assert.equal(served.includes(secret), false, `served value ${secret}`);
  d1.close();
});
