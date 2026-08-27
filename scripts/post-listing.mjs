// Single-shot x402 payer that posts ONE listing to Commonhold's POST
// /api/listing, settling the 15% posting fee from the payer wallet. Built for
// the first economy one-real-ride (docs/BRIEF-POST-LISTING-PAYER-2026-08-25.md).
//
// Money code. Ben runs it; it is DRY-RUN unless --execute is passed. It never
// prints a secret or a private key. It reuses register-maintainer.mjs's PROVEN
// x402 signing chain verbatim (buildAuthorization/signAuthorization/
// encodePaymentHeader), so the signature path is not reimplemented here.
//
// Hardening, from the two-lens money-code review (2026-08-25):
//   - the target is PINNED to DEFAULT_URL: no --url, so the citizen bearer and
//     the signed X-PAYMENT can only ever reach the real Commonhold (Codex #1);
//   - both fetches use redirect:"error", so a 307 cannot forward the payment
//     header to another origin (Codex #1);
//   - the at-most-once key is over the canonical PURCHASE, excluding the
//     incidental expires_at, so bumping the deadline cannot mint a new key and
//     slip past the tombstone into a double-pay (HIGH-fix #1 + Gemini A);
//   - the tombstone is written EXCLUSIVELY (wx) and FLUSHED (fsync) before the
//     irreversible sign, and the settled receipt is an atomic flushed replace,
//     so an OS/power loss cannot lose the gate or destroy the receipt
//     (HIGH-fix #2 + Codex #2);
//   - a settled tombstone is permanent and terminal; the 201 body is validated
//     (listing_id + fee_tx) before the tombstone is marked settled (Codex #3);
//   - asset pinned to USDC, payTo pinned to the treasury, the charged fee must
//     equal the fee WE compute AND be <= --max-fee-cents, EIP-712 domain checked.
//
// The orchestration is an injectable function (postListing) so the money-code
// call order is unit-tested with fake fetch/fs/signer, no network or key.
//
// Run from society/:
//   node scripts/post-listing.mjs --listing-file ../drafts/<file>.json           # DRY RUN
//   node scripts/post-listing.mjs --listing-file ../drafts/<file>.json --execute  # pays
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
export const TARGET = `${DEFAULT_URL}/api/listing`; // pinned; no --url override
const WALLET_PATH = resolve(process.cwd(), "..", "payer-wallet.local.json");
const FUNDER_SECRET_PATH = resolve(process.cwd(), "..", "maintainer-secret.local.txt"); // commonhold-agent = the v1 funder
const TOMBSTONE_DIR = resolve(process.cwd(), "..", ".x402-tombstones");

const EXPECTED_NETWORK = "base";
const EXPECTED_ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // USDC_BASE, register-maintainer.mjs:81
const EXPECTED_TREASURY = "0xD9E17995352EF13F9Ba467e2F36C7614A45e7011"; // register-maintainer.mjs:82; update on treasury rotation
const EXPECTED_DOMAIN_NAME = "USD Coin";
const EXPECTED_DOMAIN_VERSION = "2";
const FUNDER_HANDLE = "commonhold-agent"; // DECISIONS.md D-014
const FEE_BPS = 1500; // society.ts:50 listing_fee_basis_points
const MIN_FEE_CENTS = 50; // society.ts:51 min_listing_fee_cents
const DEFAULT_MAX_FEE_CENTS = 300; // $3 hard cap for this single-shot; override with --max-fee-cents

// ---------- pure functions (post-listing.test.ts) ----------

export function computeListingFeeCents(bountyCents) {
  return Math.max(MIN_FEE_CENTS, Math.ceil((bountyCents * FEE_BPS) / 10000));
}

// Deterministic JSON: recursively sorted keys, no insignificant whitespace.
export function canonicalize(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalize).join(",") + "]";
  const keys = Object.keys(v).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(v[k])).join(",") + "}";
}

// The POST body: ONLY the allowed endpoint fields, in a fixed order.
export function buildListingBody(source) {
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("listing source is not a JSON object");
  const ALLOWED = ["title", "description", "url", "acceptance_condition", "bounty_cents", "expires_at"];
  const body = {};
  for (const f of ALLOWED) {
    if (source[f] === undefined) throw new Error(`listing is missing required field: ${f}`);
    body[f] = source[f];
  }
  if (typeof body.title !== "string" || body.title.trim().length < 3 || body.title.length > 120) throw new Error("title must be a string 3-120 chars");
  if (typeof body.description !== "string" || body.description.trim().length < 3) throw new Error("description must be a non-empty string");
  if (typeof body.acceptance_condition !== "string" || body.acceptance_condition.trim().length < 3 || body.acceptance_condition.length > 500) throw new Error("acceptance_condition must be a string 3-500 chars");
  if (body.url !== null && typeof body.url !== "string") throw new Error("url must be a string or null");
  if (!Number.isInteger(body.bounty_cents) || body.bounty_cents < 100) throw new Error("bounty_cents must be an integer >= 100");
  if (!Number.isInteger(body.expires_at)) throw new Error("expires_at must be an integer ms-epoch (bake it into the file so the idempotency key is stable across runs)");
  return body;
}

// The at-most-once identity is the PURCHASE, not the whole body: expires_at is
// an incidental deadline, excluded so that bumping it after a Leg-2 timeout
// cannot mint a NEW key and slip past the 'signing' tombstone into a double-pay
// (Gemini review 2026-08-25, finding A). bounty_cents STAYS in -- it sets the fee.
export function purchaseIdentity(body) {
  const { expires_at, ...content } = body;
  return content;
}

export function attemptKey(method, url, funderHandle, purchase) {
  return createHash("sha256").update(canonicalize({ method, url, funderHandle, purchase })).digest("hex");
}

// Listing-specific 402 validation. Amount must equal the fee WE compute AND sit
// under the cap; resource STRICTLY equals the exact URL we targeted (the
// EIP-3009 signature binds neither host nor body, so a look-alike resource is a
// replay route -- Gemini finding C). Collects every mismatch.
export function validateListingPaymentRequirements(reqs, expectedFeeCents, maxFeeCents, expectedResource) {
  if (!reqs || typeof reqs !== "object") throw new Error("payment requirements: not an object");
  const problems = [];
  if (reqs.scheme !== "exact") problems.push(`scheme: expected "exact", got ${JSON.stringify(reqs.scheme)}`);
  if (reqs.network !== EXPECTED_NETWORK) problems.push(`network: expected "${EXPECTED_NETWORK}", got ${JSON.stringify(reqs.network)}`);
  if (typeof reqs.asset !== "string" || reqs.asset.toLowerCase() !== EXPECTED_ASSET.toLowerCase()) problems.push(`asset: expected USDC on Base (${EXPECTED_ASSET}), got ${JSON.stringify(reqs.asset)}`);
  if (typeof reqs.payTo !== "string" || reqs.payTo.toLowerCase() !== EXPECTED_TREASURY.toLowerCase()) problems.push(`payTo: expected the known treasury (${EXPECTED_TREASURY}), got ${JSON.stringify(reqs.payTo)}`);
  if (expectedFeeCents > maxFeeCents) problems.push(`fee $${(expectedFeeCents / 100).toFixed(2)} exceeds the --max-fee-cents cap $${(maxFeeCents / 100).toFixed(2)}`);
  const expectedAtomic = String(expectedFeeCents * 10000);
  if (reqs.maxAmountRequired !== expectedAtomic) problems.push(`maxAmountRequired: expected exactly "${expectedAtomic}" (our computed fee $${(expectedFeeCents / 100).toFixed(2)}), got ${JSON.stringify(reqs.maxAmountRequired)}`);
  if (typeof reqs.resource !== "string" || reqs.resource !== expectedResource) problems.push(`resource: expected exactly "${expectedResource}", got ${JSON.stringify(reqs.resource)}`);
  if (!reqs.extra || reqs.extra.name !== EXPECTED_DOMAIN_NAME || reqs.extra.version !== EXPECTED_DOMAIN_VERSION) problems.push(`extra: expected EIP-712 domain {name:${JSON.stringify(EXPECTED_DOMAIN_NAME)},version:${JSON.stringify(EXPECTED_DOMAIN_VERSION)}}, got ${JSON.stringify(reqs.extra)}`);
  if (!Number.isInteger(reqs.maxTimeoutSeconds) || reqs.maxTimeoutSeconds <= 0 || reqs.maxTimeoutSeconds > 3600) problems.push(`maxTimeoutSeconds: expected a sane positive integer (<=3600), got ${JSON.stringify(reqs.maxTimeoutSeconds)}`);
  if (problems.length > 0) throw new Error("payment requirements did not match, refusing to sign:\n  " + problems.join("\n  "));
  return reqs;
}

export function tombstonePath(dir, key) {
  return join(dir, `listing-${key}.json`);
}

export function classifyTombstone(raw) {
  let t;
  try {
    t = JSON.parse(raw);
  } catch {
    return { status: "corrupt" };
  }
  if (t && t.status === "settled") return { status: "settled", listing_id: t.listing_id, fee_tx: t.fee_tx };
  if (t && t.status === "signing") return { status: "signing", ...t };
  return { status: "unknown", ...t };
}

export function parseArgs(argv) {
  const args = { listingFile: undefined, maxFeeCents: DEFAULT_MAX_FEE_CENTS, execute: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--execute") args.execute = true;
    else if (a === "--listing-file") { args.listingFile = argv[++i]; if (args.listingFile === undefined) throw new Error("--listing-file requires a value"); }
    else if (a === "--max-fee-cents") {
      const v = argv[++i];
      if (v === undefined) throw new Error("--max-fee-cents requires a value");
      args.maxFeeCents = Number(v);
      if (!Number.isInteger(args.maxFeeCents) || args.maxFeeCents <= 0) throw new Error("--max-fee-cents must be a positive integer");
    } else throw new Error(`unrecognised argument: ${a}. (There is no --url or --tombstone-dir: the target and the at-most-once store are pinned.)`);
  }
  if (!args.listingFile) throw new Error("--listing-file <path> is required");
  return args;
}

export function recoveryMessage(path) {
  return [
    `A prior attempt for this exact listing exists at:`,
    `  ${path}`,
    `Its status is not 'settled', which means a payment MAY have been signed and settled`,
    `without a confirmed listing. DO NOT re-run, and do NOT edit the listing and retry.`,
    `First verify on-chain: GET /treasury on the target, and check the payer wallet's USDC`,
    `balance and recent Base transactions. Only if you confirm NOTHING settled may you`,
    `delete this file and retry. A 'settled' file must NEVER be deleted.`,
  ].join("\n");
}

// ---------- injectable orchestration (post-listing.test.ts drives this with fakes) ----------

// The money-code call order, with all IO as injected deps so tests can prove
// the sequence with no network, no disk, no key. Returns a structured result;
// it never touches console or process. deps: { fetch, exists, readFile,
// writeExclusive(path,data), writeAtomic(path,data), mkdir(dir), sign(reqs) }.
export async function postListing({ body, target, funderSecret, maxFeeCents, execute }, deps) {
  // Chokepoint pin for exported money code (Codex round 2 #1): enforced HERE,
  // before the bearer is used, so no importer -- not just main -- can point the
  // credential or the signed X-PAYMENT at another origin. The at-most-once store
  // is likewise the one pinned constant, never caller-supplied.
  if (target !== TARGET) {
    return { ok: false, exitCode: 1, reason: "target_not_pinned", key: null, tombPath: null, message: `target must be the pinned Commonhold endpoint (${TARGET}); refusing before any bearer is used.` };
  }
  const expectedFeeCents = computeListingFeeCents(body.bounty_cents);
  const key = attemptKey("POST", target, FUNDER_HANDLE, purchaseIdentity(body));
  const tombPath = tombstonePath(TOMBSTONE_DIR, key);
  const base = { key, tombPath, expectedFeeCents };

  if (expectedFeeCents > maxFeeCents) {
    return { ...base, ok: false, exitCode: 1, reason: "fee_over_cap", message: `fee $${(expectedFeeCents / 100).toFixed(2)} exceeds cap $${(maxFeeCents / 100).toFixed(2)}` };
  }

  // At-most-once gate (execute). Settled -> idempotent success; else refuse.
  if (execute && deps.exists(tombPath)) {
    const t = classifyTombstone(deps.readFile(tombPath));
    if (t.status === "settled") return { ...base, ok: true, exitCode: 0, reason: "already_settled", listingId: t.listing_id, feeTx: t.fee_tx };
    return { ...base, ok: false, exitCode: 1, reason: "tombstone_blocks", message: recoveryMessage(tombPath) };
  }

  const authHeader = { Authorization: `Bearer ${funderSecret}` };
  const bodyStr = JSON.stringify(body);

  // Leg 1: POST with no payment -> expect 402. redirect:"error" so a 307 cannot
  // forward the bearer to another origin.
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

  let reqs;
  try {
    reqs = validateListingPaymentRequirements(firstJson.accepts[0], expectedFeeCents, maxFeeCents, target);
  } catch (e) {
    return { ...base, ok: false, exitCode: 1, reason: "reqs_rejected", message: `Refusing to sign: ${e?.message ?? e}` };
  }

  if (!execute) return { ...base, ok: true, exitCode: 0, reason: "dry_run", reqs };

  // HIGH-fix #2: the durable at-most-once record is created EXCLUSIVELY and
  // FLUSHED right before the irreversible sign. If it exists, refuse; if the
  // flushed write fails, refuse (never sign without a durable gate).
  try {
    deps.mkdir(TOMBSTONE_DIR);
    deps.writeExclusive(tombPath, JSON.stringify({ status: "signing", key, target, expected_fee_cents: expectedFeeCents, title: body.title }));
  } catch (e) {
    if (e && e.code === "EEXIST") {
      const t = classifyTombstone(deps.readFile(tombPath));
      if (t.status === "settled") return { ...base, ok: true, exitCode: 0, reason: "already_settled", listingId: t.listing_id, feeTx: t.fee_tx };
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
    second = await deps.fetch(target, { method: "POST", headers: { "Content-Type": "application/json", "X-PAYMENT": paymentHeader, ...authHeader }, body: bodyStr, redirect: "error", signal: AbortSignal.timeout(45000) });
  } catch (e) {
    return { ...base, ok: false, exitCode: 1, reason: "leg2_ambiguous", message: `The signed payment could not be confirmed sent: ${e?.message ?? e}.\n${recoveryMessage(tombPath)}` };
  }
  const secondText = await second.text();
  let secondJson = null;
  try { secondJson = JSON.parse(secondText); } catch {}

  if (second.status !== 201) {
    return { ...base, ok: false, exitCode: 1, reason: "leg2_not_201", message: `Listing not created after payment: HTTP ${second.status}.\n${recoveryMessage(tombPath)}`, detail: secondText };
  }
  // Validate the 201 body against what we AUTHORISED before making the tombstone
  // terminal (Codex round 1 #3 + round 2 #2): a positive integer listing_id, a
  // non-empty fee_tx, and the echoed fee_cents/bounty_cents must equal this run's
  // values. A contradictory receipt leaves the tombstone 'signing', never settled.
  if (
    !secondJson ||
    !Number.isInteger(secondJson.listing_id) || secondJson.listing_id <= 0 ||
    typeof secondJson.fee_tx !== "string" || !secondJson.fee_tx ||
    secondJson.fee_cents !== expectedFeeCents ||
    secondJson.bounty_cents !== body.bounty_cents
  ) {
    return { ...base, ok: false, exitCode: 1, reason: "leg2_bad_body", message: `201 body did not match what we authorised (need positive listing_id, fee_tx, fee_cents ${expectedFeeCents}, bounty_cents ${body.bounty_cents}); leaving the tombstone 'signing'.\n${recoveryMessage(tombPath)}`, detail: secondText };
  }

  // Success: atomic flushed replacement of the tombstone with a permanent,
  // terminal 'settled' receipt (fee_cents now equals the authorised fee).
  deps.writeAtomic(tombPath, JSON.stringify({ status: "settled", key, target, listing_id: secondJson.listing_id, fee_tx: secondJson.fee_tx, fee_cents: secondJson.fee_cents }, null, 2));
  return { ...base, ok: true, exitCode: 0, reason: "settled", listingId: secondJson.listing_id, feeTx: secondJson.fee_tx };
}

// ---------- CLI (not exercised by tests; postListing is) ----------

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

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(String(e.message ?? e));
    console.error("Usage: node scripts/post-listing.mjs --listing-file <path> [--execute] [--max-fee-cents N]");
    process.exitCode = 1;
    return;
  }

  let body;
  try {
    body = buildListingBody(JSON.parse(readFileSync(resolve(args.listingFile), "utf8")));
  } catch (e) {
    console.error(`Could not read/validate the listing file: ${e.message ?? e}`);
    process.exitCode = 1;
    return;
  }

  // Host is pinned. This guard is belt-and-braces: the bearer is read only
  // after it, and the target can never be an attacker-chosen origin.
  const target = TARGET;
  if (target !== `${DEFAULT_URL}/api/listing`) {
    console.error("target is not the pinned Commonhold endpoint. Refusing.");
    process.exitCode = 1;
    return;
  }

  if (!existsSync(FUNDER_SECRET_PATH)) {
    console.error(`No funder secret at ${FUNDER_SECRET_PATH} (commonhold-agent's citizen secret).`);
    process.exitCode = 1;
    return;
  }
  const funderSecret = readFileSync(FUNDER_SECRET_PATH, "utf8").trim();
  if (!funderSecret) {
    console.error(`${FUNDER_SECRET_PATH} is empty.`);
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

  const expectedFeeCents = computeListingFeeCents(body.bounty_cents);
  console.log(`Listing: "${body.title}"`);
  console.log(`Bounty $${(body.bounty_cents / 100).toFixed(2)}; computed fee $${(expectedFeeCents / 100).toFixed(2)} (cap $${(args.maxFeeCents / 100).toFixed(2)})`);
  console.log(`Target (pinned): POST ${target}`);

  const result = await postListing(
    { body, target, funderSecret, maxFeeCents: args.maxFeeCents, execute: args.execute },
    realDeps(account ?? { address: "0x0000000000000000000000000000000000000000" }),
  );

  console.log(`Idempotency key: ${result.key}`);
  if (result.reason === "dry_run") {
    console.log("DRY RUN: the 402 matched every expected field (asset, treasury, fee, domain, exact resource).");
    let addr = null;
    try { if (existsSync(WALLET_PATH)) addr = JSON.parse(readFileSync(WALLET_PATH, "utf8")).address; } catch {}
    if (addr) console.log("Would sign (unsigned only, signTypedData never called):\n" + JSON.stringify(describeWouldSign(addr, result.reqs), null, 2));
    console.log("dry run: the authenticated 402 probe was sent; no payment was signed or sent; nothing was spent. Re-run with --execute to pay.");
  } else if (result.reason === "settled") {
    console.log("");
    console.log("Listing posted and fee settled.");
    console.log(`listing_id: ${result.listingId}`);
    console.log(`fee_tx: ${result.feeTx}`);
    console.log(`Verify: GET ${DEFAULT_URL}/api/listing/${result.listingId} and GET ${DEFAULT_URL}/treasury`);
    console.log(`Tombstone (permanent, never delete): ${result.tombPath}`);
  } else if (result.reason === "already_settled") {
    console.log(`Already posted (tombstone 'settled'): listing_id ${result.listingId}, fee_tx ${result.feeTx}. Nothing to do.`);
  } else {
    console.error(result.message ?? `Failed: ${result.reason}`);
    if (result.detail) console.error(result.detail);
  }
  process.exitCode = result.exitCode;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
