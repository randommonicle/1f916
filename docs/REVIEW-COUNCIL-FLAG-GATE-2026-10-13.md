# Gate record: council flag binding (Sonnet gate, 13 Oct 2026)

HEAD gated: a522e93927c76e6ecbd76e5034ed16d10ccb22b8 (branch council-flag-2026-10-13, diff 5c04ca34..HEAD, 30 files). Tree clean.
Class check: src/society.ts, src/doc.ts, migrations/, schema.sql, wrangler.jsonc, cron, money routes: NOT in the diff. src/resident.ts changes the ResidentOp union and its comment only. Class holds (Sonnet).
Tests: npm test 2474 tests, 2473 pass, 0 fail, 1 skipped (pre-existing). npm run typecheck: clean.

VERDICT: DEPLOYABLE. HIGH 0, MEDIUM 0, LOW 3.

1. Binding (src/council.ts:963-1000). Branch is chosen by the presented Authorization credential before the body is read. Credential: resolveActor (never reaches input.token) then requireSignedIntent("council_flag",[motion]) at :974, before readMotion. No credential: number required (401 council_flag_unbound otherwise), guests row + public_key + council_claims, then verifyResidentAssertion("resident_council_flag", [number, motion]) at :995. Only write is the UPDATE at :1006. input.token is not read in flagCouncilMotion. Unbound request learns nothing about the motion (refusals precede readMotion; the unbound-citizen test uses a missing motion id). Cross-op: council_flag/council_ballot/ballot prefixes differ; resident_ family refused by authenticateByAssertion's prefix regex (society.ts:522, unchanged); cross-op matrix tests cover both directions.
2. Resident nonce (:1008-1024). Batch [nonceStatement, flagUpdate, nonceGcStatement] is identical in shape to the live resident ballot. Replay = UNIQUE on resident_nonces, batch rolls back, refuseBatchFailure maps it to the "already used" 401; zero-change UPDATE (already flagged, closed in flight) commits the batch and leaves the assertion spent, as the ballot does for clock/recusal losses. All pre-batch refusals (not a member, binding errors, operator seat, missing/closed motion, not eligible) precede the batch, so unspent. No mislabelled error path found.
3. Doors. mcp.ts:926 passes {number, assertion} to the same function; schema has no token; other council tools unchanged.
4. Served text. All surfaces checked (COUNCIL_WRITES_SENTENCE, council-core.ts:229,231, discovery.ts:356,692, mcp.ts:711, HEARTBEAT-SKILL-TEXT.md, SKILL_VERSION 1.4.2); none offers a resident token for a flag; room/motion sentences keep token. doc.ts untouched so the attested template is byte-identical.
5. Tests. Mutated a throwaway copy (outside the worktree; junction removed with rmdir, node_modules intact): deleting the requireSignedIntent line and dropping nonceStatement from the batch turned 7 of 10 flag-binding/resident tests red. Edits to existing tests are version/sha re-pins, the INTENT_OPS list, a token-then-assertion MCP step, and the hardening-script test now asserts the old marker equals 1.4.1 and differs from current (moved, not weakened).
6. Deploy script. Parses with the PowerShell parser: 0 errors. Both pins checked before any git/network command; LIVE_BASE_COMMIT=5c04ca34... set, REVIEWED_COMMIT placeholder; template byte-compare, migrations/schema.sql stop, v5 check, no D1 command; the one POST (unbound flag, 401 expected) is refused after the rate-cap row only, as stated.
7. Runtime. Nothing differs from the live ballot batch; the UPDATE cannot raise a constraint error; no fetch options, no compound SELECT.

LOW findings
- L1 src/mcp.ts:711 (and :692, pre-existing): description says the credential goes "in the credential property of this schema"; the property is named `secret`. Cosmetic.
- L2 src/council.ts:974: a key citizen's unbound, wrong-binding, or operator-seat flag attempt burns its citizen nonce (authenticate runs first). Documented (A6) and identical to the ballot.
- L3 src/council.ts:1008-1024: a resident flagging an already-flagged motion is refused 409 with its assertion spent (no pre-batch already-flagged read). By design and matches the ballot; costs the resident one signature.

Conditions: none. (REVIEWED_COMMIT must be set to a522e939... by the hub before the script runs.)
