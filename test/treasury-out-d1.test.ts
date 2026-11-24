// payments_out on GET /treasury and GET /api/official, and the guard on scripts/put-treasury-key.mjs. Real node:sqlite through the D1-shaped helper and the committed schema.sql.
import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalD1, type LocalD1 } from "./helpers/local-d1.ts";
import { insertListing, insertSubmission } from "./helpers/local-d1.ts";
import { OPERATOR_WALLET, officialAnswer, officialFacts, treasury, type Env } from "../src/society.ts";
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
function paidListing(d1: LocalD1, citizenId: number, payer: string, cents: number): void {
  const lid = insertListing(d1, { funder_citizen_id: citizenId, bounty_cents: cents });
  const sid = insertSubmission(d1, { listing_id: lid, citizen_id: citizenId });
  d1.raw
    .prepare("INSERT INTO listing_payments (listing_id, submission_id, payee_citizen_id, payee_address, payer_address, amount_cents, tx, created_at) VALUES (?, ?, ?, '0xa', ?, ?, ?, 1)")
    .run(lid, sid, citizenId, payer, cents, `0x${lid}`);
}

// Two payments from the operator's wallet (one written in mixed case), one from another, two treasury payouts: every figure differs from every other.
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
    const out = await paymentsOut(d1.DB as never, OPERATOR_WALLET);
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
    assert.deepEqual(hits, [], `PAYMENTS_OUT_NOTE says no code here can send money from the treasury address, and src/ contains ${what}`);
  }
});

// Any edit to the note comes through here: re-derive each sentence before changing the hash.
test("the note is the text that was reviewed", () => {
  assert.equal(createHash("sha256").update(PAYMENTS_OUT_NOTE, "utf8").digest("hex"), "76e41c7cda21aa0ec88739ea51d65ce4788e9d318c463c6ceda54308e8426a1d");
});

test("the script does with the key what the note says: it is generated, its address derived, and it is piped to wrangler's stdin, and nothing else", () => {
  const code = readFileSync(join(ROOT, "scripts", "put-treasury-key.mjs"), "utf8").replace(/^\s*\/\/.*$/gm, "");
  const uses = code.split("\n").filter((l) => /\bkey\b/.test(l.replace(/"[^"]*"/g, ""))).map((l) => l.trim());
  assert.deepEqual(uses, ["const key = generatePrivateKey();", "const address = privateKeyToAccount(key).address;", "input: key,"]);
});

// ---------- scripts/put-treasury-key.mjs ----------

test("the guard refuses unless every mention of TREASURY_ADDRESS is blank and there is one", () => {
  const addr = "0xD9E17995352EF13F9Ba467e2F36C7614A45e7011";
  const blank = '{ "TREASURY_ADDRESS": "" }';
  for (const text of [
    `{ "vars": { "TREASURY_ADDRESS": "${addr}" } }`,
    `{ TREASURY_ADDRESS : '${addr}' }`,
    `// "TREASURY_ADDRESS": "${addr}"\n${blank}`,
    `${blank}\n{ "TREASURY_ADDRESS": " ${addr} " }`,
  ]) {
    assert.match(treasuryKeyRefusal(text) ?? "", /names a treasury \(0xD9E17995352EF13F9Ba467e2F36C7614A45e7011\)/, text);
  }
  for (const text of [`${blank}\n{ "TREASURY_ADDRESS": 12 }`, `// TREASURY_ADDRESS = ${addr}\n${blank}`, '{ "TREASURY_ADDRESS": 12 }', '{ TREASURY_ADDRESS: "" }', '{ "name": "x" }', ""]) {
    assert.match(treasuryKeyRefusal(text) ?? "", /does not say plainly that there is no treasury/, text);
  }
  for (const text of [null, undefined]) assert.match(treasuryKeyRefusal(text as never) ?? "", /could not be read/);
  for (const text of [blank, "{ 'TREASURY_ADDRESS' : ' ' }"]) assert.equal(treasuryKeyRefusal(text), null, text);
});

test("the committed wrangler.jsonc refuses, so this repository's own treasury is protected", () => {
  assert.match(treasuryKeyRefusal(readFileSync(join(ROOT, "wrangler.jsonc"), "utf8")) ?? "", /names a treasury/);
});

test("wrangler is told to use the file the guard read", () => {
  const code = readFileSync(join(ROOT, "scripts", "put-treasury-key.mjs"), "utf8");
  assert.equal(code.split("configPath").length - 1, 3, "defined once, read by the guard once, passed to wrangler once");
  assert.ok(code.includes('spawnSync(`npx wrangler secret put TREASURY_KEY --config "${configPath}"`, {'));
  assert.ok(code.includes('config = readFileSync(configPath, "utf8");'));
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
    ['{ "TREASURY_ADDRESS": "0xabc" }', /names a treasury \(0xabc\)/],
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
    assert.doesNotMatch(r.out, /REFUSED/);
  }
});
