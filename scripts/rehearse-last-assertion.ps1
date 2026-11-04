# Rehearses last_assertion_at through the REAL Worker D1 binding on the SCRATCH database (brief A5 and A8). A SQL-only wrangler run cannot prove the JavaScript catch in authenticateByAssertion, so this applies
# migration 0024 to the scratch database, starts scripts/assertion-rehearsal-worker under `wrangler dev --remote`, calls its route (which runs the real authenticate() with a throwaway key and a scratch citizen),
# prints every named check, stops wrangler, and exits non-zero on any miss. PASS is printed only when the route answered, every expected check is present and every check passed.
# BEN'S HAND ONLY (wrangler prompts). THE SCRATCH DATABASE ONLY: the database name is pinned below, the script refuses any other name, and the worker config is checked to bind that one database and no other.
# This script deploys nothing and writes no production data. A pass here is evidence for Ben's own confirmation flag on the deploy script; it does not set that flag.
# Run from the repo root:
#   powershell -ExecutionPolicy Bypass -File scripts\rehearse-last-assertion.ps1
# A re-run is safe: the migration is applied only when the column is absent, and the worker deletes its scratch citizen and nonce rows in finally.
# PowerShell 5.1 traps this file avoids: one spelling per variable name; "$var:" is a drive reference; never merge a native command's stderr under ErrorActionPreference Stop; every READ goes to wrangler by --command
# as one single-quote-only line. ASCII only.
param(
  [string]$Database = "commonhold-migtest",
  [int]$Port = 8798
)
$ErrorActionPreference = "Stop"
$SCRATCH_DB = "commonhold-migtest"
$SCRATCH_ID = "465f489c-f1ca-446e-8f5f-d35ea53fd720"
$CONFIG_PATH = "scripts/assertion-rehearsal-worker/wrangler.jsonc"
$MIGRATION_PATH = "migrations/0024_last_assertion_at.sql"
$WRANGLER_D1_SECONDS = 120
$START_WAIT_SECONDS = 120
$RUN_SECONDS = 120
$EXPECTED_CHECKS = @(
  "c1 first spend returns the citizen", "c1 stamp is a server time inside the call", "c1 one namespaced nonce row",
  "c2 replay is the existing 401", "c2 stamp unchanged by the replay", "c2 nonce rows unchanged",
  "c3a raw-nonce collision is the existing 401", "c3a stamp unchanged", "c3a no namespaced row", "c3a nonce rows unchanged",
  "c3b raw-nonce collision is the existing 401", "c3b stamp unchanged", "c3b no namespaced row", "c3b nonce rows unchanged",
  "c4 bad signature is a 401", "c4 no stamp", "c4 no nonce row",
  "c5 the failing batch threw", "c5 no nonce row survived the failing batch",
  "c6 rows_written reported for both statements", "c6 the stamp landed"
)

function Stop-Here($msg) { Write-Host "[STOP] $msg"; exit 1 }
function Say($msg) { Write-Host $msg }
# "" when $name is exactly the scratch database, otherwise the reason it is refused.
function Test-ScratchTarget($name) {
  if ([string]$name -cne $SCRATCH_DB) { return ("the database name is '" + $name + "', and this rehearsal only ever runs against " + $SCRATCH_DB) }
  return ""
}
# "" when the worker config binds exactly one D1 database, the scratch one by name and id, for both the binding and the preview, otherwise the reason.
function Test-RehearsalConfig($jsoncText) {
  $kept = @()
  foreach ($line in (([string]$jsoncText).Replace("`r`n", "`n").Split("`n"))) {
    if ($line.Trim().StartsWith("//")) { continue }
    $kept += $line
  }
  try { $cfg = (($kept -join "`n") | ConvertFrom-Json) } catch { return "the worker config is not valid JSON" }
  $dbs = @($cfg.d1_databases)
  if ($dbs.Count -ne 1) { return ("the worker config binds " + $dbs.Count + " D1 databases, expected exactly 1") }
  if ([string]$dbs[0].database_name -cne $SCRATCH_DB) { return ("the worker config binds '" + $dbs[0].database_name + "', not " + $SCRATCH_DB) }
  if ([string]$dbs[0].database_id -cne $SCRATCH_ID) { return ("the worker config database_id is '" + $dbs[0].database_id + "', not the scratch id") }
  if ([string]$dbs[0].preview_database_id -cne $SCRATCH_ID) { return ("the worker config preview_database_id is '" + $dbs[0].preview_database_id + "', not the scratch id") }
  if ($null -ne $cfg.triggers) { return "the worker config declares triggers" }
  return ""
}
function Invoke-Bounded($commandLine, $seconds) {
  $outFile = [System.IO.Path]::GetTempFileName()
  try {
    $p = Start-Process -FilePath "cmd.exe" -ArgumentList ("/c " + $commandLine + " > `"" + $outFile + "`"") -NoNewWindow -PassThru
    $null = $p.Handle
    if (-not $p.WaitForExit($seconds * 1000)) {
      taskkill.exe /PID $p.Id /T /F | Out-Null
      return @{ Code = -1; Out = ""; TimedOut = $true }
    }
    $text = (Get-Content $outFile -Raw -ErrorAction SilentlyContinue)
    if ($null -eq $text) { $text = "" }
    return @{ Code = $p.ExitCode; Out = $text; TimedOut = $false }
  } finally {
    Remove-Item $outFile -ErrorAction SilentlyContinue
  }
}
# The rows of `wrangler d1 execute --json` output as @{ Rows = <array> }, or $null when the output is not the expected JSON (a failed read, never zero rows).
function Read-D1Rows($text) {
  $i = ([string]$text).IndexOf("[")
  if ($i -lt 0) { return $null }
  try { $parsed = (([string]$text).Substring($i) | ConvertFrom-Json) } catch { return $null }
  if ($null -eq $parsed -or @($parsed).Count -lt 1 -or $null -eq @($parsed)[0].results) { return $null }
  return @{ Rows = @(@($parsed)[0].results) }
}
# One READ against the scratch database by --command (single-quote-only SQL), bounded. Returns the parsed rows or STOPS.
function Invoke-ScratchRead($sql, $label) {
  $why = Test-ScratchTarget $Database
  if ($why -ne "") { Stop-Here $why }
  if (([string]$sql).Contains('"')) { Stop-Here ("the SQL for " + $label + " contains a double quote") }
  $env:D1_SQL_ARG = $sql
  try {
    $r = Invoke-Bounded ("npx wrangler d1 execute " + $SCRATCH_DB + ' --remote --json --command "%D1_SQL_ARG%"') $WRANGLER_D1_SECONDS
  } finally {
    Remove-Item Env:D1_SQL_ARG -ErrorAction SilentlyContinue
  }
  if ($r.TimedOut) { Stop-Here ("wrangler d1 execute timed out after " + $WRANGLER_D1_SECONDS + " s on " + $label) }
  if ($r.Code -ne 0) { Stop-Here ("wrangler d1 execute failed (exit " + $r.Code + ") on " + $label) }
  $res = Read-D1Rows $r.Out
  if ($null -eq $res) { Stop-Here ("the read for " + $label + " returned no parsable result") }
  return $res
}
# "" when the report is a complete pass: it parsed, carries every expected check exactly once, every check passed, and report.pass is true. Otherwise the first reason.
function Test-RehearsalReport($report) {
  if ($null -eq $report) { return "the rehearsal route did not return JSON" }
  if ($null -ne $report.error -and [string]$report.error -ne "") { return ("the rehearsal route reported an error: " + $report.error) }
  $checks = @($report.checks)
  foreach ($name in $EXPECTED_CHECKS) {
    $found = @($checks | Where-Object { [string]$_.name -ceq $name })
    if ($found.Count -eq 0) { return ("check '" + $name + "' did not run") }
    if ($found.Count -gt 1) { return ("check '" + $name + "' ran " + $found.Count + " times") }
  }
  foreach ($c in $checks) {
    if ($c.pass -ne $true) { return ("check '" + $c.name + "' failed: expected " + ($c.expected | ConvertTo-Json -Compress) + ", got " + ($c.actual | ConvertTo-Json -Compress)) }
  }
  if ($report.pass -ne $true) { return "the route's own pass flag is not true" }
  if ($null -eq $report.rows_written_per_statement) { return "rows_written was not recorded" }
  return ""
}
function Get-Text($url, $maxTime) {
  $tmp = [System.IO.Path]::GetTempFileName()
  try {
    $meta = (curl.exe -s --max-time $maxTime -o $tmp -w "%{http_code}" $url)
    $body = (Get-Content $tmp -Raw -ErrorAction SilentlyContinue)
    if ($null -eq $body) { $body = "" }
    return @{ Code = [string]$meta; Body = $body }
  } finally {
    Remove-Item $tmp -ErrorAction SilentlyContinue
  }
}
# END-OF-DEFINITIONS (nothing above runs wrangler or the network)

# 0. the target: the scratch database by exact name, and a worker config that binds that one database and nothing else
$why = Test-ScratchTarget $Database
if ($why -ne "") { Stop-Here $why }
foreach ($path in $CONFIG_PATH, $MIGRATION_PATH) {
  if (-not (Test-Path $path)) { Stop-Here ("$path is missing: run this from the repo root.") }
}
$why = Test-RehearsalConfig (Get-Content $CONFIG_PATH -Raw)
if ($why -ne "") { Stop-Here $why }
Say ("[target] " + $SCRATCH_DB + " (" + $SCRATCH_ID + "), config " + $CONFIG_PATH)

# 1. the scratch database: the tables the real authenticate() touches, then migration 0024 only if the column is absent
$tables = Invoke-ScratchRead "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('citizens','auth_nonces')" "the tables read"
if (@($tables.Rows).Count -ne 2) { Stop-Here ("the scratch database has " + @($tables.Rows).Count + " of citizens and auth_nonces: load it with the production schema first.") }
$colSql = "SELECT name, type FROM pragma_table_info('citizens') WHERE name = 'last_assertion_at'"
$col = Invoke-ScratchRead $colSql "the column read"
if (@($col.Rows).Count -eq 0) {
  Say "[d1] applying $MIGRATION_PATH to the scratch database"
  $mig = Invoke-Bounded ("npx wrangler d1 execute " + $SCRATCH_DB + " --remote --file " + $MIGRATION_PATH) $WRANGLER_D1_SECONDS
  if ($mig.TimedOut) { Stop-Here "the migration timed out after $WRANGLER_D1_SECONDS s; read the column by hand before any retry." }
  if ($mig.Code -ne 0) { Stop-Here "the migration failed (exit $($mig.Code)); read the column by hand before any retry." }
  $col = Invoke-ScratchRead $colSql "the column read after the migration"
} else {
  Say "[d1] citizens.last_assertion_at is already on the scratch database; the migration is not re-applied"
}
if (@($col.Rows).Count -ne 1 -or [string]@($col.Rows)[0].type -cne "INTEGER") { Stop-Here "citizens.last_assertion_at is not present as INTEGER on the scratch database." }
Say "[d1] citizens.last_assertion_at present (INTEGER)"

# 2. the worker: wrangler dev --remote on a local port, the route called, wrangler stopped in finally
$logOut = [System.IO.Path]::GetTempFileName()
$logErr = [System.IO.Path]::GetTempFileName()
$dev = $null
$report = $null
$routeNote = ""
try {
  $devArgs = "/c npx wrangler dev --remote --config " + $CONFIG_PATH + " --port " + $Port
  Say ("[dev] starting: npx wrangler dev --remote --config " + $CONFIG_PATH + " --port " + $Port)
  $dev = Start-Process -FilePath "cmd.exe" -ArgumentList $devArgs -NoNewWindow -PassThru -RedirectStandardOutput $logOut -RedirectStandardError $logErr
  $url = "http://127.0.0.1:" + $Port + "/run"
  $deadline = (Get-Date).AddSeconds($START_WAIT_SECONDS)
  $up = $false
  while ((Get-Date) -lt $deadline) {
    if ($dev.HasExited) { $routeNote = "wrangler dev exited early (code " + $dev.ExitCode + ")"; break }
    $probe = Get-Text ("http://127.0.0.1:" + $Port + "/") 5
    if ($probe.Code -cne "000") { $up = $true; break }
    Start-Sleep -Seconds 3
  }
  if ($up) {
    $r = Get-Text $url $RUN_SECONDS
    Say ("[run] GET " + $url + " -> " + $r.Code)
    try { $report = ($r.Body | ConvertFrom-Json) } catch { $routeNote = "the route's answer was not JSON (HTTP " + $r.Code + ")" }
  } elseif ($routeNote -eq "") {
    $routeNote = "wrangler dev did not answer within " + $START_WAIT_SECONDS + " s"
  }
} finally {
  if ($null -ne $dev -and -not $dev.HasExited) { taskkill.exe /PID $dev.Id /T /F | Out-Null }
  if ($routeNote -ne "") {
    $tail = (Get-Content $logOut -Tail 15 -ErrorAction SilentlyContinue) -join " | "
    Say ("[dev] log tail: " + $tail)
  }
  Remove-Item $logOut -ErrorAction SilentlyContinue
  Remove-Item $logErr -ErrorAction SilentlyContinue
}
Say "[dev] wrangler stopped"
if ($routeNote -ne "") { Stop-Here $routeNote }

# 3. the checks, one line each, then the verdict
foreach ($c in @($report.checks)) {
  $mark = "FAIL"
  if ($c.pass -eq $true) { $mark = "ok  " }
  Say ("[" + $mark + "] " + $c.name + " | expected " + ($c.expected | ConvertTo-Json -Compress) + " | actual " + ($c.actual | ConvertTo-Json -Compress))
}
if ($null -ne $report.c5_note) { Say ("[note] " + $report.c5_note) }
Say ("[rows_written] per statement of one spend (nonce INSERT, stamp UPDATE): " + ($report.rows_written_per_statement | ConvertTo-Json -Compress))
if ($null -ne $report.cleanup_rows_deleted) { Say ("[cleanup] rows deleted: " + ($report.cleanup_rows_deleted | ConvertTo-Json -Compress)) }
$why = Test-RehearsalReport $report
if ($why -ne "") { Stop-Here ("FAIL: " + $why) }
Say "PASS: every check ran and passed against the scratch binding. Record the rows_written line in the checkpoint; the deploy script's confirmation flag stays Ben's own assertion."
exit 0
