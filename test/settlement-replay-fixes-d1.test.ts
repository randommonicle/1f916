// The hub's fix pass on the settlement replay guard (2026-09-30 rulings on docs/CHECKPOINT-SETTLEMENT-REPLAY-GUARD.md's
// collected OPEN FOR HUB list):
//   F1  a registration whose handle another seat took AFTER payment is told the truth, recorded permanently, skipped by
//       the reconciler and answered (never re-attempted) on a re-send;
//   F2  the reconciler releases a listing_pay reservation when it moves the claim to expired or refused, in the SAME batch;
//   F3  the concierge keeps first claim: order sweep -> concierge -> reconciler -> clerk (see the reconcile test file);
//   F4  the backstop wording states the daily, limited pass, and the "repeat this request" clause appears only where a
//       re-send really re-checks or finishes the row.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { insertCitizen } from "./helpers/local-d1.ts";
import {
  TEST_PAYER,
  TX,
  callWorker,
  captureLog,
  count,
  createLocalD1,
  eventLines,
  json,
  oneClaim,
  realPublicKey,
  registerHeader,
  registerReq,
  stubFacilitator,
  testEnv,
  type LocalD1,
} from "./helpers/settlement-harness.ts";
import { runReconciler } from "../src/settlement-reconcile.ts";

const settledAnswer = () => new Response(JSON.stringify({ success: true, payer: TEST_PAYER, transaction: TX }), { status: 200, headers: { "content-type": "application/json" } });

// ---------- F1 ----------

async function handleLostAfterPayment(d1: LocalD1, publicKey: string | null) {
  // The handle is free at step 2 and at the afterVerify re-check, and is taken while /settle is in flight.
  const stub = stubFacilitator({
    settle: () => {
      insertCitizen(d1, { handle: "lost-handle" });
      return settledAnswer();
    },
  });
  const header = registerHeader();
  const body = { handle: "lost-handle", model: "m", ...(publicKey ? { public_key: publicKey } : {}) };
  const send = () => callWorker(registerReq(body, header), testEnv(d1));
  return { stub, send, header, body };
}

for (const mode of ["secret", "public-key"] as const) {
  test(`F1 (${mode} mode): a handle taken by another seat after payment is answered plainly, recorded permanently, skipped by the reconciler, and never re-attempted`, async () => {
    const d1 = createLocalD1();
    const fx = await handleLostAfterPayment(d1, mode === "secret" ? null : await realPublicKey());
    try {
      const { value: first, lines } = await captureLog(() => fx.send());
      assert.equal(first.status, 409);
      const answer = await json(first);
      assert.equal(answer.code, "registration_handle_taken_after_payment");
      const text = String(answer.error);
      // (a) the wording: the tx, the handle, what happened, that re-sending cannot book it, the way out, no new signature invited
      assert.ok(text.includes(TX), "names the tx");
      assert.ok(text.includes('"lost-handle"'), "names the handle");
      assert.match(text, /payment settled/);
      assert.match(text, /taken by another seat before this registration could be written/);
      assert.match(text, /Re-sending this request cannot book it and is not needed/);
      assert.match(text, /Do not sign again/);
      assert.match(text, /POST \/api\/showhome\/enter/);
      assert.match(text, /POST \/api\/showhome\/note/);
      assert.doesNotMatch(text, /Repeating this identical request|re-checks it sooner|re-attempts|once a day|06:00/, "it promises no re-check and no deadline");
      assert.equal(count(d1, "citizens WHERE handle = 'lost-handle'"), 1, "only the other seat holds the handle");
      assert.equal(count(d1, "ledger"), 1, "the payment is in the books");

      // (b) recorded permanently: state stays settled_unbooked (B2), the reason is on the claim, one log line, no generic failure line
      const row = oneClaim(d1) as unknown as { state: string; verdict_reason: string; lease_owner: string | null };
      assert.equal(row.state, "settled_unbooked");
      assert.equal(row.verdict_reason, "handle_taken");
      assert.equal(row.lease_owner, null);
      const lineCount = eventLines(lines, "registration_handle_taken_after_payment");
      assert.equal(lineCount.length, 1, "one log line when the reason is first recorded");
      assert.equal(lineCount[0].tx, TX);
      assert.equal(lineCount[0].handle_attempted, "lost-handle");
      assert.equal(eventLines(lines, "registration_paid_but_failed").length, 0, "and not also the generic failure line");

      // the reconciler does not spend budget on it: not selected, no attempt, no log
      const { value: out, lines: reconcileLines } = await captureLog(() => runReconciler(testEnv(d1)));
      assert.equal(out.examined, 0, "the reconciler skips the row");
      assert.equal(eventLines(reconcileLines, "settlement_reconcile_row_failed").length, 0);

      // (c) an identical re-send gets the same honest answer, not a re-attempt: even if the handle is free again
      d1.raw.prepare("DELETE FROM citizens WHERE handle = 'lost-handle'").run();
      const { value: again, lines: againLines } = await captureLog(() => fx.send());
      assert.equal(again.status, 409);
      assert.deepEqual(await json(again), answer, "the same answer");
      assert.equal(count(d1, "citizens"), 0, "no citizen was created by the re-send");
      assert.equal(count(d1, "ledger"), 1);
      assert.equal(eventLines(againLines, "registration_handle_taken_after_payment").length, 0, "the reason is recorded once, not per re-send");
      assert.equal(fx.stub.calls.settle, 1, "the facilitator was asked once through all of it");
    } finally {
      fx.stub.restore();
      d1.close();
    }
  });
}

test("F1 follows its own instruction (L-109): the showhome note the answer asks for, sent through the real router, lands and names the tx", async () => {
  const d1 = createLocalD1();
  const fx = await handleLostAfterPayment(d1, null);
  try {
    const first = await fx.send();
    const message = String((await json(first)).error);
    assert.match(message, /POST \/api\/showhome\/enter \(any label that is not a citizen handle\), then POST \/api\/showhome\/note/);
    // exactly as it says: enter with a label that is not a citizen handle, then leave a note naming the tx
    const entered = await callWorker(
      new Request("https://example.test/api/showhome/enter", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ handle: "payer-without-a-seat", model: "m" }) }),
      testEnv(d1),
    );
    assert.equal(entered.status, 201, JSON.stringify(await entered.clone().json()));
    const note = await callWorker(
      new Request("https://example.test/api/showhome/note", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: (await json(entered)).token, body: `I paid for the handle lost-handle and was told it was taken. tx ${TX}` }),
      }),
      testEnv(d1),
    );
    assert.ok(note.status === 200 || note.status === 201, `the note landed (${note.status})`);
    const room = await (await callWorker(new Request("https://example.test/api/showhome"), testEnv(d1))).text();
    assert.ok(room.includes(TX), "and it is on the record the maintainer reads");
  } finally {
    fx.stub.restore();
    d1.close();
  }
});
