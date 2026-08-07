// Payouts: the treasury's outbound book, published alongside the ledger
// (the inbound one). Chained the same way as identity_events and ledger
// (D-004: tamper-evident always) — a payout is money leaving the treasury
// under the maintainer's authority, exactly what those two tables already
// exist to make unforgeable.
//
// A payout also writes a matching negative-amount ledger entry in the same
// atomic batch. Without that, GET /treasury's booked_cents would only ever
// count money in and never reflect a bounty or prize paid out, which would
// make the "public books" quietly dishonest the first time a payout landed.
// payouts is the structured, citizen-linked record of the same event;
// ledger stays the single bidirectional total it was always documented as
// (schema.sql: "Positive amount_cents = money in, negative = money out").

import { appendChainedStmt } from "./chain.ts";
import { type Env, SocietyError, MAINTAINER_ID } from "./society.ts";
import { walletFor } from "./wallets.ts";

// Pure, no D1. A code-level check gives a named error; the CHECK
// (amount_cents > 0) constraint in schema.sql is the backstop, not the
// first line of defence.
export function validatePayoutAmount(amountCents: unknown): number {
  const cents = Math.round(Number(amountCents));
  if (!Number.isFinite(cents) || cents <= 0) {
    throw new SocietyError(400, "amount_cents must be a positive integer: payouts only ever move money out");
  }
  return cents;
}

// Pure, no D1. The ledger-side description for a payout, factored out so
// its exact shape is testable without a database.
export function payoutLedgerDescription(targetCitizenId: number, address: string, reason: string, tx: string): string {
  return `payout to citizen ${targetCitizenId} (${address}): ${reason}; tx ${tx}`;
}

// Two chained tables, one atomic batch: the payout and its ledger entry
// must commit together or not at all, the same reasoning commitWithModLog
// (society.ts) uses for a moderation action and its log row. Each table's
// head is read independently, so a UNIQUE collision on either one means
// re-preparing both statements and retrying the whole pair.
async function commitPayout(
  env: Env,
  payoutRow: Record<string, unknown>,
  ledgerRow: Record<string, unknown>,
): Promise<{ payoutHash: string; ledgerHash: string }> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const payout = await appendChainedStmt(env.DB, "payouts", payoutRow);
    const ledger = await appendChainedStmt(env.DB, "ledger", ledgerRow);
    try {
      await env.DB.batch([payout.stmt, ledger.stmt]);
      return { payoutHash: payout.hash, ledgerHash: ledger.hash };
    } catch (e) {
      if (!String(e).includes("UNIQUE")) throw e;
      // Someone else appended to payouts or ledger between our read and our
      // write. Re-prepare both against the new heads and try again.
    }
  }
  throw new Error("payout commit collided with concurrent writers four times running; giving up rather than forking either chain");
}

export async function recordPayout(
  env: Env,
  citizen: { id: number },
  targetCitizenId: unknown,
  amountCents: unknown,
  reason: unknown,
  tx: unknown,
) {
  if (citizen.id !== MAINTAINER_ID) {
    throw new SocietyError(403, "Only the maintainer records payouts, approved against a claimed bounty or prize. Rule 7.");
  }
  const cents = validatePayoutAmount(amountCents);
  const targetId = Number(targetCitizenId);
  if (!Number.isInteger(targetId)) {
    throw new SocietyError(400, "citizen_id must be an integer");
  }
  if (typeof reason !== "string" || reason.trim().length < 3 || reason.length > 300) {
    throw new SocietyError(400, "reason must be 3-300 chars and should name the bounty or prize this pays");
  }
  if (typeof tx !== "string" || tx.trim().length < 1) {
    throw new SocietyError(
      400,
      "tx must be the on-chain transaction hash: a payouts row is written after the transfer settles, not before",
    );
  }

  // The payout row and nowhere for it to have gone is a worse failure than
  // a rejected request: money recorded as paid with no address behind it.
  const address = await walletFor(env, targetId);
  if (!address) {
    throw new SocietyError(409, `citizen ${targetId} has no declared wallet (POST /api/wallet). Nowhere for this payout to have gone.`);
  }

  const now = Date.now();
  const reasonTrimmed = reason.trim();
  const txTrimmed = tx.trim();
  const { payoutHash, ledgerHash } = await commitPayout(
    env,
    { citizen_id: targetId, amount_cents: cents, reason: reasonTrimmed, tx: txTrimmed, created_at: now },
    {
      entry_date: new Date(now).toISOString().slice(0, 10),
      description: payoutLedgerDescription(targetId, address, reasonTrimmed, txTrimmed),
      amount_cents: -cents,
      created_at: now,
    },
  );

  return {
    citizen_id: targetId,
    address,
    amount_cents: cents,
    reason: reasonTrimmed,
    tx: txTrimmed,
    payout_receipt: payoutHash,
    ledger_receipt: ledgerHash,
    verify: "GET /api/attest",
  };
}

// GET /payouts: the public read model. Mirrors treasury()'s shape
// (society.ts) closely on purpose, since the two are meant to be read
// side by side.
export async function payoutsPage(env: Env) {
  const { results: entries } = await env.DB.prepare(
    "SELECT id, citizen_id, amount_cents, reason, tx, created_at, prev_hash, hash FROM payouts ORDER BY created_at DESC, id DESC LIMIT 200",
  ).all();
  const sum = await env.DB.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS total FROM payouts").first<{ total: number }>();
  return {
    note: "The treasury's outbound book: every payout the maintainer has recorded, chained the same way as the ledger and the identity log.",
    total_paid_cents: sum?.total ?? 0,
    how_to_verify:
      "Each entry carries its prev_hash and hash. Recompute sha256(prev_hash + '\\n' + JSON.stringify([citizen_id, amount_cents, reason, tx, created_at])) and it must equal hash (the preimage in chain.ts). Whole-chain check with page cursor: GET /api/attest.",
    entries,
  };
}
