// Wallets: one self-declared payout address per citizen. The society never
// holds keys, only addresses (blueprint section 2).

import { appendChainedStmt, chainHeadMovedError, classifyUniqueViolation, parseUniqueColumns } from "./chain.ts";
import { type Env, SocietyError, requireSignedIntent } from "./society.ts";

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

// Pure, no D1: the exact inverse of walletLogEntry -- the address a wallet row
// makes CURRENT. "wallet declared: X" gives X; "wallet changed: A -> X" gives
// X, never A (a substring test would also match a change's PREVIOUS address,
// so a row that moved the wallet AWAY from an address would pass for it).
// Only the normalised form both writes use is accepted (0x + 40 lowercase
// hex, normalizeAddress); anything else is null, which the pay route refuses
// as wallet_row_address. scripts/pay-listing.mjs walletRowAddress parses the
// same shapes on the funder's side; test/wallet-pin-d1.test.ts runs both over
// one fixture set so the two cannot drift.
const DECLARED_DETAIL = /^wallet declared: (0x[0-9a-f]{40})$/;
const CHANGED_DETAIL = /^wallet changed: 0x[0-9a-f]{40} -> (0x[0-9a-f]{40})$/;
export function walletAddressFromRow(kind: string, detail: string): string | null {
  const m = kind === "wallet_declared" ? DECLARED_DETAIL.exec(detail) : kind === "wallet_changed" ? CHANGED_DETAIL.exec(detail) : null;
  return m ? m[1] : null;
}

const WALLET_RACED_MESSAGE =
  "Another wallet declaration for this citizenship committed first, so this one wrote nothing. Read GET /api/events?kind=wallet_declared and GET /api/events?kind=wallet_changed for the wallet now on record, then declare again if you still want this address. A public-key citizen signs a fresh assertion for that request: each assertion is spent once.";
const ADDRESS_TAKEN_MESSAGE =
  "That address is already declared by another citizen. One address, one citizen: the prize rule (one per wallet per period) depends on it.";

// A listing bounty goes straight to the reviewer's wallet row, and the served text says it never touches the treasury. Refused where a row is written (declareWallet) and where one is
// paid (handlePayListing: a row can predate this rule, or the treasury's address can change). `address` is normalised; a deployment with no treasury address refuses nothing.
export function isTreasuryAddress(env: Env, address: string): boolean {
  return address === env.TREASURY_ADDRESS?.trim().toLowerCase();
}

export async function declareWallet(env: Env, citizen: { id: number }, address: unknown, credential: string | null) {
  const normalized = normalizeAddress(address);
  if (isTreasuryAddress(env, normalized)) {
    throw new SocietyError(400, "That is the treasury's own address, not a wallet of yours: a payment to it would reach no citizen. Nothing was written. Declare an address you control.", "wallet_is_treasury");
  }
  // D-056: the declared wallet is where every future payout goes, so a key
  // citizen signs the exact address. Parts: the address string AS SUPPLIED
  // (pre-normalisation — the signer commits to what it sent; two spellings of
  // one address are two different commitments, which is fine, since each
  // request carries its own).
  await requireSignedIntent(credential, "wallet", [String(address)]);
  const now = Date.now();
  const existing = await env.DB.prepare("SELECT address, added_at FROM wallets WHERE citizen_id = ?")
    .bind(citizen.id)
    .first<{ address: string; added_at: number }>();

  if (existing?.address === normalized) {
    // DEFERRED-WALLET-REDECLARE-OUT-OF-STEP (the wallet-pin gate's L3,
    // 2026-09-24): the batched writer below prevents NEW table/log
    // mismatches, but one left by the old two-write code, or by a direct
    // database edit, can still exist. Re-declaring the table's address lands
    // here and writes no row, so the pay route's pin check keeps refusing
    // (wallet_row_address). Money-safe, but the citizen's only way out is to
    // declare another address and change back. The fix would compare with
    // the newest chained row, not the table, before answering "unchanged".
    return {
      citizen_id: citizen.id,
      address: normalized,
      unchanged: true,
      note: "That is already your declared wallet. No change needed, and no identity-log row was written.",
    };
  }

  // The payout address and its identity-log row commit as ONE batch (the
  // rotateKey / commitRotation pattern). stateStmt is a compare-and-set against
  // the row this request read, fixed across retries; the chained INSERT is
  // gated on changes() = 1, so a request that lost a race writes nothing.
  //
  // added_at is a per-row version: a first declare stores `now`; every change
  // stores MAX(now, old + 1), strictly above the value it replaced, so a request
  // holding an old (address, added_at) can never match again, even after
  // A -> B -> A or when requests sample the same millisecond. It is read and
  // served nowhere else: its meaning is "declaration time, nudged forward by at
  // least 1 ms per change".
  const stateStmt = existing
    ? env.DB.prepare(
        "UPDATE wallets SET address = ?, added_at = MAX(?, added_at + 1) WHERE citizen_id = ? AND address = ? AND added_at = ?",
      ).bind(normalized, now, citizen.id, existing.address, existing.added_at)
    : env.DB.prepare("INSERT INTO wallets (citizen_id, address, added_at) VALUES (?, ?, ?)").bind(citizen.id, normalized, now);
  const { kind, detail } = walletLogEntry(existing?.address ?? null, normalized);
  const row = { citizen_id: citizen.id, kind, detail, created_at: now };

  for (let attempt = 0; attempt < 4; attempt++) {
    const log = await appendChainedStmt(env.DB, "identity_events", row, { sql: "SELECT 1 WHERE changes() = 1", args: [] });
    let results: { meta: { changes: number } }[];
    try {
      results = await env.DB.batch<{ meta: { changes: number } }>([stateStmt, log.stmt]);
    } catch (e) {
      const message = String(e);
      if (!message.includes("UNIQUE")) throw e;
      const cols = parseUniqueColumns(message);
      if (cols !== null && cols.length === 1 && cols[0] === "wallets.address") throw new SocietyError(409, ADDRESS_TAKEN_MESSAGE);
      if (cols !== null && cols.length === 1 && cols[0] === "wallets.citizen_id") throw new SocietyError(409, WALLET_RACED_MESSAGE);
      if (classifyUniqueViolation("identity_events", message) === "chain_head") continue;
      throw e;
    }
    const changes = results.map((r) => r.meta.changes);
    if (changes[0] === 1 && changes[1] === 1) {
      return {
        citizen_id: citizen.id,
        address: normalized,
        logged: kind,
        chain_head: log.hash,
        verify: `GET /api/events?kind=${kind}`,
      };
    }
    if (changes[0] === 0 && changes[1] === 0) throw new SocietyError(409, WALLET_RACED_MESSAGE);
    throw new SocietyError(500, `wallet declaration committed an inconsistent vector [${changes.join(", ")}]; refusing to report it as success`);
  }
  throw chainHeadMovedError("identity_events");
}

// Used by payouts.ts to resolve where a citizen's money goes.
export async function walletFor(env: Env, citizenId: number): Promise<string | null> {
  const row = await env.DB.prepare("SELECT address FROM wallets WHERE citizen_id = ?")
    .bind(citizenId)
    .first<{ address: string }>();
  return row?.address ?? null;
}
