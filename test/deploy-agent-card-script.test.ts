// scripts/deploy-agent-card.ps1 is WRITTEN AND NEVER RUN by this test (no deploy, no wrangler, not even -DryRun, which reads the live worker over HTTP). It is proven here by what can be
// proven without running it: it parses under PowerShell's own parser, is ASCII with LF endings, has none of the repo's PowerShell traps, has the load-bearing step order, no migration, no D1 command of any kind, a single deploy,
// a ride of public GETs, credential-free JSON-RPC and initialize POSTs and refused rotate and wallet requests, step 0a stops on the placeholder before any git or network command (the pin block is run for real), every Select-String literal is in its file,
// the earlier waves' checks are kept (run for real against local HTTP servers and fakes), L-167 is proven by running the real poll and the real retry against fakes, and the WAVE'S OWN RIDE is run for real: the extracted PowerShell
// functions against a local HTTP server that wraps the REAL worker handlers (src/index.ts over a real local D1, so the fixture is the actual wave and the counters are the real managed-schema counters), then against failing fixtures,
// one per judged item. Derived from the wallet batch deploy script test.
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
import worker from "../src/index.ts";
import { createLocalD1, seedCitizens, guestEnv, freshIp } from "./helpers/guest.ts";
import { PROBE_DOORS, PROBE_DOOR_DAILY_CAP, utcDay, countDoor } from "../src/doors.ts";
import type { Env } from "../src/society.ts";
import { renderOperators, OPERATORS_CSP, type OperatorsFigures } from "../src/operators.ts";
import { OPERATORS_POINTER, OPERATORS_NOTE_SENTENCE, GUEST_OPERATOR_NOTE } from "../src/guest-core.ts";

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
const SCRIPT_PATH = here("../scripts/deploy-agent-card.ps1");
const rawScript = readFileSync(SCRIPT_PATH, "utf8");
const script = rawScript.replace(/\r\n/g, "\n");
const code = script.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
const defs = script.slice(script.indexOf('$ErrorActionPreference = "Stop"'), script.indexOf("# END-OF-DEFINITIONS"));
const pinBlock = script.slice(script.indexOf("# BEGIN-PIN-CHECK"), script.indexOf("# END-PIN-CHECK"));
const ride = script.slice(script.indexOf("# 4. the ride"));

const LIVE = "0090313a57e938479232959f3d7834a317d9bb8b";
const REVIEWED = "113edd2a6f7b4f34f91c224bfcf971d226e84685";
const SOCIETY_SRC = readFileSync(here("../src/society.ts"), "utf8");
const INDEX_SRC = readFileSync(here("../src/index.ts"), "utf8");

// An ordering check that cannot pass on a missing anchor: indexOf returns -1 for an absent string, and -1 is less than every real index.
const before = (a: number, b: number, msg: string): void => {
  assert.ok(a >= 0 && b >= 0, `${msg} (both anchors must be present: ${a}, ${b})`);
  assert.ok(a < b, msg);
};
// The text between the braces that open at src[open].
function braceBlock(src: string, open: number): string {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") {
      depth--;
      if (depth === 0) return src.slice(open + 1, i);
    }
  }
  return "";
}
// Every Confirm-Reads call site in src with its scriptblock: a literal block, or the block a variable was assigned (`$name = {`). sites counts the calls; blocks holds what was found for each.
function confirmReadsBlocks(src: string): { sites: number; blocks: string[] } {
  const blocks: string[] = [];
  let sites = 0;
  for (const m of src.matchAll(/Confirm-Reads\s*(\{|\$[A-Za-z0-9_]+)/g)) {
    sites++;
    let open = -1;
    if (m[1] === "{") open = m.index! + m[0].length - 1;
    else {
      const def = src.indexOf(`${m[1]} = {`);
      open = def >= 0 ? src.indexOf("{", def) : -1;
    }
    blocks.push(open >= 0 ? braceBlock(src, open) : "");
  }
  return { sites, blocks };
}

function runPs(lines: string[]): { code: number | null; out: string } | null {
  const dir = mkdtempSync(join(tmpdir(), "deploy-agent-card-"));
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
  const dir = mkdtempSync(join(tmpdir(), "deploy-agent-card-"));
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
  assert.equal(/\$(?!env:)[A-Za-z_][A-Za-z0-9_]*:/.test(code.replace(/\$\(/g, "")), false);
  for (const m of code.matchAll(/2>&1/g)) {
    const before = code.slice(0, m.index);
    assert.ok(before.lastIndexOf('$ErrorActionPreference = "Continue"') > before.lastIndexOf('$ErrorActionPreference = "Stop"'));
  }
  assert.equal(/\$\w+\s*\|\s*Where-Object[^\n]*-notmatch/.test(code), false);
});

test("the pins: the v6 hash, the live base 0090313a, the reviewed pin is the placeholder or a 40-hex sha (and is the reviewed 113edd2a in full), the allowlist is this script, its test and docs/, the parameters are -ExpectedCommit (mandatory) and -DryRun, the CSP is the handler's", () => {
  assert.match(script, /^\$V6_HASH = "dc5f48213c29bcf844e0fbe7daf1bdb5416b3d57fbd06a8bd03f1061f34092b3"$/m);
  assert.match(script, new RegExp(`^\\$LIVE_BASE_COMMIT = "${LIVE}"$`, "m"));
  assert.match(script, /^\$LIVE_BASE_PLACEHOLDER = "TO-BE-SET-BY-HUB-LIVE-BASE"$/m);
  // The reviewed pin is set below; step 0a still STOPS on the placeholder form, so this line is accepted in either shape.
  assert.match(script, /^\$REVIEWED_COMMIT = "(TO-BE-SET-BY-HUB|[0-9a-f]{40})"$/m);
  assert.match(script, /^\$REVIEWED_COMMIT_PLACEHOLDER = "TO-BE-SET-BY-HUB"$/m);
  assert.match(script, new RegExp(`^\\$REVIEWED_COMMIT = "${REVIEWED}"$`, "m"), "the reviewed pin is the full sha of 113edd2a");
  assert.match(script, /^\$ALLOWED_PATHS_AFTER_REVIEW = @\("scripts\/deploy-agent-card\.ps1", "test\/deploy-agent-card-script\.test\.ts", "docs\/"\)$/m);
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
  // The reviewed pin is set (113edd2a, asserted in full above); this only checks the line's shape.
  assert.match(script, /^\$REVIEWED_COMMIT = "(TO-BE-SET-BY-HUB|[0-9a-f]{40})"$/m, "the reviewed pin is the placeholder or a full lower-case sha");
});

test("the steps are in the load-bearing order, there is no migration, no D1 command of any kind and no D1 read, the deploy is the only wrangler command, and the only POSTs are the credential-free initialize reads, the refused rotate and wallet requests and the wave ride's JSON-RPC bodies (each from a temp file)", () => {
  const order = ["BEGIN-PIN-CHECK", "git fetch origin", "BEGIN-REVIEWED-SOURCE-CHECK", "BEGIN-GATES", 'Read-Attest "before the deploy"', "$whyRotateBefore = Test-RotateRefusals", "$whyWalletBefore = Test-WalletRefusals", "$whyAbsent = Test-WaveAbsent", "$docsBefore = Get-DocsHashes", "if ($DryRun)", "BEGIN-DEPLOY-AND-POLL", "$whyAttest = Confirm-Reads", "$whyRotate = Confirm-Reads", "$whyWallet = Confirm-Reads", "$whyPage = Confirm-Reads", "$whyPointer = Confirm-Reads", "$whyNote = Confirm-Reads", "$rideResult = Invoke-WaveRide $docsBefore", "$whySweep = Confirm-Reads"];
  let last = -1;
  for (const needle of order) {
    const i = script.indexOf(needle.startsWith("BEGIN-") ? "# " + needle : needle);
    assert.ok(i > last, `${needle} comes after the previous step`);
    last = i;
  }
  assert.equal(/migrations apply/i.test(code), false, "no migration apply");
  assert.equal(/d1 execute|Invoke-Bounded|D1_SQL_ARG|--remote|wrangler d1/i.test(code), false, "no D1 command, no bounded command runner, no SQL");
  assert.equal(/migtest|scratch/i.test(code), false, "no scratch database anywhere in the executable code");
  assert.equal((code.match(/= \(npx wrangler /g) ?? []).length, 1, "exactly one executed wrangler command (the other mentions are text in messages)");
  // Assigned or not: a command at the start of a line, or after = ( or ; { | or &, counts too. Mutation that reds this: add a bare `npx wrangler d1 list` line.
  assert.equal((code.match(/(?:^|= \(|[;{|&])[ \t]*npx wrangler /gm) ?? []).length, 1, "no other executed wrangler command, assigned or not");
  assert.match(code, /npx wrangler deploy --var "CODE_COMMIT:\$headSha"/);
  assert.equal(/Invoke-WebRequest|Invoke-RestMethod|-Method\s+Post/i.test(code), false, "no PowerShell web cmdlets; every HTTP call is curl.exe");
  assert.equal((code.match(/-X POST/g) ?? []).length, 2, "exactly two bodiless POSTs, both in Get-PostAnswer");
  const postFn = code.slice(code.indexOf("function Get-PostAnswer("), code.indexOf("function Test-Refusal401("));
  assert.equal((postFn.match(/-X POST/g) ?? []).length, 2, "both bodiless POSTs live in Get-PostAnswer");
  assert.equal((code.match(/Get-PostAnswer \$ROTATE_URL/g) ?? []).length, 2, "Get-PostAnswer is called against the rotate route twice");
  assert.equal((code.match(/Get-PostAnswer \$WALLET_URL/g) ?? []).length, 2, "and against the wallet route twice");
  assert.equal((code.match(/\bGet-PostAnswer\b/g) ?? []).length, 5, "one definition and those four calls: no Get-PostAnswer call to any other URL");
  assert.equal((code.match(/--data-binary/g) ?? []).length, 2, "exactly two request bodies: Get-InitInstructions and Get-JsonPost");
  assert.ok(code.includes('--data-binary "@$req"'), "the initialize body is sent from a temp file");
  assert.ok(code.includes('$curlArgs += ("@" + $req)'), "every JSON-RPC body is sent from a temp file, never as a quoted argument");
  assert.equal((code.match(/\bGet-JsonPost\b/g) ?? []).length, 1 + 5 + 1 + 3 + 2 + 1, "one definition, five refused /a2a bodies in Test-A2aUncounted, one null body in Test-McpUncounted, three counted sends in Send-A2aCounted, two in Send-McpCounted, one in Resend-McpUnknown");
  // The only credential-shaped string is the bearer that is no citizen's secret, sent once per refusal check (Test-RotateRefusals, Test-WalletRefusals).
  assert.equal((code.match(/Bearer/g) ?? []).length, 2, "one Bearer in each refusal check");
  assert.equal((code.match(/\("Bearer " \+ \$NOT_A_SECRET\)/g) ?? []).length, 2, "the bearer is $NOT_A_SECRET, both times");
  assert.equal(/ch1\.|tools\/call|guest_comment|showhome_note|resident_(bind|token)|api\/resident\/(bind|token)|api\/council\/(challenge|claim|ballot)/.test(code), false, "no credential, no tool call, no write tool");
  assert.ok(script.includes("initialize"), "the closing note says the ride POSTs initialize");
  assert.ok(code.includes("src/doc.ts") && code.includes("migrations schema.sql"), "the no-mint and no-migration check names src/doc.ts, migrations and schema.sql");
  assert.ok(code.includes("git merge-base --is-ancestor $LIVE_BASE_COMMIT HEAD"), "HEAD must contain the live base");
  assert.ok(code.includes("[string]$attBefore.code.commit -cne $LIVE_BASE_COMMIT"), "the live worker is proven to be the pinned base");
  before(code.indexOf("$whyAbsent = Test-WaveAbsent"), code.indexOf("if ($DryRun)"), "the 404 read is before the dry-run exit");
  before(code.indexOf("$docsBefore = Get-DocsHashes"), code.indexOf("if ($DryRun)"), "the docs read is before the dry-run exit");
  before(script.indexOf("# END-PIN-CHECK"), script.indexOf("# BEGIN-CLOCK-CHECK"), "the clock check follows the pin check");
  before(script.indexOf("# END-CLOCK-CHECK"), script.indexOf("git fetch origin"), "the clock check is before the first git (network) command");
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
  for (const anchor of ["const WALLET_RACED_MESSAGE =", "UPDATE wallets SET address = ?, added_at = MAX(?, added_at + 1) WHERE citizen_id = ? AND address = ? AND added_at = ?"]) assert.ok(code.includes(`Select-String -Path "src/wallets.ts" -Pattern "${anchor}"`), anchor);
  assert.ok(code.includes('Select-String -Path "src/chain.ts" -Pattern "export function parseUniqueColumns("'));
  // This wave's own anchors: strings only the agent card / A2A code carries.
  for (const [file, anchor] of [
    ["src/a2a.ts", "A2A-Version not supported: this endpoint speaks 0.3 and 1.0."],
    ["src/a2a.ts", "export function mcpUnknownMethod("],
    ["src/a2a-cards.ts", "export function agentCardV03("],
    ["src/doors.ts", 'export const PROBE_DOORS = ["agent_card", "a2a_send", "mcp_a2a_probe", "mcp_unknown_method"] as const;'],
    ["src/index.ts", 'if (path === "/a2a") return await handleA2a(request, env, ctx);'],
    ["src/mcp.ts", 'if (msg === null || typeof msg !== "object") {'],
    ["src/mcp-read.ts", 'if (msg === null || typeof msg !== "object") {'],
  ] as const) {
    assert.ok(code.includes(`Select-String -Path "${file}" -Pattern ${anchor.includes("'") ? '"' + anchor + '"' : anchor.includes('"') ? "'" + anchor + "'" : '"' + anchor + '"'}`), `${file} anchor ${anchor}`);
  }
  let n = 0;
  for (const m of code.matchAll(/Select-String -Path "([^"]+)" -Pattern ('[^']+'|"[^"]+")/g)) {
    if (m[1] === "wrangler.jsonc") continue;
    const lit = m[2].slice(1, -1);
    assert.ok(readFileSync(here(`../${m[1]}`), "utf8").includes(lit), `${m[1]} carries '${lit}'`);
    n++;
  }
  assert.ok(n >= 19, `checked ${n} literals`);
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
  before(script.indexOf("$whyRotateBefore = Test-RotateRefusals"), script.indexOf("if ($DryRun)"), "and the dry run reads them");
  assert.ok(code.includes("$whyWalletBefore = Test-WalletRefusals"), "before the deploy the wallet refusals must already hold");
  before(script.indexOf("$whyWalletBefore = Test-WalletRefusals"), script.indexOf("if ($DryRun)"), "and the dry run reads them");
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
  assert.equal((ride.match(/= Confirm-Reads /g) ?? []).length, 7, "attest, the rotate refusals, the wallet refusals, the page, the pointer, the llms.txt sentence and the sweep");
  assert.equal(ride.includes("Assert-Attest"), false, "the single-read attest assertion is for before the deploy only");
  const stops = ride.split("\n").filter((l) => l.includes("Stop-Here"));
  assert.equal(stops.length, 8, "one stop per retried check, plus the wave ride (its uncounted checks are retried inside Invoke-WaveRide and each of its counted requests is retried until its answer passes)");
  for (const l of stops) {
    assert.match(l, /^if \(\$why[A-Za-z]* -ne ""\) \{ Stop-Here/, `a ride stop is raised only from a retry result: ${l.slice(0, 60)}`);
    assert.ok(l.includes("by hand first"), `it says to read by hand first: ${l.slice(0, 60)}`);
    before(l.indexOf("by hand first"), l.indexOf("$ROLLBACK_LINE"), `the rollback comes after the instruction to read first: ${l.slice(0, 60)}`);
    assert.match(l, /Only if /, "and the rollback is conditional");
  }
  assert.match(script, /Read 'npx wrangler deployments list' and GET \/api\/attest by hand first[^\n]*Only if the new version is not at 100%/);
  assert.match(script, /^\$GOOD_READS_NEEDED = 3$/m);
  assert.match(script, /^\$RIDE_TRIES = 12$/m);
  assert.ok(script.includes("AND THEY ARE IN THE DAY'S FIGURES") && script.includes("NO REAL A2A CLIENT WAS RUN"), "the closing note says the ride's counted requests are in the day's figures and that no real client ran");
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

function refusalTest(title: string, fn: string, urlVar: string, apiPath: string): void {
  test(title, async (t) => {
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
        if (path !== apiPath) return send(500, { error: "wrong path " + path });
        if (req.method === "GET") return mode === "getok" ? send(200, {}) : send(404, { error: "Not found. GET / explains everything." });
        if (mode === "accepted") return send(200, { handle: "x" });
        if (!req.headers.authorization) return send(401, { error: mode === "wrongtext" ? "Something else." : NO_CRED });
        if (mode === "bearerwrong") return send(401, { error: "unknown secret. It identifies no citizen." });
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
        `foreach ($m in "good", "accepted", "wrongtext", "bearerwrong", "notjson", "getok") { $BASE = "http://127.0.0.1:${port}/" + $m; $${urlVar} = "$BASE${apiPath}"; Write-Host ("RES " + $m + " [" + (${fn}) + "]") }`,
        `$${urlVar} = "http://127.0.0.1:1${apiPath}"; Write-Host ("RES down [" + (${fn}) + "]")`,
      ]);
      if (!run) return t.skip("no PowerShell available");
      const esc = (x: string): string => x.replace(/[.*+?^${}()|[\]\\\/]/g, "\\$&");
      assert.match(run.out, /RES good \[\]/, run.out);
      assert.match(run.out, new RegExp(`RES accepted \\[POST ${esc(apiPath)} with no credential answered 200, expected 401\\]`));
      assert.match(run.out, new RegExp(`RES wrongtext \\[POST ${esc(apiPath)} with no credential: the 401 error is 'Something else\\.', expected it to start 'No credentials\\. Register first'\\]`));
      assert.match(run.out, new RegExp(`RES bearerwrong \\[POST ${esc(apiPath)} with a bearer that is no citizen's secret: the 401 error is 'unknown secret\\. It identifies no citizen\\.', expected it to start 'Unknown secret\\. It identifies no citizen\\.'\\]`), "the bearer POST's text is checked, case-sensitively (GEMINI r1)");
      assert.match(run.out, new RegExp(`RES notjson \\[POST ${esc(apiPath)} with a bearer that is no citizen's secret: the 401 was not JSON\\]`));
      assert.match(run.out, new RegExp(`RES getok \\[GET ${esc(apiPath)} answered 200, expected 404 \\(the route is POST only\\)\\]`));
      assert.match(run.out, new RegExp(`RES down \\[POST ${esc(apiPath)} with no credential: curl exited \\d+`), "a connection failure says curl failed, not a pass");
      const good = seen.filter((s2) => s2.mode === "good");
      assert.deepEqual(good.map((s2) => s2.method), ["POST", "POST", "GET"]);
      assert.equal(good[0].auth, undefined, "the first POST carries no Authorization header");
      assert.equal(good[1].auth, "Bearer commonhold-ride-not-a-credential", "the second carries exactly the non-credential bearer");
      for (const s2 of seen) assert.equal(s2.body, "", "no request body is sent");
    } finally {
      server.close();
    }
  });
}
refusalTest("Test-RotateRefusals, run for real against a local HTTP server: passes only the three refusals the gate named, sends the bearer it says, and says why each wrong answer fails", "Test-RotateRefusals", "ROTATE_URL", "/api/rotate");
refusalTest("Test-WalletRefusals, run for real against a local HTTP server: passes only the three refusals (no credential, a bearer that is no citizen's secret, a GET), sends the bearer it says, and says why each wrong answer fails (200 accepted, wrong text, wrong case, not JSON, GET 200, server down)", "Test-WalletRefusals", "WALLET_URL", "/api/wallet");

test("the wallet refusal literals: the route is POST only in the source, so GET falls through to 404, and the refused POSTs reach authenticate() before declareWallet", () => {
  assert.equal(/^\$WALLET_URL = "\$BASE\/api\/wallet"$/m.test(script), true);
  assert.ok(INDEX_SRC.includes('path === "/api/wallet" && method === "POST"'));
  assert.equal(/"\/api\/wallet"[^\n]*method === "GET"|method === "GET"[^\n]*"\/api\/wallet"/.test(INDEX_SRC), false, "no GET handler on /api/wallet");
  const at = INDEX_SRC.indexOf('path === "/api/wallet" && method === "POST"');
  const blk = INDEX_SRC.slice(at, at + 400);
  before(blk.indexOf("authenticate(env, credential)"), blk.indexOf("declareWallet("), "authenticate runs first");
});


// ---------- the wave's own ride: the real extracted functions against the REAL handlers, then against failing fixtures ----------

const doorsFns = slice("# ---------- THE A2A WAVE'S OWN CHECKS", "# END-OF-DEFINITIONS");

test("the script's probe doors and bodies are the source's own: PROBE_DOORS, the unknown-method text, the card and /a2a paths", () => {
  const names = /^\$PROBE_DOOR_NAMES = @\((.*)\)$/m.exec(script)![1].split(",").map((s2) => s2.trim().replace(/"/g, ""));
  assert.deepEqual(names, [...PROBE_DOORS], "the four probe doors, in the source's order");
  assert.equal(/^\$CARD_V1_PATH = "(.*)"$/m.exec(script)![1], "/.well-known/agent-card.json");
  assert.equal(/^\$CARD_V03_PATH = "(.*)"$/m.exec(script)![1], "/.well-known/agent.json");
  assert.equal(/^\$A2A_PATH = "(.*)"$/m.exec(script)![1], "/a2a");
  assert.ok(INDEX_SRC.includes('path === "/.well-known/agent-card.json"') && INDEX_SRC.includes('path === "/.well-known/agent.json"') && INDEX_SRC.includes('path === "/a2a"'));
  const mcpUnknown = /^\$MCP_UNKNOWN_TEXT = "(.*)"$/m.exec(script)![1];
  assert.equal(mcpUnknown, "method 'ride/unknown' not found");
  assert.ok(readFileSync(here("../src/a2a.ts"), "utf8").includes("message: `method '${method}' not found`"), "today's text, byte for byte, is the source's template");
  assert.match(script, /PROBE_DOOR_NAMES/);
  assert.ok(PROBE_DOOR_DAILY_CAP === 200);
});

test("static: every counted request goes through Invoke-Counted (retried until its judge passes, up to $RIDE_TRIES, no status-code special case), never from inside a Confirm-Reads block, and the old send-once wording is gone", () => {
  const ride2 = code.slice(code.indexOf("function Invoke-WaveRide("));
  const found = confirmReadsBlocks(ride2);
  assert.equal(found.sites, 6 + 7, "Confirm-Reads call sites from Invoke-WaveRide on: 4 literal blocks and 2 uses of $riseCheck in the function, 7 at the top level");
  assert.equal(found.blocks.length, found.sites);
  for (const b of found.blocks) {
    assert.ok(b.length > 0, "every call site's scriptblock was found, literal or variable");
    assert.equal(/Send-|Resend-|Get-JsonPost|Invoke-Counted/.test(b), false, `a Confirm-Reads block sends no counted request: ${b.slice(0, 60)}`);
  }
  for (const fn of ["Send-Cards", "Send-A2aCounted", "Send-McpCounted", "Resend-McpUnknown"]) assert.equal((code.match(new RegExp(`\\b${fn}\\b`, "g")) ?? []).length, 2, `${fn}: one definition and one call`);
  const countedFns = code.slice(code.indexOf("function Send-Cards("), code.indexOf("function Test-A2aUncounted"));
  assert.equal((countedFns.match(/Invoke-Counted "/g) ?? []).length, 1 + 3 + 2 + 1, "one call site for the cards, three for a2a, two for mcp, one for the resend");
  assert.deepEqual(countedFns.split("\n").filter((l) => l.includes("Get-JsonPost") && !l.includes("Invoke-Counted")), [], "no counted function posts outside Invoke-Counted");
  const fn = code.slice(code.indexOf("function Invoke-Counted("), code.indexOf("function Test-RpcError("));
  assert.ok(fn.includes("$n -le $RIDE_TRIES") && fn.includes("& $judge $ans") && fn.includes("Start-Sleep -Seconds $RIDE_DELAY_SECONDS"), "bounded by $RIDE_TRIES, judged, with the delay");
  assert.equal(/-ceq "404"|\.Code -c?(eq|ne)|\.Exit/.test(fn), false, "no status-code or exit-code special case in the retry: the judge decides");
  assert.equal(/Confirm-Reads/.test(fn), false);
  assert.equal(/never repeated|none was repeated|never retried through Confirm-Reads|sent ONCE|each sent once|each once/i.test(script), false, "the send-once wording is gone everywhere");
  assert.ok(script.includes("ATTEMPTS") && script.includes("PROVED"));
});
// A local HTTP server that wraps the REAL worker (src/index.ts over a real local D1). intercept() may answer instead of the worker (a stale edge); after() may alter the worker's answer (a broken wave).
interface Seen {
  method: string;
  path: string;
  body: string;
  headers: Record<string, string | string[] | undefined>;
}
interface Ans {
  status: number;
  headers: Record<string, string>;
  body: string;
}
interface Fixture {
  intercept?: (s: Seen, n: number) => Ans | undefined;
  after?: (s: Seen, res: Ans, n: number) => Ans | undefined;
  seed?: (env: Env) => Promise<void>;
}
const jsonAns = (o: unknown, status = 200): Ans => ({ status, headers: { "content-type": "application/json" }, body: JSON.stringify(o) });
const parseBody = (s: Seen): any => {
  try {
    return JSON.parse(s.body);
  } catch {
    return null;
  }
};
const mutateJson = (res: Ans, fn: (j: any) => void): Ans => {
  const j = JSON.parse(res.body);
  fn(j);
  return { ...res, body: JSON.stringify(j) };
};

async function withWave<T>(fx: Fixture, run: (port: number, d1: ReturnType<typeof createLocalD1>, env: Env) => Promise<T>): Promise<T> {
  const d1 = createLocalD1();
  seedCitizens(d1);
  const env = guestEnv(d1);
  if (fx.seed) await fx.seed(env);
  const hits = new Map<string, number>();
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (d) => chunks.push(d));
    req.on("end", async () => {
      const method = String(req.method);
      const path = String(req.url);
      const key = `${method} ${path}`;
      const n = (hits.get(key) ?? 0) + 1;
      hits.set(key, n);
      const seen: Seen = { method, path, body: Buffer.concat(chunks).toString("utf8"), headers: req.headers };
      let ans = fx.intercept?.(seen, n);
      if (!ans) {
        const pending: Promise<unknown>[] = [];
        const headers: Record<string, string> = { "CF-Connecting-IP": freshIp() };
        for (const h of ["content-type", "a2a-version", "authorization"]) if (typeof req.headers[h] === "string") headers[h] = req.headers[h] as string;
        const r = await worker.fetch(new Request(`http://127.0.0.1:${(server.address() as { port: number }).port}${path}`, { method, headers, body: method === "GET" || method === "HEAD" ? undefined : seen.body }), env, { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => {} } as unknown as ExecutionContext);
        await Promise.all(pending);
        const out: Record<string, string> = {};
        r.headers.forEach((v, k) => {
          if (k !== "content-length" && k !== "content-encoding" && k !== "transfer-encoding") out[k] = v;
        });
        ans = { status: r.status, headers: out, body: await r.text() };
        ans = fx.after?.(seen, ans, n) ?? ans;
      }
      if (ans.status === 0) {
        req.socket.destroy(); // a connection closed with no answer: curl exits non-zero
        return;
      }
      res.writeHead(ans.status, ans.headers);
      res.end(ans.status === 204 ? undefined : ans.body);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  try {
    return await run((server.address() as { port: number }).port, d1, env);
  } finally {
    server.close();
    d1.close();
  }
}

const rideHarness = (port: number, tries: number, tail: string[]): string[] => [
  "$ErrorActionPreference = 'Stop'",
  defs,
  "function Start-Sleep { }",
  `$BASE = "http://127.0.0.1:${port}"`,
  "$RIDE_DELAY_SECONDS = 0",
  `$RIDE_TRIES = ${tries}`,
  ...tail,
];
const rideTail = (times = 1): string[] => [
  "$docs = Get-DocsHashes",
  'if ($docs.Why -ne "") { Write-Host ("DOCS-FAIL " + $docs.Why); exit 2 }',
  ...Array.from({ length: times }, () => 'Start-Sleep -Seconds 0; $res = Invoke-WaveRide $docs; Write-Host ("WHY [" + $res.Why + "]"); Write-Host ("SENT ATT " + $res.Attempts["agent_card"] + " " + $res.Attempts["a2a_send"] + " " + $res.Attempts["mcp_a2a_probe"] + " " + $res.Attempts["mcp_unknown_method"] + " PROV " + $res.Proved["agent_card"] + " " + $res.Proved["a2a_send"] + " " + $res.Proved["mcp_a2a_probe"] + " " + $res.Proved["mcp_unknown_method"] + " ROUNDS " + $res.Rounds)'),
];
interface RideOut {
  whys: string[];
  sents: string[];
  out: string;
}
async function ride3(fx: Fixture, opts: { tries?: number; times?: number } = {}): Promise<RideOut & { counts: Record<string, number> }> {
  return withWave(fx, async (port, d1) => {
    const r = await runPsAsync(rideHarness(port, opts.tries ?? 4, rideTail(opts.times ?? 1)));
    const out = r ? r.out : "NO-POWERSHELL";
    const whys = [...out.matchAll(/^WHY \[(.*)\]\s*$/gm)].map((m) => m[1]);
    const sents = [...out.matchAll(/^SENT (.*?)\s*$/gm)].map((m) => m[1]);
    const counts: Record<string, number> = {};
    for (const row of d1.raw.prepare("SELECT door, n FROM door_counts WHERE day = ?").all(utcDay(Date.now())) as Array<{ door: string; n: number }>) counts[row.door] = row.n;
    return { whys, sents, out, counts };
  });
}
const seedDoor = (door: string, times: number) => async (env: Env): Promise<void> => {
  for (let i = 0; i < times; i++) await countDoor(env, door as never);
};
const POWERSHELL = spawnSync("powershell", ["-NoProfile", "-Command", "1"], { encoding: "utf8" }).status === 0;

test("THE RIDE against the real handlers passes, sends exactly 2 / 3 / 4 / 2 counted requests, the real D1 counters rise by exactly those (the uncounted refusals add nothing), and a second ride over the same day's baseline passes too", async (t) => {
  if (!POWERSHELL) return t.skip("no PowerShell available");
  // Mutations that redden this: make Test-A2aUncounted send a counted body (the totals exceed 11); send the notification with an id (a2a_send 2, the notification check reds); drop `$sent["a2a_send"]` increments (SENT reads 0).
  const r = await ride3({}, { times: 2 });
  assert.deepEqual(r.whys, ["", ""], r.out);
  assert.deepEqual(r.sents, ["ATT 2 3 4 2 PROV 2 3 4 2 ROUNDS 1", "ATT 2 3 4 2 PROV 2 3 4 2 ROUNDS 1"], "each ride sent 2 card GETs, 3 accepted /a2a sends, 4 A2A send calls to the MCP doors (message/send and SendMessage, each to both) and 2 unknown methods");
  assert.equal(r.counts.agent_card, 4, "agent_card: 2 per ride, nothing else");
  assert.equal(r.counts.a2a_send, 6, "a2a_send: 3 per ride; SendMessage without a header, 9.9, undefined, malformed and contextId added nothing");
  assert.equal(r.counts.mcp_a2a_probe, 8, "mcp_a2a_probe: 4 per ride");
  assert.equal(r.counts.mcp_unknown_method, 4, "and the JSON null bodies added nothing");
  assert.match(r.out, /\[ride\] round 1: baseline read for UTC day \d{4}-\d{2}-\d{2}; sending the counted requests, each retried until its answer passes/);
});

test("the ride passes through a stale edge: the first answers for /a2a, the card paths and the MCP send are 404 (never reached the worker, so never counted), the uncounted checks are retried and each counted request is retried until its answer passes, with the real counters still exactly 2 / 3 / 4 / 2", async (t) => {
  if (!POWERSHELL) return t.skip("no PowerShell available");
  // Mutations that redden this: Invoke-Counted tries once (`$n -le 1`: the first 404 stops the ride); the uncounted checks not retried (Confirm-Reads tries 1).
  const gone = new Set<string>();
  const first = (k: string): boolean => (gone.has(k) ? false : (gone.add(k), true));
  const stale: Fixture = {
    intercept: (s, n) => {
      const hit = (s.path === "/a2a" && n <= 2) || (s.path.startsWith("/.well-known/") && n === 1) || (isA2aPost(s) && s.headers["a2a-version"] === "1.0" && first("a2a-v1")) || (s.method === "POST" && s.path === "/mcp" && parseBody(s)?.method === "message/send" && first("mcp"));
      return hit ? { status: 404, headers: { "content-type": "application/json" }, body: '{"error":"Not found."}' } : undefined;
    },
  };
  const r = await ride3(stale, { tries: 8 });
  assert.deepEqual(r.whys, [""], r.out);
  const att = /^ATT (\d+) (\d+) (\d+) (\d+) PROV 2 3 4 2 ROUNDS 1$/.exec(r.sents[0]);
  assert.ok(att, r.sents[0]);
  assert.ok(att.slice(1).reduce((a, b) => a + Number(b), 0) > 9, "the stale answers were extra attempts");
  assert.deepEqual([r.counts.agent_card, r.counts.a2a_send, r.counts.mcp_a2a_probe, r.counts.mcp_unknown_method], [2, 3, 4, 2]);
});

// ---------- failing fixtures: one per judged item ----------

const isA2aPost = (s: Seen): boolean => s.method === "POST" && s.path === "/a2a";
const OLD_SENDMESSAGE = jsonAns({ jsonrpc: "2.0", id: 9, error: { code: -32601, message: "method 'SendMessage' not found" } });
const a2aV1 = (s: Seen): boolean => isA2aPost(s) && s.headers["a2a-version"] === "1.0" && parseBody(s)?.method === "SendMessage";
const a2aV03 = (s: Seen): boolean => isA2aPost(s) && !s.headers["a2a-version"] && parseBody(s)?.id === "ride-2";
const cardV1 = (s: Seen): boolean => s.path === "/.well-known/agent-card.json";
const failing: Array<{ name: string; fx: Fixture; why: RegExp; mutation: string }> = [
  {
    name: "a card missing a field (v1.0 defaultOutputModes)",
    fx: { after: (s, res) => (s.path === "/.well-known/agent-card.json" ? mutateJson(res, (j) => delete j.defaultOutputModes) : undefined) },
    why: /v1\.0 agent card: defaultOutputModes is missing or empty/,
    mutation: 'delete "defaultOutputModes", "skills" from the foreach in Test-CardServed',
  },
  {
    name: "a card with no supportedInterfaces (v1.0)",
    fx: { after: (s, res) => (s.path === "/.well-known/agent-card.json" ? mutateJson(res, (j) => delete j.supportedInterfaces) : undefined) },
    why: /supportedInterfaces\[0\] is missing/,
    mutation: "remove the $null -eq $iface check",
  },
  {
    name: "a v1.0 card with the wrong endpoint url",
    fx: { after: (s, res) => (s.path === "/.well-known/agent-card.json" ? mutateJson(res, (j) => (j.supportedInterfaces[0].url = "https://elsewhere.example/a2a")) : undefined) },
    why: /supportedInterfaces\[0\]\.url is 'https:\/\/elsewhere\.example\/a2a'/,
    mutation: "drop the $iface.url -cne $endpoint check",
  },
  {
    name: "a v0.3 card with the wrong url",
    fx: { after: (s, res) => (s.path === "/.well-known/agent.json" ? mutateJson(res, (j) => (j.url = "https://elsewhere.example/a2a")) : undefined) },
    why: /v0\.3 agent card: url is 'https:\/\/elsewhere\.example\/a2a'/,
    mutation: "drop the $j.url -cne $endpoint check",
  },
  {
    name: "a card whose name is not the society name /api/official serves",
    fx: { after: (s, res) => (s.path === "/.well-known/agent-card.json" ? mutateJson(res, (j) => (j.name = "Not The Society")) : undefined) },
    why: /name is 'Not The Society', expected the society name GET \/api\/official serves now/,
    mutation: "drop the $j.name -cne $name check",
  },
  {
    name: "SendMessage WITHOUT the A2A-Version header answered with a result (gate C2 not met: it must be -32601 naming message/send)",
    fx: { after: (s, res) => (isA2aPost(s) && parseBody(s)?.method === "SendMessage" && !s.headers["a2a-version"] ? jsonAns({ jsonrpc: "2.0", id: "ride-1", result: { kind: "message", messageId: "m", role: "agent", parts: [{ kind: "text", text: "guest_enter" }] } }) : undefined) },
    why: /SendMessage with NO A2A-Version header \(read as 0\.3\): the answer carried no JSON-RPC error/,
    mutation: "delete the no-header SendMessage Test-RpcError call in Test-A2aUncounted",
  },
  {
    name: "a notification (no id) answered with a body (a 200 here: node drops the body of a 204, so the 'a 204 with a body' branch is not provable on this transport)",
    fx: { after: (s, res) => (isA2aPost(s) && parseBody(s)?.method === "message/send" && !("id" in parseBody(s)) ? jsonAns({ jsonrpc: "2.0", id: null, result: {} }) : undefined) },
    why: /message\/send notification \(no id\) answered HTTP 200, expected 204/,
    mutation: "delete Test-Notification's HTTP 204 check",
  },
  {
    name: "a message carrying a contextId accepted",
    fx: { after: (s, res) => (isA2aPost(s) && parseBody(s)?.params?.message?.contextId === "x" ? jsonAns({ jsonrpc: "2.0", id: "ride-5", result: { kind: "message", messageId: "m", role: "agent", parts: [{ kind: "text", text: "guest_enter" }] } }) : undefined) },
    why: /POST \/a2a with a contextId: the answer carried no JSON-RPC error/,
    mutation: "delete the contextId Test-RpcError call in Test-A2aUncounted",
  },
  {
    name: "/mcp answers message/send with the OLD text",
    fx: { after: (s) => (s.method === "POST" && s.path === "/mcp" && parseBody(s)?.method === "message/send" ? jsonAns({ jsonrpc: "2.0", id: 7, error: { code: -32601, message: "method 'message/send' not found" } }) : undefined) },
    why: /POST \/mcp message\/send: the error message 'method 'message\/send' not found' does not contain/,
    mutation: "drop the Test-RpcError needle ($BASE + $A2A_PATH) in Send-McpCounted",
  },
  {
    name: "/mcp/read answers message/send with the old text",
    fx: { after: (s) => (s.method === "POST" && s.path === "/mcp/read" && parseBody(s)?.method === "message/send" ? jsonAns({ jsonrpc: "2.0", id: 7, error: { code: -32601, message: "method 'message/send' not found" } }) : undefined) },
    why: /POST \/mcp\/read message\/send: the error message .* does not contain/,
    mutation: "iterate only /mcp in $MCP_DOOR_PATHS",
  },
  {
    name: "an ordinary unknown method answered with a changed text",
    fx: { after: (s) => (s.method === "POST" && s.path === "/mcp" && parseBody(s)?.method === "ride/unknown" ? jsonAns({ jsonrpc: "2.0", id: 8, error: { code: -32601, message: "method 'ride/unknown' not found. Try A2A." } }) : undefined) },
    why: /expected exactly today's text/,
    mutation: "delete the $unknownText -cne $MCP_UNKNOWN_TEXT check",
  },
  {
    name: "a JSON null body answered 500",
    fx: { after: (s) => (s.method === "POST" && s.path === "/mcp" && s.body === "null" ? jsonAns({ error: "boom" }, 500) : undefined) },
    why: /POST \/mcp with a JSON null body answered HTTP 500, expected 400/,
    mutation: 'delete the Test-McpUncounted loop body',
  },
  {
    name: "/openapi.json lists POST /a2a",
    fx: { after: (s, res) => (s.path === "/openapi.json" ? mutateJson(res, (j) => (j.paths["/a2a"] = { post: { responses: {} } })) : undefined) },
    why: /GET \/openapi\.json lists \/a2a/,
    mutation: "delete the `$paths -ccontains $A2A_PATH` check",
  },
  {
    name: "/openapi.json drops a card",
    fx: { after: (s, res) => (s.path === "/openapi.json" ? mutateJson(res, (j) => delete j.paths["/.well-known/agent.json"]) : undefined) },
    why: /GET \/openapi\.json does not list \/\.well-known\/agent\.json/,
    mutation: "delete the card loop over $paths in Test-DiscoveryServed",
  },
  {
    name: "/llms.txt does not list POST /a2a",
    fx: { after: (s, res) => (s.path === "/llms.txt" ? { ...res, body: res.body.split("POST http://127.0.0.1").join("POST http://elsewhere") } : undefined) },
    why: /GET \/llms\.txt does not list POST \/a2a/,
    mutation: 'delete the llms.txt "POST " check',
  },
  {
    name: "/api/surface drops POST /a2a",
    fx: { after: (s, res) => (s.path === "/api/surface" ? mutateJson(res, (j) => (j.routes = j.routes.filter((r: { path: string }) => r.path !== "/a2a"))) : undefined) },
    why: /GET \/api\/surface does not list POST \/a2a/,
    mutation: 'delete ("POST " + $A2A_PATH) from the surface foreach',
  },
  {
    name: "/skill.md changed after the baseline read",
    fx: { after: (s, res, n) => (s.path === "/skill.md" && n >= 2 ? { ...res, body: res.body + "\nchanged" } : undefined) },
    why: /\/skill\.md differs from what it was before the deploy/,
    mutation: "delete the Skill comparison in Test-DocsUnchanged",
  },
  {
    name: "/heartbeat.md changed after the baseline read",
    fx: { after: (s, res, n) => (s.path === "/heartbeat.md" && n >= 2 ? { ...res, body: res.body + "\nchanged" } : undefined) },
    why: /\/heartbeat\.md differs from what it was before the deploy/,
    mutation: "delete the Heartbeat comparison in Test-DocsUnchanged",
  },
  {
    name: "a door that did not rise (the doors read is frozen at its first answer, with rows already there)",
    fx: (() => {
      let frozen: Ans | null = null;
      return {
        seed: async (env: Env) => {
          for (const d of PROBE_DOORS) await seedDoor(d, 5)(env);
        },
        after: (s: Seen, res: Ans) => {
          if (s.path !== "/api/doors") return undefined;
          frozen = frozen ?? res;
          return frozen;
        },
      };
    })(),
    why: /the door agent_card reads 5, expected at least 7 \(baseline 5 \+ 2 proved\) or at_cap true/,
    mutation: "change `$row.N -lt $want` to `$row.N -lt 0` in Test-DoorRise",
  },
  {
    name: "a door row ABSENT after the sends (something was sent to it)",
    fx: { after: (s, res) => (s.path === "/api/doors" ? mutateJson(res, (j) => (j.rows = j.rows.filter((r: { door: string }) => r.door !== "mcp_a2a_probe"))) : undefined) },
    why: /the door mcp_a2a_probe has no row for the day, although the ride proved 4 request\(s\) to it/,
    mutation: "delete the `-not $row.Present` check in Test-DoorRise",
  },
  {
    name: "/mcp answers SendMessage with the OLD text (message/send is right)",
    fx: { after: (s) => (s.method === "POST" && s.path === "/mcp" && parseBody(s)?.method === "SendMessage" ? OLD_SENDMESSAGE : undefined) },
    why: /POST \/mcp SendMessage: the error message 'method 'SendMessage' not found' does not contain/,
    mutation: "drop the SendMessage entry from the Send-McpCounted method list",
  },
  {
    name: "/mcp/read answers SendMessage with the old text",
    fx: { after: (s) => (s.method === "POST" && s.path === "/mcp/read" && parseBody(s)?.method === "SendMessage" ? OLD_SENDMESSAGE : undefined) },
    why: /POST \/mcp\/read SendMessage: the error message .* does not contain/,
    mutation: "drop the SendMessage entry from the Send-McpCounted method list",
  },
  {
    name: "an accepted v1.0 send echoing the WRONG id",
    fx: { after: (s, res) => (a2aV1(s) ? mutateJson(res, (j) => (j.id = "wrong")) : undefined) },
    why: /SendMessage with A2A-Version: 1\.0: the answer's id is 'wrong', expected 'ride-1' echoed/,
    mutation: "delete the $j.id -cne $wantId check in Test-A2aSuccess",
  },
  {
    name: "an accepted v1.0 send with the wrong role",
    fx: { after: (s, res) => (a2aV1(s) ? mutateJson(res, (j) => (j.result.message.role = "ROLE_USER")) : undefined) },
    why: /the v1\.0 result is not a message with role ROLE_AGENT/,
    mutation: "delete the ROLE_AGENT check in Test-A2aSuccess",
  },
  {
    name: "an accepted v1.0 send with empty parts",
    fx: { after: (s, res) => (a2aV1(s) ? mutateJson(res, (j) => (j.result.message.parts = [])) : undefined) },
    why: /the message has no part/,
    mutation: "delete the parts count check in Test-A2aSuccess",
  },
  {
    name: "an accepted v1.0 send whose text has no guest_enter",
    fx: { after: (s, res) => (a2aV1(s) ? mutateJson(res, (j) => (j.result.message.parts = [{ text: "hello" }])) : undefined) },
    why: /the message text does not name guest_enter/,
    mutation: 'delete the Contains("guest_enter") check in Test-A2aSuccess',
  },
  {
    name: "an accepted v1.0 send with no jsonrpc member",
    fx: { after: (s, res) => (a2aV1(s) ? mutateJson(res, (j) => delete j.jsonrpc) : undefined) },
    why: /SendMessage with A2A-Version: 1\.0: the answer's jsonrpc is '', expected 2\.0/,
    mutation: 'delete the jsonrpc check in Test-A2aSuccess',
  },
  {
    name: "an accepted v1.0 send with no messageId",
    fx: { after: (s, res) => (a2aV1(s) ? mutateJson(res, (j) => delete j.result.message.messageId) : undefined) },
    why: /the message has no messageId/,
    mutation: "delete the messageId check in Test-A2aSuccess",
  },
  {
    name: "an accepted v0.3 send whose part kind is not text",
    fx: { after: (s, res) => (a2aV03(s) ? mutateJson(res, (j) => (j.result.parts[0].kind = "file")) : undefined) },
    why: /the v0\.3 part's kind is 'file', expected text/,
    mutation: "delete the v0.3 parts[0].kind check in Test-A2aSuccess",
  },
  {
    name: "GET /a2a answered 200, not 405",
    fx: { after: (s, res) => (s.method === "GET" && s.path === "/a2a" ? { ...res, status: 200 } : undefined) },
    why: /GET \/a2a answered 200, expected 405/,
    mutation: 'change the "405" in Test-A2aUncounted to "200"',
  },
  {
    name: "A2A-Version 9.9 answered with -32601, not -32009",
    fx: { after: (s, res) => (isA2aPost(s) && s.headers["a2a-version"] === "9.9" ? mutateJson(res, (j) => (j.error.code = -32601)) : undefined) },
    why: /with A2A-Version 9\.9: the error code is -32601, expected -32009/,
    mutation: "delete the 9.9 Test-RpcError call in Test-A2aUncounted",
  },
  {
    name: "an /a2a refusal whose error.data carries no directions",
    fx: { after: (s, res) => (isA2aPost(s) && parseBody(s)?.method === "ride/undefined" ? mutateJson(res, (j) => delete j.error.data) : undefined) },
    why: /with an undefined method: error\.data does not carry the directions/,
    mutation: "delete the $needData block in Test-RpcError",
  },
  {
    name: "an /a2a refusal echoing the wrong id",
    fx: { after: (s, res) => (isA2aPost(s) && parseBody(s)?.params?.message?.contextId === "x" ? mutateJson(res, (j) => (j.id = "zzz")) : undefined) },
    why: /with a contextId: the answer's id is 'zzz', expected 'ride-5' echoed/,
    mutation: "delete the id comparison in Test-RpcError",
  },
  {
    name: "an /a2a refusal with no jsonrpc member (the malformed body)",
    fx: { after: (s, res) => (isA2aPost(s) && s.body === '{"jsonrpc":"2.0",' ? mutateJson(res, (j) => delete j.jsonrpc) : undefined) },
    why: /with a malformed body: the answer's jsonrpc is '', expected 2\.0/,
    mutation: "delete the jsonrpc check in Test-RpcError",
  },
  {
    name: "the malformed-body refusal carrying a non-null id",
    fx: { after: (s, res) => (isA2aPost(s) && s.body === '{"jsonrpc":"2.0",' ? mutateJson(res, (j) => (j.id = "x")) : undefined) },
    why: /with a malformed body: the answer's id is 'x', expected null/,
    mutation: 'delete the `"null"` branch in Test-RpcError',
  },
  {
    name: "a card whose version is not 1.0.0",
    fx: { after: (s, res) => (cardV1(s) ? mutateJson(res, (j) => (j.version = "2.0.0")) : undefined) },
    why: /v1\.0 agent card: version is '2\.0\.0', expected 1\.0\.0/,
    mutation: 'delete the "1.0.0" version check in Test-CardServed',
  },
  {
    name: "a card whose provider.organization is not the society name",
    fx: { after: (s, res) => (cardV1(s) ? mutateJson(res, (j) => (j.provider.organization = "Other Body")) : undefined) },
    why: /provider\.organization is not the society name/,
    mutation: "delete the provider.organization check in Test-CardServed",
  },
  {
    name: "a card whose documentationUrl does not end /llms.txt",
    fx: { after: (s, res) => (cardV1(s) ? mutateJson(res, (j) => (j.documentationUrl = "https://docs.example/readme")) : undefined) },
    why: /documentationUrl is 'https:\/\/docs\.example\/readme', expected it to end \/llms\.txt/,
    mutation: "delete the documentationUrl check in Test-CardServed",
  },
  {
    name: "a card declaring streaming true",
    fx: { after: (s, res) => (cardV1(s) ? mutateJson(res, (j) => (j.capabilities.streaming = true)) : undefined) },
    why: /capabilities\.streaming is 'True', expected the boolean false/,
    mutation: "delete the capabilities flag loop in Test-CardServed",
  },
  {
    name: "a card whose pushNotifications is the STRING false",
    fx: { after: (s, res) => (cardV1(s) ? mutateJson(res, (j) => (j.capabilities.pushNotifications = "false")) : undefined) },
    why: /capabilities\.pushNotifications is 'false', expected the boolean false/,
    mutation: "replace the `-isnot [bool]` test in the capabilities loop with `$false`",
  },
  {
    name: "/openapi.json lists a card path without a get operation",
    fx: { after: (s, res) => (s.path === "/openapi.json" ? mutateJson(res, (j) => (j.paths["/.well-known/agent.json"] = {})) : undefined) },
    why: /lists \/\.well-known\/agent\.json without a get operation/,
    mutation: "delete the get-operation check in Test-DiscoveryServed",
  },
  {
    name: "GET /api/doors with a null rows member",
    fx: { after: (s, res) => (s.path === "/api/doors" ? mutateJson(res, (j) => (j.rows = null)) : undefined) },
    why: /GET \/api\/doors carried a null rows member/,
    mutation: "delete the null rows check in Get-DoorsRead",
  },
  {
    name: "a door row whose n is not a number (a read failure with a reason, never an uncaught stop)",
    fx: { seed: seedDoor("agent_card", 1), after: (s, res) => (s.path === "/api/doors" ? mutateJson(res, (j) => (j.rows.find((r: { door: string }) => r.door === "agent_card").n = "many")) : undefined) },
    why: /the row for agent_card has a non-numeric n \('many'\)/,
    mutation: "delete the non-numeric n branch in ConvertTo-DoorCounts (the [int] cast then stops the script)",
  },
  {
    name: "a door row whose at_cap is the string true",
    fx: { seed: seedDoor("agent_card", 1), after: (s, res) => (s.path === "/api/doors" ? mutateJson(res, (j) => (j.rows.find((r: { door: string }) => r.door === "agent_card").at_cap = "true")) : undefined) },
    why: /the row for agent_card has an at_cap that is not a boolean \('true'\)/,
    mutation: "delete the at_cap -isnot [bool] branch in ConvertTo-DoorCounts",
  },
];

test("the failing fixtures: each judged item reddens the ride with its own reason (the real worker's answers, one altered)", async (t) => {
  if (!POWERSHELL) return t.skip("no PowerShell available");
  const results: Array<Awaited<ReturnType<typeof ride3>>> = [];
  for (let i = 0; i < failing.length; i += 10) results.push(...(await Promise.all(failing.slice(i, i + 10).map((f) => ride3(f.fx)))));
  failing.forEach((f, i) => {
    const r = results[i];
    assert.equal(r.whys.length, 1, `${f.name}: the ride answered ${r.out.slice(0, 400)}`);
    assert.match(r.whys[0], f.why, `${f.name} (mutation that turns this green: ${f.mutation}): ${r.whys[0]}`);
  });
});

test("a door AT CAP passes without rising (at_cap true), and the other three doors still rise by what was sent", async (t) => {
  if (!POWERSHELL) return t.skip("no PowerShell available");
  // Mutation that reds this: delete `-and -not $row.AtCap` in Test-DoorRise (the capped door is then 'did not rise').
  const r = await ride3({ seed: seedDoor("a2a_send", PROBE_DOOR_DAILY_CAP) });
  assert.deepEqual(r.whys, [""], r.out);
  assert.equal(r.counts.a2a_send, PROBE_DOOR_DAILY_CAP, "the capped door stayed at its cap");
  assert.deepEqual([r.counts.agent_card, r.counts.mcp_a2a_probe, r.counts.mcp_unknown_method], [2, 4, 2]);
});

test("the UTC day changes between the baseline and the end of the sends: the ride says so, takes a new baseline, sends the fixed batch once more (twice in total) and judges only the second day; a second change is a stop", async (t) => {
  if (!POWERSHELL) return t.skip("no PowerShell available");
  // Mutations that red this: drop the `continue` re-baseline branch (the ride judges across two days: Rounds 1 and a failure or a false pass); compare days with -ne instead of -cne is harmless (same strings).
  const rfc = (ms: number): string => new Date(ms).toUTCString();
  const yesterday = rfc(Date.now() - 86_400_000);
  const today = rfc(Date.now());
  const tomorrow = rfc(Date.now() + 86_400_000);
  const dated = (days: string[]): Fixture => {
    let reads = 0;
    return {
      after: (s, res) => {
        if (s.path !== "/api/doors") return undefined;
        reads++;
        return { ...res, headers: { ...res.headers, date: days[Math.min(reads, days.length) - 1] } };
      },
    };
  };
  const changed = await ride3(dated([yesterday, today, today, today]));
  assert.deepEqual(changed.whys, [""], changed.out);
  assert.deepEqual(changed.sents, ["ATT 4 6 8 4 PROV 4 6 8 4 ROUNDS 2"], "the batch ran twice and the total says so");
  assert.match(changed.out, /the UTC day changed between the baseline \(\d{4}-\d{2}-\d{2}\) and the end of the sends \(\d{4}-\d{2}-\d{2}\): the counts are split across two days and are not judged\. Taking a NEW baseline/);
  assert.deepEqual([changed.counts.agent_card, changed.counts.a2a_send], [4, 6], "the real counters took both rounds");
  const twice = await ride3(dated([yesterday, today, today, tomorrow]));
  assert.equal(twice.whys.length, 1, twice.out);
  assert.match(twice.whys[0], /the UTC day changed again during the second round/);
});

test("the door judge and the day parser, run for real on canned rows: an absent row is never a pass for a door something was sent to, at_cap is, an unsent door is ignored, rows of another day are not read, a Date header is the server's UTC day", (t) => {
  if (!POWERSHELL) return t.skip("no PowerShell available");
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    doorsFns.slice(0, doorsFns.indexOf("# THE WAVE RIDE.")),
    "function Row($day, $door, $n, $cap) { return [pscustomobject]@{ day = $day; door = $door; n = $n; at_cap = $cap } }",
    "function Sent($a, $b, $c, $d) { return @{ agent_card = $a; a2a_send = $b; mcp_a2a_probe = $c; mcp_unknown_method = $d } }",
    '$base = ConvertTo-DoorCounts @((Row "2026-11-24" "agent_card" 5 $false), (Row "2026-11-23" "a2a_send" 99 $false)) "2026-11-24"',
    'Write-Host ("OTHERDAY " + $base["a2a_send"].Present + " " + $base["a2a_send"].N + " AGENT " + $base["agent_card"].N)',
    '$ok = ConvertTo-DoorCounts @((Row "2026-11-24" "agent_card" 7 $false), (Row "2026-11-24" "a2a_send" 3 $false), (Row "2026-11-24" "mcp_a2a_probe" 2 $false), (Row "2026-11-24" "mcp_unknown_method" 2 $false)) "2026-11-24"',
    'Write-Host ("RISE [" + (Test-DoorRise $base $ok (Sent 2 3 2 2)) + "]")',
    '$short = ConvertTo-DoorCounts @((Row "2026-11-24" "agent_card" 6 $false), (Row "2026-11-24" "a2a_send" 3 $false), (Row "2026-11-24" "mcp_a2a_probe" 2 $false), (Row "2026-11-24" "mcp_unknown_method" 2 $false)) "2026-11-24"',
    'Write-Host ("SHORT [" + (Test-DoorRise $base $short (Sent 2 3 2 2)) + "]")',
    '$capped = ConvertTo-DoorCounts @((Row "2026-11-24" "agent_card" 200 $true), (Row "2026-11-24" "a2a_send" 3 $false), (Row "2026-11-24" "mcp_a2a_probe" 2 $false), (Row "2026-11-24" "mcp_unknown_method" 2 $false)) "2026-11-24"',
    'Write-Host ("CAP [" + (Test-DoorRise $base $capped (Sent 2 3 2 2)) + "]")',
    '$none = ConvertTo-DoorCounts @() "2026-11-24"',
    'Write-Host ("ABSENT [" + (Test-DoorRise $none $none (Sent 0 1 0 0)) + "]")',
    'Write-Host ("UNSENT [" + (Test-DoorRise $none $none (Sent 0 0 0 0)) + "]")',
    'Write-Host ("DAY [" + (Get-HeaderDay "HTTP/2 200`r`nContent-Type: x`r`nDate: Tue, 24 Nov 2026 23:59:59 GMT`r`n") + "] [" + (Get-HeaderDay "Date: Wed, 25 Nov 2026 00:00:00 GMT") + "] [" + (Get-HeaderDay "no date here") + "] [" + (Get-HeaderDay "Date: garbage") + "]")',
  ];
  const r = runPs(lines)!;
  assert.match(r.out, /OTHERDAY False 0 AGENT 5/, r.out);
  assert.match(r.out, /RISE \[\]/);
  assert.match(r.out, /SHORT \[the door agent_card reads 6, expected at least 7 \(baseline 5 \+ 2 proved\) or at_cap true\]/);
  assert.match(r.out, /CAP \[\]/, "at_cap true passes");
  assert.match(r.out, /ABSENT \[the door a2a_send has no row for the day, although the ride proved 1 request\(s\) to it\]/);
  assert.match(r.out, /UNSENT \[\]/);
  assert.match(r.out, /DAY \[2026-11-24\] \[2026-11-25\] \[\] \[\]/, r.out);
});

test("before the deploy: Test-WaveAbsent passes only when both card paths and GET /a2a answer 404, and says which does not (run against the real worker, which has the wave)", async (t) => {
  if (!POWERSHELL) return t.skip("no PowerShell available");
  // Mutation that reds this: change the -cne "404" to -cne "200" in Test-WaveAbsent.
  const tail = ['Write-Host ("ABSENT [" + (Test-WaveAbsent) + "]")'];
  const live = await withWave({}, async (port) => runPsAsync(rideHarness(port, 4, tail)));
  assert.match(live!.out, /ABSENT \[GET \/\.well-known\/agent-card\.json answered 200, expected 404\]/, live!.out);
  const notYet: Fixture = { intercept: (s) => (s.path === "/.well-known/agent-card.json" || s.path === "/.well-known/agent.json" || s.path === "/a2a" ? { status: 404, headers: {}, body: "{}" } : undefined) };
  const absent = await withWave(notYet, async (port) => runPsAsync(rideHarness(port, 4, tail)));
  assert.match(absent!.out, /ABSENT \[\]/, absent!.out);
  const half: Fixture = { intercept: (s) => (s.path === "/.well-known/agent-card.json" || s.path === "/.well-known/agent.json" ? { status: 404, headers: {}, body: "{}" } : undefined) };
  const partial = await withWave(half, async (port) => runPsAsync(rideHarness(port, 4, tail)));
  assert.match(partial!.out, /ABSENT \[GET \/a2a answered 405, expected 404\]/, partial!.out);
});

test("the counted bodies are valid JSON-RPC and ASCII, each notification has no id member, and every counted request is sent from a temp file", () => {
  const body = (name: string): string => new RegExp(`^\\$${name} = '(.*)'$`, "m").exec(script)![1];
  for (const n of ["SEND_V1_BODY", "SEND_V03_BODY", "NOTIFY_V03_BODY", "UNDEFINED_BODY", "CONTEXT_BODY", "MCP_A2A_BODY", "MCP_UNKNOWN_BODY"]) {
    const j = JSON.parse(body(n));
    assert.equal(j.jsonrpc, "2.0", n);
    assert.equal(/[^\x00-\x7f]/.test(body(n)), false, n);
  }
  assert.equal("id" in JSON.parse(body("NOTIFY_V03_BODY")), false, "the notification has no id member");
  assert.throws(() => JSON.parse(body("MALFORMED_BODY")), "the malformed body is malformed");
  assert.equal(body("NULL_BODY"), "null");
  assert.equal(JSON.parse(body("CONTEXT_BODY")).params.message.contextId, "x");
  assert.equal(/-d\s|--data\s|--data-raw|--json/.test(code), false, "no inline body argument anywhere");
});

// ---------- the counted requests are retried until their answers pass (hub review of f7c9eac2) ----------

// The seven counted request kinds, told apart exactly as the script sends them (the uncounted /a2a bodies differ by header or body).
const countedKind = (s: Seen): string | null => {
  const b = parseBody(s);
  if (s.method === "GET" && s.path === "/.well-known/agent-card.json") return "card1";
  if (s.method === "GET" && s.path === "/.well-known/agent.json") return "card03";
  if (isA2aPost(s) && s.headers["a2a-version"] === "1.0" && b?.method === "SendMessage") return "a2a-v1";
  if (isA2aPost(s) && !s.headers["a2a-version"] && b?.method === "message/send" && b?.id === "ride-2") return "a2a-v03";
  if (isA2aPost(s) && !s.headers["a2a-version"] && b?.method === "message/send" && !("id" in b) && !b?.params?.message?.contextId) return "a2a-notify";
  if (s.method === "POST" && (s.path === "/mcp" || s.path === "/mcp/read") && b?.method === "message/send") return "mcp-send" + s.path;
  if (s.method === "POST" && (s.path === "/mcp" || s.path === "/mcp/read") && b?.method === "SendMessage") return "mcp-sendmsg" + s.path;
  if (s.method === "POST" && (s.path === "/mcp" || s.path === "/mcp/read") && b?.method === "ride/unknown") return "mcp-unknown" + s.path;
  return null;
};
const BAD_503: Ans = { status: 503, headers: { "content-type": "text/plain" }, body: "unavailable" };
const BAD_CLOSE: Ans = { status: 0, headers: {}, body: "" };
const OLD_MCP_TEXT: Ans = jsonAns({ jsonrpc: "2.0", id: 7, error: { code: -32601, message: "method 'message/send' not found" } });

test("each counted request answered wrongly once or twice (a closed connection, a 503, the old -32601 text) and then rightly: the ride passes, ATTEMPTS exceed PROVED, and the real counters hold exactly the proved requests", async (t) => {
  if (!POWERSHELL) return t.skip("no PowerShell available");
  // Mutations that redden this: Invoke-Counted tries once (`$n -le 1`); the proved increment dropped (PROV reads 0); the attempts increment dropped (ATT equals PROV).
  const plan: Record<string, Ans[]> = {
    card1: [BAD_CLOSE, BAD_503],
    card03: [BAD_503, BAD_CLOSE],
    "a2a-v1": [BAD_503],
    "a2a-v03": [BAD_CLOSE],
    "a2a-notify": [BAD_503, BAD_CLOSE],
    "mcp-send/mcp": [OLD_MCP_TEXT],
    "mcp-send/mcp/read": [OLD_MCP_TEXT],
    "mcp-sendmsg/mcp": [BAD_503],
    "mcp-sendmsg/mcp/read": [BAD_CLOSE],
    "mcp-unknown/mcp": [BAD_503],
    "mcp-unknown/mcp/read": [BAD_CLOSE],
  };
  const used = new Map<string, number>();
  const r = await ride3({
    intercept: (s) => {
      const k = countedKind(s);
      if (!k || !plan[k]) return undefined;
      const i = used.get(k) ?? 0;
      used.set(k, i + 1);
      return plan[k][i];
    },
  });
  assert.deepEqual(r.whys, [""], r.out);
  // cards 2 + 2 + 1 + 1 extra = 6 attempts for 2 proved; a2a 1 + 1 + 2 + 3 proved ... = (2 + 2 + 3) = 7 for 3; mcp-send and mcp-sendmsg (2 + 2 + 2 + 2) = 8 for 4; mcp-unknown (2 + 2) = 4 for 2.
  assert.deepEqual(r.sents, ["ATT 6 7 8 4 PROV 2 3 4 2 ROUNDS 1"], r.out);
  assert.deepEqual([r.counts.agent_card, r.counts.a2a_send, r.counts.mcp_a2a_probe, r.counts.mcp_unknown_method], [2, 3, 4, 2], "the wrong answers never reached the worker, so only the proved requests are in the counters");
});

test("a counted request answered wrongly EVERY time fails the ride with that reason after exactly $RIDE_TRIES attempts (the server saw exactly that many), and the later requests are not sent", async (t) => {
  if (!POWERSHELL) return t.skip("no PowerShell available");
  // Mutations that redden this: the loop bound `-le ($RIDE_TRIES + 1)` (five attempts); `-le 1` (one attempt); no failure return (the ride goes on).
  let seen = 0;
  const r = await ride3({
    intercept: (s) => {
      if (countedKind(s) !== "a2a-v1") return undefined;
      seen++;
      return BAD_503;
    },
  });
  assert.equal(r.whys.length, 1, r.out);
  assert.match(r.whys[0], /POST \/a2a SendMessage with A2A-Version: 1\.0 answered HTTP 503, expected 200/);
  assert.equal(seen, 4, "the harness sets $RIDE_TRIES to 4: exactly four attempts reached the server");
  assert.deepEqual(r.sents, ["ATT 2 4 0 0 PROV 2 0 0 0 ROUNDS 1"], "the cards were proved, the failing request was attempted four times, nothing after it was sent");
});

test("a stale unknown-method answer (the right text from an old worker: proved, but not counted the first time) is sent once more to each MCP door and then passes, with what is wanted unraised", async (t) => {
  if (!POWERSHELL) return t.skip("no PowerShell available");
  // Mutations that redden this: the resend branch off (`if ($false)` on the single-door condition) leaves mcp_unknown_method short; Resend-McpUnknown sending nothing.
  const used = new Map<string, number>();
  const OLD_UNKNOWN = jsonAns({ jsonrpc: "2.0", id: 8, error: { code: -32601, message: "method 'ride/unknown' not found" } });
  const r = await ride3({
    intercept: (s) => {
      const k = countedKind(s);
      if (!k || !k.startsWith("mcp-unknown")) return undefined;
      const i = used.get(k) ?? 0;
      used.set(k, i + 1);
      return i === 0 ? OLD_UNKNOWN : undefined;
    },
  });
  assert.deepEqual(r.whys, [""], r.out);
  assert.deepEqual(r.sents, ["ATT 2 3 4 4 PROV 2 3 4 2 ROUNDS 1"], "two unknown-method attempts proved, two more resent: ATTEMPTS 4, what is wanted stays 2");
  assert.equal(r.counts.mcp_unknown_method, 2, "only the resends were counted by the real worker");
  assert.match(r.out, /only mcp_unknown_method is short/);
});

test("a door that never rises, even after the resend, fails: the unknown-method answers are stale every time, so mcp_unknown_method stays short and the ride says so (and a different door short alone gets no resend)", async (t) => {
  if (!POWERSHELL) return t.skip("no PowerShell available");
  // Mutations that redden this: after the resend, the second door check replaced by `$why = ""` (the ride passes); the single-door condition loosened to `$true` (the absent-row fixture below is then resent: ATT 2 3 2 4).
  const OLD_UNKNOWN = jsonAns({ jsonrpc: "2.0", id: 8, error: { code: -32601, message: "method 'ride/unknown' not found" } });
  const never = await ride3({ intercept: (s) => (countedKind(s)?.startsWith("mcp-unknown") ? OLD_UNKNOWN : undefined) });
  assert.equal(never.whys.length, 1, never.out);
  assert.match(never.whys[0], /the door mcp_unknown_method (has no row for the day, although the ride proved 2|reads 0, expected at least 2)/);
  assert.deepEqual(never.sents, ["ATT 2 3 4 4 PROV 2 3 4 2 ROUNDS 1"], never.out);
  assert.match(never.out, /only mcp_unknown_method is short/);
  const other = await ride3({ after: (s, res) => (s.path === "/api/doors" ? mutateJson(res, (j) => (j.rows = j.rows.filter((r2: { door: string }) => r2.door !== "mcp_a2a_probe"))) : undefined) });
  assert.equal(other.whys.length, 1, other.out);
  assert.match(other.whys[0], /the door mcp_a2a_probe has no row/);
  assert.deepEqual(other.sents, ["ATT 2 3 4 2 PROV 2 3 4 2 ROUNDS 1"], "another door short alone is not resent");
  assert.equal(/only mcp_unknown_method is short/.test(other.out), false);
});

// ---------- step 0b: the UTC clock; the day check around the resend; robustness of the door reads ----------

test("step 0b STOPS in the last half hour of a UTC day, before any git, npm, wrangler or network command (the clock block is run for real, with the clock overridden): 22:45 and 23:29 pass, 23:30 and 23:59 stop, 00:00 passes", (t) => {
  // Mutations that redden this: `$utcNow.Minute -ge 30` -> `-ge 31` (23:30 passes); `$utcNow.Hour -eq 23` -> `-ge 22` (22:45 stops); the Stop-Here line removed (23:30 and 23:59 pass).
  const fns = script.slice(script.indexOf("# The UTC clock"), script.indexOf("# END-OF-DEFINITIONS"));
  const block = script.slice(script.indexOf("# BEGIN-CLOCK-CHECK"), script.indexOf("# END-CLOCK-CHECK"));
  assert.ok(fns.includes("function Get-UtcNow") && block.includes("Get-UtcNow"), "the clock is read through Get-UtcNow");
  const harness = (h: number, m: number): string[] => [
    "$ErrorActionPreference = 'Stop'",
    ...["git", "npm", "npx", "curl.exe"].map((n) => `function ${n} { throw "${n} must not run in the clock check" }`),
    'function Stop-Here($msg) { Write-Host "[STOP] $msg"; exit 1 }',
    fns,
    `function Get-UtcNow { return [System.DateTime]::new(2026, 11, 24, ${h}, ${m}, 0, [System.DateTimeKind]::Utc) }`,
    block,
    'Write-Host "[PASSED-CLOCK]"',
  ];
  const first = runPs(harness(23, 29));
  if (!first) return t.skip("no PowerShell available");
  assert.equal(first.code, 0, first.out);
  assert.match(first.out, /\[PASSED-CLOCK\]/);
  for (const [h, m] of [[22, 45], [0, 0], [12, 30]] as const) assert.match(runPs(harness(h, m))!.out, /\[PASSED-CLOCK\]/, `${h}:${m} passes`);
  for (const [h, m, text] of [[23, 30, "23:30"], [23, 59, "23:59"]] as const) {
    const r = runPs(harness(h, m))!;
    assert.equal(r.code, 1, `${h}:${m}: ${r.out}`);
    assert.match(r.out, new RegExp(`\\[STOP\\] the UTC time is ${text}, 23:30 or later: run it after midnight UTC; the ride compares one UTC day's counts`));
    assert.equal(/PASSED-CLOCK|must not run/.test(r.out), false);
  }
});

test("Get-Text and Get-Page treat a curl failure after a 200 header as a failed read (Code 000), never the status its headers carried", async (t) => {
  // Mutations that redden this: delete the `if ($exit -ne 0) { $code = "000" }` line in Get-Text, or the one in Get-Page.
  const server = createServer((req, res) => {
    if (req.url === "/cut") {
      res.writeHead(200, { "content-length": "1000", "content-type": "text/plain" });
      res.write("0123456789");
      setTimeout(() => res.destroy(), 30);
      return;
    }
    res.writeHead(200, { "content-type": "text/plain" });
    res.end("fine");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as { port: number }).port;
  try {
    const fns = slice("# The status code, content type and body of a GET", "function Get-Json") + slice("function Get-Page(", '# "" when $r is GET /operators answering');
    const run = await runPsAsync([
      "$ErrorActionPreference = 'Stop'",
      fns,
      `$cut = Get-Text "http://127.0.0.1:${port}/cut" 20`,
      'Write-Host ("CUT [" + $cut.Code + "] exit [" + $cut.Exit + "]")',
      `$ok = Get-Text "http://127.0.0.1:${port}/ok" 20`,
      'Write-Host ("OK [" + $ok.Code + "] exit [" + $ok.Exit + "] body [" + $ok.Body + "]")',
      `$pcut = Get-Page "http://127.0.0.1:${port}/cut" 20`,
      'Write-Host ("PCUT [" + $pcut.Code + "] exit [" + $pcut.Exit + "]")',
      `$pok = Get-Page "http://127.0.0.1:${port}/ok" 20`,
      'Write-Host ("POK [" + $pok.Code + "] exit [" + $pok.Exit + "] body [" + $pok.Body + "]")',
    ]);
    if (!run) return t.skip("no PowerShell available");
    assert.match(run.out, /^CUT \[000\] exit \[(?!0\])\d+\]/m, run.out);
    assert.match(run.out, /^OK \[200\] exit \[0\] body \[fine\]/m, run.out);
    assert.match(run.out, /^PCUT \[000\] exit \[(?!0\])\d+\]/m, run.out);
    assert.match(run.out, /^POK \[200\] exit \[0\] body \[fine\]/m, run.out);
  } finally {
    server.close();
  }
});

test("the door counts and the day parser, run for real on canned input: a non-numeric n, a non-boolean at_cap and a boolean n are READ FAILURES with a reason (never an uncaught stop), and the LAST Date header is the day", (t) => {
  // Mutations that redden this: delete the `-is [bool] -or -not (...)` n check (the [int] cast then stops the script, no RESULT line); `-isnot [bool]` -> `$false` for at_cap; Get-HeaderDay returning on the first Date line.
  if (!POWERSHELL) return t.skip("no PowerShell available");
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    doorsFns.slice(0, doorsFns.indexOf("# THE WAVE RIDE.")),
    "function Row($day, $door, $n, $cap) { return [pscustomobject]@{ day = $day; door = $door; n = $n; at_cap = $cap } }",
    '$a = ConvertTo-DoorCounts @((Row "2026-11-24" "agent_card" "many" $false)) "2026-11-24"; Write-Host ("BADN [" + $a["_Why"] + "]")',
    '$b = ConvertTo-DoorCounts @((Row "2026-11-24" "agent_card" 3 "true")) "2026-11-24"; Write-Host ("BADCAP [" + $b["_Why"] + "]")',
    '$c = ConvertTo-DoorCounts @((Row "2026-11-24" "agent_card" 3 1)) "2026-11-24"; Write-Host ("INTCAP [" + $c["_Why"] + "]")',
    '$d = ConvertTo-DoorCounts @((Row "2026-11-24" "agent_card" $true $false)) "2026-11-24"; Write-Host ("BOOLN [" + $d["_Why"] + "]")',
    '$e = ConvertTo-DoorCounts @((Row "2026-11-23" "agent_card" "many" "x"), (Row "2026-11-24" "agent_card" 3 $false)) "2026-11-24"; Write-Host ("OTHERDAYBAD [" + $e["_Why"] + "] N " + $e["agent_card"].N)',
    '$f = ConvertTo-DoorCounts @((Row "2026-11-24" "agent_card" 3 $false)) "2026-11-24"; Write-Host ("GOOD [" + $f["_Why"] + "] N " + $f["agent_card"].N)',
    'Write-Host ("LAST [" + (Get-HeaderDay "HTTP/1.1 200 Connection established`r`nDate: Mon, 23 Nov 2026 23:59:59 GMT`r`n`r`nHTTP/2 200`r`nDate: Tue, 24 Nov 2026 00:00:01 GMT`r`n") + "] [" + (Get-HeaderDay "Date: Mon, 23 Nov 2026 10:00:00 GMT`r`nDate: garbage") + "]")',
  ];
  const r = runPs(lines)!;
  assert.match(r.out, /BADN \[GET \/api\/doors: the row for agent_card has a non-numeric n \('many'\)\]/, r.out);
  assert.match(r.out, /BADCAP \[GET \/api\/doors: the row for agent_card has an at_cap that is not a boolean \('true'\)\]/);
  assert.match(r.out, /INTCAP \[GET \/api\/doors: the row for agent_card has an at_cap that is not a boolean \('1'\)\]/);
  assert.match(r.out, /BOOLN \[GET \/api\/doors: the row for agent_card has a non-numeric n \('True'\)\]/);
  assert.match(r.out, /OTHERDAYBAD \[\] N 3/, "a bad row of another day is never read");
  assert.match(r.out, /GOOD \[\] N 3/);
  assert.match(r.out, /LAST \[2026-11-24\] \[\]/, "the last Date header wins, and an unparseable last one is no day");
});

// The UTC day changes AFTER the door check began, so the counts cannot be judged: the reason says that, never "a door did not rise".
const datedAt = (days: string[]): Fixture => {
  let reads = 0;
  return {
    after: (s, res) => {
      if (s.path !== "/api/doors") return undefined;
      reads++;
      return { ...res, headers: { ...res.headers, date: days[Math.min(reads, days.length) - 1] } };
    },
  };
};
const staleUnknown = (): Fixture["intercept"] => (s) => (countedKind(s)?.startsWith("mcp-unknown") ? jsonAns({ jsonrpc: "2.0", id: 8, error: { code: -32601, message: "method 'ride/unknown' not found" } }) : undefined);

test("the UTC day changes during the door check or during the resend: the ride fails with a reason that says the day changed and the counts could not be judged, not 'a door did not rise'", async (t) => {
  if (!POWERSHELL) return t.skip("no PowerShell available");
  // Mutations that redden this: delete the `$nowRead.Day -cne $baseRead.Day` branch (the first fixture then resends and fails with a door reason); delete the `$afterRead.Day -cne $baseRead.Day` branch (the second then reads the baseline day's rows and reports a door short).
  const rfc = (ms: number): string => new Date(ms).toUTCString();
  const today = rfc(Date.now());
  const tomorrow = rfc(Date.now() + 86_400_000);
  // Reads: 1 baseline, 2 end of sends, 3-6 the door check (the unknown-method answers are stale, so it fails), 7 the read after the failure, 8 the read after the resend.
  const duringCheck = await ride3({ ...datedAt([today, today, today, today, today, today, tomorrow]), intercept: staleUnknown() });
  assert.equal(duringCheck.whys.length, 1, duringCheck.out);
  assert.match(duringCheck.whys[0], /the UTC day changed during the door check \(\d{4}-\d{2}-\d{2} -> \d{4}-\d{2}-\d{2}\), so the door counts could not be judged; this is not a finding that a door did not rise/);
  assert.equal(/only mcp_unknown_method is short/.test(duringCheck.out), false, "no resend once the day has moved");
  const duringResend = await ride3({ ...datedAt([today, today, today, today, today, today, today, tomorrow]), intercept: staleUnknown() });
  assert.equal(duringResend.whys.length, 1, duringResend.out);
  assert.match(duringResend.whys[0], /the UTC day changed during the resend \(\d{4}-\d{2}-\d{2} -> \d{4}-\d{2}-\d{2}\), so the door counts could not be judged; this is not a finding that a door did not rise/);
  assert.match(duringResend.out, /only mcp_unknown_method is short/);
});

test("wording: nothing is overstated (counters, uncounted routes, D1, /operators, dry run, /openapi.json), and every count the script states is the one the ride sends", () => {
  // Mutations that redden this: put back "read no D1" in the closing note; put back "rose by what the ride proved"; put back "none of these reaches a counter"; put back the old /operators sentence; drop "commit_days" from the dry-run text.
  assert.equal(/NO D1 READ|read no D1|reads no D1/.test(script), false, "the D1 claim is 'no D1 command of its own'");
  assert.ok(script.includes("ran no D1 command of its own") && script.includes("runs no D1 command of its own") && script.includes("NO D1 COMMAND OF ITS OWN"));
  assert.equal(/rose by what|rise by what the ride sent/.test(script), false, "the counters line says at least baseline + PROVED for the round judged");
  assert.ok(script.includes("or was at its cap") && script.includes("the totals span two days"));
  assert.equal(script.includes("none of these reaches a counter"), false);
  assert.ok(script.includes("do not count by the code and by the local tests") && script.includes("does not measure that"));
  assert.equal(script.includes("and /skill.md, /heartbeat.md and /operators are counted doors"), false, "/operators is not named beside the byte comparison");
  assert.ok(script.includes("the poll's page check, the ride's page check and the sweeps"));
  const dry = script.split("\n").find((l) => l.includes('Say "[dry-run]'))!;
  assert.ok(dry.includes("attempts a count") && dry.includes("commit_days stamp row") && dry.includes("plain reads that count nothing (GET /api/attest"), "the dry-run text says attempts a count, names the commit_days row and lists the uncounted reads");
  assert.ok(dry.includes("message/send and SendMessage, each to /mcp and to /mcp/read (4, mcp_a2a_probe)") && dry.includes("A clean ride proves 11 counted requests"));
  assert.ok(script.includes("/openapi.json lists the two card GETs and not /a2a"), "the sentence is kept, and Test-DiscoveryServed now checks each card carries a get operation");
  assert.ok(script.includes("mcp_a2a_probe 4 (each of the two A2A send methods"), "the header states 4 for the MCP A2A probe");
});
