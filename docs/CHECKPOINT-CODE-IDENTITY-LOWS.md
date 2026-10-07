# Checkpoint log: the code-identity gate's LOWs (read-only fields on money-path answers)

Branch `code-identity-lows-2026-10-07`, base `1491fb9c` (`society/` main). Builder: Sonnet 5.5. Commission: `drafts/BUILDER-COMMISSION-CODE-IDENTITY-LOWS-2026-10-07.md` (both exchange seats
converged, `exchange/REVIEW_code-identity-lows-commission-2026-10-07.md`). Source of the items: `docs/REVIEW-CODE-IDENTITY-GATE-2026-10-06.md` (L1-L5). Contract still governing
what this file does not change: `docs/BRIEF-SERVED-CODE-IDENTITY.md`. Nothing pushed, deployed, migrated or written to a network; no `*.local.*` file read; `src/doc.ts`, `schema.sql` and
`migrations/` are not touched. I6 was done by the hub on main (`4b6819ca`) and is not touched here.

Class: read-only fields on money-path answers, no decision change (DECISIONS D-018 note 6 Oct, second): no answer's status, `code`, `accepts`, branch, claim write, lease, reconciler
selection or migration changes. If an item cannot be done without that, it stops and is reported.

Base: 1927/1927 (`npm test`, 65 s) and `tsc` silent, measured in the worktree before any edit.

## Commits

| # | sha | what |
|---|---|---|
| 1 | `d380dbb6` | this log |
| 2 | this commit | I1 + I2: the `moneyAnswer` marker on `SocietyError`, the router rule, 14 marked sites, the sweep, `test/code-identity-lows-d1.test.ts` |

## Notes (one per commit, newest last)

### 1. this log

Pattern: `docs/CHECKPOINT-SERVED-CODE-IDENTITY.md`. Differences from the commission are noted where they arise, in the commit's own note.

### 2. I1 (gate L1): `answered_by` on the uncoded money answers that are SocietyErrors (and I2: the 402 challenges left alone)

**Mechanism.** `SocietyError` (`src/society.ts`) takes an optional fourth constructor argument, `moneyAnswer`. It is stored with `Object.defineProperty(this, "moneyAnswer", { value, enumerable: false,
writable: false, configurable: false })` in the constructor BODY (the strip-types rule recorded at `society.ts:258-263`), and declared with `declare readonly moneyAnswer: boolean;` so the type exists and no
class field is emitted (a plain field would be an enumerable own property for the instant between `super()` and the `defineProperty`). `errorBody` is untouched and never reads it. The router
(`src/index.ts`, the catch) adds `answered_by` when `e.moneyAnswer === true` OR the code is on `SETTLEMENT_ANSWER_CODES`; nothing else about the response changes. No `code` is added anywhere.

**Marked** (line numbers at the base, `1491fb9c`, as the commission gave them; each confirmed by reading the source; all fourth-argument `true`, code `undefined`):

| site | what | reached by a request through the router? |
|---|---|---|
| `x402.ts:208` | `/settle` request failed in transit | yes (patron) |
| `x402.ts:210` | `/verify` request failed in transit | yes |
| `x402.ts:232` | `/settle` answer unreadable | yes |
| `x402.ts:234` | `/verify` answer unreadable | yes |
| `x402.ts:494` | `settleOrThrow`: the answer is not a verdict (unknown) | yes |
| `x402.ts:578` | `/verify` classified `failed` (a 5xx) | yes |
| `x402.ts:812` | settled, the claim cannot say so | yes |
| `x402.ts:1025` | `answerFromClaim`: the claim cannot be read back | no: a row is never deleted, so the read-back finds nothing only on a vanished row; pinned by calling it |
| `x402.ts:1299` | `recordSettledPayment`: settled, the treasury line failed | yes |
| `settlement-claims.ts:233` | `takeClaim`: the claim cannot be read back after a conflict | no: its only caller (`x402.ts:607`) catches the throw and answers from a re-read, so the marker is never served; pinned by calling it with an env whose INSERT reports a conflict and whose read finds nothing |
| `listings.ts:548` | listing fee settled, the listing failed to save | yes |
| `listings.ts:1091` | bounty settled, booking failed | yes |
| `register-gate.ts:495` | registration fee settled, registration did not complete (one throw, two message arms) | yes, both arms |
| `register-gate.ts:301-302` | `assertValidHandle` / `assertValidModel` in `finishRegistration`, AFTER the money moved: re-marked at that call (not in `society.ts`) | yes, by a settled_unbooked claim whose stored intent no longer validates, finished by the identical re-send |

The last row is not on the commission's list. The two assertions are deterministic backstops (the same values passed them before any 402), so they cannot fire for a row this route wrote, but a refusal
there is a money answer and the sweep demands it be marked or excluded with a reason. They cannot be marked at the throw (`society.ts:503`, `:517`): the same two functions also refuse free, before any
payment, and those are not money answers. So `finishRegistration` catches the SocietyError and rethrows a copy with the same status, message and code and the marker.

**Swept and NOT marked, with the reason** (every `new SocietyError(` in `x402.ts`, `settlement-claims.ts`, `listings.ts`, `register-gate.ts`, and the `society.ts` functions the paid path calls; lines at base):

- `x402.ts:541` (a header received that is not base64 JSON): nothing decoded, so no payment is identified, no claim can exist, nothing was sent to the facilitator. Free. Served exactly `{ error }` (pinned).
- `x402.ts:310`, `:314`, `:317` (`payment_payload_mismatch`) and `settlement-claims.ts:104` (`payment_authorization_malformed`): coded, 400, free, before `/verify` ("Nothing was sent to the facilitator"). The code is a decision field (the pay script keys on it); not a settlement code, so not on `SETTLEMENT_ANSWER_CODES`. Served `{ error, code }` as before (pinned).
- `register-gate.ts:154` (`assertHandleAvailable`, 409): it is the free Step 2 check before any 402 AND the afterVerify hook. The hook is after the header is parsed and `/verify` answered but before the claim and `/settle`. Free either way. Marking the throw would put `answered_by` on a stranger's unpaid refusal. Pinned: served `{ error }` when the handle is taken between the free check and `/verify`.
- `listings.ts:918-921` (the reservation refusal, 409, "Nothing was settled."): afterVerify, before the claim and `/settle`. Free. Pinned the same way.
- `society.ts:700`, `:712` (`assertListingCreateNotThrottled`, 429): listing create's afterVerify and also its free pre-402 check. Free, before the claim. `society.ts:549`, `:555` (`assertRegistrationNotThrottled`): called only before `payAndSettle`. Free.
- Everything in `listings.ts` and `register-gate.ts` thrown BEFORE `payAndSettle` is called (request-body and field validators, the wallet pin and payee checks, `listings.ts:720-810`, the invite checks, the submission and withdraw routes): these run identically with or without a payment header and refuse before `/verify`, so they are not answers to a payment.
- Already answered through the router's code list: `listings.ts:1090` (`settlement_unresolved`), `register-gate.ts:298` and `:458` (`registration_handle_taken_after_payment`).
- Plain `Error`s (not SocietyErrors, so out of this item): `x402.ts:758` (the claim cannot be read back after a first refusal's write) and `x402.ts:1202` (`ledgerReceipt`) reach the router as its generic 500 `{ error: "Internal error..." }` on register, patron and listing create, with no `answered_by`. Turning them into SocietyErrors changes a served status-and-text, which is a decision-class change; flagged `DEFERRED-PLAIN-ERROR-MONEY-ANSWERS` at `x402.ts:758` (comment only). The other plain `Error`s on the paid path (`x402.ts:790`, `:1284`, `listings.ts:534`, `:1059`, `register-gate.ts:392`, `:398`, `:429`) are thrown inside a `try` whose catch becomes one of the marked SocietyErrors above.
- `facilitator()`'s four throws are also reached from `attemptPending` through `settleOrThrow`, which catches them and reports `unchanged`: there the marker is never served. Noted in a comment at `facilitator()`.

**I2: the 402 challenge bodies are untouched.** `{ x402Version, error, accepts }` is the payment protocol's body and clients parse it. The 402s that still carry NO `answered_by`: `x402.ts:532` (no X-PAYMENT header: the invitation), `:565` (`payment_valid_before_too_far`, free), `:584` (the `/verify` refusal or invalid payment, free), `:776` (a `/settle` refusal for a caller with no claim: no production route passes none, `test/x402.test.ts` does). The 402s that DO carry it are the claim answers with `accepts` (`settlement-claims.ts:692`, `:698`, through `claimResponse`), unchanged.

**Tests** (`test/code-identity-lows-d1.test.ts`, 22): the marker (descriptor, `Object.keys`, `JSON.stringify`, spread, `errorBody` identical for a marked and an unmarked error, cannot be assigned or defined later); one test per marked site a request reaches, through the real router over real local D1 (`answered_by` LAST, `Object.keys(body)` exactly `["error", "answered_by"]`, no `code`, the pre-change status and message pinned by regex, the rest of the body equal to `errorBody` of the same error); the two unreachable sites pinned by calling them; the excluded refusals served exactly as before; a control (an unmarked uncoded SocietyError serves `{ error }`); and a source sweep (every SocietyError in the payment machinery is marked, coded or a named free refusal; every message that says the money settled is marked or coded; the marked sites are exactly 9, 1, 2 and 2 per file) with positive controls.

**Red-proofs (I1).** Each marker removed in turn (14 mutants, `scratch/code-identity-lows-builder/mutate-markers.mjs`): every one turns exactly its own site's test red, plus the sweep (the three sweep tests for the `x402.ts`, `settlement-claims.ts` and settled-message `listings.ts` sites; the count test for the `register-gate.ts` ones). Router reverted to code-only: 13 red. Marker made enumerable: 1 red (the marker test). Marker made writable and configurable: 1 red. `errorBody` serving the marker: 16 red. Marker always true: 3 red (the marker test, the excluded refusals, the control). A `code` added to the marked answer by the router: 13 red. Each restored and compared byte for byte.

**Decision invariance (I1).** The test file records status, `code` and `error` per scenario before it asserts; run against the base source (a `git archive` of `1491fb9c` in private scratch) and against this branch, the 20 recorded scenarios differ in nothing (status, code, error): 0 differences. (Against the base only the `answered_by` assertions fail, as they must: 2 pass, 20 fail, the 2 being the excluded-refusals test and the control, which assert there is no `answered_by`.)
