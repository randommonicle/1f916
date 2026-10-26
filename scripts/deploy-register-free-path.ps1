# Deploys the 26 OCT REGISTER FREE-PATH WAVE: the register tool on /mcp leads with the free path (title "Register as a citizen ($1, HTTP only)", a description and a thrown error that name guest_enter first),
# and /heartbeat.md points a reader without a credential to section 6 (the free guest routine). Served text only. Brief: drafts/BRIEF-REGISTER-FREE-PATH-2026-10-26.md.
# ONE worker deploy. Ben's hand only (D-017). One fail-fast script (L-046, L-069). NO MIGRATION, NO D1 COMMAND, NO MINT: step 0 STOPS if migrations/, schema.sql or src/doc.ts differ between the live
# base and HEAD. Wrangler is used for exactly ONE thing: the stamped deploy. Pattern: scripts/deploy-register-free-path.ps1.
# TWO PINS. $LIVE_BASE_COMMIT is the commit the live worker serves when this runs (the max_id wave, 5528b8d4); step 2 PROVES it against the live GET /api/attest code.commit.
# $REVIEWED_COMMIT is the commit the review converged on. Step 0a STOPS, before any git or network command, while EITHER still holds its placeholder or is not 40 lower-case hex.
# THE DEPLOY STAMPS THE COMMIT: `npx wrangler deploy --var CODE_COMMIT:<sha>`. The poll waits until GET /api/attest serves code.commit equal to the pinned sha AND code.version_id equal to the
# Current Version ID wrangler printed AND POST /mcp tools/list serves the new register title AND GET /heartbeat.md carries the new opening line AND GET /api/proposals still serves max_id.
# The ROLLBACK TARGET is the version id GET /api/attest served BEFORE the deploy (read live, never typed in).
# REVIEWED SOURCE ONLY: step 0 also STOPS unless HEAD is $REVIEWED_COMMIT plus changes confined to $ALLOWED_PATHS_AFTER_REVIEW (this script, its test, docs/).
# Run from society/ on main, after the merge and the push:
#   cd "C:\Users\bengr\Projects\AI domain and social network\society"
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-register-free-path.ps1 -ExpectedCommit <sha> -DryRun   # every check and the live reads, nothing deployed
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-register-free-path.ps1 -ExpectedCommit <sha>           # the real thing
# <sha> is the pushed tip of main (git -C society rev-parse HEAD), the full 40 hex.
# THE RIDE holds no token, key or assertion and writes nothing of its own: public GETs, plus ONE read-only JSON-RPC POST to /mcp (tools/list; the server's own door counter records it).
# PowerShell 5.1 traps this file avoids: one spelling per variable name; -notmatch on an array filters instead of testing; a one-element return is wrapped in @(); "$var:" is a drive reference
# (write "${var}:"); never merge a native command's stderr under ErrorActionPreference Stop; -eq and -ne are case-INSENSITIVE (hashes and shas are compared with -ceq / -cne). ASCII only.
param(
  [Parameter(Mandatory = $true)][string]$ExpectedCommit,
  [switch]$DryRun
)
$ErrorActionPreference = "Stop"
$BASE = "https://commonhold.randommonicle.workers.dev"
# The attested constitution this wave must leave untouched (v6, minted 22 Oct).
$V6_HASH = "dc5f48213c29bcf844e0fbe7daf1bdb5416b3d57fbd06a8bd03f1061f34092b3"
# The commit the live worker serves when this runs (the max_id wave, 5528b8d4).
$LIVE_BASE_COMMIT = "5528b8d40d3577b806fe7b26fd5c0e3b5c241575"
$LIVE_BASE_PLACEHOLDER = "TO-BE-SET-BY-HUB-LIVE-BASE"
# THE REVIEWED SOURCE. The hub replaces this placeholder with the full sha the review converged on; step 0 STOPS while it is unchanged, and while it is not 40 lower-case hex.
$REVIEWED_COMMIT = "TO-BE-SET-BY-HUB"
$REVIEWED_COMMIT_PLACEHOLDER = "TO-BE-SET-BY-HUB"
$ALLOWED_PATHS_AFTER_REVIEW = @("scripts/deploy-register-free-path.ps1", "test/deploy-register-free-path-script.test.ts", "docs/")
$PROPOSALS_URL = "$BASE/api/proposals"
$HEARTBEAT_URL = "$BASE/heartbeat.md"
$MCP_URL = "$BASE/mcp"
$NEW_REGISTER_TITLE = 'Register as a citizen ($1, HTTP only)'
$NEW_HEARTBEAT_LINE = "No credential? Taking part is free as a guest: go to section 6, the guest routine."
$DOLLAR_ONE = '$1'
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
# "" when a GET /api/proposals answer serves max_id as this wave defines it, otherwise the reason it is not: 200, JSON, an integer max_id and max_id_note, one page (has_more false), every
# served id at or below max_id, a served row carrying max_id itself, and no id served twice (with those, max_id minus total is the count of ids from 1 to max_id no row carries).
function Test-MaxIdServed($r) {
  if ($r.Code -ne "200") { return ("GET /api/proposals answered " + $r.Code + ", expected 200") }
  try { $j = ($r.Body | ConvertFrom-Json) } catch { return "GET /api/proposals did not return JSON" }
  if ($null -eq $j) { return "GET /api/proposals returned an empty body" }
  $names = @($j.PSObject.Properties | ForEach-Object { $_.Name })
  if (-not ($names -ccontains "max_id")) { return "GET /api/proposals carries no max_id field" }
  if (-not ($names -ccontains "max_id_note") -or -not $j.max_id_note) { return "GET /api/proposals carries no max_id_note" }
  if ($null -eq $j.max_id -or -not ($j.max_id -is [int] -or $j.max_id -is [long]) -or [long]$j.max_id -lt 1) { return ("max_id is '" + $j.max_id + "', expected a JSON whole number of at least 1 (the live table is not empty)") }
  if ($j.has_more -ne $false) { return "GET /api/proposals has_more is not false: this check reads one page only" }
  $maxN = [int]$j.max_id
  $totalN = [int]$j.total
  $ids = @($j.proposals | ForEach-Object { [int]$_.id })
  if ($ids.Count -ne $totalN) { return ("the page carries " + $ids.Count + " rows but total is " + $totalN) }
  foreach ($i in $ids) { if ($i -gt $maxN) { return ("a served row has id " + $i + ", above max_id " + $maxN) } }
  if (-not ($ids -contains $maxN)) { return ("no served row carries max_id " + $maxN + ": max_id is not the highest id a row carries") }
  if (@($ids | Select-Object -Unique).Count -ne $ids.Count) { return "the page serves a proposal id twice" }
  return ""
}
# POST a JSON-RPC tools/list to /mcp (read-only; the body is fixed, nothing from the caller). Same shape as Get-Text.
function Get-ToolsList {
  $tmp = [System.IO.Path]::GetTempFileName()
  try {
    $meta = (curl.exe -s --max-time 30 -X POST -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' -o $tmp -w "%{http_code}|%{content_type}" $MCP_URL)
    $parts = ([string]$meta).Split("|", 2)
    $body = (Get-Content $tmp -Raw -ErrorAction SilentlyContinue)
    if ($null -eq $body) { $body = "" }
    return @{ Code = [string]$parts[0]; Body = $body }
  } finally {
    Remove-Item $tmp -ErrorAction SilentlyContinue
  }
}
# "" when a tools/list answer carries the register tool with the new title and a description that opens with the free path (guest_enter and free before the dollar), otherwise the reason it does not.
function Test-RegisterFreeServed($r) {
  if ($r.Code -ne "200") { return ("POST /mcp tools/list answered " + $r.Code + ", expected 200") }
  try { $j = ($r.Body | ConvertFrom-Json) } catch { return "POST /mcp tools/list did not return JSON" }
  if ($null -eq $j -or $null -eq $j.result -or $null -eq $j.result.tools) { return "POST /mcp tools/list carries no result.tools" }
  $reg = @($j.result.tools | Where-Object { $_.name -ceq "register" })
  if ($reg.Count -ne 1) { return ("tools/list carries " + $reg.Count + " register tools, expected 1") }
  if ([string]$reg[0].title -cne $NEW_REGISTER_TITLE) { return ("the register title is '" + $reg[0].title + "', expected '" + $NEW_REGISTER_TITLE + "'") }
  $d = [string]$reg[0].description
  $iGuest = $d.IndexOf("guest_enter", [System.StringComparison]::Ordinal)
  $iFree = $d.IndexOf("free", [System.StringComparison]::Ordinal)
  $iDollar = $d.IndexOf($DOLLAR_ONE,[System.StringComparison]::Ordinal)
  if ($iGuest -lt 0 -or $iFree -lt 0 -or $iDollar -lt 0) { return "the register description does not name guest_enter, free and the dollar price" }
  if ($iGuest -gt $iDollar -or $iFree -gt $iDollar) { return "the register description does not lead with the free path (guest_enter and free must come before the dollar price)" }
  if (-not $d.Contains("POST /api/register")) { return "the register description no longer names POST /api/register" }
  if (-not $d.Contains("this MCP door cannot carry one")) { return "the register description lost the phrase 'this MCP door cannot carry one'" }
  return ""
}
# "" when a GET /heartbeat.md answer carries the new opening line before the citizen routine, otherwise the reason it does not.
function Test-HeartbeatFreeServed($r) {
  if ($r.Code -ne "200") { return ("GET /heartbeat.md answered " + $r.Code + ", expected 200") }
  $b = [string]$r.Body
  $iLine = $b.IndexOf($NEW_HEARTBEAT_LINE, [System.StringComparison]::Ordinal)
  if ($iLine -lt 0) { return "GET /heartbeat.md does not carry the new opening line" }
  $iRoutine = $b.IndexOf("A routine for an agent that holds", [System.StringComparison]::Ordinal)
  if ($iRoutine -ge 0 -and $iLine -gt $iRoutine) { return "the new opening line comes after the citizen routine's opening" }
  return ""
}
# Polls until the served block is this deploy's AND the register tool, /heartbeat.md and GET /api/proposals (max_id) serve this wave, or STOPS (with $ROLLBACK_LINE) after $tries reads.
function Wait-NewWorker($commit, $versionId, $tries, $delaySeconds) {
  $last = "never read"
  for ($n = 1; $n -le $tries; $n++) {
    $why = Test-CodeIdentityServed (Get-ServedCode) $commit $versionId
    if ($why -eq "") { $why = Test-RegisterFreeServed (Get-ToolsList) }
    if ($why -eq "") { $why = Test-HeartbeatFreeServed (Get-Text $HEARTBEAT_URL 30) }
    if ($why -eq "") { $why = Test-MaxIdServed (Get-Text $PROPOSALS_URL 30) }
    if ($why -eq "") {
      Say "[poll] try $n of ${tries}: GET /api/attest serves code.commit $($commit.Substring(0, 8)) and code.version_id $versionId; POST /mcp tools/list serves the new register title; GET /heartbeat.md carries the new opening line; GET /api/proposals serves max_id"
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
if (-not (Select-String -Path "src/mcp.ts" -Pattern "Register as a citizen" -SimpleMatch -Quiet)) { Stop-Here "src/mcp.ts has no new register title: this checkout is not the register free-path wave." }
if (-not (Select-String -Path "src/governance.ts" -Pattern "MAX(id) AS max_id FROM proposals" -SimpleMatch -Quiet)) { Stop-Here "src/governance.ts does not read MAX(id) AS max_id: this checkout would drop the max_id wave." }
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

# 2. live, before: non-minting baseline, the live worker is the base this wave was checked against, and the new text is not served yet (so the propagation poll proves something)
$attBefore = Read-Attest "before the deploy"
Assert-Attest $attBefore "before the deploy"
Say ("[live] before: v6 " + $V6_HASH.Substring(0, 8) + "; all four chains ok; identity " + $attBefore.identity_log.sealed_entries + ", treasury " + $attBefore.treasury.sealed_entries + ", ballots " + $attBefore.ballots.sealed_entries)
if ($null -eq $attBefore.code -or [string]$attBefore.code.commit_status -cne "stamped") { Stop-Here "GET /api/attest serves no stamped code.commit before the deploy: the live worker cannot be shown to be the base this wave was checked against." }
if ([string]$attBefore.code.commit -ceq $headSha) { Stop-Here "GET /api/attest already serves code.commit $($headSha.Substring(0, 8)): this commit looks already deployed. Verify by hand." }
if ([string]$attBefore.code.commit -cne $LIVE_BASE_COMMIT) { Stop-Here ("the live worker serves code.commit " + $attBefore.code.commit + " but `$LIVE_BASE_COMMIT is " + $LIVE_BASE_COMMIT + ": the base this wave was checked against is not what is live. Correct the pin only after reading what changed.") }
$rollbackTarget = "the version before it (check npx wrangler deployments list)"
if ([string]$attBefore.code.version_status -ceq "available" -and $attBefore.code.version_id) { $rollbackTarget = [string]$attBefore.code.version_id }
Say "[live] before: the live worker serves the pinned base $($LIVE_BASE_COMMIT.Substring(0, 8)); rollback target $rollbackTarget"
$toolsBefore = Get-ToolsList
if ($toolsBefore.Code -ne "200") { Stop-Here "POST /mcp tools/list answered $($toolsBefore.Code) before the deploy, expected 200." }
if (([string]$toolsBefore.Body).Contains($NEW_REGISTER_TITLE)) { Stop-Here "POST /mcp tools/list already serves the new register title: this wave looks already deployed. Verify by hand; this script cannot prove a propagation it did not wait for." }
$heartbeatBefore = Get-Text $HEARTBEAT_URL 30
if ($heartbeatBefore.Code -ne "200") { Stop-Here "GET /heartbeat.md answered $($heartbeatBefore.Code) before the deploy, expected 200." }
if (([string]$heartbeatBefore.Body).Contains($NEW_HEARTBEAT_LINE)) { Stop-Here "GET /heartbeat.md already carries the new opening line: this wave looks already deployed. Verify by hand." }
$proposalsBefore = Get-Text $PROPOSALS_URL 30
$whyBefore = Test-MaxIdServed $proposalsBefore
if ($whyBefore -ne "") { Stop-Here "GET /api/proposals does not serve max_id before the deploy ($whyBefore): the live worker is not the max_id wave this one rides on." }
Say "[live] before: the register title and the heartbeat line are the old ones (the new text is absent); GET /api/proposals serves max_id"

if ($DryRun) {
  Say "[dry-run] would now: run npx wrangler deploy --var CODE_COMMIT:<the full sha> and capture its Current Version ID (refusing to continue without one); poll up to $POLL_TRIES times, $POLL_DELAY_SECONDS s apart, until GET /api/attest serves that commit and version id, POST /mcp tools/list serves the new register title, GET /heartbeat.md carries the new opening line and GET /api/proposals still serves max_id; then ride the reads. Nothing was deployed."
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

# 4. the ride: non-minting and the chains, the register tool and the heartbeat line, max_id still served, then a sweep of public reads.
$attAfter = Read-Attest "after the deploy"
Assert-Attest $attAfter "after the deploy"
Say ("[ride] attest: v6 " + $V6_HASH.Substring(0, 8) + " unchanged; every chain ok")
$why = Test-RegisterFreeServed (Get-ToolsList)
if ($why -ne "") { Stop-Here "$why. $ROLLBACK_LINE" }
Say ("[ride] POST /mcp tools/list -> register title '" + $NEW_REGISTER_TITLE + "', description leads with the free path")
$why = Test-HeartbeatFreeServed (Get-Text $HEARTBEAT_URL 30)
if ($why -ne "") { Stop-Here "$why. $ROLLBACK_LINE" }
Say "[ride] GET /heartbeat.md -> the new opening line comes first"
$proposalsNow = Get-Text $PROPOSALS_URL 30
$why = Test-MaxIdServed $proposalsNow
if ($why -ne "") { Stop-Here "$why. $ROLLBACK_LINE" }
$served = ($proposalsNow.Body | ConvertFrom-Json)
Say ("[ride] GET /api/proposals -> total " + $served.total + ", max_id " + $served.max_id + ", ids " + (@($served.proposals | ForEach-Object { $_.id }) -join ","))
$bad = @()
foreach ($p in "/", "/api/official", "/openapi.json", "/treasury", "/api/listings", "/api/stats", "/api/topics", "/api/guest/due", "/api/citizens", "/api/doors", "/api/council", "/api/residents", "/heartbeat.md", "/skill.md", "/llms.txt", "/privacy", "/api/proposal/8") {
  $r = Get-Text "$BASE$p" 30
  if ($r.Code -ne "200") { $bad += "$p=$($r.Code)" }
}
if ($bad.Count -gt 0) { Stop-Here ("non-200 after the deploy (version $versionId): " + ($bad -join ", ") + ". If a read that answered before now fails: $ROLLBACK_LINE") }
Say "[ride] 17 public reads -> 200"
Say "[note] This ride made GET requests and one tools/list POST (read-only; the door counter records it): it wrote nothing else. The thrown register error is the one thing not ridden here; call the register tool once by hand and read the first sentence (it must begin: Taking part is free on this door: guest_enter, then guest_comment)."
Say "[done] register free-path wave deployed and ridden. Log version id $versionId, commit $($headSha.Substring(0, 8)) and these lines in HANDOVER.md."
