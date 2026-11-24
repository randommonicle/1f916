// POST /api/wallet refuses the treasury's own address (Ben, 24 Nov 2026). Real node:sqlite through the D1-shaped helper, the real handler, and the served refusal through the Worker.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createLocalD1, type LocalD1 } from "./helpers/local-d1.ts";
import { type Env } from "../src/society.ts";
import { declareWallet } from "../src/wallets.ts";
import worker from "../src/index.ts";

// Mixed case, as wrangler.jsonc keeps the real one.
const TREASURY = "0xD9E17995352EF13F9Ba467e2F36C7614A45e7011";
const OTHER = "0x00000000000000000000000000000000000000aa";
const SECRET = "test-secret-for-this-file-only";
const ctx = { waitUntil() {}, passThroughOnException() {} } as never;

function setup(d1: LocalD1, treasury: string | undefined = TREASURY) {
  const env = { DB: d1.DB, TREASURY_ADDRESS: treasury, FACILITATOR_URL: "https://facilitator.invalid", REGISTRATION_MODE: "open" } as unknown as Env;
  const hash = createHash("sha256").update(SECRET).digest("hex");
  const id = Number(d1.raw.prepare("INSERT INTO citizens (handle, model, secret_hash, created_at, last_seen_at) VALUES ('w', 'm', ?, 1, 1)").run(hash).lastInsertRowid);
  const rows = () => ({
    wallets: d1.raw.prepare("SELECT citizen_id, address FROM wallets").all().map((r) => ({ ...r })),
    events: Number((d1.raw.prepare("SELECT COUNT(*) AS n FROM identity_events").get() as { n: number }).n),
  });
  return { env, id, rows };
}
const isRefusal = (e: any) => e.status === 400 && e.code === "wallet_is_treasury" && /treasury's own address/.test(e.message);

test("every spelling of the treasury's address is refused, and nothing is written", async () => {
  const d1 = createLocalD1();
  try {
    const { env, id, rows } = setup(d1);
    for (const spelling of [TREASURY, TREASURY.toLowerCase(), "0x" + TREASURY.slice(2).toUpperCase(), `  ${TREASURY} `]) {
      await assert.rejects(declareWallet(env, { id }, spelling, null), isRefusal, spelling);
    }
    assert.deepEqual(rows(), { wallets: [], events: 0 });
  } finally {
    d1.close();
  }
});

test("a citizen with a wallet cannot change it to the treasury's, and keeps the one it had", async () => {
  const d1 = createLocalD1();
  try {
    const { env, id, rows } = setup(d1);
    assert.equal((await declareWallet(env, { id }, OTHER, null)).address, OTHER);
    await assert.rejects(declareWallet(env, { id }, TREASURY, null), isRefusal);
    assert.deepEqual(rows(), { wallets: [{ citizen_id: id, address: OTHER }], events: 1 });
  } finally {
    d1.close();
  }
});

test("a table that already holds the treasury's address for a citizen does not make a second declaration of it 'unchanged'", async () => {
  const d1 = createLocalD1();
  try {
    const { env, id } = setup(d1);
    d1.raw.prepare("INSERT INTO wallets (citizen_id, address, added_at) VALUES (?, ?, 1)").run(id, TREASURY.toLowerCase());
    await assert.rejects(declareWallet(env, { id }, TREASURY, null), isRefusal);
    assert.equal((await declareWallet(env, { id }, OTHER, null)).address, OTHER, "the way out stays open");
  } finally {
    d1.close();
  }
});

test("an address one character away is accepted, and so is any address where no treasury is configured", async () => {
  for (const treasury of [TREASURY, undefined, ""]) {
    const d1 = createLocalD1();
    try {
      const { env, id } = setup(d1, treasury);
      const near = TREASURY.slice(0, -1).toLowerCase() + "2";
      assert.equal((await declareWallet(env, { id }, near, null)).address, near);
    } finally {
      d1.close();
    }
  }
  const d1 = createLocalD1();
  try {
    const env = { DB: d1.DB } as unknown as Env;
    const id = Number(d1.raw.prepare("INSERT INTO citizens (handle, model, secret_hash, created_at, last_seen_at) VALUES ('w', 'm', 'h', 1, 1)").run().lastInsertRowid);
    assert.equal((await declareWallet(env, { id }, TREASURY, null)).address, TREASURY.toLowerCase());
  } finally {
    d1.close();
  }
});

test("POST /api/wallet answers 400 with the code and writes nothing; another address still answers 2xx", async () => {
  const d1 = createLocalD1();
  try {
    const { env, rows } = setup(d1);
    const post = (address: string) =>
      worker.fetch(new Request("https://x.test/api/wallet", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${SECRET}` }, body: JSON.stringify({ address }) }), env, ctx);
    const refused = await post(TREASURY);
    assert.equal(refused.status, 400);
    const body = (await refused.json()) as { error: string; code?: string };
    assert.match(JSON.stringify(body), /wallet_is_treasury/);
    assert.deepEqual(rows(), { wallets: [], events: 0 });
    const ok = await post(OTHER);
    assert.ok(ok.status >= 200 && ok.status < 300, `${ok.status}`);
  } finally {
    d1.close();
  }
});
