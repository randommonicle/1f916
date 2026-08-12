-- First Laws: the attested-constitution archive, and two widened kind
-- CHECK constraints (docs/BRIEF-FIRST-LAWS.md, docs/FIRST-LAWS-DESIGN.md).
--
-- Run once against the live database:
--   wrangler d1 execute <DB> --remote --file=migrations/0007_first_laws.sql
--
-- THREE jobs, not one:
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
-- Three hazards apply to BOTH rebuilds below, each closed the same way:
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
--   2. PRAGMA DISCIPLINE: `defer_foreign_keys = on` before either rebuild
--      (ballots.proposal_id and governance_settings.proposal_id both
--      reference proposals; dropping a table other rows still reference,
--      even mid-transaction, throws without it) and an EXPLICIT
--      `defer_foreign_keys = off` once both replacements bear their
--      original names again.
--   3. SEQUENCE HIGH-WATER: sqlite_sequence for an AUTOINCREMENT table can
--      exceed MAX(id) in ordinary operation -- createProposal
--      (src/governance.ts) commits a proposal row, then
--      compensating-DELETEs it if the linked debate post fails to create.
--      A rebuild that re-derives the sequence from copied rows ALONE would
--      let the next insert REUSE an id already issued once (and, in
--      principle, already referenced by a chained ballot or a
--      governance_settings row) to a row that no longer exists. Both
--      rebuilds capture their table's sqlite_sequence value into a TEMP
--      table before the DROP (which SQLite would otherwise silently
--      forget), and restore the replacement's sqlite_sequence to at least
--      that captured value once it bears the original name -- a genuine
--      no-op when the captured value was never set at all (a fresh,
--      never-inserted-into table: the exact case a schema-only local D1
--      exercises on every test run).
--
-- Column order for both replacement tables matches schema.sql's ROLLUP
-- order, not whichever order the live table happened to accrete through
-- its own ALTER-TABLE history -- after this migration, live and rollup
-- order converge for good, so a future `SELECT *` temptation stops being
-- a landmine (though still never do it: name every column, always).
--
-- Historical migrations 0004/0005 stay untouched; schema.sql's own rollup
-- is edited separately to carry both widened CHECKs and the new table.
--
-- Verification (recorded in the checkpoint, db-migration-verification):
-- local D1 apply; PRAGMA table_info (column count + names) on all three
-- touched tables; PRAGMA index_list on both rebuilt tables; PRAGMA
-- foreign_key_check clean; row-count parity before/after each rebuild.
-- Before the REMOTE apply at deploy time, rehearse this EXACT file against
-- a fresh local D1 seeded from a current `wrangler d1 export` of
-- production (real rows, including the live proposal and its ballots),
-- not only against test fixtures -- this builder's own rehearsal used
-- node:sqlite with `PRAGMA foreign_keys = ON` set explicitly (matching
-- D1's own default, which node:sqlite does not share), since this
-- session's own hard limits forbid invoking wrangler at all, even
-- `--local`; the wrangler-against-a-production-export rehearsal this
-- header calls for is still outstanding and belongs to the operator's
-- pre-deploy gate.

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

-- ---------- (b) proposals: widen kind, reorder to rollup order ----------

CREATE TEMP TABLE _seq_capture_proposals AS SELECT seq FROM sqlite_sequence WHERE name = 'proposals';

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

INSERT INTO sqlite_sequence (name, seq)
  SELECT 'proposals', (SELECT seq FROM _seq_capture_proposals)
  WHERE (SELECT seq FROM _seq_capture_proposals) IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'proposals');
UPDATE sqlite_sequence SET seq = (SELECT seq FROM _seq_capture_proposals)
  WHERE name = 'proposals'
    AND (SELECT seq FROM _seq_capture_proposals) IS NOT NULL
    AND seq < (SELECT seq FROM _seq_capture_proposals);

DROP TABLE _seq_capture_proposals;

-- ---------- (c) maintainer_queue: widen kind by constitution_fidelity ----------
--
-- Column order here already matches schema.sql's rollup (this table has
-- never been ALTERed since migration 0004 created it), so the rebuild
-- carries no reordering, only the widened CHECK -- the same explicit-
-- column-list, pragma, and sequence discipline still applies regardless.
-- Nothing else in the schema references maintainer_queue by foreign key,
-- so this rebuild carries no inbound-FK hazard (it still has its OWN
-- outbound FK to maintainer_runs, unaffected by any of this).

CREATE TEMP TABLE _seq_capture_maintainer_queue AS SELECT seq FROM sqlite_sequence WHERE name = 'maintainer_queue';

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

INSERT INTO sqlite_sequence (name, seq)
  SELECT 'maintainer_queue', (SELECT seq FROM _seq_capture_maintainer_queue)
  WHERE (SELECT seq FROM _seq_capture_maintainer_queue) IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM sqlite_sequence WHERE name = 'maintainer_queue');
UPDATE sqlite_sequence SET seq = (SELECT seq FROM _seq_capture_maintainer_queue)
  WHERE name = 'maintainer_queue'
    AND (SELECT seq FROM _seq_capture_maintainer_queue) IS NOT NULL
    AND seq < (SELECT seq FROM _seq_capture_maintainer_queue);

DROP TABLE _seq_capture_maintainer_queue;

PRAGMA defer_foreign_keys = off;
