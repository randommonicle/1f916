# D-018 gate (Opus, money path): the treasury's address refused as a wallet, 24 Nov 2026

Head `70202a1e`, live base `097a4a89`. Verdict: **DEPLOYABLE WITH CONDITIONS**. HIGH 0, MEDIUM 0, LOW 5.

**For Ben:** you ruled the declaration refusal; the pay-route refusal is the hub's addition.

1. **Paths.** `declareWallet` alone writes `wallets`; `handlePayListing` alone sets `payTo`. Direct edit: lowercase meets `wallet_is_treasury`, mixed-case or padded `wallet_row_address` (probed). Moved to the treasury during `/verify`: pays the address checked. Not closed: the treasury as payer (needs its key), an address forwarding there, a claim already made (booked or re-POSTed, rightly). L1: `recordPayout` and `createSubmission` still accept such a row (probed).
2. **Order.** Before intent and "unchanged"; before pin check, 402, claim, reservation, facilitator. Nothing after settlement calls it: a settled claim booked after the treasury became the payee (probed).
3. **False refusals.** None: exact equality; absent, blank, padded and cased configuration tested.
4. **Sentences.** True of these paths. L2: `listings.ts:1456` "never party" turns false if `TREASURY_ADDRESS` ever becomes a past payee's.
5. **Shape.** `error`, `code`, no `answered_by`, exactly as `wallet_row_superseded` (probed with a payment header). No other answer moves.
6. **Mutations.** 28, 23 killed. L3, survivors: the refusal below the pin check, below `replayForClaim`, the discovery note dropped (all three on the full suite), and both "nothing written/issued" phrases. Suite 3564, 3563 pass, 0 fail, 1 skipped; typecheck exit 0.
7. **Ride.** `/api/attest` commit; `/api/surface` carries `wallet_is_treasury`; `payments_out.note` carries the refusal. Neither refusal rides without a credential. Rollback worker `7c1bf0d2`, no migration; it drops all three waves.
8. **Claims (L4).** Paid or paying listings are refused earlier, unchanged. A reopened one is reached: an expired claim loses its 402; a contradiction-stamped one (money may have moved) loses "do not sign again" for "Nothing was issued or settled". `wallet_row_superseded` already does that to any payee who re-declares; this also needs a treasury row. Not worse.

L5: `POST /api/wallet` says "Nothing was written"; a key citizen's nonce is spent and its assertion day stamped. `WALLET_RACED_MESSAGE` says so.

**Live (GET):** two wallet rows, no changes, neither the treasury; 0 open or unresolved listings, attention 0.

**Seats** (read afterwards): both converged; neither raised L2, L4 or the L3 order gap.

**Conditions.** C1: tell Ben. C2: repeat the live reads immediately before deploy. C3: ride 7. C4: this record moves the branch head; pin accordingly.
