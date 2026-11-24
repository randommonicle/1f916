// /openapi.json response side (D-086, option A; soft-power 148881 and 149382, load-bearing-2 149371 on 1f916 9594).
// Document lint: reads only the rendered document and the UNVALIDATED table it is served from. No D1, nothing mocked.
//   1. Every GET parameter either declares a bound (minimum, maximum, pattern, enum) or carries the extension that says what the handler does with a bad value.
//   2. The extensions and the table agree both ways, value for value.
//   3. Every cursor a route serves carries the pattern of the parameter it feeds (the parked list keeps its integer cursor on both sides).
//   4. Served truth: a real page of each cursor route, from real local D1 and the real router, conforms to its declared 200 schema, and its cursor is accepted by the parameter it feeds.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { renderOpenApi, UNVALIDATED } from "../src/discovery.ts";
import { call, seedPost, seedTopic, seedVisitor } from "./helpers/guest.ts";
import { world } from "./helpers/resident-account.ts";
import { newResident } from "./helpers/resident.ts";

type Schema = Record<string, any>;
type Param = { name: string; in: string; schema: Schema };

const doc: any = renderOpenApi("https://example.test", "Commonhold");
const paramsOf = (path: string): Param[] => [...(doc.paths[path].parameters ?? []), ...(doc.paths[path].get?.parameters ?? [])];
const allParams = (): Array<[string, Param]> => Object.keys(doc.paths).flatMap((path) => paramsOf(path).map((p): [string, Param] => [`${path}|${p.name}`, p]));
const okSchema = (path: string): Schema => doc.paths[path].get.responses["200"].content["application/json"].schema;

test("every GET parameter is bounded or carries x-clamped / x-ignored-when-invalid", () => {
  const params = allParams();
  assert.ok(params.length > 40, `the lint saw ${params.length} parameters (it is not vacuous)`);
  const bare = params
    .filter(([, p]) => p.schema.minimum === undefined && p.schema.maximum === undefined && p.schema.pattern === undefined && p.schema.enum === undefined && !p.schema["x-clamped"] && !p.schema["x-ignored-when-invalid"])
    .map(([k]) => k);
  assert.deepEqual(bare, []);
});

test("the extensions and the UNVALIDATED table agree both ways", () => {
  const seen = new Set<string>();
  const wrong: string[] = [];
  for (const [key, p] of allParams()) {
    seen.add(key);
    const entry = UNVALIDATED[key];
    const clamped = p.schema["x-clamped"];
    const ignored = p.schema["x-ignored-when-invalid"];
    if (!entry) {
      if (clamped || ignored) wrong.push(`${key} carries an extension the table does not name`);
      continue;
    }
    if (entry.kind === "clamped") {
      if (!clamped || ignored) wrong.push(`${key} is clamped in the table but the document says otherwise`);
      else if (clamped.minimum !== entry.min || clamped.maximum !== entry.max || clamped.reason !== entry.reason) wrong.push(`${key} x-clamped differs from the table`);
    } else if (!ignored || clamped) wrong.push(`${key} is ignored-when-invalid in the table but the document says otherwise`);
    else if (ignored.reason !== entry.reason) wrong.push(`${key} x-ignored-when-invalid differs from the table`);
    if (p.schema.minimum !== undefined || p.schema.maximum !== undefined || p.schema.pattern !== undefined || p.schema.enum !== undefined) wrong.push(`${key} is both bounded and listed in the table`);
  }
  assert.deepEqual(wrong, []);
  assert.deepEqual(Object.keys(UNVALIDATED).filter((k) => !seen.has(k)), [], "the table names no parameter the document lacks");
  assert.ok(Object.keys(UNVALIDATED).length >= 15, "the table is not empty");
  const clamps = Object.values(UNVALIDATED).filter((u) => u.kind === "clamped");
  assert.ok(clamps.length >= 4 && clamps.every((u) => u.kind === "clamped" && u.min >= 1 && u.max > u.min), "the clamp bounds are real numbers taken from the code");
});

// [route, the parameter that takes the cursor, the 200 field that carries it, whether the field is null at the end]
const CURSOR_ROUTES: Array<[string, string, string, boolean]> = [
  ["/api/residents", "after", "next_cursor", true],
  ["/api/council/thread", "after", "next_cursor", true],
  ["/api/guest/thread", "after", "guest_thread_next", true],
  ["/api/settlements/attention", "after", "next", true],
  ["/api/guest/inbox", "cursor", "next_cursor", false],
  ["/api/guest/due", "after", "next_cursor", true],
  ["/api/inbox", "cursor", "next_cursor", false],
];

test("every cursor a route serves carries the pattern of the parameter it feeds", () => {
  const wrong: string[] = [];
  for (const [path, param, field, nullable] of CURSOR_ROUTES) {
    const want = paramsOf(path).find((p) => p.name === param)?.schema.pattern;
    const got = okSchema(path).properties?.[field];
    if (typeof want !== "string") wrong.push(`${path} ${param} declares no pattern`);
    else if (!got) wrong.push(`${path} 200 declares no ${field}`);
    else {
      if (got.pattern !== want) wrong.push(`${path} ${field} pattern ${got.pattern} is not the ${param} pattern ${want}`);
      if (got.type !== "string") wrong.push(`${path} ${field} is not a string`);
      if (Boolean(got.nullable) !== nullable) wrong.push(`${path} ${field} nullable should be ${nullable}`);
      if (!(okSchema(path).required ?? []).includes(field)) wrong.push(`${path} ${field} is not required`);
    }
  }
  assert.equal(CURSOR_ROUTES.length, 7, "residents plus the six bare cursor routes (the brief says eight; its own list names seven)");
  assert.deepEqual(wrong, []);
});

test("the parked list keeps its integer cursor on both sides", () => {
  const after = paramsOf("/api/maintainer/parked").find((p) => p.name === "after")!.schema;
  const next = okSchema("/api/maintainer/parked").properties!.next_cursor;
  assert.equal(after.type, "integer");
  assert.equal(next.type, "integer");
  assert.equal(next.nullable, true);
  assert.equal(next.pattern, undefined, "no string pattern: the cursor is an integer");
});

// ---------- served truth: a real page with a cursor, per route ----------

// A compact copy of the walker in openapi-response-schema-d1.test.ts (that file runs its tests on import, so it cannot be imported).
function conform(schema: Schema, value: unknown, at: string): string[] {
  const out: string[] = [];
  if (value === null) return schema.nullable ? out : [`${at} is null but not nullable`];
  const t = Array.isArray(value) ? "array" : Number.isInteger(value) ? "integer" : typeof value;
  if (schema.type && schema.type !== t) out.push(`${at} is ${t}, schema says ${schema.type}`);
  if (schema.pattern && typeof value === "string" && !new RegExp(schema.pattern).test(value)) out.push(`${at} is ${JSON.stringify(value)}, not matching ${schema.pattern}`);
  if (schema.minimum !== undefined && typeof value === "number" && value < schema.minimum) out.push(`${at} is below minimum ${schema.minimum}`);
  if (schema.type === "array" && schema.items && Array.isArray(value)) value.forEach((v, i) => out.push(...conform(schema.items, v, `${at}[${i}]`)));
  if (schema.type === "object" && value && typeof value === "object" && !Array.isArray(value)) {
    const o = value as Record<string, unknown>;
    for (const k of schema.required ?? []) if (!(k in o)) out.push(`${at}.${k} is required but not served`);
    for (const [k, sub] of Object.entries<Schema>(schema.properties ?? {})) if (k in o) out.push(...conform(sub, o[k], `${at}.${k}`));
  }
  return out;
}

// One served page: it conforms to the route's 200 schema, its cursor field matches the parameter's pattern, and the parameter accepts it (the next request is a 200).
async function pageThenFollow(env: any, path: string, firstQuery: string, param: string, field: string, nextQuery: (cursor: string) => string): Promise<{ first: any; second: any }> {
  const first = await call(env, "GET", `${path}?${firstQuery}`);
  assert.equal(first.status, 200, `${path} first page`);
  assert.deepEqual(conform(okSchema(path), first.body, path), [], `${path} body against its declared 200`);
  const cursor = first.body[field];
  assert.equal(typeof cursor, "string", `${path} served a cursor in ${field}`);
  const declared = paramsOf(path).find((p) => p.name === param)!.schema;
  assert.deepEqual(conform(declared, cursor, `${path} ${param}`), [], `${path} cursor ${cursor} is what ${param} declares`);
  const second = await call(env, "GET", `${path}?${nextQuery(encodeURIComponent(cursor))}`);
  assert.equal(second.status, 200, `${path} follows its own cursor`);
  assert.deepEqual(conform(okSchema(path), second.body, path), [], `${path} second page against its declared 200`);
  return { first: first.body, second: second.body };
}

test("served truth: residents", async () => {
  const { d1, env, post } = world();
  try {
    await newResident(env, post, "first");
    await newResident(env, post, "second");
    const { first, second } = await pageThenFollow(env, "/api/residents", "limit=1", "after", "next_cursor", (c) => `limit=1&after=${c}`);
    assert.equal(first.has_more, true);
    assert.ok(second.residents[0].number > first.residents[0].number);
  } finally {
    d1.close();
  }
});

test("served truth: council thread", async () => {
  const { d1, env } = world();
  try {
    for (const at of [1, 2]) d1.raw.prepare("INSERT INTO council_thread (author_kind, author_id, handle, body, created_at) VALUES ('citizen', 1, 'h', ?, ?)").run(`m${at}`, at);
    const { first, second } = await pageThenFollow(env, "/api/council/thread", "limit=1", "after", "next_cursor", (c) => `limit=1&after=${c}`);
    assert.equal(first.has_more, true);
    assert.deepEqual(second.messages.map((m: any) => m.body), ["m2"]);
  } finally {
    d1.close();
  }
});

test("served truth: settlements attention (501 eligible rows, so a first page of 500 has a cursor)", async () => {
  const { d1, env } = world();
  try {
    const ins = d1.raw.prepare("INSERT INTO settlement_claims (network, asset, from_addr, nonce, route, intent_json, intent_hash, rpc_body, rpc_body_hash, valid_before, state, verdict_reason, created_at, updated_at) VALUES ('n', 'a', '0x1', ?, 'patron', '{}', 'h', NULL, 'h', 1, 'pending', 'chain_spent_facilitator_refused:x', ?, ?)");
    d1.raw.exec("BEGIN");
    for (let i = 0; i < 501; i++) ins.run(`0x${i.toString(16).padStart(64, "0")}`, 1_000 + i, 1_000 + i);
    d1.raw.exec("COMMIT");
    const { first, second } = await pageThenFollow(env, "/api/settlements/attention", "", "after", "next", (c) => `after=${c}`);
    assert.equal(first.has_more, true);
    assert.equal(first.entries.length, 500);
    assert.equal(second.entries.length, 1);
    assert.equal(second.next, null);
  } finally {
    d1.close();
  }
});

test("served truth: guest thread (201 rows, one more than a route page)", async () => {
  const { d1, env, alice } = world();
  try {
    const post = seedPost(d1, alice);
    const ins = d1.raw.prepare("INSERT INTO guest_thread (post_id, author_kind, author_id, handle, model, kind, body, created_at) VALUES (?, 'guest', ?, 'bulk', 'm', 'comment', ?, ?)");
    d1.raw.exec("BEGIN");
    for (let i = 0; i < 201; i++) ins.run(post, 5000 + i, `bulk ${i}`, 1_000 + i);
    d1.raw.exec("COMMIT");
    const { first, second } = await pageThenFollow(env, "/api/guest/thread", `post_id=${post}`, "after", "guest_thread_next", (c) => `post_id=${post}&after=${c}`);
    assert.equal(first.guest_thread.length, 200);
    assert.equal(second.guest_thread.length, 1);
    assert.equal(second.guest_thread_next, null);
  } finally {
    d1.close();
  }
});

test("served truth: guest inbox", async () => {
  const { d1, env } = world();
  try {
    const v = await seedVisitor(d1);
    const { first } = await pageThenFollow(env, "/api/guest/inbox", `guest=${v.id}`, "cursor", "next_cursor", (c) => `guest=${v.id}&cursor=${c}`);
    assert.equal(first.has_more, false);
  } finally {
    d1.close();
  }
});

test("served truth: guest due, both views", async () => {
  const { d1, env } = world();
  try {
    const topic = seedTopic(d1);
    const duty = d1.raw.prepare("INSERT INTO guest_thread (post_id, author_kind, author_id, handle, model, kind, body, duty, due_at, created_at) VALUES (?, 'guest', ?, 'gadfly', 'm', 'critique', 'a critique', 1, ?, ?)");
    const answer = d1.raw.prepare("INSERT INTO guest_thread (post_id, parent_kind, parent_id, depth, author_kind, author_id, handle, model, kind, body, created_at) VALUES (?, 'thread', ?, 1, 'citizen', 1, 'commonhold-agent', 'm', 'comment', ?, ?)");
    const now = Date.now();
    for (let i = 0; i < 2; i++) duty.run(topic, 7000 + i, now + 5_000_000 + i, now - 1_000 + i); // open
    for (let i = 0; i < 2; i++) {
      const id = Number(duty.run(topic, 7100 + i, now + 1_000 + i, now - 200_000 + i).lastInsertRowid);
      answer.run(topic, id, "an answer that discharges the duty ".repeat(20), now - 100_000 + i); // answered
    }
    const act = await pageThenFollow(env, "/api/guest/due", "limit=1", "after", "next_cursor", (c) => `limit=1&after=${c}`);
    assert.equal(act.first.has_more, true);
    assert.match(act.first.next_cursor, /^[0-9]+\.[0-9]+$/, "the actionable view serves <due_at>.<id>");
    const hist = await pageThenFollow(env, "/api/guest/due", "view=history&limit=1", "after", "next_cursor", (c) => `view=history&limit=1&after=${c}`);
    assert.equal(hist.first.has_more, true);
    assert.match(hist.first.next_cursor, /^[0-9]+$/, "the history view serves <id>");
  } finally {
    d1.close();
  }
});

test("served truth: citizen inbox", async () => {
  const { d1, env } = world();
  try {
    const { first } = await pageThenFollow(env, "/api/inbox", "handle=alice&since=0", "cursor", "next_cursor", (c) => `handle=alice&cursor=${c}`);
    assert.match(first.next_cursor, /^c[0-9]+-p[0-9]+(-g[0-9]+)?$/);
  } finally {
    d1.close();
  }
});

// ---------- the two inbox cursors: the pattern holds every canonical safe integer; a part above its table's newest row id is a 400 and is never served back ----------

const SAFE = "9007199254740991";
const SAFE_MAX_16 = SAFE;
const FIFTEEN = "999999999999999";

test("the inbox cursor patterns accept exactly the canonical decimals 0 to 9007199254740991 per part", () => {
  for (const [path, build] of [
    ["/api/inbox", (v: string) => `c${v}-p${v}-g${v}`],
    ["/api/guest/inbox", (v: string) => `g${v}-c${v}-p${v}`],
  ] as const) {
    const re = new RegExp(paramsOf(path).find((p) => p.name === "cursor")!.schema.pattern);
    for (const ok of ["0", "7", FIFTEEN, SAFE, "9007199254740990", "1000000000000000", "8999999999999999"]) assert.ok(re.test(build(ok)), `${path} accepts ${ok}`);
    for (const bad of ["9007199254740992", "9999999999999999", "9007199254741000", "10000000000000000", "01", "0000000000000001", ""]) assert.equal(re.test(build(bad)), false, `${path} refuses '${bad}'`);
  }
  assert.equal(SAFE, String(Number.MAX_SAFE_INTEGER));
});

test("served truth at the limit: a 15-digit and a 16-digit safe part, per component, is inside the declared pattern and refused with 400 as above the newest row; what the route does serve fits the pattern and is followed with 200; an unsafe part is a 400 the pattern also refuses", async () => {
  const { d1, env } = world();
  try {
    const v = await seedVisitor(d1);
    const routes = [
      { path: "/api/inbox", base: "handle=alice", parts: ["c", "p", "g"], opt: [false, false, true], extra: "" },
      { path: "/api/guest/inbox", base: `guest=${v.id}`, parts: ["g", "c", "p"], opt: [false, false, false], extra: "" },
    ];
    let served = 0;
    let refused = 0;
    for (const r of routes) {
      const declared = paramsOf(r.path).find((p) => p.name === "cursor")!.schema;
      const re = new RegExp(declared.pattern);
      for (let at = 0; at < r.parts.length; at++) {
        for (const value of [FIFTEEN, SAFE_MAX_16]) {
          const cursor = r.parts.map((k, i) => (i === at ? `${k}${value}` : `${k}0`)).filter((_, i) => !(r.opt[i] && i !== at)).join("-");
          assert.ok(re.test(cursor), `${cursor} is inside the declared pattern`);
          const above = await call(env, "GET", `${r.path}?${r.base}&cursor=${cursor}`);
          assert.equal(above.status, 400, `${r.path} ${cursor}`);
          assert.match(above.body.error, /above the newest one here/);
          refused++;
        }
        const first = await call(env, "GET", `${r.path}?${r.base}&cursor=${r.parts.map((k) => `${k}0`).join("-")}`);
        assert.equal(first.status, 200, `${r.path} zero cursor`);
        assert.deepEqual(conform(okSchema(r.path), first.body, r.path), [], `${r.path} body against its declared 200`);
        assert.ok(re.test(first.body.next_cursor), `${r.path} served ${first.body.next_cursor}: it fits the declared pattern`);
        assert.equal((await call(env, "GET", `${r.path}?${r.base}&cursor=${first.body.next_cursor}`)).status, 200, `${r.path} follows ${first.body.next_cursor}`);
        served++;
        const unsafe = r.parts.map((k, i) => (i === at ? `${k}9007199254740992` : `${k}0`)).filter((_, i) => !(r.opt[i] && i !== at)).join("-");
        assert.equal(re.test(unsafe), false, `the pattern refuses ${unsafe}`);
        assert.equal((await call(env, "GET", `${r.path}?${r.base}&cursor=${unsafe}`)).status, 400, `${r.path} refuses ${unsafe} with 400`);
      }
    }
    assert.deepEqual([served, refused], [6, 12]);
  } finally {
    d1.close();
  }
});

test("finding: the handlers also read a part written with leading zeros as the same number; the document declares only the canonical form and says so", async () => {
  const { d1, env } = world();
  try {
    const v = await seedVisitor(d1);
    for (const [path, base, cursors] of [
      ["/api/inbox", "handle=alice", ["c0000000000000000-p0", "c00000000000000000-p0"]],
      ["/api/guest/inbox", `guest=${v.id}`, ["g0000000000000000-c0-p0", "g00000000000000000-c0-p0"]],
    ] as const) {
      const declared = paramsOf(path).find((p) => p.name === "cursor")!;
      for (const c of cursors) {
        assert.equal(new RegExp(declared.schema.pattern).test(c), false, `the pattern does not declare ${c}`);
        assert.equal((await call(env, "GET", `${path}?${base}&cursor=${c}`)).status, 200, `${path} still reads ${c} (not changed here)`);
      }
      const text = String((declared as any).description);
      assert.match(text, /no leading zeros/);
      assert.match(text, /leading zeros as the same number/);
      assert.match(text, /safe-integer limit 9007199254740991/);
    }
  } finally {
    d1.close();
  }
});
