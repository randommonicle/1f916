// scripts/deploy-refusal-list-2026-11-26.ps1 is WRITTEN AND NEVER RUN by this test (no deploy, no wrangler, not even -DryRun, which reads the live worker over HTTP). It is proven here by what can be
// proven without running it: it parses under PowerShell's own parser, is ASCII with LF endings, has none of the repo's PowerShell traps, has the load-bearing step order, no migration, no D1 command,
// a single deploy, step 0a stops on the placeholder before any git or network command, every Select-String literal is in its file, every constant the ride compares against is pinned to the
// source that serves it, L-167 is proven by running the real poll and retry, and every PowerShell function that reads the worker is RUN FOR REAL against a local HTTP server that wraps the REAL worker handlers
// (src/index.ts over a real local D1; the harness rewrites the script's $BASE to 127.0.0.1, and the test asserts it did), then against altered answers, one per judged item.
// The before-check is shown to FAIL against the real worker of this tree and to PASS against a simulated old worker (the list sentences stripped: the live base 9f7fe955), and the ride, over HTTP and over MCP on both doors, is shown to FAIL against that simulated base.
// The CF-RAY line (operator's ruling D-093 (5)) is run for real through Get-Text, Get-PostAnswer and Get-JsonPost against a local server that sends a cf-ray header and one that does not.
// Derived from test/deploy-above-head-code-2026-11-26-script.test.ts (deployed that morning), itself derived from test/deploy-inbox-params-2026-11-25-script.test.ts.
//
// Run: npm test

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { parsePowerShellFile } from "./helpers/ps-parse.ts";
import worker from "../src/index.ts";
import { createLocalD1, seedCitizens, guestEnv, freshIp, seedTopic, seedVisitor, guestComment, type LocalD1 } from "./helpers/guest.ts";
import { postGuestAnswer } from "../src/guest.ts";
import { INBOX_SECTION_LIMIT } from "../src/inbox.ts";
import type { Env } from "../src/society.ts";

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
const SCRIPT_PATH = here("../scripts/deploy-refusal-list-2026-11-26.ps1");
const rawScript = readFileSync(SCRIPT_PATH, "utf8");
const script = rawScript.replace(/\r\n/g, "\n");
const code = script.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
const defs = script.slice(script.indexOf('$ErrorActionPreference = "Stop"'), script.indexOf("# END-OF-DEFINITIONS"));
const pinBlock = script.slice(script.indexOf("# BEGIN-PIN-CHECK"), script.indexOf("# END-PIN-CHECK"));
const ride = script.slice(script.indexOf("# 4. the ride"));
const slice = (from: string, to: string): string => defs.slice(defs.indexOf(from), defs.indexOf(to));

// $LIVE_BASE_COMMIT is 9f7fe955 in full. $REVIEWED_COMMIT holds the placeholder TO-BE-SET-BY-HUB until the hub sets it; the pin test accepts the placeholder or 40 lower-case hex, and the hub tightens it to the sha it sets.
const LIVE = "9f7fe955e0f28459290d55943952cafe1fb61c89";
const SRC = (f: string): string => readFileSync(here(`../src/${f}`), "utf8");
const INBOX_SRC = SRC("inbox.ts");
const DISCOVERY_SRC = SRC("discovery.ts");
const SOCIETY_SRC = SRC("society.ts");
const INDEX_SRC = SRC("index.ts");

const realFetch = globalThis.fetch;
globalThis.fetch = (async () => new Response("rpc stubbed in test", { status: 500 })) as typeof fetch;
after(() => {
  globalThis.fetch = realFetch;
});

const before = (a: number, b: number, msg: string): void => {
  assert.ok(a >= 0 && b >= 0, `${msg} (both anchors must be present: ${a}, ${b})`);
  assert.ok(a < b, msg);
};
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
const lit = (name: string): string => new RegExp(`^\\$${name} = "(.*)"$`, "m").exec(script)![1];
const litSingle = (name: string): string => new RegExp(`^\\$${name} = '(.*)'$`, "m").exec(script)![1];

function runPs(lines: string[]): { code: number | null; out: string } | null {
  const dir = mkdtempSync(join(tmpdir(), "deploy-inbox-"));
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
function runPsAsync(lines: string[]): Promise<{ code: number | null; out: string } | null> {
  const dir = mkdtempSync(join(tmpdir(), "deploy-inbox-"));
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
const POWERSHELL = spawnSync("powershell", ["-NoProfile", "-Command", "1"], { encoding: "utf8" }).status === 0;

// ---------- static ----------

test("the script and its test are ASCII only with LF line endings, and the script parses under PowerShell's own parser with zero errors", (t) => {
  assert.equal(/[^\x00-\x7f]/.test(rawScript), false, "ASCII only");
  assert.equal(rawScript.includes("\r"), false, "the script is LF");
  assert.equal(readFileSync(fileURLToPath(import.meta.url), "utf8").includes("\r"), false, "this test file is LF");
  assert.equal(/[^\x00-\x7f]/.test(readFileSync(fileURLToPath(import.meta.url), "utf8")), false, "this test file is ASCII");
  const parsed = parsePowerShellFile(SCRIPT_PATH);
  if (!parsed.available) return t.skip(`${parsed.reason}; the static checks still run`);
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
    const b = code.slice(0, m.index);
    assert.ok(b.lastIndexOf('$ErrorActionPreference = "Continue"') > b.lastIndexOf('$ErrorActionPreference = "Stop"'));
  }
  assert.equal(/\$\w+\s*\|\s*Where-Object[^\n]*-notmatch/.test(code), false);
});

test("the pins: v6 hash, the live base 9f7fe955 in full, the reviewed pin a placeholder or 40 hex, the allowlist is the script, its test and the gate record, the parameters", () => {
  assert.match(script, /^\$V6_HASH = "dc5f48213c29bcf844e0fbe7daf1bdb5416b3d57fbd06a8bd03f1061f34092b3"$/m);
  assert.match(script, new RegExp(`^\\$LIVE_BASE_COMMIT = "${LIVE}"$`, "m"));
  assert.match(script, /^\$LIVE_BASE_PLACEHOLDER = "TO-BE-SET-BY-HUB-LIVE-BASE"$/m);
  // The reviewed pin is the placeholder until the hub sets it to the commit the review converged on, then 40 lower-case hex.
  const reviewed = /^\$REVIEWED_COMMIT = "(acf0eed0c70ec4c4eae1281b4db9858249626cab)"$/m.exec(script);
  assert.ok(reviewed, "the reviewed pin is the placeholder or 40 lower-case hex");
  assert.match(script, /^\$REVIEWED_COMMIT_PLACEHOLDER = "TO-BE-SET-BY-HUB"$/m);
  assert.match(script, /^\$ALLOWED_PATHS_AFTER_REVIEW = @\("scripts\/deploy-refusal-list-2026-11-26\.ps1", "test\/deploy-refusal-list-2026-11-26-script\.test\.ts", "docs\/REVIEW-REFUSAL-LIST-GATE-2026-11-26\.md"\)$/m);
  assert.match(script, /\[Parameter\(Mandatory = \$true\)\]\[string\]\$ExpectedCommit/);
  assert.match(script, /\[switch\]\$DryRun/);
  const git = (a: string[]): { status: number | null; out: string } => {
    const r = spawnSync("git", ["-C", here(".."), ...a], { encoding: "utf8" });
    return { status: r.status, out: r.stdout.trim() };
  };
  assert.equal(git(["cat-file", "-t", LIVE]).out, "commit");
  assert.equal(git(["merge-base", "--is-ancestor", LIVE, "HEAD"]).status, 0, "this tree contains the live base (HEAD is the wave on top of it)");
  if (/^[0-9a-f]{40}$/.test(reviewed![1])) {
    assert.equal(git(["cat-file", "-t", reviewed![1]]).out, "commit");
    assert.equal(git(["merge-base", "--is-ancestor", LIVE, reviewed![1]]).status, 0);
    assert.equal(git(["merge-base", "--is-ancestor", reviewed![1], "HEAD"]).status, 0);
  }
  assert.ok(script.includes("the base check is EQUALITY again") && script.includes("Live = origin/main = local main = that commit"), "the header says the base check is equality again, live = origin/main = local main");
  assert.equal(script.includes("origin/main is AHEAD of live"), false, "the ancestry wording of the 25 Nov script is gone");
  // Equality is the check: the live worker's attested commit is compared with the pin by -cne in step 2 (the stop list below pins the condition); ancestry only says HEAD sits on top of it.
  assert.ok(code.includes("[string]$attBefore.code.commit -cne $LIVE_BASE_COMMIT"));
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
  // The script as committed holds the placeholder or a full sha, never a short one.
  assert.match(script, /^\$REVIEWED_COMMIT = "(acf0eed0c70ec4c4eae1281b4db9858249626cab)"$/m);
});

test("inbox gate C1, run for real: the session check passes this tree (whose comment names withSession) and STOPS on a call anywhere under src/", (t) => {
  const block = script.slice(script.indexOf("# BEGIN-SESSION-CHECK"), script.indexOf("# END-SESSION-CHECK"));
  const runIn = (dir: string) => runPs(["$ErrorActionPreference = 'Stop'", 'function Stop-Here($msg) { Write-Host "[STOP] $msg"; exit 1 }', `Set-Location "${dir}"`, block, 'Write-Host "[CLEAR]"']);
  const own = runIn(here(".."));
  if (!own) return t.skip("no PowerShell available");
  assert.match(own.out, /\[CLEAR\]/, own.out);
  const dir = mkdtempSync(join(tmpdir(), "inbox-session-"));
  try {
    mkdirSync(join(dir, "src", "deep"), { recursive: true });
    writeFileSync(join(dir, "src", "a.ts"), "// withSession (a comment)\n");
    assert.match(runIn(dir)!.out, /\[CLEAR\]/);
    writeFileSync(join(dir, "src", "deep", "b.ts"), 'const s = env.DB.withSession("first-primary");\n');
    const stopped = runIn(dir)!;
    assert.equal(stopped.code, 1);
    assert.match(stopped.out, /\[STOP\] src\/ calls withSession \(1 place\(s\), first b\.ts\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// A stop whose condition is weakened or removed still parses and still says its message, so the conditions themselves are pinned, in order.
const sel = (file: string, pattern: string, simple = true): string => `-not (Select-String -Path "${file}" -Pattern ${pattern}${simple ? " -SimpleMatch" : ""} -Quiet)`;
test("every stop in the body fires on exactly its reviewed condition", () => {
  const body = code.slice(code.indexOf("if ($LIVE_BASE_COMMIT -ceq $LIVE_BASE_PLACEHOLDER)"));
  const one = [...body.matchAll(/^ *if \((.*)\) \{ Stop-Here /gm)].map((m) => m[1]);
  const block = [...body.matchAll(/^if \((.*)\) \{\n  Stop-Here /gm)].map((m) => m[1]);
  assert.deepEqual(one, [
    "$LIVE_BASE_COMMIT -ceq $LIVE_BASE_PLACEHOLDER",
    "$LIVE_BASE_COMMIT -cnotmatch '^[0-9a-f]{40}$'",
    "$REVIEWED_COMMIT -ceq $REVIEWED_COMMIT_PLACEHOLDER",
    "$REVIEWED_COMMIT -cnotmatch '^[0-9a-f]{40}$'",
    "$ExpectedCommit -cnotmatch '^[0-9a-f]{40}$'",
    "$LASTEXITCODE -ne 0",
    "$branch -cne \"main\"",
    "$expectedCode -ne 0 -or -not $expectedSha",
    "$headSha -cnotmatch '^[0-9a-f]{40}$'",
    "$LASTEXITCODE -ne 0",
    "$dirty.Count -gt 0",
    "$LASTEXITCODE -ne 0",
    "$LASTEXITCODE -ne 0",
    "$moves.Count -gt 0",
    "$sessionUses.Count -gt 0",
    "$LASTEXITCODE -ne 0",
    "$LASTEXITCODE -ne 0",
    "$unreviewed.Count -gt 0",
    sel("src/index.ts", '"assertInboxQuery(url.searchParams)"'),
    sel("src/index.ts", '"assertGuestInboxQuery(url.searchParams)"'),
    sel("src/inbox.ts", '"repeated_query_parameter"'),
    sel("src/inbox.ts", '"export const IGNORED_CREDENTIAL_ARGS"'),
    sel("src/mcp.ts", '"assertInboxArgs(args)"'),
    sel("src/mcp.ts", '"assertGuestInboxArgs(args)"'),
    sel("src/mcp-read.ts", '"assertInboxArgs(args)"'),
    sel("src/mcp-read.ts", '"assertGuestInboxArgs(args)"'),
    sel("src/inbox.ts", "'At most ${INBOX_SECTION_LIMIT} candidate rows of each table'"),
    sel("src/listings.ts", '"This request issued no payment requirements"'),
    sel("src/listings.ts", '"This request settled nothing."'),
    sel("src/inbox.ts", '"function refuseAboveHead("'),
    sel("src/inbox.ts", '"cursor_above_head"'),
    sel("src/discovery.ts", '"cursor_above_head"'),
    sel("src/inbox.ts", '"Over HTTP three refusals of this route carry a code"'),
    sel("src/code-identity.ts", '"export function codeBlock"', false),
    sel("wrangler.jsonc", "'\"version_metadata\"'", false),
    "Select-String -Path \"wrangler.jsonc\" -Pattern '\"CODE_COMMIT\"' -Quiet",
    "$failLine.Count -lt 1 -or $passLine.Count -lt 1",
    "$testCode -ne 0 -or $failN -ne \"0\" -or $passN -eq \"0\"",
    "$tscCode -ne 0",
    "$null -eq $attBefore.code -or [string]$attBefore.code.commit_status -cne \"stamped\"",
    "[string]$attBefore.code.commit -ceq $headSha",
    "[string]$attBefore.code.commit -cne $LIVE_BASE_COMMIT",
    "$visitorNumber -ceq \"\"",
    "$listWhy -ne \"\"",
    "$LASTEXITCODE -ne 0 -or $headNow -cne $headSha",
    "$LASTEXITCODE -ne 0",
    "$dirtyNow.Count -gt 0",
    "$deployCode -ne 0",
    "$versionMatches.Count -gt 1",
    "$versionMatches.Count -lt 1",
    "$whyAttest -ne \"\"",
    "$whyRotate -ne \"\"",
    "$whyWallet -ne \"\"",
    "$whyCursor -ne \"\"",
    "$whyAbove -ne \"\"",
    "$whyRoutes -ne \"\"",
    "$whyMcp -ne \"\"",
    "$whyDocs -ne \"\"",
    "$whySweep -ne \"\"",
  ]);
  assert.deepEqual(block, ["$mainSha -cne $originSha -or $mainSha -cne $expectedSha -or $headSha -cne $expectedSha"]);
  assert.equal(body.split("Stop-Here").length - 1, one.length + block.length, "no other stop, and none without a condition");
});

test("the steps are in the load-bearing order, there is no migration, no D1 command and no clock refusal, the deploy is the only wrangler command, and the only POSTs are the refusal POSTs and the JSON-RPC bodies", () => {
  const order = ["BEGIN-PIN-CHECK", "git fetch origin", "BEGIN-REVIEWED-SOURCE-CHECK", "BEGIN-GATES", 'Read-Attest "before the deploy"', "$visitorNumber = Get-VisitorNumber", "$listWhy = Test-ListAbsent", "if ($DryRun)", "BEGIN-DEPLOY-AND-POLL", "$whyAttest = Confirm-Reads", "$whyRotate", "$whyWallet", "$whyCursor", "$whyAbove", "$whyRoutes", "$whyMcp", "$whyDocs", "$whySweep"];
  let last = -1;
  for (const needle of order) {
    const i = script.indexOf(needle.startsWith("BEGIN-") ? "# " + needle : needle);
    assert.ok(i > last, `${needle} comes after the previous step`);
    last = i;
  }
  assert.equal(/migrations apply/i.test(code), false, "no migration apply");
  assert.equal(/d1 execute|Invoke-Bounded|D1_SQL_ARG|--remote|wrangler d1/i.test(code), false, "no D1 command, no bounded command runner, no SQL");
  assert.equal(/migtest|scratch/i.test(code), false, "no scratch database in the executable code");
  assert.equal(/Test-ClockWindow|Get-UtcNow|BEGIN-CLOCK-CHECK/.test(script), false, "nothing in this ride depends on the UTC day");
  assert.equal((code.match(/= \(npx wrangler /g) ?? []).length, 1, "exactly one executed wrangler command");
  assert.equal((code.match(/(?:^|= \(|[;{|&])[ \t]*npx wrangler /gm) ?? []).length, 1, "no other executed wrangler command, assigned or not");
  assert.match(code, /npx wrangler deploy --var "CODE_COMMIT:\$headSha"/);
  assert.equal(/Invoke-WebRequest|Invoke-RestMethod|-Method\s+Post/i.test(code), false, "no PowerShell web cmdlets; every HTTP call is curl.exe");
  assert.equal((code.match(/"-X", "POST"/g) ?? []).length, 1, "exactly one bodiless POST sender, Get-PostAnswer");
  assert.equal((code.match(/\bGet-PostAnswer\b/g) ?? []).length, 3, "one definition and the two calls in Test-RouteRefusals");
  assert.equal((code.match(/--data-binary/g) ?? []).length, 1, "exactly one request body sender: Get-JsonPost");
  assert.ok(code.includes('"-w", "%{http_code}|%header{cf-ray}", "-H", "Content-Type: application/json", "--data-binary", ("@" + $req), $url)'), "the JSON body goes from a temp file");
  assert.equal((code.match(/\bGet-JsonPost\b/g) ?? []).length, 10, "one definition, one tools/list in Test-ToolsListSchemas and eight tools/call in Test-McpTools");
  assert.equal((code.match(/\bBearer\b/g) ?? []).length, 1, "one Bearer, the non-credential");
  assert.equal(/ch1\.|guest_comment|showhome_note|resident_(bind|token)|api\/council\/(challenge|claim|ballot)/.test(code), false, "no credential and no write tool");
  assert.equal(/"name":"(?!inbox"|guest_inbox")/.test(code), false, "the only tools named in a tools/call body are inbox and guest_inbox");
  assert.ok(code.includes("src/doc.ts") && code.includes("migrations schema.sql"), "the no-mint and no-migration check names src/doc.ts, migrations and schema.sql");
  assert.ok(code.includes("git merge-base --is-ancestor $LIVE_BASE_COMMIT HEAD"), "HEAD must contain the live base");
  assert.ok(code.includes("[string]$attBefore.code.commit -cne $LIVE_BASE_COMMIT"), "the live worker is proven to be the pinned base");
  for (const step of ["$visitorNumber = Get-VisitorNumber", "$listWhy = Test-ListAbsent"]) {
    before(code.indexOf(step), code.indexOf("if ($DryRun)"), `${step} runs before the dry-run exit`);
  }
  assert.equal(/\bPOST\b/.test(script.slice(script.indexOf('Say "[dry-run]'), script.indexOf("exit 0", script.indexOf('Say "[dry-run]')))) && /sent NO POST/.test(script), true, "the dry run says it sends no POST");
});

test("curl.exe is called in exactly three places, Get-Text, Get-PostAnswer and Get-JsonPost, each with the cf-ray header read; no other function calls it", () => {
  assert.equal((code.match(/curl\.exe/g) ?? []).length, 3, "three calls of curl.exe in all");
  const fn = (name: string): string => {
    const start = defs.indexOf(`function ${name}(`);
    return braceBlock(defs, defs.indexOf("{", start));
  };
  for (const name of ["Get-Text", "Get-PostAnswer", "Get-JsonPost"]) {
    const body = fn(name);
    assert.equal((body.match(/curl\.exe/g) ?? []).length, 1, `${name} calls curl.exe once`);
    assert.ok(body.includes("%header{cf-ray}"), `${name} reads the cf-ray header with curl's own -w`);
    assert.ok(body.includes("Format-RayLine"), `${name} logs the ray line`);
  }
  assert.equal((code.match(/%header\{cf-ray\}/g) ?? []).length, 3, "the ray is read in those three only");
  assert.equal((code.match(/\bFormat-RayLine\b/g) ?? []).length, 4, "one definition and three callers");
});

test("the source checks name literals the checkout carries, and every Select-String literal is in its file", () => {
  let n = 0;
  for (const m of code.matchAll(/Select-String -Path "([^"]+)" -Pattern ('[^']+'|"[^"]+")/g)) {
    if (m[1] === "wrangler.jsonc") continue;
    const l = m[2].slice(1, -1);
    assert.ok(readFileSync(here(`../${m[1]}`), "utf8").includes(l), `${m[1]} carries '${l}'`);
    n++;
  }
  assert.equal(n, 16, `checked ${n} literals (one per item: the routes, the tools on both doors, the cap, the two pay wordings, plus refuseAboveHead, the code in inbox.ts and in discovery.ts, the list sentence, and codeBlock)`);
  assert.ok(readFileSync(here("../src/listings.ts"), "utf8").includes("This request settled nothing. That does not establish the outcome of an earlier or overlapping signed payment"), "the reservation refusal wording");
});

test("the constants the ride compares against are the served ones: the 400 texts, the tool refusals, the cap sentences, the route sentences, the bodies, the property names", () => {
  // The two route refusals, from the template in src/inbox.ts.
  assert.ok(INBOX_SRC.includes('"Unknown query parameter${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. ${route} accepts only: ${list}. Nothing was read; remove the parameter and call again."'.replace(/^"|"$/g, "").replace(/"/g, '"')) || INBOX_SRC.includes("`Unknown query parameter${unknown.length > 1 ? \"s\" : \"\"}: ${unknown.join(\", \")}. ${route} accepts only: ${list}. Nothing was read; remove the parameter and call again.`"));
  assert.ok(INBOX_SRC.includes('"unknown_query_parameter"') && INBOX_SRC.includes('"repeated_query_parameter"'));
  assert.ok(INBOX_SRC.includes("`Repeated query parameter${repeated.length > 1 ? \"s\" : \"\"}: ${repeated.join(\", \")}. ${route} accepts each of ${list} at most once.`"));
  assert.ok(INBOX_SRC.includes('export const INBOX_PARAMS = ["handle", "since", "cursor"] as const;') && INBOX_SRC.includes('export const GUEST_INBOX_PARAMS = ["guest", "cursor"] as const;'));
  assert.ok(INBOX_SRC.includes('assertKnownQuery(params, INBOX_PARAMS, "GET /api/inbox")') && INBOX_SRC.includes('assertKnownQuery(params, GUEST_INBOX_PARAMS, "GET /api/guest/inbox")'));
  assert.equal(lit("CODE_UNKNOWN"), "unknown_query_parameter");
  assert.equal(lit("CODE_REPEATED"), "repeated_query_parameter");
  assert.equal(lit("ERR_INBOX_LIMIT"), "Unknown query parameter: limit. GET /api/inbox accepts only: handle, since, cursor. Nothing was read; remove the parameter and call again.");
  assert.equal(lit("ERR_INBOX_SECRET"), lit("ERR_INBOX_LIMIT").replace("limit", "secret"));
  assert.equal(lit("ERR_INBOX_REPEATED"), "Repeated query parameter: handle. GET /api/inbox accepts each of handle, since, cursor at most once.");
  assert.equal(lit("ERR_GUEST_LIMIT"), "Unknown query parameter: limit. GET /api/guest/inbox accepts only: guest, cursor. Nothing was read; remove the parameter and call again.");
  assert.equal(lit("ERR_GUEST_REPEATED"), "Repeated query parameter: guest. GET /api/guest/inbox accepts each of guest, cursor at most once.");
  // The tool refusals.
  assert.ok(INBOX_SRC.includes("`Unknown argument${unknown.length > 1 ? \"s\" : \"\"} for ${tool}: ${unknown.join(\", \")}. The ${tool} tool accepts only: ${list} (${ignored.join(\" and \")} are ignored if sent). Nothing was read.`"));
  assert.ok(INBOX_SRC.includes('export const IGNORED_CREDENTIAL_ARGS = ["secret", "token"] as const;'));
  assert.equal(lit("ERR_TOOL_INBOX"), "Unknown argument for inbox: limit. The inbox tool accepts only: handle, since, cursor (secret and token are ignored if sent). Nothing was read.");
  assert.equal(lit("ERR_TOOL_GUEST"), "Unknown argument for guest_inbox: limit. The guest_inbox tool accepts only: guest, cursor (secret and token are ignored if sent). Nothing was read.");
  assert.equal(lit("TOOL_EXCEPTION_SENTENCE"), "except secret and token, which this tool does not need and ignores if sent");
  assert.equal((SRC("mcp.ts").match(/except secret and token, which this tool does not need and ignores if sent\./g) ?? []).length, 2, "both tool descriptions carry the exception sentence");
  assert.equal(lit("INBOX_TOOL_PROPS"), "cursor,handle,since");
  assert.equal(lit("GUEST_TOOL_PROPS"), "cursor,guest");
  // The cap sentences, built from the constant.
  assert.equal(INBOX_SECTION_LIMIT, 100);
  assert.equal(lit("CAP_CITIZEN_SENTENCE"), `At most ${INBOX_SECTION_LIMIT} candidate rows of each table (comments, posts and guest_thread) are taken for one page; that counts candidate rows, not items delivered, and ballots is outside it.`);
  assert.equal(lit("CAP_GUEST_SENTENCE"), `At most ${INBOX_SECTION_LIMIT} candidate rows of each table (guest_thread, comments and posts) are taken for one page; that counts candidate rows, not items delivered, and duties is outside it.`);
  assert.ok(INBOX_SRC.includes("At most ${INBOX_SECTION_LIMIT} candidate rows of each table (comments, posts and guest_thread) are taken for one page; that counts candidate rows, not items delivered, and ballots is outside it."));
  assert.ok(INBOX_SRC.includes("At most ${INBOX_SECTION_LIMIT} candidate rows of each table (guest_thread, comments and posts) are taken for one page; that counts candidate rows, not items delivered, and duties is outside it."));
  // The route sentences: discovery.ts is the one place, and it serves them on /openapi.json, /llms.txt and /api/surface.
  // The route sentences are read from the source at test time (not typed here): each carries the old 25 Nov text, then the above-head sentences.
  assert.ok(DISCOVERY_SRC.includes(lit("ROUTE_SENTENCE_INBOX")) && DISCOVERY_SRC.includes(lit("ROUTE_SENTENCE_GUEST")));
  assert.ok(lit("ROUTE_SENTENCE_INBOX").startsWith("Accepts only handle, since and cursor, each at most once;") && lit("ROUTE_SENTENCE_GUEST").startsWith("Accepts only guest and cursor, each at most once;"));
  assert.ok(lit("ROUTE_SENTENCE_INBOX").includes("cursor_above_head") && lit("ROUTE_SENTENCE_GUEST").includes("cursor_above_head"), "both route sentences carry the above-head code (a regression of this morning)");
  assert.equal(DISCOVERY_SRC.split(lit("ROUTE_SENTENCE_INBOX")).length - 1, 1);
  assert.equal(DISCOVERY_SRC.split(lit("ROUTE_SENTENCE_GUEST")).length - 1, 1);
  // The cursor_note sentence of both inbox notes, read from the source: the same sentence once in each note.
  assert.equal(INBOX_SRC.split(lit("NOTE_SENTENCE")).length - 1, 2, "src/inbox.ts carries the note sentence in both cursor_notes");
  assert.ok(lit("NOTE_SENTENCE").includes("cursor_above_head"));
  // The refusal-list sentences (D-094 note 26 Nov), read from the source at test time: once in the route's own cursor_note, right after the above-head sentence, and never in the other route's.
  const LC = lit("LIST_SENTENCE_CITIZEN");
  const LG = lit("LIST_SENTENCE_GUEST");
  assert.equal(INBOX_SRC.split(LC).length - 1, 1, "src/inbox.ts carries the citizen list sentence once");
  assert.equal(INBOX_SRC.split(LG).length - 1, 1, "src/inbox.ts carries the guest list sentence once");
  assert.equal(INBOX_SRC.split(lit("LIST_FRAGMENT")).length - 1, 2, "the before-state fragment is in both list sentences and nowhere else");
  assert.ok(LC.startsWith(lit("LIST_FRAGMENT")) && LG.startsWith(lit("LIST_FRAGMENT")), "the fragment opens both sentences");
  assert.equal(INBOX_SRC.split(lit("NOTE_SENTENCE") + " " + LC).length - 1, 1, "the citizen list follows the above-head sentence");
  assert.equal(INBOX_SRC.split(lit("NOTE_SENTENCE") + " " + LG).length - 1, 1, "the guest list follows the above-head sentence");
  assert.notEqual(LC, LG);
  assert.ok(LC.includes("a missing or malformed handle") && LG.includes("a missing or malformed guest number"), "each list names its own route's parameters");
  assert.ok(lit("LIST_SENTENCE_CITIZEN").endsWith("fix what it names and call again.") && LG.endsWith("fix what it names and call again."));
  assert.ok(readFileSync(here("../docs/HEARTBEAT-SKILL-TEXT.md"), "utf8").replace(/\r\n/g, "\n").includes(LC), "the citizen list is mirrored in docs/HEARTBEAT-SKILL-TEXT.md");
  assert.equal(lit("CODE_ABOVE_HEAD"), "cursor_above_head");
  assert.ok(INBOX_SRC.includes('"cursor_above_head"'), "refuseAboveHead throws the code");
  assert.ok(INBOX_SRC.includes('comments: "comment"') && INBOX_SRC.includes('guest_thread: "guest row"') && lit("CITIZEN_ABOVE_PART") === "comment" && lit("GUEST_ABOVE_PART") === "guest row");
  // The tools drop SocietyError.code: the tool error is the message only, on both doors.
  for (const f of ["mcp.ts", "mcp-read.ts"]) assert.ok(SRC(f).includes("JSON.stringify({ error: e.message })"), `${f}: a tool refusal is { error } only`);
  assert.equal(lit("ABOVE_ID"), "999999");
  assert.equal(lit("CITIZEN_ABOVE_CURSOR"), "c999999-p0-g0");
  assert.equal(lit("GUEST_ABOVE_CURSOR"), "g999999-c0-p0");
  // The JSON-RPC bodies.
  assert.deepEqual(JSON.parse(litSingle("TOOLS_LIST_BODY")), { jsonrpc: "2.0", id: 1, method: "tools/list" });
  const callBody = (name: string, args: unknown) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  const NOT = lit("NOT_A_SECRET");
  assert.equal(NOT, "commonhold-ride-not-a-credential");
  assert.deepEqual(JSON.parse(litSingle("INBOX_BODY_LIMIT")), callBody("inbox", { handle: "commonhold-agent", since: 0, limit: 1 }));
  assert.deepEqual(JSON.parse(litSingle("INBOX_BODY_SECRET")), callBody("inbox", { handle: "commonhold-agent", since: 0, secret: NOT, token: NOT }));
  assert.deepEqual(JSON.parse(litSingle("INBOX_BODY_PLAIN")), callBody("inbox", { handle: "commonhold-agent", since: 0 }));
  const g = (tail: string) => JSON.parse(litSingle("GUEST_BODY_HEAD") + "7" + tail);
  assert.deepEqual(g(litSingle("GUEST_TAIL_LIMIT")), callBody("guest_inbox", { guest: 7, limit: 1 }));
  assert.deepEqual(g(litSingle("GUEST_TAIL_SECRET")), callBody("guest_inbox", { guest: 7, secret: NOT, token: NOT }));
  assert.deepEqual(g(litSingle("GUEST_TAIL_PLAIN")), callBody("guest_inbox", { guest: 7 }));
  assert.deepEqual(JSON.parse(litSingle("INBOX_BODY_ABOVE")), callBody("inbox", { handle: "commonhold-agent", cursor: lit("CITIZEN_ABOVE_CURSOR") }));
  assert.deepEqual(g(litSingle("GUEST_TAIL_ABOVE")), callBody("guest_inbox", { guest: 7, cursor: lit("GUEST_ABOVE_CURSOR") }));
  assert.equal(NOT.startsWith("commonhold_sk_") || NOT.startsWith("ch1."), false, "not a secret's shape and not an assertion");
  assert.equal(/[^a-z-]/.test(NOT), false, "plain, so PowerShell 5.1 passes it to curl.exe unchanged");
  // The routes the refusals and the reads ride.
  assert.equal(lit("HEADS_URL"), "$BASE/api/inbox?handle=commonhold-agent&since=9999999999999");
  assert.equal(lit("PROPOSALS_LIMIT_URL"), "$BASE/api/proposals?limit=1");
  assert.equal(lit("CURSOR_NOTE_SENTENCE"), "A part above the newest row of its table is refused");
  assert.equal(INBOX_SRC.split(lit("CURSOR_NOTE_SENTENCE")).length - 1, 2, "both cursor_notes carry the 24 Nov sentence the cursor ride looks for");
  assert.ok(INBOX_SRC.includes('refuseAboveHead("pass since=<ms> instead of cursor to start again"') && lit("CITIZEN_RESTART_TAIL") === "or pass since=<ms> instead of cursor to start again.");
  assert.ok(INBOX_SRC.includes('refuseAboveHead("omit cursor to start again"') && lit("GUEST_RESTART_TAIL") === "omit cursor to start again.");
  assert.ok(INBOX_SRC.includes("cursor's ${CURSOR_PART_NAMES[table]} id is ${startId}, above the newest one here (${head})."));
  assert.equal(lit("NO_CREDENTIALS_PREFIX"), "No credentials. Register first");
  const auth = SOCIETY_SRC.slice(SOCIETY_SRC.indexOf("export async function authenticate("), SOCIETY_SRC.indexOf("export async function authenticate(") + 3000);
  assert.ok(auth.includes(`throw new SocietyError(401, "${lit("NO_CREDENTIALS_PREFIX")}`));
  assert.ok(auth.includes(`throw new SocietyError(401, "${lit("UNKNOWN_SECRET_TEXT")}")`));
  assert.ok(INDEX_SRC.includes('path === "/api/wallet" && method === "POST"') && !/"\/api\/wallet"[^\n]*method === "GET"/.test(INDEX_SRC), "the wallet route is POST only");
  assert.ok(INDEX_SRC.includes('path === "/api/rotate" && method === "POST"'), "the rotate route is POST only");
  // The closing note's door figures.
  assert.match(script, /^\$MCP_CALLS_PER_READ = 8$/m);
  assert.match(script, /^\$MCP_LISTS_PER_READ = 1$/m);
});

test("L-167 is structural: every post-deploy check goes through Confirm-Reads, the closing note names the unridden item and the door additions, and the sweep names 17 paths", () => {
  const sites = confirmReadsBlocks(ride);
  assert.equal((ride.match(/= Confirm-Reads /g) ?? []).length, 9, "attest, rotate, wallet, cursor ride, above-head ride, routes, tools, documents, sweep");
  assert.equal(sites.sites, 9);
  for (const b of sites.blocks) assert.ok(b.length > 0, "every Confirm-Reads call has a block");
  const rideStops = [...ride.matchAll(/Stop-Here \(([^\n]*)\)/g)];
  assert.deepEqual([rideStops.length, ride.split("Stop-Here").length - 1], [9, 9], "every stop in the ride is one this test reads");
  assert.ok(rideStops.every((m) => !/is not live: "/.test(m[1])), "no ride stop names the rollback for a version that is NOT live");
  assert.equal(rideStops.filter((m) => !/deployments list/.test(m[1])).length, 0, "every ride stop says to read the deployments list by hand");
  for (const m of rideStops) {
    const text = m[1];
    const roll = text.indexOf("$ROLLBACK_LINE");
    if (roll >= 0) assert.ok(text.indexOf("deployments list") >= 0 && text.indexOf("deployments list") < roll, "the rollback is named only after 'read the deployments list'");
  }
  assert.ok(script.includes("WHAT IT DID NOT PROVE:") && script.includes("PAY_REFUSED_BEFORE_402") && script.includes("NOT RIDDEN"), "the closing note and the header say the pay wording is not ridden");
  assert.ok(code.includes("$mcpCallsMin = $MCP_CALLS_PER_READ * $GOOD_READS_NEEDED") && code.includes("$mcpListsMin = $MCP_LISTS_PER_READ * $GOOD_READS_NEEDED") && code.includes("$mcpPostsMin = 2 * ($mcpCallsMin + $mcpListsMin)"), "the door additions are computed from the reads the ride makes");
  const sweep = /^\$sweepPaths = @\((.*)\)$/m.exec(script)![1].split(",").map((s) => s.trim());
  assert.deepEqual(sweep, ['"/"', '"/operators"', '"/api/official"', '"/openapi.json"', '"/treasury"', '"/api/listings"', '"/api/stats"', '"/api/topics"', '"/api/guest/due"', '"/api/citizens"', '"/api/council"', '"/api/residents"', '"/heartbeat.md"', '"/skill.md"', '"/llms.txt"', '"/privacy"', '"/api/proposal/8"'], "the 17 public reads, none dropped");
  // Each ride step judges with its own function. Mutation that reddens this: point the above-head step at the before-state check.
  for (const [v, fn] of [["whyCursor", "Test-CursorRide $visitorNumber"], ["whyAbove", "Test-AboveHeadRide $visitorNumber"], ["whyRoutes", "Test-RouteParams $visitorNumber"], ["whyDocs", "Test-RouteSentencesServed"], ["whyRotate", 'Test-RouteRefusals $ROTATE_URL "/api/rotate"'], ["whyWallet", 'Test-RouteRefusals $WALLET_URL "/api/wallet"']] as const) {
    assert.ok(ride.includes(`$${v} = Confirm-Reads { return (${fn}) }`), `${v} judges with ${fn}`);
  }
  assert.ok(ride.includes('$w = Test-McpTools "/mcp" $visitorNumber; if ($w -ne "") { return $w }; return (Test-McpTools "/mcp/read" $visitorNumber)'));
  const confirmBody = slice("function Confirm-Reads", "# Polls until");
  assert.match(confirmBody, /Confirm-Reads/);
  assert.equal(/Stop-Here|exit \d|ROLL ?BACK/i.test(confirmBody), false, "the retry itself neither stops nor names a remedy");
});

// ---------- L-167 run for real ----------

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
];

test("L-167, the poll run for real: one stale read does not decide it, three good reads in a row do, and the rollback is named only by the exhausted poll", (t) => {
  const pass = runPs([...fakes(["good", "bad", "good", "good", "good"]), `Wait-NewWorker '${COMMIT}' '${VERSION}' 24 0`, 'Write-Host "[WAITED]"']);
  if (!pass) return t.skip("no PowerShell available");
  assert.equal(pass.code, 0, pass.out);
  assert.match(pass.out, /\[WAITED\]/);
  assert.match(pass.out, /try 2 of 24: not yet/);
  assert.match(pass.out, /try 5 of 24: good read 3 of 3/);
  assert.equal(pass.out.includes("ROLLBACK-NAMED"), false);
  const exhausted = runPs([...fakes(["good", "good", "bad", "good", "good", "bad"]), `Wait-NewWorker '${COMMIT}' '${VERSION}' 6 0`, 'Write-Host "[WAITED]"'])!;
  assert.equal(exhausted.code, 1);
  assert.equal(/\[WAITED\]/.test(exhausted.out), false);
  const stop = exhausted.out.indexOf("[STOP]");
  assert.ok(stop > 0 && exhausted.out.indexOf("ROLLBACK-NAMED") > stop);
  assert.match(exhausted.out, /deployments list[^\n]*by hand first|by hand first[^\n]*deployments list/);
});

test("L-167, the retry run for real: a stale read resets the run, a bounded run passes, a run that never forms returns the last reason, and it never stops or names a remedy", (t) => {
  const retry = slice("# L-167. Runs the check", "# Polls until");
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
  assert.match(flaky.out, /RESULT \[\] reads 6/);
  assert.match(runPs(lines('"404"', 4))!.out, /RESULT \[404\] reads 4/);
  assert.match(runPs(lines('if ($script:k -eq 3) { "stale" } else { "" }', 4))!.out, /RESULT \[only 1 good read\(s\) in a row of the 3 needed\] reads 4/);
});

// ---------- the real worker over a local HTTP server ----------

interface Seen {
  method: string;
  path: string;
  body: string;
}
interface Ans {
  status: number;
  headers: Record<string, string>;
  body: string;
}
interface Fixture {
  intercept?: (s: Seen) => Ans | undefined;
  after?: (s: Seen, res: Ans) => Ans | undefined;
  seed?: (env: Env, d1: LocalD1) => Promise<void>;
  seen?: Seen[];
}
const jsonAns = (o: unknown, status = 200): Ans => ({ status, headers: { "content-type": "application/json" }, body: JSON.stringify(o) });
const mutateJson = (res: Ans, fn: (j: any) => void): Ans => {
  const j = JSON.parse(res.body);
  fn(j);
  return { ...res, body: JSON.stringify(j) };
};

async function withWave<T>(fx: Fixture, run: (port: number, d1: LocalD1, env: Env) => Promise<T>): Promise<T> {
  const d1 = createLocalD1();
  seedCitizens(d1);
  const env = guestEnv(d1);
  if (fx.seed) await fx.seed(env, d1);
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (d) => chunks.push(d));
    req.on("end", async () => {
      const method = String(req.method);
      const path = String(req.url);
      const seen: Seen = { method, path, body: Buffer.concat(chunks).toString("utf8") };
      fx.seen?.push(seen);
      let ans = fx.intercept?.(seen);
      if (!ans) {
        const pending: Promise<unknown>[] = [];
        const headers: Record<string, string> = { "CF-Connecting-IP": freshIp() };
        if (typeof req.headers["content-type"] === "string") headers["content-type"] = req.headers["content-type"];
        if (typeof req.headers.authorization === "string") headers.authorization = req.headers.authorization;
        const r = await worker.fetch(new Request(`http://127.0.0.1:${(server.address() as { port: number }).port}${path}`, { method, headers, body: method === "GET" || method === "HEAD" ? undefined : seen.body }), env, { waitUntil: (p: Promise<unknown>) => pending.push(p), passThroughOnException: () => {} } as unknown as ExecutionContext);
        await Promise.all(pending);
        const out: Record<string, string> = {};
        r.headers.forEach((v, k) => {
          if (k !== "content-length" && k !== "content-encoding" && k !== "transfer-encoding") out[k] = v;
        });
        ans = { status: r.status, headers: out, body: await r.text() };
        ans = fx.after?.(seen, ans) ?? ans;
      }
      res.writeHead(ans.status, ans.headers);
      res.end(ans.body);
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

// The script's own definitions with $BASE pointed at the local server. The replace is asserted: a harness that kept the live URL would reach the real worker.
const LIVE_BASE_LINE = '$BASE = "https://commonhold.randommonicle.workers.dev"';
const localDefs = (port: number): string => {
  assert.ok(defs.includes(LIVE_BASE_LINE), "the script's $BASE line is the one the harness rewrites");
  const d = defs.replace(LIVE_BASE_LINE, `$BASE = "http://127.0.0.1:${port}"`);
  assert.equal(d.includes("randommonicle"), false, "no live URL survives in the harness");
  return d;
};
const harness = (port: number, tail: string[]): string[] => ["$ErrorActionPreference = 'Stop'", localDefs(port), "function Start-Sleep { }", ...tail];
// Runs the PowerShell lines against the fixture and returns what each `RES <label> [<reason>]` line said.
async function res(fx: Fixture, tail: string[]): Promise<{ out: string; at: (label: string) => string }> {
  return withWave(fx, async (port) => {
    const r = await runPsAsync(harness(port, tail));
    const out = r ? r.out : "NO-POWERSHELL";
    return { out, at: (label: string) => new RegExp(`^RES ${label} \\[(.*)\\]\\s*$`, "m").exec(out)?.[1] ?? `<<no RES ${label} line: ${out.slice(0, 600)}>>` };
  });
}
const R = (label: string, expr: string): string => `Write-Host ("RES ${label} [" + (${expr}) + "]")`;

// A world with every row the ride reads: a critique answered (so GET /api/guest/due lists it), and a comment.
const worldSeed = (extra?: (d1: LocalD1) => void) => async (env: Env, d1: LocalD1): Promise<void> => {
  const topic = seedTopic(d1);
  const v = await seedVisitor(d1, "wren");
  const g = await guestComment(env, v.token, { post_id: topic, body: "a critique", kind: "critique" });
  assert.equal(g.status, 201, JSON.stringify(g.body));
  const answered = await postGuestAnswer(env, { id: 1, handle: "commonhold-agent", model: "claude-fable-5" }, { guest_comment_id: g.body.comment_id as string, body: "An answer long enough to count: it names the critique, says what the society will and will not change, and gives the reason." });
  assert.ok(answered.body, "the critique was answered, so GET /api/guest/due lists it in its history");
  d1.raw.prepare("INSERT INTO comments (post_id, parent_id, citizen_id, body, depth, author_model, created_at) VALUES (?, NULL, 2, 'a comment', 0, 'test-model', ?)").run(topic, Date.now());
  extra?.(d1);
};
const WORLD: Fixture = { seed: worldSeed() };

// The simulated OLD worker is the live base 9f7fe955 (the above-head code wave of this morning): everything is served as the real worker serves it EXCEPT the refusal-list sentences, which are stripped from every cursor_note.
// `keep.note` names the routes ("citizen", "guest") whose cursor_note keeps its list, so one step at a time can be altered.
const LIST_CITIZEN = lit("LIST_SENTENCE_CITIZEN");
const LIST_GUEST = lit("LIST_SENTENCE_GUEST");
const toBase = (note: string): string => note.split(" " + LIST_CITIZEN).join("").split(" " + LIST_GUEST).join("");
const oldWorker = (keep: { note?: string[] } = {}): Fixture["after"] => (s, r) => {
  const p = s.path.split("?")[0];
  const which = p === "/api/inbox" ? "citizen" : p === "/api/guest/inbox" ? "guest" : "";
  if (which && r.status === 200 && !(keep.note ?? []).includes(which)) {
    return mutateJson(r, (j) => {
      if (typeof j.cursor_note === "string") j.cursor_note = toBase(j.cursor_note);
    });
  }
  return undefined;
};
const OLD: Fixture = { seed: worldSeed(), after: oldWorker() };
// Two alterations in a row: `a` first, then `b` on what `a` made.
const then = (a: Fixture["after"], b: Fixture["after"]): Fixture["after"] => (s, r) => {
  const x = a!(s, r) ?? r;
  return b!(s, x) ?? x;
};
// The whole base as the ride meets it: the HTTP reads above AND every successful tool answer on both MCP doors with the list stripped from its cursor_note (the tools serve the same note).
const baseWorker: Fixture["after"] = (s, r) => {
  const http = oldWorker()(s, r);
  if (http) return http;
  if (s.method === "POST" && (s.path === "/mcp" || s.path === "/mcp/read") && r.status === 200 && s.body.includes('"tools/call"')) {
    return mutateJson(r, (j) => {
      const text = j?.result?.content?.[0]?.text;
      if (j?.result?.isError === true || typeof text !== "string") return;
      const inner = JSON.parse(text);
      if (typeof inner.cursor_note === "string") {
        inner.cursor_note = toBase(inner.cursor_note);
        j.result.content[0].text = JSON.stringify(inner);
      }
    });
  }
  return undefined;
};
const BASE_FULL: Fixture = { seed: worldSeed(), after: baseWorker };
// One route's cursor_note altered: `fn` gets the note and returns the new one.
const noteOf = (route: "citizen" | "guest", fn: (note: string) => string): Fixture["after"] => (s, r) => {
  const p = s.path.split("?")[0];
  if (p !== (route === "citizen" ? "/api/inbox" : "/api/guest/inbox") || r.status !== 200) return undefined;
  return mutateJson(r, (j) => {
    j.cursor_note = fn(String(j.cursor_note));
  });
};
// The cap sentence stripped from the cursor_note of one route or both (the 25 Nov regression check must notice it).
const stripCap = (which: "citizen" | "guest" | "both"): Fixture["after"] => (s, r) => {
  const p = s.path.split("?")[0];
  const isCit = p === "/api/inbox";
  const isGst = p === "/api/guest/inbox";
  if (r.status !== 200 || !((isCit && which !== "guest") || (isGst && which !== "citizen"))) return undefined;
  return mutateJson(r, (j) => {
    if (typeof j.cursor_note === "string") j.cursor_note = j.cursor_note.replace(/ At most \d+ candidate rows of each table[^.]*\./, "");
  });
};
// An above-head answer as THIS wave serves it, for a fixture that hands one back when the real worker would not.
const aboveAns = (part: string, tail: string, withCode = true): Ans => jsonAns({ ...(withCode ? { code: "cursor_above_head" } : {}), error: `cursor's ${part} id is 999999, above the newest one here (3). Pass next_cursor exactly as a previous response served it, or ${tail}.` }, 400);

test("Get-AttestReason, run for real: the good answer passes, and a wrong version, hash, flag or chain, or a flag that is a string, is a reason", async (t) => {
  if (!POWERSHELL) return t.skip("no PowerShell available");
  const V6 = lit("V6_HASH");
  const chains = (v: string) => `identity_log = @{ ok = ${v} }; treasury = @{ ok = $true }; payouts = @{ ok = $true }; ballots = @{ ok = $true }`;
  const att = (ok = "$true", first = "$true", version = "6", hash = V6) => `@{ constitution = @{ version = ${version}; template_hash = "${hash}" }; ok = ${ok}; ${chains(first)} }`;
  const r = (await runPsAsync([
    defs,
    R("good", `Get-AttestReason (${att()})`),
    R("flag", `Get-AttestReason (${att("$false")})`),
    R("flagString", `Get-AttestReason (${att('"true"')})`),
    R("flagOne", `Get-AttestReason (${att("1")})`),
    R("chain", `Get-AttestReason (${att("$true", "$false")})`),
    R("chainString", `Get-AttestReason (${att("$true", '"true"')})`),
    R("chainGone", `Get-AttestReason (@{ constitution = @{ version = 6; template_hash = "${V6}" }; ok = $true })`),
    R("version", `Get-AttestReason (${att("$true", "$true", "7")})`),
    R("hash", `Get-AttestReason (${att("$true", "$true", "6", V6.toUpperCase())})`),
    R("none", "Get-AttestReason $null"),
  ]))!;
  const at = (label: string): string => new RegExp(`^RES ${label} \\[(.*)\\]\\r?$`, "m").exec(r.out)?.[1] ?? `<<no ${label}: ${r.out}>>`;
  assert.equal(at("good"), "");
  for (const l of ["flag", "flagString", "flagOne"]) assert.match(at(l), /GET \/api\/attest ok is/, l);
  for (const l of ["chain", "chainString", "chainGone"]) assert.match(at(l), /chain identity_log ok is/, l);
  assert.match(at("version"), /constitution is version 7, expected 6/);
  assert.match(at("hash"), /template_hash is/);
  assert.match(at("none"), /unreadable/);
});

test("Get-DisallowedPaths, run for real: the allowlist is exact and case-sensitive, a docs file other than the gate record is refused, an empty change is clean", (t) => {
  const r = runPs([
    "$ErrorActionPreference = 'Stop'",
    defs,
    'Write-Host ("A [" + ((Get-DisallowedPaths @("scripts/deploy-refusal-list-2026-11-26.ps1", "test/deploy-refusal-list-2026-11-26-script.test.ts", "docs/REVIEW-REFUSAL-LIST-GATE-2026-11-26.md")) -join ",") + "]")',
    'Write-Host ("B [" + ((Get-DisallowedPaths @("src/inbox.ts", "docs/OTHER.md", "Scripts/deploy-refusal-list-2026-11-26.ps1", "scripts/deploy-refusal-list-2026-11-26.ps1.bak", "docs/REVIEW-WALLET-NOT-TREASURY-GATE-2026-11-24.md")) -join ",") + "]")',
    'Write-Host ("C [" + ((Get-DisallowedPaths @()) -join ",") + "]")',
  ]);
  if (!r) return t.skip("no PowerShell available");
  assert.match(r.out, /^A \[\]/m);
  assert.match(r.out, /^B \[src\/inbox\.ts,docs\/OTHER\.md,Scripts\/deploy-refusal-list-2026-11-26\.ps1,scripts\/deploy-refusal-list-2026-11-26\.ps1\.bak,docs\/REVIEW-WALLET-NOT-TREASURY-GATE-2026-11-24\.md\]/m);
  assert.match(r.out, /^C \[\]/m);
});

// ---------- CF-RAY ----------

const RAY = "a43b9ce3cb5eddce-LHR";
test("the CF-RAY line, run for real through Get-Text, Get-PostAnswer and Get-JsonPost: a server that sends cf-ray gets it in the line, one that does not gets none, a cut read and a refused connection get 000 none, and the query is printed as sent", async (t) => {
  if (!POWERSHELL) return t.skip("no PowerShell available");
  const intercept = (s: Seen): Ans | undefined => {
    const p = s.path.split("?")[0];
    if (p === "/ray" || p === "/rayp") return { status: 200, headers: { "content-type": "application/json", "cf-ray": RAY }, body: "{}" };
    if (p === "/rayj") return { status: 201, headers: { "content-type": "application/json", "cf-ray": RAY }, body: "{}" };
    if (p === "/noray" || p === "/norayp" || p === "/norayj") return { status: 200, headers: { "content-type": "application/json" }, body: "{}" };
    if (p === "/cut") return { status: 200, headers: { "content-type": "application/json", "cf-ray": RAY }, body: "{}" };
    return undefined;
  };
  const tail = [
    '$a = Get-Text "$BASE/ray?x=1&y=2" 20',
    '$b = Get-Text "$BASE/noray?x=1" 20',
    '$c = Get-PostAnswer "$BASE/rayp" ""',
    '$d = Get-PostAnswer "$BASE/norayp" "Bearer commonhold-ride-not-a-credential"',
    '$e = Get-JsonPost "$BASE/rayj" \'{"a":1}\'',
    '$f = Get-JsonPost "$BASE/norayj" \'{"a":1}\'',
    '$g = Get-Text "http://127.0.0.1:1/refused" 5',
    'Write-Host ("CODES " + $a.Code + " " + $b.Code + " " + $c.Code + " " + $d.Code + " " + $e.Code + " " + $f.Code + " " + $g.Code)',
    'Write-Host ("FMT " + (Format-RayLine "GET" "$BASE/p?q=1" "200" "  ") + " | " + (Format-RayLine "POST" "http://elsewhere.test/z" "404" "abc-LHR"))',
  ];
  const r = await res({ seed: worldSeed(), intercept }, tail);
  assert.match(r.out, new RegExp(`^\\[ray\\] GET /ray\\?x=1&y=2 -> 200 ${RAY}\\s*$`, "m"), r.out);
  assert.match(r.out, /^\[ray\] GET \/noray\?x=1 -> 200 none\s*$/m, r.out);
  assert.match(r.out, new RegExp(`^\\[ray\\] POST /rayp -> 200 ${RAY}\\s*$`, "m"), r.out);
  assert.match(r.out, /^\[ray\] POST \/norayp -> 200 none\s*$/m, r.out);
  assert.match(r.out, new RegExp(`^\\[ray\\] POST /rayj -> 201 ${RAY}\\s*$`, "m"), r.out);
  assert.match(r.out, /^\[ray\] POST \/norayj -> 200 none\s*$/m, r.out);
  assert.match(r.out, /^\[ray\] GET http:\/\/127\.0\.0\.1:1\/refused -> 000 none\s*$/m, r.out);
  assert.match(r.out, /^CODES 200 200 200 200 201 200 000\s*$/m, r.out);
  assert.match(r.out, /^FMT \[ray\] GET \/p\?q=1 -> 200 none \| \[ray\] POST http:\/\/elsewhere\.test\/z -> 404 abc-LHR\s*$/m, r.out);
});

test("Get-Text, run for real: an answer cut off after its 200 headers is a failed read (000, ray none) even though it sent a cf-ray, and a whole one is a 200 with its ray", async (t) => {
  if (!POWERSHELL) return t.skip("no PowerShell available");
  const server = createServer((req, res2) => {
    if (req.url === "/cut") {
      res2.writeHead(200, { "content-type": "application/json", "content-length": "100", "cf-ray": RAY });
      res2.write('{"a":1');
      setTimeout(() => res2.destroy(), 50);
      return;
    }
    res2.writeHead(200, { "content-type": "application/json", "cf-ray": RAY });
    res2.end('{"a":1}');
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  try {
    const port = (server.address() as { port: number }).port;
    const r = await runPsAsync([defs, `$cut = Get-Text "http://127.0.0.1:${port}/cut" 20`, `$whole = Get-Text "http://127.0.0.1:${port}/whole" 20`, 'Write-Host ("CUT [" + $cut.Code + "] WHOLE [" + $whole.Code + "]")']);
    assert.match(r!.out, /^CUT \[000\] WHOLE \[200\]\r?$/m, r!.out);
    assert.match(r!.out, /^\[ray\] GET http:\/\/127\.0\.0\.1:\d+\/cut -> 000 none\s*$/m, r!.out);
    assert.match(r!.out, new RegExp(`^\\[ray\\] GET http://127\\.0\\.0\\.1:\\d+/whole -> 200 ${RAY}\\s*$`, "m"), r!.out);
  } finally {
    server.close();
  }
});

// ---------- the before-state ----------

const CIT_RESTART = "pass since=<ms> instead of cursor to start again";
const GST_RESTART = "omit cursor to start again";
const CIT_ABOVE = (p: string): boolean => p === "/api/inbox?handle=commonhold-agent&cursor=c999999-p0-g0";
const GST_ABOVE = (p: string): boolean => /^\/api\/guest\/inbox\?guest=\d+&cursor=g999999-c0-p0$/.test(p);
const aboveBody = (part: string, tail: string): Record<string, unknown> => JSON.parse(aboveAns(part, tail, false).body);
const onPath = (pred: (p: string) => boolean, fn: (j: any) => void): Fixture["after"] => (s, r) => (pred(s.path) && r.status === 400 ? mutateJson(r, fn) : undefined);
const esc = (s: string): string => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

const abTail = [R("absent", "Test-ListAbsent (Get-VisitorNumber)")];
test("Test-ListAbsent, run for real: the REAL worker of this tree FAILS it (the list is live), the simulated old worker (the live base 9f7fe955) PASSES it, and every altered step has its own reason", async (t) => {
  if (!POWERSHELL) return t.skip("no PowerShell available");
  assert.match((await res(WORLD, abTail)).at("absent"), /the cursor_note of GET \/api\/inbox already carries 'Over HTTP three refusals of this route carry a code': the base is not what we think/);
  const old = await res(OLD, abTail);
  assert.equal(old.at("absent"), "", old.out);
  type Case = [string, Fixture, RegExp];
  const o = oldWorker();
  const NOTE = lit("NOTE_SENTENCE");
  const cases: Case[] = [
    ["the guest cursor_note already carries the list (citizen still base)", { seed: worldSeed(), after: oldWorker({ note: ["guest"] }) }, /the cursor_note of GET \/api\/guest\/inbox already carries 'Over HTTP three refusals of this route carry a code': the base is not what we think/],
    ["the citizen cursor_note lacks the above-head sentence of this morning", { seed: worldSeed(), after: then(o, noteOf("citizen", (n) => n.split(NOTE).join("x"))) }, /the cursor_note of GET \/api\/inbox does not carry the above-head sentence of 26 Nov: the base is not what we think/],
    ["the guest cursor_note lacks the above-head sentence of this morning", { seed: worldSeed(), after: then(o, noteOf("guest", (n) => n.split(NOTE).join("x"))) }, /the cursor_note of GET \/api\/guest\/inbox does not carry the above-head sentence of 26 Nov: the base is not what we think/],
    ["citizen since=0 answers a JSON 503", { seed: worldSeed(), after: o, intercept: (s) => (s.path === "/api/inbox?handle=commonhold-agent&since=0" ? jsonAns({ error: "x" }, 503) : undefined) }, /GET \/api\/inbox with since=0 answered 503, expected 200/],
    ["citizen since=0 is not JSON", { seed: worldSeed(), after: o, intercept: (s) => (s.path === "/api/inbox?handle=commonhold-agent&since=0" ? { status: 200, headers: { "content-type": "text/html" }, body: "<p>" } : undefined) }, /GET \/api\/inbox with since=0 was not JSON/],
    ["the plain guest inbox answers a JSON 503", { seed: worldSeed(), after: o, intercept: (s) => (/^\/api\/guest\/inbox\?guest=\d+$/.test(s.path) ? jsonAns({ error: "x" }, 503) : undefined) }, /GET \/api\/guest\/inbox answered 503, expected 200/],
    ["the plain guest inbox is not JSON", { seed: worldSeed(), after: o, intercept: (s) => (/^\/api\/guest\/inbox\?guest=\d+$/.test(s.path) ? { status: 200, headers: { "content-type": "text/html" }, body: "<p>" } : undefined) }, /GET \/api\/guest\/inbox was not JSON/],
  ];
  for (const [name, fx, re] of cases) assert.match((await res(fx, abTail)).at("absent"), re, name);
  assert.match((await res(WORLD, [R("absent", "Test-ListAbsent ''")])).at("absent"), /no visitor number could be read/);
  const none = await res({ seed: worldSeed(), after: o, intercept: (s) => (s.path.startsWith("/api/guest/due") ? jsonAns({ items: [] }) : undefined) }, abTail);
  assert.match(none.at("absent"), /no visitor number could be read from GET \/api\/guest\/due/);
});

// ---------- the above-head ride ----------

test("Test-AboveHeadText, run for real: the unchanged text passes, and a wrong part, id, head, guidance or tail each has its own reason", (t) => {
  const good = "cursor's comment id is 999999, above the newest one here (12). Pass next_cursor exactly as a previous response served it, or omit cursor to start again.";
  const r = runPs([
    "$ErrorActionPreference = 'Stop'",
    defs,
    `$good = "${good}"`,
    '$tail = "or omit cursor to start again."',
    'Write-Host ("RES good [" + (Test-AboveHeadText $good "L" "comment" $tail) + "]")',
    'Write-Host ("RES part [" + (Test-AboveHeadText $good "L" "post" $tail) + "]")',
    'Write-Host ("RES id [" + (Test-AboveHeadText ($good.Replace("999999", "900")) "L" "comment" $tail) + "]")',
    'Write-Host ("RES head [" + (Test-AboveHeadText ($good.Replace("(12)", "(none)")) "L" "comment" $tail) + "]")',
    'Write-Host ("RES guidance [" + (Test-AboveHeadText ($good.Replace("exactly as a previous", "as a previous")) "L" "comment" $tail) + "]")',
    'Write-Host ("RES tail [" + (Test-AboveHeadText ($good.Replace("start again.", "start over.")) "L" "comment" $tail) + "]")',
    'Write-Host ("RES short [" + (Test-AboveHeadText "x" "L" "comment" $tail) + "]")',
  ]);
  if (!r) return t.skip("no PowerShell available");
  const at = (label: string): string => new RegExp(`^RES ${label} \\[(.*)\\]\\r?$`, "m").exec(r.out)?.[1] ?? `<<no ${label}: ${r.out}>>`;
  assert.equal(at("good"), "");
  assert.match(at("part"), /expected it to start 'cursor's post id is 999999/);
  assert.match(at("id"), /expected it to start/);
  assert.match(at("head"), /expected the head in digits and the guidance/);
  assert.match(at("guidance"), /expected the head in digits and the guidance/);
  assert.match(at("tail"), /expected it to end 'or omit cursor to start again\.'/);
  assert.match(at("short"), /expected it to start/);
});

const aboveTail = [R("above", "Test-AboveHeadRide (Get-VisitorNumber)")];
test("Test-AboveHeadRide, run for real over the real worker: it passes; the simulated old worker (the live base) fails it at the citizen list sentence; every altered code, key, text, order, note and list has its own reason", async (t) => {
  if (!POWERSHELL) return t.skip("no PowerShell available");
  const good = await res(WORLD, aboveTail);
  assert.equal(good.at("above"), "", good.out);
  // the base passes the regression half (it serves the above-head code) and fails at the new check, the citizen list sentence first
  assert.match((await res(OLD, aboveTail)).at("above"), /the cursor_note of GET \/api\/inbox does not contain the refusal-list sentence 'Over HTTP three refusals of this route carry a code: .*fix what it names and call again\.'/);
  type Case = [string, Fixture, RegExp];
  const NOTE = lit("NOTE_SENTENCE");
  const baseGuest = oldWorker({ note: ["citizen"] });
  const stray = (pred: (p: string) => boolean, part: string, tail: string): Fixture["intercept"] => (s) => (pred(s.path) ? aboveAns(part, tail) : undefined);
  const cases: Case[] = [
    ["citizen code is another", { seed: worldSeed(), after: onPath(CIT_ABOVE, (j) => { j.code = "other"; }) }, /GET \/api\/inbox with an above-head cursor: the 400 code is 'other', expected 'cursor_above_head'/],
    ["citizen body has an extra key", { seed: worldSeed(), after: onPath(CIT_ABOVE, (j) => { j.extra = 1; }) }, /the 400 body has the keys 'code,error,extra', expected exactly 'code,error'/],
    ["guest code missing", { seed: worldSeed(), after: onPath(GST_ABOVE, (j) => { delete j.code; }) }, /GET \/api\/guest\/inbox with an above-head cursor: the 400 body has the keys 'error', expected exactly 'code,error'/],
    ["citizen text changed", { seed: worldSeed(), after: onPath(CIT_ABOVE, (j) => { j.error = j.error.replace("above the newest one here", "above the head"); }) }, /GET \/api\/inbox with an above-head cursor: the error is '.*', expected it to start/],
    ["citizen head is not a number", { seed: worldSeed(), after: onPath(CIT_ABOVE, (j) => { j.error = j.error.replace(/\(\d+\)/, "(x)"); }) }, /expected the head in digits and the guidance/],
    ["citizen tail changed", { seed: worldSeed(), after: onPath(CIT_ABOVE, (j) => { j.error = j.error.replace("start again.", "start over."); }) }, /GET \/api\/inbox with an above-head cursor: the error is '.*', expected it to end 'or pass since=<ms> instead of cursor to start again\.'/],
    ["guest guidance changed", { seed: worldSeed(), after: onPath(GST_ABOVE, (j) => { j.error = j.error.replace("Pass next_cursor exactly", "Pass cursor exactly"); }) }, /GET \/api\/guest\/inbox with an above-head cursor: the error is '.*', expected the head in digits and the guidance/],
    ["citizen: the above-head check wins over a stray parameter placed first", { seed: worldSeed(), intercept: stray((p) => p.startsWith("/api/inbox?limit=1&handle="), "comment", CIT_RESTART) }, /GET \/api\/inbox with limit=1 first and an above-head cursor: the 400 code is 'cursor_above_head', expected 'unknown_query_parameter'/],
    ["citizen: the above-head check wins over a stray parameter placed last", { seed: worldSeed(), intercept: stray((p) => p.startsWith("/api/inbox?") && p.endsWith("&cursor=c999999-p0-g0&limit=1"), "comment", CIT_RESTART) }, /GET \/api\/inbox with an above-head cursor and limit=1 last: the 400 code is 'cursor_above_head', expected 'unknown_query_parameter'/],
    ["guest: the above-head check wins over a stray parameter placed first", { seed: worldSeed(), intercept: stray((p) => p.startsWith("/api/guest/inbox?limit=1&guest="), "guest row", GST_RESTART) }, /GET \/api\/guest\/inbox with limit=1 first and an above-head cursor: the 400 code is 'cursor_above_head', expected 'unknown_query_parameter'/],
    ["guest: a stray parameter placed last is let through", { seed: worldSeed(), intercept: (s) => (s.path.startsWith("/api/guest/inbox?") && s.path.endsWith("&cursor=g999999-c0-p0&limit=1") ? jsonAns({ next_cursor: "g1-c1-p1" }) : undefined) }, /GET \/api\/guest\/inbox with an above-head cursor and limit=1 last answered 200, expected 400/],
    ["the citizen cursor_note lacks the list (the base)", { seed: worldSeed(), after: oldWorker({ note: ["guest"] }) }, /the cursor_note of GET \/api\/inbox does not contain the refusal-list sentence/],
    ["the citizen cursor_note carries the guest list", { seed: worldSeed(), after: noteOf("citizen", (n) => n.split(LIST_CITIZEN).join(LIST_GUEST)) }, /the cursor_note of GET \/api\/inbox does not contain the refusal-list sentence/],
    ["the citizen list lost its closing sentence", { seed: worldSeed(), after: noteOf("citizen", (n) => n.replace(" A prose-only refusal says nothing about checks it did not run, and a client that keeps only the first refusal never learns of a later failure: fix what it names and call again.", "")) }, /the cursor_note of GET \/api\/inbox does not contain the refusal-list sentence/],
    ["the citizen list lost its MCP sentence", { seed: worldSeed(), after: noteOf("citizen", (n) => n.replace(/ Over MCP no tool refusal carries a code or an HTTP status: [^.]*\./, "")) }, /the cursor_note of GET \/api\/inbox does not contain the refusal-list sentence/],
    ["the citizen cursor_note lost the above-head sentence", { seed: worldSeed(), after: noteOf("citizen", (n) => n.split(NOTE).join("x")) }, /the cursor_note of GET \/api\/inbox does not contain the above-head sentence/],
    ["the guest cursor_note lacks the list (the base)", { seed: worldSeed(), after: baseGuest }, /the cursor_note of GET \/api\/guest\/inbox does not contain the refusal-list sentence/],
    ["the guest cursor_note carries the citizen list", { seed: worldSeed(), after: noteOf("guest", (n) => n.split(LIST_GUEST).join(LIST_CITIZEN)) }, /the cursor_note of GET \/api\/guest\/inbox does not contain the refusal-list sentence/],
    ["the guest list lost its HTTP sentence", { seed: worldSeed(), after: noteOf("guest", (n) => n.replace(/ Over HTTP three refusals of this route carry a code: [^.]*\./, "")) }, /the cursor_note of GET \/api\/guest\/inbox does not contain the refusal-list sentence/],
    ["the guest cursor_note lost the above-head sentence", { seed: worldSeed(), after: noteOf("guest", (n) => n.split(NOTE).join("x")) }, /the cursor_note of GET \/api\/guest\/inbox does not contain the above-head sentence/],
    ["citizen since=0 down", { seed: worldSeed(), intercept: (s) => (s.path === "/api/inbox?handle=commonhold-agent&since=0" ? jsonAns({ error: "x" }, 503) : undefined) }, /GET \/api\/inbox with since=0 answered 503, expected 200/],
  ];
  for (const [name, fx, re] of cases) assert.match((await res(fx, aboveTail)).at("above"), re, name);
  assert.match((await res(WORLD, [R("above", "Test-AboveHeadRide ''")])).at("above"), /no visitor number could be read/);
});

// ---------- the cursor ride (regression) ----------

test("Test-CursorRide, run for real: the real worker passes it; the pre-24-Nov behaviour (every cursor 200) fails it at the first refusal; every altered step has its own reason", async (t) => {
  if (!POWERSHELL) return t.skip("no PowerShell available");
  const tail = [R("visitor", "Get-VisitorNumber"), "$vn = Get-VisitorNumber", R("ride", "Test-CursorRide $vn")];
  const live = await res(WORLD, tail);
  assert.match(live.at("visitor"), /^[1-9][0-9]*$/, "the visitor number came from GET /api/guest/due");
  assert.equal(live.at("ride"), "", live.out);
  const oldCursor: Fixture = { seed: worldSeed(), after: (s, r) => (/[?&]cursor=/.test(s.path) && r.status === 400 ? jsonAns({ handle: "x", next_cursor: "c0-p0", has_more: false, replies: [] }) : undefined) };
  assert.match((await res(oldCursor, tail)).at("ride"), /GET \/api\/inbox with comment id head\+1 answered 200, expected 400/);
  // a guest inbox page cut at the limit serves a comment part below the head: the ride must still pass (it would otherwise stop a good deploy)
  const cut: Fixture = { seed: worldSeed(), after: (s, r) => (/^\/api\/guest\/inbox\?guest=\d+$/.test(s.path) && r.status === 200 ? mutateJson(r, (j) => { j.has_more = true; j.next_cursor = j.next_cursor.replace(/-c(\d+)-/, (_: string, n: string) => { assert.ok(Number(n) > 0, "the fixture has a comment head"); return `-c${Number(n) - 1}-`; }); }) : undefined) };
  assert.equal((await res(cut, tail)).at("ride"), "", "a cut guest page");
  const ride2 = (name: string, fx: Fixture, re: RegExp) => ({ name, fx, re });
  const cases = [
    ride2("head cursor refused", { seed: worldSeed(), after: (s, r) => (/[?&]cursor=c(\d+)-p(\d+)-g(\d+)$/.test(s.path) && r.status === 200 && s.path.startsWith("/api/inbox?handle=commonhold-agent&cursor=") ? jsonAns({ error: "no" }, 400) : undefined) }, /GET \/api\/inbox with the head cursor itself answered 400, expected 200/),
    ride2("heads unreadable", { seed: worldSeed(), intercept: (s) => (s.path.startsWith("/api/inbox") && /since=9999999999999/.test(s.path) ? jsonAns({ next_cursor: "garbage" }) : undefined) }, /served next_cursor 'garbage', expected c<n>-p<n>/),
    ride2("wrong comment text", { seed: worldSeed(), after: (s, r) => (r.status === 400 && s.path.startsWith("/api/inbox") ? mutateJson(r, (j) => { j.error = j.error.replace("comment id", "comment number"); }) : undefined) }, /GET \/api\/inbox with comment id head\+1: the 400 error is 'cursor's comment number is 2/),
    ride2("wrong tail", { seed: worldSeed(), after: (s, r) => (r.status === 400 && s.path.startsWith("/api/inbox") ? mutateJson(r, (j) => { j.error = j.error.replace("start again.", "start over."); }) : undefined) }, /expected it to end 'or pass since=<ms> instead of cursor to start again\.'/),
    ride2("post not refused", { seed: worldSeed(), after: (s, r) => (/cursor=c\d+-p(\d+)/.test(s.path) && r.status === 400 && /above the newest one here/.test(r.body) && r.body.includes("post id") ? jsonAns({ next_cursor: "c1-p1" }) : undefined) }, /GET \/api\/inbox with post id head\+1 answered 200, expected 400/),
    ride2("guest part not refused", { seed: worldSeed(), after: (s, r) => (r.status === 400 && r.body.includes("guest row id") ? jsonAns({ next_cursor: "c1-p1" }) : undefined) }, /GET \/api\/inbox with guest row id head\+1 answered 200, expected 400/),
    ride2("cursor_note stripped", { seed: worldSeed(), after: (s, r) => (/since=0$/.test(s.path) ? mutateJson(r, (j) => { j.cursor_note = "no sentence here"; }) : undefined) }, /the cursor_note of GET \/api\/inbox with since=0 does not contain 'A part above the newest row of its table is refused'/),
    ride2("served cursor refused", { seed: worldSeed(), after: (s, r) => (/since=0$/.test(s.path) ? mutateJson(r, (j) => { j.next_cursor = "c999999-p999999"; }) : undefined) }, /GET \/api\/inbox with the next_cursor it served answered 400, expected 200/),
    ride2("guest inbox unknown visitor", { seed: worldSeed(), intercept: (s) => (s.path.startsWith("/api/guest/inbox") ? jsonAns({ error: "no" }, 404) : undefined) }, /GET \/api\/guest\/inbox\?guest=\d+ answered 404, expected 200/),
    ride2("guest cursor shape", { seed: worldSeed(), after: (s, r) => (/^\/api\/guest\/inbox\?guest=\d+$/.test(s.path) ? mutateJson(r, (j) => { j.next_cursor = "x"; }) : undefined) }, /served next_cursor 'x', expected g<n>-c<n>-p<n>/),
    ride2("guest above head not refused", { seed: worldSeed(), after: (s, r) => (s.path.startsWith("/api/guest/inbox") && r.status === 400 ? jsonAns({ next_cursor: "g1-c1-p1" }) : undefined) }, /GET \/api\/guest\/inbox with comment id head\+1 answered 200, expected 400/),
    ride2("guest wrong tail", { seed: worldSeed(), after: (s, r) => (s.path.startsWith("/api/guest/inbox") && r.status === 400 ? mutateJson(r, (j) => { j.error = j.error.replace("omit cursor to start again.", "something else."); }) : undefined) }, /GET \/api\/guest\/inbox with comment id head\+1: the 400 error is .*expected it to end 'omit cursor to start again\.'/),
  ];
  for (const c of cases) assert.match((await res(c.fx, tail)).at("ride"), c.re, c.name);
  const none = await res({ seed: worldSeed(), intercept: (s) => (s.path.startsWith("/api/guest/due") ? jsonAns({ items: [] }) : undefined) }, tail);
  assert.equal(none.at("visitor"), "");
  assert.match(none.at("ride"), /no visitor number could be read from GET \/api\/guest\/due/);
  const noGuestPart = await res({ seed: worldSeed(), after: (s, r) => (s.path.includes("since=9999999999999") ? mutateJson(r, (j) => { j.next_cursor = String(j.next_cursor).replace(/-g\d+$/, ""); }) : undefined) }, [R("ride", "Test-CursorRide '1'")]);
  assert.equal(noGuestPart.at("ride"), "", "with no guest part in the heads the guest-row step is skipped and the rest passes: " + noGuestPart.out);
});

// ---------- the routes ----------

const routeTail = [R("routes", "Test-RouteParams (Get-VisitorNumber)")];
const unrefuse = (pred: (path: string) => boolean): Fixture["after"] => (s, r) => (pred(s.path) && r.status === 400 && /"code":"(unknown|repeated)_query_parameter"/.test(r.body) ? jsonAns({ next_cursor: "c0-p0", has_more: false, cursor_note: "old" }) : undefined);
test("Test-RouteParams, run for real over the real worker: it passes; the live base (the 25 Nov wave) passes it too, as a regression; every altered refusal, text, code and cap sentence has its own reason", async (t) => {
  if (!POWERSHELL) return t.skip("no PowerShell available");
  const good = await res(WORLD, routeTail);
  assert.equal(good.at("routes"), "", good.out);
  assert.equal((await res(OLD, routeTail)).at("routes"), "", "the live base 9f7fe955 already serves the 25 Nov wave, so the regression ride passes on it");
  const lim = "&since=0&limit=1";
  type Case = [string, Fixture, RegExp];
  const cases: Case[] = [
    ["citizen limit not refused", { seed: worldSeed(), after: unrefuse((p) => p.startsWith("/api/inbox") && p.includes("limit=1")) }, /GET \/api\/inbox with limit=1 answered 200, expected 400/],
    ["guest limit not refused", { seed: worldSeed(), after: unrefuse((p) => p.startsWith("/api/guest/inbox") && p.includes("limit=1")) }, /GET \/api\/guest\/inbox with limit=1 answered 200, expected 400/],
    ["repeated handle not refused", { seed: worldSeed(), after: unrefuse((p) => p.startsWith("/api/inbox") && p.includes("handle=commonhold-agent&handle=")) }, /GET \/api\/inbox with a repeated handle answered 200, expected 400/],
    ["repeated guest not refused", { seed: worldSeed(), after: unrefuse((p) => /^\/api\/guest\/inbox\?guest=\d+&guest=/.test(p)) }, /GET \/api\/guest\/inbox with a repeated guest answered 200, expected 400/],
    ["secret on the query let through", { seed: worldSeed(), after: unrefuse((p) => p.includes("secret=")) }, /GET \/api\/inbox with secret on the query answered 200, expected 400/],
    ["the limit refusal has another code", { seed: worldSeed(), after: (s, r) => (s.path.includes(lim) && r.status === 400 ? mutateJson(r, (j) => { j.code = "bad_request"; }) : undefined) }, /GET \/api\/inbox with limit=1: the 400 code is 'bad_request', expected 'unknown_query_parameter'/],
    ["the limit refusal has other words", { seed: worldSeed(), after: (s, r) => (s.path.includes(lim) && r.status === 400 ? mutateJson(r, (j) => { j.error = "Nope."; }) : undefined) }, /GET \/api\/inbox with limit=1: the 400 error is 'Nope\.', expected 'Unknown query parameter: limit\./],
    ["the repeated refusal says unknown", { seed: worldSeed(), after: (s, r) => (s.path.includes("handle=commonhold-agent&handle=") && r.status === 400 ? mutateJson(r, (j) => { j.code = "unknown_query_parameter"; }) : undefined) }, /GET \/api\/inbox with a repeated handle: the 400 code is 'unknown_query_parameter', expected 'repeated_query_parameter'/],
    ["the guest refusal is not JSON", { seed: worldSeed(), intercept: (s) => (/^\/api\/guest\/inbox\?guest=\d+&limit=1$/.test(s.path) ? { status: 400, headers: { "content-type": "text/plain" }, body: "no" } : undefined) }, /GET \/api\/guest\/inbox with limit=1: the 400 was not JSON/],
    ["citizen since=0 down", { seed: worldSeed(), intercept: (s) => (s.path === "/api/inbox?handle=commonhold-agent&since=0" ? jsonAns({ error: "x" }, 503) : undefined) }, /GET \/api\/inbox with since=0 answered 503, expected 200/],
    ["citizen cap sentence missing", { seed: worldSeed(), after: stripCap("citizen") }, /the cursor_note of GET \/api\/inbox does not contain the cap sentence/],
    ["guest cap sentence missing", { seed: worldSeed(), after: stripCap("guest") }, /the cursor_note of GET \/api\/guest\/inbox does not contain the cap sentence/],
    ["guest inbox down", { seed: worldSeed(), intercept: (s) => (/^\/api\/guest\/inbox\?guest=\d+$/.test(s.path) ? jsonAns({ error: "x" }, 503) : undefined) }, /GET \/api\/guest\/inbox\?guest=\d+ answered 503, expected 200/],
    ["the proposals control now answers 200", { seed: worldSeed(), intercept: (s) => (s.path === "/api/proposals?limit=1" ? jsonAns({ proposals: [] }) : undefined) }, /GET \/api\/proposals\?limit=1 answered 200, expected it still to answer 400/],
  ];
  for (const [name, fx, re] of cases) assert.match((await res(fx, routeTail)).at("routes"), re, name);
  assert.match((await res(WORLD, [R("routes", "Test-RouteParams ''")])).at("routes"), /no visitor number could be read/);
});

// ---------- the tools ----------

const mcpTail = [R("mcp", "Test-McpTools '/mcp' (Get-VisitorNumber)"), R("read", "Test-McpTools '/mcp/read' (Get-VisitorNumber)")];
const toolAfter = (door: string, pred: (body: string) => boolean, fn: (j: any) => void): Fixture["after"] => (s, r) => (s.method === "POST" && s.path === door && pred(s.body) ? mutateJson(r, fn) : undefined);
const setText = (j: any, text: unknown): void => {
  j.result.content[0].text = typeof text === "string" ? text : JSON.stringify(text);
};
test("Test-McpTools, run for real over both doors of the real worker: it passes; every altered refusal, acceptance, schema and description has its own reason", async (t) => {
  if (!POWERSHELL) return t.skip("no PowerShell available");
  const good = await res(WORLD, mcpTail);
  assert.equal(good.at("mcp"), "", good.out);
  assert.equal(good.at("read"), "", good.out);
  const isInbox = (b: string) => b.includes('"name":"inbox"');
  const isGuest = (b: string) => b.includes('"name":"guest_inbox"');
  const hasLimit = (b: string) => b.includes('"limit"');
  const isAbove = (b: string) => b.includes("c999999-p0-g0") || b.includes("g999999-c0-p0");
  const hasSecret = (b: string) => b.includes('"secret"');
  const plain = (b: string) => !b.includes('"limit"') && !b.includes('"secret"') && !isAbove(b) && b.includes('"tools/call"');
  const list = (b: string) => b.includes('"tools/list"');
  type Case = [string, Fixture, string, RegExp];
  const cases: Case[] = [
    ["inbox limit not refused on /mcp", { seed: worldSeed(), after: toolAfter("/mcp", (b) => isInbox(b) && hasLimit(b), (j) => { delete j.result.isError; }) }, "mcp", /POST \/mcp inbox with limit was not refused: isError is not true/],
    ["inbox limit isError as a string", { seed: worldSeed(), after: toolAfter("/mcp", (b) => isInbox(b) && hasLimit(b), (j) => { j.result.isError = "true"; }) }, "mcp", /POST \/mcp inbox with limit was not refused/],
    ["inbox limit refused in other words", { seed: worldSeed(), after: toolAfter("/mcp", (b) => isInbox(b) && hasLimit(b), (j) => setText(j, { error: "Nope." })) }, "mcp", /POST \/mcp inbox with limit: the refusal is 'Nope\.', expected 'Unknown argument for inbox: limit\./],
    ["inbox limit refusal text not JSON", { seed: worldSeed(), after: toolAfter("/mcp", (b) => isInbox(b) && hasLimit(b), (j) => setText(j, "plain words")) }, "mcp", /POST \/mcp inbox with limit: the refusal text was not JSON/],
    ["inbox above-head cursor not refused on /mcp", { seed: worldSeed(), after: toolAfter("/mcp", (b) => isInbox(b) && isAbove(b), (j) => { delete j.result.isError; }) }, "mcp", /POST \/mcp inbox with an above-head cursor was not refused: isError is not true/],
    ["inbox above-head refusal carries a code key", { seed: worldSeed(), after: toolAfter("/mcp", (b) => isInbox(b) && isAbove(b), (j) => { const inner = JSON.parse(j.result.content[0].text); inner.code = "cursor_above_head"; setText(j, inner); }) }, "mcp", /POST \/mcp inbox with an above-head cursor: the refusal body has the keys 'code,error', expected exactly 'error' \(a tool refusal carries no code\)/],
    ["inbox above-head refused in other words", { seed: worldSeed(), after: toolAfter("/mcp/read", (b) => isInbox(b) && isAbove(b), (j) => setText(j, { error: "Nope." })) }, "read", /POST \/mcp\/read inbox with an above-head cursor: the error is 'Nope\.', expected it to start/],
    ["inbox above-head refusal text not JSON", { seed: worldSeed(), after: toolAfter("/mcp", (b) => isInbox(b) && isAbove(b), (j) => setText(j, "plain words")) }, "mcp", /POST \/mcp inbox with an above-head cursor: the refusal text was not JSON/],
    ["guest_inbox above-head cursor not refused on /mcp/read", { seed: worldSeed(), after: toolAfter("/mcp/read", (b) => isGuest(b) && isAbove(b), (j) => { delete j.result.isError; }) }, "read", /POST \/mcp\/read guest_inbox with an above-head cursor was not refused/],
    ["guest_inbox above-head refusal carries a code key", { seed: worldSeed(), after: toolAfter("/mcp/read", (b) => isGuest(b) && isAbove(b), (j) => { const inner = JSON.parse(j.result.content[0].text); inner.code = "cursor_above_head"; setText(j, inner); }) }, "read", /POST \/mcp\/read guest_inbox with an above-head cursor: the refusal body has the keys 'code,error'/],
    ["guest_inbox above-head tail changed", { seed: worldSeed(), after: toolAfter("/mcp", (b) => isGuest(b) && isAbove(b), (j) => { const inner = JSON.parse(j.result.content[0].text); inner.error = inner.error.replace("start again.", "start over."); setText(j, inner); }) }, "mcp", /POST \/mcp guest_inbox with an above-head cursor: the error is '.*', expected it to end 'omit cursor to start again\.'/],
    ["guest_inbox limit not refused on /mcp/read", { seed: worldSeed(), after: toolAfter("/mcp/read", (b) => isGuest(b) && hasLimit(b), (j) => { delete j.result.isError; }) }, "read", /POST \/mcp\/read guest_inbox with limit was not refused/],
    ["guest_inbox limit refused in other words", { seed: worldSeed(), after: toolAfter("/mcp", (b) => isGuest(b) && hasLimit(b), (j) => setText(j, { error: "Nope." })) }, "mcp", /POST \/mcp guest_inbox with limit: the refusal is 'Nope\./],
    ["inbox with secret and token refused", { seed: worldSeed(), after: toolAfter("/mcp", (b) => isInbox(b) && hasSecret(b), (j) => { j.result.isError = true; setText(j, { error: "Unknown argument for inbox: secret." }); }) }, "mcp", /POST \/mcp inbox with secret and token answered isError true: /],
    ["inbox with secret and token has no next_cursor", { seed: worldSeed(), after: toolAfter("/mcp/read", (b) => isInbox(b) && hasSecret(b), (j) => setText(j, { replies: [] })) }, "read", /POST \/mcp\/read inbox with secret and token carried no next_cursor/],
    ["inbox with secret and token answered by the old worker", { seed: worldSeed(), after: toolAfter("/mcp", (b) => isInbox(b) && hasSecret(b), (j) => setText(j, { next_cursor: "c1-p1", cursor_note: "Pass cursor=<next_cursor> on your next call, not since." })) }, "mcp", /POST \/mcp inbox with secret and token: the cursor_note does not contain the cap sentence/],
    ["inbox without them answered by the old worker (read door)", { seed: worldSeed(), after: toolAfter("/mcp/read", (b) => isInbox(b) && plain(b), (j) => setText(j, { next_cursor: "c1-p1" })) }, "read", /POST \/mcp\/read inbox without them: the cursor_note does not contain the cap sentence/],
    ["guest_inbox with secret and token answered by the old worker (read door)", { seed: worldSeed(), after: toolAfter("/mcp/read", (b) => isGuest(b) && hasSecret(b), (j) => setText(j, { next_cursor: "g0-c1-p1", cursor_note: "x" })) }, "read", /POST \/mcp\/read guest_inbox with secret and token: the cursor_note does not contain the cap sentence/],
    ["guest_inbox without them answered by the old worker", { seed: worldSeed(), after: toolAfter("/mcp", (b) => isGuest(b) && plain(b), (j) => setText(j, { next_cursor: "g0-c1-p1" })) }, "mcp", /POST \/mcp guest_inbox without them: the cursor_note does not contain the cap sentence/],
    ["inbox with secret and token answered as 9f7fe955 serves it", { seed: worldSeed(), after: toolAfter("/mcp", (b) => isInbox(b) && hasSecret(b), (j) => { const inner = JSON.parse(j.result.content[0].text); inner.cursor_note = toBase(String(inner.cursor_note)); setText(j, inner); }) }, "mcp", /POST \/mcp inbox with secret and token: the cursor_note does not contain the refusal-list sentence/],
    ["inbox without them answered as 9f7fe955 serves it (read door)", { seed: worldSeed(), after: toolAfter("/mcp/read", (b) => isInbox(b) && plain(b), (j) => { const inner = JSON.parse(j.result.content[0].text); inner.cursor_note = toBase(String(inner.cursor_note)); setText(j, inner); }) }, "read", /POST \/mcp\/read inbox without them: the cursor_note does not contain the refusal-list sentence/],
    ["guest_inbox with secret and token answered as 9f7fe955 serves it (read door)", { seed: worldSeed(), after: toolAfter("/mcp/read", (b) => isGuest(b) && hasSecret(b), (j) => { const inner = JSON.parse(j.result.content[0].text); inner.cursor_note = toBase(String(inner.cursor_note)); setText(j, inner); }) }, "read", /POST \/mcp\/read guest_inbox with secret and token: the cursor_note does not contain the refusal-list sentence/],
    ["guest_inbox without them answered as 9f7fe955 serves it", { seed: worldSeed(), after: toolAfter("/mcp", (b) => isGuest(b) && plain(b), (j) => { const inner = JSON.parse(j.result.content[0].text); inner.cursor_note = toBase(String(inner.cursor_note)); setText(j, inner); }) }, "mcp", /POST \/mcp guest_inbox without them: the cursor_note does not contain the refusal-list sentence/],
    ["guest_inbox answer carries the citizen list", { seed: worldSeed(), after: toolAfter("/mcp", (b) => isGuest(b) && plain(b), (j) => { const inner = JSON.parse(j.result.content[0].text); inner.cursor_note = String(inner.cursor_note).split(LIST_GUEST).join(LIST_CITIZEN); setText(j, inner); }) }, "mcp", /POST \/mcp guest_inbox without them: the cursor_note does not contain the refusal-list sentence/],
    ["inbox answer carries the guest list (read door)", { seed: worldSeed(), after: toolAfter("/mcp/read", (b) => isInbox(b) && hasSecret(b), (j) => { const inner = JSON.parse(j.result.content[0].text); inner.cursor_note = String(inner.cursor_note).split(LIST_CITIZEN).join(LIST_GUEST); setText(j, inner); }) }, "read", /POST \/mcp\/read inbox with secret and token: the cursor_note does not contain the refusal-list sentence/],
    ["inbox answer lost the above-head sentence", { seed: worldSeed(), after: toolAfter("/mcp", (b) => isInbox(b) && plain(b), (j) => { const inner = JSON.parse(j.result.content[0].text); inner.cursor_note = String(inner.cursor_note).split(lit("NOTE_SENTENCE")).join("x"); setText(j, inner); }) }, "mcp", /POST \/mcp inbox without them: the cursor_note does not contain the above-head sentence, so the regression of this morning is not held/],
    ["inbox without them answers 500", { seed: worldSeed(), intercept: (s) => (s.method === "POST" && s.path === "/mcp" && isInbox(s.body) && plain(s.body) ? jsonAns({ error: "x" }, 500) : undefined) }, "mcp", /POST \/mcp inbox without them answered 500, expected 200/],
    ["guest_inbox with secret and token refused", { seed: worldSeed(), after: toolAfter("/mcp/read", (b) => isGuest(b) && hasSecret(b), (j) => { j.result.isError = true; setText(j, { error: "x" }); }) }, "read", /POST \/mcp\/read guest_inbox with secret and token answered isError true/],
    ["guest_inbox without them has no result", { seed: worldSeed(), intercept: (s) => (s.method === "POST" && s.path === "/mcp" && isGuest(s.body) && plain(s.body) ? jsonAns({ jsonrpc: "2.0", id: 1, result: {} }) : undefined) }, "mcp", /POST \/mcp guest_inbox without them carried no result\.content/],
    ["tools/list: additionalProperties on inbox", { seed: worldSeed(), after: toolAfter("/mcp", list, (j) => { j.result.tools.find((x: any) => x.name === "inbox").inputSchema.additionalProperties = false; }) }, "mcp", /POST \/mcp tools\/list: the inbox inputSchema carries additionalProperties/],
    ["tools/list: additionalProperties on guest_inbox (read door)", { seed: worldSeed(), after: toolAfter("/mcp/read", list, (j) => { j.result.tools.find((x: any) => x.name === "guest_inbox").inputSchema.additionalProperties = true; }) }, "read", /POST \/mcp\/read tools\/list: the guest_inbox inputSchema carries additionalProperties/],
    ["tools/list: secret named in the inbox schema", { seed: worldSeed(), after: toolAfter("/mcp", list, (j) => { j.result.tools.find((x: any) => x.name === "inbox").inputSchema.properties.secret = { type: "string" }; }) }, "mcp", /the inbox properties are 'cursor,handle,secret,since', expected 'cursor,handle,since'/],
    ["tools/list: token named in the guest_inbox schema", { seed: worldSeed(), after: toolAfter("/mcp/read", list, (j) => { j.result.tools.find((x: any) => x.name === "guest_inbox").inputSchema.properties.token = { type: "string" }; }) }, "read", /the guest_inbox properties are 'cursor,guest,token', expected 'cursor,guest'/],
    ["tools/list: a property gone", { seed: worldSeed(), after: toolAfter("/mcp", list, (j) => { delete j.result.tools.find((x: any) => x.name === "inbox").inputSchema.properties.since; }) }, "mcp", /the inbox properties are 'cursor,handle', expected/],
    ["tools/list: the inbox description lacks the exception", { seed: worldSeed(), after: toolAfter("/mcp", list, (j) => { const t2 = j.result.tools.find((x: any) => x.name === "inbox"); t2.description = t2.description.replace("except secret and token, which this tool does not need and ignores if sent", "no exceptions"); }) }, "mcp", /the inbox description lacks 'except secret and token/],
    ["tools/list: the guest_inbox description lacks the exception (read door)", { seed: worldSeed(), after: toolAfter("/mcp/read", list, (j) => { const t2 = j.result.tools.find((x: any) => x.name === "guest_inbox"); t2.description = "x"; }) }, "read", /the guest_inbox description lacks/],
    ["tools/list: guest_inbox missing", { seed: worldSeed(), after: toolAfter("/mcp", list, (j) => { j.result.tools = j.result.tools.filter((x: any) => x.name !== "guest_inbox"); }) }, "mcp", /tools\/list lists 0 tools named guest_inbox, expected 1/],
    ["tools/list: inbox listed twice", { seed: worldSeed(), after: toolAfter("/mcp/read", list, (j) => { j.result.tools.push(j.result.tools.find((x: any) => x.name === "inbox")); }) }, "read", /tools\/list lists 2 tools named inbox, expected 1/],
    ["tools/list down", { seed: worldSeed(), intercept: (s) => (s.method === "POST" && s.path === "/mcp/read" && list(s.body) ? jsonAns({ error: "x" }, 502) : undefined) }, "read", /POST \/mcp\/read tools\/list answered 502, expected 200/],
  ];
  for (const [name, fx, label, re] of cases) assert.match((await res(fx, mcpTail)).at(label), re, name);
  assert.match((await res(WORLD, [R("mcp", "Test-McpTools '/mcp' ''")])).at("mcp"), /no visitor number could be read/);
  // The whole base 9f7fe955 over MCP, every tool answer of both doors with the list stripped: the ride must tell it from the new worker, on both doors, and the first tool answer it reads is the citizen's.
  const base = await res(BASE_FULL, mcpTail);
  assert.match(base.at("mcp"), /POST \/mcp inbox with secret and token: the cursor_note does not contain the refusal-list sentence, so this answer is not the new worker's/, base.out);
  assert.match(base.at("read"), /POST \/mcp\/read inbox with secret and token: the cursor_note does not contain the refusal-list sentence, so this answer is not the new worker's/, base.out);
  // The same base is what the HTTP half of the ride meets too.
  assert.match((await res(BASE_FULL, aboveTail)).at("above"), /does not contain the refusal-list sentence/);
});

test("the door arithmetic is true: one Test-McpTools call on one door is eight tools/call POSTs (four inbox, four guest_inbox) and one tools/list, and the real door counters count exactly those", async (t) => {
  if (!POWERSHELL) return t.skip("no PowerShell available");
  const seen: Seen[] = [];
  const fx: Fixture = { seed: worldSeed(), seen };
  const counts = await withWave(fx, async (port, d1) => {
    const r = await runPsAsync(harness(port, [R("mcp", "Test-McpTools '/mcp' (Get-VisitorNumber)")]));
    assert.match(r!.out, /^RES mcp \[\]\s*$/m, r!.out);
    const posts = seen.filter((s) => s.method === "POST");
    const rows = d1.raw.prepare("SELECT door, n FROM door_counts").all() as { door: string; n: number }[];
    return { posts, rows };
  });
  assert.equal(counts.posts.length, 9);
  assert.equal(counts.posts.filter((p) => p.body.includes('"tools/call"')).length, Number(/^\$MCP_CALLS_PER_READ = (\d+)$/m.exec(script)![1]));
  assert.equal(counts.posts.filter((p) => p.body.includes('"tools/list"')).length, Number(/^\$MCP_LISTS_PER_READ = (\d+)$/m.exec(script)![1]));
  const byDoor = Object.fromEntries(counts.rows.map((x) => [x.door, x.n]));
  assert.equal(byDoor["mcp_tool_call"], 8);
  assert.equal(byDoor["mcp_tool:inbox"], 4);
  assert.equal(byDoor["mcp_tool:guest_inbox"], 4);
  assert.equal(byDoor["mcp_tools_list"], 1);
});

// ---------- the documents ----------

test("Test-RouteSentencesServed, run for real: the real worker's /openapi.json, /llms.txt and /api/surface pass; each missing sentence or answer has its own reason", async (t) => {
  if (!POWERSHELL) return t.skip("no PowerShell available");
  const tail = [R("docs", "Test-RouteSentencesServed")];
  const ok = await res(WORLD, tail);
  assert.equal(ok.at("docs"), "", ok.out);
  const strip = (path: string, sentence: string): Fixture => ({ seed: worldSeed(), after: (s, r) => (s.path === path ? { ...r, body: r.body.split(sentence).join("x") } : undefined) });
  const INBOX = lit("ROUTE_SENTENCE_INBOX");
  const GUEST = lit("ROUTE_SENTENCE_GUEST");
  assert.match((await res(strip("/openapi.json", INBOX), tail)).at("docs"), /GET \/openapi\.json lacks the GET \/api\/inbox sentence/);
  assert.match((await res(strip("/llms.txt", INBOX), tail)).at("docs"), /GET \/llms\.txt lacks the GET \/api\/inbox sentence/);
  assert.match((await res(strip("/api/surface", GUEST), tail)).at("docs"), /GET \/api\/surface lacks the GET \/api\/guest\/inbox sentence/);
  assert.match((await res(strip("/openapi.json", GUEST), tail)).at("docs"), /GET \/openapi\.json lacks the GET \/api\/guest\/inbox sentence/);
  assert.match((await res(strip("/api/surface", INBOX), tail)).at("docs"), /GET \/api\/surface lacks the GET \/api\/inbox sentence/);
  // The live base 9f7fe955 already serves both route sentences (this wave changes no route description): a regression check, and it passes on the base.
  assert.equal((await res(OLD, tail)).at("docs"), "");
  assert.match((await res({ seed: worldSeed(), intercept: (s) => (s.path === "/llms.txt" ? { status: 404, headers: {}, body: "x" } : undefined) }, tail)).at("docs"), /GET \/llms\.txt answered 404, expected 200/);
});

test("Test-RouteRefusals, run for real: the real worker passes the rotate and wallet refusals; each altered answer has its own reason", async (t) => {
  if (!POWERSHELL) return t.skip("no PowerShell available");
  const tail = [R("rotate", "Test-RouteRefusals $ROTATE_URL '/api/rotate'"), R("wallet", "Test-RouteRefusals $WALLET_URL '/api/wallet'")];
  const ok = await res(WORLD, tail);
  for (const l of ["rotate", "wallet"]) assert.equal(ok.at(l), "", `${l}: ${ok.out}`);
  const walletAccepted = await res({ seed: worldSeed(), intercept: (s) => (s.path === "/api/wallet" && s.method === "POST" ? jsonAns({ ok: true }) : undefined) }, tail);
  assert.match(walletAccepted.at("wallet"), /POST \/api\/wallet with no credential answered 200, expected 401/);
  const rotateText = await res({ seed: worldSeed(), after: (s, r) => (s.path === "/api/rotate" && s.method === "POST" ? mutateJson(r, (j) => { j.error = "Something else."; }) : undefined) }, tail);
  assert.match(rotateText.at("rotate"), /POST \/api\/rotate with no credential: the 401 error is 'Something else\.'/);
  const walletGet = await res({ seed: worldSeed(), intercept: (s) => (s.path === "/api/wallet" && s.method === "GET" ? jsonAns({}) : undefined) }, tail);
  assert.match(walletGet.at("wallet"), /GET \/api\/wallet answered 200, expected 404/);
});

test("the dry run's text is accurate: it names only GETs, says it sends no POST and no wrangler command, and the closing note's door numbers are the reads the ride makes", () => {
  const dry = script.slice(script.indexOf('Say "[dry-run]'), script.indexOf("exit 0", script.indexOf('Say "[dry-run]')));
  assert.ok(dry.includes("Every live read was a GET") && dry.includes("sent NO POST") && dry.includes("no wrangler command at all"));
  assert.ok(dry.includes("[ray] line"), "the dry run says each read logs its ray line");
  assert.ok(!/replication/.test(dry), "inbox gate C1 is checked in step 0, not handed to a reminder");
  const beforeStep2 = code.slice(code.indexOf("$attBefore = Read-Attest"), code.indexOf("if ($DryRun)"));
  assert.equal(/Get-PostAnswer|Get-JsonPost|"-X", "POST"|Test-McpTools|Test-ToolsListSchemas|Test-RouteRefusals/.test(beforeStep2), false, "no POST before the dry-run exit");
  // the dry run EXITS: without it the script goes on to the deploy. Mutation that reddens this: delete the exit 0. The block is also run for real.
  const dryBlock = script.slice(script.indexOf("if ($DryRun) {"), script.indexOf("# 3. deploy the worker"));
  assert.match(dryBlock, /^if \(\$DryRun\) \{\n  Say "\[dry-run\][^\n]*"\n  exit 0\n\}\n+$/);
  if (POWERSHELL) {
    const run = runPs(["function Say($m) { Write-Host $m }", "$DryRun = $true", ...dryBlock.split("\n"), "Write-Host 'WENT-ON'", "exit 7"])!;
    assert.equal(run.code, 0, run.out);
    assert.equal(run.out.includes("WENT-ON"), false, "nothing runs after the dry run's block");
    assert.equal(runPs(["function Say($m) { Write-Host $m }", "$DryRun = $false", ...dryBlock.split("\n"), "Write-Host 'WENT-ON'", "exit 7"])!.code, 7, "the control: a real run goes on");
  }
  // both doors are ridden. Mutation that reddens this: drop either call.
  assert.equal(ride.split('Test-McpTools "/mcp" $visitorNumber').length - 1, 1);
  assert.equal(ride.split('Test-McpTools "/mcp/read" $visitorNumber').length - 1, 1);
  assert.ok(script.includes("The pre-deploy GETs read no counted door"), "the closing note says what the dry run did to the door figures");
  assert.equal(/agent_card|a2a_send|payments_out|wallet_is_treasury/i.test(code), false, "no leftover from the earlier ships");
});
