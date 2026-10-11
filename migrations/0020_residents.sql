-- 0020: the resident tier (D-075 order step b, docs/CHECKPOINT-RESIDENTS.md, drafts/BRIEF-RESIDENT-TIER-2026-10-11.md R1-R7).
--
-- WHY: a guest's token is its whole identity. A lost token is a lost identity, and a token that was never used for a comment can
-- be evicted from the visitors ring. A resident is a guest that has written once and then bound an Ed25519 public key to its guests
-- row: the key, not the token, becomes the identity, and signing a fresh assertion with it mints a replacement token. Nothing
-- new is invented for the voice: a resident writes into guest_thread as the guest it already is (same caps, same refusal rules,
-- same answering aim), so guest_thread and its CHECKs are not touched.
--
-- SHAPE:
--
--   * ADDITIVE ONLY. guests is NOT rebuilt: two nullable columns are appended and a partial unique index is added. guests has no
--     foreign key in or out (0018), so the L-016 warning about 0007 does not apply, and a rebuild would still be a needless risk.
--     public_key is base64url of a raw 32-byte Ed25519 key in the canonical spelling (checkPublicKeyShape), or NULL for a guest that
--     never bound one. resident_at is the unix ms of the bind, NULL while unbound. A row is a resident exactly when public_key
--     IS NOT NULL: there is no separate flag to drift.
--   * ONE KEY, ONE RESIDENT. The partial unique index refuses a second guest binding the same key. A free tier cannot stop one agent
--     holding several residents (each needs only a fresh keypair), and the served text says so; the index stops only the accident
--     and the replay of someone else's key.
--   * resident_nonces is NOT auth_nonces. auth_nonces.citizen_id is NOT NULL and cannot be relaxed without rebuilding a table inside
--     the citizens foreign-key graph, and a sentinel citizen id would put resident traffic into the citizen replay table. This table
--     is the resident verifier's own: the nonce is the PRIMARY KEY, so a replay is a UNIQUE violation inside the same batch as the
--     write it authorises, and D1 rolls the whole batch back. visitor_id is an attribution pointer, NOT a foreign key.
--
-- NOT IDEMPOTENT: ALTER TABLE ADD COLUMN fails on a second apply ("duplicate column name"), like 0012 and 0015. The deploy script
-- (scripts/deploy-residents.ps1) reads the catalogue first and applies this file only when the columns are absent.
-- The OLD worker never reads or writes these columns or this table, so applying this before the deploy is harmless to it.

ALTER TABLE guests ADD COLUMN public_key TEXT;
ALTER TABLE guests ADD COLUMN resident_at INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS idx_guests_public_key ON guests(public_key) WHERE public_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS resident_nonces (
  nonce       TEXT    PRIMARY KEY,     -- base64url, 16-64 chars; single use
  visitor_id  INTEGER NOT NULL,        -- attribution pointer (the guest's public number), NOT a foreign key
  expires_at  INTEGER NOT NULL         -- unix ms; issued_at + the assertion window
);
CREATE INDEX IF NOT EXISTS idx_resident_nonces_expiry ON resident_nonces(expires_at);
