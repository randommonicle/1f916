# Checkpoint log: served code identity (the running commit and Cloudflare's version id)

Branch `code-identity-2026-10-06`, base `69730d99` (`society/` main). Builder: Sonnet 5.5. Contract: `docs/BRIEF-SERVED-CODE-IDENTITY.md` (A1-A8; both exchange seats
closed, `exchange/REVIEW_code-identity-brief-2026-10-06.md`), commission `drafts/BUILDER-COMMISSION-CODE-IDENTITY-2026-10-06.md`. Nothing pushed, deployed, migrated or
written to a network; no `*.local.*` file read; `src/doc.ts`, `schema.sql` and `migrations/` are not touched. Read-only for money-path DECISIONS: this wave adds fields to
answers and one block to `/api/attest`; it changes no status, code, `accepts`, claim write, lease or reconciler selection.

Base: 1860/1860 (`npm test`), measured in the worktree before any edit.

## Commits

| # | sha | what |
|---|---|---|
| 1 | `e0bf8d17` | this log |
| 2 | `30c02f5e` | `src/code-identity.ts`, the `Env` fields, T1 and T2 |
| 3 | `f63fa533` | `GET /api/attest` serves a `code` block outside the constitution, T3 |
| 4 | `0ffb18a1` | `answered_by` in every settlement answer (`claimResponse(answer, identity)`, the three direct answers, the router's SocietyError path), the two DEFERRED flags, the bypass scan, T4, T4a, T4b, T4c, T5 |
| 5 | `4ce56923` | the `version_metadata` binding in `wrangler.jsonc`, `CODE_COMMIT` kept out of `vars` |
| 6 | `07ce8de8` | `scripts/deploy-code-identity.ps1` and its test, the anchored test-count regex in three scripts |
| 7-8 | this commit | red-proof summary, the close, served sentences, points for the hub |

## Notes (one per commit, newest last)

### 2. `src/code-identity.ts`, the `Env` fields, T1 and T2

`codeIdentity(env)` is the one function every surface calls. It takes a structural `{ CODE_COMMIT?: unknown; CF_VERSION_METADATA?: unknown }` (not `Env`), so a var set to anything is judged at
runtime and the module imports nothing from `society.ts` (only `Env` imports the `VersionMetadata` type from it, type-only). `COMMIT_PATTERN = /^[0-9a-f]{40}$/`, no `m` flag, no trim.
`undefined` and `null` are "absent" (`not_stamped`); every other non-matching value, including an empty string and a non-string, is `malformed_stamp` with `commit: null`, the value never served.
`version_status` is `"available"` when the binding carries a non-empty string `id`, else `"unavailable"` (the brief names only `"unavailable"`; `"available"` is my choice for the present case).
`ANSWERED_BY_NOTE` is the brief's A7 text, copied byte for byte (a later test reads the brief and checks it is quoted there). `answeredBy(identity)` is the narrow block
`{ commit, commit_status, version_id, note }`; `codeBlock(env)` is the identity plus `CODE_PROVENANCE`.

**Provenance wording (a difference to flag):** the brief says the labels follow `/api/official`'s (record / commonhold_statement) and calls `version_id` a "platform record". In
`society.ts` `COMPOSITION_PROVENANCE.key`, `record` is defined as "reproducible from public data", which a Cloudflare version id is not. So `version_id.source` is `["platform_record"]`, a
new label defined in `CODE_PROVENANCE.key`, and `commit.source` is `["commonhold_statement"]` as the brief says. The seats should press on this choice.

Tests: `test/code-identity.test.ts` (10). Red-proofs (mutant applied exact-once, the file run alone, bytes restored and sha256 compared): hex class dropped (2 red), trim before test (1), serve the
malformed value (1), absent stamp defaults to a fixed sha (1), `m` flag on the pattern (2), absent binding reports "available" (3), empty id accepted (1), timestamp dropped (1). The harness is a throwaway
script in `scratch/code-identity-builder/`, not committed.

### 3. `GET /api/attest` serves a `code` block, T3

`src/index.ts` (the `/api/attest` branch): `return json({ ...att, constitution, code: codeBlock(env) })`. A new top-level key beside the existing ones, outside `constitution` and outside
`FRONT_DOOR_TEMPLATE`; `src/doc.ts` is not touched. Only the HTTP route serves attest (`getConstitutionAttestation` is read by no MCP tool), so this is the one surface. The existing
non-minting pins (`guest-served-text-d1` test 21, `settlement-replay-served-text-d1` test 13, `doc.test.ts`) hold, and T3 adds its own: the template hash is `fa11788d...` (v5), the served
`constitution` block is `deepEqual` with and without a stamp, and serving `code` writes no `constitution_versions` row.

`test/code-identity-attest-d1.test.ts` (5): stamped plus binding; not_stamped and unavailable with nulls; four malformed stamps (the bad value appears nowhere in the response body); every prior key
still served; non-minting. Red-proofs: `code` key dropped (4 red), the block built from an empty env (2), the block put inside `constitution` (5), provenance removed (2), a prior key overwritten (4).

Not done, by the brief's file list: `src/discovery.ts`'s `/api/attest` route description (it still says only "recomputes the hash chain...") does not mention `code`; `/api/surface`, the
OpenAPI document and llms.txt therefore do not advertise the new block. A one-line follow-up for the hub to rule on (a served-text change, so it would want the seats).

### 4. `answered_by` in every settlement answer (A1, A2, A3, A7, A8), the two DEFERRED flags, T4, T4a, T4b, T4c, T5

`claimResponse(answer, identity)` (settlement-claims.ts) serialises `{ ...answer.body, answered_by }`, identity LAST; `identity` is a REQUIRED parameter, so `tsc` enumerated every call site and a
future one that forgets it fails typecheck. `claimAnswer` and `contradictionAnswer` are untouched and pure. `claimErrorResponse(body, status, identity)` is the helper for the answers x402.ts builds
directly (it calls `claimResponse({ status, body }, identity)`, so the headers, CORS `*` included, are exactly what they were). `SETTLEMENT_CLAIM_UNAVAILABLE` is a new constant for the
`"settlement_claim_unavailable"` string (same value). The `Env` is read only through `codeIdentity(env)` at each site.

**Every call site (x402.ts line numbers at this commit):**
`claimResponse(claimAnswer(...), codeIdentity(env))` at :765 (payAndSettle, the first-attempt refusal answer), :847 (the 409 conflict), :850 (handle-taken, listing-not-paying, stopped), :854 and
:884 (lease held), :861 (after a finisher that did not finish), :896 (held success), :899 (the pending answer), :904 (the fallthrough), :1010 and :1012 (answerFromMovedClaim), :1026 (answerFromClaim).
`contradictionResponse(env, tx, state)` (it gained an `env` parameter; it is private) at :887, :895, :1002, defined at :986. **The three direct answers (A2)**, now `claimErrorResponse(..., status,
codeIdentity(env))`: :637 (503 `settlement_claim_unavailable`, "could not confirm whether a claim was recorded"), :654 (502 `settlement_unresolved`, "recorded a claim but could not confirm"), :675
(503 `settlement_claim_unavailable`, "could not record a claim"). The other `Response.json` sites in x402.ts (:523, :555, :579, :773, the patron 200) carry no settlement code and are unchanged.
No other file called `claimResponse` or `claimAnswer`.

**Two paths the brief did not name, found by reading what serves a settlement code (a brief-versus-code discovery; the seats should press on it).** A settlement answer can also be THROWN as a
`SocietyError` and served by the router's catch (`index.ts`, `json(errorBody(e), e.status)`), which bypasses `claimResponse`: (1) `listings.ts` (the listing-no-longer-awaiting answer,
`SETTLEMENT_UNRESOLVED`, 500) carries a settlement code and so falls under the brief's literal rule; (2) `register-gate.ts` (two sites) throws the handle-taken answer
(`registration_handle_taken_after_payment`), which is not a `settlement_*` code but IS a claim answer that `claimAnswer` serves on a replay (brief T4 lists "handle-taken"), and the existing test
`settlement-replay-fixes-d1` F1 asserts a first answer and its replay are `deepEqual` ("the same answer"), which went red (2 tests) the moment the replay gained `answered_by` and the first answer
did not. Fix: ONE chokepoint, the router's catch, adds `answered_by` when `e.code` is on the exported `SETTLEMENT_ANSWER_CODES` (the four settlement codes, `settlement_claim_unavailable`, and
`REGISTRATION_HANDLE_TAKEN_AFTER_PAYMENT`). Status, code and message are the error's own; every other `SocietyError` is served exactly as before (a test pins that). Not touched: `register-gate.ts`
and `listings.ts` themselves.

**T5 held without touching a single existing test file:** every existing claim-answer test calls the pure `claimAnswer` (none calls `claimResponse`), and F1 passes unchanged now that both answers
carry the field. `git diff --stat` for `test/` shows only new files.

**The scan (`test/helpers/answer-scan.ts`, used by `test/code-identity-answers-d1.test.ts`).** It blanks comments, skips string and template literals when matching brackets, and applies R1 (a body
literal `code: <settlement code>`, found by the `SETTLEMENT_` prefix so a NEW code is caught with no list to forget, must sit inside `claimResponse(`/`claimErrorResponse(` or, in
settlement-claims.ts, inside `claimAnswer`/`contradictionAnswer`), R2 (`claimAnswer(`/`contradictionAnswer(` outside settlement-claims.ts only inside `claimResponse(`), R3 (`new SocietyError(`
naming a settlement code: the code must be on `SETTLEMENT_ANSWER_CODES`) and R4 (every `claimResponse(`/`claimErrorResponse(` call outside settlement-claims.ts ends with `codeIdentity(env)`, so a call
that typechecks but passes `codeIdentity({})` is caught). Positive controls feed it synthetic bypasses and watch it fail, and feed it the sanctioned forms, comments and unrelated codes and watch it pass.

**Flags planted:** `DEFERRED-CLAIM-ROW-CODE-IDENTITY` immediately above `takeClaim` (settlement-claims.ts); `DEFERRED-SERVED-SCHEMA-IDENTITY` immediately above the `/api/attest` code block (index.ts),
carrying CODEX's A5 candidate. `test/code-identity-deferred-flags.test.ts` (3) pins both, their position and their reasoning.

Tests: `test/code-identity-answers-d1.test.ts` (14), `test/code-identity-deferred-flags.test.ts` (3). Base after this step: 1892/1892, tsc 0. Red-proofs (each mutant exact-once, the file run alone,
bytes restored and sha256 compared): `claimResponse` drops `answered_by` (9 red); identity spread first (T4b red); one word of the note changed (T4c red); the pre-round-3 note wording restored (T4c red);
`claimResponse` drops CORS (4 red); each of the three direct answers given the wrong env, one at a time (its own T4a test red, plus the scan's R4); the last direct answer reverted to a bare
`Response.json` (its T4a red, plus the scan's R1); `claimErrorResponse` drops CORS (all three T4a red, A8); the router drops the field (handle-taken and listing tests red); the list loses the handle-taken
code (handle-taken red, scan R3 red); `contradictionResponse` given the wrong env (scan R4 red); `answerFromClaim` serving the answer raw (scan red); each flag renamed away or its reasoning edited (flag tests red).

### 5. `wrangler.jsonc`: the `version_metadata` binding

`"version_metadata": { "binding": "CF_VERSION_METADATA" }` added after `d1_databases` (key and shape read from the installed `node_modules/wrangler/config-schema.json`, a file read; no `wrangler`
command was run). `CODE_COMMIT` is deliberately NOT in `vars` (A6): the comment beside the binding says why. `test/code-identity-config.test.ts` (3) pins the binding name against the name `Env` types
and the code reads, and that `CODE_COMMIT` appears nowhere in the parsed config (comments blanked first, so the explanatory comment does not trip it), with a positive control. Red-proofs: binding
renamed (red), binding removed (red), a stale stamp written into `vars` (red). Note for the deploy: Cloudflare adds the binding when the Worker version is uploaded; `code.version_id` is `null`
until the first deploy of this branch, which is what the poll in the new deploy script waits for.

### 6. `scripts/deploy-code-identity.ps1`, its test, and the test-count regex fix

Pattern: `scripts/deploy-refused-option-b.ps1` and its test, both read in full. Same `-ExpectedCommit` / `-DryRun` contract, ASCII only, the 5.1 trap list. **What differs, deliberately:**
it reads NOTHING from prod D1 (the option B script's C1/C2 prod checks were that wave's gate conditions) and its only wrangler call is the deploy, so `-DryRun` never calls wrangler; step 0 pins
`$LIVE_BASE_COMMIT` to `1e4ae4bf...` (main at the option B deploy, per the HANDOVER note in the brief's context), still STOPs on any move under `migrations/`, `schema.sql` or `src/doc.ts`; the
reviewed-source base is ONE constant, `$REVIEWED_COMMIT = "TO-BE-SET-BY-HUB"`, and the script STOPS while it holds that text (a second constant, `$REVIEWED_COMMIT_PLACEHOLDER`, is what it is compared with, so
setting the first leaves the guard intact), and STOPS if it is set to anything but 40 lower-case hex; HEAD may then differ from it only in `scripts/deploy-code-identity.ps1`, its test and `docs/`.
Before the deploy it STOPS if `wrangler.jsonc` lacks the `version_metadata` binding or configures a `"CODE_COMMIT"` var, and if `GET /api/attest` already serves this commit's `code.commit`
(an already-deployed wave cannot be shown propagating). The deploy is `npx wrangler deploy --var "CODE_COMMIT:$headSha"` (the full sha; `$headSha` is checked to be 40 lower-case hex first).

**The propagation poll** (`Wait-CodeIdentity`, 12 tries, 5 s apart, constants `$POLL_TRIES` / `$POLL_DELAY_SECONDS`): each try reads `GET /api/attest` WITHOUT stopping (a failed read, a non-JSON body and the old
worker's missing `code` block all just mean "not yet"), and `Test-CodeIdentityServed` requires `commit_status` `stamped`, `code.commit` equal to the pinned sha (case-sensitive), `version_status` `available` and
`code.version_id` equal to wrangler's `Current Version ID` (compared lower-cased on both sides). A deploy that never shows its own id STOPS with the rollback line (A4). After the poll the script re-runs the v5 and
chain assertions, checks the served `provenance` labels, rides the same 13 public reads and the attention/official equality as the older scripts.

**Test-count regex: a difference from the brief's example.** The brief suggested `(?m)^\W*pass (\d+)\s*$`, last match. I did not use it: PowerShell 5.1 decodes node's UTF-8 with the console code page, and under
CP437/850 the info mark (U+2139) becomes `Gamma a-umlaut box` (letters), which `\W*` refuses, so the script would STOP on a green run on Ben's own console (the harness tool here runs UTF-8, so this was reasoned
from the encodings, not seen live: the test feeds that mangled prefix in as a data file). Instead the pattern anchors on the PAIR node prints on consecutive lines, `pass N` then `fail M`, each after at most one
prefix token: `(?m)^(?:\S+[ \t]+)?pass (\d+)[ \t]*\r?\n(?:\S+[ \t]+)?fail (\d+)[ \t]*\r?$`, last pair, so a test title ("pass 5 (0.4ms)") is never a match and the `fail` count is read from the same pair (the old
`'fail (\d+)'` had the same first-anywhere defect). `Get-TestSummary` returns `$null` when there is no pair, and the gates block STOPS on a null summary, on a non-zero npm exit, on `fail` not 0 and on a failing
typecheck, each judged separately. **The same pattern replaces the old lines in `scripts/deploy-refused-option-b.ps1` (was :250) and `scripts/deploy-m3-treasury.ps1` (was :124): no test pinned the old text**
(grep over `test/` for the pattern and for `$testOut` found nothing), and a test asserts both files carry exactly the new script's pattern string and take the last pair. Six further older scripts carry the same
unanchored line (`deploy-composition-split`, `deploy-guest-voice`, `deploy-heartbeat-inbox`, `deploy-mcp-listing-ready`, `deploy-settlement-replay-guard`, `deploy-x402-settle-honesty`); the commission named two, so
those six are untouched (they are retired deploys; copying one forward as a template would carry the defect).

`test/deploy-code-identity-script.test.ts` (26): parse and ASCII; one spelling per variable, no stderr merge under Stop, `npx wrangler` called only for the deploy, no D1 or write SQL; step order and the dry run's
exit; every judged git read checks its exit code; the definitions region runs nothing; the deploy line's exact arguments (`wrangler|deploy|--var|CODE_COMMIT:<sha>`, run against a stand-in for npx); the poll against a
stand-in for `Get-Text` (ten mismatch shapes each STOP after exactly 12 reads with the rollback line; a slow propagation passes on the first matching read; wrangler failing or printing no id STOPs before any poll);
the summary on a sample containing a test titled "pass 5" (1860, and the old pattern's 5 shown), on CRLF and on mangled prefixes; the gates block run with a stand-in for `npm`; the reviewed-source block run for real
against a throwaway git repository (placeholder, malformed values, allowed paths, eight disallowed shapes including a rename out of `src/`, a HEAD that lacks the reviewed commit); the allowlist constant; the constants
pinned (v5 hash from `computeLiveConstitutionPair`, the live base a commit in history whose subject is the option B deploy script and an ancestor of HEAD); the sentinels; the header's honesty lines.

Red-proofs (28 mutants of the script and the two older scripts, each exact-once, the test file run alone, bytes restored and sha256 compared): the stamp a fixed word; `--var` forgotten; commit not compared; version id
not compared; commit compared case-insensitively; commit_status unchecked; 3 tries not 12; a mismatch that returns quietly; rollback line dropped; first read taken as proof; placeholder guard removed; placeholder
compared case-insensitively; malformed reviewed commit accepted; `src/` on the allowlist; changes since review unread; the old unanchored pattern; the brief's `\W*` prefix; the dry run exiting 3; the configured-stamp
sentinel dropped; the live base another commit; the reviewed commit "abc123"; the v5 hash wrong; a non-ASCII character; a second wrangler call (a d1 read); each older script reverted. **26 of 28 went red the first
time; two survived and were real gaps in my test, found by this step: "a failing summary no longer stops" and "no summary no longer stops" were masked because every failing fixture also set npm's exit code, and the
two clauses were redundant with each other. Fixed by splitting the script's check into a null-summary STOP and a separate exit-code/fail/pass STOP, and adding the fixtures that isolate each; the four gates mutants
(failing summary, null summary, npm exit code, typecheck) are now each red.** Suite after this step: 1921/1921, tsc 0.

## 7-8. Red-proofs and the close

Every new test was red-proofed as it was written (the mutants are listed in each step's note above): break the guarded thing exact-once, run the named test file alone, read the failing test names, write
the saved bytes back and compare sha256 before and after (restored byte-identical every time). A neighbouring guard turning red is listed but never counted as the proof. Found by this discipline and fixed
before the commit it belonged to: two deploy-script gate mutants that survived (step 6), and a meaningless assertion in the "claimAnswer is still pure" test (`claimAnswer.length >= 3`, removed; the test
now goes red when a `claimAnswer` body carries `answered_by`, shown by a mutant). Four further mutants of `claimResponse` (a 402 turned into a 400, `accepts` dropped, `code` rewritten, `answered_by`
put in `claimAnswer`'s own body) are red in `code-identity-answers-d1`, which is what T5 is for.

Final state: `npm test` 1921/1921, `npm run typecheck` 0 errors, tree clean. Base was 1860/1860; the 61 new tests are code-identity 10, code-identity-attest-d1 5, code-identity-answers-d1 14,
code-identity-deferred-flags 3, code-identity-config 3, deploy-code-identity-script 26. No existing test file was edited; the diff of `test/` is new files only. Nothing was pushed, deployed, migrated or
written to a network; no `wrangler` command and no deploy script (not even `-DryRun`) was run; no `*.local.*` file was read; `src/doc.ts`, `schema.sql` and `migrations/` are untouched.

## Served sentences written in this wave (for the seats)

- `ANSWERED_BY_NOTE` (src/code-identity.ts): the brief's text, byte for byte (a test checks it is quoted verbatim in the brief).
- `CODE_PROVENANCE.key`: "commonhold_statement: Commonhold describing itself; the claim and its source are the same party, so it is not independent corroboration, which is not a presumption that it is false.
  platform_record: an identifier the Cloudflare runtime reports for the running Worker version; a stranger cannot recompute it from public data, and it names no source."
- `CODE_PROVENANCE.commit.check`: "The operator's deploy script typed this sha when it deployed (wrangler deploy --var CODE_COMMIT:<sha>). Check it by reading the public repository at that commit
  (https://github.com/randommonicle/1f916). Nothing served here proves the running bytes were built from it. null means no valid stamp is served: commit_status says whether it was absent or malformed."
- `CODE_PROVENANCE.version_id.check`: "Cloudflare's own id for the Worker version now running, from the runtime's version-metadata binding, with the time that version was uploaded. It tells one deploy from
  another and names no source: it does not say which commit the bytes were built from."
- The statuses: commit_status `stamped` / `not_stamped` / `malformed_stamp`; version_status `available` / `unavailable` (the brief names only `unavailable`; `available` is mine).

## Open points for the hub (things the brief did not say, or that I did differently)

1. **Two answers the brief's A2 list did not name** (checkpoint section 4): a settlement answer thrown as a `SocietyError` and served by the router (`listings.ts` listing-no-longer-awaiting, `settlement_unresolved`;
   `register-gate.ts` handle-taken, `registration_handle_taken_after_payment`). The router's catch now adds `answered_by` for codes on the exported `SETTLEMENT_ANSWER_CODES`. The handle-taken code is on the list
   although it is not a `settlement_*` code, because F1's existing test requires a first answer and its replay to be the same answer. Seats: press on whether you want that, or the narrower literal rule.
2. **`platform_record`** is a new provenance label (the brief says "platform record" and "labels follow record / commonhold_statement"; `record` is defined as reproducible from public data).
3. **The test-count regex** is the pass-then-fail pair, not the brief's example (section 6 says why: a code-page-mangled prefix would make `\W*` refuse a green run on Ben's console).
4. **`/api/surface`, the OpenAPI document and llms.txt** do not mention the new `code` block (the brief's file list excludes `src/discovery.ts`): a served-text follow-up if you want it advertised.
5. **Six older deploy scripts** still carry the unanchored `'pass (\d+)'` (section 6); the commission named two.
6. **`$REVIEWED_COMMIT`** is `TO-BE-SET-BY-HUB`: the script is unusable, `-DryRun` included, until the hub sets it to the full sha the code exchange converged on. Setting it (and the commit that does) is a path the allowlist
   permits (this script).
7. **The rollback hint** names worker `a672490d` from the HANDOVER note quoted in the brief's context; nothing in the repository records it, so the test pins only that the text and the constant agree.
