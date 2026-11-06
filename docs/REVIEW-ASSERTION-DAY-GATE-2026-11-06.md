# D-018 gate (Opus tier): last_assertion_at at UTC-day precision, range 570199fe..979ed5e6, run 2026-11-06

**VERDICT: DEPLOYABLE WITH CONDITIONS. HIGH 0, MEDIUM 2, LOW 4.**

`npm test` at `979ed5e6`: 3082 tests, 3081 pass, 0 fail, 1 skipped. `npm run typecheck`: clean. No wrangler, no remote call, no `*.local.*` read. Nothing here has run on real D1: the operator's rehearsal is still to come.

Authentication is clean. The only change in the auth path is the bound value. M1 is a test that no longer sees the mutant it names. M2 is a false word on the privacy page.

Base gate `docs/REVIEW-ASSERTION-OBJECTION-REGATE-2026-11-05.md`: this range does not disturb its derivation. The fix pass after it (`548e9710..570199fe`) sits below this range and I did not re-review it, beyond confirming that its M1 "above" is served, `test/assertion-objection-ride.test.ts` exists for its M2, and the transport step is at `scripts/rehearse-last-assertion.ps1:236-240`.

## 1. Authentication

- `src/society.ts:662` is the only executable change in the auth function. The SQL text is byte-identical; `.bind(now, row.id, now)` became `.bind(utcMidnight(now), row.id, utcMidnight(now))`.
- `utcMidnight` (`:452-455`) is a pure `Date.UTC` call on a `Date.now()` value that `withinWindow` has already used. It cannot throw on a number, and it is in use at 14 call sites in `src/`.
- Unchanged: statement order and batch shape (`:658-663`), the catch and the 401 text (`:664-669`), the GC bind, still `now` (`:673`), every refusal before the batch, and the objection predicate.
- A zero-row UPDATE inside a batch already happened on a flagged seat and on a stored later value. It is now the common case, because every same-day assertion takes it. It raises no error. Replay still raises UNIQUE on the first statement.
- No new way to fail, and no way to fail open. The comments at `:649-653` are accurate.

## 2. Values and serving

- Writers: the stamp (always a day start, since `Date.UTC(y, m, d)` is a whole multiple of 86400000) and the uphold (NULL). No other writer exists in `src/` (grep). Rehearsal `setStamp` touches scratch only.
- A millisecond value should not already be on production: the handover records 0024 as unapplied and no stamping worker as served. I did not read live. If it were otherwise, the verification SQL would stop the run.
- Only read: `citizenDirectory` (`:2308`, `:2363-2373`), served unchanged. HTTP and both MCP doors share it, and `test/last-assertion-serve-d1.test.ts` T9 and `test/assertion-objection-stamp-d1.test.ts` OT5 compare the bodies with `deepEqual`.
- No `SELECT *` on citizens and no second SELECT naming the field. `/api/me` does not carry it.

## 3. Served sentences

True against the code:
- The note (`society.ts:213`) in full, except L2. That includes "sets the value when it is null" (`:662`) and "last_me_at and a key_rotation row still show their own times" (`:2216`, `:1174`, `:1210`).
- The route note (`discovery.ts:167`), llms.txt (`:642`), and the tool description (`mcp.ts:220`, shared by `/mcp/read`).
- `privacy.ts:12`, `:37` and `:75`. "starts at registration time" holds: `society.ts:1072-1074` and `register-gate.ts:390-391` bind `last_seen_at` to `now`. `me()` is the only updater (`:2216`, callers `index.ts:492`, `mcp.ts:874`).
- "no other public field covers that use across every route" (`privacy.ts:12`) holds. `last_me_at` is one route, `last_write_at` and `acts` count writes, key_rotation rows are one route, `/api/doors` counts by door and not by seat (`doors.ts:87`), and `topics.ts` `last_activity_at` belongs to a thread. `verifyAssertion` has two callers: citizen auth (`society.ts:621`) and the resident path (`resident.ts:123`), and the note says "citizen assertion".

False: M2. Misleading by what it leaves out: L2.

Stale search: no served millisecond or exact-time claim about this field remains in `src/`. `doc.ts`, `index.ts`, `mcp-read.ts`, `showhome.ts` and `council.ts` have no hit, and `docs/` is not served. Unserved residue: L4.

The two CODEX round 2 corrections in `979ed5e6` are true as built. CODEX did not read them, because it was at its round cap: its last state is `[[POSITION - CODEX]]`, and DEEPSEEK's `[[CONVERGED]]` is its own. I re-derived both.

## 4. Operator scripts

- Millisecond assumptions: none left in any check. `assertion-objection.ps1` tests only null and non-null on the value.
- `Test-CitizensServed` (`deploy-last-assertion-at.ps1:298`) goes red on a non-day value, shown by the `list-not-day` case run in PowerShell. `verify-last-assertion-at.sql:9` goes red, shown by the test that runs it in SQLite on an otherwise valid row.
- **Those two checks are vacuous at deploy time.** Every value is NULL after the migrations, and nothing stamps during the run unless real traffic does. A green deploy says nothing about the stored value. The closing line (`:538`) says the write path is not exercised, which is honest. See C5.
- A new percent sign reaches the deploy's wrangler path (`% 86400000`). I sent the literal statement, after the same comment-stripping and whitespace collapse as `ConvertTo-SingleLineSql`, through `cmd /c npx --no-install wrangler ... --command "%D1_SQL_ARG%"`, using real `npx` and a copy of wrangler's own cmd shim pointed at a stub that saves its argument. It arrived byte-identical, `<>` included. If real wrangler mishandled it, the read would fail at step 6, closed, after the additive migrations.
- Keyholder ride text (`:20`): no false pass found. Stamps only exist after the deploy, so any non-null value on keyholder was written by the new path. See L1 for the case the text leaves open.
- First-of-day stamp and rollback: nothing inconsistent. The rollback target neither reads nor serves the column, no chain carries it, and on a later re-deploy the guard treats the old day start as an older value. A same-day rollback and re-deploy leaves today's value, which is still a true statement of that day.
- Rehearsal: c2 and c3b still go red for a wrong write, because `earlier` is below today's day start. c1b and c1c go red for a dropped guard and for `<=`. The shim ride in the suite runs all 42 names.
- `$ALLOWED_PATHS_AFTER_REVIEW` (`:54`) allows the deploy script, its test and `docs/` only. It should not grow.

## 5. Tests

- Sound: the new "Ruling 3" test (a real trigger counts writes, so `<=` and binding `now` both go red). T1 and T5 (T5 moved to a day step). T8 (moved to the next day). OT8 and the verification test (day-start values, so the clause under test is the only cause).
- M1 is the exception.

## 6. The notice

Every sentence is true of the built branch, including the contact (`privacy.ts:10`), the signed-text procedure, "records nothing from before the update" and the six years. At 1691 characters it is under `max_body_len` (8000). `createComment` has no content refusal that matches it; its refusals are length, target, depth, daily cap and topic state. `mentionsHandle` accepts a following `.` or space (`src/inbox.ts:138-154`). Two matters: L3, and what I cannot verify here (C6).

## Findings

### HIGH: none

### MEDIUM

**M1. T3 no longer sees the mutant it names.** `test/last-assertion-stamp-d1.test.ts:75` names "the stamp runs as its own statement before the batch". Its replay at `T0 + 5_000` (`:84`) lands on the same UTC day, so a wrong write stores the same day start and `:86` still passes. I ran a stronger, unguarded form of that mutant on a scratch copy (`UPDATE ... WHERE id = ?` before the batch): T3 stayed green, and T3-raw and T11 went red. I reasoned, and did not run, the named guarded form: T3 stays green and T3-raw's existing leg passes too, so the catches are T3-raw's null leg and T11. So the suite catches this mutant and T3 does not. The raw leg's `T0 - 1_000` (`:94`) is an unreal state: it is not a day start and it is above today's day start, so the guard cannot fire there and "stamp unchanged" is vacuous on that leg. Only the null leg works, plus rehearsal c2 and c3b. **Fix:** in T3, after asserting the first spend, set the stored value to `utcMidnight(T0) - DAY` and assert the replay leaves that; change `:94` to `utcMidnight(T0) - DAY`. Not on the allowlist, so before the pin.

**M2. The new replay sentence is false of one table it covers.** `src/privacy.ts:49`: "A nonce record holds the seat and an expiry time". The paragraph covers "authentication nonces", and `resident_nonces` holds `visitor_id` and `expires_at` with no seat (`migrations/0020_residents.sql:32-36`, `src/resident.ts:141`). DEEPSEEK's convergence cites the schema for `auth_nonces` and `council_challenges` only. **Fix:** "A nonce record holds the seat, or for a resident the visitor number, and an expiry time"; the same in the pin at `test/assertion-objection-text-d1.test.ts:45`, and the privacy sha in `test/secret-literal-guard.test.ts`. Ben's addition was worded for citizens, so his word covers this with C2.

### LOW

**L1. The ride text leaves one case open.** `deploy-last-assertion-at.ps1:20` says read first because today's value cannot move, and `:538` says it is not ridden until one assertion "moves" the value. Neither says what a value already on today means. **Fix (on the allowlist):** add "if it is already today's, the ride waits for the next UTC day". The deploy day itself is normally safe, since the value starts null.

**L2. The rotation comparison loses its answer on the rotation's own day.** `society.ts:213` says "compare it, to the day, with the seat's key_rotation rows". Rotation authenticates with the old key, so it stamps that day itself (T8), and the new key's first signing that day writes nothing. A value equal to the rotation's day therefore cannot show that the new key has signed. Only a later value can. T8 moved its second assertion to the next day, so no test holds this state. **Fix:** add "; a value on the rotation's own day cannot show which key signed". Ben's wording, with pins and sha, before the pin.

**L3. The notice leaves out limits the page states.** Line 3 says the field shows the day, and omits that someone polling can see roughly when it changes and that `last_me_at` and rotation rows keep exact times. Line 5 omits "A later written record beside a null can also suggest an objection". `/privacy` carries all three (`privacy.ts:37`) but only once the update is live, so before go-live the notice is the only text a holder can read. **Fix:** one clause each; I would make it before sending. Any change goes back through both seats.

**L4. Stale or residual words.**
- `deploy-last-assertion-at.ps1:1` "the greatest SERVER time" and `:284` "whole number" (allowlisted).
- `scripts/assertion-rehearsal-worker/index.ts:5` "stamp set to a server time", and its header list omits c1b and c1c (before the pin).
- `society.ts:671` "seconds of traffic" (base gate's L4, still wrong at today's traffic).
- `privacy.ts:37` "a person to whom the time relates" could say "the day", if Ben wants (pinned at `test/assertion-objection-text-d1.test.ts:40` and `test/last-assertion-privacy-d1.test.ts:11`).
- `docs/CHECKPOINT-LAST-ASSERTION-AT.md`, which the deploy header names, has no entry for this change (no hit for "6 Nov" or "UTC day").

## Conditions

**C1.** Before `$REVIEWED_COMMIT` is set: M1 and M2 fixed, with any wording Ben takes from L2 or L4 landed with its pins and guard shas. A seat read of the diff is enough; it needs another Opus gate only if `society.ts:662` or an operator statement changes.

**C2.** Ben's word on the final text. The D-078 note of 6 Nov approves `drafts/FOR-BEN-2026-11-05-EVENING.md`, and the built text differs: the necessity sentence is rewritten, the `last_me_at` sentence and the "normally no more than once a day" clause are new, the replay sentence has grown, and M2 changes it again. I did not find his approval of the final words in the D-078 note; he may have been told elsewhere.

**C3 (base C2).** The hub sets both pins and the test placeholders in one commit, then `npm test` and `-DryRun`. Both pins still hold placeholders (`deploy-last-assertion-at.ps1:49`, `:52`). "Last updated: 6 November 2026" is pinned by two tests: if the deploy day differs, move the date and the guard sha before the pin.

**C4 (base C3).** The rehearsal passes on real D1, now **42** checks plus the transport step, with `rows_written` recorded in the checkpoint, before Ben passes `-RehearsalPassed`, which no code checks. A failure on c1, c1b, c1c, c2, c3 or c8 returns the wave to review.

**C5 (base C6).** The report stays "public serving verified; production authentication write path not exercised" until one signed keyholder assertion sets the value. That ride must read the value before, require exactly today's UTC day start after, and then run `scripts/verify-last-assertion-at.sql`, since that is the first time its day clause is certain to have a value to test. The step is still not written.

**C6.** Before the notice goes: confirm against live that the seven handles are exactly the non-operator seats with a public key, since `SPONSORED_HANDLES` (`society.ts:192`) is a funding list, not a key list; and that topic 12 is open, since `createComment` refuses a closed topic. PowerShell, read-only:

    (Invoke-RestMethod https://commonhold.randommonicle.workers.dev/api/citizens).citizens | Where-Object { $_.public_key -and -not $_.operator_controlled } | Select-Object -ExpandProperty handle

## Where I differ from the seats

- Neither seat raised M1 or M2, as far as I read their records (I read CODEX round 2 and DEEPSEEK round 2, and searched round 1).
- I did not see L2 raised. DEEPSEEK treated the same-day no-write as a property to rehearse, which it is; the served comparison is the part that changed meaning.
- I agree with CODEX on `last_me_at` and on the null case, and with both on the residual timing disclosure.

## What I did not verify

- Real D1 and real wrangler: `meta.changes` on c1c, the batch on real D1, that an integer-valued JS number stores as `integer` under this column's affinity, `%` in D1's SQL, wrangler's own handling of the `--command` argument. The operator's rehearsal covers most of this; `%` through real wrangler is first exercised at deploy step 6 and fails closed.
- Live state: the census, the seven handles, topic 12, the production column state, whether `commonhold-migtest` is alive.
- The UK GDPR analysis, and whether six years is right: Ben's call as controller, and the D-078 note says it is not legally checked.
- The fix pass `548e9710..570199fe`, as stated at the top.

## What this gate touched

- Mutants ran on a scratch copy in the session scratchpad. The worktree's source was not edited, and `git status --short` was empty before this record was written.
- My first percent-sign run was badly set up. A `bin` entry in the stub's `package.json` made `npx` install the stub into the npm cache (`npm-cache/_npx/775cd3b968013e52`, a local `file:` package with no dependencies) and start it through WScript, which hung and may have shown a dialog on Ben's screen. Real wrangler never ran. `npx` may have queried the npm registry during that install, and I did not confirm it did not, so the no-network instruction may have been breached there. I killed the process tree, checked that the cache entry named only the stub, and deleted that entry. The rerun used `--no-install`.
