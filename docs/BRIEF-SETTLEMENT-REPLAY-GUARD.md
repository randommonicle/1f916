# Brief: one settlement is booked once (gate M2, wave B retrospective)

Status: Ben RULED option B (2026-09-30). Exchange CONVERGED (GEMINI r2; CODEX r3 edits applied as the round 3 amendments). The sections from "Option B as designed in exchange round 1" to the end OVERRIDE the body, later sections over earlier. Not built. OPEN for Ben: require public_key on every registration (B5b).
MONEY PATH: the D-018 gate for the build is Opus. Exchange both seats before any builder reads it.

## The gap

`docs/REVIEW-X402-SETTLE-HONESTY-GATE-2026-09-29.md` M2, re-derived by the hub:

- Nothing server-side stops one settlement being booked twice. `ledger` has no transaction column
  (`schema.sql:111-121`; the tx lives only inside `description`, e.g. `registration 0x…: handle "…"; tx 0x…`,
  `src/register-gate.ts:221`, `src/x402.ts:575`), and no route checks whether a tx, or the signed
  authorisation's `(from, nonce)`, was already booked.
- On `/api/register` and `/api/patron` the facilitator request is byte-identical for every request
  that reuses one `X-PAYMENT` header (the requirements do not depend on the handle,
  `src/register-gate.ts:179-185`; `rpcBody`, `src/x402.ts:403`).
- PayAI's own documentation, read by the hub 2026-09-30
  (`https://docs.payai.network/x402/facilitators/capacity-and-limits.md`, lines 96-99): to learn an
  outcome, "re-POST the exact same payload"; while in flight it answers `409 duplicate_settlement`;
  "Once the attempt resolves, the facilitator serves the recorded outcome: the cached success
  response (including the transaction hash) if the payment landed".
- So if PayAI's `/verify` passes an authorisation whose nonce is already used on chain (UNVERIFIED;
  nobody has observed it), a payer who replays their own signed header with a second handle gets
  our rule 4 (`src/x402.ts:259`) reading the cached success as settled: a second citizen and a
  second ledger line for one on-chain dollar. Payers are never harmed; the $1 registration toll
  (D-062) is what is lost, and `booked_cents` overstates what reached the treasury.

## Option A: no migration (code only)

After `/settle` answers settled and BEFORE any booking, look for an existing ledger row whose
description ends `; tx <this tx>` (and, for pay listing, an existing `listing_payments` row with this
tx). If one exists, refuse: 409, "this payment (tx …) is already booked to <what>; nothing new was
charged, and nothing was created". Log one line. Cheap, deployable under a worker-only deploy.
**Limit, stated:** check-then-act. Two replays that both clear PayAI after it resolves, and reach the
check before either books, can both book. PayAI answers `409` while the first is in flight, which
narrows but does not close the window. The match is on a substring of free text.

## Option B: migration (closes the race)

A table `settlement_claims(network, asset, from_addr, nonce, route, created_at, PRIMARY KEY(network,
asset, from_addr, nonce))`. In `afterVerify`, BEFORE `/settle`, INSERT the signed authorisation's
`(from, nonce)`; a UNIQUE conflict refuses the request with no settle attempt (a replay costs the
facilitator nothing and moves no money). **Open design point (must be settled before build).** The claim cannot simply stay put on every outcome.
On an UNKNOWN outcome (transit failure, 5xx, `settlement_pending`) the money may have moved: telling the
payer to sign a fresh authorisation is the double payment wave B's F7 closed, and re-sending the SAME
payload is exactly what PayAI's reconciliation path expects, which a bare claim would refuse. So the claim
needs a state (`pending`, `settled`, `refused`): `refused` (a recorded refusal) releases it like the
listing reservation does; `pending` is reconciled by OUR server re-POSTing the exact stored payload to
`/settle` (never by a new signature), and only a `settled` answer books; `settled` is final and refuses
every replay. This changes the migration's shape (a state column and the stored payload), so it is
decided here, not in the build. Migration 0017 (additive), Ben's act; deploy order: migration
first, then worker (L-046, one fail-fast script).

## Recommendation

B, because the sybil cost of the $1 door is a standing public commitment (D-062) and only a UNIQUE key
makes "one dollar, one seat" true by construction. A is a stopgap if B waits more than a week.
Neither is urgent on today's evidence: no replay has been observed, and the live door has settled 13
registrations, each with its own tx (`GET /treasury`).

## Tests (either option; real D1, facilitator stubbed via `globalThis.fetch` as the existing x402 tests do)

- A replayed identical `X-PAYMENT` whose `/settle` answers the cached success with the SAME tx:
  second request creates no citizen and no ledger row, answers 409, logs one line. Red-proof: remove
  the guard -> a second citizen.
- (B only) The replay is refused BEFORE `/settle` is called (the stub records no second settle call).
- (B only) Two concurrent requests with one header: exactly one reaches `/settle`.
- A fresh authorisation from the same payer (new nonce) still registers.
- Pay listing: unchanged behaviour (it already reserves the listing), plus the same-tx check.
- Non-minting.

## Out of scope

The classifier (`classifySettle`), the listing reservation, the payer scripts, any refund route.

## Option B as designed in exchange round 1 (Ben RULED B, 2026-09-30; this section OVERRIDES option B above and the "Open design point")

Exchange: `exchange/REVIEW_settlement-replay-guard-brief-2026-09-30.md` (CODEX r1, GEMINI r1). The classifier is now IN scope (B8).

- **B1 The claim row.** Migration 0017, table `settlement_claims`: `network, asset, from_addr, nonce` (PRIMARY KEY together), `route` (`register` | `patron` | `listing_create` | `listing_pay`), `intent_json` (the business intent as it stood when claimed: handle, model, public_key; the patron line; the listing fields; for pay listing the listing id, submission id and pinned wallet row), `rpc_body` (the exact `/settle` request body), `valid_before`, `state`, `tx`, `verdict_reason`, `booked_refs` (what booking has durably written: ledger row id, citizen id, listing id, payment row id), `created_at`, `updated_at`, `lease_owner`, `leased_until`.
- **B2 States.** `pending` (settle outcome unknown) -> `settled_unbooked` (the facilitator said settled; tx recorded; the paid act not yet fully written) -> `booked` (every write of the paid act is durable; terminal). `refused` (a recorded refusal, classifier rule 7 only; terminal). `expired` (terminal; see B6). No other transitions.
- **B3 Where it is taken.** In `afterVerify`, after a successful `/verify` and after every free business check (handle free; listing open; the listing reservation), immediately before `/settle`. A handle collision or any free-check failure leaves NO claim. On pay listing, the `open -> paying` reservation and the claim INSERT succeed or fail together (one batch, or an explicit revert of the reservation before rethrowing), so a claim conflict can never strand a listing in `paying` (`src/listings.ts:754-803`).
- **B4 A conflict on the key.** Same `(network, asset, from, nonce)` already claimed: if `rpc_body` is byte-identical, answer by that row's state and call NO `/settle`: `booked` -> 409 "this payment (tx ...) was already used for <route intent>; nothing was charged again"; `refused` -> the recorded refusal; `expired` -> "this authorisation expired unused; sign a fresh one"; `pending` -> 502 "outcome still unknown; do not sign again; this request changed nothing"; `settled_unbooked` -> finish booking (B5) and answer as the original act would have. If `rpc_body` differs (a second route or body reusing one nonce) -> 409 conflict, no `/settle`.
- **B5 Finishing a paid act (`settled_unbooked`).** Booking resumes idempotently from `booked_refs`: each write is skipped if already recorded (a ledger row with this tx; a citizen created by this claim, recognised by `booked_refs`, never by handle alone, because `register()` 409s on an existing handle, `src/society.ts:813-817`). Registration in SECRET mode delivers its credential only in a 201, so it is finished by the payer's own identical re-send (B4), which can receive it; the reconciler finishes every other route, and for a secret-mode registration it books nothing further and leaves the row `settled_unbooked` for the payer's re-send. Only `booked` refuses every replay.
- **B6 Reconciliation of `pending`.** One leased reconciler: a row is worked only by the holder of an unexpired lease (`leased_until`, a TTL, so a crashed worker cannot wedge a row). Runs in the existing 06:00 cron (no schedule change); a payer's identical re-send may also take the lease and run one attempt. Each attempt first reads the chain: USDC `authorizationState(from, nonce)` on Base (two RPCs must agree). Used -> the money moved: re-POST the stored `rpc_body` to `/settle` (PayAI's documented reconciliation) to obtain the tx, and on a success answer move to `settled_unbooked`. Unused and `now > valid_before` -> `expired` (the authorisation can no longer move money; the chain proves it). Unused and still valid -> re-POST the stored body and classify as today. Expiry alone never proves anything: the chain read decides. **For Ben:** a more frequent schedule than daily 06:00 is a cron change and his call.
- **B7 Custody of `rpc_body`.** It is an executable authorisation until `valid_before`. No route serves it; only reconciliation code reads it; it is set to NULL when the row reaches a terminal state (`booked`, `refused`, `expired`).
- **B8 Classifier (gate L1 and L3, now in scope).** `duplicate_settlement` and `settlement_pending` are compared after `trim()` and case-folding, and read as unknown (-> `pending`) at ANY status, never as a refusal; every unknown-outcome message ends with "do not sign again" (L3). L2's `/verify` wording ("nothing that could settle was sent") is corrected in the same wave.
- **B9 Caller messages.** Every state's answer names the tx when one is known and never invites a second signature except `expired` and `refused`.

## Tests (replace the Tests section above)

Real D1 via the existing harness; the facilitator and the RPC stubbed through `globalThis.fetch` as the x402 tests already do. Each guard removed in turn must turn a test red.
1. Identical replay after `booked`: no `/settle` call, no second citizen or ledger row, 409 naming the tx. 2. Divergent body reusing `(from, nonce)`: 409, no `/settle`. 3. Two concurrent requests with one header: exactly one reaches `/settle`. 4. Every classifier outcome maps to its state (rule 4 -> `settled_unbooked` -> `booked`; rule 7 -> `refused`; rules 1-3, 5, 6, 8, transit, unreadable -> `pending`), including 200 `duplicate_settlement` and `" Settlement_Pending "` -> `pending`. 5. Ledger append fails after settle -> `settled_unbooked`; identical re-send finishes it once (ledger row once, citizen once, secret delivered for secret mode). 6. A crash between the ledger row and the citizen: resume writes the citizen only. 7. Reconciler: chain says used -> re-POST -> `settled_unbooked` -> booked; chain says unused and past `valid_before` -> `expired`; the two RPCs disagree -> no transition. 8. Lease: a live lease blocks a second worker; an expired lease does not. 9. Handle collision: no claim row. 10. Pay listing: claim conflict after reservation leaves the listing `open`, in both orders. 11. `rpc_body` is NULL on every terminal row and appears in no route's response. 12. A fresh authorisation (new nonce) from the same payer still registers. 13. Non-minting.

## Deploy

Migration 0017 FIRST (Ben's act), then the worker, in one fail-fast script that fetches, pins the expected commit and captures the wrangler version id (gate L6, C2). Includes the M1/C2 branch (`fix-post-payment-pointer-2026-09-30`). Opus D-018 gate before deploy.

## Round 2 amendments (CODEX r2; these OVERRIDE B4-B6 above where they differ)

- **B4a Identity of a request.** A request matches a claim only if BOTH its `rpc_body` and its business intent match: the registration requirements omit the handle (`src/register-gate.ts:179-185`), so the same signed header with a different handle has an identical `rpc_body` and must be treated as DIVERGENT (409, no `/settle`). The row keeps `rpc_body_hash` and `intent_hash` permanently, so the comparison still works after B7 clears `rpc_body` on a terminal row.
- **B5a Atomic references.** Each booking write that creates a row (the citizen INSERT; the listing INSERT; the payment row) runs in ONE D1 batch with the UPDATE that records it in the claim's `booked_refs`, so no crash can leave a created row the claim does not know about. Test 6 adds that crash point (the batch fails as a unit: neither row exists).
- **B5b Secret-mode registration, stated plainly.** A secret credential exists only in the 201 that carries it (the database keeps its hash, `src/society.ts:799-817`). This design prevents a second charge and a second citizen; it cannot recover a lost 201. Two cases: (i) booking failed before the citizen existed: the payer's identical re-send finishes booking in that request and receives a fresh secret, no `/settle`; (ii) the citizen was created and the response was lost: the claim is `booked`, the seat exists, and its secret cannot be re-sent. That is today's property of secret mode, now named in the served message ("your seat exists; its secret was delivered once and cannot be sent again; register with a public_key to avoid this"). The reconciler never books a secret-mode registration past `settled_unbooked` (it cannot deliver the secret); the row waits for the payer's re-send and the served text says so. **For Ben (a product choice, not built unless ruled): require `public_key` on every registration, which removes case (ii) and the waiting row entirely.**
- **B6a The 06:00 backstop, bounded.** The reconciler is a BACKSTOP: a `pending` or `settled_unbooked` row can wait until the next 06:00 UTC run, and every served message for those states says so. The 06:00 invocation shares the Worker's 50-subrequest budget with governance and the maintainer (`src/index.ts:547-585`), so reconciliation takes a fixed batch (at most N rows, N sized to leave the others their budget), reserves its own subrequests, logs one line per row failure, and a failing row never stops later rows (new test 14). The payer's identical re-send (B4) is the earlier route, not the only one.

## Round 3 amendments (CODEX r3; OVERRIDE B5a, B5b and B6a where they differ)

- **B5c The ledger too.** The treasury ledger row (inserted through `appendChained`, `src/x402.ts:485-493`, `src/chain.ts:172-183`) commits in the same D1 batch as the claim's `booked_refs` update, like every other row-creating booking write; test 6 adds the crash point between the ledger insert and the reference update (the batch fails as a unit).
- **B5d Secret-mode wording.** Case (ii)'s message: "your seat exists; a response containing its secret was issued, but the secret cannot be recovered. Reach the maintainer with this tx (a free showhome note: POST /api/showhome/enter, then POST /api/showhome/note). For any future registration, send a public_key." It never says the secret was delivered, which the server cannot know.
- **B6b The backstop promise excludes secret mode.** Served messages promise resolution by the next 06:00 UTC run only for rows the reconciler can finish; a secret-mode `settled_unbooked` row's message says it waits for the payer's identical re-send and names no deadline.
