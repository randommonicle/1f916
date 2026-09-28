# Deploys the x402 settle-honesty wave (wave B, docs/BRIEF-X402-SETTLE-HONESTY.md): the /settle and
# /verify answers classified by status and body, the PayAI discovery declaration on the register
# door's payment requirements, and the registration scripts' unknown-outcome warning. Worker only,
# NO migration, non-minting (src/doc.ts is untouched). One fail-fast script (L-046). Every stop
# before "wrangler deploy" leaves the live worker exactly as it was; a stop after it says what to
# check by hand. Written but NOT run by the builder (the commission's own hard rule) -- this is
# Ben's hand only (D-017), after the code exchange and the D-018 gate, from society/ on main, after
# the merge and the push:
#   cd "C:\Users\bengr\Projects\AI domain and social network\society"
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-x402-settle-honesty.ps1 -DryRun
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-x402-settle-honesty.ps1
# PowerShell 5.1: never merge a native command's stderr under ErrorActionPreference Stop; read exit
# codes and stdout. -notmatch on an ARRAY filters (L-080 family), so multi-line captures go through
# Out-String first. This file is ASCII only: 5.1 reads a BOM-less UTF-8 script as the ANSI code page.
param([switch]$DryRun)
$ErrorActionPreference = "Stop"
$BASE = "https://commonhold.randommonicle.workers.dev"
$V5_HASH = "fa11788d062b0c6d23c54c428c1c9649d263ae3ba704e602e122066926049491"
$RIDE_LIMIT_NOTE = "The /settle and /verify classifications cannot be ridden without a real payment: the tests prove them (test/x402.test.ts, test/x402-settle-route-d1.test.ts), and the next real payment's log line is their first ride (an unknown settle outcome logs x402_settle_outcome_unknown, with broadcast_tx when PayAI names one)."

function Stop-Here($msg) { Write-Host "[STOP] $msg"; exit 1 }
# Our worker's own error bodies are {"error": "..."} and carry no secret, so a parsed string `error`
# field is safe to surface, truncated to 200 characters; anything else names only a LENGTH, never raw
# content (the same rule as scripts/deploy-heartbeat-inbox.ps1).
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
# A GET whose HTTP status is read, not discarded: a non-200 carrying JSON with the expected fields
# must never pass a check that only reads named keys (CODEX F2 on the heartbeat wave).
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
# A POST with a JSON body and NO X-PAYMENT, so nothing can be paid: the answer is a 402 challenge (or a
# refusal before one). The body goes through a temp file (--data-binary @file) because PowerShell 5.1
# strips embedded double quotes from a native command's arguments, which would mangle inline JSON.
# Returns the status code, the parsed body (or $null) and the raw text.
function Invoke-UnpaidPost($url, $jsonBody, $maxTime) {
  $bodyFile = [System.IO.Path]::GetTempFileName()
  $outFile = [System.IO.Path]::GetTempFileName()
  try {
    [System.IO.File]::WriteAllText($bodyFile, $jsonBody, (New-Object System.Text.UTF8Encoding($false)))
    $code = (curl.exe -s --max-time $maxTime -X POST -H "Content-Type: application/json" --data-binary "@$bodyFile" -o $outFile -w "%{http_code}" $url)
    $raw = (Get-Content $outFile -Raw -ErrorAction SilentlyContinue)
    $parsed = $null
    if ($raw) { try { $parsed = $raw | ConvertFrom-Json } catch { $parsed = $null } }
    return @{ Code = "$code"; Body = $parsed; Raw = $raw }
  } finally {
    Remove-Item $bodyFile, $outFile -ErrorAction SilentlyContinue
  }
}
# The first requirements object of a 402 challenge, or $null if the answer is not one.
function Get-FirstAccepts($resp) {
  if ($resp.Code -ne "402" -or $null -eq $resp.Body) { return $null }
  if (-not ($resp.Body.PSObject.Properties.Name -contains "accepts")) { return $null }
  $all = @($resp.Body.accepts)
  if ($all.Count -lt 1) { return $null }
  return $all[0]
}
function Test-HasOutputSchema($first) { return ($first.PSObject.Properties.Name -contains "outputSchema") }
# The register probe must be a 402 challenge. A 429 is the registration throttle (3 registrations per
# IP per hour, 300 society-wide), counted from real registrations only: not a defect in this wave.
function Assert-RegisterChallenge($resp, $when) {
  if ($resp.Code -eq "429") { Stop-Here "POST /api/register ($when) -> 429: the registration throttle refused this IP or the society is at its hourly cap. Not a defect in this wave; nothing was written. Re-run in an hour." }
  if ($resp.Code -eq "403") { Stop-Here "POST /api/register ($when) -> 403: the door is invite-only now ($(Format-ErrBody $resp.Raw)); this probe expects REGISTRATION_MODE open." }
  if ($resp.Code -eq "000") { Stop-Here "POST /api/register ($when): no HTTP answer (curl.exe timed out or could not connect)." }
  $first = Get-FirstAccepts $resp
  if ($null -eq $first) { Stop-Here "POST /api/register ($when) -> $($resp.Code), expected a 402 challenge with accepts ($(Format-ErrBody $resp.Raw))." }
  return $first
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
if (-not (Select-String -Path "src/x402.ts" -Pattern "export function classifySettle" -Quiet)) { Stop-Here "src/x402.ts has no classifySettle: this checkout is not the settle-honesty wave (wrong branch or directory)." }
if (-not (Select-String -Path "src/register-gate.ts" -Pattern "export const REGISTER_OUTPUT_SCHEMA" -Quiet)) { Stop-Here "src/register-gate.ts has no REGISTER_OUTPUT_SCHEMA: this checkout is not the settle-honesty wave." }

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

# 2. live, before: attest (non-minting expected), and the two unpaid probes as the old worker answers them
$attBefore = Get-Json "$BASE/api/attest"
if ($attBefore.constitution.template_hash -ne $V5_HASH) { Stop-Here "live constitution is $($attBefore.constitution.template_hash), expected v5 $V5_HASH." }
foreach ($ch in "identity_log", "treasury", "payouts", "ballots") {
  if ($attBefore.$ch.status -ne "verified") { Stop-Here "chain $ch is $($attBefore.$ch.status) before the deploy." }
}
Write-Host ("[live] before: v5 " + $V5_HASH.Substring(0, 8) + "; chains verified; identity head " + $attBefore.identity_log.head.Substring(0, 12) + " at " + $attBefore.identity_log.total_rows + " rows")
# A fresh probe handle per run (UTC yyyyMMddHHmm, 23 characters): a 402 writes nothing (register() and
# its reg_log insert run only after a settlement), so the handle is never taken and nothing is spent.
$probeHandle = "ride-probe-" + (Get-Date).ToUniversalTime().ToString("yyyyMMddHHmm")
$regBody = '{"handle":"' + $probeHandle + '","model":"ride-probe"}'
$regBefore = Invoke-UnpaidPost "$BASE/api/register" $regBody 20
$regBeforeFirst = Assert-RegisterChallenge $regBefore "before"
if (Test-HasOutputSchema $regBeforeFirst) { Stop-Here "the live register 402 already carries outputSchema before this deploy: investigate before shipping anything." }
Write-Host "[live] before: POST /api/register (handle $probeHandle, no payment) -> 402 with no outputSchema, as expected pre-deploy"
$patBefore = Invoke-UnpaidPost "$BASE/api/patron" '{}' 20
$patBeforeFirst = Get-FirstAccepts $patBefore
if ($null -eq $patBeforeFirst) { Stop-Here "POST /api/patron (no payment) -> $($patBefore.Code), expected a 402 challenge ($(Format-ErrBody $patBefore.Raw))." }
if (Test-HasOutputSchema $patBeforeFirst) { Stop-Here "the live patron 402 carries outputSchema before this deploy: investigate." }
Write-Host "[live] before: POST /api/patron (no payment) -> 402 with no outputSchema"

if ($DryRun) {
  Write-Host "[dry-run] would run: npx wrangler deploy, then the post-deploy ride in step 4. Nothing deployed."
  Write-Host "[note] $RIDE_LIMIT_NOTE"
  exit 0
}

# 3. deploy
Write-Host "[deploy] npx wrangler deploy"
npx wrangler deploy
if ($LASTEXITCODE -ne 0) { Stop-Here "wrangler deploy failed; the old worker is still live." }

# 3.5. propagation: wrangler deploy returns once propagation STARTS, so the edge can still answer with
# the OLD worker for a few seconds. Poll the unpaid register probe until its 402 carries the
# declaration (12 x 5 s, a shorter --max-time per try so one stalled try cannot burn the budget).
$declared = $false
for ($i = 0; $i -lt 12; $i++) {
  $poll = Invoke-UnpaidPost "$BASE/api/register" $regBody 10
  if ($poll.Code -eq "429") { Stop-Here "deployed, but the register probe is now throttled (429) while waiting for propagation; check POST /api/register by hand in an hour." }
  $pollFirst = Get-FirstAccepts $poll
  if ($null -ne $pollFirst -and (Test-HasOutputSchema $pollFirst)) { $declared = $true; break }
  Start-Sleep -Seconds 5
}
if (-not $declared) { Stop-Here "deployed, but the register 402 has not carried outputSchema after 60 s; check POST /api/register by hand." }
Write-Host "[deploy] the register 402 carries outputSchema after waiting for propagation"

# 4. the ride, exactly the brief's B7
# 4a. POST /api/register, no payment -> 402 whose accepts[0].outputSchema.input.discoverable is true
$regAfter = Invoke-UnpaidPost "$BASE/api/register" $regBody 20
$regAfterFirst = Assert-RegisterChallenge $regAfter "after"
if (-not (Test-HasOutputSchema $regAfterFirst)) { Stop-Here "POST /api/register -> 402 without outputSchema after the deploy." }
$decl = $regAfterFirst.outputSchema
if ($decl.input.discoverable -ne $true) { Stop-Here "the register 402's outputSchema.input.discoverable is '$($decl.input.discoverable)', expected true." }
if ($decl.input.type -ne "http" -or $decl.input.method -ne "POST") { Stop-Here "the register 402's outputSchema.input is type '$($decl.input.type)' method '$($decl.input.method)', expected http / POST." }
Write-Host "[ride] POST /api/register (no payment) -> 402; accepts[0].outputSchema.input: type http, method POST, discoverable true"
# 4b. POST /api/patron, no payment -> 402 with no outputSchema
$patAfter = Invoke-UnpaidPost "$BASE/api/patron" '{}' 20
$patAfterFirst = Get-FirstAccepts $patAfter
if ($null -eq $patAfterFirst) { Stop-Here "POST /api/patron (no payment) -> $($patAfter.Code) after the deploy, expected a 402 challenge ($(Format-ErrBody $patAfter.Raw))." }
if (Test-HasOutputSchema $patAfterFirst) { Stop-Here "the patron 402 carries outputSchema after the deploy: only the register door may declare." }
Write-Host "[ride] POST /api/patron (no payment) -> 402 with no outputSchema"
# 4c. attest still v5, all four chains verified (non-minting)
$attAfter = Get-Json "$BASE/api/attest"
if ($null -eq $attAfter -or $null -eq $attAfter.constitution -or -not $attAfter.constitution.template_hash) { Stop-Here "GET /api/attest was unreadable after the deploy; re-read it by hand before anything else (this is NOT a minting signal)." }
if ($attAfter.constitution.template_hash -ne $V5_HASH) { Stop-Here "template_hash CHANGED to $($attAfter.constitution.template_hash): this wave was expected to be non-minting; investigate before anything else." }
foreach ($ch in "identity_log", "treasury", "payouts", "ballots") {
  if ($attAfter.$ch.status -ne "verified") { Stop-Here "chain $ch is $($attAfter.$ch.status) after the deploy: investigate." }
}
Write-Host ("[ride] attest: v5 " + $V5_HASH.Substring(0, 8) + " unchanged; all four chains verified")
# 4d. a sweep of untouched surfaces
$bad = @()
foreach ($p in "/", "/api/official", "/llms.txt", "/openapi.json", "/treasury") {
  $code = (curl.exe -s --max-time 20 -o NUL -w "%{http_code}" "$BASE$p")
  if ($code -ne "200") { $bad += "$p=$code" }
}
if ($bad.Count -gt 0) { Stop-Here ("non-200 after deploy: " + ($bad -join ", ")) }
Write-Host "[ride] /, /api/official, /llms.txt, /openapi.json, /treasury -> 200"
Write-Host "[note] $RIDE_LIMIT_NOTE"
Write-Host "[done] the settle-honesty wave is deployed and ridden. Log the worker version id and these lines in HANDOVER.md. HEAD $head"
