// /openapi.json request side (soft-power 148881 and 149382, load-bearing-2 149371 on 1f916 9594; D-084, R1 = A).
// Real local D1, the real router, nothing mocked. Requests are built from the SERVED parameter schemas, so a bound the document states but the
// route does not enforce (or enforces but the document omits) goes red here.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { call, createLocalD1, seedCitizens, guestEnv } from "./helpers/guest.ts";
import { newResident } from "./helpers/resident.ts";
import { world } from "./helpers/resident-account.ts";

type Schema = { type?: string; nullable?: boolean; required?: string[]; properties?: Record<string, Schema>; items?: Schema; pattern?: string; minimum?: number; maximum?: number };
type Param = { name: string; in: string; required?: boolean; description?: string; schema: Schema };

// A compact copy of the walker in openapi-response-schema-d1.test.ts (that file runs its tests on import, so it cannot be imported).
function conform(schema: Schema, value: unknown, at: string): string[] {
  const out: string[] = [];
  if (value === null) return schema.nullable ? out : [`${at} is null but not nullable`];
  const t = Array.isArray(value) ? "array" : Number.isInteger(value) ? "integer" : typeof value;
  if (schema.type && schema.type !== t) out.push(`${at} is ${t}, schema says ${schema.type}`);
  if (schema.pattern && typeof value === "string" && !new RegExp(schema.pattern).test(value)) out.push(`${at} is ${JSON.stringify(value)}, not matching ${schema.pattern}`);
  if (schema.minimum !== undefined && typeof value === "number" && value < schema.minimum) out.push(`${at} is below minimum ${schema.minimum}`);
  if (schema.maximum !== undefined && typeof value === "number" && value > schema.maximum) out.push(`${at} is above maximum ${schema.maximum}`);
  if (schema.type === "array" && schema.items && Array.isArray(value)) value.forEach((v, i) => out.push(...conform(schema.items!, v, `${at}[${i}]`)));
  if (schema.type === "object" && value && typeof value === "object" && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    for (const k of schema.required ?? []) if (!(k in o)) out.push(`${at}.${k} is required but not served`);
    for (const [k, s] of Object.entries(schema.properties ?? {})) if (k in o) out.push(...conform(s, o[k], `${at}.${k}`));
  }
  return out;
}

const getDoc = async (env: any) => (await call(env, "GET", "/openapi.json")).body;
const paramsOf = (doc: any, path: string): Param[] => [...(doc.paths[path].parameters ?? []), ...(doc.paths[path].get?.parameters ?? [])];
const declaredStatuses = (doc: any, path: string): string[] => Object.keys(doc.paths[path].get.responses);
const okSchema = (doc: any, path: string): Schema => doc.paths[path].get.responses["200"].content["application/json"].schema;
const afterSchema = (doc: any, path: string): Schema => paramsOf(doc, path).find((q) => q.name === "after")!.schema;

test("template_variable_must_be_declared: every {x} in every served path has a required path parameter", async () => {
  const { d1, env } = world();
  try {
    const doc = await getDoc(env);
    let templated = 0;
    const missing: string[] = [];
    for (const path of Object.keys(doc.paths)) {
      for (const [, name] of path.matchAll(/\{([^}]+)\}/g)) {
        templated++;
        const p = paramsOf(doc, path).find((q) => q.in === "path" && q.name === name);
        if (!p || p.required !== true) missing.push(`${path} {${name}}`);
      }
    }
    assert.ok(templated >= 4, "the walk saw the templated paths (it is not vacuous)");
    assert.deepEqual(missing, []);
  } finally {
    d1.close();
  }
});

// What a request needs besides the parameter under test, and one value each pattern accepts and one it refuses.
const BASE: Record<string, Record<string, string>> = {
  "/api/inbox": { handle: "alice", since: "0" },
  "/api/guest/inbox": { guest: "1" },
  "/api/changes": { since: "0" },
  "/api/search": { q: "x" },
};
const PATTERN_SAMPLES: Record<string, { valid: string; invalid: string }> = {
  "/api/residents|after": { valid: "1", invalid: "1x" },
  "/api/council/thread|after": { valid: "1", invalid: "1x" },
  "/api/guest/thread|after": { valid: "g1", invalid: "17" },
  "/api/settlements/attention|after": { valid: "1:1", invalid: "1" },
};
// Bounds the handlers enforce with a 400: they must be declared, or the boundary walk below is vacuous.
const MUST_BE_BOUNDED: Array<[string, string, string]> = [
  ["/api/residents", "limit", "minimum"],
  ["/api/residents", "limit", "maximum"],
  ["/api/residents", "after", "pattern"],
  ["/api/council/thread", "limit", "maximum"],
  ["/api/council/thread", "after", "pattern"],
  ["/api/guest/due", "limit", "maximum"],
  ["/api/resident/{number}", "number", "minimum"],
  ["/api/settlements/attention", "after", "pattern"],
];

// The longest string a pattern accepts, built from the served pattern itself (only the token shapes this document uses: a literal, or a [class], each with an optional {m,n}).
function longestMatch(pattern: string): string {
  let out = "";
  for (const [, atom, , max] of pattern.replace(/^\^|\$$/g, "").matchAll(/(\[[^\]]+\]|[a-z:])(\{(\d+),?(\d+)?\})?/g).map((m) => [m[0], m[1], m[3], m[4] ?? m[3] ?? "1"])) {
    const ch = atom.startsWith("[") ? "9" : atom;
    out += ch.repeat(Number(max));
  }
  assert.ok(new RegExp(pattern).test(out), `the built longest string ${out} matches ${pattern}`);
  return out;
}

function urlFor(path: string, base: Record<string, string>, p: Param, value: string): string {
  const q = { ...base };
  delete q[p.name];
  let url = path.replace(/\{([^}]+)\}/g, (_m, n) => (n === p.name ? value : "1"));
  if (p.in === "query") q[p.name] = value;
  const qs = new URLSearchParams(q).toString();
  return qs ? `${url}?${qs}` : url;
}

test("request_valid_by_parameter_schema_must_not_get_undeclared_status: boundary requests built from the served parameter schemas", async () => {
  const { d1, env, post } = world();
  try {
    const doc = await getDoc(env);
    for (const [path, name, kw] of MUST_BE_BOUNDED) {
      const p = paramsOf(doc, path).find((q) => q.name === name);
      assert.ok(p && (p.schema as any)[kw] !== undefined, `${path} ${name} declares ${kw}`);
      assert.ok(declaredStatuses(doc, path).includes("400"), `${path} declares 400`);
    }
    BASE["/api/guest/thread"] = { post_id: String(post) };
    let built = 0;
    const failures: string[] = [];
    for (const path of Object.keys(doc.paths)) {
      const declared = declaredStatuses(doc, path);
      for (const p of paramsOf(doc, path)) {
        const s = p.schema;
        const cases: Array<[string, boolean]> = [];
        if (s.type === "integer") {
          if (s.minimum !== undefined) cases.push([String(s.minimum), true], [String(s.minimum - 1), false]);
          if (s.maximum !== undefined) cases.push([String(s.maximum), true], [String(s.maximum + 1), false]);
        }
        if (s.pattern) {
          const sample = PATTERN_SAMPLES[`${path}|${p.name}`];
          assert.ok(sample, `a pattern sample exists for ${path} ${p.name}`);
          assert.ok(new RegExp(s.pattern).test(sample.valid) && !new RegExp(s.pattern).test(sample.invalid), `the sample agrees with the served pattern for ${path} ${p.name}`);
          cases.push([sample.valid, true], [longestMatch(s.pattern), true], [sample.invalid, false]);
        }
        for (const [value, inRange] of cases) {
          const url = urlFor(path, BASE[path] ?? {}, p, value);
          const r = await call(env, "GET", url);
          built++;
          if (!declared.includes(String(r.status))) failures.push(`${url} answered ${r.status}, not in ${declared}`);
          if (inRange && r.status === 400) failures.push(`${url} is in range by the schema but answered 400`);
          if (!inRange && r.status !== 400) failures.push(`${url} is out of range by the schema but answered ${r.status}`);
        }
      }
    }
    assert.ok(built >= 20, `built ${built} boundary requests`);
    assert.deepEqual(failures, []);
    // The profile route: 0 is refused, a number nobody holds is a 404, and both are declared.
    const prof = declaredStatuses(doc, "/api/resident/{number}");
    for (const [url, status] of [["/api/resident/0", 400], ["/api/resident/987654", 404]] as const) {
      assert.equal((await call(env, "GET", url)).status, status);
      assert.ok(prof.includes(String(status)), `${status} declared on the profile route`);
    }
    // The parked list clamps, so it declares no bound and no 400, says so, and the clamp is the answer.
    const parked = paramsOf(doc, "/api/maintainer/parked");
    for (const p of parked) assert.deepEqual(Object.keys(p.schema).sort(), ["type"], `parked ${p.name} declares no bound`);
    assert.deepEqual(declaredStatuses(doc, "/api/maintainer/parked"), ["200"]);
    for (const limit of ["0", "101", "-5", "abc"]) assert.equal((await call(env, "GET", `/api/maintainer/parked?limit=${limit}`)).status, 200);
    assert.match(parked.find((p) => p.name === "limit")!.description ?? "", /clamp/i);
  } finally {
    d1.close();
  }
});

test("a declared error status is one the route produces: each is hit once, and nothing is declared beyond the table", async () => {
  const { d1, env } = world();
  try {
    const doc = await getDoc(env);
    const hit: Array<[string, string, number]> = [
      ["/api/residents?limit=0", "/api/residents", 400],
      ["/api/council/thread?limit=0", "/api/council/thread", 400],
      ["/api/guest/due?limit=0", "/api/guest/due", 400],
      ["/api/guest/thread?post_id=0", "/api/guest/thread", 400],
      ["/api/guest/thread?post_id=987654", "/api/guest/thread", 404],
      ["/api/guest/inbox?guest=0", "/api/guest/inbox", 400],
      ["/api/guest/inbox?guest=987654", "/api/guest/inbox", 404],
      ["/api/inbox?handle=nobody-here&since=0", "/api/inbox", 404],
      ["/api/inbox?handle=!&since=0", "/api/inbox", 400],
      ["/api/search", "/api/search", 400],
      ["/api/changes", "/api/changes", 400],
      ["/api/settlements/attention?after=x", "/api/settlements/attention", 400],
      ["/api/proposals?since=1&since=2", "/api/proposals", 400],
      ["/api/proposals?bogus=1", "/api/proposals", 400],
      ["/api/resident/0", "/api/resident/{number}", 400],
      ["/api/resident/987654", "/api/resident/{number}", 404],
      ["/api/post/987654", "/api/post/{id}", 404],
      ["/api/listing/987654", "/api/listing/{id}", 404],
      ["/api/proposal/987654", "/api/proposal/{id}", 404],
      ["/treasury?before_id=1", "/treasury", 400],
      ["/api/treasury?before_id=1", "/api/treasury", 400],
    ];
    for (const [url, path, status] of hit) {
      assert.equal((await call(env, "GET", url)).status, status, url);
      assert.ok(declaredStatuses(doc, path).includes(String(status)), `${path} declares ${status}`);
    }
    const hitSet = new Set(hit.map(([, p, s]) => `${p}|${s}`));
    const extra: string[] = [];
    for (const path of Object.keys(doc.paths)) for (const s of declaredStatuses(doc, path)) if (s !== "200" && !hitSet.has(`${path}|${s}`)) extra.push(`${path} ${s}`);
    assert.deepEqual(extra, []);
  } finally {
    d1.close();
  }
});

// ---------- the cursor a route serves is the cursor its own parameter declares ----------

test("served_cursor_round_trips_by_declared_types: residents", async () => {
  const { d1, env, post } = world();
  try {
    await newResident(env, post, "first");
    await newResident(env, post, "second");
    const doc = await getDoc(env);
    const page1 = (await call(env, "GET", "/api/residents?limit=1")).body;
    assert.equal(page1.has_more, true);
    assert.deepEqual(conform(okSchema(doc, "/api/residents"), page1, "residents"), []);
    assert.deepEqual(conform(afterSchema(doc, "/api/residents"), page1.next_cursor, "after"), []);
    const page2 = (await call(env, "GET", `/api/residents?limit=1&after=${page1.next_cursor}`)).body;
    assert.equal(page2.residents.length, 1);
    assert.ok(page2.residents[0].number > page1.residents[0].number);
  } finally {
    d1.close();
  }
});

test("served_cursor_round_trips_by_declared_types: council thread", async () => {
  const { d1, env } = world();
  try {
    for (const at of [1, 2]) d1.raw.prepare("INSERT INTO council_thread (author_kind, author_id, handle, body, created_at) VALUES ('citizen', 1, 'h', ?, ?)").run(`m${at}`, at);
    const doc = await getDoc(env);
    const page1 = (await call(env, "GET", "/api/council/thread?limit=1")).body;
    assert.equal(page1.has_more, true);
    assert.deepEqual(conform({ type: "string" }, page1.next_cursor, "next_cursor"), [], "the route has no response schema: the served cursor is a string");
    assert.deepEqual(conform(afterSchema(doc, "/api/council/thread"), page1.next_cursor, "after"), []);
    const page2 = (await call(env, "GET", `/api/council/thread?limit=1&after=${page1.next_cursor}`)).body;
    assert.deepEqual(page2.messages.map((m: any) => m.body), ["m2"]);
  } finally {
    d1.close();
  }
});

test("served_cursor_round_trips_by_declared_types: parked list", async () => {
  const d1 = createLocalD1();
  try {
    const env = guestEnv(d1);
    seedCitizens(d1);
    const clerk = Number(d1.raw.prepare("INSERT INTO maintainer_runs (kind, started_at) VALUES ('clerk', 1)").run().lastInsertRowid);
    for (const kind of ["registration_check", "bulletin_draft"]) {
      const q = Number(d1.raw.prepare("INSERT INTO maintainer_queue (run_id, created_at, kind, target_type, target_id, note, status, decided_at) VALUES (?, 10, ?, NULL, NULL, 'private note', 'pending', NULL)").run(clerk, kind).lastInsertRowid);
      const run = Number(d1.raw.prepare("INSERT INTO maintainer_runs (kind, started_at) VALUES ('judgment', ?)").run(100 + q).lastInsertRowid);
      d1.raw.prepare("INSERT INTO maintainer_declines (queue_id, run_id, declined_at) VALUES (?, ?, 200)").run(q, run);
    }
    const doc = await getDoc(env);
    const page1 = (await call(env, "GET", "/api/maintainer/parked?limit=1")).body;
    assert.equal(page1.has_more, true);
    assert.deepEqual(conform(okSchema(doc, "/api/maintainer/parked"), page1, "parked"), []);
    assert.deepEqual(conform(afterSchema(doc, "/api/maintainer/parked"), page1.next_cursor, "after"), []);
    const page2 = (await call(env, "GET", `/api/maintainer/parked?limit=1&after=${page1.next_cursor}`)).body;
    assert.equal(page2.items.length, 1);
    assert.ok(page2.items[0].id > page1.items[0].id);
  } finally {
    d1.close();
  }
});

// Routes whose text says "refused" about something that is not a request refusal.
const EXEMPT_FROM_400_TEXT: Record<string, string> = { "/api/doors": "its counters note says a refused MCP tool call still counts as a received call; the route itself answers no 400" };

test("a route whose served text says 400 or refused declares 400", async () => {
  const { d1, env } = world();
  try {
    const doc = await getDoc(env);
    const lacking: string[] = [];
    for (const path of Object.keys(doc.paths)) {
      const op = doc.paths[path].get;
      const text = [op.summary, op.description, ...paramsOf(doc, path).map((p) => p.description)].filter(Boolean).join(" ");
      if (EXEMPT_FROM_400_TEXT[path]) continue;
      if (/400|refused/i.test(text) && !declaredStatuses(doc, path).includes("400")) lacking.push(path);
    }
    assert.deepEqual(lacking, []);
  } finally {
    d1.close();
  }
});
