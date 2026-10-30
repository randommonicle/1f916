# Gate review: moderation gaps wave (D-018 Sonnet gate), 30 Oct 2026

Scope: `50007e0f..b79fed85` (6 commits), branch `moderation-gaps-2026-10-30`. Reviewer: Sonnet 5.5 gate.

## Verdict: DEPLOYABLE WITH CONDITIONS

HIGH 0 / MEDIUM 1 / LOW 2.

## What I ran

- `npm test`: 2803 tests, 2802 pass, 0 fail, 1 skipped. `npm run typecheck`: clean.
- Three mutations, each applied by `sed` then restored with `git checkout -- <file>`; `git status -sb` afterwards shows a clean tree:
  - `src/inbox.ts:520` joined-title redaction removed: tests 3b and 3d in `test/moderation-gaps-joined-d1.test.ts` go red.
  - `src/modstate.ts` `"title"` dropped from the redacted keys: tests 1, 2, 5 in `test/moderation-gaps-d1.test.ts` go red.
  - `src/maintainer/judgment.ts` moderated branch of `shapeTargetContent` disabled: the unit test and test 8 (`test/moderation-gaps-models-d1.test.ts`) go red.
- My own grep of every SELECT of title/url from posts, listings, submissions (direct and joined) and every `_title`/`_url` served field across `src/` (not the checkpoint's list), and every `callAnthropic` caller (anthropic.ts, clerk.ts, concierge.ts, judgment.ts).

## Findings

### M1 (MEDIUM). A moderated listing's title stays public in the treasury ledger, and the served text does not name it
`src/listings.ts:483` writes `listing posting fee, funder <h> (<payer>): "<title>"; tx ...` into `ledger.description`; `src/society.ts:2597` serves it on `GET /treasury` and `/api/treasury` (index.ts:238). The ledger is hash-chained and never rewritten, so moderating the listing leaves its title readable. This is the same class as E1 but is not among E1-E4, and the new `src/privacy.ts:83` sentence says moderation replaces "the title of a collapsed or removed ... listing" and lists only "three things" it does not reach (topic title in identity log, proposal body, acceptance condition). The sentence is therefore overclaimed for listings.
Failure scenario: a listing title is removed for abuse; anyone reads it from `/api/treasury`.
Fix (condition C1): add the treasury posting-fee line as a fourth named exception in `privacy.ts` (e.g. "a listing's title also stays in the chained treasury line for its posting fee"), and pin it in test 10. Code change is not warranted (chained rows are never rewritten).

### L1 (LOW). Proposal titles
Privacy names "a proposal's body" stays as filed; a proposal's title is also served (`governance.ts:1249,1301`, inbox ballots `inbox.ts:593,657`). Say "a proposal's title and body". Not new behaviour.

### L2 (LOW). `src/listings.ts:818` and `:483` embed the listing title in strings served to the funder and treasury
The pay description at `:818` is only reachable for unmoderated listings (guard at `:662`, 409 when moderated), so no leak. Noted for completeness; no action.

## Checks

1. Counts above.
2. Public reads: `readPost`/read_post (`society.ts:1383`), topics (`topics.ts:108` via `serveTopic`), inbox comments (`inbox.ts:520`), guest_inbox (`inbox.ts:1031`), guest_due (`guest.ts:600`), `/api/me` (`society.ts:2161-2215`), listings and submissions (`listings.ts:1236,1343,1350`) all redact. `/api/front`, `/api/new`, `/api/search` (`discovery-data.ts:90-94`), `/api/changes` posts (`society.ts:2436-2441`) and topic stubs filter `mod_state IS NULL` at query level. Inbox/guest post mentions require `mod_state == null`. Moderation event detail carries only the reason (`society.ts:1678`). No other leak found apart from M1.
3. Visible rows: `applyModState` returns the row untouched when unmoderated (`modstate.ts`), `redactJoinedPostTitle` and `history()` strip only the helper columns they added, so key set and order for visible rows are unchanged. The new `post_mod_state`/`topic_mod_state` selects are not served.
4. Model calls: concierge post query already filters `p.mod_state IS NULL`; comment query now filters moderated posts and replaces a moderated parent with a fixed line (`concierge.ts:187-223`, null would have misrendered as top-level, correctly avoided). Judgment `shapeTargetContent` withholds moderated targets (`judgment.ts:500-508`). Clerk already filtered `mod_state IS NULL` and `shapeFlagTargetText` withholds moderated targets (`clerk.ts:300-303`). E3 (clerk note to judgment) is the stated residual.
5. Tests: see mutations above.
6. Served text: mcp.ts:312 and the other new privacy clauses are true against the code (url nulled on posts, listings, submissions; history returns originals of own posts: `society.ts:2225-2233`). The judgment system prompt change is accurate. `doc.ts` hashed template says nothing about what moderation hides (lines 205-210, 251, 281), so no mint is needed. Exception: M1/L1 above.
7. Security: all new SQL is static (selects of `p.mod_state`, no concatenation of user input). `/api/me/history` remains scoped by `citizen.id`; the original-title exception requires `post_kind === 'post' && post_citizen_id === citizen.id`, so one citizen cannot obtain another's original post title, and the maintainer does not get moderated standing-topic titles back. No authorisation change in `/api/me`.

## Conditions

- C1: resolve M1 in served text before deploy (fold L1 in at the same time), plus a one-line test pin. No code or migration change.

## Conditions, met (30 Oct, architect)

- C1 (M1): /privacy now names the treasury posting-fee line as a fourth exception; test 10 pins it.
- L1: /privacy now says a proposal's title and body stay as filed; test 10 pins it.
- L2: no action (unreachable for moderated listings, :662 409 guard).
- secret-literal guard re-pinned for the changed template. Full suite 2803 / 2802 pass / 0 fail / 1 skipped; typecheck clean.
