# Sonnet gate: the 14 Oct seat counts wave

Reviewed HEAD: f1803aa1b71464cc569ae739b7252321746c9e97 (branch seat-counts-2026-10-14, base cfa70103). Tests seen: npm test 2571 tests, 2570 pass, 0 fail, 1 skipped; npm run typecheck clean.

## Verdict: DEPLOYABLE (no conditions). HIGH 0, MEDIUM 0, LOW 6.

Class check: diff touches no money route, auth path, write path, migration, schema.sql, wrangler.jsonc or cron. src/doc.ts hunks are only @@617 (type) and @@629 (fallback line), both inside compositionDoorNote, far from FRONT_DOOR_TEMPLATE (src/doc.ts:164-~555); the v5 pin test passes. Scripts: only deploy-seat-counts.ps1 (new) and the A7 early exit in deploy-composition-split.ps1.

## Questions
1. Figures: act_capable = citizenTotal - keyLost (society.ts:1742); operator_paid = Set of opRows + sponsored handles (society.ts:1744), a union not a sum; acted_30d = citizenWritersSince(db, windowStart, []) (council.ts:228), a COUNT over citizens with EXISTS, so a union of the six arms. Both counts take windowStart from ONE now (society.ts:1626-1629), same SQL text. Failure gives null (society.ts:215-222 try/catch, council.ts:243 typeof guard), never 0, never 500. Empty exclusion leaves out NOT IN (council.ts:230).
2. Served sentences read true; singular/plural right; null said plainly. See L1, L2.
3. Alias: one closure treasuryPage (index.ts:233-236), same parseLedgerCursor; `await` keeps SocietyError inside the try; T5 compares bodies byte-for-byte incl. refused half cursor. Drift guard goes red without the line (reproduced).
4. Consumers of independent: no arithmetic on it in src/, scripts/ or MCP (grep). Only readers are tests (.count) and deploy-seat-counts. deploy-composition-split.ps1 exits 1 at its first statement after param(), before any git/npm/wrangler.
5. Red-proofs reproduced on a throwaway copy: (a) acted_30d given its own Date.now() reds A3 only; (b) deleting the /api/treasury dispatch line reds the drift guard and both T5 tests; (c) operator_paid as a plain sum reds the overlap test. Narrowed guards: council-served-text keeps the "no council in composition" check apart from acted_30d provenance (honest); guest-surfaces see L5.
6. Deploy script: step 0a stops on either placeholder before any git/network; live base proved against /api/attest; migrations/schema.sql diff stops; no D1 command; one wrangler subcommand (deploy); ride is GET-only; the three-read retry keys on "composition.acted_30d is ''" which Test-SeatCountsServed produces for a null (checked by reading), a persistent null stops; rollback target is read from live code.version_id. Not run.

## Findings
- L1 (LOW) society.ts:1746-1749, discovery.ts:623-625, society.ts:2265: the note, llms.txt and citizens note say flatly "the operator paid for N" and "can still act", while provenance rests operator_paid on the operator's lists and act_capable on a holder report. Scenario: a reader excerpts the note and takes the paid count as verified. Mitigated by "each defined in provenance". Suggest "(the operator's statement)".
- L2 (LOW) society.ts:1748: with acted_30d null the sentence runs on ("12 can still act, how many wrote ... was unreadable for this response, and the operator paid for 12"). True, clumsy.
- L3 (LOW) society.ts:264-276: act_capable and operator_paid carry source ["arithmetic"] though inputs are holder_report / operator lists; the check text discloses it and the brief ruled it, but the tag is weaker than the basis; deploy-seat-counts.ps1 pins "arithmetic".
- L4 (LOW) test/deploy-seat-counts-script.test.ts:617-625: the ride's retry loop is asserted by source text only, not executed; I read it and it is correct.
- L5 (LOW) test/guest-surfaces-d1.test.ts:57-60: the note is now excluded from the byte-identity compare (only the acted sentence is asserted), so unrelated note drift in that scenario goes unseen.
- L6 (LOW) acted_30d counts scripted operator writes (daily loop comment, maintainer guest answers), so "wrote" is not "decided"; the operator split sits beside it as outside_writers_30d. Brief-ruled. Also: the two counts are separate queries, so a moderation between them could make outside > acted and the ride would stop with the rollback line (negligible), and a registration between the pre-read and the ride trips the snapshot check (pre-existing pattern).
