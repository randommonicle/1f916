VERDICT: DEPLOYABLE WITH CONDITIONS (HIGH 0, MEDIUM 0, LOW 3, INFO 6), reviewed at `53f1cec061f970144e0ffecb7afc6a77f80da288` (branch `m3-second-build-2026-10-04`), scope `7c13f680..53f1cec0`.

# D-018 gate: paid-path M3, the first build's post-gate fixes and the second build (option B), 2026-10-04

Gate: Opus, one seat, no sub-agents, read-only on the worktree except this file. Brief: `drafts/GATE-BRIEF-M3-SECOND-2026-10-04.md`. Every `file:line` below is at `53f1cec0`.

## What I ran

- Full suite at HEAD: 1603/1603 pass (`npm test`). `npm run typecheck`: exit 0.
- Twelve mutants, each on the WHOLE suite, each restored byte-for-byte from a backup in the same command (`cmp` clean) with `git status --short` empty afterwards. Table at the end.
- No push, no deploy, no wrangler, no remote D1, no live-site request.

## Conditions

- **C1 (integration).** `daa0fe3b` (main, live) is NOT an ancestor of this branch (merge base `678ae407`). Both sides changed `src/discovery.ts`, `src/index.ts` and `src/society.ts`, and main's `src/maintainer/budget.ts` adds `GUEST_DUTY_CHECK_COST = 2` ahead of the reconciler. I did not check the merged tree. Deploy only from a merged tree whose full suite and typecheck are green (the hub's integration rehearsal), with the discovery drift guards and `test/maintainer-scheduled-budget.test.ts` among the green.
- **C2 (one real ride).** The rebound booking predicates (`src/listings.ts:1013`, `:1016`, `RESERVATION_BOUND` at `src/settlement-claims.ts:280-281`) and `listingReservationState` (`:287-293`) have run only on the node:sqlite harness; the C1 rehearsal proved `last_row_id`, not these. The SQL shape is the one F2's release already used on prod, so the risk is low, but the first real pay-listing after deploy is the ride: verify its claim row `booked`, its `listing_payments` row and the listing `paid` by public read. Same for the first real payment on each other claim route.
- **C3 (the served promise).** Three new served surfaces say a person will look: `stoppedMessage` "A person will check it against the chain by hand" (`src/settlement-claims.ts:584`), the C7 marker meanings (`src/settlement-attention.ts:41-49`) and the discovery entry. That sentence is true only if someone reads `economy.settlements_awaiting_a_person` (`src/society.ts:1528`) or the list. Before deploy, put that count into the daily watch (the morning watchman or the session-start ritual). Operator process, no code.

## Findings

### HIGH: none. MEDIUM: none.

### LOW-1: `pending_aged` meaning can be false for two kinds of row it covers
`src/settlement-attention.ts:49` serves "the facilitator's answer was unknown and the chain has not settled the question". An H2 row (`src/x402.ts:1092-1098`: the facilitator answered a rule-7 refusal, not acted on because the chain reads unused) and an H3 row (`:1063-1067`: never re-sent because the listing no longer holds the reservation) are pending with a known facilitator answer, or none at all. Under M4 they normally expire within one reconciler pass, so they reach 3 days only when the reconciler sheds them or the chain cannot be read; pre-M4 rows with a far `validBefore` reach it routinely. Fix: "the outcome has not been established after N days (the facilitator's answer was unknown or not acted on, or the claim is waiting for the chain to show its authorisation used or expired)".

### LOW-2: "the settle request was sent" is served for a claim whose /settle was never sent
`src/settlement-claims.ts:670` (the generic pending answer). Reachable on new code: the claim INSERT commits and throws (`src/x402.ts:639-653`, reservation kept, nothing sent), then the payer's identical re-send arrives after `validBefore` but inside the margin. `attemptPending` returns `unchanged` at `:1049-1050` without a /settle, and the answer says the settle request was sent. Also every pre-wave stranded claim the H3 detail answers (`:1065`) where the old 503 path released after an INSERT that committed. Conservative (it says "do not sign again"), but false. Fix: drop "the settle request was sent and", or carry "no settle was sent" from the throw path. Pre-existing wording; the throw path made it reachable.

### LOW-3: a refused listing payment now holds its listing until the expiry proof runs
Under H2 and R2-1 a genuine refusal that is withheld (re-POST refusal with the chain unused; or the first refusal after another holder acquired) keeps the listing `paying` until `attemptPending`'s expiry branch runs: the payer's identical re-send after `validBefore + 300`, or the reconciler's next 06:00 pass. `scripts/pay-listing.mjs` re-signs on a re-run (`:754`) rather than re-sending the old header, so a funder who re-runs after its own `validBefore + 300` gate meets the reserve's 409 (`src/listings.ts:894-898`, "Nothing was settled", true) until the reconciler has run. Liveness only; no money path. Acceptable as is; worth one sentence in the script's `leg2_refused` message.

### INFO-1: R2-1 holds (Q1)
Every writer that starts an attempt is `acquireLease` (`src/settlement-claims.ts:232-240`), which sets `updated_at` and acts only when `leased_until <= now`, so a new holder's `updated_at` is at least the take time plus 180 s and cannot equal it. Every other pending-row writer also sets it (`noteUnknown` `:415-422`, `markChainSpent` `:397-405`, `markSettled` `:301`, `markExpired` `:359`); `releaseLease` (`:243`) does not, and starts nothing. A's own path writes nothing to the claim between `takeClaim` (`src/x402.ts:598`) and `markRefused` (`:727`): `/verify` (`:567`) and `afterVerify` (`:580`) precede `takenAt` (`:590`). The one case where a genuine refusal is withheld (B acquired, read the chain, sent nothing, released) is correct to withhold (A cannot tell) and resolves through the expiry proof, so no reservation is stranded. Mutant M7 shows `acquireLease`'s move is pinned by the old lease test only; the R2-1 tests also pass through `noteUnknown`'s move. Production's interleaving where only `acquireLease`'s move protects A (B's own lease also lapses mid-/settle) is covered by M7's red, not by an R2-1 test.

### INFO-1b: H2 and C4-B leave no invitation to sign while money can move, and no row without a route out (Q2)
Every 402 that carries `accepts` is one of: the first-attempt refusal (`src/x402.ts:749-755`, now bound by R2-1 at `:727`); an unstamped `refused` or `expired` row in `claimAnswer` (`src/settlement-claims.ts:633-649`; `refused` is now written only by that bound first attempt, `expired` only on the pinned chain proof); the M4 bound (`src/x402.ts:547-558`, no claim exists); the /verify refusal (`:570-577`, before any claim). A stopped row is answered before any lease (`:827`), excluded from the reconciler (`src/settlement-reconcile.ts:165`) and listed as `chain_spent_facilitator_refused` (`src/settlement-attention.ts:69`); its route out is a person, by Ben's ruling (C3 keeps that true). An H2 row and an unbound H3 row leave through the expiry proof (`src/x402.ts:1033-1048`), which runs before the reservation check, and whose release is bound to the claim's own reservation.

Regression (Q9): suite 1603/1603 and typecheck 0 at HEAD; `replayForClaim` still precedes `payAndSettle` on all four routes (`src/listings.ts:416`, `:830`, `src/register-gate.ts:204`, `src/x402.ts:1325`); `HOLDS_LEASE` unchanged (`src/settlement-claims.ts:257`); the reconciler's `ORDER BY updated_at ASC, created_at ASC` unchanged (`src/settlement-reconcile.ts:167`); M4 is the one behaviour change every claim route inherits. The merge with `daa0fe3b` is C1.

### INFO-2: the read-before-settle window (builder finding 8) is closed in code (Q3)
The only writers that take a listing out of `paying` are the pay route's own release (`src/listings.ts:956-961`, only on `!result.ok` without `keepReservation`, i.e. when its claim is refused or absent), the claim's terminal release (`src/settlement-claims.ts:317-324`, production caller `markExpired` only: `markRefused`'s `release` has no production caller) and the booking (`src/listings.ts:1016`). Withdraw touches only `open` (`:1114`). Between the reservation read (`src/x402.ts:1058`) and the re-POST (`:1074`), a release therefore needs another holder's `markExpired` after this holder's lease lapsed, which needs the chain unused at a block past `validBefore + 300`, after which the authorisation cannot move money. What remains is an out-of-band D1 edit by the operator. One condition everywhere: `RESERVATION_BOUND` is used by the release, the booking INSERT and UPDATE, C5 (`src/settlement-reconcile.ts:223`), the pre-re-POST check and LOW-2; the pay route's own release binds the exact instance (`paying_since = reservedAt`), which is stricter.

### INFO-3: `paying_since <= created_at` holds by line order (Q3)
`afterVerify` reserves at `src/x402.ts:580` (its `at` at `src/listings.ts:884`) and `takenAt` is read at `src/x402.ts:590`; the Workers clock does not go backwards within a request, so `at <= takenAt`, often equal, which is why `<=` (not `<`) is right. Mutant M14 (`takenAt` one millisecond earlier) turned 21 tests red: the invariant is guarded.

### INFO-4: the held-success residual is narrower than recorded (Q4)
After R2-1 and H2 nothing writes `refused` once another holder has acquired: `markRefused`'s only production caller is the first-attempt write bound to `updated_at = takenAt` (`src/x402.ts:727`), and any acquisition moves `updated_at`. So the `DEFERRED-DURABLE-HELD-SUCCESS` window (`src/x402.ts:934-938`) is reachable only through `expired`, which needs the chain to read the nonce unused past `validBefore + 300` against a facilitator success. The CODEX r2 (2) and r4 (3) tests drive `refused` by hand (`markRefused` without `takenAt`), an order production can no longer produce. The helper is correct for both callers (`:855-859`, `src/settlement-reconcile.ts:210`; mutants M9, M13).

### INFO-5: M4 (Q5)
`src/x402.ts:545-559` runs for every claim-bearing route (all four `payAndSettle` callers pass `claim`: `src/listings.ts:424`, `:883-902`, `src/register-gate.ts:258`, `src/x402.ts:1327`), after `replayForClaim` and before `/verify`, `afterVerify` and any claim: free, nothing reserved. A reference client signs `validBefore = now + maxTimeoutSeconds` (`scripts/register-maintainer.mjs:187`, which says it mirrors x402@1.2.0), so it is refused only when the signer's clock runs more than about 60 s ahead of the Worker's. Five operator scripts take `buildAuthorization`'s default local clock (`now = Date.now()`: `scripts/pay-listing.mjs:754`, `post-listing.mjs:312`, `lobby-sponsor.mjs:303`, `keyauth-ride.mjs:346`, `pay-x402-claim.mjs:690`), so Ben's machine must be within 60 s of the Worker; `register-maintainer.mjs:243` passes its own `now`, whose source I did not read. The refusal names the bound. `UNRESOLVED_AFTER_MS` (`src/listings.ts:266`, 600 s) still covers the 360 s window.

### INFO-6: C7, cost and the script (Q6, Q7, Q8)
C7 selects named columns only; `verdict_reason` is read inside the CASE and never selected out (`src/settlement-attention.ts:65-76`); entries are mapped field by field (`:109`); `rowid` is cursor-only. `/api/official` serves the same `attentionTotal` (`src/society.ts:1528`). Mutant M5 (`from_addr AS nonce`) turned the forbidden-fields test red on the payer address. Cost: no shape I traced exceeds 18 (the largest new shape I traced by hand, a pay-listing booking that fails into LOW-2's read and a release, is 15; a thrown row is at most 4 statements + 12 = 16); R2-4's pinned table went red under M2 and M3. `scripts/pay-listing.mjs:622-636`: the new 502 `settlement_unresolved` takes the generic non-200 branch, writes `refused` only on an unused chain read, and the re-run gate (`refusedRetryDecision`, `:228-235`) re-asks the chain after `validBefore + 300`; safe. The tombstone label `refused` now covers "claim exists, outcome unknown" too; misnomer only. If two D1 failures stack in the takeClaim catch's identical branch (`src/x402.ts:660` then a throw inside `respondToExistingClaim`), `handlePayListing` serves `settlement_unconfirmed` ("No settlement verdict was returned for the settle request") though this request sent none; the reservation is kept and the script keeps `signing`, so it is conservative.

## Mutants (whole suite each; all restored, `git status --short` clean after each)

| id | mutation | red |
|---|---|---|
| M1 | `takeClaim` given `takenAt + 1` (`src/x402.ts:598`) | 13 tests, incl. "H2 control: FIRST /settle still honours a rule-7 refusal", T3d, B2 pay/register routes, C1 control |
| M2 | H2 branch marks `refused` with release instead of `noteUnknown` (`:1093`) | 10: the four H2 tests, 7d, F2 (moved by H2), T6 refused, R2-4 |
| M3 | pre-re-POST reservation check disabled (`:1057`) | 5: the four stranded-claim H3 tests, R2-4 |
| M4 | `RESERVATION_BOUND` loses `paying_since <= ?` (`src/settlement-claims.ts:281`) | 6: F2 never-touched, H3 C5 binding, H3 replacement (x2), never-booked-against-later, the unit test |
| M5 | attention list serves `from_addr AS nonce` (`src/settlement-attention.ts:66`) | 6, incl. the forbidden-fields grep ("must not contain 0x...fa") |
| M6 | reconciler SELECT's marker exclusion made vacuous (`src/settlement-reconcile.ts:165`) | "C4-B: the reconciler stamps the row once and never selects it again" |
| M7 | `acquireLease` no longer moves `updated_at` (`src/settlement-claims.ts:234`) | "lease: ... acquiring moves updated_at" only (see INFO-1) |
| M8 | takeClaim catch, identical row: `keepReservation: false` (`src/x402.ts:660`) | "H3/MEDIUM-1 (pay listing, CODEX r1 HIGH)" |
| M9 | reconciler's held-success re-read disabled (`src/settlement-reconcile.ts:210`) | "CODEX r4 (3): reconciler, B refuses ... counted contradicted" |
| M10 | M4 skew allowance zeroed (`src/x402.ts:545`) | "M4: just inside the bound is accepted" |
| M13 | re-send's held-success contradiction answer disabled (`src/x402.ts:858`) | both "CODEX r2 (2)" tests |
| M14 | `takenAt` one millisecond before the reservation (`src/x402.ts:590`) | 21 tests (H3 control, F2, C5 control, LOW-2, the unit test, routes) |

## What I did not check

- The merged tree with `daa0fe3b` (C1), including main's guest voice and its budget line.
- Real D1 behaviour of the new predicates (C2) and real Workers concurrency: every interleaving here is the harness's, with injected clocks.
- PayAI's real refusal semantics beyond the documented classifier rules (pre-existing, `src/x402.ts:354-423`).
- `src/settlement-chain.ts` beyond what `attemptPending` calls (no diff in this scope).
- The C8 rehearsal worker under `scripts/c8-rehearsal-worker/` (the hub's C1 record covers it).
- The exchange files beyond the CODEX rounds of the second-build exchange; GEMINI's and the r4 exchange's findings were taken as evidence, not re-derived, except where the code above re-derives them.
