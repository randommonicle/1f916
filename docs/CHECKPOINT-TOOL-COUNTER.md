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

### 4. The seat-count wording (C4, C5; B7, B7a-B7d)

- Five served places, all after parallax (1f3d9 notes 36304 and 36667): `src/society.ts` provenance check for `act_capable` ("It counts seats with no reported key loss; it is a subtraction, not a test, so whether any of them can sign today is not established by it."), the code comment above `actCapable`, the `seatCountsSentence` opening (B7b template: "The census lists N registered citizen(s) and <no reported key loss | one reported key loss | k reported key losses>; current signing ability is not established by those counts (act_capable, X, is that subtraction)", then the acted_30d and operator_paid clauses unchanged, no full stop), the `/api/citizens` note parenthesis, and the `src/discovery.ts` llms.txt parenthesis. The field name `act_capable` stays. No `/skill.md` change: `grep act_capable src/inbox.ts` finds nothing, and the only two files that name it are society.ts and discovery.ts.
- `test/seat-counts-d1.test.ts` lines that changed, and why: the T6 sentence test (the new opening); the order assertion (B7c: the old `indexOf("Of the 14 citizens")` is -1 after the change and `-1 < x` passes vacuously, so it now asserts both indexes are >= 0 first); the singular and unreadable T6 tests (new opening, "no reported key loss"); the `/api/citizens` note assertion (new parenthesis). New: B7a (zero, one, k>1 by pushing a second entry onto `KEY_LOST_SEATS` with a present row in try/finally, and a one-citizen census whose only seat is the lost one) and B7 (no served surface contains "can still act" or "can still sign": /api/official note and provenance, /api/citizens, /llms.txt). The unreadable case stays acted_30d's only (B7d); the existing unreadable test is kept.
- The deploy-script SNAP lines in `test/deploy-penny-three-script.test.ts` and `test/deploy-seat-counts-script.test.ts` match field values, not the sentence: the full suite is green with them unchanged.

### 5. The deploy script (C6)

- `scripts/deploy-tool-counter.ps1` and `test/deploy-tool-counter-script.test.ts`, modelled on `deploy-door-funnel.ps1` (generated from it by checked replacements, then read through). Worker only: no migration, no D1 command, one wrangler subcommand (the stamped deploy). `$LIVE_BASE_COMMIT` = `30a20819237cd65c7f8064809999cd91c122ffb0`; `$REVIEWED_COMMIT` = `TO-BE-SET-BY-HUB`. Written and never run, not even -DryRun.
- Poll: stamped commit and printed version id, AND the doors note naming `mcp_tool:<name>` and `mcp_read_tool:<name>`, AND `/api/official` serving the new seat opening with neither "can still act" nor "can still sign"; the pre-deploy probe proves both words absent first.
- Ride: 14 public reads; the served words; two POSTs (one `tools/call` of `front_page` per door); the read-back needs `mcp_tool_call`, `mcp_tool:front_page`, `mcp_read_tool_call`, `mcp_read_tool:front_page` each up by at least one (four counter updates in all, A2).
- The existing `deploy-door-funnel.ps1` and every other `scripts/deploy-*` file are untouched. Working copies of the ps1 files had CRLF from the machine's autocrlf; they were normalised to LF in the working tree only (the index is LF; nothing line-ending was committed) so the repo's existing LF-checking script tests run.

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

Seat wording (same method):

- R1 k>1 phrase says "one reported key loss": B7a red.
- R2 zero case says "one reported key loss": T6 (singular), B7a red.
- R3 "citizens" always plural: T6 (singular), B7a red.
- R4 the old "can still act" sentence restored: both T6 sentence tests, B7a, B7 red.
- R5 provenance check reverted: B7 red.
- R6 llms.txt parenthesis reverted: B7 red.
- R7 /api/citizens parenthesis reverted: T6 llms/citizens test and B7 red.
- R8 opening reworded to "The census has": the T6 order test and both T6/B7a tests red (so the B7c assertion cannot pass vacuously).

## A3 check (watchman prompt and external scripts)

Searched the project (excluding node_modules, scratch, exchange, Backups, codex-* copies) for `api/doors` and `mcp_tool_call`. Readers of `GET /api/doors` outside the served code: only the deploy scripts under `society/scripts/deploy-*.ps1`. The only one that checks the note is `deploy-door-funnel.ps1`, which pins the phrases "any outcome" and "Requests, not agents" (both still served) and reads the four funnel rows by name, not an exact row set. No non-deploy script under `society/scripts/` reads `/api/doors`. The three watchman drafts in `drafts/` (`WATCHMAN-EDIT-C3`, `WATCHMAN-EDIT-GUEST-DRAFT`, `watchman-prompt-2026-09-26.md`) do not mention it. NOT VERIFIABLE FROM THE REPO: the live watchman routine's prompt is held in the cloud routine, not in a file; the hub should read it for an exact door list before deploy. Nothing outside `society/` was changed.

Deploy script (mutations on the script, tests run, restored by reverse edit):

- S1 allowlist names another deploy script: pins, reviewed-source and allowlist tests red.
- S2 ride sends an initialize instead of tools/call: ride-shape test and in-process ride test red.
- S3 poll drops the seat-wording condition: probes/poll test red.
- S4 Test-OfficialSeatWording ignores the old phrases: its run-for-real test red.
- S5 ride row list loses a per-tool row: pins and in-process ride tests red.
- S6 a wrangler d1 command appears: no-migration test red.
- S7 Test-DoorsNoteCarriesToolRows checks only the first pattern: its run-for-real test red.
- S8 live base pin wrong: pins test red.
- S9 a non-ASCII character: parse/ASCII test red.
- S10 pre-deploy official probe disabled: probes test red.
