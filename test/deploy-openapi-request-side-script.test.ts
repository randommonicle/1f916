// scripts/deploy-openapi-request-side.ps1 is WRITTEN AND NEVER RUN by the builder (no deploy, no wrangler, not even -DryRun, which reads the live worker over HTTP). It is proven here by what can be
// proven without running it: it parses under PowerShell's own parser, is ASCII with LF endings, has none of the repo's PowerShell traps, has the load-bearing step order, no migration or D1 step,
// a single wrangler use, a ride of public GETs with no request body, step 0a stops on the placeholder before any git or network command, every Select-String literal is in its file, and
// the served check (Test-RequestSideServed) is run for real against good and bad captured answers. Derived from the 16 Nov openapi resident schema deploy script test.
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
const SCRIPT_PATH = here("../scripts/deploy-openapi-request-side.ps1");
const rawScript = readFileSync(SCRIPT_PATH, "utf8");
const script = rawScript.replace(/\r\n/g, "\n");
const code = script.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
const defs = script.slice(script.indexOf('$ErrorActionPreference = "Stop"'), script.indexOf("# END-OF-DEFINITIONS"));
const pinBlock = script.slice(script.indexOf("# BEGIN-PIN-CHECK"), script.indexOf("# END-PIN-CHECK"));

const LIVE = "fdcd416c9450f0538d48182447517a118b6a86db";

function runPs(lines: string[]): { code: number | null; out: string } | null {
  const dir = mkdtempSync(join(tmpdir(), "deploy-openapi-request-side-"));
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

test("the pins: the v6 hash, the live base fdcd416c, the reviewed pin is the placeholder or a 40-hex sha, the allowlist is this script, its test and docs/, the parameters are -ExpectedCommit (mandatory) and -DryRun", () => {
  assert.match(script, /^\$V6_HASH = "dc5f48213c29bcf844e0fbe7daf1bdb5416b3d57fbd06a8bd03f1061f34092b3"$/m);
  assert.match(script, new RegExp(`^\\$LIVE_BASE_COMMIT = "${LIVE}"$`, "m"));
  assert.match(script, /^\$LIVE_BASE_PLACEHOLDER = "TO-BE-SET-BY-HUB-LIVE-BASE"$/m);
  // Setting the pin (the hub's later edit) must not red the suite: the line may hold the placeholder or a full sha.
  assert.match(script, /^\$REVIEWED_COMMIT = "(TO-BE-SET-BY-HUB|[0-9a-f]{40})"$/m);
  assert.match(script, /^\$REVIEWED_COMMIT_PLACEHOLDER = "TO-BE-SET-BY-HUB"$/m);
  assert.match(script, /^\$ALLOWED_PATHS_AFTER_REVIEW = @\("scripts\/deploy-openapi-request-side\.ps1", "test\/deploy-openapi-request-side-script\.test\.ts", "docs\/"\)$/m);
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
  assert.match(runPs(harness("fdcd416c", FULL))!.out, /\[STOP\].*LIVE_BASE_COMMIT.*not 40 lower-case hex/);
  const ok = runPs(harness(LIVE, FULL))!;
  assert.equal(ok.code, 0);
  assert.match(ok.out, /\[PASSED-PINS\]/);
});

test("the steps are in the load-bearing order, there is no migration or D1 step, wrangler is used once (the stamped deploy), and the ride sends no POST and no request body", () => {
  const order = ["BEGIN-PIN-CHECK", "git fetch origin", "BEGIN-REVIEWED-SOURCE-CHECK", "BEGIN-GATES", 'Read-Attest "before the deploy"', "if ($DryRun)", "BEGIN-DEPLOY-AND-POLL", 'Read-Attest "after the deploy"', "Test-RequestSideServed $runsNow", "limit=0"];
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
});

test("the source checks name literals the checkout carries: the wave anchor, the parked-list anchor, and every Select-String literal is in its file", () => {
  assert.ok(code.includes('Select-String -Path "src/discovery.ts" -Pattern "has no pathParams declaration"'));
  assert.ok(code.includes('Select-String -Path "src/maintainer/parked.ts" -Pattern "export async function parkedPage"'));
  let n = 0;
  for (const m of code.matchAll(/Select-String -Path "([^"]+)" -Pattern ('[^']+'|"[^"]+")/g)) {
    if (m[1] === "wrangler.jsonc") continue;
    const lit = m[2].slice(1, -1);
    assert.ok(readFileSync(here(`../${m[1]}`), "utf8").includes(lit), `${m[1]} carries '${lit}'`);
    n++;
  }
  assert.ok(n >= 12, `checked ${n} literals`);
});

type Cap = { code: string; body: string };
const q = (s: string): string => "'" + s.replace(/'/g, "''") + "'";
const cap = (c: Cap): string => `@{ Code = ${q(c.code)}; Type = 'application/json'; Body = ${q(c.body)} }`;
const slice = (from: string, to: string): string => defs.slice(defs.indexOf(from), defs.indexOf(to));

const GOOD_PARAMS = {
  number: { name: "number", in: "path", required: true, schema: { type: "integer" } },
  after: { name: "after", in: "query", required: false, schema: { type: "string", pattern: "^[0-9]{1,15}$" } },
};
const doc = (o: { number?: unknown; after?: unknown; with400?: boolean; noList?: boolean }): string =>
  JSON.stringify({
    openapi: "3.0.3",
    paths: {
      "/api/resident/{number}": { get: { parameters: o.number === undefined ? [] : [o.number], responses: { "200": {} } } },
      ...(o.noList ? {} : { "/api/residents": { get: { parameters: o.after === undefined ? [] : [o.after], responses: { "200": {}, ...(o.with400 === false ? {} : { "400": {} }) } } } }),
    },
  });

test("the request-side check, run for real, passes the good document and fails each missing or wrong piece with its own reason", (t) => {
  const fns = slice("function Read-JsonBody", "# Polls (GETs only)");
  const good = doc({ number: GOOD_PARAMS.number, after: GOOD_PARAMS.after });
  const cases: Array<[string, Cap, string]> = [
    ["good", { code: "200", body: good }, ""],
    ["nonumber", { code: "200", body: doc({ after: GOOD_PARAMS.after }) }, "declares no number path parameter"],
    ["numberoptional", { code: "200", body: doc({ number: { ...GOOD_PARAMS.number, required: false }, after: GOOD_PARAMS.after }) }, "not required"],
    ["numberquery", { code: "200", body: doc({ number: { ...GOOD_PARAMS.number, in: "query" }, after: GOOD_PARAMS.after }) }, "declares no number path parameter"],
    ["noafter", { code: "200", body: doc({ number: GOOD_PARAMS.number }) }, "declares no after query parameter"],
    ["afterint", { code: "200", body: doc({ number: GOOD_PARAMS.number, after: { ...GOOD_PARAMS.after, schema: { type: "integer" } } }) }, "after type is 'integer'"],
    ["afternopattern", { code: "200", body: doc({ number: GOOD_PARAMS.number, after: { ...GOOD_PARAMS.after, schema: { type: "string" } } }) }, "after pattern is ''"],
    ["afterwrongpattern", { code: "200", body: doc({ number: GOOD_PARAMS.number, after: { ...GOOD_PARAMS.after, schema: { type: "string", pattern: "^x$" } } }) }, "after pattern is '^x$'"],
    ["no400", { code: "200", body: doc({ number: GOOD_PARAMS.number, after: GOOD_PARAMS.after, with400: false }) }, "no 400 response"],
    ["nolist", { code: "200", body: doc({ number: GOOD_PARAMS.number, noList: true }) }, "declares no GET /api/residents"],
    ["undeclared", { code: "200", body: JSON.stringify({ openapi: "3.0.3", paths: {} }) }, "declares no /api/resident/{number} path"],
    ["500", { code: "500", body: good }, "expected 200"],
    ["html", { code: "200", body: "<html>x</html>" }, "did not return JSON"],
    ["empty", { code: "200", body: "" }, "did not return JSON"],
  ];
  const run = runPs(["$ErrorActionPreference = 'Stop'", fns, ...cases.map(([name, c]) => `Write-Host ("RESULT ${name} [" + (Test-RequestSideServed ${cap(c)}) + "]")`)]);
  if (!run) return t.skip("no PowerShell available");
  for (const [name, , expect] of cases) {
    const m = new RegExp(`RESULT ${name} \\[(.*)\\]`).exec(run.out);
    assert.ok(m, `${name} produced a result: ${run.out}`);
    if (expect === "") assert.equal(m![1], "", name);
    else assert.ok(m![1].includes(expect), `${name}: '${m![1]}' mentions '${expect}'`);
  }
});

test("the before-read accepts only the one ABSENT reason and refuses an already-deployed worker; the poll and the ride use the check", () => {
  assert.ok(code.includes("$whyBefore = Test-RequestSideServed $runsBefore"));
  assert.ok(code.includes('if ($whyBefore -eq "") { Stop-Here'));
  assert.ok(code.includes('$whyBefore -cne "the profile route declares no number path parameter"'));
  assert.ok(code.includes('return "the profile route declares no number path parameter"'), "the accepted reason is exactly the one the check returns");
  assert.ok(code.includes("Test-RequestSideServed (Get-Text $RUNS_URL 30)"));
});
