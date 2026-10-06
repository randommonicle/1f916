// scripts/deploy-refused-option-b.ps1 is run only by Ben (D-017). Proven here by what can be proven without wrangler, the network or a deploy: it parses and is ASCII;
// its steps are in the load-bearing order; the SQL it builds is pinned to the source (the C1 statement IS the one runReconciler runs, with its binds substituted and the
// gate's far-future `now`; the five states are migration 0017's; the anti-join is RESERVATION_BOUND with the claim's own pin, and agrees with listingReservationState on a
// fixture matrix); the three prod checks are run FOR REAL in PowerShell against a stand-in for npx (pass, and every STOP); and the constants it carries (the v5 hash, the live
// base commit, the step-0 sentinels) are each pinned to a source of truth. The script's definitions region is evaluated with throwing stubs for npx, git, npm and curl, so a
// stray top-level command there turns this test red instead of running.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parsePowerShellFile } from "./helpers/ps-parse.ts";
import { createLocalD1, insertListing } from "./helpers/local-d1.ts";
import { RECONCILE_BATCH_ROWS, runReconciler } from "../src/settlement-reconcile.ts";
import { CHAIN_SPENT_MARKER, CLAIM_HANDLE_TAKEN, CLAIM_LISTING_NOT_PAYING } from "../src/settlement-attention.ts";
import { RESERVATION_BOUND, listingReservationState, reservationArgs, type ClaimRow } from "../src/settlement-claims.ts";
import { computeLiveConstitutionPair } from "../src/governance.ts";
import type { Env } from "../src/society.ts";

const here = (p: string): string => fileURLToPath(new URL(p, import.meta.url));
const SCRIPT_PATH = here("../scripts/deploy-refused-option-b.ps1");
const script = readFileSync(SCRIPT_PATH, "utf8");
const migration0017 = readFileSync(here("../migrations/0017_settlement_claims.sql"), "utf8");
const claimsSource = readFileSync(here("../src/settlement-claims.ts"), "utf8");
const gateRecord = readFileSync(here("../docs/REVIEW-REFUSED-OPTION-B-GATE-2026-10-06.md"), "utf8");
const code = script
  .split(/\r?\n/)
  .filter((l) => !/^\s*#/.test(l))
  .join("\n");

const DEFS_END = "# END-OF-DEFINITIONS";
const defs = script.slice(script.indexOf('$ErrorActionPreference = "Stop"'), script.indexOf(DEFS_END));
const checksBlock = script.slice(script.indexOf("# BEGIN-PROD-CHECKS"), script.indexOf("# END-PROD-CHECKS"));
const reviewedBlock = script.slice(script.indexOf("# BEGIN-REVIEWED-SOURCE-CHECK"), script.indexOf("# END-REVIEWED-SOURCE-CHECK"));

type PsRun = { code: number | null; out: string };
function runPs(lines: string[]): PsRun | null {
  const dir = mkdtempSync(join(tmpdir(), "deploy-b-"));
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
// Stubs that make any command the definitions region might run at the top level a failure, not an action.
const THROWING_STUBS = ["npx", "git", "npm", "curl.exe"].map((n) => `function ${n} { throw "${n} must not run while the definitions are evaluated" }`);

// The script's definitions, evaluated once in PowerShell: the SQL it builds and the constants it carries.
let evaluated: Record<string, string> | null | undefined;
function definitions(t: { skip: (m: string) => void }): Record<string, string> | null {
  if (evaluated === undefined) {
    const r = runPs([
      "$ErrorActionPreference = 'Stop'",
      ...THROWING_STUBS,
      defs,
      'Write-Output ("C1=" + $C1_SQL)',
      'Write-Output ("C2A=" + $C2A_SQL)',
      'Write-Output ("C2B=" + $C2B_SQL)',
      'Write-Output ("V5=" + $V5_HASH)',
      'Write-Output ("LIVE_BASE=" + $LIVE_BASE_COMMIT)',
      'Write-Output ("STATES=" + ($CLAIM_STATES -join "|"))',
      'Write-Output ("BATCH=" + $RECONCILE_BATCH_ROWS)',
      'Write-Output ("HANDLE=" + $CLAIM_HANDLE_TAKEN)',
      'Write-Output ("LISTING=" + $CLAIM_LISTING_NOT_PAYING)',
      'Write-Output ("MARKER=" + $CHAIN_SPENT_MARKER)',
      'Write-Output ("SENTINEL=" + $C1_NOW_SENTINEL)',
      'Write-Output "EVALUATED-OK"',
    ]);
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

const collapse = (s: string): string => s.replace(/\s+/g, " ").trim();
const sqlLiteral = (v: unknown): string => (typeof v === "string" ? `'${v.replace(/'/g, "''")}'` : String(v));

// ---------- the file itself ----------

test("deploy-refused-option-b.ps1 parses under PowerShell's own parser with zero errors, and is ASCII only", (t) => {
  assert.equal(/[^\x00-\x7f]/.test(script), false, "5.1 reads a BOM-less UTF-8 script as the ANSI code page: ASCII only");
  const parsed = parsePowerShellFile(SCRIPT_PATH);
  if (!parsed.available) {
    t.skip(`${parsed.reason}; the static checks below still run`);
    return;
  }
  assert.equal(parsed.errors, 0, `parse errors: ${parsed.detail}`);
});

test("deploy-refused-option-b.ps1: one spelling per variable, no stderr merged under Stop, no write SQL, and D1 is read through the three named statements only", () => {
  const names = new Map<string, Set<string>>();
  for (const m of code.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)) {
    const set = names.get(m[1].toLowerCase()) ?? new Set<string>();
    set.add(m[1]);
    names.set(m[1].toLowerCase(), set);
  }
  assert.deepEqual([...names.values()].filter((s) => s.size > 1).map((s) => [...s].join(" / ")), [], "PowerShell variable names are case-insensitive");
  for (const m of code.matchAll(/2>&1/g)) {
    const before = code.slice(0, m.index);
    assert.ok(before.lastIndexOf('$ErrorActionPreference = "Continue"') > before.lastIndexOf('$ErrorActionPreference = "Stop"'), "stderr merged only under Continue");
  }
  assert.equal(/--file\b/.test(code), false, "this wave applies no migration file");
  assert.equal(/\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b/.test(code), false, "no write SQL anywhere in the script");
  const reads = [...code.matchAll(/Invoke-D1Read (\$[A-Z0-9_]+)/g)].map((m) => m[1]);
  assert.deepEqual(reads, ["$C1_SQL", "$C2A_SQL", "$C2B_SQL"], "exactly the three read-only statements, in order");
  assert.deepEqual(
    [...code.matchAll(/= \(npx wrangler ([a-z0-9]+)/g)].map((m) => m[1]),
    ["d1", "deploy"],
    "wrangler is used for one read-only d1 execute and the deploy, nothing else (no rollback, no migration, no secret)",
  );
  assert.match(code, /npx wrangler d1 execute commonhold --remote --json --command \$sql/);
});

test("deploy-refused-option-b.ps1: the built SQL is read-only (SELECT, no statement separator, no write keyword), whatever the constants say", (t) => {
  const d = definitions(t);
  if (!d) return;
  for (const k of ["C1", "C2A", "C2B"]) {
    assert.match(d[k], /^SELECT /, k);
    assert.equal(/;/.test(d[k]), false, `${k} carries no statement separator`);
    assert.equal(/\b(insert|update|delete|drop|alter|create|replace|pragma|attach)\b/i.test(d[k]), false, `${k} carries no write keyword`);
  }
});

test("deploy-refused-option-b.ps1: the steps are in the load-bearing order", () => {
  const order = [
    "# END-OF-DEFINITIONS",
    "git fetch origin --quiet",
    "rev-parse --abbrev-ref HEAD",
    "-ExpectedCommit",
    "git status --porcelain",
    "git merge-base --is-ancestor $LIVE_BASE_COMMIT HEAD",
    "git diff --name-only $LIVE_BASE_COMMIT HEAD -- migrations schema.sql src/doc.ts",
    "# BEGIN-REVIEWED-SOURCE-CHECK",
    "git merge-base --is-ancestor $REVIEWED_CODE_COMMIT $REVIEWED_COMMIT",
    "git diff --name-only --no-renames $REVIEWED_CODE_COMMIT $REVIEWED_COMMIT",
    "git merge-base --is-ancestor $REVIEWED_COMMIT HEAD",
    "git diff --name-only --no-renames $REVIEWED_COMMIT HEAD",
    "Get-DisallowedPaths $afterReview",
    "# END-REVIEWED-SOURCE-CHECK",
    "export async function markFirstRefusal",
    "npm test",
    "$attBefore = Read-Attest",
    "Assert-Attest $attBefore",
    "$totalBefore = Read-AttentionAndOfficial",
    "# BEGIN-PROD-CHECKS",
    "Invoke-D1Read $C1_SQL",
    "Invoke-D1Read $C2A_SQL",
    "Invoke-D1Read $C2B_SQL",
    "# END-PROD-CHECKS",
    "if ($DryRun)",
    "$deployOut = (npx wrangler deploy",
    "Current Version ID",
    "Start-Sleep -Seconds 20",
    "$attAfter = Read-Attest",
    "Assert-Attest $attAfter",
    "/api/guest/due",
    "$totalAfter = Read-AttentionAndOfficial",
  ];
  let last = -1;
  for (const needle of order) {
    const i = script.indexOf(needle, last + 1);
    assert.ok(i > last, `step out of order or missing: ${needle}`);
    last = i;
  }
  assert.ok(code.indexOf("exit 0") < code.indexOf("$deployOut = (npx wrangler deploy"), "the dry run exits before the deploy");
  assert.equal([...code.matchAll(/= \(npx wrangler deploy/g)].length, 1, "exactly one deploy call");
});

test("deploy-refused-option-b.ps1: every git read whose output is judged checks its exit code first", () => {
  const lines = code.split("\n");
  const reads = lines.map((l, i) => [l, i] as const).filter(([l]) => /= @\(git /.test(l));
  assert.ok(reads.length >= 2, "the clean-tree and no-migration reads are found");
  for (const [l, i] of reads) assert.match(lines[i + 1], /^if \(\$LASTEXITCODE -ne 0\) \{ Stop-Here/, `no exit check after: ${l}`);
});

test("deploy-refused-option-b.ps1: the definitions region runs nothing (throwing stubs for npx, git, npm and curl pass through it)", (t) => {
  const d = definitions(t);
  if (!d) return;
  assert.ok(d.C1.length > 500);
});

// ---------- C1: the reconciler's statement ----------

test("C1: the script's statement equals the one runReconciler runs, binds substituted and `now` set to the gate's far-future instant", async (t) => {
  const d = definitions(t);
  if (!d) return;
  const calls: { sql: string; binds: unknown[] }[] = [];
  const env = {
    DB: {
      prepare: (sql: string) => ({
        bind: (...binds: unknown[]) => {
          calls.push({ sql, binds });
          return { all: async () => ({ results: [] }) };
        },
      }),
    },
  } as unknown as Env;
  const before = Date.now();
  await runReconciler(env, 0);
  const after = Date.now();
  assert.equal(calls.length, 1, "the reconciler's one selection is the only statement it runs when nothing is due");
  const { sql, binds } = calls[0];
  // The bind layout the substitution below depends on: a change to it must fail here, with this message, not substitute the wrong thing.
  const eligible = [CLAIM_HANDLE_TAKEN, CLAIM_LISTING_NOT_PAYING, CHAIN_SPENT_MARKER.length, CHAIN_SPENT_MARKER];
  assert.equal(binds.length, 12, "bind layout: [now, 4 eligibility binds, LIMIT] twice");
  for (const i of [0, 6]) assert.ok(typeof binds[i] === "number" && (binds[i] as number) >= before && (binds[i] as number) <= after, `bind ${i} is the reconciler's clock reading`);
  assert.deepEqual(binds.slice(1, 5), eligible);
  assert.deepEqual(binds.slice(7, 11), eligible);
  assert.equal(binds[5], RECONCILE_BATCH_ROWS);
  assert.equal(binds[11], RECONCILE_BATCH_ROWS);
  assert.equal([...sql].filter((c) => c === "?").length, 12);
  let n = 0;
  const substituted = sql.replace(/\?/g, () => {
    const i = n++;
    return sqlLiteral(i === 0 || i === 6 ? Number(d.SENTINEL) : binds[i]);
  });
  const expected = `SELECT COUNT(*) AS n FROM (${collapse(substituted)})`;
  assert.equal(d.C1, expected, "the C1 statement is the reconciler's selection, counted");
  // The constants the script builds it from are the source's own.
  assert.equal(Number(d.BATCH), RECONCILE_BATCH_ROWS);
  assert.equal(d.HANDLE, CLAIM_HANDLE_TAKEN);
  assert.equal(d.LISTING, CLAIM_LISTING_NOT_PAYING);
  assert.equal(d.MARKER, CHAIN_SPENT_MARKER);
  assert.equal(d.SENTINEL, "9999999999999");
});

test("C1: the script's statement is, character for character, the one in the D-018 gate record's C1", (t) => {
  const d = definitions(t);
  if (!d) return;
  const m = gateRecord.match(/`(SELECT COUNT\(\*\) AS n FROM \(.*\))`/);
  assert.ok(m, "the gate record carries the C1 statement in backticks");
  assert.equal(d.C1, m[1], "if these ever differ, the SOURCE wins (the test above) and the script header must say the gate text was stale");
});

test("C1: run on a real SQLite engine it returns a count, excludes every row the reconciler excludes, and takes at most two of each kind", (t) => {
  const d = definitions(t);
  if (!d) return;
  const seed = (rows: Array<Partial<Record<string, unknown>> & { state: string; route?: string }>) => {
    const db = createLocalD1();
    let k = 0;
    for (const r of rows) {
      k++;
      const live = r.state === "pending" || r.state === "settled_unbooked";
      db.raw
        .prepare(
          `INSERT INTO settlement_claims (network, asset, from_addr, nonce, route, intent_json, intent_hash, rpc_body, rpc_body_hash, valid_before, state, tx, payer, verdict_reason, booked_refs, created_at, updated_at, lease_owner, leased_until)
           VALUES ('base', 'usdc', ?, ?, ?, ?, 'ih', ?, 'rh', 1, ?, NULL, NULL, ?, '{}', ?, ?, NULL, ?)`,
        )
        .run(`0xfrom${k}`, `0xnonce${k}`, r.route ?? "patron", (r.intent_json as string) ?? "{}", live ? "{}" : null, r.state, (r.verdict_reason as string | null) ?? null, 1000 + k, 1000 + k, (r.leased_until as number | null) ?? null);
    }
    const out = (db.raw.prepare(d.C1).get() as { n: number }).n;
    db.close();
    return out;
  };
  // Scenario A: each excluded row is OLDER than its one counted sibling, so a broken exclusion takes the slot and the count rises (n is 2, never the cap).
  const excluded = seed([
    { state: "settled_unbooked", verdict_reason: CLAIM_HANDLE_TAKEN },
    { state: "settled_unbooked", verdict_reason: CLAIM_LISTING_NOT_PAYING },
    { state: "settled_unbooked", route: "register", intent_json: "{}" },
    { state: "pending", verdict_reason: `${CHAIN_SPENT_MARKER}the chain reads it used` },
    { state: "pending", leased_until: 99_999_999_999_999 },
    { state: "booked" },
    { state: "expired" },
    { state: "refused" },
    { state: "settled_unbooked", route: "register", intent_json: '{"public_key":"k"}' },
    { state: "pending", verdict_reason: "the facilitator's last words (not a marker)" },
  ]);
  assert.equal(excluded, 2, "one settled (the keyed registration) and one pending (the one with ordinary last words)");
  // Scenario B: the per-kind LIMIT. Three settled and three pending are due; the count is capped at two of each.
  const capped = seed([{ state: "settled_unbooked" }, { state: "settled_unbooked" }, { state: "settled_unbooked" }, { state: "pending" }, { state: "pending" }, { state: "pending" }]);
  assert.equal(capped, RECONCILE_BATCH_ROWS * 2);
  assert.equal(seed([]), 0, "an empty table counts 0 (the gate: 0 is fine)");
});

// ---------- C2a: the states ----------

test("C2a: $CLAIM_STATES are the five states of migration 0017's CHECK and of the ClaimState type, and the statement is the GROUP BY the gate named", (t) => {
  const d = definitions(t);
  if (!d) return;
  const script5 = d.STATES.split("|");
  const check = migration0017.match(/state\s+TEXT\s+NOT NULL CHECK \(state IN \(([^)]*)\)\)/);
  assert.ok(check, "0017's state CHECK is found");
  assert.deepEqual(script5, [...check[1].matchAll(/'([^']+)'/g)].map((x) => x[1]));
  const type = claimsSource.match(/export type ClaimState = ([^;]+);/);
  assert.ok(type, "the ClaimState type is found");
  assert.deepEqual(script5, [...type[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]));
  assert.equal(script5.length, 5);
  assert.equal(d.C2A, "SELECT state, COUNT(*) AS n FROM settlement_claims GROUP BY state ORDER BY state");
});

// ---------- C2b: the anti-join ----------

test("C2b: the anti-join carries RESERVATION_BOUND, column for column, with the claim's own pin from reservationArgs", (t) => {
  const d = definitions(t);
  if (!d) return;
  // The pin reservationArgs binds, in order: wallet_row_id, wallet_row_hash, created_at (distinct values prove the mapping below).
  const sample = { intent_json: JSON.stringify({ listing_id: 9, wallet_row_id: 111, wallet_row_hash: "HASH", other: 1 }), created_at: 777 } as Pick<ClaimRow, "intent_json" | "created_at">;
  assert.deepEqual(reservationArgs(sample), [111, "HASH", 777]);
  const fromClaim = ["json_extract(c.intent_json, '$.wallet_row_id')", "json_extract(c.intent_json, '$.wallet_row_hash')", "c.created_at"];
  let i = 0;
  const binding = RESERVATION_BOUND.replace(/\b(status|paid_submission_id|paying_wallet_row_id|paying_wallet_row_hash|paying_since)\b/g, "l.$1").replace(/\?/g, () => fromClaim[i++]);
  assert.equal(i, 3, "RESERVATION_BOUND has exactly the three binds reservationArgs supplies");
  assert.ok(d.C2B.includes(binding), `the anti-join must contain ${binding}`);
  assert.ok(d.C2B.includes("json_extract(c.intent_json, '$.listing_id') = l.id"), "and ties the claim to the listing through the intent's listing_id");
  assert.ok(d.C2B.includes("c.route = 'listing_pay'"));
});

test("C2b: on a real SQLite engine it lists exactly the 'paying' listings no live claim owns, and agrees with listingReservationState", async (t) => {
  const d = definitions(t);
  if (!d) return;
  const db = createLocalD1();
  const env = { DB: db.DB } as unknown as Env;
  const listing = (status: string, since: number | null, pin: [number, string] | null): number => {
    const id = insertListing(db, { status });
    db.raw.prepare("UPDATE listings SET paying_since = ?, paying_wallet_row_id = ?, paying_wallet_row_hash = ? WHERE id = ?").run(since, pin?.[0] ?? null, pin?.[1] ?? null, id);
    return id;
  };
  let k = 0;
  const claims: ClaimRow[] = [];
  const claim = (state: string, listingId: number, pin: [number, string], createdAt: number): void => {
    k++;
    const row = {
      network: "base", asset: "usdc", from_addr: `0xfrom${k}`, nonce: `0xnonce${k}`, route: "listing_pay",
      intent_json: JSON.stringify({ listing_id: listingId, wallet_row_id: pin[0], wallet_row_hash: pin[1] }),
      intent_hash: "ih", rpc_body: state === "pending" || state === "settled_unbooked" ? "{}" : null, rpc_body_hash: "rh", valid_before: 1, state,
      tx: null, payer: null, verdict_reason: null, booked_refs: "{}", created_at: createdAt, updated_at: createdAt, lease_owner: null, leased_until: null,
    } as ClaimRow;
    db.raw
      .prepare(
        `INSERT INTO settlement_claims (network, asset, from_addr, nonce, route, intent_json, intent_hash, rpc_body, rpc_body_hash, valid_before, state, tx, payer, verdict_reason, booked_refs, created_at, updated_at, lease_owner, leased_until)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, '{}', ?, ?, NULL, NULL)`,
      )
      .run(row.network, row.asset, row.from_addr, row.nonce, row.route, row.intent_json, row.intent_hash, row.rpc_body, row.rpc_body_hash, row.valid_before, row.state, createdAt, createdAt);
    claims.push(row);
  };
  const owned = listing("paying", 1000, [5, "h5"]);
  claim("pending", owned, [5, "h5"], 2000);
  const noClaim = listing("paying", 1000, [6, "h6"]);
  const undated = listing("paying", null, null);
  const otherPin = listing("paying", 1000, [7, "h7"]);
  claim("pending", otherPin, [8, "h8"], 2000);
  const laterReservation = listing("paying", 3000, [9, "h9"]);
  claim("pending", laterReservation, [9, "h9"], 2000);
  const terminalClaim = listing("paying", 1000, [10, "h10"]);
  claim("expired", terminalClaim, [10, "h10"], 2000);
  const open = listing("open", null, null);
  const wrongListing = listing("paying", 1000, [11, "h11"]);
  claim("pending", open, [11, "h11"], 2000);
  const twoClaims = listing("paying", 1000, [12, "h12"]);
  claim("pending", twoClaims, [99, "h99"], 2000);
  claim("settled_unbooked", twoClaims, [12, "h12"], 2500);

  const listed = (db.raw.prepare(d.C2B).all() as { id: number }[]).map((r) => Number(r.id));
  assert.deepEqual(listed, [noClaim, undated, otherPin, laterReservation, terminalClaim, wrongListing].sort((a, b) => a - b));
  assert.equal(listed.includes(owned) || listed.includes(twoClaims) || listed.includes(open), false, "owned and non-paying listings are not listed");

  // The same answer from the code's own binding: a listing is owned iff some LIVE claim for it is bound by listingReservationState.
  const paying = (db.raw.prepare("SELECT id FROM listings WHERE status = 'paying' ORDER BY id").all() as { id: number }[]).map((r) => Number(r.id));
  const byCode: number[] = [];
  for (const id of paying) {
    let isOwned = false;
    for (const c of claims) {
      const live = c.state === "pending" || c.state === "settled_unbooked";
      if (live && (JSON.parse(c.intent_json) as { listing_id: number }).listing_id === id && (await listingReservationState(env, c)).bound) isOwned = true;
    }
    if (!isOwned) byCode.push(id);
  }
  assert.deepEqual(listed, byCode, "the anti-join and listingReservationState agree on every 'paying' listing");
  db.close();
});

// ---------- the prod checks, run for real in PowerShell against a stand-in for npx ----------

type Fixture = Record<"c1" | "states" | "orphans", { text: string; exit?: number }>;
const wrangler = (results: unknown): { text: string } => ({ text: `
wrangler banner
[
  ${JSON.stringify({ results, success: true, meta: {} })}
]` });
const happy = (): Fixture => ({ c1: wrangler([{ n: 3 }]), states: wrangler([{ state: "booked", n: 2 }, { state: "expired", n: 1 }]), orphans: wrangler([]) });

function runChecks(fixture: Fixture, t: { skip: (m: string) => void }): PsRun | null {
  const dir = mkdtempSync(join(tmpdir(), "deploy-b-fx-"));
  try {
    const fx = join(dir, "fixture.json");
    writeFileSync(fx, JSON.stringify(fixture));
    const r = runPs([
      "$ErrorActionPreference = 'Stop'",
      ...THROWING_STUBS,
      defs,
      `$fixture = (Get-Content -Raw '${fx}' | ConvertFrom-Json)`,
      // The stand-in for npx: picks the answer by the statement it was handed (the last argument) and sets the exit code a native command would.
      "function npx {",
      "  $q = [string]$args[$args.Count - 1]",
      "  if ($q -like 'SELECT COUNT(*) AS n FROM (*') { $e = $fixture.c1 } elseif ($q -like '*GROUP BY state*') { $e = $fixture.states } elseif ($q -like '*NOT EXISTS*') { $e = $fixture.orphans } else { throw \"unexpected statement: $q\" }",
      "  $global:LASTEXITCODE = [int]$e.exit",
      "  return $e.text",
      "}",
      checksBlock,
      'Write-Host "REACHED-END"',
      "exit 0",
    ]);
    if (!r) t.skip("powershell is not available on this machine");
    return r;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
const withExit = (e: { text: string }, exit: number) => ({ ...e, exit });

test("prod checks: a clean prod (C1 counts, states known, anti-join empty) passes to the end; an empty claims table and all five states are fine", (t) => {
  const a = runChecks(happy(), t);
  if (!a) return;
  assert.equal(a.code, 0, a.out);
  assert.match(a.out, /\[d1\] C1:.*3 row\(s\)/);
  assert.match(a.out, /\[d1\] C2a: settlement_claims by state: booked 2, expired 1/);
  assert.match(a.out, /\[d1\] C2b:.*anti-join empty/);
  assert.match(a.out, /REACHED-END/);
  const empty = runChecks({ ...happy(), c1: wrangler([{ n: 0 }]), states: wrangler([]) }, t);
  assert.ok(empty);
  assert.equal(empty.code, 0, empty.out);
  assert.match(empty.out, /C2a: settlement_claims by state: no rows/);
  const five = runChecks({ ...happy(), states: wrangler(["pending", "settled_unbooked", "booked", "refused", "expired"].map((state) => ({ state, n: 1 }))) }, t);
  assert.ok(five);
  assert.equal(five.code, 0, five.out);
});

test("prod checks: every failure STOPS before the end, for its own reason", (t) => {
  const cases: Array<[string, Fixture, RegExp]> = [
    ["C1 wrangler error", { ...happy(), c1: withExit(wrangler([]), 1) }, /wrangler d1 execute failed \(exit 1\)/],
    ["C1 no JSON at all", { ...happy(), c1: { text: "Error: no such table: settlement_claims" } }, /returned no JSON/],
    ["C1 no count column", { ...happy(), c1: wrangler([{ total: 3 }]) }, /C1:.*one numeric count/],
    ["C1 a non-numeric count", { ...happy(), c1: wrangler([{ n: "three" }]) }, /C1:.*one numeric count/],
    ["C1 no rows", { ...happy(), c1: wrangler([]) }, /C1:.*one numeric count/],
    ["C1 a count past what two LIMIT 2 subqueries can return", { ...happy(), c1: wrangler([{ n: 5 }]) }, /C1: the count is 5/],
    ["C2a a state the code does not know", { ...happy(), states: wrangler([{ state: "booked", n: 1 }, { state: "refunded", n: 1 }]) }, /C2a:.*refunded/],
    ["C2a a state in the wrong case", { ...happy(), states: wrangler([{ state: "Booked", n: 1 }]) }, /C2a:.*Booked/],
    ["C2b one orphan", { ...happy(), orphans: wrangler([{ id: 41, paying_since: Date.UTC(2026, 9, 1, 12) }]) }, /C2b: 1 'paying' listing\(s\).*listing 41 \(reserved 2026-10-01 12:00:00Z\)/],
    ["C2b two orphans, one undated", { ...happy(), orphans: wrangler([{ id: 7, paying_since: null }, { id: 9, paying_since: 1759320000000 }]) }, /C2b: 2.*listing 7 \(reserved undated: reserved before migration 0014\); listing 9/],
    ["C2b the anti-join query fails", { ...happy(), orphans: withExit(wrangler([]), 1) }, /wrangler d1 execute failed/],
  ];
  for (const [name, fixture, expected] of cases) {
    const r = runChecks(fixture, t);
    if (!r) return;
    assert.equal(r.code, 1, `${name}: ${r.out}`);
    assert.match(r.out, /\[STOP\]/, name);
    assert.match(r.out, expected, name);
    assert.doesNotMatch(r.out, /REACHED-END/, name);
  }
});

// ---------- the constants, each pinned to a source of truth ----------

test("$V5_HASH is the live constitution's template hash (a re-mint turns this red, as it should)", async (t) => {
  const d = definitions(t);
  if (!d) return;
  assert.equal(d.V5, (await computeLiveConstitutionPair()).templateHash);
});

test("$LIVE_BASE_COMMIT is a full sha, names a commit in this history, and is an ancestor of HEAD", (t) => {
  const d = definitions(t);
  if (!d) return;
  assert.match(d.LIVE_BASE, /^[0-9a-f]{40}$/);
  // The committed record of what the live worker was built from (the M3 second gate's deploy line): the script's base and its rollback hint both come from it.
  const deployed = readFileSync(here("../docs/REVIEW-PAID-PATH-M3-SECOND-GATE-2026-10-04.md"), "utf8").match(/Deployed as worker `([0-9a-f-]{36})` at main `([0-9a-f]{8})`/);
  assert.ok(deployed, "the M3 gate record names the deployed worker and main");
  assert.ok(d.LIVE_BASE.startsWith(deployed[2]), `the live base commit is the one the record says was deployed (${deployed[2]})`);
  assert.ok(script.includes(`should be ${deployed[1].slice(0, 8)} per HANDOVER`), "the rollback hint names the worker version the record says was live");
  const git = (...args: string[]) => spawnSync("git", ["-C", here(".."), ...args], { encoding: "utf8" });
  // Skip ONLY when this checkout cannot answer (no git, or a shallow clone); a sha that a full history does not contain is a failure, never a skip.
  const head = git("rev-parse", "HEAD");
  const shallow = git("rev-parse", "--is-shallow-repository");
  if (head.error || head.status !== 0 || shallow.error || shallow.status !== 0 || shallow.stdout.trim() !== "false") {
    t.skip("this checkout has no full git history to check the live base commit against");
    return;
  }
  const kind = git("cat-file", "-t", d.LIVE_BASE);
  assert.equal(kind.status, 0, `${d.LIVE_BASE} is not an object in this repository`);
  assert.equal(kind.stdout.trim(), "commit");
  assert.equal(git("merge-base", "--is-ancestor", d.LIVE_BASE, "HEAD").status, 0, "HEAD descends from the live worker's code");
});

// ---------- the reviewed source (CODEX deploy-script r1, HIGH): what ships is the reviewed code plus only allowlisted paths ----------

const git = (cwd: string, ...args: string[]) => spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
const lines = (s: string): string[] => s.split(/\r?\n/).filter((l) => l.length > 0);

test("the reviewed pair is pinned to history: c93150ea is the option B merge, f0431b66 follows it, and between them ONLY docs/ changed", (t) => {
  const d = definitions(t);
  if (!d) return;
  const text = `${script}`;
  const consts = Object.fromEntries([...text.matchAll(/^\$(REVIEWED_CODE_COMMIT|REVIEWED_COMMIT) = "([0-9a-f]{40})"$/gm)].map((m) => [m[1], m[2]]));
  assert.ok(consts.REVIEWED_CODE_COMMIT?.startsWith("c93150ea") && consts.REVIEWED_COMMIT?.startsWith("f0431b66"), "the two reviewed commits are full shas");
  const root = here("..");
  const head = git(root, "rev-parse", "HEAD");
  const shallow = git(root, "rev-parse", "--is-shallow-repository");
  if (head.error || head.status !== 0 || shallow.error || shallow.status !== 0 || shallow.stdout.trim() !== "false") {
    t.skip("this checkout has no full git history to check the reviewed pair against");
    return;
  }
  assert.equal(git(root, "cat-file", "-t", consts.REVIEWED_CODE_COMMIT).stdout.trim(), "commit");
  assert.equal(git(root, "cat-file", "-t", consts.REVIEWED_COMMIT).stdout.trim(), "commit");
  assert.match(git(root, "log", "-1", "--format=%s", consts.REVIEWED_CODE_COMMIT).stdout, /option B/, "the reviewed code commit is the option B merge");
  assert.equal(git(root, "merge-base", "--is-ancestor", consts.REVIEWED_CODE_COMMIT, consts.REVIEWED_COMMIT).status, 0);
  const between = lines(git(root, "diff", "--name-only", "--no-renames", consts.REVIEWED_CODE_COMMIT, consts.REVIEWED_COMMIT).stdout);
  assert.ok(between.length >= 1, "something changed between them (else this pin proves nothing)");
  assert.deepEqual(between.filter((p) => !p.startsWith("docs/")), [], "the reviewed code is the option B merge's tree: nothing but docs/ changed after it");
  assert.equal(git(root, "merge-base", "--is-ancestor", consts.REVIEWED_COMMIT, "HEAD").status, 0, "HEAD descends from the reviewed commit");
});

test("the allowlist is one constant of exactly this script, its test, and docs/; every other tracked path is refused", (t) => {
  const root = here("..");
  const listed = git(root, "ls-files");
  if (listed.error || listed.status !== 0) {
    t.skip("git is not available here");
    return;
  }
  const allowedConst = code.match(/\$ALLOWED_PATHS_AFTER_REVIEW = @\(([^)]*)\)/);
  assert.ok(allowedConst, "the allowlist is one constant");
  assert.deepEqual([...allowedConst[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]), ["scripts/deploy-refused-option-b.ps1", "test/deploy-refused-option-b-script.test.ts", "docs/"]);
  assert.equal([...code.matchAll(/\$ALLOWED_PATHS_AFTER_REVIEW = /g)].length, 1, "stated once");
  assert.ok(existsSync(here("../scripts/deploy-refused-option-b.ps1")) && existsSync(here("../test/deploy-refused-option-b-script.test.ts")));
  const tracked = lines(listed.stdout);
  assert.ok(tracked.length > 100, "the whole tree is listed");
  const dir = mkdtempSync(join(tmpdir(), "deploy-b-paths-"));
  try {
    const named = ["src/x402.ts", "src/docs/evil.ts", "src/doc.ts", "migrations/0099_x.sql", "schema.sql", "package.json", "package-lock.json", "wrangler.jsonc", "tsconfig.json", ".claude/skills/x.md", "README.md",
      "docs", "docsx/a.md", "Docs/a.md", "scripts/deploy-refused-option-b.ps1.bak", "scripts/deploy-m3-treasury.ps1", "test/deploy-refused-option-b-script.test.ts/x", "test/other.test.ts", '"docs/odd\\"name.md"'];
    const allowed = ["docs/BRIEF-REFUSED-CHAIN-RECHECK.md", "docs/a/b/c.md", "docs/new.md", "scripts/deploy-refused-option-b.ps1", "test/deploy-refused-option-b-script.test.ts"];
    const input = join(dir, "paths.txt");
    writeFileSync(input, [...tracked, ...named, "---", ...allowed].join("\n"));
    const r = runPs([
      "$ErrorActionPreference = 'Stop'",
      ...THROWING_STUBS,
      defs,
      `$all = @(Get-Content '${input}')`,
      "$cut = [array]::IndexOf($all, '---')",
      "$toCheck = @($all[0..($cut - 1)])",
      "$ok = @($all[($cut + 1)..($all.Count - 1)])",
      "$bad = @(Get-DisallowedPaths $toCheck)",
      'Write-Output ("REFUSED=" + $bad.Count)',
      "Write-Output (\"ALLOWEDREFUSED=\" + @(Get-DisallowedPaths $ok).Count)",
      "$bad | ForEach-Object { Write-Output (\"BAD:\" + $_) }",
    ]);
    if (!r) {
      t.skip("powershell is not available on this machine");
      return;
    }
    assert.equal(r.code, 0, r.out);
    const shouldAllow = (p: string) => p === "scripts/deploy-refused-option-b.ps1" || p === "test/deploy-refused-option-b-script.test.ts" || p.startsWith("docs/");
    const expectRefused = [...tracked, ...named].filter((p) => !shouldAllow(p));
    const refused = new Set([...r.out.matchAll(/^BAD:(.*)$/gm)].map((m) => m[1].replace(/\r$/, "")));
    assert.deepEqual(
      expectRefused.filter((p) => !refused.has(p)),
      [],
      "every tracked or named path outside the allowlist is refused",
    );
    assert.match(r.out, /ALLOWEDREFUSED=0/, "the allowed paths (this script, its test, anything under docs/) are not refused");
    assert.equal(Number(r.out.match(/REFUSED=(\d+)/)?.[1]), expectRefused.length, "and nothing allowed was refused along the way");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Step 0's reviewed-source block, run for real in PowerShell against a throwaway git repository whose history has the same shape as this one:
// R (the reviewed code), A (docs only on top of it: the reviewed commit), then HEAD = A plus whatever the case changes.
type Repo = { dir: string; code: string; reviewed: string; side: string };
function makeRepo(opts: { reviewedChangesSrc?: boolean } = {}): Repo {
  const dir = mkdtempSync(join(tmpdir(), "deploy-b-repo-"));
  const g = (...a: string[]) => {
    const r = spawnSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...a], { encoding: "utf8" });
    assert.equal(r.status, 0, `git ${a.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const put = (p: string, text: string) => {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), text);
  };
  g("init", "-q", "-b", "main");
  put("src/x402.ts", "export const a = 1;\n");
  put("wrangler.jsonc", "{}\n");
  put("docs/a.md", "a\n");
  put("scripts/deploy-refused-option-b.ps1", "# script\n");
  put("test/deploy-refused-option-b-script.test.ts", "// test\n");
  g("add", "-A");
  g("commit", "-q", "-m", "merge: option B");
  const code = g("rev-parse", "HEAD");
  g("branch", "side");
  put("docs/a.md", "a, status line\n");
  if (opts.reviewedChangesSrc) put("src/x402.ts", "export const a = 2;\n");
  g("commit", "-qam", "docs(brief): status");
  const reviewed = g("rev-parse", "HEAD");
  g("checkout", "-q", "side");
  put("docs/side.md", "side\n");
  g("add", "-A");
  g("commit", "-q", "-m", "side branch without the reviewed commit");
  const side = g("rev-parse", "HEAD");
  g("checkout", "-q", "main");
  return { dir, code, reviewed, side };
}
function onTop(repo: Repo, change: (put: (p: string, text: string) => void, g: (...a: string[]) => void) => void): void {
  const put = (p: string, text: string) => {
    mkdirSync(dirname(join(repo.dir, p)), { recursive: true });
    writeFileSync(join(repo.dir, p), text);
  };
  const g = (...a: string[]) => {
    const r = spawnSync("git", ["-C", repo.dir, "-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...a], { encoding: "utf8" });
    assert.equal(r.status, 0, `git ${a.join(" ")}: ${r.stderr}`);
  };
  change(put, g);
  g("add", "-A");
  g("commit", "-q", "--allow-empty", "-m", "after review");
}
function runReviewed(repo: Repo, overrides: { code?: string; reviewed?: string } = {}): PsRun | null {
  return runPs([
    "$ErrorActionPreference = 'Stop'",
    `Set-Location '${repo.dir}'`,
    defs,
    `$REVIEWED_CODE_COMMIT = '${overrides.code ?? repo.code}'`,
    `$REVIEWED_COMMIT = '${overrides.reviewed ?? repo.reviewed}'`,
    reviewedBlock,
    'Write-Host "REACHED-END"',
    "exit 0",
  ]);
}
const gone = (dir: string) => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* a read-only git object on Windows; the temp folder is the OS's to clear */
  }
};

test("step 0 reviewed-source check: HEAD = the reviewed commit plus only this script, its test and docs/ passes (and HEAD = the reviewed commit itself)", (t) => {
  const exact = makeRepo();
  const withAllowed = makeRepo();
  try {
    onTop(withAllowed, (put) => {
      put("docs/new.md", "new\n");
      put("docs/sub/deep.md", "deep\n");
      put("scripts/deploy-refused-option-b.ps1", "# script, edited\n");
      put("test/deploy-refused-option-b-script.test.ts", "// test, edited\n");
    });
    const a = runReviewed(exact);
    if (!a) return t.skip("powershell is not available on this machine");
    assert.equal(a.code, 0, a.out);
    assert.match(a.out, /HEAD differs from [0-9a-f]{8} in 0 path\(s\)/);
    const b = runReviewed(withAllowed);
    assert.ok(b);
    assert.equal(b.code, 0, b.out);
    assert.match(b.out, /in 4 path\(s\), all on the allowlist/);
    assert.match(b.out, /REACHED-END/);
  } finally {
    gone(exact.dir);
    gone(withAllowed.dir);
  }
});

test("step 0 reviewed-source check: a path outside the allowlist STOPS, naming it (src/, config, package files, a rename out of src/, one bad path among good ones)", (t) => {
  const cases: Record<string, { change: (put: (p: string, text: string) => void, g: (...a: string[]) => void) => void; names: string[] }> = {
    "src/x402.ts edited": { change: (put) => put("src/x402.ts", "export const a = 3;\n"), names: ["src/x402.ts"] },
    "the wrangler config edited": { change: (put) => put("wrangler.jsonc", '{"vars":{}}\n'), names: ["wrangler.jsonc"] },
    "package-lock.json added": { change: (put) => put("package-lock.json", "{}\n"), names: ["package-lock.json"] },
    "a new migration": { change: (put) => put("migrations/0099_x.sql", "SELECT 1;\n"), names: ["migrations/0099_x.sql"] },
    "src/x402.ts renamed into docs/ (both paths must be seen)": { change: (_p, g) => g("mv", "src/x402.ts", "docs/x402.md"), names: ["src/x402.ts"] },
    "one bad path among allowed ones": {
      change: (put) => {
        put("docs/new.md", "new\n");
        put("test/deploy-refused-option-b-script.test.ts", "// edited\n");
        put("src/sneaky.ts", "export {};\n");
      },
      names: ["src/sneaky.ts"],
    },
  };
  for (const [name, c] of Object.entries(cases)) {
    const repo = makeRepo();
    try {
      onTop(repo, c.change);
      const r = runReviewed(repo);
      if (!r) return t.skip("powershell is not available on this machine");
      assert.equal(r.code, 1, `${name}: ${r.out}`);
      assert.match(r.out, /\[STOP\] these paths changed since the reviewed commit/, name);
      for (const p of c.names) assert.ok(r.out.includes(p), `${name}: the STOP names ${p}: ${r.out}`);
      assert.doesNotMatch(r.out, /REACHED-END/, name);
    } finally {
      gone(repo.dir);
    }
  }
});

test("step 0 reviewed-source check: HEAD without the reviewed commit, a reviewed pair that changed src, and a pair out of order each STOP", (t) => {
  const repo = makeRepo();
  const bad = makeRepo({ reviewedChangesSrc: true });
  try {
    const notContained = runReviewed(repo, { reviewed: repo.side });
    if (!notContained) return t.skip("powershell is not available on this machine");
    // HEAD (main) does not contain `side`, which here plays the reviewed commit.
    assert.equal(notContained.code, 1, notContained.out);
    assert.match(notContained.out, /\[STOP\] .*(is not an ancestor of|does not contain the reviewed commit)/);
    const pairChangesSrc = runReviewed(bad);
    assert.ok(pairChangesSrc);
    assert.equal(pairChangesSrc.code, 1, pairChangesSrc.out);
    assert.match(pairChangesSrc.out, /were to change docs\/ only, but changed: src\/x402\.ts/);
    const reversed = runReviewed(repo, { code: repo.reviewed, reviewed: repo.code });
    assert.ok(reversed);
    assert.equal(reversed.code, 1, reversed.out);
    assert.match(reversed.out, /is not an ancestor of/);
    const unknown = runReviewed(repo, { reviewed: "0".repeat(40) });
    assert.ok(unknown);
    assert.equal(unknown.code, 1, unknown.out);
    assert.match(unknown.out, /\[STOP\]/);
  } finally {
    gone(repo.dir);
    gone(bad.dir);
  }
});

test("step 0's sentinels: every one the script checks for is true of this source (the positive ones present, the old writer absent), and none was dropped", () => {
  const found: Array<{ file: string; pattern: string; positive: boolean }> = [];
  for (const line of code.split("\n")) {
    const m = line.match(/Select-String -Path "([^"]+)" -Pattern "([^"]+)" -Quiet/);
    if (m) found.push({ file: m[1], pattern: m[2], positive: /if \(-not \(Select-String/.test(line) });
  }
  assert.deepEqual(
    found.map((f) => `${f.positive ? "+" : "-"} ${f.file} :: ${f.pattern}`),
    [
      "+ src/settlement-claims.ts :: export async function markFirstRefusal",
      "- src/settlement-claims.ts :: export async function markRefused",
      "+ src/society.ts :: export function parseLedgerCursor",
      "+ src/guest.ts :: export async function postGuestComment",
    ],
    "the checkout sentinels, in order",
  );
  for (const f of found) {
    const present = new RegExp(f.pattern).test(readFileSync(here(`../${f.file}`), "utf8"));
    assert.equal(present, f.positive, `${f.file} :: ${f.pattern} must be ${f.positive ? "present" : "absent"} in this source`);
  }
  assert.ok(code.includes('if (-not (Test-Path "src/settlement-attention.ts"))') && existsSync(here("../src/settlement-attention.ts")), "M3's attention list");
  assert.ok(readFileSync(here("../src/index.ts"), "utf8").includes('path === "/api/settlements/attention" && method === "GET"'), "the attention route the ride reads is served");
  assert.ok(code.includes('$ATTENTION_URL = "$BASE/api/settlements/attention"'));
});

test("the post-deploy reads do not claim to prove propagation, and the header says no marker exists", () => {
  assert.match(script, /NO public GET serves any text this wave changed/);
  assert.match(script, /not a proof of propagation/);
  assert.equal(/for \(\$i = 0; \$i -lt/.test(code), false, "no poll loop: there is no marker for one to wait on");
  assert.match(script, /THE ONE REAL RIDE of this change is the next real refused payment/);
});
