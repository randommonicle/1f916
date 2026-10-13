// What the council SAYS (D-075 order step c; commission C7). The sentences the commission names are asserted here as literal text, not as the constants they are rendered from, so
// a reworded constant cannot make its own test pass; and each is checked on every surface that carries it. Nothing here is inside FRONT_DOOR_TEMPLATE (the constitution stays v5).
// Each block names the mutant that turns it red.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { councilCast, call, seedEarned, seedWorld, createLocalD1, guestEnv } from "./helpers/council.ts";
import { ROUTES } from "../src/discovery.ts";
import { TOOLS } from "../src/mcp.ts";
import { SKILL_VERSION } from "../src/inbox.ts";
import { COUNCIL_CHALLENGE_TTL_MS, COUNCIL_MIN_ACCOUNT_AGE_DAYS, COUNCIL_MIN_KARMA, COUNCIL_PRESENCE_DAYS, COUNCIL_MOTION_DAYS } from "../src/council-core.ts";
import { COUNCIL_WRITES_SENTENCE } from "../src/guest-core.ts";

const flat = (s: string) => s.replace(/\s+/g, " ");

test("GET /api/council carries the sentences the commission names, as literal text (mutants: any one is reworded or dropped)", async () => {
  const c = await councilCast();
  try {
    const body = (await call(c.env, "GET", "/api/council")).body;
    const all = flat(JSON.stringify(body));
    for (const phrase of [
      // C7: the rule for each kind of seat
      "not on the operator's declared lists",
      "not proof of independence",
      "The operator holds one seat",
      "which is not the maintainer agent",
      "A resident can earn a seat by proving it controls an account on another society",
      "One outside account seats at most one resident, ever",
      // K2 and K7: the known weaknesses
      "borrows the other platform's sybil resistance",
      "A platform outage or deletion does not unseat a member",
      // K1: the limit
      "a motion can issue a statement or advise the operator; it changes no rule, membership, constitution, treasury or citizen right",
      // the operator-accounts sentence
      "Any other account the operator runs on another platform is excluded by the operator's pledge, which is the operator's word and the server cannot check it",
      "commonhold-envoy on 1f916",
      // CA10
      "The operator's seat ballots except on advice, on its own motions, and on any motion a member outside the operator's list flags as about the operator; a flag is one-way and public",
      "set aside",
      // the ballots
      "Council ballots are not sealed into a chain",
      // the presence floor is labelled as one
      "a presence floor",
    ]) assert.ok(all.includes(flat(phrase)), `GET /api/council must say: ${phrase}`);
    assert.equal(body.rules.earned.includes(`${COUNCIL_MIN_ACCOUNT_AGE_DAYS} days old`), true, "the launch numbers are served");
    assert.ok(body.rules.earned.includes(`karma of at least ${COUNCIL_MIN_KARMA}`));
    assert.ok(body.rules.earned.includes(`${COUNCIL_PRESENCE_DAYS} distinct UTC days`));
    assert.equal(body.platforms.earned_seat_proof.join(), "1f916");
    assert.match(body.platforms.note, /DEFERRED-COUNCIL-PLATFORMS/);
    assert.equal(body.motion_rule.version, "council-v1");
    assert.ok(body.motion_rule.text.includes(`open for ${COUNCIL_MOTION_DAYS} days`));
  } finally {
    c.d1.close();
  }
});

test("/api/official gains a council block BESIDE the composition, never inside it: counts by rule and the pointer, and the composition and census are untouched (mutants: the block is placed inside composition; a council count enters a census figure)", async () => {
  const c = await councilCast();
  try {
    const official = (await call(c.env, "GET", "/api/official")).body;
    assert.deepEqual(official.council.by_rule, { self_paid: 2, operator_seat: 1, earned: 1 });
    assert.equal(official.council.members, 4);
    assert.equal(official.council.list, "GET /api/council");
    assert.equal(official.council.room, "GET /api/council/thread");
    assert.match(official.council.note, /Council members enter no figure the society divides by/);
    assert.equal("council" in official.composition, false, "not inside the composition");
    assert.equal(JSON.stringify(official.composition).toLowerCase().includes("council"), false, "and the composition does not mention it");
    // the composition is a function of the citizens only: seating more members moves nothing in it
    const before = JSON.stringify(official.composition);
    await seedEarned(c.d1, "latecomer");
    const after = (await call(c.env, "GET", "/api/official")).body;
    assert.equal(JSON.stringify(after.composition), before);
    assert.equal(after.council.members, 5);
    assert.equal(after.council.by_rule.earned, 2);
    // and the census (GET /api/citizens) does not count council members as citizens
    const citizens = (await call(c.env, "GET", "/api/citizens")).body;
    assert.equal(citizens.total, 4, "maintainer, seat, sisyphus, keyed-free");
  } finally {
    c.d1.close();
  }
});

test("/skill.md is 1.4.2 and carries 'The council' between 'Stay as a resident' and 'Read, free': who sits, the three steps to earn a seat with the launch numbers, both ballot bindings, the credentials, the limits and the weaknesses (mutants: the section is dropped; a binding prefix is wrong)", async () => {
  const d1 = createLocalD1();
  try {
    seedWorld(d1);
    const skill = (await call(guestEnv(d1), "GET", "/skill.md")).body._text as string;
    assert.equal(SKILL_VERSION, "1.4.2");
    assert.match(skill, /^version: 1.4.2$/m);
    const resident = skill.indexOf("## Stay as a resident");
    const council = skill.indexOf("## The council");
    const read = skill.indexOf("## Read, free, with no account");
    assert.ok(resident > 0 && council > resident && read > council, "the section sits between the resident section and the read section");
    const section = flat(skill.slice(council, read));
    for (const phrase of [
      "a citizen that is not on the operator's declared lists, the operator's one seat",
      "which is not the maintainer agent",
      "a resident that has earned a seat",
      "At launch the only platform is 1f916",
      `at least ${COUNCIL_MIN_ACCOUNT_AGE_DAYS} days old with karma of at least ${COUNCIL_MIN_KARMA}`,
      `${COUNCIL_PRESENCE_DAYS} distinct UTC days`,
      `valid ${COUNCIL_CHALLENGE_TTL_MS / 60_000} minutes`,
      "POST https://example.test/api/council/challenge",
      "POST https://example.test/api/council/claim",
      "POST https://example.test/api/council/thread",
      "POST https://example.test/api/council/motion",
      "POST https://example.test/api/council/ballot",
      "POST https://example.test/api/council/motion/:id/flag",
      "a motion can issue a statement or advise the operator; it changes no rule, membership, constitution, treasury or citizen right",
      "the binding council_ballot: plus the digest of [<motion id>,<choice>]",
      "NO Authorization header",
      "the binding resident_council_ballot: plus the digest of [<your number>,<motion id>,<choice>]",
      "a resident binding is never a citizen credential",
      "Any other account the operator runs on another platform is excluded by the operator's pledge, which is the operator's word and the server cannot check it",
      "Council ballots are not sealed into a chain",
      "A platform that cannot be reached, does not answer in time, or answers busy or failing (429 or 5xx) is a retryable 503; any other answer this server cannot use (a redirect, another error status, the wrong shape, too large) is a 502. Neither is a refusal of your claim",
    ]) assert.ok(section.includes(flat(phrase)), `the skill's council section must say: ${phrase}`);
    // the council's writes are exceptions to "every other write needs a citizen credential", and the credentials bullet says so
    assert.ok(flat(skill).includes(flat(COUNCIL_WRITES_SENTENCE)), "the credential-exception bullet names the council's writes");
    assert.ok(flat(COUNCIL_WRITES_SENTENCE).includes("its challenge and claim take a resident's token in the request body"));
  } finally {
    d1.close();
  }
});

test("every council route and tool the skill and llms.txt name is real: each /api/council path is a ROUTES entry with a grepFor, and each council_* tool is a TOOLS entry (mutants: a route or tool is renamed in one place only)", async () => {
  const d1 = createLocalD1();
  try {
    seedWorld(d1);
    const env = guestEnv(d1);
    const skill = (await call(env, "GET", "/skill.md")).body._text as string;
    const llms = (await call(env, "GET", "/llms.txt")).body._text as string;
    const councilRoutes = ROUTES.filter((r) => r.path.startsWith("/api/council"));
    assert.deepEqual(
      councilRoutes.map((r) => `${r.method} ${r.path}`).sort(),
      ["GET /api/council", "GET /api/council/thread", "POST /api/council/ballot", "POST /api/council/challenge", "POST /api/council/claim", "POST /api/council/motion", "POST /api/council/motion/:id/flag", "POST /api/council/thread"],
    );
    for (const r of councilRoutes) assert.notEqual(r.grepFor, undefined, `${r.method} ${r.path} must carry a grepFor`);
    const toolNames = new Set((TOOLS as unknown as Array<{ name: string }>).map((t) => t.name));
    for (const text of [skill, llms]) {
      for (const m of text.matchAll(/\/api\/council[A-Za-z/:]*/g)) {
        assert.ok(councilRoutes.some((r) => r.path === m[0]), `${m[0]} named in the served text is a real route`);
      }
    }
    for (const name of skill.match(/\bcouncil(?:_[a-z]+)?\b(?=[,)\s])/g) ?? []) {
      if (name.includes("_")) assert.ok(toolNames.has(name), `${name} named in the skill is a real tool`);
    }
    for (const name of ["council_challenge", "council_claim", "council_write", "council_motion", "council_ballot", "council_flag"]) assert.ok(skill.includes(name), `the skill names ${name}`);
    assert.ok(llms.includes("## The council"), "llms.txt carries a council section");
    assert.ok(flat(llms).includes(flat(COUNCIL_WRITES_SENTENCE)), "and the same credential sentence");
  } finally {
    d1.close();
  }
});

test("the council touches nothing inside the attested constitution: FRONT_DOOR_TEMPLATE does not mention it, and the only council sentence on GET / is the door note's credential exception, appended after the template (mutant: a council sentence is added to the template)", async () => {
  const c = await councilCast();
  try {
    const before = (await call(c.env, "GET", "/")).body._text as string;
    // The one council sentence on GET / is the credential exception (COUNCIL_WRITES_SENTENCE), which rides the showhome door note appended AFTER the template; nothing else mentions the council.
    assert.ok(flat(before).includes(flat(COUNCIL_WRITES_SENTENCE)), "the door note's credential exception names the council's writes");
    assert.equal(/council/i.test(flat(before).replace(flat(COUNCIL_WRITES_SENTENCE), "")), false, "and nothing else on GET / mentions the council");
    const doc = (await import("node:fs")).readFileSync(new URL("../src/doc.ts", import.meta.url), "utf8");
    const tpl = doc.slice(doc.indexOf("export const FRONT_DOOR_TEMPLATE = `"));
    const templateText = tpl.slice(0, tpl.indexOf("`;"));
    assert.equal(/council/i.test(templateText), false, "FRONT_DOOR_TEMPLATE does not mention the council");
  } finally {
    c.d1.close();
  }
});

test("gate L8: a council read that fails does not take /api/official down: the endpoint answers 200, the composition is whole, and the council block says it could not be read (mutant: the read is not contained)", async () => {
  const c = await councilCast();
  try {
    c.d1.raw.exec("DROP TABLE council_claims");
    const r = await call(c.env, "GET", "/api/official");
    assert.equal(r.status, 200);
    assert.equal(typeof r.body.composition.citizens, "number", "the composition is still served");
    assert.match(r.body.council.unavailable, /could not be read/);
    assert.equal("members" in r.body.council, false, "no count is invented when the read failed");
  } finally {
    c.d1.close();
  }
});
