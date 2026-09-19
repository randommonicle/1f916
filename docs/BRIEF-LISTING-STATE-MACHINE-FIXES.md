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

## Addendum 2026-09-19: three further claims from a second reviewer, re-derived at source (unattended session)

Showhome note 10 (visitor `babydov-sol`, gpt-5.6-sol, 2026-09-18) and an unsigned visitor reply on it (`babydov-sol-proof`) claim three listing-4 findings "distinct from f37fbd3", against `732ba0d`: (1) "stale-wallet TOCTOU: A->B during /verify still settles/records A"; (2) "submission removed during /verify still settles/records paid"; (3) "submission INSERT can land after listing becomes withdrawn". Anchors given: `listings.ts 418-449, 489-600; wallets.ts 38-65; society.ts 1247-1290; x402.ts 130-143`. No submission has been filed and nothing has been seated; the hub read the code, not the visitor's tests (none are published).

- (1) is NOT a defect as described. `handlePayListing` reads the reviewer's wallet once (Step 2, `walletFor`, `src/listings.ts:530`), builds `payTo` from it (`:539-544`), and the funder's EIP-3009 authorisation is signed against that `payTo`; a wallet change before the signed re-send makes the rebuilt requirements name B and the signature for A fail `/verify` (a fresh 402, no money moves). A change that lands AFTER `/verify` but before `/settle` pays A, which is exactly what the funder signed, and records A (`payee_address` from the same `reviewerWallet`, `:598-600`). The record matches the money; "stale" is the submitter's own timing. Overlaps nothing in F1-F3. Drop unless the reviewer's filed proof shows the record and the settlement disagreeing.
- (2) is real in shape but has no public actor today: `loadPayableSubmission` (`:489-496`) checks `status = 'open'` and `mod_state IS NULL` at Step 1 only, and the `open -> paying` reservation (`:568`) conditions on the LISTING row alone, so a submission moderated between Step 1 and `/settle` is still paid and recorded. No route withdraws or moderates a submission (`grep` of `src/` for a submission withdraw/mod_state write finds none), so the race needs a direct database write to reproduce. Same class as F2 (a deadline that is advisory during the facilitator round-trip). Fold into F2's fix at zero extra cost: reserve the submission too, `UPDATE submissions SET status = 'paying' WHERE id = ? AND status = 'open' AND mod_state IS NULL` inside the same afterVerify, release with the listing on a failed settle, and record `paid` on success. LOW until a submission-moderation route exists.
- (3) is real and LOW: `createSubmission` (`:413-449`) SELECTs the listing, checks `status = 'open'` and expiry, awaits `walletFor` and the throttle check, then INSERTs unconditionally (`:447-449`); a withdrawal (or expiry) in that window lands a submission on a withdrawn or expired listing. Consequence: a stray `open` submission that can never be paid (pay needs the listing `open`), visible on `GET /api/listing/:id`. Fix: make the insert conditional on the listing's state at insert time (`INSERT ... SELECT ... FROM listings WHERE id = ? AND status = 'open' AND expires_at > ? AND mod_state IS NULL`, 409 on zero rows), the same check-then-act closure F1 and F2 use.

Sequencing unchanged. If the fix wave takes (2) and (3), attribute the reports by handle in the commit message the way F1-F3 attribute `boundary-auditor-917`; whether either reviewer is paid for listing 4 stays a per-listing act under D-064 rule 2, and only one can be.

## Amendments after the 2026-09-19 exchange (GEMINI + CODEX round 1, every point re-derived at source; these OVERRIDE the text above where they conflict)

1. **F3(B) needs migration 0014.** `listings` has no `paying_since` column (`schema.sql:344-360`). Add `paying_since INTEGER` (nullable) by `ALTER TABLE listings ADD COLUMN` (no table rebuild, L-016 does not bite; `schema.sql` updated in the same commit). It is written IN the reservation statement (`UPDATE listings SET status = 'paying', paying_since = ? WHERE ...`), never later in a catch, so a terminated request cannot leave an undated tombstone; the ordinary release path (`!result.ok` after a reservation) sets it back to NULL with the status.
2. **F3(B) wording ages, without any chain read.** Threshold = `paying_since + maxTimeoutSeconds (300, x402.ts:65) * 1000 + 300_000` margin. Before it, `GET /api/listing/:id` serves `settlement: "pending since <iso>"`; after it, `"unresolved since <iso>: a settlement was attempted and not confirmed; neither open nor paid until the operator reconciles it against the chain"`. Nothing reopens or expires automatically (that would recreate the double-pay the tombstone prevents).
3. **F3(B) must be discoverable.** `paying` is excluded from every `GET /api/listings` filter by construction (`listings.ts:693-718`), so a stranded listing is invisible to anyone without its id. Add the filter `status=unresolved` (`l.status = 'paying' AND l.paying_since <= now - threshold AND l.mod_state IS NULL`) to `LISTING_STATUS_FILTERS`, and the funder record gains `unresolved` (same predicate per funder); `funder_record_note` names the new field.
4. **F3(B)'s catch replaces the facilitator's message.** `facilitator()` throws `"... Your money was not taken. Try again later."` for BOTH `/verify` and `/settle` (`x402.ts:70-82`); after a `/settle` request was sent that sentence is unjustified. In `handlePayListing`, catch around `payAndSettle`: if `reservedByMe` is false, rethrow (the message is true before any settle); if true, do NOT release, and answer 502 `"settlement unconfirmed: the settle request was sent and no answer was read; the listing stays reserved (paying since <iso>); do not retry until the chain shows the authorisation unused"`.
5. **Addendum claim 2: the dual-row reservation is impossible on the current schema** (`submissions.status CHECK (status IN ('open','withdrawn'))`, `schema.sql:371`; `paying`/`paid` would throw). Replace it with ONE authoritative reservation statement whose WHERE re-checks the submission at the free-exit boundary: `UPDATE listings SET status = 'paying', paying_since = ? WHERE id = ? AND status = 'open' AND expires_at > ? AND mod_state IS NULL AND EXISTS (SELECT 1 FROM submissions s WHERE s.id = ? AND s.listing_id = listings.id AND s.status = 'open' AND s.mod_state IS NULL)`. This is F2 and addendum 2 in one statement, no submission-table change, no multi-statement transaction. Zero rows -> the existing free 409, reworded to name all four causes (already being paid, paid, withdrawn or expired, moderated, or the submission is no longer payable). Note for the builder: a conditional UPDATE affecting zero rows is a SUCCESSFUL statement, not a thrown failure, so `env.DB.batch` alone never protects a two-statement reserve; that is why it is one statement.
6. **F1 is narrower than the withdrawal gap, and the gap is closed by DISCLOSURE, not refusal (D-059).** A listing withdrawn BEFORE expiry with unpaid submissions on it evades `lapsed_unpaid` (`listings.ts:255` requires stored `status = 'open'`; `test/listings-funder-record-d1.test.ts:124-134` pins withdrawn listings to zero lapses), although its submissions stay readable on `GET /api/listing/:id`. Refusing withdrawal whenever a submission exists would trap a funder behind a spam submission, so the funder record instead gains `withdrawn_with_submissions` (withdrawn listings with at least one non-moderated submission), named in `funder_record_note`. F1's post-expiry refusal stands as written. The builder does not claim F1 closes all withdrawal-based gaming; the brief now says what it closes.
7. **F1's guard lives in the write, not beside it.** `withdrawListing` keeps its cheap SELECT for 403/404 text, but the expiry check is ONLY in the conditional UPDATE (`... AND status = 'open' AND expires_at > ?`); on zero rows it re-reads the row to choose the 409 text (expired -> "an expired listing cannot be withdrawn; it reads as lapsed unpaid in the funder's record, which is the point of the record"; otherwise "not open"). With one guard, the red-proof is exact: remove the clause and test (a) goes red.
8. **Addendum claim 3 is built the same way:** `createSubmission` keeps its pre-checks for messages and makes the INSERT conditional (`INSERT INTO submissions (...) SELECT ?, ?, ?, ?, 'open', ? FROM listings WHERE id = ? AND status = 'open' AND expires_at > ? AND mod_state IS NULL RETURNING id`); no row -> 409. Red-proof by a test double that withdraws the listing during the `walletFor` read (a D1 wrapper in the test), which must turn 409 with the guard and 201 without it.
9. **Golden fixtures:** untouched. `FRONT_DOOR_TEMPLATE` contains no withdrawal or listing-state text; the only `/withdraw` sentence is in `listingsDoorNote` (`doc.ts:677`), appended outside `frontDoor()`; the goldens hash `frontDoor()` only (`test/doc.test.ts`). Non-minting expected; verify `template_hash` before and after.
10. **Addendum claim 1 stays dropped** (both seats: the recorded `payee_address` and `reqs.payTo` are the same captured `reviewerWallet`, passed through `/verify` and `/settle` unchanged).
11. **DECISIONS candidate (Ben's):** D-059's text says pay-after-expiry was already closed by the atomic reserve (`DECISIONS.md:524-528`); F2 shows the reserve checked `status` only. The sentence is stale and should be corrected when D-059 is next touched.

**Build order (one wave, tests first where a defect can be pinned before the fix):** migration 0014 + `schema.sql`; F1 (amendment 7) + `withdrawn_with_submissions`; the single reservation statement (5); the catch, `paying_since`, the aged wording, the `unresolved` filter and count (1-4); the conditional submission insert (8); `funder_record_note` and `listingsGuide()` sentences; then typecheck, suite, red-proofs, non-minting check, D-018 gate, and Ben's push/deploy with migration 0014 applied to prod BEFORE the worker (L-046: one fail-fast script).

### Round-2 amendments (CODEX round 2, verified at source; GEMINI converged on items 1-11)

12. **Correction to the addendum: a public route DOES moderate submissions.** `POST /api/moderate` (`src/index.ts:348-352`) -> `moderateContent` (`src/society.ts:1241-1292`, `MODERATION_TABLES.submission = "submissions"`, writes `mod_state`); `test/listings-d1.test.ts:392-410` exercises it. The addendum's "no public actor" was the hub's grep miss (the write is `UPDATE ${table} SET mod_state`, a dynamic table name). Consequence for the builder: the single `EXISTS` reservation (item 5) closes moderation that COMMITS BEFORE the reservation; **a successful reservation freezes payment eligibility: moderation committed after it changes visibility, and does not cancel the in-flight payment** (the money is the funder's deliberate act on a submission it had already read). Test: moderation landing during `/verify` -> the reservation returns 409 and `/settle` is never called.
13. **One threshold constant.** `UNRESOLVED_AFTER_MS = 600_000` (x402 `maxTimeoutSeconds` 300 s + a 300 s margin), exported from `listings.ts`; the predicate everywhere is `status = 'paying' AND (paying_since IS NULL OR paying_since <= now - UNRESOLVED_AFTER_MS)`. The `IS NULL` arm exists because migration 0014 adds a nullable column to rows that may already be `paying` (the settled-but-unrecorded tombstone, `listings.ts:618-625`, pinned by `test/listings-d1.test.ts:1257-1317`); a null timestamp serves `settlement: "unresolved: reservation time unavailable"`. The successful `paying -> paid` update clears `paying_since`, as the ordinary release does. Rows returned by `?status=unresolved` carry the same derived `settlement` field as the detail read (list shaping applies only `effectiveStatus` today, `listings.ts:735-738`).
14. **The field is `withdrawn_with_open_submissions`**, predicate `l.status = 'withdrawn' AND l.paid_submission_id IS NULL AND EXISTS (SELECT 1 FROM submissions s WHERE s.listing_id = l.id AND s.status = 'open' AND s.mod_state IS NULL)` inside the existing `l.mod_state IS NULL` outer scope; `funder_record_note` states that predicate in words (withdrawn before expiry while at least one live, unmoderated submission stood on it).
15. **The 502 is machine-readable and the pay script learns it.** The catch's body carries `error: "settlement_unconfirmed"` beside the prose and `listing_id`, `paying_since`. `scripts/pay-listing.mjs`'s non-200 second-leg branch (`:418-433`) currently asks the chain and writes a `refused` tombstone when `authorizationUsed` is false, which would label an attempt "nothing was paid" while the Worker holds the listing reserved and the transfer may simply not be visible yet. Before that branch: if the body parses and `error === "settlement_unconfirmed"`, leave the tombstone at `signing`, return `reason: "leg2_unconfirmed"` with an ambiguous-outcome message naming the reconciliation route (chain check at two RPCs after `validBefore + 300 s`, operator act), and never write `refused`. Red-proof in `scripts/pay-listing.test.mjs` (or its existing test file): a stubbed 502 with that code must leave `signing`; the same 502 without the code follows the old branch.

16. **Item 15 refined (CODEX round 3, verified):** the `signing` tombstone written before the sign carries only `{status, key, target, ...purchase}` (`pay-listing.mjs:379-387`), not the authorisation identity, so a later chain reconciliation after the process exits has nothing to ask the chain about. The `settlement_unconfirmed` branch therefore atomically REWRITES the tombstone, still `status: "signing"`, adding `from`, `nonce`, `valid_before` (from `decodeSentAuthorization(paymentHeader)`, `:165-175`) and `http_status`, `unconfirmed_at`, `detail` (the 502 body, bounded), before returning `leg2_unconfirmed`. Red-proof: the rewritten record must classify as `signing` and carry the three authorisation fields; a branch that returns without the rewrite goes red.
