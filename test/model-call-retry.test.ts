// D-079 (docs/BRIEF-MODEL-CALL-RETRY.md R1, R2, R7, R8, R11, R18, R23, R24): callAnthropic retries a transient failure ONCE. A stub fetch
// stands in for the network (no mock of our own code); the wait goes through an injectable sleep so the delays are asserted, not waited.
import { test } from "node:test";
import assert from "node:assert/strict";
import { callAnthropic, retryDelayMs, type AnthropicCallResult } from "../src/maintainer/anthropic.ts";

type Step = { status: number; body?: string; headers?: Record<string, string> } | "network" | "abort";

function stubFetch(steps: Step[]): { calls: () => number; restore: () => void } {
  const original = globalThis.fetch;
  let n = 0;
  globalThis.fetch = (async () => {
    const step = steps[Math.min(n, steps.length - 1)];
    n++;
    if (step === "network") throw new TypeError("fetch failed");
    if (step === "abort") {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }
    return new Response(step.body ?? "{}", { status: step.status, headers: step.headers });
  }) as typeof fetch;
  return { calls: () => n, restore: () => { globalThis.fetch = original; } };
}

const OK: Step = {
  status: 200,
  body: JSON.stringify({ content: [{ type: "text", text: "hi" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } }),
};
const http = (status: number, message = "Request not allowed"): Step => ({ status, body: JSON.stringify({ error: { message } }) });

async function run(steps: Step[], mayRetry = true): Promise<{ r: AnthropicCallResult; calls: number; waits: number[] }> {
  const stub = stubFetch(steps);
  const waits: number[] = [];
  try {
    const r = await callAnthropic({ ANTHROPIC_API_KEY: "k" }, "m", "s", "u", { mayRetry, sleep: async (ms) => { waits.push(ms); } });
    return { r, calls: stub.calls(), waits };
  } finally {
    stub.restore();
  }
}

test("403 then 200 succeeds on attempt 2, error absent, retryNote 'recovered: <first>'", async () => {
  const { r, calls, waits } = await run([http(403), OK]);
  assert.equal(r.ok, true);
  assert.equal(calls, 2);
  assert.equal(r.attempts, 2);
  assert.equal(r.error, undefined);
  assert.equal(r.retryNote, "recovered: Anthropic API HTTP 403: Request not allowed");
  assert.equal(r.finalRerunnable, false);
  assert.deepEqual(waits, [2000]);
});

test("403 then 403: error is the second failure, retryNote 'failed twice: first | second', rerunnable", async () => {
  const { r, calls } = await run([http(403, "one"), http(403, "two")]);
  assert.equal(r.ok, false);
  assert.equal(calls, 2);
  assert.equal(r.attempts, 2);
  assert.equal(r.error, "Anthropic API HTTP 403: two");
  assert.equal(r.retryNote, "failed twice: Anthropic API HTTP 403: one | Anthropic API HTTP 403: two");
  assert.equal(r.finalRerunnable, true);
});

test("403 then 401: history kept, final failure not rerunnable (R18)", async () => {
  const { r } = await run([http(403), http(401, "bad key")]);
  assert.equal(r.attempts, 2);
  assert.equal(r.retryNote, "failed twice: Anthropic API HTTP 403: Request not allowed | Anthropic API HTTP 401: bad key");
  assert.equal(r.finalRerunnable, false);
});

test("a first-attempt timeout is not retried but is rerunnable, with its own note (R18)", async () => {
  const { r, calls } = await run(["abort", OK]);
  assert.equal(calls, 1);
  assert.equal(r.attempts, 1);
  assert.equal(r.stopReason, "timeout");
  assert.equal(r.finalRerunnable, true);
  assert.ok(r.retryNote?.startsWith("failed, timeout not retried: Anthropic API did not respond"));
});

test("mayRetry false: one fetch, 'failed, retry not afforded: <first>', rerunnable", async () => {
  const { r, calls } = await run([http(503), OK], false);
  assert.equal(calls, 1);
  assert.equal(r.attempts, 1);
  assert.equal(r.retryNote, "failed, retry not afforded: Anthropic API HTTP 503: Request not allowed");
  assert.equal(r.finalRerunnable, true);
});

test("R1: a 503 with an HTML body is an http_error and IS retried (red against status-after-body parsing)", async () => {
  const { r, calls } = await run([{ status: 503, body: "<html>upstream down</html>" }, OK]);
  assert.equal(calls, 2);
  assert.equal(r.ok, true);
  assert.equal(r.retryNote, "recovered: Anthropic API HTTP 503: non-JSON body");
});

test("a second attempt that times out: failed twice, rerunnable", async () => {
  const { r } = await run([http(529, "overloaded"), "abort"]);
  assert.equal(r.attempts, 2);
  assert.ok(r.retryNote?.startsWith("failed twice: Anthropic API HTTP 529: overloaded | "));
  assert.equal(r.finalRerunnable, true);
});

test("usage sums across attempts (failed attempts return none, so the sum is the success)", async () => {
  const { r } = await run([http(500), OK]);
  assert.deepEqual(r.usage, { input_tokens: 10, output_tokens: 5 });
});

// R24: every excluded status, one fetch and attempts === 1.
const NOT_RETRIED: [string, Step][] = [
  ["400", http(400, "bad request")],
  ["401", http(401, "bad key")],
  ["404", http(404, "nope")],
  ["413", http(413, "too big")],
  ["refusal", { status: 200, body: JSON.stringify({ content: [], stop_reason: "refusal", usage: { input_tokens: 1, output_tokens: 0 } }) }],
  ["timeout", "abort"],
  ["2xx unparseable", { status: 200, body: "not json at all" }],
  ["2xx no text block", { status: 200, body: JSON.stringify({ content: [], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 0 } }) }],
];
for (const [name, step] of NOT_RETRIED) {
  test(`not retried: ${name} makes exactly one fetch, attempts 1`, async () => {
    const { r, calls, waits } = await run([step, OK]);
    assert.equal(calls, 1);
    assert.equal(r.attempts, 1);
    assert.equal(r.ok, false);
    assert.deepEqual(waits, []);
  });
}

const RETRIED: [string, Step][] = [
  ["403", http(403)],
  ["429", http(429)],
  ["500", http(500)],
  ["502", http(502)],
  ["503", http(503)],
  ["504", http(504)],
  ["529", http(529)],
  ["network error", "network"],
];
for (const [name, step] of RETRIED) {
  test(`retried once: ${name} then 200 makes two fetches and recovers`, async () => {
    const { r, calls } = await run([step, OK]);
    assert.equal(calls, 2);
    assert.equal(r.attempts, 2);
    assert.equal(r.ok, true);
  });
  test(`never a loop: ${name} twice makes exactly two fetches`, async () => {
    const { calls, r } = await run([step, step, OK]);
    assert.equal(calls, 2);
    assert.equal(r.ok, false);
  });
}

// R23: the wait, through the injectable sleep.
for (const [header, expected] of [[undefined, 2000], ["1", 2000], ["5", 5000], ["30", 10000], ["soon", 2000]] as [string | undefined, number][]) {
  test(`retry-after ${header === undefined ? "absent" : JSON.stringify(header)} waits ${expected} ms`, async () => {
    const { waits } = await run([{ status: 429, body: "{}", headers: header === undefined ? {} : { "retry-after": header } }, OK]);
    assert.deepEqual(waits, [expected]);
  });
}

test("retryDelayMs is pure and clamps 2..10 s", () => {
  assert.equal(retryDelayMs(null), 2000);
  assert.equal(retryDelayMs("0"), 2000);
  assert.equal(retryDelayMs("7.5"), 7500);
  assert.equal(retryDelayMs("999"), 10000);
  assert.equal(retryDelayMs("-3"), 2000);
});
