# Deploys wave A of MCP listing readiness (docs/BRIEF-MCP-LISTING-READY.md, A1-A5):
# worker only, NO migration (nothing here touches D1 schema), non-minting
# (FRONT_DOOR_TEMPLATE is byte-for-byte unchanged -- A5(d)). One fail-fast script
# (L-046), modelled on scripts/deploy-heartbeat-inbox.ps1 (same helper shapes, same
# git/test gates, same propagation-poll-before-riding pattern). Every stop before
# "wrangler deploy" leaves the live worker exactly as it was; a stop after it says
# what to check by hand. Written but NOT run by the builder (the commission's own
# hard rule) -- this is Ben's hand only (D-017), after the code exchange and the
# D-018 gate, from society/ on main, after the merge and the push:
#   cd "C:\Users\bengr\Projects\AI domain and social network\society"
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-mcp-listing-ready.ps1 -DryRun
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-mcp-listing-ready.ps1
# PowerShell 5.1: never merge a native command's stderr under ErrorActionPreference
# Stop; read exit codes and stdout. -notmatch on a STRING is fine; -notmatch on an
# ARRAY FILTERS (L-080 family) -- every multi-line curl.exe capture goes through
# Out-String first. "$var:" is a drive reference (write ${var}:); no such pattern
# appears in this script, checked by eye. Variable names are case-insensitive ($H
# and $h are the same variable) -- every name below is spelled out in full and kept
# distinct case-insensitively (no bare $sk alongside a $SK, etc.).
param([switch]$DryRun)
$ErrorActionPreference = "Stop"
$BASE = "https://commonhold.randommonicle.workers.dev"
$V5_HASH = "fa11788d062b0c6d23c54c428c1c9649d263ae3ba704e602e122066926049491"

function Stop-Here($msg) { Write-Host "[STOP] $msg"; exit 1 }
# The worker's own error bodies are {"error": "..."} and carry no secret, so a
# parsed string `error` field is safe to surface, truncated to 200 characters.
# Anything else -- a non-JSON body, a differently shaped JSON body, an `error`
# field that is not a string, or no body at all -- still names only a LENGTH,
# never raw content: this is the one shared place that decision is made, for every
# helper below (mirrors deploy-heartbeat-inbox.ps1's own Format-ErrBody exactly).
function Format-ErrBody($bodyText) {
  if (-not $bodyText) { return "no error body captured" }
  try {
    $j = $bodyText | ConvertFrom-Json
    if ($j -and ($j.PSObject.Properties.Name -contains "error") -and ($j.error -is [string])) {
      $msg = $j.error
      if ($msg.Length -gt 200) { $msg = $msg.Substring(0, 200) + "..." }
      return "error: `"$msg`""
    }
  } catch {}
  return "error body captured, $($bodyText.Length) chars, not printed"
}
# The body goes to a temp file and is read back on a 200; on anything else it is
# read once more, through Format-ErrBody, then discarded. The temp file is removed
# in a `finally`, so a 200 whose body is not valid JSON (ConvertFrom-Json throws,
# ErrorActionPreference = "Stop") still cleans it up.
function Get-Json($url) {
  $tmp = [System.IO.Path]::GetTempFileName()
  try {
    $code = (curl.exe -s --max-time 20 -o $tmp -w "%{http_code}" $url)
    if ($code -ne "200") {
      $bodyText = (Get-Content $tmp -Raw -ErrorAction SilentlyContinue)
      Stop-Here "GET $url -> $code, expected 200 ($(Format-ErrBody $bodyText))."
    }
    return (Get-Content $tmp -Raw | ConvertFrom-Json)
  } finally {
    Remove-Item $tmp -ErrorAction SilentlyContinue
  }
}
# One string with whitespace collapsed, never an array of lines (L-076/L-080:
# -match on an array filters instead of testing the whole body) -- this is also
# what makes a served sentence that line-wraps across several lines (A5(b)'s new,
# longer 402 sentence wraps across six) matchable by a single-line pattern below.
function Get-Flat($url) { ((curl.exe -s --max-time 20 $url | Out-String) -replace '\s+', ' ') }
# ErrorActionPreference = "Stop" makes a non-2xx THROW before a caller's own status
# check can ever run, so the real status check has to live on both paths out of
# this function, the normal return AND the catch. The error body is read from
# $_.ErrorDetails.Message first: PowerShell 5.1 has already consumed the response
# stream by the time a catch runs (the same trap deploy-wallet-pin.ps1 hit).
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
    Stop-Here "GET $url -> $status, expected 200 ($(Format-ErrBody $errBody))."
  }
}
# A6's own addition: the ride needs POST (initialize, tools/list) with a JSON body
# and, for the CORS check, response headers -- Invoke-RideGet's own shape, widened.
function Invoke-RidePost($url, $bodyJson, $headers) {
  try {
    $resp = Invoke-WebRequest -UseBasicParsing -Uri $url -Method Post -ContentType "application/json" -Body $bodyJson -Headers $headers
    if ($resp.StatusCode -ne 200) { Stop-Here "POST $url -> $($resp.StatusCode), expected 200." }
    return $resp
  } catch {
    $status = "no HTTP response"
    if ($_.Exception.Response) { $status = [int]$_.Exception.Response.StatusCode }
    $errBody = $null
    if ($_.ErrorDetails -and $_.ErrorDetails.Message) { $errBody = $_.ErrorDetails.Message }
    Stop-Here "POST $url -> $status, expected 200 ($(Format-ErrBody $errBody))."
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
# A6: a Select-String on THIS WAVE's own addition (A2), not a bare Test-Path on a
# file that already existed before this wave (deploy-heartbeat-inbox.ps1's own
# "src/inbox.ts is not in this checkout" check would pass on main even without any
# of A1-A5, since inbox.ts predates this wave -- it proves the wrong thing here).
if (-not (Select-String -Path "src/mcp.ts" -Pattern "SUPPORTED_PROTOCOL_VERSIONS" -Quiet -ErrorAction SilentlyContinue)) {
  Stop-Here "src/mcp.ts does not contain SUPPORTED_PROTOCOL_VERSIONS (A2): this wave's own code is not in this checkout, or is the wrong branch/directory."
}

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

# 2. live, before: attest (non-minting expected, per A5(d)) and the propagation
# baseline (A6's own choice: SKILL_VERSION 1.0.1 -> 1.0.2 is this wave's cleanest
# single-field, pre-existing-route diff to poll on -- A1-A5 add no brand-new
# dispatch path the way the heartbeat+inbox wave's own GET /api/inbox 404-before
# check could use, so this script polls a served VALUE instead of a served
# ROUTE'S EXISTENCE).
$attBefore = Get-Json "$BASE/api/attest"
if ($attBefore.constitution.template_hash -ne $V5_HASH) { Stop-Here "live constitution is $($attBefore.constitution.template_hash), expected v5 $V5_HASH." }
foreach ($ch in "identity_log", "treasury", "payouts", "ballots") {
  if ($attBefore.$ch.status -ne "verified") { Stop-Here "chain $ch is $($attBefore.$ch.status) before the deploy." }
}
Write-Host ("[live] before: v5 " + $V5_HASH.Substring(0, 8) + "; chains verified; identity head " + $attBefore.identity_log.head.Substring(0, 12) + " at " + $attBefore.identity_log.total_rows + " rows")
$surfaceBefore = Get-Json "$BASE/api/surface"
if ($surfaceBefore.skill.version -eq "1.0.2") { Stop-Here "live /api/surface already serves skill.version 1.0.2 -- this wave may already be deployed; investigate before shipping anything." }
Write-Host "[live] before: GET /api/surface skill.version is $($surfaceBefore.skill.version) (not yet 1.0.2, as expected pre-deploy)"

if ($DryRun) { Write-Host "[dry-run] would run: npx wrangler deploy, then the post-deploy ride in step 4. Nothing deployed."; exit 0 }

# 3. deploy
Write-Host "[deploy] npx wrangler deploy"
npx wrangler deploy
if ($LASTEXITCODE -ne 0) { Stop-Here "wrangler deploy failed; the old worker is still live." }

# 3.5. wait for the new worker's skill.version to appear before the first
# post-deploy read. wrangler deploy returns once propagation STARTS, not once it
# is complete everywhere -- the edge can still answer with the OLD worker (1.0.1)
# for a few seconds after. Same 12 x 5 s pattern as
# scripts/deploy-heartbeat-inbox.ps1:134-148, adapted to poll a JSON field instead
# of a raw status code: each iteration tolerates a parse failure (a transient
# non-JSON edge response) as "not yet", never a hard stop mid-poll.
$skillVersionAfter = $surfaceBefore.skill.version
for ($i = 0; $i -lt 12; $i++) {
  $polled = $null
  try {
    $polledRaw = (curl.exe -s --max-time 10 "$BASE/api/surface")
    $polled = $polledRaw | ConvertFrom-Json
  } catch {
    $polled = $null
  }
  if ($polled -and $polled.skill.version -eq "1.0.2") { $skillVersionAfter = $polled.skill.version; break }
  Start-Sleep -Seconds 5
}
if ($skillVersionAfter -ne "1.0.2") { Stop-Here "deployed, but /api/surface skill.version has not become 1.0.2 after 60 s; check by hand." }
Write-Host "[deploy] GET /api/surface skill.version -> 1.0.2 after waiting for propagation"

# 4. the ride, exactly the brief's own Deploy section
# 4a. POST initialize to /mcp/read with an Origin header -> Access-Control-Allow-Origin: *
#     and protocolVersion negotiates 1999-01-01 -> 2025-11-25 (A1 + A2, together).
$initHeaders = @{ Origin = "https://ride-check.example.invalid" }
$initBody = (@{ jsonrpc = "2.0"; id = 1; method = "initialize"; params = @{ protocolVersion = "1999-01-01" } } | ConvertTo-Json -Compress -Depth 5)
$initResp = Invoke-RidePost "$BASE/mcp/read" $initBody $initHeaders
if ($initResp.Headers["Access-Control-Allow-Origin"] -ne "*") { Stop-Here "POST /mcp/read initialize does not carry Access-Control-Allow-Origin: *." }
$initParsed = $initResp.Content | ConvertFrom-Json
if ($initParsed.result.protocolVersion -ne "2025-11-25") { Stop-Here "POST /mcp/read initialize negotiated '$($initParsed.result.protocolVersion)' for a 1999-01-01 request, expected 2025-11-25." }
Write-Host "[ride] POST /mcp/read initialize: CORS present, 1999-01-01 negotiates to 2025-11-25"

# 4b. tools/list on /mcp/read shows a title and readOnlyHint:true on every tool (A3).
$readListBody = (@{ jsonrpc = "2.0"; id = 2; method = "tools/list" } | ConvertTo-Json -Compress)
$readListResp = Invoke-RidePost "$BASE/mcp/read" $readListBody @{}
$readTools = ($readListResp.Content | ConvertFrom-Json).result.tools
if (-not $readTools -or $readTools.Count -eq 0) { Stop-Here "POST /mcp/read tools/list returned zero tools." }
foreach ($readTool in $readTools) {
  if (-not $readTool.title) { Stop-Here "/mcp/read tool '$($readTool.name)' has no title." }
  if ($readTool.annotations.readOnlyHint -ne $true) { Stop-Here "/mcp/read tool '$($readTool.name)' is not readOnlyHint:true." }
}
Write-Host "[ride] POST /mcp/read tools/list: $($readTools.Count) tools, every one carries a title and readOnlyHint:true"

# 4c. /mcp tools/list shows me with readOnlyHint:false (A3 -- me writes last_seen_at).
$fullListBody = (@{ jsonrpc = "2.0"; id = 3; method = "tools/list" } | ConvertTo-Json -Compress)
$fullListResp = Invoke-RidePost "$BASE/mcp" $fullListBody @{}
$fullTools = ($fullListResp.Content | ConvertFrom-Json).result.tools
$meTool = $fullTools | Where-Object { $_.name -eq "me" }
if (-not $meTool) { Stop-Here "POST /mcp tools/list has no 'me' tool." }
if ($meTool.annotations.readOnlyHint -ne $false) { Stop-Here "/mcp 'me' tool is not readOnlyHint:false." }
Write-Host "[ride] POST /mcp tools/list: 'me' present, readOnlyHint:false"

# 4d. /skill.md serves version: 1.0.2 and the new Join sentence; /api/surface's
# sha256 equals the served body's own sha256 (A5(a), D7's own promise held).
$skillResp = Invoke-RideGet "$BASE/skill.md"
if ($skillResp.Content -notmatch "version:\s*1\.0\.2") { Stop-Here "/skill.md does not serve version: 1.0.2." }
$skillFlat = ($skillResp.Content -replace '\s+', ' ')
if ($skillFlat -notmatch [regex]::Escape("The checks run first and cost nothing")) { Stop-Here "/skill.md does not carry the new Join paragraph's checks-first sentence." }
$surfaceForSkill = Get-Json "$BASE/api/surface"
$skillSha = Get-Sha256Hex $skillResp.Content
if ($surfaceForSkill.skill.sha256 -ne $skillSha) { Stop-Here "/api/surface skill.sha256 ($($surfaceForSkill.skill.sha256)) does not match the served /skill.md body's own sha256 ($skillSha)." }
Write-Host "[ride] /skill.md: version 1.0.2, new Join sentence present; /api/surface sha256 matches the served body"

# 4e. /llms.txt serves the new 402 sentence (A5(b)).
$llmsFlat = Get-Flat "$BASE/llms.txt"
if ($llmsFlat -notmatch [regex]::Escape("a request that passes its checks returns 402")) { Stop-Here "/llms.txt does not carry the corrected 402 sentence." }
Write-Host "[ride] /llms.txt: the corrected 402 sentence is present"

# 4f. /api/surface lists /api/search, /api/stats and /api/showhome/reply (A4).
$surfaceRoutes = (Get-Json "$BASE/api/surface").routes
foreach ($newPath in "/api/search", "/api/stats", "/api/showhome/reply") {
  if (-not ($surfaceRoutes | Where-Object { $_.path -eq $newPath })) { Stop-Here "/api/surface does not list $newPath." }
}
Write-Host "[ride] /api/surface lists /api/search, /api/stats, /api/showhome/reply"

# 4g. attest still v5, all chains verified (non-minting, A5(d) held).
$attAfter = Get-Json "$BASE/api/attest"
if ($null -eq $attAfter -or $null -eq $attAfter.constitution -or -not $attAfter.constitution.template_hash) { Stop-Here "GET /api/attest was unreadable after the deploy; re-read it by hand before anything else (this is NOT a minting signal)." }
if ($attAfter.constitution.template_hash -ne $V5_HASH) { Stop-Here "template_hash CHANGED to $($attAfter.constitution.template_hash): this wave was expected to be non-minting; investigate before anything else." }
foreach ($ch in "identity_log", "treasury", "payouts", "ballots") {
  if ($attAfter.$ch.status -ne "verified") { Stop-Here "chain $ch is $($attAfter.$ch.status) after the deploy: investigate." }
}
Write-Host ("[ride] attest: v5 " + $V5_HASH.Substring(0, 8) + " unchanged; all four chains verified")

# 4h. a general sweep of untouched surfaces, mirroring deploy-heartbeat-inbox.ps1's
# own closing sweep.
$door = Get-Flat "$BASE/"
if ($door -notmatch "Heartbeat: GET") { Stop-Here "the heartbeat door note is not on GET / -- an unrelated regression, investigate." }
$bad = @()
foreach ($sweepPath in "/", "/api/official", "/llms.txt", "/openapi.json", "/api/topics", "/api/front", "/treasury", "/api/showhome", "/api/search?q=a", "/api/stats") {
  $sweepCode = (curl.exe -s --max-time 20 -o NUL -w "%{http_code}" "$BASE$sweepPath")
  if ($sweepCode -ne "200") { $bad += "$sweepPath=$sweepCode" }
}
if ($bad.Count -gt 0) { Stop-Here ("non-200 after deploy: " + ($bad -join ", ")) }
Write-Host "[done] MCP listing readiness (wave A) deployed and ridden. Log the worker version id and these lines in HANDOVER.md. HEAD $head"
