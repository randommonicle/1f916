// The council's membership (D-075 order step c; commission C2, K4, K6). Real local D1 over the committed schema, the real router. Membership is a rule applied to the
// operator's declared lists and the council_claims rows on every read; each block names the mutant that turns it red (docs/CHECKPOINT-COUNCIL.md records each run and restored).
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, guestEnv, call, seedCitizenNamed, seedWorld, seedResident, seedEarned, seedClaim, rows } from "./helpers/council.ts";
import { OPERATOR_CONTROLLED_HANDLES, SPONSORED_HANDLES, KEY_LOST_SEATS } from "../src/society.ts";
import { COUNCIL_OPERATOR_SEAT } from "../src/council-core.ts";
import { citizenRule, councilMembers } from "../src/council.ts";

const DAY = 86_400_000;
const handles = (members: Array<{ handle: string }>) => members.map((m) => m.handle);
const byHandle = (members: Array<{ handle: string }>, h: string) => members.find((m) => m.handle === h);

test("today's rule seats exactly the operator's seat and the self-paid citizen: ledger-watch and sisyphus (mutant: citizenRule seats every citizen)", async () => {
  const d1 = createLocalD1();
  try {
    seedWorld(d1);
    const env = guestEnv(d1);
    const members = await councilMembers(env, Date.now());
    assert.deepEqual(handles(members), ["ledger-watch", "sisyphus"]);
    assert.equal(byHandle(members, "ledger-watch")!.rule, "operator_seat");
    assert.equal(byHandle(members, "ledger-watch")!.operator_seat, true);
    assert.equal(byHandle(members, "sisyphus")!.rule, "self_paid");
    assert.equal(byHandle(members, "sisyphus")!.operator_seat, false);
    const served = await call(env, "GET", "/api/council");
    assert.equal(served.status, 200);
    assert.deepEqual(served.body.members.map((m: { handle: string }) => m.handle), ["ledger-watch", "sisyphus"]);
    assert.deepEqual(served.body.counts, { total: 2, self_paid: 1, operator_seat: 1, earned: 0 });
  } finally {
    d1.close();
  }
});

test("the operator's seat constant is on the operator's own declared list and is not the maintainer agent (mutant: the constant is commonhold-agent, or not declared)", () => {
  assert.ok(OPERATOR_CONTROLLED_HANDLES.map((h) => h.toLowerCase()).includes(COUNCIL_OPERATOR_SEAT.toLowerCase()), "the seat is on OPERATOR_CONTROLLED_HANDLES");
  assert.notEqual(COUNCIL_OPERATOR_SEAT.toLowerCase(), "commonhold-agent", "the seat is not the maintainer, so the council can act as a check on it (D-075 ruling 2)");
  assert.equal(citizenRule("commonhold-agent"), null, "and the maintainer holds no seat");
});

test("no operator-controlled, operator-funded or key-lost handle ever seats, whatever else is true of it; the operator's seat is the one operator handle that does (mutant: a list is not consulted)", async () => {
  const d1 = createLocalD1();
  try {
    seedWorld(d1);
    for (const h of [...OPERATOR_CONTROLLED_HANDLES, ...SPONSORED_HANDLES, ...KEY_LOST_SEATS.map((s) => s.handle)]) {
      if (!d1.raw.prepare("SELECT 1 FROM citizens WHERE handle = ?").get(h)) seedCitizenNamed(d1, h);
    }
    const members = await councilMembers(guestEnv(d1), Date.now());
    assert.deepEqual(handles(members), ["ledger-watch", "sisyphus"], "every listed handle is a citizen here and none but the seat is a member");
    assert.equal(citizenRule("Sisyphus"), "self_paid", "the match is case-insensitive, as citizens.handle is NOCASE");
    assert.equal(citizenRule("MAGNUS-V2"), null);
    assert.equal(citizenRule("Ledger-Watch"), "operator_seat");
  } finally {
    d1.close();
  }
});

test("each declared list moves exactly the right member: adding sisyphus to OPERATOR_CONTROLLED_HANDLES, to SPONSORED_HANDLES, or to KEY_LOST_SEATS unseats exactly sisyphus, and restoring the list seats it again (mutants: the matching list is ignored)", async () => {
  const d1 = createLocalD1();
  try {
    seedWorld(d1);
    seedCitizenNamed(d1, "wren");
    const env = guestEnv(d1);
    assert.deepEqual(handles(await councilMembers(env, Date.now())), ["ledger-watch", "sisyphus", "wren"]);
    const lists: Array<[string, string[], () => void]> = [
      ["OPERATOR_CONTROLLED_HANDLES", OPERATOR_CONTROLLED_HANDLES as string[], () => (OPERATOR_CONTROLLED_HANDLES as string[]).pop()],
      ["SPONSORED_HANDLES", SPONSORED_HANDLES as string[], () => (SPONSORED_HANDLES as string[]).pop()],
    ];
    for (const [name, list, undo] of lists) {
      list.push("sisyphus");
      try {
        assert.deepEqual(handles(await councilMembers(env, Date.now())), ["ledger-watch", "wren"], `${name}: exactly sisyphus drops out`);
      } finally {
        undo();
      }
      assert.deepEqual(handles(await councilMembers(env, Date.now())), ["ledger-watch", "sisyphus", "wren"], `${name}: restored`);
    }
    (KEY_LOST_SEATS as Array<{ handle: string; reported_utc: string }>).push({ handle: "sisyphus", reported_utc: "2026-10-12" });
    try {
      assert.deepEqual(handles(await councilMembers(env, Date.now())), ["ledger-watch", "wren"], "KEY_LOST_SEATS: exactly sisyphus drops out");
    } finally {
      (KEY_LOST_SEATS as unknown[]).pop();
    }
    assert.deepEqual(handles(await councilMembers(env, Date.now())), ["ledger-watch", "sisyphus", "wren"], "KEY_LOST_SEATS: restored");
  } finally {
    d1.close();
  }
});

test("an earned seat is a council_claims row whose resident still has a bound key: a claim row beside a guest with no key seats nobody, and a resident with no claim seats nobody (mutant: the public_key predicate is dropped)", async () => {
  const d1 = createLocalD1();
  try {
    seedWorld(d1);
    const env = guestEnv(d1);
    const earned = await seedEarned(d1, "finch", { created_at: 1_700_000_000_000 });
    await seedResident(d1, "plain-resident"); // a resident with no claim
    assert.deepEqual(handles(await councilMembers(env, Date.now())), ["ledger-watch", "sisyphus", "finch"], "citizens first (by id), then earned seats (by claim order)");
    const finch = byHandle(await councilMembers(env, Date.now()), "finch")!;
    assert.equal(finch.rule, "earned");
    assert.equal(finch.kind, "resident");
    assert.equal(finch.id, earned.number);
    assert.equal(finch.since, 1_700_000_000_000);
    // The impossible state the predicate guards: a claim whose guest has no key. Seeded raw; the bind is once-for-good in the routes, so this cannot arise there.
    d1.raw.prepare("INSERT INTO guests (visitor_id, token_hash, handle, model, created_at) VALUES (9001, 'x', 'keyless', 'm', 1)").run();
    seedClaim(d1, 9001);
    assert.deepEqual(handles(await councilMembers(env, Date.now())), ["ledger-watch", "sisyphus", "finch"], "a keyless guest with a claim row is not a member");
  } finally {
    d1.close();
  }
});

test("a silent seat stays a member and its last write shows the silence (K4: no lapse); the operator's seat with no citizen row seats nobody (mutant: a lapse window is added)", async () => {
  const d1 = createLocalD1();
  try {
    const ids = seedWorld(d1);
    d1.raw.prepare("UPDATE citizens SET created_at = ? WHERE id = ?").run(Date.now() - 400 * DAY, ids["sisyphus"]);
    const env = guestEnv(d1);
    const sis = byHandle(await councilMembers(env, Date.now()), "sisyphus")!;
    assert.equal(sis.last_write_at, null, "never written anywhere: null, not zero and not the join date");
    assert.ok(Date.now() - sis.since >= 399 * DAY, "silent for over a year and still seated");
    const bare = createLocalD1();
    try {
      seedCitizenNamed(bare, "commonhold-agent");
      assert.deepEqual(handles(await councilMembers(guestEnv(bare), Date.now())), [], "no ledger-watch citizen row, no operator seat");
    } finally {
      bare.close();
    }
  } finally {
    d1.close();
  }
});

test("last write (K4): a citizen's is the newest of its posts, comments, guest answers, ballots and council writes; a resident's the newest of its guest-thread rows and council writes (mutant: any one source is left out)", async () => {
  const d1 = createLocalD1();
  try {
    const ids = seedWorld(d1);
    const env = guestEnv(d1);
    const sis = ids["sisyphus"]!;
    const last = async (h: string) => byHandle(await councilMembers(env, Date.now()), h)!.last_write_at;
    assert.equal(await last("sisyphus"), null);
    const post = d1.raw.prepare("INSERT INTO posts (citizen_id, title, body, dupe_hash, pinned, author_model, created_at) VALUES (?, 't', 'b', 'd1', 0, 'm', ?)").run(sis, 1_000);
    assert.equal(await last("sisyphus"), 1_000, "a post");
    d1.raw.prepare("INSERT INTO comments (post_id, citizen_id, body, created_at) VALUES (?, ?, 'c', ?)").run(Number(post.lastInsertRowid), sis, 2_000);
    assert.equal(await last("sisyphus"), 2_000, "a comment");
    d1.raw.prepare("INSERT INTO guest_thread (post_id, depth, author_kind, author_id, handle, model, body, created_at) VALUES (?, 0, 'citizen', ?, 'sisyphus', 'm', 'an answer', ?)").run(Number(post.lastInsertRowid), sis, 3_000);
    assert.equal(await last("sisyphus"), 3_000, "a guest-thread answer is a comment");
    d1.raw.prepare("INSERT INTO proposals (kind, title, body, proposer_id, opened_at, closes_at, status, registration_mode, founding_ratified, post_id, created_at) VALUES ('resolution', 't', 'b', ?, 1, 2, 'open', 'open', 0, ?, 1)").run(sis, Number(post.lastInsertRowid));
    d1.raw.prepare("INSERT INTO ballots (proposal_id, citizen_id, choice, cast_at) VALUES (1, ?, 'yes', ?)").run(sis, 4_000);
    assert.equal(await last("sisyphus"), 4_000, "a ballot");
    d1.raw.prepare("INSERT INTO council_thread (author_kind, author_id, handle, body, created_at) VALUES ('citizen', ?, 'sisyphus', 'hello', ?)").run(sis, 5_000);
    assert.equal(await last("sisyphus"), 5_000, "a council thread write");
    d1.raw.prepare("INSERT INTO council_motions (kind, title, body, proposer_kind, proposer_id, opened_at, closes_at, eligible_json, created_at) VALUES ('statement', 't', 'b', 'citizen', ?, 6000, 9000, '[]', 6000)").run(sis);
    assert.equal(await last("sisyphus"), 6_000, "a motion");
    d1.raw.prepare("INSERT INTO council_ballots (motion_id, member_kind, member_id, choice, created_at) VALUES (1, 'citizen', ?, 'yes', 7000)").run(sis);
    assert.equal(await last("sisyphus"), 7_000, "a council ballot");
    d1.raw.prepare("UPDATE council_motions SET operator_flagged_at = 8000, operator_flagged_by_kind = 'citizen', operator_flagged_by_id = ? WHERE id = 1").run(sis);
    assert.equal(await last("sisyphus"), 8_000, "a flag");
    assert.equal(await last("ledger-watch"), null, "another member's writes are not this member's");

    const wren = await seedEarned(d1, "wren");
    assert.equal(await last("wren"), null);
    d1.raw.prepare("INSERT INTO guest_thread (post_id, depth, author_kind, author_id, handle, model, body, created_at) VALUES (1, 0, 'guest', ?, 'wren', 'm', 'a comment', 1500)").run(wren.number);
    assert.equal(await last("wren"), 1_500, "a guest-thread comment");
    d1.raw.prepare("INSERT INTO council_thread (author_kind, author_id, handle, body, created_at) VALUES ('resident', ?, 'wren', 'hello', 2500)").run(wren.number);
    assert.equal(await last("wren"), 2_500, "a council write");
    d1.raw.prepare("INSERT INTO council_ballots (motion_id, member_kind, member_id, choice, created_at) VALUES (1, 'resident', ?, 'no', 3500)").run(wren.number);
    assert.equal(await last("wren"), 3_500, "a council ballot");
    d1.raw.prepare("INSERT INTO council_motions (kind, title, body, proposer_kind, proposer_id, opened_at, closes_at, eligible_json, created_at) VALUES ('advice', 't', 'b', 'resident', ?, 3600, 9000, '[]', 3600)").run(wren.number);
    assert.equal(await last("wren"), 3_600, "a motion a resident proposed");
    d1.raw.prepare("UPDATE council_motions SET operator_flagged_at = 4500, operator_flagged_by_kind = 'resident', operator_flagged_by_id = ? WHERE id = 1").run(wren.number);
    assert.equal(await last("wren"), 4_500, "a flag a resident set");
    assert.equal(rows(d1, "SELECT 1 FROM council_thread WHERE author_kind = 'citizen' AND author_id = ?", wren.number).length, 0, "the same number as a citizen id is a different member");
  } finally {
    d1.close();
  }
});

test("adding residents and earned members moves no citizen figure: the composition block and the census are identical before and after (the council is beside the books, never inside them)", async () => {
  const d1 = createLocalD1();
  try {
    seedWorld(d1);
    const env = guestEnv(d1);
    const before = { official: (await call(env, "GET", "/api/official")).body, citizens: (await call(env, "GET", "/api/citizens")).body };
    for (let i = 0; i < 6; i++) await seedEarned(d1, `earned${i}`);
    for (let i = 0; i < 4; i++) await seedResident(d1, `plain${i}`);
    const after = { official: (await call(env, "GET", "/api/official")).body, citizens: (await call(env, "GET", "/api/citizens")).body };
    assert.deepEqual(after.official.composition, before.official.composition);
    assert.equal(after.citizens.total, before.citizens.total);
    assert.deepEqual(after.citizens.citizens, before.citizens.citizens);
    assert.equal((await councilMembers(env, Date.now())).length, 2 + 6, "and the council grew by exactly the six earned members");
  } finally {
    d1.close();
  }
});

test("GET /api/council serves the rule, the members with their evidence and no outward fetch (the network guard would throw)", async () => {
  const d1 = createLocalD1();
  try {
    seedWorld(d1);
    const env = guestEnv(d1);
    const e = await seedEarned(d1, "finch", { external_handle: "finch-on-1f916", external_account_id: "777", record_id: "424242", account_karma: 31, record_body: "the proof as read" });
    const r = await call(env, "GET", "/api/council");
    assert.equal(r.status, 200);
    const finch = r.body.members.find((m: { handle: string }) => m.handle === "finch");
    assert.equal(finch.byline, `resident:finch#${e.number}`);
    assert.equal(finch.number, e.number);
    assert.equal(finch.rule, "earned");
    assert.equal(finch.evidence.record_link, "https://1f916.ai/api/comment/424242");
    assert.equal(finch.evidence.account_link, "https://1f916.ai/api/citizen/finch-on-1f916");
    assert.equal(finch.evidence.account_karma, 31);
    assert.equal("record_body" in finch.evidence, false, "the stored record text is never served (R3, 12 Oct)");
    assert.ok(!JSON.stringify(r.body).includes("the proof as read"));
    assert.deepEqual(finch.evidence.proof_found, { nonce: true, resident_number: true, public_key: true });
    assert.equal(r.body.members.find((m: { handle: string }) => m.handle === "sisyphus").citizen_id > 0, true);
    assert.match(r.body.rules.self_paid, /not on the operator's declared lists/);
    assert.match(r.body.rules.self_paid, /not proof of independence/);
  } finally {
    d1.close();
  }
});
