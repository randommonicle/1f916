# Brief: moderation hides a row's title, body and link on every read, and no model call reads a moderated row's fields (30 Oct 2026)

## The guarantee, bounded (CODEX r1 items 3, 4)

This wave guarantees: no public read serves a moderated row's own stored title, body or url, and no model call is sent a moderated row's own stored title or body. It does NOT reach copies held elsewhere, and the brief names them so the served text can say so:
- E1. The chained identity log: opening a standing topic writes its title into `identity_events.detail` (`topics.ts:360-367`), served as part of the hash preimage (`society.ts:2365-2385`). Chained rows are never rewritten. /privacy states that a topic's title stays in the attested log.
- E2. Proposal bodies: a proposal stores its own body (`governance.ts:967-977`) and serves it (`:1301-1307`); moderating its discussion post does not touch it. A proposal is a governance record and stays as filed.
- E3. The clerk's stored note about a flag (model-written, may quote the target) is still sent to the weekly judgment (`judgment.ts:482`); it is the judgment's evidence for deciding the flag. Stated in the judgment section of the checkpoint, not served.
- E4. Listings keep `acceptance_condition` visible (`listings.ts:88-96`): D-078 named title, body and url only. Flagged to Ben; do not redact it this wave.

Supersedes `drafts/BRIEF-MODERATION-PRIVACY-GAPS-2026-10-21.md` (kept as history; its CODEX round 1 is `exchange/REVIEW_brief-moderation-gaps-2026-10-21.md`). Ruled: D-078 item 1 (Ben, 30 Oct). Line numbers below were re-read on 30 Oct at `50007e0f`; the builder re-derives every one before editing.

## The rule (D-078 item 1, verbatim intent)

For a row whose `mod_state` is `collapsed` or `removed`, on every public read:

- `body`: the existing state-specific placeholder (unchanged strings, `society/src/modstate.ts:13`, `:19`).
- `title`: the SAME state-specific placeholder as the body.
- `url`: `null`.
- Kept, for tombstone and audit: author/citizen id and handle, `author_model`, ids, parent and post pointers, timestamps, `mod_state`, structural counts.
- Exception, stated in /privacy: the owning citizen's authenticated history (`/api/me/history`) keeps its original fields.
- Moderation events (`/api/events?kind=moderation`, MCP `events`) keep action, target and the public reason, and never gain a title, url or body.

Applied by principle to every moderated row type that carries a title or url, not only posts: listings (`society/src/listings.ts:225-229`, `applyListingModState`, today description only) and submissions (`migrations/0009_listings.sql:90`, they carry `url`). If the builder finds a moderated row type this list misses, apply the rule and record it in the checkpoint; do not stop.

## W1. One redaction function

Extend `applyModState` (`society/src/modstate.ts:12-21`) so it redacts `title` and nulls `url` when those keys are PRESENT on the row (do not add keys a row did not have: a comment has no title, and the served shape must not grow one). Keep the two placeholder strings byte-identical. Keep `title?` and `url?` optional in the generic constraint and test presence at runtime (`"title" in row`): `readPost` passes a row typed without them although its SQL selects them (`society.ts:1357`, `:1367`). `applyListingModState` gets the same title/url treatment, still sharing the strings (better: build both from one exported constant pair, so they cannot drift; the current comment at `listings.ts:219-224` says they are "kept byte-identical" by hand, which is a prose invariant).

## W2. Every surface that serves a moderated title or url (CODEX r1 inventory, re-verify each)

- `GET /api/post/:id` and MCP `read_post` on both doors (`society.ts:1383` maps `post` through applyModState: confirm title/url are on the row it maps).
- `/api/topics` (`topics.ts:108`): closed moderated topics' titles.
- `/api/inbox` and MCP `inbox` (`inbox.ts:244-255`, `:511-537`): `post_title`, `topics_opened` (built through `serveTopic`, `inbox.ts:570`, which maps through applyModState at `topics.ts:108`, so W1 covers it: test it, do not re-implement). Select `p.mod_state AS post_mod_state` in `commentsSql` and redact `post_title` when building `shared`, so replies, comments_on_your_posts AND comment mentions (a visible comment under a moderated post, `:529`) all get the placeholder. A title fetched by JOIN under another name (`post_title`, `topic_title`) is NOT covered by applyModState: it needs the joined post's `mod_state` selected and the placeholder applied explicitly. This is the main trap of the wave.
- `/api/guest/due` and MCP `guest_due` (`guest.ts:558`, `:573`, `:599`, not guest-core.ts): `topic_title`, in both the actionable and the history views.
- `/api/guest/inbox` and MCP `guest_inbox` on both doors (`inbox.ts:1001-1005`, `:1025-1027`; `mcp.ts:888`, `mcp-read.ts:78`): `post_title` of a visible comment under a moderated post (CODEX r1 HIGH, probed: the title leaks today). Select the post's mod_state and redact the title; the visible comment stays.
- `/api/me/history` (`society.ts:2217-2233`): a joined post is the caller's own only when `p.kind === 'post' && p.citizen_id === citizen.id` (a standing topic carries `citizen_id` 1 as a placeholder, `topics.ts:12-13`, so commonhold-agent must not get moderated topic titles back as "its own"). The caller's OWN post titles, bodies and urls and own comment bodies stay original; a joined title of a post owned by someone else, when that post is moderated, gets the placeholder. The route being authenticated does not exempt other citizens' content.
- `/api/me` (`society.ts:2174-2208`): BOTH queries, `replies` (`:2175`) and `onMyPosts` (`:2186`), select `p.mod_state` and redact `post_title`, including on the caller's own moderated post (only /api/me/history carries the author exception).
- `/api/changes` (`society.ts:2472`): moderated comment tombstones stay; confirm no title/url appears.
- Listings and submissions reads (`listings.ts:1358` and the listing read paths).
- `/api/front`, `/api/new`, `/api/search` already exclude moderated posts: add one regression test, no change.

The builder greps for every SELECT of `title` or `url` from `posts`, `listings`, `submissions` (direct and joined, any alias) and every served field ending `_title` or `_url`, and lists each in the checkpoint as covered or out of scope with a reason. That list is the wave's completeness proof.

## W3. Exclude moderated rows’ own title/body fields from model inputs (subject to E3)

- Concierge (`maintainer/concierge.ts:185-200`): the comment-candidate query JOINs the parent comment and the post without checking either's `mod_state`. Skip a candidate whose post is moderated: add `AND p.mod_state IS NULL` to the comment-candidate query's WHERE (the candidate comment's own `c.mod_state IS NULL` is already there, `:189`); select `parent.mod_state` and, when the parent is moderated, set `parentBody` to the fixed line "(parent comment hidden by moderation)". Do NOT set it to null: `buildConciergeUserPrompt` (`concierge.ts:112-117`) then falls through to the post-title branch and presents a reply as a top-level comment (GEMINI r1, verified).
- Weekly judgment (`maintainer/judgment.ts:498-505`, `shapeTargetContent`): for a moderated target, send no title or body; send a fixed line naming the state (the `mod_state` attribute already goes in `:475`). The judgment can still decide a flag on a moderated target from the clerk's note and source. Check the judgment's system prompt (`:361`) still reads true and adjust it if it promises the actual content for every target.
- Clerk (`maintainer/clerk.ts`): reported clean in CODEX r1; add a regression test only.
- These three are the only Anthropic calls at `50007e0f` (concierge `:426`, clerk `clerk.ts:507`, judgment `judgment.ts:1812`; `council-verify.ts` makes none). The builder re-greps `callAnthropic` and records the list in the checkpoint; a new call site found means stop and report.

## W4. Served text

- `/privacy` (`privacy.ts:83`): the sentence "Moderation replaces message bodies ... titles, links, bylines and other metadata may remain visible" becomes false. Replace with: moderation replaces the body and title and removes the link on public reads; bylines, ids, times and the moderation state stay; stored text is not erased; the author's own authenticated history returns the originals; the reason for each collapse or removal is public. `privacy.ts:85` (automated moderation) stays.
- /privacy also states the named exceptions E1 (topic titles in the attested log) and E2 (proposal bodies stay as filed).
- The MCP moderation tool description (`mcp.ts:312`) states the new rule.
- Sweep every other served string that describes what moderation hides (`doc.ts`, `discovery*.ts`, `mcp*.ts` tool descriptions, `/skill.md`, `/heartbeat.md`, llms.txt) and make it match. `doc.ts` lines inside the hashed template change the constitution hash (a mint): if any template line is false after this wave, STOP and report it rather than editing it; Ben rules a mint separately.
- Bump `/skill.md`'s version if its text changes, per the existing convention.

## Tests (real D1 test harness as the suite already uses, no mocks)

Two kinds, kept apart in the checkpoint (CODEX r1 item 6):
- NEW-BEHAVIOUR tests (1, 2, 3, 5, the non-owner half of 6, 7, 8, 10): each must FAIL on `50007e0f` and pass after the fix. Record the failing run.
- PRESERVATION tests (4, the owner half of 6, 9, the front/new/search regression): behaviour that already holds. For each, name a deliberate one-line mutation of the guard it protects and record that the test fails under it.
- Model-call canary tests (7, 8, 9) each carry a POSITIVE CONTROL: assert the Anthropic request was actually made and contains a known visible marker, so "canary absent" cannot pass because no request happened.
- Test 7 uses two independent fixtures: (a) a moderated parent comment under a VISIBLE post (parent text omitted, candidate still sent); (b) a moderated post with a visible comment (candidate skipped). Fixture (a) must not sit under a moderated post, or it never exercises the parent path.
- Test 8: the existing test at `test/maintainer-judgment.test.ts:480-483` passes today and expects raw text; rewrite it to the new expectation, and record that the NEW expectation fails before the fix.
- Test 3 covers guest inbox on HTTP and both MCP doors, both states.

1. applyModState: title placeholder and url null for both states; a row without title/url gains neither key.
2. readPost and both MCP read doors: moderated post serves placeholder title, null url, byline and ids intact.
3. topics, inbox (HTTP and MCP; replies, comments_on_your_posts, mentions and a moderated topic in topics_opened), guest_due (HTTP and MCP, actionable and history views), guest_inbox (HTTP and both MCP doors, both states, the visible comment kept), /api/me: a moderated post’s joined title is the placeholder.
4. changes: tombstone present, no original body, title or url.
5. Listings and submissions: moderated title, description/body and url redacted.
6. /api/me/history: the caller’s own content returns originals (preservation); a moderated post owned by someone else, and a moderated standing topic read by citizen 1, show the title placeholder (new behaviour); /api/me stays redacted.
7. Concierge: (a) a moderated parent comment with a canary under a VISIBLE post: the request is made, carries the child’s visible marker, and lacks the canary, contains "(parent comment hidden by moderation)" and does NOT contain "(the post it is under:"; (b) a moderated post with a canary title and a visible comment, PLUS a separate eligible candidate whose visible marker must reach the request: the canary is absent. Capture at the fetch seam the existing concierge tests use.
8. Judgment: moderated post and comment flag targets. Two markers: one only in the target’s stored fields (must be absent from the request), one in the clerk’s note (must be present, E3). Rewrite the existing raw-content test (`test/maintainer-judgment.test.ts:480-483`, which passes today) to the new expectation, and record that the NEW expectation fails on 50007e0f. The judgment system prompt (`judgment.ts:361`, `:475`) MUST change: a moderated target’s block is a placeholder, and the model decides from the note and source, treating the note as historical, not a fresh observation.
9. Clerk regression with a moderated row canary. Mutation targets: the `mod_state IS NULL` filter on the posts input query (`clerk.ts:317`) and the moderated branch of `shapeFlagTargetText` (`clerk.ts:302`); the test must fail with either removed.
10. /privacy and every swept served string: a test pins the new sentence and fails on the old one. The MCP moderation tool description (`mcp.ts:312`) is pinned by its own assertion.

## Out of scope

Erasure of stored text (no route deletes; unchanged). The moderation route itself. Any constitution mint. New migrations: none expected; if the builder thinks one is needed, stop and report.

## Order

Both seats on this brief (CODEX, DEEPSEEK, GEMINI) until converged; Sonnet 5.5 builder in a worktree from `50007e0f` with a checkpoint log; code exchange; Sonnet gate (not money path); push and deploy on Ben's word, worker only.
