# Deploys the 14 OCT PENNY-THREE WAVE (branch penny-three-2026-10-14; brief drafts/BRIEF-PENNY-THREE-2026-10-14.md with amendments A1-A5): GET /api/official's composition gains ever_written and
# not_designated_ever_written beside acted_30d; every row of GET /api/citizens gains payer_trace { direct_payer, direct_payer_is_operator_wallet, beyond_direct_payer }; GET /api/guest/due gains
# received_elsewhere and received_elsewhere_count (a hand-kept list, outside the duty counts). Read-only fields on GET answers: no money route, no auth change, no register-path behaviour change,
# no model call, no write path. ONE worker deploy. Ben's hand only (D-017). One fail-fast script (L-046, L-069).
# NO MIGRATION, NO D1 COMMAND, NO MINT. Step 0 STOPS if migrations/ or schema.sql differ between the live base and HEAD, so a wave that quietly grew one cannot ride this script.
# Wrangler is used for exactly ONE thing here: the stamped deploy.
# WRITTEN BY THE BUILDER AND NEVER RUN: not even -DryRun (which reads the live worker over HTTP).
# TWO PINS. $LIVE_BASE_COMMIT is the commit the live worker serves when this runs (the seat counts wave, worker e1213b31) and is set; step 2 PROVES it against the live GET /api/attest code.commit at run time.
# $REVIEWED_COMMIT is the commit the review converged on and holds the hub's placeholder until the hub sets it. Step 0a STOPS, before any git or network command, while it still holds its placeholder or is
# not 40 lower-case hex.
# NO MINT: src/doc.ts is not edited by this wave. The check is the template text itself: step 0 extracts FRONT_DOOR_TEMPLATE from src/doc.ts at $LIVE_BASE_COMMIT and at HEAD and STOPS if they differ by a byte.
# After the deploy it STOPS if the constitution is not still v5 with its template hash.
# THE DEPLOY STAMPS THE COMMIT: `npx wrangler deploy --var CODE_COMMIT:<sha>` (served code identity). The poll after the deploy waits until GET /api/attest serves code.commit equal to the pinned sha
# AND code.version_id equal to the Current Version ID wrangler printed AND the three changed answers serve their new fields (the pre-deploy probes prove they are absent first).
# The ROLLBACK TARGET is the version id GET /api/attest served BEFORE the deploy (read live, never typed in).
# REVIEWED SOURCE ONLY: step 0 also STOPS unless HEAD is $REVIEWED_COMMIT plus changes confined to $ALLOWED_PATHS_AFTER_REVIEW (this script, its test, docs/).
# Run from society/ on main, after the merge and the push:
#   cd "C:\Users\bengr\Projects\AI domain and social network\society"
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-penny-three.ps1 -ExpectedCommit <sha> -DryRun   # every check and the live reads, nothing deployed
#   powershell -ExecutionPolicy Bypass -File scripts\deploy-penny-three.ps1 -ExpectedCommit <sha>           # the real thing
# <sha> is the pushed tip of main (git -C society rev-parse HEAD), the full 40 hex.
# THE RIDE IS PUBLIC GETs ONLY. NO POST OF ANY KIND, no token, key or assertion, and it WRITES NOTHING. It reads: GET /api/official (acted_30d, ever_written and not_designated_ever_written whole numbers, consistent
# with each other and with the rest of the composition, each with its provenance entry; the composition figures unchanged from before the deploy), GET /api/citizens (payer_trace on every row, every
# beyond_direct_payer not_checkable_by_us, and the rows with direct_payer_is_operator_wallet true equal composition.operator_paid), GET /api/guest/due (received_elsewhere with a count equal to its length and at
# least three, the duty counts adding up), GET /llms.txt, the notes, the attest chains and the v5 constitution.
# PowerShell 5.1 traps this file avoids (all seen live): $COLS and $cols are the SAME variable (one spelling per name here); -notmatch on an array filters instead of testing;
# a one-element return is wrapped in @(); "$var:" is a drive reference (write "${var}:"); an Invoke-WebRequest 4xx body is in $_.ErrorDetails.Message; never merge a native command's stderr
# under ErrorActionPreference Stop; -eq and -ne are case-INSENSITIVE (hashes, shas and states are compared with -ceq / -cne). ASCII only: 5.1 reads a BOM-less UTF-8 script as the ANSI code page.
param(
  [Parameter(Mandatory = $true)][string]$ExpectedCommit,
  [switch]$DryRun
)
$ErrorActionPreference = "Stop"
$BASE = "https://commonhold.randommonicle.workers.dev"
# The attested constitution this wave must leave untouched.
$V5_HASH = "fa11788d062b0c6d23c54c428c1c9649d263ae3ba704e602e122066926049491"
# The commit the live worker serves when this runs (the seat counts wave). Step 0 STOPS while it holds the placeholder, and while it is not 40 lower-case hex.
$LIVE_BASE_COMMIT = "8f866a64c14cd19451a7b9e58e6fcd1ff5075eb2"
$LIVE_BASE_PLACEHOLDER = "TO-BE-SET-BY-HUB-LIVE-BASE"
# THE REVIEWED SOURCE. The hub replaces this placeholder with the full sha the review converged on; step 0 STOPS while it is unchanged, and while it is not 40 lower-case hex.
$REVIEWED_COMMIT = "TO-BE-SET-BY-HUB"
$REVIEWED_COMMIT_PLACEHOLDER = "TO-BE-SET-BY-HUB"
$ALLOWED_PATHS_AFTER_REVIEW = @("scripts/deploy-penny-three.ps1", "test/deploy-penny-three-script.test.ts", "docs/")
# The wallet the operator states is its own (the operator's statement, lower-case). The ride recomputes direct_payer_is_operator_wallet from each served direct_payer against it.
$OPERATOR_WALLET = "0x3f2950654ef9bf2d73805a77a07e4e14d5f74f16"
$OFFICIAL_URL = "$BASE/api/official"
$CITIZENS_URL = "$BASE/api/citizens"
$DUE_URL = "$BASE/api/guest/due"
$POLL_TRIES = 12
$POLL_DELAY_SECONDS = 5
# node's test summary is the LAST thing npm test prints on a run that finishes cleanly: eight consecutive lines, "tests N", "suites N", "pass N", "fail N", "cancelled N", "skipped N", "todo N" and
# "duration_ms N.N", each after at most one prefix token, with nothing after the last but whitespace. The pattern is ANCHORED AT THE END (\z), so test TITLES are never it. The script also requires
# tests == pass + fail + cancelled + skipped + todo.
$TEST_SUMMARY_PATTERN = '(?m)^(?:\S+[ \t]+)?tests (\d+)[ \t]*\r?\n(?:\S+[ \t]+)?suites (\d+)[ \t]*\r?\n(?:\S+[ \t]+)?pass (\d+)[ \t]*\r?\n(?:\S+[ \t]+)?fail (\d+)[ \t]*\r?\n(?:\S+[ \t]+)?cancelled (\d+)[ \t]*\r?\n(?:\S+[ \t]+)?skipped (\d+)[ \t]*\r?\n(?:\S+[ \t]+)?todo (\d+)[ \t]*\r?\n(?:\S+[ \t]+)?duration_ms (\d+(?:\.\d+)?)\s*\z'

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
# The FRONT_DOOR_TEMPLATE literal of a src/doc.ts text: from its `export const FRONT_DOOR_TEMPLATE = ` line to the first backtick that is not escaped by a backslash. $null when the marker or the
# closing backtick is not found (the caller STOPS: an unreadable template is never "unchanged").
function Get-TemplateText($docText) {
  $marker = 'export const FRONT_DOOR_TEMPLATE = `'
  $start = ([string]$docText).IndexOf($marker, [System.StringComparison]::Ordinal)
  if ($start -lt 0) { return $null }
  $i = $start + $marker.Length
  while ($true) {
    $j = ([string]$docText).IndexOf('`', $i, [System.StringComparison]::Ordinal)
    if ($j -lt 0) { return $null }
    if ($j -gt 0 -and ([string]$docText)[$j - 1] -eq [char]92) { $i = $j + 1; continue }
    return ([string]$docText).Substring($start, $j - $start + 1)
  }
}
# The counts in the eight-line summary block at the END of $testOut, or $null when the output does not end with one.
function Get-TestSummary($testOut) {
  $found = [regex]::Matches([string]$testOut, $TEST_SUMMARY_PATTERN)
  if ($found.Count -lt 1) { return $null }
  $last = $found[$found.Count - 1]
  $counts = @(1..7 | ForEach-Object { [int64]$last.Groups[$_].Value })
  return @{ Tests = $counts[0]; Pass = $last.Groups[3].Value; Fail = $last.Groups[4].Value; Cancelled = $counts[4]; Skipped = $counts[5]; Todo = $counts[6]; SumOk = ($counts[0] -eq ($counts[2] + $counts[3] + $counts[4] + $counts[5] + $counts[6])) }
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
# The `code` block GET /api/attest serves now, or $null when the read fails, is not JSON, or carries no code block. Never stops: the poll decides.
function Get-ServedCode {
  $r = Get-Text "$BASE/api/attest" 30
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
# Runs of whitespace collapsed to one space (llms.txt and the notes may wrap a long sentence across lines).
function Get-FlatText($text) {
  return [regex]::Replace([string]$text, '\s+', ' ')
}
# $true when $text contains $needle after both have their whitespace flattened (ordinal, case-sensitive). $false on an empty needle: nothing is "contained" by default.
function Test-ContainsFlat($text, $needle) {
  if ([string]::IsNullOrEmpty([string]$needle)) { return $false }
  return (Get-FlatText $text).Contains((Get-FlatText $needle))
}
# $true when $v is a whole number (JSON null, a string and a missing field are not).
function Test-IsCount($v) {
  if ($null -eq $v) { return $false }
  return (($v -is [int]) -or ($v -is [long]))
}
# $true when the JSON text of GET /api/official carries NEITHER ever-written count in its composition: the pre-deploy probe, which makes the poll mean something. $false when it is unreadable or either is there.
function Test-EverWrittenAbsent($body) {
  try { $o = ([string]$body | ConvertFrom-Json) } catch { return $false }
  if ($null -eq $o -or $null -eq $o.composition) { return $false }
  foreach ($f in "ever_written", "not_designated_ever_written") {
    if ($null -ne $o.composition.PSObject.Properties[$f]) { return $false }
  }
  return $true
}
# $true when the JSON text of GET /api/citizens has at least one row and NO row carries payer_trace.
function Test-PayerTraceAbsent($body) {
  try { $o = ([string]$body | ConvertFrom-Json) } catch { return $false }
  if ($null -eq $o) { return $false }
  $rows = @($o.citizens)
  if ($rows.Count -lt 1) { return $false }
  foreach ($r in $rows) {
    if ($null -ne $r.PSObject.Properties["payer_trace"]) { return $false }
  }
  return $true
}
# $true when the JSON text of GET /api/guest/due is a JSON object WITHOUT received_elsewhere.
function Test-ReceivedElsewhereAbsent($body) {
  try { $o = ([string]$body | ConvertFrom-Json) } catch { return $false }
  if ($null -eq $o) { return $false }
  return ($null -eq $o.PSObject.Properties["received_elsewhere"])
}
# "" when the JSON text of GET /api/official serves acted_30d, ever_written and not_designated_ever_written as this wave defines them, otherwise the first reason it does not: each is a whole number (null means the
# count was unreadable for that response: the three share one writer read, so the ride's retry keys on that reason), ever_written lies between acted_30d and citizens, the not-designated count is bounded by
# ever_written and by the complement of the operator's list, the difference is no more than the operator's own seats, the Rule 7 outside count is no more than the not-designated count, and each new count has its
# provenance entry with the source tag record and the sentence the wave gave it.
# $true when a Test-EverWrittenServed reason says a writer count was NULL (its writer read failed for that response): the ONLY reason the ride reads again.
# Keyed on the exact text Test-EverWrittenServed returns for a null value; test/deploy-penny-three-script.test.ts runs both functions together on a real null body.
function Test-IsNullReason($why) {
  return ([string]$why -match "^composition\.(acted_30d|ever_written|not_designated_ever_written) is '', expected a whole number \(null means the count was unreadable")
}
function Test-EverWrittenServed($body) {
  try { $o = ([string]$body | ConvertFrom-Json) } catch { return "GET /api/official did not return JSON" }
  if ($null -eq $o -or $null -eq $o.composition) { return "GET /api/official carries no composition block" }
  $c = $o.composition
  foreach ($f in "acted_30d", "ever_written", "not_designated_ever_written") {
    $v = $c.PSObject.Properties[$f]
    if ($null -eq $v) { return ("composition." + $f + " is absent") }
    if (-not (Test-IsCount $v.Value)) { return ("composition." + $f + " is '" + $v.Value + "', expected a whole number (null means the count was unreadable for that response)") }
  }
  if ($c.ever_written -gt $c.citizens) { return ("ever_written " + $c.ever_written + " is more than citizens " + $c.citizens) }
  if ($c.ever_written -lt $c.acted_30d) { return ("ever_written " + $c.ever_written + " is less than acted_30d " + $c.acted_30d + ": it is the same count with no time limit") }
  if ($c.not_designated_ever_written -gt $c.ever_written) { return ("not_designated_ever_written " + $c.not_designated_ever_written + " is more than ever_written " + $c.ever_written) }
  if ($c.not_designated_ever_written -gt $c.not_designated_operator_controlled) { return ("not_designated_ever_written " + $c.not_designated_ever_written + " is more than not_designated_operator_controlled " + $c.not_designated_operator_controlled) }
  if (($c.ever_written - $c.not_designated_ever_written) -gt $c.operator_controlled) { return ("ever_written " + $c.ever_written + " minus not_designated_ever_written " + $c.not_designated_ever_written + " is more than operator_controlled " + $c.operator_controlled) }
  $outside = $o.rule7_revote.outside_writers_30d
  if ((Test-IsCount $outside) -and $outside -gt $c.not_designated_ever_written) { return ("rule7_revote.outside_writers_30d " + $outside + " is more than not_designated_ever_written " + $c.not_designated_ever_written + ": it is the same count over 30 days") }
  foreach ($f in "ever_written", "not_designated_ever_written") {
    $p = $c.provenance.PSObject.Properties[$f]
    if ($null -eq $p) { return ("composition.provenance." + $f + " is missing") }
    if ([string]::IsNullOrEmpty([string]$p.Value.check)) { return ("composition.provenance." + $f + " has no check") }
    if ((@($p.Value.source) -join ",") -cne "record") { return ("composition.provenance." + $f + ".source is '" + (@($p.Value.source) -join ",") + "', expected record") }
  }
  if (-not ([string]$c.provenance.ever_written.check).Contains("A row a moderator has hidden does not count")) { return "composition.provenance.ever_written.check does not say a hidden row does not count" }
  if (-not ([string]$c.provenance.not_designated_ever_written.check).Contains("does not establish who controls those seats")) { return "composition.provenance.not_designated_ever_written.check does not say it does not establish who controls those seats" }
  return ""
}
# "" when the JSON text of GET /api/citizens serves payer_trace as this wave defines it, otherwise the first reason it does not. It reads ONE page, so it STOPS on a paged census rather than checking some rows.
# Every row carries the three fields; beyond_direct_payer is not_checkable_by_us on every row; a traced row has a 20-byte wallet and a boolean flag that this function recomputes against $OPERATOR_WALLET; an
# untraced row has a null flag; and the rows with the flag true equal $operatorPaid (composition.operator_paid), so the served record cannot be inconsistent with itself.
function Test-PayerTraceServed($body, $operatorPaid) {
  try { $o = ([string]$body | ConvertFrom-Json) } catch { return "GET /api/citizens did not return JSON" }
  if ($null -eq $o) { return "GET /api/citizens did not return a JSON object" }
  if ($o.has_more -eq $true) { return "GET /api/citizens has more than one page: this check reads one page and cannot check every row" }
  $rows = @($o.citizens)
  if ($rows.Count -lt 1) { return "GET /api/citizens carries no rows" }
  if ($rows.Count -ne [int]$o.total) { return ("GET /api/citizens carries " + $rows.Count + " rows but total is " + $o.total) }
  $flagged = 0
  foreach ($r in $rows) {
    $t = $r.payer_trace
    if ($null -eq $t) { return ("row " + $r.handle + " carries no payer_trace") }
    foreach ($f in "direct_payer", "direct_payer_is_operator_wallet", "beyond_direct_payer") {
      if ($null -eq $t.PSObject.Properties[$f]) { return ("row " + $r.handle + " payer_trace." + $f + " is absent") }
    }
    if ([string]$t.beyond_direct_payer -cne "not_checkable_by_us") { return ("row " + $r.handle + " payer_trace.beyond_direct_payer is '" + $t.beyond_direct_payer + "', expected not_checkable_by_us") }
    if ($null -eq $t.direct_payer) {
      if ($null -ne $t.direct_payer_is_operator_wallet) { return ("row " + $r.handle + " has no direct_payer but direct_payer_is_operator_wallet is '" + $t.direct_payer_is_operator_wallet + "', expected null") }
    } else {
      if (([string]$t.direct_payer) -cnotmatch '^0x[0-9a-fA-F]{40}$') { return ("row " + $r.handle + " direct_payer '" + $t.direct_payer + "' is not a 20-byte address") }
      if ($t.direct_payer_is_operator_wallet -isnot [bool]) { return ("row " + $r.handle + " has a direct_payer but direct_payer_is_operator_wallet is '" + $t.direct_payer_is_operator_wallet + "', expected true or false") }
      $isOperator = (([string]$t.direct_payer).ToLowerInvariant() -ceq $OPERATOR_WALLET)
      if ($t.direct_payer_is_operator_wallet -ne $isOperator) { return ("row " + $r.handle + " direct_payer_is_operator_wallet is " + $t.direct_payer_is_operator_wallet + " but direct_payer " + $t.direct_payer + " compared with the operator's stated wallet gives " + $isOperator) }
      if ($t.direct_payer_is_operator_wallet -eq $true) { $flagged++ }
    }
  }
  if ($flagged -ne [int]$operatorPaid) { return ("the " + $flagged + " rows with direct_payer_is_operator_wallet true are not composition.operator_paid " + $operatorPaid + ": the served record disagrees with itself") }
  return ""
}
# "" when the JSON text of GET /api/guest/due serves received_elsewhere as this wave defines it, otherwise the first reason it does not: the list is there, received_elsewhere_count is a whole number equal to
# its length and at least 3, every entry names its account, platform, url, comment id, time and at least one answering comment, and the duty counts still add up (accrued is the sum of the other five).
function Test-ReceivedElsewhereServed($body) {
  try { $o = ([string]$body | ConvertFrom-Json) } catch { return "GET /api/guest/due did not return JSON" }
  if ($null -eq $o) { return "GET /api/guest/due did not return a JSON object" }
  if ($null -eq $o.PSObject.Properties["received_elsewhere"]) { return "received_elsewhere is absent" }
  $list = @($o.received_elsewhere)
  if (-not (Test-IsCount $o.received_elsewhere_count)) { return ("received_elsewhere_count is '" + $o.received_elsewhere_count + "', expected a whole number") }
  if ($o.received_elsewhere_count -ne $list.Count) { return ("received_elsewhere_count " + $o.received_elsewhere_count + " is not the list length " + $list.Count) }
  if ($list.Count -lt 3) { return ("received_elsewhere has " + $list.Count + " entries, expected at least 3") }
  foreach ($e in $list) {
    foreach ($f in "by", "platform", "url", "comment_id", "posted_utc") {
      if ([string]::IsNullOrEmpty([string]$e.$f)) { return ("a received_elsewhere entry has no " + $f) }
    }
    $answers = @($e.answered_by)
    if ($answers.Count -lt 1) { return ("received_elsewhere entry " + $e.by + " names no answering comment") }
    foreach ($a in $answers) {
      if ([string]::IsNullOrEmpty([string]$a.identity) -or [string]::IsNullOrEmpty([string]$a.comment_id)) { return ("received_elsewhere entry " + $e.by + " has an answering comment without an identity or an id") }
    }
  }
  $k = $o.counts
  foreach ($f in "accrued", "open", "overdue", "answered_in_time", "answered_late", "waived") {
    if (-not (Test-IsCount $k.$f)) { return ("counts." + $f + " is '" + $k.$f + "', expected a whole number") }
  }
  if ($k.accrued -ne ($k.open + $k.overdue + $k.answered_in_time + $k.answered_late + $k.waived)) { return ("counts.accrued " + $k.accrued + " is not the sum of the other five") }
  return ""
}
# The composition figures this wave must not move, as one comparable string: citizens, operator_controlled, operator_funded, the funded handles (sorted, ordinal), not_designated, key_lost, act_capable and operator_paid. $null when unreadable.
function Get-CompositionSnapshot($body) {
  try { $o = ([string]$body | ConvertFrom-Json) } catch { return $null }
  if ($null -eq $o -or $null -eq $o.composition) { return $null }
  $c = $o.composition
  $handles = @(@($c.operator_funded_handles) | ForEach-Object { [string]$_ })
  [array]::Sort($handles, [System.StringComparer]::Ordinal)
  return ("citizens=" + $c.citizens + ";act_capable=" + $c.act_capable + ";operator_paid=" + $c.operator_paid + ";operator_controlled=" + $c.operator_controlled + ";operator_funded=" + $c.operator_funded + ";not_designated=" + $c.not_designated_operator_controlled + ";key_lost=" + $c.key_lost + ";funded_handles=" + ($handles -join ","))
}
# $true when the JSON text of GET /api/official has a composition note that names both ever-written fields (the sentence, or the plain statement that they were unreadable, names them).
function Test-OfficialNoteNamesEverWritten($body) {
  try { $o = ([string]$body | ConvertFrom-Json) } catch { return $false }
  if ($null -eq $o -or $null -eq $o.composition) { return $false }
  return ((Test-ContainsFlat ([string]$o.composition.note) "ever_written") -and (Test-ContainsFlat ([string]$o.composition.note) "not_designated_ever_written"))
}
# $true when the JSON text of GET /api/citizens names payer_trace, its operator-wallet flag and the reach token in its note.
function Test-CitizensNoteNamesPayerTrace($body) {
  try { $o = ([string]$body | ConvertFrom-Json) } catch { return $false }
  if ($null -eq $o) { return $false }
  $note = [string]$o.note
  return ($note.Contains("payer_trace") -and $note.Contains("direct_payer_is_operator_wallet") -and $note.Contains("not_checkable_by_us"))
}
# $true when the JSON text of GET /api/guest/due has a note that separates received_elsewhere from the duty.
function Test-DueNoteSeparatesList($body) {
  try { $o = ([string]$body | ConvertFrom-Json) } catch { return $false }
  if ($null -eq $o) { return $false }
  return (Test-ContainsFlat ([string]$o.note) "received_elsewhere is a separate, hand-kept list and counts nothing here")
}
# "" when all three changed answers serve their new fields (the poll's test and the ride's), otherwise the first reason one does not. Reads GET /api/official, /api/citizens and /api/guest/due once each.
function Get-NewSurfacesReason {
  $official = Get-Text $OFFICIAL_URL 30
  if ($official.Code -ne "200") { return ("GET /api/official answered " + $official.Code) }
  $why = Test-EverWrittenServed $official.Body
  if ($why -ne "") { return $why }
  $paid = ($official.Body | ConvertFrom-Json).composition.operator_paid
  $citizens = Get-Text $CITIZENS_URL 30
  if ($citizens.Code -ne "200") { return ("GET /api/citizens answered " + $citizens.Code) }
  $why = Test-PayerTraceServed $citizens.Body $paid
  if ($why -ne "") { return $why }
  $due = Get-Text $DUE_URL 30
  if ($due.Code -ne "200") { return ("GET /api/guest/due answered " + $due.Code) }
  return (Test-ReceivedElsewhereServed $due.Body)
}
# Polls until the served block is this deploy's AND the three changed answers serve their new fields, or STOPS (with $ROLLBACK_LINE) after $tries reads.
function Wait-NewWorker($commit, $versionId, $tries, $delaySeconds) {
  $last = "never read"
  for ($n = 1; $n -le $tries; $n++) {
    $why = Test-CodeIdentityServed (Get-ServedCode) $commit $versionId
    if ($why -eq "") {
      $why = Get-NewSurfacesReason
      if ($why -eq "") {
        Say "[poll] try $n of ${tries}: GET /api/attest serves code.commit $($commit.Substring(0, 8)) and code.version_id $versionId; the three changed answers serve their new fields"
        return
      }
    }
    $last = $why
    Say "[poll] try $n of ${tries}: not yet: $why"
    if ($n -lt $tries) { Start-Sleep -Seconds $delaySeconds }
  }
  Stop-Here ("the new worker was never shown live in " + $tries + " reads (last: " + $last + "). The deploy is not shown to be live. " + $ROLLBACK_LINE)
}
# END-OF-DEFINITIONS (test/deploy-penny-three-script.test.ts reads everything above this line as definitions; nothing above runs git, npm, wrangler or the network)

# 0a. the two pins, BEFORE any git, npm, wrangler or network command: a placeholder is never a commit, and a malformed pin must not reach `git merge-base`
# BEGIN-PIN-CHECK
if ($LIVE_BASE_COMMIT -ceq $LIVE_BASE_PLACEHOLDER) { Stop-Here "`$LIVE_BASE_COMMIT still holds the placeholder '$LIVE_BASE_PLACEHOLDER': the hub sets it to the commit the live worker serves, and until then there is no base to check this wave against. Nothing was read or written." }
if ($LIVE_BASE_COMMIT -cnotmatch '^[0-9a-f]{40}$') { Stop-Here "`$LIVE_BASE_COMMIT '$LIVE_BASE_COMMIT' is not 40 lower-case hex. Nothing was read or written." }
if ($REVIEWED_COMMIT -ceq $REVIEWED_COMMIT_PLACEHOLDER) { Stop-Here "`$REVIEWED_COMMIT still holds the placeholder '$REVIEWED_COMMIT_PLACEHOLDER': the hub sets it to the commit the review converged on, and until then there is no reviewed source to deploy. Nothing was read or written." }
if ($REVIEWED_COMMIT -cnotmatch '^[0-9a-f]{40}$') { Stop-Here "`$REVIEWED_COMMIT '$REVIEWED_COMMIT' is not 40 lower-case hex. Nothing was read or written." }
# END-PIN-CHECK

# 0. the commit: fetch, then main, origin/main and the expected sha must be ONE commit, on a clean tree
# A fetch changes only remote-tracking refs, never the remote, so -DryRun performs it too: the level check must read a fresh origin/main.
Say "[git] git fetch origin"
git fetch origin --quiet
if ($LASTEXITCODE -ne 0) { Stop-Here "git fetch failed; the level check below would read a stale origin/main." }
$branch = (git rev-parse --abbrev-ref HEAD).Trim()
if ($branch -cne "main") { Stop-Here "the current branch is '$branch', not main: deploy from main only." }
$headSha = (git rev-parse HEAD).Trim()
$originSha = (git rev-parse origin/main).Trim()
$mainSha = (git rev-parse main).Trim()
# No stderr redirection on a native command under ErrorActionPreference Stop: Continue around it, read the exit code.
$ErrorActionPreference = "Continue"
$expectedSha = (git rev-parse --verify ($ExpectedCommit + "^{commit}"))
$expectedCode = $LASTEXITCODE
$ErrorActionPreference = "Stop"
if ($expectedCode -ne 0 -or -not $expectedSha) { Stop-Here "-ExpectedCommit '$ExpectedCommit' is not a commit in this repository." }
$expectedSha = ([string]$expectedSha).Trim()
if ($mainSha -cne $originSha -or $mainSha -cne $expectedSha -or $headSha -cne $expectedSha) {
  Stop-Here ("main, origin/main and -ExpectedCommit are not one commit: HEAD " + $headSha.Substring(0, 8) + ", main " + $mainSha.Substring(0, 8) + ", origin/main " + $originSha.Substring(0, 8) + ", expected " + $expectedSha.Substring(0, 8) + ". Merge, push, and pass the pushed sha.")
}
# The stamp is this sha, in full, lower-case: the code serves a commit only if it matches ^[0-9a-f]{40}$ (src/code-identity.ts), so anything else would deploy as "malformed_stamp".
if ($headSha -cnotmatch '^[0-9a-f]{40}$') { Stop-Here "HEAD '$headSha' is not 40 lower-case hex: it could not be stamped (the Worker would serve malformed_stamp)." }
# Every git read below checks its own exit code before its output is read: a failed native command prints nothing, and nothing must not read as "clean" or "no change".
$dirty = @(git status --porcelain)
if ($LASTEXITCODE -ne 0) { Stop-Here "git status failed (exit $LASTEXITCODE): the clean-tree check cannot be read." }
if ($dirty.Count -gt 0) { Stop-Here ("working tree not clean (" + $dirty.Count + " paths): the deploy must ship exactly the committed tree.") }
git merge-base --is-ancestor $LIVE_BASE_COMMIT HEAD
if ($LASTEXITCODE -ne 0) { Stop-Here "HEAD does not contain $($LIVE_BASE_COMMIT.Substring(0, 8)) (the live worker's code): this deploy would drop the waves before it." }
# Non-minting: the attested template lives in FRONT_DOOR_TEMPLATE in src/doc.ts. This wave does not edit src/doc.ts, and the proof is that the template text itself is byte-identical at both commits.
$liveDoc = (@(git show ($LIVE_BASE_COMMIT + ":src/doc.ts")) -join "`n")
if ($LASTEXITCODE -ne 0) { Stop-Here "git show $($LIVE_BASE_COMMIT.Substring(0, 8)):src/doc.ts failed (exit $LASTEXITCODE): the no-mint check cannot be read." }
$headDoc = (@(git show ($headSha + ":src/doc.ts")) -join "`n")
if ($LASTEXITCODE -ne 0) { Stop-Here "git show $($headSha.Substring(0, 8)):src/doc.ts failed (exit $LASTEXITCODE): the no-mint check cannot be read." }
$liveTemplate = Get-TemplateText $liveDoc
$headTemplate = Get-TemplateText $headDoc
if ($null -eq $liveTemplate -or $null -eq $headTemplate) { Stop-Here "FRONT_DOOR_TEMPLATE could not be found in src/doc.ts at one of the two commits: the no-mint check cannot be read." }
if ($liveTemplate -cne $headTemplate) { Stop-Here "FRONT_DOOR_TEMPLATE differs between $($LIVE_BASE_COMMIT.Substring(0, 8)) and HEAD: this wave mints nothing and was to leave the attested template alone. Not this script's deploy." }
# No migration and no schema change since the live code: this script has no migration step, so a wave that grew one must not ship through it.
$schemaMoves = @(git diff --name-status --no-renames $LIVE_BASE_COMMIT HEAD -- migrations schema.sql)
if ($LASTEXITCODE -ne 0) { Stop-Here "git diff failed (exit $LASTEXITCODE): the no-migration check cannot be read." }
if ($schemaMoves.Count -gt 0) { Stop-Here ("migrations/ or schema.sql changed since " + $LIVE_BASE_COMMIT.Substring(0, 8) + " (" + ($schemaMoves -join " | ") + "): this script applies no migration and this wave was to have none. Not this script's deploy.") }
# BEGIN-REVIEWED-SOURCE-CHECK
# (a) HEAD is the reviewed commit plus only the allowlisted paths (no rename detection: a rename out of src/ into docs/ must list BOTH paths)
git merge-base --is-ancestor $REVIEWED_COMMIT HEAD
if ($LASTEXITCODE -ne 0) { Stop-Here "HEAD does not contain the reviewed commit $($REVIEWED_COMMIT.Substring(0, 8)): this is not the code that was reviewed." }
$afterReview = @(git diff --name-only --no-renames $REVIEWED_COMMIT HEAD)
if ($LASTEXITCODE -ne 0) { Stop-Here "git diff failed (exit $LASTEXITCODE): the changes since the reviewed commit cannot be read." }
$unreviewed = @(Get-DisallowedPaths $afterReview)
if ($unreviewed.Count -gt 0) { Stop-Here ("these paths changed since the reviewed commit " + $REVIEWED_COMMIT.Substring(0, 8) + " and are not on the allowlist (" + ($ALLOWED_PATHS_AFTER_REVIEW -join ", ") + "), so what would ship was not reviewed: " + ($unreviewed -join ", ")) }
Say ("[git] reviewed source: HEAD differs from " + $REVIEWED_COMMIT.Substring(0, 8) + " in " + $afterReview.Count + " path(s), all on the allowlist")
# END-REVIEWED-SOURCE-CHECK
# This checkout must be the penny-three wave on top of the seat counts wave and everything before it.
if (-not (Select-String -Path "src/society.ts" -Pattern "export async function everWrittenSeats" -Quiet)) { Stop-Here "src/society.ts has no everWrittenSeats: this checkout is not the penny-three wave." }
if (-not (Select-String -Path "src/society.ts" -Pattern "export async function payerTracesFor" -Quiet)) { Stop-Here "src/society.ts has no payerTracesFor: this checkout is not the penny-three wave." }
if (-not (Select-String -Path "src/register-gate.ts" -Pattern "export function parseRegistrationDescription" -Quiet)) { Stop-Here "src/register-gate.ts has no parseRegistrationDescription: this checkout is not the penny-three wave." }
if (-not (Select-String -Path "src/guest-core.ts" -Pattern "export const RECEIVED_ELSEWHERE:" -SimpleMatch -Quiet)) { Stop-Here "src/guest-core.ts has no RECEIVED_ELSEWHERE: this checkout is not the penny-three wave." }
if (-not (Select-String -Path "src/society.ts" -Pattern "export async function actedWritersSince" -Quiet)) { Stop-Here "src/society.ts has no actedWritersSince: this checkout would drop the seat counts wave." }
if (-not (Select-String -Path "src/council.ts" -Pattern "export async function citizenWritersSince" -Quiet)) { Stop-Here "src/council.ts has no citizenWritersSince: this checkout would drop the seat counts wave." }
if (-not (Select-String -Path "src/index.ts" -Pattern 'path === "/api/treasury" && method === "GET"' -SimpleMatch -Quiet)) { Stop-Here "src/index.ts does not dispatch GET /api/treasury: this checkout would drop the seat counts wave." }
if (-not (Select-String -Path "src/society.ts" -Pattern "export const OPERATOR_FUNDED_SCOPE_SENTENCE" -Quiet)) { Stop-Here "src/society.ts has no OPERATOR_FUNDED_SCOPE_SENTENCE: this checkout would drop the funding label wave." }
if (-not (Select-String -Path "src/doors.ts" -Pattern '"mcp_read_tool_call"' -Quiet)) { Stop-Here "src/doors.ts does not list mcp_read_tool_call: this checkout would drop the door funnel wave." }
if (-not (Select-String -Path "src/council-core.ts" -Pattern "export const citizenCouncilFlagParts" -Quiet)) { Stop-Here "src/council-core.ts has no citizenCouncilFlagParts: this checkout would drop the council flag wave." }
if (-not (Select-String -Path "src/council.ts" -Pattern "export async function claimCouncilSeat" -Quiet)) { Stop-Here "src/council.ts has no claimCouncilSeat: this checkout would drop the council." }
if (-not (Select-String -Path "src/resident.ts" -Pattern "export async function bindResident" -Quiet)) { Stop-Here "src/resident.ts has no bindResident: this checkout would drop the resident tier." }
if (-not (Select-String -Path "src/code-identity.ts" -Pattern "export function codeBlock" -Quiet)) { Stop-Here "src/code-identity.ts has no codeBlock: this checkout would drop served code identity." }
if (-not (Select-String -Path "src/guest.ts" -Pattern "export async function postGuestComment" -Quiet)) { Stop-Here "src/guest.ts has no postGuestComment: this checkout would drop the guest voice." }
if (-not (Select-String -Path "wrangler.jsonc" -Pattern '"version_metadata"' -Quiet)) { Stop-Here "wrangler.jsonc has no version_metadata binding: the Worker could not serve Cloudflare's version id." }
if (Select-String -Path "wrangler.jsonc" -Pattern '"CODE_COMMIT"' -Quiet) { Stop-Here "wrangler.jsonc configures a CODE_COMMIT var: a deploy that forgot the flag would serve a stale stamp. The stamp comes from this script's --var only." }
Say ("[git] HEAD " + $headSha.Substring(0, 8) + " = main = origin/main = -ExpectedCommit; tree clean; contains " + $LIVE_BASE_COMMIT.Substring(0, 8) + "; FRONT_DOOR_TEMPLATE unmoved; no migration and no schema change since the live base")

# 1. the wave's own gates, re-run here so a stale checkout cannot deploy
# BEGIN-GATES
$ErrorActionPreference = "Continue"
$testOut = (npm test 2>&1 | Out-String)
$testCode = $LASTEXITCODE
$tscOut = (npm run typecheck 2>&1 | Out-String)
$tscCode = $LASTEXITCODE
$ErrorActionPreference = "Stop"
$summary = Get-TestSummary $testOut
if ($null -eq $summary) { Stop-Here "npm test: exit $testCode, the output does not END with node's eight-line summary (tests, suites, pass, fail, cancelled, skipped, todo, duration_ms): the run did not finish, or failure detail was printed after the summary. Read the output by hand." }
if (-not $summary.SumOk) { Stop-Here ("npm test: the summary's tests count (" + $summary.Tests + ") is not pass + fail + cancelled + skipped + todo (" + $summary.Pass + " + " + $summary.Fail + " + " + $summary.Cancelled + " + " + $summary.Skipped + " + " + $summary.Todo + ").") }
if ($testCode -ne 0 -or $summary.Fail -ne "0" -or -not $summary.Pass) { Stop-Here ("npm test: exit " + $testCode + ", pass '" + $summary.Pass + "', fail '" + $summary.Fail + "'.") }
if ($tscCode -ne 0) { Stop-Here "typecheck failed: $tscOut" }
Say ("[tests] pass " + $summary.Pass + ", fail 0; typecheck clean")
# END-GATES

# 2. live, before: non-minting baseline, the live worker is the base this wave was checked against, the three changed answers carry NONE of the new fields yet (so the propagation poll proves something),
# and the composition figures are recorded for the ride to compare
$attBefore = Read-Attest "before the deploy"
Assert-Attest $attBefore "before the deploy"
Say ("[live] before: v5 " + $V5_HASH.Substring(0, 8) + "; all four chains ok; identity " + $attBefore.identity_log.sealed_entries + ", treasury " + $attBefore.treasury.sealed_entries + ", ballots " + $attBefore.ballots.sealed_entries)
if ($null -eq $attBefore.code -or [string]$attBefore.code.commit_status -cne "stamped") { Stop-Here "GET /api/attest serves no stamped code.commit before the deploy: the live worker cannot be shown to be the base this wave was checked against." }
if ([string]$attBefore.code.commit -ceq $headSha) { Stop-Here "GET /api/attest already serves code.commit $($headSha.Substring(0, 8)): this commit looks already deployed. Verify by hand; this script cannot prove a propagation it did not wait for." }
if ([string]$attBefore.code.commit -cne $LIVE_BASE_COMMIT) { Stop-Here ("the live worker serves code.commit " + $attBefore.code.commit + " but `$LIVE_BASE_COMMIT is " + $LIVE_BASE_COMMIT + ": the base this wave was checked against is not what is live. Correct the pin (or find out what deployed) before anything else.") }
# The rollback target is READ from the live worker, never typed in: the version that serves right now.
$rollbackTarget = "the version before it (check npx wrangler deployments list)"
if ([string]$attBefore.code.version_status -ceq "available" -and $attBefore.code.version_id) { $rollbackTarget = [string]$attBefore.code.version_id }
Say "[live] before: the live worker serves the pinned base $($LIVE_BASE_COMMIT.Substring(0, 8)); rollback target $rollbackTarget"
$officialBefore = Get-Text $OFFICIAL_URL 30
if ($officialBefore.Code -ne "200") { Stop-Here "GET /api/official answered $($officialBefore.Code) before the deploy, expected 200: investigate." }
if (-not (Test-EverWrittenAbsent $officialBefore.Body)) { Stop-Here "GET /api/official already carries ever_written or not_designated_ever_written (or is unreadable): this wave looks already deployed. Verify by hand; this script cannot prove a propagation it did not wait for." }
$citizensBefore = Get-Text $CITIZENS_URL 30
if ($citizensBefore.Code -ne "200") { Stop-Here "GET /api/citizens answered $($citizensBefore.Code) before the deploy, expected 200: investigate." }
if (-not (Test-PayerTraceAbsent $citizensBefore.Body)) { Stop-Here "GET /api/citizens already carries payer_trace on a row (or has no rows, or is unreadable): this wave looks already deployed. Verify by hand; this script cannot prove a propagation it did not wait for." }
$dueBefore = Get-Text $DUE_URL 30
if ($dueBefore.Code -ne "200") { Stop-Here "GET /api/guest/due answered $($dueBefore.Code) before the deploy, expected 200: investigate." }
if (-not (Test-ReceivedElsewhereAbsent $dueBefore.Body)) { Stop-Here "GET /api/guest/due already carries received_elsewhere (or is unreadable): this wave looks already deployed. Verify by hand; this script cannot prove a propagation it did not wait for." }
$snapshotBefore = Get-CompositionSnapshot $officialBefore.Body
if ($null -eq $snapshotBefore) { Stop-Here "GET /api/official carried no composition block before the deploy: the figures the ride compares against cannot be read." }
Say "[live] before: none of the new fields is served (the new code is absent); composition $snapshotBefore"

if ($DryRun) {
  Say "[dry-run] would now: run npx wrangler deploy --var CODE_COMMIT:<the full sha> and capture its Current Version ID (refusing to continue without one); poll up to $POLL_TRIES times, $POLL_DELAY_SECONDS s apart, until GET /api/attest serves that commit and version id and GET /api/official serves acted_30d, ever_written and not_designated_ever_written as whole numbers with their provenance, GET /api/citizens serves payer_trace on every row and GET /api/guest/due serves received_elsewhere; re-check attest (v5, template $($V5_HASH.Substring(0, 8)), every chain ok); ride the public reads (GET only: the counts consistent, the composition figures equal the recorded ones, the rows with the operator-wallet flag true equal operator_paid, every beyond_direct_payer not_checkable_by_us, received_elsewhere_count equal to the list length and at least 3, /llms.txt and the three notes name the new fields). NO write request of any kind, NO migration, NO D1 access and no live write at any point. Nothing was deployed."
  exit 0
}

# 3. deploy the worker with the commit stamp, capturing its version id (a deploy whose id cannot be read is a stop: it cannot be tied to this commit), then poll until the served identity is this deploy's
# BEGIN-DEPLOY-AND-POLL
Say "[deploy] npx wrangler deploy --var CODE_COMMIT:$($headSha.Substring(0, 8))... (commit $($headSha.Substring(0, 8)))"
$ErrorActionPreference = "Continue"
$deployOut = (npx wrangler deploy --var "CODE_COMMIT:$headSha" 2>&1 | Out-String)
$deployCode = $LASTEXITCODE
$ErrorActionPreference = "Stop"
if ($deployCode -ne 0) { Stop-Here "wrangler deploy failed (exit $deployCode); this wave applied no migration, so there is nothing else to undo. Output: $deployOut" }
# The id is read from its OWN line, and exactly one such line must exist: with two, which one is this deploy's cannot be told.
$versionMatches = @([regex]::Matches($deployOut, '(?m)^[ \t]*Current Version ID:[ \t]*([0-9a-fA-F-]{36})[ \t]*\r?$'))
if ($versionMatches.Count -gt 1) { Stop-Here ("wrangler deploy printed 'Current Version ID' on " + $versionMatches.Count + " lines; which one is this deploy's cannot be told, and the deploy may have succeeded. Check 'npx wrangler deployments list' by hand before anything else.") }
if ($versionMatches.Count -lt 1) { Stop-Here "wrangler deploy exited 0 but printed no 'Current Version ID'; the deploy may have succeeded. Check 'npx wrangler deployments list' by hand before anything else." }
$versionId = $versionMatches[0].Groups[1].Value
Say "[deploy] worker version id $versionId (commit $($headSha.Substring(0, 8)))"
$ROLLBACK_LINE = "ROLL BACK THE WORKER (npx wrangler rollback, to the version before $versionId, which should be $rollbackTarget; check npx wrangler deployments list first). This wave applied no migration and wrote no row, so the rollback is the whole undo."
Wait-NewWorker $headSha $versionId $POLL_TRIES $POLL_DELAY_SECONDS
# END-DEPLOY-AND-POLL

# 4. the ride: non-minting and the chains, then GET-only reads of every surface the wave changed. It writes nothing.
$attAfter = Read-Attest "after the deploy"
Assert-Attest $attAfter "after the deploy"
Say ("[ride] attest: v5 " + $V5_HASH.Substring(0, 8) + " unchanged; every chain ok")
$bad = @()
foreach ($p in "/", "/api/official", "/llms.txt", "/openapi.json", "/treasury", "/api/treasury", "/api/listings", "/api/stats", "/api/topics", "/api/guest/due", "/api/citizens", "/api/doors", "/api/council", "/api/residents") {
  $r = Get-Text "$BASE$p" 30
  if ($r.Code -ne "200") { $bad += "$p=$($r.Code)" }
}
if ($bad.Count -gt 0) { Stop-Here ("non-200 after the deploy (version $versionId): " + ($bad -join ", ") + ". If a read that answered before now fails: $ROLLBACK_LINE") }
Say "[ride] 14 public reads -> 200"
# the counts: whole numbers, consistent, with provenance
# Up to three reads, 10 s apart: the three writer counts share one read and are null by design on a response whose writer read failed, so one transient D1 failure must not print the rollback line
# for a healthy deploy (the poll above already saw the counts served). A null on all three reads is a writer query failing in production, and that stops the script.
for ($try = 1; $try -le 3; $try++) {
  $officialNow = Get-Text $OFFICIAL_URL 30
  if ($officialNow.Code -ne "200") { Stop-Here "GET /api/official answered $($officialNow.Code). $ROLLBACK_LINE" }
  $servedWhy = Test-EverWrittenServed $officialNow.Body
  if ($servedWhy -eq "" -or -not (Test-IsNullReason $servedWhy)) { break }
  if ($try -lt 3) { Say "[ride] a writer count was null on read $try (its writer read failed for that response); reading again in 10 s"; Start-Sleep -Seconds 10 }
}
if ($servedWhy -ne "") { Stop-Here "GET /api/official does not serve the ever-written counts as defined: $servedWhy. $ROLLBACK_LINE" }
if (-not (Test-OfficialNoteNamesEverWritten $officialNow.Body)) { Stop-Here "the composition note on GET /api/official does not name ever_written and not_designated_ever_written. $ROLLBACK_LINE" }
$officialObj = ($officialNow.Body | ConvertFrom-Json)
$comp = $officialObj.composition
Say ("[ride] composition: citizens " + $comp.citizens + ", acted_30d " + $comp.acted_30d + ", ever_written " + $comp.ever_written + ", not_designated_ever_written " + $comp.not_designated_ever_written + ", operator_paid " + $comp.operator_paid + "; each new count has its provenance entry")
# nothing else moved: the composition figures equal what was served before
$snapshotAfter = Get-CompositionSnapshot $officialNow.Body
if ($null -eq $snapshotAfter) { Stop-Here "GET /api/official carried no composition block after the deploy. $ROLLBACK_LINE" }
if ($snapshotAfter -cne $snapshotBefore) { Stop-Here ("the composition changed across the deploy: before '" + $snapshotBefore + "', after '" + $snapshotAfter + "'. This wave was to add fields and move no figure. " + $ROLLBACK_LINE) }
Say ("[ride] composition figures unchanged (" + $snapshotAfter + ")")
# the payer trace: on every row, the reach token on every row, and the operator-wallet rows equal operator_paid
$citizensNow = Get-Text $CITIZENS_URL 30
if ($citizensNow.Code -ne "200") { Stop-Here "GET /api/citizens answered $($citizensNow.Code). $ROLLBACK_LINE" }
$traceWhy = Test-PayerTraceServed $citizensNow.Body $comp.operator_paid
if ($traceWhy -ne "") { Stop-Here "GET /api/citizens does not serve payer_trace as defined: $traceWhy. $ROLLBACK_LINE" }
if (-not (Test-CitizensNoteNamesPayerTrace $citizensNow.Body)) { Stop-Here "the note on GET /api/citizens does not name payer_trace, direct_payer_is_operator_wallet and not_checkable_by_us. $ROLLBACK_LINE" }
Say "[ride] payer_trace is on every census row, every beyond_direct_payer is not_checkable_by_us, and the rows with direct_payer_is_operator_wallet true equal operator_paid"
# the list of critiques received elsewhere: served, counted, outside the duty counts
$dueNow = Get-Text $DUE_URL 30
if ($dueNow.Code -ne "200") { Stop-Here "GET /api/guest/due answered $($dueNow.Code). $ROLLBACK_LINE" }
$dueWhy = Test-ReceivedElsewhereServed $dueNow.Body
if ($dueWhy -ne "") { Stop-Here "GET /api/guest/due does not serve received_elsewhere as defined: $dueWhy. $ROLLBACK_LINE" }
if (-not (Test-DueNoteSeparatesList $dueNow.Body)) { Stop-Here "the note on GET /api/guest/due does not separate received_elsewhere from the duty. $ROLLBACK_LINE" }
Say ("[ride] received_elsewhere_count " + ($dueNow.Body | ConvertFrom-Json).received_elsewhere_count + " equals the list length; the duty counts add up")
# the other served words: llms.txt names the new fields
$llmsNow = Get-Text "$BASE/llms.txt" 30
if ($llmsNow.Code -ne "200") { Stop-Here "GET /llms.txt answered $($llmsNow.Code). $ROLLBACK_LINE" }
foreach ($name in "ever_written", "not_designated_ever_written", "payer_trace", "direct_payer_is_operator_wallet", "beyond_direct_payer", "received_elsewhere") {
  if (-not $llmsNow.Body.Contains($name)) { Stop-Here "GET /llms.txt does not name $name. $ROLLBACK_LINE" }
}
Say "[ride] /llms.txt, the composition note, the /api/citizens note and the /api/guest/due note name the new fields"
Say "[note] Writes made by this ride: NONE. Every request was a GET; no token, no key."
Say "[done] Penny-three wave deployed and ridden. Log version id $versionId, commit $($headSha.Substring(0, 8)) and these lines in HANDOVER.md. The Colony envoy owes penny a 'now live' line under its thread."
