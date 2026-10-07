# Deploys SERVED CODE IDENTITY in ONE worker deploy: GET /api/attest gains a `code` block (the commit the deploy stamped and Cloudflare's own version id), and every settlement-claim
# answer gains `answered_by` (docs/BRIEF-SERVED-CODE-IDENTITY.md, amendments A1-A8, both exchange seats closed; build log docs/CHECKPOINT-SERVED-CODE-IDENTITY.md).
# Three outside agents asked for it on 6 Oct 2026 (1f916 95154, 95176; Colony 51cd1484), and it closes our own gap: until now no public read could tell a new worker from the old one.
# Ben's hand only (D-017). NO MIGRATION, NON-MINTING: the wave touches no file under migrations/, no schema.sql and no src/doc.ts. This script STOPS if any of those moved since the live
# worker's code ($LIVE_BASE_COMMIT), and after the deploy it STOPS if the constitution is not still v5 with its template hash. Every stop before "wrangler deploy" leaves the live worker as it was.
# It reads NOTHING from prod D1 and runs NO wrangler command except the deploy itself: -DryRun is not offline (git fetch, npm test, typecheck and public GETs) but it never calls wrangler.
# The gate for this wave is a Sonnet text-and-shape gate plus both exchange seats, not the Opus D-018 gate: it adds read-only fields to money-path ANSWERS and changes no status, code,
# `accepts`, claim write, lease or reconciler selection (brief, "Gate classification").
#
# THE DEPLOY STAMPS THE COMMIT. `npx wrangler deploy --var CODE_COMMIT:<sha>` passes the pinned 40-hex sha; CODE_COMMIT is NOT in wrangler.jsonc, and each `wrangler deploy` replaces the
# version's vars (--keep-vars defaults false), so a deploy that forgets the flag serves commit_status "not_stamped", never a stale sha. The commit is the operator's STATEMENT (checkable
# against the public repository at that commit); the version id is Cloudflare's own. Nothing served proves the running bytes were built from the commit.
# THE PROPAGATION CHECK the older scripts lacked: after the deploy this script polls GET /api/attest (12 tries, 5 s apart) until code.commit equals the pinned sha AND code.version_id equals
# the `Current Version ID` wrangler printed, with commit_status "stamped" and version_status "available". It STOPS with the rollback line if that never happens, including when
# code.version_id never equals the printed id. The live worker serves no `code` block before this deploy, so the poll proves something.
# REVIEWED SOURCE ONLY: step 0 STOPS while $REVIEWED_COMMIT still holds the placeholder (the hub sets it to the commit the code exchange converged on), and otherwise STOPS unless HEAD is that
# commit plus changes confined to $ALLOWED_PATHS_AFTER_REVIEW (this script, its test, docs/). Any other changed path, src/ or wrangler.jsonc included, is printed and STOPS.
# Pattern: scripts/deploy-refused-option-b.ps1 (L-046, L-069: one fail-fast script). Run from society/ on main, after the merge and the push:
#   cd "C:\Users\bengr\Projects\AI domain and social network\society"
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-code-identity.ps1 -ExpectedCommit <sha> -DryRun   # every check, nothing deployed, no wrangler
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-code-identity.ps1 -ExpectedCommit <sha>           # the real thing
# <sha> is the pushed tip of main (git -C society rev-parse HEAD), the full 40 hex.
# THE ONE REAL RIDE: the `code` block on GET /api/attest is proved live by the poll above. `answered_by` on a claim answer cannot be staged (an answer exists only for a real signed
# payment authorisation that conflicts with, or replays, a claim); it is first ridden by the next real replayed or conflicting claim answer. Until then it is proved by tests only.
# Windows seam: `--var "CODE_COMMIT:<sha>"` has no space, quote, `%` or `^` in it; PowerShell 5.1 hands it to npx.cmd as one argument. The test runs this exact line against a stand-in for npx.
# PowerShell 5.1 traps this file avoids (all seen live): $COLS and $cols are the SAME variable (one spelling per name here); -notmatch on an
# array filters instead of testing; a one-element return is wrapped in @(); "$var:" is a drive reference (write "${var}:"); never merge a
# native command's stderr under ErrorActionPreference Stop; -eq and -ne are case-INSENSITIVE (hashes, shas and states are compared with -ceq / -cne). ASCII only.
param(
  [Parameter(Mandatory = $true)][string]$ExpectedCommit,
  [switch]$DryRun
)
$ErrorActionPreference = "Stop"
$BASE = "https://commonhold.randommonicle.workers.dev"
# The attested constitution this wave must leave untouched (test/deploy-code-identity-script.test.ts compares it with computeLiveConstitutionPair's hash).
$V5_HASH = "fa11788d062b0c6d23c54c428c1c9649d263ae3ba704e602e122066926049491"
# The live worker's code before this wave: main at the served-code-identity deploy (the evening of 6 Oct 2026, worker 8421a724 per HANDOVER Addendum 87 s9; its code is the merge
# f66c061c plus the $REVIEWED_COMMIT commit ecbd51ff). Step 0 proves HEAD descends from it and that nothing under migrations/ or src/doc.ts and no schema.sql moved since.
$LIVE_BASE_COMMIT = "ecbd51ff5389ab7999b67a5b8e4187294df724eb"
# THE REVIEWED SOURCE. The hub replaces this placeholder with the full sha the code exchange converged on; step 0 STOPS while it is unchanged, and while it is not 40 lower-case hex.
# HEAD may differ from it ONLY in $ALLOWED_PATHS_AFTER_REVIEW: this script, its test, and anything under docs/ (an entry ending in "/" is a directory prefix, any other entry an exact
# path). A change anywhere else (src/, migrations/, schema.sql, package.json, package-lock.json, wrangler.jsonc, tsconfig.json, .claude/, any other path) STOPS step 0: that code was not reviewed.
$REVIEWED_COMMIT = "TO-BE-SET-BY-HUB"
$REVIEWED_COMMIT_PLACEHOLDER = "TO-BE-SET-BY-HUB"
$ALLOWED_PATHS_AFTER_REVIEW = @("scripts/deploy-code-identity.ps1", "test/deploy-code-identity-script.test.ts", "docs/")
$ATTENTION_URL = "$BASE/api/settlements/attention"
# The propagation poll (brief: "bounded: e.g. 12 tries, 5 s apart").
$POLL_TRIES = 12
$POLL_DELAY_SECONDS = 5
# node's test summary is the LAST thing npm test prints on a run that finishes cleanly: eight consecutive lines, "tests N", "suites N", "pass N", "fail N", "cancelled N", "skipped N", "todo N" and
# "duration_ms N.N", each after at most one prefix token (an info mark, or whatever the console's code page makes of it), with nothing after the last but whitespace. The pattern matches that whole block
# ANCHORED AT THE END of the output (\z), so test TITLES, which node prints before the summary, are never it: not a pass/fail pair, and not four titles shaped like the first four lines (CODEX build
# r1 F2 and r2). The script also requires tests == pass + fail + cancelled + skipped + todo. What this does NOT claim: on a FAILING run node prints the failure detail AFTER the summary, so the
# pattern finds no block and the script STOPs ("does not END with node's summary") instead of reading counts, which is the safe direction; and eight lines shaped exactly like the summary at the END
# of the output, written by something other than node, are out of reach of any parser. The older scripts took the first "pass (\d+)" anywhere.
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
# The counts in the eight-line summary block at the END of $testOut, as @{ Tests; Pass; Fail; Cancelled; Skipped; Todo; SumOk } (Pass and Fail as strings), or $null when the output does not end with one.
function Get-TestSummary($testOut) {
  $found = [regex]::Matches([string]$testOut, $TEST_SUMMARY_PATTERN)
  if ($found.Count -lt 1) { return $null }
  $last = $found[$found.Count - 1]
  $counts = @(1..7 | ForEach-Object { [int64]$last.Groups[$_].Value })
  return @{ Tests = $counts[0]; Pass = $last.Groups[3].Value; Fail = $last.Groups[4].Value; Cancelled = $counts[4]; Skipped = $counts[5]; Todo = $counts[6]; SumOk = ($counts[0] -eq ($counts[2] + $counts[3] + $counts[4] + $counts[5] + $counts[6])) }
}
function Test-Number($v) { return ($v -is [int] -or $v -is [long] -or $v -is [decimal] -or $v -is [double]) }
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
# Reads GET /api/settlements/attention and /api/official and requires the list's total to be a number equal to economy.settlements_awaiting_a_person
# (two reads, so a claim moving between them is possible: re-read before calling it a defect). Returns the total.
function Read-AttentionAndOfficial($when) {
  $attn = Get-Json $ATTENTION_URL
  foreach ($field in "count", "total", "has_more", "entries", "markers", "limit") {
    if (-not ($attn.PSObject.Properties.Name -contains $field)) { Stop-Here "GET /api/settlements/attention has no '$field' field $when." }
  }
  if (-not (Test-Number $attn.total)) { Stop-Here "GET /api/settlements/attention total is not a number $when ('$($attn.total)')." }
  $official = Get-Json "$BASE/api/official"
  if ($null -eq $official.economy -or -not ($official.economy.PSObject.Properties.Name -contains "settlements_awaiting_a_person")) { Stop-Here "GET /api/official economy has no settlements_awaiting_a_person $when." }
  if (-not (Test-Number $official.economy.settlements_awaiting_a_person)) { Stop-Here "GET /api/official economy.settlements_awaiting_a_person is not a number $when ('$($official.economy.settlements_awaiting_a_person)')." }
  if ([int64]$official.economy.settlements_awaiting_a_person -ne [int64]$attn.total) { Stop-Here ("/api/official economy.settlements_awaiting_a_person is " + $official.economy.settlements_awaiting_a_person + " but the attention list's total is " + $attn.total + " ${when}: re-read both by hand (a claim may have moved between the reads) before calling it a defect.") }
  return [int64]$attn.total
}
# The `code` block GET /api/attest serves now, or $null when the read fails, is not JSON, or carries no code block (the old worker, or a worker still propagating). Never stops: the poll decides.
function Get-ServedCode {
  $r = Get-Text "$BASE/api/attest" 30
  if ($r.Code -ne "200") { return $null }
  try { $served = ($r.Body | ConvertFrom-Json) } catch { return $null }
  if ($null -eq $served) { return $null }
  return $served.code
}
# "" when $code is the block THIS deploy should be serving, otherwise the reason it is not. Every comparison is case-sensitive (a sha is lower-case hex; a version id is compared lower-cased on both sides).
function Test-CodeIdentityServed($code, $commit, $versionId) {
  if ($null -eq $code) { return "GET /api/attest serves no code block (the old worker, or an unreadable answer)" }
  if ([string]$code.commit_status -cne "stamped") { return ("code.commit_status is '" + $code.commit_status + "', expected stamped") }
  if ([string]$code.commit -cne $commit) { return ("code.commit is '" + $code.commit + "', expected the pinned sha " + $commit) }
  if ([string]$code.version_status -cne "available") { return ("code.version_status is '" + $code.version_status + "', expected available") }
  if (([string]$code.version_id).ToLowerInvariant() -cne ([string]$versionId).ToLowerInvariant()) { return ("code.version_id is '" + $code.version_id + "', expected the Current Version ID wrangler printed (" + $versionId + ")") }
  return ""
}
# Polls until the served block is this deploy's, or STOPS (with $ROLLBACK_LINE) after $tries reads.
function Wait-CodeIdentity($commit, $versionId, $tries, $delaySeconds) {
  $last = "never read"
  for ($n = 1; $n -le $tries; $n++) {
    $why = Test-CodeIdentityServed (Get-ServedCode) $commit $versionId
    if ($why -eq "") {
      Say "[poll] try $n of ${tries}: GET /api/attest serves code.commit $($commit.Substring(0, 8)) and code.version_id $versionId"
      return
    }
    $last = $why
    Say "[poll] try $n of ${tries}: not yet: $why"
    if ($n -lt $tries) { Start-Sleep -Seconds $delaySeconds }
  }
  Stop-Here ("GET /api/attest never served this deploy's identity in " + $tries + " reads (last: " + $last + "). The deploy is not shown to be live. " + $ROLLBACK_LINE)
}
# END-OF-DEFINITIONS (test/deploy-code-identity-script.test.ts evaluates everything above this line; nothing above runs git, npm, wrangler or the network)

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
  Stop-Here ("main, origin/main and -ExpectedCommit are not one commit: HEAD " + $headSha.Substring(0, 8) + ", main " + $mainSha.Substring(0, 8) + ", origin/main " + $originSha.Substring(0, 8) + ", expected " + $expectedSha.Substring(0, 8) + ". Merge, push, and pass the pushed sha.")
}
# The stamp is this sha, in full, lower-case: the code serves a commit only if it matches ^[0-9a-f]{40}$ (src/code-identity.ts), so anything else would deploy as "malformed_stamp".
if ($headSha -cnotmatch '^[0-9a-f]{40}$') { Stop-Here "HEAD '$headSha' is not 40 lower-case hex: it could not be stamped (the Worker would serve malformed_stamp)." }
# Every git read below checks its own exit code before its output is read: a failed native command prints nothing, and nothing must not read
# as "clean" or "no change" (CODEX deploy-script r1, finding 1: an exit 128 with empty stdout passed both guards).
$dirty = @(git status --porcelain)
if ($LASTEXITCODE -ne 0) { Stop-Here "git status failed (exit $LASTEXITCODE): the clean-tree check cannot be read." }
if ($dirty.Count -gt 0) { Stop-Here ("working tree not clean (" + $dirty.Count + " paths): the deploy must ship exactly the committed tree.") }
git merge-base --is-ancestor $LIVE_BASE_COMMIT HEAD
if ($LASTEXITCODE -ne 0) { Stop-Here "HEAD does not contain $($LIVE_BASE_COMMIT.Substring(0, 8)) (the live worker's code): this deploy would drop served code identity and the waves before it." }
$schemaMoves = @(git diff --name-only $LIVE_BASE_COMMIT HEAD -- migrations schema.sql src/doc.ts)
if ($LASTEXITCODE -ne 0) { Stop-Here "git diff failed (exit $LASTEXITCODE): the no-migration check cannot be read." }
if ($schemaMoves.Count -gt 0) { Stop-Here ("this wave was to carry no migration and no constitution change, but these moved since " + $LIVE_BASE_COMMIT.Substring(0, 8) + ": " + ($schemaMoves -join ", ") + ". Not this script's deploy.") }
# BEGIN-REVIEWED-SOURCE-CHECK
# (a) the reviewed commit is set, and is a full sha
if ($REVIEWED_COMMIT -ceq $REVIEWED_COMMIT_PLACEHOLDER) { Stop-Here "`$REVIEWED_COMMIT still holds the placeholder '$REVIEWED_COMMIT_PLACEHOLDER': the hub sets it to the commit the code exchange converged on, and until then there is no reviewed source to deploy." }
if ($REVIEWED_COMMIT -cnotmatch '^[0-9a-f]{40}$') { Stop-Here "`$REVIEWED_COMMIT '$REVIEWED_COMMIT' is not 40 lower-case hex." }
# (b) HEAD is the reviewed commit plus only the allowlisted paths (no rename detection: a rename out of src/ into docs/ must list BOTH paths)
git merge-base --is-ancestor $REVIEWED_COMMIT HEAD
if ($LASTEXITCODE -ne 0) { Stop-Here "HEAD does not contain the reviewed commit $($REVIEWED_COMMIT.Substring(0, 8)): this is not the code that was reviewed." }
$afterReview = @(git diff --name-only --no-renames $REVIEWED_COMMIT HEAD)
if ($LASTEXITCODE -ne 0) { Stop-Here "git diff failed (exit $LASTEXITCODE): the changes since the reviewed commit cannot be read." }
$unreviewed = @(Get-DisallowedPaths $afterReview)
if ($unreviewed.Count -gt 0) { Stop-Here ("these paths changed since the reviewed commit " + $REVIEWED_COMMIT.Substring(0, 8) + " and are not on the allowlist (" + ($ALLOWED_PATHS_AFTER_REVIEW -join ", ") + "), so what would ship was not reviewed: " + ($unreviewed -join ", ")) }
Say ("[git] reviewed source: HEAD differs from " + $REVIEWED_COMMIT.Substring(0, 8) + " in " + $afterReview.Count + " path(s), all on the allowlist")
# END-REVIEWED-SOURCE-CHECK
if (-not (Test-Path "src/code-identity.ts")) { Stop-Here "src/code-identity.ts is missing: this checkout is not the code identity wave." }
if (-not (Select-String -Path "src/settlement-claims.ts" -Pattern 'export function claimResponse\(answer: ClaimAnswer, identity: CodeIdentity\)' -Quiet)) { Stop-Here "src/settlement-claims.ts has no claimResponse(answer, identity): this checkout is not the code identity wave." }
if (-not (Select-String -Path "src/settlement-claims.ts" -Pattern "export async function markFirstRefusal" -Quiet)) { Stop-Here "src/settlement-claims.ts has no markFirstRefusal: this checkout would drop option B." }
if (-not (Test-Path "src/settlement-attention.ts")) { Stop-Here "src/settlement-attention.ts is missing: this checkout would drop M3." }
if (-not (Select-String -Path "src/society.ts" -Pattern "export function parseLedgerCursor" -Quiet)) { Stop-Here "src/society.ts has no parseLedgerCursor: this checkout would drop the treasury pagination." }
if (-not (Select-String -Path "src/guest.ts" -Pattern "export async function postGuestComment" -Quiet)) { Stop-Here "src/guest.ts has no postGuestComment: this checkout would drop the guest voice." }
if (-not (Select-String -Path "wrangler.jsonc" -Pattern '"version_metadata"' -Quiet)) { Stop-Here "wrangler.jsonc has no version_metadata binding: the Worker could not serve Cloudflare's version id." }
if (Select-String -Path "wrangler.jsonc" -Pattern '"CODE_COMMIT"' -Quiet) { Stop-Here "wrangler.jsonc configures a CODE_COMMIT var: a deploy that forgot the flag would serve a stale stamp. The stamp comes from this script's --var only." }
Say ("[git] HEAD " + $headSha.Substring(0, 8) + " = main = origin/main = -ExpectedCommit; tree clean; contains " + $LIVE_BASE_COMMIT.Substring(0, 8) + "; code identity present; no migration, schema or doc.ts change since")

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

# 2. live, before: non-minting baseline, the old worker serving no code block (so the propagation poll proves something), the public surfaces this deploy must leave answering
$attBefore = Read-Attest "before the deploy"
Assert-Attest $attBefore "before the deploy"
Say ("[live] before: v5 " + $V5_HASH.Substring(0, 8) + "; all four chains ok; identity " + $attBefore.identity_log.sealed_entries + ", treasury " + $attBefore.treasury.sealed_entries + ", ballots " + $attBefore.ballots.sealed_entries)
if ($null -eq $attBefore.code) {
  Say "[live] before: GET /api/attest serves no code block (the old worker): the poll below can tell the new one from it"
} elseif ([string]$attBefore.code.commit -ceq $headSha) {
  Stop-Here "GET /api/attest already serves code.commit $($headSha.Substring(0, 8)): this commit looks already deployed. Verify by hand; this script cannot prove a propagation it did not wait for."
} else {
  Say ("[live] before: GET /api/attest already serves a code block (commit_status '" + $attBefore.code.commit_status + "', version_id '" + $attBefore.code.version_id + "'): a redeploy; the poll waits for THIS commit and version")
}
$totalBefore = Read-AttentionAndOfficial "before the deploy"
Say ("[live] before: GET /api/settlements/attention answers 200 (M3 is live), total " + $totalBefore + " = /api/official economy.settlements_awaiting_a_person")

if ($DryRun) {
  Say "[dry-run] would now: run npx wrangler deploy --var CODE_COMMIT:$($headSha.Substring(0, 8))... (the full sha) and capture its Current Version ID (refusing to continue without one); poll GET /api/attest up to $POLL_TRIES times, $POLL_DELAY_SECONDS s apart, until code.commit is the pinned sha and code.version_id is that id; re-check attest (v5, template $($V5_HASH.Substring(0, 8)), every chain ok); ride 13 public reads and the attention list. Nothing was deployed and wrangler was not called."
  exit 0
}

# 3. deploy the worker with the commit stamp, capturing its version id (a deploy whose id cannot be read is a stop: it cannot be tied to this commit), then poll until the served identity is this deploy's
# BEGIN-DEPLOY-AND-POLL
Say "[deploy] npx wrangler deploy --var CODE_COMMIT:$($headSha.Substring(0, 8))... (commit $($headSha.Substring(0, 8)))"
$ErrorActionPreference = "Continue"
$deployOut = (npx wrangler deploy --var "CODE_COMMIT:$headSha" 2>&1 | Out-String)
$deployCode = $LASTEXITCODE
$ErrorActionPreference = "Stop"
if ($deployCode -ne 0) { Stop-Here "wrangler deploy failed (exit $deployCode); nothing else was changed (no migration in this wave). Output: $deployOut" }
# The id is read from its OWN line (anchored at both ends, so a longer line, a quoted line or a bare mention in other output is not it), and exactly one such line must exist: with two, which one is this
# deploy's cannot be told from the output, and a first-match capture could tie the poll to the wrong id.
$versionMatches = @([regex]::Matches($deployOut, '(?m)^[ \t]*Current Version ID:[ \t]*([0-9a-fA-F-]{36})[ \t]*\r?$'))
if ($versionMatches.Count -gt 1) { Stop-Here ("wrangler deploy printed 'Current Version ID' on " + $versionMatches.Count + " lines; which one is this deploy's cannot be told, and the deploy may have succeeded. Check 'npx wrangler deployments list' by hand before anything else.") }
if ($versionMatches.Count -lt 1) { Stop-Here "wrangler deploy exited 0 but printed no 'Current Version ID'; the deploy may have succeeded. Check 'npx wrangler deployments list' by hand before anything else." }
$versionId = $versionMatches[0].Groups[1].Value
Say "[deploy] worker version id $versionId (commit $($headSha.Substring(0, 8)))"
$ROLLBACK_LINE = "ROLL BACK THE WORKER (npx wrangler rollback, to the version before $versionId, which should be 8421a724 per HANDOVER Addendum 87 s9; check npx wrangler deployments list first). No migration to undo; the old worker ignores the stamp and the binding."
Wait-CodeIdentity $headSha $versionId $POLL_TRIES $POLL_DELAY_SECONDS
# END-DEPLOY-AND-POLL

# 4. the ride: non-minting and the chains, the served code block's shape, then the unchanged public surfaces
$attAfter = Read-Attest "after the deploy"
Assert-Attest $attAfter "after the deploy"
Say ("[ride] attest: v5 " + $V5_HASH.Substring(0, 8) + " unchanged; every chain ok; identity " + $attAfter.identity_log.sealed_entries + ", treasury " + $attAfter.treasury.sealed_entries + ", ballots " + $attAfter.ballots.sealed_entries)
if ($null -eq $attAfter.code -or $null -eq $attAfter.code.provenance -or $null -eq $attAfter.code.provenance.commit -or $null -eq $attAfter.code.provenance.version_id) { Stop-Here "GET /api/attest serves a code block without its provenance after the deploy (version $versionId): the labels are part of the claim. $ROLLBACK_LINE" }
Say ("[ride] code block: commit " + $attAfter.code.commit + " (" + $attAfter.code.commit_status + "), version " + $attAfter.code.version_id + " (" + $attAfter.code.version_status + "), uploaded " + $attAfter.code.version_timestamp + "; provenance labels served")
$bad = @()
foreach ($p in "/", "/api/official", "/llms.txt", "/skill.md", "/heartbeat.md", "/openapi.json", "/treasury", "/api/listings", "/api/listings/payments", "/api/stats", "/api/topics", "/api/guest/due", "/api/citizens") {
  $r = Get-Text "$BASE$p" 30
  if ($r.Code -ne "200") { $bad += "$p=$($r.Code)" }
}
if ($bad.Count -gt 0) { Stop-Here ("non-200 after the deploy (version $versionId): " + ($bad -join ", ") + ". If a read that answered before now fails: $ROLLBACK_LINE") }
Say "[ride] 13 public reads -> 200"
$totalAfter = Read-AttentionAndOfficial "after the deploy (version $versionId)"
Say ("[ride] GET /api/settlements/attention answers 200, total " + $totalAfter + " = /api/official economy.settlements_awaiting_a_person (was " + $totalBefore + " before)")
if ($totalAfter -gt 0) { Say ("[note] " + $totalAfter + " settlement claim(s) await a person: read the list and the claims by hand after this ride.") }

Say "[note] answered_by on a claim answer is first ridden by the NEXT REAL replayed or conflicting claim answer; it cannot be staged. Until then it is proved by tests only. The code block above is proved live."
Say "[done] Code identity deployed and shown live by the poll. Log version id $versionId, commit $($headSha.Substring(0, 8)) and these lines in HANDOVER.md; the outward close (the 1f916 and Colony envoys) goes through the exchange."
