// scripts/deploy-register-free-path.ps1 is WRITTEN AND NEVER RUN by the builder (no deploy, no wrangler, not even -DryRun, which reads the live worker over HTTP). It is proven here by what can be
// proven without running it: it parses under PowerShell's own parser, is ASCII with LF endings, has none of the repo's PowerShell traps, has the load-bearing step order, no migration or D1 step,
// a single wrangler use, a ride of public GETs plus one read-only tools/list POST, step 0a stops on the placeholder before any git or network command, and the ride's checks (Test-RegisterFreeServed,
// Test-HeartbeatFreeServed, Test-MaxIdServed) are run for real against good and bad answers. Pattern: test/deploy-privacy-script.test.ts.
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
const SCRIPT_PATH = here("../scripts/deploy-register-free-path.ps1");
const rawScript = readFileSync(SCRIPT_PATH, "utf8");
const script = rawScript.replace(/\r\n/g, "\n");
const code = script.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
const defs = script.slice(script.indexOf('$ErrorActionPreference = "Stop"'), script.indexOf("# END-OF-DEFINITIONS"));
const pinBlock = script.slice(script.indexOf("# BEGIN-PIN-CHECK"), script.indexOf("# END-PIN-CHECK"));

function runPs(lines: string[]): { code: number | null; out: string } | null {
  const dir = mkdtempSync(join(tmpdir(), "deploy-register-free-"));
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

test("the pins: the v6 hash, the live base is the full sha of 5528b8d4, the reviewed commit is the hub's placeholder or a full 40-hex sha, the parameters are -ExpectedCommit (mandatory) and -DryRun", () => {
  assert.match(script, /^\$V6_HASH = "dc5f48213c29bcf844e0fbe7daf1bdb5416b3d57fbd06a8bd03f1061f34092b3"$/m);
  assert.match(script, /^\$LIVE_BASE_COMMIT = "5528b8d40d3577b806fe7b26fd5c0e3b5c241575"$/m);
  assert.match(script, /^\$REVIEWED_COMMIT = "(?:TO-BE-SET-BY-HUB|[0-9a-f]{40})"$/m);
  assert.match(script, /\[Parameter\(Mandatory = \$true\)\]\[string\]\$ExpectedCommit/);
  assert.match(script, /\[switch\]\$DryRun/);
});

test("step 0a STOPS on the placeholder before ANY git, npm, wrangler or network command (the pin block is run for real), and the same block passes a full sha", (t) => {
  const stubs = ["git", "npm", "npx", "curl.exe"].map((n) => `function ${n} { throw "${n} must not run in step 0a" }`);
  const harness = (reviewed: string): string[] => [
    "$ErrorActionPreference = 'Stop'",
    ...stubs,
    "function Stop-Here($msg) { Write-Host \"[STOP] $msg\"; exit 1 }",
    '$LIVE_BASE_COMMIT = "5528b8d40d3577b806fe7b26fd5c0e3b5c241575"',
    '$LIVE_BASE_PLACEHOLDER = "TO-BE-SET-BY-HUB-LIVE-BASE"',
    `$REVIEWED_COMMIT = "${reviewed}"`,
    '$REVIEWED_COMMIT_PLACEHOLDER = "TO-BE-SET-BY-HUB"',
    pinBlock,
    'Write-Host "[PASSED-PINS]"',
  ];
  const stopped = runPs(harness("TO-BE-SET-BY-HUB"));
  if (!stopped) return t.skip("no PowerShell available");
  assert.equal(stopped.code, 1);
  assert.match(stopped.out, /\[STOP\].*REVIEWED_COMMIT still holds the placeholder/);
  const bad = runPs(harness("ABCDEF0123456789ABCDEF0123456789ABCDEF01"))!;
  assert.match(bad.out, /\[STOP\].*not 40 lower-case hex/);
  const ok = runPs(harness("0123456789abcdef0123456789abcdef01234567"))!;
  assert.equal(ok.code, 0);
  assert.match(ok.out, /\[PASSED-PINS\]/);
});

test("the steps are in the load-bearing order, there is no migration or D1 step, wrangler is used once (the stamped deploy), and the ride's only POST is the fixed read-only tools/list", () => {
  const order = ["BEGIN-PIN-CHECK", "git fetch origin", "BEGIN-REVIEWED-SOURCE-CHECK", "BEGIN-GATES", 'Read-Attest "before the deploy"', "if ($DryRun)", "BEGIN-DEPLOY-AND-POLL", 'Read-Attest "after the deploy"', `Say ("[ride] POST /mcp tools/list`, "Test-MaxIdServed $proposalsNow"];
  let last = -1;
  for (const needle of order) {
    const i = script.indexOf(needle.startsWith("BEGIN-") ? "# " + needle : needle);
    assert.ok(i > last, `${needle} comes after the previous step`);
    last = i;
  }
  assert.equal(/\bd1\b|migrations apply|execute --remote/i.test(code.replace(/migrations\b/g, "").replace(/schema\.sql/g, "")), false, "no D1 command");
  assert.equal((code.match(/= \(npx wrangler /g) ?? []).length, 1, "exactly one executed wrangler command (the other mentions are text in messages)");
  assert.match(code, /npx wrangler deploy --var "CODE_COMMIT:\$headSha"/);
  assert.equal(/Invoke-WebRequest|Invoke-RestMethod|-Method\s+Post/i.test(code), false, "no PowerShell web cmdlets");
  assert.equal((code.match(/-X POST/g) ?? []).length, 1, "exactly one POST: the fixed tools/list body");
  assert.equal((code.match(/--data/g) ?? []).length, 1, "exactly one request body");
  // CODEX r1 M1: the POST is defined once AND called once at runtime, after the poll (never inside Wait-NewWorker or before the deploy).
  const calls = [...code.matchAll(/\(Get-ToolsList\)|= Get-ToolsList\b/g)].map((m) => m.index ?? -1);
  assert.equal(calls.length, 1, "Get-ToolsList is called exactly once");
  assert.ok(calls[0] > code.indexOf('Read-Attest "after the deploy"'), "the one tools/list call is in the ride, after the poll");
  assert.ok(code.includes('--data \'{"jsonrpc":"2.0","id":1,"method":"tools/list"}\''), "the POST body is the fixed tools/list call, nothing else");
  assert.ok(code.includes("src/doc.ts") && code.includes("migrations schema.sql"), "the no-mint and no-migration check names src/doc.ts, migrations and schema.sql");
});

test("Test-MaxIdServed, run for real, passes the live shape (ids 1 2 5 6 7 8, total 6, max_id 8) and fails each way it can be wrong", (t) => {
  const fn = defs.slice(defs.indexOf("function Test-MaxIdServed"), defs.indexOf("# Polls until the served block"));
  const body = (o: object): string => "'" + JSON.stringify(o).replace(/'/g, "''") + "'";
  const rows = (ids: number[]) => ids.map((id) => ({ id }));
  const good = { total: 6, max_id: 8, max_id_note: "n", has_more: false, proposals: rows([1, 2, 5, 6, 7, 8]) };
  const cases: Array<[string, string, string]> = [
    ["good", `@{ Code = "200"; Body = ${body(good)} }`, ""],
    ["status", `@{ Code = "500"; Body = ${body(good)} }`, "answered 500"],
    ["notjson", `@{ Code = "200"; Body = 'oops' }`, "did not return JSON"],
    ["absent", `@{ Code = "200"; Body = ${body({ ...good, max_id: undefined })} }`, "no max_id field"],
    ["nonote", `@{ Code = "200"; Body = ${body({ ...good, max_id_note: undefined })} }`, "no max_id_note"],
    ["null", `@{ Code = "200"; Body = ${body({ ...good, max_id: null })} }`, "whole number"],
    ["string", `@{ Code = "200"; Body = ${body({ ...good, max_id: "8" })} }`, "whole number"],
    ["more",`@{ Code = "200"; Body = ${body({ ...good, has_more: true })} }`, "has_more"],
    ["count", `@{ Code = "200"; Body = ${body({ ...good, total: 5 })} }`, "carries 6 rows"],
    ["above", `@{ Code = "200"; Body = ${body({ ...good, max_id: 7, total: 6 })} }`, "above max_id"],
    ["top", `@{ Code = "200"; Body = ${body({ ...good, max_id: 9 })} }`, "no served row carries max_id"],
    ["twice", `@{ Code = "200"; Body = ${body({ ...good, proposals: rows([1, 2, 5, 6, 8, 8]) })} }`, "twice"],
  ];
  const lines = ["$ErrorActionPreference = 'Stop'", fn, ...cases.map(([name, r]) => `Write-Host ("RESULT ${name} [" + (Test-MaxIdServed ${r}) + "]")`)];
  const run = runPs(lines);
  if (!run) return t.skip("no PowerShell available");
  for (const [name, , expect] of cases) {
    const m = new RegExp(`RESULT ${name} \\[(.*)\\]`).exec(run.out);
    assert.ok(m, `${name} produced a result: ${run.out}`);
    if (expect === "") assert.equal(m![1], "");
    else assert.ok(m![1].includes(expect), `${name}: '${m![1]}' mentions '${expect}'`);
  }
});

const NEW_TITLE = "Register as a citizen (\$1, HTTP only)";
const GOOD_DESC = "Taking part is free on this door: call guest_enter, then guest_comment. This tool does not register: citizenship takes a \$1 x402 payment over HTTP, and this MCP door cannot carry one. To become a citizen, use POST /api/register over HTTP.";
const OLD_DESC = "Disabled over MCP: registration takes a \$1 x402 payment over HTTP, and this MCP door cannot carry one. Use POST /api/register over HTTP instead.";

test("Test-RegisterFreeServed, run for real, passes the new tools/list and fails each way it can be wrong (the old title, a description that leads with the price, a lost phrase)", (t) => {
  const fn = defs.slice(defs.indexOf("function Test-RegisterFreeServed"), defs.indexOf("# \"\" when a GET /heartbeat.md answer"));
  const body = (o: object): string => "'" + JSON.stringify(o).replace(/'/g, "''") + "'";
  const list = (reg: object | null, n = 1) => ({ result: { tools: reg ? Array.from({ length: n }, () => reg).concat([{ name: "front_page", title: "Front page", description: "x" }]) : [{ name: "front_page" }] } });
  const reg = (over: object) => ({ name: "register", title: NEW_TITLE, description: GOOD_DESC, ...over });
  const cases: Array<[string, string, string]> = [
    ["good", `@{ Code = "200"; Body = ${body(list(reg({})))} }`, ""],
    ["status", `@{ Code = "502"; Body = ${body(list(reg({})))} }`, "answered 502"],
    ["notjson", `@{ Code = "200"; Body = 'oops' }`, "did not return JSON"],
    ["notools", `@{ Code = "200"; Body = '{"result":{}}' }`, "no result.tools"],
    ["absent", `@{ Code = "200"; Body = ${body(list(null))} }`, "carries 0 register tools"],
    ["twice", `@{ Code = "200"; Body = ${body(list(reg({}), 2))} }`, "carries 2 register tools"],
    ["oldtitle", `@{ Code = "200"; Body = ${body(list(reg({ title: "Register (HTTP only)" })))} }`, "the register title is"],
    ["olddesc", `@{ Code = "200"; Body = ${body(list(reg({ description: OLD_DESC })))} }`, "does not name guest_enter"],
    ["pricefirst", `@{ Code = "200"; Body = ${body(list(reg({ description: "A \$1 payment. Taking part is free: guest_enter. POST /api/register. this MCP door cannot carry one." })))} }`, "does not lead with the free path"],
    ["noroute", `@{ Code = "200"; Body = ${body(list(reg({ description: GOOD_DESC.replace("POST /api/register", "the HTTP door") })))} }`, "no longer names POST /api/register"],
    ["nophrase", `@{ Code = "200"; Body = ${body(list(reg({ description: GOOD_DESC.replace("this MCP door cannot carry one", "it cannot") })))} }`, "lost the phrase"],
  ];
  const lines = ["$ErrorActionPreference = 'Stop'", "$NEW_REGISTER_TITLE = '" + NEW_TITLE + "'", "$DOLLAR_ONE = '$1'", fn, ...cases.map(([name, r]) => `Write-Host ("RESULT ${name} [" + (Test-RegisterFreeServed ${r}) + "]")`)];
  const run = runPs(lines);
  if (!run) return t.skip("no PowerShell available");
  for (const [name, , expect] of cases) {
    const m = new RegExp(`RESULT ${name} \\[(.*)\\]`).exec(run.out);
    assert.ok(m, `${name} produced a result: ${run.out}`);
    if (expect === "") assert.equal(m![1], "");
    else assert.ok(m![1].includes(expect), `${name}: '${m![1]}' mentions '${expect}'`);
  }
});

test("Test-HeartbeatFreeServed, run for real, passes the new opening and fails when it is absent, late or the page is not a 200", (t) => {
  const fn = defs.slice(defs.indexOf("function Test-HeartbeatFreeServed"), defs.indexOf("# Polls until the served block"));
  const LINE = "No credential? Taking part is free as a guest: go to section 6, the guest routine.";
  const doc = (b: string) => "'" + b.replace(/'/g, "''") + "'";
  const cases: Array<[string, string, string]> = [
    ["good", `@{ Code = "200"; Body = ${doc("# C heartbeat\n\n" + LINE + "\n\nA routine for an agent that holds a x citizenship.")} }`, ""],
    ["status", `@{ Code = "500"; Body = ${doc(LINE)} }`, "answered 500"],
    ["old", `@{ Code = "200"; Body = ${doc("# C heartbeat\n\nA routine for an agent that holds a x citizenship.")} }`, "does not carry the new opening line"],
    ["late", `@{ Code = "200"; Body = ${doc("A routine for an agent that holds a x citizenship.\n\n" + LINE)} }`, "comes after"],
  ];
  const lines = ["$ErrorActionPreference = 'Stop'", '$NEW_HEARTBEAT_LINE = "' + LINE + '"', fn, ...cases.map(([name, r]) => `Write-Host ("RESULT ${name} [" + (Test-HeartbeatFreeServed ${r}) + "]")`)];
  const run = runPs(lines);
  if (!run) return t.skip("no PowerShell available");
  for (const [name, , expect] of cases) {
    const m = new RegExp(`RESULT ${name} \\[(.*)\\]`).exec(run.out);
    assert.ok(m, `${name} produced a result: ${run.out}`);
    if (expect === "") assert.equal(m![1], "");
    else assert.ok(m![1].includes(expect), `${name}: '${m![1]}' mentions '${expect}'`);
  }
});

test("the before-read refuses a live worker already serving the new heartbeat line (GETs only: the register title is read once, after the poll), and still requires max_id live", () => {
  assert.ok(code.includes("Contains($NEW_HEARTBEAT_LINE)"));
  assert.equal(code.includes("Contains($NEW_REGISTER_TITLE)"), false, "no before-deploy tools/list read (CODEX r1 M1)");
  assert.ok(code.includes("Test-MaxIdServed $proposalsBefore"));
  assert.ok(code.includes('"/api/proposal/8"'));
});
