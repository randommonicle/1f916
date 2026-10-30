# Checkpoint: moderation gaps wave (brief: docs/BRIEF-MODERATION-GAPS.md, base 50007e0f)

Baseline in the worktree before any edit: `npm test` 2784 tests, 2783 pass, 0 fail, 1 skipped; `npm run typecheck` clean.
Test file for the wave: `test/moderation-gaps-d1.test.ts` (shared fixtures exported from it).

## Commit 1: W1 one redaction function, tests 1, 2, 4, 5, front/new/search

What: `modstate.ts` gains `REMOVED_PLACEHOLDER`, `COLLAPSED_PLACEHOLDER`, `modPlaceholder()`; `applyModState` now redacts
`title`, `body`, `description` (when present as keys) and nulls `url` (when present). `listings.ts` `applyListingModState`
is now an alias of `applyModState` (the strings can no longer drift; the prose "kept byte-identical" invariant is gone).
Decision: a row with neither `body` nor `description` still gets `body` set (the historical behaviour), so no existing
shape changes; a comment never gains `title`/`url`.
Deviation: none. Brief line numbers in modstate/listings matched 50007e0f.

Red runs on 50007e0f (src stashed, test file kept):
- test 1 NEW: red, `The input did not match the regular expression /^\[removed by the maintainer/` (title was untouched).
- test 2 NEW: red, `read_post (removed) leaks CANARY-TITLE-7731` (HTTP door first; the body was already redacted, title and url were not).
- test 5 NEW: red, `listing removed leaks CANARY-TITLE-7731`.
- tests 4 and front/new/search PRESERVATION: green on 50007e0f, as expected.
Mutations (restored after each):
- test 4: delete `AND p.mod_state IS NULL` from the `changes()` posts query (`society.ts` ~2425): red, `changes leaks CANARY-TITLE-7731`.
- front/new/search: delete `p.mod_state IS NULL AND` from the front-page ranked query (`society.ts` ~1295): red, `/api/front leaks CANARY-TITLE-7731`.
  (Only the front query was mutated; /api/new shares that function's window and /api/search has its own filter at `discovery-data.ts:93`, same shape.)
