# Checkpoint: last_assertion_at (D-078 item 4)

Brief: drafts/BRIEF-LAST-ASSERTION-AT-2026-11-04.md (amendments A1-A10 override B and T). Branch last-assertion-at-2026-11-04, cut from main c05f2f36.

## Commit 1: migration 0024 and schema.sql

- `migrations/0024_last_assertion_at.sql`: nullable INTEGER, no default, no REFERENCES, no index, no backfill. schema.sql carries the column last.
- Deviation: `ALTER TABLE citizens DROP COLUMN` fails in node:sqlite ("incomplete input") because SQLite re-parses the table text and trips on the semicolons inside `secret_hash`'s comment. So the pre-migration state is built from schema.sql text with the column removed (`withoutLastAssertionColumn`, new `schemaTransform` option on `createLocalD1`). To keep DROP-free parsing safe the column line carries no trailing comment (its comment sits on the line above).
- Test `test/last-assertion-migration.test.ts`. Red-proof: migration changed to `INTEGER NOT NULL DEFAULT 0`: red; restored: green.
- Existing test `public-key-migration-d1` (0012 vs schema.sql column order) now applies 0024 after 0012 and expects public_key second-last, last_assertion_at last.

## Commit 2: the stamp in authenticateByAssertion (B2, A5)

- `src/society.ts`: the nonce INSERT (CASE guard unchanged) and `UPDATE citizens SET last_assertion_at = ? WHERE id = ? AND (last_assertion_at IS NULL OR last_assertion_at < ?)` bound to the server `now` are one `env.DB.batch`. Same catch, same 401 text. After the signature and the resident-binding 403.
- Tests `test/last-assertion-stamp-d1.test.ts` (T1-T8, T11; real local D1, the real router, real keys, fake clock via `withClock`). The existing council order test (`council-isolation-d1`, finds `INSERT INTO auth_nonces` by text) still passes unchanged.
- Red-proofs (mutation run on society.ts, restored byte-for-byte each time):
  - stamp binds `a.issuedAt`: T1 red.
  - signature check disabled: T2 and T11 red.
  - resident-binding refusal disabled: T2 red.
  - stamp as its own statement before the batch: T3, T3 raw, T5 and T11 red.
  - CASE guard dropped from the batched INSERT: T3 raw-nonce red.
  - batch replaced by sequential awaited `.run()` calls: T4 and T11 red (T4 sees the burnt nonce).
  - monotonic guard dropped: T5 red.
  - stamp statement removed: T1, T3, T4, T5, T6, T8, T11 red.
  - bearer path stamps: T7 red.
  - rotation clears the column: T8 red.
- T4 note: the shim prepares each statement at execution, so the missing-column UPDATE fails after the INSERT ran inside the transaction; the rollback leaves no nonce. Real-D1 behaviour of the batch error shape is the rehearsal's job (A5), not proven here.
