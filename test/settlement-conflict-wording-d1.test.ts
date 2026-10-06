// The claim-conflict wording (gate L2 class, found 6 Oct 2026; commission build item 6).
//
// claimAnswer's non-identical 409 used to say "This request sent nothing to the facilitator", and takeClaim's 503 "Nothing was sent to the facilitator". Both are reached on a path that
// runs AFTER /verify (payAndSettle takes the claim just before /settle), and the /verify body is the full signed authorisation (x402.ts, gate L2): so "nothing was sent to the facilitator"
// was false there. It is true only on the consult path (replayForClaim, before /verify). The one sentence true on BOTH is that nothing was sent to the facilitator's /settle.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { claimIdentity, claimKeyFromPayload, SETTLEMENT_CLAIM_CONFLICT, takeClaim, type ClaimSpec } from "../src/settlement-claims.ts";
import { SocietyError } from "../src/society.ts";
import { TREASURY_ADDRESS, callWorker, count, createLocalD1, json, patronReq, paymentHeaderFor, stubFacilitator, testEnv } from "./helpers/settlement-harness.ts";

const REQS = { network: "base", asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" };
const OLD_SENTENCE = /sent nothing to the facilitator,/i;
const NEW_SENTENCE = "This request sent nothing to the facilitator's /settle, charged nothing and created nothing.";

// A divergent claim (a different route and intent) for the same signed authorisation.
async function divergentClaimFor(header: string, d1: ReturnType<typeof createLocalD1>) {
  const payload = JSON.parse(atob(header));
  const { key, validBefore } = claimKeyFromPayload(payload, REQS);
  const spec: ClaimSpec = { route: "register", intent: { handle: "someone-else", model: "m", public_key: null } };
  const id = await claimIdentity(key, validBefore, { paymentPayload: payload, other: true }, spec);
  assert.deepEqual(await takeClaim(testEnv(d1), id, spec, "seed", Date.now()), { taken: true });
}

test("the conflict 409 on the CONSULT path (before /verify): nothing at all reached the facilitator, and the words say what is true on both paths", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator();
  try {
    const header = paymentHeaderFor(TREASURY_ADDRESS, "1000000");
    await divergentClaimFor(header, d1);
    const res = await callWorker(patronReq("rent", header), testEnv(d1));
    const body = await json(res);
    assert.equal(res.status, 409, JSON.stringify(body));
    assert.equal(body.code, SETTLEMENT_CLAIM_CONFLICT);
    assert.deepEqual(stub.calls, { verify: 0, settle: 0 }, "the consult answered before any facilitator call");
    assert.ok(String(body.error).includes(NEW_SENTENCE), String(body.error));
    assert.doesNotMatch(String(body.error), OLD_SENTENCE);
  } finally {
    stub.restore();
    d1.close();
  }
});

test("the conflict 409 on the TAKE path (after /verify): /verify HAD the signed authorisation, so the words must not say nothing was sent to the facilitator", async () => {
  const d1 = createLocalD1();
  const header = paymentHeaderFor(TREASURY_ADDRESS, "1000000");
  const { key, validBefore } = claimKeyFromPayload(JSON.parse(atob(header)), REQS);
  // The conflicting claim lands while this request is in /verify (the stub's hook runs synchronously, so it is written through the raw connection): the consult, before /verify, found
  // nothing, so the conflict surfaces only at the claim INSERT.
  const stub = stubFacilitator({
    onVerify: () =>
      void d1.raw
        .prepare(
          "INSERT INTO settlement_claims (network, asset, from_addr, nonce, route, intent_json, intent_hash, rpc_body, rpc_body_hash, valid_before, state, booked_refs, created_at, updated_at) VALUES (?, ?, ?, ?, 'register', '{}', 'h', 'b', 'h', ?, 'pending', '{}', 1, 1)",
        )
        .run(key.network, key.asset, key.from, key.nonce, validBefore),
  });
  try {
    const res = await callWorker(patronReq("rent", header), testEnv(d1));
    const body = await json(res);
    assert.equal(res.status, 409, JSON.stringify(body));
    assert.equal(body.code, SETTLEMENT_CLAIM_CONFLICT);
    assert.equal(stub.calls.verify, 1, "the authorisation HAD been sent to /verify, so 'nothing was sent to the facilitator' would be false here");
    assert.equal(stub.calls.settle, 0, "and nothing was sent to /settle");
    assert.ok(String(body.error).includes(NEW_SENTENCE), String(body.error));
    assert.doesNotMatch(String(body.error), OLD_SENTENCE, "the unqualified sentence is gone");
    assert.equal(count(d1, "ledger"), 0);
  } finally {
    stub.restore();
    d1.close();
  }
});

test("takeClaim's 503 (the row that conflicted cannot be read back) says /settle too: a vanished row is not production-reachable (rows are never deleted), so it is driven through a database that reports a conflict and no row", async () => {
  const db = {
    prepare: () => ({
      bind: () => ({ run: async () => ({ meta: { changes: 0 } }), first: async () => null }),
    }),
  };
  const env = { DB: db } as unknown as Parameters<typeof takeClaim>[0];
  const payload = { payload: { authorization: { from: "0x00000000000000000000000000000000000000fa", to: "0x1", value: "1000000", validBefore: "9999999999", nonce: "0x" + "ab".repeat(32) } } };
  const { key, validBefore } = claimKeyFromPayload(payload, REQS);
  const spec: ClaimSpec = { route: "patron", intent: { line: "x" } };
  const id = await claimIdentity(key, validBefore, { paymentPayload: payload }, spec);
  await assert.rejects(
    () => takeClaim(env, id, spec, "A", Date.now()),
    (e: unknown) => {
      assert.ok(e instanceof SocietyError);
      assert.equal(e.status, 503);
      assert.ok(e.message.includes("Nothing was sent to the facilitator's /settle."), e.message);
      assert.doesNotMatch(e.message, /sent to the facilitator\.$/);
      return true;
    },
  );
});
