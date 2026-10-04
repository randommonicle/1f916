VERDICT: DEPLOYABLE WITH CONDITIONS (C1 a real-D1 rehearsal of C8's `meta.last_row_id`; C2 pin the HIGH fix's plain-throw branch with a test and correct the one false clause it serves). No HIGH found.

# D-018 Opus gate: paid-path M3 choice-free subset (C1, C2, C3, C5, C6, C8) plus CODEX's 3 Oct fixes, 2026-10-03

Reviewed: branch `m3-paid-path-2026-10-02`, worktree `scratch/wt-m3`, HEAD `5b69532c`, diff `678ae407..5b69532c`. Every `file:line` below is at `5b69532c`.
Brief: `drafts/GATE-BRIEF-M3-PAID-PATH-2026-10-03.md`. Read in the brief's order: the M3 brief (C1-C8, A1-A4), `docs/CHECKPOINT-PAID-PATH-M3.md`, both exchange files.
Run by the gate: the full suite at HEAD in the worktree, **1548/1548** (`git status` clean after). Every probe and mutant ran in a scratch copy under the gate's temp directory
(`node_modules` a junction to `society/node_modules`); nothing was written to the worktree except this file. No remote system, no wrangler, no push.

## Conditions of deploy

- **C1 (Q3). A real-D1 rehearsal of the secret-mode citizen batch, through the Workers D1 binding's `batch()`** (a scratch Worker or `wrangler dev --remote` bound to the
  scratch D1; NOT `wrangler d1 execute`, which does not return per-statement batch meta the way the binding does). The batch is the exact pair `runBookingStep` builds for the
  secret-mode citizen (`src/register-gate.ts:364-378` + the record UPDATE, `src/settlement-claims.ts:443-444`). It must show, printed:
  (a) gate true: `out[0].meta.changes === 1`, `typeof out[0].meta.last_row_id === "number"`, and `out[0].meta.last_row_id` equals both `SELECT id FROM citizens WHERE handle = ?`
  and `json_extract(booked_refs, '$.citizen_id')` of the claim, on a citizens table that already has rows (so the new id is not 1);
  (b) the same, with an unrelated INSERT into another table run on the same binding just before the batch (a stale, non-zero `last_insert_rowid()`), still returns the NEW
  citizen's id, not the stale one;
  (c) gate false: `out[1].meta.changes === 0` (so `applied` is false and `rowId` is never read: `src/settlement-claims.ts:451-453`);
  (d) both `out[0].meta.last_row_id` and `out[1].meta.last_row_id` printed side by side. Reason for (d): the local shim cannot tell which statement's meta the code reads.
  Mutant M7 (read `out[out.length - 1]`, the record UPDATE, instead of `out[stmts.length - 1]`) is **green on all 1548 tests**, because node:sqlite reports the same
  `lastInsertRowid` for the UPDATE. Only real D1 can show the code reads the right statement. Why a condition: a wrong positive id has no read-back to catch it
  (`src/register-gate.ts:379-384`) and goes out in the 201 beside the secret. A missing id is safe (it falls back to the read-back).
- **C2 (Q1, Q6). The HIGH fix's commonest input is unpinned, and the answer it serves there carries one false clause.**
  Interleaving (probe P1, run): this request's /settle gets a rule-7 refusal, its `markRefused` THROWS without committing (a transient D1 failure), nobody else holds the claim.
  `src/x402.ts:649` enters the re-read, `:656` releases this request's own lease, `:657` reads the claim `pending`, `:660` calls `answerFromMovedClaim(..., null)`, whose pending branch
  (`src/x402.ts:857`) passes the hard-coded `{ leaseHeld: true }`. Served (run, verbatim): HTTP 502, listing kept `paying` (correct), claim `pending`, `lease_owner` NULL, and the body
  says "Another attempt to resolve it is in progress." No attempt exists: this request just released its own lease. For `listing_pay` there is no repeat clause, so the funder waits
  on a false premise until the 06:00 reconciler. The money answer is right (no 402, no accepts, reservation kept); the clause is false (L-002).
  Worse, the behaviour itself is not pinned: mutant M6b (let a PLAIN thrown refusal write, claim still `pending`, fall through to the 402) is **green on all 1548 tests**; only the
  gate's probe P1 turns it red (M6c). The committed regression ("M3 HIGH", `test/settlement-replay-lease-d1.test.ts:584`) covers only the B-settled case. A refactor could quietly
  re-open the release on the path a real D1 hiccup takes, so this guard "cannot go red" for its commonest input.
  Fix: (i) commit P1 as a test (status not 402, no `accepts`, listing `paying`, claim `pending`) and show M6b red under it; (ii) on the re-read path compute the clause from the row
  (`leaseHeldByAnother(now, owner, Date.now())`) instead of passing `leaseHeld: true` (`src/x402.ts:660` -> `:857`), with the assertion that P1's body no longer says "Another attempt".
  Both are a few lines. If Ben prefers to ship without (ii), record it as accepted: the money answer is right.

## Findings by severity

No HIGH.

**MEDIUM-1 (Q2, pre-existing since M2, NOT introduced or widened by M3; a later item, not a condition). A claim INSERT that commits and then throws re-opens the listing under a
claim that the funder's invited re-send then settles.** Interleaving (probe P2, run end to end):
1. `handlePayListing` reserves the listing (`src/listings.ts:883-899`); `takeClaim`'s INSERT commits and the call throws (`src/x402.ts:568`). The catch returns the 503
   `settlement_claim_unavailable` (`:586`): "nothing was sent ... Nothing was reserved or created by this request. Try again later: the same signed authorisation has not been
   used." It has no `keepReservation`, so the pay route releases its reservation (`src/listings.ts:956-961`). Run: 503, listing `open`, one claim row `pending` with `rpc_body`.
   "Nothing was ... created" is false (the claim row exists).
2. The funder re-sends the identical header, as invited. The listing is `open`, so `loadPayableListing` passes (`src/listings.ts:651`) and `replayForClaim` (`:830`) finds the
   pending claim; once the dead request's 180 s lease lapses, `attemptPending` reads the chain unused, re-POSTs the stored body, and /settle SUCCEEDS. `finishPayListing`'s INSERT
   is gated on `status = 'paying'` (`src/listings.ts:1013`) and the listing is `open`, so nothing books; the re-send is answered 500 "Your payment settled (tx ...) but recording it
   failed ..." (`:1052`). Run: /settle called once, claim `settled_unbooked`, listing `open` and payable again by a fresh signature.
3. The reconciler marks the claim `listing_not_paying` (C5) and sets it aside. Run: claim `settled_unbooked`, marker set, one `settlement_listing_not_paying` line.
Effect: money moved to the payee, the bounty is not booked, and the listing stays open for a second payment. The answers along the way are true except "Nothing was ... created".
If, instead, a second reservation lands before the old claim books (only the reconciler can finish it then, since a re-send meets `listing is paying, not open`), the old claim books
against the new reservation: the exact `DEFERRED-BOOKING-RESERVATION-BINDING` interleaving.
Exposure today: it needs a D1 commit-then-throw on one INSERT (the same class the hub already treats as real in C8) plus an identical re-send in the roughly two minutes between the
dead lease lapsing and `validBefore`. The operator's `scripts/pay-listing.mjs` never re-sends a header; it re-signs only after the old authorisation is provably dead
(`scripts/pay-listing.mjs:617-630`: a non-200 with the nonce unused writes a `refused` tombstone; `:228-236`: a retry needs validBefore + 300 s and a new signature). Under D-074 the funder population is the operator. Fix (next paid-path wave, with C4/C7): in the `takeClaim` catch, re-read the claim; if a row
exists for this key, either proceed as its holder (when `lease_owner` is this request's owner: the INSERT landed) or answer from it with `keepReservation: true`; only "no row"
keeps today's 503. Add P2 as its test.

**Q2 ruling on `DEFERRED-BOOKING-RESERVATION-BINDING` (`src/listings.ts:1001`): a later item, not a condition.** Enumeration, from source:
- Writers that move a listing off `paying` to `open`: two only. (a) The pay route's own release (`src/listings.ts:956-961`), on an `ok: false` without `keepReservation`.
  (b) `listingReleaseStatement` (`src/settlement-claims.ts:296-302`), only inside a claim's `pending -> refused/expired` batch, bound to the claim's pin and `paying_since`.
  `withdrawListing` needs `open` (`:1104`); moderation writes `mod_state` only.
- `ok: false` returns of `payAndSettle` after /settle answered: refusal written (402, releases); refusal not written or thrown, re-read `refused` (402, releases); re-read anything
  else (`keepReservation`); settled but moved (`keepReservation`); settled but unrecorded (thrown: the pay route keeps the reservation). Only the two that release have a claim
  reading `refused`, which can never become `settled_unbooked`. So after `d4f25eb0` no path AFTER /settle re-opens a listing under a claim that can settle.
- The remaining route is BEFORE /settle: MEDIUM-1's thrown claim INSERT. The binding alone does not close it. With the binding, the stale claim books nothing, but the funder's
  re-send still settles it, so the money still moves; the binding only changes which of two payments is booked. CODEX said the same ("alone would not prevent the second payment").
  Build the binding in the same later wave as MEDIUM-1's fix. Bind the INSERT, the UPDATE and C5's check (`src/settlement-reconcile.ts:201`) together, or C5 will hand a
  wrong-reservation row to the booking every run.

**LOW-1 (Q5, pre-existing; M3's C2 now carries the fact to the spot and drops it).** `respondToExistingClaim` holds a facilitator SUCCESS (`out.settledTx`, from
`attemptPending`'s pending re-read, `src/x402.ts:954-959`). It then reads the claim fresh (`:770`). If another holder has made the claim `refused` in that gap, `claimAnswer` serves the
unstamped refused row: a **402 with `accepts`**, inviting a second signature, with no contradiction stamp (`:771`). Probe P3, run: 402 with `accepts`, one
`settlement_success_unrecorded` line, claim `refused`, unstamped. Reachability: it needs this request's lease to lapse mid-attempt (the attempt is bounded at about 136 s against a
180 s lease) AND the other holder's re-POST to draw a rule-7 refusal for an authorisation the facilitator settled for this request (an `expired` cannot follow a real success, because
C6's pinned read would see it used). That is facilitator inconsistency on top of a lease lapse. Fix (one branch): when `out.settledTx !== undefined` and `fresh` is refused or expired,
`recordContradiction` and serve `contradictionResponse`.

**LOW-2 (Q6, pre-existing text made definitively false by C5).** `finishPayListing`'s 500 (`src/listings.ts:1052`) serves `RECONCILE_BACKSTOP` ("The society's reconciler makes
one pass a day ... works a limited number of unresolved payments per pass"). It is served from the same throw whether the step failed transiently (the reconciler will book it) or
because the listing is no longer `paying` (`:1028`). In the second case, since C5, the reconciler sets the claim aside and never works it (P2 step 3, run). Fix: branch the message
on the listing's status, or serve `listingNotPayingMessage` when the listing is not `paying`.

**INFO-1.** `x402.ts:649` `|| threw` is redundant (a throw leaves `wrote` false), so the condition equals `!wrote`. Harmless, and clearer than it reads.
**INFO-2.** `runBookingStep`'s `rowId` comment (`src/settlement-claims.ts:428-432`) says it is the id of "the row-creating statement". For pay listing the last statement of the list is the
listing UPDATE, not the INSERT. Only the secret-mode citizen step consumes `rowId`, whose list is the single INSERT, so nothing is wrong today. Restrict the contract in the comment, or
return `rowId` only for single-statement steps.
**INFO-3.** C6's detail "The authorisation was spent while the society was confirming its expiry" (`src/x402.ts:917`): `authorizationState` also reads true for a CANCELLED
authorisation (A2). "Spent" over-reads it. The vocabulary was there before M3 (`:938`). C4-A's cancellation read is where this gets settled.

## The seven questions, ruled

1. **The HIGH fix.** Fail-closed, read in full: every way out of the refusal branch other than a confirmed `refused` re-read either keeps the reservation (`:659-661`) or throws
   (`:658`, and a throwing `getClaim`), and `handlePayListing`'s catch keeps the reservation (`src/listings.ts:903-936`). Other callers: `markRefused`/`markExpired` in `attemptPending`
   (`:919`, `:940`) carry the release inside the claim's own batch, so a thrown write either committed both or neither. Their throw propagates: a router 500 on the re-send, `failed`
   in the reconciler (`src/settlement-reconcile.ts:228-247`). No caller acts on it as landed. `noteUnknown` is always `quietly` and gates nothing. Conditions: C2, and LOW-1 above.
2. **The binding.** A later item (above). The remaining route is MEDIUM-1.
3. **C8 / `meta.last_row_id`.** Condition C1, as specified.
4. **C6 cost.** No row exceeds 18. The attempt's branches are exclusive: the expiry branch makes at most 4 plain + 8 pinned = 12 fetches (4 distinct RPCs, `src/society.ts:2139`);
   the settle branch makes at most 4 + 1. Expiry row worst: lease 1 + 12 + terminal batch 2 = 15; with a lost `markExpired`, + release 1 = 16. A thrown row is priced
   `meter.n + 12` whenever it threw before reporting fetches (`src/settlement-reconcile.ts:257`): at most about 17 (lease, `markSettled`, read, stamp, release + 12). That is never under
   its real fetches, because the branches cannot both run. The run: a row starts only if `actualCost + 18 <= min(26, left)` (`:160`), so two rows never pass the ceiling. One
   harmless over-price: a row `pending` at SELECT and `settled_unbooked` at lease that throws in booking is priced 12 with no RPC made.
5. **C1/C2/C3/C5 answers.** C1, C2 and C3 hold: C3's proof (applied false + still `settled_unbooked` + ref unrecorded means the lease condition failed) holds for all four sites.
   Their only row-creating statements carry nothing but the gate, and a chain-head clash THROWS (UNIQUE) rather than inserting zero rows (`src/chain.ts:247-253`). C2 empty-tx:
   fixed and pinned (M2 red). The one "sign again while money may have moved" answer found is LOW-1. The one "nothing changed" when something did is MEDIUM-1's "nothing was ...
   created".
6. **Served text.** C2's clause, LOW-2, INFO-3. The changed strings otherwise read true: `contradictionAnswer`, the C2 success text, `listingNotPayingMessage`, `SECRET_LOST_NOTE`, and
   the register tail. The tail's "the repeat tells you so" holds, because a booked secret claim answers `SECRET_LOST_NOTE`'s "your seat exists".
7. **Regression.** The suite is green at HEAD (1548/1548, run). The lease semantics, `HOLDS_LEASE`, and the reconciler's ordering (`updated_at`, `created_at`) are unchanged. C5's SELECT
   keeps the F1 exclusion and still selects a PENDING secret-mode row. Patron, register and listing create reach the same answers, except where C3 now answers from the claim, which
   is correct. Nothing found broken.

## Mutants run by the gate (scratch copy; exact-once replacement, target file alone, restored byte-identical, sha256 checked)

| # | mutant | target | result |
|---|---|---|---|
| M1 | `!wrote \|\| threw` -> `!wrote && !threw` (`x402.ts:649`) | lease-d1 | RED: "M3 HIGH: pay listing, A reads a refusal after B settled the claim ..." |
| M2 | `opts.settledTx !== undefined` -> truthiness (`settlement-claims.ts`) | paid-path-m3-d1 | RED: "C2 (CODEX M3-build r1 MEDIUM): a success reported with an EMPTY tx ..." |
| M3 | `ATTEMPT_FETCH_WORST_CASE = 12` -> `5` | paid-path-m3-d1 | RED: "C6 (CODEX M3-build r1 MEDIUM): when the expiry write THROWS ..." |
| M4 | lagging-block check off (`settlement-chain.ts`) | paid-path-m3-d1 | RED x4: the C6 "not yet past validBefore + margin", "a lagging RPC is skipped", worst-case, and CODEX-MEDIUM tests |
| M5 | C8 rowId path off (`register-gate.ts:379`) | paid-path-m3-d1 | RED: "C8: a read-back that FAILS after the committed final secret-mode step still yields the 201 ..." |
| M6 | re-read keeps the reservation only for `settled_unbooked` | lease-d1 | RED: T3c, P-E (both the not-thrown `!wrote` path) |
| M6b | a PLAIN thrown refusal write (claim `pending`) falls to the 402 | **full suite** | **GREEN 1548/1548** (C2) |
| M6c | M6b against the gate's probe P1 | probe | RED: P1 |
| M7 | `rowId` read from the record UPDATE (`out[out.length - 1]`) | **full suite** | **GREEN 1548/1548** (C1(d)) |
| M8 | a null re-read lets the 402 stand (`x402.ts:658`) | **full suite** | GREEN 1548/1548. Note only: rows are never deleted, and a throwing `getClaim` still throws |

Probes (scratch only, not committed): P1 (C2), P2 (MEDIUM-1, three steps), P3 (LOW-1). The outputs quoted above are from those runs.
Probe and runner source, for the hub to lift P1 into a committed test (C2(i)): `C:\Users\bengr\AppData\Local\Temp\claude\C--Users-bengr-Projects-AI-domain-and-social-network\c323de8e-aed9-4ecd-8c40-75c3fc99b633\scratchpad\m3copy	estgate-probes.test.ts` (P1, P2, P3) and `C:\Users\bengr\AppData\Local\Temp\claude\C--Users-bengr-Projects-AI-domain-and-social-network\c323de8e-aed9-4ecd-8c40-75c3fc99b633\scratchpad\m3copygate-mutants.mjs` (outside the worktree; its node_modules junction is removed).

## Not checked by the gate

- `tsc` (hub-verified 0 at `5b69532c`; not re-run). The D-061 guard ran only as part of the green suite.
- Real D1 anywhere. Whether D1 can commit an INSERT and still throw is ASSUMED real, as the hub's own C8 assumes. MEDIUM-1 rests on it.
- CODEX's owed re-check of `d4f25eb0`/`c3e935d1`/`5b69532c`. The live site (no GET made). Served text outside the diff. `scripts/` beyond `pay-listing.mjs`'s retry rule.
- C4 and C7 (not built). L6 (a rule-7 refusal after an unused chain read, honoured without a re-read) stays open with C4. Within this wave, LOW-1 is the only place it surfaces.

---

**Dated note, 4 Oct 2026 (hub): condition C1 MET on real D1.** Run on Ben's go ("go", Remote Control chat; D-074 note 4 Oct) at about 09:03Z: `scripts/c8-rehearsal-worker/` (`eeac1158`; reviewed by both exchange seats, `exchange/REVIEW_paid-path-m3-r4-correctness-2026-10-04.md`, CODEX converged r3 after two false-pass fixes) through `npx wrangler dev --remote` bound to the scratch D1 `commonhold-migtest` only (`check.mjs` passed: no production id bound). The real `runBookingStep` with register-gate.ts's citizen statement, through the Workers D1 binding's `batch()`. Result (`docs/C1-REHEARSAL-RESULT-2026-10-04.json`), pass true:
- (a) gate true: `out[0].meta.changes` 1, `last_row_id` 2 (number) = `citizens.id` 2 = claim `booked_refs.citizen_id` 2, claim `booked`; the table held one row before (max id 1), so the new id is not 1.
- (b) after an unrelated `reg_log` INSERT on the same binding (stale `last_row_id` 1): `out[0].meta.last_row_id` 3 = the new citizen 3 = `booked_refs.citizen_id` 3, not the stale 1.
- (c) gate false (another owner's live lease): `out[0].meta.changes` 0, `out[1].meta.changes` 0, applied false, no citizen, claim still `settled_unbooked`.
- (d) side by side: real D1 reports the SAME `last_row_id` on the record UPDATE as on the citizen INSERT in (a) and (b) (2/2, 3/3), and in (c) the stale 3 on both. So on real D1 the code's `out[stmts.length - 1]` and mutant M7's `out[out.length - 1]` read the same id in this two-statement batch: the code is correct, and M7 is indistinguishable on D1 as well as locally. (c) shows why `rowId` must be read only when the batch applied: a zero-change INSERT still reports the connection's previous id.
Cleanup deleted the two rehearsal citizens, three claims and one `reg_log` row. The wrangler dev process tree was stopped afterwards (port 8799 closed).
