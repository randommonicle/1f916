# Deploys the settlement replay guard (gate M2, docs/BRIEF-SETTLEMENT-REPLAY-GUARD.md, option B as amended; build log
# docs/CHECKPOINT-SETTLEMENT-REPLAY-GUARD.md): migration 0017 (the settlement_claims table) and THEN the worker, in ONE
# fail-fast script (L-046, L-069, gate L6/C2). Ben's hand only (D-017). WRITTEN BY THE BUILDER AND NEVER RUN. The D-018 Opus gate
# (money path) comes before it; so does the merge and the push. Run from society/ on main:
#   cd "C:\Users\bengr\Projects\AI domain and social network\society"
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-settlement-replay-guard.ps1 -ExpectedCommit <sha> -DryRun   # prints every step, writes nothing remote
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-settlement-replay-guard.ps1 -ExpectedCommit <sha>           # the real thing
#   ... -MigrationAlreadyApplied   only to re-run after a failed or interrupted wrangler deploy, when 0017 is already on prod
# Order is load-bearing: the worker reads and writes settlement_claims on every paid request, so migration 0017 goes to the REMOTE
# D1 first, is catalog-verified, and only then does the worker deploy. Every stop before "wrangler deploy" leaves the live worker
# exactly as it was (migration 0017 is additive and harmless to the old worker, which never reads the table); a stop after it says
# what to check by hand.
# What it does NOT do: any payment, the push, the gate. The claim path is first ridden by the next real paid request; the ride
# here is unpaid (public GETs and one unpaid POST, which writes nothing: a 402 is issued before any claim is taken).
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
$MIGRATION_GLOB = "migrations/0017_*.sql"
# A string only this wave serves: the lobby note's new heading (src/doc.ts lobbyDoorNote, D-073) on GET / and the register door's
# 402 description (B10). The propagation poll waits for THIS, and the pre-deploy probe proves it is ABSENT first, so the poll can
# only be satisfied by the new worker.
$NEW_CODE_MARKER = "pilot PAUSED"
$NEW_402_MARKER = "Register with a public_key if you can"
# Every column of settlement_claims in its table order, and the primary key (B1, migrations/0017_settlement_claims.sql). The test
# test/settlement-replay-deploy-script.test.ts compares this list with the migration and with schema.sql.
$CLAIM_COLUMN_NAMES = @("network", "asset", "from_addr", "nonce", "route", "intent_json", "intent_hash", "rpc_body", "rpc_body_hash", "valid_before", "state", "tx", "payer", "verdict_reason", "booked_refs", "created_at", "updated_at", "lease_owner", "leased_until")
$CLAIM_PK_NAMES = @("network", "asset", "from_addr", "nonce")
$B7_CHECK = "CHECK (state IN ('pending', 'settled_unbooked') OR rpc_body IS NULL)"

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
  $ErrorActionPreference = "Continue"
  $raw = (npx wrangler d1 execute commonhold --remote --json --command $sql 2>&1)
  $code = $LASTEXITCODE
  $ErrorActionPreference = "Stop"
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
# An UNPAID register POST: a 402 challenge (written nowhere: the claim is taken only after a payment verifies). The body goes via
# a temp file because 5.1 strips embedded double quotes from a native command's arguments.
function Invoke-UnpaidRegister($handle) {
  $bodyFile = [System.IO.Path]::GetTempFileName()
  $outFile = [System.IO.Path]::GetTempFileName()
  try {
    [System.IO.File]::WriteAllText($bodyFile, ('{"handle":"' + $handle + '","model":"ride-probe"}'), (New-Object System.Text.UTF8Encoding($false)))
    $code = (curl.exe -s --max-time 20 -X POST -H "Content-Type: application/json" --data-binary "@$bodyFile" -o $outFile -w "%{http_code}" "$BASE/api/register")
    $raw = (Get-Content $outFile -Raw -ErrorAction SilentlyContinue)
    if ($null -eq $raw) { $raw = "" }
    return @{ Code = "$code"; Raw = $raw }
  } finally {
    Remove-Item $bodyFile, $outFile -ErrorAction SilentlyContinue
  }
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
if (-not (Select-String -Path "src/settlement-claims.ts" -Pattern "export async function takeClaim" -Quiet)) { Stop-Here "src/settlement-claims.ts has no takeClaim: this checkout is not the settlement replay guard." }
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

# 2. live, before: non-minting baseline, the new code ABSENT (so the propagation poll proves something), and the table's state
$attBefore = Read-Attest "before the deploy"
Assert-Attest $attBefore "before the deploy"
Say ("[live] before: v5 " + $V5_HASH.Substring(0, 8) + "; all four chains ok; identity " + $attBefore.identity_log.sealed_entries + ", treasury " + $attBefore.treasury.sealed_entries + ", ballots " + $attBefore.ballots.sealed_entries)
$frontBefore = Get-Text "$BASE/" 30
if ($frontBefore.Code -ne "200") { Stop-Here "GET / -> $($frontBefore.Code) before the deploy, expected 200." }
if ($frontBefore.Body.Contains($NEW_CODE_MARKER)) { Stop-Here "the live front door already serves '$NEW_CODE_MARKER': this wave looks already deployed. Verify by hand; this script cannot prove a propagation it did not wait for." }
Say "[live] before: GET / does not yet serve '$NEW_CODE_MARKER'"
$tableRows = @(Invoke-D1Read "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'settlement_claims'")
$tablePresent = ($tableRows.Count -eq 1)
if ($tablePresent -and -not $MigrationAlreadyApplied) { Stop-Here "settlement_claims already exists on prod. If migration 0017 was applied by an earlier run, re-run with -MigrationAlreadyApplied (the catalogue is still verified)." }
if (-not $tablePresent -and $MigrationAlreadyApplied) { Stop-Here "-MigrationAlreadyApplied was given but settlement_claims does not exist on prod." }
Say ("[d1] settlement_claims present before: " + $tablePresent)

if ($DryRun) {
  Say "[dry-run] would now: apply $migrationPath to the REMOTE D1 (skipped if -MigrationAlreadyApplied); catalog-verify settlement_claims (every B1 column, the primary key, the rpc_body CHECK, the index, zero rows); run npx wrangler deploy and capture its version id; poll GET / until it serves '$NEW_CODE_MARKER'; re-check attest (v5, template $($V5_HASH.Substring(0, 8)), every chain ok); probe the unpaid register 402 for the public_key advice. Nothing remote was written."
  exit 0
}

# 3. migration 0017 to the REMOTE D1 FIRST (additive; CREATE ... IF NOT EXISTS, so a re-apply is a no-op)
if (-not $MigrationAlreadyApplied) {
  Say "[d1] applying $migrationPath to the remote database"
  $ErrorActionPreference = "Continue"
  npx wrangler d1 execute commonhold --remote --file $migrationPath
  $migCode = $LASTEXITCODE
  $ErrorActionPreference = "Stop"
  if ($migCode -ne 0) { Stop-Here "migration 0017 failed (exit $migCode); nothing deployed; re-read the catalogue before any retry." }
}

# 3b. catalog verification (db-migration-verification): read the catalogue directly, never assume the apply worked
$info = @(Invoke-D1Read "SELECT cid, name, type, pk FROM pragma_table_info('settlement_claims') ORDER BY cid")
$gotNames = @($info | ForEach-Object { $_.name })
if ($gotNames.Count -ne $CLAIM_COLUMN_NAMES.Count) { Stop-Here ("settlement_claims has " + $gotNames.Count + " columns, expected " + $CLAIM_COLUMN_NAMES.Count + ": " + ($gotNames -join ", ")) }
for ($k = 0; $k -lt $CLAIM_COLUMN_NAMES.Count; $k++) {
  if ($gotNames[$k] -ne $CLAIM_COLUMN_NAMES[$k]) { Stop-Here ("settlement_claims column " + $k + " is '" + $gotNames[$k] + "', expected '" + $CLAIM_COLUMN_NAMES[$k] + "'") }
}
$gotPk = @($info | Where-Object { [int]$_.pk -gt 0 } | Sort-Object { [int]$_.pk } | ForEach-Object { $_.name })
if (($gotPk -join ",") -ne ($CLAIM_PK_NAMES -join ",")) { Stop-Here ("settlement_claims primary key is (" + ($gotPk -join ", ") + "), expected (" + ($CLAIM_PK_NAMES -join ", ") + ")") }
$sqlRows = @(Invoke-D1Read "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'settlement_claims'")
if ($sqlRows.Count -ne 1 -or -not ([string]$sqlRows[0].sql).Contains($B7_CHECK)) { Stop-Here "settlement_claims does not carry the B7 CHECK ($B7_CHECK): a terminal row could hold an executable authorisation." }
$idxRows = @(Invoke-D1Read "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'settlement_claims' AND name = 'idx_settlement_claims_open'")
if ($idxRows.Count -ne 1) { Stop-Here "index idx_settlement_claims_open is missing." }
$countRows = @(Invoke-D1Read "SELECT COUNT(*) AS n FROM settlement_claims")
if ($countRows.Count -ne 1 -or "$($countRows[0].n)" -notmatch "^[0-9]+$") { Stop-Here "the settlement_claims count read returned no usable number." }
Say ("[d1] catalog-verified: " + $CLAIM_COLUMN_NAMES.Count + " columns in order, primary key (" + ($CLAIM_PK_NAMES -join ", ") + "), the B7 CHECK, the open-claims index; rows: " + $countRows[0].n)

# 4. deploy the worker, capturing its version id (a deploy whose id cannot be read is a stop: it cannot be tied to this commit)
Say "[deploy] npx wrangler deploy (commit $($headSha.Substring(0, 8)))"
$ErrorActionPreference = "Continue"
$deployOut = (npx wrangler deploy 2>&1 | Out-String)
$deployCode = $LASTEXITCODE
$ErrorActionPreference = "Stop"
if ($deployCode -ne 0) { Stop-Here "wrangler deploy failed (exit $deployCode); migration 0017 is applied and harmless to the old worker. Re-run with -MigrationAlreadyApplied. Output: $deployOut" }
$versionId = [regex]::Match($deployOut, 'Current Version ID:\s*([0-9a-fA-F-]{36})').Groups[1].Value
if (-not $versionId) { Stop-Here "wrangler deploy exited 0 but printed no 'Current Version ID'; the deploy may have succeeded. Check 'npx wrangler deployments list' by hand before anything else." }
Say "[deploy] worker version id $versionId (commit $($headSha.Substring(0, 8)))"

# 4b. propagation: wrangler returns once propagation STARTS. Wait for the new code (absent before, so this proves it), 12 x 5 s.
$live = $false
for ($i = 0; $i -lt 12; $i++) {
  $poll = Get-Text "$BASE/" 30
  if ($poll.Code -eq "200" -and $poll.Body.Contains($NEW_CODE_MARKER)) { $live = $true; break }
  Start-Sleep -Seconds 5
}
if (-not $live) { Stop-Here "deployed (version $versionId), but GET / has not served '$NEW_CODE_MARKER' after 60 s; check by hand." }
Say "[deploy] GET / serves '$NEW_CODE_MARKER' (version $versionId)"

# 5. the ride: non-minting and the chains, then the unpaid probes
$attAfter = Read-Attest "after the deploy"
Assert-Attest $attAfter "after the deploy"
Say ("[ride] attest: v5 " + $V5_HASH.Substring(0, 8) + " unchanged; every chain ok")
$bad = @()
foreach ($p in "/", "/api/official", "/llms.txt", "/skill.md", "/openapi.json", "/treasury", "/api/listings") {
  $r = Get-Text "$BASE$p" 30
  if ($r.Code -ne "200") { $bad += "$p=$($r.Code)" }
}
if ($bad.Count -gt 0) { Stop-Here ("non-200 after the deploy: " + ($bad -join ", ")) }
Say "[ride] /, /api/official, /llms.txt, /skill.md, /openapi.json, /treasury, /api/listings -> 200"
$probeHandle = "ride-probe-" + (Get-Date).ToUniversalTime().ToString("yyyyMMddHHmm")
$reg = Invoke-UnpaidRegister $probeHandle
if ($reg.Code -eq "429") { Stop-Here "the unpaid register probe was throttled (429): not a defect in this wave; re-run the probe by hand in an hour. The deploy is done (version $versionId)." }
if ($reg.Code -ne "402") { Stop-Here "POST /api/register (no payment) -> $($reg.Code), expected a 402 challenge." }
if (-not $reg.Raw.Contains($NEW_402_MARKER)) { Stop-Here "the register 402 does not carry the public_key advice ('$NEW_402_MARKER'): the new worker is not answering the register door." }
Say "[ride] POST /api/register (no payment) -> 402, carrying the public_key advice"
Say "[note] The claim path itself (a claim row per signed authorisation, the booking steps, the reconciler at 06:00 UTC) is proven by the tests and first ridden by the next real paid request: after it, SELECT state, route FROM settlement_claims shows one booked row, and GET /treasury shows the one ledger line. Do not declare the claim path ridden before then."
Say "[done] settlement replay guard deployed and ridden (unpaid). Log version id $versionId, commit $($headSha.Substring(0, 8)) and these lines in HANDOVER.md."
