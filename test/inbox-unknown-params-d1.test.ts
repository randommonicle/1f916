// GET /api/inbox and GET /api/guest/inbox refuse query parameters they do not know, and a repeated known one, exactly as /api/proposals does
// (test/proposals-unknown-params-d1.test.ts), and both MCP doors refuse an unknown tool argument. Real local D1, the real router, nothing mocked.
// Operator ruling 25 Nov 2026 (FOR-BEN-2026-11-25 s3). Every block names the mutation that reddens it.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
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

test("6: both inbox tools refuse an unknown argument and a non-object on both doors, naming keys and never values; valid arguments still read", async () => {
  // Mutations that redden this: delete assertInboxArgs from either door's case; delete assertGuestInboxArgs from either.
  const { d1, env } = setup();
  try {
    const v = await seedVisitor(d1, "wren");
    for (const door of DOORS) {
      for (const [tool, good, accepts] of [["inbox", { handle: "alice", since: 0 }, "handle, since, cursor"], ["guest_inbox", { guest: v.id }, "guest, cursor"]] as const) {
        for (const [extra, named] of [
          [{ limit: 5 }, ` for ${tool}: limit`],
          [{ Secret: "v-not-echoed" }, ` for ${tool}: Secret`],
          [{ tokens: "v-not-echoed" }, ` for ${tool}: tokens`],
          [{ secret: "v-not-echoed", zeta: "v-not-echoed", token: "v-not-echoed", limit: 5 }, `s for ${tool}: zeta, limit`],
        ] as const) {
          const r = await rpc(env, door, tool, { ...good, ...extra });
          assert.equal(r.isError, true, `${door} ${tool} ${JSON.stringify(extra)}`);
          assert.equal(r.parsed.error, `Unknown argument${named}. The ${tool} tool accepts only: ${accepts} (secret and token are ignored if sent). Nothing was read.`);
          assert.equal(JSON.stringify(r).includes("v-not-echoed"), false, "a refusal names keys, never values");
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

test("6a (D-093 note): secret and token, of any type, change nothing about the read on either door: the answer is the one without them, and as many statements run", async () => {
  // Mutations that redden this: empty IGNORED_CREDENTIAL_ARGS; drop one of the two from it; authenticate args.secret in the inbox case of mcp.ts.
  let n = 0;
  const d1 = createLocalD1({ onExec: () => { n++; } });
  seedCitizens(d1);
  const env = guestEnv(d1);
  try {
    const v = await seedVisitor(d1, "wren");
    // clock fields belong to the moment of the call, not to its arguments
    const still = (o: unknown) => JSON.stringify(o, (k, x) => (/^(as_of|checked_at|now|generated_at)/.test(k) ? undefined : x));
    for (const door of DOORS) {
      for (const [tool, good] of [["inbox", { handle: "alice", since: 0 }], ["guest_inbox", { guest: v.id }]] as const) {
        n = 0;
        const plain = await rpc(env, door, tool, good);
        const plainN = n;
        assert.equal(plain.isError, false, `${door} ${tool}`);
        assert.ok(plainN > 0, "the statement counter is blind");
        for (const extra of [{ secret: "commonhold_sk_wrong" }, { token: "not-a-token" }, { secret: 5, token: null }, { secret: { a: 1 }, token: ["x"] }]) {
          n = 0;
          const r = await rpc(env, door, tool, { ...good, ...extra });
          assert.equal(r.isError, false, `${door} ${tool} ${JSON.stringify(extra)}: ${JSON.stringify(r.parsed)}`);
          assert.equal(still(r.parsed), still(plain.parsed), `${door} ${tool} ${JSON.stringify(extra)}`);
          assert.equal(n, plainN, `${door} ${tool} ${JSON.stringify(extra)}: a credential argument changed how many statements ran`);
        }
      }
    }
    // the exception is the tools' alone: the two routes still refuse both names
    for (const r of ROUTES) {
      for (const k of ["secret", "token"]) {
        const res = await call(env, "GET", `${r.path}?${r.good}&${k}=v-not-echoed`);
        assert.equal(res.status, 400);
        assert.equal(res.body.code, "unknown_query_parameter");
        assert.equal(JSON.stringify(res.body).includes("v-not-echoed"), false);
      }
    }
  } finally {
    d1.close();
  }
});

test("6b: tools/list on both doors: both inbox tools name neither secret nor token as a property, do not close the schema, and carry the refusal sentence with the exception", async () => {
  // Mutation that reddens this: add additionalProperties:false to one schema (a client that validates would refuse what the server accepts); declare secret on one; drop the sentence from one description.
  const { d1, env } = setup();
  try {
    for (const door of DOORS) {
      const r = await call(env, "POST", door, { jsonrpc: "2.0", id: 1, method: "tools/list" }, { "CF-Connecting-IP": "203.0.113.9" });
      for (const [name, only] of [["inbox", "handle, since and cursor"], ["guest_inbox", "guest and cursor"]] as const) {
        const tool = r.body.result.tools.find((t: { name: string }) => t.name === name);
        assert.equal("additionalProperties" in tool.inputSchema, false, `${door} ${name}`);
        assert.deepEqual(Object.keys(tool.inputSchema.properties), only.split(/, | and /), `${door} ${name}`);
        assert.ok(tool.description.includes(`Takes only ${only}: any other argument is refused with an error, never silently ignored, except secret and token, which this tool does not need and ignores if sent.`), `${door} ${name}: ${tool.description}`);
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

test("8: every inbox URL a served document or a source file prints carries only parameters the route accepts, each once, and a printed URL, with its placeholders filled, is read with 200", async () => {
  // Mutations that redden this: add &limit=<n> to one printed URL in inbox.ts, doc.ts, guest.ts or resident.ts; drop a key from INBOX_PARAMS.
  const { d1, env } = setup();
  try {
    const v = await seedVisitor(d1, "wren");
    const texts: Array<[string, string]> = [];
    for (const d of ["/heartbeat.md", "/skill.md", "/operators", "/", "/llms.txt", "/api/surface", "/openapi.json", "/.well-known/agent-card.json"]) {
      const r = await call(env, "GET", d);
      assert.ok(r.status === 200, `${d} answered ${r.status}`);
      texts.push([d, typeof r.body?._text === "string" ? r.body._text : JSON.stringify(r.body)]);
    }
    const srcDir = join(import.meta.dirname, "..", "src");
    for (const f of readdirSync(srcDir).filter((x) => x.endsWith(".ts"))) texts.push([`src/${f}`, readFileSync(join(srcDir, f), "utf8")]);
    const isSource = (name: string) => name.startsWith("src/");
    const seenIn = new Map<string, number>();
    let read = 0;
    // A placeholder (<your number>, ${guest.visitor_id}) is one atom, spaces and all; HTML documents print it escaped.
    const pattern = /\/api\/(guest\/)?inbox\?((?:[A-Za-z0-9_=&.-]|<[^<>]{1,40}>|\$\{[^{}]{1,40}\})+)/g;
    for (const [name, raw] of texts) {
      const text = raw.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
      for (const m of text.matchAll(pattern)) {
        seenIn.set(name, (seenIn.get(name) ?? 0) + 1);
        const isGuest = m[1] !== undefined;
        const accepted = isGuest ? ["guest", "cursor"] : ["handle", "since", "cursor"];
        const query = m[2].replace(/\.+$/, "");
        const pairs = query.split("&").map((kv) => kv.split("="));
        for (const [k] of pairs) assert.ok(accepted.includes(k), `${name} prints ${m[0]}: ${k} is not accepted`);
        assert.equal(new Set(pairs.map(([k]) => k)).size, pairs.length, `${name} prints ${m[0]} with a repeated key`);
        if (isSource(name) || pairs.some((p) => p.length !== 2)) continue; // source text, or a parameter list (guest&cursor): keys checked, nothing to read
        const values: Record<string, string> = { guest: String(v.id), handle: "alice", since: "0", cursor: isGuest ? "g0-c0-p0" : "c0-p0-g0" };
        const filled = pairs.map(([k, val]) => `${k}=${val.startsWith("<") ? values[k] : val}`).join("&");
        const res = await call(env, "GET", `/api/${isGuest ? "guest/" : ""}inbox?${filled}`);
        assert.equal(res.status, 200, `${name} prints ${m[0]}, read as ${filled}: ${JSON.stringify(res.body)}`);
        read++;
      }
    }
    for (const must of ["/heartbeat.md", "/skill.md", "/", "src/guest.ts", "src/guest-core.ts", "src/resident.ts", "src/inbox.ts", "src/doc.ts"])
      assert.ok(seenIn.get(must), `no inbox URL found in ${must}: the scan is blind there (${JSON.stringify([...seenIn])})`);
    assert.ok(read >= 4, `only ${read} printed inbox URLs were read: the fill is blind`);
  } finally {
    d1.close();
  }
});
