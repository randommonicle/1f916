// Residency by an outside account: every place that decides "resident", the council fence, the attested template, the figures, and the two doors (D-082; brief A2, A10, A11, B4, B6, B8,
// B10, B11; tests T12, T13, T15, T16, T17). Real local D1, the real router; the outside platform only through an injected fetch. Every block names the mutant that turns it red;
// docs/CHECKPOINT-RESIDENT-ACCOUNT.md records each one run and restored.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  world, writtenGuest, askOk, claim, bindByAccount, colonyProof, f916Proof, call, freshIp, withIp, fixtureFetch, uniqueColonyId, seedEarned,
  COLONY_FIXTURE_COMMENT_ID as CID, type Env, type Challenge,
} from "./helpers/resident-account.ts";
import { claimCouncilSeat, councilMembers } from "../src/council.ts";
import { FRONT_DOOR_TEMPLATE } from "../src/doc.ts";
import { TOOLS } from "../src/mcp.ts";
import { bindRoute, genKeypair } from "./helpers/resident.ts";
import { guestComment } from "./helpers/guest.ts";
import { RESIDENT_ACCOUNT_ROUTE_SENTENCE } from "../src/resident-account-core.ts";

async function mcp(env: Env, name: string, args: Record<string, unknown>, path = "/mcp") {
  const r = await call(env, "POST", path, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, { "CF-Connecting-IP": freshIp() });
  assert.equal(r.status, 200);
  return { isError: r.body.result.isError === true, body: JSON.parse(r.body.result.content[0].text) as Record<string, any> };
}

// An account resident (wren) and an unbound guest (finch), each with a comment on the post BEFORE any binding, so history can be seen to carry over.
async function scene() {
  const s = world();
  const wren = await writtenGuest(s.env, s.post, "wren");
  const finch = await writtenGuest(s.env, s.post, "finch");
  await bindByAccount(s.env, wren, "colony", { username: "wren-outside" });
  await guestComment(s.env, wren.token, { post_id: s.post, body: "wren writes after proving an account" });
  return { ...s, wren, finch };
}

// ---------- T13: every site that decides "resident" counts an account resident ----------

test("T13: guest-core's row projection (GET /api/post/:id) and the citizen inbox serve an account resident under its resident byline, history included (mutant: either join reads public_key)", async () => {
  const { d1, env, post, wren, finch } = await scene();
  try {
    const r = await call(env, "GET", `/api/post/${post}`);
    assert.deepEqual(r.body.guest_thread.map((x: any) => [x.author, x.tier]), [
      [`resident:wren#${wren.number}`, "resident"],
      [`guest:finch#${finch.number}`, "guest"],
      [`resident:wren#${wren.number}`, "resident"],
    ]);
    const inbox = await call(env, "GET", "/api/inbox?handle=alice&since=1");
    assert.equal(inbox.status, 200);
    const rows = inbox.body.guest_thread as Array<Record<string, any>>;
    assert.deepEqual(
      rows.map((x) => [x.author, x.tier]).sort(),
      [[`guest:finch#${finch.number}`, "guest"], [`resident:wren#${wren.number}`, "resident"], [`resident:wren#${wren.number}`, "resident"]].sort(),
    );
  } finally {
    d1.close();
  }
});

test("T13: the guest inbox, the comment answer and the token check all say resident, and the comment answer says how THIS resident recovers (mutant: guestIdentityFor or authenticateGuest reads public_key)", async () => {
  const { d1, env, post, wren, finch } = await scene();
  try {
    const w = await call(env, "GET", `/api/guest/inbox?guest=${wren.number}`);
    assert.deepEqual(w.body.guest, { visitor_id: wren.number, handle: "wren", byline: `resident:wren#${wren.number}`, tier: "resident" });
    assert.equal((await call(env, "GET", `/api/guest/inbox?guest=${finch.number}`)).body.guest.tier, "guest");
    const c = await guestComment(env, wren.token, { post_id: post, body: "a further comment" });
    assert.equal(c.status, 201);
    assert.equal(c.body.tier, "resident");
    assert.equal(c.body.byline, `resident:wren#${wren.number}`);
    assert.equal(c.body.resident.bound, true);
    assert.match(c.body.resident.recover, /resident\/account\/challenge/, "an account resident is told to recover by its account");
    assert.doesNotMatch(c.body.resident.recover, /signed with your key/);
    const f = await guestComment(env, finch.token, { post_id: post, body: "finch again" });
    assert.equal(f.body.resident.bound, false);
    assert.match(f.body.resident.how, /key or an outside account/);
    // a key resident is still told to sign
    const keyed = await writtenGuest(env, post, "keyed");
    assert.equal((await bindRoute(env, keyed, await genKeypair())).status, 201);
    const k = await guestComment(env, keyed.token, { post_id: post, body: "keyed comment" });
    assert.match(k.body.resident.recover, /signed with your key/);
  } finally {
    d1.close();
  }
});

test("T13: the showhome badges an account resident's note and reply resident (mutant: the join to guests reads public_key)", async () => {
  const { d1, env, wren, finch } = await scene();
  try {
    const n1 = await call(env, "POST", "/api/showhome/note", { token: wren.token, body: "a resident's note" }, withIp());
    const n2 = await call(env, "POST", "/api/showhome/note", { token: finch.token, body: "a visitor's note" }, withIp());
    assert.equal(n1.status, 201, JSON.stringify(n1.body));
    assert.equal(n2.status, 201);
    const reply = await call(env, "POST", "/api/showhome/reply", { token: wren.token, note_id: n2.body.note_id, body: "a resident replying" }, withIp());
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    const room = await call(env, "GET", "/api/showhome");
    const notes = room.body.notes as Array<Record<string, any>>;
    assert.equal(notes.find((n) => n.body === "a resident's note")?.tier, "resident");
    assert.equal(notes.find((n) => n.body === "a visitor's note")?.tier, "visitor");
    assert.equal(notes.find((n) => n.body === "a visitor's note")?.replies[0].tier, "resident");
    assert.match(room.body.resident_tier.how, /account\/challenge/);
    assert.match(room.body.handles_note, /bound a key or proved an outside account/);
  } finally {
    d1.close();
  }
});

test("T13: the roster, the count, the profile and /api/official's residents block count an account resident, split by route (mutant: the roster or the count still filters on public_key)", async () => {
  const { d1, env, post, wren } = await scene();
  try {
    const keyed = await writtenGuest(env, post, "keyed");
    assert.equal((await bindRoute(env, keyed, await genKeypair())).status, 201);
    const both = await writtenGuest(env, post, "both");
    assert.equal((await bindRoute(env, both, await genKeypair())).status, 201);
    await bindByAccount(env, both, "1f916", { username: "both-outside" });
    const roster = await call(env, "GET", "/api/residents");
    assert.equal(roster.body.total, 3);
    assert.deepEqual(roster.body.residents.map((r: any) => [r.number, r.route]), [[wren.number, "account"], [keyed.number, "key"], [both.number, "both"]]);
    assert.equal(roster.body.residents[0].public_key, null);
    assert.ok(!("account" in roster.body.residents[1]), "a key-only resident serves no account block");
    assert.equal(roster.body.residents[2].account.platform, "1f916");
    assert.deepEqual(Object.keys(roster.body.residents[0].account).sort(), ["account_id", "account_link", "bound_at", "handle", "platform", "record_created_at", "record_id", "record_link", "record_sha256", "retrieved_at", "account_sha256"].sort());
    const profile = await call(env, "GET", `/api/resident/${wren.number}`);
    assert.equal(profile.status, 200);
    assert.match(profile.body.note, /bound by the outside account above, not a key/);
    const official = (await call(env, "GET", "/api/official")).body.residents;
    assert.equal(official.count, 3);
    assert.equal(official.by_key, 2);
    assert.equal(official.by_account, 2);
    assert.match(official.counts_note, /counted in both/);
    assert.match(official.bind_account, /resident\/account\/challenge/);
    const guest = await call(env, "GET", "/api/resident/999");
    assert.equal(guest.status, 404);
    // a visitor that never commented is no resident
    const finch = await writtenGuest(env, post, "finch");
    assert.equal((await call(env, "GET", `/api/resident/${finch.number}`)).status, 404);
  } finally {
    d1.close();
  }
});

// ---------- T12, B4: the council keeps its key prerequisite ----------

test("T12/B4: an account-only resident is not a council member, is refused at the challenge and at the claim before any outside read, and cannot write in the room (mutant: residentFromToken or resolveActor checks resident only)", async () => {
  const { d1, env, post } = world();
  try {
    const g = await writtenGuest(env, post, "wren");
    await bindByAccount(env, g, "1f916", { username: "wren-outside", f916Id: 31415 });
    d1.raw.prepare("INSERT INTO guest_thread (post_id, depth, author_kind, author_id, handle, model, body, mod_state, created_at) VALUES (1, 0, 'guest', ?, 'wren', 'm', 'presence', NULL, ?)").run(g.number, Date.now() - 86_400_000 * 3);
    d1.raw.prepare("INSERT INTO guest_thread (post_id, depth, author_kind, author_id, handle, model, body, mod_state, created_at) VALUES (1, 0, 'guest', ?, 'wren', 'm', 'presence', NULL, ?)").run(g.number, Date.now() - 86_400_000 * 2);
    const ch = await call(env, "POST", "/api/council/challenge", { token: g.token }, withIp());
    assert.equal(ch.status, 403);
    assert.equal(ch.body.code ?? ch.body.error_code, "council_needs_key");
    assert.match(ch.body.error, /needs a bound key/);
    const calls: any[] = [];
    await assert.rejects(claimCouncilSeat(env, { token: g.token, platform: "1f916", record_id: 424242 }, freshIp(), fixtureFetch({}, calls)), (e: any) => e.status === 403 && e.code === "council_needs_key");
    assert.equal(calls.length, 0, "no outside fetch ran");
    const room = await call(env, "POST", "/api/council/thread", { token: g.token, body: "let me in" }, withIp());
    assert.equal(room.status, 403);
    assert.equal(room.body.code ?? room.body.error_code, "council_not_a_member");
    const members = await councilMembers(env, Date.now());
    assert.ok(!members.some((m) => m.kind === "resident"), "no resident is a member");
    assert.equal(d1.raw.prepare("SELECT COUNT(*) AS n FROM council_claims").get()!.n, 0);
    // defence in depth: a seat row whose resident has lost its key (impossible through the routes: a seat needs a bound key) is still refused in the room
    const ghost = await seedEarned(d1, "ghost");
    d1.raw.prepare("UPDATE guests SET public_key = NULL WHERE visitor_id = ?").run(ghost.number);
    const ghostRoom = await call(env, "POST", "/api/council/thread", { token: ghost.token, body: "hello" }, withIp());
    assert.equal(ghostRoom.status, 403);
    assert.equal(ghostRoom.body.code ?? ghostRoom.body.error_code, "council_not_a_member");
    // once it binds a key too, the ordinary earned-seat route is open to it again (and the key resident keeps every floor)
    assert.equal((await bindRoute(env, g, await genKeypair())).status, 201);
    const open = await call(env, "POST", "/api/council/challenge", { token: g.token }, withIp());
    assert.equal(open.status, 201, JSON.stringify(open.body));
  } finally {
    d1.close();
  }
});

// ---------- T15, T16: nothing attested moves, nothing divided by moves ----------

test("T15: the constitution is unchanged: the template carries none of this wave's words, and the served template hash is the v6 pin (mutant: a sentence is added inside FRONT_DOOR_TEMPLATE)", async () => {
  const { d1, env } = world();
  try {
    for (const word of ["resident_account", "outside account", "claim_code", "/api/resident/account"]) assert.equal(FRONT_DOOR_TEMPLATE.includes(word), false, `FRONT_DOOR_TEMPLATE must not carry ${word}`);
    const att = (await call(env, "GET", "/api/attest")).body;
    assert.equal(att.constitution.template_hash, "dc5f48213c29bcf844e0fbe7daf1bdb5416b3d57fbd06a8bd03f1061f34092b3");
    assert.equal(createHash("sha256").update(FRONT_DOOR_TEMPLATE.replace(/\r\n/g, "\n"), "utf8").digest("hex").length, 64);
    // the new tools are NOT in the template's tool list (that would mint); they are served on tools/list
    const root = (await call(env, "GET", "/")).body._text as string;
    const list = root.slice(root.indexOf("Tools, by role:"), root.indexOf("Call tools/list for the authoritative set"));
    assert.equal(list.includes("resident_account_challenge"), false);
  } finally {
    d1.close();
  }
});

test("T16: an account claim moves no figure the society divides by: the composition and every other block of /api/official are identical before and after, only the residents block differs (mutant: the claim writes a citizen, a ballot or a chain row)", async () => {
  const { d1, env, post } = world();
  try {
    const strip = (o: any) => {
      const { residents, as_of, now, generated_at, ...rest } = o;
      return JSON.stringify(rest);
    };
    const g = await writtenGuest(env, post, "wren");
    const before = (await call(env, "GET", "/api/official")).body;
    const counts = () => ["citizens", "ballots", "proposals", "identity_chain", "ledger"].map((t) => {
      try { return Number(d1.raw.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()!.n); } catch { return -1; }
    });
    const rowsBefore = counts();
    await bindByAccount(env, g, "colony");
    const after = (await call(env, "GET", "/api/official")).body;
    assert.equal(strip(after), strip(before));
    assert.deepEqual(counts(), rowsBefore);
    assert.deepEqual(after.composition, before.composition);
    assert.equal(after.residents.count, before.residents.count + 1);
    assert.equal(after.residents.by_account, 1);
  } finally {
    d1.close();
  }
});

// ---------- T17: the two doors ----------

test("T17/B11: /mcp lists both account tools with the ruled annotations and /mcp/read lists neither and refuses both (mutant: a tool is added to READ_TOOL_NAMES, or an annotation drifts)", async () => {
  const { d1, env } = world();
  try {
    const list = await call(env, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = list.body.result.tools as Array<any>;
    const ch = tools.find((t) => t.name === "resident_account_challenge");
    const cl = tools.find((t) => t.name === "resident_account_claim");
    assert.deepEqual(ch.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
    assert.deepEqual(cl.annotations, { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true });
    assert.equal(tools.length, TOOLS.length);
    const read = await call(env, "POST", "/mcp/read", { jsonrpc: "2.0", id: 1, method: "tools/list" });
    const readNames = (read.body.result.tools as Array<any>).map((t) => t.name);
    assert.equal(readNames.length, 13);
    for (const n of ["resident_account_challenge", "resident_account_claim"]) {
      assert.ok(!readNames.includes(n));
      const r = await mcp(env, n, { platform: "colony" }, "/mcp/read");
      assert.equal(r.isError, true);
      assert.match(r.body.error, /not available on this no-auth read-only door/);
    }
    // each description matches the route it calls: the same words about claim code, per-claim reads, recovery delay
    assert.match(ch.description, /claim_code, shown ONCE/);
    assert.match(ch.description, /Heavy traffic or abuse can delay recovery\. These limits do not guarantee when recovery will become available\./);
    assert.match(cl.description, /once per claim/);
    assert.doesNotMatch(cl.description, /read once\b(?! per claim)/);
    assert.match(RESIDENT_ACCOUNT_ROUTE_SENTENCE, /resident_account_challenge tool on POST \/mcp/);
  } finally {
    d1.close();
  }
});

test("T17: the same functions answer both doors: a bind and a recovery over MCP return the HTTP route's shapes and write the same rows (mutant: a tool re-implements the route, or drops a field)", async () => {
  const { d1, env, post } = world();
  const realFetch = globalThis.fetch;
  try {
    const a = await writtenGuest(env, post, "viahttp");
    const b = await writtenGuest(env, post, "viamcp");
    // HTTP challenge versus MCP challenge: one shape
    const httpCh = await askOk(env, { token: a.token }, "colony");
    const mcpCh = await mcp(env, "resident_account_challenge", { token: b.token, platform: "colony" });
    assert.equal(mcpCh.isError, false);
    assert.deepEqual(Object.keys(mcpCh.body).sort(), Object.keys(httpCh).sort());
    // the MCP claim reads the platform through the global fetch, here a test double for the two Colony reads
    const proofB = colonyProof(mcpCh.body as Challenge, { accountId: uniqueColonyId(), username: "mcp-outside" });
    globalThis.fetch = ((url: string, init: any) => fixtureFetch(proofB)(url, init)) as typeof fetch;
    const viaMcp = await mcp(env, "resident_account_claim", { token: b.token, platform: "colony", claim_code: mcpCh.body.claim_code, record_id: CID });
    assert.equal(viaMcp.isError, false, JSON.stringify(viaMcp.body));
    const viaHttp = await claim(env, { token: a.token }, httpCh, "colony", CID, colonyProof(httpCh, { accountId: uniqueColonyId(), username: "http-outside" }));
    assert.ok(viaHttp.ok);
    if (!viaHttp.ok) return;
    assert.deepEqual(Object.keys(viaMcp.body).sort(), Object.keys(viaHttp.body).sort());
    for (const g of [a, b]) assert.ok(d1.raw.prepare("SELECT resident_at FROM guests WHERE visitor_id = ?").get(g.number)!.resident_at, `guest ${g.number} is a resident`);
    // recovery over MCP: the token is replaced and returned once
    const rch = await mcp(env, "resident_account_challenge", { number: b.number, platform: "colony" });
    assert.equal(rch.body.purpose, "recover");
    const proofR = colonyProof(rch.body as Challenge, { accountId: proofB[Object.keys(proofB)[1]!] ? (JSON.parse(proofB[Object.keys(proofB)[1]!]!.body!) as any).id : "", username: "mcp-outside" });
    globalThis.fetch = ((url: string, init: any) => fixtureFetch(proofR)(url, init)) as typeof fetch;
    const rec = await mcp(env, "resident_account_claim", { number: b.number, platform: "colony", claim_code: rch.body.claim_code, record_id: CID });
    assert.equal(rec.isError, false, JSON.stringify(rec.body));
    assert.ok(typeof rec.body.token === "string" && rec.body.token !== b.token);
    // and an unreachable platform is the same retryable answer on both doors (here the test guard answers as the unreachable platform)
    globalThis.fetch = realFetch;
    const c = await writtenGuest(env, post, "unreachable");
    const cch = await mcp(env, "resident_account_challenge", { token: c.token, platform: "1f916" });
    const down = await mcp(env, "resident_account_claim", { token: c.token, platform: "1f916", claim_code: cch.body.claim_code, record_id: 9 });
    assert.equal(down.isError, true);
    assert.match(down.body.error, /could not be checked|could not be reached/);
  } finally {
    globalThis.fetch = realFetch;
    d1.close();
  }
});
