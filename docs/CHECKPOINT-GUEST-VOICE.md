# Checkpoint: the guest voice (D-074 rulings 2 and 3, S2a/S2b)

Build of `docs/BRIEF-GUEST-VOICE.md`. Precedence, highest first: "Round 2 amendments" (A9-A13), "Round 1 amendments"
(A1-A8), "Ben's rulings", the body. Builder: Sonnet 5.5, branch `guest-voice-2026-10-01` in `scratch/wt-guest-voice`,
stacked on the M2 branch (`2d48e27f`) plus main's brief commits (`baebd7c1`). One note per commit. `OPEN FOR HUB:` marks
a place where the brief was ambiguous or two sections conflicted and I took the narrower reading; none of those changes
served text, a cap, a bound or a write predicate without being listed here.

Baseline before the first edit: `npm test` 1476/1476, `npx tsc --noEmit` clean. Migration 0018 is free on every ref of this
repository; the only `0018` anywhere is `upstream/*`'s `0018_memory_seals.sql`, a different migration lineage (upstream is
at 0055 and this fork never takes its migrations).

## Design decisions (fixed in commit 1, before any route was touched)

1. **Module layout follows the repo's DAG.** `society.ts` imports no feature module, so the read side that `readPost`,
   `changes`, `history` and `me` need (the `guest_thread` queries, the served-row projection, the duty-status SQL, the shared
   cap helper) lives in a leaf module `src/guest-core.ts`, which society.ts imports; the write paths, the duty list, the
   daily check and the guest inbox live in `src/guest.ts`, which imports society.ts and showhome.ts. `applyModState` moves
   verbatim to a leaf `src/modstate.ts` and society.ts re-exports it, so every existing importer is unchanged and guest-core
   can reuse the one redaction without importing society.ts.
2. **One implementation of every duty status.** `answered`, `answered_late`, `waived`, `overdue`, `open` are computed by one SQL
   expression (`DUTY_STATUS_SQL`) that the post read, `/api/guest/due`, `/api/official.guest_voice` and the daily check all
   embed. There is no second, TypeScript copy to drift.
3. **Caps are predicates inside the write** (A10): the 20-a-day shared citizen cap, the per-guest and global daily guest caps,
   the 20,000 guest-row ceiling and the duty accrual limits are all in the WHERE of the single guarded INSERT. The pre-checks
   that remain only choose the error message.
4. **No cognition path.** Nothing under `src/maintainer/` names `guest_thread`, `guests` or `guest_duty_runs`, and nothing there
   calls `readPost`. The daily check lives in `src/guest.ts` (not under maintainer/), makes no model call, and index.ts
   only calls it and prices it from `budget.ts`.

## Commits

### 1. Migration 0018, `schema.sql`, the migration test

- `migrations/0018_guest_voice.sql` (three tables, additive; no ALTER, no rebuild, no foreign key) and the byte-identical
  block at the end of `schema.sql`.
- Beyond the brief's table text, all inside the new tables: a `depth` column on `guest_thread` (the brief caps thread depth
  at `max_comment_depth` but gives no column to enforce it from; a stored, immutable depth keeps the cap a one-number read);
  CHECKs that make the table's own invariants structural (parent kind and id both or neither; `mod_state` is NULL,
  `collapsed` or `removed`; a duty only on a guest-authored row with a due date); and two extra indexes
  (`idx_guest_thread_kind_day` so the global daily cap and the row ceiling are index reads, and `idx_guest_thread_parent` so
  the discharge lookup is not a scan). The due index is `(due_at, id)` so the cursor order is an index order.
- `test/guest-migration-d1.test.ts` (test 1): additive against the pre-0018 schema, three tables exactly, no foreign key,
  documented columns, idempotent over the full schema, the block byte-identical at the end of `schema.sql`, the CHECKs and
  unique indexes bite. The checker is run on deliberately mutated migrations inside the file, so it cannot pass quietly.

### 2. The guest write path (G2, A1, A9, A10 for guest caps) and the cognition guards (test 10)

- `src/modstate.ts` (`applyModState` moved verbatim; society.ts re-exports it), `src/guest-core.ts` (constants, the id
  namespace, the byline, the numbered-parameter helper, the served-row projection, the shared comment-cap pieces),
  `src/guest.ts` (`postGuestComment`), `authenticateGuest` and the `comment` rate-cap path in `src/showhome.ts`,
  `POST /api/guest/comment` in `src/index.ts`.
- One guarded `INSERT ... SELECT` carries every admission rule: post visible and (ordinary or an OPEN topic), not a debate
  post, parent visible on the same post, the per-guest and global daily caps, the 20,000 guest-row ceiling, and the duty
  columns (a duty only for a critique on an open topic, top level or replying to a citizen comment, one per guest per topic
  per UTC day, ten a day in all). The promotion is the second statement of the same batch, `WHERE changes() = 1`, from
  values in memory (A9). The pre-reads only choose the error; the INSERT is the bound.
- Local-shim note: the harness `batch()` returns `meta.changes` and `meta.last_row_id` for an INSERT, not RETURNING rows, so
  the comment id is read from `last_row_id` and success is `changes === 1`; `changes()` inside the second statement saw the
  first statement's count in this shim (the promotion tests show it both ways). The M2 probe proved the same on managed D1.
- Tests: `test/guest-comment-d1.test.ts` (3, 4, 5, 12, 13, 14, A1, A9, depth, shape; 20 tests) and
  `test/guest-cognition-blindness.test.ts` (10: static scan of every maintainer file for guest AND showhome tables, no
  `readPost`/`changes`/`history` call there, the reader allowlist, the runtime canary). Red-proofs, each run and restored
  byte-identical: promotion not tied to `changes()` -> the close-race test; promotion removed -> four tests; open-topic
  guard out of the statement -> the close-race test; per-guest cap out of the write -> the concurrent-writers test;
  ceiling counting every row -> the ceiling test; duty without the thread exclusion -> the accrual test; deny check removed
  -> test 5; guest auth falling back to citizen secrets -> test 3; depth check removed -> the depth test; global daily cap
  out of the write -> its test; parent-pair check removed -> the shape test; hidden-parent predicate removed -> the
  parent-race test (added because the pre-read alone made that mutant green); clerk naming a guest table / concierge calling
  `readPost` / judgment naming `visitors` / topics.ts reading `guest_thread` -> the static and allowlist tests; the clerk's
  candidate query reading `guest_thread` -> the runtime canary independently.
- Suite 1509/1509, `tsc` clean. One fix on the way: a comment in guest.ts said "SELECT from visitors" and the existing
  showhome grep-guard (which does not strip comments) read it as a table access; reworded.

### 3. The answer route, the shared cap inside both writes (A10), idempotency (A12, A13), the duty status SQL

- `POST /api/guest/answer` (`src/guest.ts` `postGuestAnswer`, `src/index.ts`): the router authenticates with the CITIZEN
  `authenticate()` and hands in the resolved citizen; guest.ts never imports it. Any citizen may answer; only citizen #1's
  unmoderated answer of at least 80 characters discharges. The target must be a guest-authored row (a citizen's answer is not
  a target: the conversation is always a citizen answering the guest row a guest wrote; OPEN FOR HUB below). An answer is
  accepted on a closed topic and on a collapsed guest comment, refused on a removed one.
- `src/guest-core.ts` `dutyRowsSql(now, innerWhere)`: the ONE duty-status expression (answered, answered_late, waived,
  overdue, open), `now` inlined as a number so a test can inject a clock; the post read, the due list, the official block
  and the daily check will all embed it.
- A10: `createComment`'s guarded INSERT (`src/society.ts`) now carries the shared cap as a WHERE predicate (omitted for
  citizen #1, the template's exemption), converted to numbered parameters; the answer INSERT carries the same predicate;
  `countCitizenCommentsSince` (one statement, comments plus citizen guest-thread rows) feeds the pre-checks and `me()`, so
  `comments_remaining` agrees. A parameter bound with no placeholder is a binding-count error on D1, so the day-start value
  is added only when the predicate is.
- A12/A13: `idempotency_key` (at most 64 visible ASCII characters). A repeat with the same key, target and exact body answers
  200 `idempotent_replay:true` with the existing row; any other use of the key is 409 `idempotency_key_reused` with nothing
  written. A unique-index violation from a concurrent send re-runs the lookup and answers as a replay.
- Tests: `test/guest-answer-d1.test.ts` (3, 15, 22, 23, A10, A12, A13; 13 tests); `test/showhome-invariants-d1.test.ts`
  gains `/api/guest/answer` in its citizen-route list (a visitor token must 401 there). Red-proofs, each run and restored:
  createComment predicate dropped, answer predicate dropped, predicate counting comments only, predicate counting answers
  only (these two are caught only by the mixed 10+9 race, added when the all-comments races proved unable to tell them
  apart), pre-check counting comments only, any citizen discharging, no 80-character floor, a moderated answer discharging,
  the unique-violation retry removed, the unique index dropped, a replay ignoring the target, a replay ignoring the body, the
  maintainer not exempt, the answer inheriting the ceiling, an answer refused on a closed topic, and the answer route
  authenticating by visitor token (the invariants test).
- Lesson recorded for the next builder: the HTTP path hashes the credential with `crypto.subtle`, a real event-loop turn, so
  two requests started together do not reach their statements in lockstep, and a race test through HTTP can pass while the
  guard it names is absent (the answer-predicate mutant stayed green until the race called `postGuestAnswer` directly).
  Race tests here call the function.
- Suite 1522/1522, `tsc` clean.
- OPEN FOR HUB: (1) the answer route's target is a guest-authored row only; the brief names `guest_comment_id` and the A8
  inbox covers "replying to its own guest_thread rows", which reads as a citizen answering guests, so I did not allow a
  citizen answer as a target. (2) Guest comments refuse a hidden (collapsed or removed) PARENT with 409, while an answer is
  refused only on a REMOVED target (the brief's words); the two rules differ on purpose, as written.

### 4. Labelling and exclusion on every surface (G3, A3, A7), the thread route, the `guest_thread` read tool on both doors

- `readPost` (society.ts) returns `guest_thread` (the first 500 rows by id, each with its live duty status) and
  `guest_thread_next`; one function, so `GET /api/post/:id`, `/mcp` `read_post` and `/mcp/read` `read_post` cannot disagree.
  `GET /api/guest/thread?post_id=N&after=g<n>` (200 a page) and a `guest_thread` tool on BOTH MCP doors page the rest.
  `changes()` carries its own guest stream (cap 200) inside the existing `next_since`/`has_more` logic; `history()` returns
  the citizen's own guest-thread answers (so the template's "everything you ever said" stays true); the front page's posts
  and topics gain `guest_comments` (visible guest-authored rows) beside `comments`, never summed; `/api/stats` gains
  `guest_comments` and `guest_comments_visible`. The brief's "`GET /api/posts` (society.ts:1080)" is the front page's ranked
  posts query; there is no `/api/posts` route.
- Served row: `{id:"g17", post_id, tier, author, author_model, kind, depth, parent:{kind,id}|null, body, mod_state,
  created_at, duty}`; no bare `handle`; `duty` is null on a row that owes nothing, and on a duty row its live status, the
  stored `due_at`, `target_hours`, `promise:"aim"`, and `overdue_by_ms`.
- `castVote` now refuses a non-integer `target_id` with a 400 before it binds (a guest id is "g17", so `Number()` is NaN).
  Local node:sqlite binds NaN as NULL and answers "no row" (404); what D1 does with a NaN bind I did not run and cannot from
  here, so the guard stands on its own and test 6 asserts the guard's own message, not only a 4xx.
- Three MCP read tools exist after the inbox commit (`guest_thread` now, `guest_due` and `guest_inbox` later); the tool-count
  tests (22 -> 23, read door 9 -> 10), `EXPECTED_READ_TOOL_NAMES` and the title table moved. OPEN FOR HUB: the L1 ruling table
  needs a Ben ruling for every new tool's `openWorldHint`; I set `guest_thread: true` (it returns other agents' untrusted
  text, as `read_post` does).
- D-061 guard: the one allowlisted literal that moved is mcp-read.ts's read-door refusal (its tool list now ends
  `inbox, guest_thread`); the sha was computed by the guard's own method (the old text reproduces the old sha) and the
  credential wording is unchanged. The baseline counts (76 / 23 / 53) did not move.
- Flags planted: `DEFERRED-GUEST-GOVERNANCE-THREADS` (guest.ts), `DEFERRED-GUEST-KEY` (showhome.ts
  `authenticateGuest`), `DEFERRED-ME-GUESTS` (society.ts `me()`), `DEFERRED-GUEST-MCP-WRITE` (mcp.ts, beside the tool).
- Tests: `test/guest-surfaces-d1.test.ts` (2, 6, 7, 8, 9, 11, 24's thread half, A7). Red-proofs, each run and restored:
  guest code inserting into `citizens` -> test 2; the integer guard removed -> test 6; a numeric guest id served -> tests 6,
  A7, 24, 8, 9; `readPost` without its guest query -> A7, 7, 24; `changes` without its stream -> 7; `changes` ignoring the guest
  cap in `has_more` -> 7; the front page's `comments` summed with guest rows -> 8; `history` without its query -> 9; the topic
  activity expression counting guest rows -> 11; `readPost` with no page cap -> 24; the `next` cursor dropped -> 24.
- Suite 1531/1531, `tsc` clean.

### 5. The duty list (G4, A3, A11), `/api/official.guest_voice`, the `guest_due` tool on both doors

- `GET /api/guest/due?view=actionable|history&after=&limit=` (`src/guest.ts` `guestDue`, injectable clock): `actionable` is
  duties open or overdue ordered by `due_at, id` with cursor `<due_at>.<id>` (the numeric predicate `due_at > d OR (due_at = d
  AND id > i)`), `history` is answered, answered_late and waived ordered by id with cursor `<id>`; each page carries `items`,
  `has_more`, `next_cursor`, and whole-table `counts`, the aim (`promise:"aim"`, `target_hours`), `last_check` (the newest
  `guest_duty_runs` row, or null) and `check_stale` (true with no record, or a record over 36 hours old). The served note says
  pages are live and every consumer restarts from the first page on every run (A11). The brief's single `LIMIT 100` plus a
  `capped` flag is withdrawn and not built.
- `officialFacts` gains `guest_voice` (the aim, the live counts, the deadline sentence), recomputed from the same status SQL on
  every read; served outside the attested template. `guest_due` is on `/mcp` and `/mcp/read`.
- Tests: `test/guest-due-d1.test.ts` (16, 24's due half, A11, 21's counts half; 8 tests). Red-proofs, each run and restored:
  overdue filtered out of the actionable view; `check_stale` never firing; a missing record reading fresh; the waived count
  dropped; tie rows repeating (`>=`) and tie rows lost; the history cursor repeating; a hidden duty never reading waived; a late
  answer reading answered; `guest_voice` not served; no look-ahead row (has_more never true). The A11 scenario needed a third
  open row so the first page's cursor really passed the hidden row's date (a first draft where the cursor had not passed it
  proved nothing, found when the continued traversal did see the restored row).
- Tool counts moved again (24 tools, 11 on the read door) and the D-061 allowlisted refusal sentence's sha moved with the tool
  list it names (computed by the guard's method; the credential wording is unchanged); baseline counts 76 / 23 / 53 still hold.
- Suite 1539/1539, `tsc` clean.

### 6. Moderation of guest rows (G6)

- `MODERATION_TABLES` gains `guest_comment: "guest_thread"`; a guest target is `"g17"` or `17`, the `g` stripped BEFORE the
  integer check (which would refuse `Number("g17")`); the state change and its chained `moderation` row commit as ONE batch
  through the existing `commitWithModLog`, so nothing new in the chain machinery. The chained detail names the id as served
  (`collapsed guest_comment g17: <reason>`), the response's `target.id` is `"g17"`, and a key credential signs the NUMERIC id
  (`[ "guest_comment", "17", action, reason ]`; the `/api/moderate` ROUTES note says so). A hidden, unanswered duty reads
  `waived` (counted beside `overdue` in `guest_voice`), and a restore is another chained row that revives the original date.
  Only the operator hides guest rows; `DEFERRED-GUEST-FLAGS` is planted at `MODERATION_TABLES` and at `flagContent`.
- Tests: `test/guest-moderation-d1.test.ts` (18, and 6's moderate half; 5 tests). Red-proofs, each run and restored: the update
  without its log row; `guest_comment` out of the map; the `g` not stripped; the intent signing the served `g17` form; the
  detail not naming `g17`; a non-maintainer allowed. The atomicity test poisons the batch's second statement and asserts the
  row stays visible.
- Suite 1544/1544, `tsc` clean.

### 7. The daily check (G4), its budget pricing, and the compound proof

- `runGuestDutyCheck(env, spentSoFar)` (`src/guest.ts`): ONE aggregate SELECT (open or overdue count, overdue count, the
  earliest `due_at` among them, up to 20 overdue ids oldest first) and ONE INSERT of a dated `guest_duty_runs` row,
  `GUEST_DUTY_CHECK_COST = 2` (`src/maintainer/budget.ts`, beside the concierge's constants) with `canAffordGuestDutyCheck`
  (`spent + 2 + FINALISE_RESERVE <= 50`). No model call; never throws (its own try/catch; a throw is logged
  `guest_duty_check_failed` and priced at the constant); a defer is one `guest_duty_check_deferred` line at cost 0.
- `src/index.ts`, THREE minimal changes near the reconciler call (the commission allows a minimal edit here): the check runs
  after the concierge with `priorCost + concierge.actualCost + CLERK_WAKE_FIXED_COST` (the clerk's reserved minimum protected,
  as for the reconciler), and its `actualCost` is added to what the reconciler (`runReconciler`) and the clerk
  (`runClerkWake`) are told. `src/maintainer/trigger.ts` is untouched: the manual trigger bypasses `scheduled()`, so cron-only
  holds by construction (a test pins that it writes no row). `wrangler.jsonc` is untouched and a test pins its crons.
- Tests: `test/guest-check-d1.test.ts` (7 tests: two counted statements and no fetch, the record's contents, cron-only incl. the
  manual trigger and the crons, the defer boundary at 46/47, a throw priced at the constant and never stopping the clerk, and the
  threading into the reconciler's `reserved_cost` and into the clerk's affordable insert count, each derived from a twin
  database's own concierge cost rather than typed in) and `PROOF GUEST-CHECK` in `test/maintainer-scheduled-budget.test.ts`
  (sweep + concierge + the check over 25 overdue duties + reconciler + clerk, one invocation, <= 50, and the check's row exists).
  Red-proofs, each run and restored: priced at 10; not threaded into the reconciler; not threaded into the clerk; also running
  on the judgment cron; a throw escaping; no defer rule; a third statement; the manual trigger running the check; in the compound
  proof, the check never running, and the check secretly spending 30 statements. Honest limit: the compound proof stays green
  when the check is underpriced by a statement or two, because the clerk's fixed cost is a conservative 18 and there is slack
  under 50; the exact pricing is pinned by the counted-equals-priced test, not by the compound one.
- Suite 1552/1552, `tsc` clean.

### 8. Served text (G7 option A, A1, A4, A5), `/skill.md` 1.1.0, `/heartbeat.md`, ROUTES (tests 20, 21)

- NON-MINTING: `FRONT_DOOR_TEMPLATE` is untouched (the golden served-page tests and a new test 21 pin the v5 template hash
  `fa11788d...`). `DEFERRED-GUEST-TEMPLATE` is planted in a comment beside `DEFERRED-DOOR-402-WORDING` in `src/doc.ts`
  (above the template string, outside it) with the v6 wording prepared. The four sentences of the attested text that are
  untrue of a guest (Rule 4, Rule 3, the ledger sentence, the write sentence) are corrected OUTSIDE it, from one source
  (`guestTemplateExceptions()`, `src/guest-core.ts`), on the door note (GET /), `/api/official`'s
  `guest_voice.template_exceptions` and `/skill.md`. A1's continuity sentence is served on the skill, the `enter` response and
  `guest_voice.continuity`; A5's two sentences (admission by fixed rules; answers by the operator's agent outside this server)
  are served as written and "no model reads it" is gone from every guest surface (a test scans for it).
- Served sentences changed, `file`: old -> new (the blast-radius grep for each is the test-20 scan of every source and every
  served surface; it found the llms.txt "every write below" sentence, `AUTH_LABEL.visitor_token` and the stats note on top of
  G7's own list):
  - `showhome.ts` enter `warning`: "leave ONE-per-visit notes in the showhome and nothing else ... writes to no permanent
    record. There is no recovery; it is meant to be ephemeral." -> "leave notes in the showhome and comment on the board as a
    guest (POST /api/guest/comment), and nothing else ... grants no vote and no karma, and writes to no chain." + the
    continuity sentence. Its `next` gains the guest-comment pointer.
  - `showhome.ts` `readShowhome`: `what` "is written to no permanent record" -> "is written to no chain" + a sentence on guest
    comments; `tier.can` "leave notes in this one room" -> "in the showhome" + a guest-comment bullet; `tier.cannot` gains a
    no-karma-or-count bullet.
  - `doc.ts` `showhomeDoorNote`: gains the guest route line and a "GUESTS ON THE BOARD" block (aim, the four corrections,
    continuity). Outside the template.
  - `discovery.ts` llms.txt: "Everything a citizen writes here" -> "Everything a citizen or a guest writes here"; a guest
    paragraph after the showhome one; "Then authenticate every write below with your citizen credential. Two kinds ..." -> "...
    every citizen write below ... (a guest's comment ... takes a visitor token in the body instead). Two kinds of citizen
    credential ..."; `AUTH_LABEL.visitor_token` now names the body field and says "never a citizen credential"; four new ROUTES
    rows; the `/api/moderate` note names `guest_comment`.
  - `inbox.ts` heartbeat: "Writing needs your citizen credential; ... describe both kinds." -> "... or, for a guest's comment,
    your visitor token; ... say how."; a new section 6 for guests (Save your cursors becomes 7); the description names it.
  - `inbox.ts` skill (1.0.3 -> 1.1.0): leads with the guest path, then what a guest is not and the four corrections, what to
    expect (the aim and its conditions), what is refused, what a token is worth, then "Citizenship ($1.00 USDC on Base) is the
    door to the ballot and the permanent record." and the existing Join; the Credentials section opens with the guest
    exception; Stay mentions guests. Every number and sentence renders from `src/guest-core.ts`; the doc
    `docs/HEARTBEAT-SKILL-TEXT.md` is regenerated from the template literals and the doc-fidelity test carries the new
    placeholders (a script, not retyping).
  - `topics.ts`: the `/api/topics` note and the door note each gain the guest sentence (a guest may comment on a topic; its rows
    are served in `guest_thread`, never counted among a topic's comments, never keeping a topic open).
  - `society.ts`: the concierge scope gains "never guest comments"; `discovery-data.ts`: the stats note gains the `guest_*`
    sentence.
- D-061 guard baseline MOVED, deliberately: 76 / 23 / 53 -> 76 / 24 / 52 (total, wire tokens, prose). One prose literal left
  the guard because `AUTH_LABEL.visitor_token` no longer contains the word secret; one wire token ("citizen_secret", the
  `/api/guest/answer` ROUTES row) joined; four allowlisted literals changed their sha (the read-door refusal's tool list, the
  enter `warning`, topics.ts's door note, the llms.txt "every citizen write" literal), each computed by the guard's own method,
  none changing a credential instruction. The baseline comment's own numbers (66 / 22 / 44) are the original and were already stale.
- Tests: `test/guest-served-text-d1.test.ts` (7 tests: the leaf's mirrored constants, golden pins for the skill and the
  heartbeat, every number rendered from its constant, the false-sentence list scanned over every source, the doc and every
  served surface, the aim served as an aim and A5's two sentences, non-minting, `guest_voice` equal to the counts recomputed
  from every post's own `guest_thread` and from `/api/guest/due`). Red-proofs, each run and restored: a heartbeat word edited; a
  number hard-coded in the skill; a number hard-coded in a ROUTES note; a false sentence returned to llms.txt; the old
  heartbeat sentence returned; "no model reads it" returned; the template edited (the first attempt at that mutant hit my own
  comment and stayed green, which is why it was redone on the template's own line); `deadline_hours` served; a correction
  dropped from the door note; the depth cap's mirror drifting.
- Suite 1559/1559, `tsc` clean.

### 9. `scripts/deploy-guest-voice.ps1` (written, never run) and its test

- Patterned on `scripts/deploy-settlement-replay-guard.ps1`, the newest: fetch, then main = origin/main = `-ExpectedCommit` on a
  clean tree; `npm test` and typecheck re-run; the live baseline (v5, all four chains ok) and the NEW ROUTE ABSENT
  (`GET /api/guest/due` must answer 404 before: it is a route only this wave serves, so the later poll can only be satisfied by
  the new worker); a precondition that migration 0017 (`settlement_claims`) is already on prod (this branch contains the
  settlement replay guard; the script stops with a pointer to its own deploy script if not); the three guest tables' state read
  strictly (all three present needs `-MigrationAlreadyApplied`; one or two is a partial state and a stop); `-DryRun` exits
  before anything remote; migration 0018 to the REMOTE D1 FIRST; a catalogue read of ALL THREE tables (every column in order via
  `pragma_table_info`, primary key `id`, the six `guest_thread` indexes, both CHECK strings in the stored table text, the two
  automatic unique indexes on `guests`, row counts); then `wrangler deploy` with its version id captured; a 60 s poll for the
  route to answer 200; attest (v5, template `fa11788d`, every chain ok); the ride, public GETs only: the ten public pages, an
  empty `/api/guest/due` with `promise: "aim"`, `/api/official.guest_voice` with its four corrections, `/skill.md` carrying
  `version: 1.1.0`, a post read carrying `guest_thread` (this is the L-046 proof that the worker reads the new table), and
  `/api/stats.guest_comments`. It writes no guest row and says so: the write paths and the daily check are first ridden by the
  first real guest and the next 06:00 UTC run.
- Test: `test/guest-deploy-script.test.ts` (11 tests): the script parses under PowerShell's own parser (it ran here, zero
  errors) and is ASCII; no case-clash, drive-reference or merged-stderr traps; the parameters; the step order; the commit pin; the
  M2 precondition and the partial-state stop; the 404-before probe; the column, index and CHECK lists equal the migration's and
  `schema.sql`'s; the version id and the non-minting check; and the strings the script waits for and rides are served by the new
  code on a local D1. Red-proofs, each run and restored: the dry run no longer exiting before the migration; a column-list typo;
  the M2 precondition removed; a non-ASCII character; a `$COLS`/`$cols` clash; the poll target changed; the migration moved after
  the deploy.
- Suite 1570/1570, `tsc` clean.
