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
- [ ] Ben ratifies the exact constitution wording (governance act; D-056 ruling 4).
- [ ] Exchange pre-gate (Gemini + CODEX), then D-018 Opus gate (authority-bearing text).
- [x] flag-deferred-items: add "fee-as-defence framing" named class + grep flag to
      docs/BRIEF-HARDENING-2.md (I-008 build-time served-text gate). DONE: §5a,
      grep token DEFERRED-FEE-FRAMING-GATE.
- [ ] Ben push (per-action approval).
- [ ] Ben deploy (v5 mints at deploy; changed_by=operator).
- [ ] one-real-ride: GET /api/attest shows v5; /api/showhome + 402 read corrected.
- [ ] RedEmma reply sent (Ben) AFTER deploy verified.
- [ ] DECISIONS.md pointer (correction as operator act) + LESSONS if warranted.

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

## Status (2026-09-12, committed locally; ratified; NOT pushed, NOT deployed)
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
