// scripts/deploy-stale-bulletin-expiry.ps1 is WRITTEN AND NEVER RUN by the builder (no deploy, no wrangler, not even -DryRun, which reads the live worker over HTTP). It is proven here by what can be
// proven without running it: it parses under PowerShell's own parser, is ASCII with LF endings, has none of the repo's PowerShell traps, has the load-bearing step order, no migration or D1 step,
// a single wrangler use, a ride of public GETs with no request body at all, step 0a stops on the placeholder before any git or network command, the .claude/skills-only gap between the live base
// (07adcc4e) and local main (ea24e206) cannot stop step 0 (the no-mint diff is path-scoped, run here against real git history), and the served-note check (Test-RunsNoteServed) is run for real
// against good and bad captured answers. Pattern: test/deploy-stale-bulletin-expiry-script.test.ts.
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
const SCRIPT_PATH = here("../scripts/deploy-stale-bulletin-expiry.ps1");
const rawScript = readFileSync(SCRIPT_PATH, "utf8");
const script = rawScript.replace(/\r\n/g, "\n");
const code = script.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
const defs = script.slice(script.indexOf('$ErrorActionPreference = "Stop"'), script.indexOf("# END-OF-DEFINITIONS"));
const pinBlock = script.slice(script.indexOf("# BEGIN-PIN-CHECK"), script.indexOf("# END-PIN-CHECK"));

const NOTE_MARKER = "expired_stale_bulletins=N";
const LIVE = "07adcc4e55c9c326eebdf92e00cb6574d411fe62";

function runPs(lines: string[]): { code: number | null; out: string } | null {
  const dir = mkdtempSync(join(tmpdir(), "deploy-stale-bulletin-expiry-"));
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

test("the pins: the v6 hash, the live base is the full sha of 07adcc4e, the reviewed commit is still the placeholder, the allowlist is this script, its test and docs/, the parameters are -ExpectedCommit (mandatory) and -DryRun", () => {
  assert.match(script, /^\$V6_HASH = "dc5f48213c29bcf844e0fbe7daf1bdb5416b3d57fbd06a8bd03f1061f34092b3"$/m);
  assert.match(script, /^\$LIVE_BASE_COMMIT = "07adcc4e55c9c326eebdf92e00cb6574d411fe62"$/m);
  assert.match(script, /^\$REVIEWED_COMMIT = "TO-BE-SET-BY-HUB"$/m);
  assert.match(script, /^\$ALLOWED_PATHS_AFTER_REVIEW = @\("scripts\/deploy-stale-bulletin-expiry\.ps1", "test\/deploy-stale-bulletin-expiry-script\.test\.ts", "docs\/"\)$/m);
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
  assert.match(runPs(harness("07adcc4e", FULL))!.out, /\[STOP\].*LIVE_BASE_COMMIT.*not 40 lower-case hex/);
  const ok = runPs(harness(LIVE, FULL))!;
  assert.equal(ok.code, 0);
  assert.match(ok.out, /\[PASSED-PINS\]/);
});

test("the steps are in the load-bearing order, there is no migration or D1 step, wrangler is used once (the stamped deploy), and the ride sends no POST and no request body", () => {
  const order = ["BEGIN-PIN-CHECK", "git fetch origin", "BEGIN-REVIEWED-SOURCE-CHECK", "BEGIN-GATES", 'Read-Attest "before the deploy"', "if ($DryRun)", "BEGIN-DEPLOY-AND-POLL", 'Read-Attest "after the deploy"', "Test-RunsNoteServed $runsNow"];
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

test("the marker and url are what the served route carries: the runs note in src/maintainer/runs.ts holds the marker, and the script pins the url", () => {
  const runs = readFileSync(here("../src/maintainer/runs.ts"), "utf8");
  assert.ok(runs.includes(NOTE_MARKER), "src/maintainer/runs.ts note carries the marker");
  assert.ok(script.includes(`$RUNS_NOTE_MARKER = "${NOTE_MARKER}"`));
  assert.ok(script.includes('$MAINT_RUNS_URL = "$BASE/api/maintainer-runs"'));
});

test("the source checks name literals the checkout carries: isStaleBulletin in judgment.ts, and every other Select-String literal is in its file", () => {
  assert.ok(code.includes('Select-String -Path "src/maintainer/judgment.ts" -Pattern "export function isStaleBulletin("'));
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

test("the no-mint diff is path-scoped: run against real history, 07adcc4e..ea24e206 (skills only) shows nothing in src/doc.ts, migrations or schema.sql, so the skills merge cannot stop step 0", (t) => {
  assert.ok(code.includes("git diff --name-status --no-renames $LIVE_BASE_COMMIT HEAD -- src/doc.ts migrations schema.sql"), "the diff is pathspec-limited to the three no-mint paths");
  const git = (args: string[]) => spawnSync("git", ["-C", here(".."), ...args], { encoding: "utf8" });
  if (git(["cat-file", "-e", LIVE + "^{commit}"]).status !== 0 || git(["cat-file", "-e", "ea24e2060c8c424823c3a2920f785973272e278b^{commit}"]).status !== 0) return t.skip("the two commits are not in this clone");
  const r = git(["diff", "--name-status", "--no-renames", LIVE, "ea24e2060c8c424823c3a2920f785973272e278b", "--", "src/doc.ts", "migrations", "schema.sql"]);
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), "", "no no-mint path moved between the live base and local main");
  const all = git(["diff", "--name-only", "--no-renames", LIVE, "ea24e2060c8c424823c3a2920f785973272e278b"]).stdout.split("\n").filter(Boolean);
  assert.ok(all.length > 0 && all.every((f) => f.startsWith(".claude/skills/")), "the whole difference is .claude/skills");
});

type Cap = { code: string; body: string };
const bodyOf = (c: string, e: string, extra = ""): string => JSON.stringify({ error: e, code: c, ...(extra ? { x: extra } : {}) });

test("the served-note check, run for real, passes the new note and fails a missing marker, an old note, a bad status, and a non-JSON body", (t) => {
  const fns = defs.slice(defs.indexOf("function Read-JsonBody"), defs.indexOf("# Polls (GETs only)"));
  const q = (s: string): string => "'" + s.replace(/'/g, "''") + "'";
  const cap = (c: Cap): string => `@{ Code = ${q(c.code)}; Type = 'application/json'; Body = ${q(c.body)} }`;
  const good: Cap = { code: "200", body: JSON.stringify({ runs: [], note: `Every wake writes one row. error can carry ${NOTE_MARKER}, the count of drafts rejected.` }) };
  const cases: Array<[string, Cap, string]> = [
    ["good", good, ""],
    ["old-note", { code: "200", body: JSON.stringify({ runs: [], note: "Every clerk (daily) and judgment (weekly) wake writes one row here." }) }, "does not contain"],
    ["wrong-case", { code: "200", body: JSON.stringify({ note: "EXPIRED_STALE_BULLETINS=N" }) }, "does not contain"],
    ["no-note", { code: "200", body: JSON.stringify({ runs: [] }) }, "does not contain"],
    ["404", { code: "404", body: good.body }, "expected 200"],
    ["500", { code: "500", body: good.body }, "expected 200"],
    ["html", { code: "200", body: "<html>hi</html>" }, "did not return JSON"],
    ["empty", { code: "200", body: "" }, "did not return JSON"],
  ];
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    `$RUNS_NOTE_MARKER = ${q(NOTE_MARKER)}`,
    fns,
    ...cases.map(([name, c]) => `Write-Host ("RESULT ${name} [" + (Test-RunsNoteServed ${cap(c)}) + "]")`),
  ];
  const run = runPs(lines);
  if (!run) return t.skip("no PowerShell available");
  for (const [name, , expect] of cases) {
    const m = new RegExp(`RESULT ${name} \\[(.*)\\]`).exec(run.out);
    assert.ok(m, `${name} produced a result: ${run.out}`);
    if (expect === "") assert.equal(m![1], "", name);
    else assert.ok(m![1].includes(expect), `${name}: '${m![1]}' mentions '${expect}'`);
  }
});

test("the before-read refuses a worker whose runs note already carries the marker and one not answering 200; the poll and the ride both use the check", () => {
  assert.ok(code.includes("([string]$runsBeforeJson.note).Contains($RUNS_NOTE_MARKER)) { Stop-Here"));
  assert.ok(code.includes('[string]$runsBefore.Code -cne "200"'));
  assert.ok(code.includes("Test-RunsNoteServed (Get-Text $MAINT_RUNS_URL 30)"));
  assert.ok(code.includes("Wait-NewWorker $headSha $versionId $POLL_TRIES"));
  assert.ok(code.includes('"/privacy"') && code.includes('"/api/proposal/8"'));
});

test("CODEX r1: the ride re-checks code identity, HEAD and a clean tree are re-read just before wrangler bundles", (t) => {
  // Order: the re-read sits after step 0's checks and before the one wrangler deploy; the ride's identity check sits after the poll.
  const reread = code.indexOf("$headNow = (git rev-parse HEAD).Trim()");
  const dirtyNow = code.indexOf("$dirtyNow = @(git status --porcelain)");
  const deploy = code.indexOf('npx wrangler deploy --var "CODE_COMMIT:$headSha"');
  const poll = code.indexOf("Wait-NewWorker $headSha $versionId $POLL_TRIES");
  const rideId = code.indexOf("Test-CodeIdentityServed $attAfter.code $headSha $versionId");
  // `code` has comment lines stripped, so the step-0 anchor is a retained code line (CODEX r2: a comment anchor read as -1).
  const step0 = code.indexOf("$unreviewed = @(Get-DisallowedPaths $afterReview)");
  for (const [name, at] of [["step0", step0], ["reread", reread], ["dirtyNow", dirtyNow], ["deploy", deploy], ["poll", poll], ["rideId", rideId]] as const) assert.ok(at >= 0, `anchor ${name} found`);
  assert.ok(reread > step0 && reread < deploy, "HEAD re-read between step 0 and the deploy");
  assert.ok(dirtyNow > reread && dirtyNow < deploy, "clean tree re-read between step 0 and the deploy");
  assert.ok(code.includes("$headNow -cne $headSha") && code.includes("$dirtyNow.Count -gt 0) { Stop-Here"));
  assert.ok(rideId > poll && rideId < code.indexOf("[ride] attest:"), "the ride's attest read is identity-checked before it is reported");

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
