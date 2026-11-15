# Rehearses migrations/0027_resident_recoveries.sql (two ADD COLUMNs on guests, one new table commit_days) on the SCRATCH D1 only, through real wrangler, and proves from the catalogue what it did. Nothing else: this script runs no worker and deploys nothing.
# BEN'S HAND ONLY (wrangler prompts; the builder never runs it). THE SCRATCH DATABASE ONLY: the name is pinned below and the script refuses any other (it will not run against 'commonhold').
# THE TARGET IS PROVED, NOT ASSUMED (review D1): before any apply this script (a) STOPS if wrangler.jsonc, wrangler.json or wrangler.toml at the repo root (every env block) names commonhold-migtest as a database_name or a binding, and
# (b) resolves the scratch database's UUID from the ACCOUNT (npx wrangler d1 info commonhold-migtest --json, a read) and STOPS unless it is a well-formed UUID that differs from every database_id in those configs (production's).
# THE SCRATCH DATABASE MUST CARRY THE PRE-0027 SCHEMA. ADD COLUMN is NOT idempotent, so unlike the 0026 rehearsal this script applies the migration ONCE and never twice: if the scratch D1 already carries any of the three objects it STOPS
# and says to reload the scratch database with the production schema first. A second apply is not rehearsed (it would fail with duplicate column name); the deploy script's catalogue read sorts absent, complete and partial instead.
# What it proves, each a named line and all required for PASS:
#   1 BEFORE: the scratch database carries the production schema (citizens, guests and council_claims exist), none of the three new objects exists, and a snapshot of every other sqlite_master row except the guests table row and commit_days;
#   2 the migration applies (exit 0);
#   3 AFTER: scripts/verify-recovery-unit.sql (the catalogue read the deploy script also uses) returns exactly the 9 expected rows: the two guests columns (types, notnull, the default 0 of recoveries, appended after resident_at),
#     commit_days with its columns and its primary key (day, code_commit);
#   4 NO PRE-EXISTING OBJECT CHANGED: the snapshot of every other sqlite_master row is identical before and after (the guests table row itself is excluded: ADD COLUMN rewrites its sql by design, and the catalogue verifies its columns);
#   5 THE WRITE COST, on D1's own meta.rows_written: a first INSERT OR IGNORE into commit_days, a duplicate of it, and a second stamp the same day. The duplicate must write 0 rows and the second stamp exactly what the first wrote
#     (and the first between 1 and 2: the table row and its primary-key index), which is what the door-counter budget (50,400 + 2S) assumes. The probe rows (day 1999-01-01) are deleted afterwards.
# Prints PASS only when every line above held; any miss prints FAIL and exits 1. A pass is evidence for Ben's -RehearsalPassed flag on scripts/deploy-recovery-unit.ps1; it does not set that flag.
# Run from the repo root:
#   powershell -ExecutionPolicy Bypass -File scripts\rehearse-recovery-unit.ps1
# PowerShell 5.1 traps this file avoids: one spelling per variable name; "$var:" is a drive reference; never merge a native command's stderr under ErrorActionPreference Stop; every READ goes to wrangler by --command as one
# single-quote-only line (a statement with a double quote is refused), --file is used only for the migration. ASCII only.
param(
  [string]$Database = "commonhold-migtest"
)
$ErrorActionPreference = "Stop"
$SCRATCH_DB = "commonhold-migtest"
$MIGRATION_PATH = "migrations/0027_resident_recoveries.sql"
$VERIFY_SQL_PATH = "scripts/verify-recovery-unit.sql"
$WRANGLER_D1_SECONDS = 120
# The 9 rows the catalogue read must return, as kind|name|detail, in the read's own order (ORDER BY 1, 2). The deploy script pins the same nine.
$EXPECTED_CATALOGUE = @(
  "column|commit_days.code_commit|TEXT|1|2",
  "column|commit_days.day|TEXT|1|1",
  "column|commit_days.first_seen_at|INTEGER|1|0",
  "column|guests.last_recovered_at|INTEGER|0|0",
  "column|guests.recoveries|INTEGER|1|0",
  "default|guests.recoveries|0",
  "guests_tail|guests|resident_at,recoveries,last_recovered_at",
  "table|commit_days|day,code_commit,first_seen_at",
  "unique|sqlite_autoindex_commit_days_1|commit_days:pk:day,code_commit"
)
# Every sqlite_master row except commit_days and the guests TABLE row (ADD COLUMN rewrites its sql by design). The migration must leave these byte for byte as they were.
$OTHER_OBJECTS_SQL = "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE tbl_name <> 'commit_days' AND NOT (type = 'table' AND name = 'guests') ORDER BY type, name"
$MIN_OTHER_OBJECTS = 20
$ROOT_CONFIGS = @("wrangler.jsonc", "wrangler.json", "wrangler.toml")
$UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
# The probe: three writes to commit_days on a day no real request can carry, then removed.
$PROBE_DAY = "1999-01-01"
$PROBE_STAMP_A = "rehearsal-stamp-a"
$PROBE_STAMP_B = "rehearsal-stamp-b"
$PROBE_INSERT_SQL = "INSERT OR IGNORE INTO commit_days (day, code_commit, first_seen_at) VALUES ('1999-01-01', '{0}', 1)"
$PROBE_CLEANUP_SQL = "DELETE FROM commit_days WHERE day = '1999-01-01'"

function Stop-Here($msg) { Write-Host "[STOP] $msg"; exit 1 }
function Say($msg) { Write-Host $msg }
# "" when $name is exactly the scratch database, otherwise the reason it is refused.
function Test-ScratchTarget($name) {
  if ([string]$name -cne $SCRATCH_DB) { return ("the database name is '" + $name + "', and this rehearsal only ever runs against " + $SCRATCH_DB) }
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
# One-line, single-quote-only SQL from a file's text: full-line -- comments dropped, whitespace collapsed.
function ConvertTo-SingleLineSql($text) {
  $kept = @()
  foreach ($line in (([string]$text).Replace("`r`n", "`n").Split("`n"))) {
    $t = $line.Trim()
    if ($t -eq "" -or $t.StartsWith("--")) { continue }
    $kept += $t
  }
  return ((($kept -join " ") -replace '\s+', " ").Trim())
}
# "" when $sql is safe to hand to a native exe as one --command argument, otherwise the reason it is refused.
function Test-SingleLineSql($sql) {
  if ([string]$sql -eq "") { return "the SQL is empty" }
  if (([string]$sql).Contains('"')) { return "the SQL contains a double quote, which PowerShell 5.1 mangles in a native argument" }
  if (([string]$sql).Contains("--")) { return "the SQL still contains '--' after stripping full-line comments" }
  return ""
}
# One READ against the scratch database by --command (bounded). Returns the parsed rows or STOPS.
function Invoke-ScratchRead($sql, $label) {
  $why = Test-ScratchTarget $Database
  if ($why -ne "") { Stop-Here $why }
  $one = ConvertTo-SingleLineSql $sql
  $why = Test-SingleLineSql $one
  if ($why -ne "") { Stop-Here ("cannot send the SQL for " + $label + ": " + $why) }
  $env:D1_SQL_ARG = $one
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
# The catalogue rows as one kind|name|detail line each, in the order read.
function ConvertTo-CatalogueLines($res) {
  $lines = @()
  foreach ($row in @($res.Rows)) { $lines += ([string]$row.kind + "|" + [string]$row.name + "|" + [string]$row.detail) }
  return @($lines)
}
# "" when $res is exactly the expected catalogue (every row present, in order, nothing extra), otherwise the first difference.
function Test-Catalogue($res) {
  if ($null -eq $res) { return "the catalogue read returned no parsable result" }
  $got = @(ConvertTo-CatalogueLines $res)
  if ($got.Count -ne $EXPECTED_CATALOGUE.Count) { return ("the catalogue read returned " + $got.Count + " rows, expected " + $EXPECTED_CATALOGUE.Count + ": " + ($got -join " ; ")) }
  for ($i = 0; $i -lt $got.Count; $i++) {
    if ($got[$i] -cne $EXPECTED_CATALOGUE[$i]) { return ("catalogue row " + ($i + 1) + " is '" + $got[$i] + "', expected '" + $EXPECTED_CATALOGUE[$i] + "'") }
  }
  return ""
}
# "" when two reads of every other sqlite_master row are the same objects with the same sql, and the read is not trivially small (a wrong database or a failed read), otherwise the reason.
function Test-OthersUnchanged($before, $after, $label) {
  if ($null -eq $before -or $null -eq $after) { return ("the snapshot of the other objects was unreadable (" + $label + ")") }
  if (@($before.Rows).Count -lt $MIN_OTHER_OBJECTS) { return ("the snapshot has only " + @($before.Rows).Count + " other objects (" + $label + "), expected at least " + $MIN_OTHER_OBJECTS + ": this is not the production schema") }
  $b = ($before.Rows | ConvertTo-Json -Compress -Depth 4)
  $a = ($after.Rows | ConvertTo-Json -Compress -Depth 4)
  if ($a -cne $b) { return ("a pre-existing table, index or trigger changed (" + $label + "): the snapshots differ") }
  return ""
}
# The text of a wrangler config without its full-line comments (// for jsonc/json, # for toml).
function Remove-ConfigComments($text) {
  $kept = @()
  foreach ($line in (([string]$text).Replace("`r`n", "`n").Split("`n"))) {
    $t = $line.Trim()
    if ($t.StartsWith("//") -or $t.StartsWith("#")) { continue }
    $kept += $line
  }
  return ($kept -join "`n")
}
# "" when a wrangler config text does NOT name the scratch database as a database_name or a binding (jsonc "key": "value" or toml key = "value", any env block), otherwise the reason. A local entry with either would make
# wrangler use that entry's configured UUID for `d1 execute commonhold-migtest` without asking the account.
function Test-ConfigDoesNotNameScratch($text, $label) {
  $clean = Remove-ConfigComments $text
  $pattern = '(?i)["'']?(database_name|binding)["'']?\s*[:=]\s*["'']' + [regex]::Escape($SCRATCH_DB) + '["'']'
  if ([regex]::IsMatch($clean, $pattern)) { return ($label + " names " + $SCRATCH_DB + " as a database_name or a binding: wrangler would resolve it to that entry's UUID without asking the account, so this rehearsal cannot show where the migration goes") }
  return ""
}
# Every database_id value in a wrangler config text (production's, whatever it is called), lower-cased.
function Get-ConfigDatabaseIds($text) {
  $ids = @()
  foreach ($m in [regex]::Matches((Remove-ConfigComments $text), '(?i)["'']?database_id["'']?\s*[:=]\s*["'']([^"'']+)["'']')) { $ids += $m.Groups[1].Value.ToLowerInvariant() }
  return @($ids)
}
# The UUID of the scratch database from `wrangler d1 info <name> --json` output (banner text before the first brace is ignored), as @{ Uuid; Error }. The object's name, when present, must be the scratch name.
function Get-ScratchUuid($text) {
  $i = ([string]$text).IndexOf("{")
  if ($i -lt 0) { return @{ Uuid = ""; Error = "d1 info returned no JSON object" } }
  try { $info = (([string]$text).Substring($i) | ConvertFrom-Json) } catch { return @{ Uuid = ""; Error = "d1 info returned JSON that does not parse" } }
  $uuid = ""
  if ($null -ne $info.PSObject.Properties["uuid"]) { $uuid = [string]$info.uuid } elseif ($null -ne $info.PSObject.Properties["id"]) { $uuid = [string]$info.id }
  if ($uuid -eq "") { return @{ Uuid = ""; Error = "d1 info carries no uuid" } }
  if ($null -ne $info.PSObject.Properties["name"] -and [string]$info.name -cne $SCRATCH_DB) { return @{ Uuid = $uuid; Error = ("d1 info answers for the database '" + $info.name + "', not " + $SCRATCH_DB) } }
  return @{ Uuid = $uuid.ToLowerInvariant(); Error = "" }
}
# "" when $uuid is a well-formed lower-case UUID that is none of the production database ids, otherwise the reason.
function Test-ScratchUuid($uuid, $prodIds) {
  if ([string]$uuid -cnotmatch $UUID_PATTERN) { return ("the scratch database's id '" + $uuid + "' is not a well-formed UUID") }
  if (@($prodIds).Count -lt 1) { return "no database_id was found in the repo's wrangler config, so production's id cannot be compared" }
  foreach ($id in @($prodIds)) {
    if ($uuid -ceq [string]$id) { return ("the scratch database " + $SCRATCH_DB + " resolves to " + $uuid + ", which is production's database_id: this would migrate production") }
  }
  return ""
}
# The meta.rows_written of a `wrangler d1 execute --json` WRITE as an integer, or $null when the output carries none (a failed read is never zero rows written).
function Get-RowsWritten($text) {
  $i = ([string]$text).IndexOf("[")
  if ($i -lt 0) { return $null }
  try { $parsed = (([string]$text).Substring($i) | ConvertFrom-Json) } catch { return $null }
  if ($null -eq $parsed -or @($parsed).Count -lt 1 -or $null -eq @($parsed)[0].meta -or $null -eq @($parsed)[0].meta.PSObject.Properties["rows_written"]) { return $null }
  return [int](@($parsed)[0].meta.rows_written)
}
# One WRITE against the scratch database by --command (bounded). Returns the rows_written D1 reports, or STOPS.
function Invoke-ScratchWrite($sql, $label) {
  $why = Test-ScratchTarget $Database
  if ($why -ne "") { Stop-Here $why }
  $why = Test-SingleLineSql $sql
  if ($why -ne "") { Stop-Here ("cannot send the SQL for " + $label + ": " + $why) }
  $env:D1_SQL_ARG = $sql
  try {
    $r = Invoke-Bounded ("npx wrangler d1 execute " + $SCRATCH_DB + ' --remote --json --command "%D1_SQL_ARG%"') $WRANGLER_D1_SECONDS
  } finally {
    Remove-Item Env:D1_SQL_ARG -ErrorAction SilentlyContinue
  }
  if ($r.TimedOut) { Stop-Here ("wrangler d1 execute timed out after " + $WRANGLER_D1_SECONDS + " s on " + $label) }
  if ($r.Code -ne 0) { Stop-Here ("wrangler d1 execute failed (exit " + $r.Code + ") on " + $label) }
  $n = Get-RowsWritten $r.Out
  if ($null -eq $n) { Stop-Here ("the write for " + $label + " returned no meta.rows_written") }
  return $n
}
# "" when the three rows_written figures are what the budget assumes: a first insert writes 1 or 2 rows, a duplicate writes 0, a second stamp writes exactly what the first did, otherwise the reason.
function Test-RowsWritten($first, $dup, $second) {
  if ($first -lt 1 -or $first -gt 2) { return ("a first commit_days insert wrote " + $first + " rows, expected 1 or 2 (the table row and its primary-key index)") }
  if ($dup -ne 0) { return ("a duplicate INSERT OR IGNORE wrote " + $dup + " rows, expected 0: the 50,400 + 2S door-counter budget assumes a duplicate costs nothing") }
  if ($second -ne $first) { return ("a second stamp wrote " + $second + " rows but the first wrote " + $first + ": the cost per stamp is not constant") }
  return ""
}
# END-OF-DEFINITIONS (nothing above runs wrangler)

$why = Test-ScratchTarget $Database
if ($why -ne "") { Stop-Here $why }
foreach ($path in $MIGRATION_PATH, $VERIFY_SQL_PATH) {
  if (-not (Test-Path $path)) { Stop-Here ("$path is missing: run this from the repo root.") }
}
$verifySql = Get-Content $VERIFY_SQL_PATH -Raw
$why = Test-SingleLineSql (ConvertTo-SingleLineSql $verifySql)
if ($why -ne "") { Stop-Here ("$VERIFY_SQL_PATH cannot be sent as one --command argument: " + $why) }
# 0b. the target is proved: no local config aliases the scratch name, and the account's own UUID for it is not production's
$prodIds = @()
foreach ($configPath in $ROOT_CONFIGS) {
  if (-not (Test-Path $configPath)) { continue }
  $configText = Get-Content $configPath -Raw
  $why = Test-ConfigDoesNotNameScratch $configText $configPath
  if ($why -ne "") { Stop-Here $why }
  $prodIds += @(Get-ConfigDatabaseIds $configText)
}
$info = Invoke-Bounded ("npx wrangler d1 info " + $SCRATCH_DB + " --json") $WRANGLER_D1_SECONDS
if ($info.TimedOut) { Stop-Here ("wrangler d1 info timed out after " + $WRANGLER_D1_SECONDS + " s: the scratch database's id could not be resolved.") }
if ($info.Code -ne 0) { Stop-Here ("wrangler d1 info failed (exit " + $info.Code + "): the scratch database's id could not be resolved.") }
$resolved = Get-ScratchUuid $info.Out
if ($resolved.Error -ne "") { Stop-Here $resolved.Error }
$why = Test-ScratchUuid $resolved.Uuid $prodIds
if ($why -ne "") { Stop-Here $why }
Say ("[target] " + $SCRATCH_DB + " resolves to " + $resolved.Uuid + " on the account; production's database_id in the repo config is " + ($prodIds -join ", ") + ": they differ")


# 1. before: the production schema is there, none of the three new objects is, and the snapshot of everything else
$base = Invoke-ScratchRead "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('citizens', 'guests', 'council_claims')" "the base tables read"
if (@($base.Rows).Count -ne 3) { Stop-Here ("the scratch database has " + @($base.Rows).Count + " of citizens, guests and council_claims: load it with the production schema first.") }
$before = Invoke-ScratchRead $OTHER_OBJECTS_SQL "the other objects, before"
$catBefore = Invoke-ScratchRead $verifySql "the catalogue, before"
$already = @(@($catBefore.Rows) | Where-Object { [string]$_.kind -cne "guests_tail" })
if ($already.Count -gt 0) { Stop-Here ("the scratch database already carries " + $already.Count + " of the migration's catalogue rows: the two ADD COLUMNs cannot be applied twice. Reload the scratch database with the pre-0027 production schema, then run again.") }
Say ("[before] " + @($before.Rows).Count + " other objects snapshotted; none of the migration's objects present")

# 2. apply ONCE (ADD COLUMN is not idempotent)
Say ("[d1] applying " + $MIGRATION_PATH + " to the scratch database")
$mig = Invoke-Bounded ("npx wrangler d1 execute " + $SCRATCH_DB + " --remote --file " + $MIGRATION_PATH) $WRANGLER_D1_SECONDS
if ($mig.TimedOut) { Stop-Here ("the migration timed out after " + $WRANGLER_D1_SECONDS + " s; the state may be partial. Read the catalogue by hand and reload the scratch database before any re-run.") }
if ($mig.Code -ne 0) { Stop-Here ("the migration failed (exit " + $mig.Code + "); the state may be partial. Reload the scratch database before any re-run.") }
$after = Invoke-ScratchRead $OTHER_OBJECTS_SQL "the other objects, after"
$catAfter = Invoke-ScratchRead $verifySql "the catalogue, after"

# 3-4. the catalogue and the untouched objects
$fails = @()
$why = Test-Catalogue $catAfter
if ($why -ne "") { $fails += ("catalogue after apply: " + $why) } else { Say "[ok] catalogue after apply: the two guests columns (types, notnull, default, order) and commit_days with its columns and primary key" }
$why = Test-OthersUnchanged $before $after "after apply"
if ($why -ne "") { $fails += $why } else { Say "[ok] no pre-existing object changed (the guests table row excluded, its columns verified by the catalogue)" }

# 5. the write cost on D1's own meta.rows_written, then the probe rows removed
$rwFirst = Invoke-ScratchWrite ($PROBE_INSERT_SQL -f $PROBE_STAMP_A) "the first commit_days insert"
$rwDup = Invoke-ScratchWrite ($PROBE_INSERT_SQL -f $PROBE_STAMP_A) "the duplicate commit_days insert"
$rwSecond = Invoke-ScratchWrite ($PROBE_INSERT_SQL -f $PROBE_STAMP_B) "the second-stamp commit_days insert"
$null = Invoke-ScratchWrite $PROBE_CLEANUP_SQL "the probe cleanup"
Say ("[d1] rows_written: first insert " + $rwFirst + ", duplicate " + $rwDup + ", second stamp " + $rwSecond)
$why = Test-RowsWritten $rwFirst $rwDup $rwSecond
if ($why -ne "") { $fails += $why } else { Say "[ok] a duplicate stamp costs nothing and each new stamp costs the same" }

if ($fails.Count -gt 0) {
  foreach ($f in $fails) { Say ("[FAIL] " + $f) }
  Say "FAIL: the migration is NOT shown to be what the deploy script expects. Do not deploy; read the catalogue by hand."
  exit 1
}
Say "PASS: migration 0027 applied once to the scratch database; the two guests columns and commit_days are there, no pre-existing object changed, and the commit_days write cost matches the door-counter budget. Ben's -RehearsalPassed flag on scripts/deploy-recovery-unit.ps1 stays his own assertion."
exit 0
