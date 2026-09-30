# Checkpoint: one settlement is booked once (gate M2, option B as amended)

Build of `docs/BRIEF-SETTLEMENT-REPLAY-GUARD.md` (sections from "Option B as designed in exchange round 1" to the
end override the body; B10 is Ben's ruling) plus the gate's L1/L2/L3 and D-073 (2). Builder: Sonnet 5.5, branch
`m2-settlement-replay-guard-2026-09-30` in `scratch/wt-m2-replay`. One note per commit. `OPEN FOR HUB:` marks a place
where the brief was ambiguous or two sections conflicted and I took the reading that refuses a second charge and a
second citizen.

## Design decisions (fixed in commit 1, before any route was touched)

1. **Booking is a function of the claim row, not of the request.** Three callers finish a paid act: the original
   request, an identical re-send on `settled_unbooked` (B4), and the reconciler (B6). Each route gets one
   `finish*` function that reads `booked_refs`, skips what is recorded, and writes the next step; the happy path
   calls it too. Resume, replay and reconciler are the same code.
2. **A step is one D1 batch**: the gated row INSERT(s), then `UPDATE settlement_claims SET booked_refs = json_set(...)`
   (and, on the route's last step, `state='booked'`, `rpc_body=NULL`). The INSERT is gated on the claim still being
   `settled_unbooked` with that ref unrecorded, and the claim UPDATE requires `changes() = 1`, so a crashed, repeated or
   concurrent finisher can never write a step twice (`runBookingStep`, `src/settlement-claims.ts`).
3. **Claim INSERT sits inside `payAndSettle`, after `afterVerify`** (where `from`, `nonce` and `rpcBody` exist). A claim
   conflict is a DISTINGUISHABLE outcome (`SettleResult` gets a third shape), so pay listing can revert its reservation
   on a conflict instead of the existing catch turning any post-reservation throw into a kept reservation.
4. **Consult-first in each handler.** A header that matches an existing claim is answered by the claim's state BEFORE
   the free checks that would wrongly refuse a replay (register's "handle is taken" fires at step 2, before any 402).
   The INSERT-time conflict inside `payAndSettle` remains for the race the consult cannot see.
5. **Key normalised to lower case** (`from`, `nonce`, `asset`); `network` and `asset` from OUR requirements. A replay
   with a checksummed address lands on the same key. `valid_before` is unix SECONDS (as signed), clamped to a safe integer.
6. **No module cycle**: `settlement-claims.ts` (DB, state machine, lease, step runner, answers) imports no route module and
   no facilitator I/O.
7. **`rpc_body` is cleared on terminal rows by a CHECK in the table**, not by discipline, and appears in no log line.

## Commits

### 1. Migration 0017, `schema.sql`, the claim module and its tests

- `migrations/0017_settlement_claims.sql` (additive: one table, one index) and the identical block appended to `schema.sql`.
  Adds one column beyond B1's list: `payer` (the facilitator's reported payer), so a resumed booking writes the same ledger
  text as a first-time one. Adds `CHECK (state IN ('pending','settled_unbooked') OR rpc_body IS NULL)` and
  `CHECK (json_valid(booked_refs))`.
- `src/settlement-claims.ts`: key, hashes (`rpc_body_hash`, `intent_hash`, B4a), `takeClaim` (INSERT ... ON CONFLICT DO
  NOTHING, taker holds the lease), lease, conditional transitions, `runBookingStep`, B4/B9 answers.
- `src/chain.ts`: `chainHeadMovedError(table)`, the one wording of the four-times-moved 503, now shared.
- `test/settlement-claims-d1.test.ts`: 11 tests on the primitives.
- Red-proofs: recorded below once run (see "Red-proof log").

### 2. Register and patron wired (B3, B4/B4a, B5/B5a-d); tests 1, 1b, 2, 3, 5, 6a-c, 9, 12

- `src/x402.ts`: `payAndSettle` takes a `PaidClaim` (route, intent, `finish`). The claim INSERT sits after `afterVerify` and
  before `/settle`; a conflict is RETURNED (`ok:false`), never thrown, answered by the claim's state (`respondToExistingClaim`).
  An unknown outcome leaves the claim `pending` and releases the lease; rule 7 marks it `refused`; a settled answer marks it
  `settled_unbooked` and hands the row to the route. `replayForClaim` is the consult-first read (used by register and patron),
  so a replay is answered before `/verify` spends facilitator credits. `recordSettledPayment` writes the treasury line as the
  claim's booking step (`runBookingStep`, ledger ref). Patron booking is `finishPatron`.
- `src/register-gate.ts`: `finishRegistration` is the one booking function (treasury line, citizen, key_registered line), run by the
  original request, the payer's identical re-send and (commit 4) the reconciler. The citizen is recognised by `booked_refs`, never
  by handle. Secret mode: the citizen INSERT is the final step; the reconciler books nothing for it (B5, B6b).
  `society.ts`: `registrationResponseBody` extracted from `register()` (same bytes), `newSecret` exported. `register()` itself is
  untouched and is no longer called by the gate (its offender-scan test still holds).
- Decision: the served "registration did not complete" messages (hub words, F8a) now carry the B6a backstop sentence (public-key)
  or the re-send sentence (secret mode, B6b, no deadline). The F8a tests type the new words literally.
- Decision: `test/helpers/x402-payload.ts` gives every header its own nonce unless a test passes one (the old constant zero nonce
  would now be a replay).
- Decision: the ledger description still names the facilitator's reported `payer` (kept in the claim's `payer` column), so a resumed
  booking writes byte-identical text.
- Secret-literal guard: four reviewed entries (B5d, B6b twice, the claim-gated citizens INSERT); baseline 74 / 23 / 51.
- OPEN FOR HUB: a registration whose handle is taken by a DIFFERENT seat after payment (the race step 2 and afterVerify narrow but
  cannot close) leaves its claim `settled_unbooked`: the brief has no terminal state for it (B2: "No other transitions"). The payer is
  told to re-send; the re-send fails the same way; the reconciler will retry it daily and log each attempt. There is no refund path.
  The operator decides each such row by hand. Not resolved here because any automatic terminal state would either drop a paid
  registration silently or invent a refund.

### 3. Listing create and pay listing wired (B3 reservation + claim atomicity); test 10a-d, listing create

- `src/listings.ts`: `handleCreateListing` and `handlePayListing` take a `PaidClaim`, run `replayForClaim` after their requirements
  are built, and book through `finishListingCreate` (ledger step, then the listing row as the final step) and `finishPayListing`
  (the `listing_payments` row and the flip to paid in ONE batch with the claim update, final step).
- **Decision (B3, pay listing): the conflict is RETURNED, not thrown.** payAndSettle returns `ok:false` for a claim conflict, so the
  pay route's existing `!result.ok` branch releases its own reservation. The catch that keeps the reservation on a thrown unknown
  outcome is never reached by a conflict. Order (i): reservation, then a claim conflict: listing back to `open` (10a). Order (ii): a
  reservation that fails takes no claim (10b). A claim already present before `/verify` is answered without any facilitator call (10a').
- **Decision: pay-listing booking is gated on the listing still being `paying`** (the INSERT and the UPDATE both, and the claim's
  `changes() = 1` ties the reference to the UPDATE). A listing a person has since released books nothing and the claim stays
  `settled_unbooked` (10d).
- **Decision: the funder's own identical re-send cannot finish a pay-listing claim**, because the reservation it meets first (listing
  `paying`) answers the existing 409 before any claim is read. The reconciler is the finisher for that route (B5 says the same).
- The exported booking entry points for the reconciler (`finishListingCreateBooking`, `finishPayListingBooking`) sit at the END of
  `listings.ts`: `test/listings-policing.test.ts` reads each handler from its signature to the next top-level export, and the
  ledger and payment-row scans must keep reading the handlers whole.
- Served text: listing create's "failed to save" and pay listing's "recording it failed" messages now carry the B6a backstop sentence
  (the pointer literals that `post-payment-pointer.test.ts` counts are unchanged).
- Test harness split out to `test/helpers/settlement-harness.ts`; listing tests in `test/settlement-replay-listings-d1.test.ts`.

### 4. The reconciler in the 06:00 handler (B6, B6a, B6b, B7); tests 7a-g, 8, 8b, 11, 14, the budget proof

- `src/settlement-chain.ts`: `readAuthorizationState` (USDC `authorizationState(from, nonce)`, selector `0xe94a0102`, the first TWO
  distinct RPCs of the shared list must answer and agree; fewer or disagreeing is no answer). `society.ts` gains `baseRpcUrls`, shared
  with the treasury balance read so the two lists cannot drift.
- `src/x402.ts`: `attemptPending` (chain decides -> `expired` only after validBefore PLUS `RECONCILE_EXPIRY_MARGIN_SECONDS`; otherwise
  re-POST the stored body, byte-identical, and classify as the first settle was). The payer's identical re-send on a `pending` claim
  takes the lease and runs one attempt itself (B6 "may also").
- `src/settlement-reconcile.ts`: `runReconciler`, a fixed batch of `RECONCILE_BATCH_ROWS = 2`, oldest ATTEMPT first, each row leased,
  every row's failure one log line (the claim's public identity and the reason, never the body), a failing row never stops the rest.
  `src/index.ts`: runs after the governance sweep on the 06:00 (clerk) cron only, and adds what it spent to `priorCost`.
- **Budget (B6a), measured not guessed.** A metered DB (every statement, a batch counting each of its statements) plus the fetch counts
  the attempt reports give the real spend; a row starts only if its worst case (`RECONCILE_ROW_WORST_CASE = 18`: the measured 16 plus one
  chain-head retry) still fits under `RECONCILE_SUBREQUEST_CEILING = 26`. The proof counts the real subrequests through `scheduled()`:
  the worst row alone is 17 with its select (12 D1, 5 fetches; the metered total equals it exactly); `scheduled()` with that row, two due
  proposals and the clerk wake is 48 of 50. With the sweep's 3 the wake sees priorCost <= 29, inside `canAffordConcierge`'s 32.
- OPEN FOR HUB (deviation from B6, the expiry margin): `expired` invites a second signature, so it must never be premature. The brief says
  "unused and `now > valid_before`". I require `now > valid_before + 300 s` (the authorisation window): a transfer broadcast just before
  validBefore can be mined a little after it in wall-clock terms and an RPC can trail the head. Inside the margin the row waits (7f).
- OPEN FOR HUB (B6 reading): when the chain says the authorisation is SPENT and /settle answers a rule-7 refusal, the two contradict; the
  row is left `pending` for a person, never refused (a refusal would invite a second signature for money that moved) (7e).
- OPEN FOR HUB (fairness): "rows worked oldest first" is read as oldest ATTEMPT first (`updated_at`, which a lease acquisition moves), so a
  row that keeps failing goes to the back instead of starving the batch (14). Creation order would let two permanently failing rows block
  every later one forever.
- OPEN FOR HUB: a reconciler-finished registration in `invite_only` mode (legacy, off in production) does not mark the invite code redeemed
  (the reconciler has no code). Noted, not built: the door has been open since 2026-08.
- Listing reservations: the reconciler does NOT release a `listing_pay` reservation when its claim goes `expired` or `refused` (the pay
  route's own rule-7 branch still does, in the request). An operator-held `paying` listing is the existing recovery surface and
  `scripts/pay-listing.mjs` reconciles it; an automatic release could race that script. A `listing_pay` claim the reconciler books is
  booked exactly as the request would have (payment row, paid flip), gated on the listing still being `paying`.

### 5. The classifier (B8: L1, L3), L2's wording, test 4

- `classifySettle` compares `duplicate_settlement` and `settlement_pending` after `trim()` and case-folding, at ANY status, as unknown
  (rule 5; `duplicate_settlement` is a second branch of it, worded as its own non-verdict). Rule 7 carries the same exclusions so a
  refusal never depends on the rules above it.
- `SETTLE_UNKNOWN_TAIL` now ends "; do not sign again." and every unknown message uses it, including rule 3 (which had its own copy)
  and the unreadable-/settle-body throw.
- L2: the three `/verify` messages no longer say "nothing that could settle was sent"; they say "This server never asked the facilitator
  to settle this payment", and the transit message adds that the request may still have been delivered (`NEVER_ASKED_TO_SETTLE`).
- The hub-worded strings the older tests type literally (`x402.test.ts`, `x402-settle-route-d1.test.ts`) are updated to the new words.
- `test/settlement-replay-classifier-d1.test.ts`: L1/L2/L3 units plus test 4, sixteen classifier outcomes each through the real register
  route to their claim state (rule 4 -> booked; rule 7 -> refused; rules 1-3, 5, 6, 8, transit, unreadable -> pending; 200
  duplicate_settlement and " Settlement_Pending " -> pending), each unknown answer ending "do not sign again".
