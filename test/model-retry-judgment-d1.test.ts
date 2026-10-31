// D-079 (docs/BRIEF-MODEL-CALL-RETRY.md R9, R13, R18, R21): the judgment wake retries a failed batch call once when the budget affords it, records a
// per-batch audit in maintainer_runs.model_retry (never in `error`), stamps `rerun: ` only when the wake ENDED on a rerunnable failure, and
// carries a spent retry into every later batch gate. Real local D1; the only stub is fetch.
import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, insertCitizen, type LocalD1 } from "./helpers/local-d1.ts";
import { installSubrequestCounter, judgmentDecisionText, rpcBalanceResponse } from "./helpers/subrequest-counter.ts";
import { runJudgmentWake } from "../src/maintainer/judgment.ts";
import { canAffordJudgmentRetry } from "../src/maintainer/budget.ts";
import type { Env } from "../src/society.ts";

const cache = () => ({ pairKey: null, versionRow: null });
const makeEnv = (d1: LocalD1) => ({ DB: d1.DB, ANTHROPIC_API_KEY: "k", TREASURY_ADDRESS: "0x0000000000000000000000000000000000000001", FACILITATOR_URL: "https://facilitator.invalid", REGISTRATION_MODE: "invite_only" }) as unknown as Env;

function seed(d1: LocalD1, bulletins: number): void {
  assert.equal(insertCitizen(d1, { handle: "commonhold-agent", model: "claude-fable-5" }), 1);
  const runId = Number(d1.raw.prepare("INSERT INTO maintainer_runs (kind, started_at) VALUES ('clerk', ?)").run(Date.now() - 86_400_000).lastInsertRowid);
  for (let i = 0; i < bulletins; i++) {
    d1.raw
      .prepare("INSERT INTO maintainer_queue (run_id, created_at, kind, target_type, target_id, source_ref, note, status) VALUES (?, ?, 'bulletin_draft', NULL, NULL, NULL, ?, 'pending')")
      .run(runId, Date.now() - 5_000 + i, `Digest ${i}\nBody number ${i}, all quiet this week.`);
  }
}

type Step = "403" | "401" | "ok" | "abort";
function scripted(script: Step[]) {
  let n = 0;
  const c = installSubrequestCounter((url, init) => {
    if (!url.includes("anthropic")) return rpcBalanceResponse();
    const step = script[Math.min(n, script.length - 1)];
    n++;
    if (step === "abort") {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }
    if (step === "403") return new Response(JSON.stringify({ error: { message: "Request not allowed" } }), { status: 403 });
    if (step === "401") return new Response(JSON.stringify({ error: { message: "invalid x-api-key" } }), { status: 401 });
    const prompt = (JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> }).messages[0].content;
    return new Response(JSON.stringify({ content: [{ type: "text", text: judgmentDecisionText(prompt) }], stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 40 } }), { status: 200 });
  });
  return { c, calls: () => n };
}
const row = (d1: LocalD1) => d1.raw.prepare("SELECT * FROM maintainer_runs WHERE kind = 'judgment' ORDER BY id DESC LIMIT 1").get() as Record<string, unknown>;
const preConsume = (c: { total: () => number; consume: (k: "d1") => void }, n: number) => { for (let i = c.total(); i < n; i++) c.consume("d1"); };

test("403 then a good answer: the batch is actioned, error NULL, model_retry 'batch 1: recovered: ...'", async () => {
  const s = scripted(["403", "ok"]);
  const d1 = createLocalD1({ onExec: s.c.consume });
  try {
    seed(d1, 1);
    await runJudgmentWake(makeEnv(d1), cache());
    const r = row(d1);
    assert.equal(s.calls(), 2);
    assert.equal(r.error, null);
    assert.equal(r.items_actioned, 1);
    assert.equal(r.model_retry, "batch 1: recovered: Anthropic API HTTP 403: Request not allowed");
  } finally {
    s.c.restore();
  }
});

test("R18: batch 1 recovers, batch 2 fails twice: one string, 'rerun: ' leads, both batches named", async () => {
  const s = scripted(["403", "ok", "403", "403"]);
  const d1 = createLocalD1({ onExec: s.c.consume });
  try {
    seed(d1, 2);
    await runJudgmentWake(makeEnv(d1), cache());
    const r = row(d1);
    assert.equal(s.calls(), 4);
    assert.equal(
      r.model_retry,
      "rerun: batch 1: recovered: Anthropic API HTTP 403: Request not allowed; batch 2: failed twice: Anthropic API HTTP 403: Request not allowed | Anthropic API HTTP 403: Request not allowed",
    );
    assert.match(String(r.error), /^model call failed on batch 2 \(stop_reason: http_error\)/);
    assert.equal(r.items_actioned, 1, "batch 1's decision stands");
  } finally {
    s.c.restore();
  }
});

test("R18: 403 then 401: history kept, no rerun prefix", async () => {
  const s = scripted(["403", "401"]);
  const d1 = createLocalD1({ onExec: s.c.consume });
  try {
    seed(d1, 1);
    await runJudgmentWake(makeEnv(d1), cache());
    assert.equal(row(d1).model_retry, "batch 1: failed twice: Anthropic API HTTP 403: Request not allowed | Anthropic API HTTP 401: invalid x-api-key");
  } finally {
    s.c.restore();
  }
});

test("R18: a first-attempt timeout is not retried and the wake is stamped 'rerun: batch 1: failed, timeout not retried: ...'", async () => {
  const s = scripted(["abort"]);
  const d1 = createLocalD1({ onExec: s.c.consume });
  try {
    seed(d1, 1);
    await runJudgmentWake(makeEnv(d1), cache());
    assert.equal(s.calls(), 1);
    assert.match(String(row(d1).model_retry), /^rerun: batch 1: failed, timeout not retried: Anthropic API did not respond/);
  } finally {
    s.c.restore();
  }
});

test("a plain 401 is not retried and leaves model_retry NULL", async () => {
  const s = scripted(["401"]);
  const d1 = createLocalD1({ onExec: s.c.consume });
  try {
    seed(d1, 1);
    await runJudgmentWake(makeEnv(d1), cache());
    assert.equal(s.calls(), 1);
    assert.equal(row(d1).model_retry, null);
  } finally {
    s.c.restore();
  }
});

test("R13: at the budget floor the retry is shed, the run row finalises and the counter never passes 50", async () => {
  const s = scripted(["403"]);
  const d1 = createLocalD1({ onExec: s.c.consume });
  try {
    seed(d1, 1);
    preConsume(s.c, 34); // priorCost 34: a batch may still open (34+6+8+2 = 50) but a retry on top of it may not
    assert.equal(canAffordJudgmentRetry(34, 0, 1), false);
    assert.equal(canAffordJudgmentRetry(33, 0, 1), true);
    await runJudgmentWake(makeEnv(d1), cache(), 34);
    const r = row(d1);
    assert.equal(s.calls(), 1);
    assert.equal(s.c.breached(), false);
    assert.ok(s.c.total() <= 50);
    assert.notEqual(r.finished_at, null);
    assert.equal(r.model_retry, "rerun: batch 1: failed, retry not afforded: Anthropic API HTTP 403: Request not allowed");
  } finally {
    s.c.restore();
  }
});

test("R13: a spent retry is carried into the next batch's gate (priorCost 26: without the carry batch 2 would open, with it batch 2 is shed)", async () => {
  const s = scripted(["403", "ok", "ok"]);
  const d1 = createLocalD1({ onExec: s.c.consume });
  try {
    seed(d1, 2);
    preConsume(s.c, 26);
    await runJudgmentWake(makeEnv(d1), cache(), 26);
    const r = row(d1);
    assert.equal(s.calls(), 2, "batch 1 retried once; batch 2 never opened");
    assert.equal(s.c.breached(), false);
    assert.match(String(r.error), /judgment batches shed for subrequest budget after 1 batch/);
    assert.equal(r.model_retry, "batch 1: recovered: Anthropic API HTTP 403: Request not allowed");
  } finally {
    s.c.restore();
  }
});
