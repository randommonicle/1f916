# Checkpoint — manual maintainer-wake trigger (`POST /api/maintainer/run`)

Worktree `society-wt-trigger`, branch `maintainer-manual-trigger`, off `b4f22df`.
A parallel Opus builder works `society-wt-showhome` on the same `.git`; all ops
here use `git -C` against this worktree only.

**Goal:** a secret-guarded HTTP endpoint that runs a clerk or judgment wake on
demand, off the cron schedule, behaving IDENTICALLY to a `scheduled()` wake.
Authority-bearing; faces a separate D-018 / independent gate before the
operator deploys. No deploy / push / migration / secret write from this session.

## Checklist

- [x] Isolated worktree; baseline green (623 tests, typecheck clean) before edits.
- [x] Per-IP rate cap `assertManualTriggerNotThrottled` (society.ts), namespaced `maintainer-run:`.
- [x] Budget constant `MANUAL_TRIGGER_PRECHECK_COST` (budget.ts), threaded into priorCost.
- [x] Constant-time secret compare `secretMatches` (trigger.ts).
- [x] Strict `parseWakeKind` validator (trigger.ts).
- [x] Orchestration `handleManualTrigger` (trigger.ts): auth → validate → cap → sweep+wake → summary.
- [x] Route wired in index.ts (`POST /api/maintainer/run`).
- [x] Tests (a)–(f) + budget test + pure units, every load-bearing guard red-proved.
- [x] Concurrency decision written down (below).
- [x] `npm test` + `npm run typecheck` green (634 tests, +11 vs baseline).

## Route + auth design

Gate order (each is server-side; the client names ONLY the wake kind):

1. **Auth — the PRIMARY defence.** Bearer `MAINTAINER_SECRET`. Refuse **closed**
   (401 `{"error":"unauthorized"}`) if the env secret is unset/blank, if no
   bearer is presented, or if the presented secret does not match. All three
   refusals are byte-identical, so a caller cannot tell *which* condition failed.
   The compare is **constant-time**: both sides are hashed to fixed 32-byte
   SHA-256 digests (`crypto.subtle`, the same primitive `chain.ts` uses), then
   XOR-accumulated over every byte with no short-circuit — never `===`/`==` on
   the raw secret. Early returns for "no env secret" / "no bearer" do not leak
   the secret's bytes (they depend only on server config and on whether a header
   was sent, both already known to the caller); only the hash compare depends on
   the secret bytes, and it is constant-time.
2. **Input validation.** Body must be a JSON object with `wake` exactly `"clerk"`
   or `"judgment"`; anything else (typo, wrong case, missing field, non-object)
   is a 400. Runs *before* the rate cap so a malformed request never consumes
   the operator's rate allowance and never spends.
3. **Rate cap — the SPEND guard** (`assertManualTriggerNotThrottled`, 6/hour/IP).
   Reached only by an authenticated, well-formed request that is about to spend
   a model wake. Reuses `reg_log` with a DISTINCT hash namespace
   (`maintainer-run:` vs `sweep:` vs `reg:`) so the three throttles never
   cross-count. Tighter than the public sweep's 10/hour because each call runs a
   full sweep+wake. **Does NOT fail open on a missing IP** (unlike its sweep
   sibling): a null/blank IP is bucketed into one shared key so the cap still
   binds. In production `CF-Connecting-IP` is always set by Cloudflare.
4. **Behaviour — replicate `scheduled()` exactly.** `runGovernanceSweep(env)`
   first, in its own try/catch (a sweep failure never blocks the wake, and vice
   versa), its cost threaded into the wake as `priorCost`; then
   `runClerkWake` / `runJudgmentWake` with the same args the cron path uses. No
   gate the wake applies to itself is bypassed (API-key gate, idle skip, budget
   shed, judgment row-claim). The ONLY differences from `scheduled()`: the wake
   kind is named by the client rather than derived from the cron string, and
   `priorCost` also carries `MANUAL_TRIGGER_PRECHECK_COST` (see below).
5. **Response:** `{ ok, wake, sweep_processed, triggered_at, note }` — enough to
   find the run's row via `GET /api/maintainer-runs` (the most recent row of the
   named kind with `started_at >= triggered_at`). No secret, no internals.

## Concurrency decision (written for the reviewer)

A manual trigger can race a scheduled cron wake, or another manual trigger.
**Decision: rely on the wakes' existing data-layer guards + the rate cap, and
deliberately DO NOT add an in-memory in-flight lock.** Grounded in the code:

- **Judgment execution is serialised by an atomic row-claim.** `stampQueueRow`
  (judgment.ts:988) does `UPDATE maintainer_queue SET status=... WHERE id=? AND
  status='pending'` and the executor acts only if `res.meta.changes > 0`
  (`if (!claimed) continue;`, judgment.ts:1054). Two concurrent judgment wakes
  therefore never double-moderate or double-post a queue item — the loser's
  conditional UPDATE changes zero rows and it skips execution. Worst case is a
  double **model call** over the same batch (each wake scans the same pending
  page), bounded by the rate cap. This is the exact concern judgment.ts's own
  L2 comment already names ("a duty-officer session working the queue at the
  same time as the cron fires, or a retried trigger").
- **The governance sweep is fail-safe under concurrency.** It appends to the
  chain under a UNIQUE constraint with a bounded retry; `FINALISE_RESERVE`
  (budget.ts:86) absorbs one concurrent collision. The documented residual —
  TWO concurrent collisions refusing the finalise write — is exactly what the
  **public sweep's** rate cap makes rare. This endpoint is a NEW way to
  manufacture a second concurrent sweep writer, so its own rate cap makes the
  same residual equally rare from this path. (Same posture as D-042/D-041.)
- **The clerk has no row-claim.** A concurrent clerk double-run drafts duplicate
  `maintainer_queue` PENDING rows (visible working paper the judge reviews and
  can reject — never authoritative-record corruption; the clerk's own M2 comment
  already treats a re-scan duplicate as "an acceptable, visible duplicate") and
  makes a second model call (bounded by the rate cap). The cursor advances to
  the same value either way, so nothing is skipped.
- **Why NOT an in-memory module-level lock:** `fetch` (manual) and `scheduled`
  (cron) handlers can run in DIFFERENT Worker isolates, so an in-isolate lock
  would not serialise a manual trigger against a cron wake — it would be a
  fail-open control masquerading as protection (guard-the-spend-paths Rule 2).
  The real cross-isolate serialisation already lives at the data layer (the
  atomic claim, the UNIQUE chain append), which protects regardless of isolate.

Net: no double **execution** of the *same* queue row (atomic claim); no chain
corruption (UNIQUE + reserve); the main residual is a bounded double **spend**
(a second model call), which the rate cap caps. One further residual, pre-existing
and named by the D-018 gate (`docs/REVIEW-TRIGGER-GATE-2026-08-19.md`, F-1):
`createPost`'s dedupe (society.ts) is a check-then-act over a NON-UNIQUE index
(`idx_posts_dupe`, schema.sql), so two DISTINCT approved drafts with identical
title+body executing concurrently can both pass the SELECT and both INSERT a
duplicate bulletin. It carries no money/vote/chain impact (those chains hold
UNIQUE indexes), it already races the same way from every existing post path
(public post index.ts, MCP mcp.ts, proposals governance.ts), and the pinned
duplicate is operator-removable. This endpoint does not introduce the race, it
only adds one more way to reach it.

## Subrequest-budget threading — honest scope

`MANUAL_TRIGGER_PRECHECK_COST = 3` is added to the `priorCost` the endpoint
threads into the wake, so the wake sheds as if the sweep cost 3 more — covering
the rate cap's own 3 D1 statements (SELECT+INSERT+DELETE) in the same
50-subrequest invocation. **Measured, not assumed:** at the current conservative
estimates the endpoint stays `<= 50` even WITHOUT the +3 (the wake peaks near
~45; +3 lands near ~48, and `FINALISE_RESERVE` independently absorbs it). So the
threading is a **margin-alignment** measure that keeps the endpoint's headroom
equal to `scheduled()`'s and robust against a future estimate tightening — NOT a
breach-preventer at today's numbers. I initially claimed the budget test would
breach at 51 without it; that was wrong and is corrected in the code comments.
Test (g) genuinely guards the endpoint's `<= 50` invariant end-to-end (it fails
if the wake's shed machinery breaks); it does not red-prove the +3 in isolation.

## Red-proofs (prove-it-can-fail) — all confirmed by breaking the guard

- Auth gate disabled → (a), (b), (f), (f2) fail.
- `secretMatches` forced `true` → discrimination unit + (b) fail (one-char-off accepted).
- Rate cap made a no-op → (d), (d2) fail.
- `parseWakeKind` made permissive → validator unit + (c) fail.
- Budget threading: could NOT be made to breach at current estimates (see above) — recorded honestly rather than claimed.

## Files

- `src/maintainer/trigger.ts` (new) — `secretMatches`, `parseWakeKind`, `handleManualTrigger`.
- `src/society.ts` — `assertManualTriggerNotThrottled` + `MANUAL_TRIGGER_PER_IP_PER_HOUR`.
- `src/maintainer/budget.ts` — `MANUAL_TRIGGER_PRECHECK_COST`.
- `src/index.ts` — route wiring + import.
- `test/maintainer-manual-trigger-d1.test.ts` (new) — 11 tests.

## For the gate to scrutinise

1. **Auth-refusal status/shape uniformity** — confirm no path (unset, blank,
   missing, wrong) leaks which condition failed, and that the constant-time
   compare is genuinely constant-time in the Workers runtime.
2. **Concurrency residual** — the double **model spend** on a manual+cron race is
   accepted and rate-capped, not eliminated. Confirm that is acceptable, and that
   the clerk's duplicate-draft residual is genuinely harmless in the judge's queue.
3. **Rate-cap value + null-IP bucketing** — 6/hour/IP and the shared `_no_ip`
   bucket: confirm the cap is tight enough for a spend path and that the
   closed-on-missing-IP choice is correct for production.
