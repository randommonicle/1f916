// POST /api/wallet refuses the treasury's own address (Ben, 24 Nov 2026). Real node:sqlite through the D1-shaped helper, the real handler, and the served refusal through the Worker.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createLocalD1, insertCitizen, insertListing, insertSubmission, type LocalD1 } from "./helpers/local-d1.ts";
import { declareTestWallet } from "./helpers/wallet-pin.ts";
import { atomicFromCents, paymentHeaderFor } from "./helpers/x402-payload.ts";
import { FACILITATOR_URL, TX, stubFacilitator } from "./helpers/settlement-harness.ts";
import { handlePayListing } from "../src/listings.ts";
import { claimIdentity, claimKeyFromPayload, markContradiction, takeClaim } from "../src/settlement-claims.ts";
import { type Env } from "../src/society.ts";
import { declareWallet } from "../src/wallets.ts";
import worker from "../src/index.ts";

// Mixed case, as wrangler.jsonc keeps the real one.
const TREASURY = "0xD9E17995352EF13F9Ba467e2F36C7614A45e7011";
const OTHER = "0x00000000000000000000000000000000000000aa";
const SECRET = "test-secret-for-this-file-only";
const ctx = { waitUntil() {}, passThroughOnException() {} } as never;

function setup(d1: LocalD1, vars: { TREASURY_ADDRESS?: string } = { TREASURY_ADDRESS: TREASURY }) {
  const env = { DB: d1.DB, ...vars, FACILITATOR_URL: "https://facilitator.invalid", REGISTRATION_MODE: "open" } as unknown as Env;
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

test("an address one character away is accepted", async () => {
  const d1 = createLocalD1();
  try {
    const { env, id } = setup(d1);
    const near = TREASURY.slice(0, -1).toLowerCase() + "2";
    assert.equal((await declareWallet(env, { id }, near, null)).address, near);
  } finally {
    d1.close();
  }
});

test("where no treasury is configured (absent, undefined or blank) nothing is refused; a padded configuration still refuses", async () => {
  for (const vars of [{}, { TREASURY_ADDRESS: undefined }, { TREASURY_ADDRESS: "" }, { TREASURY_ADDRESS: " " }]) {
    const d1 = createLocalD1();
    try {
      const { env, id } = setup(d1, vars);
      assert.equal((await declareWallet(env, { id }, TREASURY, null)).address, TREASURY.toLowerCase(), JSON.stringify(vars));
    } finally {
      d1.close();
    }
  }
  const d1 = createLocalD1();
  try {
    const { env, id } = setup(d1, { TREASURY_ADDRESS: ` ${TREASURY} ` });
    await assert.rejects(declareWallet(env, { id }, TREASURY, null), isRefusal);
  } finally {
    d1.close();
  }
});

test("the refusal comes before the signed intent: a key citizen is not asked to sign for an address that will be refused", async () => {
  const d1 = createLocalD1();
  try {
    const { env, id } = setup(d1);
    const unbound = `ch1.${Buffer.from(JSON.stringify({ c: "w" })).toString("base64url")}.AA`;
    await assert.rejects(declareWallet(env, { id }, OTHER, unbound), (e: any) => e.code !== "wallet_is_treasury" && e.status === 403, "the same credential on another address is refused for its intent");
    await assert.rejects(declareWallet(env, { id }, TREASURY, unbound), isRefusal);
  } finally {
    d1.close();
  }
});

// A row written before this rule (or by a database edit): table and chained row agree, and the pin is right, so nothing else would stop it.
test("the pay route refuses a submitter whose wallet row is the treasury, on the probe and on a signed payment, and reserves and settles nothing", async () => {
  const d1 = createLocalD1();
  const realFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches++;
    return new Response("{}", { status: 500 });
  }) as typeof fetch;
  try {
    const { env } = setup(d1);
    const funderId = insertCitizen(d1);
    const reviewerId = insertCitizen(d1);
    const funder = d1.raw.prepare("SELECT id, handle, model, karma, created_at, last_seen_at FROM citizens WHERE id = ?").get(funderId) as never;
    const listingId = insertListing(d1, { funder_citizen_id: funderId, bounty_cents: 1200 });
    const submissionId = insertSubmission(d1, { listing_id: listingId, citizen_id: reviewerId });
    const ask = async (wallet: string, pay: boolean) => {
      const row = await declareTestWallet(d1, reviewerId, wallet);
      const headers: Record<string, string> = { "content-type": "application/json", ...(pay ? { "X-PAYMENT": paymentHeaderFor(wallet, atomicFromCents(1200)) } : {}) };
      const req = new Request(`https://x.test/api/listing/${listingId}/pay`, { method: "POST", headers, body: JSON.stringify({ submission_id: submissionId, wallet_row_id: row.id, wallet_row_hash: row.hash }) });
      return handlePayListing(req, env, funder, listingId);
    };
    assert.equal((await ask(OTHER, false)).status, 402, "the same request for another wallet is answered with payment requirements");
    for (const pay of [false, true]) {
      await assert.rejects(ask(TREASURY.toLowerCase(), pay), (e: any) => e.status === 409 && e.code === "wallet_is_treasury", `pay=${pay}`);
    }
    assert.equal(fetches, 0, "the facilitator was never called");
    assert.equal((d1.raw.prepare("SELECT status FROM listings WHERE id = ?").get(listingId) as { status: string }).status, "open");
    assert.equal((d1.raw.prepare("SELECT COUNT(*) AS n FROM listing_payments").get() as { n: number }).n, 0);
  } finally {
    globalThis.fetch = realFetch;
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
    assert.equal(body.code, "wallet_is_treasury");
    assert.deepEqual(rows(), { wallets: [], events: 0 });
    const ok = await post(OTHER);
    assert.ok(ok.status >= 200 && ok.status < 300, `${ok.status}`);
  } finally {
    d1.close();
  }
});

// Where the pay refusals stand, and what they may say when a claim already exists (Opus gate L3 and L4, 24 Nov 2026; CODEX, 25 Nov 2026).
const REQS = { network: "base", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" };
const EARLIER = / This request issued no payment requirements and sent nothing to the facilitator's \/settle\. That does not establish the outcome of an earlier signed payment: if you are retrying one, do not sign another until its outcome has been checked\.$/;

async function payRoute(d1: LocalD1) {
  const { env } = setup(d1);
  const vars = env as unknown as { FACILITATOR_URL: string; TREASURY_ADDRESS: string };
  vars.FACILITATOR_URL = FACILITATOR_URL;
  const funderId = insertCitizen(d1);
  const reviewerId = insertCitizen(d1);
  const funder = d1.raw.prepare("SELECT id, handle, model, karma, created_at, last_seen_at FROM citizens WHERE id = ?").get(funderId) as never;
  const listingId = insertListing(d1, { funder_citizen_id: funderId, bounty_cents: 1200 });
  const submissionId = insertSubmission(d1, { listing_id: listingId, citizen_id: reviewerId });
  const declare = (wallet: string) => declareTestWallet(d1, reviewerId, wallet);
  const pay = async (pin: { id: number; hash: string }, header?: string) => {
    const headers: Record<string, string> = { "content-type": "application/json", ...(header ? { "X-PAYMENT": header } : {}) };
    const req = new Request(`https://x.test/api/listing/${listingId}/pay`, { method: "POST", headers, body: JSON.stringify({ submission_id: submissionId, wallet_row_id: pin.id, wallet_row_hash: pin.hash }) });
    try {
      const res = await handlePayListing(req, env, funder, listingId);
      return { status: res.status, ...((await res.json()) as { code?: string; error?: string }) };
    } catch (e: any) {
      return { status: e.status as number, code: e.code as string | undefined, error: e.message as string };
    }
  };
  return { env, vars, declare, pay, listingId };
}

test("the pay refusal comes before the pin check: a wrong pin on a treasury row is answered as the treasury row", async () => {
  const d1 = createLocalD1();
  try {
    const { declare, pay } = await payRoute(d1);
    const wrong = (row: { id: number }) => ({ id: row.id, hash: "0".repeat(64) });
    assert.equal((await pay(wrong(await declare(OTHER)))).code, "wallet_row_hash", "the same wrong pin on another address fails the pin check");
    assert.equal((await pay(wrong(await declare(TREASURY.toLowerCase())))).code, "wallet_is_treasury");
  } finally {
    d1.close();
  }
});

test("the pay refusal comes before an existing claim is consulted", async () => {
  const d1 = createLocalD1();
  try {
    const { env, declare, pay } = await payRoute(d1);
    const header = paymentHeaderFor(OTHER, atomicFromCents(1200));
    const payload = JSON.parse(atob(header));
    const { key, validBefore } = claimKeyFromPayload(payload, REQS);
    const spec = { route: "patron" as const, intent: { line: "another request" } };
    assert.deepEqual(await takeClaim(env, await claimIdentity(key, validBefore, { paymentPayload: payload, other: true }, spec), spec, "seed", Date.now()), { taken: true });
    assert.equal((await pay(await declare(OTHER), header)).code, "settlement_claim_conflict", "for another address the existing claim answers");
    assert.equal((await pay(await declare(TREASURY.toLowerCase()), header)).code, "wallet_is_treasury");
  } finally {
    d1.close();
  }
});

// The case the old words ("Nothing was issued or settled") were false in: the money of the earlier payment may have moved.
for (const kind of ["wallet_is_treasury", "wallet_row_superseded"] as const) {
  test(`a re-send of a payment whose claim is contradicted, refused as ${kind}, still says not to sign another`, async () => {
    const d1 = createLocalD1();
    const stub = stubFacilitator({ settle: () => new Response("{}", { status: 500 }) });
    try {
      const { env, vars, declare, pay, listingId } = await payRoute(d1);
      const pin = await declare(OTHER);
      const header = paymentHeaderFor(OTHER, atomicFromCents(1200));
      await pay(pin, header);
      const { key } = claimKeyFromPayload(JSON.parse(atob(header)), REQS);
      assert.equal(stub.calls.settle, 1, "the first request was sent to /settle and its outcome is unknown");
      // What a reopened listing with an expired claim looks like once a late success contradicts the expiry.
      d1.raw.prepare("UPDATE settlement_claims SET state = 'expired', rpc_body = NULL").run();
      d1.raw.prepare("UPDATE listings SET status = 'open', paying_since = NULL, paying_wallet_row_id = NULL, paying_wallet_row_hash = NULL WHERE id = ?").run(listingId);
      assert.equal(await markContradiction(env, key, TX, Date.now()), true);
      const control = await pay(pin, header);
      assert.equal(control.code, "settlement_contradiction", JSON.stringify(control));
      assert.match(control.error ?? "", /The money may have moved.*Do not sign again/);
      if (kind === "wallet_is_treasury") vars.TREASURY_ADDRESS = OTHER;
      else await declare("0x00000000000000000000000000000000000000bb");
      const refused = await pay(pin, header);
      assert.equal(refused.status, 409);
      assert.equal(refused.code, kind);
      assert.match(refused.error ?? "", EARLIER);
      assert.equal(stub.calls.settle, 1, "and nothing more was sent");
    } finally {
      stub.restore();
      d1.close();
    }
  });
}

test("all seven pre-402 pay refusals (six pin checks and the treasury check) share PAY_REFUSED_BEFORE_402 and none says 'Nothing was issued or settled'", async () => {
  const raw = await readFile(new URL("../src/listings.ts", import.meta.url), "utf8");
  const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
  assert.doesNotMatch(code, /Nothing was issued or settled/);
  const pinStart = code.indexOf("async function assertWalletPinCurrent");
  const payStart = code.indexOf("export async function handlePayListing");
  const replayAt = code.indexOf("replayForClaim(", payStart);
  assert.ok(pinStart !== -1 && payStart > pinStart && replayAt > payStart, "expected functions and replayForClaim boundary present");
  assert.equal(code.slice(pinStart, payStart).split("${PAY_REFUSED_BEFORE_402}").length - 1, 6, "six pin refusals");
  assert.equal(code.slice(payStart, replayAt).split("${PAY_REFUSED_BEFORE_402}").length - 1, 1, "the treasury refusal before replayForClaim");
  // the count alone would pass with the sentence moved to another message in the slice (Sonnet gate, 25 Nov 2026): each refusal's own message ends with it
  for (const c of ["wallet_row_missing", "wallet_row_kind", "wallet_row_citizen", "wallet_row_superseded", "wallet_row_hash", "wallet_row_address", "wallet_is_treasury"])
    assert.match(code.slice(pinStart, replayAt), new RegExp('\\$\\{PAY_REFUSED_BEFORE_402\\}`,\\s*"' + c + '"'), c);
});

test("the declaration's refusal says nothing was written, and the route's own description names the refusal", async () => {
  const d1 = createLocalD1();
  try {
    const { env, id } = setup(d1);
    await assert.rejects(declareWallet(env, { id }, TREASURY, null), (e: any) => / Nothing was written\. Declare an address you control\.$/.test(e.message));
    const surface = await (await worker.fetch(new Request("https://x.test/api/surface"), env, ctx)).text();
    assert.match(surface, /the treasury's own address is refused \(400 wallet_is_treasury\)/);
  } finally {
    d1.close();
  }
});
