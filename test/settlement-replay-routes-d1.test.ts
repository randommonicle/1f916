// The route-level guarantees of the settlement replay guard
// (docs/BRIEF-SETTLEMENT-REPLAY-GUARD.md, option B as amended; gate M2 of
// docs/REVIEW-X402-SETTLE-HONESTY-GATE-2026-09-29.md): one signed authorisation is
// booked once. Numbered as the brief numbers them ("Tests (replace the Tests
// section above)", 1-13, plus 14 from B6a); each test's red-proof is recorded in
// docs/CHECKPOINT-SETTLEMENT-REPLAY-GUARD.md. This file: registration and the patron
// door (tests 1, 2, 3, 5, 6, 9, 12); the harness is test/helpers/settlement-harness.ts.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { insertCitizen } from "./helpers/local-d1.ts";
import {
  TEST_PAYER,
  TREASURY_ADDRESS,
  TX,
  callWorker,
  captureLog,
  count,
  createLocalD1,
  dropTrigger,
  eventLines,
  failInserts,
  json,
  oneClaim,
  patronReq,
  paymentHeaderFor,
  realPublicKey,
  registerHeader,
  registerReq,
  stubFacilitator,
  testEnv,
} from "./helpers/settlement-harness.ts";
import { freshNonce } from "./helpers/x402-payload.ts";

// ---------- 1. an identical replay after `booked` ----------

test("1. an identical replay after booked: no /verify, no /settle, no second citizen or ledger row, 409 naming the tx (secret-mode and public-key)", async () => {
  for (const publicKey of [null, await realPublicKey()]) {
    const d1 = createLocalD1();
    const stub = stubFacilitator();
    try {
      const header = registerHeader();
      const body = { handle: "first-seat", model: "test-model", ...(publicKey ? { public_key: publicKey } : {}) };
      const first = await callWorker(registerReq(body, header), testEnv(d1));
      assert.equal(first.status, 201, JSON.stringify(await first.clone().json()));
      assert.deepEqual(stub.calls, { verify: 1, settle: 1 });
      assert.equal(oneClaim(d1).state, "booked");

      // PayAI, asked again, would serve its cached success with the SAME tx: the guard
      // refuses before it is ever asked.
      const { value: replay, lines } = await captureLog(() => callWorker(registerReq(body, header), testEnv(d1)));
      assert.equal(replay.status, 409);
      const answer = await json(replay);
      assert.equal(answer.code, "settlement_already_booked");
      assert.ok(String(answer.error).includes(TX), "the 409 names the tx");
      assert.match(String(answer.error), /nothing was charged again/);
      if (publicKey === null) assert.match(String(answer.error), /the secret cannot be recovered/, "secret-mode names its limit plainly (B5d)");
      assert.deepEqual(stub.calls, { verify: 1, settle: 1 }, "the replay reached neither /verify nor /settle");
      assert.equal(count(d1, "citizens"), 1, "no second citizen");
      assert.equal(count(d1, "ledger"), 1, "no second ledger row");
      assert.deepEqual(eventLines(lines, "x402_settle_outcome_unknown"), [], "nothing was sent, so nothing is unknown");
    } finally {
      stub.restore();
      d1.close();
    }
  }
});

test("1b. the same holds for the patron door: a replayed header is 409, one ledger line", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator();
  try {
    const header = paymentHeaderFor(TREASURY_ADDRESS, "1000000");
    const first = await callWorker(patronReq("rent", header), testEnv(d1));
    assert.equal(first.status, 200);
    const replay = await callWorker(patronReq("rent", header), testEnv(d1));
    assert.equal(replay.status, 409);
    assert.equal((await json(replay)).code, "settlement_already_booked");
    assert.equal(stub.calls.settle, 1);
    assert.equal(count(d1, "ledger"), 1);
    assert.equal(oneClaim(d1).state, "booked");
  } finally {
    stub.restore();
    d1.close();
  }
});

// ---------- 2. a divergent body reusing (from, nonce) ----------

test("2. a divergent request reusing one (from, nonce): 409, no /settle. A second handle, a second model, another door, a re-cased address", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator();
  try {
    const header = registerHeader();
    assert.equal((await callWorker(registerReq({ handle: "alpha", model: "m" }, header), testEnv(d1))).status, 201);
    const base = { verify: stub.calls.verify, settle: stub.calls.settle };

    // The registration requirements omit the handle, so this /settle body is byte-identical:
    // only the intent tells it from the payer's own re-send (B4a).
    const otherHandle = await callWorker(registerReq({ handle: "beta", model: "m" }, header), testEnv(d1));
    assert.equal(otherHandle.status, 409);
    assert.equal((await json(otherHandle)).code, "settlement_claim_conflict");
    const otherModel = await callWorker(registerReq({ handle: "alpha", model: "another-model" }, header), testEnv(d1));
    assert.equal(otherModel.status, 409);
    assert.equal((await json(otherModel)).code, "settlement_claim_conflict");

    // Another door: the same signed header to /api/patron (same payee and value, different resource).
    const otherDoor = await callWorker(patronReq("free dollar", header), testEnv(d1));
    assert.equal(otherDoor.status, 409);
    assert.equal((await json(otherDoor)).code, "settlement_claim_conflict");

    // Checksummed `from`: EIP-55 casing is presentation, not identity.
    const recased = paymentHeaderFor(TREASURY_ADDRESS, "1000000", {
      from: TEST_PAYER.replace("fa", "FA"),
      nonce: (JSON.parse(atob(header)) as { payload: { authorization: { nonce: string } } }).payload.authorization.nonce.toUpperCase().replace("0X", "0x"),
    });
    const reCased = await callWorker(registerReq({ handle: "gamma", model: "m" }, recased), testEnv(d1));
    assert.equal(reCased.status, 409, "a replay that re-cases from and nonce lands on the same claim");

    assert.deepEqual({ verify: stub.calls.verify, settle: stub.calls.settle }, base, "no divergent request was sent to the facilitator");
    assert.equal(count(d1, "citizens"), 1);
    assert.equal(count(d1, "ledger"), 1);
    assert.equal(count(d1, "settlement_claims"), 1, "no second claim row");
  } finally {
    stub.restore();
    d1.close();
  }
});

// ---------- 3. two concurrent requests with one header ----------

test("3. two concurrent requests with one header: exactly one reaches /settle, one citizen, one ledger line", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator({ verifyDelayMs: 15, settleDelayMs: 40 });
  try {
    const header = registerHeader();
    const body = { handle: "raced", model: "m" };
    const [a, b] = await Promise.all([callWorker(registerReq(body, header), testEnv(d1)), callWorker(registerReq(body, header), testEnv(d1))]);
    const statuses = [a.status, b.status].sort();
    assert.equal(stub.calls.settle, 1, "exactly one request reached /settle");
    assert.ok(statuses.includes(201), `one request books the registration: ${statuses}`);
    const loser = a.status === 201 ? b : a;
    assert.equal(loser.status, 502, "the other is told the outcome is in flight, not refused as a stranger");
    assert.match(String((await json(loser)).error), /do not sign again/i);
    assert.equal(count(d1, "citizens"), 1);
    assert.equal(count(d1, "ledger"), 1);
    assert.equal(oneClaim(d1).state, "booked");
  } finally {
    stub.restore();
    d1.close();
  }
});

// ---------- 5. the ledger append fails after settle ----------

test("5. the ledger append fails after settle -> settled_unbooked; the payer's identical re-send finishes it once (ledger once, citizen once, secret delivered for secret mode)", async () => {
  for (const publicKey of [null, await realPublicKey()]) {
    const d1 = createLocalD1();
    const stub = stubFacilitator();
    try {
      const header = registerHeader();
      const body = { handle: "resumed", model: "m", ...(publicKey ? { public_key: publicKey } : {}) };
      failInserts(d1, "no_ledger", "ledger", null, "disk I/O error");
      const first = await callWorker(registerReq(body, header), testEnv(d1));
      assert.equal(first.status, 500);
      assert.match(String((await json(first)).error), /payment settled \(tx 0xabab.*do not sign again/i);
      const stranded = oneClaim(d1);
      assert.equal(stranded.state, "settled_unbooked");
      assert.equal(stranded.tx, TX);
      assert.equal(stranded.lease_owner, null, "the failed request let go of its lease so the re-send is not told to wait");
      assert.equal(count(d1, "citizens"), 0);
      assert.equal(count(d1, "ledger"), 0);

      dropTrigger(d1, "no_ledger");
      const again = await callWorker(registerReq(body, header), testEnv(d1));
      assert.equal(again.status, 201, JSON.stringify(await again.clone().json()));
      const booked = await json(again);
      assert.equal(booked.handle, "resumed");
      if (publicKey === null) assert.match(String(booked.secret), /^commonhold_sk_[0-9a-f]{64}$/, "secret mode: the re-send receives a fresh secret");
      else assert.equal(booked.secret, undefined, "public-key mode: no secret, ever");
      assert.equal(booked.payment.tx, TX);
      assert.deepEqual(stub.calls, { verify: 1, settle: 1 }, "the re-send never called the facilitator");
      assert.equal(count(d1, "ledger"), 1, "the ledger line is written once");
      assert.equal(count(d1, "citizens"), 1, "the citizen is created once");
      const done = oneClaim(d1);
      assert.equal(done.state, "booked");
      assert.equal(done.rpc_body, null, "B7");

      // and a third identical request is now a plain replay
      const third = await callWorker(registerReq(body, header), testEnv(d1));
      assert.equal(third.status, 409);
      assert.equal(count(d1, "ledger"), 1);
      assert.equal(count(d1, "citizens"), 1);
    } finally {
      stub.restore();
      d1.close();
    }
  }
});

// ---------- 6. crashes between the writes ----------

test("6a. a crash between the ledger row and the citizen: the resume writes the citizen only", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator();
  try {
    const header = registerHeader();
    const body = { handle: "halfway", model: "m" };
    failInserts(d1, "no_citizen", "citizens", null, "disk I/O error");
    const first = await callWorker(registerReq(body, header), testEnv(d1));
    assert.equal(first.status, 500);
    assert.equal(count(d1, "ledger"), 1, "the treasury line is booked");
    assert.equal(count(d1, "citizens"), 0);
    const mid = oneClaim(d1);
    assert.equal(mid.state, "settled_unbooked");
    assert.equal(JSON.parse(mid.booked_refs).ledger_id, 1, "the claim records the ledger row it wrote");
    assert.equal(JSON.parse(mid.booked_refs).citizen_id, undefined);

    dropTrigger(d1, "no_citizen");
    const again = await callWorker(registerReq(body, header), testEnv(d1));
    assert.equal(again.status, 201);
    assert.equal(count(d1, "ledger"), 1, "the resume did not write the ledger line again");
    assert.equal(count(d1, "citizens"), 1);
    assert.equal(oneClaim(d1).state, "booked");
  } finally {
    stub.restore();
    d1.close();
  }
});

test("6b. a crash at the reference update (B5a/B5c): the batch fails as a unit, neither the row nor the reference exists", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator();
  try {
    const header = registerHeader();
    const body = { handle: "atomic", model: "m" };

    // (i) the ledger row is written and its reference update fails: the ledger row must not survive.
    d1.raw.exec("CREATE TRIGGER no_ledger_ref BEFORE UPDATE OF booked_refs ON settlement_claims WHEN NEW.booked_refs LIKE '%ledger_id%' BEGIN SELECT RAISE(ABORT, 'power cut'); END;");
    assert.equal((await callWorker(registerReq(body, header), testEnv(d1))).status, 500);
    assert.equal(count(d1, "ledger"), 0, "B5c: the ledger row is rolled back with its failed reference");
    assert.equal(oneClaim(d1).booked_refs, "{}");
    dropTrigger(d1, "no_ledger_ref");

    // (ii) the citizen row is written and its reference update fails: no orphan citizen.
    d1.raw.exec("CREATE TRIGGER no_citizen_ref BEFORE UPDATE OF booked_refs ON settlement_claims WHEN NEW.booked_refs LIKE '%citizen_id%' BEGIN SELECT RAISE(ABORT, 'power cut'); END;");
    assert.equal((await callWorker(registerReq(body, header), testEnv(d1))).status, 500);
    assert.equal(count(d1, "citizens"), 0, "B5a: the citizen row is rolled back with its failed reference");
    assert.equal(count(d1, "ledger"), 1, "the earlier step stands");
    assert.deepEqual(Object.keys(JSON.parse(oneClaim(d1).booked_refs)), ["ledger_id"]);
    dropTrigger(d1, "no_citizen_ref");

    const done = await callWorker(registerReq(body, header), testEnv(d1));
    assert.equal(done.status, 201);
    assert.equal(count(d1, "citizens"), 1);
    assert.equal(count(d1, "ledger"), 1);
    assert.equal(stub.calls.settle, 1, "through all of it the facilitator was asked once");
  } finally {
    stub.restore();
    d1.close();
  }
});

test("6c. a public-key registration crashing between the citizen and its key_registered line: the resume writes the key line only", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator();
  try {
    const publicKey = await realPublicKey();
    const header = registerHeader();
    const body = { handle: "keyed", model: "m", public_key: publicKey };
    failInserts(d1, "no_key_line", "identity_events", "NEW.kind = 'key_registered'", "disk I/O error");
    const first = await callWorker(registerReq(body, header), testEnv(d1));
    assert.equal(first.status, 500);
    assert.match(String((await json(first)).error), /A citizen may still have been created/);
    assert.equal(count(d1, "citizens"), 1);
    assert.equal(count(d1, "identity_events WHERE kind = 'key_registered'"), 0);
    assert.equal(oneClaim(d1).state, "settled_unbooked");

    dropTrigger(d1, "no_key_line");
    const again = await callWorker(registerReq(body, header), testEnv(d1));
    assert.equal(again.status, 201, JSON.stringify(await again.clone().json()));
    assert.equal(count(d1, "citizens"), 1, "the citizen is not created a second time");
    assert.equal(count(d1, "identity_events WHERE kind = 'key_registered'"), 1);
    assert.equal(count(d1, "ledger"), 1);
    assert.equal(oneClaim(d1).state, "booked");
  } finally {
    stub.restore();
    d1.close();
  }
});

// ---------- 9. a handle collision leaves no claim ----------

test("9. a handle collision leaves NO claim row: at 402-issuance (step 2) and in the afterVerify re-check", async () => {
  const d1 = createLocalD1();
  let stub = stubFacilitator();
  try {
    insertCitizen(d1, { handle: "taken-one" });
    const res = await callWorker(registerReq({ handle: "taken-one", model: "m" }, registerHeader()), testEnv(d1));
    assert.equal(res.status, 409);
    assert.equal(count(d1, "settlement_claims"), 0);
    assert.deepEqual(stub.calls, { verify: 0, settle: 0 });
    stub.restore();

    // The race: the handle is free at step 2 and taken by the time /verify returns.
    stub = stubFacilitator({ onVerify: () => void insertCitizen(d1, { handle: "raced-one" }) });
    const raced = await callWorker(registerReq({ handle: "raced-one", model: "m" }, registerHeader()), testEnv(d1));
    assert.equal(raced.status, 409);
    assert.equal(stub.calls.settle, 0, "the afterVerify check refused before settle");
    assert.equal(count(d1, "settlement_claims"), 0, "a free-check failure takes no claim");
  } finally {
    stub.restore();
    d1.close();
  }
});

// ---------- 12. a fresh authorisation from the same payer still registers ----------

test("12. a fresh authorisation (new nonce) from the same payer still registers", async () => {
  const d1 = createLocalD1();
  const stub = stubFacilitator();
  try {
    const one = await callWorker(registerReq({ handle: "payer-one", model: "m" }, paymentHeaderFor(TREASURY_ADDRESS, "1000000", { nonce: freshNonce() })), testEnv(d1));
    const two = await callWorker(registerReq({ handle: "payer-two", model: "m" }, paymentHeaderFor(TREASURY_ADDRESS, "1000000", { nonce: freshNonce() })), testEnv(d1));
    assert.equal(one.status, 201);
    assert.equal(two.status, 201, "the same payer, a new nonce: a new claim, a new seat");
    assert.equal(count(d1, "citizens"), 2);
    assert.equal(count(d1, "settlement_claims WHERE state = 'booked'"), 2);
    assert.equal(stub.calls.settle, 2);
  } finally {
    stub.restore();
    d1.close();
  }
});
