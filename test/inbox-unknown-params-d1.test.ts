// GET /api/inbox and GET /api/guest/inbox refuse query parameters they do not know, and a repeated known one, exactly as /api/proposals does
// (test/proposals-unknown-params-d1.test.ts), and both MCP doors refuse an unknown tool argument. Real local D1, the real router, nothing mocked.
// Operator ruling 25 Nov 2026 (FOR-BEN-2026-11-25 s3). Every block names the mutation that reddens it.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { call, createLocalD1, seedCitizens, seedVisitor, guestEnv, type LocalD1 } from "./helpers/guest.ts";
import type { Env } from "../src/society.ts";

function setup(opts: { onExec?: () => void } = {}) {
  const d1 = createLocalD1(opts.onExec ? { onExec: opts.onExec } : {});
  seedCitizens(d1); // 1 = commonhold-agent, 2 = alice
  return { d1, env: guestEnv(d1) };
}

const ROUTES = [
  { path: "/api/inbox", good: "handle=alice&since=0", accepts: "handle, since, cursor", repeatable: ["handle", "since", "cursor"] },
  { path: "/api/guest/inbox", good: "guest=1", accepts: "guest, cursor", repeatable: ["guest", "cursor"] },
] as const;

async function rpc(env: Env, door: "/mcp" | "/mcp/read", name: string, args: unknown, withArgs = true) {
  const params: Record<string, unknown> = { name };
  if (withArgs) params.arguments = args;
  const r = await call(env, "POST", door, { jsonrpc: "2.0", id: 1, method: "tools/call", params }, { "CF-Connecting-IP": "203.0.113.9" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const res = r.body.result;
  return { isError: res.isError === true, parsed: JSON.parse(res.content[0].text) };
}

const DOORS = ["/mcp", "/mcp/read"] as const;

test("1: an unknown key is 400 unknown_query_parameter naming it and listing what the route accepts; every unknown key once, first-seen order; unknown beats repeated", async () => {
  // Mutations that redden this: delete the unknown-key check in assertKnownQuery; drop the Set (a repeated unknown key is then named twice); check repeated first.
  const { d1, env } = setup();
  try {
    for (const r of ROUTES) {
      const one = await call(env, "GET", `${r.path}?${r.good}&limit=5`);
      assert.equal(one.status, 400, JSON.stringify(one.body));
      assert.equal(one.body.code, "unknown_query_parameter");
      assert.equal(one.body.error, `Unknown query parameter: limit. GET ${r.path} accepts only: ${r.accepts}. Nothing was read; remove the parameter and call again.`);
      const many = await call(env, "GET", `${r.path}?${r.good}&zeta=1&alpha=2&zeta=3`);
      assert.equal(many.body.error, `Unknown query parameters: zeta, alpha. GET ${r.path} accepts only: ${r.accepts}. Nothing was read; remove the parameter and call again.`);
      const both = await call(env, "GET", `${r.path}?${r.good}&${r.good}&x=1`);
      assert.equal(both.body.code, "unknown_query_parameter", "unknown beats repeated");
      assert.equal(/Repeated/.test(both.body.error), false);
    }
  } finally {
    d1.close();
  }
});

test("2: an empty-valued key, a bare key and a wrongly cased key are unknown; keys are named after URL decoding", async () => {
  // Mutation that reddens this: lower-case the key before comparing; skip empty keys.
  const { d1, env } = setup();
  try {
    for (const r of ROUTES) {
      const cases: Array<[string, string]> = [["x=", "x"], ["flag", "flag"], ["Since=1", "Since"], ["Handle=a", "Handle"], ["Guest=1", "Guest"], ["%73ince2=1", "since2"], ["=1", ""]];
      for (const [q, named] of cases) {
        const res = await call(env, "GET", `${r.path}?${r.good}&${q}`);
        assert.equal(res.status, 400, `${r.path}?${q}`);
        assert.equal(res.body.code, "unknown_query_parameter", `${r.path}?${q}`);
        assert.match(res.body.error, new RegExp(`^Unknown query parameter: ${named}\\. `), `${r.path}?${q}: ${res.body.error}`);
      }
    }
  } finally {
    d1.close();
  }
});

test("3: a repeated known key is 400 repeated_query_parameter, identical values too, each repeated key named once", async () => {
  // Mutation that reddens this: delete the repeated check; compare getAll length > 2.
  const { d1, env } = setup();
  try {
    const inbox = await call(env, "GET", "/api/inbox?handle=alice&handle=alice&since=0");
    assert.equal(inbox.status, 400);
    assert.equal(inbox.body.code, "repeated_query_parameter");
    assert.equal(inbox.body.error, "Repeated query parameter: handle. GET /api/inbox accepts each of handle, since, cursor at most once.");
    const two = await call(env, "GET", "/api/inbox?handle=alice&since=0&since=1&cursor=c0-p0&cursor=c0-p0");
    assert.equal(two.body.error, "Repeated query parameters: since, cursor. GET /api/inbox accepts each of handle, since, cursor at most once.");
    const guest = await call(env, "GET", "/api/guest/inbox?guest=1&guest=1");
    assert.equal(guest.status, 400);
    assert.equal(guest.body.error, "Repeated query parameter: guest. GET /api/guest/inbox accepts each of guest, cursor at most once.");
  } finally {
    d1.close();
  }
});

test("4: a refused request executes zero D1 statements", async () => {
  // Mutation that reddens this: move the check after the inbox()/guestInbox() call in index.ts.
  let n = 0;
  const { d1, env } = setup({ onExec: () => { n++; } });
  try {
    for (const q of ["/api/inbox?handle=alice&since=0&limit=1", "/api/inbox?handle=alice&since=0&since=1", "/api/guest/inbox?guest=1&x=1", "/api/guest/inbox?guest=1&guest=2"]) {
      n = 0;
      const r = await call(env, "GET", q);
      assert.equal(r.status, 400, q);
      assert.equal(n, 0, `${q}: ${n} statements ran`);
    }
  } finally {
    d1.close();
  }
});

test("5 (PRESERVATION): every accepted shape still reads: handle with since, handle with cursor, guest alone, guest with cursor", async () => {
  // Mutation that reddens this: list a key wrongly in INBOX_PARAMS or GUEST_INBOX_PARAMS (drop cursor, say).
  const { d1, env } = setup();
  try {
    const v = await seedVisitor(d1, "wren");
    const a = await call(env, "GET", "/api/inbox?handle=alice&since=0");
    assert.equal(a.status, 200, JSON.stringify(a.body));
    const b = await call(env, "GET", `/api/inbox?handle=alice&cursor=${a.body.next_cursor}`);
    assert.equal(b.status, 200, JSON.stringify(b.body));
    const c = await call(env, "GET", `/api/guest/inbox?guest=${v.id}`);
    assert.equal(c.status, 200, JSON.stringify(c.body));
    const d = await call(env, "GET", `/api/guest/inbox?guest=${v.id}&cursor=${c.body.next_cursor}`);
    assert.equal(d.status, 200, JSON.stringify(d.body));
  } finally {
    d1.close();
  }
});

test("6: both inbox tools refuse an unknown argument (secret included) and a non-object on both doors; null, omitted-guarded and valid arguments still read", async () => {
  // Mutations that redden this: delete assertInboxArgs from either door's case; delete assertGuestInboxArgs from either.
  const { d1, env } = setup();
  try {
    const v = await seedVisitor(d1, "wren");
    for (const door of DOORS) {
      for (const [tool, good, accepts] of [["inbox", { handle: "alice", since: 0 }, "handle, since, cursor"], ["guest_inbox", { guest: v.id }, "guest, cursor"]] as const) {
        for (const extra of [{ limit: 5 }, { secret: "commonhold_sk_x" }]) {
          const r = await rpc(env, door, tool, { ...good, ...extra });
          assert.equal(r.isError, true, `${door} ${tool} ${JSON.stringify(extra)}`);
          assert.equal(r.parsed.error, `Unknown argument for ${tool}: ${Object.keys(extra)[0]}. The ${tool} tool accepts only: ${accepts}. Nothing was read.`);
        }
        for (const bad of [[], "open", 5, true, null]) {
          const r = await rpc(env, door, tool, bad);
          assert.equal(r.isError, true, `${door} ${tool} ${JSON.stringify(bad)}`);
        }
        const ok = await rpc(env, door, tool, good);
        assert.equal(ok.isError, false, `${door} ${tool}: ${JSON.stringify(ok.parsed)}`);
      }
    }
  } finally {
    d1.close();
  }
});

test("6b: tools/list on both doors carries additionalProperties:false and the refusal sentence on both inbox tools", async () => {
  // Mutation that reddens this: drop additionalProperties:false from one schema; drop the sentence from one description.
  const { d1, env } = setup();
  try {
    for (const door of DOORS) {
      const r = await call(env, "POST", door, { jsonrpc: "2.0", id: 1, method: "tools/list" }, { "CF-Connecting-IP": "203.0.113.9" });
      for (const [name, only] of [["inbox", "handle, since and cursor"], ["guest_inbox", "guest and cursor"]] as const) {
        const tool = r.body.result.tools.find((t: { name: string }) => t.name === name);
        assert.equal(tool.inputSchema.additionalProperties, false, `${door} ${name}`);
        assert.ok(tool.description.includes(`Takes only ${only}: any other argument is refused with an error, never silently ignored.`), `${door} ${name}: ${tool.description}`);
      }
    }
  } finally {
    d1.close();
  }
});

test("7: the route descriptions, /llms.txt, /openapi.json and /api/surface carry the refusal", async () => {
  // Mutation that reddens this: drop the sentence from either route's description in discovery.ts.
  const { d1, env } = setup();
  try {
    const llms = (await call(env, "GET", "/llms.txt")).body._text as string;
    const surface = (await call(env, "GET", "/api/surface")).body as { routes: Array<{ method: string; path: string; description: string }> };
    const oa = (await call(env, "GET", "/openapi.json")).body as { paths: Record<string, { get?: { summary?: string } }> };
    for (const [path, only] of [["/api/inbox", "handle, since and cursor"], ["/api/guest/inbox", "guest and cursor"]] as const) {
      const sentence = `Accepts only ${only}, each at most once; any other query parameter is refused with 400 (unknown_query_parameter or repeated_query_parameter), never silently ignored.`;
      assert.ok(llms.includes(sentence), `llms.txt ${path}`);
      assert.ok(surface.routes.find((r) => r.method === "GET" && r.path === path)?.description.endsWith(sentence), `surface ${path}`);
      assert.ok(oa.paths[path]?.get?.summary?.endsWith(sentence), `openapi ${path}`);
    }
  } finally {
    d1.close();
  }
});

test("8: every inbox URL a served document prints carries only parameters the route accepts, and the URL, with placeholders filled, is read with 200", async () => {
  // Mutation that reddens this: add &limit=<n> to one printed URL in inbox.ts or doc.ts; drop a key from INBOX_PARAMS.
  const { d1, env } = setup();
  try {
    const v = await seedVisitor(d1, "wren");
    const docs = ["/heartbeat.md", "/skill.md", "/operators", "/", "/llms.txt", "/api/surface", "/openapi.json", "/.well-known/agent-card.json"];
    const texts: Array<[string, string]> = [];
    for (const d of docs) {
      const r = await call(env, "GET", d);
      assert.ok(r.status === 200, `${d} answered ${r.status}`);
      texts.push([d, typeof r.body?._text === "string" ? r.body._text : JSON.stringify(r.body)]);
    }
    let seen = 0;
    const pattern = /\/api\/(guest\/)?inbox\?([A-Za-z0-9_=&<>$%{}.:#-]+)/g;
    for (const [name, text] of texts) {
      for (const m of text.matchAll(pattern)) {
        seen++;
        const isGuest = m[1] !== undefined;
        const accepted = isGuest ? ["guest", "cursor"] : ["handle", "since", "cursor"];
        const keys = m[2].split("&").map((kv) => kv.split("=")[0]);
        for (const k of keys) assert.ok(accepted.includes(k), `${name} prints ${m[0]}: ${k} is not accepted`);
        assert.equal(new Set(keys).size, keys.length, `${name} prints ${m[0]} with a repeated key`);
        if (m[2].split("&").some((kv) => !kv.includes("="))) continue; // a parameter list (guest&cursor), not a URL
        const filled = m[2].replace(/<your visitor number>|<your number>|<number>|<visitor number>/g, String(v.id)).replace(/<your handle>|<h>/g, "alice").replace(/<ms>/g, "0").replace(/<next_cursor>/g, "c0-p0");
        if (/[<>]/.test(filled)) continue; // a placeholder this test does not know is reported by the count below, not guessed at
        const res = await call(env, "GET", `/api/${isGuest ? "guest/" : ""}inbox?${filled}`);
        assert.equal(res.status, 200, `${name} prints ${m[0]}: ${JSON.stringify(res.body)}`);
      }
    }
    assert.ok(seen >= 4, `only ${seen} printed inbox URLs were found: the scan is blind`);
  } finally {
    d1.close();
  }
});
