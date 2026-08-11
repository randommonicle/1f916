# D-018 focused adversarial gate: judgment wake-start reconciliation (`9214511` + `c35dfbd`)

Date: 2026-08-11. Reviewer: a fresh Claude Opus agent (read-only on the
working checkout; every reproduction run in an independent scratch clone
with probes written from scratch, not inherited from the pre-gate
reviewers; ~150k tokens, 30 tool calls). Commissioned under D-018:
authority-bearing maintainer machinery deploys only after a focused
adversarial review at a different tier from its builder. Both commits'
builders were Sonnet agents; the architect is Fable; the pre-gate
external round (Codex reproducer, Gemini verifier) is recorded at
`exchange/REVIEW_wake-reconciliation_2026-08-11.md` and converged
READY-FOR-GATE. Their findings entered this gate as named press-points
only. Their convergence is evidence, not this gate's verdict, and every
load-bearing claim below was re-derived first-hand.

Scope: the local, unpushed pair on `main` (ahead-2 of `origin/main` at
`3bfba69`) -- `9214511` (wake-start reconciliation, the loud claim catch)
and `c35dfbd` (exact-action supersede disposition, mq1 namespaced
encoding, reconciliation hoisted above the API-key gate). One production
file across both: `src/maintainer/judgment.ts`.

Working-tree discipline: no write to the repo tree at any point; all
probes and all mutating work in a scratch clone outside the project. The
three gated files (`src/maintainer/judgment.ts`, both judgment test
files) were confirmed unmodified in the working tree, so every citation
below is against committed `c35dfbd` content. The working tree itself is
NOT clean -- see F-9, which is a deploy blocker independent of the code.

---

## VERDICT: NOT DEPLOYABLE

The pair's own purpose is achieved and independently proven: both
original defects reproduce red against `3bfba69` and are repaired at
`c35dfbd`; all three pre-gate blockers reproduce red against `9214511`
and close at `c35dfbd`; the mq1 encoding is sound under adversarial
round-trip; the no-key hoist is correct; no test was weakened anywhere in
the pair; 398/398 and typecheck clean in a clean clone.

It does not ship as-is because the new supersede branch can fire on
evidence that is not what it takes it to be, and when it does it writes a
TERMINAL, in-code unrecoverable rejection over a judgment the office
actually made, with no entry in the public append-only log. Two
independent reproductions (F-1, F-2), neither requiring concurrency:

- **F-1**: the community-flag auto-collapse (`src/society.ts:533`) is
  read as "a later collapse decision", so an approved REMOVE is
  terminally rejected and content the judge ordered removed stays
  publicly readable.
- **F-2**: within a single pass, an OLDER stranded decision's own replay
  supersedes a NEWER one, and stamps a reason asserting the exact
  opposite of what happened.

This is the same class the pre-gate round was convened to close (1.1,
silent disposal of a stranded approval), re-opened through doors neither
external checked, and now strictly worse in kind: `9214511` left masked
rows at `approved`, recoverable by a later fix; `c35dfbd` moves them to
`rejected`, which `fetchReconcilableApprovedRows`
(`src/maintainer/judgment.ts:630`) can never re-select. Both fixes are
small -- one regex anchor, one sort direction -- and each admits a direct
red-proof. Ship after a short fixes pass and a re-gate of that pass; do
not hold the underlying repair, which is real and needed.

---

## Reproductions

Method: `git clone --no-hardlinks` of the local repo to scratch, `npm
install`, then `git checkout` per commit with my own probe harness
(untracked, so it survives checkouts) importing the real
`src/maintainer/judgment.ts`, the real `src/society.ts` executors and the
repo's real `createLocalD1` schema harness. No mocks of the code under
test; the model call is stubbed at `globalThis.fetch` only (the repo's
own no-network convention), and the driver anomaly is induced by wrapping
the claim UPDATE so the write really commits and only the returned shape
is damaged.

### The two original defects, red against `3bfba69`

| # | Probe | Verbatim result |
|---|---|---|
| A1 | stranded approved `flag_review`, no artifact, zero pending | `{"head":"3bfba69","post_mod_state":null,"queue":{"id":1,"status":"approved","decided_at":1786476311682,"decided_reason":"confirmed spam"},"run":{"skipped_reason":"nothing pending","items_actioned":0,"error":null,...}}` |
| A2 | claim UPDATE commits, `meta` absent, throw | `{"level":"error","event":"judgment_stamp_failed","queue_id":1,"message":"TypeError: Cannot read properties of undefined (reading 'changes')"}` then `{"head":"3bfba69","post_mod_state":null,"queue":{"id":1,"status":"approved",...},"run":{"skipped_reason":null,"items_actioned":0,"error":null,...}}` |

A1 is the permanent, invisible approved-but-unexecuted state (the act
never happened, `error` NULL). A2 is the same state reached through the
driver anomaly, with the TypeError reaching a console log only and the
public run row finishing clean. Both defects are real.

### The same two at `c35dfbd`

| # | Verbatim result |
|---|---|
| A1 | `{"head":"c35dfbd","post_mod_state":"removed","queue":{...,"decided_reason":"mq1\|remove\|confirmed spam"},"run":{"skipped_reason":"nothing pending","items_actioned":1,"error":null,...}}` |
| A2 | `{"head":"c35dfbd","post_mod_state":null,"queue":{"id":1,"status":"approved",...},"run":{...,"error":"queue row 1: claim failed after its UPDATE may have already committed: Cannot read properties of undefined (reading 'changes')",...}}` |

Repaired: the stranded act is driven to completion and counted; the
anomaly reaches the public `error` field.

### The three pre-gate blockers, red against `9214511`

| # | Probe | Verbatim result at `9214511` |
|---|---|---|
| B1 | stranded `remove`, later real `restore` on same target | `{"first":{"actioned":0,"error":null},"second":{"actioned":0,"error":null},"post_mod_state":null,"queue":{"status":"approved",...}}` |
| B2 | pre-encoding free text `"collapse: prose written before action encoding existed"` | `{"result":{"actioned":1,"error":null},"post_mod_state":"collapsed","events":[{"detail":"collapsed post 1: prose written before action encoding existed"}]}` |
| B3 | approved row, no `ANTHROPIC_API_KEY` | `{"post_mod_state":null,"run":{"skipped_reason":"no api key","items_actioned":null,"error":null,...}}` |

B1 silently masks; B2 executes a moderation no judge machine-recorded;
B3 skips replay for want of a key replay never needed.

### The same three at `c35dfbd` -- all closed

| # | Verbatim result at `c35dfbd` |
|---|---|
| B1 | `{"first":{"actioned":1,"error":null},"second":{"actioned":0,"error":null},"post_mod_state":null,"queue":{"status":"rejected","decided_reason":"superseded: a later restore decision executed after this approval was stranded"}}` |
| B2 | `{"result":{"actioned":0,"error":"queue row 1: approved flag_review has no recoverable action in decided_reason; left for manual review"},"post_mod_state":null,"queue":{"status":"approved",...},"events":[]}` |
| B3 | `{"post_mod_state":"removed","run":{"skipped_reason":"no api key","items_actioned":1,"error":null,"tokens_in":null,"tokens_out":null,"cost_estimate_cents":null}}` |

No stale act executed; the row takes a named terminal and is
unselectable on the second pass; prose is refused loudly and inertly;
the no-key wake reconciles and reports it.

### Suite

`npm test` in the clean scratch clone at `c35dfbd`: **`tests 398 / pass
398 / fail 0`**. `npx tsc --noEmit`: exit 0. The pair's claim verified.

---

## Findings, ranked

### F-1. The community-flag auto-collapse is read as a superseding maintainer decision, terminally rejecting an approved removal

**Severity: HIGH. Authority path. Reproduced end-to-end through the real
public flag path.**

`src/maintainer/judgment.ts:689` builds the artifact marker as
`` new RegExp(`\\b(collapsed|removed|restored) ${targetType} ${targetId}\\b`) ``
and tests it against `identity_events.detail` as a SUBSTRING. The
function's own comment (`:650-652`) states the premise: "detail is
exactly one of three shapes, moderateContent's own construction". That
premise is false. Grepping every writer of `kind='moderation'` under
`MAINTAINER_ID` finds four more:

- `src/society.ts:435` `bulletin post <id> (cap-exempt, auto-pinned)` (the one the builder found)
- `src/society.ts:450` `pinned post <id>` / `unpinned post <id>`
- **`src/society.ts:533` `auto-collapsed <type> <id>: reached <n> community flags`**

`\b` matches between `-` and `c`, so `\bcollapsed post 42\b` matches
inside `auto-collapsed post 42`. Verb-anchoring closed the bulletin
member of this class and left the more dangerous member open.

The two events are causally linked, not independent: the auto-collapse
fires only `if (count >= 5 && exists.mod_state == null)`
(`src/society.ts:505,527`), and `mod_state` is null precisely BECAUSE the
approval is stranded. The queue row exists because citizens flagged the
content; the same flags accumulate toward the threshold.

Reproduction (`probes/d-artifact-identity.ts` D1) drives the real
`flagContent` with five distinct citizens, so the auto-collapse row is
written by `society.ts` itself:

```text
D1 autocollapse-supersedes-approved-remove {"first":{"actioned":1,"error":null},"second":{"actioned":0,"error":null},"post_mod_state":"collapsed","queue":{"id":1,"status":"rejected","decided_at":1786479998573,"decided_reason":"superseded: a later collapse decision executed after this approval was stranded"},"events":[{"detail":"auto-collapsed post 1: reached 5 community flags"}]}
```

The judge's approved `remove` never executes. The post stays `collapsed`
-- "hidden from the feed but preserved and expandable" (`society.ts:546-547`)
-- rather than removed, so content the office ordered taken down remains
readable. The row is now `rejected`, and the second pass returns
`actioned: 0`: no later wake can retry it, and nothing else in `src/`
transitions a queue row (policed by `maintainer-policing.test.ts`).
Recovery requires a hand-written `--remote` D1 UPDATE.

The record is also inverted in substance. `society.ts:541` tells the
citizen the content is "collapsed pending maintainer review". The code
then treats that pending-review marker as the decision that cancels the
maintainer's review. And because the supersede branch writes only to
`maintainer_queue` and never to `identity_events`, the disposal leaves no
trace on the append-only public log -- against this file's own opening
promise (`judgment.ts:8-11`) that every use of power this wake performs
lands there.

D2 (same probe file) shows the benign sibling: a stranded approved
`collapse` plus the auto-collapse yields `match`, a silent skip -- the
outcome coincides, but the office is recorded as having acted when only
the automatic threshold did.

**Reachability today: bounded.** `FLAG_COLLAPSE_THRESHOLD = 5`
(`society.ts:505`) needs five distinct flagging citizens. At today's
population (citizen #1 seated, #2 unblocked) it cannot fire. It becomes
reachable as soon as the D-028 cohort seats five citizens, which is
active work this week. This is a latent HIGH, not a live incident.

**Fix (one line, verified):** anchor the marker at the start of `detail`.
`moderateContent` always constructs its detail with the verb at position
0 (`society.ts:575-576`); no other maintainer-attributed writer does.
Verified across every real shape:

```text
detail                                               shipped  anchored
[moderateContent remove]     "removed post 42: ..."      true     true
[moderateContent collapse]   "collapsed post 42: ..."    true     true
[moderateContent restore]    "restored post 42 to ..."   true     true
[createPost bulletin]        "bulletin post 42 (...)"    false    false
[flagContent auto-collapse]  "auto-collapsed post 42..." true     FALSE
[setPinned]                  "pinned post 42"            false    false
[setPinned unpin]            "unpinned post 42"          false    false
[reason quotes another id]   "removed post 99: ...42..." true     FALSE
[boundary control]           "removed post 429: ..."     false    false
```

`^` keeps every genuine artifact and kills both false positives, with the
`post 42` vs `post 429` boundary control still holding.

### F-2. Within one pass, an older stranded decision's replay terminally rejects a newer one, with a reason asserting the opposite

**Severity: HIGH. Authority path. No concurrency, no population
threshold, no legacy data required.**

`fetchReconcilableApprovedRows` orders `decided_at ASC`
(`judgment.ts:630`), so the OLDEST stranded row replays first. Its own
fresh `identity_events` row is written at `now`, which lies inside the
`created_at >= decided_at` window (`judgment.ts:686-687`) of every
later-decided row on the same target. The supersede branch
(`judgment.ts:819-836`) then reads that as "a later ... decision executed
after this approval was stranded".

Reproduction (`probes/g-same-pass-inversion.ts` G1): two stranded
approvals on one post, an older `collapse` (14 days ago) and a newer
`remove` (7 days ago):

```text
G1 older-replay-supersedes-newer-decision {"result":{"actioned":2,"error":null},"post_mod_state":"collapsed","older_row":{"id":1,"status":"approved","decided_reason":"mq1|collapse|borderline, collapse it"},"newer_row":{"id":2,"status":"rejected","decided_reason":"superseded: a later collapse decision executed after this approval was stranded"},"events":[{"detail":"collapsed post 1: borderline, collapse it"}]}
```

The society's most recent judgment (`remove`) is terminally discarded in
favour of a week-older one, and the stamped reason claims the collapse
was "a later decision" when it was decided earlier and executed by this
same pass seconds before. Control G2 (both rows the same verb) behaves
correctly -- exact match, silent skip -- so the fault is specific to a
differing verb, not to same-target pairs.

**Candidate fix:** order `decided_at DESC`, so the newest decision
replays first and older ones then correctly see a genuinely later
artifact and defer. Both G1 and G2 resolve correctly under that rule by
inspection; it needs its own red-proof before it is trusted.

### F-3. Normal approved `flag_review` rows re-emit a public error every wake, forever, with no in-code exit

**Severity: MEDIUM. Public surface. Two doors, one requiring no crash at
all.**

`fetchReconcilableApprovedRows` re-reads every `status='approved'`
flag_review/bulletin_draft row on every wake with no time bound and no
attempt bound. Two branches then push an error and `continue`
(`judgment.ts:803`, `:814`), leaving the row selected again next week.
The error reaches `maintainer_runs.error`, which `GET
/api/maintainer-runs` (`src/index.ts:213`) serves raw via `SELECT *`
(`src/maintainer/runs.ts:144`), under a published note stating "error is
set when a wake threw". Nothing threw.

Door (a) -- every pre-deploy approved flag_review row. The mq1 namespace
is new, so no existing row can decode, and the decode gate
(`judgment.ts:806`) runs BEFORE the artifact check (`:817`), so a row
that completed perfectly is never vouched for by its own artifact:

```text
F1 completed-pre-deploy-row-errors-every-wake {"passes":[{"actioned":0,"error":"queue row 1: approved flag_review has no recoverable action in decided_reason; left for manual review"},{"actioned":0,"error":"...same..."},{"actioned":0,"error":"...same..."}],"queue":{"id":1,"status":"approved","decided_reason":"confirmed spam"}}
```

Door (b) -- post-deploy, no stranding needed. `clerk.ts:158` accepts
`target_type` of `'citizen'` or `null` for any kind including
flag_review. `resolveExecution`'s flag_review branch requires a truthy
`target_type` (`judgment.ts:231`), so a null-target approval falls
through to `execute: null` -- a normal, successful, terminal approval
whose claim writes a PLAIN reason (`judgment.ts:538`). A clean wake then
poisons every later run row:

```text
F2 clean-approval-poisons-every-later-run-row {"afterDecision":{"queue":{"status":"approved","decided_reason":"the flag is well founded"},"run":{"items_actioned":1,"error":null}},"wake2":{"skipped_reason":"nothing pending","items_actioned":0,"error":"queue row 1: approved flag_review has no valid post/comment target (target_type=null, target_id=null)"},"wake3":{"...":"identical error"}}
```

L-003 is satisfied in letter -- "left for manual review" is a named exit
-- but there is no route by which that review can be recorded, so the
exit is unreachable in code and the message repeats indefinitely rather
than once.

### F-4. The deploy-time cutover query is aimed at the wrong risk and answers GO on a database that will error forever

**Severity: MEDIUM. Runbook defect, not a code defect.**

`docs/CHECKPOINT.md:3885-3901` gates the deploy on
`SELECT COUNT(*) ... WHERE status='approved' AND decided_reason LIKE 'mq1|%'`,
expecting 0. That query is correct for the one risk it names (a
pre-existing free-text reason literally beginning `mq1|` would be decoded
as a machine-recorded decision, and my round-trip probes confirm the
decoder would accept it). It is not sufficient as the only pre-deploy
inventory. Run against a database holding exactly the F-3 rows:

```text
F3 cutover-query-blind-spot {"checkpoint_query_result":{"c":0},"rows_that_will_error_forever":{"c":2}}
```

The runbook needs the complementary read as well:

```sql
SELECT id, kind, target_type, target_id, decided_at, decided_reason
FROM maintainer_queue
WHERE status = 'approved' AND kind = 'flag_review'
  AND (decided_reason IS NULL OR decided_reason NOT LIKE 'mq1|%');
```

Every row it returns will be reported as an anomaly on the public run row
every week from the first post-deploy wake until it is edited by hand.

### F-5. The artifact marker matches a target id quoted inside another moderation's public reason text

**Severity: MEDIUM. Same root cause and same one-line fix as F-1.**

`moderateContent` embeds the caller's reason in the detail
(`society.ts:576`, `"<verb> <type> <id>: <reason.trim().slice(0,200)>"`),
so any moderation whose reason names another target with the verb
adjacent forges that target's artifact. Reproduced with the real
executor:

```text
D3 reason-text-substring-false-artifact {"result":{"actioned":0,"error":null},"stranded_target_mod_state":null,"queue":{"id":1,"status":"approved","decided_reason":"mq1|remove|confirmed spam"},"events":[{"detail":"removed post 2: duplicate of removed post 1 spam"}]}
```

The stranded approved `remove` on post 1 is silently skipped -- blocker
1.1's original signature, at HEAD. The reason text is written either by
the maintainer through the MCP `moderate` tool or by the judge model,
which reads untrusted citizen content by design, so this is also a narrow
injection surface onto the artifact oracle.

### F-6. The accepted concurrency disposition rests on a worst-case analysis that predates the branch it now has to cover

**Severity: LOW. The premise is sound; its stated bound is not.**

The single-invocation-path claim is TRUE and I verified it at source
rather than accepting it: `classifyCron` (`src/maintainer/schedule.ts:25-29`)
matches two literal strings; `wrangler.jsonc:63` registers exactly
`["0 6 * * *", "0 7 * * 1"]`; `runJudgmentWake` has one production caller
(`src/index.ts:294`) and no HTTP route. The architect's acceptance of
documented-not-locked stands on verified ground.

What has moved is the worst case. The comment (`judgment.ts:753-761`)
bounds an overlap at "a duplicate identity_events log line ... or
createPost's own pre-existing dupe_hash guard refusing the second
INSERT". That analysis was written for the replay path. With the
supersede branch, two overlapping wakes can now terminally reject a row
on the strength of the other's in-flight replay -- F-2's mechanism
without the same-pass ordering. Unrecoverable, not a duplicate log line.
The disposition should be re-stated rather than re-litigated.

### F-7. `stampQueueRow`'s return is ignored on both reconciliation re-stamps, so `items_actioned` can over-count

**Severity: LOW.**

`judgment.ts:834` (supersede) and `:850` (deny-check) both discard the
boolean and increment `actioned` unconditionally. The primary path gates
on it (`judgment.ts:557`). If the UPDATE changes no row, a public
`items_actioned` still counts it.

### F-8. Reconciliation has no terminal for a deterministically failing row

**Severity: LOW. Same family as F-3.**

The primary executor re-stamps `rejected` when execution throws
(`judgment.ts:584-586`), which is terminal and honest. Reconciliation's
catch (`:859-861`) only accumulates the message and leaves the row at
`approved`, so a replay that fails the same way every week repeats
forever. Correct for transient failures, absent for permanent ones.

### F-9. The working tree is dirty and RED, with an uncommitted migration in the deploy path

**Severity: BLOCKING for the deploy action itself, independent of the
code verdict.**

`git status -sb` at gate time, at `c35dfbd`, ahead-2:

```text
 M schema.sql
 M src/governance.ts
 M src/maintainer/clerk.ts
 M test/doc.test.ts
 M test/governance.test.ts
?? migrations/0007_first_laws.sql
```

This is in-flight First Laws work, uncommitted. `npm test` in the working
tree: **`tests 351 / pass 350 / fail 1`** (`test/governance.test.ts`).
The gated pair is not responsible -- the same commit is 398/398 in a
clean clone -- but two consequences follow:

1. `wrangler deploy` bundles the working tree, not the commit. Deploying
   "the pair" from this checkout would ship uncommitted, ungated,
   currently-red governance and clerk changes with it, and HANDOVER
   records the First Laws brief as NOT builder-safe with eight blocking
   drift items unadjudicated.
2. Anyone verifying the pair by running `npm test` here will see red and
   may misattribute it.

Deploy must be from a clean checkout of the gated commit. The gated files
themselves are untouched by this drift, which is why the gate's evidence
stands.

Note, not a finding: `migrations/0007_first_laws.sql:69-81` rebuilds
`maintainer_queue` and keeps the status CHECK at
`('pending','approved','rejected')`. The supersede design's premise --
`rejected` is the only terminal the CHECK offers without a migration --
therefore survives. But a rebuild of this exact table is already queued
in the very next wave, so a semantically honest `superseded` status can
be added there at near-zero marginal cost, retiring the prefix
workaround.

---

## Killed findings

Hypotheses I raised and disproved, recorded so they are not re-opened:

- **mq1 decode ambiguity or injection.** Killed. Seven adversarial
  round-trips are exact, including a nested namespace
  (`mq1|remove|mq1|collapse|...` decodes to `remove` with the rest as
  reason), bare pipes, embedded newlines, empty string and `|||`. The
  decoder is anchored to the full namespace and the capture is greedy
  past the second pipe.
- **mq1 prefix truncation corrupting the encoding.** Killed.
  `stampQueueRow` slices the ENCODED string to 500 (`judgment.ts:496`)
  and `parseJudgmentDecisions` already caps the reason at 500, so an
  11-char prefix costs the reason's tail: measured `encoded_len 511 →
  stored_len 500`, prefix intact, action decodes. The lost tail sits
  beyond position 200, which is where `moderateContent` caps the public
  detail, so nothing observable changes.
- **Bulletin artifact text drift causing repeat posting.** Killed.
  `createPost` stores `title.trim()` and the body verbatim
  (`society.ts:426-427`), and `splitBulletinDraft` has already trimmed
  both, so `bulletinArtifactExists`'s exact title+body match holds and an
  executed bulletin is not re-posted.
- **Exact-match-anywhere-wins being wrong on genuine events.** Killed as
  a rule defect, and I could not construct the ordering Codex could not.
  Walked four orderings (exact-then-different, different-then-exact,
  exact-then-reversal, stranded-verb-achieved-by-another-actor); the rule
  gives the right answer in each, and it is load-bearing rather than
  merely a tie-break: without it, an OLD successfully-executed row would
  be re-stamped superseded the moment any later action touched its
  target. The deviation is sound. Its failures in F-1 and F-5 are
  failures of the oracle feeding it, not of the rule.
- **Observational kinds reachable by reconciliation.** Killed; excluded
  at SQL level (`judgment.ts:630`), not by a loop skip.
- **`decided_reason` on a public surface.** Killed independently:
  `maintainer_queue` appears in `src/` only in `clerk.ts`'s INSERT and
  `judgment.ts` itself; no route, no MCP tool.
- **Test weakening across the pair.** Killed. The only lines removed
  across `3bfba69..c35dfbd` in `test/` are a stale comment block. The
  five encode/decode unit tests `c35dfbd` deletes are the dead bare-shape
  tests, replaced by eight strictly stronger ones covering the dead
  shape, Codex's verbatim prose mimic, prefix-verb near-misses, wrong
  version/case/anchoring/missing pipes, and colon+pipe round-trip.
- **Reconciliation disturbing the overflow arithmetic.** Killed.
  Reconciliation touches only `approved` rows and never creates a
  `pending` one, so `pendingAtStart` is unaffected and
  `computeOverflowDropped` correctly receives the batch count alone.
- **Double-reporting in the error surface.** Killed. `appendError` is
  used at every site; the inner successful re-stamp deliberately stays
  console-only and the row carries its own honest reason.
- **Deny-check-before-artifact re-rejecting a live bulletin.** Not
  currently reachable (the patterns are static, and an `approved`
  bulletin row already passed them), so a note rather than a finding: it
  becomes reachable if `BULLETIN_DENY_PATTERNS` is ever TIGHTENED, which
  `judgment.ts:138-142` anticipates. Ordering the artifact check first
  would make it moot.

## Notes

- **N-1.** The no-key run row can now report `skipped_reason: "no api
  key"` alongside `items_actioned: 1`, while `/api/maintainer-runs`'s
  published note tells citizens `skipped_reason` means "a day with
  nothing to do" and that cost is zero (it is NULL). The behaviour is
  right; the note is now slightly behind it.
- **N-2.** The supersede re-stamp overwrites `decided_reason` and
  `decided_at`, so the original approval's reason and timestamp are lost
  from the row, and nothing is written to `identity_events`. Acceptable
  while the row is internal working paper, but it means a disposal of a
  judgment leaves no public trace anywhere -- which is what makes F-1 and
  F-2 invisibly wrong rather than merely wrong.
- **N-3.** The per-row artifact query re-scans all maintainer moderation
  events since each row's `decided_at`, for every approved row, every
  wake, unbounded in both row count and history. The builder flagged the
  N+1 shape; F-3 makes it permanent rather than transient, since rows are
  never retired from the scan.

## Unverified

Stated plainly rather than implied:

- **The live D1 cutover query is known-unexecuted.** It requires
  `--remote`, which this review is forbidden. It remains mandatory, and
  per F-4 it is necessary but not sufficient; run the complementary
  inventory query in F-4 in the same session.
- **The live contents of `maintainer_queue` are unknown to me.**
  `maintainer_queue` is served by no public route, so I could not bound
  F-3's blast radius from outside. Whether the first post-deploy wake
  publishes an error depends entirely on how many approved `flag_review`
  rows already exist. The F-4 query answers it.
- **Real D1 versus the harness.** All reproductions ran against the
  repo's `node:sqlite` `createLocalD1` shim on the real committed
  `schema.sql`. That is this repo's own accepted D1 idiom, but it is not
  Cloudflare D1; no finding here depends on driver-specific behaviour,
  and the one driver-specific defect in scope (the `meta` anomaly) was
  induced deliberately rather than observed.
- **Cloudflare cron retry semantics** are taken from the platform's
  documented at-least-once behaviour, not observed. F-6's remoteness
  rests on that.
- **F-1's population bound** is derived from the code
  (`FLAG_COLLAPSE_THRESHOLD = 5`) and the project's own record of who is
  seated, not from a live citizen count.

## What would make this DEPLOYABLE

1. Anchor the artifact marker at `^` (closes F-1 and F-5), with a
   red-proof per finding, including a regression fixture for the real
   `auto-collapsed` detail string.
2. Resolve F-2's ordering, candidate `decided_at DESC`, with its own
   red-proof for both the differing-verb and same-verb pairs.
3. Decide F-3's disposition: at minimum retire a row from the scan once
   its anomaly has been reported, so the message is emitted once rather
   than weekly. F-7 and F-8 are cheap to take in the same pass.
4. Add F-4's inventory query to the deploy runbook beside the existing
   cutover check.
5. Deploy from a clean checkout of the gated commit, never from the
   current working tree (F-9).

Items 1 and 2 are authority-path and gate-blocking. Items 3 to 5 are
strongly recommended in the same pass but would not, alone, have blocked.
