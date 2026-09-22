# D-018 PRE-DEPLOY GATE — standing topics (D-070) + the key-lost quorum wording (2026-09-22)

**Reviewer:** independent Opus adversarial gate (D-018), briefed from
`drafts/GATE-BRIEF-STANDING-TOPICS-2026-09-22.md` only. Every claim below was checked against
source, the live service or a local run. Read-only throughout: no push, deploy, commit, merge,
migration, secret or `--remote` call; `wrangler` not run; no `*.local.*` file opened; the main
checkout not touched. One throwaway test (`test/zz-gate-miniflare-changes.test.ts`) was run
and deleted. This record is the only file written.

**Scope.** Worktree `scratch/wt-wording`, branch `quorum-wording-2026-09-22`, HEAD `b9afa3e4`,
clean. Deploy range `637d46bf..b9afa3e4` (live worker `637d46bf`): `8b5c5e97` (the wave,
migration 0015), `82511a12` (scripts), `cb720a57` (GEMINI r1), `a0e50468` (CODEX r1,
`changes() = 1`), `5dba618a` (checkpoint), `1099a461` (the probe), `b9afa3e4` (the key-lost
wording). `origin/main` = `1099a461`. `b9afa3e4` is not on main yet, so it must be merged and
pushed before the deploy script will run (`deploy-standing-topics.ps1:36-39`).

---

## Findings

### HIGH
None.

### MEDIUM

**M1. The prod `changes()` pre-step cannot be read as written, and even if read it would not
exercise the Worker's batch path. It blocks the first `open-topic.mjs --execute`, not the
deploy.**

- `scripts/deploy-standing-topics.ps1:8-13` says to run `npx wrangler d1 execute commonhold
  --remote --file "scripts/changes-probe.sql"` and to "expect notes: changes=1, changes=0
  (unconditional), changes=1".
- Wrangler 4.118.0 (`node_modules/wrangler/wrangler-dist/cli.js`), read first-hand:
  `--remote --file` goes to D1's **import** API (R2 upload, `ingest`, poll) and returns a
  single summary row: `Total queries executed`, `Rows read`, `Rows written`,
  `Database size (MB)` (`:301169-301231`). The probe's closing `SELECT * FROM probe_log` is
  never printed. Per-statement rows are printed only on the `--command` path, which calls
  `/query` (`:301232-301243`) and then tables each result (`:301492-301510`). The import path
  also warns that the database "will be unavailable to serve queries" while it runs
  (`:301137`).
- Even read back, the import path is not `env.DB.batch([...])`. That is CODEX's r2
  position, corroborated here from source. By contrast, `--local --file` splits the file and
  runs `db.batch(...)` through Miniflare (`:301094-301098`), so the builder's local ride
  (CHECKPOINT-TOPICS commit 4) had the right shape. Only the remote step has the wrong one.
- The step exists only as prose: `open-topic.mjs` does not refuse `--execute` if it was
  skipped.
- **The consequence if `changes()` did not bind on prod.** The winner's gate would read ≠1
  and the batch would commit `[1, 0]` (a seed) or `[1, 1, 0]` (a replacement). The route
  throws 500 only after that commit (`src/topics.ts:318-356`), so a topic would exist with no
  chained moderation row, and no application path deletes a posts row. If prod's authorizer
  refused `changes()` outright, the batch would fail before commit. That outcome is safe:
  the feature simply does not work.
- **Reproduced locally on the Worker API shape** (Miniflare 5.20260730.0-alpha, the workerd
  D1 binding, in memory; the throwaway test ran 4/4 and was then deleted). Verbatim vectors:
  - Raw batches through the binding: `a=[1,1] b=[0,0] c=[1,0,0] d=[1,1]`. `c` is the no-leak
    case: a 1-row statement, then a 0-row statement, then the gate. `d` is an UPDATE followed
    by the gate.
  - The shipped probe file, split and run as one batch, returns exactly the three expected
    notes.
  - The real `openTopic` on the binding: five seeds `[1,1]` each, then a replacement
    `[1,1,1]`. All 6 rows are sealed.
  - CODEX's A5d schedule on the binding. As shipped: `[[1,1,1],[0,0,0]]`, the loser gets 409,
    and one row lands. With only the loser's `AND changes() = 1` removed:
    `[[1,1,1],[0,0,1]]`, the loser gets 500 "inconsistent vector [0, 0, 1]", and a **false
    second row** commits.

  So the clause is load-bearing, and it holds on workerd's D1. This does **not** discharge
  the condition, because production D1 is a different service from Miniflare's simulator.
- Condition **C1** below.

### LOW

**L1. `changes()` carries across batches.** In the same Miniflare run, a gate placed *first*
in its own batch read the previous batch's count (`crossBatchGateFirst=[1]`). Both shipped
gates follow their state statement inside the same batch: `topics.ts:261-316`, and
`commitGatedWithModLog`'s `[stateStmt, log.stmt]` at `society.ts:1263-1281`. So they are
sound, but only the shape of the code enforces that ordering. A comment or assertion at those
two batch sites would turn it into a control. Non-blocking.

**L2. `/api/events` attributes every topic act to citizen #1.** The chained row is written
with `citizen_id: MAINTAINER_ID` (`topics.ts:315`, and the restore path at `society.ts:1398`),
and `identityLog` serves `c.handle AS citizen` (`society.ts:1940-1950`). Each opening or
closing therefore reads as `commonhold-agent`'s moderation act. Every topic surface, however,
says `opened_by: "the operator, through POST /api/maintainer/topic"`, and ROUTES calls
MAINTAINER_SECRET "an operator credential, distinct from any citizen's own secret". This is
consistent with the existing convention: community auto-collapses are also logged under
citizen #1 (`society.ts:1314`). The D-070 disclosure should still say it in so many words
("logged in the maintainer's moderation log under citizen #1"). Non-blocking; wording for the
Rule 7 amendment.

**L3. "Quiet" is steerable by the operator.** `ACTIVITY_SQL` (`topics.ts:56`) excludes only
citizen #1's comments and moderated comments. Comments by the four other operator-controlled
citizens count as activity. The operator can therefore keep a chosen topic open, which
decides which quiet topic closes. Moderating comments away can also make a topic quiet. Every
such act is public (attributed comments, logged moderation), and the served text matches the
code ("a citizen other than the maintainer", "visible"). It does not say that the input to
the closing rule is partly under operator control. For the Rule 7 amendment text.
Non-blocking.

**L4. Served-wording precision (all outside the template).**
- (a) `officialFacts.topics.note` (`society.ts:1599`) says "every opening and closing writes
  one chained moderation row", but a replacement writes ONE row for both acts
  (`topics.ts:308-310`). The door note ("each act writes one chained moderation row") and
  ROUTES ("One chained moderation row per act") are exact.
- (b) The same note glosses the quietest topic as having "no visible comment by a citizen
  other than the maintainer inside the quiet period". That leaves out the close's second
  condition, that the topic itself opened at least 14 days ago (`topics.ts:270`).
- (c) `publicStats.note` (`discovery-data.ts:166`) still says `posts_visible` can be
  cross-checked by paging through GET /api/changes. `changes()` (`society.ts:1985-1996`)
  now returns visible topics in its posts array (with `kind: "topic"`), while
  `posts_visible` excludes them. The recipe is therefore off by the number of visible topics
  unless the reader filters on `kind == "post"`.

Non-blocking.

**L5. The deploy script.**
- (a) The post-deploy attest line (`deploy-standing-topics.ps1:82`) prints chain status but
  does not stop on a non-`verified` chain; only a template-hash change stops it (`:81`).
- (b) There is no clean-tree check. The level check reads only the first line of
  `git status -sb` (`:34-39`), so uncommitted edits in `society/` would be tested and
  deployed. The 0014 script has the same gap (`deploy-2026-09-19-listing-fixes.ps1:21-23`).
- (c) 0015 is applied with `--file --remote`, which is the import path, so expect a few
  seconds of live errors while it runs (see M1). 0014 was applied the same way.

Non-blocking.

**L6. `open-topic.mjs`.**
- Line 18 lets `COMMONHOLD_ORIGIN` send the maintainer-secret POST to any origin. The other
  secret-bearing scripts pin their target (`post-listing.mjs:46`, `pay-listing.mjs:72`).
  Print the origin before `--execute`, or drop the override.
- A missing `--file` path throws an uncaught ENOENT stack (`:40`). That fails closed and
  prints no secret.

Non-blocking.

**L7. No per-IP cap on POST /api/maintainer/topic.** It is not a spend path. The secret
check (`topics.ts:370-375`) runs before any D1 read, and after authentication the rule itself
bounds writes (five, then one per 7 days; every other attempt is a 409 after a handful of
reads). The trigger has the same posture before authentication; its cap sits after
authentication to guard model spend. Non-blocking.

**Notes (no action):**
- The clerk sends topics to its model as `<item type="post">` (`clerk.ts:317-331`). No author
  is rendered, and each topic costs one queue item.
- A no-op restore of a *visible* open topic at the cap returns a 409 saying the state moved
  (`society.ts:1382-1398`). Only the operator can reach it.
- DECISIONS.md D-065 (line 707) still quotes the retired phrase "counted toward every
  quorum". It is a historical record; a docs follow-up at most.

---

## The brief's eight attacks: dispositions

1. **Authority: PASS (L7 answers the volume question).**
   - The route reuses the trigger's `secretMatches` (`topics.ts:37`, `:370-375`). Unset,
     blank, missing or wrong secrets all get the identical 401 before the body is read
     (test 1).
   - The only writer of `kind = 'topic'` is `topics.ts:288`. The only writers of
     `topic_state` / `topic_closed_at` are `topics.ts:268` (behind the secret) and
     `society.ts:1390` (`moderateContent`: `citizen.id === 1` plus signed intent).
   - `createPost`'s INSERT (`society.ts:1172`) names no `kind` column, so the row takes
     DEFAULT 'post'. There is no other `INSERT INTO posts` in `src/`, so proposals and MCP
     create posts through `createPost`.
   - Judgment moderates through `moderateContent` (`judgment.ts:1068`), so it inherits the
     restore-at-cap guard.
2. **Attribution: PASS, with L2.** I grepped every `posts` reader in `src/` (case-insensitive
   `from|join|into|update posts`: 50 hits in 6 files). Each is either taught `kind` or never
   renders authorship:
   - front `society.ts:1035`
   - readPost / changes CASE projections
   - `me` `:1784`, `history` `:1816`
   - search `discovery-data.ts:89`, stats `:143-144`, treasury `society.ts:2086`
   - concierge `concierge.ts:171,190`
   - judgment bulletin reconciliation `judgment.ts:1319`
   - `countSince` `society.ts:255`
   - clerk (Notes)

   Votes on a topic award no karma (`society.ts:1750`); the maintainer cannot vote on one
   (`:1728`); a topic cannot be pinned (`:1202`). The topic detail strings start with
   `topic `/`restored post N`, so judgment's anchored marker parser
   (`judgment.ts:1262`) neither misses nor forges them. Test 7's blast-radius fixture
   passes.
3. **Concurrency and the chain: PASS for the statements; M1 for the prod premise.**
   - Seed against seed: the same predicted id fails on the `posts.id` UNIQUE, the attempt
     retries, and the interval returns 409. Different ids: the seed count clause gives
     `[0,0]` and a 409.
   - Replacement against replacement: A5, A5c, A5d, and the Miniflare A5d above.
   - A close against a comment: A5b.
   - A restore against an opening: both statements carry the cap, so the loser gets
     `[0,0]` and a 409 in either order.
   - The chain head moving produces a UNIQUE error, and the whole batch rolls back and
     retries. The fork guard is `schema.sql:94-95`.
   - A chained row cannot exist without its topic: the gate needs the row and
     `changes() = 1`. A topic can exist without its row only if `changes()` misbehaves
     (M1).
   - A non-UNIQUE batch error is rethrown. If an ambiguous post-commit failure is retried,
     the dupe check (`topics.ts:221-224`) returns 409, so there is no double opening.
   - `scripts/changes-probe.sql` does not test the premise the gate relies on (M1).
4. **Migration and deploy order: PASS.**
   - 0015 is three ADD COLUMNs and one CREATE INDEX: no rebuild, no `sqlite_sequence`, no
     TEMP table. Test 8 matches it column for column and index for index against
     `schema.sql`.
   - The script stops on a partial catalogue state (`:55-57`), applies 0015 only from a
     clean state, and before deploying verifies all four objects, the shape of `kind` and
     zero non-post rows (`:61-72`).
   - **The old worker `637d46bf` with 0015 applied:** no `SELECT *` on posts, and the only
     posts INSERT names its columns (git grep at `637d46bf`), so it is unaffected.
   - **The new worker without 0015:** `officialFacts` calls `topicCounts`
     (`society.ts:62-68`), so GET / itself returns 500, along with every post read and
     write. The order is load-bearing, and the script enforces it (C2).
   - A push does not deploy: `origin/main` has carried the wave since `1099a461`, live
     `/api/topics` is still 404, and there is no `.github/` workflow.
5. **Non-minting: PASS.**
   - Live `/api/attest`: constitution v5, `template_hash`
     `fa11788d062b0c6d23c54c428c1c9649d263ae3ba704e602e122066926049491`. That equals test 9's
     pin of `computeLiveConstitutionPair().templateHash`, and the test passes.
   - The only edited `doc.ts` string (`:614`, `compositionDoorNote`) sits after
     `FRONT_DOOR_TEMPLATE` closes at `doc.ts:480`.
   - `parameters_hash` cannot move: `governance.ts` is not in the diff.
6. **Served claims: PASS, with L4.**
   - Cap 5, quiet period 14 d, interval 7 d: `TOPICS` at `society.ts:52`.
   - Activity counts visible non-maintainer comments only, never votes: `topics.ts:56`.
   - A closed or moderated topic refuses comments inside the INSERT: `society.ts:1695-1711`.
   - Votes stay allowed: `castVote` has no `topic_state` check.
   - Nothing is deleted: there is no `DELETE FROM posts` in `src/`.
   - Rule 7 (`doc.ts:164-173`) names pinning, bulletins, over-cap comments, moderation and
     ledger recording, so "a power Rule 7 does not name" is true.
   - L-002: the new strings are authored for this wave, and `l002-residue.test.ts` passes.
7. **The wording commit `b9afa3e4`: PASS.**
   - `eligible` reaches `tally()` only through `quorumFromRule`, which is
     `ceil(num*eligible/den)` and non-decreasing in `eligible` (`governance.ts:196-198`,
     `:274-277`). The floor is a constant (`:278`), and `passes()` reads only yes and no
     (`:216-219`). A seat that is eligible but cannot act can therefore only raise the bar,
     and never casts: "never help one pass" holds. The only branch monotone the other way is
     the `cast > eligible` belt (`:1626`), which is unreachable on real paths and in any case
     only blocks.
   - Advisory votes have `{shape:"none"}` (`:187`), so "every quorum" scopes correctly.
   - The three surfaces (`society.ts:1538`, `doc.ts:614`, `discovery.ts:232`) now carry the
     same core phrase and agree with the constitution's quorum paragraph (`doc.ts:383-388`).
   - Red-proof equivalent: the parent strings contained "toward every quorum", and all three
     tests now `doesNotMatch(/toward every quorum/)`.
8. **Scripts: PASS, with M1, L5 and L6.**
   - `open-topic.mjs`: dry run by default (only the exact `--execute` flag sends), the
     secret is read only on `--execute` and is never printed, the title and body are refused
     before any request, and the post-201 shape check can fail (computed at `:90`, exit 1 at
     `:94`).
   - `deploy-standing-topics.ps1` fails fast. Each of its checks can fail when the thing it
     checks is wrong: non-level, typecheck, the suite's exit code and "fail 0", a partial
     catalogue, the shape of `kind`, rows with `kind` other than 'post', 12 GETs that must
     return 200, zero topics, `officialFacts.topics.cap`, the door note, the front page's
     `topics` block, and an unchanged template hash. The gaps are L5.

---

## VERDICT: DEPLOYABLE WITH CONDITIONS

**C1 applies before the first `open-topic.mjs --execute`, not before the migration or the
worker deploy.**
- (i) Make the pre-step readable. After the `--file` run, and before the DROP, run
  `npx wrangler d1 execute commonhold --remote --command "SELECT note FROM probe_log ORDER BY
  id"` and require exactly the three notes. This is engine-level evidence on prod, through
  the import path only.
- (ii) Then do one of the following:
  - Ride `changes()` through `env.DB.batch` against the managed database, requiring
    `[1,1]`, `[0,0]` and the no-leak `[1,0,0]`. This is CODEX's converge condition.
  - Or Ben records that the first seed opening *is* that ride, with the remedy fixed in
    advance: on a 500, do not retry; read GET /api/topics and
    GET /api/events?kind=moderation; if a topic landed without its row, disclose it and
    moderate it away, and open no further topics until the cause is known.

**C2.** Deploy only through `scripts/deploy-standing-topics.ps1`, from `main` level with
origin after `b9afa3e4` is merged and pushed (the script stops otherwise). A bare
`npx wrangler deploy` while 0015 is absent takes GET / down.

## Verified first-hand, and how
- **Suite:** `npm test` in the worktree ran 1166/1166 and `npm run typecheck` exited 0 (clean
  tree, HEAD `b9afa3e4`). By name, `topics-d1`, `doc`, `discovery`, `governance-d1`,
  `secret-literal-guard` and `l002-residue` ran 186/186.
- **Miniflare / workerd D1:** a throwaway test ran 4/4 with the vectors quoted in M1, and was
  then deleted. `git status --porcelain` (including ignored files, excluding
  `node_modules`) is empty apart from this record.
- **Live GETs (2026-09-22):**
  - `/api/attest`: v5 `fa11788d…`; identity 31 rows, `verified`, head `b3632733…`;
    treasury 17; ballots 14.
  - `/api/topics`: 404.
  - `/api/official`: 13 citizens, 5 operator-controlled, 8 independent, `key_lost` 1
    (`boundary-auditor-917`); the old quorum phrase is still live.
  - `/api/stats`: 11 posts.
- **Wrangler 4.118.0 source:** read at the cited `cli.js` lines.
- **git:** `origin/main` = `1099a461` contains `8b5c5e97`; there is no `.github/` in the
  tree; the old worker was grepped at `637d46bf`.
- **Reasoning, not reproduced:** how production D1 executes a batch (M1's residual), and how
  D1's `/query` endpoint executes several statements in one call.
- **Exchange** (read after the findings were formed): GEMINI r1 applied; the CODEX r1
  blocking finding is fixed in `a0e50468` and was reproduced here on the workerd binding;
  CODEX r2 holds a POSITION (the probe is not the Worker path), which I agree with and
  sharpen: the `--file --remote` path cannot display the result at all.
