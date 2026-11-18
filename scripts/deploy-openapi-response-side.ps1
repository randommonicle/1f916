# Deploys the 18 NOV OPENAPI RESPONSE-SIDE WAVE (D-086, option A): GET /openapi.json states what each parameter a handler clamps or ignores does (x-clamped, x-ignored-when-invalid, from the one
# UNVALIDATED table), declares the three row-id path parameters as the digits pattern the router enforces, and declares 200 schemas whose cursor fields carry their parameter's pattern
# (residents, council thread, settlements attention, guest thread, guest inbox, guest due, citizen inbox). SCHEMA AND TEXT ONLY: no served value changes. Brief: drafts/BRIEF-OPENAPI-RESPONSE-SIDE-2026-11-18.md.
# ONE worker deploy. Ben's hand only (D-017). One fail-fast script (L-046, L-069). NO MIGRATION, NO D1 COMMAND, NO MINT: step 0 STOPS if migrations/, schema.sql or src/doc.ts differ between the live
# base and HEAD. Wrangler is used for exactly ONE thing: the stamped deploy. Derived mechanically from deploy-openapi-request-side.ps1 (same shape of wave: a schema-only worker deploy).
# TWO PINS. $LIVE_BASE_COMMIT is the commit the live worker serves when this runs (3a5dd18d: the request-side wave); step 2 PROVES it against the live GET /api/attest code.commit. main and origin
# may sit on a script-only commit above it, which is fine: the no-mint and no-migration check reads src/doc.ts, migrations/ and schema.sql only.
# $REVIEWED_COMMIT is the commit the review converged on, a placeholder until the hub sets it. Step 0a STOPS, before any git or network command, while EITHER still holds its placeholder or is not 40 lower-case hex.
# THE DEPLOY STAMPS THE COMMIT: `npx wrangler deploy --var CODE_COMMIT:<sha>`. The poll waits until GET /api/attest serves code.commit equal to the pinned sha AND code.version_id equal to the
# Current Version ID wrangler printed AND GET /openapi.json declares what THIS wave serves (Test-ResponseSideServed: x-clamped on /api/search limit, x-ignored-when-invalid on /api/attest from, the digits
# pattern on /api/post/{id} id, and the cursor pattern on the 200 next_cursor of /api/residents and /api/council/thread, and the /api/inbox cursor pattern holding the largest safe cursor; all absent before this deploy, checked in step 2).
# L-167: EVERY READ AFTER THE DEPLOY IS RETRIED. A single read straight after a write is "not yet seen", never "failed". The poll and every ride check need $GOOD_READS_NEEDED consecutive good reads,
# within a bounded number of tries, before they judge; no stop message names a rollback until those retries have run out, and even then it says to read the deployments list first.
# The ROLLBACK TARGET is the version id GET /api/attest served BEFORE the deploy (read live, never typed in). The wave is rollback-safe: no schema change.
# REVIEWED SOURCE ONLY: step 0 also STOPS unless HEAD is $REVIEWED_COMMIT plus changes confined to $ALLOWED_PATHS_AFTER_REVIEW (this script, its test, docs/).
# Run from society/ on main, after the merge and the push:
#   cd "C:\Users\bengr\Projects\AI domain and social network\society"
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-openapi-response-side.ps1 -ExpectedCommit <sha> -DryRun   # every check and the live reads, nothing deployed
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-openapi-response-side.ps1 -ExpectedCommit <sha>           # the real thing
# <sha> is the pushed tip of main (git -C society rev-parse HEAD), the full 40 hex.
# THE RIDE holds no token, key or assertion and sends no request body: public GETs only.
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
# The commit the live worker serves when this runs.
$LIVE_BASE_COMMIT = "3a5dd18df9a623325bfb1d569b956747700b11f2"
$LIVE_BASE_PLACEHOLDER = "TO-BE-SET-BY-HUB-LIVE-BASE"
# THE REVIEWED SOURCE. The hub replaces this placeholder with the full sha the review converged on; step 0 STOPS while it is unchanged, and while it is not 40 lower-case hex.
$REVIEWED_COMMIT = "54c80faa7d7dc035577ace30b00e6dd345907f33"
$REVIEWED_COMMIT_PLACEHOLDER = "TO-BE-SET-BY-HUB"
$ALLOWED_PATHS_AFTER_REVIEW = @("scripts/deploy-openapi-response-side.ps1", "test/deploy-openapi-response-side-script.test.ts", "docs/")
$RUNS_URL = "$BASE/openapi.json"
$POLL_TRIES = 24
$POLL_DELAY_SECONDS = 5
# L-167: consecutive good reads before any post-deploy check judges, and the bounded tries it gets to find them.
$GOOD_READS_NEEDED = 3
$RIDE_TRIES = 12
$RIDE_DELAY_SECONDS = 5

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
# "" when $att is the non-minting, all-chains-ok baseline, otherwise the reason it is not. Never stops: the caller decides (before the deploy it stops, after it retries).
function Get-AttestReason($att) {
  if ($null -eq $att -or $null -eq $att.constitution -or -not $att.constitution.template_hash) { return "GET /api/attest was unreadable (this is NOT a minting signal)" }
  if ([string]$att.constitution.version -ne "6") { return ("constitution is version " + $att.constitution.version + ", expected 6: investigate before anything else") }
  if ($att.constitution.template_hash -cne $V6_HASH) { return ("template_hash is " + $att.constitution.template_hash + ", expected v6 " + $V6_HASH + ": investigate before anything else (this wave mints nothing)") }
  if ($att.ok -ne $true) { return ("GET /api/attest ok is '" + $att.ok + "', expected true") }
  foreach ($chain in "identity_log", "treasury", "payouts", "ballots") {
    if ($att.$chain.ok -ne $true) { return ("chain " + $chain + " ok is '" + $att.$chain.ok + "', expected true: investigate") }
  }
  return ""
}
function Assert-Attest($att, $when) {
  $why = Get-AttestReason $att
  if ($why -ne "") { Stop-Here "$why ($when)." }
}
# The parsed GET /api/attest answer, or $null when the read fails. Never stops.
function Get-ServedAttest {
  $r = Get-Text "$BASE/api/attest" 30
  if ($r.Code -ne "200") { return $null }
  try { return ($r.Body | ConvertFrom-Json) } catch { return $null }
}
# The `code` block GET /api/attest serves now, or $null when the read fails or carries none. Never stops: the poll decides.
function Get-ServedCode {
  $served = Get-ServedAttest
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
# The one parameter named $name on GET $path of the parsed document, or $null when there is not exactly one.
function Get-DocParam($j, $path, $name) {
  $op = $j.paths.$path.get
  if ($null -eq $op) { return $null }
  $hit = @($op.parameters | Where-Object { $_.name -ceq $name })
  if ($hit.Count -ne 1) { return $null }
  return $hit[0]
}
# "" when $r is GET /openapi.json answering 200 with JSON that declares what THIS wave serves, otherwise the reason it is not: x-clamped on /api/search limit; x-ignored-when-invalid on /api/attest
# from; the digits pattern on /api/post/{id} id; and, on /api/residents and /api/council/thread, a 200 next_cursor carrying the same pattern as the after parameter (which is itself the digits cursor).
# Case-sensitive. A quick propagation check of a few facts, not a whole-document comparison (the whole document is proven by test/openapi-response-side-d1.test.ts, which ran in step 1).
# The FIRST reason a worker from before this wave returns is the x-clamped one: step 2 accepts only that.
function Test-ResponseSideServed($r) {
  if ([string]$r.Code -cne "200") { return ("GET /openapi.json answered " + $r.Code + ", expected 200") }
  $j = Read-JsonBody $r
  if ($null -eq $j) { return "GET /openapi.json did not return JSON" }
  $lim = Get-DocParam $j "/api/search" "limit"
  if ($null -eq $lim) { return "GET /openapi.json declares no limit parameter on /api/search" }
  if ($null -eq $lim.schema.'x-clamped') { return "the /api/search limit parameter carries no x-clamped" }
  $frm = Get-DocParam $j "/api/attest" "from"
  if ($null -eq $frm) { return "GET /openapi.json declares no from parameter on /api/attest" }
  if ($null -eq $frm.schema.'x-ignored-when-invalid') { return "the /api/attest from parameter carries no x-ignored-when-invalid" }
  $pid1 = Get-DocParam $j "/api/post/{id}" "id"
  if ($null -eq $pid1) { return "GET /openapi.json declares no id parameter on /api/post/{id}" }
  if ([string]$pid1.schema.pattern -cne '^[0-9]+$') { return ("the /api/post/{id} id pattern is '" + $pid1.schema.pattern + "', expected ^[0-9]+$") }
  foreach ($cursorRoute in "/api/residents", "/api/council/thread") {
    $afterParam = Get-DocParam $j $cursorRoute "after"
    if ($null -eq $afterParam) { return ("the " + $cursorRoute + " route declares no after query parameter") }
    if ([string]$afterParam.schema.pattern -cne '^[0-9]{1,15}$') { return ("the " + $cursorRoute + " after pattern is '" + $afterParam.schema.pattern + "', expected ^[0-9]{1,15}$") }
    $nextField = $j.paths.$cursorRoute.get.responses.'200'.content.'application/json'.schema.properties.next_cursor
    if ($null -eq $nextField) { return ("the " + $cursorRoute + " 200 declares no next_cursor") }
    if ([string]$nextField.pattern -cne [string]$afterParam.schema.pattern) { return ("the " + $cursorRoute + " 200 next_cursor pattern is '" + $nextField.pattern + "', expected the after pattern " + $afterParam.schema.pattern) }
  }
  $inboxParam = Get-DocParam $j "/api/inbox" "cursor"
  if ($null -eq $inboxParam) { return "GET /openapi.json declares no cursor parameter on /api/inbox" }
  $inboxNext = $j.paths.'/api/inbox'.get.responses.'200'.content.'application/json'.schema.properties.next_cursor
  if ($null -eq $inboxNext) { return "the /api/inbox 200 declares no next_cursor" }
  if ([string]$inboxNext.pattern -cne [string]$inboxParam.schema.pattern) { return ("the /api/inbox 200 next_cursor pattern is '" + $inboxNext.pattern + "', expected the cursor parameter pattern " + $inboxParam.schema.pattern) }
  if (-not ("c9007199254740991-p9007199254740991-g9007199254740991" -cmatch [string]$inboxParam.schema.pattern)) { return "the /api/inbox cursor pattern refuses the largest cursor the route serves (c9007199254740991-p9007199254740991-g9007199254740991)" }
  if ("c9007199254740992-p0" -cmatch [string]$inboxParam.schema.pattern) { return "the /api/inbox cursor pattern accepts c9007199254740992-p0, a part above the safe-integer limit the route refuses with 400" }
  return ""
}
# L-167. Runs the check $check (a script block returning "" when the read is good, otherwise the reason it is not) until $need CONSECUTIVE good reads, at most $tries times, $delaySeconds apart.
# A bad read resets the run: it means "not yet seen", never "failed". Returns "" when the run is found, otherwise the last reason (or how short the run fell). Never stops and never names a remedy.
function Confirm-Reads($check, $need, $tries, $delaySeconds) {
  $run = 0
  $last = "never read"
  for ($n = 1; $n -le $tries; $n++) {
    $why = [string](& $check)
    if ($why -eq "") {
      $run = $run + 1
      if ($run -ge $need) { return "" }
      $last = "only " + $run + " good read(s) in a row of the " + $need + " needed"
    } else {
      $run = 0
      $last = $why
    }
    if ($n -lt $tries) { Start-Sleep -Seconds $delaySeconds }
  }
  return $last
}
# Polls (GETs only) until the served block is this deploy's AND /openapi.json declares this wave, $GOOD_READS_NEEDED reads in a row, or STOPS after $tries reads. Only the exhausted poll may name a rollback.
function Wait-NewWorker($commit, $versionId, $tries, $delaySeconds) {
  $last = "never read"
  $run = 0
  for ($n = 1; $n -le $tries; $n++) {
    $why = Test-CodeIdentityServed (Get-ServedCode) $commit $versionId
    if ($why -eq "") { $why = Test-ResponseSideServed (Get-Text $RUNS_URL 30) }
    if ($why -eq "") {
      $run = $run + 1
      Say "[poll] try $n of ${tries}: good read $run of ${GOOD_READS_NEEDED}: GET /api/attest serves code.commit $($commit.Substring(0, 8)) and code.version_id $versionId; GET /openapi.json declares the response side"
      if ($run -ge $GOOD_READS_NEEDED) { return }
      $last = "only " + $run + " good read(s) in a row of the " + $GOOD_READS_NEEDED + " needed"
    } else {
      $run = 0
      $last = $why
      Say "[poll] try $n of ${tries}: not yet: $why"
    }
    if ($n -lt $tries) { Start-Sleep -Seconds $delaySeconds }
  }
  Stop-Here ("the new worker was not shown live in " + $tries + " reads (last: " + $last + "). Read 'npx wrangler deployments list' and GET /api/attest by hand first: stale reads right after a deploy are common, and the deploy may be live. Only if the new version is not at 100% or fresh reads still disagree: " + $ROLLBACK_LINE)
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
if (-not (Select-String -Path "src/discovery.ts" -Pattern "export const UNVALIDATED: Record<string, UnvalidatedBehaviour>" -SimpleMatch -Quiet)) { Stop-Here "src/discovery.ts has no UNVALIDATED behaviour table: this checkout is not the response-side wave." }
if (-not (Select-String -Path "src/discovery.ts" -Pattern "function behaviourExtension(" -SimpleMatch -Quiet)) { Stop-Here "src/discovery.ts does not render the x-clamped / x-ignored-when-invalid extensions: this checkout is not the response-side wave." }
if (-not (Select-String -Path "src/discovery.ts" -Pattern "const ROW_ID_PATH_PARAM" -SimpleMatch -Quiet)) { Stop-Here "src/discovery.ts does not declare the row-id path pattern: this checkout is not the response-side wave." }
if (-not (Select-String -Path "src/discovery.ts" -Pattern "responseSchema: COUNCIL_THREAD_RESPONSE_SCHEMA" -SimpleMatch -Quiet)) { Stop-Here "src/discovery.ts does not declare the /api/council/thread schema: this checkout is not the response-side wave." }
if (-not (Select-String -Path "src/discovery.ts" -Pattern "has no pathParams declaration" -SimpleMatch -Quiet)) { Stop-Here "src/discovery.ts does not refuse an undeclared path variable: this checkout would drop the request-side wave." }
if (-not (Select-String -Path "src/maintainer/parked.ts" -Pattern "export async function parkedPage" -SimpleMatch -Quiet)) { Stop-Here "src/maintainer/parked.ts has no parkedPage: this checkout would drop the parked-list wave." }
if (-not (Select-String -Path "src/discovery.ts" -Pattern "schema: r.responseSchema ??" -SimpleMatch -Quiet)) { Stop-Here "src/discovery.ts does not use responseSchema in renderOpenApi: this checkout is not the openapi schema wave." }
if (-not (Select-String -Path "src/discovery.ts" -Pattern "responseSchema: PROPOSAL_RESPONSE_SCHEMA" -SimpleMatch -Quiet)) { Stop-Here "src/discovery.ts does not declare the /api/proposal/:id schema: this checkout would drop the openapi proposal schema wave." }
if (-not (Select-String -Path "src/discovery.ts" -Pattern "responseSchema: RESIDENTS_RESPONSE_SCHEMA" -SimpleMatch -Quiet)) { Stop-Here "src/discovery.ts does not declare the /api/residents schema: this checkout is not the resident schema wave." }
if (-not (Select-String -Path "src/discovery.ts" -Pattern "responseSchema: RESIDENT_RESPONSE_SCHEMA" -SimpleMatch -Quiet)) { Stop-Here "src/discovery.ts does not declare the /api/resident/:number schema: this checkout is not the resident schema wave." }
if (-not (Select-String -Path "src/doors.ts" -Pattern 'export const STAMPS_SINCE = "15 November 2026";' -SimpleMatch -Quiet)) { Stop-Here "src/doors.ts does not carry STAMPS_SINCE: this checkout is not the resident schema wave." }
if (-not (Select-String -Path "src/doors.ts" -Pattern "INSERT OR IGNORE INTO commit_days" -SimpleMatch -Quiet)) { Stop-Here "src/doors.ts does not write commit_days: this checkout would drop the 15 Nov recovery-unit wave." }
if (-not (Select-String -Path "src/maintainer/judgment.ts" -Pattern "not judged (the model declined); skipped this wake" -SimpleMatch -Quiet)) { Stop-Here "src/maintainer/judgment.ts does not name a refused item: this checkout would drop the refusal-skip wave." }
if (-not (Select-String -Path "src/maintainer/runs.ts" -Pattern "a judgment item the model declined to judge" -SimpleMatch -Quiet)) { Stop-Here "src/maintainer/runs.ts note lacks the refusal sentence: this checkout would drop the refusal-skip wave." }
if (-not (Select-String -Path "src/governance.ts" -Pattern "export function assertProposalsQuery(" -SimpleMatch -Quiet)) { Stop-Here "src/governance.ts has no assertProposalsQuery: this checkout would drop the proposals unknown-params wave." }
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

# 2. live, before: non-minting baseline, the live worker is the base this wave was checked against, and /openapi.json does not yet declare the response side (so the propagation poll proves something).
# These reads are before any write, so one read is the state and may stop.
$attBefore = Read-Attest "before the deploy"
Assert-Attest $attBefore "before the deploy"
Say ("[live] before: v6 " + $V6_HASH.Substring(0, 8) + "; all four chains ok; identity " + $attBefore.identity_log.sealed_entries + ", treasury " + $attBefore.treasury.sealed_entries + ", ballots " + $attBefore.ballots.sealed_entries)
if ($null -eq $attBefore.code -or [string]$attBefore.code.commit_status -cne "stamped") { Stop-Here "GET /api/attest serves no stamped code.commit before the deploy: the live worker cannot be shown to be the base this wave was checked against." }
if ([string]$attBefore.code.commit -ceq $headSha) { Stop-Here "GET /api/attest already serves code.commit $($headSha.Substring(0, 8)): this commit looks already deployed. Verify by hand." }
if ([string]$attBefore.code.commit -cne $LIVE_BASE_COMMIT) { Stop-Here ("the live worker serves code.commit " + $attBefore.code.commit + " but `$LIVE_BASE_COMMIT is " + $LIVE_BASE_COMMIT + ": the base this wave was checked against is not what is live. Correct the pin only after reading what changed.") }
$rollbackTarget = "the version before it (check npx wrangler deployments list)"
if ([string]$attBefore.code.version_status -ceq "available" -and $attBefore.code.version_id) { $rollbackTarget = [string]$attBefore.code.version_id }
Say "[live] before: the live worker serves the pinned base $($LIVE_BASE_COMMIT.Substring(0, 8)); rollback target $rollbackTarget"
$runsBefore = Get-Text $RUNS_URL 30
if ([string]$runsBefore.Code -cne "200") { Stop-Here "GET /openapi.json answered $($runsBefore.Code) before the deploy, expected 200: read it by hand." }
$whyBefore = Test-ResponseSideServed $runsBefore
if ($whyBefore -eq "") { Stop-Here "GET /openapi.json already declares the response side: this looks already deployed, verify by hand." }
if ($whyBefore -cne "the /api/search limit parameter carries no x-clamped") { Stop-Here ("the before-read of GET /openapi.json is not usable: " + $whyBefore + ". Read it by hand.") }
Say "[live] before: GET /openapi.json answers 200 and /api/search limit does not yet carry x-clamped"

if ($DryRun) {
  Say "[dry-run] every pin, git, source, test and live check passed. would now: run npx wrangler deploy --var CODE_COMMIT:<the full sha> and capture its Current Version ID (refusing to continue without one); poll up to $POLL_TRIES times, $POLL_DELAY_SECONDS s apart, until $GOOD_READS_NEEDED reads in a row show GET /api/attest serving that commit and version id and GET /openapi.json declaring the response side; then ride the public reads, each retried (up to $RIDE_TRIES reads, $GOOD_READS_NEEDED good in a row) before it judges. Nothing was deployed."
  exit 0
}

# 3. deploy the worker with the commit stamp, capturing its version id, then poll until the served identity is this deploy's
# BEGIN-DEPLOY-AND-POLL
# CODEX r1 (finding 2): tests, typecheck and the live reads ran since step 0, and wrangler bundles the working tree, so HEAD and a clean
# tree are re-read here, immediately before the bundle, or the stamp could name a commit the uploaded bytes no longer match.
$headNow = (git rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $headNow -cne $headSha) { Stop-Here ("HEAD moved since step 0 (" + $headSha.Substring(0, 8) + " -> " + $headNow + "): nothing was deployed.") }
$dirtyNow = @(git status --porcelain)
if ($LASTEXITCODE -ne 0) { Stop-Here "git status failed (exit $LASTEXITCODE) just before the deploy: nothing was deployed." }
if ($dirtyNow.Count -gt 0) { Stop-Here ("the working tree changed since step 0 (" + $dirtyNow.Count + " paths: " + ($dirtyNow -join " | ") + "): nothing was deployed.") }
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
$ROLLBACK_LINE = "ROLL BACK THE WORKER (npx wrangler rollback, to the version before $versionId, which should be $rollbackTarget; check npx wrangler deployments list first). This wave applied no migration and changed no schema, so the rollback is the whole undo."
Wait-NewWorker $headSha $versionId $POLL_TRIES $POLL_DELAY_SECONDS
# END-DEPLOY-AND-POLL
# 4. the ride (L-167: every check below is retried until $GOOD_READS_NEEDED good reads in a row, up to $RIDE_TRIES reads, before it judges; a stop here means the retries ran out, so the
# message says to read the deployments list by hand first, and only then names the rollback): non-minting and the chains, the served document, the roster's declared 200 and 400, then a sweep of public reads.
$whyAttest = Confirm-Reads {
  $a = Get-ServedAttest
  $m = Get-AttestReason $a
  if ($m -ne "") { return $m }
  # CODEX r1 (finding 1): the ride's own attest read must still be this deploy's, not only the poll's.
  return (Test-CodeIdentityServed $a.code $headSha $versionId)
} $GOOD_READS_NEEDED $RIDE_TRIES $RIDE_DELAY_SECONDS
if ($whyAttest -ne "") { Stop-Here ("GET /api/attest was not confirmed after the deploy in " + $RIDE_TRIES + " reads (last: " + $whyAttest + "). Read npx wrangler deployments list by hand first: another deploy may have taken over, or the edge is still catching up. Only if that shows the new version is not live: " + $ROLLBACK_LINE) }
Say ("[ride] attest: v6 " + $V6_HASH.Substring(0, 8) + " unchanged; every chain ok; code.commit " + $headSha.Substring(0, 8) + ", code.version_id " + $versionId + " ($GOOD_READS_NEEDED good reads in a row)")
$whyDoc = Confirm-Reads { return (Test-ResponseSideServed (Get-Text $RUNS_URL 30)) } $GOOD_READS_NEEDED $RIDE_TRIES $RIDE_DELAY_SECONDS
if ($whyDoc -ne "") { Stop-Here ("GET /openapi.json was not confirmed to declare the response side in " + $RIDE_TRIES + " reads (last: " + $whyDoc + "). Read npx wrangler deployments list and the document by hand first. Only if the new version is at 100% and fresh reads still disagree: " + $ROLLBACK_LINE) }
Say "[ride] GET /openapi.json -> 200: x-clamped on /api/search limit, x-ignored-when-invalid on /api/attest from, the digits pattern on /api/post/{id}, the cursor pattern on the residents and council thread next_cursor"
$whyRoster = Confirm-Reads {
  $r = Get-Text "$BASE/api/residents?limit=1" 30
  if ([string]$r.Code -cne "200") { return ("GET /api/residents?limit=1 answered " + $r.Code + ", expected 200") }
  return ""
} $GOOD_READS_NEEDED $RIDE_TRIES $RIDE_DELAY_SECONDS
if ($whyRoster -ne "") { Stop-Here ("GET /api/residents?limit=1 was not confirmed in " + $RIDE_TRIES + " reads (last: " + $whyRoster + "). Read npx wrangler deployments list and re-read it by hand first. Only if the new version is at 100% and fresh reads still fail: " + $ROLLBACK_LINE) }
$whyRosterBad = Confirm-Reads {
  $r = Get-Text "$BASE/api/residents?limit=0" 30
  if ([string]$r.Code -cne "400") { return ("GET /api/residents?limit=0 answered " + $r.Code + ", expected the declared 400") }
  return ""
} $GOOD_READS_NEEDED $RIDE_TRIES $RIDE_DELAY_SECONDS
if ($whyRosterBad -ne "") { Stop-Here ("GET /api/residents?limit=0 was not confirmed in " + $RIDE_TRIES + " reads (last: " + $whyRosterBad + "). Read npx wrangler deployments list and re-read it by hand first. Only if the new version is at 100% and fresh reads still disagree: " + $ROLLBACK_LINE) }
Say "[ride] GET /api/residents?limit=1 -> 200 and ?limit=0 -> 400, as the document declares"
$sweepPaths = @("/", "/api/official", "/openapi.json", "/treasury", "/api/listings", "/api/stats", "/api/topics", "/api/guest/due", "/api/citizens", "/api/doors", "/api/council", "/api/residents", "/heartbeat.md", "/skill.md", "/llms.txt", "/privacy", "/api/proposal/8")
$whySweep = Confirm-Reads {
  $bad = @()
  foreach ($p in $sweepPaths) {
    $r = Get-Text "$BASE$p" 30
    if ($r.Code -ne "200") { $bad += "$p=$($r.Code)" }
  }
  if ($bad.Count -gt 0) { return ("non-200: " + ($bad -join ", ")) }
  return ""
} $GOOD_READS_NEEDED $RIDE_TRIES $RIDE_DELAY_SECONDS
if ($whySweep -ne "") { Stop-Here ("the public reads were not all 200 after the deploy (version " + $versionId + ") in " + $RIDE_TRIES + " sweeps (last: " + $whySweep + "). Read npx wrangler deployments list and the failing paths by hand first. Only if the new version is at 100% and a read that answered before still fails: " + $ROLLBACK_LINE) }
Say "[ride] 17 public reads -> 200 ($GOOD_READS_NEEDED sweeps in a row)"
Say "[note] This ride sent GET requests only, with no request body, token or key. /skill.md and /heartbeat.md are counted doors, so each GET of them ATTEMPTS a counting write: the count rises by one only while the door is below its daily cap and the batch succeeds, and a commit_days stamp row for today's date and the new commit can be written even at the cap. GET /api/doors commits_by_day may therefore show two stamps for today (the old commit and the new one), which is expected. The retried ride sends several sweeps, so those two doors are counted several times."
Say "[done] openapi response-side wave deployed and ridden. Log version id $versionId, commit $($headSha.Substring(0, 8)) and these lines in HANDOVER.md."
