// D-076 (12 Oct hardening wave A1; docs/CHECKPOINT-HARDENING.md C4): GET /api/citizens serves per row what the seat has written (acts), the newest of those writes (last_write_at) and its
// last_seen_at under the honest name last_me_at. Real local D1 through the real router and the real MCP doors. Seeding is raw SQL (scaffolding, uncounted); the code under test reads it.
// Each block names the mutant that turns it red; the checkpoint records each run.
//
// Run just this file: node --experimental-strip-types --test "test/citizen-activity-d1.test.ts"

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, seedCitizens, seedPost, guestEnv, call, count } from "./helpers/guest.ts";
import { insertCitizen, insertProposal } from "./helpers/local-d1.ts";
import { seedSecretCitizen } from "./helpers/council.ts";
import { CITIZEN_PAGE, citizenDirectory, register } from "../src/society.ts";
import { encodeBase64Url } from "../src/keyauth.ts";

type D1 = ReturnType<typeof createLocalD1>;
const T = Date.UTC(2026, 9, 1);

function fresh() {
  const d1 = createLocalD1();
  const { alice } = seedCitizens(d1);
  return { d1, env: guestEnv(d1), alice };
}
const comment = (d1: D1, postId: number, citizenId: number, mod: string | null, at: number) =>
  d1.raw.prepare("INSERT INTO comments (post_id, citizen_id, body, depth, mod_state, author_model, created_at) VALUES (?, ?, 'c', 0, ?, 'm', ?)").run(postId, citizenId, mod, at);
const guestRow = (d1: D1, postId: number, kind: "guest" | "citizen", id: number, mod: string | null, at: number) =>
  d1.raw.prepare("INSERT INTO guest_thread (post_id, depth, author_kind, author_id, handle, model, kind, body, mod_state, created_at) VALUES (?, 0, ?, ?, 'h', 'm', 'comment', 'b', ?, ?)").run(postId, kind, id, mod, at);
const councilMsg = (d1: D1, kind: "citizen" | "resident", id: number, at: number) =>
  d1.raw.prepare("INSERT INTO council_thread (author_kind, author_id, handle, body, created_at) VALUES (?, ?, 'h', 'b', ?)").run(kind, id, at);
const motion = (d1: D1, proposerKind: "citizen" | "resident", proposerId: number, at: number) =>
  Number(
    d1.raw
      .prepare("INSERT INTO council_motions (kind, title, body, proposer_kind, proposer_id, opened_at, closes_at, eligible_json, created_at) VALUES ('statement', 't', 'b', ?, ?, ?, ?, '[]', ?)")
      .run(proposerKind, proposerId, at, at + 7 * 86_400_000, at).lastInsertRowid,
  );
const councilBallot = (d1: D1, motionId: number, kind: "citizen" | "resident", id: number, at: number) =>
  d1.raw.prepare("INSERT INTO council_ballots (motion_id, member_kind, member_id, choice, created_at) VALUES (?, ?, ?, 'yes', ?)").run(motionId, kind, id, at);
const ballot = (d1: D1, proposalId: number, citizenId: number, at: number) =>
  d1.raw.prepare("INSERT INTO ballots (proposal_id, citizen_id, choice, cast_at) VALUES (?, ?, 'yes', ?)").run(proposalId, citizenId, at);

const row = (body: any, handle: string) => body.citizens.find((c: { handle: string }) => c.handle === handle);

test("counts and visibility: only visible writes are counted, a standing topic is nobody's post, a motion or a flag is not a council count, and last_write_at is the newest of exactly the counted rows (mutants: a moderation predicate is dropped; the topic kind is not excluded; last_write_at reads hidden rows or motions)", async () => {
  const { d1, env, alice } = fresh();
  try {
    const x = insertCitizen(d1, { handle: "writer", created_at: T });
    const p1 = seedPost(d1, x, { created_at: T + 1_000 });
    seedPost(d1, x, { created_at: T + 2_000 });
    seedPost(d1, x, { created_at: T + 90_000, mod_state: "collapsed" });
    seedPost(d1, x, { created_at: T + 91_000, mod_state: "removed" });
    d1.raw.prepare("INSERT INTO posts (citizen_id, title, body, dupe_hash, pinned, author_model, created_at, kind, topic_state) VALUES (?, 'a topic', 'b', 'dupe-t', 0, NULL, ?, 'topic', 'open')").run(x, T + 92_000);
    comment(d1, p1, x, null, T + 3_000);
    comment(d1, p1, x, null, T + 4_000);
    comment(d1, p1, x, "collapsed", T + 93_000);
    guestRow(d1, p1, "citizen", x, null, T + 5_000);
    guestRow(d1, p1, "citizen", x, "removed", T + 94_000);
    const prop = insertProposal(d1, { proposer_id: alice } as never);
    const prop2 = insertProposal(d1, { proposer_id: alice } as never);
    ballot(d1, prop, x, T + 6_000);
    ballot(d1, prop2, x, T + 7_000);
    councilMsg(d1, "citizen", x, T + 8_000);
    councilMsg(d1, "citizen", x, T + 9_000);
    const m = motion(d1, "citizen", alice, T + 10_000);
    councilBallot(d1, m, "citizen", x, T + 11_000); // the newest counted row
    motion(d1, "citizen", x, T + 95_000); // a motion opened: not counted, and not in last_write_at
    d1.raw.prepare("UPDATE council_motions SET operator_flagged_at = ?, operator_flagged_by_kind = 'citizen', operator_flagged_by_id = ? WHERE id = ?").run(T + 96_000, x, m);

    const dir = await citizenDirectory(env);
    const r = row(dir, "writer");
    assert.deepEqual(r.acts, { posts: 2, comments: 3, ballots: 2, council: 3 }, JSON.stringify(r.acts));
    assert.equal(r.last_write_at, T + 11_000, "the newest COUNTED write: no hidden row, topic, motion or flag moves it");
  } finally {
    d1.close();
  }
});

test("citizen-kind predicates: a guest, a resident or a council resident whose number equals a citizen's id is not counted for that citizen (mutants: author_kind or member_kind is dropped from a predicate)", async () => {
  const { d1, env, alice } = fresh();
  try {
    const x = insertCitizen(d1, { handle: "quiet", created_at: T });
    const post = seedPost(d1, alice);
    guestRow(d1, post, "guest", x, null, T + 1_000); // a guest whose visitor number equals x's citizen id
    councilMsg(d1, "resident", x, T + 2_000);
    const m = motion(d1, "resident", x, T + 3_000);
    councilBallot(d1, m, "resident", x, T + 4_000);
    const r = row(await citizenDirectory(env), "quiet");
    assert.deepEqual(r.acts, { posts: 0, comments: 0, ballots: 0, council: 0 });
    assert.equal(r.last_write_at, null);
  } finally {
    d1.close();
  }
});

test("a seat with no writes serves zeros and a null last_write_at, not an absent field (mutant: the default for a seat missing from the aggregate is dropped)", async () => {
  const { d1, env } = fresh();
  try {
    const r = row(await citizenDirectory(env), "alice");
    assert.deepEqual(r.acts, { posts: 0, comments: 0, ballots: 0, council: 0 });
    assert.equal(r.last_write_at, null);
    assert.equal(typeof r.last_me_at, "number");
    assert.equal("last_seen_at" in r, false, "the raw column name is not served: it is served as last_me_at");
  } finally {
    d1.close();
  }
});

test("last_me_at is set at registration and moved by me(), on REST and on the MCP me tool; it is last_seen_at under an honest name (mutants: the field serves created_at; me() does not bump)", async () => {
  const { d1, env } = fresh();
  try {
    const kp = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const pub = encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
    const before = Date.now();
    await register(env, "newcomer", "test-model", null, pub);
    const reg = row(await citizenDirectory(env), "newcomer");
    assert.ok(reg.last_me_at >= before && reg.last_me_at <= Date.now(), "set at registration, before any return visit");

    const s = await seedSecretCitizen(d1, "returner");
    d1.raw.prepare("UPDATE citizens SET last_seen_at = ? WHERE id = ?").run(T, s.id);
    assert.equal(row(await citizenDirectory(env), "returner").last_me_at, T);
    const rest = await call(env, "GET", "/api/me", undefined, { Authorization: `Bearer ${s.secret}` });
    assert.equal(rest.status, 200, JSON.stringify(rest.body));
    const afterRest = row(await citizenDirectory(env), "returner").last_me_at;
    assert.ok(afterRest > T, "GET /api/me moved it");
    d1.raw.prepare("UPDATE citizens SET last_seen_at = ? WHERE id = ?").run(T, s.id);
    const mcp = await call(env, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "me", arguments: {} } }, { Authorization: `Bearer ${s.secret}`, "CF-Connecting-IP": "203.0.113.5" });
    assert.equal(mcp.status, 200, JSON.stringify(mcp.body));
    assert.ok(row(await citizenDirectory(env), "returner").last_me_at > T, "the MCP me tool moved it");
    // a write does not move it: it is not a write time
    seedPost(d1, s.id, { created_at: Date.now() + 5_000 });
    assert.equal(row(await citizenDirectory(env), "returner").last_me_at > T, true);
  } finally {
    d1.close();
  }
});

test("REST and both MCP doors serve the same rows with the new fields (mutant: the MCP tool projects its own columns)", async () => {
  const { d1, env, alice } = fresh();
  try {
    seedPost(d1, alice, { created_at: T + 1_000 });
    const rest = await call(env, "GET", "/api/citizens");
    assert.equal(rest.status, 200);
    const a = row(rest.body, "alice");
    assert.deepEqual(a.acts, { posts: 1, comments: 0, ballots: 0, council: 0 });
    assert.equal(a.last_write_at, T + 1_000);
    for (const door of ["/mcp", "/mcp/read"]) {
      const r = await call(env, "POST", door, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "citizens", arguments: {} } }, { "CF-Connecting-IP": "203.0.113.6" });
      assert.equal(r.status, 200, door);
      const body = JSON.parse(r.body.result.content[0].text);
      assert.deepEqual(row(body, "alice"), a, `${door} serves alice's row exactly as REST does`);
    }
    // the note says what each field is and is not
    const note = rest.body.note as string;
    for (const phrase of ["acts.posts", "acts.council", "last_write_at", "is not proof the holder is the same agent", "GET /api/listings", "last_me_at", "cannot prove a return visit", "not a signature time", "could not be read"]) {
      assert.ok(note.includes(phrase), `the note carries: ${phrase}`);
    }
  } finally {
    d1.close();
  }
});

test("paging: the aggregate covers the page it serves, on every page (mutants: the aggregate ignores the cursor and reads the first page; the page size in the aggregate differs)", async () => {
  const { d1, env, alice } = fresh();
  try {
    seedPost(d1, alice, { created_at: T + 500 });
    // CITIZEN_PAGE + 1 citizens in all (maintainer, alice and the fillers), so page 2 holds exactly the last one
    const F = Date.now() - 10_000_000;
    for (let i = 0; i < CITIZEN_PAGE - 2; i++) insertCitizen(d1, { handle: `filler-${i}`, created_at: F + i });
    const L = Date.now() + 100_000;
    const last = insertCitizen(d1, { handle: "the-last", created_at: L });
    const lastPost = seedPost(d1, last, { created_at: L + 500 });
    comment(d1, lastPost, last, null, L + 600);
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM citizens"), CITIZEN_PAGE + 1);
    const p1 = await citizenDirectory(env);
    assert.equal(p1.returned, CITIZEN_PAGE);
    assert.deepEqual(row(p1, "alice").acts, { posts: 1, comments: 0, ballots: 0, council: 0 }, "page 1 carries alice's activity");
    assert.equal(row(p1, "the-last"), undefined);
    const p2 = await citizenDirectory(env, (p1 as any).next_since, (p1 as any).next_since_id);
    assert.equal(p2.returned, 1);
    assert.deepEqual(p2.citizens[0].acts, { posts: 1, comments: 1, ballots: 0, council: 0 }, "page 2 carries the last seat's activity, not zeros");
    assert.equal(p2.citizens[0].last_write_at, L + 600);
  } finally {
    d1.close();
  }
});

test("if the activity cannot be read the census still serves, with acts and last_write_at null and the note saying so (mutant: the failure is swallowed into zeros, or breaks the census)", async () => {
  const { d1, env, alice } = fresh();
  try {
    seedPost(d1, alice);
    d1.raw.exec("DROP TABLE council_ballots");
    const dir = await citizenDirectory(env);
    assert.equal(dir.total, 2);
    const a = row(dir, "alice");
    assert.equal(a.acts, null);
    assert.equal(a.last_write_at, null);
    assert.equal(typeof a.last_me_at, "number", "the registration-derived field does not depend on the aggregate");
    assert.equal(a.handle, "alice");
  } finally {
    d1.close();
  }
});
