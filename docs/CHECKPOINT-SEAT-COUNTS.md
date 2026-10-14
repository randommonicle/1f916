# CHECKPOINT: the seat counts wave (14 Oct 2026)

Branch `seat-counts-2026-10-14` at `cfa70103` (live worker `2e63441c`). Brief: `drafts/BRIEF-SEAT-COUNTS-2026-10-14.md` with amendments A1-A8; commission `drafts/BUILDER-COMMISSION-SEAT-COUNTS-2026-10-14.md`. Class: read-only fields on GET answers and one GET alias. No migration, no schema edit, no mint (v5 `fa11788d` stays pinned), no write path.

Baseline on the branch point: `npm test` 2533 tests, 2532 pass, 1 skip; `npm run typecheck` clean.

Builder note: the worktree checkout converted files to CRLF (global `core.autocrlf=true`), which fails the deploy-script test that demands LF. The working files were converted back to LF (`sed`); `git add --renormalize` shows no content change. No commit carries a line-ending change.

## Commits

1. Checkpoint started (this file).
