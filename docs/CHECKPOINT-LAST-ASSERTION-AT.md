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

## Commit 5: deploy script, verification SQL, test (B10, A8, T12)

- `scripts/deploy-last-assertion-at.ps1` adapted from `deploy-decided-event-id.ps1` (that script and migration 0023 untouched). Kept: reads by `--command`, every wrangler call through `Invoke-Bounded`, the one-hour window, four chains compared on length and head, stamped deploy with version-id poll, reviewed-source allowlist. Dropped: the pending-proposals preflight, the historical pairs, the backfill and its re-run (no backfill is possible). New: `-RehearsalPassed` is required for a real run (A8: the Worker-binding rehearsal cannot be checked by a script), the window clock starts at the first production read (the catalogue read), the ride checks `/api/citizens` (note wording and a key on every row, non-null stamps whole numbers and only on rows with a public_key), the citizens tool on `/mcp` and `/mcp/read`, `/privacy`, sixteen public reads. Both pins ship as placeholders (hub sets them). The closing line says "public serving verified; production authentication write path NOT exercised" and the header names the optional `keyholder` assertion step as Ben's, written by the hub. The script holds no key and signs nothing (test greps for Authorization, Bearer, ch1., Ed25519, `.local.`).
- `scripts/verify-last-assertion-at.sql`: offenders are a stamp that is not an integer, is zero or below, or sits on a secret-held seat. Zero rows right after the migration and after the worker serves.
- Test `test/deploy-last-assertion-at-script.test.ts` (13): parse and ASCII, traps, placeholder pins (pin block run for real), the `-RehearsalPassed` block run for real, step order, wrangler only through the bounded helper, header duties, window, verification and column decision functions, the verification SQL over a real SQLite table, bounded runner, served-answer checks, source literals. Nothing runs wrangler.
- Red-proofs (mutate the script or the SQL, run the file, restore): reviewed pin set to a sha; rehearsal guard disabled; column type check dropped; verification forced clean; the SQL's secret-held clause dropped; served check without the key test; window threshold widened; migration block marker moved (order); post-activation verification removed; an Authorization header added; privacy marker check dropped. All red.

## Fix pass 1 (CODEX round 1)

- F1: `$script:PreflightAt` is assigned immediately BEFORE the first production read (its own run time, up to 120 s, is now inside the window); the order test pins it. Red-proof: clock moved back after the read: order test red.
- F2: header narrowed: `-MigrationAlreadyApplied` is for stops before the worker deploy; after it there is no resume mode (a re-run refuses because the live commit or note matches), so finish by hand with the listed GETs or roll back to the printed version id. Header test pins both phrases. No resume mode built.
- F3: `citizen-activity-d1` race wrapper now requires `public_key` and `last_assertion_at` in the SELECT. Red-proof: `public_key` removed from the directory SELECT: race test red.
- F4: T9 "not on /api/official or /api/council": field added to each route's answer: red (each). v6 hash pin: one character added to `FRONT_DOOR_TEMPLATE`: red. All restored.

## Commit 7: the Worker-binding rehearsal (A5, A8). Written, NOT run.

- `scripts/assertion-rehearsal-worker/` (`wrangler.jsonc` bound only to scratch `commonhold-migtest`, same compatibility date and flags as the main worker; `index.ts` imports the REAL `authenticate`) and `scripts/rehearse-last-assertion.ps1` (refuses any database name but the scratch one, applies 0024 only if the column is absent, `wrangler dev --remote`, prints each check, stops wrangler in finally, PASS only when all 21 named checks ran and passed). Modelled on `scripts/c8-rehearsal-worker/`; c8 had no driving ps1, only `check.mjs` and manual commands.
- Checks: c1 first spend and stamp and one nonce row; c2 namespaced replay (stamp deliberately set earlier first); c3a and c3b raw-nonce collision with a null and an existing stamp; c4 bad signature; c5 batch rollback (a nonexistent column, so it proves D1's rollback, not the missing-column deploy case); c6 `meta.rows_written` per statement of one spend (A3).
- Test `test/rehearse-last-assertion-script.test.ts` (9), including the worker RIDDEN on the local shim: all pass except c6's rows_written (the shim reports none), and no rows are left behind.
- Red-proofs: default database changed to the production name, dev without `--remote`, a deploy line added, a `RehearsalPassed` switch added, the stop before PASS disabled, a check name changed in the ps1, the worker config database renamed, a worker statement drifting from society.ts: each red. Stamp written outside the batch: the shimmed worker ride goes red (c2).
- `-RehearsalPassed` on the deploy script stays Ben's own assertion after this passes.

## Fix pass 2 (Opus gate record and CODEX on the rehearsal). Rehearsal still NOT run.

- R1: c5 is now a RUNTIME failure that compiles cleanly (the nonce INSERT twice, same bindings; the second raises UNIQUE at step); the nonexistent-column batch is kept as the separately named c5b (the worker-before-migration shape), each with its own note. R2: c7, `Promise.all` of two `authenticate()` calls on one token: exactly one citizen, one replay 401, one nonce row. R3: c6 needs a number greater than 0 for each statement, in the worker and again in the script; the script prints a `[checkpoint] rows_written ...` line. R4: the route must answer HTTP 200 and carry `database` equal to `commonhold-migtest (scratch)`. R5: the column read also checks `notnull` 0 and no default, on both paths. R6: Worker cleanup deletes by the unique handle, never throws past the report, and its result is the named check "cleanup removed the scratch citizen and its nonce rows"; a missing `last_row_id` is the failing check c0. R7: wrangler is stopped from a snapshot of the wrapper's descendants and the port owner plus whatever still owns the port, and a port still listening afterwards stops the run before the verdict. 28 named checks now.
- Unproven without running it: the real wrangler dev process tree (the helpers are tested with a real orphaned `ping` child and a real socket, not with wrangler/workerd), and `rows_written` and D1's error shapes on real D1.
- Red-proofs, each red then restored: R1 second INSERT given another nonce; R2 `INSERT OR IGNORE` (two winners); R3 zero rows accepted; R4 database check removed, and HTTP status check loosened; R5 notnull check dropped; R6 cleanup SQL broken; R7 Stop-ProcessIds a no-op, the snapshot unused in finally, descendants never found.
- Privacy (gate M1), PROPOSED wording pending Ben's ruling: LAWFUL_BASIS gains "recording and publishing the time a seat's signing key last authenticated," in the legitimate-interests list and the key-use balancing sentences at the end of the paragraph; both pinned in T13 (red when the sentence is edited). The secret-literal-guard sha did not move. The gate record `docs/REVIEW-LAST-ASSERTION-AT-GATE-2026-11-04.md` is left uncommitted for the hub.
