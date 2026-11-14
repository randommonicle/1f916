# CHECKPOINT: resident follow-up wave + MCP argument descriptions (14 Nov 2026)

Branch `followup-wave-2026-11-14`, cut from `ed0ce5ae` (live). Nothing pushed, deployed or run through wrangler. Brief: `drafts/BRIEF-FOLLOWUP-WAVE-2026-11-14.md`.

## Baseline

`npm test` at `ed0ce5ae`: 3194 tests, 3193 pass, 0 fail, 1 skipped. `npm run typecheck`: clean.

## Commits

| Item | Commit |
|---|---|
| W1 + W2 | `5c094eb4` |
| W3 | `832d03bf` |
| W4 | `89139ed8` (head, plus this report if committed after) |

Final: 3200 tests, 3199 pass, 0 fail, 1 skipped; typecheck clean. The constitution template hash pin test passes (it is in the suite; `FRONT_DOOR_TEMPLATE` was not touched, and a test asserts the new sentence is not in it).

## W1: a residency is not a uniqueness claim

The sentence is added verbatim to: `RESIDENTS_NOTE` (`src/guest-core.ts:549`, served in `/api/official` `residents.note`, `/api/residents` note, `/api/resident/<n>` note); the showhome room `resident_tier.warning` (`src/showhome.ts:~800`); the `/api/residents` route description (`src/discovery.ts:323`, so also `/openapi.json` and the route list); the llms.txt resident paragraph (`src/discovery.ts:~613`); the resident block of the front-door text served at `/` (`src/doc.ts:~736`, the operational section OUTSIDE `FRONT_DOOR_TEMPLATE`, which starts at `src/doc.ts:151`).

NOT done, needs the architect: **`/skill.md`** (`src/inbox.ts:849`, "Stay as a resident"). The skill text is pinned by sha-256 and version (tests: "the ride's pins", "20: /skill.md (1.4.4) ... pinned by sha-256", "10: /api/surface heartbeat/skill sha256", and `docs/HEARTBEAT-SKILL-TEXT.md` equality). An edit needs a skill version bump, re-pins, the doc file regenerated, and a ClawHub publish. I tried it, saw those four red, and reverted `src/inbox.ts`. The sentence for that surface is ready: the same sentence appended after "and nothing here verifies who you are."

No sentence needed to go inside the hashed template. MCP tool descriptions (`mcp.ts`) present no resident count, so none changed.

Test: `test/followup-wave-w1-w2-d1.test.ts` (served on each surface; template unchanged). Red-proofed by removing the sentence from `guest-core.ts` (fails) and by removing `counts_toward` (fails).

## W2: `counts_toward: []`

`serveResident` (`src/resident.ts`) now returns `counts_toward: []` on every roster row and profile. The one-line definition (`COUNTS_TOWARD_NOTE`, exported from `resident.ts`) is in the roster note and the profile note; `/api/residents` route description names the field. There is no MCP tool or OpenAPI response schema for `/api/residents` (grep: none), so nothing else to add. The bind and claim response bodies (`resident.ts:252,321`, `resident-account.ts:269,315`) are action confirmations to the resident, not roster rows; left unchanged (say if you want the field there too).

Test pins an empty array on a key resident and an account resident, in roster and profile.

## W3: "Nothing was written"

Wording the cap actually has: `assertShowhomeRateCap` (`src/showhome.ts:176-216`) inserts one `showhome_rate` row before any credential or state is read, counted per address (skipped when the request has none) and globally, per hour. It only throws before inserting when a cap is already full. So every refusal after it has already written a row. The bind and recovery routes use `assertShowhomeAddressCap` (`showhome.ts:~247`) instead, which writes its row on every attempt EXCEPT when that path's attempt log is at its ceiling; their wording says so (`BIND_ATTEMPT_COUNTED`).

New constants (`src/showhome.ts`): `ATTEMPT_COUNTED` ("this attempt was counted against the hourly rate limits, per address and across all addresses") and `BIND_ATTEMPT_COUNTED`. Codes and statuses unchanged.

Line numbers below are at `ed0ce5ae` (before the W3 commit; the line count did not change, only content).

| file:line | Earlier write in the same request | Verdict | New wording |
|---|---|---|---|
| council.ts:365 | council_challenge/council_claim rate row (council.ts:405, :455) | false | No seat was granted; ATTEMPT |
| council.ts:374 | same | false | same |
| council.ts:393 | same | false | same |
| council.ts:400 | same (assertNoSeat, both routes) | false | same |
| council.ts:429 | rate row (:405) | false | No new challenge was issued; ATTEMPT |
| council.ts:434 (lowercase, extra) | rate row | false | no new challenge was issued, and ATTEMPT |
| council.ts:472 | council_claim rate row (:455) | false | No seat was granted; ATTEMPT |
| council.ts:486 | same | false | same |
| council.ts:493 | same | false | same |
| council.ts:518 | same | false | No seat was granted and your challenge was not used; ATTEMPT |
| council.ts:521 | same | false | No seat was granted; ATTEMPT |
| council.ts:526 (lowercase, extra) | same | false | so no seat was granted; ATTEMPT |
| council.ts:640 | "council" rate row (:618) | false | No message was written; ATTEMPT |
| council.ts:859 | "council" rate row (:825) | false | No motion was opened; ATTEMPT |
| council.ts:914, 918, 922, 944, 957 | "council" rate row (:884) | false | No ballot was recorded; ATTEMPT |
| council.ts:1009, 1014, 1017 | "council" rate row (:979) | false | No flag was set; ATTEMPT |
| council.ts:1042 (lowercase, extra) | same | false | no second flag was set, and ATTEMPT |
| guest.ts:108, 109, 110, 115 | "comment" rate row (guest.ts:138); reached via explainRefusal after the failed INSERT | false | No comment was written; ATTEMPT |
| guest.ts:193, 194, 195, 201 | same (pre-reads in postGuestComment) | false | same |
| guest.ts:131 (lowercase, extra) | same | false | no comment was written, and ATTEMPT |
| guest.ts:455 | code comment, not served | n/a | unchanged |
| resident-account.ts:79, 250 | resident_account_challenge/claim rate row (:103, :143) | false | No outside account was bound; ATTEMPT |
| resident-account.ts:173, 188, 195 | claim rate row (:143) | false | No resident was bound and no token was changed; ATTEMPT |
| resident-account.ts:204, 209, 247 | claim rate row | false | No resident was bound and your challenge was not used; ATTEMPT |
| resident-account.ts:217 | claim rate row | false | No token was changed; ATTEMPT |
| resident-account.ts:257 | claim rate row | false | No resident was bound; ATTEMPT. The challenge was used or expired ... |
| resident.ts:185 (assertGuestHasCommented) | bind: address-cap row (:~196); account routes: rate row | false | No resident was bound; <counted> (the caller passes `BIND_ATTEMPT_COUNTED` or `ATTEMPT_COUNTED`) |
| resident.ts:199 | address-cap row in bindResident | false | No key was bound; BIND_ATTEMPT_COUNTED |
| resident.ts:240 | address-cap row, global slot row AND the nonce insert in the batch ("Your assertion is spent" in the same sentence) | false | Your assertion is spent. No key was bound. |
| rule7-vote.ts:119, 121, 123, 125, 127 | none: `openTopic` takes only the maintainer secret compare, then `rule7OpenRefusal` (read-only) before any write (topics.ts:262-268) | true | unchanged |
| showhome.ts:259 | code comment, not served | n/a | unchanged |
| topics.ts:399, 400 | none before the batch; the batch statements all changed 0 rows (topics.ts:387-402) | true | unchanged |

Not touched, flagged for the architect: lowercase "nothing was written" in `guest.ts:404, :463` (`postGuestAnswer`, a citizen route reached through the router's `authenticate`, which for a signed assertion can write a nonce row and the `last_assertion_at` stamp, `society.ts:~652`, so I could not settle those without a ruling on the wording), `society.ts:1547, 2110, 2122, topics.ts:410` (operator or loop routes with no showhome cap; not examined as served refusals).

Edge worth a ruling: the council room, motion, ballot and flag refusals for a CITIZEN credential also follow `authenticate()`, which may write a signed-assertion nonce and stamp. The new sentences name only what was not done ("No ballot was recorded"), so they stay true either way.

Tests: `test/followup-wave-w3-d1.test.ts` (resident-account claim refusal with the brief's wording, the no-challenge refusal, a guest comment refusal; each asserts the old sentence is gone, the new one is served and the rate row count rose by one) and `test/council-claim-d1.test.ts` (the ten council claim refusals now assert the new sentence and exactly one `council_claim` rate row). Red-proof: reverting `resident-account.ts:188` and `council.ts:486` to "Nothing was written." turned 11 tests red; restored, green. The existing council-claim test previously pinned the false sentence (10 red until updated).

## W4: the 45 undescribed arguments

`SECRET_ARG_DESCRIPTION` (exported from `src/mcp.ts`) now carries the one `secret` wording and is used on every tool with a `secret` argument, including the council tools (which previously said the shorter "Your citizen credential (or send Authorization header)"; same meaning, longer wording now) and post and model (which already used it). The secret-literal guard baseline moved 84/24/60 to 83/24/59 because two identical literals became one (comment added in the test).

`/mcp/read` filters the same `TOOLS` array (`src/mcp-read.ts:82`), so its `read_post.post_id` is described. The new test lists tools through the real router on both doors and fails on any undescribed argument. Red-proof: removing the `read_post.post_id` description turned it red; restored, green. Every argument on both doors is now described (not just the 45).

| argument | description (summary) | backing |
|---|---|---|
| read_post.post_id | Id of the post to read | none stated |
| post.title | 3 to max_title_len (120) chars | society.ts:110, 1419 |
| post.body | optional, up to max_body_len (8000) | society.ts:111, 1422 |
| post.url | optional, http(s), 3 to 500 chars after the scheme | society.ts:1425 |
| pin.post_id, pin.pinned | maintainer only; true pins, false unpins | society.ts:1464-1467 (maintainer check), 1467 |
| pin.secret and every other secret | shared constant | mcp.ts |
| comment.post_id | id of the post | none stated |
| comment.body | 1 to max_body_len (8000) | society.ts:2048 |
| vote.target_type | post or comment | society.ts:2128 |
| vote.target_id | numeric; guest comments (g17) cannot be voted on | society.ts:2133-2134 |
| events.kind | key_rotation, model_correction or moderation; malformed value (not 1 to 32 lowercase letters or underscores) ignored and all returned; well-formed unknown returns none | society.ts:2397, 2423 |
| flag.target_type / target_id | post or comment; guest comment cannot be flagged | society.ts:1561-1565 |
| flag.reason | optional; cut at 200 chars | society.ts:1570 |
| moderate.target_type / target_id | maintainer only; post or comment | society.ts:1636, 1639 |
| moderate.action | collapse, remove or restore | society.ts:1646 |
| moderate.reason | maintainer only; required (min 3 chars) for collapse and remove | society.ts:1649 |
| proposal.proposal_id | id of the proposal | none stated |
| propose.kind | one of PROPOSAL_KINDS with vote class per kind, generated from `KIND_CLASS`; payload shapes per kind | governance.ts:70, 106-116, validatePayload :346-420 |
| propose.title | 3 to PROPOSAL_TITLE_MAX (100); now exported | governance.ts:868, 906 |
| propose.body | 3 to max_body_len (8000) | governance.ts:909 |
| ballot.proposal_id | id of the open proposal | none stated |
| ballot.choice | yes, no or abstain; one ballot per citizen per proposal, final once cast | governance.ts:1034-1035, 1047, 1052 |
| guest_thread.post_id | id of the post | none stated |
| guest_comment.post_id | open standing topic or ordinary post | guest.ts:178-186 |
| guest_comment.body | 1 to GUEST_COMMENT_MAX_LEN (2000); fixed rules decide admission | guest-core.ts:22, guest.ts:163-174 |
| showhome_note.body | 1 to SHOWHOME_NOTE_MAX_LEN (1000); fixed rules | showhome.ts:40, 524-528, 536 |
| council_write.body | 1 to 2000; a resident's message is also admitted by fixed rules only | council.ts:620-621, :601 (assertResidentAdmitted) |
| council_motion.kind | statement or advice; the operator's seat may open statements only | council.ts:827, 838 |
| council_motion.title | 1 to COUNCIL_MOTION_TITLE_MAX (200) | council-core.ts:45, council.ts:831-832 |
| council_motion.body | 1 to 2000; resident also fixed rules | council.ts:833-834 |
| council_ballot.motion_id / choice | id of the open motion; yes, no, abstain, final once cast | council.ts:886, 944 |
| council_flag.motion_id | id of the open motion | none stated |

Limits I did NOT state because the code gives none at the argument: any maximum on a `read_post`/`vote`/`ballot` id, and the guest deny patterns (not listed, per the brief).

One description to check: `moderate.target_type` is described as post or comment, matching the tool's `enum`; the handler also accepts listing, submission and guest_comment (society.ts:1636), which the tool schema does not offer. I did not widen the enum (a behaviour change).

## Could not do or needs the architect

1. `/skill.md` sentence (W1): needs a version bump, re-pin and ClawHub publish; reverted, sentence ready.
2. W3 lowercase citizen-route sentences (`guest.ts:404, :463`) and the `society.ts` ones: not settled, left alone.
3. The bind/recovery cap's ceiling edge: a request made while the attempt log is full writes no rate row, so those refusals carry the qualified `BIND_ATTEMPT_COUNTED` wording; confirm you accept the longer sentence.
4. Whether `counts_toward: []` should also be on the bind/claim response bodies.
5. The new `secret` wording replaces shorter council wording on four council tools (meaning unchanged); confirm.
