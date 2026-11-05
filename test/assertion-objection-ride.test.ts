// A real RIDE of scripts/assertion-objection.ps1 past its refusals (re-gate M2). The script runs for real under PowerShell; `npx` is a recording stub on PATH (npx.cmd -> node stub), so no wrangler and no
// database is touched, and $BASE is replaced in a temp copy by a local HTTP server that serves /api/citizens. The stub answers each SELECT from a scripted list and each UPDATE with a scripted meta.changes, and
// logs every statement it is sent. This proves what the decision-function tests cannot: that -DryRun sends no write; that a real uphold sends the write and THEN re-reads the row and the census; that each
// postcondition, failing, stops with its own message; and that a withdraw permits a stamp after it. Each block names the mutation that turns it red; docs/CHECKPOINT-LAST-ASSERTION-AT.md records the runs.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT = readFileSync(fileURLToPath(new URL("../scripts/assertion-objection.ps1", import.meta.url)), "utf8").split("\r\n").join("\n");
const T0 = 1_800_000_000_000;
const BASE_LINE = '$BASE = "https://commonhold.randommonicle.workers.dev"';

type Row = { id: number; handle: string; has_key: number; last_assertion_at: number | null; assertion_objected_at: number | null };
const row = (flag: number | null, stamp: number | null, over: Partial<Row> = {}): Row => ({ id: 3, handle: "keyed-a", has_key: 1, last_assertion_at: stamp, assertion_objected_at: flag, ...over });
type Scenario = { reads: Row[]; changes?: number; census: (number | null)[] };
const page = (stamp: number | null) => ({ citizens: [{ handle: "keyed-a", public_key: "k", last_assertion_at: stamp }], has_more: false });

async function ride(args: string[], sc: Scenario): Promise<{ code: number | null; out: string; sql: string[]; censusCalls: number }> {
  const dir = mkdtempSync(join(tmpdir(), "ao-ride-"));
  let censusCalls = 0;
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/api/citizens")) {
      const stamp = sc.census[Math.min(censusCalls, sc.census.length - 1)] ?? null;
      censusCalls++;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(page(stamp)));
    } else {
      res.statusCode = 404;
      res.end("no");
    }
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  try {
    const port = (server.address() as { port: number }).port;
    assert.ok(SCRIPT.includes(BASE_LINE), "the BASE line is where the ride expects it");
    writeFileSync(join(dir, "script.ps1"), SCRIPT.replace(BASE_LINE, `$BASE = "http://127.0.0.1:${port}"`));
    writeFileSync(join(dir, "scenario.json"), JSON.stringify(sc));
    writeFileSync(
      join(dir, "stub.mjs"),
      `import fs from "node:fs";
const sc = JSON.parse(fs.readFileSync(process.env.AO_DIR + "/scenario.json", "utf8"));
const sql = process.env.D1_SQL_ARG ?? "";
fs.appendFileSync(process.env.AO_DIR + "/log.txt", sql + "\\n");
const state = process.env.AO_DIR + "/reads.count";
let n = 0; try { n = Number(fs.readFileSync(state, "utf8")); } catch {}
if (/^UPDATE/i.test(sql)) { console.log(JSON.stringify([{ results: [], success: true, meta: { changes: sc.changes ?? 1 } }])); }
else { const r = sc.reads[Math.min(n, sc.reads.length - 1)]; fs.writeFileSync(state, String(n + 1)); console.log(JSON.stringify([{ results: r ? [r] : [], success: true, meta: {} }])); }
`,
    );
    writeFileSync(join(dir, "npx.cmd"), '@node "%~dp0stub.mjs" %*\r\n');
    writeFileSync(join(dir, "log.txt"), "");
    const child = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(dir, "script.ps1"), ...args], {
      env: { ...process.env, PATH: dir + ";" + process.env.PATH, AO_DIR: dir },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    const code = await new Promise<number | null>((ok) => child.on("close", ok));
    const sql = readFileSync(join(dir, "log.txt"), "utf8").split("\n").filter(Boolean);
    return { code, out, sql, censusCalls };
  } finally {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
const isWrite = (s: string) => /^UPDATE/i.test(s);
const UP = ["-Handle", "keyed-a", "-Uphold", "-SignedRequestVerified", "-ConfirmHandle", "keyed-a"];

test("ride: -DryRun reads the row and the census and sends NO write (red: the dry-run exit removed)", async () => {
  const r = await ride(["-Handle", "keyed-a", "-Uphold", "-DryRun"], { reads: [row(null, T0)], census: [T0] });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /\[dry-run\] would run: UPDATE citizens/);
  assert.match(r.out, /Nothing was written/);
  assert.equal(r.sql.filter(isWrite).length, 0, "no write was sent");
  assert.equal(r.sql.length, 1, "one read only");
  assert.doesNotMatch(r.out, /\[write\]|\[done\]/);
});

test("ride: a real uphold sends the write, then re-reads the stored row, then the census, and reports done (red: each postcondition call removed, below)", async () => {
  const r = await ride(UP, { reads: [row(null, T0), row(T0 + 1000, null)], changes: 1, census: [T0, null] });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.sql.map((s) => s.split(" ")[0]), ["SELECT", "UPDATE", "SELECT"], "read, write, re-read, in that order");
  assert.match(r.sql[1]!, /SET assertion_objected_at = COALESCE\(assertion_objected_at, .*last_assertion_at = NULL WHERE handle = 'keyed-a' AND public_key IS NOT NULL/);
  assert.equal(r.censusCalls, 2, "the census is read before and after");
  assert.match(r.out, /\[done\] uphold recorded for keyed-a; GET \/api\/citizens serves last_assertion_at ''/);
});

test("ride: each uphold postcondition, failing, stops with its OWN message (changes not 1; stored flag not set; stored stamp not NULL; census still served)", async () => {
  const zero = await ride(UP, { reads: [row(null, T0), row(T0, null)], changes: 0, census: [T0, null] });
  assert.equal(zero.code, 1);
  assert.match(zero.out, /\[STOP\] the write changed 0 rows, expected exactly 1/);
  assert.equal(zero.sql.length, 2, "it stopped before the re-read");
  const two = await ride(UP, { reads: [row(null, T0), row(T0, null)], changes: 2, census: [T0, null] });
  assert.match(two.out, /\[STOP\] the write changed 2 rows/);
  const flag = await ride(UP, { reads: [row(null, T0), row(null, null)], changes: 1, census: [T0, null] });
  assert.equal(flag.code, 1);
  assert.match(flag.out, /\[STOP\] the stored flag is '', expected a whole number above zero/);
  assert.equal(flag.censusCalls, 1, "it stopped before the census re-read");
  const stamp = await ride(UP, { reads: [row(null, T0), row(T0, T0)], changes: 1, census: [T0, null] });
  assert.equal(stamp.code, 1);
  assert.match(stamp.out, /\[STOP\] the stored last_assertion_at is '1800000000000', expected NULL after an uphold/);
  assert.equal(stamp.censusCalls, 1);
  const census = await ride(UP, { reads: [row(null, T0), row(T0, null)], changes: 1, census: [T0, T0] });
  assert.equal(census.code, 1);
  assert.match(census.out, /\[STOP\] the census still serves last_assertion_at 1800000000000 for the handle after an uphold/);
  for (const r of [zero, two, flag, stamp, census]) assert.doesNotMatch(r.out, /\[done\]/);
});

test("ride: a real withdraw permits a stamp between the write and the read; it never fails for one (AO1)", async () => {
  const W = ["-Handle", "keyed-a", "-Withdraw", "-SignedRequestVerified", "-ObjectionTimeRecorded", "-ConfirmHandle", "keyed-a"];
  const r = await ride(W, { reads: [row(T0, null), row(null, T0 + 90_000)], changes: 1, census: [null, T0 + 90_000] });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.sql.map((s) => s.split(" ")[0]), ["SELECT", "UPDATE", "SELECT"]);
  assert.match(r.sql[1]!, /^UPDATE citizens SET assertion_objected_at = NULL WHERE handle = 'keyed-a'/);
  assert.match(r.out, /\[done\] withdraw recorded for keyed-a; GET \/api\/citizens serves last_assertion_at '1800000090000'/);
  const still = await ride(W, { reads: [row(T0, null), row(T0, null)], changes: 1, census: [null, null] });
  assert.equal(still.code, 1);
  assert.match(still.out, /\[STOP\] the stored flag is '1800000000000', expected NULL after a withdrawal/);
});

test("ride (L6): a withdraw on a seat with no recorded objection stops with its own message and sends no write, real or dry (red: the Test-WithdrawHasFlag call removed)", async () => {
  for (const extra of [["-SignedRequestVerified", "-ObjectionTimeRecorded", "-ConfirmHandle", "keyed-a"], ["-DryRun"]]) {
    const r = await ride(["-Handle", "keyed-a", "-Withdraw", ...extra], { reads: [row(null, T0)], changes: 1, census: [T0] });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /\[STOP\] there is no recorded objection to withdraw: the stored assertion_objected_at is NULL, so nothing was written/);
    assert.equal(r.sql.filter(isWrite).length, 0);
    assert.doesNotMatch(r.out, /\[done\]/);
  }
});
