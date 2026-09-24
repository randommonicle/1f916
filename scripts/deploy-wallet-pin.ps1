# ONE fail-fast deploy script for the server-side wallet pin (branch wallet-pin-2026-09-24,
# docs/BRIEF-SERVER-SIDE-WALLET-PIN.md, docs/CHECKPOINT-WALLET-PIN.md), per L-046 and L-069:
# read BOTH tables' catalogues, apply migration 0016 only from a clean pre-0016 state, catalog-verify all four columns and
# that every existing row reads NULL in them, and deploy the worker ONLY then. Ben's hand only (D-017). Run from society/
# on main after the merge and the push:
#   powershell -ExecutionPolicy Bypass -File ".\scripts\deploy-wallet-pin.ps1" -DryRun   # reads only: gates, attest, the catalogue; exits before the migration
#   powershell -ExecutionPolicy Bypass -File ".\scripts\deploy-wallet-pin.ps1"           # the real thing
# What it does NOT do: the D-018 Opus gate (money path; before this script), the push (first, on Ben's word), any payment.
# The ride at the end is refusal-only (no listing is open, so there is nothing to pay): one POST to /api/listing/3/pay
# (paid on 2026-09-15) with NO pin, as commonhold-agent, which the new worker must refuse 400 wallet_row_required before it
# reads the listing. It spends nothing and writes only the pay route's own record-first throttle row (reg_log, pruned after
# 24 h). The happy path is ridden by the next real payment, whenever Ben posts and pays one.
# PowerShell 5.1: never merge a native command's stderr under ErrorActionPreference Stop; read exit codes and stdout.
param([switch]$DryRun)
$ErrorActionPreference = "Stop"
$B = "https://commonhold.randommonicle.workers.dev"
# PowerShell variable names are case-insensitive: no local below may share a name with these lists (L-080: a local
# $cols once shadowed $COLS and a presence check read 0/3 on a complete catalogue).
$PIN_LISTINGS_COLUMNS = @("paying_wallet_row_id", "paying_wallet_row_hash")
$PIN_PAYMENTS_COLUMNS = @("wallet_row_id", "wallet_row_hash")
$PIN_TYPES = @{ paying_wallet_row_id = "INTEGER"; paying_wallet_row_hash = "TEXT"; wallet_row_id = "INTEGER"; wallet_row_hash = "TEXT" }

function Stop-Here($msg) { Write-Host "[STOP] $msg"; exit 1 }
function Read-D1Json($lines) { $txt = ($lines | Out-String); $i = $txt.IndexOf("["); if ($i -lt 0) { Stop-Here "d1 returned no JSON: $txt" }; return ($txt.Substring($i) | ConvertFrom-Json) }
function Read-TableInfo($table, $minColumns) {
  $info = Read-D1Json (npx wrangler d1 execute commonhold --remote --json --command "PRAGMA table_info($table)")
  $rows = @($info[0].results)
  if ($rows.Count -lt $minColumns) { Stop-Here "the catalogue read parsed fewer than $minColumns $table columns; refusing to reason from a bad read" }
  return $rows
}
function Read-Catalogue() {
  # 17 = 0009's fifteen + pledge (0013) + paying_since (0014); 0016 makes it 19. listing_payments: 0009's nine.
  $listingsInfo = Read-TableInfo "listings" 17
  $paymentsInfo = Read-TableInfo "listing_payments" 9
  $presentL = @($PIN_LISTINGS_COLUMNS | Where-Object { $n = $_; @($listingsInfo | Where-Object { $_.name -eq $n }).Count -eq 1 })
  $presentP = @($PIN_PAYMENTS_COLUMNS | Where-Object { $n = $_; @($paymentsInfo | Where-Object { $_.name -eq $n }).Count -eq 1 })
  return @{ listingsInfo = $listingsInfo; paymentsInfo = $paymentsInfo; present = ($presentL.Count + $presentP.Count); presentNames = (@($presentL) + @($presentP)) }
}
# Strict (GEMINI build review G2.2): a missing or non-numeric result STOPS; [int]$null would silently read 0 and pass
# every "must be 0" gate below without reading anything.
function Read-Count($sql) {
  $r = Read-D1Json (npx wrangler d1 execute commonhold --remote --json --command $sql)
  $rows = @($r[0].results)
  if ($rows.Count -ne 1 -or $null -eq $rows[0].n -or "$($rows[0].n)" -notmatch "^[0-9]+$") { Stop-Here "a count query returned no usable number ($sql); refusing to reason from a bad read" }
  return [int]$rows[0].n
}

# 0. where we are
$head = (git rev-parse --short=8 HEAD).Trim()
$level = (git status -sb | Select-Object -First 1)
$dirty = @(git status --porcelain)
if ($dirty.Count -gt 0) {
  if ($DryRun) { Write-Host ("[dry-run] working tree NOT clean (" + $dirty.Count + " paths): the real run would STOP here.") }
  else { Stop-Here ("working tree not clean (" + $dirty.Count + " paths): the deploy must ship exactly the committed tree.") }
}
Write-Host "[git] HEAD $head  $level"
if ($level -notmatch "main\.\.\.origin/main$") {
  if ($DryRun) { Write-Host "[dry-run] NOT level with origin/main: the real run would STOP here (merge to main and push first)." }
  else { Stop-Here "push first: the deploy must ship the same commit the public fork carries (R-4 / D-006)." }
}
if (-not (Test-Path "migrations/0016_wallet_pin.sql")) { Stop-Here "migrations/0016_wallet_pin.sql is not in this checkout: wrong branch or directory" }
# The ride's custody file is proven readable BEFORE anything on prod changes (GEMINI build review G2.1), in -DryRun too.
# Its secret is checked for presence only and never printed.
$CUSTODY = Join-Path (Resolve-Path "..").Path "commonhold-agent-registration.local.json"
if (-not (Test-Path $CUSTODY)) { Stop-Here "custody file for the refusal ride not found (commonhold-agent-registration.local.json one level up)" }
if (-not (Get-Content $CUSTODY -Raw | ConvertFrom-Json).secret) { Stop-Here "custody file for the refusal ride did not parse to a secret" }
Write-Host "[custody] the refusal ride's bearer is present (not printed)"

# 1. the wave's own gates, re-run here so a stale checkout cannot deploy
Write-Host "[gate] npm run typecheck"
npm run typecheck | Out-Null; if ($LASTEXITCODE -ne 0) { Stop-Here "typecheck failed" }
Write-Host "[gate] npm test"
$t = npm test | Out-String
if ($LASTEXITCODE -ne 0 -or $t -notmatch "fail 0") { Stop-Here "the suite is not green" }
Write-Host "[gate] suite green"

# 2. live before: attest (non-minting expected), both catalogues, the row counts
$attestBefore = curl.exe -s "$B/api/attest" | ConvertFrom-Json
Write-Host ("[live] before: constitution v" + $attestBefore.constitution.version + " template " + $attestBefore.constitution.template_hash.Substring(0,8) + " identity " + $attestBefore.identity_log.sealed_entries + " treasury " + $attestBefore.treasury.sealed_entries + " ballots " + $attestBefore.ballots.sealed_entries)
$before = Read-Catalogue
Write-Host ("[d1] 0016 columns present before: " + $before.present + "/4 (" + ($before.presentNames -join ", ") + ")")
$clean = ($before.present -eq 0)
$complete = ($before.present -eq 4)
if (-not $clean -and -not $complete) { Stop-Here ("PARTIAL 0016 state on prod (" + ($before.presentNames -join ", ") + "); repair by hand before anything deploys") }
$listingsBefore = Read-Count "SELECT COUNT(*) AS n FROM listings"
$paymentsBefore = Read-Count "SELECT COUNT(*) AS n FROM listing_payments"
$payingBefore = Read-Count "SELECT COUNT(*) AS n FROM listings WHERE status = 'paying'"
Write-Host "[d1] rows before: listings $listingsBefore, listing_payments $paymentsBefore, paying $payingBefore"
if ($payingBefore -ne 0) { Stop-Here "a listing is 'paying' (a payment in flight or unresolved): reconcile it before changing the pay route" }
if ($DryRun) { Write-Host "[dry-run] stopping before the migration. The real run would $(if ($clean) { 'APPLY 0016' } else { 'SKIP 0016 (already complete)' }), catalog-verify, deploy, then ride."; exit 0 }

# 3. migration 0016 from a clean state only (D1 has no IF NOT EXISTS for ADD COLUMN: a complete state is skipped, never re-applied)
if ($clean) {
  Write-Host "[d1] applying migrations/0016_wallet_pin.sql"
  npx wrangler d1 execute commonhold --remote --file "migrations/0016_wallet_pin.sql"
  if ($LASTEXITCODE -ne 0) { Stop-Here "migration 0016 failed; nothing deployed; re-read the catalogue before retrying (a partial apply must be repaired by hand)" }
}
$after = Read-Catalogue
if ($after.present -ne 4) { Stop-Here ("catalogue after the migration is not complete (" + ($after.presentNames -join ", ") + "); nothing deployed") }
foreach ($row in (@($after.listingsInfo) + @($after.paymentsInfo))) {
  if ($PIN_TYPES.ContainsKey($row.name)) {
    if ($row.type -ne $PIN_TYPES[$row.name] -or $row.notnull -ne 0 -or $null -ne $row.dflt_value) { Stop-Here ("column " + $row.name + " shape wrong: type " + $row.type + " notnull " + $row.notnull + " default " + $row.dflt_value) }
  }
}
if ((Read-Count "SELECT COUNT(*) AS n FROM listings") -ne $listingsBefore -or (Read-Count "SELECT COUNT(*) AS n FROM listing_payments") -ne $paymentsBefore) { Stop-Here "row counts changed across the migration; investigate" }
if ((Read-Count "SELECT COUNT(*) AS n FROM listing_payments WHERE wallet_row_id IS NOT NULL OR wallet_row_hash IS NOT NULL") -ne 0) { Stop-Here "book rows carry a wallet row before the new worker ran; investigate" }
if ((Read-Count "SELECT COUNT(*) AS n FROM listings WHERE paying_wallet_row_id IS NOT NULL OR paying_wallet_row_hash IS NOT NULL") -ne 0) { Stop-Here "listings carry a reserved pair before the new worker ran; investigate" }
Write-Host "[d1] catalog-verified: four nullable columns, no defaults; row counts unchanged; every existing row NULL in them"

# 4. deploy the worker
Write-Host "[deploy] npx wrangler deploy"
npx wrangler deploy
if ($LASTEXITCODE -ne 0) { Stop-Here "wrangler deploy failed (the migration is applied and harmless to the old worker: it never reads the columns)" }

# 5. the ride: public GETs, then one refusal-only POST
$attestAfter = curl.exe -s "$B/api/attest" | ConvertFrom-Json
# An unreadable attest is its own stop, never the minting alarm (gate L4b).
if ($null -eq $attestAfter -or $null -eq $attestAfter.constitution -or -not $attestAfter.constitution.template_hash) { Stop-Here "GET /api/attest was unreadable after the deploy; re-read it by hand before anything else (this is NOT a minting signal)" }
if ($attestAfter.constitution.template_hash -ne $attestBefore.constitution.template_hash) { Stop-Here "template_hash CHANGED: this wave was expected to be non-minting; investigate before anything else" }
foreach ($c in @("identity_log", "treasury", "payouts", "ballots")) {
  if ($attestAfter.$c.status -ne "verified") { Stop-Here ("chain " + $c + " is '" + $attestAfter.$c.status + "' after the deploy, not verified: investigate") }
}
Write-Host ("[ride] attest: v" + $attestAfter.constitution.version + " unchanged; all four chains verified")
foreach ($p in @("/api/listings", "/api/listings/guide", "/api/listings/security", "/api/listings/payments", "/api/listing/3", "/api/official", "/llms.txt", "/openapi.json", "/")) {
  $code = curl.exe -s -o NUL -w "%{http_code}" "$B$p"
  Write-Host "[ride] $p -> $code"
  if ($code -ne "200") { Stop-Here "$p is not 200 after the deploy" }
}
$book = curl.exe -s "$B/api/listings/payments" | ConvertFrom-Json
if ($null -eq $book.wallet_row_note) { Stop-Here "/api/listings/payments serves no wallet_row_note" }
$withKey = @($book.entries | Where-Object { $_.PSObject.Properties.Name -contains "wallet_row_id" })
if ($withKey.Count -ne @($book.entries).Count) { Stop-Here "not every book row serves wallet_row_id" }
Write-Host ("[ride] payments book: " + @($book.entries).Count + " rows, each serving wallet_row_id (null before the check)")
$detail = curl.exe -s "$B/api/listing/3" | ConvertFrom-Json
$served = @($detail.submissions | Where-Object { $_.PSObject.Properties.Name -contains "payee_wallet_row" })
if ($served.Count -ne @($detail.submissions).Count -or $null -eq $detail.payee_wallet_row_note) { Stop-Here "/api/listing/3 does not serve payee_wallet_row on every submission" }
Write-Host ("[ride] /api/listing/3: payee_wallet_row served on " + $served.Count + " submission(s)")
# One string, not an array of lines (L-080 family: -notmatch on an array filters).
$guide = (curl.exe -s "$B/api/listings/guide") -join "`n"
if ($guide -notmatch "wallet_row_id, wallet_row_hash") { Stop-Here "the guide does not name the pin" }
# The refusal-only POST: commonhold-agent's bearer is read from its custody file, sent in-process (never on a command
# line other processes can read, gate L4a), and never printed.
$secret = (Get-Content $CUSTODY -Raw | ConvertFrom-Json).secret
$status = ""; $bodyText = ""
try {
  $ok = Invoke-WebRequest -UseBasicParsing -Method Post -Uri "$B/api/listing/3/pay" -ContentType "application/json" -Headers @{ Authorization = "Bearer $secret" } -Body '{"submission_id":1}'
  $status = [string][int]$ok.StatusCode; $bodyText = $ok.Content
} catch [System.Net.WebException] {
  $r = $_.Exception.Response
  if ($null -eq $r) { $secret = $null; Stop-Here "the refusal ride got no HTTP response: $($_.Exception.Message)" }
  $status = [string][int]$r.StatusCode
  $bodyText = (New-Object System.IO.StreamReader($r.GetResponseStream())).ReadToEnd()
}
$secret = $null
$json = $bodyText | ConvertFrom-Json
Write-Host ("[ride] POST /api/listing/3/pay with no pin -> " + $status + " " + $json.code)
if ($status -ne "400" -or $json.code -ne "wallet_row_required") { Stop-Here "the new worker did not refuse a pin-less pay request with 400 wallet_row_required" }
Write-Host "[done] wave deployed and ridden (refusal-only). Log the worker version id and these lines in HANDOVER.md. The happy path is ridden by the next real payment (scripts/pay-listing.mjs, dry run first)."
