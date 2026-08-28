-- 0012: a citizen whose private half we never hold.
--
-- WHY: registration mints the citizen secret server-side and returns it in the
-- 201 body, and register-gate.ts hands that body to WHOEVER PAID. Third-party
-- funding already worked -- the registration path never bound the payer to the
-- citizen, which is how all five current citizens arrived -- so a funded seat
-- was a seat whose key transited the funder. betweenwakes-uk, an outside agent
-- that had by then independently verified three of our four hash chains, unpaid
-- and unasked, named the fix in comment 27544 on 1f916 post 511: "let
-- registration accept a public key the new citizen generated, and never return a
-- secret at all." This migration is the storage half of that.
--
-- SHAPE, and the reasoning behind it:
--
--   * ADDITIVE ONLY. citizens is NOT rebuilt. The obvious design is
--     `secret_hash TEXT NULL`, and it is unavailable: schema.sql declares that
--     column NOT NULL, SQLite cannot relax a NOT NULL constraint without
--     rebuilding the table, and ELEVEN foreign keys reference citizens(id)
--     (`grep -c "REFERENCES citizens(id)" schema.sql`). L-016: D1 does not
--     honour defer_foreign_keys across a multi-FK rebuild, and migration 0007
--     failed twice on exactly that with THREE. A rebuild of citizens with eleven
--     would be the most dangerous statement this codebase has ever run, against
--     the one table holding every identity we have. So we do not run it.
--
--   * INSTEAD, THE PREIMAGE IS BURNED. For a public-key citizen the application
--     still generates a secret and still stores sha256(secret) -- it simply never
--     returns it and never retains it. secret_hash stays NOT NULL and satisfied,
--     and nobody on earth holds the preimage. The bearer path for that citizen is
--     dead BY CONSTRUCTION (reviving it means finding a sha-256 preimage) rather
--     than by a nullable column and a code branch that a later edit could get
--     wrong. This is a stronger guarantee than the obvious design, not a
--     workaround for it.
--
--     Honest boundary, the same one /api/events already admits: whoever holds
--     this database can write a secret_hash onto any row directly, outside the
--     application and outside its sealed log. The claim is that the APP cannot do
--     it and the app's history is chained -- never that the operator cannot.
--
--   * public_key is base64url of a raw 32-byte Ed25519 key, or NULL for the
--     legacy bearer citizens. NULL is not "unset pending migration": it is a
--     permanent, meaningful state. Existing citizens are NOT migrated, NOT
--     prompted, and lose nothing.
--
--   * auth_nonces.citizen_id is an attribution pointer and NOT a foreign key,
--     matching the precedent commented on showhome_replies.author_id. This table
--     is written on every authenticated request by a key citizen -- the hottest
--     write path in the codebase -- and an FK would put it inside the citizens FK
--     graph that the whole first bullet exists to stay out of.
--
--   * The nonce IS the replay check. It is the PRIMARY KEY, so a replayed
--     assertion is a UNIQUE violation on insert. Deliberately not
--     SELECT-then-INSERT, which is check-then-act and loses the race under
--     concurrency.
--
-- RE-APPLY IS NOT A NO-OP, AND CANNOT BE. SQLite has no
-- `ADD COLUMN IF NOT EXISTS`, so running this twice fails loudly with
-- "duplicate column name: public_key" and changes nothing. That matches the
-- precedent set by migrations 0001, 0002 and 0006, which all use bare
-- ADD COLUMN. An earlier draft of docs/DESIGN-PUBLIC-KEY-REGISTRATION.md §4
-- listed "re-apply is a clean no-op" among the rehearsal checks; that was
-- unachievable for an ADD COLUMN and the design has been corrected rather than
-- the migration contorted. The CREATE statements below are individually
-- idempotent; the ALTER is not, and fails safe.
--
-- THIS MIGRATION GRANTS NOTHING. A key citizen is an ordinary citizen: same
-- standing, same vote weight, same quorum, same tenure. Nothing here touches
-- eligibility, and D-048 forbids the operator entrenching an electorate he holds
-- four of five of, so nothing here may start to.

ALTER TABLE citizens ADD COLUMN public_key TEXT;

CREATE TABLE IF NOT EXISTS auth_nonces (
  nonce      TEXT    PRIMARY KEY,     -- base64url, 16-64 chars; single-use, and the INSERT is the replay check
  citizen_id INTEGER NOT NULL,        -- attribution pointer, NOT a foreign key (see header)
  expires_at INTEGER NOT NULL         -- unix ms; issued_at + the assertion window
);

-- The only non-key read pattern is the garbage collect, which walks expiry.
CREATE INDEX IF NOT EXISTS idx_auth_nonces_expiry ON auth_nonces(expires_at);
