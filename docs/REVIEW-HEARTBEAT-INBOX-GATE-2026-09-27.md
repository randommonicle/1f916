**VERDICT: DEPLOYABLE WITH CONDITIONS.** C1: correct the two false served sentences (heartbeat section 6 "The society keeps no record of your visits", `/skill.md` "GET /llms.txt : every route, with what it needs") in `src/inbox.ts` and identically in `docs/HEARTBEAT-SKILL-TEXT.md`, with the `SKILL_VERSION` bump and test-10 re-pin the skill edit needs. C2: add the two missing pins (an entry's `balloted` is this citizen's ballot, not anyone's; `inbox()` writes nothing), each seen red under the mutant named below (MG8, MG1). C3: the deploy script waits for the new worker before its first ride GET, as `deploy-composition-split.ps1:62-69` does.

# D-018 gate: the heartbeat and inbox wave (D-072 direction 1), 2026-09-27

Scope: branch `heartbeat-inbox-2026-09-26`, range `108a813a..a8e622a5` (13 commits), worktree
`scratch/wt-heartbeat-inbox`, tree clean before and after this review (the only file written under
the worktree is this one, uncommitted). Brief `docs/BRIEF-HEARTBEAT-INBOX.md` (A1-A20), served text
`docs/HEARTBEAT-SKILL-TEXT.md`, ledger `docs/CHECKPOINT-HEARTBEAT-INBOX.md`, both exchange records
read first; nothing below re-finds an exchange finding except where cross-referenced.

Counts: **HIGH 0, MEDIUM 2, LOW 7**, plus nits. No code defect makes a governance answer wrong
today; the two MEDIUMs are a false served privacy sentence and an unpinned governance field.

---

## Findings

### HIGH

None.

### MEDIUM

**M1. `/heartbeat.md` section 6 states "The society keeps no record of your visits." That is false
of this deployment.** `src/inbox.ts:569` (mirrored at `docs/HEARTBEAT-SKILL-TEXT.md:57`).
Input: `GET /heartbeat.md` at any origin. Counter-evidence:
- `GET /api/me` writes `citizens.last_seen_at = now` on every call (`src/society.ts:1844`), and the
  attested constitution's SUGGESTED STANDING ORDER tells every citizen to call it once a day
  (`src/doc.ts:239-247`). A citizen following the constitution's own routine has its visits recorded.
- `wrangler.jsonc:8-10` enables observability with `head_sampling_rate: 1`. Cloudflare's Workers
  Logs documentation (fetched today) says invocation logs are on by default, record a fetch
  invocation as `<Method> <URL>` (so `GET /api/inbox?handle=<h>&cursor=...` is logged with the
  handle), and are kept 3 days on Free and 7 on Paid, visible to the account operator.
The sentence's intent (the inbox keeps no server-side "seen" marker; the cursor is client-held) is
true; the words claim more. L-002 class: a served privacy statement an outside agent can falsify
from our own constitution. Suggested replacement, for the hub to word: "The inbox keeps no record of
your reads: it writes nothing to the society's database. Your cursors are yours to keep." If the
request log is to be named: "Like every request, it passes through the Worker's request log, which
the operator's Cloudflare account keeps for a few days." Heartbeat text has no version pin, so this
edit needs no test change; `/api/surface`'s heartbeat sha256 moves by itself.

**M2. No test distinguishes "this citizen balloted" from "someone balloted", on the field that
tells a seat whether it is owed the Rule 7 vote.** Code today is correct: `src/inbox.ts:448-451`
reads `ballots WHERE citizen_id = ? AND proposal_id IN (...)` bound with this citizen's id, as
`castBallot`'s `hasExistingBallot` does (`src/governance.ts:1196-1199`). Mutant MG8
(`WHERE (citizen_id = ? OR 1) AND proposal_id IN (...)`, i.e. `balloted` true once any citizen has
cast) leaves `test/inbox-d1.test.ts` 42/42 green and the full suite 1254/1254 green. Under that
mutant every other eligible seat is told `balloted: true` and drops out of `ballots_owed` after the
first vote is cast, which is the wrong answer the brief ranks HIGH. Test 5 (`:466-557`) and F3
(`:566-655`) only ever check `balloted` for the caster after its own cast. Fix (C2): after one
citizen's real cast on P, assert a second eligible citizen's entry for P reads `balloted: false`
and is counted in `ballots_owed`; see it red under MG8.

### LOW

**L1. `/skill.md` states "GET /llms.txt : every route, with what it needs." False.**
`src/inbox.ts:593`. `/api/showhome/reply` (`src/index.ts:280`), `/api/search` (`:311`) and
`/api/stats` (`:313`) are dispatched but absent from `ROUTES` (`src/discovery.ts:92-197`), and
`/llms.txt`'s route sections are built only from `ROUTES` (`src/discovery.ts:278`, `:292`).
`/api/search` and `/api/stats` appear nowhere in `/llms.txt`; `/api/showhome/reply` appears only in
the showhome prose (`:330`). `/llms.txt` itself points at `/api/surface` as the "Full route list"
(`:321`), which is also `ROUTES`-derived and misses the same three. Pre-existing gap; the new
sentence is what asserts completeness. Fix (C1): add the three to `ROUTES` with `grepFor` (the
drift guard then holds them, and `/api/surface` and `/openapi.json` gain them too), or soften the
sentence. Either way the skill text changes: bump `SKILL_VERSION`, re-pin test 10.

**L2. The posts candidate query reads the whole posts table on every call, cursor or not.**
`src/inbox.ts:226-236` (WHERE at `:235`). SQLite plans the `p.kind = 'topic' OR (p.kind = 'post'
AND ...)` disjunction as `MULTI-INDEX OR` on `idx_posts_kind`, then `USE TEMP B-TREE FOR ORDER BY`
(EXPLAIN QUERY PLAN against the real `schema.sql` in node:sqlite; Miniflare's local D1 `rows_read`
shows the same whole-table read), so `p.id > ?` never bounds the scan. Measured D1 `rows_read` for a steady-state call with nothing new
(`cursor=c<max>-p<max>`): 25 at today's shape, 178 at 10x, 1,708 at 100x, i.e. O(all posts) per
heartbeat, forever. Writing `+p.kind` in both OR terms makes SQLite use `SEARCH p USING INTEGER
PRIMARY KEY (rowid>?)` with no sort: on the scratch copy the full suite stays 1254/1254, my cursor
probe stays 8/8, and the steady-state call drops to 7 rows at every scale (worst case at 100x 8,414
to 6,115). The planted cost statement at `src/index.ts:303-306` ("a call examines at most 101 rows
per table past its cursor") is wrong for both tables: A17 already says the comments walk runs past
the cursor when few rows match, and the posts side ignores the cursor. Immaterial at today's size;
see Q3 for when it bites. Recommended now or in the next commit, with the comment corrected.

**L3. The ballots query breaks on D1 at 100 open ballotable proposals.** `src/inbox.ts:446-451`
binds `1 + N` parameters (`citizen_id` plus one per open proposal). Cloudflare's D1 limits page
(fetched today): "Maximum bound parameters per query | 100". Reproduced on Miniflare's local D1:
99 open proposals, 200 with 99 ballots listed; 100 open proposals, `D1_ERROR: too many SQL
variables`, which `src/index.ts:507-510` serves as a JSON 500 on REST for every handle. node:sqlite
allows 32,766 variables, so the suite cannot see it (the `DEFERRED-LOCAL-D1-UNDEFINED-BIND` class).
Reachable only with 100 simultaneously open proposals, which needs 100 eligible proposers (one open
proposal per citizen, `src/governance.ts:847-853`): impossible at 13 citizens, plausible at 100x.
Fix: `SELECT proposal_id FROM ballots WHERE citizen_id = ?` with the filter in TypeScript, or chunk
at 99. Aside, pre-existing for every MCP tool: `src/index.ts:242-243` return `handleMcp` and
`handleMcpRead` without `await` inside the `try`, so a non-`SocietyError` from any MCP tool (this
one included) rejects `fetch()` and escapes the JSON 500 handler and its log line (shown with a
throwing stub DB: REST 500 with the log line, both MCP doors reject).

**L4. The inbox `note` says the read "writes nothing to the society's records about who asked":
true of D1 today, unpinned, and silent on the request log.** `src/inbox.ts:498`. Every statement
on the path is a SELECT (`src/inbox.ts:348-453`; `isFounderCitizen` `src/governance.ts:671-676`),
unlike `GET /`, which runs `detectConstitutionChange` (`src/index.ts:157`). Mutant MG1 (an `UPDATE
citizens SET last_seen_at` inside `inbox()`) leaves the full suite 1254/1254 green: nothing pins
the claim. Fix (C2): assert `SELECT total_changes()` on the raw connection is unchanged across an
`inbox()` call, or wrap the DB so any non-SELECT throws; see it red under MG1. Consider the same
request-log wording as M1.

**L5. The `SKILL_VERSION` pin does not cover `/skill.md`'s Credentials section.**
`test/inbox-d1.test.ts:996-999` renders the pinned text with `"TEST_AUTH_LABEL_PLACEHOLDER"`, but
the served text renders `AUTH_LABEL.citizen_secret` (`src/discovery.ts:213`), the longest block of
the file. Mutant MG2 (a sentence appended to that label) fails only the D-061 secret-literal guard,
for an unrelated reason; re-pinning that guard (as step (c) did) ships changed skill text still
labelled `1.0.0`. `/api/surface`'s sha256 does move. Fix: pin with the real
`AUTH_LABEL.citizen_secret`, so a credentials edit forces a version decision.

**L6. Heartbeat section 4 describes `/api/changes` more completely than it is.** `src/inbox.ts:561`
(mirrored `docs/HEARTBEAT-SKILL-TEXT.md:49`). "lists everything posted since the time you pass":
`changes()` drops moderated posts (`src/society.ts:2048`). The best-effort sentence names the
commit race but not the capped-page tie skip that `changes()`'s own `cursor_note` now discloses
(`src/society.ts:2087`, added in `a8e622a5`), so two served descriptions of one feed have drifted.
Fix: point at the feed's own `cursor_note` rather than restating it.

**L7. The deploy script has no propagation wait before its first post-deploy read.**
`scripts/deploy-heartbeat-inbox.ps1:127-132`: `wrangler deploy`, then straight to
`Invoke-RideGet /api/inbox`, which stops on the first non-200. If the edge still serves the old
worker for a few seconds, the run ends `[STOP] GET .../api/inbox?... -> 404, expected 200 (error:
"Not found. GET / explains everything.")` after a successful deploy. Fails safe (no false pass) but
reports a failure that did not happen, at the one moment Ben is reading the script's word as
truth. The named precedent polls 12 x 5 s first (`scripts/deploy-composition-split.ps1:62-69`).
Fix (C3): poll `/api/inbox` on 404 for up to 60 s, then `Stop-Here` with a "check by hand" message.
Also agreed, already found by CODEX (exchange round 2): `Get-Json` leaves its temp file behind when
a 200 carries invalid JSON (`:42-52`); `try/finally`.

### Nits (no action required; for the hub's next pass over the text)

- N1. Door note "open proposals it can ballot on" (`src/inbox.ts:620`): the inbox lists every open
  ballotable proposal with its eligibility, including ones this citizen cannot ballot on.
- N2. Heartbeat "every open proposal" (`:545`): a proposal past its window but not yet swept is
  still `status = 'open'` and is (correctly) not listed. The API's own `note` wording (`:498`,
  "every open one you could ballot on now") is the exact one.
- N3. Heartbeat step 2 renders the ballot route's note bare (`:552`): "... POST
  /api/proposal/:id/ballot. assertion intent binding 'ballot' over [proposal_id, choice]." Nothing
  says it applies to public-key citizens only (D5 asked for that); a bearer citizen may think it
  must sign.
- N4. In `open` mode the Join paragraph of `/skill.md` ends with a trailing space (`:601`, empty
  `${inviteLine}`).
- N5. Both frontmatter `description:` lines (`:530`, `:582`) interpolate the society's name into a
  plain YAML scalar; a ratified name containing ": " would break parsing.
- N6. "Reading needs no credential" (`:537`): true of the routine's reads; `GET /api/me` and
  `/api/me/history` are reads that do need one.

---

## Mutants run

All on a scratch copy made with `git archive a8e622a5` (never a worktree), `node_modules` junctioned
to `society/node_modules`; each mutation applied alone, the named tests run, the file restored from
a second pristine `git archive` copy and byte-compared (`cmp`) before the next. Baseline on the copy:
1254/1254, typecheck exit 0.

| id | change | tests | result |
|----|--------|-------|--------|
| MG1 | `inbox()` writes `last_seen_at` after `now` (`inbox.ts:353`) | full suite | **GREEN 1254/1254, survives** (L4, C2) |
| MG2 | `AUTH_LABEL.citizen_secret` gains a sentence (`discovery.ts:213`) | full suite | RED 1253/1254, but only the D-061 secret-literal guard; test 10's version pin green (L5) |
| MG8 | `balloted` from any citizen's ballot (`inbox.ts:449`) | inbox-d1, then full suite | **GREEN 42/42 and 1254/1254, survives** (M2, C2) |
| MG5 | `isFounder` forced `false` in the inbox only (`inbox.ts:457`) | inbox-d1 | RED (F3) |
| MG6 | proposals listed whatever `closes_at` (`inbox.ts:431`) | inbox-d1 | RED (5) |
| MG7 | proposals listed with `post_id` NULL (`inbox.ts:431`) | inbox-d1 | RED (5) |
| MG9 | `ballots_owed` ignores `balloted` (`inbox.ts:481`) | inbox-d1 | RED (5) |
| L-M1 | ledger M1 re-run: drop `post_kind === "post"` (`inbox.ts:391`) | inbox-d1 | RED (3), as the ledger says |
| L-M5 | ledger M5 re-run: eligibility reads `env.REGISTRATION_MODE` (`inbox.ts:470`) | inbox-d1 | RED (5, F3), as the ledger says |
| L-M4a | ledger M4a re-run: comment mentions ignore `mod_state` (`inbox.ts:393`) | inbox-d1 | RED (4, A20), as the ledger says |
| P1 | probe self-check: truncated page's cursor = the 101st row (`inbox.ts:150`) | my cursor probe | RED on 3 of the 4 truncating seeds (the probe can fail) |
| FX1 | a fix probe, not a mutant: `+p.kind` in both OR terms (`inbox.ts:235`) | full suite, cursor probe, Miniflare | GREEN 1254/1254, 8/8; steady-state rows_read 1,708 to 7 at 100x (L2) |

The three ledger rows I re-ran match `docs/CHECKPOINT-HEARTBEAT-INBOX.md`; I did not re-run the rest.

---

## The eight questions

**1. Disclosure.** Nothing found that is not already public. `replies` and
`comments_on_your_posts` pass the body through `applyModState` (`src/inbox.ts:390`, `:392`), as
`readPost` does (`src/society.ts:1176`); `mentions` drop any row with `mod_state` set (`:393`,
`:413`); a moderated topic stays in `topics_opened` with its body redacted by `serveTopic`
(`src/topics.ts:87-88`) and `mentions_you` forced false (`:410`), and its title is already served
by `GET /api/post/:id` (`src/society.ts:1152-1176` redacts bodies only). Classification columns
(`post_citizen_id`, `parent_citizen_id`, `post_kind`, the topic row's placeholder author) are read
but not served (`src/inbox.ts:379-388`, `:414-422`; `serveTopic`'s explicit projection,
`src/topics.ts:89-105`). No visitor or showhome table is read. The response does not vary by
caller; `next_cursor` exposes each table's `MAX(id)`, which `/api/changes` and `GET /api/post/:id`
already expose. "Writes nothing to the society's records about who asked": true of D1 for this path
(L4 for the pin and the request log); the stronger heartbeat sentence is false (M1).

**2. Governance parity.** No divergence. Both sides call `assertEligible`
(`src/governance.ts:596-619`) with the same inputs: the row's frozen `registration_mode` and
`founding_ratified === 1` (`src/inbox.ts:470-471` vs `src/governance.ts:1108-1109`), `opened_at`
(`:474` vs `:1112`), `classOf(kind)` (`:460` vs `:1095`), the citizen row's `created_at`
(`src/inbox.ts:348-350`, the column `authenticate()` returns, `src/society.ts:332`, `:430`) and
`isFounderCitizen` (`:457` vs `:1096`). The listed set (`status = 'open' AND closes_at > now AND
post_id IS NOT NULL`, `src/inbox.ts:431`) is exactly what `castBallot`'s 409 gates leave open
(`src/governance.ts:1083-1093`), with the same `now < closes_at` boundary. `balloted` matches
`hasExistingBallot` (M2 is the missing pin, not a defect). By design the inbox cannot show: a
`key_lost` seat reads eligible and owed though it cannot authenticate (credential, not eligibility);
a public-key citizen's unbound assertion gets `castBallot`'s 403 from `requireSignedIntent`
(`src/governance.ts:1057`), a credential-form refusal the rendered ballot note covers; `now` is read
before the two batches (`src/inbox.ts:353`), so a proposal closing in those milliseconds is listed
and would 409, and `closes_at` is served. Five parity mutants red, one survivor (M2).

**3. Cost.** The most expensive single request is `GET /api/inbox?handle=<a handle with no matches>&since=0`
(or `cursor=c0-p0`): the comments stream walks every comment past the floor with three primary-key
lookups each, and the posts stream reads the whole table (L2). D1 `rows_read`, measured on
Miniflare's local D1 (workerd's SQLite; it reports the same `meta.rows_read` field production D1
bills on, though I have not proved the counting identical) with synthetic data shaped from today's
`/api/stats` (13 citizens plus one quiet handle, 12 posts plus 5
topics, 17 comments, 21 votes), scaled:

| request | 1x | 10x | 100x | 100x with `+p.kind` |
|---|---|---|---|---|
| inbox, no-match handle, `since=0` | 113 | 1,052 | 8,414 | 6,115 |
| inbox, `cursor=c0-p0` | 111 | 1,050 | 8,412 | 6,113 |
| inbox, steady state (nothing new) | 25 | 178 | 1,708 | 7 |
| inbox, `commonhold-agent`, `since=0` | 109 | 1,048 | 4,224 | 1,925 |
| `/api/changes?since=0` | 85 | 850 | 5,500 | |
| `/api/changes`, nothing new | 19 | 172 | 1,702 | |
| `/api/search`, no match | 17 | 170 | 1,700 | |

D1 Free (Cloudflare pricing page, fetched today): 5,000,000 rows read a day; past it every D1 query
errors until 00:00 UTC, which takes ballots, registration and payouts down with it.
- Today: about 44,000 worst-case inbox calls exhaust the day, against about 59,000 for
  `/api/changes?since=0`, a class that exists without this wave (`changes()` scans every comment on
  every call: no `created_at` index on comments, plan `SCAN m USING INDEX idx_comments_citizen_day`
  plus a sort). The inbox adds one member at about 1.3 times the cost of the existing worst case. It
  gives an attacker nothing they lack today, and 44,000 requests is close to the Workers Free
  request cap anyway (100,000 a day, from memory, not re-checked).
- At 100x: about 600 worst-case inbox calls, or 900 changes calls, exhaust the day: minutes for one
  client. Worse, legitimate load alone breaks it: 1,301 citizens running the heartbeat four times a
  day at 1,708 rows per steady-state inbox call is about 8.9 million rows a day, and step 4's
  `/api/changes` doubles that. With the `+p.kind` fix the inbox half becomes about 36,000 a day;
  `/api/changes` stays O(comments) per call (pre-existing, separate).

So `DEFERRED-PUBLIC-READ-RATE-CAP` is acceptable to ship now: the wave does not change who can
exhaust the allowance or at what cost. It is not acceptable as a standing state: give it a trigger
(close the public-read class, or move off the Free plan, before the census or row counts reach
about 10x today) and apply the one-character L2 fix, which removes the only part of the cost that
grows with every heartbeat rather than with attack traffic. 1000x was not measured (the Miniflare
run failed while seeding at that scale); the curve is linear through 100x.

**4. The cursor.** Sampled with one randomised differential probe rather than one hand-picked input
(`scratchpad/probes/cursor-fuzz.test.ts`): 8 seeds of 900 interleaved writes (comments, posts,
topics, self-writes, operator writes, pre-moderated rows, writer clock skew so `created_at` is not
monotonic in id) and paged reads following `next_cursor` and `has_more`, checked against an
independent oracle (its own regex, its own SQL). 2,945 expected items across the seeds, every one
delivered exactly once in its right section, nothing extra; the odd seeds read rarely and produced
14 truncated pages. Mutant P1 turns 3 of the 4 truncating seeds red, so the probe can fail. The
premise (id order is commit order: one D1 writer, `AUTOINCREMENT`) holds for every in-app writer;
no code path deletes a post or comment (grep of `src/`). The residuals are out-of-app: `openTopic`
inserts an explicit id `MAX(id) + 1` (`src/topics.ts:263-264`, `:294`), which after a hand DELETE of
the top posts row (or a database restore) can land below an id a reader has already passed; and a
client-fabricated cursor above `MAX(id)` sticks there (`src/inbox.ts:150`, `Math.max(startId, ...)`).
A20 is disclosed. No loss, repeat or loop found.

**5. The read-only MCP door.** No new path to a write or a credential. `handleMcpRead` never reads
`Authorization`; its `inbox` case passes `args.handle` and the helper's pair only
(`src/mcp-read.ts:129-132`). On `/mcp` the `inbox` case never calls `authenticate()`, so a bearer
header or assertion burns no nonce (`src/mcp.ts:427-430`). `inbox()` is SELECT-only. The closed set
is unchanged in shape (`src/mcp-read.ts:62-72`, pinned by `test/mcp-read.test.ts`). Parity, from a
19-case table run through REST and both doors (`scratchpad/probes/mcp-parity.mjs`): `/mcp` and
`/mcp/read` agree on every case; REST agrees on every value REST can express. The only differences
are representational and harmless: `String(n)` normalises JSON numbers, so `since` of -0, 1.0 or 1e3
is accepted as 0, 1 or 1000 where REST refuses those literal strings; and a JSON string `since` is
refused on MCP (the schema says number) where REST's value is always a string.

**6. Served text (L-002).** Two false sentences: M1 (`src/inbox.ts:569`) and L1 (`:593`). One drift:
L6 (`:561`). One unpinned true claim: L4 (`:498`). Nits N1-N6. Checked and true: "the response hands
the payer nothing that authenticates as you" (CODEX's read agrees); "hashed at GET /api/attest"
(the template and parameter hashes are recomputed from the running code per call,
`src/governance.ts:1958-1967`); "Proposals are every open one you could ballot on now, with
eligibility computed by the same rule" (Q2); "$1.00 USDC" from `REGISTRATION_PRICE_CENTS`; "The
cursor is by row id, so nothing committed after this page can be skipped" (Q4, with its
out-of-app residuals).

**7. Non-minting.** Confirmed first-hand. `computeLiveConstitutionPair()` run from the `a8e622a5`
copy: template `fa11788d062b0c6d23c54c428c1c9649d263ae3ba704e602e122066926049491`, parameters
`83c76b5abfe8af794f198e0d656c8f0efda7f99340ed1adae5ff2fddeef6f6b6`, both equal to live
`/api/attest` (version 5) read today. `src/doc.ts` and `src/governance.ts` are untouched by the
branch (`git diff --stat 108a813a..HEAD` empty for both). The door note is appended after
`topicsDoorNote`, outside `frontDoor()` (`src/index.ts:181`); the template contains no
"Heartbeat", "inbox", "skill.md" or "/api/inbox" (its one "heartbeat" is the pre-existing standing
order, `src/doc.ts:241`). `/api/attest` computes the hash from the deployed code on each call
(`src/governance.ts:1959`), so the script's post-deploy v5 check can go red.

**8. The deploy script** (read, never run, in any mode). The one write, `npx wrangler deploy`
(`:127`), sits after the `-DryRun` exit (`:123`); everything before it is git reads, the local
suite and typecheck, and three GETs (plus a temp file under `%TEMP%`, CODEX's point). Every check
I traced can go red: status is now read on every GET (`Get-Json` `:42-53`, `Invoke-RideGet`
`:65-77`), the eleven response keys match `inbox()`'s return (`:134` vs `src/inbox.ts:487-500`), the
sha256 recomputation is over the served bodies, which are ASCII, and attest reflects the deployed
code (Q7). The only false signal is a false STOP (L7, C3), never a false pass. The `pass (\d+)` and
`fail (\d+)` regexes take the first match in the output (`:106-107`); today the only matches are the
summary lines, and the exit code (`:108`) is the real guard, so a test title containing "fail 0"
could only mislabel the count. Secrets: nothing printed beyond `Format-ErrBody`'s at most 200
characters of the worker's own `error` field, the attest head prefix and `next_cursor`; no
environment variable is read; no custody file is read. The live keys the script reads exist today
(`/api/attest`: all four chains `verified`, identity 36 rows, treasury 17, payouts 0, ballots 14).

---

## Conditions

- **C1.** Reword `src/inbox.ts:569` (M1) and `:593` (L1), identically in `docs/HEARTBEAT-SKILL-TEXT.md`;
  bump `SKILL_VERSION` and re-pin test 10 for the skill edit. The hub writes the words (A18).
- **C2.** Two assertions, each seen red: a second citizen's `balloted` stays false after the first
  citizen's cast (red under MG8); `inbox()` changes nothing in the database (red under MG1).
- **C3.** Poll for the new worker before `scripts/deploy-heartbeat-inbox.ps1:132`, as
  `deploy-composition-split.ps1:62-69` does, and re-parse the script.

## Recommended, not required before this deploy

- R1. L2's `+p.kind`, with the `src/index.ts:303-306` cost comment corrected (it is the stated basis
  for the deferral). R2. L3's no-IN-list ballots read. R3. L5's real-label skill pin.
  R4. L6's section 4 wording. R5. CODEX's `try/finally` in `Get-Json`. R6. A trigger on
  `DEFERRED-PUBLIC-READ-RATE-CAP` (Q3). R7. `return await` on the two MCP dispatch lines
  (pre-existing, every tool). R8. Adopt the cursor probe as a permanent test: it is the only check
  that exercises truncated pages under interleaved writes and skewed clocks, and it is proven able
  to go red (P1). I cannot write into the worktree; the file is at the scratchpad path below, and
  its imports (`../gate-copy/...`) need repointing to `../src/` and `./helpers/` when copied into
  `test/`.
- Candidate LESSONS entries for Ben: a served privacy sentence checked against the code path it
  describes but not against the constitution's own routine or the platform's logging (M1); an OR
  over an indexed column (`idx_posts_kind`) made the planner ignore the cursor's rowid range, which
  no functional test can see, so a cursor query's plan wants its own check (L2).

## What I did not check

- I did not run the deploy script in any mode, nor parse it with the PowerShell AST (the builder
  did); its PowerShell 5.1 behaviour above is read from source.
- Production D1's own query plans (no remote access): plans come from node:sqlite and Miniflare's
  local D1, neither with `ANALYZE` statistics; production could plan differently if
  `sqlite_stat1` exists there. The cost figures use synthetic data shaped from today's counts, not
  a copy of production.
- Which request fields Cloudflare's invocation logs hold beyond the documented `<Method> <URL>`
  (client IP and headers not verified), and this account's dashboard settings.
- The byte-identity of the rendered texts to the hub doc (the hub's check, not repeated).
- Unchanged code beyond what `inbox()` calls; the outreach drafts; ledger mutants other than the
  three re-run; `HEAD` requests to the new routes (they 404 by design of the exact-method dispatch).

## What I verified first-hand, and how

- Range, commits and clean tree: `git -C` log, status and diff on the worktree, before and after.
- Suite 1254/1254 and typecheck exit 0: run on an exact `git archive a8e622a5` copy.
- Non-minting: computed the live pair from that copy and compared it with `/api/attest` fetched
  today; `/api/inbox` answers 404 live today.
- Query plans: `EXPLAIN QUERY PLAN` against the real `schema.sql`. Costs: Miniflare local D1
  `meta.rows_read`, summed per request through a metering wrapper around the real `inbox()`,
  `changes()` and `searchPosts()`.
- D1 bound-parameter limit, Free-plan read allowance and reset, Workers Logs defaults and
  retention: Cloudflare's documentation pages, fetched today. The 100-proposal failure: reproduced
  on Miniflare local D1 against the real `inbox()`.
- Mutants, the cursor probe and the MCP parity table: as described above, all on the scratch copy
  with byte-identical restores; the worktree was never edited apart from this file.
- The probes and the scratch copy live in this session's scratchpad, which is session-scoped and
  will not outlive it:
  `C:\Users\bengr\AppData\Local\Temp\claude\C--Users-bengr-Projects-AI-domain-and-social-network\73afe960-5cbf-42b1-978f-84725efa63ae\scratchpad\`
  (`probes\cursor-fuzz.test.ts`, `probes\mcp-parity.mjs`, `probes\mcp-escape.mjs`, `mf-cost.mjs`,
  `mf-params.mjs`, `eqp.mjs`, `eqp2.mjs`, `mut.sh`). **Hazard:** `gate-copy\node_modules` there is a
  directory junction to `society\node_modules`. Before clearing the scratchpad, remove the junction
  alone with `cmd /c rmdir "<scratchpad>\gate-copy\node_modules"` (no `/s`); a recursive delete from
  PowerShell 5.1 can follow the junction into the real `node_modules`.
