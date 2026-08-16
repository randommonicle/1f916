# CHECKPOINT — pre-gate fixes wave

Builder log for a three-commit wave closing the two HIGHs and the
contention finding from Codex's combined-deploy pre-gate
(`exchange/REVIEW_combined-deploy-pregate_2026-08-16.md` `## [CODEX round 1]`;
the contention verification is `exchange/REVIEW_query-budget-brief_2026-08-15.md`'s
last `## [CODEX round 1]`). Each finding was REPRODUCED by Codex; each fix is
re-derived at source and red-proved at the same boundary Codex used.

Baseline probed at HEAD `9fe6705`: `git status -sb` clean, `main` ahead 13 of
`origin/main`; `npm --prefix society test` 617/617 pass exit 0;
`npm --prefix society run typecheck` clean exit 0.

---

## Commit 1 — HIGH 1: throttle backstop accepts the one-over (money-touching)

**What it did.** D-042's original ruling made the pre-settle throttle
precheck (`assertRegistrationNotThrottled`, called from `register-gate.ts`
step 3, before `buildPaymentRequirements`) the primary gate, but
`register()` (`society.ts`) kept its own call to the SAME function as a
"backstop" running AFTER settle. Codex proved this backstop unsound: two
same-IP rows seed the precheck at count 2 (under the 3/hour limit), the
precheck passes, a THIRD same-IP row lands during the facilitator's
`/verify` round trip (a genuinely concurrent second registration), settle
proceeds and the ledger is written, then `register()`'s own COUNT-and-throw
finds the count now at 3 and throws 429 — wrapped into the paid-but-failed
500, exactly the defect D-042 existed to close, just moved one layer in.

**Fix.** Ben's same-day D-042 amendment (recorded in `DECISIONS.md`):
accept the one-over. Removed the `await assertRegistrationNotThrottled(env, ip)`
call from `register()` entirely — the pre-settle precheck in
`register-gate.ts` is now the SOLE gate for the throttle. The `reg_log`
INSERT and the 24h-prune DELETE stay exactly where they were in
`register()`, running unconditionally on every successful, settled
registration, so a future count still sees this one. `assertValidModel`
stays as a genuine backstop in `register()` (pure, deterministic, no race
possible — the exact distinction the fix turns on). Planted the grep-able
marker `FORWARD(D-042): accept-one-over; a future society may replace this
with atomic quota reservation for strict enforcement.` at the changed site.
Updated the two comments that had asserted the now-false claim ("register()
still calls it as a backstop") in `society.ts` (both
`assertRegistrationNotThrottled`'s header and `register()`'s own body) and
in `register-gate.ts` (step 3's comment) — grepped `backstop` across `src/`
to find every site asserting this fact before editing, not just the two
obvious ones.

**Red-proof (pasted, run against the UNFIXED code first).** New test in
`test/register-gate-d1.test.ts`: seeds 2 same-IP `reg_log` rows (under the
limit), lets `register-gate.ts`'s precheck pass, then inserts a THIRD
same-IP row from inside the stubbed facilitator's `/verify` callback —
Codex's own interleaving, not a contrived direct call. Against the unfixed
code:

```
{"level":"error","event":"registration_paid_but_failed","payer":"0x00000000000000000000000000000000000abc","tx":"0xfeedfeedfeed","amount_cents":100,"handle_attempted":"one-over-citizen","ledger_receipt":"9d59a871caacd8596cd8094da1250d70f2eee646823e07f2e3ff1a7ea8966f70","reason":"Too many registrations from your address this hour. One identity is usually enough."}
✖ RED-PROOF (D-042 amendment, HIGH 1): a third same-IP registration lands during the /verify callback -- register() must accept the one-over, never paid-refuse (33.5404ms)
  Error: Your $1 payment settled (tx 0xfeedfeedfeed) but registration then failed: Too many registrations from your address this hour. One identity is usually enough.. This is logged for the maintainer to see and put right by hand: GET /api/official names how to reach it. Your payment is already in the books: GET /treasury.
      at handleRegisterGate (src/register-gate.ts:173:11)
    status: 500
```

Settle genuinely ran (verify + settle both called, ledger written per the
log line) before the refusal — the exact shape Codex described. After the
fix, the same test: 201 citizen created, `verifyCalls===1`,
`settleCalls===1` (settle ran exactly once, not retried), one ledger entry,
and `reg_log` carries 4 rows for the IP (2 seeded + 1 raced + register()'s
own insert) — the one-over is recorded, not refused.

**Kept, unchanged, still green:** the existing "a payer whose IP is already
at the 3/hour registration limit is refused BEFORE settle" test
(`register-gate-d1.test.ts`) — proves a payer already OVER the limit AT
PRECHECK TIME is still refused pre-settle, settle never called. This is
the case the task asked to keep proven; it required no changes since the
fix touches only `register()`'s post-settle path, never the pre-settle
gate.

**Behaviour preserved.** The offender-scan test ("register() is called
only from register-gate.ts, nowhere else in src/") stayed green throughout
— no new caller was introduced. Full suite 618/618 (617 + 1 new), typecheck
clean. Three touched files (`src/society.ts`, `src/register-gate.ts`,
`test/register-gate-d1.test.ts`) NUL-clean (red-proofed against a scratch
file carrying a real NUL byte first: `tr -d '\0' < f | cmp -s - f` correctly
exits 1 on the NUL scratch file and 0 on all three touched files), no
backslash-u escape notation anywhere. `git diff dfc3988..HEAD --stat --
migrations/ schema.sql` still empty.

Commit `1fb7ee3`.

---

## Commit 2 — HIGH 2: price the classification chunks so the wake sheds before the finalise write is refused

**What it did.** `JUDGMENT_BATCH_COST=8` (`src/maintainer/budget.ts`) prices
a scan page read, a model fetch, and up to six decision writes, with ZERO
allocated to classification chunking (1+0+1+6=8 by the constant's own
derivation). `classifyAndHydratePage`'s five bulk fan-out reads (flag_review
post/comment bodies, constitution_fidelity version existence, linked
mandates, version+predecessor bodies) are each chunked at
`D1_MAX_BIND_PARAMS=100` ids per statement — a page dominated by many
DISTINCT ids in one category (Codex's reproduction: hundreds of
constitution_fidelity rows each naming a different missing version) needs
far more chunk statements than the flat estimate prices. Codex measured the
extra chunks pushing the wake's own finalise write into the refused 51st
subrequest at 401 pending fidelity rows.

**Fix — a computed classification cap the budget affords.** Chose this over
a live "stop mid-chunk-loop" interrupt: interrupting `classifyAndHydratePage`
partway through a chunk loop risks fabricating a disposition for a row whose
data was never actually checked (e.g. reporting "version missing" for a row
whose existence chunk simply never ran) — a correctness hazard the brief's
own L-003 norm (never invent an artifact that is not there) forbids. Instead:

- `budget.ts` gained `D1_MAX_BIND_PARAMS` (moved here from `judgment.ts`,
  now the single source both the real `chunk()` calls and the pricing model
  use), `classifyChunkCost(postCount, commentCount, fidelityCount)` — a
  pure, conservative (>= real) worst-case chunk-statement count computed
  from ROW COUNTS alone (cheap, in-memory, zero extra D1 cost, since
  distinct ids in any category can never exceed that category's own row
  count) — and `classifyChunkBudget(priorCost, replayRowsProcessed,
  batchesOpened)`, exposing `canOpenJudgmentBatch`'s own slack arithmetic as
  a number instead of a boolean.
- `judgment.ts` gained `safeClassifyPrefixLength(page, chunkBudget)`: walks
  the ALREADY-FETCHED page (no extra D1 cost) and finds the longest PREFIX
  (in scan order) whose worst-case chunk cost fits the budget.
  `scanPendingQueueBatch` now truncates its page to that prefix BEFORE
  calling `classifyAndHydratePage` — the untruncated remainder is simply
  never looked at this call (never a false disposition), and the cursor
  stops before it so the next call re-scans it fresh, the identical idiom
  already used for a cap hit or a byte-budget defer. New optional 5th
  parameter `chunkBudget = Infinity` (every existing direct-harness test
  caller is unaffected, unedited).
- `classifyAndHydratePage` now counts every chunk statement it actually
  issues (`chunksIssued`) and returns it alongside its classification map —
  pure bookkeeping, no query or control-flow change.
- `runJudgmentWake`'s batch loop accumulates `classifyExtraSpent` (the REAL
  extra chunk cost every completed `scanPendingQueueBatch` call issued this
  wake) and folds it into `priorCost` for every later `canOpenJudgmentBatch`
  / `classifyChunkBudget` call — otherwise a classification-heavy batch's
  real overspend would be invisible to the NEXT batch's own gate, since
  `canOpenJudgmentBatch` only ever assumed the flat `JUDGMENT_BATCH_COST`
  per completed batch.
- A new loud, named run-error clause ("judgment classification shed for
  subrequest budget...") fires whenever any call this wake truncated —
  matching the `scanLimitHitOverall`/`batchesShed` idiom already in the
  file. The unclassified rows are never actioned or withheld, so
  `computeOverflowDropped` counts them as backlog automatically — no
  special-casing needed, the shed is published via the SAME two idioms
  (`overflow_dropped` and the run error) the task asked for.

**Flagged residual, not silently smoothed over.** `classifyChunkCost` prices
the mandate/body fan-outs assuming at most a handful of linked mandates per
constitution version; a version naming unusually many mandates is not fully
priced by this conservative bound. Documented at the constant's own site
(`budget.ts`) as the same class of accepted, made-rare residual
`FINALISE_RESERVE`'s own comment already carries for chain-retry
contention — constitution versions come from the governance amendment
process, not an unauthenticated public surface, so this is not
attacker-reachable the way a pending-queue backlog organically is.

**Red-proof (pasted, run against the UNFIXED code first).** New test in
`test/maintainer-scheduled-budget.test.ts`, `PROOF J-interior-401`: the
identical fixture shape to the existing `PROOF J-interior` (1-due sweep + 1
replayed row + 5 pending bulletins), with 401 missing-version fidelity rows
instead of 50 (Codex's own reproduction number). Reverted only the source
fix via `git stash` (keeping the new test in the working tree) to run it
against the unfixed code:

```
{"level":"error","event":"judgment_run_finalize_failed","run_id":2,"message":"Error: subrequest budget exceeded: attempted subrequest 51 of a 50-subrequest invocation (this one is a d1); running totals d1=48 fetch=3"}
✖ PROOF J-interior-401 ... (52.7612ms)
  AssertionError [ERR_ASSERTION]: 401-row fidelity head never exceeded budget (total 51, d1 48, fetch 3)
  true !== false
```

Byte-for-byte the same numbers Codex pasted (`d1=48 fetch=3`,
`judgment_run_finalize_failed`) — the finalise write is the refused 51st
subrequest. After restoring the fix (`git stash pop`), the same test: total
stays <= 50, `breached()` false, and the run's `error` column matches
`/classification shed for subrequest budget/` — the shed fired and was
published, not silently dropped.

**Lower-count scenario proving normal operation is unchanged.** The
EXISTING `PROOF J-interior` (50 missing-version rows, same sweep/replay
shape) stayed green throughout with NO changes to its own assertions or
measured values — confirmed by hand before writing the fix: at that
fixture's batch-1 slack (`classifyChunkBudget` computes 16 there), the
conservative cost for 50 fidelity rows is 3 (well under budget), so
`safeClassifyPrefixLength` never truncates and classification proceeds
byte-for-byte as before. Full file (12 tests) reran green after the fix,
including `PROOF J6` (60-row fidelity head, a different sweep/replay
shape) and every clerk/sweep-cohort scenario, none of which touch the
judgment classify path or were affected.

**Behaviour preserved.** Full suite 619/619 (618 + 1 new), typecheck clean.
Three touched files (`src/maintainer/budget.ts`, `src/maintainer/judgment.ts`,
`test/maintainer-scheduled-budget.test.ts`) NUL-clean, no backslash-u escape
notation anywhere. `git diff dfc3988..HEAD --stat -- migrations/ schema.sql`
still empty — `judgment.ts`'s own diff is code-only (no new table, no new
column; `chunksIssued`/`classifyBudgetExhausted` are in-memory fields on an
existing internal interface, not persisted).

Commit `<filled after this commit lands>`.

---
