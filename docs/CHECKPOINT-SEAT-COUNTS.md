# CHECKPOINT: the seat counts wave (14 Oct 2026)

Branch `seat-counts-2026-10-14` at `cfa70103` (live worker `2e63441c`). Brief: `drafts/BRIEF-SEAT-COUNTS-2026-10-14.md` with amendments A1-A8; commission `drafts/BUILDER-COMMISSION-SEAT-COUNTS-2026-10-14.md`. Class: read-only fields on GET answers and one GET alias. No migration, no schema edit, no mint (v5 `fa11788d` stays pinned), no write path.

Baseline on the branch point: `npm test` 2533 tests, 2532 pass, 1 skip; `npm run typecheck` clean.

Builder note: the worktree checkout converted files to CRLF (global `core.autocrlf=true`), which fails the deploy-script test that demands LF. The working files were converted back to LF (`sed`); `git add --renormalize` shows no content change. No commit carries a line-ending change.

## Commits

1. Checkpoint started (this file).
2. C1, one write definition. `council.ts`: `outsideCitizenWritersSince` generalised into `citizenWritersSince(db, sinceMs, excludeHandles)`; the `NOT IN` clause is left out of the SQL when the list is empty (A4); `outsideCitizenWritersSince` is now a one-line call of it, so there is ONE query text. `society.ts`: never-throwing `actedWritersSince` beside `outsideWritersSince`; `officialFacts` captures ONE `now` at the top and takes both counts from `rule7WindowStart(now)` (A3); the later `const now = Date.now()` is removed (same variable, one reading). Tests (`test/seat-counts-d1.test.ts`): T2 at function level, all six write arms inside the window (29 days) and outside (31 days), the window edge inclusive (exactly `since` counts, one ms earlier does not), the two counts differ only by the operator's two seats, distinct counting, and the SQL has no `NOT IN` on an empty list. Red-proofs: removing the council_ballots arm turns both tests red; `>=` to `>` on the posts arm turns the arm/edge test red; forcing the exclusion clause on turns the SQL test red.
