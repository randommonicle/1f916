# Checkpoint log: served code identity (the running commit and Cloudflare's version id)

Branch `code-identity-2026-10-06`, base `69730d99` (`society/` main). Builder: Sonnet 5.5. Contract: `docs/BRIEF-SERVED-CODE-IDENTITY.md` (A1-A8; both exchange seats
closed, `exchange/REVIEW_code-identity-brief-2026-10-06.md`), commission `drafts/BUILDER-COMMISSION-CODE-IDENTITY-2026-10-06.md`. Nothing pushed, deployed, migrated or
written to a network; no `*.local.*` file read; `src/doc.ts`, `schema.sql` and `migrations/` are not touched. Read-only for money-path DECISIONS: this wave adds fields to
answers and one block to `/api/attest`; it changes no status, code, `accepts`, claim write, lease or reconciler selection.

Base: 1860/1860 (`npm test`), measured in the worktree before any edit.

## Commits

| # | sha | what |
|---|---|---|

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
