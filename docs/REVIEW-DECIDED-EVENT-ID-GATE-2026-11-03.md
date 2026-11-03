# D-018 gate (Sonnet tier, not the money path): decided_event_id (D-078 item 3), run 2026-11-03

Scope `7b49b7b6..7b62aec5`, worktree `scratch/wt-decided-event-id`, branch `decided-event-id-2026-11-03`. Read-only review. `npm test`: 2999 pass, 0 fail, 1 skipped; `npm run typecheck`: clean. Exchange file not read before forming this view.

**VERDICT: DEPLOYABLE WITH CONDITIONS.** HIGH 0, MEDIUM 0.

## Derived from source

- **commitOutcome** (src/governance.ts ~1525-1600). `finalStmt` is built inside the attempt loop with that attempt's `log.hash`. Batch is `[log.stmt, ...settingStmts, finalStmt]`, so the event insert is first, the optional settings upsert second, the final UPDATE last; `logRes` is still result 0 and the `changes !== 1` test is unchanged. The `status='tallying' AND tallied_at=?` gate is unchanged. Claimed-elsewhere: the log insert's own gate and the final UPDATE's WHERE both fail, so no pointer is written. UNIQUE head collision: D1 batch rolls back, the next attempt re-prepares with a new hash, so the pointer cannot name a foreign or never-written event. The caller no longer builds the status UPDATE; no other caller of commitOutcome exists.
- **Migration 0023**: one ADD COLUMN (nullable INTEGER, no REFERENCES) plus one UPDATE, between BACKFILL markers. Backfill requires status decided, all tally fields and tallied_at non-NULL, exactly one prefix candidate at tallied_at, and the linked event matching kind, created_at, actor = proposer, sealed hash and the full canonical detail (executed amendment kinds read as `passed`). Only one code path flips a proposal passed to executed (governance.ts:2169, amendment kinds only), so the CASE is complete. A decoy or wrong-count event cannot be linked. The six live shapes (1,6) (2,12) (5,16) (6,20) (7,25) (8,37) all fit.
- **verify-decided-event-id.sql** mirrors the backfill predicate and adds the non-decided-row-with-pointer case. Zero rows on valid data; each corruption (NULL pointer, wrong target, duplicate candidate, wrong detail/actor/seal, NULL tally field, stray pointer) makes a row appear.
- **Serving**: field in the two SELECTs (listProposals, getProposalDetail), note on the list body; the four MCP tools delegate. No other proposal-row surface gained it (inbox, rule7-vote read named columns). Note text is accurate: it claims a consistency check only, discloses backfill, and the amendment case.
- **Deploy script**: reads use `--command`, `--file` only for migration and backfill; pending=0 preflight fails closed; every bounded step passes `Assert-Window`; migration before worker; post-activation backfill plus verification; ride covers six surfaces and `/api/attest` (four chains' sealed_entries and head compared); placeholders for both pins stop before any git call; rollback text is true (column stays, idempotent backfill after any old-worker tally).
- **Red-proofs sampled by reading**: T1 (drop pointer from the UPDATE: `decided_event_id !== null` fails); T3 retry (bind the first hash: sub-select returns NULL, pointer assertion fails); T8 (rewrite pointer in the flip: pointer or detail equality fails); T6 (one-word change fails exact equality).

## Findings

### HIGH / MEDIUM: none

### LOW

**L1. Served note omits the null-after-decided case.** "Null while open or tallying" implies decided rows are non-null. A decided row the backfill could not link would serve null. The script's step 6/8 verification stops that on prod today; the note could add "or, for a decided row, if it could not be matched". No change required to deploy.

**L2. Chains-unchanged check can false-stop.** `Test-ChainsUnchanged` (deploy script ride step) aborts if any identity event lands during the window. The worker is already live at that point, so it fails safe, but the operator gets "something wrote, read by hand". Acceptable; rare.

**L3. Pre-existing:** `Read-D1Rows` finds the JSON by the first `[` in wrangler output; a banner containing `[` would fail closed (a stop, never a false pass).

## Conditions

1. The scratch-D1 rehearsal of 0023 against a prod copy (hub, with Ben) must show the six pairs and a zero-row verification before `$REVIEWED_COMMIT` is set; step 5 would otherwise stop after the column is applied (harmless to the old worker).
2. Hub sets `$REVIEWED_COMMIT` to the final reviewed sha; any later change outside the script's allowlist needs a re-gate.
