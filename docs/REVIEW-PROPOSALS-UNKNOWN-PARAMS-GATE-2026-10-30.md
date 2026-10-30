DEPLOYABLE

# D-018 gate: proposals unknown-parameter refusal (D-078 item 2), 2026-10-30

Scope: `git diff 83632cb0 HEAD` on branch `proposals-unknown-params-2026-10-30` (head `cdb87f0f` before this record). Worker-only, no migration. Reviewer: Sonnet 5.5 gate (read-only-field/non-money wave, D-018 amendment). Findings: HIGH 0, MEDIUM 0, LOW 2. Conditions: none.

## Checks

1. Production callers. `grep -rn "api/proposals" src scripts` finds only plain, parameter-free GETs (the four `scripts/deploy-proposals-*.ps1` and `deploy-register-free-path.ps1` read `$BASE/api/proposals` with no query) and served prose that names the route without a parameter (`src/doc.ts:254,446,464`, `src/society.ts:1841`). No `?status=`, `?limit=` or other example anywhere in `src/`, `scripts/` or the root docs. The only `?since=...&since_id=...` text is the list's own paging note, using the two accepted keys. No script, cron or maintainer code calls the MCP `proposals` tool with arguments (grep empty).
2. Served text. `git diff 83632cb0 HEAD -- src/doc.ts` is empty: constitution template untouched, no re-mint. Changed served strings (ROUTES description, listProposals `note`, MCP tool description) all say what the code now does. `/skill.md` and `/heartbeat.md` untouched and do not describe this route's parameters.
3. Correctness. `src/governance.ts:1212-1232`: `assertProposalsQuery` collects unknown keys first (deduplicated, case-sensitive, empty key unknown), then checks repeats of known keys, throws 400 with codes `unknown_query_parameter` / `repeated_query_parameter`. `src/index.ts:640-649`: the call is the first statement of the branch, before `listProposals`; the new test counts 0 D1 statements on refusal. `assertProposalsArgs` is called after the doors' own `?? {}` (`src/mcp.ts:984`, `src/mcp-read.ts:218`), so null/omitted stays allowed and array/string/number/boolean are refused; the throw goes through the existing isError envelope (message only, unchanged envelope). Both doors call the same function. `additionalProperties: false` added to the tool schema is advertisement only and agrees with the runtime check.
4. Tests. `npm test` in the worktree: 2823 tests, 2822 pass, 0 fail, 1 skipped. `npm run typecheck`: clean (tsc, no output). The new file's refusal tests were red on the base (9 of 11, per the checkpoint) and the preservation tests (paging with tied `created_at`, MCP `since_id`) carry recorded one-line mutations that went red.
5. Other. Working tree clean apart from the untracked brief (not part of the diff). No migration, no money path, no secret-literal baseline movement (the builder avoided the word in new text).

## Findings

LOW-1. `src/index.ts:640`. Any client that appends a cache-buster or tracking parameter (`?_=123`, `?utm_source=...`) to `GET /api/proposals` now receives 400 instead of the list. Scenario: an outside agent's HTTP wrapper adds `_t=<ts>`. This is the intended behaviour of the wave (the brief refuses every unknown key so that `?status=open` cannot be silently ignored), and the message names the offending key and says how to recover. Fix: none required; keep it in the deploy note so the first outside 400 is recognised as this change, not a fault.

LOW-2. `src/index.ts:637-638`. `?since=abc` still becomes NaN and serves the first page (the same silent-misread class for a known key). Explicitly out of scope and flagged `DEFERRED-PROPOSALS-MALFORMED-CURSOR` at the site; behaviour is unchanged from the live base. Fix: a later wave.

## Conditions

None. Suggested ride after deploy: `GET /api/proposals?status=open` answers 400 `unknown_query_parameter`; `GET /api/proposals` and `?since=0&since_id=0` answer 200; `?since=1&since=2` answers 400 `repeated_query_parameter`; the `proposals` tool with `{"status":"open"}` returns isError on `/mcp/read`.
