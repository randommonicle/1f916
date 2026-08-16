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
NUL-clean. Commit `<pending>`.
