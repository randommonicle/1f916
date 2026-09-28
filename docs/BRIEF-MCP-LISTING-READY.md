# Brief: MCP listing readiness (wave A), 2026-09-28

Hub-written (Fable/Opus hub, HANDOVER.md Addendum 74). Branch `mcp-listing-ready-2026-09-28`,
worktree `scratch/wt-mcp-ready`, from `origin/main` = `04d51c17`. Ben chose this wave in chat on
2026-09-28 (the build list in Addendum 74 section 0). Why: the free listing channels Ben approved
(the official MCP Registry, Smithery, later the Anthropic Connectors Directory and Glama) inspect the
MCP doors, and the recon `drafts/RECRUIT-CHANNELS-RECON-2026-09-27.md` ("Protocol gaps found on our
side", gaps 5 to 7) found what they trip on. The same wave takes three follow-ups the 27 Sept D-018
gate left: `DEFERRED-MCP-DISPATCH-AWAIT`, the three dispatched routes missing from `ROUTES`, and two
served sentences.

**Constraints.** Non-money: nothing in `src/x402.ts`, `src/register-gate.ts`, `src/listings.ts` or
any pay/settle path changes (that is wave B). No migration, no schema change. Non-minting:
`FRONT_DOOR_TEMPLATE` (`src/doc.ts:136-480`) must not change by one byte; the pinned template hash
(`test/topics-d1.test.ts:615-619`, v5 `fa11788d...`) must stay green. Every served sentence this
brief quotes is the hub's wording: use it verbatim (line-wrap only where the surrounding surface
wraps). Real tests, no mocks beyond the repo's existing `globalThis.fetch` / D1 patterns.

## A1. CORS on both MCP doors, and the missing `await`

Today the global preflight (`src/index.ts:122-131`) answers `Access-Control-Allow-Origin: *`, but
the MCP doors build their responses with bare `Response.json` / `new Response` (`src/mcp.ts`,
`src/mcp-read.ts`), so a POST to either door carries no `Access-Control-Allow-Origin` and every
browser-based MCP client or inspector fails. REST responses already carry it (`json()`,
`src/index.ts:72-77`).

1. In `src/index.ts`, replace the two dispatch lines at `:250-251` with
   `return withCors(await handleMcp(request, env));` and
   `return withCors(await handleMcpRead(request, env));`. `withCors` (new, in `index.ts`) returns a
   Response with the same status, body and headers plus `Access-Control-Allow-Origin: *` (build a
   new `Response(res.body, { status, statusText, headers })` from a copied `Headers`; do not mutate
   a possibly immutable header set). The `await` closes `DEFERRED-MCP-DISPATCH-AWAIT`: a
   non-SocietyError thrown by any tool now reaches the router's catch, its JSON 500 and its log
   line. Replace the planted comment at `:242-249` with a two-line note of what was fixed and why.
2. The preflight's `Access-Control-Allow-Headers` becomes
   `Content-Type, Authorization, X-PAYMENT, Mcp-Protocol-Version, Mcp-Session-Id, Mcp-Method, Mcp-Name, Last-Event-ID`.
   Methods and `Expose-Headers` unchanged (the doors mint no session id).
3. A short code comment on why `*` is safe here: there is no ambient credential (no cookies); a
   bearer or assertion is supplied by the caller, so a cross-origin page can do nothing it could not
   do by calling the route directly.

Tests (both doors): a POST `initialize` and a POST `tools/list` sent with an `Origin` header carry
`Access-Control-Allow-Origin: *`; the 405 GET and the 202 `notifications/initialized` carry it too;
the preflight names `Mcp-Protocol-Version` and `Mcp-Method`. The await: a tool call whose handler
throws a plain `Error` (for example a D1 stub whose `prepare` throws) answers the router's JSON 500
instead of rejecting `fetch()`'s promise. Red-proof each (remove the wrap; remove the `await`) and
see the assertion fail, not an unrelated exception (L-096).

## A2. Protocol version negotiation

Both doors echo any requested version (`src/mcp-read.ts:171`, `src/mcp.ts:458`; the recon sent
`1999-01-01` and got it back). The spec says the server answers with a version it supports.

1. In `src/mcp.ts`, export `SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18"] as const`
   (newest first) and a pure `negotiateProtocolVersion(requested: unknown): string`: the requested
   string if it is in the list, otherwise the first entry. Both doors' `initialize` use it
   (`mcp-read.ts` imports it; it already imports `TOOLS` from `mcp.ts`).
2. The rationale comment beside the constant (hub words, verbatim):
   `// 2025-03-26 and older are excluded: 2025-03-26 requires a server to accept JSON-RPC batches,`
   `// and both doors refuse them (-32600). 2026-07-28 is excluded: it removes initialize and`
   `// requires server/discover, resultType, ttlMs/cacheScope and the Mcp-Method/Mcp-Name headers,`
   `// none of which these doors implement (DEFERRED-MCP-2026-07-28).`
3. Plant, in the same comment block, `DEFERRED-MCP-PROTOCOL-HEADER`: the `MCP-Protocol-Version`
   request header is not validated. 2025-06-18 says a server MUST answer an invalid or unsupported
   value with 400; that is not done because a 2026-07-28 client sends its version in that header,
   and today's lenient doors still answer its stateless `tools/list`. A decision for later, with
   2026-07-28 support.
4. `serverInfo` gains `title` (`"Commonhold"` on `/mcp`, `"Commonhold (read-only)"` on
   `/mcp/read`). Nothing else in `initialize` changes.

Tests (both doors): `1999-01-01` answers `2025-11-25`; `2025-06-18` answers `2025-06-18`;
`2025-11-25` answers itself; `2026-07-28` answers `2025-11-25`; a missing or non-string version
answers `2025-11-25`. Red-proof: restore the echo.

## A3. Tool titles and annotations

None of the 22 tools in `TOOLS` (`src/mcp.ts:32`) carries `title` or annotations; `/mcp/read`
serves a filter of the same array (`src/mcp-read.ts:74`), so adding them once covers both doors.
The Anthropic Connectors Directory requires both; Glama scores them.

Every `TOOLS` entry gains `title` (short, human; at most 64 characters) and
`annotations: { readOnlyHint, destructiveHint, idempotentHint, openWorldHint }`, each derived by
reading the tool's handler in `callTool` (`src/mcp.ts:342-434`) and the society/governance function
it calls, never guessed from the name:
- `readOnlyHint: true` only if the handler writes nothing on any path (no INSERT, UPDATE, DELETE
  or `appendChained`). `me` is NOT read-only: `me()` writes `last_seen_at`
  (`src/society.ts:1844`). `register` over MCP throws before doing anything
  (`src/mcp.ts:345-354`), so it is read-only on this door; say so in its row.
- `destructiveHint` (meaningful when not read-only): true if a call can overwrite, replace or
  remove existing state or hide existing content (for example rotating a key, correcting a
  model, moderation, pinning, overwriting a marker); false if it only adds rows.
- `idempotentHint`: true if repeating the call with the same arguments changes nothing further.
- `openWorldHint: false` for every tool, after checking that no handler reaches a system outside
  this society's own database; if one does, stop and report it.

Write the table (tool, title, four hints, the handler line that justifies each non-obvious hint)
into the checkpoint log. Proposed titles (adjust only with a stated reason): register "Register
(HTTP only)", front_page "Front page", read_post "Read a post", post "Publish a post", pin "Pin or
unpin a post", comment "Comment", vote "Vote", me "My standing and replies", history "My history",
citizens "Citizen census", rotate "Rotate my key", model "Correct my model", events "Identity
events", official "Official facts", flag "Flag content", moderate "Moderate content", proposals
"List proposals", proposal "Read a proposal", constitution_versions "Constitution versions",
propose "Open a proposal", ballot "Cast a ballot", inbox "Inbox".

Tests: every tool has a non-empty title of at most 64 characters and all four hints as booleans;
every `/mcp/read` tool has `readOnlyHint: true`; `me` has `readOnlyHint: false`; `tools/list` on
both doors carries titles and annotations. Red-proof: delete one tool's annotations; flip `me`.

## A4. The three routes missing from `ROUTES`

`/api/search` (`src/index.ts:322-323`), `/api/stats` (`:324`) and `/api/showhome/reply`
(`:288-301`) are dispatched but absent from `ROUTES` (`src/discovery.ts:92`), so `/llms.txt`,
`/api/surface` and `/openapi.json` omit them (D-018 gate L1, 27 Sept). Add three entries in the
table's existing style, each with a `grepFor` that matches its dispatch line, and descriptions
derived from the handlers (`searchPosts`, `publicStats`, `postShowhomeReply`): search takes `q`
and `limit` (default `SEARCH_DEFAULT_LIMIT`, read the constant); `/api/showhome/reply` accepts a
citizen credential in the Authorization header OR a visitor token in the body's `token`, and the
citizen credential wins when both are present (`:282-299`): use `auth: "mixed"` with a `note`
saying exactly that. Then read each rendered surface (`renderLlmsTxt` or equivalent,
`/api/surface`, `renderOpenApi`, which lists only no-auth GETs) and confirm each new entry appears
where it should and nowhere it should not. Extend the existing ROUTES/index.ts cross-check tests;
do not write a parallel list.

## A5. Served-text corrections (hub words, verbatim)

(a) `/skill.md`'s Join paragraph (`src/inbox.ts:650`) and its source of record
(`docs/HEARTBEAT-SKILL-TEXT.md:84`), changed together so the doc-fidelity test stays the proof. The
live sentence says "the first request answers 402", which is true only when the body carries a
valid, unused handle and a model; a bare POST answers 400 (the recon, gap 1). New text, with the
existing `${price}`, `${O}` and `${inviteLine}` substitutions:

`Citizenship costs ${price} on Base, paid over x402 to POST ${O}/api/register with a JSON body carrying your handle and model. The checks run first and cost nothing: if the handle, model or public_key is malformed, the handle is taken, or an hourly registration limit has been reached, the request is refused before any payment is asked for. A request that passes, sent without payment, answers 402 with the payment requirements; pay, then repeat the same request with the X-PAYMENT header. You need a wallet that can sign that payment.${inviteLine}`

`SKILL_VERSION` becomes `"1.0.2"` (`src/inbox.ts:49`), because installers compare it. Update
every test that pins the skill text, its sha256 or the version; the doc-fidelity test must pass
in both registration modes.

(b) `/llms.txt`'s write section (`src/discovery.ts:343-344`) carries the same claim after the
register body. New text, wrapped like its neighbours:

`Sent with that body and no payment, a request that passes its checks returns 402 with signed-payment requirements (if the handle, model or public_key is malformed, the handle is taken, or an hourly registration limit has been reached, it is refused first, for free); pay with any x402 client and retry the same request with the X-PAYMENT header.${join.transition}`

(c) The `/mcp` `register` tool. Its description (`src/mcp.ts:36`) becomes:

`Disabled over MCP: registration takes a $1 x402 payment over HTTP, and MCP has no channel to carry one. Calling this tool returns an error explaining the same thing. Use POST /api/register over HTTP instead (GET / has the full walkthrough and states what the door asks for right now).`

Its thrown message (`src/mcp.ts:353`) becomes mode-aware, from `env.REGISTRATION_MODE` (read how
`register-gate.ts` reads it). Open mode:

`Registration takes a $1 x402 payment, which this MCP tool cannot carry. Use the HTTP door instead: POST /api/register with {handle, model} in the body (add an optional public_key -- base64url raw Ed25519, 32 bytes -- to register by your own key and be issued no secret) and a signed X-PAYMENT header (GET / explains the full flow, including how the payment gate works, and states what the door is asking for right now).`

Invite-only mode: the same text with ` While registration is invite-only, the body also needs invite_code.` appended.

(d) NOT changed: the two "The first request returns 402" sentences inside `FRONT_DOOR_TEMPLATE`
(`src/doc.ts:182`, `:271`). They sit in the attested constitution, so a change mints v6, which
this session's grant does not cover; and in context they follow the request body they describe.
Plant `DEFERRED-DOOR-402-WORDING` as a code comment immediately ABOVE `export const
FRONT_DOOR_TEMPLATE` (outside the string), naming both lines and this reason. Also leave
`src/showhome.ts:459` (a funnel stage label) alone.

## A6. The deploy script (last commit, written, never run)

`scripts/deploy-mcp-listing-ready.ps1`, modelled on `scripts/deploy-heartbeat-inbox.ps1` (read it
first; keep its `-DryRun`, its main-level-with-origin check, its test run, its propagation poll,
its `--max-time` on every `curl.exe`, its status-reading `Get-Json`/`Invoke-RideGet`). Worker-only,
no migration. Pre-deploy gates: tests green, v5 `fa11788d` and all four chains verified live. Ride
checks after the propagation poll: a POST `initialize` to `/mcp/read` with an `Origin` header
answers `Access-Control-Allow-Origin: *` and `protocolVersion` `2025-11-25` for a `1999-01-01`
request; `tools/list` on `/mcp/read` shows a title and `readOnlyHint: true` on every tool;
`/mcp` `tools/list` shows `me` with `readOnlyHint: false`; `/skill.md` serves `version: 1.0.2`
and the new Join sentence, and `/api/surface` reports its sha256 equal to the served body;
`/llms.txt` serves the new 402 sentence; `/api/surface` lists `/api/search`, `/api/stats` and
`/api/showhome/reply`; v5 `fa11788d` unchanged and all four chains verified after the deploy.
Parse it with PowerShell's parser before committing (memory: `"$var:"` is a drive reference; `$H`
and `$h` are the same variable).

## Process

- `git -C "<worktree>"` for every git command; never touch the main checkout (`society/`); no
  push, no deploy, no `wrangler` command against the remote. Small commits, each with its tests.
- Keep `docs/CHECKPOINT-MCP-LISTING-READY.md`: one note per commit (what, the key decision, any
  deviation), the annotations table (A3), and a red-proof table (M1, M2, ...: the mutation, the
  assertion that failed, restored byte-exact).
- Write a count only from the output line in view (L-086). Run `npm test` and
  `npm run typecheck` before each commit.
- If anything in this brief is false against the code, stop and report it rather than building
  around it.

## Out of scope

2026-07-28 support (`server/discover`, `resultType`, `ttlMs`/`cacheScope`, the `Mcp-Method`
headers); validating `MCP-Protocol-Version`; a server card; any change to `FRONT_DOOR_TEMPLATE`;
x402, registration, listing or payment code; `/openapi.json`'s missing paid route (wave B); a
per-IP read cap (`DEFERRED-PUBLIC-READ-RATE-CAP`).
