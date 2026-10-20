# D-018 gate (Sonnet tier): received_elsewhere catch-up, 20 Oct 2026

Scope: branch received-elsewhere-2026-10-20 head 59fde518, base 3818e23f. Read-only review.
Verdict: DEPLOYABLE (no conditions). HIGH 0, MEDIUM 0, LOW 3.

## Checks
- Diff touches only src/guest-core.ts (src), three tests, the checkpoint and the new deploy script. No money, auth, migration, schema.sql, src/doc.ts, route or cron change.
- Evidence vs served: every id, timestamp and answer id in src/guest-core.ts:160-238 matches the saved raw reads (Colony comments incl. parents 242f5cc4 -> cf412908, 19dec72b -> 1ed54728; 1f3d9 notes 36304, 36667, 37121; 1f916 comments 112374, 113330, 113953, 114346 with the re-parenting recorded). thecaretaker bio matches Colony record verbatim. 1f3d9/1f916 serve no bio, so null is true. Invitations 36659 and 113355 are correctly absent. Order by posted_utc holds; every answer is later than its critique.
- Served sentence (guest-core.ts:242): "comment or note" and the null clause are true; "from 13 Oct" start date and "never independent" unchanged.
- Nullable readers: the only readers are guest.ts:599-601 (passes the list through), discovery.ts:249/551 and mcp.ts:465 (prose, no field reads). No code dereferences the two fields. tsc clean.
- Duty counts: received_elsewhere is a constant array outside the counts query; the new test and ride assert the six counts are unchanged.
- npm test 2673 (2672 pass, 1 skip), typecheck clean.
- Deploy script: worker only, no D1 or migration command; step 0 refuses on migrations/schema.sql/doc.ts moves; Test-ReceivedElsewhereCaughtUp and PreWave read the real served body (count = length = 10, every new id, answers non-empty, counts sum); ride is Invoke GET only; ErrorActionPreference Stop with exit codes checked on native commands. $REVIEWED_COMMIT is the placeholder, so it cannot run un-pinned.

## Findings
- LOW 1: scripts/deploy-received-elsewhere.ps1:152-181 does not check that the null description fields are actually null on E4-E7 or that answers include the expected ids; a wrong list of the right size/ids would pass the ride. Tests cover it pre-deploy; acceptable.
- LOW 2: E3 (guest-core.ts:178-187) is a reply to our own envoy rather than a first-hand critique; kept by Ben's ruling and commented. It is a judgment call, not a defect.
- LOW 3: E4 and E5 share answer 37121, which credits both notes; true on the note text (it cites #36667 in prose, #36304 in the code-comment sentence). No change needed.

Not verified: the E1 parent of e0a0c5ac (checkpoint says 466b38e9; my grep output was truncated). Ben to glance if wished.
