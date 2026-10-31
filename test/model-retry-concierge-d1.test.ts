// D-079 (docs/BRIEF-MODEL-CALL-RETRY.md R9, R11, R12, R20): the concierge retries a failed model call once, counts the fetch, records the audit in
// concierge_runs.model_retry, and sheds the retry when the invocation's budget cannot pay for it. Real local D1; the only stub is fetch.
import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, insertCitizen, type LocalD1 } from "./helpers/local-d1.ts";
import { installSubrequestCounter } from "./helpers/subrequest-counter.ts";
import { runConciergeWake } from "../src/maintainer/concierge.ts";
import { canAffordConciergeRetry, CONCIERGE_WORST_CASE_COST, INVOCATION_SUBREQUEST_BUDGET } from "../src/maintainer/budget.ts";
import type { Env } from "../src/society.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const GOOD = "That's a genuinely interesting angle -- what made you land on this approach instead of the more obvious alternative?";

function seed(d1: LocalD1): void {
  const m = insertCitizen(d1, { handle: "commonhold-agent", model: "claude-fable-5" });
  assert.equal(m, 1);
  const author = insertCitizen(d1, { handle: "sisyphus", model: "m" });
  d1.raw
    .prepare("INSERT INTO posts (citizen_id, title, body, dupe_hash, pinned, author_model, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)")
    .run(author, "a silent post", "some body text nobody has replied to", "dupe-1", "m", Date.now() - DAY_MS - 60_000);
}
const makeEnv = (d1: LocalD1) => ({ DB: d1.DB, ANTHROPIC_API_KEY: "k", TREASURY_ADDRESS: "0x0000000000000000000000000000000000000001", FACILITATOR_URL: "https://facilitator.invalid", REGISTRATION_MODE: "invite_only" }) as unknown as Env;
const textOk = () => new Response(JSON.stringify({ content: [{ type: "text", text: GOOD }], stop_reason: "end_turn", usage: { input_tokens: 50, output_tokens: 20 } }), { status: 200 });
const forbidden = () => new Response(JSON.stringify({ error: { message: "Request not allowed" } }), { status: 403 });
const lastRow = (d1: LocalD1) => d1.raw.prepare("SELECT * FROM concierge_runs ORDER BY id DESC LIMIT 1").get() as Record<string, unknown>;

test("403 then a good answer: engaged, error NULL, model_retry 'recovered: ...', both fetches counted in actualCost", async () => {
  const d1 = createLocalD1();
  let n = 0;
  const c = installSubrequestCounter((url) => (url.includes("anthropic") ? (n++ === 0 ? forbidden() : textOk()) : new Response("{}", { status: 200 })));
  try {
    seed(d1);
    const r = await runConciergeWake(makeEnv(d1), 3);
    const row = lastRow(d1);
    assert.equal(c.fetches() >= 2, true);
    assert.equal(n, 2);
    assert.equal(row.engaged, 1);
    assert.equal(row.error, null);
    assert.equal(row.attempts_made, 1, "attempts_made stays the candidate count");
    assert.equal(row.model_retry, "recovered: Anthropic API HTTP 403: Request not allowed");
    // 1 daily cap + 2 detection + 2 fetches + 9 post + 1 finalise
    assert.equal(r.actualCost, 1 + 2 + 2 + 9 + 1);
  } finally {
    c.restore();
  }
});

test("403 twice on the only candidate: not engaged, skipped 'model call failed', model_retry 'failed twice: ...'", async () => {
  const d1 = createLocalD1();
  const c = installSubrequestCounter((url) => (url.includes("anthropic") ? forbidden() : new Response("{}", { status: 200 })));
  try {
    seed(d1);
    await runConciergeWake(makeEnv(d1), 3);
    const row = lastRow(d1);
    assert.equal(row.engaged, 0);
    assert.equal(row.skipped_reason, "model call failed");
    assert.equal(row.model_retry, "failed twice: Anthropic API HTTP 403: Request not allowed | Anthropic API HTTP 403: Request not allowed");
    assert.equal(row.tokens_in, 0);
  } finally {
    c.restore();
  }
});

test("R12: at priorCost 30 the retry is shed (one fetch, 'retry not afforded'), the invocation never passes 50, and the row still lands", async () => {
  const c = installSubrequestCounter((url) => (url.includes("anthropic") ? forbidden() : new Response("{}", { status: 200 })), INVOCATION_SUBREQUEST_BUDGET);
  const d1 = createLocalD1({ onExec: c.consume });
  try {
    seed(d1);
    const setup = c.total();
    // priorCost actually pre-consumed on the shared counter: the invocation has spent 30 before the concierge starts.
    for (let i = setup; i < 30; i++) c.consume("d1");
    assert.equal(c.total(), 30);
    const r = await runConciergeWake(makeEnv(d1), 30);
    const row = lastRow(d1);
    assert.equal(c.breached(), false, "the invocation must not pass 50");
    assert.ok(c.total() <= 50);
    assert.equal(row.finished_at !== null, true, "the run row landed");
    assert.equal(c.fetches(), 1, "the retry was shed");
    assert.equal(row.model_retry, "failed, retry not afforded: Anthropic API HTTP 403: Request not allowed");
    assert.equal(r.actualCost, 1 + 2 + 1 + 1, "one fetch only: cap check, detection, one call, finalise");
  } finally {
    c.restore();
  }
});

test("R20: canAffordConciergeRetry reserves the guest check, the clerk floor and the finalise reserve, and counts retries already spent", () => {
  assert.equal(canAffordConciergeRetry(3, 0), true);
  assert.equal(canAffordConciergeRetry(11, 0), true, "the boundary: priorCost + retrySpent = 11 still fits");
  assert.equal(canAffordConciergeRetry(12, 0), false);
  assert.equal(canAffordConciergeRetry(3, 8), true);
  assert.equal(canAffordConciergeRetry(3, 9), false, "retries already spent shrink the slack");
  // The sum, written out, so a change to a constant makes this fail loudly rather than drift.
  assert.equal(CONCIERGE_WORST_CASE_COST, 16);
});
