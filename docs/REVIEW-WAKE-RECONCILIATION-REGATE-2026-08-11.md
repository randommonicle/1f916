# D-018 focused re-gate: the wake-reconciliation gate-fixes pass (`07576cf`)

Date: 2026-08-11. Reviewer: a fresh Claude Opus agent, read-only on the working checkout; every reproduction run in an independent scratch clone with a probe harness written from scratch, not inherited from the gate-fixes builder or from my predecessor. Commissioned under D-018 as the re-gate the original gate's own closing instruction required ("ship after a short fixes pass and a re-gate of that pass").

Scope: the triple `9214511` + `c35dfbd` + `07576cf`, local and unpushed on `main` (ahead-4 of `origin/main` at `3bfba69`). `07576cf` touches three files: `src/maintainer/judgment.ts`, `src/maintainer/runs.ts`, `test/maintainer-judgment-d1.test.ts`.

Deliberately out of scope, per the commission: F-6 (concurrency comment re-statement, a pre-deploy chip) and N-3 (unbounded artifact scan, queued for the queue-rebuild era). Both confirmed still open below rather than silently dropped. F-9 was verified only for resolution.

Method: `git clone --no-hardlinks` to scratch, `npm install`, then the probe harness (untracked, so it survives checkouts) importing the real `src/maintainer/judgment.ts`, the real `src/society.ts` executors and the repo's own `createLocalD1` schema harness. No mocks of the code under test. **Every probe was first run against `c35dfbd` and confirmed RED** before being trusted against `07576cf` — the harness is proven able to fail.

---

## VERDICT: DEPLOYABLE

Both HIGH findings are closed at the root rather than papered over, and each closure is independently reproduced here against the real public paths, not merely asserted by the builder's own tests. The artifact oracle now has a defensible premise: I enumerated every maintainer-attributed moderation writer first-hand (four, all in `society.ts`) and `moderateContent` is the only one whose `detail` ever begins with a bare verb at position 0. The `^` anchor kills both false positives and, because the regex carries no `m` flag, it also kills a newline-embedded forgery variant the original gate never tested.

The one new defect I found (R-1) is a labelling and observability defect on a population that is bounded, enumerable before deploy by the F-4 query the runbook already mandates, and incapable of executing a wrong act. It does not re-open the class that blocked the original gate.

---

## Per-finding disposition

| # | Gate severity | Status at `07576cf` | Evidence |
|---|---|---|---|
| F-1 auto-collapse read as superseding decision | HIGH | **CLOSED** | R1 |
| F-2 same-pass ASC inversion | HIGH | **CLOSED** | R2 + R2b control |
| F-3(a) undecodable row errors every wake | MEDIUM | **CLOSED** | R3a, R3b (three passes each) |
| F-3(b) null-target approval poisons every run row | MEDIUM | **CLOSED** | R4 (three shapes, three passes) |
| F-4 cutover query insufficient | MEDIUM | **CLOSED** (runbook) | complementary query present verbatim in the checkpoint |
| F-5 reason-quoted id forges an artifact | MEDIUM | **CLOSED** | R5, plus X1/X2 newline variants |
| F-6 concurrency bound predates the branch | LOW | **OPEN — out of scope**, confirmed queued as a pre-deploy chip | — |
| F-7 `stampQueueRow` boolean discarded | LOW | **CLOSED at all four sites** | R6a–R6d |
| F-8 no terminal for a deterministically failing row | LOW | **ACCEPTED as-is** per ruling; comment present at the catch, behaviour unchanged | — |
| F-9 dirty, red working tree | BLOCKING | **RESOLVED** | tree clean, ahead-4 |
| N-1 served note behind behaviour | note | **CLOSED**, with residue — see R-2 | `runs.ts:151` |
| N-2 supersede leaves no public trace | note | **DEFERRED** as ruled; `FORWARD(supersede-public-event)` comment present | — |
| N-3 unbounded per-row artifact scan | note | **OPEN — out of scope**, confirmed queued | — |
| boundary control `post N` vs `post N0` | control | **HOLDS** under the new anchor | R7 |

---

## Reproductions, verbatim

### The two HIGH findings

**F-1** — the real `flagContent` path, five distinct citizens, so `society.ts` itself writes the auto-collapse row:

```text
RED at c35dfbd:
R1 {"first":{"actioned":1},"second":{"actioned":0},"post_mod_state":"collapsed","queue":{"id":1,"status":"rejected","decided_reason":"superseded: a later collapse decision executed after this approval was stranded"},"events":["auto-collapsed post 1: reached 5 community flags"]}

GREEN at 07576cf:
R1 {"first":{"actioned":1,"error":null},"second":{"actioned":0,"error":null},"post_mod_state":"removed","queue":{"id":1,"status":"approved","decided_reason":"mq1|remove|confirmed spam"},"events":["auto-collapsed post 1: reached 5 community flags","removed post 1: confirmed spam"]}
```

The judge's approved `remove` now executes; the row stays selectable and the second pass correctly finds `match` and skips. Content the office ordered removed is removed.

**F-2** — older `collapse` (14 days), newer `remove` (7 days), one target:

```text
RED at c35dfbd:
R2 {"result":{"actioned":2},"post_mod_state":"collapsed","older_row":{"status":"approved"},"newer_row":{"id":2,"status":"rejected","decided_reason":"superseded: a later collapse decision executed after this approval was stranded"}}

GREEN at 07576cf:
R2 {"result":{"actioned":2,"error":null},"post_mod_state":"removed","older_row":{"id":1,"status":"rejected","decided_reason":"superseded: a later remove decision executed after this approval was stranded"},"newer_row":{"id":2,"status":"approved","decided_reason":"mq1|remove|confirmed spam"},"events":["removed post 1: confirmed spam"]}
```

The society's most recent judgment wins, and the stamped reason is now true: the `remove` was genuinely decided later. Same-verb control R2b still resolves to a single execution and a silent idempotent skip, and now carries the *newer* row's reason into the public detail (`"removed post 1: newer remove"`), which is the more correct record.

### F-3, both doors, three passes each

```text
R3a ABSENT  {"passes":[{"actioned":1,"error":"queue row 1: approved flag_review has no recoverable action in decided_reason; left for manual review"},{"actioned":0,"error":null},{"actioned":0,"error":null}],"queue":{"id":1,"status":"rejected","decided_reason":"unrecoverable: no machine-readable action; left for the operator"}}

R3b PRESENT {"passes":[{"actioned":1,"error":null},{"actioned":0,"error":null},{"actioned":0,"error":null}],"post_mod_state":"removed","queue":{"id":1,"status":"rejected","decided_reason":"completed pre-encoding: confirmed spam"}}

R4 door (b) {"passes":[{"actioned":0,"error":null},{"actioned":0,"error":null},{"actioned":0,"error":null}],"null_row":{"status":"approved"},"citizen_row":{"status":"approved"},"post_no_id_row":{"status":"approved"}}
```

The error emits exactly once and the row retires, against three passes on both sub-cases. Door (b) is closed at the SQL level for all three shapes I tried (`null`, `citizen`, and `post` with a null id): never selected, never reported, rows left untouched as the terminal approvals they are. Against `c35dfbd` all three shapes errored on all three passes.

### F-5, including a variant the original gate did not test

```text
R5  {"result":{"actioned":1,"error":null},"p1_mod_state":"removed","events":["removed post 2: duplicate of removed post 1 spam","removed post 1: confirmed spam"]}
X1  newline-forged marker: {"result":{"actioned":1,"error":null},"p1_mod_state":"removed","events":["removed post 2: spam\nremoved post 1: forged artifact","removed post 1: confirmed spam"]}
X2  same forge against the NEW F-3(a) oracle: {"result":{"actioned":1,"error":"queue row 1: ... left for manual review"},"queue":{"status":"rejected","decided_reason":"unrecoverable: no machine-readable action; left for the operator"}}
```

X1/X2 are mine, not the gate's: a moderation reason carrying an embedded newline followed by a perfectly-formed marker for another target. This defeats a `^` anchor if and only if the regex carries the `m` flag. It does not (`judgment.ts:733`, `new RegExp(...)` with no flags argument), so `^` is string-start only. The forge fails against both the supersede oracle and the new F-3(a) oracle — the latter correctly takes the loud `unrecoverable` exit rather than the silent `completed` one. This matters because the judge model reads untrusted citizen content by design.

### F-7 at all four sites, not the two red-proofed

The builder disclosed (deviation 1) that F-7 was applied to four re-stamp sites but red-proofed at two. I proved all four myself, with a DB whose `maintainer_queue` UPDATEs report zero rows changed and do not execute:

```text
R6a supersede            {"result":{"actioned":0,"error":null}}
R6b deny-check           {"result":{"actioned":0,"error":null}}
R6c completed-pre-encoding {"result":{"actioned":0,"error":null}}
R6d unrecoverable        {"result":{"actioned":0,"error":"queue row 1: ... left for manual review"}}
```

Against `c35dfbd`, R6a and R6b both returned `actioned: 1`. R6d is the one to note approvingly: the error is still emitted even though the stamp failed, so a failed retirement does not suppress its own report and the row stays selectable for a genuine retry. **Deviation 1 is accepted on evidence, not on the shape argument.**

### Boundary control

```text
R7 {"result":{"actioned":2},"p42":"removed","p429":"removed","p1":"removed","p12":"removed","events":["removed post 429: unrelated removal","removed post 12: unrelated removal","removed post 42: spam on 42","removed post 1: spam on 1"]}
```

Both stranded rows executed, so neither `removed post 429` nor `removed post 12` was mistaken for post 42's or post 1's artifact. The trailing `\b` still does its job under `^`.

### New surface: DESC across multiple stranded rows on different targets

Four stranded rows, three targets, interleaved decided_at (1d, 3d, 10d, 20d), differing verbs:

```text
RED at c35dfbd:
N1 {"pA":"collapsed","rA":{"id":1,"status":"rejected","decided_reason":"superseded: a later collapse decision..."},"rD":{"status":"approved"}}

GREEN at 07576cf:
N1 {"result":{"actioned":4,"error":null},"pA":"removed","pB":"collapsed","pC":null,"rA":{"status":"approved"},"rB":{"status":"approved"},"rC":{"status":"approved"},"rD":{"id":4,"status":"rejected","decided_reason":"superseded: a later remove decision executed after this approval was stranded"},"events":["restored post 3 to visible","removed post 1: A remove","collapsed post 2: B collapse"]}
```

Execution order is exactly DESC, cross-target independence holds, each target reaches the state its newest judgment ordered, and the only superseded row is the one genuinely overtaken. This was an independent second reproduction of F-2 at `c35dfbd`; it is clean now.

---

## New findings

### R-1. `completed pre-encoding:` labels a *superseded* undecodable row as completed, and does so silently

**Severity: LOW. Not gate-blocking. Labelling and observability, no wrong act executed.**

The F-3(a) PRESENT branch (`judgment.ts:912`) retires an undecodable row with `completed pre-encoding: <old reason>` and no run-row error. Its justifying premise, stated in its own comment, is "the act already happened". That premise can be false in two reachable ways:

```text
N2  a genuinely stranded 20-day-old prose approval ("confirmed spam, remove it"), never executed,
    whose target later received a DIFFERENT hand moderation (collapse):
    {"result":{"actioned":1,"error":null},"post_mod_state":"collapsed","queue":{"status":"rejected","decided_reason":"completed pre-encoding: confirmed spam, remove it"}}

N3b the artifact is written by THIS SAME PASS's replay of a different row on the same target:
    {"result":{"actioned":2,"error":null},"undecodable_row":{"status":"rejected","decided_reason":"completed pre-encoding: plain prose, no encoding"}}
```

In N2 the office approved a removal, the content is merely collapsed, and the row is disposed of silently under a reason asserting completion. The decodable equivalent of exactly this situation takes the supersede branch and stamps an honest `superseded:` reason.

Why this is LOW and not a blocker: the action is genuinely undecodable, so no code could have replayed it correctly and nothing wrong is executed; the original prose reason is preserved verbatim after the prefix, so a human can still read what the judge said; and the population is bounded to rows decided before the mq1 encoding existed. Post-deploy, a `flag_review` row with a real post or comment target always gets an mq1 reason, because `resolveExecution` always produces a `moderate` execution for one and the claim path always encodes it — I checked this at source rather than assuming it. That population is precisely what F-4's inventory query enumerates before deploy.

Recommended, not required: reword the stamp so it does not assert completion (`retired pre-encoding (artifact present): <old reason>`), or report once. Either is a one-line change and neither needs to gate this deploy.

**Runbook wording nit, same family.** The checkpoint's F-4 addendum tells the operator such rows are "silently retired if the target already carries a real moderation artifact **from before this encoding existed**". The code's actual condition is any artifact after `decided_at`, including one written by the same wake (N3b). Worth aligning so the operator's expectation matches behaviour.

---

## Notes

- **R-2. The served note's "cost is zero either way" is literally backed on only one of the two branches it names.** `runs.ts:151` now enumerates `'nothing pending'` and `'no api key'` and asserts cost is zero for both. The nothing-pending branch writes `tokensIn/tokensOut/costEstimateCents` as 0; the no-key branch omits them, so `/api/maintainer-runs` serves NULL. The substantive claim (neither skip makes a model call, so no money was spent) is true. Not a regression — the previous note asserted zero too — and it is the builder's own disclosed deviation 2, still open with the architect. Everything else in the new note I checked and found accurate: reconciliation genuinely runs ahead of both the key gate and the pending count; both skip branches genuinely pass `reconciliation.actioned` through; `error` genuinely now covers the reconciliation pass; `/treasury` exists (`index.ts:105`); the daily/weekly framing matches `wrangler.jsonc:63`. L-002 clean: no upstream handle, issue number or parent-deployment claim, and the automated gate passes.
- **R-3. `decided_at` ties.** Two approvals on one target with identical `decided_at` and differing verbs produce `superseded: a later <verb> decision...` where neither is later. Behaviour is **identical pre- and post-fix** (N4 verbatim at both commits), so the DESC change neither creates nor worsens it. Requires two same-target judgments in the same millisecond. Note only.
- **R-4. The new served note cites `(D-018 gate, N-1)`.** An internal review-record identifier in a citizen-facing API string. Not an L-002 instance — it is our own lineage, not the parent's — and it resolves against `society/docs/`, but only once the repo is pushed. Push before or with the deploy so the citation is not dangling.

---

## Killed hypotheses

Raised and disproved, recorded so they are not re-opened:

- **`^` anchor false negatives on genuine artifacts.** Killed. I enumerated every maintainer-attributed moderation writer first-hand rather than accepting the comment's list: `logModeration` has one call site (`society.ts:435`, bulletin) and `commitWithModLog` three (`:450` pinned/unpinned, `:533` auto-collapse, `:577` moderateContent). There are no other `identity_events` moderation writers in `src/`. Only `moderateContent` constructs a detail with the verb at position 0, and it is never trimmed or prefixed en route. Legacy artifacts written by the old code have the identical shape, so pre-deploy artifacts still match.
- **Newline-embedded marker forgery.** Killed (X1, X2). No `m` flag, so `^` is string-start only.
- **Regex injection through the interpolated target.** Killed. `target_id` is `INTEGER` in `schema.sql:183` and TS-narrowed to `number`; `target_type` carries a CHECK constraint and is narrowed to `"post" | "comment"` before interpolation.
- **The two new terminal strings being forgeable into authority.** Killed. Nothing in `src/` reads or branches on `completed pre-encoding:` or `unrecoverable:` — they are write-only, asserted only in tests. A judge writing either string as free text produces an ordinary undecodable row that takes the ordinary F-3(a) path.
- **Citizen-reachable forging of the F-3(a) oracle.** Killed (N5): five distinct citizens driving the only citizen-reachable moderation writer produce `auto-collapsed ...`, which no longer matches, so the row takes the loud ABSENT exit. `moderateContent` is maintainer-only (403 otherwise), so the oracle requires maintainer authority.
- **DESC harming multi-target sets.** Killed (N1).
- **F-3(b)'s SQL exclusion dropping genuinely stranded rows.** Killed. A stranded row necessarily had a real post/comment target, and comment targets are unaffected — probe C1: a stranded approved `remove` on a comment reconciles to `{"actioned":1}`, `comment_mod_state: "removed"`, event `removed comment 1: abusive comment`, idempotent on the second pass. Only `execute: null` shapes are excluded.
- **A null `decided_at` bypassing the artifact window.** Killed. An explicit guard at `judgment.ts:867` reports and skips before either branch can run, so no row reaches the oracle with an unbounded window.
- **Test weakening.** Killed. `07576cf` touches one test file. Assertions 69 → 115, `test(` blocks 14 → 23. The only deletions are the two false-decode tests' expectations, changed per the F-3(a) ruling and *gaining* assertions (exact reason text, plus three-pass silence); every other pre-existing assertion is intact. My own probes reproduce all nine reds independently of the builder's tests, which is the stronger check.

---

## Suite

`npm test` in the clean scratch clone at `07576cf`: **`tests 407 / pass 407 / fail 0 / skipped 0 / todo 0`**. `npx tsc --noEmit`: exit 0. Re-verified after the checkout dance, not carried over from the first run.

## F-9 re-check

`git status --porcelain` at `07576cf`: **empty**. `## main...origin/main [ahead 4]`. The First Laws drift the original gate found (`schema.sql`, `src/governance.ts`, `src/maintainer/clerk.ts`, `test/doc.test.ts`, `test/governance.test.ts`, `migrations/0007_first_laws.sql`) is gone from the tree. The triple's diff against `origin/main` is five files, all in scope. Deploy from a clean checkout of `07576cf` remains the instruction, but the tree no longer blocks it.

## Unverified

- **Both deploy-time D1 queries remain known-unexecuted operator work.** They need `--remote`, which this review is forbidden. Reproduced here so the gate record is self-contained, since the runbook itself lives in un-versioned paperwork:

```sql
SELECT COUNT(*) AS c FROM maintainer_queue
WHERE status = 'approved' AND decided_reason LIKE 'mq1|%';
-- expect 0; a hit is a HOLD

SELECT id, kind, target_type, target_id, decided_at, decided_reason FROM maintainer_queue
WHERE status = 'approved' AND kind = 'flag_review'
  AND (decided_reason IS NULL OR decided_reason NOT LIKE 'mq1|%');
-- not a HOLD; every row is now auto-handled on the first post-deploy wake.
-- Run it so the count is known in advance, and note R-1: rows here whose
-- target carries any later artifact retire SILENTLY under a "completed"
-- label, so this listing is the only advance record of them.
```

- **The live contents of `maintainer_queue` are unknown to me** — no public route serves it, so R-1's real blast radius is whatever the second query returns.
- **Real D1 versus the harness.** All reproductions ran against the repo's `node:sqlite` `createLocalD1` shim on the real committed `schema.sql`. No finding here depends on driver-specific behaviour; the one driver-specific defect in the family (the `meta` anomaly) was out of this pass's scope.
- **F-6 and N-3 are open by commission, not by oversight** — confirmed still queued, not silently dropped.
