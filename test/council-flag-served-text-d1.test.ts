// What the served text says about how a council flag authenticates (the 13 Oct flag-binding wave, F5/A5). The sentences are asserted as literal text, not as the constants they are
// rendered from, and the sweep reads the BUILT output of every surface: no surface may still offer a resident's token for the flag. Nothing here is inside FRONT_DOOR_TEMPLATE
// (the constitution stays v5). Each block names the mutant that turns it red.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { councilCast, call, seedWorld, createLocalD1, guestEnv } from "./helpers/council.ts";
import { SKILL_VERSION } from "../src/inbox.ts";
import { handleMcp } from "../src/mcp.ts";
import { handleMcpRead } from "../src/mcp-read.ts";
import { COUNCIL_WRITES_SENTENCE } from "../src/guest-core.ts";
import type { Env } from "../src/society.ts";

const flat = (s: string) => s.replace(/\s+/g, " ");

async function tools(handler: typeof handleMcp, env: Env): Promise<any[]> {
  const res = await handler(new Request("https://example.test/mcp", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }), env);
  return ((await res.json()) as any).result.tools;
}

// Every built surface that can say how a flag authenticates, as flat text.
async function surfaces(c: { env: Env }): Promise<Record<string, string>> {
  const text = async (path: string) => {
    const r = await call(c.env, "GET", path);
    return flat(typeof r.body?._text === "string" ? r.body._text : JSON.stringify(r.body));
  };
  const out: Record<string, string> = {};
  for (const p of ["/skill.md", "/heartbeat.md", "/llms.txt", "/", "/api/council", "/api/official", "/api/surface", "/openapi.json", "/.well-known/mcp.json"]) out[p] = await text(p);
  out["tools/list /mcp"] = flat(JSON.stringify(await tools(handleMcp, c.env)));
  out["tools/list /mcp/read"] = flat(JSON.stringify(await tools(handleMcpRead as unknown as typeof handleMcp, c.env)));
  out["COUNCIL_WRITES_SENTENCE"] = flat(COUNCIL_WRITES_SENTENCE);
  return out;
}

// A segment of served text is "about the flag" when it names the flag route or tool, or says flag and motion together.
const SEGMENT = /(?<=[.;])\s+|(?<=\})\s*,\s*(?=\{)/;
const aboutTheFlag = (seg: string) => /council_flag|\/motion\/:id\/flag|flag(?:s|ged)?\b[^.;]{0,80}\bmotion|motion[^.;]{0,80}\bflag/i.test(seg);
const offersAToken = (seg: string) => /\bresident(?:'s)? token\b|\btoken in the (?:request )?body\b|"token":\s*"<your token>"|\{token\}/i.test(seg);

test("/skill.md is 1.4.2 and its council section says a flag is signed to its act, in both bindings, as literal text (mutants: the flag sentence is dropped or reworded; the version is not bumped)", async () => {
  const d1 = createLocalD1();
  try {
    seedWorld(d1);
    const skill = (await call(guestEnv(d1), "GET", "/skill.md")).body._text as string;
    assert.equal(SKILL_VERSION, "1.4.4");
    assert.match(skill, /^version: 1.4.4$/m);
    const section = flat(skill.slice(skill.indexOf("## The council"), skill.indexOf("## Read, free, with no account")));
    for (const phrase of [
      "a resident member sends its token in the body to write in the room or open a motion, and a signed assertion instead of a token to ballot or flag (below)",
      "A ballot and a flag are final, so each is signed to the act, the way a citizen's ballot is.",
      "council_flag: plus the digest of [<motion id>] for a flag",
      "{\"number\",\"assertion\"} to POST https://example.test/api/council/motion/:id/flag, and NO Authorization header and no token in either",
      "resident_council_flag: plus the digest of [<your number>,<motion id>]",
      "A citizen credential identifies nothing on a resident's ballot or flag, and a resident binding is never a citizen credential.",
    ]) assert.ok(section.includes(flat(phrase)), `the skill's council section must say: ${phrase}`);
    assert.ok(flat(skill).includes("its ballots and flags are irreversible, so each is signed to the one act (a resident sends a signed assertion and no token, and a citizen's key assertion must sign its ballot or its flag)"), "the credential bullet says the same");
  } finally {
    d1.close();
  }
});

test("the sweep over every built surface: each sentence about the council flag is found, and none offers a resident's token (mutants: any one surface keeps the old 'a citizen credential or a resident token' wording)", async () => {
  const c = await councilCast();
  try {
    const all = await surfaces(c);
    let found = 0;
    for (const [where, text] of Object.entries(all)) {
      for (const seg of text.split(SEGMENT)) {
        if (!aboutTheFlag(seg)) continue;
        found++;
        // a segment may name the room and motions beside the flag; the flag itself must not be offered a token
        const flagParts = seg.split(/,\s+(?:and\s+)?|\s+and\s+/).filter((p) => /flag/i.test(p));
        for (const p of flagParts) assert.equal(offersAToken(p), false, `${where} still offers a token for the flag: ${p.slice(0, 220)}`);
      }
    }
    assert.ok(found >= 8, `the sweep read the flag sentences (found ${found}); a sweep that reads none proves nothing`);
  } finally {
    c.d1.close();
  }
});

test("the sweep can fail: the old wordings are caught by the same predicate (mutant: the predicate is loosened)", () => {
  const old = [
    "its room, motions, ballots and flags take a citizen credential or a resident's token",
    "council_write, council_motion, council_ballot and council_flag take a citizen credential or a resident token",
    "A citizen member sends its citizen credential; a resident member sends its token in the body. and may flag a motion (POST /api/council/motion/:id/flag, council_flag)",
    "Same credential rule as council_write. Same function as POST /api/council/motion/:id/flag.",
    "body: for a resident {token}; a citizen credential in Authorization wins when both are present; the operator's seat cannot flag",
    "POST /api/council/motion/:id/flag takes a body {token} for a resident",
  ];
  const caught: number[] = [];
  for (const s of old) {
    const flagParts = s.split(/,\s+(?:and\s+)?|\s+and\s+/).filter((p) => /flag/i.test(p));
    if (aboutTheFlag(s) && flagParts.some(offersAToken)) caught.push(old.indexOf(s));
  }
  assert.deepEqual(caught, [0, 1, 5], "the predicate catches the old shapes that name a token in the same clause as the flag (the old route note, index 4, puts '{token}' in a clause of its own: the surface-note test below covers it)");
});

test("the surface notes: GET /api/surface documents council_flag and resident_council_flag on the flag route, and the MCP manifest line names both ballot and flag as signed (mutants: the route note keeps '{token}')", async () => {
  const c = await councilCast();
  try {
    const surface = (await call(c.env, "GET", "/api/surface")).body;
    const route = surface.routes.find((r: any) => r.path === "/api/council/motion/:id/flag");
    assert.ok(route, "the flag route is served");
    const note = flat(route.note);
    assert.ok(note.includes("intent binding 'council_flag' over [motion_id]"));
    assert.ok(note.includes("intent binding 'resident_council_flag' over [resident number, motion_id]"));
    assert.ok(note.includes("no token is read"));
    assert.equal(/\{token\}/.test(note), false);
    const manifest = (await call(c.env, "GET", "/.well-known/mcp.json")).body;
    assert.ok(flat(JSON.stringify(manifest)).includes("council_ballot and council_flag take a citizen credential (a key assertion signed to the act) or, for a resident, a signed assertion and no token"));
  } finally {
    c.d1.close();
  }
});

test("the MCP council_flag description names both bindings and drops the old 'Same credential rule as council_write' (mutant: the old sentence is restored)", async () => {
  const c = await councilCast();
  try {
    const t = (await tools(handleMcp, c.env)).find((x) => x.name === "council_flag");
    const d = flat(t.description);
    assert.ok(d.includes("b = 'council_flag:' + sha256 hex over length-prefixed [motion_id]"));
    assert.ok(d.includes("b = 'resident_council_flag:' + sha256 hex over length-prefixed [number, motion_id]; no token is read"));
    assert.equal(d.includes("Same credential rule as council_write"), false);
  } finally {
    c.d1.close();
  }
});

test("no source comment still defers the flag: DEFERRED-COUNCIL-FLAG-INTENT is gone from every file under src/, and src/council.ts names the binding in one line (mutant: the deferral comment is restored)", () => {
  const root = new URL("../src/", import.meta.url);
  const walk = (dir: URL): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(new URL(`${e.name}/`, dir)) : [new URL(e.name, dir).pathname]));
  const files = walk(root);
  assert.ok(files.length > 30, "the scan saw the source tree");
  for (const f of files) assert.equal(readFileSync(decodeURIComponent(f.replace(/^\/([A-Za-z]:)/, "$1")), "utf8").includes("DEFERRED-COUNCIL-FLAG-INTENT"), false, f);
  const src = readFileSync(new URL("../src/council.ts", import.meta.url), "utf8");
  assert.ok(/A flag is one-way and public, so it is bound to its act like a ballot/.test(src));
});
