# Deploys two waves in ONE worker deploy: the paid-path M3 second build (drafts/BRIEF-PAID-PATH-M3-2026-10-02.md, C4 = option B by Ben's
# ruling, DECISIONS D-074 note 4 Oct; build log docs/CHECKPOINT-PAID-PATH-M3.md) and the treasury pagination (GET /treasury pages: total_entries,
# has_more, a (before_entry_date, before_id) cursor). Ben's hand only (D-017). Neither wave carries a migration and neither touches src/doc.ts:
# no D1 write, no mint. This script STOPS if either is no longer true.
# Pattern: scripts/deploy-guest-voice.ps1 (L-046, L-069: one fail-fast script). Run from society/ on main, after the merge and the push:
#   cd "C:\Users\bengr\Projects\AI domain and social network\society"
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-m3-treasury.ps1 -ExpectedCommit <sha> -DryRun   # every check, nothing remote written
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-m3-treasury.ps1 -ExpectedCommit <sha>           # the real thing
# M3 reads settlement_claims (migration 0017, M2, on prod since 1 Oct) and adds no column: step 2 reads the prod catalogue and stops if any
# column M3 names is missing, BEFORE the deploy. Every stop before "wrangler deploy" leaves the live worker exactly as it was.
# What it does NOT do: the push, the gate, any payment. The paid paths (register, patron, listing create, listing pay) are first ridden by the
# next REAL payment; the ride here is public GETs only (the new attention list, /api/official's count, the treasury page and its cursor).
# PowerShell 5.1 traps this file avoids (all seen live): $COLS and $cols are the SAME variable (one spelling per name here); -notmatch on an
# array filters instead of testing; a one-element return is wrapped in @(); "$var:" is a drive reference (write "${var}:"); never merge a
# native command's stderr under ErrorActionPreference Stop; -eq and -ne are case-INSENSITIVE (hashes are compared with -cne). ASCII only.
param(
  [Parameter(Mandatory = $true)][string]$ExpectedCommit,
  [switch]$DryRun
)
$ErrorActionPreference = "Stop"
$BASE = "https://commonhold.randommonicle.workers.dev"
$V5_HASH = "fa11788d062b0c6d23c54c428c1c9649d263ae3ba704e602e122066926049491"
# The live worker's code before this wave (main at the guest-voice deploy). Step 0 proves nothing under migrations/ or src/doc.ts moved since.
$LIVE_BASE_COMMIT = "daa0fe3b3eff7bae3e43fa861d482bd17985d272"
# The propagation poll waits for THIS route to answer 200 (only this wave serves it); step 2 proves it answers 404 first.
$NEW_CODE_URL = "$BASE/api/settlements/attention"
$SKILL_VERSION_LINE = "version: 1.1.4"
# GET /treasury page size (src/society.ts LEDGER_PAGE; the test compares them).
$LEDGER_PAGE_SIZE = 200
# The columns of settlement_claims M3 reads or writes, all from migrations/0017 (test/deploy-m3-treasury-script.test.ts proves each is in 0017).
$CLAIM_COLUMN_NAMES = @("network", "asset", "from_addr", "nonce", "route", "intent_json", "intent_hash", "rpc_body", "rpc_body_hash", "valid_before", "state", "tx", "payer", "verdict_reason", "booked_refs", "created_at", "updated_at", "lease_owner", "leased_until")
# The marker codes GET /api/settlements/attention may serve (src/settlement-attention.ts ATTENTION_MARKER_CODES; the test compares the lists).
$MARKER_CODES = @("settlement_contradiction", "chain_spent_facilitator_refused", "listing_not_paying", "registration_handle_taken", "settled_unbooked_aged", "pending_aged")
# Fields the attention list must NEVER serve (the C7 allowlist's complement): checked as JSON keys anywhere in the body.
$FORBIDDEN_KEYS = @("from_addr", "payer", "rpc_body", "intent_json", "verdict_reason", "intent_hash", "rpc_body_hash", "lease_owner")

function Stop-Here($msg) { Write-Host "[STOP] $msg"; exit 1 }
function Say($msg) { Write-Host $msg }
function Read-D1Json($lines) {
  $txt = ($lines | Out-String)
  $i = $txt.IndexOf("[")
  if ($i -lt 0) { Stop-Here "wrangler d1 returned no JSON: $txt" }
  return ($txt.Substring($i) | ConvertFrom-Json)
}
# Strict read: a failed or empty query STOPS; nothing reasons from a bad read. Read-only SQL only in this file.
function Invoke-D1Read($sql) {
  $raw = (npx wrangler d1 execute commonhold --remote --json --command $sql)
  $code = $LASTEXITCODE
  if ($code -ne 0) { Stop-Here "wrangler d1 execute failed (exit $code) for: $sql (a first read failed once on 4 Oct and passed on a re-run: re-run the script before investigating)" }
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
  if ($att.constitution.template_hash -cne $V5_HASH) { Stop-Here "template_hash is $($att.constitution.template_hash) $when, expected v5 ${V5_HASH}: investigate before anything else (this wave mints nothing)." }
  if ($att.ok -ne $true) { Stop-Here "GET /api/attest ok is '$($att.ok)' $when, expected true." }
  foreach ($chain in "identity_log", "treasury", "payouts", "ballots") {
    if ($att.$chain.ok -ne $true) { Stop-Here "chain $chain ok is '$($att.$chain.ok)' $when, expected true: investigate." }
  }
}

# 0. the commit: fetch, then main, origin/main and the expected sha must be ONE commit, on a clean tree
Say "[git] git fetch origin"
git fetch origin --quiet
if ($LASTEXITCODE -ne 0) { Stop-Here "git fetch failed; the level check below would read a stale origin/main." }
$branch = (git rev-parse --abbrev-ref HEAD).Trim()
if ($branch -ne "main") { Stop-Here "the current branch is '$branch', not main: deploy from main only." }
$headSha = (git rev-parse HEAD).Trim()
$originSha = (git rev-parse origin/main).Trim()
$mainSha = (git rev-parse main).Trim()
$ErrorActionPreference = "Continue"
$expectedSha = (git rev-parse --verify ($ExpectedCommit + "^{commit}"))
$expectedCode = $LASTEXITCODE
$ErrorActionPreference = "Stop"
if ($expectedCode -ne 0 -or -not $expectedSha) { Stop-Here "-ExpectedCommit '$ExpectedCommit' is not a commit in this repository." }
$expectedSha = ([string]$expectedSha).Trim()
if ($mainSha -ne $originSha -or $mainSha -ne $expectedSha -or $headSha -ne $expectedSha) {
  Stop-Here ("main, origin/main and -ExpectedCommit are not one commit: HEAD " + $headSha.Substring(0, 8) + ", main " + $mainSha.Substring(0, 8) + ", origin/main " + $originSha.Substring(0, 8) + ", expected " + $expectedSha.Substring(0, 8) + ". Merge, push, and pass the pushed sha.")
}
# Every git read below checks its own exit code before its output is read: a failed native command prints nothing, and nothing must not read
# as "clean" or "no change" (CODEX deploy-script r1, finding 1: an exit 128 with empty stdout passed both guards).
$dirty = @(git status --porcelain)
if ($LASTEXITCODE -ne 0) { Stop-Here "git status failed (exit $LASTEXITCODE): the clean-tree check cannot be read." }
if ($dirty.Count -gt 0) { Stop-Here ("working tree not clean (" + $dirty.Count + " paths): the deploy must ship exactly the committed tree.") }
git merge-base --is-ancestor $LIVE_BASE_COMMIT HEAD
if ($LASTEXITCODE -ne 0) { Stop-Here "HEAD does not contain $($LIVE_BASE_COMMIT.Substring(0, 8)) (the live worker's code): this deploy would drop the guest voice." }
$schemaMoves = @(git diff --name-only $LIVE_BASE_COMMIT HEAD -- migrations schema.sql src/doc.ts)
if ($LASTEXITCODE -ne 0) { Stop-Here "git diff failed (exit $LASTEXITCODE): the no-migration check cannot be read." }
if ($schemaMoves.Count -gt 0) { Stop-Here ("this wave was to carry no migration and no constitution change, but these moved since " + $LIVE_BASE_COMMIT.Substring(0, 8) + ": " + ($schemaMoves -join ", ") + ". Not this script's deploy.") }
if (-not (Test-Path "src/settlement-attention.ts")) { Stop-Here "src/settlement-attention.ts is missing: this checkout is not the M3 second build." }
if (-not (Select-String -Path "src/society.ts" -Pattern "export function parseLedgerCursor" -Quiet)) { Stop-Here "src/society.ts has no parseLedgerCursor: this checkout is not the treasury pagination." }
if (-not (Select-String -Path "src/guest.ts" -Pattern "export async function postGuestComment" -Quiet)) { Stop-Here "src/guest.ts has no postGuestComment: this checkout would drop the guest voice." }
Say ("[git] HEAD " + $headSha.Substring(0, 8) + " = main = origin/main = -ExpectedCommit; tree clean; contains " + $LIVE_BASE_COMMIT.Substring(0, 8) + "; no migration, schema or doc.ts change since")

# 1. the waves' own gates, re-run here so a stale checkout cannot deploy
$ErrorActionPreference = "Continue"
$testOut = (npm test 2>&1 | Out-String)
$testCode = $LASTEXITCODE
$tscOut = (npm run typecheck 2>&1 | Out-String)
$tscCode = $LASTEXITCODE
$ErrorActionPreference = "Stop"
$summary = [regex]::Matches($testOut, '(?m)^(?:\S+[ \t]+)?tests (\d+)[ \t]*\r?\n(?:\S+[ \t]+)?suites (\d+)[ \t]*\r?\n(?:\S+[ \t]+)?pass (\d+)[ \t]*\r?\n(?:\S+[ \t]+)?fail (\d+)[ \t]*\r?$')
$pass = ""
$fail = ""
if ($summary.Count -gt 0) { $pass = $summary[$summary.Count - 1].Groups[3].Value; $fail = $summary[$summary.Count - 1].Groups[4].Value }
if ($testCode -ne 0 -or $fail -ne "0" -or -not $pass) { Stop-Here "npm test: exit $testCode, pass '$pass', fail '$fail'." }
if ($tscCode -ne 0) { Stop-Here "typecheck failed: $tscOut" }
Say "[tests] pass $pass, fail 0; typecheck clean"

# 2. live, before: non-minting baseline, the new route ABSENT (so the propagation poll proves something), the prod catalogue M3 needs
$attBefore = Read-Attest "before the deploy"
Assert-Attest $attBefore "before the deploy"
Say ("[live] before: v5 " + $V5_HASH.Substring(0, 8) + "; all four chains ok; identity " + $attBefore.identity_log.sealed_entries + ", treasury " + $attBefore.treasury.sealed_entries + ", ballots " + $attBefore.ballots.sealed_entries)
$routeBefore = Get-Text $NEW_CODE_URL 20
if ($routeBefore.Code -eq "200") { Stop-Here "GET $NEW_CODE_URL already answers 200: this wave looks already deployed. Verify by hand; this script cannot prove a propagation it did not wait for." }
if ($routeBefore.Code -ne "404") { Stop-Here "GET $NEW_CODE_URL answered $($routeBefore.Code) before the deploy, expected 404 (a route only this wave serves): investigate." }
Say "[live] before: GET /api/settlements/attention answers 404 (the new code is absent)"
$claimInfo = @(Invoke-D1Read "SELECT name FROM pragma_table_info('settlement_claims') ORDER BY cid")
$claimHave = @($claimInfo | ForEach-Object { [string]$_.name })
if ($claimHave.Count -lt 1) { Stop-Here "settlement_claims is not on prod (migration 0017, M2): M3 cannot run without it. Nothing was changed." }
$claimMissing = @($CLAIM_COLUMN_NAMES | Where-Object { $claimHave -notcontains $_ })
if ($claimMissing.Count -gt 0) { Stop-Here ("settlement_claims on prod lacks columns M3 reads: " + ($claimMissing -join ", ") + ". Nothing was changed.") }
$stateRows = @(Invoke-D1Read "SELECT state, COUNT(*) AS n FROM settlement_claims GROUP BY state ORDER BY state")
$stateLine = (@($stateRows | ForEach-Object { "$($_.state) $($_.n)" }) -join ", ")
if (-not $stateLine) { $stateLine = "no rows" }
Say ("[d1] settlement_claims carries all " + $CLAIM_COLUMN_NAMES.Count + " columns M3 reads; rows by state before: " + $stateLine)
$guestDueBefore = Get-Text "$BASE/api/guest/due" 20
if ($guestDueBefore.Code -ne "200") { Stop-Here "GET /api/guest/due answered $($guestDueBefore.Code) before the deploy, expected 200 (the guest voice is live): investigate first." }

if ($DryRun) {
  Say "[dry-run] would now: run npx wrangler deploy and capture its version id; poll GET /api/settlements/attention until 200; re-check attest (v5, template $($V5_HASH.Substring(0, 8)), every chain ok); ride the public reads (incl. /api/guest/due), the attention list (allowlisted markers, no forbidden key, total >= count), /api/official economy.settlements_awaiting_a_person = the list's total, GET /treasury's page contract (total_entries = the treasury chain's rows) and its cursor (one valid page, one refused half-cursor). Nothing remote was written."
  exit 0
}

# 3. deploy the worker, capturing its version id (a deploy whose id cannot be read is a stop: it cannot be tied to this commit)
Say "[deploy] npx wrangler deploy (commit $($headSha.Substring(0, 8)))"
$ErrorActionPreference = "Continue"
$deployOut = (npx wrangler deploy 2>&1 | Out-String)
$deployCode = $LASTEXITCODE
$ErrorActionPreference = "Stop"
if ($deployCode -ne 0) { Stop-Here "wrangler deploy failed (exit $deployCode); nothing else was changed (no migration in this wave). Output: $deployOut" }
$versionId = [regex]::Match($deployOut, 'Current Version ID:\s*([0-9a-fA-F-]{36})').Groups[1].Value
if (-not $versionId) { Stop-Here "wrangler deploy exited 0 but printed no 'Current Version ID'; the deploy may have succeeded. Check 'npx wrangler deployments list' by hand before anything else." }
Say "[deploy] worker version id $versionId (commit $($headSha.Substring(0, 8)))"
$ROLLBACK_LINE = "ROLL BACK THE WORKER (npx wrangler rollback, to the version before $versionId; check npx wrangler deployments list first). No migration to undo."

# 3b. propagation: wrangler returns once propagation STARTS. Wait for the new route (404 before, so this proves it), 12 x 5 s.
$live = $false
for ($i = 0; $i -lt 12; $i++) {
  $poll = Get-Text $NEW_CODE_URL 30
  if ($poll.Code -eq "200") { $live = $true; break }
  if ($poll.Code -eq "500") { Stop-Here "GET /api/settlements/attention answered 500 on the new worker (version $versionId): its query fails on prod D1. $ROLLBACK_LINE" }
  Start-Sleep -Seconds 5
}
if (-not $live) { Stop-Here "deployed (version $versionId), but GET /api/settlements/attention has not answered 200 after 60 s; check by hand." }
Say "[deploy] GET /api/settlements/attention answers 200 (version $versionId)"

# 4. the ride: non-minting and the chains, then the public reads, then this wave's own reads
$attAfter = Read-Attest "after the deploy"
Assert-Attest $attAfter "after the deploy"
Say ("[ride] attest: v5 " + $V5_HASH.Substring(0, 8) + " unchanged; every chain ok; identity " + $attAfter.identity_log.sealed_entries + ", treasury " + $attAfter.treasury.sealed_entries + ", ballots " + $attAfter.ballots.sealed_entries)
$bad = @()
foreach ($p in "/", "/api/official", "/llms.txt", "/skill.md", "/heartbeat.md", "/openapi.json", "/treasury", "/api/listings", "/api/listings/payments", "/api/stats", "/api/topics", "/api/guest/due", "/api/citizens") {
  $r = Get-Text "$BASE$p" 30
  if ($r.Code -ne "200") { $bad += "$p=$($r.Code)" }
}
if ($bad.Count -gt 0) { Stop-Here ("non-200 after the deploy (version $versionId): " + ($bad -join ", ") + ". If a read that answered before now fails: $ROLLBACK_LINE") }
Say "[ride] 13 public reads -> 200 (incl. /api/guest/due, /api/listings/payments, /api/citizens)"
$skill = Get-Text "$BASE/skill.md" 30
if (-not $skill.Body.Contains($SKILL_VERSION_LINE)) { Stop-Here "GET /skill.md does not carry '$SKILL_VERSION_LINE'." }

# 4a. the attention list: shape, allowlisted markers only, no forbidden key anywhere in the body
$attnRaw = Get-Text $NEW_CODE_URL 30
if ($attnRaw.Code -ne "200") { Stop-Here "GET /api/settlements/attention -> $($attnRaw.Code) on the ride (it answered 200 on the poll)." }
$attn = $null
try { $attn = ($attnRaw.Body | ConvertFrom-Json) } catch { Stop-Here "GET /api/settlements/attention did not return JSON." }
foreach ($field in "count", "total", "has_more", "entries", "markers", "limit") {
  if (-not ($attn.PSObject.Properties.Name -contains $field)) { Stop-Here "GET /api/settlements/attention has no '$field' field." }
}
foreach ($key in $FORBIDDEN_KEYS) {
  if ($attnRaw.Body.Contains('"' + $key + '"')) { Stop-Here "GET /api/settlements/attention serves the key '$key' (C7 forbids it). $ROLLBACK_LINE" }
}
$attnEntries = @($attn.entries)
if ([int64]$attn.count -ne $attnEntries.Count) { Stop-Here ("the attention list's count is " + $attn.count + " but it carries " + $attnEntries.Count + " entries.") }
if ([int64]$attn.total -lt [int64]$attn.count) { Stop-Here ("the attention list's total (" + $attn.total + ") is below its count (" + $attn.count + ").") }
$offMarkers = @($attnEntries | Where-Object { $MARKER_CODES -notcontains [string]$_.marker } | ForEach-Object { [string]$_.marker })
if ($offMarkers.Count -gt 0) { Stop-Here ("the attention list serves markers outside the allowlist: " + ($offMarkers -join ", ")) }
Say ("[ride] GET /api/settlements/attention: count " + $attn.count + ", total " + $attn.total + ", has_more " + $attn.has_more + "; markers allowlisted; none of " + $FORBIDDEN_KEYS.Count + " forbidden keys served")
if ([int64]$attn.total -gt 0) { Say ("[note] " + $attn.total + " settlement claim(s) await a person: read the list and the claims by hand after this ride (the first real reading of the queue).") }

# 4b. /api/official's count equals the list's total (two reads, so a claim moving between them is possible: re-read before calling it a defect)
$official = Get-Json "$BASE/api/official"
if ($null -eq $official.economy -or -not ($official.economy.PSObject.Properties.Name -contains "settlements_awaiting_a_person")) { Stop-Here "GET /api/official economy has no settlements_awaiting_a_person." }
if ([int64]$official.economy.settlements_awaiting_a_person -ne [int64]$attn.total) { Stop-Here ("/api/official economy.settlements_awaiting_a_person is " + $official.economy.settlements_awaiting_a_person + " but the list's total is " + $attn.total + ": re-read both by hand (a claim may have moved between the reads) before calling it a defect.") }
Say ("[ride] /api/official economy.settlements_awaiting_a_person " + $official.economy.settlements_awaiting_a_person + " = the list's total; settlements_attention " + $official.economy.settlements_attention)

# 4c. the treasury page contract and its cursor
$tre = Get-Json "$BASE/treasury"
foreach ($field in "total_entries", "returned", "page_size", "has_more", "entries") {
  if (-not ($tre.PSObject.Properties.Name -contains $field)) { Stop-Here "GET /treasury has no '$field' field: the treasury pagination is not live." }
}
$treEntries = @($tre.entries)
# The page contract, checked as a contract (CODEX deploy-script r1, finding 2: field presence alone accepted an empty page with has_more true).
# Each mismatch STOPS before [done]: the worker is deployed by then, so the stop says the ride is not complete, not that the deploy failed.
$treStop = "the deploy is done (version $versionId) but this ride is not: re-read GET /treasury and GET /api/attest by hand"
if ([int64]$tre.page_size -ne $LEDGER_PAGE_SIZE) { Stop-Here ("GET /treasury page_size is " + $tre.page_size + ", expected " + $LEDGER_PAGE_SIZE + "; " + $treStop) }
if (-not ($tre.has_more -is [bool])) { Stop-Here ("GET /treasury has_more is not a boolean (" + $tre.has_more + "); " + $treStop) }
if ([int64]$tre.returned -ne $treEntries.Count) { Stop-Here ("GET /treasury returned is " + $tre.returned + " but it carries " + $treEntries.Count + " entries; " + $treStop) }
if ([int64]$tre.total_entries -ne [int64]$attAfter.treasury.total_rows) { Stop-Here ("GET /treasury total_entries " + $tre.total_entries + " differs from the treasury chain total_rows " + $attAfter.treasury.total_rows + " read a moment earlier (a ledger write between the reads would explain it); " + $treStop) }
$wantReturned = [Math]::Min([int64]$tre.total_entries, [int64]$LEDGER_PAGE_SIZE)
if ($treEntries.Count -ne $wantReturned) { Stop-Here ("GET /treasury carries " + $treEntries.Count + " entries; with total_entries " + $tre.total_entries + " and page_size " + $LEDGER_PAGE_SIZE + " the first page must carry " + $wantReturned + "; " + $treStop) }
$wantMore = ([int64]$tre.total_entries -gt [int64]$LEDGER_PAGE_SIZE)
if ($tre.has_more -ne $wantMore) { Stop-Here ("GET /treasury has_more is " + $tre.has_more + ", expected " + $wantMore + " for total_entries " + $tre.total_entries + "; " + $treStop) }
$treNames = $tre.PSObject.Properties.Name
if ($wantMore) {
  $lastEntry = $treEntries[$treEntries.Count - 1]
  if ([string]$tre.next_before_entry_date -cne [string]$lastEntry.entry_date -or [string]$tre.next_before_id -cne [string]$lastEntry.id) { Stop-Here ("GET /treasury continuation (" + $tre.next_before_entry_date + " / " + $tre.next_before_id + ") is not the last entry served (" + $lastEntry.entry_date + " / " + $lastEntry.id + "); " + $treStop) }
} elseif (($treNames -contains "next_before_entry_date") -or ($treNames -contains "next_before_id")) { Stop-Here ("GET /treasury serves a continuation cursor with has_more false; " + $treStop) }
Say ("[ride] GET /treasury: total_entries " + $tre.total_entries + " = the treasury chain rows; returned " + $tre.returned + ", page_size " + $tre.page_size + ", has_more " + $tre.has_more + "; continuation consistent")
if ($treEntries.Count -lt 2) { Stop-Here ("the ledger serves fewer than two entries, so the cursor cannot be ridden (prod had 18 on 4 Oct 2026); " + $treStop) }
$first = $treEntries[0]
$page2 = Get-Json ("$BASE/treasury?before_entry_date=" + $first.entry_date + "&before_id=" + $first.id)
$page2Entries = @($page2.entries)
$wantPage2 = [Math]::Min([int64]$tre.total_entries - 1, [int64]$LEDGER_PAGE_SIZE)
if ($page2Entries.Count -ne $wantPage2) { Stop-Here ("GET /treasury with a cursor at the newest entry returned " + $page2Entries.Count + " entries, expected " + $wantPage2 + " (every other entry is strictly older): the cursor path is broken.") }
$notOlder = @($page2Entries | Where-Object { [string]$_.entry_date -gt [string]$first.entry_date -or ([string]$_.entry_date -eq [string]$first.entry_date -and [int64]$_.id -ge [int64]$first.id) })
if ($notOlder.Count -gt 0) { Stop-Here "GET /treasury with a cursor returned an entry not strictly older than the cursor." }
Say ("[ride] GET /treasury cursor (before the newest entry, " + $first.entry_date + " / " + $first.id + ") -> " + $page2Entries.Count + " entries, all strictly older")
$half = Get-Text "$BASE/treasury?before_id=1" 20
if ($half.Code -ne "400") { Stop-Here "GET /treasury with only before_id answered $($half.Code), expected 400 (the cursor's two halves go together)." }
Say "[ride] GET /treasury with half a cursor -> 400"

Say "[note] The paid paths (register, patron, listing create, listing pay) and the reconciler are first ridden by the NEXT REAL PAYMENT and the next 06:00 UTC run. After that payment: its settlement_claims row is 'booked' (SELECT state, tx FROM settlement_claims ORDER BY updated_at DESC LIMIT 1) and GET /api/settlements/attention does not list it. Do not declare the paid path ridden before then."
Say "[done] M3 + treasury pagination deployed and ridden (public reads only). Log version id $versionId, commit $($headSha.Substring(0, 8)) and these lines in HANDOVER.md."
