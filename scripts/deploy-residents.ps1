# Deploys the RESIDENT TIER (D-075 order step b; build log docs/CHECKPOINT-RESIDENTS.md): migration 0020 (two columns on guests, a partial unique index, and the resident_nonces table) to
# the REMOTE D1 FIRST, then ONE worker deploy that carries POST /api/resident/bind, POST /api/resident/token, GET /api/residents, GET /api/resident/:number, the resident_bind and
# resident_token tools on /mcp, the resident byline and tier on every guest row, the residents block on /api/official and /skill.md 1.3.0. Ben's hand only (D-017). One fail-fast script (L-046, L-069).
# WRITTEN BY THE BUILDER AND NEVER RUN: not even -DryRun, which reads the remote D1 through wrangler (reads only, no write). The Sonnet gate, the merge and the push come before it, and
# the MCP guest door wave (D-075 order step a, scripts/deploy-mcp-guest-door.ps1) must already be LIVE: this wave is built on top of it and needs its door_counts table.
# TWO PLACEHOLDERS, both set by the hub: $LIVE_BASE_COMMIT (the commit the live worker serves when this runs, which is wave a's deployed commit) and $REVIEWED_COMMIT (the commit the review
# converged on). Step 0 STOPS, before any git or remote command, while EITHER still holds its placeholder or is not 40 lower-case hex. $LIVE_BASE_COMMIT is also proved against the live worker:
# step 2 STOPS unless GET /api/attest serves code.commit equal to it, so a hub typo cannot pass.
# NO MINT: this wave edits src/doc.ts OUTSIDE FRONT_DOOR_TEMPLATE (the showhome door note), so the check is not "doc.ts unmoved" but "the template text unmoved": step 0 extracts
# FRONT_DOOR_TEMPLATE from src/doc.ts at $LIVE_BASE_COMMIT and at HEAD and STOPS if they differ by a byte. After the deploy it STOPS if the constitution is not still v5 with its template hash.
# Order is load-bearing: the new worker reads guests.public_key on every guest-thread read and every guest comment. A worker deployed before the columns exist would 500 on them.
# Migration 0020 therefore goes to the REMOTE D1 first, is catalogue-verified (the two new guests columns in table order, the partial unique index on public_key, resident_nonces with its
# columns, its primary key and its expiry index, zero foreign keys on either table), and only then does the worker deploy. Migration 0020 is additive and harmless to the OLD worker, which
# never names the new columns or the new table (an INSERT or SELECT by column name is unaffected by two appended nullable columns), so every stop before "wrangler deploy" leaves the live worker as it was.
# 0020 is NOT idempotent (ALTER TABLE ADD COLUMN fails on a second apply), so the script reads the catalogue FIRST and applies the file only when the columns are absent.
# THE DEPLOY STAMPS THE COMMIT: `npx wrangler deploy --var CODE_COMMIT:<sha>` (served code identity). The poll after the deploy waits until GET /api/attest serves code.commit equal to the
# pinned sha AND code.version_id equal to the Current Version ID wrangler printed. The ROLLBACK TARGET is the version id GET /api/attest served BEFORE the deploy (read live, never typed in).
# REVIEWED SOURCE ONLY: step 0 also STOPS unless HEAD is $REVIEWED_COMMIT plus changes confined to $ALLOWED_PATHS_AFTER_REVIEW (this script, its test, docs/).
# Run from society/ on main, after the merge and the push:
#   cd "C:\Users\bengr\Projects\AI domain and social network\society"
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-residents.ps1 -ExpectedCommit <sha> -DryRun   # every check and the remote READS, nothing written, nothing deployed
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-residents.ps1 -ExpectedCommit <sha>           # the real thing
#   ... -MigrationAlreadyApplied   only to re-run after a failed or interrupted wrangler deploy, when 0020 is already on prod
# <sha> is the pushed tip of main (git -C society rev-parse HEAD), the full 40 hex.
# THE RIDE MAKES NO LIVE WRITE. A bind needs a private key this script would have to hold, and a script that holds a key is a script that writes an identity. The ride is public GETs, POST /mcp
# tools/list and POST /mcp/read tools/list (both read-only). The first bind and the first recovery are first ridden by the first real resident; until then they are proved by tests only.
# PowerShell 5.1 traps this file avoids (all seen live): $COLS and $cols are the SAME variable (one spelling per name here); -notmatch on an array filters instead of testing;
# a one-element return is wrapped in @(); "$var:" is a drive reference (write "${var}:"); an Invoke-WebRequest 4xx body is in $_.ErrorDetails.Message; never merge a native command's stderr
# under ErrorActionPreference Stop; -eq and -ne are case-INSENSITIVE (hashes, shas and states are compared with -ceq / -cne). ASCII only: 5.1 reads a BOM-less UTF-8 script as the ANSI code page.
param(
  [Parameter(Mandatory = $true)][string]$ExpectedCommit,
  [switch]$DryRun,
  [switch]$MigrationAlreadyApplied
)
$ErrorActionPreference = "Stop"
$BASE = "https://commonhold.randommonicle.workers.dev"
# The attested constitution this wave must leave untouched.
$V5_HASH = "fa11788d062b0c6d23c54c428c1c9649d263ae3ba704e602e122066926049491"
# The commit the live worker serves when this runs (the MCP guest door wave, once deployed). The hub replaces this placeholder; step 0 STOPS while it is unchanged, and while it is not 40 lower-case hex.
$LIVE_BASE_COMMIT = "TO-BE-SET-BY-HUB-LIVE-BASE"
$LIVE_BASE_PLACEHOLDER = "TO-BE-SET-BY-HUB-LIVE-BASE"
# THE REVIEWED SOURCE. The hub replaces this placeholder with the full sha the review converged on; step 0 STOPS while it is unchanged, and while it is not 40 lower-case hex.
$REVIEWED_COMMIT = "TO-BE-SET-BY-HUB"
$REVIEWED_COMMIT_PLACEHOLDER = "TO-BE-SET-BY-HUB"
$ALLOWED_PATHS_AFTER_REVIEW = @("scripts/deploy-residents.ps1", "test/deploy-residents-script.test.ts", "docs/")
$MIGRATION_GLOB = "migrations/0020_*.sql"
$MIGRATION_PATH_EXPECTED = "migrations/0020_residents.sql"
# From migrations/0020_residents.sql and the guests table of 0018. The test compares these lists with the migration and with schema.sql.
$GUESTS_NEW_COLUMNS = @("public_key", "resident_at")
$GUESTS_COLUMN_NAMES = @("id", "visitor_id", "token_hash", "handle", "model", "created_at", "public_key", "resident_at")
$NONCE_COLUMN_NAMES = @("nonce", "visitor_id", "expires_at")
$NONCE_KEY_NAMES = @("nonce")
$KEY_INDEX_NAME = "idx_guests_public_key"
$EXPIRY_INDEX_NAME = "idx_resident_nonces_expiry"
# The propagation poll waits for THIS route to answer 200 (a route only this wave serves); the pre-deploy probe proves it answers 404 first.
$NEW_CODE_URL = "$BASE/api/residents"
$SKILL_VERSION_LINE = "version: 1.3.0"
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
function Read-D1Json($lines) {
  $txt = ($lines | Out-String)
  $i = $txt.IndexOf("[")
  if ($i -lt 0) { Stop-Here "wrangler d1 returned no JSON: $txt" }
  return ($txt.Substring($i) | ConvertFrom-Json)
}
# Strict READ of the remote D1: a failed or empty query STOPS; nothing reasons from a bad read (an empty result must never read as "absent").
function Invoke-D1Read($sql) {
  # stdout only, no stderr redirect (the proven pattern of scripts/deploy-wallet-pin.ps1): merging stderr would wrap any wrangler notice in an error record. The exit code is read after.
  $raw = (npx wrangler d1 execute commonhold --remote --json --command $sql)
  $code = $LASTEXITCODE
  if ($code -ne 0) { Stop-Here "wrangler d1 execute failed (exit $code) for: $sql" }
  $parsed = Read-D1Json $raw
  if ($null -eq $parsed -or @($parsed).Count -lt 1 -or $null -eq $parsed[0].results) { Stop-Here "wrangler d1 returned no results object for: $sql" }
  return @($parsed[0].results)
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
# A JSON-RPC POST to the live worker with the body in a temp file (no quoting seam), returning @{ Code; Body }. Used for READ-ONLY calls only (tools/list); this script makes no live write.
function Post-Json($url, $json) {
  $in = [System.IO.Path]::GetTempFileName()
  $out = [System.IO.Path]::GetTempFileName()
  try {
    [System.IO.File]::WriteAllText($in, $json, (New-Object System.Text.UTF8Encoding($false)))
    $code = (curl.exe -s --max-time 30 -o $out -w "%{http_code}" -X POST $url -H "content-type: application/json" --data-binary "@$in")
    $body = (Get-Content $out -Raw -ErrorAction SilentlyContinue)
    if ($null -eq $body) { $body = "" }
    return @{ Code = "$code"; Body = $body }
  } finally {
    Remove-Item $in, $out -ErrorAction SilentlyContinue
  }
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
# Polls until the served block is this deploy's AND the new route answers 200, or STOPS (with $ROLLBACK_LINE) after $tries reads.
function Wait-NewWorker($commit, $versionId, $tries, $delaySeconds) {
  $last = "never read"
  for ($n = 1; $n -le $tries; $n++) {
    $why = Test-CodeIdentityServed (Get-ServedCode) $commit $versionId
    if ($why -eq "") {
      $route = Get-Text $NEW_CODE_URL 30
      if ($route.Code -eq "200") {
        Say "[poll] try $n of ${tries}: GET /api/attest serves code.commit $($commit.Substring(0, 8)) and code.version_id $versionId; GET /api/residents answers 200"
        return
      }
      $why = "GET /api/residents answered $($route.Code), expected 200"
    }
    $last = $why
    Say "[poll] try $n of ${tries}: not yet: $why"
    if ($n -lt $tries) { Start-Sleep -Seconds $delaySeconds }
  }
  Stop-Here ("the new worker was never shown live in " + $tries + " reads (last: " + $last + "). The deploy is not shown to be live. " + $ROLLBACK_LINE)
}
# The catalogue of what migration 0020 leaves on the remote D1. Every mismatch STOPS (the worker must not deploy against it).
function Assert-ResidentSchema {
  $info = @(Invoke-D1Read "SELECT cid, name, type, pk FROM pragma_table_info('guests') ORDER BY cid")
  $gotNames = @($info | ForEach-Object { $_.name })
  if ($gotNames.Count -ne $GUESTS_COLUMN_NAMES.Count) { Stop-Here ("guests has " + $gotNames.Count + " columns, expected " + $GUESTS_COLUMN_NAMES.Count + ": " + ($gotNames -join ", ")) }
  for ($k = 0; $k -lt $GUESTS_COLUMN_NAMES.Count; $k++) {
    if ($gotNames[$k] -cne $GUESTS_COLUMN_NAMES[$k]) { Stop-Here ("guests column " + $k + " is '" + $gotNames[$k] + "', expected '" + $GUESTS_COLUMN_NAMES[$k] + "'") }
  }
  $idx = @(Invoke-D1Read "SELECT name, `"unique`" AS is_unique, partial FROM pragma_index_list('guests') WHERE name = '$KEY_INDEX_NAME'")
  if ($idx.Count -ne 1) { Stop-Here "guests carries $($idx.Count) indexes named $KEY_INDEX_NAME, expected 1." }
  if ("$($idx[0].is_unique)" -cne "1") { Stop-Here "$KEY_INDEX_NAME is not UNIQUE." }
  if ("$($idx[0].partial)" -cne "1") { Stop-Here "$KEY_INDEX_NAME is not partial: it would refuse a second unbound guest." }
  $idxSql = @(Invoke-D1Read "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = '$KEY_INDEX_NAME'")
  if ($idxSql.Count -ne 1 -or -not ([string]$idxSql[0].sql).Contains("WHERE public_key IS NOT NULL")) { Stop-Here "$KEY_INDEX_NAME is not defined over WHERE public_key IS NOT NULL." }
  $nonceInfo = @(Invoke-D1Read "SELECT cid, name, type, pk FROM pragma_table_info('resident_nonces') ORDER BY cid")
  $nonceNames = @($nonceInfo | ForEach-Object { $_.name })
  if ($nonceNames.Count -ne $NONCE_COLUMN_NAMES.Count) { Stop-Here ("resident_nonces has " + $nonceNames.Count + " columns, expected " + $NONCE_COLUMN_NAMES.Count + ": " + ($nonceNames -join ", ")) }
  for ($k = 0; $k -lt $NONCE_COLUMN_NAMES.Count; $k++) {
    if ($nonceNames[$k] -cne $NONCE_COLUMN_NAMES[$k]) { Stop-Here ("resident_nonces column " + $k + " is '" + $nonceNames[$k] + "', expected '" + $NONCE_COLUMN_NAMES[$k] + "'") }
  }
  $nonceKey = @($nonceInfo | Where-Object { [int]$_.pk -gt 0 } | Sort-Object { [int]$_.pk } | ForEach-Object { $_.name })
  if (($nonceKey -join ",") -cne ($NONCE_KEY_NAMES -join ",")) { Stop-Here ("resident_nonces primary key is (" + ($nonceKey -join ", ") + "), expected (" + ($NONCE_KEY_NAMES -join ", ") + ")") }
  $expiry = @(Invoke-D1Read "SELECT name FROM sqlite_master WHERE type = 'index' AND name = '$EXPIRY_INDEX_NAME' AND tbl_name = 'resident_nonces'")
  if ($expiry.Count -ne 1) { Stop-Here "resident_nonces has no $EXPIRY_INDEX_NAME index." }
  foreach ($table in "guests", "resident_nonces") {
    $fkRows = @(Invoke-D1Read "SELECT COUNT(*) AS n FROM pragma_foreign_key_list('$table')")
    if ($fkRows.Count -ne 1 -or "$($fkRows[0].n)" -cne "0") { Stop-Here "$table carries a foreign key, or the foreign key list could not be read." }
  }
}
# END-OF-DEFINITIONS (test/deploy-residents-script.test.ts reads everything above this line as definitions; nothing above runs git, npm, wrangler or the network)

# 0a. the two pins, BEFORE any git, npm, wrangler or network command: a placeholder is never a commit, and a malformed pin must not reach `git merge-base`
# BEGIN-PIN-CHECK
if ($LIVE_BASE_COMMIT -ceq $LIVE_BASE_PLACEHOLDER) { Stop-Here "`$LIVE_BASE_COMMIT still holds the placeholder '$LIVE_BASE_PLACEHOLDER': the hub sets it to the commit the live worker serves (the MCP guest door deploy), and until then there is no base to check this wave against. Nothing was read or written." }
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
# Non-minting: the attested template lives in FRONT_DOOR_TEMPLATE in src/doc.ts. This wave edits src/doc.ts OUTSIDE it, so the proof is that the template text itself is byte-identical at both commits.
$liveDoc = (@(git show ($LIVE_BASE_COMMIT + ":src/doc.ts")) -join "`n")
if ($LASTEXITCODE -ne 0) { Stop-Here "git show $($LIVE_BASE_COMMIT.Substring(0, 8)):src/doc.ts failed (exit $LASTEXITCODE): the no-mint check cannot be read." }
$headDoc = (@(git show ($headSha + ":src/doc.ts")) -join "`n")
if ($LASTEXITCODE -ne 0) { Stop-Here "git show $($headSha.Substring(0, 8)):src/doc.ts failed (exit $LASTEXITCODE): the no-mint check cannot be read." }
$liveTemplate = Get-TemplateText $liveDoc
$headTemplate = Get-TemplateText $headDoc
if ($null -eq $liveTemplate -or $null -eq $headTemplate) { Stop-Here "FRONT_DOOR_TEMPLATE could not be found in src/doc.ts at one of the two commits: the no-mint check cannot be read." }
if ($liveTemplate -cne $headTemplate) { Stop-Here "FRONT_DOOR_TEMPLATE differs between $($LIVE_BASE_COMMIT.Substring(0, 8)) and HEAD: this wave mints nothing and was to leave the attested template alone. Not this script's deploy." }
# The only migration since the live code is 0020, added (not edited): two columns, an index and one table.
$migMoves = @(git diff --name-status --no-renames $LIVE_BASE_COMMIT HEAD -- migrations)
if ($LASTEXITCODE -ne 0) { Stop-Here "git diff failed (exit $LASTEXITCODE): the migration check cannot be read." }
if ($migMoves.Count -ne 1 -or $migMoves[0] -cne ("A`t" + $MIGRATION_PATH_EXPECTED)) { Stop-Here ("expected exactly one added migration ($MIGRATION_PATH_EXPECTED) since " + $LIVE_BASE_COMMIT.Substring(0, 8) + ", found: " + ($migMoves -join " | ")) }
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
$migrationFiles = @(Get-ChildItem -Path $MIGRATION_GLOB -ErrorAction SilentlyContinue)
if ($migrationFiles.Count -ne 1) { Stop-Here "expected exactly one $MIGRATION_GLOB in this checkout, found $($migrationFiles.Count): wrong branch or directory." }
$migrationPath = "migrations/" + $migrationFiles[0].Name
if ($migrationPath -cne $MIGRATION_PATH_EXPECTED) { Stop-Here "the migration is '$migrationPath', expected '$MIGRATION_PATH_EXPECTED'." }
if (-not (Test-Path "src/resident.ts")) { Stop-Here "src/resident.ts is missing: this checkout is not the resident tier wave." }
if (-not (Select-String -Path "src/resident.ts" -Pattern "export async function bindResident" -Quiet)) { Stop-Here "src/resident.ts has no bindResident: this checkout is not the resident tier wave." }
if (-not (Select-String -Path "src/mcp.ts" -Pattern "async function callGuestTool" -Quiet)) { Stop-Here "src/mcp.ts has no callGuestTool: this checkout does not carry the MCP guest door wave this one builds on." }
if (-not (Select-String -Path "src/doors.ts" -Pattern "DOOR_DAILY_CAP" -Quiet)) { Stop-Here "src/doors.ts is missing or has no DOOR_DAILY_CAP: this checkout does not carry the door counters." }
if (-not (Select-String -Path "src/code-identity.ts" -Pattern "export function codeBlock" -Quiet)) { Stop-Here "src/code-identity.ts has no codeBlock: this checkout would drop served code identity." }
if (-not (Select-String -Path "src/guest.ts" -Pattern "export async function postGuestComment" -Quiet)) { Stop-Here "src/guest.ts has no postGuestComment: this checkout would drop the guest voice." }
if (-not (Select-String -Path "wrangler.jsonc" -Pattern '"version_metadata"' -Quiet)) { Stop-Here "wrangler.jsonc has no version_metadata binding: the Worker could not serve Cloudflare's version id." }
if (Select-String -Path "wrangler.jsonc" -Pattern '"CODE_COMMIT"' -Quiet) { Stop-Here "wrangler.jsonc configures a CODE_COMMIT var: a deploy that forgot the flag would serve a stale stamp. The stamp comes from this script's --var only." }
Say ("[git] HEAD " + $headSha.Substring(0, 8) + " = main = origin/main = -ExpectedCommit; tree clean; contains " + $LIVE_BASE_COMMIT.Substring(0, 8) + "; FRONT_DOOR_TEMPLATE unmoved; the one new migration is " + $migrationPath)

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

# 2. live, before: non-minting baseline, the live worker is the base this wave was checked against, the new route ABSENT (so the propagation poll proves something), the prerequisites present, and 0020's state
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
$routeBefore = Get-Text $NEW_CODE_URL 20
if ($routeBefore.Code -eq "200") { Stop-Here "GET $NEW_CODE_URL already answers 200: this wave looks already deployed. Verify by hand; this script cannot prove a propagation it did not wait for." }
if ($routeBefore.Code -ne "404") { Stop-Here "GET $NEW_CODE_URL answered $($routeBefore.Code) before the deploy, expected 404 (a route only this wave serves): investigate." }
Say "[live] before: GET /api/residents answers 404 (the new code is absent)"
$prereqRows = @(Invoke-D1Read "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('guest_thread', 'guests', 'visitors', 'showhome_rate', 'door_counts')")
if ($prereqRows.Count -ne 5) { Stop-Here ("the prerequisite tables are not all on prod (found " + $prereqRows.Count + " of guest_thread, guests, visitors, showhome_rate, door_counts): this wave rides on migrations 0018 and 0019 and the MCP guest door. Nothing was changed.") }
$colRows = @(Invoke-D1Read "SELECT name FROM pragma_table_info('guests') WHERE name IN ('public_key', 'resident_at')")
$nonceRows = @(Invoke-D1Read "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'resident_nonces'")
$colsPresent = $colRows.Count
$noncePresent = $nonceRows.Count
if ($colsPresent -eq 0 -and $noncePresent -eq 0) { $migrationState = "absent" }
elseif ($colsPresent -eq 2 -and $noncePresent -eq 1) { $migrationState = "applied" }
else { Stop-Here ("migration 0020 is half-applied on prod (" + $colsPresent + " of 2 new guests columns, resident_nonces present: " + $noncePresent + "): do not re-run the file; read the catalogue by hand.") }
if ($migrationState -ceq "applied" -and -not $MigrationAlreadyApplied) { Stop-Here "migration 0020 is already on prod. If an earlier run applied it, re-run with -MigrationAlreadyApplied (the catalogue is still verified)." }
if ($migrationState -ceq "absent" -and $MigrationAlreadyApplied) { Stop-Here "-MigrationAlreadyApplied was given but migration 0020 is not on prod." }
Say ("[d1] prerequisites present; migration 0020 on prod before: " + $migrationState)

if ($DryRun) {
  Say "[dry-run] would now: apply $migrationPath to the REMOTE D1 (skipped if -MigrationAlreadyApplied); catalogue-verify guests (eight columns in order, the partial unique index on public_key) and resident_nonces (three columns, the primary key, the expiry index, no foreign key on either table); run npx wrangler deploy --var CODE_COMMIT:<the full sha> and capture its Current Version ID (refusing to continue without one); poll up to $POLL_TRIES times, $POLL_DELAY_SECONDS s apart, until GET /api/attest serves that commit and version id and GET /api/residents answers 200; re-check attest (v5, template $($V5_HASH.Substring(0, 8)), every chain ok); ride the public reads and the two tools/list calls. NO LIVE WRITE is made at any point. Nothing was written to the remote and nothing was deployed."
  exit 0
}

# 3. migration 0020 to the REMOTE D1 FIRST (additive; applied only when the catalogue read above found it absent, because ALTER TABLE ADD COLUMN is not idempotent)
if (-not $MigrationAlreadyApplied) {
  Say "[d1] applying $migrationPath to the remote database"
  $ErrorActionPreference = "Continue"
  npx wrangler d1 execute commonhold --remote --file $migrationPath
  $migCode = $LASTEXITCODE
  $ErrorActionPreference = "Stop"
  if ($migCode -ne 0) { Stop-Here "migration 0020 failed (exit $migCode); nothing deployed; re-read the catalogue before any retry (do NOT re-run the file blind: a half-applied ALTER would fail the second time)." }
}

# 3b. catalogue verification (db-migration-verification): read the catalogue directly, never assume the apply worked
Assert-ResidentSchema
$countRows = @(Invoke-D1Read "SELECT COUNT(*) AS guests_now, SUM(CASE WHEN public_key IS NOT NULL THEN 1 ELSE 0 END) AS keyed_now FROM guests")
if ($countRows.Count -ne 1 -or "$($countRows[0].guests_now)" -notmatch "^[0-9]+$") { Stop-Here "the guests row count read returned no usable number." }
Say ("[d1] catalogue-verified: guests " + $GUESTS_COLUMN_NAMES.Count + " columns (" + ($GUESTS_COLUMN_NAMES -join ", ") + "), the partial unique index " + $KEY_INDEX_NAME + "; resident_nonces " + $NONCE_COLUMN_NAMES.Count + " columns, key (" + ($NONCE_KEY_NAMES -join ", ") + "), " + $EXPIRY_INDEX_NAME + "; no foreign key. Guests now: " + $countRows[0].guests_now + ", with a key: " + $countRows[0].keyed_now)

# 4. deploy the worker with the commit stamp, capturing its version id (a deploy whose id cannot be read is a stop: it cannot be tied to this commit), then poll until the served identity is this deploy's
# BEGIN-DEPLOY-AND-POLL
Say "[deploy] npx wrangler deploy --var CODE_COMMIT:$($headSha.Substring(0, 8))... (commit $($headSha.Substring(0, 8)))"
$ErrorActionPreference = "Continue"
$deployOut = (npx wrangler deploy --var "CODE_COMMIT:$headSha" 2>&1 | Out-String)
$deployCode = $LASTEXITCODE
$ErrorActionPreference = "Stop"
if ($deployCode -ne 0) { Stop-Here "wrangler deploy failed (exit $deployCode); migration 0020 is applied and harmless to the old worker. Re-run with -MigrationAlreadyApplied. Output: $deployOut" }
# The id is read from its OWN line, and exactly one such line must exist: with two, which one is this deploy's cannot be told.
$versionMatches = @([regex]::Matches($deployOut, '(?m)^[ \t]*Current Version ID:[ \t]*([0-9a-fA-F-]{36})[ \t]*\r?$'))
if ($versionMatches.Count -gt 1) { Stop-Here ("wrangler deploy printed 'Current Version ID' on " + $versionMatches.Count + " lines; which one is this deploy's cannot be told, and the deploy may have succeeded. Check 'npx wrangler deployments list' by hand before anything else.") }
if ($versionMatches.Count -lt 1) { Stop-Here "wrangler deploy exited 0 but printed no 'Current Version ID'; the deploy may have succeeded. Check 'npx wrangler deployments list' by hand before anything else." }
$versionId = $versionMatches[0].Groups[1].Value
Say "[deploy] worker version id $versionId (commit $($headSha.Substring(0, 8)))"
$ROLLBACK_LINE = "ROLL BACK THE WORKER (npx wrangler rollback, to the version before $versionId, which should be $rollbackTarget; check npx wrangler deployments list first). Migration 0020 can stay: it is additive and the old worker never names the new columns or the new table."
Wait-NewWorker $headSha $versionId $POLL_TRIES $POLL_DELAY_SECONDS
# END-DEPLOY-AND-POLL

# 5. the ride: non-minting and the chains, then the public reads and two read-only tools/list calls. NO LIVE WRITE: a bind needs a private key this script does not hold.
$attAfter = Read-Attest "after the deploy"
Assert-Attest $attAfter "after the deploy"
Say ("[ride] attest: v5 " + $V5_HASH.Substring(0, 8) + " unchanged; every chain ok")
$bad = @()
foreach ($p in "/", "/api/official", "/llms.txt", "/skill.md", "/heartbeat.md", "/openapi.json", "/treasury", "/api/listings", "/api/stats", "/api/topics", "/api/guest/due", "/api/citizens", "/api/doors", "/api/residents", "/api/showhome") {
  $r = Get-Text "$BASE$p" 30
  if ($r.Code -ne "200") { $bad += "$p=$($r.Code)" }
}
if ($bad.Count -gt 0) { Stop-Here ("non-200 after the deploy (version $versionId): " + ($bad -join ", ") + ". If a read that answered before now fails: $ROLLBACK_LINE") }
Say "[ride] 15 public reads -> 200 (this counted GET /skill.md and GET /heartbeat.md once each)"
$skill = Get-Text "$BASE/skill.md" 30
if (-not $skill.Body.Contains($SKILL_VERSION_LINE)) { Stop-Here "GET /skill.md does not carry '$SKILL_VERSION_LINE'. $ROLLBACK_LINE" }
if (-not $skill.Body.Contains("## Stay as a resident")) { Stop-Here "GET /skill.md has no 'Stay as a resident' section. $ROLLBACK_LINE" }
Say "[ride] /skill.md -> $SKILL_VERSION_LINE with the Stay as a resident section"
$roster = Get-Json "$BASE/api/residents"
if ($null -eq $roster.residents -or "$($roster.total)" -notmatch "^[0-9]+$" -or [string]::IsNullOrEmpty([string]$roster.note)) { Stop-Here "GET /api/residents has no residents array, no numeric total or no note. $ROLLBACK_LINE" }
$official = Get-Json "$BASE/api/official"
if ($null -eq $official.residents -or "$($official.residents.count)" -notmatch "^[0-9]+$") { Stop-Here "GET /api/official has no residents block with a numeric count. $ROLLBACK_LINE" }
if ("$($official.residents.count)" -cne "$($roster.total)") { Stop-Here "GET /api/official residents.count ($($official.residents.count)) is not GET /api/residents total ($($roster.total)): two surfaces disagree about one figure. $ROLLBACK_LINE" }
Say ("[ride] /api/residents and /api/official agree: " + $roster.total + " resident(s) so far")
$room = Get-Json "$BASE/api/showhome"
if ([string]$room.resident_tier.name -cne "resident") { Stop-Here "GET /api/showhome has no resident_tier rung. $ROLLBACK_LINE" }
$missing = Get-Text "$BASE/api/resident/99999999" 20
if ($missing.Code -ne "404" -or -not $missing.Body.Contains("No guest or resident has the number")) { Stop-Here ("GET /api/resident/99999999 answered " + $missing.Code + " without the route's own 404 text: the profile route is not live. " + $ROLLBACK_LINE) }
Say "[ride] /api/showhome carries the resident rung; GET /api/resident/:number answers with its own 404 for a number nobody holds"
$list = Post-Json "$BASE/mcp" '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
foreach ($tool in "resident_bind", "resident_token", "guest_enter", "guest_comment", "showhome_note") {
  # PowerShell's -and and -or have EQUAL precedence (left to right), so every mixed condition here is parenthesised.
  $listed = $list.Body.Contains('"name":"' + $tool + '"')
  if ($list.Code -ne "200" -or -not $listed) { Stop-Here "POST /mcp tools/list does not list $tool. $ROLLBACK_LINE" }
}
$readList = Post-Json "$BASE/mcp/read" '{"jsonrpc":"2.0","id":3,"method":"tools/list"}'
if ($readList.Code -ne "200") { Stop-Here "POST /mcp/read tools/list answered $($readList.Code), expected 200. $ROLLBACK_LINE" }
# The tool NAMES are what is checked: several read-tool descriptions say where a guest writes, so the bare words appear on /mcp/read by design.
foreach ($tool in "resident_bind", "resident_token", "guest_enter", "guest_comment", "showhome_note") {
  if ($readList.Body.Contains('"name":"' + $tool + '"')) { Stop-Here "POST /mcp/read tools/list lists the write tool ${tool}: the read door must stay read-only. $ROLLBACK_LINE" }
}
Say "[ride] POST /mcp tools/list lists resident_bind and resident_token with the guest tools; /mcp/read lists none of them"
Say "[note] No live write was made: the first resident bind, the first recovery and the resident byline on a real guest-thread row are first ridden by the first real resident. Until then they are proved by tests only."
Say "[done] Resident tier deployed and ridden (reads only). Log version id $versionId, commit $($headSha.Substring(0, 8)) and these lines in HANDOVER.md; then re-stage the registry kits from the live /skill.md 1.3.0 (Ben's acts)."
