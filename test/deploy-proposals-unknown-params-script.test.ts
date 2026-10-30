// scripts/deploy-proposals-unknown-params.ps1 is WRITTEN AND NEVER RUN by the builder (no deploy, no wrangler, not even -DryRun, which reads the live worker over HTTP). It is proven here by what can be
// proven without running it: it parses under PowerShell's own parser, is ASCII with LF endings, has none of the repo's PowerShell traps, has the load-bearing step order, no migration or D1 step,
// a single wrangler use, a ride of public GETs with no request body at all, step 0a stops on the placeholder before any git or network command, and the three served-answer checks
// (Test-UnknownParamRefused, Test-RepeatedParamRefused, Test-ProposalsPlainServed) are run for real against good and bad captured answers. Pattern: test/deploy-moderation-gaps-script.test.ts.
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
const SCRIPT_PATH = here("../scripts/deploy-proposals-unknown-params.ps1");
const rawScript = readFileSync(SCRIPT_PATH, "utf8");
const script = rawScript.replace(/\r\n/g, "\n");
const code = script.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
const defs = script.slice(script.indexOf('$ErrorActionPreference = "Stop"'), script.indexOf("# END-OF-DEFINITIONS"));
const pinBlock = script.slice(script.indexOf("# BEGIN-PIN-CHECK"), script.indexOf("# END-PIN-CHECK"));

const NOTE_MARKER = "Only since and since_id are accepted";
const LIVE = "83632cb0b70a5b685ceee87236fd7a89a871a276";

function runPs(lines: string[]): { code: number | null; out: string } | null {
  const dir = mkdtempSync(join(tmpdir(), "deploy-proposals-unknown-params-"));
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

test("the pins: the v6 hash, the live base is the full sha of 83632cb0, the reviewed commit is the full sha of db5566d4, the allowlist is this script, its test and docs/, the parameters are -ExpectedCommit (mandatory) and -DryRun", () => {
  assert.match(script, /^\$V6_HASH = "dc5f48213c29bcf844e0fbe7daf1bdb5416b3d57fbd06a8bd03f1061f34092b3"$/m);
  assert.match(script, /^\$LIVE_BASE_COMMIT = "83632cb0b70a5b685ceee87236fd7a89a871a276"$/m);
  assert.match(script, /^\$REVIEWED_COMMIT = "db5566d40be30ae37f429b75b8ac6407b09fb80d"$/m);
  assert.match(script, /^\$ALLOWED_PATHS_AFTER_REVIEW = @\("scripts\/deploy-proposals-unknown-params\.ps1", "test\/deploy-proposals-unknown-params-script\.test\.ts", "docs\/"\)$/m);
  assert.match(script, /\[Parameter\(Mandatory = \$true\)\]\[string\]\$ExpectedCommit/);
  assert.match(script, /\[switch\]\$DryRun/);
});

test("step 0a STOPS on either placeholder or a malformed pin before ANY git, npm, wrangler or network command (the pin block is run for real), and the same block passes full shas", (t) => {
  const stubs = ["git", "npm", "npx", "curl.exe"].map((n) => `function ${n} { throw "${n} must not run in step 0a" }`);
  const harness = (live: string, reviewed: string): string[] => [
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
  const stopped = runPs(harness(LIVE, "TO-BE-SET-BY-HUB"));
  if (!stopped) return t.skip("no PowerShell available");
  assert.equal(stopped.code, 1);
  assert.match(stopped.out, /\[STOP\].*REVIEWED_COMMIT still holds the placeholder/);
  assert.match(runPs(harness("TO-BE-SET-BY-HUB-LIVE-BASE", FULL))!.out, /\[STOP\].*LIVE_BASE_COMMIT still holds the placeholder/);
  assert.match(runPs(harness(LIVE, "ABCDEF0123456789ABCDEF0123456789ABCDEF01"))!.out, /\[STOP\].*not 40 lower-case hex/);
  assert.match(runPs(harness("83632cb0", FULL))!.out, /\[STOP\].*LIVE_BASE_COMMIT.*not 40 lower-case hex/);
  const ok = runPs(harness(LIVE, FULL))!;
  assert.equal(ok.code, 0);
  assert.match(ok.out, /\[PASSED-PINS\]/);
});

test("the steps are in the load-bearing order, there is no migration or D1 step, wrangler is used once (the stamped deploy), and the ride sends no POST and no request body", () => {
  const order = ["BEGIN-PIN-CHECK", "git fetch origin", "BEGIN-REVIEWED-SOURCE-CHECK", "BEGIN-GATES", 'Read-Attest "before the deploy"', "if ($DryRun)", "BEGIN-DEPLOY-AND-POLL", 'Read-Attest "after the deploy"', "Test-UnknownParamRefused $unknownNow", "Test-RepeatedParamRefused $repeatNow", "Test-ProposalsPlainServed $plainNow"];
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
  assert.equal(/-X\s+POST|--data/.test(code), false, "no POST and no request body (PS 5.1 strips inner quotes from native arguments, Addendum 104 s8)");
  assert.ok(code.includes("src/doc.ts") && code.includes("migrations schema.sql"), "the no-mint and no-migration check names src/doc.ts, migrations and schema.sql");
});

test("the marker and urls are what the served route carries: the note marker is in src/governance.ts, the codes are thrown there, and the script pins the urls", () => {
  const gov = readFileSync(here("../src/governance.ts"), "utf8");
  assert.ok(gov.includes(NOTE_MARKER), "src/governance.ts note carries the marker");
  assert.ok(gov.includes('"unknown_query_parameter"') && gov.includes('"repeated_query_parameter"'));
  assert.ok(script.includes(`$PROPOSALS_NOTE_MARKER = "${NOTE_MARKER}"`));
  assert.ok(script.includes('$PROPOSALS_STATUS_URL = "$BASE/api/proposals?status=open"'));
  assert.ok(script.includes('$PROPOSALS_REPEAT_URL = "$BASE/api/proposals?since=1&since=2"'));
});

test("the source checks name literals the checkout carries: assertProposalsQuery in governance.ts and called in index.ts, and every other Select-String literal is in its file", () => {
  assert.ok(code.includes('Select-String -Path "src/governance.ts" -Pattern "export function assertProposalsQuery("'));
  assert.ok(code.includes('Select-String -Path "src/index.ts" -Pattern "assertProposalsQuery(url.searchParams)"'));
  let n = 0;
  for (const m of code.matchAll(/Select-String -Path "([^"]+)" -Pattern ('[^']+'|"[^"]+")/g)) {
    const file = m[1];
    if (file === "wrangler.jsonc") continue;
    const lit = m[2].slice(1, -1);
    assert.ok(readFileSync(here(`../${file}`), "utf8").includes(lit), `${file} carries '${lit}'`);
    n++;
  }
  assert.ok(n >= 8, `checked ${n} literals`);
});

type Cap = { code: string; body: string };
const bodyOf = (c: string, e: string, extra = ""): string => JSON.stringify({ error: e, code: c, ...(extra ? { x: extra } : {}) });

test("the served-answer checks, run for real, pass the new behaviour and fail a 200, a wrong code, an error not naming status, a bad status code, and a non-JSON body", (t) => {
  const fns = defs.slice(defs.indexOf("function Read-JsonBody"), defs.indexOf("# Polls (GETs only)"));
  const q = (s: string): string => "'" + s.replace(/'/g, "''") + "'";
  const cap = (c: Cap): string => `@{ Code = ${q(c.code)}; Type = 'application/json'; Body = ${q(c.body)} }`;
  const goodUnknown: Cap = { code: "400", body: bodyOf("unknown_query_parameter", "Unknown query parameter: status. GET /api/proposals accepts only: since, since_id.") };
  const goodRepeat: Cap = { code: "400", body: bodyOf("repeated_query_parameter", "Repeated query parameter: since.") };
  const goodPlain: Cap = { code: "200", body: JSON.stringify({ proposals: [], note: `total is real. ${NOTE_MARKER}, each at most once.` }) };
  const cases: Array<[string, string, Cap, string]> = [
    ["unknown-good", "Test-UnknownParamRefused", goodUnknown, ""],
    ["unknown-200", "Test-UnknownParamRefused", { code: "200", body: goodPlain.body }, "expected 400"],
    ["unknown-wrongcode", "Test-UnknownParamRefused", { code: "400", body: bodyOf("repeated_query_parameter", "Unknown query parameter: status.") }, "expected unknown_query_parameter"],
    ["unknown-case", "Test-UnknownParamRefused", { code: "400", body: bodyOf("Unknown_Query_Parameter", "Unknown query parameter: status.") }, "expected unknown_query_parameter"],
    ["unknown-noname", "Test-UnknownParamRefused", { code: "400", body: bodyOf("unknown_query_parameter", "Unknown query parameter: filter.") }, "does not name"],
    ["unknown-500", "Test-UnknownParamRefused", { code: "500", body: bodyOf("unknown_query_parameter", "status") }, "expected 400"],
    ["unknown-html", "Test-UnknownParamRefused", { code: "400", body: "<html>bad</html>" }, "not with a JSON body"],
    ["unknown-empty", "Test-UnknownParamRefused", { code: "400", body: "" }, "not with a JSON body"],
    ["repeat-good", "Test-RepeatedParamRefused", goodRepeat, ""],
    ["repeat-200", "Test-RepeatedParamRefused", { code: "200", body: goodPlain.body }, "expected 400"],
    ["repeat-wrongcode", "Test-RepeatedParamRefused", goodUnknown, "expected repeated_query_parameter"],
    ["plain-good", "Test-ProposalsPlainServed", goodPlain, ""],
    ["plain-400", "Test-ProposalsPlainServed", goodUnknown, "expected 200"],
    ["plain-nonote", "Test-ProposalsPlainServed", { code: "200", body: JSON.stringify({ proposals: [], note: "total is real." }) }, "does not contain"],
    ["plain-nojson", "Test-ProposalsPlainServed", { code: "200", body: "not json" }, "did not return JSON"],
  ];
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    `$PROPOSALS_NOTE_MARKER = ${q(NOTE_MARKER)}`,
    fns,
    ...cases.map(([name, fn, c]) => `Write-Host ("RESULT ${name} [" + (${fn} ${cap(c)}) + "]")`),
  ];
  const run = runPs(lines);
  if (!run) return t.skip("no PowerShell available");
  for (const [name, , , expect] of cases) {
    const m = new RegExp(`RESULT ${name} \\[(.*)\\]`).exec(run.out);
    assert.ok(m, `${name} produced a result: ${run.out}`);
    if (expect === "") assert.equal(m![1], "", name);
    else assert.ok(m![1].includes(expect), `${name}: '${m![1]}' mentions '${expect}'`);
  }
});

test("the before-read refuses a worker already refusing and one not answering 200; the poll and the ride both use the checks", () => {
  assert.ok(code.includes('-ceq "unknown_query_parameter") { Stop-Here'));
  assert.ok(code.includes('[string]$proposalsBefore.Code -cne "200"'));
  assert.ok(code.includes("Test-UnknownParamRefused (Get-Text $PROPOSALS_STATUS_URL 30)"));
  assert.ok(code.includes("Wait-NewWorker $headSha $versionId $POLL_TRIES"));
  assert.ok(code.includes('"/privacy"') && code.includes('"/api/proposal/8"'));
});

test("CODEX r1: the ride re-checks code identity, HEAD and a clean tree are re-read just before wrangler bundles, and the MCP note prints its whole JSON", (t) => {
  // Order: the re-read sits after step 0's checks and before the one wrangler deploy; the ride's identity check sits after the poll.
  const reread = code.indexOf("$headNow = (git rev-parse HEAD).Trim()");
  const dirtyNow = code.indexOf("$dirtyNow = @(git status --porcelain)");
  const deploy = code.indexOf('npx wrangler deploy --var "CODE_COMMIT:$headSha"');
  const poll = code.indexOf("Wait-NewWorker $headSha $versionId $POLL_TRIES");
  const rideId = code.indexOf("Test-CodeIdentityServed $attAfter.code $headSha $versionId");
  assert.ok(reread > code.indexOf("# END-REVIEWED-SOURCE-CHECK") && reread < deploy, "HEAD re-read between step 0 and the deploy");
  assert.ok(dirtyNow > reread && dirtyNow < deploy, "clean tree re-read between step 0 and the deploy");
  assert.ok(code.includes("$headNow -cne $headSha") && code.includes("$dirtyNow.Count -gt 0) { Stop-Here"));
  assert.ok(rideId > poll && rideId < code.indexOf("[ride] attest:"), "the ride's attest read is identity-checked before it is reported");
  assert.ok(script.includes(`{"status":"open"} on /mcp/read once by hand; it should return isError.'`), "the note line is single-quoted and whole");

  // Executed: the identity check passes this deploy's commit and version and fails another commit or another version.
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
