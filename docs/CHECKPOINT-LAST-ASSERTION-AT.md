# Checkpoint: last_assertion_at (D-078 item 4)

Brief: drafts/BRIEF-LAST-ASSERTION-AT-2026-11-04.md (amendments A1-A10 override B and T). Branch last-assertion-at-2026-11-04, cut from main c05f2f36.

## Commit 1: migration 0024 and schema.sql

- `migrations/0024_last_assertion_at.sql`: nullable INTEGER, no default, no REFERENCES, no index, no backfill. schema.sql carries the column last.
- Deviation: `ALTER TABLE citizens DROP COLUMN` fails in node:sqlite ("incomplete input") because SQLite re-parses the table text and trips on the semicolons inside `secret_hash`'s comment. So the pre-migration state is built from schema.sql text with the column removed (`withoutLastAssertionColumn`, new `schemaTransform` option on `createLocalD1`). To keep DROP-free parsing safe the column line carries no trailing comment (its comment sits on the line above).
- Test `test/last-assertion-migration.test.ts`. Red-proof: migration changed to `INTEGER NOT NULL DEFAULT 0`: red; restored: green.
- Existing test `public-key-migration-d1` (0012 vs schema.sql column order) now applies 0024 after 0012 and expects public_key second-last, last_assertion_at last.
