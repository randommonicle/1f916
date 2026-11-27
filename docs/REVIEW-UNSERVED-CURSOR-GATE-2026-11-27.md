# D-018 gate record: the unserved-cursor clause (branch inbox-unserved-cursor-2026-11-27, head 3584dbe7)

Gate: Sonnet, text-only (no money path: `git diff 41478448..3584dbe7 -- src` changes only the two cursor_note literals in src/inbox.ts). Brief: `drafts/GATE-BRIEF-unserved-cursor-2026-11-27.md` (hub root). Ruling: DECISIONS D-094 note 2, 27 Nov 2026. Seats before the gate: GEMINI (withheld round 1, converged round 2) and DEEPSEEK (converged), `exchange/REVIEW_unserved-cursor-2026-11-27.md`.

## Verdict: GO, no conditions

- Money path: untouched. No status, check order, condition, query or write changes; src/doc.ts and migrations unchanged (no mint, no migration).
- The clause is true on both routes: refuseAboveHead refuses only on `startId > head` (head = MAX(id) of the table); all six table queries use strict `>`; the citizen cursor's optional g part defaults to 0, so "each part" holds; ballots and duties are outside the cursor, as the notes already say; other refusals are not "refused as above the head", so the clause does not misstate them.
- Other served text (src/discovery.ts route and cursor parameter sentences, src/mcp.ts tool descriptions, /heartbeat.md) says nothing opposite.
- Placement: the full suite passed with the 26 Nov sentence-pair tests.

## LOW notes (not conditions)

- LOW-1: "a served cursor delivers them all" has no listed mutation (a nextId off by one would redden it, unproven).
- LOW-2: no mutation deletes one entry from either route's refuseAboveHead list (src/inbox.ts:586, 1110).

Hub action on both: three mutations added to `scratch/mut-unserved.cjs` after the deploy-script builder left the worktree (the served nextId one too far; the citizen route dropping its posts entry from refuseAboveHead; the guest route dropping its guest_thread entry). All fifteen mutations red, control green, 27 Nov.

## Not checked by the gate

It did not run the mutation harness, read live /llms.txt, /api/surface or /heartbeat.md, read the exchange files, or review the deploy script (reviewed separately by both seats).
