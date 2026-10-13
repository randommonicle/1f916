# Gate record: door funnel, 13 Oct 2026 (Sonnet gate)

**HEAD gated:** `b5e52805d60102d6584f70c5308795f7fd7fbf5b` (worktree `scratch/wt-door-funnel`, diff `b7cf4182..HEAD`, 9 files).
**Tests:** `npm test` 2505 tests, 2504 pass, 0 fail, 1 skip; `npm run typecheck` exit 0.
**Class check:** no change to `src/society.ts`, `src/doc.ts`, `migrations/`, `schema.sql`, `wrangler.jsonc`, any cron, or any money route; `/mcp/read` gains no tool (READ_TOOLS untouched) and no write path or credential read. No HIGH trigger.

## Verdict: DEPLOYABLE (no conditions). HIGH 0, MEDIUM 0, LOW 3.

## Answers
1. Counting. `src/mcp.ts` tools/call hook is gated by `TOOLS.some(name)`, `src/mcp-read.ts` by `READ_TOOLS.some(name)`: each door's own advertised list, no second list. Both hooks sit before the `try`/dispatch, so a SocietyError refusal or a thrown error still counts once; an unknown, empty or absent name counts nothing. `recordDoor` hands the write to `ctx.waitUntil` and returns a resolved promise; `countDoor` wraps `prepare/bind/run` in try/catch, so a count cannot fail or delay a request in production (ctx is passed at `src/index.ts:297-298`). Cap predicate (`WHERE door_counts.n < ?`) unchanged and applies to the new doors.
2. Read door closed: diff to `mcp-read.ts` is two `recordDoor` lines and a comment.
3. Old doors unchanged. The only changed assertions in `test/door-counts-d1.test.ts` add the stated `mcp_tool_call` on MCP `guest_enter`/`guest_comment`/`showhome_note`/refusals, or move the `tools/list`/`tools/call` no-count assertions to the new funnel test; none is weakened (each still `deepEqual`s the full row set). New tests include a generic-throw case and a missing-table case.
4. Served text true. `DOORS_NOTE` and the `/api/doors` description match the code (received call of a listed tool, any outcome, unknown name not counted). `src/doc.ts` untouched, so FRONT_DOOR_TEMPLATE is byte-identical (v5 pin).
5. Budget. Each counted request is one upsert statement, one row update at most; a guest write over MCP is two statements (two doors), each capped. Ten doors x 2,000 = 20,000.
6. Deploy script. Parses clean with the PowerShell parser (0 errors, 0 non-ASCII bytes). Pins checked before any git/network call. `$LIVE_BASE_COMMIT` = `b7cf4182...` compared with live attest (line 311). Template text byte-compared; migrations/schema.sql diff stops; v5 asserted before and after; no `wrangler d1`. Ride: exactly four POSTs (`tools/list`, `tools/call front_page` on each door), no initialize, no write tool, no credential, announces four door counts; read-back needs each row up by at least one, retries six times. Test accepts the placeholder or 40 lower-case hex only.
7. Runtime. Nothing Node-only: array `.some`, one parameterised upsert, no new binding.

## Findings
- LOW 1: the 20,000 ceiling counts updates; the ten first-of-day inserts also write the primary-key index row, so the true ceiling is up to about 20,010. Immaterial against 100,000.
- LOW 2: `migrations/0019_door_counts.sql:17` and `schema.sql` still list six doors in comments (left on purpose, noted in the checkpoint).
- LOW 3: a listed tool that `callTool` cannot dispatch still counts (receipt-based, as ruled); acceptable.

## Conditions
None. Set `$REVIEWED_COMMIT` to the merged sha before the script can run.
