// scripts/deploy-last-assertion-at.ps1 is WRITTEN AND NEVER RUN by the builder (no deploy, no wrangler, no D1, not even -DryRun, which reads production D1). It is proven here by what can be proven without running it: it
// parses under PowerShell's own parser, is ASCII with LF endings, has none of the repo's PowerShell traps, ships with both pins as placeholders and STOPS on them before any git, npm, wrangler or network command, refuses a real
// run without -RehearsalPassed, has the load-bearing step order (first production read, then migration, then verification, then worker, then the second verification, then ride), uses wrangler only through the bounded
// helper, signs nothing, and every decision function (the one-hour window, the verification, the column, the served-answer checks, the bounded runner) is RUN FOR REAL against good and bad captured inputs, with the
// verification SQL run over a real SQLite citizens table. Pattern: test/deploy-decided-event-id-script.test.ts (T12 of drafts/BRIEF-LAST-ASSERTION-AT-2026-11-04.md).
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parsePowerShellFile } from "./helpers/ps-parse.ts";

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
const SCRIPT_PATH = here("../scripts/deploy-last-assertion-at.ps1");
const rawScript = readFileSync(SCRIPT_PATH, "utf8");
const script = rawScript.replace(/\r\n/g, "\n");
const code = script.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
const defs = script.slice(script.indexOf('$ErrorActionPreference = "Stop"'), script.indexOf("# END-OF-DEFINITIONS"));
const pinBlock = script.slice(script.indexOf("# BEGIN-PIN-CHECK"), script.indexOf("# END-PIN-CHECK"));
const rehearsalBlock = script.slice(script.indexOf("# BEGIN-REHEARSAL-CHECK"), script.indexOf("# END-REHEARSAL-CHECK"));
const verifySql = readFileSync(here("../scripts/verify-last-assertion-at.sql"), "utf8").replace(/\r\n/g, "\n");
const LIVE = "7b49b7b65b8477cdafb5057541a9432def1a5705";
const FULL = "0123456789abcdef0123456789abcdef01234567";

function runPs(lines: string[]): { code: number | null; out: string } | null {
  const dir = mkdtempSync(join(tmpdir(), "deploy-last-assertion-at-"));
  try {
    const ps1 = join(dir, "harness.ps1");
    writeFileSync(ps1, lines.join("\r\n"));
    const r = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1], { encoding: "utf8" });
    if (r.error) return null;
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const q = (s: string): string => "'" + s.replace(/'/g, "''") + "'";
// Runs `defs` (definitions only, nothing touches git or the network) then the given statements; each prints RESULT <name> [<value>].
function harness(statements: string[]): string[] {
  return ["$ErrorActionPreference = 'Stop'", "$script:PreflightAt = $null", defs, ...statements];
}
const d1json = (rows: unknown[]): string => `[{"results":${JSON.stringify(rows)},"success":true,"meta":{}}]`;

test("the script parses under PowerShell's own parser with zero errors, is ASCII only and has LF line endings", (t) => {
  assert.equal(/[^\x00-\x7f]/.test(rawScript), false, "ASCII only");
  assert.equal(rawScript.includes("\r"), false, "LF line endings");
  const parsed = parsePowerShellFile(SCRIPT_PATH);
  if (!parsed.available) {
    t.skip(`${parsed.reason}; the static checks still run`);
    return;
  }
  assert.equal(parsed.errors, 0, `parse errors: ${parsed.detail}`);
});

test("no PowerShell traps: one spelling per variable, no `$var:` drive reference, stderr merged only under Continue, no -notmatch over a pipeline", () => {
  const names = new Map<string, Set<string>>();
  for (const m of code.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)) {
    const set = names.get(m[1].toLowerCase()) ?? new Set<string>();
    set.add(m[1]);
    names.set(m[1].toLowerCase(), set);
  }
  assert.deepEqual([...names.values()].filter((s) => s.size > 1).map((s) => [...s].join(" / ")), []);
  assert.equal(/\$[A-Za-z_][A-Za-z0-9_]*:/.test(code.replace(/\$\(/g, "").replace(/\$script:/g, "").replace(/\$env:/g, "")), false);
  for (const m of code.matchAll(/2>&1/g)) {
    const before = code.slice(0, m.index);
    assert.ok(before.lastIndexOf('$ErrorActionPreference = "Continue"') > before.lastIndexOf('$ErrorActionPreference = "Stop"'));
  }
  assert.equal(/\$\w+\s*\|\s*Where-Object[^\n]*-notmatch/.test(code), false);
});

test("the pins: v6 hash, BOTH pins ship as placeholders for the hub, the allowlist is this script, its test and docs/, -ExpectedCommit is mandatory, -RehearsalPassed exists, the migrations are 0024 and 0025 (AO3: no -MigrationAlreadyApplied switch)", () => {
  assert.match(script, /^\$V6_HASH = "dc5f48213c29bcf844e0fbe7daf1bdb5416b3d57fbd06a8bd03f1061f34092b3"$/m);
  assert.match(script, /^\$LIVE_BASE_COMMIT = "TO-BE-SET-BY-HUB-LIVE-BASE"$/m);
  assert.match(script, /^\$REVIEWED_COMMIT = "TO-BE-SET-BY-HUB"$/m);
  assert.match(script, /^\$ALLOWED_PATHS_AFTER_REVIEW = @\("scripts\/deploy-last-assertion-at\.ps1", "test\/deploy-last-assertion-at-script\.test\.ts", "docs\/"\)$/m);
  assert.match(script, /\[Parameter\(Mandatory = \$true\)\]\[string\]\$ExpectedCommit/);
  assert.match(script, /\[switch\]\$DryRun/);
  assert.equal(/\[switch\]\$MigrationAlreadyApplied/.test(script), false, "AO3: the single presence switch is gone, the catalogue is the state");
  assert.match(script, /\[switch\]\$RehearsalPassed/);
  assert.match(script, /^\$MIGRATION_PATH_0024 = "migrations\/0024_last_assertion_at\.sql"$/m);
  assert.match(script, /^\$MIGRATION_PATH_0025 = "migrations\/0025_assertion_objection\.sql"$/m);
  assert.match(script, /^\$COLUMN_0024 = "last_assertion_at"$/m);
  assert.match(script, /^\$COLUMN_0025 = "assertion_objected_at"$/m);
  assert.match(script, /^\$VERIFY_SQL_PATH = "scripts\/verify-last-assertion-at\.sql"$/m);
  assert.match(script, /^\$WINDOW_SECONDS = 3600$/m);
});

test("step 0a STOPS on either placeholder (as shipped) or a malformed pin before ANY git, npm, wrangler or network command (the pin block is run for real), and passes full shas", (t) => {
  const stubs = ["git", "npm", "npx", "curl.exe"].map((n) => `function ${n} { throw "${n} must not run in step 0a" }`);
  const h = (live: string, reviewed: string): string[] => [
    "$ErrorActionPreference = 'Stop'",
    ...stubs,
    "function Stop-Here($msg) { Write-Host \"[STOP] $msg\"; exit 1 }",
    `$LIVE_BASE_COMMIT = "${live}"`,
    '$LIVE_BASE_PLACEHOLDER = "TO-BE-SET-BY-HUB-LIVE-BASE"',
    `$REVIEWED_COMMIT = "${reviewed}"`,
    '$REVIEWED_COMMIT_PLACEHOLDER = "TO-BE-SET-BY-HUB"',
    pinBlock,
    'Write-Host "[PASSED-PINS]"',
  ];
  const asShipped = runPs(h("TO-BE-SET-BY-HUB-LIVE-BASE", "TO-BE-SET-BY-HUB"));
  if (!asShipped) return t.skip("no PowerShell available");
  assert.equal(asShipped.code, 1);
  assert.match(asShipped.out, /\[STOP\].*LIVE_BASE_COMMIT still holds the placeholder/);
  assert.match(runPs(h(LIVE, "TO-BE-SET-BY-HUB"))!.out, /\[STOP\].*REVIEWED_COMMIT still holds the placeholder/);
  assert.match(runPs(h(LIVE, "ABCDEF0123456789ABCDEF0123456789ABCDEF01"))!.out, /\[STOP\].*not 40 lower-case hex/);
  assert.match(runPs(h("7b49b7b6", FULL))!.out, /\[STOP\].*LIVE_BASE_COMMIT.*not 40 lower-case hex/);
  const ok = runPs(h(LIVE, FULL))!;
  assert.equal(ok.code, 0);
  assert.match(ok.out, /\[PASSED-PINS\]/);
});

test("a real run without -RehearsalPassed STOPS before anything else; -RehearsalPassed or -DryRun lets it through (the block is run for real)", (t) => {
  const h = (flags: string): string[] => [
    "$ErrorActionPreference = 'Stop'",
    "function Stop-Here($msg) { Write-Host \"[STOP] $msg\"; exit 1 }",
    `$DryRun = ${flags.includes("D") ? "$true" : "$false"}`,
    `$RehearsalPassed = ${flags.includes("R") ? "$true" : "$false"}`,
    rehearsalBlock,
    'Write-Host "[PASSED-REHEARSAL]"',
  ];
  const none = runPs(h(""));
  if (!none) return t.skip("no PowerShell available");
  assert.equal(none.code, 1);
  assert.match(none.out, /\[STOP\].*-RehearsalPassed/);
  assert.match(runPs(h("R"))!.out, /\[PASSED-REHEARSAL\]/);
  assert.match(runPs(h("D"))!.out, /\[PASSED-REHEARSAL\]/);
  assert.ok(script.indexOf("# BEGIN-REHEARSAL-CHECK") > script.indexOf("# END-PIN-CHECK") && script.indexOf("# END-REHEARSAL-CHECK") < script.indexOf("git fetch origin"), "the rehearsal check sits after the pins and before any git command");
});

test("the steps are in the load-bearing order: pins, rehearsal, git, gates, live read, first production read, dry-run exit, migration, verification, worker deploy, second verification, ride; wrangler runs only through Invoke-Bounded; nothing signs", () => {
  const order = [
    "# BEGIN-PIN-CHECK",
    "# BEGIN-REHEARSAL-CHECK",
    "git fetch origin",
    "# BEGIN-REVIEWED-SOURCE-CHECK",
    "# BEGIN-GATES",
    'Read-Attest "before the deploy"',
    "$script:PreflightAt = Get-Date",
    '$columnRes0024 = Invoke-D1Read (Get-ColumnSql $COLUMN_0024)',
    '$columnRes0025 = Invoke-D1Read (Get-ColumnSql $COLUMN_0025)',
    '$colState = Get-ColumnState $columnRes0024 $columnRes0025',
    "if ($DryRun)",
    "# BEGIN-MIGRATION",
    '# END-MIGRATION-APPLY',
    'Assert-Prod-Verified "after the migrations"',
    "# BEGIN-DEPLOY-AND-POLL",
    "Wait-NewWorker $headSha $versionId",
    "# BEGIN-RECONCILE",
    'Assert-Prod-Verified "after worker activation"',
    'Read-Attest "after the deploy"',
    "Stop-Here \"GET /api/citizens: $why",
    'Invoke-Tool $door "citizens"',
    "Test-PrivacyServed $privacy.Body",
  ];
  let last = -1;
  for (const needle of order) {
    const i = script.indexOf(needle);
    assert.ok(i > last, `${needle} comes after the previous step`);
    last = i;
  }
  const wranglerLines = code.split("\n").filter((l) => l.includes("npx wrangler"));
  const executed = wranglerLines.filter((l) => /Invoke-Bounded(Sql)? \("npx wrangler /.test(l));
  assert.deepEqual(
    executed.map((l) => /npx wrangler (\S+)/.exec(l)![1]).sort(),
    ["d1", "d1", "deploy"],
    "d1 execute (the --command read and the migration) and one stamped deploy, each through Invoke-Bounded",
  );
  for (const l of wranglerLines.filter((l) => !executed.includes(l))) assert.match(l, /Stop-Here|Say |ROLLBACK_LINE|dry-run|rollbackTarget/, `any other mention of wrangler is message text: ${l.trim().slice(0, 80)}`);
  assert.equal((code.match(/Start-Process/g) ?? []).length, 1, "one process launcher");
  assert.match(code, /npx wrangler deploy --var CODE_COMMIT:" \+ \$headSha/);
  assert.equal(/Invoke-WebRequest|Invoke-RestMethod/i.test(code), false, "no PowerShell web cmdlets");
  assert.ok(code.includes('--data-binary "@$dataFile"'), "request bodies go by file, never an inner-quoted argument");
  assert.ok(code.includes("src/doc.ts") && code.includes("-- migrations"), "the no-mint and one-migration checks");
  // The script holds no key and signs nothing: no key material, no signature helper, no Authorization header, no POST other than the read-only tools/call.
  assert.equal(/Authorization|Bearer|ch1\.|Ed25519|\.local\./i.test(code), false, "no credential, assertion or custody file is touched");
  assert.equal(/backfill/i.test(code), false, "no backfill step");
});

test("the header carries the rollback text and every duty (rehearsal first, the one hour, both MCP doors, the not-ridden honesty line, no signing)", () => {
  const header = script.split("\n").filter((l) => /^\s*#/.test(l)).join("\n");
  for (const needle of [
    "ONE HOUR",
    "worker rollback",
    "leaves migrations 0024 and 0025 applied",
    "0024 present, 0025 absent",
    "migration applies only if its own column is absent",
    "AO3",
    "AO7",
    "nothing here upholds an objection",
    "stamps go stale",
    "NO BACKFILL",
    "-RehearsalPassed",
    "/mcp and /mcp/read",
    "THIS SCRIPT DOES NOT SIGN ANYTHING",
    "public serving verified; production authentication write path not exercised",
    "worker deployed BEFORE the migration",
    "there is no resume mode",
    "a step BEFORE the worker deploy stopped",
  ]) assert.ok(header.includes(needle), `header names: ${needle}`);
});

test("the one-hour window, run for real: inside passes; just over, a missing first read and a clock far past all stop; a step that would end outside the window is refused", (t) => {
  const run = runPs(
    harness([
      "$t0 = Get-Date",
      'Write-Host ("RESULT inside [" + (Test-WithinWindow $t0 $t0.AddSeconds(3599)) + "]")',
      'Write-Host ("RESULT over [" + (Test-WithinWindow $t0 $t0.AddSeconds(3601)) + "]")',
      'Write-Host ("RESULT never [" + (Test-WithinWindow $null $t0) + "]")',
      'Write-Host ("RESULT far [" + (Test-WithinWindow $t0 $t0.AddDays(2)) + "]")',
      'Write-Host ("RESULT fits [" + (Test-SufficientWindow $t0 $t0.AddSeconds(3400) 200) + "]")',
      'Write-Host ("RESULT toolate [" + (Test-SufficientWindow $t0 $t0.AddSeconds(3500) 200) + "]")',
    ]),
  );
  if (!run) return t.skip("no PowerShell available");
  assert.match(run.out, /RESULT inside \[\]/, run.out);
  assert.match(run.out, /RESULT over \[the first production read completed 3601 s ago, over the 3600 s window/, run.out);
  assert.match(run.out, /RESULT never \[the first production read has not completed\]/, run.out);
  assert.match(run.out, /RESULT far \[the first production read completed 172800 s ago/, run.out);
  assert.match(run.out, /RESULT fits \[\]/, run.out);
  assert.match(run.out, /RESULT toolate \[the first production read completed 3500 s ago and the next bounded step may need up to 200 s/, run.out);
});

test("the D1 decision functions, run for real: a zero-row verification passes (an EMPTY result is not a failed read), any row or an unparsable read stops; the column must be there and INTEGER (a catalogue miss stops)", (t) => {
  const cases: Array<[string, string, string]> = [
    ["verify-clean", `Test-VerificationClean (Read-D1Rows ${q(d1json([]))})`, ""],
    ["verify-row", `Test-VerificationClean (Read-D1Rows ${q(d1json([{ id: 5, handle: "bearer-a", last_assertion_at: 7, stamp_type: "integer", secret_held: 1 }]))})`, "1 offending row(s), first: citizen 5 bearer-a stamp '7'"],
    ["verify-unparsable", `Test-VerificationClean (Read-D1Rows ${q("boom")})`, "no parsable result"],
    ["verify-norows-object", `Test-VerificationClean (Read-D1Rows ${q(`[{"success":true}]`)})`, "no parsable result"],
    ["column-good", `Test-ColumnPresent (Read-D1Rows ${q(d1json([{ name: "last_assertion_at", type: "INTEGER" }]))}) 'last_assertion_at'`, ""],
    ["column-good-0025", `Test-ColumnPresent (Read-D1Rows ${q(d1json([{ name: "assertion_objected_at", type: "INTEGER" }]))}) 'assertion_objected_at'`, ""],
    ["column-absent", `Test-ColumnPresent (Read-D1Rows ${q(d1json([]))}) 'last_assertion_at'`, "0 last_assertion_at column rows"],
    ["column-absent-0025", `Test-ColumnPresent (Read-D1Rows ${q(d1json([]))}) 'assertion_objected_at'`, "0 assertion_objected_at column rows"],
    ["column-text", `Test-ColumnPresent (Read-D1Rows ${q(d1json([{ name: "last_assertion_at", type: "TEXT" }]))}) 'last_assertion_at'`, "expected INTEGER"],
    ["column-text-0025", `Test-ColumnPresent (Read-D1Rows ${q(d1json([{ name: "assertion_objected_at", type: "TEXT" }]))}) 'assertion_objected_at'`, "citizens.assertion_objected_at has type 'TEXT'"],
    ["column-unparsable", `Test-ColumnPresent (Read-D1Rows ${q("Error: no such table")}) 'last_assertion_at'`, "no parsable result"],
  ];
  const run = runPs(harness(cases.map(([name, expr]) => `Write-Host ("RESULT ${name} [" + (${expr}) + "]")`)));
  if (!run) return t.skip("no PowerShell available");
  for (const [name, , expect] of cases) {
    const m = new RegExp(`RESULT ${name} \\[(.*)\\]`).exec(run.out);
    assert.ok(m, `${name} produced a result: ${run.out}`);
    if (expect === "") assert.equal(m![1], "", name);
    else assert.ok(m![1].includes(expect), `${name}: '${m![1]}' mentions '${expect}'`);
  }
});

test("the verification SQL, run for real over a citizens table: clean after the migration (all NULL), clean with a legitimate key-seat stamp, and it names a secret-held seat's stamp, a zero, a negative and a text stamp; it is a single line the script can send", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE citizens (id INTEGER PRIMARY KEY, handle TEXT, public_key TEXT, last_assertion_at INTEGER, assertion_objected_at INTEGER)");
    db.exec("INSERT INTO citizens (id, handle, public_key, last_assertion_at) VALUES (1, 'bearer', NULL, NULL), (2, 'keyed', 'pk', NULL), (3, 'keyed-stamped', 'pk', 1800000000000)");
    assert.deepEqual(db.prepare(verifySql).all(), [], "clean");
    db.exec("UPDATE citizens SET last_assertion_at = 1800000000000 WHERE id = 1");
    assert.deepEqual((db.prepare(verifySql).all() as { handle: string }[]).map((r) => r.handle), ["bearer"], "a stamp on a secret-held seat");
    db.exec("UPDATE citizens SET last_assertion_at = NULL WHERE id = 1; UPDATE citizens SET last_assertion_at = 0 WHERE id = 2");
    assert.deepEqual((db.prepare(verifySql).all() as { handle: string }[]).map((r) => r.handle), ["keyed"], "a zero");
    db.exec("UPDATE citizens SET last_assertion_at = -5 WHERE id = 2");
    assert.equal(db.prepare(verifySql).all().length, 1, "a negative");
    db.exec("UPDATE citizens SET last_assertion_at = 'yesterday' WHERE id = 2");
    assert.equal(db.prepare(verifySql).all().length, 1, "a text value (SQLite keeps it in an INTEGER-affinity column)");
    db.exec("UPDATE citizens SET last_assertion_at = 1800000000000, assertion_objected_at = 1800000001000 WHERE id = 2");
    assert.deepEqual((db.prepare(verifySql).all() as { handle: string }[]).map((r) => r.handle), ["keyed"], "a stamp on a seat whose objection was upheld");
  } finally {
    db.close();
  }
  const run = runPs(harness([`$one = ConvertTo-SingleLineSql ${q(verifySql)}`, 'Write-Host ("RESULT single [" + (Test-SingleLineSql $one) + "]")', 'Write-Host ("RESULT nolines [" + ($one.Contains("`n")) + "]")']));
  if (!run) return;
  assert.match(run.out, /RESULT single \[\]/, run.out);
  assert.match(run.out, /RESULT nolines \[False\]/, run.out);
});

test("the bounded runner, run for real: a quick command returns its stdout and code; a command that outlives its limit is killed and reported TimedOut; a failing command reports its code", (t) => {
  const run = runPs(
    harness([
      'Write-Host ("RESULT quick [" + ((Invoke-Bounded "echo hello-bounded" 20).Out.Trim()) + "|" + (Invoke-Bounded "echo x" 20).Code + "|" + (Invoke-Bounded "echo x" 20).TimedOut + "]")',
      '$slow = Invoke-Bounded "ping -n 30 127.0.0.1" 2',
      'Write-Host ("RESULT slow [" + $slow.TimedOut + "|" + $slow.Code + "]")',
      '$bad = Invoke-Bounded "exit 3" 20',
      'Write-Host ("RESULT bad [" + $bad.Code + "|" + $bad.TimedOut + "]")',
    ]),
  );
  if (!run) return t.skip("no PowerShell available");
  assert.match(run.out, /RESULT quick \[hello-bounded\|0\|False\]/, run.out);
  assert.match(run.out, /RESULT slow \[True\|-1\]/, run.out);
  assert.match(run.out, /RESULT bad \[3\|False\]/, run.out);
});

test("the served-answer checks, run for real: the list needs the note and a stamp key on EVERY row, a non-null stamp must be a whole number on a row with a public key; the privacy page needs the paragraph; a tool answer that is an error or not JSON is null", (t) => {
  const NOTE = "Each row also carries ... last_assertion_at is the greatest server timestamp, in milliseconds, recorded for a citizen assertion. Null means a secret-held seat, no recorded assertion, or an objection the operator has upheld;";
  const rows = [
    { handle: "bearer", public_key: null, last_assertion_at: null },
    { handle: "keyed", public_key: "pk", last_assertion_at: 1800000000000 },
  ];
  const listBody = (over: Record<string, unknown>): string => JSON.stringify({ note: NOTE, citizens: rows, ...over });
  const cases: Array<[string, string, string]> = [
    ["list-good", `Test-CitizensServed (Read-JsonBody @{ Body = ${q(listBody({}))} })`, ""],
    ["list-nonote", `Test-CitizensServed (Read-JsonBody @{ Body = ${q(listBody({ note: "no wording" }))} })`, "does not carry the last_assertion_at wording"],
    ["list-old-note", `Test-CitizensServed (Read-JsonBody @{ Body = ${q(listBody({ note: "last_assertion_at is the greatest server timestamp, null on a row with a public_key means none recorded" }))} })`, "does not carry the objection meaning of null"],
    ["list-nokey", `Test-CitizensServed (Read-JsonBody @{ Body = ${q(listBody({ citizens: [rows[0], { handle: "x", public_key: "pk" }] }))} })`, "citizen x has no last_assertion_at key"],
    ["list-secret-stamped", `Test-CitizensServed (Read-JsonBody @{ Body = ${q(listBody({ citizens: [{ handle: "b", public_key: null, last_assertion_at: 5 }] }))} })`, "has no public_key but serves last_assertion_at 5"],
    ["list-text", `Test-CitizensServed (Read-JsonBody @{ Body = ${q(listBody({ citizens: [{ handle: "k", public_key: "pk", last_assertion_at: "soon" }] }))} })`, "not a whole number"],
    ["list-empty", `Test-CitizensServed (Read-JsonBody @{ Body = ${q(listBody({ citizens: [] }))} })`, "no rows"],
    ["list-html", `Test-CitizensServed (Read-JsonBody @{ Body = '<html>' })`, "did not return JSON"],
    ["privacy-good", `Test-PrivacyServed ${q("x This lets readers observe recorded use of a seat's signing key, y. If the holder of a seat's key objects and shows it holds that key, z")}`, ""],
    ["privacy-no-objection", `Test-PrivacyServed ${q("x This lets readers observe recorded use of a seat's signing key, y")}`, "does not carry the objection sentence"],
    ["privacy-missing", `Test-PrivacyServed ${q("an older privacy page")}`, "does not carry the last_assertion_at paragraph"],
    ["tool-good", `[string]((Read-ToolResult @{ Code = '200'; Body = ${q(JSON.stringify({ result: { content: [{ text: JSON.stringify({ ok: 1 }) }] } }))} }).ok)`, "1"],
    ["tool-iserror", `[string]($null -eq (Read-ToolResult @{ Code = '200'; Body = ${q(JSON.stringify({ result: { isError: true, content: [{ text: "{}" }] } }))} }))`, "True"],
    ["tool-500", `[string]($null -eq (Read-ToolResult @{ Code = '500'; Body = '{}' }))`, "True"],
  ];
  const run = runPs(harness(cases.map(([name, expr]) => `Write-Host ("RESULT ${name} [" + (${expr}) + "]")`)));
  if (!run) return t.skip("no PowerShell available");
  for (const [name, , expect] of cases) {
    const m = new RegExp(`RESULT ${name} \\[(.*)\\]`).exec(run.out);
    assert.ok(m, `${name} produced a result: ${run.out}`);
    if (expect === "") assert.equal(m![1], "", name);
    else assert.ok(m![1].includes(expect), `${name}: '${m![1]}' mentions '${expect}'`);
  }
});

test("the source checks name literals the checkout carries: every Select-String literal is in its file, and the ride's markers are the served note's and the privacy paragraph's own words", () => {
  const society = readFileSync(here("../src/society.ts"), "utf8");
  const privacy = readFileSync(here("../src/privacy.ts"), "utf8");
  assert.ok(society.includes("last_assertion_at is the greatest server timestamp"));
  assert.ok(script.includes('"last_assertion_at is the greatest server timestamp"'));
  assert.ok(privacy.includes("This lets readers observe recorded use of a seat's signing key"));
  assert.ok(script.includes(`"This lets readers observe recorded use of a seat's signing key"`));
  assert.ok(privacy.includes("If the holder of a seat's key objects and shows it holds that key"));
  assert.ok(script.includes(`"If the holder of a seat's key objects and shows it holds that key"`));
  assert.ok(society.includes("or an objection the operator has upheld"));
  assert.ok(script.includes('"or an objection the operator has upheld"'));
  assert.ok(society.includes("AND assertion_objected_at IS NULL"));
  let n = 0;
  for (const m of code.matchAll(/Select-String -Path "([^"]+)" -Pattern ('[^']+'|"[^"]+")/g)) {
    const file = m[1];
    if (file === "wrangler.jsonc") continue;
    const lit = m[2].slice(1, -1);
    assert.ok(readFileSync(here(`../${file}`), "utf8").includes(lit), `${file} carries '${lit}'`);
    n++;
  }
  assert.ok(n >= 5, `checked ${n} literals`);
});

test("AO3: the catalogue state of the two columns, run for real: each combination, a failed read is an error and never 'absent', and 0025 without 0024 is out of order", (t) => {
  const row = (name: string) => d1json([{ name, type: "INTEGER" }]);
  const cases: Array<[string, string, string]> = [
    ["neither", `& { $s = Get-ColumnState (Read-D1Rows ${q(d1json([]))}) (Read-D1Rows ${q(d1json([]))}); [string]$s.Has0024 + '|' + [string]$s.Has0025 + '|' + $s.Error }`, "False|False|"],
    ["only-0024", `& { $s = Get-ColumnState (Read-D1Rows ${q(row("last_assertion_at"))}) (Read-D1Rows ${q(d1json([]))}); [string]$s.Has0024 + '|' + [string]$s.Has0025 + '|' + $s.Error }`, "True|False|"],
    ["both", `& { $s = Get-ColumnState (Read-D1Rows ${q(row("last_assertion_at"))}) (Read-D1Rows ${q(row("assertion_objected_at"))}); [string]$s.Has0024 + '|' + [string]$s.Has0025 + '|' + $s.Error }`, "True|True|"],
    ["only-0025", `& { $s = Get-ColumnState (Read-D1Rows ${q(d1json([]))}) (Read-D1Rows ${q(row("assertion_objected_at"))}); $s.Error }`, "out of order"],
    ["failed-0024", `& { $s = Get-ColumnState $null (Read-D1Rows ${q(d1json([]))}); $s.Error }`, "last_assertion_at catalogue read returned no parsable result"],
    ["failed-0025", `& { $s = Get-ColumnState (Read-D1Rows ${q(row("last_assertion_at"))}) $null; $s.Error }`, "assertion_objected_at catalogue read returned no parsable result"],
  ];
  const run = runPs(harness(cases.map(([name, expr]) => `Write-Host ("RESULT ${name} [" + (${expr}) + "]")`)));
  if (!run) return t.skip("no PowerShell available");
  for (const [name, , expect] of cases) {
    const m = new RegExp(`RESULT ${name} \\[(.*)\\]`).exec(run.out);
    assert.ok(m, `${name} produced a result: ${run.out}`);
    assert.ok(m![1].includes(expect), `${name}: '${m![1]}' mentions '${expect}'`);
  }
});

test("AO3: the migration block, run for real with a recording stub for wrangler: neither column applies 0024 then 0025; 0024 present applies only 0025; both present applies nothing; a failed or timed-out 0024 stops before 0025 is started", (t) => {
  const block = script.slice(script.indexOf("# BEGIN-MIGRATION"), script.indexOf("# END-MIGRATION-APPLY"));
  assert.ok(block.length > 200 && block.includes("MIGRATION_PATH_0025"), "the block was found");
  const h = (has0024: boolean, has0025: boolean, mig0024: string): string[] => [
    "$ErrorActionPreference = 'Stop'",
    "function Stop-Here($msg) { Write-Host \"[STOP] $msg\"; exit 1 }",
    "function Say($msg) { }",
    "function Assert-Window($label, $seconds) { }",
    "$PROD_DB = 'commonhold'; $WRANGLER_D1_SECONDS = 120",
    `$MIGRATION_PATH_0024 = 'migrations/0024_last_assertion_at.sql'; $MIGRATION_PATH_0025 = 'migrations/0025_assertion_objection.sql'`,
    `$colState = @{ Has0024 = $${has0024 ? "true" : "false"}; Has0025 = $${has0025 ? "true" : "false"} }`,
    `function Invoke-Bounded($commandLine, $seconds) { Write-Host ('APPLY ' + $commandLine); if ($commandLine -like '*0024*') { ${mig0024} } else { return @{ Code = 0; Out = ''; TimedOut = $false } } }`,
    block,
    "Write-Host '[BLOCK-DONE]'",
  ];
  const ok = "return @{ Code = 0; Out = ''; TimedOut = $false }";
  const applied = (out: string): string[] => [...out.matchAll(/APPLY .*--file (\S+)/g)].map((m) => m[1]!);
  const none = runPs(h(false, false, ok));
  if (!none) return t.skip("no PowerShell available");
  assert.deepEqual(applied(none.out), ["migrations/0024_last_assertion_at.sql", "migrations/0025_assertion_objection.sql"], none.out);
  assert.match(none.out, /\[BLOCK-DONE\]/);
  assert.deepEqual(applied(runPs(h(true, false, ok))!.out), ["migrations/0025_assertion_objection.sql"], "the state 0024 present, 0025 absent resumes at 0025");
  const both = runPs(h(true, true, ok))!;
  assert.deepEqual(applied(both.out), []);
  assert.match(both.out, /\[BLOCK-DONE\]/);
  const failed = runPs(h(false, false, "return @{ Code = 1; Out = ''; TimedOut = $false }"))!;
  assert.equal(failed.code, 1);
  assert.match(failed.out, /\[STOP\] migration 0024 failed/);
  assert.deepEqual(applied(failed.out), ["migrations/0024_last_assertion_at.sql"], "0025 was never started after a failed 0024");
  const timed = runPs(h(false, false, "return @{ Code = -1; Out = ''; TimedOut = $true }"))!;
  assert.equal(timed.code, 1);
  assert.match(timed.out, /\[STOP\] migration 0024 timed out/);
  assert.deepEqual(applied(timed.out), ["migrations/0024_last_assertion_at.sql"]);
});

test("L1 (re-gate): the rollback text no longer says the old worker stamps an upheld seat, and says the seat stays clear (the rollback target has no stamp code)", () => {
  assert.equal(/would stamp the seat again|old worker stamps a seat|re-check each upheld seat/.test(script), false, "the two wrong clauses are gone");
  assert.ok(script.includes("the seat stays clear: the rollback target has no stamp code"));
  const line = script.split("\n").find((l) => l.startsWith("$ROLLBACK_LINE = "))!;
  assert.ok(line.includes("the old worker records no stamps") && !/stamps a seat/.test(line));
});
