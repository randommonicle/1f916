// A model REFUSAL on one judgment queue item skips that item for the wake instead of ending the wake
// (docs: drafts/BRIEF-JUDGMENT-REFUSAL-SKIP-2026-11-09.md). Real local D1; the only stub is fetch.
// T1-T5 are the defect tests (red against the old generic break). R1 is the regression control (green before and after).
import test, { before } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import { createLocalD1, insertCitizen, type LocalD1 } from "./helpers/local-d1.ts";
import { installSubrequestCounter, makeModelRpcResponder, judgmentDecisionText, rpcBalanceResponse } from "./helpers/subrequest-counter.ts";
import { MAINTAINER_MODELS } from "../src/maintainer/anthropic.ts";
import { JUDGMENT_CRON } from "../src/maintainer/schedule.ts";
import { runJudgmentWake } from "../src/maintainer/judgment.ts";
import { maintainerRunsPage } from "../src/maintainer/runs.ts";
import { detectConstitutionChange } from "../src/governance.ts";
import type { Env } from "../src/society.ts";

const cache = () => ({ pairKey: null, versionRow: null });
const makeEnv = (d1: LocalD1) => ({ DB: d1.DB, ANTHROPIC_API_KEY: "k", TREASURY_ADDRESS: "0x0000000000000000000000000000000000000001", FACILITATOR_URL: "https://facilitator.invalid", REGISTRATION_MODE: "invite_only" }) as unknown as Env;

before(async () => {
  const warm = createLocalD1();
  try {
    await detectConstitutionChange({ DB: warm.DB, TREASURY_ADDRESS: "0x0", REGISTRATION_MODE: "invite_only" } as unknown as Env, Date.now());
  } finally {
    warm.close();
  }
});

// Seeds n pending bulletin drafts, oldest first; returns their queue ids in scan order.
function seed(d1: LocalD1, n: number): number[] {
  assert.equal(insertCitizen(d1, { handle: "commonhold-agent", model: "claude-fable-5" }), 1);
  const runId = Number(d1.raw.prepare("INSERT INTO maintainer_runs (kind, started_at) VALUES ('clerk', ?)").run(Date.now() - 86_400_000).lastInsertRowid);
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = d1.raw
      .prepare("INSERT INTO maintainer_queue (run_id, created_at, kind, target_type, target_id, source_ref, note, status) VALUES (?, ?, 'bulletin_draft', NULL, NULL, NULL, ?, 'pending')")
      .run(runId, Date.now() - 5_000 + i, `Digest ${i}\nBody number ${i}, all quiet this week.`);
    ids.push(Number(r.lastInsertRowid));
  }
  return ids;
}

const refusalBody = () => new Response(JSON.stringify({ content: [], stop_reason: "refusal", usage: { input_tokens: 100, output_tokens: 0 } }), { status: 200 });
const okBody = (prompt: string) => new Response(JSON.stringify({ content: [{ type: "text", text: judgmentDecisionText(prompt) }], stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 40 } }), { status: 200 });
const promptOf = (init: { body?: unknown } | undefined) => (JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> }).messages[0].content;

// `refuse(prompt)` decides per call whether the model refuses.
function model(refuse: (prompt: string) => boolean, failStatus?: number) {
  let n = 0;
  const c = installSubrequestCounter((url, init) => {
    if (!url.includes("anthropic")) return rpcBalanceResponse();
    n++;
    if (failStatus) return new Response(JSON.stringify({ error: { message: "boom" } }), { status: failStatus });
    const p = promptOf(init);
    return refuse(p) ? refusalBody() : okBody(p);
  });
  return { c, calls: () => n };
}
const row = (d1: LocalD1) => d1.raw.prepare("SELECT * FROM maintainer_runs WHERE kind = 'judgment' ORDER BY id DESC LIMIT 1").get() as Record<string, unknown>;
const statusOf = (d1: LocalD1, id: number) => (d1.raw.prepare("SELECT status FROM maintainer_queue WHERE id = ?").get(id) as { status: string }).status;

test("T1: two pending, item 1 refused, item 2 approved: item 2 executed the same wake, item 1 pending, named in error", async () => {
  const d1Ref: { d1?: LocalD1 } = {};
  const m = model((p) => p.includes("Digest 0"));
  const d1 = createLocalD1({ onExec: m.c.consume });
  d1Ref.d1 = d1;
  try {
    const ids = seed(d1, 2);
    await runJudgmentWake(makeEnv(d1), cache());
    const r = row(d1);
    assert.equal(m.calls(), 2, "the wake went on to the second item");
    assert.equal(statusOf(d1, ids[0]), "pending", "refused item stays pending");
    assert.equal(statusOf(d1, ids[1]), "approved", "second item decided in the same wake");
    assert.equal(r.items_actioned, 1);
    assert.match(String(r.error), new RegExp(`bulletin_draft item ${ids[0]} not judged \\(the model declined\\); skipped this wake`));
    assert.equal(r.overflow_dropped, 0);
    assert.equal(r.model_retry, null);
  } finally {
    m.c.restore();
    d1.close();
  }
});

test("T2: one pending item, refused: exactly one model call (no drained-cursor reselect), item pending, overflow 0", async () => {
  const m = model(() => true);
  const d1 = createLocalD1({ onExec: m.c.consume });
  try {
    const ids = seed(d1, 1);
    await runJudgmentWake(makeEnv(d1), cache());
    const r = row(d1);
    assert.equal(m.calls(), 1);
    assert.equal(statusOf(d1, ids[0]), "pending");
    assert.equal(r.overflow_dropped, 0);
    assert.match(String(r.error), /not judged \(the model declined\)/);
  } finally {
    m.c.restore();
    d1.close();
  }
});

test("T3: five pending, all refused: four model calls (batch cap), nothing executed, overflow_dropped 1", async () => {
  const m = model(() => true);
  const d1 = createLocalD1({ onExec: m.c.consume });
  try {
    const ids = seed(d1, 5);
    await runJudgmentWake(makeEnv(d1), cache());
    const r = row(d1);
    assert.equal(m.calls(), 4);
    for (const id of ids) assert.equal(statusOf(d1, id), "pending");
    assert.equal(r.items_actioned, 0);
    assert.equal(r.overflow_dropped, 1);
    assert.equal((String(r.error).match(/not judged \(the model declined\)/g) ?? []).length, 4);
  } finally {
    m.c.restore();
    d1.close();
  }
});

test("T4: the /api/maintainer-runs note carries the refusal sentence", async () => {
  const d1 = createLocalD1();
  try {
    const page = await maintainerRunsPage(makeEnv(d1));
    assert.match(page.note, /a judgment item the model declined to judge is named in error by kind and id, left pending, skipped for that wake and not counted in overflow_dropped, and offered again at the next wake/);
  } finally {
    d1.close();
  }
});

test("R1 (regression control): a non-refusal failure (http_error 500 after retry) still breaks after one batch", async () => {
  const m = model(() => false, 500);
  const d1 = createLocalD1({ onExec: m.c.consume });
  try {
    const ids = seed(d1, 3);
    await runJudgmentWake(makeEnv(d1), cache());
    const r = row(d1);
    assert.ok(m.calls() <= 2, `one batch only (call + at most one retry), saw ${m.calls()}`);
    assert.match(String(r.error), /model call failed on batch 1/);
    assert.doesNotMatch(String(r.error), /not judged/);
    for (const id of ids) assert.equal(statusOf(d1, id), "pending");
  } finally {
    m.c.restore();
    d1.close();
  }
});

test("T5 (defect test; its budget assertions only bite on the continued path): a refusal in batch 1 of a four-batch scheduled wake runs all four batches and stays within the 50-subrequest budget", async () => {
  const rpc = makeModelRpcResponder({ judgmentModel: MAINTAINER_MODELS.judgment, clerkModel: MAINTAINER_MODELS.clerk });
  let n = 0;
  const c = installSubrequestCounter((url, init) => {
    if (!url.includes("api.anthropic.com")) return rpc(url, init);
    n++;
    return n === 1 ? refusalBody() : okBody(promptOf(init));
  });
  const d1 = createLocalD1({ onExec: c.consume });
  try {
    seed(d1, 6);
    const ctl = { cron: JUDGMENT_CRON, scheduledTime: Date.now(), noRetry: () => {} };
    await (worker.scheduled as unknown as (c: unknown, e: Env, x: unknown) => Promise<void>)(ctl, makeEnv(d1), { waitUntil: () => {}, passThroughOnException: () => {} });
    assert.equal(c.breached(), false, `never exceeded budget (total ${c.total()})`);
    assert.ok(c.total() <= 50);
    assert.equal(c.fetches(), 4, "four model calls");
    assert.match(String(row(d1).error), /not judged \(the model declined\)/);
  } finally {
    c.restore();
    d1.close();
  }
});
