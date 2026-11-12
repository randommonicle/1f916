# D-018 gate (Sonnet tier): openapi proposal schema wave, 12 Nov 2026

Scope: `ba2934fd..24072be2` (754762bb code, 24072be2 deploy script and test). Read-only review; nothing deployed or run against production.

**Verdict: DEPLOYABLE** (HIGH 0, MEDIUM 0, LOW 2). No conditions.

## Checks

1. **Schema claims vs served bodies.** TRUE. `listProposals` (src/governance.ts:1253-1316) serves `decided_event_id_note` at top level and `id`, `status`, `decided_event_id` on every row (the `cols` select at :1277 carries all three). `getProposalDetail` (:1332-1352) serves `proposal.{id,status,decided_event_id}` and `ballots` (array of rows). The detail route does NOT serve the note, and the schema correctly omits it there. `nullable: true` on an integer is valid OpenAPI 3.0.3 and matches the NULL-while-open case. The only long served string is `DECIDED_EVENT_ID_NOTE`, imported (governance.ts:1321), not retyped, so it cannot drift from the existing pinned text. The one new hand-written string ("What decided_event_id on each row does and does not show.") makes no claim beyond that. test/openapi-response-schema-d1.test.ts walks the served schema against real served bodies (open and decided rows) and has a red-proof that the walker fails on a wrong `required`.
2. **Other readers.** `responseSchema` is optional and read in one place (`renderOpenApi`, discovery.ts ~:788); `renderSurface`, llms.txt and the MCP manifest do not touch it, so those outputs are byte-unchanged. No import cycle: only src/index.ts imports discovery.ts, and governance.ts does not import it. No src/doc.ts, migration or schema.sql change (`git diff --name-only ba2934fd HEAD -- migrations schema.sql src/doc.ts` is empty), so the v6 template hash is untouched. Existing openapi tests (discovery.test.ts, I4, C3, /privacy media type) pass.
3. **Deploy script.**
   - Pins: `git rev-parse` gives ba2934fda4f7a3f2599fe6d68ccfae39082cd95b (live base) and 754762bbda3da8340db2b94b18be50dcd17c4fd5 (reviewed); both match the script's `$LIVE_BASE_COMMIT` and `$REVIEWED_COMMIT` exactly.
   - `git diff --no-index` against deploy-judgment-refusal-skip.ps1 shows 33 insertions / 31 deletions: only the pins, allowlist, URL and marker, the served-check wording, the two new anchors, and the retained refusal-skip anchors reworded from "not the wave" to "would drop the wave". Nothing structural (step 0a pin check, level-commit check, clean tree, no-mint/no-migration diff, reviewed-source check, attest assertions, version-id poll, rollback line) was changed or lost.
   - Before-check: marker `decided_event_id_note` has 0 occurrences in ba2934fd's src/discovery.ts (the string exists only in governance.ts, which /openapi.json does not serve), so the live pre-state reads absent; a deployed worker makes `Test-RunsNoteServed` return "" and the script STOPS ("already deployed"). The marker also does not occur inside `DECIDED_EVENT_ID_NOTE`, so it cannot match through the description alone.
   - Poll and ride require code.commit AND code.version_id equal to the stamped deploy plus the marker in /openapi.json, so new code is proved live. `$ROLLBACK_LINE` is set before the poll. Exactly one wrangler deploy (script line 249; the other "wrangler" hits are text and a version-id message). The only HTTP client is `curl.exe` via `Get-Text`, GET only.
   - Both source anchors exist exactly once in discovery.ts.
4. **Allowlist.** `git diff --name-only 754762bb HEAD` lists exactly the script and its test, both allowlisted; `docs/` prefix is allowed. Anything else changing after 754762bb STOPS step 0. Correct.
5. **Suite.** `npm test`: tests 3110, pass 3109, fail 0, cancelled 0, skipped 1. `npm run typecheck`: clean (tsc, no output).

## Findings

- **LOW** scripts/deploy-openapi-proposal-schema.ps1 (`$RUNS_URL`, `$RUNS_NOTE_MARKER`, `Test-RunsNoteServed`): names still say "runs note" although they now test /openapi.json. Kept deliberately for mechanical derivation; a reader of the log lines will not be misled because every message was reworded. No action needed.
- **LOW** the script's `Test-RunsNoteServed` matches the marker as a substring of the whole body, not a path-scoped key. Safe today (marker absent pre-deploy, shown above); if a later wave serves that string elsewhere in /openapi.json, the before-check would misread as already deployed. It would fail safe (STOP), not ship.

## Conditions

None. Standard ride: `-DryRun` first, then the real run; rollback target is the version `/api/attest` serves before the deploy (read live by the script).

Not independently verified: live GET /openapi.json state (read-only, but not fetched here; the script's step 2 reads it).
