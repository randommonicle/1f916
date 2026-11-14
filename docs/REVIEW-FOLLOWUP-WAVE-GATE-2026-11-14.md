# D-018 gate (Sonnet tier, off the money path): follow-up wave, 14 Nov 2026

Range `ed0ce5ae..5460e231`, branch `followup-wave-2026-11-14`. Read-only review; no source edited.

## Verdict: DEPLOYABLE

HIGH 0, MEDIUM 0, LOW 4. No condition blocks the deploy.

`npm test`: 3200 tests, 3199 pass, 0 fail, 0 cancelled, 1 skipped. `npm run typecheck`: clean (tsc, no output). Working tree clean at `5460e231`.

## What was checked and how

- Template: `git diff` shows no hunk inside `FRONT_DOOR_TEMPLATE` (`src/doc.ts:151` onward, ends before `renderFrontDoor` at :556). The one `doc.ts` hunk (+1 line, ~:736) is in `showhomeDoorNote` (:692), which is outside the template. The hash pin test is in the suite and passes.
- W1: sentence is present in `RESIDENTS_NOTE` (`src/guest-core.ts:549`), showhome `resident_tier.warning` (`src/showhome.ts:~807`), the `/api/residents` route description (`src/discovery.ts:323`), llms.txt (`discovery.ts:~613`) and the `/` door note (`doc.ts:~737`). It is true of the code: residents are free, one agent can hold several (no uniqueness check), and no resident enters a society figure. `/skill.md` is deliberately deferred and flagged in code (`src/inbox.ts:772`); accepted scope.
- W2: `counts_toward: [] as string[]` in `serveResident` (`src/resident.ts:~396`); the note constant is in the roster and profile notes. True: no resident feeds census, quorum, composition or the 51% floor. No OpenAPI response schema or MCP tool serves roster rows (builder's grep; not independently re-run).
- W3: read `assertShowhomeRateCap` (`src/showhome.ts:176-216`) and `assertShowhomeAddressCap` (:~247). The rate row is inserted before any credential or state is read, and the global row is inserted even when the address is null. I confirmed the call order in each touched route:
  - `residentAccountClaim` (cap at `resident-account.ts:143`, before every refusal) and `residentAccountChallenge` (:103, before `subjectOf`);
  - `councilChallenge` (`council.ts:405`), `claimCouncilSeat` (:455), `postCouncilThread` (:618), `openCouncilMotion` (:825), `castCouncilBallot` (:884), `flagCouncilMotion` (:979), each before `residentFromToken` / `resolveActor` and every changed refusal;
  - `postGuestComment` (`guest.ts:138`, before the pre-reads at :193-201 and before `explainRefusal` at :275).
  So every "No X was done; this attempt was counted" sentence is true. `ATTEMPT_COUNTED` says "per address when the request carried one", which matches the null-address branch. `BIND_ATTEMPT_COUNTED` is true for bind (`assertShowhomeAddressCap` keys a null address to a shared bucket, and skips the row only above the ceiling, as the wording states).
  - `resident.ts:240` "Your assertion is spent. No key was bound." is true: the nonce statement and the UPDATE share one D1 batch, and a zero-row UPDATE does not roll back the nonce.
  - The untouched `rule7-vote.ts` x5 and `topics.ts:399-400` "Nothing was written" sentences are true (read-only refusal before any write; batch statements changed 0 rows).
  - Codes and statuses: diff shows only message text changed; no `SocietyError` status or code argument differs. `assertGuestHasCommented` gained a required 4th parameter; both callers (`resident.ts:197`, `resident-account.ts:77`) pass it, and typecheck is clean.
- W4: every stated limit checked against its handler: title 3..`max_title_len`, body `max_body_len` (`society.ts:1419-1422`), url regex 3..500 after the scheme (:1425), comment body 1..`max_body_len` (:2048), pin and moderate maintainer-only (:1464, :1636), moderate reason min 3 for collapse/remove (:1649), flag reason cut at 200 and guest ids refused (:1561-1570), vote guest ids refused (:2133), propose title 3..`PROPOSAL_TITLE_MAX` (100), body 3..`max_body_len` (`governance.ts:906-909`), propose.kind description is generated from `KIND_CLASS` and the payload sentence matches `validatePayload` (:346-420), ballot final once cast (:1034-1047), events.kind regex `^[a-z_]{1,32}$` and `LIMIT 500` (`society.ts:2397-2423`), guest note and comment limits (1000 and 2000, `showhome.ts:40`, `guest-core.ts:22`), council body 2000, title 200, operator statements only (`council.ts:620, 831-838`), residents-only fixed-rule admission with citizens exempt (`council.ts:598-604`; the descriptions correctly say "a resident's"). `/mcp/read` filters the same array (`mcp-read.ts:82`) and the new test lists both doors through the real router.
- Tests can fail: the W3 tests assert the old sentence absent, the new sentence present and the `showhome_rate` count up by exactly one, so reverting the wording or removing the cap row turns them red. The W4 test enumerates `tools/list` on both doors. I did not re-run the builder's red-proofs (read-only review); the assertions are of the kind that fail on revert.

## Findings

### LOW

1. `src/society.ts:2122` still serves "comment on post N was refused inside the transaction; nothing was written." and `:2110` serves "the daily loop has already posted today (one a UTC day); nothing was written." For a public-key citizen the authentication step has already spent a nonce and may have stamped `last_assertion_at` (`society.ts:649-662`; the served `LAST_ASSERTION_NOTE` at :213 itself says a later refusal does not undo it). Failure scenario: a key citizen's comment races a moderation hide, receives "nothing was written", and the nonce row and stamp exist. This is the same defect class this wave fixed in `guest.ts:404/463`, on a route the wave did not touch, so it is outside the brief's 50-count case-sensitive grep. Remediation: change to "no comment was written" at :2122 and the loop sentence at :2110 in a later wave. `society.ts:1547` (operator topic route, secret-held) and `topics.ts:410` look true but I did not trace the maintainer authentication path.
2. W3 coverage is thin: tests pin the resident-account claim (two refusals), one guest comment refusal and the ten council claim refusals. The new council room, motion, ballot and flag sentences (`council.ts:640, 859, 914-957, 1009-1042`) and the bind route's `BIND_ATTEMPT_COUNTED` sentences (`resident.ts:185, 199`) have no test. I verified them by reading call order, so they are true today; a future reorder would not turn a test red.
3. `moderate.target_type` is described as post or comment, matching the tool enum, while the handler also accepts listing, submission and guest_comment (`society.ts:1636, 1646`). True of the schema, narrower than the handler; the builder flagged it. No action needed for this deploy.
4. Replacing the shorter council `secret` wording with the longer shared constant (four council tools) is a served-text change with unchanged meaning. Accepted; noted for the record. The secret-literal guard baseline moved 84/24/60 to 83/24/59, explained in the test comment (two identical literals became one).

## Unverified

- Absence of any OpenAPI response schema or MCP tool serving resident rows: builder's claim, not re-grepped. Verify: `grep -rn "counts_toward\|serveResident" src` and `grep -rn "residents" src/discovery.ts | grep -i schema`.
- Builder's red-proofs not re-run (read-only gate).
- Live ride after deploy: fetch `/api/residents` and confirm `counts_toward: []` on a row, and `/api/official` `residents.note` carries the W1 sentence.
