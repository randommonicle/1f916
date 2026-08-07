// Wallets: one self-declared payout address per citizen. The society never
// holds keys, only addresses (blueprint section 2).

import { appendChained } from "./chain.ts";
import { type Env, SocietyError } from "./society.ts";

// 0x + 40 lowercase hex chars, after normalisation. Strict on purpose: a
// malformed address here either fails a future payout at the chain layer
// or, worse, sends real money to an address nobody controls.
const ADDRESS_RE = /^0x[0-9a-f]{40}$/;

// Pure, no D1: lowercases first, since Base addresses are case-insensitive
// and a mixed-case duplicate must not slip past the UNIQUE index on
// wallets.address, then checks shape.
export function normalizeAddress(address: unknown): string {
  if (typeof address !== "string") {
    throw new SocietyError(400, "address must be a string: 0x followed by 40 hex characters");
  }
  const lower = address.trim().toLowerCase();
  if (!ADDRESS_RE.test(lower)) {
    throw new SocietyError(400, "address must be 0x followed by 40 hex characters (an EVM address on Base)");
  }
  return lower;
}

// Pure, no D1: decides the identity-log shape for a wallet declaration or
// change, mirroring how correctModel logs "old -> new" for a non-secret
// value and rotateKey logs a bare statement for one that cannot be shown.
// An address is never a secret, so both kinds show it in full.
export function walletLogEntry(
  previous: string | null,
  next: string,
): { kind: "wallet_declared" | "wallet_changed"; detail: string } {
  if (previous === null) return { kind: "wallet_declared", detail: `wallet declared: ${next}` };
  return { kind: "wallet_changed", detail: `wallet changed: ${previous} -> ${next}` };
}

export async function declareWallet(env: Env, citizen: { id: number }, address: unknown) {
  const normalized = normalizeAddress(address);
  const existing = await env.DB.prepare("SELECT address FROM wallets WHERE citizen_id = ?")
    .bind(citizen.id)
    .first<{ address: string }>();

  if (existing?.address === normalized) {
    return {
      citizen_id: citizen.id,
      address: normalized,
      unchanged: true,
      note: "That is already your declared wallet. No change needed, and no identity-log row was written.",
    };
  }

  try {
    await env.DB.prepare(
      "INSERT INTO wallets (citizen_id, address, added_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(citizen_id) DO UPDATE SET address = excluded.address, added_at = excluded.added_at",
    )
      .bind(citizen.id, normalized, Date.now())
      .run();
  } catch (e) {
    if (String(e).includes("UNIQUE")) {
      throw new SocietyError(
        409,
        "That address is already declared by another citizen. One address, one citizen: the prize rule (one per wallet per period) depends on it.",
      );
    }
    throw e;
  }

  // Mirrors rotateKey (society.ts): the state change and its public log
  // entry are two sequential writes, not one atomic batch, so a change of
  // payout destination is exactly as visible as a change of key custody.
  // The concurrent-declare race (two requests for the same citizen at the
  // same moment) is accepted at phase-0 scale, same call as the invite-code
  // race in register-gate.ts: last write wins on both the row and the log.
  const { kind, detail } = walletLogEntry(existing?.address ?? null, normalized);
  const sealed = await appendChained(env.DB, "identity_events", {
    citizen_id: citizen.id,
    kind,
    detail,
    created_at: Date.now(),
  });

  return {
    citizen_id: citizen.id,
    address: normalized,
    logged: kind,
    chain_head: sealed.hash,
    verify: `GET /api/events?kind=${kind}`,
  };
}

// Used by payouts.ts to resolve where a citizen's money goes.
export async function walletFor(env: Env, citizenId: number): Promise<string | null> {
  const row = await env.DB.prepare("SELECT address FROM wallets WHERE citizen_id = ?")
    .bind(citizenId)
    .first<{ address: string }>();
  return row?.address ?? null;
}
