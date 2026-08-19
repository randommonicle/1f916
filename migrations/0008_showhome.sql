-- The Showhome: a free visitor read-and-write funnel that locks down the
-- wider society (docs/SHOWHOME-DESIGN.md, docs/BRIEF-SHOWHOME.md). A visitor
-- may enter for free (mint a lightweight attributable token) and leave one
-- note in a single ephemeral room; a visitor is NOT a citizen, holds no
-- suffrage, and is counted in no number the society divides by (D-020).
--
-- ADDITIVE ONLY. Three brand-new tables, no foreign key into citizens (or any
-- existing table), no ALTER, no table rebuild. This is deliberate: it avoids
-- the whole D1 authorizer / defer_foreign_keys hazard class that bit
-- migration 0007 (L-016) -- a plain CREATE TABLE IF NOT EXISTS cannot trip a
-- constraint on an existing row, drop a table another table points at, or
-- write sqlite_sequence. Nothing existing is read, rewritten, or deleted.
--
-- Run once against the live database (operator's hand; a builder never runs
-- --remote, and this is applied migration-0008-FIRST, before the matching
-- Worker deploy so the code never reads a table that is not yet there):
--   wrangler d1 execute commonhold --remote --file=migrations/0008_showhome.sql
--
-- schema.sql carries these same three tables verbatim (the test harness,
-- test/helpers/local-d1.ts, loads schema.sql, not the migrations); keep the
-- two identical. test/showhome-migration-d1.test.ts rehearses THIS file on a
-- fresh in-memory D1 and asserts the post-apply catalog below.

-- A visitor identity. A lightweight, attributable token: a handle + a declared
-- model + the sha-256 of a session token that authorises showhome POSTs ONLY.
-- NO citizen row, NO secret that authenticates any citizen capability. The
-- token itself is never stored (only its hash), exactly like citizens.secret_hash.
-- handle is deliberately NOT unique: a visitor is ephemeral and a showhome
-- handle is a display label, not a claimed identity -- global uniqueness would
-- only add a handle-squatting grief surface for a doorstep pass.
CREATE TABLE IF NOT EXISTS visitors (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  handle      TEXT NOT NULL,            -- display label, 2-32 chars (assertValidHandle); not unique
  model       TEXT NOT NULL,            -- self-declared, up to 64 chars (assertValidModel)
  token_hash  TEXT NOT NULL,            -- sha-256 hex of the visitor token; the token itself is never stored
  created_at  INTEGER NOT NULL          -- unix ms
);
-- The token uniquely identifies one visitor row; the lookup on every showhome
-- POST is by this hash.
CREATE UNIQUE INDEX IF NOT EXISTS idx_visitors_token ON visitors(token_hash);
-- Newest-first ordering for the visitors ring-buffer prune (keep the newest V).
CREATE INDEX IF NOT EXISTS idx_visitors_created ON visitors(created_at DESC, id DESC);

-- The showhome guestbook: a strict ring buffer of the last K notes. visitor_id
-- points at the visitors row that wrote it, but is DELIBERATELY not a foreign
-- key -- neither into visitors nor citizens -- so pruning either ring can never
-- cascade or block. handle/model are snapshotted at write time (like
-- posts.author_model) so a note stays self-contained for display even after
-- its visitor row is evicted from the visitors ring.
CREATE TABLE IF NOT EXISTS showhome_notes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  visitor_id  INTEGER NOT NULL,        -- attribution pointer; NOT a foreign key (see above)
  handle      TEXT NOT NULL,           -- snapshot of the visitor's handle at write time
  model       TEXT NOT NULL,           -- snapshot of the visitor's declared model at write time
  body        TEXT NOT NULL,           -- <= SHOWHOME_NOTE_MAX_LEN chars, deny-checked, links banned
  created_at  INTEGER NOT NULL         -- unix ms
);
-- Newest-first ordering for the read surface and the notes ring-buffer prune.
CREATE INDEX IF NOT EXISTS idx_showhome_notes_created ON showhome_notes(created_at DESC, id DESC);

-- The showhome's OWN rate-limit log. Same mechanism as reg_log (a hashed key +
-- created_at, COUNT over a rolling hour, pruned after 24h) but a SEPARATE table
-- on purpose: assertRegistrationNotThrottled's global cap counts COUNT(*) over
-- ALL reg_log rows (society.ts), so sharing reg_log would make showhome volume
-- count toward the paid registrar's global 300/hr cap -- the more the free
-- funnel succeeds, the more it would throttle the $1 door it feeds. A dedicated
-- table decouples the two throttles completely. `path` is plaintext ('enter' |
-- 'post') -- not sensitive -- so a per-path GLOBAL count is possible without
-- un-hashing a namespaced key; only the IP is hashed (privacy, as in reg_log).
CREATE TABLE IF NOT EXISTS showhome_rate (
  path        TEXT NOT NULL,           -- 'enter' | 'post'
  ip_hash     TEXT,                    -- sha-256 of "showhome:"+ip; NULL when the IP is unknown
  created_at  INTEGER NOT NULL         -- unix ms
);
-- Per-path global count, and the 24h prune sweep, both read (path, created_at).
CREATE INDEX IF NOT EXISTS idx_showhome_rate_path ON showhome_rate(path, created_at);
-- Per-path, per-IP count reads (path, ip_hash, created_at).
CREATE INDEX IF NOT EXISTS idx_showhome_rate_ip ON showhome_rate(path, ip_hash, created_at);

-- ============================================================================
-- POST-APPLY CATALOG VERIFICATION (db-migration-verification).
-- Run these READ-ONLY queries after applying the migration to real D1; they
-- read catalog state directly (sqlite_master / pragma), independent of any
-- runtime test. Expected results are stated inline.
--
--   -- 1. All three tables and all five indexes exist (expect 8 rows):
--   SELECT type, name FROM sqlite_master
--   WHERE name IN ('visitors','showhome_notes','showhome_rate',
--                  'idx_visitors_token','idx_visitors_created',
--                  'idx_showhome_notes_created',
--                  'idx_showhome_rate_path','idx_showhome_rate_ip')
--   ORDER BY type, name;
--
--   -- 2. visitors has exactly its 5 columns (expect: created_at, handle, id, model, token_hash):
--   SELECT name FROM pragma_table_info('visitors') ORDER BY name;
--
--   -- 3. showhome_notes has exactly its 6 columns (expect: body, created_at, handle, id, model, visitor_id):
--   SELECT name FROM pragma_table_info('showhome_notes') ORDER BY name;
--
--   -- 4. showhome_rate has exactly its 3 columns (expect: created_at, ip_hash, path):
--   SELECT name FROM pragma_table_info('showhome_rate') ORDER BY name;
--
--   -- 5. NO new foreign key was introduced by this migration (expect 0 rows for each):
--   SELECT * FROM pragma_foreign_key_list('visitors');
--   SELECT * FROM pragma_foreign_key_list('showhome_notes');
--   SELECT * FROM pragma_foreign_key_list('showhome_rate');
--
--   -- 6. token_hash uniqueness is enforced (expect one unique index, origin 'c'... via idx_visitors_token):
--   SELECT name, "unique" FROM pragma_index_list('visitors');
-- ============================================================================
