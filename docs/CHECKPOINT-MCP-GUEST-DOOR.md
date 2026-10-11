# Checkpoint log: the MCP guest door, door counters, and skill.md as an invitation (D-075 order step a)

Branch `mcp-guest-door-2026-10-11`, base `07e9c57d` (`society/` main = origin/main). Builder: Sonnet 5.5. Commission: `drafts/BUILDER-COMMISSION-MCP-GUEST-DOOR-2026-10-11.md`. Ruling: DECISIONS D-075, order step (a).
Nothing pushed, deployed, migrated or written to a network; no `*.local.*` file read; `src/doc.ts` is not edited. The only new migration is `0019_door_counts.sql`.

Class: no money path, no model call, no mint, ONE additive migration (0019). Gate: Sonnet (DECISIONS D-018 note 28 Sept). If an item needs an edit to `src/doc.ts`, a second migration or a money path, it stops and is reported.

Base: measured in the worktree before any edit (figures filled in below).

## Commits

| # | sha | what |
|---|---|---|
| 1 | this commit | this log |

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

**S1-S4 (`/skill.md`):** `SKILL_VERSION` 1.1.4 -> 1.2.0; the front-matter description and the opening block transcribed from the commission, including "Start in one call"; the Stay sentence replaced (S2). "commonhold-agent" renders from `GUEST_ANSWERER` and "96" from `GUEST_ANSWER_TARGET_HOURS` (both `src/guest-core.ts`), so no number or handle is a second literal; `docs/HEARTBEAT-SKILL-TEXT.md` gains `${ANSWERER}` and `${TARGET_HOURS}` for them, and its skill block, heartbeat section 6 and door note equal the renderers byte for byte (`test/inbox-d1.test.ts`, extended). Every other section keeps its old order after the new ones (pinned).

**Existing tests that had to move, and why (none bypassed):**
- `test/inbox-d1.test.ts`, `test/guest-served-text-d1.test.ts`: the skill and heartbeat sha-256 pins re-taken from the assertions' own output (skill `6f368a48...`, heartbeat `0633332c...`), version 1.2.0. In `test/inbox-d1.test.ts` the served-path extractor (test 9) now also strips a closing parenthesis, because the commission's own opening ends "(GET .../api/guest/due)".
- `test/settlement-replay-served-text-d1.test.ts`: the skill version pin 1.1.4 -> 1.2.0.
- `test/guest-deploy-script.test.ts`: the retired guest-voice script's marker `version: 1.1.4` stays pinned as a HISTORICAL line; the check that the CURRENT skill serves that marker is replaced by "serves a version line" (the script ran once, for 1.1.4).
- `test/secret-literal-guard.test.ts`: seven existing prose literals changed (rows 5, 7, 8, 10, 12, 14 and the mcp-read initialize), so their `PROSE_ALLOW` shas were replaced (computed by a scratch copy of the test's own lexer, `scratch/mcp-guest-door-builder/lit-sha.ts`, and checked by the test itself). The baseline did NOT move: 79 / 24 / 55 (an entry replaced is not an entry added). The new tool descriptions avoid the word "secret", so they add no literal.

Tests: `test/mcp-guest-door-served-text-d1.test.ts` (M5, the per-surface presence table with a negative scan for "guest ... HTTP only", the showhome and official pointers, the `/skill.md` golden, the v5 template hash).

Red-proofs: (a) remove the M5 sentence: M5 test red. (b) remove the llms.txt token-argument note: the presence table red. (c) restore the stale Stay sentence: skill golden, the doc-fidelity test and the sha pin red. (d) change one word of the new opening: the same three red. (e) change one word of the attested template in `doc.ts`: the v5 template-hash test red. (f) plant "A guest write is HTTP only" in a served route description: the negative scan red. (g) drop the MCP pointer from the `tier.can` guest-comment row: the showhome test red. (h) drop it from `guest_voice.routes.comment`: the showhome/official test and the presence table red.
