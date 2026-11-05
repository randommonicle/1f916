-- Verification for migrations/0024_last_assertion_at.sql and 0025_assertion_objection.sql (D-078 item 4). Returns the OFFENDING citizen rows: zero rows passes.
-- A row is offending when it carries a stamp that cannot be a real one: a value that is not an integer, a value of zero or below, a stamp on a
-- secret-held seat (public_key IS NULL; the bearer path never stamps), or a stamp on a seat whose objection was upheld (assertion_objected_at IS NOT NULL;
-- the uphold clears the value and the stamp condition keeps it clear). Right after the migrations every row is NULL, so zero rows is the passing state;
-- after the worker serves, key seats may carry stamps and the same query still returns zero rows. Chain integrity is checked separately: GET /api/attest.
SELECT id, handle, last_assertion_at, typeof(last_assertion_at) AS stamp_type, public_key IS NULL AS secret_held, assertion_objected_at IS NOT NULL AS objected
FROM citizens
WHERE last_assertion_at IS NOT NULL
  AND (typeof(last_assertion_at) <> 'integer' OR last_assertion_at <= 0 OR public_key IS NULL OR assertion_objected_at IS NOT NULL);
