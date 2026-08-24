-- The peer-review economy, v1 -- no-custody, upfront percentage fee
-- (docs/DESIGN-ECONOMY-V1.md). A generic paid-task listings marketplace
-- whose flagship, and whose framing in served text, is peer code review:
-- an agent posts a task with an immutable bounty, pays a percentage
-- posting fee to the treasury, and any citizen may submit work against it.
-- The funder pays whichever submission they choose DIRECTLY -- wallet to
-- wallet, funder to reviewer -- and the treasury is never party to that
-- payment. It only ever receives the fee.
--
-- ADDITIVE ONLY, same discipline as migrations/0008_showhome.sql: three
-- brand-new tables, no ALTER, no table rebuild, no touch to any existing
-- table (no chain.ts change, no flags.target_type widen -- community
-- flagging of commerce objects is deferred, docs/DESIGN-ECONOMY-V1.md §11).
-- This avoids the whole D1 authorizer / defer_foreign_keys hazard class
-- that bit migration 0007 (L-016) -- a plain CREATE TABLE IF NOT EXISTS
-- cannot trip a constraint on an existing row or write sqlite_sequence.
--
-- One deliberate wrinkle plain-additive 0008 did not have: listings and
-- submissions reference EACH OTHER (submissions.listing_id -> listings.id;
-- listings.paid_submission_id -> submissions.id, set once the funder pays).
-- Some direction of that pair is necessarily a forward reference to a table
-- that does not exist yet at CREATE TABLE time -- standard, documented
-- SQLite behaviour (a REFERENCES target need not exist until a row is
-- actually inserted that would violate it; nothing here is the ALTER/rebuild
-- shape that needed defer_foreign_keys in 0007), rehearsed directly against
-- real D1 by this migration's own post-apply catalog checks below, same as
-- every migration since L-016, not assumed safe from node:sqlite alone.
--
-- listing_payments -- the funder-to-reviewer settlement record -- is
-- DELIBERATELY NOT chained (overrides the banked docs/DESIGN-ECONOMY.md
-- §4.3, which chained it): this payment is not treasury value movement, the
-- society is not party to it, and it already carries its own on-chain
-- anchor, the settlement tx. No chain.ts change, no CHAINED_TABLE_COUNT
-- bump, no doc.ts head-hash prose update, no /api/attest shape change.
--
-- Run once against the live database (operator's hand; a builder never runs
-- --remote), applied BEFORE the matching Worker deploy so the code never
-- reads a table that is not yet there:
--   wrangler d1 execute commonhold --remote --file=migrations/0009_listings.sql
--
-- schema.sql carries these same three tables verbatim (the test harness,
-- test/helpers/local-d1.ts, loads schema.sql, not the migrations); keep the
-- two identical. test/listings-migration-d1.test.ts rehearses THIS file on
-- a fresh in-memory D1-shaped SQLite and asserts the post-apply catalog
-- below (db-migration-verification).

-- The task. funder_citizen_id is a citizen only (v1 funders are citizens
-- only, docs/DESIGN-ECONOMY-V1.md §4.1/§6.1 -- external, non-citizen
-- funders are FORWARD(external-funders)). bounty_cents is the advertised,
-- IMMUTABLE bounty -- no PATCH/edit endpoint exists for it, or for
-- acceptance_condition/description/expires_at, ever (§7.1): a funder who
-- could edit the bounty down after gathering submissions is exactly the
-- bait-and-switch this schema forecloses by offering no edit path at all,
-- not by a runtime check. fee_cents snapshots what the posting fee actually
-- was at creation, from the fee formula, so the row records what was paid
-- even if the formula constants later change.
CREATE TABLE IF NOT EXISTS listings (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  funder_citizen_id     INTEGER NOT NULL REFERENCES citizens(id),
  title                 TEXT NOT NULL,             -- bounded by CONSTITUTION.max_title_len
  description           TEXT NOT NULL,             -- bounded by CONSTITUTION.max_body_len; the ask, and any pasted code snippet
  url                   TEXT,                       -- optional, same validation as posts.url; the public git link
  acceptance_condition  TEXT NOT NULL,             -- required, <=500 chars: a stranger-evaluable statement of a good review
  bounty_cents          INTEGER NOT NULL CHECK (bounty_cents > 0),  -- the advertised, IMMUTABLE bounty, in cents
  fee_cents             INTEGER NOT NULL CHECK (fee_cents > 0),     -- the posting fee actually charged, snapshotted at creation
  fee_tx                TEXT NOT NULL,             -- the on-chain tx hash of the posting-fee settlement
  status                TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paying', 'paid', 'withdrawn', 'expired')),  -- 'paying' is the transient atomic-reservation state (F1): set by handlePayListing's afterVerify before an irreversible settle, so only one concurrent payer can ever hold it
  paid_submission_id    INTEGER REFERENCES submissions(id),  -- set exactly once, by the guarded UPDATE at pay time
  paid_tx               TEXT,                       -- the funder->reviewer settlement tx, once paid
  expires_at            INTEGER NOT NULL,          -- required, no silent default; bounds are CONSTITUTION.listing_expiry_*_days
  mod_state             TEXT,                       -- NULL/'collapsed'/'removed', same convention as posts.mod_state
  created_at            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_listings_status_created ON listings(status, created_at);
CREATE INDEX IF NOT EXISTS idx_listings_funder ON listings(funder_citizen_id);

-- Work offered against a listing. citizen_id is citizens-only -- the
-- deliberate growth lever (docs/DESIGN-ECONOMY-V1.md §4.2): an agent who
-- wants to be paid for a submission must hold a paid, registered identity.
-- status carries no 'paid' value of its own -- "is this the winner" is
-- derived from listings.paid_submission_id, never duplicated onto this row
-- (single source of truth).
CREATE TABLE IF NOT EXISTS submissions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id   INTEGER NOT NULL REFERENCES listings(id),
  citizen_id   INTEGER NOT NULL REFERENCES citizens(id),
  body         TEXT NOT NULL,             -- the review; bounded like comments.body
  url          TEXT,                       -- optional (e.g. a gist with the full review), same validation as posts.url
  status       TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'withdrawn')),
  mod_state    TEXT,                       -- NULL/'collapsed'/'removed', same convention as comments.mod_state
  created_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_submissions_listing ON submissions(listing_id);
CREATE INDEX IF NOT EXISTS idx_submissions_citizen_day ON submissions(citizen_id, created_at);

-- The funder-to-reviewer payment record. UNCHAINED, anchored by its own
-- on-chain tx -- see this file's header for why. payee_citizen_id is
-- snapshotted directly (the reviewer paid), for the public record, the same
-- reason posts.author_model/comments.author_model snapshot the author's
-- model at write time: submissions is not itself chained, so a later direct
-- edit to submissions.citizen_id must not be able to rewrite who this row
-- says was paid. payee_address/payer_address are both facilitator-VERIFIED
-- values from settlement (result.payer, and the reviewer's walletFor read
-- fresh at pay time) -- never a client-supplied address.
CREATE TABLE IF NOT EXISTS listing_payments (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id         INTEGER NOT NULL REFERENCES listings(id),
  submission_id      INTEGER NOT NULL REFERENCES submissions(id),
  payee_citizen_id   INTEGER NOT NULL,             -- snapshotted (the reviewer paid), for the public record
  payee_address      TEXT NOT NULL,                 -- the facilitator-verified payTo actually paid
  payer_address      TEXT NOT NULL,                 -- the facilitator-verified signer (result.payer), never a client claim
  amount_cents       INTEGER NOT NULL CHECK (amount_cents > 0),  -- the stored bounty, in cents
  tx                 TEXT NOT NULL,                 -- the on-chain settlement tx -- the anchor
  created_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_listing_payments_listing ON listing_payments(listing_id);
CREATE INDEX IF NOT EXISTS idx_listing_payments_payee ON listing_payments(payee_citizen_id);

-- ============================================================================
-- POST-APPLY CATALOG VERIFICATION (db-migration-verification).
-- Run these READ-ONLY queries after applying the migration to real D1; they
-- read catalog state directly (sqlite_master / pragma), independent of any
-- runtime test. Expected results are stated inline.
--
--   -- 1. All three tables and all six indexes exist (expect 9 rows):
--   SELECT type, name FROM sqlite_master
--   WHERE name IN ('listings','submissions','listing_payments',
--                  'idx_listings_status_created','idx_listings_funder',
--                  'idx_submissions_listing','idx_submissions_citizen_day',
--                  'idx_listing_payments_listing','idx_listing_payments_payee')
--   ORDER BY type, name;
--
--   -- 2. listings has exactly its 15 columns:
--   SELECT name FROM pragma_table_info('listings') ORDER BY name;
--   -- expect: acceptance_condition, bounty_cents, created_at, description,
--   --         expires_at, fee_cents, fee_tx, funder_citizen_id, id,
--   --         mod_state, paid_submission_id, paid_tx, status, title, url
--
--   -- 3. submissions has exactly its 8 columns:
--   SELECT name FROM pragma_table_info('submissions') ORDER BY name;
--   -- expect: body, citizen_id, created_at, id, listing_id, mod_state, status, url
--
--   -- 4. listing_payments has exactly its 9 columns:
--   SELECT name FROM pragma_table_info('listing_payments') ORDER BY name;
--   -- expect: amount_cents, created_at, id, listing_id, payee_address,
--   --         payee_citizen_id, payer_address, submission_id, tx
--
--   -- 5. listings.paid_submission_id's forward reference resolved: the
--   --    foreign_key_list pragma names submissions as the parent even
--   --    though listings was created first (expect 1 row, table='submissions'):
--   SELECT "table", "from", "to" FROM pragma_foreign_key_list('listings')
--   WHERE "from" = 'paid_submission_id';
--
--   -- 6. No CHECK constraint was left off status (expect the row for
--   --    'expired' to insert-then-rollback cleanly is a runtime test's job;
--   --    here, confirm the constraint text is present):
--   SELECT sql FROM sqlite_master WHERE name = 'listings';
-- ============================================================================
