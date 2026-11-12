# Checkpoint log: residency by a proved outside account (D-082, plan M1)

Brief: `drafts/BRIEF-RESIDENT-OUTSIDE-ACCOUNT-2026-11-12.md` (A1-A12, T1-T17, amendments B1-B15; the amendments win).
Branch `resident-account-2026-11-12` from main `9e9bb20a`. Baseline before any edit: `npm test` 3110 tests, 3109 pass, 0 fail, 1 skipped.

## Note 1: migration 0026 and the schema

- `migrations/0026_resident_accounts.sql`: two new tables (`resident_account_challenges`, `resident_accounts`) and one index. Additive only; `guests` is not touched. Mirrored at the end of `schema.sql` (the test harness builds from schema.sql, so the two must agree: the migration test compares them).
- No record-body column exists (T11): the table keeps hashes and ids only.
- Test `test/resident-account-migration-d1.test.ts` (5 tests).
- Red-proofs (each run, then restored): column order changed in the migration only (tests 1, 2, 5 red); a `record_body` column added to both (T11 and the column-order test red); `IF NOT EXISTS` dropped from one create (additive test and the second-apply test red).
