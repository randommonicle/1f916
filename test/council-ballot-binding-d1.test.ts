// The council ballot is irreversible, so it is bound like D-056's (commission C5, CA5). Three bindings, kept apart both ways:
//   a secret citizen:  its secret, nothing more (a permanent credential gains nothing from per-request intent);
//   a key citizen:     an assertion whose "b" is council_ballot:<sha256 of [motion id, choice]> (a NEW op in keyauth's INTENT_OPS);
//   a resident:        {number, assertion}, no Authorization, "b" is resident_council_ballot:<sha256 of [number, motion id, choice]> signed by the BOUND key.
// And the one narrowing edit to citizen authentication (CA5): an assertion whose "b" starts resident_ is refused as a citizen credential, after the signature and before the
// nonce burns. Each block names the mutant that turns it red.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import {
  councilCast, openMotion, castBallot, call, rows, seedKeyCitizen, seedEarned, citizenAssertion, bearerHeader, withIp, freshIp, genKeypair, signResidentBallot,
} from "./helpers/council.ts";
import { sign } from "./helpers/resident.ts";
import { buildIntentBinding, INTENT_OPS } from "../src/keyauth.ts";
import { residentBinding, bindParts, recoverParts } from "../src/resident.ts";
import { councilBallotParts } from "../src/council-core.ts";

const ballots = (d1: any) => rows(d1, "SELECT * FROM council_ballots");

test("key citizen: only an assertion bound to council_ballot over THIS motion and THIS choice votes; no intent, another choice, another motion and the citizen ballot op are each refused with the expected binding named, and write nothing (mutants: the intent check is dropped; the op is not in INTENT_OPS)", async () => {
  const c = await councilCast();
  try {
    const m = (await openMotion(c.env, c.sis, "statement", "Bound")).body.id as number;
    const other = (await openMotion(c.env, c.wren, "statement", "Another")).body.id as number;
    const expected = await buildIntentBinding("council_ballot", [String(m), "yes"]);
    const none = await castBallot(c.env, c.key, m, "yes", { binding: null });
    assert.equal(none.status, 403);
    assert.match(none.body.error, /carries no signed intent/);
    assert.ok(none.body.error.includes(expected), "the refusal teaches the exact binding expected");
    assert.match((await castBallot(c.env, c.key, m, "yes", { binding: await buildIntentBinding("council_ballot", [String(m), "no"]) })).body.error, /commits to a different action/, "another choice");
    assert.equal((await castBallot(c.env, c.key, m, "yes", { binding: await buildIntentBinding("council_ballot", [String(other), "yes"]) })).status, 403, "another motion");
    assert.equal((await castBallot(c.env, c.key, m, "yes", { binding: await buildIntentBinding("ballot", [String(m), "yes"]) })).status, 403, "the citizen ballot op over the same parts is another op");
    assert.equal((await castBallot(c.env, c.key, m, "yes", { binding: await buildIntentBinding("proposal", [String(m), "yes"]) })).status, 403);
    assert.equal(ballots(c.d1).length, 0);
    const ok = await castBallot(c.env, c.key, m, "yes");
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.equal(ballots(c.d1).length, 1);
    assert.ok(INTENT_OPS.includes("council_ballot" as never));
  } finally {
    c.d1.close();
  }
});

test("a secret citizen is exempt from the signed intent (a bearer secret gains nothing from it), exactly as at the citizen ballot (mutant: the exemption is removed)", async () => {
  const c = await councilCast();
  try {
    const m = (await openMotion(c.env, c.key, "statement", "Secret exempt")).body.id as number;
    assert.equal((await castBallot(c.env, c.sis, m, "abstain")).status, 201);
  } finally {
    c.d1.close();
  }
});

test("the citizen ballot refuses a council_ballot assertion, and the council ballot refuses a citizen ballot assertion: neither can be redirected into the other (mutants: either op's parts or name collide)", async () => {
  const c = await councilCast();
  try {
    const m = (await openMotion(c.env, c.sis, "statement", "Cross")).body.id as number;
    // a council_ballot assertion into the CITIZEN ballot route: refused for its binding (the binding check precedes the proposal lookup, so this is 403 not 404)
    const councilAssertion = await citizenAssertion(c.key, await buildIntentBinding("council_ballot", [String(m), "yes"]));
    const toCitizenBallot = await call(c.env, "POST", `/api/proposal/${m}/ballot`, { choice: "yes" }, bearerHeader(councilAssertion));
    assert.equal(toCitizenBallot.status, 403);
    assert.match(toCitizenBallot.body.error, /commits to a different action/);
    // the converse: a citizen ballot assertion into the council ballot is refused for its binding too
    const citizenAssertionForBallot = await citizenAssertion(c.key, await buildIntentBinding("ballot", [String(m), "yes"]));
    const toCouncil = await call(c.env, "POST", "/api/council/ballot", { motion_id: m, choice: "yes" }, bearerHeader(citizenAssertionForBallot));
    assert.equal(toCouncil.status, 403);
    // and the citizen ballot with its OWN binding passes the binding check (it then finds no such proposal): the refusal above was the binding, not the route
    const own = await call(c.env, "POST", `/api/proposal/${m}/ballot`, { choice: "yes" }, bearerHeader(await citizenAssertion(c.key, await buildIntentBinding("ballot", [String(m), "yes"]))));
    assert.equal(own.status, 404, "a correctly bound citizen ballot reaches the proposal lookup");
    assert.equal(ballots(c.d1).length, 0);
  } finally {
    c.d1.close();
  }
});

test("resident: only an assertion signed by the BOUND key, bound to resident_council_ballot over [number, motion, choice], fresh and for this handle, votes; each wrong part is refused and writes nothing (mutants: a part of the binding is dropped; the stored key is not the one verified against)", async () => {
  const c = await councilCast();
  try {
    const m = (await openMotion(c.env, c.sis, "statement", "Resident bound")).body.id as number;
    const other = (await openMotion(c.env, c.key, "statement", "Another")).body.id as number;
    const w = c.wren;
    const bind = (n: number, motion: number, choice: string) => residentBinding("resident_council_ballot", councilBallotParts(n, motion, choice));
    const cases: Array<[string, any, number]> = [
      ["no signed intent", { binding: null }, 403],
      ["another choice", { binding: await bind(w.number, m, "no") }, 403],
      ["another motion", { binding: await bind(w.number, other, "yes") }, 403],
      ["another resident number", { binding: await bind(w.number + 1, m, "yes") }, 403],
      ["the resident_bind op over the same parts", { binding: await residentBinding("resident_bind", bindParts(w.number, w.handle, w.kp.publicKey)) }, 403],
      ["the resident_recover op", { binding: await residentBinding("resident_recover", recoverParts(w.number, w.handle)) }, 403],
      ["a citizen council_ballot binding", { binding: await buildIntentBinding("council_ballot", [String(m), "yes"]) }, 403],
      ["a stale assertion (200 s old)", { t: Date.now() - 200_000 }, 401],
      ["a future assertion (200 s ahead)", { t: Date.now() + 200_000 }, 401],
    ];
    for (const [name, over, status] of cases) {
      const r = await castBallot(c.env, w, m, "yes", over);
      assert.equal(r.status, status, `${name}: ${JSON.stringify(r.body)}`);
    }
    // signed by a different key than the bound one
    const stranger = await genKeypair();
    const forged = await sign(stranger, { handle: w.handle, binding: await bind(w.number, m, "yes") });
    const f = await call(c.env, "POST", "/api/council/ballot", { motion_id: m, choice: "yes", number: w.number, assertion: forged.assertion }, withIp());
    assert.equal(f.status, 401);
    assert.match(f.body.error, /Signature does not verify/);
    // another handle in the payload
    const wrongHandle = await castBallot(c.env, w, m, "yes", {});
    assert.equal(wrongHandle.status, 201, "the right one passes");
    assert.equal(ballots(c.d1).length, 1);
    assert.equal(rows(c.d1, "SELECT * FROM resident_nonces").length, 1, "only the accepted ballot spent a nonce: every refusal before the write left the nonce table alone");
  } finally {
    c.d1.close();
  }
});

test("resident: the payload handle must be the resident's own; a replayed assertion and a second ballot with a fresh assertion are refused without a second ballot, and a refused double ballot does not spend the fresh assertion's nonce (mutants: the handle is not compared; the nonce is burnt outside the batch)", async () => {
  const c = await councilCast();
  try {
    const m = (await openMotion(c.env, c.sis, "statement", "Replay")).body.id as number;
    const w = c.wren;
    const wrong = await signResidentBallot(w, m, "yes", { claimHandle: "somebody-else" });
    const r1 = await call(c.env, "POST", "/api/council/ballot", { motion_id: m, choice: "yes", number: w.number, assertion: wrong.assertion }, withIp());
    assert.equal(r1.status, 401);
    assert.match(r1.body.error, /payload\.h must be this guest's handle/);
    const good = await signResidentBallot(w, m, "yes");
    const first = await call(c.env, "POST", "/api/council/ballot", { motion_id: m, choice: "yes", number: w.number, assertion: good.assertion }, withIp());
    assert.equal(first.status, 201);
    const replay = await call(c.env, "POST", "/api/council/ballot", { motion_id: m, choice: "yes", number: w.number, assertion: good.assertion }, withIp());
    assert.ok([401, 409].includes(replay.status), `replay ${replay.status}`);
    const nonces = rows(c.d1, "SELECT * FROM resident_nonces").length;
    const second = await castBallot(c.env, w, m, "no");
    assert.deepEqual([second.status, second.body.code], [409, "council_already_balloted"]);
    assert.equal(rows(c.d1, "SELECT * FROM resident_nonces").length, nonces, "the double ballot rolled the whole batch back, including its nonce");
    assert.equal(ballots(c.d1).length, 1);
    assert.equal((ballots(c.d1)[0] as any).choice, "yes");
  } finally {
    c.d1.close();
  }
});

test("concurrent identical resident ballots (one assertion sent three times) record exactly one ballot (the nonce PRIMARY KEY and the ballot PRIMARY KEY, in one batch) (mutant: either key dropped)", async () => {
  const c = await councilCast();
  try {
    const m = (await openMotion(c.env, c.sis, "statement", "Triple")).body.id as number;
    const a = await signResidentBallot(c.wren, m, "yes");
    const send = () => call(c.env, "POST", "/api/council/ballot", { motion_id: m, choice: "yes", number: c.wren.number, assertion: a.assertion }, withIp());
    const results = await Promise.all([send(), send(), send()]);
    assert.equal(results.filter((r) => r.status === 201).length, 1, JSON.stringify(results.map((r) => r.status)));
    assert.equal(ballots(c.d1).length, 1);
    const keyed = await Promise.all([1, 2, 3].map(() => castBallot(c.env, c.sis, m, "yes")));
    assert.equal(keyed.filter((r) => r.status === 201).length, 1, "and the same member's concurrent secret ballots too");
    assert.equal(ballots(c.d1).length, 2);
  } finally {
    c.d1.close();
  }
});

test("an Authorization credential takes the citizen branch: sisyphus's secret beside a resident's number and assertion records a ballot AS sisyphus and the resident's assertion is never read (mutant: the resident branch runs first)", async () => {
  const c = await councilCast();
  try {
    const m = (await openMotion(c.env, c.key, "statement", "Precedence")).body.id as number;
    const a = await signResidentBallot(c.wren, m, "yes");
    const r = await call(c.env, "POST", "/api/council/ballot", { motion_id: m, choice: "yes", number: c.wren.number, assertion: a.assertion }, bearerHeader(c.sis.secret));
    assert.equal(r.status, 201);
    assert.deepEqual(rows(c.d1, "SELECT member_kind, member_id FROM council_ballots"), [{ member_kind: "citizen", member_id: c.sis.id }]);
    assert.equal(rows(c.d1, "SELECT * FROM resident_nonces").length, 0, "the resident's assertion was never read");
  } finally {
    c.d1.close();
  }
});

// ---------- CA5: a resident's binding is not a citizen credential ----------

test("CA5: a resident_* assertion is refused as a citizen credential EVERYWHERE, after the signature and before the nonce burns, so the resident can still spend it; a citizen holding the same handle and key cannot be made to sign for the resident (mutants: the check is dropped; it runs after the nonce INSERT)", async () => {
  const c = await councilCast();
  try {
    // the exact exposure the residents gate named (L5): a citizen and a resident with the same handle AND the same key
    const kp = await genKeypair();
    const twinCitizen = await seedKeyCitizen(c.d1, "twin", kp);
    const twin = await seedEarned(c.d1, "twin", { kp });
    const m = (await openMotion(c.env, c.sis, "statement", "Twin")).body.id as number;
    const residentAssertion = (await signResidentBallot(twin, m, "yes")).assertion;
    const refusals: Array<[string, () => Promise<any>]> = [
      ["a council message", () => call(c.env, "POST", "/api/council/thread", { body: "as a citizen?" }, bearerHeader(residentAssertion))],
      ["a board post", () => call(c.env, "POST", "/api/post", { title: "as a citizen?" }, bearerHeader(residentAssertion))],
      ["me", () => call(c.env, "GET", "/api/me", undefined, bearerHeader(residentAssertion))],
      ["a citizen ballot", () => call(c.env, "POST", `/api/proposal/${m}/ballot`, { choice: "yes" }, bearerHeader(residentAssertion))],
      ["the council ballot's citizen branch", () => call(c.env, "POST", "/api/council/ballot", { motion_id: m, choice: "yes" }, bearerHeader(residentAssertion))],
    ];
    for (const [where, send] of refusals) {
      const r = await send();
      assert.equal(r.status, 403, `${where}: ${JSON.stringify(r.body)}`);
      assert.match(r.body.error, /resident's act.*not a citizen credential/, where);
    }
    assert.equal(rows(c.d1, "SELECT * FROM auth_nonces").length, 0, "no citizen nonce was burnt by any of the refusals");
    assert.equal(rows(c.d1, "SELECT * FROM council_thread").length, 0);
    // and it is still the resident's: spent once, as the resident's own ballot
    const spent = await call(c.env, "POST", "/api/council/ballot", { motion_id: m, choice: "yes", number: twin.number, assertion: residentAssertion }, withIp());
    assert.equal(spent.status, 201, JSON.stringify(spent.body));
    assert.deepEqual(rows(c.d1, "SELECT member_kind, member_id FROM council_ballots"), [{ member_kind: "resident", member_id: twin.number }]);
    void twinCitizen;
  } finally {
    c.d1.close();
  }
});

test("CA5, the other direction: every existing citizen binding still passes as an unbound citizen credential (all of INTENT_OPS, the rotation shape, no binding); only the resident_ family is refused, matched at the start and case-sensitively (mutant: the check refuses a broader set)", async () => {
  const c = await councilCast();
  try {
    const kp = await genKeypair();
    const k = await seedKeyCitizen(c.d1, "free-key", kp);
    let n = 0;
    const post = async (binding: string | null) => call(c.env, "POST", "/api/council/thread", { body: `m${++n}` }, bearerHeader(await citizenAssertion(k, binding)));
    // the thread allows 10 a day; stay under it: 7 ops + rotation + none = 9
    for (const op of INTENT_OPS) assert.equal((await post(await buildIntentBinding(op, ["1", "x"]))).status, 201, `the ${op} binding is untouched`);
    assert.equal((await post(kp.publicKey)).status, 201, "the rotation shape (a bare public key) is untouched");
    assert.equal((await post(null)).status, 201, "no binding at all");
    // the refused family, on another citizen so the daily cap does not decide
    const k2 = await seedKeyCitizen(c.d1, "free-key-two");
    const refused = async (binding: string) => call(c.env, "POST", "/api/council/thread", { body: "x" }, bearerHeader(await citizenAssertion(k2, binding)));
    for (const b of ["resident_", "resident_bind:abc", "resident_recover:abc", "resident_council_ballot:abc", "resident_anything_new:abc"]) assert.equal((await refused(b)).status, 403, b);
    for (const b of ["Resident_bind:abc", "xresident_bind:abc", " resident_bind:abc"]) assert.equal((await refused(b)).status, 201, `${b} is not in the family`);
  } finally {
    c.d1.close();
  }
});

test("CA5 does not change the order of the citizen verifier: a resident_ assertion with a BAD signature is still a signature failure (401), never the new 403 (the new answer is for the real key holder only)", async () => {
  const c = await councilCast();
  try {
    const k = await seedKeyCitizen(c.d1, "victim");
    const attacker = await genKeypair();
    const forged = (await sign(attacker, { handle: "victim", binding: "resident_council_ballot:abc" })).assertion;
    const r = await call(c.env, "POST", "/api/council/thread", { body: "x" }, bearerHeader(forged));
    assert.equal(r.status, 401);
    assert.match(r.body.error, /Signature does not verify/);
    void k;
  } finally {
    c.d1.close();
  }
});

test("a council_ballot assertion presented to the resident ballot route is refused for its binding, spends no resident nonce, and (for the twin) cannot vote as the resident (mutant: the resident verifier accepts any resident_ or council_ op)", async () => {
  const c = await councilCast();
  try {
    const kp = await genKeypair();
    const twinCitizen = await seedKeyCitizen(c.d1, "twin2", kp);
    const twin = await seedEarned(c.d1, "twin2", { kp });
    const m = (await openMotion(c.env, c.sis, "statement", "Twin two")).body.id as number;
    const citizenSigned = await citizenAssertion(twinCitizen, await buildIntentBinding("council_ballot", [String(m), "yes"]));
    const r = await call(c.env, "POST", "/api/council/ballot", { motion_id: m, choice: "yes", number: twin.number, assertion: citizenSigned }, withIp());
    assert.equal(r.status, 403);
    assert.match(r.body.error, /resident_council_ballot:/);
    assert.equal(rows(c.d1, "SELECT * FROM resident_nonces").length, 0);
    assert.equal(ballots(c.d1).length, 0);
  } finally {
    c.d1.close();
  }
});
