# Deploys the 13 OCT FUNDING LABEL WORDING (branch funding-label-2026-10-13; the served-text change is src/society.ts OPERATOR_FUNDED_SCOPE_SENTENCE and a matching clause in compositionDoorNote, src/doc.ts):
# the operator_funded flag is said, wherever it is defined or counted, to mark a SPONSORED seat only; the operator's own seats were paid from the same wallet and carry operator_controlled and
# operator_funded:false. Ben's option A on a Colony review (shejiao-daren): reword, flip nothing. ONE worker deploy. Ben's hand only (D-017). One fail-fast script (L-046, L-069).
# NO MIGRATION, NO D1 COMMAND, NO FLAG FLIPPED, NO COUNT CHANGED. Step 0 STOPS if migrations/ or schema.sql differ between the live base and HEAD, so a wave that quietly grew one cannot ride this script.
# Wrangler is used for exactly ONE thing here: the stamped deploy.
# WRITTEN BY THE BUILDER AND NEVER RUN: not even -DryRun (which reads the live worker over HTTP).
# TWO PINS. $LIVE_BASE_COMMIT is the commit the live worker serves when this runs (the door funnel wave) and is set; step 2 PROVES it against the live GET /api/attest code.commit at run time.
# $REVIEWED_COMMIT is the commit the review converged on and holds the hub's placeholder until the hub sets it. Step 0a STOPS, before any git or network command, while EITHER still holds its
# placeholder or is not 40 lower-case hex.
# NO MINT: the clause on the GET / door note lives in compositionDoorNote, OUTSIDE FRONT_DOOR_TEMPLATE. The check is the template text itself: step 0 extracts FRONT_DOOR_TEMPLATE from src/doc.ts at
# $LIVE_BASE_COMMIT and at HEAD and STOPS if they differ by a byte. After the deploy it STOPS if the constitution is not still v5 with its template hash.
# THE SENTENCE IS NEVER RETYPED HERE: it is read at run time from src/society.ts (OPERATOR_FUNDED_SCOPE_SENTENCE), so the script checks what the code serves. The door clause is a literal in this script
# and step 0 requires src/doc.ts to contain it.
# THE DEPLOY STAMPS THE COMMIT: `npx wrangler deploy --var CODE_COMMIT:<sha>` (served code identity). The poll after the deploy waits until GET /api/attest serves code.commit equal to the pinned sha
# AND code.version_id equal to the Current Version ID wrangler printed AND the operator_funded provenance check on GET /api/official contains the scope sentence (the pre-deploy probe proves it is
# absent first). The ROLLBACK TARGET is the version id GET /api/attest served BEFORE the deploy (read live, never typed in).
# REVIEWED SOURCE ONLY: step 0 also STOPS unless HEAD is $REVIEWED_COMMIT plus changes confined to $ALLOWED_PATHS_AFTER_REVIEW (this script, its test, docs/).
# Run from society/ on main, after the merge and the push:
#   cd "C:\Users\bengr\Projects\AI domain and social network\society"
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-funding-label.ps1 -ExpectedCommit <sha> -DryRun   # every check and the live reads, nothing deployed
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-funding-label.ps1 -ExpectedCommit <sha>           # the real thing
# <sha> is the pushed tip of main (git -C society rev-parse HEAD), the full 40 hex.
# THE RIDE IS PUBLIC GETs ONLY. NO POST OF ANY KIND, no token, key or assertion, and it WRITES NOTHING. It reads: the provenance check and the composition note on GET /api/official, the note on
# GET /api/citizens, GET /llms.txt and GET / (the door-note clause), each of which must contain the exact text; the composition counts (citizens, operator_controlled, operator_funded and the funded
# handles) must equal what GET /api/official served BEFORE the deploy; and every operator-controlled row on GET /api/citizens must still carry operator_funded:false.
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
# The commit the live worker serves when this runs (the door funnel wave). Step 0 STOPS while it holds the placeholder, and while it is not 40 lower-case hex.
$LIVE_BASE_COMMIT = "d6a5cd7829a14c3a91d962f85ce13d0330b532af"
$LIVE_BASE_PLACEHOLDER = "TO-BE-SET-BY-HUB-LIVE-BASE"
# THE REVIEWED SOURCE. The hub replaces this placeholder with the full sha the review converged on; step 0 STOPS while it is unchanged, and while it is not 40 lower-case hex.
$REVIEWED_COMMIT = "5f559d2f2cece16a1049653b87de2aabd0a2ee07"
$REVIEWED_COMMIT_PLACEHOLDER = "TO-BE-SET-BY-HUB"
$ALLOWED_PATHS_AFTER_REVIEW = @("scripts/deploy-funding-label.ps1", "test/deploy-funding-label-script.test.ts", "docs/")
# The clause compositionDoorNote (src/doc.ts) adds to the GET / door note. Step 0 requires src/doc.ts to contain it; the ride requires GET / to serve it.
$DOOR_CLAUSE = "The operator's own seats were paid from that wallet too; they are counted as operator-controlled, never as operator-funded."
# The sentence is read from this file at run time (never retyped here).
$SENTENCE_SOURCE = "src/society.ts"
$OFFICIAL_URL = "$BASE/api/official"
$CITIZENS_URL = "$BASE/api/citizens"
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
# The OPERATOR_FUNDED_SCOPE_SENTENCE literal of a src/society.ts text: the one double-quoted line after `export const OPERATOR_FUNDED_SCOPE_SENTENCE =`. $null when it is not found, or when the literal holds a
# backslash (an escape the script would not undo): the caller STOPS, an unreadable sentence is never "present".
function Get-ScopeSentence($societyText) {
  $m = [regex]::Match([string]$societyText, '(?m)^export const OPERATOR_FUNDED_SCOPE_SENTENCE =\s*\r?\n\s*"([^"\\\r\n]+)";')
  if (-not $m.Success) { return $null }
  return $m.Groups[1].Value
}
# Runs of whitespace collapsed to one space (llms.txt and the door note may wrap a long sentence across lines).
function Get-FlatText($text) {
  return [regex]::Replace([string]$text, '\s+', ' ')
}
# $true when $text contains $needle after both have their whitespace flattened (ordinal, case-sensitive). $false on an empty needle: nothing is "contained" by default.
function Test-ContainsFlat($text, $needle) {
  if ([string]::IsNullOrEmpty([string]$needle)) { return $false }
  return (Get-FlatText $text).Contains((Get-FlatText $needle))
}
# $true when the JSON text of GET /api/official carries $sentence in composition.provenance.operator_funded.check. $false on anything unreadable (the caller reads the status code first).
function Test-ProvenanceHasScope($body, $sentence) {
  try { $o = ([string]$body | ConvertFrom-Json) } catch { return $false }
  if ($null -eq $o -or $null -eq $o.composition -or $null -eq $o.composition.provenance -or $null -eq $o.composition.provenance.operator_funded) { return $false }
  return (Test-ContainsFlat ([string]$o.composition.provenance.operator_funded.check) $sentence)
}
# $true when the JSON text of GET /api/official carries $sentence in composition.note.
function Test-OfficialNoteHasScope($body, $sentence) {
  try { $o = ([string]$body | ConvertFrom-Json) } catch { return $false }
  if ($null -eq $o -or $null -eq $o.composition) { return $false }
  return (Test-ContainsFlat ([string]$o.composition.note) $sentence)
}
# $true when the JSON text of GET /api/citizens carries $sentence in its note.
function Test-CitizensNoteHasScope($body, $sentence) {
  try { $o = ([string]$body | ConvertFrom-Json) } catch { return $false }
  if ($null -eq $o) { return $false }
  return (Test-ContainsFlat ([string]$o.note) $sentence)
}
# The composition counts GET /api/official serves, as one comparable string: citizens, operator_controlled, operator_funded and the funded handles (sorted, ordinal). $null when unreadable.
function Get-CompositionSnapshot($body) {
  try { $o = ([string]$body | ConvertFrom-Json) } catch { return $null }
  if ($null -eq $o -or $null -eq $o.composition) { return $null }
  $c = $o.composition
  $handles = @(@($c.operator_funded_handles) | ForEach-Object { [string]$_ })
  [array]::Sort($handles, [System.StringComparer]::Ordinal)
  return ("citizens=" + $c.citizens + ";operator_controlled=" + $c.operator_controlled + ";operator_funded=" + $c.operator_funded + ";funded_handles=" + ($handles -join ","))
}
# What the rows of GET /api/citizens say about the two flags: how many rows, how many operator_controlled, which operator_controlled rows are NOT operator_funded:false (a violation), how many operator_funded
# rows, and whether the page says has_more. $null when the text is not JSON or carries no citizens array.
function Get-CitizenFlagFacts($body) {
  try { $o = ([string]$body | ConvertFrom-Json) } catch { return $null }
  if ($null -eq $o -or $null -eq $o.citizens) { return $null }
  $rows = @($o.citizens)
  $ctl = 0
  $funded = 0
  $bad = @()
  foreach ($r in $rows) {
    if ($r.operator_funded -eq $true) { $funded++ }
    if ($r.operator_controlled -eq $true) {
      $ctl++
      if ($r.operator_funded -ne $false) { $bad += [string]$r.handle }
    }
  }
  return @{ Rows = $rows.Count; Controlled = $ctl; Funded = $funded; Violations = $bad; HasMore = ($o.has_more -eq $true) }
}
# Polls until the served block is this deploy's AND the operator_funded provenance check carries the scope sentence, or STOPS (with $ROLLBACK_LINE) after $tries reads.
function Wait-NewWorker($commit, $versionId, $sentence, $tries, $delaySeconds) {
  $last = "never read"
  for ($n = 1; $n -le $tries; $n++) {
    $why = Test-CodeIdentityServed (Get-ServedCode) $commit $versionId
    if ($why -eq "") {
      $route = Get-Text $OFFICIAL_URL 30
      if ($route.Code -eq "200" -and (Test-ProvenanceHasScope $route.Body $sentence)) {
        Say "[poll] try $n of ${tries}: GET /api/attest serves code.commit $($commit.Substring(0, 8)) and code.version_id $versionId; GET /api/official carries the scope sentence"
        return
      }
      $why = "GET /api/official answered $($route.Code) and its operator_funded provenance check does not yet carry the scope sentence"
    }
    $last = $why
    Say "[poll] try $n of ${tries}: not yet: $why"
    if ($n -lt $tries) { Start-Sleep -Seconds $delaySeconds }
  }
  Stop-Here ("the new worker was never shown live in " + $tries + " reads (last: " + $last + "). The deploy is not shown to be live. " + $ROLLBACK_LINE)
}
# END-OF-DEFINITIONS (test/deploy-funding-label-script.test.ts reads everything above this line as definitions; nothing above runs git, npm, wrangler or the network)

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
# Non-minting: the attested template lives in FRONT_DOOR_TEMPLATE in src/doc.ts. This wave edits src/doc.ts only OUTSIDE it, and the proof is that the template text itself is byte-identical at both commits.
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
# The sentence the ride looks for is READ from the code, never retyped; the door clause must be in src/doc.ts.
$societyText = (Get-Content -Raw -Encoding UTF8 $SENTENCE_SOURCE)
$SCOPE_SENTENCE = Get-ScopeSentence $societyText
if ($null -eq $SCOPE_SENTENCE) { Stop-Here "$SENTENCE_SOURCE has no readable OPERATOR_FUNDED_SCOPE_SENTENCE literal: this checkout is not the funding label wave (or the literal holds an escape this script does not undo)." }
if ($SCOPE_SENTENCE.Length -lt 100 -or -not $SCOPE_SENTENCE.Contains("operator_funded")) { Stop-Here "the OPERATOR_FUNDED_SCOPE_SENTENCE read from $SENTENCE_SOURCE is implausibly short or does not name operator_funded: '$SCOPE_SENTENCE'." }
if (-not (Select-String -Path "src/doc.ts" -Pattern $DOOR_CLAUSE -SimpleMatch -Quiet)) { Stop-Here "src/doc.ts does not contain the door-note clause: this checkout is not the funding label wave." }
if (-not (Select-String -Path "src/discovery.ts" -Pattern "OPERATOR_FUNDED_SCOPE_SENTENCE" -Quiet)) { Stop-Here "src/discovery.ts does not use OPERATOR_FUNDED_SCOPE_SENTENCE: /llms.txt would not carry the sentence." }
if (-not (Select-String -Path "src/doors.ts" -Pattern '"mcp_read_tool_call"' -Quiet)) { Stop-Here "src/doors.ts does not list mcp_read_tool_call: this checkout would drop the door funnel wave." }
if (-not (Select-String -Path "src/council-core.ts" -Pattern "export const citizenCouncilFlagParts" -Quiet)) { Stop-Here "src/council-core.ts has no citizenCouncilFlagParts: this checkout would drop the council flag wave." }
if (-not (Select-String -Path "src/council.ts" -Pattern "export async function claimCouncilSeat" -Quiet)) { Stop-Here "src/council.ts has no claimCouncilSeat: this checkout would drop the council." }
if (-not (Select-String -Path "src/resident.ts" -Pattern "export async function bindResident" -Quiet)) { Stop-Here "src/resident.ts has no bindResident: this checkout would drop the resident tier." }
if (-not (Select-String -Path "src/code-identity.ts" -Pattern "export function codeBlock" -Quiet)) { Stop-Here "src/code-identity.ts has no codeBlock: this checkout would drop served code identity." }
if (-not (Select-String -Path "src/guest.ts" -Pattern "export async function postGuestComment" -Quiet)) { Stop-Here "src/guest.ts has no postGuestComment: this checkout would drop the guest voice." }
if (-not (Select-String -Path "wrangler.jsonc" -Pattern '"version_metadata"' -Quiet)) { Stop-Here "wrangler.jsonc has no version_metadata binding: the Worker could not serve Cloudflare's version id." }
if (Select-String -Path "wrangler.jsonc" -Pattern '"CODE_COMMIT"' -Quiet) { Stop-Here "wrangler.jsonc configures a CODE_COMMIT var: a deploy that forgot the flag would serve a stale stamp. The stamp comes from this script's --var only." }
Say ("[git] HEAD " + $headSha.Substring(0, 8) + " = main = origin/main = -ExpectedCommit; tree clean; contains " + $LIVE_BASE_COMMIT.Substring(0, 8) + "; FRONT_DOOR_TEMPLATE unmoved; no migration and no schema change since the live base")
Say ("[git] scope sentence read from " + $SENTENCE_SOURCE + " (" + $SCOPE_SENTENCE.Length + " chars); door clause present in src/doc.ts")

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

# 2. live, before: non-minting baseline, the live worker is the base this wave was checked against, the operator_funded provenance check does NOT yet carry the sentence (so the propagation poll proves something),
# and the composition counts are recorded for the ride to compare
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
$officialBefore = Get-Text $OFFICIAL_URL 30
if ($officialBefore.Code -ne "200") { Stop-Here "GET /api/official answered $($officialBefore.Code) before the deploy, expected 200: investigate." }
if (Test-ProvenanceHasScope $officialBefore.Body $SCOPE_SENTENCE) { Stop-Here "the operator_funded provenance check on GET /api/official already carries the scope sentence: this wave looks already deployed. Verify by hand; this script cannot prove a propagation it did not wait for." }
$snapshotBefore = Get-CompositionSnapshot $officialBefore.Body
if ($null -eq $snapshotBefore) { Stop-Here "GET /api/official carried no composition block before the deploy: the counts the ride compares against cannot be read." }
Say "[live] before: the operator_funded provenance check does not carry the scope sentence (the new code is absent); composition $snapshotBefore"

if ($DryRun) {
  Say "[dry-run] would now: run npx wrangler deploy --var CODE_COMMIT:<the full sha> and capture its Current Version ID (refusing to continue without one); poll up to $POLL_TRIES times, $POLL_DELAY_SECONDS s apart, until GET /api/attest serves that commit and version id and the operator_funded provenance check on GET /api/official carries the scope sentence; re-check attest (v5, template $($V5_HASH.Substring(0, 8)), every chain ok); ride the public reads (GET only: the provenance check and the composition note on /api/official, the note on /api/citizens, /llms.txt and GET / each carry the text; the composition counts equal the recorded ones; every operator-controlled row still operator_funded:false). NO write request of any kind, NO migration, NO D1 access and no live write at any point. Nothing was deployed."
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
Wait-NewWorker $headSha $versionId $SCOPE_SENTENCE $POLL_TRIES $POLL_DELAY_SECONDS
# END-DEPLOY-AND-POLL

# 4. the ride: non-minting and the chains, then GET-only reads of every surface that carries the sentence, the counts, and the rows. It writes nothing.
$attAfter = Read-Attest "after the deploy"
Assert-Attest $attAfter "after the deploy"
Say ("[ride] attest: v5 " + $V5_HASH.Substring(0, 8) + " unchanged; every chain ok")
$bad = @()
foreach ($p in "/", "/api/official", "/llms.txt", "/openapi.json", "/treasury", "/api/listings", "/api/stats", "/api/topics", "/api/guest/due", "/api/citizens", "/api/doors", "/api/council", "/api/residents") {
  $r = Get-Text "$BASE$p" 30
  if ($r.Code -ne "200") { $bad += "$p=$($r.Code)" }
}
if ($bad.Count -gt 0) { Stop-Here ("non-200 after the deploy (version $versionId): " + ($bad -join ", ") + ". If a read that answered before now fails: $ROLLBACK_LINE") }
Say "[ride] 13 public reads -> 200"
# the served words: the sentence on the official provenance check and composition note, the citizens note, llms.txt; the clause on the door note
$officialNow = Get-Text $OFFICIAL_URL 30
if ($officialNow.Code -ne "200") { Stop-Here "GET /api/official answered $($officialNow.Code). $ROLLBACK_LINE" }
if (-not (Test-ProvenanceHasScope $officialNow.Body $SCOPE_SENTENCE)) { Stop-Here "the operator_funded provenance check on GET /api/official does not carry the scope sentence. $ROLLBACK_LINE" }
if (-not (Test-OfficialNoteHasScope $officialNow.Body $SCOPE_SENTENCE)) { Stop-Here "the composition note on GET /api/official does not carry the scope sentence. $ROLLBACK_LINE" }
$citizensNow = Get-Text $CITIZENS_URL 30
if ($citizensNow.Code -ne "200") { Stop-Here "GET /api/citizens answered $($citizensNow.Code). $ROLLBACK_LINE" }
if (-not (Test-CitizensNoteHasScope $citizensNow.Body $SCOPE_SENTENCE)) { Stop-Here "the note on GET /api/citizens does not carry the scope sentence. $ROLLBACK_LINE" }
$llmsNow = Get-Text "$BASE/llms.txt" 30
if ($llmsNow.Code -ne "200") { Stop-Here "GET /llms.txt answered $($llmsNow.Code). $ROLLBACK_LINE" }
if (-not (Test-ContainsFlat $llmsNow.Body $SCOPE_SENTENCE)) { Stop-Here "GET /llms.txt does not carry the scope sentence. $ROLLBACK_LINE" }
$doorNow = Get-Text "$BASE/" 30
if ($doorNow.Code -ne "200") { Stop-Here "GET / answered $($doorNow.Code). $ROLLBACK_LINE" }
if (-not (Test-ContainsFlat $doorNow.Body $DOOR_CLAUSE)) { Stop-Here "the GET / door note does not carry the clause '$DOOR_CLAUSE'. $ROLLBACK_LINE" }
Say "[ride] the scope sentence is served on the operator_funded provenance check and the composition note (/api/official), the /api/citizens note and /llms.txt; the door clause is served on GET /"
# nothing moved: the composition counts equal what was served before, and every operator-controlled row still says operator_funded:false
$snapshotAfter = Get-CompositionSnapshot $officialNow.Body
if ($null -eq $snapshotAfter) { Stop-Here "GET /api/official carried no composition block after the deploy. $ROLLBACK_LINE" }
if ($snapshotAfter -cne $snapshotBefore) { Stop-Here ("the composition changed across the deploy: before '" + $snapshotBefore + "', after '" + $snapshotAfter + "'. This wave was to change words only. " + $ROLLBACK_LINE) }
$facts = Get-CitizenFlagFacts $citizensNow.Body
if ($null -eq $facts) { Stop-Here "GET /api/citizens carried no citizens array after the deploy. $ROLLBACK_LINE" }
if ($facts.HasMore) { Stop-Here "GET /api/citizens says has_more, so one page does not show every row. Read the rows by hand across pages." }
if ($facts.Controlled -lt 1) { Stop-Here "GET /api/citizens carries no operator_controlled row, so the operator_funded:false check would prove nothing. Read it by hand." }
if ($facts.Violations.Count -gt 0) { Stop-Here ("these operator-controlled rows no longer carry operator_funded:false: " + ($facts.Violations -join ", ") + ". " + $ROLLBACK_LINE) }
Say ("[ride] composition unchanged (" + $snapshotAfter + "); " + $facts.Controlled + " operator-controlled rows of " + $facts.Rows + ", every one operator_funded:false; " + $facts.Funded + " operator_funded rows")
Say "[note] Writes made by this ride: NONE. Every request was a GET; no token, no key."
Say "[done] Funding label wording deployed and ridden. Log version id $versionId, commit $($headSha.Substring(0, 8)) and these lines in HANDOVER.md."
