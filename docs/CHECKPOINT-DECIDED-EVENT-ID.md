# Checkpoint: decided_event_id (D-078 item 3)

Brief: drafts/BRIEF-DECIDED-EVENT-ID-2026-11-03.md (amendments A1-A6 override B1-B6, T1-T7). Branch decided-event-id-2026-11-03, cut from main 7b49b7b6.

## 1. Migration 0023, schema.sql, verification SQL, T5

- migrations/0023_decided_event_id.sql: ADD COLUMN (no REFERENCES, A6), then the backfill between `-- BACKFILL BEGIN` / `-- BACKFILL END` markers so the deploy script can re-run exactly that UPDATE (A5 step 6). Backfill links a decided row only when exactly one event carries its id prefix at tallied_at and that event matches actor, seal and the full canonical detail (amendment exception: a currently executed first_laws_amendment or text_amendment was tallied `passed`).
- schema.sql: column last in proposals (as ADD COLUMN leaves it). scripts/verify-decided-event-id.sql: the A2 query, returns offenders.
- test/decided-event-id-migration.test.ts (7 tests; the harness DB has the column dropped, then the real migration file is applied).
- Red-proofs: (a) widening the backfill count pattern ' (%' to '%' reds the prod-shaped test (decoy `proposal 12 (`); (b) deleting the actor clause reds the wrong-event test (wrong actor); (c) replacing the verification's `e.id = p.decided_event_id` with `1=1` reds the wrong-pointer test. Each restored, 7/7 green.
