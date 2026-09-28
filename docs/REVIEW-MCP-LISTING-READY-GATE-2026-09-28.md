**VERDICT: DEPLOYABLE WITH CONDITIONS.** C1: at the real run, `git diff --name-only 04d51c17 HEAD` in `society/` names no path outside this range's 17, because the deploy script ships whatever `main` holds and wave B (`x402-settle-honesty-2026-09-28`, money path, same base) is in flight. C2: reword the `/mcp` `register` tool's description (`src/mcp.ts:41`), whose "MCP has no channel to carry one" is false of MCP (x402 publishes an MCP transport), and move its pin (`test/mcp-listing-served-text.test.ts:62`). No HIGH. Nothing in the range mints, touches money, registration, listings or the schema, or opens a write to a read-only door.

# D-018 gate: MCP listing readiness (wave A), 2026-09-28

**Reviewer:** an independent Opus gate, working alone from `docs/BRIEF-MCP-LISTING-READY.md`,
`docs/CHECKPOINT-MCP-LISTING-READY.md`, the converged code review
(`exchange/REVIEW_mcp-listing-ready-build-2026-09-28.md`) and the code. Every claim below was
re-derived from source; the checkpoint's line numbers were not reused.

**Scope:** `04d51c17..8fd8131d` on `mcp-listing-ready-2026-09-28` (14 commits, 17 paths; worktree
`scratch/wt-mcp-ready`). `04d51c17` is the live code.

**Read-only:** no source or test edit, no push, no deploy, no `wrangler`, no `*.local.*` or `.env`
read. Network: public GETs only (live `/api/surface`, live `/llms.txt`, the x402 MCP-payments
documentation).

**Where the probes ran:**
- Scratchpad scripts importing the worktree's `src/` read-only. They rendered every changed surface
  in both registration modes, and called the real router's default export with an empty env to send
  body-shape probes to both doors.
- `git merge-tree --write-tree`, which touches no ref and no working tree.
- PowerShell's own parser, run on the deploy script.

This record is the only file written in the worktree.

## Findings

### HIGH

None.

### MEDIUM

**M1. The deploy script cannot tell which commits it ships, and a second wave on the same base is in flight.**
- **Where:**
  - `scripts/deploy-mcp-listing-ready.ps1:124-142` holds the script's only identity checks: a clean
    tree, `## main...origin/main` level, and `SUPPORTED_PROTOCOL_VERSIONS` present in `src/mcp.ts`.
  - `:177` runs `npx wrangler deploy`, which ships all of `HEAD`.
- **Defect:** none of those checks can tell "main = `04d51c17` + this range" from "main = `04d51c17`
  + this range + wave B".
  - Wave B is `x402-settle-honesty-2026-09-28` (worktree `scratch/wt-x402-honesty`, head `50bff47e`),
    branched from the same `04d51c17`.
  - It changes `src/x402.ts` (257 lines), `src/register-gate.ts` and `src/listings.ts`: the settle path
    this gate was told not to review.
  - It has its own deploy script, `scripts/deploy-x402-settle-honesty.ps1`.
- **Scenario:** wave B is merged to `main` but not yet deployed by its own script, and Ben runs this
  one. The header (`:1-3`) and the closing line (`:287`) still say "wave A ... worker only,
  non-minting". The ride checks only wave A's surfaces. Wave B's settle-path code goes live under a
  gate that never read it, without its own ride.
- **The merge itself is clean:**
  - `git merge-tree --write-tree --name-only --merge-base=04d51c17 8fd8131d x402-settle-honesty-2026-09-28`
    exits 0 and lists no conflicted path.
  - The one shared file, `test/secret-literal-guard.test.ts`, is edited in different hunks. Wave A
    changes one `sha` at `:247`; wave B adds a `PROSE_ALLOW` entry and moves the baseline 69→70 and
    46→47. The combined counts are consistent (wave A changes a value, not a count).
  - The script's own `npm test` (`:146`) exercises whatever tree it deploys.
- **Fix:** C1.

**M2. The `/mcp` `register` tool's description makes a false claim about MCP.**
- **Where:**
  - `src/mcp.ts:41`, served by `tools/list` on `/mcp` and read by every listing directory.
  - Worded by the hub at `docs/BRIEF-MCP-LISTING-READY.md:145`.
  - Pinned by `test/mcp-listing-served-text.test.ts:62` (`assert.match(register.description, /no channel to carry one/)`),
    so the test enforces the falsehood.
- **Defect:** "MCP has no channel to carry one" is a claim about MCP, and MCP has such a channel.
  - The x402 Foundation publishes an MCP transport, `specs/transports-v2/mcp.md`
    (https://github.com/x402-foundation/x402/blob/main/specs/transports-v2/mcp.md). Coinbase's
    "Discover & pay over MCP" documentation cites it: https://docs.cdp.coinbase.com/x402/buyer/mcp-payments.
  - In it, the client carries the payment in the tool call's `_meta["x402/payment"]`.
  - What is true is narrower: this door implements no such channel. It speaks x402 v1 over HTTP only
    (`src/x402.ts:164`).
  - The thrown message already says it correctly: "which this MCP tool cannot carry" (`src/mcp.ts:510`).
- **Not a regression:** the live description (`src/mcp.ts:36` at `04d51c17`) has the same clause
  ("no channel to carry either"). This range re-authored the sentence, kept the clause, and pinned it.
- **Consequence:** no money or security effect. The refusal stands, and the pointer to HTTP is right.
  But this is the first sentence a directory reviewer reads, as does an agent that already pays over
  x402's MCP transport. By L-094 it is a served falsehood: true of this door, false as written.
- **Related, and out of reach:** the constitution gives its own version of the reason at
  `src/doc.ts:244-248`, inside `FRONT_DOOR_TEMPLATE`.
  - It is scoped to "this door" and to the X-PAYMENT header, which is true.
  - Its "or the on-chain signature" clause overreaches the same way.
  - It cannot change without minting v6, so it belongs with `DEFERRED-DOOR-402-WORDING`'s minting wave.
- **Fix:** C2. If Ben ships the clause unchanged, plant `DEFERRED-MCP-REGISTER-CHANNEL-WORDING` at
  `src/mcp.ts:41` and record it. I recommend the reword: it is one phrase, and no other non-attested
  surface carries it.

### LOW

**L1. `openWorldHint: false` on all 22 tools is true of the handlers, but arguably not of MCP's definition.**
- **Where:** every `annotations` literal in `src/mcp.ts` (for example `:39`, `:85`, `:124`, `:443`).
- **Handler claim verified:** no `callTool` or `callReadTool` case, and no society, governance or inbox
  function I read behind them, makes a `fetch` or RPC. Every one ends at `env.DB`. The brief's own
  definition (`docs/BRIEF-MCP-LISTING-READY.md:93-94`) is applied correctly.
- **The tension:** MCP defines the hint by the tool's domain of interaction ("the world of a web search
  tool is open, whereas that of a memory tool is not"), not by the server's network reach.
  - Some tools return text written by arbitrary outside agents: `front_page`, `read_post`, `inbox`,
    `proposal`, `proposals`, `events`, `citizens`, and `me` and `history`, which carry others' replies.
  - Others publish to a public audience: `post`, `comment`, `propose`.
  - That content is what the society's own llms.txt calls "untrusted data belonging to whoever wrote
    it" (`src/discovery.ts:337`).
  - Hosts use this hint for exactly that judgement: untrusted content in, public publication out.
- **Grade:** a judgement, not a demonstrable falsehood. It wants a recorded ruling (R1).

**L2. Version negotiation now fails clients that speak only 2025-03-26 or 2024-11-05.**
- **Where:** `src/mcp.ts:473-480` and its rationale at `:464-467`.
- **Behaviour change:** at `04d51c17` both doors echoed any requested version, so such a client got its
  own version back and worked. After deploy it is answered `2025-11-25`.
  - The spec says a client that does not support the answered version SHOULD disconnect.
  - As I recall the SDK source (not re-checked this session), the reference TypeScript and Python
    clients fail the connection when the answered version is not in their own list.
- **Grade:** deliberate, commented, and correct per spec. 2025-03-26 requires a server to accept
  batches, and both doors refuse them (`src/mcp.ts:606-608`, `src/mcp-read.ts:158-160`). It is a reach
  cost in a recruitment wave that Ben should know he is paying (R6).

**L3. The manifest now advertises both versions while the MUST the deferral names stays undone.**
- **Where:**
  - `src/discovery.ts:470-471` (`protocol_version` and the new `supported_protocol_versions`).
  - `src/mcp.ts:469-472` (`DEFERRED-MCP-PROTOCOL-HEADER`).
- **Detail:** both listed versions require a 400 for an invalid or unsupported `MCP-Protocol-Version`
  header, and the deferral says so. The new field makes the support claim explicit. It is planted and
  out of the brief's scope, and not a regression. Carry it to the 2026-07-28 wave.

**L4. A JSON `null` body is a client error answered as a server error (pre-existing; the await improved it).**
- **Where:** `src/mcp.ts:606` and `src/mcp-read.ts:158` reject arrays only. `src/mcp.ts:613` and
  `src/mcp-read.ts:167` then read `msg.method` off `null`.
- **Probe:** through the real router, on both doors, the body `null` answers 500
  `{"error":"Internal error. The society apologizes."}` with `Access-Control-Allow-Origin: *`. It also
  logs `{"level":"error",...,"message":"TypeError: Cannot read properties of null (reading 'method')"}`.
  - At `04d51c17` the same body rejected `fetch()`'s promise, by the mechanism the build's M2 red-proof
    shows: no JSON, no CORS, no router log line.
  - So on this path the await is an improvement.
- **The root cause stays:** anyone can mint error-level lines at will. String and number bodies answer
  `-32601` over HTTP 200, which is harmless.
- **Fix:** answer `-32600` for any non-object body, beside the batch check (R2).

**L5. Six served sentences send readers to `GET /api/surface` for a recipe it does not serve (pre-existing, outside the range).**
- **Where:**
  - `src/discovery.ts:391-393` (llms.txt: "spelled out under "citizen_secret" in the auth vocabulary of
    GET /api/surface").
  - `src/mcp.ts:306`, `:385` and `:424` (`moderate`, `propose`, `ballot`: "GET /api/surface documents
    the encoding").
  - `src/society.ts:382` (the D-056 refusal) and `:846` (the public-key 201).
- **Defect:** `renderSurface` (`src/discovery.ts:551-569`) and `handleSurface` serve eight keys:
  `society`, `origin`, `generated`, `cors_preflight`, `routes`, `unmatched`, `heartbeat` and `skill`.
  None is an auth vocabulary.
  - `AUTH_LABEL` reaches only llms.txt group headings (`:330`) and `/skill.md` (`:451`).
  - The live `/api/surface` has the same eight keys, and "utf8-byte-length" appears nowhere in it.
  - Route notes give each binding's argument list. The byte-level recipe (length prefix, comma join,
    lowercase hex) is served only under llms.txt's `citizen_secret` heading and in `/skill.md`'s
    Credentials section.
- **Consequence:** small, because the refusal names the exact expected string. It is the L-002 class
  the hub's `56d9a522` fixed for one heading (R3).

**L6. An orphaned `{"token","body"}.` line in llms.txt's Showhome paragraph (pre-existing, live).**
- `src/discovery.ts:367`. It is live at lines 58-65 of today's `/llms.txt`, and untouched by the range (R4).

**L7. Text and markdown responses carry no CORS header (pre-existing; relevant to this wave's goal).**
- **Where:** `src/index.ts:79-81` and `src/discovery.ts:42-54`.
- **Effect:** `GET /`, `/llms.txt`, `/skill.md`, `/heartbeat.md`, `/humans.txt` and `/robots.txt`
  cannot be read by a browser-based client or checker. Nothing served claims otherwise: the
  `cors_preflight` note (`src/discovery.ts:565`) describes OPTIONS.
- A1 was scoped to the MCP doors. A directory inspector that reads llms.txt or skill.md from a browser
  will fail the way the doors did (R7).

## The five questions

**(1) Served sentences, against the whole deployment.**
- **The two 402 sentences are true in both registration modes:** `/skill.md` Join (`src/inbox.ts:654`,
  identical at `docs/HEARTBEAT-SKILL-TEXT.md:84`) and llms.txt (`src/discovery.ts:377-382`).
  - Every refusal they list runs before `buildPaymentRequirements` (`src/register-gate.ts:154`) and
    `payAndSettle` (`:168`): invite (`:111`), handle shape and taken (`:118`), model (`:131`), the
    throttle (`:132`), and public_key shape and import (`:144-152`).
  - `payAndSettle` answers 402 whenever X-PAYMENT is absent (`src/x402.ts:158-171`).
  - "An hourly registration limit" covers both of the throttle's limits: 3 per IP (`src/society.ts:514`)
    and 300 society-wide (`:520`).
  - The registration throttle's `reg_log` row (hash namespace `reg:`) is written only inside
    `register()`, after settlement (`src/society.ts:783`), so a refused or 402'd request spends no
    allowance, and "cost nothing" holds. The table's other INSERTs (`:576`, `:619`, `:691`, `:694`,
    `:736`) belong to other throttles, each under its own namespace, and never count toward this one.
  - `public_key` has no uniqueness constraint (`schema.sql:16`), so no key refusal can land after payment.
  - The only paid failure is the documented handle race (`src/register-gate.ts:161-168`).
  - "$1" is a constant (`src/register-gate.ts:28`).
- **The thrown register message is true in both modes** (`src/mcp.ts:509-512`). It reads the mode as
  `src/register-gate.ts:111` does.
- **The register description** (`src/mcp.ts:41`) is false: see M2.
- **The three ROUTES entries** (`src/discovery.ts:133`, `:140-143`, `:144`) match their handlers:
  - `searchPosts` (`src/discovery-data.ts:78-117`): 400 on a missing or blank q; title-or-body LIKE with
    wildcards escaped; `mod_state IS NULL`; newest first; default 20.
  - `publicStats` (`:128-168` with `src/society.ts:62-68`): every figure is a COUNT(*), and
    `generated_at` is a timestamp.
  - The reply route (`src/index.ts:303-316`): a Bearer header takes the citizen branch even when it is
    invalid; otherwise the body token takes the visitor branch.
  - Placement is correct everywhere. llms.txt Read lists search and stats; reply sits under the mixed
    heading. `/openapi.json` carries search, with `q` required, and stats, but not reply.
    `/api/surface` carries all three with their notes.
- **`AUTH_LABEL.mixed` is true** (`src/discovery.ts:252`). `/api/surface` serves each mixed route's note
  (`:559`). `/mcp`'s `tools/list` conveys per-tool auth: a `secret` argument on the 12 authenticated
  tools, and "No auth needed" on the nine read tools.
- **The manifest's version fields** (`src/discovery.ts:470-471`) match both doors' negotiation.

**(2) Security.**
- **CORS `*` on `/mcp` opens nothing, because no ambient credential exists.**
  - `authenticate()` takes only a string the caller supplies (`src/society.ts:312-337`).
  - Nothing reads a cookie, and no response sets `WWW-Authenticate`, so no browser caches HTTP auth
    for this origin.
  - At `04d51c17` the preflight already answered `*` and allowed `Authorization`, so a cross-origin POST
    carrying a credential could already be sent. The wave only lets a page read the answer, and that
    page already held the credential.
  - No MCP tool's answer depends on the caller's IP.
- **The await changes two error paths, both for the better.** A non-SocietyError from any tool now
  reaches the router's catch (`src/index.ts:533-537`): JSON 500, CORS and a log line, where before it
  rejected `fetch()`. The other is L4.
  - SocietyErrors are still answered inside the doors as `isError` results (`src/mcp.ts:638-645`,
    `src/mcp-read.ts:192-199`).
  - `withCors` (`src/index.ts:92-96`) copies status, statusText, body and every header. The tests cover
    200, 202, 405 and 500.
- **The read-only door reaches no write.** `callReadTool` (`src/mcp-read.ts:95-145`) is unchanged and
  never imports `authenticate`. I read all nine read handlers in full and found no write.

**(3) Constitution, money, schema.**
- `FRONT_DOOR_TEMPLATE` is byte-identical at `04d51c17` and `8fd8131d` (18,480 characters each,
  string-compared). The `src/doc.ts` change is a comment above it.
- `buildConstitutionTemplate` (`src/governance.ts:1816-1840`) reads only doc.ts's template and its
  name, banner and join fragments, none of which this range touches. `src/governance.ts` is not in the
  range.
- The v5 pin test ("9: the wave does not mint", `test/topics-d1.test.ts`) passed in my run.
- No path in the range is under `src/x402.ts`, `src/register-gate.ts`, `src/listings.ts`,
  `src/wallets.ts`, `src/payouts.ts`, `migrations/`, `schema.sql` or `wrangler.jsonc`.

**(4) Annotations, each re-derived against its handler.**
- **`readOnlyHint: true` holds for all ten tools that carry it.** `register` throws before any D1 access
  (`src/mcp.ts:500-513`). The nine read tools are write-free: `frontPage`, `readPost`,
  `citizenDirectory`, `identityLog`, `officialFacts`, `listProposals`, `getProposalDetail`,
  `listConstitutionVersions` and `inbox`.
- **The authenticated tools write, as marked.** Bearer authentication is a SELECT (`src/society.ts:322-335`).
  The assertion path inserts a nonce and prunes expired ones (`:446-459`), so the C1 fix to `history`
  is right.
- **`destructiveHint: false` holds on the six write tools that carry it** (the ten read-only tools also
  carry it, where MCP treats it as meaningless):
  - `post` inserts; a bulletin adds a log row.
  - `comment` inserts.
  - `vote` inserts plus a karma increment.
  - `propose` inserts and deletes only its own just-inserted row on failure.
  - `ballot` is a gated append.
  - `history` writes nothing but the nonce.
- **`idempotentHint: true` holds on the five write tools that carry it** (the ten read-only tools also
  carry it, likewise meaningless there):
  - `vote`: INSERT OR IGNORE (`src/society.ts:1788`), then a 409 (`:1804`) before the karma
    increment (`:1806`).
  - `flag`: UNIQUE, then a 409 (`:1345-1351`).
  - `model`: an equality no-op (`:1010-1018`).
  - `ballot`: a pre-check and gated append, then a 409.
  - `history`.
- **The conservative marks are safe-direction.** `me` destructive, and `pin` and `moderate`
  non-idempotent, are correct or conservative.
- **The source-derived C1 guard is sound for its stated scope.** `toolsCallingAuthenticate()`
  (`test/mcp-tool-annotations.test.ts:50-64`; its source bounds come from `callToolSource()` at `:39-46`) scans `callTool`'s real source.
  - It flags each `case` block with a direct `authenticate(` call.
  - It pins the derived set to 12 names, so a new authenticating tool fails loudly.
  - Out of its reach: indirect authentication, and a write that needs no credential.
- **openWorldHint:** see L1.

**(5) The deploy script.**
- **It fails closed on every check it names.**
  - Each ride check `Stop-Here`s.
  - Every `curl.exe` call checks the exit code before it trusts the status.
  - The test gate needs exit 0 and a `fail 0` summary. An absent summary stops it. In today's output
    only the summary lines match its first-match regexes.
  - The script parses with 0 errors, no case-colliding variable names, and no `$name:` tokens.
  - Attest is read (`:264-269`) before `GET /` (`:274`), whose detection write could otherwise record
    a mint first.
- **It deploys only the worker.** `wrangler.jsonc` is untouched by the range.
- **It runs every pre-check it claims.**
- **What it cannot do is know what it ships:** M1.

## Conditions

- **C1.** Immediately before the real run, in `society/` on `main`, run
  `git -C "C:\Users\bengr\Projects\AI domain and social network\society" diff --name-only 04d51c17 HEAD`.
  It must print only paths from this range's 17:
  - `docs/BRIEF-MCP-LISTING-READY.md`, `docs/CHECKPOINT-MCP-LISTING-READY.md`,
    `docs/HEARTBEAT-SKILL-TEXT.md`, `scripts/deploy-mcp-listing-ready.ps1`;
  - `src/discovery.ts`, `src/doc.ts`, `src/inbox.ts`, `src/index.ts`, `src/mcp-read.ts`, `src/mcp.ts`;
  - `test/discovery.test.ts`, `test/inbox-d1.test.ts`, `test/mcp-cors-await.test.ts`,
    `test/mcp-listing-served-text.test.ts`, `test/mcp-protocol-version.test.ts`,
    `test/mcp-tool-annotations.test.ts`, `test/secret-literal-guard.test.ts`.

  C2 adds no path. If any other path appears (wave B's `src/x402.ts`, `src/register-gate.ts`,
  `src/listings.ts`, ...), do not run this script. Wave B deploys first, under its own D-018 record and
  its own script. Then re-run this check against the commit wave B deployed, in place of `04d51c17`.
  Encoding the check into the script is optional; if done, re-parse the script.
- **C2.** Reword `src/mcp.ts:41` so that it claims only what this door does. The hub writes the words.
  The minimal edit: "and MCP has no channel to carry one" becomes "and this MCP door cannot carry
  one", matching `:510`.
  - Move the pin at `test/mcp-listing-served-text.test.ts:62` to the new phrase.
  - Add an assertion that "MCP has no channel" is absent, and see it red against the old string.
  - Suite green and typecheck exit 0 after.
  - `src/doc.ts:244-248` stays as it is: it is attested, and M2 names its place.

## Recommended, not required before this deploy

- R1. A DECISIONS.md ruling on which reading of `openWorldHint` Commonhold uses (L1). If it is MCP's,
  set `true` on the tools that return or publish citizen-authored text.
- R2. Answer `-32600` for any non-object JSON-RPC body on both doors (L4).
- R3. Serve `AUTH_LABEL` on `/api/surface` (for example as `auth_vocabulary`). That makes all six
  pointers in L5 true in one line; the alternative is rewording them.
- R4. Mend the Showhome paragraph's orphaned line (L6).
- R5. For wave B, not this one: `X-PAYMENT-RESPONSE` is set on real responses (`src/x402.ts:285`,
  `src/listings.ts:457`, `:875`), but `Access-Control-Expose-Headers` sits only on the preflight
  (`src/index.ts:149`), where browsers ignore it. So browser JS cannot read the settlement header.
  `test/mcp-cors-await.test.ts:103` pins the preflight value.
- R6. Record the 2025-03-26 and 2024-11-05 trade-off (L2) in DECISIONS.md. Include what a reversal
  would cost: batch receipt.
- R7. If a browser-based directory checker is expected, add CORS to the text and markdown responses
  (L7).

## What I did not check

- I did not run the deploy script, `-DryRun` included (hard rule).
- I ran no red-proofs of my own, because I edited no source or test file. For tests, I read the
  assertion text, and relied on the checkpoint's mutants only where I had re-read that text.
- I did not run the suite on the merged A+B tree. `merge-tree` proves the merge is textually clean,
  nothing more.
- I connected no real MCP client (Inspector, the TypeScript or Python SDK) and no browser to either
  door. L2's claim about SDK clients is from memory.
- I did not check MCP 2025-11-25 conformance beyond what the brief names.
- I did not test Windows PowerShell 5.1's response-header dictionary casing beyond the precedent
  script's successful run on 27 September.

## What I verified first-hand, and how

- **Suite:** `npm test` in the worktree printed "ℹ tests 1301", "ℹ pass 1301" and "ℹ fail 0", and
  exited 0. `npm run typecheck` exited 0.
- **Rendered surfaces,** from a scratchpad script importing the worktree's `src/`:
  - llms.txt and `/skill.md` in both registration modes;
  - `/.well-known/mcp.json`;
  - the `/openapi.json` paths for the three new routes;
  - the `/api/surface` entries for them and for both MCP doors;
  - all 22 titles and annotation sets.
- **Router probes:** the real default export, with bodies `null`, `"str"`, `42` and a notification, on
  both doors (L4).
- **Every handler named in (4)** read in full for writes, including `authenticate` and
  `authenticateByAssertion`.
- **Non-minting:** a string comparison of `FRONT_DOOR_TEMPLATE` at both commits, a read of
  `buildConstitutionTemplate`, and the pin test's pass line in my run.
- **Live, by public GET:**
  - `/api/surface`: eight keys, `skill.version` 1.0.1, no auth vocabulary, no `/api/search`.
  - `/llms.txt`: the Showhome paragraph.
- **x402's MCP transport:** both pages fetched directly. Coinbase's documentation names the x402
  Foundation spec. The spec itself (`specs/transports-v2/mcp.md`) states that `_meta["x402/payment"]`
  carries the client's payment payload and `_meta["x402/payment-response"]` carries the settlement.
- **Wave B's footprint and the merge:** `git diff --stat 04d51c17..x402-settle-honesty-2026-09-28`,
  and the `merge-tree` line in M1.
- **The deploy script:**
  - parsed with `[System.Management.Automation.Language.Parser]::ParseFile`;
  - variable names checked for case collisions and tokens for `$name:`;
  - the test-gate regexes checked against today's test output;
  - compared line by line with `scripts/deploy-heartbeat-inbox.ps1`.
