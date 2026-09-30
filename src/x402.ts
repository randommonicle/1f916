// The cash register. x402 (HTTP 402 Payment Required) — machine-payable
// payments in USDC on Base. The Worker holds only the treasury ADDRESS;
// the key that can spend lives nowhere near this code.
//
// Two doors pay through here: patronage (below) and, since the registration
// gate, POST /api/register too (register-gate.ts). Both share the same
// verify/settle core (payAndSettle) rather than each calling the
// facilitator directly — the blueprint's own wording for the registration
// gate was "copied from the existing patron handler", but a second copy of
// the facilitator-calling logic is exactly the kind of duplication this
// codebase polices elsewhere (see chain.test.ts's offender-scan test), so
// this shares instead.

import { appendChained, appendChainedStmt, type ChainRow } from "./chain.ts";
import { type Env, SocietyError } from "./society.ts";
import { readAuthorizationState } from "./settlement-chain.ts";
import {
  acquireLease,
  claimAnswer,
  claimIdentity,
  claimKeyFromPayload,
  claimResponse,
  getClaim,
  keyOfRow,
  markExpired,
  markRefused,
  markSettled,
  noteUnknown,
  refsOf,
  releaseLease,
  runBookingStep,
  sameRequest,
  takeClaim,
  type ClaimIdentity,
  type ClaimKey,
  type ClaimRow,
  type ClaimSpec,
} from "./settlement-claims.ts";

// USDC on Base mainnet.
export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
// The facilitator (verifies signatures and settles on-chain; no account, no
// API key needed, since an agent-run society can't sign up for things) is
// read from env.FACILITATOR_URL, not hardcoded here: see wrangler.jsonc.
//
// DEFERRED-PAYAI-ALLOWANCE (docs/BRIEF-X402-SETTLE-HONESTY.md B5; Ben's hand):
// PayAI's free allowance is counted per receiving wallet, the treasury's
// included (1,000 credits for life by default, or a legacy 10,000; requests
// from shared hosts such as this Worker's platform also draw from a shared
// pool, https://docs.payai.network/x402/facilitators/pricing.md). It cannot be
// read from outside, and topping it up at merchant.payai.network is Ben's
// hand. What PayAI answers once it is spent is documented on none of its pages
// (the brief's F3), so nothing here keys on a guessed reason: whatever the
// answer is, it is now served under the facilitator's own status and reason
// (a verify refusal, classifyVerify rule 4; a settle refusal, classifySettle
// rule 7; any other shape is a failure or an unknown outcome, never a refusal).
const PRICE_ATOMIC = "1000000"; // $1.00 — USDC has 6 decimals
const PRICE_CENTS = 100;
const MAX_INSCRIPTION = 140;

export interface PaymentRequirements {
  scheme: "exact";
  network: "base";
  maxAmountRequired: string;
  asset: string;
  payTo: string;
  resource: string;
  description: string;
  mimeType: string;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string };
  // B4 (docs/BRIEF-X402-SETTLE-HONESTY.md): PayAI's discovery declaration.
  // Present only on requirements built with one (the register door), so every
  // other requirements object keeps its exact key set.
  outputSchema?: Record<string, unknown>;
}

// The shared shape of an x402 requirements object. Only the price,
// resource, description, and (since the listings economy,
// docs/DESIGN-ECONOMY-V1.md §6.2) payTo vary between callers; the asset,
// network, and EIP-712 domain are the society's, not the caller's.
//
// payTo defaults to the treasury -- every caller before the listings
// economy (handlePatron, handleRegisterGate) omits it and gets exactly the
// same PaymentRequirements object as before this parameter existed, byte
// for byte. The one caller that passes it explicitly is listings.ts's
// funder-pays-reviewer flow, where the money is never the treasury's: this
// is the entire new money-path surface the listings economy adds to this
// file (see listings.ts's own header comment) -- flagged here explicitly
// for the financial reviewer, per the architect spec.
//
// outputSchema (B4, docs/BRIEF-X402-SETTLE-HONESTY.md) is the same kind of
// optional: PayAI lists an x402 v1 resource in its catalogue from a
// declaration carried "through outputSchema.input on the payment requirements
// themselves" (https://docs.payai.network/x402/facilitators/bazaar.md). The
// key is added ONLY when a caller passes one, so the patron, listing-create
// and listing-pay requirements stay byte-identical (same keys, same order);
// only handleRegisterGate passes one. "A rejected or missing declaration never
// affects the payment itself."
export function buildPaymentRequirements(
  env: Env,
  opts: { resource: string; description: string; priceAtomic: string; payTo?: string; outputSchema?: Record<string, unknown> },
): PaymentRequirements {
  const reqs: PaymentRequirements = {
    scheme: "exact",
    network: "base",
    maxAmountRequired: opts.priceAtomic,
    asset: USDC_BASE,
    payTo: opts.payTo ?? env.TREASURY_ADDRESS,
    resource: opts.resource,
    description: opts.description,
    mimeType: "application/json",
    maxTimeoutSeconds: PAYMENT_MAX_TIMEOUT_SECONDS,
    extra: { name: "USD Coin", version: "2" }, // EIP-712 domain of Base USDC
  };
  if (opts.outputSchema !== undefined) reqs.outputSchema = opts.outputSchema;
  return reqs;
}

// B1 (docs/BRIEF-X402-SETTLE-HONESTY.md): the facilitator's HTTP status is kept
// beside its parsed body. PayAI's own table says to "read the status and
// response body together" (a JSON 409 or 5xx can carry `success: false`
// without being a verdict), so classifySettle and classifyVerify below never
// read one without the other.
interface FacilitatorAnswer {
  status: number;
  body: Record<string, unknown>;
}

async function facilitator(env: Env, path: "/verify" | "/settle", body: unknown): Promise<FacilitatorAnswer> {
  // A fetch that REJECTS is caught here, on both paths (build review round 1,
  // CODEX HIGH, exchange/REVIEW_x402-settle-honesty-build-2026-09-28.md). A
  // /settle request can be delivered, received and settled with only its
  // answer lost, so a rejection there is an unknown outcome: a SocietyError
  // 502, which settleOrThrow logs as x402_settle_outcome_unknown and which
  // handlePayListing answers with settlement_unconfirmed, keeping its
  // reservation. It used to escape as the runtime's own error, which the router
  // served as a generic 500 on register, patron and listing create. What a /verify
  // failure may truthfully say (gate L2, 2026-09-29): the /verify body IS the full
  // signed authorisation, so it was sent, and "could not be reached" can follow
  // delivery; what is true is that this server never asked the facilitator to SETTLE it.
  let res: Response;
  try {
    res = await fetch(`${env.FACILITATOR_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    const reason = clipReason(e instanceof Error ? e.message : String(e));
    if (path === "/settle") {
      throw new SocietyError(502, `The request to the facilitator's /settle failed in transit (${reason}); it may have been received and settled. Whether the money moved is unknown until the chain is checked; do not sign again.`);
    }
    throw new SocietyError(502, `The payment facilitator could not be reached to verify this payment (${reason}); the request may still have been delivered. ${NEVER_ASKED_TO_SETTLE} Try again later.`);
  }
  // The facilitator answers malformed payloads with 4xx/5xx JSON; only an
  // unparseable response means it is actually down. The wording is
  // path-aware (2026-09-19 exchange, item 4): before /settle nothing was sent
  // that could move money, so "not taken" is true; an unreadable answer to
  // /settle is exactly the case where whether the money moved is UNKNOWN,
  // and the caller (handlePayListing) keeps its reservation and says so.
  // A body that parses but is not a JSON object (null, a string, an array)
  // is no more an answer than one that does not parse (CODEX, build review
  // round 2: a `null` body used to reach `settlement.success` and throw a
  // TypeError, an opaque 500, instead of the unknown-outcome 502).
  let answer: unknown;
  try {
    answer = await res.json();
  } catch {
    answer = undefined;
  }
  if (answer !== null && typeof answer === "object" && !Array.isArray(answer)) return { status: res.status, body: answer as Record<string, unknown> };
  if (path === "/settle") {
    throw new SocietyError(502, `The facilitator's answer to /settle could not be read (HTTP ${res.status}). ${SETTLE_UNKNOWN_TAIL}`);
  }
  throw new SocietyError(502, `The facilitator is unreachable (${res.status}). Your money was not taken. Try again later.`);
}

// A paid act's claim (docs/BRIEF-SETTLEMENT-REPLAY-GUARD.md): the route and the
// business intent it is paying for, plus `finish`, which completes the act from
// its claim row. `finish` is what an identical request does when it meets a
// settled_unbooked claim: the route's own booking, run again from booked_refs.
// It answers a Response when the act is now fully booked, or null when this
// caller could not finish it (the claim answer is served instead).
export interface PaidClaim extends ClaimSpec {
  finish: (row: ClaimRow) => Promise<Response | null>;
}

// `claim` is the settled_unbooked claim row for callers that book with one
// (every route does); `owner` is the lease holder id a caller releases through
// finishUnderOwnLease if booking does not complete.
export type SettleResult =
  | { ok: false; response: Response }
  | { ok: true; payer: string; tx: string; settlement: Record<string, unknown>; claim: ClaimRow | null; owner: string };

// The shared verify+settle core. Returns either a 402 Response to send back
// as-is (no payment attached, an invalid signature, or a settlement the
// facilitator reports as failed, classifySettle rule 7), or a successful
// settlement for the caller to act on. An outcome that is not a verdict is
// thrown (settleOrThrow), never returned as a 402.
//
// afterVerify, if given, runs after the signature is confirmed valid but
// BEFORE the irreversible settle call: the one point in this flow where a
// caller can still bail out for free, because no money has moved yet.
// register-gate.ts uses this for its second handle-availability check
// (architect ruling: one check at 402-issuance, a second immediately
// before settle). If afterVerify throws, it propagates straight out of
// this function and settle() is never called.
// The x402 window every requirement we issue declares (maxTimeoutSeconds): a
// signed authorisation is executable until roughly this long after it was
// issued. listings.ts's UNRESOLVED_AFTER_MS is derived from it, so the two
// cannot drift apart.
export const PAYMENT_MAX_TIMEOUT_SECONDS = 300;

// A4 (docs/BRIEF-SERVER-SIDE-WALLET-PIN.md, CODEX): the decoded payload's
// signed destination and amount must BE the requirements this route issued,
// checked here before /verify. payAndSettle used to forward the payload with
// reqs and trust verdict.isValid, so "the payer signs for payTo" held only if
// the facilitator compared the two. This removes reliance on /verify for the
// payload-to-requirements destination and amount comparison ONLY: signature
// verification and faithful settlement remain facilitator dependencies
// (/settle is still an external call whose reported success the Worker
// trusts). The address is compared case-folded (EIP-55 casing is
// presentation, not identity); the value exactly, as the decimal string the
// x402 "exact" scheme carries (scripts/register-maintainer.mjs
// buildAuthorization + encodePaymentHeader). A missing, malformed or
// wrong-typed authorization refuses: nothing about it is guessed. Pure, so
// every refusal is provable offline; every caller of payAndSettle (patron,
// register, listing create, listing pay) inherits it.
export const PAYMENT_PAYLOAD_MISMATCH = "payment_payload_mismatch";
const shown = (v: unknown) => JSON.stringify(v)?.slice(0, 100) ?? String(v);
export function assertPayloadMatchesRequirements(paymentPayload: unknown, reqs: PaymentRequirements): void {
  const inner = paymentPayload !== null && typeof paymentPayload === "object" ? (paymentPayload as { payload?: unknown }).payload : undefined;
  const auth = inner !== null && typeof inner === "object" ? (inner as { authorization?: unknown }).authorization : undefined;
  if (auth === null || typeof auth !== "object" || Array.isArray(auth)) {
    throw new SocietyError(400, "X-PAYMENT carries no payload.authorization object (the x402 'exact' scheme's signed transfer). Nothing was sent to the facilitator.", PAYMENT_PAYLOAD_MISMATCH);
  }
  const { to, value } = auth as { to?: unknown; value?: unknown };
  if (typeof to !== "string" || to.toLowerCase() !== reqs.payTo.toLowerCase()) {
    throw new SocietyError(400, `The signed authorization pays ${shown(to)}, but this request requires payTo ${reqs.payTo}. Nothing was sent to the facilitator; sign for the requirements this route issued.`, PAYMENT_PAYLOAD_MISMATCH);
  }
  if (typeof value !== "string" || value !== reqs.maxAmountRequired) {
    throw new SocietyError(400, `The signed authorization is for value ${shown(value)}, but this request requires exactly "${reqs.maxAmountRequired}" (atomic USDC, a decimal string). Nothing was sent to the facilitator; sign for the requirements this route issued.`, PAYMENT_PAYLOAD_MISMATCH);
  }
}

// ---------- B2: classifying the /settle answer (docs/BRIEF-X402-SETTLE-HONESTY.md) ----------
//
// Pure, so every rule is provable offline, and called only from settleOrThrow
// below. The rules run in the brief's order and the first match wins; `rule`
// names the one that matched. The label is also what makes rules 1, 2, 3 and 6
// observable at all: rule 7 names four statuses and rule 8 catches everything
// else as unknown, so any one of those four could go and its answers would
// still be unknown, only worded differently.
// Rule 7 carries every condition PayAI documents for a definitive refusal, not
// only the ones rules 1-6 leave unchecked, so a refusal never depends on the
// rules above it staying where they are: a refusal releases a listing's
// reservation, and a wrong one invites a second payment.
export const SETTLEMENT_PENDING = "settlement_pending";
const FACILITATOR_REASON_MAX = 200;
export const clipReason = (v: unknown) => (typeof v === "string" ? v : String(v)).slice(0, FACILITATOR_REASON_MAX);
// Every unknown-outcome message ends with this (gate L3, B8): on register, patron and listing create there
// is no reservation to stop a second signature, so the message is the caller's only guard, and the
// facilitator's own quoted errorReason (up to 200 characters, F5) can say anything, "retry" included.
const SETTLE_UNKNOWN_TAIL = "The settle request was sent; whether the money moved is unknown until the chain is checked; do not sign again.";
// What every /verify failure may truthfully say (gate L2): the /verify request carries the whole signed
// authorisation, so the old claim that nothing which could settle had been sent was false. This server never asked the
// facilitator to settle it.
const NEVER_ASKED_TO_SETTLE = "This server never asked the facilitator to settle this payment.";
export const DUPLICATE_SETTLEMENT = "duplicate_settlement";
// A reason compared the way B8 says: trimmed and case-folded, so " Settlement_Pending " is not a refusal.
const foldReason = (v: unknown): string | null => (typeof v === "string" ? v.trim().toLowerCase() : null);
// How an unknown-outcome message quotes the answer's errorReason: exactly as
// given, never interpreted (build review round 1, F5). A message states the
// status and this, then why the outcome is unknown, and nothing the answer did
// not say.
function givenReason(v: unknown): string {
  if (v === undefined) return "no errorReason";
  if (typeof v !== "string") return `an errorReason that is not a string: ${shown(v)}`;
  if (v.trim().length === 0) return "a blank errorReason";
  return `errorReason: ${clipReason(v)}`;
}

export type SettleVerdict =
  | { kind: "settled"; rule: 4; payer: string; tx: string }
  | { kind: "refused"; rule: 7; status: number; reason: string; error: string }
  | { kind: "unknown"; rule: 1 | 2 | 3 | 4 | 5 | 6 | 8; message: string; broadcastTx?: string };

export function classifySettle(status: number, body: Record<string, unknown>): SettleVerdict {
  // 1. A 5xx, whatever the body says.
  if (status >= 500 && status <= 599) {
    return { kind: "unknown", rule: 1, message: `The facilitator answered /settle with HTTP ${status} (${givenReason(body.errorReason)}). A 5xx answer is not a settlement verdict. ${SETTLE_UNKNOWN_TAIL}` };
  }
  // 2. A 409, whatever the body says. PayAI documents 409 duplicate_settlement
  //    as "the same operation is already in flight or has a replay marker", but
  //    the message quotes only the reason this answer gave (F5).
  if (status === 409) {
    return { kind: "unknown", rule: 2, message: `The facilitator answered /settle with HTTP 409 (${givenReason(body.errorReason)}). A 409 answer is not a settlement verdict. ${SETTLE_UNKNOWN_TAIL}` };
  }
  // 3. No boolean `success` (L-089; wording unchanged).
  if (typeof body.success !== "boolean") {
    return { kind: "unknown", rule: 3, message: `The facilitator's answer to /settle was not a settlement result (no boolean success). ${SETTLE_UNKNOWN_TAIL}` };
  }
  // 4. `success: true` settles on a 2xx status only.
  if (body.success === true) {
    if (status >= 200 && status <= 299) {
      return { kind: "settled", rule: 4, payer: typeof body.payer === "string" ? body.payer : "unknown", tx: typeof body.transaction === "string" ? body.transaction : "" };
    }
    return { kind: "unknown", rule: 4, message: `The facilitator answered /settle with HTTP ${status} and success: true (${givenReason(body.errorReason)}). A success on a status other than 2xx is not a settlement verdict. ${SETTLE_UNKNOWN_TAIL}` };
  }
  const reason = body.errorReason;
  const folded = foldReason(reason);
  // 5. settlement_pending: "It is not a verdict." On EVM `transaction` carries
  //    the broadcast hash when the transaction was already broadcast. Compared after
  //    trim() and case-folding, at ANY status (gate L1, B8): " Settlement_Pending " and
  //    a 400 carrying it are the same non-verdict, never a refusal.
  if (folded === SETTLEMENT_PENDING) {
    const tx = typeof body.transaction === "string" && body.transaction.length > 0 ? body.transaction : undefined;
    return {
      kind: "unknown",
      rule: 5,
      message: `The facilitator has not yet settled this payment (settlement_pending): it may still land on-chain.${tx ? ` It reports the broadcast transaction ${tx}.` : ""} Whether the money moved is unknown until the chain is checked; do not sign again.`,
      ...(tx ? { broadcastTx: tx } : {}),
    };
  }
  // 5b. duplicate_settlement: PayAI documents it only at 409 ("already in flight or has a replay
  //     marker", rule 2), and never as a failure verdict; at any other status it is the same
  //     non-verdict. Read as unknown, as rule 5 reads a pending answer, never as a refusal (L1, B8).
  if (folded === DUPLICATE_SETTLEMENT) {
    return {
      kind: "unknown",
      rule: 5,
      message: `The facilitator answered /settle with HTTP ${status} and the reason duplicate_settlement: a settlement for this payment is already in flight or recorded, and that is not a settlement verdict. ${SETTLE_UNKNOWN_TAIL}`,
    };
  }
  // 6. A failure with no usable reason cannot be classified: errorReason absent,
  //    not a string, or blank after trimming (build review round 1, F3: " "
  //    establishes no recorded failure, so it must never release a reservation).
  if (typeof reason !== "string" || reason.trim().length === 0) {
    return { kind: "unknown", rule: 6, message: `The facilitator answered /settle with HTTP ${status} and success: false (${givenReason(reason)}). A failure without a usable reason cannot be classified. ${SETTLE_UNKNOWN_TAIL}` };
  }
  // 7. The only refusals: "a recorded failure" (200) and "invalid input,
  //    missing/invalid credentials, or a policy refusal" (400, 401, 403), each
  //    with a reason that is not blank.
  if (
    body.success === false &&
    typeof reason === "string" &&
    reason.trim().length > 0 &&
    folded !== SETTLEMENT_PENDING &&
    folded !== DUPLICATE_SETTLEMENT &&
    (status === 200 || status === 400 || status === 401 || status === 403)
  ) {
    const shownReason = clipReason(reason);
    return { kind: "refused", rule: 7, status, reason: shownReason, error: `The facilitator reports that this settlement failed (HTTP ${status}, reason: ${shownReason}). By its account no money moved.` };
  }
  // 8. Anything else: every other 4xx, every 2xx other than 200, any 1xx or 3xx.
  return { kind: "unknown", rule: 8, message: `The facilitator answered /settle with HTTP ${status} and success: false (${givenReason(reason)}). PayAI does not document that combination as a definitive refusal. ${SETTLE_UNKNOWN_TAIL}` };
}

// ---------- B3: classifying the /verify answer (docs/BRIEF-X402-SETTLE-HONESTY.md) ----------
//
// Pure, like classifySettle. When /verify answers, this server has not asked the
// facilitator to settle anything, and every refusal and failure here says exactly
// that (gate L2: the /verify body is the full signed authorisation, so "nothing that
// could settle was sent" was false); what the status adds is whose answer it is. Before this wave any
// answer without `isValid: true` was served as 402 "payment invalid", which
// misnamed a facilitator that refused service (4xx) or failed (5xx) as a fault
// in the payer's signature. `/settle` is never called after rules 1, 3, 4 or 5.
export type VerifyVerdict =
  | { kind: "valid"; rule: 2 }
  | { kind: "invalid"; rule: 3; error: string }
  | { kind: "refused"; rule: 4; error: string }
  | { kind: "failed"; rule: 5; message: string };

const VERIFY_REASON_KEYS = ["invalidReason", "errorReason", "error", "message"] as const;
// The first NON-BLANK string among those keys, clipped to 200 characters, else
// "none given" (build review round 1, F4: an empty or blank string used to be
// taken, masking a real reason in a later key and printing "reason: ").
function verifyReason(body: Record<string, unknown>): string {
  for (const key of VERIFY_REASON_KEYS) {
    const v = body[key];
    if (typeof v === "string" && v.trim().length > 0) return v.slice(0, FACILITATOR_REASON_MAX);
  }
  return "none given";
}

export function classifyVerify(status: number, body: Record<string, unknown>): VerifyVerdict {
  // Rule 1 (a body that is not a JSON object) is facilitator()'s own 502, "Your money was not taken".
  if (status >= 200 && status <= 299) { // verify: rules 2 and 3 read a 2xx only
    if (body.isValid === true) return { kind: "valid", rule: 2 };
    return { kind: "invalid", rule: 3, error: String(body.invalidReason ?? "payment invalid") }; // unchanged
  }
  const reason = verifyReason(body);
  if (status >= 400 && status <= 499) { // verify: rule 4, the facilitator refused
    return { kind: "refused", rule: 4, error: `The payment facilitator refused to verify this payment (HTTP ${status}, reason: ${reason}). ${NEVER_ASKED_TO_SETTLE}` };
  }
  // Rule 5: a 5xx. The brief names only 2xx, 4xx and 5xx; any other final
  // status (1xx, 3xx) takes this same path, filled conservatively: it is no
  // reason to settle, and this server has asked it to settle nothing.
  return { kind: "failed", rule: 5, message: `The payment facilitator failed to verify this payment (HTTP ${status}, reason: ${reason}). ${NEVER_ASKED_TO_SETTLE} Try again later.` };
}

// The /settle leg. Returns a settled or refused verdict with the body it came
// from; every other outcome (a rejected fetch, an unreadable body, an answer
// classifySettle calls unknown) is logged ONCE as x402_settle_outcome_unknown
// and thrown, so no caller can read it as a refusal. When a pending answer
// names its broadcast transaction, the log line carries it as broadcast_tx.
async function settleOrThrow(
  env: Env,
  rpcBody: unknown,
  reqs: PaymentRequirements,
  claimKey?: ClaimKey,
): Promise<{ body: Record<string, unknown>; verdict: Exclude<SettleVerdict, { kind: "unknown" }> }> {
  let broadcastTx: string | undefined;
  try {
    const answer = await facilitator(env, "/settle", rpcBody);
    const verdict = classifySettle(answer.status, answer.body);
    if (verdict.kind === "unknown") {
      broadcastTx = verdict.broadcastTx;
      throw new SocietyError(502, verdict.message);
    }
    return { body: answer.body, verdict };
  } catch (e) {
    console.log(
      JSON.stringify({
        level: "error",
        event: "x402_settle_outcome_unknown",
        resource: reqs.resource,
        pay_to: reqs.payTo,
        amount_atomic: reqs.maxAmountRequired,
        reason: e instanceof Error ? e.message : String(e),
        ...(broadcastTx ? { broadcast_tx: broadcastTx } : {}),
        // The claim's identity (public: it is the authorisation's own from and nonce), never its body (B7).
        ...(claimKey ? { claim_from: claimKey.from, claim_nonce: claimKey.nonce } : {}),
      }),
    );
    throw e;
  }
}

export async function payAndSettle(
  env: Env,
  request: Request,
  reqs: PaymentRequirements,
  afterVerify?: () => Promise<void>,
  claim?: PaidClaim,
): Promise<SettleResult> {
  const paymentHeader = request.headers.get("X-PAYMENT");
  if (!paymentHeader) {
    return {
      ok: false,
      response: Response.json(
        {
          x402Version: 1,
          error: "Payment required. Sign an x402 payment and retry with the X-PAYMENT header.",
          accepts: [reqs],
        },
        { status: 402, headers: { "Access-Control-Allow-Origin": "*" } },
      ),
    };
  }

  let paymentPayload: unknown;
  try {
    paymentPayload = JSON.parse(atob(paymentHeader));
  } catch {
    throw new SocietyError(400, "X-PAYMENT must be base64-encoded JSON (x402 payment payload)");
  }
  assertPayloadMatchesRequirements(paymentPayload, reqs);

  const rpcBody = buildRpcBody(paymentPayload, reqs);

  // The claim's identity (docs/BRIEF-SETTLEMENT-REPLAY-GUARD.md B1/B4a): the signed
  // authorisation's (network, asset, from, nonce), lower-cased, plus the hashes of the
  // exact /settle body and of the business intent. A malformed authorisation is
  // refused here, free, before anything is sent to the facilitator.
  let claimId: ClaimIdentity | null = null;
  if (claim) {
    const { key, validBefore } = claimKeyFromPayload(paymentPayload, reqs);
    claimId = await claimIdentity(key, validBefore, rpcBody, claim);
  }

  // B3: the /verify answer, status and body together (classifyVerify). A
  // failure (5xx) is a 502 that says no money moved; a refusal (4xx) or an
  // invalid payment (2xx without isValid: true) is a 402; only a 2xx with
  // isValid: true goes on towards /settle.
  const checked = await facilitator(env, "/verify", rpcBody);
  const verdict = classifyVerify(checked.status, checked.body);
  if (verdict.kind === "failed") throw new SocietyError(502, verdict.message);
  if (verdict.kind !== "valid") {
    return {
      ok: false,
      response: Response.json(
        { x402Version: 1, error: verdict.error, accepts: [reqs] },
        { status: 402 },
      ),
    };
  }

  if (afterVerify) await afterVerify();

  // B3: the claim is taken after every free business check (afterVerify included,
  // which for pay listing is the reservation) and immediately before /settle. The
  // INSERT is the claim; a conflict is refused with NO /settle call, answered by the
  // existing claim's state. A conflict is RETURNED, never thrown, so a caller that
  // reserved something in afterVerify (pay listing) releases it on the ok:false path
  // instead of keeping it as if a settle had been sent.
  const owner = crypto.randomUUID();
  if (claim && claimId) {
    const taken = await takeClaim(env, claimId, claim, owner, Date.now());
    if (!taken.taken) {
      return { ok: false, response: await respondToExistingClaim(env, taken.row, taken.identical, reqs, claim) };
    }
  }

  // Every unknown /settle outcome is logged here, for every caller (re-gate
  // L1, 2026-09-24): registration, the patron line and listing creation
  // answer a SocietyError 502, which the router serves without logging, so
  // money that did move would otherwise be findable only on the chain. The
  // pay route also logs its own line with the listing's ids.
  //
  // Only a verdict is an answer (docs/BRIEF-X402-SETTLE-HONESTY.md B2; it
  // extends CODEX's build finding 1 of 2026-09-24, L-089, which closed the
  // answer with no boolean `success`). classifySettle reads the HTTP status
  // and the body together, as PayAI's own page says to
  // (https://docs.payai.network/x402/facilitators/capacity-and-limits.md,
  // "Read the status and response body together" and "The settlement_pending
  // response"). A 5xx, a 409 (duplicate_settlement), a body with no boolean
  // `success`, a success on a non-2xx status, a settlement_pending ("It is not
  // a verdict ... the payment may still land on-chain"), a failure with no
  // reason, and every status-and-shape combination PayAI does not document as
  // definitive all take the unknown-outcome path an unreadable body already
  // takes: thrown, logged, never read as a refusal. handlePayListing keeps its
  // reservation (settlement_unconfirmed); the other callers answer 502,
  // "unknown until the chain is checked", instead of a 402 that invites a
  // second payment while the first may still land. A refusal is ONLY
  // `success: false` with a non-empty string errorReason on a 200 (other than
  // settlement_pending: "a recorded failure") or on a 400, 401 or 403
  // ("invalid input, missing/invalid credentials, or a policy refusal"); its
  // 402 names the facilitator's own status and reason.
  let settled: Awaited<ReturnType<typeof settleOrThrow>>;
  try {
    settled = await settleOrThrow(env, rpcBody, reqs, claimId?.key);
  } catch (e) {
    // An unknown outcome leaves the claim `pending` (the money may have moved): record
    // the last thing the facilitator said and let go of the lease so an identical
    // re-send can reconcile at once. Never a state change, never a release of anything.
    if (claimId) {
      const key = claimId.key;
      await quietly("note_unknown", () => noteUnknown(env, key, e instanceof Error ? e.message : String(e), owner, Date.now()));
    }
    throw e;
  }
  if (settled.verdict.kind === "refused") {
    // Rule 7, a recorded refusal: terminal, and the authorisation body is cleared (B7).
    if (claimId) {
      const key = claimId.key;
      const reason = settled.verdict.error;
      await quietly("mark_refused", () => markRefused(env, key, reason, Date.now()));
    }
    return {
      ok: false,
      response: Response.json(
        { x402Version: 1, error: settled.verdict.error, accepts: [reqs] },
        { status: 402 },
      ),
    };
  }

  let row: ClaimRow | null = null;
  if (claimId) {
    try {
      await markSettled(env, claimId.key, settled.verdict.tx, settled.verdict.payer, Date.now());
      row = await getClaim(env, claimId.key);
      if (!row) throw new Error("the claim row is missing after settlement");
    } catch (e) {
      // The money moved and the claim cannot say so. Nothing is booked (every booking
      // step is gated on the claim), so the honest answer is the F7 one: settled, named,
      // do not sign again. The row stays pending; the reconciler re-POSTs the stored body
      // and PayAI serves the cached success, which is how it gets booked.
      console.log(
        JSON.stringify({
          level: "error",
          event: "settlement_claim_unrecorded",
          tx: settled.verdict.tx,
          payer: settled.verdict.payer,
          resource: reqs.resource,
          amount_atomic: reqs.maxAmountRequired,
          claim_from: claimId.key.from,
          claim_nonce: claimId.key.nonce,
          reason: clipReason(e instanceof Error ? e.message : String(e)),
        }),
      );
      throw new SocietyError(
        500,
        `Your payment settled (tx ${settled.verdict.tx}), but the society could not record that it had. Do not sign again: this payment has already moved. This is logged for the maintainer to put right by hand, and the society re-checks unresolved payments once a day. ${SHOWHOME_REPORT_POINTER}`,
      );
    }
  }

  return { ok: true, payer: settled.verdict.payer, tx: settled.verdict.tx, settlement: settled.body, claim: row, owner };
}

// The exact /settle (and /verify) request body for one payment: the decoded payload and
// OUR requirements, never the client's. Its text is what a claim hashes (B1/B4a).
function buildRpcBody(paymentPayload: unknown, reqs: PaymentRequirements) {
  return { x402Version: 1, paymentPayload, paymentRequirements: reqs };
}

// A claim-table write that must never change what the caller is told (the answer is
// already decided): attempted, and on failure logged once, loudly, without the body.
async function quietly(step: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    console.log(JSON.stringify({ level: "error", event: "settlement_claim_write_failed", step, reason: clipReason(e instanceof Error ? e.message : String(e)) }));
  }
}

// B4: what a request is told when its signed authorisation already has a claim. No
// /settle is ever called from here. A request that is not byte- and intent-identical
// is a conflict (B4a). An identical one is answered by the claim's state, and on a
// settled_unbooked claim the route's own `finish` completes the booking under a
// lease (B5); a live lease held by another worker is named, not raced.
async function respondToExistingClaim(env: Env, row: ClaimRow, identical: boolean, reqs: PaymentRequirements, claim: PaidClaim): Promise<Response> {
  if (!identical) return claimResponse(claimAnswer(row, false, reqs));
  if (row.state === "settled_unbooked") {
    const owner = crypto.randomUUID();
    const leased = await acquireLease(env, keyOfRow(row), owner, Date.now());
    if (!leased) return claimResponse(claimAnswer(row, true, reqs, { leaseHeld: true }));
    try {
      const done = await claim.finish(leased);
      if (done) return done;
    } finally {
      await quietly("release_lease", () => releaseLease(env, keyOfRow(row), owner));
    }
    return claimResponse(claimAnswer((await getClaim(env, keyOfRow(row))) ?? row, true, reqs));
  }
  if (row.state === "pending") {
    // B6: the payer's identical re-send may take the lease and run ONE attempt: the chain
    // is asked (two RPCs must agree) and, if the authorisation moved money or may still
    // move it, the stored body is re-POSTed to /settle, as PayAI's own documentation
    // prescribes for learning an outcome. It never asks the payer to sign again.
    const owner = crypto.randomUUID();
    const leased = await acquireLease(env, keyOfRow(row), owner, Date.now());
    if (!leased) return claimResponse(claimAnswer(row, true, reqs, { leaseHeld: true }));
    try {
      const out = await attemptPending(env, leased, owner);
      if (out.kind === "settled") {
        const done = await claim.finish(out.row);
        if (done) return done;
      }
      const fresh = (await getClaim(env, keyOfRow(row))) ?? row;
      return claimResponse(claimAnswer(fresh, true, reqs, out.kind === "unchanged" ? { detail: out.detail } : {}));
    } finally {
      await quietly("release_lease", () => releaseLease(env, keyOfRow(row), owner));
    }
  }
  return claimResponse(claimAnswer(row, true, reqs));
}

// B6, one attempt on a `pending` claim by a holder of its lease. Order matters and "the chain
// decides": (1) read authorizationState(from, nonce) at a two-RPC quorum, no quorum means no
// transition; (2) UNUSED after validBefore, plus a margin, is `expired` (the authorisation can
// no longer move money), never on the clock alone; (3) otherwise, when the authorisation was
// used or can still be used, re-POST the stored body and classify the answer exactly as the
// first /settle was: settled books it, a recorded refusal (rule 7) refuses it, anything else
// leaves it pending. A refusal is not honoured against a spent authorisation: the chain says
// the money moved, so the answers contradict and the row waits for a person.
//
// EXPIRY_MARGIN: `expired` invites a second signature, so it must never be premature. A
// transfer broadcast just before validBefore can be mined a little after it in wall-clock
// terms and an RPC can trail the chain head; the margin covers both (it is the authorisation
// window itself, PAYMENT_MAX_TIMEOUT_SECONDS).
export const RECONCILE_EXPIRY_MARGIN_SECONDS = PAYMENT_MAX_TIMEOUT_SECONDS;

// `fetches` counts the outbound fetches the attempt made (RPC reads and /settle), for the reconciler's meter.
export type AttemptOutcome = ({ kind: "settled"; row: ClaimRow } | { kind: "expired" } | { kind: "refused" } | { kind: "unchanged"; detail: string }) & { fetches: number };

export async function attemptPending(env: Env, row: ClaimRow, owner: string): Promise<AttemptOutcome> {
  if (row.state !== "pending" || row.rpc_body == null) return { kind: "unchanged", detail: "the claim is no longer pending", fetches: 0 };
  const key = keyOfRow(row);
  const nowMs = Date.now();
  const chain = await readAuthorizationState(env, row.asset, row.from_addr, row.nonce);
  if (chain.used === null) return { kind: "unchanged", detail: `The chain could not settle the question (${chain.reason}); nothing was changed.`, fetches: chain.fetches };
  if (chain.used === false && nowMs / 1000 > row.valid_before + RECONCILE_EXPIRY_MARGIN_SECONDS) {
    await markExpired(env, key, nowMs);
    return { kind: "expired", fetches: chain.fetches };
  }
  if (chain.used === false && nowMs / 1000 > row.valid_before) {
    return { kind: "unchanged", detail: "The authorisation is past its validBefore and unused so far; the society waits out a margin before calling it expired.", fetches: chain.fetches };
  }

  const body = JSON.parse(row.rpc_body) as { paymentRequirements: PaymentRequirements };
  let settled: Awaited<ReturnType<typeof settleOrThrow>>;
  try {
    settled = await settleOrThrow(env, body, body.paymentRequirements, key);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    await quietly("note_unknown", () => noteUnknown(env, key, reason, owner, Date.now()));
    return { kind: "unchanged", detail: reason, fetches: chain.fetches + 1 };
  }
  const fetches = chain.fetches + 1;
  if (settled.verdict.kind === "refused") {
    if (chain.used === true) {
      return { kind: "unchanged", detail: "The chain shows this authorisation spent, but the facilitator reports a refusal. The answers contradict; the claim is left pending for a person to decide.", fetches };
    }
    await markRefused(env, key, settled.verdict.error, Date.now());
    return { kind: "refused", fetches };
  }
  const { tx, payer } = settled.verdict;
  if (!(await markSettled(env, key, tx, payer, Date.now()))) {
    // Another worker moved it first: carry on from the row as it now stands.
    const moved = await getClaim(env, key);
    return moved && moved.state === "settled_unbooked" ? { kind: "settled", row: moved, fetches } : { kind: "unchanged", detail: "another worker moved the claim", fetches };
  }
  // The row as markSettled left it (no re-read: a pending row has recorded no booking yet).
  return { kind: "settled", row: { ...row, state: "settled_unbooked", tx, payer, verdict_reason: null }, fetches };
}

// B4, consult-first: a request whose X-PAYMENT already has a claim is answered from the
// claim BEFORE the free checks that would wrongly refuse a replay (register's "handle is
// taken" fires before any 402 is issued, so an identical re-send of a finished
// registration would otherwise read as a stranger asking for a taken handle). Null
// means no header, an unreadable one (payAndSettle reports that), or no claim: carry on.
export async function replayForClaim(env: Env, request: Request, reqs: PaymentRequirements, claim: PaidClaim): Promise<Response | null> {
  const header = request.headers.get("X-PAYMENT");
  if (!header) return null;
  let id: ClaimIdentity;
  try {
    const payload = JSON.parse(atob(header)) as unknown;
    const { key, validBefore } = claimKeyFromPayload(payload, reqs);
    id = await claimIdentity(key, validBefore, buildRpcBody(payload, reqs), claim);
  } catch {
    return null;
  }
  const row = await getClaim(env, id.key);
  if (!row) return null;
  return respondToExistingClaim(env, row, row.route === claim.route && sameRequest(row, id), reqs, claim);
}

// Runs a route's booking for the request that holds the claim's lease. If it throws,
// the lease is let go first, so the payer's identical re-send is not told "another
// attempt is in progress" by a request that has already failed.
export async function finishUnderOwnLease<T>(env: Env, result: Extract<SettleResult, { ok: true }>, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (result.claim) {
      const key = keyOfRow(result.claim);
      await quietly("release_lease", () => releaseLease(env, key, result.owner));
    }
    throw e;
  }
}

// The ledger row a claim recorded, for the receipt a response carries.
export async function ledgerReceipt(env: Env, ledgerId: number): Promise<{ prev_hash: string; hash: string }> {
  const r = await env.DB.prepare("SELECT prev_hash, hash FROM ledger WHERE id = ?").bind(ledgerId).first<{ prev_hash: string; hash: string }>();
  if (!r) throw new Error(`ledger row ${ledgerId} recorded in the claim does not exist`);
  return r;
}

// F7 (docs/CHECKPOINT-X402-SETTLE-HONESTY.md, build review round 2, CODEX HIGH):
// the treasury ledger line that registration, the patron door and listing
// creation each write once payAndSettle has returned ok. The money has moved by
// then, so a failure here is the one place a caller could be told to sign again
// for a payment that already landed. appendChained's own exhaustion error says
// "retrying may succeed" (a 503 after four UNIQUE conflicts), and any other
// throw reached the router as its generic 500; either way a retry needs a fresh
// signature, which is a second payment, and nothing named the settled
// transaction. So every failure of the append becomes ONE honest 500 that says
// the payment settled, names its transaction and says not to sign again, and is
// logged once with the payer, the transaction and the amount: the router serves
// a SocietyError without logging, and the maintainer's wake reads logs, not
// whichever client happened to be watching the response.
//
// The inner error's text goes to the log only, clipped, and never into the
// message the caller reads: appendChained's says "retrying may succeed". A
// caller runs this before anything else it writes for the payment (registration
// before the citizen is created, listing creation before the listing row), so
// neither leaves a half-made record behind; each route's own later
// paid-but-failed handling is unchanged.
// How a payer whose money moved, and who is not a citizen, reaches the maintainer (gate M1).
// One literal: every settled-but-incomplete message of this file interpolates it.
const SHOWHOME_REPORT_POINTER =
  "To add your own report, leave a free showhome note naming this tx: POST /api/showhome/enter (any label that is not a citizen handle), then POST /api/showhome/note.";

export type SettledPaymentRoute = "registration" | "patron" | "listing_fee";

// With `claim` (every route does), the ledger row is written as that claim's booking
// step (B5a/B5c): ONE batch with the UPDATE that records its id in booked_refs,
// gated on the claim still being settled_unbooked with no ledger row recorded. A step
// that finds the row already recorded returns the recorded row, so a finisher that
// runs twice books the treasury line once. `final` moves the claim to `booked` in the
// same batch, for a route whose ledger line is its last write.
export async function recordSettledPayment(
  env: Env,
  route: SettledPaymentRoute,
  settled: { payer: string; tx: string },
  amountCents: number,
  row: ChainRow,
  claim?: { key: ClaimKey; final: boolean },
): Promise<{ prev_hash: string; hash: string }> {
  try {
    if (!claim) return await appendChained(env.DB, "ledger", row);
    // The hash this call's own statement carries (the last attempt's, if the head moved and
    // the step was rebuilt): when the batch recorded it, that IS the row's receipt, with no
    // read-back (the reconciler's subrequest budget is priced on it).
    let built = null as { prev_hash: string; hash: string } | null;
    const { applied } = await runBookingStep(
      env,
      claim.key,
      {
        ref: "ledger_id",
        final: claim.final,
        chain: "ledger",
        statements: async (gate) => {
          const b = await appendChainedStmt(env.DB, "ledger", row, gate);
          built = { prev_hash: b.prev_hash, hash: b.hash };
          return [b.stmt];
        },
      },
      Date.now(),
    );
    if (applied && built) return built;
    // Not applied: another writer already recorded the line (take theirs), or the claim is not
    // settled_unbooked (nothing was written), which is a failure to book, never a silent success.
    const now = await getClaim(env, claim.key);
    const ledgerId = now ? refsOf(now).ledger_id : undefined;
    if (ledgerId == null) throw new Error("the claim is not settled_unbooked: no treasury line was recorded for it");
    return await ledgerReceipt(env, ledgerId);
  } catch (e) {
    console.log(
      JSON.stringify({
        level: "error",
        event: "payment_settled_unrecorded",
        route,
        payer: settled.payer,
        tx: settled.tx,
        amount_cents: amountCents,
        reason: clipReason(e instanceof Error ? e.message : String(e)),
      }),
    );
    throw new SocietyError(
      500,
      `Your $${(amountCents / 100).toFixed(2)} payment settled (tx ${settled.tx}), but the society could not record it in its treasury ledger. Do not sign again: this payment has already moved. This is logged for the maintainer to put right by hand. ${SHOWHOME_REPORT_POINTER}`,
    );
  }
}

// F9 (docs/CHECKPOINT-X402-SETTLE-HONESTY.md, build review round 3, CODEX MEDIUM): the
// X-PAYMENT-RESPONSE header carries the facilitator's settlement body. btoa applied
// straight to that JSON text throws on any character above U+00FF, so a successful
// settlement that merely contained one (a name, a note) became a generic 500 AFTER the
// money moved and was booked. The text is encoded as UTF-8 bytes first and those bytes
// are base64'd, so the header is ASCII whatever the body holds. For pure-ASCII input
// the output is byte-identical to the old encoding; a client reads it back by decoding
// base64 to bytes and the bytes as UTF-8.
//
// F10 (exchange 2026-09-29, CODEX round 1, MEDIUM): building the header must also never
// throw or change the outcome. JSON.stringify recurses, so a valid settlement body with
// deeply nested arrays (JSON.parse accepts 20,000 levels) threw RangeError here and the
// patron route answered a generic 500 with the ledger row already committed; a very
// large body would also make a huge header. So the whole encoding sits in a try/catch,
// and a header longer than PAYMENT_RESPONSE_HEADER_MAX is refused: either way the
// helper returns null, logs ONE warn line (warn, not error: the payment succeeded and
// the body already names the tx), and every caller omits the header and serves its
// normal status and body.
export const PAYMENT_RESPONSE_HEADER_MAX = 8192;

export function encodePaymentResponseHeader(settlement: unknown, ctx: { route: string; tx: string }): string | null {
  const omitted = (reason: string): null => {
    console.log(JSON.stringify({ level: "warn", event: "payment_response_header_omitted", route: ctx.route, tx: ctx.tx, reason }));
    return null;
  };
  let encoded: string;
  try {
    const bytes = new TextEncoder().encode(JSON.stringify(settlement));
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    encoded = btoa(binary);
  } catch (e) {
    return omitted(`unencodable: ${clipReason(e instanceof Error ? e.message : String(e))}`);
  }
  if (encoded.length > PAYMENT_RESPONSE_HEADER_MAX) return omitted(`too large: ${encoded.length} characters`);
  return encoded;
}

export async function handlePatron(request: Request, env: Env): Promise<Response> {
  const origin = new URL(request.url).origin;
  const reqs = buildPaymentRequirements(env, {
    resource: `${origin}/api/patron`,
    description:
      "Inscribe one line (≤140 chars) in the Commonhold public ledger, permanently. $1 USDC on Base. This is how the society pays its rent.",
    priceAtomic: PRICE_ATOMIC,
  });

  let inscription = "";
  try {
    const b = (await request.json()) as Record<string, unknown>;
    if (typeof b.message === "string") inscription = b.message.trim().slice(0, MAX_INSCRIPTION);
  } catch {
    /* a patron may pay in silence */
  }

  const line = inscription || "(a patron who paid in silence)";
  const claim: PaidClaim = { route: "patron", intent: { line }, finish: (row) => finishPatron(env, row, null) };
  // B4: a header that already has a claim is answered from it, before /verify spends the
  // facilitator's credits on a replay.
  const replay = await replayForClaim(env, request, reqs, claim);
  if (replay) return replay;
  const result = await payAndSettle(env, request, reqs, undefined, claim);
  if (!result.ok) return result.response;
  return finishUnderOwnLease(env, result, () => finishPatron(env, result.claim as ClaimRow, result.settlement));
}

// The reconciler's entry point for a settled patron claim (src/settlement-reconcile.ts).
export async function finishPatronBooking(env: Env, row: ClaimRow): Promise<void> {
  await finishPatron(env, row, null);
}

// The patron door's whole paid act: one treasury line. Reads the claim, writes the line
// as the claim's final booking step unless one is already recorded, and answers as the
// first request would. `settlement` is the facilitator's body when the caller has it (the
// request that settled), and null on a resumed booking, which then omits the
// X-PAYMENT-RESPONSE header it has no body for.
async function finishPatron(env: Env, row: ClaimRow, settlement: Record<string, unknown> | null): Promise<Response> {
  const line = String(JSON.parse(row.intent_json).line);
  const payer = row.payer ?? "unknown";
  const tx = row.tx ?? "";
  const ledgerId = refsOf(row).ledger_id;
  let sealed: { prev_hash: string; hash: string };
  if (ledgerId == null) {
    const now = Date.now();
    sealed = await recordSettledPayment(
      env,
      "patron",
      { payer, tx },
      PRICE_CENTS,
      {
        entry_date: new Date(now).toISOString().slice(0, 10),
        description: `patron ${payer}: "${line}"; tx ${tx}`,
        amount_cents: PRICE_CENTS,
        created_at: now,
      },
      { key: keyOfRow(row), final: true },
    );
  } else {
    sealed = await ledgerReceipt(env, ledgerId);
  }

  const paymentResponse = settlement ? encodePaymentResponseHeader(settlement, { route: "patron", tx }) : null;
  return Response.json(
    {
      thanks: "Your line is in the books, permanently: GET /treasury",
      inscription: line,
      payer,
      transaction: tx,
      network: "base",
      // 'Permanently' is a strong word for a row in someone else's database.
      // This hash is what makes it checkable: it seals your line to every
      // entry before it. Keep it. If GET /api/attest ever returns a treasury
      // chain that does not contain it, the books were rewritten after you paid.
      receipt: sealed.hash,
      verify: "GET /api/attest",
    },
    {
      status: 200,
      headers: {
        "Access-Control-Allow-Origin": "*",
        ...(paymentResponse !== null ? { "X-PAYMENT-RESPONSE": paymentResponse } : {}),
      },
    },
  );
}
