// The resident's council flag (the 13 Oct flag-binding wave, docs/CHECKPOINT-COUNCIL-FLAG.md): {number, assertion}, no Authorization and no token, the assertion signed by the
// BOUND key and carrying resident_council_flag over [number, motion id]. The nonce is burnt in ONE batch with the flag's UPDATE, as the resident ballot's is. Each block
// names the mutant that turns it red.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { councilCast, openMotion, flagMotion, motionRow, rows, bearerHeader, call, withIp, genKeypair, seedEarned, seedResident, signResidentFlag } from "./helpers/council.ts";
import { sign } from "./helpers/resident.ts";
import { buildIntentBinding } from "../src/keyauth.ts";
import { residentBinding, bindParts, recoverParts } from "../src/resident.ts";
import { councilFlagParts, councilBallotParts } from "../src/council-core.ts";

const flagged = (d1: any, id: number) => motionRow(d1, id).operator_flagged_at !== null;
const nonces = (d1: any) => rows(d1, "SELECT * FROM resident_nonces").length;

test("resident: a token alone is not a flag (4xx naming resident_council_flag), with or without a number, and nothing is written and no nonce spent; a token beside a good assertion is never read (mutants: the token path is kept; resolveActor runs first)", async () => {
  const c = await councilCast();
  try {
    const m = (await openMotion(c.env, c.sis, "statement", "Token refused")).body.id as number;
    const url = `/api/council/motion/${m}/flag`;
    const tokenOnly = await call(c.env, "POST", url, { token: c.wren.token }, withIp());
    assert.equal(tokenOnly.status, 401, JSON.stringify(tokenOnly.body));
    assert.match(tokenOnly.body.error, /resident_council_flag/);
    assert.equal(tokenOnly.body.code, "council_flag_unbound");
    const tokenAndNumber = await call(c.env, "POST", url, { token: c.wren.token, number: c.wren.number }, withIp());
    assert.equal(tokenAndNumber.status, 400);
    assert.match(tokenAndNumber.body.error, /assertion is required/);
    const nothing = await call(c.env, "POST", url, {}, withIp());
    assert.equal(nothing.status, 401, "no credential and no assertion at all");
    assert.match(nothing.body.error, /resident_council_flag/);
    assert.equal(flagged(c.d1, m), false);
    assert.equal(nonces(c.d1), 0);
    const a = await signResidentFlag(c.wren, m);
    const both = await call(c.env, "POST", url, { token: "commonhold_visit_not-a-real-token", number: c.wren.number, assertion: a.assertion }, withIp());
    assert.equal(both.status, 201, JSON.stringify(both.body));
  } finally {
    c.d1.close();
  }
});

test("resident: only an assertion signed by the BOUND key, bound to resident_council_flag over [number, motion], fresh and for this handle, flags; each wrong part is refused, writes nothing and spends no nonce (mutants: a part of the binding is dropped; the stored key is not the one verified against)", async () => {
  const c = await councilCast();
  try {
    const m = (await openMotion(c.env, c.sis, "statement", "Resident bound flag")).body.id as number;
    const other = (await openMotion(c.env, c.key, "statement", "Another")).body.id as number;
    const w = c.wren;
    const bind = (n: number, motion: number) => residentBinding("resident_council_flag", councilFlagParts(n, motion));
    const cases: Array<[string, any, number]> = [
      ["no signed intent", { binding: null }, 403],
      ["another motion", { binding: await bind(w.number, other) }, 403],
      ["another resident number in the binding", { binding: await bind(w.number + 1, m) }, 403],
      ["the resident ballot op over the same motion", { binding: await residentBinding("resident_council_ballot", councilBallotParts(w.number, m, "yes")) }, 403],
      ["the resident_bind op", { binding: await residentBinding("resident_bind", bindParts(w.number, w.handle, w.kp.publicKey)) }, 403],
      ["the resident_recover op", { binding: await residentBinding("resident_recover", recoverParts(w.number, w.handle)) }, 403],
      ["a citizen council_flag binding", { binding: await buildIntentBinding("council_flag", [String(m)]) }, 403],
      ["a stale assertion (200 s old)", { t: Date.now() - 200_000 }, 401],
      ["a future assertion (200 s ahead)", { t: Date.now() + 200_000 }, 401],
    ];
    for (const [name, over, status] of cases) {
      const r = await flagMotion(c.env, w, m, over);
      assert.equal(r.status, status, `${name}: ${JSON.stringify(r.body)}`);
    }
    const teach = await flagMotion(c.env, w, m, { binding: null });
    assert.ok(teach.body.error.includes(await bind(w.number, m)), "the refusal teaches the exact binding expected");
    // signed by a different key than the bound one
    const stranger = await genKeypair();
    const forged = await sign(stranger, { handle: w.handle, binding: await bind(w.number, m) });
    const f = await call(c.env, "POST", `/api/council/motion/${m}/flag`, { number: w.number, assertion: forged.assertion }, withIp());
    assert.equal(f.status, 401);
    assert.match(f.body.error, /Signature does not verify/);
    // another handle in the payload
    const wrongHandle = await signResidentFlag(w, m, { claimHandle: "somebody-else" });
    const h = await call(c.env, "POST", `/api/council/motion/${m}/flag`, { number: w.number, assertion: wrongHandle.assertion }, withIp());
    assert.equal(h.status, 401);
    assert.match(h.body.error, /payload\.h must be this guest's handle/);
    // another resident's number with this resident's key
    const otherResident = await seedEarned(c.d1, "otherwren");
    const asOther = await sign(w.kp, { handle: otherResident.handle, binding: await bind(otherResident.number, m) });
    const o = await call(c.env, "POST", `/api/council/motion/${m}/flag`, { number: otherResident.number, assertion: asOther.assertion }, withIp());
    assert.equal(o.status, 401, "another resident's number with a key that is not theirs");
    assert.equal(flagged(c.d1, m), false);
    assert.equal(nonces(c.d1), 0, "every refusal before the write left the nonce table alone");
    const ok = await flagMotion(c.env, w, m);
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.deepEqual([motionRow(c.d1, m).operator_flagged_by_kind, motionRow(c.d1, m).operator_flagged_by_id], ["resident", w.number]);
    assert.equal(nonces(c.d1), 1, "only the accepted flag spent a nonce");
    assert.equal(flagged(c.d1, other), false);
  } finally {
    c.d1.close();
  }
});

test("resident: a replayed flag assertion is refused by the nonce, and a flag on an already-flagged motion is refused with the assertion SPENT (the zero-change UPDATE commits the batch) (mutants: the nonce is burnt outside the batch; the nonce is dropped from the batch)", async () => {
  const c = await councilCast();
  try {
    const m = (await openMotion(c.env, c.sis, "statement", "Replay")).body.id as number;
    const a = await signResidentFlag(c.wren, m);
    const send = (assertion: string, number = c.wren.number, motion = m) => call(c.env, "POST", `/api/council/motion/${motion}/flag`, { number, assertion }, withIp());
    assert.equal((await send(a.assertion)).status, 201);
    const replay = await send(a.assertion);
    assert.ok([401, 409].includes(replay.status), `replay ${replay.status}`);
    assert.equal(nonces(c.d1), 1, "the replay spent nothing more");
    // a second resident (joined before the next motion opens) flags an already-flagged motion with a fresh assertion
    const second = await seedEarned(c.d1, "second-wren");
    const m2 = (await openMotion(c.env, c.key, "statement", "After second")).body.id as number;
    assert.equal((await flagMotion(c.env, c.wren, m2)).status, 201);
    const before = nonces(c.d1);
    const b = await signResidentFlag(second, m2);
    const refused = await send(b.assertion, second.number, m2);
    assert.deepEqual([refused.status, refused.body.code], [409, "council_already_flagged"]);
    assert.equal(nonces(c.d1), before + 1, "the refused signed act leaves its assertion spent");
    const again = await send(b.assertion, second.number, m2);
    assert.ok([401, 409].includes(again.status));
    assert.match(again.body.error, /already been used/, "the spent assertion is refused by the nonce on its second presentation");
    assert.equal(motionRow(c.d1, m2).operator_flagged_by_id, c.wren.number, "the first flagger stands");
  } finally {
    c.d1.close();
  }
});

test("resident: concurrent identical flag assertions (one assertion sent three times) record exactly one flag and one nonce (the nonce PRIMARY KEY, in one batch with the UPDATE) (mutant: the nonce statement is dropped from the batch)", async () => {
  const c = await councilCast();
  try {
    const m = (await openMotion(c.env, c.sis, "statement", "Triple")).body.id as number;
    const a = await signResidentFlag(c.wren, m);
    const send = () => call(c.env, "POST", `/api/council/motion/${m}/flag`, { number: c.wren.number, assertion: a.assertion }, withIp());
    const results = await Promise.all([send(), send(), send()]);
    assert.equal(results.filter((r) => r.status === 201).length, 1, JSON.stringify(results.map((r) => r.status)));
    assert.equal(nonces(c.d1), 1);
  } finally {
    c.d1.close();
  }
});

test("resident: an unknown number, a resident without a seat and a resident who joined after the motion opened are refused before any nonce is spent (mutants: the claim check or the snapshot check is dropped)", async () => {
  const c = await councilCast();
  try {
    const m = (await openMotion(c.env, c.sis, "statement", "Eligibility")).body.id as number;
    const noClaim = await seedResident(c.d1, "no-claim");
    const unknown = await call(c.env, "POST", `/api/council/motion/${m}/flag`, { number: 424242, assertion: (await signResidentFlag(noClaim, m)).assertion }, withIp());
    assert.deepEqual([unknown.status, unknown.body.code], [403, "council_not_a_member"], "an unknown number");
    const notMember = await flagMotion(c.env, noClaim, m);
    assert.deepEqual([notMember.status, notMember.body.code], [403, "council_not_a_member"], "a resident without a seat");
    const late = await seedEarned(c.d1, "latecomer");
    const lateFlag = await flagMotion(c.env, late, m);
    assert.deepEqual([lateFlag.status, lateFlag.body.code], [403, "council_not_eligible"]);
    assert.equal(nonces(c.d1), 0);
    assert.equal(flagged(c.d1, m), false);
  } finally {
    c.d1.close();
  }
});

test("an Authorization credential takes the citizen branch: sisyphus's secret beside a resident's number and assertion flags AS sisyphus and the resident's assertion is never read (mutant: the resident branch runs first)", async () => {
  const c = await councilCast();
  try {
    const m = (await openMotion(c.env, c.key, "statement", "Precedence")).body.id as number;
    const a = await signResidentFlag(c.wren, m);
    const r = await call(c.env, "POST", `/api/council/motion/${m}/flag`, { number: c.wren.number, assertion: a.assertion }, bearerHeader(c.sis.secret));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual([motionRow(c.d1, m).operator_flagged_by_kind, motionRow(c.d1, m).operator_flagged_by_id], ["citizen", c.sis.id]);
    assert.equal(nonces(c.d1), 0, "the resident's assertion was never read");
  } finally {
    c.d1.close();
  }
});
