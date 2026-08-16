// Pre-gate fixes wave (docs/CHECKPOINT-PREGATE-FIXES.md), contention
// finding -- exchange/REVIEW_query-budget-brief_2026-08-15.md /
// exchange/REVIEW_combined-deploy-pregate_2026-08-16.md, both CODEX round
// 1, CONVERGED. Real-D1 coverage for assertPublicSweepNotThrottled
// (society.ts) and its wiring into the PUBLIC POST /api/governance/sweep
// route (index.ts):
//
//   - the (N+1)th call from one IP within the rolling hour is refused
//     with 429;
//   - the SAME wake's own INTERNAL cron sweep path (scheduled() ->
//     runGovernanceSweep directly, never through this HTTP route) stays
//     completely unaffected, even once an IP is throttled at the public
//     door;
//   - a different IP is unaffected by another IP's cap (per-IP, not
//     global); and
//   - the throttle's own reg_log rows, namespaced "sweep:" vs
//     registration's "reg:", never cross-count against the registration
//     throttle or vice versa -- the claim society.ts's own comment makes,
//     proven here rather than only asserted there.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, type LocalD1 } from "./helpers/local-d1.ts";
import worker from "../src/index.ts";
import { runGovernanceSweep } from "../src/governance.ts";
import { assertRegistrationNotThrottled } from "../src/society.ts";
import type { Env } from "../src/society.ts";

const TREASURY_ADDRESS = "0xa7f7985eb19b8c44f12a0654df1ef89d1dd527c9";
const FACILITATOR_URL = "https://facilitator.example.invalid";

function testEnv(d1: LocalD1): Env {
  return {
    DB: d1.DB,
    TREASURY_ADDRESS,
    FACILITATOR_URL,
    REGISTRATION_MODE: "open",
  } as unknown as Env;
}

// Same cast-the-whole-handler idiom test/maintainer-scheduled-budget.test.ts's
// own callScheduled uses for worker.scheduled: the real fetch(request, env)
// implementation only declares two params, but ExportedHandler<Env> types
// fetch as taking a third (ctx), so a caller must supply something there.
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
async function callFetch(request: Request, env: Env): Promise<Response> {
  return (worker.fetch as unknown as (r: Request, e: Env, c: unknown) => Promise<Response>)(request, env, ctx);
}

function sweepRequest(ip?: string): Request {
  const headers: Record<string, string> = {};
  if (ip) headers["CF-Connecting-IP"] = ip;
  return new Request("https://example.test/api/governance/sweep", { method: "POST", headers });
}

test("RED-PROOF (contention finding): the 11th public sweep POST from one IP within the hour is refused with 429", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const ip = "198.51.100.44"; // RFC 5737 TEST-NET-2
    for (let i = 0; i < 10; i++) {
      const res = await callFetch(sweepRequest(ip), env);
      assert.equal(res.status, 200, `call ${i + 1}/10 from the same IP must succeed -- under the 10/hour cap`);
    }
    const eleventh = await callFetch(sweepRequest(ip), env);
    assert.equal(eleventh.status, 429, "the 11th call from the SAME IP inside the hour must be refused");
    const payload = (await eleventh.json()) as { error: string };
    assert.match(payload.error, /too many governance-sweep calls/i, "the refusal names itself, not a generic 500");
  } finally {
    d1.close();
  }
});

test("the internal cron sweep path (runGovernanceSweep called directly) is unaffected even after the public endpoint is throttled for an IP", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const ip = "198.51.100.45";
    // Exhaust the public cap for this IP: 10 succeed, the 11th is refused.
    for (let i = 0; i < 11; i++) {
      await callFetch(sweepRequest(ip), env);
    }
    const throttledAgain = await callFetch(sweepRequest(ip), env);
    assert.equal(throttledAgain.status, 429, "sanity: this IP is genuinely throttled at the public door now");
    // The internal path (scheduled(), index.ts) never goes through the
    // HTTP route or its IP throttle at all -- it calls runGovernanceSweep
    // directly. Calling it directly here proves the SAME thing: no
    // exception, a real result, regardless of the public endpoint's own
    // throttle state for any IP.
    const direct = await runGovernanceSweep(env);
    assert.ok(direct && typeof direct === "object", "the direct/internal sweep call must succeed regardless of the public endpoint's throttle state");
    assert.equal(direct.processed, 0, "an empty proposals table sweeps zero due proposals -- a real, ordinary result, not a thrown refusal");
  } finally {
    d1.close();
  }
});

test("a different IP is unaffected by another IP's throttle (per-IP, not global)", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const throttledIp = "198.51.100.46";
    for (let i = 0; i < 11; i++) {
      await callFetch(sweepRequest(throttledIp), env);
    }
    const freshIp = "198.51.100.47";
    const res = await callFetch(sweepRequest(freshIp), env);
    assert.equal(res.status, 200, "a different IP must not be affected by another IP's own cap");
  } finally {
    d1.close();
  }
});

test("the sweep throttle never cross-contaminates the registration throttle, despite sharing reg_log (namespaced hash)", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const ip = "198.51.100.48";
    for (let i = 0; i < 10; i++) {
      const res = await callFetch(sweepRequest(ip), env);
      assert.equal(res.status, 200);
    }
    // 10 sweep calls landed 10 reg_log rows for THIS ip (namespaced
    // "sweep:ip"), so a naive shared-table implementation without the
    // namespace would already have this IP's registration throttle at 10
    // >= 3 and refusing. The real hash namespace must keep the two counts
    // completely independent.
    const ipHash = await (await import("../src/chain.ts")).sha256Hex("sweep:" + ip);
    const sweepRows = d1.raw.prepare("SELECT COUNT(*) AS n FROM reg_log WHERE ip_hash = ?").get(ipHash) as { n: number };
    assert.equal(sweepRows.n, 10, "sanity: the 10 sweep calls really did land 10 reg_log rows under the sweep-namespaced hash");
    await assert.doesNotReject(
      () => assertRegistrationNotThrottled(env, ip),
      "10 sweep calls from an IP must not throttle that SAME IP's registrations -- the two counts share a table but never a hash",
    );
  } finally {
    d1.close();
  }
});
