# ONE fail-fast deploy script for the standing-topics wave (D-070, branch standing-topics-2026-09-20), per L-046:
# read the WHOLE posts catalogue, apply migration 0015 only from a clean pre-0015 state, catalog-verify all four objects,
# and deploy the worker ONLY then. Ben's hand only (D-017). Run from society/ on main after the merge and push:
#   powershell -ExecutionPolicy Bypass -File ".\scripts\deploy-standing-topics.ps1" -DryRun   # reads only: gates, attest, the catalogue; exits before the migration
#   powershell -ExecutionPolicy Bypass -File ".\scripts\deploy-standing-topics.ps1"           # the real thing
# Then open the five topics: node scripts/open-topic.mjs --file ../drafts/topics/<n>.txt --execute (five runs, in order).
# What it does NOT do: the D-018 gate (Ben's call), the push (first, on Ben's word), the topic openings.
# PRE-STEP, Ben's hand, BEFORE the first `open-topic.mjs --execute` (the one real ride whose failure has no repair):
# the chained-row gate relies on SQLite's changes() inside env.DB.batch([...]). Prove it through the Worker API on MANAGED D1
# (CODEX build review r2: `wrangler d1 execute --file` is a different path), against the SCRATCH database commonhold-migtest,
# never prod. The probe worker creates two namespaced tables WITHOUT "IF NOT EXISTS" (a collision fails the run) and drops them:
#   npx wrangler dev --remote --config "scripts/changes-probe-worker/wrangler.jsonc"    # leave running; in a second shell:
#   curl.exe -s http://127.0.0.1:8787/run                                                # expect "pass":true ([1,1] [0,0] [1,0,0] [1,1,1])
# Then stop the dev server (Ctrl+C). If the answer is not "pass":true, do NOT open a topic: a gate that fails on the winner
# leaves a topic with no chained row.
# PowerShell 5.1: never merge a native command's stderr under ErrorActionPreference Stop; read exit codes and stdout.
param([switch]$DryRun)
$ErrorActionPreference = "Stop"
$B = "https://commonhold.randommonicle.workers.dev"
$COLS = @("kind", "topic_state", "topic_closed_at")
$INDEX = "idx_posts_kind"

function Stop-Here($msg) { Write-Host "[STOP] $msg"; exit 1 }
function Read-D1Json($lines) { $txt = ($lines | Out-String); $i = $txt.IndexOf("["); if ($i -lt 0) { Stop-Here "d1 returned no JSON: $txt" }; return ($txt.Substring($i) | ConvertFrom-Json) }
function Read-Catalogue() {
  $cols = Read-D1Json (npx wrangler d1 execute commonhold --remote --json --command "PRAGMA table_info(posts)")
  $idx = Read-D1Json (npx wrangler d1 execute commonhold --remote --json --command "PRAGMA index_list(posts)")
  $colRows = @($cols[0].results); $idxNames = @($idx[0].results | ForEach-Object { $_.name })
  if ($colRows.Count -lt 9) { Stop-Here "the catalogue read parsed fewer than 9 posts columns; refusing to reason from a bad read" }
  $present = @($COLS | Where-Object { $c = $_; @($colRows | Where-Object { $_.name -eq $c }).Count -eq 1 })
  return @{ cols = $colRows; colsPresent = $present; indexPresent = ($idxNames -contains $INDEX); idxNames = $idxNames }
}

# 0. where we are
$head = (git rev-parse --short=8 HEAD).Trim()
$level = (git status -sb | Select-Object -First 1)
Write-Host "[git] HEAD $head  $level"
if ($level -notmatch "main\.\.\.origin/main$") {
  if ($DryRun) { Write-Host "[dry-run] NOT level with origin: the real run would STOP here (merge to main and push first)." }
  else { Stop-Here "push first: the deploy must ship the same commit the public fork carries (R-4 / D-006)." }
}

# 1. the wave's own gates, re-run here so a stale checkout cannot deploy
Write-Host "[gate] npm run typecheck"
npm run typecheck | Out-Null; if ($LASTEXITCODE -ne 0) { Stop-Here "typecheck failed" }
Write-Host "[gate] npm test"
$t = npm test | Out-String
if ($LASTEXITCODE -ne 0 -or $t -notmatch "fail 0") { Stop-Here "the suite is not green" }
Write-Host "[gate] suite green"

# 2. live before: attest (non-minting expected) and the full catalogue
$attestBefore = curl.exe -s "$B/api/attest" | ConvertFrom-Json
Write-Host ("[live] before: constitution v" + $attestBefore.constitution.version + " template " + $attestBefore.constitution.template_hash.Substring(0,8) + " identity " + $attestBefore.identity_log.sealed_entries + " treasury " + $attestBefore.treasury.sealed_entries + " ballots " + $attestBefore.ballots.sealed_entries)
$before = Read-Catalogue
Write-Host ("[d1] posts columns on prod: " + (($before.cols | ForEach-Object { $_.name }) -join ", "))
Write-Host ("[d1] 0015 objects present before: columns " + $before.colsPresent.Count + "/3, index " + $before.indexPresent)
$clean = ($before.colsPresent.Count -eq 0 -and -not $before.indexPresent)
$complete = ($before.colsPresent.Count -eq 3 -and $before.indexPresent)
if (-not $clean -and -not $complete) { Stop-Here "PARTIAL 0015 state on prod (columns $($before.colsPresent -join ',') index $($before.indexPresent)); repair by hand before anything deploys" }
if ($DryRun) { Write-Host "[dry-run] stopping before the migration. The real run would $(if ($clean) { 'APPLY 0015' } else { 'SKIP 0015 (already complete)' }), catalog-verify, then deploy."; exit 0 }

# 3. migration 0015 from a clean state only (D1 has no IF NOT EXISTS for ADD COLUMN: a re-run on a complete state is skipped, never re-applied)
if ($clean) {
  Write-Host "[d1] applying migrations/0015_standing_topics.sql"
  npx wrangler d1 execute commonhold --remote --file "migrations/0015_standing_topics.sql"
  if ($LASTEXITCODE -ne 0) { Stop-Here "migration 0015 failed; nothing deployed; re-read the catalogue before retrying (a partial apply must be repaired by hand)" }
}
$after = Read-Catalogue
if ($after.colsPresent.Count -ne 3 -or -not $after.indexPresent) { Stop-Here "catalogue after the migration is not complete (columns $($after.colsPresent -join ',') index $($after.indexPresent)); nothing deployed" }
$kind = @($after.cols | Where-Object { $_.name -eq "kind" })[0]
if ($kind.type -ne "TEXT" -or $kind.notnull -ne 1 -or $kind.dflt_value -ne "'post'") { Stop-Here ("posts.kind shape wrong: type " + $kind.type + " notnull " + $kind.notnull + " default " + $kind.dflt_value) }
$existing = Read-D1Json (npx wrangler d1 execute commonhold --remote --json --command "SELECT COUNT(*) AS n FROM posts WHERE kind != 'post'")
if (@($existing[0].results)[0].n -ne 0) { Stop-Here "posts rows with kind != 'post' exist before any topic was opened; investigate" }
Write-Host "[d1] catalog-verified: kind TEXT NOT NULL DEFAULT 'post', topic_state, topic_closed_at, idx_posts_kind; every existing row is an ordinary post"

# 4. deploy the worker
Write-Host "[deploy] npx wrangler deploy"
npx wrangler deploy
if ($LASTEXITCODE -ne 0) { Stop-Here "wrangler deploy failed (the migration is applied and harmless to the old worker: it never reads the columns)" }

# 5. one real ride, all public GETs
$attestAfter = curl.exe -s "$B/api/attest" | ConvertFrom-Json
if ($attestAfter.constitution.template_hash -ne $attestBefore.constitution.template_hash) { Stop-Here "template_hash CHANGED: this wave was expected to be non-minting; investigate before anything else" }
Write-Host ("[ride] attest: v" + $attestAfter.constitution.version + " unchanged; identity " + $attestAfter.identity_log.status + " treasury " + $attestAfter.treasury.status + " ballots " + $attestAfter.ballots.status)
foreach ($p in @("/api/topics", "/api/front", "/api/new", "/api/changes?since=0", "/api/post/11", "/api/official", "/api/stats", "/treasury", "/api/surface", "/llms.txt", "/openapi.json", "/")) {
  $code = curl.exe -s -o NUL -w "%{http_code}" "$B$p"
  Write-Host "[ride] $p -> $code"
  if ($code -ne "200") { Stop-Here "$p is not 200 after the deploy" }
}
$topics = curl.exe -s "$B/api/topics" | ConvertFrom-Json
Write-Host ("[ride] /api/topics: open_now " + $topics.rules.open_now + " opened_ever " + $topics.rules.opened_ever + " seeding " + $topics.rules.seeding)
if ($topics.rules.open_now -ne 0 -or $topics.rules.opened_ever -ne 0) { Stop-Here "expected zero topics before the first opening" }
$official = curl.exe -s "$B/api/official" | ConvertFrom-Json
if ($null -eq $official.topics -or $official.topics.cap -ne 5) { Stop-Here "officialFacts.topics is not served" }
$door = curl.exe -s "$B/"
if ($door -notmatch "STANDING TOPICS") { Stop-Here "the topics door note is not on GET /" }
$front = curl.exe -s "$B/api/front" | ConvertFrom-Json
if ($null -eq $front.topics) { Stop-Here "/api/front has no topics block" }
Write-Host "[done] wave deployed and ridden (zero topics open). Next: node scripts/open-topic.mjs --file ../drafts/topics/<n>.txt --execute, five times, then verify GET /api/topics and the five moderation rows. Log the worker version id and these lines in HANDOVER.md."
