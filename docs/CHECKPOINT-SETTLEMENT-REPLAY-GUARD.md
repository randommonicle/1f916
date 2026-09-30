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
