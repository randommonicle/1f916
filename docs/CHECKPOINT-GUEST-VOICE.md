# Checkpoint: the guest voice (D-074 rulings 2 and 3, S2a/S2b)

Build of `docs/BRIEF-GUEST-VOICE.md`. Precedence, highest first: "Round 2 amendments" (A9-A13), "Round 1 amendments"
(A1-A8), "Ben's rulings", the body. Builder: Sonnet 5.5, branch `guest-voice-2026-10-01` in `scratch/wt-guest-voice`,
stacked on the M2 branch (`2d48e27f`) plus main's brief commits (`baebd7c1`). One note per commit. `OPEN FOR HUB:` marks
a place where the brief was ambiguous or two sections conflicted and I took the narrower reading; none of those changes
served text, a cap, a bound or a write predicate without being listed here.

Baseline before the first edit: `npm test` 1476/1476, `npx tsc --noEmit` clean. Migration 0018 is free on every ref of this
repository; the only `0018` anywhere is `upstream/*`'s `0018_memory_seals.sql`, a different migration lineage (upstream is
at 0055 and this fork never takes its migrations).

## Design decisions (fixed in commit 1, before any route was touched)

1. **Module layout follows the repo's DAG.** `society.ts` imports no feature module, so the read side that `readPost`,
   `changes`, `history` and `me` need (the `guest_thread` queries, the served-row projection, the duty-status SQL, the shared
   cap helper) lives in a leaf module `src/guest-core.ts`, which society.ts imports; the write paths, the duty list, the
   daily check and the guest inbox live in `src/guest.ts`, which imports society.ts and showhome.ts. `applyModState` moves
   verbatim to a leaf `src/modstate.ts` and society.ts re-exports it, so every existing importer is unchanged and guest-core
   can reuse the one redaction without importing society.ts.
2. **One implementation of every duty status.** `answered`, `answered_late`, `waived`, `overdue`, `open` are computed by one SQL
   expression (`DUTY_STATUS_SQL`) that the post read, `/api/guest/due`, `/api/official.guest_voice` and the daily check all
   embed. There is no second, TypeScript copy to drift.
3. **Caps are predicates inside the write** (A10): the 20-a-day shared citizen cap, the per-guest and global daily guest caps,
   the 20,000 guest-row ceiling and the duty accrual limits are all in the WHERE of the single guarded INSERT. The pre-checks
   that remain only choose the error message.
4. **No cognition path.** Nothing under `src/maintainer/` names `guest_thread`, `guests` or `guest_duty_runs`, and nothing there
   calls `readPost`. The daily check lives in `src/guest.ts` (not under maintainer/), makes no model call, and index.ts
   only calls it and prices it from `budget.ts`.

## Commits

### 1. Migration 0018, `schema.sql`, the migration test

- `migrations/0018_guest_voice.sql` (three tables, additive; no ALTER, no rebuild, no foreign key) and the byte-identical
  block at the end of `schema.sql`.
- Beyond the brief's table text, all inside the new tables: a `depth` column on `guest_thread` (the brief caps thread depth
  at `max_comment_depth` but gives no column to enforce it from; a stored, immutable depth keeps the cap a one-number read);
  CHECKs that make the table's own invariants structural (parent kind and id both or neither; `mod_state` is NULL,
  `collapsed` or `removed`; a duty only on a guest-authored row with a due date); and two extra indexes
  (`idx_guest_thread_kind_day` so the global daily cap and the row ceiling are index reads, and `idx_guest_thread_parent` so
  the discharge lookup is not a scan). The due index is `(due_at, id)` so the cursor order is an index order.
- `test/guest-migration-d1.test.ts` (test 1): additive against the pre-0018 schema, three tables exactly, no foreign key,
  documented columns, idempotent over the full schema, the block byte-identical at the end of `schema.sql`, the CHECKs and
  unique indexes bite. The checker is run on deliberately mutated migrations inside the file, so it cannot pass quietly.
