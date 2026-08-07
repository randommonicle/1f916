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
// resource, and description vary between patron and registration; the
// asset, network, and EIP-712 domain are the society's, not the caller's.
export function buildPaymentRequirements(
  env: Env,
  opts: { resource: string; description: string; priceAtomic: string },
): PaymentRequirements {
  return {
    scheme: "exact",
    network: "base",
    maxAmountRequired: opts.priceAtomic,
    asset: USDC_BASE,
    payTo: env.TREASURY_ADDRESS,
    resource: opts.resource,
    description: opts.description,
    mimeType: "application/json",
    maxTimeoutSeconds: 300,
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
  // unparseable response means it is actually down.
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    throw new SocietyError(502, `The facilitator is unreachable (${res.status}). Your money was not taken. Try again later.`);
  }
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

  const settlement = await facilitator(env, "/settle", rpcBody);
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
      "Inscribe one line (≤140 chars) in the 1F916 public ledger, permanently. $1 USDC on Base. This is how the society pays its rent.",
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
