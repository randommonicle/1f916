VERDICT: DEPLOYABLE WITH CONDITIONS (HIGH 0, MEDIUM 1, LOW 6) -- worker wave reviewed at `4445c348`.

# D-018 gate: the guest-voice wave (D-074 S2a/S2b), 2026-10-02

Gate: Opus 5.5, read-only on the worktree except this file. Brief: `drafts/GATE-BRIEF-GUEST-VOICE-2026-10-02.md`.
Scope: `678ae407..4445c348` (14 commits). Every `file:line` below is at `4445c348`.

**HEAD moved during the gate.** The branch is now at `8dcb6dc1` (`ccca8490`, `77cdf111`, `8dcb6dc1`: the A6 local
answer loop). Those three commits touch only `scripts/guest-answer-*.mjs`, `scripts/guest-due-draft.mjs`,
`test/guest-answer-scripts.test.ts` and the checkpoint; `git diff 4445c348 8dcb6dc1 -- src/ migrations/ schema.sql
wrangler.jsonc` is empty, so the deployed worker is identical. **Those scripts are NOT covered by this gate**; whether
they ride it or get their own pass is the hub's call.

## What I ran

- Scratch copy of `4445c348` (`git archive`), `node_modules` junctioned: **1614/1614**, fail 0 (reproduces the hub).
- Twelve mutants on the full suite (below), each restored and the restore verified against `git show 4445c348:<file>`.
- A barrier probe of the conditional rate reservation on the three LIVE showhome paths, red-proved (below).
- `scripts/deploy-guest-voice.ps1 -DryRun` four times in a throwaway `git clone` of `society/` (its `origin` is the
  local repo, so `git fetch` touched nothing remote and no step past step 0 ran). All four STOPped, exit 1:
  1. on branch `guest-voice-2026-10-01`: `[STOP] the current branch is 'guest-voice-2026-10-01', not main`.
  2. on main = origin/main = `678ae407`, `-ExpectedCommit 4445c348`: `[STOP] main, origin/main and -ExpectedCommit are not one commit`.
  3. main fast-forwarded locally to `4445c348`, origin/main still `678ae407` (merged, not pushed): the same STOP.
  4. `-ExpectedCommit deadbeef`: `[STOP] -ExpectedCommit 'deadbeef' is not a commit in this repository.`
  Read, not run: 0018 is applied (step 3) before `wrangler deploy` (step 4), and step 3b reads every column of all three
  tables, the primary keys, the six indexes, both CHECK strings and the two `guests` autoindexes.

## Findings

### MEDIUM

**M-1. The correction of the template's false "write" sentence is itself false, on four surfaces.**
`src/guest-core.ts:379` (served on GET / door note, `/api/official.guest_voice.template_exceptions.writes`, `/skill.md`):
"A guest's board write sends the visitor token in the request body; every other write needs a citizen credential."
`src/inbox.ts:816` (skill, Credentials): "Every other write needs a citizen credential". `src/discovery.ts:450-452`
(llms.txt): "a guest's comment ... is the one write that takes a visitor token in the body instead".
Input that falsifies it: the ROUTES table two screens below in the same llms.txt, `src/discovery.ts:126`
(`POST /api/showhome/note`, auth `visitor_token`), `:135` (`/api/showhome/reply`, visitor token in the body), `:125`
(`/api/showhome/enter`, no credential), `:182` (`/api/governance/sweep`, none). The template sentence it corrects was
already untrue of the showhome; the block whose only job is to make served text honest adds a new absolute that is
false for this deployment (Q5, L-002 class). Fix, text only: e.g. "A guest's board comment sends the visitor token in
the request body, as the showhome's note and reply do; a citizen's writes need a citizen credential." Moves the skill
pin, the heartbeat/doc fidelity text if shared, and the D-061 allowlist sha of the llms.txt literal.

### LOW

**L-1. Six write-level predicates and status rules no test can turn red** (prove-it-can-fail). Each mutant left the
suite at 1614/1614 (table below): M1 post `mod_state` predicate out of the guest INSERT (`src/guest.ts:237`), M2 debate
`NOT EXISTS` out of the INSERT (`:239`), M3 `waived` evaluated before discharge (`src/guest-core.ts:240-241`), M4
`a.author_kind = 'citizen'` dropped from the discharge (`src/guest-core.ts:223`), M6 removed-target predicate out of
the answer INSERT (`src/guest.ts:411`), M7 `guest_comments` counting citizen answers (`src/guest-core.ts:284`). The
code is correct at `4445c348` in every case; the tests do not pin it. M4 is the one that matters for Q1: without
`author_kind = 'citizen'`, a guest whose visitor number is 1 could discharge a duty by replying `parent_kind:"thread"`
under a critique with 80 characters (guest rows carry `author_id` = visitor id). Recommended: one pin each for M3, M4
and M7 (sequential, cheap); M1/M6 need a race shaped like the existing close-race test.

**L-2. "owed an answer" and "duty" sit beside "we aim".** Ruling 5 serves "we aim to answer within 96 hours"; the timing
is aim-only on every surface (grep of deadline / will answer / must answer / guarantee found none). But
`src/mcp.ts:457` (tool title "Guest critiques owed an answer"), `src/doc.ts:698`, `src/discovery.ts:431`,
`src/inbox.ts:785` say "every critique owed an answer", `src/guest.ts:79` says "nothing is owed", and the skill calls an
accepted critique "one such duty" (`src/inbox.ts:785`). "Owed" asserts an obligation the ruling withheld ("a firm duty
later"). Field names (`duty`, `due_at`, `overdue`) are A4's and stay. Ben's wording call; "awaiting an answer" fits.
Related precision: `GUEST_ADMISSION_SENTENCE` (`src/guest-core.ts:69`) says "this server's scheduled wakes never read
guest comments", while the 06:00 duty check (`src/guest.ts:614-637`, called from `src/index.ts:627`) reads
`guest_thread` rows (statuses, ids, answer lengths; no model). True of the paid wakes D-043 means, not literally of
every scheduled read.

**L-3. A proposal's debate post is an ordinary post for a moment.** `createProposal` commits the post at
`src/governance.ts:977` and links it with `UPDATE proposals SET post_id` at `:1029`. A guest comment landing in that
window passes the `NOT EXISTS (proposals ...)` guard (`src/guest.ts:239`) and sits on a debate thread, which
`DEFERRED-GUEST-GOVERNANCE-THREADS` excludes. Needs a predicted post id and a few-statement window under a 10-an-hour
cap; the concierge's exclusion has the same shape. Note only.

**L-4. The global hourly attempt meter is cheap to exhaust.** `assertShowhomeRateCap` runs before the token check
(`src/guest.ts:131`), and for the `comment` path the global ATTEMPT cap equals the accepted cap (60,
`src/guest-core.ts:26`). Sixty requests with no token from six addresses (10 each) lock every guest out for an hour, at
no cost, repeatably. Inherited shape (the showhome notes meter attempts too, with 300). Since the accepted-comment hour
bound is now inside the INSERT (`src/guest.ts:243`), the attempt meter's global figure could be raised, or metered after
`authenticateGuest`, without loosening the accepted bound. Follow-up, not a condition.

**L-5. The deploy script says it verifies "zero rows" and does not.** `scripts/deploy-guest-voice.ps1:10-11` and the
DryRun text at `:163` promise zero rows; step 3b (`:193-195`) only checks the count is a number and prints it. Harmless
(the old worker never writes these tables), but an operator reading the dry run is told of a check that is not there.

**L-6. `discharges_duty` in the answer 201 can say true for an answer that did not discharge.** `src/guest.ts:441` is
`citizen.id === 1 && body.length >= 80 && discharged`, where `discharged` is the row's status, which an EARLIER answer
may have set; and `body.length` counts UTF-16 units while the discharge SQL counts `length(a.body)` characters
(`src/guest-core.ts:224`). The live status on every read is right; only this flag can mislead the sender. The local
loop's send step reads the live status (A12), so nothing depends on the flag.

## The questions, answered

1. **Separation.** Holds at `4445c348`. Visitor tokens never reach `authenticate()` (`src/index.ts` guest route reads
   only the body token; `authenticateGuest`, `src/showhome.ts`, reads `guests` then `visitors`); citizen routes hash
   into `citizens` only. Promotion is the second statement of the comment batch, `WHERE changes() = 1`, from values in
   memory (`src/guest.ts:252-263`); the two existing writers to `guest_thread` and the one to `guests` are the only ones
   (grep). No guest row is read by `citizens`/`comments` counts, `ACTIVITY_SQL`, karma or `votes`; `castVote` refuses a
   non-integer id before binding (`src/society.ts:1844`); judgment's moderation targets
   are typed `post|comment` (`src/maintainer/judgment.ts:246,268`) and its detail parser (`:1262`) cannot match
   `guest_comment g17`; no file under `src/maintainer/` names a guest table or calls `readPost`. Test gap L-1 (M4).
2. **Caps.** Every daily cap, the 20,000 ceiling (guest rows only), the duty limits and the accepted-comment hour bound
   are predicates inside the one INSERT (`src/guest.ts:227-245`); the shared 20-a-day citizen cap is inside both
   `createComment`'s INSERT and the answer INSERT, omitted only for citizen #1. The `4445c348` reservation is correct for
   all four paths: my barrier probe forced three per-address pre-reads to overlap at cap-1 through the REAL
   `enterShowhome` and through `assertShowhomeRateCap` for `post` and `reply`: exactly one passed on each; with both
   reservation predicates disabled, `enter` gave three of three (red). No caller relies on a refused attempt being
   recorded: the only other reader, `funnelSnapshot` (`src/showhome.ts:528`), counts accepted reservations, and refused
   pre-checks were never recorded before this wave either.
3. **The duty.** No undischargeable duty found after H1: a duty needs depth + 1 <= 6 (`src/guest.ts:232`); answers are
   allowed on closed topics, collapsed rows and moderated posts, refused only on a removed row (which reads `waived`);
   citizen #1 is exempt from the daily cap and the ceiling counts guest rows only. Statuses come from one expression
   (`src/guest-core.ts:236-245`) used by every reader; the actionable cursor is the numeric predicate. Promise wording: L-2.
4. **Idempotency.** A replay must match author, key, target AND exact body (`src/guest.ts:366-373`); the partial unique
   index stops a second row; a unique-violation retry re-reads and replays or 409s. No path lands both.
5. **Served text.** M-1 is the one false sentence found; L-2 the wording. Every served route exists in `index.ts`; the
   template sentences (Rules 3, 4, the ledger and write sentences) are served only on GET /, which carries the
   corrections block (`src/doc.ts:691-706`). The handle is deny-checked at `enter` (`src/showhome.ts:224`), so the
   comment path's `bulletinDenyCheck(guest.handle, body)` cannot refuse a guest for its handle alone.
6. **Moderation.** One batch through `commitWithModLog`; the chained detail is free text and attest verifies over the
   stored rows (test 18 green). A hidden unanswered duty reads `waived`; moderating the POST does not hide a duty.
7. **Spend.** No model or paid upstream call on any guest path (no guest module imports `anthropic.ts`; the deny check is
   a pure export). The check is 2 statements, defers below the 50 budget, and is threaded into the reconciler's and
   the clerk's spent counts (`src/index.ts:627-635`).
8. **Migration and script.** 0018 is three `CREATE ... IF NOT EXISTS` tables and six indexes, no ALTER, no FK; the
   committed blobs of `schema.sql` end with the migration's block byte for byte (the worktree checkout adds CRLF to
   `schema.sql`; the test normalises it). Script: STOPs proven above; L-5.
9. **The builder's six open items.** All six concur. (1) guest-row targets only: matches `guest_comment_id` in G2.
   (2) 409 on a hidden parent for a guest, answers refused only on removed: as written, and it keeps a collapsed
   critique dischargeable. (3) `openWorldHint: true` on `guest_thread`, `guest_due`, `guest_inbox` is consistent with
   Ben's rule: each returns others' writing or others' records keyed by a public number, none is the caller's own
   authenticated record, and the citizen `inbox` tool is already `true`. (4) and (5) follow the existing inbox
   convention and G5's text. (6) the extra column, CHECKs and indexes are additive and inside the new tables.
10. **Regression.** Citizen inbox cursors: the `-g<n>` part is optional and absent means 0; served only once non-zero.
    MCP: both doors carry the three tools through the same functions. Topic liveness untouched. `/skill.md` 1.1.0 and
    the heartbeat are sha-pinned. No money-path file changed (`x402.ts`, `listings.ts` pay route, `register-gate.ts`).
    The `4445c348` change tightens the live enter/note/reply paths (Q2).

## Mutants

| id | mutation (restored after each) | result |
|---|---|---|
| M1 | guest INSERT without `p.mod_state IS NULL` | GREEN, survived |
| M2 | guest INSERT without the debate `NOT EXISTS` | GREEN, survived |
| M3 | `waived` checked before discharge | GREEN, survived |
| M4 | discharge without `a.author_kind = 'citizen'` | GREEN, survived |
| M5 | `changes()` next_since ignores the guest stream | RED: test 7 (guest-surfaces-d1) |
| M6 | answer INSERT without the removed-target predicate | GREEN, survived |
| M7 | front-page `guest_comments` counts citizen rows | GREEN, survived |
| M8 | duty CASE without `p.kind = 'topic'` | RED: test 14 (guest-comment-d1) |
| M9 | rate reservation without its global predicate | RED: "CODEX r2" (guest-comment-d1) |
| M10 | daily duty limit `<=` instead of `<` | RED: test 14, "the eleventh duty" |
| M11 | `authenticateGuest` ignores `guests` | RED: A1 continuity test |
| M12 | readPost guest page without its `post_id` filter | RED: test 21 (guest-served-text-d1) |
| P1 | barrier probe (scratch test, not committed), both reservation predicates disabled | RED: enter 3/3; the hub's CODEX r2 test also red (3 fulfilled) |

A first probe WITHOUT a barrier stayed green under P1's mutant (the local shim serialises the pre-reads), so it proved
nothing and is not counted; race tests in this harness need a barrier or a direct call, as the checkpoint records.

## Conditions

- **C1 (ride, Ben's hand, immediately after the deploy and before any announcement):** one real `POST /api/showhome/enter`
  answering 201 with a token. The new conditional reservation (`src/showhome.ts:171-178`) runs on every free write,
  enter, note, reply and comment, and the script's ride is GETs only. The `INSERT ... SELECT` with `?NNN` parameters
  shape was proved on real D1 for standing topics (22 Sept) and M2 (30 Sept), not this statement; the one new thing in
  it is a SELECT with no FROM clause (`SELECT ?1, ?2, ?3 WHERE ...`, `:172-176`), where the proved shapes selected FROM
  a table. SQLite accepts that and D1 is SQLite, so this is precision, not a raised risk; but if it fails, every live
  showhome write answers 500: roll back the worker (0018 is harmless to the old one).
- **C2 (watch):** the first real guest comment must show `guest_thread` +1 AND `guests` +1. The comment batch
  (`INSERT ... SELECT` with `?NNN` parameters, then `INSERT OR IGNORE ... WHERE changes() = 1`) was not re-proved on
  real D1 for this wave. A 201 with no `guests` row means the follow-on did not see `changes()`; continuity is then lost
  (tokens still work while in the ring), nothing else.
- **C3 (text, before the deploy):** fix M-1 on its four surfaces and recompute the pins it moves.

Recommended, not conditions: the L-1 pins (M3, M4, M7 first); Ben's wording ruling on L-2; L-4 as a follow-up; L-5 and
L-6 when next in those files.

## Not checked

- Anything on real D1 (C1, C2). I touched no remote database and ran no deploy-script step past step 0.
- The local answer loop `ccca8490..8dcb6dc1` (scripts and their test).
- D1 rows-read cost at the 20,000 ceiling: the ceiling and the global caps are full `COUNT(*)` over an index on every
  guest write, and `/api/stats`, `/api/official` and `/api/guest/due` aggregate the whole table per public call (the
  `DEFERRED-PUBLIC-READ-RATE-CAP` class). Negligible at today's volume; not measured.
- The D-061 guard's moved baseline (76/24/52) beyond the suite passing; the OpenAPI and MCP manifest JSON beyond the
  tool definitions read; every branch of the citizen inbox's `guest_thread` classification (read, mutated by the
  builder, not by me).
