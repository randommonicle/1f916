// Fix-pass tests for scripts/deploy-decided-event-id.ps1 (code exchange round 1): F3 the one-hour window holds for the whole sequence, F4 all four chains compared on length and head,
// F5 the served list must carry each expected historical pair exactly once. The script is never run; its definitions are executed for real in PowerShell.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
const script = readFileSync(here("../scripts/deploy-decided-event-id.ps1"), "utf8").replace(/\r\n/g, "\n");
const code = script.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
const defs = script.slice(script.indexOf('$ErrorActionPreference = "Stop"'), script.indexOf("# END-OF-DEFINITIONS"));

function runPs(lines: string[]): { code: number | null; out: string } | null {
  const dir = mkdtempSync(join(tmpdir(), "deploy-decided-event-id-wc-"));
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
const harness = (statements: string[]): string[] => ["$ErrorActionPreference = 'Stop'", "$script:PreflightAt = $null", defs, ...statements];
const grab = (out: string, name: string): string | null => {
  const m = new RegExp("RESULT " + name + " \\[(.*)\\]").exec(out);
  return m ? m[1] : null;
};

// ---------- F3: the window holds for the whole sequence ----------

test("F3: Test-SufficientWindow, run for real: a step that would start inside the window but could end outside it is refused; one that fits (to the second) passes", (t) => {
  const run = runPs(
    harness([
      "$t0 = Get-Date",
      'Write-Host ("RESULT fits [" + (Test-SufficientWindow $t0 $t0.AddSeconds(3480) 120) + "]")',
      'Write-Host ("RESULT overruns [" + (Test-SufficientWindow $t0 $t0.AddSeconds(3500) 120) + "]")',
      'Write-Host ("RESULT deploy [" + (Test-SufficientWindow $t0 $t0.AddSeconds(2600) 1080) + "]")',
      'Write-Host ("RESULT never [" + (Test-SufficientWindow $null $t0 1) + "]")',
      'Write-Host ("RESULT completion-in [" + (Test-SufficientWindow $t0 $t0.AddSeconds(3599) 0) + "]")',
      'Write-Host ("RESULT completion-out [" + (Test-SufficientWindow $t0 $t0.AddSeconds(3601) 0) + "]")',
    ]),
  );
  if (!run) return t.skip("no PowerShell available");
  assert.equal(grab(run.out, "fits"), "", run.out);
  assert.match(grab(run.out, "overruns") ?? "", /^the preflight completed 3500 s ago and the next bounded step may need up to 120 s, over the 3600 s window/);
  assert.match(grab(run.out, "deploy") ?? "", /may need up to 1080 s/);
  assert.equal(grab(run.out, "never"), "the D1 preflight has not completed");
  assert.equal(grab(run.out, "completion-in"), "");
  assert.match(grab(run.out, "completion-out") ?? "", /^the preflight completed 3601 s ago/);
});

test("F3: Assert-Window STOPS (exit 1) without letting the next line run when the step cannot finish inside the window, and when reconciliation finishes past it the success line is never reached", (t) => {
  const stopped = (age: number, label: string, required: number) =>
    runPs(harness([`$script:PreflightAt = (Get-Date).AddSeconds(-${age})`, `Assert-Window ${q(label)} ${required}`, 'Write-Host "[NEXT-STEP-STARTED]"']));
  const late = stopped(3550, "the worker deploy and its poll", 1080);
  if (!late) return t.skip("no PowerShell available");
  assert.equal(late.code, 1);
  assert.match(late.out, /\[STOP\] before the worker deploy and its poll: the preflight completed 35\d\d s ago/);
  assert.equal(late.out.includes("[NEXT-STEP-STARTED]"), false, "the step did not start");
  const ok = stopped(100, "the worker deploy and its poll", 1080)!;
  assert.equal(ok.code, 0);
  assert.ok(ok.out.includes("[NEXT-STEP-STARTED]"));
  const done = stopped(3601, "completion of post-activation reconciliation", 0)!;
  assert.equal(done.code, 1);
  assert.match(done.out, /\[STOP\] before completion of post-activation reconciliation/);
  assert.equal(done.out.includes("[NEXT-STEP-STARTED]"), false, "past the window the sequence stops before the success line");
});

test("F3: a D1 read after the preflight is refused when it cannot finish inside the window, before wrangler is touched", (t) => {
  const run = runPs(harness(["function Invoke-Bounded { Write-Host '[WRANGLER-TOUCHED]'; return @{ Code = 0; Out = '[]'; TimedOut = $false } }", "$script:PreflightAt = (Get-Date).AddSeconds(-3550)", `$null = Invoke-D1Command ${q("SELECT 1")} 'the pairs read'`, 'Write-Host "[READ-RETURNED]"']));
  if (!run) return t.skip("no PowerShell available");
  assert.equal(run.code, 1);
  assert.match(run.out, /\[STOP\] before the pairs read: the preflight completed/);
  assert.equal(run.out.includes("[WRANGLER-TOUCHED]"), false);
  // The same read before the preflight exists (the preflight itself) is not window-checked.
  const first = runPs(harness(["function Invoke-Bounded { return @{ Code = 0; Out = '[{\"results\":[{\"pending\":0}],\"success\":true}]'; TimedOut = $false } }", `$r = Invoke-D1Command ${q("SELECT 1")} 'the preflight'`, 'Write-Host ("RESULT pend [" + $r.Rows[0].pending + "]")']))!;
  assert.equal(grab(first.out, "pend"), "0", first.out);
});

test("F3: every bounded step is preceded by a window check sized to it, and completion is checked after the post-activation verification and before the success line and the ride", () => {
  const i = (needle: string): number => {
    const at = code.indexOf(needle);
    assert.ok(at >= 0, `found: ${needle}`);
    return at;
  };
  const migrationApply = script.indexOf('Invoke-Bounded ("npx wrangler d1 execute " + $PROD_DB + " --remote --file " + $MIGRATION_PATH_EXPECTED)');
  assert.ok(script.indexOf('Assert-Window "applying the migration" $WRANGLER_D1_SECONDS') > 0 && script.indexOf('Assert-Window "applying the migration" $WRANGLER_D1_SECONDS') < migrationApply, "the migration apply is window-checked first");
  assert.ok(code.includes("Assert-Window $label $WRANGLER_D1_SECONDS"), "every D1 read checks the window itself");
  assert.ok(code.includes('Assert-Window "the worker deploy and its poll" ($WRANGLER_DEPLOY_SECONDS + ($POLL_TRIES * ($POLL_DELAY_SECONDS + $POLL_READ_SECONDS)))'), "deploy plus its whole poll");
  assert.ok(code.includes('Assert-Window "the post-activation reconciliation (backfill, then two reads)" (3 * $WRANGLER_D1_SECONDS)'));
  const verified = i('Assert-Prod-Verified "after worker activation"');
  const completion = i('Assert-Window "completion of post-activation reconciliation" 0');
  assert.ok(verified < completion && completion < i('Say "[d1] post-activation:') && completion < i('Read-Attest "after the deploy"') && completion < i("[done]"));
  assert.ok(script.includes("-gt $WINDOW_SECONDS") && script.includes("($age + $requiredSeconds)"), "the comparison adds the step bound");
});

// ---------- F4: all four chains compared on sealed_entries and head ----------

const chains = (over: Record<string, Record<string, unknown>> = {}): string =>
  JSON.stringify({
    identity_log: { ok: true, sealed_entries: 40, head: "aaa", ...over.identity_log },
    treasury: { ok: true, sealed_entries: 18, head: "bbb", ...over.treasury },
    payouts: { ok: true, sealed_entries: 0, head: "0000", ...over.payouts },
    ballots: { ok: true, sealed_entries: 19, head: "ccc", ...over.ballots },
  });

test("F4: Test-ChainsUnchanged, run for real: identical reads pass; a changed payouts length, a changed head with an unchanged length, and an unreadable chain all stop, each naming the chain and field", (t) => {
  const cases: Array<[string, string, string]> = [
    ["same", chains(), ""],
    ["payouts-length", chains({ payouts: { sealed_entries: 1 } }), "chain payouts changed at sealed_entries during the deploy (0 -> 1)"],
    ["head-only", chains({ ballots: { head: "ddd" } }), "chain ballots changed at head during the deploy (ccc -> ddd)"],
    ["identity-length", chains({ identity_log: { sealed_entries: 41 } }), "chain identity_log changed at sealed_entries"],
    ["no-head", chains({ treasury: { head: null } }), "chain treasury changed at head"],
  ];
  const run = runPs(
    harness([
      `$before = ${q(chains())} | ConvertFrom-Json`,
      ...cases.map(([name, after]) => `Write-Host ("RESULT ${name} [" + (Test-ChainsUnchanged $before (${q(after)} | ConvertFrom-Json)) + "]")`),
      `$bare = ${q(JSON.stringify({ identity_log: { ok: true }, treasury: {}, payouts: {}, ballots: {} }))} | ConvertFrom-Json`,
      'Write-Host ("RESULT unreadable [" + (Test-ChainsUnchanged $bare $bare) + "]")',
    ]),
  );
  if (!run) return t.skip("no PowerShell available");
  for (const [name, , expect] of cases) {
    const got = grab(run.out, name);
    assert.ok(got !== null, `${name}: ${run.out}`);
    if (expect === "") assert.equal(got, "", name);
    else assert.ok(got!.includes(expect), `${name}: '${got}' mentions '${expect}'`);
  }
  assert.match(grab(run.out, "unreadable") ?? "", /carries no sealed_entries in either attest read/);
});

test("F4: the ride compares the two attest reads through Test-ChainsUnchanged and says exactly what is compared", () => {
  assert.ok(code.includes("Test-ChainsUnchanged $attBefore $attAfter"));
  assert.equal(/\$(identity|treasury|ballots)Before/.test(code), false, "the three-chain length variables are gone");
  assert.ok(script.includes("the four chains (identity_log, treasury, payouts, ballots) ok, with sealed_entries and head identical to before"));
  assert.ok(script.includes("all four chains - identity_log, treasury, payouts, ballots - ok, and each chain's sealed_entries and head identical before and after"));
  assert.ok(script.indexOf("Test-ChainsUnchanged $attBefore $attAfter") < script.indexOf("[ride] attest:"));
});

// ---------- F5: the served list must carry each expected historical pair exactly once ----------

const NOTE = "decided_event_id identifies the proposal_decided event recording this proposal's tally outcome.";
const PAIRS: Array<[number, number]> = [[1, 6], [2, 12], [5, 16], [6, 20], [7, 25], [8, 37]];
const row = ([id, e]: [number, number]) => ({ id, decided_event_id: e });
const listBody = (rows: unknown[]): string => JSON.stringify({ decided_event_id_note: NOTE, proposals: rows });

test("F5: Test-ListServed, run for real: a non-empty list missing proposal 1 fails, a duplicate fails, extra later proposals pass, the full six pass", (t) => {
  const cases: Array<[string, unknown[], string]> = [
    ["full", PAIRS.map(row), ""],
    ["extra-later", [...PAIRS.map(row), { id: 9, decided_event_id: null }, { id: 10, decided_event_id: null }], ""],
    ["only-8", [row([8, 37])], "proposal 1 is not served in the list"],
    ["missing-1", PAIRS.slice(1).map(row), "proposal 1 is not served in the list"],
    ["missing-8", PAIRS.slice(0, 5).map(row), "proposal 8 is not served in the list"],
    ["duplicate-5", [...PAIRS.map(row), row([5, 16])], "proposal 5 is served 2 times in the list, expected once"],
    ["wrong-pointer", [...PAIRS.slice(0, 5).map(row), row([8, 99])], "proposal 8 serves decided_event_id '99', expected 37"],
    ["no-key", [...PAIRS.slice(0, 5).map(row), { id: 8 }], "proposal 8 in the list has no decided_event_id key"],
  ];
  const run = runPs(harness(cases.map(([name, rows]) => `Write-Host ("RESULT ${name} [" + (Test-ListServed (Read-JsonBody @{ Body = ${q(listBody(rows))} })) + "]")`)));
  if (!run) return t.skip("no PowerShell available");
  for (const [name, , expect] of cases) {
    const got = grab(run.out, name);
    assert.ok(got !== null, `${name}: ${run.out}`);
    if (expect === "") assert.equal(got, "", name);
    else assert.ok(got!.includes(expect), `${name}: '${got}' mentions '${expect}'`);
  }
});

// END-OF-TESTS
