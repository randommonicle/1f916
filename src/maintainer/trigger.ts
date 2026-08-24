// The manual maintainer-wake trigger (POST /api/maintainer/run). Lets the
// operator run a clerk or judgment wake ON DEMAND, off the cron schedule,
// behaving IDENTICALLY to a scheduled() wake: the governance sweep first, then
// the named wake, sharing one invocation's subrequest budget.
//
// Every authority decision is made SERVER-SIDE (server-side-authority): the
// client names ONLY which wake to run; the secret check, the rate cap, the
// sweep, and every gate each wake applies to itself are all enforced here and
// downstream, never trusted from the request. The request body carries no path,
// no id, no cost, nothing the server acts on beyond the wake KIND.
//
// Gate order (each documented at its step below): auth (the primary defence)
// -> input validation -> rate cap (the spend guard) -> sweep + wake.

import {
  type Env,
  SocietyError,
  assertManualTriggerNotThrottled,
} from "../society.ts";
import { runGovernanceSweep, SWEEP_COHORT_CAP } from "../governance.ts";
import { runClerkWake } from "./clerk.ts";
import { runJudgmentWake } from "./judgment.ts";
import { runConciergeWake } from "./concierge.ts";
import { estimateSweepCost, MANUAL_TRIGGER_PRECHECK_COST } from "./budget.ts";

export type ManualWakeKind = "clerk" | "judgment";

// Pure. The client names ONLY the wake kind; this is the whole of the input
// contract, validated strictly. Anything that is not EXACTLY one of the two
// kinds -- a typo, a missing field, a number, an object, "Clerk" with the
// wrong case -- is a 400, never a guess. Throws SocietyError so index.ts's
// existing catch renders it as { error }, status 400.
export function parseWakeKind(raw: unknown): ManualWakeKind {
  if (raw === "clerk" || raw === "judgment") return raw;
  throw new SocietyError(400, 'the "wake" field must be exactly "clerk" or "judgment"');
}

// The maintainer secret is compared in CONSTANT TIME, never with ===/== on the
// raw strings (constant-time-secret-compare). String equality short-circuits on
// the first differing byte and leaks, through response timing, how many leading
// bytes matched -- an oracle an attacker walks one byte at a time. Hashing both
// sides to fixed-length SHA-256 digests first (a) destroys any per-byte timing
// signal about the secret, since the comparison is now over uncorrelated hash
// bytes, and (b) makes the two buffers always equal length (32 bytes), so the
// byte loop below is fixed-length with no length-dependent early exit of its
// own. crypto.subtle is the same primitive chain.ts already hashes with, and is
// available in both the Workers runtime and the Node test runtime.
async function sha256Bytes(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

export async function secretMatches(provided: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256Bytes(provided), sha256Bytes(expected)]);
  // Both are 32-byte SHA-256 digests, so the lengths always match; XOR-
  // accumulate the difference across EVERY byte with no short-circuit, then
  // test the accumulator once. A `return false` inside the loop would
  // reintroduce a data-dependent branch, so it is deliberately absent.
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

// Pure. Extracts a Bearer token, or null. Mirrors index.ts's own module-private
// `bearer` (kept free-standing here rather than importing from the Worker entry,
// the same each-file-free-standing convention clerk.ts/judgment.ts follow for
// their duplicated appendError).
function bearerToken(request: Request): string | null {
  const auth = request.headers.get("Authorization");
  return auth?.startsWith("Bearer ") ? auth.slice(7) : null;
}

// Pure. Reads a JSON object body, tolerant of the same shapes index.ts's own
// `body` helper is (throws 400 on anything that is not a JSON object).
// Duplicated rather than imported from the Worker entry for the same reason
// bearerToken is.
async function readJsonObject(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = (await request.json()) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    /* fall through to the loud error */
  }
  throw new SocietyError(400, "request body must be a JSON object");
}

export interface ManualTriggerSummary {
  ok: true;
  wake: ManualWakeKind;
  // How many due proposals the co-resident sweep processed, or null if the
  // sweep itself threw (logged, non-fatal -- the wake still runs, exactly as
  // scheduled() does). Never leaks wake internals or the secret.
  sweep_processed: number | null;
  // A marker the operator uses to find THIS run's row: the wake writes exactly
  // one maintainer_runs row whose started_at is >= this value.
  triggered_at: number;
  note: string;
}

// The endpoint. Refusals throw SocietyError (index.ts's catch renders them);
// success returns the summary (index.ts wraps it in a 200 json()).
export async function handleManualTrigger(request: Request, env: Env): Promise<ManualTriggerSummary> {
  // 1. AUTH -- the PRIMARY defence (server-side-authority). Refuse closed if
  // the env secret is unset/blank (never open), if no bearer was presented, or
  // if the presented secret does not match. All three throw the SAME 401 with
  // the SAME body, so a caller cannot tell a wrong secret from a missing one
  // (no which-failed oracle). The early returns for the first two cases do not
  // leak the secret's bytes: they depend only on server config and on whether
  // the caller sent a header (which the caller already knows), never on the
  // secret's contents -- only the secretMatches step depends on those, and it
  // is constant-time.
  const expected = env.MAINTAINER_SECRET;
  const provided = bearerToken(request);
  if (!expected || expected.trim() === "" || !provided || !(await secretMatches(provided, expected))) {
    throw new SocietyError(401, "unauthorized");
  }

  // 2. INPUT -- validated before the rate cap so a malformed request (a typo'd
  // wake kind) is a free 400 that never consumes the operator's own rate
  // allowance and never spends.
  const b = await readJsonObject(request);
  const wake = parseWakeKind(b.wake);

  // 3. RATE CAP -- the spend guard (guard-the-spend-paths). Only reached by an
  // authenticated, well-formed request that is ABOUT to spend a model wake, so
  // the cap governs exactly the paid path. Throws 429 when exceeded, BEFORE any
  // sweep or wake runs -- a burst is refused free.
  await assertManualTriggerNotThrottled(env, request.headers.get("CF-Connecting-IP"));

  // 4. BEHAVIOUR -- replicate scheduled() exactly. The governance sweep runs
  // first, unconditionally, in its own try/catch so a sweep failure never
  // blocks the wake (and vice versa), and its estimated cost is threaded into
  // the wake as priorCost so the wake sheds work it cannot pay for. The ONLY
  // differences from scheduled() are (a) the wake kind is NAMED by the client
  // rather than derived from the cron string, and (b) priorCost also carries
  // MANUAL_TRIGGER_PRECHECK_COST, the rate cap's own D1 statements, so this
  // fetch() invocation keeps the same <= 50 subrequest budget scheduled() does.
  // No gate the wake applies to itself is bypassed: the wakes run byte-for-byte
  // the same code the cron fires, including the API-key gate, the idle skip, the
  // budget shed, and (judgment) the row-claim.
  let sweepProcessed: number | null = null;
  let priorCost = estimateSweepCost(SWEEP_COHORT_CAP) + MANUAL_TRIGGER_PRECHECK_COST;
  try {
    const sweep = await runGovernanceSweep(env);
    sweepProcessed = sweep.processed;
    priorCost = estimateSweepCost(sweep.processed) + MANUAL_TRIGGER_PRECHECK_COST;
  } catch (e) {
    console.log(JSON.stringify({ level: "error", event: "manual_trigger_sweep_failed", wake, message: String(e) }));
  }

  const triggeredAt = Date.now();
  // Same reorder as scheduled() (docs/DESIGN-CONCIERGE.md §4.1): the
  // concierge runs first on a clerk-kind trigger, and its actualCost is
  // threaded into the clerk's own priorCost identically.
  if (wake === "clerk") {
    const concierge = await runConciergeWake(env, priorCost);
    await runClerkWake(env, undefined, priorCost + concierge.actualCost);
  } else await runJudgmentWake(env, undefined, priorCost);

  return {
    ok: true,
    wake,
    sweep_processed: sweepProcessed,
    triggered_at: triggeredAt,
    note: `Ran the governance sweep, then the ${wake} wake, exactly as the cron path does. The wake wrote one row to maintainer_runs; find it via GET /api/maintainer-runs (the most recent '${wake}' row whose started_at is >= triggered_at).`,
  };
}
