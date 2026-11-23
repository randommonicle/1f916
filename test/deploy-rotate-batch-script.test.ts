// scripts/deploy-rotate-batch.ps1 is WRITTEN AND NEVER RUN by this test (no deploy, no wrangler, not even -DryRun, which reads the live worker over HTTP). It is proven here by what can be
// proven without running it: it parses under PowerShell's own parser, is ASCII with LF endings, has none of the repo's PowerShell traps, has the load-bearing step order, no migration or D1 step,
// a single wrangler use, a ride of public GETs, credential-free initialize POSTs and three refused rotate requests (no credential, a bearer that is no citizen's secret, a GET), step 0a stops on the placeholder
// before any git or network command (the pin block is run for real), every Select-String literal is in its file, the refusal check (Test-RotateRefusals) is run for real against a local HTTP server,
// the earlier waves' checks are kept, and L-167 is proven by running the real poll and the real retry against fakes. Derived from the operators pointer deploy script test.
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
import { OPERATORS_POINTER, OPERATORS_NOTE_SENTENCE, GUEST_OPERATOR_NOTE } from "../src/guest-core.ts";

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
const SCRIPT_PATH = here("../scripts/deploy-rotate-batch.ps1");
const rawScript = readFileSync(SCRIPT_PATH, "utf8");
const script = rawScript.replace(/\r\n/g, "\n");
const code = script.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
const defs = script.slice(script.indexOf('$ErrorActionPreference = "Stop"'), script.indexOf("# END-OF-DEFINITIONS"));
const pinBlock = script.slice(script.indexOf("# BEGIN-PIN-CHECK"), script.indexOf("# END-PIN-CHECK"));
const ride = script.slice(script.indexOf("# 4. the ride"));

const LIVE = "46fb9537fff5ea4364af0456fc26974becfaf095";
const SOCIETY_SRC = readFileSync(here("../src/society.ts"), "utf8");

function runPs(lines: string[]): { code: number | null; out: string } | null {
  const dir = mkdtempSync(join(tmpdir(), "deploy-rotate-batch-"));
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
  const dir = mkdtempSync(join(tmpdir(), "deploy-rotate-batch-"));
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

test("the pins: the v6 hash, the live base 46fb9537, the reviewed pin is the placeholder or a 40-hex sha, the allowlist is this script, its test and docs/, the parameters are -ExpectedCommit (mandatory) and -DryRun, the CSP is the handler's", () => {
  assert.match(script, /^\$V6_HASH = "dc5f48213c29bcf844e0fbe7daf1bdb5416b3d57fbd06a8bd03f1061f34092b3"$/m);
  assert.match(script, new RegExp(`^\\$LIVE_BASE_COMMIT = "${LIVE}"$`, "m"));
  assert.match(script, /^\$LIVE_BASE_PLACEHOLDER = "TO-BE-SET-BY-HUB-LIVE-BASE"$/m);
  // Setting the pin (the hub's later edit) must not red the suite: the line may hold the placeholder or a full sha.
  assert.match(script, /^\$REVIEWED_COMMIT = "(TO-BE-SET-BY-HUB|[0-9a-f]{40})"$/m);
  assert.match(script, /^\$REVIEWED_COMMIT_PLACEHOLDER = "TO-BE-SET-BY-HUB"$/m);
  assert.match(script, /^\$ALLOWED_PATHS_AFTER_REVIEW = @\("scripts\/deploy-rotate-batch\.ps1", "test\/deploy-rotate-batch-script\.test\.ts", "docs\/"\)$/m);
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
  assert.match(runPs(harness("9b341fb7", FULL))!.out, /\[STOP\].*LIVE_BASE_COMMIT.*not 40 lower-case hex/);
  const ok = runPs(harness(LIVE, FULL))!;
  assert.equal(ok.code, 0);
  assert.match(ok.out, /\[PASSED-PINS\]/);
  // The hub has not set the reviewed pin: the script refuses to deploy until it does (this is the builder's state; after the hub sets it the line holds a full sha and the check above still passes).
  assert.match(script, /^\$REVIEWED_COMMIT = "(TO-BE-SET-BY-HUB|[0-9a-f]{40})"$/m, "the reviewed pin is the placeholder or a full lower-case sha");
});

test("the steps are in the load-bearing order, there is no migration or D1 step, wrangler is used once (the stamped deploy), and the only POSTs are the credential-free initialize reads and the two refused rotate requests", () => {
  const order = ["BEGIN-PIN-CHECK", "git fetch origin", "BEGIN-REVIEWED-SOURCE-CHECK", "BEGIN-GATES", 'Read-Attest "before the deploy"', "if ($DryRun)", "BEGIN-DEPLOY-AND-POLL", "$whyAttest = Confirm-Reads", "$whyRotate = Confirm-Reads", "$whyPage = Confirm-Reads", "$whyPointer = Confirm-Reads", "$whyNote = Confirm-Reads", "$whySweep = Confirm-Reads"];
  let last = -1;
  for (const needle of order) {
    const i = script.indexOf(needle.startsWith("BEGIN-") ? "# " + needle : needle);
    assert.ok(i > last, `${needle} comes after the previous step`);
    last = i;
  }
  assert.equal(/\bd1\b|migrations apply|execute --remote/i.test(code.replace(/migrations\b/g, "").replace(/schema\.sql/g, "")), false, "no D1 command");
  assert.equal((code.match(/= \(npx wrangler /g) ?? []).length, 1, "exactly one executed wrangler command (the other mentions are text in messages)");
  assert.match(code, /npx wrangler deploy --var "CODE_COMMIT:\$headSha"/);
  assert.equal(/Invoke-WebRequest|Invoke-RestMethod|-Method\s+Post/i.test(code), false, "no PowerShell web cmdlets; every HTTP call is curl.exe");
  assert.equal((code.match(/-X POST/g) ?? []).length, 2, "exactly two bodiless POSTs, both in Get-PostAnswer");
  const postFn = code.slice(code.indexOf("function Get-PostAnswer("), code.indexOf("function Test-Refusal401("));
  assert.equal((postFn.match(/-X POST/g) ?? []).length, 2, "both bodiless POSTs live in Get-PostAnswer");
  assert.equal((code.match(/Get-PostAnswer \$ROTATE_URL/g) ?? []).length, 2, "Get-PostAnswer is called only against the rotate route, twice");
  assert.equal((code.match(/--data-binary/g) ?? []).length, 1, "exactly one request body, in Get-InitInstructions");
  assert.ok(code.includes('--data-binary "@$req"'), "the initialize body is sent from a temp file");
  // The only credential-shaped string is the bearer that is no citizen's secret, sent once, in Test-RotateRefusals.
  assert.equal((code.match(/Bearer/g) ?? []).length, 1, "one Bearer, in Test-RotateRefusals");
  assert.ok(code.includes('("Bearer " + $NOT_A_SECRET)'), "the bearer is $NOT_A_SECRET");
  assert.equal(/ch1\.|tools\/call|guest_enter|guest_comment|showhome_note|resident_(bind|token)|api\/resident\/(bind|token)|api\/council\/(challenge|claim|ballot)/.test(code), false, "no credential, no tool call, no write tool");
  assert.ok(script.includes("initialize POSTs"), "the closing note says the ride POSTs initialize");
  assert.ok(code.includes("src/doc.ts") && code.includes("migrations schema.sql"), "the no-mint and no-migration check names src/doc.ts, migrations and schema.sql");
  assert.ok(code.includes("git merge-base --is-ancestor $LIVE_BASE_COMMIT HEAD"), "HEAD must contain the live base");
  assert.ok(code.includes("[string]$attBefore.code.commit -cne $LIVE_BASE_COMMIT"), "the live worker is proven to be the pinned base");
});

test("the source checks name literals the checkout carries: this wave's anchors, the earlier waves' anchors, and every Select-String literal is in its file", () => {
  for (const anchor of ["export async function handleOperators", "export async function handlePrivacy"]) {
    assert.ok(code.includes(`-Pattern "${anchor}"`), anchor);
  }
  assert.ok(code.includes(`Select-String -Path "src/doors.ts" -Pattern '"operators_page",'`));
  for (const f of ["guest-core.ts", "mcp.ts", "mcp-read.ts"]) assert.ok(code.includes(`Select-String -Path "src/${f}" -Pattern`), f);
  assert.ok(code.includes(`Select-String -Path "src/index.ts" -Pattern 'path === "/operators" && method === "GET"'`));
  assert.ok(code.includes('Select-String -Path "src/maintainer/parked.ts" -Pattern "export async function parkedPage"'));
  for (const anchor of ["async function commitRotation(", "const ROTATION_RACED_MESSAGE = "]) assert.ok(code.includes(`Select-String -Path "src/society.ts" -Pattern "${anchor}"`), anchor);
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

test("the script's literals are the served constants, byte for byte, and the pre-deploy checks require 200 for the page, the pointer on both doors and the rotate refusals", () => {
  const lit = (name: string): string => new RegExp(`^\\$${name} = "(.*)"$`, "m").exec(script)![1];
  assert.equal(lit("OPERATORS_POINTER"), OPERATORS_POINTER);
  assert.equal(lit("NOTE_SENTENCE"), OPERATORS_NOTE_SENTENCE, "the exact final sentence, not a suffix of it");
  assert.ok(GUEST_OPERATOR_NOTE.endsWith(" " + OPERATORS_NOTE_SENTENCE));
  assert.ok(code.includes('if ([string]$pageBefore.Code -cne "200") { Stop-Here'));
  assert.ok(code.includes("$whyPointerBefore = Test-PointerServed"), "before the deploy the previous wave's pointer must already serve");
  assert.ok(code.includes("$whyRotateBefore = Test-RotateRefusals"), "before the deploy the ride's refusals must already hold");
  assert.ok(script.indexOf("$whyRotateBefore = Test-RotateRefusals") < script.indexOf("if ($DryRun)"), "and the dry run reads them");
  assert.ok(code.includes("Test-OperatorsServed (Get-Page $PAGE_URL 30) (Get-ServedOfficial)"));
  assert.ok(code.includes("$why = Test-PointerServed"), "the poll judges the pointer too");
});

test("Test-PointerServed, run for real against fakes: passes only when BOTH doors carry the pointer exactly once", (t) => {
  const fns = slice("# A credential-free MCP initialize POST", "# END-OF-DEFINITIONS");
  const lines = (a: string, b: string): string[] => [
    "$ErrorActionPreference = 'Stop'",
    `$OPERATORS_POINTER = ${q(OPERATORS_POINTER)}`,
    fns,
    `function Get-InitInstructions($path) { $t = ${q(b)}; if ($path -ceq '/mcp') { $t = ${q(a)} }; if ($t -ceq 'UNREADABLE') { return @{ Text = ''; Why = 'HTTP 502, expected 200' } }; return @{ Text = $t; Why = '' } }`,
    'Write-Host ("RESULT [" + (Test-PointerServed) + "]")',
  ];
  const good = "intro " + OPERATORS_POINTER + " outro";
  const r = runPs(lines(good, good));
  if (!r) return t.skip("no PowerShell available");
  assert.match(r.out, /RESULT \[\]/, r.out);
  assert.match(runPs(lines("intro outro", good))!.out, /the \/mcp initialize answer carries the pointer 0 time/);
  assert.match(runPs(lines(good, "intro outro"))!.out, /the \/mcp\/read initialize answer carries the pointer 0 time/);
  assert.match(runPs(lines(good, good + " " + OPERATORS_POINTER))!.out, /the \/mcp\/read initialize answer carries the pointer 2 time/);
  assert.match(runPs(lines("UNREADABLE", good))!.out, /the \/mcp initialize answer was unreadable: HTTP 502, expected 200/, "an unreadable answer is a failed read that says why, not a pass");
});

test("Get-InitInstructions, run for real against a local HTTP server: it POSTs the initialize body as JSON from a file and reads result.instructions; every failure says why", async (t) => {
  const seen: Array<{ method?: string; type?: string; body: string }> = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      seen.push({ method: req.method, type: req.headers["content-type"], body });
      if (req.url === "/good") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { instructions: "hello " + OPERATORS_POINTER } }));
      } else if (req.url === "/five") {
        res.writeHead(500);
        res.end("boom");
      } else if (req.url === "/notjson") {
        res.writeHead(200);
        res.end("<html>");
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ result: {} }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  try {
    const fns = slice("# A credential-free MCP initialize POST", "# How many times $needle occurs");
    const initBodyLine = script.split("\n").find((l) => l.startsWith("$INIT_BODY = "))!;
    const run = await runPsAsync([
      "$ErrorActionPreference = 'Stop'",
      initBodyLine,
      `$BASE = "http://127.0.0.1:${port}"`,
      fns,
      'foreach ($p in "/good", "/five", "/notjson", "/empty") { $r = Get-InitInstructions $p; Write-Host ("RES " + $p + " [" + $r.Text + "] why [" + $r.Why + "]") }',
      '$BASE = "http://127.0.0.1:1"',
      '$r = Get-InitInstructions "/good"; Write-Host ("RES down [" + $r.Text + "] why [" + $r.Why + "]")',
    ]);
    if (!run) return t.skip("no PowerShell available");
    assert.ok(run.out.includes(`RES /good [hello ${OPERATORS_POINTER}] why []`), run.out);
    assert.match(run.out, /RES \/five \[\] why \[HTTP 500, expected 200\]/);
    assert.match(run.out, /RES \/notjson \[\] why \[the answer was not JSON\]/);
    assert.match(run.out, /RES \/empty \[\] why \[the answer carried no result.instructions\]/);
    assert.match(run.out, /RES down \[\] why \[curl exited \d+/, "a connection failure says curl failed, not a silent empty");
    assert.equal(seen.length, 4);
    for (const s of seen) {
      assert.equal(s.method, "POST");
      assert.match(String(s.type), /^application\/json/);
      const j = JSON.parse(s.body);
      assert.equal(j.method, "initialize");
      assert.equal(j.params.protocolVersion, "2025-11-25");
    }
  } finally {
    server.close();
  }
});

test("Test-NoteServed, run for real against captured /llms.txt answers: passes only a 200 that carries the sentence", (t) => {
  const fns = slice('# "" when GET /llms.txt carries', "# END-OF-DEFINITIONS");
  const cases: Array<[string, string, string, string]> = [
    ["good", "200", "intro " + OPERATORS_NOTE_SENTENCE + " outro", ""],
    ["missing", "200", "intro without it", "does not yet carry the operator-note sentence"],
    ["truncated", "200", OPERATORS_NOTE_SENTENCE.slice(0, 30), "does not yet carry the operator-note sentence"],
    ["notfound", "404", OPERATORS_NOTE_SENTENCE, "GET /llms.txt answered 404"],
    ["server", "500", "", "GET /llms.txt answered 500"],
  ];
  const run = runPs([
    "$ErrorActionPreference = 'Stop'",
    '$BASE = "https://example.invalid"',
    `$NOTE_SENTENCE = ${q(OPERATORS_NOTE_SENTENCE)}`,
    fns,
    ...cases.flatMap(([name, code2, body]) => [`function Get-Text($url, $maxTime) { return @{ Code = ${q(code2)}; Type = 'text/plain'; Body = ${q(body)} } }`, `Write-Host ("RESULT ${name} [" + (Test-NoteServed) + "]")`]),
  ]);
  if (!run) return t.skip("no PowerShell available");
  for (const [name, , , expect] of cases) {
    const m = new RegExp(`RESULT ${name} \\[(.*)\\]`).exec(run.out);
    assert.ok(m, `${name}: ${run.out.slice(0, 400)}`);
    if (expect === "") assert.equal(m![1], "", name);
    else assert.ok(m![1].includes(expect), `${name}: '${m![1]}'`);
  }
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
  `$OPERATORS_POINTER = ${q(OPERATORS_POINTER)}`,
  `function Get-InitInstructions($path) { return @{ Text = ${q("x " + OPERATORS_POINTER + " y")}; Why = '' } }`,
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

test("L-167, the poll judges the initialise answers too: attest and /operators good but the answer still lacks the pointer is 'not yet', never good", (t) => {
  const stale = fakes(["good", "good", "good"]).map((l) => (l.startsWith("function Get-InitInstructions") ? "function Get-InitInstructions($path) { return @{ Text = 'the old answer, no pointer'; Why = '' } }" : l));
  const r = runPs([...stale, `Wait-NewWorker '${COMMIT}' '${VERSION}' 3 0`, 'Write-Host "[WAITED]"']);
  if (!r) return t.skip("no PowerShell available");
  assert.equal(r.code, 1, r.out);
  assert.equal(/\[WAITED\]/.test(r.out), false);
  assert.match(r.out, /not yet: the \/mcp initialize answer carries the pointer 0 time/);
});

test("L-167, the retry run for real: a stale read resets the run, a bounded run of good reads passes, a run that never forms returns the last reason, and it never stops or names a remedy", (t) => {
  const retry = slice("# L-167. Runs the check", "# Polls (GETs, and");
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
  assert.equal((ride.match(/= Confirm-Reads /g) ?? []).length, 6, "attest, the rotate refusals, the page, the pointer, the llms.txt sentence and the sweep");
  assert.equal(ride.includes("Assert-Attest"), false, "the single-read attest assertion is for before the deploy only");
  const stops = ride.split("\n").filter((l) => l.includes("Stop-Here"));
  assert.equal(stops.length, 6, "one stop per retried check");
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

test("the rotate refusal literals are the source's own texts, and the ride's bearer is neither a secret's shape nor an assertion", () => {
  const lit = (name: string): string => new RegExp(`^\\$${name} = "(.*)"$`, "m").exec(script)![1];
  assert.equal(lit("ROTATE_URL"), "$BASE/api/rotate");
  const noCred = lit("NO_CREDENTIALS_PREFIX");
  const unknown = lit("UNKNOWN_SECRET_TEXT");
  const auth = SOCIETY_SRC.slice(SOCIETY_SRC.indexOf("export async function authenticate("), SOCIETY_SRC.indexOf("export async function authenticate(") + 3000);
  assert.ok(auth.includes(`throw new SocietyError(401, "${noCred}`), "the no-credential 401 starts with the script's prefix");
  assert.ok(auth.includes(`throw new SocietyError(401, "${unknown}")`), "the unknown-secret 401 is the script's text exactly");
  const bearer = lit("NOT_A_SECRET");
  assert.equal(bearer.startsWith("commonhold_sk_"), false, "not newSecret()'s shape");
  assert.equal(bearer.startsWith("ch1."), false, "not an assertion, so authenticate() takes the hash lookup and refuses");
  assert.equal(/[^a-z-]/.test(bearer), false, "plain, so PowerShell 5.1 passes it to curl.exe unchanged");
});

test("Test-RotateRefusals, run for real against a local HTTP server: passes only the three refusals the gate named, sends the bearer it says, and says why each wrong answer fails", async (t) => {
  const seen: Array<{ mode: string; method?: string; auth?: string; body: string }> = [];
  const NO_CRED = "No credentials. Register first, then present your citizen credential.";
  const UNKNOWN = "Unknown secret. It identifies no citizen.";
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      const [, mode, ...rest] = String(req.url).split("/");
      const path = "/" + rest.join("/");
      seen.push({ mode, method: req.method, auth: req.headers.authorization, body });
      const send = (status: number, obj: unknown): void => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(obj));
      };
      if (path !== "/api/rotate") return send(500, { error: "wrong path " + path });
      if (req.method === "GET") return mode === "getok" ? send(200, {}) : send(404, { error: "Not found. GET / explains everything." });
      if (mode === "rotated") return send(200, { handle: "x" });
      if (!req.headers.authorization) return send(401, { error: mode === "wrongtext" ? "Something else." : NO_CRED });
      if (mode === "notjson") {
        res.writeHead(401);
        return res.end("<html>");
      }
      return send(401, { error: UNKNOWN });
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  try {
    const fns = slice("# The status code, content type and body of a GET", "# END-OF-DEFINITIONS");
    const litLine = (name: string): string => script.split("\n").find((l) => l.startsWith(`$${name} = `))!;
    const run = await runPsAsync([
      "$ErrorActionPreference = 'Stop'",
      litLine("NO_CREDENTIALS_PREFIX"),
      litLine("UNKNOWN_SECRET_TEXT"),
      litLine("NOT_A_SECRET"),
      fns,
      `foreach ($m in "good", "rotated", "wrongtext", "notjson", "getok") { $BASE = "http://127.0.0.1:${port}/" + $m; $ROTATE_URL = "$BASE/api/rotate"; Write-Host ("RES " + $m + " [" + (Test-RotateRefusals) + "]") }`,
      '$ROTATE_URL = "http://127.0.0.1:1/api/rotate"; Write-Host ("RES down [" + (Test-RotateRefusals) + "]")',
    ]);
    if (!run) return t.skip("no PowerShell available");
    assert.match(run.out, /RES good \[\]/, run.out);
    assert.match(run.out, /RES rotated \[POST \/api\/rotate with no credential answered 200, expected 401\]/);
    assert.match(run.out, /RES wrongtext \[POST \/api\/rotate with no credential: the 401 error is 'Something else\.', expected it to start 'No credentials\. Register first'\]/);
    assert.match(run.out, /RES notjson \[POST \/api\/rotate with a bearer that is no citizen's secret: the 401 was not JSON\]/);
    assert.match(run.out, /RES getok \[GET \/api\/rotate answered 200, expected 404 \(the route is POST only\)\]/);
    assert.match(run.out, /RES down \[POST \/api\/rotate with no credential: curl exited \d+/, "a connection failure says curl failed, not a pass");
    const good = seen.filter((s) => s.mode === "good");
    assert.deepEqual(good.map((s) => s.method), ["POST", "POST", "GET"]);
    assert.equal(good[0].auth, undefined, "the first POST carries no Authorization header");
    assert.equal(good[1].auth, "Bearer commonhold-ride-not-a-credential", "the second carries exactly the non-credential bearer");
    for (const s of seen) assert.equal(s.body, "", "no request body is sent");
  } finally {
    server.close();
  }
});
