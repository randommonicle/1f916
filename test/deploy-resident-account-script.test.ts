// scripts/deploy-resident-account.ps1 is WRITTEN AND NEVER RUN by the builder (no deploy, no wrangler, no D1, not even -DryRun, which reads production D1). It is proven here by what can be proven without running it: it parses
// under PowerShell's own parser, is ASCII with LF endings, has none of the repo's PowerShell traps, ships with the reviewed pin as a placeholder and STOPS on it before any git, npm, wrangler or network command, refuses a real
// run without -RehearsalPassed, STOPS unless the privacy date is the run's UTC date, has the load-bearing step order (first production read, then migration, then verification, then worker, then the second verification, then ride),
// uses wrangler only through the bounded helper, signs nothing, and every decision function (the window, the catalogue, the other-objects snapshot, the served-answer checks, the template check) is RUN FOR REAL against good and bad
// inputs, with the catalogue SQL run over a real SQLite database built from the real migration. The key gates are proven able to FAIL by mutating a copy of the script and seeing the harness answer flip.
// Pattern: test/deploy-last-assertion-at-script.test.ts and test/deploy-council-flag-script.test.ts.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parsePowerShellFile } from "./helpers/ps-parse.ts";
import { createLocalD1, seedCitizens, guestEnv, call } from "./helpers/guest.ts";
import { handleSkillMd } from "../src/discovery.ts";
import { SKILL_VERSION } from "../src/inbox.ts";
import { TOOLS } from "../src/mcp.ts";

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
const SCRIPT_PATH = here("../scripts/deploy-resident-account.ps1");
const rawScript = readFileSync(SCRIPT_PATH, "utf8");
const script = rawScript.replace(/\r\n/g, "\n");
const code = script.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
const verifySql = readFileSync(here("../scripts/verify-resident-account.sql"), "utf8").replace(/\r\n/g, "\n");
const migrationSql = readFileSync(here("../migrations/0026_resident_accounts.sql"), "utf8");
const LIVE = "9e9bb20a5913bfbb030eca5d563e0da5a4ea41c7";
const FULL = "0123456789abcdef0123456789abcdef01234567";
const BASE = "https://commonhold.randommonicle.workers.dev";

const between = (s: string, from: string, to: string): string => s.slice(s.indexOf(from), s.indexOf(to));
const defsOf = (s: string): string => between(s, '$ErrorActionPreference = "Stop"', "# END-OF-DEFINITIONS");
const defs = defsOf(script);

function runPs(lines: string[]): { code: number | null; out: string } | null {
  const dir = mkdtempSync(join(tmpdir(), "deploy-resident-account-"));
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
// Runs `d` (definitions only, nothing touches git or the network) then the given statements; each prints RESULT <name> [<value>].
function harness(statements: string[], d: string = defs): string[] {
  return ["$ErrorActionPreference = 'Stop'", "$script:PreflightAt = $null", d, ...statements];
}
const d1json = (rows: unknown[]): string => `[{"results":${JSON.stringify(rows)},"success":true,"meta":{}}]`;
const results = (out: string): Map<string, string> => new Map([...out.matchAll(/RESULT (\S+) \[(.*)\]/g)].map((m) => [m[1]!, m[2]!]));

// The five catalogue rows the real migration produces, read through the real verify SQL over node:sqlite.
function realCatalogue(): Array<{ kind: string; name: string; detail: string }> {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(migrationSql);
    return db.prepare(verifySql).all() as Array<{ kind: string; name: string; detail: string }>;
  } finally {
    db.close();
  }
}

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

test("the pins: v6 hash, the live base is the full sha of 9e9bb20a, the reviewed commit is 6c6e032c (set by the hub), the allowlist covers the scripts, the verify SQL, their tests and docs/, -ExpectedCommit is mandatory, -RehearsalPassed exists, ONE migration (0026)", () => {
  assert.match(script, /^\$V6_HASH = "dc5f48213c29bcf844e0fbe7daf1bdb5416b3d57fbd06a8bd03f1061f34092b3"$/m);
  assert.match(script, /^\$LIVE_BASE_COMMIT = "9e9bb20a5913bfbb030eca5d563e0da5a4ea41c7"$/m);
  assert.match(script, /^\$REVIEWED_COMMIT = "6c6e032c5d07acba2b347bb98b5e0e159997b1c5"$/m);
  assert.match(script, /^\$REVIEWED_COMMIT_PLACEHOLDER = "TO-BE-SET-BY-HUB"$/m);
  assert.match(
    script,
    /^\$ALLOWED_PATHS_AFTER_REVIEW = @\("scripts\/deploy-resident-account\.ps1", "scripts\/rehearse-resident-account\.ps1", "scripts\/verify-resident-account\.sql", "test\/deploy-resident-account-script\.test\.ts", "test\/rehearse-resident-account-script\.test\.ts", "docs\/"\)$/m,
  );
  assert.match(script, /\[Parameter\(Mandatory = \$true\)\]\[string\]\$ExpectedCommit/);
  assert.match(script, /\[switch\]\$DryRun/);
  assert.match(script, /\[switch\]\$RehearsalPassed/);
  assert.match(script, /^\$MIGRATION_PATH = "migrations\/0026_resident_accounts\.sql"$/m);
  assert.match(script, /^\$VERIFY_SQL_PATH = "scripts\/verify-resident-account\.sql"$/m);
  assert.match(script, /^\$WINDOW_SECONDS = 3600$/m);
  assert.match(script, /^\$PROD_DB = "commonhold"$/m);
  const lines = readFileSync(here("../scripts/rehearse-resident-account.ps1"), "utf8");
  assert.ok(!/\$PROD_DB|"commonhold"/.test(lines), "the rehearsal script never names the production database");
});

test("the ride's pins are the code's own: the skill sha-256 and version, the tool counts, the roster and privacy markers (mutant: any served text or tool edit turns this red until the hub re-pins)", async () => {
  const d1 = createLocalD1();
  try {
    seedCitizens(d1);
    const env = { ...guestEnv(d1), REGISTRATION_MODE: "open" };
    const skill = await (await handleSkillMd(new Request(`${BASE}/skill.md`), env)).text();
    assert.equal(createHash("sha256").update(Buffer.from(skill, "utf8")).digest("hex"), /^\$SKILL_SHA256 = "([0-9a-f]{64})"$/m.exec(script)![1], "the pinned sha is what the code serves at the live origin");
    assert.equal(/^\$SKILL_VERSION_LINE = "(version: [0-9.]+)"$/m.exec(script)![1], `version: ${SKILL_VERSION}`);
    assert.ok(skill.includes(`version: ${SKILL_VERSION}`));
    assert.match(script, new RegExp(`^\\$TOOL_COUNT = ${TOOLS.length}$`, "m"));
    assert.match(script, /^\$READ_TOOL_COUNT = 13$/m);
    const readCount = ((await call(env, "POST", "/mcp/read", { jsonrpc: "2.0", id: 1, method: "tools/list" })).body.result.tools as unknown[]).length;
    assert.equal(readCount, 13);
    const privacy = (await call(env, "GET", "/privacy")).body._text as string;
    const markers = [.../^\$PRIVACY_MARKERS = @\((.*)\)$/m.exec(script)![1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    assert.equal(markers.length, 4);
    for (const m of markers) assert.ok(privacy.includes(m), `privacy carries: ${m}`);
    const roster = (await call(env, "GET", "/api/residents")).body;
    assert.ok(String(roster.note).includes(/^\$ROSTER_MARKER = "([^"]+)"$/m.exec(script)![1]!));
    assert.equal(roster.total, 0);
    const official = (await call(env, "GET", "/api/official")).body;
    assert.ok(String(official.residents.counts_note).includes("counted in both"));
    for (const f of ["count", "by_key", "by_account"]) assert.ok(f in official.residents);
    assert.equal((await call(env, "GET", "/api/resident/1")).status, 404);
  } finally {
    d1.close();
  }
});

test("step 0a STOPS on either placeholder (as shipped) or a malformed pin before ANY git, npm, wrangler or network command (the pin block is run for real), and passes full shas; the reviewed pin ships as the placeholder", (t) => {
  const pinBlock = between(script, "# BEGIN-PIN-CHECK", "# END-PIN-CHECK");
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
  const asShipped = runPs(h(LIVE, "TO-BE-SET-BY-HUB"));
  if (!asShipped) return t.skip("no PowerShell available");
  assert.equal(asShipped.code, 1);
  assert.match(asShipped.out, /\[STOP\].*REVIEWED_COMMIT still holds the placeholder/, "as shipped it stops on the reviewed pin");
  assert.match(runPs(h("TO-BE-SET-BY-HUB-LIVE-BASE", FULL))!.out, /\[STOP\].*LIVE_BASE_COMMIT still holds the placeholder/);
  assert.match(runPs(h(LIVE, "ABCDEF0123456789ABCDEF0123456789ABCDEF01"))!.out, /\[STOP\].*not 40 lower-case hex/);
  assert.match(runPs(h("9e9bb20a", FULL))!.out, /\[STOP\].*LIVE_BASE_COMMIT.*not 40 lower-case hex/);
  const ok = runPs(h(LIVE, FULL))!;
  assert.equal(ok.code, 0);
  assert.match(ok.out, /\[PASSED-PINS\]/);
});

test("a real run without -RehearsalPassed STOPS before anything else; -RehearsalPassed or -DryRun lets it through (the block is run for real)", (t) => {
  const rehearsalBlock = between(script, "# BEGIN-REHEARSAL-CHECK", "# END-REHEARSAL-CHECK");
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
  assert.match(none.out, /scripts\/rehearse-resident-account\.ps1/);
  assert.match(runPs(h("R"))!.out, /\[PASSED-REHEARSAL\]/);
  assert.match(runPs(h("D"))!.out, /\[PASSED-REHEARSAL\]/);
  assert.ok(script.indexOf("# BEGIN-REHEARSAL-CHECK") > script.indexOf("# END-PIN-CHECK") && script.indexOf("# END-REHEARSAL-CHECK") < script.indexOf("git fetch origin"), "the rehearsal check sits after the pins and before any git command");
});

test("the privacy date: the script STOPS unless src/privacy.ts says the run's UTC date, before any git or network command (the function and the block are run for real; the shipped file's own date parses)", (t) => {
  const privacySrc = readFileSync(here("../src/privacy.ts"), "utf8");
  const shipped = /^Last updated: (\d{1,2} [A-Z][a-z]+ \d{4})$/m.exec(privacySrc);
  assert.ok(shipped, "src/privacy.ts has a Last updated line");
  const cases: Array<[string, string, string]> = [
    ["same-day", `Test-PrivacyDate ${q(privacySrc)} ([datetime]'2026-11-12T23:59:59Z')`, shipped![1] === "12 November 2026" ? "" : "but today is"],
    ["next-day", `Test-PrivacyDate ${q("x\nLast updated: 12 November 2026\ny")} ([datetime]'2026-11-13T00:00:01Z')`, "but today is 13 November 2026"],
    ["earlier-day", `Test-PrivacyDate ${q("Last updated: 12 November 2026")} ([datetime]'2026-11-11T12:00:00Z')`, "but today is 11 November 2026"],
    ["single-digit", `Test-PrivacyDate ${q("Last updated: 9 November 2026")} ([datetime]'2026-11-09T01:00:00Z')`, ""],
    ["no-line", `Test-PrivacyDate ${q("a privacy text without the line")} ([datetime]'2026-11-12T12:00:00Z')`, "no 'Last updated"],
    ["wrong-year", `Test-PrivacyDate ${q("Last updated: 12 November 2025")} ([datetime]'2026-11-12T12:00:00Z')`, "but today is 12 November 2026"],
  ];
  const run = runPs(harness(cases.map(([name, expr]) => `Write-Host ("RESULT ${name} [" + (${expr}) + "]")`)));
  if (!run) return t.skip("no PowerShell available");
  const got = results(run.out);
  for (const [name, , expect] of cases) {
    const v = got.get(name);
    assert.ok(v !== undefined, `${name} produced a result: ${run.out}`);
    if (expect === "") assert.equal(v, "", name);
    else assert.ok(v!.includes(expect), `${name}: '${v}' mentions '${expect}'`);
  }
  // the block: a date that is not today's STOPS with nothing read; the shipped order is pins, rehearsal, date, git
  const dateBlock = between(script, "# BEGIN-DATE-CHECK", "# END-DATE-CHECK");
  const dir = mkdtempSync(join(tmpdir(), "privacy-date-"));
  try {
    const file = join(dir, "privacy.ts");
    writeFileSync(file, "Last updated: 12 November 2026\n");
    const stubs = ["git", "npm", "npx", "curl.exe"].map((n) => `function ${n} { throw "${n} must not run in step 0b" }`);
    const h = (now: string): string[] => [
      "$ErrorActionPreference = 'Stop'",
      ...stubs,
      "function Stop-Here($msg) { Write-Host \"[STOP] $msg\"; exit 1 }",
      defs.slice(defs.indexOf("function Test-PrivacyDate"), defs.indexOf("# The FRONT_DOOR_TEMPLATE literal")),
      `$PRIVACY_PATH = ${q(file)}`,
      `function Get-Date { [datetime]'${now}' }`,
      dateBlock,
      'Write-Host "[PASSED-DATE]"',
    ];
    assert.match(runPs(h("2026-11-12T08:00:00Z"))!.out, /\[PASSED-DATE\]/);
    const late = runPs(h("2026-11-13T00:00:01Z"))!;
    assert.equal(late.code, 1);
    assert.match(late.out, /\[STOP\].*Last updated: 12 November 2026.*today is 13 November 2026.*Nothing was read or written/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(script.indexOf("# BEGIN-DATE-CHECK") > script.indexOf("# END-REHEARSAL-CHECK") && script.indexOf("# END-DATE-CHECK") < script.indexOf("git fetch origin"), "the date check sits after the rehearsal check and before any git command");
});

test("the steps are in the load-bearing order: pins, rehearsal, date, git, gates, live read, first production read, dry-run exit, migration, verification, worker deploy, second verification, ride; wrangler runs only through the bounded runner; nothing signs", () => {
  const order = [
    "# BEGIN-PIN-CHECK",
    "# BEGIN-REHEARSAL-CHECK",
    "# BEGIN-DATE-CHECK",
    "git fetch origin",
    "# BEGIN-REVIEWED-SOURCE-CHECK",
    "# BEGIN-GATES",
    'Read-Attest "before the deploy"',
    "$script:PreflightAt = Get-Date",
    "$catRes = Invoke-D1Read (Get-Content $VERIFY_SQL_PATH -Raw)",
    "$tableState = Get-TableState $catRes",
    "$script:OthersBefore = Invoke-D1Read $OTHER_OBJECTS_SQL",
    "if ($DryRun)",
    "# BEGIN-MIGRATION",
    "# END-MIGRATION-APPLY",
    'Assert-Prod-Verified "after the migration"',
    "# BEGIN-DEPLOY-AND-POLL",
    "Wait-NewWorker $headSha $versionId",
    "# BEGIN-RECONCILE",
    'Assert-Prod-Verified "after worker activation"',
    'Read-Attest "after the deploy"',
    "Test-RosterServed (Read-JsonBody",
    "$why = Test-ProfileServed",
    "Test-SkillServed $skill",
    "Test-PrivacyServed $privacy.Body",
    'Invoke-ToolList "/mcp"',
    "$why = Test-CouncilRulesUnchanged",
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
    "d1 execute (the --command read and the migration) and one stamped deploy, each through the bounded runner",
  );
  for (const l of wranglerLines.filter((l) => !executed.includes(l))) assert.match(l, /Stop-Here|Say |ROLLBACK_LINE|dry-run|rollbackTarget/, `any other mention of wrangler is message text: ${l.trim().slice(0, 80)}`);
  assert.equal((code.match(/Start-Process/g) ?? []).length, 1, "one process launcher");
  assert.match(code, /npx wrangler deploy --var CODE_COMMIT:" \+ \$headSha/);
  assert.equal(/Invoke-WebRequest|Invoke-RestMethod/i.test(code), false, "no PowerShell web cmdlets");
  assert.ok(code.includes('--data-binary "@$dataFile"'), "request bodies go by file, never an inner-quoted argument");
  assert.equal((code.match(/--data-binary/g) ?? []).length, 1, "the two POSTs (tools/list on the two doors) share the one body-by-file call");
  assert.equal((code.match(/Invoke-ToolList "\//g) ?? []).length, 2, "and there are exactly two of them");
  assert.equal(/tools\/call/.test(code), false, "no tools/call: nothing here claims a resident");
  assert.ok(code.includes("-- migrations"), "the one-migration check");
  assert.equal(/Authorization|Bearer|ch1\.|Ed25519|\.local\./i.test(code), false, "no credential, assertion or custody file is touched");
  assert.equal(/DROP\s+TABLE/i.test(code), false, "nothing drops the tables");
  const writes = code.split("\n").filter((l) => /--file /.test(l) && /Invoke-Bounded/.test(l));
  assert.equal(writes.length, 1, "exactly one remote write besides the deploy: the migration file");
  assert.ok(writes[0]!.includes("$MIGRATION_PATH"));
});

test("the header carries the rollback text and every duty (rehearsal first, the one hour, the privacy date, the ordering, both MCP doors, the not-ridden honesty line, no signing, never drop the tables)", () => {
  const header = script.split("\n").filter((l) => /^\s*#/.test(l)).join("\n");
  for (const needle of [
    "ONE HOUR",
    "worker rollback",
    "leaves migration 0026 applied",
    "NEVER drop them",
    "MIGRATION FIRST",
    "C1",
    "C3",
    "-RehearsalPassed",
    "scripts/rehearse-resident-account.ps1",
    "THE PRIVACY DATE",
    "UTC date of the run",
    "re-date src/privacy.ts",
    "-DryRun is stopped by it too",
    "THIS SCRIPT DOES NOT SIGN ANYTHING",
    "FRONT_DOOR_TEMPLATE",
    "public serving verified; production claim path not exercised",
    "worker deployed BEFORE the migration",
    "there is no resume mode",
    "a step BEFORE the worker deploy stopped",
    "/mcp/read still 13",
    "one real",
    "REVIEWED SOURCE ONLY",
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

test("the verify SQL over the REAL migration returns exactly the five rows the script pins, and is a single line the script can send", (t) => {
  const real = realCatalogue().map((r) => `${r.kind}|${r.name}|${r.detail}`);
  const pinned = [...between(script, "$EXPECTED_CATALOGUE = @(", "# Every sqlite_master row").matchAll(/"((?:index|table|unique)\|[^"]+)"/g)].map((m) => m[1]!);
  assert.deepEqual(pinned, real, "the pinned rows are what the migration builds");
  const rehearse = readFileSync(here("../scripts/rehearse-resident-account.ps1"), "utf8");
  const rehearsePinned = [...between(rehearse, "$EXPECTED_CATALOGUE = @(", "# Every sqlite_master row").matchAll(/"((?:index|table|unique)\|[^"]+)"/g)].map((m) => m[1]!);
  assert.deepEqual(rehearsePinned, pinned, "the rehearsal pins the same five rows");
  assert.equal(/^\$OTHER_OBJECTS_SQL = (".*")$/m.exec(script)![1], /^\$OTHER_OBJECTS_SQL = (".*")$/m.exec(rehearse)![1], "and the same other-objects read");
  const run = runPs(harness([`$one = ConvertTo-SingleLineSql ${q(verifySql)}`, 'Write-Host ("RESULT single [" + (Test-SingleLineSql $one) + "]")', 'Write-Host ("RESULT nolines [" + ($one.Contains("`n")) + "]")', `Write-Host ("RESULT other [" + (Test-SingleLineSql $OTHER_OBJECTS_SQL) + "]")`]));
  if (!run) return t.skip("no PowerShell available");
  const got = results(run.out);
  assert.equal(got.get("single"), "", run.out);
  assert.equal(got.get("nolines"), "False", run.out);
  assert.equal(got.get("other"), "", run.out);
});

test("the catalogue decision, run for real over the real rows: the exact five pass; a missing row, an extra row, a changed column order and a missing UNIQUE each stop; an unparsable read stops; the table count decides the migration (0 and 1 apply, 2 skips, 3 is an error, a failed read is an error)", (t) => {
  const real = realCatalogue();
  const mutate = (f: (rows: typeof real) => typeof real) => d1json(f(real.map((r) => ({ ...r }))));
  const cases: Array<[string, string, string]> = [
    ["cat-good", `Test-Catalogue (Read-D1Rows ${q(d1json(real))})`, ""],
    ["cat-missing-unique", `Test-Catalogue (Read-D1Rows ${q(mutate((r) => r.filter((x) => !x.detail.endsWith("platform,external_account_id"))))})`, "returned 4 rows, expected 5"],
    ["cat-extra", `Test-Catalogue (Read-D1Rows ${q(mutate((r) => [...r, { kind: "table", name: "stray", detail: "a" }]))})`, "returned 6 rows, expected 5"],
    ["cat-column-order", `Test-Catalogue (Read-D1Rows ${q(mutate((r) => r.map((x) => (x.name === "resident_accounts" ? { ...x, detail: x.detail.replace("visitor_id,platform", "platform,visitor_id") } : x))))})`, "catalogue row 3 is"],
    ["cat-unique-wrong-origin", `Test-Catalogue (Read-D1Rows ${q(mutate((r) => r.map((x) => (x.detail.includes(":u:") ? { ...x, detail: x.detail.replace(":u:", ":c:") } : x))))})`, "catalogue row 5 is"],
    ["cat-unparsable", `Test-Catalogue (Read-D1Rows ${q("Error: no such table")})`, "no parsable result"],
    ["state-none", `& { $s = Get-TableState (Read-D1Rows ${q(d1json([]))}); [string]$s.Tables + '|' + [string]$s.Both + '|' + $s.Error }`, "0|False|"],
    ["state-one", `& { $s = Get-TableState (Read-D1Rows ${q(d1json(real.filter((r) => r.name === "resident_accounts")))}); [string]$s.Tables + '|' + [string]$s.Both + '|' + $s.Error }`, "1|False|"],
    ["state-two", `& { $s = Get-TableState (Read-D1Rows ${q(d1json(real))}); [string]$s.Tables + '|' + [string]$s.Both + '|' + $s.Error }`, "2|True|"],
    ["state-three", `& { $s = Get-TableState (Read-D1Rows ${q(d1json([...real, { kind: "table", name: "x", detail: "y" }]))}); $s.Error }`, "at most 2"],
    ["state-failed", `& { $s = Get-TableState $null; $s.Error }`, "no parsable result"],
  ];
  const run = runPs(harness(cases.map(([name, expr]) => `Write-Host ("RESULT ${name} [" + (${expr}) + "]")`)));
  if (!run) return t.skip("no PowerShell available");
  const got = results(run.out);
  for (const [name, , expect] of cases) {
    const v = got.get(name);
    assert.ok(v !== undefined, `${name} produced a result: ${run.out}`);
    if (expect === "") assert.equal(v, "", name);
    else assert.ok(v!.includes(expect), `${name}: '${v}' mentions '${expect}'`);
  }
});

test("the other-objects comparison, run for real: identical snapshots pass; a changed table sql, a dropped object or a trivially small snapshot (a wrong database) or an unreadable one stops", (t) => {
  const rows = Array.from({ length: 25 }, (_, i) => ({ type: "table", name: `t${i}`, tbl_name: `t${i}`, sql: `CREATE TABLE t${i} (id INTEGER)` }));
  const changed = rows.map((r, i) => (i === 7 ? { ...r, sql: "CREATE TABLE t7 (id INTEGER, extra TEXT)" } : r));
  const cases: Array<[string, string, string]> = [
    ["same", `Test-OthersUnchanged (Read-D1Rows ${q(d1json(rows))}) (Read-D1Rows ${q(d1json(rows))}) 'x'`, ""],
    ["changed", `Test-OthersUnchanged (Read-D1Rows ${q(d1json(rows))}) (Read-D1Rows ${q(d1json(changed))}) 'x'`, "a pre-existing table, index or trigger changed"],
    ["dropped", `Test-OthersUnchanged (Read-D1Rows ${q(d1json(rows))}) (Read-D1Rows ${q(d1json(rows.slice(1)))}) 'x'`, "a pre-existing table, index or trigger changed"],
    ["small", `Test-OthersUnchanged (Read-D1Rows ${q(d1json(rows.slice(0, 3)))}) (Read-D1Rows ${q(d1json(rows.slice(0, 3)))}) 'x'`, "not the production schema"],
    ["unreadable", `Test-OthersUnchanged $null (Read-D1Rows ${q(d1json(rows))}) 'x'`, "unreadable"],
  ];
  const run = runPs(harness(cases.map(([name, expr]) => `Write-Host ("RESULT ${name} [" + (${expr}) + "]")`)));
  if (!run) return t.skip("no PowerShell available");
  const got = results(run.out);
  for (const [name, , expect] of cases) {
    const v = got.get(name);
    assert.ok(v !== undefined, `${name} produced a result: ${run.out}`);
    if (expect === "") assert.equal(v, "", name);
    else assert.ok(v!.includes(expect), `${name}: '${v}' mentions '${expect}'`);
  }
});

test("the migration really changes no other object: applied to a database holding the real schema, the other sqlite_master rows are identical before and after, and a second apply changes nothing", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(readFileSync(here("../schema.sql"), "utf8").split("-- Resident accounts (migrations/0026_resident_accounts.sql")[0]!);
    const others = (): string => JSON.stringify(db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE tbl_name NOT IN ('resident_accounts', 'resident_account_challenges') ORDER BY type, name").all());
    const before = others();
    assert.ok((JSON.parse(before) as unknown[]).length >= 20, "the schema is the real one");
    db.exec(migrationSql);
    const first = others();
    const cat = JSON.stringify(db.prepare(verifySql).all());
    db.exec(migrationSql);
    assert.equal(first, before, "no pre-existing object changed");
    assert.equal(others(), before, "a second apply changes nothing");
    assert.equal(JSON.stringify(db.prepare(verifySql).all()), cat);
  } finally {
    db.close();
  }
});

test("the migration block, run for real with a recording stub for wrangler: both tables present applies nothing; fewer applies 0026 once; a failed or timed-out apply stops before anything else", (t) => {
  const block = between(script, "# BEGIN-MIGRATION", "# END-MIGRATION-APPLY");
  assert.ok(block.length > 150 && block.includes("MIGRATION_PATH"), "the block was found");
  const h = (both: boolean, mig: string): string[] => [
    "$ErrorActionPreference = 'Stop'",
    "function Stop-Here($msg) { Write-Host \"[STOP] $msg\"; exit 1 }",
    "function Say($msg) { }",
    "function Assert-Window($label, $seconds) { }",
    "$PROD_DB = 'commonhold'; $WRANGLER_D1_SECONDS = 120",
    "$MIGRATION_PATH = 'migrations/0026_resident_accounts.sql'",
    `$tableState = @{ Tables = ${both ? 2 : 0}; Both = $${both ? "true" : "false"}; Error = '' }`,
    `function Invoke-Bounded($commandLine, $seconds) { Write-Host ('APPLY ' + $commandLine); ${mig} }`,
    block,
    "Write-Host '[BLOCK-DONE]'",
  ];
  const ok = "return @{ Code = 0; Out = ''; TimedOut = $false }";
  const applied = (out: string): string[] => [...out.matchAll(/APPLY .*--file (\S+)/g)].map((m) => m[1]!);
  const none = runPs(h(false, ok));
  if (!none) return t.skip("no PowerShell available");
  assert.deepEqual(applied(none.out), ["migrations/0026_resident_accounts.sql"], none.out);
  assert.match(none.out, /\[BLOCK-DONE\]/);
  assert.match(none.out, /APPLY npx wrangler d1 execute commonhold --remote --file/);
  const both = runPs(h(true, ok))!;
  assert.deepEqual(applied(both.out), []);
  assert.match(both.out, /\[BLOCK-DONE\]/);
  const failed = runPs(h(false, "return @{ Code = 1; Out = ''; TimedOut = $false }"))!;
  assert.equal(failed.code, 1);
  assert.match(failed.out, /\[STOP\] migration 0026 failed/);
  const timed = runPs(h(false, "return @{ Code = -1; Out = ''; TimedOut = $true }"))!;
  assert.equal(timed.code, 1);
  assert.match(timed.out, /\[STOP\] migration 0026 timed out/);
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

test("the served-answer checks, run for real: the residents block, the roster, the profile, the skill, the privacy page, the tool lists and the council rules each pass on good input and stop on bad", (t) => {
  const SKILL_SHA = /^\$SKILL_SHA256 = "([0-9a-f]{64})"$/m.exec(script)![1]!;
  const officialBody = (over: Record<string, unknown>): string => JSON.stringify({ residents: { count: 0, by_key: 0, by_account: 0, counts_note: "a resident bound both ways is counted in both", ...over } });
  const rosterNote = "Residents are guests that have written once and then either bound an Ed25519 public key or proved control of an outside account on 1f916 or the Colony.";
  const rosterBody = (over: Record<string, unknown>): string => JSON.stringify({ residents: [], total: 0, note: rosterNote, ...over });
  const tools = (names: string[]): string => JSON.stringify({ result: { tools: names.map((name) => ({ name })) } });
  const many = (n: number, extra: string[] = []): string[] => [...Array.from({ length: n - extra.length }, (_, i) => `tool_${i}`), ...extra];
  const council = (over: Record<string, unknown>): string => JSON.stringify({ rules: { self_paid: "a", earned: "b" }, motion_rule: { version: "council-v1", text: "t" }, powers: "p", ...over });
  const privacyGood = "x **The Colony** (thecolony.ai) receives requests naming the proof comment's id and the account's id y or recovers a token, with an account there. a SHA-256 hash of its claim code (never the code) so the account you prove is public. Last updated: 12 November 2026";
  const cases: Array<[string, string, string]> = [
    ["official-good", `Test-OfficialResidents (Read-JsonBody @{ Body = ${q(officialBody({}))} })`, ""],
    ["official-nosplit", `Test-OfficialResidents (Read-JsonBody @{ Body = ${q(JSON.stringify({ residents: { count: 0 } }))} })`, "has no by_key"],
    ["official-text", `Test-OfficialResidents (Read-JsonBody @{ Body = ${q(officialBody({ by_account: "n/a" }))} })`, "not a whole number"],
    ["official-nonote", `Test-OfficialResidents (Read-JsonBody @{ Body = ${q(officialBody({ counts_note: "" }))} })`, "no counts_note"],
    ["official-noblock", `Test-OfficialResidents (Read-JsonBody @{ Body = '{}' })`, "no residents block"],
    ["roster-good", `Test-RosterServed (Read-JsonBody @{ Body = ${q(rosterBody({}))} }) 0`, ""],
    ["roster-total", `Test-RosterServed (Read-JsonBody @{ Body = ${q(rosterBody({ total: 3 }))} }) 0`, "total is 3, expected 0"],
    ["roster-oldnote", `Test-RosterServed (Read-JsonBody @{ Body = ${q(rosterBody({ note: "Residents are guests that have bound a key." }))} }) 0`, "account route wording"],
    ["roster-noroute", `Test-RosterServed (Read-JsonBody @{ Body = ${q(rosterBody({ total: 1, residents: [{ number: 5 }] }))} }) $null`, "has no route"],
    ["roster-html", `Test-RosterServed (Read-JsonBody @{ Body = '<html>' }) 0`, "did not return JSON"],
    ["profile-404", `Test-ProfileServed @{ Code = '404'; Body = ${q(JSON.stringify({ error: "1 is a guest, not a resident" }))} }`, ""],
    ["profile-200", `Test-ProfileServed @{ Code = '200'; Body = ${q(JSON.stringify({ route: "account" }))} }`, ""],
    ["profile-200-noroute", `Test-ProfileServed @{ Code = '200'; Body = ${q(JSON.stringify({ number: 1 }))} }`, "carries no route"],
    ["profile-500", `Test-ProfileServed @{ Code = '500'; Body = '' }`, "expected 200 or 404"],
    ["skill-good", `Test-SkillServed @{ Code = '200'; Body = 'a version: 1.5.0 b'; Sha256 = ${q(SKILL_SHA)} }`, ""],
    ["skill-old", `Test-SkillServed @{ Code = '200'; Body = 'version: 1.4.4'; Sha256 = ${q(SKILL_SHA)} }`, "does not carry 'version: 1.5.0'"],
    ["skill-sha", `Test-SkillServed @{ Code = '200'; Body = 'version: 1.5.0'; Sha256 = ${q("0".repeat(64))} }`, "expected the pinned"],
    ["skill-404", `Test-SkillServed @{ Code = '404'; Body = ''; Sha256 = '' }`, "-> 404"],
    ["privacy-good", `Test-PrivacyServed ${q(privacyGood)} ([datetime]'2026-11-12T10:00:00Z')`, ""],
    ["privacy-date", `Test-PrivacyServed ${q(privacyGood)} ([datetime]'2026-11-13T10:00:00Z')`, "does not say 'Last updated: 13 November 2026'"],
    ["privacy-old", `Test-PrivacyServed ${q("an older privacy page Last updated: 12 November 2026")} ([datetime]'2026-11-12T10:00:00Z')`, "does not carry"],
    ["tools-good", `Test-ToolList (Read-JsonBody @{ Body = ${q(tools(many(39, ["resident_account_challenge", "resident_account_claim"])))} }) 39 @('resident_account_challenge','resident_account_claim') @()`, ""],
    ["tools-count", `Test-ToolList (Read-JsonBody @{ Body = ${q(tools(many(37, ["resident_account_challenge", "resident_account_claim"])))} }) 39 @('resident_account_challenge') @()`, "lists 37 tools, expected 39"],
    ["tools-missing", `Test-ToolList (Read-JsonBody @{ Body = ${q(tools(many(39)))} }) 39 @('resident_account_claim') @()`, "does not list resident_account_claim"],
    ["read-good", `Test-ToolList (Read-JsonBody @{ Body = ${q(tools(many(13)))} }) 13 @() @('resident_account_challenge','resident_account_claim')`, ""],
    ["read-leak", `Test-ToolList (Read-JsonBody @{ Body = ${q(tools(many(13, ["resident_account_claim"])))} }) 13 @() @('resident_account_claim')`, "which this door must not"],
    ["council-same", `Test-CouncilRulesUnchanged (Get-CouncilRules (Read-JsonBody @{ Body = ${q(council({}))} })) (Get-CouncilRules (Read-JsonBody @{ Body = ${q(council({}))} }))`, ""],
    ["council-changed", `Test-CouncilRulesUnchanged (Get-CouncilRules (Read-JsonBody @{ Body = ${q(council({}))} })) (Get-CouncilRules (Read-JsonBody @{ Body = ${q(council({ powers: "q" }))} }))`, "changed across the deploy"],
    ["council-unreadable", `Test-CouncilRulesUnchanged (Get-CouncilRules $null) (Get-CouncilRules (Read-JsonBody @{ Body = ${q(council({}))} }))`, "could not be read"],
  ];
  const run = runPs(harness(cases.map(([name, expr]) => `Write-Host ("RESULT ${name} [" + (${expr}) + "]")`)));
  if (!run) return t.skip("no PowerShell available");
  const got = results(run.out);
  for (const [name, , expect] of cases) {
    const v = got.get(name);
    assert.ok(v !== undefined, `${name} produced a result: ${run.out}`);
    if (expect === "") assert.equal(v, "", name);
    else assert.ok(v!.includes(expect), `${name}: '${v}' mentions '${expect}'`);
  }
});

test("the no-mint check, run for real on the real files: FRONT_DOOR_TEMPLATE at the live base and at HEAD are byte-identical although src/doc.ts changed; a changed template, a missing marker and an unterminated literal are told apart", (t) => {
  const show = spawnSync("git", ["show", `${LIVE}:src/doc.ts`], { cwd: here(".."), encoding: "utf8", maxBuffer: 1 << 26 });
  if (show.status !== 0) return t.skip("the live base commit is not in this clone");
  const dir = mkdtempSync(join(tmpdir(), "template-"));
  try {
    const liveFile = join(dir, "live.ts");
    const headFile = join(dir, "head.ts");
    writeFileSync(liveFile, show.stdout);
    writeFileSync(headFile, readFileSync(here("../src/doc.ts"), "utf8"));
    const headDoc = readFileSync(here("../src/doc.ts"), "utf8");
    assert.notEqual(show.stdout.replace(/\r\n/g, "\n"), headDoc.replace(/\r\n/g, "\n"), "src/doc.ts DID change (the RESIDENTS section), so a path check would have stopped this deploy wrongly");
    const mutated = headDoc.replace("You are reading the front door of {{NAME}}", "You are reading the front door of {{NAME}} (edited)");
    assert.notEqual(mutated, headDoc);
    const mutFile = join(dir, "mutated.ts");
    writeFileSync(mutFile, mutated);
    const run = runPs(
      harness([
        `$live = Get-TemplateText (Get-Content -Raw ${q(liveFile)})`,
        `$head = Get-TemplateText (Get-Content -Raw ${q(headFile)})`,
        `$mut = Get-TemplateText (Get-Content -Raw ${q(mutFile)})`,
        'Write-Host ("RESULT same [" + ($live -ceq $head) + "]")',
        'Write-Host ("RESULT long [" + ($live.Length -gt 5000) + "]")',
        'Write-Host ("RESULT mutated [" + ($live -ceq $mut) + "]")',
        'Write-Host ("RESULT nomarker [" + ($null -eq (Get-TemplateText "const x = 1")) + "]")',
        "Write-Host (\"RESULT unterminated [\" + ($null -eq (Get-TemplateText 'export const FRONT_DOOR_TEMPLATE = `abc')) + \"]\")",
      ]),
    );
    if (!run) return t.skip("no PowerShell available");
    const got = results(run.out);
    assert.equal(got.get("same"), "True", run.out);
    assert.equal(got.get("long"), "True", run.out);
    assert.equal(got.get("mutated"), "False", run.out);
    assert.equal(got.get("nomarker"), "True", run.out);
    assert.equal(got.get("unterminated"), "True", run.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the source checks name literals the checkout carries: every Select-String literal is in its file", () => {
  let n = 0;
  for (const m of code.matchAll(/Select-String -Path "([^"]+)" -Pattern ('[^']+'|"[^"]+")/g)) {
    const file = m[1]!;
    if (file === "wrangler.jsonc") continue;
    const lit = m[2]!.slice(1, -1);
    assert.ok(readFileSync(here(`../${file}`), "utf8").includes(lit), `${file} carries '${lit}'`);
    n++;
  }
  assert.ok(n >= 6, `checked ${n} literals`);
});

test("the key gates CAN FAIL: a mutated copy of the script turns the harness answer (the date check, the rehearsal check, the migration decision, the other-objects comparison, the catalogue comparison)", (t) => {
  const mutate = (from: string, to: string): string => {
    assert.ok(script.includes(from), `the mutation target exists: ${from}`);
    return script.replace(from, to);
  };
  const dateCase = (s: string): string | null => {
    const block = between(s, "# BEGIN-DATE-CHECK", "# END-DATE-CHECK");
    const dir = mkdtempSync(join(tmpdir(), "mut-date-"));
    try {
      const file = join(dir, "privacy.ts");
      writeFileSync(file, "Last updated: 12 November 2026\n");
      const d = defsOf(s);
      const r = runPs([
        "$ErrorActionPreference = 'Stop'",
        "function Stop-Here($msg) { Write-Host \"[STOP] $msg\"; exit 1 }",
        d.slice(d.indexOf("function Test-PrivacyDate"), d.indexOf("# The FRONT_DOOR_TEMPLATE literal")),
        `$PRIVACY_PATH = ${q(file)}`,
        "function Get-Date { [datetime]'2026-11-13T00:00:01Z' }",
        block,
        'Write-Host "[PASSED-DATE]"',
      ]);
      return r ? r.out : null;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const original = dateCase(script);
  if (original === null) return t.skip("no PowerShell available");
  assert.match(original, /\[STOP\]/);
  assert.match(dateCase(mutate("if ($m.Groups[1].Value -cne $today)", "if ($m.Groups[1].Value -cne $m.Groups[1].Value)"))!, /\[PASSED-DATE\]/, "mutant: the date comparison is a tautology -> the stale date passes");

  const rehearsalCase = (s: string): string => {
    const block = between(s, "# BEGIN-REHEARSAL-CHECK", "# END-REHEARSAL-CHECK");
    return runPs(["$ErrorActionPreference = 'Stop'", "function Stop-Here($msg) { Write-Host \"[STOP] $msg\"; exit 1 }", "$DryRun = $false", "$RehearsalPassed = $false", block, 'Write-Host "[PASSED-REHEARSAL]"'])!.out;
  };
  assert.match(rehearsalCase(script), /\[STOP\]/);
  assert.match(rehearsalCase(mutate("if (-not $DryRun -and -not $RehearsalPassed)", "if (-not $DryRun -and $false)")), /\[PASSED-REHEARSAL\]/, "mutant: the flag is not required -> a real run passes unrehearsed");

  const migrationCase = (s: string): string => {
    const block = between(s, "# BEGIN-MIGRATION", "# END-MIGRATION-APPLY");
    return runPs([
      "$ErrorActionPreference = 'Stop'",
      "function Stop-Here($msg) { Write-Host \"[STOP] $msg\"; exit 1 }",
      "function Say($msg) { }",
      "function Assert-Window($label, $seconds) { }",
      "$PROD_DB = 'commonhold'; $WRANGLER_D1_SECONDS = 120; $MIGRATION_PATH = 'migrations/0026_resident_accounts.sql'",
      "$tableState = @{ Tables = 0; Both = $false; Error = '' }",
      "function Invoke-Bounded($commandLine, $seconds) { Write-Host ('APPLY ' + $commandLine); return @{ Code = 0; Out = ''; TimedOut = $false } }",
      block,
    ])!.out;
  };
  assert.match(migrationCase(script), /APPLY /);
  assert.doesNotMatch(migrationCase(mutate("if ($tableState.Both) {", "if ($true) {")), /APPLY /, "mutant: the migration is skipped whatever the catalogue says");

  const othersCase = (s: string): string => {
    const d = defsOf(s);
    const rows = Array.from({ length: 25 }, (_, i) => ({ type: "table", name: `t${i}`, tbl_name: `t${i}`, sql: `CREATE TABLE t${i} (id INTEGER)` }));
    const changed = rows.map((r, i) => (i === 3 ? { ...r, sql: "CREATE TABLE t3 (id INTEGER, extra TEXT)" } : r));
    return runPs(harness([`Write-Host ("RESULT o [" + (Test-OthersUnchanged (Read-D1Rows ${q(d1json(rows))}) (Read-D1Rows ${q(d1json(changed))}) 'x') + "]")`], d))!.out;
  };
  assert.match(othersCase(script), /RESULT o \[a pre-existing/);
  assert.match(othersCase(mutate("if ($a -cne $b) { return (\"a pre-existing", "if ($a -ceq \"never\") { return (\"a pre-existing")), /RESULT o \[\]/, "mutant: the snapshot comparison never fires -> a changed table passes");

  const catCase = (s: string): string => {
    const d = defsOf(s);
    return runPs(harness([`Write-Host ("RESULT c [" + (Test-Catalogue (Read-D1Rows ${q(d1json(realCatalogue().slice(1)))})) + "]")`], d))!.out;
  };
  assert.match(catCase(script), /RESULT c \[the catalogue read returned 4 rows/);
  assert.match(catCase(mutate("if ($got.Count -ne $EXPECTED_CATALOGUE.Count)", "if ($false)")), /RESULT c \[catalogue row 1 is/, "mutant: the row-count check is gone -> the failure moves to a different message (row 1), proving the count gate was the one that fired");
});
