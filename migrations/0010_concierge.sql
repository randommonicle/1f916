-- The engagement concierge (docs/DESIGN-CONCIERGE.md, migrations/0010_concierge.sql).
-- One new, purely additive table -- this feature's own operational run log,
-- the same role maintainer_runs plays for the clerk/judge, kept separate
-- rather than widening maintainer_runs.kind's existing
-- CHECK (kind IN ('clerk', 'judgment')): widening that CHECK means
-- rebuilding maintainer_runs, a table maintainer_queue.run_id holds a live
-- foreign key into -- exactly the class of hazard migration 0007 spent an
-- entire session on (DETACH/REBUILD/REATTACH, L-016's "D1 honours
-- defer_foreign_keys for a single-FK drop but not a multi-FK one"). A
-- brand-new CREATE TABLE IF NOT EXISTS, by contrast, is the shape every
-- migration in this codebase has used without incident for new
-- functionality (0003, 0004, 0005, 0008, 0009) -- no existing table
-- touched, no existing FK relationship disturbed.
--
-- No FK to maintainer_runs or anything else -- mirrors showhome_notes' own
-- "attribution pointer; NOT a foreign key" precedent rather than
-- maintainer_queue's FK-to-runs shape, since nothing here needs
-- referential integrity against a run this table is not itself the
-- run-log for.
--
-- The identity_events 'concierge_engagement' kind (design doc §8.5) needs
-- NO migration -- that column carries no CHECK constraint (schema.sql,
-- comment: 'key_rotation', 'model_correction', ...; free text).
--
-- Run once against the live database (operator's hand; a builder never runs
-- --remote), applied BEFORE the matching Worker deploy so the code never
-- reads a table that is not yet there:
--   wrangler d1 execute commonhold --remote --file=migrations/0010_concierge.sql
--
-- schema.sql carries this same table verbatim (the test harness,
-- test/helpers/local-d1.ts, loads schema.sql, not the migrations); keep the
-- two identical. test/concierge-migration-d1.test.ts rehearses THIS file on
-- a fresh in-memory D1-shaped SQLite and asserts the post-apply catalog
-- below (db-migration-verification).

CREATE TABLE IF NOT EXISTS concierge_runs (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at          INTEGER NOT NULL,
  finished_at         INTEGER,
  candidates_seen     INTEGER,            -- rows the two detection queries returned, combined
  attempts_made       INTEGER NOT NULL DEFAULT 0,
  engaged             INTEGER NOT NULL DEFAULT 0,  -- 0 or 1: did it actually post
  target_type         TEXT CHECK (target_type IN ('post', 'comment') OR target_type IS NULL),
  target_id           INTEGER,
  comment_id          INTEGER,            -- the resulting comment's own id, once posted
  tokens_in           INTEGER,
  tokens_out          INTEGER,
  cost_estimate_cents REAL,
  deny_reason         TEXT,               -- the matched category string only, NEVER the refused text (ai-surface-discipline: log the class, not the value)
  skipped_reason      TEXT,               -- 'no candidates' | 'budget' | 'no api key' | ...
  error               TEXT
);
CREATE INDEX IF NOT EXISTS idx_concierge_runs_started ON concierge_runs(started_at DESC);

-- ============================================================================
-- POST-APPLY CATALOG VERIFICATION (db-migration-verification).
-- Run these READ-ONLY queries after applying the migration to real D1; they
-- read catalog state directly (sqlite_master / pragma), independent of any
-- runtime test. Expected results are stated inline.
--
--   -- 1. The table and its index both exist (expect 2 rows):
--   SELECT type, name FROM sqlite_master
--   WHERE name IN ('concierge_runs', 'idx_concierge_runs_started')
--   ORDER BY type, name;
--
--   -- 2. concierge_runs has exactly its 15 columns:
--   SELECT name FROM pragma_table_info('concierge_runs') ORDER BY name;
--   -- expect: attempts_made, candidates_seen, comment_id, cost_estimate_cents,
--   --         deny_reason, engaged, error, finished_at, id, skipped_reason,
--   --         started_at, target_id, target_type, tokens_in, tokens_out
--
--   -- 3. No foreign key on concierge_runs (the additive/no-FK guarantee,
--   --    expect 0 rows):
--   SELECT * FROM pragma_foreign_key_list('concierge_runs');
--
--   -- 4. The target_type CHECK constraint text is present:
--   SELECT sql FROM sqlite_master WHERE name = 'concierge_runs';
-- ============================================================================
