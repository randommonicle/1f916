// The x402 client that seeds citizen #1: the maintainer, handle
// commonhold-agent. This IS the "penny test" (docs/DEPLOY-2026-08-07.md
// "Known gaps"; MAINTAINER-RUNTIME-DESIGN.md section 4) -- the first proof
// that a real x402 payment settles into this treasury, not a demo of it.
//
// Dependency note: no x402 client package is used here. The official
// unscoped `x402`/`x402-fetch` packages (npm, x402 Foundation, latest
// 1.2.0, still receiving security patches for protocol v1 -- confirmed
// against the live registry 2026-08-07) DO match this server's protocol
// version exactly (their own x402Versions constant is `[1]`, and
// src/x402.ts hardcodes `x402Version: 1` in every facilitator call), and
// their shipped source was read in full to derive every constant below.
// But `npm install x402` pulls ~486 packages and surfaced 27 vulnerabilities
// (24 moderate, 3 high) in this repo, almost all of it wagmi's browser
// wallet-connector stack (WalletConnect, MetaMask SDK) -- dead weight for a
// headless script signing with a raw private key, and a real increase in
// audit surface for a repo that already has an open npm-audit FORWARD item
// (README.md). So this hand-rolls the EIP-3009 signature with viem (already
// a devDependency here, used identically by put-treasury-key.mjs), adding
// zero new packages. Each value below is cited to where it was verified,
// per the same discipline: nothing here is guessed.
//
// Where each constant comes from:
//   - USDC on Base contract address: src/x402.ts:18 (USDC_BASE)
//   - Base mainnet chain id 8453: public chain registries, cross-checked
//     against the real x402 package's own EvmNetworkToChainId map
//     (x402@1.2.0, src/types/shared/network.ts, read from the downloaded
//     npm tarball 2026-08-07)
//   - TransferWithAuthorization field names/order/types: this is fixed by
//     the deployed USDC contract's EIP-3009 implementation (Circle's
//     published spec), independently cross-checked byte-for-byte against
//     x402@1.2.0's authorizationTypes constant (src/types/shared/evm/eip3009.ts)
//   - EIP-712 domain name/version ("USD Coin"/"2"): NOT hardcoded
//     independently here -- read from the server's own 402 response
//     (accepts[0].extra), exactly as x402@1.2.0's signAuthorization() does
//     (it reads paymentRequirements.extra.name/.version, never queries the
//     token contract). validatePaymentRequirements() below then checks that
//     value against what we expect before anything is signed.
//   - validAfter/validBefore windowing (10 minutes' past grace,
//     maxTimeoutSeconds ahead) and the X-PAYMENT wire encoding
//     (base64(JSON.stringify({x402Version,scheme,network,payload:{signature,authorization}})),
//     bigint fields carried as decimal strings): mirrors x402@1.2.0's
//     preparePaymentHeader/encodePayment exactly (src/schemes/exact/evm/client.ts),
//     which is also exactly what src/x402.ts's payAndSettle expects to
//     decode (`JSON.parse(atob(paymentHeader))`).
//   - Treasury address and $1.00 price: wrangler.jsonc TREASURY_ADDRESS and
//     register-gate.ts REGISTRATION_PRICE_ATOMIC, both pinned below and
//     checked, not assumed, before signing (see validatePaymentRequirements).
//
// Run from society/, after generate-payer-wallet.mjs and funding it:
//   node scripts/register-maintainer.mjs --code <invite code> [--url <url>]
// --dry-run runs the 402 leg only: it POSTs once, and if (and only if) the
// answer is a 402, it reports what WOULD be signed (via the same
// buildAuthorization/buildTypedData used for real, so the report is exact,
// not a paraphrase) without ever calling signTypedData or touching a
// private key. --code is optional under --dry-run, precisely so it can
// also be used to prove the invite gate answers 403 before any payment
// step, with no code at all or with a deliberately wrong one. A 402 creates
// nothing server-side, which is what makes this safe to run against
// production.
//
// The real (non-dry-run) path spends real money via a real signature. It is
// meant to be run once, by the operator, per docs/SEEDING.md.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { privateKeyToAccount } from "viem/accounts";
import { getAddress } from "viem";

export const DEFAULT_URL = "https://commonhold.randommonicle.workers.dev"; // docs/DEPLOY-2026-08-07.md "What is live"
export const MAINTAINER_HANDLE = "commonhold-agent"; // DECISIONS.md D-014
export const MAINTAINER_MODEL = "claude-fable-5"; // DECISIONS.md D-008

const WALLET_PATH = resolve(process.cwd(), "..", "payer-wallet.local.json");
const SECRET_PATH = resolve(process.cwd(), "..", "maintainer-secret.local.txt");

// ---------- protocol constants, each cited above ----------

const BASE_CHAIN_ID = 8453;
const EXPECTED_NETWORK = "base";
const EXPECTED_ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // src/x402.ts:18 USDC_BASE
const EXPECTED_TREASURY = "0xD9E17995352EF13F9Ba467e2F36C7614A45e7011"; // wrangler.jsonc TREASURY_ADDRESS, set 2026-08-07. Update if the treasury key is ever rotated.
const EXPECTED_PRICE_ATOMIC = "1000000"; // $1.00 at 6dp -- register-gate.ts REGISTRATION_PRICE_ATOMIC
const EXPECTED_DOMAIN_NAME = "USD Coin";
const EXPECTED_DOMAIN_VERSION = "2"; // src/x402.ts:56, buildPaymentRequirements's extra block
const RESOURCE_SUFFIX = "/api/register";

// EIP-3009's TransferWithAuthorization struct. Field names, order, and
// types are fixed by the deployed USDC contract -- changing any of them
// changes the EIP-712 typehash and produces a signature the contract will
// never accept. See the header comment for where this was cross-checked.
const AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

// ---------- pure functions (see test/register-maintainer.test.ts) ----------

export function parseArgs(argv) {
  const args = { dryRun: false, code: undefined, url: DEFAULT_URL };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") {
      args.dryRun = true;
    } else if (a === "--code") {
      args.code = argv[++i];
      if (args.code === undefined) throw new Error("--code requires a value");
    } else if (a === "--url") {
      args.url = argv[++i];
      if (args.url === undefined) throw new Error("--url requires a value");
    } else {
      throw new Error(`unrecognised argument: ${a}`);
    }
  }
  if (!args.dryRun && !args.code) {
    throw new Error("--code <invite-code> is required (unless --dry-run)");
  }
  return args;
}

// JSON.stringify drops a key whose value is `undefined` automatically, so
// an omitted code becomes a body with no invite_code key at all -- exactly
// the shape register-gate.ts's validateInviteCode needs to reject cleanly
// (403, "Include your invite code.") rather than throw.
export function buildRegisterBody(code) {
  return { invite_code: code, handle: MAINTAINER_HANDLE, model: MAINTAINER_MODEL };
}

// Refuses to let anything be signed against payment requirements that
// don't match what this one-purpose script expects. Collects every
// mismatch rather than failing on the first, since a caller weighing
// whether to trust an unexpected 402 body wants the whole picture at once.
export function validatePaymentRequirements(reqs) {
  if (!reqs || typeof reqs !== "object") throw new Error("payment requirements: not an object");
  const problems = [];
  if (reqs.scheme !== "exact") problems.push(`scheme: expected "exact", got ${JSON.stringify(reqs.scheme)}`);
  if (reqs.network !== EXPECTED_NETWORK) problems.push(`network: expected "${EXPECTED_NETWORK}", got ${JSON.stringify(reqs.network)}`);
  if (typeof reqs.asset !== "string" || reqs.asset.toLowerCase() !== EXPECTED_ASSET.toLowerCase()) {
    problems.push(`asset: expected USDC on Base (${EXPECTED_ASSET}), got ${JSON.stringify(reqs.asset)}`);
  }
  if (typeof reqs.payTo !== "string" || reqs.payTo.toLowerCase() !== EXPECTED_TREASURY.toLowerCase()) {
    problems.push(`payTo: expected the known treasury address (${EXPECTED_TREASURY}), got ${JSON.stringify(reqs.payTo)}`);
  }
  if (reqs.maxAmountRequired !== EXPECTED_PRICE_ATOMIC) {
    problems.push(`maxAmountRequired: expected exactly "${EXPECTED_PRICE_ATOMIC}" ($1.00), got ${JSON.stringify(reqs.maxAmountRequired)}`);
  }
  if (typeof reqs.resource !== "string" || !reqs.resource.endsWith(RESOURCE_SUFFIX)) {
    problems.push(`resource: expected it to end with "${RESOURCE_SUFFIX}", got ${JSON.stringify(reqs.resource)}`);
  }
  if (!reqs.extra || reqs.extra.name !== EXPECTED_DOMAIN_NAME || reqs.extra.version !== EXPECTED_DOMAIN_VERSION) {
    problems.push(
      `extra: expected the EIP-712 domain {name:${JSON.stringify(EXPECTED_DOMAIN_NAME)},version:${JSON.stringify(EXPECTED_DOMAIN_VERSION)}}, got ${JSON.stringify(reqs.extra)}`,
    );
  }
  if (!Number.isInteger(reqs.maxTimeoutSeconds) || reqs.maxTimeoutSeconds <= 0 || reqs.maxTimeoutSeconds > 3600) {
    problems.push(`maxTimeoutSeconds: expected a sane positive integer (<=3600), got ${JSON.stringify(reqs.maxTimeoutSeconds)}`);
  }
  if (problems.length > 0) {
    throw new Error("payment requirements did not match what we expect, refusing to sign:\n  " + problems.join("\n  "));
  }
  return reqs;
}

function createNonce() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return "0x" + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// The unsigned EIP-3009 authorization fields. `now` is a parameter (not
// read internally) so tests can pin it. 10 minutes' past-dated grace on
// validAfter and maxTimeoutSeconds' forward grace on validBefore mirrors
// x402@1.2.0's preparePaymentHeader exactly (see header comment).
export function buildAuthorization(from, reqs, now = Date.now()) {
  const nowSeconds = Math.floor(now / 1000);
  return {
    from,
    to: reqs.payTo,
    value: reqs.maxAmountRequired,
    validAfter: String(nowSeconds - 600),
    validBefore: String(nowSeconds + reqs.maxTimeoutSeconds),
    nonce: createNonce(),
  };
}

// The EIP-712 typed-data structure signTypedData needs. Domain name/version
// come from the (already-validated) requirements' own extra block, never
// hardcoded independently -- see the header comment.
export function buildTypedData(authorization, reqs) {
  return {
    domain: {
      name: reqs.extra.name,
      version: reqs.extra.version,
      chainId: BASE_CHAIN_ID,
      verifyingContract: getAddress(reqs.asset),
    },
    types: AUTHORIZATION_TYPES,
    primaryType: "TransferWithAuthorization",
    message: {
      from: getAddress(authorization.from),
      to: getAddress(authorization.to),
      value: BigInt(authorization.value),
      validAfter: BigInt(authorization.validAfter),
      validBefore: BigInt(authorization.validBefore),
      nonce: authorization.nonce,
    },
  };
}

// The only step that touches the private key. Everything above and below
// this is pure/offline; this is offline too (signTypedData on a
// viem LocalAccount needs no RPC and makes no network call), it is just
// not deterministic (a fresh signature each call) so it is kept separate
// from the pure functions above rather than folded into buildTypedData.
export async function signAuthorization(account, authorization, reqs) {
  const typedData = buildTypedData(authorization, reqs);
  return account.signTypedData(typedData);
}

// The X-PAYMENT wire shape: base64(JSON) with every bigint-ish field
// already carried as a decimal string in `authorization`, matching what
// src/x402.ts's payAndSettle decodes with `JSON.parse(atob(paymentHeader))`.
export function encodePaymentHeader(x402Version, reqs, authorization, signature) {
  const payload = {
    x402Version,
    scheme: reqs.scheme,
    network: reqs.network,
    payload: { signature, authorization },
  };
  return btoa(JSON.stringify(payload));
}

// Dry-run reporting only: shows what buildAuthorization/buildTypedData
// would produce, without ever calling signTypedData. BigInt fields are
// stringified for JSON.stringify's sake (BigInt cannot be serialised).
export function describeWouldSign(from, reqs, now = Date.now()) {
  const authorization = buildAuthorization(from, reqs, now);
  const typedData = buildTypedData(authorization, reqs);
  return {
    domain: typedData.domain,
    authorization,
    message: {
      ...typedData.message,
      value: typedData.message.value.toString(),
      validAfter: typedData.message.validAfter.toString(),
      validBefore: typedData.message.validBefore.toString(),
    },
  };
}

// ---------- CLI orchestration (not exercised by tests) ----------

async function readJson(response) {
  const text = await response.text();
  try {
    return { json: JSON.parse(text), text };
  } catch {
    return { json: null, text };
  }
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(String(e.message ?? e));
    console.error("Usage: node scripts/register-maintainer.mjs --code <invite-code> [--url <url>] [--dry-run]");
    process.exitCode = 1;
    return;
  }

  let account = null;
  let payerAddress = null;
  if (!args.dryRun) {
    if (!existsSync(WALLET_PATH)) {
      console.error(`No payer wallet at ${WALLET_PATH}.`);
      console.error("Run: node scripts/generate-payer-wallet.mjs, then fund the printed address with USDC on Base.");
      process.exitCode = 1;
      return;
    }
    let wallet;
    try {
      wallet = JSON.parse(readFileSync(WALLET_PATH, "utf8"));
    } catch (e) {
      console.error(`Could not read/parse ${WALLET_PATH}: ${e.message ?? e}`);
      process.exitCode = 1;
      return;
    }
    account = privateKeyToAccount(wallet.privateKey);
    if (account.address.toLowerCase() !== String(wallet.address).toLowerCase()) {
      console.error(`${WALLET_PATH} is inconsistent: its stored address does not match its private key. Refusing to proceed.`);
      process.exitCode = 1;
      return;
    }
    payerAddress = account.address;
  } else if (existsSync(WALLET_PATH)) {
    try {
      payerAddress = JSON.parse(readFileSync(WALLET_PATH, "utf8")).address ?? null;
    } catch {
      payerAddress = null; // dry run continues address-less; this is a report, not a hard requirement
    }
  }

  const body = JSON.stringify(buildRegisterBody(args.code));
  const target = `${args.url.replace(/\/+$/, "")}/api/register`;
  console.log(`POST ${target}`);
  console.log(`  body: ${body}`);

  let first;
  try {
    first = await fetch(target, { method: "POST", headers: { "Content-Type": "application/json" }, body });
  } catch (e) {
    console.error(`Could not reach ${target}: ${e.message ?? e}`);
    console.error("Nothing was sent. No money moved.");
    process.exitCode = 1;
    return;
  }
  const { json: firstJson, text: firstText } = await readJson(first);

  if (first.status !== 402) {
    console.log(`Server responded HTTP ${first.status} (expected 402 at this stage).`);
    console.log(firstJson ? JSON.stringify(firstJson, null, 2) : firstText);
    if (args.dryRun) {
      console.log("dry run: stopped here. This proves reachability and the gate ordering; nothing was paid, nothing was constructed.");
      process.exitCode = 0;
      return;
    }
    console.error("Registration did not reach the payment stage. No payment was constructed. Nothing was spent.");
    process.exitCode = 1;
    return;
  }

  if (firstJson?.x402Version !== 1) {
    console.error(`Server's 402 named x402Version ${JSON.stringify(firstJson?.x402Version)}; this script only speaks protocol version 1.`);
    console.error("Refusing to guess at a different protocol version. Nothing was signed, nothing was spent.");
    process.exitCode = 1;
    return;
  }
  if (!firstJson || !Array.isArray(firstJson.accepts) || firstJson.accepts.length === 0) {
    console.error("402 response had no usable 'accepts' array. Cannot continue.");
    console.error(firstText);
    process.exitCode = 1;
    return;
  }

  let reqs;
  try {
    reqs = validatePaymentRequirements(firstJson.accepts[0]);
  } catch (e) {
    console.error(`Refusing to proceed: ${e.message ?? e}`);
    process.exitCode = 1;
    return;
  }

  if (args.dryRun) {
    console.log("402 received. Payment requirements matched every expected field (network, asset, treasury, price, EIP-712 domain).");
    if (payerAddress) {
      console.log(`Would sign as ${payerAddress} (unsigned only -- signTypedData is never called in --dry-run):`);
      console.log(JSON.stringify(describeWouldSign(payerAddress, reqs), null, 2));
    } else {
      console.log(`No payer wallet found at ${WALLET_PATH} -- run generate-payer-wallet.mjs to see the full unsigned payload too.`);
    }
    console.log("dry run: nothing signed, nothing sent, nothing spent.");
    process.exitCode = 0;
    return;
  }

  console.log(`Payment required: $${(Number(reqs.maxAmountRequired) / 1e6).toFixed(2)} USDC on Base, to ${reqs.payTo}`);
  console.log(`Paying from ${payerAddress}...`);

  let paymentHeader;
  try {
    const authorization = buildAuthorization(payerAddress, reqs);
    const signature = await signAuthorization(account, authorization, reqs);
    paymentHeader = encodePaymentHeader(firstJson.x402Version, reqs, authorization, signature);
  } catch (e) {
    console.error(`Failed to construct/sign the payment: ${e.message ?? e}`);
    console.error("Nothing was sent. No money moved.");
    process.exitCode = 1;
    return;
  }

  let second;
  try {
    second = await fetch(target, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-PAYMENT": paymentHeader },
      body,
    });
  } catch (e) {
    console.error(`The signed payment could not be sent: ${e.message ?? e}`);
    console.error("The facilitator was never reached with this signature. It is safe to just run this script again.");
    process.exitCode = 1;
    return;
  }
  const { json: secondJson, text: secondText } = await readJson(second);

  if (second.status === 402) {
    console.error("Payment was not accepted (nothing settled, nothing was spent):");
    console.error(secondJson ? JSON.stringify(secondJson, null, 2) : secondText);
    process.exitCode = 1;
    return;
  }
  if (second.status !== 201) {
    console.error(`Registration failed after the payment attempt: HTTP ${second.status}.`);
    console.error(secondJson ? JSON.stringify(secondJson, null, 2) : secondText);
    console.error("");
    console.error("If the message above names a settled transaction, your money already moved even though");
    console.error("registration did not complete -- register-gate.ts is designed to name the tx in exactly this");
    console.error("case, so it can be put right by hand. Do NOT just re-run this script: read docs/SEEDING.md's");
    console.error("failure-modes section, and check GET /treasury and GET /api/official on the target server first.");
    process.exitCode = 1;
    return;
  }
  if (!secondJson || typeof secondJson.secret !== "string" || !secondJson.secret) {
    console.error("Server returned 201 but no secret was in the body. This should not happen. Full response:");
    console.error(secondText);
    process.exitCode = 1;
    return;
  }

  writeFileSync(SECRET_PATH, secondJson.secret + "\n");

  console.log("");
  console.log("Registered.");
  console.log(`citizen_id: ${secondJson.citizen_id}`);
  console.log(`handle: ${secondJson.handle}`);
  if (secondJson.payment) {
    console.log("payment receipt:");
    console.log(`  payer: ${secondJson.payment.payer}`);
    console.log(`  tx: ${secondJson.payment.tx}`);
    console.log(`  amount_cents: ${secondJson.payment.amount_cents}`);
    console.log(`  ledger_receipt: ${secondJson.payment.ledger_receipt}`);
  }
  console.log(`Secret written to ${SECRET_PATH} (never printed here, and never will be).`);
  console.log("Next: node scripts/put-maintainer-secret.mjs");
}

// pathToFileURL, not a hand-rolled string, because on Windows import.meta.url
// is "file:///C:/..." (three slashes, forward-slashed) while process.argv[1]
// is "C:\..." (backslashed, no scheme) -- a naive template-string join
// mismatches and this guard would silently never run main().
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
