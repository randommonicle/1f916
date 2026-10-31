// scripts/deploy-model-call-retry.ps1 is WRITTEN AND NEVER RUN by the builder (no deploy, no wrangler, not in -DryRun and not in -Rehearse). It is proven here by what can be proven without running it: it parses under
// PowerShell's own parser, is ASCII with LF endings, has none of the repo's PowerShell traps, has the load-bearing step order (migration, catalogue check on BOTH tables, THEN the worker), the -Rehearse block
// touches the scratch database only, and the pure checks and the catalogue readers are RUN FOR REAL (the D1 reads through a stub `npx` that answers like wrangler's --json) against good and bad answers.
// Pattern: test/deploy-proposals-unknown-params-script.test.ts and test/deploy-council-script.test.ts.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parsePowerShellFile } from "./helpers/ps-parse.ts";

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
const SCRIPT_PATH = here("../scripts/deploy-model-call-retry.ps1");
const rawScript = readFileSync(SCRIPT_PATH, "utf8");
const script = rawScript.replace(/\r\n/g, "\n");
const code = script.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
const defs = script.slice(script.indexOf('$ErrorActionPreference = "Stop"'), script.indexOf("# END-OF-DEFINITIONS"));
const pinBlock = script.slice(script.indexOf("# BEGIN-PIN-CHECK"), script.indexOf("# END-PIN-CHECK"));
const rehearseBlock = script.slice(script.indexOf("# BEGIN-REHEARSE"), script.indexOf("# END-REHEARSE"));
const LIVE = "95a80c92f7b14d41ced3696517455393c5bb26ee";

function runPs(lines: string[]): { code: number | null; out: string } | null {
  const dir = mkdtempSync(join(tmpdir(), "deploy-model-call-retry-"));
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
  assert.equal(/\$[A-Za-z_][A-Za-z0-9_]*:/.test(code.replace(/\$\(/g, "")), false);
  for (const m of code.matchAll(/2>&1/g)) {
    const before = code.slice(0, m.index);
    assert.ok(before.lastIndexOf('$ErrorActionPreference = "Continue"') > before.lastIndexOf('$ErrorActionPreference = "Stop"'));
  }
  assert.equal(/\$\w+\s*\|\s*Where-Object[^\n]*-notmatch/.test(code), false);
});

test("the pins and names: v6 hash, the live base is the full sha of 95a80c92, the reviewed commit is a full sha, the allowlist is this script, its test and docs/, the database names are wrangler.jsonc's and the scratch database, the parameters", () => {
  assert.match(script, /^\$V6_HASH = "dc5f48213c29bcf844e0fbe7daf1bdb5416b3d57fbd06a8bd03f1061f34092b3"$/m);
  assert.match(script, /^\$LIVE_BASE_COMMIT = "95a80c92f7b14d41ced3696517455393c5bb26ee"$/m);
  assert.match(script, /^\$REVIEWED_COMMIT = "[0-9a-f]{40}"$/m);
  assert.match(script, /^\$ALLOWED_PATHS_AFTER_REVIEW = @\("scripts\/deploy-model-call-retry\.ps1", "test\/deploy-model-call-retry-script\.test\.ts", "docs\/"\)$/m);
  assert.match(script, /\[Parameter\(Mandatory = \$true\)\]\[string\]\$ExpectedCommit/);
  for (const p of ["DryRun", "Rehearse", "MigrationAlreadyApplied"]) assert.match(script, new RegExp(`\\[switch\\]\\$${p}`));
  const wrangler = readFileSync(here("../wrangler.jsonc"), "utf8");
  assert.match(wrangler, /"database_name": "commonhold"/);
  assert.match(script, /^\$PROD_DB = "commonhold"$/m);
  assert.match(script, /^\$SCRATCH_DB = "commonhold-migtest"$/m);
  assert.match(script, /^\$MIGRATION_PATH_EXPECTED = "migrations\/0022_model_retry\.sql"$/m);
});

test("step 0a STOPS on either placeholder or a malformed pin before ANY git, npm, wrangler or network command (the pin block is run for real), and the same block passes full shas", (t) => {
  const stubs = ["git", "npm", "npx", "curl.exe"].map((n) => `function ${n} { throw "${n} must not run in step 0a" }`);
  const harness = (live: string, reviewed: string): string[] => [
    "$ErrorActionPreference = 'Stop'",
    ...stubs,
    'function Stop-Here($msg) { Write-Host "[STOP] $msg"; exit 1 }',
    `$LIVE_BASE_COMMIT = "${live}"`,
    '$LIVE_BASE_PLACEHOLDER = "TO-BE-SET-BY-HUB-LIVE-BASE"',
    `$REVIEWED_COMMIT = "${reviewed}"`,
    '$REVIEWED_COMMIT_PLACEHOLDER = "TO-BE-SET-BY-HUB"',
    pinBlock,
    'Write-Host "[PASSED-PINS]"',
  ];
  const FULL = "0123456789abcdef0123456789abcdef01234567";
  const stopped = runPs(harness(LIVE, "TO-BE-SET-BY-HUB"));
  if (!stopped) return t.skip("no PowerShell available");
  assert.equal(stopped.code, 1);
  assert.match(stopped.out, /\[STOP\].*REVIEWED_COMMIT still holds the placeholder/);
  assert.match(runPs(harness("TO-BE-SET-BY-HUB-LIVE-BASE", FULL))!.out, /\[STOP\].*LIVE_BASE_COMMIT still holds the placeholder/);
  assert.match(runPs(harness(LIVE, "ABCDEF0123456789ABCDEF0123456789ABCDEF01"))!.out, /\[STOP\].*not 40 lower-case hex/);
  assert.match(runPs(harness("95a80c92", FULL))!.out, /\[STOP\].*LIVE_BASE_COMMIT.*not 40 lower-case hex/);
  const ok = runPs(harness(LIVE, FULL))!;
  assert.equal(ok.code, 0);
  assert.match(ok.out, /\[PASSED-PINS\]/);
});

test("ORDER: pins, git, reviewed source, rehearse, gates, live-before, prod catalogue read, dry-run exit, then migration, then the catalogue check on BOTH tables, THEN the one worker deploy, the poll and the ride", () => {
  const order = [
    "BEGIN-PIN-CHECK", "git fetch origin", "BEGIN-REVIEWED-SOURCE-CHECK", "BEGIN-REHEARSE", "BEGIN-GATES", 'Read-Attest "before the deploy"', "$migrationState = Get-RetryState $PROD_DB", "if ($DryRun)",
    "BEGIN-MIGRATION", "npx wrangler d1 execute $PROD_DB --remote --file $MIGRATION_PATH_EXPECTED", "Assert-RetryColumns $PROD_DB", "BEGIN-DEPLOY-AND-POLL", 'npx wrangler deploy --var "CODE_COMMIT:$headSha"',
    "Wait-NewWorker $headSha $versionId", 'Read-Attest "after the deploy"', 'Test-RunsServed $maintainerNow', 'Test-RunsServed $conciergeNow',
  ];
  let last = -1;
  for (const needle of order) {
    const i = script.indexOf(needle.startsWith("BEGIN-") ? "# " + needle : needle, last + 1);
    assert.ok(i > last, `${needle} comes after the previous step`);
    last = i;
  }
  // The migration and its catalogue check both sit BEFORE the first deploy command.
  const deployAt = code.indexOf('npx wrangler deploy --var "CODE_COMMIT:$headSha"');
  assert.ok(code.indexOf("npx wrangler d1 execute $PROD_DB --remote --file") < deployAt);
  assert.ok(code.indexOf("Assert-RetryColumns $PROD_DB") < deployAt);
  assert.equal((code.match(/\(npx wrangler deploy /g) ?? []).length, 1, "exactly one executed worker deploy (the other mentions are text in messages)");
  assert.equal(/Invoke-WebRequest|Invoke-RestMethod|-Method\s+Post/i.test(code), false);
  assert.equal(/-X\s+POST|--data/.test(code), false, "the ride sends no POST and no request body");
});

test("-Rehearse touches the scratch database ONLY: it names SCRATCH_DB, never PROD_DB, makes no HTTP read, no deploy and no test run, and leaves before the gates", () => {
  assert.ok(rehearseBlock.length > 200, "the rehearse block was found");
  assert.ok(rehearseBlock.includes("$SCRATCH_DB"));
  assert.equal(rehearseBlock.includes("$PROD_DB"), false);
  assert.equal(/\$BASE|curl|Get-Text|Get-Json|Read-Attest|wrangler deploy|npm /.test(rehearseBlock), false);
  assert.ok(rehearseBlock.includes("Get-RetryState $SCRATCH_DB") && rehearseBlock.includes("Assert-RetryColumns $SCRATCH_DB"));
  assert.ok(rehearseBlock.includes("--file $MIGRATION_PATH_EXPECTED") && rehearseBlock.includes("npx wrangler d1 execute $SCRATCH_DB --remote"));
  assert.ok(rehearseBlock.includes("if ($DryRun)") && rehearseBlock.indexOf("if ($DryRun)") < rehearseBlock.indexOf("--file"), "a dry rehearsal stops before it writes");
  assert.match(rehearseBlock, /exit 0\s*\n\}\s*$/, "the rehearse block ends by exiting, so the gates and the prod steps are never reached");
  // No write to the prod database name appears anywhere except the one prod apply, and a hard-coded 'commonhold ' database never does.
  assert.equal((code.match(/d1 execute commonhold\b(?!-)/g) ?? []).length, 0, "the prod name is only ever the variable");
});

test("the wrangler uses: the stamped deploy once, the two applies (scratch and prod) and the reads through Invoke-D1Read; nothing else", () => {
  const uses = [...code.matchAll(/(?:^[ \t]*|\()npx wrangler (d1 execute \$|deploy --var)/gm)].map((m) => m[1]);
  assert.equal(uses.filter((u) => u === "deploy --var").length, 1);
  assert.equal(uses.filter((u) => u === "d1 execute $").length, 3, "two applies and the one read function");
  assert.equal(uses.some((u) => !["deploy --var", "d1 execute $"].includes(u)), false, `only deploy and d1 execute: ${uses.join(", ")}`);
});

test("the checks name literals the checkout carries, and the migration is the two ADD COLUMNs the script verifies", () => {
  let n = 0;
  for (const m of code.matchAll(/Select-String -Path "([^"]+)" -Pattern ('[^']+'|"[^"]+")/g)) {
    const file = m[1];
    if (file === "wrangler.jsonc") continue;
    const lit = m[2].slice(1, -1);
    assert.ok(readFileSync(here(`../${file}`), "utf8").includes(lit), `${file} carries '${lit}'`);
    n++;
  }
  assert.ok(n >= 5, `checked ${n} literals`);
  const mig = readFileSync(here("../migrations/0022_model_retry.sql"), "utf8").split("\n").filter((l) => !l.startsWith("--")).join("\n");
  assert.match(script, /^\$RETRY_TABLES = @\("maintainer_runs", "concierge_runs"\)$/m);
  assert.match(script, /^\$RETRY_COLUMN = "model_retry"$/m);
  assert.match(script, /^\$RETRY_COLUMN_TYPE = "TEXT"$/m);
  assert.ok(mig.includes("ALTER TABLE maintainer_runs ADD COLUMN model_retry TEXT;") && mig.includes("ALTER TABLE concierge_runs ADD COLUMN model_retry TEXT;"));
});

test("the served-answer checks, run for real, pass rows that all carry model_retry and fail a missing key, no rows, a non-200 and a non-JSON body", (t) => {
  const fns = defs.slice(defs.indexOf("function Read-JsonBody"), defs.indexOf("# \"\" when the pragma rows"));
  const cap = (c: string, body: string): string => `@{ Code = ${q(c)}; Type = 'application/json'; Body = ${q(body)} }`;
  const good = JSON.stringify({ runs: [{ id: 2, model_retry: null }, { id: 1, model_retry: "recovered: x" }] });
  const cases: Array<[string, string, string]> = [
    ["good", cap("200", good), ""],
    ["null-is-a-value", cap("200", JSON.stringify({ runs: [{ id: 1, model_retry: null }] })), ""],
    ["missing-key-on-one-row", cap("200", JSON.stringify({ runs: [{ id: 2, model_retry: null }, { id: 1 }] })), "no model_retry key"],
    ["no-rows", cap("200", JSON.stringify({ runs: [] })), "no run rows"],
    ["500", cap("500", good), "expected 200"],
    ["html", cap("200", "<html>x</html>"), "did not return JSON"],
    ["case-sensitive-key", cap("200", JSON.stringify({ runs: [{ id: 1, Model_Retry: null }] })), "no model_retry key"],
  ];
  const run = runPs(["$ErrorActionPreference = 'Stop'", fns, ...cases.map(([name, c]) => `Write-Host ("RESULT ${name} [" + (Test-RunsServed ${c} 'GET /x') + "]")`)]);
  if (!run) return t.skip("no PowerShell available");
  for (const [name, , expect] of cases) {
    const m = new RegExp(`RESULT ${name} \\[(.*)\\]`).exec(run.out);
    assert.ok(m, `${name} produced a result: ${run.out}`);
    if (expect === "") assert.equal(m![1], "", name);
    else assert.ok(m![1].includes(expect), `${name}: '${m![1]}' mentions '${expect}'`);
  }
});

// A stub `npx` that answers like `wrangler d1 execute <db> --remote --json --command <sql>`: tables = how many of the two run tables exist; cols = the declared type of model_retry per table ('' = no column).
function catalogueHarness(db: string, tables: number, cols: { maintainer_runs: string; concierge_runs: string }, fn: string): string[] {
  return [
    "$ErrorActionPreference = 'Stop'",
    "$global:LASTEXITCODE = 0",
    defs,
    `$SCEN_TABLES = ${tables}`,
    `$SCEN_COLS = @{ maintainer_runs = ${q(cols.maintainer_runs)}; concierge_runs = ${q(cols.concierge_runs)} }`,
    "function npx {",
    "  $global:LASTEXITCODE = 0",
    "  $sql = [string]$args[-1]",
    "  if ($sql -like '*sqlite_master*') {",
    "    $names = @('maintainer_runs', 'concierge_runs') | Select-Object -First $SCEN_TABLES",
    "    $rows = ($names | ForEach-Object { '{\"name\":\"' + $_ + '\"}' }) -join ','",
    "    return ('[{\"results\":[' + $rows + '],\"success\":true}]')",
    "  }",
    "  $t = [regex]::Match($sql, \"pragma_table_info\\('([a-z_]+)'\\)\").Groups[1].Value",
    "  if ($SCEN_COLS[$t] -eq '') { return '[{\"results\":[],\"success\":true}]' }",
    "  return ('[{\"results\":[{\"name\":\"model_retry\",\"type\":\"' + $SCEN_COLS[$t] + '\"}],\"success\":true}]')",
    "}",
    `$db = ${q(db)}`,
    fn,
  ];
}

test("Get-RetryState and Assert-RetryColumns, run for real over a stub wrangler: absent, applied, half-applied, tables missing, and a wrong column type", (t) => {
  const state = (tables: number, a: string, b: string): ReturnType<typeof runPs> => runPs(catalogueHarness("commonhold-migtest", tables, { maintainer_runs: a, concierge_runs: b }, 'Write-Host ("STATE " + (Get-RetryState $db))'));
  const absent = state(2, "", "");
  if (!absent) return t.skip("no PowerShell available");
  assert.match(absent.out, /STATE absent/, absent.out);
  assert.match(state(2, "TEXT", "TEXT")!.out, /STATE applied/);
  const half = state(2, "TEXT", "")!;
  assert.equal(half.code, 1);
  assert.match(half.out, /\[STOP\].*half-applied on commonhold-migtest \(model_retry on 1 of 2 tables\)/);
  const missing = state(1, "", "")!;
  assert.equal(missing.code, 1);
  assert.match(missing.out, /\[STOP\].*not both on commonhold-migtest \(found 1 of 2\)/);

  const verify = (a: string, b: string) => runPs(catalogueHarness("commonhold", 2, { maintainer_runs: a, concierge_runs: b }, 'Assert-RetryColumns $db; Write-Host "VERIFIED"'))!;
  assert.match(verify("TEXT", "TEXT").out, /VERIFIED/);
  const oneMissing = verify("TEXT", "");
  assert.equal(oneMissing.code, 1);
  assert.match(oneMissing.out, /\[STOP\].*concierge_runs has 0 model_retry column rows/);
  const otherMissing = verify("", "TEXT");
  assert.match(otherMissing.out, /\[STOP\].*maintainer_runs has 0 model_retry column rows/);
  const wrongType = verify("TEXT", "INTEGER");
  assert.equal(wrongType.code, 1);
  assert.match(wrongType.out, /\[STOP\].*concierge_runs\.model_retry has type 'INTEGER', expected TEXT/);
  const lower = verify("text", "TEXT");
  assert.match(lower.out, /\[STOP\].*maintainer_runs\.model_retry has type 'text'/, "the type comparison is case-sensitive");
});

test("the CODEX-style guards: the code identity check is run for real, HEAD and a clean tree are re-read just before the one deploy, and the ride re-checks identity after the poll", (t) => {
  const step0 = code.indexOf("$unreviewed = @(Get-DisallowedPaths $afterReview)");
  const reread = code.indexOf("$headNow = (git rev-parse HEAD).Trim()");
  const dirtyNow = code.indexOf("$dirtyNow = @(git status --porcelain)");
  const deploy = code.indexOf('npx wrangler deploy --var "CODE_COMMIT:$headSha"');
  const poll = code.indexOf("Wait-NewWorker $headSha $versionId $POLL_TRIES");
  const rideId = code.indexOf("Test-CodeIdentityServed $attAfter.code $headSha $versionId");
  for (const [name, at] of [["step0", step0], ["reread", reread], ["dirtyNow", dirtyNow], ["deploy", deploy], ["poll", poll], ["rideId", rideId]] as const) assert.ok(at >= 0, `anchor ${name} found`);
  assert.ok(reread > step0 && reread < deploy && dirtyNow > reread && dirtyNow < deploy);
  assert.ok(rideId > poll);
  assert.ok(code.includes("$headNow -cne $headSha") && code.includes("$dirtyNow.Count -gt 0) { Stop-Here"));

  const fn = defs.slice(defs.indexOf("function Test-CodeIdentityServed"), defs.indexOf("# The JSON body of a captured GET answer"));
  const A = "a".repeat(40), B = "b".repeat(40), VA = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", VB = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  const c = (commit: string, v: string): string => `([pscustomobject]@{ commit_status = 'stamped'; commit = '${commit}'; version_status = 'available'; version_id = '${v}' })`;
  const run = runPs([
    "$ErrorActionPreference = 'Stop'",
    fn,
    `Write-Host ("RESULT good [" + (Test-CodeIdentityServed ${c(A, VA)} '${A}' '${VA}') + "]")`,
    `Write-Host ("RESULT commit [" + (Test-CodeIdentityServed ${c(B, VA)} '${A}' '${VA}') + "]")`,
    `Write-Host ("RESULT version [" + (Test-CodeIdentityServed ${c(A, VB)} '${A}' '${VA}') + "]")`,
  ]);
  if (!run) return t.skip("no PowerShell available");
  assert.match(run.out, /RESULT good \[\]/, run.out);
  assert.match(run.out, /RESULT commit \[code\.commit is 'b{40}'/, run.out);
  assert.match(run.out, /RESULT version \[code\.version_id is 'b{8}-/, run.out);
});
