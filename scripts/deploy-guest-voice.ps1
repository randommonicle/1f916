# Deploys the guest voice (docs/BRIEF-GUEST-VOICE.md, D-074 rulings 2 and 3; build log docs/CHECKPOINT-GUEST-VOICE.md): migration 0018 (three
# new tables: guest_thread, guest_duty_runs, guests) and THEN the worker, in ONE fail-fast script (L-046, L-069). Ben's hand only (D-017).
# WRITTEN BY THE BUILDER AND NEVER RUN. The D-018 Opus gate comes before it, and so do the merge and the push. This wave is stacked on the
# settlement replay guard (M2): that wave's migration 0017 must already be on prod, and this script stops if it is not. Run from society/ on main:
#   cd "C:\Users\bengr\Projects\AI domain and social network\society"
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-guest-voice.ps1 -ExpectedCommit <sha> -DryRun   # prints every step, writes nothing remote
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-guest-voice.ps1 -ExpectedCommit <sha>           # the real thing
#   ... -MigrationAlreadyApplied   only to re-run after a failed or interrupted wrangler deploy, when 0018 is already on prod
# Order is load-bearing: readPost queries guest_thread on EVERY post read, so a worker deployed before the tables exist answers 500 to every
# post read. Migration 0018 therefore goes to the REMOTE D1 first, is catalogue-verified (every column of all three tables, the indexes, the
# CHECKs, zero rows), and only then does the worker deploy. Every stop before "wrangler deploy" leaves the live worker exactly as it was
# (migration 0018 is additive and harmless to the old worker, which never reads the tables); a stop after it says what to check by hand.
# What it does NOT do: the push, the gate, any payment, any guest write. The write path (a guest comment, a citizen answer) is first ridden by
# the first real guest; the daily check is first ridden by the 06:00 UTC run after the deploy (until then GET /api/guest/due says
# check_stale: true, and that is honest). The ride here is public GETs only.
# PowerShell 5.1 traps this file avoids (all seen live): $COLS and $cols are the SAME variable (the lists below have names no local
# reuses); -notmatch on an array filters instead of testing (captures are joined to one string first); a one-element return is
# wrapped in @(); "$var:" is a drive reference (write "${var}:"); an Invoke-WebRequest 4xx body is in $_.ErrorDetails.Message;
# never merge a native command's stderr under ErrorActionPreference Stop. This file is ASCII only: 5.1 reads a BOM-less UTF-8
# script as the ANSI code page.
param(
  [Parameter(Mandatory = $true)][string]$ExpectedCommit,
  [switch]$DryRun,
  [switch]$MigrationAlreadyApplied
)
$ErrorActionPreference = "Stop"
$BASE = "https://commonhold.randommonicle.workers.dev"
$V5_HASH = "fa11788d062b0c6d23c54c428c1c9649d263ae3ba704e602e122066926049491"
$MIGRATION_GLOB = "migrations/0018_*.sql"
# The propagation poll waits for THIS route to answer 200 (it is a route only this wave serves), and the pre-deploy probe proves it answers
# 404 first, so the poll can only be satisfied by the new worker.
$NEW_CODE_URL = "$BASE/api/guest/due"
$SKILL_VERSION_LINE = "version: 1.1.3"
# Every column of the three tables in table order, from migrations/0018_guest_voice.sql. The test test/guest-deploy-script.test.ts compares
# these lists with the migration and with schema.sql.
$GUEST_THREAD_COLUMN_NAMES = @("id", "post_id", "parent_kind", "parent_id", "depth", "author_kind", "author_id", "handle", "model", "kind", "body", "mod_state", "duty", "due_at", "created_at", "idem_key")
$GUEST_RUN_COLUMN_NAMES = @("id", "run_at", "open_count", "overdue_count", "oldest_due_at", "overdue_ids")
$GUEST_COLUMN_NAMES = @("id", "visitor_id", "token_hash", "handle", "model", "created_at")
$GUEST_INDEX_NAMES = @("idx_guest_thread_post", "idx_guest_thread_author", "idx_guest_thread_kind_day", "idx_guest_thread_parent", "idx_guest_thread_due", "idx_guest_thread_idem")
$CHECK_PARENT = "CHECK ((parent_kind IS NULL) = (parent_id IS NULL))"
$CHECK_DUTY = "CHECK (duty = 0 OR (author_kind = 'guest' AND due_at IS NOT NULL))"

function Stop-Here($msg) { Write-Host "[STOP] $msg"; exit 1 }
function Say($msg) { Write-Host $msg }
function Read-D1Json($lines) {
  $txt = ($lines | Out-String)
  $i = $txt.IndexOf("[")
  if ($i -lt 0) { Stop-Here "wrangler d1 returned no JSON: $txt" }
  return ($txt.Substring($i) | ConvertFrom-Json)
}
# Strict read: a failed or empty query STOPS; nothing reasons from a bad read (an empty result must never read as "absent").
function Invoke-D1Read($sql) {
  # stdout only, no stderr redirect (the proven pattern of scripts/deploy-wallet-pin.ps1): merging stderr would wrap any wrangler
  # notice in an error record and hand it to ConvertFrom-Json. The exit code is read after.
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
function Read-Attest($when) {
  $att = Get-Json "$BASE/api/attest"
  if ($null -eq $att -or $null -eq $att.constitution -or -not $att.constitution.template_hash) { Stop-Here "GET /api/attest was unreadable $when; re-read it by hand (this is NOT a minting signal)." }
  return $att
}
function Assert-Attest($att, $when) {
  if ([string]$att.constitution.version -ne "5") { Stop-Here "constitution is version $($att.constitution.version) $when, expected 5: investigate before anything else." }
  if ($att.constitution.template_hash -ne $V5_HASH) { Stop-Here "template_hash is $($att.constitution.template_hash) $when, expected v5 ${V5_HASH}: investigate before anything else (this wave mints nothing)." }
  if ($att.ok -ne $true) { Stop-Here "GET /api/attest ok is '$($att.ok)' $when, expected true." }
  foreach ($chain in "identity_log", "treasury", "payouts", "ballots") {
    if ($att.$chain.ok -ne $true) { Stop-Here "chain $chain ok is '$($att.$chain.ok)' $when, expected true: investigate." }
  }
}
# One table's catalogue check: every column in order, and the primary key on id. A mismatch STOPS (the worker must not deploy against it).
function Assert-TableColumns($table, $expectedNames) {
  $info = @(Invoke-D1Read "SELECT cid, name, type, pk FROM pragma_table_info('$table') ORDER BY cid")
  $gotNames = @($info | ForEach-Object { $_.name })
  if ($gotNames.Count -ne $expectedNames.Count) { Stop-Here ("$table has " + $gotNames.Count + " columns, expected " + $expectedNames.Count + ": " + ($gotNames -join ", ")) }
  for ($k = 0; $k -lt $expectedNames.Count; $k++) {
    if ($gotNames[$k] -ne $expectedNames[$k]) { Stop-Here ("$table column " + $k + " is '" + $gotNames[$k] + "', expected '" + $expectedNames[$k] + "'") }
  }
  $gotPk = @($info | Where-Object { [int]$_.pk -gt 0 } | ForEach-Object { $_.name })
  if (($gotPk -join ",") -ne "id") { Stop-Here ("$table primary key is (" + ($gotPk -join ", ") + "), expected (id)") }
}

# 0. the commit: fetch, then main, origin/main and the expected sha must be ONE commit, on a clean tree
# A fetch changes only remote-tracking refs, never the remote, so -DryRun performs it too: the level check must read a fresh origin/main.
Say "[git] git fetch origin"
git fetch origin --quiet
if ($LASTEXITCODE -ne 0) { Stop-Here "git fetch failed; the level check below would read a stale origin/main." }
$branch = (git rev-parse --abbrev-ref HEAD).Trim()
if ($branch -ne "main") { Stop-Here "the current branch is '$branch', not main: deploy from main only." }
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
if ($mainSha -ne $originSha -or $mainSha -ne $expectedSha -or $headSha -ne $expectedSha) {
  Stop-Here ("main, origin/main and -ExpectedCommit are not one commit: HEAD " + $headSha.Substring(0, 8) + ", main " + $mainSha.Substring(0, 8) + ", origin/main " + $originSha.Substring(0, 8) + ", expected " + $expectedSha.Substring(0, 8) + ". Merge, push, and pass the pushed sha.")
}
$dirty = @(git status --porcelain)
if ($dirty.Count -gt 0) { Stop-Here ("working tree not clean (" + $dirty.Count + " paths): the deploy must ship exactly the committed tree.") }
$migrationFiles = @(Get-ChildItem -Path $MIGRATION_GLOB -ErrorAction SilentlyContinue)
if ($migrationFiles.Count -ne 1) { Stop-Here "expected exactly one $MIGRATION_GLOB in this checkout, found $($migrationFiles.Count): wrong branch or directory." }
$migrationPath = "migrations/" + $migrationFiles[0].Name
if (-not (Select-String -Path "src/guest.ts" -Pattern "export async function postGuestComment" -Quiet)) { Stop-Here "src/guest.ts has no postGuestComment: this checkout is not the guest voice." }
Say ("[git] HEAD " + $headSha.Substring(0, 8) + " = main = origin/main = -ExpectedCommit; tree clean; migration " + $migrationPath)

# 1. the wave's own gates, re-run here so a stale checkout cannot deploy
$ErrorActionPreference = "Continue"
$testOut = (npm test 2>&1 | Out-String)
$testCode = $LASTEXITCODE
$tscOut = (npm run typecheck 2>&1 | Out-String)
$tscCode = $LASTEXITCODE
$ErrorActionPreference = "Stop"
$pass = [regex]::Match($testOut, 'pass (\d+)').Groups[1].Value
$fail = [regex]::Match($testOut, 'fail (\d+)').Groups[1].Value
if ($testCode -ne 0 -or $fail -ne "0") { Stop-Here "npm test: exit $testCode, pass $pass, fail $fail." }
if ($tscCode -ne 0) { Stop-Here "typecheck failed: $tscOut" }
Say "[tests] pass $pass, fail 0; typecheck clean"

# 2. live, before: non-minting baseline, the new route ABSENT (so the propagation poll proves something), and the tables' state
$attBefore = Read-Attest "before the deploy"
Assert-Attest $attBefore "before the deploy"
Say ("[live] before: v5 " + $V5_HASH.Substring(0, 8) + "; all four chains ok; identity " + $attBefore.identity_log.sealed_entries + ", treasury " + $attBefore.treasury.sealed_entries + ", ballots " + $attBefore.ballots.sealed_entries)
$routeBefore = Get-Text $NEW_CODE_URL 20
if ($routeBefore.Code -eq "200") { Stop-Here "GET $NEW_CODE_URL already answers 200: this wave looks already deployed. Verify by hand; this script cannot prove a propagation it did not wait for." }
if ($routeBefore.Code -ne "404") { Stop-Here "GET $NEW_CODE_URL answered $($routeBefore.Code) before the deploy, expected 404 (a route only this wave serves): investigate." }
Say "[live] before: GET /api/guest/due answers 404 (the new code is absent)"
# The settlement replay guard (M2) is the wave this one is stacked on: its migration 0017 must already be on prod.
$claimRows = @(Invoke-D1Read "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'settlement_claims'")
if ($claimRows.Count -ne 1) { Stop-Here "settlement_claims is not on prod: this branch contains the settlement replay guard, whose migration 0017 must be applied first (scripts/deploy-settlement-replay-guard.ps1). Nothing was changed." }
$tableRows = @(Invoke-D1Read "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('guest_thread', 'guest_duty_runs', 'guests')")
$tablesPresent = $tableRows.Count
if ($tablesPresent -eq 3 -and -not $MigrationAlreadyApplied) { Stop-Here "all three guest tables already exist on prod. If migration 0018 was applied by an earlier run, re-run with -MigrationAlreadyApplied (the catalogue is still verified)." }
if ($tablesPresent -gt 0 -and $tablesPresent -lt 3) { Stop-Here "only $tablesPresent of the three guest tables exist on prod: a partial state this script will not guess about. Read the catalogue by hand." }
if ($tablesPresent -eq 0 -and $MigrationAlreadyApplied) { Stop-Here "-MigrationAlreadyApplied was given but none of the guest tables exist on prod." }
Say ("[d1] guest tables present before: " + $tablesPresent + " of 3; settlement_claims present (M2 is on prod)")

if ($DryRun) {
  Say "[dry-run] would now: apply $migrationPath to the REMOTE D1 (skipped if -MigrationAlreadyApplied); catalogue-verify all three tables (every column in order, the primary key, the six guest_thread indexes, the two CHECKs, zero rows); run npx wrangler deploy and capture its version id; poll GET /api/guest/due until it answers 200; re-check attest (v5, template $($V5_HASH.Substring(0, 8)), every chain ok); ride the public reads (a post read carries guest_thread, /api/official.guest_voice, /skill.md 1.1.3, /api/stats guest fields). Nothing remote was written."
  exit 0
}

# 3. migration 0018 to the REMOTE D1 FIRST (additive; CREATE ... IF NOT EXISTS, so a re-apply is a no-op)
if (-not $MigrationAlreadyApplied) {
  Say "[d1] applying $migrationPath to the remote database"
  $ErrorActionPreference = "Continue"
  npx wrangler d1 execute commonhold --remote --file $migrationPath
  $migCode = $LASTEXITCODE
  $ErrorActionPreference = "Stop"
  if ($migCode -ne 0) { Stop-Here "migration 0018 failed (exit $migCode); nothing deployed; re-read the catalogue before any retry." }
}

# 3b. catalogue verification (db-migration-verification): read the catalogue directly, never assume the apply worked
Assert-TableColumns "guest_thread" $GUEST_THREAD_COLUMN_NAMES
Assert-TableColumns "guest_duty_runs" $GUEST_RUN_COLUMN_NAMES
Assert-TableColumns "guests" $GUEST_COLUMN_NAMES
$idxRows = @(Invoke-D1Read "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'guest_thread' AND name LIKE 'idx_guest_thread_%'")
$gotIdx = @($idxRows | ForEach-Object { $_.name })
foreach ($want in $GUEST_INDEX_NAMES) {
  if ($gotIdx -notcontains $want) { Stop-Here "index $want is missing from guest_thread (found: $($gotIdx -join ', '))." }
}
$sqlRows = @(Invoke-D1Read "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'guest_thread'")
if ($sqlRows.Count -ne 1) { Stop-Here "the guest_thread definition could not be read." }
$threadSql = [string]$sqlRows[0].sql
if (-not $threadSql.Contains($CHECK_PARENT)) { Stop-Here "guest_thread does not carry the parent CHECK ($CHECK_PARENT)." }
if (-not $threadSql.Contains($CHECK_DUTY)) { Stop-Here "guest_thread does not carry the duty CHECK ($CHECK_DUTY): a citizen row could carry a duty." }
$autoRows = @(Invoke-D1Read "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'guests' AND sql IS NULL")
if ($autoRows.Count -ne 2) { Stop-Here ("guests carries " + $autoRows.Count + " automatic unique indexes, expected 2 (visitor_id and token_hash).") }
$countRows = @(Invoke-D1Read "SELECT (SELECT COUNT(*) FROM guest_thread) AS thread_rows, (SELECT COUNT(*) FROM guest_duty_runs) AS run_rows, (SELECT COUNT(*) FROM guests) AS guest_rows")
if ($countRows.Count -ne 1 -or "$($countRows[0].thread_rows)" -notmatch "^[0-9]+$") { Stop-Here "the guest table count read returned no usable number." }
# Zero rows, as promised above (gate L-5): the old worker never writes these tables, so a row here means something else did.
if ([int64]$countRows[0].thread_rows -ne 0 -or [int64]$countRows[0].run_rows -ne 0 -or [int64]$countRows[0].guest_rows -ne 0) { Stop-Here ("the guest tables are not empty before the worker deploy (thread " + $countRows[0].thread_rows + ", runs " + $countRows[0].run_rows + ", guests " + $countRows[0].guest_rows + "); find what wrote them before deploying.") }
Say ("[d1] catalogue-verified: guest_thread " + $GUEST_THREAD_COLUMN_NAMES.Count + " columns, guest_duty_runs " + $GUEST_RUN_COLUMN_NAMES.Count + ", guests " + $GUEST_COLUMN_NAMES.Count + ", primary key id on each, the " + $GUEST_INDEX_NAMES.Count + " guest_thread indexes, both CHECKs, the two guests unique indexes; rows: thread " + $countRows[0].thread_rows + ", runs " + $countRows[0].run_rows + ", guests " + $countRows[0].guest_rows)

# 4. deploy the worker, capturing its version id (a deploy whose id cannot be read is a stop: it cannot be tied to this commit)
Say "[deploy] npx wrangler deploy (commit $($headSha.Substring(0, 8)))"
$ErrorActionPreference = "Continue"
$deployOut = (npx wrangler deploy 2>&1 | Out-String)
$deployCode = $LASTEXITCODE
$ErrorActionPreference = "Stop"
if ($deployCode -ne 0) { Stop-Here "wrangler deploy failed (exit $deployCode); migration 0018 is applied and harmless to the old worker. Re-run with -MigrationAlreadyApplied. Output: $deployOut" }
$versionId = [regex]::Match($deployOut, 'Current Version ID:\s*([0-9a-fA-F-]{36})').Groups[1].Value
if (-not $versionId) { Stop-Here "wrangler deploy exited 0 but printed no 'Current Version ID'; the deploy may have succeeded. Check 'npx wrangler deployments list' by hand before anything else." }
Say "[deploy] worker version id $versionId (commit $($headSha.Substring(0, 8)))"

# 4b. propagation: wrangler returns once propagation STARTS. Wait for the new route (404 before, so this proves it), 12 x 5 s.
$live = $false
for ($i = 0; $i -lt 12; $i++) {
  $poll = Get-Text $NEW_CODE_URL 30
  if ($poll.Code -eq "200") { $live = $true; break }
  Start-Sleep -Seconds 5
}
if (-not $live) { Stop-Here "deployed (version $versionId), but GET /api/guest/due has not answered 200 after 60 s; check by hand." }
Say "[deploy] GET /api/guest/due answers 200 (version $versionId)"

# 5. the ride: non-minting and the chains, then the public reads, then ONE free write (gate C1, step 5b)
$attAfter = Read-Attest "after the deploy"
Assert-Attest $attAfter "after the deploy"
Say ("[ride] attest: v5 " + $V5_HASH.Substring(0, 8) + " unchanged; every chain ok")
$bad = @()
foreach ($p in "/", "/api/official", "/llms.txt", "/skill.md", "/heartbeat.md", "/openapi.json", "/treasury", "/api/listings", "/api/stats", "/api/topics") {
  $r = Get-Text "$BASE$p" 30
  if ($r.Code -ne "200") { $bad += "$p=$($r.Code)" }
}
if ($bad.Count -gt 0) { Stop-Here ("non-200 after the deploy: " + ($bad -join ", ")) }
Say "[ride] /, /api/official, /llms.txt, /skill.md, /heartbeat.md, /openapi.json, /treasury, /api/listings, /api/stats, /api/topics -> 200"
$due = Get-Json "$BASE/api/guest/due"
if ($due.promise -ne "aim") { Stop-Here "GET /api/guest/due promise is '$($due.promise)', expected 'aim'." }
if (@($due.items).Count -ne 0) { Stop-Here ("GET /api/guest/due is not empty (" + @($due.items).Count + " items) straight after the deploy: a real guest may have arrived in the interval, or something wrote; read it by hand. The deploy is done (version $versionId).") }
Say ("[ride] GET /api/guest/due -> 200, empty, promise aim, target_hours " + $due.target_hours + ", check_stale " + $due.check_stale + " (true until the first 06:00 UTC run writes its row)")
$official = Get-Json "$BASE/api/official"
if ($null -eq $official.guest_voice -or $official.guest_voice.promise -ne "aim") { Stop-Here "GET /api/official has no guest_voice block with promise 'aim'." }
if (@($official.guest_voice.template_exceptions.PSObject.Properties).Count -ne 4) { Stop-Here "GET /api/official guest_voice.template_exceptions does not carry its four corrections." }
Say ("[ride] /api/official guest_voice: promise aim, target " + $official.guest_voice.target_hours + " h, accrued " + $official.guest_voice.accrued + ", four template corrections served outside the attested text")
$skill = Get-Text "$BASE/skill.md" 30
if (-not $skill.Body.Contains($SKILL_VERSION_LINE)) { Stop-Here "GET /skill.md does not carry '$SKILL_VERSION_LINE'." }
Say "[ride] /skill.md -> $SKILL_VERSION_LINE"
$front = Get-Json "$BASE/api/front"
$firstId = $null
if (@($front.posts).Count -gt 0) { $firstId = $front.posts[0].id } elseif (@($front.topics).Count -gt 0) { $firstId = $front.topics[0].id }
if ($null -eq $firstId) { Stop-Here "GET /api/front listed no post or topic to read; read one by hand: its answer must carry a guest_thread array." }
$post = Get-Json "$BASE/api/post/$firstId"
if ($null -eq $post.guest_thread) { Stop-Here "GET /api/post/$firstId carries no guest_thread: the worker is not reading the new table." }
Say ("[ride] GET /api/post/" + $firstId + " -> 200 and carries guest_thread (the worker reads the new table), guest_thread_next " + $post.guest_thread_next)
# 5b. gate condition C1: ONE real free write, before anything else uses the worker. POST /api/showhome/enter is the first
# real-D1 run of the conditional rate reservation (src/showhome.ts assertShowhomeRateCap) that every free write passes
# through; a 500 here means every showhome write is down. It mints one visitor token (handle "deploy-ride"), which is
# never printed or kept. Expect 201.
$enterBody = [System.IO.Path]::GetTempFileName()
$enterOut = [System.IO.Path]::GetTempFileName()
try {
  [System.IO.File]::WriteAllText($enterBody, '{"handle":"deploy-ride","model":"deploy-script"}', (New-Object System.Text.UTF8Encoding($false)))
  $enterCode = (curl.exe -s --max-time 30 -o $enterOut -w "%{http_code}" -X POST "$BASE/api/showhome/enter" -H "content-type: application/json" --data-binary "@$enterBody")
} finally {
  Remove-Item $enterBody, $enterOut -ErrorAction SilentlyContinue
}
if ("$enterCode" -ne "201") { Stop-Here ("C1 FAILED: POST /api/showhome/enter answered HTTP $enterCode, not 201. Every free write passes the same rate reservation: ROLL BACK THE WORKER now (npx wrangler rollback), then read the worker log. Migration 0018 can stay (additive; the old worker never reads it).") }
Say "[ride] C1: POST /api/showhome/enter -> 201 (the conditional rate reservation runs on real D1; the minted token was discarded unread)"
$stats = Get-Json "$BASE/api/stats"
if ($null -eq $stats.guest_comments) { Stop-Here "GET /api/stats has no guest_comments field." }
Say ("[ride] /api/stats guest_comments " + $stats.guest_comments + " (separate from comments " + $stats.comments + ")")
Say "[note] The write paths (POST /api/guest/comment, POST /api/guest/answer) and the 06:00 UTC daily check are first ridden by the first real guest and the next 06:00 run. Gate condition C2: after the FIRST real guest comment, guest_thread AND guests must each have risen by one (SELECT (SELECT COUNT(*) FROM guest_thread WHERE author_kind = 'guest'), (SELECT COUNT(*) FROM guests)); if guests did not rise, the promotion failed on real D1 (only token continuity is lost); after the next 06:00 UTC: SELECT * FROM guest_duty_runs shows the dated record. Do not declare either ridden before then."
Say "[done] guest voice deployed and ridden (public reads and the C1 enter). Log version id $versionId, commit $($headSha.Substring(0, 8)) and these lines in HANDOVER.md; then update the operator's session-start ritual with GET /api/guest/due, and re-stage the registry kits from the live /skill.md 1.1.3 (Ben's acts)."
