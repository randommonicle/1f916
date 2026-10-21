# Checkpoint: the privacy page (GET /privacy), 21 Oct 2026

Branch `privacy-page-2026-10-21`, cut from `d44ac2cc` (live worker `a925766c`). Commission: `drafts/BUILDER-COMMISSION-PRIVACY-PAGE-2026-10-21.md`. Text: `drafts/PRIVACY-POLICY-DRAFT-2026-10-21.md` verbatim, slots from `drafts/PRIVACY-POLICY-SLOTS-2026-10-21.md` (recommended defaults). Not merged, not pushed, not deployed.

Baseline in the worktree: 2673 tests, 2672 pass, 1 skip; typecheck clean. (The worktree must be checked out with `core.autocrlf=false` for the `.ps1` parse tests to pass; the global setting here is `true`.)

## Commit 1: the route, the module, the links

- `src/privacy.ts`: `PRIVACY_TEMPLATE` (the draft, `{{CONTROLLER}}`, `{{CONTACT}}`, `{{LAWFUL_BASIS}}`, `{{TRANSFERS}}`, `{{ERASURE_COMMITMENT}}`), `PRIVACY_SLOTS` (the ONE object to edit after Ben rules), `renderPrivacy`, `handlePrivacy` (200 `text/markdown; charset=utf-8`, the same single header `/skill.md` sets: neither sets CORS or a cache header).
- `src/index.ts`: the route beside `/skill.md`, not counted as a door.
- `src/discovery.ts`: the ROUTES entry (OpenAPI and `/api/surface` generate from ROUTES; no change needed there), and one line in the llms.txt "Manifest/OpenAPI/Full route list" block.
- `src/inbox.ts`: one line in `/skill.md` "Read, free, with no account". `renderSkillMd` lives outside `FRONT_DOOR_TEMPLATE`, so nothing mints (v5 unchanged; `src/doc.ts` untouched). **Decision for the hub:** a skill text edit forces a `SKILL_VERSION` bump (a sha pin in `test/inbox-d1.test.ts` and `test/guest-served-text-d1.test.ts` enforces it), so the skill is now **1.4.3**. ClawHub / registry listings carry the skill text: publishing 1.4.3 there is Ben's click-work if he wants the listing text to match. The `docs/HEARTBEAT-SKILL-TEXT.md` copy got the same line (a test compares it to the renderer).
- Pins moved with the bump: seven `1.4.2` assertions in the served-text tests became `1.4.3`; the council-flag deploy script's test now treats its `version: 1.4.2` marker as that wave's record (the same treatment the hardening script's test already had).
- `test/secret-literal-guard.test.ts`: the template says a citizen secret is "stored only as a SHA-256 hash and never shown", so it is a reviewed prose literal (one `PROSE_ALLOW` entry, baseline 80 / 24 / 56).
- L-002: grep of the new text for upstream names (1f512, 1f3d9, Athena, incident numbering) is a test; none present.

## Commit 2: tests (`test/privacy-page-d1.test.ts`, 5 tests)

Red-proofs, each run and restored:

| Mutant | Went red |
|---|---|
| router line reworded so `/privacy` is not dispatched | the 200/body test, the ROUTES grepFor test |
| `TRANSFERS` removed from `PRIVACY_SLOTS` (an unfilled slot) | the 200/body test, the "no `{{` survives" test |
| `/skill.md` link line deleted | the links test |
| llms.txt link line deleted | the links test |
| ROUTES entry deleted | the links test (`/api/surface`), the ROUTES test |

## Commit 3: the deploy script (`scripts/deploy-privacy.ps1`, `test/deploy-privacy-script.test.ts`, 7 tests)

Written, never run. Cloned in shape from `deploy-tool-counter.ps1` but lean: worker only, no migration, no D1, one executed wrangler command, `-ExpectedCommit` and `-DryRun`, `$LIVE_BASE_COMMIT = d44ac2cc...`, `$REVIEWED_COMMIT` holds the hub's placeholder. Step 0 also stops if `src/doc.ts`, `migrations/` or `schema.sql` moved since the live base. The ride (public GETs only) asserts `/privacy` is 200, `text/markdown`, starts `# Commonhold privacy policy`, has no `{{`; `/skill.md` says `version: 1.4.3` and points at `/privacy`; `/llms.txt` points at `/privacy`. The script's pin block and `Test-PrivacyServed` are run for real in the tests (they touch no git or network).

Red-proofs, each run and restored:

| Mutant | Went red |
|---|---|
| the `{{` check deleted from `Test-PrivacyServed` | the Test-PrivacyServed run test |
| the reviewed-commit placeholder check deleted | the step-0a test |
| a non-ASCII character added | the parse/ASCII test |
| a `curl -X POST` line appended | the order/GET-only test |
| a second `npx wrangler` (a D1 migration) appended | the order/no-D1 test |
| the ride's `Test-PrivacyServed $privacyNow` call replaced | the ride-checks test and the order test |

## Owed to the hub

Set `$REVIEWED_COMMIT` in the script after review. Ben's slot rulings: edit `PRIVACY_SLOTS` in `src/privacy.ts` (slot 2 needs GitHub Issues turned on first, or the page names a dead contact). Registry and ClawHub skill 1.4.3 publish if wanted.
