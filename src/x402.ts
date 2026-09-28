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

import { appendChained } from "./chain.ts";
import { type Env, SocietyError } from "./society.ts";

// USDC on Base mainnet.
export const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
// The facilitator (verifies signatures and settles on-chain; no account, no
// API key needed, since an agent-run society can't sign up for things) is
// read from env.FACILITATOR_URL, not hardcoded here: see wrangler.jsonc.
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
  const res = await fetch(`${env.FACILITATOR_URL}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
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
    throw new SocietyError(502, `The facilitator's answer to /settle could not be read (HTTP ${res.status}). The settle request was sent; whether the money moved is unknown until the chain is checked.`);
  }
  throw new SocietyError(502, `The facilitator is unreachable (${res.status}). Your money was not taken. Try again later.`);
}

export type SettleResult =
  | { ok: false; response: Response }
  | { ok: true; payer: string; tx: string; settlement: Record<string, unknown> };

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
const clipReason = (v: unknown) => (typeof v === "string" ? v : String(v)).slice(0, FACILITATOR_REASON_MAX);
const SETTLE_UNKNOWN_TAIL = "The settle request was sent; whether the money moved is unknown until the chain is checked.";

export type SettleVerdict =
  | { kind: "settled"; rule: 4; payer: string; tx: string }
  | { kind: "refused"; rule: 7; status: number; reason: string; error: string }
  | { kind: "unknown"; rule: 1 | 2 | 3 | 4 | 5 | 6 | 8; message: string; broadcastTx?: string };

export function classifySettle(status: number, body: Record<string, unknown>): SettleVerdict {
  // 1. A server error, whatever the body says.
  if (status >= 500 && status <= 599) {
    return { kind: "unknown", rule: 1, message: `The facilitator answered /settle with HTTP ${status}, a server error, which is not a settlement verdict. ${SETTLE_UNKNOWN_TAIL}` };
  }
  // 2. 409 duplicate_settlement: "the same operation is already in flight or has a replay marker".
  if (status === 409) {
    return { kind: "unknown", rule: 2, message: `The facilitator answered /settle with HTTP 409 (duplicate_settlement: the same settlement is already in flight or has a replay marker), which is not a settlement verdict. ${SETTLE_UNKNOWN_TAIL}` };
  }
  // 3. No boolean `success` (L-089; wording unchanged).
  if (typeof body.success !== "boolean") {
    return { kind: "unknown", rule: 3, message: "The facilitator's answer to /settle was not a settlement result (no boolean success). The settle request was sent; whether the money moved is unknown until the chain is checked." };
  }
  // 4. `success: true` settles on a 2xx status only.
  if (body.success === true) {
    if (status >= 200 && status <= 299) {
      return { kind: "settled", rule: 4, payer: typeof body.payer === "string" ? body.payer : "unknown", tx: typeof body.transaction === "string" ? body.transaction : "" };
    }
    return { kind: "unknown", rule: 4, message: `The facilitator answered /settle with success: true on HTTP ${status}; a success on a non-2xx status contradicts itself, so it is not read as a verdict. ${SETTLE_UNKNOWN_TAIL}` };
  }
  const reason = body.errorReason;
  // 5. settlement_pending: "It is not a verdict." On EVM `transaction` carries
  //    the broadcast hash when the transaction was already broadcast.
  if (reason === SETTLEMENT_PENDING) {
    const tx = typeof body.transaction === "string" && body.transaction.length > 0 ? body.transaction : undefined;
    return {
      kind: "unknown",
      rule: 5,
      message: `The facilitator has not yet settled this payment (settlement_pending): it may still land on-chain.${tx ? ` It reports the broadcast transaction ${tx}.` : ""} Whether the money moved is unknown until the chain is checked; do not sign again.`,
      ...(tx ? { broadcastTx: tx } : {}),
    };
  }
  // 6. A failure with no usable reason cannot be classified.
  if (typeof reason !== "string" || reason.length === 0) {
    return { kind: "unknown", rule: 6, message: `The facilitator answered /settle with HTTP ${status} and success: false but no reason (errorReason absent, empty or not a string), so the answer cannot be classified. ${SETTLE_UNKNOWN_TAIL}` };
  }
  // 7. The only refusals: "a recorded failure" (200) and "invalid input,
  //    missing/invalid credentials, or a policy refusal" (400, 401, 403).
  if (
    body.success === false &&
    typeof reason === "string" &&
    reason.length > 0 &&
    ((status === 200 && reason !== SETTLEMENT_PENDING) || status === 400 || status === 401 || status === 403)
  ) {
    const shownReason = clipReason(reason);
    return { kind: "refused", rule: 7, status, reason: shownReason, error: `The facilitator reports that this settlement failed (HTTP ${status}, reason: ${shownReason}). By its account no money moved.` };
  }
  // 8. Anything else: every other 4xx, every 2xx other than 200, any 1xx or 3xx.
  return { kind: "unknown", rule: 8, message: `The facilitator answered /settle with HTTP ${status}, success: false and reason ${clipReason(reason)}: a combination PayAI does not document as a definitive refusal. ${SETTLE_UNKNOWN_TAIL}` };
}

// ---------- B3: classifying the /verify answer (docs/BRIEF-X402-SETTLE-HONESTY.md) ----------
//
// Pure, like classifySettle. When /verify answers, nothing that could settle
// has been sent, so every refusal and failure here truthfully says no money
// moved; what the status adds is whose answer it is. Before this wave any
// answer without `isValid: true` was served as 402 "payment invalid", which
// misnamed a facilitator that refused service (4xx) or failed (5xx) as a fault
// in the payer's signature. `/settle` is never called after rules 1, 3, 4 or 5.
export type VerifyVerdict =
  | { kind: "valid"; rule: 2 }
  | { kind: "invalid"; rule: 3; error: string }
  | { kind: "refused"; rule: 4; error: string }
  | { kind: "failed"; rule: 5; message: string };

const VERIFY_REASON_KEYS = ["invalidReason", "errorReason", "error", "message"] as const;
// The first STRING among those keys (an empty one counts: the brief says "the
// first string"), clipped to 200 characters, else "none given".
function verifyReason(body: Record<string, unknown>): string {
  for (const key of VERIFY_REASON_KEYS) {
    const v = body[key];
    if (typeof v === "string") return v.slice(0, FACILITATOR_REASON_MAX);
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
    return { kind: "refused", rule: 4, error: `The payment facilitator refused to verify this payment (HTTP ${status}, reason: ${reason}). No money moved: nothing that could settle was sent.` };
  }
  // Rule 5: a 5xx. The brief names only 2xx, 4xx and 5xx; any other final
  // status (1xx, 3xx) takes this same path, filled conservatively: it is no
  // reason to settle, and nothing that could settle was sent.
  return { kind: "failed", rule: 5, message: `The payment facilitator failed to verify this payment (HTTP ${status}, reason: ${reason}). No money moved: nothing that could settle was sent. Try again later.` };
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

  const rpcBody = { x402Version: 1, paymentPayload, paymentRequirements: reqs };

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
  const settled = await settleOrThrow(env, rpcBody, reqs);
  if (settled.verdict.kind === "refused") {
    return {
      ok: false,
      response: Response.json(
        { x402Version: 1, error: settled.verdict.error, accepts: [reqs] },
        { status: 402 },
      ),
    };
  }

  return { ok: true, payer: settled.verdict.payer, tx: settled.verdict.tx, settlement: settled.body };
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

  const result = await payAndSettle(env, request, reqs);
  if (!result.ok) return result.response;

  const now = Date.now();
  const line = inscription || "(a patron who paid in silence)";
  const sealed = await appendChained(env.DB, "ledger", {
    entry_date: new Date(now).toISOString().slice(0, 10),
    description: `patron ${result.payer}: "${line}"; tx ${result.tx}`,
    amount_cents: PRICE_CENTS,
    created_at: now,
  });

  return Response.json(
    {
      thanks: "Your line is in the books, permanently: GET /treasury",
      inscription: line,
      payer: result.payer,
      transaction: result.tx,
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
        "X-PAYMENT-RESPONSE": btoa(JSON.stringify(result.settlement)),
      },
    },
  );
}
