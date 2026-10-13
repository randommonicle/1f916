# Deploys the 13 OCT DOOR FUNNEL WAVE (build log docs/CHECKPOINT-DOOR-FUNNEL.md; brief docs/BRIEF-DOOR-FUNNEL-2026-10-13.md): GET /api/doors now counts a received tools/list and a received tools/call on each
# MCP door (mcp_tools_list, mcp_read_tools_list, mcp_tool_call, mcp_read_tool_call), beside the handshake. ONE worker deploy. Ben's hand only (D-017). One fail-fast script (L-046, L-069).
# NO MIGRATION, NO D1 COMMAND: door_counts.door is TEXT with no CHECK, so a new door name is just a new row (the stale door list in migrations/0019 and schema.sql is a comment only). Step 0 STOPS if
# migrations/ or schema.sql differ between the live base and HEAD, so a wave that quietly grew one cannot ride this script. Wrangler is used for exactly ONE thing here: the stamped deploy.
# WRITTEN BY THE BUILDER AND NEVER RUN: not even -DryRun (which reads the live worker over HTTP). The Sonnet gate (the brief's A5), the merge and the push come before it.
# TWO PINS. $LIVE_BASE_COMMIT is the commit the live worker serves when this runs (the council flag wave, worker cfb3cfe5) and is set; step 2 PROVES it against the live GET /api/attest code.commit at run
# time. $REVIEWED_COMMIT is the commit the review converged on and holds the hub's placeholder until the hub sets it. Step 0a STOPS, before any git or network command, while EITHER still holds its
# placeholder or is not 40 lower-case hex.
# NO MINT: this wave edits src/doc.ts NOT AT ALL, so the check is the template text itself: step 0 extracts FRONT_DOOR_TEMPLATE from src/doc.ts at $LIVE_BASE_COMMIT and at HEAD and STOPS if they differ
# by a byte. After the deploy it STOPS if the constitution is not still v5 with its template hash.
# THE DEPLOY STAMPS THE COMMIT: `npx wrangler deploy --var CODE_COMMIT:<sha>` (served code identity). The poll after the deploy waits until GET /api/attest serves code.commit equal to the pinned sha
# AND code.version_id equal to the Current Version ID wrangler printed AND the GET /api/doors note names all four new doors (a sentence only this wave serves; the pre-deploy probe proves it is absent
# first). The ROLLBACK TARGET is the version id GET /api/attest served BEFORE the deploy (read live, never typed in).
# REVIEWED SOURCE ONLY: step 0 also STOPS unless HEAD is $REVIEWED_COMMIT plus changes confined to $ALLOWED_PATHS_AFTER_REVIEW (this script, its test, docs/).
# Run from society/ on main, after the merge and the push:
#   cd "C:\Users\bengr\Projects\AI domain and social network\society"
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-door-funnel.ps1 -ExpectedCommit <sha> -DryRun   # every check and the live reads, nothing deployed
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-door-funnel.ps1 -ExpectedCommit <sha>           # the real thing
# <sha> is the pushed tip of main (git -C society rev-parse HEAD), the full 40 hex.
# THE RIDE (the brief's A5) IS PUBLIC GETs PLUS FOUR READ-ONLY JSON-RPC POSTs, and it holds no token, key or assertion. It reads GET /api/doors for today, sends ONE tools/list and ONE tools/call of the
# read tool front_page to EACH of /mcp and /mcp/read (four POSTs, no initialize, no write tool, no guest tool), then reads GET /api/doors again and requires each of the four new rows to have moved by
# AT LEAST one. "At least", because other callers may count on the same doors while the ride runs; the script says so. THE RIDE ADDS FOUR DOOR COUNTS (one per new door) and nothing else: front_page
# and tools/list write no row, and no other door is touched. The counts are handed to the worker's waitUntil, so the second read retries a few times before it gives up.
# PowerShell 5.1 traps this file avoids (all seen live): $COLS and $cols are the SAME variable (one spelling per name here); -notmatch on an array filters instead of testing;
# a one-element return is wrapped in @(); "$var:" is a drive reference (write "${var}:"); an Invoke-WebRequest 4xx body is in $_.ErrorDetails.Message; never merge a native command's stderr
# under ErrorActionPreference Stop; -eq and -ne are case-INSENSITIVE (hashes, shas and states are compared with -ceq / -cne); a JSON body with quotes is passed to curl.exe through a file, never an
# argument. ASCII only: 5.1 reads a BOM-less UTF-8 script as the ANSI code page.
param(
  [Parameter(Mandatory = $true)][string]$ExpectedCommit,
  [switch]$DryRun
)
$ErrorActionPreference = "Stop"
$BASE = "https://commonhold.randommonicle.workers.dev"
# The attested constitution this wave must leave untouched.
$V5_HASH = "fa11788d062b0c6d23c54c428c1c9649d263ae3ba704e602e122066926049491"
# The commit the live worker serves when this runs (the council flag wave, worker cfb3cfe5). Step 0 STOPS while it holds the placeholder, and while it is not 40 lower-case hex.
$LIVE_BASE_COMMIT = "b7cf4182868a84b8a15d311a22f1f490ace6d920"
$LIVE_BASE_PLACEHOLDER = "TO-BE-SET-BY-HUB-LIVE-BASE"
# THE REVIEWED SOURCE. The hub replaces this placeholder with the full sha the review converged on; step 0 STOPS while it is unchanged, and while it is not 40 lower-case hex.
$REVIEWED_COMMIT = "TO-BE-SET-BY-HUB"
$REVIEWED_COMMIT_PLACEHOLDER = "TO-BE-SET-BY-HUB"
$ALLOWED_PATHS_AFTER_REVIEW = @("scripts/deploy-door-funnel.ps1", "test/deploy-door-funnel-script.test.ts", "docs/")
# The four doors this wave adds, in the order the ride reports them.
$NEW_DOORS = @("mcp_tools_list", "mcp_read_tools_list", "mcp_tool_call", "mcp_read_tool_call")
# The propagation poll waits for THIS to appear on GET /api/doors (a note naming all four doors, only this wave serves it); the pre-deploy probe proves it is absent first.
$NEW_CODE_URL = "$BASE/api/doors"
$MCP_FULL_URL = "$BASE/mcp"
$MCP_READ_URL = "$BASE/mcp/read"
$DOORS_NOTE_PHRASE = "any outcome"
$DOORS_NOTE_NOT_AGENTS = "Requests, not agents"
$READ_TOOL = "front_page"
$POLL_TRIES = 12
$POLL_DELAY_SECONDS = 5
$MOVE_TRIES = 6
$MOVE_DELAY_SECONDS = 3
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
# A JSON-RPC POST (the ride only): the body goes to curl.exe through a file, because PowerShell 5.1 strips the double quotes out of a native-command argument. No Authorization header, no credential.
function Post-Rpc($url, $json) {
  $tmpBody = [System.IO.Path]::GetTempFileName()
  $tmpOut = [System.IO.Path]::GetTempFileName()
  try {
    [System.IO.File]::WriteAllText($tmpBody, $json, (New-Object System.Text.UTF8Encoding($false)))
    $code = (curl.exe -s --max-time 30 -X POST -H "content-type: application/json" --data-binary "@$tmpBody" -o $tmpOut -w "%{http_code}" $url)
    $body = (Get-Content $tmpOut -Raw -ErrorAction SilentlyContinue)
    if ($null -eq $body) { $body = "" }
    return @{ Code = "$code"; Body = $body }
  } finally {
    Remove-Item $tmpBody -ErrorAction SilentlyContinue
    Remove-Item $tmpOut -ErrorAction SilentlyContinue
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
# $true when the JSON text of GET /api/doors carries a note that names ALL FOUR new doors (ordinal, case-sensitive). $false on anything unreadable: absent is never inferred from a failed read by the
# caller (the pre-deploy probe reads the status code first).
function Test-DoorsNoteCarriesFunnel($body) {
  try { $o = ([string]$body | ConvertFrom-Json) } catch { return $false }
  if ($null -eq $o) { return $false }
  $note = [string]$o.note
  foreach ($d in $NEW_DOORS) {
    if (-not $note.Contains($d)) { return $false }
  }
  return $true
}
# Today's count for each door in $names from the JSON text of GET /api/doors: a hashtable door -> n (0 when the door has no row for $day; a row of another day is ignored). The caller reads at_cap itself.
# $null when the text is not JSON or carries no rows array.
function Get-DoorCounts($body, $day, $names) {
  try { $o = ([string]$body | ConvertFrom-Json) } catch { return $null }
  if ($null -eq $o -or $null -eq $o.rows) { return $null }
  $counts = @{}
  foreach ($d in $names) { $counts[$d] = 0 }
  foreach ($r in @($o.rows)) {
    if ([string]$r.day -ceq $day) {
      foreach ($d in $names) {
        if ([string]$r.door -ceq $d) { $counts[$d] = [int64]$r.n }
      }
    }
  }
  return $counts
}
# The doors in $names whose count in $after did not rise above the count in $before. An empty list is success ("at least one": other callers may add more).
function Get-UnmovedDoors($before, $after, $names) {
  $stuck = @()
  foreach ($d in $names) {
    if ([int64]$after[$d] -lt ([int64]$before[$d] + 1)) { $stuck += $d }
  }
  return $stuck
}
# Polls until the served block is this deploy's AND the doors note names the four new doors, or STOPS (with $ROLLBACK_LINE) after $tries reads.
function Wait-NewWorker($commit, $versionId, $tries, $delaySeconds) {
  $last = "never read"
  for ($n = 1; $n -le $tries; $n++) {
    $why = Test-CodeIdentityServed (Get-ServedCode) $commit $versionId
    if ($why -eq "") {
      $route = Get-Text $NEW_CODE_URL 30
      if ($route.Code -eq "200" -and (Test-DoorsNoteCarriesFunnel $route.Body)) {
        Say "[poll] try $n of ${tries}: GET /api/attest serves code.commit $($commit.Substring(0, 8)) and code.version_id $versionId; GET /api/doors names the four new doors"
        return
      }
      $why = "GET /api/doors answered $($route.Code) and its note does not yet name the four new doors"
    }
    $last = $why
    Say "[poll] try $n of ${tries}: not yet: $why"
    if ($n -lt $tries) { Start-Sleep -Seconds $delaySeconds }
  }
  Stop-Here ("the new worker was never shown live in " + $tries + " reads (last: " + $last + "). The deploy is not shown to be live. " + $ROLLBACK_LINE)
}
# END-OF-DEFINITIONS (test/deploy-door-funnel-script.test.ts reads everything above this line as definitions; nothing above runs git, npm, wrangler or the network)

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
if (-not (Select-String -Path "src/doors.ts" -Pattern '"mcp_read_tool_call"' -Quiet)) { Stop-Here "src/doors.ts does not list mcp_read_tool_call: this checkout is not the door funnel wave." }
if (-not (Select-String -Path "src/doors.ts" -Pattern "DEFERRED-LISTING-ATTRIBUTION" -Quiet)) { Stop-Here "src/doors.ts has no DEFERRED-LISTING-ATTRIBUTION flag: this checkout is not the door funnel wave." }
if (-not (Select-String -Path "src/mcp.ts" -Pattern 'recordDoor\(env, ctx, "mcp_tool_call"\)' -Quiet)) { Stop-Here "src/mcp.ts does not count mcp_tool_call: this checkout is not the door funnel wave." }
if (-not (Select-String -Path "src/mcp.ts" -Pattern 'recordDoor\(env, ctx, "mcp_tools_list"\)' -Quiet)) { Stop-Here "src/mcp.ts does not count mcp_tools_list: this checkout is not the door funnel wave." }
if (-not (Select-String -Path "src/mcp-read.ts" -Pattern 'recordDoor\(env, ctx, "mcp_read_tool_call"\)' -Quiet)) { Stop-Here "src/mcp-read.ts does not count mcp_read_tool_call: this checkout is not the door funnel wave." }
if (-not (Select-String -Path "src/mcp-read.ts" -Pattern 'recordDoor\(env, ctx, "mcp_read_tools_list"\)' -Quiet)) { Stop-Here "src/mcp-read.ts does not count mcp_read_tools_list: this checkout is not the door funnel wave." }
if (-not (Select-String -Path "src/council-core.ts" -Pattern "export const citizenCouncilFlagParts" -Quiet)) { Stop-Here "src/council-core.ts has no citizenCouncilFlagParts: this checkout would drop the council flag wave." }
if (-not (Select-String -Path "src/council.ts" -Pattern "export async function claimCouncilSeat" -Quiet)) { Stop-Here "src/council.ts has no claimCouncilSeat: this checkout would drop the council." }
if (-not (Select-String -Path "src/resident.ts" -Pattern "export async function bindResident" -Quiet)) { Stop-Here "src/resident.ts has no bindResident: this checkout would drop the resident tier." }
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

# 2. live, before: non-minting baseline, the live worker is the base this wave was checked against, and the doors note does NOT yet name the four new doors (so the propagation poll proves something)
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
$doorsBefore = Get-Text $NEW_CODE_URL 30
if ($doorsBefore.Code -ne "200") { Stop-Here "GET /api/doors answered $($doorsBefore.Code) before the deploy, expected 200: investigate." }
if (Test-DoorsNoteCarriesFunnel $doorsBefore.Body) { Stop-Here "GET /api/doors already names the four new doors: this wave looks already deployed. Verify by hand; this script cannot prove a propagation it did not wait for." }
Say "[live] before: GET /api/doors does not name the four new doors (the new code is absent)"

if ($DryRun) {
  Say "[dry-run] would now: run npx wrangler deploy --var CODE_COMMIT:<the full sha> and capture its Current Version ID (refusing to continue without one); poll up to $POLL_TRIES times, $POLL_DELAY_SECONDS s apart, until GET /api/attest serves that commit and version id and the GET /api/doors note names the four new doors; re-check attest (v5, template $($V5_HASH.Substring(0, 8)), every chain ok); ride the public reads, read GET /api/doors, send ONE tools/list and ONE tools/call of $READ_TOOL to each of /mcp and /mcp/read (four read-only POSTs that add FOUR door counts, one per new door) and read GET /api/doors again. NO migration, NO D1 access and no other live write at any point. Nothing was deployed."
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
$ROLLBACK_LINE = "ROLL BACK THE WORKER (npx wrangler rollback, to the version before $versionId, which should be $rollbackTarget; check npx wrangler deployments list first). This wave applied no migration, so the rollback is the whole undo. A rollback restores the previous worker, which counts the handshake and the two guest writes only: the four new door rows already written stay, and simply stop growing."
Wait-NewWorker $headSha $versionId $POLL_TRIES $POLL_DELAY_SECONDS
# END-DEPLOY-AND-POLL

# 4. the ride: non-minting and the chains, then the public reads, the doors note, then the four read-only POSTs and the doors read back.
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
# the served words: the doors note names the four doors and says what they count; the route description on /api/surface names them too
$doorsNow = Get-Text "$BASE/api/doors" 30
if ($doorsNow.Code -ne "200") { Stop-Here "GET /api/doors answered $($doorsNow.Code). $ROLLBACK_LINE" }
if (-not (Test-DoorsNoteCarriesFunnel $doorsNow.Body)) { Stop-Here "the GET /api/doors note does not name all four new doors. $ROLLBACK_LINE" }
$doorsNote = [string](($doorsNow.Body | ConvertFrom-Json).note)
if (-not $doorsNote.Contains($DOORS_NOTE_PHRASE)) { Stop-Here "the GET /api/doors note does not say '$DOORS_NOTE_PHRASE'. $ROLLBACK_LINE" }
if (-not $doorsNote.Contains($DOORS_NOTE_NOT_AGENTS)) { Stop-Here "the GET /api/doors note no longer says '$DOORS_NOTE_NOT_AGENTS'. $ROLLBACK_LINE" }
$surface = Get-Json "$BASE/api/surface"
$doorsRoute = $null
foreach ($r in @($surface.routes)) { if ([string]$r.path -ceq "/api/doors") { $doorsRoute = $r } }
if ($null -eq $doorsRoute) { Stop-Here "GET /api/surface lists no route /api/doors. $ROLLBACK_LINE" }
foreach ($d in $NEW_DOORS) {
  if (-not ([string]$doorsRoute.description).Contains($d)) { Stop-Here "the /api/doors route description on /api/surface does not name $d. $ROLLBACK_LINE" }
}
Say "[ride] /api/doors: the note and the route description name the four new doors, say any outcome and still say requests, not agents"
# the funnel itself. The UTC day is read twice and must be the same day, or the second read is not comparable with the first.
$rideDay = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd")
$countsBefore = Get-DoorCounts $doorsNow.Body $rideDay $NEW_DOORS
if ($null -eq $countsBefore) { Stop-Here "GET /api/doors carried no rows array. $ROLLBACK_LINE" }
foreach ($r in @(($doorsNow.Body | ConvertFrom-Json).rows)) {
  if ([string]$r.day -ceq $rideDay -and $r.at_cap -eq $true -and ($NEW_DOORS -ccontains [string]$r.door)) { Stop-Here "the $($r.door) row for $rideDay is already at its daily cap, so a ride cannot show it move. Read GET /api/doors by hand instead." }
}
Say ("[ride] today (" + $rideDay + ") before: " + (($NEW_DOORS | ForEach-Object { $_ + "=" + $countsBefore[$_] }) -join ", "))
Say "[note] making FOUR read-only POSTs now: ONE tools/list and ONE tools/call of $READ_TOOL to each of /mcp and /mcp/read. No handshake request, no write tool, no credential. This ride adds FOUR door counts, one per new door."
$listJson = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
$callJson = '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"' + $READ_TOOL + '","arguments":{}}}'
foreach ($door in @($MCP_FULL_URL, $MCP_READ_URL)) {
  $list = Post-Rpc $door $listJson
  if ($list.Code -ne "200") { Stop-Here "POST $door tools/list answered $($list.Code), expected 200. $ROLLBACK_LINE" }
  if (-not $list.Body.Contains('"' + $READ_TOOL + '"')) { Stop-Here "POST $door tools/list does not list $READ_TOOL. $ROLLBACK_LINE" }
  $callResult = Post-Rpc $door $callJson
  if ($callResult.Code -ne "200") { Stop-Here "POST $door tools/call $READ_TOOL answered $($callResult.Code), expected 200. $ROLLBACK_LINE" }
  if ($callResult.Body.Contains('"isError"')) { Stop-Here "POST $door tools/call $READ_TOOL answered an error result. $ROLLBACK_LINE" }
  Say "[ride] $door : tools/list and tools/call $READ_TOOL answered 200"
}
# The counts are handed to the worker's waitUntil, so they can land a moment after the answer: read back a few times before giving up. "At least one": other callers may have counted too.
$stuck = @($NEW_DOORS)
for ($n = 1; $n -le $MOVE_TRIES; $n++) {
  $doorsAfter = Get-Text "$BASE/api/doors" 30
  if ($doorsAfter.Code -ne "200") { Stop-Here "GET /api/doors answered $($doorsAfter.Code) after the four POSTs. $ROLLBACK_LINE" }
  $countsAfter = Get-DoorCounts $doorsAfter.Body $rideDay $NEW_DOORS
  if ($null -eq $countsAfter) { Stop-Here "GET /api/doors carried no rows array after the four POSTs. $ROLLBACK_LINE" }
  $stuck = @(Get-UnmovedDoors $countsBefore $countsAfter $NEW_DOORS)
  if ($stuck.Count -eq 0) { break }
  Say "[ride] read-back $n of ${MOVE_TRIES}: not yet moved: $($stuck -join ', ')"
  if ($n -lt $MOVE_TRIES) { Start-Sleep -Seconds $MOVE_DELAY_SECONDS }
}
$rideDayAfter = (Get-Date).ToUniversalTime().ToString("yyyy-MM-dd")
if ($rideDayAfter -cne $rideDay) { Stop-Here "the UTC day rolled from $rideDay to $rideDayAfter during the ride, so the two reads are not comparable. Read GET /api/doors by hand." }
if ($stuck.Count -gt 0) { Stop-Here ("these door counts did not rise by at least one after the four POSTs: " + ($stuck -join ", ") + ". The deploy served the new words but the counting is not shown (if this machine's clock is not on the UTC day the server counts under, read GET /api/doors by hand). " + $ROLLBACK_LINE) }
Say ("[ride] today (" + $rideDay + ") after:  " + (($NEW_DOORS | ForEach-Object { $_ + "=" + $countsAfter[$_] }) -join ", ") + " (each rose by at least one; other callers may add more)")
Say "[note] Writes made by this ride: FOUR door counts, one on each of mcp_tools_list, mcp_read_tools_list, mcp_tool_call and mcp_read_tool_call. Nothing else. These four requests count as requests, not agents."
Say "[done] Door funnel wave deployed and ridden. Log version id $versionId, commit $($headSha.Substring(0, 8)) and these lines in HANDOVER.md."
