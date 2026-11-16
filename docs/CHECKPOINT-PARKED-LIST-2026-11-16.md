# Checkpoint: the parked list (D-083), builder log, 16 Nov 2026

Branch `parked-list-2026-11-16`, cut from main `36e84685`. Brief `drafts/BRIEF-PARKED-LIST-2026-11-16.md` (v3, ruled R1-R6).

## Commits

1. Feature: migration 0028 (`maintainer_declines`), `src/maintainer/parked.ts` (PARK_AFTER, the one eligible-cohort definition, `recordDecline`, the route), the judgment wake reads the eligible cohort at five sites, route in ROUTES / llms.txt / openapi (schema) / surface, the maintainer-runs note corrected, the /privacy paragraph (DRAFT, unapproved) and its date, `DEFERRED-JUDGMENT-REFUSAL-HELD-STATUS` resolved, `DEFERRED-PARKED-HAND-DECISION-ROUTE` planted.
2. Deploy tooling: `scripts/deploy-parked-list.ps1`, `scripts/rehearse-parked-list.ps1`, `scripts/verify-parked-list.sql`, `scripts/check-parked-list-served.mjs`, `test/deploy-parked-list-script.test.ts`. Never run by the builder.

## Mutations run (each shown red, then restored)

`test/parked-list-d1.test.ts` and `test/judgment-refusal-skip-d1.test.ts`:
M1 refusal writes no decline; M3 no ON CONFLICT; M4 insert failure not caught; M5 route joins finished runs only; M6 threshold `<=`; M7 scan WHERE plain pending (no cursor); M8 scan WHERE plain pending (cursor); M9a baseline reads raw count; M9b trigger reads raw count; M9c skip reads raw count; M9d count returns raw total; M10 reconciliation filtered by the cohort; M11 parked ignores status; M12 extra served field; M13 total counts only pending; M14 cursor `>=`; M15 note clause reworded; M16 twelve decline statements per refusal (budget).

`test/openapi-response-schema-d1.test.ts`: an extra served top-level key; a declared required key the route does not serve.

`test/deploy-parked-list-script.test.ts`: D1 a wrong pinned catalogue row; D2 the live-base pin changed; D3 the checker skips the privacy paragraph; D4 the checker compares a note prefix; D5 the rehearsal drops the already-migrated stop; D6 the ride drops the whole-document check; D7 the verify SQL gains a sixth compound term; D8 the new route added to the attested template.

## Constitution

Nothing in `FRONT_DOOR_TEMPLATE` changed (`src/doc.ts` is untouched). The route list inside that template does not name `GET /api/maintainer/parked`; adding it would mint v7, so it is not added there. `test/constitution-v6-d1.test.ts` (the v6 template hash) and `test/last-assertion-privacy-d1.test.ts` T13 stay green.

## Pins to re-set at deploy time

`PARKED_SINCE` in `src/maintainer/parked.ts` ("17 November 2026"), the `/privacy` date line and the "since 17 November 2026" clause in its paragraph, and `$REVIEWED_COMMIT` in the deploy script.
