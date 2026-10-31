# Deploys the 31 OCT MODEL-CALL RETRY WAVE (D-079): a failed maintainer model call (clerk, judgment, concierge) is retried ONCE when the invocation's subrequest budget affords it, the audit goes in the new
# model_retry column on maintainer_runs and concierge_runs (served on GET /api/maintainer-runs and GET /api/concierge-runs), and the clerk and judgment catch-up wakes are in the code (INERT until Ben registers their two
# cron lines in wrangler.jsonc). Spec: docs/BRIEF-MODEL-CALL-RETRY.md; gate record docs/REVIEW-MODEL-CALL-RETRY-GATE-2026-10-31.md (DEPLOYABLE WITH CONDITIONS; this script is condition C1).
# Ben's hand only (D-017). ONE fail-fast script (L-046, L-069). WRITTEN BY THE BUILDER AND NEVER RUN: not in any mode, not even -DryRun or -Rehearse.
# ORDER IS LOAD-BEARING. The new worker's run-row writers name model_retry (INSERT and UPDATE on maintainer_runs, INSERT on concierge_runs). A worker deployed before migration 0022 would fail every run-row write
# and a wake would leave an open row. So migration 0022 goes to the REMOTE D1 FIRST, is verified by reading pragma_table_info on BOTH tables (model_retry present, type TEXT), and only then does the worker deploy.
# The migration is two ALTER TABLE ... ADD COLUMN statements (nullable, no default, no rebuild) and is harmless to the OLD worker: it reads SELECT * and writes explicit column lists. So every stop before
# `wrangler deploy` leaves the live worker as it was, and the rollback after it is the worker alone. A second run of the file would fail on a duplicate column, so the script READS the catalogue first and applies the
# file only when BOTH columns are absent; one present and one absent is a half-applied state and STOPS.
# THREE MODES. -Rehearse runs the SAME migration and the SAME pragma check against the scratch D1 commonhold-migtest ONLY (never prod, no worker, no live read, no tests): the rehearsal the gate asks for, first.
# -DryRun does every check and every live read and writes nothing (with -Rehearse it reads the scratch catalogue and applies nothing). The real run is neither.
# TWO PINS. $LIVE_BASE_COMMIT is the commit the live worker serves when this runs (the proposals unknown-params wave, 95a80c92); step 2 PROVES it against the live GET /api/attest code.commit.
# $REVIEWED_COMMIT is the commit the review converged on (the code tip). Step 0a STOPS, before any git or network command, while EITHER still holds its placeholder or is not 40 lower-case hex.
# NO MINT: step 0 STOPS if src/doc.ts differs between the live base and HEAD, and unless the ONLY migration added since the live base is migrations/0022_model_retry.sql.
# THE DEPLOY STAMPS THE COMMIT: `npx wrangler deploy --var CODE_COMMIT:<sha>`. The poll waits until GET /api/attest serves code.commit equal to the pinned sha AND code.version_id equal to the Current Version ID
# wrangler printed. The ROLLBACK TARGET is the version id GET /api/attest served BEFORE the deploy (read live, never typed in).
# REVIEWED SOURCE ONLY: step 0 also STOPS unless HEAD is $REVIEWED_COMMIT plus changes confined to $ALLOWED_PATHS_AFTER_REVIEW (this script, its test, docs/).
# THE CATCH-UP CRONS ARE NOT REGISTERED BY THIS SCRIPT. After this deploy the two catch-up branches exist and never fire. The cron line and the matching test/guest-check-d1.test.ts expectation are a separate step of
# Ben's (gate condition C2); wrangler.jsonc is not touched here, and this script STOPS if wrangler.jsonc configures a CODE_COMMIT var.
# Run from society/ on main, after the merge and the push:
#   cd "C:\Users\bengr\Projects\AI domain and social network\society"
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-model-call-retry.ps1 -ExpectedCommit <sha> -Rehearse -DryRun   # scratch D1 reads only
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-model-call-retry.ps1 -ExpectedCommit <sha> -Rehearse            # 0022 on commonhold-migtest, pragma-checked
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-model-call-retry.ps1 -ExpectedCommit <sha> -DryRun              # every check and the remote READS, nothing written, nothing deployed
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-model-call-retry.ps1 -ExpectedCommit <sha>                      # the real thing
#   ... -MigrationAlreadyApplied   only to re-run after a failed or interrupted wrangler deploy, when 0022 is already on prod (the catalogue is still verified)
# <sha> is the pushed tip of main (git -C society rev-parse HEAD), the full 40 hex.
# THE RIDE holds no token, key or assertion and writes nothing: public GETs only (it does not fetch /skill.md or /heartbeat.md, whose GETs add to the door counts).
# PowerShell 5.1 traps this file avoids: one spelling per variable name; -notmatch on an array filters instead of testing; a one-element return is wrapped in @(); "$var:" is a drive reference
# (write "${var}:"); never merge a native command's stderr under ErrorActionPreference Stop; -eq and -ne are case-INSENSITIVE (hashes, shas and column types are compared with -ceq / -cne); PS 5.1 strips
# inner double quotes from a native command's argument, so this script sends no request body at all. ASCII only.
param(
  [Parameter(Mandatory = $true)][string]$ExpectedCommit,
  [switch]$DryRun,
  [switch]$Rehearse,
  [switch]$MigrationAlreadyApplied
)
$ErrorActionPreference = "Stop"
$BASE = "https://commonhold.randommonicle.workers.dev"
# The attested constitution this wave must leave untouched (v6, minted 22 Oct).
$V6_HASH = "dc5f48213c29bcf844e0fbe7daf1bdb5416b3d57fbd06a8bd03f1061f34092b3"
# The commit the live worker serves when this runs (the proposals unknown-params wave, 95a80c92).
$LIVE_BASE_COMMIT = "95a80c92f7b14d41ced3696517455393c5bb26ee"
$LIVE_BASE_PLACEHOLDER = "TO-BE-SET-BY-HUB-LIVE-BASE"
# THE REVIEWED SOURCE: the code tip of the branch (the gate's D2/D3 fixes included). Step 0 STOPS while it is unchanged from the placeholder, and while it is not 40 lower-case hex.
$REVIEWED_COMMIT = "5b6cec30560b43e3edf5e0920b1bfcad5e6d9392"
$REVIEWED_COMMIT_PLACEHOLDER = "TO-BE-SET-BY-HUB"
$ALLOWED_PATHS_AFTER_REVIEW = @("scripts/deploy-model-call-retry.ps1", "test/deploy-model-call-retry-script.test.ts", "docs/")
# The database names are wrangler.jsonc's database_name for the DB binding (prod) and the scratch rehearsal database. -Rehearse can only ever name the second.
$PROD_DB = "commonhold"
$SCRATCH_DB = "commonhold-migtest"
$MIGRATION_PATH_EXPECTED = "migrations/0022_model_retry.sql"
$RETRY_TABLES = @("maintainer_runs", "concierge_runs")
$RETRY_COLUMN = "model_retry"
$RETRY_COLUMN_TYPE = "TEXT"
$MAINTAINER_RUNS_URL = "$BASE/api/maintainer-runs"
$CONCIERGE_RUNS_URL = "$BASE/api/concierge-runs"
$POLL_TRIES = 12
$POLL_DELAY_SECONDS = 5

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
# The status code, content type and body of a GET. The content type is read from curl's own -w, never guessed.
function Get-Text($url, $maxTime) {
  $tmp = [System.IO.Path]::GetTempFileName()
  try {
    $meta = (curl.exe -s --max-time $maxTime -o $tmp -w "%{http_code}|%{content_type}" $url)
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
  $r = Get-Text $url 20
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
# The `code` block GET /api/attest serves now, or $null when the read fails or carries none. Never stops: the poll decides.
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
# The JSON body of a captured GET answer, or $null when it is not JSON.
function Read-JsonBody($r) {
  try { return ([string]$r.Body | ConvertFrom-Json) } catch { return $null }
}
# "" when $r is a run-log endpoint answering 200 with a non-empty runs array in which EVERY row carries a model_retry key (null is a value; a missing key is the failure), otherwise the reason it is not.
function Test-RunsServed($r, $label) {
  if ([string]$r.Code -cne "200") { return ($label + " answered " + $r.Code + ", expected 200") }
  $j = Read-JsonBody $r
  if ($null -eq $j) { return ($label + " did not return JSON") }
  $rows = @($j.runs)
  if ($rows.Count -lt 1) { return ($label + " served no run rows, so the model_retry key cannot be shown") }
  foreach ($row in $rows) {
    if (-not (@($row.PSObject.Properties.Name) -ccontains "model_retry")) { return ($label + " has a row with no model_retry key") }
  }
  return ""
}
# "" when the pragma rows for ONE table show the column present with the right type, otherwise the reason it is not. $rows is what `SELECT name, type FROM pragma_table_info('<t>') WHERE name = 'model_retry'` returned.
function Test-RetryColumn($rows, $table) {
  $found = @($rows)
  if ($found.Count -ne 1) { return ($table + " has " + $found.Count + " model_retry column rows, expected exactly 1") }
  if ([string]$found[0].type -cne "TEXT") { return ($table + ".model_retry has type '" + $found[0].type + "', expected TEXT") }
  return ""
}
function Read-D1Json($lines) {
  $txt = ($lines | Out-String)
  $i = $txt.IndexOf("[")
  if ($i -lt 0) { Stop-Here "wrangler d1 returned no JSON: $txt" }
  return ($txt.Substring($i) | ConvertFrom-Json)
}
# Strict READ of a remote D1: a failed or empty query STOPS; nothing reasons from a bad read (an empty result must never read as "absent").
function Invoke-D1Read($db, $sql) {
  # stdout only, no stderr redirect (the proven pattern of scripts/deploy-council.ps1): merging stderr would wrap any wrangler notice in an error record. The exit code is read after.
  $raw = (npx wrangler d1 execute $db --remote --json --command $sql)
  $exit = $LASTEXITCODE
  if ($exit -ne 0) { Stop-Here "wrangler d1 execute failed (exit $exit) on $db for: $sql" }
  $parsed = Read-D1Json $raw
  if ($null -eq $parsed -or @($parsed).Count -lt 1 -or $null -eq $parsed[0].results) { Stop-Here "wrangler d1 returned no results object on $db for: $sql" }
  return @($parsed[0].results)
}
# "absent" when neither table has the column, "applied" when both do; STOPS on the tables missing or on a half-applied state. Reads only.
function Get-RetryState($db) {
  $tableRows = @(Invoke-D1Read $db "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('maintainer_runs', 'concierge_runs')")
  if ($tableRows.Count -ne 2) { Stop-Here ("maintainer_runs and concierge_runs are not both on " + $db + " (found " + $tableRows.Count + " of 2): nothing was changed.") }
  $present = 0
  foreach ($t in $RETRY_TABLES) {
    $colRows = @(Invoke-D1Read $db ("SELECT name, type FROM pragma_table_info('" + $t + "') WHERE name = '" + $RETRY_COLUMN + "'"))
    if ($colRows.Count -gt 0) { $present++ }
  }
  if ($present -eq 0) { return "absent" }
  if ($present -eq 2) { return "applied" }
  Stop-Here ("migration 0022 is half-applied on " + $db + " (model_retry on " + $present + " of 2 tables): do not re-run the file blind (a duplicate ADD COLUMN fails); read the catalogue by hand.")
}
# db-migration-verification: read the catalogue directly, never assume the apply worked. STOPS unless BOTH tables show model_retry with type TEXT.
function Assert-RetryColumns($db) {
  foreach ($t in $RETRY_TABLES) {
    $colRows = @(Invoke-D1Read $db ("SELECT name, type FROM pragma_table_info('" + $t + "') WHERE name = '" + $RETRY_COLUMN + "'"))
    $why = Test-RetryColumn $colRows $t
    if ($why -ne "") { Stop-Here ("catalogue check on " + $db + " failed: " + $why + ".") }
  }
}
# Polls (GETs only) until the served block is this deploy's AND both run endpoints carry the model_retry key, or STOPS (with $ROLLBACK_LINE) after $tries reads.
function Wait-NewWorker($commit, $versionId, $tries, $delaySeconds) {
  $last = "never read"
  for ($n = 1; $n -le $tries; $n++) {
    $why = Test-CodeIdentityServed (Get-ServedCode) $commit $versionId
    if ($why -eq "") { $why = Test-RunsServed (Get-Text $MAINTAINER_RUNS_URL 30) "GET /api/maintainer-runs" }
    if ($why -eq "") {
      Say "[poll] try $n of ${tries}: GET /api/attest serves code.commit $($commit.Substring(0, 8)) and code.version_id $versionId; GET /api/maintainer-runs rows carry model_retry"
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
if ($Rehearse -and $MigrationAlreadyApplied) { Stop-Here "-Rehearse and -MigrationAlreadyApplied together make no sense: -Rehearse applies the file to the scratch database itself." }

# 0. the commit: fetch, then main, origin/main and the expected sha must be ONE commit, on a clean tree
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
# The only migration since the live code is 0022, added (not edited).
$migMoves = @(git diff --name-status --no-renames $LIVE_BASE_COMMIT HEAD -- migrations)
if ($LASTEXITCODE -ne 0) { Stop-Here "git diff failed (exit $LASTEXITCODE): the migration check cannot be read." }
if ($migMoves.Count -ne 1 -or $migMoves[0] -cne ("A`t" + $MIGRATION_PATH_EXPECTED)) { Stop-Here ("expected exactly one added migration (" + $MIGRATION_PATH_EXPECTED + ") since " + $LIVE_BASE_COMMIT.Substring(0, 8) + ", found: " + ($migMoves -join " | ")) }
if (-not (Test-Path $MIGRATION_PATH_EXPECTED)) { Stop-Here "$MIGRATION_PATH_EXPECTED is missing in this checkout." }
# BEGIN-REVIEWED-SOURCE-CHECK
git merge-base --is-ancestor $REVIEWED_COMMIT HEAD
if ($LASTEXITCODE -ne 0) { Stop-Here "HEAD does not contain the reviewed commit $($REVIEWED_COMMIT.Substring(0, 8)): this is not the code that was reviewed." }
$afterReview = @(git diff --name-only --no-renames $REVIEWED_COMMIT HEAD)
if ($LASTEXITCODE -ne 0) { Stop-Here "git diff failed (exit $LASTEXITCODE): the changes since the reviewed commit cannot be read." }
$unreviewed = @(Get-DisallowedPaths $afterReview)
if ($unreviewed.Count -gt 0) { Stop-Here ("these paths changed since the reviewed commit " + $REVIEWED_COMMIT.Substring(0, 8) + " and are not on the allowlist (" + ($ALLOWED_PATHS_AFTER_REVIEW -join ", ") + "), so what would ship is not what was reviewed: " + ($unreviewed -join ", ")) }
Say ("[git] reviewed source: HEAD differs from " + $REVIEWED_COMMIT.Substring(0, 8) + " in " + $afterReview.Count + " path(s), all on the allowlist")
# END-REVIEWED-SOURCE-CHECK
if (-not (Select-String -Path "src/maintainer/anthropic.ts" -Pattern "export const RETRYABLE_STATUSES" -SimpleMatch -Quiet)) { Stop-Here "src/maintainer/anthropic.ts has no RETRYABLE_STATUSES: this checkout is not the model-call retry wave." }
if (-not (Select-String -Path "src/maintainer/runs.ts" -Pattern "model_retry = ?" -SimpleMatch -Quiet)) { Stop-Here "src/maintainer/runs.ts does not write model_retry: this checkout is not the model-call retry wave." }
if (-not (Select-String -Path "src/maintainer/catchup.ts" -Pattern "export async function runCatchup" -SimpleMatch -Quiet)) { Stop-Here "src/maintainer/catchup.ts has no runCatchup: this checkout is not the model-call retry wave." }
if (-not (Select-String -Path "src/governance.ts" -Pattern "export function assertProposalsQuery(" -SimpleMatch -Quiet)) { Stop-Here "src/governance.ts has no assertProposalsQuery: this checkout would drop the proposals unknown-params wave." }
if (-not (Select-String -Path "src/modstate.ts" -Pattern "export function modPlaceholder(" -SimpleMatch -Quiet)) { Stop-Here "src/modstate.ts has no modPlaceholder: this checkout would drop the moderation-gaps wave." }
if (-not (Select-String -Path "src/code-identity.ts" -Pattern "export function codeBlock" -Quiet)) { Stop-Here "src/code-identity.ts has no codeBlock: this checkout would drop served code identity." }
if (-not (Select-String -Path "wrangler.jsonc" -Pattern '"version_metadata"' -Quiet)) { Stop-Here "wrangler.jsonc has no version_metadata binding: the Worker could not serve Cloudflare's version id." }
if (Select-String -Path "wrangler.jsonc" -Pattern '"CODE_COMMIT"' -Quiet) { Stop-Here "wrangler.jsonc configures a CODE_COMMIT var: a deploy that forgot the flag would serve a stale stamp. The stamp comes from this script's --var flag only." }
Say ("[git] HEAD " + $headSha.Substring(0, 8) + " = main = origin/main = -ExpectedCommit; tree clean; contains " + $LIVE_BASE_COMMIT.Substring(0, 8) + "; src/doc.ts unmoved; the one new migration is " + $MIGRATION_PATH_EXPECTED)

# R. -Rehearse: the SAME migration and the SAME pragma check against the scratch D1 ONLY. No tests, no live read, no worker, no prod database name.
# BEGIN-REHEARSE
if ($Rehearse) {
  $scratchState = Get-RetryState $SCRATCH_DB
  Say ("[rehearse] scratch database " + $SCRATCH_DB + ": maintainer_runs and concierge_runs present; model_retry before: " + $scratchState)
  if ($scratchState -ceq "applied") { Stop-Here "model_retry is already on $SCRATCH_DB on both tables: the rehearsal was already done (or the scratch database is not the clean copy it was). Read it by hand." }
  if ($DryRun) {
    Say "[dry-run] would now apply $MIGRATION_PATH_EXPECTED to $SCRATCH_DB and run the pragma_table_info check on both tables. Nothing was written."
    exit 0
  }
  Say "[rehearse] applying $MIGRATION_PATH_EXPECTED to $SCRATCH_DB"
  $ErrorActionPreference = "Continue"
  npx wrangler d1 execute $SCRATCH_DB --remote --file $MIGRATION_PATH_EXPECTED
  $rehearseCode = $LASTEXITCODE
  $ErrorActionPreference = "Stop"
  if ($rehearseCode -ne 0) { Stop-Here "the rehearsal migration failed (exit $rehearseCode) on $SCRATCH_DB. Prod was never touched. Read the scratch catalogue before any retry." }
  Assert-RetryColumns $SCRATCH_DB
  Say ("[rehearse] catalogue-verified on " + $SCRATCH_DB + ": maintainer_runs.model_retry and concierge_runs.model_retry are present, type TEXT. Prod was never touched.")
  exit 0
}
# END-REHEARSE

# 1. the wave's own gates, re-run here so a stale checkout cannot deploy
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

# 2. live, before: non-minting baseline, the live worker is the base this wave was checked against, and the catalogue state of 0022 on prod
$attBefore = Read-Attest "before the deploy"
Assert-Attest $attBefore "before the deploy"
Say ("[live] before: v6 " + $V6_HASH.Substring(0, 8) + "; all four chains ok; identity " + $attBefore.identity_log.sealed_entries + ", treasury " + $attBefore.treasury.sealed_entries + ", ballots " + $attBefore.ballots.sealed_entries)
if ($null -eq $attBefore.code -or [string]$attBefore.code.commit_status -cne "stamped") { Stop-Here "GET /api/attest serves no stamped code.commit before the deploy: the live worker cannot be shown to be the base this wave was checked against." }
if ([string]$attBefore.code.commit -ceq $headSha) { Stop-Here "GET /api/attest already serves code.commit $($headSha.Substring(0, 8)): this commit looks already deployed. Verify by hand." }
if ([string]$attBefore.code.commit -cne $LIVE_BASE_COMMIT) { Stop-Here ("the live worker serves code.commit " + $attBefore.code.commit + " but `$LIVE_BASE_COMMIT is " + $LIVE_BASE_COMMIT + ": the base this wave was checked against is not what is live. Correct the pin only after reading what changed.") }
$rollbackTarget = "the version before it (check npx wrangler deployments list)"
if ([string]$attBefore.code.version_status -ceq "available" -and $attBefore.code.version_id) { $rollbackTarget = [string]$attBefore.code.version_id }
Say "[live] before: the live worker serves the pinned base $($LIVE_BASE_COMMIT.Substring(0, 8)); rollback target $rollbackTarget"
$migrationState = Get-RetryState $PROD_DB
if ($migrationState -ceq "applied" -and -not $MigrationAlreadyApplied) { Stop-Here "migration 0022 is already on prod. If an earlier run applied it, re-run with -MigrationAlreadyApplied (the catalogue is still verified)." }
if ($migrationState -ceq "absent" -and $MigrationAlreadyApplied) { Stop-Here "-MigrationAlreadyApplied was given but migration 0022 is not on prod." }
Say ("[d1] maintainer_runs and concierge_runs present on prod; migration 0022 on prod before: " + $migrationState)

if ($DryRun) {
  Say "[dry-run] would now: apply $MIGRATION_PATH_EXPECTED to the REMOTE D1 (skipped if -MigrationAlreadyApplied); verify with pragma_table_info that BOTH maintainer_runs and concierge_runs carry model_retry of type TEXT (STOP otherwise); run npx wrangler deploy --var CODE_COMMIT:<the full sha> and capture its Current Version ID (refusing to continue without one); poll up to $POLL_TRIES times, $POLL_DELAY_SECONDS s apart, until GET /api/attest serves that commit and version id and the maintainer-runs rows carry model_retry; then ride the public reads. Nothing was written to the remote and nothing was deployed."
  exit 0
}

# 3. migration 0022 to the REMOTE D1 FIRST (additive; applied only when the catalogue read above found it absent)
# BEGIN-MIGRATION
if (-not $MigrationAlreadyApplied) {
  Say "[d1] applying $MIGRATION_PATH_EXPECTED to the remote database"
  $ErrorActionPreference = "Continue"
  npx wrangler d1 execute $PROD_DB --remote --file $MIGRATION_PATH_EXPECTED
  $migCode = $LASTEXITCODE
  $ErrorActionPreference = "Stop"
  if ($migCode -ne 0) { Stop-Here "migration 0022 failed (exit $migCode); nothing deployed; re-read the catalogue before any retry (do NOT re-run the file blind: a duplicate ADD COLUMN fails and a partly applied file leaves one table changed)." }
}

# 3b. catalogue verification (db-migration-verification): read the catalogue directly; the worker deploys only if BOTH tables carry the column
Assert-RetryColumns $PROD_DB
Say "[d1] catalogue-verified on prod: maintainer_runs.model_retry and concierge_runs.model_retry present, type TEXT"
# END-MIGRATION

# 4. deploy the worker with the commit stamp, capturing its version id, then poll until the served identity is this deploy's
# BEGIN-DEPLOY-AND-POLL
# Tests, typecheck and the live reads ran since step 0, and wrangler bundles the working tree, so HEAD and a clean
# tree are re-read here, immediately before the bundle, or the stamp could name a commit the uploaded bytes no longer match.
$headNow = (git rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $headNow -cne $headSha) { Stop-Here ("HEAD moved since step 0 (" + $headSha.Substring(0, 8) + " -> " + $headNow + "): nothing was deployed. Migration 0022 is applied and harmless to the old worker; re-run with -MigrationAlreadyApplied.") }
$dirtyNow = @(git status --porcelain)
if ($LASTEXITCODE -ne 0) { Stop-Here "git status failed (exit $LASTEXITCODE) just before the deploy: nothing was deployed." }
if ($dirtyNow.Count -gt 0) { Stop-Here ("the working tree changed since step 0 (" + $dirtyNow.Count + " paths: " + ($dirtyNow -join " | ") + "): nothing was deployed. Migration 0022 is applied and harmless to the old worker; re-run with -MigrationAlreadyApplied.") }
Say "[deploy] npx wrangler deploy --var CODE_COMMIT:$($headSha.Substring(0, 8))... (commit $($headSha.Substring(0, 8)))"
$ErrorActionPreference = "Continue"
$deployOut = (npx wrangler deploy --var "CODE_COMMIT:$headSha" 2>&1 | Out-String)
$deployCode = $LASTEXITCODE
$ErrorActionPreference = "Stop"
if ($deployCode -ne 0) { Stop-Here "wrangler deploy failed (exit $deployCode); migration 0022 is applied and harmless to the old worker. Re-run with -MigrationAlreadyApplied. Output: $deployOut" }
$versionMatches = @([regex]::Matches($deployOut, '(?m)^[ \t]*Current Version ID:[ \t]*([0-9a-fA-F-]{36})[ \t]*\r?$'))
if ($versionMatches.Count -gt 1) { Stop-Here ("wrangler deploy printed 'Current Version ID' on " + $versionMatches.Count + " lines; which one is this deploy's cannot be told. Check 'npx wrangler deployments list' by hand before anything else.") }
if ($versionMatches.Count -lt 1) { Stop-Here "wrangler deploy exited 0 but printed no 'Current Version ID'; the deploy may have succeeded. Check 'npx wrangler deployments list' by hand before anything else." }
$versionId = $versionMatches[0].Groups[1].Value
Say "[deploy] worker version id $versionId (commit $($headSha.Substring(0, 8)))"
$ROLLBACK_LINE = "ROLL BACK THE WORKER (npx wrangler rollback, to the version before $versionId, which should be $rollbackTarget; check npx wrangler deployments list first). Migration 0022 can stay: it is two nullable ADD COLUMNs and the old worker reads SELECT * and writes explicit column lists."
Wait-NewWorker $headSha $versionId $POLL_TRIES $POLL_DELAY_SECONDS
# END-DEPLOY-AND-POLL

# 5. the ride: non-minting and the chains, the code identity, both run endpoints carrying model_retry, then a sweep of public reads. Public GETs only.
$attAfter = Read-Attest "after the deploy"
Assert-Attest $attAfter "after the deploy"
$why = Test-CodeIdentityServed $attAfter.code $headSha $versionId
if ($why -ne "") { Stop-Here "after the poll, ${why}: another deploy may have taken over. Check npx wrangler deployments list by hand." }
Say ("[ride] attest: v6 " + $V6_HASH.Substring(0, 8) + " unchanged; every chain ok; code.commit " + ([string]$attAfter.code.commit).Substring(0, 8) + ", code.version_id " + $attAfter.code.version_id)
$maintainerNow = Get-Text $MAINTAINER_RUNS_URL 30
$why = Test-RunsServed $maintainerNow "GET /api/maintainer-runs"
if ($why -ne "") { Stop-Here "$why. $ROLLBACK_LINE" }
Say ("[ride] GET /api/maintainer-runs -> 200, " + @((Read-JsonBody $maintainerNow).runs).Count + " rows, every row carries model_retry")
$conciergeNow = Get-Text $CONCIERGE_RUNS_URL 30
$why = Test-RunsServed $conciergeNow "GET /api/concierge-runs"
if ($why -ne "") { Stop-Here "$why. $ROLLBACK_LINE" }
Say ("[ride] GET /api/concierge-runs -> 200, " + @((Read-JsonBody $conciergeNow).runs).Count + " rows, every row carries model_retry")
$bad = @()
foreach ($p in "/", "/api/official", "/openapi.json", "/treasury", "/api/listings", "/api/stats", "/api/topics", "/api/guest/due", "/api/citizens", "/api/proposals", "/llms.txt", "/privacy") {
  $r = Get-Text "$BASE$p" 30
  if ($r.Code -ne "200") { $bad += "$p=$($r.Code)" }
}
if ($bad.Count -gt 0) { Stop-Here ("non-200 after the deploy (version $versionId): " + ($bad -join ", ") + ". If a read that answered before now fails: $ROLLBACK_LINE") }
Say "[ride] 12 public reads -> 200"
Say '[note] This ride made GET requests only. The catch-up crons are NOT registered by this deploy (gate C2). Gate C3: read the 1 Nov 06:00 clerk and 07:00 judgment rows (finished_at set) and the first real failure''s model_retry.'
Say "[done] model-call retry wave deployed and ridden. Log version id $versionId, commit $($headSha.Substring(0, 8)) and these lines in HANDOVER.md."
