// scripts/deploy-recovery-unit.ps1 and scripts/rehearse-recovery-unit.ps1 are WRITTEN AND NEVER RUN by the builder (no deploy, no wrangler, not even -DryRun, which reads the live worker over HTTP). They are
// proven here by what can be proven without running them: both parse under PowerShell's own parser, are ASCII with LF endings, have none of the repo's PowerShell traps, carry the pins and the load-bearing
// step order, the pin block is run for real (step 0a stops on a placeholder before any git or network command), the pure check functions are run for real against good and bad inputs (the migration-state
// sort into absent / complete / partial, the roster, profile, doors and privacy checks, the v6 pin run, the rows_written verdict), and the nine catalogue rows both scripts pin are the rows the verify SQL
// really returns over the committed schema.sql (node:sqlite), and none over the pre-0027 schema. Derived from test/deploy-followup-wave-script.test.ts and test/deploy-resident-account-script.test.ts.
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
const DEPLOY_PATH = here("../scripts/deploy-recovery-unit.ps1");
const REHEARSE_PATH = here("../scripts/rehearse-recovery-unit.ps1");
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
const LIVE = "6f7ff7edaed84d6cad4e932ad4f592669775d138";
const V6 = "dc5f48213c29bcf844e0fbe7daf1bdb5416b3d57fbd06a8bd03f1061f34092b3";
const q = (s: string): string => "'" + s.replace(/'/g, "''") + "'";

function runPs(lines: string[]): { code: number | null; out: string } | null {
  const dir = mkdtempSync(join(tmpdir(), "deploy-recovery-unit-"));
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
const verifySql = readFileSync(here("../scripts/verify-recovery-unit.sql"), "utf8");
const catalogueOf = (db: DatabaseSync): string[] => (db.prepare(verifySql.replace(/;\s*$/, "")).all() as Array<{ kind: string; name: string; detail: string }>).map((r) => `${r.kind}|${r.name}|${r.detail}`);
const pinned = (text: string): string[] => {
  const body = text.slice(text.indexOf("$EXPECTED_CATALOGUE = @("), text.indexOf("\n)", text.indexOf("$EXPECTED_CATALOGUE = @(")));
  return [...body.matchAll(/^\s*"([^"]+)",?$/gm)].map((m) => m[1]!);
};

test("both scripts parse under PowerShell's own parser with zero errors, are ASCII only and have LF line endings", (t) => {
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

test("the pins: the v6 hash, the live base is the full sha of 6f7ff7ed, the reviewed commit ships as the named placeholder, the allowlist covers the scripts, the verify SQL, this test and docs/, -ExpectedCommit is mandatory, -RehearsalPassed exists, ONE migration (0027)", () => {
  assert.match(script, new RegExp(`^\\$V6_HASH = "${V6}"$`, "m"));
  assert.match(script, new RegExp(`^\\$LIVE_BASE_COMMIT = "${LIVE}"$`, "m"));
  // Ships as the placeholder; the hub then sets a full sha. Either state must leave the suite green, or setting the pin would fail the script's own npm test gate. The placeholder STOP is proved separately below.
  assert.match(script, /^\$REVIEWED_COMMIT = "(TO-BE-SET-BY-HUB|[0-9a-f]{40})"$/m);
  assert.match(script, /^\$REVIEWED_COMMIT_PLACEHOLDER = "TO-BE-SET-BY-HUB"$/m);
  assert.match(script, /^\$ALLOWED_PATHS_AFTER_REVIEW = @\("scripts\/deploy-recovery-unit\.ps1", "scripts\/rehearse-recovery-unit\.ps1", "scripts\/verify-recovery-unit\.sql", "test\/deploy-recovery-unit-script\.test\.ts", "docs\/"\)$/m);
  assert.match(script, /^\$MIGRATION_PATH = "migrations\/0027_resident_recoveries\.sql"$/m);
  assert.match(script, /^\$VERIFY_SQL_PATH = "scripts\/verify-recovery-unit\.sql"$/m);
  assert.match(script, /\[Parameter\(Mandatory = \$true\)\]\[string\]\$ExpectedCommit/);
  assert.match(script, /\[switch\]\$DryRun/);
  assert.match(script, /\[switch\]\$RehearsalPassed/);
  assert.ok(code.includes('$migMoves.Count -ne 1 -or $migMoves[0] -cne ("A`t" + $MIGRATION_PATH)'), "exactly one added migration since the live base, and it is this one");
  assert.ok(!/0026/.test(code), "no residue of the previous wave's migration number in code");
  assert.match(rehearse, /^\$SCRATCH_DB = "commonhold-migtest"$/m);
  assert.match(rehearse, /^\$MIGRATION_PATH = "migrations\/0027_resident_recoveries\.sql"$/m);
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
  const order = ["# BEGIN-PIN-CHECK", "# BEGIN-REHEARSAL-CHECK", "# BEGIN-DATE-CHECK", "git fetch origin", "# BEGIN-REVIEWED-SOURCE-CHECK", "# BEGIN-GATES", "# BEGIN-V6-PIN-CHECK", 'Read-Attest "before the deploy"', "# BEGIN-PROD-TARGET", "$script:PreflightAt = Get-Date", "if ($DryRun)", "# BEGIN-MIGRATION", "Assert-Prod-Verified \"after the migration\"", "# BEGIN-DEPLOY-AND-POLL", "# BEGIN-RECONCILE", 'Read-Attest "after the deploy"', "[ride] 16 public reads"];
  let last = -1;
  for (const needle of order) {
    const i = script.indexOf(needle);
    assert.ok(i > last, `${needle} comes after the previous step`);
    last = i;
  }
  assert.ok(!/IF NOT EXISTS makes|applies only if a table is absent|rerunning is safe|re-run is safe once/i.test(script), "no inherited 'rerunning is safe' claim");
  assert.ok(script.includes("does NOT claim that re-running is safe"), "the script says why instead");
  const mig = script.slice(script.indexOf("# BEGIN-MIGRATION"), script.indexOf("# END-MIGRATION-APPLY"));
  assert.ok(mig.includes('if ($migState.State -ceq "complete")'), "only a COMPLETE state skips; absent applies; partial never reaches here");
  assert.ok(code.includes('if ($migState.State -ceq "partial") { Stop-Here'), "a PARTIAL state STOPS before anything is written (step 4)");
  assert.equal((code.match(/--file/g) ?? []).length, 1, "--file only for the migration");
  assert.equal(/Invoke-WebRequest|Invoke-RestMethod|-Method\s+Post|-X\s+POST|--data/i.test(code), false, "the ride is GETs only");
  assert.ok(code.includes("$whyV6 = Test-V6PinRun $v6Out $v6Code") && code.includes('if ($whyV6 -ne "") { Stop-Here'), "the no-mint check is the evaluated v6 pin run");
  assert.ok(code.includes("-ceq $LIVE_BASE_COMMIT") || code.includes("-cne $LIVE_BASE_COMMIT"), "the live commit is proved against the pin");
  assert.ok(code.includes("$liveTemplate -cne $headTemplate"), "the template is also compared byte for byte between the live base and HEAD");
});

test("the catalogue both scripts pin is exactly what scripts/verify-recovery-unit.sql returns over the committed schema.sql, and over the pre-0027 schema only the guests tail row (mutant: a pinned row differs)", () => {
  const full = readFileSync(here("../schema.sql"), "utf8").replace(/\r\n/g, "\n");
  const fresh = new DatabaseSync(":memory:");
  const pre = new DatabaseSync(":memory:");
  try {
    fresh.exec(full);
    pre.exec(full.slice(0, full.indexOf("-- Recovery counts and commit days (migrations/0027_resident_recoveries.sql")));
    const real = catalogueOf(fresh);
    assert.equal(real.length, 9);
    assert.deepEqual(pinned(script), real, "the deploy script pins what the verify SQL returns");
    assert.deepEqual(pinned(rehearse), real, "the rehearsal pins the same rows");
    const mig = readFileSync(here("../migrations/0027_resident_recoveries.sql"), "utf8").replace(/\r\n/g, "\n");
    pre.exec(mig);
    assert.deepEqual(catalogueOf(pre), real, "the migration, applied to the pre-0027 schema, yields the pinned catalogue");
    const before = new DatabaseSync(":memory:");
    before.exec(full.slice(0, full.indexOf("-- Recovery counts and commit days (migrations/0027_resident_recoveries.sql")));
    assert.deepEqual(catalogueOf(before).map((r) => r.split("|")[0]), ["guests_tail"], "before the migration only the guests tail row exists");
    before.close();
  } finally {
    fresh.close();
    pre.close();
  }
});

test("the migration-state sort, run for real: none of the three objects is ABSENT, all three COMPLETE, any other mix PARTIAL (each of the three alone and each pair), a failed read an error, never 'absent' (mutant: partial treated as absent)", (t) => {
  const fns = fnText(defs, "function Get-MigrationState", "# BEGIN-V6-PIN-FN");
  const rows = (names: string[]): string => "@{ Rows = @(" + names.map((n) => `[pscustomobject]@{ kind = '${n.split("|")[0]}'; name = '${n.split("|")[1]}'; detail = 'x' }`).join(", ") + ") }";
  const R = ["column|guests.recoveries", "column|guests.last_recovered_at", "table|commit_days"];
  const cases: Array<[string, string]> = [
    ["none", rows(["guests_tail|guests"])],
    ["all", rows(R)],
    ["a", rows([R[0]!])],
    ["b", rows([R[1]!])],
    ["c", rows([R[2]!])],
    ["ab", rows([R[0]!, R[1]!])],
    ["ac", rows([R[0]!, R[2]!])],
    ["bc", rows([R[1]!, R[2]!])],
    ["dup", rows([R[0]!, R[0]!, R[1]!, R[2]!])],
    ["null", "$null"],
  ];
  const run = runPs([
    "$ErrorActionPreference = 'Stop'",
    `$MIGRATION_OBJECTS = @(${R.map(q).join(", ")})`,
    fns,
    ...cases.map(([n, r]) => `$s = Get-MigrationState (${r}); Write-Host ("RESULT ${n} [" + $s.State + "|" + $s.Present + "|" + $s.Error + "]")`),
  ]);
  if (!run) return t.skip("no PowerShell available");
  const out = results(run.out);
  assert.equal(out.none, "absent|0|");
  assert.equal(out.all, "complete|3|");
  for (const n of ["a", "b", "c", "ab", "ac", "bc"]) assert.match(out[n]!, /^partial\|[12]\|$/, n);
  assert.match(out.dup!, /returned 2 rows for column\|guests\.recoveries/);
  assert.match(out.null!, /no parsable result/);
});

test("the served checks, run for real: the roster (the live marker), the profile, the doors, the commit listing, the official block and the privacy page pass good input and fail each missing piece", (t) => {
  const fns = defs.slice(defs.indexOf("function Read-JsonBody"), defs.indexOf("# ---- the D1 helpers")) + "\n" + defs.slice(defs.indexOf("# ---- the served-answer checks ----"), defs.indexOf("function Get-MigrationState"));
  const marker = "recoveries counts the successful token replacements recorded by either recovery route since this field shipped on";
  const row = { number: 3, unit: "resident_record", recoveries: 0, last_recovered_at: null };
  const roster = (over: Record<string, unknown> = {}, rowOver: Record<string, unknown> = {}) => JSON.stringify({ total: 1, unit: "resident_record", note: marker + " 15 November 2026; x", residents: [{ ...row, ...rowOver }], ...over });
  const doors = (over: Record<string, unknown> = {}) => JSON.stringify({ rows: [], commits_by_day: [{ day: "2026-11-15", commit: "a".repeat(40), first_seen_at: 5 }], note: "x commits_by_day lists, for each UTC day in the window y", ...over });
  const official = (over: Record<string, unknown> = {}) => JSON.stringify({ residents: { count: 1, by_key: 1, by_account: 0, unit: "resident_record", counts_note: "counted in both", ...over } });
  const privacyOk = "Last updated: 15 November 2026 recoveries, the number of successful token recoveries recorded since 15 November 2026, and last_recovered_at, the time of the latest recorded one, or null when none is recorded.";
  const cap = (code: string, body: string): string => `@{ Code = ${q(code)}; Type = 'application/json'; Body = ${q(body)} }`;
  const cases: Array<[string, string, string]> = [
    ["roster_ok", `Test-RosterServed (Read-JsonBody @{ Body = ${q(roster())} })`, ""],
    ["roster_nounit", `Test-RosterServed (Read-JsonBody @{ Body = ${q(roster({ unit: undefined }))} })`, "no top-level unit"],
    ["roster_wrongunit", `Test-RosterServed (Read-JsonBody @{ Body = ${q(roster({ unit: "citizen" }))} })`, "no top-level unit"],
    ["roster_nonote", `Test-RosterServed (Read-JsonBody @{ Body = ${q(roster({ note: "x" }))} })`, "recoveries definition"],
    ["roster_rowunit", `Test-RosterServed (Read-JsonBody @{ Body = ${q(roster({}, { unit: undefined }))} })`, "has unit"],
    ["roster_norecoveries", `Test-RosterServed (Read-JsonBody @{ Body = ${q(roster({}, { recoveries: undefined }))} })`, "whole-number recoveries"],
    ["roster_nolast", `Test-RosterServed (Read-JsonBody @{ Body = ${q(roster({}, { last_recovered_at: undefined }))} })`, "no last_recovered_at"],
    ["roster_badlast", `Test-RosterServed (Read-JsonBody @{ Body = ${q(roster({}, { last_recovered_at: "yesterday" }))} })`, "neither null nor"],
    ["roster_json", `Test-RosterServed (Read-JsonBody @{ Body = '<html>' })`, "did not return JSON"],
    ["profile_ok", `Test-ProfileServed ${cap("200", JSON.stringify(row))}`, ""],
    ["profile_404", `Test-ProfileServed ${cap("404", JSON.stringify({ error: "No resident has the number 1" }))}`, ""],
    ["profile_bad404", `Test-ProfileServed ${cap("404", JSON.stringify({ error: "nothing" }))}`, "not the resident-not-found"],
    ["profile_500", `Test-ProfileServed ${cap("500", "{}")}`, "expected 200 or 404"],
    ["profile_nounit", `Test-ProfileServed ${cap("200", JSON.stringify({ number: 1, recoveries: 0, last_recovered_at: null }))}`, "has unit"],
    ["doors_ok", `Test-DoorsServed (Read-JsonBody @{ Body = ${q(doors())} })`, ""],
    ["doors_nofield", `Test-DoorsServed (Read-JsonBody @{ Body = ${q(doors({ commits_by_day: undefined }))} })`, "no commits_by_day"],
    ["doors_empty_ok", `Test-DoorsServed (Read-JsonBody @{ Body = ${q(doors({ commits_by_day: [] }))} })`, ""],
    ["doors_badentry", `Test-DoorsServed (Read-JsonBody @{ Body = ${q(doors({ commits_by_day: [{ day: "2026-11-15" }] }))} })`, "lacks day"],
    ["doors_nonote", `Test-DoorsServed (Read-JsonBody @{ Body = ${q(doors({ note: "x" }))} })`, "does not carry"],
    ["listed_ok", `Test-CommitListed (Read-JsonBody @{ Body = ${q(doors())} }) ${q("a".repeat(40))} ([datetime]'2026-11-15T10:00:00Z')`, ""],
    ["listed_otherday", `Test-CommitListed (Read-JsonBody @{ Body = ${q(doors())} }) ${q("a".repeat(40))} ([datetime]'2026-11-16T00:00:01Z')`, "lists no commits_by_day entry"],
    ["listed_othercommit", `Test-CommitListed (Read-JsonBody @{ Body = ${q(doors())} }) ${q("b".repeat(40))} ([datetime]'2026-11-15T10:00:00Z')`, "lists no commits_by_day entry"],
    ["official_ok", `Test-OfficialResidents (Read-JsonBody @{ Body = ${q(official())} })`, ""],
    ["official_nounit", `Test-OfficialResidents (Read-JsonBody @{ Body = ${q(official({ unit: undefined }))} })`, "expected resident_record"],
    ["official_nonote", `Test-OfficialResidents (Read-JsonBody @{ Body = ${q(official({ counts_note: "x" }))} })`, "counts_note"],
    ["privacy_ok", `Test-PrivacyServed ${q(privacyOk)} ([datetime]'2026-11-15T09:00:00Z')`, ""],
    ["privacy_olddate", `Test-PrivacyServed ${q(privacyOk)} ([datetime]'2026-11-16T09:00:00Z')`, "Last updated: 16 November 2026"],
    ["privacy_nosentence", `Test-PrivacyServed ${q("Last updated: 15 November 2026")} ([datetime]'2026-11-15T09:00:00Z')`, "does not carry"],
  ];
  const run = runPs([
    "$ErrorActionPreference = 'Stop'",
    `$RESIDENT_UNIT = 'resident_record'`,
    `$RECOVERIES_MARKER = ${q(marker)}`,
    `$PRIVACY_MARKERS = @(${q("recoveries, the number of successful token recoveries recorded since")}, ${q("last_recovered_at, the time of the latest recorded one, or null when none is recorded")})`,
    `$DOORS_NOTE_MARKER = 'commits_by_day lists, for each UTC day in the window'`,
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

test("the markers the script checks are the strings the code serves: the recoveries definition, the privacy sentence, the unit and the doors sentence", () => {
  const res = readFileSync(here("../src/resident.ts"), "utf8");
  const priv = readFileSync(here("../src/privacy.ts"), "utf8");
  const doors = readFileSync(here("../src/doors.ts"), "utf8");
  const guest = readFileSync(here("../src/guest-core.ts"), "utf8");
  for (const [name, text] of [["RECOVERIES_MARKER", res], ["DOORS_NOTE_MARKER", doors]] as const) {
    const m = new RegExp(`^\\$${name} = "([^"]+)"$`, "m").exec(script);
    assert.ok(m, name);
    assert.ok(text.includes(m![1]!), `${name} text is in the source`);
  }
  assert.ok(res.includes("recoveries counts the successful token replacements recorded by either recovery route since this field shipped on"));
  const markers = [...script.matchAll(/^\$PRIVACY_MARKERS = @\((.*)\)$/gm)][0]![1]!.match(/"[^"]+"/g)!.map((s) => s.slice(1, -1));
  assert.equal(markers.length, 2);
  for (const m of markers) assert.ok(priv.includes(m), `privacy.ts carries '${m}'`);
  assert.ok(script.includes('$RESIDENT_UNIT = "resident_record"') && guest.includes('RESIDENT_UNIT = "resident_record"'));
  // The page's own date moves with every later privacy change (17 November 2026: the parked list); the recoveries sentence keeps its own start date.
  assert.ok(res.includes('RECOVERIES_SINCE = "15 November 2026"') && priv.includes("recorded since 15 November 2026"), "the privacy page states the recoveries start date, the same day as RECOVERIES_SINCE");
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

test("the rehearsal: scratch-only, applies the migration ONCE, refuses a scratch D1 that already carries the objects, and its rows_written verdict is run for real (a duplicate must cost 0, a second stamp the same as the first)", (t) => {
  assert.ok(!/--remote --file[^\n]*\n[^\n]*foreach \(\$round in 1, 2\)/.test(rehearse), "no apply-twice loop");
  assert.equal((rcode.match(/--file/g) ?? []).length, 1, "the migration is applied by exactly one --file command");
  assert.ok(!/foreach \(\$round in 1, 2\)/.test(rcode), "the migration is never applied twice");
  assert.ok(rcode.includes('$already.Count -gt 0) { Stop-Here'), "an already-migrated scratch D1 STOPS");
  assert.ok(rcode.includes("Test-RowsWritten $rwFirst $rwDup $rwSecond"));
  assert.ok(/WHERE tbl_name <> 'commit_days' AND NOT \(type = 'table' AND name = 'guests'\)/.test(rehearse) && /WHERE tbl_name <> 'commit_days' AND NOT \(type = 'table' AND name = 'guests'\)/.test(script), "both scripts snapshot the same other-objects set");
  const fns = fnText(rdefs, "# \"\" when the three rows_written figures", "ZZZ-NOT-FOUND");
  void fns;
  const fn = rehearse.slice(rehearse.indexOf("function Test-RowsWritten"), rehearse.indexOf("# END-OF-DEFINITIONS"));
  const cases: Array<[string, number, number, number, string]> = [
    ["good2", 2, 0, 2, ""],
    ["good1", 1, 0, 1, ""],
    ["dupcosts", 2, 2, 2, "duplicate"],
    ["dupone", 2, 1, 2, "duplicate"],
    ["unequal", 2, 0, 1, "not constant"],
    ["zero", 0, 0, 0, "expected 1 or 2"],
    ["three", 3, 0, 3, "expected 1 or 2"],
  ];
  const run = runPs(["$ErrorActionPreference = 'Stop'", fn, ...cases.map(([n, a, b, c]) => `Write-Host ("RESULT ${n} [" + (Test-RowsWritten ${a} ${b} ${c}) + "]")`)]);
  if (!run) return t.skip("no PowerShell available");
  const out = results(run.out);
  for (const [n, , , , expect] of cases) {
    assert.ok(n in out, `${n}: ${run.out}`);
    if (expect === "") assert.equal(out[n], "", n);
    else assert.ok(out[n]!.includes(expect), `${n}: '${out[n]}' mentions '${expect}'`);
  }
});
