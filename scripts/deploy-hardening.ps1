# Deploys the 12 OCT HARDENING WAVE (build log docs/CHECKPOINT-HARDENING.md; DECISIONS D-075 note 12 Oct late afternoon item 4, and D-076): nonces stored per signer (a citizen's auth_nonces key is
# c:<citizen_id>:<nonce>, a resident's resident_nonces key is r:<visitor_id>:<nonce>) with a constraint-failing guard for a raw-nonce row left by the previous worker, the resident bind and recovery
# attempt-row ceiling with the no-address bucket and path-scoped collectors, the resident replay pre-check, the council's second known weakness reworded with /skill.md 1.4.1, and GET /api/citizens rows
# carrying acts, last_write_at and last_me_at. ONE worker deploy. Ben's hand only (D-017). One fail-fast script (L-046, L-069).
# NO MIGRATION, NO D1 WRITE, NO D1 READ: this wave adds no table and no column (the old worker and the new one read the same schema). Step 0 STOPS if migrations/ or schema.sql differ between the live
# base and HEAD, so a wave that quietly grew one cannot ride this script. Wrangler is used for exactly ONE thing here: the stamped deploy.
# WRITTEN BY THE BUILDER AND NEVER RUN: not even -DryRun (which reads the live worker over HTTP). The Opus gate (HW1: this wave replaces the replay mechanism upstream of the wallet and payout writes),
# the merge and the push come before it.
# TWO PINS. $LIVE_BASE_COMMIT is the commit the live worker serves when this runs (the rulings wave, worker 7931589e) and is set; step 2 PROVES it against the live GET /api/attest code.commit at run
# time. $REVIEWED_COMMIT is the commit the review converged on and holds the hub's placeholder until the hub sets it. Step 0a STOPS, before any git or network command, while EITHER still holds its
# placeholder or is not 40 lower-case hex.
# NO MINT: this wave edits src/doc.ts NOT AT ALL, so the check is the template text itself: step 0 extracts FRONT_DOOR_TEMPLATE from src/doc.ts at $LIVE_BASE_COMMIT and at HEAD and STOPS if they differ
# by a byte. After the deploy it STOPS if the constitution is not still v5 with its template hash. (/skill.md is outside the template: 1.4.1 mints nothing.)
# THE DEPLOY STAMPS THE COMMIT: `npx wrangler deploy --var CODE_COMMIT:<sha>` (served code identity). The poll after the deploy waits until GET /api/attest serves code.commit equal to the pinned sha
# AND code.version_id equal to the Current Version ID wrangler printed AND GET /api/citizens rows carry the new activity fields. The ROLLBACK TARGET is the version id GET /api/attest served BEFORE the
# deploy (read live, never typed in).
# REVIEWED SOURCE ONLY: step 0 also STOPS unless HEAD is $REVIEWED_COMMIT plus changes confined to $ALLOWED_PATHS_AFTER_REVIEW (this script, its test, docs/).
# Run from society/ on main, after the merge and the push:
#   cd "C:\Users\bengr\Projects\AI domain and social network\society"
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-hardening.ps1 -ExpectedCommit <sha> -DryRun   # every check and the live reads, nothing deployed
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-hardening.ps1 -ExpectedCommit <sha>           # the real thing
# <sha> is the pushed tip of main (git -C society rev-parse HEAD), the full 40 hex.
# THE RIDE IS PUBLIC GETs ONLY AND MAKES NO LIVE WRITE AT ALL: it holds no token, key or assertion. It reads /skill.md EXACTLY ONCE, after the other reads, to confirm version 1.4.1 and the reworded council
# weakness, and says so before it does: that one 200 adds ONE to that day's door_counts row (/heartbeat.md is never read). What it proves: GET /api/citizens rows carry acts {posts, comments, ballots, council} of
# non-negative whole numbers, last_write_at (null or a number), last_me_at (a number) and no raw last_seen_at, with the note that says last_me_at cannot prove a return visit; /api/official still carries
# rule7_revote; /api/council still serves no record_body; /skill.md is 1.4.1 with the reworded weakness. THE NONCE, CAP AND REPLAY CHANGES ARE PROVED BY TESTS ONLY: a signed citizen request, a bind, a recovery
# and a council ballot each need a credential this script must not hold, so none of them is ridden here.
# PowerShell 5.1 traps this file avoids (all seen live): $COLS and $cols are the SAME variable (one spelling per name here); -notmatch on an array filters instead of testing;
# a one-element return is wrapped in @(); "$var:" is a drive reference (write "${var}:"); an Invoke-WebRequest 4xx body is in $_.ErrorDetails.Message; never merge a native command's stderr
# under ErrorActionPreference Stop; -eq and -ne are case-INSENSITIVE (hashes, shas and states are compared with -ceq / -cne). ASCII only: 5.1 reads a BOM-less UTF-8 script as the ANSI code page.
param(
  [Parameter(Mandatory = $true)][string]$ExpectedCommit,
  [switch]$DryRun
)
$ErrorActionPreference = "Stop"
$BASE = "https://commonhold.randommonicle.workers.dev"
# The attested constitution this wave must leave untouched.
$V5_HASH = "fa11788d062b0c6d23c54c428c1c9649d263ae3ba704e602e122066926049491"
# The commit the live worker serves when this runs (the rulings wave, worker 7931589e). Step 0 STOPS while it holds the placeholder, and while it is not 40 lower-case hex.
$LIVE_BASE_COMMIT = "763f6666741a83aabd41ec5f0b917cd33d722a8d"
$LIVE_BASE_PLACEHOLDER = "TO-BE-SET-BY-HUB-LIVE-BASE"
# THE REVIEWED SOURCE. The hub replaces this placeholder with the full sha the review converged on; step 0 STOPS while it is unchanged, and while it is not 40 lower-case hex.
$REVIEWED_COMMIT = "TO-BE-SET-BY-HUB"
$REVIEWED_COMMIT_PLACEHOLDER = "TO-BE-SET-BY-HUB"
$ALLOWED_PATHS_AFTER_REVIEW = @("scripts/deploy-hardening.ps1", "test/deploy-hardening-script.test.ts", "docs/")
# The propagation poll waits for THESE fields to appear on the rows of GET /api/citizens (a shape only this wave serves); the pre-deploy probe proves they are absent first.
$NEW_CODE_URL = "$BASE/api/citizens"
$NEW_CODE_FIELDS = @("acts", "last_write_at", "last_me_at")
$SKILL_VERSION_LINE = "version: 1.4.1"
$SKILL_WEAKNESS_PHRASE = "only the operator can compare the stored copy"
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
# $true when the JSON text of GET /api/citizens has at least one row and its FIRST row carries every field in $NEW_CODE_FIELDS as a property (case-sensitive; the value may be null). $false on anything
# unreadable: absent is never inferred from a failed read by the caller (the pre-deploy probe reads the status code first).
function Test-CitizensCarryActivity($body) {
  try { $o = ([string]$body | ConvertFrom-Json) } catch { return $false }
  if ($null -eq $o) { return $false }
  $rows = @($o.citizens)
  if ($rows.Count -lt 1) { return $false }
  $names = @($rows[0].PSObject.Properties.Name)
  foreach ($f in $NEW_CODE_FIELDS) { if ($names -cnotcontains $f) { return $false } }
  return $true
}
# Polls until the served block is this deploy's AND the new citizen fields are served, or STOPS (with $ROLLBACK_LINE) after $tries reads.
function Wait-NewWorker($commit, $versionId, $tries, $delaySeconds) {
  $last = "never read"
  for ($n = 1; $n -le $tries; $n++) {
    $why = Test-CodeIdentityServed (Get-ServedCode) $commit $versionId
    if ($why -eq "") {
      $route = Get-Text $NEW_CODE_URL 30
      if ($route.Code -eq "200" -and (Test-CitizensCarryActivity $route.Body)) {
        Say "[poll] try $n of ${tries}: GET /api/attest serves code.commit $($commit.Substring(0, 8)) and code.version_id $versionId; GET /api/citizens rows carry the activity fields"
        return
      }
      $why = "GET /api/citizens answered $($route.Code) and its rows do not yet carry the activity fields"
    }
    $last = $why
    Say "[poll] try $n of ${tries}: not yet: $why"
    if ($n -lt $tries) { Start-Sleep -Seconds $delaySeconds }
  }
  Stop-Here ("the new worker was never shown live in " + $tries + " reads (last: " + $last + "). The deploy is not shown to be live. " + $ROLLBACK_LINE)
}
# END-OF-DEFINITIONS (test/deploy-hardening-script.test.ts reads everything above this line as definitions; nothing above runs git, npm, wrangler or the network)

# 0a. the two pins, BEFORE any git, npm, wrangler or network command: a placeholder is never a commit, and a malformed pin must not reach `git merge-base`
# BEGIN-PIN-CHECK
if ($LIVE_BASE_COMMIT -ceq $LIVE_BASE_PLACEHOLDER) { Stop-Here "`$LIVE_BASE_COMMIT still holds the placeholder '$LIVE_BASE_PLACEHOLDER': the hub sets it to the commit the live worker serves, and until then there is no base to check this wave against. Nothing was read or written." }
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
# Non-minting: the attested template lives in FRONT_DOOR_TEMPLATE in src/doc.ts. This wave does not edit src/doc.ts, and the proof is that the template text itself is byte-identical at both commits.
$liveDoc = (@(git show ($LIVE_BASE_COMMIT + ":src/doc.ts")) -join "`n")
if ($LASTEXITCODE -ne 0) { Stop-Here "git show $($LIVE_BASE_COMMIT.Substring(0, 8)):src/doc.ts failed (exit $LASTEXITCODE): the no-mint check cannot be read." }
$headDoc = (@(git show ($headSha + ":src/doc.ts")) -join "`n")
if ($LASTEXITCODE -ne 0) { Stop-Here "git show $($headSha.Substring(0, 8)):src/doc.ts failed (exit $LASTEXITCODE): the no-mint check cannot be read." }
$liveTemplate = Get-TemplateText $liveDoc
$headTemplate = Get-TemplateText $headDoc
if ($null -eq $liveTemplate -or $null -eq $headTemplate) { Stop-Here "FRONT_DOOR_TEMPLATE could not be found in src/doc.ts at one of the two commits: the no-mint check cannot be read." }
if ($liveTemplate -cne $headTemplate) { Stop-Here "FRONT_DOOR_TEMPLATE differs between $($LIVE_BASE_COMMIT.Substring(0, 8)) and HEAD: this wave mints nothing and was to leave the attested template alone. Not this script's deploy." }
# No migration and no schema change since the live code: this script has no migration step, so a wave that grew one must not ship through it.
$schemaMoves = @(git diff --name-status --no-renames $LIVE_BASE_COMMIT HEAD -- migrations schema.sql)
if ($LASTEXITCODE -ne 0) { Stop-Here "git diff failed (exit $LASTEXITCODE): the no-migration check cannot be read." }
if ($schemaMoves.Count -gt 0) { Stop-Here ("migrations/ or schema.sql changed since " + $LIVE_BASE_COMMIT.Substring(0, 8) + " (" + ($schemaMoves -join " | ") + "): this script applies no migration and this wave was to have none. Not this script's deploy.") }
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
if (-not (Select-String -Path "src/resident.ts" -Pattern "export async function assertResidentNonceUnspent" -Quiet)) { Stop-Here "src/resident.ts has no assertResidentNonceUnspent: this checkout is not the hardening wave." }
if (-not (Select-String -Path "src/showhome.ts" -Pattern "NO_ADDRESS_KEY" -Quiet)) { Stop-Here "src/showhome.ts has no NO_ADDRESS_KEY: this checkout is not the hardening wave." }
if (-not (Select-String -Path "src/council.ts" -Pattern "export async function citizenActivityPage" -Quiet)) { Stop-Here "src/council.ts has no citizenActivityPage: this checkout is not the hardening wave." }
if (-not (Select-String -Path "src/society.ts" -Pattern "DEFERRED-NONCE-RAW-GUARD" -Quiet)) { Stop-Here "src/society.ts has no DEFERRED-NONCE-RAW-GUARD: the citizen nonce guard is missing from this checkout." }
if (-not (Select-String -Path "src/inbox.ts" -Pattern 'SKILL_VERSION = "1.4.1"' -Quiet)) { Stop-Here "src/inbox.ts does not set SKILL_VERSION 1.4.1: this checkout is not the hardening wave." }
if (-not (Select-String -Path "src/rule7-vote.ts" -Pattern "export function rule7RevoteFacts" -Quiet)) { Stop-Here "src/rule7-vote.ts has no rule7RevoteFacts: this checkout would drop the rulings wave." }
if (-not (Select-String -Path "src/council.ts" -Pattern "export async function claimCouncilSeat" -Quiet)) { Stop-Here "src/council.ts has no claimCouncilSeat: this checkout does not carry the council this wave builds on." }
if (-not (Select-String -Path "src/resident.ts" -Pattern "export async function bindResident" -Quiet)) { Stop-Here "src/resident.ts has no bindResident: this checkout does not carry the resident tier this wave builds on." }
if (-not (Select-String -Path "src/code-identity.ts" -Pattern "export function codeBlock" -Quiet)) { Stop-Here "src/code-identity.ts has no codeBlock: this checkout would drop served code identity." }
if (-not (Select-String -Path "src/guest.ts" -Pattern "export async function postGuestComment" -Quiet)) { Stop-Here "src/guest.ts has no postGuestComment: this checkout would drop the guest voice." }
if (-not (Select-String -Path "wrangler.jsonc" -Pattern '"version_metadata"' -Quiet)) { Stop-Here "wrangler.jsonc has no version_metadata binding: the Worker could not serve Cloudflare's version id." }
if (Select-String -Path "wrangler.jsonc" -Pattern '"CODE_COMMIT"' -Quiet) { Stop-Here "wrangler.jsonc configures a CODE_COMMIT var: a deploy that forgot the flag would serve a stale stamp. The stamp comes from this script's --var only." }
Say ("[git] HEAD " + $headSha.Substring(0, 8) + " = main = origin/main = -ExpectedCommit; tree clean; contains " + $LIVE_BASE_COMMIT.Substring(0, 8) + "; FRONT_DOOR_TEMPLATE unmoved; no migration and no schema change since the live base")

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

# 2. live, before: non-minting baseline, the live worker is the base this wave was checked against, and the new citizen fields ABSENT (so the propagation poll proves something)
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
$citizensBefore = Get-Text $NEW_CODE_URL 30
if ($citizensBefore.Code -ne "200") { Stop-Here "GET /api/citizens answered $($citizensBefore.Code) before the deploy, expected 200: investigate." }
if (Test-CitizensCarryActivity $citizensBefore.Body) { Stop-Here "GET /api/citizens rows already carry the activity fields: this wave looks already deployed. Verify by hand; this script cannot prove a propagation it did not wait for." }
Say "[live] before: GET /api/citizens rows do not carry the activity fields (the new code is absent)"

if ($DryRun) {
  Say "[dry-run] would now: run npx wrangler deploy --var CODE_COMMIT:<the full sha> and capture its Current Version ID (refusing to continue without one); poll up to $POLL_TRIES times, $POLL_DELAY_SECONDS s apart, until GET /api/attest serves that commit and version id and GET /api/citizens rows carry the activity fields; re-check attest (v5, template $($V5_HASH.Substring(0, 8)), every chain ok); ride the public reads and read /skill.md once (which adds ONE door count). NO migration, NO D1 access and NO live write at any point. Nothing was deployed."
  exit 0
}

# 3. deploy the worker with the commit stamp, capturing its version id (a deploy whose id cannot be read is a stop: it cannot be tied to this commit), then poll until the served identity is this deploy's
# BEGIN-DEPLOY-AND-POLL
Say "[deploy] npx wrangler deploy --var CODE_COMMIT:$($headSha.Substring(0, 8))... (commit $($headSha.Substring(0, 8)))"
$ErrorActionPreference = "Continue"
$deployOut = (npx wrangler deploy --var "CODE_COMMIT:$headSha" 2>&1 | Out-String)
$deployCode = $LASTEXITCODE
$ErrorActionPreference = "Stop"
if ($deployCode -ne 0) { Stop-Here "wrangler deploy failed (exit $deployCode); this wave applied no migration, so there is nothing else to undo. Output: $deployOut" }
# The id is read from its OWN line, and exactly one such line must exist: with two, which one is this deploy's cannot be told.
$versionMatches = @([regex]::Matches($deployOut, '(?m)^[ \t]*Current Version ID:[ \t]*([0-9a-fA-F-]{36})[ \t]*\r?$'))
if ($versionMatches.Count -gt 1) { Stop-Here ("wrangler deploy printed 'Current Version ID' on " + $versionMatches.Count + " lines; which one is this deploy's cannot be told, and the deploy may have succeeded. Check 'npx wrangler deployments list' by hand before anything else.") }
if ($versionMatches.Count -lt 1) { Stop-Here "wrangler deploy exited 0 but printed no 'Current Version ID'; the deploy may have succeeded. Check 'npx wrangler deployments list' by hand before anything else." }
$versionId = $versionMatches[0].Groups[1].Value
Say "[deploy] worker version id $versionId (commit $($headSha.Substring(0, 8)))"
$ROLLBACK_LINE = "ROLL BACK THE WORKER (npx wrangler rollback, to the version before $versionId, which should be $rollbackTarget; check npx wrangler deployments list first). This wave applied no migration, so the rollback is the whole undo. A rollback re-accepts raw nonces on the old worker: a nonce spent under the new worker is replayable there within its 120 s window."
Wait-NewWorker $headSha $versionId $POLL_TRIES $POLL_DELAY_SECONDS
# END-DEPLOY-AND-POLL

# 4. the ride: non-minting and the chains, then the public reads. Public GETs only and NO live write at all (/heartbeat.md is never read; /skill.md is read once, last, and says so first).
$attAfter = Read-Attest "after the deploy"
Assert-Attest $attAfter "after the deploy"
Say ("[ride] attest: v5 " + $V5_HASH.Substring(0, 8) + " unchanged; every chain ok")
$bad = @()
foreach ($p in "/", "/api/official", "/llms.txt", "/openapi.json", "/treasury", "/api/listings", "/api/stats", "/api/topics", "/api/guest/due", "/api/citizens", "/api/doors", "/api/council", "/api/council/thread", "/api/residents") {
  $r = Get-Text "$BASE$p" 30
  if ($r.Code -ne "200") { $bad += "$p=$($r.Code)" }
}
if ($bad.Count -gt 0) { Stop-Here ("non-200 after the deploy (version $versionId): " + ($bad -join ", ") + ". If a read that answered before now fails: $ROLLBACK_LINE") }
Say "[ride] 14 public reads -> 200"
# A1: the activity fields on every citizen row
$citizens = Get-Json "$BASE/api/citizens"
$rows = @($citizens.citizens)
if ($rows.Count -lt 1) { Stop-Here "GET /api/citizens carries no rows after the deploy. $ROLLBACK_LINE" }
if ("$($citizens.total)" -notmatch "^[0-9]+$") { Stop-Here "GET /api/citizens total is not a number. $ROLLBACK_LINE" }
foreach ($row in $rows) {
  $names = @($row.PSObject.Properties.Name)
  foreach ($f in $NEW_CODE_FIELDS) { if ($names -cnotcontains $f) { Stop-Here ("citizen " + $row.handle + " carries no " + $f + " field. " + $ROLLBACK_LINE) } }
  if ($names -ccontains "last_seen_at") { Stop-Here ("citizen " + $row.handle + " still carries the raw last_seen_at (it is served as last_me_at). " + $ROLLBACK_LINE) }
  if ($null -eq $row.acts) { Stop-Here ("citizen " + $row.handle + " has acts null: the activity could not be read on the live database (the census is served without it). " + $ROLLBACK_LINE) }
  foreach ($k in "posts", "comments", "ballots", "council") {
    if ("$($row.acts.$k)" -notmatch "^[0-9]+$") { Stop-Here ("citizen " + $row.handle + " acts." + $k + " is '" + $row.acts.$k + "', expected a non-negative whole number. " + $ROLLBACK_LINE) }
  }
  if ($null -ne $row.last_write_at -and "$($row.last_write_at)" -notmatch "^[0-9]+$") { Stop-Here ("citizen " + $row.handle + " last_write_at is '" + $row.last_write_at + "', expected null or a number. " + $ROLLBACK_LINE) }
  if ("$($row.last_me_at)" -notmatch "^[0-9]+$") { Stop-Here ("citizen " + $row.handle + " last_me_at is '" + $row.last_me_at + "', expected a number. " + $ROLLBACK_LINE) }
  $writes = [int64]$row.acts.posts + [int64]$row.acts.comments + [int64]$row.acts.ballots + [int64]$row.acts.council
  if ($writes -gt 0 -and $null -eq $row.last_write_at) { Stop-Here ("citizen " + $row.handle + " has " + $writes + " counted writes but a null last_write_at. " + $ROLLBACK_LINE) }
  if ($writes -eq 0 -and $null -ne $row.last_write_at) { Stop-Here ("citizen " + $row.handle + " has no counted writes but a last_write_at of " + $row.last_write_at + ". " + $ROLLBACK_LINE) }
}
if (-not ([string]$citizens.note).Contains("cannot prove a return visit")) { Stop-Here "GET /api/citizens note does not say last_me_at cannot prove a return visit. $ROLLBACK_LINE" }
Say ("[ride] /api/citizens: " + $rows.Count + " row(s), each with acts of four whole numbers, a last_write_at that agrees with them, a last_me_at and no raw last_seen_at; the note says what last_me_at is not")
# the earlier waves are still served
$official = Get-Json "$BASE/api/official"
if (@($official.PSObject.Properties.Name) -cnotcontains "rule7_revote") { Stop-Here "GET /api/official no longer carries rule7_revote: this deploy dropped the rulings wave. $ROLLBACK_LINE" }
$councilRaw = Get-Text "$BASE/api/council" 30
if ($councilRaw.Code -ne "200") { Stop-Here "GET /api/council answered $($councilRaw.Code). $ROLLBACK_LINE" }
if ($councilRaw.Body.Contains("record_body")) { Stop-Here "GET /api/council carries a record_body key again: this deploy dropped the rulings wave. $ROLLBACK_LINE" }
if (-not $councilRaw.Body.Contains($SKILL_WEAKNESS_PHRASE)) { Stop-Here "GET /api/council known_weaknesses does not carry the reworded sentence ('$SKILL_WEAKNESS_PHRASE'). $ROLLBACK_LINE" }
Say "[ride] /api/official still carries rule7_revote; /api/council still serves no record_body and carries the reworded weakness"
# H5: /skill.md, read ONCE, last
Say "[note] reading /skill.md now, ONCE: that one 200 adds ONE to today's door_counts row (/heartbeat.md is never read)."
$skill = Get-Text "$BASE/skill.md" 30
if ($skill.Code -ne "200") { Stop-Here "GET /skill.md answered $($skill.Code). $ROLLBACK_LINE" }
if ($skill.Body -cnotmatch ('(?m)^' + [regex]::Escape($SKILL_VERSION_LINE) + '\r?$')) { Stop-Here "GET /skill.md does not carry the line '$SKILL_VERSION_LINE'. $ROLLBACK_LINE" }
if (-not $skill.Body.Contains($SKILL_WEAKNESS_PHRASE)) { Stop-Here "GET /skill.md does not carry the reworded council weakness ('$SKILL_WEAKNESS_PHRASE'). $ROLLBACK_LINE" }
if ($skill.Body.Contains("stays checkable")) { Stop-Here "GET /skill.md still says the proof stays checkable. $ROLLBACK_LINE" }
Say "[ride] /skill.md: $SKILL_VERSION_LINE, the reworded weakness, no 'stays checkable'"
Say "[note] No live write was made. The nonce namespaces and the raw guard, the resident attempt ceiling, the no-address bucket and the replay pre-check are proved by tests only: each needs a credential this script must not hold."
Say "[done] Hardening wave deployed and ridden (reads only). Log version id $versionId, commit $($headSha.Substring(0, 8)) and these lines in HANDOVER.md."
