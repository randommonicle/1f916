# CHECKPOINT — the judgment subrequest-budget wave (D-036/D-037/D-038/D-041)

Builder log for the wave commissioned in
`docs/BRIEF-JUDGMENT-QUERY-BUDGET.md` (project root). Per-commit entries,
one concern each; the load-bearing red-proofs are pasted here as evidence
for the D-018 re-gate.

Baseline probed at HEAD `05c352f`: `git status -sb` clean and level with
`origin/main`; `npm test` 573/573 pass exit 0; `npm run typecheck` clean
exit 0; `git diff dfc3988..HEAD --stat -- migrations/ schema.sql` EMPTY.

Note on placement: the brief's Custody section names project-root
`docs/CHECKPOINT.md`; the commission ROLE says keep the per-commit log
"in the repo" with default `society/docs/CHECKPOINT-QUERY-BUDGET.md`.
Resolved in favour of in-repo so the log travels with the commits for the
gate to re-derive, and so nothing outside `society/` is edited. Flagged in
the final report.

---

## Commit 1 — the subrequest-counting proof seam (test infrastructure)

**What it did.** Added the seam THE PROOF is built on: every D1 statement
AND every outbound `fetch()` counted against one shared 50-subrequest
budget, throwing before the 51st.

- `test/helpers/local-d1.ts`: `createLocalD1()` gains an optional
  `{ onExec }` hook, called once per `first()`/`all()`/`run()` and once per
  statement inside `batch()`, BEFORE the statement runs. Every existing
  caller passes nothing and is byte-for-byte unaffected; seeding via
  `d1.raw` stays uncounted (scaffolding, not code under test).
- `test/helpers/subrequest-counter.ts` (new): `installSubrequestCounter`
  wraps `globalThis.fetch` and shares one `consume(kind)` closure with the
  D1 hook. `consume` increments and throws before executing subrequest
  `limit+1`, AND latches a `breached` flag so a throw swallowed by
  production try/catch (callAnthropic converts a fetch throw to ok:false;
  runJudgmentWake logs a scan throw; scheduled() has a backstop catch)
  cannot read as green. Plus response-shaped bodies for the two real fetch
  shapes (Anthropic judgment/clerk by pinned model name; Base RPC balance).
- `test/subrequest-counter.test.ts` (new): 4 tests pinning the seam —
  D1+fetch share one counter; each batch statement counts individually;
  the 51st THROWS before executing, proven for a D1 statement AND for a
  fetch (a proof that only fails on "query 51" would miss the fetch case).

**Key decision.** The verdict for the e2e proofs is `total() <= 50 &&
!breached()`, not "did it throw" — because production code legitimately
catches throws, so a swallowed budget breach must still fail the test. The
throw still fires (simulating the platform killing the 51st op); the flag
is the durable evidence.

**Latitude.** The brief named `local-d1.ts:36-47` as "the seam"; the actual
execution methods are the `statement()` closure and `batch()` body, so the
hook lives there. No behaviour change to any existing path.

**Red-proof.** The seam's own can-it-fail is the `assert.rejects` at the
51st subrequest, proven for both a D1 statement and a fetch (see the test
file). Full suite 577/577 (573 + 4), typecheck clean.

Commit `be307e5`.

---

## Commit 2 — §3: reconciliation loop → one `INSERT ... SELECT`

**What it did.** Rewrote `reconcileConstitutionFidelityQueue`
(`src/governance.ts`) from a whole-table read + one idempotent INSERT per
non-genesis version (1+N statements, on BOTH cron wakes = 8×/week) to a
single `INSERT ... SELECT` with the source read moved inside it. Fixed one
D1 statement regardless of N. The note is assembled in SQL with
`||`/`substr(...)` byte-identical to the JS prose the loop built.

**Key decision.** Rows-read is NOT claimed closed and the report says so:
the `INSERT ... SELECT` still scans `constitution_versions` inside the one
statement; the `NOT EXISTS` bounds it to un-queued versions but with no
index on `maintainer_queue.source_ref` the correlated check is per source
row. Growth is one row per constitution-changing deploy, static between
deploys, negligible against the subrequest budget. The subrequest
multiplier (the wave's actual target) IS closed: 1+N → 1.

**Latitude.** None beyond the brief's explicit §3 grant to either bound
rows-read or state it accepted; I stated it accepted, with the reason.

**Behaviour preserved.** All four existing `reconcileConstitutionFidelityQueue`
D1 tests stay green (queued count, error null, source_ref regex,
run_id/kind/target/status, idempotency, genesis exclusion). No test pins
the note text; all concatenated columns are NOT NULL in schema, so the
concat can never collapse the NOT NULL note to SQL NULL.

**Red-proof (pasted).** New test "costs ONE D1 statement regardless of how
many non-genesis versions it queues" seeds 5 non-genesis versions and
asserts `counter.d1() === 1`. Reverted the function to the per-row loop and
re-ran:

```
✖ reconcileConstitutionFidelityQueue costs ONE D1 statement ...
  AssertionError: ... The old 1-per-version loop would report 6 here ...
    actual: 6,
    expected: 1,
```

Restored → green. Full suite 578/578, typecheck clean, both files
NUL-clean. Commit `08bec68`.

---

## Commit 3 — §1/§2: set-based fidelity classification + bulk hydration

**What it did.** Rewrote the scanner's hydration (`src/maintainer/judgment.ts`)
from per-row to set-based. Removed the per-row helpers
(`fetchTargetContentForJudgment`, `fetchConstitutionVersionForFidelity`,
`fetchPreviousConstitutionVersionForFidelity`,
`fetchMandateProposalsForFidelity`, `hydrateFidelityEvidence`,
`hydrateQueueRow`) and added `classifyAndHydratePage`: it classifies the
WHOLE page's admissibility in a fixed number of bulk queries (flag_review
target reads; fidelity version-existence + predecessor-id + mandate-ids;
bulk mandate read) and fetches version + predecessor BODIES only for the
classification-admissible set, in bulk. `scanPendingQueueBatch`'s walk is
byte-for-byte the same control flow; it reads each row's disposition from
the precomputed map instead of hydrating inline, so scannedCount, the
byte-budget admit/defer/withhold split, cursor advancement, and
scanLimitHit/drained are all preserved.

**Key decisions / latitude.**
- §2 choice: `WHERE id IN (...)` chunked at the 100-param cap (not
  `json_each`) -- it is the plainer read against this schema and the chunk
  count IS the pinned regression cost. `placeholders(n)`/`chunk()` helpers.
- Combined mandate existence + body into ONE bulk read rather than an
  existence-then-body split: query COUNT (not bandwidth) is the budget, so
  one fewer query-set wins; a little unused body bandwidth for a row later
  withheld for a different reason is the accepted trade. Only mandate ids of
  EXISTING versions are looked up, so the missing-version fixture never runs
  a mandate query.
- `buildFidelityEvidenceBlock` and the two evidence interfaces kept
  byte-for-byte; mandates assembled in `mandate_proposal_ids` order, so the
  M-1/F8/F9 byte measures are identical.
- The prev_id subquery is the identical `(first_seen_at, id)` total order the
  per-row fetch used -- predecessor selection unchanged.

**Behaviour preserved.** All 33 existing judgment D1 red-proofs stay green
(F4/F7 withhold-then-reach, F8 combined-budget split + lone-oversized
withhold, F9 control-heavy + CJK byte measures, M-1 real-archive content +
missing-mandate withhold). The withhold reason strings are byte-identical.

**Red-proof (pasted).** New "§1 regression fixture: a 1,000-row
missing-version pending head classifies in a PINNED 11 D1 statements" asserts
`counter.d1() === 11` (1 page + 10 version-existence chunks). Mutated
`D1_MAX_BIND_PARAMS` from 100 to 1 (== per-row hydration) and re-ran:

```
✖ §1 regression fixture ...
  Error: subrequest budget exceeded: attempted subrequest 51 of a
  50-subrequest invocation (this one is a d1); running totals d1=51 fetch=0
```

That is the founding error of this wave reproduced exactly: per-row
hydration blows the 50-subrequest budget mid-scan. Restored → green. Full
suite 579/579, typecheck clean, both files NUL-clean. Commit `231fcc8`.

---

## Commit 4 — §4 honest constants (partial) + §6 replay LIMIT

**What it did.** (`src/maintainer/judgment.ts`)
- `JUDGMENT_QUEUE_CAP` 100 → **1** (D-037): 17 fixed + 24C, C=1 costs 41, C=2
  costs 65, ceiling 50. At most four decisions per weekly wake, an upper
  bound not a promise. Comment records the ruling and that 100 was a
  pre-existing defect, not a First Laws regression.
- `JUDGMENT_MAX_SCAN` stays 1000; its comment rewritten to state the real
  post-§1/§2 relationship (a row/memory ceiling, NOT a per-cap query
  multiplier; the cap is a separate decision-throughput ceiling; only the
  subrequest proof ties either to the platform).
- §6: `JUDGMENT_REPLAY_CAP = 3` and `fetchReconcilableApprovedRows` gains
  `LIMIT ?`, KEEPING `ORDER BY decided_at DESC` (load-bearing against gate
  reproduction G1). Rows beyond the cap wait for the next wake; replay is
  idempotent so deferral is safe.

**Key decision / value chosen.** Replay cap R=3. Arithmetic: each replayed
row costs ≤6 subrequests, so R≤18. The §9 budget-aware batch loop (later
commit) sheds batches to pay for whatever the sweep and this replay consume,
and the non-sheddable floor (sweep cohort + replay + the wake's fixed reads +
the finalise write) must stay under 50 so the loud run-row write always
lands. R=3 is a builder-chosen value; **flagged for the D-018 gate to
sanity-check against the §9 compound proof** — if a real backlog ever needs
faster draining that is a throughput ruling, not a code change.

**Test updates forced by the cap change** (kept green, not weakened):
- `maintainer-judgment.test.ts`: "JUDGMENT_QUEUE_CAP is 100" → "is 1";
  the stale "MAX_SCAN > cap*5" rationale rewritten to assert the real
  row/memory-ceiling relationship; new test pins JUDGMENT_REPLAY_CAP small
  and positive.
- `maintainer-judgment-d1.test.ts` F7: the withheld head-cohort size was
  `JUDGMENT_QUEUE_CAP` (a magnitude that collapsed to 1 and broke the plural
  assertion). Decoupled to a local `WITHHELD_COHORT = 100` so the
  starvation-avoidance intent survives; the F8/F9 byte tests still pass the
  cap through and stay green at cap=1 (the two-item split now lands via the
  cap rather than the byte budget, and the sanity precondition still holds).

**Red-proof (pasted).** New "§6 replay cap" test seeds R+2=5 stranded
bulletins and asserts `actioned === 3`, the newest 3 posted, oldest 2
untouched. Removed the `LIMIT ?`:

```
✖ §6 replay cap ...
    actual: 5,
    expected: 3,
```

Restored → green. Full suite 581/581, typecheck clean, all three files
NUL-clean. Commit `2d539cb`.

---

## Commit 5 — §7(a): clerk set-based flag hydration

**What it did.** Replaced the clerk's per-flag-candidate loop
(`fetchClerkCandidates`, `src/maintainer/clerk.ts`) -- which called
`fetchFlagTargetText` once per flag, up to `CLERK_INPUT_CAP=50` subrequests
on its own -- with at most TWO bulk reads (one flagged-posts IN-query, one
flagged-comments IN-query). Removed the now-dead `fetchFlagTargetText`. The
pure `shapeFlagTargetText` is unchanged, so the per-target shaped-text /
sentinel semantics (post → title+body, anything else → comments table, a
vanished row → its sentinel) are byte-identical. No chunking: the flag stream
is capped at 50, under D1's 100-param ceiling.

**Behaviour preserved.** All 59 clerk tests stay green; no test referenced
the removed helper.

**Proof placement (deliberate).** §7's subrequest red-proof and the bulk-fetch
correctness proof (right flag → right target row) live in the PROOF commit's
mandated clerk end-to-end proof (shape 2: "a full 50-candidate flag-heavy
gather"), where the flag hydration cost is proven flag-count-INDEPENDENT and
red-proved by reverting to per-flag. Flagged here so the deferral is visible:
between this commit and the PROOF commit, §7(a)'s correctness rests on the
unchanged shaping function plus structural review of the map lookup (postMap
keyed by post id, commentMap by comment id, resolved by the flag's own
target_type -- no cross-table id collision). Full suite 581/581, typecheck
clean, clerk.ts NUL-clean. Commit `<pending>`.

**§7(b) — CLERK_QUEUE_CAP** is set in the §9 budget commit, where the clerk's
own end-to-end arithmetic (including the co-resident sweep) determines the
honest value.

Commit `299f7e3`.

---

## Commit 6 — §8: bound the sweep cohort

**What it did.** `runGovernanceSweep` (`src/governance.ts`) looped every due
proposal unbounded, and it runs on EVERY invocation before both cron wakes
(and directly on the permissionless `POST /api/governance/sweep`), sharing
the 50-subrequest budget at ~8-9 statements per due proposal. Added
`SWEEP_COHORT_CAP = 2` and put it as a `LIMIT` on the due SELECT (preferred
over a loop break so rows beyond the cap are never even CLAIMED), with
`ORDER BY closes_at ASC, id ASC` so proposals still close in order. Added an
observable `cohort_capped` boolean to the response (computed from counts in
hand, no extra query) so a caller draining a backlog knows to call again.

**Value chosen: S = 2.** Co-resident arithmetic on the worst shape (judgment
wake, per §8's instruction): the sweep costs due(1) + stranded(1) +
detection(0 cached) + 2×~9 = ~20. The judgment wake's non-sheddable floor
(sweep ~20 + wake fixed 1+0+1+1 + replay [1 + 3×6] + pending 1 + finalise 1 =
~24) totals ~44, ≤ 50 with ~6 headroom, and the D-041 batch loop (next
commit) sheds all batches when the floor is this high, so finalise always
lands. **FLAG for the gate:** S=2 forces the clerk's static insert cap down
to ~10 (below §4's "low twenties"); the lever is S=1 (sweep ~11, clerk K
~18). I chose S=2 for sweep throughput and flag the K consequence rather than
silently taking either; the gate should rule on the S vs K tradeoff. The
compound e2e proof (next commit) measures the real floor.

**Behaviour preserved.** 176 governance tests + full suite stay green. The
`ORDER BY` is deterministic and the added response field is additive (no
deepEqual test broke). Deferred proposals re-qualify next invocation
(closes_at ≤ now stays true); `stranded` still names all tallying rows.

**Red-proof (pasted).** New "§8 sweep cohort cap" seeds cap+1 due proposals,
asserts `due===2`, `processed===2`, `cohort_capped===true`, the latest-due
deferred and still open, then a second sweep drains it. Removed the LIMIT:

```
✖ §8 sweep cohort cap ...
    actual: 3,
    expected: 2,
```

Restored → green. Full suite 582/582, typecheck clean, both files NUL-clean.
Commit `445dfbc`.

---

## Commit 7 — §9 (D-041): the budget-aware shed, both wakes

**What it did.** New `src/maintainer/budget.ts`: the shared, statically-derived
subrequest cost table + three pure helpers (`estimateSweepCost`,
`canOpenJudgmentBatch`, `affordableClerkInserts`). Wired:
- `index.ts` `scheduled()` captures the sweep's `processed` count, computes
  `priorCost = estimateSweepCost(processed)` (worst-case `estimateSweepCost(
  SWEEP_COHORT_CAP)` if the sweep threw), and threads it into both wakes.
- `runJudgmentWake(env, cache?, priorCost=0)`: the batch loop calls
  `canOpenJudgmentBatch(priorCost, replayRowsProcessed, batchesRun)` BEFORE
  opening each batch; if it can't pay, sets `batchesShed` and breaks. The
  deferred pending rows are counted by the existing `computeOverflowDropped`
  and one loud `appendError` clause names the shed (scan-limit idiom).
  `reconcileApprovedQueue` now returns `rowsProcessed` (the replay cost input).
- `runClerkWake(env, cache?, priorCost=0)`: passes
  `affordableClerkInserts(priorCost, CLERK_QUEUE_CAP)` to `parseClerkItems`, so
  the accepted drafts are capped at what the budget affords and the surplus
  surfaces as `overflow_dropped` with no new code path.

**Design decisions.**
- Why dynamic, not static: the judgment CANNOT statically fit 4 batches + any
  co-resident sweep (even a 1-due sweep + 4 full batches = 51), and D-041
  declined lowering JUDGMENT_MAX_BATCHES. So the judgment MUST shed. Kept
  `SWEEP_COHORT_CAP=2` and `CLERK_QUEUE_CAP=50` unchanged (no test churn) and
  made the CLERK dynamic too ("apply the same reasoning") rather than crushing
  its static cap to ~5-9; the clerk's affordable cap flexes 9 (busy sweep) to
  ~27 (quiet), always <= 50. `priorCost` defaults to 0 so every existing
  direct wake-test keeps the full budget and stays green.
- Estimates are conservative (>= real) so the shed fires early; the invocation
  counter proof is the enforcement (a drift below reality reddens the compound
  proof at 51). `JUDGMENT_BATCH_COST` carries the FORWARD(D-037) marker;
  the sweep base/per-proposal, replay-per-row, and clerk-fixed each sit beside
  the phase they price.
- **Throughput note for the gate:** the whole system is judge-bound (D-037:
  at most 4 decisions/week). The clerk's affordable cap (9-27/day) and the
  sweep cohort (2/invocation across 8 weekly crons + the permissionless
  endpoint) both vastly exceed 4/week, so their exact values are not the
  binding constraint on queue growth -- the judge cap is (ruled, D-037).

**Proof.** `test/maintainer-budget.test.ts` (6 tests) pins the arithmetic at
its exact boundaries: the compound worst case (2-due + 3 replay) sheds the
FIRST batch; a 1-due sweep opens 3 then sheds the 4th; the clerk affordable
cap shrinks with the sweep, never negative, never above the ceiling. Two
wake-level integration tests (D1 file): a quiet invocation (priorCost=3) opens
all 4 batches; a busy one (priorCost=21) opens 2 then sheds, decides 2, defers
2 (overflow_dropped=2), and emits the loud clause -- with the shed happening
BEFORE opening batch 3, so no wasted model call.

**Red-proof (pasted).** Disabled the shed (`if (false)`), re-ran the §9 shed
test:

```
✖ §9 shed ... actual: 4, expected: 2,
```

Restored → green. Full suite 590/590, typecheck clean, all files NUL-clean.
The invocation-level compound counter proof (real scheduled() + real sweep,
total <= 50) is the next-plus-one commit (THE PROOF). Commit `510cc11`.

---

## Commit 8 — §10 (D-038): the deferred-cursor trigger, made observable

**What it did.**
- `judgment.ts`: `CURSOR_TRIGGER_PENDING = 250`; when `pendingAtStart >= 250`
  the wake appends `cursor trigger reached: pending_at_start=N` (real N) to the
  run's `error` via the existing `appendError` idiom, so it PERSISTS in
  `maintainer_runs` and serves publicly. No migration. Codex's finding: the old
  code computed `pendingAtStart` and never persisted it, and the served fields
  could not reconstruct it, so a run starting at exactly 250 could publish an
  overflow below 250 -- the trigger's premise ("detectable from
  /api/maintainer-runs") was false as built. Now it is true.
- `FORWARD(D-036)` marker planted beside the clause: the durable cyclic cursor
  ITSELF is deferred (needs a migration; this wave is code-only). Greppable.
- `runs.ts`: the served note widened from "two different things" to "three" --
  naming the designed OBSERVATION (cursor-trigger) as a third kind of `error`
  content, alongside the fault and the fail-closed outcome, plus the new
  'batches shed for subrequest budget' line under the fail-closed kind. The
  public surface keeps describing its own contents honestly.
- The withheld-cohort half of the trigger (250 withheld in one run) needed NO
  new code -- the existing `withheld N` clause already serves it.

**Proof (with its built-in red-proof).** End-to-end through `runJudgmentWake`
then `maintainerRunsPage` (the exact public read surface §10 names): 250
pending rows -> the clause with exact N comes back out of the served page, and
the served note names the third kind. Its pair asserts 249 rows do NOT arm the
trigger -- the boundary is exact, proving the clause CAN be absent (the
can-it-fail). Full suite 592/592, typecheck clean, all files NUL-clean.
Commit `<pending>`.
