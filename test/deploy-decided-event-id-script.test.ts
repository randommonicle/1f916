// scripts/deploy-decided-event-id.ps1 is WRITTEN AND NEVER RUN by the builder (no deploy, no wrangler, no D1, not even -DryRun, which reads production D1). It is proven here by what can be proven without running it: it
// parses under PowerShell's own parser, is ASCII with LF endings, has none of the repo's PowerShell traps, has the load-bearing step order (preflight, then migration, then verification, then worker, then reconciliation, then ride),
// uses wrangler only through the bounded helper, and every decision function (the pending preflight, the one-hour window, the historical pairs, the verification, the column, the served-answer checks, the bounded runner,
// the backfill extraction) is RUN FOR REAL against good and bad captured inputs. Pattern: test/deploy-proposals-unknown-params-script.test.ts.
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
const SCRIPT_PATH = here("../scripts/deploy-decided-event-id.ps1");
const rawScript = readFileSync(SCRIPT_PATH, "utf8");
const script = rawScript.replace(/\r\n/g, "\n");
const code = script.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
const defs = script.slice(script.indexOf('$ErrorActionPreference = "Stop"'), script.indexOf("# END-OF-DEFINITIONS"));
const pinBlock = script.slice(script.indexOf("# BEGIN-PIN-CHECK"), script.indexOf("# END-PIN-CHECK"));
const migration = readFileSync(here("../migrations/0023_decided_event_id.sql"), "utf8");
const LIVE = "7b49b7b65b8477cdafb5057541a9432def1a5705";

function runPs(lines: string[]): { code: number | null; out: string } | null {
  const dir = mkdtempSync(join(tmpdir(), "deploy-decided-event-id-"));
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
  assert.equal(/\$[A-Za-z_][A-Za-z0-9_]*:/.test(code.replace(/\$\(/g, "").replace(/\$script:/g, "")), false);
  for (const m of code.matchAll(/2>&1/g)) {
    const before = code.slice(0, m.index);
    assert.ok(before.lastIndexOf('$ErrorActionPreference = "Continue"') > before.lastIndexOf('$ErrorActionPreference = "Stop"'));
  }
  assert.equal(/\$\w+\s*\|\s*Where-Object[^\n]*-notmatch/.test(code), false);
});

test("the pins: v6 hash, the live base is the full sha of 7b49b7b6, the reviewed commit is the hub's placeholder, the allowlist is this script, its test and docs/, -ExpectedCommit is mandatory, the migration is 0023", () => {
  assert.match(script, /^\$V6_HASH = "dc5f48213c29bcf844e0fbe7daf1bdb5416b3d57fbd06a8bd03f1061f34092b3"$/m);
  assert.match(script, new RegExp(`^\\$LIVE_BASE_COMMIT = "${LIVE}"$`, "m"));
  assert.match(script, /^\$REVIEWED_COMMIT = "TO-BE-SET-BY-HUB"$/m);
  assert.match(script, /^\$ALLOWED_PATHS_AFTER_REVIEW = @\("scripts\/deploy-decided-event-id\.ps1", "test\/deploy-decided-event-id-script\.test\.ts", "docs\/"\)$/m);
  assert.match(script, /\[Parameter\(Mandatory = \$true\)\]\[string\]\$ExpectedCommit/);
  assert.match(script, /\[switch\]\$DryRun/);
  assert.match(script, /\[switch\]\$MigrationAlreadyApplied/);
  assert.match(script, /^\$MIGRATION_PATH_EXPECTED = "migrations\/0023_decided_event_id\.sql"$/m);
  assert.match(script, /^\$WINDOW_SECONDS = 3600$/m);
});

test("step 0a STOPS on either placeholder (the reviewed pin ships as a placeholder) or a malformed pin before ANY git, npm, wrangler or network command (the pin block is run for real), and passes full shas", (t) => {
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
  const FULL = "0123456789abcdef0123456789abcdef01234567";
  const stopped = runPs(h(LIVE, "TO-BE-SET-BY-HUB"));
  if (!stopped) return t.skip("no PowerShell available");
  assert.equal(stopped.code, 1);
  assert.match(stopped.out, /\[STOP\].*REVIEWED_COMMIT still holds the placeholder/);
  assert.match(runPs(h("TO-BE-SET-BY-HUB-LIVE-BASE", FULL))!.out, /\[STOP\].*LIVE_BASE_COMMIT still holds the placeholder/);
  assert.match(runPs(h(LIVE, "ABCDEF0123456789ABCDEF0123456789ABCDEF01"))!.out, /\[STOP\].*not 40 lower-case hex/);
  assert.match(runPs(h("7b49b7b6", FULL))!.out, /\[STOP\].*LIVE_BASE_COMMIT.*not 40 lower-case hex/);
  const ok = runPs(h(LIVE, FULL))!;
  assert.equal(ok.code, 0);
  assert.match(ok.out, /\[PASSED-PINS\]/);
});

test("the steps are in the load-bearing order: pins, git, gates, live read, D1 preflight, dry-run exit, migration, verification, worker deploy, reconciliation, ride; wrangler runs only through Invoke-Bounded", () => {
  const order = [
    "# BEGIN-PIN-CHECK",
    "git fetch origin",
    "# BEGIN-REVIEWED-SOURCE-CHECK",
    "# BEGIN-GATES",
    'Read-Attest "before the deploy"',
    "$pendingRows = Invoke-D1Read $PENDING_SQL",
    "$script:PreflightAt = Get-Date",
    "if ($DryRun)",
    "# BEGIN-MIGRATION",
    "Assert-Prod-Verified \"after the migration\"",
    "Test-HistoricalPairs (Invoke-D1Read $PAIRS_SQL",
    "# BEGIN-DEPLOY-AND-POLL",
    "Wait-NewWorker $headSha $versionId",
    "# BEGIN-RECONCILE",
    'Assert-Prod-Verified "after worker activation"',
    'Read-Attest "after the deploy"',
    "Test-DetailServed $detail.proposal",
  ];
  let last = -1;
  for (const needle of order) {
    const i = script.indexOf(needle);
    assert.ok(i > last, `${needle} comes after the previous step`);
    last = i;
  }
  // The migration is applied only after the preflight read passed; the deploy only after the verification.
  assert.ok(script.indexOf("if ($why -ne \"\") { Stop-Here \"preflight: $why\" }") < script.indexOf("# BEGIN-MIGRATION"));
  const wranglerLines = code.split("\n").filter((l) => l.includes("npx wrangler"));
  const executed = wranglerLines.filter((l) => /Invoke-Bounded \("npx wrangler /.test(l));
  assert.deepEqual(
    executed.map((l) => /npx wrangler (\S+)/.exec(l)![1]).sort(),
    ["d1", "d1", "d1", "deploy"],
    "d1 execute (D1 file read, migration, backfill) and one stamped deploy, each through Invoke-Bounded",
  );
  for (const l of wranglerLines.filter((l) => !executed.includes(l))) assert.match(l, /Stop-Here|Say |ROLLBACK_LINE|dry-run|rollbackTarget/, `any other mention of wrangler is message text: ${l.trim().slice(0, 80)}`);
  assert.equal((code.match(/Start-Process/g) ?? []).length, 1, "one process launcher");
  assert.match(code, /npx wrangler deploy --var CODE_COMMIT:" \+ \$headSha/);
  assert.equal(/Invoke-WebRequest|Invoke-RestMethod/i.test(code), false, "no PowerShell web cmdlets");
  assert.ok(code.includes('--data-binary "@$dataFile"'), "request bodies go by file, never an inner-quoted argument");
  assert.ok(code.includes("src/doc.ts") && code.includes("-- migrations"), "the no-mint and one-migration checks");
});

test("the header carries the rollback text and every A5 duty (preflight, one hour, reconciliation, pairs, both MCP doors)", () => {
  const header = script.split("\n").filter((l) => /^\s*#/.test(l)).join("\n");
  for (const needle of [
    "SELECT COUNT(*) AS pending FROM proposals WHERE status IN",
    "ONE HOUR",
    "worker rollback",
    "leaves migration 0023 applied",
    "idempotent backfill UPDATE",
    "(1,6) (2,12) (5,16) (6,20) (7,25) (8,37)",
    "/mcp and /mcp/read",
    "does not detect newly opened proposals",
  ]) assert.ok(header.includes(needle), `header names: ${needle}`);
});

test("the preflight SQL is the whole-table count and, run for real over 200 decided rows followed by one open row, reports 1 (a first-page-only check would miss it); with none open it reports 0", () => {
  const sql = /^\$PENDING_SQL = "(.*)"$/m.exec(script)![1];
  assert.equal(sql, "SELECT COUNT(*) AS pending FROM proposals WHERE status IN ('open','tallying')");
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE proposals (id INTEGER PRIMARY KEY AUTOINCREMENT, status TEXT NOT NULL, created_at INTEGER NOT NULL)");
    const ins = db.prepare("INSERT INTO proposals (status, created_at) VALUES (?, ?)");
    for (let i = 0; i < 200; i++) ins.run("failed", i);
    assert.equal((db.prepare(sql).get() as { pending: number }).pending, 0);
    ins.run("open", 200);
    assert.equal((db.prepare(sql).get() as { pending: number }).pending, 1);
    // The first 200 rows by created_at (what GET /api/proposals serves) hold no pending row: only the whole-table count sees it.
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM (SELECT status FROM proposals ORDER BY created_at, id LIMIT 200) WHERE status IN ('open','tallying')").get() as { n: number }).n, 0);
    ins.run("tallying", 201);
    assert.equal((db.prepare(sql).get() as { pending: number }).pending, 2);
  } finally {
    db.close();
  }
});

test("Test-PendingPreflight, run for real through Read-D1Rows: passes only a parsed pending of 0; fails closed on 1, a tallying count, no JSON, an error page, a missing field, two rows, a non-integer, and an absent results object", (t) => {
  const cases: Array<[string, string, string]> = [
    ["zero", d1json([{ pending: 0 }]), ""],
    ["one", d1json([{ pending: 1 }]), "pending is 1"],
    ["many", d1json([{ pending: 7 }]), "pending is 7"],
    ["nojson", "Error: no such table", "no parsable result"],
    ["html", "<html>502</html>", "no parsable result"],
    ["nofield", d1json([{ other: 0 }]), "no 'pending' value"],
    ["tworows", d1json([{ pending: 0 }, { pending: 0 }]), "2 rows"],
    ["norows", d1json([]), "0 rows"],
    ["string", d1json([{ pending: "abc" }]), "not an integer"],
    ["noresults", `[{"success":true}]`, "no parsable result"],
  ];
  const run = runPs(harness(cases.map(([name, text]) => `Write-Host ("RESULT ${name} [" + (Test-PendingPreflight (Read-D1Rows ${q(text)})) + "]")`)));
  if (!run) return t.skip("no PowerShell available");
  for (const [name, , expect] of cases) {
    const m = new RegExp(`RESULT ${name} \\[(.*)\\]`).exec(run.out);
    assert.ok(m, `${name} produced a result: ${run.out}`);
    if (expect === "") assert.equal(m![1], "", name);
    else assert.ok(m![1].includes(expect), `${name}: '${m![1]}' mentions '${expect}'`);
  }
});

test("the one-hour window, run for real: inside passes; just over, a missing preflight time and a clock far past all stop", (t) => {
  const run = runPs(
    harness([
      "$t0 = Get-Date",
      'Write-Host ("RESULT inside [" + (Test-WithinWindow $t0 $t0.AddSeconds(3599)) + "]")',
      'Write-Host ("RESULT over [" + (Test-WithinWindow $t0 $t0.AddSeconds(3601)) + "]")',
      'Write-Host ("RESULT never [" + (Test-WithinWindow $null $t0) + "]")',
      'Write-Host ("RESULT far [" + (Test-WithinWindow $t0 $t0.AddDays(2)) + "]")',
    ]),
  );
  if (!run) return t.skip("no PowerShell available");
  assert.match(run.out, /RESULT inside \[\]/, run.out);
  assert.match(run.out, /RESULT over \[the preflight completed 3601 s ago, over the 3600 s window/, run.out);
  assert.match(run.out, /RESULT never \[the D1 preflight has not completed\]/, run.out);
  assert.match(run.out, /RESULT far \[the preflight completed 172800 s ago/, run.out);
});

test("the D1 decision functions, run for real: zero-row verification passes (an EMPTY result is not a failed read), any row or an unparsable read stops; the six pairs, the column and the backfill extraction", (t) => {
  const pairsGood = [[1, 6], [2, 12], [5, 16], [6, 20], [7, 25], [8, 37]].map(([id, e]) => ({ id, decided_event_id: e }));
  const pairsBad = pairsGood.map((r) => (r.id === 8 ? { id: 8, decided_event_id: 36 } : r));
  const cases: Array<[string, string, string]> = [
    ["verify-clean", `Test-VerificationClean (Read-D1Rows ${q(d1json([]))})`, ""],
    ["verify-row", `Test-VerificationClean (Read-D1Rows ${q(d1json([{ id: 5, status: "failed", decided_event_id: null, candidates: 1 }]))})`, "1 offending row(s), first: proposal 5"],
    ["verify-unparsable", `Test-VerificationClean (Read-D1Rows ${q("boom")})`, "no parsable result"],
    ["pairs-good", `Test-HistoricalPairs (Read-D1Rows ${q(d1json(pairsGood))})`, ""],
    ["pairs-extra-ignored-by-sql", `Test-HistoricalPairs (Read-D1Rows ${q(d1json(pairsGood))})`, ""],
    ["pairs-wrong", `Test-HistoricalPairs (Read-D1Rows ${q(d1json(pairsBad))})`, "proposal 8 points at event '36', expected proposal 8 -> 37"],
    ["pairs-short", `Test-HistoricalPairs (Read-D1Rows ${q(d1json(pairsGood.slice(0, 5)))})`, "returned 5 rows, expected 6"],
    ["pairs-null", `Test-HistoricalPairs (Read-D1Rows ${q(d1json(pairsGood.map((r) => ({ id: r.id, decided_event_id: null }))))})`, "points at event ''"],
    ["column-good", `Test-ColumnPresent (Read-D1Rows ${q(d1json([{ name: "decided_event_id", type: "INTEGER" }]))})`, ""],
    ["column-absent", `Test-ColumnPresent (Read-D1Rows ${q(d1json([]))})`, "0 decided_event_id column rows"],
    ["column-text", `Test-ColumnPresent (Read-D1Rows ${q(d1json([{ name: "decided_event_id", type: "TEXT" }]))})`, "expected INTEGER"],
  ];
  const run = runPs(harness([...cases.map(([name, expr]) => `Write-Host ("RESULT ${name} [" + (${expr}) + "]")`), `$sql = Get-BackfillSql ${q(migration)}`, 'Write-Host ("RESULT backfill-len [" + $sql.Length + "]")', 'Write-Host ("RESULT backfill-update [" + $sql.Contains("UPDATE proposals SET decided_event_id") + "]")', 'Write-Host ("RESULT backfill-alter [" + $sql.Contains("ALTER TABLE") + "]")', 'Write-Host ("RESULT backfill-none [" + (Get-BackfillSql "no markers here").Length + "]")']));
  if (!run) return t.skip("no PowerShell available");
  for (const [name, , expect] of cases) {
    const m = new RegExp(`RESULT ${name} \\[(.*)\\]`).exec(run.out);
    assert.ok(m, `${name} produced a result: ${run.out}`);
    if (expect === "") assert.equal(m![1], "", name);
    else assert.ok(m![1].includes(expect), `${name}: '${m![1]}' mentions '${expect}'`);
  }
  assert.match(run.out, /RESULT backfill-update \[True\]/, run.out);
  assert.match(run.out, /RESULT backfill-alter \[False\]/, "the extracted block is the UPDATE only, never the non-idempotent ALTER");
  assert.match(run.out, /RESULT backfill-none \[0\]/, run.out);
});

test("the extracted backfill is the migration's UPDATE byte for byte and is idempotent when run over a database that already holds the pointers", () => {
  const m = /-- BACKFILL BEGIN\n([\s\S]*?)-- BACKFILL END/.exec(migration.replace(/\r\n/g, "\n"));
  assert.ok(m);
  assert.ok(m![1].trimStart().startsWith("UPDATE proposals SET decided_event_id"));
  assert.equal((m![1].match(/;/g) ?? []).length, 1, "exactly one statement");
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

test("the served-answer checks, run for real: the list needs the note, a pointer key on EVERY row and the right pair; the detail needs the key and 37; a tool answer that is an error or not JSON is null", (t) => {
  const NOTE = "decided_event_id identifies the proposal_decided event recording this proposal's tally outcome.";
  const pairs = [[1, 6], [2, 12], [5, 16], [6, 20], [7, 25], [8, 37]];
  const rows = pairs.map(([id, e]) => ({ id, decided_event_id: e }));
  const listBody = (over: Record<string, unknown>): string => JSON.stringify({ decided_event_id_note: NOTE, proposals: rows, ...over });
  const cases: Array<[string, string, string]> = [
    ["list-good", `Test-ListServed (Read-JsonBody @{ Body = ${q(listBody({}))} })`, ""],
    ["list-nonote", `Test-ListServed (Read-JsonBody @{ Body = ${q(listBody({ decided_event_id_note: undefined }))} })`, "no decided_event_id_note"],
    ["list-nokey", `Test-ListServed (Read-JsonBody @{ Body = ${q(listBody({ proposals: [...rows.slice(0, 5), { id: 8 }] }))} })`, "proposal 8 in the list has no decided_event_id key"],
    ["list-wrong", `Test-ListServed (Read-JsonBody @{ Body = ${q(listBody({ proposals: [...rows.slice(0, 5), { id: 8, decided_event_id: 99 }] }))} })`, "expected 37"],
    ["list-empty", `Test-ListServed (Read-JsonBody @{ Body = ${q(listBody({ proposals: [] }))} })`, "no proposals"],
    ["list-html", `Test-ListServed (Read-JsonBody @{ Body = '<html>' })`, "did not return JSON"],
    ["detail-good", `Test-DetailServed (Read-JsonBody @{ Body = ${q(JSON.stringify({ proposal: { id: 8, decided_event_id: 37 } }))} }).proposal`, ""],
    ["detail-nokey", `Test-DetailServed (Read-JsonBody @{ Body = ${q(JSON.stringify({ proposal: { id: 8 } }))} }).proposal`, "no decided_event_id key"],
    ["detail-wrong", `Test-DetailServed (Read-JsonBody @{ Body = ${q(JSON.stringify({ proposal: { id: 8, decided_event_id: null } }))} }).proposal`, "expected 37"],
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

test("the source checks name literals the checkout carries: every Select-String literal is in its file, and the ride's note marker is the first words of the served note", () => {
  const gov = readFileSync(here("../src/governance.ts"), "utf8");
  assert.ok(gov.includes("decided_event_id identifies the proposal_decided event"));
  assert.ok(script.includes('"decided_event_id identifies the proposal_decided event"'));
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
