# D-018 PRE-DEPLOY GATE — constitution v5 fee-framing correction (2026-09-13)

**Reviewer:** independent Opus adversarial gate (D-018). Briefed from files, verified
first-hand against source and the live service. READ-ONLY throughout — no push, deploy,
migration, secret write, or remote state change; only this record was written.

**Scope.** The three-commit change committed locally in `society/`, ahead 3 of
`origin/main`, HEAD `ecccf63`, NOT pushed, NOT deployed:
- `631f2a1` fix(served): non-minting surfaces (register-gate 402 description,
  showhome `convert` field + its comment) + red-proofed test.
- `6a327f1` feat(constitution): v5 mint — the `FRONT_DOOR_TEMPLATE` TREASURY paragraph
  in `doc.ts`; regenerated 8 goldens + D-061 guard hash.
- `ecccf63` docs(checkpoint): expected v5 hashes (docs only).

It rewords the $1 registration toll from "the society's sybil defence" to rent + an
accountable on-chain money-in signal, per ratified D-054/D-055/D-062/D-063. The TREASURY
sentence sits inside the hashed template, so the deploy mints constitution v4→v5,
`changed_by=operator`.

---

## Findings (by severity)

### HIGH
None.

### MEDIUM
None.

### LOW

**L1 — "a real payer stood behind each seat" is accurate as written; tightening is
editorial only, non-blocking.**
Surfaces: `society/src/doc.ts:263-264` (inside the hashed template) "an accountable record
that a real payer stood behind each seat"; `society/src/showhome.ts:545` (not in the
template) "an accountable sign that a real payer stood behind the seat".

My own reading: **not an overclaim.** The claim quantifies over SEATS, and every seat is a
`register()` success. Evidence:
- The sole production `INSERT INTO citizens` is `society/src/society.ts:711`, inside
  `register()`. `register()`'s only caller is `society/src/register-gate.ts:181`, which is
  unreachable unless settlement succeeded: `payAndSettle` at `:165` then
  `if (!result.ok) return result.response;` at `:166`. So for every seat that exists, a
  settled $1 x402 payment with a recorded payer preceded it (ledger append `:172-177`).
- The paid-but-failed path (`register-gate.ts:182-202`) produces a payer WITHOUT a seat —
  the opposite direction. It does not falsify "each seat has a payer"; it would only bite
  "each payment produced a seat", which no served surface claims.
- The wording is silent on WHO paid: `register()` (`society.ts:655`) takes no payer
  argument, so it never binds payer→citizen. Consistent with the D-058 sponsored-seat
  disclosure (a sponsor or the operator can be the payer).
- Live check corroborates present-tense extent (first-hand, 2026-09-13):
  `GET /api/citizens` returned 7 citizens (commonhold-agent, ledger-watch, first-reader,
  the-doorpost, sisyphus, keyholder, magnus-v2), and `GET /treasury` returned exactly 7
  registration ledger entries (ids 1-5, 10, 11), each naming a payer address and tx — one
  per seat. Six share the operator payer `0x3f29…`; sisyphus has a distinct payer
  `0xb54b…`. So every current seat has an accountable ledger line with a real payer, and
  the "six share one payer" fact is precisely why the wording stays silent on WHO paid.

CODEX's optional candidates ("…funded the successful registration" / "…record of the payer
for this seat") are marginally clearer but carry a re-mint cost for the `doc.ts` instance
(follow-up commit + regenerated goldens + moved guard hash). Ben's editorial call; no
correctness need. Recorded, not required.

**L2 — the normative "which belongs at the vote" reads as *where it should live*, not
*where it already exists*; non-blocking.**
Surfaces: `society/src/doc.ts:265` "...it is not the society's defence against sybils, which
belongs at the vote and not at the door"; `society/src/showhome.ts:545` "...not the
society's defence against bad actors, which belongs at the vote". D-054 ruling 4 records
that the capability-scoped standing defence is NOT built, measured, or scheduled. A reader
could in principle parse "belongs at the vote" as asserting a defence exists there. My
reading: "belongs" is normative placement, not an existence claim, and it aligns exactly
with D-054 ruling 1 ("the defence belongs at the ballot, not a price at the door") and
D-062 ("keeping the toll is not a claim that it protects anything"). The relative clause
attaches unambiguously to singular "defence" (agrees with singular "belongs"), not to
"sybils"/"bad actors". Not misleading.

**L3 — housekeeping.** The exchange file header says "ahead 2 of origin"; the tree is
ahead 3 (`ecccf63`, docs-only). No code under review changed. Noted for accuracy; no impact.

---

## Required adversarial checks — dispositions

1. **Served-text accuracy.** doc.ts:262-266, register-gate.ts:151-155, showhome.ts:544-546
   read cleanly and do not overclaim (see L1/L2). The register-gate 402 line carries no
   "seat" claim at all. PASS.
2. **Blast-radius completeness.** Case-insensitive grep over `society/src` for
   `sybil|barrier|brake|deterrent|spam|bad actor|defen[cs]e|at the door|toll` plus a
   targeted sweep of officialFacts, llms.txt/discovery, mcp.ts, mcp-read.ts. Every hit
   classified:
   - Served, fee-as-defence framing → ONLY the three corrected surfaces
     (register-gate.ts:154, showhome.ts:545, doc.ts:264-265).
   - `register-gate.ts:73` "not an open sybil door" — CODE COMMENT bounding an
     invite-redemption race; correctly LEFT.
   - `showhome.ts:69` "a barrier we assumed rather than checked" — served, but a UX
     adoption-barrier research question, not a fee-defence claim.
   - `society.ts:1425-1436` officialFacts `sanctioned_money_in`, `x402.ts:164` patron,
     `doc.ts:79/101` JOIN fragments, `discovery.ts:97/176`, `mcp.ts:35/333/433` — all
     mechanical "$1 USDC" / rent framing, NO defence claim.
   - All remaining `defen[cs]e` hits are unrelated server-side security comments
     (auth/signature/rate-limit). No missed served surface. PASS.
3. **Mint mechanics.** Recomputed from the CLEAN committed tree (`git status --porcelain`
   empty) by importing the production `computeLiveConstitutionPair()`:
   - `template_hash = fa11788d062b0c6d23c54c428c1c9649d263ae3ba704e602e122066926049491`
     (live is `281003e6…`; moved as expected).
   - `parameters_hash = 83c76b5abfe8af794f198e0d656c8f0efda7f99340ed1adae5ff2fddeef6f6b6`
     (equals live EXACTLY — UNCHANGED; no vote-class parameter moved).
   State-invariance confirmed at source: `buildConstitutionTemplate()`
   (`governance.ts:1816`) takes NO arguments and reads only module constants (both
   name-status fragments, First Laws banner, both join fragments — a canonical superset);
   `serializeConstitutionParameters()` (`governance.ts:1864`) reads only the vote-class
   constants. Neither touches DB state. So proposal 7's close and name ratification mint
   nothing. PASS. **No schema change / migration in this change → single worker deploy, no
   ordering hazard.** `parameters_hash` does not move (no vote-class constant changed), so
   the vote-class attestation is untouched. For the chains at first observation, see
   check 9 (minting appends ONE row to the identity_events chain — this is expected, not an
   anomaly).
4. **changed_by classification.** Mandate detection (`governance.ts:2054-2059`) selects
   `status='passed' AND kind IN ('first_laws_amendment','text_amendment')`. Proposal 7 is
   kind `first_laws_ratify` (confirmed live: `GET /api/proposals` → id 7, kind
   `first_laws_ratify`, status `open`), which is a DISTINCT kind (governance.ts:57-60,
   78-81) and excluded by the filter. Live proposals show NO passed row of either mandate
   kind (only resolution#1 advisory and set_name#6 executed are passed). So `changed_by`
   resolves to `operator`, and this holds whether v5 is first observed before OR after
   proposal 7 closes (2026-09-15 11:40Z). PASS.
5. **D-061 secret-literal guard.** `PROSE_ALLOW` FRONT_DOOR_TEMPLATE hash moved
   `46d4cc25…`→`bbdfbaf3…` (the `6a327f1` diff shows exactly ONE allowlist line replaced,
   zero added/removed → no count drift; the other five doc.ts secret-literals unchanged).
   `test/secret-literal-guard.test.ts` passes (the guard recomputes the decoded literal
   hash via its own lexer and compares to PROSE_ALLOW; its pinned baseline of 66
   secret-literals / 43 allowlist entries still reconciles). PASS.
6. **Golden regen.** `test/doc.test.ts` "F2 golden served page ... pinned for all eight
   (registrationMode × nameRatified × firstLawsRatified) states" PASSES against the
   committed v5 goldens. The `6a327f1` source diff to `doc.ts` is localised to the TREASURY
   paragraph alone; the TREASURY text is invariant across all 8 branch states, so only that
   sentence moved in every golden. (CODEX independently reconstructed all 8 v4 goldens by
   substituting only the TREASURY paragraph: `new_occurrences:1, new_ok:true, old_ok:true,
   length_delta:112`.) PASS.
7. **Test integrity / red-proof.** `test/showhome-d1.test.ts` now asserts
   `doesNotMatch(room.convert, /sybil/i)` (load-bearing) + `match(room.convert, /rent/i)`.
   Proven load-bearing against the actual committed strings: the parent (`8be47d7`) convert
   line contains "the society's sybil defence and its rent" (so `doesNotMatch(/sybil/i)`
   would THROW on it); the new (`631f2a1`) convert line contains no "sybil" and contains
   "rent". *A source-edit red-proof (reintroduce "sybil" in the source and watch it fail)
   was NOT run because of the read-only constraint; the parent-vs-commit string comparison
   is equivalent evidence and the test passes on the committed source.* PASS.
8. **L-002 residue.** The change rewords only the $1-fee framing and introduces no version
   numbers, incident identifiers, or claims about the upstream parent deployment. The
   `l002-residue.test.ts` passes when run by name (`ℹ pass 3 / fail 0`) and is part of the
   full 1080-test suite. No residue introduced or exposed. PASS.
9. **What else the mint triggers at deploy (first observation).** Verified at source:
   - `detectConstitutionChange` batches the version INSERT with an `appendChainedStmt(...,
     "identity_events", { citizen_id: MAINTAINER_ID, kind: "constitution_changed", detail,
     ... })` (`governance.ts:2086-2105`). So minting v5 APPENDS ONE row to the
     **identity_events** chain (the `identity_log` in `/api/attest`). **Deploy expectation
     for the one-real-ride:** `identity_log` `sealed_entries` 21 → 22, `status:"verified"`;
     `treasury` 11, `payouts` 0, `ballots` 14 UNCHANGED; a new `constitution_versions` row
     (version 5, `template_hash fa11788d…`, `parameters_hash 83c76b5a…`, `changed_by
     operator`, `mandates=[]`). A healthy read is 22, not 21 — do not misread the increment
     as tampering. (Matches the v4 precedent: identity 16→17 at the v4 mint.) The
     `constitution_changed` event's `detail` will read `constitution changed
     281003e6…/83c76b5a… -> fa11788d…/83c76b5a… changed_by=operator mandates=[]`
     (`governance.ts:2085`).
   - **Fidelity review is queued, review-only, bounded.**
     `reconcileConstitutionFidelityQueue` (`governance.ts:2193`) runs at each cron wake
     after detection and queues AT MOST ONE `constitution_fidelity` item per non-genesis
     version, idempotently (`governance.ts:2181-2192`). The judge classifies it
     matches/exceeds/no-mandate; for v5 the honest verdict is "no mandate" (an operator edit
     with no vote), which is correct and expected. It executes NO governance outcome —
     `judgment.ts:363` verbatim: "approving or rejecting the item is how you record that
     verdict, nothing about the society's rules is executed by this decision either way."
     Cost (price-the-spend): one bounded model call at the next judgment wake (Sundays 07:00
     UTC, D-021), visible in `/api/maintainer-runs`. Not a deploy blocker; flagged so the
     operator expects the one queue row and its one judgment cost. PASS.

---

## Recomputed hashes + test / typecheck (verbatim)

Tree confirmed clean before recompute (`git status --porcelain` → empty output; HEAD
`ecccf63`), so the recompute is pinned to the committed tree at that commit.

Recompute via `computeLiveConstitutionPair()` imported from the committed
`society/src/governance.ts`:
```
template_hash  = fa11788d062b0c6d23c54c428c1c9649d263ae3ba704e602e122066926049491
parameters_hash= 83c76b5abfe8af794f198e0d656c8f0efda7f99340ed1adae5ff2fddeef6f6b6
```
- template_hash: live `281003e6…` → committed `fa11788d…` (moved as expected for v5).
- parameters_hash: equals live `83c76b5a…` EXACTLY (UNCHANGED — only the template moved).

Live `/api/attest` on 2026-09-13 (HTTP 200): `constitution.version=4`,
`template_hash=281003e6491efdee2d25718525bc6dbd79007ecc3f368c3f0c483c408184477a`,
`parameters_hash=83c76b5abfe8af794f198e0d656c8f0efda7f99340ed1adae5ff2fddeef6f6b6`,
`changed_by=operator`.

Full suite (`npm test`), verbatim tail:
```
ℹ tests 1080
ℹ suites 0
ℹ pass 1080
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```

Load-bearing files run by name
(`node --experimental-strip-types --test test/doc.test.ts test/secret-literal-guard.test.ts
test/showhome-d1.test.ts`), verbatim:
```
ℹ tests 61
ℹ pass 61
ℹ fail 0
```
including `✔ F2 golden served page: frontDoor's output is pinned for all eight ... states`
and `✔ secret-literal guard: every 'secret' literal in src/ is a reviewed wire token or an
allowlisted prose entry, none unreviewed`.

Typecheck (`npx tsc`): exit 0, no output.

---

## Corroboration (read after forming findings, not relied on as findings)
The cross-agent exchange `exchange/REVIEW_fee-framing-correction-v5_2026-09-12.md` converged
`[[CONVERGED]]` DEPLOYABLE across GEMINI and CODEX; CODEX independently recomputed the same
`fa11788d…`/`83c76b5a…` pair and ran `tests 1080 / pass 1080 / fail 0`, `TYPECHECK_EXIT=0`.
My gate re-derived every load-bearing point independently and agrees, including the "each
seat" quantifier reading and the changed_by exclusion of `first_laws_ratify`.

---

## VERDICT: DEPLOYABLE
