# Checkpoint log: the plain-error money answers (DEFERRED-PLAIN-ERROR-MONEY-ANSWERS)

Branch `plain-error-money-answers-2026-10-08`, base `fcba887b` (`society/` main). Builder: Sonnet 5.5. Commission: `drafts/BUILDER-COMMISSION-PLAIN-ERROR-MONEY-ANSWERS-2026-10-08.md` (both exchange seats
converged, `exchange/REVIEW_plain-error-money-commission-2026-10-08.md`). Source of the items: `docs/REVIEW-CODE-IDENTITY-LOWS-GATE-2026-10-07.md` (LOW 1, LOW 3) and errant-hermes on 1f916 (comment 97465).
Contract still governing what this file does not change: `docs/BRIEF-SERVED-CODE-IDENTITY.md`, `docs/CHECKPOINT-CODE-IDENTITY-LOWS.md`. Nothing pushed, deployed, migrated or written to a network; no
`*.local.*` file read; `src/doc.ts`, `schema.sql`, `migrations/` and `scripts/deploy-code-identity.ps1` are not touched.

Class: a read-only field on money-path answers, no decision change (DECISIONS, D-018 note 6 Oct, second): no answer's status, `error` text, `code`, `accepts`, branch, claim write, lease, reconciler
selection, log line or migration changes. If an item cannot be done without that, it stops and is reported.

Base: 1958 tests, 1957 pass, 1 skipped (pre-existing), `npm test` 73 s; `tsc` silent. Measured in the worktree before any edit.

## Commits

| # | sha | what |
|---|---|---|
| 1 | this commit | this log |

## Notes (one per commit, newest last)

### 1. this log

Pattern: `docs/CHECKPOINT-CODE-IDENTITY-LOWS.md`. The `node_modules` junction to `society/node_modules` was created for the worktree; no `npm install` was run.

### 2. P1: the mark on the two plain Errors, and the router rule

**Mechanism.** `src/society.ts` gains `markMoneyAnswer(err)` (defines `moneyAnswer: true` on the object, non-enumerable, non-writable, non-configurable: SocietyError's own descriptor, and returns the Error so a
throw site reads `throw markMoneyAnswer(new Error(...))`) and `carriesMoneyMark(e)` (`e instanceof Error && e.moneyAnswer === true`; a non-Error throw, or a bare object that merely has the property, is not marked). The
router's non-`SocietyError` branch (`src/index.ts`) keeps its `console.log` line and the generic body and the 500 exactly, and builds `{ error: <generic>, answered_by }` only when `carriesMoneyMark(e)`; `answered_by` LAST.
The `SocietyError` branch is untouched (it still reads `e.moneyAnswer === true` itself).

**Sites marked** (the throws stay plain `Error`s, same message, so every catch and log line behaves as before):

| site | what |
|---|---|
| `src/x402.ts:769` | `payAndSettle`, rule-7 first refusal: the claim cannot be read back after the refusal write ("could not be read back after its refusal write; the outcome is unknown") |
| `src/x402.ts:1215` | `ledgerReceipt`: the treasury row a claim recorded does not exist ("ledger row N recorded in the claim does not exist") |

**Where each can reach the router, and every wrap on the way** (read from source, not from the hub's pre-check):

- `x402.ts:769` is reached through `payAndSettle` by three callers with NO try around the call, so the mark survives to the router: `register-gate.ts:258` (register), `x402.ts:1382` (patron),
  `listings.ts:442` (listing create). The fourth caller, `listings.ts:908` (listing pay), is inside the try whose catch (`listings.ts:928`, `if (!reservedByMe) throw e;` then the 502 `settlement_unconfirmed`
  with `answered_by`) CONVERTS it when this request reserved the listing: the mark is not used there, the answer already carries the identity. When the request did NOT reserve, the same catch rethrows `e`
  unchanged, and the mark survives to the router (unreachable in practice: the refusal branch is reached only after `afterVerify` ran, which is what sets `reservedByMe`).
- `x402.ts:1215` (`ledgerReceipt`) has three callers. `register-gate.ts:338` (`finishRegistration`) and `listings.ts:501` (`finishListingCreate`) call it OUTSIDE any try (the register try begins at `:346`; the
  listing-create try wraps only the listing INSERT below it), so the mark reaches the router through `finishUnderOwnLease` (rethrows `e` unchanged after releasing the lease, `x402.ts:1199-1208`) or, for the
  reconciler, `settlement-reconcile.ts:313` (logs `reason`, serves nothing). The third, `x402.ts:1299` inside `recordSettledPayment`, is INSIDE the try whose catch (`:1301-1317`) logs
  `payment_settled_unrecorded` and throws a NEW `SocietyError(500, ..., undefined, true)`: it was already a marked, identity-carrying answer, so the mark on the inner Error is dropped there and is harmless.
  `listings.ts` pay (`finishPayListingBooking`, `:1016-1063`) never calls `ledgerReceipt`.
- **Wraps that drop the mark:** only that one (`x402.ts:1301-1317`, deliberately). Rethrowing without wrapping: `finishUnderOwnLease` (`x402.ts:1199-1208`), `register-gate.ts:308` (rethrows a non-SocietyError as is;
  it re-wraps a `SocietyError` only), the `payAndSettle` `catch (e) { ... throw e; }` after `noteUnknown` (`x402.ts` ~:735, a different error). No other catch on these paths builds a new error from these two.
- **No catch branches on the mark or on the class of these two errors.** The log sites that read the message are `register-gate.ts:478` (`e instanceof SocietyError ? e.message : String(e)`, a plain Error gives
  `String(e)` as before), `x402.ts` ~:1309 and `listings.ts` pay/create catches (`e instanceof Error ? e.message : String(e)`), `settlement-reconcile.ts:313` (the same): none reads the mark, and a
  non-enumerable property changes no `String(e)`, `e.message`, `instanceof` or `JSON.stringify` result.

**Not marked, stated plainly:**

- A raw D1 or runtime throw outside these two sites (the gate's LOW 3): e.g. `getClaim` itself throwing at `x402.ts:768`, a D1 error in `replayForClaim`'s `getClaim` (`x402.ts:1195`), any other statement.
  It stays the generic 500 with no `answered_by`; this wave's negative control pins that.
- The x402 402 challenge bodies (protocol shape: `x402.ts` ~:782-788, `accepts`), untouched.
- The society's refusals before settlement (the gate's LOW 1: the `afterVerify` refusals, validators, throttles, the 409 handle-taken before any payment): never marked, so a stranger's free refusal never carries
  the identity.

**Tests** (`test/plain-error-money-d1.test.ts`, parts 1, 2 and the sweep): the mark's descriptor and invisibility (`Object.keys`, `JSON.stringify`, spread, `Object.entries`, `String(e)`, class, a failed
re-set), `carriesMoneyMark` on every shape of thrown value, the router serving a marked and an unmarked plain Error side by side (body byte for byte; the log line byte for byte, written out, identical for
both), the `SocietyError` branch unchanged, a bare object `{ moneyAnswer: true }` and a thrown string NOT marked, and a source sweep pinning exactly two `markMoneyAnswer(` call sites, both in `x402.ts`.
The existing `test/code-identity-lows-d1.test.ts` sweep (marked `new SocietyError(` counts per file) is untouched and green: the new helper is not a `new SocietyError(` call.

### 3. P3: the read-backs through the routes, with stability across re-sends

`test/plain-error-money-routes-d1.test.ts` (8 tests, real router, real local D1, real SQLite triggers, `captureLog`). It imports nothing this wave added, so it also runs against the base source
(`PEM_RECORD=<path>` writes what each scenario served; the decision-invariance table in the close compares the two runs). Every case pins the exact status, the exact body TEXT (so key order), the router's one
log line (written out as a literal, not computed), the row counts after EACH send, and three identical sends. Fixtures: the claim's treasury row is deleted with `DELETE FROM ledger` after the first request
left a `settled_unbooked` claim (no triggers guard the ledger in `schema.sql`); "the claim vanishes after the refusal write" is an `AFTER UPDATE` trigger on `settlement_claims` that deletes the row the
first-refusal write just updated (a persistent fault; the write's own `changes` stays 1, so the code sees a refusal written and then no row); "one read finds nothing" is a DB wrapper that makes the
first claim `SELECT` after the first-refusal write return no row (a transient fault).

**Per case: the answer, whether it is stable across re-sends, and the state it leaves.**

| case | answer (all with the router's log line `{"level":"error","path":...,"message":"Error: ..."}`) | stable across 3 identical sends? | state left |
|---|---|---|---|
| (a) register, treasury row deleted | 500 `{"error":"Internal error. The society apologizes.","answered_by":{...}}` | yes, byte-identical text | claim `settled_unbooked` still pointing at the vanished row, lease released after every send; 0 citizens, 0 ledger rows, claim count 1; the facilitator was asked once (by the first request only) |
| (a) listing create, treasury row deleted | the same 500 + `answered_by` | yes | claim `settled_unbooked`, lease released; 0 listings, 0 ledger rows; facilitator asked once |
| (b) register, persistent fault | the same 500 + `answered_by`, log reason "could not be read back after its refusal write" | yes | NO claim row (the trigger deletes it each time); 0 citizens, 0 ledger, 0 claims. Each re-send is a fresh claim and a fresh `/verify` and `/settle`: the facilitator is asked once PER SEND (3 sends, 3 asks) because the claim that would have answered it is gone |
| (b) patron, persistent fault | the same | yes | no claim row; no treasury line; facilitator asked once per send |
| (b) listing create, persistent fault | the same | yes | no claim row; no listing, no treasury line; facilitator asked once per send |
| (b) register, TRANSIENT fault | first answer: the same 500 + `answered_by`; re-sends: 502 `settlement_unresolved` with `answered_by`, no `accepts`, the claim's own answer | NOT stable from the first answer to the second (500 then 502); stable from the first re-send on (re-send 1 = re-send 2 byte for byte) | after the first answer: claim `pending` holding the facilitator's refusal, lease released, 0 citizens, 0 ledger. Nothing invites a second signature at any point |
| (b) listing pay (regression) | first answer: 502 `settlement_unconfirmed` with the existing keys in the existing order (`error, listing_id, submission_id, paying_since, wallet_row_id, wallet_row_hash, message, answered_by`), `answered_by` LAST; unchanged by this wave (base run identical); re-sends: 409 `{"error":"listing N is paying, not open"}` | stable from the first re-send on | listing `paying` (reservation kept), claim `pending`; the re-sends never reach the claim because `loadPayableListing` refuses a reserved listing first, for free (`DEFERRED-PAY-LISTING-RESEND-REPLAY`, `listings.ts` ~:849): a pre-settlement refusal, never marked |
| (c) negative control, an unmarked plain throw (a raw D1 error on the claim read), on register, patron, listing create and listing pay | exactly `{"error":"Internal error. The society apologizes."}` with NO `answered_by`; the router's log line unchanged | yes (3 sends each) | nothing written, no facilitator call |

**Findings worth the hub's attention (none changes this wave's code).**

1. For the persistent-fault cases there is no stable claim for a re-send to be answered from, so each re-send pays the facilitator round trips again and gets the same 500. In production the claim row is
   never deleted (`CHECKPOINT-CODE-IDENTITY-LOWS.md` note on `x402.ts:1025`), so the persistent case is the shape of "the D1 read keeps failing", and there the claim row does exist: that is the
   transient/`pending` shape above, where the first answer is the 500 and the re-sends are the claim's 502.
2. The first answer to a transient read-back failure (the generic 500) differs from every later answer (the claim's 502 `settlement_unresolved`). That is existing behaviour, only now visible:
   the 500 carries no `code` and says nothing about the refusal that was written. This wave adds the identity to it and does not change what it says.
3. Pay listing's re-send after that first answer is the reservation's free 409 (no `answered_by`), as `DEFERRED-PAY-LISTING-RESEND-REPLAY` already says.

**Existing coverage of the pay-listing regression, as the commission asked me to say.** `test/settlement-replay-lease-d1.test.ts` ~:593-634 and ~:636-675 inject a refusal write that THROWS (not a read that finds no
row) and assert "not a 402, no `accepts`, reservation kept, claim state"; they do not assert the 502 body or `answered_by`. `test/refused-option-b-d1.test.ts` ~:250-315 case (b) injects a read-back that THROWS
and asserts 502 `settlement_unconfirmed` and the kept reservation, again without `answered_by` and not for a read that finds no row (the marked-Error path). So neither covers the byte-level answer; the new
listing-pay test does (exact key list and order, `answered_by` last, the message prefix, the router log empty, the claim `pending`).
