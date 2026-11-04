# D-018 gate (Opus, money-path tier): last_assertion_at (D-078 item 4), run 2026-11-04

Scope `c05f2f36..04e1af7e`, worktree `scratch/wt-last-assertion`, branch `last-assertion-at-2026-11-04`. Read-only review, apart from this file. `npm test`: 3041 pass, 0 fail, 1 skipped; `npm run typecheck`: clean. No wrangler, no live read or write. Real-D1 evidence does not exist yet: the rehearsal has not run.

**VERDICT: DEPLOYABLE WITH CONDITIONS.** HIGH 0, MEDIUM 2, LOW 5. No finding is in the authentication code itself. M1 is privacy text that needs Ben's wording, M2 is a rehearsal check that prints more than it proves. The conditions are below; C1 is the one that stands between this record and any claim about real D1.

## What I derived from source

**1. `authenticateByAssertion` (`src/society.ts:580-674`).**
- Refusals before the batch: malformed (:582), audience (:596), freshness (:604), no such key citizen (:619), signature (:621), resident binding (:630). All throw before :655, so no nonce and no stamp. The order comment and T2/T11 hold.
- The only path to a returned citizen runs through `env.DB.batch([nonce INSERT, stamp UPDATE])` (:655-660), then the GC delete (:670). A batch that throws never returns a citizen: UNIQUE/PRIMARY KEY becomes the unchanged 401 at :662-663, and anything else is rethrown at :665 to the router's generic 500 (`src/index.ts`, the `Internal error` branch). A failing stamp cannot authenticate.
- The raw-nonce CASE is byte-identical to the old statement. A raw collision inserts the raw key again, raises UNIQUE on statement one, and reaches the same catch.
- New failure classes: the UPDATE names one nullable column with no constraint, no index and no trigger (no `CREATE TRIGGER` in `schema.sql` or `migrations/`). The only realistic new failure is the column being absent, which is the deploy order. Otherwise a D1 failure that would fail the UPDATE would already have failed the INSERT.
- A GC delete that throws at :670 leaves a committed stamp and a burnt nonce and answers 500. The nonce half is existing behaviour; the note's wording survives it.
- Real binding differences (error shape through `batch`, statement order, numbered and positional parameters in one batch): not derivable here. c1, c2, c3a and c3b in the rehearsal are the right checks for them.

**Money callers.** Every money route authenticates first, before reading the body and before any settlement: `/api/ledger` `index.ts:247`, `/api/payout` :253, `/api/wallet` :536, `/api/listing` :563 (then `handleCreateListing`, `payAndSettle` at `listings.ts:434`), `/api/submission` :567, `/api/listing/:id/pay` :573 (then `listings.ts:900`), withdraw :578. `src/x402.ts`, `src/listings.ts` and `src/register-gate.ts` never call `authenticate`. Registration has no citizen credential at all. So a batch failure on a money route is a 500 before any payment header is read: no "payment taken, then a 500" state is added. A paid retry must carry a fresh assertion today and still must. A stamp failure rolls the nonce back, so that assertion stays spendable inside its window.

**Budget.** `batch()` replaces `.run()`, so one D1 call stays one D1 call and the live subrequest count should not move (the binding's call count is not something I measured). `src/x402.ts`, `listings.ts` and `register-gate.ts` carry no budget on an authenticated path; the one x402 budget comment (:1272) concerns the reconciler, which does not authenticate. `src/maintainer` does not call `authenticate`, so D-041's budget is untouched. See L3 for the harness side.

**2. Concurrency.** D1 is one SQLite writer, with no row locks, so two batches from one seat serialise and cannot deadlock. One seat's two simultaneous spends of one token: one commits, the other hits UNIQUE and gets the 401. Two fresh tokens: both commit; the guard at :659 keeps the greater `now`. Other `UPDATE citizens` sites (`society.ts:1164`, :1204, :1252, :2164, :2213) are single statements outside this batch, so nothing holds a lock across a call. The added cost is a write lock held for two statements instead of one. A rotation racing an in-flight assertion can stamp after the key changed; the note says "the seat's key at that moment", which covers it. This reasoning is from D1's single-writer model and is not exercised on real D1 (L2).

**3. Serving.** `citizenDirectory` is called from `index.ts:500`, `mcp.ts:881` and `mcp-read.ts:110` only. No `SELECT *` on citizens anywhere in `src/`, and the two auth SELECTs (:514, :612) name their columns, so the field cannot leak through `Citizen`. T9 pins it off `/api/official` and `/api/council`. Note sentences checked against behaviour, all true:
- "/mcp/read authenticates nothing": `authenticate` is not imported there (`mcp-read.ts:23` and grep).
- "Null on a row with no public_key means a secret-held seat": `rotateKey` keeps each seat's kind (`society.ts:1129`, :1196), so no stamped row can lose its key.
- `?kind=key_rotation` is a served filter (`society.ts:2420`).
- "a later refusal ... does not undo it": T6.
- "just before verifying": see L1.

Privacy paragraph: true against the code. Its gap is M1. `src/doc.ts` carries no sentence about activity, recording or nonces (grep), and `:684` enumerates flags only, so A7 stands. The `act_capable` wording "not a test of any key" stays true. `last_write_at|payer_trace|last_me_at` grep across `src/`: `society.ts`, `mcp.ts`, `discovery.ts:167`, and `council.ts:342` (a council field, not a citizen row). `/skill.md` and `/heartbeat.md` enumerate no row fields.

**4. Annotations.** Twelve direct `authenticate(env, secret)` sites in `callTool` (`mcp.ts:857-917`: post, pin, comment, vote, me, history, rotate, model, flag, moderate, propose, ballot) plus four through `resolveActor` (`council.ts:609`, :816, :884, :977: council_write, council_motion, council_ballot, council_flag). Those are the only `resolveActor` callers and the grep finds no other `authenticate(` reachable from a tool, so the sixteen are complete. council_challenge and council_claim do not reach it. No served list, listing kit or test outside `test/mcp-tool-annotations.test.ts` and the guest and resident door tests asserts a count of these hints; `discovery.ts` and `mcp-read.ts` do not mention `destructive`. See L5 for the client-side cost.

**5. `scripts/deploy-last-assertion-at.ps1`.**
- Order: pins and `-RehearsalPassed` before anything (:318-324); git, no-mint and one-added-migration checks (:327-378); gates; live base proof (:399-410); clock start before the first production read (:413); migration (:429-435); catalogue and verification (:438-439); stamped deploy and poll (:445-461); post-activation verification (:466-468); ride. Migration before worker holds, so the worker-first failure that would stop every key seat cannot happen by this path.
- All reads go by `--command` through the bounded helper. The rollback text is derived from the live version id (:406, :460) and is true: the old worker's SELECT does not name the column.
- Partial failure: a migration timeout or failure stops with "read the catalogue by hand"; a re-run with the column present demands `-MigrationAlreadyApplied` (:418); a failed deploy points at that flag; after a live deploy there is no resume mode and the header (:27-28) says so.
- `Invoke-Tool` is unchanged from the deployed template. `/privacy` is served as raw markdown (`privacy.ts:99`), so the apostrophe in `$PRIVACY_MARKER` will match.
- Copied logic that does not quite fit: L4.

**6. Rehearsal.**
- It cannot reach production: the database name is exact-matched and refused otherwise (:36-39, used at :128 and in `Invoke-ScratchRead`), the config check requires exactly one D1 binding with the scratch name and id for both binding and preview and no triggers (:41-55), and the test pins no bare production name and no `wrangler deploy` in the file. The worker holds only that binding. `wrangler dev --remote` uploads a preview, not a deployment.
- It fails closed: a route answer that is not JSON stops; all 21 names must appear exactly once and pass (:98-113); PASS is the last line after the stop.
- c1 to c4 go through the REAL `authenticate()` and each can go red: c2 and c3b plant an earlier stamp so a wrong update shows, c3a uses null. These answer the error-shape, statement-order and catch questions from item 1.
- c5: M2. c6: L3.

**7. Tests.** Red-proofs reasoned from the assertions, not re-run:
- T4: two awaited `.run()` calls burn the nonce before the UPDATE fails, so `nonceRows == []` goes red.
- T3: a stamp outside the batch moves to `T0+5000` on the replay, so the equality with T0 goes red.
- T3 raw: with the CASE dropped the namespaced insert succeeds, so `refusal()` throws.
- T1: binding `issuedAt` stores `T0-100000`, so the equality with T0 goes red.
- T5: with the guard dropped the stored later value moves back.
- T11: a stamp outside the batch fails on text order or on `log[0].length`.
All six can fail. T4's shim fails the UPDATE at execution, so it says nothing about how real D1 fails a missing column; the checkpoint says so.

## Findings

### HIGH: none

### MEDIUM

**M1. The privacy page states a purpose for this processing but no lawful basis, and the new sentence leans on one.** `src/privacy.ts:37` ends "the right to object below applies". The right at :81 is the right to object "to processing based on legitimate interests". `LAWFUL_BASIS` (:12) lists publishing contributions, rate limiting, logs, moderation, council checks and attested records. A machine-generated timestamp of key use is not a contribution and, by its own note, is in no hash chain, so it sits under none of them. The balancing line ("participants choose what to write, are told here that it is public") cannot reach it either: A2 itself says the value is "generated automatically rather than written by the holder", and the outside key holders did not opt in. This matters only where the data relates to a person, and the page already allows for that. Nothing it says is false; it is an omission on a regulated page, and the field is what the brief itself flagged as the privacy cost. A seat did read A2 against this slot and found "no contradiction" (`exchange/REVIEW_brief-last-assertion-at-2026-11-04.md:131`). I agree there is none; the gap is that the slot does not cover the new processing, and that question was not asked. **Fix:** Ben rules a clause for `LAWFUL_BASIS`, for example naming "recording and publishing the time a seat's signing key last authenticated" under legitimate interests, with the interest stated (a reader can see whether a seat's key is in use) and the balance stated honestly (automatic, no opt-out, the holder can object). The slots are his rulings (`privacy.ts:2-4`), so I do not draft it as final. If the slot string changes, the secret-literal guard needs no change unless it contains the guarded word; run the suite.

**M2. Rehearsal c5 prints a proof it may not be giving.** `scripts/assertion-rehearsal-worker/index.ts:120-134` makes statement two fail by naming a nonexistent column, then prints "c5 proves D1's whole-batch rollback (a first-statement success is undone when a later statement fails)". A nonexistent column is a compile error. If the real binding or D1 prepares a batch before it steps any statement (I do not know whether it does, and nothing in this repo establishes it), statement one never ran, c5 passes, and no rollback was exercised. That check cannot go red for the reason it names. The shim prepares at execution, so the shim ride does not settle it. Consequence is bounded: the failure this would hide is a burnt nonce on a 500, never an authentication. c2 and c3 separately prove the load-bearing direction (statement one fails, stamp does not move). The brief asks that nothing printed as PASS read stronger than it is, and the rehearsal is one run of Ben's. **Fix, before the rehearsal runs:** make statement two a runtime failure that compiles cleanly, by running `NONCE_INSERT` a second time with the same bindings in the same batch (the CASE takes the namespaced key again and raises UNIQUE at step). Assert the batch threw and no row survived. Keep the nonexistent-column batch as a separately named check, since it is the shape of the worker-before-migration case, and word each note to what it shows. Update the worker, `$EXPECTED_CHECKS` and any name or count pinned in `test/rehearse-last-assertion-script.test.ts` (it derives names from the worker source) together, then re-run that file. No `src/` change.

### LOW

**L1. "just before verifying the signature" (`LAST_ASSERTION_NOTE`).** `now` is taken at `society.ts:603`; the citizen SELECT at :611 sits between it and `verifyAssertion` at :621. The stamp can therefore precede the verify by one D1 round trip. The sentence's point, that it is the server's clock and not the signer's, holds. Fix: none required; if the note is reopened, "during authentication, before verifying the signature" is exact.

**L2. Concurrency has no real-D1 check.** Brief item 2 rests on reasoning above. Fix, optional and cheap with M2: a c7 that runs `Promise.all` of two `authenticate()` calls on one token and asserts exactly one citizen, one REPLAY_TEXT 401 and one nonce row.

**L3. Cost evidence is thinner than A3 words it.** A3 says the rehearsal records `rows_written` "for one assertion before and after"; c6 records the two statements of the new batch only. The INSERT line is the "before" in effect, so the number is usable, but c6 passes on any two numbers, including zero, so the hub has to read it. Separately, A3 told the builder to re-check subrequest-budget tests on authenticated paths and the checkpoint records no such re-check. I did it: no test using `onExec` signs an assertion, so no budget test covers this path, and live counts are unchanged by the batch swap. Fix: record the `rows_written` line in the checkpoint (C1).

**L4. Inherited script text that does not fit.** `Test-WithinWindow` (`deploy-last-assertion-at.ps1:166`) is called only by its test; the script uses `Test-SufficientWindow`. The one-hour window protects nothing specific in a wave with no backfill; it is harmless and B10 asked for it. Header :29 "THE RIDE writes nothing" is loose, since the doors record daily counters (`mcp-read.ts:54`). Fix: none required.

**L5. The annotation change has an outward cost beyond the prompt.** `me`, `history` and `vote` now say destructive and non-idempotent to every client, bearer seats included; A4 names the prompting. A client that retries only idempotent calls will also stop retrying `vote` and `ballot`, which were retry-safe by their own guards. Registry, directory and Smithery surfaces may cache the old hints (I did not check them). Ruled by A4, so this is for Ben's information. Fix: none.

## Conditions

**C1.** The rehearsal runs after the M2 fix and PASSES on real D1, with c2, c3a and c3b showing the exact 401 text. The `rows_written` line goes in the checkpoint. This gate does not stand in for it: `-RehearsalPassed` is Ben's own assertion and no code checks it. A failure on c1 to c3 returns the wave to review before any deploy.

**C2.** Before the deploy, the hub sets both pins in `scripts/deploy-last-assertion-at.ps1` and updates the placeholder assertions in `test/deploy-last-assertion-at-script.test.ts` (:79, :80) in the same commit, then reruns `npm test` and the script with `-DryRun`. Any `src/` or rehearsal change (M1, M2, the "Last updated" date in `privacy.ts:20` if the deploy date differs, with its guard sha in `test/secret-literal-guard.test.ts`) lands BEFORE `$REVIEWED_COMMIT` is set, because the allowlist covers only the script, its test and `docs/`.

**C3.** Ben, before the deploy: rules the `LAWFUL_BASIS` wording (M1), and confirms the A2 decision that the seven outside key seats did not opt in and have no opt-out. Each is his word on the record, in the hand-over.

**C4.** After the deploy, the field is reported as "public serving verified; production authentication write path not exercised" until one signed assertion from `keyholder` moves its stamp (A8). That step is not yet written (the hub writes it, with the existing custody handling) and it is the first time this write runs on production. If Ben declines it, the next real key-seat act is the ride, so read the first one against the D1 row.

## What I did not check

- Real D1 anything: batch error shape, rollback, `rows_written`, the 0024 `--file` apply. All sit with the rehearsal.
- Whether `commonhold-migtest` is alive and at what level. The script's tables read stops if it lacks the two tables, and a missing `public_key` fails at the worker's INSERT, closed.
- `wrangler dev --remote` running the rehearsal at all: never run; written from the c8 worker, which had no driving script. Its failure modes are closed.
- Live subrequest counts; the Cloudflare D1 pricing figure in A3; how third-party registries treat changed hints.
- Whether the UK GDPR analysis in M1 changes if no key holder is a natural person: left to Ben.
- Mutations: red-proofs were reasoned from the test assertions and the checkpoint's record, not re-run. The exchanges were not reviewed as evidence, apart from a search of the brief exchange on the M1 question.
