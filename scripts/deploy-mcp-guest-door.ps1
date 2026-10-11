# Deploys the MCP GUEST DOOR (D-075 order step a; build log docs/CHECKPOINT-MCP-GUEST-DOOR.md): migration 0019 (ONE new table, door_counts) to the REMOTE D1 FIRST, then ONE worker
# deploy that carries the three guest tools on /mcp, the door counters, GET /api/doors and /skill.md 1.2.0. Ben's hand only (D-017). One fail-fast script (L-046, L-069).
# WRITTEN BY THE BUILDER AND NEVER RUN: not even -DryRun, which reads the remote D1 through wrangler (reads only, no write). The Sonnet gate, the merge and the push come before it.
# NO MINT: the wave touches no sentence of the attested template (src/doc.ts is not edited). This script STOPS if src/doc.ts moved since the live worker's code ($LIVE_BASE_COMMIT), if
# anything under migrations/ other than the new 0019 moved, and after the deploy it STOPS if the constitution is not still v5 with its template hash.
# Order is load-bearing: the new worker writes door_counts on the first GET of /skill.md. A worker deployed before the table exists would log one door_count_failed warn per counted
# request (counting never fails a request, so it would not be an outage, but the figures would be lost). Migration 0019 therefore goes to the REMOTE D1 first, is catalogue-verified (the
# table, its three columns in order, the primary key (day, door), zero foreign keys), and only then does the worker deploy. Migration 0019 is additive and harmless to the OLD worker,
# which never reads the table, so every stop before "wrangler deploy" leaves the live worker exactly as it was.
# THE DEPLOY STAMPS THE COMMIT: `npx wrangler deploy --var CODE_COMMIT:<sha>` (served code identity, scripts/deploy-code-identity.ps1). Each wrangler deploy replaces the version's vars, so a
# deploy that forgets the flag would serve commit_status "not_stamped"; scripts/deploy-guest-voice.ps1 predates that and does not carry it. The poll after the deploy waits until
# GET /api/attest serves code.commit equal to the pinned sha AND code.version_id equal to the Current Version ID wrangler printed.
# REVIEWED SOURCE ONLY: step 0 STOPS while $REVIEWED_COMMIT still holds the placeholder (the hub sets it after the merge), and otherwise STOPS unless HEAD is that commit plus changes confined to
# $ALLOWED_PATHS_AFTER_REVIEW (this script, its test, docs/).
# Run from society/ on main, after the merge and the push:
#   cd "C:\Users\bengr\Projects\AI domain and social network\society"
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-mcp-guest-door.ps1 -ExpectedCommit <sha> -DryRun   # every check and the remote READS, nothing written, nothing deployed
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-mcp-guest-door.ps1 -ExpectedCommit <sha>           # the real thing
#   ... -MigrationAlreadyApplied   only to re-run after a failed or interrupted wrangler deploy, when 0019 is already on prod
# <sha> is the pushed tip of main (git -C society rev-parse HEAD), the full 40 hex.
# THE RIDE: public GETs, one POST /mcp initialize, and ONE real free write, POST /mcp tools/call guest_enter (handle "deploy-ride"; it mints one visitor token that is discarded unread).
# That write is the first real-D1 run of the MCP guest path and of the showhome_enter counter. The first guest COMMENT over MCP is first ridden by the first real guest; until then it is
# proved by tests only. After the ride GET /api/doors must show the counts the ride itself caused (skill_md, mcp_initialize, showhome_enter); counting is handed to ctx.waitUntil, so the
# script waits and retries a few times before it calls a missing count a failure.
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
# The live worker's code before this wave: main at the daily-loop and Rule 7 sentences deploy (9 Oct 2026). Step 0 proves HEAD descends from it.
$LIVE_BASE_COMMIT = "07e9c57d9339a7a8a8acf4b3f9c28674b6eccbd4"
# The worker version live before this wave; the rollback target.
$ROLLBACK_WORKER_VERSION = "0ed544ae-5ec0-4301-8910-2bcf255caffe"
# THE REVIEWED SOURCE. The hub replaces this placeholder with the full sha the review converged on; step 0 STOPS while it is unchanged, and while it is not 40 lower-case hex.
$REVIEWED_COMMIT = "TO-BE-SET-BY-HUB"
$REVIEWED_COMMIT_PLACEHOLDER = "TO-BE-SET-BY-HUB"
$ALLOWED_PATHS_AFTER_REVIEW = @("scripts/deploy-mcp-guest-door.ps1", "test/deploy-mcp-guest-door-script.test.ts", "docs/")
$MIGRATION_GLOB = "migrations/0019_*.sql"
$MIGRATION_PATH_EXPECTED = "migrations/0019_door_counts.sql"
# Every column of door_counts in table order, and its primary key columns in key order, from migrations/0019_door_counts.sql. THREE columns. The test compares these lists with the migration and with schema.sql.
$DOOR_COLUMN_NAMES = @("day", "door", "n")
$DOOR_KEY_NAMES = @("day", "door")
# The propagation poll waits for THIS route to answer 200 (a route only this wave serves); the pre-deploy probe proves it answers 404 first.
$NEW_CODE_URL = "$BASE/api/doors"
$SKILL_VERSION_LINE = "version: 1.2.0"
$POLL_TRIES = 12
$POLL_DELAY_SECONDS = 5
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
# A JSON-RPC POST to the live worker with the body in a temp file (no quoting seam), returning @{ Code; Body }.
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
        Say "[poll] try $n of ${tries}: GET /api/attest serves code.commit $($commit.Substring(0, 8)) and code.version_id $versionId; GET /api/doors answers 200"
        return
      }
      $why = "GET /api/doors answered $($route.Code), expected 200"
    }
    $last = $why
    Say "[poll] try $n of ${tries}: not yet: $why"
    if ($n -lt $tries) { Start-Sleep -Seconds $delaySeconds }
  }
  Stop-Here ("the new worker was never shown live in " + $tries + " reads (last: " + $last + "). The deploy is not shown to be live. " + $ROLLBACK_LINE)
}
# One table's catalogue check: every column in order, then the primary key in key order. A mismatch STOPS (the worker must not deploy against it).
function Assert-DoorTable {
  $info = @(Invoke-D1Read "SELECT cid, name, type, pk FROM pragma_table_info('door_counts') ORDER BY cid")
  $gotNames = @($info | ForEach-Object { $_.name })
  if ($gotNames.Count -ne $DOOR_COLUMN_NAMES.Count) { Stop-Here ("door_counts has " + $gotNames.Count + " columns, expected " + $DOOR_COLUMN_NAMES.Count + ": " + ($gotNames -join ", ")) }
  for ($k = 0; $k -lt $DOOR_COLUMN_NAMES.Count; $k++) {
    if ($gotNames[$k] -cne $DOOR_COLUMN_NAMES[$k]) { Stop-Here ("door_counts column " + $k + " is '" + $gotNames[$k] + "', expected '" + $DOOR_COLUMN_NAMES[$k] + "'") }
  }
  $gotKey = @($info | Where-Object { [int]$_.pk -gt 0 } | Sort-Object { [int]$_.pk } | ForEach-Object { $_.name })
  if (($gotKey -join ",") -cne ($DOOR_KEY_NAMES -join ",")) { Stop-Here ("door_counts primary key is (" + ($gotKey -join ", ") + "), expected (" + ($DOOR_KEY_NAMES -join ", ") + ")") }
  $fkRows = @(Invoke-D1Read "SELECT COUNT(*) AS n FROM pragma_foreign_key_list('door_counts')")
  if ($fkRows.Count -ne 1 -or "$($fkRows[0].n)" -cne "0") { Stop-Here "door_counts carries a foreign key, or the foreign key list could not be read." }
  $autoRows = @(Invoke-D1Read "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'door_counts' AND sql IS NULL")
  if ($autoRows.Count -ne 1) { Stop-Here ("door_counts carries " + $autoRows.Count + " automatic indexes, expected 1 (the primary key).") }
}
# END-OF-DEFINITIONS (test/deploy-mcp-guest-door-script.test.ts reads everything above this line as definitions; nothing above runs git, npm, wrangler or the network)

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
# Non-minting: the attested template lives in src/doc.ts, and this wave does not touch it.
$docMoves = @(git diff --name-only $LIVE_BASE_COMMIT HEAD -- src/doc.ts)
if ($LASTEXITCODE -ne 0) { Stop-Here "git diff failed (exit $LASTEXITCODE): the no-mint check cannot be read." }
if ($docMoves.Count -gt 0) { Stop-Here "src/doc.ts moved since $($LIVE_BASE_COMMIT.Substring(0, 8)): this wave mints nothing and was to leave the attested template alone. Not this script's deploy." }
# The only migration since the live code is 0019, added (not edited): one additive table.
$migMoves = @(git diff --name-status --no-renames $LIVE_BASE_COMMIT HEAD -- migrations)
if ($LASTEXITCODE -ne 0) { Stop-Here "git diff failed (exit $LASTEXITCODE): the migration check cannot be read." }
if ($migMoves.Count -ne 1 -or $migMoves[0] -cne ("A`t" + $MIGRATION_PATH_EXPECTED)) { Stop-Here ("expected exactly one added migration ($MIGRATION_PATH_EXPECTED) since " + $LIVE_BASE_COMMIT.Substring(0, 8) + ", found: " + ($migMoves -join " | ")) }
# BEGIN-REVIEWED-SOURCE-CHECK
# (a) the reviewed commit is set, and is a full sha
if ($REVIEWED_COMMIT -ceq $REVIEWED_COMMIT_PLACEHOLDER) { Stop-Here "`$REVIEWED_COMMIT still holds the placeholder '$REVIEWED_COMMIT_PLACEHOLDER': the hub sets it to the commit the review converged on, and until then there is no reviewed source to deploy." }
if ($REVIEWED_COMMIT -cnotmatch '^[0-9a-f]{40}$') { Stop-Here "`$REVIEWED_COMMIT '$REVIEWED_COMMIT' is not 40 lower-case hex." }
# (b) HEAD is the reviewed commit plus only the allowlisted paths (no rename detection: a rename out of src/ into docs/ must list BOTH paths)
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
if (-not (Test-Path "src/doors.ts")) { Stop-Here "src/doors.ts is missing: this checkout is not the MCP guest door wave." }
if (-not (Select-String -Path "src/mcp.ts" -Pattern "async function callGuestTool" -Quiet)) { Stop-Here "src/mcp.ts has no callGuestTool: this checkout is not the MCP guest door wave." }
if (-not (Select-String -Path "src/code-identity.ts" -Pattern "export function codeBlock" -Quiet)) { Stop-Here "src/code-identity.ts has no codeBlock: this checkout would drop served code identity." }
if (-not (Select-String -Path "src/guest.ts" -Pattern "export async function postGuestComment" -Quiet)) { Stop-Here "src/guest.ts has no postGuestComment: this checkout would drop the guest voice." }
if (-not (Select-String -Path "wrangler.jsonc" -Pattern '"version_metadata"' -Quiet)) { Stop-Here "wrangler.jsonc has no version_metadata binding: the Worker could not serve Cloudflare's version id." }
if (Select-String -Path "wrangler.jsonc" -Pattern '"CODE_COMMIT"' -Quiet) { Stop-Here "wrangler.jsonc configures a CODE_COMMIT var: a deploy that forgot the flag would serve a stale stamp. The stamp comes from this script's --var only." }
Say ("[git] HEAD " + $headSha.Substring(0, 8) + " = main = origin/main = -ExpectedCommit; tree clean; contains " + $LIVE_BASE_COMMIT.Substring(0, 8) + "; src/doc.ts unmoved; the one new migration is " + $migrationPath)

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

# 2. live, before: non-minting baseline, the new route ABSENT (so the propagation poll proves something), the guest voice's tables present, and door_counts' state
$attBefore = Read-Attest "before the deploy"
Assert-Attest $attBefore "before the deploy"
Say ("[live] before: v5 " + $V5_HASH.Substring(0, 8) + "; all four chains ok; identity " + $attBefore.identity_log.sealed_entries + ", treasury " + $attBefore.treasury.sealed_entries + ", ballots " + $attBefore.ballots.sealed_entries)
if ($null -ne $attBefore.code -and [string]$attBefore.code.commit -ceq $headSha) { Stop-Here "GET /api/attest already serves code.commit $($headSha.Substring(0, 8)): this commit looks already deployed. Verify by hand; this script cannot prove a propagation it did not wait for." }
$routeBefore = Get-Text $NEW_CODE_URL 20
if ($routeBefore.Code -eq "200") { Stop-Here "GET $NEW_CODE_URL already answers 200: this wave looks already deployed. Verify by hand; this script cannot prove a propagation it did not wait for." }
if ($routeBefore.Code -ne "404") { Stop-Here "GET $NEW_CODE_URL answered $($routeBefore.Code) before the deploy, expected 404 (a route only this wave serves): investigate." }
Say "[live] before: GET /api/doors answers 404 (the new code is absent)"
$guestRows = @(Invoke-D1Read "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('guest_thread', 'guests', 'visitors', 'showhome_rate')")
if ($guestRows.Count -ne 4) { Stop-Here ("the guest voice tables are not all on prod (found " + $guestRows.Count + " of guest_thread, guests, visitors, showhome_rate): this wave rides on migration 0018 and the showhome. Nothing was changed.") }
$doorRows = @(Invoke-D1Read "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'door_counts'")
$doorPresent = $doorRows.Count
if ($doorPresent -eq 1 -and -not $MigrationAlreadyApplied) { Stop-Here "door_counts already exists on prod. If migration 0019 was applied by an earlier run, re-run with -MigrationAlreadyApplied (the catalogue is still verified)." }
if ($doorPresent -eq 0 -and $MigrationAlreadyApplied) { Stop-Here "-MigrationAlreadyApplied was given but door_counts does not exist on prod." }
Say ("[d1] guest tables present; door_counts present before: " + $doorPresent + " of 1")

if ($DryRun) {
  Say "[dry-run] would now: apply $migrationPath to the REMOTE D1 (skipped if -MigrationAlreadyApplied); catalogue-verify door_counts (three columns in order, the primary key (day, door), no foreign key, one automatic index); run npx wrangler deploy --var CODE_COMMIT:<the full sha> and capture its Current Version ID (refusing to continue without one); poll up to $POLL_TRIES times, $POLL_DELAY_SECONDS s apart, until GET /api/attest serves that commit and version id and GET /api/doors answers 200; re-check attest (v5, template $($V5_HASH.Substring(0, 8)), every chain ok); ride the public reads, POST /mcp initialize, tools/list and ONE real guest_enter, then read the counts back from GET /api/doors. Nothing was written to the remote and nothing was deployed."
  exit 0
}

# 3. migration 0019 to the REMOTE D1 FIRST (additive; CREATE ... IF NOT EXISTS, so a re-apply is a no-op)
if (-not $MigrationAlreadyApplied) {
  Say "[d1] applying $migrationPath to the remote database"
  $ErrorActionPreference = "Continue"
  npx wrangler d1 execute commonhold --remote --file $migrationPath
  $migCode = $LASTEXITCODE
  $ErrorActionPreference = "Stop"
  if ($migCode -ne 0) { Stop-Here "migration 0019 failed (exit $migCode); nothing deployed; re-read the catalogue before any retry." }
}

# 3b. catalogue verification (db-migration-verification): read the catalogue directly, never assume the apply worked
Assert-DoorTable
$countRows = @(Invoke-D1Read "SELECT COUNT(*) AS rows_now FROM door_counts")
if ($countRows.Count -ne 1 -or "$($countRows[0].rows_now)" -notmatch "^[0-9]+$") { Stop-Here "the door_counts row count read returned no usable number." }
Say ("[d1] catalogue-verified: door_counts " + $DOOR_COLUMN_NAMES.Count + " columns (" + ($DOOR_COLUMN_NAMES -join ", ") + "), primary key (" + ($DOOR_KEY_NAMES -join ", ") + "), no foreign key; rows now: " + $countRows[0].rows_now)

# 4. deploy the worker with the commit stamp, capturing its version id (a deploy whose id cannot be read is a stop: it cannot be tied to this commit), then poll until the served identity is this deploy's
# BEGIN-DEPLOY-AND-POLL
Say "[deploy] npx wrangler deploy --var CODE_COMMIT:$($headSha.Substring(0, 8))... (commit $($headSha.Substring(0, 8)))"
$ErrorActionPreference = "Continue"
$deployOut = (npx wrangler deploy --var "CODE_COMMIT:$headSha" 2>&1 | Out-String)
$deployCode = $LASTEXITCODE
$ErrorActionPreference = "Stop"
if ($deployCode -ne 0) { Stop-Here "wrangler deploy failed (exit $deployCode); migration 0019 is applied and harmless to the old worker. Re-run with -MigrationAlreadyApplied. Output: $deployOut" }
# The id is read from its OWN line, and exactly one such line must exist: with two, which one is this deploy's cannot be told.
$versionMatches = @([regex]::Matches($deployOut, '(?m)^[ \t]*Current Version ID:[ \t]*([0-9a-fA-F-]{36})[ \t]*\r?$'))
if ($versionMatches.Count -gt 1) { Stop-Here ("wrangler deploy printed 'Current Version ID' on " + $versionMatches.Count + " lines; which one is this deploy's cannot be told, and the deploy may have succeeded. Check 'npx wrangler deployments list' by hand before anything else.") }
if ($versionMatches.Count -lt 1) { Stop-Here "wrangler deploy exited 0 but printed no 'Current Version ID'; the deploy may have succeeded. Check 'npx wrangler deployments list' by hand before anything else." }
$versionId = $versionMatches[0].Groups[1].Value
Say "[deploy] worker version id $versionId (commit $($headSha.Substring(0, 8)))"
$ROLLBACK_LINE = "ROLL BACK THE WORKER (npx wrangler rollback, to the version before $versionId, which should be $ROLLBACK_WORKER_VERSION; check npx wrangler deployments list first). Migration 0019 can stay: it is additive and the old worker never reads door_counts."
Wait-NewWorker $headSha $versionId $POLL_TRIES $POLL_DELAY_SECONDS
# END-DEPLOY-AND-POLL

# 5. the ride: non-minting and the chains, the public reads, the MCP door, then ONE real free write
$attAfter = Read-Attest "after the deploy"
Assert-Attest $attAfter "after the deploy"
Say ("[ride] attest: v5 " + $V5_HASH.Substring(0, 8) + " unchanged; every chain ok")
$bad = @()
foreach ($p in "/", "/api/official", "/llms.txt", "/skill.md", "/heartbeat.md", "/openapi.json", "/treasury", "/api/listings", "/api/stats", "/api/topics", "/api/guest/due", "/api/citizens", "/api/doors") {
  $r = Get-Text "$BASE$p" 30
  if ($r.Code -ne "200") { $bad += "$p=$($r.Code)" }
}
if ($bad.Count -gt 0) { Stop-Here ("non-200 after the deploy (version $versionId): " + ($bad -join ", ") + ". If a read that answered before now fails: $ROLLBACK_LINE") }
Say "[ride] 13 public reads -> 200 (this counted GET /skill.md and GET /heartbeat.md once each)"
$skill = Get-Text "$BASE/skill.md" 30
if (-not $skill.Body.Contains($SKILL_VERSION_LINE)) { Stop-Here "GET /skill.md does not carry '$SKILL_VERSION_LINE'. $ROLLBACK_LINE" }
Say "[ride] /skill.md -> $SKILL_VERSION_LINE"
$doorsNow = Get-Json "$BASE/api/doors"
if ($null -eq $doorsNow.rows -or [string]::IsNullOrEmpty([string]$doorsNow.note)) { Stop-Here "GET /api/doors has no rows array or no note." }
if ([int]$doorsNow.window_days -ne 30) { Stop-Here "GET /api/doors window_days is '$($doorsNow.window_days)', expected 30." }
$init = Post-Json "$BASE/mcp" '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25"}}'
if ($init.Code -ne "200" -or -not $init.Body.Contains("guest_enter returns a token")) { Stop-Here "POST /mcp initialize answered $($init.Code) or lacks the guest sentence. $ROLLBACK_LINE" }
$list = Post-Json "$BASE/mcp" '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
foreach ($tool in "guest_enter", "guest_comment", "showhome_note") {
  # PowerShell's -and and -or have EQUAL precedence (left to right), so every mixed condition here is parenthesised.
  $listed = $list.Body.Contains('"name":"' + $tool + '"')
  if ($list.Code -ne "200" -or -not $listed) { Stop-Here "POST /mcp tools/list does not list $tool. $ROLLBACK_LINE" }
}
$readList = Post-Json "$BASE/mcp/read" '{"jsonrpc":"2.0","id":3,"method":"tools/list"}'
if ($readList.Code -ne "200") { Stop-Here "POST /mcp/read tools/list answered $($readList.Code), expected 200. $ROLLBACK_LINE" }
# The tool NAMES are what is checked: several read-tool descriptions (guest_thread, guest_inbox, guest_due) now say where a guest writes, so the bare words appear on /mcp/read by design.
foreach ($tool in "guest_enter", "guest_comment", "showhome_note") {
  if ($readList.Body.Contains('"name":"' + $tool + '"')) { Stop-Here "POST /mcp/read tools/list lists the guest write tool ${tool}: the read door must stay read-only. $ROLLBACK_LINE" }
}
Say "[ride] POST /mcp initialize carries the guest sentence; tools/list lists the three guest tools; /mcp/read lists none of them"
# The ONE real free write: the first real-D1 run of the MCP guest path (enterShowhome through the MCP door, the shared rate cap, and the showhome_enter counter). The token is never printed or kept. Expect isError absent.
$enter = Post-Json "$BASE/mcp" '{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"guest_enter","arguments":{"handle":"deploy-ride","model":"deploy-script"}}}'
if ($enter.Code -ne "200" -or $enter.Body.Contains('"isError"') -or -not $enter.Body.Contains("commonhold_visit_")) { Stop-Here ("the MCP guest_enter ride failed (HTTP " + $enter.Code + "): every MCP guest write passes the same functions as the HTTP routes. " + $ROLLBACK_LINE) }
Say "[ride] POST /mcp guest_enter -> a visitor token (discarded unread): the MCP guest path runs on real D1"
# The counts the ride itself caused. Counting is handed to ctx.waitUntil, so allow a few reads before calling a missing count a failure.
$want = @("skill_md", "heartbeat_md", "mcp_initialize", "showhome_enter")
$missing = @($want)
for ($n = 1; $n -le 6 -and $missing.Count -gt 0; $n++) {
  Start-Sleep -Seconds 3
  $doors = Get-Json "$BASE/api/doors"
  $seen = @($doors.rows | Where-Object { [int]$_.n -ge 1 } | ForEach-Object { [string]$_.door })
  $missing = @($want | Where-Object { $seen -cnotcontains $_ })
}
if ($missing.Count -gt 0) { Stop-Here ("GET /api/doors never showed a count for: " + ($missing -join ", ") + ". The worker is live and serving; counting never fails a request, so this is not a rollback signal by itself: read the worker log for door_count_failed, and check door_counts on prod by hand.") }
Say ("[ride] GET /api/doors shows a count for " + ($want -join ", ") + " (the ride's own requests)")
Say "[note] The first guest COMMENT over MCP, and mcp_read_initialize and guest_comment in the counts, are first ridden by real agents. Until then they are proved by tests only."
Say "[done] MCP guest door deployed and ridden. Log version id $versionId, commit $($headSha.Substring(0, 8)) and these lines in HANDOVER.md; then re-stage the registry kits from the live /skill.md 1.2.0 (Ben's acts)."
