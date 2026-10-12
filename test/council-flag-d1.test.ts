// The operator's seat and the flag (D-075 ruling of 12 Oct, commission CA10, CA11): the seat ballots, except on advice motions, on motions it proposed, and on any motion a
// member outside the operator's list has flagged. The flag is one atomic conditional UPDATE, one-way, public, refused at the close. Each block names the mutant that turns it red.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { councilCast, openMotion, castBallot, flagMotion, motionRow, setWindow, closeMotionNow, servedMotion, withClock, call, rows, seedEarned, seedSecretCitizen } from "./helpers/council.ts";

test("flag: a secret citizen, a key citizen and a resident can each flag an open motion they were eligible for; it records who and when, serves them on the motion, and is one-way (mutants: a member kind cannot flag; the served fields are dropped)", async () => {
  const c = await councilCast();
  try {
    for (const [who, label] of [[c.sis, "sisyphus"], [c.key, "keyed-free"], [c.wren, "wren"]] as const) {
      const m = (await openMotion(c.env, label === "keyed-free" ? c.sis : c.key, "statement", `Flag by ${label}`)).body.id as number;
      const t0 = Date.now();
      const r = await flagMotion(c.env, who, m);
      assert.equal(r.status, 201, `${label}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.operator_seat.out_of_the_count, true);
      assert.deepEqual(r.body.operator_seat.reasons, ["flagged"]);
      assert.equal(r.body.operator_seat.flagged.by.handle, label);
      assert.ok(r.body.operator_seat.flagged.at >= t0);
      const row = motionRow(c.d1, m);
      assert.equal(row.operator_flagged_by_kind, label === "wren" ? "resident" : "citizen");
      assert.equal(row.operator_flagged_by_id, label === "wren" ? c.wren.number : label === "sisyphus" ? c.sis.id : c.key.id);
      // served on every read of the motion
      const served = await servedMotion(c.env, m);
      assert.equal(served.operator_seat.flagged.by.handle, label);
      assert.match(served.operator_seat.flagged.note, /one-way and public/);
      // one-way: there is no route to unflag, and a second flag is refused and changes nothing
      const again = await flagMotion(c.env, who === c.sis ? c.key : c.sis, m);
      assert.deepEqual([again.status, again.body.code], [409, "council_already_flagged"]);
      assert.match(again.body.error, /was already flagged at /);
      assert.equal(motionRow(c.d1, m).operator_flagged_by_id, row.operator_flagged_by_id, "the first flagger stands");
      assert.equal(motionRow(c.d1, m).operator_flagged_at, row.operator_flagged_at);
      closeMotionNow(c.d1, m);
    }
  } finally {
    c.d1.close();
  }
});

test("flag: the operator's seat cannot flag (the flag is a check on it), a non-member cannot, an unknown or closed motion cannot, and none of it writes (mutants: each guard dropped)", async () => {
  const c = await councilCast();
  try {
    const m = (await openMotion(c.env, c.sis, "statement", "Refusals")).body.id as number;
    const seat = await flagMotion(c.env, c.seat, m);
    assert.deepEqual([seat.status, seat.body.code], [403, "council_operator_cannot_flag"]);
    const stranger = await seedSecretCitizen(c.d1, "magnus-v2");
    assert.deepEqual([(await flagMotion(c.env, stranger, m)).status, (await flagMotion(c.env, stranger, m)).body.code], [403, "council_not_a_member"]);
    assert.equal((await flagMotion(c.env, c.sis, 999)).body.code, "council_motion_missing");
    assert.equal((await flagMotion(c.env, c.sis, "0")).status, 400);
    assert.equal(motionRow(c.d1, m).operator_flagged_at, null);
    closeMotionNow(c.d1, m);
    const closed = await flagMotion(c.env, c.sis, m);
    assert.deepEqual([closed.status, closed.body.code], [409, "council_motion_closed"]);
    assert.equal(motionRow(c.d1, m).operator_flagged_at, null);
  } finally {
    c.d1.close();
  }
});

test("flag: two members at once, exactly one wins and the stored flagger is the winner's; flags on an advice motion and on the seat's own motion are allowed (mutants: the conditional UPDATE loses `operator_flagged_at IS NULL`)", async () => {
  const c = await councilCast();
  try {
    const m = (await openMotion(c.env, c.seat, "statement", "From the seat")).body.id as number;
    const [a, b] = await Promise.all([flagMotion(c.env, c.sis, m), flagMotion(c.env, c.key, m)]);
    const won = [a, b].filter((r) => r.status === 201);
    assert.equal(won.length, 1, JSON.stringify([a.status, b.status]));
    const lost = [a, b].find((r) => r.status !== 201)!;
    assert.deepEqual([lost.status, lost.body.code], [409, "council_already_flagged"]);
    assert.equal(motionRow(c.d1, m).operator_flagged_by_id, won[0] === a ? c.sis.id : c.key.id);
    const advice = (await openMotion(c.env, c.key, "advice", "Advice")).body.id as number;
    assert.equal((await flagMotion(c.env, c.wren, advice)).status, 201, "a flag on an advice motion is a statement of concern and is recorded");
  } finally {
    c.d1.close();
  }
});

test("flag at the close boundary: closes_at - 1 flags, closes_at does not, and a flag whose pre-read saw the motion open but whose write is judged at the close is refused by the UPDATE's own predicate (mutants: >= for >; the UPDATE drops closes_at > ?1)", async () => {
  const c = await councilCast();
  try {
    const closes = Date.now() + 60_000;
    const a = (await openMotion(c.env, c.sis, "statement", "Boundary A")).body.id as number;
    const b = (await openMotion(c.env, c.key, "statement", "Boundary B")).body.id as number;
    const w = (await openMotion(c.env, c.wren, "statement", "Boundary C")).body.id as number;
    for (const id of [a, b, w]) setWindow(c.d1, id, Date.now() - 1_000, closes);
    assert.equal((await withClock(closes - 1, () => flagMotion(c.env, c.key, a))).status, 201);
    const at = await withClock(closes, () => flagMotion(c.env, c.sis, b));
    assert.deepEqual([at.status, at.body.code], [409, "council_motion_closed"]);
    assert.equal(motionRow(c.d1, b).operator_flagged_at, null);
    // in flight: the clock flips right after the motion is read
    let flipped = false;
    const real = c.env.DB;
    const env = {
      ...c.env,
      DB: {
        prepare(sql: string) {
          const wrap = (st: any): any => ({
            ...st,
            bind: (...x: unknown[]) => wrap(st.bind(...x)),
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
    const inflight = await withClock(() => (flipped ? closes : closes - 1), () => flagMotion(env, c.key, w));
    assert.deepEqual([inflight.status, inflight.body.code], [409, "council_motion_closed"], JSON.stringify(inflight.body));
    assert.equal(motionRow(c.d1, w).operator_flagged_at, null, "nothing was flagged");
  } finally {
    c.d1.close();
  }
});

test("the seat ballots on an ordinary statement, but not on advice, not on its own motion, and not on a flagged one: each refusal names the reason and writes nothing (mutants: a reason is dropped from the ballot INSERT or from the pre-read)", async () => {
  const c = await councilCast();
  try {
    const plain = (await openMotion(c.env, c.sis, "statement", "Plain")).body.id as number;
    assert.equal((await castBallot(c.env, c.seat, plain, "yes")).status, 201);
    const advice = (await openMotion(c.env, c.key, "advice", "Advice")).body.id as number;
    const onAdvice = await castBallot(c.env, c.seat, advice, "yes");
    assert.deepEqual([onAdvice.status, onAdvice.body.code], [403, "council_operator_recused"]);
    assert.match(onAdvice.body.error, /an advice motion/);
    const own = (await openMotion(c.env, c.seat, "statement", "The seat's own")).body.id as number;
    const onOwn = await castBallot(c.env, c.seat, own, "yes");
    assert.deepEqual([onOwn.status, onOwn.body.code], [403, "council_operator_recused"]);
    assert.match(onOwn.body.error, /the operator's seat proposed it/);
    const other = (await openMotion(c.env, c.wren, "statement", "To be flagged")).body.id as number;
    assert.equal((await flagMotion(c.env, c.sis, other)).status, 201);
    const onFlagged = await castBallot(c.env, c.seat, other, "yes");
    assert.deepEqual([onFlagged.status, onFlagged.body.code], [403, "council_operator_recused"]);
    assert.match(onFlagged.body.error, /the motion was flagged/);
    assert.equal(rows(c.d1, "SELECT * FROM council_ballots WHERE member_id = ? AND member_kind = 'citizen'", c.seat.id).length, 1, "only the ordinary statement took the seat's ballot");
    // members other than the seat ballot on advice, on the seat's motion and on flagged motions
    for (const id of [advice, own, other]) assert.equal((await castBallot(c.env, c.sis, id, "yes")).status, 201, `motion ${id}`);
  } finally {
    c.d1.close();
  }
});

test("a flag landing between the seat's pre-read and its write refuses the ballot atomically: the INSERT carries the flag predicate for the seat, so the ballot is not recorded even though the read before it saw an unflagged motion (mutant: the INSERT drops operator_flagged_at IS NULL)", async () => {
  const c = await councilCast();
  try {
    const m = (await openMotion(c.env, c.key, "statement", "Flag in flight")).body.id as number;
    let done = false;
    const real = c.env.DB;
    const env = {
      ...c.env,
      DB: {
        prepare(sql: string) {
          const wrap = (st: any): any => ({
            ...st,
            bind: (...x: unknown[]) => wrap(st.bind(...x)),
            first: async () => {
              const r = await st.first();
              if (!done && /FROM council_motions WHERE id = ?/.test(sql)) {
                done = true;
                // another request flags the motion right after this request read it unflagged
                c.d1.raw.prepare("UPDATE council_motions SET operator_flagged_at = ?, operator_flagged_by_kind = 'citizen', operator_flagged_by_id = ? WHERE id = ?").run(Date.now(), c.sis.id, m);
              }
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
    const r = await castBallot(env, c.seat, m, "yes");
    assert.deepEqual([r.status, r.body.code], [403, "council_operator_recused"], JSON.stringify(r.body));
    assert.match(r.body.error, /flagged while your ballot was in flight/);
    assert.equal(rows(c.d1, "SELECT * FROM council_ballots").length, 0, "no ballot was recorded");
  } finally {
    c.d1.close();
  }
});

test("a flag after the seat balloted sets that ballot aside: it stays in the table, is served as 'set aside: the motion was flagged', and is never counted (mutants: the ballot is deleted; it is counted)", async () => {
  const c = await councilCast();
  try {
    const m = (await openMotion(c.env, c.key, "statement", "Flag after")).body.id as number;
    assert.equal((await castBallot(c.env, c.seat, m, "yes")).status, 201);
    const before = await servedMotion(c.env, m);
    assert.equal(before.tally.counted, 1);
    assert.equal(before.ballots[0].counted, true);
    assert.equal((await flagMotion(c.env, c.sis, m)).status, 201);
    const after = await servedMotion(c.env, m);
    assert.equal(after.tally.counted, 0, "the seat's ballot is no longer counted");
    assert.equal(after.tally.eligible_in_the_count, 3);
    assert.equal(after.tally.eligible_at_open, 4);
    assert.equal(after.ballots.length, 1, "kept and served");
    assert.deepEqual([after.ballots[0].counted, after.ballots[0].set_aside], [false, "set aside: the motion was flagged"]);
    assert.equal(rows(c.d1, "SELECT * FROM council_ballots").length, 1, "still in the table");
  } finally {
    c.d1.close();
  }
});

test("the verdict end to end: the same ballots pass without the flag and fail with it (seat yes, sisyphus yes, wren no, keyed-free abstain: 2 yes to 1 no, then 1 to 1 with the seat set aside), and a pass needs the window to have closed (mutant: the seat's ballot is counted after a flag)", async () => {
  const c = await councilCast();
  try {
    const run = async (proposer: typeof c.sis | typeof c.key, flag: boolean) => {
      const m = (await openMotion(c.env, proposer, "statement", flag ? "Flagged run" : "Plain run")).body.id as number;
      for (const [who, choice] of [[c.seat, "yes"], [c.sis, "yes"], [c.wren, "no"], [c.key, "abstain"]] as const) assert.equal((await castBallot(c.env, who, m, choice)).status, 201);
      if (flag) assert.equal((await flagMotion(c.env, c.wren, m)).status, 201);
      assert.equal((await servedMotion(c.env, m)).status, "open", "open until the window closes, whatever the count");
      closeMotionNow(c.d1, m);
      return servedMotion(c.env, m);
    };
    const plain = await run(c.sis, false);
    assert.equal(plain.status, "passed");
    assert.deepEqual([plain.tally.counted, plain.tally.yes, plain.tally.no], [4, 2, 1]);
    const flagged = await run(c.key, true);
    assert.equal(flagged.status, "failed");
    assert.deepEqual([flagged.tally.counted, flagged.tally.yes, flagged.tally.no], [3, 1, 1]);
    assert.match(flagged.tally.why_not.join("; "), /yes \(1\) is not more than no \(1\)/);
    assert.equal(flagged.ballots.filter((b: any) => !b.counted).length, 1);
  } finally {
    c.d1.close();
  }
});

test("a flag and the seat's ballot arriving together leave one coherent state: whichever lands first, the seat's ballot is either refused or set aside, never counted on a flagged motion (mutants: the ballot INSERT drops the flag predicate AND the read-side exclusion)", async () => {
  for (let round = 0; round < 6; round++) {
    const c = await councilCast();
    try {
      const m = (await openMotion(c.env, c.key, "statement", `Race ${round}`)).body.id as number;
      const calls = round % 2 === 0 ? [flagMotion(c.env, c.sis, m), castBallot(c.env, c.seat, m, "yes")] : [castBallot(c.env, c.seat, m, "yes"), flagMotion(c.env, c.sis, m)];
      const [x, y] = await Promise.all(calls);
      const flagReply = round % 2 === 0 ? x : y;
      const ballotReply = round % 2 === 0 ? y : x;
      assert.equal(flagReply.status, 201, "the flag always lands");
      assert.ok([201, 403].includes(ballotReply.status), `ballot ${ballotReply.status}`);
      const served = await servedMotion(c.env, m);
      assert.equal(served.operator_seat.out_of_the_count, true);
      assert.equal(served.tally.counted, 0, "the seat's ballot is never counted on a flagged motion");
      assert.equal(served.ballots.every((b: any) => b.counted === false), true);
    } finally {
      c.d1.close();
    }
  }
});

test("GET /api/council serves open and recent motions with their frozen member list, the flag fields and each set-aside ballot labelled, and a closed motion keeps its derived status; the list is capped with the total served (mutant: the cap is not applied or not disclosed)", async () => {
  const c = await councilCast();
  try {
    const open = (await openMotion(c.env, c.sis, "statement", "Still open")).body.id as number;
    // many closed motions from many members: 22 rows inserted directly, a past window each
    for (let i = 0; i < 22; i++) {
      c.d1.raw
        .prepare("INSERT INTO council_motions (kind, title, body, proposer_kind, proposer_id, opened_at, closes_at, eligible_json, created_at) VALUES ('statement', ?, 'b', 'citizen', ?, 1, 2, '[]', 1)")
        .run(`closed ${i}`, 100 + i);
    }
    const s = (await call(c.env, "GET", "/api/council")).body.motions;
    assert.equal(s.open.length, 1);
    assert.equal(s.open[0].id, open);
    assert.equal(s.recent_closed.length, 20, "at most twenty closed motions are listed");
    assert.equal(s.total, 23, "and the total says how many exist");
    assert.equal(s.recent_closed[0].title, "closed 21", "newest first");
    assert.match(s.note, /at most/);
    assert.equal(s.recent_closed[0].status, "failed", "a closed motion with no ballots failed");
    assert.deepEqual(Object.keys(s.open[0].operator_seat).sort(), ["flagged", "out_of_the_count", "reasons"]);
    void seedEarned;
  } finally {
    c.d1.close();
  }
});
