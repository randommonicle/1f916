# CHECKPOINT: x402 settle honesty and PayAI discovery (wave B)

Branch `x402-settle-honesty-2026-09-28`, worktree `scratch/wt-x402-honesty`, from `origin/main` =
`04d51c17`. Design: `docs/BRIEF-X402-SETTLE-HONESTY.md` (latest amendment `7b2f89a1`), B1-B7. Money
path: the D-018 Opus gate reviews this before any deploy. No migration; non-minting (`src/doc.ts`
untouched). Built by one builder, no sub-agents, no push, no deploy, no remote `wrangler`.

Baseline in the worktree before any edit (2026-09-28): `npm test` pass 1268, fail 0; `npm run
typecheck` exit 0.

## Plan (stated before code)

**Files.**
- `src/x402.ts`: B1 `facilitator()` returns `{ status, body }`; B2 `classifySettle(status, body)`,
  pure and exported, rules 1-8 first match wins, called from `payAndSettle` through one helper that
  throws (and logs once) on every unknown outcome; B3 `classifyVerify(status, body)`, pure and
  exported; B4 optional `outputSchema` on `PaymentRequirements` / `buildPaymentRequirements`, key
  present only when given; B5 `DEFERRED-PAYAI-ALLOWANCE`; the `:196-212` comment rewritten to the new
  rules with PayAI's page cited.
- `src/listings.ts`: `settlement_unconfirmed`'s "no settlement result was read" becomes "no
  settlement verdict was returned"; the release comment ("A refused settle is an ANSWER") becomes "a
  recorded failure is an answer; a pending or unreadable one is not (x402.ts)".
- `src/register-gate.ts`: B4 passes the register declaration; B5 `DEFERRED-LANDED-PAYMENT-NO-SEAT`.
- `scripts/pay-listing.mjs`: `:616` "could not read the facilitator's answer" becomes "did not receive
  a settlement verdict from the facilitator".
- `scripts/register-maintainer.mjs`: B2b's shared helper (the warning, the three identifiers, the
  signed second leg with an injected fetch and printer); its own second leg goes through it.
- `scripts/lobby-sponsor.mjs`, `scripts/keyauth-ride.mjs`: their second legs go through the same
  helper.
- `scripts/deploy-x402-settle-honesty.ps1`: B7, written and parsed, never run.

**Tests** (each red-proofed by mutating exactly the rule it guards; restored byte-exact by a runner
that holds the original bytes and checks the sha256 after writing them back).
- `test/x402.test.ts`: `classifySettle` table (every rule, status boundaries, the hub wording, the
  200-character clip); `classifyVerify` table (every rule, the reason chain); the unknown-outcome log
  line carries `broadcast_tx` only on rule 5 with a transaction; `buildPaymentRequirements`' key set
  with and without `outputSchema`.
- `test/x402-settle-route-d1.test.ts` (new): the pay route's unknown and recorded-failure cases; the
  register route's pending and refused cases; verify 403 / 503 / invalid; the discovery 402s.
- `test/pay-listing.test.ts`: the new `leg2_unconfirmed` phrase.
- `test/register-scripts-unknown-outcome.test.ts` (new): the helper on a rejected fetch and a 502;
  a positive control; the wiring scan of all three scripts.

**No new dependencies.**

**Commit order.** 1: B1 + B2 (with the listings.ts and pay-listing.mjs phrases). 2: B3. 3: B2b. 4: B4.
5: B5. 6: B7.

## Commits

### Commit 1: B1 + B2, the /settle classification

**What.** `facilitator()` returns `{ status, body }` (the unreadable-body 502s unchanged).
`classifySettle(status, body)` is pure and exported: rules 1-8 in the brief's order, first match wins,
returning `{ kind: "settled" | "refused" | "unknown", rule, ... }` with the hub's rule-5 message
(and `broadcastTx` when `transaction` is a non-empty string) and the hub's rule-7 402 `error` (reason
clipped to 200). `settleOrThrow` wraps the /settle leg: every unknown outcome (a rejected fetch, an
unreadable body, a classified unknown) is logged ONCE as `x402_settle_outcome_unknown`, with
`broadcast_tx` only on rule 5 with a transaction, and thrown as the `SocietyError(502, ...)`, so
`handlePayListing` keeps its reservation (`settlement_unconfirmed`) and every other caller answers
502. `src/x402.ts`'s old `:196-212` comment is rewritten to the new rules, citing PayAI's page.
`src/listings.ts`: "no settlement result was read" becomes "no settlement verdict was returned"; the
release comment becomes "A recorded failure is an answer; a pending or unreadable one is not
(x402.ts)"; one sentence added to the Finding 3 comment above it, which described the unknown path
as only a rejected fetch or a non-JSON body. `scripts/pay-listing.mjs:616`: "could not read the
facilitator's answer" becomes "did not receive a settlement verdict from the facilitator".

**Key decision.** Rule 7 carries every condition PayAI documents for a definitive refusal (status
200 with a reason other than `settlement_pending`, or 400/401/403; `success: false`; a non-empty string
reason), not only the residue rules 1-6 leave. A refusal releases a listing's reservation, so it must
never depend on the rules above it staying where they are. Behaviour is identical to the brief's
first-match order.

**Coverage limit, for the gate.** Since round 1 narrowed rule 7 to four statuses, rule 8 catches
every answer rules 1, 2, 3 and 6 catch, with the same unknown outcome: deleting any one of them
changes only `rule` and the wording. So B6's example red-proof "let 409 fall through" cannot turn a
route test red on outcome. Rules 1, 2, 3 and 6 are red-proofed on the `rule` label in the unit table
(M1, M2, M3, M6). Rules 4, 5, 7 and 8 are red-proofed through the pay route on outcome (M4; M5 via
the 400/403 pending test; M7, M8, M9).

**Builder wording (not the hub's).** The unknown messages for rules 1, 2, 4 (a success on a non-2xx
status), 6 and 8. Each ends "whether the money moved is unknown until the chain is checked" (an
existing test pins that phrase). Rule 3's wording is unchanged.

**Additions beyond B6's list.** Route cases: `settlement_pending` on a 400 and a 403, in their own
test (rule 5 holds on any status; these are the answers rule 7 would release without it); 401 in the
refusal list (rule 7 names it); the patron and listing-create doors on a pending settle (F1 names
both).

**Tests.** `test/x402.test.ts` +5 (the rule table, rule 5's wording, rule 7's wording and clip,
rule 4's payer/tx, the log line through `payAndSettle`); `test/x402-settle-route-d1.test.ts` (new) +6;
`test/pay-listing.test.ts` one assertion added to the `leg2_unconfirmed` test. `npm test`: pass 1279,
fail 0. `npm run typecheck`: exit 0.

### Commit 2: B3, the /verify classification

**What.** `classifyVerify(status, body)`, pure and exported: a 2xx with `isValid: true` proceeds (rule
2); a 2xx without it keeps the old 402 with `String(invalidReason ?? "payment invalid")` (rule 3,
byte-identical expression); a 4xx is a 402 whose `error` is the hub's "refused to verify" wording
(rule 4); a 5xx is a `SocietyError(502)` with the hub's "failed to verify ... Try again later"
wording (rule 5). `reason` is the first string among `invalidReason`, `errorReason`, `error`,
`message`, clipped to 200, else "none given". Rule 1 (a body that is not a JSON object) stays
`facilitator()`'s own 502. `/settle` is never called after rules 1, 3, 4 or 5.

**Gap filled conservatively (report).** B3 names only 2xx, 4xx and 5xx. A 1xx or 3xx final status
on /verify takes rule 5's path (502, `/settle` never called): it is no reason to settle, and nothing
that could settle was sent. Pinned by the unit row `302 {"isValid":true}` -> failed.

**Reading recorded.** "The first string" is taken literally: an empty string counts, so
`{ invalidReason: "", errorReason: "x" }` names `reason: ` (empty). Wording only; nothing moves on it.

**Test design fix during red-proofing.** The first B3 pay-route test called `handlePayListing` and
read a Response, so M19 (4xx becomes a 502 throw) failed it with `ERR_TEST_FAILURE` (an escaped
`SocietyError`), not its own assertion. It now reads the route's answer through `answerOf`, which
takes the status and error from a returned Response OR a thrown `SocietyError` (the router serves
both alike); every commit-2 mutation then fails it on `ERR_ASSERTION`. All 58 failures across the
commit-1 and commit-2 red-proof logs are `AssertionError`; none is `ERR_TEST_FAILURE` or a TypeError.

**Tests.** `test/x402.test.ts` +2 (the rule table incl. a 5xx and a 4xx that say `isValid: true`; the
reason chain and clip); `test/x402-settle-route-d1.test.ts` +2 (register: 403 -> 402, 503 -> 502,
invalid 200 -> unchanged 402, none reaching /settle or writing; pay: 403 and 503 never reserve and
never settle). `npm test`: pass 1283, fail 0. `npm run typecheck`: exit 0.

### Commit 3: B2b, the three registration scripts on an unknown outcome

**What.** One shared helper in `scripts/register-maintainer.mjs` (the module `lobby-sponsor.mjs` and
`keyauth-ride.mjs` already import from): `UNKNOWN_OUTCOME_WARNING` (the hub's words verbatim),
`unknownOutcomeLines(authorization)` (from, nonce, validBefore with its ISO time, then the warning),
and `sendSignedPayment(target, body, paymentHeader, authorization, { fetchImpl, printError })`, which
sends the signed request and, on a rejected fetch OR a 502, prints the identifiers and the warning and
returns `{ outcome: "unknown" }`; any other status comes back `answered` for the script's own handling
(201 / 402 / other, unchanged). All three scripts hoist `authorization` out of the signing `try` and
send their signed leg through the helper, stopping (exit code 1) on unknown. Removed: the false "The
facilitator was never reached with this signature. It is safe to just run this script again."
(register-maintainer) and the two re-run checks that proved nothing (treasury/citizens, lobby-sponsor;
keyholder/new payment, keyauth-ride).

**Key decision.** The scripts cannot be run in a test (their CLI paths read the Ben-custody payer
wallet before the signed leg), so the helper takes its fetch and printer as parameters and is driven
directly; a wiring test then pins, per script, the one call-and-stop block, that no other request
carries the signed header, the helper's import, and the absence of the old advice. The rejected-fetch
line keeps the two scripts' existing accurate wording ("errored in transit"), not register-maintainer's
"could not be sent", which was itself a claim that nothing was sent.

**Found by the wiring test while building.** My first comment in keyauth-ride.mjs quoted the old advice
verbatim, and the test's absence check flagged it; the comment was reworded, the check kept.

**Scope kept to the brief (report).** Only a rejected fetch and a 502 print the warning. The server's
generic 500 ("Internal error", a non-SocietyError) can also hide an unknown outcome on registration (a
rejected `/settle` fetch inside `facilitator()` is a TypeError, and an `appendChained` failure after a
settle is not a SocietyError); on a 500 the scripts still print their pre-existing advice, which
points at GET /treasury. Not widened.

**Tests.** `test/register-scripts-unknown-outcome.test.ts` (new) +4: a rejected fetch and a 502 each
print the warning verbatim and the three identifiers and never "safe to"; a positive control (201 and
402 print nothing and pass the signed request through unchanged); the wiring scan. `npm test`: pass
1287, fail 0. `npm run typecheck`: exit 0.

### Commit 4: B4, the PayAI discovery declaration (register only)

**What.** `PaymentRequirements` gains optional `outputSchema?: Record<string, unknown>`;
`buildPaymentRequirements` takes an optional `outputSchema` and adds the key, last, ONLY when given.
`src/register-gate.ts` exports `REGISTER_OUTPUT_SCHEMA` (the brief's object, verbatim) and passes it;
no other caller does, so the patron, listing-create and listing-pay requirements keep exactly the
pre-wave keys in the pre-wave order (pinned by `Object.keys` and a golden `JSON.stringify`).

**Checked against the code before building.** The handle description matches `assertValidHandle`
(`/^[a-z0-9_-]{2,32}$/i`: without the `u` flag, `i` folds no non-ASCII character into `[a-z]`, so
"ASCII letters" is exact; probed with U+00E9, U+0131, U+017F and U+212A, all refused). The model
description matches `assertValidModel` (`trim().length >= 1`, `length <= 64` in UTF-16 code units;
probed with 32 and 33 astral characters). The public_key description matches `register()` (a
public-key registration's 201 carries no `secret` field). Production runs `REGISTRATION_MODE:
"open"` (wrangler.jsonc), so the declared body omitting `invite_code` is right today; it would be
incomplete if the door went back to invite-only (report).

**Additions beyond B6's list.** The declaration reaches the facilitator (the register door's
/verify request carries it in `paymentRequirements`, which is where PayAI reads it); a pin test that
the two descriptions still match the rules they restate (a rule change fails the build rather than
leaving a stale served description).

**The D-061 secret-literal guard.** The public_key description (the hub's words) contains "secret",
so `test/secret-literal-guard.test.ts` went red on it, as designed. It describes the public-key
path's 201 and is not a secret-only citizen-auth instruction, so it got a reviewed `PROSE_ALLOW`
entry (sha256 of the full decoded value, `9b8f9ece...`), and the guard's pinned baseline moved from
69 / 23 / 46 to 70 / 23 / 47 (total / wire / prose). This edit to a policing test is flagged for the
gate's review.

**Test design fixes during red-proofing.** The pin test's `ok()` helper first let a thrown
`SocietyError` escape and the register test called `validatePaymentRequirements` bare; both now fail
as assertions (`ok()` returns a boolean; `assert.doesNotThrow`). The runner's code/name extraction
was also fixed: a deep-equal diff's `...` elision had ended its block scan early, hiding the `code:`
line; after the fix every commit-4 failure shows `ERR_ASSERTION` (11 of 11), and commit 3's log shows
11 of 11 `AssertionError`.

**Tests.** `test/x402-discovery-d1.test.ts` (new) +5; `test/secret-literal-guard.test.ts` one
`PROSE_ALLOW` entry and the moved baseline. `npm test`: pass 1292, fail 0. `npm run typecheck`: 0.

### Commit 5: B5, the two deferred markers (comments, no behaviour)

**What.** `DEFERRED-LANDED-PAYMENT-NO-SEAT` in `src/register-gate.ts`, directly above the
`payAndSettle` call an unknown settle outcome propagates out of (the brief's content; plus one
clause: this wave widens which answers reach that path, not what happens after).
`DEFERRED-PAYAI-ALLOWANCE` in `src/x402.ts`, beside the `FACILITATOR_URL` note (the brief's content,
with PayAI's pricing page cited).

**Wording choice (report).** The brief's marker text says that once the allowance is spent "verify or
settle refusals are now named honestly (B2 rule 7, B3 rule 4)". Since the exhaustion answer is
undocumented (F3), the marker says so and adds that any other shape is a failure or an unknown
outcome, never a refusal. Nothing keys on a guessed reason string.

**Tests.** None (no behaviour). `npm test`: pass 1292, fail 0. `npm run typecheck`: 0.

### Commit 6: B7, the deploy script (written and parsed, never run)

**What.** `scripts/deploy-x402-settle-honesty.ps1`, modelled on `scripts/deploy-heartbeat-inbox.ps1`:
`-DryRun`; a clean tree and `main` level with `origin/main`; a check that this checkout carries the
wave (`classifySettle`, `REGISTER_OUTPUT_SCHEMA`); `npm test` and typecheck re-run; attest v5
`fa11788d` and all four chains verified before and after; worker-only `npx wrangler deploy`; a
12 x 5 s propagation poll with a shorter `--max-time`; every GET status read, never discarded. The
ride: `POST /api/register` with `{"handle":"ride-probe-<UTC yyyyMMddHHmm>","model":"ride-probe"}`
and no payment answers 402 with NO `outputSchema` before the deploy and with
`accepts[0].outputSchema.input` = type http, method POST, discoverable true after; `POST /api/patron`
with no payment answers 402 with no `outputSchema` before and after; a sweep of five untouched
surfaces. The script prints, in the dry run and the real run, that the settle and verify
classifications cannot be ridden without a real payment: the tests prove them, and the next real
payment's log line is their first ride.

**Decisions.** The unpaid POST bodies go through a temp file (`--data-binary @file`), because
PowerShell 5.1 strips embedded double quotes from native-command arguments. A 429 on the register
probe is named as the registration throttle (3 per IP per hour, 300 society-wide, counted from real
registrations only), not a defect; a 403 as an invite-only door. The dry run still makes the live
reads and the two unpaid POSTs (as the heartbeat script's dry run makes its live reads): a 402 writes
nothing, and nothing can be paid without an X-PAYMENT header.

**Checked, never run.** `[System.Management.Automation.Language.Parser]::ParseFile` reports 0
errors; the file is 13,887 bytes, 0 of them non-ASCII (5.1 reads a BOM-less script as ANSI); no
`"$var:"` drive-reference interpolation; 178 variable tokens, no name spelled two ways (the
case-collision check's positive control, `cols` / `COLS`, is detected). A first version of that
collision check used `Select-Object -CaseSensitive`, which PowerShell 5.1 does not have; it errored
per group and printed 0, a check that could not go red, and was replaced before it was relied on.

## Closing walk

- B1 `facilitator()` keeps the status: commit 1. B2 rules 1-8, the `:196-212` comment, the
  listings.ts comment and message, the pay-listing.mjs phrase and its test: commit 1. B3: commit 2.
  B2b (all three scripts, one helper): commit 3. B4: commit 4. B5: commit 5. B7: commit 6.
- Wiring: every `payAndSettle` caller inherits the classifiers; a pending settle is ridden through all
  four doors (pay, register, patron, listing create), a verify refusal and failure through register
  and pay.
- Byte-identity: the patron, listing-create and listing-pay requirements keep their pre-wave keys and
  order (unit golden string plus three route 402s).
- Non-minting: `src/doc.ts` has 0 diff lines against `origin/main`; the existing v5 pin stays green.
- Red-proofs M1-M44, each failing its own assertion (`ERR_ASSERTION`), each restored byte-exact.
- Not done here, by the hard rules: no push, no deploy, no remote `wrangler`, no network call to a
  live service. No `*.local.*` file and no `.env` was opened. The D-018 gate and the deploy are next,
  and are not this builder's.

## Red-proof table

Every run below is the runner in the session scratchpad (`redproof.mjs`): the find string must occur
exactly once; the original bytes are held in memory and written back in a `finally`; "restored" is
the sha256 comparison it printed. Every failure listed is `AssertionError` / `ERR_ASSERTION` from the
test's own assertion (never a TypeError). Counts are the runner's `# pass` / `# fail` for the files
named.

| # | Guards | Mutation (src only) | Run: pass / fail | Its own assertion that failed | Restored |
|---|--------|---------------------|------------------|-------------------------------|----------|
| M1 | rule 1 (label) | `if (status >= 500 && status <= 599)` -> `if (false)` | x402.test: 20 / 1 | rule table: `HTTP 500 {"success":false,"errorReason":"x"}: decided by rule 1`, 8 !== 1 | byte-exact |
| M2 | rule 2 (label) | `if (status === 409)` -> `if (false)` | x402.test: 20 / 1 | rule table: `HTTP 409 {... "duplicate_settlement"}: decided by rule 2`, 8 !== 2 | byte-exact |
| M3 | rule 3 (label) | `if (typeof body.success !== "boolean")` -> `if (false)` | x402.test: 20 / 1 | rule table: `HTTP 200 {}: decided by rule 3`, 6 !== 3 | byte-exact |
| M4 | rule 4's 2xx condition | `if (status >= 200 && status <= 299)` -> `if (true)` | route + x402.test: 25 / 2 | pay route: `403 success:true: 502, not a 402 that releases`, 200 !== 502 (it settled and recorded); rule table: `HTTP 300 {"success":true}: kind` settled vs unknown | byte-exact |
| M5 | rule 5 | `if (reason === SETTLEMENT_PENDING)` -> `if (false)` | route + x402.test: 20 / 7 | rule-5 pay route test: `400 settlement_pending: 502, not a 402 that releases`, 402 !== 502 (released); pay route table: `200 settlement_pending with a transaction: the message names the broadcast transaction` (false: rule 8's wording); register, patron, wording, log tests also red | byte-exact |
| M6 | rule 6 (label) | `if (typeof reason !== "string" \|\| reason.length === 0)` -> `if (false)` | x402.test: 20 / 1 | rule table: `HTTP 200 {"success":false}: decided by rule 6`, 8 !== 6 | byte-exact |
| M7 | rule 7 names only 400/401/403 | the status set -> `(status >= 400 && status <= 499)` | route: 5 / 1 | pay route table: `408 upstream_timeout: 502, not a 402 that releases`, 402 !== 502 | byte-exact |
| M8 | rule 7 refuses at all | `body.success === false &&` -> `false && body.success === false &&` | route: 4 / 2 | pay refusals: `HTTP 200 insufficient_funds: a refusal is a 402`, 502 !== 402; register refusal: 502 !== 402 | byte-exact |
| M9 | rule 8 is unknown | a refusal returned ahead of rule 8's return | route: 5 / 1 | pay route table: `408 upstream_timeout: 502, not a 402 that releases`, 402 !== 502 | byte-exact |
| M10 | listings.ts phrase | "no settlement verdict was returned" -> "no settlement result was read" | route: 4 / 2 | pay route table: `200 settlement_pending with a transaction: The settle request was sent and no settlement result was read (...` (startsWith false); rule-5 test likewise | byte-exact |
| M11 | pay-listing.mjs phrase | "did not receive a settlement verdict from the facilitator (HTTP" -> "could not read the facilitator's answer (HTTP" | pay-listing.test: 55 / 1 | `leg2_unconfirmed` test: the input did not match `/did not receive a settlement verdict from the facilitator \(HTTP 502, settlement_unconfirmed\)/` | byte-exact |
| M12 | rule 7's wording | "By its account no money moved." -> "Settlement failed." | x402.test + route: 24 / 3 | pay refusals `HTTP 200 insufficient_funds` (strictEqual on the error); register refusal; rule 7 wording test | byte-exact |
| M13 | `broadcast_tx` in the log | the `...(broadcastTx ? { broadcast_tx } : {})` line removed | x402.test: 20 / 1 | log test: `broadcast_tx` undefined !== `0xcdcd...` | byte-exact |
| M14 | unknown is thrown, never a 402 | the throw -> `return` a refused verdict (the pre-wave behaviour) | route: 2 / 4 | pay route table: `200 settlement_pending with a transaction: 502, not a 402 that releases`, 402 !== 502; rule-5 test; register: `a 502, never a 402 that invites a second payment`, 402 !== 502; patron: `patron: a 502`, 402 !== 502 | byte-exact |
| M15 | rule 5's wording | "do not sign again." -> "retry later." | x402.test + route: 24 / 3 | register pending (strictEqual on the error); rule 5 wording test; log test | byte-exact |
| M16 | rule 7's 200-character clip | `FACILITATOR_REASON_MAX = 200` -> `250` | x402.test: 20 / 1 | rule 7 test: reason `r`x250 !== `r`x200 | byte-exact |
| M17 | rule 4's payer/tx unchanged | `payer: typeof body.payer === "string" ? ...` -> `payer: "unknown"` | x402.test: 20 / 1 | rule 4 test: deepEqual, payer `'unknown'` vs `'0xpayer'` | byte-exact |
| M18 | verify: rules 2-3 read a 2xx only | the verify 2xx test -> `if (true)` (the pre-wave behaviour) | route + x402.test: 27 / 4 | register: `verify 403: error`, "payment invalid" vs the hub's refusal; pay route answer; both unit tests | byte-exact |
| M19 | verify rule 4 | the verify 4xx test -> `if (false)` | route + x402.test: 27 / 4 | register: `verify 403: status`, 502 !== 402; pay route answer (after the `answerOf` fix, ERR_ASSERTION); unit table | byte-exact |
| M20 | verify rule 5 is a 502 | rule 5's return -> a refusal | route: 6 / 2 | register: `verify 503: status`, 402 !== 502; pay route answer | byte-exact |
| M21 | no /settle after a verify refusal | `if (verdict.kind !== "valid")` -> `if (verdict.kind === "invalid")` | route: 6 / 2 | register: `verify 403: status`, 201 !== 402 (it settled and registered); pay route answer | byte-exact |
| M22 | a verify failure is thrown | the `failed` throw line removed | route: 6 / 2 | register: `verify 503: status`, 402 !== 502; pay route answer | byte-exact |
| M23 | the reason chain's order | `invalidReason` and `errorReason` swapped | x402.test: 22 / 1 | reason test: strictEqual, "second" vs "first" | byte-exact |
| M24 | "none given" | `return "none given"` -> `return ""` | x402.test: 21 / 2 | rule table: `HTTP 422 {"isValid":true}: error`; reason test | byte-exact |
| M25 | verify's 200-character clip | the reason's `.slice(0, FACILITATOR_REASON_MAX)` removed | x402.test: 22 / 1 | reason test: strictEqual, `e`x250 vs `e`x200 | byte-exact |
| M26 | verify rule 4's wording | "refused to verify this payment" -> "declined to ..." | x402.test + route: 27 / 4 | register: `verify 403: error`; pay route answer; both unit tests | byte-exact |
| M27 | verify rule 5's wording | "failed to verify this payment" -> "could not verify ..." | x402.test + route: 28 / 3 | register: `verify 503: error`; pay route answer; rule table | byte-exact |
| M28 | the warning is printed | `UNKNOWN_OUTCOME_WARNING` dropped from `unknownOutcomeLines` | B2b test: 2 / 2 | rejected fetch and 502: `the warning, verbatim` | byte-exact |
| M29 | the nonce is printed | the nonce line removed | B2b test: 2 / 2 | rejected fetch: `its nonce`; 502 likewise | byte-exact |
| M30 | the rejected-fetch path reports | the report loop removed from the `catch` | B2b test: 3 / 1 | rejected fetch: `the warning, verbatim` | byte-exact |
| M31 | a 502 is unknown | `response.status === 502` -> `=== 503` | B2b test: 3 / 1 | 502 test: strictEqual, outcome `answered` vs `unknown` | byte-exact |
| M32 | nothing calls a re-run safe | a line "It is safe to run this script again." added to the `catch` | B2b test: 3 / 1 | rejected fetch: `nothing calls a re-run safe` (doesNotMatch /safe to/i) | byte-exact |
| M33 | lobby-sponsor goes through the helper | its pre-wave second leg (own fetch, treasury/citizens advice) restored | B2b test: 3 / 1 | wiring: `lobby-sponsor.mjs: the signed leg goes through sendSignedPayment exactly once and stops on unknown` | byte-exact |
| M34 | keyauth-ride goes through the helper | its pre-wave second leg restored | B2b test: 3 / 1 | wiring: `keyauth-ride.mjs: ... exactly once and stops on unknown` | byte-exact |
| M35 | register-maintainer goes through the helper | its pre-wave second leg ("safe to just run") restored | B2b test: 3 / 1 | wiring: `register-maintainer.mjs: ... exactly once and stops on unknown` | byte-exact |
| M36 | the script stops on unknown | the `return` removed from keyauth-ride's unknown branch | B2b test: 3 / 1 | wiring: `keyauth-ride.mjs: ... exactly once and stops on unknown` | byte-exact |
| M37 | the key only when given | the guard -> an unconditional `reqs.outputSchema = opts.outputSchema` | discovery: 4 / 1 | unit: `no outputSchema key at all, not even an undefined one` (deepEqual on `Object.keys`). The served 402s stay unchanged under this mutation (JSON drops an undefined key), so only the unit test can see it | byte-exact |
| M38 | register declares | `outputSchema: REGISTER_OUTPUT_SCHEMA` removed from register-gate.ts | discovery: 3 / 2 | register route: deepEqual `accepts[0].outputSchema` (undefined vs the declaration); the /verify-body test | byte-exact |
| M39 | the declaration's content | `discoverable: true` -> `false` | discovery: 3 / 2 | register route and /verify-body: deepEqual on the declaration | byte-exact |
| M40 | only register declares | every caller gets a default declaration | discovery: 3 / 2 | unit key set; patron / listing 402s: `patron` (`"outputSchema" in reqs` true) | byte-exact |
| M41 | the operator's script accepts it | `validatePaymentRequirements` refuses an `outputSchema` key | discovery: 4 / 1 | register route: `Got unwanted exception: the operator's registration script still signs against it` (doesNotThrow) | byte-exact |
| M42 | the handle description matches its rule | `{2,32}` -> `{3,32}` in `assertValidHandle` | discovery: 4 / 1 | pin test: `2 characters` | byte-exact |
| M43 | the model description matches its rule | `model.length > 64` -> `> 63` in `assertValidModel` (anchored on its signature: `correctModel` has its own copy) | discovery: 4 / 1 | pin test: `64 characters` | byte-exact |
| M44 | the declaration reaches the facilitator | `paymentRequirements: { ...reqs, outputSchema: undefined }` in the rpc body | discovery: 4 / 1 | /verify-body test: deepEqual (undefined vs the declaration) | byte-exact |
