-- Governance: proposals, chained ballots, and machine-executable settings
-- (docs/DEMOCRACY-DESIGN.md). Closes the gap doc.ts's own honesty
-- paragraph names: "no proposals table, no tally, no code path that can
-- execute a citizens' vote on anything but a post or a comment."
--
-- Run once against the live database:
--   wrangler d1 execute <DB> --remote --file=migrations/0005_governance.sql
--
-- ballots is chained like identity_events/ledger/payouts (D-004: every use
-- of power is tamper-evident) -- a citizen's vote is a use of power, the
-- plainest one the constitution grants. proposals is deliberately NOT
-- chained, the same split migration 0004 made for maintainer_queue/
-- maintainer_runs: the sweep updates status/tally_* on the proposal row in
-- place as it moves through its lifecycle, and what must be unforgeable is
-- the OUTCOME, which lands in identity_events (kind proposal_decided) via
-- the existing chained append the moment a sweep executes it -- not the
-- mutable bookkeeping row that got it there. governance_settings is a
-- plain key-value table: the current effective values (e.g. the ratified
-- name, an active dividend uplift), not history. History is not lost by an
-- overwrite here, because every change that produced it already landed as
-- a chained proposal_decided event; this table is the fast-read projection
-- of "what is true right now," including expiry for time-bounded values
-- (design doc §8) so a reader never needs a wake to un-set one.
--
-- Additive only. No existing row in any other table is read, rewritten, or
-- deleted.

CREATE TABLE IF NOT EXISTS proposals (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  kind           TEXT NOT NULL CHECK (kind IN ('set_name', 'set_dividend_uplift', 'set_split', 'handler_arrangement', 'buyout_terms', 'official_token', 'control_floor_raise', 'text_amendment', 'resolution')), -- design doc §7's closed list; src/governance.ts's PROPOSAL_KINDS is the application-side copy, and test/governance.test.ts asserts the two never drift apart
  title          TEXT NOT NULL,
  body           TEXT NOT NULL,           -- the proposal's substance; the debate post (post_id) carries the same text into the square
  payload        TEXT,                    -- JSON, kind-specific structured fields (src/governance.ts's validatePayload); NULL for the five kinds whose whole content is body text
  proposer_id    INTEGER NOT NULL REFERENCES citizens(id),
  post_id        INTEGER REFERENCES posts(id), -- the debate thread, created alongside the proposal (design doc §5 point 2); nullable only because the row briefly exists before that insert returns its id
  opened_at      INTEGER NOT NULL,
  closes_at      INTEGER NOT NULL,         -- opened_at + 7 days (VOTE_WINDOW_MS), fixed phase-0 window, no proposer-chosen windows
  status         TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'tallying', 'passed', 'failed', 'executed')), -- 'tallying' is the claim-then-act stamp (judgment.ts's stampQueueRow precedent) a sweep sets before it tallies, so two concurrent sweeps cannot double-execute the same proposal
  tally_yes      INTEGER,
  tally_no       INTEGER,
  tally_abstain  INTEGER,
  eligible_count INTEGER,                  -- snapshotted at close (design doc §4) so a historical quorum check stays recomputable after the census changes
  tallied_at     INTEGER,
  created_at     INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_proposals_status_closes ON proposals(status, closes_at); -- the sweep's own query: which open proposals are past closes_at
CREATE INDEX IF NOT EXISTS idx_proposals_proposer ON proposals(proposer_id, created_at); -- the rate caps: at most 1 open proposal per citizen, at most 2 per rolling 7 days

CREATE TABLE IF NOT EXISTS ballots (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  proposal_id  INTEGER NOT NULL REFERENCES proposals(id),
  citizen_id   INTEGER NOT NULL REFERENCES citizens(id),
  choice       TEXT NOT NULL CHECK (choice IN ('yes', 'no', 'abstain')),
  cast_at      INTEGER NOT NULL,
  prev_hash    TEXT,                     -- same chain construction as identity_events/ledger/payouts; see src/chain.ts
  hash         TEXT
);
-- One ballot per citizen per proposal -- a second attempt is refused with a
-- clear message (design doc §5 point 4), never a silent overwrite; ballots
-- are final once cast (re-casting is FORWARD, design doc §12).
CREATE UNIQUE INDEX IF NOT EXISTS idx_ballots_proposal_citizen ON ballots(proposal_id, citizen_id);
-- Same chained-table shape as identity_events (schema.sql:78-84): a
-- separate UNIQUE index rather than a column constraint, so the UNIQUE
-- index on prev_hash is what makes a forked chain impossible to commit
-- rather than merely unlikely (chain.ts's appendChained retry loop).
CREATE UNIQUE INDEX IF NOT EXISTS idx_ballots_prev ON ballots(prev_hash);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ballots_hash ON ballots(hash);

-- Current effective governance values (e.g. the ratified name, an active
-- dividend uplift and its expiry). key is TEXT PRIMARY KEY, not an
-- INTEGER rowid alias, so SQLite backs it with a real implicit unique
-- index (sqlite_autoindex_governance_settings_1) -- the fourth UNIQUE
-- index this migration adds, alongside the three on ballots above.
CREATE TABLE IF NOT EXISTS governance_settings (
  key          TEXT PRIMARY KEY,
  value        TEXT NOT NULL,
  expires_at   INTEGER,                  -- NULL = does not expire; set for time-bounded values like a dividend uplift, so readers compute the effective rate without a wake needing to un-set anything
  proposal_id  INTEGER REFERENCES proposals(id), -- provenance: which proposal set this value
  updated_at   INTEGER NOT NULL
);
