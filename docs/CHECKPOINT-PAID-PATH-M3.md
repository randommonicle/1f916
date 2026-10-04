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

## S4. M4: the validBefore bound

What: `payAndSettle`, for a claim-bearing route and right after `claimKeyFromPayload` (so before `/verify`, before any reservation, before any claim), refuses an authorisation whose
`validBefore > now + PAYMENT_MAX_TIMEOUT_SECONDS (300) + PAYMENT_VALID_BEFORE_SKEW_SECONDS (60)`: 402 with `accepts`, code `payment_valid_before_too_far`, naming the latest accepted value. It is an upper bound only
(a validBefore in the past is still the facilitator's and the chain's to judge). It bounds NEW claims; a claim admitted before this existed is answered from its row (`replayForClaim` runs first) and the attention list's
`pending_aged` marker (S7) covers any that outlive N days. Both constants are exported next to `PAYMENT_MAX_TIMEOUT_SECONDS`.
Harness: `test/helpers/x402-payload.ts` `paymentHeaderFor` defaulted `validBefore` to `"9999999999"`, which M4 rightly refuses; its default is now `now + 300` (the window the requirements declare). No existing test changed
meaning: the full suite stayed green with only that default moved (tests that seed claims directly choose their own validBefore). The operator scripts already sign `now + maxTimeoutSeconds` from the server's requirements.

| mutant | red in |
|---|---|
| the bound removed | both refusal tests (patron, pay listing) |
| the bound off by a day | both refusal tests |
| the bound also refusing a long-past validBefore | "just inside the bound is accepted ... past ... still the facilitator's to judge" |

Served string, new: 402 "This payment authorisation's validBefore (T) is further ahead than this server accepts. It must be no later than B (unix seconds, from now): the 300 seconds the payment requirements declare, plus 60
seconds for clock skew. Nothing was sent to the facilitator and nothing was charged. Sign a fresh authorisation with a validBefore inside that bound." Before: no such refusal (any validBefore was admitted).
The reconciler re-measurement the commission lists under M4 is S8 (nothing in M4 adds a statement or a fetch to a reconciler row: the check is a comparison).

## S5. H3 + gate MEDIUM-1 + the booking-reservation binding + gate LOW-2

What, in four parts.
1. THE BINDING (which one, as the commission asks): the one the code already had, F2's release (`listingReleaseStatement`): the listing is `paying`, unpaid, records THIS claim's pinned wallet row (id and hash from the
   claim's intent), and `paying_since <= claim.created_at` (a reservation is always taken before its claim in the same request, so a later `paying_since` is another payer's). It is now ONE exported fragment,
   `RESERVATION_BOUND` + `reservationArgs(row)` in `settlement-claims.ts`, and the release statement was refactored onto it (behaviour unchanged: the F2 tests stayed green). It is used by: the release, the booking INSERT's
   `EXISTS`, the booking `UPDATE listings`, C5's check in the reconciler, and the new pre-re-POST check, via `listingReservationState(env, row)` (one read: status and `bound`). Closes this checkpoint's open question 2 and the
   gate's MEDIUM-1 binding requirement (lines 68-71 of the gate record). The `DEFERRED-BOOKING-RESERVATION-BINDING` flag is removed.
2. PRE-RE-POST CHECK (`attemptPending`, listing_pay only, after the expiry branches and before the body is parsed or `/settle` is called): not bound and the chain reads USED -> stamped and stopped (S1's marker, via a new
   `stopPending` helper that the rule-7 branch now shares); not bound and unused -> `unchanged`, no `/settle`, the claim waits for C6's expiry proof (whose F2 release is bound the same way, so a replacement payer's reservation is
   never released by it). Cost: one D1 read for a listing_pay row.
   Decision to flag: the stamp for "chain used + listing not holding the reservation" reuses the marker `chain_spent_facilitator_refused` (the allowlist is fixed), though no facilitator refusal is involved. The served text for a
   stopped row says only what is established (the chain reads the nonce used; retries stopped; a person will look), so it is true for both causes; the stored reason after the colon names the real one.
3. `takeClaim` THAT THROWS (`payAndSettle`): the claim is re-read. No row: today's 503 and release. Our row (its `lease_owner` is this request's owner: the INSERT landed): the reservation is KEPT, our own lease is released, the answer
   is a 502 `settlement_unresolved` saying the claim exists and nothing was sent. Another request's row: answered from it as a key conflict is (no keepReservation, as before). The re-read throws too: the reservation is KEPT (fail closed:
   only a proven absence of the row may release) with a 503 `settlement_claim_unavailable` that says the society could not confirm. Decision: the gate offered "proceed as its holder" or "answer from it"; the commission says answer from
   it, which is what is built (it is the smaller change; the claim then resolves through the reconciler's expiry proof, or, for a route with no reservation, the payer's identical re-send).
4. GATE LOW-2: `finishPayListing`'s booking-failure 500 now branches on `listingReservationState`: not bound -> `listingNotPayingMessage(row, "will")` (the C5 text with the tense fixed: the reconciler WILL set it aside when it next
   meets it; it used to promise the daily pass that works the claim); bound (a transient failure) -> the unchanged backstop text; a read that fails -> the backstop. The 500's code is `settlement_unresolved` in the new branch.

Tests (`test/paid-path-m3b-d1.test.ts`): INSERT commits then throws (pay listing: reservation kept, 0 `/settle`, 502, lease released, one log line; re-read also throws: 503, kept; patron: 502 with the repeat clause and the re-send
completes the payment once; the no-row control still releases); old pending claim against a re-opened listing and against a replacement reservation, chain unused (re-send and reconciler: 0 further `/settle`, claim pending, listing
untouched) and chain used (stamped, 0 further `/settle`); the in-reservation control (re-POSTed and booked); `listingReservationState` unit; a settled_unbooked claim is never booked against a later reservation (INSERT gate) and C5 sets it
aside; the booking control; LOW-2 both branches.

| mutant | red in |
|---|---|
| the catch never keeps the reservation for our own row | both INSERT-commits-then-throws tests |
| the catch releases when the re-read throws | the unreadable-claim test |
| no pre-re-POST check | all four stranded-claim tests |
| unbound + used does not stamp | both chain-used tests |
| booking INSERT gated on `status = 'paying'` only | the never-booked-against-a-later-reservation test |
| C5's check on status only | the C5 same-binding test |
| LOW-2 always serves the backstop | the LOW-2 test |
| the binding without the `paying_since` order | five tests |
| the binding without the pinned wallet row | the unit test |

Not independently red-proofable: the binding on the booking `UPDATE listings`. It sits in the same D1 batch as the INSERT and is guarded by `changes() = 1` from the INSERT, so the INSERT's gate already stops it and no test can make
the UPDATE's own condition decisive (defence in depth, the same stance as before). Stated rather than hidden.

Served strings (old -> new):
- claim-INSERT throw with the row present and ours. Old: 503 "The society could not record a claim for this payment (a database error), so nothing was sent to the facilitator's /settle and nothing was charged. Nothing was reserved or created by
  this request. Try again later: the same signed authorisation has not been used." (false: the claim exists; the reservation was released). New: 502 "The society recorded a claim for this payment authorisation but could not confirm that it had
  (a database error). Nothing was sent to the facilitator's /settle by this request, so by this request's own account no money moved. Do not sign again. [listing_pay: The listing stays reserved for this payment until the claim resolves: an
  authorisation nobody uses lapses within minutes, after which the reconciler can release the listing.] <reconcile tail>".
- claim-INSERT throw, re-read throws. New: 503 "The society could not confirm whether a claim for this payment authorisation was recorded (a database error), so nothing was sent to the facilitator's /settle by this request and it charged
  nothing. [listing_pay: The listing stays reserved, because releasing it could re-open it under a claim that does exist.] Do not sign again: this is logged for the maintainer to resolve." The no-row answer is the old text, unchanged.
- pending answer's detail for an unbound listing_pay claim, new: "This payment's listing (<status>) no longer holds the reservation this claim was made under, so the society does not re-send the authorisation to the facilitator. The claim waits
  until the chain shows the authorisation used or provably expired."
- `finishPayListing` 500 when the listing no longer holds the reservation. Old: "Your payment settled (tx T) but recording it failed. This is logged for the maintainer ... <RECONCILE_BACKSTOP> To add your own report ...". New (500,
  `settlement_unresolved`): the C5 text with a future tense, "Your $X payment settled (tx T), but the listing it was paid against (listing N) is no longer awaiting this payment, so the society cannot record it against that listing, and its reconciler
  will set it aside when it next meets it rather than retry it. Do not sign again: ..."; the transient-failure text is unchanged. The thrown (logged) message "...or the listing is no longer paying" became "...or the listing no longer holds this
  payment's reservation".
Existing tests moved on purpose: `paid-path-m3-d1` "C3 control: PAY LISTING keeps the lease read-back" and `settlement-replay-listings-d1` 10d (both asserted /recording it failed/ for a released listing; they now assert the LOW-2 text).

## S6. C7 and R2-3: GET /api/settlements/attention, and the count in /api/official

What: a public read of the claims a person must look at. New LEAF module `src/settlement-attention.ts` (no runtime imports, so `officialFacts` in `society.ts` can use it without a cycle with `settlement-claims.ts`, which imports
`society.ts`). The four markers the claim table carries (`CLAIM_HANDLE_TAKEN`, `CLAIM_LISTING_NOT_PAYING`, `CONTRADICTION_MARKER`, `CHAIN_SPENT_MARKER`) are DEFINED there and re-exported by `settlement-claims.ts`, so the writers and
the one reader share one definition (no call site changed). Allowlist and selection together (R2-3), one marker per row in this priority: `settlement_contradiction` (refused or expired rows carrying the C1 stamp),
`chain_spent_facilitator_refused` (pending rows carrying S1's stamp), `listing_not_paying`, `registration_handle_taken` (settled_unbooked rows carrying the F1 reason), then `settled_unbooked_aged` and `pending_aged` (rows whose
`created_at` is more than N days old in that state and that carry no more specific marker). N is one constant, `ATTENTION_AGED_DAYS = 3` (the brief's suggested value; the brief left the choice to the build, so it is reported).
Fields: `route`, `state`, `marker`, `tx` (null when none is known or the stamp stored an empty one), `created_at`, `updated_at`, `nonce`. The marker is derived inside the SQL, so `verdict_reason` is never selected out of the query
(M5: the facilitator's words, kept inside the C1 and C4 stamps, cannot reach the list); there is no `SELECT *` on this path. At most `ATTENTION_LIMIT = 500` rows.
`/api/official` gains `economy.settlements_attention` (the route) and `economy.settlements_awaiting_a_person` (the number of rows the list returns: the same function). Route added to `discovery.ts` ROUTES with its `grepFor`; the drift guards,
the completeness checks and the 404 text all stayed green. The stopped-row answer (S1) now ends its status sentence with "It is listed at GET /api/settlements/attention."
Non-minting: the front-door template is untouched; `/api/official` is outside the hashed template and the non-minting test stayed green.

| mutant | red in |
|---|---|
| the contradiction branch lists every terminal row | "each marker appears ... and only those" |
| the served note names the payer address | the forbidden-fields grep |
| the `pending_aged` branch removed | the marker test and the grep test |
| the age line a tenth of N days | the age-boundary and one-marker-per-row test |
| the `/api/official` count not the list's | the official-count test |
| the route not served | five C7 tests |
| the stopped answer not pointing at the list | the discovery/pointer test |

Served text (new): the response's `note` ("The settlement claims a person must look at ... This list is the maintainer's queue, not a promise: no resolution time is promised for any row on it. ... Rows carry no wallet address and no request
content; only the fields listed here are served."), a `markers` object explaining each of the six codes (the meanings are in `ATTENTION_MARKER_MEANINGS`; the chain-spent one says "spent, or cancelled by its signer" and covers both the facilitator
refusal and the listing that no longer holds the reservation), and the discovery description. No em dashes (a test checks the served JSON). The forbidden-fields test greps the WHOLE response, case-insensitively, for `rpc_body`, `intent_json`,
`from_addr`, `payer`, `verdict_reason`, a sentinel facilitator refusal, the test payer's address, a sentinel intent handle, `paymentPayload`, `signature` and `commonhold_sk_`; the served note deliberately avoids the word "payer" so that grep can be strict.

## S7. R2-4 (and the M4 re-measure): the reconciler's per-row worst case under option B

What: nothing in the code changes; the measurement is pinned. `test/paid-path-m3b-d1.test.ts` "R2-4" drives seven row shapes through the real `runReconciler` on the worst RPC day (every even-numbered RPC fetch fails, so the plain read's
two-RPC quorum takes FOUR attempts) and pins each row's measured cost (the select taken off): pay listing pending, bound, re-POST settles, booked 13; unbound with the chain used, stamped 7; bound, chain used, refusal, stamped 8; bound, chain
unused, H2 refusal, noted 9; settled_unbooked and not the claim's, set aside 3; a patron refusal with the chain used, stamped 7; a pay-listing row whose `markSettled` throws, priced at its 4 statements plus `ATTEMPT_FETCH_WORST_CASE` 12 = 16.
Every one is inside `RECONCILE_ROW_WORST_CASE = 18`, so no constant changed: 18, the ceiling 26, the two-row batch, `ATTEMPT_FETCH_WORST_CASE = 12`. H3's reservation read is a statement, not a fetch, and it sits AFTER the expiry branches (which
carry the 12-fetch worst case and return before it). M4's bound is a comparison and the stopped marker is a SELECT predicate: neither adds a statement or a fetch. The registration row (16 + 2 for a chain-head retry) is still the largest. The itemised note
in `settlement-reconcile.ts` was extended with these numbers.

| mutant | red in |
|---|---|
| a duplicate reservation read added to the pre-re-POST check | the pinned costs |
| `RECONCILE_ROW_WORST_CASE` lowered to 12 | the ceiling assertion |
| `noteUnknown` dropped from the H2 branch | the H2 tests and the pinned cost |

## Second build: close-out

Commits (oldest first, off `a580b9c3`): S1 `722a350c`, S2 `b2008122`, S3 `e97481ef`, S4 `53874368`, S5 `6ee716f2`, S6 `6f56025d`, S7 (this commit). Suite 1557 -> 1596 (+39 new in `test/paid-path-m3b-d1.test.ts`, 0 removed), tsc 0, no migration.
D-061 baseline (`secret-literal-guard`): 76 / 23 / 53, unmoved (no PROSE_ALLOW entry re-keyed or added). The non-minting test and the discovery drift guards stayed green.

Deferred flags: planted `DEFERRED-C4-OPTION-A-RECEIPT` (x402.ts `attemptPending`'s stamp, and the marker's definition comment in settlement-claims.ts) and `DEFERRED-DURABLE-HELD-SUCCESS` (x402.ts `holdSuccessAgainstTerminal`, naming R2-2's six
requirements). Removed `DEFERRED-BOOKING-RESERVATION-BINDING` (listings.ts; discharged in S5; its name no longer appears in src or test).

Existing tests moved on purpose (every other test is untouched): `settlement-replay-reconcile-d1` 7d (refused leg) and 7e (refusal leg counts `stopped`); `settlement-replay-fixes-d1` F2 refused; `settlement-replay-lease-d1` T6 refused;
`paid-path-m3-d1` "C3 control: PAY LISTING keeps the lease read-back" and `settlement-replay-listings-d1` 10d (the LOW-2 text). Harness: `test/helpers/x402-payload.ts` default `validBefore` is now `now + 300`.

Findings and deviations for the gate:
1. C4's marker name over-reads for one cause. `chain_spent_facilitator_refused` also stamps "chain used and the listing no longer holds the reservation" (no facilitator refusal; H3 as the commission words it). The allowlist is fixed, so the
   served text states only what is established (S1, S6); the stored reason after the colon names the real cause. A person reading the list sees one code for two causes.
2. The takeClaim re-read answers from the claim (the commission's wording) instead of proceeding as the claim's holder (the gate's other option). A pay-listing claim taken this way waits for the expiry proof (and the reconciler's next daily pass) before
   its listing can be paid again; the answer says so. A route with no reservation lets the payer's identical re-send finish it at once.
3. The booking `UPDATE listings`' binding cannot be red-proofed on its own (same batch, same condition as the INSERT that guards it through `changes() = 1`); it is defence in depth.
4. `markRefused`'s `release` parameter has no production caller left (H2 removed the re-send/reconciler refusal). Kept for the tests that drive a refusal by hand (H1) and as a hook; harmless.
5. M4 bounds NEW claims only. A pending claim admitted before it keeps its far `validBefore`; `pending_aged` (3 days) puts it on the attention list. A claim whose authorisation is valid for years can still wait years for the expiry proof.
6. `settled_unbooked_aged` lists a secret-mode registration whose payer never came back to re-send (by design it waits for them); after 3 days it is on the maintainer's list. That is the intent of "older than N days", stated because the row is not a fault.
7. Not done, by instruction: durable success evidence (R2-2), option A's receipt-level Transfer check, any migration.

Close-out addendum (after `9798cefc`, which is the last code and test commit; S7 above says "this commit" for the R2-4 pin, it is `9798cefc`). Further findings for the gate:

8. H3's reservation read sits BEFORE `/settle`. A release that lands between that read and the settle still lets a re-POST move money for a listing nobody holds; C5 catches it afterwards (and the booking INSERT's gate refuses it). The window narrowed from "always" to that gap; it did not close.
9. `officialFacts` now runs one extra D1 statement for every caller: GET /, /api/official, llms.txt, the discovery surface and both MCP doors' official tool. This is request-path load on the busiest read, not the scheduled budget; the claim table is small and the query is one scan.
10. Sharpening finding 5: a pending listing_pay claim admitted before M4, whose listing is unbound and whose authorisation is unused, is selected by the reconciler every day (it returns `unchanged`, costing a lease and a read) until its far `validBefore` proves expiry. That is a "takes a slot until expiry" shape C5 did not foresee;
    `pending_aged` surfaces it after three days and a person resolves it by hand.
11. `scripts/pay-listing.mjs` was not re-run against, and its classification of, the new 502 `settlement_unresolved` from the takeClaim catch was not read. Its retry rule (re-sign only after validBefore + 300 s with the nonce unused at a two-RPC quorum) is safe by construction, but the body's handling there is unverified.
12. Working tree: every touched file is CRLF (this checkout's autocrlf convention); the index stores LF. Checked with `git ls-files --eol` at the end; one bare `sed -i` had converted `src/x402.ts` to LF mid-session and it was put back. No em dash was added to any `src` line.

## S8. Follow-up 1 (CODEX second-build r1 LOW): `pay-listing.mjs` no longer says the server "did not take" the payment

What: the non-200 branch of `scripts/pay-listing.mjs` (reason `leg2_refused`) opened "The server did not take the payment (HTTP n, code)"; neither a 502 `settlement_unresolved` nor an unused-nonce reading establishes that. It now opens
"The server did not confirm the payment (HTTP n, code)"; the rest of the message (unused as of this check, not yet proof nothing was paid, re-run only after validBefore + margin and only if the chain still shows it unused) is unchanged.
Tests (`test/pay-listing.test.ts`): the 502 `settlement_unresolved` test and the 402 test each pin the new opening (`startsWith`) and that "did not take the payment" is absent. Both were red against the old opening, green after.
Served string, old -> new (operator script output, not a served surface): "The server did not take the payment (HTTP 402) ..." -> "The server did not confirm the payment (HTTP 402) ...".

## S9. Follow-up 2 (CODEX second-build r1 MEDIUM): C7 no longer hides rows beyond the page size

What: `ATTENTION_LIMIT` (500) was a silent cap: the oldest 500 rows, no cursor, no signal, and `/api/official`'s `settlements_awaiting_a_person` counted that capped list. Now it is a PAGE size.
`GET /api/settlements/attention?after=<created_at>:<nonce>` returns the rows strictly after that cursor in the existing order (`created_at > ? OR (created_at = ? AND nonce > ?)`); a string that is not exactly
`/^\d+:0x[0-9a-f]{64}$/` (digits capped at 16 so it is a safe integer) answers 400 "after must be the next value of a previous response ...". The page fetches `LIMIT + 1` to learn `has_more`; `next` is the last returned row's
`<created_at>:<nonce>` when `has_more`, else null. `total` is a `COUNT(*)` over the same marked selection (one `MARKED` subquery and one bindings function shared by the page and the count, so they cannot drift); `count` stays the rows in this
response; `limit` is served. `/api/official`'s `settlements_awaiting_a_person` is now `total` (the same `attentionTotal`), not the page length. The served note, the `ATTENTION_LIMIT` comment and the discovery entry (description and a
`queryParams` entry for `after`) say the list is paged. The leaf module stays import-free: it returns `null` for a bad cursor and `index.ts` throws the 400. Reconciler budget untouched (this is a request-path read).
Tests: 501 eligible rows (pairs share a `created_at`, so the tie-break is exercised): page one 500, `has_more`, `total` 501, `next` set; `?after=next` returns the 501st, `has_more` false, `next` null, the pages together are 501 distinct
rows strictly ascending; `/api/official` 501 while the page count is 500 (red before: the 500 page had no `has_more`, `total` or `after`); a short list has `has_more` false and `next` null, a cursor past the end answers an empty page,
a cursor on the first row returns only the second; twelve malformed cursors answer 400 and no rows, a well-formed one 200; the note and discovery entry say it is paged; the first C7 test now also pins `total` against ineligible rows.

| mutant | red in |
|---|---|
| no `LIMIT + 1` (`has_more` never true) | the 501-row test |
| the cursor not strict on `created_at` | the 501-row test and the short-list/cursor test |
| `/api/official` count capped at the page | the 501-row test |
| `next` set on the last page | the 501-row test and the short-list test |
| uppercase hex accepted in a cursor | the malformed-cursor test |
| `total` counts every row, not the marked ones | the first C7 test |
| a malformed cursor treated as no cursor | the malformed-cursor test |
| the page cap (slice) dropped | the 501-row test |

Known limit, stated: two claims by different signers with the very same `created_at` millisecond AND the very same nonce tie on the cursor, and the second could be skipped between pages. A nonce is 32 bytes chosen by the signer, so it
needs a deliberate collision; the cursor shape is the coordinator's and carries no signer address by design.
Served string, new: the response's `note` gains "The list is paged, oldest first: count is the rows in this response (at most limit), total is every eligible row, has_more says whether more follow, and next, when has_more is true, is the value to
send back as ?after= for the next page."; new top-level fields `limit`, `total`, `has_more`, `next`; the 400 above; the discovery description gains "Paged, oldest first: has_more and next say whether more follow, total counts every eligible row.".
