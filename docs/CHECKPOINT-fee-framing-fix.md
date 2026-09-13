# Checkpoint: fee-as-sybil-defence served-text correction (v5 mint)

**Goal:** Correct the three served surfaces that call the $1 registration toll
"the society's sybil defence" to describe it honestly (rent + an accountable
money-in signal), aligning served text with the ratified governance position
(D-054, D-055, D-062). Accept the v4->v5 constitution mint for the one string
inside FRONT_DOOR_TEMPLATE.

Scope decided with Ben 2026-09-12: all three surfaces + v5 mint; fix-first (the
RedEmma reply, D-062 going public, is HELD until this deploys).

## Why (verified first-hand)
- D-062 (ratified 2026-09-12): "Keeping it is not a claim that it protects
  anything." D-054: the defence belongs at the vote, "not a price at the door."
  D-055: one ballot carries an advisory vote at $1 or $0.
- Census (blast-radius grep, not the 3 places handed over): served doc.ts:263
  (MINT), register-gate.ts:154, showhome.ts:543; justifying comment
  showhome.ts:479-481; test assertion showhome-d1.test.ts:341 (would BLESS the
  corrected text via its `/rent` branch). register-gate.ts:73 reviewed and LEFT
  (bounds an invite race, not a fee-as-defence claim); CHECKPOINT-showhome.md:143
  LEFT (historical record).
- template_hash is state-invariant: buildConstitutionTemplate() (governance.ts:1816)
  is argument-free and renders a canonical superset, so the 15 Sept first_laws flip
  mints nothing. There is no future mint to ride; deferring the constitution line
  means deferring it indefinitely.

## Checklist
- [x] Commit A (non-minting): reword register-gate.ts:154 + showhome.ts:543 +
      comment showhome.ts:479-481; rewrite test showhome-d1.test.ts:338-341
      (negative assertion load-bearing, red-proofed). DONE 631f2a1.
- [x] Commit B (v5 MINT): reword doc.ts:263 constitution TREASURY prose;
      regenerate doc.test.ts golden fixtures deliberately. DONE (this commit).
- [x] Ben ratified the exact constitution wording (2026-09-12; D-056 ruling 4).
- [x] Exchange converged DEPLOYABLE (GEMINI + CODEX, 2026-09-13); D-018 Opus gate DEPLOYABLE (docs/REVIEW-V5-FEE-FRAMING-GATE-2026-09-13.md).
- [x] flag-deferred-items: add "fee-as-defence framing" named class + grep flag to
      docs/BRIEF-HARDENING-2.md (I-008 build-time served-text gate). DONE: §5a,
      grep token DEFERRED-FEE-FRAMING-GATE.
- [x] Pushed the v5 commits (2026-09-13; origin ecccf63).
- [x] Deployed (2026-09-13; npx wrangler deploy; v5 minted).
- [x] one-real-ride GREEN (2026-09-13): /api/attest version 5, changed_by operator, identity 21->22, template_hash fa11788d..., parameters_hash unchanged; /api/showhome + register 402 read corrected.
- [x] RedEmma reply SENT (2026-09-13; 1f916 comment 58844 on post 4580); D-062 now public.
- [x] DECISIONS D-063 stamped DEPLOYED+VERIFIED (2026-09-13). LESSONS pending Ben: L-054 + a parallel-work-recon miss.

## Commit log
- **Commit A 631f2a1 (non-minting served text + test).** Reworded the 402-challenge
  description (register-gate.ts) and the /api/showhome `convert` field plus its justifying
  comment (showhome.ts); rewrote showhome-d1.test.ts so the negative `doesNotMatch(/sybil/i)`
  is load-bearing (red-proofed). Split from the mint so the constitution edit stays an
  isolated, reviewable operator act.
- **Commit B (v5 mint).** Reworded the doc.ts FRONT_DOOR_TEMPLATE TREASURY sentence
  (operator-ratified 2026-09-12); regenerated all 8 doc.test.ts goldens deliberately (a
  before/after diff proved ONLY the TREASURY sentence moved, e.g. invite_only,false,false
  391efd65...->4cf896b8...); moved the secret-literal-guard PROSE_ALLOW hash
  46d4cc25...->bbdfbaf3... via the guard's own lexer (other 5 doc.ts secret-literals
  unchanged). Mints v4->v5 at deploy when buildConstitutionTemplate() recomputes template_hash.

## Status (2026-09-12 pre-deploy record; superseded by the Closeout at the end of this file)
Suite 1080/1080, typecheck clean. Commits local; origin still 8be47d7.

Expected v5 at deploy (computeLiveConstitutionPair on the committed tree vs live /api/attest):
- template_hash: 281003e6... (v4 live) -> fa11788d062b0c6d23c54c428c1c9649d263ae3ba704e602e122066926049491 (v5)
- parameters_hash: 83c76b5abfe8af794f198e0d656c8f0efda7f99340ed1adae5ff2fddeef6f6b6 (UNCHANGED; live matches,
  so only the template moved, no vote-class parameter touched)
- version: 4 (live) -> 5 expected, changed_by=operator.

In flight: exchange REVIEW_fee-framing-correction-v5_2026-09-12.md opened (GEMINI auto-woken;
CODEX kickoff owed to Ben); Opus advisor passed twice; monitor armed for GEMINI/CODEX replies.
Remaining, all Ben's: CODEX kickoff -> exchange converge -> write D-063 -> push -> deploy (mints v5)
-> one-real-ride (attest template_hash=fa11788d..., version=5, params unchanged; /api/showhome + 402
read corrected) -> RedEmma send. Also owed: D-023 Dropbox mirror; full session-start agent run
(NOT done this session, task-scoped).

## Closeout (2026-09-13): DEPLOYED, MINTED, VERIFIED; RedEmma SENT
- Exchange converged DEPLOYABLE across GEMINI + CODEX (CODEX conceded the "each seat" quantifier objection; hashes independently re-derived). Record: exchange/REVIEW_fee-framing-correction-v5_2026-09-12.md, all sections [[CONVERGED]].
- D-018 Opus gate: DEPLOYABLE, 0 HIGH / 0 MED / 3 LOW (all non-blocking). Record: docs/REVIEW-V5-FEE-FRAMING-GATE-2026-09-13.md (committed with this checkpoint).
- Pushed + deployed (Ben, 2026-09-13). v5 minted and verified live on /api/attest: version 5, changed_by operator, first_seen_at set, template_hash fa11788d... (was 281003e6...), parameters_hash 83c76b5... UNCHANGED. Identity chain 21 -> 22 (the constitution_changed seal); treasury 11 / ballots 14 / payouts genesis unchanged. /api/constitution/versions total 5 with the v5 row.
- All three served surfaces confirmed corrected live: /api/showhome convert (GET); register 402 description (POST /api/register returns 402 with the rent/money-in text); constitution TREASURY prose (via the live template_hash).
- The mint queues one review-only constitution_fidelity item at the next judgment wake (Sun 07:00 UTC), expected verdict "no mandate" (correct for an operator edit); one bounded model call.
- RedEmma reply SENT (Ben ran the .ps1) and verified: 1f916 comment 58844 on post 4580, parent 54545, author commonhold-envoy; body matches the staged text; it is the thread tail. D-062 is now public.
- DECISIONS: D-063 stamped DEPLOYED+VERIFIED (2026-09-13). Dropbox mirror refreshed (D-023). HANDOVER Addendum 59 written.
- Process note (banked): a stale-snapshot round-2 was appended to the exchange while the seats converged in parallel (live-state-first / parallel-work-recon miss); closed cleanly with a round-3. Candidate lesson, pending Ben.
