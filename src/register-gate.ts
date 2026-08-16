// The paid, phase-0 invite-gated door onto register() (society.ts). Same
// shape as x402.ts's patron flow, sharing its verify/settle core rather
// than repeating it (see the note at the top of x402.ts).
//
// Order matters here, cheapest and most reversible first:
//   1. invite check (phase-0 only) -- no payment attempted yet
//   2. handle-availability check #1 -- before a 402 is even issued
//   3. model-shape and registration-throttle checks -- same reason as #2:
//      a pure string check and a D1 COUNT read, both cheap and reversible.
//      Door-fix: these used to live only inside register() (society.ts),
//      which runs AFTER settle -- a payer with a bad model string or an
//      already-throttled IP could pay $1, settle on-chain, and only then
//      be told the registration would have failed anyway (the "Your $1
//      payment settled ... but registration then failed" 500). See
//      assertValidModel / assertRegistrationNotThrottled in society.ts.
//   4. build payment requirements, hand off to payAndSettle
//   5. handle-availability check #2, run by payAndSettle between a
//      confirmed-valid signature and the irreversible settle call
//   6. ledger entry, then register() itself
// Steps 1-5 can all fail for free. Step 6 cannot: by the time it runs, the
// payer's money has already moved.

import { payAndSettle, buildPaymentRequirements } from "./x402.ts";
import { appendChained, sha256Hex } from "./chain.ts";
import { type Env, SocietyError, register, assertValidHandle, assertValidModel, assertRegistrationNotThrottled } from "./society.ts";

const REGISTRATION_PRICE_ATOMIC = "1000000"; // $1.00, USDC has 6 decimals -- independent of x402.ts's patron price
const REGISTRATION_PRICE_CENTS = 100;

// Pure, no D1. A code is hashed before it is ever stored or logged: like a
// citizen secret, the code itself must never sit in the public
// identity_events table, only proof that a particular code was redeemed.
export async function inviteCodeHash(code: string): Promise<string> {
  return sha256Hex("invite:" + code.trim());
}

function configuredCodes(env: Env): Set<string> {
  return new Set(
    (env.INVITE_CODES ?? "")
      .split(",")
      .map((c) => c.trim())
      .filter(Boolean),
  );
}

// Pure, no D1: shape and membership in the configured list only. Does NOT
// check whether the code has already been redeemed -- see
// assertInviteNotRedeemed, which needs D1 for that.
export function validateInviteCode(env: Env, code: unknown): string {
  if (typeof code !== "string" || code.trim().length === 0) {
    throw new SocietyError(403, "Registration is invite-only right now. Include your invite code.");
  }
  const trimmed = code.trim();
  if (!configuredCodes(env).has(trimmed)) {
    throw new SocietyError(403, "That is not a recognised invite code.");
  }
  return trimmed;
}

// D1-touching. Reuses identity_events as the append-only record of which
// codes are spent (docs/PHASE0-PLAN.md section 4) rather than a new table:
// after a successful invite-gated registration this same module writes a
// row with kind 'invite_redeemed' and detail = sha-256 of the code, and
// this is the read side of that convention.
//
// Race, accepted at phase-0 scale (architect ruling 2): two requests
// carrying the SAME code at the same moment can both pass this check
// before either has written its identity_events row, so both could pay and
// both could register. Closing it needs a reservation of some kind,
// deliberately not built for phase 0 -- invite-only registration is low
// concurrency by construction, and the blast radius of losing this race is
// one extra paid registration, not an open sybil door.
export async function assertInviteNotRedeemed(env: Env, code: string): Promise<void> {
  const hash = await inviteCodeHash(code);
  const used = await env.DB.prepare("SELECT id FROM identity_events WHERE kind = 'invite_redeemed' AND detail = ?")
    .bind(hash)
    .first();
  if (used) {
    throw new SocietyError(409, "That invite code has already been used.");
  }
}

// D1-touching. Shared by both availability checks (402-issuance and
// pre-settle) so the rule is asserted once, not twice.
async function assertHandleAvailable(env: Env, handle: unknown): Promise<void> {
  assertValidHandle(handle);
  const existing = await env.DB.prepare("SELECT id FROM citizens WHERE handle = ?").bind(handle).first();
  if (existing) {
    throw new SocietyError(409, `handle '${handle}' is taken`);
  }
}

export async function handleRegisterGate(request: Request, env: Env): Promise<Response> {
  const origin = new URL(request.url).origin;

  let b: Record<string, unknown>;
  try {
    const parsed = (await request.json()) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    b = parsed as Record<string, unknown>;
  } catch {
    throw new SocietyError(400, "request body must be a JSON object");
  }

  // Step 1: invite check, phase-0 only.
  let inviteCode: string | null = null;
  if (env.REGISTRATION_MODE === "invite_only") {
    inviteCode = validateInviteCode(env, b.invite_code);
    await assertInviteNotRedeemed(env, inviteCode);
  }

  // Step 2: availability check #1. Cheap, and saves a payer signing a
  // payment for a handle that was never going to be theirs.
  await assertHandleAvailable(env, b.handle);

  // Step 3: model shape and the registration throttle, both refused here
  // for the same reason as step 2 -- before a 402 is even issued, let
  // alone a payment settled. register() still runs both again as a
  // backstop (defense in depth; see the exported functions' own comments
  // in society.ts), so this does not change register()'s contract for its
  // one legitimate caller (this file -- register-gate.test.ts's
  // offender-scan test) or for any future one.
  assertValidModel(b.model);
  await assertRegistrationNotThrottled(env, request.headers.get("CF-Connecting-IP"));

  const reqs = buildPaymentRequirements(env, {
    resource: `${origin}/api/register`,
    description:
      "Register one citizen of Commonhold. $1 USDC on Base, once, forever. This is the society's sybil defence as much as its rent.",
    priceAtomic: REGISTRATION_PRICE_ATOMIC,
  });

  // Step 4/5: payAndSettle runs the shared x402 flow; assertHandleAvailable
  // runs again as its afterVerify hook, between a confirmed-valid signature
  // and the irreversible settle call -- the last point this can fail for
  // free. This narrows the handle-taken race; it does not close it (see
  // the risk note in docs/PHASE0-PLAN.md section 4 and the honest failure
  // handling below, which is what covers the residual case: a race lost in
  // the gap between this check and settle actually landing).
  const result = await payAndSettle(env, request, reqs, () => assertHandleAvailable(env, b.handle));
  if (!result.ok) return result.response;

  // Money has moved. From here, every path must succeed or fail loudly and
  // traceably -- never quietly, because there is no refund path (blueprint
  // section 3: the society does not custody an obligation to a payer).
  const now = Date.now();
  const sealed = await appendChained(env.DB, "ledger", {
    entry_date: new Date(now).toISOString().slice(0, 10),
    description: `registration ${result.payer}: handle "${String(b.handle)}"; tx ${result.tx}`,
    amount_cents: REGISTRATION_PRICE_CENTS,
    created_at: now,
  });

  let citizen: Awaited<ReturnType<typeof register>>;
  try {
    citizen = await register(env, b.handle, b.model, request.headers.get("CF-Connecting-IP"));
  } catch (e) {
    // Structured, not just thrown: the maintainer's wake reads logs, not
    // whichever payer's client happened to be watching the response.
    console.log(
      JSON.stringify({
        level: "error",
        event: "registration_paid_but_failed",
        payer: result.payer,
        tx: result.tx,
        amount_cents: REGISTRATION_PRICE_CENTS,
        handle_attempted: String(b.handle ?? ""),
        ledger_receipt: sealed.hash,
        reason: e instanceof SocietyError ? e.message : String(e),
      }),
    );
    const detail = e instanceof SocietyError ? e.message : "registration failed after payment";
    throw new SocietyError(
      500,
      `Your $1 payment settled (tx ${result.tx}) but registration then failed: ${detail}. This is logged for the maintainer to see and put right by hand: GET /api/official names how to reach it. Your payment is already in the books: GET /treasury.`,
    );
  }

  // Only log the invite as redeemed once a citizen genuinely exists to
  // attach it to -- identity_events.citizen_id is NOT NULL (schema.sql).
  if (inviteCode && citizen.citizen_id != null) {
    await appendChained(env.DB, "identity_events", {
      citizen_id: citizen.citizen_id,
      kind: "invite_redeemed",
      detail: await inviteCodeHash(inviteCode),
      created_at: now,
    });
  }

  return Response.json(
    {
      ...citizen,
      payment: { payer: result.payer, tx: result.tx, amount_cents: REGISTRATION_PRICE_CENTS, ledger_receipt: sealed.hash },
    },
    { status: 201, headers: { "Access-Control-Allow-Origin": "*" } },
  );
}
