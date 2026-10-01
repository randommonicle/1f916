// B8 of docs/BRIEF-SETTLEMENT-REPLAY-GUARD.md, which carries gate L1, L2 and L3
// (docs/REVIEW-X402-SETTLE-HONESTY-GATE-2026-09-29.md, lines 33-35), and test 4:
//
//  L1. `duplicate_settlement` and `settlement_pending` are compared after trim() and case-folding, and are
//      unknown at ANY status, never a refusal (a refusal releases a listing's reservation and invites a
//      second signature).
//  L2. The /verify wording "nothing that could settle was sent" was false: the /verify body is the full
//      signed authorisation. What is true is that this server never asked the facilitator to settle it, and
//      "could not be reached" may follow delivery.
//  L3. Every unknown-outcome message ends with "do not sign again" (on register, patron and listing create
//      the message is the caller's only guard against a second signature).
//  4.  Every classifier outcome maps to its claim state, through the real register route.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { classifySettle, classifyVerify } from "../src/x402.ts";
import {
  TEST_PAYER,
  TX,
  callWorker,
  count,
  createLocalD1,
  json,
  oneClaim,
  registerHeader,
  registerReq,
  stubFacilitator,
  testEnv,
} from "./helpers/settlement-harness.ts";

const DO_NOT_SIGN = /do not sign again\.?$/i;
const BROADCAST = "0x" + "cd".repeat(32);

test("L1. duplicate_settlement and settlement_pending are unknown at ANY status and in any case or spacing, never a refusal", () => {
  const spellings = ["settlement_pending", " Settlement_Pending ", "SETTLEMENT_PENDING", "\tsettlement_pending\n", "duplicate_settlement", " Duplicate_Settlement ", "DUPLICATE_SETTLEMENT"];
  for (const status of [200, 400, 401, 403]) {
    for (const errorReason of spellings) {
      const v = classifySettle(status, { success: false, errorReason });
      assert.equal(v.kind, "unknown", `HTTP ${status} ${JSON.stringify(errorReason)} is a non-verdict`);
      assert.equal(v.rule, 5);
      if (v.kind === "unknown") assert.match(v.message, DO_NOT_SIGN);
    }
  }
  // a pending answer still names its broadcast transaction, whatever its case
  const pending = classifySettle(200, { success: false, errorReason: " Settlement_Pending ", transaction: BROADCAST });
  assert.equal(pending.kind === "unknown" && pending.broadcastTx, BROADCAST);
  // only the two exact strings (folded): a different reason that merely contains one is still a recorded failure
  for (const errorReason of ["duplicate_settlement_failed", "settlement_pending_timeout", "not_duplicate_settlement"]) {
    assert.equal(classifySettle(200, { success: false, errorReason }).kind, "refused", `${errorReason} is a reason of its own`);
  }
  // and a blank reason is still rule 6
  assert.equal(classifySettle(200, { success: false, errorReason: "  " }).rule, 6);
});

test("L3. every unknown-outcome /settle message ends with 'do not sign again'", () => {
  const unknowns: [number, Record<string, unknown>][] = [
    [500, { success: false, errorReason: "x" }],
    [502, {}],
    [409, { success: false, errorReason: "duplicate_settlement" }],
    [409, { success: true }],
    [200, {}],
    [200, { success: "false" }],
    [300, { success: true }],
    [403, { success: true }],
    [200, { success: false, errorReason: "settlement_pending", transaction: BROADCAST }],
    [200, { success: false, errorReason: "settlement_pending" }],
    [200, { success: false, errorReason: "duplicate_settlement" }],
    [200, { success: false }],
    [200, { success: false, errorReason: " " }],
    [400, { success: false, errorReason: 42 }],
    [408, { success: false, errorReason: "upstream_timeout" }],
    [429, { success: false, errorReason: "r".repeat(250) }],
    [202, { success: false, errorReason: "retry later, please try again" }],
  ];
  for (const [status, body] of unknowns) {
    const v = classifySettle(status, body);
    assert.equal(v.kind, "unknown", `HTTP ${status} ${JSON.stringify(body).slice(0, 60)}`);
    if (v.kind === "unknown") assert.match(v.message, DO_NOT_SIGN, `HTTP ${status}: ${v.message.slice(-120)}`);
  }
});

test("L2. no /verify message says 'nothing that could settle was sent'; each says this server never asked the facilitator to settle, and 'could not be reached' may follow delivery", async () => {
  for (const status of [400, 403, 404]) {
    const v = classifyVerify(status, { invalidReason: "x" });
    assert.equal(v.kind, "refused");
    assert.match(v.kind === "refused" ? v.error : "", /never asked the facilitator to settle this payment/);
  }
  for (const status of [500, 503]) {
    const v = classifyVerify(status, { error: "x" });
    assert.match(v.kind === "failed" ? v.message : "", /never asked the facilitator to settle this payment\. Try again later\./);
  }
  // the transit message, through the real route
  const d1 = createLocalD1();
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new TypeError("fetch failed: other side closed");
  }) as typeof fetch;
  try {
    const res = await callWorker(registerReq({ handle: "verify-transit", model: "m" }, registerHeader()), testEnv(d1));
    assert.equal(res.status, 502);
    const message = String((await json(res)).error);
    assert.match(message, /could not be reached to verify this payment/);
    assert.match(message, /may still have been delivered/);
    assert.match(message, /never asked the facilitator to settle this payment/);
    assert.doesNotMatch(message, /nothing that could settle/i);
    assert.equal(count(d1, "settlement_claims"), 0, "a /verify failure takes no claim: the same header may be re-sent");
  } finally {
    globalThis.fetch = original;
    d1.close();
  }
  // and the false sentence is gone from the source, wherever it was served from
  assert.equal(readFileSync(new URL("../src/x402.ts", import.meta.url), "utf8").includes("nothing that could settle was sent"), false);
});

// ---------- 4. every classifier outcome maps to its claim state, through the real route ----------

type Case = { name: string; settle: () => Response | Promise<Response>; state: "booked" | "refused" | "pending"; status: number };
const j = (status: number, body: unknown) => () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const CASES: Case[] = [
  { name: "rule 4 settled", settle: j(200, { success: true, payer: TEST_PAYER, transaction: TX }), state: "booked", status: 201 },
  { name: "rule 4, success on a non-2xx", settle: j(403, { success: true }), state: "pending", status: 502 },
  { name: "rule 7, a recorded failure at 200", settle: j(200, { success: false, errorReason: "insufficient_funds" }), state: "refused", status: 402 },
  { name: "rule 7, a policy refusal at 403", settle: j(403, { success: false, errorReason: "policy" }), state: "refused", status: 402 },
  { name: "rule 1, a 5xx", settle: j(503, { success: true, transaction: TX }), state: "pending", status: 502 },
  { name: "rule 2, a 409", settle: j(409, { success: false, errorReason: "duplicate_settlement" }), state: "pending", status: 502 },
  { name: "rule 3, no boolean success", settle: j(200, {}), state: "pending", status: 502 },
  { name: "rule 5, settlement_pending", settle: j(200, { success: false, errorReason: "settlement_pending", transaction: BROADCAST }), state: "pending", status: 502 },
  { name: "rule 5, ' Settlement_Pending ' (case and spacing)", settle: j(200, { success: false, errorReason: " Settlement_Pending " }), state: "pending", status: 502 },
  { name: "rule 5, SETTLEMENT_PENDING at 400", settle: j(400, { success: false, errorReason: "SETTLEMENT_PENDING" }), state: "pending", status: 502 },
  { name: "200 duplicate_settlement", settle: j(200, { success: false, errorReason: "duplicate_settlement" }), state: "pending", status: 502 },
  { name: "duplicate_settlement at 403", settle: j(403, { success: false, errorReason: " Duplicate_Settlement" }), state: "pending", status: 502 },
  { name: "rule 6, no usable reason", settle: j(200, { success: false, errorReason: " " }), state: "pending", status: 502 },
  { name: "rule 8, every other 4xx", settle: j(422, { success: false, errorReason: "x" }), state: "pending", status: 502 },
  { name: "a /settle fetch that rejects (transit)", settle: () => Promise.reject(new TypeError("fetch failed: other side closed")), state: "pending", status: 502 },
  { name: "an unreadable /settle body", settle: () => new Response("<html>gateway</html>", { status: 200 }), state: "pending", status: 502 },
];

for (const c of CASES) {
  test(`4. classifier outcome -> claim state: ${c.name} -> ${c.state}`, async () => {
    const d1 = createLocalD1();
    const stub = stubFacilitator({ settle: c.settle });
    try {
      const res = await callWorker(registerReq({ handle: "mapped", model: "m", public_key: undefined as never }, registerHeader()), testEnv(d1));
      const body = await json(res);
      assert.equal(res.status, c.status, JSON.stringify(body));
      const row = oneClaim(d1);
      assert.equal(row.state, c.state, `the claim is ${c.state}`);
      if (c.state === "pending") {
        assert.match(String(body.error), DO_NOT_SIGN, "L3: an unknown outcome ends with 'do not sign again'");
        assert.ok(row.rpc_body, "a pending claim keeps its body for reconciliation");
        assert.equal(count(d1, "citizens"), 0, "nothing is booked on an unknown outcome");
        assert.equal(count(d1, "ledger"), 0);
      } else if (c.state === "refused") {
        assert.equal(row.rpc_body, null, "B7: a refusal clears the body");
        assert.equal(count(d1, "citizens"), 0);
      } else {
        assert.equal(row.rpc_body, null);
        assert.equal(count(d1, "citizens"), 1);
        assert.equal(count(d1, "ledger"), 1);
      }
      assert.equal(stub.calls.settle, 1, "one /settle call, whatever it answered");
    } finally {
      stub.restore();
      d1.close();
    }
  });
}
