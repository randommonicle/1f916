# Rehearses last_assertion_at AND the assertion objection (D-078 item 4 option B, brief AO3) through the REAL Worker D1 binding on the SCRATCH database (brief A5 and A8). A SQL-only wrangler run cannot prove the JavaScript catch in authenticateByAssertion, so this applies
# migrations 0024 and 0025 to the scratch database (each ONLY if its own column is absent: the state '0024 present, 0025 absent' works, an apply failure stops the run, a re-run resumes), starts scripts/assertion-rehearsal-worker under `wrangler dev --remote`, calls its route (which runs the real authenticate() with a throwaway key and a scratch citizen),
# prints every named check, stops wrangler, and exits non-zero on any miss. PASS is printed only when the route answered, every expected check is present and every check passed.
# BEN'S HAND ONLY (wrangler prompts). THE SCRATCH DATABASE ONLY: the database name is pinned below, the script refuses any other name, and the worker config is checked to bind that one database and no other.
# This script deploys nothing and writes no production data. A pass here is evidence for Ben's own confirmation flag on the deploy script; it does not set that flag.
# Run from the repo root:
#   powershell -ExecutionPolicy Bypass -File scripts\rehearse-last-assertion.ps1
# A re-run is safe: each migration is applied only when its own column is absent, and the worker deletes its scratch citizen and nonce rows in finally.
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
$MIGRATION_PATH_0024 = "migrations/0024_last_assertion_at.sql"
$MIGRATION_PATH_0025 = "migrations/0025_assertion_objection.sql"
$WRANGLER_D1_SECONDS = 120
$START_WAIT_SECONDS = 120
$RUN_SECONDS = 120
$EXPECTED_DATABASE = "commonhold-migtest (scratch)"
$EXPECTED_CHECKS = @(
  "c1 first spend returns the citizen", "c1 stamp is the UTC day start of the call", "c1 one namespaced nonce row", "c1b an earlier sampled day does not lower a future stamp", "c1c the stamp statement for the stored day changes no row",
  "c2 replay is the existing 401", "c2 stamp unchanged by the replay", "c2 nonce rows unchanged",
  "c3a raw-nonce collision is the existing 401", "c3a stamp unchanged", "c3a no namespaced row", "c3a nonce rows unchanged",
  "c3b raw-nonce collision is the existing 401", "c3b stamp unchanged", "c3b no namespaced row", "c3b nonce rows unchanged",
  "c4 bad signature is a 401", "c4 no stamp", "c4 no nonce row",
  "c0 the scratch citizen was created with a row id",
  "c5 the duplicate-insert batch threw", "c5 no nonce row survived the duplicate-insert batch",
  "c5b the missing-column batch threw", "c5b no nonce row survived the missing-column batch",
  "c7 concurrent spends: exactly one citizen", "c7 concurrent spends: exactly one replay 401", "c7 concurrent spends: exactly one nonce row",
  "c6 rows_written reported for both statements", "c6 the stamp landed",
  "c8a a stamp is committed before the uphold", "c8a the uphold changed exactly one row", "c8a the uphold cleared the stamp and set the flag",
  "c8b a flagged seat authenticates", "c8b a flagged seat spends its nonce", "c8b a flagged seat is not stamped", "c8b the flagged spend added exactly one nonce row",
  "c8c a replay on a flagged seat is the existing 401", "c8c the replay wrote nothing",
  "c8d the withdraw changed exactly one row", "c8d the withdraw cleared the flag and left the value NULL", "c8d the next assertion stamps again",
  "cleanup removed the scratch citizen and its nonce rows"
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
  $changes = $null
  $meta = @($parsed)[0].meta
  if ($null -ne $meta -and $null -ne $meta.PSObject.Properties["changes"]) { $changes = $meta.changes }
  return @{ Rows = @(@($parsed)[0].results); Changes = $changes }
}
# One statement against the scratch database by --command (single-quote-only SQL), bounded. Returns the parsed result (Rows, and Changes from meta.changes) or STOPS. Used for reads and for the one transport check.
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
# The operator's uphold statement, verbatim from scripts/assertion-objection.ps1 (a test pins that), sent below with a handle that does not exist (re-gate C3).
$UPHOLD_SQL_TEMPLATE = "UPDATE citizens SET assertion_objected_at = COALESCE(assertion_objected_at, CAST(strftime('%s','now') AS INTEGER) * 1000), last_assertion_at = NULL WHERE handle = '@HANDLE@' AND public_key IS NOT NULL"
$ABSENT_HANDLE = "no-such-seat-rehearsal-0"
# "" when the answer to the transport check shows meta.changes present and equal to 0, otherwise the reason (a missing figure is a failure, not a pass).
function Test-NoRowsChanged($res) {
  if ($null -eq $res) { return "the transport check returned no parsable result" }
  if ($null -eq $res.Changes) { return "the transport check answer carries no meta.changes, so zero rows changed cannot be shown" }
  if ([string]$res.Changes -ne "0") { return ("the uphold statement for a handle that does not exist changed " + $res.Changes + " rows, expected 0") }
  return ""
}
# The catalogue read for one citizens column (single quotes and square brackets only, so it can go to wrangler by --command).
function Get-ColumnShapeSql($columnName) { return ("SELECT name, type, [notnull] AS notnull_flag, dflt_value FROM pragma_table_info('citizens') WHERE name = '" + $columnName + "'") }
# "" when the column read shows exactly one citizens.<$columnName>, type INTEGER, nullable (notnull 0) and with no default (dflt_value null), otherwise the reason.
function Test-ColumnShape($res, $columnName) {
  if ($null -eq $res) { return "the column read returned no parsable result" }
  $list = @($res.Rows)
  if ($list.Count -ne 1) { return ("citizens has " + $list.Count + " " + $columnName + " column rows, expected exactly 1") }
  if ([string]$list[0].type -cne "INTEGER") { return ("citizens." + $columnName + " has type '" + $list[0].type + "', expected INTEGER") }
  if ([string]$list[0].notnull_flag -cne "0") { return ("citizens." + $columnName + " has notnull '" + $list[0].notnull_flag + "', expected 0 (nullable)") }
  if ($null -ne $list[0].dflt_value) { return ("citizens." + $columnName + " has a default '" + $list[0].dflt_value + "', expected none") }
  return ""
}
# "" when 0025's column is not present without 0024's (out of order: the objection column is meaningless without the stamp it stops), otherwise the reason.
function Test-ColumnOrder($has0024, $has0025) {
  if ($has0025 -and -not $has0024) { return "citizens.assertion_objected_at is on the scratch database but citizens.last_assertion_at is not: out of order, read the catalogue by hand" }
  return ""
}
# "" when the report is a complete pass: it parsed, carries every expected check exactly once, every check passed, and report.pass is true. Otherwise the first reason.
function Test-RehearsalReport($report) {
  if ($null -eq $report) { return "the rehearsal route did not return JSON" }
  if ($null -eq $report.database) { return "the route's answer lacks the database field: it may not be the rehearsal worker" }
  if ([string]$report.database -cne $EXPECTED_DATABASE) { return ("the route reports database '" + $report.database + "', expected '" + $EXPECTED_DATABASE + "'") }
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
  $written = @($report.rows_written_per_statement)
  if ($written.Count -ne 2) { return "rows_written was not recorded for both statements" }
  foreach ($w in $written) {
    $n = 0
    if (-not [int]::TryParse([string]$w, [ref]$n) -or $n -le 0) { return ("rows_written is '" + $w + "', expected a number greater than 0 for each statement") }
  }
  return ""
}
# The process id that owns the LISTENING socket on $listenPort, or $null when nothing listens there.
function Get-ListenerPid($listenPort) {
  $conns = @(Get-NetTCPConnection -LocalPort $listenPort -State Listen -ErrorAction SilentlyContinue)
  if ($conns.Count -lt 1) { return $null }
  return [int]$conns[0].OwningProcess
}
# Every descendant process id of $rootPid (children, their children, and so on), read from the process table now.
function Get-DescendantPids($rootPid) {
  $table = @(Get-CimInstance Win32_Process | Select-Object ProcessId, ParentProcessId)
  $found = @()
  $queue = @([int]$rootPid)
  while ($queue.Count -gt 0) {
    $head = $queue[0]
    $queue = @($queue | Select-Object -Skip 1)
    foreach ($proc in $table) {
      if ([int]$proc.ParentProcessId -eq $head -and ($found -notcontains [int]$proc.ProcessId)) {
        $found += [int]$proc.ProcessId
        $queue += [int]$proc.ProcessId
      }
    }
  }
  return @($found)
}
# Kills each listed process id with its tree. An id that is already gone is not an error. Never this shell.
function Stop-ProcessIds($ids) {
  foreach ($id in @($ids)) {
    if ($null -ne $id -and [int]$id -gt 0 -and [int]$id -ne $PID) { taskkill.exe /PID $id /T /F | Out-Null }
  }
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
foreach ($path in $CONFIG_PATH, $MIGRATION_PATH_0024, $MIGRATION_PATH_0025) {
  if (-not (Test-Path $path)) { Stop-Here ("$path is missing: run this from the repo root.") }
}
$why = Test-RehearsalConfig (Get-Content $CONFIG_PATH -Raw)
if ($why -ne "") { Stop-Here $why }
Say ("[target] " + $SCRATCH_DB + " (" + $SCRATCH_ID + "), config " + $CONFIG_PATH)

# 1. the scratch database: the tables the real authenticate() touches, then each migration (0024, then 0025) only if ITS OWN column is absent
$tables = Invoke-ScratchRead "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('citizens','auth_nonces')" "the tables read"
if (@($tables.Rows).Count -ne 2) { Stop-Here ("the scratch database has " + @($tables.Rows).Count + " of citizens and auth_nonces: load it with the production schema first.") }
$col0024 = Invoke-ScratchRead (Get-ColumnShapeSql "last_assertion_at") "the last_assertion_at column read"
$col0025 = Invoke-ScratchRead (Get-ColumnShapeSql "assertion_objected_at") "the assertion_objected_at column read"
$why = Test-ColumnOrder (@($col0024.Rows).Count -gt 0) (@($col0025.Rows).Count -gt 0)
if ($why -ne "") { Stop-Here $why }
foreach ($migration in @(@{ Label = "0024"; Path = $MIGRATION_PATH_0024; Column = "last_assertion_at"; Read = $col0024 }, @{ Label = "0025"; Path = $MIGRATION_PATH_0025; Column = "assertion_objected_at"; Read = $col0025 })) {
  $shape = $migration.Read
  if (@($shape.Rows).Count -eq 0) {
    Say ("[d1] applying " + $migration.Path + " to the scratch database")
    $mig = Invoke-Bounded ("npx wrangler d1 execute " + $SCRATCH_DB + " --remote --file " + $migration.Path) $WRANGLER_D1_SECONDS
    if ($mig.TimedOut) { Stop-Here ("migration " + $migration.Label + " timed out after " + $WRANGLER_D1_SECONDS + " s; read the column by hand before any retry.") }
    if ($mig.Code -ne 0) { Stop-Here ("migration " + $migration.Label + " failed (exit " + $mig.Code + "); no later migration was started; read the column by hand before any retry.") }
    $shape = Invoke-ScratchRead (Get-ColumnShapeSql $migration.Column) ("the " + $migration.Column + " column read after migration " + $migration.Label)
  } else {
    Say ("[d1] citizens." + $migration.Column + " is already on the scratch database; migration " + $migration.Label + " is not re-applied")
  }
  $why = Test-ColumnShape $shape $migration.Column
  if ($why -ne "") { Stop-Here ("the column on the scratch database is not migration " + $migration.Label + "'s: " + $why) }
  Say ("[d1] citizens." + $migration.Column + " present (INTEGER, nullable, no default)")
}

# 1b. the operator script's transport (re-gate C3): the uphold statement for a handle that does not exist, by wrangler d1 execute --remote --json --command through the same helper, must answer meta.changes 0.
# It writes nothing (it matches no row) and proves the transport and the JSON shape on real wrangler before a person's objection is the first use of that path.
# BEGIN-TRANSPORT-CHECK
$transport = Invoke-ScratchRead ($UPHOLD_SQL_TEMPLATE.Replace("@HANDLE@", $ABSENT_HANDLE)) "the uphold transport check"
$why = Test-NoRowsChanged $transport
if ($why -ne "") { Stop-Here ("transport check failed: " + $why) }
Say ("[transport] the uphold statement for a handle that does not exist answered meta.changes " + $transport.Changes + " through the same helper")
# END-TRANSPORT-CHECK

# 2. the worker: wrangler dev --remote on a local port, the route called, wrangler stopped in finally
$logOut = [System.IO.Path]::GetTempFileName()
$logErr = [System.IO.Path]::GetTempFileName()
$dev = $null
$snapshot = @()
$report = $null
$routeNote = ""
try {
  $devArgs = "/c npx wrangler dev --remote --config " + $CONFIG_PATH + " --port " + $Port
  Say ("[dev] starting: npx wrangler dev --remote --config " + $CONFIG_PATH + " --port " + $Port)
  $dev = Start-Process -FilePath "cmd.exe" -ArgumentList $devArgs -NoNewWindow -PassThru -RedirectStandardOutput $logOut -RedirectStandardError $logErr
  $snapshot += @($dev.Id)
  $url = "http://127.0.0.1:" + $Port + "/run"
  $deadline = (Get-Date).AddSeconds($START_WAIT_SECONDS)
  $up = $false
  while ((Get-Date) -lt $deadline) {
    if ($dev.HasExited) { $routeNote = "wrangler dev exited early (code " + $dev.ExitCode + ")"; break }
    $probe = Get-Text ("http://127.0.0.1:" + $Port + "/") 5
    if ($probe.Code -cne "000") {
      $up = $true
      # The process tree as it stands now: the wrapper, the port's owner and everything under both, so a dead wrapper cannot strand the Worker runtime.
      $owner = Get-ListenerPid $Port
      $snapshot += @(Get-DescendantPids $dev.Id)
      if ($null -ne $owner) { $snapshot += @($owner); $snapshot += @(Get-DescendantPids $owner) }
      break
    }
    Start-Sleep -Seconds 3
  }
  if ($up) {
    $r = Get-Text $url $RUN_SECONDS
    Say ("[run] GET " + $url + " -> " + $r.Code)
    if ($r.Code -cne "200") { $routeNote = "the rehearsal route answered HTTP " + $r.Code + ", expected 200" }
    else {
      try { $report = ($r.Body | ConvertFrom-Json) } catch { $routeNote = "the route's answer was not JSON" }
    }
  } elseif ($routeNote -eq "") {
    $routeNote = "wrangler dev did not answer within " + $START_WAIT_SECONDS + " s"
  }
} finally {
  # Stop by process tree whether or not the cmd.exe wrapper is still alive: the snapshot, whatever is still under the wrapper, and whatever still owns the port.
  if ($null -ne $dev) { $snapshot += @(Get-DescendantPids $dev.Id) }
  $ownerNow = Get-ListenerPid $Port
  if ($null -ne $ownerNow) { $snapshot += @($ownerNow) }
  Stop-ProcessIds $snapshot
  Start-Sleep -Seconds 2
  $stillOwner = Get-ListenerPid $Port
  if ($null -ne $stillOwner) { Stop-ProcessIds @($stillOwner) }
  if ($routeNote -ne "") {
    $tail = (Get-Content $logOut -Tail 15 -ErrorAction SilentlyContinue) -join " | "
    Say ("[dev] log tail: " + $tail)
  }
  Remove-Item $logOut -ErrorAction SilentlyContinue
  Remove-Item $logErr -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 1
$leftOver = Get-ListenerPid $Port
if ($null -ne $leftOver) { Stop-Here ("something (process " + $leftOver + ") still listens on port " + $Port + " after the stop: stop it by hand before any re-run.") }
Say ("[dev] wrangler stopped, port " + $Port + " released")
if ($routeNote -ne "") { Stop-Here $routeNote }

# 3. the checks, one line each, then the verdict
foreach ($c in @($report.checks)) {
  $mark = "FAIL"
  if ($c.pass -eq $true) { $mark = "ok  " }
  Say ("[" + $mark + "] " + $c.name + " | expected " + ($c.expected | ConvertTo-Json -Compress) + " | actual " + ($c.actual | ConvertTo-Json -Compress))
}
if ($null -ne $report.c5_note) { Say ("[note] " + $report.c5_note) }
if ($null -ne $report.c5b_note) { Say ("[note] " + $report.c5b_note) }
Say ("[checkpoint] rows_written per statement of one spend (nonce INSERT, stamp UPDATE): " + ($report.rows_written_per_statement | ConvertTo-Json -Compress))
if ($null -ne $report.cleanup_rows_deleted) { Say ("[cleanup] rows deleted: " + ($report.cleanup_rows_deleted | ConvertTo-Json -Compress)) }
$why = Test-RehearsalReport $report
if ($why -ne "") { Stop-Here ("FAIL: " + $why) }
Say "PASS: every check ran and passed against the scratch binding. Record the rows_written line in the checkpoint; the deploy script's confirmation flag stays Ben's own assertion."
exit 0
