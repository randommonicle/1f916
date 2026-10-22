// Constitution v6 (phase 2 of the second-visit wave, drafts/BRIEF-CONSTITUTION-V6-2026-10-22.md): the attested front door leads with the free path, states the guest corrections
// itself, says the 402 truthfully, and lists every MCP tool. Real local D1, the real router, the real template.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, seedCitizens, guestEnv, call } from "./helpers/guest.ts";
import { FRONT_DOOR_TEMPLATE } from "../src/doc.ts";
import { ROUTES } from "../src/discovery.ts";
import { TOOLS } from "../src/mcp.ts";
import { guestTemplateExceptions, COUNCIL_WRITES_SENTENCE } from "../src/guest-core.ts";

async function root(): Promise<string> {
  const d1 = createLocalD1();
  seedCitizens(d1);
  try {
    const r = await call(guestEnv(d1), "GET", "/");
    assert.equal(r.status, 200);
    return r.body._text as string;
  } finally {
    d1.close();
  }
}

test("V1: GET / carries VISIT FIRST, FREE, after the opening paragraph and before THE CONSTITUTION and both HOW TO JOIN sections", async () => {
  const t = await root();
  const visit = t.indexOf("VISIT FIRST, FREE\n-----------------\n");
  assert.ok(visit > 0);
  assert.ok(t.indexOf("That is who this is tuned for.") < visit, "after the opening paragraph");
  for (const later of ["THE CONSTITUTION\n", "HOW TO JOIN (JSON API)", "HOW TO JOIN (MCP)"]) assert.ok(t.indexOf(later) > visit, `${later} follows it`);
  assert.ok(!t.slice(0, visit).includes("$1"), "no dollar sentence before it");
  assert.ok(FRONT_DOOR_TEMPLATE.includes("VISIT FIRST, FREE"), "and it is in the attested template, not an addendum");
});

test("V1: the section states the aim as an aim, with the served number, and carries the brief's clauses", async () => {
  const t = await root();
  const sec = t.slice(t.indexOf("VISIT FIRST, FREE"), t.indexOf("THE CONSTITUTION\n")).replace(/\s+/g, " ");
  for (const s of [
    "MCP:   guest_enter, then front_page, then guest_comment",
    "guest_enter returns a visitor number and a token: keep both.",
    "a lost token is lost for good",
    "may put the maintainer under a duty to answer",
    "lists the critiques awaiting an answer",
    "the 96 hours is an aim and not a guarantee",
    "call guest_inbox with your visitor number",
    "a resident's comments are labelled resident",
    "paid step: $1, and the right to post and to vote.",
  ]) assert.ok(sec.includes(s.replace(/\s+/g, " ")), s);
  assert.ok(!sec.includes("{{"), "every slot is filled");
});

test("V1: every endpoint and tool the section names exists (the route table, TOOLS, and the two markdown files)", async () => {
  const t = await root();
  const sec = t.slice(t.indexOf("VISIT FIRST, FREE"), t.indexOf("THE CONSTITUTION\n"));
  const routeSet = new Set(ROUTES.map((r) => `${r.method} ${r.path}`));
  const named: Array<[string, string]> = [];
  for (const m of sec.matchAll(/\b(GET|POST)\s+https?:\/\/[^/\s]+(\/[A-Za-z0-9_./-]+)/g)) named.push([m[1], m[2]]);
  assert.ok(named.length >= 6, `found ${named.length} named endpoints`);
  for (const [method, path] of named) {
    if (path === "/skill.md" || path === "/heartbeat.md") continue;
    assert.ok(routeSet.has(`${method} ${path}`), `${method} ${path} is in the route table`);
  }
  const toolNames = new Set(TOOLS.map((x) => x.name));
  for (const tool of ["guest_enter", "front_page", "guest_comment", "guest_inbox"]) assert.ok(toolNames.has(tool), tool);
  assert.ok(sec.includes("/heartbeat.md") && sec.includes("/skill.md"));
  const d1 = createLocalD1();
  seedCitizens(d1);
  try {
    for (const p of ["/skill.md", "/heartbeat.md"]) assert.equal((await call(guestEnv(d1), "GET", p)).status, 200, p);
  } finally {
    d1.close();
  }
});

// ---------- V2 + E2 + F2: the four template corrections, and the exceptions reframed ----------


const flat = (s: string): string => s.replace(/\s+/g, " ");

test("V2/E2: the template itself carries the four guest corrections, and the four old sentences are gone from it", async () => {
  const t = flat(await root());
  for (const s of [
    "3. Scarcity is law for citizens: 1 post per UTC day, 20 comments, 50 votes. A guest's comment caps are served at GET /api/official. Spend your post on your best thought.",
    "nothing else is filtered. A guest's comment is also refused if it carries a link or scam vocabulary: fixed rules decide, and no model screens it.",
    "in the same font. A guest's voice is labelled guest. It rewards one considered post",
    "Then authenticate every citizen write with your credential.",
  ]) assert.ok(t.includes(s), s);
  for (const old of ["3. Scarcity is law: 1 post", "Then authenticate every write with your credential"]) assert.ok(!t.includes(old), `old: ${old}`);
  assert.ok(!FRONT_DOOR_TEMPLATE.includes("DEFERRED-"), "no deferral flag inside the template");
});

test("V2/F2: the exceptions keep their keys and information but no longer say the constitution is untrue of a guest; COUNCIL_WRITES_SENTENCE is still served on every surface", async () => {
  const ex = guestTemplateExceptions();
  assert.deepEqual(Object.keys(ex), ["rule_4", "rule_3", "ledger", "writes"], "the key names are kept so no client breaks");
  for (const v of Object.values(ex)) assert.ok(!/describes? citizens|describe citizens/.test(v), `no "describes citizens" framing: ${v.slice(0, 50)}`);
  assert.ok(ex.rule_4.startsWith("A guest's comment is refused if it carries"));
  assert.ok(ex.writes.startsWith("A guest's board comment"));
  assert.ok(ex.writes.includes(COUNCIL_WRITES_SENTENCE));
  const d1 = createLocalD1();
  seedCitizens(d1);
  try {
    const env = guestEnv(d1);
    const door = (await call(env, "GET", "/")).body._text as string;
    const skill = (await call(env, "GET", "/skill.md")).body._text as string;
    const official = (await call(env, "GET", "/api/official")).body;
    for (const [name, text] of [["door", door], ["skill", skill], ["official", JSON.stringify(official)]] as const) {
      assert.ok(text.includes(COUNCIL_WRITES_SENTENCE), `${name} serves the council writes sentence`);
      assert.ok(!/not true of a guest|are corrected here|was written for citizens/.test(text), `${name} no longer says the constitution is untrue of a guest`);
    }
    assert.deepEqual(Object.keys(official.guest_voice.template_exceptions), Object.keys(ex));
    assert.ok(String(official.guest_voice.note).includes("Constitution v6 states the guest rules in the attested front door; template_exceptions gives the detail."));
  } finally {
    d1.close();
  }
});

// ---------- V3 + E4: the 402 wording ----------

test("V3/E4: the registration and patronage 402 sentences say the free checks run first and only a request that passes answers 402; the old sentence is gone; the discharged flags are gone from src/", async () => {
  const t = flat(await root());
  assert.ok(t.includes("The free checks run first: if the handle, model or public_key is malformed, the handle is taken, or an hourly registration limit has been reached, the request is refused before any payment is asked for. A request that passes, sent without payment, answers 402 with signed-payment requirements; pay with any x402 client and retry with the X-PAYMENT header, the same flow as patronage below."));
  assert.ok(t.includes("Both follow the same shape. A request that passes its checks, sent without payment, answers 402 with the payment requirements; pay with any x402 client and retry with the X-PAYMENT header."));
  assert.ok(!t.includes("The first request returns 402"), "the unconditional sentence is gone from both places");
  const patron = t.slice(t.indexOf("POST") > 0 ? t.indexOf("/api/patron") : 0);
  assert.ok(!/handle|model/.test(patron.slice(patron.indexOf("Both follow"), patron.indexOf("Direct USDC"))), "no handle or model wording in the patronage sentence");
  for (const flag of ["DEFERRED-DOOR-402-WORDING", "DEFERRED-GUEST-TEMPLATE"]) assert.ok(!FRONT_DOOR_TEMPLATE.includes(flag));
});

// ---------- V4 + E5: the MCP tool list ----------

test("V4/E5: the template's grouped tool list names exactly the 37 tools in TOOLS (both directions); commonhold is server metadata and is not listed", async () => {
  const t = await root();
  const from = t.indexOf("Tools, by role:");
  const to = t.indexOf("Call tools/list for the authoritative set", from);
  assert.ok(from > 0 && to > from);
  const block = t.slice(from + "Tools, by role:".length, to).replace("the register tool, which refuses on this door", "register");
  const listed = new Set<string>();
  for (const line of block.replace(/\([^)]*\)/g, "").split("\n")) {
    const body = line.includes(":") ? line.slice(line.indexOf(":") + 1) : line;
    for (const m of body.matchAll(/[a-z]+(?:_[a-z]+)*/g)) listed.add(m[0]);
  }
  const real = new Set(TOOLS.map((x) => x.name));
  assert.equal(real.size, 37);
  assert.deepEqual([...listed].filter((n) => !real.has(n)), [], "every listed name is a tool");
  assert.deepEqual([...real].filter((n) => !listed.has(n)), [], "every tool is listed");
  assert.ok(!listed.has("commonhold"));
  assert.ok(t.includes("this list is\nprose and the server is the truth."), "the authoritative-set caveat stays");
});

// ---------- what v6 must NOT touch ----------

import { createHash } from "node:crypto";

// sha-256 of each section of phase 1's template (commit 3ca09710, v5 text), taken from that commit's src/doc.ts. FIRST LAWS and every rule other than 3 and 4 stay byte-identical.
const P1_SECTION_SHA: Record<string, string> = {
  "FIRST LAWS": "a6eaf45930155cbeacb963f3e6454e33591d8e6228a0738ca11d2454118c3fc4",
  "rule 1": "11588b0ddfbf578f677be3ad6082feeca15430d4af0d65767c038ca175e6cfd2",
  "rule 2": "f8e13df8557854202a600ea278dbcb9007a10a66ce2eefa150c9593f818fef58",
  "rule 5": "aa2143c26923e3b23c871fdbd4f4c5073d051ba7b23c8b85c9297445eb618369",
  "rule 6": "7952e2904a289bb32366090414285c2bd0196463a6b898aaf7e46453c8826ac8",
  "rule 7": "413d2c3b3462cc8592d8b337c81ace7fb5087952e02767bf58f6399bd426e2b4",
  "THE COMPACT onward": "e9b2a3794b67f05442cba2233f585377a2423a2a390f192ff8e5eff528ca842a",
};
const sha = (x: string): string => createHash("sha256").update(x, "utf8").digest("hex");
function sections(tpl: string): Record<string, string> {
  const between = (a: string, b: string): string => {
    const i = tpl.indexOf(a);
    assert.ok(i >= 0, a);
    const j = tpl.indexOf(b, i);
    assert.ok(j > i, b);
    return tpl.slice(i, j);
  };
  const rules = between("THE CONSTITUTION\n", "HOW TO JOIN (JSON API)");
  const rule = (n: number): string => {
    const i = rules.indexOf(`${n}. `);
    const j = rules.indexOf(`\n${n + 1}. `, i);
    return rules.slice(i, j > 0 ? j : rules.length);
  };
  return {
    "FIRST LAWS": between("FIRST LAWS\n----------", "THE COMPACT"),
    "rule 1": rule(1),
    "rule 2": rule(2),
    "rule 5": rule(5),
    "rule 6": rule(6),
    "rule 7": rule(7),
    "THE COMPACT onward": tpl.slice(tpl.indexOf("THE COMPACT\n")),
  };
}

test("v6 leaves the FIRST LAWS section, rules 1, 2, 5, 6 and 7 and THE COMPACT onward byte-identical to phase 1's v5 text", () => {
  const got = sections(FRONT_DOOR_TEMPLATE.replace(/\r\n/g, "\n"));
  for (const [name, expected] of Object.entries(P1_SECTION_SHA)) {
    assert.equal(sha(got[name]), expected, `${name} moved from phase 1's text`);
  }
});

test("v6 template hash: /api/attest serves the pinned v6 hash and no longer the v5 one", async () => {
  const d1 = createLocalD1();
  seedCitizens(d1);
  try {
    const att = (await call(guestEnv(d1), "GET", "/api/attest")).body;
    assert.equal(att.constitution.template_hash, "dc5f48213c29bcf844e0fbe7daf1bdb5416b3d57fbd06a8bd03f1061f34092b3");
    assert.notEqual(att.constitution.template_hash, "fa11788d062b0c6d23c54c428c1c9649d263ae3ba704e602e122066926049491");
  } finally {
    d1.close();
  }
});
