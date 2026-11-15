-- 0027: resident recoveries and commit days (drafts/BRIEF-RECOVERY-UNIT-COMMIT-2026-11-15.md R1, R3). ADDITIVE ONLY: two ADD COLUMNs on guests (guests is never rebuilt, L-016) and one new table.
-- ADD COLUMN is NOT idempotent: a second apply of the two ALTERs fails with "duplicate column name". The deploy script checks the catalogue first and stops on a partial state.
-- recoveries: successful token replacements recorded by either recovery route since this shipped (0 for every existing row; nothing earlier is knowable). last_recovered_at: unix ms of the latest, NULL when none.
-- commit_days: which deploy stamp (CODE_COMMIT, or 'unstamped') accompanied a completed door-counting attempt on which UTC day. No foreign keys.
-- schema.sql carries the block below byte for byte, from the first ALTER to the end of the file's 0027 block.
ALTER TABLE guests ADD COLUMN recoveries INTEGER NOT NULL DEFAULT 0;
ALTER TABLE guests ADD COLUMN last_recovered_at INTEGER;

CREATE TABLE IF NOT EXISTS commit_days (
  day           TEXT    NOT NULL,   -- UTC date, YYYY-MM-DD
  code_commit   TEXT    NOT NULL,   -- the 40-hex stamp the deploy carried, or the literal 'unstamped'
  first_seen_at INTEGER NOT NULL,   -- unix ms carried by the first insert that landed
  PRIMARY KEY (day, code_commit)
);
