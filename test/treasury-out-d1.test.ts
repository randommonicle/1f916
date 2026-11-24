// payments_out on GET /treasury and GET /api/official, and the guard on scripts/put-treasury-key.mjs. Real node:sqlite through the D1-shaped helper and the committed schema.sql.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalD1, type LocalD1 } from "./helpers/local-d1.ts";
import { insertListing, insertSubmission } from "./helpers/local-d1.ts";
import { OPERATOR_CONTROLLED_HANDLES, officialFacts, treasury, type Env } from "../src/society.ts";
import { PAYMENTS_OUT_NOTE, paymentsOut } from "../src/treasury-out.ts";
import { treasuryKeyRefusal } from "../scripts/treasury-key-guard.mjs";
import worker from "../src/index.ts";

const ROOT = join(import.meta.dirname, "..");
const realFetch = globalThis.fetch;
globalThis.fetch = (async () => new Response("rpc stubbed in test", { status: 500 })) as typeof fetch;
after(() => {
  globalThis.fetch = realFetch;
});

const makeEnv = (d1: LocalD1): Env =>
  ({ DB: d1.DB, TREASURY_ADDRESS: "0x0000000000000000000000000000000000000001", FACILITATOR_URL: "https://facilitator.invalid", REGISTRATION_MODE: "open" }) as unknown as Env;

const citizen = (d1: LocalD1, handle: string): number =>
  Number(d1.raw.prepare("INSERT INTO citizens (handle, model, secret_hash, created_at, last_seen_at) VALUES (?, 'm', ?, 1, 1)").run(handle, `h-${handle}`).lastInsertRowid);
function paidListing(d1: LocalD1, funder: number, reviewer: number, cents: number): void {
  const lid = insertListing(d1, { funder_citizen_id: funder, bounty_cents: cents });
  const sid = insertSubmission(d1, { listing_id: lid, citizen_id: reviewer });
  d1.raw
    .prepare("INSERT INTO listing_payments (listing_id, submission_id, payee_citizen_id, payee_address, payer_address, amount_cents, tx, created_at) VALUES (?, ?, ?, '0xa', '0xb', ?, ?, 1)")
    .run(lid, sid, reviewer, cents, `0x${lid}`);
}

// Two operator-funded payments of different sizes, one from an outside funder, one treasury payout: every figure differs from every other.
function seed(d1: LocalD1): void {
  const op = citizen(d1, OPERATOR_CONTROLLED_HANDLES[0]);
  const op2 = citizen(d1, OPERATOR_CONTROLLED_HANDLES[OPERATOR_CONTROLLED_HANDLES.length - 1]);
  const outside = citizen(d1, "outside-funder");
  const reviewer = citizen(d1, "reviewer");
  paidListing(d1, op, reviewer, 1200);
  paidListing(d1, op2, reviewer, 1500);
  paidListing(d1, outside, reviewer, 700);
  d1.raw.prepare("INSERT INTO payouts (citizen_id, amount_cents, reason, tx, created_at, prev_hash, hash) VALUES (?, 250, 'prize', '0xp', 1, 'p', 'h')").run(reviewer);
}

test("the two books are counted apart, and the operator's own funders are a part of the listing book", async () => {
  const d1 = createLocalD1();
  try {
    seed(d1);
    const out = await paymentsOut(d1.DB as never, OPERATOR_CONTROLLED_HANDLES);
    assert.deepEqual(out.from_treasury, { recorded_payouts: 1, total_cents: 250, code_can_pay: false, book: "GET /payouts" });
    assert.deepEqual(out.listing_bounties, { paid: 3, total_cents: 3400, operator_controlled_funders: { paid: 2, total_cents: 2700 }, book: "GET /api/listings/payments" });
    assert.equal(out.note, PAYMENTS_OUT_NOTE);
  } finally {
    d1.close();
  }
});

test("empty books answer zeros, not nulls", async () => {
  const d1 = createLocalD1();
  try {
    const out = await paymentsOut(d1.DB as never, OPERATOR_CONTROLLED_HANDLES);
    assert.deepEqual([out.from_treasury.recorded_payouts, out.from_treasury.total_cents, out.listing_bounties.paid, out.listing_bounties.total_cents], [0, 0, 0, 0]);
    assert.deepEqual(out.listing_bounties.operator_controlled_funders, { paid: 0, total_cents: 0 });
  } finally {
    d1.close();
  }
});

test("GET /treasury (both paths) and GET /api/official serve the same payments_out, and what they served before is still there", async () => {
  const d1 = createLocalD1();
  try {
    seed(d1);
    const env = makeEnv(d1);
    const want = await paymentsOut(d1.DB as never, OPERATOR_CONTROLLED_HANDLES);
    const t = (await treasury(env)) as unknown as { payments_out: unknown; wallet: { address: string } };
    assert.deepEqual(t.payments_out, want);
    assert.equal(t.wallet.address, env.TREASURY_ADDRESS);
    const o = (await officialFacts(env)) as unknown as { treasury: Record<string, unknown> };
    assert.deepEqual(o.treasury, { address: env.TREASURY_ADDRESS, network: "base", asset: "USDC", payments_out: want });
    const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
    for (const [path, pick] of [
      ["/treasury", (j: any) => j.payments_out],
      ["/api/official", (j: any) => j.treasury.payments_out],
    ] as const) {
      const res = await worker.fetch(new Request(`https://x.test${path}`), env, ctx);
      assert.equal(res.status, 200, path);
      assert.deepEqual(pick(await res.json()), want, path);
    }
  } finally {
    d1.close();
  }
});

// The note's one claim about code. If a signer is ever written, this goes red until the note and code_can_pay are rewritten with it.
test("no file under src/ names the treasury key or signs or broadcasts a transfer, which is what the note says", () => {
  const signing = /TREASURY_KEY|eth_sendRawTransaction|eth_sendTransaction|privateKeyTo|signTypedData|signTransaction|sendTransaction|createWalletClient|from "viem|from "x402/;
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts")) files.push(p);
    }
  };
  walk(join(ROOT, "src"));
  assert.ok(files.length > 30, `the walk must see the source tree, saw ${files.length}`);
  const hits = files.filter((f) => signing.test(readFileSync(f, "utf8")));
  assert.deepEqual(hits, [], "PAYMENTS_OUT_NOTE says no code here can send money from the treasury address");
  assert.ok(signing.test('const a = privateKeyToAccount(env.TREASURY_KEY)'), "the pattern matches a signer");
});

test("the note claims no more than is known", () => {
  assert.match(PAYMENTS_OUT_NOTE, /No code in this service can send money from the treasury address: POST \/api\/payout records a transfer and does not make one\./);
  assert.match(PAYMENTS_OUT_NOTE, /by the operator's statement of 24 November 2026 the operator holds no copy of it anywhere else;/);
  assert.match(PAYMENTS_OUT_NOTE, /and that no copy exists, cannot be checked from outside\./);
  assert.match(PAYMENTS_OUT_NOTE, /They say what was recorded;/);
});

// ---------- scripts/put-treasury-key.mjs ----------

test("the guard refuses every form of a configured treasury and allows a blank or absent one", () => {
  const addr = "0xD9E17995352EF13F9Ba467e2F36C7614A45e7011";
  for (const text of [`{ "vars": { "TREASURY_ADDRESS": "${addr}" } }`, `{ TREASURY_ADDRESS : '${addr}' }`, `// "TREASURY_ADDRESS": "${addr}"\n{ "TREASURY_ADDRESS": "" }`]) {
    assert.match(treasuryKeyRefusal(text) ?? "", /already names a treasury \(0xD9E1/, text);
  }
  assert.match(treasuryKeyRefusal(null) ?? "", /could not be read/);
  assert.match(treasuryKeyRefusal('{ "TREASURY_ADDRESS": 12 }') ?? "", /a form this check does not read/);
  assert.equal(treasuryKeyRefusal('{ "TREASURY_ADDRESS": "" }'), null);
  assert.equal(treasuryKeyRefusal('{ "name": "x" }'), null);
});

test("the committed wrangler.jsonc refuses, so this repository's own treasury is protected", () => {
  assert.match(treasuryKeyRefusal(readFileSync(join(ROOT, "wrangler.jsonc"), "utf8")) ?? "", /already names a treasury/);
});

// Runs the real script in a temp tree with no node_modules and no PATH, so it can reach neither viem nor wrangler whatever the guard does.
function runKeyScript(jsonc: string | null, args: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "treasury-key-"));
  try {
    mkdirSync(join(dir, "scripts"));
    for (const f of ["put-treasury-key.mjs", "treasury-key-guard.mjs"]) copyFileSync(join(ROOT, "scripts", f), join(dir, "scripts", f));
    if (jsonc !== null) writeFileSync(join(dir, "wrangler.jsonc"), jsonc);
    const r = spawnSync(process.execPath, [join(dir, "scripts", "put-treasury-key.mjs"), ...args], { cwd: dir, env: { SystemRoot: process.env.SystemRoot ?? "" }, encoding: "utf8" });
    return { status: r.status, out: `${r.stdout}${r.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("put-treasury-key.mjs refuses before it loads a key library, when a treasury is configured or the config cannot be read", () => {
  for (const [jsonc, want] of [
    ['{ "TREASURY_ADDRESS": "0xabc" }', /already names a treasury \(0xabc\)/],
    [null, /could not be read/],
  ] as const) {
    const r = runKeyScript(jsonc);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, want);
    assert.doesNotMatch(r.out, /viem/, "it must stop before it needs viem");
  }
});

test("put-treasury-key.mjs goes past the guard with a blank address, and a dry run is never guarded (both then need viem, absent here)", () => {
  for (const r of [runKeyScript('{ "TREASURY_ADDRESS": "" }'), runKeyScript('{ "TREASURY_ADDRESS": "0xabc" }', ["--dry-run"])]) {
    assert.match(r.out, /Cannot find package 'viem'/);
    assert.doesNotMatch(r.out, /already names a treasury/);
  }
});
