# Gate record: served code identity (Sonnet 5.5 text-and-shape gate), 6 Oct 2026

Scope: branch `code-identity-2026-10-06`, diff `69730d99..b60885a4`. Contract: `society/docs/BRIEF-SERVED-CODE-IDENTITY.md` (A1-A8). Build log: `docs/CHECKPOINT-SERVED-CODE-IDENTITY.md` (in the builder's worktree).
Method: read the whole src diff and the whole deploy script; ran the suite and the red-proofs in a PRIVATE detached worktree at `b60885a4` (`scratch/code-identity-gate/wt`, node_modules by junction), never in the builder's worktree. No wrangler command, no deploy script, no network write, no `*.local.*` read. Line numbers below are at `b60885a4`.

## Verdict: DEPLOYABLE WITH CONDITIONS. HIGH 0, MEDIUM 0, LOW 5.

**Classification: HOLDS. I found no path where the change alters what a claim answer DECIDES** (HTTP status, `code`, whether `accepts` is present, which branch is taken). The classification stays Sonnet text-and-shape; it does not flip to Opus.

Conditions (both are procedure, neither is a code change):
- C1. The hub sets `$REVIEWED_COMMIT` (`scripts/deploy-code-identity.ps1:43`) to the full 40-hex sha of the converged tip. Until then the script cannot run at all, `-DryRun` included (checked, Q5). Any `src/` or `wrangler.jsonc` change after that sha is refused by the allowlist (:45, :189-201), so the gate verdict applies to that sha only.
- C2. Ben runs `-DryRun` first. At the real deploy, if the poll STOPs naming `code.version_id`, compare `npx wrangler deployments list` with `GET /api/attest` by hand BEFORE rolling back (see L5: the one assumption no ride has yet tested).

## Q1. Decision invariance: yes, byte for byte, no exception

- Method: I normalised the head `src/x402.ts` (stripped `, codeIdentity(env))` and the `env, ` argument of `contradictionResponse`) and diffed it against `69730d99`. What remains is exactly: three imports; the three direct answers (:637-645, :654-662, :675-682) changing `Response.json(body, { status, headers: CORS })` into `claimErrorResponse(body, status, identity)`; and `contradictionResponse`'s signature (:986). Nothing else.
- Direct answers: the status (503, 502, 503) and the `code` values are unchanged (`SETTLEMENT_CLAIM_UNAVAILABLE` is the same string, `src/settlement-claims.ts:78`; `SETTLEMENT_UNRESOLVED` untouched). `claimErrorResponse` (:761) calls `claimResponse({ status, body }, identity)`, whose headers are the same single CORS header as before (:755-757), so A8 holds.
- Every `claimResponse` call site (`x402.ts` :765, :847, :850, :854, :861, :884, :896, :899, :904, :987 via `contradictionResponse`, :1010, :1012, :1026) changes only its second argument. Branch conditions around them are not in the diff.
- `claimResponse` (`settlement-claims.ts:755-757`): `{ ...answer.body, answered_by }`. Status, headers and every body key, `accepts` included, pass through the spread; key order is unchanged with `answered_by` last. `claimAnswer` and `contradictionAnswer` are not in the diff (pure, no env).
- Router (`src/index.ts:582-587`): `e.status` is untouched; only the body gains a field, and only for codes on `SETTLEMENT_ANSWER_CODES` (`settlement-claims.ts:769-776`). All other `SocietyError`s are served as before. `codeIdentity` cannot throw on any `env` shape (it type-checks every field; `src/code-identity.ts:39-61`).
- `listings.ts:958` (the 502 `settlement_unconfirmed`): one appended key, status 502 and CORS unchanged.
- No claim write, lease, reconciler selection, migration or `schema.sql` is touched. Between the live code (`c93150ea`) and `1e4ae4bf`, `src/` is unchanged (`git diff --stat c93150ea 1e4ae4bf -- src wrangler.jsonc migrations schema.sql` is empty), so the wave's src diff is the whole of what ships.
- Tests for it: `test/code-identity-answers-d1.test.ts:111` ("T4/T5") serves every `claimAnswer` shape through `claimResponse` and asserts status, code, accepts and every other field equal the answer's own. Red-proved by me (Q7: J4, J5, J6).

## Q2. Served sentences: all true of the code and the deploy path

- `ANSWERED_BY_NOTE` (`code-identity.ts:65`, 460 chars): byte-identical to the A7 text quoted in the brief (I compared the constant with the brief by script: `true`). It says the commit is the operator's stamp, "not proof of the running bytes", null when absent or malformed, that `version_id` is Cloudflare's id, and that "the claim row does not record which" code decided. The last is true: `settlement_claims` has no code column and the wave adds none (no migration). Nothing implies the commit is verified, that the version id names source, or that the row records code.
- `CODE_PROVENANCE` (:83-96): `commonhold_statement` wording matches `COMPOSITION_PROVENANCE.key` at `society.ts:222`. `platform_record` is a new label; I agree with the builder that reusing `record` would be false (there it means "reproducible from public data"). The commit check says "Nothing served here proves the running bytes were built from it"; the version check says it "names no source". Both true. The public repository URL is the fork named in the project guide, and the deploy script only deploys when HEAD = main = origin/main (:174-176), so the stamped commit is a pushed commit.
- Statuses `available` / `stamped` / `not_stamped` / `malformed_stamp` / `unavailable` are each served only in the case they name (`code-identity.ts:39-61`).

## Q3. Honest failure

- Absent `CODE_COMMIT` (undefined or null): `commit: null`, `commit_status: "not_stamped"`. Present and invalid (upper-case, 39 chars, trailing newline, empty string, non-string): `commit: null`, `"malformed_stamp"`. I ran `codeIdentity` directly: an upper-case 40-hex and a 40-hex plus `\n` both give `malformed_stamp` with `commit: null`; no `m` flag, no trim (`:14`).
- Missing `CF_VERSION_METADATA`, or one with no usable string id: `version_id: null`, `version_timestamp: null`, `version_status: "unavailable"`. `/api/attest` carries the status; `answered_by` carries only `version_id` (null) (L2).
- The "forgotten flag serves `not_stamped`, never a stale sha" claim (code comments, brief, script header) is true of wrangler 4.118.0, read in `node_modules/wrangler/wrangler-dist/cli.js` (a file read, no wrangler command): `keep-vars` has `default: false` and "will delete all vars before setting those found in the Wrangler configuration" (:304521); `deploy()` turns each `--var` into a `plain_text` binding (:148807) and passes `keepVars` through (:148857), so a previous deploy's `CODE_COMMIT` is not carried over.
- The malformed value is served nowhere. `grep CODE_COMMIT src` shows it read only at `code-identity.ts:40`; no `console.log` touches it; no route dumps `env`. Red-proved: J8 (serve the bad value) goes red.

## Q4. Coverage

Every body carrying a settlement code is covered. `grep -rnE "SETTLEMENT_|settlement_|REGISTRATION_HANDLE_TAKEN_AFTER_PAYMENT" src`, comments excluded:
- bodies built in `claimAnswer`/`contradictionAnswer` (`settlement-claims.ts:653-746`) are served only by `claimResponse`;
- direct answers: `x402.ts:637/654/675` (via `claimErrorResponse`), `listings.ts:949-958` (`error: "settlement_unconfirmed"`, `answered_by` last);
- thrown `SocietyError`s: `listings.ts:1090` (`SETTLEMENT_UNRESOLVED`) and `register-gate.ts:298, :458` (handle taken), served by the router at `index.ts:587`, which adds the field. `errorBody` is called only there (`index.ts:586`), and `mcp.ts:698` / `mcp-read.ts:206` serve `e.message` only, never a code, and do not reach `payAndSettle`.
- `SETTLEMENT_PENDING` / `DUPLICATE_SETTLEMENT` (`x402.ts:333, :392`) are the facilitator's reason strings inside a message, never a body `code`.
Gap outside the literal rule: L1.

## Q5. `scripts/deploy-code-identity.ps1`

- `-DryRun` deploys nothing and never calls wrangler: it exits 0 at :242-245; the only wrangler call is :251, after it. It does run `git fetch`, `npm test`, typecheck and public GETs (header says so, :6).
- Step 0 STOPs while `$REVIEWED_COMMIT` is the placeholder: :191, compared `-ceq` with a second constant (:44). It also STOPs on a non-40-hex value (:192), a HEAD lacking it (:194) and any path off the allowlist (:196-199). It also STOPs on any move under `migrations/`, `schema.sql`, `src/doc.ts` since `1e4ae4bf` (:186-188); I ran that diff myself: empty.
- The real path passes `--var "CODE_COMMIT:$headSha"` (:251). `$headSha` equals main, origin/main and the verified `-ExpectedCommit` (:174) and is checked `-cnotmatch '^[0-9a-f]{40}$'` (:178). Wrangler 4.118.0 has `--var key:value` (string, array option; `cli.js` `collectKeyValues` splits on the first colon only).
- The poll (`Wait-CodeIdentity` :143-156, `Test-CodeIdentityServed` :134-141) requires `commit_status` stamped, `commit` equal (case-sensitive), `version_status` available, and `version_id` equal to the id wrangler printed; 12 tries, 5 s; STOPs with `$ROLLBACK_LINE` otherwise (:155). It is reached only after the deploy line, and `$ROLLBACK_LINE` is defined (:258) before the call (:259).
- Test-count regex (:56): `(?m)` line starts plus `\z`, the eight-line block at the END of the output, last match taken (:76-77), plus the tests = pass + fail + cancelled + skipped + todo check (:79, :222). I ran the script's own capture (`(npm test 2>&1 | Out-String)` under `Continue`, PowerShell 5.1) on the full suite in my private copy: exactly one match, `tests 1927 = pass 1927`, the `?` prefix (the info mark under this console code page) accepted. `Current Version ID` regex (:255) is first-match and unanchored (L4).
- ASCII-only: 0 bytes above 127, no BOM. PowerShell 5.1 parser: 0 errors. No case-variant variable names. The only `-cnotmatch` uses are on scalars (:178, :192). All `2>&1` (:215, :217, :251) run under `$ErrorActionPreference = "Continue"` (:214, :250). One-element returns are wrapped in `@()`. No `"$var:"` drive references in strings.

## Q6. Non-minting

`git diff 69730d99..b60885a4 -- src/doc.ts schema.sql migrations` is empty. `wrangler.jsonc` gains only `version_metadata`; `CODE_COMMIT` is not in `vars` (test pinned, and my mutant J15 below). The v5 pin tests (`test/code-identity-attest-d1.test.ts:78`, `guest-served-text-d1`, `settlement-replay-served-text-d1`, `doc.test.ts`) are green in my full run: **1927/1927, `tsc` exit 0**, same as the builder's count.

Note: `deploy-code-identity-script.test.ts` has 30 tests at this tip; the checkpoint's "26" predates the F1/F2/F2b passes, so it is not drift.

## Q7. Red-proofs re-run by me (private copy; each mutant exact-once; test file run alone; bytes restored and sha256 compared, all `true`)

| Mutant | Test file | Before | With mutant | Red because (failing tests) |
|---|---|---|---|---|
| J1 `claimResponse` stops adding `answered_by` | answers-d1 | 16/0 | 7/9 | nine tests, incl. T4/T5 all-shapes, T4b spread order, the 409 route, the router answers |
| J2 router stops adding it to thrown settlement answers | answers-d1 | 16/0 | 14/2 | the two router tests: handle-taken first answer = replay, listing-no-longer-awaiting |
| J3 the 409 path serves `codeIdentity({})` | answers-d1 | 16/0 | 14/2 | "T4 (route): the 409 conflict ..." and the source scan |
| J4 DECISION: `claimResponse` drops `accepts` | answers-d1 | 16/0 | 15/1 | "T4/T5: every claim answer shape ..." |
| J5 DECISION: a 402 becomes a 400 | answers-d1 | 16/0 | 15/1 | "T4/T5 ..." |
| J6 DECISION: `claimResponse` rewrites `code` | answers-d1 | 16/0 | 8/8 | eight tests, incl. T4/T5 (the served `code` no longer equals the answer's own) |
| J7 pay-listing 502 loses `answered_by` | answers-d1 | 16/0 | 13/3 | F1 route test, T4 source scan, F1 real-file scan |
| J8 a malformed stamp is served as the commit | code-identity | 10/0 | 9/1 | T1 "every present-but-invalid stamp is malformed_stamp ... bad value appears nowhere" |
| J9 the pattern accepts upper-case hex | code-identity | 10/0 | 8/2 | T1 malformed and T1 pattern-is-exact |
| J10 `/api/attest` stops serving `code` | attest-d1 | 5/0 | 1/4 | the four T3 serve tests |
| J11 poll no longer compares `version_id` | deploy-script | 30/0 | 27/3 | the three T6 poll tests (both comparisons, slow propagation, the two are separate) |
| J12 `--var` forgotten on the real deploy | deploy-script | 30/0 | 28/2 | T6 "--var CODE_COMMIT:<pinned sha>" and the step-order test |
| J13 placeholder guard removed | deploy-script | 30/0 | 27/3 | the placeholder-guard test, the guard-is-pinned test, the step-order test |
| J14 poll no longer compares `commit` | deploy-script | 30/0 | 28/2 | T6 poll both-comparisons and separate-comparisons |
| J15 `code` moved INSIDE `constitution` | attest-d1 | 5/0 | 0/5 | all five T3 tests incl. non-minting |

No mutant survived. J4-J6 are the decision-invariance guard: a mutant that changes status, `accepts` or `code` is caught.

## Findings

LOW, none blocking.
- L1. Some settlement-related answers carry no `answered_by`: the 502 unknown-verdict `SocietyError`s with no `code` (`x402.ts:208, :232, :494`), the 402 refusal body (:774-777), the 500 "settled but could not record" (:812) and the 503 "could not be read back" (:1025). They are outside the brief's literal rule (it is keyed on a settlement code) and outside A2's list, so this is not a defect against the contract. The checkpoint's commit-table phrase "every settlement answer" overreaches; the outward close should say "every claim answer that carries a settlement code".
- L2. `answered_by.version_id` can be `null` with no status in that block, and the fixed A7 note explains only a null `commit`. True, but a reader of one 409 cannot tell "binding missing" from nothing. `/api/attest` carries `version_status`.
- L3. `discovery.ts:113` (and so `/api/surface`, OpenAPI, llms.txt) does not mention the new `code` block. An omission, not a false sentence; the builder flagged it.
- L4. Script nits: the header says shas are compared with `-ceq`/`-cne` (:28) but :174 compares two git-produced shas with `-ne` (harmless, both lower-case from git); the `Current Version ID` regex (:255) takes the first match, unanchored (a wrong capture fails safe, because the poll then compares against the id the server serves).
- L5. Unridden assumption: that wrangler's `Current Version ID` equals the runtime's `version_metadata.id`. Cloudflare documents both as the Worker version's id, and the failure direction is a false STOP of a healthy deploy with a rollback hint (no migration to undo), never a false pass. The first deploy is its ride (condition C2).

Builder's open points: (1) the handle-taken code on `SETTLEMENT_ANSWER_CODES` is justified by `settlement-replay-fixes-d1` F1 (a first answer and its replay must be the same answer); (2) `platform_record` accepted; (3) the pass-then-fail regex was superseded by the end-anchored block and is verified live here; (5) six retired deploy scripts keep the old unanchored pattern: not run again, no action; (6) covered by C1; (7) the `a672490d` rollback hint matches HANDOVER Addendum 86.
