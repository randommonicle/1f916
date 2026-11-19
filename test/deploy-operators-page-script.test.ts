// scripts/deploy-operators-page.ps1 is WRITTEN AND NEVER RUN by the builder (no deploy, no wrangler, not even -DryRun, which reads the live worker over HTTP). It is proven here by what can be
// proven without running it: it parses under PowerShell's own parser, is ASCII with LF endings, has none of the repo's PowerShell traps, has the load-bearing step order, no migration or D1 step,
// a single wrangler use, a ride of public GETs with no request body, step 0a stops on the placeholder before any git or network command (the pin block is run for real), every Select-String literal is
// in its file, the served check (Test-OperatorsServed) is run for real against good and bad captured pages built from the real renderer, the header reader (Get-Page) is run for real against a local
// HTTP server serving the real handler's headers, and L-167 is proven by running the real poll (Wait-NewWorker) and the real retry (Confirm-Reads) against fakes: a stale read is "not yet seen", and
// no stop names a rollback before the retries have run out. Derived from the OpenAPI response-side deploy script test.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { parsePowerShellFile } from "./helpers/ps-parse.ts";
import { renderOperators, OPERATORS_CSP, type OperatorsFigures } from "../src/operators.ts";

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
const SCRIPT_PATH = here("../scripts/deploy-operators-page.ps1");
const rawScript = readFileSync(SCRIPT_PATH, "utf8");
const script = rawScript.replace(/\r\n/g, "\n");
const code = script.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
const defs = script.slice(script.indexOf('$ErrorActionPreference = "Stop"'), script.indexOf("# END-OF-DEFINITIONS"));
const pinBlock = script.slice(script.indexOf("# BEGIN-PIN-CHECK"), script.indexOf("# END-PIN-CHECK"));
const ride = script.slice(script.indexOf("# 4. the ride"));

const LIVE = "d52ad72599d7300539f0dac1643a0bea2c57a702";

function runPs(lines: string[]): { code: number | null; out: string } | null {
  const dir = mkdtempSync(join(tmpdir(), "deploy-operators-page-"));
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
// The asynchronous twin, for the one test whose HTTP server lives in this process.
function runPsAsync(lines: string[]): Promise<{ code: number | null; out: string } | null> {
  const dir = mkdtempSync(join(tmpdir(), "deploy-operators-page-"));
  const ps1 = join(dir, "harness.ps1");
  writeFileSync(ps1, lines.join("\r\n"));
  return new Promise((resolve) => {
    const child = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1]);
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", () => {
      rmSync(dir, { recursive: true, force: true });
      resolve(null);
    });
    child.on("close", (c) => {
      rmSync(dir, { recursive: true, force: true });
      resolve({ code: c, out });
    });
  });
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

test("the pins: the v6 hash, the live base d52ad725, the reviewed pin is the placeholder or a 40-hex sha, the allowlist is this script, its test and docs/, the parameters are -ExpectedCommit (mandatory) and -DryRun, the CSP is the handler's", () => {
  assert.match(script, /^\$V6_HASH = "dc5f48213c29bcf844e0fbe7daf1bdb5416b3d57fbd06a8bd03f1061f34092b3"$/m);
  assert.match(script, new RegExp(`^\\$LIVE_BASE_COMMIT = "${LIVE}"$`, "m"));
  assert.match(script, /^\$LIVE_BASE_PLACEHOLDER = "TO-BE-SET-BY-HUB-LIVE-BASE"$/m);
  // Setting the pin (the hub's later edit) must not red the suite: the line may hold the placeholder or a full sha.
  assert.match(script, /^\$REVIEWED_COMMIT = "(TO-BE-SET-BY-HUB|[0-9a-f]{40})"$/m);
  assert.match(script, /^\$REVIEWED_COMMIT_PLACEHOLDER = "TO-BE-SET-BY-HUB"$/m);
  assert.match(script, /^\$ALLOWED_PATHS_AFTER_REVIEW = @\("scripts\/deploy-operators-page\.ps1", "test\/deploy-operators-page-script\.test\.ts", "docs\/"\)$/m);
  assert.match(script, /\[Parameter\(Mandatory = \$true\)\]\[string\]\$ExpectedCommit/);
  assert.match(script, /\[switch\]\$DryRun/);
  assert.equal(/^\$CSP_EXPECTED = "(.*)"$/m.exec(script)![1], OPERATORS_CSP, "the script expects the exact policy the handler serves");
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
  assert.match(runPs(harness("d52ad725", FULL))!.out, /\[STOP\].*LIVE_BASE_COMMIT.*not 40 lower-case hex/);
  const ok = runPs(harness(LIVE, FULL))!;
  assert.equal(ok.code, 0);
  assert.match(ok.out, /\[PASSED-PINS\]/);
  // The hub has not set the reviewed pin: the script refuses to deploy until it does (this is the builder's state; after the hub sets it the line holds a full sha and the check above still passes).
  assert.match(script, /^\$REVIEWED_COMMIT = "(TO-BE-SET-BY-HUB|[0-9a-f]{40})"$/m, "the reviewed pin is the placeholder or a full lower-case sha");
});

test("the steps are in the load-bearing order, there is no migration or D1 step, wrangler is used once (the stamped deploy), and the ride sends no POST and no request body", () => {
  const order = ["BEGIN-PIN-CHECK", "git fetch origin", "BEGIN-REVIEWED-SOURCE-CHECK", "BEGIN-GATES", 'Read-Attest "before the deploy"', "if ($DryRun)", "BEGIN-DEPLOY-AND-POLL", "$whyAttest = Confirm-Reads", "$whyPage = Confirm-Reads", "$whyDoors = Confirm-Reads", "$whySweep = Confirm-Reads"];
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
  for (const anchor of ["export async function handleOperators", "export async function handlePrivacy"]) {
    assert.ok(code.includes(`-Pattern "${anchor}"`), anchor);
  }
  assert.ok(code.includes(`Select-String -Path "src/doors.ts" -Pattern '"operators_page",'`));
  assert.ok(code.includes(`Select-String -Path "src/index.ts" -Pattern 'path === "/operators" && method === "GET"'`));
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

type Cap = { code: string; type?: string; csp?: string; nosniff?: string; body: string };
const q = (s: string): string => "'" + s.replace(/'/g, "''") + "'";
const capPage = (c: Cap): string => `@{ Code = ${q(c.code)}; Type = ${q(c.type ?? "text/html; charset=utf-8")}; Csp = ${q(c.csp ?? OPERATORS_CSP)}; Nosniff = ${q(c.nosniff ?? "nosniff")}; Body = ${q(c.body)} }`;
const slice = (from: string, to: string): string => defs.slice(defs.indexOf(from), defs.indexOf(to));
const cspLine = script.split("\n").find((l) => l.startsWith("$CSP_EXPECTED = "))!;

const ORIGIN = "https://commonhold.example.invalid";
const FIG: OperatorsFigures = { citizens: 13, operator_controlled: 5, operator_paid: 12, acted_30d: 0, residents: 52 };
const official = (f: Partial<Record<keyof OperatorsFigures, number | null>> = {}): string => {
  const x = { ...FIG, ...f };
  return JSON.stringify({ composition: { citizens: x.citizens, operator_controlled: x.operator_controlled, operator_paid: x.operator_paid, acted_30d: x.acted_30d }, residents: { count: x.residents } });
};
const goodBody = (f: Partial<OperatorsFigures> = {}): string => renderOperators(ORIGIN, { ...FIG, ...f });

test("the page check, run for real against pages the real renderer produced, passes the good page and fails each wrong piece with its own reason", (t) => {
  const fns = slice("function Test-OperatorsServed", "# L-167. Runs the check");
  const cases: Array<[string, Cap, string, string]> = [
    ["good", { code: "200", body: goodBody() }, official(), ""],
    ["singular", { code: "200", body: goodBody({ citizens: 1, acted_30d: 1 }) }, official({ citizens: 1, acted_30d: 1 }), ""],
    ["actednull", { code: "200", body: goodBody({ acted_30d: null }) }, official({ acted_30d: null }), ""],
    ["404", { code: "404", body: "not found" }, official(), "answered 404"],
    ["type", { code: "200", type: "text/plain", body: goodBody() }, official(), "content type is 'text/plain'"],
    ["nocsp", { code: "200", csp: "", body: goodBody() }, official(), "Content-Security-Policy is ''"],
    ["weakcsp", { code: "200", csp: OPERATORS_CSP.replace("; frame-ancestors 'none'", ""), body: goodBody() }, official(), "expected exactly"],
    ["nonosniff", { code: "200", nosniff: "", body: goodBody() }, official(), "X-Content-Type-Options is ''"],
    ["script", { code: "200", body: goodBody().replace("<h1>", "<script>1</script><h1>") }, official(), "contains <script"],
    ["img", { code: "200", body: goodBody().replace("<h1>", "<img alt=x><h1>") }, official(), "contains <img"],
    ["noopening", { code: "200", body: goodBody().replace("This page is not a way to take part", "Welcome") }, official(), "lacks 'This page is not a way to take part'"],
    ["nopaste", { code: "200", body: goodBody().replace("<pre>", "<p>") }, official(), "lacks '<pre>'"],
    ["officialnull", { code: "200", body: goodBody() }, "null", "GET /api/official was unreadable"],
    ["citizensdiffer", { code: "200", body: goodBody({ citizens: 12 }) }, official(), "figures sentence"],
    ["pluraldiffer", { code: "200", body: goodBody({ citizens: 1 }) }, official({ citizens: 2 }), "figures sentence"],
    ["controlsdiffer", { code: "200", body: goodBody({ operator_controlled: 4 }) }, official(), "figures sentence"],
    ["actednullbutpage0", { code: "200", body: goodBody({ acted_30d: 0 }) }, official({ acted_30d: null }), "figures sentence"],
    ["actedzerovsunavailable", { code: "200", body: goodBody({ acted_30d: null }) }, official({ acted_30d: 0 }), "figures sentence"],
    ["residentsdiffer", { code: "200", body: goodBody({ residents: 51 }) }, official(), "figures sentence"],
    // a bare number would also match inside a longer one: the page says 113 and the route 13, the page says 12 seats and the route 2
    ["113vs13", { code: "200", body: goodBody({ citizens: 113 }) }, official({ citizens: 13 }), "figures sentence"],
    ["12seatsvs2", { code: "200", body: goodBody({ acted_30d: 12 }) }, official({ acted_30d: 2 }), "figures sentence"],
    ["152vs52", { code: "200", body: goodBody({ residents: 152 }) }, official({ residents: 52 }), "figures sentence"],
    ["1vs11", { code: "200", body: goodBody({ operator_paid: 11 }) }, official({ operator_paid: 1 }), "figures sentence"],
  ];
  const run = runPs(["$ErrorActionPreference = 'Stop'", cspLine, fns, ...cases.map(([name, c, off]) => `Write-Host ("RESULT ${name} [" + (Test-OperatorsServed ${capPage(c)} (${q(off)} | ConvertFrom-Json)) + "]")`)]);
  if (!run) return t.skip("no PowerShell available");
  for (const [name, , , expect] of cases) {
    const m = new RegExp(`RESULT ${name} \\[(.*)\\]`).exec(run.out);
    assert.ok(m, `${name} produced a result: ${run.out.slice(0, 600)}`);
    if (expect === "") assert.equal(m![1], "", name);
    else assert.ok(m![1].includes(expect), `${name}: '${m![1]}' mentions '${expect}'`);
  }
});

test("Get-Page, run for real against a local HTTP server serving the handler's own headers, reads the status, content type, Content-Security-Policy, X-Content-Type-Options and body", async (t) => {
  const body = goodBody();
  const server = createServer((req, res) => {
    if (req.url === "/bare") {
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("hello");
      return;
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": OPERATORS_CSP, "X-Content-Type-Options": "nosniff" });
    res.end(body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  try {
    const fns = slice("function Get-Page", "# \"\" when $r is GET /operators answering");
    const run = await runPsAsync([
      "$ErrorActionPreference = 'Stop'",
      fns,
      `$p = Get-Page "http://127.0.0.1:${port}/operators" 20`,
      'Write-Host ("CODE [" + $p.Code + "]")',
      'Write-Host ("TYPE [" + $p.Type + "]")',
      'Write-Host ("CSP [" + $p.Csp + "]")',
      'Write-Host ("NOSNIFF [" + $p.Nosniff + "]")',
      'Write-Host ("BODYLEN [" + $p.Body.Length + "]")',
      `$b = Get-Page "http://127.0.0.1:${port}/bare" 20`,
      'Write-Host ("BARE [" + $b.Csp + "|" + $b.Nosniff + "|" + $b.Body + "]")',
    ]);
    if (!run) return t.skip("no PowerShell available");
    assert.match(run.out, /CODE \[200\]/, run.out);
    assert.match(run.out, /TYPE \[text\/html; charset=utf-8\]/);
    assert.ok(run.out.includes(`CSP [${OPERATORS_CSP}]`), run.out);
    assert.match(run.out, /NOSNIFF \[nosniff\]/);
    assert.match(run.out, new RegExp(`BODYLEN \\[${body.length}\\]`));
    assert.match(run.out, /BARE \[\|\|hello\]/, "a response without the two headers reads as empty values, not as a pass");
  } finally {
    server.close();
  }
});

test("the before-read accepts only a 404 and refuses an already-deployed page; the poll and the ride use the check", () => {
  assert.ok(code.includes('if ([string]$pageBefore.Code -ceq "200") { Stop-Here'));
  assert.ok(code.includes('if ([string]$pageBefore.Code -cne "404") { Stop-Here'));
  assert.ok(code.includes("Test-OperatorsServed (Get-Page $PAGE_URL 30) (Get-ServedOfficial)"));
});

// ---------- L-167: a read straight after a write is not the state ----------

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const VERSION = "11111111-2222-3333-4444-555555555555";
const fakes = (sequence: string[]): string[] => [
  "$ErrorActionPreference = 'Stop'",
  cspLine,
  defs,
  "function Start-Sleep { }",
  '$ROLLBACK_LINE = "ROLLBACK-NAMED"',
  `$sequence = @(${sequence.map((s) => `'${s}'`).join(", ")})`,
  "$script:reads = 0",
  `function Get-ServedCode { $i = $script:reads; $script:reads = $script:reads + 1; if ($i -lt $sequence.Count -and $sequence[$i] -ceq 'good') { return @{ commit_status = 'stamped'; commit = '${COMMIT}'; version_status = 'available'; version_id = '${VERSION}' } } else { return $null } }`,
  `function Get-Page($url, $maxTime) { return ${capPage({ code: "200", body: goodBody() })} }`,
  `function Get-ServedOfficial { return (${q(official())} | ConvertFrom-Json) }`,
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

test("L-167, the poll judges the page too: a worker serving the right code identity but no page (a 404) is 'not yet', never good", (t) => {
  const withMissingPage = fakes(["good", "good", "good"]).map((l) => (l.startsWith("function Get-Page") ? `function Get-Page($url, $maxTime) { return ${capPage({ code: "404", body: "not found" })} }` : l));
  const r = runPs([...withMissingPage, `Wait-NewWorker '${COMMIT}' '${VERSION}' 3 0`, 'Write-Host "[WAITED]"']);
  if (!r) return t.skip("no PowerShell available");
  assert.equal(r.code, 1, r.out);
  assert.equal(/\[WAITED\]/.test(r.out), false);
  assert.match(r.out, /not yet: GET \/operators answered 404/);
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
  assert.equal(/Stop-Here|exit \d|ROLL ?BACK/i.test(retry), false, "the retry itself neither stops nor names a remedy");
});

test("L-167, the ride: every post-deploy check goes through Confirm-Reads, no ride stop is raised from a single read, and each names the rollback only after saying to read the deployments list by hand", () => {
  assert.equal((ride.match(/= Confirm-Reads /g) ?? []).length, 4, "attest, the page, the doors note and the sweep");
  assert.equal(ride.includes("Assert-Attest"), false, "the single-read attest assertion is for before the deploy only");
  const stops = ride.split("\n").filter((l) => l.includes("Stop-Here"));
  assert.equal(stops.length, 4, "one stop per retried check");
  for (const l of stops) {
    assert.match(l, /^if \(\$why[A-Za-z]* -ne ""\) \{ Stop-Here/, `a ride stop is raised only from a retry result: ${l.slice(0, 60)}`);
    assert.ok(l.includes("by hand first"), `it says to read by hand first: ${l.slice(0, 60)}`);
    assert.ok(l.indexOf("by hand first") < l.indexOf("$ROLLBACK_LINE"), `the rollback comes after the instruction to read first: ${l.slice(0, 60)}`);
    assert.match(l, /Only if /, "and the rollback is conditional");
  }
  assert.match(script, /Read 'npx wrangler deployments list' and GET \/api\/attest by hand first[^\n]*Only if the new version is not at 100%/);
  assert.match(script, /^\$GOOD_READS_NEEDED = 3$/m);
  assert.match(script, /^\$RIDE_TRIES = 12$/m);
  assert.ok(script.includes("THE RIDE ITSELF ADDED TO operators_page"), "the closing note says the ride itself added to the counted door");
  assert.ok(ride.includes('"/operators"'), "the sweep reads the page");
});
