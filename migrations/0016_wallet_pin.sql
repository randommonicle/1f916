-- 0016: the server-side wallet pin (DEFERRED-SERVER-SIDE-WALLET-PIN,
-- docs/BRIEF-SERVER-SIDE-WALLET-PIN.md, amendments A5/A6).
--
-- WHY: POST /api/listing/:id/pay now requires the funder to pin the payee's
-- wallet row (wallet_row_id + wallet_row_hash: the chained identity-log row
-- that made the payee's address current). The route checks the pin before any
-- 402, and again inside the one reservation UPDATE, and binds the settlement
-- destination to the address that row names. These columns record WHICH row
-- the server checked:
--   listings.paying_wallet_row_id / paying_wallet_row_hash -- written by the
--     reservation UPDATE itself and cleared wherever paying_since is cleared,
--     so the 502 settlement_unconfirmed and 500 settled-but-unrecorded paths
--     keep the checked pair for reconciliation (A6);
--   listing_payments.wallet_row_id / wallet_row_hash -- copied onto the public
--     book row when the payment is recorded.
-- Rows paid before this migration carry NULL: they predate the check, and the
-- served note on GET /api/listings/payments says so.
--
-- ADD COLUMN only -- no table rebuild, no FK detach (L-016 does not bite).
-- All four nullable. D1 has no IF NOT EXISTS for ADD COLUMN: applied twice
-- this FAILS, which is why the deploy script reads the catalogue before and
-- after and refuses to deploy the worker on any partial state. Apply to prod
-- BEFORE the worker that reads and writes these columns (L-046).
ALTER TABLE listings ADD COLUMN paying_wallet_row_id INTEGER;
ALTER TABLE listings ADD COLUMN paying_wallet_row_hash TEXT;
ALTER TABLE listing_payments ADD COLUMN wallet_row_id INTEGER;
ALTER TABLE listing_payments ADD COLUMN wallet_row_hash TEXT;
