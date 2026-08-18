-- First Laws: the attested-constitution archive, and two widened kind
-- CHECK constraints (docs/BRIEF-FIRST-LAWS.md, docs/FIRST-LAWS-DESIGN.md).
--
-- v2: fixes a SECOND real-D1 failure the v1 D1SAFE candidate hit. v1
-- correctly removed the CREATE TEMP TABLE / sqlite_sequence writes that
-- caused the ORIGINAL 0007's SQLITE_AUTH failure -- confirmed on real D1,
-- that part applied clean, no authorizer error. But v1's `proposals`
-- rebuild (CREATE proposals_new / INSERT...SELECT / DROP proposals /
-- ALTER TABLE RENAME, wrapped in PRAGMA defer_foreign_keys = on/off) then
-- failed differently:
--
--   X [ERROR] D1 DB was reset and rolled back to its last known good
--   state because the application left the database in a state where
--   constraints were violated: FOREIGN KEY constraint failed:
--   SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_FOREIGNKEY)
--
-- `proposals` is the parent of two inbound foreign keys --
-- ballots.proposal_id and governance_settings.proposal_id -- and node:
-- sqlite (re-run on this exact failing shape) PASSES it clean, proving
-- node:sqlite cannot be used to validate D1's actual foreign-key
-- checking behaviour across a table rebuild. See
-- drafts/MIGRATION-0007-D1-FIX.md's appended diagnosis section for the
-- full research: multiple independent public reports (Cloudflare's own
-- foreign-keys docs, workers-sdk#5438, workerd#2471, an external
-- migration-pattern writeup) converge on the same conclusion --
-- `wrangler d1 execute --file` wraps the whole file in one implicit
-- transaction, but `PRAGMA defer_foreign_keys` does NOT reliably permit
-- dropping a table something else currently has a live foreign key
-- pointing at, within that transaction, despite that being its
-- documented purpose in plain SQLite. This is not merely theorised: a
-- companion probe (drafts/probe-d1-defer-fk.sql) isolates the exact same
-- question in two throwaway tables, for direct confirmation.
--
-- v2's fix does not try to make defer_foreign_keys work harder. It
-- restructures the `proposals` rebuild so defer_foreign_keys is never
-- load-bearing for correctness at all -- kept only as belt-and-braces --
-- using the DETACH / REBUILD / REATTACH pattern (independently
-- documented for exactly this D1 quirk: brachkow.com/notes/
-- d1-on-delete-cascade, cited in the memo):
--
--   DETACH:   rebuild every table with an inbound FK to `proposals`
--             (ballots, governance_settings), each with that FK
--             temporarily OMITTED from its own CREATE TABLE. Once this
--             finishes, nothing in the schema has a live FK pointing at
--             `proposals` by name.
--   REBUILD:  rebuild `proposals` itself (identical to v1: widened
--             CHECK, explicit column list, no TEMP tables, no
--             sqlite_sequence writes). This DROP is now safe under ANY
--             FK-checking granularity, because nothing currently
--             references the table being dropped.
--   REATTACH: rebuild ballots and governance_settings AGAIN, this time
--             WITH the FK restored, now pointing at the new `proposals`
--             (which already exists, under its final name, holding
--             every original row and id).
--
-- Run once against the live database:
--   wrangler d1 execute <DB> --remote --file=migrations/0007_first_laws.sql
--
-- THREE jobs, not one (unchanged from v1/original):
--
-- (a) constitution_versions: additive, new table. The archive I-007
-- attests (design doc §5): every distinct (template_hash, parameters_hash)
-- pair the deployed code has ever served, full text alongside each hash so
-- any citizen can diff two versions without trusting the hash alone. The
-- genesis row is seeded by the DETECTION CODE on its first run, never by
-- this migration -- a migration file cannot compute the deployed template
-- and parameters hashes, so a genesis INSERT here would either carry
-- placeholder hashes (which /api/attest would then serve as truth) or
-- duplicate doc.ts/governance.ts's own hashing logic outside them.
--
-- (b) and (c): UNLIKE every migration before it, this one is NOT purely
-- additive. proposals.kind and maintainer_queue.kind are both closed by a
-- CHECK constraint SQLite cannot ALTER, so widening either list means
-- rebuilding the table: create a replacement with the new CHECK, copy
-- every row across, drop the original, rename the replacement into place.
-- `maintainer_queue` has no inbound FK from anywhere in the schema
-- (grep-confirmed, and unchanged by this migration), so its rebuild
-- carries none of the DETACH/REATTACH hazard `proposals` does -- it stays
-- exactly the simple four-statement shape v1 already used.
--
-- Hazards that apply throughout, both rebuild families:
--
--   1. EXPLICIT COLUMN LISTS on both sides of every copy, never `SELECT
--      *`. proposals' LIVE column order (0005's sixteen columns with
--      0006's two ALTER-TABLE-appended columns tacked on the end) differs
--      from schema.sql's own ROLLUP order (registration_mode/
--      founding_ratified interleaved after status) -- a positional copy
--      into a rollup-shaped replacement would silently bind live
--      tally_yes into registration_mode and shift everything after it.
--      Naming every column identically on both sides of INSERT ... SELECT
--      makes the copy immune to column order entirely, on either side.
--      The same discipline applies to ballots and governance_settings'
--      two rebuilds each below -- every column named, every time.
--   2. PRAGMA DISCIPLINE: `defer_foreign_keys = on` before any of it,
--      `= off` once everything bears its final name and shape again.
--      Confirmed D1-supported (Cloudflare D1 docs, "Define foreign
--      keys"); kept as defence-in-depth even though the DETACH/REBUILD/
--      REATTACH structure no longer depends on it for correctness.
--   3. CHAIN INTEGRITY: `ballots` is hash-chained (prev_hash/hash,
--      identical construction to identity_events/ledger/payouts --
--      D-004, tamper-evident always). Both of its rebuilds below copy
--      every column, including prev_hash and hash, as opaque values --
--      never recomputed, never reordered. The two UNIQUE indexes
--      (idx_ballots_prev, idx_ballots_hash) that enforce "a hash may be
--      the predecessor of exactly one entry" are recreated once
--      ballots reaches its final reattached shape; the transient
--      DETACH-phase table carries no indexes at all, since nothing reads
--      or writes it before it is rebuilt again three statements later.
--   4. SEQUENCE HIGH-WATER: deliberately NOT preserved, unchanged from
--      v1. Full trade-off in drafts/MIGRATION-0007-D1-FIX.md ("The
--      high-water decision") -- proven a no-op on current prod data,
--      proven harmless-by-construction for `proposals` (a compensating-
--      deleted id can never be durably referenced by anything), proven
--      inapplicable to `maintainer_queue` (never deleted from). The
--      DETACH/REBUILD/REATTACH rebuild below rebuilds `ballots` and
--      `governance_settings` too, but neither is ever deleted from in
--      normal operation (ballots rows are permanent votes; governance_
--      settings is upserted, never deleted), so this doesn't introduce
--      any NEW sequence-high-water question for those two tables either.
--
-- Column order for the `proposals` and `maintainer_queue` replacement
-- tables matches schema.sql's ROLLUP order, not whichever order the live
-- table happened to accrete through its own ALTER-TABLE history --
-- unchanged from v1. `ballots` and `governance_settings` are rebuilt with
-- their EXISTING column order preserved exactly (neither has ever been
-- ALTERed since 0005 created them, so live order already matches
-- schema.sql's rollup for both).
--
-- Historical migrations 0004/0005 stay untouched; schema.sql's own rollup
-- is edited separately to carry both widened CHECKs and the new table.
-- schema.sql's own `ballots`/`governance_settings` definitions do not
-- change at all -- this migration's DETACH/REATTACH dance is pure
-- mechanism to get live D1 to that same already-declared end state
-- safely; the end state itself is identical to what v1 targeted.
--
-- Verification (recorded in the checkpoint, db-migration-verification):
-- local D1 apply; PRAGMA table_info (column count + names) on all touched
-- tables; PRAGMA index_list on every rebuilt table; row-count AND full-
-- content parity before/after for ballots specifically (chain integrity,
-- not just count); foreign-key integrity by explicit anti-join SELECTs,
-- NOT `PRAGMA foreign_key_check` (independently confirmed unauthorized on
-- D1 -- memo). drafts/rehearse-0007-REAL-D1.md has the exact commands.
-- CRITICAL, learned from v1's own failure: a node:sqlite pass on this
-- file proves data preservation ONLY -- it already passed v1's broken
-- shape too, so it cannot be trusted for D1-authorizer or D1-FK-checking
-- behaviour. Only a real-D1 rehearsal proves this file is safe to apply.

PRAGMA defer_foreign_keys = on;

-- ---------- (a) constitution_versions ----------

CREATE TABLE IF NOT EXISTS constitution_versions (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  template_hash        TEXT NOT NULL,           -- sha256 of the canonicalised (LF-only) constitution template text
  parameters_hash      TEXT NOT NULL,           -- sha256 of the canonical JSON serialisation of the live vote-class table
  full_text            TEXT NOT NULL,           -- the template text this hash was computed over, verbatim -- diffable by any reader
  parameters_text      TEXT NOT NULL,           -- the canonical JSON this hash was computed over, verbatim
  first_seen_at        INTEGER NOT NULL,        -- unix ms: when this exact (template, parameters) pair was first detected live
  changed_by           TEXT NOT NULL CHECK (changed_by IN ('genesis', 'mandate_linked', 'operator')),
  mandate_proposal_ids TEXT NOT NULL            -- JSON array of proposal ids this version's text fulfils; '[]' when changed_by is 'genesis' or 'operator'
);
-- A (template_hash, parameters_hash) pair identifies a version uniquely --
-- this is both the archive's own dedupe key and the NOT EXISTS gate every
-- detection write is conditioned on (src/governance.ts).
CREATE UNIQUE INDEX IF NOT EXISTS idx_constitution_versions_pair ON constitution_versions(template_hash, parameters_hash);

-- ---------- (b) proposals: widen kind, via DETACH / REBUILD / REATTACH ----------

-- ===== DETACH: strip the inbound FK from both referencing tables =====
-- After this block, nothing in the schema has a live foreign key
-- pointing at `proposals` by name -- the DROP TABLE proposals below
-- becomes safe regardless of how D1 actually schedules or scopes its
-- deferred foreign-key checking internally.

CREATE TABLE ballots_detached (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_id  INTEGER NOT NULL,
  citizen_id   INTEGER NOT NULL REFERENCES citizens(id),
  choice       TEXT NOT NULL CHECK (choice IN ('yes', 'no', 'abstain')),
  cast_at      INTEGER NOT NULL,
  prev_hash    TEXT,
  hash         TEXT
);
INSERT INTO ballots_detached (id, proposal_id, citizen_id, choice, cast_at, prev_hash, hash)
SELECT id, proposal_id, citizen_id, choice, cast_at, prev_hash, hash
FROM ballots;
DROP TABLE ballots;
ALTER TABLE ballots_detached RENAME TO ballots;

CREATE TABLE governance_settings_detached (
  key          TEXT PRIMARY KEY,
  value        TEXT NOT NULL,
  expires_at   INTEGER,
  proposal_id  INTEGER,
  updated_at   INTEGER NOT NULL
);
INSERT INTO governance_settings_detached (key, value, expires_at, proposal_id, updated_at)
SELECT key, value, expires_at, proposal_id, updated_at
FROM governance_settings;
DROP TABLE governance_settings;
ALTER TABLE governance_settings_detached RENAME TO governance_settings;

-- ===== REBUILD: proposals itself, identical shape to v1 =====

CREATE TABLE proposals_new (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  kind           TEXT NOT NULL CHECK (kind IN ('set_name', 'set_dividend_uplift', 'set_split', 'handler_arrangement', 'buyout_terms', 'official_token', 'control_floor_raise', 'text_amendment', 'resolution', 'first_laws_ratify', 'first_laws_amendment')),
  title          TEXT NOT NULL,
  body           TEXT NOT NULL,
  payload        TEXT,
  proposer_id    INTEGER NOT NULL REFERENCES citizens(id),
  post_id        INTEGER REFERENCES posts(id),
  opened_at      INTEGER NOT NULL,
  closes_at      INTEGER NOT NULL,
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'tallying', 'passed', 'failed', 'executed')),
  registration_mode TEXT NOT NULL DEFAULT 'invite_only',
  founding_ratified INTEGER NOT NULL DEFAULT 0,
  tally_yes      INTEGER,
  tally_no       INTEGER,
  tally_abstain  INTEGER,
  eligible_count INTEGER,
  tallied_at     INTEGER,
  created_at     INTEGER NOT NULL
);

INSERT INTO proposals_new (id, kind, title, body, payload, proposer_id, post_id, opened_at, closes_at, status, registration_mode, founding_ratified, tally_yes, tally_no, tally_abstain, eligible_count, tallied_at, created_at)
SELECT id, kind, title, body, payload, proposer_id, post_id, opened_at, closes_at, status, registration_mode, founding_ratified, tally_yes, tally_no, tally_abstain, eligible_count, tallied_at, created_at
FROM proposals;

DROP TABLE proposals;
ALTER TABLE proposals_new RENAME TO proposals;

CREATE INDEX IF NOT EXISTS idx_proposals_status_closes ON proposals(status, closes_at);
CREATE INDEX IF NOT EXISTS idx_proposals_proposer ON proposals(proposer_id, created_at);

-- ===== REATTACH: restore the FK on both tables, now pointing at the new proposals =====

CREATE TABLE ballots_reattached (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_id  INTEGER NOT NULL REFERENCES proposals(id),
  citizen_id   INTEGER NOT NULL REFERENCES citizens(id),
  choice       TEXT NOT NULL CHECK (choice IN ('yes', 'no', 'abstain')),
  cast_at      INTEGER NOT NULL,
  prev_hash    TEXT,
  hash         TEXT
);
INSERT INTO ballots_reattached (id, proposal_id, citizen_id, choice, cast_at, prev_hash, hash)
SELECT id, proposal_id, citizen_id, choice, cast_at, prev_hash, hash
FROM ballots;
DROP TABLE ballots;
ALTER TABLE ballots_reattached RENAME TO ballots;

CREATE UNIQUE INDEX IF NOT EXISTS idx_ballots_proposal_citizen ON ballots(proposal_id, citizen_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ballots_prev ON ballots(prev_hash);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ballots_hash ON ballots(hash);

CREATE TABLE governance_settings_reattached (
  key          TEXT PRIMARY KEY,
  value        TEXT NOT NULL,
  expires_at   INTEGER,
  proposal_id  INTEGER REFERENCES proposals(id),
  updated_at   INTEGER NOT NULL
);
INSERT INTO governance_settings_reattached (key, value, expires_at, proposal_id, updated_at)
SELECT key, value, expires_at, proposal_id, updated_at
FROM governance_settings;
DROP TABLE governance_settings;
ALTER TABLE governance_settings_reattached RENAME TO governance_settings;

-- ---------- (c) maintainer_queue: widen kind by constitution_fidelity ----------
--
-- No inbound FK from anywhere in the schema (grep-confirmed, unchanged by
-- this migration), so this rebuild carries none of the DETACH/REATTACH
-- hazard `proposals` does -- the simple v1 shape is correct as-is.
-- Column order here already matches schema.sql's rollup (this table has
-- never been ALTERed since migration 0004 created it), so the rebuild
-- carries no reordering, only the widened CHECK. It still has its OWN
-- outbound FK to maintainer_runs, unaffected by any of this (nothing
-- about dropping maintainer_queue touches maintainer_runs at all).

CREATE TABLE maintainer_queue_new (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id         INTEGER NOT NULL REFERENCES maintainer_runs(id),
  created_at     INTEGER NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('flag_review', 'bookkeeping_note', 'registration_check', 'bulletin_draft', 'constitution_fidelity')),
  target_type    TEXT CHECK (target_type IN ('post', 'comment', 'citizen') OR target_type IS NULL),
  target_id      INTEGER,
  source_ref     TEXT,
  note           TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_at     INTEGER,
  decided_reason TEXT
);

INSERT INTO maintainer_queue_new (id, run_id, created_at, kind, target_type, target_id, source_ref, note, status, decided_at, decided_reason)
SELECT id, run_id, created_at, kind, target_type, target_id, source_ref, note, status, decided_at, decided_reason
FROM maintainer_queue;

DROP TABLE maintainer_queue;
ALTER TABLE maintainer_queue_new RENAME TO maintainer_queue;

CREATE INDEX IF NOT EXISTS idx_maintainer_queue_status ON maintainer_queue(status, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_maintainer_queue_run ON maintainer_queue(run_id);

PRAGMA defer_foreign_keys = off;
