**VERDICT (the delta `4f07460c..f20eefdf`): CLEAR WITH NOTES.** No path in the delta moves money to the wrong place, drops a reservation it should keep, or mints. Fix M1 (a few lines in the deploy script) before the script is next run, `-DryRun` included.

# D-018 narrow re-gate: the wallet-pin review-round fixes (2026-09-24)

**Reviewer:** an independent Opus re-gate, working from the re-gate brief and the full gate record
(`docs/REVIEW-WALLET-PIN-GATE-2026-09-24.md`). I did not read the exchange records.

**Scope:** `7d303af7` and `f20eefdf` only.

**Read-only:** no commit, push, deploy, migration, `wrangler`, network call to the live site, or
`*.local.*` file.

**Where the probes ran:**
- Against a local 127.0.0.1 server.
- On a checksum-verified copy of the worktree in the session scratchpad, since deleted.

This record is the only file written in the worktree.

## Findings

### HIGH
None.

### MEDIUM

**M1. A custody file that no longer parses prints the bearer, now in `-DryRun` too.**
- **Where:** `scripts/deploy-wallet-pin.ps1:66` (new, in section 0, which runs in `-DryRun`) and `:143` (the ride).
  The comment at `:63` says the secret is "never printed".
- **Defect:** both lines parse the file with Windows PowerShell 5.1's `ConvertFrom-Json`, under
  `$ErrorActionPreference = "Stop"`, with no `try`. 5.1's parser puts the whole input text in its exception
  message, and PowerShell prints the uncaught error.
- **Scenario:** the custody file is truncated or hand-edited so that it no longer parses. Any run of the
  script prints a line like `ConvertFrom-Json : Invalid object passed in, ':' or '}' expected. (N): {"handle":…,"secret":"commonhold_sk_…"}`.
  That includes an agent's `-DryRun` (checkpoint note 8 records an agent running one), so the bearer lands
  in a transcript. Before the delta, this parse ran only at the end of a real run, by Ben's hand.
- **Reproduced**, with dummy values on PS 5.1.26100:
  - `'{"k":"DUMMYVALUE123" "x":1}' | ConvertFrom-Json` gives `Invalid object passed in, ':' or '}' expected. (22): {"k":"DUMMYVALUE123" "x":1}`;
  - a truncated `'{"k":"DUMMYVALUE123'` gives `Unterminated string passed in. (19): {"k":"DUMMYVALUE123`.
- **Unlikely today:** the pay and post scripts parse this same file and field, and refuse anything else
  (`scripts/pay-listing.mjs:95`, `:760-764`).
- **Fix:** one helper, used at both lines, that prints nothing from `$_`:
  `function Read-CustodySecret { try { $s = (Get-Content $CUSTODY -Raw | ConvertFrom-Json).secret } catch { Stop-Here "custody file is not valid JSON (contents withheld)" }; if (-not $s) { Stop-Here "custody file did not parse to a secret" }; return $s }`.

### LOW

**L1. The three treasury callers return the new unknown-outcome 502 with no log line. One case lost the log line it had.**
- **Where:** the new throw at `src/x402.ts:209`, and the one at `:94`. `src/index.ts:496` returns a
  `SocietyError` without logging it; `:497` logs everything else.
- **Defect:** before the delta, a `/settle` body of JSON `null` threw a `TypeError` inside `payAndSettle`.
  `handleRegisterGate`, `handlePatron` and `handleCreateListing` let that reach `index.ts:497`, which
  logged `{level:"error", path, message}`. The same body is now a `SocietyError` 502, returned unlogged.
  - The other new unknown shapes were unlogged 402s before, so they lose nothing.
  - `handlePayListing` is unaffected: it logs `listing_pay_settle_unconfirmed` itself
    (`src/listings.ts:786`).
- **Scenario:**
  - A registration's `/settle` returns `null` after the facilitator has broadcast. The dollar reaches
    the treasury with no ledger row and no log line, so the operator can find it only on the chain.
  - The client is told 502 "unknown until the chain is checked", and nothing tells it not to sign again.
    The handle is still free, so a retry can settle a second dollar.
  - Both are still better than the old 402, which invited the retry outright.
- **Reasoned**, not run. From `index.ts:496-497` against the pre-delta side of
  `git diff 4f07460c..f20eefdf -- src/x402.ts`: `facilitator()` returned any parsed body, and `payAndSettle`
  read `settlement.success` directly.
- **Fix:** in `payAndSettle`, before both `/settle` throws, log one structured line, mirroring
  `listing_pay_settle_unconfirmed`. Fields: `resource`, `pay_to`, the authorization's `from` and `nonce`,
  and `reason`. Optionally add "do not sign again until the chain shows this authorisation unexecuted" to
  the two 502 messages (`:94`, `:209`), as the pay route already says.

**L2. The pay route's 502 now says "no answer was read" when one was.**
- **Where:** `src/listings.ts:795`.
- **Defect:** the sentence was true for the two cases it was written for, a rejected fetch and an
  unparseable body. The delta routes a third case here: a parsed JSON answer with no boolean `success`.
  The served message then contradicts itself: "The settle request was sent and no answer was read (The
  facilitator's answer to /settle was not a settlement result …)".
- **Money-safe:** `error: "settlement_unconfirmed"` and the kept reservation are right. The route test
  pins only the code (`test/wallet-pin-route-d1.test.ts:438`).
- **Fix:** change it to "no settlement result was read". This is non-minting, because `listings.ts` is
  outside `FRONT_DOOR_TEMPLATE`. The code comment at `:772-776` ("facilitator() THROWS on a rejected fetch
  or a non-JSON body") needs the same widening.

### Notes (no action needed for this deploy)

**The bearer outlives `$secret = $null`, inside `$Error`** (`deploy-wallet-pin.ps1:146`, `:154`).
- The caught 400's error record keeps the `HttpWebRequest` as its `TargetObject`, headers included.
- **Reproduced** with a dummy: after `:154`, `$Error[0].TargetObject.Headers["Authorization"]` still
  equals the dummy bearer.
- Under the documented `powershell -File` invocation, the process ends with the script.
- If it may ever be run inside an interactive session, add `$Error.Clear()` after `:154`.

**A non-JSON body from the ride crashes the script without a clean stop.**
- `:155` throws `ConvertFrom-Json : Invalid JSON primitive` on, for example, a Cloudflare HTML 5xx.
- This comes after `:154` has nulled the bearer, and after the deploy, so it is safe. It is still not a
  `Stop-Here`.
- **Reproduced.**

**The typed catch at `:148` works only under PowerShell 5.1.**
- Under `pwsh` 7, a 4xx throws `HttpResponseException`, which that catch does not match.
- The script's header prescribes `powershell`, which is 5.1.

**C2 is not in the script.**
- Step 2 (`:85-89`) counts listings, book rows and `paying` rows only, so the payability query stays a
  manual step before the deploy.
- Checkpoint note 8 records it as run on prod with zero rows. I did not verify that, because it is live.

**The wedge is deliberate, and how often it happens depends on the facilitator.**
- Any `/settle` refusal without a boolean `success` now keeps the reservation. An error-shaped body such
  as `{"error": …}` is one such refusal, and a facilitator can send one before or after it broadcasts.
- Each occurrence leaves one listing wedged in `paying` until the operator reconciles it by hand.
  `?status=unresolved` and the script's `paying` stop (`:89`) make it visible.
- The gate noted there is no reconciliation runbook in `docs/`, and that gap now matters slightly more.
- I did not check PayAI's own refusal shapes (`wrangler.jsonc:37`).

**The address clause in the discovery note holds at check 1.**
- In the gate's accepted Q1 window, the wallets table flips after check 1 and before the chained row
  lands, and the pinned address is still paid (`src/listings.ts:739-743`).
- The pay-script header in this delta now says so accurately.

## The brief's five questions

1. **`x402.ts`: the claims are true.**
   - `facilitator()` returns only an object that is neither null nor an array (`:92`). Anything else
     takes the path-aware 502 (`:93-96`).
   - After `/settle`, a `success` that is not a boolean throws a 502 (`:208-210`), and only
     `success === false` reaches the 402 (`:211-219`).
   - `success === true` is still the only success, so no settled answer became a refusal.
2. **The callers.**
   - **`handlePayListing`:** its catch keys only on `reservedByMe` (`src/listings.ts:784`). Every new throw
     after the reservation therefore keeps the reservation and the pair (`settlement_unconfirmed`,
     `:786-798`). A `/verify` 502 happens before the reservation and propagates with nothing reserved.
   - **The other three** (`src/register-gate.ts:165`, `src/x402.ts:243`, `src/listings.ts:390`): the throw
     propagates to `index.ts:496` as a 502. Each writes its ledger row only after `result.ok`, so no
     database record is skipped that used to be written. The one lost trace is the log line (L1).
   - A refusal now becomes an unknown that wedges a listing only when it lacks a boolean `success` (see
     the wedge note above).
3. **The served text is true and non-minting.**
   - **The door note:** the new body and pointer (`src/doc.ts:685-686`) sit in `listingsDoorNote`
     (`:671`), outside the template (`:136-480`). The v5 pin test is green among the 1211.
   - **The discovery pay note** (`src/discovery.ts:135`) now matches guide step 4 (`src/listings.ts:1131`).
     "A refusal writes nothing public" holds: the only write before a pin refusal is the reg_log throttle
     row, which no route serves.
   - **`AUTH_LABEL.x402_payment`** (`src/discovery.ts:178`) renders only as the header of llms.txt's x402
     group (`:259`). It is true for all four routes: registration and patron at $1, the listing fee, and
     the bounty.
   - **The pay-listing header and the `wallets.ts` DEFERRED note** are comments only.
4. **The deploy script.**
   - **Section 0's custody check** (`:64-67`) runs before any prod change, including in `-DryRun`. It
     prints nothing on a file that parses (see M1 for one that does not).
   - **`Read-Count`** (`:41-46`) stops on a missing result, several results, or a non-numeric one.
   - **The ride** (`:143-157`), replayed verbatim under PS 5.1 against a local server:
     - **a 400 with a JSON body:** lands in the catch with `status = "400"`, and the body is read (the
       stream was seekable, at position 0). The ride passes;
     - **a 200:** stops;
     - **a refused connection:** stops, with the bearer nulled first (`:150`);
     - **an HTML 502:** crashes at `:155`, after the bearer is nulled.
   - **The bearer is never on a command line**, which closes the gate's L4a. `SecurityProtocol` on this
     machine is `SystemDefault`.
   - **The unreadable-attest stop** (`:118`) comes before the minting comparison (`:119`). An HTML attest
     body throws in `ConvertFrom-Json` instead, which is not the minting alarm either. That closes L4b.
   - **Parse and names:** the 5.1 parser reports 0 errors. No new variable name collides with another
     case-insensitively (`$rows`, and `$r` inside `Read-Count`, are function-local).
5. **The tests:** each of the six new tests can fail (see the mutants below). The gaps:
   - **Masked rows in the settle table:** the new boolean check masks the `[true]` and `"success"` rows,
     so X3 survives. That is equivalent in behaviour on `/settle`. On `/verify` only `null` is covered.
   - **A test title claims the wrong address:** the A4 production-shape test's title says
     "(wrangler.jsonc)", but it uses `0xA7f7…`, not `0xD9E1…` (`wrangler.jsonc:27`). This is cosmetic:
     the fold logic does not depend on the address, and X4 proves the test fails when the fold is removed.
   - **L2c misses one of E2's three assertions:** it does not assert the 500 log line.

## Mutants

Each mutant ran on the scratch copy against the two changed test files (29 tests), and each was restored
byte-exact afterwards.

| Id | Change | Red |
|---|---|---|
| X1 | `x402.ts:208`: boolean-`success` check off | `x402.test.ts:176` and `wallet-pin-route-d1.test.ts:432` |
| X2 | `x402.ts:92`: loosened to `answer !== undefined` | `x402.test.ts:176` (its `null` row) and `:200` |
| X3 | `x402.ts:92`: only the array arm removed | **none** (masked, see question 5) |
| X4 | `x402.ts:144`: `reqs.payTo` not case-folded (the gate's mutant A) | `x402.test.ts:220` |
| X5 | `listings.ts:758`: check 2's kind filter dropped (the gate's B) | `wallet-pin-route-d1.test.ts:451` |
| X6 | `listings.ts:627`: check 1's kind filter dropped (the gate's C) | `:451` |
| X7 | `listings.ts:1091`: A7's kind filter dropped (the gate's D) | `:451` |
| X8 | the pair cleared in its own statement before the record batch (`listings.ts:833`) | `:467` |

The checkpoint's M22-M26 counts match X1, X4, X6, X8 and X2.

## Not checked
- **Anything live:**
  - prod's rows and C2's result;
  - PayAI's `/settle` refusal shapes;
  - whether PayAI ever answers `success:false` after a broadcast. The operator's pay script guards
    against that with its chain check; third-party funders have no such guard.
- **The deploy script end to end**, which needs `wrangler` and the live site. Only the ride's lines ran,
  verbatim, and only against a local server.

## Verified first-hand
- **The suite:** `npm test` in the worktree at `f20eefdf` ran 1211/1211, and `npm run typecheck` exited 0.
- **The worktree is untouched:** `git status --porcelain` was empty before this file was written. The
  checksums of `src/x402.ts`, `src/listings.ts`, `src/doc.ts`, `src/discovery.ts`, `src/wallets.ts`,
  `scripts/deploy-wallet-pin.ps1` and the two changed test files were identical before and after.
- **The scratch copy:**
  - It held `src`, `test`, `migrations`, `schema.sql` and the configs, with no `node_modules`, no
    `scripts` and no `.local.` file.
  - It was checksum-verified against the worktree and ran 29/29 unmutated.
  - It has been deleted.
- **The probe scripts** are kept in the session scratchpad, under `regate-probe\`: `server.mjs`,
  `build-and-run.ps1` (which builds the ride probe from the script's lines 144-157 verbatim) and
  `mutants.mjs`. The scratchpad may not survive this session.
