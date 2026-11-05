# Records, or withdraws, an UPHELD OBJECTION to the publication of citizens.last_assertion_at for one key seat (D-078 item 4, option B).
# Spec: drafts/BRIEF-ASSERTION-OBJECTION-2026-11-05.md O3, O4, O5, O10 with amendments AO1 and AO5; checkpoint docs/CHECKPOINT-LAST-ASSERTION-AT.md.
# BEN'S HAND ONLY (D-017). This is the only way the flag is set or cleared: no HTTP route, no MCP tool, no identity_events row (O5: a chained row would publish the objection).
# It needs migration 0025 on production (citizens.assertion_objected_at) and the worker that honours it; before that it fails at its first read.
#
#   -Uphold   one statement sets assertion_objected_at to the DATABASE's clock and CLEARS the stored last_assertion_at, for a key seat only (public_key IS NOT NULL).
#             The stamp in authentication then never fires for that seat (the seat still authenticates and acts), and the census serves null.
#   -Withdraw clears the flag only. The stored value stays NULL until the seat's next assertion stamps it; a stamp between the withdrawal and the public read is permitted, never a failure.
#
# O10 / AO5, the procedure BEFORE a real run, done offline and by the operator: the holder signs a text that names the service, the seat, the field (last_assertion_at), the requested action
# (uphold or withdraw) and a date; the operator checks the signature against the seat's public key on GET /api/citizens and checks the date is fresh. A withdrawal needs the same. Losing the key
# does not by itself defeat a person's objection: that case is assessed individually and this script is not the route. The operator keeps a PRIVATE record of the request and its outcome.
# A withdrawal clears the only database copy of the objection time, so a real -Withdraw also needs -ObjectionTimeRecorded: the operator has copied the stored time (printed by -DryRun) into that record.
# A real run therefore needs -SignedRequestVerified (the operator's own assertion that this was done) and -ConfirmHandle equal to -Handle, byte for byte.
#
# POSTCONDITIONS (AO1), each checked after the write, each its own failure message:
#   uphold:   exactly one row changed (wrangler's meta.changes), the stored flag is a whole number above zero, the stored stamp is NULL, and GET /api/citizens (every page, by next_since and next_since_id) serves null
#             for the handle.
#   withdraw: exactly one row changed and the stored flag is NULL. The served value is not constrained.
# The census is read through every page because the census never truncates but does paginate (page size is served as page_size).
#
# THIS SCRIPT WAS WRITTEN AND TESTED LOCALLY ONLY (functions against captured and real local-D1 answers). Nobody has run it against production. -DryRun reads (the stored row and the census) and writes nothing.
#   cd "C:\Users\bengr\Projects\AI domain and social network\society"
#   powershell -ExecutionPolicy Bypass -File scripts\assertion-objection.ps1 -Handle <handle> -Uphold -DryRun
#   powershell -ExecutionPolicy Bypass -File scripts\assertion-objection.ps1 -Handle <handle> -Uphold -SignedRequestVerified -ConfirmHandle <handle>
# Cost, stated in the privacy note and the brief: the database holder can flag a seat silently (nothing is chained), as it can already edit any unchained column.
# PowerShell 5.1 traps this file avoids: one spelling per variable name; "$var:" is a drive reference (write "${var}:"); -eq and -ne are case-INSENSITIVE (exact checks use -ceq / -cne); a one-element return is
# wrapped in @(); never merge a native command's stderr under ErrorActionPreference Stop; a statement for wrangler goes by --command as one single-quote-only line. ASCII only.
param(
  [Parameter(Mandatory = $true)][string]$Handle,
  [switch]$Uphold,
  [switch]$Withdraw,
  [switch]$DryRun,
  [switch]$SignedRequestVerified,
  [switch]$ObjectionTimeRecorded,
  [string]$ConfirmHandle = ""
)
$ErrorActionPreference = "Stop"
$BASE = "https://commonhold.randommonicle.workers.dev"
$PROD_DB = "commonhold"
$WRANGLER_D1_SECONDS = 120
$CENSUS_MAX_PAGES = 200
# The statements. @HANDLE@ is replaced by a handle that has already passed Test-HandleShape (letters, digits, _ and -), so it can never carry a quote. The time is the database's own clock, in ms.
$UPHOLD_SQL_TEMPLATE = "UPDATE citizens SET assertion_objected_at = COALESCE(assertion_objected_at, CAST(strftime('%s','now') AS INTEGER) * 1000), last_assertion_at = NULL WHERE handle = '@HANDLE@' AND public_key IS NOT NULL"
$WITHDRAW_SQL_TEMPLATE = "UPDATE citizens SET assertion_objected_at = NULL WHERE handle = '@HANDLE@' AND public_key IS NOT NULL"
$READ_ROW_SQL_TEMPLATE = "SELECT id, handle, public_key IS NOT NULL AS has_key, last_assertion_at, assertion_objected_at FROM citizens WHERE handle = '@HANDLE@'"

function Stop-Here($msg) { Write-Host "[STOP] $msg"; exit 1 }
function Say($msg) { Write-Host $msg }
# "" when $h is a citizen handle (2-32 of letters, digits, _ and -; the server's own pattern), otherwise the reason. Case-sensitive character class written out so no locale rule applies.
function Test-HandleShape($h) {
  if ($null -eq $h -or -not ($h -is [string])) { return "the handle is not a string" }
  if ($h -cnotmatch '^[A-Za-z0-9_-]{2,32}\z') { return "the handle must be 2-32 characters, letters, digits, _ or -" }
  return ""
}
function Get-Sql($template, $h) {
  $why = Test-HandleShape $h
  if ($why -ne "") { throw ("refusing to build SQL: " + $why) }
  return $template.Replace("@HANDLE@", $h)
}
function Get-UpholdSql($h) { return (Get-Sql $UPHOLD_SQL_TEMPLATE $h) }
function Get-WithdrawSql($h) { return (Get-Sql $WITHDRAW_SQL_TEMPLATE $h) }
function Get-ReadRowSql($h) { return (Get-Sql $READ_ROW_SQL_TEMPLATE $h) }
# "" when exactly one of -Uphold and -Withdraw was given.
function Test-Mode($wantUphold, $wantWithdraw) {
  if ($wantUphold -and $wantWithdraw) { return "give -Uphold or -Withdraw, not both" }
  if (-not $wantUphold -and -not $wantWithdraw) { return "give -Uphold or -Withdraw" }
  return ""
}
# "" when a real run has everything it needs: the handle confirmed byte for byte (-ceq) and the offline signature check asserted.
function Test-RealRunAllowed($h, $confirmValue, $signedFlag) {
  if (-not $signedFlag) { return "a real run needs -SignedRequestVerified: the holder's signed text (service, seat, field, action, date) was verified offline against the public key on /api/citizens and is fresh" }
  if ($confirmValue -cne $h) { return "a real run needs -ConfirmHandle equal to -Handle exactly (case-sensitive)" }
  return ""
}
# "" unless a real withdraw would clear the objection time before the operator has recorded it privately.
function Test-WithdrawRecorded($mode, $recordedFlag) {
  if ($mode -ceq "withdraw" -and -not $recordedFlag) { return "a real -Withdraw needs -ObjectionTimeRecorded: copy the stored assertion_objected_at (shown by -DryRun) into the private record first, because this clears the only database copy" }
  return ""
}
# Runs a command line through cmd.exe with stdout captured to a file, killing the process tree if it outlives $seconds. Returns @{ Code; Out; TimedOut }.
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
# The statement travels in an environment variable that cmd.exe expands inside the quotes, so no character of it is parsed as cmd syntax.
function Invoke-BoundedSql($prefix, $sql, $seconds) {
  $env:D1_SQL_ARG = $sql
  try {
    return (Invoke-Bounded ($prefix + ' "%D1_SQL_ARG%"') $seconds)
  } finally {
    Remove-Item Env:D1_SQL_ARG -ErrorAction SilentlyContinue
  }
}
# `wrangler d1 execute --json` output as @{ Rows = <array>; Changes = <meta.changes or $null> }, or $null when the output is not the expected JSON. $null is a FAILED read, never zero rows.
function Read-D1Result($text) {
  $i = ([string]$text).IndexOf("[")
  if ($i -lt 0) { return $null }
  try { $parsed = (([string]$text).Substring($i) | ConvertFrom-Json) } catch { return $null }
  if ($null -eq $parsed -or @($parsed).Count -lt 1 -or $null -eq @($parsed)[0].results) { return $null }
  $changes = $null
  $meta = @($parsed)[0].meta
  if ($null -ne $meta -and $null -ne $meta.PSObject.Properties["changes"]) { $changes = $meta.changes }
  return @{ Rows = @(@($parsed)[0].results); Changes = $changes }
}
function Invoke-D1($sql, $label) {
  $why = ""
  if (([string]$sql).Contains('"')) { $why = "the SQL contains a double quote" }
  if ($why -ne "") { Stop-Here ("cannot send the SQL for " + $label + ": " + $why + ".") }
  $r = Invoke-BoundedSql ("npx wrangler d1 execute " + $PROD_DB + " --remote --json --command") $sql $WRANGLER_D1_SECONDS
  if ($r.TimedOut) { Stop-Here ("wrangler d1 execute timed out after " + $WRANGLER_D1_SECONDS + " s on " + $label + ". The state is unknown: read the row by hand before any retry.") }
  if ($r.Code -ne 0) { Stop-Here ("wrangler d1 execute failed (exit " + $r.Code + ") on " + $label + ".") }
  $res = Read-D1Result $r.Out
  if ($null -eq $res) { Stop-Here ("wrangler d1 execute answered something that is not the expected JSON on " + $label + ".") }
  return $res
}
# "" when $res is the read of exactly one key-seat row, otherwise the reason (a secret-held seat has no value to object to; an unknown handle matches nothing).
function Test-PreRow($res) {
  if ($null -eq $res) { return "the row read returned no parsable result" }
  $list = @($res.Rows)
  if ($list.Count -ne 1) { return ("the handle matched " + $list.Count + " citizen rows, expected exactly 1") }
  if ([string]$list[0].has_key -ne "1") { return "the seat has no public key: a secret-held seat records no assertion time, so there is nothing to object to" }
  return ""
}
# "" unless a withdraw was asked for a seat that has no objection recorded (re-gate L6): there is nothing to withdraw, and a write would only report a no-op as done.
function Test-WithdrawHasFlag($mode, $row) {
  if ($mode -ceq "withdraw" -and $null -eq $row.assertion_objected_at) { return "there is no recorded objection to withdraw: the stored assertion_objected_at is NULL, so nothing was written" }
  return ""
}
# "" when exactly one row changed. meta.changes must be present and equal to 1: a missing figure is a failure, not a pass.
function Test-ChangedOne($res) {
  if ($null -eq $res) { return "the write returned no parsable result" }
  if ($null -eq $res.Changes) { return "the write answer carries no meta.changes, so one row changed cannot be shown" }
  if ([string]$res.Changes -ne "1") { return ("the write changed " + $res.Changes + " rows, expected exactly 1") }
  return ""
}
# "" when the stored row after the write is what the mode promises (AO1). Uphold: flag a whole number above zero and stamp NULL. Withdraw: flag NULL (the stamp is not constrained: a later stamp is permitted).
function Test-StoredAfter($res, $mode) {
  if ($null -eq $res) { return "the stored-row read returned no parsable result" }
  $list = @($res.Rows)
  if ($list.Count -ne 1) { return ("the stored-row read returned " + $list.Count + " rows, expected exactly 1") }
  $flag = $list[0].assertion_objected_at
  $stamp = $list[0].last_assertion_at
  if ($mode -ceq "uphold") {
    if ($null -eq $flag -or -not ([string]$flag -match '^[0-9]+$') -or [string]$flag -eq "0") { return ("the stored flag is '" + $flag + "', expected a whole number above zero") }
    if ($null -ne $stamp) { return ("the stored last_assertion_at is '" + $stamp + "', expected NULL after an uphold") }
    return ""
  }
  if ($null -ne $flag) { return ("the stored flag is '" + $flag + "', expected NULL after a withdrawal") }
  return ""
}
# The census row for $h, following every page. $fetch is a scriptblock taking a URL and returning the parsed page (or $null). Returns @{ Row; Error }: Row is the matching row or $null, Error is "" unless
# a page could not be read or the walk did not end (an unreadable page is a failure, not "not found"). The handle is compared case-insensitively, as the column is.
function Find-CensusRow($h, $fetch, $maxPages) {
  $url = $BASE + "/api/citizens"
  for ($n = 1; $n -le $maxPages; $n++) {
    $page = & $fetch $url
    if ($null -eq $page -or $null -eq $page.citizens) { return @{ Row = $null; Error = ("census page " + $n + " (" + $url + ") was unreadable") } }
    foreach ($row in @($page.citizens)) {
      if ([string]$row.handle -eq $h) { return @{ Row = $row; Error = "" } }
    }
    if ($page.has_more -ne $true) { return @{ Row = $null; Error = "" } }
    if ($null -eq $page.next_since -or $null -eq $page.next_since_id) { return @{ Row = $null; Error = ("census page " + $n + " says has_more but carries no next_since and next_since_id") } }
    $url = $BASE + "/api/citizens?since=" + $page.next_since + "&since_id=" + $page.next_since_id
  }
  return @{ Row = $null; Error = ("the census walk did not end within " + $maxPages + " pages") }
}
# "" when the served census row satisfies the mode. Uphold: the row exists, carries the last_assertion_at key and it is null. Withdraw: the row exists and carries the key (its value is not constrained).
function Test-CensusServed($found, $mode) {
  if ($null -eq $found) { return "the census walk returned nothing" }
  if ($found.Error -ne "") { return [string]$found.Error }
  if ($null -eq $found.Row) { return "the handle is not on any page of GET /api/citizens" }
  if ($null -eq $found.Row.PSObject.Properties["last_assertion_at"]) { return "the census row carries no last_assertion_at key" }
  if ($mode -ceq "uphold" -and $null -ne $found.Row.last_assertion_at) { return ("the census still serves last_assertion_at " + $found.Row.last_assertion_at + " for the handle after an uphold") }
  return ""
}
function Get-CensusPage($url) {
  $tmp = [System.IO.Path]::GetTempFileName()
  try {
    $code = (curl.exe -s --max-time 30 -o $tmp -w "%{http_code}" $url)
    if ([string]$code -ne "200") { return $null }
    $body = (Get-Content $tmp -Raw -ErrorAction SilentlyContinue)
    try { return ([string]$body | ConvertFrom-Json) } catch { return $null }
  } finally {
    Remove-Item $tmp -ErrorAction SilentlyContinue
  }
}
# END-OF-DEFINITIONS (nothing above reads or writes anything)

$why = Test-Mode $Uphold $Withdraw
if ($why -ne "") { Stop-Here $why }
$why = Test-HandleShape $Handle
if ($why -ne "") { Stop-Here $why }
$mode = "uphold"
if ($Withdraw) { $mode = "withdraw" }
if (-not $DryRun) {
  $why = Test-RealRunAllowed $Handle $ConfirmHandle $SignedRequestVerified
  if ($why -ne "") { Stop-Here $why }
  $why = Test-WithdrawRecorded $mode $ObjectionTimeRecorded
  if ($why -ne "") { Stop-Here $why }
}

# 1. the stored row, a READ: must be exactly one key seat
$before = Invoke-D1 (Get-ReadRowSql $Handle) "the stored-row read"
$why = Test-PreRow $before
if ($why -ne "") { Stop-Here $why }
$beforeRow = @($before.Rows)[0]
$why = Test-WithdrawHasFlag $mode $beforeRow
if ($why -ne "") { Stop-Here $why }
Say ("[before] " + $beforeRow.handle + ": stored last_assertion_at '" + $beforeRow.last_assertion_at + "', stored assertion_objected_at '" + $beforeRow.assertion_objected_at + "'")
$censusBefore = Find-CensusRow $Handle { param($u) Get-CensusPage $u } $CENSUS_MAX_PAGES
if ($censusBefore.Error -ne "") { Stop-Here $censusBefore.Error }
if ($null -eq $censusBefore.Row) { Stop-Here "the handle is not on any page of GET /api/citizens." }
Say ("[before] census serves last_assertion_at '" + $censusBefore.Row.last_assertion_at + "'")

if ($DryRun) {
  if ($mode -ceq "uphold") { Say ("[dry-run] would run: " + (Get-UpholdSql $Handle)) } else { Say ("[dry-run] would run: " + (Get-WithdrawSql $Handle)) }
  Say "[dry-run] then re-read the stored row, check one row changed and the postconditions, and re-read the census. Nothing was written."
  exit 0
}

# 2. the write (one statement), then the postconditions, each its own failure
if ($mode -ceq "uphold") { $writeSql = Get-UpholdSql $Handle } else { $writeSql = Get-WithdrawSql $Handle }
Say ("[write] " + $writeSql)
$written = Invoke-D1 $writeSql "the write"
$why = Test-ChangedOne $written
if ($why -ne "") { Stop-Here ($why + ". Read the row by hand before any retry.") }
$after = Invoke-D1 (Get-ReadRowSql $Handle) "the stored-row re-read"
$why = Test-StoredAfter $after $mode
if ($why -ne "") { Stop-Here ($why + ". Read the row by hand.") }
Say ("[after] stored row: " + (($after.Rows | ConvertTo-Json -Compress)))
$censusAfter = Find-CensusRow $Handle { param($u) Get-CensusPage $u } $CENSUS_MAX_PAGES
$why = Test-CensusServed $censusAfter $mode
if ($why -ne "") { Stop-Here ($why + ". The database was written; investigate the served path.") }
Say ("[done] " + $mode + " recorded for " + $Handle + "; GET /api/citizens serves last_assertion_at '" + $censusAfter.Row.last_assertion_at + "'. Nothing was chained. Keep the private record of the request and its outcome.")
