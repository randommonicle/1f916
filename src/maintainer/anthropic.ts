// Fetch-based Anthropic Messages API wrapper for the maintainer runtime.
// Model names are pinned in exactly one place (MAINTAINER_MODELS), same
// discipline as server/config/models.ts in the sibling ASH codebase and as
// this repo's own "single source of truth" rules elsewhere.
//
// CRITICAL correctness hazard (learned expensively elsewhere, see the
// header on extractText below): current Claude models run adaptive
// thinking by default, and the first content block in a response may be a
// thinking block, not text. Code that reads content[0] and assumes text is
// wrong the moment a model decides to think before answering.

// D-008/D-009: Fable holds the office (judgment), a cheaper tier does the
// daily rounds (clerk). D-009 specifically chose Sonnet over Haiku for the
// clerk tier as "cheap insurance on judgment quality" within the cage.
export const MAINTAINER_MODELS = {
  clerk: "claude-sonnet-5",
  judgment: "claude-fable-5",
} as const;
export type MaintainerWakeKind = keyof typeof MAINTAINER_MODELS;

// Pricing, USD per million tokens. Source: the claude-api skill's cached
// model table (cache date 2026-06-24) / platform.claude.com/docs/en/pricing.
// These are LIST prices, not the Claude Sonnet 5 introductory rate ($2/$10,
// expires 2026-08-31) -- a hardcoded intro price would go quietly stale the
// day it lapses, which is exactly the failure the ASH sibling app's own
// pricing-table lesson (CLAUDE.md, "the pricing table was WRONG until
// 2026-07-27") warns against repeating. VERIFY AT DEPLOY: prices drift:
// re-check platform.claude.com/docs/en/pricing before the runtime goes
// live, and update this table by commit, not by hand-edit against a live
// database (there is no live database column for this -- these constants
// ARE the source of truth cost_estimate_cents is computed from).
export const ANTHROPIC_PRICING: Record<string, { inputPerMTok: number; outputPerMTok: number }> = {
  "claude-sonnet-5": { inputPerMTok: 3.0, outputPerMTok: 15.0 },
  "claude-fable-5": { inputPerMTok: 10.0, outputPerMTok: 50.0 },
};

// Pure. Throws rather than silently costing at some fallback rate if a
// pinned model has no pricing entry -- see the "every pinned model has a
// pricing entry" test, the enforcement the ASH sibling app's own
// single-source-of-truth rule never had until it was burned by a 5x
// under-report (CLAUDE.md, same lesson cited above).
export function estimateCostCents(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = ANTHROPIC_PRICING[model];
  if (!pricing) {
    throw new Error(`no ANTHROPIC_PRICING entry for model "${model}" -- every pinned model must have one`);
  }
  const dollars = (inputTokens / 1_000_000) * pricing.inputPerMTok + (outputTokens / 1_000_000) * pricing.outputPerMTok;
  return dollars * 100;
}

// Generous on purpose: a JSON-carrying response that hits max_tokens
// truncates mid-object and becomes unparseable. No temperature parameter
// anywhere in this file -- deliberate, not an oversight: the cage (design
// doc S3, S10) keeps the clerk's output shape enforced by the parser, not
// by sampling settings, and the judge's decisions are meant to be
// considered, not creative.
const MAX_TOKENS = 4096;
const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
// L7, review fix: a scheduled Worker with no bound on a single fetch can
// hang indefinitely on a slow or wedged upstream, leaving the wake stuck
// rather than failing cleanly into its own runs row. 120s is generous for
// a single judgment batch (worst case ~100 items of prompt, up to
// MAX_TOKENS of output) while still bounded and diagnosable.
const ANTHROPIC_TIMEOUT_MS = 120_000;

export interface AnthropicContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

export interface AnthropicMessageResponse {
  content: AnthropicContentBlock[];
  stop_reason: string;
  usage: { input_tokens: number; output_tokens: number };
  [key: string]: unknown;
}

// Pure. THE hazard: adaptive thinking means content[0] can be a thinking
// block (or several), never assume position -- find the text block by
// type. Returns null when there is none at all: a pure refusal (empty
// content), a tool-only response, or an all-thinking response with no
// answer. Callers must treat null as "nothing to parse", never as "".
export function extractText(content: AnthropicContentBlock[]): string | null {
  const block = content.find((b) => b.type === "text" && typeof b.text === "string");
  return block ? (block.text as string) : null;
}

// Pure. The live judgment wake on 2026-08-16 (maintainer run 11) actioned
// ZERO items because the judge model returned its JSON verdict wrapped in a
// Markdown code fence (three backticks, then `json`, a newline, the array,
// a newline, a closing fence). The bare JSON.parse both maintainer parsers do
// threw "response was not valid JSON" and every fenced run since would repeat
// it. This strips a SURROUNDING code fence when present -- an opening fence of
// exactly three backticks, an optional language tag, and a newline, plus a
// matching closing fence at the very end, with surrounding whitespace ignored
// -- and returns the inner text for the caller to JSON.parse. It is a shared
// pre-parse step for BOTH the judgment and clerk parsers.
//
// Deliberately narrow and non-destructive: text with NO surrounding fence is
// returned UNCHANGED (the original string, not even trimmed), so already-clean
// JSON parses byte-identically to before -- the fence tolerance adds a case,
// it never alters the existing one. Genuinely unparseable text, fenced or not,
// still reaches JSON.parse and still throws the caller's own loud
// "...response was not valid JSON" error: this tolerates the fence, never
// real garbage (honest-failure-surfacing). Only a fence wrapping the WHOLE
// content is stripped; trailing prose after the closing fence does not match,
// so it falls through to the honest parse error rather than being silently
// half-read.
export function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  // ^```<optional-lang>\n  ...content...  \n```$  (CR-tolerant on both newlines)
  const fence = /^```[a-zA-Z0-9_-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/.exec(trimmed);
  return fence ? fence[1] : text;
}

// Pure. The request body, isolated so its shape (no temperature, the
// generous fixed max_tokens) is directly assertable in tests rather than
// only claimed in a comment.
export function buildRequestBody(model: string, system: string, userContent: string): Record<string, unknown> {
  return {
    model,
    max_tokens: MAX_TOKENS,
    system,
    messages: [{ role: "user", content: userContent }],
  };
}

export interface AnthropicCallResult {
  ok: boolean;
  text: string;
  stopReason: string;
  usage: { input_tokens: number; output_tokens: number };
  error?: string;
  // D-079 (docs/BRIEF-MODEL-CALL-RETRY.md R8, R18): HTTP fetches made, 1 or 2.
  attempts: 1 | 2;
  // null unless the call ended in a retryable-class failure or recovered from
  // one. Exactly these shapes: `recovered: <first error>`, `failed twice:
  // <first> | <second>`, `failed, retry not afforded: <first>`, `failed,
  // timeout not retried: <error>`. `error` keeps its old meaning (the final
  // failure only).
  retryNote: string | null;
  // True when the call ENDED failed on a status/outcome a fresh invocation
  // could plausibly cure (a retryable status, network_error or timeout).
  finalRerunnable: boolean;
}

export interface AnthropicCallOptions {
  // The caller's budget verdict (R4): false means a retry would breach the
  // invocation's subrequest budget, so the first failure is final.
  mayRetry?: boolean;
  // Injectable so tests assert the wait without waiting (R23).
  sleep?: (ms: number) => Promise<void>;
}

// Statuses worth exactly one more try (A1). 401/400/404/413 are not: a bad
// key or a bad request is not cured by repeating it.
export const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([403, 429, 500, 502, 503, 504, 529]);
const RETRY_DELAY_MIN_MS = 2000;
const RETRY_DELAY_MAX_MS = 10_000;

// Pure (R2). 2 s, or `retry-after` seconds clamped to 2..10 s when the header
// parses as a non-negative number of seconds; anything else waits 2 s.
export function retryDelayMs(retryAfter: string | null | undefined): number {
  if (retryAfter == null || !/^\s*\d+(\.\d+)?\s*$/.test(retryAfter)) return RETRY_DELAY_MIN_MS;
  return Math.min(RETRY_DELAY_MAX_MS, Math.max(RETRY_DELAY_MIN_MS, Math.round(Number(retryAfter) * 1000)));
}

const EMPTY_USAGE = { input_tokens: 0, output_tokens: 0 };

// Pure. Distinguishes an aborted-by-us request (the timeout below) from
// any other fetch failure, so the caller gets an honest, specific
// stopReason ("timeout") rather than being lumped in with a generic
// "network_error" that could just as easily mean the API is genuinely
// unreachable -- a distinction worth keeping in the public runs-row
// record, since one is "we gave up waiting" and the other is "it never
// answered at all". Matches both the DOMException a real aborted fetch
// throws and a plain Error with the same .name, for testability without
// needing a real network call (see maintainer-anthropic.test.ts).
export function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError";
}

// The only impure function in this file. stop_reason: "refusal" and a
// truncated/no-text response are both handled explicitly here -- neither
// throws; both come back as a typed, ok:false (or ok:true-with-a-flagged-
// stopReason) result the caller decides what to do with. Callers still
// see usage/tokens for a refusal (Anthropic bills nothing for a pre-output
// decline, but the field is threaded through honestly either way rather
// than assumed zero).
type AttemptResult = Omit<AnthropicCallResult, "attempts" | "retryNote" | "finalRerunnable"> & { status?: number; retryAfter?: string | null };

async function attemptOnce(
  env: { ANTHROPIC_API_KEY?: string },
  model: string,
  system: string,
  userContent: string,
): Promise<AttemptResult> {
  if (!env.ANTHROPIC_API_KEY) {
    // Callers are expected to check this before ever reaching here (see
    // clerk.ts/judgment.ts's own no-key skip, which never even builds a
    // prompt) -- this is a defence-in-depth backstop, not the primary gate.
    return { ok: false, text: "", stopReason: "no_api_key", usage: EMPTY_USAGE, error: "ANTHROPIC_API_KEY is not set" };
  }

  // L7: bounds the single fetch below so a hung or wedged upstream cannot
  // leave a scheduled wake running indefinitely -- see ANTHROPIC_TIMEOUT_MS.
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ANTHROPIC_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: JSON.stringify(buildRequestBody(model, system, userContent)),
      signal: ctrl.signal,
    });
  } catch (e) {
    if (isAbortError(e)) {
      return { ok: false, text: "", stopReason: "timeout", usage: EMPTY_USAGE, error: `Anthropic API did not respond within ${ANTHROPIC_TIMEOUT_MS / 1000}s` };
    }
    return { ok: false, text: "", stopReason: "network_error", usage: EMPTY_USAGE, error: `could not reach the Anthropic API: ${String(e)}` };
  } finally {
    clearTimeout(timer);
  }

  // R1: status before body. A 502/503/504/529 or an edge 403 often carries an
  // HTML or text body; it is an http_error carrying the status either way.
  if (!res.ok) {
    let message = "non-JSON body";
    try {
      const errBody = (await res.json()) as { error?: { message?: string } };
      message = errBody?.error?.message ?? "unknown error";
    } catch {
      // keep the "non-JSON body" note
    }
    return { ok: false, text: "", stopReason: "http_error", usage: EMPTY_USAGE, error: `Anthropic API HTTP ${res.status}: ${message}`, status: res.status, retryAfter: res.headers.get("retry-after") };
  }

  let body: AnthropicMessageResponse;
  try {
    body = (await res.json()) as AnthropicMessageResponse;
  } catch {
    return { ok: false, text: "", stopReason: "unparseable_response", usage: EMPTY_USAGE, error: `Anthropic API returned a non-JSON body (HTTP ${res.status})` };
  }

  const usage = body.usage ?? EMPTY_USAGE;

  if (body.stop_reason === "refusal") {
    return { ok: false, text: "", stopReason: "refusal", usage, error: "the model declined to answer (safety classifier)" };
  }

  const text = extractText(body.content ?? []);
  if (text == null) {
    return { ok: false, text: "", stopReason: body.stop_reason, usage, error: "no text block in the response content" };
  }

  // stop_reason "max_tokens" is intentionally NOT special-cased into a
  // failure here: it flows through as ok:true with stopReason set, so a
  // caller's own JSON.parse either succeeds (the truncation landed after
  // the useful content) or throws -- and when it throws, the caller logs
  // stop_reason alongside the parse error, which is what makes a
  // truncation-caused failure diagnosable rather than a bare "invalid
  // JSON" (the exact class of silent failure CLAUDE.md's max_tokens
  // lesson, in the ASH sibling app, describes).
  return { ok: true, text, stopReason: body.stop_reason, usage };
}

function isRetryableAttempt(r: AttemptResult): boolean {
  return !r.ok && ((r.stopReason === "http_error" && r.status != null && RETRYABLE_STATUSES.has(r.status)) || r.stopReason === "network_error");
}

function addUsage(a: { input_tokens: number; output_tokens: number }, b: { input_tokens: number; output_tokens: number }) {
  return { input_tokens: a.input_tokens + b.input_tokens, output_tokens: a.output_tokens + b.output_tokens };
}

function strip(r: AttemptResult): Omit<AnthropicCallResult, "attempts" | "retryNote" | "finalRerunnable"> {
  const { status: _s, retryAfter: _r, ...rest } = r;
  return rest;
}

// D-079: one model call with at most ONE retry (never a loop), only for a
// transient-class failure (A1) and only when the caller says the budget
// affords the extra fetch. See docs/BRIEF-MODEL-CALL-RETRY.md.
export async function callAnthropic(
  env: { ANTHROPIC_API_KEY?: string },
  model: string,
  system: string,
  userContent: string,
  opts: AnthropicCallOptions = {},
): Promise<AnthropicCallResult> {
  const first = await attemptOnce(env, model, system, userContent);
  if (first.ok) return { ...strip(first), attempts: 1, retryNote: null, finalRerunnable: false };
  if (first.stopReason === "timeout") {
    return { ...strip(first), attempts: 1, retryNote: `failed, timeout not retried: ${first.error}`, finalRerunnable: true };
  }
  if (!isRetryableAttempt(first)) {
    return { ...strip(first), attempts: 1, retryNote: null, finalRerunnable: false };
  }
  if (!opts.mayRetry) {
    return { ...strip(first), attempts: 1, retryNote: `failed, retry not afforded: ${first.error}`, finalRerunnable: true };
  }
  await (opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))))(retryDelayMs(first.retryAfter));
  const second = await attemptOnce(env, model, system, userContent);
  const usage = addUsage(first.usage, second.usage);
  if (second.ok) return { ...strip(second), usage, attempts: 2, retryNote: `recovered: ${first.error}`, finalRerunnable: false };
  return {
    ...strip(second),
    usage,
    attempts: 2,
    retryNote: `failed twice: ${first.error} | ${second.error}`,
    finalRerunnable: second.stopReason === "timeout" || isRetryableAttempt(second),
  };
}
