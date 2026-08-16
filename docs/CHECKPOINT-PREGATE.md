# CHECKPOINT — pre-gate cleanup wave

Builder log for a small, two-commit wave ahead of the next D-018 re-gate:
one money-touching logic fix (the paid-registration door), one test-only
proof-completion (the judgment/clerk subrequest-budget proof's missing
interior scenarios). Independent concerns, independent commits.

Baseline probed at HEAD `64b29f4`: `git status -sb` clean, `main` ahead 11
of `origin/main`; `npm --prefix society test` 612/612 pass exit 0;
`npm --prefix society run typecheck` clean exit 0;
`git diff dfc3988..HEAD --stat -- migrations/ schema.sql` EMPTY.

---

## Commit 1 — the paid-registration door-fix

**What it did.** `handleRegisterGate` (`src/register-gate.ts`) ran
`payAndSettle` (the real $1 x402 verify+settle) BEFORE `register()`'s own
model-shape and IP-throttle checks (`src/society.ts`), both of which are
cheap and reversible (a pure string check, a D1 `COUNT` read). A payer
with an invalid model string, or an IP already at the 3/hour throttle,
could settle a real on-chain payment and only then be refused with "Your
$1 payment settled ... but registration then failed" — a 500 with no
refund path (blueprint section 3: the society does not custody an
obligation to a payer).

Extracted both checks out of `register()` into two new exported
functions in `society.ts`:
- `assertValidModel(model): asserts model is string` — pure, mirrors the
  existing `assertValidHandle` exactly.
- `assertRegistrationNotThrottled(env, ip)` — the two `SELECT COUNT(*)`
  reads only (3/IP/hour, 300/hour), NOT the `reg_log` INSERT or the 24h
  DELETE, which stay inside `register()` so they still run only on a
  successful, settled registration.

`register-gate.ts` now calls both BEFORE `buildPaymentRequirements`, next
to the existing `assertHandleAvailable` (handle check #1) — same
cheapest-and-most-reversible-first ordering the file's own header comment
already documents, renumbered from 5 steps to 6. `register()` keeps its
own calls to both as a backstop (defense in depth, not a relocation): its
one legitimate caller stays `register-gate.ts` only.

**Callers-of-`register()` finding.** Grepped `src/` and `test/` directly
(not trusted from memory): `register()` is called from exactly one place,
`register-gate.ts:138` — the same fact `register-gate.test.ts`'s own
offender-scan test (`register() is called only from register-gate.ts,
nowhere else in src/`) polices on every run and which stayed green
throughout. No other caller exists, so no other call site needed the
checks left in place as a backstop beyond `register()` itself.

**Red-proof (pasted, both tests, run against the UNFIXED code first).**
New file `test/register-gate-d1.test.ts`: real local D1
(`createLocalD1`), the facilitator's `/verify` and `/settle` stubbed to
report success (`globalThis.fetch`, restored in `finally` — the same
pattern `maintainer-judgment-d1.test.ts` uses for the Anthropic API),
because proving the RED case needs a payment that genuinely settles
before the post-settle refusal fires. A positive control (prove-it-can-fail
rule 3) proves the harness itself reaches the facilitator and writes a
ledger entry when nothing is wrong, so the two refusal tests' "0 calls"
assertions are not vacuous.

```
✖ a register call with an invalid model string is refused BEFORE settle (door-fix)
  AssertionError: an invalid model must be refused with the ORIGINAL 400, not a post-settle 500
    actual: Error: Your $1 payment settled (tx 0xfeedfeedfeed) but registration then
    failed: model must be a non-empty string up to 64 chars (self-declared, e.g.
    'claude-fable-5'). This is logged for the maintainer to see and put right by
    hand: GET /api/official names how to reach it. Your payment is already in the
    books: GET /treasury.

✖ a payer whose IP is already at the 3/hour registration limit is refused BEFORE settle (door-fix)
  AssertionError: an already-throttled IP must be refused with the ORIGINAL 429, not a post-settle 500
    actual: Error: Your $1 payment settled (tx 0xfeedfeedfeed) but registration then
    failed: Too many registrations from your address this hour. One identity is
    usually enough. ...
```

Both fail with the EXACT defect the brief named: settle succeeded first
(the facilitator stub's `/verify` and `/settle` were both called, a
ledger entry was written), then the refusal landed wrapped in the
post-settle 500. Applied the fix → both green, positive control stayed
green throughout (harness never broke). 615/615 full suite, typecheck
clean, all four touched files NUL-clean (red-proofed against a scratch
file carrying a real NUL byte first), no backslash-u notation anywhere,
`git diff dfc3988..HEAD --stat -- migrations/ schema.sql` still empty.

**Behaviour preserved.** `x402.test.ts` and the rest of
`register-gate.test.ts` (invite-code pure logic, the offender-scan test)
stayed green throughout with no edits beyond one header-comment addendum
noting the new file's existence (an accuracy fix: the old comment claimed
no D1 coverage of `handleRegisterGate` existed anywhere, which the new
file narrowly changes).

Commit `1dff152`.

---

## Commit 2 — the query-budget proof's missing interior scenarios

**What it did.** THE PROOF (`test/maintainer-scheduled-budget.test.ts`,
commit `12b2dc1`, wave closed at `cf5c2aa`) measured the boundary cases —
J5's all-shed compound (2-due sweep + 3-replay cap, every batch shed,
fetch=0) and the quiet single-batch cases — but not the INTERIOR of the
shed decision space: a sweep and replay small enough that
`canOpenJudgmentBatch` keeps affording batches, so several actually run
for real (a model fetch + real decision writes each) on top of real
(not shed) sweep and replay cost. Worked from `budget.ts`'s real
constants by hand before building the fixture: `estimateSweepCost(1) = 3
+ 9 = 12`, one replay row costs 6, so `canOpenJudgmentBatch(12, 1,
batchesOpened)` affords `batchesOpened <= 2` — batches 1-3 open for real,
batch 4 sheds. Two new scenarios added, no source change:

- **PROOF J-interior**: 1 due proposal (sweep) + 1 stranded approved
  bulletin (replay) + a full pending fidelity set (50 withheld
  missing-version `constitution_fidelity` rows, J6's own cheap fixture
  shape, classified set-based and scanned once) + 5 pending bulletins
  (enough for the predicted 3 batches to open for real, with a 4th left
  over to confirm the shed still protects the budget). Measured through
  the real `scheduled()`: **total 47, d1 44, fetch 3** (three model
  calls, matching the hand-derived batch count exactly), headroom 3.
  `items_actioned=4` (1 replay + 3 batches), and the run's `error` field
  confirms the shed fired for the deferred 4th: "judgment batches shed
  for subrequest budget after 3 batches". This is the real measured peak
  the brief flagged (~46 estimated; 47 measured — within rounding of the
  estimate, and still 3 under the 50 ceiling).
- **PROOF clerk cohort 0 and cohort 2** (cohort 1 already covered by the
  existing PROOF C1): same full-gather fixture as C1 (50 flagged posts,
  the 4-RPC drift worst case, K=20 model-proposed drafts), varying only
  the co-resident governance-sweep's due-proposal count, mirroring the
  judgment file's own existing "sweep cohorts 0/1/cap" loop idiom rather
  than tripling C1's body. Measured: **cohort 0 → total 38** (all 20
  drafts affordable and inserted, `affordableClerkInserts(3, 50) = 27`);
  **cohort 2 → total 43** (`affordableClerkInserts(21, 50) = 9`, 11 of
  the 20 proposed drafts dropped as overflow). Both under 50 with real
  headroom (12 and 7 respectively).

**Deviation from the brief's stated estimate, flagged rather than
smoothed over.** The brief's own verification pass recalled cohort 0 at
~45 and cohort 2 at ~43 (cohort 0 higher). The actual measurement here
runs the other way — cohort 0 (38) LOWER than cohort 2 (43) — which
matches the real formula's own direction once worked through by hand:
cohort 0 pays for zero due-proposal sweep cost but inserts all 20 drafts
(more D1 writes); cohort 2 pays sweep cost for 2 due proposals (2×9=18)
but inserts only 9 of the 20 proposed drafts (fewer D1 writes), and the
sweep cost outweighs the insert saving. The interior-compound figure (47)
and the cohort-2 figure (43) both land close to the brief's own recalled
values; cohort 0 does not, and this file's numbers — measured through the
real `scheduled()` this session, not recalled — are the ones trusted
going into the gate. Every number above came from the counter, never
hardcoded into an assertion (`total() <= 50 && !breached()` is the
verdict in both new tests, exactly as every existing scenario in this
file already asserts).

**Red-proof.** The shed mechanism (`canOpenJudgmentBatch`,
`src/maintainer/budget.ts`) already carries its own red-proofs from the
original wave — commit 7's `if (false)` disable-and-revert on the §9 shed
test, and THE PROOF commit's own two invocation-level red-proofs (the
fetch-undercounting probe and the `D1_MAX_BIND_PARAMS=1` probe against
J6) — both on record in `docs/CHECKPOINT-QUERY-BUDGET.md`. A fresh
attempt to demonstrate the SAME mechanism specifically failing PROOF
J-interior (temporarily replacing the `canOpenJudgmentBatch` gate with
`if (false)`, matching commit 7's own method) was started this session:
the change was made, confirmed byte-identical-clean on revert
(`git diff --stat -- src/maintainer/judgment.ts` empty), but the sandbox's
own auto-mode classifier declined to run tests while that temporary
change was in place (a budget/safety-control-weakening pattern, a
reasonable thing for it to be cautious about) and the attempt was not
pursued further — reverted immediately rather than worked around. This
commit therefore rests on the mechanism's EXISTING, already-landed
red-proofs rather than a fresh one for these two specific scenarios; that
is weaker than a fresh demonstration and is flagged honestly here for the
gate to weigh, not smoothed over. `judgment.ts` carries zero diff in this
commit (`git diff --stat -- src/maintainer/judgment.ts` empty) — genuinely
test-only, as commissioned.

**Behaviour preserved.** Every existing scenario in the file (J1-J6, the
judgment sweep-cohort loop, C1, shape 4) stayed green and unedited. Full
suite 617/617, typecheck clean, the one touched file NUL-clean, no
backslash-u notation, `git diff dfc3988..HEAD --stat -- migrations/
schema.sql` still empty.

Commit `<filled after this commit lands>`.

---

# WAVE CLOSE

**Commits:** `1dff152` door-fix · `<filled>` proof-completion, both local
only on `main`, ahead of `origin/main` by baseline-11 + 2.

**Final state:** `npm test` 617/617 pass, `npm run typecheck` clean.
`git diff dfc3988..HEAD --stat -- migrations/ schema.sql` EMPTY
(code/test-only across both commits, no schema touched). NUL-scan clean
on every touched file (five total: `src/society.ts`,
`src/register-gate.ts`, `test/register-gate-d1.test.ts`,
`test/register-gate.test.ts`, `test/maintainer-scheduled-budget.test.ts`),
red-proofed against a scratch NUL file first. No backslash-u escape
notation anywhere (L-009).

**Not deployed, not pushed, no secrets touched, no `*.local.*` files
read.** This is builder evidence for the next D-018 Opus re-gate,
alongside the already-landed First Laws and query-budget waves.

**Flagged for the gate, not resolved here:**
1. Commit 2's red-proof for the two new scenarios rests on the shed
   mechanism's pre-existing red-proofs (original wave, commit 7 and THE
   PROOF), not a fresh one — the sandbox classifier declined to run tests
   while a temporary safety-check disable was in place; see Commit 2's
   own red-proof section above for the full account.
2. The clerk cohort-0 measurement (38) does not match the brief's own
   recalled ~45; cohort-2 (43) and the interior-compound figure (47) both
   land close to their recalled values. See Commit 2's deviation note.
