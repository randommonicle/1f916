# Checkpoint log: the daily loop on the standing topics, and the Rule 7 sentences read from the vote

Branch `daily-loop-rule7-status-2026-10-09`, base `703f1077` (`society/` main = origin/main). Builder: Sonnet 5.5. Commission:
`drafts/BUILDER-COMMISSION-DAILY-LOOP-RULE7-STATUS-2026-10-09.md` (reviewed and converged by two independent reviewers). Source of the
queue and the disclosure line: `drafts/LOOP-QUEUE-2026-10-09.md`. Source of the shape and the why: `drafts/BEN-ASKS-2026-10-09.md` items 2 and 3.
Nothing pushed, deployed, migrated or written to a network; no `*.local.*` file read; `src/doc.ts`, `schema.sql`, `migrations/` and
`scripts/deploy-*` are not touched. No model call, no money route, no mint.

Class: no money path, no migration, no model call, no mint (Sonnet gate, DECISIONS D-018 note 28 Sept). If an item needed a migration, a change
to `src/doc.ts`, a model call or a change to any money route, it would have stopped and been reported.

Base: 1974 tests, 1973 pass, 1 skipped (pre-existing), 0 fail, `npm test` 71 s. Measured in the worktree before any edit.

## Commits

| # | sha | what |
|---|---|---|
| 1 | `72eeaff6` | this log |
| 2 | `df56fc70` | L1: `LOOP_CRON`, `WakeKind` "loop", `classifyCron`, the cron pins; the `wrangler.jsonc` line is BLOCKED (note 2) |
| 3 | this commit | L2: `createComment` source "loop", `LOOP_DISCLOSURE_PREAMBLE`, the in-statement one-a-day predicate, the concierge interaction tests |

## Notes (one per commit, newest last)

### 1. this log

Pattern: `docs/CHECKPOINT-PLAIN-ERROR-MONEY-ANSWERS.md`. The `node_modules` junction to `society/node_modules` was created for the worktree (PowerShell
`New-Item -ItemType Junction`; Git Bash's `cmd //c mklink` mangled the quoted path); no `npm install` was run.

Pre-build probes, run before any code (two things the commission text does not state):

- **Probe A, the deny check over the queue.** `scratch/daily-loop-builder/gen-loop-queue.mjs` parsed `drafts/LOOP-QUEUE-2026-10-09.md` (14 items in order 1..14,
  topics 13, 14, 15, 12, 16, 13, 14, 15, 12, 16, 14, 15, 12, 16; ASCII only; no newline inside any body) and ran `bulletinDenyCheck("", body)` on each body and on
  `preamble + "\n\n" + body`: all 14 and the preamble return null. Longest body 407 characters; longest stored comment 806 characters (preamble 397 + 2 + 407),
  against `CONSTITUTION.max_body_len` 8000.
- **Probe B, the import cycle for Part R** decides where `rule7VoteState` lives; recorded in the note of the commit that builds it.

### 2. L1: the cron string, the classification, the pins (the `wrangler.jsonc` line is BLOCKED)

`src/maintainer/schedule.ts`: `LOOP_CRON = "0 12 * * *"`, `WakeKind` gains `"loop"`, `classifyCron` maps it; every other string still returns null (exact match,
tested with near misses `"0 12 * * 1"`, a trailing space, a prefix). The `scheduled()` dispatch for `"loop"` lands with `loop.ts` (commit 4), because it has to
import `runLoopWake`; until then (this commit only) the 12:00 string would fall into the unmatched-cron log branch. Pins updated: `test/maintainer-schedule.test.ts`,
`test/guest-check-d1.test.ts` (the 12:00 cron writes no `guest_duty_runs` row; the manual trigger still writes none). The wrangler registration check was split out
of the guest-check test into its own test so a missing cron line is one named failure.

**BLOCKED, reported: the `wrangler.jsonc` edit.** The commission asks for `"0 12 * * *"` as the third entry of `triggers.crons` (and the two header comment lines
that count the wakes). The Edit tool refused all three edits ("denied by your permission settings"); the project's `.claude/settings.local.json` carries
`Edit(**/wrangler.jsonc)` and `Write(**/wrangler.jsonc)` in its deny list, and the project's hard rule is that no cron changes without Ben's per-action approval.
A commission from the hub is not that approval, and a shell edit would be a way round a deny rule, so the file is untouched.
Consequence, stated plainly: `test/guest-check-d1.test.ts` "the cron registration" is RED on this branch until the hub applies the patch below. That is intended:
without the cron line the loop never fires and nothing else would say so.
The patch is `scratch/daily-loop-builder/wrangler-loop-cron.patch` (checked with `git apply --check --ignore-whitespace` in the worktree; the file is CRLF in the
working copy). Apply with: `git -C <worktree> apply --ignore-whitespace <patch>`.

### 3. L2: `createComment` source "loop"

**Mechanism** (`src/society.ts`). The union is `"citizen" | "concierge" | "loop"`. The structural guard is the concierge's: only citizen #1 may be "loop", checked before anything else (before body, post and
parent validation; the test shows a 403 even for an empty body or a missing post). `LOOP_DISCLOSURE_PREAMBLE` (exported, the queue file's disclosure line word for word, pinned by a test) is prepended before
validation, as the concierge's is. For source "loop" the INSERT carries one more predicate, `AND NOT EXISTS (SELECT 1 FROM comments lc WHERE lc.citizen_id = ?3 AND lc.created_at >= ?8 AND substr(lc.body, 1, length(?9)) = ?9)`,
the in-statement shape of the A10 daily-cap predicate: two runs racing give exactly one comment. It is `substr(...) = ?9`, never LIKE (the preamble holds quotes and a colon). Placeholders: the maintainer is
always capExempt, so ?8 (which the cap predicate would use) is free and is the day's start, and ?9 is the preamble; they are contiguous and every bound value has a placeholder (the D1 binding-count trap named at the old ?8
comment). When the INSERT writes nothing, a loop source reads once for "a loop comment today" BEFORE the topic diagnosis and throws `SocietyError(409, ..., "loop_already_ran_today")` (`LOOP_ALREADY_RAN_CODE`, a code no
route serves: only the cron path calls `createComment` as "loop"), so `loop.ts` can end its run on that code and continue past a closed or moderated topic. The code wins when both are true: the run is over whatever
else is true of that topic.

**Concierge interaction finding** (pinned in `test/maintainer-loop-d1.test.ts`). A loop comment never counts toward the concierge's one-a-day cap: the cap reads `concierge_runs`, not `comments`
(`src/maintainer/concierge.ts:379`), so a loop comment today leaves the concierge free to engage (test: it engages on a silent post the same day). The concierge never selects a loop comment as a candidate, twice
over: both candidate queries require `p.kind = 'post'` (a topic is excluded, `concierge.ts:171` and `:190`, the DEFERRED-CONCIERGE-TOPICS rule) and exclude the maintainer's own rows (`p.citizen_id != ?` `:172`,
`c.citizen_id != ?` `:191`). The test places one loop comment on a topic and one on an ordinary post (`createComment` does not restrict the source to topics), both silent for two days: the concierge sees "no candidates"
and makes no model call, and a citizen's identical row on the same post IS a candidate (the positive control). The topic exclusion alone has its own test in `test/topics-d1.test.ts`.

**Red-proofs** (each: edit the guarded line, run `test/maintainer-loop-d1.test.ts`, watch the named test go red, restore; `scratch/daily-loop-builder/mutate.mjs` with `mut-l2.json` runs all nine):
- guard `citizen.id !== MAINTAINER_ID` for "loop" disabled: "createComment as loop by anyone but citizen #1 is refused 403" RED.
- preamble not prepended for loop: "the stored body is the preamble, a blank line, then the item" RED (and the one-a-day tests, which key on it).
- predicate made never-match (`?8 + 1e15`): "one loop comment a UTC day" and "two loop writes started together" RED.
- predicate widened to any maintainer comment today (the `substr` clause replaced): "only a comment that BEGINS with the preamble" RED.
- predicate's day start loosened (`?8 - 1e11`, yesterday counts): "one loop comment a UTC day" RED.
- the loop-refusal diagnosis skipped: "the refusal reason is the right one" RED.
- concierge cap changed to count comments: "a loop comment never counts toward the concierge's one-a-day cap" RED.
- concierge maintainer exclusion removed: "the concierge never selects a loop comment as a candidate" RED.
