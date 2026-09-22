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
//   - two read-only chain reads over public Base RPCs (no key): the payer's
//     USDC balance is checked BEFORE the tombstone and the sign (an
//     underfunded payer refuses cleanly instead of wedging on its own
//     'signing' record), and after a refused second leg the chain is asked
//     whether OUR nonce (authorizationState) was executed -- if not, the
//     record becomes 'refused' and may be retried only after the signed
//     authorization's validBefore has passed and the chain still says
//     unexecuted. Both reads fail CLOSED. (exchange 2026-09-15, GEMINI r1.)
//   - the bearer is commonhold-agent's CITIZEN secret, read from
//     commonhold-agent-registration.local.json -- the file scripts/
//     roll-citizen-secret.mjs wrote on 2026-09-13 (L-056). The older
//     maintainer-secret.local.txt holds the ORIGINAL secret, which no longer
//     authenticates (secret_hash was rolled); it is still the worker's
//     MAINTAINER_SECRET, which is a different door.
//   - the payee is pinned to the CHAIN, not only to the command line.
//     --wallet-row names the identity-log wallet row (GET /api/events?kind=
//     wallet_declared or ?kind=wallet_changed) that made that wallet the
//     submission's citizen's current one, and --wallet-row-hash is that row's
//     hash as the operator wrote it down when reading it. Before the 402 probe,
//     in dry run and execute alike, the script re-reads both wallet kinds,
//     recomputes the row's hash from the served preimage, requires the row to
//     make the pinned payee current (the declared address, or the right-hand
//     side of a change, parsed exactly), to belong to the submission's citizen
//     and to be that citizen's NEWEST wallet row of either kind, then asks
//     GET /api/attest?identity_from=<row>&identity_expect=<hash> whether the
//     chain still holds that hash at that row. A head that moved under the row
//     the desk pinned is a refusal before any bearer is used (1f916 comment
//     69513, chit402, 2026-09-19: what should the desk refuse when the
//     published head moves). Reading both kinds closes the change-away-and-back
//     pass named in 1f916 comment 73404 (2026-09-21): a declaration of A, then
//     changes A -> B and B -> A, no longer passes against the stale
//     declaration of A; the desk must pin the newest row. All four reads are
//     public and fail CLOSED.
//
// Run from society/:
//   node scripts/pay-listing.mjs --listing 3 --submission 1 --payee 0x... --amount-cents 1200 --wallet-row 24 --wallet-row-hash <64 hex>            # DRY RUN
//   node scripts/pay-listing.mjs --listing 3 --submission 1 --payee 0x... --amount-cents 1200 --wallet-row 24 --wallet-row-hash <64 hex> --execute  # pays
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
const EXPECTED_MAX_TIMEOUT_SECONDS = 300; // x402.ts buildPaymentRequirements: maxTimeoutSeconds 300
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
  // The worker emits exactly 300 (x402.ts buildPaymentRequirements); a larger window
  // would only widen how long a signed authorization stays executable (GEMINI r1 p4).
  if (!Number.isInteger(reqs.maxTimeoutSeconds) || reqs.maxTimeoutSeconds <= 0 || reqs.maxTimeoutSeconds > EXPECTED_MAX_TIMEOUT_SECONDS) problems.push(`maxTimeoutSeconds: expected a positive integer <= ${EXPECTED_MAX_TIMEOUT_SECONDS}, got ${JSON.stringify(reqs.maxTimeoutSeconds)}`);
  if (problems.length > 0) throw new Error("payment requirements did not match, refusing to sign:\n  " + problems.join("\n  "));
  return reqs;
}

// The 200 receipt must describe the purchase we authorised, or the tombstone
// stays 'signing' and the operator reconciles from chain.
export function validatePayReceipt(body, { listingId, submissionId, payee, amountCents, payer }) {
  const problems = [];
  if (!body || typeof body !== "object") return ["receipt is not a JSON object"];
  if (body.listing_id !== listingId) problems.push(`listing_id: expected ${listingId}, got ${JSON.stringify(body.listing_id)}`);
  if (body.submission_id !== submissionId) problems.push(`submission_id: expected ${submissionId}, got ${JSON.stringify(body.submission_id)}`);
  if (typeof body.payee_address !== "string" || body.payee_address.toLowerCase() !== payee.toLowerCase()) problems.push(`payee_address: expected ${payee}, got ${JSON.stringify(body.payee_address)}`);
  if (body.amount_cents !== amountCents) problems.push(`amount_cents: expected ${amountCents}, got ${JSON.stringify(body.amount_cents)}`);
  if (typeof body.tx !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(body.tx)) problems.push(`tx: expected a 0x-prefixed 32-byte hash, got ${JSON.stringify(body.tx)}`);
  if (body.listing_marked_paid !== true) problems.push(`listing_marked_paid: expected true, got ${JSON.stringify(body.listing_marked_paid)}`);
  // The receipt must name OUR signing account as the payer, or the permanent
  // record would certify a payer identity it never verified (GEMINI r1 p3).
  if (typeof body.payer_address !== "string" || typeof payer !== "string" || body.payer_address.toLowerCase() !== payer.toLowerCase()) problems.push(`payer_address: expected the signing account ${payer}, got ${JSON.stringify(body.payer_address)}`);
  return problems;
}

// The X-PAYMENT-RESPONSE header is base64(JSON) of the facilitator's settlement
// ({success, transaction, network, payer}). Returns the problems found: absent,
// undecodable, not a success, wrong network, naming a different transaction
// from the body, or naming a payer other than the account that signed
// (exchange 2026-09-15, GEMINI round 1 point 5).
export function checkSettlementHeader(headerValue, bodyTx, payer) {
  if (typeof headerValue !== "string" || !headerValue) return ["X-PAYMENT-RESPONSE: header missing from the 200; the server always sets it"];
  let s;
  try {
    s = JSON.parse(Buffer.from(headerValue, "base64").toString("utf8"));
  } catch {
    return ["X-PAYMENT-RESPONSE: not base64-encoded JSON"];
  }
  const problems = [];
  if (!s || s.success !== true) problems.push(`X-PAYMENT-RESPONSE: success is not true (${JSON.stringify(s?.success)})`);
  if (s?.network !== EXPECTED_NETWORK) problems.push(`X-PAYMENT-RESPONSE: network ${JSON.stringify(s?.network)} is not "${EXPECTED_NETWORK}"`);
  if (typeof s?.transaction !== "string" || typeof bodyTx !== "string" || s.transaction.toLowerCase() !== bodyTx.toLowerCase()) {
    problems.push(`X-PAYMENT-RESPONSE: transaction ${JSON.stringify(s?.transaction)} does not match the body's tx ${JSON.stringify(bodyTx)}`);
  }
  if (typeof s?.payer !== "string" || typeof payer !== "string" || s.payer.toLowerCase() !== payer.toLowerCase()) {
    problems.push(`X-PAYMENT-RESPONSE: payer ${JSON.stringify(s?.payer)} is not the account that signed (${payer})`);
  }
  return problems;
}

// The authorization we signed, read back out of the X-PAYMENT header we sent
// (encodePaymentHeader: base64 JSON {payload:{authorization:{from,nonce,
// validBefore,...}}}). Needed after a refused second leg to ask the chain
// whether that exact nonce was ever executed.
export function decodeSentAuthorization(paymentHeader) {
  const p = JSON.parse(Buffer.from(paymentHeader, "base64").toString("utf8"));
  const a = p?.payload?.authorization;
  if (!a || !isAddress(a.from) || typeof a.nonce !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(a.nonce) || !/^\d+$/.test(String(a.validBefore))) {
    throw new Error("the sent X-PAYMENT header does not carry a well-formed authorization");
  }
  return { from: a.from, nonce: a.nonce, validBefore: Number(a.validBefore) };
}

// A 'refused' tombstone (second leg came back non-200 AND the chain says our
// nonce was never executed) may be retried only once the signed authorization
// can no longer be executed by anyone: after its validBefore, re-checked
// against the chain at that moment. Pure; the caller supplies the clock and
// the chain answer.
// RETRY_MARGIN_SECONDS: the contract judges validBefore against BLOCK time,
// this machine against its own clock. A local clock running ahead would let
// a retry sign while the first authorization is still executable on-chain,
// and a facilitator holding both could execute both. Five minutes covers any
// skew a working machine has; the cost is the operator waiting that long.
export const RETRY_MARGIN_SECONDS = 300;
export function refusedRetryDecision(refused, nowSeconds, nonceUsedNow) {
  if (nonceUsedNow === true) return { retry: false, reason: "the earlier authorization HAS been executed on-chain since it was refused; this is a settled payment with no receipt -- reconcile from the chain, do not re-run" };
  if (nonceUsedNow !== false) return { retry: false, reason: "the chain's answer about the earlier authorization was not a definite 'unexecuted'; refusing" };
  if (!Number.isInteger(refused.valid_before)) return { retry: false, reason: "the refused record carries no valid_before; cannot prove the earlier authorization is dead" };
  const deadAfter = refused.valid_before + RETRY_MARGIN_SECONDS;
  if (nowSeconds <= deadAfter) {
    return { retry: false, reason: `the earlier authorization is unexecuted but still valid until ${new Date(refused.valid_before * 1000).toISOString()} (plus a ${RETRY_MARGIN_SECONDS}s clock-skew margin); re-run after ${new Date(deadAfter * 1000).toISOString()}, when nobody holding it can execute it` };
  }
  return { retry: true, reason: "earlier authorization expired unexecuted" };
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
  if (t && t.status === "refused") return { ...t, status: "refused" };
  // Classification wins over the file's own status field (post-listing.mjs
  // spreads the other way round, so an unrecognised status there survives as
  // itself; harmless because every consumer checks === "settled" only, but
  // the test here pins the intended reading).
  return { ...t, status: "unknown" };
}

export function parseArgs(argv) {
  const args = { listingId: undefined, submissionId: undefined, payee: undefined, amountCents: undefined, maxAmountCents: DEFAULT_MAX_AMOUNT_CENTS, walletRow: undefined, walletRowHash: undefined, execute: false };
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
    else if (a === "--wallet-row") args.walletRow = intFlag(a, argv[++i]);
    else if (a === "--wallet-row-hash") {
      args.walletRowHash = argv[++i];
      if (!IDENTITY_HASH_RE.test(String(args.walletRowHash))) throw new Error("--wallet-row-hash must be the row's 64-hex sha256 as GET /api/events serves it (lowercase)");
    } else if (a === "--payee") {
      args.payee = argv[++i];
      if (!isAddress(args.payee)) throw new Error("--payee must be a 0x-prefixed 20-byte address (the submitter's declared wallet, from GET /api/events)");
    } else throw new Error(`unrecognised argument: ${a}. (There is no --url or --tombstone-dir: the target and the at-most-once store are pinned.)`);
  }
  for (const [flag, v] of [["--listing", args.listingId], ["--submission", args.submissionId], ["--payee", args.payee], ["--amount-cents", args.amountCents], ["--wallet-row", args.walletRow], ["--wallet-row-hash", args.walletRowHash]]) {
    if (v === undefined) throw new Error(`${flag} is required`);
  }
  return args;
}

// ---------- the wallet-row pin (pure; test/pay-listing.test.ts) ----------

export const IDENTITY_HASH_RE = /^[0-9a-f]{64}$/;

// The identity log's own preimage (society.ts identityLog how_to_verify;
// chain.ts): sha256(prev_hash + "\n" + JSON.stringify([citizen_id, kind,
// detail, created_at])). Recomputed here so the pin never takes the served
// `hash` field's word for what the row says.
export function recomputeIdentityRowHash(row) {
  return createHash("sha256")
    .update(String(row.prev_hash) + "\n" + JSON.stringify([row.citizen_id, row.kind, row.detail, row.created_at]))
    .digest("hex");
}

// The two identity-log kinds a wallet row can be (src/wallets.ts walletLogEntry):
// the first declaration and every later change.
export const WALLET_ROW_KINDS = ["wallet_declared", "wallet_changed"];

// GET /api/events serves at most this many rows per kind, newest first
// (src/society.ts identityLog, LIMIT 500; a test pins the two together). A page
// that comes back full may be missing rows, so it is never taken as a wallet
// history.
export const EVENTS_PAGE_CAP = 500;

// The address a wallet row makes current, parsed exactly from the served detail
// (src/wallets.ts walletLogEntry): "wallet declared: <addr>" or "wallet changed:
// <previous> -> <next>". A substring test would also match a change's PREVIOUS
// address, so a row that moved the wallet AWAY from the payee would pass for it.
const DECLARED_DETAIL = /^wallet declared: (0x[0-9a-fA-F]{40})$/;
const CHANGED_DETAIL = /^wallet changed: 0x[0-9a-fA-F]{40} -> (0x[0-9a-fA-F]{40})$/;
export function walletRowAddress(row) {
  const detail = String(row?.detail ?? "");
  const m = row?.kind === "wallet_declared" ? DECLARED_DETAIL.exec(detail) : row?.kind === "wallet_changed" ? CHANGED_DETAIL.exec(detail) : null;
  return m ? m[1].toLowerCase() : null;
}

// From the public wallet rows already fetched (both kinds): does the pinned row
// make the pinned payee the submission's citizen's current wallet, as that
// citizen's newest wallet row of either kind, with the hash the operator wrote
// down? Pure, so every refusal is provable offline.
export function checkWalletRow({ rows, walletRow, walletRowHash, payee, submitterCitizenId }) {
  const row = rows.find((r) => r && r.id === walletRow);
  if (!row) return { ok: false, reason: "wallet_row_missing", message: `identity-log row ${walletRow} is not among GET /api/events?kind=wallet_declared or ?kind=wallet_changed. Refusing.` };
  if (!WALLET_ROW_KINDS.includes(row.kind)) return { ok: false, reason: "wallet_row_kind", message: `identity-log row ${walletRow} is a '${row.kind}' row, not a wallet row (wallet_declared or wallet_changed). Refusing.` };
  const current = walletRowAddress(row);
  if (current === null || current !== payee.toLowerCase()) return { ok: false, reason: "wallet_row_payee", message: `identity-log row ${walletRow} reads "${String(row.detail ?? "")}", which does not make the pinned payee ${payee} the citizen's current wallet. Refusing.` };
  if (row.citizen_id !== submitterCitizenId) return { ok: false, reason: "wallet_row_citizen", message: `identity-log row ${walletRow} belongs to citizen ${row.citizen_id} (${row.citizen ?? "?"}), not to the submission's citizen ${submitterCitizenId}. Refusing.` };
  // Newer of EITHER kind: a change away and back to the same address is still a
  // newer wallet row, and the desk pins the newest one (1f916 comment 73404).
  const newer = rows.filter((r) => r && WALLET_ROW_KINDS.includes(r.kind) && r.citizen_id === row.citizen_id && r.id > row.id).map((r) => r.id);
  if (newer.length) return { ok: false, reason: "wallet_row_superseded", message: `citizen ${row.citizen_id} has a newer wallet row after row ${walletRow} (row${newer.length > 1 ? "s" : ""} ${newer.join(", ")}), even if it names the same address again. Re-read the citizen's newest wallet row and re-pin. Refusing.` };
  const recomputed = recomputeIdentityRowHash(row);
  if (recomputed !== walletRowHash) return { ok: false, reason: "wallet_row_hash", message: `identity-log row ${walletRow} recomputes to ${recomputed}, not the pinned ${walletRowHash}: this is not the row the operator read. Refusing.` };
  return { ok: true, row };
}

// The witness answer: GET /api/attest?identity_from=<row>&identity_expect=<hash>
// compares the saved hash to the chain's hash at that row (chain.ts
// attestTable, `expect_matches`). Anything but a definite match refuses; a
// chain reported broken after the row refuses too. 'incomplete' (a chain longer
// than one verify page, no break found) is accepted only with the match, since
// the match is the pin and the page limit is not a tamper report.
export function checkWitness(attest, walletRow, walletRowHash) {
  const il = attest && typeof attest === "object" ? attest.identity_log : undefined;
  if (!il || typeof il !== "object") return { ok: false, reason: "wallet_row_unreadable", message: "GET /api/attest answered without an identity_log block. Refusing." };
  if (il.expect_matches !== true) return { ok: false, reason: "wallet_row_moved", message: `the identity chain no longer holds ${walletRowHash} at row ${walletRow} (status ${il.status ?? "?"}, the chain's hash there is now ${il.anchor_at_from ?? "?"}): the published head moved under the row the desk pinned. Refusing; re-read the row by eye and decide whether the record or the pin is wrong before anything is paid.` };
  if (il.status === "broken") return { ok: false, reason: "wallet_row_chain_broken", message: `the identity chain verifies as broken after row ${walletRow}${il.reason ? `: ${il.reason}` : ""}. Refusing.` };
  return { ok: true, status: il.status, head: il.head };
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
export async function payListing({ listingId, submissionId, payee, amountCents, maxAmountCents, walletRow, walletRowHash, target, funderSecret, execute, payer }, deps) {
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
  for (const [name, v] of [["listingId", listingId], ["submissionId", submissionId], ["amountCents", amountCents], ["maxAmountCents", maxAmountCents], ["walletRow", walletRow]]) {
    if (!Number.isSafeInteger(v) || v <= 0) {
      return { ok: false, exitCode: 1, reason: "argument_invalid", key: null, tombPath: null, message: `${name} must be a positive safe integer; refusing before any bearer is used.` };
    }
  }
  if (typeof walletRowHash !== "string" || !IDENTITY_HASH_RE.test(walletRowHash)) {
    return { ok: false, exitCode: 1, reason: "argument_invalid", key: null, tombPath: null, message: "walletRowHash must be a lowercase 64-hex sha256; refusing before any bearer is used." };
  }
  const purchase = purchaseIdentity({ listingId, submissionId, payee, amountCents });
  const key = attemptKey("POST", target, FUNDER_HANDLE, purchase);
  const tombPath = tombstonePath(TOMBSTONE_DIR, key);
  const base = { key, tombPath };

  if (amountCents > maxAmountCents) {
    return { ...base, ok: false, exitCode: 1, reason: "amount_over_cap", message: `amount $${(amountCents / 100).toFixed(2)} exceeds cap $${(maxAmountCents / 100).toFixed(2)}` };
  }

  // At-most-once gate (execute). Settled -> idempotent success. Refused (a
  // non-200 second leg whose authorization the chain says was never executed)
  // -> retryable ONLY once that authorization has expired and the chain still
  // says unexecuted (GEMINI r1 p2: an ordinary refusal must not wedge the
  // operator into deleting a tombstone by hand; but a still-valid signed
  // authorization in the facilitator's hands is a double-pay if we sign
  // another). Anything else blocks.
  if (execute && !isAddress(payer)) {
    return { ...base, ok: false, exitCode: 1, reason: "argument_invalid", message: "payer (the signing account's address) is required to execute; refusing before any bearer is used." };
  }
  let replaceTombstone = false;
  if (execute && deps.exists(tombPath)) {
    const t = classifyTombstone(deps.readFile(tombPath));
    if (t.status === "settled") return { ...base, ok: true, exitCode: 0, reason: "already_settled", tx: t.tx };
    if (t.status === "refused") {
      let usedNow;
      try {
        usedNow = await deps.authorizationUsed(t.from, t.nonce);
      } catch (e) {
        return { ...base, ok: false, exitCode: 1, reason: "tombstone_blocks", message: `A refused earlier attempt exists and the chain could not be asked whether its authorization was executed (${e?.message ?? e}). Refusing until it can. ${recoveryMessage(tombPath)}` };
      }
      const d = refusedRetryDecision(t, deps.nowSeconds(), usedNow);
      if (!d.retry) return { ...base, ok: false, exitCode: 1, reason: "tombstone_blocks", message: `Refused earlier attempt at ${tombPath}: ${d.reason}` };
      replaceTombstone = true;
    } else {
      return { ...base, ok: false, exitCode: 1, reason: "tombstone_blocks", message: recoveryMessage(tombPath) };
    }
  }

  // The wallet-row pin, dry run and execute alike, BEFORE the bearer is used:
  // the payee on the command line must be the wallet the named identity-log
  // row made current for the submission's citizen, that row must be the
  // citizen's newest wallet row of either kind, with the hash the operator
  // wrote down, and the chain must still hold that hash at that row. Four
  // public GETs (listing, both wallet kinds, the attest witness), all fail
  // closed.
  const origin = new URL(target).origin;
  let listingDoc;
  let declaredDoc;
  let changedDoc;
  try {
    listingDoc = await deps.readJson(`${origin}/api/listing/${listingId}`);
    declaredDoc = await deps.readJson(`${origin}/api/events?kind=wallet_declared`);
    changedDoc = await deps.readJson(`${origin}/api/events?kind=wallet_changed`);
  } catch (e) {
    return { ...base, ok: false, exitCode: 1, reason: "wallet_row_unreadable", message: `Could not read the public rows the payee pin needs (${e?.message ?? e}). Refusing before any bearer is used.` };
  }
  const submission = Array.isArray(listingDoc?.submissions) ? listingDoc.submissions.find((s) => s && s.id === submissionId) : undefined;
  if (!submission || !Number.isSafeInteger(submission.citizen_id)) {
    return { ...base, ok: false, exitCode: 1, reason: "submission_unknown", message: `GET /api/listing/${listingId} does not list submission ${submissionId} with a citizen_id. Refusing before any bearer is used.` };
  }
  for (const [kind, doc] of [["wallet_declared", declaredDoc], ["wallet_changed", changedDoc]]) {
    if (!Array.isArray(doc?.events)) {
      return { ...base, ok: false, exitCode: 1, reason: "wallet_row_unreadable", message: `GET /api/events?kind=${kind} answered without an events array. Refusing before any bearer is used.` };
    }
    if (doc.events.length >= EVENTS_PAGE_CAP) {
      return { ...base, ok: false, exitCode: 1, reason: "wallet_row_unreadable", message: `GET /api/events?kind=${kind} returned a full page (${doc.events.length} rows, the route's cap is ${EVENTS_PAGE_CAP}), so older rows may be missing and the newest-row check cannot be trusted. Refusing before any bearer is used.` };
    }
  }
  // One list of both kinds, each row once (by chain id).
  const byId = new Map();
  for (const r of [...declaredDoc.events, ...changedDoc.events]) if (r && Number.isSafeInteger(r.id) && !byId.has(r.id)) byId.set(r.id, r);
  const pin = checkWalletRow({ rows: [...byId.values()], walletRow, walletRowHash, payee, submitterCitizenId: submission.citizen_id });
  if (!pin.ok) return { ...base, ok: false, exitCode: 1, reason: pin.reason, message: pin.message };
  let attestDoc;
  try {
    attestDoc = await deps.readJson(`${origin}/api/attest?identity_from=${walletRow}&identity_expect=${walletRowHash}`);
  } catch (e) {
    return { ...base, ok: false, exitCode: 1, reason: "wallet_row_unreadable", message: `Could not ask GET /api/attest whether the chain still holds the pinned row (${e?.message ?? e}). Refusing before any bearer is used.` };
  }
  const witness = checkWitness(attestDoc, walletRow, walletRowHash);
  if (!witness.ok) return { ...base, ok: false, exitCode: 1, reason: witness.reason, message: witness.message };
  const walletRowCheck = { row: walletRow, kind: pin.row.kind, citizen_id: pin.row.citizen_id, citizen: pin.row.citizen ?? null, submitter_handle: submission.submitter_handle ?? null, attest_status: witness.status, identity_head: witness.head ?? null };

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

  if (!execute) return { ...base, ok: true, exitCode: 0, reason: "dry_run", reqs, walletRowCheck };

  // Balance pre-check, BEFORE the tombstone and the sign (GEMINI r1 p2): a
  // payer that cannot cover the amount would sign, be refused at settle, and
  // wedge on its own 'signing' record. Ask the chain first; fail closed if the
  // chain cannot be asked.
  let balanceAtomic;
  try {
    balanceAtomic = await deps.usdcBalanceAtomic(payer);
  } catch (e) {
    return { ...base, ok: false, exitCode: 1, reason: "balance_unknown", message: `Could not read the payer's USDC balance on Base (${e?.message ?? e}). Refusing to sign without knowing it can settle.` };
  }
  const needAtomic = BigInt(reqs.maxAmountRequired);
  if (balanceAtomic < needAtomic) {
    return { ...base, ok: false, exitCode: 1, reason: "balance_insufficient", message: `Payer ${payer} holds ${(Number(balanceAtomic) / 1e6).toFixed(6)} USDC, less than the ${(Number(needAtomic) / 1e6).toFixed(2)} USDC this bounty needs. Nothing signed. Top up and re-run.` };
  }

  // The durable at-most-once record is created EXCLUSIVELY and FLUSHED right
  // before the irreversible sign (or atomically REPLACED when the only prior
  // record is an expired, unexecuted refusal). If it exists otherwise, refuse;
  // if the flushed write fails, refuse (never sign without a durable gate).
  try {
    deps.mkdir(TOMBSTONE_DIR);
    const signing = JSON.stringify({ status: "signing", key, target, ...purchase });
    if (replaceTombstone) deps.writeAtomic(tombPath, signing);
    else deps.writeExclusive(tombPath, signing);
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

  // The worker's own "settle sent, answer never read" case (2026-09-19,
  // finding 3): it answers 502 with error "settlement_unconfirmed" and KEEPS
  // the listing reserved, because the facilitator may have moved the money.
  // The generic non-200 branch below would ask the chain and, seeing our
  // nonce unexecuted so far, write a 'refused' tombstone that says nothing was
  // paid -- a label the transfer may falsify minutes later. So this code is
  // recognised FIRST: the tombstone stays 'signing', and is REWRITTEN with the
  // authorisation identity (from, nonce, validBefore) plus the 502's detail,
  // so the later two-RPC reconciliation has the exact thing to ask the chain
  // about after this process has exited. Nothing is retried by this script.
  if (secondJson && secondJson.error === "settlement_unconfirmed") {
    let ident = {};
    try {
      const sent = decodeSentAuthorization(paymentHeader);
      ident = { from: sent.from, nonce: sent.nonce, valid_before: sent.validBefore };
    } catch {
      // keep going: the tombstone still records the status and the detail
    }
    deps.writeAtomic(tombPath, JSON.stringify({ status: "signing", key, target, ...purchase, ...ident, http_status: second.status, unconfirmed_at: deps.nowSeconds(), detail: secondText.slice(0, 2000) }, null, 2));
    return { ...base, ok: false, exitCode: 1, reason: "leg2_unconfirmed", message: `The server sent the settle request and could not read the facilitator's answer (HTTP ${second.status}, settlement_unconfirmed); it keeps the listing reserved and so does this record. Outcome AMBIGUOUS: the money may or may not have moved. DO NOT re-run. After the authorization's validBefore${ident.valid_before ? ` (${new Date((ident.valid_before + RETRY_MARGIN_SECONDS) * 1000).toISOString()} with the ${RETRY_MARGIN_SECONDS}s margin)` : ""}, the operator checks authorizationState(from, nonce) on two RPCs and reconciles the listing from that; the identity is in the 'signing' record.\n${recoveryMessage(tombPath)}`, detail: secondText };
  }

  // The server's own settled-but-unrecorded case is a 500 carrying the tx and
  // a listing left 'paying': money moved. That is exactly the case the
  // tombstone must stay 'signing' for, so it is not special-cased here.
  if (second.status !== 200) {
    // Ask the chain whether OUR nonce was executed. If it was not, record a
    // 'refused' tombstone (retryable after the authorization expires, see the
    // gate above) instead of wedging on 'signing'. If the chain says it was,
    // or cannot be asked, 'signing' stands and the operator reconciles.
    try {
      const sent = decodeSentAuthorization(paymentHeader);
      const used = await deps.authorizationUsed(sent.from, sent.nonce);
      if (used === false) {
        deps.writeAtomic(tombPath, JSON.stringify({ status: "refused", key, target, ...purchase, from: sent.from, nonce: sent.nonce, valid_before: sent.validBefore, http_status: second.status, refused_at: deps.nowSeconds(), detail: secondText.slice(0, 2000) }, null, 2));
        return { ...base, ok: false, exitCode: 1, reason: "leg2_refused", message: `The server refused the signed payment (HTTP ${second.status}) and the chain confirms the authorization was not executed. Nothing was paid. Recorded as 'refused'; a re-run is allowed after ${new Date((sent.validBefore + RETRY_MARGIN_SECONDS) * 1000).toISOString()} (the signed authorization's validBefore plus a ${RETRY_MARGIN_SECONDS}s clock-skew margin, when nobody holding it can execute it).`, detail: secondText };
      }
    } catch {
      // fall through: keep 'signing'
    }
    return { ...base, ok: false, exitCode: 1, reason: "leg2_not_200", message: `Bounty not confirmed paid after the signed request: HTTP ${second.status}.\n${recoveryMessage(tombPath)}`, detail: secondText };
  }
  const problems = validatePayReceipt(secondJson, { listingId, submissionId, payee, amountCents, payer });
  // Belt to the body's braces (exchange 2026-09-15, CODEX): the worker also
  // returns the facilitator's settlement verbatim in X-PAYMENT-RESPONSE
  // (listings.ts, the 200's headers). It must be present and name the SAME
  // transaction as the body, or the receipt is contradictory and the
  // tombstone stays 'signing'. This still proves nothing about chain
  // inclusion -- that is the operator's on-chain check after the run.
  problems.push(...checkSettlementHeader(typeof second.headers?.get === "function" ? second.headers.get("X-PAYMENT-RESPONSE") : null, secondJson?.tx, payer));
  if (problems.length > 0) {
    return { ...base, ok: false, exitCode: 1, reason: "leg2_bad_body", message: `200 body did not match what we authorised; leaving the tombstone 'signing'.\n  ${problems.join("\n  ")}\n${recoveryMessage(tombPath)}`, detail: secondText };
  }

  // Success: atomic flushed replacement of the tombstone with a permanent,
  // terminal 'settled' receipt.
  deps.writeAtomic(tombPath, JSON.stringify({ status: "settled", key, target, ...purchase, tx: secondJson.tx, payer_address: secondJson.payer_address }, null, 2));
  return { ...base, ok: true, exitCode: 0, reason: "settled", tx: secondJson.tx, payerAddress: secondJson.payer_address, walletRowCheck };
}

// ---------- chain reads (public Base RPC, read-only, no key) ----------

// Public JSON-RPC endpoints tried in order; the first that answers wins. A
// non-answer everywhere throws, and every caller above treats that as
// "refuse" (never as "fine").
const BASE_RPCS = ["https://base.drpc.org", "https://1rpc.io/base", "https://base-rpc.publicnode.com", "https://mainnet.base.org"];
const SEL_BALANCE_OF = "0x70a08231"; // balanceOf(address)
const SEL_AUTHORIZATION_STATE = "0xe94a0102"; // authorizationState(address,bytes32), EIP-3009 on Base USDC

async function ethCallOne(url, data) {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params: [{ to: EXPECTED_ASSET, data }, "latest"] }), signal: AbortSignal.timeout(15000) });
  const j = await r.json();
  if (typeof j?.result === "string" && /^0x[0-9a-fA-F]*$/.test(j.result)) return j.result;
  throw new Error(`${url}: ${JSON.stringify(j?.error ?? j).slice(0, 120)}`);
}

// First endpoint that answers wins. Used for the balance, where a wrong answer
// only ever leads to a refusal or to a settle the server itself then refuses.
async function ethCall(data) {
  let lastErr;
  for (const url of BASE_RPCS) {
    try {
      return await ethCallOne(url, data);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error("no RPC answered");
}

const pad32 = (hexNo0x) => hexNo0x.toLowerCase().padStart(64, "0");

export async function usdcBalanceAtomic(address) {
  const out = await ethCall(SEL_BALANCE_OF + pad32(address.slice(2)));
  return BigInt(out === "0x" ? "0x0" : out);
}

// true if the (authorizer, nonce) pair has been used on-chain, i.e. the
// signed transferWithAuthorization was executed. A wrong "unexecuted" here is
// the ONE answer that could lead to a second signature for the same purchase
// (refused -> retry), so "false" is returned only when at least
// AUTHORIZATION_QUORUM independent endpoints agree on it; any "true" wins;
// anything less is an error, and every caller treats an error as "refuse".
// Pure decision in decideAuthorizationUsed (tested); the fan-out is here.
export const AUTHORIZATION_QUORUM = 2;
export function decideAuthorizationUsed(answers) {
  const bools = answers.filter((a) => a === true || a === false);
  if (bools.some((a) => a === true)) return true;
  if (bools.filter((a) => a === false).length >= AUTHORIZATION_QUORUM) return false;
  throw new Error(`only ${bools.length} endpoint(s) gave a definite answer; ${AUTHORIZATION_QUORUM} agreeing on 'unexecuted' are required`);
}
export async function authorizationUsed(authorizer, nonce) {
  const data = SEL_AUTHORIZATION_STATE + pad32(authorizer.slice(2)) + pad32(nonce.slice(2));
  const answers = await Promise.all(
    BASE_RPCS.map(async (url) => {
      try {
        const out = await ethCallOne(url, data);
        if (!/^0x0{63}[01]$/.test(out)) return new Error(`${url}: unexpected authorizationState result ${out}`);
        return out.endsWith("1");
      } catch (e) {
        return e instanceof Error ? e : new Error(String(e));
      }
    }),
  );
  return decideAuthorizationUsed(answers);
}

// ---------- CLI (not exercised by tests; payListing is) ----------

const realDeps = (account) => ({
  usdcBalanceAtomic,
  authorizationUsed,
  nowSeconds: () => Math.floor(Date.now() / 1000),
  fetch: (...a) => fetch(...a),
  // public, key-free GET; a non-2xx or a non-JSON body throws, and every
  // caller treats a throw as "refuse".
  readJson: async (url) => {
    const r = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`GET ${url} answered HTTP ${r.status}`);
    return r.json();
  },
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
    console.error("Usage: node scripts/pay-listing.mjs --listing <id> --submission <id> --payee <0x...> --amount-cents <n> --wallet-row <identity row id> --wallet-row-hash <its 64-hex hash> [--execute] [--max-amount-cents N]");
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
  console.log(`Pinned wallet row ${args.walletRow} (hash ${args.walletRowHash.slice(0, 8)}...): the payee must be that row's declared wallet, by the submission's citizen, still held by the chain.`);

  const result = await payListing(
    { listingId: args.listingId, submissionId: args.submissionId, payee: args.payee, amountCents: args.amountCents, maxAmountCents: args.maxAmountCents, walletRow: args.walletRow, walletRowHash: args.walletRowHash, target, funderSecret, execute: args.execute, payer: account?.address ?? null },
    realDeps(account ?? { address: "0x0000000000000000000000000000000000000000" }),
  );

  console.log(`Idempotency key: ${result.key}`);
  if (result.walletRowCheck) {
    const w = result.walletRowCheck;
    console.log(`Wallet row ${w.row}: ${w.kind}, the newest wallet row of citizen ${w.citizen_id} (${w.citizen ?? "?"}), the submitter of submission ${args.submissionId} (${w.submitter_handle ?? "?"}); recomputed hash matches the pin; GET /api/attest holds it at that row (status ${w.attest_status}, identity head ${w.identity_head ?? "?"}).`);
  }
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
