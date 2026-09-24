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
export function buildPaymentRequirements(
  env: Env,
  opts: { resource: string; description: string; priceAtomic: string; payTo?: string },
): PaymentRequirements {
  return {
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
}

async function facilitator(env: Env, path: "/verify" | "/settle", body: unknown): Promise<Record<string, unknown>> {
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
  if (answer !== null && typeof answer === "object" && !Array.isArray(answer)) return answer as Record<string, unknown>;
  if (path === "/settle") {
    throw new SocietyError(502, `The facilitator's answer to /settle could not be read (HTTP ${res.status}). The settle request was sent; whether the money moved is unknown until the chain is checked.`);
  }
  throw new SocietyError(502, `The facilitator is unreachable (${res.status}). Your money was not taken. Try again later.`);
}

export type SettleResult =
  | { ok: false; response: Response }
  | { ok: true; payer: string; tx: string; settlement: Record<string, unknown> };

// The shared verify+settle core. Returns either a 402 Response to send back
// as-is (no payment attached, an invalid signature, or a failed
// settlement), or a successful settlement for the caller to act on.
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

  const verdict = await facilitator(env, "/verify", rpcBody);
  if (verdict.isValid !== true) {
    return {
      ok: false,
      response: Response.json(
        { x402Version: 1, error: String(verdict.invalidReason ?? "payment invalid"), accepts: [reqs] },
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
  // Only a well-formed answer is an answer (CODEX, build review 2026-09-24,
  // finding 1). facilitator() returns any parsed JSON object whatever the
  // HTTP status, so an intermediary's JSON error page, or a reply without a
  // boolean `success`, used to read as a refusal here: handlePayListing then
  // released its reservation and a retry could pay twice if the facilitator
  // had in fact broadcast. Such a body says nothing about whether the money
  // moved, so it takes the unknown-outcome path an unreadable body already
  // takes: thrown, never read as a refusal. handlePayListing keeps its
  // reservation (settlement_unconfirmed); the other callers answer 502,
  // "unknown until the chain is checked", instead of a 402 that invites a
  // second payment. An explicit `success: false` is still a refusal.
  let settlement: Record<string, unknown>;
  try {
    settlement = await facilitator(env, "/settle", rpcBody);
    if (typeof settlement.success !== "boolean") {
      throw new SocietyError(502, "The facilitator's answer to /settle was not a settlement result (no boolean success). The settle request was sent; whether the money moved is unknown until the chain is checked.");
    }
  } catch (e) {
    console.log(JSON.stringify({ level: "error", event: "x402_settle_outcome_unknown", resource: reqs.resource, pay_to: reqs.payTo, amount_atomic: reqs.maxAmountRequired, reason: e instanceof Error ? e.message : String(e) }));
    throw e;
  }
  if (settlement.success !== true) {
    return {
      ok: false,
      response: Response.json(
        { x402Version: 1, error: String(settlement.errorReason ?? "settlement failed"), accepts: [reqs] },
        { status: 402 },
      ),
    };
  }

  const payer = typeof settlement.payer === "string" ? settlement.payer : "unknown";
  const tx = typeof settlement.transaction === "string" ? settlement.transaction : "";
  return { ok: true, payer, tx, settlement };
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
