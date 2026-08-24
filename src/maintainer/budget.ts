// The shared subrequest-budget cost table (docs/BRIEF-JUDGMENT-QUERY-BUDGET.md
// §9 / D-041). Cloudflare Workers Free allows 50 subrequests per invocation,
// and scheduled() runs the governance sweep AND whichever wake fired in ONE
// invocation, sharing that budget. The static constants above do NOT close
// the compound worst case by themselves -- a due proposal, a replayed
// stranded row, and full judgment batches can coincide and cross 50 -- and
// D-041 declined the alternative of simply lowering JUDGMENT_MAX_BATCHES
// (a smaller fixed ceiling wastes capacity on quiet weeks and still fails on
// busy ones, since the compound case is driven by sweep and replay work a
// smaller batch count does not touch). So each wake sheds load it cannot pay
// for, LOUDLY, BEFORE starting it, using this bookkeeping arithmetic over the
// phases actually run this invocation -- NOT a wrapper around the D1 binding
// in production, which is neither needed nor commissioned.
//
// These are STATICALLY-DERIVED per-phase estimates, deliberately CONSERVATIVE
// (>= the real cost) so the shed decision fires early enough that the real
// invocation never actually reaches subrequest 51. The end-to-end counter
// proof (test/maintainer-scheduled-budget.test.ts) is the enforcement: if any
// estimate drifts below reality, the compound proof goes red at 51. Keep each
// constant next to the phase it prices, and cite the proof beside them.
//
// Costs are in subrequests (D1 statements + outbound fetches, one pool).

export const INVOCATION_SUBREQUEST_BUDGET = 50;

// The governance sweep, run in scheduled() before either wake. due SELECT +
// stranded SELECT + one detection lookup = 3 fixed; each due proposal costs
// ~8-9 through claimTallyAndExecuteOne (claim, proposal SELECT, ballot counts,
// citizens + founders, commitOutcome's head read + a 2-3 statement batch), so
// 9 is the conservative per-proposal price.
export const SWEEP_BASE_COST = 3;
export const SWEEP_PER_PROPOSAL_COST = 9;

// The judgment wake's fixed reads before the batch loop: run-row reserve,
// detection (conservatively 1, usually 0 cached), set-based reconciliation,
// maintainer-citizen load, approved-row read, pending count. Finalise is
// reserved separately (FINALISE_RESERVE).
export const JUDGMENT_WAKE_FIXED_COST = 6;

// One stranded approved row replayed through the real executors costs up to 6
// (the bulletin ceiling: claim + createPost's daily-count + dupe + insert +
// chain head + chain insert). The wake reserves this for the rows the replay
// actually processed this invocation.
export const REPLAY_PER_ROW_COST = 6;

// One judgment batch's marginal cost at C=1: a scan page + its (bulk,
// set-based) classification + a model fetch + up to 6 decision writes for one
// approved bulletin. FORWARD(D-037): a better product may exist by changing
// JUDGMENT_MAX_BATCHES or the per-decision write/executor shape (fewer
// batches, bulk stamps) -- D-037 expressly did NOT commission that; this
// marker sits where the cost table prices the batch phase so the option is
// findable if the throughput ruling is ever revisited.
export const JUDGMENT_BATCH_COST = 8;

// The clerk wake's fixed cost (non-insert): reserve + detection + reconcile +
// cursor + 4 candidate streams + set-based flag hydration (<=2) + drift (1 D1
// sum + up to 4 RPC probes, worst case) + previous delta + one model fetch +
// finalise. Flatter than the judgment shape (no 4-batch multiplier), so the
// clerk closes with a per-insert affordability cap rather than shedding whole
// batches.
export const CLERK_WAKE_FIXED_COST = 18;

// Headroom held back so the loud finalise run-row write ALWAYS lands even at
// the non-sheddable floor, plus a little slop. Uncontended paths land here
// with stated headroom; a chain-append UNIQUE-collision retry (only possible
// under concurrent invocations, not within one sequential sweep) adds ~2 each
// and is called out in the report rather than reserved in full.
//
// Contention finding, D-042/D-041's accept-a-rare-residual posture
// (exchange/REVIEW_query-budget-brief_2026-08-15.md /
// exchange/REVIEW_combined-deploy-pregate_2026-08-16.md, both CODEX round
// 1, CONVERGED): at the ~47/50 interior peak a judgment wake can reach,
// this reserve absorbs exactly ONE such collision -- the finalise write
// still lands, on the slop alone. TWO concurrent collisions (+4, not +2)
// DO refuse the finalise write; this is an ACCEPTED residual, not closed
// here, the same posture D-042 already took for the registration-throttle
// one-over (society.ts). Reaching "two concurrent" needs a SECOND writer
// racing the cron wake's own co-resident sweep, and the only way an
// outside caller can manufacture one is the public, permissionless
// `POST /api/governance/sweep` (index.ts) -- now rate-capped per IP
// (assertPublicSweepNotThrottled, society.ts), which is what makes this
// residual RARE rather than routinely reachable. Raising this constant
// to cover two collisions outright was considered and rejected: it buys
// safety against a residual the rate cap already makes rare, at the cost
// of shedding real work on every ordinary, uncontended wake.
export const FINALISE_RESERVE = 2;

// Pure. The sweep's estimated cost given how many due proposals it processed
// this invocation. scheduled() passes this to both wakes as their `priorCost`.
export function estimateSweepCost(proposalsProcessed: number): number {
  return SWEEP_BASE_COST + proposalsProcessed * SWEEP_PER_PROPOSAL_COST;
}

// The manual-trigger endpoint (POST /api/maintainer/run, src/maintainer/trigger.ts)
// runs the SAME sweep+wake pipeline scheduled() does, but inside a fetch()
// invocation that FIRST spends the per-IP rate cap's own D1 statements
// (assertManualTriggerNotThrottled, society.ts): SELECT count + INSERT + DELETE
// prune = 3 subrequests, in the SAME 50-subrequest invocation the wake sheds
// against. estimateSweepCost prices only the sweep, so the endpoint adds this
// constant to the priorCost it threads into the wake -- the wake then sheds as
// if the sweep had cost 3 more, so the endpoint carries the SAME headroom below
// 50 that scheduled() does, rather than quietly spending 3 of FINALISE_RESERVE's
// margin on a path scheduled() never had.
//
// HONEST SCOPE (measured, not assumed): at the CURRENT conservative estimates,
// the endpoint stays <= 50 even WITHOUT this threading -- FINALISE_RESERVE and
// the estimates' own slack independently absorb the extra 3 in every fixture
// tried (the wake peaks near ~45, so +3 lands near ~48, not 51). So this is a
// margin-ALIGNMENT measure that keeps the endpoint's budget accounting honest
// and robust against a future estimate tightening, NOT a breach-preventer at
// today's numbers. The end-to-end proof in
// test/maintainer-manual-trigger-d1.test.ts guards the endpoint's <= 50
// invariant as a whole (which CAN fail if the wake's shed machinery breaks); it
// does not, and cannot at current estimates, red-prove this +3 in isolation.
// Conservative (>= real): the cap spends 3 on the proceed path, 0 when the IP
// resolves to an empty bucket, never more.
export const MANUAL_TRIGGER_PRECHECK_COST = 3;

// Pure. May the judgment wake OPEN another batch? True only if, after the
// sweep (priorCost), the wake's fixed reads, the replay rows already
// processed, and the batches already opened, there is room for one MORE batch
// AND the finalise reserve. `batchesOpened` is how many batches this wake has
// already run.
export function canOpenJudgmentBatch(priorCost: number, replayRowsProcessed: number, batchesOpened: number): boolean {
  const spent = priorCost + JUDGMENT_WAKE_FIXED_COST + replayRowsProcessed * REPLAY_PER_ROW_COST + batchesOpened * JUDGMENT_BATCH_COST;
  return spent + JUDGMENT_BATCH_COST + FINALISE_RESERVE <= INVOCATION_SUBREQUEST_BUDGET;
}

// HIGH 2 companion (exchange/REVIEW_combined-deploy-pregate_2026-08-16.md
// CODEX round 1): JUDGMENT_BATCH_COST prices a scan page's own read but
// assumes classifying it costs NOTHING extra (8 = 1 scan page + 1 model
// fetch + up to 6 decision writes, with 0 left for classification) -- true
// only while every bulk fan-out inside classifyAndHydratePage
// (maintainer/judgment.ts) stays within its first D1_MAX_BIND_PARAMS-sized
// chunk. A page dominated by many DISTINCT ids in one fan-out category
// (Codex's reproduction: hundreds of constitution_fidelity rows each
// naming a different missing constitution_versions id) needs MORE chunk
// statements than that flat estimate prices, and the shortfall was
// completely unpriced -- Codex measured the extra chunk statements pushing
// the wake's own finalise write into the refused 51st subrequest at 401
// pending fidelity rows.
//
// D1's bind-parameter cap (100 per query, both plans) is what forces the
// chunking in the first place -- see classifyAndHydratePage's own `chunk`
// calls, all sized to this constant.
export const D1_MAX_BIND_PARAMS = 100;

// Pure. Conservative (>= real) worst-case chunk-statement count for
// classifying a raw scan page from ROW COUNTS alone -- cheap, in-memory,
// already-fetched data, never a second D1 round trip just to know the true
// distinct-id counts. Distinct ids in any one fan-out category can never
// exceed that category's own row count (postCount/commentCount/
// fidelityCount are disjoint subsets of the same page, since a row is
// never more than one kind), so counting rows is always a safe substitute
// for counting the true distinct sets classifyAndHydratePage actually
// queries by.
//
// fidelityCount prices THREE separate fan-outs off the same rows --
// version existence, linked mandates, and version+predecessor bodies --
// because a fidelity row's classification can touch all three regardless
// of how many turn out admissible. A row withheld at the existence check
// (Codex's own missing-version fixture) costs LESS in reality, never more,
// so this stays a safe overestimate for that case. It assumes at most a
// handful of mandates per constitution version -- a version naming
// unusually many linked mandates is a residual this does not fully price,
// the same kind of documented, made-rare-not-impossible residual
// FINALISE_RESERVE's own comment accepts for chain-retry contention; real
// constitution versions come from the governance amendment process, not an
// unauthenticated public surface, so the volume this would need is not
// attacker-reachable the way a pending-queue backlog organically is.
export function classifyChunkCost(postCount: number, commentCount: number, fidelityCount: number): number {
  const chunksOf = (n: number) => Math.ceil(n / D1_MAX_BIND_PARAMS);
  return chunksOf(postCount) + chunksOf(commentCount) + chunksOf(fidelityCount) /* existence */ + chunksOf(fidelityCount) /* mandates, worst case */ + chunksOf(fidelityCount * 2) /* bodies: version + predecessor, worst case */;
}

// Pure. How many EXTRA classification chunk statements (beyond the base
// scan-page read JUDGMENT_BATCH_COST already prices) can THIS batch afford,
// given everything already spent and the batches already opened -- the
// exact same `spent` arithmetic canOpenJudgmentBatch uses, expressed as
// slack instead of a boolean. Only meaningful once canOpenJudgmentBatch has
// already said this batch may open at all (which guarantees the result is
// >= 0); a caller that skips that check could see a negative number and
// must treat it as zero headroom, not a negative budget.
export function classifyChunkBudget(priorCost: number, replayRowsProcessed: number, batchesOpened: number): number {
  const spent = priorCost + JUDGMENT_WAKE_FIXED_COST + replayRowsProcessed * REPLAY_PER_ROW_COST + batchesOpened * JUDGMENT_BATCH_COST;
  return INVOCATION_SUBREQUEST_BUDGET - spent - JUDGMENT_BATCH_COST - FINALISE_RESERVE;
}

// Pure. How many queue inserts can the clerk afford this invocation, capped at
// `ceiling` (CLERK_QUEUE_CAP)? Never negative. On a quiet-sweep day this is
// near the ceiling; on a busy-sweep day it shrinks, and the surplus the model
// proposed is counted as overflow_dropped exactly as a volume overflow is.
export function affordableClerkInserts(priorCost: number, ceiling: number): number {
  const affordable = INVOCATION_SUBREQUEST_BUDGET - priorCost - CLERK_WAKE_FIXED_COST - FINALISE_RESERVE;
  return Math.max(0, Math.min(ceiling, affordable));
}

// The engagement concierge (docs/DESIGN-CONCIERGE.md §12, docs/BUILD-CONCIERGE-ADDENDUM.md).
// Runs BEFORE the clerk on every clerk-cadence wake (src/index.ts scheduled(),
// src/maintainer/trigger.ts handleManualTrigger); its own returned actualCost
// is threaded into the clerk's priorCost exactly as the sweep's is, so the two
// phases share one invocation's budget honestly -- a busy concierge attempt
// leaves the clerk affording fewer inserts, never the other way round.

// The two detection reads (§6) -- always run when affordable, D1-only. Priced
// separately from the generation/post cost below because they are the fixed,
// cheap part; the model call is the part that actually costs money.
export const CONCIERGE_DETECTION_COST = 2;

// One Anthropic fetch per candidate attempted, up to this many candidates
// tried before the wake gives up for the day (not how many it may POST --
// that ceiling is 1, enforced by stopping at the first successful post).
export const CONCIERGE_ATTEMPT_COST = 1;
export const CONCIERGE_MAX_ATTEMPTS = 3;

// One successful post: the maintainer citizen row fetch (1, C2 -- replaces a
// fabricated identity object with a real SELECT, so createComment is never
// handed a citizen that does not exist) + createComment's post-exists check
// (1) + parent-exists check (1, comment targets only -- conservatively
// priced as always-present) + countSince (1, always runs even though
// capExempt skips the cap comparison -- society.ts) + the INSERT (1) = 5,
// plus the identity_events disclosure append (head-hash read + insert, ~2,
// up to ~4 conservatively if a UNIQUE-collision retry is modelled the way
// commitWithModLog's own comment prices one, society.ts) = 9, conservative
// (>= real), matching the D-041/D-045 house discipline of pricing worst
// case, not typical case.
export const CONCIERGE_POST_COST = 9;

// CC1 (docs/DESIGN-CONCIERGE.md's own "rate-limited to one a day" disclosure,
// society.ts's officialFacts concierge block and CONCIERGE_DISCLOSURE_PREAMBLE):
// the daily-cap SELECT concierge.ts runs immediately after this
// affordability check and before detection, on every invocation that
// reaches it -- one D1 read. Priced here so canAffordConcierge's own worst
// case accounts for it; without this, an invocation could pass the
// affordability check and then still be the one that pushes a later phase
// over budget on the strength of a read this function never charged for.
export const CONCIERGE_DAILY_CAP_CHECK_COST = 1;

// CC2: the concierge_runs row EVERY path writes, exactly once, as its last
// act (insertConciergeRun) -- previously unpriced anywhere, so the
// actualCost this phase returned understated what it threaded into the
// clerk's own priorCost by exactly this much, on every single path,
// including the ones that spend nothing else at all (no api key, budget
// shed). One D1 write.
export const CONCIERGE_FINALISE_COST = 1;

// Pure. May the concierge phase run at all this invocation, given what the
// co-resident governance sweep (priorCost) has already spent? Reuses the
// existing FINALISE_RESERVE (this phase's own outcome write must always
// land) and INVOCATION_SUBREQUEST_BUDGET -- no new ceiling constant, the same
// shared 50 the rest of budget.ts prices against. Checked ONCE, before
// detection runs, using the worst-case estimate -- simpler than the
// judgment batch loop's incremental per-batch check, and safe: the
// concierge's worst case is small and tightly bounded, so a single
// conservative up-front check costs little in false shedding.
//
// Arithmetic: 1 (daily-cap check) + 2 (detection) + 3*1 (attempts) + 9
// (post) + 1 (finalise) = 16, so this passes whenever priorCost <= 32.
export function canAffordConcierge(priorCost: number): boolean {
  const worstCase =
    CONCIERGE_DAILY_CAP_CHECK_COST + CONCIERGE_DETECTION_COST + CONCIERGE_MAX_ATTEMPTS * CONCIERGE_ATTEMPT_COST + CONCIERGE_POST_COST + CONCIERGE_FINALISE_COST;
  return priorCost + worstCase + FINALISE_RESERVE <= INVOCATION_SUBREQUEST_BUDGET;
}
