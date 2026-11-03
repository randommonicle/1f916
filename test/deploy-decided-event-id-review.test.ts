// Fix-pass tests for scripts/deploy-decided-event-id.ps1 after the code exchange round 1 (exchange/REVIEW_code-decided-event-id-2026-11-03.md): F1 transport, F3 window, F4 chains, F5 served pairs.
// Same discipline as test/deploy-decided-event-id-script.test.ts: the script is never run; its definitions are executed for real in PowerShell against captured inputs.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
const script = readFileSync(here("../scripts/deploy-decided-event-id.ps1"), "utf8").replace(/\r\n/g, "\n");
const code = script.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
const defs = script.slice(script.indexOf('$ErrorActionPreference = "Stop"'), script.indexOf("# END-OF-DEFINITIONS"));
const verifySql = readFileSync(here("../scripts/verify-decided-event-id.sql"), "utf8");

function runPs(lines: string[]): { code: number | null; out: string } | null {
  const dir = mkdtempSync(join(tmpdir(), "deploy-decided-event-id-review-"));
  try {
    const ps1 = join(dir, "harness.ps1");
    writeFileSync(ps1, lines.join("\r\n"));
    const r = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1], { encoding: "utf8" });
    if (r.error) return null;
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const q = (s: string): string => "'" + s.replace(/'/g, "''") + "'";
const harness = (statements: string[]): string[] => ["$ErrorActionPreference = 'Stop'", "$script:PreflightAt = $null", defs, ...statements];
const d1json = (rows: unknown[]): string => `[{"results":${JSON.stringify(rows)},"success":true,"meta":{}}]`;
const grab = (out: string, name: string): string | null => {
  const m = new RegExp("RESULT " + name + " \\[(.*)\\]").exec(out);
  return m ? m[1] : null;
};

// ---------- F1: reads go by --command; --file returns statistics only ----------

const FILE_STATS_SHAPE = JSON.stringify([{ "Total queries executed": 1, "Rows read": 12, "Rows written": 0, "Database size (MB)": "0.1" }]);

test("F1: every read goes by --command and --file is used only for the migration and the backfill (a regression to --file for a SELECT goes red)", () => {
  const fileLines = code.split("\n").filter((l) => l.includes("--file"));
  assert.equal(fileLines.length, 2, `exactly two --file uses: ${fileLines.join(" | ")}`);
  assert.ok(fileLines.some((l) => l.includes("$MIGRATION_PATH_EXPECTED")) && fileLines.some((l) => l.includes("$bf")), "the migration apply and the backfill re-run");
  assert.ok(code.includes('--remote --json --command"'), "reads use --command");
  assert.equal(code.includes("Invoke-D1File"), false, "the file reader is gone");
  assert.ok(code.includes("Invoke-D1Command (Get-Content $VERIFY_SQL_PATH -Raw)"), "the verification SQL is loaded from the checked-in file at run time");
});

test("F1: a reader fed the --file statistics shape fails closed on every read decision; the real --command shape (an array with one object carrying results) is accepted", (t) => {
  const run = runPs(
    harness([
      `Write-Host ("RESULT stats-pending [" + (Test-PendingPreflight (Read-D1Rows ${q(FILE_STATS_SHAPE)})) + "]")`,
      `Write-Host ("RESULT stats-verify [" + (Test-VerificationClean (Read-D1Rows ${q(FILE_STATS_SHAPE)})) + "]")`,
      `Write-Host ("RESULT stats-pairs [" + (Test-HistoricalPairs (Read-D1Rows ${q(FILE_STATS_SHAPE)})) + "]")`,
      `Write-Host ("RESULT stats-column [" + (Test-ColumnPresent (Read-D1Rows ${q(FILE_STATS_SHAPE)})) + "]")`,
      `Write-Host ("RESULT real [" + (Test-PendingPreflight (Read-D1Rows ${q(d1json([{ pending: 0 }]))})) + "]")`,
    ]),
  );
  if (!run) return t.skip("no PowerShell available");
  for (const n of ["stats-pending", "stats-verify", "stats-pairs", "stats-column"]) assert.ok((grab(run.out, n) ?? "").endsWith("no parsable result"), `${n}: ${run.out}`);
  assert.equal(grab(run.out, "real"), "");
});

test("F1: the verification file collapses to one single-quote-only line that is its statement; a double quote, a trailing comment and an all-comment file are refused", (t) => {
  const run = runPs(
    harness([
      `$one = ConvertTo-SingleLineSql ${q(verifySql)}`,
      'Write-Host ("RESULT why [" + (Test-SingleLineSql $one) + "]")',
      'Write-Host ("RESULT lines [" + ($one.Split("`n").Count) + "]")',
      'Write-Host ("RESULT starts [" + $one.Substring(0, 14) + "]")',
      `Write-Host ("RESULT dq [" + (Test-SingleLineSql (ConvertTo-SingleLineSql ${q('SELECT "a" FROM t')})) + "]")`,
      'Write-Host ("RESULT tail [" + (Test-SingleLineSql (ConvertTo-SingleLineSql "SELECT 1 -- note")) + "]")',
      'Write-Host ("RESULT empty [" + (Test-SingleLineSql (ConvertTo-SingleLineSql "-- only a comment")) + "]")',
    ]),
  );
  if (!run) return t.skip("no PowerShell available");
  assert.equal(grab(run.out, "why"), "", run.out);
  assert.equal(grab(run.out, "lines"), "1");
  assert.equal(grab(run.out, "starts"), "SELECT p.id, p");
  assert.match(grab(run.out, "dq") ?? "", /^the SQL contains a double quote/);
  assert.match(grab(run.out, "tail") ?? "", /^the SQL still contains '--'/);
  assert.equal(grab(run.out, "empty"), "the SQL is empty");
  assert.equal(verifySql.includes('"'), false, "the checked-in verification uses single quotes only");
});

test("F1: the transport carries the real verification statement to a child process byte for byte, percent signs and angle brackets included (cmd.exe never parses it)", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "deploy-decided-event-id-argv-"));
  try {
    const echo = join(dir, "echo-argv.js");
    writeFileSync(echo, "process.stdout.write(process.argv[2] === undefined ? 'NOARG' : process.argv[2]);\n");
    const run = runPs(
      harness([
        `$one = ConvertTo-SingleLineSql ${q(verifySql)}`,
        `$r = Invoke-BoundedSql ${q("node " + echo.split(String.fromCharCode(92)).join("/"))} $one 30`,
        'Write-Host ("RESULT code [" + $r.Code + "]")',
        'Write-Host ("RESULT same [" + ($r.Out -ceq $one) + "]")',
        'Write-Host ("RESULT pct [" + $one.Contains("%") + "|" + $one.Contains("<>") + "]")',
      ]),
    );
    if (!run) return t.skip("no PowerShell available");
    assert.equal(grab(run.out, "code"), "0", run.out);
    assert.equal(grab(run.out, "same"), "True", run.out);
    assert.equal(grab(run.out, "pct"), "True|True", "the statement under test really contains % and <>");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
