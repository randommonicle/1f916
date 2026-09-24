# CHECKPOINT — the server-side wallet pin wave (`DEFERRED-SERVER-SIDE-WALLET-PIN`)

Branch `wallet-pin-2026-09-24`, worktree `scratch/wt-wallet-pin` (from `main` = `4066677c`). Design:
`docs/BRIEF-SERVER-SIDE-WALLET-PIN.md` including amendments A1-A9, which override its body where they
conflict. Ben's rulings (DECISIONS.md, 2026-09-23 later notes): the pin is REQUIRED (§5 = R); A4's local
x402 payload check ships in the SAME wave. Money path: the D-018 gate before any deploy. No date is
promised anywhere (1f916 76565).

Baseline in the worktree before any edit: 1178/1178, typecheck 0 (2026-09-24 ~20:25Z).

## Plan (plan-first, stated before code)

**Files.**
- `src/society.ts` — `SocietyError` gains an optional stable `code` (third constructor argument).
- `src/index.ts` — the top-level catch serialises `{ error, code }` when a code is set; every body
  without one stays byte-identical.
- `src/x402.ts` — `assertPayloadMatchesRequirements(payload, reqs)`, exported and pure, called in
  `payAndSettle` after the decode and before `/verify`: `payload.authorization.to` against `reqs.payTo`
  (address case-folded), `payload.authorization.value` against `reqs.maxAmountRequired` (exact string);
  a missing or malformed authorization refuses. 400 `payment_payload_mismatch`. Covers all four callers
  (patron, register, listing create, listing pay).
- `src/wallets.ts` — `walletAddressFromRow(kind, detail)`, the exact inverse of `walletLogEntry`.
- `migrations/0016_wallet_pin.sql` + `schema.sql` — four additive nullable columns:
  `listing_payments.wallet_row_id`, `listing_payments.wallet_row_hash`, `listings.paying_wallet_row_id`,
  `listings.paying_wallet_row_hash`.
- `src/listings.ts` — the pay route: required pin (400 `wallet_row_required` / `wallet_row_malformed`),
  check 1 after `walletFor` (two reads; 409 `wallet_row_missing|_kind|_citizen|_superseded|_hash|_address`),
  check 2 inside the one reservation UPDATE (A5's eleven binds, A6's pair SET), the pair cleared on
  release and on paid, carried by the 502 body and both error log lines, copied to the book row, served
  in the success body; `getListingDetail` serves each submission's payee newest wallet row (A7) and the
  reserved pair while `paying` (A6); `listingPaymentsPage` serves the book row's pair and a note true of
  old and new rows; the guide's step 4 names the pin.
- `src/discovery.ts` — the pay route's description names the pin; `llms.txt` follows from it.
- `scripts/pay-listing.mjs` — both legs carry `{ submission_id, wallet_row_id, wallet_row_hash }`; a
  leg-1 refusal surfaces the server's code; the receipt check extends to the pair; the recovery message
  says reconciliation uses the RECORDED pair, never the newest row at reconciliation time.
- `docs/DESIGN-ECONOMY-V1.md` — §7.2's "the body carries only submission_id" gets a dated note (it
  becomes false under R).
- `scripts/deploy-wallet-pin.ps1` — one fail-fast script, `-DryRun` first, 0016 before the worker.

**Tests** (each red-proofed by a mutation that changes what it observes, restored byte-exact; L-079).
- `test/x402.test.ts` — the pure check: match; `to` mismatch; `value` mismatch; case-folded address
  passes; missing/malformed authorization; non-string value.
- Harness sweep: every fake X-PAYMENT becomes a real-shaped payload bound to its request's own payTo
  and amount; every test wallet is declared WITH its chained identity row (the real `appendChained`),
  so pay tests carry a real pin.
- `test/wallet-pin-d1.test.ts` (new) — brief §6 tests 1-11 and A5's per-clause refusals: happy path
  (book row, success body, payments page carry the pair); each check-1 refusal before any 402 or
  facilitator call; CODEX's counterexample (table B, chain A, `wallet_row_address`); the race (a
  `wallet_changed` appended during /verify: reservation 0 rows, 409, nothing settled, still `open`);
  the stored hash rewritten during /verify; the helper's shapes; historical NULL rows; A6 recovery
  (502 keeps and serves the pair, release clears it, success copies it); A7 served newest row; A4 on
  both the pay route and registration.
- `test/listings-migration-d1.test.ts` — the drift detector applies 0016 too.
- `test/listings-policing.test.ts:89` — the one-field invariant becomes the three-field invariant, as
  ruled (R); the payTo/amount scan at :61 stays.
- Parity: the server helper and the script's `walletRowAddress` agree on one fixture set.
- Non-minting: the existing v5 pin (`test/topics-d1.test.ts`) stays green.

**No new dependencies.**

**Out of scope (flagged in the brief §9):** signed intents on the submission, the declaration and the
book row; a public log of refusals; making the two wallet writes atomic; any date.

## Commits

(one note per commit below, as they land)

**1. A4, the local x402 payload check, and `SocietyError.code`.** `payAndSettle` now calls
`assertPayloadMatchesRequirements` after the decode and before `/verify`; all four callers inherit it.
`SocietyError` gains an optional `code`; `errorBody` serialises `{ error }` exactly as before when there
is none and `{ error, code }` when there is (the prose stays in `error`, so no reader of the sentence
breaks; the pay script will read `code`). Harness sweep: `test/helpers/x402-payload.ts` builds a
real-shaped `exact` payload; the listings create/pay requests and the registration request now sign for
the route's own payTo and amount (the pay helper reads both from the DB exactly as the route derives
them). Tests: six in `test/x402.test.ts` (the pure check's shapes, the in-`payAndSettle` refusal with a
positive control, `errorBody`), one ride through registration, one through the pay route. 1186/1186,
typecheck 0. Red-proofs (restored byte-exact, sha256 `a66876a0…`): M1 the call removed, 3 red; M2 the
address comparison disabled, 4 red; M3 the value comparison disabled, 3 red. Decision: the value is
compared as the scheme's decimal string, so a number-typed `1000000` refuses (the brief's "exactly as a
string"; our own clients and x402's send strings).
