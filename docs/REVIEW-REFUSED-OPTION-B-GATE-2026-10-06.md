# D-018 gate: option B, a first-attempt rule-7 refusal stays pending (MONEY PATH), 2026-10-06

Gate: Opus, no sub-agents, read-only. Scope `8e5d2782..76c22c45` (12 commits), worktree `scratch/wt-refused-b`. Suite re-run here: 1831/1831. Brief: `drafts/GATE-BRIEF-REFUSED-OPTION-B-2026-10-06.md`.

## Verdict: DEPLOYABLE WITH CONDITIONS. HIGH 0, MEDIUM 1, LOW 4.

The money-safety property B exists for holds: no answer invites a second signature before the chain's own expiry proof. The MEDIUM is liveness (who waits, and for how long), not money.

## The questions

**Q1, the B write.** Holds. `markFirstRefusal` (`src/settlement-claims.ts:353-361`) requires the strict holder and `updated_at = takenAt`, never writes over a stopped row, and never writes `state` or `rpc_body`. Between `takeClaim` (`src/x402.ts:604`, which writes `takenAt` from `:596` as created_at and updated_at) and the write (`:742`), this request makes no claim write: `settleOrThrow` touches no table, and its `noteUnknown` sits in the catch. So its own path cannot withhold a genuine refusal. A holder that lost the lease writes nothing and is answered from the claim (`:764`). `rpc_body` survives every B path, so every B row can reach C6.

**Q2, nothing invites early.** Holds. The first answer is `claimAnswer`'s pending branch: 502 with no `accepts` (`settlement-claims.ts:714-722`). A re-send meets the B4 consult before `/verify` (`register-gate.ts:204`, `listings.ts:424`, `x402.ts:1351`), and `attemptPending` produces `accepts` only after `markExpired`. The conflict 409, the contradiction 500 and the pay route's catch carry none. The trailing direct 402 needs a call without a claim, and all four production call sites pass one (`register-gate.ts:258`, `listings.ts:432`, `:896`, `x402.ts:1353`).

**Q3, no stranded row.** Every B row has a route out. The listing release is the second statement of `markExpired`'s batch, bound by `RESERVATION_BOUND` and `changes() = 1` (`settlement-claims.ts:320-335`). How long the route out takes depends on the backlog: see M1.

**Q4, served text.** Step 0 is true on each route. T is `valid_before + 300` (`:607-609`). The repeat clause is absent on listing_pay. Nothing changed in `doc.ts`, migrations, schema or config, so there is no mint. Sweep gaps: L1, L2.

**Q5, old rows and the fixture.** The pre-B `refused` arm is unchanged, contradiction stamp first. **My mutant:** the B write set `state = 'refused', rpc_body = NULL`, and the branch restored the old 402 with `accepts`. The ordering fixture went red on "I4: claim is refused, but since option B no production path writes `refused`" (11 traces, `FIRST(refused)` serving the 402 with accepts), and so did its three pinned first-refusal tests. `refused-option-b-d1.test.ts` went red in the unit test, the source scan and every step-0 test. Both files were restored byte-identical (sha256 checked), and the tree is clean.

**Q6, the reconciler's selection.** It uses no window function. The UNION ALL with inner LIMITs and its binds are valid SQLite. D1's acceptance is unproven (L-016), hence C1. Slot starvation across kinds is closed; budget starvation is not (M1).

**Q8.** The two recorded checks stand; add C1. Live reads today (`?status=unresolved` 0, no open listings) fit an empty anti-join but do not replace it.

## Findings

**M1 (MEDIUM): an expiry proof leaves no budget for a second row.** `src/settlement-reconcile.ts:214` starts a row only if `actualCost + 18 <= 26`. An aged first refusal's expiry costs 8, which is 9 with the select, and 9 + 18 > 26, so the second row of that pass is shed. Under B, every refusal a payer does not re-send after T becomes such a row; before B, a refusal cost the reconciler nothing. I ran two probes on this branch, using its own helpers in an uncommitted scratch test:
- **PROBE A:** three patron refusals older than a settled-unbooked payment, all past T. The booking waited **4 passes**, so F1's aim (refusals cannot starve bookings) fails here.
- **PROBE B:** a listing_pay refusal behind four older aged refusals. The listing was released on **pass 5**. The funder has no other exit: a re-send is refused at `listings.ts:659`, and `POST /api/maintainer/run` fires only clerk or judgment wakes (`src/maintainer/trigger.ts:35`).

The starvation test (`test/refused-option-b-expiry-d1.test.ts:386-422`) passes for a reason it does not name. It backdates `updated_at` but leaves `valid_before` in the future, so each refusal takes the cheap H2 re-POST (7 with the select) and leaves room for the booking (L-124 class). Money never moves wrongly, and rows older than three days surface as `pending_aged`. Prod is believed to hold no claims (Add 84 s11; C2 checks) and has no open listings, so this is latent. Fix shapes: price the next row by its own route and kind instead of the global 18, or let a listing_pay re-send reach its claim.

**L1:** `RECONCILE_BACKSTOP` still serves "oldest attempt first" (`settlement-claims.ts:556-557`, pinned at `test/settlement-replay-fixes-d1.test.ts:363-365`). After F1, a newer settled row can share a batch ahead of an older second pending row.

**L2:** `settlementField`'s dated arm (`listings.ts:279-288`) promises the reconciler, but a dated `paying` listing can still have no claim after deploy. When `takeClaim` throws and the re-read also throws (`x402.ts:630`), the reservation is kept whether or not the INSERT landed. Nothing will release that listing, and before B the by-hand wording was true.

**L3:** the first-refusal answer says both "re-send after T" and "Repeating this identical request re-checks it sooner" (`settlement-claims.ts:562`). Each is true; together they invite the pre-T re-sends F3 is about.

**L4:** listing_create's free checks run before the consult (`listings.ts:386-393` before `:424`), so a funder at the daily limit is refused before reaching the claim. The repeat clause has had the same condition since M2. Nit: the comment at `listings.ts:959` mentions a `/verify` refusal after the reservation, which cannot occur.

## Q7 ruling on F3, `DEFERRED-RESEND-COOLDOWN`: (a), acceptable to deploy with the flag

1. **No money consequence.** Every re-send outcome fails closed. An unreadable chain means no re-POST, an unknown `/settle` leaves the row pending, and the 180 s lease serialises attempts on each claim.
2. **Bounded per authorisation.** While the chain reads unused, `/settle` is re-POSTed only before validBefore (`x402.ts:1074`), at most about 360 s after signing. After that come at most 300 s of chain reads and one expiry proof, and then the answer comes from the row.
3. **The same resources are already reachable at the same order per request.** Unauthenticated `GET /treasury` makes up to four uncached fetches to the same `baseRpcUrls` (`index.ts:217`, `society.ts:2304`), and the patron door sends any well-formed signature to PayAI `/verify` with no throttle. What is new is about two D1 UPDATEs per re-send. B does let a stranger create a pending row on demand if rule-7 refusals are cheap to produce, and whether PayAI's `/verify` checks the balance is unproven.
4. **Holding B for a cost bound keeps the double-payment window open.**

**Un-defer triggers** (any one): evidence that PayAI meters or rate-limits `/settle` per call; the first production first-attempt refusal, or logs showing repeated re-sends of one claim; outreach that drives paid traffic. **The bound needs no migration:** a pending row whose `verdict_reason` carries classifySettle's rule-7 prefix, re-sent before its T, is answered from the row (no lease, no RPC, no `/settle`) without the repeat clause, which also fixes L3. After T the row runs as now, and a late success is seen through the chain reading used, which delays it without losing it. Its test: an immediate replay makes zero RPC and zero facilitator calls.

## Conditions

- **C1 (Ben, wrangler, read-only, before deploy).** D1 must accept the reconciler's statement. In PowerShell, assign the query below to `$sql` with a single-quoted here-string, then run `npx wrangler d1 execute commonhold --remote --command $sql`. Pass: a count comes back (0 is fine). An error stops the deploy. I ran this exact text locally: it parses, and the constants match.
  `SELECT COUNT(*) AS n FROM (SELECT * FROM (SELECT * FROM settlement_claims WHERE state = 'settled_unbooked' AND (leased_until IS NULL OR leased_until <= 9999999999999) AND (verdict_reason IS NULL OR verdict_reason NOT IN ('handle_taken', 'listing_not_paying')) AND (verdict_reason IS NULL OR substr(verdict_reason, 1, 32) <> 'chain_spent_facilitator_refused:') AND NOT (route = 'register' AND json_extract(intent_json, '$.public_key') IS NULL) ORDER BY updated_at ASC, created_at ASC LIMIT 2) UNION ALL SELECT * FROM (SELECT * FROM settlement_claims WHERE state = 'pending' AND (leased_until IS NULL OR leased_until <= 9999999999999) AND (verdict_reason IS NULL OR verdict_reason NOT IN ('handle_taken', 'listing_not_paying')) AND (verdict_reason IS NULL OR substr(verdict_reason, 1, 32) <> 'chain_spent_facilitator_refused:') ORDER BY updated_at ASC, created_at ASC LIMIT 2))`
- **C2 (Ben, before deploy).** Run the two recorded checks. A non-empty anti-join stops the deploy.
- **C3 (hub, before merge; tests and comments only).** (i) Add a starvation variant whose refusals are past T and pin PROBE A's behaviour; re-title the existing test so it claims only the cheap case. (ii) Plant `DEFERRED-RECONCILE-EXPIRY-SHED` at `settlement-reconcile.ts:214` with M1's fix shapes. (iii) Rewrite the `DEFERRED-RESEND-COOLDOWN` text (`x402.ts:863-867`) to record this ruling, its triggers and the shape of the bound. (iv) Flag L1 and L2 where they are served, unless they are fixed in this wave.
- **C4 (Ben).** Open no new listing until M1 or DEFERRED-PAY-LISTING-RESEND-REPLAY is fixed. listing_pay is the one route where B can hold an honest party with no exit of their own and no operator lever. D-074 S1 already keeps listings closed.
