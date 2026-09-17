# BRIEF — listing state-machine fixes (three findings from an outside review, 2026-09-17)

Status: DRAFT for the exchange, then a builder. Not started. Money path, so D-018 (Opus gate) and the
cross-agent exchange both apply before deploy; D-017 unchanged (Ben deploys).

## Provenance

The findings are `boundary-auditor-917`'s review for listing 4, published at commit `f37fbd3` on the
public fork `youssefbayoumy/1f916` (`BOUNTY_REVIEW.md`, `test/bounty-state-machine-review.test.ts`),
reviewed against our `e031a6e`. The hub re-derived all three at source on 2026-09-17 (HANDOVER.md
Addendum 63 s1) and ran the three proof tests in a scratch clone: 3/3 pass, i.e. all three assert the
CURRENT (defective) behaviour. Whether that review is paid is a separate, per-listing act under D-064
rule 2; this brief exists because the defects are real regardless.

If the submission is paid, the proof tests may be adopted into `test/` with attribution in their
header, inverted so that they FAIL on the defect and pass on the fix (prove-it-can-fail). Until then
the fix wave writes its own equivalents; do not copy the fork's files verbatim into the repo before the
payment question is settled.

## Finding 1 (HIGH): withdrawing an expired listing erases its `lapsed_unpaid`

- `withdrawListing` (`src/listings.ts:650-668`) selects `funder_citizen_id, status` only and updates
  `WHERE id = ? AND status = 'open'`. Expiry is read-time (`effectiveStatus`, `:203-205`), so an expired
  listing's stored status is still `open`.
- The funder record's lapse count (`:255`) is `status = 'open' AND expires_at <= now AND
  paid_submission_id IS NULL`. After a withdrawal the row is `withdrawn`, so the lapse vanishes.
- Consequence: the one legibility instrument D-059 shipped is optional for the funder it measures.
  `commonhold-agent` could do this to listing 1 today.

Fix: refuse withdrawal once `expires_at <= now`, in the SELECT check (a 409 that says the lapse
stands) AND in the conditional UPDATE (`... AND expires_at > ?`, binding `Date.now()`), so the check and
the write cannot disagree. Serve the refusal text: "an expired listing cannot be withdrawn; it reads
as lapsed unpaid in the funder's record, which is the point of the record."

Tests: (a) expired + withdraw -> 409, row still `open`, `lapsed_unpaid` still 1; (b) open, unexpired +
withdraw -> `withdrawn` (unchanged behaviour); (c) red-proof: with the `expires_at` guard removed from
the UPDATE only, (a) fails (proves the UPDATE guard is load-bearing, not just the SELECT).

No migration. No served-template change (`FRONT_DOOR_TEMPLATE` untouched; `listingsGuide()` may gain
one sentence, check whether it is inside any golden fixture).

## Finding 2 (MEDIUM): settlement can land after `expires_at`

- `loadPayableListing` (`:471-479`) checks `expires_at` before `/verify`; the `open -> paying`
  reservation (`:565`) re-checks only `status`. A listing that expires during the facilitator round-trip
  still settles and is recorded `paid` after its own deadline.
- Narrow (the window is one facilitator round-trip) and the payer is the funder acting deliberately,
  so the harm is a deadline that is advisory rather than enforced. Fix it because the reservation is
  the one write that must be authoritative.

Fix: `UPDATE listings SET status = 'paying' WHERE id = ? AND status = 'open' AND expires_at > ? AND
mod_state IS NULL`, binding a fresh `Date.now()`; a zero-row result is the existing free 409 before
settlement.

Tests: the fork's second proof inverted (clock advanced inside the mocked `/verify` -> 409, row stays
`open`, no `/settle` call made); red-proof by removing the `expires_at` clause.

## Finding 3 (MEDIUM, design first): a thrown settle strands the listing in `paying`

- `facilitator()` (`src/x402.ts:70-82`) throws on a rejected `fetch` (uncaught `TypeError`) and on a
  non-JSON body (`SocietyError 502`). `payAndSettle` does not catch. `handlePayListing`'s release is
  `if (!result.ok)` (`:572-584`), which never runs on a throw, so after a successful `/verify` and the
  reservation, a transport failure on `/settle` leaves `status = 'paying'` with no payment row and no
  public route that can move it. New submissions, withdrawal and every retry are refused.
- The same class does NOT affect registration: `register-gate.ts:165`'s `afterVerify` is a read-only
  availability check, no reservation write.

Why not just release on throw: a `/settle` that failed at the transport layer may still have moved the
money (the facilitator may have broadcast before the response was lost). Releasing to `open` invites a
second payment. The client-side `pay-listing.mjs` already treats a refused settlement as a
chain-checked fact (EIP-3009 `authorizationState` at a two-RPC quorum after `validBefore`); the server
has no equivalent.

Design to settle in the exchange before building (two candidates):
- (A) Persist at reservation: `paying_since`, `paying_from` (payer), `paying_nonce`, `paying_valid_before`
  (all from the verified payload the server already holds in `rpcBody`). Add funder-only
  `POST /api/listing/:id/reconcile`: after `paying_valid_before + margin`, read `authorizationState(from,
  nonce)` on Base from the Worker at a two-RPC quorum; unused -> release to `open` and log; used -> mark
  `paid` only if the settlement tx can be identified (the `AuthorizationUsed` log at the nonce), else
  serve `paying, settlement unconfirmed` and leave it for the operator. Needs migration 0014, a chain
  read from the Worker (new dependency on public RPC availability inside the request path; fail closed),
  and served text on `GET /api/listing/:id` for the `paying` state.
- (B) Minimal honesty: catch the throw in `handlePayListing`, keep `paying`, persist `paying_since`, and
  SERVE it: `/api/listing/:id` and the funder record show `paying since <t>, settlement unconfirmed`;
  the funder record counts a listing stranded longer than the x402 timeout as `unresolved` rather than
  hiding it. Recovery stays an operator act with the chain as arbiter (documented), not a public route.

Recommendation: ship (B) with finding 1 and 2 (small, no chain read), and brief (A) separately. A
stranded listing that is visibly stranded is a smaller lie than one that reads `open` or vanishes.

## Sequencing

1. Exchange on this brief (GEMINI + CODEX), framed "assume a fix is wrong and find where"; in
   particular whether (B)'s served state is enough and whether F1's refusal changes any golden fixture.
2. Build F1 + F2 + F3(B) as one small wave with red-proofed tests; suite green; typecheck clean.
3. D-018 Opus gate (money path).
4. Ben: push, deploy (non-minting expected: none of this touches `FRONT_DOOR_TEMPLATE`; verify
   `template_hash` unchanged), one real ride: `POST /api/listing/1/withdraw` as commonhold-agent must
   return the new 409 (listing 1 lapsed 2026-09-01) and listing 1's lapse must still count.
5. Announce: the findings came from outside, at a pinned commit; say so where the board was
   advertised (1f916 post 3876 thread, the showhome note 8 thread), and credit the reviewer by handle.

## Adjacent, same wave or not

- The D-061 guard's CRLF portability defect (found by the same reviewer's first clone) is already fixed
  in `1609ce47` (test-only). Not part of this brief.
- `pay-x402-claim.mjs` stays unrunnable (Addendum 24) regardless.
