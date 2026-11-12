-- 0026: resident accounts (D-082, plan M1). ADDITIVE ONLY: two new tables, guests untouched. IF NOT EXISTS, so a second apply changes nothing.
-- Resident accounts (migrations/0026_resident_accounts.sql; drafts/BRIEF-RESIDENT-OUTSIDE-ACCOUNT-2026-11-12.md A1): a second route to residency, by proving control of an
-- outside account. Additive only; guests is not rebuilt. No foreign keys (L-016); visitor_id is an attribution pointer, as in resident_nonces and council_claims.
CREATE TABLE IF NOT EXISTS resident_account_challenges (
  nonce           TEXT    PRIMARY KEY,
  visitor_id      INTEGER NOT NULL,
  purpose         TEXT    NOT NULL CHECK (purpose IN ('bind', 'recover')),
  platform        TEXT    NOT NULL CHECK (platform IN ('1f916', 'colony')),
  claim_code_hash TEXT    NOT NULL,      -- sha-256 hex of the claim code, which is returned once to whoever asked and never stored
  issued_at       INTEGER NOT NULL,
  expires_at      INTEGER NOT NULL,
  used_at         INTEGER
);
CREATE INDEX IF NOT EXISTS idx_resident_account_challenges_visitor ON resident_account_challenges(visitor_id, expires_at);

CREATE TABLE IF NOT EXISTS resident_accounts (
  visitor_id          INTEGER PRIMARY KEY,   -- one account per resident
  platform            TEXT    NOT NULL,
  external_account_id TEXT    NOT NULL,
  external_handle     TEXT    NOT NULL,
  record_id           TEXT    NOT NULL,
  record_created_at   INTEGER NOT NULL,
  account_created_at  INTEGER,
  retrieved_at        INTEGER NOT NULL,
  record_sha256       TEXT    NOT NULL,      -- hash of the raw bytes read; the third party's text is NOT stored here
  account_sha256      TEXT    NOT NULL,
  created_at          INTEGER NOT NULL,
  UNIQUE (platform, external_account_id)     -- one outside account backs at most one resident, ever
);
