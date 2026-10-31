# D-018 Sonnet gate: one retry on a failed maintainer model call (D-079)

Scope d9a3c11a..4970af61 on branch model-call-retry-2026-10-31 (worktree scratch/wt-model-retry), against live 95a80c92.
Read: the brief (R1-R24), the converged code exchange, the full source diff, the tests named below. No source or test file changed; no network.

Observed: npm run typecheck clean (tsc, no output). npm test: 2915 tests, 2914 pass, 0 fail, 1 skipped.

## Verdict: DEPLOYABLE WITH CONDITIONS

HIGH 0, MEDIUM 2, LOW 4. Both MEDIUMs concern the deploy and the operator's cron patch, not the code paths in this diff.

## Findings

### MEDIUM

M1. No deploy script is in the scope, and the worker is unsafe to deploy before migration 0022.
- src/maintainer/runs.ts:59-62 (insertMaintainerRun), :95-96 (finalizeMaintainerRun) and src/maintainer/concierge.ts:267-270 (insertConciergeRun) now name model_retry in every INSERT/UPDATE. Against a catalog without the column each throws "no column named model_retry".
- Worker first, concretely: (a) runClerkWake (clerk.ts:443-447) and runJudgmentWake (judgment.ts:1610-1614) hit the reserve-row insert, log *_run_reserve_failed and RETURN, so the 06:00 clerk wake and the Sunday judgment wake do nothing at all; (b) the concierge posts its public comment first (concierge.ts:496) and writes its row last (:524); that insert throws, the outer catch (:332-349) tries a second insert that also throws and is swallowed, so a posted comment can have NO concierge_runs row, and the daily cap (concierge.ts:390, SELECT 1 FROM concierge_runs WHERE engaged = 1) cannot see it, so a second wake the same UTC day (manual trigger) could post again.
- Reads are tolerant: maintainerRunsPage and conciergeRunsPage use SELECT * (runs.ts:168-169, concierge.ts:302-303), so the GET endpoints do not break either way. The catch-up read (catchup.ts:23) names the column but runs only from a registered cron and is wrapped in a try/catch that logs catchup_failed (catchup.ts:46).
- Migration first is safe for the OLD worker: its INSERT/UPDATE statements name explicit columns, and SELECT * just serves an extra model_retry: null.
- Remediation: a deploy-model-retry.ps1 (copy deploy-proposals-unknown-params.ps1, not deploy-moderation-gaps.ps1, per Addendum 108 s4) that applies 0022, reads pragma_table_info for BOTH tables and stops unless both show model_retry TEXT, and only then deploys the worker. Condition C1.

M2. The operator's cron patch turns an existing test red, and nothing in the branch tells the operator.
- test/guest-check-d1.test.ts:139-143 asserts wrangler.jsonc triggers.crons is exactly [CLERK_CRON, JUDGMENT_CRON, LOOP_CRON]. When Ben adds "30 6 * * *" and "30 7 * * 1" (wrangler.jsonc:70 carries three strings) that test fails, so a deploy script that runs the suite stops. The patch must update that assertion in the same commit. No file in the branch carries the exact patch (a grep for the 06:30 string hits only the brief, schedule.ts and the catch-up test).
- UNVERIFIED: whether the account's cron-trigger limit allows five triggers on this worker (and any others on the account). Check in the Cloudflare dashboard before Ben applies the lines.
- Remediation: put the exact wrangler.jsonc line AND the new expected array ([CLERK_CRON, JUDGMENT_CRON, LOOP_CRON, CLERK_CATCHUP_CRON, JUDGMENT_CATCHUP_CRON]) in the deploy hand-over. Condition C2.

### LOW

L1. Two served sentences say "5xx" where the code retries only 500, 502, 503, 504 and 529. src/maintainer/runs.ts:175 (served note) and src/maintainer/concierge.ts:309: "(a 403, 429, 5xx, 529 or network error)". A 501 or 505 is not in RETRYABLE_STATUSES (anthropic.ts:159). The sentence claims only a class that "could plausibly cure", so it is loose rather than false; name the five codes.

L2. Two non-model-failure paths are priced differently from 95a80c92 (both conservative; they can only make the clerk shed earlier in that one wake): a concierge post that throws now charges CONCIERGE_POST_COST 9 where main charged 0 (concierge.ts:486, :545), and the concierge outer catch returns WORST_CASE + 3 = 19 where main returned 16 (concierge.ts:351). The builder changed test/maintainer-concierge-d1.test.ts:599 to expect it. Intended (F3, R20), but it is a delta from "exactly as main" on a path with no failed model call.

L3. Stale comment at src/index.ts:706-711: "Governance sweep first, on every wake ... it runs regardless of which cron fired". A catch-up cron that skips (the normal case) now returns before any sweep (index.ts:698-704). Harmless: the 06:00 and 07:00 invocations still sweep.

L4. src/maintainer/schedule.ts:30-35 carries DEFERRED-CATCHUP-CRON-REGISTRATION. No TODO, FIXME, XXX or "for now" appears in the diff (grep of the full diff returned nothing). The marker is the named deferral covered by item 6 and is accurate.

## 1. Paths with no failed model call

The 06:00, 07:00 and 12:00 crons, unknown crons and the manual trigger behave as at 95a80c92, with L2 the only delta:
- scheduled() adds one pure classifyCron call and returns early only for the two new strings (index.ts:698-704); every other cron falls into the unchanged sweep and dispatch. classifyCron returns the old three values for the old three strings (schedule.ts:44-51). Unknown cron: model-retry-catchup-d1.test.ts:158 pins "sweeps, no wake, no fetch".
- callAnthropic on a 2xx answer returns the same fields plus attempts 1, retryNote null, finalRerunnable false (anthropic.ts:298); strip only removes the internal status/retryAfter.
- Clerk, judgment and concierge write model_retry NULL when there is no note (retryAudit returns null, anthropic.ts:323-326; judgment retryParts empty gives null, judgment.ts:1898; concierge retryNotes empty gives null, concierge.ts:542).
- A non-2xx with an HTML body is now http_error (was unparseable_response) for every caller (anthropic.ts:232-242); a failed call, and the intended R1.
- Manual trigger: trigger.ts untouched; it reaches the wakes with priorCost including its 3-read pre-check, so mayRetry is computed against that.

## 2. Deploy order

See M1. The migration is two ALTER TABLE ... ADD COLUMN statements, nullable, no default (migrations/0022_model_retry.sql:13-14), no rebuild, so L-016 does not bite; schema.sql:184,427 matches (model-retry-migration.test.ts compares the shapes; it applies 0004+0010+0022 only, and no other migration ALTERs either table: grep of migrations/ for ALTER TABLE on the two tables finds only 0022).

## 3. 50-subrequest budget

- Clerk: canAffordClerkRetry needs 50 - priorCost - 18 - 2 >= 1, i.e. priorCost <= 29 (budget.ts:93-95); the retry then shrinks the insert cap by one (clerk.ts:533, affordableClerkInserts, budget.ts:213-216). The 18 already prices the first model fetch (budget.ts:61). Tests model-retry-clerk-d1.test.ts:142,161,180.
- Concierge: canAffordConciergeRetry (budget.ts:305-309): priorCost + 16 + retrySpent + 1 + 2 + 18 + 2 <= 50, i.e. priorCost + retrySpent <= 11. Retries are carried into actualCost at 1 per fetch (concierge.ts:545, CONCIERGE_ATTEMPT_COST = 1), so the guest check, reconciler and clerk see them. Proof: maintainer-scheduled-budget.test.ts PROOF GUEST-CHECK + RETRIES (three candidates, real post, 403 offered to concierge and clerk, cohorts 0/1/2, real counter).
- Catch-up clerk: priorCost = CATCHUP_PRECHECK_COST 1 + estimateSweepCost(n) = 1 + 3 + 9n; SWEEP_COHORT_CAP = 2 (governance.ts:1769, confirmed), so <= 22, and 22 when the sweep throws (catchup.ts:37-41). The concierge, guest check and reconciler do not run, so the clerk sees 22: retry affordable (22 <= 29), insert cap min(cap, 50-23-20) = 7 after a retry. Separate invocation, own 50.
- Catch-up judgment: same priorCost <= 22; canAffordJudgmentRetry counts the current batch in batchesRun (incremented before the call) and retrySpent enters effectivePriorCost for every later canOpenJudgmentBatch/classifyChunkBudget (judgment.ts:1787). Tests model-retry-judgment-d1.test.ts:120,140.
- Catch-up runs AND the wake retries: the two paragraphs above plus model-retry-catchup-d1.test.ts:173 (precheck cost).
- UNVERIFIED, pre-existing if real: GEMINI round 1 computed 51 for a cohort-2 scenario with no retries (replayed stranded rows, comment-on-comment, 4-RPC drift fallback); the hub could not reproduce it and left it as a follow-up. I did not seed it.

## 4. Served strings

- runs.ts:175 note: each clause I checked matches code (separate column, not in error; retried at most once; not after timeout, refusal, unparseable answer, 400/401/404/413; the four value shapes; the "rerun: " prefix rule; the catch-up reads one row, runs only when finished and "rerun:", otherwise no row and no model call; the two residuals). Only L1.
- concierge.ts:309 note: R5 fixed (a failed call is zero tokens, no longer called "paid"); the "no trace" sentence is bounded to the first failed attempt of a recovered call; timeout named. Pinned by model-retry-served.test.ts.
- src/discovery.ts:191-192 and src/doc.ts:310,794 do not list run fields, and a grep for tokens_in / items_drafted finds only the three maintainer files, so no other served surface needed the new field.
- The runs note says the catch-up fires only if the operator has registered the cron lines: true whether or not they are ever added.

## 5. Tests

- The pivotal ones can go red by construction: model-retry-clerk-d1.test.ts:48 (recovered run keeps error NULL, next cursor moves past it), model-call-retry.test.ts:88 (HTML 503 retried), model-retry-concierge-d1.test.ts:96 (post-throw cost), model-retry-served.test.ts (text pins). I did not mutate code to re-prove them; the hub reports doing so.
- Wake-level tests use the real 2 s sleep (delay values are asserted only in the unit table); slower, not weaker.
- model-retry-migration.test.ts reads the catalog on a 0004+0010+0022 build; nothing exercises prod's column set. The scratch-D1 rehearsal the brief requires (R3) is not evidenced in the branch; see C1.
- Gap: no test fails when wrangler.jsonc and the two catch-up constants disagree; the only cron-registration test pins three strings (M2).

## 6. wrangler.jsonc

Unchanged (triggers.crons = three strings, wrangler.jsonc:70). With only those, classifyCron never returns a catch-up kind, the new scheduled() branch never runs, and the wave's effect is the retry inside the three existing wakes plus the new column. Inert and safe without the cron lines; the served note describes the catch-up as conditional on registration.

## Conditions

C1. A deploy script that applies migrations/0022_model_retry.sql to prod BEFORE the worker, verifies pragma_table_info shows model_retry TEXT on both maintainer_runs and concierge_runs, and stops otherwise; rehearse 0022 on the scratch D1 first. No other deploy route.
C2. Before Ben adds the cron lines: hand over the exact wrangler.jsonc patch together with the updated expectation at test/guest-check-d1.test.ts:142, land both before $REVIEWED_COMMIT is set, and confirm the account's cron-trigger count allows five.
C3. After deploy, ride it: on the first real model-call failure read the run row's model_retry; confirm the 1 Nov 06:00 clerk and 07:00 judgment rows finalise (finished_at set).

## Unverified

- Cloudflare cron-trigger limit for this account (dashboard, no command).
- GEMINI's 51-subrequest cohort-2 scenario on 95a80c92: needs a seeded fixture under installSubrequestCounter (replayed stranded rows, comment-on-comment, 4-RPC drift fallback).
- That each pivotal test is red against a mutated build: remove the retry in callAnthropic in a scratch copy and run node --test test/model-call-retry.test.ts.

## Addendum: the clerk catch-up against the idle-skip rule (checked at the advisor's request)

Question: can the 06:30 clerk catch-up skip as "idle" because it compares its live drift to the delta the FAILED 06:00 row recorded?

Result: not reachable in the shape asked, by reading (not by running a fixture).
- The failed-call exit does record the delta (clerk.ts:~519, driftDeltaCents: drift.deltaCents), and getMostRecentClerkDelta (clerk.ts:401) has no error IS NULL filter.
- But the wake inserts its OWN row first (clerk.ts:443, delta NULL) and reads previousDelta afterwards (clerk.ts:~480-482) with ORDER BY started_at DESC LIMIT 1 and no id exclusion, so on the production path previousDelta is the current wake's own NULL, not the prior row's delta. shouldSkipIdleClerkWake (clerk.ts:246-250) therefore skips only when there are no candidates AND the live drift is itself unreadable (null). A numeric live drift never equals the NULL, so a catch-up with zero candidates and a readable drift proceeds to the model call. A catch-up with candidates never skips (clerk.ts:247).
- The one residual: the 06:00 wake failed on the model with a numeric drift and zero candidates, and at 06:30 the drift probes are unreadable (null) with zero candidates: the catch-up skips as idle. Narrow, and arguably correct (nothing to report).

LOW (pre-existing, not from this wave, recorded because the catch-up now depends on this code): L5. The M5 idle-skip chain appears not to work as its comment says (clerk.ts:392-405, 491): the DB read sees the wake's own freshly inserted NULL row. Only the pure function is tested (test/maintainer-clerk.test.ts:367); no test drives the DB read. Verify: seed a clerk row with drift_delta_cents = 5 and zero candidates, run runClerkWake with live delta 5, and see whether it skips (it should per the comment). If it does not skip, the idle skip never saved a model call on main either; that is why the catch-up is not blocked by it today. Fixing it (exclude the current id, or read only error IS NULL rows) would make the catch-up skip a failed-then-unchanged morning, so it must be fixed together with a catch-up bypass, not alone.

Addition to C2's hand-over for Ben: the catch-up covers a model-call failure on a wake that had work to do (candidates, or a readable changed drift). It does NOT cover a killed or still-open wake (open row), a failure whose final error is not retryable-class (401, 400, refusal, unparseable), or the concierge's own failure (the concierge never feeds the clerk row). Do not add the lines on the promise that it covers every bad morning.
