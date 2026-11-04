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

## Commit 3: serving, served text, privacy (B4, A1, A2, A7)

- `citizenDirectory` selects the column and serves `last_assertion_at` beside `last_me_at` (HTTP list and both MCP `citizens` doors, one function). The A1 note is `LAST_ASSERTION_NOTE`, appended after `PAYER_TRACE_NOTE`; the `last_me_at` sentence now reads "is not a signature time (see last_assertion_at)" (the existing test pins "not a signature time", kept).
- Served-text sweep (A7): `grep last_me_at src` finds society.ts only (the field and the note). Row-field enumerations changed: `src/discovery.ts:167` (route note), `src/discovery.ts:639-644` (llms.txt payer_trace paragraph, one sentence added), `src/mcp.ts:212` (`citizens` tool description). `src/doc.ts:684` unchanged (A7: outside the attested template, enumerates disclosure flags). `/skill.md` and `/heartbeat.md` enumerate no citizen row fields (no hit for payer_trace or last_write_at). Template hash v6 `dc5f4821` pinned by test, unchanged.
- Privacy: A2 sentence after the citizens list in `src/privacy.ts`; the date line is the builder's date, 4 November 2026 (the convention is a hand-kept date line with no test pin; the hub moves it to the deploy date if that differs).
- Existing test `governance-d1` row key list gains `last_assertion_at`.
- Tests: `test/last-assertion-serve-d1.test.ts` (T9, T10), `test/last-assertion-privacy-d1.test.ts` (T13).
- Red-proofs: column dropped from the SELECT: T9 (row key) and T10 red; one word of the note constant changed: T9 note red; "(see last_assertion_at)" pointer dropped: T9 note red; stamp also moves last_seen_at: T10 red; A2 last clause dropped: T13 red; date line reverted: T13 red. NOT red-proved: T9 "not on /api/official or /api/council" (no mutant is cheap: it would need the field added to the composition or council members) and the v6 hash pin (pre-existing shape; a template edit would turn it red).
- Two existing tests moved with the code: `citizen-activity-d1` (its race wrapper matched the page SELECT by `public_key FROM citizens`, now `last_assertion_at FROM citizens`), and `secret-literal-guard` (the new clause says "a secret-held seat" in three served descriptions and the A1 note: four new reviewed prose literals, the privacy entry's sha replaced; baseline 80/24/56 becomes 84/24/60).

## Commit 4: annotations (A4, A10)

- `src/mcp.ts`: all sixteen citizen-authenticating tools now carry readOnlyHint false, destructiveHint true, idempotentHint false, each with a comment line naming last_assertion_at. Hints CHANGED on twelve: post, comment, propose (destructive), vote, ballot, council_ballot (destructive and idempotent), history (destructive and idempotent), model, flag, council_flag (idempotent), council_write, council_motion (destructive). Already right and unchanged: pin, me, rotate, moderate. Old comments that said "destructiveHint false" or "idempotentHint true" were reworded to "Own effect (not the hint)" / "Own effect is idempotent" so each stays true; history's C1 comment rewritten (its "only nonce bookkeeping" claim was false for a key citizen). The `me`/`history` comments at the old :169-199 were handled this way; the council comments at :672-710 likewise.
- `test/mcp-tool-annotations.test.ts`: the "only add" destructive loop and the positive idempotence loop (vote, flag, ballot, model) replaced; new tests trace council_write, council_motion, council_ballot, council_flag through their handlers to resolveActor and then authenticate (council_challenge and council_claim traced as NOT authenticating a citizen), and assert all sixteen (twelve derived from callTool's source, four traced).
- Red-proofs (revert one tool's two flags to the old values, run the file, restore): post, comment, vote, history, propose, ballot, model, flag, council_write, council_motion, council_ballot, council_flag each red (the sixteen-tool test, plus the older destructive or idempotent tests where they cover the tool). council_ballot with only destructive reverted: red; with only idempotent reverted: red. Not a red-proof: pin, me, rotate, moderate already held the new values.
- Cost for Ben (A4): a client that prompts on destructive tools now prompts on every authenticated tool, bearer seats included.
