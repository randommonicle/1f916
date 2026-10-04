// scripts/deploy-m3-treasury.ps1 is written by the hub and run only by Ben. Proven here by what can be proven without running it: it parses
// under PowerShell's own parser and is ASCII; its steps are in the load-bearing order (fetch, pin, no-migration check, gates, probes, dry-run
// exit, deploy, version id, poll, attest, ride); the column list it checks on prod is migration 0017's; the marker allowlist it rides is the
// code's; and the forbidden keys it looks for are really absent from the list the code serves, even for a row that carries every one of them.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { classifyParseRun, parsePowerShellFile } from "./helpers/ps-parse.ts";
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
  const parsed = parsePowerShellFile(SCRIPT_PATH);
  if (!parsed.available) {
    t.skip(`${parsed.reason}; the static checks below still run`);
    return;
  }
  assert.equal(parsed.errors, 0, `parse errors: ${parsed.detail}`);
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
       VALUES ('base', 'usdc', '0xSECRETFROM', '0x01', 'register', '{"secret":"INTENTSECRET"}', 'IHASHSECRET', 'RPCSECRET', 'RHASHSECRET', ?, 'pending', NULL, '0xSECRETPAYER', 'VERDICTSECRET', '{}', ?, ?, 'LEASESECRET', NULL)`,
    )
    .run(old + 360_000, old, old);
  const served = JSON.stringify(await settlementsAttention(d1.DB as never, null, now));
  const listed = JSON.parse(served);
  assert.equal(listed.count, 1, "the aged pending row is listed (else this test proves nothing)");
  assert.equal(listed.entries[0].marker, "pending_aged");
  for (const key of listOf("FORBIDDEN_KEYS")) assert.equal(served.includes(`"${key}"`), false, `served key ${key}`);
  for (const secret of ["SECRETFROM", "INTENTSECRET", "RPCSECRET", "SECRETPAYER", "VERDICTSECRET", "LEASESECRET", "IHASHSECRET", "RHASHSECRET"]) assert.equal(served.includes(secret), false, `served value ${secret}`);
  d1.close();
});

test("deploy-m3-treasury.ps1: $LEDGER_PAGE_SIZE is the code's LEDGER_PAGE", async () => {
  const { LEDGER_PAGE } = await import("../src/society.ts");
  const m = code.match(/\$LEDGER_PAGE_SIZE = (\d+)/);
  assert.ok(m);
  assert.equal(Number(m[1]), LEDGER_PAGE);
});

test("deploy-m3-treasury.ps1: every git read whose output is judged checks its exit code first (CODEX deploy-script r1, finding 1)", () => {
  const lines = code.split("\n");
  const reads = lines.map((l, i) => [l, i] as const).filter(([l]) => /= @\(git /.test(l));
  assert.ok(reads.length >= 2, "the clean-tree and no-migration reads are found");
  for (const [l, i] of reads) assert.match(lines[i + 1], /^if \(\$LASTEXITCODE -ne 0\) \{ Stop-Here/, `no exit check after: ${l}`);
});

// The treasury ride block, run for real in PowerShell with the network replaced by fixtures (CODEX deploy-script r1, finding 2).
const ledgerRows = (n: number) =>
  Array.from({ length: n }, (_, k) => {
    const id = n - k;
    return { id, entry_date: `2026-09-${String(10 + Math.floor(id / 2)).padStart(2, "0")}` };
  });
const goodPage = (n: number) => ({ total_entries: n, returned: Math.min(n, 200), page_size: 200, has_more: n > 200, entries: ledgerRows(n).slice(0, 200) });
const runTreasuryRide = (t: { skip: (m: string) => void }, fixture: unknown): { code: number | null; out: string } | null => {
  const start = code.indexOf('$tre = Get-Json "$BASE/treasury"');
  const endNeedle = 'Say "[ride] GET /treasury with half a cursor -> 400"';
  const end = code.indexOf(endNeedle);
  assert.ok(start > 0 && end > start, "the treasury ride block is found");
  const block = code.slice(start, end + endNeedle.length);
  const dir = mkdtempSync(join(tmpdir(), "m3t-ride-"));
  const fx = join(dir, "fixture.json");
  writeFileSync(fx, JSON.stringify(fixture));
  const harness = [
    '$ErrorActionPreference = "Stop"',
    '$BASE = "https://example.invalid"',
    '$versionId = "test-version"',
    "$LEDGER_PAGE_SIZE = 200",
    'function Stop-Here($msg) { Write-Host "[STOP] $msg"; exit 1 }',
    "function Say($msg) { Write-Host $msg }",
    `$fixture = (Get-Content -Raw '${fx}' | ConvertFrom-Json)`,
    "$attAfter = $fixture.att",
    'function Get-Json($url) { if ($url -like "*before_entry_date*") { return $fixture.page2 }; return $fixture.page1 }',
    "function Get-Text($url, $maxTime) { return @{ Code = [string]$fixture.halfCode; Body = '' } }",
    block,
    'Write-Host "REACHED-END"',
    "exit 0",
  ].join("\r\n");
  const ps1 = join(dir, "ride.ps1");
  writeFileSync(ps1, harness);
  const r = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1], { encoding: "utf8" });
  rmSync(dir, { recursive: true, force: true });
  if (r.error) {
    t.skip("powershell is not available on this machine");
    return null;
  }
  return { code: r.status, out: r.stdout + r.stderr };
};
const older = (n: number) => ({ ...goodPage(n - 1), total_entries: n, entries: ledgerRows(n).slice(1, 201) });

test("deploy-m3-treasury.ps1 treasury ride: a true 18-row ledger passes to the end", (t) => {
  const r = runTreasuryRide(t, { att: { treasury: { total_rows: 18 } }, page1: goodPage(18), page2: older(18), halfCode: "400" });
  if (!r) return;
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /REACHED-END/);
});

test("deploy-m3-treasury.ps1 treasury ride: impossible or inconsistent pages STOP before the end", (t) => {
  const base = { att: { treasury: { total_rows: 18 } }, page1: goodPage(18), page2: older(18), halfCode: "400" };
  const cases: Record<string, unknown> = {
    "CODEX's empty page": { ...base, page1: { total_entries: 0, returned: 0, page_size: 0, has_more: true, entries: [] } },
    "total differs from the chain": { ...base, att: { treasury: { total_rows: 19 } } },
    "has_more true at 18 rows": { ...base, page1: { ...goodPage(18), has_more: true, next_before_entry_date: "2026-09-10", next_before_id: 1 } },
    "a short first page": { ...base, page1: { ...goodPage(18), returned: 17, entries: ledgerRows(18).slice(0, 17) } },
    "a continuation with has_more false": { ...base, page1: { ...goodPage(18), next_before_id: 1 } },
    "a short cursor page": { ...base, page2: { ...older(18), entries: ledgerRows(18).slice(1, 10) } },
    "half a cursor accepted": { ...base, halfCode: "200" },
  };
  for (const [name, fixture] of Object.entries(cases)) {
    const r = runTreasuryRide(t, fixture);
    if (!r) return;
    assert.equal(r.code, 1, `${name}: ${r.out}`);
    assert.match(r.out, /\[STOP\]/, name);
    assert.doesNotMatch(r.out, /REACHED-END/, name);
  }
});

test("the shared parse helper can fail: a broken script reports its errors, and a parser that never ran is an error, not a clean parse (CODEX deploy-script r2)", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ps-parse-"));
  try {
    const broken = join(dir, "broken.ps1");
    writeFileSync(broken, "if ($x -eq 1 {\r\n  Write-Host 'unclosed'\r\n");
    const parsed = parsePowerShellFile(broken);
    if (!parsed.available) {
      t.skip(parsed.reason);
      return;
    }
    assert.ok(parsed.errors > 0, `a broken script must report errors: ${parsed.detail}`);
    const missing = parsePowerShellFile(join(dir, "no-such-file.ps1"));
    assert.ok(missing.available && missing.errors > 0, "a missing file is a parse error, never a clean parse");
    // CODEX r2's reproduction of the old probe's false pass, and the other ways a run can fail to reach the parser.
    assert.equal(classifyParseRun(0, "0\r\n", "Cannot create type. Only core types are supported in this language mode.").available, false);
    assert.throws(() => classifyParseRun(0, "0\r\n", ""), /did not run/);
    assert.throws(() => classifyParseRun(0, "NOPARSE\r\n", ""), /did not run/);
    assert.throws(() => classifyParseRun(1, "ERRORS=0\r\n", "boom"), /did not run/);
    assert.deepEqual(classifyParseRun(0, "ERRORS=0\r\n", ""), { available: true, errors: 0, detail: "ERRORS=0\r\n" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
