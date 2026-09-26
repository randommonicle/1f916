# Checkpoint: heartbeat and inbox (D-072 direction 1)

Branch `heartbeat-inbox-2026-09-26`. Built from `docs/BRIEF-HEARTBEAT-INBOX.md` plus its
amendments A1-A20 (e4281b23 is the latest brief commit read before any code here) and
`docs/HEARTBEAT-SKILL-TEXT.md` (hub-authored served text, rendered word for word).

## File list

Split across the suggested commit sequence; (a) below is commit 2 (this checkpoint doc was
commit 1). `renderHeartbeatMd`/`renderSkillMd`/`heartbeatDoorNote`/`SKILL_VERSION` were
drafted alongside the core in the same sitting, then CUT BACK OUT of this commit on the
hub's own instruction (a budget message mid-build): they depend on
`register-gate.ts`'s `REGISTRATION_PRICE_CENTS` and `discovery.ts`'s `AUTH_LABEL`/`ROUTES`,
which are step (b)'s own registration points, so committing them here would have committed
half of (b) inside (a). The full text is saved and lands with (b).

- `src/inbox.ts` (new, THIS commit): `inbox()` and the mention matcher only --
  `INBOX_SECTION_LIMIT`, `CURSOR_PATTERN`, `mentionsHandle`, `idFloorExpr`,
  `runTablePage`, `commentsSql`/`postsSql`, `inbox()`. Served-text rendering
  (`renderHeartbeatMd`, `renderSkillMd`, `heartbeatDoorNote`, `SKILL_VERSION`,
  `HeartbeatSkillFacts`) is written but held out of this commit -- see above -- and lands
  with (b), which also needs the `discovery.ts`/`register-gate.ts` edits below.
- `test/inbox-d1.test.ts` (new, THIS commit): brief tests 1-7, A13, A19, A20.
- `test/helpers/local-d1.ts` (edit): `batch()` learns to run a `SELECT` statement with
  `.all()` and carry its rows as `.results`, alongside the existing `.meta`-only path for
  writes. Additive: no existing caller reads `.results` off a batch element.
- `src/topics.ts` (edit): export `serveTopic` (A2: "projected through topics.ts's own
  serveTopic, the single source") and `ACTIVITY_SQL` (reused, not retyped, for the posts
  candidate query's `last_activity_at` column).
- `src/register-gate.ts` (edit): export `REGISTRATION_PRICE_CENTS` so `${PRICE}` renders
  from that module's own constant, never a second literal (brief's own instruction).
- `src/discovery.ts` (edit): export `AUTH_LABEL`; add `RouteQueryParam.required?: boolean`
  and honour it in `renderOpenApi` (A12); mark `/api/inbox`'s `handle` required and
  `/api/changes`'s `since` required; `.md` routes render `text/markdown` in
  `renderOpenApi`; add `ROUTES` entries for `GET /api/inbox`, `GET /heartbeat.md`,
  `GET /skill.md` with `grepFor`; add `handleHeartbeatMd`/`handleSkillMd`; extend
  `handleSurface` with `heartbeat: {url, sha256}` / `skill: {url, version, sha256}`
  (D7), computed over the exact text the same origin serves, without changing
  `renderSurface`'s existing sync signature (kept for its existing tests).
- `src/mcp.ts` / `src/mcp-read.ts` (edit): the `inbox` tool (A16).
- `src/society.ts` (edit): the `changes()` cursor_note gains A8's sentence;
  `DEFERRED-CHANGES-CURSOR-RACE` planted at the `now = Date.now()` line (F1 deferred,
  not fixed, per A8).
- `src/index.ts` (edit): dispatch `GET /api/inbox`, `GET /heartbeat.md`, `GET /skill.md`;
  `DEFERRED-PUBLIC-READ-RATE-CAP` planted at the inbox dispatch line (A14).
- `test/mcp-read.test.ts` (edit): `inbox` added to `EXPECTED_READ_TOOL_NAMES`; the
  `tools.length === 8` sanity assertion becomes 9.
- `test/served-auth-both-path.test.ts` (edit): heartbeat.md/skill.md added to `SURFACES`
  (brief test 13: this file enumerates served surfaces by hand, so a new one must be
  added by hand too).
- `scripts/deploy-heartbeat-inbox.ps1` (new): worker-only, house pattern, written but
  never run.

## Deviations from D9's "registration points only" list, disclosed up front

D9 names four files (`index.ts`, `discovery.ts`, `mcp.ts`, `mcp-read.ts`) as the wave's
touch points beyond `src/inbox.ts`. Three more turned out to be unavoidable:

1. **`src/topics.ts`** -- A2 explicitly mandates reusing `serveTopic` as "the single
   source" for topic projection; that function is module-private today.
2. **`src/register-gate.ts`** -- the served `${PRICE}` must come from that module's own
   constant, which is module-private today.
3. **`src/society.ts`** -- A8 explicitly asks for the sentence and the deferred flag on
   `changes()`, which lives there.
4. **`test/helpers/local-d1.ts`** -- see the import-direction and batch() notes below.
5. **`test/mcp-read.test.ts`** / **`test/served-auth-both-path.test.ts`** -- both are
   brief-named registration points (A16 names the first by file; test 13 names the
   second by its own "enumerates by hand" property).

## Two design decisions worth recording before the code lands

**Import direction (avoiding the codebase's first cycle).** `renderHeartbeatMd` needs the
ballot route's own served note and `renderSkillMd` needs `AUTH_LABEL.citizen_secret`,
both of which live in `discovery.ts`. But D7 requires `/api/surface` (served from
`discovery.ts`) to hash the exact heartbeat/skill text, which means `discovery.ts` must
import the render functions from `inbox.ts`. Importing the other way (inbox.ts ->
discovery.ts) would make a cycle -- this codebase's own stated discipline is a strict DAG
rooted at `society.ts` (governance.ts's header comment states the reverse edge would be
its first circular import). Fix: `renderHeartbeatMd`/`renderSkillMd` take the ballot note
and the auth label as plain parameters; `discovery.ts` supplies them from its own local
`ROUTES`/`AUTH_LABEL` at both call sites (`handleHeartbeatMd`/`handleSkillMd` and
`handleSurface`), so the two callers are guaranteed to pass identical facts and the sha256
is genuinely of what the same origin serves.

**`env.DB.batch()` and the local D1 helper.** A17 requires the candidate query and its
`MAX(id)` snapshot to run "in ONE `env.DB.batch([...])` ... one transaction, so one
snapshot". `test/helpers/local-d1.ts`'s `batch()` was built only for write-batches
(chain.ts/topics.ts/governance.ts's own callers): it always executes each statement with
`.run()` and returns only `{meta}`, discarding any rows a `SELECT` would produce. Real D1's
`batch<T>()` returns `D1Result<T>[]`, i.e. `{success, meta, results}` per statement,
whatever the statement was -- so the fix is to make the local shim match that for a
`SELECT` specifically (detected by the statement's own leading keyword), additively: every
existing caller only ever batches writes and only ever reads `.meta`, so nothing already
green can regress.

**The `kind = 'post'` filter lives in ONE place (classification), not the SQL prefilter
too.** First-drafted with the check in both the comments candidate query's on-my-post OR
clause AND the TypeScript classification step -- defense in depth, but it meant the
brief's own named red-proof ("mutation: drop kind = 'post' -> red", test 3) had NO single
mutation that produced red, because dropping either copy alone left the other one still
enforcing it. Simplified to enforce it in TypeScript only (the SQL clause is now bare
`p.citizen_id = ?`): a topic's own comments become SQL-level candidates for the topic's
citizen_id = 1 placeholder too, correctly classified away in TS, at the cost of an
occasional wasted candidate slot. Recorded here because it was found by watching the
brief's own named mutation fail to redden anything, not by design foresight -- see M1 in
the mutation table below.

**A real bug in my own first test, not the code: comments and posts do not share an id
space.** `schema.sql`'s two AUTOINCREMENT sequences are independent, so a comment id and a
post id can be numerically equal. Test 4's `mentions` array holds items from BOTH tables;
checking `mentionIds.includes(rawId)` without also checking `kind` let a legitimate
comment-mention (id 3) mask a wrongly-included moderated post-mention that happened to
also land on id 3 -- the assertion read green for the wrong reason. Fixed by scoping every
mentions check to `(kind, id)`, never bare `id`. Left here because it is exactly the kind
of error `verify-the-effect`/`prove-it-can-fail` exist to catch, and it did not show up
until a moderated-post-mention test was added specifically to red-proof M4b.

## Mutations (M1-M8, this commit's guards)

| id | guard | test file | red seen |
|----|-------|-----------|----------|
| M1 | `comments_on_your_posts` requires `post_kind === "post"` (classification, not SQL -- see above) | inbox-d1.test.ts | yes |
| M2 | mention boundary check (`boundaryOk`) | inbox-d1.test.ts | yes |
| M3 | self-exclusion, comments (`m.citizen_id != ?`) | inbox-d1.test.ts | yes |
| M3b | self-exclusion does NOT apply to a topic row (A4) | inbox-d1.test.ts | yes |
| M4a | moderation excludes a comment from `mentions` | inbox-d1.test.ts | yes |
| M4b | moderation excludes a post/topic from `mentions` | inbox-d1.test.ts | yes |
| M5 | ballot eligibility reads the row's frozen `registration_mode`, never `env.REGISTRATION_MODE` | inbox-d1.test.ts | yes |
| M5b | ballot eligibility reads the row's frozen `founding_ratified`, never a live signal | inbox-d1.test.ts | yes |
| M6 | the look-ahead row (101st) is never served on a truncated page | inbox-d1.test.ts | yes |
| M7 | the first-call floor (A19), vs A1's superseded naive rule | inbox-d1.test.ts | yes |

Each was applied, run alone to confirm the named test(s) went red, reverted, and
`git diff --stat` / a byte-diff against a pristine copy confirmed nothing remained, then
the full suite was re-run green before moving to the next mutation.

## Round 2: gate review fixes F1-F7 (exchange/REVIEW_inbox-core-build-2026-09-26.md, "## [CLAUDE round 2]")

Both external seats (CODEX, GEMINI) re-derived the code and the test file at source
against the committed `80c26552`. CODEX found F1 (two real 400-bypasses: empty-but-present
params, an unrepresentable cursor/since magnitude). GEMINI found F2 (my own A13 test could
not go red for the defect it names -- a genuine test bug, not a source bug) and F3-F6
(missing/thin coverage: the ballots parity table only ever compared one of two seeded
proposals; every mention test placed the mention in a title, never a body; no reply-window
or self-comment-on-own-post test; no posts-table pagination test). GEMINI also found F7
(the `batch()` shim's shape gap: no `success`, no `results` on a write) and two DEFERRED,
not-adopted items the hub records but this build does not fix (`Promise.all` risking
`SQLITE_BUSY` on real D1 -- rejected, both are reads at one primary; the helper accepting
`undefined` binds where real D1 refuses them -- `DEFERRED-LOCAL-D1-UNDEFINED-BIND`, no bind
in `inbox.ts` is actually undefined, CODEX confirmed).

| id | guard | test file | red seen |
|----|-------|-----------|----------|
| M8 | F1 rule 1: presence is `!== null`, not `!== null && !== ""` | inbox-d1.test.ts | yes |
| M9 | F1 rule 2: `SINCE_PATTERN` (digits only) checked before `Number()` | inbox-d1.test.ts | yes |
| M10a | F1 rule 4: cursor parts must each be a safe integer | inbox-d1.test.ts | yes |
| M10b | F1 rule 3: `since` must be a safe integer | inbox-d1.test.ts | yes |
| F2 | the cursor branch filters by `id`, not `created_at` (the corrected A13 test's own mutation, GEMINI's finding) | inbox-d1.test.ts | yes |
| F7 | `batch()` carries `success: true` on every entry and `results: []` on a write, and reads a leading `WITH` as well as `SELECT` | local-d1.ts | yes |

F2's fix: `before` was stamped `created_at: 1` and `id1`'s `created_at` was set to `100`
-- 100 is NEWER than 1, so the test could not distinguish an id cursor from a
created_at cursor (GEMINI's finding, confirmed by re-deriving the two numbers directly).
Restamped `before: 1000`, `id1: 500` (id1's id is still larger, its clock is now
genuinely older); the mutation (filter comments by `m.created_at > ` instead of
`m.id > `) now visibly reddens it (and, incidentally, two other tests that share the
same query path -- recorded as expected fallout, not a separate defect).

## Round 2 continued: F3-F6 (comprehensive coverage, second commit)

New tests only -- no source change in `src/inbox.ts` beyond F1/F2 above. Two of the new
guards turned out to already be covered by an EXISTING mutation once the new test was
added (recorded as such below, not given a redundant new id): `M3` (self-exclusion)
also reddens F5's self-comment-on-own-post test, and `M6` (the look-ahead slice) also
reddens both of F6's pagination tests. Three genuinely new mutation points: the
per-side boundary check (F4, `boundaryOk`'s two operands had only ever been mutated
together, M2), the windowing mechanism as a whole (F5), and the empty-table cursor
fallback (F6).

| id | guard | test file | red seen |
|----|-------|-----------|----------|
| M11 | mention boundary, BEFORE side only (`boundaryOk(before)` dropped from the AND) | inbox-d1.test.ts | yes |
| M12 | mention boundary, AFTER side only (`boundaryOk(after)` dropped from the AND) | inbox-d1.test.ts | yes |
| F4-body | `mentionsHandle(row.body, ...)` dropped from post AND topic classification (one mutation, both red) | inbox-d1.test.ts | yes |
| M-window | `idFloorExpr` forced to always 0 (no windowing at all) | inbox-d1.test.ts | yes |
| M13 | the empty-table cursor fallback (`snapshotMax ?? startId`) forced to ignore `startId` | inbox-d1.test.ts | yes |
| M3 (recheck) | self-exclusion (`m.citizen_id != ?`) ALSO reddens F5's self-comment-on-own-post test | inbox-d1.test.ts | yes (confirmed, not a new id) |
| M6 (recheck) | the look-ahead slice ALSO reddens F6's posts-pagination and 101-valid-items tests | inbox-d1.test.ts | yes (confirmed, not a new id) |

F3 (the ballots parity matrix) and the F4 post/topic-body test add coverage of the
EXISTING M5/M5b/M4b guards across more cells (four vote classes, tenure boundaries,
a founding-gated-with-false kind); their own new assertions were verified to actually
distinguish eligible from ineligible outcomes (the matrix's own "not vacuously green"
assertion) rather than mutation-tested a second time on the same source lines M5/M5b/M4b
already cover.

## Commit log

**Commit 2 (`src/inbox.ts` core + `test/inbox-d1.test.ts` + the two supporting exports):**
built `inbox()` end to end per A1/A2/A17/A19/A20 (id cursor per table, one candidate
stream per table classified in TypeScript, the look-ahead row, the conservative
first-call floor inlined as a scalar subquery so it shares the candidate query's own
batch, A20's restoration case, which needed no code change -- the classify-then-advance
design already has that property). Exported `serveTopic`/`ACTIVITY_SQL` from
`topics.ts` (A2's single-source instruction) and extended
`test/helpers/local-d1.ts`'s `batch()` to return `.results` for a `SELECT` statement
(additive; see the design-decision note above). Key decisions: the import-direction
fix (render functions take `ballotNote`/`authLabel` as parameters, not imports) and the
`kind = 'post'` single-source-of-enforcement fix, both above. Deviation: `renderHeartbeatMd`/
`renderSkillMd`/`heartbeatDoorNote`/`SKILL_VERSION` were written, then held out of this
commit and deferred to (b) on the hub's instruction, because they need `register-gate.ts`/
`discovery.ts` exports that are step (b)'s own registration points. 16/16 new tests green
(10 mutations red-proofed, table above), suite 1228/1228, typecheck clean.

**Commit 3 (gate review fixes F1-F7):** presence/shape/magnitude hardening on
`since`/`cursor` (F1, four rules, four mutations); the corrected A13 cursor-by-id test
(F2); `test/helpers/local-d1.ts`'s `batch()` now matches real D1's `D1Result` shape on
every entry (F7). F3-F6 (comprehensive ballots parity, body/underscore mention
vectors, window/self-comment tests, posts-table pagination) land in a following
commit -- see below. 6/6 new mutations red-proofed, table above.

**Commit 4 (gate review fixes F3-F6, test coverage only):** a full ballots parity
matrix (F3: four vote classes, tenure boundaries either side of the 7- and 14-day
thresholds, a founding-gated kind with `founding_ratified` false against both a
founder and non-founders, every one of the 20 (citizen, proposal) pairs compared
against a real `castBallot`); post-body and topic-body mention vectors plus the two
underscore-boundary cases (F4); a reply-window test and a self-comment-on-own-post
exclusion test (F5); posts-table pagination (101 topics), an empty-database cursor
test, and a clean 101-valid-items-as-100-then-1 test (F6). No `src/inbox.ts` change
beyond commit 3's F1/F2. 8 new tests, 5 new mutations plus 2 confirmed-by-an-existing-
mutation (table above). Suite 1241/1241, typecheck clean.
(b), (c), (d) still NOT STARTED.
