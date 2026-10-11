# Checkpoint log: the MCP guest door, door counters, and skill.md as an invitation (D-075 order step a)

Branch `mcp-guest-door-2026-10-11`, base `07e9c57d` (`society/` main = origin/main). Builder: Sonnet 5.5. Commission: `drafts/BUILDER-COMMISSION-MCP-GUEST-DOOR-2026-10-11.md`. Ruling: DECISIONS D-075, order step (a).
Nothing pushed, deployed, migrated or written to a network; no `*.local.*` file read; `src/doc.ts` is not edited. The only new migration is `0019_door_counts.sql`.

Class: no money path, no model call, no mint, ONE additive migration (0019). Gate: Sonnet (DECISIONS D-018 note 28 Sept). If an item needs an edit to `src/doc.ts`, a second migration or a money path, it stops and is reported.

Base: 2045 tests (2044 pass, 0 fail, 1 skipped, 68 s) and `tsc` silent, measured in the worktree before any edit. Final: 2093 tests, 2092 pass, 0 fail, 1 skipped.

## Commits

| # | sha | what |
|---|---|---|
| 1 | `c0d303c0` | this log |
| 2 | `f22b37fa` | M1-M4 (and the M5 sentence): the three guest tools on the full `/mcp` door, `test/mcp-guest-door-d1.test.ts` |
| 3 | `c5df07fb` | M5-M6 and S1-S4: the served-text sweep, `/skill.md` 1.2.0, the four reviewer amendments |
| 4 | `8ea38946` | C1-C2: migration 0019, `src/doors.ts`, the hooks |
| 5 | `82db0061` | C3: `GET /api/doors` |
| 6 | this commit | C4: the deploy script and its test; the close |

## Notes (one per commit, newest last)

### 1. this log

Pattern: `docs/CHECKPOINT-CODE-IDENTITY-LOWS.md`. Differences from the commission are noted where they arise, in the commit's own note.

Decisions taken before the first edit, so a reviewer can see them:

- The three guest tools are dispatched from `handleMcp` ahead of `callTool`, through a separate `callGuestTool` that takes no credential at all; the `Authorization` header is extracted only on the non-guest branch. `callTool` and its `secret` line are untouched, so `test/mcp-tool-annotations.test.ts`'s scan of `callTool`'s own source (no tool that calls `authenticate(` is read-only) still reads the same function.
- The deploy script carries `--var CODE_COMMIT:<sha>` from `scripts/deploy-code-identity.ps1`. `scripts/deploy-guest-voice.ps1` (the pattern the commission names) predates served code identity, and a deploy without the flag would serve `commit_status: not_stamped` (each `wrangler deploy` replaces the version's vars). The new script is the guest-voice migration-first shape with the code-identity stamp, reviewed-source check and poll.
- `docs/HEARTBEAT-SKILL-TEXT.md` is the hub-authored source that `test/inbox-d1.test.ts` compares with `renderSkillMd` and `renderHeartbeatMd` byte for byte; the S1-S3 change and any heartbeat edit are made in that file in the same commit as the renderer.

### 2. M1-M4: the three guest tools on the full /mcp door

Base measured before any edit: 2045 tests (2044 pass, 0 fail, 1 skipped), `tsc` silent, in the worktree.

- `src/mcp.ts`: `guest_enter`, `guest_comment`, `showhome_note` in `TOOLS` (after `guest_inbox`), dispatched by `callGuestTool`, which `handleMcp` calls ahead of `callTool` for exactly those names. `callTool` and its `secret` line are untouched. `handleMcp` now extracts the `Authorization` header only on the non-guest branch, and reads `CF-Connecting-IP` on the guest branch, so no credential is computed for a guest tool and the address reaches `enterShowhome` / `postGuestComment` / `postShowhomeNote`, which meter it through the one `showhome_rate` table (M2: one cap across both doors).
- `guest_comment` builds its input from `post_id, kind, parent_kind, parent_id, body` only, the five fields `postGuestComment` reads; `token` is passed separately, as the REST route does.
- Descriptions carry "free, no account, no wallet, no payment", "shown once" and "only credential" (guest_enter), and point at `GET /skill.md` for caps and refusals; no cap number or refused-word list is restated. The word "secret" is avoided in them, so `test/secret-literal-guard.test.ts` needs no new prose entry and its baseline (79 / 24 / 55) does not move.
- The `guest_thread`, `guest_due`, `guest_inbox` descriptions gain one sentence each saying a guest writes with `guest_enter` / `guest_comment` on the full `/mcp` door (they are also served on `/mcp/read`, so the sentence says "full /mcp door"). Each still ends "No auth needed." (the `/mcp/read` cross-check). The comment above them that said there was deliberately no guest write tool, and the one at the old :631 ("a guest write is HTTP only"), are corrected.
- `DEFERRED-GUEST-MCP-WRITE` is retired: the work it deferred is done. `test/guest-deferred-flags.test.ts` drops it from its planted-flag table and pins its ABSENCE from `src/mcp.ts` plus the three tools' presence (a flag naming finished work would be a false claim).
- Existing parity tables updated, not bypassed: `test/mcp-tool-annotations.test.ts` (count 25 -> 28, titles, open-world hints, a new test for the three annotation sets); `test/mcp-read.test.ts` adds the three names to the list that `/mcp/read` must refuse on `tools/call`; its tools/list assertions stay at exactly twelve.
- `/mcp/read` needed no code change: its `callReadTool` switch is a closed set and `READ_TOOL_NAMES` does not name the three.

Tests: `test/mcp-guest-door-d1.test.ts` (real local D1, the real router; REST on one fresh database and MCP on another with the same fixture, rows and bodies compared).

Red-proofs (mutant, then the tests that went red; each restored from the index afterwards):
1. add `guest_comment` to `mcp-read.ts` `READ_TOOL_NAMES`: "/mcp lists the three ... /mcp/read lists none" red (the tools/call refusal test stays green: the two layers are independent, as designed).
2. pass `null` instead of the address from `guest_comment`: the M2 mixed-door cap test red (the eleventh call is refused by the per-guest day cap, not the address cap).
3. `args.token ?? args.secret` in `guest_comment`: both M3 tests red (behavioural and source-order).
4. drop `kind` from the built input: the guest_comment parity test red (the critique stops accruing a duty).
5. drop `parent_kind`: the same test red (the reply loses its parent).
6. make `guest_enter` throw a different message: the refusal-parity test red.
7. read the `Authorization` header before the guest branch: the M3 source-order test red.
8. the retired flag reappears in `src/mcp.ts`: the flag-retirement test red.
9. change a guest tool's title: the C5 titles test red.
10. mark `guest_enter` read-only: the new annotations test and the M1 annotations test red.

### 3. M5-M6: the initialize sentence and the served-text sweep (and the four reviewer amendments)

**Reviewer amendments (GEMINI r1, CODEX r2), applied in this commit:**
1. Deploy-script catalogue check: `door_counts` has THREE columns (`day`, `door`, `n`) plus the primary key `(day, door)`, not four. The script and its test (commit 6) say three.
2. `src/doc.ts` is NOT edited. The ban stands for `FRONT_DOOR_TEMPLATE`; outside it, `showhomeDoorNote` (the door note on `GET /`) only LISTS the HTTP routes and never claims they are the only door, so by the amendment's own test it is not false and is left alone. Template unchanged is proved by `test/mcp-guest-door-served-text-d1.test.ts` (`/api/attest` serves the v5 `template_hash` `fa11788d...`) and by the existing golden and constitution tests passing with no fixture edit. The one GET / door note I could add an MCP pointer to without touching `doc.ts` is `heartbeatDoorNote` (`src/inbox.ts`), which I did.
3. Annotations: `guest_enter` and `showhome_note` are `destructiveHint: true`, for the reason CODEX gave: `enterShowhome` ring-prunes older visitor rows (`DELETE FROM visitors WHERE id <= ...`, `SHOWHOME_VISITORS_RING`) and `postShowhomeNote` ring-prunes older notes (`SHOWHOME_NOTES_RING`). `guest_comment` stays `destructiveHint: false`: I checked `postGuestComment` and it has no DELETE; its writes are the guarded INSERT into `guest_thread` and `INSERT OR IGNORE INTO guests`, and at `GUEST_ROW_CEILING` it refuses rather than evicts ("It is never evicted: the record is promised persistent"). The only deletion on its path is `assertShowhomeRateCap` pruning `showhome_rate` rows older than 24 h, which is the cap's own bookkeeping, shared by every showhome write and invisible to a reader. `test/mcp-tool-annotations.test.ts` pins the three annotation sets AND that the two prunes (and the absence of a delete in `postGuestComment`) are really in the functions the tools call.
4. M3 wording: the three guest tools are dispatched before `callTool` can compute `secret`, and they IGNORE `args.secret` and the `Authorization` header (comments and this log say "ignored", not "never read"). My implementation is stricter than the amendment requires: `handleMcp` extracts the header only on the non-guest branch (the global extraction could have stayed); a source-order test pins that. The behavioural test is kept: a citizen bearer plus a guest call with no token is refused as a missing token (the same 401 as REST).

M5: the `initialize` sentence on `/mcp` was written in commit 2 (it sits in `handleMcp` with the tools); `test/mcp-guest-door-served-text-d1.test.ts` pins it verbatim and pins that the rest of the instructions is unchanged.

**M6 sweep: every changed served line** (a grep of all of `src/` for "HTTP only", "HTTP door", "guest write", "MCP" and "HTTP" was read hit by hit; the hits that are NOT changed are listed after the table):

| # | file | surface | change |
|---|---|---|---|
| 1 | `src/mcp.ts` | tool descriptions `guest_thread`, `guest_inbox`, `guest_due` (`/mcp` and `/mcp/read` tools/list) | one sentence each: a guest writes with `guest_enter` / `guest_comment` on the full `/mcp` door; each still ends "No auth needed." |
| 2 | `src/mcp.ts` | comments at the old :436-439 and :631 ("no guest WRITE tool", "a guest write is HTTP only") | corrected (not served) |
| 3 | `src/mcp.ts` | `/mcp` `initialize` instructions | the M5 sentence prepended |
| 4 | `src/mcp-read.ts` | `/mcp/read` `initialize` instructions | adds "A guest takes part free over the full door too, with guest_enter, guest_comment and showhome_note (no account, wallet or payment)." |
| 5 | `src/mcp-read.ts` | the `/mcp/read` refusal message for a non-read tool | adds "; a guest writes there free with guest_enter, guest_comment and showhome_note." |
| 6 | `src/discovery.ts` | `ROUTES` `/mcp` description (so `/llms.txt`, `/api/surface`) | adds the guest sentence |
| 7 | `src/discovery.ts` | `ROUTES` `/mcp` note | adds "the three guest tools take a visitor token as their token argument and read no citizen credential" |
| 8 | `src/discovery.ts` | `ROUTES` `/mcp/read` description | "Writes need a citizen credential" becomes "Citizen writes need ...; a guest takes part there free with ..." |
| 9 | `src/discovery.ts` | `AUTH_LABEL.visitor_token` (llms.txt, /api/surface) | "(over MCP, the token argument of guest_comment and showhome_note)" |
| 10 | `src/discovery.ts` | `/llms.txt` Connect block | "Writes need a citizen credential over /mcp" becomes "Citizen writes need ...; a guest takes part there free with ..." |
| 11 | `src/discovery.ts` | `/llms.txt` Showhome paragraph | a paragraph naming the three tools and the token-argument rule |
| 12 | `src/discovery.ts` | `/llms.txt` "Not every write takes one" paragraph | "(the token argument over MCP)" |
| 13 | `src/discovery.ts` | `/.well-known/mcp.json` `auth.required_for` | "write tools only" becomes "citizen write tools only; the three guest tools ... take a visitor token ... and no citizen credential" |
| 14 | `src/discovery.ts` | `/openapi.json` `info.description` | the write routes take a citizen credential OR, for a guest's comment and note, a free visitor token (HTTP route or the `guest_enter` tool) |
| 15 | `src/showhome.ts` | `GET /api/showhome` `what`, `tier.can` x2 | name the MCP tools beside the HTTP routes |
| 16 | `src/showhome.ts` | `POST /api/showhome/enter` response `next` | adds the MCP tool names (same body over both doors) |
| 17 | `src/guest-core.ts` | `GET /api/official` `guest_voice.routes.comment` | adds "or the guest_comment tool on POST /mcp (the token argument)" |
| 18 | `src/inbox.ts` | `/heartbeat.md` section 6 | "POST .../api/guest/comment, or the guest_comment tool on .../mcp, and your token" |
| 19 | `src/inbox.ts` | door note on `GET /` (`heartbeatDoorNote`) | one sentence: a guest can take part free over MCP as well as HTTP |
| 20 | `src/inbox.ts` | `/skill.md` | S1-S4 (below) |

Hits read and NOT changed: `src/doc.ts` (outside the template, `showhomeDoorNote`: lists HTTP routes without claiming exclusivity; inside the template, the prose tool list `:255-259` says "this list is prose and the server is the truth" and already omitted `guest_thread`, `guest_due`, `guest_inbox` and `inbox`, so three more absent names leave it exactly as true as it was; its line "register ... the HTTP door above" is about registration, which IS HTTP-only); the `register` tool's "(HTTP only)" title and description (registration IS HTTP-only); the `ROUTES` `/api/attest` entry (a grep of it for "MCP", "guest" and "HTTP" finds nothing to correct: it describes the `code` block and `answered_by`); `guestTemplateExceptions().writes` ("take the visitor token in the request body": a tool call's arguments are in the request body, so it stays true); `/skill.md` "Credentials" (S4: unchanged); `src/index.ts` comments (not served).

**S1-S4 (`/skill.md`):** `SKILL_VERSION` 1.1.4 -> 1.2.0; the front-matter description and the opening block transcribed from the commission, including "Start here"; the Stay sentence replaced (S2). "commonhold-agent" renders from `GUEST_ANSWERER` and "96" from `GUEST_ANSWER_TARGET_HOURS` (both `src/guest-core.ts`), so no number or handle is a second literal; `docs/HEARTBEAT-SKILL-TEXT.md` gains `${ANSWERER}` and `${TARGET_HOURS}` for them, and its skill block, heartbeat section 6 and door note equal the renderers byte for byte (`test/inbox-d1.test.ts`, extended). Every other section keeps its old order after the new ones (pinned).

**Existing tests that had to move, and why (none bypassed):**
- `test/inbox-d1.test.ts`, `test/guest-served-text-d1.test.ts`: the skill and heartbeat sha-256 pins re-taken from the assertions' own output (skill `6f368a48...`, heartbeat `0633332c...`), version 1.2.0. In `test/inbox-d1.test.ts` the served-path extractor (test 9) now also strips a closing parenthesis, because the commission's own opening ends "(GET .../api/guest/due)".
- `test/settlement-replay-served-text-d1.test.ts`: the skill version pin 1.1.4 -> 1.2.0.
- `test/guest-deploy-script.test.ts`: the retired guest-voice script's marker `version: 1.1.4` stays pinned as a HISTORICAL line; the check that the CURRENT skill serves that marker is replaced by "serves a version line" (the script ran once, for 1.1.4).
- `test/secret-literal-guard.test.ts`: seven existing prose literals changed (rows 5, 7, 8, 10, 12, 14 and the mcp-read initialize), so their `PROSE_ALLOW` shas were replaced (computed by a scratch copy of the test's own lexer, `scratch/mcp-guest-door-builder/lit-sha.ts`, and checked by the test itself). The baseline did NOT move: 79 / 24 / 55 (an entry replaced is not an entry added). The new tool descriptions avoid the word "secret", so they add no literal.

Tests: `test/mcp-guest-door-served-text-d1.test.ts` (M5, the per-surface presence table with a negative scan for "guest ... HTTP only", the showhome and official pointers, the `/skill.md` golden, the v5 template hash).

Red-proofs: (a) remove the M5 sentence: M5 test red. (b) remove the llms.txt token-argument note: the presence table red. (c) restore the stale Stay sentence: skill golden, the doc-fidelity test and the sha pin red. (d) change one word of the new opening: the same three red. (e) change one word of the attested template in `doc.ts`: the v5 template-hash test red. (f) plant "A guest write is HTTP only" in a served route description: the negative scan red. (g) drop the MCP pointer from the `tier.can` guest-comment row: the showhome test red. (h) drop it from `guest_voice.routes.comment`: the showhome/official test and the presence table red.

### 4. C1-C2: migration 0019 and the door counters

- `migrations/0019_door_counts.sql` (new) and the same block at the end of `schema.sql`: `door_counts(day TEXT NOT NULL, door TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, door))`. Written across lines (the columns and the key are the commission's, in its order); nothing else in either file changed. No foreign key, no CHECK on `door` (a new door is then a code change, not a migration), no pruning (at most six rows a day).
- `src/doors.ts` (new): `DOORS` (six, in the commission's order), `DOOR_DAILY_CAP = 2000`, `countDoor(env, door, now)` (the one statement `INSERT ... ON CONFLICT (day, door) DO UPDATE SET n = n + 1 WHERE door_counts.n < ?`; every error caught and logged once as `{"level":"warn","event":"door_count_failed","door":...}`, never thrown), and `recordDoor(env, ctx, door)` (hands the write to `ctx.waitUntil` and returns a resolved promise; with no ctx it returns the promise so a test can await it).
- Hooks: `src/index.ts` (`skill_md` and `heartbeat_md` on a 200 GET; `showhome_enter` and `guest_comment` after the shared function returned on the REST routes), `src/mcp.ts` (`mcp_initialize`; `showhome_enter` and `guest_comment` after `callGuestTool` returned), `src/mcp-read.ts` (`mcp_read_initialize`). The Worker's `fetch` takes `ctx?` (optional, so `worker.fetch(request, env)` in every existing test is unchanged) and passes it to both MCP handlers, which take an optional third parameter. `showhome_note` has no door (it is not one of the six) and counts nothing on either path.
- `test/guest-migration-d1.test.ts`: its "schema.sql ends with exactly the migration's block" check became "contains the block, followed by nothing but later migrations' blocks" (today the door block), with a stray block failing it. The guest block is no longer the last in `schema.sql`; that is the only existing assertion this commit moved.

Tests: `test/door-counts-d1.test.ts` (migration against a real SQLite engine; each hook increments exactly its door once; refusals count nothing on either door; the cap, also under five concurrent calls; a new UTC day is a new row; the table missing leaves every counted route answering as before with one warn line per failed count; with a ctx none of six counted routes waits for its count).

Red-proofs: (1) the migration loses its primary key: C1 red. (2) the cap predicate becomes `WHERE ? > 0`: the cap test red (it reads 2003). (3) the MCP `guest_enter` counted BEFORE the shared function: the enter test red (a refused enter counted) and the ctx test red. (4) the `skill_md` hook removed: hooks, missing-table and ctx tests red. (5) the heartbeat hook counts `skill_md`: the same three red. (6) `countDoor` rethrows: the missing-table test red. (7) `recordDoor` returns the promise even with a ctx: the ctx test red after its 1.5 s timeout (the request waited). (8) `index.ts` drops ctx for `/mcp`: the ctx test red. (9) the REST guest comment counted before the shared function: the guest_comment test and the missing-table test red. (10) a stray table block appended to `schema.sql`: the C1 test red.

### 5. C3: GET /api/doors

- `src/doors.ts`: `doorsReport(env, now)` reads `door_counts` for the last 30 UTC days (today and the 29 before it; `DOOR_WINDOW_DAYS`), `ORDER BY day DESC, door ASC`, and serves `{window_days, rows: [{day, door, n, at_cap}], note}`. `at_cap` is `n >= DOOR_DAILY_CAP`. The `note` is the commission's text verbatim (`DOORS_NOTE`; the "2000" is rendered from `DOOR_DAILY_CAP`, so the cap and its sentence cannot drift). `window_days: 30` is the one field beyond the commission's `rows` and `note`: without it an empty list does not say what window it is empty over. A (day, door) with no count is absent, not a zero row.
- `src/index.ts` dispatches it (next to `/api/stats`); `src/discovery.ts` `ROUTES` lists it (GET, `auth: none`, the note as the route note, a `grepFor` that `index.ts` carries), so `/llms.txt`, `/openapi.json` and `/api/surface` list it with no further edit, and the existing drift guards (`test/discovery.test.ts`) cover it. The route counts nothing itself.
- With the table missing the read answers the router's generic 500: the deploy script applies migration 0019 BEFORE the worker, so that state is not reachable through the script; I did not add a second failure mode for it.

Tests (in `test/door-counts-d1.test.ts`): shape, order, the 30-day boundary (day 29 in, day 30 out), `at_cap` at 2000 and not at 1999, the note verbatim, an empty table is an empty list, POST is a 404, the read counts nothing, an end-to-end cap (a door driven to the cap by real GETs reads `at_cap: true`), and the route is in `ROUTES`, `/llms.txt`, `/openapi.json` and `/api/surface` with the `grepFor` really in `index.ts`.

Red-proofs: (1) ascending order: red. (2) a 31-day window: red (day 30 appears). (3) `at_cap` uses `>`: red, twice. (4) one word of the note changed: red, twice. (5) the route not dispatched: red, four tests including the existing drift guard. (6) the `ROUTES` entry removed: the listing test red.

### 6. C4: the deploy script and its test; the close

- `scripts/deploy-mcp-guest-door.ps1` (new, never run, not even `-DryRun`): the migration-first shape of `scripts/deploy-guest-voice.ps1` with the stamp, the reviewed-source check, the test-summary parser and the propagation poll of `scripts/deploy-code-identity.ps1`. `$LIVE_BASE_COMMIT = 07e9c57d9339a7a8a8acf4b3f9c28674b6eccbd4`, `$ROLLBACK_WORKER_VERSION = 0ed544ae-5ec0-4301-8910-2bcf255caffe` (named in the rollback line), `$REVIEWED_COMMIT = TO-BE-SET-BY-HUB`, with the allowlist this script, its test and `docs/`. Steps: fetch and the one-commit pin; HEAD contains the live base; `src/doc.ts` unmoved (non-minting); exactly one added migration since the live base and it is `0019_door_counts.sql`; reviewed source; the gates; live before (v5, the new route `GET /api/doors` answers 404, the guest and showhome tables are on prod, `door_counts` state); the `-DryRun` exit; migration 0019 to the REMOTE D1 first; the catalogue read (THREE columns `day`, `door`, `n` in order, the primary key `(day, door)` in key order, no foreign key, one automatic index); `npx wrangler deploy --var "CODE_COMMIT:<sha>"` and the single `Current Version ID`; the poll until `/api/attest` serves that commit and id AND `/api/doors` answers 200; attest (v5, every chain); the ride.
- `-DryRun` reads the remote D1 through wrangler (reads only) like `deploy-guest-voice.ps1`; the header says so and says it was never run. Nothing in the script executes any wrangler subcommand but `d1 execute` and `deploy` (pinned by the test; the rollback is text for Ben).
- The ride (Ben's run): the 13 public reads, `/skill.md` 1.2.0, `POST /mcp` `initialize` (carries the guest sentence), `tools/list` (lists the three guest tools; `/mcp/read` lists none), and ONE real free write, `POST /mcp tools/call guest_enter` (handle `deploy-ride`, token discarded unread), then reads `/api/doors` back (with retries: the count is on `ctx.waitUntil`) for `skill_md`, `heartbeat_md`, `mcp_initialize`, `showhome_enter`. A missing count is a STOP that says it is not by itself a rollback signal.
- A bug the test caught before it could cost a deploy: the first draft checked `/mcp/read`'s tools/list for the bare words `guest_enter` etc., but M6 put those words into the `guest_thread`, `guest_inbox` and `guest_due` descriptions, which `/mcp/read` serves. A bare-word check would have STOPPED a good deploy. The script (and its test) now check the tool NAMES (`"name":"guest_enter"`).
- Another, in the first draft: PowerShell's `-and` and `-or` have EQUAL precedence, so a condition mixing them reads differently from how it looks. The test now fails any group that mixes them (innermost parentheses first, with a positive control).

Tests: `test/deploy-mcp-guest-door-script.test.ts` (17): parses under PowerShell's own parser, ASCII, no traps, parameters, the pins, the step order, wrangler used for three things only, the one-commit pin, non-minting and one migration, the prerequisites and `-MigrationAlreadyApplied` both ways, the 404 probe and the poll, the column lists equal to the migration's and `schema.sql`'s, the definitions region runs nothing (throwing stubs), `Assert-DoorTable` RUN FOR REAL against a stand-in for the remote read (the right three pass; a fourth column, a missing column, a wrong order, a wrong key, a reversed key, a foreign key and a missing key index each STOP), the reviewed-source check RUN for the placeholder and for a non-hex value, `Get-DisallowedPaths` and `Get-TestSummary` run for real, and the ride's targets served by the new code in a local D1.

Red-proofs: (1) a fourth column in the script's list: the columns test and the real `Assert-DoorTable` run red. (2) the catalogue read removed: the order test red. (3) the stamp removed from the deploy line: the wrangler test red. (4) `$REVIEWED_COMMIT` set by the builder: the pins test red. (5) `Assert-DoorTable` ignores the column count: the real run red. (6) an executed `npx wrangler rollback`: the wrangler test red. (7) a non-ASCII character: the parse/ASCII test red. (8) `-and` beside `-or`: the traps test red (after the check was rewritten to look inside parentheses; its first version looked only outside them and missed this mutant). (9) the `src/doc.ts` no-mint check dropped: the non-minting test red.

## Close: the checklist walk

| commission item | state |
|---|---|
| M1 three tools, same functions, five REST fields only, annotations (amended: enter and note destructive), titles, descriptions | done, commit 2 and 3 |
| M2 address read like REST; one cap across both doors | done; mixed-door cap test; mutant (null address) red |
| M3 token from `args.token` only; dispatched before `callTool` computes `secret`; bearer plus token speaks as guest; bearer without token refused | done ("ignored" wording per amendment 4) |
| M4 `/mcp/read` read-only, stays twelve, a test pins it | done |
| M5 initialize sentence | done (commit 2), pinned verbatim (commit 3) |
| M6 served-text sweep, `src/doc.ts` unedited, every changed line listed | done, commit 3 note; `heartbeatDoorNote` is the one GET / door note that gained a pointer |
| C1 migration 0019 and `schema.sql` | done |
| C2 `src/doors.ts`, hooks on REST and MCP, never throws, `ctx.waitUntil`, count after success | done |
| C3 `GET /api/doors`, listed everywhere | done |
| C4 deploy script and test | done, never run |
| S1-S4 `/skill.md` | done, commit 3 (with M6: the skill is one of the M6 surfaces and its pins moved together) |
| Tests, red-proofed | each note lists its mutants |
| Full `npm test` and `npm run typecheck` green, tree clean | 2093 tests, 2092 pass, 0 fail, 1 skipped (the base had 2045, 2044 pass, 1 skipped); `tsc` silent; `git status` clean |

## Differences from the commission, and points for the hub

- Order: S1-S4 landed in commit 3 with M6 (the skill is an M6 surface and its sha pin, doc and version moved with the same text), not commit 7; M5 landed in commit 2 beside the tools. Commit 6 is the deploy script and this close.
- `handleMcp` extracts the `Authorization` header only on the non-guest branch (stricter than amendment 4 requires).
- `/api/doors` serves `window_days: 30` beside `rows` and `note`.
- The deploy script carries `--var CODE_COMMIT` (the guest-voice pattern predates served code identity) and a real guest_enter ride; its `-DryRun` reads the remote D1.
- `docs/HEARTBEAT-SKILL-TEXT.md` (the hub-authored source that `test/inbox-d1.test.ts` compares byte for byte) was edited for the new skill block, heartbeat section 6 and the door note, with two new placeholders; the served-path extractor in that test now also strips a closing parenthesis (the commission's own opening ends "(GET .../api/guest/due)").
- `DEFERRED-GUEST-MCP-WRITE` is retired; `test/guest-deferred-flags.test.ts` pins its absence.
- Seven existing prose literals changed, so seven `PROSE_ALLOW` shas in `test/secret-literal-guard.test.ts` were replaced; the baseline stayed 79 / 24 / 55.
- `showhomeDoorNote` (in `src/doc.ts`, outside the template) lists the HTTP routes and says nothing about MCP; it is not false, so by amendment 2 it is untouched. If the hub wants an MCP line on `GET /` it can ride a later `doc.ts` edit, or stay in `heartbeatDoorNote` as now.
- A mistake of mine, disclosed: early on I ran an interpreter heredoc (`python3 - <<'EOF'` with an empty body) by reflex, against the rule. It did nothing (Python is not installed; the call hung and I stopped the task). No file was written by it. All later edits used the file tools, `sed -i`, `git` and `node --test`.
- One scratch aid outside the repo: `scratch/mcp-guest-door-builder/lit-sha.ts`, a copy of the secret-literal guard's own lexer, used to compute the replacement shas. Nothing under `scratch/` is in the branch.
