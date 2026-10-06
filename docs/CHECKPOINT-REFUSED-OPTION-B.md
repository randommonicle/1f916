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
