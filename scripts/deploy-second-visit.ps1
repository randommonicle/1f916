# Deploys the 22 OCT SECOND-VISIT WAVE AND CONSTITUTION V6 (build log docs/CHECKPOINT-SECOND-VISIT.md): the guest return advice in both MCP initialisers, the open standing topics in the guest_enter answer,
# next_visit and continuity in the guest_comment answer, /skill.md 1.4.4, the operator block in /llms.txt, the MCP manifest and OpenAPI, and (phase 2) the v6 FRONT_DOOR_TEMPLATE: the VISIT FIRST, FREE
# section, the four guest corrections, the conditional 402 wording and the grouped MCP tool list. THIS DEPLOY MINTS CONSTITUTION v6 (an operator act, changed_by operator).
# ONE worker deploy. Ben's hand only (D-017). One fail-fast script (L-046, L-069). NO MIGRATION, NO D1 COMMAND: step 0 STOPS if migrations/ or schema.sql differ between the live base and HEAD.
# THE MINT: step 0 compares FRONT_DOOR_TEMPLATE in src/doc.ts at $REVIEWED_COMMIT and at HEAD byte for byte (they must be equal: what ships is the template that was reviewed) and also STOPS if the
# template equals the live base's (then this would not be the v6 mint). The version row and the identity-log row are written by the first of GET /, the public governance sweep or a cron wake
# to reach the new worker (src/index.ts:168-190, src/governance.ts:1740-1751, src/maintainer/clerk.ts:451-462, src/maintainer/judgment.ts:1615-1628); detectConstitutionChange
# runs on each of them, and GET /api/attest is read-only. The ride still requests GET / FIRST so the row exists before it reads /api/attest for version 6 with changed_by operator and template_hash $V6_HASH.
# Wrangler is used for exactly ONE thing: the stamped deploy.
# WRITTEN BY THE BUILDER AND NEVER RUN: not even -DryRun (which reads the live worker over HTTP). The review, the merge and the push come before it.
# TWO PINS. $LIVE_BASE_COMMIT is the commit the live worker serves when this runs. IT ASSUMES THE PRIVACY WAVE IS DEPLOYED FIRST: 773ce09f is the local main with the privacy wave merged; if the
# live worker is anything else, step 2 STOPS (it PROVES the pin against the live GET /api/attest code.commit at run time) and the pin is corrected only after reading what changed.
# $REVIEWED_COMMIT is the commit the review converged on and holds the hub's placeholder until the hub sets it. Step 0a STOPS, before any git or network command, while EITHER still holds its
# placeholder or is not 40 lower-case hex.
# THE DEPLOY STAMPS THE COMMIT: `npx wrangler deploy --var CODE_COMMIT:<sha>`. The poll waits until GET /api/attest serves code.commit equal to the pinned sha AND code.version_id equal to the
# Current Version ID wrangler printed AND GET / carries the VISIT FIRST, FREE section (a request that makes the new worker detect the change and write the version row if the sweep or a cron wake has not already). The ROLLBACK TARGET is the version id GET /api/attest
# served BEFORE the deploy (read live, never typed in). A rollback of the WORKER does not unwrite the constitution row: if the ride fails after GET / minted v6, say so in HANDOVER.
# REVIEWED SOURCE ONLY: step 0 also STOPS unless HEAD is $REVIEWED_COMMIT plus changes confined to $ALLOWED_PATHS_AFTER_REVIEW (this script, its test, docs/).
# Run from society/ on main, after the merge and the push:
#   cd "C:\Users\bengr\Projects\AI domain and social network\society"
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-second-visit.ps1 -ExpectedCommit <sha> -DryRun   # every check and the live reads, nothing deployed
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-second-visit.ps1 -ExpectedCommit <sha>           # the real thing
# <sha> is the pushed tip of main (git -C society rev-parse HEAD), the full 40 hex.
# THE RIDE holds no token, key or assertion and makes NO guest_enter or guest_comment call (those write). It is public GETs plus exactly two POSTs, the JSON-RPC `initialize` of /mcp and of /mcp/read
# (they create no society record; each adds one door count, like any request). GET / first (the mint), then /api/attest (version 6, changed_by operator, $V6_HASH, every chain ok); GET / must
# carry VISIT FIRST, FREE before THE CONSTITUTION and both HOW TO JOIN sections; /skill.md must say version: 1.4.4; both initialisers must carry the return advice; /llms.txt and the manifest
# must carry the operator block.
# PowerShell 5.1 traps this file avoids: one spelling per variable name; -notmatch on an array filters instead of testing; a one-element return is wrapped in @(); "$var:" is a drive reference
# (write "${var}:"); never merge a native command's stderr under ErrorActionPreference Stop; -eq and -ne are case-INSENSITIVE (hashes and shas are compared with -ceq / -cne); a JSON body is passed to
# curl.exe from a file (--data-binary @file), never inline. ASCII only.
param(
  [Parameter(Mandatory = $true)][string]$ExpectedCommit,
  [switch]$DryRun
)
$ErrorActionPreference = "Stop"
$BASE = "https://commonhold.randommonicle.workers.dev"
# The attested constitution the live worker serves before this deploy (v5).
$V5_HASH = "fa11788d062b0c6d23c54c428c1c9649d263ae3ba704e602e122066926049491"
# The constitution this deploy mints (v6): the sha-256 of the built template, recorded in docs/CHECKPOINT-SECOND-VISIT.md. Step 2 proves the live worker is still v5; the ride proves v6.
$V6_HASH = "dc5f48213c29bcf844e0fbe7daf1bdb5416b3d57fbd06a8bd03f1061f34092b3"
# The commit the live worker serves when this runs: the local main with the privacy wave merged (773ce09f). ASSUMES THE PRIVACY WAVE IS DEPLOYED FIRST.
$LIVE_BASE_COMMIT = "773ce09f6d90421e1627adb2a9f951e400b2664f"
$LIVE_BASE_PLACEHOLDER = "TO-BE-SET-BY-HUB-LIVE-BASE"
# THE REVIEWED SOURCE. The hub replaces this placeholder with the full sha the review converged on; step 0 STOPS while it is unchanged, and while it is not 40 lower-case hex.
$REVIEWED_COMMIT = "TO-BE-SET-BY-HUB"
$REVIEWED_COMMIT_PLACEHOLDER = "TO-BE-SET-BY-HUB"
$ALLOWED_PATHS_AFTER_REVIEW = @("scripts/deploy-second-visit.ps1", "test/deploy-second-visit-script.test.ts", "docs/")
$VISIT_HEADING = "VISIT FIRST, FREE"
$SKILL_VERSION_LINE = "version: 1.4.4"
$RETURN_ADVICE = "After guest_enter, keep the visitor number and token. If your operator runs a schedule, return every 6 to 24 hours, call guest_inbox with that visitor number, or read section 6 of GET /heartbeat.md, then follow its cursor."
$OPERATOR_HEADING = "## For the person who runs an agent"
$OPERATOR_NOTE_PART = "The first public outcome after the two guest calls (guest_enter, then guest_comment) is a guest comment, not citizenship."
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
# The one POST this script makes: the JSON-RPC initialize. The body goes in through a file. Returns the instructions string, or "" when the answer is not an initialize result.
function Get-Instructions($url) {
  $bodyFile = [System.IO.Path]::GetTempFileName()
  $outFile = [System.IO.Path]::GetTempFileName()
  try {
    Set-Content -Path $bodyFile -Value '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25"}}' -Encoding ASCII
    $code = (curl.exe -s --max-time 30 -o $outFile -w "%{http_code}" -H "Content-Type: application/json" --data-binary "@$bodyFile" $url)
    if ([string]$code -ne "200") { return "" }
    $raw = (Get-Content $outFile -Raw -ErrorAction SilentlyContinue)
    if ($null -eq $raw) { return "" }
    try { $parsed = ($raw | ConvertFrom-Json) } catch { return "" }
    if ($null -eq $parsed -or $null -eq $parsed.result -or $null -eq $parsed.result.instructions) { return "" }
    return [string]$parsed.result.instructions
  } finally {
    Remove-Item $bodyFile -ErrorAction SilentlyContinue
    Remove-Item $outFile -ErrorAction SilentlyContinue
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
function Assert-AttestChains($att, $when) {
  if ($att.ok -ne $true) { Stop-Here "GET /api/attest ok is '$($att.ok)' $when, expected true." }
  foreach ($chain in "identity_log", "treasury", "payouts", "ballots") {
    if ($att.$chain.ok -ne $true) { Stop-Here "chain $chain ok is '$($att.$chain.ok)' $when, expected true: investigate." }
  }
}
# Before the deploy: the live worker serves constitution v5 (the privacy wave is live; this deploy is what mints v6).
function Assert-AttestBefore($att, $when) {
  if ([string]$att.constitution.version -ne "5") { Stop-Here "constitution is version $($att.constitution.version) $when, expected 5: investigate before anything else." }
  if ($att.constitution.template_hash -cne $V5_HASH) { Stop-Here "template_hash is $($att.constitution.template_hash) $when, expected v5 ${V5_HASH}: investigate before anything else." }
  Assert-AttestChains $att $when
}
# After the deploy and after GET / (the first of GET /, the sweep or a cron wake writes the version row): constitution version 6, changed_by operator, the pinned v6 template hash, every chain ok.
function Assert-AttestAfter($att, $when) {
  if ([string]$att.constitution.version -ne "6") { Stop-Here "constitution is version $($att.constitution.version) $when, expected 6 (the version row is written by the first of GET /, the public governance sweep or a cron wake; was GET / requested first?)." }
  if ([string]$att.constitution.changed_by -cne "operator") { Stop-Here "constitution changed_by is '$($att.constitution.changed_by)' $when, expected operator (mandate_linked would mean a passed first_laws_amendment or text_amendment proposal exists, src/governance.ts:2054-2060, which nothing on the record has)." }
  if ($att.constitution.template_hash -cne $V6_HASH) { Stop-Here "template_hash is $($att.constitution.template_hash) $when, expected v6 ${V6_HASH}." }
  Assert-AttestChains $att $when
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
# "" when a GET / answer is the v6 root, otherwise the reason it is not: 200, the VISIT FIRST, FREE section present, guest_enter named inside it and before THE CONSTITUTION, both HOW TO JOIN sections
# and the first dollar-one sentence. (This request makes the new worker detect the change and write the version row, unless the sweep or a cron wake already did.)
function Test-RootServed($r) {
  if ($r.Code -ne "200") { return ("GET / answered " + $r.Code + ", expected 200") }
  $body = [string]$r.Body
  $visit = $body.IndexOf($VISIT_HEADING, [System.StringComparison]::Ordinal)
  if ($visit -lt 0) { return ("GET / does not carry '" + $VISIT_HEADING + "'") }
  $guest = $body.IndexOf("guest_enter", [System.StringComparison]::Ordinal)
  if ($guest -lt 0 -or $guest -lt $visit) { return "GET / does not name guest_enter inside the VISIT FIRST section" }
  foreach ($later in "THE CONSTITUTION", "HOW TO JOIN (JSON API)", "HOW TO JOIN (MCP)") {
    $at = $body.IndexOf($later, [System.StringComparison]::Ordinal)
    if ($at -lt 0) { return ("GET / carries no '" + $later + "' (the constitution is missing)") }
    if ($at -lt $guest) { return ("GET / names guest_enter only after '" + $later + "'") }
  }
  $dollar = $body.IndexOf('$1', [System.StringComparison]::Ordinal)
  if ($dollar -ge 0 -and $guest -gt $dollar) { return "GET / names guest_enter only after the first dollar-one sentence" }
  return ""
}
# Polls until the served block is this deploy's AND GET / is the v6 root, or STOPS (with $ROLLBACK_LINE) after $tries reads.
function Wait-NewWorker($commit, $versionId, $tries, $delaySeconds) {
  $last = "never read"
  for ($n = 1; $n -le $tries; $n++) {
    $why = Test-CodeIdentityServed (Get-ServedCode) $commit $versionId
    if ($why -eq "") { $why = Test-RootServed (Get-Text "$BASE/" 30) }
    if ($why -eq "") {
      Say "[poll] try $n of ${tries}: GET /api/attest serves code.commit $($commit.Substring(0, 8)) and code.version_id $versionId; GET / carries the VISIT FIRST section"
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
# The mint, checked on the template itself: it must equal the REVIEWED commit's template (what ships is what was reviewed) and must differ from the live base's (this is the v6 mint).
$reviewedDoc = (@(git show ($REVIEWED_COMMIT + ":src/doc.ts")) -join "`n")
if ($LASTEXITCODE -ne 0) { Stop-Here "git show $($REVIEWED_COMMIT.Substring(0, 8)):src/doc.ts failed (exit $LASTEXITCODE): the template check cannot be read." }
$liveDoc = (@(git show ($LIVE_BASE_COMMIT + ":src/doc.ts")) -join "`n")
if ($LASTEXITCODE -ne 0) { Stop-Here "git show $($LIVE_BASE_COMMIT.Substring(0, 8)):src/doc.ts failed (exit $LASTEXITCODE): the template check cannot be read." }
$headDoc = (@(git show ($headSha + ":src/doc.ts")) -join "`n")
if ($LASTEXITCODE -ne 0) { Stop-Here "git show $($headSha.Substring(0, 8)):src/doc.ts failed (exit $LASTEXITCODE): the template check cannot be read." }
$reviewedTemplate = Get-TemplateText $reviewedDoc
$liveTemplate = Get-TemplateText $liveDoc
$headTemplate = Get-TemplateText $headDoc
if ($null -eq $reviewedTemplate -or $null -eq $liveTemplate -or $null -eq $headTemplate) { Stop-Here "FRONT_DOOR_TEMPLATE could not be found in src/doc.ts at one of the three commits: the template check cannot be read." }
if ($reviewedTemplate -cne $headTemplate) { Stop-Here "FRONT_DOOR_TEMPLATE at HEAD differs from the reviewed commit $($REVIEWED_COMMIT.Substring(0, 8)): what would ship as the constitution is not what was reviewed." }
if ($liveTemplate -ceq $headTemplate) { Stop-Here "FRONT_DOOR_TEMPLATE at HEAD equals the live base's: this is the v6 mint and the template did not change. Not this script's deploy." }
# No migration and no schema change since the live code: this script has no migration step, so a wave that grew one must not ship through it.
$schemaMoves = @(git diff --name-status --no-renames $LIVE_BASE_COMMIT HEAD -- migrations schema.sql)
if ($LASTEXITCODE -ne 0) { Stop-Here "git diff failed (exit $LASTEXITCODE): the no-migration check cannot be read." }
if ($schemaMoves.Count -gt 0) { Stop-Here ("migrations/ or schema.sql changed since " + $LIVE_BASE_COMMIT.Substring(0, 8) + " (" + ($schemaMoves -join " | ") + "): this script applies no migration and this wave was to have none. Not this script's deploy.") }
# BEGIN-REVIEWED-SOURCE-CHECK
git merge-base --is-ancestor $REVIEWED_COMMIT HEAD
if ($LASTEXITCODE -ne 0) { Stop-Here "HEAD does not contain the reviewed commit $($REVIEWED_COMMIT.Substring(0, 8)): this is not the code that was reviewed." }
$afterReview = @(git diff --name-only --no-renames $REVIEWED_COMMIT HEAD)
if ($LASTEXITCODE -ne 0) { Stop-Here "git diff failed (exit $LASTEXITCODE): the changes since the reviewed commit cannot be read." }
$unreviewed = @(Get-DisallowedPaths $afterReview)
if ($unreviewed.Count -gt 0) { Stop-Here ("these paths changed since the reviewed commit " + $REVIEWED_COMMIT.Substring(0, 8) + " and are not on the allowlist (" + ($ALLOWED_PATHS_AFTER_REVIEW -join ", ") + "), so what would ship is not what was reviewed: " + ($unreviewed -join ", ")) }
Say ("[git] reviewed source: HEAD differs from " + $REVIEWED_COMMIT.Substring(0, 8) + " in " + $afterReview.Count + " path(s), all on the allowlist")
# END-REVIEWED-SOURCE-CHECK
if (-not (Select-String -Path "src/doc.ts" -Pattern "VISIT FIRST, FREE" -SimpleMatch -Quiet)) { Stop-Here "src/doc.ts has no VISIT FIRST, FREE section: this checkout is not constitution v6." }
if (Select-String -Path "src/index.ts" -Pattern "guestDoorNote" -SimpleMatch -Quiet) { Stop-Here "src/index.ts still renders guestDoorNote: phase 1 note was to be removed by v6." }
if (-not (Select-String -Path "src/guest.ts" -Pattern "next_visit" -SimpleMatch -Quiet)) { Stop-Here "src/guest.ts has no next_visit: this checkout is not the second-visit wave." }
if (-not (Select-String -Path "src/mcp.ts" -Pattern "GUEST_RETURN_ADVICE" -SimpleMatch -Quiet)) { Stop-Here "src/mcp.ts does not serve GUEST_RETURN_ADVICE: this checkout is not the second-visit wave." }
if (-not (Select-String -Path "src/inbox.ts" -Pattern 'SKILL_VERSION = "1.4.4"' -SimpleMatch -Quiet)) { Stop-Here "src/inbox.ts does not set SKILL_VERSION 1.4.4: this checkout is not the second-visit wave." }
if (-not (Select-String -Path "src/privacy.ts" -Pattern "export async function handlePrivacy" -Quiet)) { Stop-Here "src/privacy.ts has no handlePrivacy: this checkout would drop the privacy wave this one assumes is live." }
if (-not (Select-String -Path "src/code-identity.ts" -Pattern "export function codeBlock" -Quiet)) { Stop-Here "src/code-identity.ts has no codeBlock: this checkout would drop served code identity." }
if (-not (Select-String -Path "wrangler.jsonc" -Pattern '"version_metadata"' -Quiet)) { Stop-Here "wrangler.jsonc has no version_metadata binding: the Worker could not serve Cloudflare's version id." }
if (Select-String -Path "wrangler.jsonc" -Pattern '"CODE_COMMIT"' -Quiet) { Stop-Here "wrangler.jsonc configures a CODE_COMMIT var: a deploy that forgot the flag would serve a stale stamp. The stamp comes from this script's --var flag only." }
Say ("[git] HEAD " + $headSha.Substring(0, 8) + " = main = origin/main = -ExpectedCommit; tree clean; contains " + $LIVE_BASE_COMMIT.Substring(0, 8) + "; FRONT_DOOR_TEMPLATE equals the reviewed commit's and differs from the live base's; migrations and schema.sql unmoved")

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

# 2. live, before: non-minting baseline, the live worker is the base this wave was checked against, and the new root is not served yet (so the propagation poll proves something)
$attBefore = Read-Attest "before the deploy"
Assert-AttestBefore $attBefore "before the deploy"
Say ("[live] before: v5 " + $V5_HASH.Substring(0, 8) + "; all four chains ok; identity " + $attBefore.identity_log.sealed_entries + ", treasury " + $attBefore.treasury.sealed_entries + ", ballots " + $attBefore.ballots.sealed_entries)
if ($null -eq $attBefore.code -or [string]$attBefore.code.commit_status -cne "stamped") { Stop-Here "GET /api/attest serves no stamped code.commit before the deploy: the live worker cannot be shown to be the base this wave was checked against." }
if ([string]$attBefore.code.commit -ceq $headSha) { Stop-Here "GET /api/attest already serves code.commit $($headSha.Substring(0, 8)): this commit looks already deployed. Verify by hand." }
if ([string]$attBefore.code.commit -cne $LIVE_BASE_COMMIT) { Stop-Here ("the live worker serves code.commit " + $attBefore.code.commit + " but `$LIVE_BASE_COMMIT is " + $LIVE_BASE_COMMIT + ": the base this wave was checked against is not what is live (this script assumes the privacy wave was deployed first). Correct the pin only after reading what changed.") }
$rollbackTarget = "the version before it (check npx wrangler deployments list)"
if ([string]$attBefore.code.version_status -ceq "available" -and $attBefore.code.version_id) { $rollbackTarget = [string]$attBefore.code.version_id }
Say "[live] before: the live worker serves the pinned base $($LIVE_BASE_COMMIT.Substring(0, 8)); rollback target $rollbackTarget"
$rootBefore = Get-Text "$BASE/" 30
if (([string]$rootBefore.Body).Contains($VISIT_HEADING)) { Stop-Here "GET / already carries the VISIT FIRST section: this wave looks already deployed. Verify by hand; this script cannot prove a propagation it did not wait for." }
Say "[live] before: GET / answers $($rootBefore.Code) and carries no VISIT FIRST section (the new code is absent)"

if ($DryRun) {
  Say "[dry-run] would now: run npx wrangler deploy --var CODE_COMMIT:<the full sha> and capture its Current Version ID (refusing to continue without one); poll up to $POLL_TRIES times, $POLL_DELAY_SECONDS s apart, until GET /api/attest serves that commit and version id and GET / carries the VISIT FIRST section; then GET /api/attest for constitution version 6; then ride the public reads and the two initialize calls. Nothing was deployed."
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

# 4. the ride: the root first (it makes the new worker write the v6 version row if the sweep or a cron wake has not), then the attestation, the skill, both initialisers, the operator block, then a sweep of public reads. GETs, plus the two initialize POSTs.
$rootNow = Get-Text "$BASE/" 30
$why = Test-RootServed $rootNow
if ($why -ne "") { Stop-Here "$why. $ROLLBACK_LINE" }
Say "[ride] GET / -> 200, carries '$VISIT_HEADING' and names guest_enter before THE CONSTITUTION and both HOW TO JOIN sections (this request writes the v6 version row unless the sweep or a cron wake already did)"
$attAfter = Read-Attest "after the deploy"
Assert-AttestAfter $attAfter "after the deploy"
Say ("[ride] attest: constitution version 6, changed_by operator, template_hash " + $V6_HASH.Substring(0, 8) + "; every chain ok")
$skillNow = Get-Text "$BASE/skill.md" 30
if ($skillNow.Code -ne "200") { Stop-Here "GET /skill.md answered $($skillNow.Code). $ROLLBACK_LINE" }
if (-not ([string]$skillNow.Body).Contains($SKILL_VERSION_LINE)) { Stop-Here "GET /skill.md does not say '$SKILL_VERSION_LINE'. $ROLLBACK_LINE" }
Say "[ride] /skill.md says $SKILL_VERSION_LINE"
foreach ($door in "/mcp", "/mcp/read") {
  $instructions = Get-Instructions "$BASE$door"
  if ($instructions -eq "") { Stop-Here "POST $door initialize did not return instructions. $ROLLBACK_LINE" }
  if (-not $instructions.Contains($RETURN_ADVICE)) { Stop-Here "POST $door initialize does not carry the return advice. $ROLLBACK_LINE" }
}
Say "[ride] both MCP initialisers carry the return advice"
$llmsNow = Get-Text "$BASE/llms.txt" 30
if ($llmsNow.Code -ne "200") { Stop-Here "GET /llms.txt answered $($llmsNow.Code). $ROLLBACK_LINE" }
if (-not ([string]$llmsNow.Body).Contains($OPERATOR_HEADING)) { Stop-Here "GET /llms.txt does not carry '$OPERATOR_HEADING'. $ROLLBACK_LINE" }
if (-not ([string]$llmsNow.Body).Contains($OPERATOR_NOTE_PART)) { Stop-Here "GET /llms.txt does not carry the operator note. $ROLLBACK_LINE" }
$manifestNow = Get-Text "$BASE/.well-known/mcp.json" 30
if ($manifestNow.Code -ne "200") { Stop-Here "GET /.well-known/mcp.json answered $($manifestNow.Code). $ROLLBACK_LINE" }
if (-not ([string]$manifestNow.Body).Contains($OPERATOR_NOTE_PART)) { Stop-Here "GET /.well-known/mcp.json does not carry the operator note. $ROLLBACK_LINE" }
Say "[ride] /llms.txt and the MCP manifest carry the operator block"
$bad = @()
foreach ($p in "/api/official", "/openapi.json", "/treasury", "/api/listings", "/api/stats", "/api/topics", "/api/guest/due", "/api/citizens", "/api/doors", "/api/council", "/api/residents", "/heartbeat.md", "/privacy") {
  $r = Get-Text "$BASE$p" 30
  if ($r.Code -ne "200") { $bad += "$p=$($r.Code)" }
}
if ($bad.Count -gt 0) { Stop-Here ("non-200 after the deploy (version $versionId): " + ($bad -join ", ") + ". If a read that answered before now fails: $ROLLBACK_LINE") }
Say "[ride] 13 public reads -> 200"
Say "[note] This ride wrote nothing to the society: GETs, and two initialize calls that each add one door count. It made no guest_enter or guest_comment call."
Say "[done] Second-visit wave deployed and ridden. Log version id $versionId, commit $($headSha.Substring(0, 8)) and these lines in HANDOVER.md."
