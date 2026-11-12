# D-018 deploy gate (Sonnet tier): residency by an outside account, 12 Nov 2026

**Verdict: DEPLOYABLE WITH CONDITIONS.** HIGH 0, MEDIUM 0, LOW 3.

Scope: `resident-account-2026-11-12`, commits `9e9bb20a..1160e29c` (five commits; main `9e9bb20a` is live). Spec: `drafts/BRIEF-RESIDENT-OUTSIDE-ACCOUNT-2026-11-12.md` (B1-B15 override). Re-derived from source; the seats' and builder's conclusions were not relied on.

Tests, run in the worktree by this gate: `npm test`: tests 3163, pass 3162, fail 0, skipped 1. `npm run typecheck` (`tsc`): exit 0, no output.

## Findings

### HIGH
None.

### MEDIUM
None.

### LOW
- L1. `scratch-p.mjs` (repo root, added in `1160e29c`) is a one-off script that rewrites `test/resident-served-text-d1.test.ts` in place if run. It is not under `src/`, is not bundled and typecheck passes with it, but it is stray junk and a footgun on main. Remove it before merge.
- L2. `src/resident-account-core.ts:53` (`RESIDENT_ACCOUNT_NOT_CHECKED_SENTENCE`) lists "that the account is an agent" under "what is not checked" and then says the Colony's own `user_type` must say agent. The code does refuse a Colony account whose `user_type` is not `agent` (`src/resident-account-verify.ts:207`), relying on the platform's label. True, but the sentence reads as self-contradicting. Wording only.
- L3. A third party can spend the global hourly challenge or claim cap (100 an hour, `src/resident-account-core.ts:5-8`) and so delay everyone's recovery. This is bounded and disclosed by `RESIDENT_ACCOUNT_DELAY_SENTENCE`, which says the limits do not guarantee when recovery is available. No action, recorded for the first-week watch.

## What was checked, by focus area

1. **Identity takeover.** Recovery needs (a) a live challenge whose `claim_code_hash` equals the submitted code, selected by constant-time compare over all live challenges for that resident, purpose and platform, never "latest" (`src/resident-account.ts:163-176`); the code is returned once to the asker and never appears in the posted text; (b) a proof comment created after the challenge, containing the nonce and the resident number standing alone; (c) the comment's author account id (not handle) equal to the stored `external_account_id` (`:213-220`). The token-hash snapshot is taken before the outside read (`:180`), and the guarded UPDATE (`:290-295`) matches that old hash, the live challenge and the bound account, so a concurrent recovery makes it match nothing; the burn and the visitors rewrite are conditional on it (`changes() = 1`; `src/showhome.ts:490-493` writes only if guests already carries the new hash). A stranger asking for a recovery challenge for a resident learns nothing and gains no token without posting from the bound account. A bind needs the guest token, a promoted guest, and the same code and proof; the INSERT is guarded on the token hash still being the guest's (`:237`). Another guest cannot reuse a posted proof: the nonce and number are bound to the challenge. Residual (accepted, disclosed in `src/doc.ts` and the privacy page): until a key or account is bound the token is the whole identity.
2. **Data integrity.** `migrations/0026_resident_accounts.sql`: two `CREATE TABLE IF NOT EXISTS` and one index; no change to any existing table; `schema.sql` carries the identical block. Bind is one batch: guarded INSERT, then two UPDATEs on `changes() = 1`; a UNIQUE violation aborts the whole batch (caught and mapped, `:244-253`), a zero-row INSERT leaves the promotion and the burn writing nothing, and the code checks all three change counts. The council claim INSERT gained the mirror guard (`src/council.ts:510-512`), and each INSERT carries its half inside the statement, so the cross-table exclusion holds under a race. A resident's own account may also be its council account (`visitor_id != ?1`).
3. **Isolation.** The new module never reads `citizens` and calls no citizen `authenticate`. `git diff --name-only` shows no x402, register-gate, payout, listing, settlement, wallet, governance, treasury or chain file in `src/` (only two test files that pin served text). The residents block on `/api/official` is a sibling of `composition` (`src/guest-core.ts:545-570`). A council seat needs a bound key at the challenge, the claim and the actor (`src/council.ts:371`, `:585`); ballot and flag by number already required `public_key`. The `src/doc.ts` change is in the operational RESIDENTS section outside `FRONT_DOOR_TEMPLATE` (the template spans from line 151; the section is near line 722, after the "DELIBERATELY NOT part of FRONT_DOOR_TEMPLATE" marker); the constitution pin tests pass, so no version mints. The two new MCP tools are deliberately absent from the template's prose tool list, and the test asserts that.
4. **Outside reads.** `get()` takes an `allowedOrigin` parameter; origin, manual redirect refusal, timeout and in-read byte cap are the council's existing code (`src/council-verify.ts`), unchanged except for the parameter. Both Colony ids are UUID-validated before they enter a URL. The Colony 404 shape, the comment/account agreement and `user_type` are checked; a changed shape is `unreadable`, never a verdict, and the challenge is only used on success. The exclusion list names exactly the two `commonhold-envoy` accounts (`src/resident-account-verify.ts:43-46`), matched by id or handle, and a claim from one is refused.
5. **Served text and privacy.** Read against the code: the route, recovery, read-retention, claim-code, delay and council sentences are true (recovery stores nothing but `used_at`; a bind stores ids, times and two hashes, not the comment text; the roster serves the account, which the privacy page now says in terms). The privacy page's date moved to 12 November 2026 and names the Colony as a recipient of requests. No overclaim found beyond L2.
6. **Counts.** See above.

## Conditions

- C1. Apply `migrations/0026_resident_accounts.sql` to production before the worker deploys. The roster, profile, `residentFacts`, key bind and key recovery now read `resident_accounts`; a worker without the table would 500 on `/api/official` and the resident routes. Additive and idempotent, so safe to apply first and safe to leave if the deploy is abandoned (the old worker ignores it). No deploy script for this wave is in the scope reviewed: the one Ben runs must order it so.
- C2. Remove `scratch-p.mjs` (L1) before merge.
- C3. After deploy, ride both routes once for real (a bind on each platform, then a recovery), and read the `resident_account_bind` and `resident_account_recover` funnel lines, since the outside reads have only run against fixtures here.

C3 as ruled by Ben, 12 Nov (DECISIONS D-082 note): no operator account binds, since the served exclusion undertaking forbids it. Ben rides a claim from the envoy account on each platform; each must reach both outside reads and the proof checks and be refused 403 operator_account (binding no resident; the challenge and claim-attempt rows are still written). The positive bind and recovery are ridden by the first outside resident.
