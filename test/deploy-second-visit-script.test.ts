// scripts/deploy-second-visit.ps1 (the second-visit wave AND the constitution v6 mint, phase 2) is WRITTEN AND NEVER RUN by the builder (no deploy, no wrangler, not even -DryRun, which reads the live worker over HTTP). It is proven here by what can be proven
// without running it: it parses under PowerShell's own parser, is ASCII with LF endings, has none of the repo's PowerShell traps, has the load-bearing step order, no migration or D1 step, a single
// wrangler use, a ride with no guest write and exactly one POST site (the JSON-RPC initialize), step 0a stops on the placeholder before any git or network command, and its checks are run for real:
// Test-RootServed and Assert-AttestAfter against good and bad answers, Get-TemplateText against the real src/doc.ts. Every phrase it waits for is checked, in process, against the new code. Pattern:
// test/deploy-privacy-script.test.ts and test/deploy-council-flag-script.test.ts; mutants in docs/CHECKPOINT-SECOND-VISIT.md.
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
import { createLocalD1, seedCitizens, guestEnv, call } from "./helpers/guest.ts";
import { computeLiveConstitutionPair } from "../src/governance.ts";

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
const SCRIPT_PATH = here("../scripts/deploy-second-visit.ps1");
const rawScript = readFileSync(SCRIPT_PATH, "utf8");
const script = rawScript.replace(/\r\n/g, "\n");
const code = script.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
const at = (needle: string, from = 0): number => {
  const i = code.indexOf(needle, from);
  assert.ok(i >= 0, `the script must contain: ${needle}`);
  return i;
};
const defs = script.slice(script.indexOf('$ErrorActionPreference = "Stop"'), script.indexOf("# END-OF-DEFINITIONS"));
const pinBlock = script.slice(script.indexOf("# BEGIN-PIN-CHECK"), script.indexOf("# END-PIN-CHECK"));
const pin = (name: string): string => {
  const m = new RegExp(`^\\$${name} = "(.*)"$`, "m").exec(script);
  assert.ok(m, `pin ${name}`);
  return m![1];
};

function runPs(lines: string[]): { code: number | null; out: string } | null {
  const dir = mkdtempSync(join(tmpdir(), "deploy-second-visit-"));
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

test("the pins: the v5 hash, the live base is the full sha of 773ce09f, the reviewed commit is the hub's placeholder or a full 40-hex sha, the parameters are -ExpectedCommit (mandatory) and -DryRun, the skill line is 1.4.4", () => {
  assert.match(script, /^\$V5_HASH = "fa11788d062b0c6d23c54c428c1c9649d263ae3ba704e602e122066926049491"$/m);
  assert.match(script, /^\$LIVE_BASE_COMMIT = "773ce09f6d90421e1627adb2a9f951e400b2664f"$/m);
  assert.match(script, /^\$REVIEWED_COMMIT = "(?:TO-BE-SET-BY-HUB|[0-9a-f]{40})"$/m);
  assert.match(script, /\[Parameter\(Mandatory = \$true\)\]\[string\]\$ExpectedCommit/);
  assert.match(script, /\[switch\]\$DryRun/);
  assert.equal(pin("SKILL_VERSION_LINE"), "version: 1.4.4");
  assert.equal(pin("V5_HASH"), "fa11788d062b0c6d23c54c428c1c9649d263ae3ba704e602e122066926049491", "the constitution served before the deploy");
  assert.match(script, /^\$V6_HASH = "[0-9a-f]{64}"$/m);
  assert.ok(/ASSUMES THE PRIVACY WAVE IS DEPLOYED FIRST/.test(script), "the base's assumption is written down");
});

test("step 0a STOPS on the placeholder before ANY git, npm, wrangler or network command (the pin block is run for real), and the same block passes a full sha", (t) => {
  const stubs = ["git", "npm", "npx", "curl.exe"].map((n) => `function ${n} { throw "${n} must not run in step 0a" }`);
  const harness = (reviewed: string): string[] => [
    "$ErrorActionPreference = 'Stop'",
    ...stubs,
    "function Stop-Here($msg) { Write-Host \"[STOP] $msg\"; exit 1 }",
    '$LIVE_BASE_COMMIT = "773ce09f6d90421e1627adb2a9f951e400b2664f"',
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

test("the steps are in the load-bearing order, there is no migration or D1 step, wrangler is used once (the stamped deploy), and no guest write is made", () => {
  const order = ["BEGIN-PIN-CHECK", "git fetch origin", "BEGIN-REVIEWED-SOURCE-CHECK", "BEGIN-GATES", 'Read-Attest "before the deploy"', "if ($DryRun)", "BEGIN-DEPLOY-AND-POLL", "Test-RootServed $rootNow", 'Read-Attest "after the deploy"'];
  let last = -1;
  for (const needle of order) {
    const i = script.indexOf(needle.startsWith("BEGIN-") ? "# " + needle : needle);
    assert.ok(i > last, `${needle} comes after the previous step`);
    last = i;
  }
  assert.equal(/\bd1\b|migrations apply|execute --remote/i.test(code.replace(/migrations\b/g, "").replace(/schema\.sql/g, "")), false, "no D1 command");
  assert.equal((code.match(/= \(npx wrangler /g) ?? []).length, 1, "exactly one executed wrangler command (the other mentions are text in messages)");
  assert.match(code, /npx wrangler deploy --var "CODE_COMMIT:\$headSha"/);
  assert.equal(/Invoke-WebRequest|Invoke-RestMethod|-Method\s+Post|-X\s+POST/i.test(code), false, "no other HTTP client");
  assert.equal((code.match(/--data-binary/g) ?? []).length, 1, "exactly one POST site (the initialize call), its body passed from a file");
  assert.equal(code.includes("tools/call"), false, "no tool call: guest_enter and guest_comment write, and this ride makes neither");
  assert.equal(/api\/showhome\/enter|api\/guest\/comment|api\/showhome\/note/.test(code), false, "no guest write route is named in an executable line");
  assert.ok(code.includes('"/mcp", "/mcp/read"') && code.includes("Get-Instructions"), "the two initialisers are ridden");
});

test("the mint: the template must equal the REVIEWED commit's and differ from the live base's; v5 is required before, and after GET / (which writes the row) version 6, changed_by operator and the pinned v6 hash, with every chain ok", () => {
  assert.match(code, /if \(\$reviewedTemplate -cne \$headTemplate\) \{ Stop-Here/);
  assert.match(code, /if \(\$liveTemplate -ceq \$headTemplate\) \{ Stop-Here/);
  assert.ok(code.includes("migrations schema.sql"));
  assert.match(code, /\[string\]\$att\.constitution\.version -ne "5"/);
  assert.match(code, /\$att\.constitution\.template_hash -cne \$V5_HASH/);
  assert.match(code, /\[string\]\$att\.constitution\.version -ne "6"/);
  assert.match(code, /\[string\]\$att\.constitution\.changed_by -cne "operator"/);
  assert.match(code, /\$att\.constitution\.template_hash -cne \$V6_HASH/);
  for (const chain of ["identity_log", "treasury", "payouts", "ballots"]) assert.ok(code.includes(`"${chain}"`), `the ${chain} chain is checked`);
  assert.ok(at("Assert-AttestBefore $attBefore") < at("$deployOut = (npx wrangler deploy"), "v5 checked before");
  assert.ok(at("Assert-AttestAfter $attAfter") > at("$deployOut = (npx wrangler deploy"), "v6 checked after");
  assert.ok(at("$rootNow = Get-Text") < at("Assert-AttestAfter $attAfter"), "GET / is requested BEFORE the attestation is read, because that request writes the version row (F4)");
});

test("it proves the live worker IS the pinned base, proves the VISIT FIRST section absent before the deploy, and the poll needs the stamped commit AND the printed version id AND the v6 root", () => {
  assert.match(code, /\[string\]\$attBefore\.code\.commit -cne \$LIVE_BASE_COMMIT/);
  assert.match(code, /\$rollbackTarget = \[string\]\$attBefore\.code\.version_id/);
  assert.match(code, /Contains\(\$VISIT_HEADING\)\) \{ Stop-Here "GET \/ already carries the VISIT FIRST section/);
  assert.match(code, /\$why = Test-CodeIdentityServed \(Get-ServedCode\) \$commit \$versionId/);
  assert.match(code, /if \(\$why -eq ""\) \{ \$why = Test-RootServed/);
});

test("Test-RootServed, run for real, passes a v6 root and fails each way it can be wrong; Assert-AttestAfter passes version 6 / operator / the pinned hash and fails each other answer", (t) => {
  const fn = defs.slice(defs.indexOf("function Test-RootServed"), defs.indexOf("# Polls until the served block"));
  const good = "Commonhold\n\nVISIT FIRST, FREE\nMCP: guest_enter, front_page, guest_comment\n\nTHE CONSTITUTION\nit costs $1\nHOW TO JOIN (JSON API)\nHOW TO JOIN (MCP)";
  const cases: Array<[string, string, string, string]> = [
    ["good", good, "200", ""],
    ["notFound", good, "404", "answered 404"],
    ["noVisit", "Commonhold\n\nTHE CONSTITUTION guest_enter\nHOW TO JOIN (JSON API)\nHOW TO JOIN (MCP)", "200", "does not carry"],
    ["noGuest", "VISIT FIRST, FREE\nread freely\nTHE CONSTITUTION\nHOW TO JOIN (JSON API)\nHOW TO JOIN (MCP)", "200", "does not name guest_enter inside"],
    ["guestLate", "VISIT FIRST, FREE\nread freely\nTHE CONSTITUTION\nHOW TO JOIN (JSON API)\nguest_enter\nHOW TO JOIN (MCP)", "200", "only after 'THE CONSTITUTION'"],
    ["noMcpJoin", "VISIT FIRST, FREE guest_enter\nTHE CONSTITUTION\nHOW TO JOIN (JSON API)", "200", "no 'HOW TO JOIN (MCP)'"],
    ["afterDollar", "VISIT FIRST, FREE\nIt costs $1 once. guest_enter later.\nTHE CONSTITUTION\nHOW TO JOIN (JSON API)\nHOW TO JOIN (MCP)", "200", "after the first dollar-one"],
  ];
  const q = (s: string): string => "'" + s.replace(/'/g, "''").replace(/\n/g, "'+[char]10+'") + "'";
  const attFn = defs.slice(defs.indexOf("function Assert-AttestChains"), defs.indexOf("function Assert-AttestBefore")) + defs.slice(defs.indexOf("function Assert-AttestAfter"), defs.indexOf("# The `code` block"));
  const V6 = pin("V6_HASH");
  const att = (version: string, by: string, hash: string, ok = "$true"): string =>
    `(Assert-AttestAfter ([pscustomobject]@{ ok = ${ok}; constitution = [pscustomobject]@{ version = '${version}'; changed_by = '${by}'; template_hash = '${hash}' }; identity_log = [pscustomobject]@{ ok = $true }; treasury = [pscustomobject]@{ ok = $true }; payouts = [pscustomobject]@{ ok = $true }; ballots = [pscustomobject]@{ ok = $true } }) 'after')`;
  const lines = [
    "$ErrorActionPreference = 'Stop'",
    '$VISIT_HEADING = "VISIT FIRST, FREE"',
    `$V6_HASH = "${V6}"`,
    "function Stop-Here($msg) { Write-Output ('STOP ' + $msg); exit 0 }",
    fn,
    attFn,
    ...cases.map(([name, body, status]) => `Write-Host ("RESULT ${name} [" + (Test-RootServed @{ Code = '${status}'; Type = 'text/plain'; Body = (${q(body)}) }) + "]")`),
    `Write-Output 'ATT-GOOD'; ${att("6", "operator", V6)}; Write-Output 'ATT-GOOD-PASSED'`,
  ];
  const run = runPs(lines);
  if (!run) return t.skip("no PowerShell available");
  for (const [name, , , expect] of cases) {
    const m = new RegExp(`RESULT ${name} \\[(.*)\\]`).exec(run.out);
    assert.ok(m, `${name} produced a result: ${run.out}`);
    if (expect === "") assert.equal(m![1], "", `${name}: ${m![1]}`);
    else assert.ok(m![1].includes(expect), `${name}: '${m![1]}' mentions '${expect}'`);
  }
  assert.match(run.out, /ATT-GOOD-PASSED/, "a version-6 operator answer with the pinned hash passes");
  const bad: Array<[string, string, string]> = [
    ["version 5", att("5", "operator", V6), "expected 6"],
    ["genesis", att("6", "genesis", V6), "expected operator"],
    ["old hash", att("6", "operator", "fa11788d062b0c6d23c54c428c1c9649d263ae3ba704e602e122066926049491"), "expected v6"],
    ["chain broken", att("6", "operator", V6, "$false"), "expected true"],
  ];
  for (const [name, call2, expect] of bad) {
    const r = runPs([
      "$ErrorActionPreference = 'Stop'",
      `$V6_HASH = "${V6}"`,
      "function Stop-Here($msg) { Write-Output ('STOP ' + $msg); exit 0 }",
      attFn,
      call2,
      "Write-Output 'NOT-STOPPED'",
    ])!;
    assert.match(r.out, /STOP /, `${name}: stops`);
    assert.ok(r.out.includes(expect), `${name}: '${r.out.trim()}' mentions '${expect}'`);
    assert.equal(r.out.includes("NOT-STOPPED"), false, name);
  }
});

test("Get-TemplateText (run for real): it extracts FRONT_DOOR_TEMPLATE from the real src/doc.ts, showhomeDoorNote lies OUTSIDE it, an edit outside does not change it, a byte INSIDE does, a missing marker is null", (t) => {
  const fn = defs.slice(defs.indexOf("function Get-TemplateText"), defs.indexOf("# The status code, content type and body of a GET"));
  const docTs = readFileSync(here("../src/doc.ts"), "utf8").replace(/\r\n/g, "\n");
  const marker = "export const FRONT_DOOR_TEMPLATE = `";
  const start = docTs.indexOf(marker);
  assert.ok(start > 0);
  let i = start + marker.length;
  let end = -1;
  while (end < 0) {
    const j = docTs.indexOf("`", i);
    assert.ok(j > 0);
    if (docTs[j - 1] === "\\") i = j + 1;
    else end = j;
  }
  assert.ok(docTs.indexOf("export function showhomeDoorNote") > end, "showhomeDoorNote lies after the template");
  const outsideEdit = docTs.replace("export function showhomeDoorNote", "// an edit outside the template\nexport function showhomeDoorNote");
  const insideEdit = docTs.replace(marker, marker + "X");
  const dir = mkdtempSync(join(tmpdir(), "deploy-second-visit-tpl-"));
  try {
    writeFileSync(join(dir, "a.txt"), docTs);
    writeFileSync(join(dir, "b.txt"), outsideEdit);
    writeFileSync(join(dir, "c.txt"), insideEdit);
    const r = runPs([
      "$ErrorActionPreference = 'Stop'",
      fn,
      `$a = Get-TemplateText (Get-Content -Raw -Encoding UTF8 '${join(dir, "a.txt")}')`,
      `$b = Get-TemplateText (Get-Content -Raw -Encoding UTF8 '${join(dir, "b.txt")}')`,
      `$c = Get-TemplateText (Get-Content -Raw -Encoding UTF8 '${join(dir, "c.txt")}')`,
      "$e = Get-TemplateText 'no marker here'",
      "Write-Output ('LEN=' + $a.Length)",
      "Write-Output ('OUTSIDE-SAME=' + ($a -ceq $b))",
      "Write-Output ('INSIDE-DIFFERS=' + ($a -cne $c))",
      "Write-Output ('MISSING=' + ($null -eq $e))",
    ]);
    if (!r) return t.skip("no PowerShell available");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, new RegExp(`LEN=${end - start + 1}`));
    assert.match(r.out, /OUTSIDE-SAME=True/);
    assert.match(r.out, /INSIDE-DIFFERS=True/);
    assert.match(r.out, /MISSING=True/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Get-DisallowedPaths (run for real): only this script, its test and docs/ pass the allowlist", (t) => {
  const fn = defs.slice(defs.indexOf("function Get-DisallowedPaths"), defs.indexOf("# The FRONT_DOOR_TEMPLATE literal"));
  const r = runPs([
    "$ErrorActionPreference = 'Stop'",
    '$ALLOWED_PATHS_AFTER_REVIEW = @("scripts/deploy-second-visit.ps1", "test/deploy-second-visit-script.test.ts", "docs/")',
    fn,
    "$bad = @(Get-DisallowedPaths @('scripts/deploy-second-visit.ps1', 'test/deploy-second-visit-script.test.ts', 'docs/CHECKPOINT-SECOND-VISIT.md', 'src/doc.ts', 'migrations/0030_x.sql', 'docs', 'Docs/x.md', 'scripts/deploy-privacy.ps1'))",
    "Write-Output ('BAD=' + ($bad -join ','))",
  ]);
  if (!r) return t.skip("no PowerShell available");
  assert.match(r.out, /BAD=src\/doc\.ts,migrations\/0030_x\.sql,docs,Docs\/x\.md,scripts\/deploy-privacy\.ps1/);
});

test("every phrase the script waits for or rides is really served by the new code (in process, no network), and the pinned v6 hash is the built template's", async () => {
  const d1 = createLocalD1();
  seedCitizens(d1);
  try {
    const env = guestEnv(d1);
    const root = (await call(env, "GET", "/")).body._text as string;
    assert.ok(root.includes(pin("VISIT_HEADING")), "GET / carries the VISIT FIRST heading");
    assert.ok(root.indexOf(pin("VISIT_HEADING")) < root.indexOf("THE CONSTITUTION"));
    assert.equal((await computeLiveConstitutionPair()).templateHash, pin("V6_HASH"), "the script's v6 pin is the built template's hash");
    assert.equal((await call(env, "GET", "/api/attest")).body.constitution.template_hash, pin("V6_HASH"));
    const skill = (await call(env, "GET", "/skill.md")).body._text as string;
    assert.ok(skill.includes(pin("SKILL_VERSION_LINE")));
    for (const door of ["/mcp", "/mcp/read"]) {
      const r = await call(env, "POST", door, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } });
      assert.ok((r.body.result.instructions as string).includes(pin("RETURN_ADVICE")), door);
    }
    const llms = (await call(env, "GET", "/llms.txt")).body._text as string;
    assert.ok(llms.includes(pin("OPERATOR_HEADING")) && llms.includes(pin("OPERATOR_NOTE_PART")));
    const manifest = JSON.stringify((await call(env, "GET", "/.well-known/mcp.json")).body);
    assert.ok(manifest.includes(pin("OPERATOR_NOTE_PART")));
  } finally {
    d1.close();
  }
});
