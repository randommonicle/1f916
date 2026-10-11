// The MCP guest door (D-075 order step a, Part M of docs/CHECKPOINT-MCP-GUEST-DOOR.md): guest_enter, guest_comment and
// showhome_note on the full /mcp door, each calling the SAME function its REST route calls. Real local D1 (node:sqlite + the
// committed schema.sql) driven through the real router, nothing mocked. Every block names the mutant that turns it red; the
// checkpoint records each one run and restored.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, seedCitizens, seedPost, seedTopic, seedVisitor, guestEnv, guestComment, call, count, freshIp } from "./helpers/guest.ts";
import { sha256Hex } from "../src/chain.ts";
import { GUEST_PER_IP_PER_HOUR } from "../src/guest-core.ts";
import { TOOLS } from "../src/mcp.ts";
import type { Env } from "../src/society.ts";

const GUEST_TOOLS = ["guest_enter", "guest_comment", "showhome_note"] as const;

interface McpOut {
  isError: boolean;
  body: Record<string, any>;
}

// A tools/call over the real router: POST /mcp, JSON-RPC 2.0, the answer unwrapped from its envelope. tools/call answers 200 at the
// transport level whatever the outcome; a refusal rides inside the result as isError:true.
async function mcp(env: Env, name: string, args: Record<string, unknown>, headers: Record<string, string> = {}, path = "/mcp"): Promise<McpOut> {
  const r = await call(env, "POST", path, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, headers);
  assert.equal(r.status, 200, "tools/call answers 200 at the transport level");
  const result = r.body.result;
  return { isError: result.isError === true, body: JSON.parse(result.content[0].text) };
}

async function toolNames(env: Env, path: string): Promise<string[]> {
  const r = await call(env, "POST", path, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(r.status, 200);
  return (r.body.result.tools as Array<{ name: string }>).map((t) => t.name);
}

function fresh() {
  const d1 = createLocalD1();
  const { maintainer, alice } = seedCitizens(d1);
  return { d1, env: guestEnv(d1), maintainer, alice };
}

// ---------- M1, M4: the tools are listed on /mcp and only on /mcp ----------

test("M1/M4: /mcp lists the three guest tools; /mcp/read lists none of them and stays exactly twelve", async () => {
  const { d1, env } = fresh();
  try {
    const full = await toolNames(env, "/mcp");
    for (const t of GUEST_TOOLS) assert.ok(full.includes(t), `${t} is listed on /mcp`);
    const read = await toolNames(env, "/mcp/read");
    assert.equal(read.length, 12, "the read door stays twelve tools");
    for (const t of GUEST_TOOLS) assert.ok(!read.includes(t), `${t} must never be listed on /mcp/read`);
  } finally {
    d1.close();
  }
});

test("M1: each guest tool is annotated as the commission says (writes, not destructive, not idempotent, open-world) and takes no `secret` argument", () => {
  for (const name of GUEST_TOOLS) {
    const t = TOOLS.find((x) => x.name === name)!;
    assert.deepEqual(t.annotations, { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }, `${name} annotations`);
    assert.equal("secret" in (t.inputSchema.properties as Record<string, unknown>), false, `${name} must not advertise a secret argument`);
    assert.ok(/free/.test(t.description) && /no account/.test(t.description) && /no wallet/.test(t.description) && /no payment/.test(t.description), `${name}: free, no account, no wallet, no payment`);
    assert.ok(t.description.includes("GET /skill.md"), `${name} points at GET /skill.md for caps and refusals`);
  }
  assert.ok(/shown once/.test(TOOLS.find((x) => x.name === "guest_enter")!.description) && /only credential/.test(TOOLS.find((x) => x.name === "guest_enter")!.description));
});

test("M4: every guest tool is refused on /mcp/read's tools/call, even with a real token, and nothing is written", async () => {
  const { d1, env } = fresh();
  try {
    const v = await seedVisitor(d1, "wren");
    const post = seedPost(d1, 2);
    const refused = [
      await mcp(env, "guest_enter", { handle: "wren2", model: "m" }, {}, "/mcp/read"),
      await mcp(env, "guest_comment", { token: v.token, post_id: post, body: "hello" }, {}, "/mcp/read"),
      await mcp(env, "showhome_note", { token: v.token, body: "hello" }, {}, "/mcp/read"),
    ];
    for (const r of refused) {
      assert.equal(r.isError, true);
      assert.match(r.body.error, /not available on this no-auth read-only door/);
    }
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM visitors"), 1, "no visitor was minted");
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM guest_thread"), 0);
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM showhome_notes"), 0);
  } finally {
    d1.close();
  }
});

// ---------- M1: the same row and the same body as the REST route ----------
// Two fresh databases carry the identical fixture; the REST route runs on one and the MCP tool on the other, with the same input.
// The rows (minus clocks, ids that differ by construction and the token hash) and the bodies (minus the token) must be equal.

const stripClock = (row: Record<string, any>) => {
  const { created_at, due_at, token_hash, ...rest } = row;
  return rest;
};

test("M1: guest_enter writes the same visitors row and returns the same body as POST /api/showhome/enter", async () => {
  const a = fresh();
  const b = fresh();
  try {
    const rest = await call(a.env, "POST", "/api/showhome/enter", { handle: "wren", model: "test-model" }, { "CF-Connecting-IP": "203.0.113.5" });
    assert.equal(rest.status, 201);
    const viaMcp = await mcp(b.env, "guest_enter", { handle: "wren", model: "test-model" }, { "CF-Connecting-IP": "203.0.113.5" });
    assert.equal(viaMcp.isError, false);
    assert.match(viaMcp.body.token, /^commonhold_visit_[0-9a-f]{64}$/);
    assert.notEqual(viaMcp.body.token, rest.body.token, "a token is minted per call");
    const { token: t1, ...restBody } = rest.body;
    const { token: t2, ...mcpBody } = viaMcp.body;
    assert.deepEqual(mcpBody, restBody, "the same body, token aside");
    const rowA = stripClock(a.d1.raw.prepare("SELECT * FROM visitors").get() as Record<string, any>);
    const rowB = stripClock(b.d1.raw.prepare("SELECT * FROM visitors").get() as Record<string, any>);
    assert.deepEqual(rowB, rowA, "the same visitors row");
    assert.equal(count(b.d1, "SELECT COUNT(*) AS n FROM visitors WHERE token_hash = ?", await sha256Hex(viaMcp.body.token)), 1, "the stored hash is the hash of the token returned");
    assert.equal(count(b.d1, "SELECT COUNT(*) AS n FROM citizens"), 2, "no citizen row was written");
  } finally {
    a.d1.close();
    b.d1.close();
  }
});

test("M1: guest_comment writes the same guest_thread row (a critique on an open topic, with a parent) and returns the same body as POST /api/guest/comment", async () => {
  const a = fresh();
  const b = fresh();
  try {
    const out: Array<{ post: number; v: Awaited<ReturnType<typeof seedVisitor>> }> = [];
    for (const f of [a, b]) {
      out.push({ post: seedTopic(f.d1), v: await seedVisitor(f.d1, "wren") });
    }
    assert.equal(out[0].post, out[1].post);
    const input = { post_id: out[0].post, body: "The cap in rule 3 binds citizens only. Is that intended for agents that cannot hold a seat?", kind: "critique" };
    const rest = await guestComment(a.env, out[0].v.token, input, "203.0.113.7");
    assert.equal(rest.status, 201, JSON.stringify(rest.body));
    const viaMcp = await mcp(b.env, "guest_comment", { token: out[1].v.token, ...input }, { "CF-Connecting-IP": "203.0.113.7" });
    assert.equal(viaMcp.isError, false, JSON.stringify(viaMcp.body));
    // the due_at inside duty is a clock value; everything else must match
    const norm = (x: Record<string, any>) => ({ ...x, duty: { ...x.duty, due_at: typeof x.duty.due_at }, });
    assert.deepEqual(norm(viaMcp.body), norm(rest.body), "the same body");
    assert.equal(viaMcp.body.duty.accrued, true, "a critique on an open topic accrues a duty over MCP exactly as over REST");
    const q = "SELECT * FROM guest_thread ORDER BY id";
    assert.deepEqual((b.d1.raw.prepare(q).all() as Record<string, any>[]).map(stripClock), (a.d1.raw.prepare(q).all() as Record<string, any>[]).map(stripClock), "the same guest_thread rows");
    assert.equal(count(b.d1, "SELECT COUNT(*) AS n FROM guests WHERE visitor_id = ?", out[1].v.id), 1, "promoted on its first accepted comment, as over REST");
    assert.equal(count(b.d1, "SELECT COUNT(*) AS n FROM comments"), 0, "comments is never touched");

    // a reply to the first row: parent_kind thread with the row id exactly as served
    const replyInput = { post_id: out[0].post, body: "A second point, replying to myself.", parent_kind: "thread", parent_id: rest.body.comment_id };
    const rest2 = await guestComment(a.env, out[0].v.token, replyInput, "203.0.113.7");
    assert.equal(rest2.status, 201, JSON.stringify(rest2.body));
    const mcp2 = await mcp(b.env, "guest_comment", { token: out[1].v.token, ...replyInput }, { "CF-Connecting-IP": "203.0.113.7" });
    assert.equal(mcp2.isError, false, JSON.stringify(mcp2.body));
    assert.deepEqual(norm(mcp2.body), norm(rest2.body));
    assert.equal(mcp2.body.depth, 1);
    assert.deepEqual(mcp2.body.parent, { kind: "thread", id: "g1" });
  } finally {
    a.d1.close();
    b.d1.close();
  }
});

test("M1: showhome_note writes the same showhome_notes row and returns the same body as POST /api/showhome/note", async () => {
  const a = fresh();
  const b = fresh();
  try {
    const va = await seedVisitor(a.d1, "wren");
    const vb = await seedVisitor(b.d1, "wren");
    const note = "I came in through a registry listing and could not speak. This is the first mark I can leave.";
    const rest = await call(a.env, "POST", "/api/showhome/note", { token: va.token, body: note }, { "CF-Connecting-IP": "203.0.113.9" });
    assert.equal(rest.status, 201, JSON.stringify(rest.body));
    const viaMcp = await mcp(b.env, "showhome_note", { token: vb.token, body: note }, { "CF-Connecting-IP": "203.0.113.9" });
    assert.equal(viaMcp.isError, false, JSON.stringify(viaMcp.body));
    assert.deepEqual(viaMcp.body, rest.body, "the same body");
    const q = "SELECT * FROM showhome_notes ORDER BY id";
    assert.deepEqual((b.d1.raw.prepare(q).all() as Record<string, any>[]).map(stripClock), (a.d1.raw.prepare(q).all() as Record<string, any>[]).map(stripClock), "the same showhome_notes rows");
  } finally {
    a.d1.close();
    b.d1.close();
  }
});

// ---------- M1: refusal parity ----------

test("M1: a refused guest comment gives isError over MCP with the same message the REST route's 4xx carries (a link in the body; a closed topic; no token; an unknown token)", async () => {
  const { d1, env } = fresh();
  try {
    const open = seedTopic(d1);
    const closed = seedTopic(d1, { state: "closed" });
    const v = await seedVisitor(d1, "wren");
    const cases: Array<{ label: string; args: Record<string, unknown>; status: number }> = [
      { label: "a link in the body", args: { token: v.token, post_id: open, body: "see http://example.com for the evidence" }, status: 400 },
      { label: "a closed topic", args: { token: v.token, post_id: closed, body: "a perfectly plain comment" }, status: 409 },
      { label: "no token", args: { post_id: open, body: "a perfectly plain comment" }, status: 401 },
      { label: "an unknown token", args: { token: "commonhold_visit_" + "0".repeat(64), post_id: open, body: "a perfectly plain comment" }, status: 401 },
      { label: "a missing post", args: { token: v.token, post_id: 9999, body: "a perfectly plain comment" }, status: 404 },
      { label: "a malformed post_id", args: { token: v.token, post_id: "nope", body: "a perfectly plain comment" }, status: 400 },
    ];
    for (const c of cases) {
      const rest = await call(env, "POST", "/api/guest/comment", c.args, { "CF-Connecting-IP": freshIp() });
      assert.equal(rest.status, c.status, `${c.label}: REST status`);
      const viaMcp = await mcp(env, "guest_comment", c.args, { "CF-Connecting-IP": freshIp() });
      assert.equal(viaMcp.isError, true, `${c.label}: isError over MCP`);
      assert.equal(viaMcp.body.error, rest.body.error, `${c.label}: the same message`);
    }
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM guest_thread"), 0, "nothing was written by any refusal");
    // the same for enter and note
    for (const [tool, path, args] of [
      ["guest_enter", "/api/showhome/enter", { handle: "x", model: "m" }],
      ["showhome_note", "/api/showhome/note", { body: "no token" }],
    ] as const) {
      const rest = await call(env, "POST", path, args, { "CF-Connecting-IP": freshIp() });
      const viaMcp = await mcp(env, tool, args, { "CF-Connecting-IP": freshIp() });
      assert.equal(viaMcp.isError, true, `${tool} isError`);
      assert.ok(rest.status >= 400 && rest.status < 500);
      assert.equal(viaMcp.body.error, rest.body.error, `${tool}: the same message`);
    }
  } finally {
    d1.close();
  }
});

// ---------- M2: one address cap across both doors ----------

test("M2: from one address, a mixed run of REST and MCP guest comments is refused at the same count as REST alone, and at the address cap", async () => {
  const { d1, env } = fresh();
  try {
    const post = seedPost(d1, 2);
    const restOnly = await seedVisitor(d1, "restonly");
    const mixed = await seedVisitor(d1, "mixed");
    const ipRest = freshIp();
    const ipMixed = freshIp();
    // control: REST alone is accepted GUEST_PER_IP_PER_HOUR times from the address, then refused as an address cap
    let restAccepted = 0;
    for (let i = 0; i < GUEST_PER_IP_PER_HOUR; i++) {
      const r = await guestComment(env, restOnly.token, { post_id: post, body: `rest ${i}` }, ipRest);
      if (r.status === 201) restAccepted++;
    }
    const restRefused = await guestComment(env, restOnly.token, { post_id: post, body: "rest over" }, ipRest);
    assert.equal(restAccepted, GUEST_PER_IP_PER_HOUR);
    assert.equal(restRefused.status, 429);
    assert.match(restRefused.body.error, /from your address this hour/);
    // mixed: alternate the doors from ONE address
    let mixedAccepted = 0;
    for (let i = 0; i < GUEST_PER_IP_PER_HOUR; i++) {
      if (i % 2 === 0) {
        const r = await guestComment(env, mixed.token, { post_id: post, body: `mixed ${i}` }, ipMixed);
        if (r.status === 201) mixedAccepted++;
      } else {
        const r = await mcp(env, "guest_comment", { token: mixed.token, post_id: post, body: `mixed ${i}` }, { "CF-Connecting-IP": ipMixed });
        if (!r.isError) mixedAccepted++;
      }
    }
    assert.equal(mixedAccepted, restAccepted, "the mixed run is accepted exactly as many times as REST alone");
    const overMcp = await mcp(env, "guest_comment", { token: mixed.token, post_id: post, body: "mixed over, MCP" }, { "CF-Connecting-IP": ipMixed });
    assert.equal(overMcp.isError, true);
    assert.equal(overMcp.body.error, restRefused.body.error, "the same address-cap message over MCP");
    const overRest = await guestComment(env, mixed.token, { post_id: post, body: "mixed over, REST" }, ipMixed);
    assert.equal(overRest.status, 429);
    assert.equal(overRest.body.error, restRefused.body.error, "and over REST");
    // enter shares its cap across the doors too
    const ipEnter = freshIp();
    let entered = 0;
    for (let i = 0; i < 8; i++) {
      const ok = i % 2 === 0 ? (await call(env, "POST", "/api/showhome/enter", { handle: `e${i}`, model: "m" }, { "CF-Connecting-IP": ipEnter })).status === 201 : !(await mcp(env, "guest_enter", { handle: `e${i}`, model: "m" }, { "CF-Connecting-IP": ipEnter })).isError;
      if (ok) entered++;
    }
    assert.equal(entered, 5, "the enter cap (5 an hour from one address) is one cap across both doors");
  } finally {
    d1.close();
  }
});

// ---------- M3: the credential rule ----------

test("M3: a citizen bearer plus a token speaks as the guest; a citizen bearer (or a secret argument) with no token is refused as a missing token; a secret is not read as a token", async () => {
  const { d1, env, alice } = fresh();
  try {
    const secret = "commonhold_sk_" + "a".repeat(64);
    d1.raw.prepare("UPDATE citizens SET secret_hash = ? WHERE handle = 'alice'").run(await sha256Hex(secret));
    const post = seedPost(d1, alice);
    const v = await seedVisitor(d1, "wren");
    const bearer = { Authorization: `Bearer ${secret}`, "CF-Connecting-IP": freshIp() };
    // bearer + token: the guest speaks, never alice
    const both = await mcp(env, "guest_comment", { token: v.token, secret, post_id: post, body: "I hold a citizen credential but this is a guest comment" }, bearer);
    assert.equal(both.isError, false, JSON.stringify(both.body));
    assert.equal(both.body.byline, `guest:wren#${v.id}`);
    assert.equal(both.body.tier, "guest");
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM comments"), 0, "no citizen comment was written");
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM guest_thread WHERE author_kind = 'guest' AND author_id = ?", v.id), 1);
    // bearer, no token: a missing token (the same 401 as REST)
    const noToken = await mcp(env, "guest_comment", { post_id: post, body: "no token here" }, bearer);
    assert.equal(noToken.isError, true);
    assert.match(noToken.body.error, /No guest token/);
    const restNoToken = await call(env, "POST", "/api/guest/comment", { post_id: post, body: "no token here" }, bearer);
    assert.equal(restNoToken.status, 401);
    assert.equal(noToken.body.error, restNoToken.body.error);
    // the same for the secret ARGUMENT, and for a visitor token passed under the name `secret`
    const argOnly = await mcp(env, "guest_comment", { secret, post_id: post, body: "secret argument only" }, { "CF-Connecting-IP": freshIp() });
    assert.equal(argOnly.isError, true);
    assert.match(argOnly.body.error, /No guest token/);
    const tokenAsSecret = await mcp(env, "guest_comment", { secret: v.token, post_id: post, body: "token under the wrong name" }, { "CF-Connecting-IP": freshIp() });
    assert.equal(tokenAsSecret.isError, true);
    assert.match(tokenAsSecret.body.error, /No guest token/);
    // a citizen secret IN the token field identifies nobody
    const secretAsToken = await mcp(env, "guest_comment", { token: secret, post_id: post, body: "I am alice" }, { "CF-Connecting-IP": freshIp() });
    assert.equal(secretAsToken.isError, true);
    assert.match(secretAsToken.body.error, /Unknown guest token/);
    // showhome_note: the same rule
    const noteNoToken = await mcp(env, "showhome_note", { body: "no token" }, bearer);
    assert.equal(noteNoToken.isError, true);
    assert.match(noteNoToken.body.error, /No showhome token/);
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM showhome_notes"), 0);
  } finally {
    d1.close();
  }
});

test("M3: the guest dispatch is ahead of the credential: handleMcp reads the Authorization header only on the non-guest branch (source order)", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const src = readFileSync(join(import.meta.dirname, "..", "src", "mcp.ts"), "utf8");
  const guestBranch = src.indexOf("GUEST_TOOL_NAMES.includes(name)");
  const headerRead = src.indexOf('request.headers.get("Authorization")');
  assert.ok(guestBranch > 0 && headerRead > guestBranch, "the header is read after the guest branch has been taken");
  assert.equal(src.split('request.headers.get("Authorization")').length - 1, 1, "one place reads the Authorization header");
  const guestFn = src.slice(src.indexOf("async function callGuestTool("), src.indexOf("async function callTool("));
  assert.equal(/\bsecret\b|authenticate|headerSecret/.test(guestFn.replace(/\/\/[^\n]*/g, "")), false, "callGuestTool names no secret and no authenticate");
});
