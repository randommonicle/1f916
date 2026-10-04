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
  contradictionAnswer,
  getClaim,
  isChainSpent,
  isContradicted,
  isHandleTaken,
  isListingNotPaying,
  keyOfRow,
  markChainSpent,
  markContradiction,
  markExpired,
  markRefused,
  markSettled,
  noteUnknown,
  reconcileTail,
  refsOf,
  releaseLease,
  leaseHeldByAnother,
  runBookingStep,
  SHOWHOME_REPORT_POINTER,
  sameRequest,
  stepGatedOutByLease,
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

// C1 (docs/REVIEW-SETTLEMENT-REPLAY-GUARD-GATE-2026-09-30.md, M1): the facilitator fetch is BOUNDED, because the request that takes a claim
// holds its lease for CLAIM_LEASE_TTL_MS (180 s) and, with no bound, a /settle that ran past it let a re-send or the reconciler take the
// lease while this request was still live (three false-answer outcomes, all documented in the gate record).
//
//   /settle 120 s: above PayAI's documented ~100 s wait before it answers settlement_pending
//   (https://docs.payai.network/x402/facilitators/capacity-and-limits.md, read 2026-09-30), below the lease. A /settle that times out is an
//   UNKNOWN outcome by the path a rejected fetch already takes: the claim stays pending, the lease is released (noteUnknown), the answer
//   says "do not sign again", and the reconciler or the payer's identical re-send resolves it from the chain.
//   /verify 30 s: a signature and balance check with NO claim and NO lease behind it (the claim is taken after it), safe to retry, so it
//   fails fast; 30 s is well above any normal check and well below a payer's patience. It takes the existing verify-transit path: this
//   server never asked the facilitator to settle.
//
// THE INVARIANT, kept in one place: the lease must outlive the longest thing the lease holder does after taking it, which is the /settle
// wait plus the booking that follows (markSettled and the route's booking steps, about twenty D1 statements; 40 s is a generous allowance).
// test/settlement-replay-timeout-d1.test.ts asserts FACILITATOR_SETTLE_TIMEOUT_MS + CLAIM_BOOKING_ALLOWANCE_MS < CLAIM_LEASE_TTL_MS, so an
// edit of any of the three cannot silently reopen M1.
export const FACILITATOR_SETTLE_TIMEOUT_MS = 120_000;
export const FACILITATOR_VERIFY_TIMEOUT_MS = 30_000;
export const CLAIM_BOOKING_ALLOWANCE_MS = 40_000;

// The bound actually applied: the built-in one, or a SHORTER positive number from the Env (never longer).
export function facilitatorTimeoutMs(env: Env, path: "/verify" | "/settle"): number {
  const ceiling = path === "/settle" ? FACILITATOR_SETTLE_TIMEOUT_MS : FACILITATOR_VERIFY_TIMEOUT_MS;
  const raw = path === "/settle" ? env.FACILITATOR_SETTLE_TIMEOUT_MS : env.FACILITATOR_VERIFY_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(n, ceiling) : ceiling;
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
  // The timer covers the answer's BODY as well as its headers (an abort during the body read makes res.json() throw, which the unreadable-body
  // path below already serves as an unknown /settle outcome), and is cleared only once that read is done.
  const timeoutMs = facilitatorTimeoutMs(env, path);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  let res: Response;
  try {
    res = await fetch(`${env.FACILITATOR_URL}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const reason = timedOut ? `no answer within ${Math.round(timeoutMs / 100) / 10} s` : clipReason(e instanceof Error ? e.message : String(e));
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
  } finally {
    clearTimeout(timer);
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
  // `owner` is the id of the lease holder doing the finishing (R1): every booking write it makes carries it, so a holder whose lease was
  // taken by another writes nothing.
  finish: (row: ClaimRow, owner: string) => Promise<Response | null>;
}

// `claim` is the settled_unbooked claim row for callers that book with one
// (every route does); `owner` is the lease holder id a caller releases through
// finishUnderOwnLease if booking does not complete.
// `keepReservation` (R2b, gate C2): set on an ok:false answer given AFTER /settle said settled, when the claim had moved under this request. The money
// has moved or may have, and another holder may still be booking it, so a caller that reserved something in afterVerify (pay listing) must NOT release it.
export type SettleResult =
  | { ok: false; response: Response; keepReservation?: true }
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
    // L1 (gate, 2026-09-30): a claim INSERT that THROWS (a database error, not a key conflict) after afterVerify reserved something leaves
    // that reservation with no claim behind it, and, reaching handlePayListing's catch, would be served as "the facilitator may have moved
    // the money" though no /settle was sent. It is returned as a not-sent ok:false instead, exactly as a conflict is, so the pay route
    // releases its own reservation (B3: "an explicit revert of the reservation before rethrowing").
    let taken: Awaited<ReturnType<typeof takeClaim>>;
    try {
      taken = await takeClaim(env, claimId, claim, owner, Date.now());
    } catch (e) {
      console.log(
        JSON.stringify({
          level: "error",
          event: "settlement_claim_not_taken",
          resource: reqs.resource,
          amount_atomic: reqs.maxAmountRequired,
          claim_from: claimId.key.from,
          claim_nonce: claimId.key.nonce,
          reason: clipReason(e instanceof Error ? e.message : String(e)),
        }),
      );
      return {
        ok: false,
        response: Response.json(
          {
            error:
              "The society could not record a claim for this payment (a database error), so nothing was sent to the facilitator's /settle and nothing was charged. Nothing was reserved or created by this request. Try again later: the same signed authorisation has not been used.",
            code: "settlement_claim_unavailable",
          },
          { status: 503, headers: { "Access-Control-Allow-Origin": "*" } },
        ),
      };
    }
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
      let wrote = false;
      let threw = false;
      try {
        wrote = await markRefused(env, key, reason, owner, Date.now());
      } catch (e) {
        threw = true;
        console.log(JSON.stringify({ level: "error", event: "settlement_claim_write_failed", step: "mark_refused", reason: clipReason(e instanceof Error ? e.message : String(e)) }));
      }
      if (!wrote || threw) {
        // R1: another holder moved the claim, or holds a live lease on it, while this request's /settle was in flight. This request's refusal is
        // then not the claim's answer: answer from the claim, never "refused, sign a fresh one" over a payment another holder may have settled.
        // CODEX M3-build r1 HIGH (pre-existing since M2): a THROWN markRefused is no refusal recorded either. It used to skip this re-read and
        // fall through to the 402 below, which releases pay listing's reservation, so a refusal could re-open a listing whose claim another
        // holder had settled. Now it is re-read like any unwritten refusal; a re-read that throws, or finds no row, is an unknown outcome
        // (thrown, so pay listing keeps its reservation: settlement_unconfirmed); only a claim that reads `refused` lets the 402 stand.
        // CODEX M3-build r2 (1): ...and only an UNSTAMPED one. A refused claim stamped with a settlement contradiction (another holder's re-POST read a
        // success after the refusal) is answered from the claim, the contradiction's 500, and pay listing keeps its reservation: the money may have moved.
        if (threw) await quietly("release_lease", () => releaseLease(env, key, owner));
        const now = await getClaim(env, key);
        if (!now) throw new Error("the settlement claim could not be read back after its refusal write; the outcome is unknown");
        if (now.state !== "refused" || isContradicted(now)) {
          return { ok: false, keepReservation: true, response: await answerFromMovedClaim(env, now, reqs, claim as PaidClaim, null, owner) };
        }
      }
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
    let wrote = false;
    try {
      // R2b (gate C2): markSettled's `false` means another holder moved the claim, or holds a live lease on it, while this request's /settle was in
      // flight (C1 bounds that wait below the lease; R1 makes the claim's own conditions enforce it). This request then finishes on NOTHING it
      // computed: it re-reads the claim and answers from its state (see answerFromMovedClaim below).
      wrote = await markSettled(env, claimId.key, settled.verdict.tx, settled.verdict.payer, owner, Date.now());
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
      // Let go of the lease: the answer below tells the payer a re-send re-checks it, and a re-send must not meet a live lease held by this dead request.
      const heldKey = claimId.key;
      await quietly("release_lease", () => releaseLease(env, heldKey, owner));
      throw new SocietyError(
        500,
        `Your payment settled (tx ${settled.verdict.tx}), but the society could not record that it had. Do not sign again: this payment has already moved. This is logged for the maintainer to put right by hand. ${reconcileTail(claim?.route ?? "register")} ${SHOWHOME_REPORT_POINTER}`,
      );
    }
    if (!wrote && row) {
      return { ok: false, keepReservation: true, response: await answerFromMovedClaim(env, row, reqs, claim as PaidClaim, { tx: settled.verdict.tx, payer: settled.verdict.payer }) };
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
  // F1: a registration whose handle was taken after payment is answered, never re-attempted (no retry can book it). C5: so is a bounty payment whose listing is no longer
  // 'paying'. C4 (option B): so is a STOPPED claim (the chain reads its authorisation used and a person must look), before any lease is taken or any fetch is made.
  if (isHandleTaken(row) || isListingNotPaying(row) || isChainSpent(row)) return claimResponse(claimAnswer(row, true, reqs));
  if (row.state === "settled_unbooked") {
    const owner = crypto.randomUUID();
    const leased = await acquireLease(env, keyOfRow(row), owner, Date.now());
    if (!leased) return claimResponse(claimAnswer(row, true, reqs, { leaseHeld: true }));
    try {
      const done = await claim.finish(leased, owner);
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
      if (out.kind === "contradiction") return contradictionResponse(out.tx, out.state);
      if (out.kind === "settled") {
        const done = await claim.finish(out.row, owner);
        if (done) return done;
      }
      if (out.kind === "unchanged" && out.held) {
        // CODEX M3-build r2 (2), the gate's LOW-1 (severity upgraded): a held success is never discarded into a terminal row's 402 (holdSuccessAgainstTerminal).
        const held = await holdSuccessAgainstTerminal(env, keyOfRow(row), out.held);
        if (held.contradicted) return contradictionResponse(out.held.tx, held.contradicted);
        return claimResponse(claimAnswer(held.fresh ?? row, true, reqs, { detail: out.detail, settledTx: out.held.tx }));
      }
      const fresh = (await getClaim(env, keyOfRow(row))) ?? row;
      return claimResponse(claimAnswer(fresh, true, reqs, out.kind === "unchanged" ? { detail: out.detail } : {}));
    } finally {
      await quietly("release_lease", () => releaseLease(env, keyOfRow(row), owner));
    }
  }
  return claimResponse(claimAnswer(row, true, reqs));
}

// R2b (gate C2, docs/REVIEW-SETTLEMENT-REPLAY-GUARD-GATE-2026-09-30.md): this request's own write to the claim (markSettled, or markRefused for a refusal it
// read) was refused because the claim moved under it: another holder moved it, or holds a live lease on it. Nothing this request computed is the claim's
// answer, so it re-reads the claim and answers from its state, as an identical replay would:
//   - booked, or settled_unbooked: the replay answer (respondToExistingClaim: the booked 409, the handle-taken 409, or, on a settled_unbooked claim whose
//     lease is free, the same finish a re-send runs; under another holder's live lease, "the booking is not finished, do not sign again");
//   - pending: the existing unknown-outcome answer, "do not sign again", under another live lease;
//   - refused or expired when /settle said SETTLED (`settled` is given): the two records contradict. The money may have moved and no automatic step
//     resolves a terminal claim, so this is ONE error-level line for the maintainer and an answer that never says nothing was charged;
//   - refused or expired when this request itself read a refusal: the ordinary replay answer (the claim and the refusal agree).
// The ONE place the contradiction is logged and answered (gate C2; fix pass 4 H2): the facilitator reported a settlement, and the society's own
// claim for the same authorisation is refused or expired. Used by payAndSettle (this request's own /settle) and by attemptPending (a re-send's or the
// reconciler's re-POST), so the two cannot drift. The money may have moved and no automatic step re-examines a terminal claim: ONE error-level line
// for the maintainer, and an answer that never invites a second signature and never says nothing was charged.
function logSettlementContradiction(row: Pick<ClaimRow, "from_addr" | "nonce">, state: string, settled: { tx: string; payer: string }, req: { resource: string; maxAmountRequired: string }): void {
  console.log(
    JSON.stringify({
      level: "error",
      event: "settlement_contradiction",
      payer: settled.payer,
      tx: settled.tx,
      resource: req.resource,
      amount_atomic: req.maxAmountRequired,
      state,
      claim_from: row.from_addr,
      claim_nonce: row.nonce,
    }),
  );
}

// C2: a facilitator success verdict this call holds could not be written to a claim that is still pending under another holder's lease (answerFromMovedClaim, and
// attemptPending's re-read). ONE error-level line carries the tx, so a person can still book it if the holder meets C1 or the facilitator's recovery record expires.
function logSettlementSuccessUnrecorded(row: Pick<ClaimRow, "from_addr" | "nonce" | "state">, settled: { tx: string; payer: string }, req: { resource: string; maxAmountRequired: string }): void {
  console.log(
    JSON.stringify({
      level: "error",
      event: "settlement_success_unrecorded",
      tx: settled.tx,
      payer: settled.payer,
      resource: req.resource,
      amount_atomic: req.maxAmountRequired,
      claim_from: row.from_addr,
      claim_nonce: row.nonce,
      state: row.state,
    }),
  );
}

// C1: the log line AND the stamp, so the two contradiction branches (this request's own /settle, an attempt's re-POST) cannot drift. The stamp makes every
// LATER identical replay of the terminal row read the contradiction (claimAnswer) instead of a 402 with fresh accepts. It must never change what THIS caller is
// told, so a failed stamp is logged by `quietly` and the answer is unchanged.
async function recordContradiction(env: Env, row: ClaimRow, state: string, settled: { tx: string; payer: string }, req: { resource: string; maxAmountRequired: string }): Promise<void> {
  logSettlementContradiction(row, state, settled, req);
  await quietly("mark_contradiction", () => markContradiction(env, keyOfRow(row), settled.tx, Date.now()));
}

// A facilitator SUCCESS an attempt holds but could not write: the claim was pending under another holder (attemptPending's moved-pending branch).
export type HeldSuccess = { tx: string; payer: string; req: { resource: string; maxAmountRequired: string } };

// CODEX M3-build r2 (2) and its r4 follow-up (exchange/REVIEW_paid-path-m3-r4-correctness-2026-10-04.md): after an attempt that HOLDS a success, the claim is
// read once more; if the other holder has since made it refused or expired, the success is recorded as the contradiction (log line and stamp) instead of being
// discarded, so neither this caller nor a later identical replay of the row serves a 402 with fresh accepts. Used by the re-send answer (respondToExistingClaim)
// and the scheduled reconciler, so the two cannot drift. A window after this read stays open in both; the settlement_success_unrecorded line names the tx.
// Cost: one read, plus the stamp when terminal (the reconciler's row stays well inside RECONCILE_ROW_WORST_CASE: this branch books nothing).
//
// DEFERRED-DURABLE-HELD-SUCCESS (brief R2-2; the agreed residual of exchange/REVIEW_paid-path-m3-r4-correctness-2026-10-04.md): a terminal write that lands AFTER the read
// below and BEFORE the caller releases its lease stays unstamped. The complete remedy is durable success evidence on the PENDING row that markRefused and markExpired respect.
// It is its own wave: it needs (1) a migration (a column the held-success path writes; today only markSettled writes tx), (2) an atomic contract for BOTH orderings
// (evidence first: refusal and expiry write nothing; terminal first: the evidence writer stamps a contradiction and handles zero changes), (3) the empty-tx success
// (a success whose tx is ""), (4) replay behaviour for a row carrying evidence, (5) migration ordering against the worker deploy, (6) tests for every one of those.
export async function holdSuccessAgainstTerminal(env: Env, key: ClaimKey, held: HeldSuccess): Promise<{ contradicted: "refused" | "expired" | null; fresh: ClaimRow | null }> {
  const fresh = await getClaim(env, key);
  if (fresh && (fresh.state === "refused" || fresh.state === "expired")) {
    await recordContradiction(env, fresh, fresh.state, { tx: held.tx, payer: held.payer }, held.req);
    return { contradicted: fresh.state, fresh };
  }
  return { contradicted: null, fresh };
}

function contradictionResponse(tx: string, state: string): Response {
  return claimResponse(contradictionAnswer(tx, state));
}

async function answerFromMovedClaim(
  env: Env,
  row: ClaimRow,
  reqs: PaymentRequirements,
  claim: PaidClaim,
  settled: { tx: string; payer: string } | null,
  // Gate C2 (3 Oct): the refusal branch passes its own owner, so "another attempt is in progress" is said only when ANOTHER holder's lease is live.
  // After a thrown refusal write this request released its own lease, and nobody may hold one. Other callers keep the old answer.
  owner?: string,
): Promise<Response> {
  if (settled && (row.state === "refused" || row.state === "expired")) {
    await recordContradiction(env, row, row.state, settled, reqs);
    return contradictionResponse(settled.tx, row.state);
  }
  if (row.state === "pending") {
    // C2 (re-gate LOW-1(b)): this request's /settle said SUCCESS but the claim is pending under another holder, so nothing here records the tx. It is
    // logged once (the one place a person can still find it) and the answer names it. It is NOT written to the pending row: markSettled is the only writer
    // of `tx`, and the holder that has the lease will either book (the facilitator's cached success) or meet C1.
    if (settled) {
      logSettlementSuccessUnrecorded(row, settled, reqs);
      return claimResponse(claimAnswer(row, true, reqs, { leaseHeld: true, settledTx: settled.tx }));
    }
    return claimResponse(claimAnswer(row, true, reqs, { leaseHeld: owner === undefined ? true : leaseHeldByAnother(row, owner, Date.now()) }));
  }
  return respondToExistingClaim(env, row, true, reqs, claim);
}

// R2a/R3 (gate C2): a finisher whose OWN booking step did not apply (another holder recorded it, or took the lease, so this call's batch wrote nothing)
// answers from the claim exactly as an identical replay would: booked gives the replay answer; still settled_unbooked under another holder gives "the
// booking is not finished, do not sign again". It never builds an answer from values it computed for a step that wrote nothing (the register finisher's
// fresh `secret`, whose hash the database does not hold). It lets go of its own lease first (a no-op unless it still holds one), so a re-send is not told
// to wait for a request that has already answered.
export async function answerFromClaim(env: Env, key: ClaimKey, owner: string): Promise<Response> {
  await quietly("release_lease", () => releaseLease(env, key, owner));
  const row = await getClaim(env, key);
  if (!row) throw new SocietyError(503, "The payment claim could not be read back. Do not sign again: this payment may already have moved.");
  return claimResponse(claimAnswer(row, true, undefined));
}

// B6, one attempt on a `pending` claim by a holder of its lease. Order matters and "the chain
// decides": (1) read authorizationState(from, nonce) at a two-RPC quorum, no quorum means no
// transition; (2) UNUSED after validBefore, plus a margin, is `expired` (the authorisation can
// no longer move money), never on the clock alone; (3) otherwise, when the authorisation was
// used or can still be used, re-POST the stored body and classify the answer as the
// first /settle was: settled books it; anything else leaves it pending. A recorded refusal (rule 7) is NOT honoured on this path (H2): against a spent authorisation the chain
// says the money moved, so the answers contradict and the claim is stamped and stopped for a person (C4, option B); against an unused one an earlier attempt's transfer may
// still be mined, so the claim stays pending until the chain shows it used or provably expired. Only payAndSettle's first /settle writes `refused`.
//
// EXPIRY_MARGIN: `expired` invites a second signature, so it must never be premature. A
// transfer broadcast just before validBefore can be mined a little after it in wall-clock
// terms and an RPC can trail the chain head; the margin covers both (it is the authorisation
// window itself, PAYMENT_MAX_TIMEOUT_SECONDS).
export const RECONCILE_EXPIRY_MARGIN_SECONDS = PAYMENT_MAX_TIMEOUT_SECONDS;

// `fetches` counts the outbound fetches the attempt made (RPC reads and /settle), for the reconciler's meter.
// `contradiction` (fix pass 4, H2): the facilitator said settled but another holder had already made the claim `refused` or `expired`. The line is logged
// by attemptPending; the caller answers with contradictionResponse (a re-send) or counts it separately (the reconciler), never as booked, resolved or a 402.
export type AttemptOutcome = (
  | { kind: "settled"; row: ClaimRow }
  | { kind: "expired" }
  | { kind: "unchanged"; detail: string; held?: HeldSuccess }
  | { kind: "contradiction"; tx: string; state: "refused" | "expired" }
  // C4, option B: THIS call stamped the claim (CHAIN_SPENT_MARKER) and stopped it: the chain reads the authorisation used and a person must look. The lease is cleared by the stamp.
  | { kind: "stopped" }
) & { fetches: number };

export async function attemptPending(env: Env, row: ClaimRow, owner: string): Promise<AttemptOutcome> {
  if (row.state !== "pending" || row.rpc_body == null) return { kind: "unchanged", detail: "the claim is no longer pending", fetches: 0 };
  // A3: a stopped row is never read, re-POSTed or written again (no fetch, no D1 write); it waits for a person.
  if (isChainSpent(row)) return { kind: "unchanged", detail: "the claim is stopped for a person to check", fetches: 0 };
  const key = keyOfRow(row);
  const nowMs = Date.now();
  const chain = await readAuthorizationState(env, row.asset, row.from_addr, row.nonce);
  if (chain.used === null) return { kind: "unchanged", detail: `The chain could not settle the question (${chain.reason}); nothing was changed.`, fetches: chain.fetches };
  if (chain.used === false && nowMs / 1000 > row.valid_before + RECONCILE_EXPIRY_MARGIN_SECONDS) {
    // C6 (first-gate L5, A4): `expired` invites a second signature, so the Worker's clock alone must never decide it: the chain's own clock must agree. Only on this branch (so an
    // ordinary poll costs nothing extra) the authorisation is read AGAIN at a quorum of two RPCs, each at its own latest block, and "unused" counts only from a block whose timestamp
    // is past validBefore + margin (an RPC that trails the chain head answers from an older block and is no answer). It is read again, not trusted from above: the first read
    // was at a block of unknown time, and an authorisation read as unused there could have been mined since.
    const proof = await readAuthorizationState(env, row.asset, row.from_addr, row.nonce, { pastTimestamp: row.valid_before + RECONCILE_EXPIRY_MARGIN_SECONDS });
    const fetches = chain.fetches + proof.fetches;
    if (proof.used === null) {
      return { kind: "unchanged", detail: `The wall clock says this authorisation has expired, but the chain's own clock has not confirmed it (${proof.reason}); nothing was changed.`, fetches };
    }
    if (proof.used === true) {
      return { kind: "unchanged", detail: "The authorisation was spent while the society was confirming its expiry; the next attempt re-checks it as used.", fetches };
    }
    if (!(await markExpired(env, key, owner, nowMs, row))) return { kind: "unchanged", detail: "another worker moved the claim", fetches };
    return { kind: "expired", fetches };
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
      // C4, option B: the chain reads the nonce used and the facilitator answers a recorded refusal. The two answers contradict; the claim is STOPPED (stamped, never refused: the
      // money may have moved) for a person to decide. DEFERRED-C4-OPTION-A-RECEIPT: option A (book from the transaction's own receipt) is not built in this wave.
      if (!(await markChainSpent(env, key, settled.verdict.error, owner, Date.now()))) return { kind: "unchanged", detail: "another worker moved the claim", fetches };
      console.log(
        JSON.stringify({
          level: "error",
          event: "settlement_chain_spent_stopped",
          route: row.route,
          claim_from: row.from_addr,
          claim_nonce: row.nonce,
          reason: clipReason(settled.verdict.error),
        }),
      );
      return { kind: "stopped", fetches };
    }
    // H2 (CODEX r1 on the M3 brief, replacing L6): a rule-7 refusal on the RE-POST path, while the chain reads the authorisation UNUSED, is not acted on. An earlier attempt's broadcast
    // transfer can be mined after any number of "unused" reads, right up to validBefore, so a refusal written now could be false for money that then moved (and its 402 would invite a
    // second signature). The claim stays pending; the facilitator's words are kept as its last words; it resolves through the chain showing the nonce used (booked, or stopped above)
    // or through C6's pinned unused-after-expiry proof (expired, which releases a pay-listing reservation in the same batch). payAndSettle's FIRST /settle keeps honouring a rule-7
    // refusal at once: the claim was taken by that very request, so no earlier attempt exists.
    const refusal = settled.verdict.error;
    await quietly("note_unknown", () => noteUnknown(env, key, refusal, owner, Date.now()));
    return {
      kind: "unchanged",
      detail: `${refusal} It is not acted on: the chain still reads this authorisation unused, so an earlier attempt's transfer may yet be mined and a refusal now could be wrong. The claim stays pending until the chain shows the authorisation used or provably expired.`,
      fetches,
    };
  }
  const { tx, payer } = settled.verdict;
  if (!(await markSettled(env, key, tx, payer, owner, Date.now()))) {
    // Another worker moved it first: carry on from the row as it now stands.
    const moved = await getClaim(env, key);
    if (moved && (moved.state === "refused" || moved.state === "expired")) {
      // H2: this re-POST was answered with a SUCCESS and the claim is already terminal-without-money. Discarding the verdict would let the re-send serve the
      // terminal row's 402 with fresh accepts, inviting a second signature for money that may have moved, and log nothing.
      await recordContradiction(env, moved, moved.state, { tx, payer }, body.paymentRequirements);
      return { kind: "contradiction", tx, state: moved.state, fetches };
    }
    if (moved && moved.state === "settled_unbooked") return { kind: "settled", row: moved, fetches };
    if (moved && moved.state === "pending") {
      // C2 (re-gate LOW-1(b)): the re-POST answered SUCCESS, another holder holds the still-pending claim, and nothing here may write the tx to it. Logged once and
      // carried in the outcome, so the re-send's answer names it; the reconciler's outcome counts it unchanged, the line already written.
      logSettlementSuccessUnrecorded(moved, { tx, payer }, body.paymentRequirements);
      return { kind: "unchanged", detail: "", held: { tx, payer, req: body.paymentRequirements }, fetches };
    }
    return { kind: "unchanged", detail: "another worker moved the claim", fetches };
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
// SHOWHOME_REPORT_POINTER (how a payer whose money moved, and who is not a citizen, reaches the maintainer, gate M1) lives in settlement-claims.ts,
// next to the contradiction answer that also serves it; every settled-but-incomplete message of this file interpolates it.

export type SettledPaymentRoute = "registration" | "patron" | "listing_fee";

export type SettledPaymentRecord = { applied: boolean; prev_hash: string; hash: string } | { applied: false; prev_hash: null; hash: null };

// With `claim` (every route does), the ledger row is written as that claim's booking
// step (B5a/B5c): ONE batch with the UPDATE that records its id in booked_refs,
// gated on the claim still being settled_unbooked with no ledger row recorded, and on
// `owner` holding the lease (R1). A step that finds the row already recorded returns the
// recorded row, so a finisher that runs twice books the treasury line once. `final` moves
// the claim to `booked` in the same batch, for a route whose ledger line is its last write.
// `applied` says whether THIS call's batch recorded the line (R3): a route whose ledger
// line is its last write (the patron door) answers from the claim when it is false; a route
// that goes on to a later step (registration, listing creation) lets that step decide. A
// null receipt means the line is not recorded and ANOTHER holder has the lease (it is still
// booking): the caller answers from the claim.
export async function recordSettledPayment(
  env: Env,
  route: SettledPaymentRoute,
  settled: { payer: string; tx: string },
  amountCents: number,
  row: ChainRow,
  claim?: { key: ClaimKey; final: boolean; owner: string },
): Promise<SettledPaymentRecord> {
  try {
    if (!claim) return { ...(await appendChained(env.DB, "ledger", row)), applied: true };
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
      claim.owner,
      Date.now(),
    );
    if (applied && built) return { ...built, applied: true };
    // Not applied: another writer already recorded the line (take theirs), or the claim is not
    // settled_unbooked (nothing was written), which is a failure to book, never a silent success.
    const now = await getClaim(env, claim.key);
    const ledgerId = now ? refsOf(now).ledger_id : undefined;
    if (ledgerId == null) {
      // The gate is three conditions: settled_unbooked, this ref unrecorded, and this owner holds the lease or none is live. This call's batch did not apply, and
      // the claim is still settled_unbooked with the line unrecorded: so the lease was the condition that failed, and another holder is booking (C3: proven from state
      // and ref, never from a lease read that can have lapsed since). Anything else is a failure to book, never a silent success.
      if (stepGatedOutByLease(now, "ledger_id")) return { applied: false, prev_hash: null, hash: null };
      throw new Error("the claim is not settled_unbooked: no treasury line was recorded for it");
    }
    return { ...(await ledgerReceipt(env, ledgerId)), applied: false };
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
  const claim: PaidClaim = { route: "patron", intent: { line }, finish: (row, owner) => finishPatron(env, row, null, owner) };
  // B4: a header that already has a claim is answered from it, before /verify spends the
  // facilitator's credits on a replay.
  const replay = await replayForClaim(env, request, reqs, claim);
  if (replay) return replay;
  const result = await payAndSettle(env, request, reqs, undefined, claim);
  if (!result.ok) return result.response;
  return finishUnderOwnLease(env, result, () => finishPatron(env, result.claim as ClaimRow, result.settlement, result.owner));
}

// The reconciler's entry point for a settled patron claim (src/settlement-reconcile.ts).
export async function finishPatronBooking(env: Env, row: ClaimRow, owner: string): Promise<void> {
  await finishPatron(env, row, null, owner);
}

// The patron door's whole paid act: one treasury line. Reads the claim, writes the line
// as the claim's final booking step unless one is already recorded, and answers as the
// first request would. `settlement` is the facilitator's body when the caller has it (the
// request that settled), and null on a resumed booking, which then omits the
// X-PAYMENT-RESPONSE header it has no body for.
async function finishPatron(env: Env, row: ClaimRow, settlement: Record<string, unknown> | null, owner: string): Promise<Response> {
  const line = String(JSON.parse(row.intent_json).line);
  const payer = row.payer ?? "unknown";
  const tx = row.tx ?? "";
  const ledgerId = refsOf(row).ledger_id;
  let sealed: SettledPaymentRecord;
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
      { key: keyOfRow(row), final: true, owner },
    );
    // R3 (gate C2): the treasury line IS this route's whole paid act. If this call's batch did not record it (another holder did, or holds the
    // lease), the answer comes from the claim, never from a receipt this call did not write.
    if (!sealed.applied) return answerFromClaim(env, keyOfRow(row), owner);
  } else {
    // The claim already records the line (and, the line being this route's last write, it is booked): nothing for this call to apply.
    return answerFromClaim(env, keyOfRow(row), owner);
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
