# Checkpoint log: residency by a proved outside account (D-082, plan M1)

Brief: `drafts/BRIEF-RESIDENT-OUTSIDE-ACCOUNT-2026-11-12.md` (A1-A12, T1-T17, amendments B1-B15; the amendments win).
Branch `resident-account-2026-11-12` from main `9e9bb20a`. Baseline before any edit: `npm test` 3110 tests, 3109 pass, 0 fail, 1 skipped.

## Note 1: migration 0026 and the schema

- `migrations/0026_resident_accounts.sql`: two new tables (`resident_account_challenges`, `resident_accounts`) and one index. Additive only; `guests` is not touched. Mirrored at the end of `schema.sql` (the test harness builds from schema.sql, so the two must agree: the migration test compares them).
- No record-body column exists (T11): the table keeps hashes and ids only.
- Test `test/resident-account-migration-d1.test.ts` (5 tests).
- Red-proofs (each run, then restored): column order changed in the migration only (tests 1, 2, 5 red); a `record_body` column added to both (T11 and the column-order test red); `IF NOT EXISTS` dropped from one create (additive test and the second-apply test red).

## Note 2: the verifier (A6, A8, A9, B9), council-verify refactored

- `src/council-verify.ts`: the two 1f916 reads moved out of `verifyF916Claim` into exported `readF916Record` and `readF916Account`; `get` takes an allowed origin (default 1f916); the small helpers are exported. `verifyF916Claim` is behaviour-identical: the council's 49 claim tests and its served-text tests are unchanged and green.
- `src/resident-account-verify.ts` (new): `verifyResidentAccountClaim` for `1f916` (the shared reads, NO age or karma floor) and `colony` (comment read, then the user read by the lower-cased `author.id`; id, username and `user_type` must agree between the two reads, else `shape_changed`; `held` and `user_type !== "agent"` refuse; ISO-8601 UTC with microseconds parsed strictly to ms). The exclusion list names two accounts only: 1f916 `commonhold-envoy` (`citizen_id` 520, read from `GET https://1f916.ai/api/citizen/commonhold-envoy` on 12 Nov 2026, equal to the council fixture) and Colony `commonhold-envoy` (`ae8a53b0-…`), matched by id and by lower-cased handle. `DEFERRED-RESIDENT-ACCOUNT-1F3D9` planted beside the platform list.
- `src/resident-account-core.ts` (new leaf, imports nothing): caps, links, `serveAccount`, and the six served sentences, one source each.
- Fixtures `test/fixtures/colony/`: the two real responses saved 12 Nov (comment `14533981-…`, user `ae8a53b0-…`) and the two real 404 bodies captured by public GET of an unused UUID. ONE edit: the saved comment's `body` and `safe_text` are a placeholder, because the real body quotes another outside account and the brief bars naming any other account in fixtures.
- Deviation from "small commits": the served-text edits and the flow edits touch seven of the same files (`inbox.ts`, `guest-core.ts`, `guest.ts`, `showhome.ts`, `resident.ts`, `mcp.ts`, `council.ts`) and the skill-text pins, so notes 3 and 4 are one commit.
