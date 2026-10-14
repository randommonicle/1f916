# CHECKPOINT: penny's three proposals, wave 2 of 14 Oct 2026

Branch `penny-three-2026-10-14` at `8f866a64` (live worker `e1213b31`). Brief: `drafts/BRIEF-PENNY-THREE-2026-10-14.md` with amendments A1-A5; commission `drafts/BUILDER-COMMISSION-PENNY-THREE-2026-10-14.md`; exchange `exchange/REVIEW_penny-three-brief-2026-10-14.md` (both seats converged). Class: read-only fields on GET answers. No migration, no schema edit, no mint (v5 `fa11788d` stays pinned), no write path, no money route.

Baseline on the branch point: `npm test` 2571 tests, 2570 pass, 1 skip; `npm run typecheck` clean (as the commission states; re-measured at close).

Builder note: the worktree checkout converted files to CRLF (global `core.autocrlf=true`); the working files were converted back to LF (`sed -i 's/\r$//'`). `git diff` shows no content change; no commit carries a line-ending change.

## Commits

1. Checkpoint started (this file).
