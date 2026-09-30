-- 0017: settlement claims (docs/BRIEF-SETTLEMENT-REPLAY-GUARD.md, option B as
-- amended; the gate's M2, docs/REVIEW-X402-SETTLE-HONESTY-GATE-2026-09-29.md).
--
-- WHY: nothing server-side stopped one signed x402 authorisation being booked
-- twice. ledger has no transaction column, and on /api/register and /api/patron
-- the facilitator request is byte-identical for every request that reuses one
-- X-PAYMENT header. A replay that reached a cached "settled" answer could mint a
-- second citizen and a second ledger line for one on-chain dollar. This table
-- is the UNIQUE key that makes "one authorisation, one booked act" true by
-- construction: a claim is INSERTed in afterVerify, BEFORE /settle, and a
-- conflict is refused with no settle attempt.
--
-- THE KEY is (network, asset, from_addr, nonce), the EIP-3009 authorisation's own
-- identity, stored lower-cased (EIP-55 casing is presentation).
--
-- STATES (B2): pending (settle outcome unknown) -> settled_unbooked (the
-- facilitator said settled; the paid act not yet fully written) -> booked
-- (every write of the paid act durable; terminal). refused (a recorded
-- refusal, classifier rule 7 only) and expired (the chain proved the
-- authorisation unused after valid_before) are terminal.
--
-- rpc_body is the exact /settle request body, which is an EXECUTABLE
-- authorisation until valid_before. It is NULL on every terminal row, and the
-- CHECK below makes that a property of the table, not of the code (B7). No route
-- serves it.
--
-- booked_refs records what booking has durably written (a JSON object:
-- ledger_id, citizen_id, key_event_id, listing_id, payment_id); each
-- row-creating booking write commits in ONE batch with the UPDATE that records
-- it here (B5a/B5c), so no crash can leave a created row the claim does not
-- know about.
--
-- valid_before is unix SECONDS, as the signed authorisation carries it.
-- lease_owner / leased_until (unix ms) make the reconciler single-holder with a
-- TTL, so a crashed worker cannot wedge a row (B6). payer is the facilitator's
-- reported payer, kept so a resumed booking writes the same ledger text a
-- first-time booking does.
--
-- ADDITIVE ONLY: one new table and one index. No existing table is rebuilt
-- (L-016: eleven foreign keys point at citizens). Apply to prod BEFORE the
-- worker that reads it (L-046); re-applying is a no-op (IF NOT EXISTS).
CREATE TABLE IF NOT EXISTS settlement_claims (
  network        TEXT    NOT NULL,
  asset          TEXT    NOT NULL,
  from_addr      TEXT    NOT NULL,
  nonce          TEXT    NOT NULL,
  route          TEXT    NOT NULL CHECK (route IN ('register', 'patron', 'listing_create', 'listing_pay')),
  intent_json    TEXT    NOT NULL,
  intent_hash    TEXT    NOT NULL,
  rpc_body       TEXT,
  rpc_body_hash  TEXT    NOT NULL,
  valid_before   INTEGER NOT NULL,
  state          TEXT    NOT NULL CHECK (state IN ('pending', 'settled_unbooked', 'booked', 'refused', 'expired')),
  tx             TEXT,
  payer          TEXT,
  verdict_reason TEXT,
  booked_refs    TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(booked_refs)),
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  lease_owner    TEXT,
  leased_until   INTEGER,
  PRIMARY KEY (network, asset, from_addr, nonce),
  CHECK (state IN ('pending', 'settled_unbooked') OR rpc_body IS NULL)
);
CREATE INDEX IF NOT EXISTS idx_settlement_claims_open ON settlement_claims(state, updated_at);
