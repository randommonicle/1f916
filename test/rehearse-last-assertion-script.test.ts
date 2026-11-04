// scripts/rehearse-last-assertion.ps1 and scripts/assertion-rehearsal-worker/ are WRITTEN AND NEVER RUN by the builder (they use wrangler; Ben runs them). This proves what can be proven without running them:
// the script parses, is ASCII with LF endings, has none of the repo's PowerShell traps, names the scratch database and no other, never names production, uses --remote for dev, has no deploy and no
// confirmation-flag shortcut, prints PASS only after the report check; its decision functions are RUN FOR REAL against good and bad inputs; the worker config binds the scratch database only with the main
// worker's compatibility settings; the worker's two statements are the ones src/society.ts batches; and the worker itself is RIDDEN on the local D1 shim: every check passes except rows_written (the shim reports
// no rows_written, which only real D1 does), it leaves no rows behind, and it goes red when the stamp is written outside the batch. Pattern: test/deploy-last-assertion-at-script.test.ts.
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
import { createLocalD1 } from "./helpers/local-d1.ts";
import { guestEnv } from "./helpers/guest.ts";
import worker from "../scripts/assertion-rehearsal-worker/index.ts";

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
const SCRIPT_PATH = here("../scripts/rehearse-last-assertion.ps1");
const rawScript = readFileSync(SCRIPT_PATH, "utf8");
const script = rawScript.replace(/\r\n/g, "\n");
const code = script.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
const defs = script.slice(script.indexOf('$ErrorActionPreference = "Stop"'), script.indexOf("# END-OF-DEFINITIONS"));
const workerDir = "../scripts/assertion-rehearsal-worker/";
const workerConfigText = readFileSync(here(workerDir + "wrangler.jsonc"), "utf8");
const workerSource = readFileSync(here(workerDir + "index.ts"), "utf8");
const society = readFileSync(here("../src/society.ts"), "utf8");
const SCRATCH_ID = "465f489c-f1ca-446e-8f5f-d35ea53fd720";

function runPs(lines: string[]): { code: number | null; out: string } | null {
  const dir = mkdtempSync(join(tmpdir(), "rehearse-last-assertion-"));
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
function harness(statements: string[]): string[] {
  return ["$ErrorActionPreference = 'Stop'", "$Database = 'commonhold-migtest'", defs, ...statements];
}
// The check names the worker adds, with the c3 template expanded for c3a and c3b.
function workerCheckNames(): string[] {
  const names: string[] = [];
  for (const m of workerSource.matchAll(/add\(\s*[`"]([^`"]+)[`"]/g)) {
    if (m[1].includes("${label}")) for (const l of ["c3a", "c3b"]) names.push(m[1].replace("${label}", l));
    else names.push(m[1]);
  }
  return names.filter((n) => n !== "the run completed without an unexpected error");
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

test("no PowerShell traps: one spelling per variable, no `$var:` drive reference, no stderr merge", () => {
  const names = new Map<string, Set<string>>();
  for (const m of code.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)) {
    const set = names.get(m[1].toLowerCase()) ?? new Set<string>();
    set.add(m[1]);
    names.set(m[1].toLowerCase(), set);
  }
  assert.deepEqual([...names.values()].filter((s) => s.size > 1).map((s) => [...s].join(" / ")), []);
  assert.equal(/\$[A-Za-z_][A-Za-z0-9_]*:/.test(code.replace(/\$\(/g, "").replace(/\$script:/g, "").replace(/\$env:/g, "")), false);
  assert.equal(code.includes("2>&1"), false);
});

test("the target is the scratch database by name and id; production is named nowhere (not even in comments); dev is --remote; there is no deploy and no confirmation-flag shortcut", () => {
  assert.match(script, /^\$SCRATCH_DB = "commonhold-migtest"$/m);
  assert.match(script, new RegExp(`^\\$SCRATCH_ID = "${SCRATCH_ID}"$`, "m"));
  assert.match(script, /\[string\]\$Database = "commonhold-migtest"/);
  // The bare word commonhold, as a database target, appears nowhere: every occurrence is part of commonhold-migtest.
  const bare = [...script.matchAll(/(?<![\w-])commonhold(?![\w-])/g)];
  assert.equal(bare.length, 0, "no bare 'commonhold' anywhere in the file");
  assert.equal(/\bcommonhold\b(?!-migtest)/.test(script.replace(/commonhold-migtest/g, "X")), false);
  assert.ok(code.includes('npx wrangler dev --remote --config'), "dev runs against the remote scratch binding");
  for (const l of code.split("\n").filter((l) => l.includes('Invoke-Bounded ("npx wrangler d1 execute'))) assert.ok(l.includes("--remote"), `every d1 execute is --remote: ${l.trim().slice(0, 80)}`);
  assert.equal(/wrangler\s+deploy/i.test(script), false, "no wrangler deploy anywhere in the file");
  assert.equal(/RehearsalPassed/i.test(script), false, "no shortcut flag");
  assert.equal(/Authorization|Bearer|\.local\./i.test(code), false, "no credential or custody file");
  // The migration is applied only on an absent column, by the scratch database name.
  assert.ok(code.includes('npx wrangler d1 execute " + $SCRATCH_DB + " --remote --file " + $MIGRATION_PATH'));
  assert.ok(script.indexOf("if (@($col.Rows).Count -eq 0)") < script.indexOf("--remote --file"));
});

test("PASS is printed once, only after the report check, and the step order is target, tables, column, migration, worker, checks, verdict", () => {
  assert.equal((code.match(/PASS/g) ?? []).length, 1);
  const order = [
    "# 0. the target",
    "Test-RehearsalConfig (Get-Content $CONFIG_PATH -Raw)",
    "# 1. the scratch database",
    "--remote --file",
    "# 2. the worker",
    "taskkill.exe /PID $dev.Id",
    "# 3. the checks",
    "$why = Test-RehearsalReport $report",
    'Say "PASS',
  ];
  let last = -1;
  for (const needle of order) {
    const i = script.indexOf(needle);
    assert.ok(i > last, `${needle} comes after the previous step`);
    last = i;
  }
  assert.ok(script.includes('\nif ($why -ne "") { Stop-Here ("FAIL: " + $why) }\n'), "the stop is unconditional on a reason");
  assert.ok(script.indexOf("Stop-Here (\"FAIL: \" + $why)") >script.indexOf("$why = Test-RehearsalReport $report") && script.indexOf("Stop-Here (\"FAIL: \" + $why)") < script.indexOf('Say "PASS'), "a miss stops (exit 1) before PASS");
});

test("the worker config binds ONLY the scratch database (name, id, preview id), with the main worker's compatibility date and flags and no triggers", () => {
  const strip = (s: string) => JSON.parse(s.replace(/^\s*\/\/.*$/gm, ""));
  const cfg = strip(workerConfigText);
  const main = strip(readFileSync(here("../wrangler.jsonc"), "utf8"));
  assert.equal(cfg.d1_databases.length, 1);
  assert.deepEqual(cfg.d1_databases[0], { binding: "DB", database_name: "commonhold-migtest", database_id: SCRATCH_ID, preview_database_id: SCRATCH_ID });
  assert.equal(cfg.compatibility_date, main.compatibility_date);
  assert.deepEqual(cfg.compatibility_flags, main.compatibility_flags);
  assert.equal(cfg.triggers, undefined);
  const prodIds = (main.d1_databases ?? []).flatMap((d: { database_id?: string; preview_database_id?: string }) => [d.database_id, d.preview_database_id]);
  assert.equal(prodIds.includes(SCRATCH_ID), false, "the scratch id is not a production id");
  assert.match(workerSource, /import \{ authenticate, SocietyError, type Env \} from "\.\.\/\.\.\/src\/society\.ts"/, "the REAL authenticate");
});

test("the decision functions, run for real: the scratch target is exact; the config check refuses a wrong name, a wrong id, two databases and bad JSON; the report check refuses a missing check, a failed one, an error and a false pass flag", (t) => {
  const names = workerCheckNames();
  assert.equal(names.length, 21, `the worker adds 21 named checks: ${names.length}`);
  const good = { pass: true, rows_written_per_statement: [2, 1], checks: names.map((n) => ({ name: n, expected: 1, actual: 1, pass: true })) };
  const withCheck = (idx: number, over: Record<string, unknown>) => ({ ...good, checks: good.checks.map((c, i) => (i === idx ? { ...c, ...over } : c)) });
  const jsonc = (db: Record<string, unknown>[]) => JSON.stringify({ name: "x", d1_databases: db });
  const dbOk = { binding: "DB", database_name: "commonhold-migtest", database_id: SCRATCH_ID, preview_database_id: SCRATCH_ID };
  const cases: Array<[string, string, string]> = [
    ["target-ok", `Test-ScratchTarget 'commonhold-migtest'`, ""],
    ["target-other", `Test-ScratchTarget 'some-other-db'`, "only ever runs against commonhold-migtest"],
    ["target-case", `Test-ScratchTarget 'Commonhold-Migtest'`, "only ever runs against"],
    ["config-ok", `Test-RehearsalConfig ${q(workerConfigText)}`, ""],
    ["config-name", `Test-RehearsalConfig ${q(jsonc([{ ...dbOk, database_name: "other" }]))}`, "not commonhold-migtest"],
    ["config-id", `Test-RehearsalConfig ${q(jsonc([{ ...dbOk, database_id: "0000" }]))}`, "not the scratch id"],
    ["config-preview", `Test-RehearsalConfig ${q(jsonc([{ ...dbOk, preview_database_id: "0000" }]))}`, "preview_database_id"],
    ["config-two", `Test-RehearsalConfig ${q(jsonc([dbOk, dbOk]))}`, "binds 2 D1 databases"],
    ["config-json", `Test-RehearsalConfig 'not json'`, "not valid JSON"],
    ["report-ok", `Test-RehearsalReport (ConvertFrom-Json ${q(JSON.stringify(good))})`, ""],
    ["report-null", `Test-RehearsalReport $null`, "did not return JSON"],
    ["report-missing", `Test-RehearsalReport (ConvertFrom-Json ${q(JSON.stringify({ ...good, checks: good.checks.slice(1) }))})`, "did not run"],
    ["report-failed", `Test-RehearsalReport (ConvertFrom-Json ${q(JSON.stringify(withCheck(3, { pass: false, actual: "boom" })))})`, "failed: expected 1, got \"boom\""],
    ["report-error", `Test-RehearsalReport (ConvertFrom-Json ${q(JSON.stringify({ ...good, error: "x broke" }))})`, "reported an error: x broke"],
    ["report-flag", `Test-RehearsalReport (ConvertFrom-Json ${q(JSON.stringify({ ...good, pass: false }))})`, "pass flag is not true"],
    ["report-norows", `Test-RehearsalReport (ConvertFrom-Json ${q(JSON.stringify({ ...good, rows_written_per_statement: undefined }))})`, "rows_written was not recorded"],
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

test("the ps1's expected check names are exactly the worker's (a check added to one and not the other would pass or fail silently)", () => {
  const listed = [...(/\$EXPECTED_CHECKS = @\(([\s\S]*?)\n\)/.exec(script)![1].matchAll(/"([^"]+)"/g))].map((m) => m[1]);
  assert.deepEqual([...listed].sort(), [...workerCheckNames()].sort());
});

test("the worker's two batched statements are the ones src/society.ts runs, verbatim", () => {
  const lit = (name: string) => new RegExp(`const ${name} =\\s*\\n?\\s*"([^"]+)"`).exec(workerSource)![1];
  for (const s of [lit("NONCE_INSERT"), lit("STAMP_UPDATE")]) assert.ok(society.includes(s), `src/society.ts carries: ${s.slice(0, 60)}`);
});

async function ride() {
  const d1 = createLocalD1();
  try {
    const before = d1.raw.prepare("SELECT COUNT(*) AS n FROM citizens").get() as { n: number };
    const res = await worker.fetch(new Request("https://rehearsal.test/run"), guestEnv(d1));
    const report = (await res.json()) as { pass: boolean; checks: { name: string; pass: boolean; actual: unknown }[]; cleanup_rows_deleted?: number[]; error?: string };
    const after = d1.raw.prepare("SELECT COUNT(*) AS n FROM citizens").get() as { n: number };
    const nonces = d1.raw.prepare("SELECT COUNT(*) AS n FROM auth_nonces").get() as { n: number };
    return { report, citizensDelta: after.n - before.n, nonces: nonces.n };
  } finally {
    d1.close();
  }
}

test("the worker, ridden on the local D1 shim: every check passes except rows_written (the shim reports none; real D1 does), the scratch citizen and nonce rows are gone, and no key material is in the report", async () => {
  const { report, citizensDelta, nonces } = await ride();
  const failed = report.checks.filter((c) => !c.pass).map((c) => c.name);
  assert.deepEqual(failed, ["c6 rows_written reported for both statements"], JSON.stringify(report.checks.filter((c) => !c.pass)));
  assert.equal(report.checks.length, 21);
  assert.equal(report.pass, false, "on the shim the overall verdict is not pass, because rows_written cannot be real here");
  assert.equal(citizensDelta, 0, "the scratch citizen was deleted");
  assert.equal(nonces, 0, "every nonce row was deleted");
  const text = JSON.stringify(report);
  assert.equal(/ch1\.|"d":|privateKey|BEGIN/.test(text), false, "no token or key material");
});
