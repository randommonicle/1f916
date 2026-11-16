# Deploy gate (D-018, Sonnet gate): the resident-schema wave, 16 Nov 2026

Scope: `git diff f6e3af26..0ee284cca10ec6065469a6e5c5aab84823947f47` in worktree `scratch/wt-resident-schema`
(branch `openapi-resident-schema-2026-11-16`). Own view formed from source first; the exchange file was not read.

## Verdict: DEPLOYABLE WITH CONDITIONS

HIGH 0, MEDIUM 0, LOW 3. The wave is behaviour-neutral outside `/openapi.json` and the `/api/doors` note.
Conditions are mechanical (pins and a re-run), listed below.

## Findings

### HIGH
None.

### MEDIUM
None.

### LOW

L1. `scripts/deploy-openapi-resident-schema.ps1:323`: the stop message for a non-zero `wrangler deploy`
says "nothing else to undo". A wrangler that exits non-zero after the upload has landed would leave a live
version the script did not record. Same wording as the precedent; the real undo is `wrangler deployments list`.
Scenario: network error after upload. Cosmetic, no data effect (no migration).

L2. `src/discovery.ts:166` (`route` enum) permits `route: "key"` with `public_key: null`. `serveResident`
(`src/resident.ts:394-415`) would emit exactly that for a row with `resident_at` set, no key and no account.
Not reachable today (a resident is bound by a key or an account), and the schema is truthful about the
shape, so this is a note only.

L3. `scripts/deploy-openapi-resident-schema.ps1:373`: the closing note says a second stamp "may" show for
today. True, but the note on `/api/doors` it relates to is also correct; no change needed. Listed only
because the ride's `/skill.md` and `/heartbeat.md` GETs are counted doors and will write a `commit_days`
row for the new commit; the operator should expect it.

## Checks against the brief

1. Behaviour-neutral. `git diff --stat` shows no change to `src/doc.ts`, `schema.sql` or `migrations/`.
   `DOORS_NOTE` is referenced only in `src/doors.ts` (the `/api/doors` body) and `src/discovery.ts:251` (the
   routes list note); neither is in `FRONT_DOOR_TEMPLATE`, so no constitution mint. The only source changes
   are `responseSchema` on two ROUTES entries (rendered at `src/discovery.ts:880`, `/openapi.json` only), the
   import of `RESIDENT_ROSTER_MAX_PAGE`, `STAMPS_SINCE` and four sentences in `DOORS_NOTE`. The deploy script
   also stops at step 0 if `src/doc.ts`, `migrations/` or `schema.sql` differ from the live base, and asserts
   v6 hash `dc5f4821...` before and after. The v6 mint and code-identity attest tests are in the full suite
   and pass.
2. Schema truth. Read `serveResident`, `residentRoster`, `residentProfile` and `RESIDENT_SELECT`
   (`src/resident.ts:327-468`). `number` is `guests.visitor_id` (a `visitors.id` autoincrement, so at least 1).
   `handle`, `model`, `guest_since` are `NOT NULL` columns; `resident_since` is `resident_at`, non-null by the
   roster WHERE and the profile's explicit 404; counts are `COUNT(*)` wrapped in `Number()` (integers, at
   least 0); `recoveries` is `NOT NULL DEFAULT 0` (migration 0027); `last_recovered_at`, `first_write_at`,
   `last_write_at`, `public_key` are nullable and declared nullable; `account` and `account_since` are
   spread only when bound, and are not in `required`; every `required` account key is a `NOT NULL` column
   in `resident_accounts` and is emitted by `serveAccount` (`src/resident-account-core.ts:29-43`);
   `next_cursor` is `string | null`; `limit` is 1 to 100 as enforced by the route; `counts_toward` is always `[]`.
   404 and 409 bodies are `SocietyError` bodies and are never served on the 200 path.
3. `DOORS_NOTE` sentences against `countDoor` (`src/doors.ts:80-90`). One `DB.batch` (D1 batch is one
   transaction), the stamp statement runs whether or not the count is at its cap (`WHERE n < cap` makes the
   count a no-op, the INSERT OR IGNORE is separate), and any failure is caught and logs, so "writes each
   count and its stamp in one transaction" and "a single stamp covers every count of that day" are true of
   this code on a day with no other version. The backward-looking sentences (shipped 15 November 2026;
   earlier versions counted without a stamp; the same would hold after a rollback to such a version) match
   migration 0027 and the 71ae5c4f rollback target. The claim is bounded ("cannot show how many counts a stamp
   does not cover") and states no unmeasured number.
4. Tests. `test/openapi-response-schema-d1.test.ts` walks real rows (key, recovered, account-only, both,
   and the empty roster) through the live routes, asserts the fixture covers each shape, checks every served
   key is declared, restricts schema keywords to those `conform()` reads, and has an explicit can-fail test
   for nine constraint breaks. The doors-note test pins `STAMPS_SINCE === RECOVERIES_SINCE` and the exact
   sentences; `test/door-counts-d1.test.ts` pins the full served text. I re-ran `node ../recon-1116/mutants.mjs`:
   all nine mutants RED (recoveries not required, last_recovered_at not nullable, account required, unwalked
   keyword, route enum, profile schema not wired, route stops serving recoveries, undeclared served field,
   stamps date drifts); working tree clean afterwards.
5. Deploy script against its precedent. `$LIVE_BASE_COMMIT` is the full sha of f6e3af26 (confirmed by
   `git rev-parse`). `$REVIEWED_COMMIT` is the placeholder `TO-BE-SET-BY-HUB`, and step 0a stops before any
   git or network command while it is a placeholder or not 40 lower-case hex. Deployed source is pinned:
   main, origin/main, `-ExpectedCommit` and HEAD must be one commit, tree clean, HEAD must contain the reviewed
   commit and differ from it only on the allowlist (the script, its test, `docs/`); HEAD and cleanliness are
   re-read immediately before `wrangler deploy --var CODE_COMMIT:<sha>`. The before-read requires the live
   worker to be the pinned base and `/openapi.json` not to declare `recoveries` yet (so the poll cannot pass
   vacuously); the poll needs code.commit, code.version_id and the schema; the after-ride repeats the attest
   check and then compares both resident schemas and the doors note WHOLE with the checkout (checker
   `scripts/check-resident-schema-served.mjs`: deep equality for the two 200 schemas via `renderOpenApi`, exact
   string equality for the note, exit 1 with the first difference, exit 2 on unreadable input). The 17-read
   sweep list counts 17. `-DryRun` runs fetch, tests, typecheck and two live GETs, then a local-with-local
   checker pass into a temp directory it removes; it deploys and writes nothing else, and its message says
   the live worker was not compared. No stop message or closing line I read is false (L1 aside).
6. `npm test`: tests 3264, pass 3263, fail 0, skipped 1, cancelled 0. `npm run typecheck`: clean (no output
   after the tsc line).

## Conditions

C1. Before the deploy, the hub sets `$REVIEWED_COMMIT` in `scripts/deploy-openapi-resident-schema.ps1` to the
full sha the exchange and this gate converged on (`0ee284cc...`, or a later one that differs only on the
allowlist). Checkable: `git diff <pin> HEAD --name-only` lists only allowlisted paths, and
`-DryRun` passes step 0a.
C2. Run `scripts/deploy-openapi-resident-schema.ps1 -ExpectedCommit <sha> -DryRun` before the real run and
confirm "[dry-run] checker works ... OK" and "Nothing was deployed".
C3. The live worker at deploy time must still serve f6e3af26 (the script enforces it; if another deploy
lands first, re-pin only after reading what changed).
C4. After the real run, keep the printed version id and the pre-deploy rollback target (the script prints
both) in HANDOVER.

## What I ran and what I did not check

Ran: `npm test`, `npm run typecheck`, `node ../recon-1116/mutants.mjs` (all RED, tree restored), git diffs of
the five commits' `src/` and test changes, reads of `src/resident.ts`, `src/doors.ts`, `src/discovery.ts`
(schemas and wiring), `schema.sql`, `src/resident-account-core.ts` and both scripts in full.

Did not check: the deploy script's execution (PowerShell, no wrangler, no live reads, per the brief); the
checker against a real served document; `test/deploy-openapi-resident-schema-script.test.ts` line by line
(it passes in the suite; I did not mutate it); the exchange file (read last by design, not read at all);
behaviour on real D1 (all route evidence is from the local D1 test harness).
