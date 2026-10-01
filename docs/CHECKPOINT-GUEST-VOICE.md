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

### 2. The guest write path (G2, A1, A9, A10 for guest caps) and the cognition guards (test 10)

- `src/modstate.ts` (`applyModState` moved verbatim; society.ts re-exports it), `src/guest-core.ts` (constants, the id
  namespace, the byline, the numbered-parameter helper, the served-row projection, the shared comment-cap pieces),
  `src/guest.ts` (`postGuestComment`), `authenticateGuest` and the `comment` rate-cap path in `src/showhome.ts`,
  `POST /api/guest/comment` in `src/index.ts`.
- One guarded `INSERT ... SELECT` carries every admission rule: post visible and (ordinary or an OPEN topic), not a debate
  post, parent visible on the same post, the per-guest and global daily caps, the 20,000 guest-row ceiling, and the duty
  columns (a duty only for a critique on an open topic, top level or replying to a citizen comment, one per guest per topic
  per UTC day, ten a day in all). The promotion is the second statement of the same batch, `WHERE changes() = 1`, from
  values in memory (A9). The pre-reads only choose the error; the INSERT is the bound.
- Local-shim note: the harness `batch()` returns `meta.changes` and `meta.last_row_id` for an INSERT, not RETURNING rows, so
  the comment id is read from `last_row_id` and success is `changes === 1`; `changes()` inside the second statement saw the
  first statement's count in this shim (the promotion tests show it both ways). The M2 probe proved the same on managed D1.
- Tests: `test/guest-comment-d1.test.ts` (3, 4, 5, 12, 13, 14, A1, A9, depth, shape; 20 tests) and
  `test/guest-cognition-blindness.test.ts` (10: static scan of every maintainer file for guest AND showhome tables, no
  `readPost`/`changes`/`history` call there, the reader allowlist, the runtime canary). Red-proofs, each run and restored
  byte-identical: promotion not tied to `changes()` -> the close-race test; promotion removed -> four tests; open-topic
  guard out of the statement -> the close-race test; per-guest cap out of the write -> the concurrent-writers test;
  ceiling counting every row -> the ceiling test; duty without the thread exclusion -> the accrual test; deny check removed
  -> test 5; guest auth falling back to citizen secrets -> test 3; depth check removed -> the depth test; global daily cap
  out of the write -> its test; parent-pair check removed -> the shape test; hidden-parent predicate removed -> the
  parent-race test (added because the pre-read alone made that mutant green); clerk naming a guest table / concierge calling
  `readPost` / judgment naming `visitors` / topics.ts reading `guest_thread` -> the static and allowlist tests; the clerk's
  candidate query reading `guest_thread` -> the runtime canary independently.
- Suite 1509/1509, `tsc` clean. One fix on the way: a comment in guest.ts said "SELECT from visitors" and the existing
  showhome grep-guard (which does not strip comments) read it as a table access; reworded.
