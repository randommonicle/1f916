# Checkpoint: received_elsewhere catch-up (20 Oct 2026)

Class: hand-kept data on GET /api/guest/due only. No money route, auth, model call, mint, migration, schema, doc.ts, cron, write path or /skill.md.
Ruling: Ben, 20 Oct ("add on to the lists, yes to all"); hub ruling, same day: both self-description fields become nullable where the platform serves none (E4-E7); the sentence changes "a comment on the post" to "a comment or note"; `answered_by` lists every answer by our identities even where the platform re-parented it.

## Evidence (public GET reads, 20 Oct 2026, saved under scratch/received-elsewhere-builder/evidence/ at the project root)

| Entry | Critique id and time (UTC) | Answers (id, time UTC) | Source file |
|---|---|---|---|
| E1 penny 466b38e9 | existing | + e0a0c5ac-c434-4594-8534-cb5ef5f5d637, 2026-10-14T13:49:30.854883Z (parent 466b38e9) | colony-comments.json |
| E2 thecaretaker | cf412908-5fc1-44f2-b11c-4fb4a5bc241a, 2026-10-15T19:22:37.746828Z | 242f5cc4-700c-4776-837b-1a5298d188a3, 2026-10-17T19:57:34.977912Z | colony-comments.json |
| E3 thecaretaker | 1ed54728-eedc-4dc1-a125-fbc51da3a287, 2026-10-17T19:59:34.039570Z | 19dec72b-9579-4c9c-84b9-7ee0a321cc47, 2026-10-18T22:54:16.075939Z | colony-comments.json |
| E4 parallax, 1f3d9 note 36304 | 2026-10-18T23:44:57.907Z | note 37121 2026-10-20T09:23:10.681Z | 1f3d9-note-36304/36659/37121.json |
| E5 parallax, 1f3d9 note 36667 | 2026-10-19T15:02:29.358Z | note 37121 2026-10-20T09:23:10.681Z | 1f3d9-note-36667/37121.json |
| E6 kashia-muse, 1f916 comment 112374 | 2026-10-19T00:16:17.240Z | 113330 2026-10-19T14:10:56.967Z | 1f916-post-9271.json |
| E7 kashia-muse, 1f916 comment 113953 | 2026-10-20T01:44:31.775Z | 114346 2026-10-20T08:15:14.389Z | 1f916-post-9271.json |

Notes
- thecaretaker's Colony bio is one sentence (whole bio, excerpt false).
- 1f3d9 serves no self-description: the resident record is {id 23, handle, model, joined_at}; no profile route exists (/api/resident/*, look, drawing all 404; `residents?view=presence&handle=` carries no text). 1f916's /api/citizen/kashia-muse carries handle, model, karma and counts, no bio. E4-E7 therefore serve null for both description fields.
- 1f3d9 and 1f916 have no HTML page for a note or post; the url is the public API URL (https://1f3d9.com/api/note/N, https://1f916.ai/api/post/9271).
- 1f916 re-parents deep replies (113355 sits under 113330, 113953 under 113355, 114346 under 113953). 113355 and note 36659 are invitations to the guest door, not answers, and are not listed (fix pass).

## Commit 2: entries, text, tests

- `src/guest-core.ts`: `account_self_description` and `account_self_description_is_excerpt` are `string | null` and `boolean | null`; E1 appends e0a0c5ac; E2-E7 added in posted_utc order (10 entries). Comment block updated (three platforms, where each was read, null rule, re-parented answers).
- Served sentence, one change plus one clause: `each entry is a comment on the post at its url` becomes `each entry is a comment or note at its url`; `...true where that text is only part of its profile bio)` becomes `...true where that text is only part of its profile bio; both are null where the platform serves no self-description)`. `RECEIVED_ELSEWHERE_FROM_UTC` and the rest unchanged; "on another platform" and "from [date] (our review request post on The Colony; earlier ones are not listed)" remain true.
- Existing exact assertions updated: `test/penny-three-received-elsewhere-d1.test.ts` EXPECTED (4 to 10 entries), every `received_elsewhere_count` 4 to 10, the A5 comment text, the T7 note phrases (the two changed wordings) and the excerpt/bio assertion (Colony-only bio check, null for the rest); `test/deploy-penny-three-script.test.ts` line 569 (`received_elsewhere_count` 4 to 10) and the `count_wrong` regex (list length 4 to 10).
- New tests: null descriptions serve null for both fields and the type allows it; every entry has an answer by commonhold-envoy later than its critique and entries are in posted_utc order.
- Red-proofs: answer time moved before its critique (3 red); a description set to invented text (3 red); sentence wording reverted (T7 red). Each restored by reverse edit.
- Baseline 2651 (2650 pass, 1 skip); now 2653 (2652 pass, 1 skip), tsc clean.

## Commit 3: deploy script and its test

- `scripts/deploy-received-elsewhere.ps1` (written and never run, not even -DryRun): worker only, no migration, no D1 command; `$LIVE_BASE_COMMIT = 3818e23f25efcbfbef8f1b3c22183d75a84ee447`; `$REVIEWED_COMMIT = "TO-BE-SET-BY-HUB"`; modelled on `deploy-penny-three.ps1` with its composition/citizens helpers removed. Probe before: the live list is the old 4-entry list without cf412908. Poll and ride: GET-only on `/api/guest/due` (10 entries, every id, the duty counts adding up, the two new note wordings), 14 public reads, v5 and chains. Duty counts across the deploy: a difference prints a note (a critique may arrive in between) rather than stopping, since no duty row is touched.
- `test/deploy-received-elsewhere-script.test.ts` (19 tests): parse/ASCII/LF, PS traps, pins, step order, no D1/migration, GET-only ride, plus the four decision functions run for real over `guestDue` output with a mutant per refusal reason.
- Red-proofs: `$NEW_COUNT` 10 to 9 (2 red); a POST/`Invoke-WebRequest` line added (8 red); the pre-wave "no new id" condition removed (1 red). Restored by reverse edit.
- Working-copy note: the worktree checked out CRLF (autocrlf); the other `scripts/*.ps1` were converted to LF in the working copy only so their existing LF tests pass; the index and every commit are unchanged for them.

## Fix pass (hub ruling after CODEX r2)

- E3 (1ed54728) kept, with a code comment saying why. Invitations removed from answered_by: 36659 (E4) and 113355 (E6); 37121 and 113330 stay; entries stay 10. The E4/E6 rows above are corrected. The deploy script names critique ids only and needs no change (its answer-count checks still hold).
- Provenance comments in src/guest-core.ts and the header of the penny-three test now separate the 14 Oct Colony read from the 20 Oct reads of the three public APIs.
- New test: no invitation id is in any answered_by and the remaining answers are exactly as typed. Red-proof: 113355 put back (red), removed (green).
