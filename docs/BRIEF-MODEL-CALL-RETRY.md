# Brief: one retry on a failed maintainer model call

Status: DRAFT, ruled in principle by Ben (31 Oct 2026, "Agree with all your
recommendations", answering "Should a failed model call retry once before the
wake gives up?"). Both exchange seats owed before a builder is commissioned.
Not the money path: the D-018 gate is Sonnet.

## Why

Run 100 (clerk, 31 Oct 06:00 GMT) failed on one answer:
`Anthropic API HTTP 403: Request not allowed`. Runs 1-99 carried no Anthropic
HTTP error; the manual clerk wake at 10:56 GMT (run 101) succeeded with the
same key, model and code. `callAnthropic` (`src/maintainer/anthropic.ts:160`)
makes exactly one fetch and returns `http_error` on any non-2xx
(`anthropic.ts:205-207`), and every caller gives up on `!result.ok`
(`clerk.ts:509`, `concierge.ts:431`, `judgment.ts:1815`). So one bad answer
costs a day of clerk work, or a week of judgment.

## What a retry can and cannot fix (state this in the commit, do not oversell)

- It fixes a transient refusal or fault: 429, 5xx, 529 (overloaded), a
  network error, and a 403 that does not repeat a second later.
- It probably does NOT fix a refusal caused by where the request left from.
  A retry inside the same invocation will normally egress from the same
  Cloudflare data centre. The cause of run 100 is unproven (HANDOVER Addendum
  108 s6), so this is the part to be honest about. Part B below is the cure
  for that case, and it is Ben's cron change.

## Part A (code, agent-buildable)

A1. In `callAnthropic`, on a first attempt that ends `http_error` with status
    403, 429, 500, 502, 503, 504 or 529, or `network_error`, wait a fixed
    delay (2 s; 10 s if the answer carries `retry-after` under 10 s, honour
    it up to 10 s) and make exactly ONE more attempt. Never a loop.
A2. Do NOT retry `timeout` (each attempt can already take 120 s,
    `ANTHROPIC_TIMEOUT_MS`, `anthropic.ts:65`; two would double the wall
    time), `refusal`, `unparseable_response`, 400, 401, 404 or 413. A 401 is
    a bad key and a retry only hides it.
A3. The result carries an `attempts` count (1 or 2). When the second attempt
    succeeds, the run row's `error` still records the first failure as an
    observation line (`model call retried once after: Anthropic API HTTP
    403: ...`), so a recovered fault stays visible in
    `GET /api/maintainer-runs` and the watch report can count them. Check the
    served `runs.ts:171` description: it names three things `error` carries;
    a fourth (a retried-and-recovered fault) must be added or the served text
    becomes false (L-002 class).
A4. Usage: a failed attempt bills nothing in practice, but the result sums
    usage across both attempts rather than assuming zero.
A5. Subrequest budget (D-041, `src/maintainer/budget.ts:24`, 50 per
    invocation): a retry is one more subrequest. The builder finds where each
    wake's fixed or per-batch cost counts its model fetch
    (`CLERK_WAKE_FIXED_COST`, `budget.ts:61`; `JUDGMENT_BATCH_COST`, `:53`;
    `CONCIERGE_ATTEMPT_COST`, `:213`) and either raises that count by one or
    makes the retry conditional on slack the caller passes in. Whichever,
    `FINALISE_RESERVE` (`:86`) must still guarantee the run-row write lands.
    The concierge can make up to three model calls a wake
    (`CONCIERGE_MAX_ATTEMPTS`), so its worst case rises from 3 to 6 fetches:
    cost it.
A6. Tests (real, no mocks of our own code; a stub `fetch` is the existing
    pattern in `test/maintainer-anthropic.test.ts`): 403 then 200 succeeds
    with attempts 2 and the observation line; 403 then 403 fails with both
    in the error; 401 is not retried; timeout is not retried; 529 then 200
    succeeds; a budget at its floor still writes the run row. Prove each can
    go red (remove the retry, the 403 then 200 test must fail).

## Part B (cron, Ben's hand only: agents may not edit `wrangler.jsonc`)

B1. A catch-up wake, e.g. `"30 6 * * *"`, that runs the clerk only if
    today's clerk row ended in a model-call failure, and does nothing
    (writes no row, makes no model call) otherwise. A second scheduled
    invocation is a fresh placement, so it is the only lever on a location
    refusal. The skip check is one D1 read.
B2. The same for judgment would be `"30 7 * * SUN"` (day names, Quartz
    numbering: memory `cloudflare-cron-dow-quartz`).
B3. Build the handler branch in code (agent), hand Ben the exact
    `wrangler.jsonc` patch, and land it before `$REVIEWED_COMMIT` is set in
    the deploy script (memory `wrangler-jsonc-agent-deny`).

Recommendation: build A now; build B's code with A but ask Ben for the cron
line only if the 1 Nov 06:00 or 07:00 wake fails again. If both 1 Nov wakes
succeed, B can wait for a second occurrence.

## Order

Brief to both exchange seats; Sonnet builder; code exchange; Sonnet gate;
push and deploy on Ben's word.

## Amendments after GEMINI round 1 (31 Oct; each re-derived from source by the hub)

These override A1-A6 and B1-B3 where they conflict.

R1. **Status before body.** `callAnthropic` parses JSON before it checks
    `res.ok` (`anthropic.ts:198-207`), so a 502/503/504/529 or edge 403 with
    an HTML or text body becomes `unparseable_response` and A1 would never
    retry it. Check `res.ok` first: any non-2xx is `http_error` carrying the
    status, with the JSON `error.message` when the body parses and a short
    "non-JSON body" note when it does not. Only a 2xx with an unparseable body
    stays `unparseable_response` (not retried).
R2. **One delay rule.** Wait 2 s, or `retry-after` seconds clamped to
    2..10 s when the header parses; a longer `retry-after` still waits 10 s
    and retries once. Replaces A1's contradictory wording.
R3. **The retry observation does NOT go in `error`.** `getClerkCursor` reads
    `MAX(cursor_advanced_to) ... WHERE kind = 'clerk' AND error IS NULL`
    (`clerk.ts:384`), so a recovered clerk run with a non-null `error` would
    have its cursor ignored and the next wake would re-scan and redraft.
    Do not change that predicate (it is the M2 guard, `clerk.ts:195-205`).
    Instead add one nullable column, `model_retry TEXT`, to `maintainer_runs`
    and `concierge_runs` by an additive migration (next free number; scratch-D1
    rehearsal, catalog verification query, migration before worker in one
    fail-fast script). It holds `retried once after: <first error>` on a
    recovered call, or both errors on a double failure alongside the usual
    `error`. Serve it on both run endpoints and add it to the `runs.ts:171`
    and `concierge.ts:305` notes. A3's `error` wording is withdrawn.
R4. **Count actual fetches; do not raise the constants.** `callAnthropic`
    takes a `mayRetry: boolean` from its caller and returns `attempts`.
    Each caller computes `mayRetry` from remaining budget after every
    post-call reserve, and adds `attempts - 1` to its own spent count:
    - clerk: `mayRetry` only if `50 - priorCost - CLERK_WAKE_FIXED_COST -
      FINALISE_RESERVE >= 1`; pass `priorCost + (attempts - 1)` into
      `affordableClerkInserts` (`clerk.ts:530`).
    - concierge: `actualCost` (`concierge.ts:528`) counts fetches, not
      candidates (`attemptsMade` stays the candidate count it serves);
      `mayRetry` is false unless the caller's slack covers the extra fetch
      on top of `CONCIERGE_WORST_CASE_COST` (`budget.ts:263`).
    - judgment: the extra fetch adds to `classifyExtraSpent` (or a
      `retrySpent` passed to `canOpenJudgmentBatch` / `classifyChunkBudget`),
      and `mayRetry` reserves the batch's `JUDGMENT_DECISION_WORST_CASE`
      writes and `FINALISE_RESERVE` first.
    A5 is withdrawn. The constants stay, so no existing budget proof moves.
R5. **A false served sentence found in passing.** `concierge.ts:305` says
    'model call failed' carries "a real, non-zero cost"; a failed call has
    zero tokens. Correct it in this wave.
R6. **Part B, corrected.** The placement claim is belief on both sides: the
    brief does not know that a 06:30 cron lands elsewhere either. Reword B1:
    a separate invocation is a chance of a different placement, not a
    certainty. The catch-up is its own `classifyCron` branch
    (`src/maintainer/schedule.ts`) that runs no sweep, concierge, guest check
    or reconciler. It reads the NEWEST `maintainer_runs` row of that kind
    started since UTC midnight (`ORDER BY started_at DESC, id DESC LIMIT 1`)
    and runs the wake only if that row has `finished_at IS NOT NULL` and an
    `error` beginning `model call failed`. A later successful manual wake
    therefore stops it; an open (in-flight or killed) row stops it too, and
    the killed case is named as a residual. B2: the live line is
    `"0 7 * * 1"` (numeric, Quartz 1 = Sunday); write the catch-up the same
    way, `"30 7 * * 1"`.
R7. **Tests that can fail.** Every not-retried case (401, timeout, 2xx
    unparseable) asserts the stub was called exactly once and
    `attempts === 1`. The budget-floor test uses `installSubrequestCounter`
    (`test/maintainer-scheduled-budget.test.ts`) with `priorCost` actually
    pre-consumed on the counter and the wake's worst-case branch forced, and
    asserts `finished_at` is set. Add: a recovered clerk retry leaves
    `error` NULL and the next wake's cursor starts past it (the R3 bug, red
    against a build that writes the observation into `error`); a 503 with an
    HTML body is retried (red against the current parse order).

## Amendments after CODEX round 2 (31 Oct; spot-checked by the hub: `index.ts:696-720` sweep before `classifyCron`, `clerk.ts:510` / `judgment.ts:1821` compound errors via `appendError`, `test/maintainer-anthropic.test.ts` header)

R8.  **The result carries the observation.** `AnthropicCallResult`
     (`anthropic.ts:130-136`) gains `attempts: 1 | 2` and
     `retryNote: string | null`, set whenever the call ended in a
     retryable-class failure or recovered from one, with exactly three
     shapes: `recovered: <first error>`, `failed twice: <first> | <second>`,
     `failed, retry not afforded: <first>`. Non-retryable outcomes leave it
     null. `error` keeps today's meaning (the final failure only).
R9.  **Plumbing named.** `RunFields` and both `maintainer_runs` statements
     (`runs.ts:14-32`, `:55-76`, `:90-108`) and the concierge field interface
     and INSERT (`concierge.ts:245-283`) carry `model_retry`. Every caller
     propagates `retryNote` on every exit after the call: recovered,
     double failure, parse failure after a recovered call, and posting
     failure after a recovered call. Concierge keeps the note of each
     candidate's call (join with `; ` if more than one).
R10. **Schema mirror.** The migration adds the column to both tables, and
     `schema.sql` (`:169-185`, `:410-427`) is updated identically
     (`migrations/0010_concierge.sql:30-34` requires it); the column-set
     assertion in `test/concierge-migration-d1.test.ts:123-136` and its
     maintainer equivalent are updated.
R11. **A6 superseded by exact expectations.** 403 then 200: `ok`,
     `attempts 2`, `error` NULL, `model_retry` = `recovered: Anthropic API
     HTTP 403: ...`. 403 then 403: `error` = the second failure (in the
     existing `model call failed ...` line), `model_retry` = `failed twice:
     ...`. Both columns are asserted in every case. A6's "both in the error"
     is withdrawn.
R12. **Concierge budget, cumulative.** Before each candidate's call, and
     before each retry, the concierge checks remaining slack including every
     retry already spent this wake (`retrySpent`); `actualCost`
     (`concierge.ts:508-529`) is `... + fetchesMade * CONCIERGE_ATTEMPT_COST
     + ...` where `fetchesMade` counts HTTP attempts. Worst case is 6
     fetches; a test at `priorCost = 30` (CODEX's case: `30 + 19 + 2 = 51`)
     must show the retries shed rather than breach 50.
R13. **Judgment budget, exact.** The retry gate, evaluated after
     `chunksIssued` is known (`judgment.ts:1788-1806`), requires slack for
     the extra fetch on top of the current batch's model fetch, its
     `JUDGMENT_DECISION_WORST_CASE` writes and `FINALISE_RESERVE`; a spent
     retry is carried into every later `canOpenJudgmentBatch` and
     `classifyChunkBudget` call.
R14. **Catch-up before the sweep.** The catch-up cron is recognised at the
     top of `scheduled()`, before the unconditional governance sweep
     (`index.ts:696-720`), and returns after its one read when it skips. When
     it runs, it runs the plain wake path for that kind (sweep included,
     since the failed wake's sweep already ran and a second is idempotent;
     the builder confirms that from `runGovernanceSweep`).
R15. **Catch-up predicate on the new column, not on `error` text.** Run
     only if the newest row of that kind since UTC midnight has
     `finished_at IS NOT NULL` and `model_retry LIKE 'failed%'`. A 401 or
     other non-retryable failure (note null) does not trigger it. Tested
     against a compound `error` with an earlier clause.
R16. **A4 narrowed.** "No usage was returned, so the local estimate records
     zero for a failed attempt." No claim about what Anthropic billed.
R17. **Test location corrected.** `test/maintainer-anthropic.test.ts`
     does not exercise `callAnthropic`; use the fetch-stub pattern in
     `test/maintainer-concierge-d1.test.ts:87-110` and the counter in
     `test/helpers/subrequest-counter.ts:47-83`. Add the 2xx invalid-body
     not-retried case to the list.

## Closing amendments after the cap round (CODEX round 3, GEMINI continuation round; both took positions, every point taken here; hub re-derived `index.ts:741-755` and that `JUDGMENT_DECISION_WORST_CASE` does not exist)

R18. **Rerun is decided by the final failure, not the audit text.**
     `callAnthropic` also returns `finalRerunnable: boolean`, true when the
     call ended failed on a retryable status (A1 list), `network_error` or
     `timeout` (a timeout is not retried in-invocation, but a fresh
     invocation is the right place for it). The wake writes `model_retry`
     as `rerun: <audit>` when the wake ENDED on such a failure, and plain
     `<audit>` otherwise. Audit parts keep R8's shapes, plus
     `failed, timeout not retried: <error>`; judgment prefixes each batch's
     part with `batch N:` and joins with `; ` (R9 already does this for the
     concierge). R15's predicate becomes `model_retry LIKE 'rerun:%'`. This
     covers a first-attempt timeout, a later judgment batch failing after an
     earlier one recovered, and 403 then 401 (final not rerunnable, history
     kept). Test each of the three.
R19. **What the catch-up runs (supersedes R14's last sentence).** When it
     runs: `runGovernanceSweep` (idempotent, `governance.ts:1771-1842`,
     confirmed by GEMINI), then `runClerkWake` or `runJudgmentWake` directly
     with the sweep's cost as `priorCost`. It does NOT run the concierge, the
     guest check or the reconciler (`index.ts:741-755`): each writes a daily
     row or spends a budget that the 06:00 invocation already used.
R20. **Concierge retry slack reserves what follows it.** The concierge is
     handed `priorCost` without the clerk's floor (`index.ts:742`), so its
     `mayRetry` requires `priorCost + CONCIERGE_WORST_CASE_COST + retrySpent
     + 1 + GUEST_DUTY_CHECK_COST + CLERK_WAKE_FIXED_COST + FINALISE_RESERVE
     <= INVOCATION_SUBREQUEST_BUDGET`. In practice the concierge will retry
     only on a quiet sweep day; say so in the commit. Its outer catch
     (`concierge.ts:345`) returns `CONCIERGE_WORST_CASE_COST +
     CONCIERGE_MAX_ATTEMPTS` so a throw after retries is not under-priced.
     Extend `PROOF GUEST-CHECK` (`test/maintainer-scheduled-budget.test.ts`)
     to a worst case with concierge retries at 0, 1 and 2 due proposals.
R21. **Judgment gate, corrected.** There is no `JUDGMENT_DECISION_WORST_CASE`
     constant; R4 and R13 named one in error. `JUDGMENT_BATCH_COST` (8)
     already reserves the batch's scan page, model fetch and decision writes
     (`budget.ts:46-53`). The retry gate at `judgment.ts:1815` is: the same
     spent sum `classifyChunkBudget` uses (with this batch counted in
     `batchesRun` and `classifyExtraSpent` including `chunksIssued`), plus
     `retrySpent`, plus `FINALISE_RESERVE`, leaves at least 1.
R22. **Manual-trigger race, named.** `handleManualTrigger` has no
     single-flight claim (`trigger.ts:127-157`), so a manual wake started
     between the catch-up's read and its wake can run alongside it. Accepted
     residual: the worst outcome is one duplicate wake, whose duplicate
     drafts are visible under M2 (`clerk.ts:195-205`). Name it in the commit
     and the served note; no claim table in this wave.
R23. **`retry-after` tested.** The delay goes through an injectable sleep
     so tests assert the wait for: header absent (2 s), `1` (2 s), `5` (5 s),
     `30` (10 s), malformed (2 s).
R24. **Every excluded status tested.** One table-driven test over 400, 401,
     404, 413, refusal, timeout and 2xx-unparseable asserts one fetch and
     `attempts === 1`; one over 403, 429, 500, 502, 503, 504, 529 and
     network error asserts two.

Status: builder-ready. No seat disagreement is left open: both seats' cap
positions are taken in full by R18-R24.
