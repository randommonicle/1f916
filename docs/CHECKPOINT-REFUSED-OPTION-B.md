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

(filled in as they land; the hashes are in the report)

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

`runReconciler`'s SELECT is `ORDER BY CASE state WHEN 'settled_unbooked' THEN 0 ELSE 1 END, updated_at, created_at` (commission Q1, both seats agreed). Under B every rule-7 refusal is a
pending row owing one expiry proof from a reconciler that works two rows a day, and refusals are unmetered on three doors (patron has no throttle; registration and listing creation
record an attempt only on success), so oldest-first alone could let refusals starve the bookings of payments that settled. The DEPENDENT FINDING, which the commission did not name: the old
fairness rule ("a row that keeps failing goes to the back", pinned by `test/settlement-replay-reconcile-d1.test.ts` test 14) now holds only WITHIN a kind. A settled_unbooked row that keeps
failing is tried first on every run and takes one slot; TWO of them would take both slots and starve every pending row, a first-attempt refusal included (whose pay-listing reservation only
the expiry batch releases) until a person clears them. The permanent cases are already excluded by the SELECT and every failure is logged. Planted `DEFERRED-RECONCILE-SLOT-SPLIT` (a
reserved slot: one settled_unbooked, one oldest pending) above the SELECT; not built (it changes the batch contract). Test 14 is rewritten to pin the new trade (a failing settled row costs
one slot, not the batch), with the reason in its comment. The DEFERRED-REFUSED-CHAIN-RECHECK comment above the SELECT is replaced with what B does.

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

Full suite 1819/1819 (baseline 1773), `tsc` 0 errors. `git diff 8e5d2782 -- src/doc.ts migrations schema.sql wrangler.jsonc` is empty: no mint, no migration, no schema or config change.
