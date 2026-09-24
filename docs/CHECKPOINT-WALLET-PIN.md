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

**2. Migration 0016, `schema.sql`, and `walletAddressFromRow`.** Four additive nullable columns
(`listings.paying_wallet_row_id|_hash`, `listing_payments.wallet_row_id|_hash`), mirrored in
`schema.sql`; the drift detector now applies 0016. `walletAddressFromRow(kind, detail)` in
`src/wallets.ts` is the exact inverse of `walletLogEntry` and accepts only the normalised form
(0x + 40 lowercase hex). New `test/wallet-pin-d1.test.ts` parts 1-2: 0016 adds exactly the four
columns (types, nullable, no default), existing rows read NULL (brief test 7), 0016 is once-only
(a second apply fails "duplicate column"); the helper's inverse property; parity with the pay
script's `walletRowAddress` on eleven fixtures. **One stated difference:** a mixed-case address,
which the application cannot write, is null on the server (refused) and lowercased by the script;
stricter on the server is the safe side. 1191/1191, typecheck 0. Red-proofs (restored byte-exact):
M4 one ALTER dropped, 3 red; M5 a change returns its previous address, 2 red; M6 mixed case
accepted, 1 red. Catalogue verification query for the rehearsal and the deploy:
`SELECT name FROM pragma_table_info('listings') WHERE name LIKE 'paying_wallet_row_%' UNION ALL
SELECT name FROM pragma_table_info('listing_payments') WHERE name LIKE 'wallet_row_%'` must return
exactly four rows.

**2a. Correction to note 2.** Note 2 says 1191/1191. It was false when written: the full run before
that commit reported 1190 pass, 1 fail, and the commit went in anyway. The failure was a SECOND
schema drift detector (`test/listings-pledge-d1.test.ts:122`, the listings table only), which went red
correctly because `schema.sql` gained the 0016 columns; the sweep for detectors had found only the one
in `test/listings-migration-d1.test.ts`. That detector now applies 0016 too. A grep for every test that
loads 0014 or reads the listings tables' `pragma_table_info` finds exactly three files, all now
applying 0016 where they compare. 1191/1191 after this commit. Practice from here: read the fail count
before writing the note, not after.

**3. The pay route: the required pin, check 1, check 2, and the pair through every exit.**
`parseWalletPin` (free 400s: `wallet_row_required` when either field is absent or null,
`wallet_row_malformed` for a non-number id, id <= 0, or a hash that is not 64 lowercase hex) runs
beside `submission_id`, before any read. `assertWalletPinCurrent` (check 1, two reads) runs after
`walletFor` and before the requirements, so the 402 probe itself refuses: 409 `wallet_row_missing`,
`_kind`, `_citizen`, `_superseded` (by `MAX(id)`, A2), `_hash` (stored column, not recomputed), and
`_address` (CODEX's binding: `walletAddressFromRow(row)` must equal `walletFor`'s value, which then
becomes `payTo`). Check 2 is A5's statement verbatim, eleven binds, recording the pair on the listing
(A6). The pair is cleared on release and on paid, carried by the 502 body, both error log lines and
the success body, and copied to the book row; the 502 message says reconciliation uses the recorded
row, never the newest at reconciliation time. Deviation from the checkpoint plan: the route tests
live in their own file, `test/wallet-pin-route-d1.test.ts` (a heredoc append hit the Bash
backslash trap, nothing landed, and a separate file written whole was cleaner). Harness:
`test/helpers/wallet-pin.ts` (`declareTestWallet` through the real `appendChained`,
`newestWalletRow`, `PLACEHOLDER_PIN`); every listings-d1 wallet is now declared with its chained
row, its 21 short test addresses padded to 40 hex, and every pay request carries the newest row.
The policing invariant at `test/listings-policing.test.ts:89` is now three fields, as ruled.
1199/1199, typecheck 0. Red-proofs (restored byte-exact): M7 address check off -> test 3 red; M8
NOT EXISTS neutralised -> test 4; M9 reservation hash clause neutralised -> test 5; M10 check-1
superseded off -> test 2; M11 check-1 hash off -> test 2; M12 pair not recorded at the reservation
-> test 10; M13 release keeps the pair -> test 10; M14 book row without the pair -> test 1.

**4. The served half: A7, A6's served pair, the book's pair, and the text.** `getListingDetail`
serves each submission's `payee_wallet_row` ({id, hash, address}; null with no wallet row; a row
whose detail does not parse is served with address null, never dropped) from one read, and a
`payee_wallet_row_note`; while a payment is pending or unresolved it serves the reserved
`paying_wallet_row_id|_hash` beside `paying_since` and `settlement`. `listingPaymentsPage` serves
`wallet_row_id|_hash` on every entry and a `wallet_row_note` (null before the check; the stored hash
compared, the chain not recomputed; what it cannot show). The guide's step 4 and the discovery entry
(from which `llms.txt` is built) name the required pin, where to read it, the refusals, and that a
refusal writes nothing public. Non-minting: the v5 template pin (`test/topics-d1.test.ts:619`,
`fa11788d…`) stays green. The root design doc's §6.2 claim gets a dated note (paperwork, outside
git). 1203/1203, typecheck 0. Red-proofs (restored byte-exact): M15 A7 serves the first row -> test
11 red; M16 the A6 pair not served -> test 10 red; M17 the book pair not served -> test 1 red; M18 an
unparseable row dropped -> test 11 red.

**4a. Correction to note 4.** Note 4 and commit `4d911b99`'s message say 1203/1203. The run
printed 1202/1202 (1199 plus the three new tests, none failing). The number was written before the
run's output was read, which is the practice note 2a said to stop. The count below was read first.

**5. The pay script.** Both legs send `{ submission_id, wallet_row_id, wallet_row_hash }` (the
probe too, so a stale pin is refused before anything is signed); a leg-1 refusal carries the
server's `code` out as `serverCode` and in the message; `validatePayReceipt` requires the receipt to
name the pinned row and hash (a receipt without them is a server that did not check, so the
tombstone stays `signing`); the 502 recovery message says to reconcile against the row the server
recorded, never the newest at reconciliation time; the header comment no longer calls the server
check deferred. `test/pay-listing.test.ts`: the leg-1 body assertion changes as ruled, the receipt
fixture carries the pair, three new tests (both legs carry the pin; the code is surfaced with
nothing signed; a receipt without the pair, or with another row or hash, stays `signing`). 1205/1205,
typecheck 0. Red-proofs (restored byte-exact): M19 body without the pin -> 2 red; M20 receipt row
unchecked -> 1 red; M21 server code not surfaced -> 1 red.

**6. The deploy script, `scripts/deploy-wallet-pin.ps1`** (L-046, L-069; modelled on
`deploy-standing-topics.ps1`). Gates: clean tree, level with `origin/main`, typecheck, the suite.
Live before: attest, both tables' catalogues (17 `listings` and 9 `listing_payments` columns before
0016), the row counts, and a refusal if any listing is `paying`. 0016 applies only from a clean state
(0/4); 4/4 skips; anything between stops. After: four columns with the right types, nullable, no
default; row counts unchanged; every existing row NULL in them. Then the worker. The ride: attest
non-minting and all four chains verified; nine GETs 200; the payments book serves `wallet_row_id` on
every row and its note; `/api/listing/3` serves `payee_wallet_row` on every submission; the guide
names the pin; and ONE refusal-only POST to `/api/listing/3/pay` with no pin, as commonhold-agent
(bearer read from custody, never printed), which must return 400 `wallet_row_required`. A bug caught
before any run: the `listings` minimum was 18, which would have stopped the real run on a correct
catalogue; it is 17. **Dry run ridden against prod, 2026-09-24 ~21:50Z** (reads only): constitution
v5 `fa11788d`, identity 36 / treasury 17 / ballots 14, 0016 columns 0/4 (clean), listings 4,
listing_payments 3, paying 0; stopped before the migration as designed (tree not clean only because
of this script, uncommitted at that moment; not level, as expected on the branch).

**7. 0016 rehearsed on the scratch D1 `commonhold-migtest` (`465f489c…`), 2026-09-24 ~21:55Z, under
Ben's grant ("Yes, scratch only"); prod untouched.** Every command went through
`scripts/changes-probe-worker/wrangler.jsonc`, which binds the scratch database and nothing else
(checked first). The scratch database was BEHIND prod: its `listings` had 0009's fifteen columns,
with neither 0013's `pledge` nor 0014's `paying_since`, and no rows. So: (A) 0013 and 0014 applied to
the scratch first, giving prod's pre-0016 shape (listings 17 columns, listing_payments 9); (B)
synthetic rows seeded (a paid listing with its submission and book row, an open listing); (C) 0016
applied, exit 0, four statements; (D) the catalogue query returned exactly the four columns,
INTEGER/TEXT as designed, `notnull` 0, no default; listings 2 and book rows 1 unchanged; zero rows
carry a pair; listings now 19 columns; (E) a second apply FAILED "duplicate column name:
paying_wallet_row_id: SQLITE_ERROR" and changed nothing (19 and 11 columns). What this does not
prove: prod's own data, which the deploy script's before/after checks read at the real run.

**8. The review round: the D-018 Opus gate, the two-seat code exchange, and the fixes.**
The gate (`docs/REVIEW-WALLET-PIN-GATE-2026-09-24.md`, brief `docs/GATE-BRIEF-WALLET-PIN-2026-09-24.md`)
returned **DEPLOYABLE WITH CONDITIONS, no HIGH**: C1, the front door (`src/doc.ts` `listingsDoorNote`)
still documented the pay body as `{"submission_id"}`, which the new worker refuses; C2, before the
deploy, a read-only payability query on prod. The code exchange
(`exchange/REVIEW_wallet-pin-build-2026-09-24.md`, round 1) found what the gate did not: **CODEX, HIGH,
verified at source:** `facilitator()` returns any parseable body whatever its HTTP status and
`payAndSettle` read every `success !== true` as a refusal, so an intermediary's JSON 502 after a real
broadcast released the reservation, cleared the pair and allowed a second payment on retry. It predates
this wave and sits in the shared core. GEMINI (verified): the `llms.txt` label "$1 USDC over x402" above
bounty routes; the discovery note lacked "a refusal writes nothing public" (note 4 claimed it had it);
the deploy script read the custody file only after mutating prod, and `Read-Count` turned a bad read
into 0; the pay script's header overstated check 2. Fixed in the next commit: the `/settle` answer is
classified by a boolean `success` (anything else is an unknown outcome, thrown, never a refusal); the
front door, the discovery note ("before any payment", the gate's L1; "a refusal writes nothing public")
and the x402 label ("USDC over x402 (402 challenge naming the amount ...)"); the pay-script header; the
deploy script (custody proven readable before any prod change and in `-DryRun`; strict `Read-Count`; the
ride's bearer sent in-process by `Invoke-WebRequest`, never on a command line, the gate's L4a; an
unreadable post-deploy attest stops as itself, not as the minting alarm, L4b); the gate's L3 flagged as
`DEFERRED-WALLET-REDECLARE-OUT-OF-STEP` in `src/wallets.ts`. New tests: the settle classification (unit,
with the explicit `success:false` control) and on the route (a JSON 502 keeps the reservation and pair; a
retry never reaches `/settle`); A4 with a checksum-cased treasury (the gate's L2a); a payee whose newest
identity row is a model correction stays payable and A7 serves the wallet row (L2b); the 500 path keeps
the pair and serves it (L2c). **1210/1210** (read before writing), typecheck 0, v5 pin green.
Red-proofs (restored byte-exact): M22 settle classification off -> 2 red; M23 required address not
case-folded -> 1 red; M24 check-1 kind filter dropped -> 1 red; M25 the 500 path clears the pair -> 1
red. **C2 run on prod, read-only:** zero rows (both prod wallets' newest chained rows name their table
addresses); the query's own positive control on the scratch D1 returned 1 row out of step and 0 back in
step (synthetic rows, removed). The fixed deploy script's `-DryRun`, run from this worktree, stops at the
new custody check by design (it resolves custody one level above its working directory, which is right
from `society/`); its prod reads were exercised by the dry run in note 6.

**8a. Corrections.** (i) The mutation total before this round was 21 (M1-M21), not the 24 I wrote in the
exchange opener and the handover; 25 with this round's four. (ii) The times in notes 6 and 7 ("~21:50Z",
"~21:55Z") and the baseline's "~20:25Z" were guesses, not clock reads; the server's clock read 20:35Z at
the chit402 send that followed them, so the dry run and the rehearsal ran between 19:40Z (session open,
system clock) and 20:35Z. (iii) Note 4 says the design doc's §6.2 got a dated note; §7.2 and the §8
endpoint table carried the same claim, and §7.2 now has its own note (paperwork, outside git).
