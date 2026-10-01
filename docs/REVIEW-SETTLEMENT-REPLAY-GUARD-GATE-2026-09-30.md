**VERDICT: DEPLOYABLE WITH CONDITIONS.** No HIGH: I found no sequence that books one authorisation twice, and no documented facilitator answer that moves a claim to `refused` or `expired` while the money may have moved. One condition before the deploy: (C1) bound the facilitator fetch below the claim lease, because the request that takes a claim can today outlive its own lease inside `/settle`, and every M1 variant starts there. The finisher hardening (C2) and L1 ride the next paid-path wave unless the builder does them with C1.

# D-018 gate: M2, one settlement is booked once (settlement replay guard), pre-deploy

Scope `5a3465f7..a16b1c42`, worktree `scratch/wt-m2-replay`, branch `m2-settlement-replay-guard-2026-09-30`. That is 20 commits: the M1/C2 fix branch (`468b4efb`, `0d9fb068`, `f7c7e694`), its merge `838cfe14`, and 16 build and fix commits. I was read-only on ROOT except for this file. Mutants and probes ran on a scratch copy under the session scratchpad, with `node_modules` as a junction. Line numbers are at `a16b1c42`. Run 2026-09-30/10-01 UTC.

## Findings

### HIGH: none

### MEDIUM

**M1. The request that took a claim can outlive its lease, and nothing re-derives the answer when the claim moved under it.**

- **Root.** `facilitator()` fetches `/settle` with no timeout (`src/x402.ts:146`). The taker's lease is `CLAIM_LEASE_TTL_MS = 180_000` from `takeClaim` (`src/settlement-claims.ts:65`, `:192-206`). Once a `/settle` runs past 180 s, the payer's identical re-send (or the reconciler) can take the lease (`src/x402.ts:630-665`, `src/settlement-claims.ts:214-222`) while the original request is still live.
- **What the original request does then.**
  - `payAndSettle` ignores `markSettled`'s `false` and finishes on whatever `getClaim` returns (`src/x402.ts:575-576`).
  - `finishRegistration` trusts its row snapshot for the citizen step and discards the step's `applied` (`src/register-gate.ts:328`, `:347-366`).
- **The three outcomes.** Bookings stay single in all three (the step gates hold), but the answers are false.
  - **(a) P1, run at function level.** I called `finishRegistration` directly, twice, with the same stale `settled_unbooked` row. The second call returned `done: true` with a 201 `secret` that was never stored: its hash does not match `citizens.secret_hash`. Through the router this needs two finishers interleaved under a lapsed lease. I reasoned that route-level path from P2; I did not run it. The effect is that the payer can end up holding a dead credential while the real one went to the other response.
  - **(b) P2, run.** The original request, after a re-send has booked the registration, answers 500: "registration did not complete ... No credential was delivered to you ... Repeating this identical request ... hands you a fresh secret". It also logs `registration_paid_but_failed` with the reason "the claim is not booked" (`src/register-gate.ts:370`, `:461`). The registration did complete, and a repeat gets the booked answer, not a secret.
  - **(c) P5, run.** Suppose the re-send's re-POST is answered with a rule-7 refusal while the original's `/settle` later succeeds. The claim is then `refused` for money that moved. The original answers 500 with an empty tx ("settled (tx )"), because `row.tx` is null on a refused row. Every later identical replay gets the recorded refusal 402 with `accepts`, which invites a fresh signature (`src/x402.ts:711-716`, `src/settlement-claims.ts:455-459`).
- **Why MEDIUM and not HIGH.** Variant (c) has HIGH-class impact. But it needs a `/settle` longer than 180 s, where PayAI documents a 100 s response budget ("capacity-and-limits", fetched 2026-09-30), and a facilitator that answers an identical in-flight re-POST with a recorded failure, where PayAI documents `409 duplicate_settlement` or another `settlement_pending`. Variants (a) and (b) need only the long `/settle` plus an identical re-send inside the window.
- **Fix.**
  - C1: an AbortController on the facilitator fetch at no more than 120 s. That is above PayAI's 100 s and below 180 s minus the 16 s worst-case chain read. An aborted `/settle` is already an unknown outcome (pending, lease released), so the fix uses a path that exists.
  - C2: a finisher whose citizen step was not applied by this call answers from the claim and never returns `secret`. `payAndSettle` answers from the claim's state when `markSettled` returns `false`, and logs the contradiction loudly if that state is `refused` or `expired`.

### LOW

**L1. A claim INSERT that throws (a D1 error, not a conflict) after the pay-listing reservation strands the listing in `paying` with no claim, and serves a false "may have moved the money".**

- `takeClaim` runs inside `payAndSettle` after `afterVerify` has reserved (`src/x402.ts:510-516`). A throw there reaches `handlePayListing`'s catch with `reservedByMe` true (`src/listings.ts:883-916`), which answers `settlement_unconfirmed`: "No settlement verdict was returned for the settle request ... the facilitator may have moved the money".
- In fact no `/settle` was sent. There is no claim, so neither the reconciler nor F2 can release the listing. Only hand SQL can.
- P4, run with a `BEFORE INSERT` trigger on `settlement_claims`: 502 `settlement_unconfirmed`, listing `paying`, 0 claims, 0 settles.
- B3 asks for "an explicit revert of the reservation before rethrowing". That is met for a conflict, not for a thrown INSERT.
- Same wrapper, same direction: a post-settlement `settlement_claim_unrecorded` 500 (`src/x402.ts:599-602`) reaches the pay route as "No settlement verdict was returned (Your payment settled (tx ...)...)". It is self-contradictory but safe: it keeps the reservation, says do not sign again, and the claim resumes.
- Fix: catch a `takeClaim` throw in `payAndSettle` and return it as a not-sent `ok:false`, so the pay route releases its own reservation. Test it with the trigger.

**L2. Test 3 passes for the wrong reason.**

- `test/settlement-replay-routes-d1.test.ts:136` stubs no RPC. When the loser meets a pending claim with no live lease, its chain read fails (the stub throws on RPC URLs) and it never re-POSTs. So "exactly one reaches /settle" holds even when the taker holds no lease.
- Mutant G1 (below) leaves test 3 green. Only the two primitive tests in `settlement-claims-d1` go red.
- With `rpc: () => authStateAnswer(false)` added to test 3's stub, G1 turns test 3 red. I checked this on the scratch copy. Fix: add that stub.

**L3. A spent `pending` row can only be booked while PayAI still holds its recovery record.**

- The reconciler learns the tx only by re-POSTing (`src/x402.ts:700-725`).
- PayAI's page says "Reconcile promptly" and "If the recovery record is no longer available ... Do not interpret an expired record as proof of failure". The TTL is undocumented.
- On a day the reconciler defers (F3) or rotates 2 rows, a spent row whose record has expired meets 7e's contradiction branch. It stays `pending` "for a person" (`src/x402.ts:712-713`), is re-POSTed every day, and no route lets a person resolve it.
- The code comment "a public-key registration is finished either way" (`src/register-gate.ts:255`) overclaims. The served text does not: F4's backstop wording promises no resolution.
- Suggest booking from chain evidence: the tx hash of `AuthorizationUsed(from, nonce)` via `eth_getLogs`, at the same two-RPC quorum. Or give such rows a permanent reason and stop re-POSTing.

**L4. Rows the reconciler can never finish still take its two daily slots.**

- The SELECT (`src/settlement-reconcile.ts:132-136`) excludes only `handle_taken`.
- Three kinds of row are still picked on every run and rotate through the 2 slots:
  - secret-mode `settled_unbooked` registrations (it books nothing for them: `src/register-gate.ts:291`);
  - `listing_pay` rows whose listing is no longer `paying`;
  - L3's contradiction rows.
- Each such row delays real rows by about half a day. Suggest excluding secret-mode `settled_unbooked` in SQL, and giving the others a permanent `verdict_reason` as F1 does.

**L5. `expired` is decided on the Worker's clock, not on the block time the chain answer reflects.**

- `nowMs/1000 > valid_before + 300` (`src/x402.ts:693`) is checked against `eth_call ... "latest"` (`src/settlement-chain.ts:37`).
- Two RPCs lagging by more than 300 s could both report "unused" while a block with timestamp below `validBefore`, carrying the transfer, is not yet visible to them. The claim would be expired, and for `listing_pay` released (F2), for money that moved.
- The distinct operators make this improbable. The robust form reads `latest`'s timestamp in the same quorum and requires `block.timestamp > valid_before`.

**L6. No chain re-read after a refusal on the re-POST path.**

- The sequence is: unused and valid, then re-POST, then rule 7, then `refused` (`src/x402.ts:711-716`). This is brief-conformant (B6: "classify as today").
- If the authorisation was executed between the read and the answer, the claim is refused for money that moved. That needs PayAI to treat an identical re-POST as a new attempt.
- Defence in depth: after a rule-7 answer on the re-POST path, read the chain again and stay `pending` if it is now used.

**L7. Two secret-mode messages can be false after the citizen batch commits.**

- If the read-back straight after the committed secret-mode citizen batch fails (`src/register-gate.ts:364`), or D1 commits and still throws, the request answers "No credential was delivered ... Repeating ... hands you a fresh secret" (`:455`, `:461`).
- The claim is already `booked`, so the repeat answers `SECRET_LOST_NOTE`. Its phrase "a response containing its secret was issued" (`src/settlement-claims.ts:429-430`) is itself false in this case.
- Narrow: it needs a D1 failure in the one read after a committed batch. A fix is to take the citizen id from the step (for example `RETURNING`) rather than from a second read.

### Info (not findings)

- **I1. Where the rehearsal record is.** The gate brief says the 0017 rehearsal record is the checkpoint's final note. It is actually in `HANDOVER.md` Addendum 78 section 9 (batch `last_insert_rowid()`/`changes()`/`json_set` on real D1, 0017 applied twice, CHECKs and PK refusing bad rows). The checkpoint should point to it.
- **I2. Chain-head exhaustion under concurrency.** Under six concurrent paid acts on distinct claims (P3), one or two requests exhausted the four chain-head retries and answered the F7 500. Each claim then resumed cleanly (the reconciler booked 2, an identical re-send booked the third) and `GET /api/attest` verified every chain. The four-retry limit is pre-existing (`appendChained`). What is new is that it is now recoverable.
- **I3. Invite mode.** In invite mode (dormant), a stale public-key finisher could append a second `invite_redeemed` line (`src/register-gate.ts:483-490`).
- **I4. Late listing creation.** A listing creation the reconciler books days later keeps the funder's `expires_at` from the intent, so it can land already expired.

## Mutants run (scratch copy; each restored byte-identical, checked with `Buffer.compare`)

| id | guard | mutation | result |
|---|---|---|---|
| G1 | the taker holds a live lease, so a concurrent identical request cannot re-POST (test 3's claim) | `takeClaim` inserts `leased_until = NULL` (`src/settlement-claims.ts:195`) | Full suite 1467 pass / **2 fail**, primitives only (`the INSERT is the claim ...`, `lease: a live lease blocks ...`). **Route test 3 stayed green** (L2). With an answering RPC stub in test 3: **test 3 red**. |
| G2 | two RPCs that disagree give no transition | `src/settlement-chain.ts:66` disagreement check disabled | **Red, 1 fail**: 7c. |

Probes (not mutants, current code, scratch copy): P1 (stale finisher, bogus secret), P2 (original request after the lease lapses, false 500), P5 (claim `refused` while the original settles), P4 (claim INSERT throws after the reservation), P3 (attest after booking paths). Results are quoted in the findings.

## The thirteen questions

1. **One authorisation, one booking.** Holds; I found no path to a second citizen, ledger row, listing or payment row.
   - The key is the PK `(network, asset, from_addr, nonce)`, lower-cased, with network and asset taken from our requirements (`src/settlement-claims.ts:109-120`).
   - The claim is `INSERT ... ON CONFLICT DO NOTHING` (`:192-206`).
   - An identical replay is answered by consult-first (`src/x402.ts:733-747`) and, in a race, at the INSERT (`:511-516`).
   - B4a: a different handle, model or door is a 409 conflict because the intent hash differs (test 2, which checks the code, not only the status).
   - Concurrency: one INSERT wins, and the taker holds the lease (routes test 3; see L2 for why that test does not prove the lease).
   - Crashes: every row-creating write is one batch with its `booked_refs` update, gated on `settled_unbooked` with the ref unrecorded and `changes() = 1` (`src/settlement-claims.ts:344-369`). A crash anywhere leaves a resumable claim, and resume skips recorded steps with the gate as a second layer.
   - Terminal replays: `booked` gives 409, `refused` the recorded 402, `expired` a 402 "sign a fresh one", with no `/settle` in any case.
   - Reconciler against a re-send: the lease. P1, P2 and P5 each end with one citizen and one ledger row at most. What breaks under a lapsed lease is the answer, not the booking (M1).
2. **Where the claim is taken.**
   - It is taken after `/verify`, after `afterVerify` (the handle re-check; the reservation; the listing-create throttle) and immediately before `/settle` (`src/x402.ts:489-516`).
   - Every free check runs before `payAndSettle`. A handle collision leaves no claim (test 9). A conflict after the reservation releases it (10a).
   - Exception: a thrown claim INSERT strands the listing (L1).
3. **Refusal vs unknown.**
   - B8 holds: `duplicate_settlement` and `settlement_pending` are folded and trimmed, and read as unknown at any status (`src/x402.ts:274`, `:319-337`). Rule 7 excludes both (`:347-357`).
   - `expired` requires the chain to report unused at a two-distinct-RPC quorum AND `now > valid_before + 300` (`src/x402.ts:691-699`). This is stricter than the brief; the hub ruled OPEN 3.
   - A spent authorisation is never refused: 7e keeps it `pending` (`:712-713`).
   - Residuals: M1(c), L5 and L6. All three need conditions contrary to PayAI's documentation or two lagging RPCs.
4. **The reconciler.**
   - Lease: a conditional `UPDATE ... RETURNING` with a TTL (`src/settlement-claims.ts:214-222`), so two workers cannot both hold a row (8b), and a crashed worker frees the row after 180 s.
   - Quorum: the first two distinct RPCs that answer must agree. One answering, or two disagreeing, gives no transition (G2 red). Garbage (not exactly 32 bytes, not 0/1, an error object, non-2xx, timeout) is no answer (`src/settlement-chain.ts:26-68`).
   - It re-POSTs only the stored body, and `JSON.stringify(JSON.parse(rpc_body))` is byte-identical (7a asserts it). It never asks for a signature.
   - Budget: it runs after the sweep and the concierge, gets what is left minus the clerk's fixed cost and `FINALISE_RESERVE`, defers with one line when that is short, and has a per-row try/catch (`src/settlement-reconcile.ts:120-209`, `src/index.ts:593-603`). A failing row never stops the rest (test 14).
   - It never books a secret-mode registration (`src/register-gate.ts:291`).
   - Liveness gaps: L3, L4.
5. **Secret mode.**
   - No secret is served twice, and none to a divergent intent: the intent hash covers handle, model and public_key.
   - But a stale finisher can serve a secret that was never stored (M1a).
   - Who else can finish a `settled_unbooked` secret registration: anyone holding the same `X-PAYMENT` header and the same body. That means the payer, any proxy or relay on its path, and anyone who logged the request.
   - That exposure is not new. Before this wave the same holder could replay into a new registration, and M2 let them take a second handle. It is now narrower.
   - The case (ii) text never says "delivered" (`src/settlement-claims.ts:429-430`). Its "was issued" can be false in L7's window.
6. **Custody of `rpc_body`.**
   - No route serves it. `claimAnswer` builds from the route, intent fields, tx and state only.
   - No log line carries it: the logs carry `claim_from`/`claim_nonce`, the tx and reasons clipped to 200 characters.
   - The table CHECK (`migrations/0017_settlement_claims.sql:63`) makes it NULL on every terminal row. The hub red-proofed that CHECK on real D1.
   - `settled_unbooked` keeps it, but its nonce is already spent.
7. **The chained ledger in a batch.**
   - `appendChainedStmt` precomputes `prev_hash`. The UNIQUE indexes on `ledger(prev_hash)` and `(hash)` (`schema.sql:120-121`) fail the whole batch on a head race, and `runBookingStep` rebuilds against the new head, up to four times (`src/settlement-claims.ts:355-368`). A fork cannot commit.
   - P3, first-hand: `GET /api/attest` gives `ok:true` on identity (5) and treasury (9) after a plain registration, a resumed public-key registration, six concurrent paid acts across claims, a reconciler booking with a key line, and replays of each. There were 9 claims, all `booked`.
8. **Migration 0017 and `schema.sql`.**
   - Additive: one `CREATE TABLE IF NOT EXISTS` and one index. No existing table is rebuilt.
   - The PK and every B1/B4a column are present, plus `payer` (OPEN 9, accepted). The block is identical to `schema.sql:456-479`.
   - The old worker never reads the table.
   - The new worker needs it on every paid request. Without it, consult-first throws before `/verify` (a 500 with no money moved) and the reconciler's throw is caught. So migration first, which the script enforces.
   - The rehearsal record is I1.
9. **The deploy script.**
   - Every remote write is after the `-DryRun` exit (`scripts/deploy-settlement-replay-guard.ps1:159-162`). Before it there are only `git fetch`, the local gates, public GETs and remote D1 reads.
   - It fetches (`:107`) and pins HEAD = main = origin/main = `-ExpectedCommit` on a clean tree (`:109-125`).
   - It applies the migration before the worker (`:165-172`), reads the catalogue (columns in order, PK, the B7 CHECK text, the index, a count: `:175-189`), captures the version id or stops (`:198-199`), and polls a marker it first proved absent (`:151`, `:204-209`; I confirmed "pilot PAUSED" is absent from live `GET /` today). The 402 marker is checked only after the deploy, in the register 402 body, which I did not POST. Its absence on `GET /` proves nothing.
   - Failure handling: every step stops on failure. The test gate needs exit 0 and `fail 0`; a test title matching `fail 0` cannot pass a red run, because the exit code is also required.
   - It reads no custody file and prints no secret. I did not run or parse it; the builder's parse test is in the green suite.
10. **Pay listing in flight (listing 5).**
    - An honest first payment is unchanged apart from the claim. Leg 1 has no header, so consult-first returns null. Leg 2 carries a fresh nonce. The 200 body fields and `X-PAYMENT-RESPONSE` are as before (`src/listings.ts:1018-1031`).
    - `pay-listing.mjs` never re-sends a signed header, so the consult-first answers and conflicts are unreachable from it.
    - A `settlement_claim_unrecorded` or a thrown claim INSERT arrives as `settlement_unconfirmed` and keeps the tombstone at `signing`. That is safe, although L1's text is false.
    - No new answer reads as success or as safe to re-run.
    - For Ben: if the pay answer is `settlement_unconfirmed` and prod has no claim row for that nonce, no `/settle` was sent (L1).
11. **Served text (L-002).** False or overstated:
    - M1(b): the original request's 500 after a re-send has booked the registration.
    - L7: the two secret-mode sentences.
    - L1: "may have moved the money" when no `/settle` was sent.
    - The code comment at `src/register-gate.ts:255` (L3; not served).

    True as served:
    - `RECONCILE_BACKSTOP`: one pass at 06:00, limited, oldest attempt first, no deadline.
    - The repeat clause, only on routes where a re-send re-checks.
    - The F1 handle-taken answer.
    - `PUBLIC_KEY_ADVICE`.
    - The lobby note, verbatim from the commission appendix. Its "seven" matches `SPONSORED_HANDLES` (`src/society.ts:159-167`, seven handles) and live `GET /api/official` `composition.operator_funded: 7`.
    - B6b: the secret-mode `settled_unbooked` answer names no deadline.
12. **Non-minting.**
    - `src/constitution.ts` and `wrangler.jsonc` are unchanged. `src/doc.ts` has one hunk, `lobbyDoorNote` (`src/doc.ts:736`), outside `FRONT_DOOR_TEMPLATE` (line 147).
    - Test 13 and `topics-d1` 9 pin `fa11788d...` and are green.
    - Live `/api/attest`: v5, `fa11788d062b0c6d23c54c428c1c9649d263ae3ba704e602e122066926049491`, all four chains ok (identity 36, treasury 18, payouts 0, ballots 14).
13. **The tests.** G1 and G2 above. G1 exposes L2. G2 shows the quorum's disagreement branch has its own test.

## Conditions

- **C1 (before the deploy).**
  - Bound the facilitator fetch (`src/x402.ts:146`, both paths) with an AbortController timeout of at most 120 s.
  - Add a test that a hung `/settle` ends with the claim `pending`, its lease released, the 502 saying "do not sign again", all inside `CLAIM_LEASE_TTL_MS`.
  - This removes M1's precondition and uses the existing unknown-outcome path. In this gate's judgement, a focused re-check of that diff (the exchange) is enough. Whether D-018 needs another Opus pass is Ben's call.
- **C2 (the next paid-path wave, or with C1 if cheap).** M1's finisher hardening (a secret only from this call's own applied step; answer from the claim when `markSettled` returns false), and L1.
- **Queued, not conditions:** L2 (one-line test fix), L3-L7.

## What I did not check

- **No real D1.** I relied on the hub's rehearsal (Addendum 78 section 9) for batch `changes()`/`last_insert_rowid()`/`json_set`. The `metered` facade over real D1 statements is unproven (OPEN 1, accepted).
- **No live PayAI behaviour.** Not observed: the recovery-record TTL, the answer to an identical in-flight re-POST, what a spent nonce's re-POST returns, or whether `/verify` checks the on-chain nonce.
- **Platform behaviour.** Not checked: whether a Worker keeps running its `/settle` after the client disconnects, or whether a cron can fire twice.
- **Red-proofs.** I did not re-run the builder's roughly 100 red-proofs; I sampled two.
- **The deploy script.** I did not run it or PowerShell-parse it.
- **Already-converged areas.** I did not re-review the merged M1/C2 branch beyond its pointer texts, or invite mode.
- **Typecheck coverage.** It covers `src/` only.
- **The brief's exchange record.** I read it in part.

## What I verified first-hand, and how

- **The worktree.** `git -C <ROOT> rev-parse HEAD` = `a16b1c42b0499617969d69c2fed1786c6e258bbe`. The tree is clean. `git log 5a3465f7..HEAD` lists the 20 commits above.
- **Suite and typecheck.** 1469/1469 pass and `npx tsc --noEmit` exits 0, on the scratch copy (`src`, `test`, `scripts`, `migrations`, `docs`, `schema.sql`, `package.json`, `tsconfig.json`, `wrangler.jsonc`; `node_modules` junctioned).
- **Code read.** The full `5a3465f7..HEAD` diff of `src/`, the migration, `schema.sql` and the deploy script, plus `scripts/pay-listing.mjs`'s leg-2 handling.
- **Mutants and probes.** G1, G2 and P1-P5, as above. Probe files lived only in the scratch copy.
- **Live reads.** `GET /api/attest`, `GET /` and `GET /api/official`, read-only.
- **PayAI documentation.** `docs.payai.network/x402/facilitators/capacity-and-limits.md`, read-only.
