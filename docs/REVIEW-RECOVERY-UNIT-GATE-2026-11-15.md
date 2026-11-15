# Gate record: recovery-unit wave (R1, R2, R3), 15 November 2026

Range `6f7ff7ed..e3f1b099` (code ends at `67b2acb0`). Branch `recovery-unit-commit-2026-11-15`. Read-only review; nothing edited, committed, deployed or sent.

## Verdict: DEPLOYABLE WITH CONDITIONS (HIGH 0, MEDIUM 1, LOW 4)

Conditions:
- C1. Deploy on the same UTC day as the privacy date (15 November 2026). The deploy script already enforces this (Test-PrivacyDate, step 0a/0b), so a run after midnight UTC stops before any write and needs a re-date, re-review and re-pin. This is the one operational constraint; it is not a code defect.
- C2. Run the scratch rehearsal first (it must see a pre-0027 scratch schema), then set `$REVIEWED_COMMIT` to the final reviewed sha (placeholder still present, which correctly stops the script today).

## Findings

### MEDIUM
M1. Served date coupled to the deploy day. `src/resident.ts` (RECOVERIES_SINCE = "15 November 2026", used in RECOVERIES_NOTE) and `src/privacy.ts` ("recorded since 15 November 2026", "Last updated: 15 November 2026") say the field shipped on that date. If the deploy lands on 16 November or later the sentences are false by a day. Mitigation already in place: `scripts/deploy-recovery-unit.ps1` Test-PrivacyDate stops unless the date equals the UTC day of the run. Fix only if the deploy slips: re-date both strings, re-pin the privacy hash, re-review.

### LOW
L1. `src/doors.ts` countDoor: the two statements are one `DB.batch`, which is atomic. If `commit_days` were missing, the door-count statement would roll back with it and door counts would be lost (logged as `door_count_failed`, never thrown). Not reachable under the script order (migration, verify, then worker) or on a worker rollback (the table stays). Worth knowing only for a hand-run worker deploy before the migration. Optional fix: none needed.
L2. Deploy script ride (`Test-PrivacyServed`, `Test-CommitListed`) reads the UTC date at ride time. A deploy that straddles 00:00 UTC would stop with the rollback line on a true state. Fail-closed, rare.
L3. ROLLBACK comment wording (`scripts/deploy-recovery-unit.ps1` lines 24-25, and `$ROLLBACK_LINE`): "a re-roll-forward would fail on ADD COLUMN" is true only if the columns were NOT dropped; if dropped, ADD COLUMN would succeed but the rows are lost. The instruction (never drop) is right, the stated reason is loosely worded.
L4. Counters after a rollback window: recoveries made while the old worker is live are not recorded, so a later roll-forward shows a lower count. The served text says "recorded", so it stays true.

## Priority 1: served sentences (each checked against code)

- `/privacy` "recoveries ... since 15 November 2026 ... last_recovered_at ... null when none is recorded": true (resident.ts:355-359 and serveResident; both UPDATEs bump and write the timestamp; default NULL). Date: see M1.
- `/privacy` counters sentence ("deploy stamps (a code commit, or unstamped) observed during completed door-counting attempts, including attempts after a counter has capped, with the timestamp carried by the first insert that landed"): true. doors.ts COMMIT_DAY_SQL is a separate statement in the batch, unconditional on the count's DO UPDATE WHERE; INSERT OR IGNORE keeps the first row; `first_seen_at` is the `now` bound at the first landing insert. "nothing about who called": the table has no caller field. "unstamped" covers both an absent and a malformed stamp (code-identity.ts:51-61 returns null commit for both), so "(a 40-hex commit, or unstamped)" is true.
- DOORS_NOTE commits_by_day sentence: each clause true, including "not necessarily the earliest such request", "A day may show several stamps", "/privacy is not a counted door" (no recordDoor call for it in index.ts), "Days before this shipped have no entry".
- discovery.ts `/api/doors` description ("per UTC day in the same window"): doorsReport uses the same `day >= since` for both queries.
- RECOVERIES_NOTE / roster and profile route descriptions: true; every non-bind `token_hash` writer was cross-checked (only resident.ts:302 and resident-account.ts:291 replace a token on a resident; showhome.ts:498 is the visitors mirror).
- RESIDENT_UNIT / RESIDENT_UNIT_NOTE and route descriptions ("unit ... on the total and on every row"): present on roster total, serveResident (roster and profile) and residentFacts (guest-core.ts, used society.ts:1723 for /api/official.residents).

No false served sentence found beyond the date coupling in M1.

## Priority 2: correctness

- Account UPDATE (resident-account.ts:290-296): `?7` is `now`, used for both `expires_at > ?7` and `last_recovered_at`; `?8` account id; numbering is contiguous and consistent. The bump is in the same statement as the token replacement, guarded by the old hash and live challenge; `results[0].changes !== 1` raises 409 and the batch's UPDATE then recorded nothing.
- Key UPDATE (resident.ts:302): `?4` is a fresh `Date.now()`, `?1 ?2 ?3` unchanged; old-hash and `public_key IS NOT NULL` conditions retained, so a lost race changes 0 rows and bumps nothing. D1 batch is one transaction, so a failed later statement rolls the bump back.
- countDoor: never throws (try/catch). doorsReport: ordering `day DESC, first_seen_at ASC, code_commit ASC`, same window as the rows.
- Roster/profile/residentFacts: `recoveries` via `Number()`, `last_recovered_at` passes null through.
- Migration 0027 vs schema.sql: the block from the first ALTER onwards is byte-identical (checked by script, LF, no CR in the migration). No migration rebuilds `guests` (0018 creates, 0020 ALTERs, 0027 ALTERs); guests tail on prod is therefore `resident_at, recoveries, last_recovered_at`, matching the catalogue expectation.

## Priority 3: behaviour outside the brief

None found. Subrequests per request are unchanged (one D1 call per recordDoor, now a batch of two). Writes: one new row plus its index entry per distinct (day, stamp); a repeat insert is ignored by the primary-key check before any write. Extra rows read: one primary-key probe per counted call. Far inside free-tier limits. `doorsReport` adds one SELECT. No route or error path changed.

## Priority 4: constitution

`src/doc.ts` is byte-identical between `6f7ff7ed` and HEAD (sha256 `92b873e3...ca5`, whole file, so FRONT_DOOR_TEMPLATE is identical).

## Priority 5: deploy and rehearsal scripts

- Order: the placeholder, privacy-date, git, level-with-origin, no-mint template compare, single-migration check, reviewed-commit and allowlist, `npm test`, typecheck, v6 pin run, live base proof, roster marker and production-target proof (UUID of `commonhold` from the account against wrangler.jsonc) are all before the first remote write. Reads before that use `d1 execute --command` only. `-DryRun` exits before step 5. The only writes are the migration (step 5) and `wrangler deploy` (step 7), and a real run requires `-RehearsalPassed`.
- absent/complete/partial: Get-MigrationState counts the three objects from the catalogue read; absent applies, complete skips, partial stops, a failed read is an error and never "absent". Correct for non-idempotent ADD COLUMN.
- Ride asserts effects the old worker cannot produce: roster top-level `unit`, the recoveries sentence, `/api/official.residents.unit`, the privacy markers, `commits_by_day` and the note marker, and this deploy's commit listed for the day. It cannot ride a recovery (stated in the script).
- Rollback statement: true that 0027 is harmless to the old worker (additive, defaults, no `SELECT *` into a strict type found); see L3 for the reason wording.
- Rehearsal: the target name is pinned to `commonhold-migtest`, the script refuses another name, stops if the repo config names the scratch DB, and stops if the account's scratch UUID equals any `database_id` in the repo config. It cannot reach `commonhold`.

## Priority 6: red-proofs reproduced (in a temp copy, no tracked file edited; `git status` clean)

Baseline in the copy: 37 of 37 pass across the four relevant files. Mutants:
1. Account UPDATE without the `recoveries + 1` bump: red (2 fail of 30).
2. `INSERT OR IGNORE` changed to plain `INSERT`: red (13 fail of 30; more than the checkpoint's 1, as the plain insert also breaks existing door tests).
3. Door count and stamp as two separate `.run()` writes instead of one batch: red (4 fail of 30).

## Verified first-hand versus taken on trust

First-hand: the full diff of src, schema, migration; the served sentences against code; code-identity stamp logic; migration/schema byte identity; doc.ts hash equality; absence of a guests rebuild; the deploy and rehearsal script control flow and target pinning by reading; the three mutants above.
On trust (hub, not re-run): the full suite (3242/3241/0/1) and typecheck; the token_hash writer inventory beyond the greps I did; the scripts' own unit tests. I did not execute either `.ps1` file.

## Could not check

Real D1 behaviour (rows_written of an ignored INSERT, batch atomicity) was reasoned from SQLite and D1 documentation and the node:sqlite harness, not measured on D1; the rehearsal on the scratch D1 is where that gets proved. PowerShell 5.1 parsing of the scripts was not run by me.
