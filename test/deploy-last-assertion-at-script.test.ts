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

test("the pins: v6 hash, BOTH pins ship as placeholders for the hub, the allowlist is this script, its test and docs/, -ExpectedCommit is mandatory, -RehearsalPassed exists, the migration is 0024", () => {
  assert.match(script, /^\$V6_HASH = "dc5f48213c29bcf844e0fbe7daf1bdb5416b3d57fbd06a8bd03f1061f34092b3"$/m);
  assert.match(script, /^\$LIVE_BASE_COMMIT = "TO-BE-SET-BY-HUB-LIVE-BASE"$/m);
  assert.match(script, /^\$REVIEWED_COMMIT = "TO-BE-SET-BY-HUB"$/m);
  assert.match(script, /^\$ALLOWED_PATHS_AFTER_REVIEW = @\("scripts\/deploy-last-assertion-at\.ps1", "test\/deploy-last-assertion-at-script\.test\.ts", "docs\/"\)$/m);
  assert.match(script, /\[Parameter\(Mandatory = \$true\)\]\[string\]\$ExpectedCommit/);
  assert.match(script, /\[switch\]\$DryRun/);
  assert.match(script, /\[switch\]\$MigrationAlreadyApplied/);
  assert.match(script, /\[switch\]\$RehearsalPassed/);
  assert.match(script, /^\$MIGRATION_PATH_EXPECTED = "migrations\/0024_last_assertion_at\.sql"$/m);
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
    '$columnRes = Invoke-D1Read $COLUMN_SQL "the column state read"',
    "$script:PreflightAt = Get-Date",
    "if ($DryRun)",
    "# BEGIN-MIGRATION",
    'Assert-Prod-Verified "after the migration"',
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
    "leaves migration 0024 applied",
    "stamps go stale",
    "NO BACKFILL",
    "-RehearsalPassed",
    "/mcp and /mcp/read",
    "THIS SCRIPT DOES NOT SIGN ANYTHING",
    "public serving verified; production authentication write path not exercised",
    "worker deployed BEFORE the migration",
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
    ["column-good", `Test-ColumnPresent (Read-D1Rows ${q(d1json([{ name: "last_assertion_at", type: "INTEGER" }]))})`, ""],
    ["column-absent", `Test-ColumnPresent (Read-D1Rows ${q(d1json([]))})`, "0 last_assertion_at column rows"],
    ["column-text", `Test-ColumnPresent (Read-D1Rows ${q(d1json([{ name: "last_assertion_at", type: "TEXT" }]))})`, "expected INTEGER"],
    ["column-unparsable", `Test-ColumnPresent (Read-D1Rows ${q("Error: no such table")})`, "no parsable result"],
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
    db.exec("CREATE TABLE citizens (id INTEGER PRIMARY KEY, handle TEXT, public_key TEXT, last_assertion_at INTEGER)");
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
  const NOTE = "Each row also carries ... last_assertion_at is the greatest server timestamp, in milliseconds, recorded for a citizen assertion";
  const rows = [
    { handle: "bearer", public_key: null, last_assertion_at: null },
    { handle: "keyed", public_key: "pk", last_assertion_at: 1800000000000 },
  ];
  const listBody = (over: Record<string, unknown>): string => JSON.stringify({ note: NOTE, citizens: rows, ...over });
  const cases: Array<[string, string, string]> = [
    ["list-good", `Test-CitizensServed (Read-JsonBody @{ Body = ${q(listBody({}))} })`, ""],
    ["list-nonote", `Test-CitizensServed (Read-JsonBody @{ Body = ${q(listBody({ note: "no wording" }))} })`, "does not carry the last_assertion_at wording"],
    ["list-nokey", `Test-CitizensServed (Read-JsonBody @{ Body = ${q(listBody({ citizens: [rows[0], { handle: "x", public_key: "pk" }] }))} })`, "citizen x has no last_assertion_at key"],
    ["list-secret-stamped", `Test-CitizensServed (Read-JsonBody @{ Body = ${q(listBody({ citizens: [{ handle: "b", public_key: null, last_assertion_at: 5 }] }))} })`, "has no public_key but serves last_assertion_at 5"],
    ["list-text", `Test-CitizensServed (Read-JsonBody @{ Body = ${q(listBody({ citizens: [{ handle: "k", public_key: "pk", last_assertion_at: "soon" }] }))} })`, "not a whole number"],
    ["list-empty", `Test-CitizensServed (Read-JsonBody @{ Body = ${q(listBody({ citizens: [] }))} })`, "no rows"],
    ["list-html", `Test-CitizensServed (Read-JsonBody @{ Body = '<html>' })`, "did not return JSON"],
    ["privacy-good", `Test-PrivacyServed ${q("x This lets readers observe recorded use of a seat's signing key, y")}`, ""],
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
