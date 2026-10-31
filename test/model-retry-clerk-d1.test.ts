// D-079 (docs/BRIEF-MODEL-CALL-RETRY.md R3, R7, R9, R11, R18): the clerk wake retries a failed model call once, records the audit in
// maintainer_runs.model_retry and NEVER in `error` (getClerkCursor reads error IS NULL), prefixes `rerun: ` only when the wake ended on a failure
// a fresh invocation could cure, and sheds the retry when the invocation budget cannot pay for it. Real local D1; the only stub is fetch.
import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, insertCitizen, type LocalD1 } from "./helpers/local-d1.ts";
import { installSubrequestCounter, clerkDraftText, rpcBalanceResponse } from "./helpers/subrequest-counter.ts";
import { runClerkWake } from "../src/maintainer/clerk.ts";
import { canAffordClerkRetry, INVOCATION_SUBREQUEST_BUDGET } from "../src/maintainer/budget.ts";
import type { Env } from "../src/society.ts";

const cache = () => ({ pairKey: null, versionRow: null });
const makeEnv = (d1: LocalD1) => ({ DB: d1.DB, ANTHROPIC_API_KEY: "k", TREASURY_ADDRESS: "0x0000000000000000000000000000000000000001", FACILITATOR_URL: "https://facilitator.invalid", REGISTRATION_MODE: "invite_only" }) as unknown as Env;

function seed(d1: LocalD1): void {
  assert.equal(insertCitizen(d1, { handle: "commonhold-agent", model: "claude-fable-5" }), 1);
  const now = Date.now();
  for (let i = 0; i < 3; i++) {
    const postId = Number(d1.raw.prepare("INSERT INTO posts (citizen_id, title, body, dupe_hash, pinned, author_model, created_at) VALUES (1, ?, ?, ?, 0, 'm', ?)").run(`P${i}`, `body ${i}`, `h${i}`, now - 1_000_000).lastInsertRowid);
    d1.raw.prepare("INSERT INTO flags (citizen_id, target_type, target_id, reason, created_at) VALUES (1, 'post', ?, 'spam', ?)").run(postId, now - (3 - i) * 100);
  }
}

const anthropicOk = (text: string) => new Response(JSON.stringify({ content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 40 } }), { status: 200 });
const forbidden = () => new Response(JSON.stringify({ error: { message: "Request not allowed" } }), { status: 403 });
const unauthorised = () => new Response(JSON.stringify({ error: { message: "invalid x-api-key" } }), { status: 401 });
const drafts = () => clerkDraftText([{ kind: "bookkeeping_note", note: "a" }, { kind: "bookkeeping_note", note: "b" }]);

// Answers the nth Anthropic call from `script`, repeating the last entry; everything else is a Base RPC probe.
function scripted(script: Array<() => Response | "abort">, limit = 50) {
  let n = 0;
  const c = installSubrequestCounter((url) => {
    if (!url.includes("anthropic")) return rpcBalanceResponse();
    const step = script[Math.min(n, script.length - 1)];
    n++;
    const r = step === "abort" ? "abort" : step();
    if (r === "abort") {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }
    return r;
  }, limit);
  return { c, calls: () => n };
}
const clerkRow = (d1: LocalD1) => d1.raw.prepare("SELECT * FROM maintainer_runs WHERE kind = 'clerk' ORDER BY id DESC LIMIT 1").get() as Record<string, unknown>;

test("R3/R11: 403 then a good answer: error NULL, model_retry 'recovered: ...', the cursor advanced, and the next wake's cursor starts past it", async () => {
  const s = scripted([forbidden, () => anthropicOk(drafts())]);
  const d1 = createLocalD1({ onExec: s.c.consume });
  try {
    seed(d1);
    await runClerkWake(makeEnv(d1), cache());
    const row = clerkRow(d1);
    assert.equal(s.calls(), 2);
    assert.equal(row.error, null, "a recovered retry is not an error");
    assert.equal(row.model_retry, "recovered: Anthropic API HTTP 403: Request not allowed");
    assert.equal(row.items_drafted, 2);
    assert.notEqual(row.cursor_advanced_to, null);
    // getClerkCursor's own predicate (error IS NULL): the recovered run's cursor is the one the next wake starts from. Were the observation
    // written into `error`, this MAX would be NULL and the next wake would re-scan and redraft.
    const cursor = (d1.raw.prepare("SELECT MAX(cursor_advanced_to) AS c FROM maintainer_runs WHERE kind = 'clerk' AND error IS NULL").get() as { c: number | null }).c;
    assert.equal(cursor, row.cursor_advanced_to);
  } finally {
    s.c.restore();
  }
});

test("R11/R18: 403 twice: error is the second failure, model_retry 'rerun: failed twice: ...'", async () => {
  const s = scripted([forbidden]);
  const d1 = createLocalD1({ onExec: s.c.consume });
  try {
    seed(d1);
    await runClerkWake(makeEnv(d1), cache());
    const row = clerkRow(d1);
    assert.equal(s.calls(), 2);
    assert.equal(row.error, "model call failed (stop_reason: http_error): Anthropic API HTTP 403: Request not allowed");
    assert.equal(row.model_retry, "rerun: failed twice: Anthropic API HTTP 403: Request not allowed | Anthropic API HTTP 403: Request not allowed");
    assert.equal(row.cursor_advanced_to, null);
  } finally {
    s.c.restore();
  }
});

test("R18: 403 then 401: history kept, NO rerun prefix (a bad key is not cured by a fresh invocation)", async () => {
  const s = scripted([forbidden, unauthorised]);
  const d1 = createLocalD1({ onExec: s.c.consume });
  try {
    seed(d1);
    await runClerkWake(makeEnv(d1), cache());
    const row = clerkRow(d1);
    assert.equal(row.model_retry, "failed twice: Anthropic API HTTP 403: Request not allowed | Anthropic API HTTP 401: invalid x-api-key");
    assert.match(String(row.error), /HTTP 401/);
  } finally {
    s.c.restore();
  }
});

test("R18: a first-attempt timeout is not retried but is stamped 'rerun: failed, timeout not retried: ...'", async () => {
  const s = scripted(["abort"]);
  const d1 = createLocalD1({ onExec: s.c.consume });
  try {
    seed(d1);
    await runClerkWake(makeEnv(d1), cache());
    const row = clerkRow(d1);
    assert.equal(s.calls(), 1);
    assert.match(String(row.model_retry), /^rerun: failed, timeout not retried: Anthropic API did not respond/);
  } finally {
    s.c.restore();
  }
});

test("a plain 401 is not retried and leaves model_retry NULL (the catch-up must not trigger on it)", async () => {
  const s = scripted([unauthorised]);
  const d1 = createLocalD1({ onExec: s.c.consume });
  try {
    seed(d1);
    await runClerkWake(makeEnv(d1), cache());
    const row = clerkRow(d1);
    assert.equal(s.calls(), 1);
    assert.equal(row.model_retry, null);
    assert.match(String(row.error), /HTTP 401/);
  } finally {
    s.c.restore();
  }
});

test("R9: a parse failure after a recovered call keeps the 'recovered' note (no rerun prefix) alongside the parse error", async () => {
  const s = scripted([forbidden, () => anthropicOk("this is not json")]);
  const d1 = createLocalD1({ onExec: s.c.consume });
  try {
    seed(d1);
    await runClerkWake(makeEnv(d1), cache());
    const row = clerkRow(d1);
    assert.equal(row.model_retry, "recovered: Anthropic API HTTP 403: Request not allowed");
    assert.match(String(row.error), /not valid JSON/);
  } finally {
    s.c.restore();
  }
});

test("R7: budget floor -- priorCost 30 actually pre-consumed: the retry is shed, the run row still finalises, the counter never passes 50", async () => {
  const s = scripted([forbidden]);
  const d1 = createLocalD1({ onExec: s.c.consume });
  try {
    seed(d1);
    for (let i = s.c.total(); i < 30; i++) s.c.consume("d1");
    assert.equal(canAffordClerkRetry(30), false);
    await runClerkWake(makeEnv(d1), cache(), 30);
    const row = clerkRow(d1);
    assert.equal(s.calls(), 1, "no retry at the floor");
    assert.equal(s.c.breached(), false);
    assert.ok(s.c.total() <= INVOCATION_SUBREQUEST_BUDGET);
    assert.notEqual(row.finished_at, null, "the run row was finalised");
    assert.equal(row.model_retry, "rerun: failed, retry not afforded: Anthropic API HTTP 403: Request not allowed");
  } finally {
    s.c.restore();
  }
});

test("R4: a retry spent shrinks the insert cap (priorCost 29 leaves slack for the retry and none for inserts)", async () => {
  const s = scripted([forbidden, () => anthropicOk(drafts())]);
  const d1 = createLocalD1({ onExec: s.c.consume });
  try {
    seed(d1);
    for (let i = s.c.total(); i < 29; i++) s.c.consume("d1");
    assert.equal(canAffordClerkRetry(29), true);
    await runClerkWake(makeEnv(d1), cache(), 29);
    const row = clerkRow(d1);
    assert.equal(s.calls(), 2);
    assert.equal(s.c.breached(), false);
    assert.equal(row.items_drafted, 0, "the retry took the last unit of slack, so no insert is affordable");
    assert.equal(row.overflow_dropped, 2, "the drafts shed as overflow, the honest 'did not draft, deferred' signal");
    assert.equal(row.model_retry, "recovered: Anthropic API HTTP 403: Request not allowed");
  } finally {
    s.c.restore();
  }
});

test("canAffordClerkRetry is the slack the inserts would have used: true up to priorCost 29, false at 30", () => {
  assert.equal(canAffordClerkRetry(0), true);
  assert.equal(canAffordClerkRetry(29), true);
  assert.equal(canAffordClerkRetry(30), false);
});
