**VERDICT: DEPLOYABLE WITH CONDITIONS.** C1: correct the front door's pay body (`src/doc.ts:685`) before the push. C2: before the deploy, run the read-only payability query below against prod and resolve any row it returns.

# D-018 PRE-DEPLOY GATE: the server-side wallet pin + A4, the local x402 payload check (2026-09-24)

**Reviewer:** independent Opus adversarial gate (D-018), briefed from
`docs/GATE-BRIEF-WALLET-PIN-2026-09-24.md` only. I did not read the exchange records for this
wave, so these findings are independent of them. Every claim below was checked against source or
a local run. Read-only throughout: no commit, push, deploy, migration, `wrangler` command,
network call to the live site or `*.local.*` file. The worktree was not modified. Throwaway
probes and mutants ran on a **copy** of the worktree in the session scratchpad, outside the repo.
That copy was deleted afterwards (see "Verified first-hand"). This record is the only file
written in the worktree.

**Scope.** Worktree `scratch/wt-wallet-pin`, branch `wallet-pin-2026-09-24`, HEAD `4f07460c`,
base `4066677c` (= local `origin/main`, not fetched). The branch is not pushed. Range
`4066677c..4f07460c`, eight commits: `7378e1cd` (A4 + `SocietyError.code`), `be464cb9` (0016 +
`walletAddressFromRow`), `0de7941b` (the second drift detector), `f763e852` (the pin: checks
1 and 2, A6), `4d911b99` (the served half: A7, the notes, the guide, discovery), `39bcd76f` (the
pay script), `21adc164` (the deploy script) and `4f07460c` (the checkpoint).

---

## Findings

### HIGH
None. No path I could build settles money anywhere except the address the pinned row names (Q1),
and no stale, foreign or tampered pin passes both checks (Q2).

### MEDIUM

**M1. The front door still documents the old pay contract.**
- **Where:** `src/doc.ts:685`, inside `listingsDoorNote` (`src/doc.ts:671`). It is appended to
  `GET /` at `src/index.ts:176` and sits outside `FRONT_DOOR_TEMPLATE`, which closes at
  `src/doc.ts:480`.
- **Defect:** `GET /` tells every reader that the pay body is `{"submission_id"}`. Under R, the
  new worker refuses exactly that body with 400 `wallet_row_required` (`src/listings.ts:591-597`,
  called at `:665`, before the listing is even read).
- **Scenario:** an outside funder follows the front door, POSTs `{"submission_id": N}` with a
  signed X-PAYMENT, and gets a 400. This is money-safe: the request fails closed before any
  read, and the 400's prose says what to send. It is still a false served instruction, on the
  project's most-read surface, for the one route this wave changes.
- **Why it was missed:** the brief's §4.7 lists four surfaces, and this is a fifth. The build
  followed the brief. No test pins the string (a grep of `test/` finds none), so nothing went red.
- **Reproduced:** by reading the served text against `parseWalletPin`. The deploy ride itself
  sends exactly this body (`scripts/deploy-wallet-pin.ps1:132`) and requires the 400
  (`:140`).
- **Fix (C1):** make the line `{"submission_id","wallet_row_id","wallet_row_hash"}`. The change
  is non-minting because the line is outside the template (`:685` against the template's close at
  `:480`). The v5 pin test will therefore stay green by construction. I did not run it with the
  change applied.
  Optionally, add a test that the door note names the three fields, so the next change to this
  contract goes red there too.

### LOW

**L1. The discovery note says every stale pin is refused "before any 402". It is not.**
- **Where:** `src/discovery.ts:135`, in the `note`. The note is served only on `/api/surface`
  (`renderSurface`, `src/discovery.ts:437-447`). `llms.txt` renders only `description`
  (`routeLine`, `:188-192`), and the description is true. `openapi.json` emits notes only for
  no-auth GETs (`isNoAuthRead`, `:184-186`), so it does not carry this one.
- **Defect:** a pin can go stale during leg 2's `/verify`. That pin passed check 1 on both legs,
  and a 402 was issued for it on leg 1. It is then refused only by check 2 at the reservation
  (`src/listings.ts:753-767`), after the funder has signed, with the generic 409 that carries no
  `code`.
- **Reproduced:** probe E6. The probe got a 402 for the pin. A `wallet_changed` landed during
  leg 2's `/verify`, and the result was a 409 with `code === undefined`, `/verify` called once
  and `/settle` never called. The builder's test 4 (`test/wallet-pin-route-d1.test.ts:255-278`)
  shows the same refusal.
- **Fix:** say "refused before any payment", as the guide's step 4 already does
  (`src/listings.ts:1131`). Non-minting. Best made in the same edit as C1.

**L2. Three behaviours the pin relies on are correct but unpinned by any test (mutation-proven).**
- (a) **A4's requirements-side case fold, against the production config.**
  - **Where:** `src/x402.ts:137`. Production's `TREASURY_ADDRESS` is EIP-55 cased
    (`wrangler.jsonc:27`, `0xD9E17995352EF13F9Ba467e2F36C7614A45e7011`).
  - **The gap:** every test env uses a lowercase or dummy treasury (`test/x402.test.ts:18`,
    `test/register-gate-d1.test.ts:44`, `test/listings-d1.test.ts:43`,
    `test/listings-pledge-d1.test.ts:176`, `test/wallet-pin-route-d1.test.ts:26`). The one case
    test folds the other side: a checksummed `to` against a lowercase `payTo`.
  - **Scenario:** an edit drops `.toLowerCase()` from `reqs.payTo`. The suite stays 1205/1205.
    In production, every registration, patron line and listing post from a standard client is
    then refused 400 `payment_payload_mismatch`, because such a client signs `to` exactly as the
    402 serves it (`scripts/register-maintainer.mjs:184`).
  - **Reproduced:** mutant A (table below). The existing suite stayed green and only probe E1
    went red. On unmodified code, E1 passes: a checksummed `to` and a lowercase `to` both pass
    against the production value, and `payAndSettle` reaches `/verify` and `/settle`.
- (b) **Kind scoping, in all three places.**
  - **Where:** `src/listings.ts:627` (check 1's `MAX(id)`), `:758` (check 2's `NOT EXISTS`) and
    `:1091` (A7's newest row).
  - **The gap:** no test has a payee whose newest identity row is not a wallet row.
  - **Scenario:** a payee corrects their model after declaring a wallet, and one filter has been
    "simplified" away. Depending on which filter, the payee becomes unpayable (409 superseded, or
    the generic 409), or A7 serves the model-correction row with address null.
  - **Reproduced:** mutants B, C and D each left the existing suite green. Probes E3 and E3b
    caught them. Both probes pass on unmodified code.
- (c) **The 500 path keeps the pair.**
  - **The gap:** `test/listings-d1.test.ts:1650` asserts that the listing stays `paying` and that
    the batch rolled back, but not that the pair survives. The pair does survive by construction:
    it is cleared in the same statement as `'paid'` (`src/listings.ts:828-830`), and the batch
    (`:833`) rolls back as a unit.
  - **Reproduced:** probe E2. The pair is kept, the 500 log line carries it, and
    `GET /api/listing/:id` serves it beside `settlement: "pending since …"`.
- **Fix:** move E1, E3, E3b and E2's three assertions into the suite. They are written, in the
  probe file named under "Verified first-hand", which uses the suite's own helpers.

**L3. A payee left out of step cannot resync by re-declaring the same address.**
- **Where:** `src/wallets.ts:66-73`.
- **Defect:** the `unchanged` short-circuit compares only the `wallets` table. Suppose write 2
  (the chained row, `:98-104`) failed after write 1 (the upsert, `:75-90`) committed. Or suppose
  the accepted concurrent-declare race (`:92-97`) left the newest chained row naming a different
  address. In either case, re-declaring the table's address returns "That is already your
  declared wallet. No change needed, and no identity-log row was written", and check 1 keeps
  refusing with `wallet_row_address` (`src/listings.ts:637-639`).
- **Scenario and reproduction:** probe E7 used the real `declareWallet` with write 2 made to
  fail. The table reads B and the chain still says A, so the pay probe is refused
  `wallet_row_address`. Re-declaring B returns `unchanged: true` and appends no row, and the pay
  is still refused.
- **Why LOW:** this is money-safe. Before this wave, `walletFor` would silently have paid the
  table address, so the pin turned a silent mis-pay into a refusal. The recovery that works
  today is to declare any other address and then change back. Nothing served says so: the 409
  says only "nothing is paid until they agree".
- **Fix (follow-up, not this wave):** short-circuit only when the newest chained wallet row also
  names the address (`walletAddressFromRow`), and otherwise append the row. Alternatively, name
  the recovery in the 409. Brief §9 keeps full atomicity out of scope; this fix is much smaller
  than atomicity.

**L4. The deploy script.** `scripts/deploy-wallet-pin.ps1`
- (a) **The bearer is on a native command line.**
  - **Where:** `:133` puts commonhold-agent's bearer in curl.exe's argv. This is the first
    script here to do that: `grep "Authorization: Bearer" scripts/*.ps1` finds only this line,
    and every `.mjs` reads custody in-process.
  - **What holds:** the bearer is never printed, since `:139` prints only the status and the
    code. It is never written to disk, since the temp file holds only the body (`:132`).
    `$secret = $null` at `:135` runs before the parse at `:138` can throw, so a parse failure
    prints no secret.
  - **What does not:** argv is readable by same-user processes, and by command-line process
    auditing where that is enabled.
  - **Fix:** curl's `-H "@<file>"` (headers read from a file, written without a BOM and deleted
    in a `finally`), or an in-process `Invoke-WebRequest` inside `try`/`catch`.
- (b) **A failed attest fetch after the deploy reads as minting.**
  - **Where:** `:103-104`.
  - **Defect:** if the fetch fails, `$attestAfter` is `$null`. The test then evaluates
    `$null -ne <hash>`, and the script stops with "template_hash CHANGED: this wave was expected
    to be non-minting". That false alarm points at the one thing that did not happen.
  - **Fix:** stop on `$null -eq $attestAfter` first, with its own message.
- (c) **Step 2 (`:72-76`) never asks whether existing payees can be paid under R.** That is C2.

**Notes (no action):**
- **The check-2 409 carries no `code`** (`src/listings.ts:762-767`). The brief asked only for a
  change to its message. The pay script handles it conservatively: on a non-200 from leg 2 it
  asks the chain, and it writes `refused` only when the nonce is unexecuted
  (`scripts/pay-listing.mjs:621-636`). The message names only "no longer the payee's newest", but
  a database-holder edit to the pinned row (hash, kind, citizen or deletion) lands in the same
  409 (test 5). That case is outside the stated threat model.
- **A4 checks `to` and `value` only**, as its comment says (`src/x402.ts:113-127`). The
  destination binding holds whatever the facilitator does, because USDC's EIP-3009 signature
  covers `to`: a transfer settled from this authorization can only reach `payTo`. The exact value
  comparison also means an authorization signed for more than the requirement can no longer
  settle and be recorded at a fixed price (`PRICE_CENTS`, `REGISTRATION_PRICE_CENTS`).
- **Column order differs:** `schema.sql` places the listings pair after `paying_since`, while
  0016 appends it. Nothing reads these tables by position (no `SELECT *` or `.raw(` touches
  them), and the drift detector compares sorted names (`test/listings-migration-d1.test.ts:60-61`).
  0014 had the same shape.

---

## Mutants (scratch copy only; each restored and checksum-verified)

| Mutant | Change | Existing suite (1205) | Gate probes |
|---|---|---|---|
| A | `x402.ts:137`: drop `.toLowerCase()` on `reqs.payTo` | **all green** | E1 red |
| B | `listings.ts:758`: drop the `NOT EXISTS` kind filter | **all green** | E3, E3b red |
| C | `listings.ts:627`: drop check 1's `MAX` kind filter | **all green** | E3b red |
| D | `listings.ts:1091`: drop A7's kind filter | **all green** | E3b red |
| E | the builder's M7: check 1's address comparison off | test 3 red | none |
| F | the builder's M8: `NOT EXISTS` neutralised (placeholders kept) | test 4 red | E6 red |

---

## The brief's eight questions

1. **Can any path settle to an address other than the pinned row's? No application path can.**
   Each step binds the destination:
   - **Check 1** (`src/listings.ts:613-640`, called at `:688`) requires all of these:
     - the row exists, is a wallet kind and belongs to the submission's citizen;
     - it is that citizen's `MAX(id)` wallet row;
     - it carries the pinned hash;
     - `walletAddressFromRow` equals `walletFor`'s value exactly.
   - **The requirements** (`:694-699`) take that same value as `payTo`, and the stored bounty as
     the amount.
   - **A4** (`src/x402.ts:130-143`, called at `:172`, before `/verify` at `:176`) holds the
     signed `authorization.to` to `payTo`, case-folded, and holds `value` exactly. The object
     forwarded to the facilitator is the one A4 validated, re-serialised (`:174`). So there is
     no parser differential: duplicate keys collapse to what A4 saw.
   - **The reservation** (`src/listings.ts:753-761`) re-identifies the same row (id, citizen,
     kind, hash) and requires no newer wallet row, in one statement.
   - **Settlement** can then only reach `payTo` (see the A4 note).

   The builder's M7 and M8 reproduce here (mutants E, F).

   The one window that passes both checks: `declareWallet`'s write 1 (table to B) has landed and
   write 2 has not, at the moment of the reservation. The money then goes to A, the pinned
   address, which was still the payee's newest chained row. That is A1's doctrine and §4.4's
   rejected wallets clause, and the served "at the reservation it was the payee's newest wallet
   row" is true of it. Not a defect.
2. **Can a stale, foreign or tampered pin pass check 1 or check 2? No.**
   - **Foreign:** refused by the citizen comparison at both checks.
   - **Tampered:** refused by the stored-hash comparison at both checks.
   - **Stale:** refused by the `MAX` at check 1 and the `NOT EXISTS` at check 2. Both order by
     id, and ids are `AUTOINCREMENT`, never reused (`schema.sql:80`).
   - **Between check 1 and the reservation:** any wallet row appended in this window makes the
     reservation match 0 rows (test 4, E6).
   - **Between check 1's two reads:** they are not atomic, but a row landing between them makes
     `MAX` greater than the row id, which refuses as superseded (fail-closed).
   - **`declareWallet`'s two writes:**
     - write 1 alone before check 1: the table and the row disagree, refused
       `wallet_row_address` (E7);
     - both writes after check 1: the reservation refuses;
     - write 1 alone after check 1: the Q1 window.
   - **The concurrent-declare race:** it leaves an out-of-step pair that check 1 refuses. Its
     only cost is L3.
   - **Why check 2 is authoritative:** its subqueries are evaluated inside the UPDATE itself,
     whatever check 1 read.
3. **Does A4 refuse any legitimate payer? No, on the evidence.**
   - **The treasury:** it is EIP-55 cased (`wrangler.jsonc:27`), and A4 folds both sides
     (`src/x402.ts:137`). E1 proves this against the production value.
   - **The operator's four scripts** all sign the server's own 402 requirements through
     `buildAuthorization`, which sets `to: reqs.payTo` and `value: reqs.maxAmountRequired`
     (`scripts/register-maintainer.mjs:180-190`). The call sites are `register-maintainer.mjs:385`,
     `lobby-sponsor.mjs:300`, `post-listing.mjs:312` and `pay-listing.mjs:750`.
   - **The values** are all server-built decimal strings:
     - `REGISTRATION_PRICE_ATOMIC = "1000000"` (`src/register-gate.ts:28`);
     - `String(feeCents * 10_000)` (`src/listings.ts:382`), where the fee is an integer
       (`Math.ceil`, `:49-51`);
     - `String(listing.bounty_cents * 10_000)` (`:697`).
   - **A number-typed `value` is refused.** That is a stated decision (checkpoint note 1). I did
     not re-check third-party x402 clients' payloads, but by the scheme they carry strings.
   - The only weakness is in the tests (L2a).
4. **Is every served sentence true of the code? Two are not: M1 and L1.** The rest hold:
   - **`WALLET_ROW_BOOK_NOTE`** (`src/listings.ts:277-278`), clause by clause:
     - "newest at the reservation": `:758`;
     - "stored hash matched": `:634`, `:757`;
     - "named payee_address": `:637`, with `payee_address` = `reviewerWallet` at `:827`;
     - "null before the check": 0016's nullable columns, and brief test 7;
     - "does not recompute the chain": `:634` compares the stored column.
   - **`PAYEE_WALLET_ROW_NOTE`** (`:279-280`): true. "null if they have none" holds because the
     A7 join drops a citizen whose `MAX` is NULL (`:1087-1096`, test 11).
   - **Guide step 4** (`:1131`): true, including "A refusal writes nothing public". The only
     write before a pin refusal is the reg_log throttle row (`:655`, then
     `src/society.ts:736-737`), and no route serves reg_log.
   - **The discovery description:** true. Its note is false in the race window (L1).
   - **The 502 message** (`src/listings.ts:795`): true.
   - **Check 1's "Nothing was issued or settled"** (`:618-638`): true. Check 1 runs before the
     requirements and before `payAndSettle`, on both legs (test 2).
   - **A4's "Nothing was sent to the facilitator":** true (test "A4 inside payAndSettle").
5. **A6: the pair is correct on every exit.**
   - **Recorded** by the reservation, in the same UPDATE (`:754`, binds `:760`).
   - **Release** clears it with `paying_since` (`:809`, test 10).
   - **Paid** clears it in the `'paid'` UPDATE (`:829`) and copies it to the book row
     (`:826-827`), in one batch (`:833`) (test 1).
   - **502** keeps it, and the 502 body and log line carry it (`:786-797`) (test 10).
   - **500** keeps it via the rolled-back batch. The log line carries it (`:835-848`); the 500
     body does not, and A6 asked only for the 502 body and the two log lines (E2).
   - **A check-2 refusal** writes no pair (test 4).
   - **Withdrawal** is possible only from `'open'` (`:900`), so it cannot strand a pair.

   `GET /api/listing/:id` on a listing left `paying` by the 500 path serves `status: "paying"`,
   `paying_since`, and `paying_wallet_row_id`/`_hash` equal to the checked pair
   (`:1098-1108`). Its `settlement` reads "pending since … a payment is being settled; not open
   for submissions" for the first 600 s (`UNRESOLVED_AFTER_MS`, `:255`), then "unresolved since …
   until the operator reconciles it against the chain" (E2). `?status=unresolved` on the list
   route serves the time but not the pair (`:992-996`). That is consistent with A6, which names
   only the detail route.
6. **The deploy script.**
   - **Order:** 0016 (`:80-84`) runs strictly before `wrangler deploy` (`:99`), gated by the
     post-migration catalogue check (`:85-95`). The order is load-bearing for reads, not only
     writes. Without 0016, the new worker fails `GET /api/listing/:id` and
     `GET /api/listings/payments` with "no such column". It also fails the reservation after
     `/verify` and before `/settle` (E8).
   - **Fail-fast:**
     - every native step checks `$LASTEXITCODE` (`:58`, `:61`, `:83`, `:100`);
     - JSON reads stop on a bad read (`:24`, `:28`) or throw under
       `$ErrorActionPreference = "Stop"`;
     - a partial 0016 state stops (`:71`), and a complete one skips (`:80`);
     - row counts and NULLs are verified (`:92-94`).
   - **Partial states:**
     - migration applied but deploy failed: harmless to the old worker, which names its columns;
       a re-run skips 0016;
     - deployed but the ride failed: ride by hand.
   - **PowerShell 5.1 traps:** none found.
     - No two of the script's variable names collide case-insensitively (all checked; see the
       note at `:17-18`).
     - Every `-match`/`-notmatch` is on a scalar (`:50`; `:61` via `Out-String`; `:125` via
       `-join`).
     - Every collection is wrapped in `@()` (`:27`, `:35-36`, `:116`, `:120`, `:136`).
     - `Read-TableInfo` returns at least 9 rows, so the one-element unroll cannot bite.
     - Even if `payouts` is still at genesis (the handover's last figure; I did not check it
       live), `/api/attest` with `from = 0` reports `verified` for an empty chain
       (`src/chain.ts:496-497`: `empty` needs `from > 0`). So `:105-107` does not false-stop.
   - **The refusal-only ride:** the bearer is never printed or written, but it is on argv (L4a).
     The POST is refused before any state change other than the throttle row:
     - bearer authentication is read-only (`src/society.ts:312-338`), and the only
       `last_seen_at` write in `src/` is in `me()` (`src/society.ts:1844`), not on this path;
     - the throttle writes its reg_log row and prunes (`src/society.ts:736-737`);
     - then `parseWalletPin` refuses (`src/listings.ts:665`), before the listing is read.

     If the old worker were still answering, listing 3 (paid) would give a 409, so the ride
     cannot false-pass.
   - **Gaps:** L4b, and C2.
7. **Tests.**
   - **Load-bearing ones re-proven here:** M7 (test 3) and M8 (test 4).
   - **Vacuous individually:** in the probe variant of test 2
     (`test/wallet-pin-route-d1.test.ts:204-219`), `verify === 0`, `settle === 0` and "nothing
     reserved" cannot fail. With no X-PAYMENT, `payAndSettle` returns the 402 before `/verify`.
     The same holds for the probe half of test 3's `settlePayTo === null`. The status-and-code
     assertion carries those rows, so do not read them as independent evidence.
   - **Test 4's message check** (`:265`) matches the generic 409 for any reservation refusal.
     The setup isolates the cause, so it still holds.
   - **A5's bind-count test** (`:306-313`) reads source text, so it cannot see a placeholder
     moved within the SQL. Test 5's behavioural per-clause cases cover that.
   - **The parity test's third assertion** (`test/wallet-pin-d1.test.ts:155-157`) restates the
     first two. It is redundant, not vacuous.
   - **Gaps:** L2 (a), (b) and (c).
8. **Brief versus build.**
   - **Done as briefed:**
     - R: the pin is required, and a missing or malformed one is a free 400;
     - check 1 with A2's two reads;
     - check 2 verbatim, with A5's eleven binds and per-clause tests;
     - the helper as the exact inverse of `walletLogEntry`;
     - 0016 with A6's four columns;
     - A6 on every exit;
     - A7, and A9's wording;
     - A4 inside `payAndSettle`, covering all four callers (`x402.ts:222`,
       `register-gate.ts:165`, `listings.ts:390`, `listings.ts:751`);
     - the script's pin on both legs, and its receipt check;
     - the non-minting v5 pin, still green.
   - **Done differently, and said so:**
     - The machine code sits in `code` beside a prose `error` (checkpoint note 1). The brief's
       precedent, `settlement_unconfirmed`, puts the code in `error` itself. A funder's client
       therefore handles two conventions.
     - The route tests have their own file (note 3).
     - The rehearsal ran before this gate (note 7), the reverse of §8's order. Harmless.
   - **Missed:**
     - The front door (M1): the brief's own §4.7 list missed it.
     - A6 says to state the reconciliation rule "in `docs/`". Only the brief and the checkpoint
       say it. There is no operator reconciliation runbook in `docs/`. The served 502 message and
       the pay script's recovery message do say it.
     - The checkpoint's `docs/DESIGN-ECONOMY-V1.md` note was made outside git: that file is not
       in the repo (checkpoint note 4 says so).

---

## Conditions

**C1 (before the push).** Fix `src/doc.ts:685` (M1). It is one line and non-minting. Make L1's
"before any payment" edit to `src/discovery.ts:135` in the same commit.

**C2 (before the deploy).** Run this read-only query against prod from `society/`. Zero rows are
expected:

```
npx wrangler d1 execute commonhold --remote --command "SELECT w.citizen_id, w.address FROM wallets w WHERE NOT EXISTS (SELECT 1 FROM identity_events e WHERE e.id = (SELECT MAX(e2.id) FROM identity_events e2 WHERE e2.citizen_id = w.citizen_id AND e2.kind IN ('wallet_declared','wallet_changed')) AND e.hash IS NOT NULL AND ((e.kind = 'wallet_declared' AND e.detail = 'wallet declared: ' || w.address) OR (e.kind = 'wallet_changed' AND length(e.detail) = 104 AND e.detail GLOB 'wallet changed: 0x* -> ' || w.address)))"
```

- **What a row means:** each row names a citizen whose declared wallet the new worker cannot pay:
  there is no chained wallet row, or the newest one names another address or another case.
- **If a row appears:** that citizen stays unpayable until they declare a *different* address,
  because re-declaring the same one does nothing (L3). Decide before deploying.
- **Proven able to fail** (probe E5, local SQLite):
  - it flags a table-only wallet, an out-of-step pair, and a mixed-case table address;
  - it passes a clean declaration, a change, and a payee with a later non-wallet row.
- **The change arm uses `GLOB`, not `LIKE`**, because SQLite's `LIKE` is case-insensitive and
  would miss the mixed-case row (E8 shows `LIKE` returning 1 where `GLOB` returns 0).
- **Windows:** run it in PowerShell as one line. The single quotes, `||` and `*` all sit inside
  the double-quoted argument, where neither PowerShell nor cmd.exe treats them specially. This
  exact string was not run through `npx.cmd` here.
- **Better:** add the `COUNT(*) AS n` form to step 2 of the deploy script, so `-DryRun` reports
  it.

---

## What I did NOT check
- **Anything live** (the brief forbade network and `wrangler`). So these are unverified:
  - prod's `wallets` and identity rows (C2);
  - how prod D1 executes the reservation's subqueries;
  - the script's parse of real `wrangler --json` output. The checkpoint's prod dry run covers
    this last one.
- **The facilitator's own `/verify` and `/settle` behaviour.**
- **Third-party x402 client payloads** beyond the project's own scripts.
- **PowerShell execution of the deploy script.** I read it; I did not run it. The argv-visibility
  point in L4a is general Windows behaviour, not tested here.
- **A public-key funder's intent binding on the pay route.** That is D-056 scope, not this wave.
- **The exchange records for this wave.** Not read, to keep this record independent.

## Verified first-hand, and how
- **The suite:** `npm test` in the worktree at `4f07460c` ran 1205/1205, and `npm run typecheck`
  exited 0.
- **The scratch copy:** a byte-identical copy of `src/`, `test/`, `migrations/`, `scripts/` and
  the configs, in the session scratchpad, with `node_modules` by junction. Checksums matched the
  worktree, including `x402.ts` at `a66876a0…`. It ran 1205/1205.
- **The throwaway probe file** (`test/zz-gate-wallet-pin.test.ts`, in the copy only) held eight
  tests: E1, E2, E3, E3b, E5, E6, E7 and E8 (there is no E4). All were green on unmodified code.
- **The mutants:** A-F are as tabled. Each was applied by exact single-match replacement, run
  against the whole suite, then restored from the worktree and checksum-verified.
- **Cleanup:** the copy and its junction were deleted afterwards. The junction was removed with
  `rmdir`, so it was never followed; the worktree's `node_modules` entry count was 42 before and
  after. The probe file alone is kept outside the repo, so its tests can be lifted into `test/`:
  `C:\Users\bengr\AppData\Local\Temp\claude\C--Users-bengr-Projects-AI-domain-and-social-network\804bfee5-2d2c-483c-bf4f-6c6f6bcb3bd9\scratchpad\zz-gate-wallet-pin.test.ts`.
  The scratchpad belongs to this session and may not survive it. If it is gone, the probe
  descriptions and the mutant table above are enough to rewrite the tests.
- **The worktree is untouched:** checksums of `src/listings.ts`, `src/x402.ts`,
  `src/wallets.ts`, `src/discovery.ts`, `src/doc.ts` and `scripts/deploy-wallet-pin.ps1` were
  identical before and after. `git status --porcelain` shows only the untracked gate brief and
  this record.
- **Reasoning, not reproduced:** the Windows argv exposure (L4a), and the case-insensitive
  `-ne` comparison at `:89`, which is harmless because SQLite type names are case-insensitive.
