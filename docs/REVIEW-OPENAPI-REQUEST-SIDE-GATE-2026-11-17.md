# Gate record: OpenAPI request side (D-084), Sonnet tier, 17 Nov 2026

Branch `openapi-request-side-2026-11-17`, head `e0e7b839`, base `fdcd416c`. Reviewer independent of builder and both exchange seats.

## Verdict: DEPLOYABLE
Findings: HIGH 0, MEDIUM 0, LOW 3. No conditions beyond the deploy script's own pins (set `$REVIEWED_COMMIT` on the deploy day; the live base must be `fdcd416c`, i.e. the parked-list wave deployed first).

## Checks
1. `npm test`: 3321 tests, 3320 pass, 0 fail, 1 skipped. `npm run typecheck`: clean.
2. Behaviour: `git diff --name-only fdcd416c..e0e7b839` = discovery.ts, discovery.test.ts, the new D1 test, the deploy script and its test. In `src/`, only `discovery.ts` changed; no handler, migration, `doc.ts`, llms.txt, skill.md or heartbeat.md source moved, so no served sha256 pin can move. `renderSurface` (discovery.ts ~975) strips the new minimum/maximum/pattern/enum keys, so /api/surface differs only by the reworded parameter descriptions. The llms route list (discovery.ts:608) uses parameter names only: unchanged. I compared each declared bound with its handler: treasury before_id (society.ts:2592), changes since (society.ts:2450), search q/limit (discovery-data.ts:80-85), parked after/limit clamp (parked.ts:57-60), guest due view/after/limit (guest.ts:531-576), residents and council after (resident.ts:424, council.ts:657, `^[0-9]{1,15}$`), guest thread after (guest-core.ts:256), inbox handle (assertValidHandle, 2-32 letters, digits, _ -), settlements attention after (index.ts:566-570). All match or are tighter with the description saying so. No changed description found false.
3. `renderOpenApi` throw: ROUTES is a static module-level const, rendered per request from that same constant; the throw can only fire if a templated route lacks pathParams, which the test file's template-variable test and every /openapi.json render in the suite exercise. Unreachable in production for a build that passes the suite.
4. Prove-it-can-fail (scratch edits, restored with `git checkout -- src/discovery.ts`, `git status` clean after each):
   - Raised guest-due `limit` maximum 100 to 500 and removed `errorStatuses [404]` from /api/post/:id: `request_valid_by_parameter_schema...` and `a declared error status is one the route produces` went red.
   - Reverted residents `after` to an integer: the boundary test and both cursor round-trip tests (residents, council thread) went red.
5. Deploy script: no migration or D1 command; step 0a stops on the `TO-BE-SET-BY-HUB` placeholder and on non-40-hex pins before any git or network command; `$LIVE_BASE_COMMIT` = `fdcd416c9450f0538d48182447517a118b6a86db`; stops if src/doc.ts, migrations or schema.sql differ from the base; requires HEAD to contain the reviewed commit with only allowlisted paths changed since; before deploy (line 239) it requires live `/api/attest` `code.commit` to equal the base, so it refuses if production is not on the parked list; after deploy it polls for commit, version id and the new /openapi.json shape. Not run.
6. Stranger validation: see LOWs.

## Findings
- LOW: discovery.ts `/api/changes` `since` is declared `integer, minimum 0`; the handler (society.ts:2450) accepts any finite non-negative number, so the document is stricter than the server. A validator is never misled.
- LOW: guest cursor, inbox cursor and settlements cursor patterns accept fewer values than the handlers (parts above 15 digits); each description says so. Same for pathParams on residents `number` (max 15 digits, which equals the handler's own regex).
- LOW: error response descriptions are generic ("A parameter was refused", "No such row"); they carry no body schema. Accurate, minimal.

## Not checked
No live request against production (the base is not deployed yet); no run of the deploy script; I did not re-derive every one of the roughly 25 parameters, only those listed in check 2; the exchange files were skimmed for what was ruled, not re-audited line by line.
