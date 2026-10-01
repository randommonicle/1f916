**VERDICT: DEPLOYABLE.** No HIGH, no MEDIUM. M1 is closed for every outcome the brief names: no interleaving I ran or reasoned through gives a second booking, a `secret` the database does not hold, "nothing was charged" after a settle, or a 402 "sign a fresh one" over a claim another holder can still settle, except inside the first gate's PayAI-contrary residual (LOW-1). That residual is now logged, and the request that meets it answers honestly. Later identical replays of the same claim still get the terminal 402 with `accepts`. Three LOWs are queued for the next paid-path wave; none blocks the deploy. One is cheap enough to fold in now: commit P-E as a test, because one money-path guard can be deleted with the whole suite still green (LOW-3).

# D-018 re-gate: M2 fix passes 3 and 4 (lease ownership through booking), pre-deploy

The scope is `2d48e27f..0735ad17`, in worktree `scratch/wt-m2-replay` on branch `m2-settlement-replay-guard-2026-09-30`. That covers fix pass 3 (`ce3c9e06`, `dd94485d`, `1420c6b7`, `a9433918`, `599653c7`) and fix pass 4 (`9045d083`, `79ef9a17`, `0735ad17`). HEAD = `0735ad17dace9be114785a5c406bcb213d69ca9b` and the tree was clean, so line numbers below are at `0735ad17`. I was read-only on the worktree except for this file. Probes and mutants ran on a scratch copy (`git archive 0735ad17`, with `node_modules` junctioned to `society/node_modules`). Before reviewing I read the predecessor gate record, the checkpoint from "Fix pass 2" onward, and the exchange from "CODEX round 1" to the close. Run 2026-10-01.

## Precondition arithmetic (it decides how the residuals are rated)

- **Request path.** A lapse before `markSettled` needs the original request's lease (180 s from `takeClaim`, `src/settlement-claims.ts:200`) to run out while `/settle` is bounded at 120 s (`src/x402.ts:150`). That leaves more than 60 s of D1 latency outside the bounded fetch.
- **Attempt path.** The re-send and the reconciler acquire the lease and then do a chain read of at most about 16 s plus `/settle`, so a lapse there needs more than about 44 s.
- **C1's invariant still holds.** `test/settlement-replay-timeout-d1.test.ts` is unchanged, and "C1 invariant: the /settle bound plus the booking allowance stays below the claim lease" ran green.
- **Where fix pass 3 does real work.** It covers a lapse during BOOKING: a single batch, or a gap between steps, longer than 180 s, such as four chain-head retries on a very slow D1. Every non-final write now renews the lease (`src/settlement-claims.ts:257`, `:374-375`), so a holder that keeps making progress keeps it.
- **Request-path consequence.** T3a/T3b/T3c and P-D below are defence in depth. They are not a live race.

## Findings

### HIGH: none

### MEDIUM: none

The first gate's M1(c) class (money moved by the facilitator's account, the claim terminal by another holder) is **dropped to LOW-1**. Both reasons it was MEDIUM have changed:
- C1 bounds the precondition that was unbounded.
- Fix pass 4 replaced the false answer, for the request that meets the contradiction, with a logged, honest one (`src/x402.ts:782-806`). Later replays are covered in LOW-1(a).

### LOW

**LOW-1. A settlement the facilitator called successful can still go unbooked. Later replays of a contradicted claim are invited to sign again, and in one sub-case the success is not logged at all.**

*(a) The contradiction (accepted residual, now logged).*
- **Interleaving.** A's lease lapses. B takes it, and B's identical re-POST is answered with a recorded refusal, or B's two RPCs lag more than 300 s (first-gate L5). B marks the claim `refused` or `expired`. A's `/settle` then answers success.
- **What happens.**
  - A logs one `settlement_contradiction` and answers 500, "may have moved ... do not sign again" (`src/x402.ts:815-818`, `:896-900`).
  - Nothing is booked, and no automatic step re-examines a terminal claim: the reconciler selects only `pending`/`settled_unbooked` (`src/settlement-reconcile.ts:135-136`).
  - For `listing_pay`, B's terminal batch has already released the reservation (F2, `src/settlement-claims.ts:273-290`; the re-send and the reconciler both pass `release`). The listing is open again while A's money may have moved, so a second funder payment is possible. The log line, with `resource` naming the listing, is the only signal.
  - **A's honest answer is served once; every later identical replay is not.** The row stays plain `refused` or `expired`, with no marker, so a later replay goes through `respondToExistingClaim` (`src/x402.ts:766`) to `claimAnswer(row, true, reqs)`. That serves the terminal 402 with fresh `accepts` (`src/settlement-claims.ts:481-494`): "By its account no money moved", or "Nothing was charged. Sign a fresh one". This is the brief's false answer, served for as long as the payer keeps replaying. The first gate named it under M1(c), and it survives fix pass 4.
  - Fix candidate: in the contradiction branch, stamp the terminal row, for example with a `verdict_reason` marker conditional on the row still being terminal. `claimAnswer` would then check the marker and serve the contradiction answer instead of `accepts`. Check the 0017 CHECKs before choosing the column.
- **Rating.** PayAI documents an identical in-flight re-POST as `409 duplicate_settlement` or `settlement_pending`, both classified as unknown, never as rule 7. Combined with the lapse arithmetic above, this is improbable. It is logged, and the answer is true.

*(b) The facilitator's tx is dropped when the claim is still `pending` under another holder's live lease (P-D, run).*
- **What happens.**
  - When A's `/settle` answers success and `markSettled` is refused because B holds a live lease on the still-`pending` claim, `answerFromMovedClaim` takes the `pending` branch (`src/x402.ts:819`).
  - A serves the generic unknown-outcome 502. It carries no tx, because `row.tx` is null on a pending row, and it says "whether the money moved is not yet established ... this request changed nothing" (`src/settlement-claims.ts:499`), though A holds a success verdict naming the tx.
  - No log line carries the tx: P-D captured 0 lines containing it, and `settleOrThrow` logs only unknown outcomes (`src/x402.ts:473-487`).
  - `attemptPending` drops a success the same way when its re-read finds `pending` (`src/x402.ts:902`).
- **Harm.** Normally none: B's re-POST gets PayAI's cached success and books. It matters only if B then meets a refusal (case a) or PayAI's recovery record has expired (first-gate L3). In those cases the one fact that would let a person book it is gone.
- **Fix.** On both branches, when a success verdict is in hand, log one line (tx, payer, claim key, `resource`). Optionally carry the tx in the answer, and drop "this request changed nothing" there.

**LOW-2. The TypeScript lease read-back can call "another holder is still booking" a booking failure (P-A, run).**
- **Where.** After a gated-out step, four finishers re-read the claim and ask `leaseHeldByAnother(after, owner, Date.now())`:
  - `src/x402.ts:1029-1030`;
  - `src/register-gate.ts:383-384` and `:419`;
  - `src/listings.ts:510`;
  - `src/listings.ts:1017-1019`.
- **What happens.** If B's lease lapses, or B releases after a failure, between A's batch and A's read, the check is false and A throws its booking-failure path. In P-A, A's ledger batch was gated out by B's live lease and B's lease lapsed straight after it. A answered 500 `payment_settled_unrecorded`, "could not record it in its treasury ledger ... This is logged for the maintainer to put right by hand" (`src/x402.ts:1045-1048`). The claim was merely `settled_unbooked` with nothing written, and a re-send or the reconciler resumes it. "Do not sign again" is still served, so no second payment is invited.
- **Why LOW.** The window is one D1 round trip at a lease boundary. The text is over-specific (a person is not needed), not false about money.
- **Fix.** For the ledger, citizen and key_registered steps, the only gate conditions are state, ref and lease. So `applied: false` with the claim still `settled_unbooked` and the ref unrecorded proves that the lease condition failed at gate time: answer from the claim whatever the re-read lease says. Keep the distinction for pay listing, whose INSERT also requires `listings.status = 'paying'` (`src/listings.ts:1005`).

**LOW-3. No committed test sees the `keepReservation` on `payAndSettle`'s `markRefused`-false answer (G5, run).**
- **The gap.** Deleting `keepReservation: true` at `src/x402.ts:651` leaves the full suite at **1507/1507 green**. T3c, the only test of that branch, is a registration test.
- **Why it matters.** If that line regressed, a pay request that reads a refusal while B is mid-attempt would release its own reservation. If B's re-POST then succeeds, B's booking is gated out because the listing is no longer `paying` (`src/listings.ts:1005`), and the listing can be paid a second time.
- **The test.** My probe P-E (pay listing, refusal read under B's live lease: answers 502, listing stays `paying`, claim `pending`) is green at `0735ad17` and red under G5. Commit it.
- **Where to put it.** It drops into `test/settlement-replay-lease-d1.test.ts` beside T3c and uses that file's own `payFixture`, `bTakesTheLease`, `refusedAnswer`, `oneClaim` and `stubFacilitator`:

```ts
test("P-E: pay listing, refusal read under another holder's live lease: A answers 502 and KEEPS the reservation", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator({
    settle: async () => {
      await bTakesTheLease(d1);
      return refusedAnswer();
    },
  });
  try {
    const fx = await payFixture(d1);
    const res = await fx.pay();
    assert.equal(res.status, 502);
    assert.equal(res.body.accepts, undefined);
    assert.equal(fx.listing().status, "paying", "reservation kept while B may still settle");
    assert.equal(oneClaim(d1).state, "pending");
  } finally {
    stub.restore();
    d1.close();
  }
});
```

### Info

- **I1. Equivalent mutant (G7).** `lease_owner IS NULL` in `HOLDS_LEASE` (`src/settlement-claims.ts:241`) is redundant: every writer sets or clears `lease_owner` and `leased_until` together (`:200`, `:218`, `:227`, `:257`, `:299`, `:310`, `:323`, `:333`, `:374-375`), so `leased_until IS NULL` covers it. Harmless.
- **I2. M15 is redundant by construction (G9 green).** I accept the builder's reading. In one D1 batch, the gate's `HOLDS_LEASE` and the recording UPDATE's `HOLDS_LEASE` read the same claim row at the same `(owner, now)`, and no statement between them touches `settlement_claims`. With `changes() = 1` chained to the gated statement, the two cannot differ.
- **I3. The first gate's I3 is closed incidentally.** A stale finisher now returns `claim_moved` at `src/register-gate.ts:427`, before the invite append at `:510`, so it cannot write a second `invite_redeemed`.
- **I4. `reg_log` is still ungated** (`src/register-gate.ts:348-357`). A stale finisher whose citizen step gates out still writes a throttle row, so that IP's count can run one high, which only errs strict. This is pre-existing and was named by the builder.
- **I5. The reconciler's itemised worst case can be exceeded by one statement (reasoned, not measured).** A stale reconciler finisher that both takes one chain-head collision retry and then has its key_registered step gated out pays 16 + 2 + 1 re-read (`src/register-gate.ts:418`) against `RECONCILE_ROW_WORST_CASE = 18` (`src/settlement-reconcile.ts:28-33`, `:47`). That one statement comes out of `FINALISE_RESERVE`, and the overrun needs a lapse plus a collision on the same row. The honest path's 16 is unchanged.

## The five questions

**1. Is M1 closed?** Yes, for the outcomes the brief names.
- **Double booking.** Fix pass 3 only adds conditions, and the per-step gates and the PK are unchanged.
- **Ownership inside every write.**
  - `HOLDS_LEASE` is on `markSettled` (`:257`), `markRefused` (`:299`), `markExpired` (`:310`), `markHandleTaken` (`:333`), the booking gate (`:371`) and the record UPDATE (`:380`).
  - `noteUnknown` is strictly holder-only (`:323`).
  - Only four `SET state` sites exist in `src/` (`:257`, `:299`, `:310`, `:374`), and no other module UPDATEs `settlement_claims`.
- **No stale `secret`.** A secret leaves only when this call's own final step applied (`src/register-gate.ts:385`, `:414`, `:427`): G3 turns T1c and T1r red in both modes.
- **`markSettled` false.** It is answered from the claim (`src/x402.ts:700-702`, `:808-821`): G10 turns T3b red.
- **`attemptPending`.** It keeps a success as a contradiction (`:893-901`): G4 turns all four H2 tests red.
- **Finishers answer from their own step or the claim.**
  - Patron at `:1151`, `:1154`.
  - Listing create at `src/listings.ts:480`, `:532`, `:543`.
  - Pay listing at `:1048`, `:1051`.
  - G8 shows the lease read-back is load-bearing.
- **Gaps that remain.**
  - LOW-1(b) and LOW-2: incomplete or over-specific answers, both safe ("do not sign again"), both narrow.
  - LOW-1(a): later replays of a contradicted claim get a 402 with `accepts`. This one is not safe, but it sits behind the PayAI-contrary precondition.

**2. Can a stale holder write between another holder's batches via "OR no live lease is held"?**
- **By enumeration, no holder releases between its own batches.** Every `releaseLease` call site comes after the holder's last write, or on a throw path with no further write:
  - `src/x402.ts:694` (unrecorded-settle throw), `:741` and `:763` (re-send `finally`), `:829` (answering);
  - `:938` (`finishUnderOwnLease` on throw);
  - `src/settlement-reconcile.ts:202` (`finally`).
- **Between batches the holder's lease is live,** because each non-final write renews it. G1 is red on T4b/T4c, and G6 is red on T4c and the transitions test, so the lapsed-lease disjunct is exercised.
- **So the unheld branch lets a stale holder write only after the other holder finished or abandoned.**
  - If it finished, the state or ref gate refuses the write.
  - If it abandoned, the stale holder's write is legitimate resumption. Each value carried forward is re-read from `booked_refs`, never taken from the snapshot: the citizen id at `src/register-gate.ts:379-381`, the ledger receipt at `src/x402.ts:1032`, the listing id at `src/listings.ts:507-508`.
- **P-C, run in secret and public-key modes.** B wrote the ledger line and released. A's stale finisher, holding a snapshot with no refs, then completed the citizen step (and key_registered in public-key mode).
  - The result was one ledger row, one citizen and one key line, with the claim `booked`.
  - A's `secret` hashed to `citizens.secret_hash`.
  - A's `ledger_receipt` was B's line's hash.

**3. `keepReservation` on the pay route.**
- **Released while being booked:** no.
  - The route's own release fires only when `keepReservation` is unset (`src/listings.ts:951`): on the not-sent paths, and on a refusal the claim agrees with.
  - It is now bound to this request's own reservation instance (`:953-955`, H1).
  - G2 turns T2 (live lease) red. G5 (the refusal-path flag) is caught only by my P-E (LOW-3).
- **Stranded:** not beyond what a `pending` or `settled_unbooked` claim already implies.
  - The other holder books it, or F2 releases it on `refused` or `expired`.
  - If the other holder abandons, the reconciler books it. P-B, run: the reservation was kept, B abandoned, and one `runReconciler` pass gave `booked: 1`, listing `paid`, one payment row.
  - The bound is the next 06:00 pass, and longer when first-gate L4's slot-eaters are present. This is F2's design, unchanged.
  - The two cases that wait for a person are pre-existing residuals: a pending row where the chain says spent and the facilitator says refused (first-gate L3/7e), and the LOW-1(a) contradiction, where the listing is reopened, not stranded.

**4. Hub rulings.**
- **Agree** with all of the following:
  - one source commit;
  - `payAndSettle` answers from the claim when `markRefused` returns false (T3c; P-E for pay listing);
  - `attemptPending` reports `unchanged` on a refused terminal write (T6);
  - `keepReservation` (see 3);
  - "logged for the maintainer to check against the chain by hand". This is true: nothing re-selects a terminal claim (`src/settlement-reconcile.ts:136`).
- **The `noteUnknown` predicate: agree with strict `lease_owner = ?`** (`src/settlement-claims.ts:323`).
  - It clears the lease, so it must not run for another owner.
  - A lapsed lease still named for me passes, which is the correct self-clear (transitions test `test/settlement-replay-lease-d1.test.ts:726-738`).
  - The only cost is a stale holder's unknown verdict going unrecorded on a row another worker has since handled, which is low stakes.
- **H1 and H2: agree.** CODEX's reproductions are reflected in the H1 and H2 tests, and the code is as described.
- **`answerFromClaim` `reqs: undefined`** (`src/x402.ts:832`): **agree it is unreachable.**
  - It is called only from finishers, and those receive `settled_unbooked`.
  - The only transition out of `settled_unbooked` is to `booked` (`:374`). `refused` and `expired` require `state = 'pending'` (`:299`, `:310`), so the `accepts: [reqs]` shapes cannot be reached.
- **`finishBooking`'s `booked` count** (`src/settlement-reconcile.ts:107-115`, `:178-180`): **agree it is cosmetic.** Production reads only `.actualCost` (`src/index.ts:597`), and no served text or log line carries `booked`.
- **The mirror case** (this attempt read a refusal while another holder settled): **agree.** The re-send answers the claim's true `settled_unbooked` state (`src/x402.ts:889`, `:760-761`), and nothing false is served.

**5. Regressions.** None found.
- **Untouched by the diff:** `migrations/`, `schema.sql`, `src/doc.ts`, `src/constitution.ts`, `wrangler.jsonc`, `scripts/` and `test/settlement-replay-timeout-d1.test.ts` (`git diff --stat 2d48e27f..0735ad17 --` on them is empty). The C1 constants (`src/x402.ts:150-152`) are not in the diff either.
- **Green in the baseline run:**
  - "C1 invariant: ...";
  - "13. non-minting: the attested constitution is untouched (template hash fa11788d, v5)";
  - the deploy-script test "it captures the wrangler version id and stops if there is none; the propagation poll ... verifies non-minting".
- **The honest first payment.** It goes through `markSettled` with `HOLDS_LEASE` passing for its own owner, and through booking steps that renew and then clear. The routes, listings and registration suites are green. The pay route's 200 body (`src/listings.ts:1054-1069`) is outside the diff.

## Mutants run

Each mutant used exact-once string replacements on the scratch copy, ran the named tests, and was then restored. Each restore was checked with `Buffer.compare` against the clean worktree file at `0735ad17`, and all ten matched.

| id | mutation | tests run | result |
|---|---|---|---|
| G1 | `HOLDS_LEASE` dropped from the booking gate (`settlement-claims.ts:371-372`) | lease + claims | **red 6**: T1 both modes, T2 pay listing (live), T2 listing create (live), T4b, T4c |
| G2 | pay route releases even with `keepReservation` (`listings.ts:951`) | lease; probes | **red**: T2 pay listing (live); probes P-B and P-E red |
| G3 | the `finalApplied` guard removed (`register-gate.ts:427`) | lease | **red 4**: T1c and T1r, both modes |
| G4 | `attemptPending`'s contradiction branch disabled (`x402.ts:896`) | lease | **red 4**: H2 re-send and reconciler, refused and expired |
| G5 | `keepReservation` dropped from the `markRefused`-false answer (`x402.ts:651`) | full suite; probes | **full suite green, 1507/1507** (LOW-3); probe P-E red |
| G6 | `HOLDS_LEASE`'s lapsed-lease disjunct neutralised | full suite | **red 2**: T4c, the transitions test |
| G7 | `lease_owner IS NULL` removed from `HOLDS_LEASE` | full suite | green, 1507 (equivalent, I1) |
| G8 | `leaseHeldByAnother` always false | lease | **red 4**: T1 both modes, T2 pay listing (live), T2 listing create (live) |
| G9 | `HOLDS_LEASE` dropped from the record UPDATE only (the builder's M15) | full suite | green, 1507 (redundant by construction, I2) |
| G10 | `payAndSettle`'s contradiction branch disabled (`x402.ts:815`) | lease | **red 2**: T3b refused and expired |

**Probes** (scratch file `probes/zz-regate-probes.test.ts`; each asserts the current behaviour, and all 6 pass at `0735ad17`):
- P-A: the read-back window (LOW-2).
- P-B: abandoned holder, then the reconciler books (Q3).
- P-C: resume through the unheld branch, secret and public-key (Q2).
- P-D: tx dropped under a live lease (LOW-1b).
- P-E: pay listing, refusal under a live lease, reservation kept (LOW-3).

**Baseline:** `npm test` gave 1507/1507 (exit 0), and `npx tsc --noEmit` exited 0, on the scratch copy.

## What I did not check

- **Real D1.** Not checked: batch atomicity of the gate and record pair, `changes()` across statements, and INTEGER/REAL equality on the H1 `paying_since = ?` bind. I relied on the hub's 0017 rehearsal and the local D1 harness.
- **Workers platform clocks.** Not checked: clock skew between isolates (`HOLDS_LEASE` compares one worker's `now` with another's `leased_until`), and whether a Worker keeps running after the client disconnects.
- **PayAI's live answers.** I did not observe its answer to an identical in-flight re-POST, or the recovery-record TTL. LOW-1(a)'s rating rests on PayAI's documentation.
- **The builder's red-proofs.** I did not re-run the builder's 25 red-proofs individually. G1, G2, G3, G4 and G9 are my own runs of mutants equivalent to M1, M10, M3, M20 and M15. The rest are new.
- **I5** is reasoned, not measured.
- **Out of scope.** The deploy script, invite mode beyond I3, and first-gate L3-L7 were not re-reviewed: none is in this diff.
- **Typecheck coverage.** It covers `src/` only.
