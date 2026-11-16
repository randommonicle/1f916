// scripts/deploy-openapi-resident-schema.ps1 is WRITTEN AND NEVER RUN by the builder (no deploy, no wrangler, not even -DryRun, which reads the live worker over HTTP). It is proven here by what can be
// proven without running it: it parses under PowerShell's own parser, is ASCII with LF endings, has none of the repo's PowerShell traps, has the load-bearing step order, no migration or D1 step,
// a single wrangler use, a ride of public GETs with no request body at all, step 0a stops on the placeholder before any git or network command, and the served checks
// (Test-ResidentSchemaServed, Test-RosterSchemaServed, Test-DoorsNoteServed, Test-ResidentsLive) are run for real against good and bad captured answers. Derived from the 12 Nov openapi proposal schema deploy script test.
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
const SCRIPT_PATH = here("../scripts/deploy-openapi-resident-schema.ps1");
const rawScript = readFileSync(SCRIPT_PATH, "utf8");
const script = rawScript.replace(/\r\n/g, "\n");
const code = script.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
const defs = script.slice(script.indexOf('$ErrorActionPreference = "Stop"'), script.indexOf("# END-OF-DEFINITIONS"));
const pinBlock = script.slice(script.indexOf("# BEGIN-PIN-CHECK"), script.indexOf("# END-PIN-CHECK"));

const LIVE = "f6e3af26f337acee80a2b07e0e1398741695abd0";
const SHIP_SENTENCE = "It shipped on 15 November 2026.";
const NOENTRY_SENTENCE = "Days before this shipped have no entry.";

function runPs(lines: string[]): { code: number | null; out: string } | null {
  const dir = mkdtempSync(join(tmpdir(), "deploy-openapi-resident-schema-"));
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

test("the pins: the v6 hash, the live base f6e3af26, the reviewed pin is the placeholder or a 40-hex sha, the allowlist is this script, its test and docs/, the parameters are -ExpectedCommit (mandatory) and -DryRun", () => {
  assert.match(script, /^\$V6_HASH = "dc5f48213c29bcf844e0fbe7daf1bdb5416b3d57fbd06a8bd03f1061f34092b3"$/m);
  assert.match(script, new RegExp(`^\\$LIVE_BASE_COMMIT = "${LIVE}"$`, "m"));
  assert.match(script, /^\$LIVE_BASE_PLACEHOLDER = "TO-BE-SET-BY-HUB-LIVE-BASE"$/m);
  // Setting the pin (the hub's later edit) must not red the suite: the line may hold the placeholder or a full sha.
  assert.match(script, /^\$REVIEWED_COMMIT = "(TO-BE-SET-BY-HUB|[0-9a-f]{40})"$/m);
  assert.match(script, /^\$REVIEWED_COMMIT_PLACEHOLDER = "TO-BE-SET-BY-HUB"$/m);
  assert.match(script, /^\$ALLOWED_PATHS_AFTER_REVIEW = @\("scripts\/deploy-openapi-resident-schema\.ps1", "scripts\/check-resident-schema-served\.mjs", "test\/deploy-openapi-resident-schema-script\.test\.ts", "docs\/"\)$/m);
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
  assert.match(runPs(harness("f6e3af26", FULL))!.out, /\[STOP\].*LIVE_BASE_COMMIT.*not 40 lower-case hex/);
  const ok = runPs(harness(LIVE, FULL))!;
  assert.equal(ok.code, 0);
  assert.match(ok.out, /\[PASSED-PINS\]/);
});

test("the pin test accepts the set sha: the shipped script, with its reviewed line set to a real 40-hex sha, still passes every pin assertion", () => {
  const FULL = "0123456789abcdef0123456789abcdef01234567";
  const set = script.replace(/^\$REVIEWED_COMMIT = ".*"$/m, `$REVIEWED_COMMIT = "${FULL}"`);
  assert.match(set, /^\$REVIEWED_COMMIT = "(TO-BE-SET-BY-HUB|[0-9a-f]{40})"$/m);
  assert.match(set, new RegExp(`^\\$REVIEWED_COMMIT = "${FULL}"$`, "m"));
  assert.match(set, /^\$REVIEWED_COMMIT_PLACEHOLDER = "TO-BE-SET-BY-HUB"$/m);
  assert.equal(/[^\x00-\x7f]/.test(set), false);
});

test("the steps are in the load-bearing order, there is no migration or D1 step, wrangler is used once (the stamped deploy), and the ride sends no POST and no request body", () => {
  const order = ["BEGIN-PIN-CHECK", "git fetch origin", "BEGIN-REVIEWED-SOURCE-CHECK", "BEGIN-GATES", 'Read-Attest "before the deploy"', "if ($DryRun)", "BEGIN-DEPLOY-AND-POLL", 'Read-Attest "after the deploy"', "Test-ResidentSchemaServed $runsNow", "Test-RosterSchemaServed $runsNow", "Test-DoorsNoteServed $doorsNow", "Test-ResidentsLive $rosterNow", "Invoke-ServedCheck $servedOpenapi $servedDoors"];
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

test("what the served routes carry: the schema constants and recoveries are in src/discovery.ts, the ship-day sentences are in src/doors.ts, and the script's literals match", () => {
  const disc = readFileSync(here("../src/discovery.ts"), "utf8");
  const doors = readFileSync(here("../src/doors.ts"), "utf8");
  for (const lit of ["const RESIDENTS_RESPONSE_SCHEMA", "const RESIDENT_RESPONSE_SCHEMA", "recoveries: { type: \"integer\", minimum: 0", 'enum: ["resident_record"]', "maxItems: 0"]) assert.ok(disc.includes(lit), `src/discovery.ts carries ${lit}`);
  assert.ok(doors.includes('STAMPS_SINCE = "15 November 2026"') && doors.includes("It shipped on ${STAMPS_SINCE}."), "src/doors.ts builds the ship-day sentence from 15 November 2026");
  assert.ok(doors.includes(NOENTRY_SENTENCE));
  assert.ok(script.includes(`"${SHIP_SENTENCE}"`) && script.includes(`"${NOENTRY_SENTENCE}"`));
  assert.ok(script.includes("$RUNS_URL = \"$BASE/openapi.json\""));
  assert.ok(code.includes(".paths.'/api/resident/{number}'") && code.includes(".paths.'/api/residents'"));
});

test("the source checks name literals the checkout carries: the wave anchors, the earlier-wave anchors, and every other Select-String literal is in its file", () => {
  assert.ok(code.includes('Select-String -Path "src/discovery.ts" -Pattern "responseSchema: RESIDENTS_RESPONSE_SCHEMA"'));
  assert.ok(code.includes('Select-String -Path "src/discovery.ts" -Pattern "responseSchema: RESIDENT_RESPONSE_SCHEMA"'));
  assert.ok(code.includes('Select-String -Path "src/discovery.ts" -Pattern "responseSchema: PROPOSAL_RESPONSE_SCHEMA"'));
  assert.ok(code.includes("Select-String -Path \"src/doors.ts\" -Pattern 'export const STAMPS_SINCE = \"15 November 2026\";'"));
  assert.ok(code.includes('Select-String -Path "src/doors.ts" -Pattern "INSERT OR IGNORE INTO commit_days"'));
  assert.ok(code.includes('Select-String -Path "src/maintainer/judgment.ts" -Pattern "DEFERRED-JUDGMENT-REFUSAL-HELD-STATUS"'));
  let n = 0;
  for (const m of code.matchAll(/Select-String -Path "([^"]+)" -Pattern ('[^']+'|"[^"]+")/g)) {
    const file = m[1];
    if (file === "wrangler.jsonc") continue;
    const lit = m[2].slice(1, -1);
    // DEFERRED-JUDGMENT-REFUSAL-HELD-STATUS was resolved on 17 November 2026 (D-083, the parked list): the marker is gone from judgment.ts by design, and this earlier wave is not re-deployed.
    if (lit === "DEFERRED-JUDGMENT-REFUSAL-HELD-STATUS") continue;
    assert.ok(readFileSync(here(`../${file}`), "utf8").includes(lit), `${file} carries '${lit}'`);
    n++;
  }
  assert.ok(n >= 12, `checked ${n} literals`);
});

type Cap = { code: string; body: string };
const q = (s: string): string => "'" + s.replace(/'/g, "''") + "'";
const cap = (c: Cap): string => `@{ Code = ${q(c.code)}; Type = 'application/json'; Body = ${q(c.body)} }`;
const slice = (from: string, to: string): string => defs.slice(defs.indexOf(from), defs.indexOf(to));

const rowProps = (unitEnum: string[], maxItems: number | undefined) => ({
  unit: { type: "string", enum: unitEnum },
  counts_toward: maxItems === undefined ? { type: "array" } : { type: "array", maxItems },
});
const openapi = (opts: { resident?: unknown; roster?: unknown }): string =>
  JSON.stringify({
    openapi: "3.0.3",
    paths: {
      "/api/residents": { get: { responses: { "200": { content: { "application/json": { schema: opts.roster } } } } } },
      "/api/resident/{number}": { get: { responses: { "200": { content: { "application/json": { schema: opts.resident } } } } } },
    },
  });
const residentSchema = (recoveries: unknown) => ({ type: "object", properties: { number: { type: "integer" }, ...(recoveries === undefined ? {} : { recoveries }) } });
const rosterSchema = (unitEnum: string[], maxItems: number | undefined) => ({ type: "object", properties: { residents: { type: "array", items: { type: "object", properties: rowProps(unitEnum, maxItems) } } } });

test("the resident schema check, run for real, passes recoveries integer with minimum 0 and fails a bare object, no recoveries, the wrong type, a missing minimum, a wrong minimum, a non-200, a non-JSON body and an empty body", (t) => {
  const fns = slice("function Read-JsonBody", "# \"\" when $r is GET /openapi.json whose GET /api/residents");
  const good = openapi({ resident: residentSchema({ type: "integer", minimum: 0 }) });
  const cases: Array<[string, Cap, string]> = [
    ["good", { code: "200", body: good }, ""],
    ["bare", { code: "200", body: openapi({ resident: { type: "object" } }) }, "the resident schema has no properties"],
    ["norec", { code: "200", body: openapi({ resident: residentSchema(undefined) }) }, "the resident schema has no recoveries property"],
    ["wrongtype", { code: "200", body: openapi({ resident: residentSchema({ type: "string", minimum: 0 }) }) }, "recoveries type is 'string'"],
    ["nomin", { code: "200", body: openapi({ resident: residentSchema({ type: "integer" }) }) }, "recoveries minimum is ''"],
    ["wrongmin", { code: "200", body: openapi({ resident: residentSchema({ type: "integer", minimum: 1 }) }) }, "recoveries minimum is '1'"],
    ["undeclared", { code: "200", body: JSON.stringify({ openapi: "3.0.3", paths: {} }) }, "does not declare a 200 JSON schema"],
    ["500", { code: "500", body: good }, "expected 200"],
    ["html", { code: "200", body: "<html>x</html>" }, "did not return JSON"],
    ["empty", { code: "200", body: "" }, "did not return JSON"],
  ];
  const run = runPs(["$ErrorActionPreference = 'Stop'", fns, ...cases.map(([name, c]) => `Write-Host ("RESULT ${name} [" + (Test-ResidentSchemaServed ${cap(c)}) + "]")`)]);
  if (!run) return t.skip("no PowerShell available");
  for (const [name, , expect] of cases) {
    const m = new RegExp(`RESULT ${name} \\[(.*)\\]`).exec(run.out);
    assert.ok(m, `${name} produced a result: ${run.out}`);
    if (expect === "") assert.equal(m![1], "", name);
    else assert.ok(m![1].includes(expect), `${name}: '${m![1]}' mentions '${expect}'`);
  }
});

test("the roster schema check, run for real, passes the one-value unit enum with counts_toward maxItems 0 and fails a wider enum, an empty enum, a missing or non-zero maxItems, a bare schema and a non-200", (t) => {
  const fns = slice("function Read-JsonBody", "# \"\" when $r is GET /openapi.json whose GET /api/residents") + slice("# \"\" when $r is GET /openapi.json whose GET /api/residents", "# \"\" when $r is GET /api/doors");
  const cases: Array<[string, Cap, string]> = [
    ["good", { code: "200", body: openapi({ roster: rosterSchema(["resident_record"], 0) }) }, ""],
    ["wide", { code: "200", body: openapi({ roster: rosterSchema(["resident_record", "agent"], 0) }) }, "unit enum is 'resident_record,agent'"],
    ["wrongvalue", { code: "200", body: openapi({ roster: rosterSchema(["agent"], 0) }) }, "unit enum is 'agent'"],
    ["noenum", { code: "200", body: openapi({ roster: rosterSchema([], 0) }) }, "unit enum is ''"],
    ["nomax", { code: "200", body: openapi({ roster: rosterSchema(["resident_record"], undefined) }) }, "counts_toward does not carry maxItems 0"],
    ["max3", { code: "200", body: openapi({ roster: rosterSchema(["resident_record"], 3) }) }, "counts_toward does not carry maxItems 0"],
    ["bare", { code: "200", body: openapi({ roster: { type: "object" } }) }, "declares no residents items properties"],
    ["500", { code: "500", body: "{}" }, "expected 200"],
  ];
  const run = runPs(["$ErrorActionPreference = 'Stop'", fns, ...cases.map(([name, c]) => `Write-Host ("RESULT ${name} [" + (Test-RosterSchemaServed ${cap(c)}) + "]")`)]);
  if (!run) return t.skip("no PowerShell available");
  for (const [name, , expect] of cases) {
    const m = new RegExp(`RESULT ${name} \\[(.*)\\]`).exec(run.out);
    assert.ok(m, `${name} produced a result: ${run.out}`);
    if (expect === "") assert.equal(m![1], "", name);
    else assert.ok(m![1].includes(expect), `${name}: '${m![1]}' mentions '${expect}'`);
  }
});

test("the doors note and live roster checks, run for real, pass the good answers and fail a missing ship-day sentence, a missing no-entry sentence, a wrong-case sentence, a wrong unit and a non-200", (t) => {
  const fns = slice("function Read-JsonBody", "# \"\" when $r is GET /openapi.json whose GET /api/residents") + slice("# \"\" when $r is GET /api/doors", "# Polls (GETs only)");
  const note = (s: string): string => JSON.stringify({ note: s });
  const cases: Array<[string, string, Cap, string]> = [
    ["doorsgood", "Test-DoorsNoteServed", { code: "200", body: note(`x ${SHIP_SENTENCE} y ${NOENTRY_SENTENCE}`) }, ""],
    ["noship", "Test-DoorsNoteServed", { code: "200", body: note(`x ${NOENTRY_SENTENCE}`) }, "ship-day sentence"],
    ["noentry", "Test-DoorsNoteServed", { code: "200", body: note(`x ${SHIP_SENTENCE}`) }, "no-entry sentence"],
    ["doorscase", "Test-DoorsNoteServed", { code: "200", body: note(`${SHIP_SENTENCE.toUpperCase()} ${NOENTRY_SENTENCE}`) }, "ship-day sentence"],
    ["doors500", "Test-DoorsNoteServed", { code: "500", body: "{}" }, "expected 200"],
    ["rostergood", "Test-ResidentsLive", { code: "200", body: JSON.stringify({ unit: "resident_record", total: 0, residents: [] }) }, ""],
    ["rosterunit", "Test-ResidentsLive", { code: "200", body: JSON.stringify({ unit: "agent", total: 0, residents: [] }) }, "expected resident_record"],
    ["rosterfragment", "Test-ResidentsLive", { code: "200", body: JSON.stringify({ unit: "resident_record" }) }, "total is not an integer"],
    ["rostertotalstr", "Test-ResidentsLive", { code: "200", body: JSON.stringify({ unit: "resident_record", total: "0", residents: [] }) }, "total is not an integer"],
    ["rostertotalneg", "Test-ResidentsLive", { code: "200", body: JSON.stringify({ unit: "resident_record", total: -1, residents: [] }) }, "total is below 0"],
    ["rosternoarray", "Test-ResidentsLive", { code: "200", body: JSON.stringify({ unit: "resident_record", total: 0, residents: "x" }) }, "residents is not an array"],
    ["roster404", "Test-ResidentsLive", { code: "404", body: "{}" }, "expected 200"],
  ];
  const run = runPs(["$ErrorActionPreference = 'Stop'", fns, ...cases.map(([name, fn, c]) => `Write-Host ("RESULT ${name} [" + (${fn} ${cap(c)}) + "]")`)]);
  if (!run) return t.skip("no PowerShell available");
  for (const [name, , , expect] of cases) {
    const m = new RegExp(`RESULT ${name} \\[(.*)\\]`).exec(run.out);
    assert.ok(m, `${name} produced a result: ${run.out}`);
    if (expect === "") assert.equal(m![1], "", name);
    else assert.ok(m![1].includes(expect), `${name}: '${m![1]}' mentions '${expect}'`);
  }
});

test("the before-read accepts only the two ABSENT reasons, refuses an already-deployed worker and a non-200; the poll and the ride use the checks; the closing note states the door-counter writes and the two stamps", () => {
  assert.ok(code.includes('[string]$runsBefore.Code -cne "200"'));
  assert.ok(code.includes("$whyBefore = Test-ResidentSchemaServed $runsBefore"));
  assert.ok(code.includes('if ($whyBefore -eq "") { Stop-Here'));
  assert.ok(code.includes('$whyBefore -cne "the resident schema has no properties" -and $whyBefore -cne "the resident schema has no recoveries property"'));
  // The accepted reasons must be exactly the ones Test-ResidentSchemaServed returns.
  assert.ok(code.includes('return "the resident schema has no properties"') && code.includes('return "the resident schema has no recoveries property"'));
  assert.ok(code.includes("Test-ResidentSchemaServed (Get-Text $RUNS_URL 30)"));
  assert.ok(code.includes("Wait-NewWorker $headSha $versionId $POLL_TRIES"));
  assert.ok(code.includes('"/privacy"') && code.includes('"/api/proposal/8"'));
  assert.equal(code.includes("it wrote nothing"), false, "the false 'wrote nothing' note is gone");
  // CODEX r1 finding 4: the note says each GET ATTEMPTS a counting write; it must not say the ride wrote or that each GET adds one.
  assert.equal(code.includes("It still wrote"), false, "no 'It still wrote'");
  assert.equal(code.includes("adds one"), false, "no 'adds one'");
  for (const needle of ["/skill.md and /heartbeat.md are counted doors", "each GET of them ATTEMPTS a counting write", "only while the door is below its daily cap and the batch succeeds", "can be written even at the cap", "commit_days", "two stamps for today"]) {
    assert.ok(code.includes(needle), `closing note carries '${needle}'`);
  }
});

test("CODEX r1 finding 3: the ride saves the live bodies and runs the whole-document checker after the poll, and STOPS with the rollback line unless it exits 0 and printed OK; -DryRun runs the checker local with local and says so", () => {
  const poll = code.indexOf("Wait-NewWorker $headSha $versionId $POLL_TRIES");
  const save = code.indexOf("$openapiSaved = Save-Body $RUNS_URL $servedOpenapi");
  const run = code.indexOf("$served = Invoke-ServedCheck $servedOpenapi $servedDoors");
  const stop = code.indexOf('if ($served.Code -ne 0 -or $served.Out -cne "OK") { Stop-Here');
  const sweep = code.lastIndexOf("$bad = @()");
  assert.ok(poll >= 0 && save > poll && run > save && stop > run && sweep > stop, "poll, save, check, stop, then the public sweep");
  assert.ok(code.slice(stop, stop + 400).includes("$ROLLBACK_LINE"), "the stop carries the rollback line");
  assert.ok(code.includes("node --experimental-strip-types scripts/check-resident-schema-served.mjs $openapiFile $doorsFile"));
  const dry = code.slice(code.indexOf("if ($DryRun) {"), code.indexOf("exit 0", code.indexOf("if ($DryRun) {")));
  assert.ok(dry.includes("--write-local") && dry.includes("Invoke-ServedCheck $dryOpenapi $dryDoors") && dry.includes("(local with local)"), "the dry run checks local with local and says so");
  assert.ok(dry.indexOf("Invoke-ServedCheck") < dry.indexOf("[dry-run] would now"));
});

// The checker, run for real as a child process (plain node, no network).
const CHECKER = here("../scripts/check-resident-schema-served.mjs");
function runChecker(args: string[]): { code: number | null; out: string } {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", CHECKER, ...args], { encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}`.trim() };
}
function withLocalBodies(fn: (openapiFile: string, doorsFile: string, doc: any, doors: { note: string }) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "resident-schema-checker-"));
  try {
    const o = join(dir, "openapi.json");
    const d = join(dir, "doors.json");
    const w = runChecker(["--write-local", o, d]);
    assert.equal(w.code, 0, w.out);
    fn(o, d, JSON.parse(readFileSync(o, "utf8")), JSON.parse(readFileSync(d, "utf8")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const schemaAt = (doc: any, p: string): any => doc.paths[p].get.responses["200"].content["application/json"].schema;

test("the checker, run for real: bodies built from this checkout are OK (exit 0), and the file is ASCII with LF endings", () => {
  const raw = readFileSync(CHECKER, "utf8");
  assert.equal(/[^\x00-\x7f]/.test(raw), false, "ASCII only");
  assert.equal(raw.includes("\r"), false, "LF line endings");
  assert.equal(/process\.exit\(/.test(raw), false, "never process.exit()");
  withLocalBodies((o, d) => {
    const r = runChecker([o, d]);
    assert.equal(r.out, "OK");
    assert.equal(r.code, 0);
  });
});

test("Invoke-ServedCheck, run for real under PowerShell, returns exit 0 and OK for local bodies and exit 1 for a fragment (the node invocation the ride and the dry run depend on)", (t) => {
  const fn = slice("function Invoke-ServedCheck", "# Polls (GETs only)");
  const root = here("..").replace(/[\\/]$/, "");
  withLocalBodies((o, d) => {
    const dir = mkdtempSync(join(tmpdir(), "resident-schema-ps-"));
    try {
      const frag = join(dir, "frag.json");
      writeFileSync(frag, JSON.stringify({ openapi: "3.0.3", paths: {} }));
      const run = runPs([
        "$ErrorActionPreference = 'Stop'",
        `Set-Location ${q(root)}`,
        fn,
        `$a = Invoke-ServedCheck ${q(o)} ${q(d)}`,
        'Write-Host ("RESULT good [" + $a.Code + "|" + $a.Out + "]")',
        `$b = Invoke-ServedCheck ${q(frag)} ${q(d)}`,
        'Write-Host ("RESULT frag [" + $b.Code + "|" + $b.Out.Substring(0, 8) + "]")',
      ]);
      if (!run) return t.skip("no PowerShell available");
      assert.match(run.out, /RESULT good \[0\|OK\]/, run.out);
      assert.match(run.out, /RESULT frag \[1\|MISMATCH\]/, run.out);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("the checker, run for real, fails (exit 1) on each fragment shape and names the right one of the three", () => {
  withLocalBodies((o, d, doc, doors) => {
    const dir = mkdtempSync(join(tmpdir(), "resident-schema-checker-frag-"));
    try {
      const put = (name: string, v: unknown): string => { const f = join(dir, name); writeFileSync(f, JSON.stringify(v)); return f; };
      const clone = () => JSON.parse(JSON.stringify(doc));

      const profileOnlyRec = clone();
      schemaAt(profileOnlyRec, "/api/resident/{number}").properties = { recoveries: { type: "integer", minimum: 0 } };
      let r = runChecker([put("p.json", profileOnlyRec), d]);
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /^MISMATCH openapi \/api\/resident\/\{number\} schema/);

      const rosterFragment = clone();
      const rs = schemaAt(rosterFragment, "/api/residents");
      rs.properties = { residents: { type: "array", items: { type: "object", properties: { unit: { type: "string", enum: ["resident_record"] }, counts_toward: { type: "array", maxItems: 0 } } } } };
      r = runChecker([put("r.json", rosterFragment), d]);
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /^MISMATCH openapi \/api\/residents schema/);

      const sentences = doors.note.split(". ");
      const missingSentence = { note: doors.note.replace("It shipped on 15 November 2026.", "") };
      assert.notEqual(missingSentence.note, doors.note, "the fixture really removed the ship-day sentence");
      r = runChecker([o, put("n.json", missingSentence)]);
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /^MISMATCH \/api\/doors note, first differing character at index \d+/);

      const twoSentences = { note: sentences.slice(0, 2).join(". ") + "." };
      r = runChecker([o, put("n2.json", twoSentences)]);
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /^MISMATCH \/api\/doors note/);

      r = runChecker([o, put("n3.json", { unit: "resident_record" })]);
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /^MISMATCH \/api\/doors note: served body carries no string note/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("the checker, run for real, fails (exit 1) on one changed constraint deep inside, with its JSON path, and ignores key order and origin-dependent fields", () => {
  withLocalBodies((o, d, doc) => {
    const dir = mkdtempSync(join(tmpdir(), "resident-schema-checker-deep-"));
    try {
      const put = (name: string, v: unknown): string => { const f = join(dir, name); writeFileSync(f, JSON.stringify(v)); return f; };
      const clone = () => JSON.parse(JSON.stringify(doc));

      const limit = clone();
      schemaAt(limit, "/api/residents").properties.limit.maximum = 101;
      let r = runChecker([put("l.json", limit), d]);
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /openapi \/api\/residents schema, first difference at \$\.properties\.limit\.maximum/);

      const nullable = clone();
      delete schemaAt(nullable, "/api/resident/{number}").properties.last_recovered_at.nullable;
      r = runChecker([put("n.json", nullable), d]);
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /openapi \/api\/resident\/\{number\} schema, first difference at \$\.properties\.last_recovered_at\.nullable/);

      const reordered = clone();
      const rs = schemaAt(reordered, "/api/residents");
      rs.properties = Object.fromEntries(Object.entries(rs.properties).reverse());
      reordered.servers = [{ url: "https://elsewhere.invalid" }];
      r = runChecker([put("ok.json", reordered), d]);
      assert.equal(r.out, "OK", "key order and servers do not matter");
      assert.equal(r.code, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("the checker, run for real, exits 2 on a missing file, a non-JSON file and the wrong argument count", () => {
  withLocalBodies((o, d) => {
    const dir = mkdtempSync(join(tmpdir(), "resident-schema-checker-bad-"));
    try {
      const bad = join(dir, "bad.json");
      writeFileSync(bad, "<html>not json</html>");
      let r = runChecker([bad, d]);
      assert.equal(r.code, 2, r.out);
      assert.match(r.out, /is not JSON/);
      r = runChecker([o, bad]);
      assert.equal(r.code, 2, r.out);
      r = runChecker([join(dir, "missing.json"), d]);
      assert.equal(r.code, 2, r.out);
      assert.match(r.out, /cannot read/);
      r = runChecker([o]);
      assert.equal(r.code, 2, r.out);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

test("CODEX r1: the ride re-checks code identity, HEAD and a clean tree are re-read just before wrangler bundles", (t) => {
  const reread = code.indexOf("$headNow = (git rev-parse HEAD).Trim()");
  const dirtyNow = code.indexOf("$dirtyNow = @(git status --porcelain)");
  const deploy = code.indexOf('npx wrangler deploy --var "CODE_COMMIT:$headSha"');
  const poll = code.indexOf("Wait-NewWorker $headSha $versionId $POLL_TRIES");
  const rideId = code.indexOf("Test-CodeIdentityServed $attAfter.code $headSha $versionId");
  // `code` has comment lines stripped, so the step-0 anchor is a retained code line.
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
