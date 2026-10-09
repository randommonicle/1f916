// The guest-voice daily check (docs/BRIEF-GUEST-VOICE.md G4; test 17): two statements, no model call, never throws, on
// the 06:00 clerk cron only, threaded into what the reconciler and the clerk are told has been spent, and deferred when it
// cannot fit. Real local D1 with the subrequest counter wrapped around BOTH boundaries (test/helpers/subrequest-counter.ts).
// The compound proof (sweep + concierge + this check + reconciler + clerk, one invocation, never 51) is the PROOF GUEST-CHECK
// case in test/maintainer-scheduled-budget.test.ts. Every block names the mutant that turns it red; docs/CHECKPOINT-GUEST-VOICE.md
// records each one run and restored.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import worker from "../src/index.ts";
import { createLocalD1, insertCitizen, insertProposal } from "./helpers/local-d1.ts";
import { installSubrequestCounter, clerkDraftText, rpcBalanceResponse } from "./helpers/subrequest-counter.ts";
import { captureLog, eventLines } from "./helpers/settlement-harness.ts";
import { seedTopic } from "./helpers/guest.ts";
import { runGuestDutyCheck } from "../src/guest.ts";
import { runConciergeWake } from "../src/maintainer/concierge.ts";
import { CLERK_CRON, JUDGMENT_CRON, LOOP_CRON } from "../src/maintainer/schedule.ts";
import { GUEST_DUTY_CHECK_COST, canAffordGuestDutyCheck, estimateSweepCost, INVOCATION_SUBREQUEST_BUDGET, FINALISE_RESERVE, CLERK_WAKE_FIXED_COST } from "../src/maintainer/budget.ts";
import { GUEST_ANSWER_TARGET_HOURS, HOUR_MS } from "../src/guest-core.ts";
import type { Env } from "../src/society.ts";

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
const fire = (cron: string, env: Env) => (worker.scheduled as unknown as (c: unknown, e: Env, x: unknown) => Promise<void>)({ cron, scheduledTime: Date.now(), noRetry: () => {} }, env, ctx);

function envFor(DB: unknown, extra: Record<string, unknown> = {}): Env {
  return { DB, TREASURY_ADDRESS: "0x0000000000000000000000000000000000000001", FACILITATOR_URL: "https://facilitator.invalid", REGISTRATION_MODE: "open", ...extra } as unknown as Env;
}

function addDuty(d1: ReturnType<typeof createLocalD1>, topic: number, n: number, dueAt: number, o: { mod?: string | null } = {}): number[] {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    ids.push(
      Number(
        d1.raw
          .prepare("INSERT INTO guest_thread (post_id, author_kind, author_id, handle, model, kind, body, mod_state, duty, due_at, created_at) VALUES (?, 'guest', ?, 'g', 'm', 'critique', 'c', ?, 1, ?, ?)")
          .run(topic, 9000 + ids.length + Math.floor(Math.random() * 1e6), o.mod ?? null, dueAt + i, dueAt - GUEST_ANSWER_TARGET_HOURS * HOUR_MS).lastInsertRowid,
      ),
    );
  }
  return ids;
}

// ---------- the check alone: exactly two statements, one dated row ----------

test("17: the check is exactly GUEST_DUTY_CHECK_COST (2) counted subrequests with no outbound fetch, writes ONE dated row, and its priced cost equals its counted cost", async () => {
  const counter = installSubrequestCounter(() => {
    throw new Error("the guest check must make no outbound call");
  });
  const d1 = createLocalD1({ onExec: counter.consume });
  try {
    insertCitizen(d1, { handle: "commonhold-agent" });
    const topic = seedTopic(d1);
    const now = Date.now();
    addDuty(d1, topic, 3, now - 5 * HOUR_MS); // overdue
    addDuty(d1, topic, 2, now + 5 * HOUR_MS); // open
    const before = counter.total();
    const res = await runGuestDutyCheck(envFor(d1.DB), 0, now);
    assert.equal(counter.total() - before, 2, "two counted statements");
    assert.equal(counter.fetches(), 0, "no model call, no RPC");
    assert.equal(res.actualCost, GUEST_DUTY_CHECK_COST);
    assert.equal(res.actualCost, counter.total() - before, "the priced cost IS the counted cost (a check priced at 10 would not be)");
    assert.equal(res.ran, true);
    const rows = d1.raw.prepare("SELECT * FROM guest_duty_runs").all() as Record<string, any>[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].run_at, now);
    assert.equal(rows[0].open_count, 5, "open or overdue");
    assert.equal(rows[0].overdue_count, 3);
    assert.equal(rows[0].oldest_due_at, now - 5 * HOUR_MS);
    assert.deepEqual(JSON.parse(rows[0].overdue_ids), ["g1", "g2", "g3"], "oldest first, as served");
  } finally {
    counter.restore();
    d1.close();
  }
});

test("17: no duties writes a record with zero counts and null ids; more than 20 overdue records the 20 oldest; answered, hidden and not-yet-due duties are not overdue", async () => {
  const d1 = createLocalD1();
  try {
    insertCitizen(d1, { handle: "commonhold-agent" });
    const topic = seedTopic(d1);
    const now = Date.now();
    await runGuestDutyCheck(envFor(d1.DB), 0, now);
    const empty = d1.raw.prepare("SELECT * FROM guest_duty_runs ORDER BY id DESC LIMIT 1").get() as Record<string, any>;
    assert.deepEqual([empty.open_count, empty.overdue_count, empty.oldest_due_at, empty.overdue_ids], [0, 0, null, null]);
    const overdue = addDuty(d1, topic, 25, now - 10 * HOUR_MS);
    const answered = addDuty(d1, topic, 1, now - 20 * HOUR_MS)[0];
    d1.raw.prepare("INSERT INTO guest_thread (post_id, parent_kind, parent_id, depth, author_kind, author_id, handle, model, kind, body, created_at) VALUES (?, 'thread', ?, 1, 'citizen', 1, 'commonhold-agent', 'm', 'comment', ?, ?)").run(topic, answered, "x".repeat(100), now - HOUR_MS);
    addDuty(d1, topic, 1, now - 30 * HOUR_MS, { mod: "collapsed" }); // waived
    addDuty(d1, topic, 4, now + 9 * HOUR_MS); // open
    await runGuestDutyCheck(envFor(d1.DB), 0, now + 1);
    const row = d1.raw.prepare("SELECT * FROM guest_duty_runs ORDER BY id DESC LIMIT 1").get() as Record<string, any>;
    assert.equal(row.open_count, 29, "25 overdue + 4 open; the answered and the hidden one are not owed");
    assert.equal(row.overdue_count, 25);
    assert.equal(row.oldest_due_at, now - 10 * HOUR_MS);
    const ids = JSON.parse(row.overdue_ids) as string[];
    assert.equal(ids.length, 20, "at most 20 ids");
    assert.deepEqual(ids, overdue.slice(0, 20).map((n) => `g${n}`), "the 20 oldest, oldest first");
  } finally {
    d1.close();
  }
});

// ---------- cron only ----------

test("17: the check runs on the 06:00 clerk cron only: one row there, none on the Sunday judgment cron, none on the 12:00 loop cron, none from the manual trigger", async () => {
  const d1 = createLocalD1();
  const counter = installSubrequestCounter((url) => (url.includes("anthropic") ? new Response(JSON.stringify({ content: [{ type: "text", text: "[]" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 }) : rpcBalanceResponse()), 10_000);
  try {
    insertCitizen(d1, { handle: "commonhold-agent", model: "claude-fable-5" });
    const env = envFor(d1.DB, { ANTHROPIC_API_KEY: "test-key", MAINTAINER_SECRET: "manual-trigger-secret-for-the-guest-check-test" });
    const runs = () => (d1.raw.prepare("SELECT COUNT(*) AS n FROM guest_duty_runs").get() as { n: number }).n;
    await fire(JUDGMENT_CRON, env);
    assert.equal(runs(), 0, "the judgment cron does not run the check");
    await fire(LOOP_CRON, env);
    assert.equal(runs(), 0, "the 12:00 loop cron does not run the check either: the check is the 06:00 wake's, and only that wake's");
    await fire(CLERK_CRON, env);
    assert.equal(runs(), 1, "the clerk cron runs it once");
    // the manual trigger replicates scheduled() but bypasses the reconciler and this check, by design
    for (const wake of ["clerk", "judgment"]) {
      const res = await worker.fetch(
        new Request("https://example.test/api/maintainer/run", { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer manual-trigger-secret-for-the-guest-check-test", "CF-Connecting-IP": `192.0.2.${wake === "clerk" ? 11 : 12}` }, body: JSON.stringify({ wake }) }),
        env,
      );
      assert.equal(res.status, 200, `${wake}: ${await res.clone().text()}`);
    }
    assert.equal(runs(), 1, "the manual trigger wrote no guest_duty_runs row");
  } finally {
    counter.restore();
    d1.close();
  }
});

// Its own test, so a missing cron line is one named failure and never hides the assertions above. The daily loop (src/maintainer/loop.ts)
// fires only if wrangler.jsonc registers LOOP_CRON; classifyCron knowing the string is not enough, and nothing else would notice.
test("the cron registration: wrangler.jsonc's triggers.crons is exactly the three strings schedule.ts classifies, in this order", () => {
  const wrangler = readFileSync(join(import.meta.dirname, "..", "wrangler.jsonc"), "utf8");
  const crons = /"crons":\s*\[([^\]]*)\]/.exec(wrangler)?.[1].split(",").map((s) => s.trim().replace(/"/g, ""));
  assert.deepEqual(crons, [CLERK_CRON, JUDGMENT_CRON, LOOP_CRON], "a loop wake whose cron is not registered never fires");
});

// ---------- the defer rule ----------

test("17: the defer rule: it runs when its two statements and the finalise reserve fit, skips with one log line and costs nothing when they do not", async () => {
  const limit = INVOCATION_SUBREQUEST_BUDGET - GUEST_DUTY_CHECK_COST - FINALISE_RESERVE; // 46
  assert.equal(canAffordGuestDutyCheck(limit), true);
  assert.equal(canAffordGuestDutyCheck(limit + 1), false);
  const d1 = createLocalD1();
  try {
    insertCitizen(d1, { handle: "commonhold-agent" });
    const ran = await runGuestDutyCheck(envFor(d1.DB), limit);
    assert.equal(ran.ran, true);
    const { value: skipped, lines } = await captureLog(() => runGuestDutyCheck(envFor(d1.DB), limit + 1));
    assert.deepEqual([skipped.ran, skipped.deferred, skipped.actualCost], [false, true, 0]);
    assert.equal(eventLines(lines, "guest_duty_check_deferred").length, 1, "exactly one log line");
    assert.equal((d1.raw.prepare("SELECT COUNT(*) AS n FROM guest_duty_runs").get() as { n: number }).n, 1, "the deferred call wrote nothing");
  } finally {
    d1.close();
  }
});

// ---------- a failing check never stops what follows, and is priced at the constant ----------

test("17: a throwing check does not stop the clerk (or throw at all): it is logged and priced at the constant", async () => {
  const d1 = createLocalD1();
  const counter = installSubrequestCounter((url) => (url.includes("anthropic") ? new Response(JSON.stringify({ content: [{ type: "text", text: "[]" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200 }) : rpcBalanceResponse()), 10_000);
  try {
    insertCitizen(d1, { handle: "commonhold-agent", model: "claude-fable-5" });
    const failing = {
      prepare: (sql: string) => {
        if (sql.includes("guest_duty_runs") || sql.includes("guest_thread")) throw new Error("the guest tables are unavailable");
        return d1.DB.prepare(sql);
      },
      batch: (stmts: unknown[]) => d1.DB.batch(stmts as never),
    };
    const env = envFor(failing, { ANTHROPIC_API_KEY: "test-key" });
    const direct = await runGuestDutyCheck(env, 0);
    assert.deepEqual([direct.ran, direct.deferred, direct.actualCost], [false, false, GUEST_DUTY_CHECK_COST], "a throw is priced at the constant");
    const { lines } = await captureLog(() => fire(CLERK_CRON, env));
    assert.equal(eventLines(lines, "guest_duty_check_failed").length >= 1, true, "the failure is logged");
    assert.equal(eventLines(lines, "scheduled_wake_failed").length, 0, "and never reaches the wake's own backstop");
    assert.equal((d1.raw.prepare("SELECT COUNT(*) AS n FROM maintainer_runs WHERE kind = 'clerk'").get() as { n: number }).n, 1, "the clerk still ran");
  } finally {
    counter.restore();
    d1.close();
  }
});

// ---------- threaded into the reconciler's and the clerk's spent count ----------

// A day on the 06:00 clerk cron, COUNTED, on one database; its twin (same rows) lets the test read the concierge's own
// cost directly, so the expected figures below are derived, not typed in.
function seedDay(d1: ReturnType<typeof createLocalD1>, o: { due?: number; flagged?: number }) {
  insertCitizen(d1, { handle: "commonhold-agent", model: "claude-fable-5" });
  for (let i = 0; i < 4; i++) insertCitizen(d1);
  const now = Date.now();
  for (let i = 0; i < (o.due ?? 0); i++) insertProposal(d1, { kind: "resolution", status: "open", opened_at: now - 9 * 86_400_000, closes_at: now - (i + 2) * 1_000 });
  for (let i = 0; i < (o.flagged ?? 0); i++) {
    const postId = Number(d1.raw.prepare("INSERT INTO posts (citizen_id, title, body, dupe_hash, pinned, author_model, created_at) VALUES (1, ?, ?, ?, 0, 'm', ?)").run(`P${i}`, `body ${i}`, `h${i}`, now - 60_000).lastInsertRowid);
    d1.raw.prepare("INSERT INTO flags (citizen_id, target_type, target_id, reason, created_at) VALUES (1, 'post', ?, 'spam', ?)").run(postId, now - (5 - i) * 100);
  }
}

test("17: what the check spent is added to what the RECONCILER is told: its deferral line carries sweep + concierge + the check + the clerk's fixed cost", async () => {
  const counter = installSubrequestCounter(() => rpcBalanceResponse(), 10_000);
  const day = createLocalD1();
  const twin = createLocalD1();
  try {
    seedDay(day, { due: 2 });
    seedDay(twin, { due: 2 });
    const sweep = estimateSweepCost(2);
    const concierge = await runConciergeWake(envFor(twin.DB), sweep); // the same concierge phase, on the identical twin
    const { lines } = await captureLog(() => fire(CLERK_CRON, envFor(day.DB)));
    const deferred = eventLines(lines, "settlement_reconcile_deferred");
    assert.equal(deferred.length, 1, "two due proposals leave the reconciler no room: it defers once");
    assert.equal(deferred[0].reserved_cost, sweep + concierge.actualCost + GUEST_DUTY_CHECK_COST + CLERK_WAKE_FIXED_COST, "the reconciler was told the check's cost");
    assert.equal((day.raw.prepare("SELECT COUNT(*) AS n FROM guest_duty_runs").get() as { n: number }).n, 1, "and the check really ran");
  } finally {
    counter.restore();
    day.close();
    twin.close();
  }
});

test("17: what the check spent is added to what the CLERK is told: it affords exactly two fewer inserts than the same day without the check's cost", async () => {
  // The clerk may insert min(cap, 50 - priorCost - 18 - 2). With 40 drafts offered it is the affordable number that binds,
  // so the count of inserted rows IS the clerk's priorCost, read back.
  const drafts = Array.from({ length: 40 }, (_, i) => ({ kind: "bookkeeping_note", note: `drift note ${i}` }));
  const responder = (url: string) =>
    url.includes("anthropic")
      ? new Response(JSON.stringify({ content: [{ type: "text", text: clerkDraftText(drafts) }], stop_reason: "end_turn", usage: { input_tokens: 80, output_tokens: 40 } }), { status: 200 })
      : rpcBalanceResponse();
  const counter = installSubrequestCounter(responder, 10_000);
  const day = createLocalD1();
  const twin = createLocalD1();
  try {
    seedDay(day, { flagged: 5 });
    seedDay(twin, { flagged: 5 });
    const sweep = estimateSweepCost(0);
    const concierge = await runConciergeWake(envFor(twin.DB, { ANTHROPIC_API_KEY: "test-key" }), sweep);
    await fire(CLERK_CRON, envFor(day.DB, { ANTHROPIC_API_KEY: "test-key" }));
    const inserted = (day.raw.prepare("SELECT COUNT(*) AS n FROM maintainer_queue WHERE kind = 'bookkeeping_note'").get() as { n: number }).n;
    // the reconciler's select (no rows to work) costs RECONCILE_SELECT_COST (1); the check costs 2
    const expected = INVOCATION_SUBREQUEST_BUDGET - (sweep + concierge.actualCost + GUEST_DUTY_CHECK_COST + 1) - CLERK_WAKE_FIXED_COST - FINALISE_RESERVE;
    assert.equal(inserted, expected, `the clerk was told sweep ${sweep} + concierge ${concierge.actualCost} + check ${GUEST_DUTY_CHECK_COST} + reconciler 1`);
    assert.ok(inserted > 0 && inserted < 40, "the affordable number bound it");
    assert.equal(counter.breached(), false);
  } finally {
    counter.restore();
    day.close();
    twin.close();
  }
});
