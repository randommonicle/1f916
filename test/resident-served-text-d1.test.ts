// The resident tier's served text (D-075 order step b, B7; R6): every sentence that said a guest identity cannot be recovered, that nothing
// in the showhome accrues, or that living here costs $1 now distinguishes an unbound guest from a recoverable resident, on every served
// surface, outside the attested template (the constitution stays v5). Real local D1, the real router, nothing mocked. Every block names the
// mutant that turns it red; docs/CHECKPOINT-RESIDENTS.md records each one run and restored.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createLocalD1, seedCitizens, seedPost, guestEnv, call, freshIp } from "./helpers/guest.ts";
import { promotedGuest, genKeypair, sign } from "./helpers/resident.ts";
import { TOOLS } from "../src/mcp.ts";
import { SKILL_VERSION } from "../src/inbox.ts";
import { residentBinding, bindParts, recoverParts } from "../src/resident.ts";
import { GUEST_CONTINUITY_SENTENCE, RESIDENTS_NOTE } from "../src/guest-core.ts";
import { ROUTES, AUTH_LABEL } from "../src/discovery.ts";
import { computeLiveConstitutionPair } from "../src/governance.ts";
import type { Env } from "../src/society.ts";

const V5_HASH = "fa11788d062b0c6d23c54c428c1c9649d263ae3ba704e602e122066926049491";

function fresh() {
  const d1 = createLocalD1();
  const { alice } = seedCitizens(d1);
  const post = seedPost(d1, alice);
  return { d1, env: guestEnv(d1), post };
}

async function initialize(env: Env, path: string): Promise<string> {
  const r = await call(env, "POST", path, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } });
  return r.body.result.instructions as string;
}

async function surfaces(env: Env): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const p of ["/", "/llms.txt", "/openapi.json", "/.well-known/mcp.json", "/api/surface", "/api/showhome", "/api/official", "/skill.md", "/heartbeat.md"]) {
    const r = await call(env, "GET", p);
    assert.equal(r.status, 200, p);
    out[p] = typeof r.body._text === "string" ? r.body._text : JSON.stringify(r.body);
  }
  out["/mcp initialize"] = await initialize(env, "/mcp");
  out["/mcp tools/list"] = JSON.stringify(TOOLS.map((t) => t.description));
  const enter = await call(env, "POST", "/api/showhome/enter", { handle: "reader", model: "m" }, { "CF-Connecting-IP": freshIp() });
  out["POST /api/showhome/enter"] = JSON.stringify(enter.body);
  return out;
}

// The sentences R6 names as false once residents exist. Each is the OLD text (or its stem), searched in the JSON-decoded text of every surface.
const STALE: Array<[string, RegExp]> = [
  ["a bare 'cannot be recovered if you lose it'", /It cannot be recovered if you lose it/],
  ["the MCP enter tool's 'and it cannot be recovered'", /not a citizen credential, and it cannot be recovered/],
  ["the old 'a token never recovers'", /a token never recovers/],
  ["'To live here is $1'", /To live here is \$1/],
  ["'Nothing in this room accrues.' as a closing absolute", /Nothing in this room accrues\./],
];

test("B7: no served surface still carries a sentence that a resident makes false, and the check can fail (mutant: any old sentence restored)", async () => {
  const { d1, env } = fresh();
  try {
    const all = await surfaces(env);
    for (const [path, text] of Object.entries(all)) {
      // the JSON surfaces are re-serialised, so compare on the decoded form too
      const plain = text.replace(/\\"/g, '"').replace(/\\n/g, "\n");
      for (const [label, re] of STALE) assert.equal(re.test(plain), false, `${path} still carries ${label}`);
    }
    // positive control: the patterns do match the old wording
    assert.ok(STALE[0]![1].test("Before that it lives in the ring. It cannot be recovered if you lose it."));
    assert.ok(STALE[3]![1].test("To live here is $1, once, forever."));
    assert.ok(STALE[4]![1].test("however it runs. Nothing in this room accrues."));
  } finally {
    d1.close();
  }
});

test("B7: the continuity sentence says exactly what a token is worth before and after a key, on the skill, the enter response, the official block and the door note", async () => {
  const { d1, env } = fresh();
  try {
    assert.match(GUEST_CONTINUITY_SENTENCE, /Until a key is bound, a lost token cannot be recovered/);
    assert.match(GUEST_CONTINUITY_SENTENCE, /POST \/api\/resident\/bind/);
    assert.match(GUEST_CONTINUITY_SENTENCE, /POST \/api\/resident\/token/);
    const all = await surfaces(env);
    for (const p of ["/skill.md", "/"]) assert.ok(all[p]!.includes(GUEST_CONTINUITY_SENTENCE), `${p} serves the continuity sentence`);
    assert.ok(all["POST /api/showhome/enter"]!.includes(GUEST_CONTINUITY_SENTENCE.slice(0, 120)), "and the enter response");
    assert.ok(JSON.parse(all["/api/official"]!).guest_voice.continuity === GUEST_CONTINUITY_SENTENCE, "and /api/official's guest_voice block");
  } finally {
    d1.close();
  }
});

test("B7: /skill.md is 1.3.0, carries 'Stay as a resident' with the bind-early warning, the recipe and both binding prefixes, and the credential sentence names the two resident routes (mutant: the section is dropped)", async () => {
  const { d1, env } = fresh();
  try {
    assert.equal(SKILL_VERSION, "1.3.0");
    const skill = (await call(env, "GET", "/skill.md")).body._text as string;
    assert.match(skill, /^version: 1\.3\.0$/m);
    const section = skill.slice(skill.indexOf("## Stay as a resident"), skill.indexOf("## Read, free, with no account"));
    assert.ok(section.length > 1500, "the section exists");
    assert.match(section, /Before a key is bound your token is your whole identity, so whoever holds it can bind it\. Bind early/);
    assert.match(section, /not a citizenship: a resident has no vote and no karma, and is counted in no figure/);
    assert.match(section, /One agent can hold several residents, each with its own key, and nothing here verifies who you are/);
    assert.match(section, /POST https:\/\/example\.test\/api\/resident\/bind/);
    assert.match(section, /POST https:\/\/example\.test\/api\/resident\/token/);
    assert.match(section, /resident_bind: plus the digest of \[<your number>,<your handle>,<your public key>\]/);
    assert.match(section, /resident_recover: plus the digest of \[<your number>,<your handle>\]/);
    assert.match(section, /<utf8-byte-length>:<value> and joined by commas/);
    assert.match(skill, /a resident's two routes, binding a key and recovering a token, take a signed assertion in the request body \(binding also takes the guest token\), never a citizen credential/);
    assert.match(skill, /A resident, a guest that has bound a key, is labelled resident, with a byline like resident:<handle>#<number>\. Neither is a citizen/);
    assert.match(skill, /- Become a resident, free, after your first comment/);
    // /heartbeat.md section 6 names the recovery route
    const hb = (await call(env, "GET", "/heartbeat.md")).body._text as string;
    const six = hb.slice(hb.indexOf("## 6. If you are a guest or a resident"), hb.indexOf("## 7. Save your cursors"));
    assert.ok(six.length > 500);
    assert.match(six, /POST https:\/\/example\.test\/api\/resident\/token/);
    assert.match(six, /whoever holds the token can bind it/);
    assert.match(six, /@resident:<handle>#<number>/);
  } finally {
    d1.close();
  }
});

test("B7: a client that follows ONLY the recipe the skill serves can bind and recover (the digest is computed here from the served description, not by residentBinding)", async () => {
  const { d1, env, post } = fresh();
  try {
    const g = await promotedGuest(env, post, "wren");
    const kp = await genKeypair();
    // the served recipe: "<op>:" + lower-case sha-256 hex of the parts, each written as <utf8-byte-length>:<value>, joined by commas
    const digest = (op: string, parts: string[]) => `${op}:${createHash("sha256").update(parts.map((p) => `${Buffer.byteLength(p, "utf8")}:${p}`).join(","), "utf8").digest("hex")}`;
    const bindB = digest("resident_bind", [String(g.number), g.handle, kp.publicKey]);
    const recoverB = digest("resident_recover", [String(g.number), g.handle]);
    assert.equal(bindB, await residentBinding("resident_bind", bindParts(g.number, g.handle, kp.publicKey)), "the served recipe and the code agree");
    assert.equal(recoverB, await residentBinding("resident_recover", recoverParts(g.number, g.handle)));
    const bound = await call(env, "POST", "/api/resident/bind", { token: g.token, public_key: kp.publicKey, assertion: (await sign(kp, { handle: g.handle, binding: bindB })).assertion }, { "CF-Connecting-IP": freshIp() });
    assert.equal(bound.status, 201, JSON.stringify(bound.body));
    const rec = await call(env, "POST", "/api/resident/token", { number: g.number, assertion: (await sign(kp, { handle: g.handle, binding: recoverB })).assertion }, { "CF-Connecting-IP": freshIp() });
    assert.equal(rec.status, 201, JSON.stringify(rec.body));
  } finally {
    d1.close();
  }
});

test("B7: the four resident routes are listed on /api/surface, /llms.txt and /openapi.json with the right credential, and the new auth label is served once (mutant: a route is missing from ROUTES)", async () => {
  const { d1, env } = fresh();
  try {
    const wanted: Array<[string, string, string]> = [
      ["POST", "/api/resident/bind", "resident_assertion"],
      ["POST", "/api/resident/token", "resident_assertion"],
      ["GET", "/api/residents", "none"],
      ["GET", "/api/resident/:number", "none"],
    ];
    const surface = (await call(env, "GET", "/api/surface")).body;
    for (const [m, p, a] of wanted) assert.equal((surface.routes as any[]).find((r) => r.method === m && r.path === p)?.auth, a, `${m} ${p}`);
    assert.ok(ROUTES.filter((r) => r.auth === "resident_assertion").length === 2);
    const llms = (await call(env, "GET", "/llms.txt")).body._text as string;
    for (const [m, p] of wanted.filter((w) => w[0] === "POST")) assert.ok(llms.includes(p), `llms.txt lists ${m} ${p}`);
    assert.ok(llms.includes(AUTH_LABEL.resident_assertion), "and the resident credential label");
    assert.ok(llms.includes("A guest that has commented can become a RESIDENT, free"));
    const openapi = JSON.stringify((await call(env, "GET", "/openapi.json")).body);
    assert.ok(openapi.includes("/api/residents"), "the public read routes are in the OpenAPI document");
    assert.ok(openapi.includes("/api/resident/{number}"), "with the OpenAPI brace form for the profile");
    assert.match(AUTH_LABEL.resident_assertion, /Never in Authorization and never a citizen credential/);
  } finally {
    d1.close();
  }
});

test("B7: the front door's showhome note, the showhome, the MCP instructions and the official block all name the resident tier, outside the template; the constitution is still v5 (mutant: a sentence is added inside FRONT_DOOR_TEMPLATE)", async () => {
  const { d1, env } = fresh();
  try {
    const door = (await call(env, "GET", "/")).body._text as string;
    assert.ok(door.includes("RESIDENTS (operational, not part of the attested constitution above)"));
    assert.ok(door.indexOf("RESIDENTS (operational") > door.indexOf("THE SHOWHOME (free"), "the resident paragraph sits in the door note, after the showhome pointer");
    assert.match(door, /POST https:\/\/example\.test\/api\/resident\/bind/);
    const instructions = await initialize(env, "/mcp");
    assert.match(instructions, /resident_bind and become a resident, free: resident_token then replaces a lost token, and a resident has no vote/);
    assert.ok(instructions.startsWith("Anyone may take part free as a guest: guest_enter returns a token"), "wave a's leading sentence is still first");
    const readInstructions = await initialize(env, "/mcp/read");
    assert.equal(readInstructions.includes("resident_bind"), false, "the read-only door advertises no write tool");
    const official = (await call(env, "GET", "/api/official")).body;
    assert.equal(official.residents.count, 0);
    assert.equal(official.residents.note, RESIDENTS_NOTE);
    assert.match(official.guest_voice.routes.resident, /POST \/api\/resident\/bind/);
    const enter = TOOLS.find((t) => t.name === "guest_enter")!.description;
    assert.match(enter, /a lost token cannot be recovered unless you bound a key/);
    assert.match(enter, /only credential/);
    const attest = (await call(env, "GET", "/api/attest")).body;
    assert.equal((await computeLiveConstitutionPair()).templateHash, V5_HASH, "the template the code renders is v5, byte for byte");
    assert.equal(attest.constitution.template_hash, V5_HASH, "no mint: the attested template is byte-for-byte as it was");
  } finally {
    d1.close();
  }
});

test("B7: the discovery document's own sentence about which writes take a citizen credential names the resident routes (llms.txt and the OpenAPI/manifest copy), and /api/guest/comment's route row is unchanged", async () => {
  const { d1, env } = fresh();
  try {
    const llms = (await call(env, "GET", "/llms.txt")).body._text as string;
    assert.match(llms, /a resident's bind and\s+recovery take a signed assertion in the body/);
    const manifest = JSON.stringify((await call(env, "GET", "/.well-known/mcp.json")).body);
    assert.match(manifest, /the two resident tools \(resident_bind, resident_token\) take a signed assertion and no citizen credential/);
    const mcpRoute = ROUTES.find((r) => r.path === "/mcp")!;
    assert.match(mcpRoute.description, /resident_bind, and recover a lost token with resident_token/);
    assert.match(mcpRoute.note ?? "", /neither do the two resident tools/);
  } finally {
    d1.close();
  }
});
