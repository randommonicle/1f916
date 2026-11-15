# CHECKPOINT: recovery count, record unit, commit per door row (15 Nov 2026)

Brief: `drafts/BRIEF-RECOVERY-UNIT-COMMIT-2026-11-15.md` (outside the repo). Branch `recovery-unit-commit-2026-11-15`, worktree `scratch/wt-recovery-unit`, from the live commit `6f7ff7ed`.
Not merged, pushed or deployed; no wrangler or remote D1 command was run.

## Commits

1. R1: migration 0027, recoveries and last_recovered_at, both recovery routes, served on roster and profile, privacy text.
2. R2: `unit: resident_record` on the roster total, every row and `/api/official.residents`.
3. R3: `commit_days`, countDoor's one batch, `commits_by_day` on `/api/doors`, DOORS_NOTE, the write-budget formula.
4. Deploy tooling (written, never run): rehearse and deploy scripts, verify SQL, their test.
5. This checkpoint.

## FLAG FOR BEN: this is a privacy-text change

`src/privacy.ts` (the guests and residents paragraph) now names two new public fields, `recoveries` and `last_recovered_at`, and the page is re-dated to **15 November 2026**.
The deploy script STOPS unless that date equals the UTC date of the run, so if the deploy is on another day, re-date `src/privacy.ts` AND `RECOVERIES_SINCE` in `src/resident.ts`
(the test `the markers the script checks...` pins that the two are the same day), then re-pin (`secret-literal-guard.test.ts` PROSE_ALLOW hash of the privacy template) and re-review.
The `/privacy` counters paragraph was NOT changed for `commit_days` (the brief did not ask): the table holds a day, a deploy commit and a time, nothing about any caller.

## Served sentences (exact)

- Recoveries definition (roster and profile notes, after COUNTS_TOWARD_NOTE): "recoveries counts the successful token replacements recorded by either recovery route since this field shipped on 15 November 2026; last_recovered_at is the latest recorded one, null when none is recorded."
- Unit sentence (roster and profile notes, beside RESIDENTS_NOTE which carries the existing uniqueness and "any figure the society divides by" wording): "unit names what a resident total counts: resident_record, one guests row that became a resident, never an agent or a controller, and no figure the society divides by takes it."
- DOORS_NOTE addition: "commits_by_day lists, for each UTC day in the window, the deploy stamps (a 40-hex commit, or unstamped) that accompanied at least one completed door-counting attempt that day, including attempts after that door's count had capped; first_seen_at is the time carried by the first insert that landed, not necessarily the earliest such request. It is the operator's stamp (a commonhold_statement, as /api/attest's provenance says), not proof of the running bytes. A day may show several stamps, and a deployment without a completed door-counting attempt contributes no stamp observation, so this is not a complete deployment timeline and it does not say which /privacy response anyone received (/privacy is not a counted door). Days before this shipped have no entry."
- Privacy paragraph addition: "Both also show two fields about token replacement: recoveries, the number of successful token recoveries recorded since 15 November 2026, and last_recovered_at, the time of the latest recorded one, or null when none is recorded."

## Decisions and deviations

- `schema.sql` carries the 0027 block LAST (header "-- Recovery counts and commit days (migrations/0027_resident_recoveries.sql"); the 0020, 0021 and 0026 migration tests now compare against schema.sql cut at that header, because those migrations are rehearsed against a schema that does not yet carry 0027.
- countDoor is now one `DB.batch` of two statements, so the existing test wrappers that held back or failed a lone `run()` (door-counts, tool-counter, door-funnel) now gate and fail the batch; the proposals-unknown-params statement count for a refused MCP call is 4 (two attempts, each a two-statement batch), was 2. `resident-isolation` lists `commit_days` as a counter table beside `door_counts`.
- Subrequests: each counted door request now issues one batch of two statements (the same one subrequest on D1's own metering, two on the local harness's conservative per-statement count).
- Write budget (T5): 50,400 + 2S with S bounded by the stated constant 20 (one stamp per deploy, a handful of deploys a day); the fixed part is asserted equal to 50,400 so a change to the tool lists forces the brief to be updated. The rehearsal asserts D1's own `meta.rows_written` (first insert 1 or 2, duplicate 0, second stamp equal to the first).
- The deploy script's other-objects snapshot excludes the `guests` TABLE row (ADD COLUMN rewrites its sql by design); the catalogue verifies the guests columns, their default and their order instead. Index rows on guests stay in the snapshot.
- The rehearsal applies the migration ONCE and refuses a scratch D1 that already carries any of the three objects (the 0026 rehearsal applied twice; ADD COLUMN cannot).
- The REVIEWED pin ships as the placeholder `TO-BE-SET-BY-HUB`; step 0a stops until the architect sets it. The ride does not re-pin `/skill.md` or the tool counts (neither changes in this wave).
- The `/api/doors` route description in `src/discovery.ts` and `/api/residents` OpenAPI text were not edited to mention the new fields (not in the brief); worth a line in the next discovery pass.

## Red-proofs (mutant, then the count of tests that went red; each restored and re-run green)

R1 (`test/recovery-count-d1.test.ts`)
- key UPDATE without the bump: 3 red. Account UPDATE without the bump: 1 red. Old-hash condition removed from the key UPDATE: 1 red (the lost-race block). Bump added to the key bind UPDATE: 4 red. schema.sql tail drifted by one character: 1 red.
- Not mutated: "mirror also bumps" (visitors has no counter column, so the mutant cannot be written; the test asserts the column's absence and one recovery = exactly one, with the ring row present and evicted); "bump outside the batch" (the trigger test pins rollback; a separate write is not expressible without restructuring the route).

R2 (`test/resident-unit-d1.test.ts`)
- unit removed from serveResident: 1 red. From the roster total: 2 red. From residentFacts (official, and so both MCP handlers): 2 red. Unit note reworded to "enters no society figure": 1 red.

R3 (`test/commit-days-d1.test.ts`, `test/tool-counter-d1.test.ts`)
- plain INSERT (no OR IGNORE): 1 red. INSERT OR REPLACE: 2 red. Two separate writes instead of the batch: 1 red. Stamp insert made conditional on the count changing (`WHERE changes() > 0`): 1 red. Null stamp stored instead of 'unstamped': 1 red. Raw env value stored: 1 red. Ordering reduced to day, commit DESC: 1 red. Window dropped from the commits query: 1 red. A DOORS_NOTE sentence removed: 1 red. commit_days keyed by day only (schema.sql): 4 red. MAX_STAMPS_PER_DAY raised to 20000: 1 red (T5).

Deploy tooling (`test/deploy-recovery-unit-script.test.ts`)
- partial state treated as absent: 1 red. rows_written duplicate check weakened: 1 red. A pinned catalogue row changed: 1 red. Roster unit check removed: 1 red. The partial STOP renamed away: 1 red. Commit-listed check always failing: 1 red.

## Verification

`npm test`: 3242 run, 3241 pass, 0 fail, 1 skipped (baseline before this wave 3212/3211/0/1). `npm run typecheck`: clean. Both `.ps1` files parse with zero errors under `[System.Management.Automation.Language.Parser]::ParseFile`.
`FRONT_DOOR_TEMPLATE` untouched; `test/constitution-v6-d1.test.ts` green.

## Still to do (not done here)

The scratch-D1 rehearsal and the deploy are Ben's hand; the REVIEWED pin; the privacy-text read; the first real recovery after deploy is the ride of `recoveries`.
