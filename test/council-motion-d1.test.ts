// Council motions through the real router (D-075 order step c; commission C5, K1, K3, CA2, CA10). Real local D1, the real routes; the verdict itself is proved over every
// combination in test/council-verdict.test.ts, and here end to end. Each block names the mutant that turns it red.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import {
  councilCast, openMotion, castBallot, flagMotion, motionRow, setWindow, closeMotionNow, servedMotion, withClock, call, rows, seedEarned, seedSecretCitizen, seedResident, bearerHeader, withIp,
  freshIp,
} from "./helpers/council.ts";
import { COUNCIL_MOTION_DAYS, COUNCIL_MOTION_TITLE_MAX } from "../src/council-core.ts";
import { GUEST_COMMENT_MAX_LEN } from "../src/guest-core.ts";

const DAY = 86_400_000;

test("open: a statement by a self-paid citizen, a key citizen and an earned resident; the window is seven days, the whole membership is frozen at open, and the reply is the served motion (mutant: the snapshot is not stored, or the window is wrong)", async () => {
  const c = await councilCast();
  try {
    const t0 = Date.now();
    const a = await openMotion(c.env, c.sis, "statement", "On the standing topics", "We think ...");
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.equal(a.body.kind, "statement");
    assert.equal(a.body.status, "open");
    assert.equal(a.body.proposer.handle, "sisyphus");
    const row = motionRow(c.d1, a.body.id);
    assert.equal(row.closes_at - row.opened_at, COUNCIL_MOTION_DAYS * DAY);
    assert.ok(row.opened_at >= t0 && row.opened_at <= Date.now());
    const frozen = JSON.parse(row.eligible_json) as Array<Record<string, unknown>>;
    assert.deepEqual(frozen.map((m) => [m.kind, m.handle, m.rule, m.operator_seat]), [
      ["citizen", "ledger-watch", "operator_seat", true],
      ["citizen", "sisyphus", "self_paid", false],
      ["citizen", "keyed-free", "self_paid", false],
      ["resident", "wren", "earned", false],
    ]);
    assert.equal(a.body.eligible.length, 4);
    assert.match(a.body.note, /changes no rule, membership, constitution, treasury or citizen right/);
    const b = await openMotion(c.env, c.key, "advice", "On the daily loop");
    assert.equal(b.status, 201, "a key citizen's unbound assertion opens a motion");
    const r = await openMotion(c.env, c.wren, "statement", "From a resident");
    assert.equal(r.status, 201);
    assert.equal(r.body.proposer.byline, `resident:wren#${c.wren.number}`);
    assert.equal(rows(c.d1, "SELECT * FROM council_motions").length, 3);
  } finally {
    c.d1.close();
  }
});

test("open: refused for a non-member, an unknown kind, a missing or oversize title or body, and a resident's linked text; the operator's seat may propose statements only (CA10); nothing is written (mutants: each guard dropped)", async () => {
  const c = await councilCast();
  try {
    const stranger = await seedSecretCitizen(c.d1, "magnus-v2");
    assert.equal((await openMotion(c.env, stranger, "statement")).body.code, "council_not_a_member");
    for (const kind of ["ruling", "", undefined, "Statement", 5]) {
      const r = await call(c.env, "POST", "/api/council/motion", { kind, title: "t", body: "b" }, bearerHeader(c.sis.secret));
      assert.deepEqual([r.status, r.body.code], [400, "council_motion_kind"], `kind ${String(kind)}`);
    }
    const post = (over: Record<string, unknown>) => call(c.env, "POST", "/api/council/motion", { kind: "statement", title: "t", body: "b", ...over }, bearerHeader(c.sis.secret));
    assert.equal((await post({ title: "   " })).status, 400);
    assert.equal((await post({ title: "x".repeat(COUNCIL_MOTION_TITLE_MAX + 1) })).status, 400);
    assert.equal((await post({ title: "x".repeat(COUNCIL_MOTION_TITLE_MAX) })).status, 201, "exactly the title cap");
    assert.equal((await call(c.env, "POST", "/api/council/motion", { kind: "statement", title: "t2", body: "" }, bearerHeader("commonhold_sk_unknown"))).status, 401);
    const advice = await openMotion(c.env, c.seat, "advice", "Advice from the operator's seat");
    assert.deepEqual([advice.status, advice.body.code], [403, "council_operator_statement_only"]);
    const statement = await openMotion(c.env, c.seat, "statement", "A statement from the seat");
    assert.equal(statement.status, 201);
    assert.equal(statement.body.operator_seat.out_of_the_count, true, "the seat's own motion has the seat out of the count");
    assert.deepEqual(statement.body.operator_seat.reasons, ["proposed_by_operator_seat"]);
    const link = await openMotion(c.env, c.wren, "statement", "Look", "see https://example.org");
    assert.deepEqual([link.status, link.body.code], [400, "council_refused_by_rules"]);
    const tooLong = await call(c.env, "POST", "/api/council/motion", { kind: "statement", title: "t", body: "x".repeat(GUEST_COMMENT_MAX_LEN + 1), token: c.wren.token }, withIp());
    assert.equal(tooLong.status, 400);
    assert.equal(rows(c.d1, "SELECT * FROM council_motions").length, 2, "only the title-cap statement and the seat's statement were written");
  } finally {
    c.d1.close();
  }
});

test("open: a member holds one open motion at a time, enforced inside the INSERT (four at once leave one); a closed motion frees the member to open another (mutant: the NOT EXISTS is dropped)", async () => {
  const c = await councilCast();
  try {
    const results = await Promise.all([1, 2, 3, 4].map((i) => openMotion(c.env, c.sis, "statement", `m${i}`)));
    assert.equal(results.filter((r) => r.status === 201).length, 1, JSON.stringify(results.map((r) => r.status)));
    assert.ok(results.filter((r) => r.status !== 201).every((r) => r.status === 409 && r.body.code === "council_motion_open"));
    assert.match(results.find((r) => r.status === 409)!.body.error, /open until /);
    assert.equal(rows(c.d1, "SELECT * FROM council_motions").length, 1);
    // another member is not blocked by sisyphus's motion
    assert.equal((await openMotion(c.env, c.key, "statement", "mine")).status, 201);
    closeMotionNow(c.d1, results.find((r) => r.status === 201)!.body.id);
    assert.equal((await openMotion(c.env, c.sis, "statement", "a second, after the first closed")).status, 201);
  } finally {
    c.d1.close();
  }
});

test("the snapshot is frozen at open: a member seated afterwards is not in it, cannot ballot and cannot flag (mutant: eligibility is read live)", async () => {
  const c = await councilCast();
  try {
    const m = await openMotion(c.env, c.sis, "statement", "Before the newcomer");
    const late = await seedEarned(c.d1, "latecomer");
    const lateBallot = await castBallot(c.env, late, m.body.id, "yes");
    assert.deepEqual([lateBallot.status, lateBallot.body.code], [403, "council_not_eligible"]);
    const lateFlag = await flagMotion(c.env, late, m.body.id);
    assert.deepEqual([lateFlag.status, lateFlag.body.code], [403, "council_not_eligible"]);
    assert.equal(rows(c.d1, "SELECT * FROM council_ballots").length, 0);
    assert.equal(motionRow(c.d1, m.body.id).operator_flagged_at, null);
    // the latecomer is a member for the NEXT motion
    const next = await openMotion(c.env, late, "statement", "After");
    assert.equal(next.body.eligible.length, 5);
    assert.equal((await castBallot(c.env, late, next.body.id, "yes")).status, 201);
  } finally {
    c.d1.close();
  }
});

test("ballot: a secret citizen, a key citizen and a resident each ballot once; a second ballot is refused and the first stands; the operator's seat ballots on an ordinary statement (mutants: the PRIMARY KEY is dropped; a member kind is refused)", async () => {
  const c = await councilCast();
  try {
    const m = await openMotion(c.env, c.sis, "statement", "Three yes, one no");
    const id = m.body.id as number;
    for (const [who, choice] of [[c.sis, "yes"], [c.key, "yes"], [c.wren, "no"], [c.seat, "yes"]] as const) {
      const r = await castBallot(c.env, who, id, choice);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.choice, choice);
      assert.equal(r.body.counts, true);
      assert.match(r.body.note, /not sealed into any chain/);
    }
    const again = await castBallot(c.env, c.sis, id, "no");
    assert.deepEqual([again.status, again.body.code], [409, "council_already_balloted"]);
    assert.equal(rows<{ choice: string }>(c.d1, "SELECT choice FROM council_ballots WHERE member_kind = 'citizen' AND member_id = ?", c.sis.id)[0]!.choice, "yes", "the first ballot stands");
    assert.equal(rows(c.d1, "SELECT * FROM council_ballots").length, 4);
    // the same number as a citizen and as a resident are two members
    assert.equal(rows(c.d1, "SELECT * FROM council_ballots WHERE member_kind = 'resident'").length, 1);
  } finally {
    c.d1.close();
  }
});

test("ballot: refused for a bad choice, a bad or unknown motion, and every non-member, and none of it writes (mutants: validation dropped)", async () => {
  const c = await councilCast();
  try {
    const m = await openMotion(c.env, c.sis, "statement", "x");
    const id = m.body.id as number;
    for (const choice of ["maybe", "", undefined, "YES", 1]) assert.equal((await call(c.env, "POST", "/api/council/ballot", { motion_id: id, choice }, bearerHeader(c.sis.secret))).status, 400, `choice ${String(choice)}`);
    for (const mid of [0, -1, 1.5, "abc", undefined]) assert.equal((await call(c.env, "POST", "/api/council/ballot", { motion_id: mid, choice: "yes" }, bearerHeader(c.sis.secret))).status, 400, `motion ${String(mid)}`);
    const missing = await castBallot(c.env, c.sis, 999, "yes");
    assert.deepEqual([missing.status, missing.body.code], [404, "council_motion_missing"]);
    const stranger = await seedSecretCitizen(c.d1, "boundary-auditor-v2");
    assert.equal((await castBallot(c.env, stranger, id, "yes")).body.code, "council_not_a_member");
    const noClaim = await seedResident(c.d1, "nobody");
    assert.equal((await castBallot(c.env, noClaim, id, "yes")).body.code, "council_not_a_member");
    const nonResident = await call(c.env, "POST", "/api/council/ballot", { motion_id: id, choice: "yes", number: 424242, assertion: "ch1.x.y" }, withIp());
    assert.equal(nonResident.body.code, "council_not_a_member");
    assert.equal((await call(c.env, "POST", "/api/council/ballot", { motion_id: id, choice: "yes" }, withIp())).status, 400, "no Authorization and no number is a malformed resident ballot");
    assert.equal(rows(c.d1, "SELECT * FROM council_ballots").length, 0);
  } finally {
    c.d1.close();
  }
});

test("a ballot at or after closes_at is refused at the boundary millisecond: closes_at - 1 is accepted, closes_at is refused (CA2) (mutants: >= for >; the pre-read alone decides)", async () => {
  const c = await councilCast();
  try {
    const m = await openMotion(c.env, c.sis, "statement", "Boundary");
    const id = m.body.id as number;
    const closes = Date.now() + 60_000;
    setWindow(c.d1, id, Date.now() - 1_000, closes);
    const before = await withClock(closes - 1, () => castBallot(c.env, c.sis, id, "yes"));
    assert.equal(before.status, 201, JSON.stringify(before.body));
    const at = await withClock(closes, () => castBallot(c.env, c.key, id, "yes"));
    assert.deepEqual([at.status, at.body.code], [409, "council_motion_closed"]);
    const after = await withClock(closes + 1, () => castBallot(c.env, c.wren, id, "yes"));
    assert.deepEqual([after.status, after.body.code], [409, "council_motion_closed"]);
    assert.equal(rows(c.d1, "SELECT * FROM council_ballots").length, 1);
    assert.equal(rows(c.d1, "SELECT * FROM resident_nonces").length, 0, "a ballot refused by the pre-read, at or after the close, spends no resident nonce");
  } finally {
    c.d1.close();
  }
});

test("CA2: a ballot whose pre-read saw the motion OPEN is still refused if the clock has reached closes_at by the write: the INSERT carries its own clock and its own closes_at predicate, and the resident's assertion is then spent (mutants: the INSERT drops closes_at > ?5; the INSERT reuses the pre-read's clock)", async () => {
  const c = await councilCast();
  try {
    const m = await openMotion(c.env, c.sis, "statement", "In flight");
    const id = m.body.id as number;
    const closes = Date.now() + 60_000;
    setWindow(c.d1, id, Date.now() - 1_000, closes);
    // the clock reads closes_at - 1 until the motion has been read once, then closes_at: the read said open, the write is judged at the close
    let flipped = false;
    const real = c.env.DB;
    const env = {
      ...c.env,
      DB: {
        prepare(sql: string) {
          const wrap = (st: any): any => ({
            ...st,
            bind: (...a: unknown[]) => wrap(st.bind(...a)),
            first: async () => {
              const r = await st.first();
              if (/FROM council_motions WHERE id = \?/.test(sql)) flipped = true;
              return r;
            },
            all: st.all?.bind(st),
            run: st.run?.bind(st),
          });
          return wrap(real.prepare(sql));
        },
        batch: (s: any[]) => real.batch(s),
      },
    } as any;
    const clock = () => (flipped ? closes : closes - 1);
    const secret = await withClock(clock, () => castBallot(env, c.sis, id, "yes"));
    assert.deepEqual([secret.status, secret.body.code], [409, "council_motion_closed"], JSON.stringify(secret.body));
    flipped = false;
    const resident = await withClock(clock, () => castBallot(env, c.wren, id, "yes"));
    assert.deepEqual([resident.status, resident.body.code], [409, "council_motion_closed"]);
    assert.equal(rows(c.d1, "SELECT * FROM council_ballots").length, 0, "neither ballot was recorded");
    assert.equal(rows(c.d1, "SELECT * FROM resident_nonces").length, 1, "the resident's valid assertion was spent by the lost race, as a signed act is elsewhere");
  } finally {
    c.d1.close();
  }
});

test("status is derived on read and never written: closing a motion by moving its window changes the served status with no write, and the table has no status column (mutant: a status column or a sweep)", async () => {
  const c = await councilCast();
  try {
    const m = await openMotion(c.env, c.sis, "statement", "Derived");
    const id = m.body.id as number;
    assert.equal((await castBallot(c.env, c.sis, id, "yes")).status, 201);
    assert.equal((await castBallot(c.env, c.seat, id, "yes")).status, 201);
    assert.equal((await castBallot(c.env, c.key, id, "yes")).status, 201);
    assert.equal((await servedMotion(c.env, id)).status, "open");
    const dump = () => JSON.stringify([rows(c.d1, "SELECT * FROM council_motions"), rows(c.d1, "SELECT * FROM council_ballots")]);
    closeMotionNow(c.d1, id);
    const before = dump();
    const served = await servedMotion(c.env, id);
    assert.equal(served.status, "passed", "three yes of four members, once the window has closed");
    assert.deepEqual([served.tally.counted, served.tally.yes, served.tally.eligible_in_the_count], [3, 3, 4]);
    assert.equal(dump(), before, "reading wrote nothing");
    assert.equal((c.d1.raw.prepare("SELECT COUNT(*) AS n FROM pragma_table_info('council_motions') WHERE name LIKE '%status%' OR name LIKE '%result%' OR name LIKE '%outcome%'").get() as { n: number }).n, 0);
  } finally {
    c.d1.close();
  }
});
