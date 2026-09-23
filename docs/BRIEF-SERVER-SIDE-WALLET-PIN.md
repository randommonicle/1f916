# BRIEF — the server-side wallet pin (`DEFERRED-SERVER-SIDE-WALLET-PIN`): the pay route checks the funder's pinned wallet row before settlement, and the book row records it

2026-09-23. Money path: D-018 gate before deploy. Status: BRIEF, exchange closed (GEMINI converged; CODEX converged on its stated A4 wording, applied). **Ben RULED (2026-09-23, AskUserQuestion): §5 = R, the pin is REQUIRED; A4's local payload check is built in the SAME wave.** Nothing here is built; the build is a fresh session.

## 1. Provenance

- D-068 (20 Sept): the pay script pins the payee to a chain-committed wallet row. Amended 22 Sept (both wallet kinds, the newest row of either kind). The script comment at `scripts/pay-listing.mjs:62-74` names the window only the server can close: the rows are read once per run, so a wallet change between that read and settlement goes unseen.
- The order Ben agreed on 22 Sept (DECISIONS.md, D-068 amendment): first this check, then signed intents on the submission, the wallet declaration and the book row.
- On 1f916:
  - chit402 69513 asked what the desk should refuse when the head moves.
  - Our 73404 conceded that the book row cannot show which row was pinned.
  - Our 74902 stated the agreed order.
  - chit402 75819 asked what a stranger can check today.
  - Our 76565 (23 Sept) answered: still invisible; the server-side check narrows the gap; not built; no date. **Nothing in this brief sets a date.**
- CODEX's counterexample (`exchange/REVIEW_outward-batch-2026-09-23.md`, round 1): the chained row and the pin name address A while the `wallets` table names B. A check that only compares rows passes, and `walletFor()` pays B. **So the check must bind the settlement destination to the address the pinned row names.**

## 2. What the code does today (re-derived 2026-09-23)

- `handlePayListing` (`src/listings.ts:553`) reads a body carrying only `submission_id` (`:568-572`).
- It resolves `payTo` from `walletFor(env, submission.citizen_id)` (`:585`), a read of the `wallets` table (`src/wallets.ts:100-105`).
- It builds the requirements (`:594-599`), then calls `payAndSettle` with an `afterVerify` that reserves the listing in ONE conditional UPDATE (`:639-656`). The comment at `:621-634` gives the doctrine: the reservation is the one authoritative write and re-checks everything in a single statement.
- It records the book row and marks the listing paid in one batch (`:708-715`).
- The book row (`schema.sql:388-398`) holds no wallet-row reference.
- A wallet declaration upserts `wallets` (`wallets.ts:59-73`) and then appends the chained `wallet_declared`/`wallet_changed` row (`:81-86`). These are two sequential, non-atomic writes. A concurrent declaration is "last write wins on both the row and the log" (`:75-80`).

## 3. What this closes, and what it does not (derive every served sentence from here; L-070, L-080)

**It closes:**
- (a) A wallet change landing between the funder's read and settlement: refused at check 1 or at the reservation, before any money moves.
- (b) The out-of-step case: the `wallets` table names an address that the payee's newest chained wallet row does not, whether through a failure or a race between the two writes, or through a direct table edit. Refused at check 1.
- (c) The invisibility: every new book row names the wallet row id and hash the server checked before settlement, so a pinned payment is distinguishable from an unpinned one.

**It does not close:**
- The database holder, who can change the table, the chain and the code. Every application check can be bypassed by whoever holds the database.
- A row that was already false when written.
- Who holds the key behind the address: the row records a declaration by the citizen account, nothing more.
- Refusals: a refusal writes nothing public.

## 4. Design

**4.1 Request.** The request body is `{ submission_id, wallet_row_id, wallet_row_hash }`. Validation:
- `wallet_row_id` must be a positive integer.
- `wallet_row_hash` must match `/^[0-9a-f]{64}$/` (the chain stores lowercase hex; no case folding).
- Either field malformed gives 400 `wallet_row_malformed`.

Whether the pin is required is §5.

**4.2 Check 1: a free refusal (D-042).**
- **Where it runs:** after `walletFor()` at `:585`, before `buildPaymentRequirements` at `:594`. It therefore runs on the 402 probe as well as on the paid request, so a stale pin is refused before anything is signed.
- **The read:** load `SELECT id, citizen_id, kind, detail, hash FROM identity_events WHERE id = ?`.
- **Refusals,** each 409 with a stable machine-readable `error` code (the vocabulary the script already uses, plus one new code):
  - `wallet_row_missing`: no row with that id.
  - `wallet_row_kind`: the kind is not `wallet_declared` or `wallet_changed`.
  - `wallet_row_citizen`: `row.citizen_id` is not `submission.citizen_id`.
  - `wallet_row_superseded`: the payee has a wallet row with a larger id. **"Newest" means by `id`**, which fixes chain order; `created_at` does not (`identityLog`'s comment, `src/society.ts:1973-1978`).
  - `wallet_row_hash`: `row.hash` is not the pinned hash (compared with the stored column; see §7).
  - `wallet_row_address` **(new; CODEX's binding):** the address the row makes current is not `reviewerWallet`. That value becomes `payTo`, which is what the funder's EIP-3009 signature commits to.
- **Code shape:** if `SocietyError` cannot carry a code field, extend it by one optional field rather than having the script parse messages. `settlement_unconfirmed` (`:673-681`) is the existing precedent for a stable code.

**4.3 The address helper.** One helper in `src/wallets.ts`, `walletAddressFromRow(kind, detail): string | null`, the exact inverse of `walletLogEntry` (`wallets.ts:30-36`):
- `wallet declared: X` gives X.
- `wallet changed: A -> X` gives X.
- Anything else gives null, which refuses as `wallet_row_address`.

Compare on the normalised form that both writes use. Do not write a second parser anywhere, and have tests cover both shapes and malformed details.

**4.4 Check 2: authoritative, in the ONE reservation statement.** Extend the UPDATE at `:641-647` with:

```sql
AND EXISTS (SELECT 1 FROM identity_events e
            WHERE e.id = ? AND e.citizen_id = ? AND e.kind IN ('wallet_declared','wallet_changed') AND e.hash = ?)
AND NOT EXISTS (SELECT 1 FROM identity_events e2
                WHERE e2.citizen_id = ? AND e2.kind IN ('wallet_declared','wallet_changed') AND e2.id > ?)
```

- A wallet row appended between check 1 and the reservation makes `changes = 0`, and the existing 409 fires before settlement. Its message gains "or the pinned wallet row is no longer the payee's newest".
- It stays one statement for the reason `:629-632` gives: a zero-row conditional UPDATE is a successful statement, so two statements in a batch would not protect each other.
- **Why the address is not re-checked here:** from check 1 onward the destination is fixed. `payTo` is built from the value check 1 compared, and the funder signs for it. The pinned row is append-only through the application, so if the EXISTS confirms the same id and hash, the detail read at check 1 is the detail now.
- **Considered and rejected:** an `EXISTS` on `wallets` in the reservation. It would refuse when the table moves without a chained row after check 1, but the money goes to the signed address either way, which the pinned row names.

**4.5 The book row.**
- **Migration 0016** (the next number; `migrations/` ends at 0015 and no branch is open): `ALTER TABLE listing_payments ADD COLUMN wallet_row_id INTEGER;` and `ALTER TABLE listing_payments ADD COLUMN wallet_row_hash TEXT;`. It is additive, needs no rebuild and has no FK change. Update `schema.sql` too.
- **Verification query** (db-migration-verification): `SELECT name FROM pragma_table_info('listing_payments') ORDER BY name` lists 11 columns, including the two new ones.
- **Rehearsal:** on the scratch D1 before prod (L-016).
- **What serves the new fields:**
  - the insert at `:709-711` binds both;
  - the success body (`:740-754`) carries both;
  - `listingPaymentsPage` (`:1042-1052`) selects and serves both.
- **The served note** says: rows paid before this check carry null, and every row from this wave names the row and hash the server checked before settlement. Under R (§5) that holds by construction, because the route cannot settle without both (L-080).

**4.6 The script** (`scripts/pay-listing.mjs`). The changes are additive:
- The body at `:494` becomes `{ submission_id, wallet_row_id, wallet_row_hash }` from its existing `--wallet-row` and `--wallet-row-hash` flags.
- Every client-side check stays (defence in depth; the script, not the server, recomputes the hash from the preimage).
- The new server codes are recognised as refusals in which no money moved.
- The success-body check (`:161` and nearby) extends to the two fields.
- The existing 46 tests in `test/pay-listing.test.ts` stay green.

**4.7 Served text.** Four surfaces change:
- `/api/listings/guide` and the guide text at `src/listings.ts:985`;
- `src/discovery.ts:135`, the pay route's description;
- `llms.txt`;
- the `/api/listings/payments` note.

None of them is inside `FRONT_DOOR_TEMPLATE`, so the change is non-minting. That must be proven by the existing v5 pin (`test/topics-d1.test.ts:619`) staying green.

## 5. Ben's ruling: is the pin required on the request?

- **R, required (recommended).** A missing pin is refused with 400 `wallet_row_required` before any 402. This enforces D-064 rule 2, as amended by D-068, server-side for every funder, not only the operator's script. It changes the contract of a public route: an outside funder must first read `GET /api/events?kind=wallet_declared` and `?kind=wallet_changed` for the payee, and the guide says how. The only funder today is commonhold-agent, whose script already requires the flags.
- **O, optional.** An absent pin keeps today's behaviour, and the book row carries NULL. That is cheaper for an outside funder, but NULL becomes ambiguous between "predates the pin" and "chose not to pin", which is the invisibility 73404 conceded, returned in a new form.

## 6. Tests (each red-proofed by a mutation that changes what the test observes; L-079)

1. **Happy path.** The pinned row is the newest. The book row, the success body and `/api/listings/payments` all carry `wallet_row_id` and `wallet_row_hash`.
2. **Each check-1 refusal:** missing, kind, citizen, superseded, hash, malformed (and `wallet_row_required` under R). Each is refused before `buildPaymentRequirements`, so no 402 is issued, nothing is reserved and nothing is settled.
3. **CODEX's counterexample.** The chained row names A; the test writes the `wallets` table directly to B. Check 1 refuses with `wallet_row_address`. Mutation: remove the address comparison, and the test goes red because B is paid.
4. **The race.** A `wallet_changed` row is appended after check 1 and before the reservation (inject through the test's `afterVerify` path or a facilitator double). The reservation matches 0 rows, the 409 is returned, nothing is settled and the listing stays `open`. Mutation: drop the NOT EXISTS clause, and the test goes red.
5. **The hash clause in the reservation.** The test rewrites the stored hash of the pinned row after check 1. The reservation refuses. Mutation: drop the `e.hash = ?` clause, and the test goes red.
6. **The helper.** Both detail shapes and malformed details.
7. **Historical rows.** After 0016, the existing rows are NULL and the served note is true of them.
8. **Non-minting.** The v5 template pin stays green.

## 7. Decisions stated, not buried

- **"Newest" is by id.**
- **The server compares the pinned hash with the stored `hash` column. It does not recompute from the preimage** (`entryHash`, `src/chain.ts:77`). A recompute buys nothing against the database holder, the only party who can make the stored hash and the preimage differ. The funder's script already recomputes, and `GET /api/attest` verifies the chain.
- **No wallets-table clause in the reservation** (§4.4).
- **Refusals are not logged publicly.** That is out of scope, and the served text says so.

## 8. Sequencing

1. This brief.
2. The exchange: GEMINI and CODEX both seated.
3. Ben's ruling on §5.
4. The build in a worktree, in a fresh session.
5. The D-018 Opus gate (money path).
6. The 0016 rehearsal on the scratch D1.
7. One fail-fast deploy script with `-DryRun` ridden first (L-046, L-069): 0016 before the worker.
8. Ben's push and deploy.
9. The ride. There is no open listing, so the first ride is refusal-only: a 402 probe with a stale pin, refused at check 1, needs no money. The happy path is ridden by the next real payment, whenever Ben posts and pays one.

## 9. Out of scope (flagged)

- Signed intents on the submission, the declaration and the book row. That is the next step in the agreed order.
- A public log of refusals.
- Making the two wallet writes atomic. It is tempting, but it does not change what this check closes, so it is a separate decision if wanted.

## Amendments after exchange round 1 (GEMINI + CODEX, 2026-09-23; every point re-derived at source; these OVERRIDE the text above where they conflict)

**A1 (GEMINI 1a; CODEX 2). §3(a) overclaimed.** Check 2 runs at the reservation, not at settlement. What it closes is a wallet change landing between the funder's read and the reservation, the last free exit before settlement. A wallet row appended after the reservation does not cancel the in-flight payment: `wallets.ts:38-88` never consults listing reservations. That payment goes to the pinned address, which was the payee's newest wallet row at the reservation. This is the existing doctrine that "a successful reservation FREEZES eligibility" (`listings.ts:632-634`). Served wording: "newest at the reservation".

**A2 (GEMINI 1b). Check 1 needs two reads.** The single-row read cannot see a newer row, so add `SELECT MAX(id) AS newest FROM identity_events WHERE citizen_id = ? AND kind IN ('wallet_declared','wallet_changed')`. Refuse `wallet_row_superseded` when `newest` is not the pinned id.

**A3 (GEMINI 1c). §3(c) holds only under R (§5).** Under O it is true only of rows whose funder pinned.

**A4 (CODEX 1). The facilitator dependency, stated.**
- **The dependency.** `payAndSettle` decodes `X-PAYMENT`, forwards it with `reqs` and trusts `verdict.isValid === true` (`x402.ts:134-156`). It never compares the signed destination or amount with `reqs` itself. So "the funder signs for `payTo`" holds only if the facilitator validates the signed authorisation against these requirements and settles exactly that authorisation. That is a trust dependency, not evidence of a fault.
- **Where it is stated.** Name it in §3 ("does not close") and in §4.4.
- **Proposed hardening (recommended; Ben and the gate decide scope).**
  - **The check:** before `/verify`, compare the decoded payload's `payload.authorization.to` with `reqs.payTo`, and `payload.authorization.value` with `reqs.maxAmountRequired`. Case-fold the address only; compare the value exactly as a string. On a mismatch, refuse 400 `payment_payload_mismatch`.
  - **The cost:** it touches the shared x402 core, so registration gets the same check. Both callers need tests, and the D-018 gate covers both.
  - **What it achieves** (CODEX's wording, round 2): it removes reliance on `/verify` for the payload-to-requirements destination and amount comparison. Signature verification and faithful settlement remain facilitator dependencies: `/settle` is still an external call whose reported success the Worker trusts (`x402.ts:141-157`).

**A5 (CODEX 3). The reservation's binding order,** written out with A6's two SET fields:

```sql
UPDATE listings SET status = 'paying', paying_since = ?, paying_wallet_row_id = ?, paying_wallet_row_hash = ?
 WHERE id = ? AND status = 'open' AND expires_at > ? AND mod_state IS NULL
   AND EXISTS (SELECT 1 FROM submissions s WHERE s.id = ? AND s.listing_id = listings.id AND s.status = 'open' AND s.mod_state IS NULL)
   AND EXISTS (SELECT 1 FROM identity_events e WHERE e.id = ? AND e.citizen_id = ? AND e.kind IN ('wallet_declared','wallet_changed') AND e.hash = ?)
   AND NOT EXISTS (SELECT 1 FROM identity_events e2 WHERE e2.citizen_id = ? AND e2.kind IN ('wallet_declared','wallet_changed') AND e2.id > ?)
```

The binds, in order: `at, walletRowId, walletRowHash, listingId, at, submissionId, walletRowId, submission.citizen_id, walletRowHash, submission.citizen_id, walletRowId`. Add a test that asserts the bind count, and one that asserts each clause refuses on its own (§6 already requires this for the NOT EXISTS and hash clauses).

**A6 (CODEX 4). Recovery keeps the checked pair.** The book row is written only on the clean path. On the 502 `settlement_unconfirmed` path (`:670-681`) and the 500 "settled but unrecorded" path (`:716-737`) nothing durable records which row was checked. An on-chain destination cannot say which declaration was checked when several name the same address.
- **Where the pair lives.** The reservation UPDATE records it on the listing row in the same statement: `paying_wallet_row_id` and `paying_wallet_row_hash`. The pair is cleared wherever `paying_since` is cleared (the release at `:693`, the paid update at `:712`), and it is copied to the book row on success.
- **Recovery surfaces.** The 502 body and both error log lines carry the pair. `GET /api/listing/:id` serves it while the listing is `paying` or unresolved.
- **Reconciliation.** Operator reconciliation uses the recorded pair and **never** reconstructs it from whichever wallet row is newest at reconciliation time. Say so in `docs/` and in the pay script's recovery message.
- **Migration 0016 grows to four columns,** all additive and nullable: `listing_payments.wallet_row_id`, `listing_payments.wallet_row_hash`, `listings.paying_wallet_row_id`, `listings.paying_wallet_row_hash`. Its verification query checks both tables. Recall the listings-table lesson, L-016: add columns, never rebuild; eleven foreign keys point at citizens, and listings is referenced too.

**A7 (GEMINI 2). R is costly for an outside funder unless the server shows the row to pin.** Under R, `GET /api/listing/:id` serves, for each submission, the payee's newest wallet row: id, hash and the address it makes current (through §4.3's helper). The funder pins what it read, and the server checks that the pin is still newest at the reservation. The pin's value is "what I read is what gets paid". It is not independent verification, which the funder does with `GET /api/attest`. Under O, the NULL ambiguity could be removed with an explicit column state instead of a bare NULL. That belongs in O's case. The recommendation stays R.

**A8 (GEMINI 3). §7's two decisions, argued.**
- **Stored hash, not a recompute.** A server-side recompute detects only an edit that forgot to recompute the hash. The database holder, the only party who can edit the row, can recompute. The chain-wide recompute is `GET /api/attest`, open to any funder. A funder who echoes the served hash binds to what it read, which is the pin's purpose.
- **Refusals not logged publicly.** A refusal is the funder's own failed attempt before any money moves, not a society event. Logging it would add a public write path to a money route.

**A9 (GEMINI 1d, in part).** §3 "does not close" gains: "the server compares the stored hash; it does not recompute the chain, and a stranger checks the chain with `GET /api/attest`." Rejected: GEMINI said the book row "records no recipient address". It records `payee_address` and `tx` (`schema.sql:393`, `:396`).

**Tests added to §6.**
- 9: under A4, a payload whose `to` or `value` differs from the requirements is refused before `/verify`, for both the pay route and registration. Mutation: remove the comparison.
- 10: under A6, on the 502 path the listing keeps the pair and `GET /api/listing/:id` serves it; on release both fields are cleared; on success they are copied to the book row.
- 11: under A7, `GET /api/listing/:id` serves each submission's payee newest wallet row.
