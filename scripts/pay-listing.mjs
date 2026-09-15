// Single-shot x402 payer that pays ONE listing's bounty to ONE submission via
// Commonhold's POST /api/listing/:id/pay, settling the bounty from the payer
// wallet DIRECTLY to the submitter's declared wallet (the treasury is never
// party to it: listings.ts handlePayListing, "the one call in this codebase
// where buildPaymentRequirements' payTo is NOT the treasury").
//
// Money code. Ben runs it; it is DRY-RUN unless --execute is passed. It never
// prints a secret or a private key. It reuses register-maintainer.mjs's PROVEN
// x402 signing chain verbatim (buildAuthorization/signAuthorization/
// encodePaymentHeader) and post-listing.mjs's at-most-once discipline, so
// neither the signature path nor the tombstone gate is reimplemented here.
//
// What is different from post-listing.mjs, and why:
//   - payTo is the SUBMITTER's wallet, not the treasury. The server resolves it
//     from the submission's citizen row (never from the request body). This
//     script pins the expectation on the COMMAND LINE (--payee, taken from
//     public data: GET /api/events row "wallet declared: 0x...") and refuses to
//     sign unless the 402's payTo equals it EXACTLY -- so a database-side wallet
//     swap between the operator's read and the sign cannot redirect the money
//     silently. Same for the amount (--amount-cents must equal the listing's
//     public bounty_cents AND the 402's maxAmountRequired).
//   - the at-most-once key is over {listing, submission, payee, amount}: the
//     purchase identity. Re-running with the same four is refused by the
//     tombstone; changing any of them is a different purchase and Ben's
//     deliberate act.
//   - the 200 body is validated against what we AUTHORISED (payee_address,
//     amount_cents, submission_id, listing_id, a non-empty tx,
//     listing_marked_paid:true) before the tombstone becomes terminal.
//   - the bearer is commonhold-agent's CITIZEN secret, read from
//     commonhold-agent-registration.local.json -- the file scripts/
//     roll-citizen-secret.mjs wrote on 2026-09-13 (L-056). The older
//     maintainer-secret.local.txt holds the ORIGINAL secret, which no longer
//     authenticates (secret_hash was rolled); it is still the worker's
//     MAINTAINER_SECRET, which is a different door.
//
// Run from society/:
//   node scripts/pay-listing.mjs --listing 3 --submission 1 --payee 0x... --amount-cents 1200            # DRY RUN
//   node scripts/pay-listing.mjs --listing 3 --submission 1 --payee 0x... --amount-cents 1200 --execute  # pays
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { privateKeyToAccount } from "viem/accounts";
import {
  buildAuthorization,
  signAuthorization,
  encodePaymentHeader,
  describeWouldSign,
} from "./register-maintainer.mjs";

export const DEFAULT_URL = "https://commonhold.randommonicle.workers.dev";
const WALLET_PATH = resolve(process.cwd(), "..", "payer-wallet.local.json");
const FUNDER_SECRET_PATH = resolve(process.cwd(), "..", "commonhold-agent-registration.local.json"); // {handle, secret}, roll-citizen-secret.mjs
const TOMBSTONE_DIR = resolve(process.cwd(), "..", ".x402-tombstones");

const EXPECTED_NETWORK = "base";
const EXPECTED_ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // USDC_BASE, register-maintainer.mjs:81
const EXPECTED_DOMAIN_NAME = "USD Coin";
const EXPECTED_DOMAIN_VERSION = "2";
const FUNDER_HANDLE = "commonhold-agent"; // the v1 funder of every listing so far (DECISIONS.md D-014)
const DEFAULT_MAX_AMOUNT_CENTS = 2000; // $20 hard cap for this single-shot; the largest open bounty is $15

// ---------- pure functions (test/pay-listing.test.ts) ----------

// The pinned target for a listing id. There is no --url: the bearer and the
// signed X-PAYMENT can only ever reach the real Commonhold.
export function payTarget(listingId) {
  return `${DEFAULT_URL}/api/listing/${listingId}/pay`;
}

export function isAddress(s) {
  return typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);
}

// Deterministic JSON: recursively sorted keys, no insignificant whitespace.
export function canonicalize(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalize).join(",") + "]";
  const keys = Object.keys(v).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(v[k])).join(",") + "}";
}

// The purchase identity: WHICH submission, on WHICH listing, paid to WHOM, HOW
// MUCH. Lowercased payee so a checksum-cased re-run cannot mint a second key.
export function purchaseIdentity({ listingId, submissionId, payee, amountCents }) {
  return { listing_id: listingId, submission_id: submissionId, payee: payee.toLowerCase(), amount_cents: amountCents };
}

export function attemptKey(method, url, funderHandle, purchase) {
  return createHash("sha256").update(canonicalize({ method, url, funderHandle, purchase })).digest("hex");
}

// Pay-specific 402 validation. Every field must match what the operator pinned
// from public data; collects every mismatch so a wrong 402 is fully described.
export function validatePayRequirements(reqs, { payee, amountCents, maxAmountCents, resource }) {
  if (!reqs || typeof reqs !== "object") throw new Error("payment requirements: not an object");
  const problems = [];
  if (reqs.scheme !== "exact") problems.push(`scheme: expected "exact", got ${JSON.stringify(reqs.scheme)}`);
  if (reqs.network !== EXPECTED_NETWORK) problems.push(`network: expected "${EXPECTED_NETWORK}", got ${JSON.stringify(reqs.network)}`);
  if (typeof reqs.asset !== "string" || reqs.asset.toLowerCase() !== EXPECTED_ASSET.toLowerCase()) problems.push(`asset: expected USDC on Base (${EXPECTED_ASSET}), got ${JSON.stringify(reqs.asset)}`);
  if (typeof reqs.payTo !== "string" || !isAddress(reqs.payTo) || reqs.payTo.toLowerCase() !== payee.toLowerCase()) problems.push(`payTo: expected the pinned payee ${payee}, got ${JSON.stringify(reqs.payTo)}`);
  if (amountCents > maxAmountCents) problems.push(`amount $${(amountCents / 100).toFixed(2)} exceeds the --max-amount-cents cap $${(maxAmountCents / 100).toFixed(2)}`);
  const expectedAtomic = String(amountCents * 10000);
  if (reqs.maxAmountRequired !== expectedAtomic) problems.push(`maxAmountRequired: expected exactly "${expectedAtomic}" (the pinned bounty $${(amountCents / 100).toFixed(2)}), got ${JSON.stringify(reqs.maxAmountRequired)}`);
  if (typeof reqs.resource !== "string" || reqs.resource !== resource) problems.push(`resource: expected exactly "${resource}", got ${JSON.stringify(reqs.resource)}`);
  if (!reqs.extra || reqs.extra.name !== EXPECTED_DOMAIN_NAME || reqs.extra.version !== EXPECTED_DOMAIN_VERSION) problems.push(`extra: expected EIP-712 domain {name:${JSON.stringify(EXPECTED_DOMAIN_NAME)},version:${JSON.stringify(EXPECTED_DOMAIN_VERSION)}}, got ${JSON.stringify(reqs.extra)}`);
  if (!Number.isInteger(reqs.maxTimeoutSeconds) || reqs.maxTimeoutSeconds <= 0 || reqs.maxTimeoutSeconds > 3600) problems.push(`maxTimeoutSeconds: expected a sane positive integer (<=3600), got ${JSON.stringify(reqs.maxTimeoutSeconds)}`);
  if (problems.length > 0) throw new Error("payment requirements did not match, refusing to sign:\n  " + problems.join("\n  "));
  return reqs;
}

// The 200 receipt must describe the purchase we authorised, or the tombstone
// stays 'signing' and the operator reconciles from chain.
export function validatePayReceipt(body, { listingId, submissionId, payee, amountCents }) {
  const problems = [];
  if (!body || typeof body !== "object") return ["receipt is not a JSON object"];
  if (body.listing_id !== listingId) problems.push(`listing_id: expected ${listingId}, got ${JSON.stringify(body.listing_id)}`);
  if (body.submission_id !== submissionId) problems.push(`submission_id: expected ${submissionId}, got ${JSON.stringify(body.submission_id)}`);
  if (typeof body.payee_address !== "string" || body.payee_address.toLowerCase() !== payee.toLowerCase()) problems.push(`payee_address: expected ${payee}, got ${JSON.stringify(body.payee_address)}`);
  if (body.amount_cents !== amountCents) problems.push(`amount_cents: expected ${amountCents}, got ${JSON.stringify(body.amount_cents)}`);
  if (typeof body.tx !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(body.tx)) problems.push(`tx: expected a 0x-prefixed 32-byte hash, got ${JSON.stringify(body.tx)}`);
  if (body.listing_marked_paid !== true) problems.push(`listing_marked_paid: expected true, got ${JSON.stringify(body.listing_marked_paid)}`);
  return problems;
}

// The X-PAYMENT-RESPONSE header is base64(JSON) of the facilitator's settlement
// ({success, transaction, network, payer}). Returns the problems found: absent,
// undecodable, not a success, or naming a different transaction from the body.
export function checkSettlementHeader(headerValue, bodyTx) {
  if (typeof headerValue !== "string" || !headerValue) return ["X-PAYMENT-RESPONSE: header missing from the 200; the server always sets it"];
  let s;
  try {
    s = JSON.parse(Buffer.from(headerValue, "base64").toString("utf8"));
  } catch {
    return ["X-PAYMENT-RESPONSE: not base64-encoded JSON"];
  }
  const problems = [];
  if (!s || s.success !== true) problems.push(`X-PAYMENT-RESPONSE: success is not true (${JSON.stringify(s?.success)})`);
  if (typeof s?.transaction !== "string" || typeof bodyTx !== "string" || s.transaction.toLowerCase() !== bodyTx.toLowerCase()) {
    problems.push(`X-PAYMENT-RESPONSE: transaction ${JSON.stringify(s?.transaction)} does not match the body's tx ${JSON.stringify(bodyTx)}`);
  }
  return problems;
}

export function tombstonePath(dir, key) {
  return join(dir, `pay-${key}.json`);
}

export function classifyTombstone(raw) {
  let t;
  try {
    t = JSON.parse(raw);
  } catch {
    return { status: "corrupt" };
  }
  if (t && t.status === "settled") return { status: "settled", tx: t.tx, listing_id: t.listing_id, submission_id: t.submission_id };
  if (t && t.status === "signing") return { ...t, status: "signing" };
  // Classification wins over the file's own status field (post-listing.mjs
  // spreads the other way round, so an unrecognised status there survives as
  // itself; harmless because every consumer checks === "settled" only, but
  // the test here pins the intended reading).
  return { ...t, status: "unknown" };
}

export function parseArgs(argv) {
  const args = { listingId: undefined, submissionId: undefined, payee: undefined, amountCents: undefined, maxAmountCents: DEFAULT_MAX_AMOUNT_CENTS, execute: false };
  const intFlag = (name, v) => {
    if (v === undefined) throw new Error(`${name} requires a value`);
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--execute") args.execute = true;
    else if (a === "--listing") args.listingId = intFlag(a, argv[++i]);
    else if (a === "--submission") args.submissionId = intFlag(a, argv[++i]);
    else if (a === "--amount-cents") args.amountCents = intFlag(a, argv[++i]);
    else if (a === "--max-amount-cents") args.maxAmountCents = intFlag(a, argv[++i]);
    else if (a === "--payee") {
      args.payee = argv[++i];
      if (!isAddress(args.payee)) throw new Error("--payee must be a 0x-prefixed 20-byte address (the submitter's declared wallet, from GET /api/events)");
    } else throw new Error(`unrecognised argument: ${a}. (There is no --url or --tombstone-dir: the target and the at-most-once store are pinned.)`);
  }
  for (const [flag, v] of [["--listing", args.listingId], ["--submission", args.submissionId], ["--payee", args.payee], ["--amount-cents", args.amountCents]]) {
    if (v === undefined) throw new Error(`${flag} is required`);
  }
  return args;
}

export function recoveryMessage(path) {
  return [
    `A prior attempt for this exact payment exists at:`,
    `  ${path}`,
    `Its status is not 'settled', which means a payment MAY have been signed and settled`,
    `without a confirmed receipt. DO NOT re-run. First verify on-chain: the payer wallet's`,
    `USDC balance and recent Base transactions, and GET /api/listing/<id> (a listing left`,
    `'paying' means the server settled but could not record; the maintainer reconciles by`,
    `hand). Only if you confirm NOTHING settled may you delete this file and retry. A`,
    `'settled' file must NEVER be deleted.`,
  ].join("\n");
}

// ---------- injectable orchestration (test/pay-listing.test.ts drives this with fakes) ----------

// The money-code call order, with all IO as injected deps so tests can prove
// the sequence with no network, no disk, no key. Returns a structured result;
// it never touches console or process. deps: { fetch, exists, readFile,
// writeExclusive(path,data), writeAtomic(path,data), mkdir(dir), sign(reqs) }.
export async function payListing({ listingId, submissionId, payee, amountCents, maxAmountCents, target, funderSecret, execute }, deps) {
  // Chokepoint pin for exported money code: enforced HERE, before the bearer is
  // used, so no importer can point the credential or the signed X-PAYMENT at
  // another origin. The at-most-once store is likewise the one pinned constant.
  if (target !== payTarget(listingId)) {
    return { ok: false, exitCode: 1, reason: "target_not_pinned", key: null, tombPath: null, message: `target must be the pinned Commonhold endpoint (${payTarget(listingId)}); refusing before any bearer is used.` };
  }
  if (!isAddress(payee)) {
    return { ok: false, exitCode: 1, reason: "payee_invalid", key: null, tombPath: null, message: "payee is not a 0x-prefixed 20-byte address; refusing before any bearer is used." };
  }
  // The CLI already checks these, but this is the exported money-code
  // boundary and a future importer or test is not the CLI (exchange
  // 2026-09-15, CODEX): a non-integer here would silently shape the purchase
  // identity, the URL and the atomic amount string.
  for (const [name, v] of [["listingId", listingId], ["submissionId", submissionId], ["amountCents", amountCents], ["maxAmountCents", maxAmountCents]]) {
    if (!Number.isSafeInteger(v) || v <= 0) {
      return { ok: false, exitCode: 1, reason: "argument_invalid", key: null, tombPath: null, message: `${name} must be a positive safe integer; refusing before any bearer is used.` };
    }
  }
  const purchase = purchaseIdentity({ listingId, submissionId, payee, amountCents });
  const key = attemptKey("POST", target, FUNDER_HANDLE, purchase);
  const tombPath = tombstonePath(TOMBSTONE_DIR, key);
  const base = { key, tombPath };

  if (amountCents > maxAmountCents) {
    return { ...base, ok: false, exitCode: 1, reason: "amount_over_cap", message: `amount $${(amountCents / 100).toFixed(2)} exceeds cap $${(maxAmountCents / 100).toFixed(2)}` };
  }

  // At-most-once gate (execute). Settled -> idempotent success; else refuse.
  if (execute && deps.exists(tombPath)) {
    const t = classifyTombstone(deps.readFile(tombPath));
    if (t.status === "settled") return { ...base, ok: true, exitCode: 0, reason: "already_settled", tx: t.tx };
    return { ...base, ok: false, exitCode: 1, reason: "tombstone_blocks", message: recoveryMessage(tombPath) };
  }

  const authHeader = { Authorization: `Bearer ${funderSecret}` };
  const bodyStr = JSON.stringify({ submission_id: submissionId });

  // Leg 1: POST with no payment -> expect 402. redirect:"error" so a 307 cannot
  // forward the bearer to another origin. Every free refusal the server makes
  // (listing not open, submission not open, no declared wallet, not the funder)
  // arrives here as a non-402 and ends the run with nothing signed.
  let first;
  try {
    first = await deps.fetch(target, { method: "POST", headers: { "Content-Type": "application/json", ...authHeader }, body: bodyStr, redirect: "error", signal: AbortSignal.timeout(30000) });
  } catch (e) {
    return { ...base, ok: false, exitCode: 1, reason: "leg1_unreachable", message: `Could not complete the 402 probe to ${target}: ${e?.message ?? e}. No payment was signed or sent.` };
  }
  const firstText = await first.text();
  let firstJson = null;
  try { firstJson = JSON.parse(firstText); } catch {}

  if (first.status !== 402) {
    return { ...base, ok: false, exitCode: 1, reason: "leg1_not_402", message: `Server responded HTTP ${first.status} (expected 402). Nothing paid.`, detail: firstText };
  }
  if (!firstJson || firstJson.x402Version !== 1 || !Array.isArray(firstJson.accepts) || firstJson.accepts.length === 0) {
    return { ...base, ok: false, exitCode: 1, reason: "leg1_bad_402", message: "402 was not a valid v1 x402 challenge. Refusing.", detail: firstText };
  }
  // Exactly ONE alternative, or refuse (exchange 2026-09-15, CODEX finding 1):
  // the worker emits `accepts: [reqs]` and settles that same object
  // (x402.ts payAndSettle), so a challenge with several entries is not this
  // server's, and "every field matched" would be true only of the entry we
  // happened to pick, not of the challenge as a whole.
  if (firstJson.accepts.length !== 1) {
    return { ...base, ok: false, exitCode: 1, reason: "leg1_bad_402", message: `402 carried ${firstJson.accepts.length} payment alternatives; this server emits exactly one. Refusing to choose.`, detail: firstText };
  }

  let reqs;
  try {
    reqs = validatePayRequirements(firstJson.accepts[0], { payee, amountCents, maxAmountCents, resource: target });
  } catch (e) {
    return { ...base, ok: false, exitCode: 1, reason: "reqs_rejected", message: `Refusing to sign: ${e?.message ?? e}` };
  }

  if (!execute) return { ...base, ok: true, exitCode: 0, reason: "dry_run", reqs };

  // The durable at-most-once record is created EXCLUSIVELY and FLUSHED right
  // before the irreversible sign. If it exists, refuse; if the flushed write
  // fails, refuse (never sign without a durable gate).
  try {
    deps.mkdir(TOMBSTONE_DIR);
    deps.writeExclusive(tombPath, JSON.stringify({ status: "signing", key, target, ...purchase }));
  } catch (e) {
    if (e && e.code === "EEXIST") {
      const t = classifyTombstone(deps.readFile(tombPath));
      if (t.status === "settled") return { ...base, ok: true, exitCode: 0, reason: "already_settled", tx: t.tx };
      return { ...base, ok: false, exitCode: 1, reason: "tombstone_blocks", message: recoveryMessage(tombPath) };
    }
    return { ...base, ok: false, exitCode: 1, reason: "tombstone_write_failed", message: `Could not durably create the at-most-once tombstone: ${e?.message ?? e}. Refusing to sign without it.` };
  }

  // Sign (the only step that touches the key) then Leg 2 with X-PAYMENT.
  let paymentHeader;
  try {
    paymentHeader = await deps.sign(reqs);
  } catch (e) {
    return { ...base, ok: false, exitCode: 1, reason: "sign_failed", message: `Failed to sign: ${e?.message ?? e}. Nothing sent; the 'signing' tombstone may be deleted after confirming no on-chain settlement.` };
  }

  let second;
  try {
    second = await deps.fetch(target, { method: "POST", headers: { "Content-Type": "application/json", "X-PAYMENT": paymentHeader, ...authHeader }, body: bodyStr, redirect: "error", signal: AbortSignal.timeout(60000) });
  } catch (e) {
    return { ...base, ok: false, exitCode: 1, reason: "leg2_ambiguous", message: `The signed payment could not be confirmed sent: ${e?.message ?? e}.\n${recoveryMessage(tombPath)}` };
  }
  const secondText = await second.text();
  let secondJson = null;
  try { secondJson = JSON.parse(secondText); } catch {}

  // The server's own settled-but-unrecorded case is a 500 carrying the tx and
  // a listing left 'paying': money moved. That is exactly the case the
  // tombstone must stay 'signing' for, so it is not special-cased here.
  if (second.status !== 200) {
    return { ...base, ok: false, exitCode: 1, reason: "leg2_not_200", message: `Bounty not confirmed paid after the signed request: HTTP ${second.status}.\n${recoveryMessage(tombPath)}`, detail: secondText };
  }
  const problems = validatePayReceipt(secondJson, { listingId, submissionId, payee, amountCents });
  // Belt to the body's braces (exchange 2026-09-15, CODEX): the worker also
  // returns the facilitator's settlement verbatim in X-PAYMENT-RESPONSE
  // (listings.ts, the 200's headers). It must be present and name the SAME
  // transaction as the body, or the receipt is contradictory and the
  // tombstone stays 'signing'. This still proves nothing about chain
  // inclusion -- that is the operator's on-chain check after the run.
  problems.push(...checkSettlementHeader(typeof second.headers?.get === "function" ? second.headers.get("X-PAYMENT-RESPONSE") : null, secondJson?.tx));
  if (problems.length > 0) {
    return { ...base, ok: false, exitCode: 1, reason: "leg2_bad_body", message: `200 body did not match what we authorised; leaving the tombstone 'signing'.\n  ${problems.join("\n  ")}\n${recoveryMessage(tombPath)}`, detail: secondText };
  }

  // Success: atomic flushed replacement of the tombstone with a permanent,
  // terminal 'settled' receipt.
  deps.writeAtomic(tombPath, JSON.stringify({ status: "settled", key, target, ...purchase, tx: secondJson.tx, payer_address: secondJson.payer_address }, null, 2));
  return { ...base, ok: true, exitCode: 0, reason: "settled", tx: secondJson.tx, payerAddress: secondJson.payer_address };
}

// ---------- CLI (not exercised by tests; payListing is) ----------

const realDeps = (account) => ({
  fetch: (...a) => fetch(...a),
  exists: (p) => existsSync(p),
  readFile: (p) => readFileSync(p, "utf8"),
  // flushed exclusive create: fsync before the handle closes, so a crash after
  // this returns cannot lose the gate.
  writeExclusive: (p, data) => writeFileSync(p, data, { flag: "wx", flush: true }),
  // atomic flushed replace: write a flushed temp, then rename over the target.
  writeAtomic: (p, data) => {
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, data, { flush: true });
    renameSync(tmp, p);
  },
  mkdir: (d) => mkdirSync(d, { recursive: true }),
  sign: async (reqs) => {
    const authorization = buildAuthorization(account.address, reqs);
    const signature = await signAuthorization(account, authorization, reqs);
    return encodePaymentHeader(1, reqs, authorization, signature);
  },
});

// The funder bearer: {handle, secret} as roll-citizen-secret.mjs writes it.
// Refuses a file whose handle is not the funder, so the wrong citizen's
// secret can never be presented as commonhold-agent's.
export function readFunderSecret(raw) {
  const j = JSON.parse(raw);
  if (!j || j.handle !== FUNDER_HANDLE) throw new Error(`custody file is for ${JSON.stringify(j?.handle)}, not ${FUNDER_HANDLE}`);
  if (typeof j.secret !== "string" || !j.secret.startsWith("commonhold_sk_") || j.secret.length !== 78) throw new Error("custody file does not hold a commonhold_sk_ secret of the expected length");
  return j.secret;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(String(e.message ?? e));
    console.error("Usage: node scripts/pay-listing.mjs --listing <id> --submission <id> --payee <0x...> --amount-cents <n> [--execute] [--max-amount-cents N]");
    process.exitCode = 1;
    return;
  }

  const target = payTarget(args.listingId);

  if (!existsSync(FUNDER_SECRET_PATH)) {
    console.error(`No funder custody file at ${FUNDER_SECRET_PATH} (commonhold-agent's citizen secret, as roll-citizen-secret.mjs writes it).`);
    process.exitCode = 1;
    return;
  }
  let funderSecret;
  try {
    funderSecret = readFunderSecret(readFileSync(FUNDER_SECRET_PATH, "utf8"));
  } catch (e) {
    console.error(`Funder custody file unusable: ${e.message ?? e}. Refusing.`);
    process.exitCode = 1;
    return;
  }

  let account = null;
  if (args.execute) {
    if (!existsSync(WALLET_PATH)) {
      console.error(`No payer wallet at ${WALLET_PATH}.`);
      process.exitCode = 1;
      return;
    }
    try {
      const wallet = JSON.parse(readFileSync(WALLET_PATH, "utf8"));
      account = privateKeyToAccount(wallet.privateKey);
      if (account.address.toLowerCase() !== String(wallet.address).toLowerCase()) throw new Error("stored address does not match its private key");
    } catch (e) {
      console.error(`Payer wallet unusable: ${e.message ?? e}. Refusing.`);
      process.exitCode = 1;
      return;
    }
  }

  console.log(`Pay listing ${args.listingId}, submission ${args.submissionId}`);
  console.log(`Pinned payee ${args.payee}; pinned amount $${(args.amountCents / 100).toFixed(2)} (cap $${(args.maxAmountCents / 100).toFixed(2)})`);
  console.log(`Target (pinned): POST ${target}`);

  const result = await payListing(
    { listingId: args.listingId, submissionId: args.submissionId, payee: args.payee, amountCents: args.amountCents, maxAmountCents: args.maxAmountCents, target, funderSecret, execute: args.execute },
    realDeps(account ?? { address: "0x0000000000000000000000000000000000000000" }),
  );

  console.log(`Idempotency key: ${result.key}`);
  if (result.reason === "dry_run") {
    console.log("DRY RUN: the 402 matched every expected field (asset, pinned payee, pinned amount, domain, exact resource).");
    let addr = null;
    try { if (existsSync(WALLET_PATH)) addr = JSON.parse(readFileSync(WALLET_PATH, "utf8")).address; } catch {}
    if (addr) console.log("Would sign (unsigned only, signTypedData never called):\n" + JSON.stringify(describeWouldSign(addr, result.reqs), null, 2));
    console.log("dry run: the authenticated 402 probe was sent; no payment was signed or sent; nothing was spent. Re-run with --execute to pay.");
  } else if (result.reason === "settled") {
    console.log("");
    console.log("Bounty paid and the listing is marked paid.");
    console.log(`tx: ${result.tx}`);
    console.log(`payer: ${result.payerAddress}`);
    console.log(`Verify: GET ${DEFAULT_URL}/api/listing/${args.listingId} (status paid), GET ${DEFAULT_URL}/api/listings/payments, and the tx on Base.`);
    console.log(`Tombstone (permanent, never delete): ${result.tombPath}`);
  } else if (result.reason === "already_settled") {
    console.log(`Already paid (tombstone 'settled'): tx ${result.tx}. Nothing to do.`);
  } else {
    console.error(result.message ?? `Failed: ${result.reason}`);
    if (result.detail) console.error(result.detail);
  }
  process.exitCode = result.exitCode;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
