# D-018 gate (Sonnet tier, not the money path): stale bulletin expiry (D-080), run 2026-11-02

Scope `ea24e206..bc8e565a`, worktree `scratch/wt-stale-bulletin`, branch `stale-bulletin-expiry-2026-11-02`. Read-only review. `npm test`: 2946 pass, 0 fail, 1 skipped; `npm run typecheck`: clean.

**VERDICT: DEPLOYABLE WITH CONDITIONS.** HIGH 0, MEDIUM 0. The one condition is a deploy-script housekeeping step, not a code defect.

## What I derived from source

- **Publish paths.** `createPost(` callers under src/maintainer are judgment.ts only: the primary path (`executeJudgmentDecisions` via `resolveExecution`) and the replay (`reconcileApprovedQueue`, bulletin branch). Both are age-checked. `index.ts` and `mcp.ts` posts are direct caller-written posts and out of scope. No third queue-driven path.
- **Replay ordering.** `isStaleBulletin` in `reconcileApprovedQueue` sits after `if (exists) continue;` (judgment.ts ~1563-1572), so a published bulletin that stays `approved` (post 24's row) is never re-stamped "not published". T7 covers it.
- **Expiry UPDATE** (`expireStaleBulletinDrafts`): `WHERE status = 'pending' AND kind = 'bulletin_draft' AND created_at < ?`. Cannot touch other kinds or non-pending rows. One statement, bound `now`, reason, `now - 7d`. Strict `<`, so a draft exactly 7 days old survives.
- **One `now`.** `startedAt` (judgment.ts:1646) feeds the expiry, `reconcileApprovedQueue` and `executeJudgmentDecisions`. No second clock read.
- **items_actioned.** `expiredStaleBulletins` is added on the citizen-load-failure, no-key, pending-count-failure, pending-0 and normal-end paths. It is not in `batchItemsActioned`, and `pendingAtStart` is counted after the expiry, so `computeOverflowDropped` is unaffected. The expiry runs before the citizen load, so a failed load still reports it.
- **Created_at is required** on `QueueRow` and `ReconcileRow`; `tsc` enforces fixtures.
- **Budget.** `JUDGMENT_WAKE_FIXED_COST` 6 to 7 with the statement listed. Arithmetic in the edited assertions re-derived: 12+7+16+8+2=45, 12+7+24+8+2=53, 33+7+8+2=50, and 25+7+8+8+2=50 / 26 sheds. No total-50 invariant was loosened; the compound interior case now sheds before its 3rd batch and asserts the shed line.
- **Served note** (runs.ts): the added sentence is true. Direct maintainer posts are stated not to be queue drafts.
- **Readers of the rows.** grep of src/ for `maintainer_queue` outside judgment.ts: clerk.ts INSERT only, governance.ts fidelity INSERT/NOT EXISTS keyed on kind `constitution_fidelity`. No `decided_reason` reader outside judgment.ts, no public route serves queue rows. The clerk does not dedupe bulletin drafts against queue status.
- **~17 pending production rows.** Bulletin drafts over 7 days old are rejected in one bounded UPDATE (a single D1 subrequest, no per-row work), with the stale reason, and nothing else reads them. Fresher drafts survive. Run row shows `expired_stale_bulletins=N`.
- **Deploy script vs template** `deploy-proposals-unknown-params.ps1`: diff shows only the intended swaps (base pin 07adcc4e full sha, marker `expired_stale_bulletins=N`, step order unchanged, wrangler used once, rollback line derived at runtime from the live attest version id, "no migration" wording true). `$REVIEWED_COMMIT` is a placeholder the script refuses (test-pinned).

## Findings

### HIGH / MEDIUM: none

### LOW

**L1. Fixed-cost change is red-proofed by only one test (accepted).** Three budget proofs (`test/maintainer-budget.test.ts` canOpenJudgmentBatch cases; `test/maintainer-scheduled-budget.test.ts` interior case) were re-derived by hand, not shown to go red at fixed cost 6; `test/model-retry-judgment-d1.test.ts` R13 does go red. Acceptable: the constant is one literal, R13 and the interior-case shed-line assertion bind it from two directions, and the arithmetic is exact at the boundary. Fix, optional: none required.

**L2. Capacity cost.** On a sweep Sunday the interior case now opens two batches, not three (budget.ts:43). This is the intended price of the extra statement and sits under the already-planted `DEFERRED-JUDGMENT-SHED-ROOT-CAUSE`. Fix: none now; the separate brief owns it.

**L3. Behaviour to expect, not a defect.** A stranded approved bulletin older than 7 days is rejected at replay even though the judge approved it (judgment.ts ~1565). That is D-080 as ruled; the stamp reason says so.

## Conditions

**C1.** Before the deploy, the hub sets `$REVIEWED_COMMIT` in `scripts/deploy-stale-bulletin-expiry.ps1` to the reviewed code head and updates the placeholder assertion at `test/deploy-stale-bulletin-expiry-script.test.ts:72` in the same commit (the template test pins the real sha), then reruns `npm test` and the script with `-DryRun`. This gate record is a docs/ file, inside the script's allowlist.
