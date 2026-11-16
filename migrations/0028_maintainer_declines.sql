-- 0028: the parked list (drafts/BRIEF-PARKED-LIST-2026-11-16.md, D-083). ADDITIVE ONLY: one CREATE TABLE, no rebuild of maintainer_queue (L-016).
-- One row per recorded model decline: which queue item, in which judgment wake, when. Nothing is backfilled: the 15 November 2026 decline of one item predates this table.
-- Plain CREATE TABLE (not IF NOT EXISTS) on purpose: a second apply must fail loudly, not pass silently over a half-known state.
-- schema.sql carries the block below byte for byte, from the CREATE TABLE to the end of the file's 0028 block.
CREATE TABLE maintainer_declines (
  queue_id    INTEGER NOT NULL REFERENCES maintainer_queue(id),
  run_id      INTEGER NOT NULL REFERENCES maintainer_runs(id),
  declined_at INTEGER NOT NULL,
  PRIMARY KEY (queue_id, run_id)
);
