# Deploys the 30 OCT PROPOSALS UNKNOWN-PARAMS WAVE (D-078 item 2): GET /api/proposals refuses an unknown query parameter with 400 (code unknown_query_parameter) and a repeated known one with 400
# (code repeated_query_parameter), instead of silently ignoring a filter the caller expected; the MCP proposals tool refuses unknown arguments. Spec: docs/BRIEF-PROPOSALS-UNKNOWN-PARAMS.md; gate record
# docs/REVIEW-PROPOSALS-UNKNOWN-PARAMS-GATE-2026-10-30.md (DEPLOYABLE).
# ONE worker deploy. Ben's hand only (D-017). One fail-fast script (L-046, L-069). NO MIGRATION, NO D1 COMMAND, NO MINT: step 0 STOPS if migrations/, schema.sql or src/doc.ts differ between the live
# base and HEAD. Wrangler is used for exactly ONE thing: the stamped deploy. Pattern: scripts/deploy-proposals-unknown-params.ps1 (this ride makes GET requests only).
# TWO PINS. $LIVE_BASE_COMMIT is the commit the live worker serves when this runs (the moderation-gaps wave, 83632cb0, worker b1329921); step 2 PROVES it against the live GET /api/attest code.commit.
# $REVIEWED_COMMIT is the commit the review converged on. Step 0a STOPS, before any git or network command, while EITHER still holds its placeholder or is not 40 lower-case hex.
# THE DEPLOY STAMPS THE COMMIT: `npx wrangler deploy --var CODE_COMMIT:<sha>`. The poll waits until GET /api/attest serves code.commit equal to the pinned sha AND code.version_id equal to the
# Current Version ID wrangler printed AND GET /api/proposals?status=open answers 400 unknown_query_parameter naming status.
# The ROLLBACK TARGET is the version id GET /api/attest served BEFORE the deploy (read live, never typed in).
# REVIEWED SOURCE ONLY: step 0 also STOPS unless HEAD is $REVIEWED_COMMIT plus changes confined to $ALLOWED_PATHS_AFTER_REVIEW (this script, its test, docs/).
# Run from society/ on main, after the merge and the push:
#   cd "C:\Users\bengr\Projects\AI domain and social network\society"
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-proposals-unknown-params.ps1 -ExpectedCommit <sha> -DryRun   # every check and the live reads, nothing deployed
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-proposals-unknown-params.ps1 -ExpectedCommit <sha>           # the real thing
# <sha> is the pushed tip of main (git -C society rev-parse HEAD), the full 40 hex.
# THE RIDE holds no token, key or assertion and writes nothing: public GETs only.
# PowerShell 5.1 traps this file avoids: one spelling per variable name; -notmatch on an array filters instead of testing; a one-element return is wrapped in @(); "$var:" is a drive reference
# (write "${var}:"); never merge a native command's stderr under ErrorActionPreference Stop; -eq and -ne are case-INSENSITIVE (hashes and shas are compared with -ceq / -cne); PS 5.1 strips
# inner double quotes from a native command's argument, so this script sends no request body at all. ASCII only.
param(
  [Parameter(Mandatory = $true)][string]$ExpectedCommit,
  [switch]$DryRun
)
$ErrorActionPreference = "Stop"
$BASE = "https://commonhold.randommonicle.workers.dev"
# The attested constitution this wave must leave untouched (v6, minted 22 Oct).
$V6_HASH = "dc5f48213c29bcf844e0fbe7daf1bdb5416b3d57fbd06a8bd03f1061f34092b3"
# The commit the live worker serves when this runs (the moderation-gaps wave, 83632cb0).
$LIVE_BASE_COMMIT = "83632cb0b70a5b685ceee87236fd7a89a871a276"
$LIVE_BASE_PLACEHOLDER = "TO-BE-SET-BY-HUB-LIVE-BASE"
# THE REVIEWED SOURCE. The hub replaces this placeholder with the full sha the review converged on; step 0 STOPS while it is unchanged, and while it is not 40 lower-case hex.
$REVIEWED_COMMIT = "db5566d40be30ae37f429b75b8ac6407b09fb80d"
$REVIEWED_COMMIT_PLACEHOLDER = "TO-BE-SET-BY-HUB"
$ALLOWED_PATHS_AFTER_REVIEW = @("scripts/deploy-proposals-unknown-params.ps1", "test/deploy-proposals-unknown-params-script.test.ts", "docs/")
$PROPOSALS_URL = "$BASE/api/proposals"
$PROPOSALS_STATUS_URL = "$BASE/api/proposals?status=open"
$PROPOSALS_REPEAT_URL = "$BASE/api/proposals?since=1&since=2"
$POLL_TRIES = 12
$POLL_DELAY_SECONDS = 5
# The served note the plain list carries once this wave is live.
$PROPOSALS_NOTE_MARKER = "Only since and since_id are accepted"

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
# "" when $r is the 400 GET /api/proposals?status=open must now answer (JSON code exactly unknown_query_parameter, the error naming status), otherwise the reason it is not. Case-sensitive.
function Test-UnknownParamRefused($r) {
  if ([string]$r.Code -cne "400") { return ("GET /api/proposals?status=open answered " + $r.Code + ", expected 400") }
  $j = Read-JsonBody $r
  if ($null -eq $j) { return "GET /api/proposals?status=open answered 400 but not with a JSON body" }
  if ([string]$j.code -cne "unknown_query_parameter") { return ("the 400 carries code '" + $j.code + "', expected unknown_query_parameter") }
  if (-not ([string]$j.error).Contains("status")) { return "the 400 error text does not name the refused parameter 'status'" }
  return ""
}
# "" when $r is the 400 GET /api/proposals?since=1&since=2 must answer (JSON code exactly repeated_query_parameter), otherwise the reason it is not.
function Test-RepeatedParamRefused($r) {
  if ([string]$r.Code -cne "400") { return ("GET /api/proposals?since=1&since=2 answered " + $r.Code + ", expected 400") }
  $j = Read-JsonBody $r
  if ($null -eq $j) { return "GET /api/proposals?since=1&since=2 answered 400 but not with a JSON body" }
  if ([string]$j.code -cne "repeated_query_parameter") { return ("the 400 carries code '" + $j.code + "', expected repeated_query_parameter") }
  return ""
}
# "" when $r is the plain list answering 200 with this wave's note, otherwise the reason it is not.
function Test-ProposalsPlainServed($r) {
  if ([string]$r.Code -cne "200") { return ("GET /api/proposals answered " + $r.Code + ", expected 200") }
  $j = Read-JsonBody $r
  if ($null -eq $j) { return "GET /api/proposals did not return JSON" }
  if (-not ([string]$j.note).Contains($PROPOSALS_NOTE_MARKER)) { return "GET /api/proposals note does not contain '$PROPOSALS_NOTE_MARKER'" }
  return ""
}
# Polls (GETs only) until the served block is this deploy's AND GET /api/proposals?status=open is refused, or STOPS (with $ROLLBACK_LINE) after $tries reads.
function Wait-NewWorker($commit, $versionId, $tries, $delaySeconds) {
  $last = "never read"
  for ($n = 1; $n -le $tries; $n++) {
    $why = Test-CodeIdentityServed (Get-ServedCode) $commit $versionId
    if ($why -eq "") { $why = Test-UnknownParamRefused (Get-Text $PROPOSALS_STATUS_URL 30) }
    if ($why -eq "") {
      Say "[poll] try $n of ${tries}: GET /api/attest serves code.commit $($commit.Substring(0, 8)) and code.version_id $versionId; GET /api/proposals?status=open answers 400 unknown_query_parameter"
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
# Non-minting, no migration: src/doc.ts (which holds FRONT_DOOR_TEMPLATE), migrations/ and schema.sql must not have moved since the live code.
$moves = @(git diff --name-status --no-renames $LIVE_BASE_COMMIT HEAD -- src/doc.ts migrations schema.sql)
if ($LASTEXITCODE -ne 0) { Stop-Here "git diff failed (exit $LASTEXITCODE): the no-mint and no-migration check cannot be read." }
if ($moves.Count -gt 0) { Stop-Here ("src/doc.ts, migrations/ or schema.sql changed since " + $LIVE_BASE_COMMIT.Substring(0, 8) + " (" + ($moves -join " | ") + "): this wave mints nothing and has no migration. Not this script's deploy.") }
# BEGIN-REVIEWED-SOURCE-CHECK
git merge-base --is-ancestor $REVIEWED_COMMIT HEAD
if ($LASTEXITCODE -ne 0) { Stop-Here "HEAD does not contain the reviewed commit $($REVIEWED_COMMIT.Substring(0, 8)): this is not the code that was reviewed." }
$afterReview = @(git diff --name-only --no-renames $REVIEWED_COMMIT HEAD)
if ($LASTEXITCODE -ne 0) { Stop-Here "git diff failed (exit $LASTEXITCODE): the changes since the reviewed commit cannot be read." }
$unreviewed = @(Get-DisallowedPaths $afterReview)
if ($unreviewed.Count -gt 0) { Stop-Here ("these paths changed since the reviewed commit " + $REVIEWED_COMMIT.Substring(0, 8) + " and are not on the allowlist (" + ($ALLOWED_PATHS_AFTER_REVIEW -join ", ") + "), so what would ship is not what was reviewed: " + ($unreviewed -join ", ")) }
Say ("[git] reviewed source: HEAD differs from " + $REVIEWED_COMMIT.Substring(0, 8) + " in " + $afterReview.Count + " path(s), all on the allowlist")
# END-REVIEWED-SOURCE-CHECK
if (-not (Select-String -Path "src/governance.ts" -Pattern "export function assertProposalsQuery(" -SimpleMatch -Quiet)) { Stop-Here "src/governance.ts has no assertProposalsQuery: this checkout is not the proposals unknown-params wave." }
if (-not (Select-String -Path "src/index.ts" -Pattern "assertProposalsQuery(url.searchParams)" -SimpleMatch -Quiet)) { Stop-Here "src/index.ts does not call assertProposalsQuery(url.searchParams): the route would not refuse unknown parameters." }
if (-not (Select-String -Path "src/modstate.ts" -Pattern "export function modPlaceholder(" -SimpleMatch -Quiet)) { Stop-Here "src/modstate.ts has no modPlaceholder: this checkout would drop the moderation-gaps wave." }
if (-not (Select-String -Path "src/governance.ts" -Pattern "SELECT seq FROM sqlite_sequence WHERE name = 'proposals'" -SimpleMatch -Quiet)) { Stop-Here "src/governance.ts does not read sqlite_sequence for proposals: this checkout is not the high-water wave." }
if (-not (Select-String -Path "src/governance.ts" -Pattern 'PROPOSALS_SEQUENCE_BASELINE = { migration: "0007_first_laws", applied: "2026-08-18" }' -SimpleMatch -Quiet)) { Stop-Here "src/governance.ts does not carry the 0007 baseline: this checkout is not the note-epoch wave." }
if (-not (Select-String -Path "src/governance.ts" -Pattern "MAX(id) AS max_id," -SimpleMatch -Quiet)) { Stop-Here "src/governance.ts does not read MAX(id) AS max_id: this checkout would drop the max_id wave." }
if (-not (Select-String -Path "src/mcp.ts" -Pattern "Register as a citizen" -SimpleMatch -Quiet)) { Stop-Here "src/mcp.ts has no register free-path title: this checkout would drop the register free-path wave." }
if (-not (Select-String -Path "src/privacy.ts" -Pattern "export async function handlePrivacy" -Quiet)) { Stop-Here "src/privacy.ts has no handlePrivacy: this checkout would drop the privacy page." }
if (-not (Select-String -Path "src/code-identity.ts" -Pattern "export function codeBlock" -Quiet)) { Stop-Here "src/code-identity.ts has no codeBlock: this checkout would drop served code identity." }
if (-not (Select-String -Path "wrangler.jsonc" -Pattern '"version_metadata"' -Quiet)) { Stop-Here "wrangler.jsonc has no version_metadata binding: the Worker could not serve Cloudflare's version id." }
if (Select-String -Path "wrangler.jsonc" -Pattern '"CODE_COMMIT"' -Quiet) { Stop-Here "wrangler.jsonc configures a CODE_COMMIT var: a deploy that forgot the flag would serve a stale stamp. The stamp comes from this script's --var flag only." }
Say ("[git] HEAD " + $headSha.Substring(0, 8) + " = main = origin/main = -ExpectedCommit; tree clean; contains " + $LIVE_BASE_COMMIT.Substring(0, 8) + "; src/doc.ts, migrations and schema.sql unmoved")

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

# 2. live, before: non-minting baseline, the live worker is the base this wave was checked against, and ?status=open still answers 200 (so the propagation poll proves something)
$attBefore = Read-Attest "before the deploy"
Assert-Attest $attBefore "before the deploy"
Say ("[live] before: v6 " + $V6_HASH.Substring(0, 8) + "; all four chains ok; identity " + $attBefore.identity_log.sealed_entries + ", treasury " + $attBefore.treasury.sealed_entries + ", ballots " + $attBefore.ballots.sealed_entries)
if ($null -eq $attBefore.code -or [string]$attBefore.code.commit_status -cne "stamped") { Stop-Here "GET /api/attest serves no stamped code.commit before the deploy: the live worker cannot be shown to be the base this wave was checked against." }
if ([string]$attBefore.code.commit -ceq $headSha) { Stop-Here "GET /api/attest already serves code.commit $($headSha.Substring(0, 8)): this commit looks already deployed. Verify by hand." }
if ([string]$attBefore.code.commit -cne $LIVE_BASE_COMMIT) { Stop-Here ("the live worker serves code.commit " + $attBefore.code.commit + " but `$LIVE_BASE_COMMIT is " + $LIVE_BASE_COMMIT + ": the base this wave was checked against is not what is live. Correct the pin only after reading what changed.") }
$rollbackTarget = "the version before it (check npx wrangler deployments list)"
if ([string]$attBefore.code.version_status -ceq "available" -and $attBefore.code.version_id) { $rollbackTarget = [string]$attBefore.code.version_id }
Say "[live] before: the live worker serves the pinned base $($LIVE_BASE_COMMIT.Substring(0, 8)); rollback target $rollbackTarget"
$proposalsBefore = Get-Text $PROPOSALS_STATUS_URL 30
if ([string]$proposalsBefore.Code -ceq "400" -and [string](Read-JsonBody $proposalsBefore).code -ceq "unknown_query_parameter") { Stop-Here "GET /api/proposals?status=open already answers 400 unknown_query_parameter: this looks already deployed, verify by hand." }
if ([string]$proposalsBefore.Code -cne "200") { Stop-Here "GET /api/proposals?status=open answered $($proposalsBefore.Code) before the deploy, expected 200 (the old behaviour silently ignored it): the live worker is not the base this wave was checked against. Read it by hand." }
Say "[live] before: GET /api/proposals?status=open answers 200 (the unknown parameter is still silently ignored)"

if ($DryRun) {
  Say "[dry-run] would now: run npx wrangler deploy --var CODE_COMMIT:<the full sha> and capture its Current Version ID (refusing to continue without one); poll up to $POLL_TRIES times, $POLL_DELAY_SECONDS s apart, until GET /api/attest serves that commit and version id and GET /api/proposals?status=open answers 400 unknown_query_parameter; then ride the public reads. Nothing was deployed."
  exit 0
}

# 3. deploy the worker with the commit stamp, capturing its version id, then poll until the served identity is this deploy's
# BEGIN-DEPLOY-AND-POLL
Say "[deploy] npx wrangler deploy --var CODE_COMMIT:$($headSha.Substring(0, 8))... (commit $($headSha.Substring(0, 8)))"
$ErrorActionPreference = "Continue"
$deployOut = (npx wrangler deploy --var "CODE_COMMIT:$headSha" 2>&1 | Out-String)
$deployCode = $LASTEXITCODE
$ErrorActionPreference = "Stop"
if ($deployCode -ne 0) { Stop-Here "wrangler deploy failed (exit $deployCode); this wave applied no migration, so there is nothing else to undo. Output: $deployOut" }
$versionMatches = @([regex]::Matches($deployOut, '(?m)^[ \t]*Current Version ID:[ \t]*([0-9a-fA-F-]{36})[ \t]*\r?$'))
if ($versionMatches.Count -gt 1) { Stop-Here ("wrangler deploy printed 'Current Version ID' on " + $versionMatches.Count + " lines; which one is this deploy's cannot be told. Check 'npx wrangler deployments list' by hand before anything else.") }
if ($versionMatches.Count -lt 1) { Stop-Here "wrangler deploy exited 0 but printed no 'Current Version ID'; the deploy may have succeeded. Check 'npx wrangler deployments list' by hand before anything else." }
$versionId = $versionMatches[0].Groups[1].Value
Say "[deploy] worker version id $versionId (commit $($headSha.Substring(0, 8)))"
$ROLLBACK_LINE = "ROLL BACK THE WORKER (npx wrangler rollback, to the version before $versionId, which should be $rollbackTarget; check npx wrangler deployments list first). This wave applied no migration, so the rollback is the whole undo."
Wait-NewWorker $headSha $versionId $POLL_TRIES $POLL_DELAY_SECONDS
# END-DEPLOY-AND-POLL
# 4. the ride: non-minting and the chains, the refusals and the plain list served, then a sweep of public reads.
$attAfter = Read-Attest "after the deploy"
Assert-Attest $attAfter "after the deploy"
Say ("[ride] attest: v6 " + $V6_HASH.Substring(0, 8) + " unchanged; every chain ok; code.commit " + ([string]$attAfter.code.commit).Substring(0, 8) + ", code.version_id " + $attAfter.code.version_id)
$unknownNow = Get-Text $PROPOSALS_STATUS_URL 30
$why = Test-UnknownParamRefused $unknownNow
if ($why -ne "") { Stop-Here "$why. $ROLLBACK_LINE" }
Say ("[ride] GET /api/proposals?status=open -> 400 " + (Read-JsonBody $unknownNow).code + ": " + (Read-JsonBody $unknownNow).error)
$repeatNow = Get-Text $PROPOSALS_REPEAT_URL 30
$why = Test-RepeatedParamRefused $repeatNow
if ($why -ne "") { Stop-Here "$why. $ROLLBACK_LINE" }
Say "[ride] GET /api/proposals?since=1&since=2 -> 400 repeated_query_parameter"
$plainNow = Get-Text $PROPOSALS_URL 30
$why = Test-ProposalsPlainServed $plainNow
if ($why -ne "") { Stop-Here "$why. $ROLLBACK_LINE" }
Say "[ride] GET /api/proposals -> 200 and its note says '$PROPOSALS_NOTE_MARKER'"
$bad = @()
foreach ($p in "/", "/api/official", "/openapi.json", "/treasury", "/api/listings", "/api/stats", "/api/topics", "/api/guest/due", "/api/citizens", "/api/doors", "/api/council", "/api/residents", "/heartbeat.md", "/skill.md", "/llms.txt", "/privacy", "/api/proposal/8") {
  $r = Get-Text "$BASE$p" 30
  if ($r.Code -ne "200") { $bad += "$p=$($r.Code)" }
}
if ($bad.Count -gt 0) { Stop-Here ("non-200 after the deploy (version $versionId): " + ($bad -join ", ") + ". If a read that answered before now fails: $ROLLBACK_LINE") }
Say "[ride] 17 public reads -> 200"
Say "[note] This ride made GET requests only: it wrote nothing. The proposals MCP tool refusal is not ridden here: call the proposals tool with {"status":"open"} on /mcp/read once by hand; it should return isError."
Say "[done] proposals unknown-params wave deployed and ridden. Log version id $versionId, commit $($headSha.Substring(0, 8)) and these lines in HANDOVER.md."
