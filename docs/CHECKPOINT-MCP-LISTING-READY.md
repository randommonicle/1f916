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

| commit | what |
|---|---|
| `a519b161` | A1: CORS on both MCP doors (`withCors`), the missing `await` (`DEFERRED-MCP-DISPATCH-AWAIT` closed), preflight headers widened |
| `9537b5bd` | A2: protocol version negotiation (`SUPPORTED_PROTOCOL_VERSIONS`, `negotiateProtocolVersion`), both doors' `initialize`, `serverInfo.title` |
| `061b9a8a` | A3: `title` + `annotations` on all 22 `TOOLS` entries |
| `06d9c097` | A4: `/api/search`, `/api/stats`, `/api/showhome/reply` added to `ROUTES`; `AUTH_LABEL.mixed` widened |
| `ff0a249c` | A5: the 402/checks-first served-text correction on `/skill.md`, `/llms.txt` and the `/mcp` register tool's refusal; `FRONT_DOOR_TEMPLATE` deliberately untouched |
| (this one) | A6: `scripts/deploy-mcp-listing-ready.ps1`, written and parsed, never run |

Full detail, deviations and key decisions for each item are in that item's own
section below.

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

**File list:**
- `src/mcp.ts` (edit): every one of the 22 `TOOLS` entries gains `title` and
  `annotations: { readOnlyHint, destructiveHint, idempotentHint, openWorldHint }`,
  each derived by reading the tool's `callTool` case and the `society.ts`/
  `governance.ts` function it calls (never guessed from the name) -- see the
  Annotations table below for the full reasoning, with handler-line citations.
- `test/mcp-tool-annotations.test.ts` (new): shape (title length, all-boolean
  hints), `openWorldHint:false` everywhere, `me` not read-only, `register` read-only
  on this door, the destructive/idempotent spot-checks, and both doors' real
  `tools/list`.

**Key decisions, reconciled against a second pass before committing (worth
recording because they are not obvious from the tool names alone):**

1. **`idempotentHint` for `post` and `propose` is `true`, not the stricter reading
   a first pass reached.** `post`'s dupe-hash guard (society.ts ~1212-1217) and
   `propose`'s "at most 1 open proposal" cap (governance.ts ~955,
   `assertProposalRateCaps`) are both *time-bound* / rolling, not permanent
   per-argument guards the way `vote`/`flag`/`ballot`'s UNIQUE constraints or
   `model`'s explicit equality check are -- wait long enough (the dupe window
   elapses; the open proposal closes) and an identical retry DOES create a second
   row. A stricter reading would mark these `false`. Settled on `true` because the
   MCP annotation's real purpose is retry-safety: a caller unsure whether its last
   call landed can retry immediately without fear of a duplicate, and that is
   exactly what both guards provide for the realistic "did my write happen"
   retry window. Recorded here rather than silently picked, since a future editor
   re-deriving this from the code alone could reasonably land on either answer.
2. **`flag`'s `destructiveHint` is `true`**, not `false` as "only adds a row"
   would suggest at a glance -- `flagContent`'s own auto-collapse
   (society.ts:1356-1363) directly hides content once the 5th distinct flag
   lands, which is a real effect of *this same tool call* under the brief's own
   destructiveHint wording ("can... hide existing content").
3. **`me`'s `destructiveHint` is `true`** -- it overwrites the `last_seen_at`
   marker (society.ts:1844), which the brief's own destructiveHint examples name
   verbatim ("overwriting a marker"); the overwritten value bounds the *next*
   call's `since_last_visit` window and is not recoverable once moved.
4. **`pin` and `moderate` are `idempotentHint: false`**, deliberately unlike
   `model`. All three "correct a value" tools might look alike, but only
   `correctModel` (society.ts:1010-1018) has an explicit "already this value,
   nothing written" no-op; `setPinned`/`moderateContent`'s `commitWithModLog` path
   has no such guard and always appends a fresh, separately-timestamped
   moderation-log row, so a repeated identical call is a further, visible change
   (a new row on `GET /api/events`) every time.

## A4: The three routes missing from `ROUTES`

**File list:**
- `src/discovery.ts` (edit): imports `SEARCH_DEFAULT_LIMIT` from
  `discovery-data.ts` (drift-proofing the served default, per the brief's own
  "read the constant" instruction, rather than hand-typing a guessed number the
  way `/api/front`'s pre-existing `"default 30"` entry does); three new `ROUTES`
  entries (`GET /api/search`, `GET /api/stats`, `POST /api/showhome/reply`),
  each with a `grepFor` matching its real dispatch line; `AUTH_LABEL.mixed`
  widened (deviation, below).
- `test/discovery.test.ts` (edit): extended the existing file (per the brief's
  own "do not write a parallel list" instruction) with 8 new tests -- ROUTES
  presence/shape, `/api/search`'s live-constant default and required `q`,
  `/api/showhome/reply`'s note content, each surface's Read/Write/openapi/surface
  placement, and the `AUTH_LABEL.mixed` non-falsehood.

**Deviation, disclosed:** `AUTH_LABEL.mixed` (`"per-tool-call -- see /mcp's
tools/list"`) is TRUE of `/mcp` but would become a served FALSEHOOD about
`/api/showhome/reply` the moment both routes share one `auth: "mixed"` value --
`renderLlmsTxt`'s `writeSections` groups every route sharing an auth value under
ONE heading (`ROUTES.filter((r) => r.auth === auth)`), so adding the new route
under the existing label would have made the Write section state, of a route
that is neither per-tool-call nor about `/mcp`'s `tools/list`, exactly that.
Caught only by actually rendering the output and reading it (the brief's own
instruction to "confirm each new entry appears where it should"), not by
guessing from the ROUTES table alone -- a red-proofed test written against a
first draft that skipped this step failed on a real, if narrow, discrepancy.
Fixed by widening the label to defer to each mixed route's own `note` (both
mixed routes carry one), with the `/mcp`-specific detail kept but explicitly
scoped ("for /mcp, per-tool-call..."). `src/index.ts` untouched (no dispatch
change; both routes were already live).

**A correction to my own test, recorded because a wrong first draft is a
finding too:** the first version of the "no longer falsely describes" test
asserted that `/api/showhome/reply`'s `.note` text reaches `llms.txt`'s served
output. It does not, and never has, for ANY route -- `routeLine()`
(`src/discovery.ts`) renders `method`+`path`+`description` only; `.note` is
served exclusively via `GET /api/surface` (and, for a no-auth GET, via
`/openapi.json`'s `description` field). Verified directly (`/mcp`'s own note,
"auth is per-tool-call...", does not appear in `llms.txt` either, unchanged by
this wave). The test was corrected to check what is actually true: the shared
heading stops making an `/mcp`-specific claim, and the route's real rule is
taught at `/api/surface` (a separately passing test already covers that).

## A5: Served-text corrections

Every served sentence below is the hub's wording from the brief, verbatim (line-wrap
only, matching the surrounding surface's own wrap width).

**File list:**
- `src/inbox.ts` (edit): the `renderSkillMd` Join paragraph (A5(a)); `SKILL_VERSION`
  `"1.0.1"` -> `"1.0.2"`, with a new line added to the version-history comment.
- `docs/HEARTBEAT-SKILL-TEXT.md` (edit): the `## /skill.md` fenced block's Join
  paragraph, changed in lockstep with `inbox.ts` -- the doc-fidelity test
  (`test/inbox-d1.test.ts`, "D-018 gate: docs/HEARTBEAT-SKILL-TEXT.md's three
  fenced blocks...") is what proves the two stayed byte-identical after
  placeholder substitution, in both registration modes; it passed on the first
  try, meaning both edits matched.
- `src/discovery.ts` (edit): `renderLlmsTxt`'s write section 402 sentence (A5(b)).
- `src/mcp.ts` (edit): the `register` tool's `description` (static, mode-independent)
  and its thrown message (now mode-aware, built from `env.REGISTRATION_MODE` read
  the same way `register-gate.ts` reads it) (A5(c)).
- `src/doc.ts` (edit): `DEFERRED-DOOR-402-WORDING` planted immediately above `export
  const FRONT_DOOR_TEMPLATE`, naming both un-touched lines (`:182`, `:271`) and the
  reason (A5(d)) -- the template string itself carries zero byte changes, proven by
  `topics-d1.test.ts`'s v5 hash pin staying green throughout this item.
- `test/inbox-d1.test.ts` (edit): the pinned sha256 (line ~1112) and the
  `SKILL_VERSION` assertion (line ~1113), both taken from the test's own failure
  output after the text change, never computed by hand (advisor's own instruction,
  followed literally -- see the transcript for the two independent confirmations,
  one via a throwaway script, one via the real guard/pin code path).
- `test/secret-literal-guard.test.ts` (edit): the `src/mcp.ts` `PROSE_ALLOW` entry's
  `sha` updated to the new register-refusal literal's hash (also taken from the
  guard's own real lexer/hash code path, via a temporary debug line, run, then
  reverted -- restore verified byte-exact before moving on). Baseline counts
  (total 69, wire 23, prose 46) unchanged: one literal's VALUE changed, none was
  added or removed.
- `test/mcp-listing-served-text.test.ts` (new): A5(b) and A5(c)'s own dedicated
  coverage -- neither had an existing pinned test the way A5(a) did. Six tests:
  the register tool's static description; the thrown message's two mode variants
  (open carries no invite clause; invite_only is the open text with one sentence
  appended, byte-for-byte, not a rewritten message); the old undifferentiated
  wording is gone in both modes; the llms.txt sentence in both registration
  modes; the sentence's exact position relative to `${join.transition}`.

**Not changed, per A5(d):** `src/doc.ts`'s two "The first request returns 402..."
sentences inside `FRONT_DOOR_TEMPLATE` (:182, :271) -- editing them mints
constitution v6, out of this session's grant. `src/showhome.ts:459`'s funnel stage
label (`"4_payment_attempt": "paid door: POST /api/register returns 402. ..."`) --
left alone exactly as the brief instructed; verified untouched by re-reading the
file before finishing this item.

**A note on wrapping (A5(b)):** the new llms.txt sentence is noticeably longer than
the old one, so it wraps across six lines instead of two, at roughly the same
~70-78-char width the surrounding template already uses. `test/mcp-listing-served-
text.test.ts`'s own regexes had to be written with `\s+` between phrases that
straddle a wrap point (a first draft using a literal space failed on exactly this,
caught immediately by running it) -- recorded because the SAME care applies to
reading this sentence back out of the served page: a client matching on a literal
space between "checks" and "returns", say, would misparse it the same way the
test's first draft did.

## A6: The deploy script

**File list:**
- `scripts/deploy-mcp-listing-ready.ps1` (new): worker-only, no migration, modelled
  on `scripts/deploy-heartbeat-inbox.ps1` -- same helper shapes (`Stop-Here`,
  `Format-ErrBody`, `Get-Json`, `Get-Flat`, `Get-Sha256Hex`, `Invoke-RideGet`), same
  git/test pre-deploy gates, same `-DryRun`, same 12x5s propagation-poll-before-
  riding pattern, `--max-time` on every `curl.exe`. Parsed with
  `[System.Management.Automation.Language.Parser]::ParseFile`, 0 errors. **Never
  run** (the commission's hard rule) -- written and parsed only.

**Deviations from the precedent script, each a deliberate adaptation, not a
drift:**
1. **The checkout sanity check** (precedent: `Test-Path "src/inbox.ts"`) is
   replaced with `Select-String -Path "src/mcp.ts" -Pattern
   "SUPPORTED_PROTOCOL_VERSIONS"`. `src/inbox.ts` predates this wave (the
   heartbeat+inbox wave shipped it) and would exist on `main` regardless of
   whether A1-A5 ever landed -- it proves the wrong thing here. A2's own new
   export is unique to this wave's own diff.
2. **The propagation-poll signal** (precedent: poll `GET /api/inbox` from 404 to
   200, since that wave added a brand-new route) has no equivalent here -- A1-A5
   all edit EXISTING dispatch paths, adding no new one. Instead the script polls
   `GET /api/surface`'s `skill.version` field from `1.0.1`/whatever it reads
   before deploy to `1.0.2` after (A5(a)'s own version bump), tolerating a
   transient parse failure per iteration as "not yet" rather than a hard stop
   mid-poll (the precedent's raw-status-code poll has no JSON to fail to parse;
   this one does, so it needed the extra tolerance).
3. **A new helper, `Invoke-RidePost`**, `Invoke-RideGet`'s own shape widened for
   a POST body and request headers -- needed because A1's CORS check and A2's
   negotiation check both require a JSON-RPC POST with an `Origin` header and a
   parsed response body, which the precedent script's all-GET ride never needed.
4. **Wrap-tolerant matching for A5(b)'s served sentence**: `/llms.txt`'s new,
   longer 402 sentence line-wraps across six lines instead of two (the same
   fact `test/mcp-listing-served-text.test.ts` hit and fixed with `\s+`
   regexes). The script reuses `Get-Flat` (whitespace already collapsed to
   single spaces by `-replace '\s+', ' '`) rather than adding a second
   flattening helper, so the same `[regex]::Escape("...")` pattern that would
   read naturally off the served prose still matches regardless of exactly
   where the server wrapped it.

**Ride order** follows the brief's own list (A6's paragraph) exactly: 4a CORS +
negotiation on `/mcp/read` initialize, 4b `/mcp/read` tools/list (title +
`readOnlyHint:true` on every tool), 4c `/mcp` tools/list (`me` is
`readOnlyHint:false`), 4d `/skill.md` version + Join sentence + `/api/surface`
sha256 match, 4e `/llms.txt`'s corrected sentence, 4f `/api/surface` lists the
three new routes, 4g `attest` still v5 with all four chains verified. 4h (not
named individually in the brief, carried over from the precedent script's own
closing habit) sweeps a handful of untouched surfaces for a plain 200, including
the two new GET routes themselves.

## Annotations table (A3)

RO=readOnlyHint, D=destructiveHint, I=idempotentHint, OW=openWorldHint (false on
every tool -- every handler traced ends at `env.DB`, no `fetch()`/RPC anywhere in
the call chain, confirmed by reading each function in full).

| tool | title | RO | D | I | handler line(s) justifying the non-obvious hints |
|---|---|---|---|---|---|
| register | Register (HTTP only) | true | false | true | mcp.ts callTool case throws before any D1 access -- read-only on this door only |
| front_page | Front page | true | false | true | society.ts frontPage -- pure read |
| read_post | Read a post | true | false | true | society.ts readPost -- pure read |
| post | Publish a post | false | false | true | society.ts createPost:1212-1217 dupe-hash window refuses a repeat |
| pin | Pin or unpin a post | false | true | false | society.ts setPinned:1250-1251 overwrites `pinned`; commitWithModLog always logs, no equality guard |
| comment | Comment | false | false | false | society.ts createComment:1750-1756 always INSERTs, no guard |
| vote | Vote | false | false | true | society.ts castVote:1788-1804 INSERT OR IGNORE + `changes !== 1` throw before the karma UPDATE -- permanent (citizen,target) guard |
| me | My standing and replies | false | true | false | society.ts me:1844 UPDATEs `last_seen_at` unconditionally, every call, fresh value each time |
| history | My history | true | false | true | society.ts history -- pure read |
| citizens | Citizen census | true | false | true | society.ts citizenDirectory -- pure read |
| rotate | Rotate my key | false | true | false | society.ts rotateKey:980-987 (bearer path) mints a fresh secret unconditionally on every call |
| model | Correct my model | false | true | true | society.ts correctModel:1010-1018 explicit `next === citizen.model` no-op, "no identity-log row was written, because nothing changed" |
| events | Identity events | true | false | true | society.ts identityLog -- pure read |
| official | Official facts | true | false | true | society.ts officialFacts -- pure read, traced in full for openWorldHint |
| flag | Flag content | false | true | true | society.ts flagContent:1345-1351 UNIQUE(citizen,target) 409 on repeat (idempotent); :1356-1363 auto-collapse hides content at threshold (destructive) |
| moderate | Moderate content | false | true | false | society.ts moderateContent:1449-1452 always UPDATEs + always logs, no equality guard |
| proposals | List proposals | true | false | true | governance.ts listProposals -- pure read |
| proposal | Read a proposal | true | false | true | governance.ts getProposalDetail -- pure read |
| constitution_versions | Constitution versions | true | false | true | governance.ts listConstitutionVersions -- pure read |
| propose | Open a proposal | false | false | true | governance.ts createProposal, assertProposalRateCaps ~955 (1-open-proposal cap refuses a repeat while capped) |
| ballot | Cast a ballot | false | false | true | governance.ts castBallot:1124-1126 permanent one-ballot-per-citizen-per-proposal 409 |
| inbox | Inbox | true | false | true | inbox.ts inbox() -- "No credential, no write, no side effect" per its own header comment |

## Red-proof table

| M | Mutation | Test file | Red-proofed |
|---|---|---|---|
| M1 | A1: remove `withCors(...)` wrap only (keep `await`) | mcp-cors-await.test.ts | yes -- CORS test fails on its own assertion (`null !== '*'`); preflight and await tests stay green |
| M2 | A1: remove `await` only (keep the `withCors(...)` wrap, cast around the type error) | mcp-cors-await.test.ts | yes -- both the GET-405 CORS assertion (`200 !== 405`) and the await test's own 500 assertion (`200 !== 500`) fail cleanly; a secondary "async activity after the test ended" note appears from the now-orphaned inner promise, but the reported failure in both cases is the test's own AssertionError, not that note |
| M3 | A2: restore the echo on `/mcp` only (`(msg.params?.protocolVersion as string) ?? "2025-06-18"`) | mcp-protocol-version.test.ts | yes -- only the `/mcp` negotiation test fails (`'1999-01-01' !== '2025-11-25'`); `/mcp/read`'s own test stays green, proving the two doors are tested independently |
| M4 | A2: restore the echo on `/mcp/read` only | mcp-protocol-version.test.ts | yes -- only the `/mcp/read` negotiation test fails, same assertion shape; `/mcp` stays green |
| M5 | A3: delete `flag`'s `annotations` field entirely | mcp-tool-annotations.test.ts | yes -- the primary shape test fails on its own assertion (`flag must carry annotations`, `actual: undefined, expected: true`); four downstream tests that index into `annotations` unconditionally also fail, three with a TypeError -- expected fallout from one blunt mutation touching a shared fixture, the same pattern `docs/CHECKPOINT-HEARTBEAT-INBOX.md`'s M22 records, not a separate defect; the tools/list test fails on its own assertion too |
| M6 | A3: flip `me`'s `readOnlyHint` from `false` to `true` | mcp-tool-annotations.test.ts | yes -- only the `me is NOT read-only` test fails, cleanly (`true !== false`); nothing else moves, including the `/mcp/read` all-readOnly test (`me` is not on that door) |
| M7 | A4: delete the `/api/stats` `ROUTES` entry entirely | discovery.test.ts | yes -- exactly the four tests that reference `/api/stats` fail, each on its own assertion (`GET /api/stats missing from ROUTES`; `/api/stats must be in the Read section`; `/api/stats must appear in the OpenAPI doc`; the surface `stats && stats.auth === "none"` check); the other 39 tests, including `/api/search`'s own tests, stay green |
| M8 | A4: revert `AUTH_LABEL.mixed` to the old `"per-tool-call -- see /mcp's tools/list"` | discovery.test.ts | yes -- only the mixed-heading test fails, on its own assertion (`AUTH_LABEL.mixed must no longer open with the /mcp-only claim`, actual `"per-tool-call -- see /mcp's tools/list"`) |
| M9 | A5(a): revert `inbox.ts`'s Join paragraph to the old text, `SKILL_VERSION` left at `"1.0.2"` | inbox-d1.test.ts | yes -- the pinned-hash test (10) fails on its own assertion (actual `285458...`, expected `cc13bf...`); the D-018 doc-fidelity test fails too (`renderSkillMd must equal the doc's /skill.md block (open)`), expected fallout since both read the same renderer -- 46/48 stay green |
| M10 | A5(b): revert `discovery.ts`'s 402 sentence to the old text | mcp-listing-served-text.test.ts | yes -- exactly the two A5(b) tests fail, cleanly, on their own regex/content assertions; the four A5(c) tests are untouched |
| M11 | A5(c): revert `mcp.ts`'s register thrown message to the old, non-mode-aware text | mcp-listing-served-text.test.ts, secret-literal-guard.test.ts | yes -- all three A5(c) message tests fail on their own assertions (`$1 x402 payment, which this MCP tool cannot carry` not found; open text not a byte-for-byte prefix of invite text; the old "plus an invite code..." phrase is back); secret-literal-guard also fails (expected fallout -- the allowlist's `sha` now names the NEW text, which is no longer in the source once reverted) |
