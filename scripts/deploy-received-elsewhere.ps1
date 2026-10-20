# Deploys the 20 OCT RECEIVED-ELSEWHERE CATCH-UP (branch received-elsewhere-2026-10-20; commission drafts/BUILDER-COMMISSION-RECEIVED-ELSEWHERE-2026-10-20.md): GET /api/guest/due's hand-kept
# received_elsewhere list grows from 4 to 10 entries (a Colony answer added, thecaretaker on The Colony, parallax on 1f3d9, kashia-muse on 1f916), account_self_description and its excerpt flag are
# null where the platform serves none, and one served sentence says "a comment or note". Hand-kept data on a GET answer: no money route, no auth change, no model call, no write path.
# ONE worker deploy. Ben's hand only (D-017). One fail-fast script (L-046, L-069).
# NO MIGRATION, NO D1 COMMAND, NO MINT. Step 0 STOPS if migrations/ or schema.sql differ between the live base and HEAD, or if FRONT_DOOR_TEMPLATE in src/doc.ts moved.
# Wrangler is used for exactly ONE thing here: the stamped deploy.
# WRITTEN BY THE BUILDER AND NEVER RUN: not even -DryRun (which reads the live worker over HTTP).
# TWO PINS. $LIVE_BASE_COMMIT is the commit the live worker serves when this runs (the tool-call counter wave, worker fcc81add); step 2 PROVES it against the live GET /api/attest code.commit.
# $REVIEWED_COMMIT holds the hub's placeholder until the hub sets it; step 0a STOPS, before any git or network command, while either pin is a placeholder or not 40 lower-case hex.
# THE DEPLOY STAMPS THE COMMIT: `npx wrangler deploy --var CODE_COMMIT:<sha>`. The poll waits until GET /api/attest serves that commit and the Current Version ID wrangler printed AND GET /api/guest/due
# serves the new list (the pre-deploy probe proves the old list first). The ROLLBACK TARGET is the version id GET /api/attest served BEFORE the deploy (read live, never typed in).
# REVIEWED SOURCE ONLY: step 0 STOPS unless HEAD is $REVIEWED_COMMIT plus changes confined to $ALLOWED_PATHS_AFTER_REVIEW (this script, its test, docs/).
# Run from society/ on main, after the merge and the push:
#   cd "C:\Users\bengr\Projects\AI domain and social network\society"
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-received-elsewhere.ps1 -ExpectedCommit <sha> -DryRun   # every check and the live reads, nothing deployed
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-received-elsewhere.ps1 -ExpectedCommit <sha>           # the real thing
# <sha> is the pushed tip of main (git -C society rev-parse HEAD), the full 40 hex.
# THE RIDE IS PUBLIC GETs ONLY. NO POST OF ANY KIND, no token, key or assertion, and it WRITES NOTHING. It reads GET /api/guest/due (the new count and every new id, the duty counts adding up and unchanged
# across the deploy, the sentence's new wording), the other public pages, the attest chains and the v5 constitution.
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
# The commit the live worker serves when this runs (the tool-call counter wave). Step 0 STOPS while it holds the placeholder, and while it is not 40 lower-case hex.
$LIVE_BASE_COMMIT = "3818e23f25efcbfbef8f1b3c22183d75a84ee447"
$LIVE_BASE_PLACEHOLDER = "TO-BE-SET-BY-HUB-LIVE-BASE"
# THE REVIEWED SOURCE. The hub replaces this placeholder with the full sha the review converged on; step 0 STOPS while it is unchanged, and while it is not 40 lower-case hex.
$REVIEWED_COMMIT = "TO-BE-SET-BY-HUB"
$REVIEWED_COMMIT_PLACEHOLDER = "TO-BE-SET-BY-HUB"
$ALLOWED_PATHS_AFTER_REVIEW = @("scripts/deploy-received-elsewhere.ps1", "test/deploy-received-elsewhere-script.test.ts", "docs/")
$DUE_URL = "$BASE/api/guest/due"
$POLL_TRIES = 12
$POLL_DELAY_SECONDS = 5
# The list as served before and after: the count, and the critique ids (comment_id) the new list must carry. The old list's four ids are a subset of the new ten.
$OLD_COUNT = 4
$NEW_COUNT = 10
$NEW_IDS = @("236697e1-1e45-4c2f-b2b3-42c4cedc96ac", "c5aa25b2-28b8-4753-91d2-4fc81ad57408", "6fce54ff-3116-4687-8a58-02a6b7474b6d", "466b38e9-5d02-44ee-a3e4-e94dce1d08fc", "cf412908-5fc1-44f2-b11c-4fb4a5bc241a", "1ed54728-eedc-4dc1-a125-fbc51da3a287", "36304", "112374", "36667", "113953")
$NEW_ONLY_ID = "cf412908-5fc1-44f2-b11c-4fb4a5bc241a"
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
# Runs of whitespace collapsed to one space (llms.txt and the notes may wrap a long sentence across lines).
function Get-FlatText($text) {
  return [regex]::Replace([string]$text, '\s+', ' ')
}
# $true when $text contains $needle after both have their whitespace flattened (ordinal, case-sensitive). $false on an empty needle: nothing is "contained" by default.
function Test-ContainsFlat($text, $needle) {
  if ([string]::IsNullOrEmpty([string]$needle)) { return $false }
  return (Get-FlatText $text).Contains((Get-FlatText $needle))
}
# $true when $v is a whole number (JSON null, a string and a missing field are not).
function Test-IsCount($v) {
  if ($null -eq $v) { return $false }
  return (($v -is [int]) -or ($v -is [long]))
}
# $true when the JSON text of GET /api/official carries NEITHER ever-written count in its composition: the pre-deploy probe, which makes the poll mean something. $false when it is unreadable or either is there.
# "" when the JSON text of GET /api/guest/due serves received_elsewhere as THIS wave defines it, otherwise the first reason it does not: the list is there, received_elsewhere_count is a whole number equal to
# its length and to $NEW_COUNT, every id in $NEW_IDS is named by an entry's comment_id (ordinal), every entry has its platform, url, posted_utc and at least one answering comment, and the six duty counts
# are whole numbers with accrued the sum of the other five.
function Test-ReceivedElsewhereCaughtUp($body) {
  try { $o = ([string]$body | ConvertFrom-Json) } catch { return "GET /api/guest/due did not return JSON" }
  if ($null -eq $o) { return "GET /api/guest/due did not return a JSON object" }
  if ($null -eq $o.PSObject.Properties["received_elsewhere"]) { return "received_elsewhere is absent" }
  $list = @($o.received_elsewhere)
  if (-not (Test-IsCount $o.received_elsewhere_count)) { return ("received_elsewhere_count is '" + $o.received_elsewhere_count + "', expected a whole number") }
  if ($o.received_elsewhere_count -ne $list.Count) { return ("received_elsewhere_count " + $o.received_elsewhere_count + " is not the list length " + $list.Count) }
  if ($list.Count -ne $NEW_COUNT) { return ("received_elsewhere has " + $list.Count + " entries, expected " + $NEW_COUNT) }
  $ids = @($list | ForEach-Object { [string]$_.comment_id })
  foreach ($id in $NEW_IDS) {
    if ($ids -cnotcontains $id) { return ("received_elsewhere has no entry with comment_id " + $id) }
  }
  foreach ($e in $list) {
    foreach ($f in "by", "platform", "url", "comment_id", "posted_utc") {
      if ([string]::IsNullOrEmpty([string]$e.$f)) { return ("a received_elsewhere entry has no " + $f) }
    }
    $answers = @($e.answered_by)
    if ($answers.Count -lt 1) { return ("received_elsewhere entry " + $e.comment_id + " names no answering comment") }
    foreach ($a in $answers) {
      if ([string]::IsNullOrEmpty([string]$a.identity) -or [string]::IsNullOrEmpty([string]$a.comment_id)) { return ("received_elsewhere entry " + $e.comment_id + " has an answering comment without an identity or an id") }
    }
  }
  $k = $o.counts
  foreach ($f in "accrued", "open", "overdue", "answered_in_time", "answered_late", "waived") {
    if (-not (Test-IsCount $k.$f)) { return ("counts." + $f + " is '" + $k.$f + "', expected a whole number") }
  }
  if ($k.accrued -ne ($k.open + $k.overdue + $k.answered_in_time + $k.answered_late + $k.waived)) { return ("counts.accrued " + $k.accrued + " is not the sum of the other five") }
  return ""
}
# $true when the JSON text of GET /api/guest/due is the PRE-wave list: received_elsewhere_count equal to its length and to $OLD_COUNT, and no entry for $NEW_ONLY_ID. $false when unreadable or anything else:
# the pre-deploy probe, which makes the poll mean something.
function Test-ReceivedElsewherePreWave($body) {
  try { $o = ([string]$body | ConvertFrom-Json) } catch { return $false }
  if ($null -eq $o -or $null -eq $o.PSObject.Properties["received_elsewhere"]) { return $false }
  $list = @($o.received_elsewhere)
  if (-not (Test-IsCount $o.received_elsewhere_count)) { return $false }
  if ($o.received_elsewhere_count -ne $list.Count -or $list.Count -ne $OLD_COUNT) { return $false }
  $ids = @($list | ForEach-Object { [string]$_.comment_id })
  return ($ids -cnotcontains $NEW_ONLY_ID)
}
# The six duty counts as one comparable string, or $null when unreadable: the deploy must not move them.
function Get-DutyCounts($body) {
  try { $o = ([string]$body | ConvertFrom-Json) } catch { return $null }
  if ($null -eq $o -or $null -eq $o.counts) { return $null }
  $k = $o.counts
  return ("accrued " + $k.accrued + ", open " + $k.open + ", overdue " + $k.overdue + ", answered_in_time " + $k.answered_in_time + ", answered_late " + $k.answered_late + ", waived " + $k.waived)
}
# $true when the note of GET /api/guest/due carries the two wordings this wave changed: "a comment or note at its url" and the null clause.
function Test-DueNoteWording($body) {
  try { $o = ([string]$body | ConvertFrom-Json) } catch { return $false }
  if ($null -eq $o) { return $false }
  return ((Test-ContainsFlat ([string]$o.note) "each entry is a comment or note at its url") -and (Test-ContainsFlat ([string]$o.note) "both are null where the platform serves no self-description"))
}
# "" when GET /api/guest/due serves the new list (the poll's test and the ride's), otherwise the first reason it does not.
function Get-NewSurfacesReason {
  $due = Get-Text $DUE_URL 30
  if ($due.Code -ne "200") { return ("GET /api/guest/due answered " + $due.Code) }
  $why = Test-ReceivedElsewhereCaughtUp $due.Body
  if ($why -ne "") { return $why }
  if (-not (Test-DueNoteWording $due.Body)) { return "the due note does not carry the new wording" }
  return ""
}
# Polls until the served block is this deploy's AND the new list is served, or STOPS (with $ROLLBACK_LINE) after $tries reads.
function Wait-NewWorker($commit, $versionId, $tries, $delaySeconds) {
  $last = "never read"
  for ($n = 1; $n -le $tries; $n++) {
    $why = Test-CodeIdentityServed (Get-ServedCode) $commit $versionId
    if ($why -eq "") {
      $why = Get-NewSurfacesReason
      if ($why -eq "") {
        Say "[poll] try $n of ${tries}: GET /api/attest serves code.commit $($commit.Substring(0, 8)) and code.version_id $versionId; GET /api/guest/due serves the new list"
        return
      }
    }
    $last = $why
    Say "[poll] try $n of ${tries}: not yet: $why"
    if ($n -lt $tries) { Start-Sleep -Seconds $delaySeconds }
  }
  Stop-Here ("the new worker was never shown live in " + $tries + " reads (last: " + $last + "). The deploy is not shown to be live. " + $ROLLBACK_LINE)
}
# END-OF-DEFINITIONS (test/deploy-received-elsewhere-script.test.ts reads everything above this line as definitions; nothing above runs git, npm, wrangler or the network)

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
# This checkout must be the catch-up wave on top of the tool-call counter wave and everything before it.
if (-not (Select-String -Path "src/guest-core.ts" -Pattern "export const RECEIVED_ELSEWHERE:" -SimpleMatch -Quiet)) { Stop-Here "src/guest-core.ts has no RECEIVED_ELSEWHERE: this checkout cannot be this wave." }
if (-not (Select-String -Path "src/guest-core.ts" -Pattern "cf412908-5fc1-44f2-b11c-4fb4a5bc241a" -SimpleMatch -Quiet)) { Stop-Here "src/guest-core.ts does not list the thecaretaker entry cf412908: this checkout is not the catch-up wave." }
if (-not (Select-String -Path "src/guest-core.ts" -Pattern "each entry is a comment or note at its url" -SimpleMatch -Quiet)) { Stop-Here "src/guest-core.ts does not carry the new sentence wording: this checkout is not the catch-up wave." }
if (-not (Select-String -Path "src/doors.ts" -Pattern '"mcp_read_tool_call"' -Quiet)) { Stop-Here "src/doors.ts does not list mcp_read_tool_call: this checkout would drop the tool-call counter wave." }
if (-not (Select-String -Path "src/code-identity.ts" -Pattern "export function codeBlock" -Quiet)) { Stop-Here "src/code-identity.ts has no codeBlock: this checkout would drop served code identity." }
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

# 2. live, before: non-minting baseline, the live worker is the base this wave was checked against, GET /api/guest/due carries the OLD list (so the propagation poll proves something), and the duty
# counts are recorded for the ride to compare
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
$dueBefore = Get-Text $DUE_URL 30
if ($dueBefore.Code -ne "200") { Stop-Here "GET /api/guest/due answered $($dueBefore.Code) before the deploy, expected 200: investigate." }
if (-not (Test-ReceivedElsewherePreWave $dueBefore.Body)) { Stop-Here "GET /api/guest/due does not serve the old $OLD_COUNT-entry list (or already carries $NEW_ONLY_ID, or is unreadable): this wave looks already deployed, or the base is not what was checked. Verify by hand; this script cannot prove a propagation it did not wait for." }
$dutyBefore = Get-DutyCounts $dueBefore.Body
if ($null -eq $dutyBefore) { Stop-Here "GET /api/guest/due carried no counts block before the deploy: the figures the ride compares against cannot be read." }
Say "[live] before: the old $OLD_COUNT-entry list is served; duty counts $dutyBefore"

if ($DryRun) {
  Say "[dry-run] would now: run npx wrangler deploy --var CODE_COMMIT:<the full sha> and capture its Current Version ID (refusing to continue without one); poll up to $POLL_TRIES times, $POLL_DELAY_SECONDS s apart, until GET /api/attest serves that commit and version id and GET /api/guest/due serves $NEW_COUNT entries with every new id and the new note wording; then ride public GETs only. Nothing was deployed and nothing was written."
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
$ROLLBACK_LINE = "ROLL BACK THE WORKER (npx wrangler rollback, to the version before $versionId, which should be $rollbackTarget; check npx wrangler deployments list first). This wave applied no migration and wrote no row, so the rollback is the whole undo."
Wait-NewWorker $headSha $versionId $POLL_TRIES $POLL_DELAY_SECONDS
# END-DEPLOY-AND-POLL

# 4. the ride: non-minting and the chains, then GET-only reads of the surface the wave changed. It writes nothing.
$attAfter = Read-Attest "after the deploy"
Assert-Attest $attAfter "after the deploy"
Say ("[ride] attest: v5 " + $V5_HASH.Substring(0, 8) + " unchanged; every chain ok")
$bad = @()
foreach ($p in "/", "/api/official", "/llms.txt", "/openapi.json", "/treasury", "/api/treasury", "/api/listings", "/api/stats", "/api/topics", "/api/guest/due", "/api/citizens", "/api/doors", "/api/council", "/api/residents") {
  $r = Get-Text "$BASE$p" 30
  if ($r.Code -ne "200") { $bad += "$p=$($r.Code)" }
}
if ($bad.Count -gt 0) { Stop-Here ("non-200 after the deploy (version $versionId): " + ($bad -join ", ") + ". If a read that answered before now fails: $ROLLBACK_LINE") }
Say "[ride] 14 public reads -> 200"
$dueNow = Get-Text $DUE_URL 30
if ($dueNow.Code -ne "200") { Stop-Here "GET /api/guest/due answered $($dueNow.Code). $ROLLBACK_LINE" }
$dueWhy = Test-ReceivedElsewhereCaughtUp $dueNow.Body
if ($dueWhy -ne "") { Stop-Here "GET /api/guest/due does not serve received_elsewhere as defined: $dueWhy. $ROLLBACK_LINE" }
if (-not (Test-DueNoteWording $dueNow.Body)) { Stop-Here "the note on GET /api/guest/due does not carry the new wording. $ROLLBACK_LINE" }
$dutyAfter = Get-DutyCounts $dueNow.Body
if ($null -eq $dutyAfter) { Stop-Here "GET /api/guest/due carried no counts block after the deploy. $ROLLBACK_LINE" }
if ($dutyAfter -cne $dutyBefore) { Say "[ride] note: the duty counts moved across the deploy (before '$dutyBefore', after '$dutyAfter'); a critique may have arrived or been answered in between, since this wave touches no duty row. Check by hand before reading it as a fault." }
else { Say "[ride] duty counts unchanged ($dutyAfter)" }
Say ("[ride] received_elsewhere_count " + ($dueNow.Body | ConvertFrom-Json).received_elsewhere_count + " equals the list length and every new id is served; the duty counts add up; the note carries the new wording")
Say "[note] Writes made by this ride: NONE. Every request was a GET; no token, no key."
Say "[done] Received-elsewhere catch-up deployed and ridden. Log version id $versionId, commit $($headSha.Substring(0, 8)) and these lines in HANDOVER.md."
