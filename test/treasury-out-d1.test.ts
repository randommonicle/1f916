// payments_out on GET /treasury and GET /api/official, and the guard on scripts/put-treasury-key.mjs. Real node:sqlite through the D1-shaped helper and the committed schema.sql.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalD1, type LocalD1 } from "./helpers/local-d1.ts";
import { insertListing, insertSubmission } from "./helpers/local-d1.ts";
import { OPERATOR_WALLET, officialAnswer, officialFacts, treasury, type Env } from "../src/society.ts";
import { PAYMENTS_OUT_NOTE, paymentsOut } from "../src/treasury-out.ts";
import { treasuryKeyRefusal } from "../scripts/treasury-key-guard.mjs";
import worker from "../src/index.ts";
import { listingPaymentsPage } from "../src/listings.ts";
import { payoutsPage } from "../src/payouts.ts";
import { declareWallet } from "../src/wallets.ts";

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
function paidListing(d1: LocalD1, citizenId: number, payer: string, cents: number): void {
  const lid = insertListing(d1, { funder_citizen_id: citizenId, bounty_cents: cents });
  const sid = insertSubmission(d1, { listing_id: lid, citizen_id: citizenId });
  d1.raw
    .prepare("INSERT INTO listing_payments (listing_id, submission_id, payee_citizen_id, payee_address, payer_address, amount_cents, tx, created_at) VALUES (?, ?, ?, '0xa', ?, ?, ?, 1)")
    .run(lid, sid, citizenId, payer, cents, `0x${lid}`);
}

// Two payments from the operator's wallet (one written in mixed case), two from others, three treasury payouts: every figure differs from every other.
function seed(d1: LocalD1): void {
  const c = citizen(d1, "someone");
  paidListing(d1, c, OPERATOR_WALLET, 1200);
  paidListing(d1, c, OPERATOR_WALLET.replace(/[a-f]/g, (x) => x.toUpperCase()), 1500);
  paidListing(d1, c, "0x00000000000000000000000000000000000000aa", 700);
  paidListing(d1, c, "0x00000000000000000000000000000000000000ab", 100);
  for (const [n, cents] of [[1, 250], [2, 40], [3, 1]] as const) {
    d1.raw.prepare("INSERT INTO payouts (citizen_id, amount_cents, reason, tx, created_at, prev_hash, hash) VALUES (?, ?, 'prize', ?, 1, ?, ?)").run(c, cents, `0xp${n}`, `p${n}`, `h${n}`);
  }
}

test("the two books are counted apart, and payments from the operator's wallet are a part of the listing book, whatever the letter case of the stored address", async () => {
  const d1 = createLocalD1();
  try {
    seed(d1);
    const out = await paymentsOut(d1.DB as never, OPERATOR_WALLET.toUpperCase().replace("0X", "0x"));
    assert.deepEqual(out.from_treasury, { recorded_payouts: 3, total_cents: 291, code_can_pay: false, book: "GET /payouts" });
    assert.deepEqual(out.listing_bounties, { paid: 4, total_cents: 3500, paid_from_operator_wallet: { paid: 2, total_cents: 2700, wallet: OPERATOR_WALLET }, book: "GET /api/listings/payments" });
    assert.equal(out.note, PAYMENTS_OUT_NOTE);
  } finally {
    d1.close();
  }
});

test("empty books answer zeros, not nulls", async () => {
  const d1 = createLocalD1();
  try {
    const out = await paymentsOut(d1.DB as never, OPERATOR_WALLET);
    assert.deepEqual(out.from_treasury, { recorded_payouts: 0, total_cents: 0, code_can_pay: false, book: "GET /payouts" });
    assert.deepEqual(out.listing_bounties.paid_from_operator_wallet, { paid: 0, total_cents: 0, wallet: OPERATOR_WALLET });
    assert.deepEqual([out.listing_bounties.paid, out.listing_bounties.total_cents], [0, 0]);
  } finally {
    d1.close();
  }
});

test("GET /treasury, GET /api/treasury, GET /api/official and the official tool on both MCP doors serve the same payments_out", async () => {
  const d1 = createLocalD1();
  try {
    seed(d1);
    const env = makeEnv(d1);
    const want = await paymentsOut(d1.DB as never, OPERATOR_WALLET);
    const ctx = { waitUntil() {}, passThroughOnException() {} } as never;
    const ask = async (req: Request): Promise<any> => {
      const res = await worker.fetch(req, env, ctx);
      assert.equal(res.status, 200, req.url);
      return res.json();
    };
    for (const path of ["/treasury", "/api/treasury"]) assert.deepEqual((await ask(new Request(`https://x.test${path}`))).payments_out, want, path);
    const treasuryBlock = { address: env.TREASURY_ADDRESS, network: "base", asset: "USDC", payments_out: want };
    assert.deepEqual((await ask(new Request("https://x.test/api/official"))).treasury, treasuryBlock);
    for (const path of ["/mcp", "/mcp/read"]) {
      const reply = await ask(
        new Request(`https://x.test${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "official", arguments: {} } }),
        }),
      );
      assert.deepEqual(JSON.parse(reply.result.content[0].text).treasury, treasuryBlock, path);
    }
    // The other callers of officialFacts serve no treasury payments, so it does not read them.
    assert.deepEqual((await officialFacts(env)).treasury, { address: env.TREASURY_ADDRESS, network: "base", asset: "USDC" });
    const { treasury: _a, ...rest } = (await officialAnswer(env)) as Record<string, unknown>;
    const { treasury: _b, ...facts } = (await officialFacts(env)) as Record<string, unknown>;
    assert.deepEqual(Object.keys(rest), Object.keys(facts), "officialAnswer drops and adds no other key");
    assert.equal(((await treasury(env)) as unknown as { wallet: { address: string } }).wallet.address, env.TREASURY_ADDRESS);
  } finally {
    d1.close();
  }
});

// The note's one claim about code. If a signer is ever written, this goes red until the note and code_can_pay are rewritten with it. It reads for names; a signer that uses none of
// them, under another binding name, would pass it.
const SIGNING = [
  ["the key's name", /TREASURY_KEY/, "env.TREASURY_KEY"],
  ["a broadcast", /eth_send(Raw)?Transaction/, 'method: "eth_sendRawTransaction"'],
  ["an account from a key", /privateKeyTo|fromPrivateKey/, "privateKeyToAccount(k)"],
  ["a signing call", /\bsign(TypedData|Transaction|Message|Authorization)\b/, "account.signTypedData(x)"],
  ["a wallet client", /createWalletClient|sendTransaction/, "createWalletClient({})"],
  ["a signing library", /["'](viem|ethers|x402|x402-fetch|@noble\/curves|@coinbase\/x402)(\/[^"']*)?["']/, "await import('viem/accounts')"],
  ["a curve only wallets use", /secp256k1/, "secp256k1.sign(h, k)"],
] as const;

test("no file under src/ names the treasury key or signs or broadcasts a transfer, which is what the note says", () => {
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|js|mjs)$/.test(p)) files.push(p);
    }
  };
  walk(join(ROOT, "src"));
  assert.ok(files.length > 30, `the walk must see the source tree, saw ${files.length}`);
  for (const [what, pattern, example] of SIGNING) {
    assert.match(example, pattern, `the pattern for ${what} matches its own example`);
    const hits = files.filter((f) => pattern.test(readFileSync(f, "utf8")));
    assert.deepEqual(hits, [], `PAYMENTS_OUT_NOTE says the published source holds no code that sends money from the treasury address, and src/ contains ${what}`);
  }
});

// Any edit to the note comes through here: re-derive each sentence before changing the hash.
test("the note is the text that was reviewed", () => {
  assert.equal(createHash("sha256").update(PAYMENTS_OUT_NOTE, "utf8").digest("hex"), "45495b7de574ffaa492d1c8a86a834791874fa710d06fd065b82f94581e6e200");
});

test("the script does with the key what the note says: it is generated, its address derived, and it is piped to wrangler's stdin, and nothing else", () => {
  const code = readFileSync(join(ROOT, "scripts", "put-treasury-key.mjs"), "utf8").replace(/^\s*\/\/.*$/gm, "");
  const uses = code.split("\n").filter((l) => /\bkey\b/.test(l.replace(/"(?:\\.|[^"\\])*"/g, ""))).map((l) => l.trim());
  assert.deepEqual(uses, ["const key = generatePrivateKey();", "const address = privateKeyToAccount(key).address;", "input: key,"]);
});

test("the note's claims about other routes hold: POST /api/wallet refuses the treasury's own address, and both books serve the newest 200", async () => {
  const d1 = createLocalD1();
  try {
    const env = makeEnv(d1);
    const c = citizen(d1, "someone");
    await assert.rejects(declareWallet(env, { id: c }, env.TREASURY_ADDRESS, null), (e: any) => e.status === 400 && e.code === "wallet_is_treasury");
    const lid = insertListing(d1, { funder_citizen_id: c, bounty_cents: 100 });
    const sid = insertSubmission(d1, { listing_id: lid, citizen_id: c });
    for (let i = 1; i <= 201; i++) {
      d1.raw.prepare("INSERT INTO payouts (citizen_id, amount_cents, reason, tx, created_at, prev_hash, hash) VALUES (?, 1, 'r', ?, ?, ?, ?)").run(c, `0xp${i}`, i, `pp${i}`, `ph${i}`);
      d1.raw
        .prepare("INSERT INTO listing_payments (listing_id, submission_id, payee_citizen_id, payee_address, payer_address, amount_cents, tx, created_at) VALUES (?, ?, ?, '0xa', ?, 100, ?, ?)")
        .run(lid, sid, c, OPERATOR_WALLET, `0xl${i}`, i);
    }
    for (const page of [await payoutsPage(env), await listingPaymentsPage(env)]) {
      const times = (page.entries as { created_at: number }[]).map((e) => e.created_at);
      assert.deepEqual([times.length, times[0], times[199]], [200, 201, 2]);
    }
  } finally {
    d1.close();
  }
});

// ---------- scripts/put-treasury-key.mjs ----------

test("the guard goes on only for a readable list that does not hold TREASURY_KEY", () => {
  const list = (...names: string[]) => JSON.stringify(names.map((name) => ({ name, type: "secret_text" })));
  for (const ok of [list(), list("MAINTAINER_SECRET", "TREASURY_KEY_OLD")]) assert.equal(treasuryKeyRefusal(0, ok), null, ok);
  assert.match(treasuryKeyRefusal(0, list("MAINTAINER_SECRET", "TREASURY_KEY")) ?? "", /already holds TREASURY_KEY/);
  for (const [status, out] of [
    [1, list()],
    [null, list()],
    [0, ""],
    [0, "not json"],
    [0, "{}"],
    [0, "null"],
    [0, "[null]"],
    [0, '["TREASURY_KEY"]'],
    [0, undefined],
  ] as const) {
    assert.match(treasuryKeyRefusal(status, out as never) ?? "", /gave no answer this check can read/, `${status} ${out}`);
  }
});

// Runs the real script in a temp tree with no node_modules, from another directory, with a stub npx that logs its arguments. It can reach neither viem nor wrangler whatever the guard does.
function runKeyScript(answer: string, args: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "treasury-key-"));
  try {
    for (const d of ["scripts", "bin", "elsewhere"]) mkdirSync(join(dir, d));
    for (const f of ["put-treasury-key.mjs", "treasury-key-guard.mjs"]) copyFileSync(join(ROOT, "scripts", f), join(dir, "scripts", f));
    const log = join(dir, "npx.log");
    writeFileSync(join(dir, "answer.json"), answer);
    const stub = join(dir, "bin", "stub.mjs");
    writeFileSync(stub, `import { appendFileSync, readFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");\nprocess.stdout.write(readFileSync(${JSON.stringify(join(dir, "answer.json"))}, "utf8"));\n`);
    writeFileSync(join(dir, "bin", "npx.cmd"), `@"${process.execPath}" "${stub}" %*\r\n`);
    writeFileSync(join(dir, "bin", "npx"), `#!/bin/sh\nexec "${process.execPath}" "${stub}" "$@"\n`, { mode: 0o755 });
    const r = spawnSync(process.execPath, [join(dir, "scripts", "put-treasury-key.mjs"), ...args], {
      cwd: join(dir, "elsewhere"),
      env: { SystemRoot: process.env.SystemRoot ?? "", ComSpec: process.env.ComSpec ?? "", PATHEXT: ".CMD;.EXE", PATH: join(dir, "bin") },
      encoding: "utf8",
    });
    const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]) : [];
    return { status: r.status, out: `${r.stdout}${r.stderr}`, calls, config: join(dir, "wrangler.jsonc") };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("put-treasury-key.mjs asks this Worker first, and refuses before it loads a key library or stores anything", () => {
  for (const [answer, want] of [
    ['[{"name":"TREASURY_KEY","type":"secret_text"}]', /REFUSED: this Worker already holds TREASURY_KEY/],
    ["oops", /REFUSED: wrangler secret list gave no answer/],
  ] as const) {
    const r = runKeyScript(answer);
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, want);
    assert.doesNotMatch(r.out, /viem/, "it must stop before it needs viem");
    assert.deepEqual(r.calls, [["wrangler", "secret", "list", "--format", "json", "--config", r.config]], "one call, a list, on the config beside the script whatever the working directory");
  }
});

test("put-treasury-key.mjs goes past the guard when the Worker holds no TREASURY_KEY (it then needs viem, absent here), and a dry run asks nothing", () => {
  const fresh = runKeyScript('[{"name":"MAINTAINER_SECRET","type":"secret_text"}]');
  assert.match(fresh.out, /Cannot find package 'viem'/);
  assert.equal(fresh.calls.length, 1);
  const dry = runKeyScript('[{"name":"TREASURY_KEY","type":"secret_text"}]', ["--dry-run"]);
  assert.match(dry.out, /Cannot find package 'viem'/);
  assert.deepEqual(dry.calls, []);
});

test("the put names the same config file as the list", () => {
  const code = readFileSync(join(ROOT, "scripts", "put-treasury-key.mjs"), "utf8");
  assert.ok(code.includes('spawnSync(`npx wrangler secret put TREASURY_KEY --config "${configPath}"`, {'));
});
