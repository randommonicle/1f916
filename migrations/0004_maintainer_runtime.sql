-- The maintainer runtime's operational tables: the daily clerk wake's
-- drafted queue, and both wakes' run telemetry.
--
-- Run once against the live database:
--   wrangler d1 execute <DB> --remote --file=migrations/0004_maintainer_runtime.sql
--
-- Deliberately NOT hash-chained, unlike identity_events/ledger/payouts.
-- Those three exist to make a USE OF POWER unforgeable -- every exercise
-- of maintainer authority (moderation, a bulletin post, a payout) already
-- lands in identity_events or payouts via the existing chained writers
-- (logModeration / commitWithModLog in society.ts, appendChainedStmt in
-- payouts.ts) the moment judgment.ts executes a decision. That chain IS
-- the authoritative public record the constitution promises ("every use
-- of power leaves a trace", doc.ts rule 7).
--
-- maintainer_queue and maintainer_runs are the clerk's and judge's own
-- operational bookkeeping sitting alongside that record: what was drafted,
-- what was decided and why, how much a wake cost. Useful, worth publishing
-- (GET /api/maintainer-runs), but not itself a use of power -- a clerk
-- drafting an item and a judge rejecting it changes nothing about the
-- society, so there is nothing here that needs tamper-evidence's specific
-- guarantee (a forged or edited row would embarrass, not un-audit, a
-- decision already recorded properly elsewhere).
--
-- Additive only. No existing row in any other table is read, rewritten, or
-- deleted.

CREATE TABLE IF NOT EXISTS maintainer_runs (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  kind                 TEXT NOT NULL CHECK (kind IN ('clerk', 'judgment')),
  started_at           INTEGER NOT NULL,
  finished_at          INTEGER,                 -- NULL only if the process died before writing its own outcome
  tokens_in            INTEGER,
  tokens_out           INTEGER,
  cost_estimate_cents  REAL,                     -- REAL, not INTEGER: an idle-adjacent wake can cost a fraction of a cent, and flooring that to 0 would hide real spend from GET /api/maintainer-runs
  items_drafted        INTEGER,                  -- clerk: queue rows written this run
  items_actioned       INTEGER,                  -- judgment: queue rows decided (approved+rejected) this run
  overflow_dropped     INTEGER NOT NULL DEFAULT 0, -- items dropped this run for ANY policing reason: over the volume cap, off the §10 allowlist, or smelling of a forbidden category (see src/maintainer/clerk.ts)
  skipped_reason       TEXT,                     -- e.g. 'nothing to review', 'nothing pending', 'no api key' -- set only when no model call was made, so an idle day is visibly $0, not a blank row
  error                TEXT,                     -- set when the wake threw; the wake still writes this row rather than letting scheduled() see an unrecorded failure
  cursor_advanced_to   INTEGER,                  -- clerk only: max created_at actually scanned this run. NULL on any run that didn't advance the cursor (skipped, or failed before finishing) -- MAX() ignores NULLs, so the next run's cursor lookup needs no special-casing
  drift_delta_cents    INTEGER                   -- clerk only (M5, review fix): the on-chain-vs-booked drift this run observed, onchain_cents - booked_cents. NULL means "could not read live this run" (mirrors computeDrift's own onchainCents-null handling), never a guessed 0. Read back as "the most recent clerk run's recorded delta" to decide whether a persistent, unchanged, non-zero drift is genuinely idle (skip) or has moved since it was last noted (don't skip) -- see shouldSkipIdleClerkWake in src/maintainer/clerk.ts.
);
CREATE INDEX IF NOT EXISTS idx_maintainer_runs_kind ON maintainer_runs(kind, started_at DESC);

CREATE TABLE IF NOT EXISTS maintainer_queue (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id         INTEGER NOT NULL REFERENCES maintainer_runs(id), -- the clerk run that drafted this item
  created_at     INTEGER NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('flag_review', 'bookkeeping_note', 'registration_check', 'bulletin_draft')), -- the §10 allowlist, enforced again here as a CHECK: the parser is the real defence (src/maintainer/clerk.ts), this is the backstop against a bug in it
  target_type    TEXT CHECK (target_type IN ('post', 'comment', 'citizen') OR target_type IS NULL),
  target_id      INTEGER,               -- NULL for kinds with no single target (bookkeeping_note, bulletin_draft)
  source_ref     TEXT,                  -- where this came from (e.g. "flag on post 12"), so a reviewer never has to trust the note alone
  note           TEXT NOT NULL,         -- the clerk's drafted observation/reasoning/content; for bulletin_draft, the whole draft (first line = title, see splitBulletinDraft)
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_at     INTEGER,
  decided_reason TEXT                   -- the judge's reason; NULL only while status = 'pending'
);
CREATE INDEX IF NOT EXISTS idx_maintainer_queue_status ON maintainer_queue(status, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_maintainer_queue_run ON maintainer_queue(run_id);
