# Deploys the 24 NOV SHIP: three read-only or refusing changes in ONE worker deploy.
#   1. Treasury disclosure: `payments_out` on GET /treasury, GET /api/treasury, GET /api/official (treasury.payments_out) and the `official` MCP tool on /mcp and /mcp/read (src/treasury-out.ts, officialAnswer in src/society.ts).
#      Gate: docs/REVIEW-TREASURY-DISCLOSURE-GATE-2026-11-24.md.
#   2. Inbox cursor refusal: GET /api/inbox and GET /api/guest/inbox answer 400 for a cursor part above its own table's newest row (src/inbox.ts refuseAboveHead).
#      Gate and its ride (condition C2): docs/REVIEW-INBOX-CURSOR-HEAD-GATE-2026-11-24.md.
#   3. The treasury's own address refused in POST /api/wallet (400 wallet_is_treasury) and POST /api/listing/:id/pay. Gate: docs/REVIEW-WALLET-NOT-TREASURY-GATE-2026-11-24.md (Opus).
# Brief: drafts/BUILDER-BRIEF-deploy-ship-2026-11-24.md. Derived from scripts/deploy-agent-card.ps1; what this ship does not need is deleted (the A2A sends and the counted probe doors, the operators page and pointer checks,
# the /skill.md and /heartbeat.md hashes, the door-count baseline and the UTC clock refusal).
# ONE worker deploy. Ben's hand only (D-017). One fail-fast script (L-046, L-069). NO MIGRATION, NO D1 WRITE, NO D1 COMMAND OF ITS OWN, NO MINT: step 0 STOPS if migrations/, schema.sql or src/doc.ts differ between the live base and HEAD.
# The ONLY wrangler command this script runs is the stamped deploy.
# TWO PINS. $LIVE_BASE_COMMIT is the commit the live worker serves when this runs (097a4a89: the agent card / A2A wave); step 2 PROVES it against the live GET /api/attest code.commit.
# $REVIEWED_COMMIT is the commit the reviews read (70202a1e). Step 0a STOPS, before any git or network command, while EITHER pin still holds its placeholder or is not 40 lower-case hex.
# REVIEWED SOURCE ONLY: step 0 also STOPS unless HEAD is $REVIEWED_COMMIT plus changes confined to $ALLOWED_PATHS_AFTER_REVIEW (this script, its test, the wallet-not-treasury gate record).
# THE DEPLOY STAMPS THE COMMIT: `npx wrangler deploy --var CODE_COMMIT:<sha>`. The poll waits until GET /api/attest serves code.commit equal to the pinned sha AND code.version_id equal to the
# Current Version ID wrangler printed. THE STAMP IS THE ONLY PROOF THE NEW CODE IS LIVE; the ride below then exercises the wave over HTTP.
# BEFORE THE DEPLOY (the dry run does all of it, one read is the state and may stop):
#   - the live base is the pinned one and the chains and v6 are as expected;
#   - GET /api/events?kind=wallet_declared and ?kind=wallet_changed (the route has no paging, LIMIT 500: a kind at 500 rows STOPS, it cannot be proved complete): no row makes the served treasury address anyone's current wallet;
#   - /treasury, /api/treasury and /api/official carry no payments_out yet;
#   - an inbox cursor one above the comment head answers 200 today (that is the defect; a 400 already means the base is not what we think).
# THE RIDE (every check retried until $GOOD_READS_NEEDED good reads in a row, L-167):
#   - payments_out is ONE identical object on the five surfaces; from_treasury equals GET /payouts; listing_bounties equals GET /api/listings/payments (the totals always, the row counts and the recomputed
#     operator-wallet figures only where the page is under its 200-row cap); code_can_pay is false; the note carries the two sentences the brief names;
#   - the inbox cursor ride, as the inbox gate's condition C2 sets it out, GET only, heads read first, the visitor number taken from GET /api/guest/due;
#   - /openapi.json carries the refusal sentence on both cursor parameters; GET /api/surface's POST /api/wallet note carries wallet_is_treasury;
#   - the rotate and wallet 401 refusals and the two agent cards (which are COUNTED reads: see the closing note) answer as before; the public reads are 200.
# WHAT THE RIDE DOES NOT PROVE: the treasury-address refusal itself. It needs a citizen's credential, and the ride holds none. The first real attempt is its ride.
# Run from society/ on main, after the merge and the push:
#   cd "C:\Users\bengr\Projects\AI domain and social network\society"
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-ship-2026-11-24.ps1 -ExpectedCommit <sha> -DryRun   # every check and the live reads, nothing deployed
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-ship-2026-11-24.ps1 -ExpectedCommit <sha>           # the real thing
# <sha> is the pushed tip of main (git -C society rev-parse HEAD), the full 40 hex.
# INBOX GATE C1 (no read may come from a replica behind the one that served a cursor) is met by source: without the Sessions API D1 answers from the primary, and step 0 STOPS if any file under src/ calls withSession.
# THE UTC DAY. Nothing in this ride compares one UTC day's counts, so the 23:30 refusal the template carried is removed.
# The ROLLBACK TARGET is the version id GET /api/attest served BEFORE the deploy (read live, never typed in). The ship is rollback-safe: no schema change.
# THE RIDE holds no token, key or assertion and prints none: public GETs, two credential-free `official` tools/call POSTs (the body is sent from a temp file, curl.exe --data-binary "@file"), and the refused POSTs to /api/rotate and /api/wallet.
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
# The commit the live worker serves when this runs (the agent card / A2A wave).
$LIVE_BASE_COMMIT = "097a4a895f4b3fafe87b6d5c2bd4472edf926600"
$LIVE_BASE_PLACEHOLDER = "TO-BE-SET-BY-HUB-LIVE-BASE"
# THE REVIEWED SOURCE. Step 0 STOPS while this is the placeholder, and while it is not 40 lower-case hex.
$REVIEWED_COMMIT = "70202a1e81ef0ce78b900c916042da8f8936a25d"
$REVIEWED_COMMIT_PLACEHOLDER = "TO-BE-SET-BY-HUB"
$ALLOWED_PATHS_AFTER_REVIEW = @("scripts/deploy-ship-2026-11-24.ps1", "test/deploy-ship-2026-11-24-script.test.ts", "docs/REVIEW-WALLET-NOT-TREASURY-GATE-2026-11-24.md")
$ROTATE_URL = "$BASE/api/rotate"
$WALLET_URL = "$BASE/api/wallet"
# The two refusal texts the ride reads, exactly as src/society.ts authenticate() serves them (the test pins both against the source). A prefix of each is checked.
$NO_CREDENTIALS_PREFIX = "No credentials. Register first"
$UNKNOWN_SECRET_TEXT = "Unknown secret. It identifies no citizen."
# A bearer string that is no citizen's secret (it does not have newSecret()'s commonhold_sk_ shape) and not an assertion (no ch1. prefix): authenticate() hashes it, finds no row and refuses. It writes nothing.
$NOT_A_SECRET = "commonhold-ride-not-a-credential"
# The two sentences of PAYMENTS_OUT_NOTE the ride requires (the test pins both against src/treasury-out.ts).
$NOTE_WALLET_SENTENCE = "POST /api/wallet refuses the treasury's own address."
$NOTE_COPY_SENTENCE = "no copy of it anywhere else"
# The identity-log kinds that make an address someone's wallet (src/wallets.ts walletLogEntry), and the route's row cap (src/society.ts identityLog LIMIT 500).
$WALLET_KINDS = @("wallet_declared", "wallet_changed")
$IDENTITY_LOG_CAP = 500
# The row cap of GET /payouts and GET /api/listings/payments (LIMIT 200 in src/payouts.ts and src/listings.ts).
$BOOK_PAGE_CAP = 200
$HEADS_URL = "$BASE/api/inbox?handle=commonhold-agent&since=9999999999999"
$CITIZEN_INBOX_URL = "$BASE/api/inbox?handle=commonhold-agent"
$GUEST_INBOX_URL = "$BASE/api/guest/inbox?guest="
$CURSOR_ABOVE_SENTENCE = "or above the newest row id of its table, is refused with 400"
$CURSOR_NOTE_SENTENCE = "refused with 400"
$CITIZEN_RESTART_TAIL = "or pass since=<ms> instead of cursor to start again."
$GUEST_RESTART_TAIL = "omit cursor to start again."
$OFFICIAL_BODY = '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"official","arguments":{}}}'
$CARD_PATHS = @("/.well-known/agent-card.json", "/.well-known/agent.json")
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
    $body = (Get-Content $tmp -Raw -Encoding UTF8 -ErrorAction SilentlyContinue)
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
  Stop-Here ("the new worker was not shown live in " + $tries + " reads (last: " + $last + "). Read 'npx wrangler deployments list' and GET /api/attest by hand first: stale reads right after a deploy are common, and the deploy may be live. Only if the new version is not at 100% or fresh reads still disagree: " + $ROLLBACK_LINE)
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
    $body = (Get-Content $out -Raw -Encoding UTF8 -ErrorAction SilentlyContinue)
    if ($null -eq $body) { $body = "" }
    return @{ Code = [string]$code; Exit = $exit; Body = [string]$body }
  } finally {
    Remove-Item $out -ErrorAction SilentlyContinue
  }
}
# A JSON POST by curl.exe: the body goes from a temp file (--data-binary "@file", ASCII, deleted in finally), never as a quoted argument. Returns @{ Code; Exit; Body }. Never stops.
function Get-JsonPost($url, $bodyText) {
  $out = [System.IO.Path]::GetTempFileName()
  $req = [System.IO.Path]::GetTempFileName()
  try {
    [System.IO.File]::WriteAllText($req, $bodyText, (New-Object System.Text.UTF8Encoding($false)))
    $curlArgs = @("-s", "--max-time", "30", "-o", $out, "-w", "%{http_code}", "-H", "Content-Type: application/json", "--data-binary", ("@" + $req), $url)
    $code = (curl.exe @curlArgs)
    $exit = $LASTEXITCODE
    $body = (Get-Content $out -Raw -Encoding UTF8 -ErrorAction SilentlyContinue)
    if ($null -eq $body) { $body = "" }
    return @{ Code = [string]$code; Exit = $exit; Body = [string]$body }
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
# True for a JSON whole number (PowerShell reads one as Int32 or Int64), never for a string, a boolean or $null.
function Test-IsWhole($v) { return ($v -is [int] -or $v -is [long]) }
# The address a wallet row makes CURRENT, or "": "wallet declared: X" gives X, "wallet changed: A -> X" gives X, never A (src/wallets.ts walletAddressFromRow, the same two patterns).
function Get-WalletRowAddress($kind, $detail) {
  $m = $null
  if ([string]$kind -ceq "wallet_declared") { $m = [regex]::Match([string]$detail, '^wallet declared: (0x[0-9a-f]{40})$') }
  elseif ([string]$kind -ceq "wallet_changed") { $m = [regex]::Match([string]$detail, '^wallet changed: 0x[0-9a-f]{40} -> (0x[0-9a-f]{40})$') }
  if ($null -eq $m -or -not $m.Success) { return "" }
  return $m.Groups[1].Value
}
# The treasury address GET /treasury serves, or "" when it does not serve a well-formed one.
function Get-TreasuryAddress($treasuryJson) {
  if ($null -eq $treasuryJson -or $null -eq $treasuryJson.wallet) { return "" }
  $a = [string]$treasuryJson.wallet.address
  if ($a -cnotmatch '^0x[0-9a-fA-F]{40}$') { return "" }
  return $a
}
# "" when no row in $events makes $treasury (case-insensitive) a current wallet address, otherwise the reason. A row whose detail the two patterns cannot read is a reason too: it is not safe to call it clear.
function Test-WalletRowsClear($events, $treasury) {
  if ([string]$treasury -ceq "") { return "the served treasury address is missing or malformed, so the wallet rows cannot be compared with it" }
  $want = ([string]$treasury).ToLowerInvariant()
  foreach ($e in @($events)) {
    $addr = Get-WalletRowAddress $e.kind $e.detail
    if ($addr -ceq "") { return ("identity-log row " + $e.id + " (" + $e.kind + ") has a detail the script cannot read as a wallet address: it cannot be called clear") }
    if ($addr.ToLowerInvariant() -ceq $want) { return ("identity-log row " + $e.id + " (" + $e.kind + ", citizen " + $e.citizen + ") makes the treasury's own address " + $treasury + " a current wallet: the new refusal would not undo that. Read it by hand; NOT this script's deploy") }
  }
  return ""
}
# @{ Why; Events }: every row of both wallet kinds from GET /api/events?kind=, or why they could not be read completely. A kind at the route's row cap is a reason (the route has no paging).
function Get-WalletEvents {
  $all = @()
  foreach ($kind in $WALLET_KINDS) {
    $r = Get-Text ($BASE + "/api/events?kind=" + $kind) 30
    if ([string]$r.Code -cne "200") { return @{ Why = ("GET /api/events?kind=" + $kind + " answered " + $r.Code + ", expected 200"); Events = @() } }
    $j = Read-JsonBody $r
    if ($null -eq $j -or $null -eq $j.events) { return @{ Why = ("GET /api/events?kind=" + $kind + " carried no events member"); Events = @() } }
    if ([string]$j.filter -cne $kind) { return @{ Why = ("GET /api/events?kind=" + $kind + " says filter '" + $j.filter + "': the kind filter was not applied"); Events = @() } }
    $rows = @($j.events)
    if ($rows.Count -ge $IDENTITY_LOG_CAP) { return @{ Why = ("GET /api/events?kind=" + $kind + " returned " + $rows.Count + " rows, the route's cap: it cannot be shown to be every row"); Events = @() } }
    foreach ($row in $rows) {
      if ([string]$row.kind -cne $kind) { return @{ Why = ("GET /api/events?kind=" + $kind + " carried a row of kind '" + $row.kind + "'"); Events = @() } }
    }
    $all += $rows
  }
  return @{ Why = ""; Events = $all }
}
# "" when /treasury, /api/treasury and /api/official carry no payments_out (the before-state), otherwise the reason.
function Test-NoPaymentsOutYet {
  foreach ($path in "/treasury", "/api/treasury", "/api/official") {
    $r = Get-Text ($BASE + $path) 30
    if ([string]$r.Code -cne "200") { return ("GET " + $path + " answered " + $r.Code + ", expected 200") }
    $j = Read-JsonBody $r
    if ($null -eq $j) { return ("GET " + $path + " was not JSON") }
    $holder = $j
    if ($path -ceq "/api/official") {
      $holder = $j.treasury
      if ($null -eq $holder) { return "GET /api/official carried no treasury member" }
    }
    if ($holder.PSObject.Properties.Name -ccontains "payments_out") { return ("GET " + $path + " already carries payments_out: the base is not what we think") }
  }
  return ""
}
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
# BEFORE the deploy: "" when a citizen cursor one above the comment head answers 200 (the defect), otherwise the reason. A 400 says the refusal is already live.
function Test-CursorDefectPresent {
  $h = Read-CitizenHeads
  if ($h.Why -ne "") { return $h.Why }
  $r = Get-Text ($CITIZEN_INBOX_URL + "&cursor=" + (Format-CitizenCursor ($h.C + 1) $h.P $h.G $h.HasG)) 30
  if ([string]$r.Code -ceq "400") { return "GET /api/inbox with a cursor one above the comment head already answers 400: the refusal is live, so the base is not what we think" }
  if ([string]$r.Code -cne "200") { return ("GET /api/inbox with a cursor one above the comment head answered " + $r.Code + ", expected 200 (the defect this ship fixes)") }
  return ""
}
# The visitor number of the newest guest critique GET /api/guest/due lists (the number after # in its author byline), or "" when none can be read. A public answer, never a guess.
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
# THE INBOX GATE'S C2 RIDE (docs/REVIEW-INBOX-CURSOR-HEAD-GATE-2026-11-24.md, steps 1-5). GET only. $visitor is the guest number from a public answer. "" or the first reason.
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
  $gC = [long]$gm.Groups[2].Value
  $why = Test-Reads200 ($GUEST_INBOX_URL + $visitor + "&cursor=" + [string]$gj.next_cursor) "GET /api/guest/inbox replaying its next_cursor"
  if ($why -ne "") { return $why }
  $above = "g" + $gm.Groups[1].Value + "-c" + ($gC + 1) + "-p" + $gm.Groups[3].Value
  $r = Get-Text ($GUEST_INBOX_URL + $visitor + "&cursor=" + $above) 30
  return (Test-CursorRefusal $r "GET /api/guest/inbox with comment id head+1" "comment" ($gC + 1) $gC $GUEST_RESTART_TAIL)
}
# "" when /openapi.json carries the refusal sentence on the cursor parameter of both inbox routes, otherwise the reason.
function Test-OpenApiCursorText {
  $r = Get-Text ($BASE + "/openapi.json") 30
  if ([string]$r.Code -cne "200") { return ("GET /openapi.json answered " + $r.Code + ", expected 200") }
  $j = Read-JsonBody $r
  if ($null -eq $j -or $null -eq $j.paths) { return "GET /openapi.json was not an OpenAPI document" }
  foreach ($path in "/api/inbox", "/api/guest/inbox") {
    $item = $j.paths.PSObject.Properties[$path].Value
    if ($null -eq $item -or $null -eq $item.get) { return ("GET /openapi.json lists no get operation for " + $path) }
    $cursorParams = @(@($item.get.parameters) | Where-Object { [string]$_.name -ceq "cursor" })
    if ($cursorParams.Count -ne 1) { return ("GET /openapi.json: " + $path + " declares " + $cursorParams.Count + " cursor parameters, expected 1") }
    $text = [string](ConvertTo-Json -InputObject $cursorParams[0] -Compress -Depth 20)
    if (-not $text.Contains($CURSOR_ABOVE_SENTENCE)) { return ("GET /openapi.json: the cursor parameter of " + $path + " does not contain '" + $CURSOR_ABOVE_SENTENCE + "'") }
  }
  return ""
}
# "" when GET /api/surface lists POST /api/wallet with a note that names wallet_is_treasury, otherwise the reason.
function Test-SurfaceWalletNote {
  $r = Get-Text ($BASE + "/api/surface") 30
  if ([string]$r.Code -cne "200") { return ("GET /api/surface answered " + $r.Code + ", expected 200") }
  $j = Read-JsonBody $r
  if ($null -eq $j -or $null -eq $j.routes) { return "GET /api/surface was not the route list" }
  foreach ($route in @($j.routes)) {
    if ([string]$route.method -ceq "POST" -and [string]$route.path -ceq "/api/wallet") {
      if (-not ([string]$route.note).Contains("wallet_is_treasury")) { return "GET /api/surface lists POST /api/wallet but its note does not name wallet_is_treasury" }
      return ""
    }
  }
  return "GET /api/surface does not list POST /api/wallet"
}
# The `official` tool's payments_out from a credential-free tools/call POST to $path: @{ Why; Obj }. These are POSTs, so they ADD to the door figures (see the closing note). Never stops.
function Get-McpPaymentsOut($path) {
  $a = Get-JsonPost ($BASE + $path) $OFFICIAL_BODY
  if ($a.Exit -ne 0) { return @{ Why = ("POST " + $path + " official: curl exited " + $a.Exit); Obj = $null } }
  if ([string]$a.Code -cne "200") { return @{ Why = ("POST " + $path + " official answered " + $a.Code + ", expected 200"); Obj = $null } }
  $j = Read-JsonBody $a
  if ($null -eq $j -or $null -eq $j.result -or $null -eq $j.result.content) { return @{ Why = ("POST " + $path + " official carried no result.content"); Obj = $null } }
  if ($j.result.isError -eq $true) { return @{ Why = ("POST " + $path + " official answered isError true"); Obj = $null } }
  try { $inner = ([string]@($j.result.content)[0].text | ConvertFrom-Json) } catch { return @{ Why = ("POST " + $path + " official: the content text was not JSON"); Obj = $null } }
  if ($null -eq $inner -or $null -eq $inner.treasury -or $null -eq $inner.treasury.payments_out) { return @{ Why = ("POST " + $path + " official carried no treasury.payments_out"); Obj = $null } }
  return @{ Why = ""; Obj = $inner.treasury.payments_out }
}
# @{ Why; Items }: payments_out as each of the five surfaces serves it, Items being @{ Label; Obj }. A surface that does not carry it is the reason.
function Read-PaymentsOutFive {
  $items = @()
  foreach ($path in "/treasury", "/api/treasury", "/api/official") {
    $r = Get-Text ($BASE + $path) 30
    if ([string]$r.Code -cne "200") { return @{ Why = ("GET " + $path + " answered " + $r.Code + ", expected 200"); Items = @() } }
    $j = Read-JsonBody $r
    if ($null -eq $j) { return @{ Why = ("GET " + $path + " was not JSON"); Items = @() } }
    $obj = $j.payments_out
    if ($path -ceq "/api/official") { $obj = $j.treasury.payments_out }
    if ($null -eq $obj) { return @{ Why = ("GET " + $path + " carries no payments_out"); Items = @() } }
    $items += @{ Label = ("GET " + $path); Obj = $obj }
  }
  foreach ($path in "/mcp", "/mcp/read") {
    $m = Get-McpPaymentsOut $path
    if ($m.Why -ne "") { return @{ Why = $m.Why; Items = @() } }
    $items += @{ Label = ("the official tool on " + $path); Obj = $m.Obj }
  }
  return @{ Why = ""; Items = $items }
}
# "" when every surface in $items served the identical payments_out object, otherwise the reason. Compared as compact JSON, so a field, its order or a figure that differs is caught.
function Test-FiveIdentical($items) {
  $first = [string](ConvertTo-Json -InputObject @($items)[0].Obj -Compress -Depth 20)
  foreach ($one in @($items)) {
    $text = [string](ConvertTo-Json -InputObject $one.Obj -Compress -Depth 20)
    if ($text -cne $first) { return ("payments_out on " + $one.Label + " differs from the one on " + @($items)[0].Label) }
  }
  return ""
}
# "" when the one payments_out object $po agrees with the two public books and states what the brief requires, otherwise the first reason.
# $payouts is GET /payouts, $payments is GET /api/listings/payments (both parsed). Row counts and the operator-wallet recompute are used only where the page is under its row cap (a capped page is not the whole book).
function Test-PaymentsOutJudge($po, $payouts, $payments) {
  if ($null -eq $po -or $null -eq $po.from_treasury -or $null -eq $po.listing_bounties) { return "payments_out lacks from_treasury or listing_bounties" }
  $ft = $po.from_treasury
  $lb = $po.listing_bounties
  if ($ft.code_can_pay -isnot [bool] -or $ft.code_can_pay -ne $false) { return ("from_treasury.code_can_pay is '" + $ft.code_can_pay + "', expected the boolean false") }
  if ($null -eq $payouts -or -not (Test-IsWhole $payouts.total_paid_cents) -or $payouts.entries -isnot [array]) { return "GET /payouts was not the payouts book" }
  if ($null -eq $payments -or -not (Test-IsWhole $payments.total_paid_cents) -or $payments.entries -isnot [array]) { return "GET /api/listings/payments was not the payments book" }
  foreach ($name in "recorded_payouts", "total_cents") {
    if (-not (Test-IsWhole $ft.$name)) { return ("from_treasury." + $name + " is '" + $ft.$name + "', expected a whole number") }
  }
  foreach ($name in "paid", "total_cents") {
    if (-not (Test-IsWhole $lb.$name)) { return ("listing_bounties." + $name + " is '" + $lb.$name + "', expected a whole number") }
  }
  $payoutRows = @($payouts.entries)
  if ([long]$ft.total_cents -ne [long]$payouts.total_paid_cents) { return ("from_treasury.total_cents is " + $ft.total_cents + ", GET /payouts total_paid_cents is " + $payouts.total_paid_cents) }
  if ($payoutRows.Count -lt $BOOK_PAGE_CAP -and [long]$ft.recorded_payouts -ne $payoutRows.Count) { return ("from_treasury.recorded_payouts is " + $ft.recorded_payouts + ", GET /payouts lists " + $payoutRows.Count + " rows (under its cap, so that is the whole book)") }
  if ([long]$lb.total_cents -ne [long]$payments.total_paid_cents) { return ("listing_bounties.total_cents is " + $lb.total_cents + ", GET /api/listings/payments total_paid_cents is " + $payments.total_paid_cents) }
  $paymentRows = @($payments.entries)
  if ($paymentRows.Count -lt $BOOK_PAGE_CAP -and [long]$lb.paid -ne $paymentRows.Count) { return ("listing_bounties.paid is " + $lb.paid + ", GET /api/listings/payments lists " + $paymentRows.Count + " rows (under its cap, so that is the whole book)") }
  $op = $lb.paid_from_operator_wallet
  if ($null -eq $op) { return "listing_bounties.paid_from_operator_wallet is missing" }
  if ([string]$op.wallet -cnotmatch '^0x[0-9a-f]{40}$') { return ("paid_from_operator_wallet.wallet is '" + $op.wallet + "', expected 0x and 40 lower-case hex") }
  foreach ($name in "paid", "total_cents") {
    if (-not (Test-IsWhole $op.$name)) { return ("paid_from_operator_wallet." + $name + " is '" + $op.$name + "', expected a whole number") }
  }
  if ($paymentRows.Count -lt $BOOK_PAGE_CAP) {
    $n = 0
    $cents = 0
    foreach ($row in $paymentRows) {
      if ($null -eq $row -or -not (Test-IsWhole $row.amount_cents)) { return "GET /api/listings/payments carried a row whose amount_cents is not a whole number" }
      if (([string]$row.payer_address).ToLowerInvariant() -ceq [string]$op.wallet) { $n = $n + 1; $cents = $cents + [long]$row.amount_cents }
    }
    if ([long]$op.paid -ne $n -or [long]$op.total_cents -ne $cents) { return ("paid_from_operator_wallet is " + $op.paid + " payments, " + $op.total_cents + " cents; recomputed from GET /api/listings/payments rows whose payer_address is " + $op.wallet + ": " + $n + " payments, " + $cents + " cents") }
  }
  if (-not ([string]$po.note).Contains($NOTE_WALLET_SENTENCE)) { return ("the payments_out note lacks the sentence '" + $NOTE_WALLET_SENTENCE + "'") }
  if (-not ([string]$po.note).Contains($NOTE_COPY_SENTENCE)) { return ("the payments_out note lacks the words '" + $NOTE_COPY_SENTENCE + "'") }
  return ""
}
# "" when payments_out is one identical object on the five surfaces and agrees with the two books, otherwise the reason. Every read is fresh (a payment can land between two).
function Test-PaymentsOutServed {
  $five = Read-PaymentsOutFive
  if ($five.Why -ne "") { return $five.Why }
  $why = Test-FiveIdentical $five.Items
  if ($why -ne "") { return $why }
  $p1 = Get-Text ($BASE + "/payouts") 30
  if ([string]$p1.Code -cne "200") { return ("GET /payouts answered " + $p1.Code + ", expected 200") }
  $p2 = Get-Text ($BASE + "/api/listings/payments") 30
  if ([string]$p2.Code -cne "200") { return ("GET /api/listings/payments answered " + $p2.Code + ", expected 200") }
  return (Test-PaymentsOutJudge @($five.Items)[0].Obj (Read-JsonBody $p1) (Read-JsonBody $p2))
}
# "" when both agent cards answer 200 as JSON with a name and a version. These two GETs ADD to the agent_card door count (see the closing note).
function Test-CardsServed {
  foreach ($path in $CARD_PATHS) {
    $r = Get-Text ($BASE + $path) 30
    if ([string]$r.Code -cne "200") { return ("GET " + $path + " answered " + $r.Code + ", expected 200") }
    if (-not ([string]$r.Type).StartsWith("application/json")) { return ("GET " + $path + ": the content type is '" + $r.Type + "', expected application/json") }
    $j = Read-JsonBody $r
    if ($null -eq $j) { return ("GET " + $path + " was not JSON") }
    foreach ($field in "name", "version") {
      if ([string]$j.$field -ceq "") { return ("GET " + $path + ": " + $field + " is missing or empty") }
    }
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
if (-not (Select-String -Path "src/treasury-out.ts" -Pattern "export async function paymentsOut(" -SimpleMatch -Quiet)) { Stop-Here "src/treasury-out.ts has no paymentsOut: this checkout is not the treasury disclosure." }
if (-not (Select-String -Path "src/society.ts" -Pattern "payments_out: await paymentsOut(env.DB, OPERATOR_WALLET)" -SimpleMatch -Quiet)) { Stop-Here "src/society.ts does not serve payments_out on /api/official: this checkout is not the treasury disclosure." }
if (-not (Select-String -Path "src/inbox.ts" -Pattern "function refuseAboveHead(" -SimpleMatch -Quiet)) { Stop-Here "src/inbox.ts has no refuseAboveHead: this checkout is not the inbox cursor refusal." }
if (-not (Select-String -Path "src/wallets.ts" -Pattern '"wallet_is_treasury"' -SimpleMatch -Quiet)) { Stop-Here "src/wallets.ts does not refuse the treasury's own address: this checkout is not the wallet-not-treasury change." }
if (-not (Select-String -Path "src/listings.ts" -Pattern '"wallet_is_treasury",' -SimpleMatch -Quiet)) { Stop-Here "src/listings.ts does not refuse a treasury wallet row on the pay route: this checkout is not the wallet-not-treasury change." }
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

# 2. live, before, GETs only (the dry run does all of it): non-minting baseline, the live worker is the pinned base, no wallet row makes the treasury address a wallet, no payments_out yet, the cursor defect present.
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
$treasuryBefore = Get-Text "$BASE/treasury" 30
if ([string]$treasuryBefore.Code -cne "200") { Stop-Here ("GET /treasury answered " + $treasuryBefore.Code + " before the deploy, expected 200.") }
$treasuryAddress = Get-TreasuryAddress (Read-JsonBody $treasuryBefore)
if ($treasuryAddress -ceq "") { Stop-Here "GET /treasury served no well-formed wallet.address: the wallet rows cannot be compared with it." }
$walletRead = Get-WalletEvents
if ($walletRead.Why -ne "") { Stop-Here ("before the deploy, " + $walletRead.Why + ": read the wallet rows by hand.") }
$walletWhy = Test-WalletRowsClear $walletRead.Events $treasuryAddress
if ($walletWhy -ne "") { Stop-Here ("before the deploy, " + $walletWhy + ".") }
Say ("[live] before: " + @($walletRead.Events).Count + " wallet rows (wallet_declared and wallet_changed), none makes the treasury address " + $treasuryAddress + " a current wallet")
$absentWhy = Test-NoPaymentsOutYet
if ($absentWhy -ne "") { Stop-Here ("before the deploy, " + $absentWhy + ".") }
Say "[live] before: /treasury, /api/treasury and /api/official carry no payments_out"
$defectWhy = Test-CursorDefectPresent
if ($defectWhy -ne "") { Stop-Here ("before the deploy, " + $defectWhy + ".") }
Say "[live] before: an inbox cursor one above the comment head answers 200 (the defect this ship fixes)"
$visitorNumber = Get-VisitorNumber
if ($visitorNumber -ceq "") { Stop-Here "before the deploy, no visitor number could be read from GET /api/guest/due (history): the ride's guest inbox step cannot run. Read it by hand." }
Say "[live] before: the guest ride will use visitor number $visitorNumber, read from GET /api/guest/due"

if ($DryRun) {
  Say "[dry-run] every pin, git, source, test and live check passed. Every live read was a GET: /api/attest, /treasury, the two /api/events kinds, /api/treasury, /api/official, /api/inbox (the heads and one cursor above the head) and /api/guest/due. It sent NO POST, no JSON-RPC body, no wrangler command at all (this script runs no D1 command of its own) and wrote nothing. would now: run npx wrangler deploy --var CODE_COMMIT:<the full sha> and capture its Current Version ID (refusing to continue without one); poll up to $POLL_TRIES times, $POLL_DELAY_SECONDS s apart, until $GOOD_READS_NEEDED reads in a row show GET /api/attest serving that commit and version id; then ride (each check retried up to $RIDE_TRIES reads, $GOOD_READS_NEEDED good in a row): the rotate and wallet 401 refusals, payments_out on the five surfaces against the two books, the inbox cursor ride, /openapi.json and /api/surface, the two agent cards and the public reads. Nothing was deployed."
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
# message says to read the deployments list by hand first, and only then names the rollback): non-minting and the chains, the wallet and rotate refusals, payments_out, the cursor ride, the discovery text, the cards, then a sweep of public reads.
$whyAttest = Confirm-Reads {
  $a = Get-ServedAttest
  $m = Get-AttestReason $a
  if ($m -ne "") { return $m }
  return (Test-CodeIdentityServed $a.code $headSha $versionId)
} $GOOD_READS_NEEDED $RIDE_TRIES $RIDE_DELAY_SECONDS
if ($whyAttest -ne "") { Stop-Here ("GET /api/attest was not confirmed after the deploy in " + $RIDE_TRIES + " reads (last: " + $whyAttest + "). Read npx wrangler deployments list by hand first: another deploy may have taken over, or the edge is still catching up. Only if the new version is at 100% and fresh reads still disagree: " + $ROLLBACK_LINE) }
Say ("[ride] attest: v6 " + $V6_HASH.Substring(0, 8) + " unchanged; every chain ok; code.commit " + $headSha.Substring(0, 8) + ", code.version_id " + $versionId + " ($GOOD_READS_NEEDED good reads in a row)")
$whyRotate = Confirm-Reads { return (Test-RouteRefusals $ROTATE_URL "/api/rotate") } $GOOD_READS_NEEDED $RIDE_TRIES $RIDE_DELAY_SECONDS
if ($whyRotate -ne "") { Stop-Here ("the rotate route was not confirmed to refuse as before in " + $RIDE_TRIES + " reads (last: " + $whyRotate + "). Read npx wrangler deployments list and POST /api/rotate by hand first. Only if the new version is at 100% and fresh reads still disagree: " + $ROLLBACK_LINE) }
Say "[ride] POST /api/rotate -> 401 No credentials, 401 Unknown secret; GET /api/rotate -> 404 ($GOOD_READS_NEEDED good reads in a row)"
$whyWallet = Confirm-Reads { return (Test-RouteRefusals $WALLET_URL "/api/wallet") } $GOOD_READS_NEEDED $RIDE_TRIES $RIDE_DELAY_SECONDS
if ($whyWallet -ne "") { Stop-Here ("the wallet route was not confirmed to refuse as before in " + $RIDE_TRIES + " reads (last: " + $whyWallet + "). Read npx wrangler deployments list and POST /api/wallet by hand first. Only if the new version is at 100% and fresh reads still disagree: " + $ROLLBACK_LINE) }
Say "[ride] POST /api/wallet -> 401 No credentials, 401 Unknown secret; GET /api/wallet -> 404 ($GOOD_READS_NEEDED good reads in a row). These show the route still refuses a caller with no credential; the treasury-address refusal itself needs a citizen's credential and is NOT ridden."
$whyPay = Confirm-Reads { return (Test-PaymentsOutServed) } $GOOD_READS_NEEDED $RIDE_TRIES $RIDE_DELAY_SECONDS
if ($whyPay -ne "") { Stop-Here ("payments_out was not confirmed in " + $RIDE_TRIES + " reads (last: " + $whyPay + "). Read npx wrangler deployments list and the five surfaces by hand first. Only if the new version is at 100% and fresh reads still disagree: " + $ROLLBACK_LINE) }
Say "[ride] payments_out is one identical object on /treasury, /api/treasury, /api/official, and the official tool on /mcp and /mcp/read; from_treasury equals GET /payouts, listing_bounties equals GET /api/listings/payments, code_can_pay is false, the note carries both sentences ($GOOD_READS_NEEDED good reads in a row)"
$whyCursor = Confirm-Reads { return (Test-CursorRide (Get-VisitorNumber)) } $GOOD_READS_NEEDED $RIDE_TRIES $RIDE_DELAY_SECONDS
if ($whyCursor -ne "") { Stop-Here ("the inbox cursor ride was not confirmed in " + $RIDE_TRIES + " reads (last: " + $whyCursor + "). Gate condition C2: a step that differs means the prior worker. Read npx wrangler deployments list and the two inbox routes by hand first. Only if the new version is at 100% and fresh reads still disagree: " + $ROLLBACK_LINE) }
Say "[ride] inbox cursor ride (gate C2): head cursor 200; comment, post and guest-row id one above the head 400 with the gate's text; since=0 200 with the cursor_note sentence and its served next_cursor 200; /api/guest/inbox 200, replay 200, comment id above the head 400 ($GOOD_READS_NEEDED good reads in a row)"
$whyDocs = Confirm-Reads { $w = Test-OpenApiCursorText; if ($w -ne "") { return $w }; return (Test-SurfaceWalletNote) } $GOOD_READS_NEEDED $RIDE_TRIES $RIDE_DELAY_SECONDS
if ($whyDocs -ne "") { Stop-Here ("the served documents were not confirmed in " + $RIDE_TRIES + " reads (last: " + $whyDocs + "). Read npx wrangler deployments list and re-read /openapi.json and /api/surface by hand first. Only if the new version is at 100% and fresh reads still disagree: " + $ROLLBACK_LINE) }
Say "[ride] /openapi.json carries the refusal sentence on both cursor parameters; /api/surface's POST /api/wallet note names wallet_is_treasury"
$whyCards = Confirm-Reads { return (Test-CardsServed) } $GOOD_READS_NEEDED $RIDE_TRIES $RIDE_DELAY_SECONDS
if ($whyCards -ne "") { Stop-Here ("the agent cards were not confirmed in " + $RIDE_TRIES + " reads (last: " + $whyCards + "). Read npx wrangler deployments list and both card paths by hand first. Only if the new version is at 100% and fresh reads still disagree: " + $ROLLBACK_LINE) }
Say "[ride] both agent cards answer 200 as JSON with a name and a version ($GOOD_READS_NEEDED good reads in a row)"
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
$mcpPostsMin = 2 * $GOOD_READS_NEEDED
$cardGetsMin = $CARD_PATHS.Count * $GOOD_READS_NEEDED
Say ("[note] WHAT THIS RIDE PROVED: the stamped commit is serving; payments_out is one identical object on the five surfaces and agrees with GET /payouts and GET /api/listings/payments (the row counts and the operator-wallet recompute only where a page is under its " + $BOOK_PAGE_CAP + "-row cap); code_can_pay is false; the inbox cursor refusal is live on both inbox routes as the inbox gate's ride sets it out; /openapi.json and /api/surface carry the new text; the rotate and wallet routes still refuse a caller with no credential; both agent cards answer. " +
  "WHAT IT DID NOT PROVE: the refusal of the treasury's own address in POST /api/wallet and POST /api/listing/:id/pay. That needs a citizen's credential, which this ride does not hold; the first real attempt is its ride. " +
  "WHAT THIS RIDE ADDED TO THE DOOR FIGURES: the two official tools/call POSTs per good read are POSTs to /mcp and /mcp/read and add to those doors' call counts and to their per-tool counts for official: at least " + $mcpPostsMin + " (" + $GOOD_READS_NEEDED + " good reads, one POST to each door), more for every retried read. The two agent card GETs per good read add to the agent_card door: at least " + $cardGetsMin + ". The pre-deploy GETs added nothing but the plain-read counts every request attempts, and the sweep reads /skill.md, /heartbeat.md and /operators, which are counted doors. " +
  "The rotate and wallet refusals wrote nothing (authenticate() throws before any write). This script ran no wrangler command but the deploy and ran no D1 command of its own (the routes it called read D1 as they always do, and the counted doors write their counts).")
Say "[done] treasury disclosure, inbox cursor refusal and treasury-address refusal deployed and ridden over HTTP (the refusal itself not ridden). Log version id $versionId, commit $($headSha.Substring(0, 8)) and these lines in HANDOVER.md."
