# Gate record: the MCP guest door, door counters and /skill.md 1.2.0 (Sonnet gate), 11 Oct 2026

Gate reviewer: Sonnet 5.5 sub-agent, independent of the builder and of the GEMINI and CODEX seats. Read-only. Brief: `drafts/GATE-BRIEF-MCP-GUEST-DOOR-2026-10-11.md`.

**HEAD gated:** `36a8d2fe22d9619c3db56789c312484c54811c23` (branch `mcp-guest-door-2026-10-11`, worktree `scratch/wt-mcp-guest-door`, 7 commits on base `07e9c57d`). Worktree verified clean after the run (`git status --porcelain` empty, HEAD unchanged).

**Tests:** `npm test` 2093 tests, 2092 pass, 0 fail, 1 skipped (the pre-existing skip). `npm run typecheck` (`tsc`) exit 0, silent.

**Live state read (GET only):** `/api/attest` serves `code.commit` `07e9c57d9339a7a8a8acf4b3f9c28674b6eccbd4`, `version_id` `0ed544ae-5ec0-4301-8910-2bcf255caffe`, constitution v5 `fa11788d`, ok true; `GET /api/doors` answers 404 (so the script's "new route absent" probe will pass); `/skill.md` serves 1.1.4. The script's `$LIVE_BASE_COMMIT` and `$ROLLBACK_WORKER_VERSION` are both right.

**Mutation checks I ran myself** (in a throwaway copy under the session scratchpad, since removed; the junction was removed with `rmdir`, the real `node_modules` is intact): `guest_enter` passing `null` for the address -> `test/mcp-guest-door-d1.test.ts` M2 goes red (killed). `showhome_note` passing `null` for the address -> all 42 tests in the four relevant files stay green (SURVIVED, see L1).

## VERDICT: DEPLOYABLE WITH CONDITIONS

HIGH 0, MEDIUM 0, LOW 5. No change to a money route, no edit inside `FRONT_DOOR_TEMPLATE` (`git diff --stat 07e9c57d..HEAD -- src/doc.ts` is empty), no model call, one additive migration (0019), no guest tool reaches a citizen credential or capability.

Conditions (both are Ben's/the hub's acts, neither needs a code change):
- C1. The hub sets `$REVIEWED_COMMIT` in `scripts/deploy-mcp-guest-door.ps1` to the commit this record gates (or its successor after any L-fix) before the merge; step 0 already refuses while it holds the placeholder.
- C2. After the deploy, read `D1 rows_written` (or the worker's door_count_failed warn lines) once for the first full UTC day, to confirm the premise in L2. Not a rollback signal by itself.

## Answers to the brief

**1. Credential isolation: holds.**
- `src/mcp.ts:777-785`: `GUEST_TOOL_NAMES.includes(name)` (list at `:612`) is an exact three-name match on `String(msg.params?.name)`; the guest branch runs `callGuestTool` (`:614-627`) and the `else` branch is the only place `Authorization` is read. No `secret` is computed for a guest tool: `callTool`'s `const secret = typeof args.secret === "string" ? ...` line (`:629`) is not on the path.
- `callGuestTool` hands the three shared functions only `args.handle/model`, `args.token/post_id/kind/parent_kind/parent_id/body` and `args.token/body`. I confirmed `postGuestComment` reads exactly `input.post_id, kind, parent_kind, parent_id, body` (`src/guest.ts:139-161`), so the five-field object is equivalent to REST's whole-body pass. Extra keys, `secret` and a bearer change nothing; a non-string token is refused by `authenticateGuest` (`src/showhome.ts:326-345`), which never reads `citizens`.
- Non-guest tools: `git diff 07e9c57d..HEAD -- src/mcp.ts` shows `callTool`'s body unchanged except one comment (`guest_thread` case). The header expression moved from before the `switch` to the non-guest branch, character for character identical, and no other method used it.

**2. Parity with REST: holds, one test gap (L1).**
- Same functions: `enterShowhome`, `postGuestComment`, `postShowhomeNote` (`src/mcp.ts:614-627` vs `src/index.ts:308-309`, `:354-355`, `:317`), same `request.headers.get("CF-Connecting-IP")`, so one `showhome_rate` cap (`src/showhome.ts:144-189`, keyed on path + ip hash). Refusals are the same `SocietyError.message`; MCP serves `{error: message}` with `isError`, REST serves the same message plus any `code` field (MCP drops `code`, which is true of every existing MCP tool; see L3).
- Tests run on the real local D1 through the real router and compare rows and bodies on two fresh databases (`test/mcp-guest-door-d1.test.ts:105-228`); the mixed-door cap test (`:229-278`) can fail (I killed the `guest_enter` null-address mutant). It does NOT cover `showhome_note` (L1).

**3. Counters: holds.**
- `src/doors.ts:30-39`: one statement, cap in the `DO UPDATE ... WHERE door_counts.n < ?` predicate, whole body in try/catch, logs `door_count_failed` at warn and never throws. `recordDoor` (`:47-54`) hands the promise to `ctx.waitUntil` or returns it.
- Hooks sit after the shared function returned: `src/index.ts:223`, `:228` (200 only), `:309`, `:355`; `src/mcp.ts:754` (initialize), `:780-781` (after `callGuestTool`); `src/mcp-read.ts:184`. A refused write throws first, so it counts nothing; `showhome_note` has no door. `ctx` is the third parameter of `fetch` (`src/index.ts:141`, optional, `satisfies ExportedHandler<Env>` typechecks) and is passed to both MCP handlers (`:295-296`).
- Worst case per day: 6 doors x 2000 = 12,000 counter upserts (assuming L2), 6 new rows a day; `GET /api/doors` (`src/doors.ts:72-80`) selects `day, door, n` only, at most 180 rows, no address, no token.

**4. Served text: true of the code.**
- `/skill.md` 1.2.0 opening vs the commission's S1-S3: verbatim apart from the CODEX-agreed heading `## Start here`. "can earn a reply from commonhold-agent, which aims to answer within 96 hours" renders from `GUEST_ANSWERER` and `GUEST_ANSWER_TARGET_HOURS` (`src/guest-core.ts:40-41`); duties accrue only on an open standing topic under the caps explained at `src/guest.ts:71-127`, so "can earn" is accurate. "Read the constitution, the books and every ballot, with no login": ballots with voter and choice are in the public proposal detail (`src/governance.ts:1266-1278`), books at `/treasury` and `/payouts`. The MCP route lines name tools that exist and `/mcp/read` really is twelve read tools (`src/mcp-read.ts:64-77`).
- `initialize` instructions, tool descriptions, `heartbeatDoorNote`, `/llms.txt`, `/openapi.json`, `/.well-known/mcp.json`, `/api/showhome`, `/api/official.guest_voice`: each changed sentence read against the code; none false. I grepped `src/` for "HTTP only", "HTTP door", "guest write", "citizens only" and read each hit: the remaining ones are about registration (which is HTTP-only) or are unserved comments.
- Template: `src/doc.ts` untouched, and `test/mcp-guest-door-served-text-d1.test.ts:158-168` asserts the live `/api/attest` hash equals v5 `fa11788d...`. The template's prose tool list (`src/doc.ts` HOW TO JOIN (MCP)) says "this list is prose and the server is the truth" and was already incomplete.

**5. Migration and deploy script: sound.**
- `migrations/0019_door_counts.sql` and the `schema.sql` tail are the same CREATE TABLE (three columns, PK `(day, door)`, no FK, no CHECK). Semicolons and apostrophes in its comments have precedent in 0018, which applied on prod.
- `scripts/deploy-mcp-guest-door.ps1`: migration to the remote D1 at `:295-302`, catalogue check at `:179-192` and `:305` (three column names in order, PK in key order, zero FKs, one automatic index), `wrangler deploy --var "CODE_COMMIT:<sha>"` at `:314`, version id from its own line, poll until attest serves the pinned commit and id AND `/api/doors` is 200, then attest re-check. Pre-flight stops: not main, main/origin/expected not one commit, dirty tree, live base not an ancestor, `src/doc.ts` moved, anything but one added `0019` under `migrations/`, placeholder or non-hex `$REVIEWED_COMMIT`, disallowed paths since review, `/api/doors` already 200, guest tables absent.
- The one live write is an MCP `guest_enter` (handle `deploy-ride`, token discarded unread, `:361-363`) and it is disclosed in the header (`:21-24`) with its consequence for `showhome_enter`. Acceptable: free, capped (one `showhome_rate` row), identical to what any agent does, and it is the only real-D1 run of the MCP guest path. Side effects not named in the header: one `visitors` row, and if the visitor ring (1000) is full it ring-prunes the oldest unpromoted visitor (that is what `destructiveHint: true` on `guest_enter` says).
- `$LIVE_BASE_COMMIT`, `$ROLLBACK_WORKER_VERSION` and the placeholder are right (see the live read above). The rollback line leaves migration 0019 in place, which is correct (additive, the old worker never reads the table).

**6. Secret-literal guard: no loosening.** Seven shas replaced one for one (`test/secret-literal-guard.test.ts` PROSE_ALLOW rows for the `/mcp` note, `/mcp/read` description, two llms.txt chunks, the OpenAPI description and the two `mcp-read.ts` strings). Each is a descriptive sentence about credentials in the file named, matches a literal that the scanner finds in that file (an entry without a live literal fails the test), and the baseline stays 79/24/55. The new tool descriptions avoid the word "secret", so they add no literal.

## Findings

**HIGH: none. MEDIUM: none.**

**L1 (LOW). `showhome_note` over MCP has no address-cap parity test.** `test/mcp-guest-door-d1.test.ts:229-278` mixes the doors for `guest_comment` and `guest_enter` only. Mutant: `src/mcp.ts:622` `postShowhomeNote(env, args.token, args.body, null)`. Result in my copy: 42/42 pass across `mcp-guest-door-d1`, `door-counts-d1`, `mcp-guest-door-served-text-d1`, `mcp-tool-annotations`. Scenario: a later refactor drops the address from that one call, the per-address note cap (10 an hour, `SHOWHOME_POST_PER_IP_PER_HOUR`) is silently bypassed over MCP and only the global cap binds, and nothing goes red. The code at HEAD is correct. Fix: add a `showhome_note` alternating REST/MCP run to the M2 test, 10 accepted then refused.

**L2 (LOW). The "flood cannot starve the society's writes" claim depends on an unverified D1 metering premise.** `src/doors.ts:30` at the cap runs an upsert whose `DO UPDATE ... WHERE` is false. Locally it changes nothing (the test pins that). Whether D1's `rows_written` meter also charges nothing for it is not shown anywhere in the tests or the checkpoint. If it charged one row, an unauthenticated flood of `GET /skill.md` or `POST /mcp initialize` after the cap would still cost one D1 write per request, which is a new unauthenticated write path (previously these GETs wrote nothing). The Worker's own 100,000 requests a day bound that, so it is not a deploy blocker. Condition C2.

**L3 (LOW). Structured refusal codes are lost over MCP.** REST `postGuestComment` at the row ceiling throws `SocietyError(503, ..., "guest_capacity")` and the router serves `{error, code}`; `handleMcp` serves only `{error}` (`src/mcp.ts:790-795`, unchanged behaviour for all tools). The message text is the same and says the record is full, so the brief's "same message" holds; an MCP client cannot branch on the code.

**L4 (LOW). Two served sentences point to `/skill.md` for caps it does not state, and a shared gateway address will meet the caps sooner.** `guest_enter` and `showhome_note` descriptions say "For caps and what is refused, see GET /skill.md" (`src/mcp.ts:493-508`, `:529-541`); `/skill.md` states only the comment caps (`guestCapsSentence`, `src/guest-core.ts:374-376`), not the enter cap (5 an hour per address, `SHOWHOME_ENTER_PER_IP_PER_HOUR`, `src/showhome.ts:52`) or the note cap. The refusal itself names the limit ("Too many showhome entries from your address this hour", `src/showhome.ts:130`), so nothing is hidden. Related, not a defect of this wave: the per-address caps are keyed on `CF-Connecting-IP`, so agents arriving through a registry's hosted gateway will share one address; five enters an hour across all of them is a low ceiling. Worth watching in `/api/doors` (`showhome_enter` against the 429s) after the listings are re-staged.

## Questions answered, none missed

Nothing in `src/` outside the files in the diff changed; `wrangler.jsonc`, `src/doc.ts`, `src/x402.ts`, `src/listings.ts`, `src/register-gate.ts` and every existing migration are untouched. The builder's nine declared deviations are all acceptable as written (I checked 1, 4, 5, 7 and 9 against the code; the rest are text).

**L5 (LOW, served text). The MCP line in `## Start here` gives no pointer to a `post_id`.** `src/inbox.ts` (Start here): the HTTP line says "then comment with the token it returns (steps below)", which leads to step 2 (`GET /api/topics`). The MCP line says "call guest_enter, then guest_comment" and stops. `guest_comment` requires `post_id`, so an agent that follows the line literally calls it without one and gets the 400 "post_id must be a positive integer". Not false, and the error is self-explanatory; no verdict change. Possible one-clause fix: "then read GET /api/topics for a post_id, then guest_comment".
