# Deploys OPTION B in ONE worker deploy: a FIRST-attempt rule-7 refusal no longer writes `refused`; the claim stays `pending` until the chain's own expiry proof
# (Ben's ruling 5 Oct 2026, DECISIONS D-074; docs/BRIEF-REFUSED-CHAIN-RECHECK.md; build log docs/CHECKPOINT-REFUSED-OPTION-B.md). MONEY PATH. Ben's hand only (D-017).
# The D-018 Opus gate (docs/REVIEW-REFUSED-OPTION-B-GATE-2026-10-06.md) returned DEPLOYABLE WITH CONDITIONS; this script carries its pre-deploy conditions:
#   C1  the reconciler's new UNION ALL selection, run read-only against prod D1 (D1's acceptance is unproven locally, L-016): a count must come back.
#   C2  the two recorded checks: settlement_claims by state (nothing outside the five states the code knows), and the anti-join of 'paying' listings
#       against the claims that own them (below). A non-empty anti-join STOPS the deploy.
# C3 (the gate's hub-side test and comment work) is already merged. C4 (open no new listing until the gate's M1 or DEFERRED-PAY-LISTING-RESEND-REPLAY is fixed) is Ben's,
# and stands after this deploy: D-074 S1 already keeps listings closed.
# NON-MINTING, NO MIGRATION: option B changes four files under src/ (listings, settlement-claims, settlement-reconcile, x402) and scripts/pay-listing.mjs, and nothing in
# migrations/, schema.sql or src/doc.ts. This script STOPS if any of those three moved since the live worker's code (7a1432a9), and after the deploy it STOPS if the
# constitution is not still v5 with its template hash. Every stop before "wrangler deploy" leaves the live worker exactly as it was.
# Pattern: scripts/deploy-m3-treasury.ps1 (L-046, L-069: one fail-fast script). Run from society/ on main, after the merge and the push:
#   cd "C:\Users\bengr\Projects\AI domain and social network\society"
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-refused-option-b.ps1 -ExpectedCommit <sha> -DryRun   # every check and the read-only prod queries, nothing deployed
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-refused-option-b.ps1 -ExpectedCommit <sha>           # the real thing
# <sha> is the pushed tip of main (git -C society rev-parse HEAD). -DryRun is NOT offline: it runs git fetch, npm test, typecheck, public GETs and three read-only
# `wrangler d1 execute --remote` SELECTs against prod. Nothing it runs writes.
# What it does NOT do: the push, the gate, any payment, any migration. THE ONE REAL RIDE of this change is the next real refused payment, and it CANNOT be staged:
# a rule-7 refusal comes from the facilitator, not from anything Ben can safely cause. After one: the claim stays `pending` with the facilitator's words as its
# verdict_reason (SELECT state, verdict_reason FROM settlement_claims ORDER BY updated_at DESC LIMIT 1), the answer carried facilitator_refused and recheck_after and no `accepts`,
# and the listing (if listing_pay) stays `paying`. Do not declare option B ridden before then.
# PROPAGATION, stated plainly: NO public GET serves any text this wave changed. The diff 8e5d2782..f0431b66 touches POST answers only (402, 502, 409, 500 bodies), the
# reconciler's scheduled selection, and settlementField's sentence for a 'paying' listing, which GET /api/listing/:id serves only while a listing is 'paying' (prod
# has none and C2b is about exactly that). /openapi.json, /skill.md, /llms.txt, /heartbeat.md and GET / are untouched. So there is nothing to poll for, and the
# reads after the deploy cannot tell the new worker from the old one: they show only that nothing broke. The evidence of the deploy is wrangler's own version id,
# which this script prints and refuses to continue without. A fixed 20 s wait precedes the reads; it is not a proof of propagation.
# Windows seam (checked by hand with a stand-in for npx.cmd that prints its argv as JSON, 6 Oct 2026): the C1 text carries `<=`, `<>` and `$.` and reaches wrangler
# as ONE argument, byte-identical, because PowerShell 5.1 wraps an argument that has spaces in double quotes, the SQL has no double quote, `%` or `^`, and cmd.exe
# leaves `<` and `>` inside quotes alone. The first live use of this seam with that text is the dry run: if wrangler reports a syntax error, STOP and re-run once.
# PowerShell 5.1 traps this file avoids (all seen live): $COLS and $cols are the SAME variable (one spelling per name here); -notmatch on an
# array filters instead of testing; a one-element return is wrapped in @(); "$var:" is a drive reference (write "${var}:"); never merge a
# native command's stderr under ErrorActionPreference Stop; -eq and -ne are case-INSENSITIVE (hashes and state names are compared with -cne / -cnotcontains). ASCII only.
param(
  [Parameter(Mandatory = $true)][string]$ExpectedCommit,
  [switch]$DryRun
)
$ErrorActionPreference = "Stop"
$BASE = "https://commonhold.randommonicle.workers.dev"
# The attested constitution this wave must leave untouched (test/deploy-refused-option-b-script.test.ts compares it with computeLiveConstitutionPair's hash).
$V5_HASH = "fa11788d062b0c6d23c54c428c1c9649d263ae3ba704e602e122066926049491"
# The live worker's code before this wave (the M3 + treasury deploy of 4 Oct, docs on top). Step 0 proves nothing under migrations/ or src/doc.ts moved since.
$LIVE_BASE_COMMIT = "7a1432a92a91e5dde45ceb898501f4063bcff2f9"
$ATTENTION_URL = "$BASE/api/settlements/attention"
# The five states migrations/0017's CHECK allows and ClaimState names (the test compares all three). Any other state on prod STOPS the deploy.
$CLAIM_STATES = @("pending", "settled_unbooked", "booked", "refused", "expired")
# The constants the reconciler's selection is built from (src/settlement-reconcile.ts RECONCILE_BATCH_ROWS; src/settlement-attention.ts CLAIM_HANDLE_TAKEN,
# CLAIM_LISTING_NOT_PAYING, CHAIN_SPENT_MARKER). The test proves the statement built below equals the one the reconciler runs, with these as its binds.
$RECONCILE_BATCH_ROWS = 2
$CLAIM_HANDLE_TAKEN = "handle_taken"
$CLAIM_LISTING_NOT_PAYING = "listing_not_paying"
$CHAIN_SPENT_MARKER = "chain_spent_facilitator_refused:"
# The reconciler binds `now` for its lease filter; C1 binds a far-future instant instead (the gate's own text), so no lease can hide a row from the count.
$C1_NOW_SENTINEL = "9999999999999"

function Stop-Here($msg) { Write-Host "[STOP] $msg"; exit 1 }
function Say($msg) { Write-Host $msg }
function Compress-Sql($sql) { return ([regex]::Replace([string]$sql, '\s+', ' ')).Trim() }

# C1: the reconciler's selection (runReconciler's ELIGIBLE fragment twice inside two LIMITed subqueries joined by UNION ALL), whitespace-collapsed, wrapped in a count.
$C1_ELIGIBLE_TEMPLATE = @'
(leased_until IS NULL OR leased_until <= @NOW@)
 AND (verdict_reason IS NULL OR verdict_reason NOT IN ('@HANDLE_TAKEN@', '@LISTING_NOT_PAYING@'))
 AND (verdict_reason IS NULL OR substr(verdict_reason, 1, @MARKER_LENGTH@) <> '@MARKER@')
'@
$C1_TEMPLATE = @'
SELECT COUNT(*) AS n FROM (SELECT * FROM (SELECT * FROM settlement_claims WHERE state = 'settled_unbooked' AND @ELIGIBLE@
 AND NOT (route = 'register' AND json_extract(intent_json, '$.public_key') IS NULL)
 ORDER BY updated_at ASC, created_at ASC LIMIT @LIMIT@)
 UNION ALL
 SELECT * FROM (SELECT * FROM settlement_claims WHERE state = 'pending' AND @ELIGIBLE@
 ORDER BY updated_at ASC, created_at ASC LIMIT @LIMIT@))
'@
$C1_ELIGIBLE = $C1_ELIGIBLE_TEMPLATE.Replace("@NOW@", $C1_NOW_SENTINEL).Replace("@HANDLE_TAKEN@", $CLAIM_HANDLE_TAKEN).Replace("@LISTING_NOT_PAYING@", $CLAIM_LISTING_NOT_PAYING).Replace("@MARKER_LENGTH@", "$($CHAIN_SPENT_MARKER.Length)").Replace("@MARKER@", $CHAIN_SPENT_MARKER)
$C1_SQL = Compress-Sql ($C1_TEMPLATE.Replace("@ELIGIBLE@", $C1_ELIGIBLE).Replace("@LIMIT@", "$RECONCILE_BATCH_ROWS"))

# C2a: the claims by state.
$C2A_SQL = "SELECT state, COUNT(*) AS n FROM settlement_claims GROUP BY state ORDER BY state"

# C2b: the anti-join. DEFINITION. A listing is 'paying' while a payment for it is being settled, and the ONLY things that can release it, book it or set it aside are the
# listing_pay claim that OWNS its reservation, worked by the reconciler (listingReleaseStatement, listingReservationState and the booking INSERT all test the one fragment
# RESERVATION_BOUND, src/settlement-claims.ts). A claim OWNS a 'paying' listing when, reading its intent (intentOf: listing_id, wallet_row_id, wallet_row_hash):
#   it is a listing_pay claim the reconciler can still select (pending or settled_unbooked), for THIS listing, and RESERVATION_BOUND holds with the claim's own pin:
#   the listing is 'paying' and unpaid, paying_wallet_row_id and paying_wallet_row_hash are the claim's wallet_row_id and wallet_row_hash, and paying_since is set and not later
#   than the claim's created_at (a later one is another payer's reservation, taken after a release).
# The query lists every 'paying' listing NO claim owns, including a listing reserved before migration 0014 (paying_since NULL: no claim, ever). settlementField's dated arm tells
# such a listing's funder that the society's reconciler will resolve it, and for a listing with no owning claim that is false (DEFERRED-DATED-PAYING-NO-CLAIM, listings.ts).
# STRICTER than "no claim carries this listing_id", on purpose: a listing held under another payer's pin, or by a claim already terminal, is as stranded as one with no claim.
$C2B_TEMPLATE = @'
SELECT l.id AS id, l.paying_since AS paying_since FROM listings l
 WHERE l.status = 'paying'
 AND NOT EXISTS (SELECT 1 FROM settlement_claims c
 WHERE c.route = 'listing_pay' AND c.state IN ('pending', 'settled_unbooked')
 AND json_extract(c.intent_json, '$.listing_id') = l.id
 AND l.status = 'paying' AND l.paid_submission_id IS NULL
 AND l.paying_wallet_row_id = json_extract(c.intent_json, '$.wallet_row_id')
 AND l.paying_wallet_row_hash = json_extract(c.intent_json, '$.wallet_row_hash')
 AND l.paying_since IS NOT NULL AND l.paying_since <= c.created_at)
 ORDER BY l.id
'@
$C2B_SQL = Compress-Sql $C2B_TEMPLATE

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
function Format-PayingSince($ms) {
  if ($null -eq $ms) { return "undated: reserved before migration 0014" }
  return ([DateTimeOffset]::FromUnixTimeMilliseconds([int64]$ms).UtcDateTime.ToString("u"))
}
function Test-Number($v) { return ($v -is [int] -or $v -is [long] -or $v -is [decimal] -or $v -is [double]) }
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
# Reads GET /api/settlements/attention and /api/official and requires the list's total to be a number equal to economy.settlements_awaiting_a_person
# (two reads, so a claim moving between them is possible: re-read before calling it a defect). Returns the total.
function Read-AttentionAndOfficial($when) {
  $attn = Get-Json $ATTENTION_URL
  foreach ($field in "count", "total", "has_more", "entries", "markers", "limit") {
    if (-not ($attn.PSObject.Properties.Name -contains $field)) { Stop-Here "GET /api/settlements/attention has no '$field' field $when." }
  }
  if (-not (Test-Number $attn.total)) { Stop-Here "GET /api/settlements/attention total is not a number $when ('$($attn.total)')." }
  $official = Get-Json "$BASE/api/official"
  if ($null -eq $official.economy -or -not ($official.economy.PSObject.Properties.Name -contains "settlements_awaiting_a_person")) { Stop-Here "GET /api/official economy has no settlements_awaiting_a_person $when." }
  if (-not (Test-Number $official.economy.settlements_awaiting_a_person)) { Stop-Here "GET /api/official economy.settlements_awaiting_a_person is not a number $when ('$($official.economy.settlements_awaiting_a_person)')." }
  if ([int64]$official.economy.settlements_awaiting_a_person -ne [int64]$attn.total) { Stop-Here ("/api/official economy.settlements_awaiting_a_person is " + $official.economy.settlements_awaiting_a_person + " but the attention list's total is " + $attn.total + " ${when}: re-read both by hand (a claim may have moved between the reads) before calling it a defect.") }
  return [int64]$attn.total
}
# END-OF-DEFINITIONS (test/deploy-refused-option-b-script.test.ts evaluates everything above this line; nothing above runs git, npm, wrangler or the network)

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
if ($LASTEXITCODE -ne 0) { Stop-Here "HEAD does not contain $($LIVE_BASE_COMMIT.Substring(0, 8)) (the live worker's code): this deploy would drop M3 and the treasury pagination." }
$schemaMoves = @(git diff --name-only $LIVE_BASE_COMMIT HEAD -- migrations schema.sql src/doc.ts)
if ($LASTEXITCODE -ne 0) { Stop-Here "git diff failed (exit $LASTEXITCODE): the no-migration check cannot be read." }
if ($schemaMoves.Count -gt 0) { Stop-Here ("option B was to carry no migration and no constitution change, but these moved since " + $LIVE_BASE_COMMIT.Substring(0, 8) + ": " + ($schemaMoves -join ", ") + ". Not this script's deploy.") }
if (-not (Select-String -Path "src/settlement-claims.ts" -Pattern "export async function markFirstRefusal" -Quiet)) { Stop-Here "src/settlement-claims.ts has no markFirstRefusal: this checkout is not option B." }
if (Select-String -Path "src/settlement-claims.ts" -Pattern "export async function markRefused" -Quiet) { Stop-Here "src/settlement-claims.ts still exports markRefused (the old writer of the refused state): this checkout is not option B." }
if (-not (Test-Path "src/settlement-attention.ts")) { Stop-Here "src/settlement-attention.ts is missing: this checkout would drop M3." }
if (-not (Select-String -Path "src/society.ts" -Pattern "export function parseLedgerCursor" -Quiet)) { Stop-Here "src/society.ts has no parseLedgerCursor: this checkout would drop the treasury pagination." }
if (-not (Select-String -Path "src/guest.ts" -Pattern "export async function postGuestComment" -Quiet)) { Stop-Here "src/guest.ts has no postGuestComment: this checkout would drop the guest voice." }
Say ("[git] HEAD " + $headSha.Substring(0, 8) + " = main = origin/main = -ExpectedCommit; tree clean; contains " + $LIVE_BASE_COMMIT.Substring(0, 8) + "; option B present; no migration, schema or doc.ts change since")

# 1. the wave's own gates, re-run here so a stale checkout cannot deploy
$ErrorActionPreference = "Continue"
$testOut = (npm test 2>&1 | Out-String)
$testCode = $LASTEXITCODE
$tscOut = (npm run typecheck 2>&1 | Out-String)
$tscCode = $LASTEXITCODE
$ErrorActionPreference = "Stop"
$pass = [regex]::Match($testOut, 'pass (\d+)').Groups[1].Value
$fail = [regex]::Match($testOut, 'fail (\d+)').Groups[1].Value
if ($testCode -ne 0 -or $fail -ne "0" -or -not $pass) { Stop-Here "npm test: exit $testCode, pass '$pass', fail '$fail'." }
if ($tscCode -ne 0) { Stop-Here "typecheck failed: $tscOut" }
Say "[tests] pass $pass, fail 0; typecheck clean"

# 2. live, before: non-minting baseline, and the public surfaces this deploy must leave answering
$attBefore = Read-Attest "before the deploy"
Assert-Attest $attBefore "before the deploy"
Say ("[live] before: v5 " + $V5_HASH.Substring(0, 8) + "; all four chains ok; identity " + $attBefore.identity_log.sealed_entries + ", treasury " + $attBefore.treasury.sealed_entries + ", ballots " + $attBefore.ballots.sealed_entries)
$totalBefore = Read-AttentionAndOfficial "before the deploy"
Say ("[live] before: GET /api/settlements/attention answers 200 (M3 is live), total " + $totalBefore + " = /api/official economy.settlements_awaiting_a_person")

# 2b. the read-only prod checks (the gate's C1 and C2). Read-only SELECTs through wrangler d1 execute --remote; a failed read STOPS. (test/deploy-refused-option-b-script.test.ts runs this block against a stand-in for npx.)
# BEGIN-PROD-CHECKS
$c1Rows = @(Invoke-D1Read $C1_SQL)
if ($c1Rows.Count -ne 1 -or -not (Test-Number $c1Rows[0].n)) { Stop-Here "C1: the reconciler's selection did not return one numeric count from prod D1; STOP (nothing was deployed)." }
$c1n = [int64]$c1Rows[0].n
if ($c1n -lt 0 -or $c1n -gt ($RECONCILE_BATCH_ROWS * 2)) { Stop-Here "C1: the count is $c1n, outside 0..$($RECONCILE_BATCH_ROWS * 2) (two subqueries, each LIMIT $RECONCILE_BATCH_ROWS): the statement did not run as the gate read it; STOP." }
Say "[d1] C1: prod D1 accepts the reconciler's UNION ALL selection; it would take $c1n row(s) now (at most $($RECONCILE_BATCH_ROWS * 2))"
$stateRows = @(Invoke-D1Read $C2A_SQL)
$stateLine = (@($stateRows | ForEach-Object { "$($_.state) $($_.n)" }) -join ", ")
if (-not $stateLine) { $stateLine = "no rows" }
Say "[d1] C2a: settlement_claims by state: $stateLine"
$unknownStates = @($stateRows | Where-Object { $CLAIM_STATES -cnotcontains [string]$_.state } | ForEach-Object { [string]$_.state })
if ($unknownStates.Count -gt 0) { Stop-Here ("C2a: settlement_claims holds state(s) outside the five the code knows (" + ($CLAIM_STATES -join ", ") + "): " + ($unknownStates -join ", ") + ". Nothing was deployed.") }
$orphanRows = @(Invoke-D1Read $C2B_SQL)
if ($orphanRows.Count -gt 0) {
  $orphanLine = (@($orphanRows | ForEach-Object { "listing " + $_.id + " (reserved " + (Format-PayingSince $_.paying_since) + ")" }) -join "; ")
  Stop-Here ("C2b: " + $orphanRows.Count + " 'paying' listing(s) no live listing_pay claim owns: " + $orphanLine + ". After deploy the served text would tell such a funder the reconciler resolves it, and it cannot. A payment in flight right now can appear here for a few seconds (re-run once); otherwise read the listing and the chain by hand. Nothing was deployed.")
}
Say "[d1] C2b: every 'paying' listing is owned by a live listing_pay claim (anti-join empty)"
# END-PROD-CHECKS

if ($DryRun) {
  Say "[dry-run] would now: run npx wrangler deploy and capture its version id (refusing to continue without one); wait 20 s; re-check attest (v5, template $($V5_HASH.Substring(0, 8)), every chain ok); ride the public reads, GET /api/settlements/attention (200, total numeric) and /api/official economy.settlements_awaiting_a_person (numeric, equal to the list's total). No public read can tell the new worker from the old one (see the header). Nothing was deployed."
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
$ROLLBACK_LINE = "ROLL BACK THE WORKER (npx wrangler rollback, to the version before $versionId, which should be af1c4ad3 per HANDOVER; check npx wrangler deployments list first). No migration to undo; a claim option B left pending is an ordinary pending claim to the old code."

# 3b. no public read serves anything this wave changed, so there is nothing to poll for. A fixed wait, then the reads; the version id above is the evidence of the deploy.
Say "[deploy] waiting 20 s (a fixed wait, not a proof of propagation: no public read distinguishes the new worker from the old one)"
Start-Sleep -Seconds 20

# 4. the ride: non-minting and the chains, then the unchanged public surfaces
$attAfter = Read-Attest "after the deploy"
Assert-Attest $attAfter "after the deploy"
Say ("[ride] attest: v5 " + $V5_HASH.Substring(0, 8) + " unchanged; every chain ok; identity " + $attAfter.identity_log.sealed_entries + ", treasury " + $attAfter.treasury.sealed_entries + ", ballots " + $attAfter.ballots.sealed_entries)
$bad = @()
foreach ($p in "/", "/api/official", "/llms.txt", "/skill.md", "/heartbeat.md", "/openapi.json", "/treasury", "/api/listings", "/api/listings/payments", "/api/stats", "/api/topics", "/api/guest/due", "/api/citizens") {
  $r = Get-Text "$BASE$p" 30
  if ($r.Code -ne "200") { $bad += "$p=$($r.Code)" }
}
if ($bad.Count -gt 0) { Stop-Here ("non-200 after the deploy (version $versionId): " + ($bad -join ", ") + ". If a read that answered before now fails: $ROLLBACK_LINE") }
Say "[ride] 13 public reads -> 200"
$totalAfter = Read-AttentionAndOfficial "after the deploy (version $versionId)"
Say ("[ride] GET /api/settlements/attention answers 200, total " + $totalAfter + " = /api/official economy.settlements_awaiting_a_person (was " + $totalBefore + " before)")
if ($totalAfter -gt 0) { Say ("[note] " + $totalAfter + " settlement claim(s) await a person: read the list and the claims by hand after this ride.") }

Say "[note] Option B is first ridden by the NEXT REAL REFUSED PAYMENT (a facilitator rule-7 refusal); it cannot be staged. Until then: the reads above show only that nothing broke. Open no new listing until the gate's M1 (the reconciler's expiry shed) or DEFERRED-PAY-LISTING-RESEND-REPLAY is fixed (gate C4; D-074 S1 already keeps listings closed)."
Say "[done] Option B deployed (public reads only; NOT yet ridden by a real refusal). Log version id $versionId, commit $($headSha.Substring(0, 8)) and these lines in HANDOVER.md."
