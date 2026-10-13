# Checkpoint log: bind the council flag to its act (DEFERRED-COUNCIL-FLAG-INTENT)

Branch `council-flag-2026-10-13`, base `5c04ca34` (live as worker `acfa546b`). Builder: Sonnet 5.5. Commission: `drafts/BUILDER-COMMISSION-COUNCIL-FLAG-2026-10-13.md`; contract: `drafts/BRIEF-COUNCIL-FLAG-INTENT-2026-10-13.md` with A1-A8.
Nothing pushed, deployed, migrated or written to a network. No `*.local.*` file read. No money route, register path, mint, migration, `schema.sql`, cron or `src/doc.ts` change. `authenticate`, `authenticateByAssertion` and `requireSignedIntent` untouched. No sub-agent. Gate: Sonnet (A8).

Baseline (before any edit, from the commission): 2429 tests, 2428 pass, 1 skip; tsc clean.

## Notes (one per commit)

1. Checkpoint started; worktree `scratch/wt-council-flag`, `node_modules` junction to `society/node_modules`.
2. C1, the citizen op. `"council_flag"` added to `INTENT_OPS` (`src/keyauth.ts`); `citizenCouncilFlagParts` (and the resident `councilFlagParts`, used from C2) in `src/council-core.ts`; `flagCouncilMotion` calls `requireSignedIntent(actor.credential, "council_flag", [motion id])` right after `resolveActor` and before the motion is read or the operator-seat check. Tests: `test/council-flag-binding-d1.test.ts` (plain refused with the binding named and no council state change; another motion, `council_ballot`/`ballot`/`proposal` over the same parts refused; bound accepted; the unbound refusal precedes the motion lookup; an unbound assertion burns its citizen nonce, allowed per A6; secret exempt; operator seat still refused). Existing tests moved: the `flagMotion` helper now builds a bound key assertion; `test/resident-isolation-d1.test.ts` INTENT_OPS assertion lists the eighth op; `test/council-ballot-binding-d1.test.ts` thread-cap comment (8 ops + rotation + none = 10, exactly the daily cap). Served: the `/api/surface` note for the flag route now documents the `council_flag` binding (the aud-drift guard in `test/discovery.test.ts` requires it for every `INTENT_OPS` member); its resident sentence is completed in C2/C5. Red-proof: the `requireSignedIntent` line commented out turns three tests in the new file red (restored, green).
