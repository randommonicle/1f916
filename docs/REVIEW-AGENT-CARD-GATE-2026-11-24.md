# Gate record: the agent-card / A2A wave, Sonnet tier, 24 Nov 2026

Branch `agent-card-2026-11-23`, head `113edd2a6f7b4f34f91c224bfcf971d226e84685`, base `0090313a` (production). Reviewer independent of the builder and of both exchange seats. Not a money path. Note on the exchanges: GEMINI r2 and DEEPSEEK r1 converged on the code; CODEX was out of quota and reviewed neither the code nor brief v4 amendments A to E. This gate and DEEPSEEK are therefore the only reads of the code that went to the A2A sources.

## Verdict: DEPLOYABLE WITH CONDITIONS
Findings: HIGH 0, MEDIUM 0, LOW 7. Conditions: C1 and C2 (neither is a code change).

- C1. No deploy script exists on the branch (`scripts/` has no agent-card or a2a script; the newest is `deploy-wallet-batch.ps1`). The brief's script must be written, reviewed and pinned to the then-live base before Ben's dry run. The ride is below.
- C2. The ride must say that a v1.0 client WITHOUT an `A2A-Version: 1.0` header is treated as 0.3 and gets `-32601` on `SendMessage` (declared, spec 3.6, but the most likely first failure of a real client). Run both shapes, with and without the header.

## Findings (all LOW)
- L1 `src/a2a.ts` negotiate(): a present-but-EMPTY `A2A-Version` header wins over a non-empty `?A2A-Version=1.0` query (`headers.get` returns "" not null, so `??` does not fall through). Probe: header "" plus query 1.0 gave `-32601 ... speaks A2A 0.3`. Spec 3.6 allows either source and says an empty value is 0.3, so this is defensible; only a client sending an empty header plus a query value is affected.
- L2 `src/a2a.ts` referencesTask() and validMessage(): `referenceTaskIds: [""]` is accepted as an optional string array, then counts as a task reference (non-empty array) and gets `-32001`. The comment says an EMPTY string is absent. Probe confirmed. Harmless, inconsistent.
- L3 `src/a2a.ts` errorData(): an unsupported-version refusal (`-32009`) carries `data` as an object, not the v1.0 ErrorInfo array (v1.0 9.5 says an A2A-specific code MUST carry ErrorInfo). Declared in the code comment: the shape is v1.0 only once 1.0 was negotiated. The spec text and its own example (object `data` for `-32601`) disagree, so either choice is arguable.
- L4 `src/index.ts`: HEAD on either card is 404 (probe), as for `/skill.md` and every other GET-only route. Crawlers that HEAD first see a 404. Consistent with existing behaviour.
- L5 `src/mcp.ts` default branch, `src/mcp-read.ts`: `mcp_unknown_method` counts every unknown string method, including `notifications/cancelled` (probe), which ordinary MCP clients send, so it is not an A2A signal. The served DOORS_NOTE says exactly this. Every unknown-method request now also runs a two-statement D1 batch where it ran none; the caps bound rows written, not requests, and the per-IP cap remains deferred (stated truly in `src/doors.ts`).
- L6 `/privacy` (`src/privacy.ts:48`) says counters are "to each public door and to each MCP tool ... nothing about who called". Still true (closed names, no caller data, no `console.log` in `src/a2a.ts`), but it does not name the probe doors; `src/privacy.ts` is unchanged by design. No action needed.
- L7 `/mcp` answers a JSON-RPC notification (no id) with a `-32601` body rather than nothing: pre-existing behaviour, not part of this wave.

## Checks first-hand
1. Baseline: `npm test` 3499 tests, 3498 pass, 0 fail, 1 skipped (the hub's figures). `npm run typecheck` clean. Worktree clean before and after (`git status --porcelain` empty apart from this record).
2. Scope: 12 files; `src/doc.ts`, `src/privacy.ts`, the skill and heartbeat sources, `migrations/` and `schema.sql` are untouched, so the constitution template hash, the /skill.md and /heartbeat.md pins and /privacy cannot have moved. Live production (GET only): `/.well-known/agent-card.json`, `/.well-known/agent.json` and `/a2a` all 404 now, consistent with base `0090313a`.
3. Served text. Read every string: both cards, `directionsText`, every error message, ROUTES entries and notes, the `/llms.txt` lines, DOORS_NOTE, the `/api/doors` description, the `/mcp` message. Each is true of this deployment; no figure, no wallet, nothing inherited from the fork. "Run by a named human operator" is true (`src/privacy.ts:12` names the controller). "The application does not store your message" is qualified by "application", with `/privacy` for the Cloudflare layer. No caller text reaches a response, log or D1 apart from the validated `id` (a string of at most 256 characters, a finite number or null); `src/a2a.ts` has no `console.log`. The `/mcp` text reflects the caller's method name only in the unchanged `method '<m>' not found` form.
4. Secret-literal guard hash (`test/secret-literal-guard.test.ts`): the pinned sha is of the complete literal in `src/discovery.ts`; the literal changed by one phrase ("the governance sweep and POST /a2a take none"), which is true (`auth: "none"`) and carries no secret-only instruction; the note records why. Legitimate, and the test passes, so the hash equals the new literal.
5. /a2a, by probe (a temporary test file, since deleted): invalid UTF-8 gives `-32700`; a BOM-prefixed body is accepted; a chunked 200 KB body with no Content-Length gives `-32600` at 64 KB; an over-limit nested body gives `-32600` before parsing; `__proto__`, `constructor`, `toString`, `hasOwnProperty`, `valueOf` as methods give `-32601`; `params` array or null gives `-32602`; text plus data in one v1.0 part gives `-32602`; a `taskId` inside a data part or metadata is ignored (accepted); `id` 1e400 and a 300-character id give `-32600` with `id: null`; version "1.0.5" is 1.0, "1.00" is `-32009`; trailing slash `/a2a/` works; DELETE and HEAD give 405. The order of outcomes follows amendment A.
6. Counters: four closed names, `capFor` routes them to 200 and the fixed and per-tool classes are unchanged; T5 derives each class (56,000 against the 60,000 budget). `countDoor` catches every error and `recordDoor` hands the write to `waitUntil`, so a failure cannot change a response. Counted only on: a 200 card GET, an accepted send, and a string-method unknown at the two MCP doors. A refused send, a null or non-string-method payload count nothing; an accepted notification does count (as briefed). Probe counts after my run: a2a_send 4 (BOM, data-part taskId, 1.0.5, trailing slash: exactly the accepted ones), agent_card 1, mcp_unknown_method 1.
7. Existing behaviour: the `initialize`, `tools/list`, `tools/call`, `ping` and `notifications/initialized` branches are untouched (the diff is the `default` branch and the guard). An array still reaches the earlier batch refusal. CORS: the one added allowed header `A2A-Version` is on the global OPTIONS reply; it only widens what a cross-origin preflight may send, and no route reads it except `/a2a`. Routing: `/a2a` and both card paths are exact matches placed before the JSON API and `/mcp`; nothing earlier shadows them; `/mcp` initialize still answers (probe).
8. Conformance against the sources fetched this session (v1.0.0 `a2a.proto` and `specification.md`; v0.3.0 `types.ts`). v1.0 card: every REQUIRED field of `AgentCard`, `AgentInterface`, `AgentSkill` and `AgentProvider` is present, named as the proto names it. v0.3 card: `protocolVersion`, `name`, `description`, `url`, `version`, `capabilities`, `defaultInputModes`, `defaultOutputModes`, `skills` all present. v1.0 send: `SendMessage`, `ROLE_USER`, text parts without `kind`, response `{ message }` with `ROLE_AGENT`; the push field `taskPushNotificationConfig` matches the proto. v0.3 send: `message/send`, `kind: "message"`, role `user`, unwrapped Message result. Codes -32001, -32003, -32004, -32007, -32009 match the v1.0 table; -32007 for the v0.3 extended-card refusal matches v0.3. The v1.0 ErrorInfo is present for every A2A-specific code sent while 1.0 is negotiated. Deviations, all declared: no `contextId` in our replies; a supplied `contextId` is refused `-32004`; `ListTasks` mapped to `-32004` (3.3.4 names no code); the unsupported-version `data` shape (L3). Honest for a client taking the card at its word: yes. It claims one skill, no streaming, no push, no extended card, and the endpoint refuses each with the matching code. The one trap is C2.

## Mutation table
Run files: `test/a2a-d1`, `test/door-counts-d1`, `test/tool-counter-d1`, `test/guest-served-text-d1`, `test/secret-literal-guard`. Each applied by scratch replacement, tests run, then `git checkout -- <file>`.

| # | Mutation | Result |
|---|---|---|
| M1 | 204 branch for no-id requests removed | RED 1 (T3d) |
| M2 | REFUSALS lookup made inherited (no `hasOwn`) | RED 1 (T3h) |
| M3 | body bound x1000 | RED 3 (T3a, T3g, T3i) |
| M4 | task reference ignored | RED 3 (T3c, T3g, T3j) |
| M5 | probe cap routed to the fixed 2000 | RED 1 (T5b) |
| M6 | `/mcp` null and primitive guard removed | RED 1 (T4) |
| M7 | version regex without the leading-zero rule | NOT RED: equivalent mutant, the later `"1.0"` string comparison already rejects "01.00" |
| M8 | v0.3 card GET uncounted | RED 2 (T5, T5c) |
| M9 | v0.3 card without top-level `url` | RED 1 (T1) |
| M10 | ErrorInfo reason row dropped | RED 1 (T3g) |
| M11 | `contextId` ignored | RED 3 |
| M12 | push-callback request accepted | RED 2 |
| M13 | A2A send methods counted as `mcp_unknown_method` | RED 2 (T5, T5c) |
| M14 | reply role `ROLE_USER` | RED 2 (T2, T3a) |
| M15 | `a2a_send` never counted | RED 8 |
| M16 | id length bound removed | RED 1 (T3a) |
| M17 | POST-only check removed | RED 1 (T3e) |
| M18 | `A2A-Version` dropped from the global allowed headers | RED 1 (T3e) |
| M19 | `/mcp/read` unknown-method count removed | RED 2 (T5, T5c) |

18 of 19 red; the survivor is an equivalent mutant. Worktree restored byte-identical (`git status --porcelain` empty before this record).

## Not checked
- Real D1 and workerd: everything ran on the local D1 and the node router. The door-counter batch is the shape already in production; a card GET adds one `governance_settings` read.
- No real A2A client or SDK was run against the endpoint; conformance was read from the sources.
- `/llms.txt`, `/api/surface` and `/openapi.json` were checked through the passing parity tests and the ROUTES text, not from a built deployment.
- The `.proto` and `types.ts` were read for the fields this wave uses, not exhaustively.
- No load test of the routes that have no per-IP cap (deferred, declared).

## Ride conditions (for the deploy script, brief "Deploy")
1. Pin the base to the live worker at the time and the commit to the reviewed head; no migration; read-only dry run first.
2. Baseline `GET /api/doors`. GET both cards: 200, required fields, the live name, one agent_card count each.
3. POST `/a2a`: `SendMessage` with `A2A-Version: 1.0`; `message/send` with no header; the same `SendMessage` without the header (expect `-32601` naming `message/send`, C2); `A2A-Version: 9.9` (expect `-32009`); one unknown method; a notification (204, empty). Expect exactly two counted sends.
4. POST `/mcp` and `/mcp/read` with `message/send` (the new text, `-32601`) and one ordinary unknown method (today's text byte for byte), and one `initialize` to prove MCP still answers.
5. Poll `GET /api/doors` in a bounded loop until each probe door is at least baseline plus the ride's own sends, or `at_cap`; the script says the ride's requests are in the day's figures.
6. Check `/llms.txt` and `/api/surface` list the two cards and `POST /a2a`; `/openapi.json` lists the cards and not `POST /a2a`.
7. `/api/attest` template hash and `/skill.md`, `/heartbeat.md` unchanged.

VERDICT: DEPLOYABLE WITH CONDITIONS (C1, C2)

## Hub correction (24 Nov 2026, added after the gate, not by the gate)
The opening note says this gate and DEEPSEEK are the reads that went to the A2A sources. DEEPSEEK did not: it is prompt-only and said it could not see the spec pages. The reads that went to the sources were the builder's (which could not read the end of the v1.0 page), CODEX's on the brief (rounds 1 to 3, not the code), a fetch agent's report to the hub of the v1.0.0 and v0.3.0 specification text, the hub's own read of `specification/a2a.proto` at v1.0.0, and this gate's.
