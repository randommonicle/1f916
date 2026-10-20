// scripts/deploy-received-elsewhere.ps1 is WRITTEN AND NEVER RUN by the builder (hard rule: no deploy, no wrangler command, not even -DryRun, which reads the live worker over HTTP).
// It is proven here by everything that can be proven without running it: it parses under PowerShell's own parser, it is ASCII with LF line endings, it has none of the traps the repo's L-080
// family names, its steps are in the load-bearing order (the two pins FIRST, fetch, template check, no-migration check, reviewed source, the catch-up code present, gates, the live probes,
// dry-run exit, deploy, version id, poll, attest, ride), it has NO migration step and touches no D1 at all, step 0a stops on EITHER placeholder before any git or network command, and the ride is
// public GETs ONLY. Its decision functions are run for real under PowerShell against what the real code serves (guestDue) and each is shown to answer differently on a body that breaks one thing.
// The pattern is test/deploy-received-elsewhere-script.test.ts, of which the shared checks are copies.
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
import { createLocalD1, guestEnv, seedCitizens } from "./helpers/guest.ts";
import { RECEIVED_ELSEWHERE } from "../src/guest-core.ts";
import { guestDue } from "../src/guest.ts";

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
const SCRIPT_PATH = here("../scripts/deploy-received-elsewhere.ps1");
const rawScript = readFileSync(SCRIPT_PATH, "utf8");
const script = rawScript.replace(/\r\n/g, "\n");
// Code lines only: a comment may name a trap it avoids.
const code = script
  .split("\n")
  .filter((l) => !/^\s*#/.test(l))
  .join("\n");
const at = (needle: string, from = 0) => {
  const i = code.indexOf(needle, from);
  assert.ok(i >= 0, `the script must contain: ${needle}`);
  return i;
};
const DEFS_END = "# END-OF-DEFINITIONS";
const block = (name: string): string => script.slice(script.indexOf(`# BEGIN-${name}`), script.indexOf(`# END-${name}`));
const defs = script.slice(script.indexOf('$ErrorActionPreference = "Stop"'), script.indexOf(DEFS_END));
const pinBlock = block("PIN-CHECK");
const reviewedBlock = block("REVIEWED-SOURCE-CHECK");

type PsRun = { code: number | null; out: string };
// A PowerShell 5.1 harness. The .ps1 is written ASCII-only; data goes in files read with -Encoding UTF8.
function runPs(lines: string[], files: Record<string, string> = {}): PsRun | null {
  const dir = mkdtempSync(join(tmpdir(), "deploy-received-elsewhere-"));
  try {
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    const ps1 = join(dir, "harness.ps1");
    writeFileSync(ps1, lines.map((l) => l.replaceAll("@DIR@", dir)).join("\r\n"));
    const r = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1], { encoding: "utf8" });
    if (r.error) return null;
    return { code: r.status, out: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const deepCopy = <T>(o: T): T => JSON.parse(JSON.stringify(o)) as T;
const getFile = (f: string) => `(Get-Content -Raw -Encoding UTF8 '@DIR@\\${f}')`;
const THROWING_STUBS = ["npx", "git", "npm", "curl.exe"].map((n) => `function ${n} { throw "${n} must not run while the definitions are evaluated" }`);
const PS_DEFS = ["$ErrorActionPreference = 'Stop'", ...THROWING_STUBS, defs];

// ---------- the static proofs ----------

test("the script parses under PowerShell's own parser with zero errors, is ASCII only and has LF line endings", (t) => {
  assert.equal(/[^\x00-\x7f]/.test(rawScript), false, "5.1 reads a BOM-less UTF-8 script as the ANSI code page: ASCII only");
  assert.equal(rawScript.includes("\r"), false, "LF line endings only");
  const parsed = parsePowerShellFile(SCRIPT_PATH);
  if (!parsed.available) {
    t.skip(`${parsed.reason}; the static checks below still run`);
    return;
  }
  assert.equal(parsed.errors, 0, `parse errors: ${parsed.detail}`);
});

test("no PowerShell traps: no two variables differing only by case, no `$var:` drive reference, no stderr merged outside a Continue block, no -notmatch over a pipeline, no -and mixed with -or on one line", () => {
  const names = new Map<string, Set<string>>();
  for (const m of code.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)) {
    const set = names.get(m[1].toLowerCase()) ?? new Set<string>();
    set.add(m[1]);
    names.set(m[1].toLowerCase(), set);
  }
  const clashes = [...names.values()].filter((s) => s.size > 1).map((s) => [...s].join(" / "));
  assert.deepEqual(clashes, [], "a variable name is case-insensitive in PowerShell: one spelling each");
  assert.equal(/\$[A-Za-z_][A-Za-z0-9_]*:/.test(code.replace(/\$\(/g, "")), false, '"$var:" is a drive reference: write "${var}:"');
  for (const m of code.matchAll(/2>&1/g)) {
    const before = code.slice(0, m.index);
    assert.ok(before.lastIndexOf('$ErrorActionPreference = "Continue"') > before.lastIndexOf('$ErrorActionPreference = "Stop"'), "a native command's stderr is merged only while ErrorActionPreference is Continue");
  }
  assert.equal(/\$\w+\s*\|\s*Where-Object[^\n]*-notmatch/.test(code), false, "no -notmatch over a pipeline of lines");
  assert.equal(/-notcontains|-notin\b/.test(code.replace(/-cnotcontains/g, "")), false, "a case-insensitive membership test would pass a key spelled in another case: use -cnotcontains");
  const mixed = (s: string) => /\s-and\s/.test(s) && /\s-or\s/.test(s);
  for (const line of code.split("\n")) {
    let rest = line.replace(/"[^"]*"|'[^']*'/g, '""');
    for (let guard = 0; guard < 50 && /\([^()]*\)/.test(rest); guard++) {
      for (const m of rest.matchAll(/\(([^()]*)\)/g)) assert.equal(mixed(m[1]!), false, `a group mixes -and with -or: ${line.trim().slice(0, 120)}`);
      rest = rest.replace(/\([^()]*\)/g, "X");
    }
    assert.equal(mixed(rest), false, `a line mixes -and with -or: ${line.trim().slice(0, 120)}`);
  }
  assert.equal(mixed("if ($a -eq 1 -and $b -or $c)"), true, "positive control: the check can fail");
});

test("parameters: -ExpectedCommit is mandatory and -DryRun exists; there is NO -MigrationAlreadyApplied, because there is no migration", () => {
  assert.match(script, /\[Parameter\(Mandatory = \$true\)\]\[string\]\$ExpectedCommit/);
  assert.match(script, /\[switch\]\$DryRun/);
  assert.equal(/MigrationAlreadyApplied/.test(script), false);
});

test("the pins: the v5 hash, the live base (the tool-call counter wave's deployed commit), the reviewed commit (the hub's placeholder or a full 40-hex sha) and the allowlist", () => {
  assert.match(script, /^\$V5_HASH = "fa11788d062b0c6d23c54c428c1c9649d263ae3ba704e602e122066926049491"$/m);
  assert.match(script, /^\$LIVE_BASE_COMMIT = "3818e23f25efcbfbef8f1b3c22183d75a84ee447"$/m);
  assert.match(script, /^\$REVIEWED_COMMIT = "(?:TO-BE-SET-BY-HUB|[0-9a-f]{40})"$/m, "the reviewed commit is the hub's placeholder or a full 40-hex sha");
  assert.match(script, /^\$LIVE_BASE_PLACEHOLDER = "TO-BE-SET-BY-HUB-LIVE-BASE"$/m);
  assert.match(script, /^\$REVIEWED_COMMIT_PLACEHOLDER = "TO-BE-SET-BY-HUB"$/m);
  const allowed = /\$ALLOWED_PATHS_AFTER_REVIEW = @\(([^)]*)\)/.exec(code)?.[1] ?? "";
  assert.deepEqual([...allowed.matchAll(/"([^"]+)"/g)].map((m) => m[1]), ["scripts/deploy-received-elsewhere.ps1", "test/deploy-received-elsewhere-script.test.ts", "docs/"]);
  assert.equal([...code.matchAll(/\$ALLOWED_PATHS_AFTER_REVIEW = /g)].length, 1, "stated once");
  assert.match(code, /\$ROLLBACK_LINE = .*\$rollbackTarget/, "the rollback line names the version read from the live worker");
  assert.match(code, /\$ROLLBACK_LINE = .*applied no migration and wrote no row, so the rollback is the whole undo/, "and says the rollback is the whole undo");
  assert.equal(/\$ROLLBACK_WORKER_VERSION/.test(code), false, "no typed-in rollback version: it is read live, before the deploy");
});

test("the committed-state check accepts the placeholder OR 40 lower-case hex and rejects an upper-case sha, and the same check can fail", () => {
  const accepts = (line: string) => /^\$REVIEWED_COMMIT = "(?:TO-BE-SET-BY-HUB|[0-9a-f]{40})"$/m.test(line);
  assert.equal(accepts('$REVIEWED_COMMIT = "TO-BE-SET-BY-HUB"'), true);
  assert.equal(accepts('$REVIEWED_COMMIT = "' + "0123456789abcdef".repeat(2) + "01234567" + '"'), true);
  assert.equal(accepts('$REVIEWED_COMMIT = "' + "0123456789ABCDEF".repeat(2) + "01234567" + '"'), false, "an upper-case sha is refused");
  assert.equal(accepts('$REVIEWED_COMMIT = "0123456"'), false, "a short sha is refused");
  assert.equal(accepts('$REVIEWED_COMMIT = "TO-BE-SET-BY-HUB-LIVE-BASE"'), false, "another placeholder is refused");
});

test("step 0a STOPS before ANY git, npm, wrangler or network command while EITHER pin is its placeholder (or is not 40 lower-case hex); it is the first thing after the definitions", (t) => {
  assert.ok(pinBlock.length > 300, "the pin block exists");
  assert.ok(at("$LIVE_BASE_COMMIT -ceq $LIVE_BASE_PLACEHOLDER") < at("git fetch origin --quiet"), "the live-base pin is checked before the fetch");
  assert.ok(at("$REVIEWED_COMMIT -ceq $REVIEWED_COMMIT_PLACEHOLDER") < at("git fetch origin --quiet"), "the reviewed pin is checked before the fetch");
  assert.ok(at("$LIVE_BASE_COMMIT -cnotmatch") < at("git merge-base --is-ancestor $LIVE_BASE_COMMIT HEAD"), "a malformed live base can never reach git merge-base");
  for (const forbidden of ["git ", "npm ", "npx ", "curl.exe", "Get-Text", "Read-Attest"]) {
    assert.equal(pinBlock.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n").includes(forbidden), false, `the pin block never calls ${forbidden.trim()}`);
  }
  const run = (live: string, reviewed: string) => runPs([...PS_DEFS, `$LIVE_BASE_COMMIT = '${live}'`, `$REVIEWED_COMMIT = '${reviewed}'`, pinBlock, "Write-Output 'PAST-PINS'"]);
  const sha40 = "0123456789abcdef0123456789abcdef01234567";
  const both = run("TO-BE-SET-BY-HUB-LIVE-BASE", "TO-BE-SET-BY-HUB");
  if (!both) return t.skip("powershell is not available on this machine");
  const liveOnly = run("TO-BE-SET-BY-HUB-LIVE-BASE", sha40);
  const reviewedOnly = run(sha40, "TO-BE-SET-BY-HUB");
  const shortLive = run("abc1234", sha40);
  const upperReviewed = run(sha40, sha40.toUpperCase());
  const good = run(sha40, sha40);
  for (const [label, r, pattern] of [
    ["both placeholders", both, /\[STOP\].*LIVE_BASE_COMMIT still holds the placeholder/],
    ["the live-base placeholder alone", liveOnly, /\[STOP\].*LIVE_BASE_COMMIT still holds the placeholder/],
    ["the reviewed placeholder alone (the state this script is committed in)", reviewedOnly, /\[STOP\].*REVIEWED_COMMIT still holds the placeholder/],
    ["a short live base", shortLive, /\[STOP\].*LIVE_BASE_COMMIT 'abc1234' is not 40 lower-case hex/],
    ["an upper-case reviewed sha", upperReviewed, /\[STOP\].*REVIEWED_COMMIT '[0-9A-F]{40}' is not 40 lower-case hex/],
  ] as const) {
    assert.equal(r!.code, 1, `${label}: exit 1, got ${r!.code}: ${r!.out}`);
    assert.match(r!.out, pattern, label);
    assert.match(r!.out, /Nothing was read or written/, `${label}: says so`);
    assert.equal(/PAST-PINS/.test(r!.out), false, `${label}: must not pass`);
    assert.equal(/must not run while the definitions/.test(r!.out), false, `${label}: touched git, npm, wrangler or curl before stopping`);
  }
  assert.equal(good!.code, 0, good!.out);
  assert.match(good!.out, /PAST-PINS/, "positive control: two real shas pass the block");
});

test("as committed, the pins block decides on the value the file holds: the hub's placeholder STOPS at step 0a before anything is fetched, tested, read or deployed; a full 40-hex sha set by the hub after the review passes it", (t) => {
  const reviewed = /^\$REVIEWED_COMMIT = "([^"]+)"$/m.exec(script)![1];
  const isPlaceholder = reviewed === "TO-BE-SET-BY-HUB";
  assert.ok(isPlaceholder || /^[0-9a-f]{40}$/.test(reviewed), "$REVIEWED_COMMIT is the placeholder or a full 40-hex sha, not '" + reviewed + "'");
  const r = runPs([
    ...PS_DEFS,
    `$LIVE_BASE_COMMIT = '${/^\$LIVE_BASE_COMMIT = "([^"]+)"$/m.exec(script)![1]}'`,
    `$REVIEWED_COMMIT = '${reviewed}'`,
    pinBlock,
    "Write-Output 'PAST-PINS'",
  ]);
  if (!r) return t.skip("powershell is not available on this machine");
  if (isPlaceholder) {
    assert.equal(r.code, 1);
    assert.match(r.out, /REVIEWED_COMMIT still holds the placeholder/);
    assert.equal(/PAST-PINS/.test(r.out), false);
  } else {
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /PAST-PINS/, "the hub's sha passes the pins block");
  }
});

let evaluated: Record<string, string> | null | undefined;
function definitions(t: { skip: (m: string) => void }): Record<string, string> | null {
  if (evaluated === undefined) {
    const r = runPs([...PS_DEFS, 'Write-Output ("TRIES=" + $POLL_TRIES)', 'Write-Output ("DELAY=" + $POLL_DELAY_SECONDS)', 'Write-Output "EVALUATED-OK"']);
    if (!r) evaluated = null;
    else {
      assert.equal(r.code, 0, `the definitions region must evaluate cleanly: ${r.out}`);
      assert.match(r.out, /EVALUATED-OK/);
      evaluated = Object.fromEntries([...r.out.matchAll(/^([A-Z0-9_]+)=(.*)$/gm)].map((m) => [m[1], m[2].replace(/\r$/, "")]));
    }
  }
  if (evaluated === null) t.skip("powershell is not available on this machine");
  return evaluated ?? null;
}

test("the definitions region runs nothing, and the poll is bounded (12 tries 5 s apart)", (t) => {
  const d = definitions(t);
  if (!d) return;
  assert.equal(d.TRIES, "12");
  assert.equal(d.DELAY, "5");
});

test("the reviewed-source check stops when HEAD does not contain the reviewed commit or a path outside the allowlist changed (the placeholder stop lives in step 0a)", (t) => {
  if (!definitions(t)) return;
  assert.equal(/still holds the placeholder/.test(reviewedBlock), false, "the placeholder stop lives in the pin block, before any git command");
  const run = (changed: string[]) =>
    runPs([
      ...PS_DEFS,
      "$REVIEWED_COMMIT = '0123456789abcdef0123456789abcdef01234567'",
      "$headSha = 'fedcba9876543210fedcba9876543210fedcba98'",
      "function git { $global:LASTEXITCODE = 0; if ($args -contains '--name-only') { return @('" + changed.join("','") + "') } }",
      reviewedBlock,
      "Write-Output 'PAST-REVIEW'",
    ]);
  const clean = run(["scripts/deploy-received-elsewhere.ps1", "docs/CHECKPOINT-RECEIVED-ELSEWHERE.md", "test/deploy-received-elsewhere-script.test.ts"]);
  if (!clean) return t.skip("powershell is not available on this machine");
  assert.match(clean.out, /PAST-REVIEW/, clean.out);
  const dirty = run(["src/society.ts"]);
  assert.equal(dirty!.code, 1);
  assert.match(dirty!.out, /not on the allowlist/);
  assert.equal(/PAST-REVIEW/.test(dirty!.out), false);
  const migration = run(["migrations/0022_x.sql"]);
  assert.equal(migration!.code, 1, "a migration after the review is refused too");
  const other = run(["scripts/deploy-seat-counts.ps1"]);
  assert.equal(other!.code, 1, "another deploy script is not on this script's allowlist");
});

test("Get-TemplateText (run for real): it extracts FRONT_DOOR_TEMPLATE from the real src/doc.ts, a change OUTSIDE the template does not change it, a byte INSIDE it does, an escaped backtick does not end it, and a missing marker is null", (t) => {
  if (!definitions(t)) return;
  const docTs = readFileSync(here("../src/doc.ts"), "utf8");
  const marker = "export const FRONT_DOOR_TEMPLATE = `";
  const start = docTs.indexOf(marker);
  assert.ok(start > 0, "the template marker is in src/doc.ts");
  let i = start + marker.length;
  let end = -1;
  while (end < 0) {
    const j = docTs.indexOf("`", i);
    assert.ok(j > 0, "the template has a closing backtick");
    if (docTs[j - 1] === "\\") i = j + 1;
    else end = j;
  }
  const expected = docTs.slice(start, end + 1).replace(/\r\n/g, "\n");
  assert.ok(expected.length > 10_000, "the attested template is large; the extraction is not vacuous");
  const doc = docTs.replace(/\r\n/g, "\n");
  const outsideEdit = doc.replace("export function showhomeDoorNote", "// an edit outside the template\nexport function showhomeDoorNote");
  const insideEdit = doc.replace("export const FRONT_DOOR_TEMPLATE = `", "export const FRONT_DOOR_TEMPLATE = `X");
  assert.ok(outsideEdit.indexOf("// an edit outside the template") > end, "the outside edit really lies after the template");
  const r = runPs(
    [
      ...PS_DEFS,
      "$a = Get-TemplateText (Get-Content -Raw -Encoding UTF8 '@DIR@\\a.txt')",
      "$b = Get-TemplateText (Get-Content -Raw -Encoding UTF8 '@DIR@\\b.txt')",
      "$c = Get-TemplateText (Get-Content -Raw -Encoding UTF8 '@DIR@\\c.txt')",
      "$d = Get-TemplateText (Get-Content -Raw -Encoding UTF8 '@DIR@\\d.txt')",
      "$e = Get-TemplateText 'no marker here'",
      "Write-Output ('LEN=' + $a.Length)",
      "Write-Output ('OUTSIDE-SAME=' + ($a -ceq $b))",
      "Write-Output ('INSIDE-DIFFERS=' + ($a -cne $c))",
      "Write-Output ('ESCAPED-OK=' + ($d -ceq ('export const FRONT_DOOR_TEMPLATE = ' + [char]96 + 'one ' + [char]92 + [char]96 + ' two' + [char]96)))",
      "Write-Output ('MISSING=' + ($null -eq $e))",
    ],
    {
      "a.txt": doc,
      "b.txt": outsideEdit,
      "c.txt": insideEdit,
      "d.txt": "head\nexport const FRONT_DOOR_TEMPLATE = `one \\` two`;\nexport function after() { return `x`; }\n",
    },
  );
  if (!r) return t.skip("powershell is not available on this machine");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`LEN=${expected.length}`), "the PowerShell slice has the TypeScript slice's length");
  assert.match(r.out, /OUTSIDE-SAME=True/);
  assert.match(r.out, /INSIDE-DIFFERS=True/);
  assert.match(r.out, /ESCAPED-OK=True/);
  assert.match(r.out, /MISSING=True/);
});

test("Get-DisallowedPaths and Get-TestSummary (run for real): only this script, its test and docs/ pass the allowlist; a summary that does not end the output is not read", (t) => {
  if (!definitions(t)) return;
  const r = runPs([
    ...PS_DEFS,
    "$bad = @(Get-DisallowedPaths @('scripts/deploy-received-elsewhere.ps1', 'test/deploy-received-elsewhere-script.test.ts', 'docs/CHECKPOINT-RECEIVED-ELSEWHERE.md', 'src/society.ts', 'migrations/0022_x.sql', 'docs', 'Docs/x.md', 'scripts/deploy-seat-counts.ps1'))",
    "Write-Output ('BAD=' + ($bad -join ','))",
    "$tail = \"tests 10`r`nsuites 0`r`npass 9`r`nfail 0`r`ncancelled 0`r`nskipped 1`r`ntodo 0`r`nduration_ms 12.5`r`n\"",
    "$s = Get-TestSummary $tail",
    "Write-Output ('SUMMARY=' + $s.Pass + '/' + $s.Fail + '/' + $s.SumOk)",
    "$notEnd = Get-TestSummary ($tail + 'trailing failure detail')",
    "Write-Output ('NOTEND=' + ($null -eq $notEnd))",
  ]);
  if (!r) return t.skip("powershell is not available on this machine");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /BAD=src\/society\.ts,migrations\/0022_x\.sql,docs,Docs\/x\.md,scripts\/deploy-seat-counts\.ps1/, "src/, migrations/, a docs look-alike and another deploy script are not on the allowlist");
  assert.match(r.out, /SUMMARY=9\/0\/True/);
  assert.match(r.out, /NOTEND=True/);
});


// ---------- the static proofs specific to this script ----------

test("the steps are in the load-bearing order: pins, fetch, branch, clean tree, ancestry, template check, no-migration check, reviewed source, the catch-up code present, gates, probes (live base proved, old list present), (dry-run exit), deploy, version id, poll, attest, ride", () => {
  const order = [
    "$LIVE_BASE_COMMIT -ceq $LIVE_BASE_PLACEHOLDER",
    "$REVIEWED_COMMIT -ceq $REVIEWED_COMMIT_PLACEHOLDER",
    "git fetch origin --quiet",
    "rev-parse --abbrev-ref HEAD",
    "git status --porcelain",
    "git merge-base --is-ancestor $LIVE_BASE_COMMIT HEAD",
    "$liveTemplate -cne $headTemplate",
    "--name-status --no-renames $LIVE_BASE_COMMIT HEAD -- migrations schema.sql",
    "git merge-base --is-ancestor $REVIEWED_COMMIT HEAD",
    "Get-DisallowedPaths $afterReview",
    'Pattern "cf412908-5fc1-44f2-b11c-4fb4a5bc241a"',
    "$testOut = (npm test",
    "$attBefore = Read-Attest",
    "[string]$attBefore.code.commit -cne $LIVE_BASE_COMMIT",
    "Test-ReceivedElsewherePreWave $dueBefore.Body",
    "if ($DryRun)",
    "npx wrangler deploy --var",
    "Current Version ID",
    "Wait-NewWorker $headSha $versionId",
    "$attAfter = Read-Attest",
    "$dueWhy = Test-ReceivedElsewhereCaughtUp $dueNow.Body",
    "Writes made by this ride: NONE",
  ];
  let from = 0;
  for (const needle of order) from = at(needle, from) + 1;
});

test("NO migration and NO D1 access of any kind: no wrangler d1, no migration apply; the one wrangler command is the stamped deploy", () => {
  assert.equal(/wrangler d1|d1 execute|--file|migrationPath|MIGRATION_|MigrationAlreadyApplied/.test(code), false, "no D1 and no migration in the executed code");
  const calls = [...code.matchAll(/^\s*(?:\$\w+ = \()?npx wrangler ([a-z0-9]+)/gm)].map((m) => m[1]);
  assert.deepEqual(calls, ["deploy"], "exactly one executed wrangler subcommand, and it is deploy");
  assert.match(code, /npx wrangler deploy --var "CODE_COMMIT:\$headSha"/, "the deploy stamps the pinned full sha");
  assert.match(code, /\$schemaMoves = @\(git diff --name-status --no-renames \$LIVE_BASE_COMMIT HEAD -- migrations schema\.sql\)/);
  assert.match(code, /\$schemaMoves\.Count -gt 0\) \{ Stop-Here/);
});

test("the ride is public GETs ONLY: no POST of any kind, no credential, one curl.exe command (inside Get-Text), the changed surface is asserted, and the closing log says it wrote nothing", () => {
  assert.equal(/Authorization|Bearer|ch1\.|guest_enter|guest_comment|showhome_note|resident_|initialize/.test(code), false, "nothing in the executed code carries a credential or a write route");
  assert.equal(/-X\s|--request|--data|-d\s+["'@]|--form|-F\s|--upload-file|-T\s|\bPOST\b|\bPUT\b|\bPATCH\b|\bDELETE\b|Invoke-WebRequest|Invoke-RestMethod|-Method\b/.test(code), false, "no HTTP method but GET ever appears");
  assert.equal([...code.matchAll(/curl\.exe/g)].length, 1, "exactly one curl.exe command in the whole script (inside Get-Text)");
  assert.match(code, /curl\.exe -s --max-time \$maxTime -o \$tmp -w "%\{http_code\}" \$url/, "and it is a plain GET");
  assert.match(code, /\$dueWhy -ne ""\) \{ Stop-Here/, "a reason STOPS the ride");
  assert.match(code, /Test-DueNoteWording \$dueNow\.Body\)\) \{ Stop-Here/, "the note wording");
  assert.match(code, /\$dutyAfter -cne \$dutyBefore/, "the duty counts are compared across the deploy");
  assert.match(code, /Writes made by this ride: NONE\. Every request was a GET/);
  assert.match(script, /WRITES NOTHING/);
  assert.match(script, /NO POST OF ANY KIND/);
});

test("it stops unless main, origin/main and -ExpectedCommit are ONE commit, after a fetch, on a clean tree, and HEAD is 40 lower-case hex (the stamp); non-minting is checked on the template text and on v5 plus every chain before and after", () => {
  assert.match(code, /\$mainSha -cne \$originSha -or \$mainSha -cne \$expectedSha -or \$headSha -cne \$expectedSha/);
  assert.match(code, /\$headSha -cnotmatch '\^\[0-9a-f\]\{40\}\$'/);
  assert.match(code, /\$dirty\.Count -gt 0\) \{ Stop-Here/);
  assert.ok(at("git fetch origin --quiet") < at("$mainSha = (git rev-parse main)"));
  assert.match(code, /Assert-Attest \$attBefore "before the deploy"/);
  assert.match(code, /Assert-Attest \$attAfter "after the deploy"/);
  assert.match(code, /\$liveTemplate -cne \$headTemplate\) \{ Stop-Here/);
});

test("step 0 requires the catch-up code in the checkout (the new entry id and the new wording) and the tool-call counter wave it must not drop", () => {
  for (const [file, needle] of [
    ["src/guest-core.ts", "cf412908-5fc1-44f2-b11c-4fb4a5bc241a"],
    ["src/guest-core.ts", "each entry is a comment or note at its url"],
    ["src/doors.ts", '"mcp_read_tool_call"'],
  ] as const) {
    assert.ok(readFileSync(here(`../${file}`), "utf8").includes(needle), `${file} really contains: ${needle}`);
  }
  assert.match(code, /Select-String -Path "src\/guest-core\.ts" -Pattern "cf412908-5fc1-44f2-b11c-4fb4a5bc241a" -SimpleMatch -Quiet/);
});

test("the pre-deploy probe, the poll and the ride are keyed on the same ten ids as the served list, typed in the script and not imported", () => {
  const typed = /^\$NEW_IDS = @\((.*)\)$/m.exec(script)![1]!;
  const ids = [...typed.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(ids, RECEIVED_ELSEWHERE.map((e) => e.comment_id), "the script names exactly the served comment_ids, in order");
  assert.match(script, /^\$NEW_COUNT = 10$/m);
  assert.match(script, /^\$OLD_COUNT = 4$/m);
  assert.match(script, /^\$NEW_ONLY_ID = "cf412908-5fc1-44f2-b11c-4fb4a5bc241a"$/m);
  assert.ok(ids.includes(RECEIVED_ELSEWHERE.at(4)!.comment_id));
});

// ---------- the decision functions, run for real against what guestDue really serves ----------

test("Test-ReceivedElsewhereCaughtUp, Test-ReceivedElsewherePreWave, Get-DutyCounts and Test-DueNoteWording (run for real): the body guestDue really serves passes; each body that breaks one thing is refused with its own reason; the old list is 'pre-wave'", async (t) => {
  if (!definitions(t)) return;
  const d1 = createLocalD1();
  try {
    seedCitizens(d1);
    const due: any = await guestDue(guestEnv(d1), null, null, null, Date.now());
    assert.equal(due.received_elsewhere_count, 10);
    const mutants: Record<string, (o: any) => void> = {
      absent: (o) => delete o.received_elsewhere,
      count_wrong: (o) => (o.received_elsewhere_count = 3),
      count_a_string: (o) => (o.received_elsewhere_count = "3"),
      list_old: (o) => {
        o.received_elsewhere = o.received_elsewhere.slice(0, 4);
        o.received_elsewhere_count = 4;
      },
      an_id_missing: (o) => (o.received_elsewhere[6].comment_id = "36305"),
      entry_without_url: (o) => (o.received_elsewhere[0].url = ""),
      entry_without_answer: (o) => (o.received_elsewhere[5].answered_by = []),
      answer_without_id: (o) => (o.received_elsewhere[8].answered_by[0].comment_id = ""),
      accrued_wrong: (o) => (o.counts.accrued = 99),
    };
    const files: Record<string, string> = { "ok.json": JSON.stringify(due), "junk.json": "not json" };
    const lines = [...PS_DEFS, `Write-Output ('OK=[' + (Test-ReceivedElsewhereCaughtUp ${getFile("ok.json")}) + ']')`, `Write-Output ('JUNK=[' + (Test-ReceivedElsewhereCaughtUp ${getFile("junk.json")}) + ']')`];
    for (const [name, mutate] of Object.entries(mutants)) {
      const o = deepCopy(due);
      mutate(o);
      files[`m_${name}.json`] = JSON.stringify(o);
      lines.push(`Write-Output ('M_${name}=[' + (Test-ReceivedElsewhereCaughtUp ${getFile(`m_${name}.json`)}) + ']')`);
    }
    const old = deepCopy(due);
    old.received_elsewhere = old.received_elsewhere.slice(0, 4);
    old.received_elsewhere_count = 4;
    files["old.json"] = JSON.stringify(old);
    const mixed = deepCopy(due);
    mixed.received_elsewhere_count = 4;
    files["mixed.json"] = JSON.stringify(mixed);
    const oldWithNew = deepCopy(old);
    oldWithNew.received_elsewhere[3].comment_id = "cf412908-5fc1-44f2-b11c-4fb4a5bc241a";
    files["oldwithnew.json"] = JSON.stringify(oldWithNew);
    const plainNote = deepCopy(due);
    plainNote.note = String(plainNote.note).replace("a comment or note at its url", "a comment on the post at its url");
    files["plainnote.json"] = JSON.stringify(plainNote);
    const noClause = deepCopy(due);
    noClause.note = String(noClause.note).replace("; both are null where the platform serves no self-description", "");
    files["noclause.json"] = JSON.stringify(noClause);
    for (const [label, f] of [["NEW", "ok.json"], ["OLD", "old.json"], ["MIXED", "mixed.json"], ["OLDWITHNEW", "oldwithnew.json"]] as const) {
      lines.push(`Write-Output ('PRE_${label}=' + (Test-ReceivedElsewherePreWave ${getFile(f)}))`);
    }
    lines.push("Write-Output ('PRE_JUNK=' + (Test-ReceivedElsewherePreWave 'not json'))");
    lines.push(`Write-Output ('DUTY=[' + (Get-DutyCounts ${getFile("ok.json")}) + ']')`, "Write-Output ('DUTY_JUNK=[' + (Get-DutyCounts 'not json') + ']')");
    for (const [label, f] of [["OK", "ok.json"], ["PLAIN", "plainnote.json"], ["NOCLAUSE", "noclause.json"]] as const) {
      lines.push(`Write-Output ('NOTE_${label}=' + (Test-DueNoteWording ${getFile(f)}))`);
    }
    const r = runPs(lines, files);
    if (!r) return t.skip("powershell is not available on this machine");
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /OK=\[\]/, "what the code really serves passes, with no reason");
    assert.match(r.out, /JUNK=\[GET \/api\/guest\/due did not return JSON\]/);
    const reasons: Record<string, RegExp> = {
      absent: /received_elsewhere is absent/,
      count_wrong: /received_elsewhere_count 3 is not the list length 10/,
      count_a_string: /received_elsewhere_count is '3', expected a whole number/,
      list_old: /received_elsewhere has 4 entries, expected 10/,
      an_id_missing: /received_elsewhere has no entry with comment_id 36304/,
      entry_without_url: /a received_elsewhere entry has no url/,
      entry_without_answer: /received_elsewhere entry 1ed54728-eedc-4dc1-a125-fbc51da3a287 names no answering comment/,
      answer_without_id: /received_elsewhere entry 36667 has an answering comment without an identity or an id/,
      accrued_wrong: /counts\.accrued 99 is not the sum of the other five/,
    };
    for (const name of Object.keys(mutants)) assert.match(r.out, new RegExp(`M_${name}=\\[[^\\]\\r\\n]+\\]`), `${name}: refused with a reason`);
    for (const [name, pattern] of Object.entries(reasons)) {
      const line = r.out.split("\n").find((l) => l.startsWith(`M_${name}=`)) ?? "";
      assert.match(line, pattern, `${name}: the reason names the broken thing`);
    }
    assert.match(r.out, /PRE_NEW=False/, "the new list is not pre-wave");
    assert.match(r.out, /PRE_OLD=True/, "the old four-entry list is");
    assert.match(r.out, /PRE_MIXED=False/, "a count that disagrees with the list is not");
    assert.match(r.out, /PRE_OLDWITHNEW=False/, "four entries that already carry the new id are not");
    assert.match(r.out, /PRE_JUNK=False/);
    assert.match(r.out, /DUTY=\[accrued 0, open 0, overdue 0, answered_in_time 0, answered_late 0, waived 0\]/);
    assert.match(r.out, /DUTY_JUNK=\[\]/, "unreadable counts read as nothing, which the script stops on");
    assert.match(r.out, /NOTE_OK=True/);
    assert.match(r.out, /NOTE_PLAIN=False/, "the old wording is not the new wording");
    assert.match(r.out, /NOTE_NOCLAUSE=False/, "a note without the null clause is refused");
  } finally {
    d1.close();
  }
});

test("the old list the script expects is the penny-three list: the four ids it expects to be live are the first four entries served now", () => {
  const first4 = RECEIVED_ELSEWHERE.slice(0, 4).map((e) => e.comment_id);
  const typed = /^\$NEW_IDS = @\((.*)\)$/m.exec(script)![1]!;
  assert.deepEqual([...typed.matchAll(/"([^"]+)"/g)].map((m) => m[1]).slice(0, 4), first4);
});
