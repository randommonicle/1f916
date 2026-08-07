// Tests for the maintainer runtime's Anthropic API wrapper: pure logic
// only (extractText, buildRequestBody, estimateCostCents, isAbortError).
// callAnthropic itself makes a real fetch() call and is not exercised
// here -- no network in this suite, per the repo's own convention (see
// wallets.test.ts / payouts.test.ts's header notes on what's accepted as
// manual-only coverage at this project's scale). The L7 timeout's error-
// classification logic (isAbortError) is pure and IS covered directly;
// the full wiring (a real hung request actually getting aborted after
// ANTHROPIC_TIMEOUT_MS) was verified manually against a local server that
// never responds -- see the review-fixes checkpoint log entry for L7.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import {
  MAINTAINER_MODELS,
  ANTHROPIC_PRICING,
  estimateCostCents,
  extractText,
  buildRequestBody,
  isAbortError,
  type AnthropicContentBlock,
} from "../src/maintainer/anthropic.ts";

// ---------- extractText: the thinking-block-first hazard ----------

test("extractText finds the text block when a thinking block comes first", () => {
  const content: AnthropicContentBlock[] = [
    { type: "thinking", thinking: "reasoning about the request..." },
    { type: "text", text: "here is my answer" },
  ];
  assert.equal(extractText(content), "here is my answer");
});

test("extractText finds the text block past MULTIPLE thinking blocks", () => {
  const content: AnthropicContentBlock[] = [
    { type: "thinking", thinking: "first pass" },
    { type: "thinking", thinking: "second pass" },
    { type: "text", text: "final answer" },
  ];
  assert.equal(extractText(content), "final answer");
});

test("extractText on a text-first response (no thinking) still works", () => {
  const content: AnthropicContentBlock[] = [{ type: "text", text: "plain answer" }];
  assert.equal(extractText(content), "plain answer");
});

test("extractText returns null on a response with no text block at all (e.g. a pure refusal or tool-only response)", () => {
  const allThinking: AnthropicContentBlock[] = [{ type: "thinking", thinking: "..." }];
  assert.equal(extractText(allThinking), null);

  const empty: AnthropicContentBlock[] = [];
  assert.equal(extractText(empty), null);

  const toolOnly: AnthropicContentBlock[] = [{ type: "tool_use", id: "t1", name: "x", input: {} }];
  assert.equal(extractText(toolOnly), null);
});

test("extractText does not mistake content[0] for the answer -- the hazard this function exists to close", () => {
  // If this were implemented as `content[0].text`, this fixture would
  // return undefined (or throw) instead of the real answer at index 2.
  const content: AnthropicContentBlock[] = [
    { type: "thinking", thinking: "a" },
    { type: "thinking", thinking: "b" },
    { type: "text", text: "the real answer" },
  ];
  assert.notEqual((content[0] as { text?: string }).text, "the real answer");
  assert.equal(extractText(content), "the real answer");
});

// ---------- buildRequestBody: generous max_tokens, no temperature ----------

test("buildRequestBody never includes a temperature parameter", () => {
  const body = buildRequestBody("claude-sonnet-5", "system prompt", "user content");
  assert.equal("temperature" in body, false);
});

test("buildRequestBody uses a generous fixed max_tokens", () => {
  const body = buildRequestBody("claude-sonnet-5", "system prompt", "user content");
  assert.equal(body.max_tokens, 4096);
});

test("buildRequestBody carries the model, system, and a single user message", () => {
  const body = buildRequestBody("claude-fable-5", "be terse", "hello") as {
    model: string;
    system: string;
    messages: { role: string; content: string }[];
  };
  assert.equal(body.model, "claude-fable-5");
  assert.equal(body.system, "be terse");
  assert.deepEqual(body.messages, [{ role: "user", content: "hello" }]);
});

// ---------- pricing: every pinned model has an entry ----------

test("every pinned MAINTAINER_MODELS entry has a pricing entry", () => {
  for (const [role, model] of Object.entries(MAINTAINER_MODELS)) {
    assert.ok(ANTHROPIC_PRICING[model], `no ANTHROPIC_PRICING entry for the ${role} model "${model}"`);
  }
});

test("estimateCostCents throws for a model with no pricing entry, rather than costing at some fallback rate", () => {
  assert.throws(() => estimateCostCents("claude-nonexistent-model", 1000, 1000), /no ANTHROPIC_PRICING entry/);
});

// ---------- estimateCostCents arithmetic ----------

test("estimateCostCents computes input+output cost correctly for a known model", () => {
  // Sonnet 5: $3.00/$15.00 per MTok. 1,000,000 input + 1,000,000 output = $3 + $15 = $18 = 1800 cents.
  assert.equal(estimateCostCents("claude-sonnet-5", 1_000_000, 1_000_000), 1800);
});

test("estimateCostCents scales linearly with token count", () => {
  const small = estimateCostCents("claude-sonnet-5", 50_000, 4_000);
  const double = estimateCostCents("claude-sonnet-5", 100_000, 8_000);
  assert.ok(Math.abs(double - small * 2) < 1e-9);
});

test("estimateCostCents on a tiny idle-adjacent wake is a small positive fraction of a cent, not zero", () => {
  // A near-empty clerk wake: a few hundred input tokens, a short JSON reply.
  const cents = estimateCostCents("claude-sonnet-5", 300, 50);
  assert.ok(cents > 0, "a real call must never estimate to exactly zero cost");
  assert.ok(cents < 1, "this call is genuinely sub-cent");
});

test("estimateCostCents(0, 0) is exactly zero", () => {
  assert.equal(estimateCostCents("claude-fable-5", 0, 0), 0);
});

// ---------- isAbortError: distinguishing a timeout from any other fetch failure (L7) ----------

test("isAbortError recognises a real DOMException named AbortError -- what fetch actually throws on abort", () => {
  // The exact shape a real aborted fetch() rejects with, in both browsers
  // and workerd (Cloudflare's runtime): a DOMException whose .name is
  // "AbortError". Constructed directly here (no real fetch, no network)
  // since DOMException is a standard global.
  assert.ok(isAbortError(new DOMException("The operation was aborted", "AbortError")));
});

test("isAbortError also recognises a plain Error with .name set to AbortError (defensive, not just DOMException)", () => {
  const e = new Error("aborted");
  e.name = "AbortError";
  assert.ok(isAbortError(e));
});

test("isAbortError returns false for an ordinary network error, so it is never mistaken for a timeout", () => {
  assert.equal(isAbortError(new TypeError("fetch failed")), false);
  assert.equal(isAbortError(new Error("some other failure")), false);
});

test("isAbortError returns false for a non-Error value, never throws", () => {
  assert.equal(isAbortError("not an error"), false);
  assert.equal(isAbortError(null), false);
  assert.equal(isAbortError(undefined), false);
  assert.equal(isAbortError({ name: "AbortError" }), false); // not an Error instance
});
