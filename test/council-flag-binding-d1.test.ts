// The council flag is one-way and public, so it is bound to its act like the council ballot (the 13 Oct flag-binding wave, docs/CHECKPOINT-COUNCIL-FLAG.md). Three bindings:
//   a secret citizen:  its secret, nothing more (a permanent credential gains nothing from per-request intent);
//   a key citizen:     an assertion whose "b" is council_flag:<sha256 of [motion id]> (a NEW op in keyauth's INTENT_OPS);
//   a resident:        {number, assertion}, no Authorization and no token, "b" is resident_council_flag:<sha256 of [number, motion id]> signed by the BOUND key.
// Each block names the mutant that turns it red.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { councilCast, openMotion, flagMotion, motionRow, rows, citizenAssertion, bearerHeader, call } from "./helpers/council.ts";
import { buildIntentBinding, INTENT_OPS } from "../src/keyauth.ts";
import { citizenCouncilFlagParts } from "../src/council-core.ts";

const flagged = (d1: any, id: number) => motionRow(d1, id).operator_flagged_at !== null;

test("key citizen: only an assertion bound to council_flag over THIS motion flags; no intent, another motion, and the council ballot or citizen ballot ops over the same parts are each refused with the expected binding named, and no council state changes (mutants: the intent check is dropped; the op is not in INTENT_OPS)", async () => {
  const c = await councilCast();
  try {
    const m = (await openMotion(c.env, c.sis, "statement", "Bound flag")).body.id as number;
    const other = (await openMotion(c.env, c.key, "statement", "Another")).body.id as number;
    const expected = await buildIntentBinding("council_flag", citizenCouncilFlagParts(m));
    const none = await flagMotion(c.env, c.key, m, { binding: null });
    assert.equal(none.status, 403);
    assert.match(none.body.error, /carries no signed intent/);
    assert.ok(none.body.error.includes(expected), "the refusal teaches the exact binding expected");
    const wrongMotion = await flagMotion(c.env, c.key, m, { binding: await buildIntentBinding("council_flag", [String(other)]) });
    assert.equal(wrongMotion.status, 403);
    assert.match(wrongMotion.body.error, /commits to a different action/);
    for (const op of ["council_ballot", "ballot", "proposal"] as const) {
      assert.equal((await flagMotion(c.env, c.key, m, { binding: await buildIntentBinding(op, [String(m), "yes"]) })).status, 403, `${op} over [motion, choice]`);
      assert.equal((await flagMotion(c.env, c.key, m, { binding: await buildIntentBinding(op, [String(m)]) })).status, 403, `${op} over [motion]`);
    }
    assert.equal(flagged(c.d1, m), false);
    assert.equal(flagged(c.d1, other), false);
    assert.equal(rows(c.d1, "SELECT * FROM council_ballots").length, 0);
    const ok = await flagMotion(c.env, c.key, m);
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(flagged(c.d1, m), true);
    assert.equal(flagged(c.d1, other), false, "the flag landed on the motion it was signed for");
    assert.equal(motionRow(c.d1, m).operator_flagged_by_id, c.key.id);
    assert.ok(INTENT_OPS.includes("council_flag" as never));
  } finally {
    c.d1.close();
  }
});

test("key citizen: an unbound flag assertion burns its citizen nonce (documented, authenticate() runs first) but changes no council state, and the same assertion cannot then be redirected to a bound flag (mutant: the intent check runs after the motion is read and written)", async () => {
  const c = await councilCast();
  try {
    const m = (await openMotion(c.env, c.sis, "statement", "Nonce")).body.id as number;
    const before = rows(c.d1, "SELECT * FROM auth_nonces").length;
    const a = await citizenAssertion(c.key, null);
    const r = await call(c.env, "POST", `/api/council/motion/${m}/flag`, {}, bearerHeader(a));
    assert.equal(r.status, 403);
    assert.equal(rows(c.d1, "SELECT * FROM auth_nonces").length, before + 1, "the nonce is spent by authenticate, as for every refused bound act");
    const again = await call(c.env, "POST", `/api/council/motion/${m}/flag`, {}, bearerHeader(a));
    assert.ok([401, 403].includes(again.status));
    assert.equal(flagged(c.d1, m), false);
    assert.deepEqual(rows(c.d1, "SELECT * FROM council_thread"), []);
  } finally {
    c.d1.close();
  }
});

test("key citizen: an unbound credential learns nothing about the motion (a missing motion id answers the binding refusal, not 404), so the intent check precedes the motion read (mutant: the motion is read first)", async () => {
  const c = await councilCast();
  try {
    const r = await flagMotion(c.env, c.key, 999999, { binding: null });
    assert.equal(r.status, 403, JSON.stringify(r.body));
    assert.match(r.body.error, /carries no signed intent/);
    const bound = await flagMotion(c.env, c.key, 999999);
    assert.deepEqual([bound.status, bound.body.code], [404, "council_motion_missing"], "a bound credential reaches the motion lookup");
  } finally {
    c.d1.close();
  }
});

test("a secret citizen is exempt from the signed intent (a bearer secret gains nothing from it), and the operator's seat is still refused (mutants: the exemption is removed; the seat's refusal is dropped)", async () => {
  const c = await councilCast();
  try {
    const m = (await openMotion(c.env, c.key, "statement", "Secret exempt")).body.id as number;
    const seat = await flagMotion(c.env, c.seat, m);
    assert.deepEqual([seat.status, seat.body.code], [403, "council_operator_cannot_flag"]);
    assert.equal(flagged(c.d1, m), false);
    assert.equal((await flagMotion(c.env, c.sis, m)).status, 201);
    assert.equal(motionRow(c.d1, m).operator_flagged_by_id, c.sis.id);
  } finally {
    c.d1.close();
  }
});
