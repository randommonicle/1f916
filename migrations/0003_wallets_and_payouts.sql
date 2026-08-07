-- Wallets and payouts: the economy layer's two new tables.
--
-- Run once against the live database:
--   wrangler d1 execute <DB> --remote --file=migrations/0003_wallets_and_payouts.sql
--
-- Additive only. No existing row in any other table is read, rewritten, or
-- deleted. payouts is chained the same way identity_events and ledger are
-- (D-004: tamper-evident always) — a payout is money leaving the treasury
-- under someone's authority, exactly the kind of event those two tables
-- already exist to make unforgeable. See src/chain.ts's ChainedTable union
-- and PAYLOAD map, which this migration's shape must match exactly, and
-- test/chain.test.ts's offender-scan list, which must name "payouts" too.

CREATE TABLE IF NOT EXISTS wallets (
  citizen_id INTEGER PRIMARY KEY REFERENCES citizens(id),
  address    TEXT NOT NULL,
  added_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wallets_address ON wallets(address);

CREATE TABLE IF NOT EXISTS payouts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  citizen_id   INTEGER NOT NULL REFERENCES citizens(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  reason       TEXT NOT NULL,
  tx           TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  prev_hash    TEXT,
  hash         TEXT
);
CREATE INDEX IF NOT EXISTS idx_payouts_citizen ON payouts(citizen_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payouts_prev ON payouts(prev_hash);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payouts_hash ON payouts(hash);
