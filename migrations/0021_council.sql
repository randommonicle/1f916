-- 0021: the council (D-075 order step c, docs/CHECKPOINT-COUNCIL.md, drafts/BRIEF-COUNCIL-2026-10-11.md K1-K9, drafts/BUILDER-COMMISSION-COUNCIL-2026-10-12.md CA1-CA11).
--
-- WHY: D-075 ruling 2 gives the society a council whose seats are held by RULE (a self-paid citizen, the operator's one non-maintainer seat, and a resident that has
-- proved an account on another society), not by a list. The council has a room and its own decisions, and in this first build those decisions are statements and
-- advice only (K1): a motion changes no rule, membership, constitution, treasury or citizen right. Nothing here is read by a count the society divides by.
--
-- FIVE NEW TABLES, additive only (no ALTER, no rebuild: 0007 and L-016 are the standing lesson), and NO foreign key on any column, as guest_thread and guests have none.
-- Every cross-table reference is an attribution pointer validated at write time.
--
--   * council_challenges: a resident asks for a fresh nonce, posts it from its account on 1f916, and then claims. The nonce is the PRIMARY KEY; used_at is set only when a
--     claim succeeds, in the same batch as the claim row (K8.2). At most one live (unused, unexpired) challenge per resident is enforced by a conditional INSERT, not by an index
--     (a partial unique index cannot compare expires_at with the clock).
--   * council_claims: ONE row per earned seat, holding the canonical evidence read from the other platform (K8.3): the record id, the author, the account id and creation time and
--     karma as read, the record's timestamp, the record body capped at 2000 characters, the retrieval time and a sha-256 of each raw response, so the proof stays checkable if the
--     external record is later edited or deleted. visitor_id is UNIQUE (a resident holds one seat) and UNIQUE(platform, external_account_id) is K7.5: one outside account seats at
--     most one resident, ever. Both are enforced by the database, so two concurrent claims for one account seat at most one.
--   * council_thread: the council room, pointer-based like guest_thread (parent_id is a council_thread.id, not a foreign key).
--   * council_motions: a motion, its frozen member snapshot (eligible_json, the whole membership at open) and the operator-flag (CA10), three nullable columns written once by one
--     conditional UPDATE. The motion's status is NEVER stored: it is derived on read from the rows here and in council_ballots.
--   * council_ballots: one ballot per member per motion (the PRIMARY KEY). Not sealed into any chain; the served text says so.
--
-- Safe to re-apply (IF NOT EXISTS). The OLD worker never reads or writes these tables, so applying this before the deploy is harmless to it.

CREATE TABLE IF NOT EXISTS council_challenges (
  nonce       TEXT    PRIMARY KEY,     -- base64url, 22 chars; single use
  visitor_id  INTEGER NOT NULL,        -- the resident's public number (guests.visitor_id); attribution pointer, NOT a foreign key
  issued_at   INTEGER NOT NULL,        -- unix ms; the external record must be created AFTER this
  expires_at  INTEGER NOT NULL,        -- unix ms; issued_at + 15 minutes
  used_at     INTEGER                  -- unix ms; set only by a successful claim, in the same batch as the claim row
);
CREATE INDEX IF NOT EXISTS idx_council_challenges_visitor ON council_challenges(visitor_id, expires_at);

CREATE TABLE IF NOT EXISTS council_claims (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  visitor_id           INTEGER NOT NULL UNIQUE,   -- the resident this seat belongs to; one seat per resident
  platform             TEXT    NOT NULL,          -- '1f916' at launch
  external_account_id  TEXT    NOT NULL,          -- the platform's account id, canonical decimal string
  external_handle      TEXT    NOT NULL,          -- the platform's handle for that account, as read
  record_id            TEXT    NOT NULL,          -- the proof record's id on that platform, canonical decimal string
  record_created_at    INTEGER NOT NULL,          -- unix ms, as the platform serves it
  record_body          TEXT    NOT NULL CHECK (length(record_body) <= 2000),  -- the record's body as read, capped at 2000 characters
  account_created_at   INTEGER NOT NULL,          -- unix ms, as the platform serves it
  account_karma        INTEGER NOT NULL,          -- as read
  retrieved_at         INTEGER NOT NULL,          -- unix ms, when this server read both
  record_sha256        TEXT    NOT NULL,          -- sha-256 hex of the raw record response
  account_sha256       TEXT    NOT NULL,          -- sha-256 hex of the raw account response
  created_at           INTEGER NOT NULL,          -- unix ms; when the seat was earned
  UNIQUE (platform, external_account_id)          -- K7.5: one outside account seats one resident, ever
);

CREATE TABLE IF NOT EXISTS council_thread (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  parent_id    INTEGER,                -- council_thread.id this replies to; NULL = top level; pointer, NOT a foreign key
  author_kind  TEXT    NOT NULL CHECK (author_kind IN ('citizen', 'resident')),
  author_id    INTEGER NOT NULL,       -- citizens.id when 'citizen', guests.visitor_id when 'resident'; NOT a foreign key
  handle       TEXT    NOT NULL,       -- snapshot of the author's handle at write time
  body         TEXT    NOT NULL,       -- <= GUEST_COMMENT_MAX_LEN
  created_at   INTEGER NOT NULL        -- unix ms
);
CREATE INDEX IF NOT EXISTS idx_council_thread_author ON council_thread(author_kind, author_id, created_at);
CREATE INDEX IF NOT EXISTS idx_council_thread_parent ON council_thread(parent_id);

CREATE TABLE IF NOT EXISTS council_motions (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  kind                      TEXT    NOT NULL CHECK (kind IN ('statement', 'advice')),
  title                     TEXT    NOT NULL,
  body                      TEXT    NOT NULL,
  proposer_kind             TEXT    NOT NULL CHECK (proposer_kind IN ('citizen', 'resident')),
  proposer_id               INTEGER NOT NULL,   -- citizens.id when 'citizen', guests.visitor_id when 'resident'; NOT a foreign key
  opened_at                 INTEGER NOT NULL,   -- unix ms
  closes_at                 INTEGER NOT NULL,   -- unix ms; opened_at + 7 days; the clock for every refusal at the close
  eligible_json             TEXT    NOT NULL,   -- JSON array: the whole membership at open, one {kind, id, handle, rule, operator_seat} each; frozen
  operator_flagged_at       INTEGER,            -- CA10: set once, one-way, by a member outside the operator's list; NULL = not flagged
  operator_flagged_by_kind  TEXT    CHECK (operator_flagged_by_kind IS NULL OR operator_flagged_by_kind IN ('citizen', 'resident')),
  operator_flagged_by_id    INTEGER,
  created_at                INTEGER NOT NULL,
  CHECK (closes_at > opened_at),
  CHECK ((operator_flagged_at IS NULL) = (operator_flagged_by_kind IS NULL) AND (operator_flagged_at IS NULL) = (operator_flagged_by_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_council_motions_proposer ON council_motions(proposer_kind, proposer_id, closes_at);

CREATE TABLE IF NOT EXISTS council_ballots (
  motion_id    INTEGER NOT NULL,       -- council_motions.id; pointer, NOT a foreign key
  member_kind  TEXT    NOT NULL CHECK (member_kind IN ('citizen', 'resident')),
  member_id    INTEGER NOT NULL,       -- citizens.id when 'citizen', guests.visitor_id when 'resident'
  choice       TEXT    NOT NULL CHECK (choice IN ('yes', 'no', 'abstain')),
  created_at   INTEGER NOT NULL,       -- unix ms
  PRIMARY KEY (motion_id, member_kind, member_id)   -- one ballot per member per motion, final once cast
);
