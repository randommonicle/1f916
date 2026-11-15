# Deploys the RECOVERY-UNIT-COMMIT WAVE: guests.recoveries and guests.last_recovered_at served on the roster and every profile (R1), a `unit: resident_record` on every resident total (R2), and the commit stamp recorded per
# UTC day beside the door counters, served as commits_by_day on GET /api/doors (R3). Brief drafts/BRIEF-RECOVERY-UNIT-COMMIT-2026-11-15.md; checkpoint docs/CHECKPOINT-RECOVERY-UNIT-COMMIT-2026-11-15.md. Adapted from
# scripts/deploy-resident-account.ps1 (the migration-first template) and scripts/deploy-followup-wave.ps1 (the evaluated v6 pin test, step 1b), keeping their fixes: reads by --command, one wrangler subcommand per bounded
# call, the one-hour window, the four chains compared on length and head.
# A MIGRATION WAVE, MIGRATION FIRST (L-046, L-016). Ben's hand only (D-017). One fail-fast script. Migration 0027 has THREE parts: ALTER TABLE guests ADD COLUMN recoveries, ALTER TABLE guests ADD COLUMN last_recovered_at, and
# CREATE TABLE IF NOT EXISTS commit_days. ADD COLUMN is NOT idempotent, so this script does NOT claim that re-running is safe: step 4 reads the catalogue and sorts the three objects into ABSENT (apply the migration), COMPLETE (skip it)
# or PARTIAL (STOP: some of the three exist, so the file cannot be re-applied; repair by hand against the file). A worker deployed BEFORE the migration would 500 every roster read and every door count's batch, so the migration goes first.
# NO MINT: Step 1 extracts the FRONT_DOOR_TEMPLATE literal from src/doc.ts at the live base and at HEAD and STOPS if they differ by a byte; step 1b re-runs test/constitution-v6-d1.test.ts on its own and STOPS unless it passes with
# its pinned v6 hash and its template_hash test named in the run; after the deploy it STOPS if the constitution is not still v6 with its template hash. The only migration added since the live base must be migrations/0027_resident_recoveries.sql.
# THE PRIVACY DATE: src/privacy.ts says "Last updated: 15 November 2026" and names the two new public fields. Step 0b STOPS, before any git, npm, wrangler or network command, unless the date in that file equals the UTC date of the run: if Ben
# deploys on another day, re-date src/privacy.ts (and RECOVERIES_SINCE in src/resident.ts, which states the day the counting began) first, a docs-and-text commit the architect re-reviews and re-pins. -DryRun is stopped by it too.
# THIS IS A PRIVACY-TEXT CHANGE FOR BEN (the guest and resident paragraph names recoveries and last_recovered_at), so it needs his read before the deploy.
# THE PRODUCTION TARGET IS PROVED, NOT ASSUMED (review E1): every D1 command here names the database 'commonhold'; before the first production read the script resolves the account's own UUID for 'commonhold' (npx wrangler d1 info
# commonhold --json, a read) and STOPS unless it equals the database_id wrangler.jsonc pairs with that name AND no other root wrangler config or env block maps the name to a different id.
# THIS SCRIPT DOES NOT SIGN ANYTHING and holds no key, no token and no custody file. It writes only what its steps say: migration 0027 to production D1 (only when all three objects are absent), and the stamped worker.
# ORDER: the rehearsal of the migration on the scratch D1 (scripts/rehearse-recovery-unit.ps1) has PASSED, which a real run confirms by -RehearsalPassed (the script cannot check it; it needs Ben, since wrangler prompts); then 0a the pins, 0b the
# privacy date; 1 git; 1b the v6 pin test; 2 gates (npm test, typecheck); 3 live read of the base and the attested constitution; 4 the first production read (the catalogue, scripts/verify-recovery-unit.sql, and a snapshot of every other
# sqlite_master row except the guests table row, which ADD COLUMN legitimately rewrites), which STARTS the clock: migration, worker activation and the post-activation verification must all finish within ONE HOUR of it; 5 apply 0027 ONLY
# if all three objects are absent; 6 verify on prod: the catalogue is exactly the 9 expected rows and every other object is unchanged; 7 deploy the worker (stamped) and poll for GET /api/residents carrying unit; 8 verify again after
# activation; 9 the ride, public GETs only: /api/attest (v6 unchanged, the four chains ok, sealed_entries and head identical before and after, code.commit and code.version_id the new deploy's), /api/residents (unit, the recoveries
# definition), /api/resident/1, /api/official (residents.unit), /privacy (the new sentence and the date), /api/doors (commits_by_day present, the note, and this deploy's own commit listed for today once a door has been counted), and sixteen public reads.
# LIVE MARKER: GET /api/residents has no top-level `unit` before this deploy and has it after. Step 3 STOPS if it is already there (already deployed).
# WHAT THE RIDE CANNOT DO: a recovery needs a resident's key or outside account, so nothing here recovers a token; recoveries is ridden by the first real recovery after deploy (read the profile before and after).
# ROLLBACK (written before the deploy): a worker rollback (npx wrangler rollback, to the version GET /api/attest served BEFORE the deploy, read live) leaves migration 0027 applied. That is schema-compatible, not free: while the old worker runs, recoveries are not counted and no commit stamp is recorded. The old worker sees two unused guests columns and one unused
# table the old worker never reads or writes (the old worker's SELECT * of guests ignores them). NEVER drop the columns or the table: the new worker's rows would be lost.
# TWO PINS. $LIVE_BASE_COMMIT is the commit the live worker serves when this runs (6f7ff7ed...); step 3 PROVES it against the live GET /api/attest code.commit. $REVIEWED_COMMIT is the commit the review converged on: it ships as the
# placeholder and the architect sets it after review. Step 0a STOPS, before any git or network command, while EITHER holds its placeholder or is not 40 lower-case hex. -ExpectedCommit is required.
# REVIEWED SOURCE ONLY: step 1 also STOPS unless HEAD is $REVIEWED_COMMIT plus changes confined to $ALLOWED_PATHS_AFTER_REVIEW (these scripts, the verify SQL, their test, docs/).
# Run from society/ on main, after the merge and the push (Ben, in this order):
#   cd "C:\Users\bengr\Projects\AI domain and social network\society"
#   powershell -ExecutionPolicy Bypass -File scripts\rehearse-recovery-unit.ps1                                       # the scratch D1 only; prints PASS or FAIL
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-recovery-unit.ps1 -ExpectedCommit <sha> -DryRun            # every check and the live reads (the D1 catalogue read is a READ), nothing written to production, nothing deployed (it does write local temp files and runs npm test)
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-recovery-unit.ps1 -ExpectedCommit <sha> -RehearsalPassed  # the real thing
#   If a step BEFORE the migration stopped: just re-run. If the migration was applied and a later step stopped, a re-run finds the catalogue COMPLETE and resumes at the worker. A PARTIAL catalogue always stops.
#   Once the worker has been deployed there is no resume mode: a re-run refuses because the live commit or the roster unit already matches. If a stop comes after the deploy, the worker is live: finish the remaining verification
#   by hand with the GETs this script lists, repeat the catalogue read and scripts/verify-recovery-unit.sql, or roll back to the version id printed before the stop.
# THE RIDE sends public GETs only. Two of them (/skill.md and /heartbeat.md) are counted doors, so the worker itself writes their door_counts increments and this deploy's commit_days row: those are the ride's only writes, and the last check reads them back. -DryRun exits before the ride.
# PowerShell 5.1 traps this file avoids: one spelling per variable name; -notmatch on an array filters instead of testing; a one-element return is wrapped in @(); "$var:" is a drive reference (write "${var}:");
# never merge a native command's stderr under ErrorActionPreference Stop; -eq and -ne are case-INSENSITIVE (hashes and shas are compared with -ceq / -cne); PS 5.1 strips inner double quotes from a native command's
# argument, so every READ goes to wrangler by --command as one single-quote-only line (a statement with a double quote is refused), --file is used only for the migration. ASCII only.
param(
  [Parameter(Mandatory = $true)][string]$ExpectedCommit,
  [switch]$DryRun,
  [switch]$RehearsalPassed
)
$ErrorActionPreference = "Stop"
$BASE = "https://commonhold.randommonicle.workers.dev"
$PROD_DB = "commonhold"
# The attested constitution this wave must leave untouched (v6, minted 22 Oct).
$V6_HASH = "dc5f48213c29bcf844e0fbe7daf1bdb5416b3d57fbd06a8bd03f1061f34092b3"
# The commit the live worker serves when this runs.
$LIVE_BASE_COMMIT = "6f7ff7edaed84d6cad4e932ad4f592669775d138"
$LIVE_BASE_PLACEHOLDER = "TO-BE-SET-BY-HUB-LIVE-BASE"
# THE REVIEWED SOURCE. The architect replaces this placeholder with the full sha the review converged on; step 0a STOPS while it is unchanged, and while it is not 40 lower-case hex.
$REVIEWED_COMMIT = "TO-BE-SET-BY-HUB"
$REVIEWED_COMMIT_PLACEHOLDER = "TO-BE-SET-BY-HUB"
$ALLOWED_PATHS_AFTER_REVIEW = @("scripts/deploy-recovery-unit.ps1", "scripts/rehearse-recovery-unit.ps1", "scripts/verify-recovery-unit.sql", "test/deploy-recovery-unit-script.test.ts", "docs/")
$MIGRATION_PATH = "migrations/0027_resident_recoveries.sql"
$VERIFY_SQL_PATH = "scripts/verify-recovery-unit.sql"
$PRIVACY_PATH = "src/privacy.ts"
$ROOT_CONFIGS = @("wrangler.jsonc", "wrangler.json", "wrangler.toml")
$UUID_PATTERN = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
$WINDOW_SECONDS = 3600
$WRANGLER_D1_SECONDS = 120
$WRANGLER_DEPLOY_SECONDS = 300
$POLL_TRIES = 12
$POLL_DELAY_SECONDS = 5
# One poll try reads GET /api/attest and GET /api/residents, each bounded by curl --max-time 30, then sleeps.
$POLL_READ_SECONDS = 60
$TEST_SUMMARY_PATTERN = '(?m)^(?:\S+[ \t]+)?tests (\d+)[ \t]*\r?\n(?:\S+[ \t]+)?suites (\d+)[ \t]*\r?\n(?:\S+[ \t]+)?pass (\d+)[ \t]*\r?\n(?:\S+[ \t]+)?fail (\d+)[ \t]*\r?\n(?:\S+[ \t]+)?cancelled (\d+)[ \t]*\r?\n(?:\S+[ \t]+)?skipped (\d+)[ \t]*\r?\n(?:\S+[ \t]+)?todo (\d+)[ \t]*\r?\n(?:\S+[ \t]+)?duration_ms (\d+(?:\.\d+)?)\s*\z'
# The 9 rows scripts/verify-recovery-unit.sql must return, as kind|name|detail, in the read's own order (ORDER BY 1, 2). The rehearsal script pins the same nine.
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
# The three objects the migration creates, as the catalogue rows that show each one: a PARTIAL state (some but not all) is a STOP, never an apply.
$MIGRATION_OBJECTS = @("column|guests.recoveries", "column|guests.last_recovered_at", "table|commit_days")
# Every sqlite_master row except the commit_days table and its index, and except the guests TABLE row itself (ADD COLUMN rewrites its sql by design; its columns are verified by the catalogue instead). The migration must
# leave every one of these byte for byte as it was, the indexes on guests included.
$OTHER_OBJECTS_SQL = "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE tbl_name <> 'commit_days' AND NOT (type = 'table' AND name = 'guests') ORDER BY type, name"
$MIN_OTHER_OBJECTS = 20
# The ride's markers: only the worker of THIS wave serves them.
$RESIDENT_UNIT = "resident_record"
$RECOVERIES_MARKER = "recoveries counts the successful token replacements recorded by either recovery route since this field shipped on"
$PRIVACY_MARKERS = @("recoveries, the number of successful token recoveries recorded since", "last_recovered_at, the time of the latest recorded one, or null when none is recorded")
$DOORS_NOTE_MARKER = "commits_by_day lists, for each UTC day in the window"


function Stop-Here($msg) { Write-Host "[STOP] $msg"; exit 1 }
function Say($msg) { Write-Host $msg }
# The paths in $paths that are NOT on $ALLOWED_PATHS_AFTER_REVIEW (ordinal, case-sensitive; an empty list in is an empty list out).
function Get-DisallowedPaths($paths) {
  $bad = @()
  foreach ($p in @($paths)) {
    $ok = $false
    foreach ($entry in $ALLOWED_PATHS_AFTER_REVIEW) {
      if ($entry.EndsWith("/")) { if ($p.StartsWith($entry, [System.StringComparison]::Ordinal)) { $ok = $true } }
      elseif ($p -ceq $entry) { $ok = $true }
    }
    if (-not $ok) { $bad += $p }
  }
  return $bad
}
# "" when the privacy page text's "Last updated" date is the UTC date of $nowUtc (day month-name year, invariant culture), otherwise the reason. An unreadable date is a stop, never a pass.
function Test-PrivacyDate($privacyText, $nowUtc) {
  $m = [regex]::Match([string]$privacyText, '(?m)^Last updated: (\d{1,2} [A-Z][a-z]+ \d{4})\r?$')
  if (-not $m.Success) { return "no 'Last updated: <day> <month> <year>' line was found in the privacy text" }
  $today = ([datetime]$nowUtc).ToString("d MMMM yyyy", [System.Globalization.CultureInfo]::InvariantCulture)
  if ($m.Groups[1].Value -cne $today) { return ("the privacy text says 'Last updated: " + $m.Groups[1].Value + "' but today is " + $today + " (UTC): re-date src/privacy.ts, get it reviewed and re-pinned, then run again") }
  return ""
}
# The FRONT_DOOR_TEMPLATE literal of a src/doc.ts text: from its `export const FRONT_DOOR_TEMPLATE = ` line to the first backtick that is not escaped by a backslash. $null when the marker or the
# closing backtick is not found (the caller STOPS: an unreadable template is never "unchanged").
function Get-TemplateText($docText) {
  $marker = 'export const FRONT_DOOR_TEMPLATE = `'
  $start = ([string]$docText).IndexOf($marker, [System.StringComparison]::Ordinal)
  if ($start -lt 0) { return $null }
  $i = $start + $marker.Length
  while ($true) {
    $j = ([string]$docText).IndexOf('`', $i, [System.StringComparison]::Ordinal)
    if ($j -lt 0) { return $null }
    if ($j -gt 0 -and ([string]$docText)[$j - 1] -eq [char]92) { $i = $j + 1; continue }
    return ([string]$docText).Substring($start, $j - $start + 1)
  }
}
# The counts in the eight-line summary block at the END of $testOut, or $null when the output does not end with one.
function Get-TestSummary($testOut) {
  $found = [regex]::Matches([string]$testOut, $TEST_SUMMARY_PATTERN)
  if ($found.Count -lt 1) { return $null }
  $last = $found[$found.Count - 1]
  $counts = @(1..7 | ForEach-Object { [int64]$last.Groups[$_].Value })
  return @{ Tests = $counts[0]; Pass = $last.Groups[3].Value; Fail = $last.Groups[4].Value; Cancelled = $counts[4]; Skipped = $counts[5]; Todo = $counts[6]; SumOk = ($counts[0] -eq ($counts[2] + $counts[3] + $counts[4] + $counts[5] + $counts[6])) }
}
# The status code, content type, body and the sha-256 of the response BYTES of a GET (the third parameter is kept for the callers' signature and must be empty). The content type is read from curl's own -w, never guessed.
function Get-Text($url, $maxTime, $dataFile) {
  $tmp = [System.IO.Path]::GetTempFileName()
  try {
    if ($dataFile) { Stop-Here "Get-Text was asked to send a request body: this script's ride is GETs only." }
    $meta = (curl.exe -s --max-time $maxTime -o $tmp -w "%{http_code}|%{content_type}" $url)
    $parts = ([string]$meta).Split("|", 2)
    $body = (Get-Content $tmp -Raw -Encoding UTF8 -ErrorAction SilentlyContinue)
    if ($null -eq $body) { $body = "" }
    $type = ""
    if ($parts.Count -gt 1) { $type = [string]$parts[1] }
    $sha = ""
    if (Test-Path $tmp) { $sha = (Get-FileHash -Algorithm SHA256 -Path $tmp).Hash.ToLowerInvariant() }
    return @{ Code = [string]$parts[0]; Type = $type; Body = $body; Sha256 = $sha }
  } finally {
    Remove-Item $tmp -ErrorAction SilentlyContinue
  }
}
function Get-Json($url) {
  $r = Get-Text $url 20 $null
  if ($r.Code -ne "200") { Stop-Here "GET $url -> $($r.Code), expected 200." }
  try { return ($r.Body | ConvertFrom-Json) } catch { Stop-Here "GET $url did not return JSON." }
}
function Read-Attest($when) {
  $att = Get-Json "$BASE/api/attest"
  if ($null -eq $att -or $null -eq $att.constitution -or -not $att.constitution.template_hash) { Stop-Here "GET /api/attest was unreadable $when; re-read it by hand (this is NOT a minting signal)." }
  return $att
}
function Assert-Attest($att, $when) {
  if ([string]$att.constitution.version -ne "6") { Stop-Here "constitution is version $($att.constitution.version) $when, expected 6: investigate before anything else." }
  if ($att.constitution.template_hash -cne $V6_HASH) { Stop-Here "template_hash is $($att.constitution.template_hash) $when, expected v6 ${V6_HASH}: investigate before anything else (this wave mints nothing)." }
  if ($att.ok -ne $true) { Stop-Here "GET /api/attest ok is '$($att.ok)' $when, expected true." }
  foreach ($chain in "identity_log", "treasury", "payouts", "ballots") {
    if ($att.$chain.ok -ne $true) { Stop-Here "chain $chain ok is '$($att.$chain.ok)' $when, expected true: investigate." }
  }
}
function Get-ServedCode {
  $r = Get-Text "$BASE/api/attest" 30 $null
  if ($r.Code -ne "200") { return $null }
  try { $served = ($r.Body | ConvertFrom-Json) } catch { return $null }
  if ($null -eq $served) { return $null }
  return $served.code
}
# "" when $code is the block THIS deploy should be serving, otherwise the reason it is not. Every comparison is case-sensitive.
function Test-CodeIdentityServed($code, $commit, $versionId) {
  if ($null -eq $code) { return "GET /api/attest serves no code block (an unreadable answer)" }
  if ([string]$code.commit_status -cne "stamped") { return ("code.commit_status is '" + $code.commit_status + "', expected stamped") }
  if ([string]$code.commit -cne $commit) { return ("code.commit is '" + $code.commit + "', expected the pinned sha " + $commit) }
  if ([string]$code.version_status -cne "available") { return ("code.version_status is '" + $code.version_status + "', expected available") }
  if (([string]$code.version_id).ToLowerInvariant() -cne ([string]$versionId).ToLowerInvariant()) { return ("code.version_id is '" + $code.version_id + "', expected the Current Version ID wrangler printed (" + $versionId + ")") }
  return ""
}
function Read-JsonBody($r) {
  try { return ([string]$r.Body | ConvertFrom-Json) } catch { return $null }
}
# ---- the D1 helpers: strict reads, bounded commands ----
# Runs a command line through cmd.exe with its stdout captured to a file, killing the whole process tree if it outlives $seconds. Returns @{ Code; Out; TimedOut }.
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
# The result of `wrangler d1 execute --json` output as @{ Rows = <array> }, or $null when the output is not the expected JSON. The caller treats $null as a FAILED read, never as zero rows; a hashtable wrapper is used
# because an empty array returned from a function vanishes in the pipeline and would arrive as $null.
function Read-D1Rows($text) {
  $i = ([string]$text).IndexOf("[")
  if ($i -lt 0) { return $null }
  try { $parsed = (([string]$text).Substring($i) | ConvertFrom-Json) } catch { return $null }
  if ($null -eq $parsed -or @($parsed).Count -lt 1 -or $null -eq @($parsed)[0].results) { return $null }
  return @{ Rows = @(@($parsed)[0].results) }
}
# "" when the clock started less than $WINDOW_SECONDS ago, otherwise the reason the sequence must stop.
function Test-WithinWindow($checkedAt, $now) {
  if ($null -eq $checkedAt) { return "the first production read has not completed" }
  $age = ($now - $checkedAt).TotalSeconds
  if ($age -gt $WINDOW_SECONDS) { return ("the first production read completed " + [int]$age + " s ago, over the " + $WINDOW_SECONDS + " s window: stop for recovery and run afresh") }
  return ""
}
# "" when all four chains carry the same sealed_entries and the same head in both attest reads, otherwise the first difference. (Integrity is Assert-Attest's job; this is "nothing was written".)
function Test-ChainsUnchanged($before, $after) {
  foreach ($chain in "identity_log", "treasury", "payouts", "ballots") {
    foreach ($field in "sealed_entries", "head") {
      $b = [string]$before.$chain.$field
      $a = [string]$after.$chain.$field
      if ($b -eq "" -and $a -eq "") { return ("chain " + $chain + " carries no " + $field + " in either attest read: it cannot be compared") }
      if ($a -cne $b) { return ("chain " + $chain + " changed at " + $field + " during the deploy (" + $b + " -> " + $a + ")") }
    }
  }
  return ""
}
# "" when a step whose upper bound is $requiredSeconds can START now and still END inside the window (age plus the bound stays within $WINDOW_SECONDS), otherwise the reason it must not start.
function Test-SufficientWindow($checkedAt, $now, $requiredSeconds) {
  if ($null -eq $checkedAt) { return "the first production read has not completed" }
  $age = ($now - $checkedAt).TotalSeconds
  if (($age + $requiredSeconds) -gt $WINDOW_SECONDS) { return ("the first production read completed " + [int]$age + " s ago and the next bounded step may need up to " + $requiredSeconds + " s, over the " + $WINDOW_SECONDS + " s window: stop for recovery and run afresh") }
  return ""
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
# SQL for wrangler goes by --command, never --file: with --file, `d1 execute` goes through D1's import API and returns statistics only, never rows (wrangler-dist/cli.js, the input.file branch), so a SELECT read that
# way can only fail closed. --file stays for the migration apply, whose result is the exit code alone.
# One line, single quotes only: PowerShell 5.1 mangles embedded double quotes when it calls a native exe, so a statement containing one is refused. Full-line -- comments are stripped and whitespace collapsed.
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
# Runs `$prefix "<sql>"` bounded. The statement travels in an environment variable that cmd.exe expands inside the quotes, so a percent sign or an angle bracket in it is never parsed as cmd syntax.
function Invoke-BoundedSql($prefix, $sql, $seconds) {
  $env:D1_SQL_ARG = $sql
  try {
    return (Invoke-Bounded ($prefix + ' "%D1_SQL_ARG%"') $seconds)
  } finally {
    Remove-Item Env:D1_SQL_ARG -ErrorAction SilentlyContinue
  }
}
# Runs one READ against the remote D1 by --command (bounded) and returns the parsed result, or STOPS.
function Invoke-D1Command($sql, $label) {
  $one = ConvertTo-SingleLineSql $sql
  $why = Test-SingleLineSql $one
  if ($why -ne "") { Stop-Here ("cannot send the SQL for " + $label + ": " + $why + ".") }
  # Every read after the first is itself a bounded step inside the window (the first read is the one that starts the clock).
  if ($null -ne $script:PreflightAt) { Assert-Window $label $WRANGLER_D1_SECONDS }
  $r = Invoke-BoundedSql ("npx wrangler d1 execute " + $PROD_DB + " --remote --json --command") $one $WRANGLER_D1_SECONDS
  if ($r.TimedOut) { Stop-Here ("wrangler d1 execute timed out after " + $WRANGLER_D1_SECONDS + " s on " + $label + ". The state is unknown: read the catalogue by hand before any retry.") }
  if ($r.Code -ne 0) { Stop-Here ("wrangler d1 execute failed (exit " + $r.Code + ") on " + $label + ".") }
  return (Read-D1Rows $r.Out)
}
function Invoke-D1Read($sql, $label) { return (Invoke-D1Command $sql $label) }
# STOPS, without starting the step, unless a step bounded by $requiredSeconds fits inside the window; with 0 it is the completion check.
function Assert-Window($label, $requiredSeconds) {
  $why = Test-SufficientWindow $script:PreflightAt (Get-Date) $requiredSeconds
  if ($why -ne "") { Stop-Here ("before " + $label + ": " + $why + ".") }
}
# Reads the catalogue and every other object on prod and STOPS unless the catalogue is exactly the 9 expected rows (the two new guests columns, commit_days and its primary key, the guests tail) and nothing else changed since the first production read.
function Assert-Prod-Verified($when) {
  $why = Test-Catalogue (Invoke-D1Read (Get-Content $VERIFY_SQL_PATH -Raw) "the catalogue read")
  if ($why -ne "") { Stop-Here ("catalogue check " + $when + " failed: " + $why + ".") }
  $why = Test-OthersUnchanged $script:OthersBefore (Invoke-D1Read $OTHER_OBJECTS_SQL "the other objects read") ("on prod " + $when)
  if ($why -ne "") { Stop-Here ("verification " + $when + " failed: " + $why + ". Do not deploy or continue; read the catalogue by hand.") }
}
# ---- the served-answer checks ----
# "" when $body is the parsed /api/official answer carrying the residents block with count, by_key, by_account (whole numbers) and unit resident_record, otherwise the reason.
function Test-OfficialResidents($body) {
  if ($null -eq $body) { return "GET /api/official did not return JSON" }
  $r = $body.residents
  if ($null -eq $r) { return "GET /api/official carries no residents block" }
  foreach ($field in "count", "by_key", "by_account") {
    if ($null -eq $r.PSObject.Properties[$field]) { return ("the residents block has no " + $field) }
    if (-not ([string]$r.$field -match '^[0-9]+$')) { return ("residents." + $field + " is '" + $r.$field + "', not a whole number") }
  }
  if ([string]$r.unit -cne $RESIDENT_UNIT) { return ("residents.unit is '" + $r.unit + "', expected " + $RESIDENT_UNIT) }
  if (-not ([string]$r.counts_note).Contains("counted in both")) { return "the residents block has no counts_note naming the both-ways count" }
  return ""
}
# "" when $body is the parsed roster: a whole-number total, the top-level unit, the recoveries definition in the note, and on every listed row the unit, a whole-number recoveries and a last_recovered_at property,
# otherwise the reason. This is also the LIVE MARKER: the top-level unit is absent from the old worker.
function Test-RosterServed($body) {
  if ($null -eq $body) { return "GET /api/residents did not return JSON" }
  if (-not ([string]$body.total -match '^[0-9]+$')) { return ("the roster total is '" + $body.total + "', not a whole number") }
  if ($null -eq $body.PSObject.Properties["unit"] -or [string]$body.unit -cne $RESIDENT_UNIT) { return ("the roster carries no top-level unit " + $RESIDENT_UNIT) }
  if (-not ([string]$body.note).Contains($RECOVERIES_MARKER)) { return "the roster note does not carry the recoveries definition" }
  foreach ($row in @($body.residents)) { $why = Test-ResidentRow $row; if ($why -ne "") { return $why } }
  return ""
}
# "" when a resident row (roster or profile) carries the unit, a whole-number recoveries and a last_recovered_at property (null or a whole number), otherwise the reason.
function Test-ResidentRow($row) {
  if ([string]$row.unit -cne $RESIDENT_UNIT) { return ("resident " + $row.number + " has unit '" + $row.unit + "', expected " + $RESIDENT_UNIT) }
  if ($null -eq $row.PSObject.Properties["recoveries"] -or -not ([string]$row.recoveries -match '^[0-9]+$')) { return ("resident " + $row.number + " has no whole-number recoveries") }
  if ($null -eq $row.PSObject.Properties["last_recovered_at"]) { return ("resident " + $row.number + " has no last_recovered_at") }
  if ($null -ne $row.last_recovered_at -and -not ([string]$row.last_recovered_at -match '^[0-9]+$')) { return ("resident " + $row.number + " has last_recovered_at '" + $row.last_recovered_at + "', neither null nor a whole number") }
  return ""
}
# "" when the profile read of resident 1 is honest: a 200 whose row passes Test-ResidentRow, or a 404 whose error says it is not a resident, otherwise the reason.
function Test-ProfileServed($r) {
  if ([string]$r.Code -ceq "200") {
    $j = Read-JsonBody $r
    if ($null -eq $j) { return "the profile of resident 1 is not JSON" }
    return (Test-ResidentRow $j)
  }
  if ([string]$r.Code -ceq "404") {
    $j = Read-JsonBody $r
    if ($null -eq $j -or -not ([string]$j.error -match 'resident')) { return "the 404 for resident 1 is not the resident-not-found answer" }
    return ""
  }
  return ("GET /api/resident/1 -> " + $r.Code + ", expected 200 or 404")
}
# "" when $text is the privacy page carrying the new recoveries sentence and the run's UTC date, otherwise the reason.
function Test-PrivacyServed($text, $nowUtc) {
  foreach ($marker in $PRIVACY_MARKERS) {
    if (-not ([string]$text).Contains($marker)) { return ("GET /privacy does not carry: " + $marker) }
  }
  $today = ([datetime]$nowUtc).ToString("d MMMM yyyy", [System.Globalization.CultureInfo]::InvariantCulture)
  if (-not ([string]$text).Contains("Last updated: " + $today)) { return ("GET /privacy does not say 'Last updated: " + $today + "'") }
  return ""
}
# "" when $body is the parsed /api/doors answer with a commits_by_day property whose entries each carry day, commit and first_seen_at, and the note carries the commits_by_day sentence, otherwise the reason.
function Test-DoorsServed($body) {
  if ($null -eq $body) { return "GET /api/doors did not return JSON" }
  if ($null -eq $body.PSObject.Properties["commits_by_day"]) { return "GET /api/doors carries no commits_by_day" }
  foreach ($e in @($body.commits_by_day)) {
    if ($null -eq $e) { continue }
    if ([string]$e.day -eq "" -or [string]$e.commit -eq "" -or -not ([string]$e.first_seen_at -match '^[0-9]+$')) { return "a commits_by_day entry lacks day, commit or a whole-number first_seen_at" }
  }
  if (-not ([string]$body.note).Contains($DOORS_NOTE_MARKER)) { return "the doors note does not carry the commits_by_day sentence" }
  return ""
}
# "" when $body lists $commit among today's ($nowUtc, UTC date) commits_by_day entries, otherwise the reason.
function Test-CommitListed($body, $commit, $nowUtc) {
  $day = ([datetime]$nowUtc).ToString("yyyy-MM-dd", [System.Globalization.CultureInfo]::InvariantCulture)
  foreach ($e in @($body.commits_by_day)) {
    if ($null -ne $e -and [string]$e.day -ceq $day -and [string]$e.commit -ceq $commit) { return "" }
  }
  return ("GET /api/doors lists no commits_by_day entry for " + $day + " and " + $commit)
}
# The state of the migration's three objects from one catalogue read (a parsed read result, or $null for a failed read), as @{ State; Present; Error }. State is absent (none of the three), complete (all three) or partial; a failed
# read is an Error, never 'absent'. ADD COLUMN is not idempotent, so only absent may apply the migration.
function Get-MigrationState($res) {
  if ($null -eq $res) { return @{ State = ""; Present = 0; Error = "the catalogue read returned no parsable result" } }
  $present = 0
  foreach ($key in $MIGRATION_OBJECTS) {
    $kindName = $key.Split("|", 2)
    $hit = @(@($res.Rows) | Where-Object { [string]$_.kind -ceq $kindName[0] -and [string]$_.name -ceq $kindName[1] })
    if ($hit.Count -gt 1) { return @{ State = ""; Present = 0; Error = ("the catalogue read returned " + $hit.Count + " rows for " + $key) } }
    $present += $hit.Count
  }
  if ($present -eq 0) { return @{ State = "absent"; Present = 0; Error = "" } }
  if ($present -eq $MIGRATION_OBJECTS.Count) { return @{ State = "complete"; Present = $present; Error = "" } }
  return @{ State = "partial"; Present = $present; Error = "" }
}
# BEGIN-V6-PIN-FN
# The v6 pin test's name: it renders FRONT_DOOR_TEMPLATE through GET /api/attest (every ${...} resolved) and asserts template_hash equals the v6 hash.
$V6_PIN_TEST_FILE = "test/constitution-v6-d1.test.ts"
$V6_PIN_TEST_NAME = "v6 template hash: /api/attest serves the pinned v6 hash and no longer the v5 one"
# "" when $out (the output of running $V6_PIN_TEST_FILE alone) and $code (its exit code) show the pinned test ran and passed with nothing failing, otherwise the reason.
function Test-V6PinRun($out, $code) {
  $failM = [regex]::Matches($out, '(?m)^(?:\S+[ \t]+)?fail (\d+)[ \t]*\r?$')
  $passM = [regex]::Matches($out, '(?m)^(?:\S+[ \t]+)?pass (\d+)[ \t]*\r?$')
  if ($failM.Count -lt 1 -or $passM.Count -lt 1) { return "the v6 pin test run carries no pass/fail summary" }
  if ($code -ne 0 -or $failM[$failM.Count - 1].Groups[1].Value -ne "0") { return "the v6 pin test failed (exit $code)" }
  if ($passM[$passM.Count - 1].Groups[1].Value -eq "0") { return "the v6 pin test ran no test" }
  if (-not $out.Contains($V6_PIN_TEST_NAME)) { return "the v6 pin test's template_hash test did not run" }
  # The name appearing is not a result: a skipped test is printed too. With fail 0, the name printed and skipped 0, the named test ran and passed.
  $skipM = [regex]::Matches($out, '(?m)^(?:\S+[ \t]+)?skipped (\d+)[ \t]*\r?$')
  if ($skipM.Count -lt 1) { return "the v6 pin test run carries no skipped count" }
  if ($skipM[$skipM.Count - 1].Groups[1].Value -ne "0") { return "the v6 pin test run skipped a test, so the named test's result is not proved" }
  # A TODO or a cancelled test is printed by name without its body having passed, the same hole as a skip.
  foreach ($kind in "todo", "cancelled") {
    $kindM = [regex]::Matches($out, ('(?m)^(?:\S+[ \t]+)?' + $kind + ' (\d+)[ \t]*\r?$'))
    if ($kindM.Count -lt 1) { return "the v6 pin test run carries no $kind count" }
    if ($kindM[$kindM.Count - 1].Groups[1].Value -ne "0") { return "the v6 pin test run has a $kind test, so the named test's result is not proved" }
  }
  return ""
}
# END-V6-PIN-FN
# Polls (GETs only) until the served block is this deploy's AND /api/residents carries the unit and the recoveries definition, or STOPS (with $ROLLBACK_LINE) after $tries reads.
function Wait-NewWorker($commit, $versionId, $tries, $delaySeconds) {
  $last = "never read"
  for ($n = 1; $n -le $tries; $n++) {
    $why = Test-CodeIdentityServed (Get-ServedCode) $commit $versionId
    if ($why -eq "") { $why = Test-RosterServed (Read-JsonBody (Get-Text "$BASE/api/residents" 30 $null)) }
    if ($why -eq "") {
      Say "[poll] try $n of ${tries}: GET /api/attest serves code.commit $($commit.Substring(0, 8)) and code.version_id $versionId; GET /api/residents serves the unit and the recoveries definition"
      return
    }
    $last = $why
    Say "[poll] try $n of ${tries}: not yet: $why"
    if ($n -lt $tries) { Start-Sleep -Seconds $delaySeconds }
  }
  Stop-Here ("the new worker was never shown live in " + $tries + " reads (last: " + $last + "). The deploy is not shown to be live. " + $ROLLBACK_LINE)
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
# Every D1 entry a wrangler config text declares, top level and in every env block, as @{ Name; Binding; Id } (empty strings when absent). $isToml selects the toml reader (a [[...d1_databases]] block per entry);
# otherwise the text is jsonc/json. $null when a jsonc/json text does not parse (the caller STOPS: an unreadable config is never "no alias").
function Get-ConfigD1Entries($text, $isToml) {
  $entries = @()
  $clean = Remove-ConfigComments $text
  if ($isToml) {
    foreach ($block in ([regex]::Split($clean, '(?m)^\s*\[\[[^\]]*d1_databases\]\]\s*$') | Select-Object -Skip 1)) {
      $chunk = ([regex]::Split($block, '(?m)^\s*\[')[0])
      $name = ""; $binding = ""; $id = ""
      $m = [regex]::Match($chunk, '(?m)^\s*database_name\s*=\s*"([^"]*)"'); if ($m.Success) { $name = $m.Groups[1].Value }
      $m = [regex]::Match($chunk, '(?m)^\s*binding\s*=\s*"([^"]*)"'); if ($m.Success) { $binding = $m.Groups[1].Value }
      $m = [regex]::Match($chunk, '(?m)^\s*database_id\s*=\s*"([^"]*)"'); if ($m.Success) { $id = $m.Groups[1].Value.ToLowerInvariant() }
      $entries += @(@{ Name = $name; Binding = $binding; Id = $id })
    }
    return @($entries)
  }
  try { $cfg = ($clean | ConvertFrom-Json) } catch { return $null }
  $lists = @(, @($cfg.d1_databases))
  if ($null -ne $cfg.env) { foreach ($envProp in $cfg.env.PSObject.Properties) { $lists += @(, @($envProp.Value.d1_databases)) } }
  foreach ($list in $lists) {
    foreach ($d in @($list)) {
      if ($null -eq $d) { continue }
      $name = ""; $binding = ""; $id = ""
      if ($null -ne $d.PSObject.Properties["database_name"]) { $name = [string]$d.database_name }
      if ($null -ne $d.PSObject.Properties["binding"]) { $binding = [string]$d.binding }
      if ($null -ne $d.PSObject.Properties["database_id"]) { $id = ([string]$d.database_id).ToLowerInvariant() }
      $entries += @(@{ Name = $name; Binding = $binding; Id = $id })
    }
  }
  return @($entries)
}
# The UUID of $expectedName from `wrangler d1 info <name> --json` output (banner text before the first brace is ignored), as @{ Uuid; Error }. The object must carry a name equal to $expectedName: wrangler looks the
# uuid up from the config, so the name the account returns is the only independent evidence that the config's id is production (CODEX r3).
function Get-D1InfoUuid($text, $expectedName) {
  $i = ([string]$text).IndexOf("{")
  if ($i -lt 0) { return @{ Uuid = ""; Error = "d1 info returned no JSON object" } }
  try { $info = (([string]$text).Substring($i) | ConvertFrom-Json) } catch { return @{ Uuid = ""; Error = "d1 info returned JSON that does not parse" } }
  $uuid = ""
  if ($null -ne $info.PSObject.Properties["uuid"]) { $uuid = [string]$info.uuid } elseif ($null -ne $info.PSObject.Properties["id"]) { $uuid = [string]$info.id }
  if ($uuid -eq "") { return @{ Uuid = ""; Error = "d1 info carries no uuid" } }
  if ($null -eq $info.PSObject.Properties["name"] -or [string]$info.name -eq "") { return @{ Uuid = $uuid; Error = "d1 info carries no database name, so the config's id cannot be proved to be " + $expectedName } }
  if ([string]$info.name -cne $expectedName) { return @{ Uuid = $uuid; Error = ("d1 info answers for the database '" + $info.name + "', not " + $expectedName) } }
  return @{ Uuid = $uuid.ToLowerInvariant(); Error = "" }
}
# "" when $uuid (the account's id for the production database) is a well-formed lower-case UUID, there is at least one config entry whose database_name is the production name, and EVERY entry that maps the production name (as
# database_name or binding) carries exactly that id, otherwise the reason. $entries is every D1 entry of every root config.
function Test-ProdTarget($uuid, $entries) {
  if ([string]$uuid -cnotmatch $UUID_PATTERN) { return ("the production database's id '" + $uuid + "' is not a well-formed UUID") }
  $named = @(@($entries) | Where-Object { [string]$_.Name -ceq $PROD_DB })
  if ($named.Count -lt 1) { return ("no wrangler config entry pairs database_name " + $PROD_DB + " with a database_id, so the id the account reports cannot be compared") }
  foreach ($e in @($entries)) {
    if ([string]$e.Name -ceq $PROD_DB -or [string]$e.Binding -ceq $PROD_DB) {
      if ([string]$e.Id -cne $uuid) { return ("a wrangler config entry maps the name " + $PROD_DB + " to database_id '" + $e.Id + "' but the account says " + $uuid + ": wrangler would send the migration to the config's database, not the account's. Not this script's deploy") }
    }
  }
  return ""
}
# END-OF-DEFINITIONS (nothing above runs git, npm, wrangler or the network)

# 0a. the two pins, BEFORE any git, npm, wrangler or network command: a placeholder is never a commit, and a malformed pin must not reach `git merge-base`
# BEGIN-PIN-CHECK
if ($LIVE_BASE_COMMIT -ceq $LIVE_BASE_PLACEHOLDER) { Stop-Here "`$LIVE_BASE_COMMIT still holds the placeholder '$LIVE_BASE_PLACEHOLDER': the hub sets it to the commit the live worker serves." }
if ($LIVE_BASE_COMMIT -cnotmatch '^[0-9a-f]{40}$') { Stop-Here "`$LIVE_BASE_COMMIT '$LIVE_BASE_COMMIT' is not 40 lower-case hex. Nothing was read or written." }
if ($REVIEWED_COMMIT -ceq $REVIEWED_COMMIT_PLACEHOLDER) { Stop-Here "`$REVIEWED_COMMIT still holds the placeholder '$REVIEWED_COMMIT_PLACEHOLDER': the hub sets it to the commit the review converged on." }
if ($REVIEWED_COMMIT -cnotmatch '^[0-9a-f]{40}$') { Stop-Here "`$REVIEWED_COMMIT '$REVIEWED_COMMIT' is not 40 lower-case hex. Nothing was read or written." }
# END-PIN-CHECK
# BEGIN-REHEARSAL-CHECK
if (-not $DryRun -and -not $RehearsalPassed) { Stop-Here "a real run needs -RehearsalPassed: scripts/rehearse-recovery-unit.ps1 must have printed PASS against the scratch D1 (the two guests columns and commit_days created, no other object changed, the rows_written of a first insert, a duplicate and a second stamp), and this script cannot check that. Nothing was read or written." }
# END-REHEARSAL-CHECK
# 0b. the privacy date: the file on disk must say today's UTC date (a local read, no git, no network). A re-dated file is a source change the hub re-reviews, so this stops before anything is read or written.
# BEGIN-DATE-CHECK
if (-not (Test-Path $PRIVACY_PATH)) { Stop-Here "$PRIVACY_PATH is missing: run this from the repo root." }
$why = Test-PrivacyDate (Get-Content $PRIVACY_PATH -Raw) ((Get-Date).ToUniversalTime())
if ($why -ne "") { Stop-Here "$why. Nothing was read or written." }
# END-DATE-CHECK

# 1. the commit: fetch, then main, origin/main and the expected sha must be ONE commit, on a clean tree
Say "[git] git fetch origin"
git fetch origin --quiet
if ($LASTEXITCODE -ne 0) { Stop-Here "git fetch failed; the level check below would read a stale origin/main." }
$branch = (git rev-parse --abbrev-ref HEAD).Trim()
if ($branch -cne "main") { Stop-Here "the current branch is '$branch', not main: deploy from main only." }
$headSha = (git rev-parse HEAD).Trim()
$originSha = (git rev-parse origin/main).Trim()
$mainSha = (git rev-parse main).Trim()
$ErrorActionPreference = "Continue"
$expectedSha = (git rev-parse --verify ($ExpectedCommit + "^{commit}"))
$expectedCode = $LASTEXITCODE
$ErrorActionPreference = "Stop"
if ($expectedCode -ne 0 -or -not $expectedSha) { Stop-Here "-ExpectedCommit '$ExpectedCommit' is not a commit in this repository." }
$expectedSha = ([string]$expectedSha).Trim()
if ($mainSha -cne $originSha -or $mainSha -cne $expectedSha -or $headSha -cne $expectedSha) {
  Stop-Here ("main, origin/main and -ExpectedCommit are not one commit: HEAD " + $headSha.Substring(0, 8) + ", main " + $mainSha.Substring(0, 8) + ", origin/main " + $originSha.Substring(0, 8) + ", expected " + $expectedSha.Substring(0, 8) + ".")
}
if ($headSha -cnotmatch '^[0-9a-f]{40}$') { Stop-Here "HEAD '$headSha' is not 40 lower-case hex: it could not be stamped (the Worker would serve malformed_stamp)." }
$dirty = @(git status --porcelain)
if ($LASTEXITCODE -ne 0) { Stop-Here "git status failed (exit $LASTEXITCODE): the clean-tree check cannot be read." }
if ($dirty.Count -gt 0) { Stop-Here ("working tree not clean (" + $dirty.Count + " paths): the deploy must ship exactly the committed tree.") }
git merge-base --is-ancestor $LIVE_BASE_COMMIT HEAD
if ($LASTEXITCODE -ne 0) { Stop-Here "HEAD does not contain $($LIVE_BASE_COMMIT.Substring(0, 8)) (the live worker's code): this deploy would drop the waves before it." }
# Non-minting: the attested template lives in FRONT_DOOR_TEMPLATE in src/doc.ts. This wave edits src/doc.ts OUTSIDE the template (the RESIDENTS section), so the proof is the template text itself, byte-identical at both commits.
$liveDoc = (@(git show ($LIVE_BASE_COMMIT + ":src/doc.ts")) -join "`n")
if ($LASTEXITCODE -ne 0) { Stop-Here "git show $($LIVE_BASE_COMMIT.Substring(0, 8)):src/doc.ts failed (exit $LASTEXITCODE): the no-mint check cannot be read." }
$headDoc = (@(git show ($headSha + ":src/doc.ts")) -join "`n")
if ($LASTEXITCODE -ne 0) { Stop-Here "git show $($headSha.Substring(0, 8)):src/doc.ts failed (exit $LASTEXITCODE): the no-mint check cannot be read." }
$liveTemplate = Get-TemplateText $liveDoc
$headTemplate = Get-TemplateText $headDoc
if ($null -eq $liveTemplate -or $null -eq $headTemplate) { Stop-Here "FRONT_DOOR_TEMPLATE could not be found in src/doc.ts at one of the two commits: the no-mint check cannot be read." }
if ($liveTemplate -cne $headTemplate) { Stop-Here "FRONT_DOOR_TEMPLATE differs between $($LIVE_BASE_COMMIT.Substring(0, 8)) and HEAD: this wave mints nothing and was to leave the attested template alone. Not this script's deploy." }
# The ONLY migration since the live code is 0027, added (not edited).
$migMoves = @(git diff --name-status --no-renames $LIVE_BASE_COMMIT HEAD -- migrations)
if ($LASTEXITCODE -ne 0) { Stop-Here "git diff failed (exit $LASTEXITCODE): the migration check cannot be read." }
if ($migMoves.Count -ne 1 -or $migMoves[0] -cne ("A`t" + $MIGRATION_PATH)) { Stop-Here ("expected exactly one added migration (" + $MIGRATION_PATH + ") since " + $LIVE_BASE_COMMIT.Substring(0, 8) + ", found: " + ($migMoves -join " | ")) }
# BEGIN-REVIEWED-SOURCE-CHECK
git merge-base --is-ancestor $REVIEWED_COMMIT HEAD
if ($LASTEXITCODE -ne 0) { Stop-Here "HEAD does not contain the reviewed commit $($REVIEWED_COMMIT.Substring(0, 8)): this is not the code that was reviewed." }
$afterReview = @(git diff --name-only --no-renames $REVIEWED_COMMIT HEAD)
if ($LASTEXITCODE -ne 0) { Stop-Here "git diff failed (exit $LASTEXITCODE): the changes since the reviewed commit cannot be read." }
$unreviewed = @(Get-DisallowedPaths $afterReview)
if ($unreviewed.Count -gt 0) { Stop-Here ("these paths changed since the reviewed commit " + $REVIEWED_COMMIT.Substring(0, 8) + " and are not on the allowlist (" + ($ALLOWED_PATHS_AFTER_REVIEW -join ", ") + "), so what would ship is not what was reviewed: " + ($unreviewed -join ", ")) }
Say ("[git] reviewed source: HEAD differs from " + $REVIEWED_COMMIT.Substring(0, 8) + " in " + $afterReview.Count + " path(s), all on the allowlist")
# END-REVIEWED-SOURCE-CHECK
if (-not (Select-String -Path "src/resident.ts" -Pattern "last_recovered_at" -SimpleMatch -Quiet)) { Stop-Here "src/resident.ts does not serve last_recovered_at: this checkout is not the recovery-unit wave." }
if (-not (Select-String -Path "src/resident-account.ts" -Pattern "recoveries = recoveries + 1" -SimpleMatch -Quiet)) { Stop-Here "src/resident-account.ts does not count a recovery: this checkout is not the recovery-unit wave." }
if (-not (Select-String -Path "src/doors.ts" -Pattern "commit_days" -SimpleMatch -Quiet)) { Stop-Here "src/doors.ts does not write commit_days: this checkout is not the recovery-unit wave." }
if (-not (Select-String -Path "src/guest-core.ts" -Pattern "RESIDENT_UNIT" -SimpleMatch -Quiet)) { Stop-Here "src/guest-core.ts has no RESIDENT_UNIT: this checkout would not serve the unit." }
if (-not (Select-String -Path "src/privacy.ts" -Pattern "last_recovered_at" -SimpleMatch -Quiet)) { Stop-Here "src/privacy.ts does not name last_recovered_at: this checkout would not serve the privacy sentence." }
if (-not (Select-String -Path "src/code-identity.ts" -Pattern "export function codeBlock" -Quiet)) { Stop-Here "src/code-identity.ts has no codeBlock: this checkout would drop served code identity." }
if (-not (Test-Path $MIGRATION_PATH)) { Stop-Here "$MIGRATION_PATH is missing." }
if (-not (Test-Path $VERIFY_SQL_PATH)) { Stop-Here "$VERIFY_SQL_PATH is missing: the verification cannot run." }
$verifyWhy = Test-SingleLineSql (ConvertTo-SingleLineSql (Get-Content $VERIFY_SQL_PATH -Raw))
if ($verifyWhy -ne "") { Stop-Here "$VERIFY_SQL_PATH cannot be sent as one --command argument: $verifyWhy." }
$otherWhy = Test-SingleLineSql $OTHER_OBJECTS_SQL
if ($otherWhy -ne "") { Stop-Here "the other-objects SQL cannot be sent as one --command argument: $otherWhy." }
if (-not (Select-String -Path "wrangler.jsonc" -Pattern '"version_metadata"' -Quiet)) { Stop-Here "wrangler.jsonc has no version_metadata binding: the Worker could not serve Cloudflare's version id." }
if (Select-String -Path "wrangler.jsonc" -Pattern '"CODE_COMMIT"' -Quiet) { Stop-Here "wrangler.jsonc configures a CODE_COMMIT var: a deploy that forgot the flag would serve a stale stamp. The stamp comes from this script's --var flag only." }
Say ("[git] HEAD " + $headSha.Substring(0, 8) + " = main = origin/main = -ExpectedCommit; tree clean; contains " + $LIVE_BASE_COMMIT.Substring(0, 8) + "; FRONT_DOOR_TEMPLATE byte-identical to the live base; the one new migration is " + $MIGRATION_PATH)

# 2. the wave's own gates, re-run here so a stale checkout cannot deploy
# BEGIN-GATES
$ErrorActionPreference = "Continue"
$testOut = (npm test 2>&1 | Out-String)
$testCode = $LASTEXITCODE
$tscOut = (npm run typecheck 2>&1 | Out-String)
$tscCode = $LASTEXITCODE
$ErrorActionPreference = "Stop"
$summary = Get-TestSummary $testOut
if ($null -eq $summary) { Stop-Here "npm test: exit $testCode, the output does not END with node's eight-line summary (tests, suites, pass, fail, cancelled, skipped, todo, duration_ms): the run did not finish, or failure detail was printed after the summary. Read the output by hand." }
if (-not $summary.SumOk) { Stop-Here ("npm test: the summary's tests count (" + $summary.Tests + ") is not pass + fail + cancelled + skipped + todo (" + $summary.Pass + " + " + $summary.Fail + " + " + $summary.Cancelled + " + " + $summary.Skipped + " + " + $summary.Todo + ").") }
if ($testCode -ne 0 -or $summary.Fail -ne "0" -or -not $summary.Pass) { Stop-Here ("npm test: exit " + $testCode + ", pass '" + $summary.Pass + "', fail '" + $summary.Fail + "'.") }
if ($tscCode -ne 0) { Stop-Here "typecheck failed: $tscOut" }
Say ("[tests] pass " + $summary.Pass + ", fail 0; typecheck clean")
# END-GATES
# 1b. the no-mint proof on the evaluated template: the v6 pin test on its own, its hash literal present, its template_hash test named in the run.
# BEGIN-V6-PIN-CHECK
if (-not ((Get-Content -Raw -Encoding UTF8 $V6_PIN_TEST_FILE).Contains($V6_HASH))) { Stop-Here "$V6_PIN_TEST_FILE no longer carries the v6 hash ${V6_HASH}: the no-mint proof is gone." }
$ErrorActionPreference = "Continue"
$v6Out = (node --experimental-strip-types --test --test-reporter=spec $V6_PIN_TEST_FILE 2>&1 | Out-String)
$v6Code = $LASTEXITCODE
$ErrorActionPreference = "Stop"
$whyV6 = Test-V6PinRun $v6Out $v6Code
if ($whyV6 -ne "") { Stop-Here ($whyV6 + ": the evaluated constitution template may have moved; this wave mints nothing. Not this script's deploy.") }
Say ("[no-mint] " + $V6_PIN_TEST_FILE + " passes: the evaluated template hashes to v6 " + $V6_HASH.Substring(0, 8))
# END-V6-PIN-CHECK

# 3. live, before: non-minting baseline, the live worker is the pinned base, and the residents split is not yet served
$attBefore = Read-Attest "before the deploy"
Assert-Attest $attBefore "before the deploy"
Say ("[live] before: v6 " + $V6_HASH.Substring(0, 8) + "; all four chains ok; identity " + $attBefore.identity_log.sealed_entries + ", treasury " + $attBefore.treasury.sealed_entries + ", ballots " + $attBefore.ballots.sealed_entries)
if ($null -eq $attBefore.code -or [string]$attBefore.code.commit_status -cne "stamped") { Stop-Here "GET /api/attest serves no stamped code.commit before the deploy: the live worker cannot be shown to be the base this wave was checked against." }
if ([string]$attBefore.code.commit -ceq $headSha) { Stop-Here "GET /api/attest already serves code.commit $($headSha.Substring(0, 8)): this commit looks already deployed. Verify by hand." }
if ([string]$attBefore.code.commit -cne $LIVE_BASE_COMMIT) { Stop-Here ("the live worker serves code.commit " + $attBefore.code.commit + " but `$LIVE_BASE_COMMIT is " + $LIVE_BASE_COMMIT + ": the base this wave was checked against is not what is live. Correct the pin only after reading what changed.") }
$rollbackTarget = "the version before it (check npx wrangler deployments list)"
if ([string]$attBefore.code.version_status -ceq "available" -and $attBefore.code.version_id) { $rollbackTarget = [string]$attBefore.code.version_id }
Say "[live] before: the live worker serves the pinned base $($LIVE_BASE_COMMIT.Substring(0, 8)); rollback target $rollbackTarget"
$rosterBefore = Read-JsonBody (Get-Text "$BASE/api/residents" 30 $null)
if ($null -eq $rosterBefore) { Stop-Here "GET /api/residents did not return JSON before the deploy: read it by hand." }
if ($null -ne $rosterBefore.PSObject.Properties["unit"]) { Stop-Here "GET /api/residents already serves a top-level unit: this looks already deployed, verify by hand." }

# 3b. THE PRODUCTION TARGET (E1): the account's own UUID for the database every D1 command below names, compared with the root wrangler configs. A READ, so -DryRun runs it too.
# BEGIN-PROD-TARGET
$prodEntries = @()
foreach ($configPath in $ROOT_CONFIGS) {
  if (-not (Test-Path $configPath)) { continue }
  $found = Get-ConfigD1Entries (Get-Content $configPath -Raw) ($configPath.EndsWith(".toml"))
  if ($null -eq $found) { Stop-Here "$configPath does not parse: the production database's id cannot be compared." }
  $prodEntries += @($found)
}
$prodInfo = Invoke-Bounded ("npx wrangler d1 info " + $PROD_DB + " --json") $WRANGLER_D1_SECONDS
if ($prodInfo.TimedOut) { Stop-Here ("wrangler d1 info timed out after " + $WRANGLER_D1_SECONDS + " s: the production database's id could not be resolved. Nothing was written.") }
if ($prodInfo.Code -ne 0) { Stop-Here ("wrangler d1 info failed (exit " + $prodInfo.Code + "): the production database's id could not be resolved. Nothing was written.") }
$prodResolved = Get-D1InfoUuid $prodInfo.Out $PROD_DB
if ($prodResolved.Error -ne "") { Stop-Here ($prodResolved.Error + ". Nothing was written.") }
$why = Test-ProdTarget $prodResolved.Uuid $prodEntries
if ($why -ne "") { Stop-Here ($why + ". Nothing was written.") }
Say ("[target] " + $PROD_DB + " resolves to " + $prodResolved.Uuid + " on the account; the repo's wrangler config pairs " + $PROD_DB + " with " + $prodResolved.Uuid + ": they are equal")
# END-PROD-TARGET

# 4. THE FIRST PRODUCTION READ. The clock starts BEFORE it is invoked, so the read's own run time (up to $WRANGLER_D1_SECONDS) is inside the window. READS, so -DryRun runs them too.
$script:PreflightAt = Get-Date
$catRes = Invoke-D1Read (Get-Content $VERIFY_SQL_PATH -Raw) "the catalogue state read"
$migState = Get-MigrationState $catRes
if ($migState.Error -ne "") { Stop-Here $migState.Error }
if ($migState.State -ceq "partial") { Stop-Here ("the catalogue shows " + $migState.Present + " of the 3 migration objects (" + ($MIGRATION_OBJECTS -join ", ") + ") on prod: a PARTIAL migration. ADD COLUMN cannot be applied twice, so this script will not apply the file again. Read the catalogue by hand and repair against " + $MIGRATION_PATH + ". Nothing was written.") }
$script:OthersBefore = Invoke-D1Read $OTHER_OBJECTS_SQL "the other objects snapshot"
$why = Test-OthersUnchanged $script:OthersBefore $script:OthersBefore "the first read against itself"
if ($why -ne "") { Stop-Here ("the first snapshot of the other objects is unusable: " + $why) }
Say ("[window] production D1 first read at " + $script:PreflightAt.ToString("o") + "; migration, worker activation and the post-activation verification must finish within " + $WINDOW_SECONDS + " s of this")
Say ("[d1] on prod before: migration 0027 is " + $migState.State + "; " + @($script:OthersBefore.Rows).Count + " other objects snapshotted; the migration applies only when absent")

if ($DryRun) {
  Say "[dry-run] would now: apply $MIGRATION_PATH to the REMOTE D1 (only if absent; skipped if complete); verify the catalogue (exactly the 9 rows of $VERIFY_SQL_PATH) and that every other object is unchanged; run npx wrangler deploy --var CODE_COMMIT:<the full sha> (bounded) and capture its Current Version ID; poll up to $POLL_TRIES times, $POLL_DELAY_SECONDS s apart; verify again; then ride the public reads. Nothing was written to the remote and nothing was deployed. The script signs nothing."
  exit 0
}

# 5. migration 0027 to the REMOTE D1 FIRST (two ADD COLUMNs and one table, nothing else), applied ONLY when all three objects are absent (the state read in step 4). ADD COLUMN is not idempotent: there is no 're-run is safe' here.
# BEGIN-MIGRATION
if ($migState.State -ceq "complete") {
  Say "[d1] migration 0027: all three objects are already on prod, not applied"
} else {
  Assert-Window "applying migration 0027" $WRANGLER_D1_SECONDS
  Say ("[d1] applying " + $MIGRATION_PATH + " to the remote database")
  $mig = Invoke-Bounded ("npx wrangler d1 execute " + $PROD_DB + " --remote --file " + $MIGRATION_PATH) $WRANGLER_D1_SECONDS
  if ($mig.TimedOut) { Stop-Here ("migration 0027 timed out after " + $WRANGLER_D1_SECONDS + " s; the state is unknown and may be PARTIAL. Read the catalogue by hand (scripts/verify-recovery-unit.sql) before any re-run: the two ADD COLUMNs cannot be applied twice.") }
  if ($mig.Code -ne 0) { Stop-Here ("migration 0027 failed (exit " + $mig.Code + "); nothing deployed. The state may be PARTIAL: read the catalogue by hand before any retry; the two ADD COLUMNs cannot be applied twice.") }
}
# END-MIGRATION-APPLY

# 6. catalogue and verification on prod (db-migration-verification): the worker deploys only if the catalogue is exactly the 9 rows and no other object changed
Assert-Window "the catalogue verification (two reads)" (2 * $WRANGLER_D1_SECONDS)
Assert-Prod-Verified "after the migration"
Say "[d1] verified on prod: the two guests columns (types, notnull, default, order), commit_days with its primary key, and every other object unchanged"
# END-MIGRATION

# 7. deploy the worker with the commit stamp, capturing its version id, then poll until the served identity is this deploy's
# BEGIN-DEPLOY-AND-POLL
Assert-Window "the worker deploy and its poll" ($WRANGLER_DEPLOY_SECONDS + ($POLL_TRIES * ($POLL_DELAY_SECONDS + $POLL_READ_SECONDS)))
$headNow = (git rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $headNow -cne $headSha) { Stop-Here ("HEAD moved since step 1 (" + $headSha.Substring(0, 8) + " -> " + $headNow + "): the migration is applied, the worker was not deployed. Re-run once HEAD is right.") }
$dirtyNow = @(git status --porcelain)
if ($LASTEXITCODE -ne 0) { Stop-Here "git status failed (exit $LASTEXITCODE) just before the deploy: the worker was not deployed." }
if ($dirtyNow.Count -gt 0) { Stop-Here ("the working tree changed since step 1 (" + $dirtyNow.Count + " paths: " + ($dirtyNow -join " | ") + "): the worker was not deployed.") }
Say "[deploy] npx wrangler deploy --var CODE_COMMIT:$($headSha.Substring(0, 8))... (commit $($headSha.Substring(0, 8)))"
$dep = Invoke-Bounded ("npx wrangler deploy --var CODE_COMMIT:" + $headSha) $WRANGLER_DEPLOY_SECONDS
if ($dep.TimedOut) { Stop-Here "wrangler deploy timed out after $WRANGLER_DEPLOY_SECONDS s; whether it took effect is unknown. Check 'npx wrangler deployments list' by hand. Migration 0027 is applied and harmless to the old worker." }
if ($dep.Code -ne 0) { Stop-Here "wrangler deploy failed (exit $($dep.Code)); migration 0027 is applied and harmless to the old worker. Re-run: the catalogue will read COMPLETE and the migration is skipped. Output: $($dep.Out)" }
$versionMatches = @([regex]::Matches($dep.Out, '(?m)^[ \t]*Current Version ID:[ \t]*([0-9a-fA-F-]{36})[ \t]*\r?$'))
if ($versionMatches.Count -gt 1) { Stop-Here ("wrangler deploy printed 'Current Version ID' on " + $versionMatches.Count + " lines; which one is this deploy's cannot be told. Check 'npx wrangler deployments list' by hand before anything else.") }
if ($versionMatches.Count -lt 1) { Stop-Here "wrangler deploy exited 0 but printed no 'Current Version ID'; the deploy may have succeeded. Check 'npx wrangler deployments list' by hand before anything else." }
$versionId = $versionMatches[0].Groups[1].Value
Say "[deploy] worker version id $versionId (commit $($headSha.Substring(0, 8)))"
$ROLLBACK_LINE = "ROLL BACK THE WORKER (npx wrangler rollback, to the version before $versionId, which should be $rollbackTarget; check npx wrangler deployments list first). Migration 0027 stays applied and the old worker runs on it unchanged (two unused guests columns and one unused table), but while it runs no recovery is counted and no commit stamp is recorded. NEVER drop them: the new worker keeps its recoveries and commit_days rows there."
Wait-NewWorker $headSha $versionId $POLL_TRIES $POLL_DELAY_SECONDS
# END-DEPLOY-AND-POLL

# 8. the verification again AFTER activation
# BEGIN-RECONCILE
Assert-Window "the post-activation verification (two reads)" (2 * $WRANGLER_D1_SECONDS)
Assert-Prod-Verified "after worker activation"
Assert-Window "completion of the post-activation verification" 0
Say "[d1] post-activation: the catalogue is still exactly the 9 rows and nothing else changed"
# END-RECONCILE

# 9. the ride: non-minting and the chains, then public reads only.
$attAfter = Read-Attest "after the deploy"
Assert-Attest $attAfter "after the deploy"
$why = Test-CodeIdentityServed $attAfter.code $headSha $versionId
if ($why -ne "") { Stop-Here "after the poll, ${why}: another deploy may have taken over. Check npx wrangler deployments list by hand." }
$why = Test-ChainsUnchanged $attBefore $attAfter
if ($why -ne "") { Stop-Here "$why. Something wrote during the deploy: read what, by hand." }
Say ("[ride] attest: v6 " + $V6_HASH.Substring(0, 8) + " unchanged; the four chains (identity_log, treasury, payouts, ballots) ok, with sealed_entries and head identical to before; code.commit " + ([string]$attAfter.code.commit).Substring(0, 8) + ", code.version_id " + $attAfter.code.version_id)
$why = Test-RosterServed (Read-JsonBody (Get-Text "$BASE/api/residents" 30 $null))
if ($why -ne "") { Stop-Here "GET /api/residents: $why. $ROLLBACK_LINE" }
Say "[ride] GET /api/residents -> 200, unit resident_record, the recoveries definition, every row with unit, recoveries and last_recovered_at"
$profileRead = Get-Text "$BASE/api/resident/1" 30 $null
$why = Test-ProfileServed $profileRead
if ($why -ne "") { Stop-Here "GET /api/resident/1: $why. $ROLLBACK_LINE" }
if ([string]$profileRead.Code -ceq "404") { Say "[ride] GET /api/resident/1 -> 404, no resident 1: the profile's new fields are NOT RIDDEN here (a 404 carries none, and the old worker answers the same). The roster check above is the proof that the new worker serves." }
else { Say "[ride] GET /api/resident/1 -> 200, a profile with unit, recoveries and last_recovered_at" }
$why = Test-OfficialResidents (Read-JsonBody (Get-Text "$BASE/api/official" 30 $null))
if ($why -ne "") { Stop-Here "GET /api/official: $why. $ROLLBACK_LINE" }
Say "[ride] GET /api/official -> the residents block with count, by_key, by_account, unit and counts_note"
$privacy = Get-Text "$BASE/privacy" 30 $null
if ($privacy.Code -ne "200") { Stop-Here "GET /privacy -> $($privacy.Code). $ROLLBACK_LINE" }
$why = Test-PrivacyServed $privacy.Body ((Get-Date).ToUniversalTime())
if ($why -ne "") { Stop-Here "$why. $ROLLBACK_LINE" }
Say "[ride] GET /privacy -> the recoveries sentence and today's date"
$bad = @()
foreach ($p in "/", "/api/official", "/openapi.json", "/treasury", "/api/listings", "/api/stats", "/api/topics", "/api/guest/due", "/api/proposals", "/api/doors", "/api/council", "/api/residents", "/heartbeat.md", "/skill.md", "/llms.txt", "/privacy") {
  $r = Get-Text "$BASE$p" 30 $null
  if ($r.Code -ne "200") { $bad += "$p=$($r.Code)" }
}
if ($bad.Count -gt 0) { Stop-Here ("non-200 after the deploy (version $versionId): " + ($bad -join ", ") + ". If a read that answered before now fails: $ROLLBACK_LINE") }
Say "[ride] 16 public reads -> 200"
# The doors read comes LAST: the /skill.md and /heartbeat.md reads above are counted doors, so this deploy's stamp should be listed for today (the count is handed to waitUntil, so a few short retries are allowed).
$doorsWhy = "never read"
for ($n = 1; $n -le 4; $n++) {
  $doorsBody = Read-JsonBody (Get-Text "$BASE/api/doors" 30 $null)
  $doorsWhy = Test-DoorsServed $doorsBody
  if ($doorsWhy -eq "") { $doorsWhy = Test-CommitListed $doorsBody $headSha ((Get-Date).ToUniversalTime()) }
  if ($doorsWhy -eq "") { break }
  # A retry repeats a counted door first: /api/doors is not a counted door, so if the earlier counts never landed, polling it alone could not produce the stamp. Counted GET, then the wait, then the doors read.
  if ($n -lt 4) { $null = Get-Text "$BASE/skill.md" 30 $null; Start-Sleep -Seconds 3 }
}
if ($doorsWhy -ne "") { Stop-Here "GET /api/doors: $doorsWhy. $ROLLBACK_LINE" }
Say "[ride] GET /api/doors -> commits_by_day present, the note, and this deploy's commit listed for today"
Say "[done] recovery-unit wave deployed and verified. Public serving verified; recoveries NOT exercised: a recovery needs a resident's key or outside account, so the first real recovery is its ride (read the profile before and after). Log version id $versionId, commit $($headSha.Substring(0, 8)) and these lines in HANDOVER.md."
