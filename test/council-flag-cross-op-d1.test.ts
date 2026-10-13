// The cross-op matrix for the council flag (DEFERRED-COUNCIL-FLAG-INTENT, F3/A7): each binding is refused everywhere else, in BOTH directions, so a captured assertion cannot be
// redirected into another act. council_flag and resident_council_flag are two new ops beside council_ballot and resident_council_ballot, resident_bind and resident_recover.
// Each block names the mutant that turns it red.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { councilCast, openMotion, castBallot, flagMotion, motionRow, rows, seedKeyCitizen, seedEarned, citizenAssertion, bearerHeader, withIp, genKeypair, signResidentFlag, signResidentBallot, call } from "./helpers/council.ts";
import { buildIntentBinding } from "../src/keyauth.ts";
import { residentBinding, bindParts, recoverParts } from "../src/resident.ts";
import { councilFlagParts, councilBallotParts } from "../src/council-core.ts";

const flagged = (d1: any, id: number) => motionRow(d1, id).operator_flagged_at !== null;
const ballots = (d1: any) => rows(d1, "SELECT * FROM council_ballots");

test("a council_flag assertion cannot ballot: the citizen (constitutional) ballot and the council ballot both refuse it for its binding, and nothing is written (mutants: council_flag shares the parts and op of a ballot; either ballot accepts any council op)", async () => {
  const c = await councilCast();
  try {
    const m = (await openMotion(c.env, c.sis, "statement", "Flag cannot ballot")).body.id as number;
    const flagAssertion = async () => citizenAssertion(c.key, await buildIntentBinding("council_flag", [String(m)]));
    const toCitizenBallot = await call(c.env, "POST", `/api/proposal/${m}/ballot`, { choice: "yes" }, bearerHeader(await flagAssertion()));
    assert.equal(toCitizenBallot.status, 403, JSON.stringify(toCitizenBallot.body));
    assert.match(toCitizenBallot.body.error, /commits to a different action/);
    const toCouncilBallot = await call(c.env, "POST", "/api/council/ballot", { motion_id: m, choice: "yes" }, bearerHeader(await flagAssertion()));
    assert.equal(toCouncilBallot.status, 403, JSON.stringify(toCouncilBallot.body));
    assert.match(toCouncilBallot.body.error, /council_ballot/);
    // and the same flag assertion, built over the ballot's own parts, is no better
    const overBallotParts = await call(c.env, "POST", "/api/council/ballot", { motion_id: m, choice: "yes" }, bearerHeader(await citizenAssertion(c.key, await buildIntentBinding("council_flag", [String(m), "yes"]))));
    assert.equal(overBallotParts.status, 403);
    assert.equal(ballots(c.d1).length, 0);
    assert.equal(flagged(c.d1, m), false);
  } finally {
    c.d1.close();
  }
});

test("a council_ballot assertion (and a citizen ballot assertion) cannot flag, whatever parts it was built over; the flag stays unset (mutant: the flag accepts a ballot op)", async () => {
  const c = await councilCast();
  try {
    const m = (await openMotion(c.env, c.sis, "statement", "Ballot cannot flag")).body.id as number;
    for (const op of ["council_ballot", "ballot"] as const) {
      for (const parts of [[String(m), "yes"], [String(m)]]) {
        const r = await flagMotion(c.env, c.key, m, { binding: await buildIntentBinding(op, parts) });
        assert.equal(r.status, 403, `${op} over ${JSON.stringify(parts)}: ${JSON.stringify(r.body)}`);
        assert.match(r.body.error, /commits to a different action/);
      }
    }
    assert.equal(flagged(c.d1, m), false);
    // the control: the flag's own binding flags
    assert.equal((await flagMotion(c.env, c.key, m)).status, 201);
  } finally {
    c.d1.close();
  }
});

test("a resident_council_flag assertion cannot ballot the council, bind, recover or act as a citizen, and no nonce is spent by any refusal (mutants: the resident ballot accepts a flag op; resident_bind or resident_recover accept a council op; the resident_ prefix refusal is narrowed to named ops)", async () => {
  const { enterGuest, bindRoute, recoverRoute, nonceCount } = await import("./helpers/resident.ts");
  const { seedPost, guestComment } = await import("./helpers/guest.ts");
  const c = await councilCast();
  try {
    const kp = await genKeypair();
    const twinCitizen = await seedKeyCitizen(c.d1, "twin3", kp);
    const twin = await seedEarned(c.d1, "twin3", { kp });
    const m = (await openMotion(c.env, c.sis, "statement", "Resident flag cannot")).body.id as number;
    const flagBinding = await residentBinding("resident_council_flag", councilFlagParts(twin.number, m));
    // the council ballot's resident branch
    const toBallot = await castBallot(c.env, twin, m, "yes", { binding: flagBinding });
    assert.equal(toBallot.status, 403, JSON.stringify(toBallot.body));
    assert.match(toBallot.body.error, /resident_council_ballot:/);
    // the resident's own recover (twin is a resident with a stored key)
    const recover = await recoverRoute(c.env, { number: twin.number, handle: twin.handle, token: twin.token }, twin.kp, { binding: flagBinding });
    assert.equal(recover.status, 403, JSON.stringify(recover.body));
    assert.match(recover.body.error, /resident_recover:/);
    // resident_bind (a promoted guest with no key yet)
    const post = seedPost(c.d1, c.sis.id);
    const g = await enterGuest(c.env, "newcomer3");
    assert.equal((await guestComment(c.env, g.token, { post_id: post, body: "a first comment" })).status, 201);
    const bind = await bindRoute(c.env, g, await genKeypair(), { binding: flagBinding });
    assert.equal(bind.status, 403, JSON.stringify(bind.body));
    assert.match(bind.body.error, /resident_bind:/);
    assert.equal((c.d1.raw.prepare("SELECT public_key FROM guests WHERE visitor_id = ?").get(g.number) as { public_key: string | null }).public_key, null, "the guest is still unbound");
    // as a citizen credential (the twin holds the same handle and key): every route that authenticates a citizen refuses the resident family by prefix
    const asCitizen = (await signResidentFlag(twin, m)).assertion;
    const refusals: Array<[string, () => Promise<any>]> = [
      ["the council flag's citizen branch", () => call(c.env, "POST", `/api/council/motion/${m}/flag`, {}, bearerHeader(asCitizen))],
      ["the council ballot's citizen branch", () => call(c.env, "POST", "/api/council/ballot", { motion_id: m, choice: "yes" }, bearerHeader(asCitizen))],
      ["a citizen ballot", () => call(c.env, "POST", `/api/proposal/${m}/ballot`, { choice: "yes" }, bearerHeader(asCitizen))],
      ["a council message", () => call(c.env, "POST", "/api/council/thread", { body: "as a citizen?" }, bearerHeader(asCitizen))],
      ["me", () => call(c.env, "GET", "/api/me", undefined, bearerHeader(asCitizen))],
    ];
    for (const [where, send] of refusals) {
      const r = await send();
      assert.equal(r.status, 403, `${where}: ${JSON.stringify(r.body)}`);
      assert.match(r.body.error, /resident's act.*not a citizen credential/, where);
    }
    assert.equal(rows(c.d1, "SELECT * FROM auth_nonces").length, 0, "no citizen nonce was burnt by any refusal");
    assert.equal(nonceCount(c.d1), 0, "no resident nonce was burnt by any refusal");
    assert.equal(flagged(c.d1, m), false);
    assert.equal(ballots(c.d1).length, 0);
    // and it is still the resident's: spent once, as the resident's own flag
    const spent = await call(c.env, "POST", `/api/council/motion/${m}/flag`, { number: twin.number, assertion: asCitizen }, withIp());
    assert.equal(spent.status, 201, JSON.stringify(spent.body));
    assert.deepEqual([motionRow(c.d1, m).operator_flagged_by_kind, motionRow(c.d1, m).operator_flagged_by_id], ["resident", twin.number]);
    void twinCitizen;
  } finally {
    c.d1.close();
  }
});

test("the other direction on the resident side: resident_council_ballot, resident_bind, resident_recover and a citizen council_flag assertion are each refused by the resident flag for their binding, naming resident_council_flag, with no nonce spent (mutant: the resident flag accepts another resident op)", async () => {
  const c = await councilCast();
  try {
    const kp = await genKeypair();
    const twinCitizen = await seedKeyCitizen(c.d1, "twin4", kp);
    const twin = await seedEarned(c.d1, "twin4", { kp });
    const m = (await openMotion(c.env, c.sis, "statement", "Other ops cannot flag")).body.id as number;
    const bindings: Array<[string, string]> = [
      ["resident_council_ballot", await residentBinding("resident_council_ballot", councilBallotParts(twin.number, m, "yes"))],
      ["resident_bind", await residentBinding("resident_bind", bindParts(twin.number, twin.handle, twin.kp.publicKey))],
      ["resident_recover", await residentBinding("resident_recover", recoverParts(twin.number, twin.handle))],
      ["a citizen council_flag", await buildIntentBinding("council_flag", [String(m)])],
      ["a citizen council_ballot", await buildIntentBinding("council_ballot", [String(m), "yes"])],
    ];
    for (const [name, binding] of bindings) {
      const r = await flagMotion(c.env, twin, m, { binding });
      assert.equal(r.status, 403, `${name}: ${JSON.stringify(r.body)}`);
      assert.match(r.body.error, /resident_council_flag:/, name);
    }
    // the citizen twin, signing the council_flag op for the SAME motion as a citizen assertion, flags AS the citizen, never as the resident
    const citizenSigned = await citizenAssertion(twinCitizen, await buildIntentBinding("council_flag", [String(m)]));
    const viaResidentBranch = await call(c.env, "POST", `/api/council/motion/${m}/flag`, { number: twin.number, assertion: citizenSigned }, withIp());
    assert.equal(viaResidentBranch.status, 403, "a citizen's assertion in the resident fields is refused for its binding");
    assert.equal(rows(c.d1, "SELECT * FROM resident_nonces").length, 0);
    assert.equal(flagged(c.d1, m), false);
    // a resident ballot assertion is still a resident ballot (the control)
    assert.equal((await castBallot(c.env, twin, m, "yes")).status, 201);
    void signResidentBallot;
  } finally {
    c.d1.close();
  }
});
