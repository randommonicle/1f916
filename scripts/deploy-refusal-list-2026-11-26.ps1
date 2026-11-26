# Deploys the 26 NOV REFUSAL-LIST WAVE: both inbox cursor_notes say which refusals of their route carry a code and which are prose only (D-094 note 26 Nov, 1f916 post 9594 c161017, load-bearing-2). WORDING ONLY, in ONE worker deploy.
#   1. The cursor_note of GET /api/inbox and of GET /api/guest/inbox, over HTTP and over MCP (the inbox and guest_inbox tools serve the same note), gains its route's list: "Over HTTP three refusals of this route carry a code: ... the rest carry prose only: ...",
#      then "Over MCP no tool refusal carries a code or an HTTP status: ...", then "A prose-only refusal says nothing about checks it did not run, ..." (src/inbox.ts). Nothing else is served differently.
#   2. docs/HEARTBEAT-SKILL-TEXT.md mirrors the citizen sentence; it is a document, not served by the worker.
# Gate record: docs/REVIEW-REFUSAL-LIST-GATE-2026-11-26.md. Brief: drafts/BUILDER-BRIEF-deploy-refusal-list-2026-11-26.md. Derived from scripts/deploy-above-head-code-2026-11-26.ps1, deployed that morning (every structural protection and every ride of it kept as a regression check).
# ONE worker deploy. Ben's hand only (D-017). One fail-fast script (L-046, L-069). NO MIGRATION, NO D1 WRITE, NO D1 COMMAND OF ITS OWN, NO MINT: step 0 STOPS if migrations/, schema.sql or src/doc.ts differ between the live base and HEAD.
# The ONLY wrangler command this script runs is the stamped deploy.
# TWO PINS. $LIVE_BASE_COMMIT is the commit the live worker serves when this runs (9f7fe955: the above-head code wave of this morning); step 2 PROVES it against the live GET /api/attest code.commit. Live = origin/main = local main = that commit
# before this wave, so the base check is EQUALITY again (live code.commit must equal the pin, nothing sits between), not the ancestry of the last ship; HEAD must still contain the pin, since HEAD is the wave on top of it.
# $REVIEWED_COMMIT is the commit the reviews read. It holds the placeholder TO-BE-SET-BY-HUB until the hub sets it. Step 0a STOPS, before any git or network command, while EITHER pin still holds its placeholder or is not 40 lower-case hex.
# REVIEWED SOURCE ONLY: step 0 also STOPS unless HEAD is $REVIEWED_COMMIT plus changes confined to $ALLOWED_PATHS_AFTER_REVIEW (this script, its test, the refusal-list gate record).
# THE DEPLOY STAMPS THE COMMIT: `npx wrangler deploy --var CODE_COMMIT:<sha>`. The poll waits until GET /api/attest serves code.commit equal to the pinned sha AND code.version_id equal to the
# Current Version ID wrangler printed. THE STAMP IS THE ONLY PROOF THE NEW CODE IS LIVE; the ride below then exercises the wave over HTTP and over MCP.
# CF-RAY (operator's ruling D-093 (5)): every HTTP read this script makes, GET or POST, before and after the deploy, logs one line: [ray] <method> <path and query as sent> -> <status> <CF-RAY, or none>.
# The ray is read by curl's own -w "%header{cf-ray}" inside Get-Text, Get-PostAnswer and Get-JsonPost, the only three places curl runs, so no read can miss it. Nothing secret is ever in a line. When a retried check or the poll reports a bad read, the ray lines around it are the evidence.
# ROLLBACK TARGET: worker ca318f8b-8aec-4876-b2b8-c57adb06db55, the version serving 9f7fe955 now (the script still reads the live version id before the deploy and names THAT one in its stop lines; this one is for the hand).
# BEFORE THE DEPLOY (GETs only, the dry run does all of it, one read is the state and may stop):
#   - the live base is the pinned one and the chains and v6 are as expected;
#   - neither cursor_note, read over HTTP, carries the list sentence ("Over HTTP three refusals of this route carry a code"), and both carry the above-head sentence of this morning (the base is what we think); a visitor number is readable from GET /api/guest/due.
#   The above-head code is already live: the ride below re-checks it as a REGRESSION, it is not the before-state.
# THE RIDE (every check retried until $GOOD_READS_NEEDED good reads in a row, L-167):
#   - attest, the rotate and wallet 401 refusals, and the inbox cursor ride (regression);
#   - the above-head ride (regression of this morning: both routes 400 with code cursor_above_head, keys exactly code and error, the unchanged text; a stray parameter, in either order, 400 unknown_query_parameter) AND THE NEW CHECK: both cursor_notes, over HTTP, carry their route's FULL list sentences;
#   - the regression ride of the 25 Nov wave: limit=1 -> 400, a repeated handle and a repeated guest -> 400 repeated_query_parameter, secret on the query -> 400, the plain shapes 200, both cap sentences, /api/proposals?limit=1 still 400;
#   - the MCP tools on both doors: limit -> isError true with the exact text; an above-head cursor -> isError true with the unchanged text and no code field; secret and token (the fixed string commonhold-ride-not-a-credential, no credential) -> not an error, and the call without them answers too, and each
#     answer's cursor_note carries its tool's FULL list sentences. THE LIST SENTENCE IS THE DISCRIMINATOR on both doors and both tools: the base (9f7fe955) serves the cap and above-head sentences over MCP too, so only the list sentence tells the new worker's answer from the base's. tools/list: no additionalProperties, the exact property names, the exception sentence;
#   - /openapi.json, /llms.txt and /api/surface carry both full route sentences (regression); the sweep of public reads (nothing dropped from it).
# WHAT THE RIDE DOES NOT PROVE: the wording of the pay-route refusals (PAY_REFUSED_BEFORE_402) and of the pay reservation refusal (the 25 Nov wave, NOT RIDDEN then and now): they need a citizen's credential and a signed payment. Nor does it prove that a prose-only refusal is prose only on every path the list names: the unit tests (test/inbox-refusal-list-d1.test.ts) prove that against the routes themselves.
# Run from society/ on main, after the merge and the push:
#   cd "C:\Users\bengr\Projects\AI domain and social network\society"
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-refusal-list-2026-11-26.ps1 -ExpectedCommit <sha> -DryRun   # every check and the live reads, nothing deployed
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-refusal-list-2026-11-26.ps1 -ExpectedCommit <sha>           # the real thing
# <sha> is the pushed tip of main (git -C society rev-parse HEAD), the full 40 hex.
# INBOX GATE C1 (no read may come from a replica behind the one that served a cursor) is met by source: without the Sessions API D1 answers from the primary, and step 0 STOPS if any file under src/ calls withSession.
# The ROLLBACK TARGET the script names is the version id GET /api/attest served BEFORE the deploy (read live, never typed in). The ship is rollback-safe: no schema change.
# THE RIDE holds no token, key or assertion and prints none: public GETs, credential-free tools/call and tools/list POSTs (the body is sent from a temp file, curl.exe --data-binary "@file"), and the refused POSTs to /api/rotate and /api/wallet.
# PowerShell 5.1 traps this file avoids: one spelling per variable name; -notmatch on an array filters instead of testing; a one-element return is wrapped in @(); "$var:" is a drive reference
# (write "${var}:"); never merge a native command's stderr under ErrorActionPreference Stop; -eq and -ne are case-INSENSITIVE (hashes, shas and every exact answer are compared with -ceq / -cne); PS 5.1 strips
# inner double quotes from a native command's argument, so every JSON body is sent from a temp file. ASCII only.
param(
  [Parameter(Mandatory = $true)][string]$ExpectedCommit,
  [switch]$DryRun
)
$ErrorActionPreference = "Stop"
$BASE = "https://commonhold.randommonicle.workers.dev"
# The attested constitution this ship must leave untouched (v6, minted 22 Oct).
$V6_HASH = "dc5f48213c29bcf844e0fbe7daf1bdb5416b3d57fbd06a8bd03f1061f34092b3"
# The commit the live worker serves when this runs (the above-head code wave of 26 Nov; live = origin/main = local main).
$LIVE_BASE_COMMIT = "9f7fe955e0f28459290d55943952cafe1fb61c89"
$LIVE_BASE_PLACEHOLDER = "TO-BE-SET-BY-HUB-LIVE-BASE"
# THE REVIEWED SOURCE. Step 0 STOPS while this is the placeholder, and while it is not 40 lower-case hex. The hub sets it (the commit the review converged on).
$REVIEWED_COMMIT = "acf0eed0c70ec4c4eae1281b4db9858249626cab"
$REVIEWED_COMMIT_PLACEHOLDER = "TO-BE-SET-BY-HUB"
$ALLOWED_PATHS_AFTER_REVIEW = @("scripts/deploy-refusal-list-2026-11-26.ps1", "test/deploy-refusal-list-2026-11-26-script.test.ts", "docs/REVIEW-REFUSAL-LIST-GATE-2026-11-26.md")
$ROTATE_URL = "$BASE/api/rotate"
$WALLET_URL = "$BASE/api/wallet"
# The two refusal texts the ride reads, exactly as src/society.ts authenticate() serves them (the test pins both against the source). A prefix of each is checked.
$NO_CREDENTIALS_PREFIX = "No credentials. Register first"
$UNKNOWN_SECRET_TEXT = "Unknown secret. It identifies no citizen."
# A bearer string that is no citizen's secret (it does not have newSecret()'s commonhold_sk_ shape) and not an assertion (no ch1. prefix): authenticate() hashes it, finds no row and refuses. It writes nothing.
# The same fixed string is the value of the `secret` query parameter and of the `secret` and `token` tool arguments: it is no credential and the inbox reads ignore it.
$NOT_A_SECRET = "commonhold-ride-not-a-credential"
$HEADS_URL = "$BASE/api/inbox?handle=commonhold-agent&since=9999999999999"
$CITIZEN_INBOX_URL = "$BASE/api/inbox?handle=commonhold-agent"
$GUEST_INBOX_URL = "$BASE/api/guest/inbox?guest="
$PROPOSALS_LIMIT_URL = "$BASE/api/proposals?limit=1"
$CURSOR_NOTE_SENTENCE = "A part above the newest row of its table is refused"
# THE ABOVE-HEAD WAVE. Cursor values far above any head: the comment part (citizen) and the guest-row part (guest) are the first part named. No parameter either route does not accept.
$CODE_ABOVE_HEAD = "cursor_above_head"
$ABOVE_ID = "999999"
$CITIZEN_ABOVE_CURSOR = "c999999-p0-g0"
$GUEST_ABOVE_CURSOR = "g999999-c0-p0"
$CITIZEN_ABOVE_PART = "comment"
$GUEST_ABOVE_PART = "guest row"
# What the before-state looks for: the base must not carry the list fragment (it opens both list sentences).
$LIST_FRAGMENT = "Over HTTP three refusals of this route carry a code"
# The sentence both cursor_notes carry (src/inbox.ts; the test pins it to the source).
$NOTE_SENTENCE = "A part above the newest row of its table is refused with 400 over HTTP, code cursor_above_head, and over MCP as a tool error carrying the message only. A refusal reports the first failing check only: unknown or repeated parameters (over MCP, a tool's unknown argument) are rejected before the cursor is compared, so a cursor refused with a parameter was not compared, and of several parts above their heads only the first, in this cursor's own order, is named."
# The list sentences of the refusal-list wave, one per route (src/inbox.ts; the test pins both to the source). Each is the three sentences after the above-head one: the HTTP list, the MCP sentence, the prose-only sentence.
$LIST_SENTENCE_CITIZEN = "Over HTTP three refusals of this route carry a code: unknown_query_parameter, repeated_query_parameter and cursor_above_head; the rest carry prose only: a missing or malformed handle, since and cursor both or neither, a malformed or out-of-range since or cursor (400), and an unknown handle (404). Over MCP no tool refusal carries a code or an HTTP status: every one, an above-head cursor and an unknown, non-object or wrongly typed argument included, is a tool error carrying prose only. A prose-only refusal says nothing about checks it did not run, and a client that keeps only the first refusal never learns of a later failure: fix what it names and call again."
$LIST_SENTENCE_GUEST = "Over HTTP three refusals of this route carry a code: unknown_query_parameter, repeated_query_parameter and cursor_above_head; the rest carry prose only: a missing or malformed guest number, a malformed or out-of-range cursor (400), and an unknown guest number (404). Over MCP no tool refusal carries a code or an HTTP status: every one, an above-head cursor and an unknown, non-object or wrongly typed argument included, is a tool error carrying prose only. A prose-only refusal says nothing about checks it did not run, and a client that keeps only the first refusal never learns of a later failure: fix what it names and call again."
$CITIZEN_RESTART_TAIL = "or pass since=<ms> instead of cursor to start again."
$GUEST_RESTART_TAIL = "omit cursor to start again."
# The cap sentence of each cursor_note (the test pins both against src/inbox.ts and INBOX_SECTION_LIMIT).
$CAP_CITIZEN_SENTENCE = "At most 100 candidate rows of each table (comments, posts and guest_thread) are taken for one page; that counts candidate rows, not items delivered, and ballots is outside it."
$CAP_GUEST_SENTENCE = "At most 100 candidate rows of each table (guest_thread, comments and posts) are taken for one page; that counts candidate rows, not items delivered, and duties is outside it."
# The exact 400 answers the routes serve (src/inbox.ts assertKnownQuery; the test pins them against the source and runs them against the real worker).
$CODE_UNKNOWN = "unknown_query_parameter"
$CODE_REPEATED = "repeated_query_parameter"
$ERR_INBOX_LIMIT = "Unknown query parameter: limit. GET /api/inbox accepts only: handle, since, cursor. Nothing was read; remove the parameter and call again."
$ERR_INBOX_SECRET = "Unknown query parameter: secret. GET /api/inbox accepts only: handle, since, cursor. Nothing was read; remove the parameter and call again."
$ERR_INBOX_REPEATED = "Repeated query parameter: handle. GET /api/inbox accepts each of handle, since, cursor at most once."
$ERR_GUEST_LIMIT = "Unknown query parameter: limit. GET /api/guest/inbox accepts only: guest, cursor. Nothing was read; remove the parameter and call again."
$ERR_GUEST_REPEATED = "Repeated query parameter: guest. GET /api/guest/inbox accepts each of guest, cursor at most once."
# The exact tool refusals (src/inbox.ts assertKnownArgs), as the JSON `error` inside content[0].text.
$ERR_TOOL_INBOX = "Unknown argument for inbox: limit. The inbox tool accepts only: handle, since, cursor (secret and token are ignored if sent). Nothing was read."
$ERR_TOOL_GUEST = "Unknown argument for guest_inbox: limit. The guest_inbox tool accepts only: guest, cursor (secret and token are ignored if sent). Nothing was read."
$TOOL_EXCEPTION_SENTENCE = "except secret and token, which this tool does not need and ignores if sent"
$INBOX_TOOL_PROPS = "cursor,handle,since"
$GUEST_TOOL_PROPS = "cursor,guest"
# The JSON-RPC bodies. The guest ones are head + visitor number + tail, the number being digits only.
$TOOLS_LIST_BODY = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'
$INBOX_BODY_LIMIT = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"inbox","arguments":{"handle":"commonhold-agent","since":0,"limit":1}}}'
$INBOX_BODY_SECRET = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"inbox","arguments":{"handle":"commonhold-agent","since":0,"secret":"commonhold-ride-not-a-credential","token":"commonhold-ride-not-a-credential"}}}'
$INBOX_BODY_PLAIN = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"inbox","arguments":{"handle":"commonhold-agent","since":0}}}'
$GUEST_BODY_HEAD = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"guest_inbox","arguments":{"guest":'
$GUEST_TAIL_LIMIT = ',"limit":1}}}'
$GUEST_TAIL_SECRET = ',"secret":"commonhold-ride-not-a-credential","token":"commonhold-ride-not-a-credential"}}}'
$GUEST_TAIL_PLAIN = '}}}'
$INBOX_BODY_ABOVE = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"inbox","arguments":{"handle":"commonhold-agent","cursor":"c999999-p0-g0"}}}'
$GUEST_TAIL_ABOVE = ',"cursor":"g999999-c0-p0"}}}'
# The doors' per-good-read POST counts for the closing note: eight tools/call (four inbox, four guest_inbox) and one tools/list per door.
$MCP_CALLS_PER_READ = 8
$MCP_LISTS_PER_READ = 1
# The two route sentences /openapi.json, /llms.txt and /api/surface carry (src/discovery.ts; the test pins both).
$ROUTE_SENTENCE_INBOX = "Accepts only handle, since and cursor, each at most once; any other query parameter is refused with 400 (unknown_query_parameter or repeated_query_parameter), never silently ignored. A cursor part above the newest row of its table is refused with 400 (cursor_above_head). Unknown or repeated parameters are rejected before the cursor is compared, and a refusal reports the first failing check only."
$ROUTE_SENTENCE_GUEST = "Accepts only guest and cursor, each at most once; any other query parameter is refused with 400 (unknown_query_parameter or repeated_query_parameter), never silently ignored. A cursor part above the newest row of its table is refused with 400 (cursor_above_head). Unknown or repeated parameters are rejected before the cursor is compared, and a refusal reports the first failing check only."
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
# THE RAY LINE (D-093 (5)): "[ray] <method> <path and query as sent> -> <status> <ray>", the ray being "none" when the header is absent or curl failed.
function Format-RayLine($method, $url, $code, $ray) {
  $shown = [string]$url
  if ($shown.StartsWith($BASE, [System.StringComparison]::Ordinal)) { $shown = $shown.Substring($BASE.Length) }
  $rayText = ([string]$ray).Trim()
  if ($rayText -ceq "") { $rayText = "none" }
  return ("[ray] " + $method + " " + $shown + " -> " + $code + " " + $rayText)
}
# The status and the ray from curl's -w text "<status>|<ray>" and its exit code. A curl failure (a connection lost after the headers included) is a failed read: status 000, ray none, never the status its headers carried.
function Read-CodeAndRay($meta, $exit) {
  $parts = ([string]$meta).Split("|", 2)
  $code = [string]$parts[0]
  $ray = ""
  if ($parts.Count -gt 1) { $ray = [string]$parts[1] }
  if ($exit -ne 0) { $code = "000"; $ray = "none" }
  return @{ Code = $code; Ray = $ray }
}
# The status code, content type and body of a GET, and one ray line. The content type is read from curl's own -w, never guessed.
function Get-Text($url, $maxTime) {
  $tmp = [System.IO.Path]::GetTempFileName()
  try {
    $meta = (curl.exe -s --max-time $maxTime -o $tmp -w "%{http_code}|%{content_type}|%header{cf-ray}" $url)
    $exit = $LASTEXITCODE
    $parts = ([string]$meta).Split("|", 3)
    $body = (Get-Content $tmp -Raw -Encoding UTF8 -ErrorAction SilentlyContinue)
    if ($null -eq $body) { $body = "" }
    $type = ""
    if ($parts.Count -gt 1) { $type = [string]$parts[1] }
    $ray = ""
    if ($parts.Count -gt 2) { $ray = [string]$parts[2] }
    $code = [string]$parts[0]
    if ($exit -ne 0) { $code = "000"; $ray = "none" }
    Say (Format-RayLine "GET" $url $code $ray)
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
  if ($att.constitution.template_hash -cne $V6_HASH) { return ("template_hash is " + $att.constitution.template_hash + ", expected v6 " + $V6_HASH + ": investigate before anything else (this ship mints nothing)") }
  if ($att.ok -isnot [bool] -or $att.ok -ne $true) { return ("GET /api/attest ok is '" + $att.ok + "', expected true") }
  foreach ($chain in "identity_log", "treasury", "payouts", "ballots") {
    if ($null -eq $att.$chain -or $att.$chain.ok -isnot [bool] -or $att.$chain.ok -ne $true) { return ("chain " + $chain + " ok is '" + $att.$chain.ok + "', expected true: investigate") }
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
# Polls until the served block is this deploy's, $GOOD_READS_NEEDED reads in a row, or STOPS after $tries reads. Only the exhausted poll may name a rollback.
function Wait-NewWorker($commit, $versionId, $tries, $delaySeconds) {
  $last = "never read"
  $run = 0
  for ($n = 1; $n -le $tries; $n++) {
    $why = Test-CodeIdentityServed (Get-ServedCode) $commit $versionId
    if ($why -eq "") {
      $run = $run + 1
      Say "[poll] try $n of ${tries}: good read $run of ${GOOD_READS_NEEDED}: GET /api/attest serves code.commit $($commit.Substring(0, 8)) and code.version_id $versionId"
      if ($run -ge $GOOD_READS_NEEDED) { return }
      $last = "only " + $run + " good read(s) in a row of the " + $GOOD_READS_NEEDED + " needed"
    } else {
      $run = 0
      $last = $why
      Say "[poll] try $n of ${tries}: not yet: $why"
    }
    if ($n -lt $tries) { Start-Sleep -Seconds $delaySeconds }
  }
  Stop-Here ("the new worker was not shown live in " + $tries + " reads (last: " + $last + "). Read 'npx wrangler deployments list' and GET /api/attest by hand first, with the [ray] lines above as the evidence: stale reads right after a deploy are common, and the deploy may be live. Only if the new version is serving, in whole or in part, and fresh reads still disagree: " + $ROLLBACK_LINE)
}
# The status and body of a POST to $url with no body, by curl.exe like every other HTTP call here, and one ray line. $auth is the whole Authorization header value, or "" to send none. Never stops.
function Get-PostAnswer($url, $auth) {
  $out = [System.IO.Path]::GetTempFileName()
  try {
    $curlArgs = @("-s", "--max-time", "30", "-o", $out, "-w", "%{http_code}|%header{cf-ray}", "-X", "POST")
    if ([string]$auth -cne "") { $curlArgs += @("-H", ("Authorization: " + $auth)) }
    $curlArgs += $url
    $meta = (curl.exe @curlArgs)
    $exit = $LASTEXITCODE
    $read = Read-CodeAndRay $meta $exit
    $body = (Get-Content $out -Raw -Encoding UTF8 -ErrorAction SilentlyContinue)
    if ($null -eq $body) { $body = "" }
    Say (Format-RayLine "POST" $url $read.Code $read.Ray)
    return @{ Code = [string]$read.Code; Exit = $exit; Body = [string]$body }
  } finally {
    Remove-Item $out -ErrorAction SilentlyContinue
  }
}
# A JSON POST by curl.exe: the body goes from a temp file (--data-binary "@file", ASCII, deleted in finally), never as a quoted argument, and one ray line. Returns @{ Code; Exit; Body }. Never stops.
function Get-JsonPost($url, $bodyText) {
  $out = [System.IO.Path]::GetTempFileName()
  $req = [System.IO.Path]::GetTempFileName()
  try {
    [System.IO.File]::WriteAllText($req, $bodyText, (New-Object System.Text.UTF8Encoding($false)))
    $curlArgs = @("-s", "--max-time", "30", "-o", $out, "-w", "%{http_code}|%header{cf-ray}", "-H", "Content-Type: application/json", "--data-binary", ("@" + $req), $url)
    $meta = (curl.exe @curlArgs)
    $exit = $LASTEXITCODE
    $read = Read-CodeAndRay $meta $exit
    $body = (Get-Content $out -Raw -Encoding UTF8 -ErrorAction SilentlyContinue)
    if ($null -eq $body) { $body = "" }
    Say (Format-RayLine "POST" $url $read.Code $read.Ray)
    return @{ Code = [string]$read.Code; Exit = $exit; Body = [string]$body }
  } finally {
    Remove-Item $out -ErrorAction SilentlyContinue
    Remove-Item $req -ErrorAction SilentlyContinue
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
# "" when the route at $url refuses the three credential-free requests: POST with no credential and POST with a bearer that is no citizen's secret (401 with the two texts), and GET (404, POST only). None writes anything.
function Test-RouteRefusals($url, $name) {
  $why = Test-Refusal401 (Get-PostAnswer $url "") ("POST " + $name + " with no credential") $NO_CREDENTIALS_PREFIX
  if ($why -ne "") { return $why }
  $why = Test-Refusal401 (Get-PostAnswer $url ("Bearer " + $NOT_A_SECRET)) ("POST " + $name + " with a bearer that is no citizen's secret") $UNKNOWN_SECRET_TEXT
  if ($why -ne "") { return $why }
  $g = Get-Text $url 30
  if ([string]$g.Code -cne "404") { return ("GET " + $name + " answered " + $g.Code + ", expected 404 (the route is POST only)") }
  return ""
}
# ---------- THE SHIP'S OWN CHECKS ----------
# @{ Why; C; P; G; HasG }: the heads a since call serves as next_cursor (c<C>-p<P>, with -g<G> once guest rows exist). Read every time: they move.
function Read-CitizenHeads {
  $r = Get-Text $HEADS_URL 30
  if ([string]$r.Code -cne "200") { return @{ Why = ("GET /api/inbox since=9999999999999 answered " + $r.Code + ", expected 200"); C = 0; P = 0; G = 0; HasG = $false } }
  $j = Read-JsonBody $r
  if ($null -eq $j) { return @{ Why = "GET /api/inbox since=9999999999999 was not JSON"; C = 0; P = 0; G = 0; HasG = $false } }
  $m = [regex]::Match([string]$j.next_cursor, '^c(\d+)-p(\d+)(?:-g(\d+))?$')
  if (-not $m.Success) { return @{ Why = ("GET /api/inbox since=9999999999999 served next_cursor '" + $j.next_cursor + "', expected c<n>-p<n> with an optional -g<n>"); C = 0; P = 0; G = 0; HasG = $false } }
  $hasG = $m.Groups[3].Success
  $g = 0
  if ($hasG) { $g = [long]$m.Groups[3].Value }
  return @{ Why = ""; C = [long]$m.Groups[1].Value; P = [long]$m.Groups[2].Value; G = $g; HasG = $hasG }
}
function Format-CitizenCursor($c, $p, $g, $hasG) {
  $text = "c" + $c + "-p" + $p
  if ($hasG) { $text = $text + "-g" + $g }
  return $text
}
# The visitor number of the first guest critique GET /api/guest/due lists (the number after # in its author byline), or "" when none can be read. A public answer, never a guess.
function Get-VisitorNumber {
  $r = Get-Text ($BASE + "/api/guest/due?view=history&limit=1") 30
  if ([string]$r.Code -cne "200") { return "" }
  $j = Read-JsonBody $r
  if ($null -eq $j -or $null -eq $j.items) { return "" }
  $first = @($j.items)[0]
  if ($null -eq $first) { return "" }
  $m = [regex]::Match([string]$first.author, '#([1-9][0-9]{0,14})$')
  if (-not $m.Success) { return "" }
  return $m.Groups[1].Value
}
# "" when the captured answer $r is a 400 whose JSON `error` names $partName with id $id above head $head and ends with $tail, otherwise the reason it is not.
function Test-CursorRefusal($r, $label, $partName, $id, $head, $tail) {
  if ([string]$r.Code -cne "400") { return ($label + " answered " + $r.Code + ", expected 400") }
  $j = Read-JsonBody $r
  if ($null -eq $j) { return ($label + ": the 400 was not JSON") }
  $e = [string]$j.error
  $start = "cursor's " + $partName + " id is " + $id + ", above the newest one here (" + $head + ")."
  if (-not $e.StartsWith($start, [System.StringComparison]::Ordinal)) { return ($label + ": the 400 error is '" + $e + "', expected it to start '" + $start + "'") }
  if (-not $e.EndsWith($tail, [System.StringComparison]::Ordinal)) { return ($label + ": the 400 error is '" + $e + "', expected it to end '" + $tail + "'") }
  return ""
}
# "" when a GET of $url answers 200, otherwise the reason. $label names it.
function Test-Reads200($url, $label) {
  $r = Get-Text $url 30
  if ([string]$r.Code -cne "200") { return ($label + " answered " + $r.Code + ", expected 200") }
  return ""
}
# THE CURSOR RIDE, kept as a regression check (docs/REVIEW-INBOX-CURSOR-HEAD-GATE-2026-11-24.md, steps 1-5): the cursor refusal of the 24 Nov ship must still work. GET only. $visitor is the guest number from a public answer. "" or the first reason.
function Test-CursorRide($visitor) {
  $h = Read-CitizenHeads
  if ($h.Why -ne "") { return $h.Why }
  $why = Test-Reads200 ($CITIZEN_INBOX_URL + "&cursor=" + (Format-CitizenCursor $h.C $h.P $h.G $h.HasG)) "GET /api/inbox with the head cursor itself"
  if ($why -ne "") { return $why }
  $r = Get-Text ($CITIZEN_INBOX_URL + "&cursor=" + (Format-CitizenCursor ($h.C + 1) $h.P $h.G $h.HasG)) 30
  $why = Test-CursorRefusal $r "GET /api/inbox with comment id head+1" "comment" ($h.C + 1) $h.C $CITIZEN_RESTART_TAIL
  if ($why -ne "") { return $why }
  $r = Get-Text ($CITIZEN_INBOX_URL + "&cursor=" + (Format-CitizenCursor $h.C ($h.P + 1) $h.G $h.HasG)) 30
  $why = Test-CursorRefusal $r "GET /api/inbox with post id head+1" "post" ($h.P + 1) $h.P $CITIZEN_RESTART_TAIL
  if ($why -ne "") { return $why }
  if ($h.HasG) {
    $r = Get-Text ($CITIZEN_INBOX_URL + "&cursor=" + (Format-CitizenCursor $h.C $h.P ($h.G + 1) $true)) 30
    $why = Test-CursorRefusal $r "GET /api/inbox with guest row id head+1" "guest row" ($h.G + 1) $h.G $CITIZEN_RESTART_TAIL
    if ($why -ne "") { return $why }
  }
  $since = Get-Text ($CITIZEN_INBOX_URL + "&since=0") 30
  if ([string]$since.Code -cne "200") { return ("GET /api/inbox with since=0 answered " + $since.Code + ", expected 200") }
  $sj = Read-JsonBody $since
  if ($null -eq $sj) { return "GET /api/inbox with since=0 was not JSON" }
  if (-not ([string]$sj.cursor_note).Contains($CURSOR_NOTE_SENTENCE)) { return ("the cursor_note of GET /api/inbox with since=0 does not contain '" + $CURSOR_NOTE_SENTENCE + "'") }
  $served = [string]$sj.next_cursor
  if ($served -cnotmatch '^c\d+-p\d+(-g\d+)?$') { return ("GET /api/inbox with since=0 served next_cursor '" + $served + "', expected c<n>-p<n> with an optional -g<n>") }
  $why = Test-Reads200 ($CITIZEN_INBOX_URL + "&cursor=" + $served) "GET /api/inbox with the next_cursor it served"
  if ($why -ne "") { return $why }
  if ([string]$visitor -ceq "") { return "no visitor number could be read from GET /api/guest/due, so the guest inbox cannot be ridden" }
  $guest = Get-Text ($GUEST_INBOX_URL + $visitor) 30
  if ([string]$guest.Code -cne "200") { return ("GET /api/guest/inbox?guest=" + $visitor + " answered " + $guest.Code + ", expected 200 (the visitor number came from GET /api/guest/due)") }
  $gj = Read-JsonBody $guest
  if ($null -eq $gj) { return "GET /api/guest/inbox was not JSON" }
  $gm = [regex]::Match([string]$gj.next_cursor, '^g(\d+)-c(\d+)-p(\d+)$')
  if (-not $gm.Success) { return ("GET /api/guest/inbox served next_cursor '" + $gj.next_cursor + "', expected g<n>-c<n>-p<n>") }
  # The comment HEAD, not the comment part of this page's next_cursor: a page cut at the limit carries the last row it served, and one above that is not above the head.
  $gC = $h.C
  $why = Test-Reads200 ($GUEST_INBOX_URL + $visitor + "&cursor=" + [string]$gj.next_cursor) "GET /api/guest/inbox replaying its next_cursor"
  if ($why -ne "") { return $why }
  $above = "g" + $gm.Groups[1].Value + "-c" + ($gC + 1) + "-p" + $gm.Groups[3].Value
  $r = Get-Text ($GUEST_INBOX_URL + $visitor + "&cursor=" + $above) 30
  return (Test-CursorRefusal $r "GET /api/guest/inbox with comment id head+1" "comment" ($gC + 1) $gC $GUEST_RESTART_TAIL)
}
# "" when the captured GET answer $r is a 400 with JSON `code` $code and JSON `error` exactly $text, otherwise the reason it is not. Case-sensitive.
function Test-Refusal400($r, $label, $code, $text) {
  if ($r.Exit -ne 0) { return ($label + ": curl exited " + $r.Exit + " (no answer; a TLS or network failure)") }
  if ([string]$r.Code -cne "400") { return ($label + " answered " + $r.Code + ", expected 400") }
  $j = Read-JsonBody $r
  if ($null -eq $j) { return ($label + ": the 400 was not JSON") }
  if ([string]$j.code -cne $code) { return ($label + ": the 400 code is '" + $j.code + "', expected '" + $code + "'") }
  if ([string]$j.error -cne $text) { return ($label + ": the 400 error is '" + $j.error + "', expected '" + $text + "'") }
  return ""
}
# "" when $e (the JSON `error` of an answer) is the above-head refusal text for $partName: it starts "cursor's <part> id is 999999, above the newest one here (", then the head in digits, then the unchanged guidance, and ends with $tail. This wave leaves the text as it was.
function Test-AboveHeadText($e, $label, $partName, $tail) {
  $text = [string]$e
  $start = "cursor's " + $partName + " id is " + $ABOVE_ID + ", above the newest one here ("
  if (-not $text.StartsWith($start, [System.StringComparison]::Ordinal)) { return ($label + ": the error is '" + $text + "', expected it to start '" + $start + "'") }
  if (-not $text.EndsWith($tail, [System.StringComparison]::Ordinal)) { return ($label + ": the error is '" + $text + "', expected it to end '" + $tail + "'") }
  if ($text.Length -lt ($start.Length + $tail.Length)) { return ($label + ": the error is '" + $text + "', too short to hold the head and the guidance") }
  $middle = $text.Substring($start.Length, $text.Length - $start.Length - $tail.Length)
  $guidance = '^[0-9]+\)\. Pass next_cursor exactly as a previous response served it, or $'
  if ($tail.StartsWith("or ", [System.StringComparison]::Ordinal)) { $guidance = '^[0-9]+\)\. Pass next_cursor exactly as a previous response served it, $' }
  if ($middle -cnotmatch $guidance) { return ($label + ": the error is '" + $text + "', expected the head in digits and the guidance 'Pass next_cursor exactly as a previous response served it' between the start and the end") }
  return ""
}
# "" when the captured GET answer $r is the above-head 400 as THIS wave serves it: JSON keys exactly code and error, code cursor_above_head, the unchanged text.
function Test-AboveHeadRefusal($r, $label, $partName, $tail) {
  if ($r.Exit -ne 0) { return ($label + ": curl exited " + $r.Exit + " (no answer; a TLS or network failure)") }
  if ([string]$r.Code -cne "400") { return ($label + " answered " + $r.Code + ", expected 400") }
  $j = Read-JsonBody $r
  if ($null -eq $j) { return ($label + ": the 400 was not JSON") }
  $keys = (@($j.PSObject.Properties.Name) | Sort-Object) -join ","
  if ($keys -cne "code,error") { return ($label + ": the 400 body has the keys '" + $keys + "', expected exactly 'code,error'") }
  if ([string]$j.code -cne $CODE_ABOVE_HEAD) { return ($label + ": the 400 code is '" + $j.code + "', expected '" + $CODE_ABOVE_HEAD + "'") }
  return (Test-AboveHeadText $j.error $label $partName $tail)
}
# BEFORE the deploy: "" when the base is the one this wave changes, otherwise the reason. $visitor is the guest number. GETs only.
#   neither cursor_note, read over HTTP, carries the list sentence (the base does not), and both carry the above-head sentence of this morning (the base is what we think: that wave is live, a regression and not the before-state).
function Test-ListAbsent($visitor) {
  if ([string]$visitor -ceq "") { return "no visitor number could be read from GET /api/guest/due, so the guest inbox cannot be read" }
  $cr = Get-Text ($CITIZEN_INBOX_URL + "&since=0") 30
  if ([string]$cr.Code -cne "200") { return ("GET /api/inbox with since=0 answered " + $cr.Code + ", expected 200") }
  $cn = Read-JsonBody $cr
  if ($null -eq $cn) { return "GET /api/inbox with since=0 was not JSON" }
  if (([string]$cn.cursor_note).Contains($LIST_FRAGMENT)) { return ("the cursor_note of GET /api/inbox already carries '" + $LIST_FRAGMENT + "': the base is not what we think") }
  if (-not ([string]$cn.cursor_note).Contains($NOTE_SENTENCE)) { return ("the cursor_note of GET /api/inbox does not carry the above-head sentence of 26 Nov: the base is not what we think") }
  $gr = Get-Text ($GUEST_INBOX_URL + $visitor) 30
  if ([string]$gr.Code -cne "200") { return ("GET /api/guest/inbox answered " + $gr.Code + ", expected 200") }
  $gn = Read-JsonBody $gr
  if ($null -eq $gn) { return "GET /api/guest/inbox was not JSON" }
  if (([string]$gn.cursor_note).Contains($LIST_FRAGMENT)) { return ("the cursor_note of GET /api/guest/inbox already carries '" + $LIST_FRAGMENT + "': the base is not what we think") }
  if (-not ([string]$gn.cursor_note).Contains($NOTE_SENTENCE)) { return ("the cursor_note of GET /api/guest/inbox does not carry the above-head sentence of 26 Nov: the base is not what we think") }
  return ""
}
# THE ABOVE-HEAD AND REFUSAL-LIST RIDE: "" when both routes still serve the above-head refusals and notes of this morning (regression) and both cursor_notes carry their full list sentence (this wave), otherwise the first reason. GET only.
function Test-AboveHeadRide($visitor) {
  if ([string]$visitor -ceq "") { return "no visitor number could be read from GET /api/guest/due, so the guest inbox cannot be ridden" }
  $cit = $CITIZEN_INBOX_URL
  $gst = $GUEST_INBOX_URL + $visitor
  $why = Test-AboveHeadRefusal (Get-Text ($cit + "&cursor=" + $CITIZEN_ABOVE_CURSOR) 30) "GET /api/inbox with an above-head cursor" $CITIZEN_ABOVE_PART $CITIZEN_RESTART_TAIL
  if ($why -ne "") { return $why }
  $why = Test-AboveHeadRefusal (Get-Text ($gst + "&cursor=" + $GUEST_ABOVE_CURSOR) 30) "GET /api/guest/inbox with an above-head cursor" $GUEST_ABOVE_PART $GUEST_RESTART_TAIL
  if ($why -ne "") { return $why }
  $why = Test-Refusal400 (Get-Text ($BASE + "/api/inbox?limit=1&handle=commonhold-agent&cursor=" + $CITIZEN_ABOVE_CURSOR) 30) "GET /api/inbox with limit=1 first and an above-head cursor" $CODE_UNKNOWN $ERR_INBOX_LIMIT
  if ($why -ne "") { return $why }
  $why = Test-Refusal400 (Get-Text ($cit + "&cursor=" + $CITIZEN_ABOVE_CURSOR + "&limit=1") 30) "GET /api/inbox with an above-head cursor and limit=1 last" $CODE_UNKNOWN $ERR_INBOX_LIMIT
  if ($why -ne "") { return $why }
  $why = Test-Refusal400 (Get-Text ($BASE + "/api/guest/inbox?limit=1&guest=" + $visitor + "&cursor=" + $GUEST_ABOVE_CURSOR) 30) "GET /api/guest/inbox with limit=1 first and an above-head cursor" $CODE_UNKNOWN $ERR_GUEST_LIMIT
  if ($why -ne "") { return $why }
  $why = Test-Refusal400 (Get-Text ($gst + "&cursor=" + $GUEST_ABOVE_CURSOR + "&limit=1") 30) "GET /api/guest/inbox with an above-head cursor and limit=1 last" $CODE_UNKNOWN $ERR_GUEST_LIMIT
  if ($why -ne "") { return $why }
  $c = Get-Text ($cit + "&since=0") 30
  if ([string]$c.Code -cne "200") { return ("GET /api/inbox with since=0 answered " + $c.Code + ", expected 200") }
  $cj = Read-JsonBody $c
  if ($null -eq $cj) { return "GET /api/inbox with since=0 was not JSON" }
  if (-not ([string]$cj.cursor_note).Contains($NOTE_SENTENCE)) { return ("the cursor_note of GET /api/inbox does not contain the above-head sentence '" + $NOTE_SENTENCE + "'") }
  # the refusal-list wave: the base does not serve this sentence, so it is what the ride reads the new worker by
  if (-not ([string]$cj.cursor_note).Contains($LIST_SENTENCE_CITIZEN)) { return ("the cursor_note of GET /api/inbox does not contain the refusal-list sentence '" + $LIST_SENTENCE_CITIZEN + "'") }
  $g = Get-Text $gst 30
  if ([string]$g.Code -cne "200") { return ("GET /api/guest/inbox?guest=" + $visitor + " answered " + $g.Code + ", expected 200") }
  $gj = Read-JsonBody $g
  if ($null -eq $gj) { return "GET /api/guest/inbox was not JSON" }
  if (-not ([string]$gj.cursor_note).Contains($NOTE_SENTENCE)) { return ("the cursor_note of GET /api/guest/inbox does not contain the above-head sentence '" + $NOTE_SENTENCE + "'") }
  if (-not ([string]$gj.cursor_note).Contains($LIST_SENTENCE_GUEST)) { return ("the cursor_note of GET /api/guest/inbox does not contain the refusal-list sentence '" + $LIST_SENTENCE_GUEST + "'") }
  return ""
}
# THE ROUTES: "" when both inbox routes refuse and serve as this wave says, otherwise the first reason. GET only.
function Test-RouteParams($visitor) {
  if ([string]$visitor -ceq "") { return "no visitor number could be read from GET /api/guest/due, so the guest inbox cannot be ridden" }
  $cit = $CITIZEN_INBOX_URL
  $gst = $GUEST_INBOX_URL + $visitor
  $why = Test-Refusal400 (Get-Text ($cit + "&since=0&limit=1") 30) "GET /api/inbox with limit=1" $CODE_UNKNOWN $ERR_INBOX_LIMIT
  if ($why -ne "") { return $why }
  $why = Test-Refusal400 (Get-Text ($gst + "&limit=1") 30) "GET /api/guest/inbox with limit=1" $CODE_UNKNOWN $ERR_GUEST_LIMIT
  if ($why -ne "") { return $why }
  $why = Test-Refusal400 (Get-Text ($cit + "&handle=commonhold-agent&since=0") 30) "GET /api/inbox with a repeated handle" $CODE_REPEATED $ERR_INBOX_REPEATED
  if ($why -ne "") { return $why }
  $why = Test-Refusal400 (Get-Text ($gst + "&guest=" + $visitor) 30) "GET /api/guest/inbox with a repeated guest" $CODE_REPEATED $ERR_GUEST_REPEATED
  if ($why -ne "") { return $why }
  $why = Test-Refusal400 (Get-Text ($cit + "&since=0&secret=" + $NOT_A_SECRET) 30) "GET /api/inbox with secret on the query" $CODE_UNKNOWN $ERR_INBOX_SECRET
  if ($why -ne "") { return $why }
  $c = Get-Text ($cit + "&since=0") 30
  if ([string]$c.Code -cne "200") { return ("GET /api/inbox with since=0 answered " + $c.Code + ", expected 200") }
  $cj = Read-JsonBody $c
  if ($null -eq $cj) { return "GET /api/inbox with since=0 was not JSON" }
  if (-not ([string]$cj.cursor_note).Contains($CAP_CITIZEN_SENTENCE)) { return ("the cursor_note of GET /api/inbox does not contain the cap sentence '" + $CAP_CITIZEN_SENTENCE + "'") }
  $g = Get-Text $gst 30
  if ([string]$g.Code -cne "200") { return ("GET /api/guest/inbox?guest=" + $visitor + " answered " + $g.Code + ", expected 200") }
  $gj = Read-JsonBody $g
  if ($null -eq $gj) { return "GET /api/guest/inbox was not JSON" }
  if (-not ([string]$gj.cursor_note).Contains($CAP_GUEST_SENTENCE)) { return ("the cursor_note of GET /api/guest/inbox does not contain the cap sentence '" + $CAP_GUEST_SENTENCE + "'") }
  $p = Get-Text $PROPOSALS_LIMIT_URL 30
  if ([string]$p.Code -cne "400") { return ("GET /api/proposals?limit=1 answered " + $p.Code + ", expected it still to answer 400") }
  return ""
}
# @{ Why; IsError; Text }: what a tools/call POST answer $a says. Why is "" when it carried a result with content; IsError is true only for the JSON boolean true.
function Read-ToolAnswer($a, $label) {
  if ($a.Exit -ne 0) { return @{ Why = ($label + ": curl exited " + $a.Exit); IsError = $false; Text = "" } }
  if ([string]$a.Code -cne "200") { return @{ Why = ($label + " answered " + $a.Code + ", expected 200"); IsError = $false; Text = "" } }
  $j = Read-JsonBody $a
  if ($null -eq $j -or $null -eq $j.result -or $null -eq $j.result.content) { return @{ Why = ($label + " carried no result.content"); IsError = $false; Text = "" } }
  $first = @($j.result.content)[0]
  if ($null -eq $first) { return @{ Why = ($label + " carried an empty result.content"); IsError = $false; Text = "" } }
  $isErr = ($j.result.isError -is [bool] -and $j.result.isError -eq $true)
  return @{ Why = ""; IsError = $isErr; Text = [string]$first.text }
}
# "" when the tools/call answer $a is isError true with content[0].text a JSON whose `error` is exactly $text, otherwise the reason.
function Test-ToolRefusal($a, $label, $text) {
  $t = Read-ToolAnswer $a $label
  if ($t.Why -ne "") { return $t.Why }
  if (-not $t.IsError) { return ($label + " was not refused: isError is not true") }
  try { $inner = ($t.Text | ConvertFrom-Json) } catch { return ($label + ": the refusal text was not JSON") }
  if ($null -eq $inner -or [string]$inner.error -cne $text) { return ($label + ": the refusal is '" + $inner.error + "', expected '" + $text + "'") }
  return ""
}
# "" when the tools/call answer $a is isError true with content[0].text a JSON whose ONLY key is `error` (a tool refusal is JSON.stringify({ error: e.message }) in src/mcp.ts and src/mcp-read.ts: it carries no code, and this check invents none) and whose error is the unchanged above-head text for $partName.
function Test-ToolAboveHead($a, $label, $partName, $tail) {
  $t = Read-ToolAnswer $a $label
  if ($t.Why -ne "") { return $t.Why }
  if (-not $t.IsError) { return ($label + " was not refused: isError is not true") }
  try { $inner = ($t.Text | ConvertFrom-Json) } catch { return ($label + ": the refusal text was not JSON") }
  if ($null -eq $inner) { return ($label + ": the refusal text was empty JSON") }
  $keys = (@($inner.PSObject.Properties.Name) | Sort-Object) -join ","
  if ($keys -cne "error") { return ($label + ": the refusal body has the keys '" + $keys + "', expected exactly 'error' (a tool refusal carries no code)") }
  return (Test-AboveHeadText $inner.error $label $partName $tail)
}
# "" when the tools/call answer $a is NOT an error and its content[0].text is a JSON body with a next_cursor, otherwise the reason.
function Test-ToolAccepts($a, $label, $capSentence, $listSentence) {
  $t = Read-ToolAnswer $a $label
  if ($t.Why -ne "") { return $t.Why }
  if ($t.IsError) { return ($label + " answered isError true: " + $t.Text) }
  try { $inner = ($t.Text | ConvertFrom-Json) } catch { return ($label + ": the body text was not JSON") }
  if ($null -eq $inner -or [string]$inner.next_cursor -ceq "") { return ($label + " carried no next_cursor") }
  # the 25 Nov regression: the cap sentence is still served
  if (-not ([string]$inner.cursor_note).Contains($capSentence)) { return ($label + ": the cursor_note does not contain the cap sentence, so this answer is not the new worker's") }
  # the live base (9f7fe955) answers this call with the cap and the above-head sentences too: only the list sentence says this answer is the new worker's
  if (-not ([string]$inner.cursor_note).Contains($NOTE_SENTENCE)) { return ($label + ": the cursor_note does not contain the above-head sentence, so the regression of this morning is not held") }
  if (-not ([string]$inner.cursor_note).Contains($listSentence)) { return ($label + ": the cursor_note does not contain the refusal-list sentence, so this answer is not the new worker's") }
  return ""
}
# "" when tools/list on $path lists inbox and guest_inbox once each, with no additionalProperties member, exactly the accepted property names and the exception sentence in the description, otherwise the reason.
function Test-ToolsListSchemas($path) {
  $a = Get-JsonPost ($BASE + $path) $TOOLS_LIST_BODY
  if ($a.Exit -ne 0) { return ("POST " + $path + " tools/list: curl exited " + $a.Exit) }
  if ([string]$a.Code -cne "200") { return ("POST " + $path + " tools/list answered " + $a.Code + ", expected 200") }
  $j = Read-JsonBody $a
  if ($null -eq $j -or $null -eq $j.result -or $null -eq $j.result.tools) { return ("POST " + $path + " tools/list carried no result.tools") }
  $tools = @($j.result.tools)
  foreach ($spec in @(@("inbox", $INBOX_TOOL_PROPS), @("guest_inbox", $GUEST_TOOL_PROPS))) {
    $name = [string]$spec[0]
    $found = @($tools | Where-Object { [string]$_.name -ceq $name })
    if ($found.Count -ne 1) { return ("POST " + $path + " tools/list lists " + $found.Count + " tools named " + $name + ", expected 1") }
    $schema = $found[0].inputSchema
    if ($null -eq $schema -or $null -eq $schema.properties) { return ("POST " + $path + " tools/list: " + $name + " has no inputSchema.properties") }
    if ($schema.PSObject.Properties.Name -ccontains "additionalProperties") { return ("POST " + $path + " tools/list: the " + $name + " inputSchema carries additionalProperties (it must not: a client that checks the schema first would refuse secret and token)") }
    $names = (@($schema.properties.PSObject.Properties.Name) | Sort-Object) -join ","
    if ($names -cne [string]$spec[1]) { return ("POST " + $path + " tools/list: the " + $name + " properties are '" + $names + "', expected '" + $spec[1] + "'") }
    if (-not ([string]$found[0].description).Contains($TOOL_EXCEPTION_SENTENCE)) { return ("POST " + $path + " tools/list: the " + $name + " description lacks '" + $TOOL_EXCEPTION_SENTENCE + "'") }
  }
  return ""
}
# THE TOOLS on one door $path: "" or the first reason. Per call it POSTs: limit (refused), an above-head cursor (refused), secret and token (answered), plain (answered), for both tools, then tools/list. POSTs: see the closing note.
function Test-McpTools($path, $visitor) {
  if ([string]$visitor -ceq "") { return "no visitor number could be read from GET /api/guest/due, so guest_inbox cannot be ridden" }
  $url = $BASE + $path
  $why = Test-ToolRefusal (Get-JsonPost $url $INBOX_BODY_LIMIT) ("POST " + $path + " inbox with limit") $ERR_TOOL_INBOX
  if ($why -ne "") { return $why }
  $why = Test-ToolAboveHead (Get-JsonPost $url $INBOX_BODY_ABOVE) ("POST " + $path + " inbox with an above-head cursor") $CITIZEN_ABOVE_PART $CITIZEN_RESTART_TAIL
  if ($why -ne "") { return $why }
  $why = Test-ToolAccepts (Get-JsonPost $url $INBOX_BODY_SECRET) ("POST " + $path + " inbox with secret and token") $CAP_CITIZEN_SENTENCE $LIST_SENTENCE_CITIZEN
  if ($why -ne "") { return $why }
  $why = Test-ToolAccepts (Get-JsonPost $url $INBOX_BODY_PLAIN) ("POST " + $path + " inbox without them") $CAP_CITIZEN_SENTENCE $LIST_SENTENCE_CITIZEN
  if ($why -ne "") { return $why }
  $why = Test-ToolRefusal (Get-JsonPost $url ($GUEST_BODY_HEAD + $visitor + $GUEST_TAIL_LIMIT)) ("POST " + $path + " guest_inbox with limit") $ERR_TOOL_GUEST
  if ($why -ne "") { return $why }
  $why = Test-ToolAboveHead (Get-JsonPost $url ($GUEST_BODY_HEAD + $visitor + $GUEST_TAIL_ABOVE)) ("POST " + $path + " guest_inbox with an above-head cursor") $GUEST_ABOVE_PART $GUEST_RESTART_TAIL
  if ($why -ne "") { return $why }
  $why = Test-ToolAccepts (Get-JsonPost $url ($GUEST_BODY_HEAD + $visitor + $GUEST_TAIL_SECRET)) ("POST " + $path + " guest_inbox with secret and token") $CAP_GUEST_SENTENCE $LIST_SENTENCE_GUEST
  if ($why -ne "") { return $why }
  $why = Test-ToolAccepts (Get-JsonPost $url ($GUEST_BODY_HEAD + $visitor + $GUEST_TAIL_PLAIN)) ("POST " + $path + " guest_inbox without them") $CAP_GUEST_SENTENCE $LIST_SENTENCE_GUEST
  if ($why -ne "") { return $why }
  return (Test-ToolsListSchemas $path)
}
# "" when /openapi.json, /llms.txt and /api/surface each carry both route sentences, otherwise the reason.
function Test-RouteSentencesServed {
  foreach ($path in "/openapi.json", "/llms.txt", "/api/surface") {
    $r = Get-Text ($BASE + $path) 30
    if ([string]$r.Code -cne "200") { return ("GET " + $path + " answered " + $r.Code + ", expected 200") }
    if (-not ([string]$r.Body).Contains($ROUTE_SENTENCE_INBOX)) { return ("GET " + $path + " lacks the GET /api/inbox sentence '" + $ROUTE_SENTENCE_INBOX + "'") }
    if (-not ([string]$r.Body).Contains($ROUTE_SENTENCE_GUEST)) { return ("GET " + $path + " lacks the GET /api/guest/inbox sentence '" + $ROUTE_SENTENCE_GUEST + "'") }
  }
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
if ($ExpectedCommit -cnotmatch '^[0-9a-f]{40}$') { Stop-Here "-ExpectedCommit '$ExpectedCommit' is not 40 lower-case hex: a branch name would always agree with itself. Pass the sha you were given. Nothing was read or written." }

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
if ($moves.Count -gt 0) { Stop-Here ("src/doc.ts, migrations/ or schema.sql changed since " + $LIVE_BASE_COMMIT.Substring(0, 8) + " (" + ($moves -join " | ") + "): this ship mints nothing and has no migration. Not this script's deploy.") }
# BEGIN-SESSION-CHECK
$sessionUses = @(Get-ChildItem -Path "src" -Recurse -Filter "*.ts" | Select-String -Pattern "withSession(" -SimpleMatch)
if ($sessionUses.Count -gt 0) { Stop-Here ("src/ calls withSession (" + $sessionUses.Count + " place(s), first " + $sessionUses[0].Filename + "): an inbox read could come from a replica behind the one that served a cursor (inbox gate C1).") }
# END-SESSION-CHECK
# BEGIN-REVIEWED-SOURCE-CHECK
git merge-base --is-ancestor $REVIEWED_COMMIT HEAD
if ($LASTEXITCODE -ne 0) { Stop-Here "HEAD does not contain the reviewed commit $($REVIEWED_COMMIT.Substring(0, 8)): this is not the code that was reviewed." }
$afterReview = @(git diff --name-only --no-renames $REVIEWED_COMMIT HEAD)
if ($LASTEXITCODE -ne 0) { Stop-Here "git diff failed (exit $LASTEXITCODE): the changes since the reviewed commit cannot be read." }
$unreviewed = @(Get-DisallowedPaths $afterReview)
if ($unreviewed.Count -gt 0) { Stop-Here ("these paths changed since the reviewed commit " + $REVIEWED_COMMIT.Substring(0, 8) + " and are not on the allowlist (" + ($ALLOWED_PATHS_AFTER_REVIEW -join ", ") + "), so what would ship is not what was reviewed: " + ($unreviewed -join ", ")) }
Say ("[git] reviewed source: HEAD differs from " + $REVIEWED_COMMIT.Substring(0, 8) + " in " + $afterReview.Count + " path(s), all on the allowlist")
# END-REVIEWED-SOURCE-CHECK
if (-not (Select-String -Path "src/index.ts" -Pattern "assertInboxQuery(url.searchParams)" -SimpleMatch -Quiet)) { Stop-Here "src/index.ts does not refuse unknown parameters on GET /api/inbox: this checkout is not the inbox parameters wave." }
if (-not (Select-String -Path "src/index.ts" -Pattern "assertGuestInboxQuery(url.searchParams)" -SimpleMatch -Quiet)) { Stop-Here "src/index.ts does not refuse unknown parameters on GET /api/guest/inbox: this checkout is not the inbox parameters wave." }
if (-not (Select-String -Path "src/inbox.ts" -Pattern "repeated_query_parameter" -SimpleMatch -Quiet)) { Stop-Here "src/inbox.ts has no repeated_query_parameter refusal: this checkout is not the inbox parameters wave." }
if (-not (Select-String -Path "src/inbox.ts" -Pattern "export const IGNORED_CREDENTIAL_ARGS" -SimpleMatch -Quiet)) { Stop-Here "src/inbox.ts has no IGNORED_CREDENTIAL_ARGS: this checkout is not the inbox tools change." }
if (-not (Select-String -Path "src/mcp.ts" -Pattern "assertInboxArgs(args)" -SimpleMatch -Quiet)) { Stop-Here "src/mcp.ts does not check the inbox tool's arguments: this checkout is not the inbox tools change." }
if (-not (Select-String -Path "src/mcp.ts" -Pattern "assertGuestInboxArgs(args)" -SimpleMatch -Quiet)) { Stop-Here "src/mcp.ts does not check the guest_inbox tool's arguments: this checkout is not the inbox tools change." }
if (-not (Select-String -Path "src/mcp-read.ts" -Pattern "assertInboxArgs(args)" -SimpleMatch -Quiet)) { Stop-Here "src/mcp-read.ts does not check the inbox tool's arguments: this checkout is not the inbox tools change." }
if (-not (Select-String -Path "src/mcp-read.ts" -Pattern "assertGuestInboxArgs(args)" -SimpleMatch -Quiet)) { Stop-Here "src/mcp-read.ts does not check the guest_inbox tool's arguments: this checkout is not the inbox tools change." }
if (-not (Select-String -Path "src/inbox.ts" -Pattern 'At most ${INBOX_SECTION_LIMIT} candidate rows of each table' -SimpleMatch -Quiet)) { Stop-Here "src/inbox.ts has no per-table cap sentence in a cursor_note: this checkout is not the inbox parameters wave." }
if (-not (Select-String -Path "src/listings.ts" -Pattern "This request issued no payment requirements" -SimpleMatch -Quiet)) { Stop-Here "src/listings.ts has no PAY_REFUSED_BEFORE_402 wording: this checkout is not the pay refusal wording change." }
if (-not (Select-String -Path "src/listings.ts" -Pattern "This request settled nothing." -SimpleMatch -Quiet)) { Stop-Here "src/listings.ts has no reservation refusal wording: this checkout is not the pay refusal wording change." }
if (-not (Select-String -Path "src/inbox.ts" -Pattern "function refuseAboveHead(" -SimpleMatch -Quiet)) { Stop-Here "src/inbox.ts has no refuseAboveHead: this checkout is not the inbox cursor refusal." }
if (-not (Select-String -Path "src/inbox.ts" -Pattern "cursor_above_head" -SimpleMatch -Quiet)) { Stop-Here "src/inbox.ts has no cursor_above_head code: this checkout is not the above-head code wave." }
if (-not (Select-String -Path "src/discovery.ts" -Pattern "cursor_above_head" -SimpleMatch -Quiet)) { Stop-Here "src/discovery.ts has no cursor_above_head sentence in the inbox route descriptions: this checkout is not the above-head code wave." }
if (-not (Select-String -Path "src/inbox.ts" -Pattern "Over HTTP three refusals of this route carry a code" -SimpleMatch -Quiet)) { Stop-Here "src/inbox.ts has no refusal-list sentence in a cursor_note: this checkout is not the refusal-list wave." }
if (-not (Select-String -Path "src/code-identity.ts" -Pattern "export function codeBlock" -Quiet)) { Stop-Here "src/code-identity.ts has no codeBlock: this checkout would drop served code identity." }
if (-not (Select-String -Path "wrangler.jsonc" -Pattern '"version_metadata"' -Quiet)) { Stop-Here "wrangler.jsonc has no version_metadata binding: the Worker could not serve Cloudflare's version id." }
if (Select-String -Path "wrangler.jsonc" -Pattern '"CODE_COMMIT"' -Quiet) { Stop-Here "wrangler.jsonc configures a CODE_COMMIT var: a deploy that forgot the flag would serve a stale stamp. The stamp comes from this script's --var flag only." }
Say ("[git] HEAD " + $headSha.Substring(0, 8) + " = main = origin/main = -ExpectedCommit; tree clean; contains " + $LIVE_BASE_COMMIT.Substring(0, 8) + "; src/doc.ts, migrations and schema.sql unmoved")

# 1. the ship's own gates, re-run here so a stale checkout cannot deploy
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

# 2. live, before, GETs only (the dry run does all of it): non-minting baseline, the live worker is the pinned base, the wave is not live yet.
# These reads are before any write, so one read is the state and may stop.
$attBefore = Read-Attest "before the deploy"
Assert-Attest $attBefore "before the deploy"
Say ("[live] before: v6 " + $V6_HASH.Substring(0, 8) + "; all four chains ok; identity " + $attBefore.identity_log.sealed_entries + ", treasury " + $attBefore.treasury.sealed_entries + ", ballots " + $attBefore.ballots.sealed_entries)
if ($null -eq $attBefore.code -or [string]$attBefore.code.commit_status -cne "stamped") { Stop-Here "GET /api/attest serves no stamped code.commit before the deploy: the live worker cannot be shown to be the base this ship was checked against." }
if ([string]$attBefore.code.commit -ceq $headSha) { Stop-Here "GET /api/attest already serves code.commit $($headSha.Substring(0, 8)): this commit looks already deployed. Verify by hand." }
if ([string]$attBefore.code.commit -cne $LIVE_BASE_COMMIT) { Stop-Here ("the live worker serves code.commit " + $attBefore.code.commit + " but `$LIVE_BASE_COMMIT is " + $LIVE_BASE_COMMIT + ": the base this ship was checked against is not what is live. Correct the pin only after reading what changed.") }
$rollbackTarget = "the version before it (check npx wrangler deployments list)"
if ([string]$attBefore.code.version_status -ceq "available" -and $attBefore.code.version_id) { $rollbackTarget = [string]$attBefore.code.version_id }
Say "[live] before: the live worker serves the pinned base $($LIVE_BASE_COMMIT.Substring(0, 8)); rollback target $rollbackTarget"
$visitorNumber = Get-VisitorNumber
if ($visitorNumber -ceq "") { Stop-Here "before the deploy, no visitor number could be read from GET /api/guest/due (history): the guest inbox cannot be read or ridden. Read it by hand." }
Say "[live] before: the guest reads will use visitor number $visitorNumber, read from GET /api/guest/due"
$listWhy = Test-ListAbsent $visitorNumber
if ($listWhy -ne "") { Stop-Here ("before the deploy, " + $listWhy + ".") }
Say "[live] before: neither cursor_note, read over HTTP, carries the refusal-list sentence, and both carry the above-head sentence of this morning"

if ($DryRun) {
  Say "[dry-run] every pin, git, source, test and live check passed. Every live read was a GET: /api/attest, /api/guest/due, /api/inbox (the above-head cursor and since=0), /api/guest/inbox (the above-head cursor and the plain read), /openapi.json, /llms.txt and /api/surface, each with its [ray] line. It sent NO POST, no JSON-RPC body, no wrangler command at all (this script runs no D1 command of its own) and wrote nothing. would now: run npx wrangler deploy --var CODE_COMMIT:<the full sha> and capture its Current Version ID (refusing to continue without one); poll up to $POLL_TRIES times, $POLL_DELAY_SECONDS s apart, until $GOOD_READS_NEEDED reads in a row show GET /api/attest serving that commit and version id; then ride (each check retried up to $RIDE_TRIES reads, $GOOD_READS_NEEDED good in a row): the attested code, constitution and chains, the rotate and wallet 401 refusals, the inbox cursor ride, the above-head and refusal-list ride (the code and the check order as a regression, then both cursor_notes carrying their full list sentence), the two routes' refusals and cap sentences, the inbox and guest_inbox tools on /mcp and /mcp/read, the route sentences in /openapi.json, /llms.txt and /api/surface, and the public reads. Nothing was deployed."
  exit 0
}

# 3. deploy the worker with the commit stamp, capturing its version id, then poll until the served identity is this deploy's
# BEGIN-DEPLOY-AND-POLL
# Tests, typecheck and the live reads ran since step 0, and wrangler bundles the working tree, so HEAD and a clean
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
if ($deployCode -ne 0) { Stop-Here "wrangler deploy failed (exit $deployCode); this ship applied no migration, so there is nothing else to undo. Output: $deployOut" }
$versionMatches = @([regex]::Matches($deployOut, '(?m)^[ \t]*Current Version ID:[ \t]*([0-9a-fA-F-]{36})[ \t]*\r?$'))
if ($versionMatches.Count -gt 1) { Stop-Here ("wrangler deploy printed 'Current Version ID' on " + $versionMatches.Count + " lines; which one is this deploy's cannot be told. Check 'npx wrangler deployments list' by hand before anything else.") }
if ($versionMatches.Count -lt 1) { Stop-Here "wrangler deploy exited 0 but printed no 'Current Version ID'; the deploy may have succeeded. Check 'npx wrangler deployments list' by hand before anything else." }
$versionId = $versionMatches[0].Groups[1].Value
Say "[deploy] worker version id $versionId (commit $($headSha.Substring(0, 8)))"
$ROLLBACK_LINE = "ROLL BACK THE WORKER (npx wrangler rollback, to the version before $versionId, which should be $rollbackTarget; check npx wrangler deployments list first). This ship applied no migration and changed no schema, so the rollback is the whole undo."
Wait-NewWorker $headSha $versionId $POLL_TRIES $POLL_DELAY_SECONDS
# END-DEPLOY-AND-POLL
# 4. the ride (L-167: every check below is retried until $GOOD_READS_NEEDED good reads in a row, up to $RIDE_TRIES reads, before it judges; a stop here means the retries ran out, so the
# message says to read the deployments list by hand first, and only then names the rollback): non-minting and the chains, the rotate and wallet refusals, the cursor ride, the routes, the tools, the discovery text, then a sweep of public reads.
$whyAttest = Confirm-Reads {
  $a = Get-ServedAttest
  $m = Get-AttestReason $a
  if ($m -ne "") { return $m }
  return (Test-CodeIdentityServed $a.code $headSha $versionId)
} $GOOD_READS_NEEDED $RIDE_TRIES $RIDE_DELAY_SECONDS
if ($whyAttest -ne "") { Stop-Here ("GET /api/attest was not confirmed after the deploy in " + $RIDE_TRIES + " reads (last: " + $whyAttest + "). Read npx wrangler deployments list by hand first, with the [ray] lines above as the evidence: another deploy may have taken over, or the edge is still catching up. Only if the new version is at 100% and fresh reads still disagree: " + $ROLLBACK_LINE) }
Say ("[ride] attest: v6 " + $V6_HASH.Substring(0, 8) + " unchanged; every chain ok; code.commit " + $headSha.Substring(0, 8) + ", code.version_id " + $versionId + " ($GOOD_READS_NEEDED good reads in a row)")
$whyRotate = Confirm-Reads { return (Test-RouteRefusals $ROTATE_URL "/api/rotate") } $GOOD_READS_NEEDED $RIDE_TRIES $RIDE_DELAY_SECONDS
if ($whyRotate -ne "") { Stop-Here ("the rotate route was not confirmed to refuse as before in " + $RIDE_TRIES + " reads (last: " + $whyRotate + "). Read npx wrangler deployments list and POST /api/rotate by hand first. Only if the new version is at 100% and fresh reads still disagree: " + $ROLLBACK_LINE) }
Say "[ride] POST /api/rotate -> 401 No credentials, 401 Unknown secret; GET /api/rotate -> 404 ($GOOD_READS_NEEDED good reads in a row)"
$whyWallet = Confirm-Reads { return (Test-RouteRefusals $WALLET_URL "/api/wallet") } $GOOD_READS_NEEDED $RIDE_TRIES $RIDE_DELAY_SECONDS
if ($whyWallet -ne "") { Stop-Here ("the wallet route was not confirmed to refuse as before in " + $RIDE_TRIES + " reads (last: " + $whyWallet + "). Read npx wrangler deployments list and POST /api/wallet by hand first. Only if the new version is at 100% and fresh reads still disagree: " + $ROLLBACK_LINE) }
Say "[ride] POST /api/wallet -> 401 No credentials, 401 Unknown secret; GET /api/wallet -> 404 ($GOOD_READS_NEEDED good reads in a row)"
$whyCursor = Confirm-Reads { return (Test-CursorRide $visitorNumber) } $GOOD_READS_NEEDED $RIDE_TRIES $RIDE_DELAY_SECONDS
if ($whyCursor -ne "") { Stop-Here ("the inbox cursor ride was not confirmed in " + $RIDE_TRIES + " reads (last: " + $whyCursor + "). A regression check: the 24 Nov cursor refusal must still work. Read npx wrangler deployments list and the two inbox routes by hand first. Only if the new version is at 100% and fresh reads still disagree: " + $ROLLBACK_LINE) }
Say "[ride] inbox cursor ride (regression): head cursor 200; comment, post and guest-row id one above the head 400 with the gate's text; since=0 200 with the cursor_note sentence and its served next_cursor 200; /api/guest/inbox 200, replay 200, comment id above the head 400 ($GOOD_READS_NEEDED good reads in a row)"
$whyAbove = Confirm-Reads { return (Test-AboveHeadRide $visitorNumber) } $GOOD_READS_NEEDED $RIDE_TRIES $RIDE_DELAY_SECONDS
if ($whyAbove -ne "") { Stop-Here ("the above-head ride was not confirmed in " + $RIDE_TRIES + " reads (last: " + $whyAbove + "). Read npx wrangler deployments list and the two inbox routes by hand first. Only if the new version is at 100% and fresh reads still disagree: " + $ROLLBACK_LINE) }
Say "[ride] above-head: GET /api/inbox and GET /api/guest/inbox with a cursor far above the head -> 400 with code cursor_above_head, keys exactly code and error, the unchanged text; a stray limit=1 with an above-head cursor, first or last, -> 400 unknown_query_parameter on both routes; both cursor_notes carry their route's full refusal-list sentence ($GOOD_READS_NEEDED good reads in a row)"
$whyRoutes = Confirm-Reads { return (Test-RouteParams $visitorNumber) } $GOOD_READS_NEEDED $RIDE_TRIES $RIDE_DELAY_SECONDS
if ($whyRoutes -ne "") { Stop-Here ("the inbox routes were not confirmed in " + $RIDE_TRIES + " reads (last: " + $whyRoutes + "). Read npx wrangler deployments list and the two inbox routes by hand first. Only if the new version is at 100% and fresh reads still disagree: " + $ROLLBACK_LINE) }
Say "[ride] GET /api/inbox and GET /api/guest/inbox: limit=1 -> 400 unknown_query_parameter, a repeated handle and a repeated guest -> 400 repeated_query_parameter, secret on the query -> 400, the plain shapes 200, both cursor_notes carry the cap sentence; GET /api/proposals?limit=1 still 400 ($GOOD_READS_NEEDED good reads in a row)"
$whyMcp = Confirm-Reads { $w = Test-McpTools "/mcp" $visitorNumber; if ($w -ne "") { return $w }; return (Test-McpTools "/mcp/read" $visitorNumber) } $GOOD_READS_NEEDED $RIDE_TRIES $RIDE_DELAY_SECONDS
if ($whyMcp -ne "") { Stop-Here ("the inbox tools were not confirmed in " + $RIDE_TRIES + " reads (last: " + $whyMcp + "). Read npx wrangler deployments list and both doors by hand first. Only if the new version is at 100% and fresh reads still disagree: " + $ROLLBACK_LINE) }
Say "[ride] the inbox and guest_inbox tools on /mcp and /mcp/read: limit -> isError true with the exact text; an above-head cursor -> isError true with the unchanged text and no code field; secret and token (the fixed non-credential string) answer, and so does the call without them, each answer's cursor_note carrying its tool's full refusal-list sentence (the discriminator against the base); tools/list carries no additionalProperties, exactly the accepted properties and the exception sentence ($GOOD_READS_NEEDED good reads in a row)"
$whyDocs = Confirm-Reads { return (Test-RouteSentencesServed) } $GOOD_READS_NEEDED $RIDE_TRIES $RIDE_DELAY_SECONDS
if ($whyDocs -ne "") { Stop-Here ("the served documents were not confirmed in " + $RIDE_TRIES + " reads (last: " + $whyDocs + "). Read npx wrangler deployments list and re-read /openapi.json, /llms.txt and /api/surface by hand first. Only if the new version is at 100% and fresh reads still disagree: " + $ROLLBACK_LINE) }
Say "[ride] /openapi.json, /llms.txt and /api/surface carry both route sentences ($GOOD_READS_NEEDED good reads in a row)"
$sweepPaths = @("/", "/operators", "/api/official", "/openapi.json", "/treasury", "/api/listings", "/api/stats", "/api/topics", "/api/guest/due", "/api/citizens", "/api/council", "/api/residents", "/heartbeat.md", "/skill.md", "/llms.txt", "/privacy", "/api/proposal/8")
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
Say ("[ride] " + $sweepPaths.Count + " public reads -> 200 ($GOOD_READS_NEEDED sweeps in a row)")
$mcpCallsMin = $MCP_CALLS_PER_READ * $GOOD_READS_NEEDED
$mcpListsMin = $MCP_LISTS_PER_READ * $GOOD_READS_NEEDED
$mcpPostsMin = 2 * ($mcpCallsMin + $mcpListsMin)
Say ("[note] WHAT THIS RIDE PROVED: the stamped commit is serving; both inbox routes answer a cursor far above the head with 400, code cursor_above_head, keys exactly code and error and the unchanged text; a stray parameter with an above-head cursor, in either order, is refused 400 unknown_query_parameter first; both cursor_notes carry their route's full refusal-list sentence over HTTP, and the answers of the inbox and guest_inbox tools on both doors carry the same sentences (the base 9f7fe955 serves neither); /openapi.json, /llms.txt and /api/surface carry both full route sentences; the inbox and guest_inbox tools on both doors refuse an above-head cursor (isError true, the unchanged text, the only key `error`); the above-head code of this morning and the 25 Nov wave still hold (unknown and repeated parameters refused with their codes, the tools refuse an unknown argument and let secret and token through, the cap sentences, tools/list schemas); the 24 Nov cursor refusal still works; the rotate and wallet routes still refuse a caller with no credential. " +
  "WHAT IT DID NOT PROVE: that a tool refusal carries a code (it does not: the tools serve {error} only, and the ride asserts exactly that); that secret and token are unused (the tests show it, not this ride); the wording of the pay-route refusals (PAY_REFUSED_BEFORE_402) and of the pay reservation refusal, which need a citizen's credential and a signed payment and stay NOT RIDDEN; the order of several above-head parts (only the first is named), which the unit tests prove, not this ride. " +
  "WHAT THIS RIDE ADDED TO THE DOOR FIGURES: per good read each door took " + $MCP_CALLS_PER_READ + " tools/call POSTs (four inbox, four guest_inbox: counted on receipt, refusals included, in mcp_tool_call or mcp_read_tool_call and in the per-tool rows mcp_tool:inbox, mcp_tool:guest_inbox, mcp_read_tool:inbox, mcp_read_tool:guest_inbox) and " + $MCP_LISTS_PER_READ + " tools/list POST (mcp_tools_list, mcp_read_tools_list). With " + $GOOD_READS_NEEDED + " good reads that is at least " + $mcpCallsMin + " tool calls and " + $mcpListsMin + " tools/list per door, " + $mcpPostsMin + " POSTs to /mcp and /mcp/read in all, more for every retried read (a retry adds at most the same again). " +
  "The pre-deploy GETs read no counted door, and the sweep reads /skill.md, /heartbeat.md and /operators, which are counted doors. The rotate and wallet refusals wrote nothing (authenticate() throws before any write). This script ran no wrangler command but the deploy and ran no D1 command of its own (the routes it called read D1 as they always do, and the counted doors write their counts).")
Say "[done] refusal-list wave deployed and ridden over HTTP (HTTP and MCP; the pay refusal wording not ridden). Log version id $versionId, commit $($headSha.Substring(0, 8)) and these lines, the [ray] lines included, in HANDOVER.md."
