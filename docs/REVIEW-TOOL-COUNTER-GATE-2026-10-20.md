# D-018 Sonnet gate: tool counter + B7 seat wording (branch tool-counter-b7-2026-10-20, 6e987f18, base 30a20819)

VERDICT: DEPLOYABLE WITH CONDITIONS (HIGH 0, MEDIUM 0)

Evidence: npm test 2651 tests, 2650 pass, 0 fail, 1 skipped (pre-existing skip not examined); tsc clean. Diff touches no migration, schema, src/doc.ts, money or auth path (git diff --stat).

## Conditions
C1. Hub sets $REVIEWED_COMMIT (scripts/deploy-tool-counter.ps1:~37) to the final reviewed sha; step 0a stops until then. Only scripts/deploy-tool-counter.ps1, its test and docs/ may change after it.
C2. Ben's per-action word for push and deploy; run -DryRun first.

## Checked
- No unlisted name creates a row: toolDoor (src/doors.ts:~49) is the membership test and the only constructor of ToolDoor; mcp.ts:~975 and mcp-read.ts:~209 count both rows only when it returns non-null. Each door tests its own list (a name /mcp/read lacks cannot create mcp_read_tool:<n>).
- Counter failures cannot alter/delay answers: countDoor catches everything; recordDoor hands it to ctx.waitUntil; tests T4/A5 cover either write failing alone and the held-write path.
- Cap applied where enforced: countDoor binds capFor(door) (100 per-tool, 2000 fixed); doorsReport at_cap uses the same function. Fixed names cannot match the "mcp_tool:" prefixes (colon).
- Budget: 50 names x100 + 10x2000 = 25,000 increments, x2 index = 50,000 < 60,000 stated bound; derived from list lengths (T5).
- Served text: DOORS_NOTE, /api/doors route text, act_capable provenance, seat opening (keyLost 0/1/k, N=1), /api/citizens note and llms.txt are true against code; "can still act/sign" survives only in a code comment quoting it (society.ts:1817), not served.
- Deploy script: pins checked before any git/network; main=origin=expected; clean tree; live base proven against /api/attest; template byte-identical; no migration/schema diff; gates re-run with end-anchored summary; new-words-absent probe makes the poll meaningful; rollback target read live. Ride is two read-only front_page POSTs (front_page exists in TOOLS; isError string only appears on error results, so no false stop), four counter rows move, UTC-day roll and at_cap guarded.

## Findings
LOW-1 src/doors.ts:13-15 comment reads awkwardly ("in the project folder outside this repo B1-B5"); comment only.
LOW-2 Mid-ride, a tool-call flood from outsiders cannot break the ride (check is "rose by at least one"), but if mcp_tool:front_page is already at 100 the script stops pre-ride with a clear message: failure scenario is a false stop on a busy day, safe direction.
LOW-3 A3 asked to check the watchman prompt and scripts reading /api/doors for exact door lists; I could not find such a reader in this worktree (the routine prompt lives outside the repo). Hub to confirm it does not match an exact row set; extra rows are additive in the same shape.
LOW-4 Fixed-door-by-prefix is an implicit convention: a future fixed door named "mcp_tool:x" would get cap 100. Not reachable today (Door union closed).
