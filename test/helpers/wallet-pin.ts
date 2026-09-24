// Wallet fixtures for the server-side wallet pin (docs/BRIEF-SERVER-SIDE-WALLET-PIN.md).
//
// declareTestWallet declares a wallet the way POST /api/wallet does
// (src/wallets.ts declareWallet): the wallets row, then the chained
// wallet_declared / wallet_changed identity row through the REAL appendChained,
// with the detail walletLogEntry writes. Since the pin, the pay route checks
// that chained row, so a wallet written to the table alone is refused
// (wallet_row_missing) -- which is CODEX's out-of-step case, not a fixture
// shortcut. Addresses must be the normalised form (0x + 40 lowercase hex).

import { appendChained } from "../../src/chain.ts";
import { walletLogEntry } from "../../src/wallets.ts";
import type { LocalD1 } from "./local-d1.ts";

export interface WalletRowPin {
  id: number;
  hash: string;
}

export async function declareTestWallet(d1: LocalD1, citizenId: number, address: string): Promise<WalletRowPin> {
  const previous = d1.raw.prepare("SELECT address FROM wallets WHERE citizen_id = ?").get(citizenId) as { address: string } | undefined;
  d1.raw
    .prepare("INSERT INTO wallets (citizen_id, address, added_at) VALUES (?, ?, ?) ON CONFLICT(citizen_id) DO UPDATE SET address = excluded.address, added_at = excluded.added_at")
    .run(citizenId, address, Date.now());
  const { kind, detail } = walletLogEntry(previous?.address ?? null, address);
  const sealed = await appendChained(d1.DB, "identity_events", { citizen_id: citizenId, kind, detail, created_at: Date.now() });
  const row = d1.raw.prepare("SELECT id FROM identity_events WHERE hash = ?").get(sealed.hash) as { id: number };
  return { id: row.id, hash: sealed.hash };
}

// The citizen's newest wallet row of either kind -- what GET /api/listing/:id
// serves a funder to pin (A7), and what the route requires. null if none.
export function newestWalletRow(d1: LocalD1, citizenId: number): WalletRowPin | null {
  const row = d1.raw
    .prepare("SELECT id, hash FROM identity_events WHERE citizen_id = ? AND kind IN ('wallet_declared', 'wallet_changed') ORDER BY id DESC LIMIT 1")
    .get(citizenId) as { id: number; hash: string } | undefined;
  return row ? { id: row.id, hash: row.hash } : null;
}

// A syntactically valid pin for a request the route refuses BEFORE check 1
// (no wallet, not the funder, throttled): it passes the free format check and
// is never compared with anything.
export const PLACEHOLDER_PIN: WalletRowPin = { id: 999_999, hash: "0".repeat(64) };
