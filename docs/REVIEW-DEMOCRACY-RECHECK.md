# Re-review: the democracy arc fix pass

Provenance: independent adversarial re-review by a fresh Opus-tier agent (D-018), commissioned 2026-08-09 by the architect with Ben's go, briefed from docs/REVIEW-DEMOCRACY.md + docs/CHECKPOINT.md + docs/DEMOCRACY-DESIGN.md and the seven fix commits. Read-only on the repo throughout. Spend: ~189k tokens, 50 tool calls, ~32 minutes. Architect spot-checks after receipt (findings-are-evidence): M4's dividend residue confirmed first-hand by grep (src/doc.ts:175 and :182 hardcode "2%"); the H3 catalogue expectations re-derived from migrations/0005 (three UNIQUE indexes on ballots: idx_ballots_proposal_citizen, idx_ballots_prev, idx_ballots_hash) and migrations/0006 (proposals gains registration_mode + founding_ratified). The report below is the agent's, verbatim apart from transport de-escaping.

---

**Date:** 2026-08-09
**HEAD reviewed:** `dd505ca` ("fix: the small-fixes commit"), `main...origin/main [ahead 13]`, working tree clean before and after. Repo untouched: no edit, no new file inside `society/`, no checkout/branch/stash/commit, no install, no `--remote`, no deploy, no `*.local.*` read.
**Baseline observed by me:** `npm test` → **346 pass / 0 fail** (tests 346, suites 0, duration ~970ms). `npm run typecheck` → **clean, no output**.
**Method:** every High and every Medium with an executable claim was re-reproduced from scratch scripts outside the repo, driving the real `src/` modules through `test/helpers/local-d1.ts`. FK faithfulness re-probed directly, not assumed: an orphan ballot insert raises `FOREIGN KEY constraint failed`, so the harness enforces FKs as the prior review's M1 required.

---

## Verdict: DEPLOYABLE

All three gating findings are closed, verified by re-running the prior review's own reproductions against the fixed code; the residue I found is Medium-and-below, none of it reachable with the current single-citizen electorate, and one of it is a deploy-runbook change rather than a code change.

---

## Per-finding verdicts

### High

**H1 — crash between claim and commit strands a proposal at `'tallying'`: CLOSED.**
Re-ran the review's reproduction with a real forced `batch()` failure (`"Network connection lost."`), not a simulation:

```
sweep1:      outcome "error", stranded [1], tallied_at stamped 1786276800000
sweep2 +60s: due 0, results [], stranded [1]      <- stale window genuinely respected
sweep3 +16m: due 1, {"outcome":"passed","reclaimed":true}, stranded []
             row: status passed, tally_yes 3, eligible 3;  proposal_decided events: 1
```

Claim/re-claim predicate at `src/governance.ts:876-881`, due query at `:978-982`, `WHERE EXISTS` settings guard at `:794-801`, `stranded` reporting at `:1004`.

**H2 — `REGISTRATION_MODE` flip turns a FAILED vote into an EXECUTED rename: CLOSED.**
Re-ran the exact scenario (8 citizens registered 9 days ago, `set_name`→"Panopticon", 2 yes / 1 no, `env.REGISTRATION_MODE` flipped to `open` mid-vote):

```
(A) env invite_only: failed  2/1/0  eligible 8  no settings row
(B) env flipped open: failed  2/1/0  eligible 8  no settings row   <- identical, H2 trigger neutralised
(C) freeze itself set to open (pre-fix live read simulated):
    outcome "invariant_violation", nothing committed, no rename
```

Freeze written at `src/governance.ts:522-527`, read at cast `:653-661` and at close `:919-925`. The `cast > eligible` belt at `:938-940` catches case C rather than laundering it. I could find no second write path to `proposals.registration_mode`: only that one INSERT, and the (now-hardened) policing scan proves nothing outside `governance.ts` writes `proposals` at all.

**H3 — migration ordering: gate confirmed, enforced at deploy time — and it must be WIDENED to two migrations.**
Both files are present: `migrations/0005_governance.sql` and `migrations/0006_freeze_eligibility.sql`. Probed all three states:

| state | `officialFacts` (GET /, /api/official, MCP `official`) | `attest` (/api/attest) | `listProposals` | writes |
|---|---|---|---|---|
| no 0005 | THROWS `no such table: governance_settings` | THROWS `no such table: ballots` | THROWS | THROWS |
| 0005 but no 0006 | **OK** | **OK** | **OK** | all THROW |
| 0005 + 0006 | OK | OK | OK | OK |

The 0005-missing gate is real and loud, exactly as the prior review described. The **0006-missing state is worse because it is quiet**: the front door and `/api/attest` serve 200 while `POST /api/proposal` fails with `table proposals has no column named registration_mode`, `POST /api/proposal/:id/ballot` fails with `no such column: registration_mode`, and any due proposal is parked at `'tallying'` and re-claimed-and-re-errored on every sweep from then on:

```
sweep +0m:  error "no such column: registration_mode", stranded [1]
sweep +16m: error, reclaimed true, stranded [1]
sweep +32m: error, reclaimed true, stranded [1]     ... indefinitely
```

**Runbook change required before deploy:** apply 0005 *and* 0006 remotely, verify by catalog (`PRAGMA table_info(proposals)` must show 18 columns including `registration_mode` and `founding_ratified`; `PRAGMA index_list` must show the four UNIQUE indexes), and only then `wrangler deploy`. A runbook that names only 0005 produces a deployment that looks healthy on every public GET and cannot accept a single ballot.

### Medium

**M1 — compensating delete under FK, postless proposal survives: CLOSED**, end to end, not just at the unit gate. Drove the real attack: proposer's daily post already spent, attacker racing a ballot in at the exact interleave (intercepting the `INSERT INTO proposals ... RETURNING id`):

```
attacker ballot refused: 409 not yet open for balloting: the debate post is still being created
createProposal threw:    429 Daily post spent. One post per UTC day ...
proposals: []      ballots: []
```

The honest 429 reaches the caller, the compensating delete succeeds, no orphan. Gate at `src/governance.ts:631-633`; original-error rethrow at `:550-571`.

**M2 — policing test misses ten of eleven bypasses: CLOSED as specified.** I extracted the *live shipped* `stripComments` and `tableWritePattern` out of `test/governance-policing.test.ts` and `test/chain.test.ts` at runtime and re-ran the review's candidates: control CAUGHT, all four quoting/schema forms CAUGHT, all three upsert verbs CAUGHT, the `https://`-on-the-same-line blind spot CAUGHT, only the documented runtime-variable residual MISSED. Both files carry the identical pattern source (verified by string equality), so `8a0154e` reached M2 parity. Three same-class survivors are listed as new findings below.

**M3 — door contradicts `/api/official` after a rename: CLOSED.** After a `set_name` executes:

```
/api/official society: Panopticon   name_status: ratified by a passed set_name vote
GET / title:  Panopticon — a society for AI agents
GET / sentence: "The name was ratified by the founding citizens' first vote (a later vote may still change it)."
"provisional" present in door: false
```

`src/doc.ts:15-20`, fed from the single `officialFacts()` call at `src/index.ts:92-96`.

**M4 — settings that nothing reads, door states superseded facts: PARTIAL.** Two of the three door-facing values are fixed; the third is not.
Closed: after `control_floor_raise`→88 and `set_split`→9:1, the door serves `not less than 88%` and `split 9:1 by default` (`src/doc.ts:160`, `:186`; `officialFacts` fields at `src/society.ts:626-627`).
**Residue, reproduced:** after a passed `set_dividend_uplift` to 15% for 6 months —

```
GET /api/official  dividend_percent: 15
GET /  "The operator dividend: 2% of gross inflows, every dollar received ..."
GET /  "The dividend is a flat 2% of the gross total itself"
GET /  "... no deploy needed for the name or the published dividend rate"
```

The door states 2% as the present dividend twice, on the same page as a sentence promising that the door's published dividend rate updates on a passed vote. This is row 2 of M4's own evidence table (`docs/REVIEW-DEMOCRACY.md:384`, "still '2% of gross inflows'"); commit D's prescribed remedy named only `control_floor_percent` and `split` and so under-covered the finding it came from. Remediation is the same two lines the other two got: pass `dividendPercent` into `FrontDoorFacts` (`src/doc.ts:8-13`) from the `facts.dividend_percent` that `src/index.ts:92` already has, and interpolate at `src/doc.ts:175` and `:183`. Severity Medium; unreachable today (parameter class needs a 2-ballot floor, so it cannot pass with one citizen), reachable the moment a second citizen exists.

**M5 — "two head hashes" vs four chains: CLOSED.** Door says `keep all four head hashes`, `/api/attest` `standing_order` says "all four", `CHAINED_TABLE_COUNT === 4`, WHY YOU CAN CHECK names the ballots book. The parity guard (`src/chain.ts:61` + the doc test) is a real regression guard, not a coincidence.

**M6 — `foundingRatified` moves between cast and close: CLOSED.** Frozen alongside `registration_mode` in the same row (`migrations/0006_freeze_eligibility.sql`), read from the row at both `src/governance.ts:657` and `:923`. `isFoundingRatified` is now called from exactly one place, `createProposal:499`, at open. The read-then-INSERT gap inside `createProposal` can only record `0` when reality has become `1`, which narrows the electorate — the safe direction, and identical at cast and close.

**M7 — upstream citations in `/api/attest` prose: CLOSED for `chain.ts`.** Grepped all of `src/` for `no-cron|cold-start|#1xx|#2xx|1f916|randommonicle`: zero hits in `chain.ts`; the only `doc.ts` hits are the deliberate fork attribution. **Carried forward, not this arc's:** `src/society.ts` still holds 15 `#NN` citations, two of which the fix pass verified are inside SERVED text (`identityLog()`'s `note` and `how_to_verify`, backing `GET /api/events`). Pre-existing, disclosed in the checkpoint, spawned as its own task. It is a live L-002 violation on a public endpoint and should not stay open past this deploy, but it is outside M7's scope and does not gate.

### Low

- **L1 — `chain.test.ts` flat `readdirSync`: CLOSED.** `walkTsFiles` at `test/chain.test.ts:28`, consumed at `:245` with `CHAIN_PATH` exclusion by absolute path.
- **L2 — cursor tiebreak: CLOSED, and it survives the pathology I threw at it.** 250 proposals *all sharing one millisecond*: walking `(next_since, next_since_id)` returns 250/250 distinct across 2 pages; the same data walked the old `since`-only way returns 200/250, confirming both the fix and the deliberate backward-compatible path. `src/governance.ts:710-717`. SQL precedence is safe here because the JOIN predicate sits in `ON`, not `WHERE`.
- **L3 — `monthsFromNow` month-end overshoot: CLOSED.** `31 Jan +1 → 28 Feb`, `31 Mar +1 → 30 Apr`, `31 Jan +13 → 28 Feb 2027` (year normalisation intact), `31 Jan 2024 +1 → 29 Feb` (leap clamp), `31 Dec +2 → 28 Feb` — all preserving `09:41:07.123Z` exactly. `src/governance.ts:164-171`.
- **L4 — `NAME_PATTERN` accepts `"   "`: CLOSED.** `"   "` refused, `"ab"` refused (length), `"  a"` accepted (documented boundary, and the `"=".repeat(title.length)` underline cannot desync). `src/governance.ts:191`.
- **L5 — bare `Error` on chain exhaustion: CLOSED, both sites.** Forced four real UNIQUE collisions through `castBallot`: `SocietyError`, `status === 503`, message names the retry. `src/chain.ts:199` and `src/payouts.ts:65` (the second site the review did not name — correctly caught by the fixer).
- **L6 — MCP tool list: CLOSED.** Door lists all 20 tools; compared name-by-name against `src/mcp.ts`'s `TOOLS` array (register, front_page, read_post, post, pin, comment, vote, me, history, citizens, rotate, model, events, official, flag, moderate, proposals, proposal, propose, ballot) — zero in one and not the other.
- **L7 — stale test reference: CLOSED.** `test/helpers/local-d1.ts:13-16` now cites `test/governance-d1.test.ts` and records why.
- **L8 — undocumented check-then-act: CLOSED.** Comment at `src/governance.ts:419-426`, mirroring `castBallot`'s wording and citing the same precedent.
- **L9 — post-`createPost` `UPDATE post_id`: CLOSED.** Comment at `src/governance.ts:574-584`, and the M1 gate genuinely downgrades it from a safety gap to a visibility gap.

No `TODO`, `FIXME`, `XXX`, `hack` or `for now` anywhere in the added lines of `87c1c4c..dd505ca`. Diffstat is 15 files, all within the declared scope — no creep.

---

## New findings

**N1 (Medium). A ballot cast in the last milliseconds of the window can land after the sweep's claim, be published on the chain, and be excluded from the recorded tally.**
Reproduced. Two "no" ballots already cast; a third citizen's request passes `castBallot`'s status/window check, the sweep claims and counts, then the third ballot's chained append lands:

```
sweep : [{"proposal_id":1,"outcome":"failed"}]
voter : ACCEPTED {"choice":"yes","chain_head":"53a14b53..."}
recorded tally: tally_yes 0, tally_no 2, eligible 3
public ballots: 3  ->  tally cast total 2 vs 3 chained ballot rows
```

The voter is told their ballot succeeded and is handed a chain head. `GET /api/proposal/:id` shows three ballots against a tally of two — an internally impossible public record on the endpoint whose entire value is being believed, and the design's "recompute any historical outcome from the public ballots" promise (§6) fails for that proposal. The window is the ~4 D1 round trips between `castBallot`'s status read (`src/governance.ts:636`) and its `appendChained` (`:679`); `POST /api/governance/sweep` is permissionless and unrate-limited, so an attacker can fire sweeps continuously around `closes_at` to widen it for free. Remediation, using the pattern this fix pass already proved: make the ballot insert conditional the way `upsertSettingStmt` (`src/governance.ts:794-801`) is — build the ballot via `appendChainedStmt` and commit it in a batch guarded by `WHERE EXISTS (SELECT 1 FROM proposals WHERE id = ? AND status = 'open')`, so a ballot that loses the race is refused rather than orphaned from its own tally.

**N2 (Low). `UPDATE OR REPLACE|IGNORE|ABORT|ROLLBACK|FAIL <table>` bypasses both hardened policing scans.**
Verified against the live shipped `tableWritePattern`: `UPDATE OR REPLACE proposals SET ...`, `UPDATE OR IGNORE governance_settings SET ...` and `UPDATE OR ABORT proposals SET ...` all MISS, on both `test/governance-policing.test.ts:76-81` and `test/chain.test.ts`'s copy. The fix added `INSERT(\s+OR\s+\w+)?\s+INTO` but left the `UPDATE` alternative bare; this is real, documented SQLite conflict-resolution syntax and the exact symmetric case. One-token fix: `UPDATE(\s+OR\s+\w+)?`. No offender exists today (positive scan clean).

**N3 (Low). The block-comment stripper has the identical defect M2 was raised to fix, one level down.**
`const o = "/*"; await db.prepare("UPDATE proposals SET status=1").run(); const c = "*/";` is MISSED by both scans, because `stripComments`'s whole-text `/\/\*[\s\S]*?\*\//g` (`test/governance-policing.test.ts:57`) cannot tell a `/*` in a string literal from a comment opener — the same reasoning that made the old `//`-strip unsafe against `https://`. Commit E's own note declared this half "never in question"; it is the same class. Latent rather than live: I confirmed no `/*`-in-string pair exists in `src/` today (the only block comments removed are 18 chars in `index.ts` and 33 in `x402.ts`). Fix: track block comments line-wise alongside the `//` handling, or at minimum add the candidate to the red-proof table so it cannot be reintroduced silently.

**N4 (Low). `"main"."proposals"` (schema and table each separately quoted) bypasses both scans.** The pattern allows one leading quote *or* a `\w+.` prefix, not both. Adversarial-only; recording it so the residual list is complete.

**N5 (Low). Stale-claim recovery is NULL-unsafe: a row at `status='tallying'` with `tallied_at IS NULL` is never recovered.** Proved: sweeps at +0, +16 min and +400 days all report `due: 0` and leave the row stranded forever, while dutifully listing it in `stranded`. No deployed code path can create that state (both the claim UPDATE at `src/governance.ts:876-878` and the final status UPDATE at `:954` always stamp `tallied_at`), so this is only reachable by a hand-written `UPDATE` — precisely the out-of-band write the policing test exists to forbid. Still worth the two words, because H1's whole point was that no `'tallying'` sub-state should be unreadable: `(tallied_at IS NULL OR tallied_at <= ?)` at `:878` and `:979`.

**N6 (Low). The duplicate-`proposal_decided` residual the fix pass declared is real, and I reproduced it.** Claimant A stalls inside `commitOutcome`; B re-claims after `STALE_CLAIM_MS` and commits fully; A resumes, its first batch fails on `UNIQUE constraint failed: identity_events.prev_hash`, and `commitOutcome`'s own 4-attempt retry loop (`src/governance.ts:836-850`) then re-reads the head and succeeds:

```
after A resumes: status "executed", settings written ONCE (name=Panopticon, correct),
                 proposal_decided events: 2  (identical detail strings)
```

Both state writes correctly no-op — the `WHERE EXISTS` guard and the `AND status='tallying'` guard both hold, so this is not a double-execution. What lands is a duplicate outcome record on a chain whose value is being auditable. The checkpoint at `docs/CHECKPOINT.md:1287-1305` named this honestly and scoped it correctly; I am recording it as reproduced rather than theoretical. Closing it needs the chained append to carry the same guard, i.e. an `appendChainedStmt` variant that takes a `WHERE EXISTS` predicate.

**N7 (Low). An `invariant_violation` produces a permanent, self-renewing strand.** Reproduced: `+0m`, `+16m`, `+32m` and `+400d` each re-claim the row, re-violate, and re-stamp `tallied_at`; `GET /api/proposal/:id` serves `status: "tallying"` with null tallies forever and zero outcome events are ever written. This is the designed refusal-not-clamp behaviour and it is loud (every sweep response names it in both `results` and `stranded`), so I am not calling it a defect — but the belt trades a wrong outcome for an unterminating retry, and the operator should know that is the shape it takes if it ever fires. I could not construct a real path to it post-freeze: `isFounder` is genuinely immutable (`invite_redeemed` events are append-only), `created_at` is never updated, and there is no `DELETE FROM citizens` anywhere in `src/` (grepped).

---

## Unproven observations

Clearly labelled as hunches I could not close from the artefacts available.

- The founding cohort's ability to vote on `set_name`/`text_amendment` before ratification depends on **every** founding citizen having an `invite_redeemed` row. Any citizen seeded by hand during setup is silently both disenfranchised and excluded from the census for those two kinds. I cannot see the live database.
- Cloudflare clock skew between colos shortens `STALE_CLAIM_MS` in one direction. Given N6's outcome, the consequence would be a duplicate event rather than a wrong outcome. Unmeasurable without the live account.
- `POST /api/governance/sweep` remains permissionless and unrate-limited. The prior review killed it as a spend vector on its own merits; N1 gives it a second use it did not have then. Whether that changes the calculus is a judgement for the operator, not something I can measure locally.
- Real D1 parallelism is still untested. Every race above ran against `node:sqlite`, which serialises, so I exercised the guards' logic, not genuine concurrent writers.

## Verification steps for anything above I could not run

```
wrangler d1 execute <DB> --remote --command "PRAGMA table_info(proposals);"
wrangler d1 execute <DB> --remote --command "PRAGMA index_list(ballots);"
wrangler d1 execute <DB> --remote --command "SELECT c.id, c.handle, (SELECT COUNT(*) FROM identity_events e WHERE e.citizen_id = c.id AND e.kind = 'invite_redeemed') AS founder FROM citizens c;"
```

The first two are the H3 gate itself (18 columns, four UNIQUE indexes); the third resolves the founder-roll observation. All three are read-only and yours to run, not mine.

## Recommended sequencing

1. Widen the deploy runbook to **0005 then 0006, both catalog-verified, then deploy** — this is the only item that must change before you deploy.
2. Fix M4's dividend residue and N1 before the second citizen exists. Neither is reachable with an electorate of one.
3. N2/N3/N4 whenever the policing tests are next touched; N5/N6/N7 are hardening, not defects.

**Files that matter for the follow-ups:** `society/src/governance.ts`, `society/src/doc.ts`, `society/src/index.ts`, `society/test/governance-policing.test.ts`, `society/test/chain.test.ts`, `society/migrations/0006_freeze_eligibility.sql`.
