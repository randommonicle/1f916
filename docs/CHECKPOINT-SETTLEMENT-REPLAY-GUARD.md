# Checkpoint: one settlement is booked once (gate M2, option B as amended)

Build of `docs/BRIEF-SETTLEMENT-REPLAY-GUARD.md` (sections from "Option B as designed in exchange round 1" to the
end override the body; B10 is Ben's ruling) plus the gate's L1/L2/L3 and D-073 (2). Builder: Sonnet 5.5, branch
`m2-settlement-replay-guard-2026-09-30` in `scratch/wt-m2-replay`. One note per commit. `OPEN FOR HUB:` marks a place
where the brief was ambiguous or two sections conflicted and I took the reading that refuses a second charge and a
second citizen.

## Design decisions (fixed in commit 1, before any route was touched)

1. **Booking is a function of the claim row, not of the request.** Three callers finish a paid act: the original
   request, an identical re-send on `settled_unbooked` (B4), and the reconciler (B6). Each route gets one
   `finish*` function that reads `booked_refs`, skips what is recorded, and writes the next step; the happy path
   calls it too. Resume, replay and reconciler are the same code.
2. **A step is one D1 batch**: the gated row INSERT(s), then `UPDATE settlement_claims SET booked_refs = json_set(...)`
   (and, on the route's last step, `state='booked'`, `rpc_body=NULL`). The INSERT is gated on the claim still being
   `settled_unbooked` with that ref unrecorded, and the claim UPDATE requires `changes() = 1`, so a crashed, repeated or
   concurrent finisher can never write a step twice (`runBookingStep`, `src/settlement-claims.ts`).
3. **Claim INSERT sits inside `payAndSettle`, after `afterVerify`** (where `from`, `nonce` and `rpcBody` exist). A claim
   conflict is a DISTINGUISHABLE outcome (`SettleResult` gets a third shape), so pay listing can revert its reservation
   on a conflict instead of the existing catch turning any post-reservation throw into a kept reservation.
4. **Consult-first in each handler.** A header that matches an existing claim is answered by the claim's state BEFORE
   the free checks that would wrongly refuse a replay (register's "handle is taken" fires at step 2, before any 402).
   The INSERT-time conflict inside `payAndSettle` remains for the race the consult cannot see.
5. **Key normalised to lower case** (`from`, `nonce`, `asset`); `network` and `asset` from OUR requirements. A replay
   with a checksummed address lands on the same key. `valid_before` is unix SECONDS (as signed), clamped to a safe integer.
6. **No module cycle**: `settlement-claims.ts` (DB, state machine, lease, step runner, answers) imports no route module and
   no facilitator I/O.
7. **`rpc_body` is cleared on terminal rows by a CHECK in the table**, not by discipline, and appears in no log line.

## Commits

### 1. Migration 0017, `schema.sql`, the claim module and its tests

- `migrations/0017_settlement_claims.sql` (additive: one table, one index) and the identical block appended to `schema.sql`.
  Adds one column beyond B1's list: `payer` (the facilitator's reported payer), so a resumed booking writes the same ledger
  text as a first-time one. Adds `CHECK (state IN ('pending','settled_unbooked') OR rpc_body IS NULL)` and
  `CHECK (json_valid(booked_refs))`.
- `src/settlement-claims.ts`: key, hashes (`rpc_body_hash`, `intent_hash`, B4a), `takeClaim` (INSERT ... ON CONFLICT DO
  NOTHING, taker holds the lease), lease, conditional transitions, `runBookingStep`, B4/B9 answers.
- `src/chain.ts`: `chainHeadMovedError(table)`, the one wording of the four-times-moved 503, now shared.
- `test/settlement-claims-d1.test.ts`: 11 tests on the primitives.
- Red-proofs: see "Red-proof log" below.

### 2. Register and patron wired (B3, B4/B4a, B5/B5a-d); tests 1, 1b, 2, 3, 5, 6a-c, 9, 12

- `src/x402.ts`: `payAndSettle` takes a `PaidClaim` (route, intent, `finish`). The claim INSERT sits after `afterVerify` and
  before `/settle`; a conflict is RETURNED (`ok:false`), never thrown, answered by the claim's state (`respondToExistingClaim`).
  An unknown outcome leaves the claim `pending` and releases the lease; rule 7 marks it `refused`; a settled answer marks it
  `settled_unbooked` and hands the row to the route. `replayForClaim` is the consult-first read (used by register and patron),
  so a replay is answered before `/verify` spends facilitator credits. `recordSettledPayment` writes the treasury line as the
  claim's booking step (`runBookingStep`, ledger ref). Patron booking is `finishPatron`.
- `src/register-gate.ts`: `finishRegistration` is the one booking function (treasury line, citizen, key_registered line), run by the
  original request, the payer's identical re-send and (commit 4) the reconciler. The citizen is recognised by `booked_refs`, never
  by handle. Secret mode: the citizen INSERT is the final step; the reconciler books nothing for it (B5, B6b).
  `society.ts`: `registrationResponseBody` extracted from `register()` (same bytes), `newSecret` exported. `register()` itself is
  untouched and is no longer called by the gate (its offender-scan test still holds).
- Decision: the served "registration did not complete" messages (hub words, F8a) now carry the B6a backstop sentence (public-key)
  or the re-send sentence (secret mode, B6b, no deadline). The F8a tests type the new words literally.
- Decision: `test/helpers/x402-payload.ts` gives every header its own nonce unless a test passes one (the old constant zero nonce
  would now be a replay).
- Decision: the ledger description still names the facilitator's reported `payer` (kept in the claim's `payer` column), so a resumed
  booking writes byte-identical text.
- Secret-literal guard: four reviewed entries (B5d, B6b twice, the claim-gated citizens INSERT); baseline 74 / 23 / 51.
- OPEN FOR HUB: a registration whose handle is taken by a DIFFERENT seat after payment (the race step 2 and afterVerify narrow but
  cannot close) leaves its claim `settled_unbooked`: the brief has no terminal state for it (B2: "No other transitions"). The payer is
  told to re-send; the re-send fails the same way; the reconciler will retry it daily and log each attempt. There is no refund path.
  The operator decides each such row by hand. Not resolved here because any automatic terminal state would either drop a paid
  registration silently or invent a refund.

### 3. Listing create and pay listing wired (B3 reservation + claim atomicity); test 10a-d, listing create

- `src/listings.ts`: `handleCreateListing` and `handlePayListing` take a `PaidClaim`, run `replayForClaim` after their requirements
  are built, and book through `finishListingCreate` (ledger step, then the listing row as the final step) and `finishPayListing`
  (the `listing_payments` row and the flip to paid in ONE batch with the claim update, final step).
- **Decision (B3, pay listing): the conflict is RETURNED, not thrown.** payAndSettle returns `ok:false` for a claim conflict, so the
  pay route's existing `!result.ok` branch releases its own reservation. The catch that keeps the reservation on a thrown unknown
  outcome is never reached by a conflict. Order (i): reservation, then a claim conflict: listing back to `open` (10a). Order (ii): a
  reservation that fails takes no claim (10b). A claim already present before `/verify` is answered without any facilitator call (10a').
- **Decision: pay-listing booking is gated on the listing still being `paying`** (the INSERT and the UPDATE both, and the claim's
  `changes() = 1` ties the reference to the UPDATE). A listing a person has since released books nothing and the claim stays
  `settled_unbooked` (10d).
- **Decision: the funder's own identical re-send cannot finish a pay-listing claim**, because the reservation it meets first (listing
  `paying`) answers the existing 409 before any claim is read. The reconciler is the finisher for that route (B5 says the same).
- The exported booking entry points for the reconciler (`finishListingCreateBooking`, `finishPayListingBooking`) sit at the END of
  `listings.ts`: `test/listings-policing.test.ts` reads each handler from its signature to the next top-level export, and the
  ledger and payment-row scans must keep reading the handlers whole.
- Served text: listing create's "failed to save" and pay listing's "recording it failed" messages now carry the B6a backstop sentence
  (the pointer literals that `post-payment-pointer.test.ts` counts are unchanged).
- Test harness split out to `test/helpers/settlement-harness.ts`; listing tests in `test/settlement-replay-listings-d1.test.ts`.

### 4. The reconciler in the 06:00 handler (B6, B6a, B6b, B7); tests 7a-g, 8, 8b, 11, 14, the budget proof

- `src/settlement-chain.ts`: `readAuthorizationState` (USDC `authorizationState(from, nonce)`, selector `0xe94a0102`, the first TWO
  distinct RPCs of the shared list must answer and agree; fewer or disagreeing is no answer). `society.ts` gains `baseRpcUrls`, shared
  with the treasury balance read so the two lists cannot drift.
- `src/x402.ts`: `attemptPending` (chain decides -> `expired` only after validBefore PLUS `RECONCILE_EXPIRY_MARGIN_SECONDS`; otherwise
  re-POST the stored body, byte-identical, and classify as the first settle was). The payer's identical re-send on a `pending` claim
  takes the lease and runs one attempt itself (B6 "may also").
- `src/settlement-reconcile.ts`: `runReconciler`, a fixed batch of `RECONCILE_BATCH_ROWS = 2`, oldest ATTEMPT first, each row leased,
  every row's failure one log line (the claim's public identity and the reason, never the body), a failing row never stops the rest.
  `src/index.ts`: runs after the governance sweep on the 06:00 (clerk) cron only, and adds what it spent to `priorCost`.
- **Budget (B6a), measured not guessed.** A metered DB (every statement, a batch counting each of its statements) plus the fetch counts
  the attempt reports give the real spend; a row starts only if its worst case (`RECONCILE_ROW_WORST_CASE = 18`: the measured 16 plus one
  chain-head retry) still fits under `RECONCILE_SUBREQUEST_CEILING = 26`. The proof counts the real subrequests through `scheduled()`:
  the worst row alone is 17 with its select (12 D1, 5 fetches; the metered total equals it exactly); `scheduled()` with that row, two due
  proposals and the clerk wake is 48 of 50. With the sweep's 3 the wake sees priorCost <= 29, inside `canAffordConcierge`'s 32.
- OPEN FOR HUB (deviation from B6, the expiry margin): `expired` invites a second signature, so it must never be premature. The brief says
  "unused and `now > valid_before`". I require `now > valid_before + 300 s` (the authorisation window): a transfer broadcast just before
  validBefore can be mined a little after it in wall-clock terms and an RPC can trail the head. Inside the margin the row waits (7f).
- OPEN FOR HUB (B6 reading): when the chain says the authorisation is SPENT and /settle answers a rule-7 refusal, the two contradict; the
  row is left `pending` for a person, never refused (a refusal would invite a second signature for money that moved) (7e).
- OPEN FOR HUB (fairness): "rows worked oldest first" is read as oldest ATTEMPT first (`updated_at`, which a lease acquisition moves), so a
  row that keeps failing goes to the back instead of starving the batch (14). Creation order would let two permanently failing rows block
  every later one forever.
- OPEN FOR HUB: a reconciler-finished registration in `invite_only` mode (legacy, off in production) does not mark the invite code redeemed
  (the reconciler has no code). Noted, not built: the door has been open since 2026-08.
- Listing reservations: the reconciler does NOT release a `listing_pay` reservation when its claim goes `expired` or `refused` (the pay
  route's own rule-7 branch still does, in the request). An operator-held `paying` listing is the existing recovery surface and
  `scripts/pay-listing.mjs` reconciles it; an automatic release could race that script. A `listing_pay` claim the reconciler books is
  booked exactly as the request would have (payment row, paid flip), gated on the listing still being `paying`.

### 5. The classifier (B8: L1, L3), L2's wording, test 4

- `classifySettle` compares `duplicate_settlement` and `settlement_pending` after `trim()` and case-folding, at ANY status, as unknown
  (rule 5; `duplicate_settlement` is a second branch of it, worded as its own non-verdict). Rule 7 carries the same exclusions so a
  refusal never depends on the rules above it.
- `SETTLE_UNKNOWN_TAIL` now ends "; do not sign again." and every unknown message uses it, including rule 3 (which had its own copy)
  and the unreadable-/settle-body throw.
- L2: the three `/verify` messages no longer say "nothing that could settle was sent"; they say "This server never asked the facilitator
  to settle this payment", and the transit message adds that the request may still have been delivered (`NEVER_ASKED_TO_SETTLE`).
- The hub-worded strings the older tests type literally (`x402.test.ts`, `x402-settle-route-d1.test.ts`) are updated to the new words.
- `test/settlement-replay-classifier-d1.test.ts`: L1/L2/L3 units plus test 4, sixteen classifier outcomes each through the real register
  route to their claim state (rule 4 -> booked; rule 7 -> refused; rules 1-3, 5, 6, 8, transit, unreadable -> pending; 200
  duplicate_settlement and " Settlement_Pending " -> pending), each unknown answer ending "do not sign again".

### 6. B10 served text, the D-073 lobby note, test 13 (non-minting)

- `society.ts` `PUBLIC_KEY_ADVICE`, one sentence with its one reason (a secret exists only in the response that carries it, so a lost
  response loses it). Carried by every register-door surface outside the attested template: `/skill.md` (SKILL_VERSION 1.0.2 -> 1.0.3; the
  pinned hash and `docs/HEARTBEAT-SKILL-TEXT.md` updated in the same commit), the register door's 402 description, the PayAI
  declaration's `public_key` description, the showhome tier's Convert line and both convert texts, the MCP register tool's refusal, and
  the route table's register entry (served at `/api/surface` and `/llms.txt`). `src/doc.ts` FRONT_DOOR_TEMPLATE is untouched.
- D-073 (2): `lobbyDoorNote` replaced with the commission's appendix text VERBATIM (its ONLY `src/doc.ts` edit; a test types the whole
  text and compares). Tests that pinned the old invitation are updated to the paused text. Guard entries re-hashed.
- OPEN FOR HUB: the ClawHub/MCP-Registry listing kits were staged from `/skill.md` 1.0.2 (`drafts/LISTING-KITS-2026-09-28.md`); the served
  skill is now 1.0.3, so the staged `SKILL.md` needs re-staging from the live text after this deploys.
- L-109: a test follows the secret-lost answer's pointer (POST /api/showhome/enter, then /note) through the real router.
- Test 13: the template hash is `fa11788d...` (v5), asserted here and by `test/topics-d1.test.ts` 9.

### 7. The deploy script (written, parsed, never run)

- `scripts/deploy-settlement-replay-guard.ps1`: `git fetch`; `-ExpectedCommit` (mandatory) must equal `main`, `origin/main` and HEAD, on branch
  `main`, clean tree; its own gates (npm test, typecheck); the live non-minting baseline (v5, template hash, every chain `ok:true`) and the
  PROOF that the new code is absent (`pilot PAUSED` not yet on GET /), so the later poll means something; stops if `settlement_claims` already
  exists unless `-MigrationAlreadyApplied` (which is itself an assertion the table exists); applies `migrations/0017_*.sql` to the REMOTE D1
  FIRST; reads `pragma_table_info('settlement_claims')` (19 columns in order, the four-column primary key), the table's SQL for the B7 CHECK,
  the open-claims index and the row count; `npx wrangler deploy` with the version id captured (none = stop); polls GET / for the new marker;
  re-checks attest; 7 public GETs and one UNPAID register probe (a 402 carrying the public_key advice; it writes nothing). `-DryRun` does the
  fetch, the level check, the gates and the live reads and exits before any remote write.
- Avoids the gate's L6 traps: reusable (no gate on a literal the wave itself makes true), fetches, pins the commit, captures the version id,
  and a poll target proved absent-before. Avoids the PowerShell traps (`$COLS`/`$cols`, array `-notmatch`, one-element returns wrapped in `@()`,
  `"${var}:"` for `$V5_HASH:`, ErrorDetails, no stderr merge under Stop): the first parse of my own draft caught a `$V5_HASH:` drive reference.
- `test/settlement-replay-deploy-script.test.ts` proves it without running it (parse via PowerShell's own parser: 0 errors; ASCII; trap scans; step
  order; one migration apply and one deploy; column list equals the migration's and schema.sql's; the poll and probe markers are really served).

## Red-proof log

Method: `scratchpad/mut.mjs` applies one mutation to an in-memory copy of ONE file, runs the named test file(s), then rewrites the file from the
in-memory original (never `git checkout`) and confirms the bytes match. Mutations ran only after the work was committed or while the tree held only
committed content. "RED" means the named test(s) failed; all were restored byte-identical.

- Claim primitives (`settlement-claims-d1`): no fold on `from` / `nonce` (2 red each); INSERT replaces instead of conflicting; `sameRequest` ignores
  intent; lease ignores a live lease; `markSettled` not state-conditional; step gate without the ref check; step gate without the state check; step
  not a batch (statements run singly); no chain-head retry; final step leaves state alone; schema without the B7 CHECK. 12 of 12 red.
- Tests 1, 2, 3, 5, 9 (`x402.ts`): no consult-first; conflict ignored (no claim guard: test 3 red; test 1 is still held by consult-first, a second
  layer); divergent read as identical; `settled_unbooked` never finished by the re-send; a failed request keeping its lease; claim taken BEFORE
  afterVerify; treasury line written without the claim. All red.
- Tests 6a, 6c, 5, 1, 12 (`register-gate.ts`, `settlement-claims.ts`): a resume re-writing the treasury line (no skip AND no claim gate), a resume
  re-creating the citizen (same), key_registered step skipped, `deliver` ignored, register without consult-first; the key ignoring the nonce (test 12);
  the taker holding no lease. All red. (Single-layer mutations of the skip alone stay green because the claim gate is a second layer: that is why the
  two-layer mutations are the proof.)
- Test 10 (`listings.ts`, `settlement-claims.ts`): pay listing takes no claim; a conflict no longer releases the reservation; no consult-first; the payment
  INSERT not gated on the listing still paying; a resumed pay booking with no skip and no gate; a resumed listing booking likewise; the claim reference
  ignoring `changes()`. All red.
- Tests 7a-7h, 8, 8b, 11, 14, the budget proofs, the cron rule (`x402.ts`, `settlement-reconcile.ts`, `settlement-claims.ts`, `register-gate.ts`, `index.ts`):
  re-POST not byte-identical; expiry on the clock alone; no expiry margin; no quorum required; unused+valid never re-POSTed; a refusal honoured against a
  spent authorisation; the re-send never attempting; the re-send ignoring a live lease; the reconciler selecting leased rows; a failing row stopping the
  next; creation order instead of attempt order; no fixed batch; the wake not charged for the reconciler; no ceiling; `acquireLease` ignoring a live lease;
  a pending answer leaking the stored body; the reconciler booking a secret-mode registration; the reconciler also running on the judgment cron;
  `scheduled()` not charging priorCost. All red. THE FIRST RUN FOUND THREE GAPS and I closed them with new tests before calling these red-proofed:
  7b (added 7h: spent-but-past-validBefore is booked, not expired), the fairness mutation (test 14 now has four rows and asserts the failing row is not
  retried ahead of the waiting ones), the ceiling mutation (new test: a second worst-case row is shed).
- Classifier, test 4 (`x402.ts`): settlement_pending compared exactly; duplicate_settlement not a non-verdict; both removed; the tail without "do not sign
  again"; rule 3's own copy; the unreadable-body message; the /verify wording restored (and the transit message without "may still have been
  delivered"); rule 7 not marking the claim refused. 9 of 9 red.
- B10, D-073, test 13: the advice losing its reason; removed from each of /skill.md, the 402 description, the discovery declaration, the three showhome
  texts, the MCP refusal, the route table; the skill version not bumped; the secret-lost pointer naming a nonexistent route (L-109); a word added inside
  the attested template (mints: test 13 red); the lobby note losing its pause. All red.
- Deploy script (16 mutations of the script itself; the d1 read path carries no stderr redirect, on the advisor's catch that merging it would hand a wrangler notice to ConvertFrom-Json): no fetch, `-ExpectedCommit` not mandatory, dry run not exiting, a column dropped, the
  already-applied guard removed, a `$cols`/`$COLS` clash, a drive-reference trap, a non-ASCII character, no version-id check, a poll marker that is not
  served, the gate's outputSchema trap reintroduced, deploy before migration, the absent-marker probe removed, the branch check removed, stderr merged
  on the deploy under Stop, stderr merged on the d1 read. All red.

Not red-proofed, and why: (1) the `metered` DB facade's unwrapping of statements inside `batch` is proven only by the equality of its count with the
counter's (17 = 17) on LocalD1; its behaviour against real D1's host statement objects cannot be exercised locally (see OPEN FOR HUB 1).
(2) The `rpc_body`-in-every-response walk (test 11) covers the public GET routes in the route table and the four paid doors' replay answers; a route that
does not exist in `ROUTES` is unreachable by it, and the router has none that touches the table.

## OPEN FOR HUB (collected)

1. RULED: accepted. **Real D1 is unproven for four things**: `last_insert_rowid()`, `changes()` and `json_set` inside one D1 batch (the claim's reference update), and the
   `metered` facade over D1's host statement objects. Local SQLite and real D1 are the same engine, and governance already relies on `changes() = 1`
   in a batch on prod, but only a scratch-D1 rehearsal (L-016) proves it. Suggest: rehearse migration 0017 and one register claim on the scratch D1 before
   the deploy.
2. RULED: fix (F1, below). **A handle lost to a race after payment** leaves the claim `settled_unbooked` forever (B2: "No other transitions"); the reconciler retries daily and logs.
3. RULED: accepted. **Expiry margin** (deviation): `expired` needs `now > valid_before + 300 s`, not `now > valid_before`.
4. RULED: accepted. **Chain spent + facilitator refusal** contradict: the row stays `pending` for a person (never refused).
5. RULED: accepted. **Fairness reading**: "oldest first" is oldest ATTEMPT (`updated_at`), so a row that keeps failing cannot starve the batch.
6. RULED: fix (F2, below). **The reconciler does not release a `listing_pay` reservation** on `expired`/`refused`; a person (or `pay-listing.mjs`) does.
7. RULED: accepted. **Invite-only mode**: a reconciler-finished registration does not mark the invite code redeemed (legacy mode, off in production).
8. RULED: stands as a named limit; F4 makes the served text say so (no repeat clause on listing_pay). **Pay listing's own re-send** cannot finish a claim: the reservation answers first (the reconciler is the finisher, per B5).
9. RULED: accepted. **B1 deviation**: one extra column, `payer`; and B7 is also a table CHECK.
10. RULED: accepted. **Hub-worded served messages changed** (F8a registration failures, listing create/pay "failed to save/recording failed") to carry B6a/B6b; the older
    tests that type them literally were updated.
11. RULED: accepted. **Behaviour tightening**: a paid request whose authorisation lacks a 20-byte `from`, a 32-byte `nonce` or a decimal `validBefore` is refused 400
    before `/verify` (every real x402 client sends them).
12. RULED: accepted. **B10 scope**: the route-table entry for `/api/register` (served at `/api/surface` and `/llms.txt`) also carries the advice; `/skill.md` is 1.0.3, so
    the ClawHub/MCP-Registry kits staged from 1.0.2 need re-staging after the deploy.
13. RULED: accepted. **A replay is now answered before `/verify`** on all four doors (consult-first), which also spares the facilitator's credits.
14. RULED: fix (F3, below). **Priority on a tight day (budget).** The reconciler runs right after the sweep and BEFORE the concierge, so it can shed the concierge: before this wave a
    2-due-proposal day left the concierge 21 + 16 + 2 = 39 (it ran); now 21 + one worst reconcile row 17 = 38 and `canAffordConcierge(38)` is 38 + 16 + 2 = 56 > 50
    (shed). The existing comment in `index.ts` gives the concierge "first claim" on a tight day; the brief calls the reconciler a backstop that can wait. The
    measured proof (48 of 50) is correct for the order built. Alternative, NOT built because it changes a measured proof and the priority is the hub's call:
    run the reconciler between the concierge and the clerk using `concierge.actualCost`; on that day the reconciler sheds and waits 24 hours.
15. RULED: accepted. (nit) `respondToExistingClaim`'s pending branch answers "another attempt is in progress" when `acquireLease` returns null because the row went terminal between
    the read and the lease; the payer's next identical re-send meets consult-first and gets the terminal answer.
16. RULED: accepted. `register()` in `society.ts` is now uncalled by any route (register-gate books through `finishRegistration`); it stays exported for the tests that create
    fixtures with it, and the offender scan (`register-gate.test.ts`) still holds. Dead code to retire in a later wave.

## Fix pass (hub rulings of 2026-09-30)

The hub ruled on the list above (RULED marks inline). Accepted as named limits, no code change: 1 (the hub rehearses on a scratch D1), 3, 4, 5, 7 (dormant), 9, 10, 11,
12 (the hub re-stages the listing kits), 13, 15, 16. Fixes F1-F4 follow, one commit each.

### F1. A handle lost to another seat AFTER payment (item 2)

- The finisher recognises the citizen write's UNIQUE failure on `citizens.handle` (only possible when this claim has not yet created its citizen), records
  `verdict_reason = 'handle_taken'` on the claim (state stays `settled_unbooked`, per B2 no new transition), writes ONE `registration_handle_taken_after_payment`
  log line when the reason is first recorded (the generic `registration_paid_but_failed` line is not also written), and answers 409
  `registration_handle_taken_after_payment`: the payment settled, the tx, the handle, taken by another seat before this registration could be written, re-sending
  cannot book it and is not needed, do not sign again, reach the maintainer with the tx by a free showhome note (POST /api/showhome/enter, then /note).
- The reconciler's SELECT excludes rows with that reason (no daily budget spent on them). `respondToExistingClaim` answers an identical re-send (consult-first or at
  the INSERT) from the claim, never re-attempting, even if the handle is free again; `finishRegistration` refuses such a row too (defence in depth).
- Tests (`test/settlement-replay-fixes-d1.test.ts`): the wording; the recorded reason, one log line, no generic line; the reconciler skips it; an identical re-send
  gets the same answer with no citizen created and no second log line; both modes; following the showhome instruction through the real router (L-109).
- Red-proofs (10 mutations, multi-file from saved copies, all restored): reconciler not excluding the rows; reason never recorded; UNIQUE on `citizens.handle`
  not recognised; log written on every recognition (caught by the stale-copy test: a worker that read the claim before the reason was recorded must not log
  again); an identical re-send re-attempting (needs BOTH the `respondToExistingClaim` check and the finisher's defence removed: each layer alone stays green);
  the answer inviting a re-send; naming no handle; losing the showhome instruction (two tests red); the claim-answer path not serving it. All red.

### F2. The reconciler releases a pay-listing reservation (item 6; supersedes the commit-4 note that it would not)

- `markExpired` / `markRefused` take the claim row as `release`; for a `listing_pay` claim the terminal UPDATE and ONE conditional listing UPDATE run as one D1 batch
  (`terminate`, `listingReleaseStatement` in `src/settlement-claims.ts`): `status = 'paying'`, `paid_submission_id IS NULL`, the reservation's pinned wallet row
  (id and hash) equal to the claim's pin, `paying_since <= claim.created_at` (the reservation is taken before the claim in the same request, so a LATER reservation by
  another payer is never released), and `changes() = 1` (only the worker that actually moved the claim releases). `attemptPending` passes the row on `expired` and on a
  recorded rule-7 `refused`; nothing else ever releases: not `pending`, not an unknown answer, not a spent authorisation (that books), not an unreadable chain.
  The pay route's own request-path refusal still releases through its own `!result.ok` branch and passes no row.
- Tests (`test/settlement-replay-fixes-d1.test.ts`): expired -> open; refused -> open; chain spent with an unknown answer or a refusal, RPCs disagreeing, no quorum ->
  claim pending and listing still paying; a spent authorisation books (paid); a listing already paid, withdrawn, re-reserved later, or reserved under another pin is
  untouched while the claim still expires; the release and the claim update are one batch (a trigger refusing the release leaves the claim pending, and the next run does
  both); a worker that lost the race (claim already terminal) releases nothing even if the listing is `paying` under the same pin.
- Red-proofs (8, all restored): the terminal update releasing nothing; the reconciler passing no row on expired; on refused; release without `status = 'paying'`; without the
  pinned-row conditions; without the `paying_since` condition; without `changes() = 1`; the release as a separate statement. All red. Not independently provable:
  `paid_submission_id IS NULL` (a `paying` listing with a paid submission cannot be made by any route; it is defence in depth behind `status = 'paying'`).

### F3. The concierge keeps first claim: sweep -> concierge -> reconciler -> clerk (item 14; supersedes the commit-4 order)

- `scheduled()` (clerk cron): the concierge runs right after the sweep, exactly as its existing comment says; THEN the reconciler with
  `runReconciler(env, sweep + concierge.actualCost + CLERK_WAKE_FIXED_COST)`; THEN the clerk, charged `priorCost + concierge.actualCost + reconcileCost`. `runReconciler`
  now takes `reservedCost`, computes `left = 50 - reservedCost - FINALISE_RESERVE`, and if `left < select + one worst-case row (19)` works NONE, spends nothing and writes
  one `settlement_reconcile_deferred` line (`reserved_cost`, `budget_left`, `needed`); otherwise its ceiling is `min(26, left)`. A throw escaping the reconciler is priced
  as the whole ceiling, logged, and never stops the clerk.
- Measured through the real `scheduled()` with the counter (per invocation, cap 50): a quiet day with a worst-case row (four RPC fetches), a busy clerk (5 flagged posts,
  10 drafts offered) and the concierge running: 42 subrequests, the row BOOKED, the clerk shed to 6 of 10 inserts to pay for it; a contested day (2 due proposals, sweep
  21): 34, the concierge NOT shed (the old order shed it on exactly this day), the reconciler deferred with one line, the row untouched, and the next day (35) books it; a
  day the concierge really engages and posts: the reconciler sees what is really left, defers, and the clerk still runs. Consequence to know: on any day the concierge
  engages and posts (cost up to 16) the reconciler cannot afford a worst-case row and defers, so rows can wait several days (F4's wording says so); the payer's identical
  re-send is the fast path.
- Red-proofs (10, all restored): the old order; the reconciler not charged the concierge's actual cost, the clerk's minimum, or both; the clerk not charged what the reconciler
  spent (caught by the insert count, not by the total: the estimates are conservative); no deferral; deferral logging nothing; the standing ceiling ignoring what is left
  (a second cheap row starting); a throw escaping the reconciler stopping the clerk. The first run of this set found two greens that I closed with new tests (the concierge
  engaged day; the clerk's insert count) and one (the escape) with a dropped-table test.

### F4. The backstop wording, and the repeat clause only where it is true (follows F1, F3 and item 8)

- `RECONCILE_BACKSTOP` now reads: "The society's reconciler makes one pass a day, at 06:00 UTC, and works a limited number of unresolved payments per pass, oldest attempt
  first, so a payment can wait more than one day." No deadline, no "at the latest". The clause "Repeating this identical request re-checks it sooner."
  (`RECONCILE_REPEAT_CLAUSE`) is a separate constant, appended by `reconcileTail(route)` ONLY for register, patron and listing_create, where an identical re-send really
  re-checks (a pending claim: lease, chain read, re-POST) or finishes (a settled one). It is NOT on any `listing_pay` answer (the reservation answers a re-send first; the
  lease-held "repeat in a few minutes" sentence is also dropped for it), NOT on the F1 handle-taken answer, and B6b holds (a secret-mode settled_unbooked answer names no
  deadline and no daily pass).
- Sites: `claimAnswer` (pending, settled_unbooked), the registration failure tail (public-key: backstop + clause; secret-mode keeps its own re-send sentence), listing create's
  "failed to save" (backstop + clause), pay listing's "recording it failed" (backstop only), and the `settlement_claim_unrecorded` answer in `payAndSettle` (tail by route).
  The F8a tests and the listing tests that type these words were updated.
- One behaviour fix the follow-test forced: a request that settled but could not record the claim (`settlement_claim_unrecorded`) now releases its own lease before
  answering, so the re-send it tells the payer to make re-checks at once instead of meeting a live lease held by a dead request.
- Tests: the wording; every route x state x lease combination of `claimAnswer` (listing_pay none, the others carry it, secret-mode none, handle-taken none); and the clause is
  FOLLOWED (L-109): register pending (under a live lease the re-send asks nobody; once the lease is gone the identical request really re-checks the chain and re-POSTs), patron
  pending (every identical request re-checks), a public-key registration settled-but-not-booked (the re-send finishes it), the "could not record" answer for a registration
  (its re-send re-checks the chain and books it) and for a pay listing (backstop, no clause).
- Red-proofs (11, all restored): the old promise; listing_pay carrying the clause; register lacking it; a listing_pay lease-held invitation; the registration failure tail without
  the clause; the pay-listing failure message with it; the listing-create message without it; the unrecorded tail ignoring the route; the dead request keeping its lease; a
  deadline on the secret-mode answer; the backstop on the handle-taken answer. All red.

## Fix pass report

F1-F4 done on this branch; items 1, 3, 4, 5, 7, 9, 10, 11, 12, 13, 15, 16 recorded as RULED: accepted; item 8 stands (F4 makes the text say so).

### Hub note: the scratch-D1 rehearsal (OPEN FOR HUB 1), 2026-09-30

Run by the hub against the scratch D1 `commonhold-migtest` only (prod untouched); full record in the project root `HANDOVER.md`, Addendum 78 section 9. (a) A `wrangler dev --remote` probe worker, namespaced tables dropped after: inside ONE managed `env.DB.batch`, a gated-out INSERT then the record statement gave `[0,0]` and recorded nothing; INSERT -> UPDATE (`changes() = 1`) -> `json_set(refs, '$.row_id', last_insert_rowid())` gave `[1,1,1]` and recorded the INSERTed id (41), not the stale id (40) nor the updated row (7); a replay after `booked` gave `[0,0]`. (b) `migrations/0017_settlement_claims.sql` applied twice (the second a no-op); catalog showed every column, the four-part primary key and `idx_settlement_claims_open`; on real D1 the CHECKs refused a terminal row carrying `rpc_body`, invalid `booked_refs` JSON and an unknown state, and the key refused a duplicate (SQLITE_CONSTRAINT_PRIMARYKEY). Probe rows deleted.

### Hub note: the D-018 Opus gate, 2026-09-30

`docs/REVIEW-SETTLEMENT-REPLAY-GUARD-GATE-2026-09-30.md`: DEPLOYABLE WITH CONDITIONS, HIGH 0, MEDIUM 1, LOW 7. C1 (before deploy): a timeout of at most 120 s on the facilitator call. C2 rides a later paid-path wave. Fix pass 2 follows (C1, L1, L2).

## Fix pass 2 (the D-018 Opus gate, `docs/REVIEW-SETTLEMENT-REPLAY-GUARD-GATE-2026-09-30.md`: DEPLOYABLE WITH CONDITIONS, C1 before the deploy)

### C1. The facilitator fetch is bounded below the claim lease (gate M1)

- `facilitator()` (src/x402.ts) fetches with an `AbortController`: `/settle` 120 s (`FACILITATOR_SETTLE_TIMEOUT_MS`: above PayAI's documented ~100 s wait, below the
  180 s lease), `/verify` 30 s (`FACILITATOR_VERIFY_TIMEOUT_MS`: a signature and balance check with no claim and no lease behind it, safe to retry, so it fails fast). The
  timer covers the answer's body and is cleared once it is read. A timed-out `/settle` takes the EXISTING transit path ("failed in transit (no answer within 120 s) ... do
  not sign again"): the claim stays `pending`, `noteUnknown` releases the lease, one `x402_settle_outcome_unknown` line. A timed-out `/verify` takes the existing
  verify-transit path ("could not be reached to verify ... never asked the facilitator to settle"): no claim exists yet.
- The invariant lives in one place: `FACILITATOR_SETTLE_TIMEOUT_MS + CLAIM_BOOKING_ALLOWANCE_MS (40 s: markSettled plus about twenty D1 statements, generous) < CLAIM_LEASE_TTL_MS`,
  asserted by `test/settlement-replay-timeout-d1.test.ts` together with the settle bound exceeding 100 s and the verify bound being shorter.
- For testing in milliseconds the Env can set `FACILITATOR_SETTLE_TIMEOUT_MS` / `FACILITATOR_VERIFY_TIMEOUT_MS`, but only SHORTER (`facilitatorTimeoutMs` takes the minimum
  with the built-in bound), so no configuration can lengthen a bound past the lease. The harness's delays now honour the caller's abort signal like a real fetch.
- Tests: a /settle held 2 s with a 200 ms bound ends inside it (aborted once, 502, pending, lease released, no citizen or ledger line, one log line); a hung /verify (aborted,
  502 verify-transit, no claim, no settle); the patron door; a normal answer inside the bound is untouched (timer cleared); the invariant; the clamp.
- Red-proofs (8, all restored): no signal passed; the timer never firing; a timed-out settle not reported as in transit; the verify bound equal to the settle bound; the Env
  lengthening a bound; a later edit raising the settle bound to 170 s; a later edit shortening the lease to 150 s. All red (the last two by the invariant test alone).

### L1. A claim INSERT that throws after the pay-listing reservation

- `payAndSettle` catches a `takeClaim` throw (a database error, not a key conflict), writes one `settlement_claim_not_taken` line, and RETURNS a not-sent `ok:false`: 503
  `settlement_claim_unavailable`, "nothing was sent to the facilitator's /settle and nothing was charged ... Try again later: the same signed authorisation has not been used".
  The pay route's existing `!result.ok` branch then releases its own reservation (the conditional `UPDATE ... WHERE status = 'paying'` the conflict path already uses), so the
  listing is no longer stranded in `paying` with no claim and the answer no longer claims the money may have moved. The other doors answer the same 503 with nothing created.
- Tests (`test/settlement-replay-timeout-d1.test.ts`): a `BEFORE INSERT` trigger on `settlement_claims`: pay listing answers 503, the listing is `open` with no pinned
  reservation, 0 claims, 0 settles, the wording names "nothing was sent to the facilitator's /settle" and never "may have moved", one log line, and the funder can pay once the
  database is healthy; registration answers the same 503 with no citizen and the same signed header registers afterwards.
- Red-proofs (3, restored): the throw not caught (old behaviour); the answer saying the money may have moved; the reservation not released on the not-sent path. All red.

### L2. Routes test 3 proves the lease (gate G1)

- `test/settlement-replay-routes-d1.test.ts` test 3 now carries the chain stub the gate describes (`rpc: () => authStateAnswer(false)`) and asserts the loser made no RPC
  call. A loser that meets the pending claim with no live lease would now re-check the chain (unused, authorisation still valid) and re-POST `/settle`: a second settle, a second
  booking. Red-proof: `takeClaim` inserting a NULL lease (the gate's mutant G1) now turns THIS test red (alone, run on its own file); before, it stayed green and only the two
  primitive tests noticed.

### C2 marker (not built; the next paid-path wave)

- `DEFERRED-STALE-CLAIM-ANSWER` planted at the two places the gate's C2 names: `src/register-gate.ts` at the return that can hand back a `secret` that was never stored (a
  finisher with a stale `settled_unbooked` snapshot whose citizen step was gated out by another finisher still returns its own fresh secret; fix: a secret only when THIS call's
  step reported `applied: true`, otherwise answer from the claim), and `src/x402.ts` at the `markSettled` call whose `false` is ignored (answer from the claim's state, log loudly
  if it is refused or expired for money that settled). C1 removes the usual way in (a `/settle` outliving its lease); it does not remove the race, so this stays owed.
