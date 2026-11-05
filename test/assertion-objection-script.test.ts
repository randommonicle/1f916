// scripts/assertion-objection.ps1 (D-078 item 4 option B; brief O4, AO1, AO5; OT10 first half). The script is WRITTEN AND TESTED LOCALLY ONLY: nothing here runs wrangler or touches production. It is
// proven by what can be proven without that: it parses under PowerShell's own parser, is ASCII with LF, has none of the repo's PowerShell traps, REFUSES (run for real, before any read) a malformed
// handle, a missing or double mode, and a real run without the offline-verification assertion or the handle confirmation; its SQL templates are the ones test/assertion-objection-stamp-d1.test.ts runs against
// a real local D1; and every decision function is RUN FOR REAL against answers taken from the real router and real D1 (a stored row, the census walked across two real pages). Pattern: test/deploy-last-assertion-at-script.test.ts.
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
import { createLocalD1, guestEnv, call, freshIp } from "./helpers/guest.ts";
import { insertCitizen } from "./helpers/local-d1.ts";
import { seedKeyCitizen, citizenAssertion, bearerHeader, withClock } from "./helpers/council.ts";

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
const SCRIPT_PATH = here("../scripts/assertion-objection.ps1");
const rawScript = readFileSync(SCRIPT_PATH, "utf8");
const script = rawScript.split("\r\n").join("\n");
const code = script.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
const defs = script.slice(script.indexOf('$ErrorActionPreference = "Stop"'), script.indexOf("# END-OF-DEFINITIONS"));
const T0 = 1_800_000_000_000;

function runPs(lines: string[], fileMode: "file" | "script" = "file", args: string[] = []): { code: number | null; out: string } | null {
  const dir = mkdtempSync(join(tmpdir(), "assertion-objection-"));
  try {
    const ps1 = join(dir, "harness.ps1");
    writeFileSync(ps1, lines.join("\r\n"));
    const r = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", fileMode === "file" ? ps1 : SCRIPT_PATH, ...args], { encoding: "utf8" });
    if (r.error) return null;
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const q = (s: string): string => "'" + s.replace(/'/g, "''") + "'";
const harness = (statements: string[]): string[] => ["$ErrorActionPreference = 'Stop'", defs, ...statements];
const d1json = (rows: unknown[], changes?: number): string => JSON.stringify([{ results: rows, success: true, meta: changes === undefined ? {} : { changes } }]);
// Runs a harness and returns the named RESULT values (RESULT name [value]).
function results(statements: string[]): Record<string, string> | null {
  const run = runPs(harness(statements));
  if (!run) return null;
  const out: Record<string, string> = {};
  for (const m of run.out.matchAll(/^RESULT (\S+) \[(.*)\]\s*$/gm)) out[m[1]!] = m[2]!;
  assert.ok(Object.keys(out).length > 0, `the harness produced no RESULT lines: ${run.out}`);
  return out;
}
const say = (name: string, expr: string): string => `Write-Host ("RESULT ${name} [" + (${expr}) + "]")`;

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

test("no PowerShell traps: one spelling per variable, no `$var:` drive reference, no $pat, no stderr merge, wrangler only through the bounded helper, nothing signed, no route", () => {
  const names = new Map<string, Set<string>>();
  for (const m of code.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)) {
    const set = names.get(m[1]!.toLowerCase()) ?? new Set<string>();
    set.add(m[1]!);
    names.set(m[1]!.toLowerCase(), set);
  }
  assert.deepEqual([...names.values()].filter((s) => s.size > 1).map((s) => [...s].join(" / ")), []);
  assert.equal(/\$[A-Za-z_][A-Za-z0-9_]*:/.test(code.replace(/\$\(/g, "").replace(/\$script:/g, "").replace(/\$env:/g, "")), false);
  assert.equal(names.has("pat"), false);
  assert.equal(names.has("cols") && names.get("cols")!.size > 1, false);
  assert.equal(code.includes("2>&1"), false);
  const wranglerLines = code.split("\n").filter((l) => /wrangler/.test(l));
  assert.ok(wranglerLines.length > 0 && wranglerLines.every((l) => /Invoke-BoundedSql|Invoke-D1|Stop-Here|the SQL|wrangler d1 execute/.test(l)), wranglerLines.join("\n"));
  assert.equal(/wrangler deploy|git push|Invoke-WebRequest|Invoke-RestMethod|-Method\s+(Post|Put|Patch|Delete)|Authorization|Bearer|ch1\.|Ed25519|\.local\./i.test(code), false, "no deploy, no HTTP write, no key, no custody file");
  assert.equal(/INSERT INTO identity_events|identity_events/.test(code), false, "O5: nothing is chained");
});

test("the SQL templates: single-quote only, no `--`, key seats only, uphold clears the stored value, withdraw leaves it, nothing else is touched", () => {
  const get = (n: string): string => script.match(new RegExp("^[$]" + n + ' = "(.*)"$', "m"))![1]!;
  const up = get("UPHOLD_SQL_TEMPLATE");
  const wd = get("WITHDRAW_SQL_TEMPLATE");
  const rd = get("READ_ROW_SQL_TEMPLATE");
  for (const s of [up, wd, rd]) {
    assert.equal(s.includes('"'), false);
    assert.equal(s.includes("--"), false);
    assert.ok(s.includes("handle = '@HANDLE@'"));
  }
  assert.equal(up, "UPDATE citizens SET assertion_objected_at = CAST(strftime('%s','now') AS INTEGER) * 1000, last_assertion_at = NULL WHERE handle = '@HANDLE@' AND public_key IS NOT NULL");
  assert.equal(wd, "UPDATE citizens SET assertion_objected_at = NULL WHERE handle = '@HANDLE@' AND public_key IS NOT NULL");
  assert.equal(wd.includes("last_assertion_at"), false, "a withdrawal never restores or touches the value");
  assert.match(rd, /^SELECT /);
});

test("OT10: the script REFUSES, run for real before any read: a malformed handle, no mode, both modes, and a real run without -SignedRequestVerified or with a wrong -ConfirmHandle", (t) => {
  const refuse = (args: string[]): string | null => {
    const run = runPs([], "script", args);
    if (!run) return null;
    assert.equal(run.code, 1, `expected exit 1: ${run.out}`);
    assert.match(run.out, /\[STOP\]/);
    assert.equal(/\[before\]|\[write\]|wrangler/i.test(run.out.replace(/wrangler d1 execute/gi, "")), false, "it stopped before any read or write: " + run.out);
    return run.out;
  };
  const cases: [string[], RegExp][] = [
    [["-Handle", "bad handle!", "-Uphold", "-DryRun"], /handle must be 2-32/],
    [["-Handle", "x", "-Uphold", "-DryRun"], /handle must be 2-32/],
    [["-Handle", "a'b", "-Uphold", "-DryRun"], /handle must be 2-32/],
    [["-Handle", "a".repeat(33), "-Uphold", "-DryRun"], /handle must be 2-32/],
    [["-Handle", "keyed-a", "-DryRun"], /give -Uphold or -Withdraw/],
    [["-Handle", "keyed-a", "-Uphold", "-Withdraw", "-DryRun"], /not both/],
    [["-Handle", "keyed-a", "-Uphold"], /-SignedRequestVerified/],
    [["-Handle", "keyed-a", "-Uphold", "-SignedRequestVerified"], /-ConfirmHandle equal to -Handle/],
    [["-Handle", "keyed-a", "-Uphold", "-SignedRequestVerified", "-ConfirmHandle", "KEYED-A"], /-ConfirmHandle equal to -Handle/],
    [["-Handle", "keyed-a", "-Withdraw", "-ConfirmHandle", "keyed-a"], /-SignedRequestVerified/],
  ];
  for (const [args, re] of cases) {
    const out = refuse(args);
    if (out === null) {
      t.skip("powershell could not be started");
      return;
    }
    assert.match(out, re, args.join(" "));
  }
});

test("the decision functions, run for real: handle shape, mode, real-run gate, SQL building refuses a bad handle", () => {
  const r = results([
    ...["ab", "keyed-a", "Keyed_A-9", "a'b", "a b", "a", "x".repeat(33), "x".repeat(32), "a;b", "café"].map((h, i) => say(`shape${i}`, `Test-HandleShape ${q(h)}`)),
    say("modeNone", "Test-Mode $false $false"),
    say("modeBoth", "Test-Mode $true $true"),
    say("modeOne", "Test-Mode $true $false"),
    say("gateNoSigned", "Test-RealRunAllowed 'keyed-a' 'keyed-a' $false"),
    say("gateCase", "Test-RealRunAllowed 'keyed-a' 'Keyed-A' $true"),
    say("gateOk", "Test-RealRunAllowed 'keyed-a' 'keyed-a' $true"),
    say("sqlOk", "Get-UpholdSql 'keyed-a'"),
    "try { $null = Get-UpholdSql \"a'b\"; Write-Host 'RESULT sqlBad [built]' } catch { Write-Host 'RESULT sqlBad [refused]' }",
  ]);
  if (!r) return;
  const shapes = ["", "", "", "x", "x", "x", "x", "", "x", "x"];
  shapes.forEach((want, i) => assert.equal(r[`shape${i}`] === "", want === "", `shape ${i}: '${r[`shape${i}`]}'`));
  assert.match(r.modeNone!, /give -Uphold or -Withdraw/);
  assert.match(r.modeBoth!, /not both/);
  assert.equal(r.modeOne, "");
  assert.match(r.gateNoSigned!, /SignedRequestVerified/);
  assert.match(r.gateCase!, /exactly \(case-sensitive\)/);
  assert.equal(r.gateOk, "");
  assert.ok(r.sqlOk!.includes("WHERE handle = 'keyed-a' AND public_key IS NOT NULL"));
  assert.equal(r.sqlBad, "refused");
});

test("the write and stored-row checks, run for real over D1 answers: one row changed, a missing meta.changes fails, uphold needs flag set and stamp NULL, withdraw needs flag NULL", () => {
  const f = (name: string, text: string): string => {
    const dir = mkdtempSync(join(tmpdir(), "ao-d1-"));
    const p = join(dir, `${name}.json`);
    writeFileSync(p, text);
    return p;
  };
  const row = (flag: number | null, stamp: number | null, extra: Record<string, unknown> = {}) => ({ id: 3, handle: "keyed-a", has_key: 1, last_assertion_at: stamp, assertion_objected_at: flag, ...extra });
  const parse = (name: string, text: string): string => `$${name} = Read-D1Result (Get-Content -Raw ${q(f(name, text))})`;
  const r = results([
    parse("one", d1json([], 1)),
    parse("zero", d1json([], 0)),
    parse("two", d1json([], 2)),
    parse("none", d1json([])),
    say("changedOne", "Test-ChangedOne $one"),
    say("changedZero", "Test-ChangedOne $zero"),
    say("changedTwo", "Test-ChangedOne $two"),
    say("changedMissing", "Test-ChangedOne $none"),
    say("changedNull", "Test-ChangedOne $null"),
    say("unparsable", "($null -eq (Read-D1Result 'wrangler said no'))"),
    parse("pre", d1json([row(null, T0)])),
    parse("preSecret", d1json([row(null, null, { has_key: 0 })])),
    parse("preNone", d1json([])),
    parse("preTwo", d1json([row(null, null), row(null, null)])),
    say("preOk", "Test-PreRow $pre"),
    say("preSecret", "Test-PreRow $preSecret"),
    say("preNone", "Test-PreRow $preNone"),
    say("preTwo", "Test-PreRow $preTwo"),
    parse("upOk", d1json([row(T0, null)])),
    parse("upFlagNull", d1json([row(null, null)])),
    parse("upStamp", d1json([row(T0, T0)])),
    parse("upZero", d1json([row(0, null)])),
    say("upOk", "Test-StoredAfter $upOk 'uphold'"),
    say("upFlagNull", "Test-StoredAfter $upFlagNull 'uphold'"),
    say("upStamp", "Test-StoredAfter $upStamp 'uphold'"),
    say("upZero", "Test-StoredAfter $upZero 'uphold'"),
    parse("wdOk", d1json([row(null, null)])),
    parse("wdStamped", d1json([row(null, T0)])),
    parse("wdStill", d1json([row(T0, null)])),
    say("wdOk", "Test-StoredAfter $wdOk 'withdraw'"),
    say("wdStamped", "Test-StoredAfter $wdStamped 'withdraw'"),
    say("wdStill", "Test-StoredAfter $wdStill 'withdraw'"),
  ]);
  if (!r) return;
  assert.equal(r.changedOne, "");
  assert.match(r.changedZero!, /changed 0 rows/);
  assert.match(r.changedTwo!, /changed 2 rows/);
  assert.match(r.changedMissing!, /no meta\.changes/);
  assert.match(r.changedNull!, /no parsable result/);
  assert.equal(r.unparsable, "True");
  assert.equal(r.preOk, "");
  assert.match(r.preSecret!, /no public key/);
  assert.match(r.preNone!, /matched 0 citizen rows/);
  assert.match(r.preTwo!, /matched 2 citizen rows/);
  assert.equal(r.upOk, "");
  assert.match(r.upFlagNull!, /expected a whole number above zero/);
  assert.match(r.upStamp!, /expected NULL after an uphold/);
  assert.match(r.upZero!, /expected a whole number above zero/);
  assert.equal(r.wdOk, "");
  assert.equal(r.wdStamped, "", "AO1: a stamp after a withdrawal is permitted, never a failure");
  assert.match(r.wdStill!, /expected NULL after a withdrawal/);
});

// The real router's answers feed the census walk and the interleave test.
async function censusPages(d1: any, env: any): Promise<{ dir: string; pages: Record<string, any> }> {
  const dir = mkdtempSync(join(tmpdir(), "ao-census-"));
  const pages: Record<string, any> = {};
  let url = "/api/citizens";
  for (let n = 0; n < 10; n++) {
    const r = await call(env, "GET", url);
    assert.equal(r.status, 200);
    const key = n === 0 ? "start" : url.match(/since_id=(\d+)/)![1]!;
    pages[key] = r.body;
    writeFileSync(join(dir, `p_${key}.json`), JSON.stringify(r.body));
    if (!r.body.has_more) break;
    url = `/api/citizens?since=${r.body.next_since}&since_id=${r.body.next_since_id}`;
  }
  return { dir, pages };
}
const fetchBlock = (dir: string): string =>
  `$fetch = { param($u) $key = 'start'; if ($u -match 'since_id=([0-9]+)') { $key = $Matches[1] }; $p = Join-Path ${q(dir)} ('p_' + $key + '.json'); if (-not (Test-Path $p)) { return $null }; return (Get-Content -Raw $p | ConvertFrom-Json) }`;

test("AO1: the census is walked across REAL pages (next_since, next_since_id) to find a handle on page 2, an unreadable page is a failure, a missing handle is reported, and the served value is judged per mode", async () => {
  const d1 = createLocalD1();
  let dir = "";
  try {
    const env = guestEnv(d1);
    insertCitizen(d1, { handle: "commonhold-agent", created_at: T0 - 5_000_000 });
    for (let i = 0; i < 1004; i++) insertCitizen(d1, { handle: `filler-${i}`, created_at: T0 - 4_000_000 + i });
    const k = await seedKeyCitizen(d1, "keyed-late");
    d1.raw.prepare("UPDATE citizens SET created_at = ? WHERE id = ?").run(T0, k.id);
    await withClock(T0, async () => call(env, "GET", "/api/me", undefined, bearerHeader(await citizenAssertion(k), freshIp())));
    const got = await censusPages(d1, env);
    dir = got.dir;
    assert.ok(Object.keys(got.pages).length >= 2, "the census really spans two pages");
    const r = results([
      fetchBlock(dir),
      "$found = Find-CensusRow 'keyed-late' $fetch 5",
      say("foundHandle", "$found.Row.handle"),
      say("foundError", "$found.Error"),
      say("stampedWithdraw", "Test-CensusServed $found 'withdraw'"),
      say("stampedUphold", "Test-CensusServed $found 'uphold'"),
      "$missing = Find-CensusRow 'nobody-here' $fetch 5",
      say("missing", "Test-CensusServed $missing 'uphold'"),
      "$short = Find-CensusRow 'keyed-late' $fetch 1",
      say("short", "$short.Error"),
      "$broken = Find-CensusRow 'keyed-late' { param($u) $null } 5",
      say("broken", "$broken.Error"),
      "$nocursor = Find-CensusRow 'keyed-late' { param($u) [pscustomobject]@{ citizens = @(); has_more = $true } } 5",
      say("nocursor", "$nocursor.Error"),
      "$nokey = @{ Row = [pscustomobject]@{ handle = 'x' }; Error = '' }",
      say("nokey", "Test-CensusServed $nokey 'uphold'"),
    ]);
    if (!r) return;
    assert.equal(r.foundHandle, "keyed-late", "found on a later page");
    assert.equal(r.foundError, "");
    assert.match(r.stampedUphold!, /still serves last_assertion_at/, "an uphold with a served value is a failure");
    assert.equal(r.stampedWithdraw, "", "a withdrawal does not constrain the served value");
    assert.match(r.missing!, /not on any page/);
    assert.match(r.short!, /did not end within 1 pages/);
    assert.match(r.broken!, /unreadable/);
    assert.match(r.nocursor!, /carries no next_since/);
    assert.match(r.nokey!, /no last_assertion_at key/);
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
    d1.close();
  }
});

test("AO1: an assertion between a withdrawal and the public read passes the withdraw postconditions; an uphold judged against a census taken before it fails", async () => {
  const d1 = createLocalD1();
  let dir = "";
  try {
    const env = guestEnv(d1);
    insertCitizen(d1, { handle: "commonhold-agent" });
    const k = await seedKeyCitizen(d1, "keyed-a");
    const tmpl = (n: string): string => script.match(new RegExp("^[$]" + n + ' = "(.*)"$', "m"))![1]!;
    await withClock(T0, async () => call(env, "GET", "/api/me", undefined, bearerHeader(await citizenAssertion(k), freshIp())));
    const beforeUphold = await censusPages(d1, env);
    d1.raw.prepare(tmpl("UPHOLD_SQL_TEMPLATE").replace("@HANDLE@", "keyed-a")).run();
    d1.raw.prepare(tmpl("WITHDRAW_SQL_TEMPLATE").replace("@HANDLE@", "keyed-a")).run();
    // the interleave: the seat asserts AFTER the withdrawal and BEFORE the script's public read
    const t2 = T0 + 90_000;
    await withClock(t2, async () => call(env, "GET", "/api/me", undefined, bearerHeader(await citizenAssertion(k, null, { t: t2 }), freshIp())));
    const stored = d1.raw.prepare("SELECT id, handle, public_key IS NOT NULL AS has_key, last_assertion_at, assertion_objected_at FROM citizens WHERE handle = 'keyed-a'").all();
    assert.equal((stored[0] as any).last_assertion_at, t2, "the interleaved assertion did stamp");
    const afterInterleave = await censusPages(d1, env);
    dir = afterInterleave.dir;
    const storedFile = join(dir, "stored.json");
    writeFileSync(storedFile, d1json(stored as unknown[], 1));
    const r = results([
      `$stored = Read-D1Result (Get-Content -Raw ${q(storedFile)})`,
      say("storedWithdraw", "Test-StoredAfter $stored 'withdraw'"),
      fetchBlock(dir),
      "$found = Find-CensusRow 'keyed-a' $fetch 5",
      say("servedWithdraw", "Test-CensusServed $found 'withdraw'"),
      fetchBlock(beforeUphold.dir),
      "$stale = Find-CensusRow 'keyed-a' $fetch 5",
      say("servedUpholdStale", "Test-CensusServed $stale 'uphold'"),
    ]);
    rmSync(beforeUphold.dir, { recursive: true, force: true });
    if (!r) return;
    assert.equal(r.storedWithdraw, "", "withdraw: a stamp after the withdrawal is permitted");
    assert.equal(r.servedWithdraw, "");
    assert.match(r.servedUpholdStale!, /still serves last_assertion_at/);
  } finally {
    if (dir) rmSync(dir, { recursive: true, force: true });
    d1.close();
  }
});
