// scripts/deploy-openapi-response-side.ps1 is WRITTEN AND NEVER RUN by the builder (no deploy, no wrangler, not even -DryRun, which reads the live worker over HTTP). It is proven here by what can be
// proven without running it: it parses under PowerShell's own parser, is ASCII with LF endings, has none of the repo's PowerShell traps, has the load-bearing step order, no migration or D1 step,
// a single wrangler use, a ride of public GETs with no request body, step 0a stops on the placeholder before any git or network command (the pin block is run for real), every Select-String literal is
// in its file, the served check (Test-ResponseSideServed) is run for real against good and bad captured answers, and L-167 is proven by running the real poll (Wait-NewWorker) and the real retry
// (Confirm-Reads) against fakes: a stale read is "not yet seen", and no stop names a rollback before the retries have run out. Derived from the request-side deploy script test.
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
import { renderOpenApi } from "../src/discovery.ts";

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
const SCRIPT_PATH = here("../scripts/deploy-openapi-response-side.ps1");
const rawScript = readFileSync(SCRIPT_PATH, "utf8");
const script = rawScript.replace(/\r\n/g, "\n");
const code = script.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
const defs = script.slice(script.indexOf('$ErrorActionPreference = "Stop"'), script.indexOf("# END-OF-DEFINITIONS"));
const pinBlock = script.slice(script.indexOf("# BEGIN-PIN-CHECK"), script.indexOf("# END-PIN-CHECK"));
const ride = script.slice(script.indexOf("# 4. the ride"));

const LIVE = "3a5dd18df9a623325bfb1d569b956747700b11f2";

function runPs(lines: string[]): { code: number | null; out: string } | null {
  const dir = mkdtempSync(join(tmpdir(), "deploy-openapi-response-side-"));
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

test("the script and its test are ASCII only with LF line endings, and the script parses under PowerShell's own parser with zero errors", (t) => {
  assert.equal(/[^\x00-\x7f]/.test(rawScript), false, "ASCII only");
  assert.equal(rawScript.includes("\r"), false, "the script is LF");
  assert.equal(readFileSync(fileURLToPath(import.meta.url), "utf8").includes("\r"), false, "this test file is LF");
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

test("the pins: the v6 hash, the live base 3a5dd18d, the reviewed pin is the placeholder or a 40-hex sha, the allowlist is this script, its test and docs/, the parameters are -ExpectedCommit (mandatory) and -DryRun", () => {
  assert.match(script, /^\$V6_HASH = "dc5f48213c29bcf844e0fbe7daf1bdb5416b3d57fbd06a8bd03f1061f34092b3"$/m);
  assert.match(script, new RegExp(`^\\$LIVE_BASE_COMMIT = "${LIVE}"$`, "m"));
  assert.match(script, /^\$LIVE_BASE_PLACEHOLDER = "TO-BE-SET-BY-HUB-LIVE-BASE"$/m);
  // Setting the pin (the hub's later edit) must not red the suite: the line may hold the placeholder or a full sha.
  assert.match(script, /^\$REVIEWED_COMMIT = "(TO-BE-SET-BY-HUB|[0-9a-f]{40})"$/m);
  assert.match(script, /^\$REVIEWED_COMMIT_PLACEHOLDER = "TO-BE-SET-BY-HUB"$/m);
  assert.match(script, /^\$ALLOWED_PATHS_AFTER_REVIEW = @\("scripts\/deploy-openapi-response-side\.ps1", "test\/deploy-openapi-response-side-script\.test\.ts", "docs\/"\)$/m);
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
  assert.match(runPs(harness("3a5dd18d", FULL))!.out, /\[STOP\].*LIVE_BASE_COMMIT.*not 40 lower-case hex/);
  const ok = runPs(harness(LIVE, FULL))!;
  assert.equal(ok.code, 0);
  assert.match(ok.out, /\[PASSED-PINS\]/);
  // The script's own pin is the placeholder (step 0a stops on it) or the hub's full lower-case sha: setting the pin must not red this suite, because the script's own npm test step would then stop the deploy.
  assert.match(script, /^\$REVIEWED_COMMIT = "(TO-BE-SET-BY-HUB|[0-9a-f]{40})"$/m, "the reviewed pin is the placeholder or a full lower-case sha");
});

test("the steps are in the load-bearing order, there is no migration or D1 step, wrangler is used once (the stamped deploy), and the ride sends no POST and no request body", () => {
  const order = ["BEGIN-PIN-CHECK", "git fetch origin", "BEGIN-REVIEWED-SOURCE-CHECK", "BEGIN-GATES", 'Read-Attest "before the deploy"', "if ($DryRun)", "BEGIN-DEPLOY-AND-POLL", "$whyAttest = Confirm-Reads", "$whyDoc = Confirm-Reads", "limit=0", "$whySweep = Confirm-Reads"];
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
  assert.equal(/-X\s+POST|--data/.test(code), false, "no POST and no request body");
  assert.ok(code.includes("src/doc.ts") && code.includes("migrations schema.sql"), "the no-mint and no-migration check names src/doc.ts, migrations and schema.sql");
  assert.ok(code.includes("git merge-base --is-ancestor $LIVE_BASE_COMMIT HEAD"), "HEAD must contain the live base");
  assert.ok(code.includes("[string]$attBefore.code.commit -cne $LIVE_BASE_COMMIT"), "the live worker is proven to be the pinned base");
});

test("the source checks name literals the checkout carries: this wave's anchors, the earlier waves' anchors, and every Select-String literal is in its file", () => {
  for (const anchor of ["export const UNVALIDATED: Record<string, UnvalidatedBehaviour>", "function behaviourExtension(", "const ROW_ID_PATH_PARAM", "responseSchema: COUNCIL_THREAD_RESPONSE_SCHEMA", "has no pathParams declaration"]) {
    assert.ok(code.includes(`Select-String -Path "src/discovery.ts" -Pattern "${anchor}"`), anchor);
  }
  assert.ok(code.includes('Select-String -Path "src/maintainer/parked.ts" -Pattern "export async function parkedPage"'));
  let n = 0;
  for (const m of code.matchAll(/Select-String -Path "([^"]+)" -Pattern ('[^']+'|"[^"]+")/g)) {
    if (m[1] === "wrangler.jsonc") continue;
    const lit = m[2].slice(1, -1);
    assert.ok(readFileSync(here(`../${m[1]}`), "utf8").includes(lit), `${m[1]} carries '${lit}'`);
    n++;
  }
  assert.ok(n >= 16, `checked ${n} literals`);
});

type Cap = { code: string; body: string };
const q = (s: string): string => "'" + s.replace(/'/g, "''") + "'";
const cap = (c: Cap): string => `@{ Code = ${q(c.code)}; Type = 'application/json'; Body = ${q(c.body)} }`;
const slice = (from: string, to: string): string => defs.slice(defs.indexOf(from), defs.indexOf(to));

const DIGITS = "^[0-9]{1,15}$";
const INBOX_PATTERN: string = ((renderOpenApi("https://example.test", "Commonhold") as any).paths["/api/inbox"].get.parameters as any[]).find((p) => p.name === "cursor").schema.pattern; // the real served pattern, so the good document is the real one
const cursorRoute = (pattern: string | undefined, nextCursor: unknown, param = "after") => ({
  get: {
    parameters: [{ name: param, in: "query", schema: { type: "string", ...(pattern === undefined ? {} : { pattern }) } }],
    responses: { "200": { content: { "application/json": { schema: { properties: nextCursor === undefined ? {} : { next_cursor: nextCursor } } } } } },
  },
});
const goodDoc = (): any => ({
  openapi: "3.0.3",
  paths: {
    "/api/search": { get: { parameters: [{ name: "limit", in: "query", schema: { type: "integer", "x-clamped": { minimum: 1, maximum: 50, reason: "r" } } }] } },
    "/api/attest": { get: { parameters: [{ name: "from", in: "query", schema: { type: "integer", "x-ignored-when-invalid": { reason: "r" } } }] } },
    "/api/post/{id}": { get: { parameters: [{ name: "id", in: "path", schema: { type: "string", pattern: "^[0-9]+$" } }] } },
    "/api/residents": cursorRoute(DIGITS, { type: "string", nullable: true, pattern: DIGITS }),
    "/api/council/thread": cursorRoute(DIGITS, { type: "string", nullable: true, pattern: DIGITS }),
    "/api/inbox": cursorRoute(INBOX_PATTERN, { type: "string", pattern: INBOX_PATTERN }, "cursor"),
  },
});
const edit = (f: (d: any) => void): string => {
  const d = goodDoc();
  f(d);
  return JSON.stringify(d);
};

test("the response-side check, run for real, passes the good document and fails each missing or wrong piece with its own reason", (t) => {
  const fns = slice("function Read-JsonBody", "# L-167. Runs the check");
  const cases: Array<[string, Cap, string]> = [
    ["good", { code: "200", body: JSON.stringify(goodDoc()) }, ""],
    ["noclamp", { code: "200", body: edit((d) => delete d.paths["/api/search"].get.parameters[0].schema["x-clamped"]) }, "carries no x-clamped"],
    ["nosearchlimit", { code: "200", body: edit((d) => (d.paths["/api/search"].get.parameters = [])) }, "no limit parameter on /api/search"],
    ["noignored", { code: "200", body: edit((d) => delete d.paths["/api/attest"].get.parameters[0].schema["x-ignored-when-invalid"]) }, "carries no x-ignored-when-invalid"],
    ["nofrom", { code: "200", body: edit((d) => (d.paths["/api/attest"].get.parameters = [])) }, "no from parameter on /api/attest"],
    ["noidparam", { code: "200", body: edit((d) => (d.paths["/api/post/{id}"].get.parameters = [])) }, "no id parameter on /api/post/{id}"],
    ["idnopattern", { code: "200", body: edit((d) => delete d.paths["/api/post/{id}"].get.parameters[0].schema.pattern) }, "id pattern is ''"],
    ["idwrongpattern", { code: "200", body: edit((d) => (d.paths["/api/post/{id}"].get.parameters[0].schema.pattern = "^x$")) }, "id pattern is '^x$'"],
    ["resafterwrong", { code: "200", body: edit((d) => (d.paths["/api/residents"].get.parameters[0].schema.pattern = "^x$")) }, "/api/residents after pattern is '^x$'"],
    ["resnonext", { code: "200", body: edit((d) => (d.paths["/api/residents"] = cursorRoute(DIGITS, undefined))) }, "/api/residents 200 declares no next_cursor"],
    ["resnextnopattern", { code: "200", body: edit((d) => delete d.paths["/api/residents"].get.responses["200"].content["application/json"].schema.properties.next_cursor.pattern) }, "/api/residents 200 next_cursor pattern is ''"],
    ["resnextdiffers", { code: "200", body: edit((d) => (d.paths["/api/residents"].get.responses["200"].content["application/json"].schema.properties.next_cursor.pattern = "^[0-9]+$")) }, "/api/residents 200 next_cursor pattern is '^[0-9]+$'"],
    ["councilnonext", { code: "200", body: edit((d) => (d.paths["/api/council/thread"] = cursorRoute(DIGITS, undefined))) }, "/api/council/thread 200 declares no next_cursor"],
    ["councilnextnopattern", { code: "200", body: edit((d) => (d.paths["/api/council/thread"] = cursorRoute(DIGITS, { type: "string", nullable: true }))) }, "/api/council/thread 200 next_cursor pattern is ''"],
    ["councilnoafter", { code: "200", body: edit((d) => (d.paths["/api/council/thread"].get.parameters = [])) }, "/api/council/thread route declares no after"],
    ["noinboxparam", { code: "200", body: edit((d) => (d.paths["/api/inbox"].get.parameters = [])) }, "no cursor parameter on /api/inbox"],
    ["inboxnonext", { code: "200", body: edit((d) => (d.paths["/api/inbox"] = cursorRoute(INBOX_PATTERN, undefined, "cursor"))) }, "/api/inbox 200 declares no next_cursor"],
    ["inboxnextdiffers", { code: "200", body: edit((d) => (d.paths["/api/inbox"].get.responses["200"].content["application/json"].schema.properties.next_cursor.pattern = DIGITS)) }, "/api/inbox 200 next_cursor pattern is"],
    ["inboxold15", { code: "200", body: edit((d) => { const old = "^c[0-9]{1,15}-p[0-9]{1,15}(-g[0-9]{1,15})?$"; d.paths["/api/inbox"] = cursorRoute(old, { type: "string", pattern: old }, "cursor"); }) }, "refuses the largest cursor the route serves"],
    ["inboxloose", { code: "200", body: edit((d) => { const loose = "^c[0-9]+-p[0-9]+(-g[0-9]+)?$"; d.paths["/api/inbox"] = cursorRoute(loose, { type: "string", pattern: loose }, "cursor"); }) }, "accepts c9007199254740992-p0"],
    ["500", { code: "500", body: JSON.stringify(goodDoc()) }, "expected 200"],
    ["html", { code: "200", body: "<html>x</html>" }, "did not return JSON"],
    ["empty", { code: "200", body: "" }, "did not return JSON"],
    ["requestsideonly", { code: "200", body: JSON.stringify({ openapi: "3.0.3", paths: { "/api/search": { get: { parameters: [{ name: "limit", in: "query", schema: { type: "integer" } }] } } } }) }, "the /api/search limit parameter carries no x-clamped"],
  ];
  const run = runPs(["$ErrorActionPreference = 'Stop'", fns, ...cases.map(([name, c]) => `Write-Host ("RESULT ${name} [" + (Test-ResponseSideServed ${cap(c)}) + "]")`)]);
  if (!run) return t.skip("no PowerShell available");
  for (const [name, , expect] of cases) {
    const m = new RegExp(`RESULT ${name} \\[(.*)\\]`).exec(run.out);
    assert.ok(m, `${name} produced a result: ${run.out}`);
    if (expect === "") assert.equal(m![1], "", name);
    else assert.ok(m![1].includes(expect), `${name}: '${m![1]}' mentions '${expect}'`);
  }
});

test("the before-read accepts only the one ABSENT reason a pre-wave worker returns and refuses an already-deployed worker; the poll and the ride use the check", () => {
  assert.ok(code.includes("$whyBefore = Test-ResponseSideServed $runsBefore"));
  assert.ok(code.includes('if ($whyBefore -eq "") { Stop-Here'));
  assert.ok(code.includes('$whyBefore -cne "the /api/search limit parameter carries no x-clamped"'));
  assert.ok(code.includes('return "the /api/search limit parameter carries no x-clamped"'), "the accepted reason is exactly the one the check returns");
  assert.ok(code.includes("Test-ResponseSideServed (Get-Text $RUNS_URL 30)"));
});

// ---------- L-167: a read straight after a write is not the state ----------

const GOOD_BODY = JSON.stringify(goodDoc());
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const VERSION = "11111111-2222-3333-4444-555555555555";
const fakes = (sequence: string[]): string[] => [
  "$ErrorActionPreference = 'Stop'",
  defs,
  "function Start-Sleep { }",
  '$ROLLBACK_LINE = "ROLLBACK-NAMED"',
  `$sequence = @(${sequence.map((s) => `'${s}'`).join(", ")})`,
  "$script:reads = 0",
  `function Get-ServedCode { $i = $script:reads; $script:reads = $script:reads + 1; if ($i -lt $sequence.Count -and $sequence[$i] -ceq 'good') { return @{ commit_status = 'stamped'; commit = '${COMMIT}'; version_status = 'available'; version_id = '${VERSION}' } } else { return $null } }`,
  `function Get-Text($url, $maxTime) { return @{ Code = '200'; Type = 'application/json'; Body = ${q(GOOD_BODY)} } }`,
];

test("L-167, the poll run for real: one stale read in the middle does not decide it, three good reads in a row do, and the rollback is named only by the exhausted poll", (t) => {
  const pass = runPs([...fakes(["good", "bad", "good", "good", "good"]), `Wait-NewWorker '${COMMIT}' '${VERSION}' 24 0`, 'Write-Host "[WAITED]"']);
  if (!pass) return t.skip("no PowerShell available");
  assert.equal(pass.code, 0, pass.out);
  assert.match(pass.out, /\[WAITED\]/);
  assert.match(pass.out, /try 2 of 24: not yet/, "the stale read is reported as not yet");
  assert.match(pass.out, /try 5 of 24: good read 3 of 3/);
  assert.equal(pass.out.includes("ROLLBACK-NAMED"), false, "a poll that found its good reads never names a rollback");
  const exhausted = runPs([...fakes(["good", "good", "bad", "good", "good", "bad"]), `Wait-NewWorker '${COMMIT}' '${VERSION}' 6 0`, 'Write-Host "[WAITED]"'])!;
  assert.equal(exhausted.code, 1, "two good reads then a stale one never make three in a row: the poll runs out");
  assert.equal(/\[WAITED\]/.test(exhausted.out), false);
  const stop = exhausted.out.indexOf("[STOP]");
  assert.ok(stop > 0 && exhausted.out.indexOf("ROLLBACK-NAMED") > stop, "the rollback appears only in the stop message after the tries ran out");
  assert.match(exhausted.out, /deployments list[^\n]*by hand first|by hand first[^\n]*deployments list/, "and even then it says to read the deployments list first");
});

test("L-167, the retry run for real: a stale read resets the run, a bounded run of good reads passes, a run that never forms returns the last reason, and it never stops or names a remedy", (t) => {
  const retry = slice("# L-167. Runs the check", "# Polls (GETs only)");
  const lines = (body: string, tries: number): string[] => [
    "$ErrorActionPreference = 'Stop'",
    "function Start-Sleep { }",
    retry,
    "$script:k = 0",
    `$chk = { $script:k = $script:k + 1; ${body} }`,
    `$res = Confirm-Reads $chk 3 ${tries} 0`,
    'Write-Host ("RESULT [" + $res + "] reads " + $script:k)',
  ];
  const flaky = runPs(lines('if ($script:k -eq 1 -or $script:k -eq 3) { "stale 404" } else { "" }', 12));
  if (!flaky) return t.skip("no PowerShell available");
  assert.match(flaky.out, /RESULT \[\] reads 6/, `bad, good, bad, then good x3: ${flaky.out}`);
  const never = runPs(lines('"404"', 4))!;
  assert.match(never.out, /RESULT \[404\] reads 4/, "bounded: it reads exactly the tries it was given and returns the last reason");
  const short = runPs(lines('if ($script:k -eq 3) { "stale" } else { "" }', 4))!;
  assert.match(short.out, /RESULT \[only 1 good read\(s\) in a row of the 3 needed\] reads 4/, "a run that falls short says how short");
  const retryBody = retry;
  assert.equal(/Stop-Here|exit \d|ROLL ?BACK/i.test(retryBody), false, "the retry itself neither stops nor names a remedy");
});

test("L-167, the ride: every post-deploy check goes through Confirm-Reads, no ride stop is raised from a single read, and each names the rollback only after saying to read the deployments list by hand", () => {
  assert.equal((ride.match(/= Confirm-Reads /g) ?? []).length, 5, "attest, document, roster 200, roster 400 and the sweep");
  assert.equal(ride.includes("Assert-Attest"), false, "the single-read attest assertion is for before the deploy only");
  const stops = ride.split("\n").filter((l) => l.includes("Stop-Here"));
  assert.equal(stops.length, 5, "one stop per retried check");
  for (const l of stops) {
    assert.match(l, /^if \(\$why[A-Za-z]* -ne ""\) \{ Stop-Here/, `a ride stop is raised only from a retry result: ${l.slice(0, 60)}`);
    assert.ok(l.includes("by hand first"), `it says to read by hand first: ${l.slice(0, 60)}`);
    assert.ok(l.indexOf("by hand first") < l.indexOf("$ROLLBACK_LINE"), `the rollback comes after the instruction to read first: ${l.slice(0, 60)}`);
    assert.match(l, /Only if /, "and the rollback is conditional");
  }
  // The poll's own stop is the same shape, and a ride read is never judged outside the retry.
  assert.match(script, /Read 'npx wrangler deployments list' and GET \/api\/attest by hand first[^\n]*Only if the new version is not at 100%/);
  assert.match(script, /^\$GOOD_READS_NEEDED = 3$/m);
  assert.match(script, /^\$RIDE_TRIES = 12$/m);
});
