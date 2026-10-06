# Checkpoint log: option B for a first-attempt refusal (MONEY PATH)

Branch `refused-option-b-2026-10-06`, base `8e5d2782` (`society/` main). Builder: Sonnet 5.5. Spec: `drafts/BUILDER-COMMISSION-REFUSED-OPTION-B-2026-10-05.md`
(CONVERGED by both exchange seats, `exchange/REVIEW_refused-option-b-commission-2026-10-06.md`), design `docs/BRIEF-REFUSED-CHAIN-RECHECK.md`. Nothing pushed, deployed,
migrated or written to a network; no `*.local.*` file read; `src/doc.ts` (`FRONT_DOOR_TEMPLATE`) is not touched.

Base: 1773/1773, tsc 0.

## How every red-proof below was done

A mutant is applied to the working file with an exact-once replacement, the named test files are run ALONE (`node --experimental-strip-types --test <file>`), the failing test
names are read, the file's saved bytes are written back and the sha256 compared before and after (restored byte-identical every time), and `git status` is checked. The harness is a
throwaway script in the scratchpad (not committed). A neighbouring guard turning red is listed but never counts as the proof.

## Commits

| # | sha | what |
|---|---|---|
| 1 | `6ca8e9d4` | a first-attempt rule-7 refusal keeps the claim pending: `markFirstRefusal`, `firstRefusalDetail`, `reportPointer`, the branch rewrite, every first-refusal test rewritten, the fixture flipped |
| 2 | `5a63c39a` | `markRefused` deleted; a scan that nothing writes `refused` |
| 3 | `18eba064` | reconciler: settled_unbooked first (superseded by F1), the expiry/cancellation/booking matrix |
| 4 | `8e3ed4bc` | the claim-conflict answers say "/settle" (item 6) |
| 5 | `31ade529` | `pay-listing.mjs` recognises `settlement_unresolved` (item 7) |
| 6 | `0f8c5dce` | the served-text sweep and `DEFERRED-PAY-LISTING-RESEND-REPLAY` |
| 7 | `1ff8be50` | an import the refusal branch no longer uses; this table |
| 8 | `35853c27` | `settlementField`: the reconciler's sentence only on the dated arm (a claimless row keeps the by-hand wording); the slot-split flag pinned |
| F1 | `27d7c655` | the reconciler batch is one of each kind (UNION ALL of two LIMITed subqueries, interleaved in TypeScript); the slot-split flag removed |
| F2 | `77574a98` | `facilitator_refused` / `recheck_after` on the first-refusal answer only; the pay script keys on it |
| F3 | not built | stopped at the churn threshold: 20 base tests, see the F3 section; the probe was reverted |

## 1. The first-attempt refusal stays pending

`markFirstRefusal` (settlement-claims.ts): ONE conditional UPDATE, `verdict_reason = <reason clipped to 400>, updated_at = now, lease cleared`, WHERE the key matches AND
`state = 'pending' AND lease_owner = owner AND updated_at = takenAt` AND the row is not stopped. `state` and `rpc_body` are never written (attemptPending refuses a pending row whose
body is NULL, so clearing it would leave the row unable to expire). It returns whether it wrote. Strict owner as noteUnknown, not HOLDS_LEASE: a holder that let go of its own lease
(`releaseLease` clears `lease_owner` WITHOUT moving `updated_at`, so the take-time bound still matches) writes nothing (both seats agreed; the unit test has that leg).

`payAndSettle`'s refusal branch: wrote and the re-read row is a pending unstopped one -> the step-0 answer (`claimAnswer(now, true, reqs, { detail: firstRefusalDetail(...) })`,
502 `settlement_unresolved`); anything else (did not write, write threw after the lease was released, the row moved) -> `answerFromMovedClaim(..., null, owner)`; a re-read that
throws or finds no row throws (unknown outcome: pay listing keeps its reservation as `settlement_unconfirmed`). EVERY ok:false return on the branch carries
`keepReservation: true`. The `!isChainSpent(now)` test in the branch is behaviourally redundant with claimAnswer's own stopped check (it answers the stopped message whatever the
detail), kept as the commission words it.

**Deviations from the commission, none of substance:**

- `firstRefusalDetail(verdictError, row, marginSeconds)` takes the margin as a THIRD ARGUMENT. `RECONCILE_EXPIRY_MARGIN_SECONDS` lives in x402.ts, which imports settlement-claims.ts;
  importing it back would make the module graph cyclic and break the module's own header ("imports no route module"). x402.ts passes the constant in.
- A `payAndSettle` call WITHOUT a claim (no production route does this; `test/x402.test.ts` does) keeps today's plain 402: there is no row to hold the refusal on.
- `reportPointer(row)` is exported from settlement-claims.ts (the nonce pointer `stoppedMessage` already built) and used by both; the pointer deviation from the brief
  (`SHOWHOME_REPORT_POINTER` names a tx, a refused payment has none) is as the commission settled it.

Test fallout, every one rewritten, none deleted: `test/listings-d1.test.ts` (two: 402 and release became 502 and a KEPT reservation; the paid half moved to a second listing),
`test/wallet-pin-route-d1.test.ts` (the refused half), `test/x402-settle-route-d1.test.ts` (pay route and register route), `test/settlement-replay-classifier-d1.test.ts` (the two
rule-7 rows: pending, 502, the reason served, `rpc_body` kept), `test/paid-path-m3b-d1.test.ts` (the H2 control and the R2-1 unit test), `test/paid-path-m3-d1.test.ts` (the C1 control
and `bTerminates`), `test/settlement-replay-lease-d1.test.ts` (the failure-injection seams re-keyed to `markFirstRefusal`'s UPDATE; T3d; the "every transition a holder makes" test; the
T3b/H2 loops, whose `refused` leg models a pre-B row; H1 and CODEX r2 (1)-(3) now terminate the row as `expired`, the production terminal state), `test/settlement-replay-reconcile-d1.test.ts`
(the walk keeps a `refused` row, seeded as history), and the ordering fixture (below).

Pre-B refused rows: a `refused` row is production-reachable only as history (L-126). `test/helpers/pre-b-refused.ts` writes exactly what the old `markRefused` wrote, with no
lease condition, and every test that needs such a row says so where it calls it.

Ordering fixture (`test/settlement-claim-orderings-d1.test.ts`): the rival's `markRefused` action is gone (the rival ends `expired` only, so the `end` dimension is removed from its
labels, coverage and the enumeration); I4 is "no trace produces `refused`"; the DEFERRED-REFUSED-CHAIN-RECHECK test is flipped into three tests that pin what the gap became:
no `accepts` on any answer until the C6 expiry proof marks the claim `expired`, through (a) an unreported transfer booked by the payer's re-send, (b) the payer's re-send after the
proof, (c) the reconciler's pass after the proof. Floors re-set: measured before 2266 traces (792 with a rival) and 8612 step checks, floors 2000 / 7500 / 700; measured after
3572 traces (792 with a rival) and 13672 step checks, floors 3150 / 12000 / 700.

Red-proofs (target: `test/refused-option-b-d1.test.ts` unless named): M1 strict owner relaxed -> the unit test's "a lease that was let go is nobody's" leg; M2 take-time bound
removed -> the unit test and R2-1; M3 the write sets `state = 'refused'` -> the unit test, every step-0 test and the ordering fixture's I4; M4 the write clears `rpc_body` -> the unit
test and the ordering tests; M5 stopped guard removed -> the unit test's stopped leg; M6/M7 `keepReservation` dropped on either return -> listings-d1, x402-settle-route, wallet-pin-route,
P-E, M3 HIGH, gate C2, R2-1 (pay listing); M8/M12 T without the margin -> the T assertion on all four routes; M9 pointer swapped -> the pointer assertions; M10 the facilitator's words
dropped; M11 listing_pay told to re-send; M13 step 0 served when the write changed nothing -> T3c (the new "another attempt is in progress" assertion); M14 a thrown write keeps the lease.

## 2. markRefused deleted

`markRefused` had one production caller (the branch above). It is removed, with its comment moved: the `release` paragraph now sits on `markExpired`, the F2 comment says an expiry is the
ONLY terminal write with a listing release, `claimAnswer`'s refused arm and the `payAndSettle` header and the `attemptPending` comments say what option B changed. The `refused` state
stays in `ClaimState` and the table's CHECK; `claimAnswer`'s refused arm, `markContradiction`, `isContradicted`, `holdSuccessAgainstTerminal` and the attention list serve old rows unchanged.
`test/settlement-claims-d1.test.ts` (the last test that imported it) was rewritten onto `markFirstRefusal`/`markExpired`. New test: a scan of `src/` that no file has a `markRefused`
identifier (outside comments), a `SET state = 'refused'` or an UPDATE writing the `"refused"` literal. Red-proof: M15 (a `markRefused` stub beside `markExpired`) and M17 (a
`SET state = 'refused'` string in `settlement-reconcile.ts`) each go red in that test alone; M16 (the B write sets `state = 'refused'`) goes red in it AND in the unit and step-0 tests.

## 3. The reconciler takes money that moved first; how a first-attempt refusal ENDS

**Superseded by fix pass F1 (below):** commit 3 first ordered `settled_unbooked` before `pending` in one `ORDER BY`, which starved pending rows (a refusal's listing_pay reservation only the expiry
batch releases) behind two failing settled rows, and broke the cross-kind "a failing row goes to the back" rule pinned by test 14. I planted `DEFERRED-RECONCILE-SLOT-SPLIT`; both reviewers
rated it blocking, and F1 removed it and the flag. The DEFERRED-REFUSED-CHAIN-RECHECK comment above the SELECT is replaced with what B does.

`test/refused-option-b-expiry-d1.test.ts` (20 tests), on the shared fixture `test/helpers/refused-b-fixture.ts` (the four doors driven with an identical request): the expiry proof by the
payer's re-send (register, patron, listing_create) and by the reconciler (all four), after T at the chain's clock only (the wall clock alone, a trailing RPC, and the margin not yet waited
out each leave the claim pending with no `accepts`); a listing_pay reservation released only in the expiry batch, and a re-send of a reserved listing refused by "paying, not open" before
it reaches the claim; cancellation (the chain reads used while the facilitator refuses again: stopped, never refused or expired, never selected again, listed on the attention list);
success after the refusal (booked once, by the re-send on three doors, by the reconciler's re-POST on listing_pay); secret-mode registration keeps its identical re-send requirement; a held
success meeting a first-refusal row is held, logged and named; `pending_aged` on the attention list; and the starvation regression (three older refusals, one settled-unbooked payment: the
booking goes first). Red-proofs: E1 ORDER BY back to oldest-first -> the starvation test; E2 `markExpired` without the release row -> both listing_pay tests; E3 the pinned proof without
`pastTimestamp` -> the trailing-block leg; E4 the margin not waited out -> the early leg; E5 a used-chain refusal not stopped -> the cancellation test; E6 secret-mode settled_unbooked rows
selected again -> the secret-mode test; E7 a held success not named -> the held-success test.

## 4. The claim-conflict wording says "/settle" (commission item 6, gate L2 class)

`claimAnswer`'s non-identical 409 said "This request sent nothing to the facilitator" and `takeClaim`'s 503 "Nothing was sent to the facilitator". Both can be reached AFTER `/verify`
(payAndSettle takes the claim at `x402.ts` just before `/settle`, after `/verify` at the top of the function), and the `/verify` body is the full signed authorisation (the L2 note), so
the sentence was false on that path; it is true only on the consult path (`replayForClaim`, before `/verify`). Both now say "the facilitator's /settle", true on both. I checked the other
"nothing was sent to the facilitator" sentences against their call sites: `malformed()` (settlement-claims), the three `assertPayloadMatchesRequirements` refusals and the
`PAYMENT_VALID_BEFORE_TOO_FAR` answer all run before `/verify`, so they stay as they are; the three database-error answers in payAndSettle already said "/settle".
`test/settlement-conflict-wording-d1.test.ts` drives each path: the consult (no facilitator call at all), the take (the stub's `/verify` hook lands the conflicting claim, so `/verify`
is called once and `/settle` never), and the 503 (a vanished row is not production-reachable, rows are never deleted, so it is driven through a database that reports a conflict and no
row). Red-proofs: W1 the 409's old sentence back -> the consult and take tests; W2 the 503's old sentence back -> the 503 test.

## 5. `scripts/pay-listing.mjs` recognises the code (commission item 7, CODEX r1)

A first-attempt refusal is now a 502 `code: "settlement_unresolved"` with the listing kept reserved. The script's generic non-200 branch would have read the nonce as unused, written a local
`refused` tombstone and promised a re-run after validBefore + the margin, which `loadPayableListing` refuses ("paying, not open") until the reconciler releases the listing. A new branch,
checked BEFORE the generic one and matching `secondJson.code === "settlement_unresolved"` (the code, never the error text), keeps the tombstone `signing` (rewritten with `from`, `nonce`,
`valid_before`, the status and the detail), does not consult the chain, and returns reason `leg2_unresolved`. **Scope, a decision the commission left open (the advisor's catch):** the code is
also what the 500 answers carry (a payment that settled but whose booking is not finished, and a claim stopped for a person), so the branch is not scoped to 502: `signing` is the true state
for those too, and the message is chosen by status. For a 502 it says the server keeps listing N reserved, a re-run is refused while it is paying, the reconciler decides it after
validBefore + the margin (the time is printed), releasing the listing in the same step if the authorisation expired unused (`GET /api/listing/:id` then shows it open, and only then is a fresh
signature safe) or booking it if the facilitator's settlement is confirmed; for any other status it is the do-not-re-run message, with no reservation story. The one existing test that
pinned the old behaviour ("a 502 settlement_unresolved with the chain unused is recorded 'refused'") is rewritten into the first of three: the 502, the 500, and "the code, not the words".
Checked and left unchanged: `register-maintainer.mjs`'s `sendSignedPayment` already treats every 502 as an unknown outcome and prints the do-not-sign-again warning, which is what a first
refusal on registration now is; `refusedLine`'s "a 402 is the facilitator's own refusal" stays true for the /verify refusals and the expiry 402.
Red-proofs (`test/pay-listing.test.ts`): P1 the branch removed -> the 502 and 500 tests (the generic path writes `refused`); P2 matching the words instead of the code -> the code-not-words
test and both others; P3 the 502 story told for every status -> the 500 test; P4 the branch writes `refused` -> the 502 and 500 tests.

## 6. The served-text sweep (L-002 class) and DEFERRED-PAY-LISTING-RESEND-REPLAY

Each surface that tells a payer what a refusal means, or that a 402 follows a failed settlement, was read from the live router (a throwaway scan of `/`, `/llms.txt`, `/skill.md`,
`/heartbeat.md`, `/api/surface`, `/api/listings/guide`, `/api/listings/security`, `/api/official`, `/api/listings`) and from source. None says a facilitator refusal is answered 402 or
releases a listing: before B that was true of the code and of nothing served. The list:

- `GET /api/listings/{guide,security}`: checked, UNCHANGED ("a refusal writes nothing public" is about the pin refusals before any payment).
- `GET /api/listing/:id` (`settlementField`, listings.ts): CHANGED. "...neither open nor paid until the operator reconciles it against the chain" said too little once a refusal routinely ends
  here: it now says the society's reconciler makes one pass a day at 06:00 UTC (no time promised), releases the listing if the signed authorisation expired unused or books the payment if it
  settled, and lists a claim it stops, or that stays undecided for `ATTENTION_AGED_DAYS` days, at `GET /api/settlements/attention`. The `pending since` wording is unchanged. The step-0
  listing_pay answer points the funder at this read. Also `FUNDER_RECORD_NOTE` and the `?status=unresolved` description: checked, true as they stand.
  **The new sentence is served on the DATED arm only (advisor catch, found before the report).** The `paying_since IS NULL` arm is for a row reserved before migration 0014, which
  predates the claim table (0017): it has no claim, so the reconciler can never select, release or book it and the attention list never carries it. There the old by-hand wording is the
  true one and is kept (a test pins the split; red-proof S1b). A dated row reserved between 0014 and 0017 would also have no claim; whether prod holds one is a state this worktree cannot
  see: before deploy, Ben's prod read `SELECT id, paying_since FROM listings WHERE status = 'paying'` against `SELECT listing_id FROM ...settlement_claims` (the intent's listing_id) settles it.
- `scripts/post-listing.mjs` (listing_create's payer) and `scripts/pay-x402-claim.mjs`: checked, UNCHANGED. Both treat any non-success leg 2 as an unknown outcome (post-listing: `leg2_not_201`,
  tombstone stays 'signing', `recoveryMessage` says do not re-run and verify on-chain; pay-x402-claim: `unknown(...)`), which is what a first refusal now is. No registry enumerates `DEFERRED-*`
  flags in `src/` (the guest flags have their own, scoped by name), so the new flag is planted by comment and pinned by a test (DEFERRED-PAY-LISTING-RESEND-REPLAY). The slot-split flag planted in commit 3 was removed again by fix pass F1.
- `src/doc.ts` / `FRONT_DOOR_TEMPLATE` (hashed): checked, NOT TOUCHED, no mint. Its lines on the 402 describe the unpaid probe, not a refusal.
- `src/discovery.ts` route notes, `/llms.txt`, `/skill.md`, `/heartbeat.md` (`src/inbox.ts`), `/api/surface`, `src/mcp.ts` and `src/mcp-read.ts` tool descriptions: checked, UNCHANGED (the 402 they
  describe is the probe; the register tool says the MCP door cannot carry a payment).
- Code comments: `payAndSettle`'s header (x402.ts), the refusal branch, `attemptPending`'s H2 notes, `answerFromMovedClaim`'s list, `holdSuccessAgainstTerminal`'s residual, the F2 release note,
  `claimAnswer`'s refused arm and B9 note (settlement-claims.ts), the reconciler's SELECT and header (settlement-reconcile.ts), and the release comment and the `unresolved` field comment
  (listings.ts): CHANGED, in commits 1-3 and here.
- `scripts/pay-listing.mjs`: CHANGED (commit 5). `scripts/register-maintainer.mjs` (`sendSignedPayment`, `refusedLine`): checked, UNCHANGED. A first refusal on registration is now a 502, which
  `sendSignedPayment` already treats as an unknown outcome (the identifiers and the do-not-sign-again warning); `refusedLine`'s "a 402 is the facilitator's own refusal" stays true of a /verify refusal.

`DEFERRED-PAY-LISTING-RESEND-REPLAY` (commission Q2, both seats agreed) is planted at the B4 consult in `handlePayListing` (`replayForClaim`), which a re-send of a reserved listing never
reaches (`loadPayableListing` refuses it first), and a test keeps it there.

New `test/refused-option-b-served-text-d1.test.ts`: the changed `settlementField` sentence, the listing read a refused funder is pointed to, a sentence-level scan of nine served surfaces for
the three old claims (402 after a refused settlement; a refused settlement releases the listing; the facilitator's refusal is final), and the scan's own self-test (it fires on each old
claim and on none of the sentences the surfaces carry). Red-proofs: S1 the old settlementField sentence back -> the field test and the listing-read test; S2/S3 the guide made to claim a
release, or a 402, after a refused settlement -> the scan; S4 the flag removed -> the flag test.

## Close

Full suite 1820/1820 (baseline 1773), `tsc` 0 errors. `git diff 8e5d2782 -- src/doc.ts migrations schema.sql wrangler.jsonc` is empty: no mint, no migration, no schema or config change.

# Fix pass on the build review (`exchange/REVIEW_refused-option-b-build-2026-10-06.md`, CODEX r1 and GEMINI r1)

## F1. The reconciler's batch is one of each kind (both reviewers, blocking)

`runReconciler` fetches in ONE statement (`RECONCILE_SELECT_COST` stays 1): `SELECT * FROM (settled_unbooked subquery ... ORDER BY updated_at, created_at LIMIT ?) UNION ALL SELECT * FROM (pending
subquery ... LIMIT ?)`, each with the existing filters (the secret-mode exclusion is on the settled subquery only, where it applies). TypeScript sorts each kind oldest-first and interleaves: first
settled, first pending, second settled, second pending, then takes the first `RECONCILE_BATCH_ROWS`. One of each kind per run when both exist; two of one kind when only that kind does; within
a kind a failing row still goes to the back (its `updated_at` moves on every lease). No window function (D1's runtime support is unproven; CODEX's probe was local SQLite 3.51.3 only).
`DEFERRED-RECONCILE-SLOT-SPLIT` and its pinning test are removed. The ordering comment is rewritten with the reasons.
**Residual, not new:** the loop still sheds a second row whose worst case would pass the ceiling (`actualCost + 18 > 26`), so an expensive failing first row (a public-key registration failing at
its last step costs up to 16) can still shed the second of the pair. A cheap one (the patron case tested) cannot. Named for the gate, not built (it is the pre-existing C6 consequence).
Tests (`test/refused-option-b-expiry-d1.test.ts`): two settled rows that keep failing plus a pending listing_pay refusal, and the pending row is worked on the FIRST run and its reservation is
released by the expiry batch; two pending rows and no settled row are both worked; two settled and no pending are both worked, and a failing settled row goes behind the one that has waited.
Reconcile test 14 holds unchanged apart from its comment. Red-proofs: G1 back to the settled-first `ORDER BY` -> the two-failing-settled starvation test (for that reason: `resolved 0`, the listing still
`paying`); G2 back to plain oldest-first -> that test AND the earlier refusals-starve-bookings test; G3 the interleave dropped -> the starvation test; G4 within a kind newest first -> the within-kind test and
reconcile test 14; G5 one pending row fetched -> "two pending rows"; G6 one settled row fetched -> the settled tests.

## F2. The first-refusal answer carries a discriminator; the pay script keys on it (CODEX)

`settlement_unresolved` is shared by every answer that says "the outcome is not established", including a 502 that means the facilitator ALREADY reported a settlement this request could not
record (`claimAnswer`'s `settledTx` branch, `x402.ts` `answerFromMovedClaim`). The pay script's expiry-and-reopen story is false for that payer. The B first-attempt answer, and only it, now carries
`facilitator_refused: true` and `recheck_after` (T, ISO UTC, one function `firstRefusalRecheckAfter` shared with `firstRefusalDetail`); status 502 and the code are unchanged. `claimAnswer` adds the two
fields only when the caller passes `firstRefusalRecheckAfter`; only `payAndSettle`'s first-refusal return does. `scripts/pay-listing.mjs` shows the reservation/expiry message only on
`facilitator_refused === true` (the boolean, nothing truthy); every other `settlement_unresolved`, 502 or 500, gets "the outcome is NOT established, the money may have moved, DO NOT re-run, the record stays
`signing`, the operator reconciles from the chain" with no reopen promise. The tombstone keeps `facilitator_refused` and `recheck_after` when the server said them.
Tests: pay-listing.test.ts (the 502 with the discriminator; the 502 settledTx shape; the 500; the boolean-only rule); the served-text file (the discriminator on all four routes, equal to validBefore + 300,
and absent from a re-send's answer, a stopped 500, a booking failure, an unknown first outcome, a held success, a settled_unbooked answer and the lease-held answer). Red-proofs: D1 the route passes
no discriminator -> the four route tests and the "no other" test; D2 the held success carries it -> "no other"; D3 every pending answer carries it -> "no other"; D4 the pay script keys on the code
again -> the settledTx 502, the 500 and the boolean tests; D5 any truthy value unlocks the story -> the boolean test; D6 `recheck_after` dropped from the record -> the first test.

## F3. The re-send cooldown: NOT BUILT, stopped at the churn threshold (as commissioned)

Built to the commission as a probe, not committed: `RESEND_COOLDOWN_MS = 60_000` exported from `x402.ts`; in `respondToExistingClaim`'s pending branch, before `acquireLease`, `if (Date.now() - row.updated_at <
RESEND_COOLDOWN_MS)` answers `claimAnswer(row, true, reqs, { detail })` from the row (no lease, no RPC, no /settle), the detail naming the last attempt and `updated_at + cooldown` as ISO UTC; the reconciler is
untouched. The served-sentence check held: `RECONCILE_REPEAT_CLAUSE` ("re-checks it sooner") stays true, the held-lease "repeat in a few minutes" stays true, and `firstRefusalDetail`'s "after T" is
past the cooldown (a refusal at /settle was made on an authorisation still valid at /verify, so T = validBefore + 300 s is more than 200 s after the refusal).

**The churn: 33 tests failed, 20 of them present at the base commit (more than the commission's limit of about 12), 13 written in this branch.** The 20 are the tests that replay immediately and expect
a re-check: C1 refused/expired (re-POST), C2 (re-POST), R2-3, C4-B control, CODEX deploy-script r3, CODEX pending-wording r1, H3/MEDIUM-1 (patron), C7, F4 (register, patron, settled-but-unrecorded),
H2 re-send refused/expired, CODEX r2 (2) tx-named/empty-tx, 7g, test 8, and the ordering enumeration (3572 traces, each RESEND step an immediate re-send, so it needs a clock step per RESEND, which changes
what it enumerates). Per the commission the probe was reverted and F3 is reported rather than built; F1 and F2 stand. Nothing in the tree depends on F3.

## F1b and the F3 flag (coordinator follow-ups)

**F1b.** Within each pair (the k-th settled row and the k-th pending row) the row that has waited longest, by `updated_at` then `created_at`, goes first, settled first on a tie. Always settled first
could shed the pending row on EVERY run when the first row is costly and keeps failing (the loop sheds the second row when `actualCost + 18 > ceiling`); a failing row moves its own `updated_at`
on every attempt, so next run the waiting row is older and goes first, and the shed can fall on a kind at most on alternate runs. Test: a failing public-key registration booking (6 statements, 7 with the select)
plus a pending listing_pay refusal on a day with a ceiling of 24 (`runReconciler(env, 24)`, what production hands the reconciler when the sweep and concierge have used the rest): run 1 tries the settled row and
sheds the refusal, run 2 works the refusal and the expiry batch releases the listing. Honest limit: a failing settled row costs 6 once its earlier steps are booked, so the "costly" row is modelled by the day's
ceiling, the same arithmetic as a first attempt costing 9 or more against 26. Red-proof H1: the always-settled-first pair order fails that test at run 2 (`resolved 0`, the listing still `paying`) and reconcile
test 14. Reconcile test 14's runs 2-4 were REVISED, not weakened: A, having just failed, now waits behind the older pending rows (run 2: C booked, A shed loudly; run 3: D booked; run 4: A tried and logged).
**F3** stays unbuilt: `DEFERRED-RESEND-COOLDOWN` is planted at `respondToExistingClaim`'s pending branch in `x402.ts` (the unbounded re-send window, the prototype and its 20 broken tests, the two seats' positions, the gate decides).

# After the D-018 gate (`docs/REVIEW-REFUSED-OPTION-B-GATE-2026-10-06.md`: DEPLOYABLE WITH CONDITIONS, HIGH 0): C3 and the LOW fixes

| Row | What | Red-proof |
|---|---|---|
| C3a | `test/refused-option-b-expiry-d1.test.ts`: the refusals-starve-bookings test renamed to what it covers (refusals NOT yet past T, the cheap re-POST path, 7 with the select); two new tests with refusals PAST T (valid_before backdated too) that pin the gate's probes: a settled-but-unbooked payment behind N=3 older aged refusals is booked on pass N+1 (4), a listing_pay refusal behind four older ones is released on pass 5; one aged refusal is cleared per pass | X1 the ceiling raised to 40 fails both probes (and the expiry-by-reconciler tests, which assert a single pass) |
| C3b | `DEFERRED-RECONCILE-EXPIRY-SHED` planted above the shed check in `settlement-reconcile.ts` (9 + 18 > 26; one aged pending row cleared per pass; remedy shapes: price the next row by its own route and kind, or let a listing_pay re-send reach its claim); pinned by a source test beside the probes | X2 the flag removed |
| C3c | the `DEFERRED-RESEND-COOLDOWN` comment (`x402.ts`) now records the gate's ruling (a), its four reasons, the three un-defer triggers and the migration-free fix shape (a rule-7-prefixed pending row re-sent before its T answered from the row, which also fixes L3 for re-sends) | Y1 ruling removed, Y2 a trigger removed |
| L1 | `RECONCILE_BACKSTOP` no longer says "oldest attempt first": it says the pass takes settled-but-unbooked and still-unresolved payments in turn, longest-waiting first within each. Tests that pinned the old words updated (replay-fixes F4, replay-listings x2, post-payment-honesty) | X5 the old words back fail all four files |
| L3 | the first-refusal answer (only) ends on `RECONCILE_BACKSTOP`, without `RECONCILE_REPEAT_CLAUSE`; every other pending answer on register/patron/listing_create keeps it, listing_pay never has it | X3 the clause back on the first answer; X4 the clause gone from every answer |
| L2 | `DEFERRED-DATED-PAYING-NO-CLAIM` planted in `settlementField`'s dated arm (the double failure at `payAndSettle`'s claim INSERT + re-read keeps a reservation with no claim; Ben's pre-deploy anti-join covers existing rows) | Y3 |
| L4 | `DEFERRED-LISTING-CREATE-THROTTLE-RESEND` planted above `assertListingCreateNotThrottled` in `handleCreateListing`; the wrong comment at the pay route's release (it named a /verify refusal after the reservation, which cannot occur) corrected | Y4, Y5 |

**Determinism fix found while red-proofing:** the F1b test's pair order depends on the refusal's `updated_at` against the settled row's, and two timestamps taken in the same millisecond tie (settled first), which made it fail once in a file-wide run. The refusal's `updated_at` is now fixed at 2000 (`created_at` is left alone: the release is bound to a reservation taken no later than the claim's creation); six isolated and three file-wide reruns pass.
**Scratchpad collision, recorded:** the gate session shares the scratchpad and had overwritten my `mutate.mjs` with its own mutant script; my next invocation applied ITS mutant (`state = 'refused'` in `markFirstRefusal`, and the old 402 branch in `x402.ts`) to this worktree before throwing. I found it from the unexpected `M src/x402.ts` in `git status`, restored `x402.ts` with `git checkout` and `markFirstRefusal`'s SQL by an exact reverse replacement, checked `git diff` showed only this pass's edits, and moved my harness to a private `builder/` folder. Nothing mutated was committed (the suite is green and the red-proof table above was re-run from the private harness).
