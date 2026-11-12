# Rehearses migrations/0026_resident_accounts.sql (D-082, residency by an outside account) on the SCRATCH D1 only, through real wrangler, and proves from the catalogue what it did. Nothing else: this script runs no worker and deploys nothing.
# BEN'S HAND ONLY (wrangler prompts; the builder never runs it). THE SCRATCH DATABASE ONLY: the name is pinned below and the script refuses any other (it will not run against 'commonhold').
# What it proves, each a named line and all required for PASS:
#   1 BEFORE: the scratch database carries the production schema (citizens and guests exist) and a snapshot of the sqlite_master sql of every table, index and trigger that is NOT one of the two new tables or their indexes;
#   2 the migration applies (exit 0); it is additive and every statement is CREATE ... IF NOT EXISTS, so a re-run is safe and this script applies it TWICE on purpose;
#   3 AFTER: scripts/verify-resident-account.sql (the catalogue read the deploy script also uses) returns exactly the five expected rows: resident_accounts and resident_account_challenges with their columns in order, the index
#     idx_resident_account_challenges_visitor on (visitor_id, expires_at), the UNIQUE (platform, external_account_id) on resident_accounts, and the nonce primary key on the challenges table;
#   4 NO PRE-EXISTING OBJECT CHANGED: the snapshot of every other sqlite_master row is identical before, after the first apply and after the second;
#   5 the second apply changed nothing: the catalogue rows are identical after the first and the second apply.
# Prints PASS only when every line above held; any miss prints FAIL and exits 1. A pass is evidence for Ben's -RehearsalPassed flag on scripts/deploy-resident-account.ps1; it does not set that flag.
# Run from the repo root:
#   powershell -ExecutionPolicy Bypass -File scripts\rehearse-resident-account.ps1
# PowerShell 5.1 traps this file avoids: one spelling per variable name; "$var:" is a drive reference; never merge a native command's stderr under ErrorActionPreference Stop; every READ goes to wrangler by --command as one
# single-quote-only line (a statement with a double quote is refused), --file is used only for the migration. ASCII only.
param(
  [string]$Database = "commonhold-migtest"
)
$ErrorActionPreference = "Stop"
$SCRATCH_DB = "commonhold-migtest"
$MIGRATION_PATH = "migrations/0026_resident_accounts.sql"
$VERIFY_SQL_PATH = "scripts/verify-resident-account.sql"
$WRANGLER_D1_SECONDS = 120
$NEW_TABLES = @("resident_accounts", "resident_account_challenges")
# The five rows the catalogue read must return, as kind|name|detail, in the read's own order (ORDER BY 1, 2).
$EXPECTED_CATALOGUE = @(
  "index|idx_resident_account_challenges_visitor|resident_account_challenges:visitor_id,expires_at",
  "table|resident_account_challenges|nonce,visitor_id,purpose,platform,claim_code_hash,issued_at,expires_at,used_at",
  "table|resident_accounts|visitor_id,platform,external_account_id,external_handle,record_id,record_created_at,account_created_at,retrieved_at,record_sha256,account_sha256,created_at",
  "unique|sqlite_autoindex_resident_account_challenges_1|resident_account_challenges:pk:nonce",
  "unique|sqlite_autoindex_resident_accounts_1|resident_accounts:u:platform,external_account_id"
)
# Every sqlite_master row that is not one of the new tables or an index on them. The migration must leave these byte for byte as they were.
$OTHER_OBJECTS_SQL = "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE tbl_name NOT IN ('resident_accounts', 'resident_account_challenges') ORDER BY type, name"
$MIN_OTHER_OBJECTS = 20

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
# END-OF-DEFINITIONS (nothing above runs wrangler)

$why = Test-ScratchTarget $Database
if ($why -ne "") { Stop-Here $why }
foreach ($path in $MIGRATION_PATH, $VERIFY_SQL_PATH) {
  if (-not (Test-Path $path)) { Stop-Here ("$path is missing: run this from the repo root.") }
}
$verifySql = Get-Content $VERIFY_SQL_PATH -Raw
$why = Test-SingleLineSql (ConvertTo-SingleLineSql $verifySql)
if ($why -ne "") { Stop-Here ("$VERIFY_SQL_PATH cannot be sent as one --command argument: " + $why) }
Say ("[target] " + $SCRATCH_DB)

# 1. before: the production schema is there, and the snapshot of everything else
$base = Invoke-ScratchRead "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('citizens', 'guests', 'council_claims')" "the base tables read"
if (@($base.Rows).Count -ne 3) { Stop-Here ("the scratch database has " + @($base.Rows).Count + " of citizens, guests and council_claims: load it with the production schema first.") }
$before = Invoke-ScratchRead $OTHER_OBJECTS_SQL "the other objects, before"
$catBefore = Invoke-ScratchRead $verifySql "the catalogue, before"
Say ("[before] " + @($before.Rows).Count + " other objects snapshotted; " + @($catBefore.Rows).Count + " of the 5 catalogue rows present (a re-run starts with all 5)")

# 2. apply, twice: IF NOT EXISTS makes the second a no-op
$snapshots = @()
$catalogues = @()
foreach ($round in 1, 2) {
  Say ("[d1] applying " + $MIGRATION_PATH + " to the scratch database (apply " + $round + " of 2)")
  $mig = Invoke-Bounded ("npx wrangler d1 execute " + $SCRATCH_DB + " --remote --file " + $MIGRATION_PATH) $WRANGLER_D1_SECONDS
  if ($mig.TimedOut) { Stop-Here ("the migration timed out after " + $WRANGLER_D1_SECONDS + " s (apply " + $round + "); read the catalogue by hand before any re-run.") }
  if ($mig.Code -ne 0) { Stop-Here ("the migration failed (exit " + $mig.Code + ") on apply " + $round + ".") }
  $snapshots += @(, (Invoke-ScratchRead $OTHER_OBJECTS_SQL ("the other objects, after apply " + $round)))
  $catalogues += @(, (Invoke-ScratchRead $verifySql ("the catalogue, after apply " + $round)))
}

# 3-5. the verdict
$fails = @()
foreach ($round in 0, 1) {
  $why = Test-Catalogue $catalogues[$round]
  if ($why -ne "") { $fails += ("catalogue after apply " + ($round + 1) + ": " + $why) } else { Say ("[ok] catalogue after apply " + ($round + 1) + ": both tables, their columns in order, the index, the UNIQUE (platform, external_account_id), the nonce primary key") }
  $why = Test-OthersUnchanged $before $snapshots[$round] ("after apply " + ($round + 1))
  if ($why -ne "") { $fails += $why } else { Say ("[ok] no pre-existing object changed after apply " + ($round + 1)) }
}
$firstLines = ((ConvertTo-CatalogueLines $catalogues[0]) -join "`n")
$secondLines = ((ConvertTo-CatalogueLines $catalogues[1]) -join "`n")
if ($firstLines -cne $secondLines) { $fails += "the second apply changed the catalogue" } else { Say "[ok] the second apply changed nothing" }
if ($fails.Count -gt 0) {
  foreach ($f in $fails) { Say ("[FAIL] " + $f) }
  Say "FAIL: the migration is NOT shown to be what the deploy script expects. Do not deploy; read the catalogue by hand."
  exit 1
}
Say "PASS: migration 0026 applied twice to the scratch database; both tables, the columns, the index and the UNIQUE are there, and no pre-existing object changed. Ben's -RehearsalPassed flag on scripts/deploy-resident-account.ps1 stays his own assertion."
exit 0
