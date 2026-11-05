# D-018 re-gate (Opus tier): last_assertion_at with the assertion objection (D-078 item 4, option B), run 2026-11-05

**VERDICT: DEPLOYABLE WITH CONDITIONS. HIGH 0, MEDIUM 2, LOW 7.**

Scope `c05f2f36..c4c7f5e4`, weighted to `89eb2598..c4c7f5e4`. Per AO7 this record replaces `docs/REVIEW-LAST-ASSERTION-AT-GATE-2026-11-04.md` for this branch; that record's derivation of the money callers, the budget, the serving path and the annotations still stands, because the objection did not move them (I re-read the auth batch and the serving SELECT, not the money callers). Its C1 and C2 are carried below; its C4 is superseded by C6.

`npm test` at head: 3069 pass, 0 fail, 1 skipped. `npm run typecheck`: clean. No wrangler, no remote call. Real-D1 evidence still does not exist: the rehearsal has not run.

Nothing found is in the authentication path. M1 is a false word on the privacy page, M2 is a test that cannot see the script's write sequence.

## What I derived from source

**1. Authentication.**
- The stamp is the second statement of one `env.DB.batch` (`src/society.ts:658-663`), after every refusal (`:596`, `:604`, `:619`, `:621`, `:630`). The added condition `AND assertion_objected_at IS NULL` can only make the UPDATE match fewer rows. A zero-row UPDATE is not an error, so a flagged seat authenticates as before. The catch and the 401 text are unchanged (`:664-669`). `row.public_key` is read by the same SELECT (`:611-615`), which does not name either new column, and nothing returned to callers carries them.
- Replay on a flagged seat: statement one raises UNIQUE, the same catch, nothing written. OT4 and rehearsal c8c.
- New worker, 0024 present, 0025 absent: the UPDATE fails on the absent column, the batch fails, the error is not UNIQUE so it is rethrown (`:668`), every key seat gets a 500 and no nonce burns. It fails closed, and it takes every key seat down. **The census would still answer**, because `citizenDirectory` names only `last_assertion_at` (`:2308`), so the poll would not see it. That makes the catalogue check before the deploy (`scripts/deploy-last-assertion-at.ps1:472-473`) the only guard, and it is in place. Secret-held seats are unaffected: they never reach this code.
- New worker, both absent: as above, and the census 500s too. Old worker, any migration state: it names neither column, so 0024 and 0025 are invisible to it.
- Rollback: `git show c05f2f36:src/society.ts` contains `last_assertion_at` zero times, so the rollback target neither stamps nor serves the field. Upheld seats stay clear through a rollback and a re-deploy. See L1.

**2. The invariant.** The writers of `last_assertion_at` in `src/` are the stamp alone (`society.ts:662`). Rotation (`:1167`, `:1207`), model (`:1255`), karma (`:2167`) and last_seen (`:2216`) name other columns; the two INSERTs (`register-gate.ts:390`, `society.ts:1072`) name neither new column; no `REPLACE INTO`, `DELETE FROM citizens` or `SELECT *` on citizens exists. `assertion_objected_at` appears in `src/` only inside the stamp predicate. So no door can serve the flag, and the value's only read is `citizenDirectory`, which HTTP and both MCP doors share (OT5 compares them for equality). Uphold is one statement setting both columns. Against a stamp batch: stamp first, uphold clears; uphold first, the predicate fails inside the UPDATE. That rests on D1's single-writer serialisation and is reasoned, not exercised concurrently. I agree with CODEX and DEEPSEEK on this. The invariant holds with no read-side condition. `scripts/verify-last-assertion-at.sql` names the offending case and the deploy runs it twice.

**3. `scripts/assertion-objection.ps1`.**
- SQL construction: `Test-HandleShape` (`:53`) is `^[A-Za-z0-9_-]{2,32}$` under `-cnotmatch`, the same character set as the server's `/^[a-z0-9_-]{2,32}$/i` (`src/society.ts:684`). No `'` can pass, and `Get-Sql` (`:56-60`) is the only builder and validates again. With the `--` guard gone (`c4c7f5e4`), a `--` sits inside the quoted literal and SQLite treats it as data. The SQL reaches wrangler via `%D1_SQL_ARG%`, so cmd never parses it. Only gap: .NET `$` also matches before a final LF (L3); it cannot leave the literal.
- `%s` transport: the uphold is the first statement through this helper with a percent sign. I ran the literal statement through `cmd /c npx <shim> --command "%D1_SQL_ARG%"` using real `npx` and a copy of wrangler's own cmd shim pointed at an echo script. It arrived byte-identical. If it ever did not, `strftime('','now')` would give 0 and `Test-StoredAfter` refuses a flag of 0, though by then the row is written.
- Dry run: the only statements before `exit 0` (`:224`) are the read and the census. It cannot write as written. No test holds that: M2.
- Partial failure: every failure after the write stops with its own message (`:232`, `:235`, `:239`). A re-run is safe: `COALESCE` keeps the first objection time and a repeat clears nothing new.
- A local ride, evidence and not a test: a copy of the script with `$BASE` pointed at a local census, a stub `npx` running each statement on a local SQLite file, the real cmd path. Dry runs of both modes wrote nothing; a secret-held seat and an unknown handle stopped before any write; uphold, second uphold (time kept) and withdraw all met their postconditions. This is the only time lines 211-240 have run.
- Not proved anywhere: real wrangler's `meta.changes` on an UPDATE (it fails closed if absent, but only after the write).

**4. Deploy and rehearsal scripts.**
- Order: pins, rehearsal flag, git (exactly the two migrations, in order, both added), gates, live base, catalogue, migrations each only if its column is absent, both columns and verification, deploy, poll, verification, ride. The `0024 present, 0025 absent` resume works: step 3 still passes because the note is not yet served. I read the migration loop (`:457-467`), and the test runs it with a recording stub in four states.
- What the checks can prove: the ride proves serving, code identity, the chains and the text. It cannot prove the stamp or the objection, and its closing line says so (`:535`). The source-literal checks (`:392-397`) prove the strings exist, not that they are one statement; the reviewed-source check carries that.
- Passes with the thing broken: `Test-ColumnPresent` (`:209-215`) checks INTEGER only: L5.
- The rehearsal worker imports the real `authenticate` (`index.ts:20`). c8a-c8d use the ps1's statements through the real binding, pinned by test. c8b goes red if the predicate is dropped; the checkpoint records that mutant and the logic supports it. It cannot reach production, as the earlier gate derived; I re-read the name and config checks (`rehearse-last-assertion.ps1:46-65`). `Test-RehearsalReport` requires all 40 names once each. Not rehearsed: the script's own wrangler path (C3).
- **`$ALLOWED_PATHS_AFTER_REVIEW` should NOT change.** The script writes to production, and `test/assertion-objection-stamp-d1.test.ts:17-24` and the rehearsal's pin read their SQL from it. A post-review edit must move `$REVIEWED_COMMIT`.

**5. Served sentences.** Checked against the code, and true unless a finding says otherwise: every sentence of the Citizens paragraph (`src/privacy.ts:37`), `LAST_ASSERTION_NOTE` (`society.ts:213`), the route note (`discovery.ts:167`), llms.txt (`:642`), the tool description (`mcp.ts`, shared by `/mcp/read`). "A later refusal does not undo it" and "the seat can still act" are tested. The note's "on or after 4 November 2026" stays true on any later date. `src/doc.ts`, `/skill.md` and `/heartbeat.md` carry no sentence the objection falsifies (no hit for `objection` or `last_assertion` in `doc.ts`, `index.ts`, `mcp-read.ts`, `council.ts`, `showhome.ts`; the earlier gate established `/skill.md` and `/heartbeat.md` enumerate no row fields). The v6 hash pin stays green. False: M1. Imprecise: L2, L4.

**6. Tests.** The stamp and text suites are sound; each named mutant follows from its assertions (OT1, OT2, OT6, OT7, the COALESCE test), and I sampled them rather than re-running all. Dropping `AND public_key IS NOT NULL` is caught twice (literal at `test/assertion-objection-script.test.ts:93`, OT2). My two mutants of the script both SURVIVED: see M2. Unproven: real wrangler `meta.changes`; everything on real D1 including c8; uphold against a stamp under real concurrency.

## Findings

### HIGH: none

### MEDIUM

**M1. The privacy page points the wrong way.** `src/privacy.ts:12` ends "as described under Citizens below". The slot renders at `:65`; Citizens is at `:37`, above it. A holder reading the lawful basis looks below, finds only the generic right at `:81`, and misses what an objection does: the exact gap the 5 Nov withhold was about. O9 said "above"; AO4 changed it to "below"; `exchange/` shows no seat discussing the phrase (grep for "Citizens below": zero hits in the three records), and both pin tests now hold the false word (`test/assertion-objection-text-d1.test.ts:42`, `test/last-assertion-privacy-d1.test.ts:27`). **Fix:** "above" in the slot and both pins, plus the privacy entry's sha in `test/secret-literal-guard.test.ts`. Before `$REVIEWED_COMMIT`, since `src/` is not on the allowlist.

**M2. Nothing tests the script past the refusals.** I removed the whole `if ($DryRun) {...}` block, then separately removed the `Test-ChangedOne` and `Test-StoredAfter` calls from the main sequence (`assertion-objection.ps1:231-235`). `test/assertion-objection-script.test.ts` and the stamp file stayed 16/16 green both times; the file was restored and `git status` is clean. The tests pin the decision functions and the refusals, which all exit before `:211`, and nothing calls the rest. So AO1's postconditions and "a dry run writes nothing" are true today only because the text is right, and a dry run that writes production would pass the suite. The deploy test has already solved this for its own migration block with a recording stub. **Fix, smallest:** literal assertions in the F1/F2 test's style: in file order, `exit 0` of the dry-run block precedes `Say ("[write] "`, and the `Test-ChangedOne`, `Test-StoredAfter` and `Test-CensusServed` calls follow the write. **Better:** my local ride as a test (a recording `npx` stub on PATH, `$BASE` replaced in a temp copy): about 40 lines and it runs the path for real.

### LOW

**L1. The rollback text contradicts itself and is wrong.** `scripts/deploy-last-assertion-at.ps1:21-22` says the old worker "records nothing" and also "would stamp the seat again"; `:494` repeats both. The rollback target has no stamp code (zero hits at `c05f2f36`), and "GET /api/citizens must serve null" cannot be read on a worker that does not serve the field. It costs a needless re-check in the middle of an incident. **Fix:** delete both clauses; an upheld seat stays clear through a rollback. On the allowlist, so it may follow the review.

**L2. The privacy paragraph names one inference and misses the stronger one.** A key seat can only authenticate by signing, so a row with `public_key`, a `last_write_at` after recording began and a null stamp shows an objection, or a rollback gap, with no saved value needed. The note's "these are not distinguished" (`society.ts:213`) is true of the field and misleading for such a row, and it is more exact than the aggregate O6 rejected for narrowing the objector. The privacy text followed the seats' advice not to promise non-inference, so nothing is flatly false, but a holder deciding whether to object is told of the other route only (`privacy.ts:37`). **Fix:** "...can see that it has gone, and a later written record beside a null can suggest it." Ben's wording (AO4 is PROPOSED).

**L3. Trailing LF.** `assertion-objection.ps1:53`: .NET `$` accepts a handle ending in LF; the server's JS pattern does not. It stays inside the literal and fails at the read, and it is hard to pass from a PowerShell command line. **Fix:** `\z`.

**L4. "One current value" against the nonce table.** `privacy.ts:12` and `:37` say one current value, no separate history, and "records no more for that seat". `auth_nonces` keeps, per spend, `citizen_id` and `expires_at = issuedAt + window` (`society.ts:660-661`), and its only clean-up runs on a later successful assertion by anyone (`:673`), so with today's traffic the last row can sit for days, the uphold does not clear it, and a flagged seat's later spends each leave one. It does not make the sentences false: the rows are private, are replay bookkeeping, are bounded by the clean-up to roughly one window plus the last spend, and `privacy.ts:49` discloses that expired records can remain. But `:49` does not say they name the seat and a time, and the comments that say "seconds" (`society.ts:671`, `migrations/0024:8`) are wrong on this traffic. No seat raised this (zero hits for `auth_nonces` or replay records in the three exchange records). **Fix:** add to `:49` "they hold the seat and an expiry time", for Ben's approval; optionally the uphold also deletes that seat's expired rows.

**L5. The deploy catalogue check is weaker than the rehearsal's.** `Test-ColumnPresent` (`:209-215`) checks INTEGER only; `Test-ColumnShape` (`rehearse-last-assertion.ps1:110-118`) also checks nullable and no default. A hand-made `NOT NULL DEFAULT 0` column would pass the catalogue, pass the verification (no stamp is an offender, and a flag of 0 is not checked) and stop every stamp. It needs a hand DDL to arise. **Fix:** port the two checks. On the allowlist.

**L6. No-op withdraw.** A withdraw on an unflagged seat matches one row, so it passes and prints "[done] withdraw recorded" (seen in the ride). `[before]` shows the state and nothing is harmed. **Fix, optional:** a stop in the withdraw path when the stored flag is null.

**L7. Small stale or uncovered text.** The `-RehearsalPassed` stop message (`deploy-last-assertion-at.ps1:348`) lists the old checks, not the objection's. `privacy.ts:75` gives no retention period for the private objection record the page now promises (`:37`). `privacy.ts:12` "it lets readers see whether a seat's key is still in use" is the claim both seats rejected in AO6's reasoning; it belongs with Ben's necessity ruling.

## Conditions

**C1.** Before `$REVIEWED_COMMIT` is set: M1 fixed; M2's test added; any wording Ben takes from L2, L4 or L7 landed with its pins and guard shas. Every `src/` and `test/assertion-objection-*` change goes before the pin. This is a text and test change only, so a CODEX or DEEPSEEK read of the diff is enough; it does not need another Opus gate unless `society.ts:658-663` or the operator statements change.

**C2.** The hub sets both pins in `scripts/deploy-last-assertion-at.ps1` and the placeholder assertions in its test in one commit, then runs `npm test` and `-DryRun`. "Last updated: 5 November 2026" is pinned by two tests: if the deploy day differs, move the date and the guard sha before the pin.

**C3.** The rehearsal PASSES on real D1, all 40 checks, with `rows_written` recorded in the checkpoint, before Ben passes `-RehearsalPassed`, which no code checks. A failure on c1-c3 or c8 returns the wave to review. Add one step to it first, because no rehearsal touches the script's wrangler path: the uphold template with a handle that does not exist, sent by `wrangler d1 execute <scratch> --remote --json --command` through the same helper, must answer with `meta.changes` equal to 0. It proves the transport and the JSON shape on real wrangler and writes nothing. Otherwise the first real use of that path is a person's objection on production.

**C4.** Ben's wording: AO4 and the lawful-basis edits are PROPOSED, and this wave has changed text he approved on 4 Nov. His approval is on the record before the deploy.

**C5.** Ben's rulings on the record, see below.

**C6.** After the deploy the honest report stays "public serving verified; production authentication write path not exercised" until one signed assertion from `keyholder` moves its stamp. That step is not yet written. The objection is not shown by that either: it rests on C3 and on the first real run of the script.

## Ben's out-of-scope rulings: would their absence block a deploy?

No code or script checks any of them. On the record:
- **Necessity basis:** blocked by the record. AO6 says the balancing paragraph "stays a deploy hold for Ben".
- **No-opt-in:** blocked by the record. The earlier gate's C3 requires his word, and the brief (O11a) says this build does not settle it. C3's "no opt-out" wording is now out of date: the page says no self-service setting plus an objection.
- **Notice to existing holders:** no record makes it a condition. It is open at O11(c).
- **Millisecond or day precision:** no record makes it a condition. If he rules for day, the stamp, the note, the tests and the rehearsal all change, so it has to come before C1.

## Where I differ from the seats

- CODEX and DEEPSEEK passed "Citizens below" (M1). Neither raised the nonce table (L4) or the main-sequence gap (M2). CODEX's "the AO1 postconditions are correctly separated" is true of the functions; DEEPSEEK's convergence adds nothing on their being called.
- Both are right on concurrency, and on F1 and F2. I checked the fixes: the `--` guard is gone and the literal stays confined; `-ObjectionTimeRecorded` is enforced at `:206`; the recovery note at `deploy-last-assertion-at.ps1:32` lists the database checks.

## What I did not check

- Real D1 and real wrangler: batch error shape, c8, `rows_written`, `meta.changes`, the 0024 and 0025 `--file` applies. All sit with C3.
- Whether `commonhold-migtest` is alive or at what level.
- Edge caching of `/api/citizens`: no cache code in `src/index.ts` or `src/society.ts` (grep), but I did not read a live response. A cached census would fail the uphold postcondition loudly, after the write.
- D1 Time Travel keeps prior values for its own period, so "clears the stored time" does not reach that copy. `privacy.ts:75` says the page does not establish backup retention. I did not check the account's setting, and read that as adequate.
- The UK GDPR analysis, including whether the objection procedure honours Article 21 for a person who is not the key holder. The text routes that to individual assessment; that is Ben's.
- The earlier gate's sections on money callers and annotations were not re-derived.
- Hub-written `keyholder` assertion step: it does not exist yet.
