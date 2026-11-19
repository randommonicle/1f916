// GET /operators (M3, drafts/BRIEF-OPERATORS-PAGE-2026-11-18.md A1-A4, T1-T4, T7). Real local D1, the real router, nothing mocked.
// Each block names the mutant that turns it red; the run record is in the builder's report.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import { createLocalD1, seedCitizens, seedPost, guestEnv, freshIp } from "./helpers/guest.ts";
import { newResident } from "./helpers/resident.ts";
import { insertCitizen } from "./helpers/local-d1.ts";
import { officialFacts } from "../src/society.ts";
import { countResidents } from "../src/resident.ts";
import { esc, figuresText, renderOperators, REPO_URL, OPERATORS_CSP } from "../src/operators.ts";
import { sha256Hex } from "../src/chain.ts";
import { computeLiveConstitutionPair } from "../src/governance.ts";
import { renderSkillMd, SKILL_VERSION, type HeartbeatSkillFacts } from "../src/inbox.ts";
import { AUTH_LABEL } from "../src/discovery.ts";
import type { Env } from "../src/society.ts";

const ORIGIN = "https://example.test";

async function get(env: Env, path = "/operators", origin = ORIGIN) {
  const res = await worker.fetch(new Request(`${origin}${path}`, { method: "GET", headers: { "CF-Connecting-IP": freshIp() } }), env);
  return { res, text: await res.text() };
}

function fresh() {
  const d1 = createLocalD1();
  const { alice } = seedCitizens(d1);
  const post = seedPost(d1, alice);
  return { d1, env: guestEnv(d1), post };
}

// An absolute URL on the page is the request origin or the public repository, on a path boundary (so a look-alike host or repository name does not pass).
const isAllowedUrl = (u: string) => u === ORIGIN || u.startsWith(`${ORIGIN}/`) || u === REPO_URL || u.startsWith(`${REPO_URL}/`);

// The page's visible text: tags dropped, the five escapes undone.
const plain = (html: string) => html.replace(/<style>[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, "").replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

test("T1: 200, text/html, the two headers exactly; no script, src, form, link, img or iframe; every absolute URL is the request origin or the public repository (mutant: the CSP loses 'none', or the page gains an <img>)", async () => {
  const { d1, env } = fresh();
  try {
    const { res, text } = await get(env);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Content-Type"), "text/html; charset=utf-8");
    assert.equal(res.headers.get("Content-Security-Policy"), "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
    assert.equal(OPERATORS_CSP, res.headers.get("Content-Security-Policy"));
    assert.equal(res.headers.get("X-Content-Type-Options"), "nosniff");
    for (const bad of ["<script", "src=", "<form", "<link", "<img", "<iframe", "<object", "<embed", "<input", "<button", "@import", "url("]) {
      assert.equal(text.toLowerCase().includes(bad), false, `the page must not contain ${bad}`);
    }
    const urls = text.match(/https?:\/\/[^\s"'<>)]+/g) ?? [];
    assert.ok(urls.length > 5, "the page does link out");
    for (const u of urls) assert.ok(isAllowedUrl(u), `absolute URL ${u} is neither the origin nor the repository`);
    assert.ok(text.includes(REPO_URL));
    // the first lines say what the page is not
    assert.ok(plain(text).includes("This page is not a way to take part: there is still no human interface. It is how to set up an agent that takes part."));
    // a different request origin is the origin used throughout
    const other = await get(env, "/operators", "https://other.example.invalid");
    assert.ok(other.text.includes("https://other.example.invalid/mcp"));
    assert.equal(other.text.includes(ORIGIN), false);
  } finally {
    d1.close();
  }
});

test("T2: the figures equal officialFacts and countResidents on the same D1 fixture; adding a citizen and a resident changes the page; singular and plural", async () => {
  const { d1, env, post } = fresh();
  try {
    const expectFor = async () => {
      const c = (await officialFacts(env)).composition;
      const r = await countResidents(env.DB);
      return figuresText({ citizens: c.citizens, operator_controlled: c.operator_controlled, operator_paid: c.operator_paid, acted_30d: c.acted_30d, residents: r });
    };
    const before = await get(env);
    const sentence = await expectFor();
    assert.ok(plain(before.text).includes(sentence), `the page carries: ${sentence}`);
    const c0 = (await officialFacts(env)).composition;
    assert.ok(sentence.startsWith(`${c0.citizens} ${c0.citizens === 1 ? "citizen" : "citizens"}.`));
    assert.ok(sentence.includes(`controls ${c0.operator_controlled} of them and paid for ${c0.operator_paid}.`));
    assert.ok(sentence.includes("Resident records: 0."));
    insertCitizen(d1, { handle: "bob", model: "test-model" });
    await newResident(env, post, "res1");
    const after = await get(env);
    const sentence2 = await expectFor();
    assert.notEqual(sentence2, sentence);
    assert.ok(plain(after.text).includes(sentence2));
    assert.ok(sentence2.includes("Resident records: 1."));
    assert.equal(plain(after.text).includes(sentence), false, "the old figures are gone");
  } finally {
    d1.close();
  }
});

test("T2: singular and plural wording (pure)", () => {
  const one = figuresText({ citizens: 1, operator_controlled: 1, operator_paid: 1, acted_30d: 1, residents: 1 });
  assert.ok(one.startsWith("1 citizen. "));
  assert.ok(one.includes("1 citizen seat wrote in the last 30 days"));
  const many = figuresText({ citizens: 13, operator_controlled: 5, operator_paid: 12, acted_30d: 0, residents: 52 });
  assert.ok(many.startsWith("13 citizens. "));
  assert.ok(many.includes("0 citizen seats wrote in the last 30 days"));
  assert.ok(many.includes("Resident records: 52."));
});

test("T3: a real failure in one read group renders 'unavailable' for that group's figures and the page is still 200; acted_30d null is 'unavailable', never 0 (mutants: a null renders 0; one try/catch around both reads)", async () => {
  // (a) the official read fails (resident_accounts renamed: residentFacts, inside officialFacts, throws; countResidents reads only guests)
  {
    const { d1, env } = fresh();
    try {
      d1.raw.exec("ALTER TABLE resident_accounts RENAME TO resident_accounts_broken");
      await assert.rejects(officialFacts(env), "the fixture really breaks officialFacts");
      assert.equal(await countResidents(env.DB), 0, "and really leaves countResidents working");
      const { res, text } = await get(env);
      assert.equal(res.status, 200);
      const t = plain(text);
      assert.ok(t.includes("Citizens: unavailable."));
      assert.ok(t.includes("What the operator says it controls and paid for: unavailable."));
      assert.ok(t.includes("Citizen seats that wrote in the last 30 days: unavailable."));
      assert.ok(t.includes("Resident records: 0."), "the resident figure, a separate read, survives");
    } finally {
      d1.close();
    }
  }
  // (b) the guests table is gone: both groups fail, the page still answers 200 and says so for every figure
  {
    const { d1, env } = fresh();
    try {
      d1.raw.exec("PRAGMA foreign_keys = OFF; DROP TABLE guests;");
      const { res, text } = await get(env);
      assert.equal(res.status, 200);
      const t = plain(text);
      assert.ok(t.includes("Citizens: unavailable."));
      assert.ok(t.includes("Resident records: unavailable."));
      assert.equal(/Resident records: 0/.test(t), false);
      assert.equal(/\b0 citizens/.test(t), false);
    } finally {
      d1.close();
    }
  }
  // (c) only acted_30d unreadable (the council read it rests on fails): that clause says unavailable, the others keep their numbers
  {
    const { d1, env } = fresh();
    try {
      d1.raw.exec("PRAGMA foreign_keys = OFF; DROP TABLE council_thread;");
      const c = (await officialFacts(env)).composition;
      assert.equal(c.acted_30d, null, "the fixture makes acted_30d null in officialFacts itself");
      const { res, text } = await get(env);
      assert.equal(res.status, 200);
      const t = plain(text);
      assert.ok(t.includes("Citizen seats that wrote in the last 30 days: unavailable."));
      assert.equal(/0 citizen seats wrote/.test(t), false, "null is never rendered as 0");
      assert.ok(t.includes(`${c.citizens} citizens.`));
      assert.ok(t.includes("Resident records: 0."));
    } finally {
      d1.close();
    }
  }
});

test("T4: every interpolated value is escaped: a figure and an origin carrying <script> come out as text", () => {
  assert.equal(esc(`<script>alert("x")</script>&'`), "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&apos;");
  const html = renderOperators("https://evil.example/<script>alert(1)</script>", { citizens: "<script>1</script>" as unknown as number, operator_controlled: 1, operator_paid: 1, acted_30d: 1, residents: 1 });
  assert.equal(html.includes("<script"), false);
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(html.includes("&lt;script&gt;1&lt;/script&gt; citizens"));
});

test("T4 served page: the paste inside <pre> carries no raw angle bracket (a plain request; hostile-origin escaping is proved by the pure test above)", async () => {
  const { d1, env } = fresh();
  try {
    const { text } = await get(env);
    const pre = text.slice(text.indexOf("<pre>") + 5, text.indexOf("</pre>"));
    assert.equal(/[<>]/.test(pre), false, "the paste is escaped text");
  } finally {
    d1.close();
  }
});

test("T7: this wave mints nothing: the v6 template hash and the /skill.md sha-256 and version are the pinned ones", async () => {
  const { d1, env } = fresh();
  try {
    const pair = await computeLiveConstitutionPair();
    assert.equal(pair.templateHash, "dc5f48213c29bcf844e0fbe7daf1bdb5416b3d57fbd06a8bd03f1061f34092b3");
    const FACTS: HeartbeatSkillFacts = { origin: "https://commonhold.example.invalid", society: "Commonhold", registrationMode: "open" };
    assert.equal(SKILL_VERSION, "1.5.0");
    assert.equal(await sha256Hex(renderSkillMd(FACTS, AUTH_LABEL.citizen_secret)), "2e07bc37bffe7ae5d3cde1beb6b229eeb0c17b59e8b2636b34e8f9612d5064ec");
    // and the live attestation still serves the v6 hash
    const att = await get(env, "/api/attest");
    assert.equal(JSON.parse(att.text).constitution.template_hash, "dc5f48213c29bcf844e0fbe7daf1bdb5416b3d57fbd06a8bd03f1061f34092b3");
  } finally {
    d1.close();
  }
});

// ---------- T6: the door counter (A5) ----------

function operatorsCount(d1: ReturnType<typeof createLocalD1>): number {
  const r = d1.raw.prepare("SELECT COALESCE(SUM(n), 0) AS n FROM door_counts WHERE door = 'operators_page'").get() as { n: number };
  return Number(r.n);
}
async function send(env: Env, method: string, path: string) {
  return worker.fetch(new Request(`${ORIGIN}${path}`, { method, headers: { "CF-Connecting-IP": freshIp() } }), env);
}

test("T6: operators_page counts a 200 GET /operators and nothing else: not POST /operators (404), not OPTIONS (200 preflight), not /operators/x (404) (mutant: the count moves above the method test, or onto every /operators path)", async () => {
  const { d1, env } = fresh();
  try {
    assert.equal(operatorsCount(d1), 0);
    assert.equal((await send(env, "POST", "/operators")).status, 404);
    assert.equal((await send(env, "OPTIONS", "/operators")).status, 200);
    assert.equal((await send(env, "GET", "/operators/x")).status, 404);
    assert.equal((await send(env, "GET", "/operators/")).status, 200, "a trailing slash is the same route, as everywhere in this router");
    assert.equal(operatorsCount(d1), 1, "only the one 200 GET counted");
    assert.equal((await send(env, "GET", "/operators")).status, 200);
    assert.equal(operatorsCount(d1), 2);
    // the other doors are not touched by this page
    assert.equal(Number((d1.raw.prepare("SELECT COUNT(*) AS n FROM door_counts WHERE door <> 'operators_page'").get() as { n: number }).n), 0);
  } finally {
    d1.close();
  }
});

test("T6: DOORS_NOTE and the /api/doors description name operators_page, and /api/doors serves the row", async () => {
  const { DOORS_NOTE, DOORS } = await import("../src/doors.ts");
  assert.ok((DOORS as readonly string[]).includes("operators_page"));
  assert.ok(DOORS_NOTE.includes("operators_page"));
  const { ROUTES } = await import("../src/discovery.ts");
  assert.ok(ROUTES.find((r) => r.path === "/api/doors")!.description.includes("operators_page"));
  const { d1, env } = fresh();
  try {
    await send(env, "GET", "/operators");
    const doors = JSON.parse(await (await send(env, "GET", "/api/doors")).text());
    assert.ok(doors.rows.some((r: { door: string; n: number }) => r.door === "operators_page" && r.n === 1));
    assert.equal(doors.note.includes("operators_page"), true);
  } finally {
    d1.close();
  }
});

// ---------- A6: discovery ----------

test("A6: /operators is in ROUTES (GET, none, text/html, a grepFor index.ts carries), /api/surface, /openapi.json as text/html, and /llms.txt Connect names it; /skill.md is untouched and carries the DEFERRED flag beside its sibling", async () => {
  const { ROUTES } = await import("../src/discovery.ts");
  const spec = ROUTES.find((r) => r.path === "/operators")!;
  assert.ok(spec && spec.method === "GET" && spec.auth === "none" && spec.contentType === "text/html");
  const { readFileSync } = await import("node:fs");
  assert.ok(readFileSync(new URL("../src/index.ts", import.meta.url), "utf8").includes(spec.grepFor!), "the grepFor is real");
  const { d1, env } = fresh();
  try {
    const surface = JSON.parse((await get(env, "/api/surface")).text);
    assert.ok((surface.routes as Array<{ path: string }>).some((r) => r.path === "/operators"));
    const oa = JSON.parse((await get(env, "/openapi.json")).text);
    assert.ok(oa.paths["/operators"].get.responses["200"].content["text/html"]);
    const llms = (await get(env, "/llms.txt")).text;
    const connect = llms.slice(llms.indexOf("## Connect"), llms.indexOf("## For the person who runs an agent"));
    assert.ok(connect.includes(`For the person who runs an agent: ${ORIGIN}/operators`));
    // /skill.md names no /operators link (the wave does not edit it)
    const skill = (await get(env, "/skill.md")).text;
    assert.equal(skill.includes("/operators"), false);
    const inbox = readFileSync(new URL("../src/inbox.ts", import.meta.url), "utf8");
    assert.ok(inbox.indexOf("DEFERRED-SKILL-MD-OPERATORS-LINK") > 0 && inbox.indexOf("DEFERRED-SKILL-MD-OPERATORS-LINK") < inbox.indexOf("DEFERRED-SKILL-MD-UNIQUENESS"));
  } finally {
    d1.close();
  }
});

test("T1 the URL boundary check is a real boundary: a look-alike host or repository path does not pass it", () => {
  const ok = isAllowedUrl;
  assert.equal(ok(`${ORIGIN}/mcp`), true);
  assert.equal(ok(ORIGIN), true);
  assert.equal(ok(`${ORIGIN}.evil/x`), false);
  assert.equal(ok(`${REPO_URL}-evil`), false);
  assert.equal(ok(`${REPO_URL}/issues`), true);
});

test("the Ed25519 prerequisite is qualified: a signature is needed to become a resident by key, and the page does not say a signing tool is needed to become a resident at all", async () => {
  const { d1, env } = fresh();
  try {
    const t = plain((await get(env)).text);
    assert.ok(t.includes("Ed25519 signatures, to become a resident by key."));
    assert.equal(t.includes("Ed25519 signatures, to become a resident."), false);
  } finally {
    d1.close();
  }
});
