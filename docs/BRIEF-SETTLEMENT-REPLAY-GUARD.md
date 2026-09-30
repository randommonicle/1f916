# Brief: one settlement is booked once (gate M2, wave B retrospective)

Status: HUB DRAFT, 2026-09-30, NOT yet exchanged, for Ben's ruling (option A or B below). Not built.
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
