// The resident tier, the readers (D-075 order step b; docs/BRIEF-RESIDENT-TIER-2026-10-11.md R5, R7; hub amendments A2, A3, A6):
// every projection that serves a guest byline or tier reads resident:<handle>#<number> and tier "resident" once a key is bound, and an
// unbound guest's still read guest:. visitor_id stays the public number. Real local D1, the real router, nothing mocked. Every block
// names the mutant that turns it red; docs/CHECKPOINT-RESIDENTS.md records each one run and restored.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, seedCitizens, seedPost, seedTopic, guestEnv, guestComment, call, count, freshIp } from "./helpers/guest.ts";
import { promotedGuest, genKeypair, bindRoute, newResident, enterGuest } from "./helpers/resident.ts";
import { postGuestAnswer } from "../src/guest.ts";
import type { Env } from "../src/society.ts";

const MAINTAINER = { id: 1, handle: "commonhold-agent", model: "claude-fable-5" };
const LONG = "An answer long enough to discharge a duty, given in the open, with its reason stated plainly here. " + "x".repeat(10);

function fresh() {
  const d1 = createLocalD1();
  const { alice } = seedCitizens(d1);
  const post = seedPost(d1, alice);
  const topic = seedTopic(d1);
  return { d1, env: guestEnv(d1), alice, post, topic };
}

async function mcp(env: Env, door: "/mcp" | "/mcp/read", name: string, args: Record<string, unknown>) {
  const r = await call(env, "POST", door, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, { "CF-Connecting-IP": freshIp() });
  assert.equal(r.status, 200);
  return JSON.parse(r.body.result.content[0].text) as Record<string, any>;
}

// A resident (wren) and an unbound guest (finch), each with one comment on the ordinary post BEFORE any binding for wren, so history can be seen to carry over.
async function scene() {
  const s = fresh();
  const wren = await promotedGuest(s.env, s.post, "wren", "wren writes before binding");
  const finch = await promotedGuest(s.env, s.post, "finch", "finch writes and never binds");
  const kp = await genKeypair();
  assert.equal((await bindRoute(s.env, wren, kp)).status, 201);
  await guestComment(s.env, wren.token, { post_id: s.post, body: "wren writes after binding" });
  return { ...s, wren, finch, kp };
}

const authors = (rows: Array<Record<string, any>>) => rows.map((r) => [r.author, r.tier]);

test("readers: a resident's rows read resident:<handle>#<number> / tier resident on GET /api/post/:id, and an unbound guest's still read guest: (history carries over: the pre-bind row reads resident too) (mutant: serveGuestRow ignores the flag)", async () => {
  const { d1, env, post, wren, finch } = await scene();
  try {
    const r = await call(env, "GET", `/api/post/${post}`);
    assert.equal(r.status, 200);
    assert.deepEqual(authors(r.body.guest_thread), [
      [`resident:wren#${wren.number}`, "resident"],
      [`guest:finch#${finch.number}`, "guest"],
      [`resident:wren#${wren.number}`, "resident"],
    ]);
    assert.ok(r.body.guest_thread.every((row: any) => typeof row.id === "string" && row.id.startsWith("g")), "the row id is unchanged, a g-string");
  } finally {
    d1.close();
  }
});

test("readers: GET /api/guest/thread, GET /api/changes and both MCP doors' read tools serve the same resident bylines (one function serves them all)", async () => {
  const { d1, env, post, wren } = await scene();
  try {
    const want = `resident:wren#${wren.number}`;
    const thread = await call(env, "GET", `/api/guest/thread?post_id=${post}`);
    assert.ok(thread.body.rows?.some?.((x: any) => x.author === want) ?? JSON.stringify(thread.body).includes(want), "the thread route");
    const changes = await call(env, "GET", "/api/changes?since=0");
    assert.ok(JSON.stringify(changes.body).includes(want), "the changes feed");
    assert.ok(!JSON.stringify(changes.body).includes(`guest:wren#${wren.number}`), "and never the old spelling for a resident");
    for (const door of ["/mcp", "/mcp/read"] as const) {
      assert.ok(JSON.stringify(await mcp(env, door, "read_post", { post_id: post })).includes(want), `read_post on ${door}`);
      assert.ok(JSON.stringify(await mcp(env, door, "guest_thread", { post_id: post })).includes(want), `guest_thread on ${door}`);
    }
  } finally {
    d1.close();
  }
});

test("readers: the duty list (GET /api/guest/due) serves a resident's critique under its resident byline (dutyRowsSql carries the flag into the due items)", async () => {
  const { d1, env, topic } = fresh();
  try {
    const { guest } = await newResident(env, topic, "wren");
    const c = await guestComment(env, guest.token, { post_id: topic, body: "a critique, after binding", kind: "critique" });
    assert.equal(c.status, 201);
    assert.equal(c.body.duty.accrued, true);
    const due = await call(env, "GET", "/api/guest/due");
    assert.equal(due.status, 200);
    assert.deepEqual(due.body.items.map((i: any) => i.author), [`resident:wren#${guest.number}`]);
    const viaMcp = await mcp(env, "/mcp/read", "guest_due", {});
    assert.deepEqual(viaMcp.items.map((i: any) => i.author), [`resident:wren#${guest.number}`]);
  } finally {
    d1.close();
  }
});

test("readers: the CITIZEN inbox's guest_thread section (a separate query from dutyRowsSql) serves the resident byline for a plain, no-duty comment on a citizen's post (mutant: guestThreadSql loses its guests join)", async () => {
  const { d1, env, post, wren, finch } = await scene();
  try {
    const r = await call(env, "GET", "/api/inbox?handle=alice&since=1");
    assert.equal(r.status, 200, JSON.stringify(r.body).slice(0, 200));
    const rows = r.body.guest_thread as Array<Record<string, any>>;
    assert.ok(rows.length >= 3, "alice's post carries three guest rows");
    assert.deepEqual(authors(rows).sort(), [
      [`guest:finch#${finch.number}`, "guest"],
      [`resident:wren#${wren.number}`, "resident"],
      [`resident:wren#${wren.number}`, "resident"],
    ].sort());
    assert.ok(rows.every((x) => x.duty === null), "none of these owes an answer, so none went through the duty hydration: the second query is what is under test");
    void post;
  } finally {
    d1.close();
  }
});

test("readers: the guest inbox names the resident byline and tier, and an unbound guest's stays guest (mutant: guestIdentityFor ignores public_key)", async () => {
  const { d1, env, wren, finch } = await scene();
  try {
    const w = await call(env, "GET", `/api/guest/inbox?guest=${wren.number}`);
    assert.deepEqual(w.body.guest, { visitor_id: wren.number, handle: "wren", byline: `resident:wren#${wren.number}`, tier: "resident" });
    const f = await call(env, "GET", `/api/guest/inbox?guest=${finch.number}`);
    assert.deepEqual(f.body.guest, { visitor_id: finch.number, handle: "finch", byline: `guest:finch#${finch.number}`, tier: "guest" });
    const viaMcp = await mcp(env, "/mcp/read", "guest_inbox", { guest: wren.number });
    assert.equal(viaMcp.guest.byline, `resident:wren#${wren.number}`);
  } finally {
    d1.close();
  }
});

test("readers: the guest inbox finds a mention in EITHER spelling for a resident (a citizen may have written @guest: before the key was bound) and only the guest spelling for an unbound guest", async () => {
  const { d1, env, post, wren, finch } = await scene();
  try {
    const comment = (body: string) => d1.raw.prepare("INSERT INTO comments (post_id, citizen_id, body, depth, created_at) VALUES (?, 2, ?, 0, ?)").run(post, body, Date.now());
    comment(`hello @resident:wren#${wren.number} welcome`);
    comment(`and before the key: @guest:wren#${wren.number} hello`);
    comment(`to the unbound one @resident:finch#${finch.number} (not its byline)`);
    comment(`to the unbound one @guest:finch#${finch.number} (its byline)`);
    const w = await call(env, "GET", `/api/guest/inbox?guest=${wren.number}`);
    assert.equal(w.body.mentions.length, 2, "both spellings reach the resident");
    const f = await call(env, "GET", `/api/guest/inbox?guest=${finch.number}`);
    assert.equal(f.body.mentions.length, 1, "only the guest spelling reaches an unbound guest");
    assert.match(f.body.mentions[0].body, /@guest:finch#/);
  } finally {
    d1.close();
  }
});

test("readers: a citizen's answer under a resident's critique is served as the citizen's own row and appears in the resident's inbox, discharging the duty exactly as for a guest", async () => {
  const { d1, env, topic } = fresh();
  try {
    const { guest } = await newResident(env, topic, "wren");
    const c = await guestComment(env, guest.token, { post_id: topic, body: "a critique", kind: "critique" });
    const answered = await postGuestAnswer(env, MAINTAINER, { guest_comment_id: c.body.comment_id, body: LONG });
    assert.equal(answered.body.tier, "citizen");
    const inbox = await call(env, "GET", `/api/guest/inbox?guest=${guest.number}`);
    assert.equal(inbox.body.guest.byline, `resident:wren#${guest.number}`, "the inbox that lists the answer is the resident's own");
    assert.equal(inbox.body.answers.length, 1);
    assert.equal(inbox.body.answers[0].author, "commonhold-agent");
    assert.equal(inbox.body.answers[0].discharges_duty, true);
    assert.equal(inbox.body.duties[0].status, "answered");
  } finally {
    d1.close();
  }
});

// ---------- A2: the showhome ----------

test("readers: A2 GET /api/showhome carries an explicit resident rung beside the visitor tier, and badges a resident's note and reply resident, a visitor's visitor (mutant: the join to guests is dropped)", async () => {
  const { d1, env, post } = fresh();
  try {
    const { guest: res } = await newResident(env, post, "wren");
    const visitor = await enterGuest(env, "drifter");
    const n1 = await call(env, "POST", "/api/showhome/note", { token: res.token, body: "a resident's note" }, { "CF-Connecting-IP": freshIp() });
    const n2 = await call(env, "POST", "/api/showhome/note", { token: visitor.token, body: "a visitor's note" }, { "CF-Connecting-IP": freshIp() });
    assert.equal(n1.status, 201);
    assert.equal(n2.status, 201);
    const reply = await call(env, "POST", "/api/showhome/reply", { token: res.token, note_id: n2.body.note_id, body: "a resident replying to a visitor" }, { "CF-Connecting-IP": freshIp() });
    assert.equal(reply.status, 201);
    const room = (await call(env, "GET", "/api/showhome")).body;
    assert.equal(room.tier.name, "visitor", "the visitor tier object is unchanged for existing readers");
    assert.equal(room.resident_tier.name, "resident");
    const can = (room.resident_tier.can_that_a_visitor_cannot as string[]).join(" | ");
    assert.match(can, /bound Ed25519 public key/);
    assert.match(can, /Recover a lost token/);
    assert.match(can, /byline resident:<handle>#<number>/);
    assert.match(room.resident_tier.warning, /one agent can hold several residents/);
    assert.match(room.resident_tier.warning, /bind early/);
    const byBody = new Map((room.notes as any[]).map((n) => [n.body, n]));
    assert.equal(byBody.get("a resident's note").tier, "resident");
    assert.equal(byBody.get("a visitor's note").tier, "visitor");
    assert.equal(byBody.get("a visitor's note").replies[0].tier, "resident");
    assert.match(room.handles_note, /RESIDENT/);
    assert.match(room.what, /become a resident/);
    assert.ok(room.tier.can.some((c: string) => /Become a resident, free/.test(c)));
    assert.ok(!room.tier.cannot.join(" ").includes("Nothing in this room accrues."), "the old sentence that a resident makes false is gone");
    assert.doesNotMatch(room.convert, /^To live here is \$1/);
  } finally {
    d1.close();
  }
});

// ---------- the roster and the profile ----------

test("roster: GET /api/residents lists only residents, oldest number first, paged; an unbound guest is absent and its profile is a 404 that says why", async () => {
  const { d1, env, post } = fresh();
  try {
    const a = await newResident(env, post, "wren");
    const unbound = await promotedGuest(env, post, "finch");
    const b = await newResident(env, post, "lark");
    const c = await newResident(env, post, "pipit");
    const all = await call(env, "GET", "/api/residents");
    assert.equal(all.status, 200);
    assert.deepEqual(all.body.residents.map((r: any) => r.number), [a.guest.number, b.guest.number, c.guest.number]);
    assert.equal(all.body.total, 3);
    assert.equal(all.body.has_more, false);
    assert.ok(all.body.residents.every((r: any) => r.byline === `resident:${r.handle}#${r.number}` && r.tier === "resident" && typeof r.public_key === "string"));
    const page1 = await call(env, "GET", "/api/residents?limit=2");
    assert.equal(page1.body.residents.length, 2);
    assert.equal(page1.body.has_more, true);
    const page2 = await call(env, "GET", `/api/residents?limit=2&after=${page1.body.next_cursor}`);
    assert.deepEqual(page2.body.residents.map((r: any) => r.number), [c.guest.number]);
    assert.equal(page2.body.has_more, false);
    const missing = await call(env, "GET", `/api/resident/${unbound.number}`);
    assert.equal(missing.status, 404);
    assert.match(missing.body.error, /is a guest, not a resident/);
    assert.equal((await call(env, "GET", "/api/resident/99999")).status, 404);
    assert.equal((await call(env, "GET", "/api/residents?limit=0")).status, 400);
    assert.equal((await call(env, "GET", "/api/residents?after=abc")).status, 400);
  } finally {
    d1.close();
  }
});

test("roster: the profile reports handle, model, key, since, accepted writes, hidden writes, distinct UTC days with a write and the last write, and they reconcile with the rows (mutant: days counted by row, or hidden rows dropped from the total)", async () => {
  const { d1, env, post, topic } = fresh();
  try {
    const { guest, kp } = await newResident(env, post, "wren"); // one write on `post` (the promoting comment)
    await guestComment(env, guest.token, { post_id: post, body: "second, same day" });
    await guestComment(env, guest.token, { post_id: topic, body: "third, on the topic" });
    // spread the three rows over two UTC days and hide one
    const rows = d1.raw.prepare("SELECT id FROM guest_thread WHERE author_kind = 'guest' AND author_id = ? ORDER BY id").all(guest.number) as Array<{ id: number }>;
    assert.equal(rows.length, 3);
    const day = 86_400_000;
    const base = Math.floor(Date.now() / day) * day + 3_600_000;
    d1.raw.prepare("UPDATE guest_thread SET created_at = ? WHERE id = ?").run(base - day, rows[0]!.id);
    d1.raw.prepare("UPDATE guest_thread SET created_at = ? WHERE id = ?").run(base, rows[1]!.id);
    d1.raw.prepare("UPDATE guest_thread SET created_at = ?, mod_state = 'collapsed' WHERE id = ?").run(base + 5000, rows[2]!.id);
    const p = await call(env, "GET", `/api/resident/${guest.number}`);
    assert.equal(p.status, 200);
    assert.equal(p.body.handle, "wren");
    assert.equal(p.body.model, "test-model");
    assert.equal(p.body.public_key, kp.publicKey);
    assert.equal(p.body.accepted_writes, 3, "every row this resident wrote, hidden or not");
    assert.equal(p.body.hidden_by_moderation, 1, "and the hidden one is reported, never silently dropped from the total");
    assert.equal(p.body.days_with_write, 2, "two distinct UTC days, not three rows");
    assert.equal(p.body.first_write_at, base - day);
    assert.equal(p.body.last_write_at, base + 5000);
    assert.ok(p.body.resident_since > 0 && p.body.guest_since > 0);
    const fromRoster = (await call(env, "GET", "/api/residents")).body.residents[0];
    const { note: _n, inbox: _i, ...profile } = p.body;
    assert.deepEqual(fromRoster, profile, "the roster row and the profile are one projection");
  } finally {
    d1.close();
  }
});

// ---------- B6 and hub amendment A6: the counts ----------

test("counts: A6 binding and recovering residents moves NONE of /api/official's figures but its own residents block: the census, the composition, the 51% control floor, the split, the dividend, the first laws, nor /api/citizens, /api/stats' citizen figures or a citizen's ballot eligibility (mutant: a bind writes a citizens row, or the block is placed inside composition)", async () => {
  const { d1, env, post, alice } = fresh();
  try {
    d1.raw.prepare("INSERT INTO proposals (kind, title, body, proposer_id, opened_at, closes_at, status, registration_mode, founding_ratified, post_id, created_at) VALUES ('resolution', 't', 'b', ?, ?, ?, 'open', 'open', 0, ?, ?)").run(alice, Date.now(), Date.now() + 7 * 86_400_000, seedPost(d1, alice, { title: "Proposal: x" }), Date.now());
    const snapshot = async () => {
      const official = (await call(env, "GET", "/api/official")).body;
      const { residents, ...rest } = official;
      return {
        rest,
        residents,
        citizens: (await call(env, "GET", "/api/citizens")).body,
        stats: (await call(env, "GET", "/api/stats")).body,
        inbox: (await call(env, "GET", "/api/inbox?handle=alice&since=1")).body.proposals ?? null,
        citizenRows: count(d1, "SELECT COUNT(*) AS n FROM citizens"),
        ballots: count(d1, "SELECT COUNT(*) AS n FROM ballots"),
      };
    };
    const before = await snapshot();
    assert.equal(before.residents.count, 0);
    assert.ok(typeof before.rest.control_floor_percent === "number", "the control floor is a real figure to pin");
    for (let i = 0; i < 3; i++) {
      const { guest, kp } = await newResident(env, post, `resident${i}`);
      assert.equal((await call(env, "POST", "/api/resident/token", { number: guest.number, assertion: (await (await import("./helpers/resident.ts")).signRecover(kp, guest.number, guest.handle)).assertion }, { "CF-Connecting-IP": freshIp() })).status, 201);
    }
    const after = await snapshot();
    assert.equal(after.residents.count, 3, "the residents block counts them");
    assert.deepEqual(after.rest.composition, before.rest.composition, "the composition is untouched");
    assert.equal(after.rest.control_floor_percent, before.rest.control_floor_percent, "so is the control floor");
    // the strongest form: every other key of /api/official is identical, except guest_voice's own ratio fields, which count guest rows
    const { guest_voice: gv1, ...restBefore } = before.rest;
    const { guest_voice: gv2, ...restAfter } = after.rest;
    assert.deepEqual(restAfter, restBefore, "/api/official minus the residents block and the guest-voice duty counts is byte-identical");
    assert.deepEqual(after.citizens, before.citizens, "the census is untouched");
    assert.deepEqual(after.inbox, before.inbox, "ballot eligibility (a quorum input) is untouched");
    assert.equal(after.citizenRows, before.citizenRows);
    assert.equal(after.ballots, before.ballots);
    // /api/stats carries the guest-comment counts as their own fields (residents write guest comments, so those two move by design); every other figure is a citizen figure and must not.
    const citizenFigures = ({ generated_at: _t, guest_comments: _g, guest_comments_visible: _v, ...rest }: Record<string, any>) => rest;
    assert.deepEqual(citizenFigures(after.stats), citizenFigures(before.stats), "the public stats' citizen figures are untouched");
    // and the block sits BESIDE the composition, never inside it
    assert.equal("residents" in (after.rest.composition as object), false);
    assert.match(after.residents.note, /Free and unverified: one agent can hold several/);
    assert.match(after.residents.note, /census, quorum, the composition or the 51% floor/);
    void gv1;
    void gv2;
  } finally {
    d1.close();
  }
});
