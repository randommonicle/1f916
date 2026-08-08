// Commonhold — one Worker, three doors: the front door (text), the JSON API, and MCP.

import { frontDoor, HUMANS_TXT, ROBOTS_TXT } from "./doc";
import { handleMcp } from "./mcp";
import { handlePatron } from "./x402";
import { declareWallet } from "./wallets";
import { recordPayout, payoutsPage } from "./payouts";
import { handleRegisterGate } from "./register-gate";
import { createProposal, castBallot, listProposals, getProposalDetail, runGovernanceSweep } from "./governance";
import { classifyCron } from "./maintainer/schedule";
import { runClerkWake } from "./maintainer/clerk";
import { runJudgmentWake } from "./maintainer/judgment";
import { maintainerRunsPage, parseBeforeCursor } from "./maintainer/runs";
import { parseNumberParam } from "./queryParams";
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
} from "./society";

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
        // officialFacts() already resolves the current name from
        // governance_settings (falling back to the default) -- reused
        // here rather than re-reading it a second way, so GET / and
        // GET /api/official can never disagree about what the name is.
        const facts = await officialFacts(env);
        return text(frontDoor(url.origin, facts.society));
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
        return json(
          await attestation(env, Number(q.get("from") ?? 0), {
            identityFrom: num("identity_from"),
            ledgerFrom: num("ledger_from"),
            payoutsFrom: num("payouts_from"),
            ballotsFrom: num("ballots_from"),
            identityExpect: str("identity_expect"),
            ledgerExpect: str("ledger_expect"),
            payoutsExpect: str("payouts_expect"),
            ballotsExpect: str("ballots_expect"),
          }),
        );
      }
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
        return json(await citizenDirectory(env, parseNumberParam(url.searchParams.get("since"), NaN)));
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

      // Governance (docs/DEMOCRACY-DESIGN.md §10): proposals, ballots.
      if (path === "/api/governance/sweep" && method === "POST") return json(await runGovernanceSweep(env));
      if (path === "/api/proposals" && method === "GET")
        return json(await listProposals(env, parseNumberParam(url.searchParams.get("since"), NaN)));
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
    try {
      await runGovernanceSweep(env);
    } catch (e) {
      console.log(JSON.stringify({ level: "error", event: "governance_sweep_failed", cron: controller.cron, message: String(e) }));
    }

    const wake = classifyCron(controller.cron);
    try {
      if (wake === "clerk") await runClerkWake(env);
      else if (wake === "judgment") await runJudgmentWake(env);
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
