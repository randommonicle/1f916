# Deploys the heartbeat and the inbox (D-072 direction 1, docs/BRIEF-HEARTBEAT-INBOX.md):
# worker only, NO migration (every column this wave reads already exists), non-minting.
# One fail-fast script (L-046). Every stop before "wrangler deploy" leaves the live worker
# exactly as it was; a stop after it says what to check by hand. Written but NOT run by the
# builder (the commission's own hard rule) -- this is Ben's hand only (D-017), after the
# code exchange and the D-018 gate, from society/ on main, after the merge and the push:
#   cd "C:\Users\bengr\Projects\AI domain and social network\society"
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-heartbeat-inbox.ps1 -DryRun
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-heartbeat-inbox.ps1
# PowerShell 5.1: never merge a native command's stderr under ErrorActionPreference Stop;
# read exit codes and stdout. -notmatch on a STRING is fine; -notmatch on an ARRAY FILTERS
# (L-080 family) -- every multi-line curl.exe capture below goes through Out-String first.
param([switch]$DryRun)
$ErrorActionPreference = "Stop"
$BASE = "https://commonhold.randommonicle.workers.dev"
$V5_HASH = "fa11788d062b0c6d23c54c428c1c9649d263ae3ba704e602e122066926049491"

function Stop-Here($msg) { Write-Host "[STOP] $msg"; exit 1 }
# D1 (CODEX F2, exchange/REVIEW_heartbeat-steps-bcd-build-2026-09-27.md): the old Get-Json
# discarded curl's HTTP status entirely, so a non-200 answer carrying JSON with the expected
# fields (an intermediary's error page, say) would pass every check that only reads named
# keys off the parsed body. The body goes to a temp file and is read back ONLY on a 200 --
# never printed wholesale either way.
function Get-Json($url) {
  $tmp = [System.IO.Path]::GetTempFileName()
  $code = (curl.exe -s -o $tmp -w "%{http_code}" $url)
  if ($code -ne "200") { Stop-Here "GET $url -> $code, expected 200 (body not printed; left at $tmp for inspection)." }
  $json = (Get-Content $tmp -Raw | ConvertFrom-Json)
  Remove-Item $tmp -ErrorAction SilentlyContinue
  return $json
}
# One string with whitespace collapsed, never an array of lines (L-076/L-080: -match on an
# array filters instead of testing the whole body).
function Get-Flat($url) { ((curl.exe -s $url | Out-String) -replace '\s+', ' ') }
# D1 (CODEX F2): every post-deploy Invoke-WebRequest goes through this one helper.
# $ErrorActionPreference = "Stop" makes a non-2xx THROW before a caller's own
# "if ($resp.StatusCode -ne 200)" check can ever run (CODEX proved that pattern dead code at
# the old lines 78/91-92) -- so the real status check has to live on both paths out of this
# function, the normal return AND the catch. The error body is read from
# $_.ErrorDetails.Message first: PowerShell 5.1 has already consumed the response stream by
# the time a catch runs, the same trap deploy-wallet-pin.ps1 (commit 108a813a) hit and fixed.
# Only the body's LENGTH is ever named in the Stop-Here message -- never printed wholesale.
function Invoke-RideGet($url) {
  try {
    $resp = Invoke-WebRequest -UseBasicParsing -Uri $url
    if ($resp.StatusCode -ne 200) { Stop-Here "GET $url -> $($resp.StatusCode), expected 200." }
    return $resp
  } catch {
    $status = "no HTTP response"
    if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
    $errBody = $null
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $errBody = $_.ErrorDetails.Message }
    $note = if ($errBody) { "error body captured, $($errBody.Length) chars, not printed" } else { "no error body captured" }
    Stop-Here "GET $url -> $status, expected 200 ($note)."
  }
}
function Get-Sha256Hex($text) {
  $bytes = [System.Text.Encoding]::UTF8.GetBytes($text)
  $hash = [System.Security.Cryptography.SHA256]::Create().ComputeHash($bytes)
  return ([System.BitConverter]::ToString($hash) -replace '-', '').ToLower()
}

# 0. where we are
$head = (git rev-parse --short=8 HEAD).Trim()
$level = (git status -sb | Select-Object -First 1)
$dirty = @(git status --porcelain)
Write-Host "[git] HEAD $head  $level"
if ($dirty.Count -gt 0) {
  if ($DryRun) { Write-Host ("[dry-run] working tree NOT clean (" + $dirty.Count + " paths): the real run would STOP here.") }
  else { Stop-Here ("working tree not clean (" + $dirty.Count + " paths): the deploy must ship exactly the committed tree.") }
}
if ($level -notmatch '^## main\.\.\.origin/main$') {
  if ($DryRun) { Write-Host "[dry-run] NOT main level with origin: the real run would STOP here (merge to main and push first)." }
  else { Stop-Here "merge to main and push first: the deploy must ship the same commit the public fork carries (R-4 / D-006)." }
}
if (-not (Test-Path "src/inbox.ts")) { Stop-Here "src/inbox.ts is not in this checkout: wrong branch or directory" }

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
Write-Host "[tests] pass $pass, fail 0; typecheck clean"

# 2. live, before: attest (non-minting expected) and proof the new route does not exist yet
$attBefore = Get-Json "$BASE/api/attest"
if ($attBefore.constitution.template_hash -ne $V5_HASH) { Stop-Here "live constitution is $($attBefore.constitution.template_hash), expected v5 $V5_HASH." }
foreach ($ch in "identity_log", "treasury", "payouts", "ballots") {
  if ($attBefore.$ch.status -ne "verified") { Stop-Here "chain $ch is $($attBefore.$ch.status) before the deploy." }
}
Write-Host ("[live] before: v5 " + $V5_HASH.Substring(0, 8) + "; chains verified; identity head " + $attBefore.identity_log.head.Substring(0, 12) + " at " + $attBefore.identity_log.total_rows + " rows")
$inboxBeforeCode = (curl.exe -s -o NUL -w "%{http_code}" "$BASE/api/inbox?handle=commonhold-agent&since=0")
if ($inboxBeforeCode -ne "404") { Stop-Here "GET /api/inbox already answers $inboxBeforeCode before this deploy (expected 404) -- investigate before shipping anything." }
Write-Host "[live] before: GET /api/inbox -> 404, as expected pre-deploy"

if ($DryRun) { Write-Host "[dry-run] would run: npx wrangler deploy, then the post-deploy ride in step 4. Nothing deployed."; exit 0 }

# 3. deploy
Write-Host "[deploy] npx wrangler deploy"
npx wrangler deploy
if ($LASTEXITCODE -ne 0) { Stop-Here "wrangler deploy failed; the old worker is still live." }

# 4. the ride, exactly the brief's own Deploy section
# 4a. GET /api/inbox?handle=commonhold-agent&since=0 -> 200, every section present
$inboxResp = Invoke-RideGet "$BASE/api/inbox?handle=commonhold-agent&since=0"
$inboxBody = $inboxResp.Content | ConvertFrom-Json
foreach ($key in "handle", "replies", "comments_on_your_posts", "mentions", "topics_opened", "ballots", "ballots_owed", "next_cursor", "has_more", "note", "cursor_note") {
  if (-not ($inboxBody.PSObject.Properties.Name -contains $key)) { Stop-Here "GET /api/inbox response is missing the '$key' section." }
}
Write-Host ("[ride] GET /api/inbox?handle=commonhold-agent&since=0 -> 200, every section present; next_cursor " + $inboxBody.next_cursor)
# 4b. an unknown handle -> 404
$unknownCode = (curl.exe -s -o NUL -w "%{http_code}" "$BASE/api/inbox?handle=no-such-citizen-at-all&since=0")
if ($unknownCode -ne "404") { Stop-Here "GET /api/inbox for an unknown handle -> $unknownCode, expected 404." }
Write-Host "[ride] GET /api/inbox for an unknown handle -> 404"
# 4c. /heartbeat.md and /skill.md -> 200 text/markdown
$hbResp = Invoke-RideGet "$BASE/heartbeat.md"
$skResp = Invoke-RideGet "$BASE/skill.md"
if ($hbResp.Headers["Content-Type"] -notmatch "text/markdown") { Stop-Here "GET /heartbeat.md -> 200 but Content-Type $($hbResp.Headers['Content-Type']), expected text/markdown." }
if ($skResp.Headers["Content-Type"] -notmatch "text/markdown") { Stop-Here "GET /skill.md -> 200 but Content-Type $($skResp.Headers['Content-Type']), expected text/markdown." }
Write-Host "[ride] /heartbeat.md and /skill.md -> 200 text/markdown"
# 4d. /api/surface's two sha256 values equal the served bodies' own sha256
$surface = Get-Json "$BASE/api/surface"
$hbSha = Get-Sha256Hex $hbResp.Content
$skSha = Get-Sha256Hex $skResp.Content
if ($surface.heartbeat.sha256 -ne $hbSha) { Stop-Here "/api/surface heartbeat.sha256 ($($surface.heartbeat.sha256)) does not match the served /heartbeat.md body's own sha256 ($hbSha)." }
if ($surface.skill.sha256 -ne $skSha) { Stop-Here "/api/surface skill.sha256 ($($surface.skill.sha256)) does not match the served /skill.md body's own sha256 ($skSha)." }
Write-Host ("[ride] /api/surface sha256 values match the served bodies: heartbeat " + $hbSha.Substring(0, 8) + ", skill " + $skSha.Substring(0, 8) + " (version " + $surface.skill.version + ")")
# 4e. attest still v5, all chains verified (non-minting)
$attAfter = Get-Json "$BASE/api/attest"
if ($null -eq $attAfter -or $null -eq $attAfter.constitution -or -not $attAfter.constitution.template_hash) { Stop-Here "GET /api/attest was unreadable after the deploy; re-read it by hand before anything else (this is NOT a minting signal)." }
if ($attAfter.constitution.template_hash -ne $V5_HASH) { Stop-Here "template_hash CHANGED to $($attAfter.constitution.template_hash): this wave was expected to be non-minting; investigate before anything else." }
foreach ($ch in "identity_log", "treasury", "payouts", "ballots") {
  if ($attAfter.$ch.status -ne "verified") { Stop-Here "chain $ch is $($attAfter.$ch.status) after the deploy: investigate." }
}
Write-Host ("[ride] attest: v5 " + $V5_HASH.Substring(0, 8) + " unchanged; all four chains verified")
# 4f. the door note, and a general sweep of untouched surfaces
$door = Get-Flat "$BASE/"
if ($door -notmatch "Heartbeat: GET") { Stop-Here "the heartbeat door note is not on GET /." }
$bad = @()
foreach ($p in "/", "/api/official", "/llms.txt", "/openapi.json", "/api/topics", "/api/front", "/treasury", "/api/showhome") {
  $code = (curl.exe -s -o NUL -w "%{http_code}" "$BASE$p")
  if ($code -ne "200") { $bad += "$p=$code" }
}
if ($bad.Count -gt 0) { Stop-Here ("non-200 after deploy: " + ($bad -join ", ")) }
Write-Host "[done] heartbeat and inbox deployed and ridden. Log the worker version id and these lines in HANDOVER.md. HEAD $head"
