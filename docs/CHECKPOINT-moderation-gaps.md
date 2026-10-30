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

## Commit 2: W2 joined titles (inbox, guest_inbox, guest_due, /api/me, /api/me/history), tests 3a-3e and 6

What: `modPlaceholder` applied explicitly to titles fetched by JOIN, because a `post_title`/`topic_title` is not a `title` key
and applyModState cannot see it.
- `inbox.ts`: `commentsSql` selects `p.mod_state AS post_mod_state`; `post_title` is redacted when building `shared`, so
  replies, comments_on_your_posts and comment mentions all get it. The guest-inbox comment-mention query does the same.
- `guest.ts` `guestDue`: both views select `p.mod_state AS topic_mod_state`; `topic_title` redacted.
- `society.ts` `me()`: both queries select `post_mod_state`; `redactJoinedPostTitle` redacts and strips the helper column
  (served shape unchanged). The caller's own moderated post is redacted here too (only /me/history has the author exception).
- `society.ts` `history()`: comment rows select `post_mod_state, post_citizen_id, post_kind` (stripped before serving); the
  title stays original only when `post_kind === 'post' && post_citizen_id === citizen.id`, else the placeholder. Own posts
  (their own SELECT), own comment bodies unchanged.
- topics (`serveTopic`, `topics.ts:108`) and `topics_opened` (`inbox.ts` via serveTopic) are covered by W1 alone; tested, not re-implemented.
Deviation: none. Line numbers matched 50007e0f within a few lines.

Red runs on 50007e0f (src stashed, tests kept), NEW tests:
- 3b inbox: red, `inbox leaks CANARY-TITLE-7731` (a reply's `post_title`).
- 3c guest_due: red, `guest_due actionable leaks CANARY-TITLE-7731`.
- 3d guest_inbox: red, `guest_inbox leaks CANARY-TITLE-7731` (probed HIGH from CODEX r1 confirmed).
- 3e /api/me: red, `/api/me leaks CANARY-TITLE-7731`.
- 6 non-owner half: red, `The input did not match the regular expression /^\[collapsed /` (someone else's moderated post title).
- 3a topics: needs only W1, so it passed in the stash run above (W1 was already committed). Correction: I then reverse-applied
  `git diff 50007e0f HEAD -- src` (true 50007e0f source) and ran both test files: tests 1, 2, 3a, 3b, 3c, 3d, 3e, 5 and 6 all RED;
  tests 4 and front/new/search green (PRESERVATION), as required. Patch re-applied afterwards; `git diff 50007e0f --stat -- src` shows the 5 expected files.
Preservation mutation, test 6 owner half: replace the ownership condition with `false` (always redact): red, `own post title kept on own comment`.
Process note (a mistake, surfaced): I restored from that mutation with `git checkout -- src/society.ts`, which also threw away
my uncommitted commit-2 edits to that file. I re-applied them from the same scripts and re-ran everything; no committed state was affected. Mutations are now done on a copy.
Full suite after commit 2: 2795 tests, 2794 pass, 0 fail, 1 skipped; typecheck clean.

## Commit 3: W3 concierge, tests 7a and 7b

What: `concierge.ts` comment-candidate query gains `AND p.mod_state IS NULL` (a moderated post's comments are skipped) and selects
`parent.mod_state AS parent_mod_state`; a moderated parent's text becomes the exported fixed line
`MODERATED_PARENT_LINE` = "(parent comment hidden by moderation)" (NOT null: null falls through to the post-title branch of
`buildConciergeUserPrompt` and presents a reply as top-level). The posts candidate query already filtered `p.mod_state IS NULL`.
Tests (`test/moderation-gaps-models-d1.test.ts`, capture at the `globalThis.fetch` Anthropic seam, real D1): 7a = moderated parent
under a VISIBLE post (separate from 7b's fixture), 7b = moderated post with a visible comment as the OLDEST candidate plus a separate
eligible post. Each asserts a positive control (request made, known visible marker present) before the canary-absent assertion.
Red on true 50007e0f source (concierge.ts reverse-applied): 7a red at `the moderated parent's text is absent`; 7b red at
`the eligible candidate reached the request (positive control)` (the first and only request carried the moderated post's canary title
instead, so the eligible marker never arrived: the test cannot pass vacuously). Green after the fix.

### `callAnthropic` call sites, re-grepped at this commit (`grep -rn callAnthropic src`)
`maintainer/anthropic.ts:160` (definition); callers: `clerk.ts:507`, `concierge.ts:426`, `judgment.ts:1812`. Three, as the brief says; no new call site. `council-verify.ts` makes none.
