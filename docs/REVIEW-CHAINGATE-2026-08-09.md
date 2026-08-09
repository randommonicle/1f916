# Focused adversarial review: the chain-gate commit (a31a6b5)

Provenance: commissioned 2026-08-09 by the architect after the hardening pass, per D-018 (commit a31a6b5 modifies src/chain.ts, the append machinery behind all four public books). Fresh Opus-tier agent, read-only, ~118k tokens, 48 tool calls, ~15 minutes. Verdict: **SAFE TO DEPLOY, approve with changes (none blocking)**. The report below is the agent's, verbatim apart from transport de-escaping.

---

Baseline: HEAD `e589e56`, tree clean, repo untouched by this review. `npm test` = **352 tests, 352 pass, 0 fail** (846ms). `npm run typecheck` = exit 0. Scratch work under the session scratchpad only.

## Q1 — Ungated blast radius: no change, proven at two levels

Code level: the diff's non-gate branch in `src/chain.ts:216-224` is the pre-commit statement character-for-character. `appendChained` (`:191-207`) is untouched — same head-read SQL, same 4-attempt loop, same `String(e).includes("UNIQUE")`, same 503 text. `entryHash`/`PAYLOAD` untouched, so no hash-input change is even possible. The only new work on the ungated path is hoisting `cols.map(...)` into `const values` — a pure map, no side effects, same array.

Runtime level (spy over `prepare/bind`, all four tables): the ungated SQL and binds are identical to the pre-commit literal, e.g.

```
ungated : INSERT INTO ballots (proposal_id, citizen_id, choice, cast_at, prev_hash, hash) VALUES (?, ?, ?, ?, ?, ?)
gated   : INSERT INTO ballots (...) SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM proposals WHERE id = ? AND status = 'open')
```

with gated args = ungated args + gate args, in positional order, and the **same hash value** in both forms.

All three remaining ungated callers pass three arguments (`src/payouts.ts:47-48`, `src/society.ts:483`), so `gate === undefined` and they take the original branch. Nothing else imports `appendChainedGated`.

## Q2 — Gated semantics: sound on all three sub-questions

**(a) Refusal vs UNIQUE collision.** Distinguished by mechanism, not by string parsing: a collision *throws*, a refusal *returns*. Verified against workerd's real D1 (miniflare 5.20260730, the workerd version this repo pins), not just `node:sqlite`:

```
gate passes  -> {changes:1, changed_db:true,  rows_written:3, success:true}
gate refuses -> {changes:0, changed_db:false, rows_written:0, success:true}   <- no throw
UNIQUE       -> throws "D1_ERROR: UNIQUE constraint failed: t.prev_hash..."   -> includes("UNIQUE") = true
```

D1's return shapes cannot blur them. When *both* would apply (gate false **and** the row would violate UNIQUE), the gate wins silently — no insert is attempted, so no constraint is evaluated. That precedence is correct for N1.

**(b) Chain head after a refusal.** Genuinely undisturbed: 0 rows written, `prev_hash` not consumed, `sqlite_sequence` not advanced (`seq` stayed 1 after two refusals). An INSERT…SELECT is one atomic statement; there is no half-written row to leave behind. Confirmed end-to-end by the repro below — `attest` reports `ballots: verified` after a refusal followed by a real append.

**(c) Hash input.** Cannot differ: `entryHash` runs in JS before either statement form exists. Storage-level affinity also checked in case the *stored* row round-tripped differently and broke `/api/attest` — across number→TEXT, numeric-string→INTEGER, float→INTEGER, fractional float, and NULL, `VALUES` and `SELECT` store byte-identical values and `typeof()`s. CHECK constraints also still fire under the SELECT form.

## Q3 — Batch order at `src/governance.ts:883-890`: correct, and load-bearing

The three statements read the *same* predicate on the *same* variable: log gate `id = ? AND status = 'tallying'` (`:869`), settings upsert `WHERE EXISTS (SELECT 1 FROM proposals WHERE id = ? AND status = 'tallying')` (`:818`), status UPDATE `WHERE id = ? AND status = 'tallying'` (`:1027`) — all bound with the same `proposalId` (`:869`, `:1021`, `:1029`). No statement between the log and the status UPDATE writes `proposals`, so all three see one value inside the batch's transaction. There is no interleave where the gate passes and the state statements no-op, or the reverse: D1 batches are a single transaction and SQLite serialises writers, so a concurrent `commitOutcome` either commits fully or no-ops fully. Verified `batch()` returns per-statement meta in order under workerd (`[{changes:0},{changes:1}]`).

The commit's mutation claim is exactly right — reverting the ordering alone in a copied tree: **7 of 46 fail** in `test/governance-d1.test.ts`, including four pre-existing sweep tests, the H1 reproduction, the re-claim race, and N6's own.

## Q4 — Tests, plus one interleave the suite does not cover

| Run | Result |
|---|---|
| Full suite | 352 pass / 0 fail |
| `--test-name-pattern "N1\|N6"` | both pass (N1 19.5ms, N6 6.4ms) |
| `tsc` | clean |
| M1 batch order reverted | 39 pass / **7 fail** |
| M2 castBallot gate → tautology | 45 pass / **1 fail** (the N1 test only) |
| M3 commitOutcome gate → tautology | 45 pass / **1 fail** (the N6 test only) |

Neither test passes on broken code. **New adversarial interleave** (gate passes → UNIQUE → retry re-evaluates after the sweep claims), which neither committed test covers — the helper `withChainedHeadReadTriggering` fires once and passes retries straight through, so the retry-path gate was untested:

```
attempt0: rival ballot landed, our captured head is now stale   -> UNIQUE on ballots.prev_hash
attempt1: sweep ran -> [{"proposal_id":1,"outcome":"failed"}]
castBallot verdict: SocietyError 409: proposal 1 is no longer open for balloting...
proposal: {"status":"failed","tally_no":1} | public ballots: 1 | tally cast total: 1
victim's ballot rows: 0 | attest ballots chain: verified
```

Correct. Red-proved against M2: same interleave yields `ACCEPTED ... chain_head:db2d035d`, **2 public ballots against a tally of 1** — the exact N1 defect.

## Non-blocking findings

1. **A resumed stale claimant's sweep response publishes an outcome that was never committed.** `commitOutcome` discards `batch()`'s result, so `claimTallyAndExecuteOne` returns its own stale `finalStatus` (`src/governance.ts:890,1033`). Reproduced with a divergent tally (four citizens join during the stall, moving quorum): B (re-claimer) committed `failed`; A's sweep response reports `executed` while nothing was written. `POST /api/governance/sweep` states a `set_split` was executed when nothing was. Pre-existing (pre-fix the same interleave also wrote the lie to the chain, so this commit strictly improves it). Remediation: `const [logRes] = await env.DB.batch([log.stmt, ...stateStmts]);` at `src/governance.ts:890` and return a "claimed_elsewhere"-shaped outcome when `logRes.meta.changes === 0`.
2. **`commitOutcome` returns a phantom hash for a fully no-oped batch** — `return { hash: log.hash }` at `src/governance.ts:891` names a row that does not exist. Inert today (the only caller discards it). Same one-line remediation as (1).
3. **`meta.changes === 0` is the sole refusal signal and it fails open.** At `src/chain.ts:279`, if `changes` were ever absent, `undefined === 0` is false and the caller is handed a `chain_head` for a ballot that was never written. Verified present and 0 under workerd, and `changes: number` is required in `D1Meta`. Cheap fail-closed hardening: `if (result.meta.changes !== 1) return null;`.
4. **Duplicate-vote UNIQUE collisions burn four attempts and produce a false 503.** Pre-existing and documented at `src/governance.ts:663-671`, but copied verbatim into the new function (`src/chain.ts:283-286`). Two concurrent ballots from the same citizen give `503 ... retrying may succeed` — retrying will never succeed (`idx_ballots_proposal_citizen` is not a chain-head race). Distinguishing the two constraint families in the catch would fix both the wasted round trips and the message.
5. **Message accuracy in the overlap case** (cosmetic): when the gate refuses a citizen who had also already voted, the 409 says "no longer open... the tally already ran without it" rather than "already voted". Accurate about the outcome, wrong about the cause.

No `TODO`/`FIXME`/`XXX`/"for now" in the added lines.

## Unverified

- **Production D1's `meta.changes` for a no-op `INSERT…SELECT`.** Verified against workerd locally, not the live service. The safe verification is finding 3's fail-closed change, not a remote write; no `wrangler --remote` was run.
- **Real D1 parallelism.** Every race here (as in the recheck doc) ran against a serialising SQLite; the guards' logic was exercised, not genuine concurrent writers.
- One attempt at `wrangler d1 execute --local --persist-to <scratch>` returned an internal error and was not pursued; the Miniflare probe replaced it.

**One line:** `a31a6b5` is SAFE TO DEPLOY — the ungated path is provably unchanged, the gated path closes N1 and N6 with a refusal signal that workerd's own D1 distinguishes cleanly from a chain-head race, and the only residues (a stale outcome echoed in the sweep's HTTP response, a phantom hash, a fail-open `changes` check) are pre-existing or latent, each a one-line follow-up.
