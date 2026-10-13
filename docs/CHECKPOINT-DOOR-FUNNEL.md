# Checkpoint: the door funnel (13 Oct 2026)

Brief: `drafts/BRIEF-DOOR-FUNNEL-2026-10-13.md` (amendments A1-A7; D2 dropped). Commission: `drafts/BUILDER-COMMISSION-DOOR-FUNNEL-2026-10-13.md`.
Base `b7cf4182` (live worker `cfb3cfe5`), branch `door-funnel-2026-10-13`. Baseline 2474 tests: 2473 pass, 1 skip; tsc clean.
Class: no money route, no auth change, no register path, no model call, no mint, no migration, no `schema.sql` edit, no cron.

## Notes

1. Checkpoint started. Worktree `scratch/wt-door-funnel`, `node_modules` junction to `society/node_modules`.
2. C1+C2+C3 (`b9ee9d4f`, one commit because the served-text tests need the doors and the doors need the tests): `DOORS` gains `mcp_tools_list`, `mcp_read_tools_list`, `mcp_tool_call`, `mcp_read_tool_call`.
   `tools/list` is counted in `handleMcp` / `handleMcpRead` beside the initialize hook. `tools/call` is counted on RECEIPT, before dispatch, when the name is in THAT door's own list
   (`TOOLS` in `src/mcp.ts`, `READ_TOOLS` in `src/mcp-read.ts`); an unknown name counts nothing. `ctx` was already threaded to both handlers (`src/index.ts:297-298`), nothing to thread.
   The guest-write doors still count only after success, so a successful MCP `guest_enter` now moves TWO rows (`mcp_tool_call` on receipt, `showhome_enter` after success): five existing
   assertions in `test/door-counts-d1.test.ts` were updated for that (and one for the `tools/list` and `tools/call` it used to assert counted nothing). Served text: the cap comment in
   `src/doors.ts` now says ten doors, 20,000 of 100,000; `DOORS_NOTE` and the `/api/doors` route description (`src/discovery.ts`) name the doors and say received requests, any outcome,
   requests not agents; `DEFERRED-LISTING-ATTRIBUTION` planted beside `DOORS`. `/mcp/read` gained no tool and no write path.
3. STALE LISTS LEFT ALONE ON PURPOSE (A4): the six-door lists in `migrations/0019_door_counts.sql:17` and `schema.sql:534-536` are comments only; the deploy script stops on any change there.
4. C4 (`bb7e6eec`): `scripts/deploy-door-funnel.ps1` + `test/deploy-door-funnel-script.test.ts`. Written and never run (not even -DryRun). The ride sends FOUR read-only POSTs (a `tools/list` and a
   `tools/call` of `front_page` to each door), so it ADDS FOUR DOOR COUNTS and says so; the read-back needs each new row to have risen by AT LEAST one (other callers may add more) and
   retries six times 3 s apart because the counts go through `waitUntil`. It STOPS if a new row is already at its cap or the UTC day rolls mid-ride. The in-process test replays the script's
   own JSON bodies against the real router and requires exactly the four rows, one each, and nothing else.

## Red-proofs (each mutant applied, the named tests run red, the file restored from the index)

`test/door-funnel-d1.test.ts` and `test/door-counts-d1.test.ts`:

- hook moved AFTER dispatch on `/mcp`: 10 red (including the generic-throw test); on `/mcp/read`: 6 red.
- `/mcp` unknown names counted (`if (true)`): 2 red; `/mcp/read`: 4 red.
- `/mcp/read` membership taken from `TOOLS` instead of `READ_TOOLS`: 2 red.
- `/mcp` `tools/list` counts the read door's name: 8 red; `/mcp/read` `tools/call` counts the full door's name: 12 red.
- `countDoor` re-throws instead of logging (missing table): 4 red.
- route description drops `mcp_tool_call`: 2 red; `DOORS_NOTE` drops `mcp_read_tools_list`: 6 red; `DOORS` drops `mcp_read_tool_call`: 4 red.

`test/deploy-door-funnel-script.test.ts` (script mutants): upper-case reviewed pin 4 red; wrong live base 2; migration stop disabled 2; ride calls `guest_enter` 4; ride announcement removed 4;
moved needs +2 instead of at least one 2; note probe skips the fourth door 2; pre-deploy absent probe removed 2; a non-ASCII byte 2; day-roll stop removed 2; stuck-row stop removed 2;
a `wrangler d1` line added 2; a `$var:` drive reference 4. Every mutant red, restored, baseline green.

## Done

Full `npm test` and `npm run typecheck` green on the final tree (counts in the report).
