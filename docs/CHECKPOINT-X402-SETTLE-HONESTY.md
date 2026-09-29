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

**As built (plan drift, recorded).** The discovery 402s and the `validatePaymentRequirements` check
landed in their own file, `test/x402-discovery-d1.test.ts` (commit 4), not in the route file or the
scripts test as planned above; the policing test `test/secret-literal-guard.test.ts` also changed
(commit 4: one reviewed `PROSE_ALLOW` entry and its moved baseline).

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

### Commit 7: docs only, the review before hand-off

**Found.** The B2b positive control (a 201 and a 402 come back `answered`, print nothing, and carry
the signed request through) had no red-proof: M28-M36 all mutate the unknown paths, which it never
enters. M45 and M46 close it; M47 shows the commit-4 `PROSE_ALLOW` entry is exact-keyed (a changed
served literal fails the guard). No test or source changed in this commit.

**Readings recorded for the gate.**
- B2b's second-leg 502 is no longer only the unknown-settle answer: since B3 a verify 5xx is also a
  502, whose body says "No money moved". The helper warns on every 502 (over-cautious in the safe
  direction) and prints the server's own body first, so the operator sees which one it was.
- Settle rule 6 reads "empty" literally: a whitespace-only `errorReason` counts as non-empty, so a
  200 with `success: false` and `errorReason: " "` is a refusal (rule 7).
- The facilitator's `transaction` string is shown unclipped in the rule-5 message and the
  `broadcast_tx` log field (clipping a hash would print a wrong one); the reason strings are clipped
  to 200.

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
- Red-proofs M1-M47, each failing its own assertion (`ERR_ASSERTION`), each restored byte-exact;
  every new test has at least one (the B2b positive control from M45/M46, commit 7).
- Not done here, by the hard rules: no push, no deploy, no remote `wrangler`, no network call to a
  live service. No `*.local.*` file and no `.env` was opened. The D-018 gate and the deploy are next,
  and are not this builder's.

## Build review round 1 (exchange/REVIEW_x402-settle-honesty-build-2026-09-28.md)

Six fixes (F1-F6) from the coordinator; the hub verified F1 and F2 at source. Same rules; red-proof
rows M48 onward.

### Commit R1: F1, a facilitator request that fails in transit (server side)

**What.** `facilitator()` catches a rejected fetch on both paths. `/settle`: `SocietyError(502, "The
request to the facilitator's /settle failed in transit (<reason>); it may have been received and
settled. Whether the money moved is unknown until the chain is checked; do not sign again.")`, which
`settleOrThrow` logs as `x402_settle_outcome_unknown` and `handlePayListing` answers with
`settlement_unconfirmed`, keeping its reservation. `/verify`: `SocietyError(502, "The payment
facilitator could not be reached to verify this payment (<reason>). No money moved: nothing that could
settle was sent. Try again later.")`. Both are the hub's words; `<reason>` is the runtime's message,
clipped to 200. Before this, the rejection escaped as the runtime's own error and the router served its
generic 500 on register, patron and listing create (CODEX HIGH; my own report's point (e)).

**Tests.** Route: register, patron and listing create answer 502 with the in-transit message and write
nothing (citizens, ledger, reg_log, listings); listing pay answers `settlement_unconfirmed`, keeps its
reservation and pinned pair, and a retry never reaches `/settle`; a `/verify` in transit answers 502 on
register and pay, never reaches `/settle`, writes and reserves nothing. Unit: through `payAndSettle`,
one log line with the in-transit reason; none for `/verify`. `answerOf` now maps a non-`SocietyError`
to the router's own generic 500 (`src/index.ts:519-521`), so a mutation that lets the runtime's error
escape fails the test's assertion rather than the test. `npm test`: pass 1296, fail 0. Typecheck 0.

**Unchanged wording, noted.** The pay route's own 502 still opens "The settle request was sent and no
settlement verdict was returned (...)". For a request that failed in transit, "was sent" is stronger
than the inner reason ("may have been received"). That sentence is the brief's B2 wording and predates
this fix for the rejected-fetch case, so it is left for the hub.

### Commit R2: F1 (scripts) and F2, the shared helper's unknown outcomes

**What.** `sendSignedPayment` now answers `answered` ONLY for a 201 (the registration) or a 4xx (a
refusal: the server runs its checks again before it settles, and a 402 is the facilitator's own
refusal). Everything else prints the three identifiers and the warning and returns `unknown`: a
rejected fetch (as before); a body that cannot be read, since the headers can arrive and the body fail
(F2, CODEX); every 5xx, not only a 502, since a write that fails after a settlement is a 500 with no
treasury row (F1); and, my extension, any other status (a 200, a 202, a 3xx is no answer this door
gives). A new shared `refusedLine(status)` replaces each script's own non-201 text, the only failure
branch left in the scripts. Removed: register-maintainer's "check GET /treasury and GET /api/official",
lobby-sponsor's `:325` "check GET /treasury and GET /api/citizens before re-running", keyauth-ride's
"check GET /treasury and GET /api/official first".

**Choice (report).** A 4xx whose body cannot be read is `unknown`, not a refusal. The F2 rule ("a
body-read failure on the signed leg is an unknown outcome too") is applied before the F1 rule (a 4xx
stays a refusal). That errs cautious: at worst the operator waits for validBefore before signing again.

**Tests.** `test/register-scripts-unknown-outcome.test.ts` +4: every 5xx (500 carrying "Your $1 payment
settled (tx ...)", 500 generic, 503, 504) is unknown with the warning and the server's words; a body
whose stream errors (on a 502 and on a 201) is unknown, never a throw (`send()` turns a throw into a
failing assertion); a 200, 202 or 302 is unknown; a 400, 403, 409 or 429 is `answered` with nothing
printed, and `refusedLine` is pinned verbatim. The wiring test now also pins each script's one non-201
branch to `refusedLine`, the import, and no `console.error` line naming `GET /treasury`, `GET
/api/citizens` or `GET /api/official`. `npm test`: pass 1300, fail 0. Typecheck 0.

### Commit R3: F3 and F4, a blank reason is no reason

**What.** Settle rule 6 now catches an `errorReason` that is absent, not a string, or blank after
trimming; rule 7 requires a reason that is not blank. So `200 {"success":false,"errorReason":" "}` is
unknown and the pay route keeps its reservation; before this it was a refusal that released it (both
seats; my own point (b)). `verifyReason` returns the first NON-BLANK string among `invalidReason`,
`errorReason`, `error`, `message`, else "none given", so an empty or blank key no longer masks a real
reason in a later key or prints "reason: " (GEMINI; point (c)). Both supersede the literal readings I
recorded in commit 7. The verify rule-3 expression (`String(invalidReason ?? "payment invalid")`) is
unchanged, as the brief requires.

**Coverage, stated.** Rule 7's own non-blank condition is defence in depth: with rule 6 intact, a blank
reason never reaches it. M64 is the evidence (that mutation alone leaves 37 of 37 green) and is not a
red-proof. The route test goes red only when both rules are reverted to the pre-review code (M63).

**Tests.** `test/x402.test.ts`: three blank-reason rows in the settle table (`" "` at 200 and 403, a
tab-and-newline reason at 401), each decided by rule 6, and a new F4 test (an empty `invalidReason`
before a real `errorReason`, blank before `error`, blank before `message`, blank throughout).
`test/x402-settle-route-d1.test.ts`: `" "` at 200 and at 403 keeps the reservation. `npm test`: pass
1302, fail 0. Typecheck 0.

### Commit R4: F5 and F6, the unknown-rule messages state only what the answer said

**What.** A `givenReason(errorReason)` quotes the answer's reason exactly as given: `errorReason: X`
(clipped to 200), `no errorReason`, `a blank errorReason`, or `an errorReason that is not a string:
<value>`. Every builder-worded unknown message now states the status and that quote, then why the
outcome is unknown, and nothing else:
- rule 1: "The facilitator answered /settle with HTTP 503 (errorReason: x). A 5xx answer is not a
  settlement verdict." (was "a server error");
- rule 2: "... HTTP 409 (errorReason: X)." or "(no errorReason)". It no longer calls every 409
  `duplicate_settlement` (CODEX; point (a)). PayAI's documented meaning stays in a code comment;
- rule 4: "... HTTP 403 and success: true (no errorReason). A success on a status other than 2xx is not
  a settlement verdict." (was "contradicts itself");
- rule 6: "... HTTP 200 and success: false (a blank errorReason). A failure without a usable reason
  cannot be classified.";
- rule 8: "... HTTP 408 and success: false (errorReason: upstream_timeout). PayAI does not document that
  combination as a definitive refusal."
Each still ends with the tail "The settle request was sent; whether the money moved is unknown until
the chain is checked." Rule 3 (L-089) and rule 5 (the hub's) are unchanged. An intermediary's `error`
field is not quoted as the facilitator's `errorReason` (a 503 `{error: ...}` reads "(no errorReason)").

**Tests.** `test/x402.test.ts` +1 (F6, GEMINI): 14 rows across rules 1, 2, 4, 6 and 8, each message
asserted exactly, covering all four reason forms, the clip, a 409 with no reason and one with another
reason, and a 503 carrying only `error`. `npm test`: pass 1303, fail 0. Typecheck 0.

### Review round 1: closing walk

- F1 server (R1 `16c71a46`), F1 scripts and F2 (R2 `87ca8765`), F3 and F4 (R3 `e2ce87ef`), F5 and F6
  (R4, this commit). Red-proofs M48-M75: every new assertion failed on its own message
  (`ERR_ASSERTION`) and every file was restored byte-exact; M64 is an evidence run, not a red-proof.
- `src/doc.ts` still has 0 diff lines against `origin/main` (non-minting).
- No push, no deploy, no remote `wrangler`, no live-service call; no `*.local.*` or `.env` opened; git
  run only against this worktree in this round.

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
| M45 | only an unknown outcome prints | `response.status === 502` -> `!== 999` (every outcome reports) | B2b test: 3 / 1 | positive control: `HTTP 201`, outcome `unknown` vs `answered` | byte-exact |
| M46 | the helper sends the signed header | `"X-PAYMENT": paymentHeader` dropped from the helper's fetch | B2b test: 2 / 2 | positive control: `X-PAYMENT` undefined vs `SIGNED-HEADER`; wiring: `register-maintainer.mjs: no X-PAYMENT request outside the helper` | byte-exact |
| M47 | the new PROSE_ALLOW entry is exact | a full stop added to the public_key description | secret-literal-guard: 5 / 1 | `Unreviewed secret-bearing literal(s) in src/` (the changed literal is an offender) | byte-exact |
| M48 | a rejected fetch is caught (F1) | `throw e;` ahead of the new catch body (the rejection escapes, as before) | route + x402.test: 31 / 4 | register: `register: the in-transit 502` (the router's generic 500); pay: `the message carries the facilitator-side reason`; verify: `register: the verify in-transit 502`; unit: `a SocietyError 502, never the runtime's own error` | byte-exact |
| M49 | the /settle in-transit wording (F1) | "it may have been received and settled." -> "it was not received." | route + x402.test: 32 / 3 | register, pay and unit: strictEqual / includes on the hub's message | byte-exact |
| M50 | a /settle in transit never says "no money moved" (F1) | the catch's `path === "/settle"` -> `!==` (the two messages swapped) | route + x402.test: 31 / 4 | register: `register: the in-transit 502` (it served "could not be reached ... No money moved"); verify and unit likewise | byte-exact |
| M51 | the in-transit outcome is logged (F1) | the log event renamed | x402.test: 21 / 3 | F1 unit: `exactly one unknown-outcome line`, 0 !== 1 (the L1 and B2 log tests also red) | byte-exact |
| M52 | the /verify in-transit wording (F1) | "could not be reached to verify this payment" -> "was unreachable" | route + x402.test: 33 / 2 | register: `register: the verify in-transit 502`; unit strictEqual | byte-exact |
| M53 | every 5xx is unknown (F1) | the helper's gate -> `response.status === 502` (the pre-review helper) | B2b test: 6 / 2 | 5xx test: `HTTP 500: unknown` (answered); other-status test likewise | byte-exact |
| M54 | an unreadable body is unknown (F2) | the body-read catch re-throws | B2b test: 7 / 1 | `HTTP 502 with an unreadable body: unknown, never a throw` | byte-exact |
| M55 | a 4xx stays a refusal (F1) | the gate -> `response.status !== 201` (a 4xx becomes unknown) | B2b test: 6 / 2 | positive control `HTTP 402`; 4xx test | byte-exact |
| M56 | the 5xx path prints the report (F1) | its `unknown(...)` -> a bare `{ outcome: "unknown" }` | B2b test: 5 / 3 | `second-leg 502: the warning, verbatim`; 5xx and other-status tests | byte-exact |
| M57 | the unreadable path prints the report (F2) | its `unknown(...)` -> a bare `{ outcome: "unknown" }` | B2b test: 7 / 1 | `HTTP 502, unreadable body: the warning, verbatim` | byte-exact |
| M58 | no error print points at a record (F1) | lobby-sponsor's refusal branch gets "Check GET /treasury and GET /api/citizens before re-running." | B2b test: 7 / 1 | wiring: `lobby-sponsor.mjs: an error print points at a record as proof` | byte-exact |
| M59 | each script prints the shared refusal line | keyauth-ride's branch goes back to its own wording | B2b test: 7 / 1 | wiring: `keyauth-ride.mjs: the one non-201 branch left prints the shared refusal line`, 0 !== 1 | byte-exact |
| M60 | only a 201 is a success answer | the gate lets every 2xx through | B2b test: 7 / 1 | `HTTP 200: unknown` (answered) | byte-exact |
| M61 | the refusal line's wording | "so by their account no money moved." -> "so nothing happened." | B2b test: 7 / 1 | 4xx test: strictEqual on `refusedLine(409)` | byte-exact |
| M62 | rule 6 catches a blank reason (F3) | rule 6's `reason.trim().length === 0` -> `reason.length === 0` | x402.test + route: 36 / 1 | settle table: `HTTP 200 {"success":false,"errorReason":" "}: decided by rule 6`, 8 !== 6 (label only: rule 7 still refuses nothing blank) | byte-exact |
| M63 | a blank reason never releases (F3) | rules 6 and 7 both reverted to the pre-review conditions (two edits) | route + x402.test: 35 / 2 | F3 route test: `200 with errorReason " ": 502, not a 402 that releases`, 402 !== 502; settle table kind | byte-exact |
| M64 | EVIDENCE, not a red-proof | rule 7's non-blank condition alone reverted, rule 6 intact | x402.test + route: 37 / 0 | none, as expected: rule 7's own check is defence in depth | byte-exact |
| M65 | verifyReason skips an empty string (F4) | its non-blank check removed (the first string again) | x402.test: 24 / 1 | F4 test: `an empty invalidReason does not mask errorReason` | byte-exact |
| M66 | verifyReason skips a blank string (F4) | `v.trim().length > 0` -> `v.length > 0` | x402.test: 24 / 1 | F4 test: `a blank invalidReason does not mask error` | byte-exact |
| M67 | rule 2 claims no reason the answer did not give (F5) | rule 2's message -> the pre-review "duplicate_settlement: ... in flight or has a replay marker" | x402.test: 25 / 1 | F6: `HTTP 409 {"success":false,"errorReason":"duplicate_settlement"}: the message, exactly` | byte-exact |
| M68 | an absent reason is quoted as absent (F5) | `givenReason(undefined)` -> "errorReason: duplicate_settlement" | x402.test: 25 / 1 | F6: `HTTP 502 {}: the message, exactly` | byte-exact |
| M69 | rule 1 claims nothing more (F5) | "A 5xx answer is not a settlement verdict." -> "The facilitator is down." | x402.test: 25 / 1 | F6: `HTTP 500 {... "x"}: the message, exactly` | byte-exact |
| M70 | rule 4 claims nothing more (F5) | its reason sentence -> "A success on a non-2xx status contradicts itself." | x402.test: 25 / 1 | F6: `HTTP 403 {"success":true}: the message, exactly` | byte-exact |
| M71 | rule 6 quotes the reason as given (F5) | the `(${givenReason(reason)})` clause dropped | x402.test: 25 / 1 | F6: `HTTP 200 {"success":false}: the message, exactly` | byte-exact |
| M72 | rule 8 quotes the reason as given (F5) | the `(${givenReason(reason)})` clause dropped | x402.test: 25 / 1 | F6: `HTTP 408 {... "upstream_timeout"}: the message, exactly` | byte-exact |
| M73 | a blank reason is quoted as blank (F5) | blank -> "no errorReason" | x402.test: 25 / 1 | F6: `HTTP 200 {... " "}: the message, exactly` | byte-exact |
| M74 | a non-string reason is quoted as one (F5) | not-a-string -> "no errorReason" | x402.test: 25 / 1 | F6: `HTTP 400 {... 42}: the message, exactly` | byte-exact |
| M75 | the quoted reason is clipped to 200 (F5) | `clipReason(v)` -> `v` | x402.test: 25 / 1 | F6: `HTTP 429 {... "rrrr..."}: the message, exactly` | byte-exact |

## Note: hub fix before build review round 2 (2026-09-28 evening session)

The builder's open point: the pay route's `settlement_unconfirmed` message opened "The settle request was sent and ..." even when the request failed in transit (F1's case), where it may never have left. Hub wording, applied by the hub: the route now opens "No settlement verdict was returned for the settle request (${reason})." (`src/listings.ts`), and `scripts/pay-listing.mjs`'s `leg2_unconfirmed` message opens "The server did not receive a settlement verdict from the facilitator (HTTP ...)". The other "was sent" sentences in `src/x402.ts` stay: each is served only after an answer arrived, so the request was delivered.

| # | guards | mutation | tests (pass / fail) | failing assertion | restore |
|---|---|---|---|---|---|
| M76 | the route claims no delivery | the pre-fix sentence (the tests changed first, run against the old source) | route + pay-listing: red on the in-transit case and every unknown case | `a /settle that fails in transit: The settle request was sent and ...` (startsWith) | the new source; 68 / 0 |
| M77 | the script claims no delivery | the pre-fix script sentence (same run) | pay-listing: red | `startsWith("The server did not receive a settlement verdict")` | the new source; 68 / 0 |

The brief is amended in its three stale places (rule 6 "empty" becomes "blank after trimming", rule 7 "non-empty" becomes "non-blank"; B2's closing sentence now records this fix; B2b's "a second-leg 502" becomes every 5xx, every non-201 non-4xx status and an unreadable body, a 4xx staying a refusal), each marked "amended after build review round 1".

## F7 (build review round 2, CODEX HIGH): a payment that settled but could not be booked

**Status: built and red-proofed, and BLOCKED: not committed.** Two source scans in `test/listings-policing.test.ts`, a file outside this unit's fence, pin the old call spelling and now fail (see "Blocked" below); nothing else is red. Baseline 1303 tests, all pass, `tsc` exit 0. Now 1311 tests (8 new), 1309 pass, 2 fail, `tsc` exit 0.

### The finding and the fix

After `payAndSettle` returns `ok` the money has moved. Registration (`src/register-gate.ts`), the patron door (`src/x402.ts`) and listing create (`src/listings.ts`, step 4) each then appended the treasury ledger line with `appendChained(env.DB, "ledger", ...)` outside any catch. A throw there reached the payer as `chain head for ledger moved four times running; ... The write was never committed -- retrying may succeed.` (`src/chain.ts`, a 503 after four UNIQUE conflicts) or as the router's generic 500 (`src/index.ts`). Either way a retry needs a fresh signature, which is a second payment, and nothing logged named the settled transaction.

`recordSettledPayment(env, route, settled, amountCents, row)` in `src/x402.ts` (exported; `route` is `"registration" | "patron" | "listing_fee"`) calls `appendChained(env.DB, "ledger", row)` and returns its result. On any throw it logs one line, `{"level":"error","event":"payment_settled_unrecorded","route","payer","tx","amount_cents","reason"}`, where `reason` is the inner error's message clipped to 200 characters by the file's own `clipReason`, and throws `SocietyError(500, ...)` with the hub's words: "Your $D payment settled (tx T), but the society could not record it in its treasury ledger. Do not sign again: this payment has already moved. This is logged for the maintainer to put right by hand: GET /api/official names how to reach it." (`D` is `(amountCents / 100).toFixed(2)`.) The inner error's text never reaches the caller. All three routes use it, so registration stops before the citizen is created and listing create before the listing insert; each route's own later paid-but-failed handling is unchanged. In that state a registrant holds a landed payment and no seat, the same state `DEFERRED-LANDED-PAYMENT-NO-SEAT` in `src/register-gate.ts` names for an unknown settle answer (its comment now says so).

### Tests

`test/x402-post-settle-record-d1.test.ts`, 8 tests on the real `schema.sql` in the local D1 with the facilitator stubbed to verify and settle: for each of the three routes, every `INSERT INTO ledger` fails through a SQLite trigger, in two flavours, (a) `RAISE(ABORT, 'UNIQUE constraint failed: ledger.hash')` (appendChained retries four times, then throws its 503) and (b) `RAISE(ABORT, 'disk I/O error')` (rethrown at once); a control with no trigger (each door succeeds, books one line of the amount signed and returns that line's hash as its receipt, and logs nothing); and a unit test of the helper (reason clipped to 200, a thrown non-Error logged as a string, five cents served as `$0.05`). Each failure test asserts, answer first: status 500 and the message equal to the hub's words with the settled tx and the amount signed (registration and patron `$1.00`, listing create `$1.50`, the fee on a $10 bounty); neither `retrying may succeed` nor `never committed`; one verify and one settle; exactly one `payment_settled_unrecorded` line with exactly the fields level, event, route, payer, tx, amount_cents, reason; no `_paid_but_failed` line; and no ledger line, citizen, reg_log row or listing written. A probe confirmed node:sqlite surfaces a trigger's `RAISE` text verbatim as `Error.message`, so (a) reaches appendChained's `String(e).includes("UNIQUE")` retry and (b) does not.

### Red-proofs (M78 onward)

Runner: `f7-redproof.mjs` in the session scratchpad (the find string must occur exactly once; original bytes held in memory and written back in a `finally`; the sha256 of the restored file compared). Only the F7 test file is run. Every failure below is `AssertionError [ERR_ASSERTION]`, and the failing assertion is the one named.

| # | guards | mutation | tests (pass / fail) | failing assertion | restore |
|---|---|---|---|---|---|
| M78 | registration books through the helper | `src/register-gate.ts`: the call put back to the bare `await appendChained(env.DB, "ledger", {` | F7 file: 6 / 2 | `registration (a) ...: the honest 500` (deepEqual; actual `{status: 503, error: "chain head for ledger moved four times running; ... retrying may succeed."}`) and `registration (b) ...: the honest 500` (actual `{status: 500, error: "Internal error. The society apologizes."}`) | byte-exact |
| M79 | patron books through the helper | `src/x402.ts`: the patron call put back to the bare `appendChained` | 6 / 2 | `patron (a) ...: the honest 500` and `patron (b) ...: the honest 500`, the same two actuals | byte-exact |
| M80 | listing create books through the helper | `src/listings.ts`: the call put back to the bare `appendChained`, with its import restored (two edits) | 6 / 2 | `listing_fee (a) ...: the honest 500` and `listing_fee (b) ...: the honest 500`, the same two actuals | byte-exact |
| M81 | one log line names the settled payment | the helper's `console.log(` -> `[].push(` (the line is built and swallowed) | 1 / 7 | `<route>: exactly one payment_settled_unrecorded line` (0 !== 1) on all six route tests; the unit test's `records.length` (0 !== 1) | byte-exact |
| M82 | the logged reason is clipped to 200 | the `clipReason(...)` dropped | 7 / 1 | unit: `clipped to 200 characters` (300 !== 200) | byte-exact |
| M83 | the caller never reads the inner error's text | the served message gets the inner message appended | 1 / 7 | `<route> ...: the honest 500` on all six route tests (deepEqual on the message); the unit test's message strictEqual | byte-exact |
| M84 | the amount served is the amount signed | the listing call site passes `100` instead of `feeCents` | 6 / 2 | `listing_fee (a) ...: the honest 500` and `(b)` (`$1.00` served, `$1.50` expected) | byte-exact |
| M85 | the helper returns appendChained's result | it returns an empty hash instead | 7 / 1 | control: `registration: the receipt is the hash of the line just written` (`''` vs the head hash) | byte-exact |

- M81's first attempt used `void (` with a trailing comma, a SyntaxError, so it is a setup error and not a red-proof; it was rerun as `[].push(`. The runner now flags any run that is not exactly 8 tests or that shows a SyntaxError or ReferenceError.
- The assertions that no ledger line, citizen, reg_log row or listing was written hold before the fix too (the trigger blocks the row, and both pre-fix throws happen before the citizen is created and before the listing insert), so they are harness checks, not red-proof evidence. The answer assertion comes first in each test for that reason.
- The two flavours are shown to take different appendChained paths by the logged reason: (a) starts `chain head for ledger moved four times running`, (b) is exactly `disk I/O error`.

### Blocked: two policing scans pin the old call spelling

`test/listings-policing.test.ts` scans `src/listings.ts` (comments stripped) for `/appendChained\s*\(\s*env\.DB\s*,\s*["']ledger["']/`. The fix moves that call into `src/x402.ts` by design, so the pattern finds none and two tests fail:

1. `positive control: handleCreateListing DOES book the posting fee to the chained ledger (the scan above is not vacuous)`
2. `exactly one appendChained(..., "ledger", ...) call exists in the whole file -- the posting fee, and nothing else, is ever booked as treasury income` (expected 1, found 0)

The invariant they police still holds: `listings.ts` has exactly one ledger booking, `recordSettledPayment(env, "listing_fee", result, feeCents, {`, whose row books `amount_cents: feeCents`. That file is outside this unit's fence, and the brief's rule for a guard going red is to stop and report, so it is untouched and nothing is committed.

Proposed amendment, needing the fence widened. It was verified in a scratchpad mirror only (a copy of `src/listings.ts` beside a patched copy of the test; the worktree's guard was never edited). After `const SRC`, define `const LEDGER_BOOKING = /(?:appendChained\s*\(\s*env\.DB\s*,\s*["']ledger["']|recordSettledPayment\s*\(\s*env\s*,\s*["']listing_fee["'])/;`. Use it in the positive control's first `assert.match`, and as `SRC.match(new RegExp(LEDGER_BOOKING.source, "g"))` in the count test. In the `handlePayListing` test "never references the chained 'ledger' table or calls appendChained", add `assert.ok(!/\brecordSettledPayment\b/.test(body), ...)`: the bounty is not treasury money, and without it a `recordSettledPayment` call in that function would pass every other scan. Mirror results: amended guard against the new source, 7 / 0; the fee no longer booked, 5 / 2 (the positive control, and the count with found 0); `handlePayListing` booking through the helper, 5 / 2 (the new assertion, and a count of 2); a second bare ledger booking in `handleCreateListing`, 6 / 1 (a count of 2).

Near miss, fixed in scope: `test/register-gate.test.ts`'s scan for `register(` outside `register-gate.ts` reads raw text, comments included, and flagged my first comment in `src/x402.ts` that mentioned it. The comment was reworded.

### Script reading (no change)

`scripts/register-maintainer.mjs` `sendSignedPayment`, shared by `lobby-sponsor.mjs` and `keyauth-ride.mjs`: only a 201 or a 4xx is an answer. Every other status, so every 5xx including this 500, prints the server's body, the signed authorisation's from, nonce and validBefore and `UNKNOWN_OUTCOME_WARNING` ("Do not sign again until the original authorisation's outcome has been reconciled on-chain"), returns `outcome: "unknown"` and exits 1 (`test/register-scripts-unknown-outcome.test.ts`, F1). `scripts/post-listing.mjs` treats any non-201 on the signed leg as `leg2_not_201`, prints `recoveryMessage` ("DO NOT re-run ... Only if you confirm NOTHING settled may you delete this file") and leaves the tombstone `signing` (`test/post-listing.test.ts`, "a non-201 leaves the tombstone 'signing'"). Neither tells a paid caller to sign again, so neither changes. One observation: `recoveryMessage` lists `GET /treasury` first among its checks, and after this fix a settled but unbooked payment has no treasury line. The message also sends the reader to the wallet balance and the Base transactions and allows deleting the tombstone only if NOTHING settled, so it stays safe.

### F7 limits, recorded and not changed (the hub's words are verbatim)

- The served sentence says the society "could not record" the payment. A database error returned after a write had in fact committed would make that untrue for that one row. The log line carries the tx and the inner reason, so the maintainer checks `GET /treasury` before booking by hand.
- A facilitator success body with no `transaction` string yields `tx: ""` (`classifySettle` rule 4), so the served sentence reads `(tx )`, the log's `tx` is empty, and the ledger description would end `tx ` as well. This is the same for every paid-but-failed message already in `register-gate.ts` and `listings.ts`.

### F7 closing walk

- Touched: `src/x402.ts`, `src/register-gate.ts`, `src/listings.ts` (its `appendChained` import, now unused, is removed), `test/x402-post-settle-record-d1.test.ts`, this file. `src/doc.ts` has 0 diff lines against `origin/main`; `migrations/`, `wrangler.jsonc` and `test/secret-literal-guard.test.ts` are untouched, and the D-061 guard is green.
- Not committed, because of the block above. No push, no deploy, no remote call; no `*.local.*` or `.env` opened; git run only against this worktree.

## F8/F9 (build review round 3, CODEX)

Baseline before this section: 1346 tests, all pass, `tsc` exit 0 (head `f5dd2e98`, rebased onto main `71812d05`).

### F8a (HIGH): registration's paid-but-failed 500 never carries inner error text

The `catch (e)` around `register(...)` in `src/register-gate.ts` served the inner SocietyError's message verbatim (`: ${detail}`). When `register()`'s `key_registered` append exhausts `appendChained` AFTER the citizen row exists, a caller whose money moved read "retrying may succeed" (a second payment), and a UNIQUE text inside would have been mapped by `register()` to "handle ... is taken", while a citizen holding their key already existed.

The `registration_paid_but_failed` log line is unchanged (the inner reason belongs there). The thrown message is now one of two hub-worded messages, chosen by `publicKey !== null`, status still 500, with `$` + `(REGISTRATION_PRICE_CENTS / 100).toFixed(2)` (so `$1.00`, where it read `$1`) and `String(b.handle)`:

- public key supplied: says the payment settled (tx), registration did not complete, do not sign again, the payment is in the books (GET /treasury); a citizen may still have been created and GET /api/citizens lists each handle with the public key on record; if the handle is listed there with the supplied key the seat is the caller's and the key already works, otherwise no seat was created; logged for the maintainer.
- no public key: the same first sentence, then "No credential was delivered to you, so no seat is usable by you.", then the maintainer sentence.

Paging clause. `/api/citizens` IS paged: `citizenDirectory` (`src/society.ts`) serves `page_size` 1000, `has_more`, and, while `has_more`, `next_since` and `next_since_id`, and `src/index.ts` reads the query parameters `since` and `since_id`. The clause added after "on record" is exactly: `The list is paged: while has_more is true, fetch GET /api/citizens?since=<next_since>&since_id=<next_since_id> and keep going.` It is in the public-key message only (the no-key message sends the caller nowhere).

State the message describes and the tests document: after F8a(i) the money is booked, the citizen row exists with the supplied key, and the identity chain has no `key_registered` row for it. Putting that right is the maintainer's, from the log line.

### F8b (HIGH, invite mode only, not reachable on the live open-mode door): the credential is never withheld

The `invite_redeemed` append after `register()` ran outside any catch: a throw gave the caller a raw 503/500 after payment, ledger and citizen creation, and they never received the credential `register()` returned. It is now inside try/catch; on any throw one line `{"level":"error","event":"invite_redeemed_unrecorded","payer","tx","citizen_id","invite_hash","reason"}` is logged (`invite_hash` is the `inviteCodeHash` value, never the code; `reason` clipped to 200 with `clipReason`, now exported from `src/x402.ts`) and the normal 201 is served. Hub design choice, recorded for Ben: the cost is that the code is not marked spent, so one more paid registration could redeem it, the same blast radius `assertInviteNotRedeemed` already accepts for the concurrent race.

### F8 tests

`test/x402-post-payment-honesty-d1.test.ts` (F7's harness: facilitator stub, local D1 on the real `schema.sql`, SQLite `RAISE` triggers, log capture): F8a(i) x2 (public-key registration; trigger on `identity_events` `WHEN NEW.kind = 'key_registered'`; (a) `UNIQUE constraint failed: identity_events.hash`, (b) `disk I/O error`), F8a(ii) (secret registration; trigger on `citizens`), an F8b control (no trigger: 201, one `invite_redeemed` row holding the code's hash, no unrecorded line) and F8b x2 (trigger `WHEN NEW.kind = 'invite_redeemed'`, the same two variants). The message assertions are deepEqual against the hub words typed in the test, plus a no-inner-text scan for `retrying may succeed`, `never committed`, `UNIQUE`, `disk I/O`, `is taken`, `chain head`. F8b asserts 201, that the served secret's sha256 is the citizen row's `secret_hash`, no `invite_redeemed` row, exactly one unrecorded line with payer, tx, citizen_id and the code's hash, and that the code's plaintext appears nowhere in the captured log.

### Red-proofs, F8 (M86 onward)

Method: original file copied aside, one mutation applied (the find string must occur exactly once), only the new test file run, the file restored from the copy and compared with `cmp`. Every failure is `AssertionError [ERR_ASSERTION]`.

| # | guards | mutation | tests (pass / fail) | failing assertion | restore |
|---|---|---|---|---|---|
| M86 | the caller never reads the inner error's text | `src/register-gate.ts`: the served message put back to the pre-fix `...registration then failed: ${detail}. ...` | 3 / 3 | `the public-key hub words, verbatim` on F8a(i) (a) and (b) (actual begins `Your $1 payment settled (tx 0xabab...) but registration then failed: chain head for identity_events moved four times running; ... retrying may succeed..`) and `the no-key hub words, verbatim` on F8a(ii) | byte-exact |
| M87 | each hub-word variant goes to its own case | the condition swapped, `publicKey !== null` to `publicKey === null` | 3 / 3 | `the public-key hub words, verbatim` on both F8a(i) tests and `the no-key hub words, verbatim` on F8a(ii) | byte-exact |
| M88 | the public-key message names how to page the census | the paging clause deleted | 4 / 2 | `the public-key hub words, verbatim` on both F8a(i) tests | byte-exact |
| M89 | the credential is never withheld | the try/catch around the `invite_redeemed` append removed (`if (true) { ... } else {`) | 4 / 2 | F8b (a): status 503, body `{"error":"chain head for identity_events moved four times running; ... retrying may succeed."}`; F8b (b): status 500, body `{"error":"Internal error. The society apologizes."}` (the 201 assertion, whose message carries the body) | byte-exact |
| M90 | the log holds the hash and never the code | `invite_hash: inviteHash` to `invite_hash: inviteCode` | 4 / 2 | `the hash of the code, never the code` on F8b (a) and (b) | byte-exact |

- The status, ledger-row and citizen-row assertions inside the F8a tests hold before the fix too (the failure happens after the payment is booked either way), so they are harness checks; the message assertion is first in each test for that reason.
- The F8b control shows the trigger is the only thing that changes the outcome: with no trigger the same request is a 201 that writes the `invite_redeemed` row.

### F8 closing walk

- Touched: `src/register-gate.ts`, `src/x402.ts` (one word: `clipReason` exported), `test/x402-post-payment-honesty-d1.test.ts` (new), this file and the brief. `src/society.ts`, `src/doc.ts`, `migrations/`, `wrangler.*`, `scripts/` and `test/secret-literal-guard.test.ts` are untouched; the D-061 guard is green.
- `test/register-scripts-unknown-outcome.test.ts` contains the old sentence as a stub answer for the scripts' 5xx handling; it tests the scripts, not this route, and stays green.
