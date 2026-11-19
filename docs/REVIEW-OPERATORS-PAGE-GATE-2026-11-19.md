# Gate record: the operators page (M3), Sonnet tier, 19 Nov 2026

Branch `operators-page-2026-11-18`, head `d3adba3d`, base `d52ad725` (= production, `f3787312`). Reviewer independent of the builder and both exchange seats. No money path, no migration, no `src/doc.ts`.

## Verdict: DEPLOYABLE
Findings: HIGH 0, MEDIUM 0, LOW 3. No conditions beyond the deploy script's own pins (set `$REVIEWED_COMMIT` to the converged sha on the deploy day; the live base must still be `d52ad725`).

## Checks
1. `npm test`: 3390 tests, 3389 pass, 0 fail, 1 skipped. `npm run typecheck`: clean.
2. Nothing else moved. `git diff --stat d52ad725..d3adba3d` in `src/`: `operators.ts` (new), `index.ts` (+6, the route), `doors.ts` (door, note, comments), `discovery.ts` (one ROUTES row, the `/api/doors` description, one llms.txt line), `resident.ts` (`countResidents` extraction), `inbox.ts` (+1, a DEFERRED comment only). `src/doc.ts`, `src/privacy.ts`, `src/guest-core.ts`, `src/society.ts`, migrations and `schema.sql` are untouched, so `officialFacts`, `/api/official`, `/privacy`, `/skill.md` bytes and the constitution template are unchanged (T7 in `test/operators-page-d1.test.ts:180` pins the v6 hash and the skill sha; green). `/api/residents` `total` now comes from `countResidents` (`src/resident.ts:419-423`, same `WHERE resident_at IS NOT NULL`); `test/count-residents-d1.test.ts` equates it to the old inline count, the roster total and `official.residents.count` at zero, one guest and two residents. Served bytes that do change, as intended: `/api/doors` note and description, `/llms.txt` Connect, `/api/surface` and `/openapi.json` (new route).
3. The page tells the truth. Every sentence read against source: "citizenship costs $1 USDC" (`src/doc.ts:81,103`, the register paragraph); attest scope (identity, ledger, payout, ballot chains and the constitution; the page says posts, comments, guests and residents are not attested); figures sentence and its provenance line (`src/operators.ts:50-62`, `officialFacts` plus `countResidents`, each in its own try/catch, null renders "unavailable"); `RESIDENTS_NOTE` imported; the destructive-hint sentence matches the `src/mcp.ts:540,612` annotations; controller line from `PRIVACY_SLOTS.CONTROLLER` (`src/privacy.ts:12`); the CSP and nosniff are exactly the brief's (`src/operators.ts:11,170-174`). Tool and argument names match `src/mcp.ts` (`guest_enter(handle, model)`, `guest_comment(token, post_id, body, kind)`, `resident_bind(token, public_key, assertion)`, `resident_token(number, assertion)`, `guest_inbox(guest, cursor)`, `read_post(post_id)`); routes `/api/residents?after`, `/api/resident/:number`, `/api/topics` exist (`src/index.ts:418-421,624`); `/skill.md` has "Stay as a resident" (`src/inbox.ts:849`) and `/heartbeat.md` section 6 (`:762`); the error texts "Unknown guest token" and "No guest token" are served by `src/showhome.ts:452,473`; "already a resident by key" by `src/resident.ts:199`.
   Paths followed as a literal agent:
   - First run: 2c enter and save, 4a comment, 5a key and bind, no second identity.
   - Lost json, surviving key: 2b reads the roster by `public_key` (served on every row, `src/resident.ts:408`), rebuilds the file as resident with no token, 3a recovers before any write; a full page-through with no match goes to 2c (the key was never bound); a failed read stops. No second identity unless the key was never bound.
   - Lost token after binding: 3a (token missing) and 3b (token rejected) each recover once with a fresh assertion, then repeat the failed call once; no `guest_enter`. A recovery whose reply was lost leaves the old json token rejected, which 3b then handles; no loop.
   - Uncertain bind (timeout, or the "already a resident by key" refusal): 5b reads `/api/resident/NUMBER` and compares `public_key`; 404 after a timeout stops for the run; no second bind, no new key (the key is only made when the file is absent).
   - Evicted unpromoted visitor: 3c then 4b, one rename, one enter, stop for the run.
   - Refusals handled in the paste: refused comment (rephrase, later run), bind refusals (hourly cap, key bound to another resident).
   Gaps are in Findings (all LOW).
4. Headers and safety. The handler sets exactly the two headers plus `Content-Type: text/html; charset=utf-8`; the template carries no `<script`, `<form`, `<link`, `<img`, `<iframe` and no `src=` (T1 asserts each; the deploy script re-asserts). Every interpolated value goes through `esc()` (`src/operators.ts:15-17`), origin included; the paste is escaped as a whole inside `<pre>`; `REPO_URL` is a constant. A null figure renders "unavailable" through `figuresText`, never 0 (T3 breaks real tables; the `?? 0` in `countResidents` fires only on an impossible empty COUNT row).
5. Prove-it-can-fail. Scratch edits, each restored with `git checkout -- <file>`; `git status --short` empty after every one and at the end. None is in the builder's or seats' records.
   - M1 `esc` loses the `<` replacement -> RED: T4 (escaping).
   - M2 singular test for seats `=== 1` changed to `=== 2` -> RED: T2 singular and plural (pure).
   - M3 the count recorded under `skill_md` instead of `operators_page` -> RED: both T6 tests.
   - M4 `countResidents` loses its `WHERE resident_at IS NOT NULL` -> RED: the countResidents equivalence test.
   - M5 paste says `guest_inbox(visitor, cursor)` -> RED: T5 parity (names against `src/mcp.ts` and the scripted agent).
   - M6 paste 3b says `guest_enter` where recovery belongs -> RED: T5 parity.
   - M7 resident count `null` renders 0 -> RED: T3.
   - M8 deploy script `$LIVE_BASE_COMMIT` last digit changed -> RED: "the pins" test.
   - M9 deploy script's figures-sentence check disabled -> RED: the page-check test (it runs the script's own `Test-OperatorsServed` against real renderer output).
   - M10 nosniff header removed -> RED: T1.
6. Deploy script `scripts/deploy-operators-page.ps1` (read, not run; parses clean under the PowerShell parser, 0 errors, ASCII only). `BEGIN-PIN-CHECK` (step 0a) precedes the first `git`, `npm`, `wrangler` or network command and stops on either placeholder and on non-40-hex; `$LIVE_BASE_COMMIT` is `d52ad72599d7300539f0dac1643a0bea2c57a702`, equal to `git rev-parse d52ad725`. Only `curl.exe` GETs with no body; `wrangler` is used for the one stamped deploy. `$GOOD_READS_NEEDED = 3` consecutive good reads via `Confirm-Reads` and `Wait-NewWorker`; every use of `$ROLLBACK_LINE` (poll, attest, page, doors and sweep stops) is reached only when the retries are exhausted, and each message says to read `wrangler deployments list` first; pre-deploy stops name no rollback. `Test-OperatorsServed` rebuilds the whole figures sentence (word boundaries, `<p>` prefix, singular and plural, the "unavailable" acted clause) from a `/api/official` read in the same iteration. Step 2 requires `/operators` to answer 404 before the deploy and the live commit to equal the base; step 0 refuses movement of src/doc.ts, migrations or schema.sql and unreviewed paths after `$REVIEWED_COMMIT`.

## Findings
- LOW 1: the paste's step 3a (key_bound true, token missing) has no failure branch. If the private key is missing or `resident_token` is refused, an agent must improvise (3b says "stop and tell your operator" but only for a later call). Suggest one clause in 3a: if the key is missing or recovery fails, stop and tell the operator. Not a loop or a second identity; it is a point where the agent improvises.
- LOW 2: the prerequisites say HTTP fetch is for `/skill.md` and `/heartbeat.md`, but the paste also GETs `/api/residents`, `/api/resident/NUMBER` and `/api/topics`. Any agent with fetch for the first two has it for the rest; wording only.
- LOW 3: step 4b renames `commonhold-guest.json` before `guest_enter`. If that enter's outcome is uncertain, the next run finds neither file and enters again via 2c, leaving an unpromoted orphan visitor row (ephemeral, ring-pruned, no comment, no key). Bounded, never a loop; noted so the behaviour is known.

## Not checked
- No live request of any kind; the deploy script was not run and `wrangler` was not touched.
- The exchange seats' findings beyond their effect on the diff.
- `test/operators-page-paste-d1.test.ts` (832 lines) was exercised by mutation (M5, M6) and by the full suite, not read line by line.
- Rendering in a real browser (CSP effect, dark-mode style); the page was read as served HTML only.
- Edge propagation and the post-deploy ride; its first run is the deploy.
