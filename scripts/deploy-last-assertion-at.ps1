# Deploys the LAST-ASSERTION-AT WAVE (D-078 item 4): each citizen row carries last_assertion_at, the greatest SERVER time at which a valid signed assertion from that seat's key was spent here, stamped in the same D1 batch as
# the replay nonce and served on GET /api/citizens and the citizens tool of /mcp and /mcp/read. Spec: drafts/BRIEF-LAST-ASSERTION-AT-2026-11-04.md with amendments A1-A10 (A8 is this script's order); checkpoint
# docs/CHECKPOINT-LAST-ASSERTION-AT.md. Adapted from scripts/deploy-decided-event-id.ps1, keeping its fixes: reads by --command, one wrangler subcommand per bounded call, the one-hour window, the four chains compared on length and head.
# A MIGRATION WAVE, MIGRATION FIRST (L-046, L-016). Ben's hand only (D-017). One fail-fast script. NO MINT: step 1 STOPS if src/doc.ts differs between the live base and HEAD, and unless the ONLY migration added since the
# live base is migrations/0024_last_assertion_at.sql (a nullable ADD COLUMN: no default, no index, no rebuild, no FK detach, NO BACKFILL because auth_nonces keeps a row for seconds and earlier assertions are unknowable).
# THIS SCRIPT DOES NOT SIGN ANYTHING and holds no key. The worker's SELECT and UPDATE name the column, so a worker deployed BEFORE the migration would 500 the census and fail every assertion closed: the migration goes first.
# ORDER (A8): the rehearsal of the actual Worker binding authentication path against a scratch D1 (namespaced replay and raw-nonce collision, the existing 401 text, an unchanged stamp and nonces) has PASSED, which a real run
# confirms by -RehearsalPassed (a SQL-only wrangler run cannot prove the JavaScript catch; it needs Ben, since wrangler prompts); then 1 pins and git; 2 gates (npm test, typecheck); 3 live read of the base and the attested
# constitution; 4 the first production read, the catalogue state of citizens.last_assertion_at, which STARTS the clock: migration, worker activation and the post-activation verification must all finish within ONE HOUR of it
# (before every bounded step, the time since that read plus the step's upper bound must fit inside the window or the step is not started; wrangler commands are bounded by a timeout), else STOP for recovery and a fresh run;
# 5 apply 0024; 6 verify on prod: pragma_table_info shows the column as INTEGER and scripts/verify-last-assertion-at.sql returns ZERO rows (STOP on any offending row); 7 deploy the worker (stamped) and poll;
# 8 re-run the verification AFTER activation; 9 ride GET /api/attest (v6 unchanged, all four chains - identity_log, treasury, payouts, ballots - ok, and each chain's sealed_entries and head identical before and after),
# GET /api/citizens (the note and a last_assertion_at key on every row), the citizens tool on /mcp and /mcp/read, GET /privacy (the paragraph), and sixteen public reads.
# WHAT THE RIDE CANNOT DO: public reads cannot execute authenticateByAssertion. If the optional step below is declined, the honest report is "public serving verified; production authentication write path not exercised", and the
# field is not called ridden. OPTIONAL STEP FOR BEN, after the deploy (the hub writes it, with the existing custody handling, not this script): one signed assertion from keyholder on GET /api/me, then GET /api/citizens must show
# keyholder's last_assertion_at move from null to a server time inside that minute.
# ROLLBACK (written before the deploy): a worker rollback (npx wrangler rollback, to the version GET /api/attest served BEFORE the deploy, read live) leaves migration 0024 applied: an extra nullable column the old worker never reads.
# The old worker records nothing, so stamps go stale from that moment; nothing needs repairing. Do not drop the column. A rollback after 0024 is safe.
# TWO PINS. $LIVE_BASE_COMMIT is the commit the live worker serves when this runs; step 3 PROVES it against the live GET /api/attest code.commit. $REVIEWED_COMMIT is the commit the review converged on. Both ship as
# placeholders: the hub sets them. Step 0a STOPS, before any git or network command, while EITHER holds its placeholder or is not 40 lower-case hex. -ExpectedCommit is required.
# REVIEWED SOURCE ONLY: step 1 also STOPS unless HEAD is $REVIEWED_COMMIT plus changes confined to $ALLOWED_PATHS_AFTER_REVIEW (this script, its test, docs/).
# Run from society/ on main, after the merge and the push:
#   cd "C:\Users\bengr\Projects\AI domain and social network\society"
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-last-assertion-at.ps1 -ExpectedCommit <sha> -DryRun                  # every check and the live reads (including the D1 catalogue read, a READ), nothing written, nothing deployed
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-last-assertion-at.ps1 -ExpectedCommit <sha> -RehearsalPassed        # the real thing
#   If the migration was applied and a step BEFORE the worker deploy stopped: re-run with -MigrationAlreadyApplied (the catalogue and the verification still run).
#   Once the worker has been deployed there is no resume mode: a re-run refuses because the live commit or note already matches. If a stop comes after the deploy, the worker is live: finish the remaining verification
#   by hand with the GETs this script lists (/api/attest, /api/citizens, the citizens tool on /mcp and /mcp/read, /privacy), or roll back to the version id printed before the stop.
# THE RIDE writes nothing: public GETs, and two POSTs of a read-only tools/call whose body is sent from a temp file.
# PowerShell 5.1 traps this file avoids: one spelling per variable name; -notmatch on an array filters instead of testing; a one-element return is wrapped in @(); "$var:" is a drive reference (write "${var}:");
# never merge a native command's stderr under ErrorActionPreference Stop; -eq and -ne are case-INSENSITIVE (hashes and shas are compared with -ceq / -cne); PS 5.1 strips inner double quotes from a native command's
# argument, so every READ goes to wrangler by --command as one single-quote-only line (a statement with a double quote is refused), --file is used only for the migration, and request bodies go by
# --data-binary @file. ASCII only.
param(
  [Parameter(Mandatory = $true)][string]$ExpectedCommit,
  [switch]$DryRun,
  [switch]$MigrationAlreadyApplied,
  [switch]$RehearsalPassed
)
$ErrorActionPreference = "Stop"
$BASE = "https://commonhold.randommonicle.workers.dev"
$PROD_DB = "commonhold"
# The attested constitution this wave must leave untouched (v6, minted 22 Oct).
$V6_HASH = "dc5f48213c29bcf844e0fbe7daf1bdb5416b3d57fbd06a8bd03f1061f34092b3"
# The commit the live worker serves when this runs. The hub sets it.
$LIVE_BASE_COMMIT = "TO-BE-SET-BY-HUB-LIVE-BASE"
$LIVE_BASE_PLACEHOLDER = "TO-BE-SET-BY-HUB-LIVE-BASE"
# THE REVIEWED SOURCE. The hub replaces this placeholder with the full sha the review converged on; step 0a STOPS while it is unchanged, and while it is not 40 lower-case hex.
$REVIEWED_COMMIT = "TO-BE-SET-BY-HUB"
$REVIEWED_COMMIT_PLACEHOLDER = "TO-BE-SET-BY-HUB"
$ALLOWED_PATHS_AFTER_REVIEW = @("scripts/deploy-last-assertion-at.ps1", "test/deploy-last-assertion-at-script.test.ts", "docs/")
$MIGRATION_PATH_EXPECTED = "migrations/0024_last_assertion_at.sql"
$VERIFY_SQL_PATH = "scripts/verify-last-assertion-at.sql"
$WINDOW_SECONDS = 3600
$WRANGLER_D1_SECONDS = 120
$WRANGLER_DEPLOY_SECONDS = 300
$POLL_TRIES = 12
$POLL_DELAY_SECONDS = 5
# One poll try reads GET /api/attest and GET /api/citizens, each bounded by curl --max-time 30, then sleeps.
$POLL_READ_SECONDS = 60
$STAMP_FIELD = "last_assertion_at"
# The first words of the served note and of the privacy paragraph: the ride's markers that the new worker is the one serving.
$NOTE_MARKER = "last_assertion_at is the greatest server timestamp"
$PRIVACY_MARKER = "This lets readers observe recorded use of a seat's signing key"
$COLUMN_SQL = "SELECT name, type FROM pragma_table_info('citizens') WHERE name = 'last_assertion_at'"

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
# The status code, content type and body of a GET (or, with $dataFile, a POST of that file's bytes). The content type is read from curl's own -w, never guessed.
function Get-Text($url, $maxTime, $dataFile) {
  $tmp = [System.IO.Path]::GetTempFileName()
  try {
    if ($dataFile) {
      $meta = (curl.exe -s --max-time $maxTime -o $tmp -w "%{http_code}|%{content_type}" -H "Content-Type: application/json" --data-binary "@$dataFile" $url)
    } else {
      $meta = (curl.exe -s --max-time $maxTime -o $tmp -w "%{http_code}|%{content_type}" $url)
    }
    $parts = ([string]$meta).Split("|", 2)
    $body = (Get-Content $tmp -Raw -ErrorAction SilentlyContinue)
    if ($null -eq $body) { $body = "" }
    $type = ""
    if ($parts.Count -gt 1) { $type = [string]$parts[1] }
    return @{ Code = [string]$parts[0]; Type = $type; Body = $body }
  } finally {
    Remove-Item $tmp -ErrorAction SilentlyContinue
  }
}
function Get-Json($url) {
  $r = Get-Text $url 20 $null
  if ($r.Code -ne "200") { Stop-Here "GET $url -> $($r.Code), expected 200." }
  try { return ($r.Body | ConvertFrom-Json) } catch { Stop-Here "GET $url did not return JSON." }
}
function Read-Attest($when) {
  $att = Get-Json "$BASE/api/attest"
  if ($null -eq $att -or $null -eq $att.constitution -or -not $att.constitution.template_hash) { Stop-Here "GET /api/attest was unreadable $when; re-read it by hand (this is NOT a minting signal)." }
  return $att
}
function Assert-Attest($att, $when) {
  if ([string]$att.constitution.version -ne "6") { Stop-Here "constitution is version $($att.constitution.version) $when, expected 6: investigate before anything else." }
  if ($att.constitution.template_hash -cne $V6_HASH) { Stop-Here "template_hash is $($att.constitution.template_hash) $when, expected v6 ${V6_HASH}: investigate before anything else (this wave mints nothing)." }
  if ($att.ok -ne $true) { Stop-Here "GET /api/attest ok is '$($att.ok)' $when, expected true." }
  foreach ($chain in "identity_log", "treasury", "payouts", "ballots") {
    if ($att.$chain.ok -ne $true) { Stop-Here "chain $chain ok is '$($att.$chain.ok)' $when, expected true: investigate." }
  }
}
function Get-ServedCode {
  $r = Get-Text "$BASE/api/attest" 30 $null
  if ($r.Code -ne "200") { return $null }
  try { $served = ($r.Body | ConvertFrom-Json) } catch { return $null }
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
function Read-JsonBody($r) {
  try { return ([string]$r.Body | ConvertFrom-Json) } catch { return $null }
}
# ---- the D1 helpers: strict reads, bounded commands ----
# Runs a command line through cmd.exe with its stdout captured to a file, killing the whole process tree if it outlives $seconds. Returns @{ Code; Out; TimedOut }.
function Invoke-Bounded($commandLine, $seconds) {
  $outFile = [System.IO.Path]::GetTempFileName()
  try {
    $p = Start-Process -FilePath "cmd.exe" -ArgumentList ("/c " + $commandLine + " > `"" + $outFile + "`"") -NoNewWindow -PassThru
    $null = $p.Handle
    if (-not $p.WaitForExit($seconds * 1000)) {
      taskkill.exe /PID $p.Id /T /F | Out-Null
      return @{ Code = -1; Out = ""; TimedOut = $true }
    }
    $text = (Get-Content $outFile -Raw -ErrorAction SilentlyContinue)
    if ($null -eq $text) { $text = "" }
    return @{ Code = $p.ExitCode; Out = $text; TimedOut = $false }
  } finally {
    Remove-Item $outFile -ErrorAction SilentlyContinue
  }
}
# The result of `wrangler d1 execute --json` output as @{ Rows = <array> }, or $null when the output is not the expected JSON. The caller treats $null as a FAILED read, never as zero rows; a hashtable wrapper is used
# because an empty array returned from a function vanishes in the pipeline and would arrive as $null.
function Read-D1Rows($text) {
  $i = ([string]$text).IndexOf("[")
  if ($i -lt 0) { return $null }
  try { $parsed = (([string]$text).Substring($i) | ConvertFrom-Json) } catch { return $null }
  if ($null -eq $parsed -or @($parsed).Count -lt 1 -or $null -eq @($parsed)[0].results) { return $null }
  return @{ Rows = @(@($parsed)[0].results) }
}
# "" when the clock started less than $WINDOW_SECONDS ago, otherwise the reason the sequence must stop.
function Test-WithinWindow($checkedAt, $now) {
  if ($null -eq $checkedAt) { return "the first production read has not completed" }
  $age = ($now - $checkedAt).TotalSeconds
  if ($age -gt $WINDOW_SECONDS) { return ("the first production read completed " + [int]$age + " s ago, over the " + $WINDOW_SECONDS + " s window: stop for recovery and run afresh") }
  return ""
}
# "" when all four chains carry the same sealed_entries and the same head in both attest reads, otherwise the first difference. (Integrity is Assert-Attest's job; this is "nothing was written".)
function Test-ChainsUnchanged($before, $after) {
  foreach ($chain in "identity_log", "treasury", "payouts", "ballots") {
    foreach ($field in "sealed_entries", "head") {
      $b = [string]$before.$chain.$field
      $a = [string]$after.$chain.$field
      if ($b -eq "" -and $a -eq "") { return ("chain " + $chain + " carries no " + $field + " in either attest read: it cannot be compared") }
      if ($a -cne $b) { return ("chain " + $chain + " changed at " + $field + " during the deploy (" + $b + " -> " + $a + ")") }
    }
  }
  return ""
}
# "" when a step whose upper bound is $requiredSeconds can START now and still END inside the window (age plus the bound stays within $WINDOW_SECONDS), otherwise the reason it must not start.
function Test-SufficientWindow($checkedAt, $now, $requiredSeconds) {
  if ($null -eq $checkedAt) { return "the first production read has not completed" }
  $age = ($now - $checkedAt).TotalSeconds
  if (($age + $requiredSeconds) -gt $WINDOW_SECONDS) { return ("the first production read completed " + [int]$age + " s ago and the next bounded step may need up to " + $requiredSeconds + " s, over the " + $WINDOW_SECONDS + " s window: stop for recovery and run afresh") }
  return ""
}
# "" when $res is the successfully parsed ZERO-row result of the verification query, otherwise the reason (any row is an offender; an unparsable read is a failed read).
function Test-VerificationClean($res) {
  if ($null -eq $res) { return "the verification read returned no parsable result" }
  $list = @($res.Rows)
  if ($list.Count -gt 0) { return ("the verification returned " + $list.Count + " offending row(s), first: citizen " + $list[0].id + " " + $list[0].handle + " stamp '" + $list[0].last_assertion_at + "' type " + $list[0].stamp_type) }
  return ""
}
# "" when $res shows the column present with type INTEGER.
function Test-ColumnPresent($res) {
  if ($null -eq $res) { return "the column read returned no parsable result" }
  $list = @($res.Rows)
  if ($list.Count -ne 1) { return ("citizens has " + $list.Count + " last_assertion_at column rows, expected exactly 1") }
  if ([string]$list[0].type -cne "INTEGER") { return ("citizens.last_assertion_at has type '" + $list[0].type + "', expected INTEGER") }
  return ""
}
# SQL for wrangler goes by --command, never --file: with --file, `d1 execute` goes through D1's import API and returns statistics only, never rows (wrangler-dist/cli.js, the input.file branch), so a SELECT read that
# way can only fail closed. --file stays for the migration apply, whose result is the exit code alone.
# One line, single quotes only: PowerShell 5.1 mangles embedded double quotes when it calls a native exe, so a statement containing one is refused. Full-line -- comments are stripped and whitespace collapsed.
function ConvertTo-SingleLineSql($text) {
  $kept = @()
  foreach ($line in (([string]$text).Replace("`r`n", "`n").Split("`n"))) {
    $t = $line.Trim()
    if ($t -eq "" -or $t.StartsWith("--")) { continue }
    $kept += $t
  }
  return ((($kept -join " ") -replace '\s+', " ").Trim())
}
# "" when $sql is safe to hand to a native exe as one --command argument, otherwise the reason it is refused.
function Test-SingleLineSql($sql) {
  if ([string]$sql -eq "") { return "the SQL is empty" }
  if (([string]$sql).Contains('"')) { return "the SQL contains a double quote, which PowerShell 5.1 mangles in a native argument" }
  if (([string]$sql).Contains("--")) { return "the SQL still contains '--' after stripping full-line comments" }
  return ""
}
# Runs `$prefix "<sql>"` bounded. The statement travels in an environment variable that cmd.exe expands inside the quotes, so a percent sign or an angle bracket in it is never parsed as cmd syntax.
function Invoke-BoundedSql($prefix, $sql, $seconds) {
  $env:D1_SQL_ARG = $sql
  try {
    return (Invoke-Bounded ($prefix + ' "%D1_SQL_ARG%"') $seconds)
  } finally {
    Remove-Item Env:D1_SQL_ARG -ErrorAction SilentlyContinue
  }
}
# Runs one READ against the remote D1 by --command (bounded) and returns the parsed result, or STOPS.
function Invoke-D1Command($sql, $label) {
  $one = ConvertTo-SingleLineSql $sql
  $why = Test-SingleLineSql $one
  if ($why -ne "") { Stop-Here ("cannot send the SQL for " + $label + ": " + $why + ".") }
  # Every read after the first is itself a bounded step inside the window (the first read is the one that starts the clock).
  if ($null -ne $script:PreflightAt) { Assert-Window $label $WRANGLER_D1_SECONDS }
  $r = Invoke-BoundedSql ("npx wrangler d1 execute " + $PROD_DB + " --remote --json --command") $one $WRANGLER_D1_SECONDS
  if ($r.TimedOut) { Stop-Here ("wrangler d1 execute timed out after " + $WRANGLER_D1_SECONDS + " s on " + $label + ". The state is unknown: read the catalogue by hand before any retry.") }
  if ($r.Code -ne 0) { Stop-Here ("wrangler d1 execute failed (exit " + $r.Code + ") on " + $label + ".") }
  return (Read-D1Rows $r.Out)
}
function Invoke-D1Read($sql, $label) { return (Invoke-D1Command $sql $label) }
# STOPS, without starting the step, unless a step bounded by $requiredSeconds fits inside the window; with 0 it is the completion check.
function Assert-Window($label, $requiredSeconds) {
  $why = Test-SufficientWindow $script:PreflightAt (Get-Date) $requiredSeconds
  if ($why -ne "") { Stop-Here ("before " + $label + ": " + $why + ".") }
}
# Reads the catalogue and verification on prod and STOPS on any offending row.
function Assert-Prod-Verified($when) {
  $why = Test-ColumnPresent (Invoke-D1Read $COLUMN_SQL "the column read")
  if ($why -ne "") { Stop-Here ("catalogue check " + $when + " failed: " + $why + ".") }
  $why = Test-VerificationClean (Invoke-D1Command (Get-Content $VERIFY_SQL_PATH -Raw) "the verification")
  if ($why -ne "") { Stop-Here ("verification " + $when + " failed: " + $why + ". Do not deploy or continue; read the rows by hand.") }
}
# ---- the served-answer checks ----
# "" when $body is a parsed citizens list whose note carries the field's wording, whose every row carries the stamp key (null is allowed), whose every non-null stamp is a whole number, and whose
# secret-held rows (no public_key) carry null.
function Test-CitizensServed($body) {
  if ($null -eq $body) { return "the citizens list did not return JSON" }
  if (-not ([string]$body.note).Contains($NOTE_MARKER)) { return "the citizens note does not carry the last_assertion_at wording" }
  $rows = @($body.citizens)
  if ($rows.Count -lt 1) { return "the citizens list carries no rows" }
  foreach ($row in $rows) {
    if ($null -eq $row.PSObject.Properties[$STAMP_FIELD]) { return ("citizen " + $row.handle + " has no last_assertion_at key") }
    $value = $row.$STAMP_FIELD
    if ($null -ne $value) {
      if (-not ([string]$value -match '^[0-9]+$')) { return ("citizen " + $row.handle + " serves last_assertion_at '" + $value + "', not a whole number") }
      if (-not $row.public_key) { return ("citizen " + $row.handle + " has no public_key but serves last_assertion_at " + $value) }
    }
  }
  return ""
}
# "" when $text is the privacy page carrying the paragraph.
function Test-PrivacyServed($text) {
  if (-not ([string]$text).Contains($PRIVACY_MARKER)) { return "GET /privacy does not carry the last_assertion_at paragraph" }
  return ""
}
# The tool result of a JSON-RPC tools/call answer as parsed JSON, or $null.
function Read-ToolResult($r) {
  if ([string]$r.Code -cne "200") { return $null }
  $j = Read-JsonBody $r
  if ($null -eq $j -or $null -eq $j.result -or $j.result.isError -eq $true) { return $null }
  try { return ([string]$j.result.content[0].text | ConvertFrom-Json) } catch { return $null }
}
# Posts a read-only tools/call (body from a temp file) and returns the parsed tool result, or $null.
function Invoke-Tool($door, $name, $argsJson) {
  $f = [System.IO.Path]::GetTempFileName()
  try {
    [System.IO.File]::WriteAllText($f, ('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"' + $name + '","arguments":' + $argsJson + '}}'))
    return (Read-ToolResult (Get-Text ($BASE + $door) 30 $f))
  } finally {
    Remove-Item $f -ErrorAction SilentlyContinue
  }
}
function Wait-NewWorker($commit, $versionId, $tries, $delaySeconds) {
  $last = "never read"
  for ($n = 1; $n -le $tries; $n++) {
    $why = Test-CodeIdentityServed (Get-ServedCode) $commit $versionId
    if ($why -eq "") { $why = Test-CitizensServed (Read-JsonBody (Get-Text "$BASE/api/citizens" 30 $null)) }
    if ($why -eq "") {
      Say "[poll] try $n of ${tries}: GET /api/attest serves code.commit $($commit.Substring(0, 8)) and code.version_id $versionId; GET /api/citizens serves last_assertion_at"
      return
    }
    $last = $why
    Say "[poll] try $n of ${tries}: not yet: $why"
    if ($n -lt $tries) { Start-Sleep -Seconds $delaySeconds }
  }
  Stop-Here ("the new worker was never shown live in " + $tries + " reads (last: " + $last + "). The deploy is not shown to be live. " + $ROLLBACK_LINE)
}
# END-OF-DEFINITIONS (nothing above runs git, npm, wrangler or the network)

# 0a. the two pins, BEFORE any git, npm, wrangler or network command: a placeholder is never a commit, and a malformed pin must not reach `git merge-base`
# BEGIN-PIN-CHECK
if ($LIVE_BASE_COMMIT -ceq $LIVE_BASE_PLACEHOLDER) { Stop-Here "`$LIVE_BASE_COMMIT still holds the placeholder '$LIVE_BASE_PLACEHOLDER': the hub sets it to the commit the live worker serves." }
if ($LIVE_BASE_COMMIT -cnotmatch '^[0-9a-f]{40}$') { Stop-Here "`$LIVE_BASE_COMMIT '$LIVE_BASE_COMMIT' is not 40 lower-case hex. Nothing was read or written." }
if ($REVIEWED_COMMIT -ceq $REVIEWED_COMMIT_PLACEHOLDER) { Stop-Here "`$REVIEWED_COMMIT still holds the placeholder '$REVIEWED_COMMIT_PLACEHOLDER': the hub sets it to the commit the review converged on." }
if ($REVIEWED_COMMIT -cnotmatch '^[0-9a-f]{40}$') { Stop-Here "`$REVIEWED_COMMIT '$REVIEWED_COMMIT' is not 40 lower-case hex. Nothing was read or written." }
# END-PIN-CHECK
# BEGIN-REHEARSAL-CHECK
if (-not $DryRun -and -not $RehearsalPassed) { Stop-Here "a real run needs -RehearsalPassed: the Worker-binding authentication rehearsal against a scratch D1 (namespaced replay and raw-nonce collision, the existing 401 text, unchanged stamp and nonces) must have passed first, and this script cannot check that. Nothing was read or written." }
# END-REHEARSAL-CHECK

# 1. the commit: fetch, then main, origin/main and the expected sha must be ONE commit, on a clean tree
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
# Non-minting: src/doc.ts (which holds FRONT_DOOR_TEMPLATE) must not have moved since the live code.
$docMoves = @(git diff --name-status --no-renames $LIVE_BASE_COMMIT HEAD -- src/doc.ts)
if ($LASTEXITCODE -ne 0) { Stop-Here "git diff failed (exit $LASTEXITCODE): the no-mint check cannot be read." }
if ($docMoves.Count -gt 0) { Stop-Here ("src/doc.ts changed since " + $LIVE_BASE_COMMIT.Substring(0, 8) + " (" + ($docMoves -join " | ") + "): this wave mints nothing. Not this script's deploy.") }
# The ONLY migration since the live code is 0024, added (not edited).
$migMoves = @(git diff --name-status --no-renames $LIVE_BASE_COMMIT HEAD -- migrations)
if ($LASTEXITCODE -ne 0) { Stop-Here "git diff failed (exit $LASTEXITCODE): the migration check cannot be read." }
if ($migMoves.Count -ne 1 -or $migMoves[0] -cne ("A`t" + $MIGRATION_PATH_EXPECTED)) { Stop-Here ("expected exactly one added migration (" + $MIGRATION_PATH_EXPECTED + ") since " + $LIVE_BASE_COMMIT.Substring(0, 8) + ", found: " + ($migMoves -join " | ")) }
# BEGIN-REVIEWED-SOURCE-CHECK
git merge-base --is-ancestor $REVIEWED_COMMIT HEAD
if ($LASTEXITCODE -ne 0) { Stop-Here "HEAD does not contain the reviewed commit $($REVIEWED_COMMIT.Substring(0, 8)): this is not the code that was reviewed." }
$afterReview = @(git diff --name-only --no-renames $REVIEWED_COMMIT HEAD)
if ($LASTEXITCODE -ne 0) { Stop-Here "git diff failed (exit $LASTEXITCODE): the changes since the reviewed commit cannot be read." }
$unreviewed = @(Get-DisallowedPaths $afterReview)
if ($unreviewed.Count -gt 0) { Stop-Here ("these paths changed since the reviewed commit " + $REVIEWED_COMMIT.Substring(0, 8) + " and are not on the allowlist (" + ($ALLOWED_PATHS_AFTER_REVIEW -join ", ") + "), so what would ship is not what was reviewed: " + ($unreviewed -join ", ")) }
Say ("[git] reviewed source: HEAD differs from " + $REVIEWED_COMMIT.Substring(0, 8) + " in " + $afterReview.Count + " path(s), all on the allowlist")
# END-REVIEWED-SOURCE-CHECK
if (-not (Select-String -Path "src/society.ts" -Pattern "UPDATE citizens SET last_assertion_at = ? WHERE id = ?" -SimpleMatch -Quiet)) { Stop-Here "src/society.ts does not stamp last_assertion_at: this checkout is not the last-assertion-at wave." }
if (-not (Select-String -Path "src/society.ts" -Pattern "export const LAST_ASSERTION_NOTE" -SimpleMatch -Quiet)) { Stop-Here "src/society.ts has no LAST_ASSERTION_NOTE: this checkout would not serve the note." }
if (-not (Select-String -Path "src/privacy.ts" -Pattern "This lets readers observe recorded use of a seat's signing key" -SimpleMatch -Quiet)) { Stop-Here "src/privacy.ts does not carry the last_assertion_at paragraph: this checkout would not serve it." }
if (-not (Select-String -Path "src/governance.ts" -Pattern "export function assertProposalsQuery(" -SimpleMatch -Quiet)) { Stop-Here "src/governance.ts has no assertProposalsQuery: this checkout would drop the unknown-params wave." }
if (-not (Select-String -Path "src/code-identity.ts" -Pattern "export function codeBlock" -Quiet)) { Stop-Here "src/code-identity.ts has no codeBlock: this checkout would drop served code identity." }
if (-not (Test-Path $VERIFY_SQL_PATH)) { Stop-Here "$VERIFY_SQL_PATH is missing: the verification cannot run." }
$verifyWhy = Test-SingleLineSql (ConvertTo-SingleLineSql (Get-Content $VERIFY_SQL_PATH -Raw))
if ($verifyWhy -ne "") { Stop-Here "$VERIFY_SQL_PATH cannot be sent as one --command argument: $verifyWhy." }
if (-not (Select-String -Path "wrangler.jsonc" -Pattern '"version_metadata"' -Quiet)) { Stop-Here "wrangler.jsonc has no version_metadata binding: the Worker could not serve Cloudflare's version id." }
if (Select-String -Path "wrangler.jsonc" -Pattern '"CODE_COMMIT"' -Quiet) { Stop-Here "wrangler.jsonc configures a CODE_COMMIT var: a deploy that forgot the flag would serve a stale stamp. The stamp comes from this script's --var flag only." }
Say ("[git] HEAD " + $headSha.Substring(0, 8) + " = main = origin/main = -ExpectedCommit; tree clean; contains " + $LIVE_BASE_COMMIT.Substring(0, 8) + "; src/doc.ts unmoved; the one new migration is " + $MIGRATION_PATH_EXPECTED)

# 2. the wave's own gates, re-run here so a stale checkout cannot deploy
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

# 3. live, before: non-minting baseline, the live worker is the pinned base, and the census does not yet serve the field
$attBefore = Read-Attest "before the deploy"
Assert-Attest $attBefore "before the deploy"
Say ("[live] before: v6 " + $V6_HASH.Substring(0, 8) + "; all four chains ok; identity " + $attBefore.identity_log.sealed_entries + ", treasury " + $attBefore.treasury.sealed_entries + ", ballots " + $attBefore.ballots.sealed_entries)
if ($null -eq $attBefore.code -or [string]$attBefore.code.commit_status -cne "stamped") { Stop-Here "GET /api/attest serves no stamped code.commit before the deploy: the live worker cannot be shown to be the base this wave was checked against." }
if ([string]$attBefore.code.commit -ceq $headSha) { Stop-Here "GET /api/attest already serves code.commit $($headSha.Substring(0, 8)): this commit looks already deployed. Verify by hand." }
if ([string]$attBefore.code.commit -cne $LIVE_BASE_COMMIT) { Stop-Here ("the live worker serves code.commit " + $attBefore.code.commit + " but `$LIVE_BASE_COMMIT is " + $LIVE_BASE_COMMIT + ": the base this wave was checked against is not what is live. Correct the pin only after reading what changed.") }
$rollbackTarget = "the version before it (check npx wrangler deployments list)"
if ([string]$attBefore.code.version_status -ceq "available" -and $attBefore.code.version_id) { $rollbackTarget = [string]$attBefore.code.version_id }
Say "[live] before: the live worker serves the pinned base $($LIVE_BASE_COMMIT.Substring(0, 8)); rollback target $rollbackTarget"
$listBefore = Read-JsonBody (Get-Text "$BASE/api/citizens" 30 $null)
if ($null -eq $listBefore) { Stop-Here "GET /api/citizens did not return JSON before the deploy: read it by hand." }
if (([string]$listBefore.note).Contains($NOTE_MARKER)) { Stop-Here "GET /api/citizens already carries the last_assertion_at note: this looks already deployed, verify by hand." }

# 4. THE FIRST PRODUCTION READ. The clock starts BEFORE it is invoked, so the read's own run time (up to $WRANGLER_D1_SECONDS) is inside the window. A READ, so -DryRun runs it too.
$script:PreflightAt = Get-Date
$columnRes = Invoke-D1Read $COLUMN_SQL "the column state read"
if ($null -eq $columnRes) { Stop-Here "the column state read returned no parsable result." }
Say ("[window] production D1 first read at " + $script:PreflightAt.ToString("o") + "; migration, worker activation and the post-activation verification must finish within " + $WINDOW_SECONDS + " s of this")
$columnPresent = (@($columnRes.Rows).Count -gt 0)
if ($columnPresent -and -not $MigrationAlreadyApplied) { Stop-Here "citizens.last_assertion_at is already on prod. If an earlier run applied it, re-run with -MigrationAlreadyApplied (the catalogue and verification still run)." }
if (-not $columnPresent -and $MigrationAlreadyApplied) { Stop-Here "-MigrationAlreadyApplied was given but citizens.last_assertion_at is not on prod." }
Say ("[d1] citizens.last_assertion_at on prod before: " + $columnPresent)

if ($DryRun) {
  Say "[dry-run] would now: apply $MIGRATION_PATH_EXPECTED to the REMOTE D1 (skipped if -MigrationAlreadyApplied); verify the column and $VERIFY_SQL_PATH (zero rows) on prod; run npx wrangler deploy --var CODE_COMMIT:<the full sha> (bounded) and capture its Current Version ID; poll up to $POLL_TRIES times, $POLL_DELAY_SECONDS s apart; re-run the verification; then ride HTTP and both MCP doors. Nothing was written to the remote and nothing was deployed. The script signs nothing."
  exit 0
}

# 5. migration 0024 to the REMOTE D1 FIRST (a nullable column, nothing else; applied only when the catalogue read above found the column absent)
# BEGIN-MIGRATION
Assert-Window "applying the migration" $WRANGLER_D1_SECONDS
if (-not $MigrationAlreadyApplied) {
  Say "[d1] applying $MIGRATION_PATH_EXPECTED to the remote database"
  $mig = Invoke-Bounded ("npx wrangler d1 execute " + $PROD_DB + " --remote --file " + $MIGRATION_PATH_EXPECTED) $WRANGLER_D1_SECONDS
  if ($mig.TimedOut) { Stop-Here "migration 0024 timed out after $WRANGLER_D1_SECONDS s; the state is unknown. Read the catalogue by hand; do NOT re-run the file blind (a duplicate ADD COLUMN fails)." }
  if ($mig.Code -ne 0) { Stop-Here "migration 0024 failed (exit $($mig.Code)); nothing deployed; re-read the catalogue before any retry (do NOT re-run the file blind: a duplicate ADD COLUMN fails)." }
}

# 6. catalogue and verification on prod (db-migration-verification): the worker deploys only if the column is there and the verification returns zero rows
Assert-Window "the catalogue verification (two reads)" (2 * $WRANGLER_D1_SECONDS)
Assert-Prod-Verified "after the migration"
Say "[d1] verified on prod: column present (INTEGER), the verification returns zero rows"
# END-MIGRATION

# 7. deploy the worker with the commit stamp, capturing its version id, then poll until the served identity is this deploy's
# BEGIN-DEPLOY-AND-POLL
Assert-Window "the worker deploy and its poll" ($WRANGLER_DEPLOY_SECONDS + ($POLL_TRIES * ($POLL_DELAY_SECONDS + $POLL_READ_SECONDS)))
$headNow = (git rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $headNow -cne $headSha) { Stop-Here ("HEAD moved since step 1 (" + $headSha.Substring(0, 8) + " -> " + $headNow + "): the migration is applied, the worker was not deployed. Re-run with -MigrationAlreadyApplied once HEAD is right.") }
$dirtyNow = @(git status --porcelain)
if ($LASTEXITCODE -ne 0) { Stop-Here "git status failed (exit $LASTEXITCODE) just before the deploy: the worker was not deployed." }
if ($dirtyNow.Count -gt 0) { Stop-Here ("the working tree changed since step 1 (" + $dirtyNow.Count + " paths: " + ($dirtyNow -join " | ") + "): the worker was not deployed.") }
Say "[deploy] npx wrangler deploy --var CODE_COMMIT:$($headSha.Substring(0, 8))... (commit $($headSha.Substring(0, 8)))"
$dep = Invoke-Bounded ("npx wrangler deploy --var CODE_COMMIT:" + $headSha) $WRANGLER_DEPLOY_SECONDS
if ($dep.TimedOut) { Stop-Here "wrangler deploy timed out after $WRANGLER_DEPLOY_SECONDS s; whether it took effect is unknown. Check 'npx wrangler deployments list' by hand. Migration 0024 is applied and harmless to the old worker." }
if ($dep.Code -ne 0) { Stop-Here "wrangler deploy failed (exit $($dep.Code)); migration 0024 is applied and harmless to the old worker. Re-run with -MigrationAlreadyApplied. Output: $($dep.Out)" }
$versionMatches = @([regex]::Matches($dep.Out, '(?m)^[ \t]*Current Version ID:[ \t]*([0-9a-fA-F-]{36})[ \t]*\r?$'))
if ($versionMatches.Count -gt 1) { Stop-Here ("wrangler deploy printed 'Current Version ID' on " + $versionMatches.Count + " lines; which one is this deploy's cannot be told. Check 'npx wrangler deployments list' by hand before anything else.") }
if ($versionMatches.Count -lt 1) { Stop-Here "wrangler deploy exited 0 but printed no 'Current Version ID'; the deploy may have succeeded. Check 'npx wrangler deployments list' by hand before anything else." }
$versionId = $versionMatches[0].Groups[1].Value
Say "[deploy] worker version id $versionId (commit $($headSha.Substring(0, 8)))"
$ROLLBACK_LINE = "ROLL BACK THE WORKER (npx wrangler rollback, to the version before $versionId, which should be $rollbackTarget; check npx wrangler deployments list first). Migration 0024 stays applied (an extra nullable column the old worker never reads); the old worker records no stamps, so existing stamps go stale, and nothing needs repairing."
Wait-NewWorker $headSha $versionId $POLL_TRIES $POLL_DELAY_SECONDS
# END-DEPLOY-AND-POLL

# 8. the verification again AFTER activation (the new worker may already have stamped a key seat; the query must still return zero rows)
# BEGIN-RECONCILE
Assert-Window "the post-activation verification (two reads)" (2 * $WRANGLER_D1_SECONDS)
Assert-Prod-Verified "after worker activation"
Assert-Window "completion of the post-activation verification" 0
Say "[d1] post-activation: the verification returns zero rows"
# END-RECONCILE

# 9. the ride: non-minting and the chains, then HTTP and both MCP doors.
$attAfter = Read-Attest "after the deploy"
Assert-Attest $attAfter "after the deploy"
$why = Test-CodeIdentityServed $attAfter.code $headSha $versionId
if ($why -ne "") { Stop-Here "after the poll, ${why}: another deploy may have taken over. Check npx wrangler deployments list by hand." }
$why = Test-ChainsUnchanged $attBefore $attAfter
if ($why -ne "") { Stop-Here "$why. Something wrote during the deploy: read what, by hand." }
Say ("[ride] attest: v6 " + $V6_HASH.Substring(0, 8) + " unchanged; the four chains (identity_log, treasury, payouts, ballots) ok, with sealed_entries and head identical to before; code.commit " + ([string]$attAfter.code.commit).Substring(0, 8) + ", code.version_id " + $attAfter.code.version_id)
$why = Test-CitizensServed (Read-JsonBody (Get-Text "$BASE/api/citizens" 30 $null))
if ($why -ne "") { Stop-Here "GET /api/citizens: $why. $ROLLBACK_LINE" }
Say "[ride] GET /api/citizens -> the note and a last_assertion_at key on every row"
foreach ($door in "/mcp", "/mcp/read") {
  $toolList = Invoke-Tool $door "citizens" "{}"
  $why = Test-CitizensServed $toolList
  if ($why -ne "") { Stop-Here "$door citizens tool: $why. $ROLLBACK_LINE" }
  Say "[ride] $door citizens tool -> the stamp key served"
}
$privacy = Get-Text "$BASE/privacy" 30 $null
if ($privacy.Code -ne "200") { Stop-Here "GET /privacy -> $($privacy.Code). $ROLLBACK_LINE" }
$why = Test-PrivacyServed $privacy.Body
if ($why -ne "") { Stop-Here "$why. $ROLLBACK_LINE" }
Say "[ride] GET /privacy -> the last_assertion_at paragraph"
$bad = @()
foreach ($p in "/", "/api/official", "/openapi.json", "/treasury", "/api/listings", "/api/stats", "/api/topics", "/api/guest/due", "/api/proposals", "/api/doors", "/api/council", "/api/residents", "/heartbeat.md", "/skill.md", "/llms.txt", "/privacy") {
  $r = Get-Text "$BASE$p" 30 $null
  if ($r.Code -ne "200") { $bad += "$p=$($r.Code)" }
}
if ($bad.Count -gt 0) { Stop-Here ("non-200 after the deploy (version $versionId): " + ($bad -join ", ") + ". If a read that answered before now fails: $ROLLBACK_LINE") }
Say "[ride] 16 public reads -> 200"
Say "[done] last-assertion-at wave deployed and verified. Public serving verified; production authentication write path NOT exercised: it is not ridden until one signed assertion from keyholder moves its last_assertion_at (the optional step in this script's header). Log version id $versionId, commit $($headSha.Substring(0, 8)) and these lines in HANDOVER.md."
