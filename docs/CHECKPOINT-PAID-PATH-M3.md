# Checkpoint log: paid-path wave M3, the choice-free subset (C1, C2, C3, C5, C6, C8)

Branch `m3-paid-path-2026-10-02`, base `678ae407` (`society/` main = live worker `c4ba8c1d`). Builder: Sonnet 5.5. MONEY PATH.
Spec: `drafts/BRIEF-PAID-PATH-M3-2026-10-02.md` with amendments A1-A4 (A1 for C1, A4 for C6). **C4 and C7 are NOT built** (they wait for the
operator's ruling); no C4 marker was invented. Nothing pushed, deployed or written to a network; no `*.local.*` file read.

Base: 1508/1508, tsc 0. Final: 1545/1545, tsc 0 (+37 tests, all in `test/paid-path-m3-d1.test.ts`; every other test change edits an existing test, listed below).
No migration, no new table, column or state: every new condition lives in `verdict_reason`. `git diff 678ae407 -- src/doc.ts migrations schema.sql wrangler.jsonc` is empty;
`test/settlement-replay-served-text-d1.test.ts` test 13 ("non-minting ... template hash fa11788d, v5") and `test/doc.test.ts` are green unchanged.

## How every red-proof below was done

Mutant applied with an exact-once replacement to the COMMITTED code, the target test FILE run ALONE (`node --experimental-strip-types --test test/paid-path-m3-d1.test.ts`),
the failing test names read, then `git checkout -- <file>` and the file's sha256 compared before and after (restored byte-identical in every case) and `git status` clean.
The harness is a throwaway script in the scratchpad (not committed). "Target red" names the tests that went red; a neighbouring guard turning red is listed too, but never counts.

## Commits

| # | sha | what |
|---|---|---|
| 1 | `951eba7a` | C1: contradiction stamp, both branches, both terminal arms (A1) |
| 2 | `1b4b2892` | C2: `settlement_success_unrecorded` line and an answer naming the tx |
| 3 | `cff44c18` | C3: `stepGatedOutByLease`, four sites; pay listing keeps the read-back |
| 4 | `fcbe463b` | C5: reconciler SELECT exclusions and `listing_not_paying` |
| 5 | `2c4827ff` | C5: unit test that the marker is written once, only on settled_unbooked (added after its mutant C5-j came out green) |
| 6 | `502e26d4` | C6: the chain's clock must agree before `expired` (pinned second read), harness `chainRpc` |
| 7 | `3a6ccff9` | C8: the secret-mode citizen step answers from its own batch; the two messages |
| 8 | `2449d0eb` | comments: `DEFERRED-INVITE-REDEEM-TWICE`, `DEFERRED-LATE-LISTING-EXPIRY`, budget note, the C6 shed test |
| 9 | `476be3c3` | C8: the tail keeps its hedge (advisor catch: "it is created" was a promise a repeat cannot keep) |
| 10 | `cc226cc1` | C8: the hedge pinned in the paid-path file (mutant C8-d2 came out green until then) |
| 11 | this one | this checkpoint |

## C1 (A1) `951eba7a`

`markContradiction` is ONE conditional UPDATE: `SET tx = ?, verdict_reason = 'settlement_contradiction:' || tx || '|' || substr(original, 1, 300), updated_at` WHERE the key matches AND
`state IN ('refused','expired')` AND the row is not already stamped (the first contradiction's tx is kept). `recordContradiction` (x402.ts) is the one helper both branches call
(`answerFromMovedClaim` for this request's own /settle, `attemptPending` for a re-send's or the reconciler's re-POST): the existing log line, then the stamp in `quietly()`, so a failed stamp
never changes what the caller is told. `claimAnswer`'s `refused` AND `expired` arms read the marker and serve `contradictionAnswer` (500, `settlement_contradiction`, tx named, "do not sign
again", never `accepts`). `contradictionAnswer` is the same function `contradictionResponse` now serves, so the first answer and every replay cannot drift. `SHOWHOME_REPORT_POINTER` moved to
settlement-claims.ts (the answer needs it; that module imports no route module).

| mutant | target red |
|---|---|
| C1-a stamp call removed | all six replay tests (refused/expired x own /settle, re-send re-POST, reconciler re-POST) |
| C1-b state condition removed from the stamp | "the stamp lands only on a refused or expired row" |
| C1-c expired arm ignores the marker (A1) | the three `expired` replay tests |
| C1-c2 refused arm ignores the marker | the three `refused` replay tests |
| C1-d original reason dropped | both own-/settle replay tests, and the stamp unit test |
| C1-e already-stamped guard removed | the stamp unit test (second tx overwrote the first) |
| C1-f tx not set on the row | both own-/settle replay tests, and the stamp unit test |
| C1-g every terminal row read as contradicted | "C1 control" (an unstamped refused row still answers 402 with accepts; so does an unstamped expired one) |

## C2 `1b4b2892` (P-D reproduced as a committed test, three sites)

`logSettlementSuccessUnrecorded` (error level: tx, payer, resource, amount_atomic, claim_from, claim_nonce, the row's state) at `answerFromMovedClaim`'s pending branch and at
`attemptPending`'s re-read when `moved.state === 'pending'`. `claimAnswer` gains `settledTx`; the answer names the tx and drops "this request changed nothing". The tx is NOT written to the
pending row (asserted: `tx` stays NULL, B keeps its lease). Status stays 502 and the code `settlement_unresolved`. Tests: own /settle, re-send, reconciler; control: an ordinary unknown outcome
still says "changed nothing" and logs no success line.

| mutant | target red |
|---|---|
| C2-a log removed (answerFromMovedClaim) | "C2 (P-D, this request's own /settle)" |
| C2-b log removed (attemptPending) | "C2 (the re-send's re-POST)", "C2 (the reconciler's re-POST)" |
| C2-c answer drops the tx ("changed nothing" restored) | own /settle, re-send |
| C2-d re-read arm returns "another worker moved the claim" again | re-send |
| C2-e tx written to the pending row | own /settle |
| C2-f unknown-outcome answer loses "changed nothing" | "C2 control" |

## C3 `cff44c18` (P-A reproduced per site)

`stepGatedOutByLease(after, ref)`: `after.state === 'settled_unbooked' && refsOf(after)[ref] == null`, called only after a batch that reported `applied: false`. The proof: the other two gate
conditions (state, ref) held when the batch ran (a ref is only ever added, the claim only moves forward) and still hold, so the lease condition is what failed; the answer is the claim's
whatever the lease reads now. Sites: `recordSettledPayment` (ledger; serves patron, registration and listing fee), the register citizen step, the register key_registered step, listing creation.
Pay listing keeps `leaseHeldByAnother` (its INSERT also needs `listings.status = 'paying'`, `src/listings.ts` ~1005). The test window: a DB wrapper runs "B takes the lapsed lease" just before the
step's batch and lapses B's lease just after it (`windowEnv`), so the old read-back reads "nobody holds it". Each site also resumes afterwards (re-send, or the reconciler).

| mutant | target red |
|---|---|
| C3-ledger old read-back restored in `recordSettledPayment` | "C3 ledger step (patron)" |
| C3-citizen old read-back restored | both "C3 citizen step (registration, secret / public-key)" |
| C3-key old read-back restored | "C3 key step (registration, public-key)" |
| C3-listing old read-back restored | "C3 listing step (listing creation)" |
| C3-pay the new rule applied to pay listing | "C3 control: PAY LISTING keeps the lease read-back" |
| C3-helper state check dropped / ref check dropped | "C3: stepGatedOutByLease is true only for ..." (both) |

## C5 `fcbe463b`, `2c4827ff`

SQL: `verdict_reason IS NULL OR verdict_reason NOT IN (handle_taken, listing_not_paying)` (exact constants: a pending row's `verdict_reason` is the facilitator's last words from `noteUnknown` and
must never exclude it), and `NOT (route = 'register' AND state = 'settled_unbooked' AND json_extract(intent_json, '$.public_key') IS NULL)` (a PENDING secret-mode row is still worked). In the loop,
before `finishBooking`, a `listing_pay` row whose listing is not `paying` gets `markListingNotPaying` (settled_unbooked, `verdict_reason IS NULL`, holder-only, clears the lease), one error line
`settlement_listing_not_paying`, and is never selected again. The marker is written only for a settled_unbooked claim: a pending one can still expire or be refused by `attemptPending`. The
exclusion of "every marked row" is the two exact constants; C1 rows are terminal (never selected) and C4 markers do not exist yet. Answers for a marked row: `claimAnswer` serves
`listingNotPayingMessage` (500, `settlement_unresolved`; the payment settled, tx, the listing no longer awaits it, the reconciler has set it aside, do not sign again, no resolution time,
mention @commonhold-agent) and `respondToExistingClaim` never re-attempts it. No reconciler promise is served for it.

| mutant | target red |
|---|---|
| C5-a secret-mode exclusion removed (today's SELECT) | "three rows the reconciler can never finish, older than one real row: one run reaches the real row" |
| C5-b listing_not_paying not excluded | the same test |
| C5-c any reason excludes | "C5 control (pending row whose reason is only the facilitator's last words)" (and three reconciler tests of C1/C2) |
| C5-d the listing check removed | the three-rows test; "a bounty payment whose listing is no longer 'paying' is marked" |
| C5-e the listing check inverted | the three-rows test; the marked test; "C5 control: ... STILL 'paying' is not marked" |
| C5-f respondToExistingClaim re-attempts the marked row | the marked test (replay) |
| C5-g the answer falls back to the generic settled_unbooked text | the marked test |
| C5-h public-key rows excluded too | "C5 control (public-key registration, settled_unbooked)" |
| C5-i a PENDING secret-mode row excluded too | "C5 control (secret-mode registration, still PENDING)" |
| C5-j `verdict_reason IS NULL` guard dropped from the marker | "markListingNotPaying records its reason once" (the test was added because this came out green) |

## C6 (A4) `502e26d4`

`readAuthorizationState(..., { pastTimestamp })`: each RPC is asked for `eth_getBlockByNumber("latest")` (number and timestamp), then `eth_call` AT THAT BLOCK NUMBER on the same RPC. An "unused" answer
from a block whose timestamp is not strictly greater than `pastTimestamp` is lagging: not an answer, the next RPC is tried. "Used" is accepted from any block. `attemptPending` takes the pinned
read ONLY on the branch that would mark `expired` (chain unused at the first read AND wall clock past `valid_before + margin`), so an ordinary poll costs nothing extra (asserted: zero
`eth_getBlockByNumber` calls before the margin and when the chain says used). If the pinned read says used, or disagrees, or has no quorum, the outcome is `unchanged` with a detail; it is never
`expired`. Why a second read and not trust the first: the first read was at a block of unknown time, and an authorisation read unused there could have been mined since.

| mutant | target red |
|---|---|
| C6-a block check removed (a lagging block counts) | "an RPC pair whose latest block is not yet past ... never yields expired", "a lagging RPC is skipped", the worst-case test |
| C6-b boundary `>` to `>=` | the first test (block time exactly validBefore + margin) |
| C6-c confirming eth_call at "latest" | "the confirming read is PINNED", "spent between the two reads" |
| C6-d confirming read dropped | five C6 tests |
| C6-e every poll reads blocks | "C6 (A4): an ordinary poll costs nothing extra" and three more |
| C6-f spent between the reads still marked expired | "an authorisation spent between the two reads is not expired" |
| C6-g wall clock no longer required | "C6 (A4): an ordinary poll costs nothing extra" (and six re-POST tests that now see block calls) |
| C6-h a lagging RPC aborts the read | "a lagging RPC is skipped", the worst-case test |

**Cost tables (read before ruling).** Subrequests, a bad day, patron row, from the measured test: lease 1 + plain read 4 + pinned read 7 + terminal write 1 = 13 (14 with the select).
Typical expiry row: lease 1 + 2 + 4 + 1 = 8 (a listing_pay row 9, its terminal batch has two statements), against about 4 before C6. Worst case: 1 + 4 + 8 + 2 = 15, inside
`RECONCILE_ROW_WORST_CASE = 18`. Consequence, pinned by a test: after an expiry row the loop sees 1 + 8 = 9, and 9 + 18 > `RECONCILE_SUBREQUEST_CEILING` (26), so a SECOND due row is shed to the
next run. Rows that are used / not yet expired are unaffected. **Alternative considered (pin-first):** when the wall clock is already past the margin on entry, make the pinned read THE read
(typical 4 fetches, 8 worst). It would avoid the shed, but a row that is past the margin and USED then goes on to /settle and a full booking with up to 8 RPC fetches instead of 4: a public-key
registration's worst case becomes 20 > the priced 18, so `RECONCILE_ROW_WORST_CASE` (and with it the `left` and ceiling arithmetic in `scheduled()`) would have to be re-priced, and it fetches blocks
on a poll A4 says must cost nothing extra. I kept the A4 letter and the budget invariant, and flag the shed for the gate to rule on.

## C8 `3a6ccff9`, `476be3c3`, `cc226cc1`

`runBookingStep` returns `{ applied, rowId? }`: `rowId` is the D1 `meta.last_row_id` of the LAST statement of the step's own list (the row-creating statement whose id the claim records via
`last_insert_rowid()`), only when the step applied and the id is a positive safe integer. The secret-mode citizen step (which IS the final step) takes `citizenId` from it with no read-back; a missing
id falls back to the read-back as before. Public-key mode is unchanged (its citizen step is not final and still reads back). Two served strings reworded (below).

| mutant | target red |
|---|---|
| C8-a read-back restored after the secret-mode step | "a read-back that FAILS after the committed final secret-mode step still yields the 201" |
| C8-b `runBookingStep` reports no row id | the same, and "runBookingStep reports the id the row-creating statement reported" |
| C8-c a stale id reported for a gated-out step | "runBookingStep reports the id ..." |
| C8-d the tail promises a fresh secret again | "D1 commits the citizen batch and still throws" |
| C8-d2 the hedge dropped ("it is created") | the same (red only after the hedge assertion was added in `cc226cc1`) |
| C8-e `SECRET_LOST_NOTE` says a response was issued again | "the booked-claim answer for a secret registration makes no claim about a response having been issued" |

## Served strings changed or added (old -> new)

1. C1, a replay of a stamped refused/expired claim. Old: 402 with `accepts`, "By its account no money moved" / "Nothing was charged. Sign a fresh one." New: the existing contradiction answer verbatim
   (500, "The facilitator reported this payment settled (tx ...), but the society's own record ... reads \"refused\"|\"expired\", which contradicts it. The money may have moved ... Do not sign
   again. This is logged for the maintainer ..."). One edit to that text: an empty facilitator tx now prints "(tx not reported)" instead of "(tx )".
2. C2, pending answer when this call holds a success verdict. Old: "...whether the money moved is not yet established. Do not sign again; this request changed nothing." New (only then): "The
   facilitator reported this payment settled (tx T), but this request could not record that: the society's own record of it is still pending, and another attempt held it when this request tried to
   write. By the facilitator's account this payment has already moved. Do not sign again." followed by the same lease/detail/reconcile tail. The ordinary unknown-outcome answer is unchanged.
3. C5, new: `listingNotPayingMessage` (see C5). The settled_unbooked answer for such a row replaces the generic one that carried the reconciler backstop.
4. C6, new `detail` strings served in the pending answer: "The wall clock says this authorisation has expired, but the chain's own clock has not confirmed it (<reason>); nothing was changed." and
   "The authorisation was spent while the society was confirming its expiry; the next attempt re-checks it as used." The no-quorum reason now also says how many RPCs answered "unused" from a block
   not yet past the expiry. In the C2 re-read case `detail` is now empty (it was "another worker moved the claim").
5. C8, `SECRET_LOST_NOTE`. Old: "your seat exists; a response containing its secret was issued, but the secret cannot be recovered. Reach the maintainer ...". New: "your seat exists; its secret was
   generated once, for the response to the request that registered it, and cannot be recovered. If that response did not reach you, the secret is lost: reach the maintainer ...".
6. C8, the secret-mode paid-but-failed tail (register-gate.ts). Old: "Repeating this identical request re-attempts it without a second charge and, if it completes, hands you a fresh secret." New:
   "Repeating this identical request checks it again without a second charge: if no seat was created, the repeat attempts to create it and, if that succeeds, hands you its secret; if a seat was
   already created before this error, the repeat tells you so, and that seat's secret cannot be recovered."
C3 changes WHICH answer is served (the claim's, not a booking failure) but no string.

## Existing tests moved on purpose (all other tests are untouched)

- H2 x4 (`settlement-replay-lease-d1`): the claim is now stamped, so they expect `tx` = the facilitator's tx and the marker (they asserted `tx` NULL). Titles say "stamped".
- `post-payment-pointer` M1: counts the one `SHOWHOME_REPORT_POINTER` literal in settlement-claims.ts and that x402.ts interpolates it (it counted it in x402.ts).
- Fourteen assertions in `settlement-claims-d1` and `settlement-replay-lease-d1` that did `deepEqual(runBookingStep(...), { applied: X })` now assert `.applied` (the result gained `rowId`).
- `settlement-replay-routes-d1` B5d: matches the new note and asserts it never says "was issued". `x402-post-payment-honesty-d1` `hubNoKey`: the new tail, verbatim.
- `secret-literal-guard`: two PROSE_ALLOW entries re-keyed, none added or removed. **D-061 baseline: 76 / 23 / 53 at base and at the end, unmoved.** Re-keyed: `a6c0e9a1...` to `81203a44...`
  (`SECRET_LOST_NOTE`), `337c602c...` to `574033562ec2...` (the register-gate tail; an intermediate `1464249d...` was discarded when the hedge was restored).
- Harness (`test/helpers/settlement-harness.ts`): a stub's `rpc` callback now receives the request; `blockAnswer` and `chainRpc` answer both reads; `rpcCalls` records method and params. A stub
  written for `eth_call` alone (it returns an authorizationState word for every request) is answered for the block read with a block stamped now, which is past every test's `validBefore`, so
  every pre-existing expiry test exercises the pinned path and keeps meaning what it meant.

## Findings and deviations (file:line at this branch)

1. **Pre-existing, narrowed not closed:** `finishPayListing`'s INSERT gate (`src/listings.ts:1010`, `EXISTS (SELECT 1 FROM listings WHERE id = ? AND status = 'paying')`) and C5's own check test `status = 'paying'`
   only, not that the reservation is THIS claim's (`paying_wallet_row_id` / `paying_since <= created_at`, the F2 release conditions, `settlement-claims.ts` `listingReleaseStatement`). A stale
   settled_unbooked listing_pay claim could be booked against a LATER payer's reservation if the operator released by hand and someone else reserved before the reconciler met it. C5's marker closes
   it from the first meeting on; the window before that needs a ruling.
2. C1 stamps `tx = ''` when the facilitator's success carries no `transaction` (`classifySettle` gives `""`, `src/x402.ts:359`): the column holds an empty string, not NULL. `contradictionAnswer` prints "not reported".
3. `recordSettledPayment`'s not-applied path (`src/x402.ts:1080`) now answers from the claim for every settled_unbooked / ledger-unrecorded case regardless of the lease. Sound by the gate's own
   argument (state, ref and lease are the whole gate), and C3's tests cover the lapse window; stated here because it removes a throw that used to exist.
4. **C8 depends on D1 reporting `meta.last_row_id` per statement inside a batch** (the local shim does, `test/helpers/local-d1.ts` batch). If D1 reports nothing usable the code falls back to the
   read-back (safe). A WRONG positive id would put a wrong `citizen_id` in the 201: the gate should rehearse this on a scratch D1 (an INSERT ... SELECT in a batch) before the deploy.
5. The brief's C5 "exclude every marked row" is implemented as the two exact constants (see C5). C4/C7 markers do not exist and were not invented.
6. The brief's line citations for C2, C3, C5, C6, C8 all matched the code (`x402.ts` 823/906/1029-1034/871, `register-gate.ts` 379-383/419/484, `listings.ts` 510/1017, `settlement-reconcile.ts` 135-138,
   `settlement-claims.ts` 455-456). `test/secret-literal-guard.test.ts` line 29's header still says 66/22/44/43; the asserted baseline is 76/23/53 (stale since before this wave, untouched).

## Open questions for the gate and the operator

1. C6 cost shape: keep the A4-letter double read (shed a second due row after an expiry; budget invariant intact) or pin-first with `RECONCILE_ROW_WORST_CASE` re-priced to about 22. See the cost tables.
2. The stale-claim-versus-later-reservation window (finding 1): close it in C5 (bind the booking gate to the claim's own reservation) or accept until the first meeting?
3. Real D1 `meta.last_row_id` per batch statement (finding 4): rehearse before deploy.
4. C4 (option A or B) and C7 (route, `from_addr`, age N) still need the operator's rulings; C1's stamped rows and C5's `listing_not_paying` rows are exactly what C7's list will show.

---

# Second build (branch `m3-second-build-2026-10-04`, off the gate-clear first build `a580b9c3`)

Commission `drafts/BUILDER-COMMISSION-M3-SECOND-BUILD-2026-10-04.md`; operative spec = the brief's "Amendments after CODEX r2", then Ben's option-B ruling, then CODEX r1, then C2-C8. Tests live in
`test/paid-path-m3b-d1.test.ts` (new); red-proofs are done with the target file run alone (mutants listed per commit; the runner restored each file byte-identical, sha checked).
Baseline at `a580b9c3`: 1557/1557, tsc 0. Working-tree note: this checkout is CRLF (core.autocrlf true, the index stores LF); a bare `sed -i` converted one file to LF mid-session and it was put back.

## S1. C4 option B, A3, R2-3 (stopped-row answer), reconciler exclusion

What: a PENDING claim whose authorisation the chain reads used, while the facilitator answers a recorded refusal on the re-POST path, is STAMPED (`markChainSpent`,
`verdict_reason = 'chain_spent_facilitator_refused:' + the facilitator's words, clipped to 300`) and STOPPED. No new state, no migration. `attemptPending` returns the new outcome `stopped`
(distinct from `unchanged`) after the stamp, logs one `settlement_chain_spent_stopped` error line, and returns early (no fetch, no write) on a row that already carries the marker.
`noteUnknown` gained `AND (verdict_reason IS NULL OR substr(verdict_reason, 1, ?) <> ?)`; the reconciler's SELECT excludes the marker's prefix the same way and counts the outcome in a new
`ReconcileResult.stopped` (the stamp clears the lease, so no release is paid). `respondToExistingClaim` answers a stopped row before taking any lease (a replay writes nothing).
Decision: `substr`, not `LIKE`: the brief's A3 text says `NOT LIKE '<marker prefix>%'`, but the marker contains underscores, which LIKE reads as single-character wildcards. The stamp is conditional on
`state = 'pending'` and on the row not already carrying the marker, so the first reason is kept. The marker is read from `state === 'pending'` only (a row in any other state never counts as stopped).
Deviation from the brief's wording: none in behaviour. `DEFERRED-C4-OPTION-A-RECEIPT` is planted at the stamp (x402.ts attemptPending, and the marker's comment); `DEFERRED-DURABLE-HELD-SUCCESS` is planted
at `holdSuccessAgainstTerminal` naming R2-2's six requirements.

| mutant | red in |
|---|---|
| noteUnknown without the marker guard | "noteUnknown never overwrites a marker" |
| attemptPending without the early return on a marked row | "attemptPending returns early on a marked row" |
| the stamp replaced by the old `unchanged` outcome | stamp test, reconciler test, R2-3 test |
| reconciler SELECT without the prefix exclusion | "the reconciler stamps the row once and never selects it again" |
| respondToExistingClaim without the pre-lease short-circuit | R2-3 test (the replay moved `updated_at`) |
| claimAnswer without the stopped arm | R2-3 test |
| markChainSpent without the `state = 'pending'` condition | "markChainSpent stamps only a pending row" |

Served strings (old -> new): the pending answer for a stopped row. Old: "The outcome of this payment is still unknown...: the settle request was sent and whether the money moved is not yet established. Do not sign again;
this request changed nothing. <reconciler tail>" (plus the old `detail` "The chain shows this authorisation spent, but the facilitator reports a refusal. The answers contradict; the claim is left pending for a person
to decide."). New (500, `settlement_unresolved`): "The chain shows the signed authorisation for <what> was used (spent, or cancelled by its signer), so the money may have moved: whether it did is not
established, and the society cannot tell which transaction used it. The society has stopped retrying this payment automatically. A person will check it against the chain by hand; no resolution time is
promised. Do not sign again. To add your own report, <mention @commonhold-agent in a comment naming this nonce | leave a free showhome note naming this nonce> (...)." It carries no reconciler tail, no repeat
instruction, no `accepts`, and none of the facilitator's words. "Spent, or cancelled" is deliberate (gate INFO-3: `authorizationState` is true for a cancelled authorisation as well).
Existing test moved on purpose: `settlement-replay-reconcile-d1` 7e (the refusal leg now expects `stopped` 1 / `unchanged` 0; the unknown-outcome leg is unchanged).

## S2. H2 (replaces L6): a re-POST refusal while the chain reads UNUSED never marks the claim refused

What: in `attemptPending` the rule-7 branch with `chain.used === false` no longer calls `markRefused`. It records the facilitator's words as the claim's last words (`noteUnknown`, which also lets go of the lease) and
returns `unchanged` with a detail that names the refusal. The `refused` variant of `AttemptOutcome` is gone (nothing returns it); the reconciler no longer counts a refusal as `resolved`. The claim resolves through the chain
showing the nonce used (booked, or S1's stamp) or C6's pinned unused-after-expiry proof (`expired`, which releases a pay-listing reservation in the same batch). `payAndSettle`'s first `/settle` is untouched and still
honours a rule-7 refusal at once. `markRefused`'s `release` parameter now has no production caller (the pay route's own path releases itself, the re-send/reconciler refusal path is gone); it is kept for the tests that drive a
refusal by hand (H1) and for a future caller.
Decision: the detail is served to the payer inside the pending answer: the facilitator's own verdict text (the same text the first /settle already quotes in its 402) plus one sentence saying why it is not acted on.

| mutant | red in |
|---|---|
| the re-POST refusal marks the claim refused again | all four H2 tests (state, interleaving, re-send, reconciler) |
| no `noteUnknown` (lease left held) | the unit test and the interleaving test |
| the first `/settle` no longer honours a refusal | the H2 control |

Served string (old -> new). Old, the payer's re-send after an unused-chain refusal: 402 `{error: "The facilitator reports that this settlement failed (HTTP 200, reason: X). By its account no money moved.", accepts}`. New: 502 `settlement_unresolved`,
"The outcome of this payment is still unknown: ... Do not sign again; this request changed nothing. <verdict text> It is not acted on: the chain still reads this authorisation unused, so an earlier attempt's transfer may yet be
mined and a refusal now could be wrong. The claim stays pending until the chain shows the authorisation used or provably expired. <reconciler tail>".
Existing tests moved on purpose: `settlement-replay-reconcile-d1` 7d (refused leg: pending, unchanged, 502 on the re-send); `settlement-replay-fixes-d1` F2 refused (now: pending, reservation kept, released by the expiry proof);
`settlement-replay-lease-d1` T6 refused (the holder's own attempt reports `unchanged`, claim pending).

## S3. R2-1 (HIGH, pre-existing): the first attempt's refusal is bound to its take time

What: `payAndSettle` captures `takenAt` once, passes it to `takeClaim` (it becomes the claim's `created_at` and `updated_at`) and to the first-attempt `markRefused`, which gained an optional `takenAt` and a conditional
`AND updated_at = ?`. Every other holder's attempt moves `updated_at` (`acquireLease` and `noteUnknown` both set it, and `acquireLease` acts only after the lease lapsed), so a refusal that lands after another attempt
started writes nothing; the existing re-read then answers from the claim (pending: the unknown-outcome answer, reservation kept), never a 402. No migration, no other caller changes (the argument is optional).
CODEX's interleaving is pinned for a patron claim and for pay listing (A's /settle in flight; B, with a clock past A's lease, acquires, re-POSTs, meets an unknown outcome, `noteUnknown` clears the lease; A's refusal then
lands): not 402, no `accepts`, claim pending, listing still `paying`. Both were red on the unchanged code (402 with accepts for the patron; the listing released for the pay route).
Test detail: B's writes use a clock 400 s ahead of A's, so `updated_at` differs deterministically (in production the 180 s lease lapse alone guarantees it).

| mutant | red in |
|---|---|
| `markRefused`'s `updated_at` condition made vacuous | both interleavings and the unit test |
| `payAndSettle` stops passing the take time | both interleavings |

Served strings: none changed (the answer is the existing pending one).
