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
export async function callAnthropic(
  env: { ANTHROPIC_API_KEY?: string },
  model: string,
  system: string,
  userContent: string,
): Promise<AnthropicCallResult> {
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

  let body: AnthropicMessageResponse & { error?: { message?: string } };
  try {
    body = (await res.json()) as AnthropicMessageResponse & { error?: { message?: string } };
  } catch {
    return { ok: false, text: "", stopReason: "unparseable_response", usage: EMPTY_USAGE, error: `Anthropic API returned a non-JSON body (HTTP ${res.status})` };
  }

  if (!res.ok) {
    return { ok: false, text: "", stopReason: "http_error", usage: EMPTY_USAGE, error: `Anthropic API HTTP ${res.status}: ${body.error?.message ?? "unknown error"}` };
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
