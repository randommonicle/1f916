// scripts/rehearse-resident-account.ps1 is WRITTEN AND NEVER RUN by the builder (it drives wrangler against the scratch D1, which prompts). It is proven here by what can be proven without running it: it parses, is ASCII with LF
// endings, refuses any database but the scratch one (the decision is RUN FOR REAL, and the script never names the production database), sends only the one-line verify SQL, applies only the 0026 file, and its decision functions
// (the catalogue, the other-objects comparison) are run against good and bad inputs, including the rows the real migration produces over node:sqlite. Mutating a copy turns the scratch-only refusal red.
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
const SCRIPT_PATH = here("../scripts/rehearse-resident-account.ps1");
const rawScript = readFileSync(SCRIPT_PATH, "utf8");
const script = rawScript.replace(/\r\n/g, "\n");
const code = script.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
const verifySql = readFileSync(here("../scripts/verify-resident-account.sql"), "utf8");
const migrationSql = readFileSync(here("../migrations/0026_resident_accounts.sql"), "utf8");
const defsOf = (s: string): string => s.slice(s.indexOf('$ErrorActionPreference = "Stop"'), s.indexOf("# END-OF-DEFINITIONS"));
const defs = defsOf(script);

function runPs(lines: string[]): { code: number | null; out: string } | null {
  const dir = mkdtempSync(join(tmpdir(), "rehearse-resident-account-"));
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
const d1json = (rows: unknown[]): string => `[{"results":${JSON.stringify(rows)},"success":true,"meta":{}}]`;
const harness = (statements: string[], d: string = defs): string[] => ["$ErrorActionPreference = 'Stop'", "$Database = 'commonhold-migtest'", d, ...statements];
const results = (out: string): Map<string, string> => new Map([...out.matchAll(/RESULT (\S+) \[(.*)\]/g)].map((m) => [m[1]!, m[2]!]));

function realCatalogue(): Array<{ kind: string; name: string; detail: string }> {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(migrationSql);
    return db.prepare(verifySql).all() as Array<{ kind: string; name: string; detail: string }>;
  } finally {
    db.close();
  }
}

test("the script parses under PowerShell's own parser, is ASCII only with LF endings, and has no PowerShell traps (one spelling per variable, no drive reference)", (t) => {
  assert.equal(/[^\x00-\x7f]/.test(rawScript), false, "ASCII only");
  assert.equal(rawScript.includes("\r"), false, "LF line endings");
  const names = new Map<string, Set<string>>();
  for (const m of code.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)) {
    const set = names.get(m[1].toLowerCase()) ?? new Set<string>();
    set.add(m[1]);
    names.set(m[1].toLowerCase(), set);
  }
  assert.deepEqual([...names.values()].filter((s) => s.size > 1).map((s) => [...s].join(" / ")), []);
  assert.equal(/\$[A-Za-z_][A-Za-z0-9_]*:/.test(code.replace(/\$\(/g, "").replace(/\$env:/g, "")), false);
  assert.equal(/2>&1/.test(code), false, "stderr is never merged");
  const parsed = parsePowerShellFile(SCRIPT_PATH);
  if (!parsed.available) return t.skip(`${parsed.reason}; the static checks ran`);
  assert.equal(parsed.errors, 0, `parse errors: ${parsed.detail}`);
});

test("the scratch database only: the name is pinned, never the production name, the only wrangler d1 commands name the scratch constant, and the only file applied is migration 0026", () => {
  assert.match(script, /^\$SCRATCH_DB = "commonhold-migtest"$/m);
  assert.match(script, /^\$MIGRATION_PATH = "migrations\/0026_resident_accounts\.sql"$/m);
  assert.equal(/\$PROD_DB|"commonhold"|'commonhold'/.test(code), false, "the production database name appears nowhere");
  const wrangler = code.split("\n").filter((l) => l.includes("npx wrangler"));
  assert.equal(wrangler.length, 2, "one read command and one apply command");
  for (const l of wrangler) assert.ok(l.includes("npx wrangler d1 execute \" + $SCRATCH_DB") || l.includes("npx wrangler d1 execute " + '" + $SCRATCH_DB'), `names the scratch constant: ${l.trim()}`);
  assert.equal((code.match(/--file /g) ?? []).length, 1);
  assert.ok(code.includes("--file \" + $MIGRATION_PATH"));
  assert.equal(/wrangler deploy|wrangler dev|DROP\s|DELETE\s|UPDATE\s|INSERT\s/i.test(code), false, "nothing deploys or writes but the migration file");
  assert.equal(/Authorization|Bearer|\.local\./i.test(code), false);
  const header = script.split("\n").filter((l) => /^\s*#/.test(l)).join("\n");
  for (const needle of ["BEN'S HAND ONLY", "THE SCRATCH DATABASE ONLY", "refuses any other", "applies it TWICE", "NO PRE-EXISTING OBJECT CHANGED", "-RehearsalPassed"]) assert.ok(header.includes(needle), needle);
});

test("any other database name is refused (run for real), the scratch name passes, and the refusal is case-sensitive; a mutated copy that compares loosely turns it red", (t) => {
  const cases: Array<[string, string]> = [
    ["scratch", "commonhold-migtest"],
    ["prod", "commonhold"],
    ["upper", "COMMONHOLD-MIGTEST"],
    ["suffix", "commonhold-migtest2"],
    ["empty", ""],
  ];
  const run = runPs(harness(cases.map(([name, v]) => `Write-Host ("RESULT ${name} [" + (Test-ScratchTarget ${q(v)}) + "]")`)));
  if (!run) return t.skip("no PowerShell available");
  const got = results(run.out);
  assert.equal(got.get("scratch"), "");
  for (const n of ["prod", "upper", "suffix", "empty"]) assert.match(got.get(n) ?? "NOT-RUN", /this rehearsal only ever runs against commonhold-migtest/, n);
  const mutated = script.replace("if ([string]$name -cne $SCRATCH_DB)", "if ($false)");
  assert.notEqual(mutated, script);
  const m = runPs(harness([`Write-Host ("RESULT prod [" + (Test-ScratchTarget 'commonhold') + "]")`], defsOf(mutated)))!;
  assert.equal(results(m.out).get("prod"), "", "mutant: the name check is gone -> production would be accepted");
});

test("the catalogue and the other-objects comparison, run for real: the real migration's five rows pass; a missing or reordered row, an unparsable read, a changed or dropped object, a tiny snapshot all fail", (t) => {
  const real = realCatalogue();
  const pinned = [...script.slice(script.indexOf("$EXPECTED_CATALOGUE = @("), script.indexOf("# Every sqlite_master row")).matchAll(/"((?:index|table|unique)\|[^"]+)"/g)].map((m) => m[1]!);
  assert.deepEqual(pinned, real.map((r) => `${r.kind}|${r.name}|${r.detail}`), "the pinned rows are what the migration builds");
  const rows = Array.from({ length: 25 }, (_, i) => ({ type: "table", name: `t${i}`, tbl_name: `t${i}`, sql: `CREATE TABLE t${i} (id INTEGER)` }));
  const cases: Array<[string, string, string]> = [
    ["cat-good", `Test-Catalogue (Read-D1Rows ${q(d1json(real))})`, ""],
    ["cat-short", `Test-Catalogue (Read-D1Rows ${q(d1json(real.slice(1)))})`, "returned 4 rows, expected 5"],
    ["cat-swapped", `Test-Catalogue (Read-D1Rows ${q(d1json([real[1], real[0], ...real.slice(2)]))})`, "catalogue row 1 is"],
    ["cat-unparsable", `Test-Catalogue (Read-D1Rows ${q("Error")})`, "no parsable result"],
    ["oth-same", `Test-OthersUnchanged (Read-D1Rows ${q(d1json(rows))}) (Read-D1Rows ${q(d1json(rows))}) 'x'`, ""],
    ["oth-changed", `Test-OthersUnchanged (Read-D1Rows ${q(d1json(rows))}) (Read-D1Rows ${q(d1json(rows.map((r, i) => (i === 2 ? { ...r, sql: "CREATE TABLE t2 (id INTEGER, x TEXT)" } : r))))}) 'x'`, "changed"],
    ["oth-dropped", `Test-OthersUnchanged (Read-D1Rows ${q(d1json(rows))}) (Read-D1Rows ${q(d1json(rows.slice(1)))}) 'x'`, "changed"],
    ["oth-small", `Test-OthersUnchanged (Read-D1Rows ${q(d1json(rows.slice(0, 2)))}) (Read-D1Rows ${q(d1json(rows.slice(0, 2)))}) 'x'`, "not the production schema"],
    ["sql-single", `Test-SingleLineSql (ConvertTo-SingleLineSql ${q(verifySql)})`, ""],
    ["sql-quote", `Test-SingleLineSql 'SELECT "a"'`, "double quote"],
    ["sql-other", `Test-SingleLineSql $OTHER_OBJECTS_SQL`, ""],
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
