# Checkpoint: /api/proposals refuses unknown parameters (D-078 item 2)

Branch `proposals-unknown-params-2026-10-30`, base `83632cb0`. Spec: `docs/BRIEF-PROPOSALS-UNKNOWN-PARAMS.md` (A1-A5, B1-B3 operative).

## Baseline (83632cb0)
`npm test`: 2812 tests, 2811 pass, 0 fail, 1 skipped. `npm run typecheck`: clean.

## Commits
1. `d328e1ba` tests alone (`test/proposals-unknown-params-d1.test.ts`, 11 tests). Run on unchanged code: 9 fail (1, 2, 3, 4, 5, 6, 6b, 7, 8), 2 pass (9, 10, the PRESERVATION tests, which is what they are for). Every NEW test went red for the stated reason (HTTP 200 instead of 400; MCP not refused; no `additionalProperties`; note sentence absent; counted statements ran).
2. `bcf877ce` the change (below).
3. This log.

## Decisions and deviations
- Validators live in `src/governance.ts` (`assertProposalsQuery`, `assertProposalsArgs`), imported by index.ts, mcp.ts and mcp-read.ts, so both doors and HTTP share one list of accepted keys.
- MCP errors throw SocietyError with code `unknown_argument`; the doors' envelope drops the code (A3), so only the message is served. No envelope change.
- Non-object `arguments` (array, string, number, boolean) refused after the doors' own `?? {}`; explicit `null` still means `{}` (B2). Omission, `{}`, `null` tested as allowed on both doors.
- DEVIATION (small): the MCP tool description does NOT say "(including secret)". `test/secret-literal-guard.test.ts` pins the count of `secret` literals in src/ (80/24/56) and previous waves avoided the word in new text for that reason. Adding the word needed a PROSE_ALLOW entry and a baseline bump; I tried it (sha `8c8ee414...`), saw the baseline test go 81 != 80, and reverted to the wording without the word. The secret-argument refusal itself is still tested (test 6) and the refusal message names `secret` when sent. The guard file is unchanged.
- No doc.ts change, no migration, `/skill.md` and `/heartbeat.md` untouched (they do not mention /api/proposals parameters), no version bump.
- No MCP client convention sending extra arguments to every tool found in src/ (`grep _meta src/mcp*.ts` empty; `_meta` lives in `params`, not `arguments`).
- Test 9 fixture: 202 rows (PROPOSAL_PAGE + 2), the row at index 200 shares `created_at` with index 199. Expectations written independently from fixture ids, not from the function's output. The new note sentence is asserted only in test 7 (not 9/10), as A5 says "separately".
- Test 8: HTTP refusal makes 0 counted statements (`onExec`); MCP refusal makes exactly 2 (the two door_counts writes), and the raw connection confirms both `mcp_tool_call`/`mcp_tool:proposals` (and read-door equivalents) incremented.
- `docs/BRIEF-PROPOSALS-UNKNOWN-PARAMS.md` is untracked in this worktree (it was placed there for the build); not committed by me.

## Red runs
See commit 1 above. Final: 11/11 of the new file pass after commit 2. Full suite after commit 2: 2823 tests, 2822 pass, 0 fail, 1 skipped; typecheck clean. (One intermediate full run failed on the secret-literal guard, the deviation above.)

## Mutation table (PRESERVATION tests)
| Test | One-line mutation | Result |
|---|---|---|
| 9 | `governance.ts` listProposals: `OR (p.created_at = ? AND p.id > ?)` to `AND p.id > ? + 1` (loses the tied row) | red (tests 9 and 10 both) |
| 10 | `mcp-read.ts` proposals branch (line 124): `since_id` argument replaced by `NaN` | red (test 10; test 9 stays green, HTTP untouched) |
| 10 | `mcp.ts` proposals case: `since_id` replaced by `NaN` | red (test 10) |
All reverse-applied with sed on the exact line; `git status` clean afterwards (only the untracked brief).
(A first attempt at the mcp-read mutation hit the wrong line, the suite stayed green, and I re-aimed it: noted because the first green run is not evidence.)

## Served surfaces touched
- `src/governance.ts` listProposals `note`: appended "Only since and since_id are accepted, each at most once: any other query parameter is refused with 400 (unknown_query_parameter), and a repeated one with 400 (repeated_query_parameter), so a filter you expected cannot silently be ignored." Reaches GET /api/proposals and both MCP doors' proposals result.
- `src/discovery.ts` ROUTES entry for GET /api/proposals: `description` now "Open and past governance proposals. Accepts only since and since_id, each at most once; any other query parameter is refused with 400 (unknown_query_parameter or repeated_query_parameter), never silently ignored." Reaches /llms.txt, /openapi.json, /api/surface (asserted on rendered output).
- `src/mcp.ts` proposals tool: description "... Takes only since and since_id: any other argument is refused with an error, never silently ignored."; `inputSchema.additionalProperties: false`. Reaches tools/list on /mcp and /mcp/read (read door filters the same TOOLS).
- New 400 / tool-error messages (governance.ts): "Unknown query parameter(s): ...", "Repeated query parameter(s): ...", "Unknown argument(s) for proposals: ...", "The proposals tool takes an object with optional since, since_id."
- Not touched: doc.ts, skill.md, heartbeat.md, GET / walkthrough.

## DEFERRED
`DEFERRED-PROPOSALS-MALFORMED-CURSOR` planted as a comment at the proposals route in `src/index.ts`.

## Checklist walk
Wired: HTTP route, both MCP dispatch branches, schema, ROUTES. Tests real-D1, real router. No migration, no deploy script (the brief leaves that for after the gate).
