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
| 3 | `e071ada4` | L2: `createComment` source "loop", `LOOP_DISCLOSURE_PREAMBLE`, the in-statement one-a-day predicate, the concierge interaction tests |
| 4 | `8853be5e` | L3 + L4 + L5: `runLoopWake`, `LOOP_QUEUE`, the budget constants, the `scheduled()` dispatch, the wake tests, the static pins |
| 5 | this commit | R1 + R2: `src/rule7-vote.ts`, the three (four) sites read it, the secret-literal guard entries |

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

### 4. L3 + L4 + L5: the wake, the queue, the dispatch, the tests

**Files.** `src/maintainer/loop.ts` (`runLoopWake`), `src/maintainer/loop-queue.ts` (`LOOP_QUEUE`), `src/maintainer/budget.ts` (`LOOP_DETECTION_COST` 4, `LOOP_ATTEMPT_COST` 5, `LOOP_MAX_ATTEMPTS` 3,
`LOOP_WORST_CASE_COST` 19, `canAffordLoop`), `src/index.ts` (the `"loop"` branch of `scheduled()`), tests in `test/maintainer-loop-wake-d1.test.ts`, `test/maintainer-policing.test.ts`,
`test/guest-cognition-blindness.test.ts`.

**L4, the queue.** `loop-queue.ts` was generated from `drafts/LOOP-QUEUE-2026-10-09.md` by `scratch/daily-loop-builder/gen-loop-queue.mjs` (a regex over the file, `JSON.stringify` per body), not typed:
14 items, topics in the file's order, bodies verbatim without the "N. Topic X." label. The hub diffs it against the file. The disclosure constant in `society.ts` was written from the same line and is pinned by a test.

**L3, the walk** (`runLoopWake(env, priorCost, now = Date.now())`, never throws). (1) `canAffordLoop(priorCost)` first: if not, `loop_deferred_budget` once, nothing read. (2) The pre-read (one statement): a comment by
citizen #1 since `utcMidnight(now)` whose body begins with the preamble, by `substr(...) = ?` (never LIKE), only to spare the rest and choose the log line `loop_already_ran_today` (`by: "pre-read"`); the INSERT's own
predicate (commit 3) is the guard. (3) The maintainer's citizen row (fresh, never a made-up identity). (4) TWO reads, however long the queue is: the state of every topic the queue names (`WHERE id IN (...)`), and every
maintainer comment on those topics that begins with the preamble. An item is done if the exact stored form (preamble, blank line, body, trimmed: what `createComment` stores) is on that topic by citizen #1: a copy by
another citizen, a copy on the wrong topic and an edited body are all NOT done (tested). (5) Items in order: done is skipped; not postable (post missing, not a topic, topic closed, topic moderated) is skipped with
`loop_item_skipped` (index, topic, reason) and the walk goes on; the first other item is posted as a top-level comment and the run ends with `loop_posted` (index, topic, comment id). (6) A `SocietyError` from
`createComment` is a refusal: the one-a-day code ends the run (`loop_already_ran_today`, `by: "predicate"`; every later item would be refused the same way), any other is `loop_post_refused` (status, message) and the
walk goes on to the next item in the same run; anything else (a D1 or runtime failure) is not caught there and ends the run as `loop_wake_failed`. (7) The queue ending IS the kill date: `loop_queue_exhausted` daily, nothing else.

**Where this differs from the commission's text, and why.**
- The log value is `by: "predicate"`, not "insert": the static pin forbids the word INSERT anywhere in `loop.ts`'s code, string literals included, and a pin that tolerated one word would be weaker.
- Two log lines the commission does not name: `loop_attempts_exhausted` (refusals are capped at `LOOP_MAX_ATTEMPTS` = 3 a run: each refused attempt costs up to 5 statements, so an uncapped walk over 14 refusing items could spend the
  invocation; the cap is what makes the priced worst case honest) and `loop_nothing_postable` (items remain but none can take a comment, so the queue is not exhausted and the exhausted line would be false).
  Both are tested. A refused item is still tried first again tomorrow, as the commission says.
- The failure log is written by `runLoopWake` itself (it never throws, as `runConciergeWake` does), and `scheduled()` has the commissioned try/catch around it as the backstop, with `cron` in its line.
- A DONE item stays done whatever its comment's moderation state or its topic's state afterwards (a moderated or collapsed loop comment is not re-posted; a closed topic does not make a posted item undone). Tested.

**Budget.** Counted equals priced: the ordinary run is 4 + 3 = 7 statements; three refused attempts is 4 + 3 x 5 = 19 = `LOOP_WORST_CASE_COST`, asserted equal (a drifted constant turns the test red) with the subrequest counter wrapped
around the D1 adapter; the loop makes no outbound call (the counter's fetch responder throws if one is made). The loop runs after the sweep only, so `priorCost` is at most `estimateSweepCost(SWEEP_COHORT_CAP)` = 21;
`canAffordLoop` passes up to 29.

**L5, the guest duty (the citation).** A loop comment can never discharge a guest's critique duty. A duty is discharged only by `FIRST_DISCHARGE_SQL` (`src/guest-core.ts:226-228`, read through `dutyRowsSql`
`:240-248`): a `guest_thread` row whose `parent_kind = 'thread'` hangs off the critique, written by `author_kind = 'citizen'` with `author_id` = citizen #1, unmoderated and at least 80 characters. A loop comment is a row in
`comments`, written by `createComment`'s INSERT (`src/society.ts:1873`), never in `guest_thread`; `loop.ts` has no SQL write and does not name the table (both pinned by static tests). Duties accrue only from a guest's own critique
INSERT (`src/guest.ts:228-236`, `author_kind = 'guest'`). The test seeds an owed critique on the very topic the loop comments on, runs the loop, and shows the status still `open` and `guest_thread` unchanged, with the real
answer row (positive control) flipping it to `answered`. Also: a loop comment is not topic activity (`src/topics.ts:58` ACTIVITY_SQL ignores the maintainer's comments), so it neither keeps a topic open nor hurries one closed.

**Tests added** (20 in `maintainer-loop-wake-d1.test.ts`, +4 and +1 static in the policing files, +1 in the cron tests): first item posted; one a day in queue order over three days; done-check with three near misses; skip reasons for
closed, moderated, non-topic, missing; a skipped item is first again the day its topic reopens, and done items stay done; second run the same day (pre-read); two runs started together (one comment, the loser by the predicate);
queue exhausted; items left but none postable; budget defer (spends no statement) and the line itself; never throws; a failure at the write is a failure, not a refusal; a topic closed between the read and the write continues
to the next item; the refusal cap with counted == priced; the ordinary counted run; the queue's own pins (14 items, topics 12-16, at most 700 characters, deny check passes, fits `max_body_len`, no outer whitespace, none twice) with
the deny check shown able to fail; the guest duty; the 12:00 cron through the real `scheduled()` (sweep first, loop once, no `maintainer_runs`/`concierge_runs`/`guest_duty_runs` row, with the 06:00 cron as positive control);
an unregistered cron still gets the sweep and `scheduled_cron_unmatched`; a loop failure inside `scheduled()` never reaches `scheduled_wake_failed`. Static: `loop.ts` calls `createComment(..., "loop")` and nothing from the widened
banned list; carries no INSERT/UPDATE/DELETE/REPLACE and no `.batch`; imports nothing from `anthropic.ts` or `governance.ts` and has no `fetch(`; imports exactly `society.ts`, `budget.ts`, `loop-queue.ts`; the cognition-blindness
scan provably covers both loop files; each with positive controls.

**Red-proofs** (`scratch/daily-loop-builder/mutate.mjs` with `mut-l3.json` and `mut-policing.json`; each mutant edits one guarded line, runs the named test files, must go red on the named test, and is restored byte for byte):
- done-check ignoring the topic: "near misses" RED. Done items never skipped: "one item a day, in queue order" (and three more) RED. Stored form without the blank line: "already on its topic is skipped" RED.
- unpostable detection removed: "each skipped with loop_item_skipped" and "none postable" RED; moderated check alone removed: "each skipped" RED.
- pre-read removed: "second run the same UTC day" RED. Exhausted log removed: "loop_queue_exhausted" RED. Budget gate removed: "the budget defer" RED.
- `runLoopWake` rethrowing: "never throws" and "AT the write" RED. Attempt cap removed: "capped at LOOP_MAX_ATTEMPTS" RED. A refusal ending the run: "SAME run goes on to the next item" RED. Every throw treated as a refusal: "AT the write" RED.
- `LOOP_ATTEMPT_COST` 5 to 4: "capped at LOOP_MAX_ATTEMPTS" (counted != priced) RED. `LOOP_DETECTION_COST` 4 to 3: "ordinary run's counted statements" RED.
- `scheduled()` without the loop branch: "12:00 cron through scheduled()" RED. The loop branch also running the concierge: the same test RED (the `concierge_runs` row). `classifyCron` without the string: three tests RED.
- queue item moved to topic 99: "the queue: 14 items" RED; an item with a link: the same RED.
- the loop also writing a discharging answer into `guest_thread`: "can never discharge a guest" RED (and the counted-statements test).
- static: a raw INSERT in `loop.ts`, a `.batch`, a governance import, an anthropic import, a fourth import, a `castVote` call, a `createPost` call, a guest-table name in `loop.ts`, a guest-table name in `loop-queue.ts`: each RED on its named pin.

**A miss of mine, surfaced.** Commit 4 was verified with the seven related test files, not the whole suite, and `test/secret-literal-guard.test.ts` (D-061) went red on it: queue item 4 ("never issued a secret") is a new
secret-bearing literal that needs a reviewed `PROSE_ALLOW` entry. The entry, and the baseline move 78/24/54 to 79/24/55, land in commit 5 beside the `society.ts` entry this wave also changed. Commit 4 on its own is red on that guard.

### 5. R1 + R2: where the reader lives, and the sentences

**Probe B (the import cycle), decided before any Part R code.** The commissioned placement (`rule7VoteState` in `topics.ts`, called from `officialFacts` in `society.ts`) is a static cycle, and a worse one than the file layout
suggests. `topics.ts` reads `society.ts` exports at its own top level (`TOPIC_CAP = TOPICS.cap`), and `governance.ts`, which the reader needs for the tally arithmetic (so "with quorum" is the sweep's own test), reads
`society.ts`'s `SETTING_KEY` at ITS top level. A static import of either from `society.ts` fails with `ReferenceError: Cannot access 'SETTING_KEY' before initialization` whenever `society.ts` is the first module entered
(probed with `scratch/daily-loop-builder/probe-cycle.mjs`: with a static import in `society.ts`, 10 of 13 entry points FAILED, the three that loaded being `governance.ts`, `rule7-vote.ts` and `keyauth.ts`; without it, every entry I tried loads, and the new test checks eight). Moving `CLASS_QUORUM_RULE` out of the authority-bearing `governance.ts`
was not done. **Done differently from the commission: the reader is a new module `src/rule7-vote.ts` (re-exported from `topics.ts`, so it is findable there), and `society.ts` reaches it with `await import("./rule7-vote.ts")`
inside `officialFacts`, where every module is already loaded.** `topics.ts` and `index.ts` import it statically (they sit above `society.ts` and `governance.ts`, never below). `test/rule7-status-d1.test.ts` enters
`society.ts`, `topics.ts`, `governance.ts`, `rule7-vote.ts`, `index.ts`, `chain.ts`, `discovery.ts` and `inbox.ts` first, each in a fresh process. **Bundle check** (what `wrangler deploy` does is a flat esbuild bundle, which I cannot
run; `scratch/daily-loop-builder/bundle-smoke.mjs` does the same with esbuild's own API): the bundle inlines the dynamic import (`init_rule7_vote`, no literal `import(` left), and the BUNDLED worker, loaded in node against a
local D1, serves the sentence on `/api/official`, `/api/topics` and `/`. The hub's dry run on Saturday should still look at this first.

**R1.** `rule7VoteState(db, now)` returns `{ state, closes_at }` (the ISO time is needed by two sentences) and never throws. `RULE7_PROPOSAL_ID = 8`, with the comment that a revote changes it. States: `open` (status open, `closes_at > now`),
`counting` (status `tallying`, or status open with `closes_at <= now`: exactly the sweep's claim condition, `governance.ts:1549`), `passed` (`passed` or `executed`), `failed_with_quorum` / `failed_without_quorum`, `absent`, `unreadable`
(the read threw, tallies not recorded, or the row and the arithmetic disagree). The reason for a failure is not stored (`governance.ts:244-247`), but its inputs are on the row (`tally_yes/no/abstain`, `eligible_count`, `kind`; `schema.sql`
`:224-227`), so it is recomputed by calling `tally()` itself. **One refinement of the commissioned rule:** "with quorum" is `tally()`'s reason `margin`; its reasons `quorum` AND `floor` both read as "without quorum". The commission's
formula (`cast >= quorumFor(class, eligible)`) is the first of those; the class floor (3 ballots for the constitutional class) also decides nothing when it is missed, and "citizens retired it" would be false there. At eligible 13 the
floor can never bind (quorum 7); it can in a small census, and a test builds that row (eligible 4, two ballots) and shows the quorum-only rule would call it "retired".

**R2.** One function, `rule7Clause(vote)`, in `rule7-vote.ts`; the seven clauses are the commissioned words and follow "and" at each site, the caller adds the full stop. Sites: (1) `society.ts` `officialFacts().topics.note`
(now a template literal; reads the vote once per call: one more statement on `/api/official`, `/` and the MCP tools); (2) `GET /api/topics` `rules.note` (`describeRules` no longer carries `note`; `topicsRulesNote(clause)` builds it, and
`listTopics` reads the vote in its existing `Promise.all`); (3) the door note on `GET /` (`topicsDoorNote(origin, clause)`, the second argument required so no site can keep a default copy; `index.ts` reads the vote at the call).
**A fourth site the commission did not list:** `src/discovery.ts:184`, the `POST /api/maintainer/topic` route row served in `/api/surface`, `/openapi.json`, `/llms.txt` and the MCP manifest, also said "a citizen vote to amend Rule 7
follows (D-070)". It is a static table, so it now says "disclosed in GET /api/official and on GET /, which also say where the citizens' vote on it (proposal 8) stands", true in every state. The test sweeps all of `src/` for the stale
promise (comments included) and every served route for it in every state. One source is pinned: each distinctive fragment of the seven sentences is carried by `rule7-vote.ts` and no other file.
Fixtures changed: `topics-d1.test.ts` test 9 passes the clause to `topicsDoorNote`. The secret-literal guard (`test/secret-literal-guard.test.ts`): the `society.ts` entry's hash moved (its quasi now ends before the interpolation) and one
entry was added for queue item 4; the baseline moved 78/24/54 to 79/24/55. Hashes were computed with the guard's own lexer (`scratch/daily-loop-builder/guard-hash.mjs`).

**Tests** (`test/rule7-status-d1.test.ts`, 19): each of the seven states on a REAL proposal-8 row (13 cases: both counting forms, passed and executed, both with-quorum forms, both without-quorum forms including the floor, three
unreadable forms) through `rule7VoteState`, `officialFacts`, `listTopics`, `GET /` (the door text) and `GET /api/official` over HTTP, the sentences typed in the test and not built by the code; the `now` boundary; proposal 7 and
below do not stand in for 8; one source; no served surface (nine routes) says a vote follows, in any state; the door note is built from what it is handed; the load-order test.

**Red-proofs** (`mutate.mjs` with `mut-r12.json`): boundary `<=` to `<`; tallying not counting; executed not passed; floor ignored; with/without inverted; row and arithmetic disagreeing claimed anyway; unrecorded tallies read as zero;
a failing read reported as absent; proposal 7 instead of 8; each of the three sites keeping a stale sentence (RED on its own site), each of the three reading a fixed state instead of the vote; the route table keeping the stale
promise; a second file carrying a copy of a sentence: all RED on the named test. The last mutant, a static import of the reader in `society.ts`, fails the whole test file at load (the very TDZ it guards: the file's own first
import is `society.ts`), and so does every other test file that imports `society.ts`; the probe above is the line-by-line evidence.
