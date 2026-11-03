# Deploys the DECIDED-EVENT-ID WAVE (D-078 item 3): each proposal row carries decided_event_id, the id of the chained proposal_decided event that recorded its tally outcome, served on GET /api/proposals,
# GET /api/proposal/:id and the proposals and proposal tools of /mcp and /mcp/read. Spec: drafts/BRIEF-DECIDED-EVENT-ID-2026-11-03.md with amendments A1-A6 (A5 is this script); checkpoint docs/CHECKPOINT-DECIDED-EVENT-ID.md.
# A MIGRATION WAVE, MIGRATION FIRST (L-046, L-016). Ben's hand only (D-017). One fail-fast script. NO MINT: step 0 STOPS if src/doc.ts differs between the live base and HEAD, and unless the ONLY migration added since the
# live base is migrations/0023_decided_event_id.sql (an ADD COLUMN plus an idempotent backfill; no rebuild, no FK detach). The scratch-D1 rehearsal of 0023 against a prod copy is the hub's, with Ben, BEFORE this script runs.
# STEPS (A5): 1 pins and git; 2 gates (npm test, typecheck); 3 live read of the base and the attested constitution; 4 PREFLIGHT immediately before the migration: SELECT COUNT(*) AS pending FROM proposals WHERE status IN
# ('open','tallying') against production D1, a successfully parsed result with pending = 0 or STOP (absent or malformed fails closed); the time it completed is recorded and migration, worker activation and reconciliation must all finish
# within ONE HOUR of it (every step re-checks the window; wrangler commands are bounded by a timeout), else STOP for recovery and a fresh preflight. This whole-table count excludes existing pending tallies; proposals opened
# afterwards cannot become due inside the window under the seven-day minimum voting window. Step 7 repairs missing pointers on decided rows; it does not detect newly opened proposals. 5 apply 0023 (column plus backfill);
# 6 verify on prod: pragma_table_info shows the column, scripts/verify-decided-event-id.sql returns ZERO rows (STOP on any mismatch row), and the six historical pairs (1,6) (2,12) (5,16) (6,20) (7,25) (8,37) are present (those six are
# checked; extra proposals are not rejected); 7 deploy the worker (stamped) and poll; 8 re-run the backfill UPDATE (idempotent: it fills only NULL pointers on decided rows) and the verification AFTER activation; 9 ride HTTP list and
# detail and the proposals and proposal tools on /mcp and /mcp/read, and /api/attest (chains ok and sealed counts unchanged).
# ROLLBACK (written before the deploy): a worker rollback (npx wrangler rollback, to the version GET /api/attest served BEFORE the deploy, read live) leaves migration 0023 applied: an extra nullable column the old worker never reads.
# It restores a writer that does not fill the pointer. After ANY tally made under the rolled-back worker the recovery is the same idempotent backfill UPDATE (the block between BEGIN/END BACKFILL in migrations/0023_decided_event_id.sql)
# followed by scripts/verify-decided-event-id.sql, which must return zero rows. Do not drop the column.
# TWO PINS. $LIVE_BASE_COMMIT is the commit the live worker serves when this runs (7b49b7b6, worker 89166900); step 3 PROVES it against the live GET /api/attest code.commit. $REVIEWED_COMMIT is the commit the review converged
# on; the hub sets it after review. Step 0a STOPS, before any git or network command, while EITHER holds its placeholder or is not 40 lower-case hex. -ExpectedCommit is required.
# REVIEWED SOURCE ONLY: step 1 also STOPS unless HEAD is $REVIEWED_COMMIT plus changes confined to $ALLOWED_PATHS_AFTER_REVIEW (this script, its test, docs/).
# Run from society/ on main, after the merge and the push:
#   cd "C:\Users\bengr\Projects\AI domain and social network\society"
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-decided-event-id.ps1 -ExpectedCommit <sha> -DryRun   # every check and the live reads (including the D1 preflight, a READ), nothing written, nothing deployed
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-decided-event-id.ps1 -ExpectedCommit <sha>           # the real thing
#   If the migration was applied and a later step stopped: re-run with -MigrationAlreadyApplied (the preflight, the catalogue and the verification still run).
# THE RIDE writes nothing: public GETs, and two POSTs of a read-only tools/call whose body is sent from a temp file.
# PowerShell 5.1 traps this file avoids: one spelling per variable name; -notmatch on an array filters instead of testing; a one-element return is wrapped in @(); "$var:" is a drive reference (write "${var}:");
# never merge a native command's stderr under ErrorActionPreference Stop; -eq and -ne are case-INSENSITIVE (hashes and shas are compared with -ceq / -cne); PS 5.1 strips inner double quotes from a native command's
# argument, so SQL goes to wrangler by --file and request bodies by --data-binary @file. ASCII only.
param(
  [Parameter(Mandatory = $true)][string]$ExpectedCommit,
  [switch]$DryRun,
  [switch]$MigrationAlreadyApplied
)
$ErrorActionPreference = "Stop"
$BASE = "https://commonhold.randommonicle.workers.dev"
$PROD_DB = "commonhold"
# The attested constitution this wave must leave untouched (v6, minted 22 Oct).
$V6_HASH = "dc5f48213c29bcf844e0fbe7daf1bdb5416b3d57fbd06a8bd03f1061f34092b3"
# The commit the live worker serves when this runs (stale bulletin expiry, D-080).
$LIVE_BASE_COMMIT = "7b49b7b65b8477cdafb5057541a9432def1a5705"
$LIVE_BASE_PLACEHOLDER = "TO-BE-SET-BY-HUB-LIVE-BASE"
# THE REVIEWED SOURCE. The hub replaces this placeholder with the full sha the review converged on; step 1 STOPS while it is unchanged, and while it is not 40 lower-case hex.
$REVIEWED_COMMIT = "TO-BE-SET-BY-HUB"
$REVIEWED_COMMIT_PLACEHOLDER = "TO-BE-SET-BY-HUB"
$ALLOWED_PATHS_AFTER_REVIEW = @("scripts/deploy-decided-event-id.ps1", "test/deploy-decided-event-id-script.test.ts", "docs/")
$MIGRATION_PATH_EXPECTED = "migrations/0023_decided_event_id.sql"
$VERIFY_SQL_PATH = "scripts/verify-decided-event-id.sql"
$WINDOW_SECONDS = 3600
$WRANGLER_D1_SECONDS = 120
$WRANGLER_DEPLOY_SECONDS = 300
$POLL_TRIES = 12
$POLL_DELAY_SECONDS = 5
$POINTER_FIELD = "decided_event_id"
$NOTE_FIELD = "decided_event_id_note"
$PENDING_SQL = "SELECT COUNT(*) AS pending FROM proposals WHERE status IN ('open','tallying')"
$PAIRS_SQL = "SELECT id, decided_event_id FROM proposals WHERE id IN (1,2,5,6,7,8) ORDER BY id"
$COLUMN_SQL = "SELECT name, type FROM pragma_table_info('proposals') WHERE name = 'decided_event_id'"
# The six historical (proposal id, event id) pairs the backfill must produce.
$EXPECTED_PAIRS = @(@(1, 6), @(2, 12), @(5, 16), @(6, 20), @(7, 25), @(8, 37))

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
# The status code, content type and body of a GET (or, with $dataFile, a POST of that file's bytes). The content type is read from curl's own -w, never guessed.
function Get-Text($url, $maxTime, $dataFile) {
  $tmp = [System.IO.Path]::GetTempFileName()
  try {
    if ($dataFile) {
      $meta = (curl.exe -s --max-time $maxTime -o $tmp -w "%{http_code}|%{content_type}" -H "Content-Type: application/json" --data-binary "@$dataFile" $url)
    } else {
      $meta = (curl.exe -s --max-time $maxTime -o $tmp -w "%{http_code}|%{content_type}" $url)
    }
    $parts = ([string]$meta).Split("|", 2)
    $body = (Get-Content $tmp -Raw -ErrorAction SilentlyContinue)
    if ($null -eq $body) { $body = "" }
    $type = ""
    if ($parts.Count -gt 1) { $type = [string]$parts[1] }
    return @{ Code = [string]$parts[0]; Type = $type; Body = $body }
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
# ---- the D1 helpers (A5 step 4 and 6): strict reads, bounded commands ----
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
# "" when $res is a successfully parsed pending count of exactly 0, otherwise the reason it is not (absent, malformed or non-zero all fail closed).
function Test-PendingPreflight($res) {
  if ($null -eq $res) { return "the pending-proposals read returned no parsable result" }
  $list = @($res.Rows)
  if ($list.Count -ne 1) { return ("the pending-proposals read returned " + $list.Count + " rows, expected exactly 1") }
  $raw = $list[0].pending
  if ($null -eq $raw) { return "the pending-proposals row has no 'pending' value" }
  $n = 0
  if (-not [int]::TryParse([string]$raw, [ref]$n)) { return ("pending is '" + $raw + "', not an integer") }
  if ($n -ne 0) { return ("pending is " + $n + ": a proposal is open or tallying, so an old-worker tally could cross the migration. Wait until none is, then re-run.") }
  return ""
}
# "" when the preflight completed less than $WINDOW_SECONDS ago, otherwise the reason the sequence must stop.
function Test-WithinWindow($checkedAt, $now) {
  if ($null -eq $checkedAt) { return "the D1 preflight has not completed" }
  $age = ($now - $checkedAt).TotalSeconds
  if ($age -gt $WINDOW_SECONDS) { return ("the preflight completed " + [int]$age + " s ago, over the " + $WINDOW_SECONDS + " s window: stop for recovery and run a fresh preflight") }
  return ""
}
# "" when $rows are the six historical pairs (extra proposals are ignored by the SQL itself), otherwise the reason not.
function Test-HistoricalPairs($res) {
  if ($null -eq $res) { return "the historical-pairs read returned no parsable result" }
  $got = @($res.Rows)
  if ($got.Count -ne $EXPECTED_PAIRS.Count) { return ("the historical-pairs read returned " + $got.Count + " rows, expected " + $EXPECTED_PAIRS.Count) }
  for ($k = 0; $k -lt $EXPECTED_PAIRS.Count; $k++) {
    if ([string]$got[$k].id -cne [string]$EXPECTED_PAIRS[$k][0] -or [string]$got[$k].decided_event_id -cne [string]$EXPECTED_PAIRS[$k][1]) {
      return ("proposal " + $got[$k].id + " points at event '" + $got[$k].decided_event_id + "', expected proposal " + $EXPECTED_PAIRS[$k][0] + " -> " + $EXPECTED_PAIRS[$k][1])
    }
  }
  return ""
}
# "" when $rows is the successfully parsed ZERO-row result of the verification query, otherwise the reason (any row is a mismatch; an unparsable read is a failed read).
function Test-VerificationClean($res) {
  if ($null -eq $res) { return "the verification read returned no parsable result" }
  $list = @($res.Rows)
  if ($list.Count -gt 0) { return ("the verification returned " + $list.Count + " offending row(s), first: proposal " + $list[0].id + " status " + $list[0].status + " pointer '" + $list[0].decided_event_id + "'") }
  return ""
}
# "" when $rows shows the column present with type INTEGER.
function Test-ColumnPresent($res) {
  if ($null -eq $res) { return "the column read returned no parsable result" }
  $list = @($res.Rows)
  if ($list.Count -ne 1) { return ("proposals has " + $list.Count + " decided_event_id column rows, expected exactly 1") }
  if ([string]$list[0].type -cne "INTEGER") { return ("proposals.decided_event_id has type '" + $list[0].type + "', expected INTEGER") }
  return ""
}
# Runs one SQL file against the remote D1 (bounded) and returns the parsed rows, or STOPS. $json: read the rows back.
function Invoke-D1File($sqlPath, $label) {
  $r = Invoke-Bounded ("npx wrangler d1 execute " + $PROD_DB + " --remote --json --file " + $sqlPath) $WRANGLER_D1_SECONDS
  if ($r.TimedOut) { Stop-Here ("wrangler d1 execute timed out after " + $WRANGLER_D1_SECONDS + " s on " + $label + ". The state is unknown: read the catalogue by hand before any retry.") }
  if ($r.Code -ne 0) { Stop-Here ("wrangler d1 execute failed (exit " + $r.Code + ") on " + $label + ".") }
  return (Read-D1Rows $r.Out)
}
# Writes $sql to a temp .sql file and runs it as a read.
function Invoke-D1Read($sql, $label) {
  $stem = [System.IO.Path]::GetTempFileName()
  $f = $stem + ".sql"
  try {
    [System.IO.File]::WriteAllText($f, $sql + "`n")
    return (Invoke-D1File $f $label)
  } finally {
    Remove-Item $f -ErrorAction SilentlyContinue
    Remove-Item $stem -ErrorAction SilentlyContinue
  }
}
# The text between the BEGIN BACKFILL and END BACKFILL marker lines of the migration (the one idempotent UPDATE), or "" when the markers are absent.
function Get-BackfillSql($migrationText) {
  $m = [regex]::Match(([string]$migrationText).Replace("`r`n", "`n"), '(?s)-- BACKFILL BEGIN\n(.*?)-- BACKFILL END')
  if (-not $m.Success) { return "" }
  return $m.Groups[1].Value
}
function Assert-Window($label) {
  $why = Test-WithinWindow $script:PreflightAt (Get-Date)
  if ($why -ne "") { Stop-Here ("before " + $label + ": " + $why + ".") }
}
# Reads the catalogue and verification on prod and STOPS on any mismatch row (A5 step 6 and 8).
function Assert-Prod-Verified($when) {
  $why = Test-ColumnPresent (Invoke-D1Read $COLUMN_SQL "the column read")
  if ($why -ne "") { Stop-Here ("catalogue check " + $when + " failed: " + $why + ".") }
  $why = Test-VerificationClean (Invoke-D1File $VERIFY_SQL_PATH "the A2 verification")
  if ($why -ne "") { Stop-Here ("A2 verification " + $when + " failed: " + $why + ". Do not deploy or continue; read the rows by hand.") }
}
# ---- the served-answer checks (A5 step 9) ----
# "" when $list is a parsed proposals list whose every row carries the pointer key, carries the note, and the historical pairs match for those proposals present on the page.
function Test-ListServed($body) {
  if ($null -eq $body) { return "the list did not return JSON" }
  if (-not ([string]$body.$NOTE_FIELD).Contains("decided_event_id identifies the proposal_decided event")) { return "the list carries no decided_event_id_note" }
  $rows = @($body.proposals)
  if ($rows.Count -lt 1) { return "the list carries no proposals" }
  foreach ($row in $rows) {
    if ($null -eq $row.PSObject.Properties[$POINTER_FIELD]) { return ("proposal " + $row.id + " in the list has no decided_event_id key") }
  }
  foreach ($pair in $EXPECTED_PAIRS) {
    foreach ($row in $rows) {
      if ([string]$row.id -ceq [string]$pair[0] -and [string]$row.$POINTER_FIELD -cne [string]$pair[1]) { return ("proposal " + $row.id + " serves decided_event_id '" + $row.$POINTER_FIELD + "', expected " + $pair[1]) }
    }
  }
  return ""
}
# "" when $proposal is the detail of proposal 8 serving decided_event_id 37.
function Test-DetailServed($proposal) {
  if ($null -eq $proposal) { return "the detail carries no proposal object" }
  if ($null -eq $proposal.PSObject.Properties[$POINTER_FIELD]) { return "the detail has no decided_event_id key" }
  if ([string]$proposal.$POINTER_FIELD -cne "37") { return ("proposal 8 serves decided_event_id '" + $proposal.$POINTER_FIELD + "', expected 37") }
  return ""
}
# The tool result of a JSON-RPC tools/call answer as parsed JSON, or $null.
function Read-ToolResult($r) {
  if ([string]$r.Code -cne "200") { return $null }
  $j = Read-JsonBody $r
  if ($null -eq $j -or $null -eq $j.result -or $j.result.isError -eq $true) { return $null }
  try { return ([string]$j.result.content[0].text | ConvertFrom-Json) } catch { return $null }
}
# Posts a read-only tools/call (body from a temp file) and returns the parsed tool result, or $null.
function Invoke-Tool($door, $name, $argsJson) {
  $f = [System.IO.Path]::GetTempFileName()
  try {
    [System.IO.File]::WriteAllText($f, ('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"' + $name + '","arguments":' + $argsJson + '}}'))
    return (Read-ToolResult (Get-Text ($BASE + $door) 30 $f))
  } finally {
    Remove-Item $f -ErrorAction SilentlyContinue
  }
}
function Wait-NewWorker($commit, $versionId, $tries, $delaySeconds) {
  $last = "never read"
  for ($n = 1; $n -le $tries; $n++) {
    $why = Test-CodeIdentityServed (Get-ServedCode) $commit $versionId
    if ($why -eq "") { $why = Test-ListServed (Read-JsonBody (Get-Text "$BASE/api/proposals" 30 $null)) }
    if ($why -eq "") {
      Say "[poll] try $n of ${tries}: GET /api/attest serves code.commit $($commit.Substring(0, 8)) and code.version_id $versionId; GET /api/proposals serves decided_event_id"
      return
    }
    $last = $why
    Say "[poll] try $n of ${tries}: not yet: $why"
    if ($n -lt $tries) { Start-Sleep -Seconds $delaySeconds }
  }
  Stop-Here ("the new worker was never shown live in " + $tries + " reads (last: " + $last + "). The deploy is not shown to be live. " + $ROLLBACK_LINE)
}
# END-OF-DEFINITIONS (nothing above runs git, npm, wrangler or the network)

# 0a. the two pins, BEFORE any git, npm, wrangler or network command: a placeholder is never a commit, and a malformed pin must not reach `git merge-base`
# BEGIN-PIN-CHECK
if ($LIVE_BASE_COMMIT -ceq $LIVE_BASE_PLACEHOLDER) { Stop-Here "`$LIVE_BASE_COMMIT still holds the placeholder '$LIVE_BASE_PLACEHOLDER': the hub sets it to the commit the live worker serves." }
if ($LIVE_BASE_COMMIT -cnotmatch '^[0-9a-f]{40}$') { Stop-Here "`$LIVE_BASE_COMMIT '$LIVE_BASE_COMMIT' is not 40 lower-case hex. Nothing was read or written." }
if ($REVIEWED_COMMIT -ceq $REVIEWED_COMMIT_PLACEHOLDER) { Stop-Here "`$REVIEWED_COMMIT still holds the placeholder '$REVIEWED_COMMIT_PLACEHOLDER': the hub sets it to the commit the review converged on." }
if ($REVIEWED_COMMIT -cnotmatch '^[0-9a-f]{40}$') { Stop-Here "`$REVIEWED_COMMIT '$REVIEWED_COMMIT' is not 40 lower-case hex. Nothing was read or written." }
# END-PIN-CHECK

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
# Non-minting: src/doc.ts (which holds FRONT_DOOR_TEMPLATE) must not have moved since the live code.
$docMoves = @(git diff --name-status --no-renames $LIVE_BASE_COMMIT HEAD -- src/doc.ts)
if ($LASTEXITCODE -ne 0) { Stop-Here "git diff failed (exit $LASTEXITCODE): the no-mint check cannot be read." }
if ($docMoves.Count -gt 0) { Stop-Here ("src/doc.ts changed since " + $LIVE_BASE_COMMIT.Substring(0, 8) + " (" + ($docMoves -join " | ") + "): this wave mints nothing. Not this script's deploy.") }
# The ONLY migration since the live code is 0023, added (not edited).
$migMoves = @(git diff --name-status --no-renames $LIVE_BASE_COMMIT HEAD -- migrations)
if ($LASTEXITCODE -ne 0) { Stop-Here "git diff failed (exit $LASTEXITCODE): the migration check cannot be read." }
if ($migMoves.Count -ne 1 -or $migMoves[0] -cne ("A`t" + $MIGRATION_PATH_EXPECTED)) { Stop-Here ("expected exactly one added migration (" + $MIGRATION_PATH_EXPECTED + ") since " + $LIVE_BASE_COMMIT.Substring(0, 8) + ", found: " + ($migMoves -join " | ")) }
# BEGIN-REVIEWED-SOURCE-CHECK
git merge-base --is-ancestor $REVIEWED_COMMIT HEAD
if ($LASTEXITCODE -ne 0) { Stop-Here "HEAD does not contain the reviewed commit $($REVIEWED_COMMIT.Substring(0, 8)): this is not the code that was reviewed." }
$afterReview = @(git diff --name-only --no-renames $REVIEWED_COMMIT HEAD)
if ($LASTEXITCODE -ne 0) { Stop-Here "git diff failed (exit $LASTEXITCODE): the changes since the reviewed commit cannot be read." }
$unreviewed = @(Get-DisallowedPaths $afterReview)
if ($unreviewed.Count -gt 0) { Stop-Here ("these paths changed since the reviewed commit " + $REVIEWED_COMMIT.Substring(0, 8) + " and are not on the allowlist (" + ($ALLOWED_PATHS_AFTER_REVIEW -join ", ") + "), so what would ship is not what was reviewed: " + ($unreviewed -join ", ")) }
Say ("[git] reviewed source: HEAD differs from " + $REVIEWED_COMMIT.Substring(0, 8) + " in " + $afterReview.Count + " path(s), all on the allowlist")
# END-REVIEWED-SOURCE-CHECK
if (-not (Select-String -Path "src/governance.ts" -Pattern "decided_event_id = (SELECT id FROM identity_events WHERE hash = ?" -SimpleMatch -Quiet)) { Stop-Here "src/governance.ts does not bind the pointer inside the tally UPDATE: this checkout is not the decided-event-id wave." }
if (-not (Select-String -Path "src/governance.ts" -Pattern "export const DECIDED_EVENT_ID_NOTE" -SimpleMatch -Quiet)) { Stop-Here "src/governance.ts has no DECIDED_EVENT_ID_NOTE: this checkout would not serve the note." }
if (-not (Select-String -Path "src/governance.ts" -Pattern "export function assertProposalsQuery(" -SimpleMatch -Quiet)) { Stop-Here "src/governance.ts has no assertProposalsQuery: this checkout would drop the unknown-params wave." }
if (-not (Select-String -Path "src/code-identity.ts" -Pattern "export function codeBlock" -Quiet)) { Stop-Here "src/code-identity.ts has no codeBlock: this checkout would drop served code identity." }
if (-not (Select-String -Path "migrations/0023_decided_event_id.sql" -Pattern "-- BACKFILL BEGIN" -SimpleMatch -Quiet)) { Stop-Here "the migration carries no BACKFILL BEGIN marker: step 8 could not re-run the backfill." }
if (-not (Test-Path $VERIFY_SQL_PATH)) { Stop-Here "$VERIFY_SQL_PATH is missing: the A2 verification cannot run." }
if (-not (Select-String -Path "wrangler.jsonc" -Pattern '"version_metadata"' -Quiet)) { Stop-Here "wrangler.jsonc has no version_metadata binding: the Worker could not serve Cloudflare's version id." }
if (Select-String -Path "wrangler.jsonc" -Pattern '"CODE_COMMIT"' -Quiet) { Stop-Here "wrangler.jsonc configures a CODE_COMMIT var: a deploy that forgot the flag would serve a stale stamp. The stamp comes from this script's --var flag only." }
$backfillSql = Get-BackfillSql (Get-Content $MIGRATION_PATH_EXPECTED -Raw)
if ($backfillSql.Trim() -eq "" -or -not $backfillSql.Contains("UPDATE proposals SET decided_event_id")) { Stop-Here "the backfill block could not be read from the migration." }
Say ("[git] HEAD " + $headSha.Substring(0, 8) + " = main = origin/main = -ExpectedCommit; tree clean; contains " + $LIVE_BASE_COMMIT.Substring(0, 8) + "; src/doc.ts unmoved; the one new migration is " + $MIGRATION_PATH_EXPECTED)

# 2. the wave's own gates, re-run here so a stale checkout cannot deploy
# BEGIN-GATES
$ErrorActionPreference = "Continue"
$testOut = (npm test 2>&1 | Out-String)
$testCode = $LASTEXITCODE
$tscOut = (npm run typecheck 2>&1 | Out-String)
$tscCode = $LASTEXITCODE
$ErrorActionPreference = "Stop"
$failLine = [regex]::Matches($testOut, '(?m)^(?:\S+[ \t]+)?fail (\d+)[ \t]*\r?$')
$passLine = [regex]::Matches($testOut, '(?m)^(?:\S+[ \t]+)?pass (\d+)[ \t]*\r?$')
if ($failLine.Count -lt 1 -or $passLine.Count -lt 1) { Stop-Here "npm test: exit $testCode, the output carries no pass/fail summary: the run did not finish." }
$failN = $failLine[$failLine.Count - 1].Groups[1].Value
$passN = $passLine[$passLine.Count - 1].Groups[1].Value
if ($testCode -ne 0 -or $failN -ne "0" -or $passN -eq "0") { Stop-Here ("npm test: exit " + $testCode + ", pass '" + $passN + "', fail '" + $failN + "'.") }
if ($tscCode -ne 0) { Stop-Here "typecheck failed: $tscOut" }
Say ("[tests] pass " + $passN + ", fail 0; typecheck clean")
# END-GATES

# 3. live, before: non-minting baseline, the live worker is the pinned base, and the list does not yet serve the pointer
$attBefore = Read-Attest "before the deploy"
Assert-Attest $attBefore "before the deploy"
Say ("[live] before: v6 " + $V6_HASH.Substring(0, 8) + "; all four chains ok; identity " + $attBefore.identity_log.sealed_entries + ", treasury " + $attBefore.treasury.sealed_entries + ", ballots " + $attBefore.ballots.sealed_entries)
if ($null -eq $attBefore.code -or [string]$attBefore.code.commit_status -cne "stamped") { Stop-Here "GET /api/attest serves no stamped code.commit before the deploy: the live worker cannot be shown to be the base this wave was checked against." }
if ([string]$attBefore.code.commit -ceq $headSha) { Stop-Here "GET /api/attest already serves code.commit $($headSha.Substring(0, 8)): this commit looks already deployed. Verify by hand." }
if ([string]$attBefore.code.commit -cne $LIVE_BASE_COMMIT) { Stop-Here ("the live worker serves code.commit " + $attBefore.code.commit + " but `$LIVE_BASE_COMMIT is " + $LIVE_BASE_COMMIT + ": the base this wave was checked against is not what is live. Correct the pin only after reading what changed.") }
$rollbackTarget = "the version before it (check npx wrangler deployments list)"
if ([string]$attBefore.code.version_status -ceq "available" -and $attBefore.code.version_id) { $rollbackTarget = [string]$attBefore.code.version_id }
Say "[live] before: the live worker serves the pinned base $($LIVE_BASE_COMMIT.Substring(0, 8)); rollback target $rollbackTarget"
$listBefore = Read-JsonBody (Get-Text "$BASE/api/proposals" 30 $null)
if ($null -eq $listBefore) { Stop-Here "GET /api/proposals did not return JSON before the deploy: read it by hand." }
if ($null -ne $listBefore.PSObject.Properties[$NOTE_FIELD]) { Stop-Here "GET /api/proposals already carries decided_event_id_note: this looks already deployed, verify by hand." }
$identityBefore = [string]$attBefore.identity_log.sealed_entries
$treasuryBefore = [string]$attBefore.treasury.sealed_entries
$ballotsBefore = [string]$attBefore.ballots.sealed_entries

# 4. THE PREFLIGHT (A5 step 2), immediately before the migration: whole-table, production D1, fail closed. A READ, so -DryRun runs it too.
$pendingRows = Invoke-D1Read $PENDING_SQL "the pending-proposals preflight"
$why = Test-PendingPreflight $pendingRows
if ($why -ne "") { Stop-Here "preflight: $why" }
$script:PreflightAt = Get-Date
Say ("[preflight] production D1: pending = 0 at " + $script:PreflightAt.ToString("o") + "; migration, worker activation and reconciliation must finish within " + $WINDOW_SECONDS + " s of this")
$columnRes = Invoke-D1Read $COLUMN_SQL "the column state read"
if ($null -eq $columnRes) { Stop-Here "the column state read returned no parsable result." }
$columnPresent = (@($columnRes.Rows).Count -gt 0)
if ($columnPresent -and -not $MigrationAlreadyApplied) { Stop-Here "proposals.decided_event_id is already on prod. If an earlier run applied it, re-run with -MigrationAlreadyApplied (the catalogue and verification still run)." }
if (-not $columnPresent -and $MigrationAlreadyApplied) { Stop-Here "-MigrationAlreadyApplied was given but proposals.decided_event_id is not on prod." }
Say ("[d1] proposals.decided_event_id on prod before: " + $columnPresent)

if ($DryRun) {
  Say "[dry-run] would now: apply $MIGRATION_PATH_EXPECTED to the REMOTE D1 (skipped if -MigrationAlreadyApplied); verify the column, $VERIFY_SQL_PATH (zero rows) and the six historical pairs on prod; run npx wrangler deploy --var CODE_COMMIT:<the full sha> (bounded) and capture its Current Version ID; poll up to $POLL_TRIES times, $POLL_DELAY_SECONDS s apart; re-run the backfill and the verification; then ride HTTP and both MCP doors. Nothing was written to the remote and nothing was deployed."
  exit 0
}

# 5. migration 0023 to the REMOTE D1 FIRST (column plus idempotent backfill; applied only when the catalogue read above found the column absent)
# BEGIN-MIGRATION
Assert-Window "applying the migration"
if (-not $MigrationAlreadyApplied) {
  Say "[d1] applying $MIGRATION_PATH_EXPECTED to the remote database"
  $mig = Invoke-Bounded ("npx wrangler d1 execute " + $PROD_DB + " --remote --file " + $MIGRATION_PATH_EXPECTED) $WRANGLER_D1_SECONDS
  if ($mig.TimedOut) { Stop-Here "migration 0023 timed out after $WRANGLER_D1_SECONDS s; the state is unknown. Read the catalogue by hand; do NOT re-run the file blind (a duplicate ADD COLUMN fails)." }
  if ($mig.Code -ne 0) { Stop-Here "migration 0023 failed (exit $($mig.Code)); nothing deployed; re-read the catalogue before any retry (do NOT re-run the file blind: a duplicate ADD COLUMN fails)." }
}

# 6. catalogue and verification on prod (db-migration-verification): the worker deploys only if the column is there, the A2 query returns zero rows, and the six historical pairs hold
Assert-Window "the catalogue verification"
Assert-Prod-Verified "after the migration"
$why = Test-HistoricalPairs (Invoke-D1Read $PAIRS_SQL "the historical pairs read")
if ($why -ne "") { Stop-Here ("historical pairs after the migration: " + $why + ". Do not deploy.") }
Say "[d1] verified on prod: column present (INTEGER), A2 verification returns zero rows, pairs (1,6) (2,12) (5,16) (6,20) (7,25) (8,37) hold"
# END-MIGRATION

# 7. deploy the worker with the commit stamp, capturing its version id, then poll until the served identity is this deploy's
# BEGIN-DEPLOY-AND-POLL
Assert-Window "the worker deploy"
$headNow = (git rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $headNow -cne $headSha) { Stop-Here ("HEAD moved since step 1 (" + $headSha.Substring(0, 8) + " -> " + $headNow + "): the migration is applied, the worker was not deployed. Re-run with -MigrationAlreadyApplied once HEAD is right.") }
$dirtyNow = @(git status --porcelain)
if ($LASTEXITCODE -ne 0) { Stop-Here "git status failed (exit $LASTEXITCODE) just before the deploy: the worker was not deployed." }
if ($dirtyNow.Count -gt 0) { Stop-Here ("the working tree changed since step 1 (" + $dirtyNow.Count + " paths: " + ($dirtyNow -join " | ") + "): the worker was not deployed.") }
Say "[deploy] npx wrangler deploy --var CODE_COMMIT:$($headSha.Substring(0, 8))... (commit $($headSha.Substring(0, 8)))"
$dep = Invoke-Bounded ("npx wrangler deploy --var CODE_COMMIT:" + $headSha) $WRANGLER_DEPLOY_SECONDS
if ($dep.TimedOut) { Stop-Here "wrangler deploy timed out after $WRANGLER_DEPLOY_SECONDS s; whether it took effect is unknown. Check 'npx wrangler deployments list' by hand. Migration 0023 is applied and harmless to the old worker." }
if ($dep.Code -ne 0) { Stop-Here "wrangler deploy failed (exit $($dep.Code)); migration 0023 is applied and harmless to the old worker. Re-run with -MigrationAlreadyApplied. Output: $($dep.Out)" }
$versionMatches = @([regex]::Matches($dep.Out, '(?m)^[ \t]*Current Version ID:[ \t]*([0-9a-fA-F-]{36})[ \t]*\r?$'))
if ($versionMatches.Count -gt 1) { Stop-Here ("wrangler deploy printed 'Current Version ID' on " + $versionMatches.Count + " lines; which one is this deploy's cannot be told. Check 'npx wrangler deployments list' by hand before anything else.") }
if ($versionMatches.Count -lt 1) { Stop-Here "wrangler deploy exited 0 but printed no 'Current Version ID'; the deploy may have succeeded. Check 'npx wrangler deployments list' by hand before anything else." }
$versionId = $versionMatches[0].Groups[1].Value
Say "[deploy] worker version id $versionId (commit $($headSha.Substring(0, 8)))"
$ROLLBACK_LINE = "ROLL BACK THE WORKER (npx wrangler rollback, to the version before $versionId, which should be $rollbackTarget; check npx wrangler deployments list first). Migration 0023 stays applied (an extra nullable column the old worker never reads); after any tally made under the rolled-back worker, re-run the backfill block and scripts/verify-decided-event-id.sql (zero rows)."
Wait-NewWorker $headSha $versionId $POLL_TRIES $POLL_DELAY_SECONDS
# END-DEPLOY-AND-POLL

# 8. reconciliation AFTER activation (A5 step 6): the idempotent backfill again, then the verification again
# BEGIN-RECONCILE
Assert-Window "the post-activation reconciliation"
$bfStem = [System.IO.Path]::GetTempFileName()
$bf = $bfStem + ".sql"
try {
  [System.IO.File]::WriteAllText($bf, $backfillSql)
  $rec = Invoke-Bounded ("npx wrangler d1 execute " + $PROD_DB + " --remote --file " + $bf) $WRANGLER_D1_SECONDS
} finally {
  Remove-Item $bf -ErrorAction SilentlyContinue
  Remove-Item $bfStem -ErrorAction SilentlyContinue
}
if ($rec.TimedOut) { Stop-Here "the post-activation backfill timed out after $WRANGLER_D1_SECONDS s; read the verification by hand. $ROLLBACK_LINE" }
if ($rec.Code -ne 0) { Stop-Here "the post-activation backfill failed (exit $($rec.Code)). $ROLLBACK_LINE" }
Assert-Prod-Verified "after worker activation"
Say "[d1] post-activation: backfill re-run, A2 verification returns zero rows"
# END-RECONCILE

# 9. the ride: non-minting and the chains, then HTTP list and detail and both MCP doors.
$attAfter = Read-Attest "after the deploy"
Assert-Attest $attAfter "after the deploy"
$why = Test-CodeIdentityServed $attAfter.code $headSha $versionId
if ($why -ne "") { Stop-Here "after the poll, ${why}: another deploy may have taken over. Check npx wrangler deployments list by hand." }
if ([string]$attAfter.identity_log.sealed_entries -cne $identityBefore -or [string]$attAfter.treasury.sealed_entries -cne $treasuryBefore -or [string]$attAfter.ballots.sealed_entries -cne $ballotsBefore) {
  Stop-Here ("a chain length moved during the deploy (identity " + $identityBefore + " -> " + $attAfter.identity_log.sealed_entries + ", treasury " + $treasuryBefore + " -> " + $attAfter.treasury.sealed_entries + ", ballots " + $ballotsBefore + " -> " + $attAfter.ballots.sealed_entries + "): something wrote. Read what, by hand.")
}
Say ("[ride] attest: v6 " + $V6_HASH.Substring(0, 8) + " unchanged; every chain ok and unchanged in length; code.commit " + ([string]$attAfter.code.commit).Substring(0, 8) + ", code.version_id " + $attAfter.code.version_id)
$why = Test-ListServed (Read-JsonBody (Get-Text "$BASE/api/proposals" 30 $null))
if ($why -ne "") { Stop-Here "GET /api/proposals: $why. $ROLLBACK_LINE" }
Say "[ride] GET /api/proposals -> the note, a decided_event_id key on every row, the six pairs"
$detail = Read-JsonBody (Get-Text "$BASE/api/proposal/8" 30 $null)
if ($null -eq $detail) { Stop-Here "GET /api/proposal/8 did not return JSON. $ROLLBACK_LINE" }
$why = Test-DetailServed $detail.proposal
if ($why -ne "") { Stop-Here "GET /api/proposal/8: $why. $ROLLBACK_LINE" }
Say "[ride] GET /api/proposal/8 -> decided_event_id 37"
foreach ($door in "/mcp", "/mcp/read") {
  $toolList = Invoke-Tool $door "proposals" "{}"
  $why = Test-ListServed $toolList
  if ($why -ne "") { Stop-Here "$door proposals tool: $why. $ROLLBACK_LINE" }
  $toolDetail = Invoke-Tool $door "proposal" '{"proposal_id":8}'
  if ($null -eq $toolDetail) { Stop-Here "$door proposal tool returned no parsable result. $ROLLBACK_LINE" }
  $why = Test-DetailServed $toolDetail.proposal
  if ($why -ne "") { Stop-Here "$door proposal tool: $why. $ROLLBACK_LINE" }
  Say "[ride] $door proposals and proposal tools -> the pointer served"
}
$bad = @()
foreach ($p in "/", "/api/official", "/openapi.json", "/treasury", "/api/listings", "/api/stats", "/api/topics", "/api/guest/due", "/api/citizens", "/api/doors", "/api/council", "/api/residents", "/heartbeat.md", "/skill.md", "/llms.txt", "/privacy") {
  $r = Get-Text "$BASE$p" 30 $null
  if ($r.Code -ne "200") { $bad += "$p=$($r.Code)" }
}
if ($bad.Count -gt 0) { Stop-Here ("non-200 after the deploy (version $versionId): " + ($bad -join ", ") + ". If a read that answered before now fails: $ROLLBACK_LINE") }
Say "[ride] 16 public reads -> 200"
Say "[done] decided-event-id wave deployed, reconciled and ridden. Log version id $versionId, commit $($headSha.Substring(0, 8)) and these lines in HANDOVER.md."
