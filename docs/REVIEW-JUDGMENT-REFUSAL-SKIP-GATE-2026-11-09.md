# D-018 gate (Sonnet tier, not money path): judgment refusal-skip wave

Tree: branch judgment-refusal-skip-2026-11-09 at 6c908fd0, base main c05f2f36. Reviewer: Sonnet 5.5 gate. Read-only except temporary mutants, all restored (`git status --short` clean).

## Verdict: DEPLOYABLE WITH CONDITIONS

Severity counts: HIGH 0, MEDIUM 0, LOW 2, INFO 2.

Evidence: `npm test` 3016 tests, 3015 pass, 0 fail (one non-pass is a skip/todo, not a failure); `npx tsc --noEmit` clean; the two wave test files 16/16.

## Path analysis (judgment.ts 1851-1931)

1. Refusal, 1 admissible item (the only reachable refusal shape, JUDGMENT_QUEUE_CAP = 1, judgment.ts:71): id pushed to refusedIds, one error clause, no parse and no execute (the else branch holds both), falls to `shouldContinueBatchLoop` at :1931. The item row is never written (no UPDATE on this path), so it stays pending and cannot be approved, rejected or executed by this wake (T1/T2/T3 assert status).
2. Refusal, admissible.length != 1: unreachable at CAP = 1; would fall to the generic `!result.ok` break (old behaviour). Safe.
3. Other failures (500, timeout, no_api_key, unparseable, no text block): unchanged generic break (R1 green). `endedRerunnable` is set only for retryable/timeout failures; a refusal is neither, so `model_retry` stays null, matching the runs.ts note ("never after a refusal").
4. Success: unchanged.
5. Termination: every iteration either breaks or reaches :1931. The cursor is `nextCursor`, null only when `drained` (:991), and `drained` stops the loop. A non-drained scan returns a real resume point past the refused row, so the same item is not reselected within the wake. Hard caps remain: JUDGMENT_MAX_BATCHES = 4, `canOpenJudgmentBatch` budget gate, `scanLimitHit`. A refusal is still billed in tokens/cost (usage added before the branch). T5 shows four batches within 50 subrequests with a refusal in batch 1.
6. Run row for a refusal wake: items_actioned counts only executed items; overflow_dropped = max(0, pendingAtStart - actioned - withheld - refused) (T3: 5 pending, 4 refused, overflow 1, correct); error holds one clause per refusal; model_retry null. Mixed wake (refusal then a later hard failure) correctly keeps the failure clause and break.
7. Served text: the runs.ts note gains the one sentence, matching what the code does. No other served surface (doc.ts, discovery.ts) mentions judgment refusal behaviour (grep). src/doc.ts, migrations and schema.sql untouched, so non-minting; the script's step 0 enforces it.

## Findings

- F1 (LOW) judgment.ts:1894-1897 (the length === 1 guard): mutant M3 (guard removed) survives the whole suite. The multi-item refusal branch is unreachable at CAP = 1, so no test can reach it. Acceptable as a defensive guard; if JUDGMENT_QUEUE_CAP is ever raised, a test for a refused multi-item batch must be added in the same change. Suggest a one-line comment or flag at JUDGMENT_QUEUE_CAP naming this dependency.
- F2 (LOW) residual, as the brief states: four always-refused items at the head of the queue still consume all four batches every wake and later items starve; remedy is the operator's hand (read, reject under live-data-surgery). `DEFERRED-JUDGMENT-REFUSAL-HELD-STATUS` is planted at the branch and anchored by the deploy script. Also note a refused item re-raises its clause every wake, so `error` is non-null on those wakes: the morning watch report will see a recurring "error" that is a designed outcome (the note says so).
- I1 (INFO) the refusal else-block in judgment.ts is not re-indented (the generic code sits unindented inside `else {`); cosmetic only.
- I2 (INFO) the brief's R2 ("maintainer-scheduled-budget.test.ts stays green with a refusal") is met by T5 in the new file plus the unchanged existing file passing in the full suite.

## Deploy script review (scripts/deploy-judgment-refusal-skip.ps1)

- Both pins ($LIVE_BASE_COMMIT, $REVIEWED_COMMIT) are placeholders; step 0a stops before any git/network on a placeholder or non-40-lower-hex; the script test runs the pin block for real. So the script cannot deploy as committed: the hub must set both pins (this adds a commit that must be on the allowlist, which it is: the script, its test, docs/).
- Allowlist: script, its test, `docs/` prefix (ordinal, case-sensitive). Anything else changed since the reviewed commit stops the deploy. The gate record itself lives under docs/ and is covered. Note `docs/` is a prefix, so any docs/ file is allowed, which is correct for this wave.
- Order: fetch, main = origin/main = expected = HEAD, clean tree, ancestor of live base, no change to doc.ts/migrations/schema.sql, reviewed-ancestor + allowlist, source anchors, tests+typecheck, live before-reads (v6 hash, four chains, live code.commit equals the pin, runs note lacks the sentence so the poll proves something), HEAD/clean re-read immediately before wrangler, stamped deploy, single Current Version ID parse (stops on 0 or 2+), poll on commit + version id + served note, ride re-checks identity, 17 public GETs. Rollback target is read live, not typed; ROLLBACK_LINE is defined before the first use that can need it. No POST, no body, no migration.
- No false-success route found: success requires served commit, version id and note sentence. The ride cannot prove the refusal path itself (stated in the final `[note]`).
- Anchors checked by the script test against real files (refusal clause, DEFERRED flag, runs.ts sentence).

## Mutants run (each restored)

- M1 drop `refusedIds.length` from overflow: T1, T2, T3 red. Caught.
- M2 bare `continue` after the push: T2, T3 red. Caught.
- M3 remove `admissible.length === 1` guard: all green. Survives (F1, unreachable at CAP = 1).
- M4 refusal condition disabled (old break): T1, T2, T3, T5 red. Caught.
- M5 clause text changed/removed: T1, T2, T3, T5 red. Caught.

## Missing against the brief

Nothing found. Items 1-6 of the change, T1-T4, R1, R2 (via T5), the residual, and the DEFERRED flag are present. The gate record and handover mention of the residual are to be committed by the hub.

## Conditions

- C1. The hub sets both pins in the script (live base = what /api/attest serves at deploy time, reviewed = the converged commit); the real run goes only after `-DryRun` passes.
- C2. The refusal path is first ridden by the next judgment wake that meets a refusal: read its row in GET /api/maintainer-runs and confirm error names the item by kind and id, the item is still pending in the queue, overflow_dropped excludes it, model_retry is null, and the wake went on to later items.
- C3. If JUDGMENT_QUEUE_CAP is ever raised above 1, add a refused multi-item batch test first (F1).
- C4. Handover and DECISIONS record the F2 residual and tell the morning watch that a refusal clause in `error` is a designed outcome.
