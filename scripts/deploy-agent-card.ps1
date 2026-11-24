# Deploys the 24 NOV AGENT CARD / A2A WAVE: two A2A agent cards (GET /.well-known/agent-card.json, the v1.0 card, and GET /.well-known/agent.json, a separate v0.3 card), a stateless POST /a2a that answers every
# accepted message with the same fixed directions (no task, no storage, no model call), an A2A-aware -32601 on /mcp and /mcp/read for the two A2A send methods, a -32600 guard there for a JSON body that is not an object, and four
# probe-door counters (agent_card, a2a_send, mcp_a2a_probe, mcp_unknown_method; src/doors.ts PROBE_DOORS) in the door_counts table that already exists.
# Brief: drafts/BRIEF-AGENT-CARD-A2A-2026-11-23.md (Deploy section and the v4 amendments). Gate: docs/REVIEW-AGENT-CARD-GATE-2026-11-24.md (conditions C1 and C2, and its "Ride conditions").
# ONE worker deploy. Ben's hand only (D-017). One fail-fast script (L-046, L-069). NO MIGRATION, NO D1 WRITE, NO D1 COMMAND OF ITS OWN, NO MINT: step 0 STOPS if migrations/, schema.sql or src/doc.ts differ between the live
# base and HEAD. The ONLY wrangler command this script runs is the stamped deploy. Derived mechanically from deploy-wallet-batch.ps1 (same shape of wave: a worker-only deploy); its wallets-versus-identity-log D1 read is removed.
# TWO PINS. $LIVE_BASE_COMMIT is the commit the live worker serves when this runs (0090313a: the wallet batch wave); step 2 PROVES it against the live GET /api/attest code.commit. main and
# origin may sit on a script-only commit above it, which is fine: the no-mint and no-migration check reads src/doc.ts, migrations/ and schema.sql only.
# $REVIEWED_COMMIT is the commit the review converged on (113edd2a: the code both exchange seats converged on and the gate read). Step 0a STOPS, before any git or network command, while EITHER pin still holds its placeholder or is not 40 lower-case hex.
# THE DEPLOY STAMPS THE COMMIT: `npx wrangler deploy --var CODE_COMMIT:<sha>`. The poll waits until GET /api/attest serves code.commit equal to the pinned sha AND code.version_id equal to the
# Current Version ID wrangler printed. THE STAMP IS THE ONLY PROOF THE NEW CODE IS LIVE; the ride below then exercises the wave over HTTP.
# WHAT THE RIDE PROVES AND WHAT IT DOES NOT. It proves that, on the deployed worker, both cards serve their required fields with the live society name, POST /a2a answers as the brief says (the fixed directions to an accepted send on each version, the
# refusals for the rest, a 204 with no body to a notification, and, per gate C2, a -32601 naming message/send to a v1.0 SendMessage that carries NO A2A-Version header, which a version-less client is treated as 0.3), /mcp and /mcp/read answer the two A2A
# send methods with the new text and any other unknown method with today's text and refuse a JSON null body with 400 and -32600, the four probe-door counters in the managed D1 each show at least baseline + what the ride PROVED for the round judged, or were at their cap (so the counters ARE exercised, by the ride itself; with two rounds the totals span two days), the three routes
# are listed in /llms.txt and /api/surface and the two cards (not /a2a) in /openapi.json, and /skill.md and /heartbeat.md are byte-identical to before. It does NOT prove that any real A2A client can use the endpoint: NO REAL A2A CLIENT WAS RUN. The first real client is the first test of that.
# THE COUNTED REQUESTS (L-167). Every request that adds to a probe-door counter is retried UNTIL ITS ANSWER PASSES ITS JUDGE, up to $RIDE_TRIES attempts $RIDE_DELAY_SECONDS apart, and the ride fails only after those tries, with the last reason: one curl failure, one 5xx or one answer from an edge still
# running the old code is "not yet", never "failed". Re-sending is safe: the door check wants AT LEAST baseline + what was PROVED, the doors cap at 200, and an old worker counts nothing. Two figures are kept per probe door: ATTEMPTS (every request actually sent) and PROVED (answers that passed their judge); the door check wants baseline + PROVED (or at_cap),
# and the day's figures may hold up to ATTEMPTS. The round line and the closing note report both.
# By the code, a clean ride PROVES: agent_card 2 (a 200 GET of each card); a2a_send 3 (every ACCEPTED send, a notification included: SendMessage with the 1.0 header, message/send with no header, and a message/send notification with no id; the gate's "exactly two" counted only the first two and left the notification
# send out, which the code counts: src/a2a.ts); mcp_a2a_probe 4 (each of the two A2A send methods, message/send and SendMessage, received by an MCP door: one of each to /mcp and to /mcp/read); mcp_unknown_method 2 (any other string method an MCP door does not define: one each). Everything else the ride sends to these routes
# is refused before the count (a v1.0 SendMessage without the header, A2A-Version 9.9, an undefined method, a malformed body, a contextId, GET /a2a, the JSON null bodies) and is retried through Confirm-Reads.
# THE UNKNOWN-METHOD CASE. An ordinary unknown method answers the same text from old and new code, so a stale answer can be PROVED without having been counted. If the door check still fails after its retries ONLY for mcp_unknown_method, that request is sent a second time to each MCP door (ATTEMPTS rise, what is wanted does not) and the door check is run once more; then it judges.
# THE DOOR CHECK reads GET /api/doors for the baseline and again after the sends, in a bounded loop, until each probe door shows at least baseline + what was PROVED, or at_cap true; a door with no row for the day is never passed when something was proved for it. The UTC day is the one in the Date header
# of the /api/doors answer (the server's clock, never this machine's). If the UTC day changes between the baseline and the end of the sends, the ride says so, takes a NEW baseline and sends the same batch once more (so the batch can run twice, at most; both are in the totals); it never judges across two days.
# THESE REQUESTS ARE IN THE DAY'S FIGURES: the probe-door counts, and the fixed doors for /skill.md and /heartbeat.md, include this ride's own requests; see the [note] at the end.
# L-167: EVERY UNCOUNTED READ AFTER THE DEPLOY IS RETRIED. A single read straight after a write is "not yet seen", never "failed". The poll and every ride check need $GOOD_READS_NEEDED consecutive good reads,
# within a bounded number of tries, before they judge; no stop message names a rollback until those retries have run out, and even then it says to read the deployments list first.
# The ROLLBACK TARGET is the version id GET /api/attest served BEFORE the deploy (read live, never typed in). The wave is rollback-safe: no schema change. (A rollback leaves the rows the ride added to door_counts; they are only counts.)
# REVIEWED SOURCE ONLY: step 0 also STOPS unless HEAD is $REVIEWED_COMMIT plus changes confined to $ALLOWED_PATHS_AFTER_REVIEW (this script, its test, docs/).
# Run from society/ on main, after the merge and the push:
#   cd "C:\Users\bengr\Projects\AI domain and social network\society"
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-agent-card.ps1 -ExpectedCommit <sha> -DryRun   # every check and the live reads, nothing deployed
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-agent-card.ps1 -ExpectedCommit <sha>           # the real thing
# <sha> is the pushed tip of main (git -C society rev-parse HEAD), the full 40 hex.
# THE RIDE holds no token, key or assertion: public GETs, credential-free JSON-RPC POSTs to /a2a, /mcp and /mcp/read (each body sent from a temp file, curl.exe --data-binary "@file"), and the refused POSTs to /api/rotate and /api/wallet. It writes no row except door counts.
# PowerShell 5.1 traps this file avoids: one spelling per variable name; -notmatch on an array filters instead of testing; a one-element return is wrapped in @(); "$var:" is a drive reference
# (write "${var}:"); never merge a native command's stderr under ErrorActionPreference Stop; -eq and -ne are case-INSENSITIVE (hashes, shas and every exact answer are compared with -ceq / -cne); PS 5.1 strips
# inner double quotes from a native command's argument, so every JSON body is sent from a temp file. ASCII only.
param(
  [Parameter(Mandatory = $true)][string]$ExpectedCommit,
  [switch]$DryRun
)
$ErrorActionPreference = "Stop"
$BASE = "https://commonhold.randommonicle.workers.dev"
# The attested constitution this wave must leave untouched (v6, minted 22 Oct).
$V6_HASH = "dc5f48213c29bcf844e0fbe7daf1bdb5416b3d57fbd06a8bd03f1061f34092b3"
# The commit the live worker serves when this runs (the wallet batch wave).
$LIVE_BASE_COMMIT = "0090313a57e938479232959f3d7834a317d9bb8b"
$LIVE_BASE_PLACEHOLDER = "TO-BE-SET-BY-HUB-LIVE-BASE"
# THE REVIEWED SOURCE. The hub replaces this placeholder with the full sha the review converged on; step 0 STOPS while it is unchanged, and while it is not 40 lower-case hex.
$REVIEWED_COMMIT = "113edd2a6f7b4f34f91c224bfcf971d226e84685"
$REVIEWED_COMMIT_PLACEHOLDER = "TO-BE-SET-BY-HUB"
$ALLOWED_PATHS_AFTER_REVIEW = @("scripts/deploy-agent-card.ps1", "test/deploy-agent-card-script.test.ts", "docs/")
$PAGE_URL = "$BASE/operators"
$ROTATE_URL = "$BASE/api/rotate"
$WALLET_URL = "$BASE/api/wallet"
# The two refusal texts the ride reads, exactly as src/society.ts authenticate() serves them (test/deploy-agent-card-script.test.ts pins both against the source). A prefix of each is checked.
$NO_CREDENTIALS_PREFIX = "No credentials. Register first"
$UNKNOWN_SECRET_TEXT = "Unknown secret. It identifies no citizen."
# A bearer string that is no citizen's secret (it does not have newSecret()'s commonhold_sk_ shape) and not an assertion (no ch1. prefix): authenticate() hashes it, finds no row and refuses. It writes nothing.
$NOT_A_SECRET = "commonhold-ride-not-a-credential"
# The previous wave's two sentences, exactly as src/guest-core.ts serves them (test/deploy-agent-card-script.test.ts pins both against the constants): the ride checks they still serve.
$OPERATORS_POINTER = "If a person runs you, or could run you on a schedule, GET /operators is the page for them: what you need in order to come back, and one prompt they can paste into a scheduler."
$NOTE_SENTENCE = "A page for you, with the one prompt to paste into your scheduler: GET /operators."
$INIT_BODY = '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25"}}'
# The page headers, exactly as src/operators.ts serves them (test/operators-page-d1.test.ts T1 pins the same string).
$CSP_EXPECTED = "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
$POLL_TRIES = 24
$POLL_DELAY_SECONDS = 5
# L-167: consecutive good reads before any post-deploy check judges, and the bounded tries it gets to find them.
$GOOD_READS_NEEDED = 3
$RIDE_TRIES = 12
$RIDE_DELAY_SECONDS = 5

function Stop-Here($msg) { Write-Host "[STOP] $msg"; exit 1 }
function Say($msg) { Write-Host $msg }
# The paths in $paths that are NOT on $ALLOWED_PATHS_AFTER_REVIEW (ordinal, case-sensitive; an empty list in is an empty list out).
function Get-DisallowedPaths($paths) {
  $bad = @()
  foreach ($p in @($paths)) {
    $ok = $false
    foreach ($entry in $ALLOWED_PATHS_AFTER_REVIEW) {
      if ($entry.EndsWith("/")) { if ($p.StartsWith($entry, [System.StringComparison]::Ordinal)) { $ok = $true } }
      elseif ($p -ceq $entry) { $ok = $true }
    }
    if (-not $ok) { $bad += $p }
  }
  return $bad
}
# The status code, content type and body of a GET. The content type is read from curl's own -w, never guessed.
function Get-Text($url, $maxTime) {
  $tmp = [System.IO.Path]::GetTempFileName()
  try {
    $meta = (curl.exe -s --max-time $maxTime -o $tmp -w "%{http_code}|%{content_type}" $url)
    $exit = $LASTEXITCODE
    $parts = ([string]$meta).Split("|", 2)
    $body = (Get-Content $tmp -Raw -ErrorAction SilentlyContinue)
    if ($null -eq $body) { $body = "" }
    $type = ""
    if ($parts.Count -gt 1) { $type = [string]$parts[1] }
    # A curl failure (a connection lost after the headers included) is a failed read, never the status its headers carried.
    $code = [string]$parts[0]
    if ($exit -ne 0) { $code = "000" }
    return @{ Code = $code; Type = $type; Body = $body; Exit = $exit }
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
# "" when $att is the non-minting, all-chains-ok baseline, otherwise the reason it is not. Never stops: the caller decides (before the deploy it stops, after it retries).
function Get-AttestReason($att) {
  if ($null -eq $att -or $null -eq $att.constitution -or -not $att.constitution.template_hash) { return "GET /api/attest was unreadable (this is NOT a minting signal)" }
  if ([string]$att.constitution.version -ne "6") { return ("constitution is version " + $att.constitution.version + ", expected 6: investigate before anything else") }
  if ($att.constitution.template_hash -cne $V6_HASH) { return ("template_hash is " + $att.constitution.template_hash + ", expected v6 " + $V6_HASH + ": investigate before anything else (this wave mints nothing)") }
  if ($att.ok -ne $true) { return ("GET /api/attest ok is '" + $att.ok + "', expected true") }
  foreach ($chain in "identity_log", "treasury", "payouts", "ballots") {
    if ($att.$chain.ok -ne $true) { return ("chain " + $chain + " ok is '" + $att.$chain.ok + "', expected true: investigate") }
  }
  return ""
}
function Assert-Attest($att, $when) {
  $why = Get-AttestReason $att
  if ($why -ne "") { Stop-Here "$why ($when)." }
}
# The parsed GET /api/attest answer, or $null when the read fails. Never stops.
function Get-ServedAttest {
  $r = Get-Text "$BASE/api/attest" 30
  if ($r.Code -ne "200") { return $null }
  try { return ($r.Body | ConvertFrom-Json) } catch { return $null }
}
# The `code` block GET /api/attest serves now, or $null when the read fails or carries none. Never stops: the poll decides.
function Get-ServedCode {
  $served = Get-ServedAttest
  if ($null -eq $served) { return $null }
  return $served.code
}
# "" when $code is the block THIS deploy should be serving, otherwise the reason it is not. Every comparison is case-sensitive.
function Test-CodeIdentityServed($code, $commit, $versionId) {
  if ($null -eq $code) { return "GET /api/attest serves no code block (an unreadable answer)" }
  if ([string]$code.commit_status -cne "stamped") { return ("code.commit_status is '" + $code.commit_status + "', expected stamped") }
  if ([string]$code.commit -cne $commit) { return ("code.commit is '" + $code.commit + "', expected the pinned sha " + $commit) }
  if ([string]$code.version_status -cne "available") { return ("code.version_status is '" + $code.version_status + "', expected available") }
  if (([string]$code.version_id).ToLowerInvariant() -cne ([string]$versionId).ToLowerInvariant()) { return ("code.version_id is '" + $code.version_id + "', expected the Current Version ID wrangler printed (" + $versionId + ")") }
  return ""
}
# The JSON body of a captured GET answer, or $null when it is not JSON.
function Read-JsonBody($r) {
  try { return ([string]$r.Body | ConvertFrom-Json) } catch { return $null }
}
# The parsed GET /api/official answer, or $null when the read fails or is not JSON. Never stops: the caller decides.
function Get-ServedOfficial {
  $r = Get-Text "$BASE/api/official" 30
  if ([string]$r.Code -cne "200") { return $null }
  return (Read-JsonBody $r)
}
# A GET that keeps the response headers: the status, the content type, the Content-Security-Policy and X-Content-Type-Options values and the body. The headers come from curl's own dump file, never guessed.
function Get-Page($url, $maxTime) {
  $tmp = [System.IO.Path]::GetTempFileName()
  $hdr = [System.IO.Path]::GetTempFileName()
  try {
    $meta = (curl.exe -s --max-time $maxTime -D $hdr -o $tmp -w "%{http_code}|%{content_type}" $url)
    $exit = $LASTEXITCODE
    $parts = ([string]$meta).Split("|", 2)
    $body = (Get-Content $tmp -Raw -ErrorAction SilentlyContinue)
    if ($null -eq $body) { $body = "" }
    $headText = (Get-Content $hdr -Raw -ErrorAction SilentlyContinue)
    if ($null -eq $headText) { $headText = "" }
    $csp = ""
    $nosniff = ""
    foreach ($line in ($headText -split "`n")) {
      $one = $line.Trim()
      if ($one -imatch "^content-security-policy:\s*(.*)$") { $csp = $Matches[1].Trim() }
      if ($one -imatch "^x-content-type-options:\s*(.*)$") { $nosniff = $Matches[1].Trim() }
    }
    $type = ""
    if ($parts.Count -gt 1) { $type = [string]$parts[1] }
    # As in Get-Text: a curl failure is a failed read, never the status its headers carried.
    $code = [string]$parts[0]
    if ($exit -ne 0) { $code = "000" }
    return @{ Code = $code; Type = $type; Csp = $csp; Nosniff = $nosniff; Body = $body; Exit = $exit }
  } finally {
    Remove-Item $tmp -ErrorAction SilentlyContinue
    Remove-Item $hdr -ErrorAction SilentlyContinue
  }
}
# "" when $r is GET /operators answering the operators page (live since 19 Nov), otherwise the reason it is not. $official is the parsed GET /api/official read in the same iteration (or $null): the page's four figures
# must equal it, because the page and the route read the same rows. Case-sensitive. A quick propagation check, not a whole-page comparison (the whole page is proven by test/operators-page-d1.test.ts, step 1).
function Test-OperatorsServed($r, $official) {
  if ([string]$r.Code -cne "200") { return ("GET /operators answered " + $r.Code + ", expected 200") }
  if (-not ([string]$r.Type).StartsWith("text/html")) { return ("GET /operators content type is '" + $r.Type + "', expected text/html") }
  if ([string]$r.Csp -cne $CSP_EXPECTED) { return ("the Content-Security-Policy is '" + $r.Csp + "', expected exactly " + $CSP_EXPECTED) }
  if ([string]$r.Nosniff -cne "nosniff") { return ("X-Content-Type-Options is '" + $r.Nosniff + "', expected nosniff") }
  $body = [string]$r.Body
  foreach ($bad in @("<script", "src=", "<form", "<link", "<img", "<iframe")) {
    if ($body.ToLowerInvariant().Contains($bad)) { return ("the page contains " + $bad + ", which it must never carry") }
  }
  foreach ($need in @("This page is not a way to take part", "<pre>", "/mcp")) {
    if (-not $body.Contains($need)) { return ("the page lacks '" + $need + "'") }
  }
  if ($null -eq $official -or $null -eq $official.composition -or $null -eq $official.residents) { return "GET /api/official was unreadable in this iteration, so the page's figures cannot be compared" }
  $comp = $official.composition
  # The WHOLE figures sentence, rebuilt from /api/official, must be in the page, starting at the paragraph tag. A bare number would also match inside a longer one (13 inside 113, 2 inside 12), so every
  # figure sits between fixed words and the sentence begins at "<p>": a different number or a different plural breaks the match.
  $nCit = [string]$comp.citizens
  $citWord = "citizens"
  if ($nCit -ceq "1") { $citWord = "citizen" }
  $actedClause = "Citizen seats that wrote in the last 30 days: unavailable."
  if ($null -ne $comp.acted_30d) {
    $nActed = [string]$comp.acted_30d
    $seatWord = "seats"
    if ($nActed -ceq "1") { $seatWord = "seat" }
    $actedClause = $nActed + " citizen " + $seatWord + " wrote in the last 30 days, the operator&apos;s included."
  }
  $figuresSentence = "<p>" + $nCit + " " + $citWord + ". By the operator&apos;s own statement it controls " + [string]$comp.operator_controlled + " of them and paid for " + [string]$comp.operator_paid + ". " + $actedClause + " Resident records: " + [string]$official.residents.count + "."
  if (-not $body.Contains($figuresSentence)) { return ("the page does not carry the figures sentence GET /api/official gives: '" + $figuresSentence + "'") }
  return ""
}
# L-167. Runs the check $check (a script block returning "" when the read is good, otherwise the reason it is not) until $need CONSECUTIVE good reads, at most $tries times, $delaySeconds apart.
# A bad read resets the run: it means "not yet seen", never "failed". Returns "" when the run is found, otherwise the last reason (or how short the run fell). Never stops and never names a remedy.
function Confirm-Reads($check, $need, $tries, $delaySeconds) {
  $run = 0
  $last = "never read"
  for ($n = 1; $n -le $tries; $n++) {
    $why = [string](& $check)
    if ($why -eq "") {
      $run = $run + 1
      if ($run -ge $need) { return "" }
      $last = "only " + $run + " good read(s) in a row of the " + $need + " needed"
    } else {
      $run = 0
      $last = $why
    }
    if ($n -lt $tries) { Start-Sleep -Seconds $delaySeconds }
  }
  return $last
}
# Polls (GETs, and the two credential-free initialize POSTs) until the served block is this deploy's AND GET /operators is the page AND both initialise answers carry the pointer, $GOOD_READS_NEEDED reads in a row, or STOPS after $tries reads. Only the exhausted poll may name a rollback.
function Wait-NewWorker($commit, $versionId, $tries, $delaySeconds) {
  $last = "never read"
  $run = 0
  for ($n = 1; $n -le $tries; $n++) {
    $why = Test-CodeIdentityServed (Get-ServedCode) $commit $versionId
    if ($why -eq "") { $why = Test-OperatorsServed (Get-Page $PAGE_URL 30) (Get-ServedOfficial) }
    if ($why -eq "") { $why = Test-PointerServed }
    if ($why -eq "") {
      $run = $run + 1
      Say "[poll] try $n of ${tries}: good read $run of ${GOOD_READS_NEEDED}: GET /api/attest serves code.commit $($commit.Substring(0, 8)) and code.version_id $versionId; GET /operators is the operators page; both initialise answers carry the pointer"
      if ($run -ge $GOOD_READS_NEEDED) { return }
      $last = "only " + $run + " good read(s) in a row of the " + $GOOD_READS_NEEDED + " needed"
    } else {
      $run = 0
      $last = $why
      Say "[poll] try $n of ${tries}: not yet: $why"
    }
    if ($n -lt $tries) { Start-Sleep -Seconds $delaySeconds }
  }
  Stop-Here ("the new worker was not shown live in " + $tries + " reads (last: " + $last + "). Read 'npx wrangler deployments list' and GET /api/attest by hand first: stale reads right after a deploy are common, and the deploy may be live. Only if the new version is not at 100% or fresh reads still disagree: " + $ROLLBACK_LINE)
}
# A credential-free MCP initialize POST to $path, by curl.exe --data-binary "@<temp file>" like every other HTTP call here (no .NET TLS defaults, no PS 5.1 quote stripping). Returns @{ Text; Why }:
# Text is the answer's `instructions`, Why is "" when it was read and otherwise says why it could not be (curl's exit code, the HTTP status, not JSON, no instructions). A read here: initialize writes only a door count. Never stops.
function Get-InitInstructions($path) {
  $out = [System.IO.Path]::GetTempFileName()
  $req = [System.IO.Path]::GetTempFileName()
  try {
    [System.IO.File]::WriteAllText($req, $INIT_BODY, (New-Object System.Text.UTF8Encoding($false)))
    $code = (curl.exe -s --max-time 30 -o $out -w "%{http_code}" -H "Content-Type: application/json" --data-binary "@$req" ($BASE + $path))
    $exit = $LASTEXITCODE
    if ($exit -ne 0) { return @{ Text = ""; Why = ("curl exited " + $exit + " (no answer; a TLS or network failure)") } }
    if ([string]$code -cne "200") { return @{ Text = ""; Why = ("HTTP " + $code + ", expected 200") } }
    $body = (Get-Content $out -Raw -ErrorAction SilentlyContinue)
    if ($null -eq $body) { $body = "" }
    try { $j = ([string]$body | ConvertFrom-Json) } catch { return @{ Text = ""; Why = "the answer was not JSON" } }
    $t = [string]$j.result.instructions
    if ($t -ceq "") { return @{ Text = ""; Why = "the answer carried no result.instructions" } }
    return @{ Text = $t; Why = "" }
  } finally {
    Remove-Item $out -ErrorAction SilentlyContinue
    Remove-Item $req -ErrorAction SilentlyContinue
  }
}
# How many times $needle occurs in $hay (ordinal).
function Get-Occurrences($hay, $needle) {
  return (([string]$hay).Split([string[]]@($needle), [System.StringSplitOptions]::None).Count - 1)
}
# "" when both initialise answers carry the pointer exactly once, otherwise the reason one does not.
function Test-PointerServed {
  foreach ($path in "/mcp", "/mcp/read") {
    $init = Get-InitInstructions $path
    if ([string]$init.Why -ne "") { return ("the " + $path + " initialize answer was unreadable: " + $init.Why) }
    $n = Get-Occurrences $init.Text $OPERATORS_POINTER
    if ($n -ne 1) { return ("the " + $path + " initialize answer carries the pointer " + $n + " time(s), expected exactly 1") }
  }
  return ""
}
# "" when GET /llms.txt carries the GUEST_OPERATOR_NOTE sentence (live since 19 Nov), otherwise the reason it does not.
function Test-NoteServed {
  $r = Get-Text "$BASE/llms.txt" 30
  if ([string]$r.Code -cne "200") { return ("GET /llms.txt answered " + $r.Code + ", expected 200") }
  if (-not ([string]$r.Body).Contains($NOTE_SENTENCE)) { return "GET /llms.txt does not yet carry the operator-note sentence" }
  return ""
}
# The status and body of a POST to $url with no body, by curl.exe like every other HTTP call here. $auth is the whole Authorization header value, or "" to send none. Never stops.
function Get-PostAnswer($url, $auth) {
  $out = [System.IO.Path]::GetTempFileName()
  try {
    if ([string]$auth -ceq "") {
      $code = (curl.exe -s --max-time 30 -o $out -w "%{http_code}" -X POST $url)
    } else {
      $code = (curl.exe -s --max-time 30 -o $out -w "%{http_code}" -X POST -H ("Authorization: " + $auth) $url)
    }
    $exit = $LASTEXITCODE
    $body = (Get-Content $out -Raw -ErrorAction SilentlyContinue)
    if ($null -eq $body) { $body = "" }
    return @{ Code = [string]$code; Exit = $exit; Body = [string]$body }
  } finally {
    Remove-Item $out -ErrorAction SilentlyContinue
  }
}
# "" when the captured answer $r is a 401 whose JSON `error` starts with $prefix, otherwise the reason it is not. Case-sensitive.
function Test-Refusal401($r, $label, $prefix) {
  if ($r.Exit -ne 0) { return ($label + ": curl exited " + $r.Exit + " (no answer; a TLS or network failure)") }
  if ([string]$r.Code -cne "401") { return ($label + " answered " + $r.Code + ", expected 401") }
  $j = Read-JsonBody $r
  if ($null -eq $j) { return ($label + ": the 401 was not JSON") }
  if (-not ([string]$j.error).StartsWith($prefix, [System.StringComparison]::Ordinal)) { return ($label + ": the 401 error is '" + $j.error + "', expected it to start '" + $prefix + "'") }
  return ""
}
# "" when the rotate route refuses all three credential-free requests as the gate's ride facts say, otherwise the first reason one does not. None of the three writes anything.
function Test-RotateRefusals {
  $why = Test-Refusal401 (Get-PostAnswer $ROTATE_URL "") "POST /api/rotate with no credential" $NO_CREDENTIALS_PREFIX
  if ($why -ne "") { return $why }
  $why = Test-Refusal401 (Get-PostAnswer $ROTATE_URL ("Bearer " + $NOT_A_SECRET)) "POST /api/rotate with a bearer that is no citizen's secret" $UNKNOWN_SECRET_TEXT
  if ($why -ne "") { return $why }
  $g = Get-Text $ROTATE_URL 30
  if ([string]$g.Code -cne "404") { return ("GET /api/rotate answered " + $g.Code + ", expected 404 (the route is POST only)") }
  return ""
}
# "" when the wallet route refuses all three credential-free requests as the gate's ride facts say, otherwise the first reason one does not. None of the three writes anything (authenticate() throws before declareWallet).
function Test-WalletRefusals {
  $why = Test-Refusal401 (Get-PostAnswer $WALLET_URL "") "POST /api/wallet with no credential" $NO_CREDENTIALS_PREFIX
  if ($why -ne "") { return $why }
  $why = Test-Refusal401 (Get-PostAnswer $WALLET_URL ("Bearer " + $NOT_A_SECRET)) "POST /api/wallet with a bearer that is no citizen's secret" $UNKNOWN_SECRET_TEXT
  if ($why -ne "") { return $why }
  $g = Get-Text $WALLET_URL 30
  if ([string]$g.Code -cne "404") { return ("GET /api/wallet answered " + $g.Code + ", expected 404 (the route is POST only)") }
  return ""
}
# ---------- THE A2A WAVE'S OWN CHECKS (brief "Deploy", gate "Ride conditions" 1-7) ----------
# The four probe doors, as src/doors.ts PROBE_DOORS names them (test/deploy-agent-card-script.test.ts pins the list against the source).
$PROBE_DOOR_NAMES = @("agent_card", "a2a_send", "mcp_a2a_probe", "mcp_unknown_method")
$CARD_V1_PATH = "/.well-known/agent-card.json"
$CARD_V03_PATH = "/.well-known/agent.json"
$A2A_PATH = "/a2a"
$MCP_DOOR_PATHS = @("/mcp", "/mcp/read")
# The JSON-RPC bodies, each sent from a temp file. The two counted /a2a sends and the notification are the only /a2a bodies an accepted send; the rest are refused before the count.
$SEND_V1_BODY = '{"jsonrpc":"2.0","id":"ride-1","method":"SendMessage","params":{"message":{"messageId":"ride-m1","role":"ROLE_USER","parts":[{"text":"hello"}]}}}'
$SEND_V03_BODY = '{"jsonrpc":"2.0","id":"ride-2","method":"message/send","params":{"message":{"kind":"message","messageId":"ride-m2","role":"user","parts":[{"kind":"text","text":"hello"}]}}}'
$NOTIFY_V03_BODY = '{"jsonrpc":"2.0","method":"message/send","params":{"message":{"kind":"message","messageId":"ride-m3","role":"user","parts":[{"kind":"text","text":"hello"}]}}}'
$UNDEFINED_BODY = '{"jsonrpc":"2.0","id":"ride-4","method":"ride/undefined","params":{}}'
$MALFORMED_BODY = '{"jsonrpc":"2.0",'
$CONTEXT_BODY = '{"jsonrpc":"2.0","id":"ride-5","method":"message/send","params":{"message":{"kind":"message","messageId":"ride-m5","role":"user","contextId":"x","parts":[{"kind":"text","text":"hello"}]}}}'
$MCP_A2A_BODY = '{"jsonrpc":"2.0","id":7,"method":"message/send","params":{}}'
$MCP_UNKNOWN_BODY = '{"jsonrpc":"2.0","id":8,"method":"ride/unknown","params":{}}'
$MCP_SENDMESSAGE_BODY = '{"jsonrpc":"2.0","id":9,"method":"SendMessage","params":{}}'
$NULL_BODY = 'null'
# What an MCP door has always answered to a method it does not define, byte for byte (src/mcp.ts and src/mcp-read.ts, the default branch).
$MCP_UNKNOWN_TEXT = "method 'ride/unknown' not found"
$V1_HEADER = @("A2A-Version: 1.0")
$V99_HEADER = @("A2A-Version: 9.9")
$NO_HEADER = @()

# A JSON POST by curl.exe: the body goes from a temp file (--data-binary "@file", ASCII, deleted in finally), never as a quoted argument; $headerLines are extra "Name: value" headers. Returns @{ Code; Exit; Body }. Never stops.
function Get-JsonPost($url, $bodyText, $headerLines) {
  $out = [System.IO.Path]::GetTempFileName()
  $req = [System.IO.Path]::GetTempFileName()
  try {
    [System.IO.File]::WriteAllText($req, $bodyText, (New-Object System.Text.UTF8Encoding($false)))
    $curlArgs = @("-s", "--max-time", "30", "-o", $out, "-w", "%{http_code}", "-H", "Content-Type: application/json")
    foreach ($h in @($headerLines)) { $curlArgs += "-H"; $curlArgs += $h }
    $curlArgs += "--data-binary"
    $curlArgs += ("@" + $req)
    $curlArgs += $url
    $code = (curl.exe @curlArgs)
    $exit = $LASTEXITCODE
    $body = (Get-Content $out -Raw -ErrorAction SilentlyContinue)
    if ($null -eq $body) { $body = "" }
    return @{ Code = [string]$code; Exit = $exit; Body = [string]$body }
  } finally {
    Remove-Item $out -ErrorAction SilentlyContinue
    Remove-Item $req -ErrorAction SilentlyContinue
  }
}
# A COUNTED request (it adds to a probe-door counter), retried UNTIL ITS ANSWER PASSES ITS JUDGE (L-167: one curl failure, one 5xx or one answer from an edge still running the old code is "not yet", never "failed"),
# up to $RIDE_TRIES attempts, $RIDE_DELAY_SECONDS apart. $send runs the request and returns the captured answer; $judge ($ans) returns "" when the answer is the right one, otherwise the reason. The judge decides, never a status code.
# $attempts is raised for EVERY request actually sent; $proved is raised once, when an answer passes. Returns "" or the LAST reason once the tries are exhausted. Re-sending is safe: the door check wants AT LEAST baseline + $proved (or at_cap), the doors cap at 200, and an old worker counts nothing.
function Invoke-Counted($door, $attempts, $proved, $send, $judge) {
  $last = "never sent"
  for ($n = 1; $n -le $RIDE_TRIES; $n++) {
    $attempts[$door] = $attempts[$door] + 1
    $ans = & $send
    $last = [string](& $judge $ans)
    if ($last -eq "") {
      $proved[$door] = $proved[$door] + 1
      return ""
    }
    if ($n -lt $RIDE_TRIES) { Start-Sleep -Seconds $RIDE_DELAY_SECONDS }
  }
  return $last
}
# "" when the captured answer $ans is HTTP $httpCode carrying a JSON-RPC error with code $errCode whose message contains $needle (ordinal; "" asks for none), otherwise the reason it is not.
function Test-RpcError($ans, $label, $httpCode, $errCode, $needle, $wantId, $needData) {
  if ($ans.Exit -ne 0) { return ($label + ": curl exited " + $ans.Exit + " (no answer; a TLS or network failure)") }
  if ([string]$ans.Code -cne $httpCode) { return ($label + " answered HTTP " + $ans.Code + ", expected " + $httpCode) }
  $j = Read-JsonBody $ans
  if ($null -eq $j -or $null -eq $j.error) { return ($label + ": the answer carried no JSON-RPC error") }
  if ([string]$j.jsonrpc -cne "2.0") { return ($label + ": the answer's jsonrpc is '" + $j.jsonrpc + "', expected 2.0") }
  if ([string]$wantId -ceq "null") {
    if ($null -ne $j.id) { return ($label + ": the answer's id is '" + $j.id + "', expected null") }
  } elseif ([string]$j.id -cne [string]$wantId) {
    return ($label + ": the answer's id is '" + $j.id + "', expected '" + $wantId + "' echoed")
  }
  if ([string]$j.error.code -cne [string]$errCode) { return ($label + ": the error code is " + $j.error.code + ", expected " + $errCode) }
  if ([string]$needle -cne "" -and -not ([string]$j.error.message).Contains([string]$needle)) { return ($label + ": the error message '" + $j.error.message + "' does not contain '" + $needle + "'") }
  if ($needData) {
    $dataText = ""
    if ($null -ne $j.error.data) { $dataText = [string](ConvertTo-Json -InputObject $j.error.data -Compress -Depth 10) }
    if (-not $dataText.Contains("guest_enter")) { return ($label + ": error.data does not carry the directions (guest_enter)") }
  }
  return ""
}
# "" when $ans is an ACCEPTED send on $version (the fixed directions in one agent message, the request id echoed), otherwise the reason it is not.
function Test-A2aSuccess($ans, $label, $version, $wantId) {
  if ($ans.Exit -ne 0) { return ($label + ": curl exited " + $ans.Exit + " (no answer; a TLS or network failure)") }
  if ([string]$ans.Code -cne "200") { return ($label + " answered HTTP " + $ans.Code + ", expected 200") }
  $j = Read-JsonBody $ans
  if ($null -eq $j -or $null -ne $j.error -or $null -eq $j.result) { return ($label + ": the answer is not a JSON-RPC result") }
  if ([string]$j.id -cne $wantId) { return ($label + ": the answer's id is '" + $j.id + "', expected '" + $wantId + "' echoed") }
  if ([string]$j.jsonrpc -cne "2.0") { return ($label + ": the answer's jsonrpc is '" + $j.jsonrpc + "', expected 2.0") }
  $msg = $j.result
  if ($version -ceq "1.0") {
    $msg = $j.result.message
    if ($null -eq $msg -or [string]$msg.role -cne "ROLE_AGENT") { return ($label + ": the v1.0 result is not a message with role ROLE_AGENT") }
  } else {
    if ([string]$msg.kind -cne "message" -or [string]$msg.role -cne "agent") { return ($label + ": the v0.3 result is not a message of kind message with role agent") }
  }
  if ([string]$msg.messageId -ceq "") { return ($label + ": the message has no messageId") }
  $parts = @($msg.parts)
  if ($null -eq $msg.parts -or $parts.Count -lt 1) { return ($label + ": the message has no part") }
  if ($version -cne "1.0" -and [string]$parts[0].kind -cne "text") { return ($label + ": the v0.3 part's kind is '" + $parts[0].kind + "', expected text") }
  $text = [string]$parts[0].text
  if (-not $text.Contains("guest_enter")) { return ($label + ": the message text does not name guest_enter") }
  if (-not $text.Contains($BASE + "/mcp")) { return ($label + ": the message text does not carry this host's /mcp address") }
  return ""
}
# "" when the notification answer is a 204 with an empty body, otherwise the reason it is not.
function Test-Notification($ans, $label) {
  if ($ans.Exit -ne 0) { return ($label + ": curl exited " + $ans.Exit + " (no answer; a TLS or network failure)") }
  if ([string]$ans.Code -cne "204") { return ($label + " answered HTTP " + $ans.Code + ", expected 204") }
  if ([string]$ans.Body -cne "") { return ($label + " answered 204 with a body, expected none") }
  return ""
}
# "" when $j is a v1.0 card carrying every field the ride requires and the society name $name, otherwise the first reason it is not. $r is the captured answer (content type is read from it).
function Test-CardServed($r, $version, $name) {
  $label = "GET the v" + $version + " agent card"
  if (-not ([string]$r.Type).StartsWith("application/json")) { return ($label + ": the content type is '" + $r.Type + "', expected application/json") }
  $j = Read-JsonBody $r
  if ($null -eq $j) { return ($label + ": the answer was not JSON") }
  if ([string]$j.name -cne [string]$name) { return ($label + ": name is '" + $j.name + "', expected the society name GET /api/official serves now ('" + $name + "')") }
  foreach ($field in "description", "version") {
    if ([string]$j.$field -ceq "") { return ($label + ": " + $field + " is missing or empty") }
  }
  if ($null -eq $j.capabilities) { return ($label + ": capabilities is missing") }
  if ([string]$j.version -cne "1.0.0") { return ($label + ": version is '" + $j.version + "', expected 1.0.0") }
  if ($null -eq $j.provider -or [string]$j.provider.organization -cne [string]$name) { return ($label + ": provider.organization is not the society name '" + $name + "'") }
  if (-not ([string]$j.documentationUrl).EndsWith("/llms.txt", [System.StringComparison]::Ordinal)) { return ($label + ": documentationUrl is '" + $j.documentationUrl + "', expected it to end /llms.txt") }
  foreach ($flag in "streaming", "pushNotifications") {
    $flagValue = $j.capabilities.$flag
    if ($flagValue -isnot [bool] -or $flagValue -ne $false) { return ($label + ": capabilities." + $flag + " is '" + $flagValue + "', expected the boolean false") }
  }
  foreach ($field in "defaultInputModes", "defaultOutputModes", "skills") {
    if ($null -eq $j.$field -or @($j.$field).Count -lt 1) { return ($label + ": " + $field + " is missing or empty") }
  }
  $skill = @($j.skills)[0]
  foreach ($field in "id", "name", "description") {
    if ([string]$skill.$field -ceq "") { return ($label + ": skills[0]." + $field + " is missing or empty") }
  }
  if ($null -eq $skill.tags) { return ($label + ": skills[0].tags is missing") }
  $endpoint = $BASE + $A2A_PATH
  if ($version -ceq "1.0") {
    $iface = @($j.supportedInterfaces)[0]
    if ($null -eq $iface) { return ($label + ": supportedInterfaces[0] is missing") }
    if ([string]$iface.url -cne $endpoint) { return ($label + ": supportedInterfaces[0].url is '" + $iface.url + "', expected " + $endpoint) }
    if ([string]$iface.protocolBinding -cne "JSONRPC") { return ($label + ": supportedInterfaces[0].protocolBinding is '" + $iface.protocolBinding + "', expected JSONRPC") }
    if ([string]$iface.protocolVersion -cne "1.0") { return ($label + ": supportedInterfaces[0].protocolVersion is '" + $iface.protocolVersion + "', expected 1.0") }
  } else {
    if ([string]$j.protocolVersion -cne "0.3.0") { return ($label + ": protocolVersion is '" + $j.protocolVersion + "', expected 0.3.0") }
    if ([string]$j.url -cne $endpoint) { return ($label + ": url is '" + $j.url + "', expected " + $endpoint) }
    if ([string]$j.preferredTransport -cne "JSONRPC") { return ($label + ": preferredTransport is '" + $j.preferredTransport + "', expected JSONRPC") }
  }
  return ""
}
# The society name GET /api/official serves, read until it answers (these reads are not counted), or "" when it never did.
function Wait-ServedName {
  for ($n = 1; $n -le $RIDE_TRIES; $n++) {
    $official = Get-ServedOfficial
    if ($null -ne $official -and [string]$official.society -cne "") { return [string]$official.society }
    if ($n -lt $RIDE_TRIES) { Start-Sleep -Seconds $RIDE_DELAY_SECONDS }
  }
  return ""
}
# "" when the captured GET answer $r is a 200 card for $version carrying the required fields and the society name, otherwise the reason it is not.
function Test-CardAnswer($r, $version, $name, $path) {
  if ([string]$r.Code -cne "200") { return ("GET " + $path + " answered " + $r.Code + ", expected 200") }
  return (Test-CardServed $r $version $name)
}
# "" when $ans is an MCP door's answer to message/send at $path: -32601 naming this host's /a2a and the guest_enter instruction.
function Test-McpA2aAnswer($ans, $path, $method, $wantId) {
  $label = "POST " + $path + " " + $method
  $why = Test-RpcError $ans $label "200" "-32601" ($BASE + $A2A_PATH) $wantId $false
  if ($why -ne "") { return $why }
  return (Test-RpcError $ans $label "200" "-32601" ("POST " + $BASE + "/mcp and call guest_enter") $wantId $false)
}
# "" when $ans is an MCP door's answer to an ordinary unknown method at $path: -32601 with exactly today's text.
function Test-McpUnknownAnswer($ans, $path) {
  $label = "POST " + $path + " with an ordinary unknown method"
  $why = Test-RpcError $ans $label "200" "-32601" "" "8" $false
  if ($why -ne "") { return $why }
  $unknownText = [string](Read-JsonBody $ans).error.message
  if ($unknownText -cne $MCP_UNKNOWN_TEXT) { return ($label + ": the error message is '" + $unknownText + "', expected exactly today's text '" + $MCP_UNKNOWN_TEXT + "'") }
  return ""
}
# COUNTED: GET each card (agent_card), each retried until it passes. Returns "" or the last reason.
function Send-Cards($name, $attempts, $proved) {
  foreach ($spec in @(@("1.0", $CARD_V1_PATH), @("0.3", $CARD_V03_PATH))) {
    $version = $spec[0]
    $path = $spec[1]
    $why = Invoke-Counted "agent_card" $attempts $proved { Get-Text ($BASE + $path) 30 } { param($ans) Test-CardAnswer $ans $version $name $path }
    if ($why -ne "") { return $why }
  }
  return ""
}
# COUNTED: the three accepted sends to /a2a (a2a_send), each retried until it passes. Returns "" or the last reason.
function Send-A2aCounted($attempts, $proved) {
  $url = $BASE + $A2A_PATH
  $why = Invoke-Counted "a2a_send" $attempts $proved { Get-JsonPost $url $SEND_V1_BODY $V1_HEADER } { param($ans) Test-A2aSuccess $ans "POST /a2a SendMessage with A2A-Version: 1.0" "1.0" "ride-1" }
  if ($why -ne "") { return $why }
  $why = Invoke-Counted "a2a_send" $attempts $proved { Get-JsonPost $url $SEND_V03_BODY $NO_HEADER } { param($ans) Test-A2aSuccess $ans "POST /a2a message/send with no A2A-Version header" "0.3" "ride-2" }
  if ($why -ne "") { return $why }
  $why = Invoke-Counted "a2a_send" $attempts $proved { Get-JsonPost $url $NOTIFY_V03_BODY $NO_HEADER } { param($ans) Test-Notification $ans "POST /a2a message/send notification (no id)" }
  if ($why -ne "") { return $why }
  return ""
}
# COUNTED: to each MCP door, one message/send (mcp_a2a_probe, the new text) and one ordinary unknown method (mcp_unknown_method, today's text), each retried until it passes. Returns "" or the last reason.
function Send-McpCounted($attempts, $proved) {
  foreach ($path in $MCP_DOOR_PATHS) {
    $url = $BASE + $path
    foreach ($sendSpec in @(@("message/send", $MCP_A2A_BODY, "7"), @("SendMessage", $MCP_SENDMESSAGE_BODY, "9"))) {
      $sendMethod = $sendSpec[0]
      $sendBody = $sendSpec[1]
      $sendId = $sendSpec[2]
      $why = Invoke-Counted "mcp_a2a_probe" $attempts $proved { Get-JsonPost $url $sendBody $NO_HEADER } { param($ans) Test-McpA2aAnswer $ans $path $sendMethod $sendId }
      if ($why -ne "") { return $why }
    }
    $why = Invoke-Counted "mcp_unknown_method" $attempts $proved { Get-JsonPost $url $MCP_UNKNOWN_BODY $NO_HEADER } { param($ans) Test-McpUnknownAnswer $ans $path }
    if ($why -ne "") { return $why }
  }
  return ""
}
# The ordinary unknown method answers the same text from old and new code, so a stale answer can pass its judge without having been counted. When the door check still fails ONLY for mcp_unknown_method, this sends that
# request once more to each MCP door (until it passes again). It raises ATTEMPTS only: what the door check wants (PROVED) is not raised. Returns "" or the last reason.
function Resend-McpUnknown($attempts) {
  $unraised = @{ mcp_unknown_method = 0 }
  foreach ($path in $MCP_DOOR_PATHS) {
    $url = $BASE + $path
    $why = Invoke-Counted "mcp_unknown_method" $attempts $unraised { Get-JsonPost $url $MCP_UNKNOWN_BODY $NO_HEADER } { param($ans) Test-McpUnknownAnswer $ans $path }
    if ($why -ne "") { return $why }
  }
  return ""
}
# UNCOUNTED, so retried: GET /a2a is refused (405) and the /a2a refusals, which by the code and the local tests do not reach a counter (the ride does not measure that): a v1.0 SendMessage with NO header is -32601 naming message/send (gate C2), A2A-Version 9.9 is -32009,
# an undefined method is -32601, a malformed body is -32700 (HTTP 400), a contextId is -32004.
function Test-A2aUncounted {
  $url = $BASE + $A2A_PATH
  $g = Get-Text $url 30
  if ([string]$g.Code -cne "405") { return ("GET /a2a answered " + $g.Code + ", expected 405 (the route is POST only)") }
  $why = Test-RpcError (Get-JsonPost $url $SEND_V1_BODY $NO_HEADER) "POST /a2a SendMessage with NO A2A-Version header (read as 0.3)" "200" "-32601" "message/send" "ride-1" $true
  if ($why -ne "") { return $why }
  $why = Test-RpcError (Get-JsonPost $url $SEND_V1_BODY $V99_HEADER) "POST /a2a with A2A-Version 9.9" "200" "-32009" "" "ride-1" $true
  if ($why -ne "") { return $why }
  $why = Test-RpcError (Get-JsonPost $url $UNDEFINED_BODY $NO_HEADER) "POST /a2a with an undefined method" "200" "-32601" "message/send" "ride-4" $true
  if ($why -ne "") { return $why }
  $why = Test-RpcError (Get-JsonPost $url $MALFORMED_BODY $NO_HEADER) "POST /a2a with a malformed body" "400" "-32700" "" "null" $true
  if ($why -ne "") { return $why }
  $why = Test-RpcError (Get-JsonPost $url $CONTEXT_BODY $NO_HEADER) "POST /a2a with a contextId" "200" "-32004" "" "ride-5" $true
  if ($why -ne "") { return $why }
  return ""
}
# UNCOUNTED, so retried: a JSON null body to each MCP door is HTTP 400 with -32600 (not a 500).
function Test-McpUncounted {
  foreach ($path in $MCP_DOOR_PATHS) {
    $why = Test-RpcError (Get-JsonPost ($BASE + $path) $NULL_BODY $NO_HEADER) ("POST " + $path + " with a JSON null body") "400" "-32600" "" "null" $false
    if ($why -ne "") { return $why }
  }
  return ""
}
# BEFORE the deploy: the wave is not there yet, so both card paths and GET /a2a answer 404 (a 404 is never counted). "" or the reason.
function Test-WaveAbsent {
  foreach ($path in $CARD_V1_PATH, $CARD_V03_PATH, $A2A_PATH) {
    $r = Get-Text ($BASE + $path) 30
    if ([string]$r.Code -cne "404") { return ("GET " + $path + " answered " + $r.Code + ", expected 404") }
  }
  return ""
}
# The SHA-256 of the bytes a GET returned (curl's own output file, never a decoded string). Returns @{ Why; Sha }.
function Get-BodySha($url) {
  $tmp = [System.IO.Path]::GetTempFileName()
  try {
    $code = (curl.exe -s --max-time 30 -o $tmp -w "%{http_code}" $url)
    $exit = $LASTEXITCODE
    if ($exit -ne 0) { return @{ Why = ("GET " + $url + ": curl exited " + $exit); Sha = "" } }
    if ([string]$code -cne "200") { return @{ Why = ("GET " + $url + " answered " + $code + ", expected 200"); Sha = "" } }
    return @{ Why = ""; Sha = (Get-FileHash -Algorithm SHA256 -Path $tmp).Hash }
  } finally {
    Remove-Item $tmp -ErrorAction SilentlyContinue
  }
}
# @{ Why; Skill; Heartbeat }: the two files' hashes, or the reason one could not be read.
function Get-DocsHashes {
  $skill = Get-BodySha ($BASE + "/skill.md")
  if ($skill.Why -ne "") { return @{ Why = $skill.Why; Skill = ""; Heartbeat = "" } }
  $heartbeat = Get-BodySha ($BASE + "/heartbeat.md")
  if ($heartbeat.Why -ne "") { return @{ Why = $heartbeat.Why; Skill = ""; Heartbeat = "" } }
  return @{ Why = ""; Skill = $skill.Sha; Heartbeat = $heartbeat.Sha }
}
# "" when /skill.md and /heartbeat.md are byte-identical to the hashes read before the deploy, otherwise the reason they are not.
function Test-DocsUnchanged($before) {
  $now = Get-DocsHashes
  if ($now.Why -ne "") { return $now.Why }
  if ([string]$now.Skill -cne [string]$before.Skill) { return "/skill.md differs from what it was before the deploy (this wave must not change it)" }
  if ([string]$now.Heartbeat -cne [string]$before.Heartbeat) { return "/heartbeat.md differs from what it was before the deploy (this wave must not change it)" }
  return ""
}
# "" when /llms.txt names both cards and POST /a2a, /api/surface lists the three routes, and /openapi.json lists the two card GETs and NOT /a2a, otherwise the reason.
function Test-DiscoveryServed {
  $llms = Get-Text ($BASE + "/llms.txt") 30
  if ([string]$llms.Code -cne "200") { return ("GET /llms.txt answered " + $llms.Code + ", expected 200") }
  foreach ($path in $CARD_V1_PATH, $CARD_V03_PATH) {
    if (-not ([string]$llms.Body).Contains($BASE + $path)) { return ("GET /llms.txt does not name " + $path) }
  }
  if (-not ([string]$llms.Body).Contains("POST " + $BASE + $A2A_PATH + " ")) { return "GET /llms.txt does not list POST /a2a" }
  $surface = Get-Text ($BASE + "/api/surface") 30
  if ([string]$surface.Code -cne "200") { return ("GET /api/surface answered " + $surface.Code + ", expected 200") }
  $sj = Read-JsonBody $surface
  if ($null -eq $sj -or $null -eq $sj.routes) { return "GET /api/surface was not the route list" }
  $routes = @($sj.routes | ForEach-Object { $_.method + " " + $_.path })
  foreach ($want in ("GET " + $CARD_V1_PATH), ("GET " + $CARD_V03_PATH), ("POST " + $A2A_PATH)) {
    if (-not ($routes -ccontains $want)) { return ("GET /api/surface does not list " + $want) }
  }
  $spec = Get-Text ($BASE + "/openapi.json") 30
  if ([string]$spec.Code -cne "200") { return ("GET /openapi.json answered " + $spec.Code + ", expected 200") }
  $oj = Read-JsonBody $spec
  if ($null -eq $oj -or $null -eq $oj.paths) { return "GET /openapi.json was not an OpenAPI document" }
  $paths = @($oj.paths.PSObject.Properties | ForEach-Object { $_.Name })
  foreach ($path in $CARD_V1_PATH, $CARD_V03_PATH) {
    if (-not ($paths -ccontains $path)) { return ("GET /openapi.json does not list " + $path) }
    $pathItem = $oj.paths.PSObject.Properties[$path].Value
    if ($null -eq $pathItem -or $null -eq $pathItem.get) { return ("GET /openapi.json lists " + $path + " without a get operation") }
  }
  if ($paths -ccontains $A2A_PATH) { return "GET /openapi.json lists /a2a, which is a write route and must not be in the read-only document" }
  return ""
}
# The UTC day (yyyy-MM-dd) of a response's Date header, or "" when it has none or it does not parse. The server's clock, never this machine's.
function Get-HeaderDay($headText) {
  $lastRaw = ""
  foreach ($line in (([string]$headText) -split "`n")) {
    $one = $line.Trim()
    if ($one -imatch "^date:\s*(.*)$") { $lastRaw = $Matches[1].Trim() }
  }
  if ($lastRaw -ceq "") { return "" }
  try {
    $when = [System.DateTimeOffset]::ParseExact($lastRaw, "r", [System.Globalization.CultureInfo]::InvariantCulture, [System.Globalization.DateTimeStyles]::AssumeUniversal)
    return $when.UtcDateTime.ToString("yyyy-MM-dd", [System.Globalization.CultureInfo]::InvariantCulture)
  } catch {
    return ""
  }
}
# GET /api/doors with the response headers kept: @{ Why; Rows; Day }. Why is "" when it was read, the rows an array (possibly empty), and Day the server's UTC day. Never stops.
function Get-DoorsRead {
  $tmp = [System.IO.Path]::GetTempFileName()
  $hdr = [System.IO.Path]::GetTempFileName()
  try {
    $code = (curl.exe -s --max-time 30 -D $hdr -o $tmp -w "%{http_code}" ($BASE + "/api/doors"))
    $exit = $LASTEXITCODE
    if ($exit -ne 0) { return @{ Why = ("GET /api/doors: curl exited " + $exit); Rows = @(); Day = "" } }
    if ([string]$code -cne "200") { return @{ Why = ("GET /api/doors answered " + $code + ", expected 200"); Rows = @(); Day = "" } }
    $body = (Get-Content $tmp -Raw -ErrorAction SilentlyContinue)
    try { $j = ([string]$body | ConvertFrom-Json) } catch { return @{ Why = "GET /api/doors was not JSON"; Rows = @(); Day = "" } }
    if ($null -eq $j -or -not ($j.PSObject.Properties.Name -ccontains "rows")) { return @{ Why = "GET /api/doors carried no rows member"; Rows = @(); Day = "" } }
    if ($null -eq $j.rows) { return @{ Why = "GET /api/doors carried a null rows member"; Rows = @(); Day = "" } }
    $day = Get-HeaderDay (Get-Content $hdr -Raw -ErrorAction SilentlyContinue)
    if ($day -ceq "") { return @{ Why = "GET /api/doors carried no readable Date header, so the server's UTC day is unknown"; Rows = @(); Day = "" } }
    return @{ Why = ""; Rows = @($j.rows); Day = $day }
  } finally {
    Remove-Item $tmp -ErrorAction SilentlyContinue
    Remove-Item $hdr -ErrorAction SilentlyContinue
  }
}
# GET /api/doors until it is read (not a counted request), up to $RIDE_TRIES times; the last answer, good or not.
function Wait-DoorsRead {
  $last = @{ Why = "never read"; Rows = @(); Day = "" }
  for ($n = 1; $n -le $RIDE_TRIES; $n++) {
    $last = Get-DoorsRead
    if ($last.Why -eq "") { return $last }
    if ($n -lt $RIDE_TRIES) { Start-Sleep -Seconds $RIDE_DELAY_SECONDS }
  }
  return $last
}
# The four probe doors' figures for $day from the rows of GET /api/doors: door -> @{ N; AtCap; Present }. A door with no row for that day is Present false with N 0 (absent is 0, but it is never a pass for a door something was sent to).
function ConvertTo-DoorCounts($rows, $day) {
  $out = @{ _Why = "" }
  foreach ($door in $PROBE_DOOR_NAMES) { $out[$door] = @{ N = 0; AtCap = $false; Present = $false } }
  foreach ($row in @($rows)) {
    if ([string]$row.day -ceq [string]$day -and ($PROBE_DOOR_NAMES -contains [string]$row.door)) {
      $rawN = $row.n
      if ($rawN -is [bool] -or -not ($rawN -is [int] -or $rawN -is [long] -or $rawN -is [double] -or $rawN -is [decimal])) {
        $out["_Why"] = "GET /api/doors: the row for " + $row.door + " has a non-numeric n ('" + $rawN + "')"
        continue
      }
      if ($row.at_cap -isnot [bool]) {
        $out["_Why"] = "GET /api/doors: the row for " + $row.door + " has an at_cap that is not a boolean ('" + $row.at_cap + "')"
        continue
      }
      $out[[string]$row.door] = @{ N = [int]$rawN; AtCap = ($row.at_cap -eq $true); Present = $true }
    }
  }
  return $out
}
# Every probe door the round has PROVED a request for that does not show at least baseline + proved, and is not at_cap: @{ Door; Why } each, in door order. Pure: two parsed row sets and the proved counts.
# A missing row for a door something was proved for is never a pass.
function Get-DoorShortfalls($baseCounts, $nowCounts, $proved) {
  $out = @()
  foreach ($door in $PROBE_DOOR_NAMES) {
    $n = [int]$proved[$door]
    if ($n -le 0) { continue }
    $row = $nowCounts[$door]
    if (-not $row.Present) {
      $out += @{ Door = $door; Why = ("the door " + $door + " has no row for the day, although the ride proved " + $n + " request(s) to it") }
    } elseif ($row.N -lt ([int]$baseCounts[$door].N + $n) -and -not $row.AtCap) {
      $out += @{ Door = $door; Why = ("the door " + $door + " reads " + $row.N + ", expected at least " + ([int]$baseCounts[$door].N + $n) + " (baseline " + $baseCounts[$door].N + " + " + $n + " proved) or at_cap true") }
    }
  }
  return $out
}
# "" when every probe door the round proved a request for shows at least baseline + proved, or is at_cap, otherwise the first reason.
function Test-DoorRise($baseCounts, $nowCounts, $proved) {
  $short = @(Get-DoorShortfalls $baseCounts $nowCounts $proved)
  if ($short.Count -gt 0) { return [string]$short[0].Why }
  return ""
}
function Format-Counts($counts) {
  return ("agent_card " + $counts["agent_card"] + ", a2a_send " + $counts["a2a_send"] + ", mcp_a2a_probe " + $counts["mcp_a2a_probe"] + ", mcp_unknown_method " + $counts["mcp_unknown_method"])
}
# The attempts and the proved counts of every round, added up: @{ Attempts; Proved }.
function Get-RoundTotals($roundList) {
  $attempts = @{ agent_card = 0; a2a_send = 0; mcp_a2a_probe = 0; mcp_unknown_method = 0 }
  $proved = @{ agent_card = 0; a2a_send = 0; mcp_a2a_probe = 0; mcp_unknown_method = 0 }
  foreach ($one in @($roundList)) {
    foreach ($door in $PROBE_DOOR_NAMES) {
      $attempts[$door] = $attempts[$door] + $one.Attempts[$door]
      $proved[$door] = $proved[$door] + $one.Proved[$door]
    }
  }
  return @{ Attempts = $attempts; Proved = $proved }
}
# THE WAVE RIDE. Returns @{ Why; Attempts; Proved; Rounds }: Why is "" when everything passed; Attempts is every counted request actually sent and Proved the answers that passed, per probe door, TOTAL across rounds.
# Order: the uncounted checks first (each retried), then the counted requests (each retried until its answer passes), then the door check (retried), then, only if the door check failed for mcp_unknown_method alone, one resend of that request
# to each MCP door and the door check once more. If the UTC day changes between the baseline and the end of the sends it says so, takes a new baseline and sends the batch once more (at most one re-baseline).
function Invoke-WaveRide($docsBefore) {
  $roundList = @()
  $why = Confirm-Reads { return (Test-A2aUncounted) } $GOOD_READS_NEEDED $RIDE_TRIES $RIDE_DELAY_SECONDS
  if ($why -ne "") { return @{ Why = $why; Attempts = (Get-RoundTotals $roundList).Attempts; Proved = (Get-RoundTotals $roundList).Proved; Rounds = 0 } }
  Say "[ride] GET /a2a -> 405; POST /a2a: SendMessage with no A2A-Version header -> -32601 naming message/send (gate C2), A2A-Version 9.9 -> -32009, an undefined method -> -32601, a malformed body -> 400 -32700, a contextId -> -32004 ($GOOD_READS_NEEDED good reads in a row; these are routes that do not count by the code and by the local tests, and the ride does not measure that)"
  $why = Confirm-Reads { return (Test-McpUncounted) } $GOOD_READS_NEEDED $RIDE_TRIES $RIDE_DELAY_SECONDS
  if ($why -ne "") { return @{ Why = $why; Attempts = (Get-RoundTotals $roundList).Attempts; Proved = (Get-RoundTotals $roundList).Proved; Rounds = 0 } }
  Say "[ride] POST /mcp and POST /mcp/read with a JSON null body -> 400 -32600 ($GOOD_READS_NEEDED good reads in a row)"
  $why = Confirm-Reads { return (Test-DocsUnchanged $docsBefore) } $GOOD_READS_NEEDED $RIDE_TRIES $RIDE_DELAY_SECONDS
  if ($why -ne "") { return @{ Why = $why; Attempts = (Get-RoundTotals $roundList).Attempts; Proved = (Get-RoundTotals $roundList).Proved; Rounds = 0 } }
  Say "[ride] /skill.md and /heartbeat.md are byte-identical (SHA-256) to before the deploy"
  $why = Confirm-Reads { return (Test-DiscoveryServed) } $GOOD_READS_NEEDED $RIDE_TRIES $RIDE_DELAY_SECONDS
  if ($why -ne "") { return @{ Why = $why; Attempts = (Get-RoundTotals $roundList).Attempts; Proved = (Get-RoundTotals $roundList).Proved; Rounds = 0 } }
  Say "[ride] /llms.txt names both card paths and POST /a2a; /api/surface lists the three routes; /openapi.json lists the two card GETs and not /a2a"
  $name = Wait-ServedName
  if ($name -ceq "") { return @{ Why = "GET /api/official served no society name, so the cards' name cannot be compared"; Attempts = (Get-RoundTotals $roundList).Attempts; Proved = (Get-RoundTotals $roundList).Proved; Rounds = 0 } }
  $why = ""
  $rounds = 0
  for ($round = 1; $round -le 2; $round++) {
    $rounds = $round
    $attempts = @{ agent_card = 0; a2a_send = 0; mcp_a2a_probe = 0; mcp_unknown_method = 0 }
    $proved = @{ agent_card = 0; a2a_send = 0; mcp_a2a_probe = 0; mcp_unknown_method = 0 }
    $roundList += @{ Attempts = $attempts; Proved = $proved }
    $baseRead = Wait-DoorsRead
    if ($baseRead.Why -ne "") { $why = $baseRead.Why; break }
    $baseCounts = ConvertTo-DoorCounts $baseRead.Rows $baseRead.Day
    if ([string]$baseCounts["_Why"] -ne "") { $why = [string]$baseCounts["_Why"]; break }
    Say ("[ride] round " + $round + ": baseline read for UTC day " + $baseRead.Day + "; sending the counted requests, each retried until its answer passes (up to " + $RIDE_TRIES + " attempts): GET of each card, three accepted sends to /a2a, message/send and one unknown method to each MCP door")
    $why = Send-Cards $name $attempts $proved
    if ($why -eq "") { $why = Send-A2aCounted $attempts $proved }
    if ($why -eq "") { $why = Send-McpCounted $attempts $proved }
    if ($why -ne "") { break }
    Say ("[ride] round " + $round + " ATTEMPTS (every request sent): " + (Format-Counts $attempts) + "; PROVED (answers that passed): " + (Format-Counts $proved))
    $endRead = Wait-DoorsRead
    if ($endRead.Why -ne "") { $why = $endRead.Why; break }
    if ([string]$endRead.Day -cne [string]$baseRead.Day) {
      if ($round -eq 2) { $why = "the UTC day changed again during the second round (" + $baseRead.Day + " -> " + $endRead.Day + "); the door counts cannot be judged across two days"; break }
      Say ("[ride] the UTC day changed between the baseline (" + $baseRead.Day + ") and the end of the sends (" + $endRead.Day + "): the counts are split across two days and are not judged. Taking a NEW baseline and sending the same batch once more (it now runs twice in total).")
      continue
    }
    $riseCheck = {
      $now = Get-DoorsRead
      if ($now.Why -ne "") { return $now.Why }
      $nowCounts = ConvertTo-DoorCounts $now.Rows $baseRead.Day
      if ([string]$nowCounts["_Why"] -ne "") { return [string]$nowCounts["_Why"] }
      return (Test-DoorRise $baseCounts $nowCounts $proved)
    }
    $why = Confirm-Reads $riseCheck 2 $RIDE_TRIES $RIDE_DELAY_SECONDS
    if ($why -ne "") {
      $nowRead = Wait-DoorsRead
      if ($nowRead.Why -eq "") {
        $nowCounts = ConvertTo-DoorCounts $nowRead.Rows $baseRead.Day
        if ([string]$nowRead.Day -cne [string]$baseRead.Day) {
          $why = "the UTC day changed during the door check (" + $baseRead.Day + " -> " + $nowRead.Day + "), so the door counts could not be judged; this is not a finding that a door did not rise. Read GET /api/doors for " + $baseRead.Day + " by hand (last reason: " + $why + ")"
        } elseif ([string]$nowCounts["_Why"] -eq "") {
          $short = @(Get-DoorShortfalls $baseCounts $nowCounts $proved)
          if ($short.Count -eq 1 -and [string]$short[0].Door -ceq "mcp_unknown_method") {
            Say "[ride] only mcp_unknown_method is short: that request answers the same text from old and new code, so a stale answer can pass without being counted. Sending it a second time to each MCP door (attempts rise, what is wanted does not), then the door check once more."
            $whyResend = Resend-McpUnknown $attempts
            $afterRead = Wait-DoorsRead
            if ($whyResend -ne "") {
              $why = $whyResend
            } elseif ($afterRead.Why -ne "") {
              $why = $afterRead.Why
            } elseif ([string]$afterRead.Day -cne [string]$baseRead.Day) {
              $why = "the UTC day changed during the resend (" + $baseRead.Day + " -> " + $afterRead.Day + "), so the door counts could not be judged; this is not a finding that a door did not rise. Read GET /api/doors for " + $baseRead.Day + " and " + $afterRead.Day + " by hand"
            } else {
              $why = Confirm-Reads $riseCheck 2 $RIDE_TRIES $RIDE_DELAY_SECONDS
            }
          }
        }
      }
    }
    break
  }
  $totals = Get-RoundTotals $roundList
  return @{ Why = $why; Attempts = $totals.Attempts; Proved = $totals.Proved; Rounds = $rounds }
}
# The UTC clock, behind a function so a test can set it. The ride compares ONE UTC day's counts, so it is not started in the last half hour of a UTC day.
function Get-UtcNow { return [System.DateTime]::UtcNow }
function Test-ClockWindow($utcNow) {
  if ($utcNow.Hour -eq 23 -and $utcNow.Minute -ge 30) { return ("the UTC time is " + $utcNow.ToString("HH:mm", [System.Globalization.CultureInfo]::InvariantCulture) + ", 23:30 or later: run it after midnight UTC; the ride compares one UTC day's counts") }
  return ""
}
# END-OF-DEFINITIONS (nothing above runs git, npm, wrangler or the network)

# 0a. the two pins, BEFORE any git, npm, wrangler or network command: a placeholder is never a commit, and a malformed pin must not reach `git merge-base`
# BEGIN-PIN-CHECK
if ($LIVE_BASE_COMMIT -ceq $LIVE_BASE_PLACEHOLDER) { Stop-Here "`$LIVE_BASE_COMMIT still holds the placeholder '$LIVE_BASE_PLACEHOLDER': the hub sets it to the commit the live worker serves." }
if ($LIVE_BASE_COMMIT -cnotmatch '^[0-9a-f]{40}$') { Stop-Here "`$LIVE_BASE_COMMIT '$LIVE_BASE_COMMIT' is not 40 lower-case hex. Nothing was read or written." }
if ($REVIEWED_COMMIT -ceq $REVIEWED_COMMIT_PLACEHOLDER) { Stop-Here "`$REVIEWED_COMMIT still holds the placeholder '$REVIEWED_COMMIT_PLACEHOLDER': the hub sets it to the commit the review converged on." }
if ($REVIEWED_COMMIT -cnotmatch '^[0-9a-f]{40}$') { Stop-Here "`$REVIEWED_COMMIT '$REVIEWED_COMMIT' is not 40 lower-case hex. Nothing was read or written." }
# END-PIN-CHECK

# 0b. the UTC clock, BEFORE any git, npm, wrangler or network command
# BEGIN-CLOCK-CHECK
$clockWhy = Test-ClockWindow (Get-UtcNow)
if ($clockWhy -ne "") { Stop-Here $clockWhy }
# END-CLOCK-CHECK

# 0. the commit: fetch, then main, origin/main and the expected sha must be ONE commit, on a clean tree
Say "[git] git fetch origin"
git fetch origin --quiet
if ($LASTEXITCODE -ne 0) { Stop-Here "git fetch failed; the level check below would read a stale origin/main." }
$branch = (git rev-parse --abbrev-ref HEAD).Trim()
if ($branch -cne "main") { Stop-Here "the current branch is '$branch', not main: deploy from main only." }
$headSha = (git rev-parse HEAD).Trim()
$originSha = (git rev-parse origin/main).Trim()
$mainSha = (git rev-parse main).Trim()
$ErrorActionPreference = "Continue"
$expectedSha = (git rev-parse --verify ($ExpectedCommit + "^{commit}"))
$expectedCode = $LASTEXITCODE
$ErrorActionPreference = "Stop"
if ($expectedCode -ne 0 -or -not $expectedSha) { Stop-Here "-ExpectedCommit '$ExpectedCommit' is not a commit in this repository." }
$expectedSha = ([string]$expectedSha).Trim()
if ($mainSha -cne $originSha -or $mainSha -cne $expectedSha -or $headSha -cne $expectedSha) {
  Stop-Here ("main, origin/main and -ExpectedCommit are not one commit: HEAD " + $headSha.Substring(0, 8) + ", main " + $mainSha.Substring(0, 8) + ", origin/main " + $originSha.Substring(0, 8) + ", expected " + $expectedSha.Substring(0, 8) + ".")
}
if ($headSha -cnotmatch '^[0-9a-f]{40}$') { Stop-Here "HEAD '$headSha' is not 40 lower-case hex: it could not be stamped (the Worker would serve malformed_stamp)." }
$dirty = @(git status --porcelain)
if ($LASTEXITCODE -ne 0) { Stop-Here "git status failed (exit $LASTEXITCODE): the clean-tree check cannot be read." }
if ($dirty.Count -gt 0) { Stop-Here ("working tree not clean (" + $dirty.Count + " paths): the deploy must ship exactly the committed tree.") }
git merge-base --is-ancestor $LIVE_BASE_COMMIT HEAD
if ($LASTEXITCODE -ne 0) { Stop-Here "HEAD does not contain $($LIVE_BASE_COMMIT.Substring(0, 8)) (the live worker's code): this deploy would drop the waves before it." }
# Non-minting, no migration: src/doc.ts (which holds FRONT_DOOR_TEMPLATE), migrations/ and schema.sql must not have moved since the live code.
$moves = @(git diff --name-status --no-renames $LIVE_BASE_COMMIT HEAD -- src/doc.ts migrations schema.sql)
if ($LASTEXITCODE -ne 0) { Stop-Here "git diff failed (exit $LASTEXITCODE): the no-mint and no-migration check cannot be read." }
if ($moves.Count -gt 0) { Stop-Here ("src/doc.ts, migrations/ or schema.sql changed since " + $LIVE_BASE_COMMIT.Substring(0, 8) + " (" + ($moves -join " | ") + "): this wave mints nothing and has no migration. Not this script's deploy.") }
# BEGIN-REVIEWED-SOURCE-CHECK
git merge-base --is-ancestor $REVIEWED_COMMIT HEAD
if ($LASTEXITCODE -ne 0) { Stop-Here "HEAD does not contain the reviewed commit $($REVIEWED_COMMIT.Substring(0, 8)): this is not the code that was reviewed." }
$afterReview = @(git diff --name-only --no-renames $REVIEWED_COMMIT HEAD)
if ($LASTEXITCODE -ne 0) { Stop-Here "git diff failed (exit $LASTEXITCODE): the changes since the reviewed commit cannot be read." }
$unreviewed = @(Get-DisallowedPaths $afterReview)
if ($unreviewed.Count -gt 0) { Stop-Here ("these paths changed since the reviewed commit " + $REVIEWED_COMMIT.Substring(0, 8) + " and are not on the allowlist (" + ($ALLOWED_PATHS_AFTER_REVIEW -join ", ") + "), so what would ship is not what was reviewed: " + ($unreviewed -join ", ")) }
Say ("[git] reviewed source: HEAD differs from " + $REVIEWED_COMMIT.Substring(0, 8) + " in " + $afterReview.Count + " path(s), all on the allowlist")
# END-REVIEWED-SOURCE-CHECK
if (-not (Select-String -Path "src/discovery.ts" -Pattern "export const UNVALIDATED: Record<string, UnvalidatedBehaviour>" -SimpleMatch -Quiet)) { Stop-Here "src/discovery.ts has no UNVALIDATED behaviour table: this checkout is not the response-side wave." }
if (-not (Select-String -Path "src/discovery.ts" -Pattern "function behaviourExtension(" -SimpleMatch -Quiet)) { Stop-Here "src/discovery.ts does not render the x-clamped / x-ignored-when-invalid extensions: this checkout is not the response-side wave." }
if (-not (Select-String -Path "src/discovery.ts" -Pattern "const ROW_ID_PATH_PARAM" -SimpleMatch -Quiet)) { Stop-Here "src/discovery.ts does not declare the row-id path pattern: this checkout is not the response-side wave." }
if (-not (Select-String -Path "src/discovery.ts" -Pattern "responseSchema: COUNCIL_THREAD_RESPONSE_SCHEMA" -SimpleMatch -Quiet)) { Stop-Here "src/discovery.ts does not declare the /api/council/thread schema: this checkout is not the response-side wave." }
if (-not (Select-String -Path "src/discovery.ts" -Pattern "has no pathParams declaration" -SimpleMatch -Quiet)) { Stop-Here "src/discovery.ts does not refuse an undeclared path variable: this checkout would drop the request-side wave." }
if (-not (Select-String -Path "src/maintainer/parked.ts" -Pattern "export async function parkedPage" -SimpleMatch -Quiet)) { Stop-Here "src/maintainer/parked.ts has no parkedPage: this checkout would drop the parked-list wave." }
if (-not (Select-String -Path "src/discovery.ts" -Pattern "schema: r.responseSchema ??" -SimpleMatch -Quiet)) { Stop-Here "src/discovery.ts does not use responseSchema in renderOpenApi: this checkout is not the openapi schema wave." }
if (-not (Select-String -Path "src/discovery.ts" -Pattern "responseSchema: PROPOSAL_RESPONSE_SCHEMA" -SimpleMatch -Quiet)) { Stop-Here "src/discovery.ts does not declare the /api/proposal/:id schema: this checkout would drop the openapi proposal schema wave." }
if (-not (Select-String -Path "src/discovery.ts" -Pattern "responseSchema: RESIDENTS_RESPONSE_SCHEMA" -SimpleMatch -Quiet)) { Stop-Here "src/discovery.ts does not declare the /api/residents schema: this checkout is not the resident schema wave." }
if (-not (Select-String -Path "src/discovery.ts" -Pattern "responseSchema: RESIDENT_RESPONSE_SCHEMA" -SimpleMatch -Quiet)) { Stop-Here "src/discovery.ts does not declare the /api/resident/:number schema: this checkout is not the resident schema wave." }
if (-not (Select-String -Path "src/doors.ts" -Pattern 'export const STAMPS_SINCE = "15 November 2026";' -SimpleMatch -Quiet)) { Stop-Here "src/doors.ts does not carry STAMPS_SINCE: this checkout is not the resident schema wave." }
if (-not (Select-String -Path "src/doors.ts" -Pattern "INSERT OR IGNORE INTO commit_days" -SimpleMatch -Quiet)) { Stop-Here "src/doors.ts does not write commit_days: this checkout would drop the 15 Nov recovery-unit wave." }
if (-not (Select-String -Path "src/maintainer/judgment.ts" -Pattern "not judged (the model declined); skipped this wake" -SimpleMatch -Quiet)) { Stop-Here "src/maintainer/judgment.ts does not name a refused item: this checkout would drop the refusal-skip wave." }
if (-not (Select-String -Path "src/maintainer/runs.ts" -Pattern "a judgment item the model declined to judge" -SimpleMatch -Quiet)) { Stop-Here "src/maintainer/runs.ts note lacks the refusal sentence: this checkout would drop the refusal-skip wave." }
if (-not (Select-String -Path "src/governance.ts" -Pattern "export function assertProposalsQuery(" -SimpleMatch -Quiet)) { Stop-Here "src/governance.ts has no assertProposalsQuery: this checkout would drop the proposals unknown-params wave." }
if (-not (Select-String -Path "src/modstate.ts" -Pattern "export function modPlaceholder(" -SimpleMatch -Quiet)) { Stop-Here "src/modstate.ts has no modPlaceholder: this checkout would drop the moderation-gaps wave." }
if (-not (Select-String -Path "src/governance.ts" -Pattern "SELECT seq FROM sqlite_sequence WHERE name = 'proposals'" -SimpleMatch -Quiet)) { Stop-Here "src/governance.ts does not read sqlite_sequence for proposals: this checkout is not the high-water wave." }
if (-not (Select-String -Path "src/governance.ts" -Pattern 'PROPOSALS_SEQUENCE_BASELINE = { migration: "0007_first_laws", applied: "2026-08-18" }' -SimpleMatch -Quiet)) { Stop-Here "src/governance.ts does not carry the 0007 baseline: this checkout is not the note-epoch wave." }
if (-not (Select-String -Path "src/governance.ts" -Pattern "MAX(id) AS max_id," -SimpleMatch -Quiet)) { Stop-Here "src/governance.ts does not read MAX(id) AS max_id: this checkout would drop the max_id wave." }
if (-not (Select-String -Path "src/mcp.ts" -Pattern "Register as a citizen" -SimpleMatch -Quiet)) { Stop-Here "src/mcp.ts has no register free-path title: this checkout would drop the register free-path wave." }
if (-not (Select-String -Path "src/operators.ts" -Pattern "export async function handleOperators" -SimpleMatch -Quiet)) { Stop-Here "src/operators.ts has no handleOperators: this checkout is not the operators' page wave." }
if (-not (Select-String -Path "src/doors.ts" -Pattern '"operators_page",' -SimpleMatch -Quiet)) { Stop-Here "src/doors.ts has no operators_page door: this checkout is not the operators' page wave." }
if (-not (Select-String -Path "src/index.ts" -Pattern 'path === "/operators" && method === "GET"' -SimpleMatch -Quiet)) { Stop-Here "src/index.ts does not route GET /operators: this checkout is not the operators' page wave." }
if (-not (Select-String -Path "src/guest-core.ts" -Pattern "export const OPERATORS_POINTER" -SimpleMatch -Quiet)) { Stop-Here "src/guest-core.ts has no OPERATORS_POINTER: this checkout is not the operators' pointer wave." }
if (-not (Select-String -Path "src/mcp.ts" -Pattern "OPERATORS_POINTER + " -SimpleMatch -Quiet)) { Stop-Here "src/mcp.ts does not serve OPERATORS_POINTER: this checkout is not the operators' pointer wave." }
if (-not (Select-String -Path "src/mcp-read.ts" -Pattern "OPERATORS_POINTER + " -SimpleMatch -Quiet)) { Stop-Here "src/mcp-read.ts does not serve OPERATORS_POINTER: this checkout is not the operators' pointer wave." }
if (-not (Select-String -Path "src/society.ts" -Pattern "async function commitRotation(" -SimpleMatch -Quiet)) { Stop-Here "src/society.ts has no commitRotation: this checkout is not the rotateKey batch wave." }
if (-not (Select-String -Path "src/society.ts" -Pattern "const ROTATION_RACED_MESSAGE = " -SimpleMatch -Quiet)) { Stop-Here "src/society.ts has no ROTATION_RACED_MESSAGE: this checkout is not the rotateKey batch wave." }
if (-not (Select-String -Path "src/society.ts" -Pattern 'UPDATE citizens SET secret_hash = ? WHERE id = ? AND secret_hash = ?' -SimpleMatch -Quiet)) { Stop-Here "src/society.ts does not compare-and-set the secret: this checkout is not the rotateKey batch wave." }
if (-not (Select-String -Path "src/wallets.ts" -Pattern "const WALLET_RACED_MESSAGE =" -SimpleMatch -Quiet)) { Stop-Here "src/wallets.ts has no WALLET_RACED_MESSAGE: this checkout is not the wallet batch wave." }
if (-not (Select-String -Path "src/wallets.ts" -Pattern "UPDATE wallets SET address = ?, added_at = MAX(?, added_at + 1) WHERE citizen_id = ? AND address = ? AND added_at = ?" -SimpleMatch -Quiet)) { Stop-Here "src/wallets.ts does not compare-and-set the wallet row: this checkout is not the wallet batch wave." }
if (-not (Select-String -Path "src/chain.ts" -Pattern "export function parseUniqueColumns(" -SimpleMatch -Quiet)) { Stop-Here "src/chain.ts has no parseUniqueColumns: this checkout is not the wallet batch wave." }
if (-not (Select-String -Path "src/a2a.ts" -Pattern "A2A-Version not supported: this endpoint speaks 0.3 and 1.0." -SimpleMatch -Quiet)) { Stop-Here "src/a2a.ts has no version refusal: this checkout is not the agent card / A2A wave." }
if (-not (Select-String -Path "src/a2a.ts" -Pattern "export function mcpUnknownMethod(" -SimpleMatch -Quiet)) { Stop-Here "src/a2a.ts has no mcpUnknownMethod: this checkout is not the agent card / A2A wave." }
if (-not (Select-String -Path "src/a2a-cards.ts" -Pattern "export function agentCardV03(" -SimpleMatch -Quiet)) { Stop-Here "src/a2a-cards.ts has no agentCardV03: this checkout is not the agent card / A2A wave." }
if (-not (Select-String -Path "src/doors.ts" -Pattern 'export const PROBE_DOORS = ["agent_card", "a2a_send", "mcp_a2a_probe", "mcp_unknown_method"] as const;' -SimpleMatch -Quiet)) { Stop-Here "src/doors.ts has no probe doors: this checkout is not the agent card / A2A wave." }
if (-not (Select-String -Path "src/index.ts" -Pattern 'if (path === "/a2a") return await handleA2a(request, env, ctx);' -SimpleMatch -Quiet)) { Stop-Here "src/index.ts does not route /a2a: this checkout is not the agent card / A2A wave." }
if (-not (Select-String -Path "src/mcp.ts" -Pattern 'if (msg === null || typeof msg !== "object") {' -SimpleMatch -Quiet)) { Stop-Here "src/mcp.ts has no non-object body guard: this checkout is not the agent card / A2A wave." }
if (-not (Select-String -Path "src/mcp-read.ts" -Pattern 'if (msg === null || typeof msg !== "object") {' -SimpleMatch -Quiet)) { Stop-Here "src/mcp-read.ts has no non-object body guard: this checkout is not the agent card / A2A wave." }
if (-not (Select-String -Path "src/privacy.ts" -Pattern "export async function handlePrivacy" -Quiet)) { Stop-Here "src/privacy.ts has no handlePrivacy: this checkout would drop the privacy page." }
if (-not (Select-String -Path "src/code-identity.ts" -Pattern "export function codeBlock" -Quiet)) { Stop-Here "src/code-identity.ts has no codeBlock: this checkout would drop served code identity." }
if (-not (Select-String -Path "wrangler.jsonc" -Pattern '"version_metadata"' -Quiet)) { Stop-Here "wrangler.jsonc has no version_metadata binding: the Worker could not serve Cloudflare's version id." }
if (Select-String -Path "wrangler.jsonc" -Pattern '"CODE_COMMIT"' -Quiet) { Stop-Here "wrangler.jsonc configures a CODE_COMMIT var: a deploy that forgot the flag would serve a stale stamp. The stamp comes from this script's --var flag only." }
Say ("[git] HEAD " + $headSha.Substring(0, 8) + " = main = origin/main = -ExpectedCommit; tree clean; contains " + $LIVE_BASE_COMMIT.Substring(0, 8) + "; src/doc.ts, migrations and schema.sql unmoved")

# 1. the wave's own gates, re-run here so a stale checkout cannot deploy
# BEGIN-GATES
$ErrorActionPreference = "Continue"
$testOut = (npm test 2>&1 | Out-String)
$testCode = $LASTEXITCODE
$tscOut = (npm run typecheck 2>&1 | Out-String)
$tscCode = $LASTEXITCODE
$ErrorActionPreference = "Stop"
$failLine = [regex]::Matches($testOut, '(?m)^(?:\S+[ \t]+)?fail (\d+)[ \t]*\r?$')
$passLine = [regex]::Matches($testOut, '(?m)^(?:\S+[ \t]+)?pass (\d+)[ \t]*\r?$')
if ($failLine.Count -lt 1 -or $passLine.Count -lt 1) { Stop-Here "npm test: exit $testCode, the output carries no pass/fail summary: the run did not finish." }
$failN = $failLine[$failLine.Count - 1].Groups[1].Value
$passN = $passLine[$passLine.Count - 1].Groups[1].Value
if ($testCode -ne 0 -or $failN -ne "0" -or $passN -eq "0") { Stop-Here ("npm test: exit " + $testCode + ", pass '" + $passN + "', fail '" + $failN + "'.") }
if ($tscCode -ne 0) { Stop-Here "typecheck failed: $tscOut" }
Say ("[tests] pass " + $passN + ", fail 0; typecheck clean")
# END-GATES

# 2. live, before: non-minting baseline, the live worker is the base this wave was checked against, GET /operators answers 200, both initialise answers carry the pointer (the previous wave is live), the rotate and wallet routes refuse the three credential-free requests each that the ride repeats.
# These reads are before any write, so one read is the state and may stop.
$attBefore = Read-Attest "before the deploy"
Assert-Attest $attBefore "before the deploy"
Say ("[live] before: v6 " + $V6_HASH.Substring(0, 8) + "; all four chains ok; identity " + $attBefore.identity_log.sealed_entries + ", treasury " + $attBefore.treasury.sealed_entries + ", ballots " + $attBefore.ballots.sealed_entries)
if ($null -eq $attBefore.code -or [string]$attBefore.code.commit_status -cne "stamped") { Stop-Here "GET /api/attest serves no stamped code.commit before the deploy: the live worker cannot be shown to be the base this wave was checked against." }
if ([string]$attBefore.code.commit -ceq $headSha) { Stop-Here "GET /api/attest already serves code.commit $($headSha.Substring(0, 8)): this commit looks already deployed. Verify by hand." }
if ([string]$attBefore.code.commit -cne $LIVE_BASE_COMMIT) { Stop-Here ("the live worker serves code.commit " + $attBefore.code.commit + " but `$LIVE_BASE_COMMIT is " + $LIVE_BASE_COMMIT + ": the base this wave was checked against is not what is live. Correct the pin only after reading what changed.") }
$rollbackTarget = "the version before it (check npx wrangler deployments list)"
if ([string]$attBefore.code.version_status -ceq "available" -and $attBefore.code.version_id) { $rollbackTarget = [string]$attBefore.code.version_id }
Say "[live] before: the live worker serves the pinned base $($LIVE_BASE_COMMIT.Substring(0, 8)); rollback target $rollbackTarget"
$pageBefore = Get-Text $PAGE_URL 30
if ([string]$pageBefore.Code -cne "200") { Stop-Here ("GET /operators answered " + $pageBefore.Code + " before the deploy, expected 200 (the operators page wave is live): read it by hand.") }
Say "[live] before: GET /operators answers 200"
# Before the deploy BOTH initialise answers carry the pointer once (the previous wave is live). Credential-free initialize POSTs: a read, writing only a door count.
$whyPointerBefore = Test-PointerServed
if ($whyPointerBefore -ne "") { Stop-Here ("before the deploy, " + $whyPointerBefore + ": the previous wave is not as expected, read it by hand.") }
Say "[live] before: both initialise answers carry the operators pointer exactly once"
# Before the deploy the rotate route refuses the three credential-free requests exactly as the ride will expect after it (gate C1). They write nothing.
$whyRotateBefore = Test-RotateRefusals
if ($whyRotateBefore -ne "") { Stop-Here ("before the deploy, " + $whyRotateBefore + ": the ride's expectation does not hold on the live worker, read it by hand.") }
Say "[live] before: POST /api/rotate refuses no credential (401 No credentials) and a bearer that is no citizen's secret (401 Unknown secret); GET /api/rotate -> 404"
# The same three for the wallet route: this wave's route, read before the deploy so the ride shows it still refuses as it did.
$whyWalletBefore = Test-WalletRefusals
if ($whyWalletBefore -ne "") { Stop-Here ("before the deploy, " + $whyWalletBefore + ": the ride's expectation does not hold on the live worker, read it by hand.") }
Say "[live] before: POST /api/wallet refuses no credential (401 No credentials) and a bearer that is no citizen's secret (401 Unknown secret); GET /api/wallet -> 404"
# The A2A wave is not live yet (both card paths and GET /a2a answer 404: a 404 is never counted), and /skill.md and /heartbeat.md are read now so the ride can show they did not change.
$whyAbsent = Test-WaveAbsent
if ($whyAbsent -ne "") { Stop-Here ("before the deploy, " + $whyAbsent + ": the A2A wave is already live or those routes answer something else; read it by hand.") }
Say "[live] before: GET /.well-known/agent-card.json, GET /.well-known/agent.json and GET /a2a answer 404 (the wave is not live yet)"
$docsBefore = Get-DocsHashes
if ($docsBefore.Why -ne "") { Stop-Here ("before the deploy, " + $docsBefore.Why + ": /skill.md and /heartbeat.md cannot be hashed for the after-comparison.") }
Say "[live] before: /skill.md and /heartbeat.md read; their SHA-256 are kept for the ride (each GET attempts a count on its own door)"

if ($DryRun) {
  Say "[dry-run] every pin, git, source, test and live check passed. Step 2 itself already sent one GET /operators, two credential-free initialize POSTs (operators_page, mcp_initialize and mcp_read_initialize are counted doors: each request attempts a count, so each rises by that many unless it is at its cap), three refused rotate requests and three refused wallet requests (which write nothing), plain reads that count nothing (GET /api/attest, and the GET /api/rotate and GET /api/wallet that answer 404), one GET of /skill.md and one of /heartbeat.md (read for their SHA-256; both are counted doors, so each attempts a count), and three GETs (the two card paths and /a2a) that must answer 404 and are never counted. It sent NONE of the ride's POSTs to /a2a, /mcp or /mcp/read (the only POSTs to /mcp and /mcp/read are the two initialize reads above), no JSON-RPC send, and no wrangler command at all (this script runs no D1 command of its own). Every counted-door request also attempts a commit_days stamp row for today's date and the live commit. would now: run npx wrangler deploy --var CODE_COMMIT:<the full sha> and capture its Current Version ID (refusing to continue without one); poll up to $POLL_TRIES times, $POLL_DELAY_SECONDS s apart, until $GOOD_READS_NEEDED reads in a row show GET /api/attest serving that commit and version id, GET /operators the page and both initialise answers the pointer; then ride the rotate and wallet refusals, the earlier waves, the public reads and the A2A wave (the uncounted checks each retried up to $RIDE_TRIES reads, $GOOD_READS_NEEDED good in a row; then the COUNTED requests, each retried until its answer passes (up to $RIDE_TRIES attempts): GET of each card (2, agent_card), SendMessage with the 1.0 header, message/send with no header and a message/send notification (3, a2a_send), message/send and SendMessage, each to /mcp and to /mcp/read (4, mcp_a2a_probe), one ordinary unknown method to each (2, mcp_unknown_method); and the door check). A clean ride proves 11 counted requests, and any retry adds to the attempts; all of them would be in the day's door figures. Nothing was deployed."
  exit 0
}

# 3. deploy the worker with the commit stamp, capturing its version id, then poll until the served identity is this deploy's
# BEGIN-DEPLOY-AND-POLL
# CODEX r1 (finding 2): tests, typecheck and the live reads ran since step 0, and wrangler bundles the working tree, so HEAD and a clean
# tree are re-read here, immediately before the bundle, or the stamp could name a commit the uploaded bytes no longer match.
$headNow = (git rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $headNow -cne $headSha) { Stop-Here ("HEAD moved since step 0 (" + $headSha.Substring(0, 8) + " -> " + $headNow + "): nothing was deployed.") }
$dirtyNow = @(git status --porcelain)
if ($LASTEXITCODE -ne 0) { Stop-Here "git status failed (exit $LASTEXITCODE) just before the deploy: nothing was deployed." }
if ($dirtyNow.Count -gt 0) { Stop-Here ("the working tree changed since step 0 (" + $dirtyNow.Count + " paths: " + ($dirtyNow -join " | ") + "): nothing was deployed.") }
Say "[deploy] npx wrangler deploy --var CODE_COMMIT:$($headSha.Substring(0, 8))... (commit $($headSha.Substring(0, 8)))"
$ErrorActionPreference = "Continue"
$deployOut = (npx wrangler deploy --var "CODE_COMMIT:$headSha" 2>&1 | Out-String)
$deployCode = $LASTEXITCODE
$ErrorActionPreference = "Stop"
if ($deployCode -ne 0) { Stop-Here "wrangler deploy failed (exit $deployCode); this wave applied no migration, so there is nothing else to undo. Output: $deployOut" }
$versionMatches = @([regex]::Matches($deployOut, '(?m)^[ \t]*Current Version ID:[ \t]*([0-9a-fA-F-]{36})[ \t]*\r?$'))
if ($versionMatches.Count -gt 1) { Stop-Here ("wrangler deploy printed 'Current Version ID' on " + $versionMatches.Count + " lines; which one is this deploy's cannot be told. Check 'npx wrangler deployments list' by hand before anything else.") }
if ($versionMatches.Count -lt 1) { Stop-Here "wrangler deploy exited 0 but printed no 'Current Version ID'; the deploy may have succeeded. Check 'npx wrangler deployments list' by hand before anything else." }
$versionId = $versionMatches[0].Groups[1].Value
Say "[deploy] worker version id $versionId (commit $($headSha.Substring(0, 8)))"
$ROLLBACK_LINE = "ROLL BACK THE WORKER (npx wrangler rollback, to the version before $versionId, which should be $rollbackTarget; check npx wrangler deployments list first). This wave applied no migration and changed no schema, so the rollback is the whole undo."
Wait-NewWorker $headSha $versionId $POLL_TRIES $POLL_DELAY_SECONDS
# END-DEPLOY-AND-POLL
# 4. the ride (L-167: every check below is retried until $GOOD_READS_NEEDED good reads in a row, up to $RIDE_TRIES reads, before it judges; a stop here means the retries ran out, so the
# message says to read the deployments list by hand first, and only then names the rollback): non-minting and the chains, the rotate and wallet refusals, the operators page against GET /api/official, both initialise answers carrying the pointer, /llms.txt carrying the new note sentence, then a sweep of public reads.
$whyAttest = Confirm-Reads {
  $a = Get-ServedAttest
  $m = Get-AttestReason $a
  if ($m -ne "") { return $m }
  # CODEX r1 (finding 1): the ride's own attest read must still be this deploy's, not only the poll's.
  return (Test-CodeIdentityServed $a.code $headSha $versionId)
} $GOOD_READS_NEEDED $RIDE_TRIES $RIDE_DELAY_SECONDS
if ($whyAttest -ne "") { Stop-Here ("GET /api/attest was not confirmed after the deploy in " + $RIDE_TRIES + " reads (last: " + $whyAttest + "). Read npx wrangler deployments list by hand first: another deploy may have taken over, or the edge is still catching up. Only if that shows the new version is not live: " + $ROLLBACK_LINE) }
Say ("[ride] attest: v6 " + $V6_HASH.Substring(0, 8) + " unchanged; every chain ok; code.commit " + $headSha.Substring(0, 8) + ", code.version_id " + $versionId + " ($GOOD_READS_NEEDED good reads in a row)")
$whyRotate = Confirm-Reads { return (Test-RotateRefusals) } $GOOD_READS_NEEDED $RIDE_TRIES $RIDE_DELAY_SECONDS
if ($whyRotate -ne "") { Stop-Here ("the rotate route was not confirmed to refuse as before in " + $RIDE_TRIES + " reads (last: " + $whyRotate + "). Read npx wrangler deployments list and POST /api/rotate by hand first. Only if the new version is at 100% and fresh reads still disagree: " + $ROLLBACK_LINE) }
Say "[ride] POST /api/rotate -> 401 No credentials, 401 Unknown secret; GET /api/rotate -> 404 ($GOOD_READS_NEEDED good reads in a row). The earlier wave still refuses."
$whyWallet = Confirm-Reads { return (Test-WalletRefusals) } $GOOD_READS_NEEDED $RIDE_TRIES $RIDE_DELAY_SECONDS
if ($whyWallet -ne "") { Stop-Here ("the wallet route was not confirmed to refuse as before in " + $RIDE_TRIES + " reads (last: " + $whyWallet + "). Read npx wrangler deployments list and POST /api/wallet by hand first. Only if the new version is at 100% and fresh reads still disagree: " + $ROLLBACK_LINE) }
Say "[ride] POST /api/wallet -> 401 No credentials, 401 Unknown secret; GET /api/wallet -> 404 ($GOOD_READS_NEEDED good reads in a row). These show the route still refuses; only the stamp above shows the batch is the code now serving. The first real declaration is the first production execution of the batch."
$whyPage = Confirm-Reads { return (Test-OperatorsServed (Get-Page $PAGE_URL 30) (Get-ServedOfficial)) } $GOOD_READS_NEEDED $RIDE_TRIES $RIDE_DELAY_SECONDS
if ($whyPage -ne "") { Stop-Here ("GET /operators was not confirmed to be the operators page in " + $RIDE_TRIES + " reads (last: " + $whyPage + "). Read npx wrangler deployments list and the page by hand first. Only if the new version is at 100% and fresh reads still disagree: " + $ROLLBACK_LINE) }
Say "[ride] GET /operators -> 200 still: text/html, the exact Content-Security-Policy and X-Content-Type-Options, no script, form, link, img or iframe, the opening sentence and the paste, and the four figures and the resident count equal to GET /api/official read in the same iteration"
$whyPointer = Confirm-Reads { return (Test-PointerServed) } $GOOD_READS_NEEDED $RIDE_TRIES $RIDE_DELAY_SECONDS
if ($whyPointer -ne "") { Stop-Here ("the initialise answers were not confirmed to carry the pointer in " + $RIDE_TRIES + " reads (last: " + $whyPointer + "). Read npx wrangler deployments list and both initialise answers by hand first. Only if the new version is at 100% and fresh reads still disagree: " + $ROLLBACK_LINE) }
Say "[ride] /mcp and /mcp/read initialize -> each carries the operators pointer exactly once ($GOOD_READS_NEEDED good reads in a row)"
$whyNote = Confirm-Reads { return (Test-NoteServed) } $GOOD_READS_NEEDED $RIDE_TRIES $RIDE_DELAY_SECONDS
if ($whyNote -ne "") { Stop-Here ("GET /llms.txt was not confirmed to carry the operator-note sentence in " + $RIDE_TRIES + " reads (last: " + $whyNote + "). Read npx wrangler deployments list and re-read it by hand first. Only if the new version is at 100% and fresh reads still disagree: " + $ROLLBACK_LINE) }
Say "[ride] GET /llms.txt -> 200 and still carries the operator-note sentence"
# The A2A wave: the uncounted checks (retried), the counted requests (each retried until its answer passes) and the door check. See the header and Invoke-WaveRide.
$rideResult = Invoke-WaveRide $docsBefore
$whyWave = [string]$rideResult.Why
$attemptsLine = Format-Counts $rideResult.Attempts
$provedLine = Format-Counts $rideResult.Proved
if ($whyWave -ne "") { Stop-Here ("the A2A wave ride did not pass: " + $whyWave + ". Its uncounted checks were retried up to " + $RIDE_TRIES + " reads, and each of its counted requests up to " + $RIDE_TRIES + " attempts, before this stop (ATTEMPTS so far: " + $attemptsLine + "; PROVED so far: " + $provedLine + "). Read npx wrangler deployments list and the failing route by hand first. Only if the new version is at 100% and fresh reads still disagree: " + $ROLLBACK_LINE) }
Say ("[ride] A2A wave: both cards 200 with the required fields and the live society name; POST /a2a accepted SendMessage (1.0 header) and message/send (no header) with the fixed directions and answered the notification 204 with no body; /mcp and /mcp/read answered message/send and SendMessage with the new text and an ordinary unknown method with today's text; each probe door showed at least baseline + PROVED for the round judged (or was at its cap), in " + $rideResult.Rounds + " round(s). ATTEMPTS (every request sent): " + $attemptsLine + ". PROVED (answers that passed): " + $provedLine)
$sweepPaths = @("/", "/operators", "/api/official", "/openapi.json", "/treasury", "/api/listings", "/api/stats", "/api/topics", "/api/guest/due", "/api/citizens", "/api/doors", "/api/council", "/api/residents", "/heartbeat.md", "/skill.md", "/llms.txt", "/privacy", "/api/proposal/8")
$whySweep = Confirm-Reads {
  $bad = @()
  foreach ($p in $sweepPaths) {
    $r = Get-Text "$BASE$p" 30
    if ($r.Code -ne "200") { $bad += "$p=$($r.Code)" }
  }
  if ($bad.Count -gt 0) { return ("non-200: " + ($bad -join ", ")) }
  return ""
} $GOOD_READS_NEEDED $RIDE_TRIES $RIDE_DELAY_SECONDS
if ($whySweep -ne "") { Stop-Here ("the public reads were not all 200 after the deploy (version " + $versionId + ") in " + $RIDE_TRIES + " sweeps (last: " + $whySweep + "). Read npx wrangler deployments list and the failing paths by hand first. Only if the new version is at 100% and a read that answered before still fails: " + $ROLLBACK_LINE) }
Say "[ride] 18 public reads -> 200 ($GOOD_READS_NEEDED sweeps in a row)"
Say ("[note] WHAT THIS RIDE PROVED: the stamped commit is serving, both cards and POST /a2a answer as the brief says (including gate C2: a v1.0 SendMessage with no A2A-Version header is -32601 naming message/send), /mcp and /mcp/read answer BOTH A2A send methods (message/send and SendMessage) with the new text and refuse a JSON null body, the routes are listed, /skill.md and /heartbeat.md are unchanged, and, for the round judged, each of the four probe-door counters in the managed D1 showed at least baseline + what the ride proved (or was at its cap). The ride does not measure that the uncounted routes add nothing to any counter; the code and the local tests say so. WHAT IT DID NOT PROVE: NO REAL A2A CLIENT WAS RUN; the first real client is the first test that one can use the endpoint. " +
  "THE COUNTED REQUESTS THIS RIDE SENT, in " + $rideResult.Rounds + " round(s), AND THEY ARE IN THE DAY'S FIGURES. ATTEMPTS (every request actually sent, a stale answer or a retry included): " + $attemptsLine + ". PROVED (answers that passed their judge; the door check wanted baseline + these): " + $provedLine + ". A clean ride proves agent_card 2 (a GET of each card), a2a_send 3 (SendMessage with the 1.0 header, message/send with no header, and a message/send notification with no id: a notification is an accepted send and the code counts it), mcp_a2a_probe 4 (message/send and SendMessage, each to /mcp and to /mcp/read), mcp_unknown_method 2 (one ordinary unknown method to each MCP door). " +
  "So the day's figures may hold up to the ATTEMPTS added to the four probe doors (an attempt answered by an edge still running the old code, or lost, was not counted): a door that was at its cap shows less than that, and with two rounds (a UTC midnight during the ride) the totals span two days and today's row holds only the second round's. They are not visitors. The uncounted requests (the refusals, GET /a2a, the null bodies) are routes that do not count by the code and by the local tests; this ride does not measure that. The two initialize POSTs per read (pre-deploy check, poll and ride) add to mcp_initialize and mcp_read_initialize, " +
  "and /skill.md and /heartbeat.md are counted doors that each GET attempts to count (the pre-deploy reads, the ride's byte comparison, which reads only those two, and the sweeps); /operators is one too (step 2's read, the poll's page check, the ride's page check and the sweeps each attempted a count), so the first day's operators_page figure includes them; and a commit_days stamp row for today's date and the new commit can be written. GET /api/doors commits_by_day may show two stamps for today (the old commit and the new one), which is expected. " +
  "The rotate and wallet refusals wrote nothing (authenticate() throws before any write). This script ran no wrangler command but the deploy and ran no D1 command of its own (the routes it called read and write D1 as they always do).")
Say "[done] agent card / A2A wave deployed and ridden over HTTP (no real A2A client was run). Log version id $versionId, commit $($headSha.Substring(0, 8)) and these lines in HANDOVER.md."
