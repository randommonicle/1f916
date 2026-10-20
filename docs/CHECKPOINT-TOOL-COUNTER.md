# Checkpoint: per-tool MCP call counts (B1-B6, A1-A10) and the seat-count wording (B7, B7a-B7d)

Branch `tool-counter-b7-2026-10-20` at `30a20819` (live worker `1aab93be`). Commission: `drafts/BUILDER-COMMISSION-TOOL-COUNTER-B7-2026-10-20.md`. Brief: `drafts/BRIEF-TOOL-CALL-COUNTER-2026-10-19.md`. Exchanges: `exchange/REVIEW_tool-counter-brief-2026-10-19.md`, `exchange/REVIEW_b7-seat-wording-2026-10-20.md`. Gate tier: Sonnet (no money path, no auth, no migration, no doc.ts, no /skill.md).

Baseline before any edit: 2618 tests, 2617 pass, 1 skipped (`I5`, the deploy-script "hub has set the reviewed commit" test; not this wave's).

## Notes (one per commit)

### 1. Checkpoint started

### 2. The counter (C1) and its tests (C3)

- `src/doors.ts`: `TOOL_DOOR_DAILY_CAP = 100`; a branded `ToolDoor` type made only by `toolDoor(kind, name, list)`, which is the membership test (returns null for a name the door does not list), so a caller cannot skip it (A4: `TOOLS` widens its names to `string`, so a template-literal type would check nothing; `Door` stays closed, a typo in a fixed name is still a type error). `countDoor` binds `capFor(door)` into `COUNT_SQL` and `doorsReport` uses the same `capFor` for `at_cap` (A8). A per-tool door is recognised by the colon prefix; no fixed door name has a colon (tested).
- `src/mcp.ts`, `src/mcp-read.ts`: under the same membership test as before, a listed `tools/call` counts `mcp_tool_call` then `mcp_tool:<name>` (read door: `mcp_read_tool_call`, `mcp_read_tool:<name>`), each through `recordDoor` and so `ctx.waitUntil`. Two separate writes; a successful `guest_enter` / `guest_comment` over MCP now makes three counter updates (A2).
- New `test/tool-counter-d1.test.ts` (T1-T6, A5, T2b). Existing assertions changed, each because a listed `tools/call` now also writes a per-tool row (and for the held-write count, an extra `waitUntil`):
  - `test/door-counts-d1.test.ts`: the `today(d1)` rows after MCP `guest_enter` (two places), `guest_comment` (three places, incl. `showhome_note`, which is a listed tool and so counts `mcp_tool:showhome_note`), the dropped-table `warns` array (adds `mcp_tool:guest_comment`), the held-write `pending.length` (`requests.length + 2`: three counts for `guest_enter`) and its final row set, the `NOTE` literal (the rewritten cap sentence and the per-tool sentence).
  - `test/door-funnel-d1.test.ts`: the exact `today(d1)` rows after `front_page`, `read_post` and `guest_comment` calls, the dropped-table `warns` array (each of the receipt and the per-tool write warns on its own), and the served-rows door list.
  - `test/deploy-door-funnel-script.test.ts`: the in-process ride rows (the ride is `front_page` on each door, so two per-tool rows join the four funnel rows). The old script is untouched.

### 3. Served text for the counter (C2)

- `DOORS_NOTE`: the single-cap sentence rewritten to cover both caps in one sentence (A3); one sentence added: what the per-tool rows count, that they are separate writes with their own cap, and that they need not reconcile exactly with `mcp_tool_call` / `mcp_read_tool_call` (A6).
- `src/discovery.ts` ROUTES description for `/api/doors` (A10): names the per-tool rows and the 100 cap.

## Red-proofs

Counter (each mutation applied, tests run, restored by reverse edit, tree equal to the index afterwards):

- M1 per-tool write removed from mcp.ts: T1, T3, T4, A5 red.
- M2 toolDoor skips the membership test: T2, T2b red.
- M3 capFor always 2000 (SQL not bound to the per-tool cap): T3 red.
- M4 doorsReport at_cap uses 2000 for all rows: T3 red.
- M5 capFor returns 100 for every door (leak onto fixed doors): T3 red.
- M6 mcp-read per-tool write awaited directly instead of through recordDoor/waitUntil: A5 red.
- M7 TOOL_DOOR_DAILY_CAP 1000: T3, T5 red.
- M8 DOORS_NOTE back to the single-cap sentence: T6 red.
- M9 ROUTES description without the per-tool rows: T6 red.
