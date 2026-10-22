# D-018 gate (text-only, Sonnet tier): privacy page wave, 2026-10-21

Scope: `d44ac2cc..5bc3a8ce` on branch privacy-page-2026-10-21 (GET /privacy, ROUTES/OpenAPI, /skill.md 1.4.3, /llms.txt, served-text consistency fixes, scripts/deploy-privacy.ps1).

## Verdict: DEPLOYABLE WITH CONDITIONS (HIGH 0, MEDIUM 0, LOW 2)

## Evidence
- `npm test`: 2693 tests, 2692 pass, 0 fail, 1 skipped. `npm run typecheck`: clean.
- Money path: diff touches no x402.ts, payouts.ts, settlement*.ts, listings.ts. Only wording in discovery-data.ts, discovery.ts, inbox.ts, mcp.ts, showhome.ts, index.ts (one GET route).
- Non-minting: src/doc.ts, migrations/ and schema.sql are absent from the diff. FRONT_DOOR_TEMPLATE untouched; no mint.
- Deploy script: worker-only (`npx wrangler deploy --var CODE_COMMIT:<sha>` is the only wrangler use), no migration or D1 command; -ExpectedCommit mandatory, -DryRun present (exits before deploy); step 0a refuses while either pin is a placeholder or malformed; step 0b (contact gate, deploy-privacy.ps1:145) STOPS on `PENDING-CONTACT` in src/privacy.ts, before any git or network call; test/deploy-privacy-script.test.ts:164-170 proves it fires on the real file and passes on a filled copy. Ride is public GETs only; rollback target read live.
- Factual spot checks of served policy (all match): 100% sampling wrangler.jsonc:10; crons 06:00 daily and weekly 07:00 (wrangler.jsonc:70); showhome rings 1000/200/600 (showhome.ts:46-47,62); council proof body cap 2000 (council-core.ts:41); rate hash is `sha256("showhome:"+ip)`, no secret salt (showhome.ts:178); rate rows pruned opportunistically on write, not by timer (showhome.ts:213; reg_log society.ts:777); auth_nonces pruned on later operation (society.ts:659); council_challenges pruned on later operation (council.ts:428); Anthropic URL (maintainer/anthropic.ts:58); 1f916.ai proof fetch (council-verify.ts:3-4); RPC list (society.ts:2497); no cookies (index.ts:151); notes pruned by id offset, no citizen/ballot deletion path found; guest ring eviction before first comment (guest-core.ts:573).
- Cross-surface contradiction sweep (never logged, erased, tombstone, content gone, request log, few days): none remain. The inbox/guest notes, mcp moderate description and showhome stats note were corrected and now agree with /privacy.

## Conditions
C1. Before deploy, PRIVACY_SLOTS.CONTACT must hold Ben's real address (gate enforces; UK GDPR Art. 13), re-reviewed, committed, and `$REVIEWED_COMMIT` set by the hub.
C2. The policy is the operator's legal statement (Cloudflare retention, transfers, lawful basis are Ben's rulings, flagged as unverified in the text). Ben to read it once as controller before it goes live.

## Findings
- LOW-1: weekly cron is `0 7 * * 1` (wrangler.jsonc:70); policy says Sundays. Correct only if Cloudflare numbering applies (1 = Sunday); already the project's recorded convention. Confirm on the live trigger list.
- LOW-2: policy sentence "Rate-limit hashes ... removed by a later operation" holds for showhome_rate and reg_log; not individually verified for every rate table (HW5 inventory at showhome.ts:222 lists the paths).
