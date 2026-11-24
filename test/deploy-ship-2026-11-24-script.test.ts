// scripts/deploy-ship-2026-11-24.ps1 is WRITTEN AND NEVER RUN by this test (no deploy, no wrangler, not even -DryRun, which reads the live worker over HTTP). It is proven here by what can be
// proven without running it: it parses under PowerShell's own parser, is ASCII with LF endings, has none of the repo's PowerShell traps, has the load-bearing step order, no migration, no D1 command,
// a single deploy, step 0a stops on the placeholder before any git or network command, every Select-String literal is in its file, every constant the ride compares against is pinned to the
// source that serves it, L-167 is proven by running the real poll and retry, and every new PowerShell function is RUN FOR REAL against a local HTTP server that wraps the REAL worker handlers
// (src/index.ts over a real local D1; the harness rewrites the script's $BASE to 127.0.0.1, and the test asserts it did), then against altered answers, one per judged item.
// SHIP_SCRIPT_PATH overrides the script under test so a mutated copy can be run against this file (the mutation runner); it is never set in a normal run.
// Derived from test/deploy-agent-card-script.test.ts.
//
// Run: npm test

import test, { after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { parsePowerShellFile } from "./helpers/ps-parse.ts";
import worker from "../src/index.ts";
import { createLocalD1, seedCitizens, guestEnv, freshIp, seedTopic, seedVisitor, guestComment, type LocalD1 } from "./helpers/guest.ts";
import { insertListing, insertSubmission } from "./helpers/local-d1.ts";
import { postGuestAnswer } from "../src/guest.ts";
import { OPERATOR_WALLET, type Env } from "../src/society.ts";
import { PAYMENTS_OUT_NOTE } from "../src/treasury-out.ts";
import { walletLogEntry } from "../src/wallets.ts";

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
const SCRIPT_PATH = process.env.SHIP_SCRIPT_PATH ?? here("../scripts/deploy-ship-2026-11-24.ps1");
const rawScript = readFileSync(SCRIPT_PATH, "utf8");
const script = rawScript.replace(/\r\n/g, "\n");
const code = script.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
const defs = script.slice(script.indexOf('$ErrorActionPreference = "Stop"'), script.indexOf("# END-OF-DEFINITIONS"));
const pinBlock = script.slice(script.indexOf("# BEGIN-PIN-CHECK"), script.indexOf("# END-PIN-CHECK"));
const ride = script.slice(script.indexOf("# 4. the ride"));
const slice = (from: string, to: string): string => defs.slice(defs.indexOf(from), defs.indexOf(to));

const LIVE = "097a4a895f4b3fafe87b6d5c2bd4472edf926600";
const REVIEWED = "70202a1e81ef0ce78b900c916042da8f8936a25d";
const SRC = (f: string): string => readFileSync(here(`../src/${f}`), "utf8");
const SOCIETY_SRC = SRC("society.ts");
const INDEX_SRC = SRC("index.ts");
const INBOX_SRC = SRC("inbox.ts");
const DISCOVERY_SRC = SRC("discovery.ts");
const WALLETS_SRC = SRC("wallets.ts");

// The worker's treasury RPC read must not reach the network from this process.
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

function runPs(lines: string[]): { code: number | null; out: string } | null {
  const dir = mkdtempSync(join(tmpdir(), "deploy-ship-"));
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
  const dir = mkdtempSync(join(tmpdir(), "deploy-ship-"));
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

test("the pins: v6 hash, the live base 097a4a89, the reviewed commit 70202a1e in full, the allowlist is the script, its test and the wallet-not-treasury gate record, the parameters", () => {
  assert.match(script, /^\$V6_HASH = "dc5f48213c29bcf844e0fbe7daf1bdb5416b3d57fbd06a8bd03f1061f34092b3"$/m);
  assert.match(script, new RegExp(`^\\$LIVE_BASE_COMMIT = "${LIVE}"$`, "m"));
  assert.match(script, /^\$LIVE_BASE_PLACEHOLDER = "TO-BE-SET-BY-HUB-LIVE-BASE"$/m);
  assert.match(script, new RegExp(`^\\$REVIEWED_COMMIT = "${REVIEWED}"$`, "m"));
  assert.match(script, /^\$REVIEWED_COMMIT_PLACEHOLDER = "TO-BE-SET-BY-HUB"$/m);
  assert.match(script, /^\$ALLOWED_PATHS_AFTER_REVIEW = @\("scripts\/deploy-ship-2026-11-24\.ps1", "test\/deploy-ship-2026-11-24-script\.test\.ts", "docs\/REVIEW-WALLET-NOT-TREASURY-GATE-2026-11-24\.md"\)$/m);
  assert.match(script, /\[Parameter\(Mandatory = \$true\)\]\[string\]\$ExpectedCommit/);
  assert.match(script, /\[switch\]\$DryRun/);
  // The reviewed pin is a real commit of this repository, and the live base is its ancestor.
  const git = (a: string[]): { status: number | null; out: string } => {
    const r = spawnSync("git", ["-C", here(".."), ...a], { encoding: "utf8" });
    return { status: r.status, out: r.stdout.trim() };
  };
  assert.equal(git(["cat-file", "-t", REVIEWED]).out, "commit");
  assert.equal(git(["merge-base", "--is-ancestor", LIVE, REVIEWED]).status, 0);
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
});

test("the steps are in the load-bearing order, there is no migration, no D1 command and no clock refusal, the deploy is the only wrangler command, the only POSTs are two bodiless refusal POSTs per route and the official tools/call body", () => {
  const order = ["BEGIN-PIN-CHECK", "git fetch origin", "BEGIN-REVIEWED-SOURCE-CHECK", "BEGIN-GATES", 'Read-Attest "before the deploy"', "$walletRead = Get-WalletEvents", "$absentWhy = Test-NoPaymentsOutYet", "$defectWhy = Test-CursorDefectPresent", "$visitorNumber = Get-VisitorNumber", "if ($DryRun)", "BEGIN-DEPLOY-AND-POLL", "$whyAttest = Confirm-Reads", "$whyRotate", "$whyWallet", "$whyPay", "$whyCursor", "$whyDocs", "$whyCards", "$whySweep"];
  let last = -1;
  for (const needle of order) {
    const i = script.indexOf(needle.startsWith("BEGIN-") ? "# " + needle : needle);
    assert.ok(i > last, `${needle} comes after the previous step`);
    last = i;
  }
  assert.equal(/migrations apply/i.test(code), false, "no migration apply");
  assert.equal(/d1 execute|Invoke-Bounded|D1_SQL_ARG|--remote|wrangler d1/i.test(code), false, "no D1 command, no bounded command runner, no SQL");
  assert.equal(/migtest|scratch/i.test(code), false, "no scratch database in the executable code");
  assert.equal(/Test-ClockWindow|Get-UtcNow|BEGIN-CLOCK-CHECK/.test(script), false, "nothing in this ride depends on the UTC day, so the template's clock refusal is gone");
  assert.equal((code.match(/= \(npx wrangler /g) ?? []).length, 1, "exactly one executed wrangler command");
  assert.equal((code.match(/(?:^|= \(|[;{|&])[ \t]*npx wrangler /gm) ?? []).length, 1, "no other executed wrangler command, assigned or not");
  assert.match(code, /npx wrangler deploy --var "CODE_COMMIT:\$headSha"/);
  assert.equal(/Invoke-WebRequest|Invoke-RestMethod|-Method\s+Post/i.test(code), false, "no PowerShell web cmdlets; every HTTP call is curl.exe");
  assert.equal((code.match(/-X POST/g) ?? []).length, 2, "exactly two bodiless POSTs, both in Get-PostAnswer");
  assert.equal((code.match(/\bGet-PostAnswer\b/g) ?? []).length, 3, "one definition and the two calls in Test-RouteRefusals");
  assert.equal((code.match(/--data-binary/g) ?? []).length, 1, "exactly one request body sender: Get-JsonPost");
  assert.ok(code.includes('$curlArgs = @("-s", "--max-time", "30", "-o", $out, "-w", "%{http_code}", "-H", "Content-Type: application/json", "--data-binary", ("@" + $req), $url)'), "the JSON body goes from a temp file");
  assert.equal((code.match(/\bGet-JsonPost\b/g) ?? []).length, 2, "one definition and one call: the official tools/call");
  assert.equal((code.match(/\bBearer\b/g) ?? []).length, 1, "one Bearer, the non-credential");
  assert.equal(/ch1\.|guest_comment|showhome_note|resident_(bind|token)|api\/council\/(challenge|claim|ballot)/.test(code), false, "no credential and no write tool");
  assert.ok(code.includes("src/doc.ts") && code.includes("migrations schema.sql"), "the no-mint and no-migration check names src/doc.ts, migrations and schema.sql");
  assert.ok(code.includes("git merge-base --is-ancestor $LIVE_BASE_COMMIT HEAD"), "HEAD must contain the live base");
  assert.ok(code.includes("[string]$attBefore.code.commit -cne $LIVE_BASE_COMMIT"), "the live worker is proven to be the pinned base");
  for (const step of ["$walletRead = Get-WalletEvents", "$absentWhy = Test-NoPaymentsOutYet", "$defectWhy = Test-CursorDefectPresent", "$visitorNumber = Get-VisitorNumber"]) {
    before(code.indexOf(step), code.indexOf("if ($DryRun)"), `${step} runs before the dry-run exit`);
  }
  for (const stop of ['if ($walletRead.Why -ne "") { Stop-Here', 'if ($walletWhy -ne "") { Stop-Here', 'if ($absentWhy -ne "") { Stop-Here', 'if ($defectWhy -ne "") { Stop-Here', 'if ($visitorNumber -ceq "") { Stop-Here', 'if ($treasuryAddress -ceq "") { Stop-Here']) {
    assert.ok(code.includes(stop), `${stop} ... the before-state read stops the script`);
  }
  before(code.indexOf("Test-WalletRowsClear $walletRead.Events"),code.indexOf("$visitorNumber = Get-VisitorNumber"), "the wallet rows are judged before the other before-state reads");
  assert.equal(/\bPOST\b/.test(script.slice(script.indexOf('Say "[dry-run]'), script.indexOf("exit 0", script.indexOf('Say "[dry-run]')))) && /sent NO POST/.test(script), true, "the dry run says it sends no POST");
});

test("the source checks name literals the checkout carries, and every Select-String literal is in its file", () => {
  for (const [file, anchor] of [
    ["src/treasury-out.ts", "export async function paymentsOut("],
    ["src/society.ts", "payments_out: await paymentsOut(env.DB, OPERATOR_WALLET)"],
    ["src/inbox.ts", "function refuseAboveHead("],
    ["src/wallets.ts", '"wallet_is_treasury"'],
    ["src/listings.ts", '"wallet_is_treasury",'],
  ] as const) {
    assert.ok(code.includes(`Select-String -Path "${file}" -Pattern ${anchor.includes('"') ? "'" + anchor + "'" : '"' + anchor + '"'}`), `${file}: ${anchor}`);
  }
  let n = 0;
  for (const m of code.matchAll(/Select-String -Path "([^"]+)" -Pattern ('[^']+'|"[^"]+")/g)) {
    if (m[1] === "wrangler.jsonc") continue;
    const l = m[2].slice(1, -1);
    assert.ok(readFileSync(here(`../${m[1]}`), "utf8").includes(l), `${m[1]} carries '${l}'`);
    n++;
  }
  assert.ok(n >= 6, `checked ${n} literals`);
});

test("the constants the ride compares against are the served ones: the note sentences, the inbox texts, the part names, the openapi sentence, the row caps, the wallet row patterns, the refusal texts", () => {
  assert.ok(PAYMENTS_OUT_NOTE.includes(lit("NOTE_WALLET_SENTENCE")), "the wallet sentence is in the served note");
  assert.ok(PAYMENTS_OUT_NOTE.includes(lit("NOTE_COPY_SENTENCE")), "the copy words are in the served note");
  assert.equal(lit("NOTE_WALLET_SENTENCE"), "POST /api/wallet refuses the treasury's own address.");
  assert.equal(lit("NOTE_COPY_SENTENCE"), "no copy of it anywhere else");
  assert.ok(INBOX_SRC.includes('{ comments: "comment", posts: "post", guest_thread: "guest row" }'), "the part names the ride quotes");
  assert.ok(INBOX_SRC.includes("cursor's ${CURSOR_PART_NAMES[table]} id is ${startId}, above the newest one here (${head})."), "the start of the 400 text");
  assert.ok(INBOX_SRC.includes('refuseAboveHead("pass since=<ms> instead of cursor to start again"') && lit("CITIZEN_RESTART_TAIL") === "or pass since=<ms> instead of cursor to start again.", "the citizen inbox restart tail");
  assert.ok(INBOX_SRC.includes('refuseAboveHead("omit cursor to start again"') && lit("GUEST_RESTART_TAIL") === "omit cursor to start again.", "the guest inbox restart tail");
  assert.ok(INBOX_SRC.includes("Pass next_cursor exactly as a previous response served it, or ${restart}."), "the tail follows 'or <restart>.'");
  assert.equal((INBOX_SRC.match(/A part above the newest row of its table is refused with 400/g) ?? []).length, 2, "both cursor_notes carry the sentence");
  assert.equal(lit("CURSOR_NOTE_SENTENCE"), "refused with 400");
  assert.ok(DISCOVERY_SRC.includes(lit("CURSOR_ABOVE_SENTENCE")), "the openapi sentence is in discovery.ts");
  assert.equal((DISCOVERY_SRC.match(/or above the newest row id of its table, is refused with 400/g) ?? []).length, 2, "on both cursor parameters");
  assert.match(script, /^\$IDENTITY_LOG_CAP = 500$/m);
  assert.equal((SOCIETY_SRC.match(/ORDER BY e\.created_at DESC LIMIT 500/g) ?? []).length, 2, "identityLog caps both its queries at 500");
  assert.match(script, /^\$BOOK_PAGE_CAP = 200$/m);
  assert.ok(readFileSync(here("../src/payouts.ts"), "utf8").includes("ORDER BY created_at DESC, id DESC LIMIT 200"));
  assert.ok(readFileSync(here("../src/listings.ts"), "utf8").includes("ORDER BY lp.created_at DESC, lp.id DESC LIMIT 200"));
  assert.match(script, /^\$WALLET_KINDS = @\("wallet_declared", "wallet_changed"\)$/m);
  assert.ok(WALLETS_SRC.includes("const DECLARED_DETAIL = /^wallet declared: (0x[0-9a-f]{40})$/;") && script.includes("'^wallet declared: (0x[0-9a-f]{40})$'"));
  assert.ok(WALLETS_SRC.includes("const CHANGED_DETAIL = /^wallet changed: 0x[0-9a-f]{40} -> (0x[0-9a-f]{40})$/;") && script.includes("'^wallet changed: 0x[0-9a-f]{40} -> (0x[0-9a-f]{40})$'"));
  assert.equal(lit("HEADS_URL"), "$BASE/api/inbox?handle=commonhold-agent&since=9999999999999");
  assert.equal(lit("NO_CREDENTIALS_PREFIX"), "No credentials. Register first");
  const auth = SOCIETY_SRC.slice(SOCIETY_SRC.indexOf("export async function authenticate("), SOCIETY_SRC.indexOf("export async function authenticate(") + 3000);
  assert.ok(auth.includes(`throw new SocietyError(401, "${lit("NO_CREDENTIALS_PREFIX")}`));
  assert.ok(auth.includes(`throw new SocietyError(401, "${lit("UNKNOWN_SECRET_TEXT")}")`));
  const bearer = lit("NOT_A_SECRET");
  assert.equal(bearer.startsWith("commonhold_sk_") || bearer.startsWith("ch1."), false, "not a secret's shape and not an assertion");
  assert.equal(/[^a-z-]/.test(bearer), false, "plain, so PowerShell 5.1 passes it to curl.exe unchanged");
  assert.ok(INDEX_SRC.includes('path === "/api/wallet" && method === "POST"') && !/"\/api\/wallet"[^\n]*method === "GET"/.test(INDEX_SRC), "the wallet route is POST only");
  assert.ok(INDEX_SRC.includes('path === "/api/rotate" && method === "POST"'), "the rotate route is POST only");
  assert.match(script, /^\$OFFICIAL_BODY = '\{"jsonrpc":"2\.0","id":1,"method":"tools\/call","params":\{"name":"official","arguments":\{\}\}\}'$/m);
  assert.ok(SRC("mcp-read.ts").includes('case "official":') && SRC("mcp.ts").includes('case "official":'), "both MCP doors serve the official tool");
  assert.deepEqual([...script.matchAll(/^\$CARD_PATHS = @\("([^"]+)", "([^"]+)"\)$/gm)].map((m) => [m[1], m[2]])[0], ["/.well-known/agent-card.json", "/.well-known/agent.json"]);
});

test("L-167 is structural: every post-deploy check goes through Confirm-Reads, none sends a POST outside it, the closing note names the unridden refusal and the two door additions, and the sweep names 17 paths", () => {
  const sites = confirmReadsBlocks(ride);
  assert.equal((ride.match(/= Confirm-Reads /g) ?? []).length, 8, "attest, rotate, wallet, payments_out, cursor ride, documents, cards, sweep");
  assert.equal(sites.sites, 8);
  for (const b of sites.blocks) assert.ok(b.length > 0, "every Confirm-Reads call has a block");
  assert.equal([...ride.matchAll(/Stop-Here \(([^\n]*)\)/g)].filter((m) => !/deployments list/.test(m[1])).length, 0, "every ride stop says to read the deployments list by hand");
  for (const m of ride.matchAll(/Stop-Here \(([^\n]*)\)/g)) {
    const text = m[1];
    const roll = text.indexOf("$ROLLBACK_LINE");
    if (roll >= 0) assert.ok(text.indexOf("deployments list") >= 0 && text.indexOf("deployments list") < roll, "the rollback is named only after 'read the deployments list'");
  }
  assert.ok(script.includes("NOT ridden") && script.includes("WHAT IT DID NOT PROVE"), "the closing note says the refusal is not ridden");
  assert.ok(code.includes("$mcpPostsMin = 2 * $GOOD_READS_NEEDED") && code.includes("$cardGetsMin = $CARD_PATHS.Count * $GOOD_READS_NEEDED"), "the door additions are computed from the reads the ride makes");
  const sweep = /^\$sweepPaths = @\((.*)\)$/m.exec(script)![1].split(",").map((s) => s.trim());
  assert.equal(sweep.length, 17, "17 public reads");
  assert.equal(new Set(sweep).size, 17);
  assert.equal(/Confirm-Reads/.test(slice("function Confirm-Reads", "# Polls until")) && /Stop-Here|exit \d|ROLL ?BACK/i.test(slice("function Confirm-Reads", "# Polls until")), false, "the retry itself neither stops nor names a remedy");
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
}
const jsonAns = (o: unknown, status = 200): Ans => ({ status, headers: { "content-type": "application/json" }, body: JSON.stringify(o) });
const mutateJson = (res: Ans, fn: (j: any) => void): Ans => {
  const j = JSON.parse(res.body);
  fn(j);
  return { ...res, body: JSON.stringify(j) };
};
// The per-surface alteration of payments_out: all five surfaces at once, so five identical wrong objects can be served.
const poHook = (fn: (po: any) => void) => (s: Seen, res: Ans): Ans | undefined => {
  const p = s.path.split("?")[0];
  if (s.method === "GET" && (p === "/treasury" || p === "/api/treasury")) return mutateJson(res, (j) => fn(j.payments_out));
  if (s.method === "GET" && p === "/api/official") return mutateJson(res, (j) => fn(j.treasury.payments_out));
  if (s.method === "POST" && (p === "/mcp" || p === "/mcp/read") && s.body.includes('"official"')) {
    return mutateJson(res, (j) => {
      const inner = JSON.parse(j.result.content[0].text);
      fn(inner.treasury.payments_out);
      j.result.content[0].text = JSON.stringify(inner, null, 2);
    });
  }
  return undefined;
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

const OPERATOR_UPPER = OPERATOR_WALLET.replace(/[a-f]/g, (x) => x.toUpperCase()).replace("0X", "0x");
const OTHER = "0x00000000000000000000000000000000000000aa";
function paidListing(d1: LocalD1, citizenId: number, payer: string, cents: number): void {
  const lid = insertListing(d1, { funder_citizen_id: citizenId, bounty_cents: cents });
  const sid = insertSubmission(d1, { listing_id: lid, citizen_id: citizenId });
  d1.raw
    .prepare("INSERT INTO listing_payments (listing_id, submission_id, payee_citizen_id, payee_address, payer_address, amount_cents, tx, created_at) VALUES (?, ?, ?, '0xa', ?, ?, ?, 1)")
    .run(lid, sid, citizenId, payer, cents, `0x${lid}`);
}
// A world with every row the ride reads: comments, posts, a guest critique answered (so GET /api/guest/due lists it), two operator-wallet payments (one mixed case), one other, three payouts, wallet rows.
const worldSeed = (extra?: (d1: LocalD1) => void) => async (env: Env, d1: LocalD1): Promise<void> => {
  const topic = seedTopic(d1);
  const v = await seedVisitor(d1, "wren");
  const g = await guestComment(env, v.token, { post_id: topic, body: "a critique", kind: "critique" });
  assert.equal(g.status, 201, JSON.stringify(g.body));
  const answered = await postGuestAnswer(env, { id: 1, handle: "commonhold-agent", model: "claude-fable-5" }, { guest_comment_id: g.body.comment_id as string, body: "An answer long enough to count: it names the critique, says what the society will and will not change, and gives the reason." });
  assert.ok(answered.body, "the critique was answered, so GET /api/guest/due lists it in its history");
  d1.raw.prepare("INSERT INTO comments (post_id, parent_id, citizen_id, body, depth, author_model, created_at) VALUES (?, NULL, 2, 'a comment', 0, 'test-model', ?)").run(topic, Date.now());
  paidListing(d1, 2, OPERATOR_WALLET, 1200);
  paidListing(d1, 2, OPERATOR_UPPER, 1500);
  paidListing(d1, 2, OTHER, 700);
  for (const [n, cents] of [[1, 250], [2, 40], [3, 1]] as const) {
    d1.raw.prepare("INSERT INTO payouts (citizen_id, amount_cents, reason, tx, created_at, prev_hash, hash) VALUES (2, ?, 'prize', ?, 1, ?, ?)").run(cents, `0xp${n}`, `p${n}`, `h${n}`);
  }
  wallet(d1, 2, null, OTHER);
  extra?.(d1);
};
function wallet(d1: LocalD1, citizen: number, previous: string | null, next: string): void {
  const e = walletLogEntry(previous, next);
  d1.raw.prepare("INSERT INTO identity_events (citizen_id, kind, detail, created_at) VALUES (?, ?, ?, ?)").run(citizen, e.kind, e.detail, Date.now());
}
const WORLD: Fixture = { seed: worldSeed() };
const TREASURY_SERVED = "0x0000000000000000000000000000000000000001";

test("Get-WalletEvents and Test-WalletRowsClear, run for real over the real route and rows written by the real walletLogEntry: clear, the treasury declared, the treasury as the NEW address of a change in any letter case, a change AWAY from it, an unreadable row, a capped read and an unapplied filter", async (t) => {
  if (!POWERSHELL) return t.skip("no PowerShell available");
  const tail = [
    "$ev = Get-WalletEvents",
    R("read", '$ev.Why'),
    R("clear", `Test-WalletRowsClear $ev.Events '${TREASURY_SERVED}'`),
    R("badaddr", "Test-WalletRowsClear $ev.Events ''"),
    R("count", "@($ev.Events).Count"),
  ];
  const ok = await res(WORLD, tail);
  assert.equal(ok.at("read"), "", ok.out);
  assert.equal(ok.at("clear"), "");
  assert.match(ok.at("badaddr"), /treasury address is missing or malformed/);
  assert.equal(ok.at("count"), "1");
  // Declared, and changed TO the treasury (stored lower case; the compare is case-insensitive, so the served address in capitals still matches).
  const declared = await res({ seed: worldSeed((d1) => wallet(d1, 2, null, TREASURY_SERVED)) }, tail);
  assert.match(declared.at("clear"), /identity-log row \d+ \(wallet_declared, citizen alice\) makes the treasury's own address 0x0{39}1 a current wallet/);
  const changed = await res({ seed: worldSeed((d1) => wallet(d1, 2, OTHER, TREASURY_SERVED)) }, tail);
  assert.match(changed.at("clear"), /\(wallet_changed, citizen alice\) makes the treasury's own address/);
  const upper = await res(WORLD, ["$ev = Get-WalletEvents", R("clear", "Test-WalletRowsClear @(@{ id = 9; kind = 'wallet_declared'; detail = 'wallet declared: " + TREASURY_SERVED + "'; citizen = 'x' }) '0X0000000000000000000000000000000000000001'.Replace('0X', '0x').ToUpperInvariant().Replace('0X', '0x')")]);
  assert.match(upper.at("clear"), /makes the treasury's own address/, "the served address in capitals still matches the lower-case row");
  // A change AWAY from the treasury: the previous address is the treasury, the new one is not. The old row is the finding, the new one is clear on its own.
  const away = await res(WORLD, [R("clear", `Test-WalletRowsClear @(@{ id = 5; kind = 'wallet_changed'; detail = '${walletLogEntry(TREASURY_SERVED, OTHER).detail}'; citizen = 'x' }) '${TREASURY_SERVED}'`)]);
  assert.equal(away.at("clear"), "", "a row that moved the wallet AWAY from the treasury makes it nobody's current wallet");
  const unreadable = await res(WORLD, [R("clear", `Test-WalletRowsClear @(@{ id = 6; kind = 'wallet_declared'; detail = 'wallet declared: 0xNOTHEX'; citizen = 'x' }) '${TREASURY_SERVED}'`)]);
  assert.match(unreadable.at("clear"), /identity-log row 6 \(wallet_declared\) has a detail the script cannot read/);
  // The route's cap: 500 rows of one kind cannot be shown to be every row.
  const capped = await res({ seed: worldSeed((d1) => { for (let i = 0; i < 500; i++) wallet(d1, 2, null, OTHER); }) }, tail);
  assert.match(capped.at("read"), /GET \/api\/events\?kind=wallet_declared returned 500 rows, the route's cap: it cannot be shown to be every row/);
  // A filter that was not applied (the route ignores a bad kind and serves everything) is a failed read.
  const noFilter = await res({ seed: worldSeed(), intercept: (s) => (s.path.startsWith("/api/events?kind=wallet_changed") ? jsonAns({ filter: "all", count: 0, events: [] }) : undefined) }, tail);
  assert.match(noFilter.at("read"), /says filter 'all': the kind filter was not applied/);
  const stray = await res({ seed: worldSeed(), after: (s, r) => (s.path.startsWith("/api/events?kind=wallet_declared") ? mutateJson(r, (j) => { j.events[0].kind = "moderation"; }) : undefined) }, tail);
  assert.match(stray.at("read"), /carried a row of kind 'moderation'/);
  const down = await res({ seed: worldSeed(), intercept: (s) => (s.path.startsWith("/api/events") ? jsonAns({ error: "x" }, 503) : undefined) }, tail);
  assert.match(down.at("read"), /GET \/api\/events\?kind=wallet_declared answered 503, expected 200/);
});

test("Test-NoPaymentsOutYet, run for real: the real worker already carries payments_out (a reason naming the first surface); with it stripped from all three the before-state passes, and one surface still carrying it fails", async (t) => {
  if (!POWERSHELL) return t.skip("no PowerShell available");
  const tail = [R("state", "Test-NoPaymentsOutYet")];
  assert.match((await res(WORLD, tail)).at("state"), /GET \/treasury already carries payments_out: the base is not what we think/);
  const stripAll = (keep?: string) => (s: Seen, r: Ans): Ans | undefined => {
    const p = s.path.split("?")[0];
    if (s.method !== "GET" || p === keep) return undefined;
    if (p === "/treasury" || p === "/api/treasury") return mutateJson(r, (j) => { delete j.payments_out; });
    if (p === "/api/official") return mutateJson(r, (j) => { delete j.treasury.payments_out; });
    return undefined;
  };
  assert.equal((await res({ seed: worldSeed(), after: stripAll() }, tail)).at("state"), "");
  assert.match((await res({ seed: worldSeed(), after: stripAll("/api/official") }, tail)).at("state"), /GET \/api\/official already carries payments_out/);
  assert.match((await res({ seed: worldSeed(), after: stripAll("/api/treasury") }, tail)).at("state"), /GET \/api\/treasury already carries payments_out/);
  assert.match((await res({ seed: worldSeed(), intercept: (s) => (s.path === "/treasury" ? jsonAns({ error: "x" }, 502) : undefined) }, tail)).at("state"), /GET \/treasury answered 502/);
});

test("Test-CursorDefectPresent and Test-CursorRide, run for real: the real worker (the refusal is live) fails the before-check and passes the ride; the old behaviour (every cursor 200) passes the before-check and fails the ride at the first refusal; every altered step has its own reason", async (t) => {
  if (!POWERSHELL) return t.skip("no PowerShell available");
  const tail = [R("defect", "Test-CursorDefectPresent"), "$vn = Get-VisitorNumber", R("visitor", "$vn"), R("ride", "Test-CursorRide $vn")];
  const live = await res(WORLD, tail);
  assert.match(live.at("defect"), /already answers 400: the refusal is live, so the base is not what we think/);
  assert.match(live.at("visitor"), /^[1-9][0-9]*$/, "the visitor number came from GET /api/guest/due");
  assert.equal(live.at("ride"), "", live.out);
  // The old worker answered 200 for a cursor above a head; here every 400 the real worker gives is turned into that 200.
  const oldWorld: Fixture = { seed: worldSeed(), after: (s, r) => (/[?&]cursor=/.test(s.path) && r.status === 400 ? jsonAns({ handle: "x", next_cursor: "c0-p0", has_more: false, replies: [] }) : undefined) };
  const old = await res(oldWorld, tail);
  assert.equal(old.at("defect"), "", "the defect is present: the cursor above the head answered 200");
  assert.match(old.at("ride"), /GET \/api\/inbox with comment id head\+1 answered 200, expected 400/);
  assert.match((await res({ seed: worldSeed(), intercept: (s) => (s.path.startsWith("/api/inbox") && /since=9999999999999/.test(s.path) ? jsonAns({ next_cursor: "garbage" }) : undefined) }, tail)).at("defect"), /served next_cursor 'garbage', expected c<n>-p<n>/);
  const ride = (name: string, fx: Fixture, re: RegExp) => ({ name, fx, re });
  const cases = [
    ride("head cursor refused", { seed: worldSeed(), after: (s, r) => (/[?&]cursor=c(\d+)-p(\d+)-g(\d+)$/.test(s.path) && r.status === 200 && s.path.startsWith("/api/inbox?handle=commonhold-agent&cursor=") ? jsonAns({ error: "no" }, 400) : undefined) }, /GET \/api\/inbox with the head cursor itself answered 400, expected 200/),
    ride("wrong comment text", { seed: worldSeed(), after: (s, r) => (r.status === 400 && s.path.startsWith("/api/inbox") ? mutateJson(r, (j) => { j.error = j.error.replace("comment id", "comment number"); }) : undefined) }, /GET \/api\/inbox with comment id head\+1: the 400 error is 'cursor's comment number is 2/),
    ride("wrong tail", { seed: worldSeed(), after: (s, r) => (r.status === 400 && s.path.startsWith("/api/inbox") ? mutateJson(r, (j) => { j.error = j.error.replace("start again.", "start over."); }) : undefined) }, /expected it to end 'or pass since=<ms> instead of cursor to start again\.'/),
    ride("post not refused", { seed: worldSeed(), after: (s, r) => (/cursor=c\d+-p(\d+)/.test(s.path) && r.status === 400 && /above the newest one here/.test(r.body) && r.body.includes("post id") ? jsonAns({ next_cursor: "c1-p1" }) : undefined) }, /GET \/api\/inbox with post id head\+1 answered 200, expected 400/),
    ride("guest part not refused", { seed: worldSeed(), after: (s, r) => (r.status === 400 && r.body.includes("guest row id") ? jsonAns({ next_cursor: "c1-p1" }) : undefined) }, /GET \/api\/inbox with guest row id head\+1 answered 200, expected 400/),
    ride("cursor_note stripped", { seed: worldSeed(), after: (s, r) => (/since=0$/.test(s.path) ? mutateJson(r, (j) => { j.cursor_note = "no sentence here"; }) : undefined) }, /the cursor_note of GET \/api\/inbox with since=0 does not contain 'refused with 400'/),
    ride("served cursor refused", { seed: worldSeed(), after: (s, r) => (/since=0$/.test(s.path) ? mutateJson(r, (j) => { j.next_cursor = "c999999-p999999"; }) : undefined) }, /GET \/api\/inbox with the next_cursor it served answered 400, expected 200/),
    ride("guest inbox unknown visitor", { seed: worldSeed(), intercept: (s) => (s.path.startsWith("/api/guest/inbox") ? jsonAns({ error: "no" }, 404) : undefined) }, /GET \/api\/guest\/inbox\?guest=\d+ answered 404, expected 200/),
    ride("guest cursor shape", { seed: worldSeed(), after: (s, r) => (/^\/api\/guest\/inbox\?guest=\d+$/.test(s.path) ? mutateJson(r, (j) => { j.next_cursor = "x"; }) : undefined) }, /served next_cursor 'x', expected g<n>-c<n>-p<n>/),
    ride("guest above head not refused", { seed: worldSeed(), after: (s, r) => (s.path.startsWith("/api/guest/inbox") && r.status === 400 ? jsonAns({ next_cursor: "g1-c1-p1" }) : undefined) }, /GET \/api\/guest\/inbox with comment id head\+1 answered 200, expected 400/),
    ride("guest wrong tail", { seed: worldSeed(), after: (s, r) => (s.path.startsWith("/api/guest/inbox") && r.status === 400 ? mutateJson(r, (j) => { j.error = j.error.replace("omit cursor to start again.", "something else."); }) : undefined) }, /GET \/api\/guest\/inbox with comment id head\+1: the 400 error is .*expected it to end 'omit cursor to start again\.'/),
  ];
  for (const c of cases) assert.match((await res(c.fx, tail)).at("ride"), c.re, c.name);
  // No visitor number to ride with: a public answer that lists none is a reason, never a guess.
  const none = await res({ seed: worldSeed(), intercept: (s) => (s.path.startsWith("/api/guest/due") ? jsonAns({ items: [] }) : undefined) }, tail);
  assert.equal(none.at("visitor"), "");
  assert.match(none.at("ride"), /no visitor number could be read from GET \/api\/guest\/due/);
  const noGuestPart = await res({ seed: worldSeed(), after: (s, r) => (s.path.includes("since=9999999999999") ? mutateJson(r, (j) => { j.next_cursor = String(j.next_cursor).replace(/-g\d+$/, ""); }) : undefined) }, [R("ride", "Test-CursorRide '1'")]);
  assert.doesNotMatch(noGuestPart.at("ride"), /guest row id/, "with no guest part in the heads the guest-row step is skipped, not failed");
});

const poTail = [R("pay", "Test-PaymentsOutServed")];
test("Test-PaymentsOutServed, run for real over the real surfaces (the REAL paymentsOut over seeded books): passes; every altered figure, surface and sentence has its own reason", async (t) => {
  if (!POWERSHELL) return t.skip("no PowerShell available");
  const good = await res(WORLD, poTail);
  assert.equal(good.at("pay"), "", good.out);
  type Case = [string, Fixture, RegExp];
  const alter = (name: string, fn: (po: any) => void, re: RegExp): Case => [name, { seed: worldSeed(), after: poHook(fn) }, re];
  const cases: Case[] = [
    ["one surface differs: /api/treasury total", { seed: worldSeed(), after: (s, r) => (s.path === "/api/treasury" ? mutateJson(r, (j) => { j.payments_out.listing_bounties.total_cents += 1; }) : undefined) }, /payments_out on GET \/api\/treasury differs from the one on GET \/treasury/],
    ["the MCP read door still serves the old answer (no payments_out)", { seed: worldSeed(), after: (s, r) => (s.path === "/mcp/read" && s.method === "POST" ? mutateJson(r, (j) => { const inner = JSON.parse(j.result.content[0].text); delete inner.treasury.payments_out; j.result.content[0].text = JSON.stringify(inner); }) : undefined) }, /POST \/mcp\/read official carried no treasury\.payments_out/],
    ["the MCP door answers an error", { seed: worldSeed(), after: (s, r) => (s.path === "/mcp" && s.method === "POST" ? mutateJson(r, (j) => { j.result.isError = true; }) : undefined) }, /POST \/mcp official answered isError true/],
    ["the official answer lacks payments_out", { seed: worldSeed(), after: (s, r) => (s.path === "/api/official" ? mutateJson(r, (j) => { delete j.treasury.payments_out; }) : undefined) }, /GET \/api\/official carries no payments_out/],
    ["the MCP door's total differs from the other four", { seed: worldSeed(), after: (s, r) => (s.path === "/mcp" && s.method === "POST" ? mutateJson(r, (j) => { const inner = JSON.parse(j.result.content[0].text); inner.treasury.payments_out.from_treasury.total_cents += 1; j.result.content[0].text = JSON.stringify(inner); }) : undefined) }, /payments_out on the official tool on \/mcp differs from the one on GET \/treasury/],
    ["the MCP read door's note differs from the other four", { seed: worldSeed(), after: (s, r) => (s.path === "/mcp/read" && s.method === "POST" ? mutateJson(r, (j) => { const inner = JSON.parse(j.result.content[0].text); inner.treasury.payments_out.note += " x"; j.result.content[0].text = JSON.stringify(inner); }) : undefined) }, /payments_out on the official tool on \/mcp\/read differs from the one on GET \/treasury/],
    alter("code_can_pay true",(po) => { po.from_treasury.code_can_pay = true; }, /from_treasury\.code_can_pay is 'True', expected the boolean false/),
    alter("code_can_pay a string", (po) => { po.from_treasury.code_can_pay = "false"; }, /from_treasury\.code_can_pay is 'false', expected the boolean false/),
    alter("recorded_payouts differs from GET /payouts", (po) => { po.from_treasury.recorded_payouts = 4; }, /from_treasury\.recorded_payouts is 4, GET \/payouts lists 3 rows/),
    alter("payouts total differs", (po) => { po.from_treasury.total_cents = 292; }, /from_treasury\.total_cents is 292, GET \/payouts total_paid_cents is 291/),
    alter("a count as a string", (po) => { po.listing_bounties.paid = "3"; }, /listing_bounties\.paid is '3', expected a whole number/),
    alter("bounty total differs", (po) => { po.listing_bounties.total_cents = 3401; }, /listing_bounties\.total_cents is 3401, GET \/api\/listings\/payments total_paid_cents is 3400/),
    alter("bounty count differs", (po) => { po.listing_bounties.paid = 4; }, /listing_bounties\.paid is 4, GET \/api\/listings\/payments lists 3 rows/),
    alter("operator wallet count differs", (po) => { po.listing_bounties.paid_from_operator_wallet.paid = 3; }, /paid_from_operator_wallet is 3 payments, 2700 cents; recomputed from GET \/api\/listings\/payments rows whose payer_address is 0x[0-9a-f]{40}: 2 payments, 2700 cents/),
    alter("operator wallet cents differ", (po) => { po.listing_bounties.paid_from_operator_wallet.total_cents = 1200; }, /paid_from_operator_wallet is 2 payments, 1200 cents; recomputed/),
    alter("wallet not lower case", (po) => { po.listing_bounties.paid_from_operator_wallet.wallet = OPERATOR_UPPER; }, /paid_from_operator_wallet\.wallet is '0x3F29/),
    alter("note lacks the wallet sentence", (po) => { po.note = po.note.replace("POST /api/wallet refuses the treasury's own address.", ""); }, /the payments_out note lacks the sentence 'POST \/api\/wallet refuses the treasury's own address\.'/),
    alter("note lacks the copy words", (po) => { po.note = po.note.replace("no copy of it anywhere else", "a copy elsewhere"); }, /the payments_out note lacks the words 'no copy of it anywhere else'/),
    ["GET /payouts down", { seed: worldSeed(), intercept: (s) => (s.path === "/payouts" ? jsonAns({ error: "x" }, 503) : undefined) }, /GET \/payouts answered 503/],
    ["a payments book that is not one", { seed: worldSeed(), intercept: (s) => (s.path === "/api/listings/payments" ? jsonAns({ entries: [] }) : undefined) }, /GET \/api\/listings\/payments was not the payments book/],
  ];
  for (const [name, fx, re] of cases) assert.match((await res(fx, poTail)).at("pay"), re, name);
});

test("Test-PaymentsOutServed at the 200-row cap: a page of exactly 200 rows is not the whole book, so the row counts and the operator-wallet recompute are skipped (a lie there passes), while the totals still bind; at 199 rows the same lie fails", async (t) => {
  if (!POWERSHELL) return t.skip("no PowerShell available");
  const rows = (n: number) => worldSeed((d1) => { for (let i = 0; i < n; i++) paidListing(d1, 2, OTHER, 1); });
  const lie = poHook((po) => { po.listing_bounties.paid_from_operator_wallet.paid = 999; po.listing_bounties.paid = 999; });
  const capped = await res({ seed: rows(197), after: lie }, poTail); // 3 seeded + 197 = 200 rows
  assert.equal(capped.at("pay"), "", capped.out);
  assert.match((await res({ seed: rows(196), after: lie }, poTail)).at("pay"), /listing_bounties\.paid is 999, GET \/api\/listings\/payments lists 199 rows/, "199 rows is under the cap and the lie is caught");
  const totalLie = poHook((po) => { po.listing_bounties.total_cents += 5; });
  assert.match((await res({ seed: rows(197), after: totalLie }, poTail)).at("pay"), /listing_bounties\.total_cents is \d+, GET \/api\/listings\/payments total_paid_cents is \d+/, "at the cap the total still binds");
});

test("Test-OpenApiCursorText, Test-SurfaceWalletNote, Test-CardsServed and Test-RouteRefusals, run for real: the real worker passes each; each altered answer has its own reason", async (t) => {
  if (!POWERSHELL) return t.skip("no PowerShell available");
  const tail = [R("openapi", "Test-OpenApiCursorText"), R("surface", "Test-SurfaceWalletNote"), R("cards", "Test-CardsServed"), R("rotate", "Test-RouteRefusals $ROTATE_URL '/api/rotate'"), R("wallet", "Test-RouteRefusals $WALLET_URL '/api/wallet'")];
  const ok = await res(WORLD, tail);
  for (const l of ["openapi", "surface", "cards", "rotate", "wallet"]) assert.equal(ok.at(l), "", `${l}: ${ok.out}`);
  const noSentence = await res({ seed: worldSeed(), after: (s, r) => (s.path === "/openapi.json" ? { ...r, body: r.body.split("or above the newest row id of its table, is refused with 400").join("x") } : undefined) }, tail);
  assert.match(noSentence.at("openapi"), /the cursor parameter of \/api\/inbox does not contain 'or above the newest row id of its table, is refused with 400'/);
  const oneOnly = await res({ seed: worldSeed(), after: (s, r) => (s.path === "/openapi.json" ? mutateJson(r, (j) => { j.paths["/api/guest/inbox"].get.parameters = [{ name: "guest" }]; }) : undefined) }, tail);
  assert.match(oneOnly.at("openapi"), /the cursor parameter of \/api\/guest\/inbox does not contain/);
  const noNote = await res({ seed: worldSeed(), after: (s, r) => (s.path === "/api/surface" ? mutateJson(r, (j) => { for (const x of j.routes) if (x.path === "/api/wallet") x.note = "assertion intent binding"; }) : undefined) }, tail);
  assert.match(noNote.at("surface"), /POST \/api\/wallet but its note does not name wallet_is_treasury/);
  const noRoute = await res({ seed: worldSeed(), after: (s, r) => (s.path === "/api/surface" ? mutateJson(r, (j) => { j.routes = j.routes.filter((x: any) => x.path !== "/api/wallet"); }) : undefined) }, tail);
  assert.match(noRoute.at("surface"), /GET \/api\/surface does not list POST \/api\/wallet/);
  const card404 = await res({ seed: worldSeed(), intercept: (s) => (s.path === "/.well-known/agent.json" ? jsonAns({ error: "x" }, 404) : undefined) }, tail);
  assert.match(card404.at("cards"), /GET \/\.well-known\/agent\.json answered 404, expected 200/);
  const cardHtml = await res({ seed: worldSeed(), intercept: (s) => (s.path === "/.well-known/agent-card.json" ? { status: 200, headers: { "content-type": "text/html" }, body: "<p>x</p>" } : undefined) }, tail);
  assert.match(cardHtml.at("cards"), /the content type is 'text\/html', expected application\/json/);
  const cardNoName = await res({ seed: worldSeed(), after: (s, r) => (s.path === "/.well-known/agent-card.json" ? mutateJson(r, (j) => { delete j.name; }) : undefined) }, tail);
  assert.match(cardNoName.at("cards"), /name is missing or empty/);
  const walletAccepted = await res({ seed: worldSeed(), intercept: (s) => (s.path === "/api/wallet" && s.method === "POST" ? jsonAns({ ok: true }) : undefined) }, tail);
  assert.match(walletAccepted.at("wallet"), /POST \/api\/wallet with no credential answered 200, expected 401/);
  const rotateText = await res({ seed: worldSeed(), after: (s, r) => (s.path === "/api/rotate" && s.method === "POST" ? mutateJson(r, (j) => { j.error = "Something else."; }) : undefined) }, tail);
  assert.match(rotateText.at("rotate"), /POST \/api\/rotate with no credential: the 401 error is 'Something else\.'/);
  const walletGet = await res({ seed: worldSeed(), intercept: (s) => (s.path === "/api/wallet" && s.method === "GET" ? jsonAns({}) : undefined) }, tail);
  assert.match(walletGet.at("wallet"), /GET \/api\/wallet answered 200, expected 404/);
});

test("Get-DisallowedPaths and Get-TreasuryAddress, run for real: the allowlist is exact and case-sensitive, a docs file other than the gate record is refused, an empty change is clean, and a malformed treasury address is never served as one", (t) => {
  const r = runPs([
    "$ErrorActionPreference = 'Stop'",
    defs,
    'Write-Host ("A [" + ((Get-DisallowedPaths @("scripts/deploy-ship-2026-11-24.ps1", "test/deploy-ship-2026-11-24-script.test.ts", "docs/REVIEW-WALLET-NOT-TREASURY-GATE-2026-11-24.md")) -join ",") + "]")',
    'Write-Host ("B [" + ((Get-DisallowedPaths @("src/society.ts", "docs/OTHER.md", "Scripts/deploy-ship-2026-11-24.ps1", "scripts/deploy-ship-2026-11-24.ps1.bak")) -join ",") + "]")',
    'Write-Host ("C [" + ((Get-DisallowedPaths @()) -join ",") + "]")',
    'Write-Host ("D [" + (Get-TreasuryAddress ([pscustomobject]@{ wallet = [pscustomobject]@{ address = "0x0000000000000000000000000000000000000001" } })) + "]")',
    'Write-Host ("E [" + (Get-TreasuryAddress ([pscustomobject]@{ wallet = [pscustomobject]@{ address = "0x12" } })) + "]")',
    'Write-Host ("F [" + (Get-TreasuryAddress ([pscustomobject]@{ x = 1 })) + "]")',
  ]);
  if (!r) return t.skip("no PowerShell available");
  assert.match(r.out, /^A \[\]/m);
  assert.match(r.out, /^B \[src\/society\.ts,docs\/OTHER\.md,Scripts\/deploy-ship-2026-11-24\.ps1,scripts\/deploy-ship-2026-11-24\.ps1\.bak\]/m);
  assert.match(r.out, /^C \[\]/m);
  assert.match(r.out, /^D \[0x0{39}1\]/m);
  assert.match(r.out, /^E \[\]/m);
  assert.match(r.out, /^F \[\]/m);
});

test("the dry run's text is accurate: it names only GETs, says it sends no POST and no wrangler command, and the closing note's door numbers are the reads the ride makes", () => {
  const dry = script.slice(script.indexOf('Say "[dry-run]'), script.indexOf("exit 0", script.indexOf('Say "[dry-run]')));
  assert.ok(dry.includes("Every live read was a GET") && dry.includes("sent NO POST") && dry.includes("no wrangler command at all"));
  assert.ok(dry.includes("C1") && dry.includes("D1 read replication"), "the dry run reminds Ben of the inbox gate's C1, which a script cannot read");
  const beforeStep2 = code.slice(code.indexOf("$attBefore = Read-Attest"), code.indexOf("if ($DryRun)"));
  assert.equal(/Get-PostAnswer|Get-JsonPost|-X POST/.test(beforeStep2), false, "no POST before the dry-run exit");
  assert.ok(script.includes("The pre-deploy GETs added nothing"), "the closing note says what the dry run did to the door figures");
  assert.equal(/agent_card 2|11 counted|probe door|a2a_send/i.test(code), false, "no leftover from the A2A ride");
});
