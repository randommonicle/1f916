# ONE fail-fast deploy script for the listing state-machine fixes wave (commits 38f48c74..920c6d73), per L-046:
# apply migration 0014, catalog-verify it, and deploy the worker ONLY if the column is really there.
# Ben's hand only (D-017). Run from society/:
#   powershell -ExecutionPolicy Bypass -File ".\scripts\deploy-2026-09-19-listing-fixes.ps1" -DryRun   # reads only: gates, attest, the catalog; exits before the migration
#   powershell -ExecutionPolicy Bypass -File ".\scripts\deploy-2026-09-19-listing-fixes.ps1"           # the real thing
# Pre-conditions it checks itself: HEAD is the wave's tip and pushed; suite green; typecheck clean.
# What it does NOT do: the D-018 gate (Ben's call before running this), the push (do that first, on Ben's word).
# PowerShell 5.1 note: never merge a native command's stderr (2>&1) under ErrorActionPreference Stop -- node's
# ExperimentalWarning on stderr would become a terminating NativeCommandError; exit codes and stdout are read instead.
param([switch]$DryRun)
$ErrorActionPreference = "Stop"
$B = "https://commonhold.randommonicle.workers.dev"

function Stop-Here($msg) { Write-Host "[STOP] $msg"; exit 1 }
# wrangler --json prints a multi-line document; PowerShell 5.1 pipes it line by line, and ConvertFrom-Json on a
# fragment yields nothing (measured on the 2026-09-19 dry run: an empty column list). Join first, then parse from the first bracket.
function Read-D1Json($lines) { $txt = ($lines | Out-String); $i = $txt.IndexOf("["); if ($i -lt 0) { Stop-Here "d1 returned no JSON: $txt" }; return ($txt.Substring($i) | ConvertFrom-Json) }

# 0. where we are
$head = (git rev-parse --short=8 HEAD).Trim()
$level = (git status -sb | Select-Object -First 1)
Write-Host "[git] HEAD $head  $level"
if ($level -notmatch "main\.\.\.origin/main$") {
  if ($DryRun) { Write-Host "[dry-run] NOT level with origin: the real run would STOP here (push first)." }
  else { Stop-Here "push first: the deploy must ship the same commit the public fork carries (R-4 / D-006)." }
}

# 1. the wave's own gates, re-run here so a stale checkout cannot deploy
Write-Host "[gate] npm run typecheck"
npm run typecheck | Out-Null; if ($LASTEXITCODE -ne 0) { Stop-Here "typecheck failed" }
Write-Host "[gate] npm test"
$t = npm test | Out-String
if ($LASTEXITCODE -ne 0 -or $t -notmatch "fail 0") { Stop-Here "the suite is not green" }
Write-Host "[gate] suite green"

# 2. live before: attest hashes (non-minting expected) and the column's absence
$attestBefore = curl.exe -s "$B/api/attest" | ConvertFrom-Json
Write-Host ("[live] before: constitution v" + $attestBefore.constitution.version + " template " + $attestBefore.constitution.template_hash.Substring(0,8) + " identity " + $attestBefore.identity_log.sealed_entries + " treasury " + $attestBefore.treasury.sealed_entries + " ballots " + $attestBefore.ballots.sealed_entries)
$colsBefore = Read-D1Json (npx wrangler d1 execute commonhold --remote --json --command "PRAGMA table_info(listings)")
$hasBefore = @($colsBefore[0].results | Where-Object { $_.name -eq "paying_since" }).Count
Write-Host ("[d1] listings columns on prod: " + (($colsBefore[0].results | ForEach-Object { $_.name }) -join ", "))
Write-Host "[d1] listings.paying_since present before: $hasBefore"
if ($DryRun) { Write-Host "[dry-run] stopping before the migration. The real run would $(if ($hasBefore -eq 0) { 'APPLY 0014' } else { 'SKIP 0014 (already present)' }), catalog-verify, then deploy."; exit 0 }

# 3. migration 0014 (idempotent guard: skip the ALTER if the column already exists, e.g. a re-run after a failed deploy step)
if (@($colsBefore[0].results).Count -lt 10) { Stop-Here "the catalog read parsed fewer than 10 listings columns; refusing to reason from a bad read" }
if ($hasBefore -eq 0) {
  Write-Host "[d1] applying migrations/0014_listing_paying_since.sql"
  npx wrangler d1 execute commonhold --remote --file "migrations/0014_listing_paying_since.sql"
  if ($LASTEXITCODE -ne 0) { Stop-Here "migration 0014 failed; nothing deployed" }
}
# catalog-verify: the column must now exist, INTEGER, nullable
$colsAfter = Read-D1Json (npx wrangler d1 execute commonhold --remote --json --command "PRAGMA table_info(listings)")
$col = @($colsAfter[0].results | Where-Object { $_.name -eq "paying_since" })
if ($col.Count -ne 1) { Stop-Here "catalog says listings.paying_since is NOT there after the migration; nothing deployed" }
if ($col[0].type -ne "INTEGER" -or $col[0].notnull -ne 0) { Stop-Here ("column shape wrong: type " + $col[0].type + " notnull " + $col[0].notnull) }
Write-Host "[d1] catalog-verified: listings.paying_since INTEGER nullable"
# rows already 'paying' (they will read as unresolved, time unavailable): report, do not touch
$payingRows = Read-D1Json (npx wrangler d1 execute commonhold --remote --json --command "SELECT id FROM listings WHERE status = 'paying'")
Write-Host ("[d1] rows already 'paying' before the worker: " + @($payingRows[0].results).Count)

# 4. deploy the worker
Write-Host "[deploy] npx wrangler deploy"
npx wrangler deploy
if ($LASTEXITCODE -ne 0) { Stop-Here "wrangler deploy failed (the migration is applied and harmless to the old worker: it never reads the column)" }

# 5. one real ride, all public GETs
$attestAfter = curl.exe -s "$B/api/attest" | ConvertFrom-Json
if ($attestAfter.constitution.template_hash -ne $attestBefore.constitution.template_hash) { Stop-Here "template_hash CHANGED: this wave was expected to be non-minting; investigate before anything else" }
Write-Host ("[ride] attest: v" + $attestAfter.constitution.version + " unchanged; identity " + $attestAfter.identity_log.status + " treasury " + $attestAfter.treasury.status + " ballots " + $attestAfter.ballots.status)
foreach ($p in @("/api/listings", "/api/listings?status=unresolved", "/api/listing/1", "/api/listing/2", "/api/official", "/api/citizens", "/api/surface")) {
  $code = curl.exe -s -o NUL -w "%{http_code}" "$B$p"
  Write-Host "[ride] $p -> $code"
  if ($code -ne "200") { Stop-Here "$p is not 200 after the deploy" }
}
$l2 = curl.exe -s "$B/api/listing/2" | ConvertFrom-Json
Write-Host ("[ride] listing 2 funder_record: " + ($l2.funder_record | ConvertTo-Json -Compress))
if ($null -eq $l2.funder_record.withdrawn_with_open_submissions -or $null -eq $l2.funder_record.unresolved) { Stop-Here "the new funder_record fields are not served" }
$l1 = curl.exe -s "$B/api/listing/1" | ConvertFrom-Json
Write-Host ("[ride] listing 1 status " + $l1.listing.status + " (expected expired: F1's live proof is that POST /api/listing/1/withdraw as commonhold-agent now answers 409; that is a citizen write, Ben's hand, optional)")
Write-Host "[done] wave deployed and ridden. Log the worker version id and these lines in HANDOVER.md."
