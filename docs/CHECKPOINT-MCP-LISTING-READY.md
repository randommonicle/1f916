# Checkpoint: MCP listing readiness (wave A)

Branch `mcp-listing-ready-2026-09-28`, worktree `scratch/wt-mcp-ready`, from
`origin/main` = `04d51c17`. Built from `docs/BRIEF-MCP-LISTING-READY.md` (bc6acad3 is
the brief commit read before any code here). Items A1-A6, one commit per item except
where a later item's tests share a file with an earlier one (noted inline).

Non-money, non-minting, no migration (brief's own constraints). Never touched:
`src/x402.ts`, `src/register-gate.ts` (read-only, for `REGISTRATION_PRICE_CENTS` and
how it reads `REGISTRATION_MODE`), `src/listings.ts`, `FRONT_DOOR_TEMPLATE` (byte for
byte).

## Commit log

(filled in per commit below, each with: what, the key decision, any deviation)

## A1: CORS on both MCP doors, and the missing `await`

**File list:**
- `src/index.ts` (edit): `withCors()` (new helper, wraps a Response with a fresh
  `Headers` copy plus `Access-Control-Allow-Origin: *`, never mutating the input
  Response's own headers, which can be immutable); the two `/mcp` / `/mcp/read`
  dispatch lines now `return withCors(await handleMcp(...))` /
  `return withCors(await handleMcpRead(...))`, closing
  `DEFERRED-MCP-DISPATCH-AWAIT`; the planted 8-line comment there replaced with a
  2-line note; the OPTIONS preflight's `Access-Control-Allow-Headers` gains
  `Mcp-Protocol-Version, Mcp-Session-Id, Mcp-Method, Mcp-Name, Last-Event-ID`
  (methods and `Expose-Headers` unchanged, per the brief -- the doors mint no
  session id); a short comment on why `*` is safe (no ambient credential).
- `test/mcp-cors-await.test.ts` (new): 3 tests, round-tripped through the real
  router (`worker.fetch`, the same `callFetch` shape `inbox-d1.test.ts` uses) rather
  than `handleMcp`/`handleMcpRead` directly -- `withCors` lives in `index.ts`, so a
  test calling the door handlers directly would never exercise it.

**Key decision:** the await red-proof (L-096) needs `Promise.allSettled`, not a bare
`await fetch(...)` -- removing the `await` makes the router's own returned promise
*reject* (the exact pre-fix bug), and a bare `await` on a rejecting call throws inside
the test before any assertion runs. The test wraps the `callFetch` call in
`Promise.allSettled` and asserts `status === "fulfilled"` as its own first assertion,
then asserts on the 500 body's *exact* shape (`{"error": "Internal error. The society
apologizes."}` -- society.ts's router catch does not echo the thrown message, so the
test does not either).

**Tests added:** CORS present on `initialize`/`tools/list`/405 GET/202 notification,
both doors; preflight names the new headers and keeps the old ones; the await fix
(a D1 stub whose `prepare()` throws a plain `Error`, routed through the `official`
tool on both doors, must resolve to a real 500, not reject).

## A2: Protocol version negotiation

**File list:**
- `src/mcp.ts` (edit): export `SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25",
  "2025-06-18"] as const` and pure `negotiateProtocolVersion(requested: unknown):
  string`; the rationale + `DEFERRED-MCP-PROTOCOL-HEADER` comment block, hub words
  verbatim; `initialize` uses it; `serverInfo.title = "Commonhold"`.
- `src/mcp-read.ts` (edit): imports `negotiateProtocolVersion` alongside the
  existing `TOOLS` import from `./mcp.ts`; `initialize` uses it;
  `serverInfo.title = "Commonhold (read-only)"`.
- `test/mcp-protocol-version.test.ts` (new): the pure function over every case the
  brief names, plus both doors' real `initialize` response round-tripped through
  `handleMcp`/`handleMcpRead` directly (matching `test/mcp-citizens.test.ts`'s own
  precedent -- A2 touches neither routing nor CORS, so the router is not needed
  here the way A1's test needed it).
- `test/discovery.test.ts` (edit, deviation -- see below): the `renderMcpManifest`
  protocol-version test's rationale and title.

**Deviation, disclosed:** `test/discovery.test.ts:288` asserted
`m.protocol_version === "2025-06-18"` with the comment "must match mcp.ts's own
initialize response literally". That comment goes false the moment A2 ships:
`renderMcpManifest`'s `protocol_version` field (`src/discovery.ts`, a route
OUTSIDE the brief's two doors, never touched by A2) stays the hardcoded literal
`"2025-06-18"` -- the brief's "Out of scope" list does not name it, and A2 says
only "Both doors' `initialize` use it" -- but mcp.ts's real `initialize` no longer
defaults to that literal (it defaults to `2025-11-25`, newest-first). The
NUMERIC assertion still passes (the manifest's literal is genuinely unchanged),
but its stated reason would be false. Reworded to assert membership in
`SUPPORTED_PROTOCOL_VERSIONS` instead of literal equality, with a comment
explaining why the manifest's own field is out of this brief's scope. No
`src/discovery.ts` code changed.

## A3: Tool titles and annotations

## A4: The three routes missing from `ROUTES`

## A5: Served-text corrections

## A6: The deploy script

## Annotations table (A3)

## Red-proof table

| M | Mutation | Test file | Red-proofed |
|---|---|---|---|
| M1 | A1: remove `withCors(...)` wrap only (keep `await`) | mcp-cors-await.test.ts | yes -- CORS test fails on its own assertion (`null !== '*'`); preflight and await tests stay green |
| M2 | A1: remove `await` only (keep the `withCors(...)` wrap, cast around the type error) | mcp-cors-await.test.ts | yes -- both the GET-405 CORS assertion (`200 !== 405`) and the await test's own 500 assertion (`200 !== 500`) fail cleanly; a secondary "async activity after the test ended" note appears from the now-orphaned inner promise, but the reported failure in both cases is the test's own AssertionError, not that note |
| M3 | A2: restore the echo on `/mcp` only (`(msg.params?.protocolVersion as string) ?? "2025-06-18"`) | mcp-protocol-version.test.ts | yes -- only the `/mcp` negotiation test fails (`'1999-01-01' !== '2025-11-25'`); `/mcp/read`'s own test stays green, proving the two doors are tested independently |
| M4 | A2: restore the echo on `/mcp/read` only | mcp-protocol-version.test.ts | yes -- only the `/mcp/read` negotiation test fails, same assertion shape; `/mcp` stays green |
