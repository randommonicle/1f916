**RE-GATE: CLEAR WITH NOTES**

# D-018 re-gate: the gate conditions commit, 2026-09-27

Scope, and nothing else: `git diff a8e622a5..3d8d2a78` (`177abdaf` conditions, `3d8d2a78` checkpoint
only), against the hub's brief `scratchpad/CONDITIONS-BRIEF-2026-09-27.md` and the gate record
`docs/REVIEW-HEARTBEAT-INBOX-GATE-2026-09-27.md` (committed byte-identical to what the gate wrote,
365 lines). Re-verified on a fresh `git archive 3d8d2a78` copy: suite 1266/1266, typecheck exit 0,
`scripts/deploy-heartbeat-inbox.ps1` parses with 0 errors (PowerShell AST, not run). The worktree was
clean before this file.

## 1. The three conditions

**C1: met.** Heartbeat section 6 now reads "Reading the inbox writes nothing to the society's
database. Like every request here, it passes through the Worker's request log, which the operator's
Cloudflare account keeps for a few days. The cursors are yours to keep." (`src/inbox.ts:585`,
`docs/HEARTBEAT-SKILL-TEXT.md:57`). The `/skill.md` line reads "a guide to the routes, with what each
needs" (`src/inbox.ts:613`, doc `:76`). `SKILL_VERSION` is `1.0.1` (`src/inbox.ts:49`), and test 10
is re-pinned (`test/inbox-d1.test.ts:1069-1071`), now against the real `AUTH_LABEL.citizen_secret`
(L5 closed: an appended label sentence turns test 10 red on its own). The new doc-fidelity test
(`test/inbox-d1.test.ts:1238`) turns the code-to-doc check into a test; dropping one word from the
doc's `/skill.md` block, or changing section 6's retention words in the doc only, each turns it red.

**C2: met.** `balloted` is per citizen (`test/inbox-d1.test.ts:667`): red under MG8 re-applied to
the post-R2 query (`WHERE citizen_id = ? OR 1`). `inbox()` writes nothing (`:695`,
`total_changes()` on the shared raw connection): red under MG1. Both re-run here; both restored
byte-identical. Limit, for the record rather than as a finding: `total_changes()` cannot see a
statement that changes no rows or a schema-only write. The realistic regression, a real write, is
covered.

**C3: met.** `scripts/deploy-heartbeat-inbox.ps1:140-147` polls `/api/inbox` every 5 s, 12 times,
while it answers 404, after `wrangler deploy` (`:131-132`) and before the first ride GET (`:151`).
It then stops with "deployed, but the new route has not appeared after 60 s; check by hand". Any
other status, including `000`, falls through to `Invoke-RideGet`, which stops with its own message.
It fails safe. The only write is still after the `-DryRun` exit (`:127`). R5's `finally`
(`:54-56`) is correct: the return value is read before the file is removed.

## 2. Defects or false sentences introduced by this diff

**Note 1 (LOW, introduced; the fault traces to my own gate record's R2).** The new ballots read
(`src/inbox.ts:466`, `SELECT proposal_id FROM ballots WHERE citizen_id = ?`) has no index that
leads with `citizen_id`. The only candidate, `idx_ballots_proposal_citizen`, leads with
`proposal_id`. The plan is therefore `SCAN ballots USING COVERING INDEX idx_ballots_proposal_citizen`,
which reads every ballot ever cast on every inbox call.

I measured D1 `rows_read` on Miniflare's local D1 at this commit, with 5, 50 and 500 proposals and
14, 140 and 1,400 ballots seeded to scale. A steady-state call with nothing new reads 21, 147 and
1,407 rows at 1x, 10x and 100x. The ballots read accounts for 14, 140 and 1,400 of those. That
cancels most of R1's gain (1,708 to 7 at 100x) and restores an O(table) read on every heartbeat.
The comment at `:461-462` ("never more than a few thousand even at 100x") counts rows returned, not
rows examined: the same confusion the corrected `src/index.ts` comment now warns about.

The gate recommended exactly this query as R2's first option without checking the index. The
builder implemented it as asked.

Fix, verified on the scratch copy (full suite 1266/1266, typecheck 0; the plan becomes `SEARCH`
on `(proposal_id, citizen_id)`, 3 rows at every scale, and there is no bound-parameter growth):
`SELECT proposal_id FROM ballots WHERE citizen_id = ? AND proposal_id IN (SELECT id FROM proposals
WHERE status = 'open' AND closes_at > ? AND post_id IS NOT NULL)`, bound `(citizen.id, now)`, with
the existing TypeScript filter kept. Immaterial today (14 ballots add 14 rows a call); worth taking
before this wave's cost story is relied on.

**Note 2 (LOW, a false red-proof claim, not served).** The R1 plan test's title
(`test/inbox-d1.test.ts:714`) and the code comment (`src/inbox.ts:234-235`) both say that dropping
either `+p.kind` turns the test red. It does not. Dropping only the topic-term `+`, or only the
post-term `+`, keeps the plan at `SEARCH p USING INTEGER PRIMARY KEY (rowid>?)`, because one
non-indexable OR term is enough to defeat `MULTI-INDEX OR`. The test stays green in both cases
(M33b, M33c). The guard is sound, since the property it pins holds with either `+`. Only the
wording is wrong: it should say "drop both". The checkpoint's M33 row correctly says both.

**Served sentences: none false.** Each new sentence was checked against source:
- "Like every request here, it passes through the Worker's request log, which the operator's
  Cloudflare account keeps for a few days" (`src/inbox.ts:512`, `:585`). `wrangler.jsonc:8-10` has
  observability on with `head_sampling_rate: 1`, and no `invocation_logs` override; the file is
  unchanged by this diff. Cloudflare's Workers Logs page, fetched for the gate, says invocation logs
  are on by default, a fetch is logged as `<Method> <URL>`, and retention is 3 days on Free and 7 on
  Paid. "A few days" is true on the Free plan this deployment runs on. If the account moves to
  Workers Paid it becomes a week: a trigger to reword, not a defect.
- "The reads in this routine need no credential" (`:553`) is true of inbox, changes, topics and
  post reads.
- "every proposal open for ballots now" (`:561`) and the door note's "every proposal open for
  ballots with whether it can ballot" (`:640`) are true.
- "A public-key citizen signs it:" (`:568`) is true: signed intent binds assertions only.
- Section 4 (`:577`) now claims only a catch-up feed and defers to the feed's own `cursor_note`.
- The open-mode Join paragraph no longer ends in a space (`:599`, `:618`).

**Nit.** The checkpoint's M34 row lists "3, 5, 7, the odd/rare-read seeds that actually produce
truncated pages". Seed 1 also produces truncated pages; its page edges happen not to expose that
off-by-one.

## 3. M34, and whether the adopted fuzz test can go red for its class

**The builder's reasoning is right.** The rows delivered on a page are a subset of the rows
examined, so "advance the comment cursor to the last DELIVERED row" can only under-advance. The
next page re-examines rows that were already dropped and drops them again. It never re-examines a
delivered row. Nothing is lost or duplicated, so an exactly-once oracle computed from final state
cannot see it.

B1, my own implementation of the brief's mutation (fall back to the real cursor when nothing is
delivered): the fuzz stays 8/8 green, while test 7/A17 and the A20 test go red. The property is
guarded, just not by the fuzz. One caveat to "safe and wasteful": a variant that falls back to the
start id when a truncated page delivers nothing would never advance while `has_more` is true, which
is a loop. The fuzz's body mix makes such a page practically impossible, and `node:test` has no
default timeout, so it would hang rather than fail. Test 7 pins the exact cursor value either way.

**The fuzz as adopted does go red for its class** (loss or duplication across interleaved writes
and paged reads):

| mutant | defect it plants | fuzz result |
|---|---|---|
| M34 (re-run) | truncated page's cursor = the 101st look-ahead row (loss) | red, seeds 3, 5, 7 |
| B2 | truncated page's cursor one row short (duplicate) | red, seeds 3, 5, 7 |
| B3 | untruncated cursor one past the snapshot `MAX(id)` (loss) | red, 8/8 |
| B4 | cursor branch floored by `created_at`, the A1/A19 class (loss and duplicate under skew) | red, 8/8 |
| B1 | the brief's "last delivered" (under-advance only) | green 8/8; test 7 and A20 red instead |

Its truncation-path power rests on three seeds (3, 5 and 7), so more rare-read seeds would widen it
(optional). The checkpoint's stated coverage limit is accurate: the oracle reads final state and
the fuzz never flips moderation after insert, so the A20 class is outside it, and test A20 covers
that.

## Mutants run

All on a fresh `git archive 3d8d2a78` copy, each restored and byte-compared before the next. The
M-numbered rows are the builder's own mutants (M28-M34), re-run here; the rest are mine.

| id | change | tests | result |
|---|---|---|---|
| M31 | MG8 on the post-R2 query | inbox-d1 | red (C2/MG8) |
| M32 | MG1, an `UPDATE` inside `inbox()` | inbox-d1 | red (C2/MG1) |
| M33 | both `+p.kind` dropped | inbox-d1 | red (R1/L2 plan test) |
| M33b, M33c | one `+p.kind` dropped (each side) | inbox-d1 | **green** (Note 2) |
| M28 variants | one doc word, and section 6's retention words, changed in the doc | inbox-d1 | red (doc-fidelity) |
| M30 | `AUTH_LABEL.citizen_secret` gains a sentence | inbox-d1 | red (test 10) |
| B1, B2, B3, B4, M34 | as in section 3 | fuzz, and inbox-d1 for B1 | as in section 3 |
| FX | Note 1's subquery form of the ballots read (a fix probe) | full suite | green 1266/1266, typecheck 0 |

## Not checked

The deploy script was not run in any mode. Production D1's plans are not verified: the plans and
costs come from node:sqlite and Miniflare's local D1, with no `ANALYZE` statistics. Whether
`finally` runs when `Stop-Here`'s `exit` fires inside `try` in Windows PowerShell 5.1 was not
tested; it affects only temp-file cleanup. Nothing outside `a8e622a5..3d8d2a78` was re-reviewed.
