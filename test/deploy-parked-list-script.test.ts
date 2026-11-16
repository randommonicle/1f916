// scripts/deploy-parked-list.ps1, scripts/rehearse-parked-list.ps1 and scripts/check-parked-list-served.mjs are WRITTEN AND NEVER RUN by the builder (no deploy, no wrangler, not even -DryRun, which reads the live worker over
// HTTP). They are proven here by what can be proven without running them: both .ps1 parse under PowerShell's own parser, are ASCII with LF endings, have none of the repo's PowerShell traps, carry the pins and the load-bearing
// step order, the pin block is run for real (step 0a stops on a placeholder before any git or network command), the pure check functions are run for real against good and bad inputs (the migration-state sort, the parked-route
// check, the date check, the v6 pin run), the whole-document checker is run for real against good and mutated documents, and the seven catalogue rows both scripts pin are the rows the verify SQL really returns over the
// committed schema.sql (node:sqlite), and none over the pre-0028 schema. Derived from test/deploy-recovery-unit-script.test.ts and test/deploy-openapi-resident-schema-script.test.ts.
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
const DEPLOY_PATH = here("../scripts/deploy-parked-list.ps1");
const REHEARSE_PATH = here("../scripts/rehearse-parked-list.ps1");
const CHECKER_PATH = here("../scripts/check-parked-list-served.mjs");
const rawDeploy = readFileSync(DEPLOY_PATH, "utf8");
const rawRehearse = readFileSync(REHEARSE_PATH, "utf8");
const script = rawDeploy.replace(/\r\n/g, "\n");
const rehearse = rawRehearse.replace(/\r\n/g, "\n");
const strip = (s: string): string => s.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
const code = strip(script);
const rcode = strip(rehearse);
const defs = script.slice(script.indexOf('$ErrorActionPreference = "Stop"'), script.indexOf("# END-OF-DEFINITIONS"));
const rdefs = rehearse.slice(rehearse.indexOf('$ErrorActionPreference = "Stop"'), rehearse.indexOf("# END-OF-DEFINITIONS"));
const pinBlock = script.slice(script.indexOf("# BEGIN-PIN-CHECK"), script.indexOf("# END-PIN-CHECK"));
const v6Block = script.slice(script.indexOf("# BEGIN-V6-PIN-FN"), script.indexOf("# END-V6-PIN-FN"));
const LIVE = "36e846854b23a32d6304ec141d4ed0874327bc46";
const V6 = "dc5f48213c29bcf844e0fbe7daf1bdb5416b3d57fbd06a8bd03f1061f34092b3";
const q = (s: string): string => "'" + s.replace(/'/g, "''") + "'";

function runPs(lines: string[]): { code: number | null; out: string } | null {
  const dir = mkdtempSync(join(tmpdir(), "deploy-parked-list-"));
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
// The function text from `from` up to (not including) `to` inside the defs.
const fnText = (text: string, from: string, to: string): string => text.slice(text.indexOf(from), text.indexOf(to));
// "RESULT name [value]" lines -> map
const results = (out: string): Record<string, string> => Object.fromEntries([...out.matchAll(/^RESULT (\S+) \[(.*)\]\r?$/gm)].map((m) => [m[1]!, m[2]!]));


// ---------- the real catalogue ----------
const verifySql = readFileSync(here("../scripts/verify-parked-list.sql"), "utf8");
const catalogueOf = (db: DatabaseSync): string[] => (db.prepare(verifySql.replace(/;\s*$/, "")).all() as Array<{ kind: string; name: string; detail: string }>).map((r) => `${r.kind}|${r.name}|${r.detail}`);
const pinned = (text: string): string[] => {
  const body = text.slice(text.indexOf("$EXPECTED_CATALOGUE = @("), text.indexOf("\n)", text.indexOf("$EXPECTED_CATALOGUE = @(")));
  return [...body.matchAll(/^\s*"([^"]+)",?$/gm)].map((m) => m[1]!);
};
const HEADER_0028 = "-- The parked list (migrations/0028_maintainer_declines.sql";

test("both scripts parse under PowerShell's own parser with zero errors, are ASCII only and have LF line endings; so is the checker", (t) => {
  assert.equal(/[^\x00-\x7f]/.test(readFileSync(CHECKER_PATH, "utf8")), false, "checker: ASCII only");
  assert.equal(readFileSync(CHECKER_PATH, "utf8").includes("\r"), false, "checker: LF line endings");
  for (const [name, raw, path] of [["deploy", rawDeploy, DEPLOY_PATH], ["rehearse", rawRehearse, REHEARSE_PATH]] as const) {
    assert.equal(/[^\x00-\x7f]/.test(raw), false, `${name}: ASCII only`);
    assert.equal(raw.includes("\r"), false, `${name}: LF line endings`);
    const parsed = parsePowerShellFile(path);
    if (!parsed.available) {
      t.skip(`${parsed.reason}; the static checks still run`);
      return;
    }
    assert.equal(parsed.errors, 0, `${name} parse errors: ${parsed.detail}`);
  }
});

test("no PowerShell traps in either script: one spelling per variable, no `$var:` drive reference, stderr merged only under Continue, no -notmatch over a pipeline", () => {
  for (const c of [code, rcode]) {
    const names = new Map<string, Set<string>>();
    for (const m of c.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)) {
      const set = names.get(m[1]!.toLowerCase()) ?? new Set<string>();
      set.add(m[1]!);
      names.set(m[1]!.toLowerCase(), set);
    }
    assert.deepEqual([...names.values()].filter((s) => s.size > 1).map((s) => [...s].join(" / ")), []);
    assert.equal(/\$[A-Za-z_][A-Za-z0-9_]*:/.test(c.replace(/\$\(/g, "").replace(/\$(script|env):/g, "")), false);
    for (const m of c.matchAll(/2>&1/g)) {
      const before = c.slice(0, m.index);
      assert.ok(before.lastIndexOf('$ErrorActionPreference = "Continue"') > before.lastIndexOf('$ErrorActionPreference = "Stop"'));
    }
    assert.equal(/\$\w+\s*\|\s*Where-Object[^\n]*-notmatch/.test(c), false);
  }
});

test("the pins: the v6 hash, the live base is the full sha of 36e84685, the reviewed commit ships as the named placeholder, the allowlist covers the scripts, the verify SQL, the checker, this test and docs/, -ExpectedCommit is mandatory, -RehearsalPassed exists, ONE migration (0028)", () => {
  assert.match(script, new RegExp(`^\\$V6_HASH = "${V6}"$`, "m"));
  assert.match(script, new RegExp(`^\\$LIVE_BASE_COMMIT = "${LIVE}"$`, "m"));
  // Ships as the placeholder; the hub then sets a full sha. Either state must leave the suite green, or setting the pin would fail the script's own npm test gate. The placeholder STOP is proved separately below.
  assert.match(script, /^\$REVIEWED_COMMIT = "(TO-BE-SET-BY-HUB|[0-9a-f]{40})"$/m);
  assert.match(script, /^\$REVIEWED_COMMIT_PLACEHOLDER = "TO-BE-SET-BY-HUB"$/m);
  assert.match(script, /^\$ALLOWED_PATHS_AFTER_REVIEW = @\("scripts\/deploy-parked-list\.ps1", "scripts\/rehearse-parked-list\.ps1", "scripts\/verify-parked-list\.sql", "scripts\/check-parked-list-served\.mjs", "test\/deploy-parked-list-script\.test\.ts", "docs\/"\)$/m);
  assert.match(script, /^\$MIGRATION_PATH = "migrations\/0028_maintainer_declines\.sql"$/m);
  assert.match(script, /^\$VERIFY_SQL_PATH = "scripts\/verify-parked-list\.sql"$/m);
  assert.match(script, /^\$CHECKER_PATH = "scripts\/check-parked-list-served\.mjs"$/m);
  assert.match(script, /\[Parameter\(Mandatory = \$true\)\]\[string\]\$ExpectedCommit/);
  assert.match(script, /\[switch\]\$DryRun/);
  assert.match(script, /\[switch\]\$RehearsalPassed/);
  assert.ok(code.includes('$migMoves.Count -ne 1 -or $migMoves[0] -cne ("A`t" + $MIGRATION_PATH)'), "exactly one added migration since the live base, and it is this one");
  assert.ok(!/0027|0026/.test(code), "no residue of an earlier wave's migration number in code");
  assert.match(rehearse, /^\$SCRATCH_DB = "commonhold-migtest"$/m);
  assert.match(rehearse, /^\$MIGRATION_PATH = "migrations\/0028_maintainer_declines\.sql"$/m);
  assert.match(rehearse, /^\$VERIFY_SQL_PATH = "scripts\/verify-parked-list\.sql"$/m);
});

test("step 0a STOPS on either placeholder or a malformed pin before ANY git, npm, wrangler or network command (the pin block is run for real), and passes full shas", (t) => {
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
  const ok = runPs(harness(LIVE, FULL))!;
  assert.equal(ok.code, 0);
  assert.match(ok.out, /\[PASSED-PINS\]/);
});

test("the steps are in the load-bearing order: pins, date, git, reviewed source, gates, the v6 pin test, the live reads, the first production read, the migration, the catalogue, the deploy, the verification, the ride; and the migration never claims a re-run is safe", () => {
  const order = ["# BEGIN-PIN-CHECK", "# BEGIN-REHEARSAL-CHECK", "# BEGIN-DATE-CHECK", "git fetch origin", "# BEGIN-REVIEWED-SOURCE-CHECK", "# BEGIN-GATES", "# BEGIN-V6-PIN-CHECK", 'Read-Attest "before the deploy"', "# BEGIN-PROD-TARGET", "$script:PreflightAt = Get-Date", "if ($DryRun)", "# BEGIN-MIGRATION", "Assert-Prod-Verified \"after the migration\"", "# BEGIN-DEPLOY-AND-POLL", "# BEGIN-RECONCILE", 'Read-Attest "after the deploy"', "$why = Test-ServedWhole", "[ride] 17 public reads"];
  let last = -1;
  for (const needle of order) {
    const i = script.indexOf(needle);
    assert.ok(i > last, `${needle} comes after the previous step`);
    last = i;
  }
  assert.ok(!/IF NOT EXISTS makes|applies only if a table is absent|rerunning is safe|re-run is safe once/i.test(script), "no inherited 'rerunning is safe' claim");
  assert.ok(script.includes("does NOT claim that re-running is safe"), "the script says why instead");
  const mig = script.slice(script.indexOf("# BEGIN-MIGRATION"), script.indexOf("# END-MIGRATION-APPLY"));
  assert.ok(mig.includes('if ($migState.State -ceq "complete")'), "only a COMPLETE state skips; absent applies");
  assert.ok(code.includes('if ($migState.State -ceq "partial") { Stop-Here'), "an unreadable PARTIAL state STOPS before anything is written (step 4)");
  assert.equal((code.match(/--file/g) ?? []).length, 1, "--file only for the migration");
  assert.equal(/Invoke-WebRequest|Invoke-RestMethod|-Method\s+Post|-X\s+POST|--data/i.test(code), false, "the ride is GETs only");
  assert.ok(code.includes("$whyV6 = Test-V6PinRun $v6Out $v6Code") && code.includes('if ($whyV6 -ne "") { Stop-Here'), "the no-mint check is the evaluated v6 pin run");
  assert.ok(code.includes("-ceq $LIVE_BASE_COMMIT") || code.includes("-cne $LIVE_BASE_COMMIT"), "the live commit is proved against the pin");
  assert.ok(code.includes("$liveTemplate -cne $headTemplate"), "the template is also compared byte for byte between the live base and HEAD");
  assert.ok(code.includes('if ([string]$parkedBefore.Code -cne "404") { Stop-Here'), "the live marker: the route is 404 before the deploy, and a 200 stops as already deployed");
});

test("the catalogue both scripts pin is exactly what scripts/verify-parked-list.sql returns over the committed schema.sql, and over the pre-0028 schema nothing (mutant: a pinned row differs); the verify SQL respects real D1's limits", () => {
  const full = readFileSync(here("../schema.sql"), "utf8").replace(/\r\n/g, "\n");
  const cut = full.indexOf(HEADER_0028);
  assert.ok(cut > 0);
  const fresh = new DatabaseSync(":memory:");
  const pre = new DatabaseSync(":memory:");
  try {
    fresh.exec(full);
    pre.exec(full.slice(0, cut));
    const real = catalogueOf(fresh);
    assert.equal(real.length, 7);
    assert.deepEqual(pinned(script), real, "the deploy script pins what the verify SQL returns");
    assert.deepEqual(pinned(rehearse), real, "the rehearsal pins the same rows");
    assert.deepEqual(catalogueOf(pre), [], "before the migration the catalogue read returns no rows");
    const mig = readFileSync(here("../migrations/0028_maintainer_declines.sql"), "utf8").replace(/\r\n/g, "\n");
    pre.exec(mig);
    assert.deepEqual(catalogueOf(pre), real, "the migration, applied to the pre-0028 schema, yields the pinned catalogue");
    // A pinned row that differs from what the SQL returns goes red.
    const tampered = pinned(script).map((r, i) => (i === 0 ? r.replace("INTEGER|1|0", "TEXT|1|0") : r));
    assert.notDeepEqual(tampered, real);
  } finally {
    fresh.close();
    pre.close();
  }
  const sql = verifySql.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
  assert.ok((sql.match(/UNION ALL/g) ?? []).length + 1 <= 5, "at most five compound SELECT terms (real D1)");
  assert.ok(!/FROM sqlite_master[^;]*pragma_table_info\(\w+\.name\)[^;]*\bOR\b/i.test(sql) && !/\bOR\b/i.test(sql.replace(/ORDER/gi, "")), "no sqlite_master joined to a pragma under an OR (real D1: SQLITE_AUTH)");
  assert.ok(!verifySql.includes('"'), "single quotes only");
});

test("the migration-state sort, run for real: no table is ABSENT, the table COMPLETE, a duplicate row and a failed read an error, never 'absent' (mutant: complete treated as absent)", (t) => {
  const fns = fnText(defs, "function Get-MigrationState", "# BEGIN-V6-PIN-FN");
  const rows = (names: string[]): string => "@{ Rows = @(" + names.map((n) => `[pscustomobject]@{ kind = '${n.split("|")[0]}'; name = '${n.split("|")[1]}'; detail = 'x' }`).join(", ") + ") }";
  const cases: Array<[string, string]> = [
    ["none", rows([])],
    ["col_only", rows(["column|maintainer_declines.queue_id"])],
    ["all", rows(["table|maintainer_declines"])],
    ["dup", rows(["table|maintainer_declines", "table|maintainer_declines"])],
    ["null", "$null"],
  ];
  const run = runPs([
    "$ErrorActionPreference = 'Stop'",
    `$MIGRATION_OBJECTS = @(${q("table|maintainer_declines")})`,
    fns,
    ...cases.map(([n, r]) => `$s = Get-MigrationState (${r}); Write-Host ("RESULT ${n} [" + $s.State + "|" + $s.Present + "|" + $s.Error + "]")`),
  ]);
  if (!run) return t.skip("no PowerShell available");
  const out = results(run.out);
  assert.equal(out.none, "absent|0|");
  assert.equal(out.col_only, "absent|0|", "only the table row decides (step 6 then requires all seven rows)");
  assert.equal(out.all, "complete|1|");
  assert.match(out.dup!, /returned 2 rows for table\|maintainer_declines/);
  assert.match(out.null!, /no parsable result/);
});

test("the served checks, run for real: the parked route passes good input and fails each missing piece; the privacy date check passes today's date and fails any other", (t) => {
  const fns = defs.slice(defs.indexOf("function Read-JsonBody"), defs.indexOf("# ---- the D1 helpers")) + "\n" + fnText(defs, "# ---- the served-answer checks ----", "# Saves the exact bytes") + "\n" + fnText(defs, "function Test-PrivacyDate", "# The FRONT_DOOR_TEMPLATE literal");
  const body = (over: Record<string, unknown> = {}) => JSON.stringify({ total: 0, parked_now: 0, park_after: 2, items: [], ...over });
  const cap = (code: string, b: string): string => `@{ Code = ${q(code)}; Type = 'application/json'; Body = ${q(b)} }`;
  const cases: Array<[string, string, string]> = [
    ["parked_ok", `Test-ParkedLive ${cap("200", body())}`, ""],
    ["parked_404", `Test-ParkedLive ${cap("404", "{}")}`, "answered 404"],
    ["parked_html", `Test-ParkedLive ${cap("200", "<html>")}`, "did not return JSON"],
    ["parked_nototal", `Test-ParkedLive ${cap("200", body({ total: undefined }))}`, "total is not a whole number"],
    ["parked_badtotal", `Test-ParkedLive ${cap("200", body({ total: "x" }))}`, "total is not a whole number"],
    ["parked_noparkedNow", `Test-ParkedLive ${cap("200", body({ parked_now: undefined }))}`, "parked_now"],
    ["parked_park3", `Test-ParkedLive ${cap("200", body({ park_after: 3 }))}`, "expected 2"],
    ["parked_noitems", `Test-ParkedLive ${cap("200", body({ items: undefined }))}`, "no items"],
    ["date_ok", `Test-PrivacyDate ${q("x\nLast updated: 17 November 2026\ny")} ([datetime]'2026-11-17T09:00:00Z')`, ""],
    ["date_old", `Test-PrivacyDate ${q("x\nLast updated: 15 November 2026\ny")} ([datetime]'2026-11-17T09:00:00Z')`, "but today is 17 November 2026"],
    ["date_missing", `Test-PrivacyDate ${q("nothing here")} ([datetime]'2026-11-17T09:00:00Z')`, "no 'Last updated"],
  ];
  const run = runPs([
    "$ErrorActionPreference = 'Stop'",
    fns,
    ...cases.map(([n, expr]) => `Write-Host ("RESULT ${n} [" + (${expr}) + "]")`),
  ]);
  if (!run) return t.skip("no PowerShell available");
  const out = results(run.out);
  for (const [n, , expect] of cases) {
    assert.ok(n in out, `${n} produced a result: ${run.out}`);
    if (expect === "") assert.equal(out[n], "", n);
    else assert.ok(out[n]!.includes(expect), `${n}: '${out[n]}' mentions '${expect}'`);
  }
});

// ---------- the whole-document checker, run for real ----------
function checker(args: string[]): { code: number | null; out: string } {
  const r = spawnSync("node", ["--experimental-strip-types", CHECKER_PATH, ...args], { encoding: "utf8", cwd: here("..") });
  return { code: r.status, out: `${r.stdout}${r.stderr}`.trim() };
}
function withDocs(fn: (dir: string, f: { parked: string; openapi: string; privacy: string; runs: string }) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "parked-checker-"));
  try {
    const f = { parked: join(dir, "parked.json"), openapi: join(dir, "openapi.json"), privacy: join(dir, "privacy.md"), runs: join(dir, "runs.json") };
    const w = checker(["--write-local", f.parked, f.openapi, f.privacy, f.runs]);
    assert.deepEqual([w.code, w.out], [0, "WROTE-LOCAL"]);
    fn(dir, f);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the whole-document checker: the source against itself is OK, and each mutation of a served document is a MISMATCH naming it (parked note, since, park_after, route schema, privacy paragraph, privacy date, runs note; a missing or unreadable file is exit 2)", () => {
  withDocs((dir, f) => {
    const all = [f.parked, f.openapi, f.privacy, f.runs];
    assert.deepEqual(checker(all), { code: 0, out: "OK" });
    const edit = (file: string, fn: (text: string) => string): string => {
      const out = join(dir, "mut-" + file.split(/[\\/]/).pop());
      writeFileSync(out, fn(readFileSync(file, "utf8")));
      return out;
    };
    const jedit = (file: string, fn: (j: any) => void): string => edit(file, (t) => { const j = JSON.parse(t); fn(j); return JSON.stringify(j); });
    const mismatch = (files: string[], what: RegExp, label: string): void => {
      const r = checker(files);
      assert.equal(r.code, 1, `${label}: ${r.out}`);
      assert.match(r.out, what, label);
    };
    mismatch([jedit(f.parked, (j) => { j.note = j.note.replace("recorded declines", "recorded refusals"); }), f.openapi, f.privacy, f.runs], /MISMATCH \/api\/maintainer\/parked note, first differing character/, "one word of the parked note");
    mismatch([jedit(f.parked, (j) => { j.note = j.note.slice(0, -1); }), f.openapi, f.privacy, f.runs], /MISMATCH \/api\/maintainer\/parked note/, "the parked note's last character (a fragment passes no check)");
    mismatch([jedit(f.parked, (j) => { j.since = "18 November 2026"; }), f.openapi, f.privacy, f.runs], /MISMATCH \/api\/maintainer\/parked since/, "since");
    mismatch([jedit(f.parked, (j) => { j.park_after = 3; }), f.openapi, f.privacy, f.runs], /MISMATCH \/api\/maintainer\/parked park_after/, "park_after");
    mismatch([f.parked, jedit(f.openapi, (j) => { j.paths["/api/maintainer/parked"].get.responses["200"].content["application/json"].schema.required.push("nope"); }), f.privacy, f.runs], /MISMATCH openapi \/api\/maintainer\/parked schema/, "the route schema");
    mismatch([f.parked, jedit(f.openapi, (j) => { delete j.paths["/api/maintainer/parked"].get.responses["200"].content["application/json"].schema; }), f.privacy, f.runs], /MISMATCH openapi/, "a missing schema");
    const doc = /MISMATCH \/privacy document, first differing character/;
    mismatch([f.parked, f.openapi, edit(f.privacy, (t) => t.replace("Wake rows and decline records are kept", "Wake rows and decline records may be kept")), f.runs], doc, "a word in the Counters and logs paragraph");
    mismatch([f.parked, f.openapi, edit(f.privacy, (t) => t.replace("and not chosen by anyone it may concern", "and is chosen by anyone it may concern").replace("is not chosen by anyone it may concern", "is chosen by anyone it may concern")), f.runs], doc, "a word in the lawful-basis paragraph (declined-items sentences)");
    mismatch([f.parked, f.openapi, edit(f.privacy, (t) => t.replace("and the maintainer's wake log and its record of declined items are kept", "and the maintainer's wake log are kept")), f.runs], doc, "a word in the retention sentence");
    mismatch([f.parked, f.openapi, edit(f.privacy, (t) => t.replace("no automatic removal exists", "automatic removal exists")), f.runs], doc, "the last clause of the lawful-basis paragraph");
    mismatch([f.parked, f.openapi, edit(f.privacy, (t) => t.replace(/^Last updated: .+$/m, "Last updated: 1 January 2020")), f.runs], doc, "the privacy date");
    mismatch([f.parked, f.openapi, edit(f.privacy, (t) => t + "\nExtra line."), f.runs], doc, "text appended to the document (a section outside the paragraph)");
    mismatch([f.parked, f.openapi, edit(f.privacy, (t) => t.replace("Contact: ben240689@proton.me", "Contact: someone@example.org")), f.runs], doc, "the contact value");
    mismatch([f.parked, f.openapi, f.privacy, jedit(f.runs, (j) => { j.note = j.note.replace("offered", "shown"); })], /MISMATCH \/api\/maintainer-runs note/, "the runs note");
    assert.equal(checker([join(dir, "absent.json"), f.openapi, f.privacy, f.runs]).code, 2, "a missing file");
    assert.equal(checker([edit(f.parked, () => "<html>"), f.openapi, f.privacy, f.runs]).code, 2, "a non-JSON body");
    assert.equal(checker([f.parked]).code, 2, "the wrong argument count");
    // CRLF in the served privacy text is tolerated (the whole document is compared after line-ending normalisation).
    assert.deepEqual(checker([f.parked, f.openapi, edit(f.privacy, (t) => t.replace(/\n/g, "\r\n")), f.runs]), { code: 0, out: "OK" });
  });
});

test("the checker compares the source this repo serves: its expected paragraph, note and schema are the ones the real router returns (mutant: the checker reads its own copy)", async () => {
  const { PARKED_NOTE } = await import("../src/maintainer/parked.ts");
  const { MAINTAINER_RUNS_NOTE } = await import("../src/maintainer/runs.ts");
  const { renderPrivacy } = await import("../src/privacy.ts");
  const { createLocalD1, guestEnv, call } = await import("./helpers/guest.ts");
  const d1 = createLocalD1();
  try {
    const env = guestEnv(d1);
    assert.equal((await call(env, "GET", "/api/maintainer/parked")).body.note, PARKED_NOTE);
    assert.equal((await call(env, "GET", "/api/maintainer-runs")).body.note, MAINTAINER_RUNS_NOTE);
    const privacy = await (await (await import("../src/index.ts")).default.fetch(new Request("https://example.test/privacy"), env)).text();
    assert.equal(privacy, renderPrivacy());
    const dir = mkdtempSync(join(tmpdir(), "parked-live-"));
    try {
      const files = { parked: join(dir, "p.json"), openapi: join(dir, "o.json"), privacy: join(dir, "v.md"), runs: join(dir, "r.json") };
      writeFileSync(files.parked, JSON.stringify((await call(env, "GET", "/api/maintainer/parked")).body));
      writeFileSync(files.openapi, JSON.stringify((await call(env, "GET", "/openapi.json")).body));
      writeFileSync(files.privacy, privacy);
      writeFileSync(files.runs, JSON.stringify((await call(env, "GET", "/api/maintainer-runs")).body));
      assert.deepEqual(checker([files.parked, files.openapi, files.privacy, files.runs]), { code: 0, out: "OK" }, "what the real router serves passes the checker");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  } finally {
    d1.close();
  }
});

test("every Select-String literal in the deploy script is in the file it names (a checkout guard cannot name text the source lacks)", () => {
  let n = 0;
  for (const m of code.matchAll(/Select-String -Path "([^"]+)" -Pattern ("[^"]+") -SimpleMatch/g)) {
    const file = m[1]!;
    if (file === "wrangler.jsonc") continue;
    const lit = m[2]!.slice(1, -1);
    assert.ok(readFileSync(here(`../${file}`), "utf8").includes(lit), `${file} carries '${lit}'`);
    n++;
  }
  assert.ok(n >= 5, `checked ${n} literals`);
});

test("step 1b's check of the v6 pin run: a pass with the named test passes; a failure, a non-zero exit, no test run, a missing summary or the named test absent each STOP; and it names a real test", (t) => {
  const name = "v6 template hash: /api/attest serves the pinned v6 hash and no longer the v5 one";
  const cases: Array<[string, string, number, string]> = [
    ["ok", `✔ ${name} (5ms)\nℹ pass 6\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\n`, 0, ""],
    ["skipped", `﹣ ${name} (5ms) # SKIP\nℹ pass 5\nℹ fail 0\nℹ cancelled 0\nℹ skipped 1\nℹ todo 0\n`, 0, "skipped a test"],
    ["noskipline", `✔ ${name} (5ms)\nℹ pass 6\nℹ fail 0\n`, 0, "no skipped count"],
    ["todo", `﹣ ${name} (5ms) # TODO\nℹ pass 5\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0\nℹ todo 1\n`, 0, "has a todo test"],
    ["cancelled", `✖ ${name} (5ms)\nℹ pass 5\nℹ fail 0\nℹ cancelled 1\nℹ skipped 0\nℹ todo 0\n`, 0, "has a cancelled test"],
    ["notodoline", `✔ ${name} (5ms)\nℹ pass 6\nℹ fail 0\nℹ skipped 0\n`, 0, "no todo count"],
    ["fail", `✖ ${name} (5ms)\nℹ pass 5\nℹ fail 1\n`, 1, "failed"],
    ["exit", `✔ ${name} (5ms)\nℹ pass 6\nℹ fail 0\n`, 1, "failed"],
    ["none", "ℹ pass 0\nℹ fail 0\n", 0, "ran no test"],
    ["nosummary", `✔ ${name}\n`, 0, "no pass/fail summary"],
    ["unnamed", "✔ some other test (5ms)\nℹ pass 6\nℹ fail 0\n", 0, "did not run"],
  ];
  const pin = readFileSync(here("../test/constitution-v6-d1.test.ts"), "utf8");
  assert.ok(pin.includes(name) && pin.includes(V6), "the pinned test name and hash are in the v6 test file");
  assert.match(script, /\$v6Out = \(node --experimental-strip-types --test --test-reporter=spec \$V6_PIN_TEST_FILE 2>&1 \| Out-String\)/);
  assert.ok(!script.includes("FRONT_DOOR_TEMPLATE = ") || script.includes("export const FRONT_DOOR_TEMPLATE = `"), "only the extractor's marker, never a substring template proof");
  const run = runPs([
    "$ErrorActionPreference = 'Stop'",
    v6Block,
    ...cases.map(([n, out, c]) => `Write-Host ("RESULT ${n} [" + (Test-V6PinRun ${q(out)} ${c}) + "]")`),
  ]);
  if (!run) return t.skip("no PowerShell available");
  const out = results(run.out);
  for (const [n, , , expect] of cases) {
    assert.ok(n in out, `${n}: ${run.out}`);
    if (expect === "") assert.equal(out[n], "", n);
    else assert.ok(out[n]!.includes(expect), `${n}: '${out[n]}' mentions '${expect}'`);
  }
});

test("the constitution does not move: this wave does not touch FRONT_DOOR_TEMPLATE in src/doc.ts, and the evaluated v6 pin test is the one the deploy script re-runs", () => {
  const doc = readFileSync(here("../src/doc.ts"), "utf8");
  assert.ok(doc.includes("export const FRONT_DOOR_TEMPLATE = `"));
  assert.ok(!doc.includes("/api/maintainer/parked"), "the new route is NOT in the attested template (adding it there would mint v7)");
});

test("the rehearsal: scratch-only, applies the migration ONCE, refuses a scratch D1 that already carries the table, and both scripts snapshot the same other-objects set", () => {
  assert.equal((rcode.match(/--file/g) ?? []).length, 1, "the migration is applied by exactly one --file command");
  assert.ok(!/foreach \(\$round in 1, 2\)/.test(rcode), "the migration is never applied twice");
  assert.ok(rcode.includes("if (@($catBefore.Rows).Count -gt 0) { Stop-Here"), "an already-migrated scratch D1 STOPS");
  assert.ok(/WHERE tbl_name <> 'maintainer_declines' ORDER BY type, name/.test(rehearse) && /WHERE tbl_name <> 'maintainer_declines' ORDER BY type, name/.test(script), "both scripts snapshot the same other-objects set");
  assert.ok(rcode.includes("Test-ScratchTarget $Database") && /\$SCRATCH_DB = "commonhold-migtest"/.test(rehearse), "scratch-only");
  assert.ok(!/--remote[^\n]*\bcommonhold\b[^-]/.test(rcode.replace(/commonhold-migtest/g, "")), "never names the production database");
  assert.equal(/Test-RowsWritten|rows_written/.test(rcode), false, "no inherited write-cost probe (this wave's write is one ordinary insert)");
});
