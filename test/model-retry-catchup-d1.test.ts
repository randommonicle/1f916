// D-079 Part B (docs/BRIEF-MODEL-CALL-RETRY.md R6, R14, R15, R18, R19, R22): the catch-up crons. Driven through the real Worker default export's
// scheduled() handler against a real local D1; the only stub is fetch. A catch-up with nothing to catch up is ONE D1 read; one that runs does the
// sweep and the plain wake and nothing else of the 06:00 invocation.
import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import { createLocalD1, insertCitizen, insertProposal, type LocalD1 } from "./helpers/local-d1.ts";
import { installSubrequestCounter, clerkDraftText, rpcBalanceResponse, judgmentDecisionText } from "./helpers/subrequest-counter.ts";
import { CLERK_CATCHUP_CRON, JUDGMENT_CATCHUP_CRON, CLERK_CRON, JUDGMENT_CRON, classifyCron } from "../src/maintainer/schedule.ts";
import { CATCHUP_PRECHECK_COST } from "../src/maintainer/budget.ts";
import { catchupWanted } from "../src/maintainer/catchup.ts";
import { utcMidnight } from "../src/society.ts";
import type { Env } from "../src/society.ts";

const makeEnv = (d1: LocalD1) => ({ DB: d1.DB, ANTHROPIC_API_KEY: "k", TREASURY_ADDRESS: "0x0000000000000000000000000000000000000001", FACILITATOR_URL: "https://facilitator.invalid", REGISTRATION_MODE: "invite_only" }) as unknown as Env;
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
const callScheduled = (cron: string, env: Env) =>
  (worker.scheduled as unknown as (c: unknown, e: Env, x: unknown) => Promise<void>)({ cron, scheduledTime: Date.now(), noRetry: () => {} }, env, ctx);

const today = () => utcMidnight(Date.now()) + 1000;

function seed(d1: LocalD1): void {
  assert.equal(insertCitizen(d1, { handle: "commonhold-agent", model: "claude-fable-5" }), 1);
  const now = Date.now();
  for (let i = 0; i < 3; i++) {
    const postId = Number(d1.raw.prepare("INSERT INTO posts (citizen_id, title, body, dupe_hash, pinned, author_model, created_at) VALUES (1, ?, ?, ?, 0, 'm', ?)").run(`P${i}`, `body ${i}`, `h${i}`, now - 1_000_000).lastInsertRowid);
    d1.raw.prepare("INSERT INTO flags (citizen_id, target_type, target_id, reason, created_at) VALUES (1, 'post', ?, 'spam', ?)").run(postId, now - (3 - i) * 100);
  }
  // a pending bulletin so a judgment catch-up has work
  const runId = Number(d1.raw.prepare("INSERT INTO maintainer_runs (kind, started_at, finished_at) VALUES ('clerk', ?, ?)").run(now - 86_400_000 * 3, now - 86_400_000 * 3 + 1).lastInsertRowid);
  d1.raw
    .prepare("INSERT INTO maintainer_queue (run_id, created_at, kind, target_type, target_id, source_ref, note, status) VALUES (?, ?, 'bulletin_draft', NULL, NULL, NULL, 'Digest\nBody, all quiet.', 'pending')")
    .run(runId, now - 5_000);
}
function priorRow(d1: LocalD1, kind: "clerk" | "judgment", f: { startedAt?: number; finishedAt?: number | null; error?: string | null; modelRetry?: string | null }): void {
  const startedAt = f.startedAt ?? today();
  d1.raw
    .prepare("INSERT INTO maintainer_runs (kind, started_at, finished_at, error, model_retry) VALUES (?, ?, ?, ?, ?)")
    .run(kind, startedAt, f.finishedAt === undefined ? startedAt + 5 : f.finishedAt, f.error ?? null, f.modelRetry ?? null);
}
const RERUN = "rerun: failed twice: Anthropic API HTTP 403: Request not allowed | Anthropic API HTTP 403: Request not allowed";

function respond(url: string, init: { body?: unknown } | undefined): Response {
  if (!url.includes("anthropic")) return rpcBalanceResponse();
  const prompt = (JSON.parse(String(init?.body)) as { messages: Array<{ content: string }> }).messages[0].content;
  const text = prompt.includes("queue_item id=") ? judgmentDecisionText(prompt) : clerkDraftText([{ kind: "bookkeeping_note", note: "caught up" }]);
  return new Response(JSON.stringify({ content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 40 } }), { status: 200 });
}
const count = (d1: LocalD1, sql: string) => (d1.raw.prepare(sql).get() as { n: number }).n;

test("the catch-up cron strings classify, are exact-match, and do not collide with the existing four", () => {
  assert.equal(classifyCron(CLERK_CATCHUP_CRON), "clerk_catchup");
  assert.equal(classifyCron(JUDGMENT_CATCHUP_CRON), "judgment_catchup");
  assert.equal(CLERK_CATCHUP_CRON, "30 6 * * *");
  assert.equal(JUDGMENT_CATCHUP_CRON, "30 7 * * 1");
  assert.equal(new Set([CLERK_CRON, JUDGMENT_CRON, CLERK_CATCHUP_CRON, JUDGMENT_CATCHUP_CRON, "0 12 * * *"]).size, 5);
  assert.equal(classifyCron("30 6 * * 1"), null);
  assert.equal(classifyCron(CLERK_CATCHUP_CRON + " "), null);
  assert.equal(classifyCron("30 7 * * SUN"), null, "the live line is numeric (Quartz 1 = Sunday), as JUDGMENT_CRON is");
});

test("nothing to catch up (no row today): exactly ONE D1 read, no fetch, no row written, no sweep", async () => {
  const c = installSubrequestCounter(respond);
  const d1 = createLocalD1({ onExec: c.consume });
  try {
    seed(d1);
    const rowsBefore = count(d1, "SELECT COUNT(*) AS n FROM maintainer_runs");
    await callScheduled(CLERK_CATCHUP_CRON, makeEnv(d1));
    assert.equal(c.d1(), 1, "the skip check is one D1 read");
    assert.equal(c.fetches(), 0);
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM maintainer_runs"), rowsBefore);
  } finally {
    c.restore();
  }
});

const SKIPS: Array<[string, (d1: LocalD1) => void]> = [
  ["today's clerk row succeeded (model_retry NULL)", (d1) => priorRow(d1, "clerk", {})],
  ["today's clerk row recovered by retry (plain 'recovered:' note, no rerun)", (d1) => priorRow(d1, "clerk", { modelRetry: "recovered: Anthropic API HTTP 403: Request not allowed" })],
  ["today's failure was a 401 (note NULL), not rerunnable", (d1) => priorRow(d1, "clerk", { error: "model call failed (stop_reason: http_error): Anthropic API HTTP 401: bad", modelRetry: null })],
  ["403 then 401 (history kept, no rerun prefix)", (d1) => priorRow(d1, "clerk", { modelRetry: "failed twice: a | b" })],
  ["the newest row is still open (in flight or killed)", (d1) => priorRow(d1, "clerk", { finishedAt: null, modelRetry: RERUN })],
  [
    "a LATER successful manual wake is the newest row",
    (d1) => {
      priorRow(d1, "clerk", { startedAt: today(), modelRetry: RERUN });
      priorRow(d1, "clerk", { startedAt: today() + 60_000 });
    },
  ],
  ["the rerun row is from before UTC midnight", (d1) => priorRow(d1, "clerk", { startedAt: utcMidnight(Date.now()) - 3_600_000, modelRetry: RERUN })],
  ["the rerun row is a JUDGMENT row (the clerk catch-up reads clerk rows only)", (d1) => priorRow(d1, "judgment", { modelRetry: RERUN })],
];
for (const [name, setup] of SKIPS) {
  test(`skip: ${name}`, async () => {
    const c = installSubrequestCounter(respond);
    const d1 = createLocalD1({ onExec: c.consume });
    try {
      seed(d1);
      setup(d1);
      const rows = count(d1, "SELECT COUNT(*) AS n FROM maintainer_runs");
      await callScheduled(CLERK_CATCHUP_CRON, makeEnv(d1));
      assert.equal(c.d1(), 1);
      assert.equal(c.fetches(), 0);
      assert.equal(count(d1, "SELECT COUNT(*) AS n FROM maintainer_runs"), rows, "no row written");
    } finally {
      c.restore();
    }
  });
}

test("R15: a compound error with an earlier clause still triggers on the model_retry prefix, and the clerk wake runs (sweep too; no concierge, guest check or reconciler)", async () => {
  const c = installSubrequestCounter(respond);
  const d1 = createLocalD1({ onExec: c.consume });
  try {
    seed(d1);
    priorRow(d1, "clerk", { error: "constitution detection did not resolve (exhausted); model call failed (stop_reason: http_error): Anthropic API HTTP 403: Request not allowed", modelRetry: RERUN });
    const due = insertProposal(d1, { kind: "resolution", status: "open", opened_at: Date.now() - 8 * 86_400_000, closes_at: Date.now() - 1_000 });
    await callScheduled(CLERK_CATCHUP_CRON, makeEnv(d1));
    assert.equal(c.breached(), false);
    const clerkRows = d1.raw.prepare("SELECT * FROM maintainer_runs WHERE kind = 'clerk' AND started_at >= ? ORDER BY id DESC").all(today()) as Array<Record<string, unknown>>;
    assert.equal(clerkRows.length, 2, "the failed row and the catch-up's own");
    assert.equal(clerkRows[0].model_retry, null);
    assert.equal(clerkRows[0].items_drafted, 1);
    const status = (d1.raw.prepare("SELECT status FROM proposals WHERE id = ?").get(due) as { status: string }).status;
    assert.notEqual(status, "open", "the catch-up ran the sweep");
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM concierge_runs"), 0, "no concierge");
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM guest_duty_runs"), 0, "no guest check");
  } finally {
    c.restore();
  }
});

test("the judgment catch-up runs the judgment wake when this morning's judgment row ended on a rerunnable failure", async () => {
  const c = installSubrequestCounter(respond);
  const d1 = createLocalD1({ onExec: c.consume });
  try {
    seed(d1);
    priorRow(d1, "judgment", { error: "model call failed on batch 1 (stop_reason: http_error): x", modelRetry: "rerun: batch 1: failed twice: a | b" });
    await callScheduled(JUDGMENT_CATCHUP_CRON, makeEnv(d1));
    const rows = d1.raw.prepare("SELECT * FROM maintainer_runs WHERE kind = 'judgment' ORDER BY id DESC").all() as Array<Record<string, unknown>>;
    assert.equal(rows.length, 2);
    assert.equal(rows[0].items_actioned, 1, "the catch-up actioned the pending bulletin");
    assert.equal(rows[0].model_retry, null);
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM maintainer_runs WHERE kind = 'clerk' AND started_at >= " + today()), 0, "and no clerk wake");
  } finally {
    c.restore();
  }
});

test("catchupWanted reads the newest row only (ORDER BY started_at DESC, id DESC): equal started_at falls to the higher id", async () => {
  const d1 = createLocalD1();
  seed(d1);
  priorRow(d1, "clerk", { startedAt: today(), modelRetry: RERUN });
  priorRow(d1, "clerk", { startedAt: today() }); // same started_at, higher id, succeeded
  assert.equal(await catchupWanted(makeEnv(d1), "clerk", Date.now()), false);
});

test("an unrecognised cron still sweeps and runs no wake (unchanged behaviour)", async () => {
  const c = installSubrequestCounter(respond);
  const d1 = createLocalD1({ onExec: c.consume });
  try {
    seed(d1);
    const due = insertProposal(d1, { kind: "resolution", status: "open", opened_at: Date.now() - 8 * 86_400_000, closes_at: Date.now() - 1_000 });
    await callScheduled("* * * * *", makeEnv(d1));
    const status = (d1.raw.prepare("SELECT status FROM proposals WHERE id = ?").get(due) as { status: string }).status;
    assert.notEqual(status, "open");
    assert.equal(c.fetches(), 0);
  } finally {
    c.restore();
  }
});

test("F1: a proceeding catch-up adds its own skip-check read to priorCost (clerk insert cap 50 - (3 + 1) - 18 - 2 = 26, not 27)", async () => {
  const drafts = clerkDraftText(Array.from({ length: 40 }, (_, i) => ({ kind: "bookkeeping_note", note: `n${i}` })));
  const c = installSubrequestCounter((url) => {
    if (!url.includes("anthropic")) return rpcBalanceResponse();
    return new Response(JSON.stringify({ content: [{ type: "text", text: drafts }], stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 40 } }), { status: 200 });
  });
  const d1 = createLocalD1({ onExec: c.consume });
  try {
    seed(d1);
    priorRow(d1, "clerk", { modelRetry: RERUN });
    await callScheduled(CLERK_CATCHUP_CRON, makeEnv(d1));
    const newest = d1.raw.prepare("SELECT items_drafted FROM maintainer_runs WHERE kind = 'clerk' ORDER BY id DESC LIMIT 1").get() as { items_drafted: number };
    assert.equal(newest.items_drafted, 50 - (3 + CATCHUP_PRECHECK_COST) - 18 - 2);
    assert.equal(newest.items_drafted, 26);
  } finally {
    c.restore();
  }
});
