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

## Step (b): served text, routes, discovery integration

Resumed after the account's usage window reset. `renderHeartbeatMd`/`renderSkillMd`/
`heartbeatDoorNote`/`SKILL_VERSION`/`HeartbeatSkillFacts` (drafted during step (a),
cut out and saved per that commit's own note) land back in `src/inbox.ts` unchanged
from the saved draft -- already vetted against the brief and the hub's served-text
doc before step (a) even started, so no re-derivation was needed, only re-insertion
plus the two exports (`REGISTRATION_PRICE_CENTS`, `AUTH_LABEL`) it depends on.

No sentence in `docs/HEARTBEAT-SKILL-TEXT.md` was found unrenderable from a single
source; every `${...}` placeholder had exactly one home (`CONSTITUTION`, `TOPICS`,
`REGISTRATION_PRICE_CENTS`, the ballot route's own `ROUTES` note, `AUTH_LABEL`,
`env.REGISTRATION_MODE`, `SKILL_VERSION`).

**File list:**
- `src/inbox.ts` (edit): served-text section re-added (see above); `CONSTITUTION`/
  `TOPICS`/`REGISTRATION_PRICE_CENTS` imports restored.
- `src/register-gate.ts` (edit): `REGISTRATION_PRICE_CENTS` exported (same edit as
  step (a)'s draft, re-applied after the earlier revert).
- `src/discovery.ts` (edit): `AUTH_LABEL` exported; `RouteQueryParam.required?:
  boolean` added and emitted by `renderOpenApi` (A12) instead of a hard-coded
  `false`; `.md` routes render `text/markdown` in `renderOpenApi`'s content-type
  logic; `ROUTES` gains `GET /api/inbox` (handle required; since/cursor described as
  exactly-one-of in their own descriptions -- OpenAPI's per-parameter `required` has
  no native way to express an XOR between two parameters), `GET /heartbeat.md`, `GET
  /skill.md`, each with a `grepFor`; `/api/changes`'s `since` marked required;
  `handleHeartbeatMd`/`handleSkillMd` added (colocated with `handleLlmsTxt`, per the
  advisor's guidance during step (a) planning); `handleSurface` extended with
  `heartbeat: {url, sha256}` / `skill: {url, version, sha256}` (D7), `renderSurface`'s
  own sync signature and existing tests untouched.
- `src/index.ts` (edit): `GET /api/inbox`, `GET /heartbeat.md`, `GET /skill.md`
  dispatched; `DEFERRED-PUBLIC-READ-RATE-CAP` (A14) planted as a comment at the inbox
  dispatch line; `heartbeatDoorNote` appended after `topicsDoorNote` in the door-note
  assembly, outside `FRONT_DOOR_TEMPLATE` (the v5 pin stays green -- verified by the
  whole suite passing, including `topics-d1.test.ts`'s own pin test, unmodified).
- `src/society.ts` (edit): `changes()`'s `cursor_note` gains A8's sentence, rendered
  word for word; `DEFERRED-CHANGES-CURSOR-RACE` (F1, not fixed this wave) planted as
  a comment at the `now = Date.now()` line.
- `test/inbox-d1.test.ts` (edit): tests 8, 9, 10, 11, 11b, 13.
- `test/served-auth-both-path.test.ts` (edit): `/skill.md`'s Credentials section
  added to `SURFACES` (test 13's own instruction: this file enumerates by hand).
  `/heartbeat.md` deliberately NOT added -- it points at `/skill.md`/`/llms.txt`
  for credential mechanics rather than restating them, so the file's `BOTH_PATH`
  assertion does not apply to it; forcing a match would mean inventing wording the
  hub did not write.

| id | guard | test file | red seen |
|----|-------|-----------|----------|
| M14 | `renderOpenApi` emits `required` from `RouteQueryParam.required`, not a hard-coded `false` (A12) | inbox-d1.test.ts | yes |
| M15 | `heartbeatDoorNote` is appended on `GET /` | inbox-d1.test.ts | yes |
| M16 | `handleSurface`'s sha256 values are computed over the matching text (heartbeat/skill, not swapped) | inbox-d1.test.ts | yes |

Tests 9 and 10 also carry their own named mutations inline (a bogus path planted in
the checked text; a different origin's render), both red-proofed directly in the
test as the brief's own test list asks for, not against `src/`.

**Commit 5 (step (b)):** as above. 12 new tests (8, 9, 10, 11, 11b, 13, plus the
`served-auth-both-path.test.ts` extension folds into its existing test count), 3 new
mutations red-proofed. Suite 1247/1247, typecheck clean.

## Step (c): the inbox MCP tool (A16)

**Registration points, all five:** `TOOLS` in `src/mcp.ts` (the `inbox` entry, its
description ending "No auth needed" per `test/mcp-read.test.ts`'s own cross-check);
a `callTool` case in `mcp.ts` (public, no auth -- `args.secret`/`headerSecret` never
read for this tool, same as every other no-auth tool); `READ_TOOL_NAMES` in
`src/mcp-read.ts`; a `callReadTool` case there; `EXPECTED_READ_TOOL_NAMES` in
`test/mcp-read.test.ts` (the `tools.length === 8` sanity assertion becomes 9).
`test/l002-residue.test.ts` needed no edit -- it scans every `src/**/*.ts` file, so
`inbox.ts`'s existing content is covered with no registration of its own.

**A real, unplanned-for failure: `test/secret-literal-guard.test.ts`.** Adding
"inbox" to `mcp-read.ts`'s hand-written refusal-message tool list changed that
literal's exact text, which changed its sha256, which broke this D-061 guard (it
allowlists secret-bearing string literals BY HASH of their decoded value, so any
edit to an allowlisted sentence -- even one word appended elsewhere in it -- makes
the OLD hash stale and the NEW text unreviewed). Fixed the only way the guard's own
message says to: recomputed the sha256 of the changed literal (the template
literal's second quasi segment, the text after `${name}`) and updated the existing
`PROSE_ALLOW` entry in place (same file, same note plus a line on why, new sha) --
not a new entry alongside the old one, which would have left the old sha as a
second, now-genuinely-stale entry the guard's own `stale` check would then catch.

**File list:**
- `src/mcp.ts` (edit): the `inbox` tool entry (`TOOLS`); a `callTool` case; imports
  `inbox` from `./inbox.ts`.
- `src/mcp-read.ts` (edit): `READ_TOOL_NAMES` gains `"inbox"`; a `callReadTool` case;
  the header comment's "eight tools" corrected to "nine"; the refusal message's
  hand-listed tool names gain `, inbox`.
- `test/mcp-read.test.ts` (edit): `EXPECTED_READ_TOOL_NAMES` gains `"inbox"`; the
  `tools.length === 8` sanity assertion becomes `9`.
- `test/secret-literal-guard.test.ts` (edit): the `src/mcp-read.ts` `PROSE_ALLOW`
  entry for the refusal message updated to the new sha256 (see above).
- `test/inbox-d1.test.ts` (edit): test 12 (`handleMcp`/`handleMcpRead` imported;
  `tools/list` presence on both doors; a since-based and a cursor-based call, each
  compared for exact deep-equality between the MCP tool result and the REST body --
  the response was already designed with no wall-clock-sensitive top-level field
  during step (a), so this equality holds with no special-casing).

| id | guard | test file | red seen |
|----|-------|-----------|----------|
| M17 | `mcp.ts`'s `callTool` case for `"inbox"` | inbox-d1.test.ts | yes |
| M18 | `mcp-read.ts`'s `READ_TOOL_NAMES` entry for `"inbox"` (and, transitively, its `callReadTool` case, since `READ_TOOLS`/the advertised list is filtered from it) | inbox-d1.test.ts, mcp-read.test.ts | yes |

**Commit 6 (step (c)):** as above. 1 new test (12), 2 new mutations red-proofed, plus
the unplanned secret-literal-guard fix. Suite 1248/1248, typecheck clean.

## Two items owed from the review, addressed directly (not part of (b)/(c)/(d))

**The A20 test did not directly prove its own named property.** The original test
asserted only `page2.mentions === []` after a restore -- true, but true for more
than one reason (it would also read true if page1's OWN cursor never advanced past
`hidden` at all, a different bug). Redesigned with a genuine, DELIVERED mention
inserted before the hidden one, so "the cursor advances to the last EXAMINED row"
and "the cursor advances to the last DELIVERED row" produce two different, named
values (`c<hidden>-...` vs `c<genuine>-...`), and the test now asserts the id
DIRECTLY, not only the downstream consequence. Red-proofed with the review's own
suggested mutation: track the last row actually pushed into a section during
classification and use IT as the cursor instead of the real (last-examined)
value -- confirmed red on the new direct assertion, reverted, `git diff` against
HEAD confirmed byte-identical.

**`DEFERRED-LOCAL-D1-UNDEFINED-BIND`** planted as a comment at `test/helpers/
local-d1.ts`'s `batch()` function: real D1 rejects an `undefined` bind value
outright; `node:sqlite` underneath this shim can be more lenient, a genuine
fidelity gap GEMINI's review named and CLAUDE round 2 declined to fix this wave
(CODEX verified every bind in `src/inbox.ts` lines up and none is ever undefined).
No functional change -- documentation only, matching how every other `DEFERRED-*`
flag in this codebase is recorded (a grep-able marker, not an enforced check).

**Commit 7 (the two review-owed items):** `test/inbox-d1.test.ts` (A20 test
redesigned and re-proofed), `test/helpers/local-d1.ts` (the flag). 1 new mutation
red-proofed (table below). Suite unchanged in count (1248/1248 -- the A20 test was
replaced, not added), typecheck clean.

| id | guard | test file | red seen |
|----|-------|-----------|----------|
| A20-recheck | the comments cursor advances to the last EXAMINED row, never the last DELIVERED one | inbox-d1.test.ts | yes |

## Step (d): the deploy script

`scripts/deploy-heartbeat-inbox.ps1`, in the house pattern of
`scripts/deploy-composition-split.ps1` (the closest precedent: worker-only, no
migration, non-minting -- unlike `deploy-wallet-pin.ps1`/`deploy-standing-topics.ps1`,
which both carry a migration this wave has none of). `-DryRun` re-runs the suite and
typecheck, reads `/api/attest` (v5, all chains verified) and proves `GET /api/inbox`
still answers 404 (the route genuinely does not exist pre-deploy), then stops before
`wrangler deploy`. The real run deploys, then rides exactly the brief's own Deploy
section: `GET /api/inbox?handle=commonhold-agent&since=0` 200 with all eleven
response keys present; an unknown handle 404; `/heartbeat.md` and `/skill.md` 200
`text/markdown` (via `Invoke-WebRequest`, not `curl.exe -I` -- index.ts dispatches
these routes on an exact `method === "GET"` match, so a HEAD request would 404
instead of reflecting the real GET response, a trap avoided here); `/api/surface`'s
two sha256 values recomputed independently in PowerShell (`System.Security.
Cryptography.SHA256`) against the served bodies' own bytes; `/api/attest` still v5
with all chains verified; the door note present; a sweep of eight untouched
surfaces still 200.

**WRITTEN, NOT RUN, in any mode -- not even `-DryRun`** (the commission's hard rule,
reiterated in the hub's own resume message). Checked for correctness the only way
that does not violate that rule: `[System.Management.Automation.Language.Parser]::
ParseInput` against the file, which builds an AST and reports syntax errors without
executing a single line -- no network call, no `npm test`, no `wrangler` invocation.
Returned zero parse errors.

**Commit 8 (step (d)):** `scripts/deploy-heartbeat-inbox.ps1` (new). No test/src
change; nothing to red-proof (the script itself is Ben's hand-run artifact, not
code this suite exercises). Suite and typecheck unchanged from commit 7's own
1248/1248, clean.

## All four steps done

(a) core `inbox()`, (b) served text and routes, (c) the MCP tool, (d) the deploy
script, plus the two review-owed items, are all committed. Nothing outstanding from
`docs/BRIEF-HEARTBEAT-INBOX.md` or the hub's resume message remains unbuilt in this
worktree. No sentence in `docs/HEARTBEAT-SKILL-TEXT.md` was found unrenderable from
a single source at any point across the whole build.
