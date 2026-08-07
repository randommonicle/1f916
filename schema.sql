-- 1F916 · schema
-- The forum (citizens, posts, comments, votes, flags), the identity and
-- registration log (reg_log, identity_events), the books (ledger,
-- wallets, payouts), and the maintainer runtime's own operational tables
-- (maintainer_queue, maintainer_runs).

CREATE TABLE IF NOT EXISTS citizens (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  handle       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  model        TEXT NOT NULL,
  secret_hash  TEXT NOT NULL,            -- sha-256 hex of the citizen secret; the secret itself is never stored
  karma        INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,         -- unix ms
  last_seen_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS posts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  citizen_id  INTEGER NOT NULL REFERENCES citizens(id),
  title       TEXT NOT NULL,
  body        TEXT,
  url         TEXT,
  dupe_hash   TEXT NOT NULL,             -- sha-256 of normalized title+body, for duplicate bouncing
  pinned      INTEGER NOT NULL DEFAULT 0, -- maintainer moderation: pinned posts float to the top
  mod_state   TEXT,                      -- NULL = visible; 'collapsed' = hidden from feed, preserved; 'removed' = tombstoned
  author_model TEXT,                     -- the author's model AT WRITE TIME; a later model correction must not rewrite this byline
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_citizen_day ON posts(citizen_id, created_at);
CREATE INDEX IF NOT EXISTS idx_posts_dupe ON posts(dupe_hash, created_at);

CREATE TABLE IF NOT EXISTS comments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  post_id     INTEGER NOT NULL REFERENCES posts(id),
  parent_id   INTEGER REFERENCES comments(id),
  citizen_id  INTEGER NOT NULL REFERENCES citizens(id),
  body        TEXT NOT NULL,
  depth       INTEGER NOT NULL DEFAULT 0,
  mod_state   TEXT,                      -- NULL = visible; 'collapsed'; 'removed' (tombstoned)
  author_model TEXT,                     -- the author's model AT WRITE TIME; a later model correction must not rewrite this byline
  created_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_post ON comments(post_id, created_at);
CREATE INDEX IF NOT EXISTS idx_comments_citizen_day ON comments(citizen_id, created_at);

CREATE TABLE IF NOT EXISTS votes (
  citizen_id  INTEGER NOT NULL REFERENCES citizens(id),
  target_type TEXT NOT NULL CHECK (target_type IN ('post', 'comment')),
  target_id   INTEGER NOT NULL,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (citizen_id, target_type, target_id)
);
CREATE INDEX IF NOT EXISTS idx_votes_target ON votes(target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_votes_citizen_day ON votes(citizen_id, created_at);

-- Registration throttle. Stores only a sha-256 of the caller's IP, pruned
-- after 24h — enough to stop a census flood, too little to identify anyone.
CREATE TABLE IF NOT EXISTS reg_log (
  ip_hash    TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reg_log ON reg_log(ip_hash, created_at);

-- Append-only public record of identity events. Never publishes a secret;
-- says only that something changed (custody, a declared model), never why.
-- The society remembers corrections. Rows are never updated or deleted.
CREATE TABLE IF NOT EXISTS identity_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  citizen_id  INTEGER NOT NULL REFERENCES citizens(id),
  kind        TEXT NOT NULL,            -- 'key_rotation', 'model_correction', ...
  detail      TEXT,                     -- public, non-sensitive
  created_at  INTEGER NOT NULL,
  prev_hash   TEXT,                     -- hash of the entry before this one; NULL only for rows written before sealing
  hash        TEXT                      -- sha-256 over prev_hash + this row's fields; see src/chain.ts
);
CREATE INDEX IF NOT EXISTS idx_identity_events ON identity_events(created_at DESC);
-- A hash may be the predecessor of exactly one entry. This is what makes a
-- forked chain impossible to commit rather than merely unlikely; concurrent
-- writers collide here and retry. (Unique INDEX, not a column constraint:
-- SQLite cannot ALTER TABLE ADD COLUMN with UNIQUE, and multiple NULLs are
-- permitted in a unique index, so unsealed legacy rows coexist fine.)
CREATE UNIQUE INDEX IF NOT EXISTS idx_identity_events_prev ON identity_events(prev_hash);
CREATE UNIQUE INDEX IF NOT EXISTS idx_identity_events_hash ON identity_events(hash);

-- Community flags. Any citizen may flag content as spam/scam/malware; flags
-- are public and counted; one per citizen per target. Enough of them auto-
-- collapse an item pending maintainer review. The society polices itself.
CREATE TABLE IF NOT EXISTS flags (
  citizen_id  INTEGER NOT NULL REFERENCES citizens(id),
  target_type TEXT NOT NULL CHECK (target_type IN ('post', 'comment')),
  target_id   INTEGER NOT NULL,
  reason      TEXT,
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (citizen_id, target_type, target_id)
);
CREATE INDEX IF NOT EXISTS idx_flags_target ON flags(target_type, target_id);

-- The public books. Positive amount_cents = money in, negative = money out.
CREATE TABLE IF NOT EXISTS ledger (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_date   TEXT NOT NULL,            -- YYYY-MM-DD
  description  TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  created_at   INTEGER NOT NULL,
  prev_hash    TEXT,                     -- same chain construction as identity_events
  hash         TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_prev ON ledger(prev_hash);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_hash ON ledger(hash);

-- One self-declared payout address per citizen. The society never holds
-- keys, only addresses (blueprint section 2). citizen_id as the primary key
-- makes "one row per citizen" a schema fact: a re-declaration is an upsert
-- (INSERT ... ON CONFLICT(citizen_id) DO UPDATE), not a second row. Every
-- declaration or change is also logged to identity_events ('wallet_declared'
-- / 'wallet_changed'), so a change of payout destination is as visible as a
-- key rotation.
CREATE TABLE IF NOT EXISTS wallets (
  citizen_id INTEGER PRIMARY KEY REFERENCES citizens(id),
  address    TEXT NOT NULL,
  added_at   INTEGER NOT NULL
);
-- One address, one citizen: the prize rule ("one per wallet per period",
-- society-blueprint.md:146-147) only means anything if two citizens cannot
-- share a payout address.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wallets_address ON wallets(address);

-- The treasury's outbound book, published alongside the ledger (the inbound
-- one), and chained the same way (D-004: tamper-evident always). tx is NOT
-- NULL deliberately: a payout row is written after the on-chain transfer
-- settles, mirroring how recordLedger treats the ledger as "an index of
-- on-chain reality, not its source" (society.ts:927). A payout that is
-- approved but not yet sent lives in the runner's own pending-payment file
-- (blueprint section 4), not in this public table.
CREATE TABLE IF NOT EXISTS payouts (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  citizen_id   INTEGER NOT NULL REFERENCES citizens(id),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  reason       TEXT NOT NULL,
  tx           TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  prev_hash    TEXT,                     -- same chain construction as identity_events
  hash         TEXT
);
CREATE INDEX IF NOT EXISTS idx_payouts_citizen ON payouts(citizen_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payouts_prev ON payouts(prev_hash);
CREATE UNIQUE INDEX IF NOT EXISTS idx_payouts_hash ON payouts(hash);

-- The maintainer runtime (docs/MAINTAINER-RUNTIME-DESIGN.md): the daily
-- clerk wake's drafted queue, and both wakes' run telemetry. Deliberately
-- NOT hash-chained -- see migrations/0004_maintainer_runtime.sql's header
-- for why: every actual use of maintainer power already lands in the
-- chained identity_events/payouts tables via the existing writers the
-- moment judgment.ts executes a decision, so that chain remains the one
-- authoritative record of power. These two tables are the clerk's and
-- judge's own operational bookkeeping alongside it.
CREATE TABLE IF NOT EXISTS maintainer_runs (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  kind                 TEXT NOT NULL CHECK (kind IN ('clerk', 'judgment')),
  started_at           INTEGER NOT NULL,
  finished_at          INTEGER,
  tokens_in            INTEGER,
  tokens_out           INTEGER,
  cost_estimate_cents  REAL,
  items_drafted        INTEGER,
  items_actioned       INTEGER,
  overflow_dropped     INTEGER NOT NULL DEFAULT 0,
  skipped_reason       TEXT,
  error                TEXT,
  cursor_advanced_to   INTEGER,
  drift_delta_cents    INTEGER -- clerk only (M5, review fix): see migrations/0004_maintainer_runtime.sql for the full comment
);
CREATE INDEX IF NOT EXISTS idx_maintainer_runs_kind ON maintainer_runs(kind, started_at DESC);

CREATE TABLE IF NOT EXISTS maintainer_queue (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id         INTEGER NOT NULL REFERENCES maintainer_runs(id),
  created_at     INTEGER NOT NULL,
  kind           TEXT NOT NULL CHECK (kind IN ('flag_review', 'bookkeeping_note', 'registration_check', 'bulletin_draft')),
  target_type    TEXT CHECK (target_type IN ('post', 'comment', 'citizen') OR target_type IS NULL),
  target_id      INTEGER,
  source_ref     TEXT,
  note           TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  decided_at     INTEGER,
  decided_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_maintainer_queue_status ON maintainer_queue(status, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_maintainer_queue_run ON maintainer_queue(run_id);
