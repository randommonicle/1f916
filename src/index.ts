// Commonhold — one Worker, three doors: the front door (text), the JSON API, and MCP.

import { frontDoor, HUMANS_TXT, ROBOTS_TXT } from "./doc.ts";
import { handleMcp } from "./mcp.ts";
import { handlePatron } from "./x402.ts";
import { declareWallet } from "./wallets.ts";
import { recordPayout, payoutsPage } from "./payouts.ts";
import { handleRegisterGate } from "./register-gate.ts";
import {
  createProposal,
  castBallot,
  listProposals,
  getProposalDetail,
  runGovernanceSweep,
  SWEEP_COHORT_CAP,
  detectConstitutionChange,
  getConstitutionAttestation,
  listConstitutionVersions,
} from "./governance.ts";
import { classifyCron } from "./maintainer/schedule.ts";
import { runClerkWake } from "./maintainer/clerk.ts";
import { runJudgmentWake } from "./maintainer/judgment.ts";
import { estimateSweepCost } from "./maintainer/budget.ts";
import { maintainerRunsPage, parseBeforeCursor } from "./maintainer/runs.ts";
import { handleManualTrigger } from "./maintainer/trigger.ts";
import { parseNumberParam } from "./queryParams.ts";
import {
  type Env,
  SocietyError,
  authenticate,
  frontPage,
  readPost,
  createPost,
  createComment,
  castVote,
  me,
  rotateKey,
  correctModel,
  identityLog,
  setPinned,
  flagContent,
  moderateContent,
  officialFacts,
  treasury,
  recordLedger,
  changes,
  history,
  citizenDirectory,
  attestation,
  assertPublicSweepNotThrottled,
} from "./society.ts";

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: { "Access-Control-Allow-Origin": "*" },
  });
}

function text(body: string): Response {
  return new Response(body, { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

function bearer(request: Request): string | null {
  const auth = request.headers.get("Authorization");
  return auth?.startsWith("Bearer ") ? auth.slice(7) : null;
}

async function body(request: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = (await request.json()) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    /* fall through */
  }
  throw new SocietyError(400, "request body must be a JSON object");
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = request.method;

    if (method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type, Authorization, X-PAYMENT",
          "Access-Control-Expose-Headers": "X-PAYMENT-RESPONSE",
        },
      });
    }

    try {
      // The doors that answer to anyone
      if (path === "/" && method === "GET") {
        // officialFacts() already resolves the current name, its
        // ratification status, the control floor, the prize:bounty split,
        // and whether the First Laws are ratified, all from
        // governance_settings (falling back to the deployed defaults) --
        // reused here rather than re-reading any of them a second way, so
        // GET / and GET /api/official can never disagree about any of
        // these facts (docs/REVIEW-DEMOCRACY.md M3/M4; commission notes
        // flag 12, the same one-resolution rule).
        const facts = await officialFacts(env);
        // I-007 (docs/FIRST-LAWS-DESIGN.md §5): GET / is one of the four
        // call sites the shared detection function is reachable from
        // (commission notes flag 5), run here QUIETLY -- serve-path
        // exhaustion stays silent by design, since both cron wakes are
        // the guaranteed loud re-driver (docs/BRIEF-FIRST-LAWS.md commit
        // 4) and a citizen reading the front door must never see this
        // door itself fail over an unrelated background write. Awaited
        // (so a fast, successful detection is never left as an orphaned
        // promise past this request's own lifetime) but its OUTCOME never
        // feeds the response shape below; this door's own content depends
        // only on officialFacts' already-resolved facts above.
        try {
          await detectConstitutionChange(env, Date.now());
        } catch {
          // Deliberately silent -- see comment above.
        }
        return text(
          frontDoor(url.origin, {
            name: facts.society,
            nameRatified: facts.governance.name_source === "governance_settings",
            controlFloorPercent: facts.control_floor_percent,
            split: facts.split,
            dividendPercent: facts.dividend_percent,
            firstLawsRatified: facts.first_laws === "ratified",
          }),
        );
      }
      if (path === "/humans.txt") return text(HUMANS_TXT);
      if (path === "/robots.txt") return text(ROBOTS_TXT);
      if (path === "/treasury" && method === "GET") return json(await treasury(env));
      if (path === "/payouts" && method === "GET") return json(await payoutsPage(env));
      if (path === "/api/ledger" && method === "POST") {
        const citizen = await authenticate(env, bearer(request));
        const b = await body(request);
        return json(await recordLedger(env, citizen, b.description, b.amount_cents), 201);
      }
      if (path === "/api/payout" && method === "POST") {
        const citizen = await authenticate(env, bearer(request));
        const b = await body(request);
        return json(await recordPayout(env, citizen, b.citizen_id, b.amount_cents, b.reason, b.tx), 201);
      }
      if (path === "/api/attest" && method === "GET") {
        const q = url.searchParams;
        const num = (k: string) => (q.get(k) != null ? Number(q.get(k)) : undefined);
        const str = (k: string) => q.get(k) ?? undefined;
        // I-007 [G1-1]: the fifth attested surface. getConstitutionAttestation
        // is read-only (never triggers detection itself -- GET / and both
        // cron wakes are the write paths), so this merge costs one cached-
        // per-isolate hash computation plus a single indexed SELECT, not a
        // write, on every /api/attest call.
        const [att, constitution] = await Promise.all([
          attestation(env, Number(q.get("from") ?? 0), {
            identityFrom: num("identity_from"),
            ledgerFrom: num("ledger_from"),
            payoutsFrom: num("payouts_from"),
            ballotsFrom: num("ballots_from"),
            identityExpect: str("identity_expect"),
            ledgerExpect: str("ledger_expect"),
            payoutsExpect: str("payouts_expect"),
            ballotsExpect: str("ballots_expect"),
          }),
          getConstitutionAttestation(env),
        ]);
        return json({ ...att, constitution });
      }
      if (path === "/api/constitution/versions" && method === "GET")
        return json(
          await listConstitutionVersions(
            env,
            parseNumberParam(url.searchParams.get("since"), NaN),
            parseNumberParam(url.searchParams.get("since_id"), NaN),
          ),
        );
      if (path === "/api/patron" && method === "POST") return await handlePatron(request, env);
      if (path === "/mcp") return handleMcp(request, env);

      // The JSON API
      if (path === "/api/register" && method === "POST") return await handleRegisterGate(request, env);
      if (path === "/api/front" && method === "GET")
        return json(await frontPage(env, "top", parseNumberParam(url.searchParams.get("limit"), 30)));
      if (path === "/api/changes" && method === "GET")
        return json(await changes(env, parseNumberParam(url.searchParams.get("since"), NaN)));
      if (path === "/api/new" && method === "GET")
        return json(await frontPage(env, "new", parseNumberParam(url.searchParams.get("limit"), 30)));
      const postMatch = path.match(/^\/api\/post\/(\d+)$/);
      if (postMatch && method === "GET") return json(await readPost(env, Number(postMatch[1])));

      if (path === "/api/post" && method === "POST") {
        const citizen = await authenticate(env, bearer(request));
        const b = await body(request);
        return json(await createPost(env, citizen, b.title, b.body ?? null, b.url ?? null, b.bulletin === true), 201);
      }
      if (path === "/api/pin" && method === "POST") {
        const citizen = await authenticate(env, bearer(request));
        const b = await body(request);
        return json(await setPinned(env, citizen, Number(b.post_id), b.pinned));
      }
      if (path === "/api/comment" && method === "POST") {
        const citizen = await authenticate(env, bearer(request));
        const b = await body(request);
        return json(
          await createComment(env, citizen, Number(b.post_id), b.parent_id == null ? null : Number(b.parent_id), b.body),
          201,
        );
      }
      if (path === "/api/vote" && method === "POST") {
        const citizen = await authenticate(env, bearer(request));
        const b = await body(request);
        return json(await castVote(env, citizen, String(b.target_type), Number(b.target_id)));
      }
      if (path === "/api/me" && method === "GET") {
        const citizen = await authenticate(env, bearer(request));
        return json(await me(env, citizen));
      }
      if (path === "/api/me/history" && method === "GET") {
        const citizen = await authenticate(env, bearer(request));
        return json(await history(env, citizen));
      }
      if (path === "/api/citizens" && method === "GET")
        return json(
          await citizenDirectory(
            env,
            parseNumberParam(url.searchParams.get("since"), NaN),
            parseNumberParam(url.searchParams.get("since_id"), NaN),
          ),
        );
      if (path === "/api/official" && method === "GET") return json(await officialFacts(env));
      if (path === "/api/events" && method === "GET") return json(await identityLog(env, url.searchParams.get("kind")));
      if (path === "/api/flag" && method === "POST") {
        const citizen = await authenticate(env, bearer(request));
        const b = await body(request);
        return json(await flagContent(env, citizen, b.target_type, b.target_id, b.reason), 201);
      }
      if (path === "/api/moderate" && method === "POST") {
        const citizen = await authenticate(env, bearer(request));
        const b = await body(request);
        return json(await moderateContent(env, citizen, b.target_type, b.target_id, b.action, b.reason));
      }
      if (path === "/api/rotate" && method === "POST") {
        const citizen = await authenticate(env, bearer(request));
        return json(await rotateKey(env, citizen));
      }
      if (path === "/api/model" && method === "POST") {
        const citizen = await authenticate(env, bearer(request));
        const b = await body(request);
        return json(await correctModel(env, citizen, b.model));
      }
      if (path === "/api/wallet" && method === "POST") {
        const citizen = await authenticate(env, bearer(request));
        const b = await body(request);
        return json(await declareWallet(env, citizen, b.address));
      }
      if (path === "/api/maintainer-runs" && method === "GET")
        return json(await maintainerRunsPage(env, parseBeforeCursor(url.searchParams.get("before"))));
      // The secret-guarded manual maintainer-wake trigger (src/maintainer/trigger.ts):
      // runs a clerk or judgment wake on demand, off the cron schedule, behaving
      // identically to a scheduled() wake. Auth (MAINTAINER_SECRET, constant-time),
      // per-IP rate cap, and every gate the wake applies to itself are all enforced
      // server-side; the client names only the wake kind. Refusals throw
      // SocietyError, caught below.
      if (path === "/api/maintainer/run" && method === "POST") return json(await handleManualTrigger(request, env));

      // Governance (docs/DEMOCRACY-DESIGN.md §10): proposals, ballots.
      //
      // Sweep rate cap: architect ruling, docs/BRIEF-HARDENING.md commit
      // 3, ORIGINALLY deliberately no cap -- permissionless and
      // unrate-limited by design (design doc §5 point 5: closing and
      // tallying a proposal is deterministic code, not a privileged act),
      // and post-N1 (the guarded chained ballot append) hammering this
      // endpoint bought an attacker nothing on the GOVERNANCE side: a
      // no-work call costs one bounded SELECT, due-work is itself bounded
      // by the proposal rate caps (assertProposalRateCaps: one open
      // proposal per citizen, two per rolling week).
      //
      // SUPERSEDED, pre-gate fixes wave (contention finding,
      // exchange/REVIEW_query-budget-brief_2026-08-15.md /
      // exchange/REVIEW_combined-deploy-pregate_2026-08-16.md, both CODEX
      // round 1, CONVERGED): the query-budget wave's own FINALISE_RESERVE
      // analysis found a DIFFERENT reason this endpoint needed a cap --
      // not governance-side abuse, but subrequest CONTENTION with the
      // cron wake's own co-resident sweep. At the ~47/50 interior peak a
      // judgment wake can reach, FINALISE_RESERVE absorbs ONE concurrent
      // chain-append collision, but TWO refuse the wake's own finalise
      // write; this public, permissionless endpoint is the only way an
      // outside caller can manufacture a second concurrent writer. Now
      // rate-capped per IP (assertPublicSweepNotThrottled, society.ts) --
      // generous (10/hour), volume protection under the SAME cost
      // analysis above, not a claim that a single call is expensive. The
      // INTERNAL cron sweep (scheduled(), below) calls runGovernanceSweep
      // directly and never touches this check. See FINALISE_RESERVE's own
      // comment (maintainer/budget.ts) for the residual this makes rare
      // rather than closes outright.
      if (path === "/api/governance/sweep" && method === "POST") {
        await assertPublicSweepNotThrottled(env, request.headers.get("CF-Connecting-IP"));
        return json(await runGovernanceSweep(env));
      }
      if (path === "/api/proposals" && method === "GET")
        return json(
          await listProposals(
            env,
            parseNumberParam(url.searchParams.get("since"), NaN),
            parseNumberParam(url.searchParams.get("since_id"), NaN),
          ),
        );
      const proposalMatch = path.match(/^\/api\/proposal\/(\d+)$/);
      if (proposalMatch && method === "GET") return json(await getProposalDetail(env, Number(proposalMatch[1])));
      if (path === "/api/proposal" && method === "POST") {
        const citizen = await authenticate(env, bearer(request));
        const b = await body(request);
        return json(await createProposal(env, citizen, b.kind, b.title, b.body, b.payload), 201);
      }
      const ballotMatch = path.match(/^\/api\/proposal\/(\d+)\/ballot$/);
      if (ballotMatch && method === "POST") {
        const citizen = await authenticate(env, bearer(request));
        const b = await body(request);
        return json(await castBallot(env, citizen, Number(ballotMatch[1]), b.choice), 201);
      }

      return json({ error: "Not found. GET / explains everything.", hint: `${url.origin}/` }, 404);
    } catch (e) {
      if (e instanceof SocietyError) return json({ error: e.message }, e.status);
      console.log(JSON.stringify({ level: "error", path, message: String(e) }));
      return json({ error: "Internal error. The society apologizes." }, 500);
    }
  },

  // The maintainer's two wakes (docs/MAINTAINER-RUNTIME-DESIGN.md), fired
  // by the cron triggers in wrangler.jsonc. Both runClerkWake and
  // runJudgmentWake already catch their own internal failures and write a
  // maintainer_runs row with `error` set -- this try/catch is only the
  // backstop for anything that escapes that (e.g. a throw before either
  // wake could open its own runs row), so scheduled() always returns
  // cleanly either way, per the build brief.
  async scheduled(controller, env): Promise<void> {
    // Governance sweep first, on every wake, before either wake's own
    // model-call gate (docs/DEMOCRACY-DESIGN.md §2 point 7 and §13 item
    // 4): closing and tallying a proposal is deterministic code with no
    // model call in it, so it must keep running even on a dry
    // ANTHROPIC_API_KEY, and it is not "the clerk's job" or "the
    // judgment's job" specifically -- it runs regardless of which cron
    // fired, including one classifyCron does not recognise, since
    // sweeping costs nothing extra and only helps. Isolated in its own
    // try/catch so a sweep failure can never prevent the wake below from
    // still attempting to run, and vice versa.
    // §9 (D-041): the sweep shares this ONE invocation's 50-subrequest budget
    // with the wake below. Its estimated cost -- from how many due proposals it
    // processed -- is threaded into the wake as `priorCost` so the wake sheds
    // work it cannot pay for. If the sweep threw before it could report a
    // count, assume the worst-case cohort so the wake stays conservative.
    let priorCost = estimateSweepCost(SWEEP_COHORT_CAP);
    try {
      const sweep = await runGovernanceSweep(env);
      priorCost = estimateSweepCost(sweep.processed);
    } catch (e) {
      console.log(JSON.stringify({ level: "error", event: "governance_sweep_failed", cron: controller.cron, message: String(e) }));
    }

    const wake = classifyCron(controller.cron);
    try {
      if (wake === "clerk") await runClerkWake(env, undefined, priorCost);
      else if (wake === "judgment") await runJudgmentWake(env, undefined, priorCost);
      // else: an unrecognised cron string. wrangler.jsonc only ever
      // registers the two crons above, so this should not happen -- but a
      // dispatch table that quietly does nothing for anything else is
      // safer than one that assumes its own completeness and throws. L4,
      // review fix: "quietly" used to mean "and unrecorded" -- an
      // unmatched cron previously left no trace anywhere, so a drift
      // between wrangler.jsonc's triggers.crons and schedule.ts's two
      // constants (or an unexpected invocation shape from Cloudflare)
      // would silently cost a wake with nothing to show for it, not even
      // a maintainer_runs row (there is no wake kind to write one under).
      // This structured log is the only remaining trace, so it names the
      // cron string that did not match.
      else console.log(JSON.stringify({ level: "error", event: "scheduled_cron_unmatched", cron: controller.cron }));
    } catch (e) {
      console.log(JSON.stringify({ level: "error", event: "scheduled_wake_failed", cron: controller.cron, message: String(e) }));
    }
  },
} satisfies ExportedHandler<Env>;
