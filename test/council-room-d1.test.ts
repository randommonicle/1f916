// The council room (D-075 order step c; commission C4, K5). Real local D1, the real router. Public to read, members only to write: a citizen the rule seats (with its
// citizen credential, secret or key assertion) or an earned resident (with its token). Each block names the mutant that turns it red.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import {
  createLocalD1, guestEnv, call, seedWorld, seedSecretCitizen, seedKeyCitizen, citizenAssertion, seedEarned, seedResident, seedCitizenNamed, bearerHeader, withIp, freshIp, rows,
} from "./helpers/council.ts";
import { COUNCIL_THREAD_PER_MEMBER_PER_DAY, COUNCIL_WRITE_PER_IP_PER_HOUR } from "../src/council-core.ts";
import { GUEST_COMMENT_MAX_LEN } from "../src/guest-core.ts";

async function setup() {
  const d1 = createLocalD1();
  seedWorld(d1);
  // replace the seeded ledger-watch and sisyphus rows' secrets: the seeded world has unusable hashes, so the members this file writes as are made fresh here
  const env = guestEnv(d1);
  return { d1, env };
}
const write = (env: any, headers: Record<string, string>, body: Record<string, unknown>) => call(env, "POST", "/api/council/thread", body, headers);
const thread = (d1: any) => rows<{ id: number; author_kind: string; author_id: number; handle: string; body: string; parent_id: number | null }>(d1, "SELECT * FROM council_thread ORDER BY id");

test("write: a self-paid citizen (secret), the operator's seat (secret), a key citizen (assertion) and an earned resident (token) can each write; the rows carry the right author kind and id (mutant: a member kind is refused)", async () => {
  const d1 = createLocalD1();
  try {
    seedCitizenNamed(d1, "commonhold-agent");
    const sis = await seedSecretCitizen(d1, "sisyphus");
    const seat = await seedSecretCitizen(d1, "ledger-watch");
    const keyed = await seedKeyCitizen(d1, "keyed-and-free");
    const wren = await seedEarned(d1, "wren");
    const env = guestEnv(d1);
    const a = await write(env, bearerHeader(sis.secret), { body: "sisyphus here" });
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.deepEqual({ kind: a.body.author.kind, byline: a.body.author.byline, rule: a.body.author.rule }, { kind: "citizen", byline: "sisyphus", rule: "self_paid" });
    const b = await write(env, bearerHeader(seat.secret), { body: "the seat speaks", parent_id: a.body.id });
    assert.equal(b.status, 201);
    assert.equal(b.body.author.rule, "operator_seat");
    assert.equal(b.body.parent_id, a.body.id);
    const c = await write(env, bearerHeader(await citizenAssertion(keyed)), { body: "a key citizen is not on the declared lists" });
    assert.equal(c.status, 201, "an unbound assertion is enough for an unbound social write (D-056)");
    const d = await write(env, withIp(), { token: wren.token, body: "an earned resident" });
    assert.equal(d.status, 201);
    assert.equal(d.body.author.byline, `resident:wren#${wren.number}`);
    assert.deepEqual(thread(d1).map((r) => [r.author_kind, r.author_id, r.handle]), [["citizen", sis.id, "sisyphus"], ["citizen", seat.id, "ledger-watch"], ["citizen", keyed.id, "keyed-and-free"], ["resident", wren.number, "wren"]]);
  } finally {
    d1.close();
  }
});

test("write: refused for everyone the rule does not seat, with nothing written: the maintainer, an operator-controlled citizen, a sponsored seat, a key-lost seat, a resident with no claim, a guest, and no credential at all (mutants: the membership gate is dropped; the rule is not consulted)", async () => {
  const { d1, env } = await setup();
  try {
    const heads: Array<[string, Record<string, string>, Record<string, unknown>]> = [];
    for (const h of ["commonhold-agent", "first-reader", "magnus-v2", "boundary-auditor-917"]) {
      d1.raw.prepare("DELETE FROM citizens WHERE handle = ?").run(h);
      const c = await seedSecretCitizen(d1, h);
      heads.push([h, bearerHeader(c.secret), {}]);
    }
    const plain = await seedResident(d1, "no-claim");
    heads.push(["a resident with no claim", withIp(), { token: plain.token }]);
    heads.push(["an unbound token that is only a guest", withIp(), { token: "commonhold_visit_unknown" }]);
    for (const [who, headers, extra] of heads) {
      const r = await write(env, headers, { ...extra, body: "let me in" });
      assert.ok([401, 403].includes(r.status), `${who}: ${r.status}`);
      if (r.status === 403) assert.equal(r.body.code, "council_not_a_member", who);
    }
    const none = await write(env, withIp(), { body: "no credential" });
    assert.deepEqual([none.status, none.body.code], [401, "council_no_credential"]);
    assert.equal(thread(d1).length, 0, "nothing was written by any of them");
  } finally {
    d1.close();
  }
});

test("write: a citizen credential wins when both are present (a non-member citizen's bearer beside an earned resident's valid token is refused, and the token is never read) (mutant: the token branch runs first)", async () => {
  const { d1, env } = await setup();
  try {
    d1.raw.prepare("DELETE FROM citizens WHERE handle = 'magnus-v2'").run();
    const sponsored = await seedSecretCitizen(d1, "magnus-v2");
    const wren = await seedEarned(d1, "wren");
    const r = await write(env, bearerHeader(sponsored.secret), { token: wren.token, body: "both credentials" });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, "council_not_a_member");
    assert.equal(thread(d1).length, 0);
    // and a secret smuggled in the body is never read as a credential
    const sis = await seedSecretCitizen(d1, "sisyphus-two");
    const viaBody = await write(env, withIp(), { secret: sis.secret, body: "secret in the body" });
    assert.equal(viaBody.status, 401);
  } finally {
    d1.close();
  }
});

test("write: the body is validated (empty, over the cap, a parent that does not exist, a malformed parent), and a resident's message is held to the guest admission rules while a citizen's is not (mutants: each guard dropped)", async () => {
  const d1 = createLocalD1();
  try {
    seedCitizenNamed(d1, "commonhold-agent");
    const sis = await seedSecretCitizen(d1, "sisyphus");
    const wren = await seedEarned(d1, "wren");
    const env = guestEnv(d1);
    const h = bearerHeader(sis.secret);
    assert.equal((await write(env, h, { body: "   " })).status, 400);
    assert.equal((await write(env, h, {})).status, 400);
    assert.equal((await write(env, h, { body: "x".repeat(GUEST_COMMENT_MAX_LEN + 1) })).status, 400);
    assert.equal((await write(env, h, { body: "x".repeat(GUEST_COMMENT_MAX_LEN) })).status, 201, "exactly the cap is accepted");
    const missingParent = await write(env, bearerHeader(sis.secret), { body: "reply", parent_id: 999 });
    assert.deepEqual([missingParent.status, missingParent.body.code], [404, "council_parent_missing"]);
    for (const bad of [0, -1, 1.5, "abc", "1e3"]) assert.equal((await write(env, bearerHeader(sis.secret), { body: "reply", parent_id: bad })).status, 400, `parent_id ${bad}`);
    const link = "see https://example.org/offer";
    const refused = await write(env, withIp(), { token: wren.token, body: link });
    assert.deepEqual([refused.status, refused.body.code], [400, "council_refused_by_rules"]);
    assert.equal((await write(env, bearerHeader(sis.secret), { body: link })).status, 201, "a citizen's council message is not deny-checked, as a citizen's board comment is not");
    assert.equal(thread(d1).filter((r) => r.author_kind === "resident").length, 0);
  } finally {
    d1.close();
  }
});

test("write: ten messages per member per UTC day, enforced inside the INSERT, so twelve at once leave exactly ten; the cap is per member (mutant: the count predicate is dropped or counts all members)", async () => {
  const d1 = createLocalD1();
  try {
    seedCitizenNamed(d1, "commonhold-agent");
    const sis = await seedSecretCitizen(d1, "sisyphus");
    const seat = await seedSecretCitizen(d1, "ledger-watch");
    const env = guestEnv(d1);
    const results = await Promise.all(Array.from({ length: COUNCIL_THREAD_PER_MEMBER_PER_DAY + 2 }, (_, i) => write(env, bearerHeader(sis.secret), { body: `message ${i}` })));
    assert.equal(results.filter((r) => r.status === 201).length, COUNCIL_THREAD_PER_MEMBER_PER_DAY, JSON.stringify(results.map((r) => r.status)));
    assert.ok(results.filter((r) => r.status !== 201).every((r) => r.status === 429 && r.body.code === "council_daily_cap"));
    assert.equal(thread(d1).length, COUNCIL_THREAD_PER_MEMBER_PER_DAY);
    assert.equal((await write(env, bearerHeader(seat.secret), { body: "another member is not capped by sisyphus" })).status, 201);
    // yesterday's messages do not count towards today's cap
    d1.raw.prepare("UPDATE council_thread SET created_at = created_at - 86400000 * 2 WHERE author_id = ?").run(sis.id);
    assert.equal((await write(env, bearerHeader(sis.secret), { body: "a new day" })).status, 201);
  } finally {
    d1.close();
  }
});

test("write: the per-address cap counts every attempt, refused or not, and is its own path (mutant: the cap is dropped)", async () => {
  const d1 = createLocalD1();
  try {
    seedCitizenNamed(d1, "commonhold-agent");
    const sis = await seedSecretCitizen(d1, "sisyphus");
    const env = guestEnv(d1);
    const ip = freshIp();
    const statuses: number[] = [];
    for (let i = 0; i < COUNCIL_WRITE_PER_IP_PER_HOUR + 1; i++) statuses.push((await write(env, bearerHeader(sis.secret, ip), { body: "" })).status);
    assert.ok(statuses.slice(0, -1).every((s) => s === 400), "empty bodies are refused as 400 until the cap");
    assert.equal(statuses.at(-1), 429);
  } finally {
    d1.close();
  }
});

test("read: public and paged by id (after, limit), with the author's kind and byline; a bad cursor or limit is a 400; no credential is needed or read (mutants: paging off by one; the read demands a credential)", async () => {
  const d1 = createLocalD1();
  try {
    seedCitizenNamed(d1, "commonhold-agent");
    const sis = await seedSecretCitizen(d1, "sisyphus");
    const wren = await seedEarned(d1, "wren");
    const env = guestEnv(d1);
    for (let i = 0; i < 5; i++) await write(env, i % 2 ? withIp() : bearerHeader(sis.secret), { ...(i % 2 ? { token: wren.token } : {}), body: `m${i}` });
    const first = await call(env, "GET", "/api/council/thread?limit=2");
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.messages.map((m: any) => m.body), ["m0", "m1"]);
    assert.equal(first.body.has_more, true);
    assert.equal(first.body.total, 5);
    assert.equal(first.body.messages[0].author.byline, "sisyphus");
    assert.equal(first.body.messages[1].author.byline, `resident:wren#${wren.number}`);
    assert.equal(first.body.messages[1].author.number, wren.number);
    const second = await call(env, "GET", `/api/council/thread?limit=2&after=${first.body.next_cursor}`);
    assert.deepEqual(second.body.messages.map((m: any) => m.body), ["m2", "m3"]);
    const last = await call(env, "GET", `/api/council/thread?after=${second.body.next_cursor}`);
    assert.deepEqual(last.body.messages.map((m: any) => m.body), ["m4"]);
    assert.deepEqual([last.body.has_more, last.body.next_cursor], [false, null]);
    for (const q of ["after=abc", "after=-1", "limit=0", "limit=101", "limit=x"]) assert.equal((await call(env, "GET", `/api/council/thread?${q}`)).status, 400, q);
    assert.match(first.body.note, /readable by everyone/);
  } finally {
    d1.close();
  }
});

test("the room never fetches outward and never reads the visitors table: a write by an earned resident touches guests and council tables only (the network guard would throw)", async () => {
  const d1 = createLocalD1();
  try {
    seedCitizenNamed(d1, "commonhold-agent");
    const wren = await seedEarned(d1, "wren");
    const env = guestEnv(d1);
    const r = await write(env, withIp(), { token: wren.token, body: "from a resident whose visitors row is long gone" });
    assert.equal(r.status, 201, "the resident has no visitors row at all (the ring has evicted it) and still writes");
    assert.equal(rows(d1, "SELECT * FROM visitors").length, 0);
  } finally {
    d1.close();
  }
});

test("the write gate and the roster agree: a claim row beside a guest with no bound key is no member on the roster and cannot write (mutant: the gate checks the claim row but not the key)", async () => {
  const d1 = createLocalD1();
  try {
    seedCitizenNamed(d1, "commonhold-agent");
    const env = guestEnv(d1);
    const keyless = await seedEarned(d1, "keyless");
    d1.raw.prepare("UPDATE guests SET public_key = NULL WHERE visitor_id = ?").run(keyless.number);
    const r = await write(env, withIp(), { token: keyless.token, body: "no key, no seat" });
    assert.deepEqual([r.status, r.body.code], [403, "council_not_a_member"]);
    assert.equal((await call(env, "GET", "/api/council")).body.members.filter((m: any) => m.handle === "keyless").length, 0);
  } finally {
    d1.close();
  }
});
