// The subrequest counter THE PROOF is built on
// (docs/BRIEF-JUDGMENT-QUERY-BUDGET.md). Cloudflare Workers Free allows 50
// subrequests per invocation, and a subrequest is any D1 statement OR any
// outbound fetch() -- they draw from ONE shared pool. The prior wave shipped
// a false "bounded scan" guarantee because it proved the scanner in
// isolation and counted only D1 statements; a proof that counts only D1
// certifies nothing. So this counter wraps BOTH boundaries around ONE shared
// closure:
//
//   - every D1 first()/all()/run() and every statement inside a batch(),
//     via createLocalD1's `onExec` seam (test/helpers/local-d1.ts), and
//   - every outbound globalThis.fetch() -- each Anthropic model call, each
//     Base RPC probe -- via the wrapper installed here.
//
// consume() increments the shared counter and THROWS before executing
// subrequest `limit + 1` (default: before the 51st), exactly as the platform
// would kill the invocation. Because the production code wraps many of its
// own D1/fetch calls in try/catch (callAnthropic converts any fetch throw
// into an ok:false result; runJudgmentWake logs a scan throw into runError;
// scheduled() has a backstop catch), a swallowed throw must not read as a
// pass -- so the counter ALSO latches a `breached` flag the moment the limit
// is first exceeded, and exposes total()/d1()/fetches() after the fact. The
// e2e verdict is `total() <= limit && !breached()`: a well-behaved
// invocation never trips the throw and finishes under budget; a regressed
// one trips it and the flag stays set even if the throw was caught upstream.
//
// This instruments the boundaries; it does not mock the behaviour under test
// (the local-SQLite harness runs real SQL against the real schema, and the
// responder returns real, response-shaped bodies the production parsers
// consume for real). Instrumenting a boundary is not mocking -- the brief's
// "real tests, no mocks" applied honestly to a shared-budget proof.

export interface SubrequestCounter {
  // Passed to createLocalD1({ onExec: counter.consume }) so D1 statements
  // feed the same counter the fetch wrapper does. Also called internally by
  // the installed fetch wrapper for every outbound request.
  consume: (kind: "d1" | "fetch") => void;
  total: () => number;
  d1: () => number;
  fetches: () => number;
  // Latched true the moment the limit is first exceeded. Survives a throw
  // swallowed by production try/catch, so a regression cannot read as green.
  breached: () => boolean;
  restore: () => void;
}

// Installs the counting fetch wrapper on globalThis.fetch and returns the
// shared counter. `respond` produces the response body for a given URL and
// request init -- Anthropic model call, Base RPC probe, whatever the scenario
// drives -- AFTER the fetch has already been counted (so a budget-exceeding
// fetch throws in consume() before respond() is ever consulted). Always
// restore() in a finally block; the wrapper is process-global.
export function installSubrequestCounter(respond: (url: string, init: { body?: unknown } | undefined) => Response | Promise<Response>, limit = 50): SubrequestCounter {
  const original = globalThis.fetch;
  let d1Count = 0;
  let fetchCount = 0;
  let breached = false;

  const consume = (kind: "d1" | "fetch") => {
    if (kind === "fetch") fetchCount++;
    else d1Count++;
    const total = d1Count + fetchCount;
    if (total > limit) {
      breached = true;
      throw new Error(`subrequest budget exceeded: attempted subrequest ${total} of a ${limit}-subrequest invocation (this one is a ${kind}); running totals d1=${d1Count} fetch=${fetchCount}`);
    }
  };

  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    consume("fetch");
    return respond(String(url), init);
  }) as typeof fetch;

  return {
    consume,
    total: () => d1Count + fetchCount,
    d1: () => d1Count,
    fetches: () => fetchCount,
    breached: () => breached,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

// ---------- response-shaped bodies for the two real fetch shapes ----------

const ANTHROPIC_HOST = "api.anthropic.com";

// Recover the prompt string the code under test actually sent. buildRequestBody
// puts the user prompt at messages[0].content as a STRING VALUE, so its own
// quote characters are JSON-escaped in the raw bytes -- parse first, then match
// against the real unescaped prompt (the exact lesson stubAnthropicFetch in
// test/maintainer-judgment-d1.test.ts records).
function promptOf(init: { body?: unknown } | undefined): string {
  const bodyText = typeof init?.body === "string" ? init.body : "";
  try {
    const parsed = JSON.parse(bodyText) as { messages?: Array<{ content?: string }> };
    return parsed.messages?.[0]?.content ?? "";
  } catch {
    return "";
  }
}

function modelOf(init: { body?: unknown } | undefined): string {
  const bodyText = typeof init?.body === "string" ? init.body : "";
  try {
    return (JSON.parse(bodyText) as { model?: string }).model ?? "";
  } catch {
    return "";
  }
}

function anthropicResponse(decisionText: string): Response {
  const body = {
    content: [{ type: "text", text: decisionText }],
    stop_reason: "end_turn",
    usage: { input_tokens: 100, output_tokens: 50 },
  };
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

// The judge's response for a real judgment prompt: parse every
// <queue_item id="N" kind="K"> and return a syntactically valid decision the
// production parseJudgmentDecisions/executeJudgmentDecisions run against for
// real. A flag_review gets action="remove" (an executable moderation, ~5-6
// subrequests); every other approved kind gets action=null (a bulletin_draft
// then posts, ~6 subrequests; bookkeeping/registration are observational).
// `decide` lets a scenario override the verdict per item (e.g. force a reject).
export function judgmentDecisionText(promptText: string, decide?: (id: number, kind: string) => { decision: "approve" | "reject"; reason: string; action: "collapse" | "remove" | "restore" | null }): string {
  const items = [...promptText.matchAll(/queue_item id="(\d+)" kind="([a-z_]+)"/g)].map((m) => ({ id: Number(m[1]), kind: m[2] }));
  const decisions = items.map(({ id, kind }) => {
    if (decide) return { queue_id: id, ...decide(id, kind) };
    const action = kind === "flag_review" ? "remove" : null;
    return { queue_id: id, decision: "approve", reason: "stubbed judge decision for the subrequest-budget proof", action };
  });
  return JSON.stringify(decisions);
}

// The clerk's response: a fixed list of draft items the production
// parseClerkItems accepts, so the insert loop runs for real. Each draft is a
// bookkeeping_note (no target fetch, trivially accepted, never smells
// forbidden) unless the caller supplies its own drafts.
export function clerkDraftText(drafts?: Array<{ kind: string; note: string; target_type?: string | null; target_id?: number | null; source_ref?: string | null }>): string {
  const items = drafts ?? [];
  return JSON.stringify(items.map((d) => ({ kind: d.kind, note: d.note, target_type: d.target_type ?? null, target_id: d.target_id ?? null, source_ref: d.source_ref ?? null })));
}

// A JSON-RPC eth_call result for readOnchainUsdcCents: a 32-byte hex balance.
// Any non-"0x" result makes the drift check treat the RPC as answered, so the
// first RPC in the fallback list wins and the remaining three are never tried
// (the uncontended single-RPC drift cost). Pass a raw balance to vary it.
export function rpcBalanceResponse(rawBalance = 1_000_000n): Response {
  const hex = "0x" + rawBalance.toString(16).padStart(64, "0");
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: hex }), { status: 200, headers: { "content-type": "application/json" } });
}

// Convenience composite responder: dispatches Anthropic model calls (judgment
// vs clerk, by the pinned model name) and Base RPC probes to the right shape.
// A scenario supplies only what it exercises. An unrecognised URL returns a
// benign empty-200 rather than throwing, so an unexpected fetch still counts
// as a subrequest (the honest thing) instead of masking itself as an error.
export function makeModelRpcResponder(opts: {
  judgmentModel: string;
  clerkModel: string;
  onJudgment?: (promptText: string) => string;
  onClerk?: (promptText: string) => string;
  rpcBalance?: bigint;
}): (url: string, init: { body?: unknown } | undefined) => Response {
  return (url, init) => {
    if (url.includes(ANTHROPIC_HOST)) {
      const model = modelOf(init);
      const prompt = promptOf(init);
      if (model === opts.judgmentModel) return anthropicResponse(opts.onJudgment ? opts.onJudgment(prompt) : judgmentDecisionText(prompt));
      if (model === opts.clerkModel) return anthropicResponse(opts.onClerk ? opts.onClerk(prompt) : clerkDraftText([]));
      return anthropicResponse("[]");
    }
    // Anything else is treated as a Base RPC probe (readOnchainUsdcCents).
    return rpcBalanceResponse(opts.rpcBalance ?? 1_000_000n);
  };
}
