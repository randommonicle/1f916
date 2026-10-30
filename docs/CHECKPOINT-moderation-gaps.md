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

## Commit 4: W3 judgment, tests 8 and 9 (clerk regression)

What: `judgment.ts` `shapeTargetContent` returns, for any target with a `mod_state`, the fixed line
`(content already <state>; its text is withheld from this review)` and keeps the `mod_state` (the `<target_content mod_state=...>`
attribute is unchanged). `JUDGMENT_SYSTEM_PROMPT` (the `target_content` paragraph, `judgment.ts:361`) now says a collapsed or
removed target's block holds only that line, to decide from note and source, and to treat the note as the clerk's historical
account, not a fresh observation. The prompt previously promised "ACTUAL CURRENT content" for every target; it still does for visible ones.
E3 (stated, not served): the clerk's note about a flag, which may quote its target, still goes to the judgment as its evidence; test 8 asserts the note markers are PRESENT.
Existing raw-content test (`maintainer-judgment.test.ts`, "shapeTargetContent returns a comment's body plus its mod_state", a
`collapsed` comment expecting "this is spam"): split into a visible-comment version (unchanged expectation) and a new moderated
test with the new expectation. Red on 50007e0f source (judgment.ts reverse-applied): the new moderated expectation fails
(`Expected values to be strictly equal`), the prompt-pin test fails (`did not match /already collapsed or removed, ...`), and
test 8 fails at `no moderated target's stored title or body was sent`.
Test 8 (D1, fetch seam): moderated post, moderated comment, visible post as flag_review targets, each with a distinct clerk-note marker;
asserts note markers present, the visible target's content present (positive control), the canary (only in stored fields) absent, and the placeholder block.
Test 9 PRESERVATION (clerk): green on the unchanged clerk. Mutations (on a copy, restored): (1) drop `AND mod_state IS NULL` from the posts
input query (`clerk.ts:317`): red at `no moderated row's stored text was sent`; (2) delete the moderated branch of `shapeFlagTargetText`
(`clerk.ts:302`): red at `the flag on a moderated post is shown as moderated, no content`. Both fail with either removed, as the brief requires.

## Commit 5: W4 served text, test 10

What: `/privacy` (`privacy.ts:83`) now says: moderation replaces the body and the title of a collapsed or removed post, comment,
listing or submission with a notice and removes its link; bylines, ids, times and the moderation state stay; stored text is not erased;
the author's authenticated history returns the original bodies (the existing pinned sentence "returns its original post and comment
bodies. The reason given ... is public (GET /api/events?kind=moderation)." is kept byte-identical, `served-privacy-consistency-d1.test.ts`
pins it) and also the original titles and links of its own posts; then the exceptions: E1 a standing topic's title stays in the attested
identity log, E2 a proposal's body stays as filed, and (deviation, below) a listing's acceptance condition stays visible. The MCP `moderate`
tool description (`mcp.ts:312`) now reads "the body and title are replaced and the link removed on supported public reads, but stored text
remains and the byline, ids and times stay visible, reason public". `served-privacy-consistency-d1.test.ts` CONTRADICTS 2 re-pinned to the new text.
DEVIATION (small, for Ben): the brief names E1 and E2 in /privacy; I also named E4 (listings' `acceptance_condition` stays visible) because
the served sentence would otherwise over-claim ("title and body replaced" for listings), and D-078 left E4 for Ben. Remove that clause if Ben prefers E4 left unsaid.
Sweep of other served strings (doc.ts, discovery*.ts, mcp*.ts, `/skill.md`, `/heartbeat.md`, llms.txt, inbox notes): the only strings that
described what moderation hides were `privacy.ts:83` and `mcp.ts:312`. `doc.ts:205-210` (inside the hashed template) says only "collapse or remove
spam and scams, with a public reason, logged": still true, NOT edited, no mint. `discovery.ts:154`/`discovery-data.ts:107` (search excludes moderated
posts) true. `inbox.ts:676`/`:1056` (mentions hidden by moderation are not delivered) true. `/skill.md` and `/heartbeat.md` carry no moderation-hiding
sentence, so SKILL_VERSION is not bumped.
Test 10 (NEW): pins the new /privacy sentences (E1, E2, own-history) on PRIVACY_TEMPLATE and on the served route, and asserts the old
"titles, links, bylines and other metadata may remain visible" sentence is absent; 10b pins the MCP tool description. Red with privacy.ts and mcp.ts reverse-applied to the old text.

## W2 completeness list (every SELECT of title/url from posts, listings, submissions, direct or joined, and every served `_title`/`_url` field)
Covered = redacted or excluded when moderated, with a test above.
- `society.ts` readPost `p.title, p.url` (`:1364`): COVERED (W1 applyModState), test 2, HTTP + both MCP doors.
- `society.ts` front ranked posts (`:1287`) and front topics (`:1315`): excluded `mod_state IS NULL`; COVERED by the front regression test.
- `society.ts` changes posts `p.title, p.url` (`:2421`): excluded `mod_state IS NULL`; COVERED, test 4 (+ mutation).
- `society.ts` search (`:2440`, route) and `discovery-data.ts:90`: `mod_state IS NULL`; COVERED, regression test.
- `society.ts` me() `post_title` x2 (`:2175`, `:2186`): COVERED (redactJoinedPostTitle), test 3e.
- `society.ts` history() own posts `p.title, p.url` (`:2219`): OUT OF SCOPE by rule (the author's own history keeps originals); test 6.
- `society.ts` history() comments `post_title` (`:2227`): COVERED, someone else's moderated post redacted, own kept, standing topic not "own"; test 6.
- `topics.ts` topicSelect/serveTopic (`:87`, `:108`): COVERED by W1 (title via applyModState), tests 3a and 3b (topics_opened); `topics.ts:141` quietest: excludes moderated.
- `inbox.ts` commentsSql `post_title` (`:246`): COVERED, test 3b (replies, comments_on_your_posts, mentions).
- `inbox.ts` postsSql (`:298`, topics_opened and post mentions): topics via serveTopic COVERED; post mentions require `mod_state == null`; COVERED, test 3b.
- `inbox.ts` guest-inbox comment mentions `post_title` (`:1002`): COVERED, test 3d. Guest-inbox post mentions (`:1006`): require `mod_state == null`.
- `inbox.ts:336` guestThreadSql joins posts for `post_citizen_id`/`post_kind` only: no title served.
- `guest.ts` guest_due `topic_title` (`:559`, `:574`): COVERED, test 3c (both views, HTTP and both MCP doors).
- `guest.ts:243`, `:103`, `:188`, `:502`: posts read for gating, no title served.
- `listings.ts` list (`:1222`) and single (`:1296`) `l.title, l.url, l.description`: COVERED (applyListingModState is applyModState), test 5.
- `listings.ts` submissions (`:1306`) `s.url, s.body`: COVERED (applyModState), test 5.
- `listings.ts:658` `loadPayableListing` selects `title`: its use at `:818` (the x402 description) is only reached after the 409 refusal of a moderated listing: OUT OF SCOPE, unreachable for a moderated row. `:483`/`:535` are the funder's own creation response.
- `listings.ts:319-341`, `:1437` (funder record, payments page): no title/url served; funder record counts only `mod_state IS NULL`.
- `governance.ts:1249`, `:1301` and `inbox.ts:590`, `:654` proposals `title`/`body`: OUT OF SCOPE (E2, a proposal is a governance record and stays as filed; it is the proposals table, not posts).
- `council.ts` posts reads are counts only. `maintainer/*` posts reads are model inputs, covered in W3.
- Served `_title`/`_url` fields: `post_title` (inbox, guest inbox, me, history: covered above), `topic_title` (guest_due: covered). No other served `_url` row field exists (`payment_url`-style fields are config, not row content).
- Known gap, not a title/url: listings' `acceptance_condition` stays visible (E4), flagged for Ben.
