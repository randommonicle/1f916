# Deploys the 13 OCT COUNCIL FLAG WAVE (build log docs/CHECKPOINT-COUNCIL-FLAG.md; the flag binds to its act like a ballot): a key citizen's council flag carries the signed intent council_flag over
# [motion id], a resident's flag is {number, assertion} with the binding resident_council_flag over [number, motion id] and takes no token (the nonce is burnt in one batch with the flag), the MCP
# council_flag tool and every served sentence say so, and /skill.md is 1.4.2. ONE worker deploy. Ben's hand only (D-017). One fail-fast script (L-046, L-069).
# NO MIGRATION, NO D1 WRITE, NO D1 READ: this wave adds no table and no column (the old worker and the new one read the same schema). Step 0 STOPS if migrations/ or schema.sql differ between the live
# base and HEAD, so a wave that quietly grew one cannot ride this script. Wrangler is used for exactly ONE thing here: the stamped deploy.
# WRITTEN BY THE BUILDER AND NEVER RUN: not even -DryRun (which reads the live worker over HTTP). The Sonnet gate (the brief's A8), the merge and the push come before it.
# TWO PINS. $LIVE_BASE_COMMIT is the commit the live worker serves when this runs (the hardening wave, worker acfa546b) and is set; step 2 PROVES it against the live GET /api/attest code.commit at run
# time. $REVIEWED_COMMIT is the commit the review converged on and holds the hub's placeholder until the hub sets it. Step 0a STOPS, before any git or network command, while EITHER still holds its
# placeholder or is not 40 lower-case hex.
# NO MINT: this wave edits src/doc.ts NOT AT ALL, so the check is the template text itself: step 0 extracts FRONT_DOOR_TEMPLATE from src/doc.ts at $LIVE_BASE_COMMIT and at HEAD and STOPS if they differ
# by a byte. After the deploy it STOPS if the constitution is not still v5 with its template hash. (/skill.md is outside the template: 1.4.2 mints nothing.)
# THE DEPLOY STAMPS THE COMMIT: `npx wrangler deploy --var CODE_COMMIT:<sha>` (served code identity). The poll after the deploy waits until GET /api/attest serves code.commit equal to the pinned sha
# AND code.version_id equal to the Current Version ID wrangler printed AND GET /api/surface documents the flag route's two bindings (a shape only this wave serves; the pre-deploy probe proves it is absent
# first). The ROLLBACK TARGET is the version id GET /api/attest served BEFORE the deploy (read live, never typed in).
# REVIEWED SOURCE ONLY: step 0 also STOPS unless HEAD is $REVIEWED_COMMIT plus changes confined to $ALLOWED_PATHS_AFTER_REVIEW (this script, its test, docs/).
# Run from society/ on main, after the merge and the push:
#   cd "C:\Users\bengr\Projects\AI domain and social network\society"
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-council-flag.ps1 -ExpectedCommit <sha> -DryRun   # every check and the live reads, nothing deployed
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-council-flag.ps1 -ExpectedCommit <sha>           # the real thing
# <sha> is the pushed tip of main (git -C society rev-parse HEAD), the full 40 hex.
# THE RIDE IS PUBLIC GETs PLUS EXACTLY ONE REFUSED POST, and it holds no token, key or assertion. The reads: the 14 public reads, GET /api/surface (the flag route's note names both bindings and no token),
# GET /llms.txt and GET /.well-known/mcp.json (the credential sentence and the MCP line say a ballot and a flag are signed to the act), GET /api/council (still 200, still no record_body, the flag still one-way
# and public). It reads /skill.md EXACTLY ONCE, last, to confirm version 1.4.2 and the council section's flag binding, and says so before it does: that one 200 adds ONE to that day's door_counts row
# (/heartbeat.md is never read). THE ONE POST is an UNBOUND flag request: POST /api/council/motion/999999/flag with the body {} and no Authorization, which the route refuses with a 4xx BEFORE it
# reads a motion, a nonce or a credential. Its only trace is the one rate-cap reservation row (path council, a hashed address, which expires) that every request to a council write route makes first: no motion,
# flag, ballot or nonce is written, and the script reads GET /api/council before and after and STOPS if the motions total moved. THE BINDINGS THEMSELVES (a key citizen's council_flag, a resident's
# resident_council_flag, the replay and cross-op refusals) ARE PROVED BY TESTS ONLY: each needs a credential this script must not hold, so none of them is ridden here.
# NOTE: /api/council serves no sentence about how a flag authenticates (that lives on /skill.md, /llms.txt, /api/surface, the MCP manifest and the tool description), so the new wording is ridden on those.
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
# The commit the live worker serves when this runs (the hardening wave, worker acfa546b). Step 0 STOPS while it holds the placeholder, and while it is not 40 lower-case hex.
$LIVE_BASE_COMMIT = "5c04ca34588ffca279e246e6865920b4b5164e0f"
$LIVE_BASE_PLACEHOLDER = "TO-BE-SET-BY-HUB-LIVE-BASE"
# THE REVIEWED SOURCE. The hub replaces this placeholder with the full sha the review converged on; step 0 STOPS while it is unchanged, and while it is not 40 lower-case hex.
$REVIEWED_COMMIT = "e888a57e7f12a24d9b44ce42b4d6d62bf769e9eb"
$REVIEWED_COMMIT_PLACEHOLDER = "TO-BE-SET-BY-HUB"
$ALLOWED_PATHS_AFTER_REVIEW = @("scripts/deploy-council-flag.ps1", "test/deploy-council-flag-script.test.ts", "docs/")
# The propagation poll waits for THIS to appear on GET /api/surface (a note only this wave serves); the pre-deploy probe proves it is absent first.
$NEW_CODE_URL = "$BASE/api/surface"
$FLAG_ROUTE_PATH = "/api/council/motion/:id/flag"
$SURFACE_CITIZEN_PHRASE = "intent binding 'council_flag' over [motion_id]"
$SURFACE_RESIDENT_PHRASE = "intent binding 'resident_council_flag' over [resident number, motion_id]"
$SKILL_VERSION_LINE = "version: 1.4.2"
$SKILL_FLAG_PHRASE = "council_flag: plus the digest of [<motion id>] for a flag"
$SKILL_RESIDENT_PHRASE = "resident_council_flag: plus the digest of [<your number>,<motion id>]"
$CREDENTIAL_PHRASE = "its ballots and flags are irreversible, so each is signed to the one act"
$MCP_MANIFEST_PHRASE = "council_ballot and council_flag take a citizen credential (a key assertion signed to the act)"
$UNBOUND_FLAG_URL = "$BASE/api/council/motion/999999/flag"
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
# The ONE request this script makes that is not a GET: an unbound flag, an empty JSON body, no Authorization header, no token, no assertion. Used once, in the ride, against motion 999999.
function Post-Unbound($url) {
  $tmp = [System.IO.Path]::GetTempFileName()
  try {
    $code = (curl.exe -s --max-time 30 -X POST -H "content-type: application/json" -d "{}" -o $tmp -w "%{http_code}" $url)
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
# $true when the JSON text of GET /api/surface lists the flag route and its note carries BOTH binding phrases (ordinal, case-sensitive). $false on anything unreadable: absent is never inferred from a
# failed read by the caller (the pre-deploy probe reads the status code first).
function Test-SurfaceCarriesFlagBinding($body) {
  try { $o = ([string]$body | ConvertFrom-Json) } catch { return $false }
  if ($null -eq $o) { return $false }
  foreach ($r in @($o.routes)) {
    if ([string]$r.path -ceq $FLAG_ROUTE_PATH) {
      $note = [string]$r.note
      return ($note.Contains($SURFACE_CITIZEN_PHRASE) -and $note.Contains($SURFACE_RESIDENT_PHRASE))
    }
  }
  return $false
}
# Polls until the served block is this deploy's AND the surface documents the flag bindings, or STOPS (with $ROLLBACK_LINE) after $tries reads.
function Wait-NewWorker($commit, $versionId, $tries, $delaySeconds) {
  $last = "never read"
  for ($n = 1; $n -le $tries; $n++) {
    $why = Test-CodeIdentityServed (Get-ServedCode) $commit $versionId
    if ($why -eq "") {
      $route = Get-Text $NEW_CODE_URL 30
      if ($route.Code -eq "200" -and (Test-SurfaceCarriesFlagBinding $route.Body)) {
        Say "[poll] try $n of ${tries}: GET /api/attest serves code.commit $($commit.Substring(0, 8)) and code.version_id $versionId; GET /api/surface documents the flag route's two bindings"
        return
      }
      $why = "GET /api/surface answered $($route.Code) and its flag route note does not yet carry both bindings"
    }
    $last = $why
    Say "[poll] try $n of ${tries}: not yet: $why"
    if ($n -lt $tries) { Start-Sleep -Seconds $delaySeconds }
  }
  Stop-Here ("the new worker was never shown live in " + $tries + " reads (last: " + $last + "). The deploy is not shown to be live. " + $ROLLBACK_LINE)
}
# END-OF-DEFINITIONS (test/deploy-council-flag-script.test.ts reads everything above this line as definitions; nothing above runs git, npm, wrangler or the network)

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
if (-not (Select-String -Path "src/council-core.ts" -Pattern "export const citizenCouncilFlagParts" -Quiet)) { Stop-Here "src/council-core.ts has no citizenCouncilFlagParts: this checkout is not the council flag wave." }
if (-not (Select-String -Path "src/council-core.ts" -Pattern "export const councilFlagParts" -Quiet)) { Stop-Here "src/council-core.ts has no councilFlagParts: this checkout is not the council flag wave." }
if (-not (Select-String -Path "src/resident.ts" -Pattern "resident_council_flag" -Quiet)) { Stop-Here "src/resident.ts does not name resident_council_flag: this checkout is not the council flag wave." }
if (-not (Select-String -Path "src/keyauth.ts" -Pattern '"council_flag"' -Quiet)) { Stop-Here "src/keyauth.ts has no council_flag intent op: this checkout is not the council flag wave." }
if (-not (Select-String -Path "src/inbox.ts" -Pattern 'SKILL_VERSION = "1.4.2"' -Quiet)) { Stop-Here "src/inbox.ts does not set SKILL_VERSION 1.4.2: this checkout is not the council flag wave." }
if (Select-String -Path "src/council.ts" -Pattern "DEFERRED-COUNCIL-FLAG-INTENT" -Quiet) { Stop-Here "src/council.ts still carries DEFERRED-COUNCIL-FLAG-INTENT: the deferral this wave discharges is still in the source." }
if (-not (Select-String -Path "src/resident.ts" -Pattern "export async function assertResidentNonceUnspent" -Quiet)) { Stop-Here "src/resident.ts has no assertResidentNonceUnspent: this checkout would drop the hardening wave." }
if (-not (Select-String -Path "src/council.ts" -Pattern "export async function citizenActivityPage" -Quiet)) { Stop-Here "src/council.ts has no citizenActivityPage: this checkout would drop the hardening wave." }
if (-not (Select-String -Path "src/society.ts" -Pattern "DEFERRED-NONCE-RAW-GUARD" -Quiet)) { Stop-Here "src/society.ts has no DEFERRED-NONCE-RAW-GUARD: the citizen nonce guard is missing from this checkout." }
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

# 2. live, before: non-minting baseline, the live worker is the base this wave was checked against, and the flag route's new notes ABSENT (so the propagation poll proves something)
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
$surfaceBefore = Get-Text $NEW_CODE_URL 30
if ($surfaceBefore.Code -ne "200") { Stop-Here "GET /api/surface answered $($surfaceBefore.Code) before the deploy, expected 200: investigate." }
if (Test-SurfaceCarriesFlagBinding $surfaceBefore.Body) { Stop-Here "GET /api/surface already documents the flag route's two bindings: this wave looks already deployed. Verify by hand; this script cannot prove a propagation it did not wait for." }
Say "[live] before: GET /api/surface does not document the flag route's two bindings (the new code is absent)"

if ($DryRun) {
  Say "[dry-run] would now: run npx wrangler deploy --var CODE_COMMIT:<the full sha> and capture its Current Version ID (refusing to continue without one); poll up to $POLL_TRIES times, $POLL_DELAY_SECONDS s apart, until GET /api/attest serves that commit and version id and GET /api/surface documents the flag route's two bindings; re-check attest (v5, template $($V5_HASH.Substring(0, 8)), every chain ok); ride the public reads, make ONE refused unbound flag POST to motion 999999 (its only trace is a rate-cap row) and read /skill.md once (which adds ONE door count). NO migration, NO D1 access and no other live write at any point. Nothing was deployed."
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
$ROLLBACK_LINE = "ROLL BACK THE WORKER (npx wrangler rollback, to the version before $versionId, which should be $rollbackTarget; check npx wrangler deployments list first). This wave applied no migration, so the rollback is the whole undo. A rollback restores the previous worker's unbound flag (a key citizen's flag with no signed intent, a resident's flag by token); a flag already set stays set, because a flag is one-way."
Wait-NewWorker $headSha $versionId $POLL_TRIES $POLL_DELAY_SECONDS
# END-DEPLOY-AND-POLL

# 4. the ride: non-minting and the chains, then the public reads, then ONE refused unbound flag, then /skill.md once, last.
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
# F5: the flag route's note on GET /api/surface names both bindings and no token
$surface = Get-Json "$BASE/api/surface"
$flagRoute = $null
foreach ($r in @($surface.routes)) { if ([string]$r.path -ceq $FLAG_ROUTE_PATH) { $flagRoute = $r } }
if ($null -eq $flagRoute) { Stop-Here "GET /api/surface lists no route $FLAG_ROUTE_PATH. $ROLLBACK_LINE" }
$flagNote = [string]$flagRoute.note
if (-not $flagNote.Contains($SURFACE_CITIZEN_PHRASE)) { Stop-Here "the flag route's note does not carry '$SURFACE_CITIZEN_PHRASE'. $ROLLBACK_LINE" }
if (-not $flagNote.Contains($SURFACE_RESIDENT_PHRASE)) { Stop-Here "the flag route's note does not carry '$SURFACE_RESIDENT_PHRASE'. $ROLLBACK_LINE" }
if (-not $flagNote.Contains("no token is read")) { Stop-Here "the flag route's note does not say no token is read. $ROLLBACK_LINE" }
if ($flagNote.Contains("{token}")) { Stop-Here "the flag route's note still offers a {token}. $ROLLBACK_LINE" }
Say "[ride] /api/surface: the flag route documents council_flag and resident_council_flag and says no token is read"
$llms = Get-Text "$BASE/llms.txt" 30
if ($llms.Code -ne "200") { Stop-Here "GET /llms.txt answered $($llms.Code). $ROLLBACK_LINE" }
if (-not $llms.Body.Contains($CREDENTIAL_PHRASE)) { Stop-Here "GET /llms.txt does not carry the credential sentence ('$CREDENTIAL_PHRASE'). $ROLLBACK_LINE" }
Say "[ride] /llms.txt: the credential sentence (ballots and flags are signed to the one act)"
$manifest = Get-Text "$BASE/.well-known/mcp.json" 30
if ($manifest.Code -ne "200") { Stop-Here "GET /.well-known/mcp.json answered $($manifest.Code). $ROLLBACK_LINE" }
if (-not $manifest.Body.Contains($MCP_MANIFEST_PHRASE)) { Stop-Here "GET /.well-known/mcp.json does not say '$MCP_MANIFEST_PHRASE'. $ROLLBACK_LINE" }
Say "[ride] /.well-known/mcp.json: council_ballot and council_flag are signed to the act"
# the earlier waves are still served, and the council reads as before
$official = Get-Json "$BASE/api/official"
if (@($official.PSObject.Properties.Name) -cnotcontains "rule7_revote") { Stop-Here "GET /api/official no longer carries rule7_revote: this deploy dropped the rulings wave. $ROLLBACK_LINE" }
$councilBefore = Get-Json "$BASE/api/council"
$councilRaw = Get-Text "$BASE/api/council" 30
if ($councilRaw.Code -ne "200") { Stop-Here "GET /api/council answered $($councilRaw.Code). $ROLLBACK_LINE" }
if ($councilRaw.Body.Contains("record_body")) { Stop-Here "GET /api/council carries a record_body key again: this deploy dropped the rulings wave. $ROLLBACK_LINE" }
if (-not $councilRaw.Body.Contains("a flag is one-way and public")) { Stop-Here "GET /api/council no longer says a flag is one-way and public. $ROLLBACK_LINE" }
Say "[ride] /api/official still carries rule7_revote; /api/council still serves no record_body and says a flag is one-way and public"
# THE ONE POST: an unbound flag against a motion that does not exist. No Authorization, no token, no assertion, an empty body. It is refused before any motion, nonce or credential is read.
Say "[note] making ONE refused POST now: an unbound flag (no credential, no assertion) to motion 999999. Its only trace is the rate-cap reservation row every council write route makes first."
$unbound = Post-Unbound $UNBOUND_FLAG_URL
if ($unbound.Code -notmatch '^4[0-9][0-9]$') { Stop-Here "the unbound flag POST answered $($unbound.Code), expected a 4xx refusal. $ROLLBACK_LINE" }
if ($unbound.Code -ne "401") { Stop-Here "the unbound flag POST answered $($unbound.Code), expected 401 (no credential and no assertion at all). $ROLLBACK_LINE" }
if (-not $unbound.Body.Contains("resident_council_flag")) { Stop-Here "the unbound flag refusal does not name resident_council_flag, so it is not this wave's refusal. $ROLLBACK_LINE" }
if (-not $unbound.Body.Contains("council_flag_unbound")) { Stop-Here "the unbound flag refusal does not carry the code council_flag_unbound. $ROLLBACK_LINE" }
$councilAfter = Get-Json "$BASE/api/council"
if ([string]$councilAfter.motions.total -cne [string]$councilBefore.motions.total) { Stop-Here ("GET /api/council motions total moved from " + $councilBefore.motions.total + " to " + $councilAfter.motions.total + " across the unbound flag POST: investigate. " + $ROLLBACK_LINE) }
Say "[ride] the unbound flag was refused 401 (council_flag_unbound, naming resident_council_flag) and the motions total is unchanged at $($councilAfter.motions.total)"
# /skill.md, read ONCE, last
Say "[note] reading /skill.md now, ONCE: that one 200 adds ONE to today's door_counts row (/heartbeat.md is never read)."
$skill = Get-Text "$BASE/skill.md" 30
if ($skill.Code -ne "200") { Stop-Here "GET /skill.md answered $($skill.Code). $ROLLBACK_LINE" }
if ($skill.Body -cnotmatch ('(?m)^' + [regex]::Escape($SKILL_VERSION_LINE) + '\r?$')) { Stop-Here "GET /skill.md does not carry the line '$SKILL_VERSION_LINE'. $ROLLBACK_LINE" }
if (-not $skill.Body.Contains($SKILL_FLAG_PHRASE)) { Stop-Here "GET /skill.md does not carry the council flag binding ('$SKILL_FLAG_PHRASE'). $ROLLBACK_LINE" }
if (-not $skill.Body.Contains($SKILL_RESIDENT_PHRASE)) { Stop-Here "GET /skill.md does not carry the resident flag binding ('$SKILL_RESIDENT_PHRASE'). $ROLLBACK_LINE" }
if (-not $skill.Body.Contains($CREDENTIAL_PHRASE)) { Stop-Here "GET /skill.md does not carry the credential sentence ('$CREDENTIAL_PHRASE'). $ROLLBACK_LINE" }
Say "[ride] /skill.md: $SKILL_VERSION_LINE, both flag bindings and the credential sentence"
Say "[note] Writes made by this ride: the one door count the /skill.md read added, and the one rate-cap row the refused unbound flag made. The bindings themselves (a key citizen's council_flag, a resident's resident_council_flag, replay and cross-op refusals) are proved by tests only: each needs a credential this script must not hold."
Say "[done] Council flag wave deployed and ridden. Log version id $versionId, commit $($headSha.Substring(0, 8)) and these lines in HANDOVER.md."
