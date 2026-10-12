# Deploys the COUNCIL (D-075 order step c; build log docs/CHECKPOINT-COUNCIL.md): migration 0021 (five new tables, no foreign key) to the REMOTE D1 FIRST, then ONE worker deploy that carries
# GET /api/council, GET and POST /api/council/thread, POST /api/council/challenge, /claim, /motion, /ballot and /motion/:id/flag, the council read tool on /mcp and /mcp/read, the six
# council write tools on /mcp only, the council block on /api/official and /skill.md 1.4.0. Ben's hand only (D-017). One fail-fast script (L-046, L-069).
# WRITTEN BY THE BUILDER AND NEVER RUN: not even -DryRun, which reads the remote D1 through wrangler (reads only, no write). The Sonnet gate, the merge and the push come before it, and
# the resident tier (D-075 order step b, scripts/deploy-residents.ps1) must already be LIVE: this wave is built on top of it and needs its guests.public_key column and resident_nonces table.
# TWO PINS. $LIVE_BASE_COMMIT is the commit the live worker serves when this runs (the resident tier's deployed commit) and is set; $REVIEWED_COMMIT is the commit the review converged
# on and holds the hub's placeholder until the hub sets it. Step 0a STOPS, before any git or remote command, while EITHER still holds its placeholder or is not 40 lower-case hex.
# $LIVE_BASE_COMMIT is also proved against the live worker: step 2 STOPS unless GET /api/attest serves code.commit equal to it, so a hub typo cannot pass.
# NO MINT: this wave edits src/doc.ts NOT AT ALL (the council text rides guest-core.ts, discovery.ts and inbox.ts), so the check is the template text itself: step 0 extracts
# FRONT_DOOR_TEMPLATE from src/doc.ts at $LIVE_BASE_COMMIT and at HEAD and STOPS if they differ by a byte. After the deploy it STOPS if the constitution is not still v5 with its template hash.
# Order is load-bearing: the new worker reads the council tables on GET /api/council and on /api/official (every read of the official facts). A worker deployed before the tables exist would
# 500 on /api/official. Migration 0021 therefore goes to the REMOTE D1 first, is catalogue-verified (the five tables, their columns in order, their keys including the
# UNIQUE(platform, external_account_id) that seats one resident per outside account, their indexes, and no foreign key on any of them), and only then does the worker deploy. Migration 0021
# is additive and harmless to the OLD worker, which never names the new tables, so every stop before "wrangler deploy" leaves the live worker as it was. 0021 is written IF NOT EXISTS, but
# the script still reads the catalogue FIRST and applies the file only when the tables are absent, so it never re-runs a file against a table of unknown shape.
# THE DEPLOY STAMPS THE COMMIT: `npx wrangler deploy --var CODE_COMMIT:<sha>` (served code identity). The poll after the deploy waits until GET /api/attest serves code.commit equal to the
# pinned sha AND code.version_id equal to the Current Version ID wrangler printed. The ROLLBACK TARGET is the version id GET /api/attest served BEFORE the deploy (read live, never typed in).
# REVIEWED SOURCE ONLY: step 0 also STOPS unless HEAD is $REVIEWED_COMMIT plus changes confined to $ALLOWED_PATHS_AFTER_REVIEW (this script, its test, docs/).
# Run from society/ on main, after the merge and the push:
#   cd "C:\Users\bengr\Projects\AI domain and social network\society"
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-council.ps1 -ExpectedCommit <sha> -DryRun   # every check and the remote READS, nothing written, nothing deployed
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-council.ps1 -ExpectedCommit <sha>           # the real thing
#   ... -MigrationAlreadyApplied   only to re-run after a failed or interrupted wrangler deploy, when 0021 is already on prod
# <sha> is the pushed tip of main (git -C society rev-parse HEAD), the full 40 hex.
# THE RIDE MAKES NO LIVE WRITE EXCEPT THE DOOR COUNTS ITS OWN GETS ADD: each 200 on GET /skill.md or GET /heartbeat.md adds one request to that day's door_counts row (src/doors.ts), so the ride
# fetches /skill.md ONCE and /heartbeat.md once, and says so in its log. Nothing else is written: a claim needs a resident's token, a ballot a signed assertion, a council message a seat,
# and a script that holds any of those is a script that writes an identity. The ride is public GETs, POST /mcp tools/list and POST /mcp/read tools/list (both read-only). The first
# challenge, claim, message, motion, ballot and flag are first ridden by real members; until then they are proved by tests only.
# PowerShell 5.1 traps this file avoids (all seen live): $COLS and $cols are the SAME variable (one spelling per name here); -notmatch on an array filters instead of testing;
# a one-element return is wrapped in @(); "$var:" is a drive reference (write "${var}:"); an Invoke-WebRequest 4xx body is in $_.ErrorDetails.Message; never merge a native command's stderr
# under ErrorActionPreference Stop; -eq and -ne are case-INSENSITIVE (hashes, shas and states are compared with -ceq / -cne). ASCII only: 5.1 reads a BOM-less UTF-8 script as the ANSI code page.
param(
  [Parameter(Mandatory = $true)][string]$ExpectedCommit,
  [switch]$DryRun,
  [switch]$MigrationAlreadyApplied
)
$ErrorActionPreference = "Stop"
$BASE = "https://commonhold.randommonicle.workers.dev"
# The attested constitution this wave must leave untouched.
$V5_HASH = "fa11788d062b0c6d23c54c428c1c9649d263ae3ba704e602e122066926049491"
# The commit the live worker serves when this runs (the resident tier, once deployed). Step 0 STOPS while it holds the placeholder, and while it is not 40 lower-case hex.
$LIVE_BASE_COMMIT = "3ac2928976e2a3627207ed4c1d1b834ac5a5968a"
$LIVE_BASE_PLACEHOLDER = "TO-BE-SET-BY-HUB-LIVE-BASE"
# THE REVIEWED SOURCE. The hub replaces this placeholder with the full sha the review converged on; step 0 STOPS while it is unchanged, and while it is not 40 lower-case hex.
$REVIEWED_COMMIT = "41409b9f7e73522d187aa6ba0db7e7a998558404"
$REVIEWED_COMMIT_PLACEHOLDER = "TO-BE-SET-BY-HUB"
$ALLOWED_PATHS_AFTER_REVIEW = @("scripts/deploy-council.ps1", "test/deploy-council-script.test.ts", "docs/")
$MIGRATION_GLOB = "migrations/0021_*.sql"
$MIGRATION_PATH_EXPECTED = "migrations/0021_council.sql"
# From migrations/0021_council.sql. The test compares these lists with the migration and with schema.sql. Each table: its columns in order, its primary key, and the indexes it must carry.
$COUNCIL_TABLES = @("council_challenges", "council_claims", "council_thread", "council_motions", "council_ballots")
$CHALLENGES_COLUMNS = @("nonce", "visitor_id", "issued_at", "expires_at", "used_at")
$CHALLENGES_KEY = @("nonce")
$CLAIMS_COLUMNS = @("id", "visitor_id", "platform", "external_account_id", "external_handle", "record_id", "record_created_at", "record_body", "account_created_at", "account_karma", "retrieved_at", "record_sha256", "account_sha256", "created_at")
$CLAIMS_KEY = @("id")
$THREAD_COLUMNS = @("id", "parent_id", "author_kind", "author_id", "handle", "body", "created_at")
$THREAD_KEY = @("id")
$MOTIONS_COLUMNS = @("id", "kind", "title", "body", "proposer_kind", "proposer_id", "opened_at", "closes_at", "eligible_json", "operator_flagged_at", "operator_flagged_by_kind", "operator_flagged_by_id", "created_at")
$MOTIONS_KEY = @("id")
$BALLOTS_COLUMNS = @("motion_id", "member_kind", "member_id", "choice", "created_at")
$BALLOTS_KEY = @("motion_id", "member_kind", "member_id")
# The two UNIQUE keys on council_claims (K7.5): one seat per resident, and one outside account seats at most one resident, ever. Each is a list of columns in index order.
$CLAIMS_UNIQUE_KEYS = @("visitor_id", "platform,external_account_id")
$COUNCIL_INDEXES = @("idx_council_challenges_visitor:council_challenges", "idx_council_thread_author:council_thread", "idx_council_thread_parent:council_thread", "idx_council_motions_proposer:council_motions")
# The propagation poll waits for THIS route to answer 200 (a route only this wave serves); the pre-deploy probe proves it answers 404 first.
$NEW_CODE_URL = "$BASE/api/council"
$SKILL_VERSION_LINE = "version: 1.4.0"
$POLL_TRIES = 12
$POLL_DELAY_SECONDS = 5
# The members the ride expects the rule to seat today (the operator's one seat, and the self-paid citizen) and the rule that seats each.
$RIDE_MEMBERS = @("ledger-watch:operator_seat", "sisyphus:self_paid")
$COUNCIL_WRITE_TOOLS = @("council_challenge", "council_claim", "council_write", "council_motion", "council_ballot", "council_flag")
# node's test summary is the LAST thing npm test prints on a run that finishes cleanly: eight consecutive lines, "tests N", "suites N", "pass N", "fail N", "cancelled N", "skipped N", "todo N" and
# "duration_ms N.N", each after at most one prefix token, with nothing after the last but whitespace. The pattern is ANCHORED AT THE END (\z), so test TITLES are never it. The script also requires
# tests == pass + fail + cancelled + skipped + todo.
$TEST_SUMMARY_PATTERN = '(?m)^(?:\S+[ \t]+)?tests (\d+)[ \t]*\r?\n(?:\S+[ \t]+)?suites (\d+)[ \t]*\r?\n(?:\S+[ \t]+)?pass (\d+)[ \t]*\r?\n(?:\S+[ \t]+)?fail (\d+)[ \t]*\r?\n(?:\S+[ \t]+)?cancelled (\d+)[ \t]*\r?\n(?:\S+[ \t]+)?skipped (\d+)[ \t]*\r?\n(?:\S+[ \t]+)?todo (\d+)[ \t]*\r?\n(?:\S+[ \t]+)?duration_ms (\d+(?:\.\d+)?)\s*\z'

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
function Read-D1Json($lines) {
  $txt = ($lines | Out-String)
  $i = $txt.IndexOf("[")
  if ($i -lt 0) { Stop-Here "wrangler d1 returned no JSON: $txt" }
  return ($txt.Substring($i) | ConvertFrom-Json)
}
# Strict READ of the remote D1: a failed or empty query STOPS; nothing reasons from a bad read (an empty result must never read as "absent").
function Invoke-D1Read($sql) {
  # stdout only, no stderr redirect (the proven pattern of scripts/deploy-wallet-pin.ps1): merging stderr would wrap any wrangler notice in an error record. The exit code is read after.
  $raw = (npx wrangler d1 execute commonhold --remote --json --command $sql)
  $code = $LASTEXITCODE
  if ($code -ne 0) { Stop-Here "wrangler d1 execute failed (exit $code) for: $sql" }
  $parsed = Read-D1Json $raw
  if ($null -eq $parsed -or @($parsed).Count -lt 1 -or $null -eq $parsed[0].results) { Stop-Here "wrangler d1 returned no results object for: $sql" }
  return @($parsed[0].results)
}
function Get-Text($url, $maxTime) {
  $tmp = [System.IO.Path]::GetTempFileName()
  try {
    $code = (curl.exe -s --max-time $maxTime -o $tmp -w "%{http_code}" $url)
    $body = (Get-Content $tmp -Raw -ErrorAction SilentlyContinue)
    if ($null -eq $body) { $body = "" }
    return @{ Code = "$code"; Body = $body }
  } finally {
    Remove-Item $tmp -ErrorAction SilentlyContinue
  }
}
function Get-Json($url) {
  $r = Get-Text $url 20
  if ($r.Code -ne "200") { Stop-Here "GET $url -> $($r.Code), expected 200." }
  try { return ($r.Body | ConvertFrom-Json) } catch { Stop-Here "GET $url did not return JSON." }
}
# A JSON-RPC POST to the live worker with the body in a temp file (no quoting seam), returning @{ Code; Body }. Used for READ-ONLY calls only (tools/list); this script makes no live write.
function Post-Json($url, $json) {
  $in = [System.IO.Path]::GetTempFileName()
  $out = [System.IO.Path]::GetTempFileName()
  try {
    [System.IO.File]::WriteAllText($in, $json, (New-Object System.Text.UTF8Encoding($false)))
    $code = (curl.exe -s --max-time 30 -o $out -w "%{http_code}" -X POST $url -H "content-type: application/json" --data-binary "@$in")
    $body = (Get-Content $out -Raw -ErrorAction SilentlyContinue)
    if ($null -eq $body) { $body = "" }
    return @{ Code = "$code"; Body = $body }
  } finally {
    Remove-Item $in, $out -ErrorAction SilentlyContinue
  }
}
function Read-Attest($when) {
  $att = Get-Json "$BASE/api/attest"
  if ($null -eq $att -or $null -eq $att.constitution -or -not $att.constitution.template_hash) { Stop-Here "GET /api/attest was unreadable $when; re-read it by hand (this is NOT a minting signal)." }
  return $att
}
function Assert-Attest($att, $when) {
  if ([string]$att.constitution.version -ne "5") { Stop-Here "constitution is version $($att.constitution.version) $when, expected 5: investigate before anything else." }
  if ($att.constitution.template_hash -cne $V5_HASH) { Stop-Here "template_hash is $($att.constitution.template_hash) $when, expected v5 ${V5_HASH}: investigate before anything else (this wave mints nothing)." }
  if ($att.ok -ne $true) { Stop-Here "GET /api/attest ok is '$($att.ok)' $when, expected true." }
  foreach ($chain in "identity_log", "treasury", "payouts", "ballots") {
    if ($att.$chain.ok -ne $true) { Stop-Here "chain $chain ok is '$($att.$chain.ok)' $when, expected true: investigate." }
  }
}
# The `code` block GET /api/attest serves now, or $null when the read fails, is not JSON, or carries no code block. Never stops: the poll decides.
function Get-ServedCode {
  $r = Get-Text "$BASE/api/attest" 30
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
# Polls until the served block is this deploy's AND the new route answers 200, or STOPS (with $ROLLBACK_LINE) after $tries reads.
function Wait-NewWorker($commit, $versionId, $tries, $delaySeconds) {
  $last = "never read"
  for ($n = 1; $n -le $tries; $n++) {
    $why = Test-CodeIdentityServed (Get-ServedCode) $commit $versionId
    if ($why -eq "") {
      $route = Get-Text $NEW_CODE_URL 30
      if ($route.Code -eq "200") {
        Say "[poll] try $n of ${tries}: GET /api/attest serves code.commit $($commit.Substring(0, 8)) and code.version_id $versionId; GET /api/council answers 200"
        return
      }
      $why = "GET /api/council answered $($route.Code), expected 200"
    }
    $last = $why
    Say "[poll] try $n of ${tries}: not yet: $why"
    if ($n -lt $tries) { Start-Sleep -Seconds $delaySeconds }
  }
  Stop-Here ("the new worker was never shown live in " + $tries + " reads (last: " + $last + "). The deploy is not shown to be live. " + $ROLLBACK_LINE)
}
# The catalogue of what migration 0021 leaves on the remote D1. Every mismatch STOPS (the worker must not deploy against it).
# One table's columns, in order, as read from pragma_table_info; returns the rows so the caller can read the primary key from the same read.
function Get-TableColumnsInOrder($table, $expected) {
  $info = @(Invoke-D1Read "SELECT cid, name, type, pk FROM pragma_table_info('$table') ORDER BY cid")
  $got = @($info | ForEach-Object { $_.name })
  if ($got.Count -ne $expected.Count) { Stop-Here ("$table has " + $got.Count + " columns, expected " + $expected.Count + ": " + ($got -join ", ")) }
  for ($k = 0; $k -lt $expected.Count; $k++) {
    if ($got[$k] -cne $expected[$k]) { Stop-Here ("$table column " + $k + " is '" + $got[$k] + "', expected '" + $expected[$k] + "'") }
  }
  return $info
}
function Assert-PrimaryKey($table, $info, $expectedKey) {
  $key = @($info | Where-Object { [int]$_.pk -gt 0 } | Sort-Object { [int]$_.pk } | ForEach-Object { $_.name })
  if (($key -join ",") -cne ($expectedKey -join ",")) { Stop-Here ("$table primary key is (" + ($key -join ", ") + "), expected (" + ($expectedKey -join ", ") + ")") }
}
function Assert-CouncilSchema {
  # No double quote inside any SQL handed to wrangler: PowerShell 5.1 does not escape an embedded one when it passes a native argument, so the argument would split. Hence SELECT *, and the column read by its own name.
  $challenges = @(Get-TableColumnsInOrder "council_challenges" $CHALLENGES_COLUMNS)
  Assert-PrimaryKey "council_challenges" $challenges $CHALLENGES_KEY
  $claims = @(Get-TableColumnsInOrder "council_claims" $CLAIMS_COLUMNS)
  Assert-PrimaryKey "council_claims" $claims $CLAIMS_KEY
  $thread = @(Get-TableColumnsInOrder "council_thread" $THREAD_COLUMNS)
  Assert-PrimaryKey "council_thread" $thread $THREAD_KEY
  $motions = @(Get-TableColumnsInOrder "council_motions" $MOTIONS_COLUMNS)
  Assert-PrimaryKey "council_motions" $motions $MOTIONS_KEY
  $ballots = @(Get-TableColumnsInOrder "council_ballots" $BALLOTS_COLUMNS)
  Assert-PrimaryKey "council_ballots" $ballots $BALLOTS_KEY
  # The two UNIQUE keys on council_claims: one seat per resident, and one outside account seats at most one resident, ever. Read from the index list, never assumed from the CREATE text.
  $indexRows = @(Invoke-D1Read "SELECT * FROM pragma_index_list('council_claims')")
  $uniqueKeys = @()
  foreach ($row in $indexRows) {
    if ("$($row.unique)" -ceq "1") {
      $indexColumns = @(Invoke-D1Read ("SELECT name FROM pragma_index_info('" + $row.name + "') ORDER BY seqno") | ForEach-Object { $_.name })
      $uniqueKeys += ($indexColumns -join ",")
    }
  }
  foreach ($want in $CLAIMS_UNIQUE_KEYS) {
    if ($uniqueKeys -cnotcontains $want) { Stop-Here ("council_claims has no UNIQUE key on (" + $want + "); its unique keys are: " + ($uniqueKeys -join " | ")) }
  }
  if ($uniqueKeys.Count -ne $CLAIMS_UNIQUE_KEYS.Count) { Stop-Here ("council_claims has " + $uniqueKeys.Count + " UNIQUE keys, expected " + $CLAIMS_UNIQUE_KEYS.Count + ": " + ($uniqueKeys -join " | ")) }
  $claimsSql = @(Invoke-D1Read "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'council_claims'")
  if ($claimsSql.Count -ne 1 -or -not ([string]$claimsSql[0].sql).Contains("length(record_body) <= 2000")) { Stop-Here "council_claims does not CHECK the stored record body to 2000 characters." }
  foreach ($entry in $COUNCIL_INDEXES) {
    $parts = $entry.Split(":")
    $found = @(Invoke-D1Read ("SELECT name FROM sqlite_master WHERE type = 'index' AND name = '" + $parts[0] + "' AND tbl_name = '" + $parts[1] + "'"))
    if ($found.Count -ne 1) { Stop-Here ("the index " + $parts[0] + " on " + $parts[1] + " is missing.") }
  }
  foreach ($table in $COUNCIL_TABLES) {
    $fkRows = @(Invoke-D1Read "SELECT COUNT(*) AS n FROM pragma_foreign_key_list('$table')")
    if ($fkRows.Count -ne 1 -or "$($fkRows[0].n)" -cne "0") { Stop-Here "$table carries a foreign key, or the foreign key list could not be read." }
  }
}
# END-OF-DEFINITIONS (test/deploy-council-script.test.ts reads everything above this line as definitions; nothing above runs git, npm, wrangler or the network)

# 0a. the two pins, BEFORE any git, npm, wrangler or network command: a placeholder is never a commit, and a malformed pin must not reach `git merge-base`
# BEGIN-PIN-CHECK
if ($LIVE_BASE_COMMIT -ceq $LIVE_BASE_PLACEHOLDER) { Stop-Here "`$LIVE_BASE_COMMIT still holds the placeholder '$LIVE_BASE_PLACEHOLDER': the hub sets it to the commit the live worker serves (the MCP guest door deploy), and until then there is no base to check this wave against. Nothing was read or written." }
if ($LIVE_BASE_COMMIT -cnotmatch '^[0-9a-f]{40}$') { Stop-Here "`$LIVE_BASE_COMMIT '$LIVE_BASE_COMMIT' is not 40 lower-case hex. Nothing was read or written." }
if ($REVIEWED_COMMIT -ceq $REVIEWED_COMMIT_PLACEHOLDER) { Stop-Here "`$REVIEWED_COMMIT still holds the placeholder '$REVIEWED_COMMIT_PLACEHOLDER': the hub sets it to the commit the review converged on, and until then there is no reviewed source to deploy. Nothing was read or written." }
if ($REVIEWED_COMMIT -cnotmatch '^[0-9a-f]{40}$') { Stop-Here "`$REVIEWED_COMMIT '$REVIEWED_COMMIT' is not 40 lower-case hex. Nothing was read or written." }
# END-PIN-CHECK

# 0. the commit: fetch, then main, origin/main and the expected sha must be ONE commit, on a clean tree
# A fetch changes only remote-tracking refs, never the remote, so -DryRun performs it too: the level check must read a fresh origin/main.
Say "[git] git fetch origin"
git fetch origin --quiet
if ($LASTEXITCODE -ne 0) { Stop-Here "git fetch failed; the level check below would read a stale origin/main." }
$branch = (git rev-parse --abbrev-ref HEAD).Trim()
if ($branch -cne "main") { Stop-Here "the current branch is '$branch', not main: deploy from main only." }
$headSha = (git rev-parse HEAD).Trim()
$originSha = (git rev-parse origin/main).Trim()
$mainSha = (git rev-parse main).Trim()
# No stderr redirection on a native command under ErrorActionPreference Stop: Continue around it, read the exit code.
$ErrorActionPreference = "Continue"
$expectedSha = (git rev-parse --verify ($ExpectedCommit + "^{commit}"))
$expectedCode = $LASTEXITCODE
$ErrorActionPreference = "Stop"
if ($expectedCode -ne 0 -or -not $expectedSha) { Stop-Here "-ExpectedCommit '$ExpectedCommit' is not a commit in this repository." }
$expectedSha = ([string]$expectedSha).Trim()
if ($mainSha -cne $originSha -or $mainSha -cne $expectedSha -or $headSha -cne $expectedSha) {
  Stop-Here ("main, origin/main and -ExpectedCommit are not one commit: HEAD " + $headSha.Substring(0, 8) + ", main " + $mainSha.Substring(0, 8) + ", origin/main " + $originSha.Substring(0, 8) + ", expected " + $expectedSha.Substring(0, 8) + ". Merge, push, and pass the pushed sha.")
}
# The stamp is this sha, in full, lower-case: the code serves a commit only if it matches ^[0-9a-f]{40}$ (src/code-identity.ts), so anything else would deploy as "malformed_stamp".
if ($headSha -cnotmatch '^[0-9a-f]{40}$') { Stop-Here "HEAD '$headSha' is not 40 lower-case hex: it could not be stamped (the Worker would serve malformed_stamp)." }
# Every git read below checks its own exit code before its output is read: a failed native command prints nothing, and nothing must not read as "clean" or "no change".
$dirty = @(git status --porcelain)
if ($LASTEXITCODE -ne 0) { Stop-Here "git status failed (exit $LASTEXITCODE): the clean-tree check cannot be read." }
if ($dirty.Count -gt 0) { Stop-Here ("working tree not clean (" + $dirty.Count + " paths): the deploy must ship exactly the committed tree.") }
git merge-base --is-ancestor $LIVE_BASE_COMMIT HEAD
if ($LASTEXITCODE -ne 0) { Stop-Here "HEAD does not contain $($LIVE_BASE_COMMIT.Substring(0, 8)) (the live worker's code): this deploy would drop the waves before it." }
# Non-minting: the attested template lives in FRONT_DOOR_TEMPLATE in src/doc.ts. This wave edits src/doc.ts OUTSIDE it, so the proof is that the template text itself is byte-identical at both commits.
$liveDoc = (@(git show ($LIVE_BASE_COMMIT + ":src/doc.ts")) -join "`n")
if ($LASTEXITCODE -ne 0) { Stop-Here "git show $($LIVE_BASE_COMMIT.Substring(0, 8)):src/doc.ts failed (exit $LASTEXITCODE): the no-mint check cannot be read." }
$headDoc = (@(git show ($headSha + ":src/doc.ts")) -join "`n")
if ($LASTEXITCODE -ne 0) { Stop-Here "git show $($headSha.Substring(0, 8)):src/doc.ts failed (exit $LASTEXITCODE): the no-mint check cannot be read." }
$liveTemplate = Get-TemplateText $liveDoc
$headTemplate = Get-TemplateText $headDoc
if ($null -eq $liveTemplate -or $null -eq $headTemplate) { Stop-Here "FRONT_DOOR_TEMPLATE could not be found in src/doc.ts at one of the two commits: the no-mint check cannot be read." }
if ($liveTemplate -cne $headTemplate) { Stop-Here "FRONT_DOOR_TEMPLATE differs between $($LIVE_BASE_COMMIT.Substring(0, 8)) and HEAD: this wave mints nothing and was to leave the attested template alone. Not this script's deploy." }
# The only migration since the live code is 0021, added (not edited): five new tables and their indexes.
$migMoves = @(git diff --name-status --no-renames $LIVE_BASE_COMMIT HEAD -- migrations)
if ($LASTEXITCODE -ne 0) { Stop-Here "git diff failed (exit $LASTEXITCODE): the migration check cannot be read." }
if ($migMoves.Count -ne 1 -or $migMoves[0] -cne ("A`t" + $MIGRATION_PATH_EXPECTED)) { Stop-Here ("expected exactly one added migration ($MIGRATION_PATH_EXPECTED) since " + $LIVE_BASE_COMMIT.Substring(0, 8) + ", found: " + ($migMoves -join " | ")) }
# BEGIN-REVIEWED-SOURCE-CHECK
# (a) HEAD is the reviewed commit plus only the allowlisted paths (no rename detection: a rename out of src/ into docs/ must list BOTH paths)
git merge-base --is-ancestor $REVIEWED_COMMIT HEAD
if ($LASTEXITCODE -ne 0) { Stop-Here "HEAD does not contain the reviewed commit $($REVIEWED_COMMIT.Substring(0, 8)): this is not the code that was reviewed." }
$afterReview = @(git diff --name-only --no-renames $REVIEWED_COMMIT HEAD)
if ($LASTEXITCODE -ne 0) { Stop-Here "git diff failed (exit $LASTEXITCODE): the changes since the reviewed commit cannot be read." }
$unreviewed = @(Get-DisallowedPaths $afterReview)
if ($unreviewed.Count -gt 0) { Stop-Here ("these paths changed since the reviewed commit " + $REVIEWED_COMMIT.Substring(0, 8) + " and are not on the allowlist (" + ($ALLOWED_PATHS_AFTER_REVIEW -join ", ") + "), so what would ship was not reviewed: " + ($unreviewed -join ", ")) }
Say ("[git] reviewed source: HEAD differs from " + $REVIEWED_COMMIT.Substring(0, 8) + " in " + $afterReview.Count + " path(s), all on the allowlist")
# END-REVIEWED-SOURCE-CHECK
$migrationFiles = @(Get-ChildItem -Path $MIGRATION_GLOB -ErrorAction SilentlyContinue)
if ($migrationFiles.Count -ne 1) { Stop-Here "expected exactly one $MIGRATION_GLOB in this checkout, found $($migrationFiles.Count): wrong branch or directory." }
$migrationPath = "migrations/" + $migrationFiles[0].Name
if ($migrationPath -cne $MIGRATION_PATH_EXPECTED) { Stop-Here "the migration is '$migrationPath', expected '$MIGRATION_PATH_EXPECTED'." }
if (-not (Test-Path "src/council.ts")) { Stop-Here "src/council.ts is missing: this checkout is not the council wave." }
if (-not (Select-String -Path "src/council.ts" -Pattern "export async function claimCouncilSeat" -Quiet)) { Stop-Here "src/council.ts has no claimCouncilSeat: this checkout is not the council wave." }
if (-not (Test-Path "src/resident.ts")) { Stop-Here "src/resident.ts is missing: this checkout does not carry the resident tier this wave builds on." }
if (-not (Select-String -Path "src/resident.ts" -Pattern "export async function bindResident" -Quiet)) { Stop-Here "src/resident.ts has no bindResident: this checkout does not carry the resident tier this wave builds on." }
if (-not (Select-String -Path "src/mcp.ts" -Pattern "async function callGuestTool" -Quiet)) { Stop-Here "src/mcp.ts has no callGuestTool: this checkout does not carry the MCP guest door wave this one builds on." }
if (-not (Select-String -Path "src/doors.ts" -Pattern "DOOR_DAILY_CAP" -Quiet)) { Stop-Here "src/doors.ts is missing or has no DOOR_DAILY_CAP: this checkout does not carry the door counters." }
if (-not (Select-String -Path "src/code-identity.ts" -Pattern "export function codeBlock" -Quiet)) { Stop-Here "src/code-identity.ts has no codeBlock: this checkout would drop served code identity." }
if (-not (Select-String -Path "src/guest.ts" -Pattern "export async function postGuestComment" -Quiet)) { Stop-Here "src/guest.ts has no postGuestComment: this checkout would drop the guest voice." }
if (-not (Select-String -Path "wrangler.jsonc" -Pattern '"version_metadata"' -Quiet)) { Stop-Here "wrangler.jsonc has no version_metadata binding: the Worker could not serve Cloudflare's version id." }
if (Select-String -Path "wrangler.jsonc" -Pattern '"CODE_COMMIT"' -Quiet) { Stop-Here "wrangler.jsonc configures a CODE_COMMIT var: a deploy that forgot the flag would serve a stale stamp. The stamp comes from this script's --var only." }
Say ("[git] HEAD " + $headSha.Substring(0, 8) + " = main = origin/main = -ExpectedCommit; tree clean; contains " + $LIVE_BASE_COMMIT.Substring(0, 8) + "; FRONT_DOOR_TEMPLATE unmoved; the one new migration is " + $migrationPath)

# 1. the wave's own gates, re-run here so a stale checkout cannot deploy
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

# 2. live, before: non-minting baseline, the live worker is the base this wave was checked against, the new route ABSENT (so the propagation poll proves something), the prerequisites present, and 0021's state
$attBefore = Read-Attest "before the deploy"
Assert-Attest $attBefore "before the deploy"
Say ("[live] before: v5 " + $V5_HASH.Substring(0, 8) + "; all four chains ok; identity " + $attBefore.identity_log.sealed_entries + ", treasury " + $attBefore.treasury.sealed_entries + ", ballots " + $attBefore.ballots.sealed_entries)
if ($null -eq $attBefore.code -or [string]$attBefore.code.commit_status -cne "stamped") { Stop-Here "GET /api/attest serves no stamped code.commit before the deploy: the live worker cannot be shown to be the base this wave was checked against." }
if ([string]$attBefore.code.commit -ceq $headSha) { Stop-Here "GET /api/attest already serves code.commit $($headSha.Substring(0, 8)): this commit looks already deployed. Verify by hand; this script cannot prove a propagation it did not wait for." }
if ([string]$attBefore.code.commit -cne $LIVE_BASE_COMMIT) { Stop-Here ("the live worker serves code.commit " + $attBefore.code.commit + " but `$LIVE_BASE_COMMIT is " + $LIVE_BASE_COMMIT + ": the base this wave was checked against is not what is live. Correct the pin (or find out what deployed) before anything else.") }
# The rollback target is READ from the live worker, never typed in: the version that serves right now.
$rollbackTarget = "the version before it (check npx wrangler deployments list)"
if ([string]$attBefore.code.version_status -ceq "available" -and $attBefore.code.version_id) { $rollbackTarget = [string]$attBefore.code.version_id }
Say "[live] before: the live worker serves the pinned base $($LIVE_BASE_COMMIT.Substring(0, 8)); rollback target $rollbackTarget"
$routeBefore = Get-Text $NEW_CODE_URL 20
if ($routeBefore.Code -eq "200") { Stop-Here "GET $NEW_CODE_URL already answers 200: this wave looks already deployed. Verify by hand; this script cannot prove a propagation it did not wait for." }
if ($routeBefore.Code -ne "404") { Stop-Here "GET $NEW_CODE_URL answered $($routeBefore.Code) before the deploy, expected 404 (a route only this wave serves): investigate." }
Say "[live] before: GET /api/council answers 404 (the new code is absent)"
$prereqRows = @(Invoke-D1Read "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('guest_thread', 'guests', 'resident_nonces', 'door_counts', 'showhome_rate')")
if ($prereqRows.Count -ne 5) { Stop-Here ("the prerequisite tables are not all on prod (found " + $prereqRows.Count + " of guest_thread, guests, resident_nonces, door_counts, showhome_rate): this wave rides on migrations 0018, 0019 and 0020 and the resident tier. Nothing was changed.") }
$residentColumns = @(Invoke-D1Read "SELECT name FROM pragma_table_info('guests') WHERE name IN ('public_key', 'resident_at')")
if ($residentColumns.Count -ne 2) { Stop-Here "guests has no public_key and resident_at columns on prod: the resident tier (migration 0020) is not live, and the council needs it. Nothing was changed." }
$tableRows = @(Invoke-D1Read "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('council_challenges', 'council_claims', 'council_thread', 'council_motions', 'council_ballots')")
$tablesPresent = $tableRows.Count
if ($tablesPresent -eq 0) { $migrationState = "absent" }
elseif ($tablesPresent -eq 5) { $migrationState = "applied" }
else { Stop-Here ("migration 0021 is half-applied on prod (" + $tablesPresent + " of 5 council tables present): do not re-run the file blind; read the catalogue by hand.") }
if ($migrationState -ceq "applied" -and -not $MigrationAlreadyApplied) { Stop-Here "migration 0021 is already on prod. If an earlier run applied it, re-run with -MigrationAlreadyApplied (the catalogue is still verified)." }
if ($migrationState -ceq "absent" -and $MigrationAlreadyApplied) { Stop-Here "-MigrationAlreadyApplied was given but migration 0021 is not on prod." }
Say ("[d1] prerequisites present (the resident tier's columns included); migration 0021 on prod before: " + $migrationState)

if ($DryRun) {
  Say "[dry-run] would now: apply $migrationPath to the REMOTE D1 (skipped if -MigrationAlreadyApplied); catalogue-verify the five council tables (columns in order, primary keys, the two UNIQUE keys on council_claims including (platform, external_account_id), the 2000 character CHECK, the four indexes, no foreign key); run npx wrangler deploy --var CODE_COMMIT:<the full sha> and capture its Current Version ID (refusing to continue without one); poll up to $POLL_TRIES times, $POLL_DELAY_SECONDS s apart, until GET /api/attest serves that commit and version id and GET /api/council answers 200; re-check attest (v5, template $($V5_HASH.Substring(0, 8)), every chain ok); ride the public reads and the two tools/list calls. NO LIVE WRITE is made at any point except the door counts the ride's own GETs add. Nothing was written to the remote and nothing was deployed."
  exit 0
}

# 3. migration 0021 to the REMOTE D1 FIRST (additive; applied only when the catalogue read above found it absent)
if (-not $MigrationAlreadyApplied) {
  Say "[d1] applying $migrationPath to the remote database"
  $ErrorActionPreference = "Continue"
  npx wrangler d1 execute commonhold --remote --file $migrationPath
  $migCode = $LASTEXITCODE
  $ErrorActionPreference = "Stop"
  if ($migCode -ne 0) { Stop-Here "migration 0021 failed (exit $migCode); nothing deployed; re-read the catalogue before any retry (do NOT re-run the file blind: a partly applied file leaves tables of unknown shape)." }
}

# 3b. catalogue verification (db-migration-verification): read the catalogue directly, never assume the apply worked
Assert-CouncilSchema
$countRows = @(Invoke-D1Read "SELECT (SELECT COUNT(*) FROM council_claims) AS claims_now, (SELECT COUNT(*) FROM council_motions) AS motions_now, (SELECT COUNT(*) FROM council_thread) AS messages_now")
if ($countRows.Count -ne 1 -or "$($countRows[0].claims_now)" -notmatch "^[0-9]+$" -or "$($countRows[0].motions_now)" -notmatch "^[0-9]+$" -or "$($countRows[0].messages_now)" -notmatch "^[0-9]+$") { Stop-Here "the council row count read returned no usable numbers." }
Say ("[d1] catalogue-verified: " + ($COUNCIL_TABLES -join ", ") + " with their columns in order and their keys, council_claims UNIQUE on (" + ($CLAIMS_UNIQUE_KEYS -join ") and (") + "), the four indexes, no foreign key. Rows now: claims " + $countRows[0].claims_now + ", motions " + $countRows[0].motions_now + ", messages " + $countRows[0].messages_now)

# 4. deploy the worker with the commit stamp, capturing its version id (a deploy whose id cannot be read is a stop: it cannot be tied to this commit), then poll until the served identity is this deploy's
# BEGIN-DEPLOY-AND-POLL
Say "[deploy] npx wrangler deploy --var CODE_COMMIT:$($headSha.Substring(0, 8))... (commit $($headSha.Substring(0, 8)))"
$ErrorActionPreference = "Continue"
$deployOut = (npx wrangler deploy --var "CODE_COMMIT:$headSha" 2>&1 | Out-String)
$deployCode = $LASTEXITCODE
$ErrorActionPreference = "Stop"
if ($deployCode -ne 0) { Stop-Here "wrangler deploy failed (exit $deployCode); migration 0021 is applied and harmless to the old worker. Re-run with -MigrationAlreadyApplied. Output: $deployOut" }
# The id is read from its OWN line, and exactly one such line must exist: with two, which one is this deploy's cannot be told.
$versionMatches = @([regex]::Matches($deployOut, '(?m)^[ \t]*Current Version ID:[ \t]*([0-9a-fA-F-]{36})[ \t]*\r?$'))
if ($versionMatches.Count -gt 1) { Stop-Here ("wrangler deploy printed 'Current Version ID' on " + $versionMatches.Count + " lines; which one is this deploy's cannot be told, and the deploy may have succeeded. Check 'npx wrangler deployments list' by hand before anything else.") }
if ($versionMatches.Count -lt 1) { Stop-Here "wrangler deploy exited 0 but printed no 'Current Version ID'; the deploy may have succeeded. Check 'npx wrangler deployments list' by hand before anything else." }
$versionId = $versionMatches[0].Groups[1].Value
Say "[deploy] worker version id $versionId (commit $($headSha.Substring(0, 8)))"
$ROLLBACK_LINE = "ROLL BACK THE WORKER (npx wrangler rollback, to the version before $versionId, which should be $rollbackTarget; check npx wrangler deployments list first). Migration 0021 can stay: it is additive and the old worker never names the council tables."
Wait-NewWorker $headSha $versionId $POLL_TRIES $POLL_DELAY_SECONDS
# END-DEPLOY-AND-POLL

# 5. the ride: non-minting and the chains, then the public reads and two read-only tools/list calls. NO LIVE WRITE except the door counts its own GETs add: a claim needs a resident's token, a ballot a signed assertion.
$attAfter = Read-Attest "after the deploy"
Assert-Attest $attAfter "after the deploy"
Say ("[ride] attest: v5 " + $V5_HASH.Substring(0, 8) + " unchanged; every chain ok")
$bad = @()
$skill = $null
foreach ($p in "/", "/api/official", "/llms.txt", "/skill.md", "/heartbeat.md", "/openapi.json", "/treasury", "/api/listings", "/api/stats", "/api/topics", "/api/guest/due", "/api/citizens", "/api/doors", "/api/council", "/api/council/thread") {
  $r = Get-Text "$BASE$p" 30
  if ($r.Code -ne "200") { $bad += "$p=$($r.Code)" }
  # /skill.md is fetched ONCE and its body read from this same response: each 200 on it adds one request to that day's door_counts row.
  if ($p -ceq "/skill.md") { $skill = $r }
}
if ($bad.Count -gt 0) { Stop-Here ("non-200 after the deploy (version $versionId): " + ($bad -join ", ") + ". If a read that answered before now fails: $ROLLBACK_LINE") }
Say "[ride] 15 public reads -> 200 (this counted GET /skill.md and GET /heartbeat.md once each, the only writes the ride makes: the door counts its own GETs add)"
if (-not $skill.Body.Contains($SKILL_VERSION_LINE)) { Stop-Here "GET /skill.md does not carry '$SKILL_VERSION_LINE'. $ROLLBACK_LINE" }
if (-not $skill.Body.Contains("## The council")) { Stop-Here "GET /skill.md has no 'The council' section. $ROLLBACK_LINE" }
Say "[ride] /skill.md -> $SKILL_VERSION_LINE with the council section"
$council = Get-Json "$BASE/api/council"
if ($null -eq $council.members -or $null -eq $council.counts -or "$($council.counts.total)" -notmatch "^[0-9]+$" -or [string]::IsNullOrEmpty([string]$council.rules.self_paid)) { Stop-Here "GET /api/council has no members array, no numeric counts.total or no rules. $ROLLBACK_LINE" }
foreach ($want in $RIDE_MEMBERS) {
  $wantParts = $want.Split(":")
  $seated = @($council.members | Where-Object { $_.handle -ceq $wantParts[0] })
  if ($seated.Count -ne 1) { Stop-Here ("GET /api/council lists " + $seated.Count + " members named " + $wantParts[0] + ", expected 1 (the rule seats it today). " + $ROLLBACK_LINE) }
  if ([string]$seated[0].rule -cne $wantParts[1]) { Stop-Here ("GET /api/council seats " + $wantParts[0] + " by rule '" + $seated[0].rule + "', expected '" + $wantParts[1] + "'. " + $ROLLBACK_LINE) }
}
$official = Get-Json "$BASE/api/official"
if ($null -eq $official.council -or "$($official.council.members)" -notmatch "^[0-9]+$") { Stop-Here "GET /api/official has no council block with a numeric members count. $ROLLBACK_LINE" }
if ("$($official.council.members)" -cne "$($council.counts.total)") { Stop-Here "GET /api/official council.members ($($official.council.members)) is not GET /api/council counts.total ($($council.counts.total)): two surfaces disagree about one figure. $ROLLBACK_LINE" }
if (@($official.composition.PSObject.Properties.Name) -ccontains "council") { Stop-Here "GET /api/official carries the council INSIDE the composition: it must sit beside it. $ROLLBACK_LINE" }
Say ("[ride] /api/council and /api/official agree: " + $council.counts.total + " member(s), ledger-watch seated as the operator's seat and sisyphus as self-paid, the council beside the composition and not in it")
$thread = Get-Json "$BASE/api/council/thread"
if ($null -eq $thread.messages -or "$($thread.total)" -notmatch "^[0-9]+$" -or [string]::IsNullOrEmpty([string]$thread.note)) { Stop-Here "GET /api/council/thread has no messages array, no numeric total or no note. $ROLLBACK_LINE" }
Say "[ride] GET /api/council/thread answers with its own shape"
$list = Post-Json "$BASE/mcp" '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
if ($list.Code -ne "200") { Stop-Here "POST /mcp tools/list answered $($list.Code), expected 200. $ROLLBACK_LINE" }
foreach ($tool in (@("council") + $COUNCIL_WRITE_TOOLS)) {
  $listed = $list.Body.Contains('"name":"' + $tool + '"')
  if (-not $listed) { Stop-Here "POST /mcp tools/list does not list $tool. $ROLLBACK_LINE" }
}
$readList = Post-Json "$BASE/mcp/read" '{"jsonrpc":"2.0","id":3,"method":"tools/list"}'
if ($readList.Code -ne "200") { Stop-Here "POST /mcp/read tools/list answered $($readList.Code), expected 200. $ROLLBACK_LINE" }
if (-not $readList.Body.Contains('"name":"council"')) { Stop-Here "POST /mcp/read tools/list does not list the council read tool. $ROLLBACK_LINE" }
# The tool NAMES are what is checked: several read-tool descriptions say where a member writes, so the bare words appear on /mcp/read by design.
foreach ($tool in $COUNCIL_WRITE_TOOLS) {
  if ($readList.Body.Contains('"name":"' + $tool + '"')) { Stop-Here "POST /mcp/read tools/list lists the write tool ${tool}: the read door must stay read-only. $ROLLBACK_LINE" }
}
Say "[ride] POST /mcp tools/list lists council and the six council write tools; /mcp/read lists council and none of the six"
Say "[note] No live write was made except the door counts the ride's own GETs add: the first challenge, claim, message, motion, ballot and flag are first ridden by real members. Until then they are proved by tests only."
Say "[done] Council deployed and ridden (reads only). Log version id $versionId, commit $($headSha.Substring(0, 8)) and these lines in HANDOVER.md; then re-stage the registry kits from the live /skill.md 1.4.0 (Ben's acts)."
