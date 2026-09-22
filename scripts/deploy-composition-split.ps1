# Deploys the composition split (commit 91b73ef3: parallax's provenance split, DECISIONS D-069 note of
# 2026-09-22): worker only, no migration, non-minting. One fail-fast script (L-046). Every stop before
# "wrangler deploy" leaves the live worker exactly as it was; a stop after it says what to check by hand.
#   cd "C:\Users\bengr\Projects\AI domain and social network\society"
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-composition-split.ps1 -DryRun
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-composition-split.ps1
param([switch]$DryRun)
$ErrorActionPreference = "Stop"
$BASE = "https://commonhold.randommonicle.workers.dev"
$V5_HASH = "fa11788d062b0c6d23c54c428c1c9649d263ae3ba704e602e122066926049491"
$OLD_LABEL = '\b\d+ (is|are) independent\b|\bOf (those|the) (\d+ )?independent\b|\bindependent of him\b|tally of citizens independent|counted as independent'
function Stop-Here($msg) { Write-Host "[STOP] $msg"; exit 1 }
function Get-Json($url) { curl.exe -s $url | ConvertFrom-Json }
# One string with whitespace collapsed, never an array of lines (L-076: -match on an array filters).
function Get-Flat($url) { ((curl.exe -s $url | Out-String) -replace '\s+', ' ') }

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
  if ($DryRun) { Write-Host "[dry-run] NOT main level with origin: the real run would STOP here (merge, then push first)." }
  else { Stop-Here "merge to main and push first: the deploy ships the commit the public fork carries (D-006)." }
}
git merge-base --is-ancestor 91b73ef3 HEAD
if ($LASTEXITCODE -ne 0) { Stop-Here "HEAD does not contain 91b73ef3 (the split)." }

# 1. the suite and the typecheck, on this exact tree
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

# 2. live, before
$att = Get-Json "$BASE/api/attest"
if ($att.constitution.template_hash -ne $V5_HASH) { Stop-Here "live constitution is $($att.constitution.template_hash), expected v5 $V5_HASH." }
foreach ($ch in "identity_log", "treasury", "payouts", "ballots") {
  if ($att.$ch.status -ne "verified") { Stop-Here "chain $ch is $($att.$ch.status) before the deploy." }
}
Write-Host ("[live] v5 " + $V5_HASH.Substring(0, 8) + "; chains verified; identity head " + $att.identity_log.head.Substring(0, 12) + " at " + $att.identity_log.total_rows + " rows")

if ($DryRun) { Write-Host "[dry-run] would run: npx wrangler deploy, then the post-deploy checks in step 4. Nothing deployed."; exit 0 }

# 3. deploy
Write-Host "[deploy] npx wrangler deploy"
npx wrangler deploy
if ($LASTEXITCODE -ne 0) { Stop-Here "wrangler deploy failed; the old worker is still live." }

# 4. after: the new text is served everywhere it should be, the old label nowhere, and nothing minted
$o = $null
for ($i = 0; $i -lt 12; $i++) {
  $o = Get-Json "$BASE/api/official"
  if ($null -ne $o.composition.not_designated_operator_controlled) { break }
  Start-Sleep -Seconds 5
}
$c = $o.composition
if ($null -eq $c.not_designated_operator_controlled) { Stop-Here "after 60 s /api/official still serves no not_designated_operator_controlled: check the deploy output and GET /api/official by hand." }
if ($c.independent -ne $c.not_designated_operator_controlled -or $c.not_designated_operator_controlled -ne ($c.citizens - $c.operator_controlled)) { Stop-Here "composition arithmetic: citizens $($c.citizens), operator_controlled $($c.operator_controlled), not_designated $($c.not_designated_operator_controlled), independent $($c.independent)." }
foreach ($fig in "citizens", "operator_controlled", "not_designated_operator_controlled", "operator_funded", "key_lost") {
  if (-not $c.provenance.$fig.check) { Stop-Here "provenance.$fig is missing." }
}
$note = $c.note -replace '\s+', ' '
if ($note -notmatch 'are not on that list' -or $note -match $OLD_LABEL) { Stop-Here "/api/official composition.note does not carry the new wording, or still carries the old label." }
$front = Get-Flat "$BASE/"
if ($front -notmatch 'not on that list, and that is all the count shows' -or $front -notmatch 'counts among the citizens not designated operator-controlled' -or $front -match $OLD_LABEL) { Stop-Here "GET / door notes: new wording missing or old label present." }
$llms = Get-Flat "$BASE/llms.txt"
if ($llms -notmatch "That list is the operator's own statement" -or $llms -match $OLD_LABEL) { Stop-Here "/llms.txt Honesty line: new wording missing or old label present." }
$att2 = Get-Json "$BASE/api/attest"
if ($att2.constitution.template_hash -ne $V5_HASH) { Stop-Here "the deploy MINTED: constitution now $($att2.constitution.template_hash). It must not; report to Ben at once." }
foreach ($ch in "identity_log", "treasury", "payouts", "ballots") {
  if ($att2.$ch.status -ne "verified") { Stop-Here "chain $ch is $($att2.$ch.status) after the deploy." }
}
$bad = @()
foreach ($p in "/", "/api/official", "/api/attest", "/api/citizens", "/api/topics", "/api/front", "/llms.txt", "/treasury", "/api/showhome", "/api/events?kind=moderation") {
  $code = (curl.exe -s -o NUL -w "%{http_code}" "$BASE$p")
  if ($code -ne "200") { $bad += "$p=$code" }
}
if ($bad.Count -gt 0) { Stop-Here ("non-200 after deploy: " + ($bad -join ", ")) }
Write-Host ("[verify] split live on /api/official, GET / and /llms.txt; old label absent; v5 unchanged; chains verified; 10 GETs 200. HEAD " + $head)
