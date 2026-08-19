// The secret-guarded manual maintainer-wake trigger (POST /api/maintainer/run,
// src/maintainer/trigger.ts). Every test drives the REAL Worker default export
// (worker.fetch) against a real local-D1 (the actual schema.sql), the same
// idiom test/governance-sweep-throttle-d1.test.ts and
// test/maintainer-scheduled-budget.test.ts already use -- no mock of the thing
// under test. The ONLY stub is globalThis.fetch, so no real Anthropic API call
// (or Base RPC probe) ever fires; the production parsers still run for real
// against real, response-shaped bodies.
//
// Coverage (each red-proved -- see docs/CHECKPOINT-manual-trigger.md):
//   (a) no Authorization header            -> 401 refused
//   (b) wrong secret / one-char-off        -> 401; the RIGHT secret -> 200
//   (c) unknown or missing wake kind       -> 400
//   (d) burst past the per-IP rate cap     -> 429, free and deterministic
//   (e) a valid clerk trigger              -> sweep+wake run, a maintainer_runs row lands
//   (f) MAINTAINER_SECRET unset            -> 401 refused closed (never open)
//   (g) a compound judgment trigger        -> stays <= 50 subrequests (budget threading)
// plus pure-unit coverage of parseWakeKind and the constant-time secretMatches.
//
// Run just this file:
//   node --experimental-strip-types --test "test/maintainer-manual-trigger-d1.test.ts"

import test, { before } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import { createLocalD1, insertCitizen, insertProposal, type LocalD1 } from "./helpers/local-d1.ts";
import { installSubrequestCounter, makeModelRpcResponder } from "./helpers/subrequest-counter.ts";
import { MAINTAINER_MODELS } from "../src/maintainer/anthropic.ts";
import { parseWakeKind, secretMatches } from "../src/maintainer/trigger.ts";
import { SocietyError } from "../src/society.ts";
import { sha256Hex } from "../src/chain.ts";
import { detectConstitutionChange } from "../src/governance.ts";
import type { Env } from "../src/society.ts";

const SECRET = "correct-horse-battery-staple-maintainer-secret-2026";
// One byte different, same length -- the discriminator proof: a constant-time
// compare must still reject this, and a leaked-prefix oracle would not.
const SECRET_OFF_BY_ONE = "corrick-horse-battery-staple-maintainer-secret-2026";

// Pre-warm the shared PROCESS_CONSTITUTION_CACHE once (same reason and same way
// as test/maintainer-scheduled-budget.test.ts): so every detection through a
// wake below is a cache hit costing 0 D1, making the budget test (g)
// deterministic rather than order-dependent on a cold-cache genesis landing.
before(async () => {
  const warm = createLocalD1();
  try {
    await detectConstitutionChange({ DB: warm.DB, TREASURY_ADDRESS: "0x0", REGISTRATION_MODE: "invite_only" } as unknown as Env, Date.now());
  } finally {
    warm.close();
  }
});

// ---------- harness ----------

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
async function callFetch(request: Request, env: Env): Promise<Response> {
  return (worker.fetch as unknown as (r: Request, e: Env, c: unknown) => Promise<Response>)(request, env, ctx);
}

function makeEnv(d1: LocalD1, opts: { secret?: string; apiKey?: string } = {}): Env {
  const env: Record<string, unknown> = {
    DB: d1.DB,
    TREASURY_ADDRESS: "0x0000000000000000000000000000000000000001",
    FACILITATOR_URL: "https://facilitator.invalid",
    REGISTRATION_MODE: "invite_only",
  };
  if (opts.secret !== undefined) env.MAINTAINER_SECRET = opts.secret;
  if (opts.apiKey !== undefined) env.ANTHROPIC_API_KEY = opts.apiKey;
  return env as unknown as Env;
}

function triggerRequest(opts: { secret?: string; wake?: unknown; ip?: string; rawBody?: string } = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.secret !== undefined) headers["Authorization"] = `Bearer ${opts.secret}`;
  if (opts.ip) headers["CF-Connecting-IP"] = opts.ip;
  let body: string;
  if (opts.rawBody !== undefined) body = opts.rawBody;
  else if (opts.wake !== undefined) body = JSON.stringify({ wake: opts.wake });
  else body = "{}";
  return new Request("https://example.test/api/maintainer/run", { method: "POST", headers, body });
}

// A non-counting fetch stub for the functional tests (the budget test uses the
// counting installSubrequestCounter instead, since it models one invocation's
// budget and must NOT accumulate across the several invocations a burst issues).
function stubFetch(): () => void {
  const original = globalThis.fetch;
  const responder = makeModelRpcResponder({ judgmentModel: MAINTAINER_MODELS.judgment, clerkModel: MAINTAINER_MODELS.clerk });
  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => responder(String(url), init)) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

function seedMaintainer(d1: LocalD1): void {
  const id = insertCitizen(d1, { handle: "commonhold-agent", model: "claude-fable-5" });
  assert.equal(id, 1, "test setup invariant: the maintainer must be citizen #1 (first insert into a fresh DB)");
}

function seedDueProposal(d1: LocalD1, closesAt: number): number {
  return insertProposal(d1, { kind: "resolution", status: "open", opened_at: closesAt - 8 * 86_400_000, closes_at: closesAt });
}

function seedRunRow(d1: LocalD1): number {
  return Number(d1.raw.prepare("INSERT INTO maintainer_runs (kind, started_at) VALUES ('judgment', ?)").run(Date.now()).lastInsertRowid);
}
function seedPendingBulletin(d1: LocalD1, runId: number, i: number, createdAt: number): void {
  d1.raw
    .prepare("INSERT INTO maintainer_queue (run_id, created_at, kind, target_type, target_id, source_ref, note, status) VALUES (?, ?, 'bulletin_draft', NULL, NULL, NULL, ?, 'pending')")
    .run(runId, createdAt, `Digest ${i}\nBody number ${i}, all quiet this week.`);
}
function seedApprovedBulletin(d1: LocalD1, runId: number, i: number, decidedAt: number): void {
  d1.raw
    .prepare("INSERT INTO maintainer_queue (run_id, created_at, kind, target_type, target_id, source_ref, note, status, decided_at, decided_reason) VALUES (?, ?, 'bulletin_draft', NULL, NULL, NULL, ?, 'approved', ?, 'looked fine')")
    .run(runId, decidedAt - 100_000, `Stranded digest ${i}\nBody number ${i}.`, decidedAt);
}

// ---------- pure: parseWakeKind ----------

test("parseWakeKind accepts exactly the two kinds and rejects everything else with a 400", () => {
  assert.equal(parseWakeKind("clerk"), "clerk");
  assert.equal(parseWakeKind("judgment"), "judgment");
  for (const bad of [undefined, null, "", "Clerk", "CLERK", "judge", "clerk ", "banana", 1, {}, ["clerk"], true]) {
    let caught: unknown;
    try {
      parseWakeKind(bad);
    } catch (e) {
      caught = e;
    }
    assert.ok(caught instanceof SocietyError, `must reject ${JSON.stringify(bad)} with a SocietyError`);
    assert.equal((caught as SocietyError).status, 400, `${JSON.stringify(bad)} -> 400`);
  }
});

// ---------- pure: secretMatches (the discriminator) ----------

test("secretMatches returns true only for the identical secret, false for any difference (the compare actually discriminates)", async () => {
  assert.equal(await secretMatches(SECRET, SECRET), true, "identical secrets match");
  assert.equal(await secretMatches(SECRET_OFF_BY_ONE, SECRET), false, "one byte off, same length, must NOT match");
  assert.equal(await secretMatches(SECRET.slice(0, -1), SECRET), false, "a correct PREFIX must not match (the timing-oracle case)");
  assert.equal(await secretMatches(SECRET + "x", SECRET), false, "the correct secret plus a byte must not match");
  assert.equal(await secretMatches("", SECRET), false, "empty provided must not match a real secret");
  assert.equal(await secretMatches(SECRET, SECRET + " "), false, "a trailing-space variant of the expected is a different secret");
});

// ---------- (a) no Authorization header ----------

test("(a) a request with no Authorization header is refused 401, the wake never runs", async () => {
  const restore = stubFetch();
  const d1 = createLocalD1();
  try {
    seedMaintainer(d1);
    const env = makeEnv(d1, { secret: SECRET, apiKey: "test-key" });
    const res = await callFetch(triggerRequest({ wake: "clerk" }), env); // no secret -> no Authorization header
    assert.equal(res.status, 401, "no bearer -> 401");
    const body = (await res.json()) as { error: string };
    assert.equal(body.error, "unauthorized", "the generic body never says WHICH auth condition failed");
    const runs = d1.raw.prepare("SELECT COUNT(*) AS n FROM maintainer_runs").get() as { n: number };
    assert.equal(runs.n, 0, "no wake ran, so no maintainer_runs row was written");
  } finally {
    restore();
    d1.close();
  }
});

// ---------- (b) wrong secret refused; right secret accepted ----------

test("(b) a wrong secret and a one-char-off secret are both refused 401; the exact secret is accepted 200", async () => {
  const restore = stubFetch();
  const d1 = createLocalD1();
  try {
    seedMaintainer(d1);
    const env = makeEnv(d1, { secret: SECRET, apiKey: "test-key" });

    const wrong = await callFetch(triggerRequest({ secret: "totally-wrong", wake: "clerk" }), env);
    assert.equal(wrong.status, 401, "a wrong secret -> 401");
    assert.equal(((await wrong.json()) as { error: string }).error, "unauthorized", "same generic body as a missing header (no which-failed leak)");

    const offByOne = await callFetch(triggerRequest({ secret: SECRET_OFF_BY_ONE, wake: "clerk" }), env);
    assert.equal(offByOne.status, 401, "one byte off (same length) -> 401: the compare discriminates, not merely a length/prefix check");

    const right = await callFetch(triggerRequest({ secret: SECRET, wake: "clerk" }), env);
    assert.equal(right.status, 200, "the EXACT secret is accepted");
    const body = (await right.json()) as { ok: boolean; wake: string };
    assert.equal(body.ok, true);
    assert.equal(body.wake, "clerk");
  } finally {
    restore();
    d1.close();
  }
});

// ---------- (c) unknown / missing wake kind ----------

test("(c) an authenticated request with an unknown or missing wake kind is a 400, and never spends", async () => {
  const restore = stubFetch();
  const d1 = createLocalD1();
  try {
    seedMaintainer(d1);
    const env = makeEnv(d1, { secret: SECRET, apiKey: "test-key" });

    const unknown = await callFetch(triggerRequest({ secret: SECRET, wake: "banana" }), env);
    assert.equal(unknown.status, 400, 'an unknown wake kind -> 400');

    const missing = await callFetch(triggerRequest({ secret: SECRET }), env); // body {}, no wake field
    assert.equal(missing.status, 400, "a missing wake field -> 400");

    const notObject = await callFetch(triggerRequest({ secret: SECRET, rawBody: "[]" }), env);
    assert.equal(notObject.status, 400, "a non-object JSON body -> 400");

    const runs = d1.raw.prepare("SELECT COUNT(*) AS n FROM maintainer_runs").get() as { n: number };
    assert.equal(runs.n, 0, "a malformed request never ran a wake");
  } finally {
    restore();
    d1.close();
  }
});

// ---------- (d) burst past the per-IP rate cap ----------

test("(d) the 7th valid trigger from one IP within the hour is refused 429 (free, deterministic); no ANTHROPIC key needed", async () => {
  const restore = stubFetch();
  const d1 = createLocalD1();
  try {
    seedMaintainer(d1);
    // No ANTHROPIC_API_KEY: every clerk wake takes the no-key path (no model
    // call), so the burst is genuinely free and deterministic. The rate cap
    // (MANUAL_TRIGGER_PER_IP_PER_HOUR = 6) is what refuses the 7th.
    const env = makeEnv(d1, { secret: SECRET });
    const ip = "198.51.100.60"; // RFC 5737 TEST-NET-2
    for (let i = 0; i < 6; i++) {
      const res = await callFetch(triggerRequest({ secret: SECRET, wake: "clerk", ip }), env);
      assert.equal(res.status, 200, `call ${i + 1}/6 from the same IP must succeed -- under the 6/hour cap`);
    }
    const seventh = await callFetch(triggerRequest({ secret: SECRET, wake: "clerk", ip }), env);
    assert.equal(seventh.status, 429, "the 7th call from the same IP inside the hour is refused");
    assert.match(((await seventh.json()) as { error: string }).error, /too many manual maintainer-wake triggers/i, "the refusal names itself, not a generic 500");

    // A different IP is unaffected -- per-IP, not global (namespaced hash).
    const fresh = await callFetch(triggerRequest({ secret: SECRET, wake: "clerk", ip: "198.51.100.61" }), env);
    assert.equal(fresh.status, 200, "a different IP is not throttled by another IP's cap");
  } finally {
    restore();
    d1.close();
  }
});

test("(d2) the manual-trigger throttle never cross-contaminates the sweep or registration throttles despite sharing reg_log (namespaced hash)", async () => {
  const restore = stubFetch();
  const d1 = createLocalD1();
  try {
    seedMaintainer(d1);
    const env = makeEnv(d1, { secret: SECRET });
    const ip = "198.51.100.62";
    for (let i = 0; i < 6; i++) await callFetch(triggerRequest({ secret: SECRET, wake: "clerk", ip }), env);

    // The 6 successful triggers landed 6 reg_log rows under "maintainer-run:ip".
    const mineHash = await sha256Hex("maintainer-run:" + ip);
    const mine = d1.raw.prepare("SELECT COUNT(*) AS n FROM reg_log WHERE ip_hash = ?").get(mineHash) as { n: number };
    assert.equal(mine.n, 6, "sanity: 6 triggers -> 6 reg_log rows under the manual-trigger-namespaced hash");
    // The sweep-namespaced and registration-namespaced counts for the SAME ip
    // are untouched -- a naive shared-table impl without the namespace would
    // have polluted them.
    const sweepHash = await sha256Hex("sweep:" + ip);
    const regHash = await sha256Hex("reg:" + ip);
    assert.equal((d1.raw.prepare("SELECT COUNT(*) AS n FROM reg_log WHERE ip_hash = ?").get(sweepHash) as { n: number }).n, 0, "the sweep throttle's count for this IP is untouched");
    assert.equal((d1.raw.prepare("SELECT COUNT(*) AS n FROM reg_log WHERE ip_hash = ?").get(regHash) as { n: number }).n, 0, "the registration throttle's count for this IP is untouched");
  } finally {
    restore();
    d1.close();
  }
});

// ---------- (e) a valid clerk trigger runs sweep + wake and writes a row ----------

test("(e) a valid clerk trigger runs the governance sweep FIRST, then the clerk wake, and writes exactly one clerk maintainer_runs row", async () => {
  const restore = stubFetch();
  const d1 = createLocalD1();
  try {
    seedMaintainer(d1);
    for (let i = 0; i < 3; i++) insertCitizen(d1); // a small census so the sweep's tally has voters
    const env = makeEnv(d1, { secret: SECRET, apiKey: "test-key" });
    // A due proposal with no ballots: the co-resident sweep must process it
    // (close it out of 'open'), proving the sweep ran BEFORE the wake.
    const dueId = seedDueProposal(d1, Date.now() - 2_000);

    const res = await callFetch(triggerRequest({ secret: SECRET, wake: "clerk", ip: "198.51.100.70" }), env);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { ok: boolean; wake: string; sweep_processed: number | null; triggered_at: number };
    assert.equal(body.ok, true);
    assert.equal(body.wake, "clerk");
    assert.equal(body.sweep_processed, 1, "the summary reports the one due proposal the sweep processed");
    assert.ok(typeof body.triggered_at === "number" && body.triggered_at > 0, "a triggered_at marker is returned so the operator can find the row");

    const dueStatus = (d1.raw.prepare("SELECT status FROM proposals WHERE id = ?").get(dueId) as { status: string }).status;
    assert.notEqual(dueStatus, "open", "the sweep closed the due proposal out of 'open' -- it ran, first");

    const clerkRuns = d1.raw.prepare("SELECT id, finished_at, started_at FROM maintainer_runs WHERE kind = 'clerk'").all() as Array<{ id: number; finished_at: number | null; started_at: number }>;
    assert.equal(clerkRuns.length, 1, "the clerk wake wrote exactly one maintainer_runs row");
    assert.notEqual(clerkRuns[0].finished_at, null, "the row is finalised (finished_at set) -- the wake ran to completion");
    assert.ok(clerkRuns[0].started_at >= body.triggered_at, "the row's started_at is >= triggered_at, so the marker finds it");
  } finally {
    restore();
    d1.close();
  }
});

// ---------- (f) MAINTAINER_SECRET unset / blank -> refuse closed ----------

test("(f) with MAINTAINER_SECRET unset the endpoint refuses closed (401), never open -- even with a plausible bearer", async () => {
  const restore = stubFetch();
  const d1 = createLocalD1();
  try {
    seedMaintainer(d1);
    const env = makeEnv(d1, { apiKey: "test-key" }); // NO MAINTAINER_SECRET
    // A caller presenting SOME bearer must still be refused -- an unset server
    // secret can never authenticate anyone (it must not, e.g., match "" or an
    // empty bearer).
    const res = await callFetch(triggerRequest({ secret: "anything-at-all", wake: "clerk" }), env);
    assert.equal(res.status, 401, "unset secret -> refuse closed");
    assert.equal(((await res.json()) as { error: string }).error, "unauthorized");
    // And an empty bearer against the unset secret is equally refused (never a
    // "" === "" open door).
    const emptyBearer = await callFetch(triggerRequest({ secret: "", wake: "clerk" }), env);
    assert.equal(emptyBearer.status, 401, "empty bearer vs unset secret -> still refused");

    const runs = d1.raw.prepare("SELECT COUNT(*) AS n FROM maintainer_runs").get() as { n: number };
    assert.equal(runs.n, 0, "nothing ran");
  } finally {
    restore();
    d1.close();
  }
});

test("(f2) a blank (whitespace-only) MAINTAINER_SECRET also refuses closed", async () => {
  const restore = stubFetch();
  const d1 = createLocalD1();
  try {
    seedMaintainer(d1);
    const env = makeEnv(d1, { secret: "   ", apiKey: "test-key" });
    const res = await callFetch(triggerRequest({ secret: "   ", wake: "clerk" }), env);
    assert.equal(res.status, 401, "a whitespace-only server secret is treated as unset -> refuse closed");
  } finally {
    restore();
    d1.close();
  }
});

// ---------- (g) the subrequest-budget invariant through the real endpoint ----------

// A faithful adaptation of PROOF J-interior-401 (test/maintainer-scheduled-budget.test.ts)
// but through POST /api/maintainer/run, WITH the per-IP rate cap active (an IP
// is present), so the ratecap's own 3 D1 statements are inside the same
// invocation as the sweep + judgment wake. This guards the ENDPOINT's <= 50
// subrequest invariant end-to-end, the same way maintainer-scheduled-budget.test.ts
// guards scheduled() -- it CAN fail if the wake's shed machinery breaks. It does
// NOT red-prove MANUAL_TRIGGER_PRECHECK_COST in isolation: at current
// conservative estimates the endpoint stays <= 50 even without that +3
// (FINALISE_RESERVE absorbs it), so the threading is a documented margin-
// alignment measure, not a breach-preventer here -- see the constant's own
// comment in budget.ts and docs/CHECKPOINT-manual-trigger.md.
test("(g) a compound judgment trigger (1-due sweep + 1 replay + 401 withheld fidelity rows + 5 bulletins), rate cap active, stays <= 50 subrequests", async () => {
  const judgmentResponder = makeModelRpcResponder({ judgmentModel: MAINTAINER_MODELS.judgment, clerkModel: MAINTAINER_MODELS.clerk });
  const counter = installSubrequestCounter(judgmentResponder);
  const d1 = createLocalD1({ onExec: counter.consume });
  try {
    seedMaintainer(d1);
    for (let i = 0; i < 4; i++) insertCitizen(d1);
    const runId = seedRunRow(d1);
    const now = Date.now();
    seedDueProposal(d1, now - 3_000); // 1 due proposal (co-resident sweep)
    seedApprovedBulletin(d1, runId, 0, now - 2_000); // 1 stranded approved row to replay
    // 401 missing-version fidelity rows (Codex's reproduction number): the
    // classifier's existence-chunk count scales with distinct ids, the exact
    // pressure MANUAL_TRIGGER_PRECHECK_COST + the wake's own shed must absorb.
    for (let i = 0; i < 401; i++) {
      d1.raw
        .prepare("INSERT INTO maintainer_queue (run_id, created_at, kind, target_type, target_id, source_ref, note, status) VALUES (?, ?, 'constitution_fidelity', NULL, NULL, ?, 'missing', 'pending')")
        .run(runId, now - 500_000 - i, `constitution_versions:${900000 + i}`);
    }
    for (let i = 0; i < 5; i++) seedPendingBulletin(d1, runId, i, now - 2_500 + i * 100);

    const env = makeEnv(d1, { secret: SECRET, apiKey: "test-key" });
    const res = await callFetch(triggerRequest({ secret: SECRET, wake: "judgment", ip: "198.51.100.80" }), env);

    assert.equal(res.status, 200, "the endpoint returns cleanly");
    assert.equal(counter.breached(), false, `never exceeded budget (total ${counter.total()}, d1 ${counter.d1()}, fetch ${counter.fetches()})`);
    assert.ok(counter.total() <= 50, `ratecap + sweep + judgment wake total ${counter.total()} <= 50 -- the whole point of threading the ratecap cost into priorCost`);

    // runId is the seeded PARENT run row (kind 'judgment') the pending queue
    // items FK to; the wake writes its OWN row with a higher id. Count only
    // rows the wake itself wrote (id > runId), so the seed row is excluded.
    const wakeRuns = d1.raw.prepare("SELECT COUNT(*) AS n FROM maintainer_runs WHERE kind = 'judgment' AND id > ?").get(runId) as { n: number };
    assert.equal(wakeRuns.n, 1, "the judgment wake wrote its own maintainer_runs row through the endpoint");
  } finally {
    counter.restore();
    d1.close();
  }
});
