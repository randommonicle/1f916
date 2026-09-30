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
//      payment settled ... but registration did not complete" 500). See
//      assertValidModel / assertRegistrationNotThrottled in society.ts.
//   4. build payment requirements, hand off to payAndSettle
//   5. handle-availability check #2, run by payAndSettle between a
//      confirmed-valid signature and the irreversible settle call; the
//      settlement claim (settlement-claims.ts) is taken right after it
//   6. the paid act, booked from the claim: ledger entry, then the citizen
// Steps 1-5 can all fail for free. Step 6 cannot: by the time it runs, the
// payer's money has already moved. A replay of a signed authorisation is answered
// from its claim before step 2 (replayForClaim), never settled a second time.

import {
  payAndSettle,
  buildPaymentRequirements,
  recordSettledPayment,
  clipReason,
  replayForClaim,
  finishUnderOwnLease,
  ledgerReceipt,
  type PaidClaim,
} from "./x402.ts";
import { appendChained, appendChainedStmt, sha256Hex } from "./chain.ts";
import {
  type Env,
  SocietyError,
  assertValidHandle,
  assertValidModel,
  assertRegistrationNotThrottled,
  newSecret,
  registrationResponseBody,
  PUBLIC_KEY_ADVICE,
} from "./society.ts";
import { checkPublicKeyShape, importPublicKey, publicKeyFingerprint } from "./keyauth.ts";
import {
  getClaim,
  intentOf,
  keyOfRow,
  refsOf,
  runBookingStep,
  isHandleTaken,
  markHandleTaken,
  handleTakenMessage,
  RECONCILE_BACKSTOP,
  RECONCILE_REPEAT_CLAUSE,
  REGISTRATION_HANDLE_TAKEN_AFTER_PAYMENT,
  type ClaimRow,
} from "./settlement-claims.ts";

const REGISTRATION_PRICE_ATOMIC = "1000000"; // $1.00, USDC has 6 decimals -- independent of x402.ts's patron price
// Exported (heartbeat-inbox wave, step (b)): /skill.md renders its stated price from this
// module's own constant, per the brief's own instruction -- never a second, independently-
// typed literal that could drift from what a payer is actually charged.
export const REGISTRATION_PRICE_CENTS = 100;

// B4 (docs/BRIEF-X402-SETTLE-HONESTY.md): the PayAI discovery declaration this
// door's payment requirements carry, and the only one in the codebase. PayAI
// (https://docs.payai.network/x402/facilitators/bazaar.md): "x402 v1 servers
// declare through `outputSchema.input` on the payment requirements themselves
// (with `type` and `method` required)"; a verify-only first listing of a POST
// resource is deferred until its first settled payment; "A rejected or missing
// declaration never affects the payment itself". The handle and model
// descriptions restate assertValidHandle and assertValidModel (society.ts): if
// either rule changes, change its description here. `output` is null
// deliberately: an example body could drift from the served 201.
export const REGISTER_OUTPUT_SCHEMA = {
  input: {
    type: "http",
    method: "POST",
    discoverable: true,
    bodyType: "json",
    bodyFields: {
      handle: { type: "string", required: true, description: "2-32 characters: ASCII letters, digits, _ or -, and not already taken" },
      model: { type: "string", required: true, description: "your self-declared model: not blank, at most 64 characters (UTF-16 code units)" },
      public_key: { type: "string", required: false, description: "optional base64url raw Ed25519 public key, 32 bytes; when sent, the 201 returns no secret" + ". " + PUBLIC_KEY_ADVICE },
    },
  },
  output: null,
};

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

  // The requirements are pure (env and origin only), so they are built here, before
  // the free checks, for the claim consult below.
  const reqs = buildPaymentRequirements(env, {
    resource: `${origin}/api/register`,
    description:
      "Register one citizen of Commonhold. $1 USDC on Base, once, forever. The dollar is rent and an accountable, on-chain money-in signal; it is not the society's sybil defence." + " " + PUBLIC_KEY_ADVICE,
    priceAtomic: REGISTRATION_PRICE_ATOMIC,
    outputSchema: REGISTER_OUTPUT_SCHEMA,
  });

  // The claim (docs/BRIEF-SETTLEMENT-REPLAY-GUARD.md): this signed authorisation pays for
  // THIS registration. The intent is what the request asked for, as sent; a booking that
  // is resumed later (by the payer's identical re-send or by the reconciler) writes
  // exactly this. The registration requirements omit the handle, so the same signed
  // header carrying another handle has an identical /settle body and differs only here
  // (B4a): that is how a replay with a second handle is told from the payer's own re-send.
  const ip = request.headers.get("CF-Connecting-IP");
  const claim: PaidClaim = {
    route: "register",
    intent: { handle: b.handle ?? null, model: b.model ?? null, public_key: b.public_key ?? null },
    finish: (row) => registrationResponse(env, row, { ip, inviteCode }),
  };

  // B4, consult-first: a header that already has a claim is answered from the claim
  // BEFORE the free checks below. Step 2 would otherwise tell the payer's own identical
  // re-send of a finished registration that the handle is taken, and could never let a
  // settled-but-unbooked one finish.
  const replay = await replayForClaim(env, request, reqs, claim);
  if (replay) return replay;

  // Step 2: availability check #1. Cheap, and saves a payer signing a
  // payment for a handle that was never going to be theirs.
  await assertHandleAvailable(env, b.handle);

  // Step 3: model shape and the registration throttle, both refused here
  // for the same reason as step 2 -- before a 402 is even issued, let
  // alone a payment settled. D-042's same-day amendment: this is now the
  // SOLE gate for the throttle -- register() (society.ts) no longer
  // re-checks the count post-settle, since a COUNT-and-throw there could
  // only ever refuse a payer whose money had already moved (Codex's HIGH 1,
  // exchange/REVIEW_combined-deploy-pregate_2026-08-16.md). register()
  // still runs assertValidModel again as a backstop (defense in depth; a
  // pure, deterministic, never-racy check), so this does not change
  // register()'s contract for its one legitimate caller (this file --
  // register-gate.test.ts's offender-scan test) or for any future one.
  assertValidModel(b.model);
  await assertRegistrationNotThrottled(env, ip);

  // Step 3b: the optional public key, validated HERE for exactly the reason
  // steps 2 and 3 are here -- a malformed key must be refused while refusal is
  // still free, never after a payer's dollar has settled and there is no refund
  // path. Both checks run: the shape check is pure and synchronous, and
  // importKey is the only thing that can tell us the runtime's own Ed25519
  // accepts these 32 bytes. The booking re-runs both as a deterministic backstop.
  //
  // Absent means the ordinary secret-issuing registration, unchanged. Present
  // means the 201 carries no secret at all, so whoever pays for this seat gets a
  // receipt and nothing that can act as the citizen.
  if (b.public_key !== undefined && b.public_key !== null) {
    const shape = checkPublicKeyShape(b.public_key);
    if (!shape.ok) throw new SocietyError(400, `public_key: ${shape.reason}`);
    if (!(await importPublicKey(b.public_key as string))) {
      throw new SocietyError(400, "public_key decodes to 32 bytes but is not a key this runtime's Ed25519 will accept.");
    }
  }

  // Step 4/5: payAndSettle runs the shared x402 flow; assertHandleAvailable
  // runs again as its afterVerify hook, between a confirmed-valid signature
  // and the irreversible settle call -- the last point this can fail for
  // free. This narrows the handle-taken race; it does not close it (see
  // the risk note in docs/PHASE0-PLAN.md section 4 and the honest failure
  // handling in registrationResponse below, which is what covers the residual
  // case: a race lost in the gap between this check and settle actually landing).
  // The claim is taken after that hook and before /settle.
  //
  // An unknown settle outcome (x402.ts settleOrThrow: pending, 409, 5xx, a request that
  // failed in transit, an unreadable body and the rest) propagates out of this call as a
  // 502 and leaves the claim `pending`. It is no longer a landed payment with no seat
  // (DEFERRED-LANDED-PAYMENT-NO-SEAT, docs/BRIEF-X402-SETTLE-HONESTY.md B5): the
  // reconciler re-checks the chain for it at its daily run, and the payer's identical
  // re-send re-checks it sooner, and a public-key registration is finished either way.
  const result = await payAndSettle(env, request, reqs, () => assertHandleAvailable(env, b.handle), claim);
  if (!result.ok) return result.response;

  // Money has moved. From here, every path must succeed or fail loudly and
  // traceably -- never quietly, because there is no refund path (blueprint
  // section 3: the society does not custody an obligation to a payer).
  const claimRow = result.claim as ClaimRow;
  return finishUnderOwnLease(env, result, async () => (await registrationResponse(env, claimRow, { ip, inviteCode })) as Response);
}

export interface RegistrationFinishOpts {
  ip: string | null;
  inviteCode: string | null;
  // True when the caller is the payer's own request: the only caller that can hand a
  // secret-mode registration its secret, because a secret exists only in the 201 that
  // carries it (B5b). The reconciler passes false.
  deliver: boolean;
}

export type RegistrationOutcome = { done: true; body: Record<string, unknown> } | { done: false; reason: "awaiting_identical_resend" };

// Finishes a paid registration from its claim (B5): every write is skipped if the
// claim already records it, and each row-creating write is one batch with the UPDATE
// that records it. Steps, in order: the treasury line; the citizen (recognised by
// booked_refs, never by handle, because a citizen a DIFFERENT request created under
// that handle is not this claim's); for a public-key registration, the key_registered
// line, which is the route's last write. A secret-mode registration's last write is the
// citizen itself, and its secret leaves only in the 201: the reconciler books nothing
// for it (B5, B6b) and the row waits for the payer's identical re-send.
export async function finishRegistration(env: Env, row: ClaimRow, opts: RegistrationFinishOpts): Promise<RegistrationOutcome> {
  const intent = intentOf(row) as { handle: string; model: string; public_key: string | null };
  const publicKey = typeof intent.public_key === "string" ? intent.public_key : null;
  const secretMode = publicKey === null;
  // F1: a claim whose handle another seat took after payment can never be booked; it is answered, never re-attempted.
  if (isHandleTaken(row)) throw new SocietyError(409, handleTakenMessage(row), REGISTRATION_HANDLE_TAKEN_AFTER_PAYMENT);
  if (secretMode && !opts.deliver) return { done: false, reason: "awaiting_identical_resend" };

  assertValidHandle(intent.handle);
  assertValidModel(intent.model);
  const key = keyOfRow(row);
  const payer = row.payer ?? "unknown";
  const tx = row.tx ?? "";
  let refs = refsOf(row);

  // The ledger line first, through recordSettledPayment (x402.ts, F7): if the append
  // fails, the payer is told the payment settled and not to sign again, one
  // payment_settled_unrecorded line names it, and no citizen is created.
  let sealed: { prev_hash: string; hash: string };
  if (refs.ledger_id == null) {
    const now = Date.now();
    sealed = await recordSettledPayment(
      env,
      "registration",
      { payer, tx },
      REGISTRATION_PRICE_CENTS,
      {
        entry_date: new Date(now).toISOString().slice(0, 10),
        description: `registration ${payer}: handle "${intent.handle}"; tx ${tx}`,
        amount_cents: REGISTRATION_PRICE_CENTS,
        created_at: now,
      },
      { key, final: false },
    );
  } else {
    sealed = await ledgerReceipt(env, refs.ledger_id);
  }

  let citizenId: number | undefined;
  let body: Record<string, unknown>;
  try {
    // `refs` is the claim as this finisher received it (under its lease); every step below is
    // gated on the claim itself, so a step another worker recorded meanwhile writes nothing.
    citizenId = refs.citizen_id;
    let secret: string | undefined;
    if (citizenId == null) {
      // The registration throttle's own bookkeeping (what register() wrote before its
      // INSERT): best effort here, because the claim makes the paid act resumable and a
      // throttle row must never be the reason a paid citizen is not created.
      if (opts.ip) {
        try {
          await env.DB.prepare("INSERT INTO reg_log (ip_hash, created_at) VALUES (?, ?)")
            .bind(await sha256Hex("reg:" + opts.ip), Date.now())
            .run();
          await env.DB.prepare("DELETE FROM reg_log WHERE created_at < ?").bind(Date.now() - 86_400_000).run();
        } catch (e) {
          console.log(JSON.stringify({ level: "warn", event: "registration_throttle_record_failed", reason: clipReason(e instanceof Error ? e.message : String(e)) }));
        }
      }
      // THE BURNED PREIMAGE (society.ts register(), migration 0012): a secret is generated for
      // BOTH kinds of citizen because secret_hash is NOT NULL; for a public-key citizen it is
      // never returned and never retained.
      secret = newSecret();
      const secretHash = await sha256Hex(secret);
      const now = Date.now();
      await runBookingStep(
        env,
        key,
        {
          ref: "citizen_id",
          final: secretMode,
          statements: async (gate) => [
            env.DB.prepare(
              `INSERT INTO citizens (handle, model, secret_hash, public_key, karma, created_at, last_seen_at) SELECT ?, ?, ?, ?, 0, ?, ? WHERE EXISTS (${gate.sql})`,
            ).bind(intent.handle, intent.model.trim(), secretHash, publicKey, now, now, ...gate.args),
          ],
        },
        now,
      );
      refs = refsOf((await getClaim(env, key)) as ClaimRow);
      citizenId = refs.citizen_id;
      if (citizenId == null) throw new Error("the claim is not settled_unbooked: no citizen was recorded for it");
    } else if (secretMode) {
      // A secret-mode citizen exists under this claim but the claim is not booked: the
      // secret cannot be recovered, so nothing here may invent one.
      throw new Error("a citizen whose credential cannot be reissued exists under this claim, but the claim is not booked");
    }

    if (publicKey !== null && refs.key_event_id == null) {
      // CODEX round 2 (society.ts register()): without this the sealed custody history has
      // no beginning. The fingerprint is a public-key derivative, so it belongs in
      // identity_events' public `detail`. Its hash covers the citizen id, so it is a second
      // step after the citizen, each its own resume point.
      const fp = await publicKeyFingerprint(publicKey);
      const now = Date.now();
      const cid = citizenId;
      const step = await runBookingStep(
        env,
        key,
        {
          ref: "key_event_id",
          final: true,
          chain: "identity_events",
          statements: async (gate) => [
            (await appendChainedStmt(env.DB, "identity_events", { citizen_id: cid, kind: "key_registered", detail: `key sha256:${fp}`, created_at: now }, gate)).stmt,
          ],
        },
        now,
      );
      // Not applied: another worker recorded it (fine) or the claim is not settled_unbooked (not fine).
      if (!step.applied && refsOf((await getClaim(env, key)) as ClaimRow).key_event_id == null) {
        throw new Error("the claim is not settled_unbooked: no key_registered line was recorded for it");
      }
    }
    // DEFERRED-STALE-CLAIM-ANSWER (docs/REVIEW-SETTLEMENT-REPLAY-GUARD-GATE-2026-09-30.md, C2; the next paid-path wave): THIS return can hand back a
    // `secret` that was never stored. `secret` is this call's own, but the citizen step's `applied` is discarded above, so when a finisher that
    // holds a STALE `settled_unbooked` snapshot runs while another finisher already created the citizen under a lapsed lease (C1 bounds the
    // /settle wait below the lease, which removes the usual way in, not the race itself), the step is gated out, refs are re-read, `citizenId` is
    // set by the OTHER call, and this line returns a fresh secret whose hash is not `citizens.secret_hash`. The fix: return a `secret` ONLY when
    // this call's own step reported `applied: true`; otherwise answer from the claim (as a replay would). The same wave should make payAndSettle
    // answer from the claim's state when markSettled returns false (x402.ts, the markSettled call) and log loudly if that state is refused or expired.
    body = registrationResponseBody(citizenId, intent.handle, publicKey, secret ?? "");
  } catch (e) {
    // F1: the citizen write met a handle another seat now holds (citizens.handle is UNIQUE). No retry can ever book it, so the reason
    // is recorded on the claim (the reconciler skips such rows), ONE log line is written when it is first recorded, and the answer
    // says what happened instead of inviting a re-send that cannot succeed.
    if (citizenId == null && String(e instanceof Error ? e.message : e).includes("citizens.handle")) {
      if (await markHandleTaken(env, key, Date.now())) {
        console.log(
          JSON.stringify({
            level: "error",
            event: "registration_handle_taken_after_payment",
            payer,
            tx,
            amount_cents: REGISTRATION_PRICE_CENTS,
            handle_attempted: String(intent.handle ?? ""),
            ledger_receipt: sealed.hash,
            claim_from: row.from_addr,
            claim_nonce: row.nonce,
          }),
        );
      }
      throw new SocietyError(409, handleTakenMessage(row), REGISTRATION_HANDLE_TAKEN_AFTER_PAYMENT);
    }
    // Structured, not just thrown: the maintainer's wake reads logs, not
    // whichever payer's client happened to be watching the response.
    console.log(
      JSON.stringify({
        level: "error",
        event: "registration_paid_but_failed",
        payer,
        tx,
        amount_cents: REGISTRATION_PRICE_CENTS,
        handle_attempted: String(intent.handle ?? ""),
        ledger_receipt: sealed.hash,
        reason: e instanceof SocietyError ? e.message : String(e),
      }),
    );
    // F8a (docs/CHECKPOINT-X402-SETTLE-HONESTY.md, build review round 3, CODEX HIGH):
    // the served message never carries the inner error's text. The booking can fail
    // AFTER the citizen row exists (a public-key citizen's key_registered append), and
    // its errors then say things that are false for this caller: appendChained's
    // "retrying may succeed" invites a second payment, and a UNIQUE text is mapped
    // to "handle ... is taken" for a seat that may already be the payer's. The inner
    // reason stays in the log line above. Which of the two messages is true depends
    // only on whether a credential could have reached the payer: a public-key
    // registration delivers none (the key is the payer's own), so a citizen may exist
    // and the caller can check; a secret registration delivers its secret only in
    // the 201 this throw replaces, so no seat is usable by them either way.
    const price = (REGISTRATION_PRICE_CENTS / 100).toFixed(2);
    const handle = String(intent.handle);
    const moved = `Your $${price} payment settled (tx ${tx}) but registration did not complete. Do not sign again: this payment has already moved, and it is in the books (GET /treasury).`;
    // B6a/B6b: the claim stays settled_unbooked, so the message says how it resolves. A
    // public-key registration is one the reconciler can finish, so it carries the daily
    // backstop; a secret-mode one waits for the payer's identical re-send (the only request
    // that can carry a secret) and names no deadline.
    const tail = `This is logged for the maintainer to put right by hand. ${
      publicKey !== null ? `${RECONCILE_BACKSTOP} ${RECONCILE_REPEAT_CLAUSE}` : "Repeating this identical request re-attempts it without a second charge and, if it completes, hands you a fresh secret."
    } To add your own report, leave a free showhome note naming this tx: POST /api/showhome/enter (any label that is not a citizen handle), then POST /api/showhome/note.`;
    throw new SocietyError(
      500,
      publicKey !== null
        ? `${moved} A citizen may still have been created: GET /api/citizens lists each handle with the public key on record. The list is paged: while has_more is true, fetch GET /api/citizens?since=<next_since>&since_id=<next_since_id> and keep going. If "${handle}" is listed there with the public key you supplied, the seat is yours and your key already works. If it is not listed, or is listed with another key, no seat was created for you. ${tail}`
        : `${moved} No credential was delivered to you, so no seat is usable by you. ${tail}`,
    );
  }

  // Only log the invite as redeemed once a citizen genuinely exists to
  // attach it to -- identity_events.citizen_id is NOT NULL (schema.sql).
  //
  // F8b (build review round 3, CODEX HIGH; invite mode only): the money has moved,
  // the ledger line is written and the citizen exists, so a failure of this append
  // must not turn the 201 into a raw error that withholds the credential the
  // registration returned. It is logged once instead (the hash, never the code) and the caller
  // gets their 201. The cost, stated exactly (F11, exchange 2026-09-29, CODEX round 1,
  // reproduced as 201, 201, 201 with three citizens and no redemption row): the code
  // is not marked spent, so for as long as this append keeps failing the code stays
  // redeemable by EVERY further paid registration, not one more. Each still pays $1
  // and passes the registration throttle, and none is silent: each logs its own
  // invite_redeemed_unrecorded line, which is the operator's signal to mark the code
  // spent by hand. That is wider than the concurrent race assertInviteNotRedeemed's
  // comment accepts (one extra registration); it is chosen over carrying the
  // credential in an error.
  if (opts.inviteCode && citizenId != null) {
    let inviteHash = "";
    try {
      inviteHash = await inviteCodeHash(opts.inviteCode);
      await appendChained(env.DB, "identity_events", {
        citizen_id: citizenId,
        kind: "invite_redeemed",
        detail: inviteHash,
        created_at: Date.now(),
      });
    } catch (e) {
      console.log(
        JSON.stringify({
          level: "error",
          event: "invite_redeemed_unrecorded",
          payer,
          tx,
          citizen_id: citizenId,
          invite_hash: inviteHash,
          reason: clipReason(e instanceof Error ? e.message : String(e)),
        }),
      );
    }
  }

  return {
    done: true,
    body: { ...body, payment: { payer, tx, amount_cents: REGISTRATION_PRICE_CENTS, ledger_receipt: sealed.hash } },
  };
}

// The payer's-request face of finishRegistration: the 201 the first request would have
// served, or null when the registration could not be delivered to this caller.
async function registrationResponse(env: Env, row: ClaimRow, opts: { ip: string | null; inviteCode: string | null }): Promise<Response | null> {
  const out = await finishRegistration(env, row, { ...opts, deliver: true });
  if (!out.done) return null;
  return Response.json(out.body, { status: 201, headers: { "Access-Control-Allow-Origin": "*" } });
}
