# Checkpoint: decided_event_id (D-078 item 3)

Brief: drafts/BRIEF-DECIDED-EVENT-ID-2026-11-03.md (amendments A1-A6 override B1-B6, T1-T7). Branch decided-event-id-2026-11-03, cut from main 7b49b7b6.

## 1. Migration 0023, schema.sql, verification SQL, T5

- migrations/0023_decided_event_id.sql: ADD COLUMN (no REFERENCES, A6), then the backfill between `-- BACKFILL BEGIN` / `-- BACKFILL END` markers so the deploy script can re-run exactly that UPDATE (A5 step 6). Backfill links a decided row only when exactly one event carries its id prefix at tallied_at and that event matches actor, seal and the full canonical detail (amendment exception: a currently executed first_laws_amendment or text_amendment was tallied `passed`).
- schema.sql: column last in proposals (as ADD COLUMN leaves it). scripts/verify-decided-event-id.sql: the A2 query, returns offenders.
- test/decided-event-id-migration.test.ts (7 tests; the harness DB has the column dropped, then the real migration file is applied).
- Red-proofs: (a) widening the backfill count pattern ' (%' to '%' reds the prod-shaped test (decoy `proposal 12 (`); (b) deleting the actor clause reds the wrong-event test (wrong actor); (c) replacing the verification's `e.id = p.decided_event_id` with `1=1` reds the wrong-pointer test. Each restored, 7/7 green.

## 2. A4: pointer written inside commitOutcome's retry loop; T1, T2, T3, T3b, T8

- commitOutcome now takes the settings statements and the final values and builds the final proposal UPDATE per attempt, binding that attempt's `log.hash` into `decided_event_id = (SELECT id FROM identity_events WHERE hash = ? AND kind = 'proposal_decided')`. Batch order: log statement, settings upsert, final UPDATE; logRes stays first. No `decided_event_id IS NULL` condition.
- Tests: T1, T2 (failed, and executed with the settings upsert), T3 (the F6 real collision test extended: pointer names the retry's event), T3b (stale claimant leaves the committer's pointer), T8 x2 (first_laws_amendment and text_amendment tallied by the real sweep, which itself runs constitution detection and flips them to executed: pointer, counts, passed event unchanged; separate constitution_changed event). T8 needs a fresh ConstitutionCache passed to the sweep (module cache otherwise leaks between tests).
- Red-proofs: (A) drop the pointer from the final UPDATE: T1, T2, T3(F6), T3b, T8 x2 red. (B) bind the first attempt's hash: F6 collision test red. (C) drop `status = 'tallying' AND tallied_at = ?` from the final UPDATE: T3b plus three existing stale-claimant tests red. (D) flip UPDATE nulls the pointer: T8 x2 red. All restored.

## 3. B4 + A3: serve the field; T4, T6, T7

- `p.decided_event_id` added to the listProposals page SELECT and the getProposalDetail SELECT; `decided_event_id_note` (DECIDED_EVENT_ID_NOTE, A3 text exactly) beside the other notes on listProposals. The four MCP tools delegate to these two functions, so they carry both unchanged.
- test/decided-event-id-serve.test.ts: T7 (six surfaces carry the stored pointer), T4 (open and tallying serve null, key present), T6 (note equals the A3 text on HTTP and both doors; no "proves/guarantee", no transaction-history claim), A6 scope (inbox response does not contain the field; this one has no red-proof: the inbox builds its summaries from ballots, nothing in it can reach the column).
- Red-proofs: dropping the column from the list SELECT or from the detail SELECT reds T4 and T7; changing "not independent confirmation" to "and independent confirmation" reds T6. Restored. Full suite 2962 pass, 1 skip, 0 fail.
