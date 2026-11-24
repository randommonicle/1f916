// The A2A agent cards, POST /a2a, the MCP doors' A2A pointer and the four probe doors (drafts/BRIEF-AGENT-CARD-A2A-2026-11-23.md v4, tests 1-7).
// Real local D1, the real router, nothing mocked. Each block names the mutant that turns it red; the commit message records each one run and restored.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import { createLocalD1, seedCitizens, guestEnv, freshIp, type LocalD1 } from "./helpers/guest.ts";
import { DOORS, PROBE_DOORS, PROBE_DOOR_DAILY_CAP, DOOR_DAILY_CAP, countDoor, utcDay } from "../src/doors.ts";
import { ROUTES, AUTH_LABEL, renderOpenApi } from "../src/discovery.ts";
import { A2A_BODY_LIMIT, directionsText } from "../src/a2a.ts";
import type { Env } from "../src/society.ts";

const ORIGIN = "https://example.test";

function fresh() {
  const d1 = createLocalD1();
  seedCitizens(d1);
  return { d1, env: guestEnv(d1) };
}

interface Raw {
  status: number;
  headers: Headers;
  text: string;
  json: any;
}

async function send(env: Env, method: string, path: string, opts: { body?: string; headers?: Record<string, string>; ctx?: ExecutionContext } = {}): Promise<Raw> {
  const res = await worker.fetch(
    new Request(`${ORIGIN}${path}`, { method, headers: { "Content-Type": "application/json", "CF-Connecting-IP": freshIp(), ...(opts.headers ?? {}) }, body: method === "GET" || method === "HEAD" ? undefined : opts.body }),
    env,
    opts.ctx,
  );
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, headers: res.headers, text, json };
}

const a2a = (env: Env, body: unknown, headers: Record<string, string> = {}) => send(env, "POST", "/a2a", { body: typeof body === "string" ? body : JSON.stringify(body), headers });
const V1 = { "A2A-Version": "1.0" };
const rpc = (method: string, params?: unknown, id: unknown = 1) => ({ jsonrpc: "2.0", id, method, params });

const msgV1 = (over: Record<string, unknown> = {}) => ({ messageId: "m-1", role: "ROLE_USER", parts: [{ text: "hello" }], ...over });
const msgV03 = (over: Record<string, unknown> = {}) => ({ kind: "message", messageId: "m-1", role: "user", parts: [{ kind: "text", text: "hello" }], ...over });
const sendV1 = (over?: Record<string, unknown>, id: unknown = 1) => rpc("SendMessage", { message: msgV1(over) }, id);
const sendV03 = (over?: Record<string, unknown>, id: unknown = 1) => rpc("message/send", { message: msgV03(over) }, id);

function today(d1: LocalD1): Record<string, number> {
  const out: Record<string, number> = {};
  for (const r of d1.raw.prepare("SELECT door, n FROM door_counts WHERE day = ?").all(utcDay(Date.now())) as Array<{ door: string; n: number }>) out[r.door] = r.n;
  return out;
}

// Wraps env.DB: counts the prepared statements that are not the door counter's, and can make the counter's batch throw for the named doors or hold it back behind a gate.
function wrapped(env: Env, opts: { failing?: string[]; gate?: Promise<void> } = {}) {
  const db = env.DB;
  const reads: string[] = [];
  const out = {
    ...env,
    DB: {
      prepare(sql: string) {
        if (!/^INSERT (OR IGNORE )?INTO (door_counts|commit_days)/.test(sql)) reads.push(sql);
        return db.prepare(sql);
      },
      batch: async (stmts: Array<{ __sql: string; __args: unknown[] }>) => {
        const upsert = stmts.find((s) => s.__sql.startsWith("INSERT INTO door_counts"));
        if (upsert) {
          if (opts.gate) await opts.gate;
          if (opts.failing?.includes(String(upsert.__args[1]))) throw new Error("boom: the counter is down");
        }
        return db.batch(stmts as never);
      },
    },
  } as unknown as Env;
  return { env: out, reads };
}

// ---------- 1. the cards ----------

const V1_REQUIRED = ["name", "description", "supportedInterfaces", "version", "capabilities", "defaultInputModes", "defaultOutputModes", "skills"];
const V03_REQUIRED = ["protocolVersion", "name", "description", "url", "version", "capabilities", "defaultInputModes", "defaultOutputModes", "skills"];

function numbersIn(v: unknown, out: number[] = []): number[] {
  if (typeof v === "number") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => numbersIn(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => numbersIn(x, out));
  return out;
}

test("T1: the v1.0 card has every v1.0 required field, typed; the v0.3 card every v0.3 required field; both point at <origin>/a2a; neither names a figure or an 0x address", async () => {
  // Mutants: drop `supportedInterfaces` from the v1 card, or `url` / `protocolVersion` from the v0.3 card -> red; serve the v1 card on agent.json -> red.
  const { d1, env } = fresh();
  try {
    const v1 = await send(env, "GET", "/.well-known/agent-card.json");
    const v03 = await send(env, "GET", "/.well-known/agent.json");
    assert.equal(v1.status, 200);
    assert.equal(v03.status, 200);
    assert.equal(v1.headers.get("Access-Control-Allow-Origin"), "*");
    assert.equal(v03.headers.get("Access-Control-Allow-Origin"), "*");
    for (const k of V1_REQUIRED) assert.ok(k in v1.json, `v1.0 card has ${k}`);
    for (const k of V03_REQUIRED) assert.ok(k in v03.json, `v0.3 card has ${k}`);
    for (const card of [v1.json, v03.json]) {
      assert.equal(typeof card.name, "string");
      assert.equal(typeof card.description, "string");
      assert.equal(typeof card.version, "string");
      assert.equal(card.capabilities.streaming, false);
      assert.equal(card.capabilities.pushNotifications, false);
      assert.deepEqual(card.defaultInputModes, ["text/plain"]);
      assert.deepEqual(card.defaultOutputModes, ["text/plain"]);
      assert.equal(card.skills.length, 1);
      for (const k of ["id", "name", "description", "tags"]) assert.ok(k in card.skills[0], `the skill has ${k}`);
      assert.ok(Array.isArray(card.skills[0].tags));
      assert.deepEqual(card.provider, { organization: card.name, url: ORIGIN });
      assert.equal(card.documentationUrl, `${ORIGIN}/llms.txt`);
      assert.equal(card.version, "1.0.0");
      assert.equal(JSON.stringify(card).includes("0x"), false, "no address");
      assert.deepEqual(numbersIn(card), [], "no JSON number anywhere: no figure that can go stale");
    }
    assert.equal(v1.json.capabilities.extendedAgentCard, false);
    assert.deepEqual(v1.json.supportedInterfaces, [{ url: `${ORIGIN}/a2a`, protocolBinding: "JSONRPC", protocolVersion: "1.0" }]);
    assert.equal(v03.json.url, `${ORIGIN}/a2a`);
    assert.equal(v03.json.protocolVersion, "0.3.0");
    assert.equal(v03.json.preferredTransport, "JSONRPC");
    assert.equal("supportedInterfaces" in v03.json, false, "a v0.3 card is not a v1.0 card");
    assert.equal("url" in v1.json, false, "a v1.0 card has no top-level url");
    assert.equal(v1.json.skills[0].id, "directions");
  } finally {
    d1.close();
  }
});

test("T1b: a governance_settings rename changes name and provider.organization on both cards; the card route makes ONE D1 read", async () => {
  // Mutants: hard-code the name -> red on the rename; read through officialFacts -> red on the read count.
  const { d1, env } = fresh();
  try {
    const before = await send(env, "GET", "/.well-known/agent-card.json");
    assert.equal(before.json.name, "Commonhold", "the DEFAULT_NAME fallback");
    d1.raw.prepare("INSERT INTO governance_settings (key, value, updated_at) VALUES ('name', 'Renamed Society', ?)").run(Date.now());
    for (const path of ["/.well-known/agent-card.json", "/.well-known/agent.json"]) {
      const card = (await send(env, "GET", path)).json;
      assert.equal(card.name, "Renamed Society");
      assert.equal(card.provider.organization, "Renamed Society");
    }
    for (const path of ["/.well-known/agent-card.json", "/.well-known/agent.json"]) {
      const w = wrapped(env);
      assert.equal((await send(w.env, "GET", path)).status, 200);
      assert.equal(w.reads.length, 1, `${path}: one read, got ${JSON.stringify(w.reads)}`);
      assert.match(w.reads[0]!, /governance_settings/);
    }
  } finally {
    d1.close();
  }
});

// ---------- 2. a send ----------

test("T2: SendMessage (A2A-Version 1.0) returns the wrapped v1.0 message; message/send (no header) the unwrapped v0.3 one; both carry the validated id; the text is identical for two different bodies", async () => {
  // Mutants: unwrap the v1 reply or wrap the v0.3 one -> red; put a request field into the text -> red on the identical-text check; drop the id -> red.
  const { d1, env } = fresh();
  try {
    const a = await a2a(env, sendV1({ messageId: "alpha", parts: [{ text: "one" }] }, "req-A"), V1);
    const b = await a2a(env, sendV1({ messageId: "beta", parts: [{ text: "two, quite different" }, { url: "https://x.test/f" }] }, 77), V1);
    assert.equal(a.status, 200);
    assert.equal(a.json.jsonrpc, "2.0");
    assert.equal(a.json.id, "req-A");
    assert.equal(b.json.id, 77);
    const m = a.json.result.message;
    assert.equal(m.role, "ROLE_AGENT");
    assert.equal(typeof m.messageId, "string");
    assert.equal("kind" in m, false, "v1.0 has no kind");
    assert.equal(m.parts.length, 1);
    assert.equal(m.parts[0].text, directionsText(ORIGIN));
    assert.equal(m.parts[0].text, b.json.result.message.parts[0].text, "identical text for two different request bodies");
    assert.notEqual(m.messageId, b.json.result.message.messageId, "a fresh messageId each time");
    assert.match(m.parts[0].text, /POST https:\/\/example\.test\/mcp and call guest_enter/);
    assert.match(m.parts[0].text, /free/);

    const c = await a2a(env, sendV03({ messageId: "gamma" }, "req-C"));
    const d = await a2a(env, sendV03({ parts: [{ kind: "data", data: { any: "thing" } }] }, null));
    assert.equal(c.json.id, "req-C");
    assert.equal(d.json.id, null);
    assert.equal(c.json.result.kind, "message");
    assert.equal(c.json.result.role, "agent");
    assert.equal("message" in c.json.result, false, "v0.3 returns the Message itself, unwrapped");
    assert.deepEqual(c.json.result.parts, [{ kind: "text", text: directionsText(ORIGIN) }]);
    assert.equal(c.json.result.parts[0].text, d.json.result.parts[0].text);
    // 0.3 with a patch number and the header written as "0.3" also speak 0.3; the patch is ignored (v1.0 3.6)
    assert.equal((await a2a(env, sendV03(), { "A2A-Version": "0.3" })).json.result.kind, "message");
    assert.equal((await a2a(env, sendV03(), { "A2A-Version": "0.3.0" })).json.result.kind, "message");
    assert.equal((await a2a(env, sendV1(), { "A2A-Version": "1.0.2" })).json.result.message.role, "ROLE_AGENT");
    // each version speaks only its own send method
    assert.equal((await a2a(env, sendV1())).json.error.code, -32601, "SendMessage without a header is a 0.3 request: not a 0.3 method");
    assert.equal((await a2a(env, sendV03(), V1)).json.error.code, -32601, "message/send under 1.0 is not a 1.0 method");
  } finally {
    d1.close();
  }
});

test("T2b: an unsupported A2A-Version is VersionNotSupportedError -32009, for any method", async () => {
  // Mutant: treat an unknown version as 0.3 -> red.
  const { d1, env } = fresh();
  try {
    for (const v of ["9.9", "2.0", "abc", "1", "1.0-beta"]) {
      const r = await a2a(env, sendV1(), { "A2A-Version": v });
      assert.equal(r.json.error.code, -32009, `A2A-Version ${v}`);
      assert.equal(r.json.id, 1);
    }
    assert.equal((await a2a(env, rpc("tasks/get", { id: "x" }), { "A2A-Version": "9.9" })).json.error.code, -32009);
    assert.deepEqual(today(d1), {}, "a refused version counts nothing");
  } finally {
    d1.close();
  }
});

// ---------- 3. refusals ----------

test("T3a: envelope refusals: oversized, malformed, null / number / array / string bodies, wrong jsonrpc, non-string method, bad ids; none is counted", async () => {
  // Mutants: let a 64 KB+ body through -> red; accept a batch -> red; drop the id-length bound -> red.
  const { d1, env } = fresh();
  try {
    const big = JSON.stringify(sendV1({ parts: [{ text: "x".repeat(A2A_BODY_LIMIT) }] }));
    assert.ok(big.length > A2A_BODY_LIMIT);
    const over = await a2a(env, big, V1);
    assert.equal(over.json.error.code, -32600);
    assert.equal(over.json.id, null);
    // a body just under the bound is read (and refused on its merits, not on size)
    const under = JSON.stringify(sendV1({ parts: [{ text: "x".repeat(A2A_BODY_LIMIT - 400) }] }));
    assert.ok(under.length < A2A_BODY_LIMIT);
    assert.equal((await a2a(env, under, V1)).json.result.message.role, "ROLE_AGENT");
    // a streamed body with no Content-Length is bounded too
    const streamed = new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(big)); c.close(); } });
    const res = await worker.fetch(new Request(`${ORIGIN}/a2a`, { method: "POST", headers: { "A2A-Version": "1.0" }, body: streamed, duplex: "half" } as RequestInit), env);
    assert.equal((await res.json() as any).error.code, -32600);

    assert.equal((await a2a(env, "{not json", V1)).json.error.code, -32700);
    assert.equal((await a2a(env, "", V1)).json.error.code, -32700);
    for (const body of ["null", "42", '"SendMessage"', "true", "[]", JSON.stringify([sendV1()])]) {
      const r = await a2a(env, body, V1);
      assert.equal(r.json.error.code, -32600, body.slice(0, 20));
      assert.equal(r.json.id, null);
    }
    assert.equal((await a2a(env, { ...sendV1(), jsonrpc: "1.0" }, V1)).json.error.code, -32600);
    assert.equal((await a2a(env, { id: 1, method: "SendMessage", params: {} }, V1)).json.error.code, -32600, "no jsonrpc member");
    for (const method of [42, null, { a: 1 }, ["SendMessage"]]) assert.equal((await a2a(env, { jsonrpc: "2.0", id: 1, method }, V1)).json.error.code, -32600);
    assert.equal((await a2a(env, { jsonrpc: "2.0", id: 1 }, V1)).json.error.code, -32600, "no method");
    for (const id of [{ a: 1 }, [1], "x".repeat(300), true]) {
      const r = await a2a(env, sendV1(undefined, id), V1);
      assert.equal(r.json.error.code, -32600, JSON.stringify(id).slice(0, 20));
      assert.equal(r.json.id, null);
    }
    assert.equal((await a2a(env, sendV1(undefined, "x".repeat(256)), V1)).json.id, "x".repeat(256), "256 characters is allowed");
    assert.deepEqual(Object.keys(today(d1)), ["a2a_send"], "only the two accepted sends above counted");
    assert.equal(today(d1).a2a_send, 2);
  } finally {
    d1.close();
  }
});

test("T3b: message validation: params.message missing, parts [42], missing messageId / role / v0.3 kind, wrong role case, empty parts, two part members: -32602, not counted", async () => {
  // Mutants: accept a message with no messageId -> red; accept a Part with two members, or no `kind` on 0.3 -> red; count before validating -> red.
  const { d1, env } = fresh();
  try {
    const bad1: Array<[string, unknown]> = [
      ["no params", rpc("SendMessage")],
      ["no message", rpc("SendMessage", {})],
      ["message a string", rpc("SendMessage", { message: "hi" })],
      ["message an array", rpc("SendMessage", { message: [msgV1()] })],
      ["parts [42]", sendV1({ parts: [42] })],
      ["parts empty", sendV1({ parts: [] })],
      ["parts not an array", sendV1({ parts: { text: "x" } })],
      ["no messageId", sendV1({ messageId: undefined })],
      ["empty messageId", sendV1({ messageId: "" })],
      ["no role", sendV1({ role: undefined })],
      ["role ROLE_AGENT", sendV1({ role: "ROLE_AGENT" })],
      ["role user (0.3 spelling)", sendV1({ role: "user" })],
      ["part with two members", sendV1({ parts: [{ text: "a", url: "https://x.test" }] })],
      ["part with none", sendV1({ parts: [{ mediaType: "text/plain" }] })],
      ["text not a string", sendV1({ parts: [{ text: 5 }] })],
      ["a 0.3 message to 1.0", rpc("SendMessage", { message: msgV03() })],
    ];
    for (const [name, body] of bad1) {
      const r = await a2a(env, body, V1);
      assert.equal(r.json.error?.code, -32602, `1.0: ${name}`);
    }
    const bad03: Array<[string, unknown]> = [
      ["no kind", sendV03({ kind: undefined })],
      ["wrong kind", sendV03({ kind: "task" })],
      ["no messageId", sendV03({ messageId: undefined })],
      ["no role", sendV03({ role: undefined })],
      ["role ROLE_USER", sendV03({ role: "ROLE_USER" })],
      ["parts [42]", sendV03({ parts: [42] })],
      ["text part without kind", sendV03({ parts: [{ text: "x" }] })],
      ["text part, non-string text", sendV03({ parts: [{ kind: "text", text: 1 }] })],
      ["file part without file", sendV03({ parts: [{ kind: "file" }] })],
      ["file with neither bytes nor uri", sendV03({ parts: [{ kind: "file", file: {} }] })],
      ["data part with a string", sendV03({ parts: [{ kind: "data", data: "x" }] })],
      ["unknown part kind", sendV03({ parts: [{ kind: "image", text: "x" }] })],
      ["a 1.0 message to 0.3", rpc("message/send", { message: msgV1() })],
    ];
    for (const [name, body] of bad03) assert.equal((await a2a(env, body)).json.error?.code, -32602, `0.3: ${name}`);
    assert.deepEqual(today(d1), {}, "no invalid send counted");
    // the other valid part shapes are accepted
    assert.ok((await a2a(env, sendV1({ parts: [{ raw: "aGk=" }, { url: "https://x.test/a" }, { data: { k: 1 } }, { text: "t" }] }), V1)).json.result);
    assert.ok((await a2a(env, sendV03({ parts: [{ kind: "file", file: { bytes: "aGk=" } }, { kind: "file", file: { uri: "https://x.test/a" } }, { kind: "data", data: { k: 1 } }] }))).json.result);
    assert.equal(today(d1).a2a_send, 2);
  } finally {
    d1.close();
  }
});

test("T3c: a task reference is TaskNotFound -32001 and not counted (message.taskId, message.referenceTaskIds, either version); only the protocol's named fields count, a taskId inside a data part or metadata is payload; a supplied contextId is -32004, uncounted, in both versions; a push request is -32003", async () => {
  // Mutants: ignore message.taskId -> red; search the payload recursively for taskId -> red on the data-part send; treat contextId as a task -> red (-32001); ignore contextId -> red; accept a push configuration silently -> red.
  const { d1, env } = fresh();
  try {
    assert.equal((await a2a(env, sendV1({ taskId: "nonexistent" }), V1)).json.error.code, -32001);
    assert.equal((await a2a(env, sendV03({ taskId: "nonexistent" }))).json.error.code, -32001);
    assert.equal((await a2a(env, sendV1({ referenceTaskIds: ["t"] }), V1)).json.error.code, -32001);
    assert.equal((await a2a(env, sendV03({ referenceTaskIds: ["t"] }))).json.error.code, -32001);
    assert.deepEqual(today(d1), {});
    // payload is not a task reference: a data part (either version), metadata, and an empty referenceTaskIds are accepted
    assert.ok((await a2a(env, sendV1({ parts: [{ data: { taskId: "inside-a-data-part" } }] }), V1)).json.result);
    assert.ok((await a2a(env, sendV03({ parts: [{ kind: "data", data: { taskId: "inside-a-data-part", nested: { taskId: "x" } } }] }))).json.result);
    assert.ok((await a2a(env, sendV1({ metadata: { taskId: "m" }, referenceTaskIds: [] }), V1)).json.result);
    assert.ok((await a2a(env, rpc("message/send", { message: msgV03(), metadata: { taskId: "m" } }))).json.result);
    assert.equal(today(d1).a2a_send, 4);
    // a supplied contextId: refused, never TaskNotFound, never ignored, uncounted
    for (const [headers, body] of [[V1, sendV1({ contextId: "ctx-1" })], [{}, sendV03({ contextId: "ctx-1" })]] as const) {
      const r = await a2a(env, body, headers);
      assert.equal(r.json.error.code, -32004);
      assert.equal(JSON.stringify(r.json).includes("ctx-1"), false, "the caller's context is not echoed");
    }
    assert.equal(today(d1).a2a_send, 4, "refused contexts are not counted");
    // our replies carry no contextId (and no taskId), in either version
    for (const r of [(await a2a(env, sendV1(), V1)).json.result.message, (await a2a(env, sendV03())).json.result]) {
      assert.equal("contextId" in r, false);
      assert.equal("taskId" in r, false);
    }
    assert.equal((await a2a(env, rpc("SendMessage", { message: msgV1(), configuration: { taskPushNotificationConfig: { url: "https://x.test/hook" } } }), V1)).json.error.code, -32003);
    assert.equal((await a2a(env, rpc("message/send", { message: msgV03(), configuration: { pushNotificationConfig: { url: "https://x.test/hook" } } }))).json.error.code, -32003);
    assert.equal(today(d1).a2a_send, 6, "only the accepted sends counted");
  } finally {
    d1.close();
  }
});

test("T3d: notifications: no id member gets 204 and an empty body (a send counted, a refused send and an unknown method not); \"id\": null is an ordinary response", async () => {
  // Mutants: answer a notification with a body -> red; count a refused notification -> red; treat id:null as a notification -> red.
  const { d1, env } = fresh();
  try {
    const note = (method: string, params?: unknown) => ({ jsonrpc: "2.0", method, params });
    const accepted = await a2a(env, note("SendMessage", { message: msgV1() }), V1);
    assert.equal(accepted.status, 204);
    assert.equal(accepted.text, "");
    assert.deepEqual(today(d1), { a2a_send: 1 }, "an accepted send that is a notification still counts");
    const refused = await a2a(env, note("SendMessage", { message: { messageId: "" } }), V1);
    assert.equal(refused.status, 204);
    assert.equal(refused.text, "");
    const unknown = await a2a(env, note("no/such/method"));
    assert.equal(unknown.status, 204);
    assert.equal(unknown.text, "");
    assert.equal((await a2a(env, note("tasks/get", { id: "x" }))).status, 204, "a refusal-table method as a notification");
    assert.deepEqual(today(d1), { a2a_send: 1 });
    // version failure: a notification is 204, no body, uncounted; the same request with "id": null gets -32009 (amendment A)
    const badVersionNote = await a2a(env, note("SendMessage", { message: msgV1() }), { "A2A-Version": "9.9" });
    assert.equal(badVersionNote.status, 204);
    assert.equal(badVersionNote.text, "");
    const badVersionNull = await a2a(env, { jsonrpc: "2.0", id: null, method: "SendMessage", params: { message: msgV1() } }, { "A2A-Version": "9.9" });
    assert.equal(badVersionNull.status, 200);
    assert.equal(badVersionNull.json.error.code, -32009);
    assert.equal(badVersionNull.json.id, null);
    assert.deepEqual(today(d1), { a2a_send: 1 }, "neither version failure counted");
    // an envelope that fails before the id can be read still answers, with id null
    assert.equal((await a2a(env, "{oops")).json.id, null);
    assert.equal((await a2a(env, { method: "x" })).status, 400, "no jsonrpc member: refused, even with no id");
    const nullId = await a2a(env, { jsonrpc: "2.0", id: null, method: "SendMessage", params: { message: msgV1() } }, V1);
    assert.equal(nullId.status, 200);
    assert.equal(nullId.json.id, null);
    assert.ok(nullId.json.result.message);
    assert.equal(today(d1).a2a_send, 2);
  } finally {
    d1.close();
  }
});

test("T3e: GET, DELETE, PUT and HEAD on /a2a are 405 with Allow: POST and a pointer to both cards, and read no body; the OPTIONS preflight allows A2A-Version and Content-Type", async () => {
  // Mutants: serve GET -> red; drop A2A-Version from the router's preflight list -> red; read the body before refusing the method -> red (the stream was pulled).
  const { d1, env } = fresh();
  try {
    for (const method of ["GET", "DELETE", "PUT", "HEAD", "PATCH"]) {
      const r = await send(env, method, "/a2a", { body: "{}" });
      assert.equal(r.status, 405, method);
      assert.equal(r.headers.get("Allow"), "POST", method);
      if (method !== "HEAD") {
        assert.ok(r.text.includes("/.well-known/agent-card.json") && r.text.includes("/.well-known/agent.json"), `${method}: the pointer`);
      }
    }
    // the refusal happens before any body is read: a stream body that records whether it was pulled
    for (const method of ["DELETE", "PUT", "PATCH"]) {
      let pulled = false;
      const body = new ReadableStream({ pull(c) { pulled = true; c.enqueue(new TextEncoder().encode("{}")); c.close(); } }, { highWaterMark: 0 });
      const res = await worker.fetch(new Request(`${ORIGIN}/a2a`, { method, body, duplex: "half" } as RequestInit), env);
      assert.equal(res.status, 405, method);
      assert.equal(pulled, false, `${method}: the body was not read`);
    }
    const pre = await send(env, "OPTIONS", "/a2a", { headers: { Origin: "https://app.test", "Access-Control-Request-Method": "POST" } });
    assert.ok(pre.status < 300);
    assert.equal(pre.headers.get("Access-Control-Allow-Origin"), "*");
    assert.match(pre.headers.get("Access-Control-Allow-Headers") ?? "", /A2A-Version/);
    assert.match(pre.headers.get("Access-Control-Allow-Headers") ?? "", /Content-Type/);
    assert.match(pre.headers.get("Access-Control-Allow-Methods") ?? "", /POST/);
    assert.equal((await a2a(env, sendV1(), V1)).headers.get("Access-Control-Allow-Origin"), "*");
    assert.deepEqual(today(d1), { a2a_send: 1 }, "nothing but the one accepted send counted");
  } finally {
    d1.close();
  }
});

test("T3f: each row of the refusal table, per version, gets its own code; a method the spec does not define is -32601 with the pointer", async () => {
  // Mutants: give SubscribeToTask / tasks/resubscribe -32001 -> red; give a push method -32004 -> red; drop a table row -> -32601 there -> red.
  const { d1, env } = fresh();
  try {
    const table1: Array<[string, number]> = [
      ["SendStreamingMessage", -32004],
      ["SubscribeToTask", -32004],
      ["CreateTaskPushNotificationConfig", -32003],
      ["GetTaskPushNotificationConfig", -32003],
      ["ListTaskPushNotificationConfigs", -32003],
      ["DeleteTaskPushNotificationConfig", -32003],
      ["GetExtendedAgentCard", -32004],
      ["GetTask", -32001],
      ["CancelTask", -32001],
      ["ListTasks", -32004],
    ];
    for (const [method, code] of table1) {
      const r = await a2a(env, rpc(method, { id: "t" }), V1);
      assert.equal(r.json.error?.code, code, `1.0 ${method}`);
      assert.equal(r.json.id, 1);
    }
    const table03: Array<[string, number]> = [
      ["message/stream", -32004],
      ["tasks/resubscribe", -32004],
      ["tasks/pushNotificationConfig/set", -32003],
      ["tasks/pushNotificationConfig/get", -32003],
      ["tasks/pushNotificationConfig/list", -32003],
      ["tasks/pushNotificationConfig/delete", -32003],
      ["agent/getAuthenticatedExtendedCard", -32007],
      ["tasks/get", -32001],
      ["tasks/cancel", -32001],
    ];
    for (const [method, code] of table03) assert.equal((await a2a(env, rpc(method, { id: "t" }))).json.error?.code, code, `0.3 ${method}`);
    // a v1.0 method under 0.3 and the reverse are not defined by that version
    assert.equal((await a2a(env, rpc("GetTask", { id: "t" }))).json.error.code, -32601);
    assert.equal((await a2a(env, rpc("tasks/get", { id: "t" }), V1)).json.error.code, -32601);
    assert.equal((await a2a(env, rpc("tasks/list", {}))).json.error.code, -32601, "tasks/list is not a 0.3 JSON-RPC method");
    const unknown = await a2a(env, rpc("tools/list"), V1);
    assert.equal(unknown.json.error.code, -32601);
    assert.ok(unknown.json.error.message.includes("/.well-known/agent-card.json") && unknown.json.error.message.includes("/.well-known/agent.json"), "the pointer");
    assert.deepEqual(today(d1), {}, "no refusal counted");
  } finally {
    d1.close();
  }
});

// ---------- 4. the MCP doors ----------

const mcp = (env: Env, path: string, body: unknown) => send(env, "POST", path, { body: typeof body === "string" ? body : JSON.stringify(body) });
const A2A_TEXT = `This is an MCP endpoint and does not speak A2A. A2A: ${ORIGIN}/a2a (cards at ${ORIGIN}/.well-known/agent-card.json and /.well-known/agent.json). To take part over MCP, POST ${ORIGIN}/mcp and call guest_enter.`;

test("T4: /mcp and /mcp/read: message/send and SendMessage get the A2A pointer under -32601; another unknown method gets today's text byte for byte; null and primitive bodies are -32600, not a 500", async () => {
  // Mutants: change the unknown-method text -> red; answer the A2A methods with today's text -> red; drop the null guard -> red (a TypeError 500).
  const { d1, env } = fresh();
  try {
    for (const path of ["/mcp", "/mcp/read"]) {
      for (const method of ["message/send", "SendMessage"]) {
        const r = await mcp(env, path, rpc(method, { message: msgV03() }, 7));
        assert.equal(r.status, 200);
        assert.equal(r.json.error.code, -32601);
        assert.equal(r.json.error.message, A2A_TEXT);
        assert.equal(r.json.id, 7);
      }
      const other = await mcp(env, path, rpc("tasks/get", {}, 8));
      assert.equal(other.json.error.code, -32601);
      assert.equal(other.json.error.message, "method 'tasks/get' not found", "today's text, byte for byte");
      assert.equal(other.json.id, 8);
      assert.equal((await mcp(env, path, rpc("message/stream", {}))).json.error.message, "method 'message/stream' not found", "only the two A2A send methods get the pointer");
      for (const body of ["null", "42", '"x"', "true"]) {
        const r = await mcp(env, path, body);
        assert.equal(r.status, 400, `${path} ${body}`);
        assert.equal(r.json.error.code, -32600);
        assert.equal(r.json.id, null);
      }
      assert.equal((await mcp(env, path, "[]")).json.error.code, -32600, "a batch is still refused");
      assert.equal((await mcp(env, path, "{nope")).json.error.code, -32700, "malformed JSON is unchanged");
      assert.equal((await mcp(env, path, { jsonrpc: "2.0", id: 3 })).json.error.message, "method 'undefined' not found", "an object with no method keeps today's answer");
    }
    // the sentence is true on both doors: guest_enter is listed on /mcp and is not on /mcp/read
    const toolNames = async (path: string) => ((await mcp(env, path, rpc("tools/list"))).json.result.tools as Array<{ name: string }>).map((t) => t.name);
    assert.ok((await toolNames("/mcp")).includes("guest_enter"), "guest_enter is on /mcp");
    assert.equal((await toolNames("/mcp/read")).includes("guest_enter"), false, "and not on /mcp/read, so the text must not say to call it there");
    assert.ok(A2A_TEXT.includes(`POST ${ORIGIN}/mcp and call guest_enter`));
  } finally {
    d1.close();
  }
});

// ---------- 5. the counters ----------

test("T5: each probe door counts once per qualifying request and never for a non-qualifying one", async () => {
  // Mutants: count at the top of handleA2a, before validation -> red; count a known MCP method as unknown -> red; count a null body -> red; count a failed card -> n/a.
  const { d1, env } = fresh();
  try {
    await send(env, "GET", "/.well-known/agent-card.json");
    await send(env, "GET", "/.well-known/agent.json");
    assert.deepEqual(today(d1), { agent_card: 2 });
    await a2a(env, sendV1(), V1);
    await a2a(env, sendV03());
    assert.equal(today(d1).a2a_send, 2);
    // non-qualifying /a2a requests
    await a2a(env, "{bad");
    await a2a(env, sendV1({ messageId: "" }), V1);
    await a2a(env, rpc("tasks/get", {}));
    await send(env, "GET", "/a2a");
    assert.equal(today(d1).a2a_send, 2);
    // the MCP doors
    await mcp(env, "/mcp", rpc("message/send", {}));
    await mcp(env, "/mcp/read", rpc("SendMessage", {}));
    await mcp(env, "/mcp", rpc("no/such", {}));
    await mcp(env, "/mcp/read", rpc("no/such", {}));
    await mcp(env, "/mcp/read", rpc("no/such", {}));
    assert.equal(today(d1).mcp_a2a_probe, 2);
    assert.equal(today(d1).mcp_unknown_method, 3);
    // known methods and non-qualifying payloads count on none of the probe doors
    const before = { ...today(d1) };
    await mcp(env, "/mcp", rpc("ping"));
    await mcp(env, "/mcp/read", rpc("ping"));
    await mcp(env, "/mcp", rpc("notifications/initialized"));
    await mcp(env, "/mcp", "null");
    await mcp(env, "/mcp/read", "42");
    await mcp(env, "/mcp", "{bad");
    await mcp(env, "/mcp", { jsonrpc: "2.0", id: 1, method: 7 });
    await mcp(env, "/mcp", { jsonrpc: "2.0", id: 1 });
    await mcp(env, "/mcp", "[]");
    for (const door of PROBE_DOORS) assert.equal(today(d1)[door], before[door], `${door} unchanged`);
    for (const d of DOORS) assert.equal(d in today(d1), false, `no fixed door written (${d})`);
    // a card fetch that is not a 200 counts nothing: HEAD /a2a-card is a 404 route
    assert.equal((await send(env, "GET", "/.well-known/agent-card.jsonx")).status, 404);
    assert.equal(today(d1).agent_card, 2);
    // nothing about the caller is stored: the door_counts rows hold only (day, door, n)
    const cols = (d1.raw.prepare("PRAGMA table_info(door_counts)").all() as Array<{ name: string }>).map((c) => c.name).sort();
    assert.deepEqual(cols, ["day", "door", "n"]);
  } finally {
    d1.close();
  }
});

test("T5b: a probe door caps at PROBE_DOOR_DAILY_CAP (200), also under concurrency, without spilling onto a fixed door; the fixed doors still cap at 2000", async () => {
  // Mutants: give the probe doors DOOR_DAILY_CAP -> red here and in tool-counter T5; the cap applied to the fixed doors too -> red on skill_md.
  const { d1, env } = fresh();
  try {
    const day = utcDay(Date.now());
    assert.equal(PROBE_DOOR_DAILY_CAP, 200);
    d1.raw.prepare("INSERT INTO door_counts (day, door, n) VALUES (?, 'a2a_send', ?)").run(day, PROBE_DOOR_DAILY_CAP - 10);
    d1.raw.prepare("INSERT INTO door_counts (day, door, n) VALUES (?, 'skill_md', ?)").run(day, PROBE_DOOR_DAILY_CAP);
    await Promise.all(Array.from({ length: 30 }, () => countDoor(env, "a2a_send")));
    assert.equal(today(d1).a2a_send, PROBE_DOOR_DAILY_CAP, "thirty concurrent counts from ten below the cap land at exactly 200");
    await countDoor(env, "skill_md");
    assert.equal(today(d1).skill_md, PROBE_DOOR_DAILY_CAP + 1, "a fixed door at 200 keeps counting: the probe cap does not leak onto it");
    await countDoor(env, "agent_card");
    d1.raw.prepare("UPDATE door_counts SET n = ? WHERE door = 'skill_md'").run(DOOR_DAILY_CAP);
    await countDoor(env, "skill_md");
    assert.equal(today(d1).skill_md, DOOR_DAILY_CAP);
    // the real route at the cap: still 200, the count stays
    const r = await a2a(env, sendV1(), V1);
    assert.ok(r.json.result);
    assert.equal(today(d1).a2a_send, PROBE_DOOR_DAILY_CAP);
    const rep = (await send(env, "GET", "/api/doors")).json;
    const row = (rep.rows as Array<{ door: string; at_cap: boolean }>).find((x) => x.door === "a2a_send")!;
    assert.equal(row.at_cap, true);
    assert.equal((rep.rows as Array<{ door: string; at_cap: boolean }>).find((x) => x.door === "agent_card")!.at_cap, false);
  } finally {
    d1.close();
  }
});

test("T5c: a counter failure leaves every response unchanged, and every probe count goes through ctx.waitUntil without holding the response", async () => {
  // Mutants: await the count instead of handing it to waitUntil -> red (answered-while-held); let a counter throw reach the response -> red.
  const { d1, env } = fresh();
  const realLog = console.log;
  try {
    console.log = () => {};
    const failing = wrapped(env, { failing: [...PROBE_DOORS] }).env;
    const healthy = await a2a(env, sendV1(), V1);
    const broken = await a2a(failing, sendV1(), V1);
    assert.equal(broken.status, 200);
    assert.deepEqual(broken.json.result.message.parts, healthy.json.result.message.parts);
    assert.equal((await send(failing, "GET", "/.well-known/agent-card.json")).status, 200);
    assert.equal((await mcp(failing, "/mcp", rpc("message/send", {}))).json.error.message, A2A_TEXT);
    assert.equal((await mcp(failing, "/mcp/read", rpc("no/such", {}))).json.error.message, "method 'no/such' not found");
    assert.deepEqual(today(d1), { a2a_send: 1 }, "only the healthy call's count landed");

    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const pending: Promise<unknown>[] = [];
    const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {} } as unknown as ExecutionContext;
    const held = wrapped(env, { gate }).env;
    const calls: Array<() => Promise<Raw>> = [
      () => send(held, "GET", "/.well-known/agent-card.json", { ctx }),
      () => send(held, "GET", "/.well-known/agent.json", { ctx }),
      () => send(held, "POST", "/a2a", { body: JSON.stringify(sendV1()), headers: V1, ctx }),
      () => send(held, "POST", "/mcp", { body: JSON.stringify(rpc("message/send", {})), ctx }),
      () => send(held, "POST", "/mcp/read", { body: JSON.stringify(rpc("no/such", {})), ctx }),
    ];
    for (const c of calls) {
      const settled = await Promise.race([c(), new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 1500))]);
      assert.notEqual(settled, "timeout", "answered while the counts were held");
    }
    assert.equal(pending.length, 5, "one count per call, each handed to waitUntil");
    const mid = today(d1);
    assert.equal(mid.agent_card, undefined, "none landed while held");
    release();
    await Promise.all(pending);
    assert.deepEqual(today(d1), { a2a_send: 2, agent_card: 2, mcp_a2a_probe: 1, mcp_unknown_method: 1 });
  } finally {
    console.log = realLog;
    d1.close();
  }
});

// ---------- 7. route parity ----------

test("T7: the card GETs are in /openapi.json, /llms.txt and /api/surface; POST /a2a is in /llms.txt Write and /api/surface and not in /openapi.json; both card paths and /a2a have a grepFor index.ts carries", async () => {
  // Mutants: drop a card ROUTES entry -> red; mark POST /a2a as a GET or drop its entry -> red.
  const { d1, env } = fresh();
  try {
    for (const [method, path] of [["GET", "/.well-known/agent-card.json"], ["GET", "/.well-known/agent.json"], ["POST", "/a2a"]] as const) {
      const spec = ROUTES.find((r) => r.method === method && r.path === path);
      assert.ok(spec, `${method} ${path} is in ROUTES`);
      assert.equal(spec!.auth, "none");
      assert.ok(spec!.grepFor, `${method} ${path} has a grepFor anchor`);
    }
    const llms = (await send(env, "GET", "/llms.txt")).text;
    const openapi = (await send(env, "GET", "/openapi.json")).json;
    const surface = (await send(env, "GET", "/api/surface")).json;
    const routes = surface.routes as Array<{ method: string; path: string }>;
    for (const path of ["/.well-known/agent-card.json", "/.well-known/agent.json"]) {
      assert.ok(openapi.paths[path]?.get, `${path} in /openapi.json`);
      assert.ok(llms.includes(`GET  ${ORIGIN}${path} `), `${path} in /llms.txt Read`);
      assert.ok(routes.some((r) => r.method === "GET" && r.path === path), `${path} in /api/surface`);
    }
    assert.equal(openapi.paths["/a2a"], undefined, "a write route is not in the read-only OpenAPI document");
    assert.equal(renderOpenApi(ORIGIN, "Commonhold").paths["/a2a"], undefined);
    assert.ok(routes.some((r) => r.method === "POST" && r.path === "/a2a"), "POST /a2a in /api/surface");
    const at = llms.lastIndexOf(`POST ${ORIGIN}/a2a `);
    assert.ok(at > 0, "POST /a2a is in /llms.txt");
    const noneGroup = llms.indexOf(AUTH_LABEL.none);
    assert.ok(noneGroup > 0 && at > noneGroup, "and it sits under the no-credential write group");
    assert.ok(llms.includes(`${ORIGIN}/.well-known/agent-card.json (1.0)`) && llms.includes(`${ORIGIN}/a2a`), "the Connect-section line names the cards and /a2a");
  } finally {
    d1.close();
  }
});

// ---------- amendment E: the directions ride on every error ----------

const ourInfo = (directions: string) => ({ "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason: "SEE_DIRECTIONS", domain: "example.test", metadata: { directions } });

test("T3g: every JSON-RPC error /a2a sends carries the fixed directions in error.data (v1.0: an array of @type objects; otherwise an object) and never caller text", async () => {
  // Mutants: drop error.data from one path (envelope, version, refusal table, validation) -> red; interpolate the method name or id into the directions -> red.
  const { d1, env } = fresh();
  try {
    const directions = directionsText(ORIGIN);
    const secret = "CALLER-TEXT-7731";
    const cases: Array<[string, Raw]> = [
      ["parse", await a2a(env, "{bad")],
      ["oversize", await a2a(env, JSON.stringify(sendV1({ parts: [{ text: secret + "x".repeat(A2A_BODY_LIMIT) }] })), V1)],
      ["not an object", await a2a(env, "[1]")],
      ["bad jsonrpc", await a2a(env, { jsonrpc: "1.0", id: 1, method: secret })],
      ["bad id", await a2a(env, { jsonrpc: "2.0", id: { a: secret }, method: "SendMessage" })],
      ["version", await a2a(env, sendV1(), { "A2A-Version": "9.9" })],
      ["unknown 1.0", await a2a(env, rpc(secret), V1)],
      ["unknown 0.3", await a2a(env, rpc(secret))],
      ["invalid params 1.0", await a2a(env, rpc("SendMessage", { message: secret }), V1)],
      ["invalid params 0.3", await a2a(env, rpc("message/send", { message: secret }))],
      ["task not found", await a2a(env, sendV1({ taskId: secret }), V1)],
      ["context", await a2a(env, sendV03({ contextId: secret }))],
      ["push", await a2a(env, rpc("tasks/pushNotificationConfig/set", { id: secret }))],
      ["streaming 1.0", await a2a(env, rpc("SendStreamingMessage", {}), V1)],
      ["extended 0.3", await a2a(env, rpc("agent/getAuthenticatedExtendedCard"))],
    ];
    for (const [name, r] of cases) {
      assert.ok(r.json.error, `${name}: an error`);
      const data = r.json.error.data;
      assert.ok(data, `${name}: error.data present`);
      assert.ok(JSON.stringify(data).includes(directions), `${name}: carries the fixed directions`);
      assert.equal(r.text.includes(secret), false, `${name}: no caller text anywhere in the response`);
    }
    // v1.0: an array of objects each with an @type (v1.0 9.5); everything else: the plain object
    const v1err = cases.find(([n]) => n === "unknown 1.0")![1].json.error.data;
    assert.ok(Array.isArray(v1err) && v1err.every((o: any) => typeof o["@type"] === "string"));
    assert.equal(v1err.length, 1, "a standard code (-32601): the directions entry alone");
    assert.deepEqual(v1err[0], ourInfo(directions));
    // every A2A-specific code under 1.0: data[0] is the canonical ErrorInfo (domain a2a-protocol.org, reason the UPPER_SNAKE error type), data[1] the directions entry
    const specific: Array<[string, number, string, unknown]> = [
      ["task not found", -32001, "TASK_NOT_FOUND", sendV1({ taskId: "t" })],
      ["streaming", -32004, "UNSUPPORTED_OPERATION", rpc("SendStreamingMessage", {})],
      ["context", -32004, "UNSUPPORTED_OPERATION", sendV1({ contextId: "c" })],
      ["extended card", -32004, "UNSUPPORTED_OPERATION", rpc("GetExtendedAgentCard")],
      ["push method", -32003, "PUSH_NOTIFICATION_NOT_SUPPORTED", rpc("CreateTaskPushNotificationConfig", {})],
      ["push in a send", -32003, "PUSH_NOTIFICATION_NOT_SUPPORTED", rpc("SendMessage", { message: msgV1(), configuration: { taskPushNotificationConfig: {} } })],
    ];
    for (const [name, code, reason, body] of specific) {
      const r = await a2a(env, body, V1);
      assert.equal(r.json.error.code, code, name);
      const d = r.json.error.data;
      assert.equal(d.length, 2, `${name}: two entries`);
      assert.deepEqual(d[0], { "@type": "type.googleapis.com/google.rpc.ErrorInfo", reason, domain: "a2a-protocol.org" }, `${name}: the canonical ErrorInfo first`);
      assert.deepEqual(d[1], ourInfo(directions), `${name}: the directions entry second`);
    }
    // the other standard codes under 1.0 carry the directions entry alone
    for (const [name, r] of [["parse", await a2a(env, "{bad", V1)], ["invalid params", await a2a(env, rpc("SendMessage", { message: "x" }), V1)], ["invalid request", await a2a(env, "[1]", V1)]] as const) {
      assert.deepEqual(r.json.error.data, [ourInfo(directions)], name);
    }
    assert.deepEqual(cases.find(([n]) => n === "unknown 0.3")![1].json.error.data, { directions });
    assert.deepEqual(cases.find(([n]) => n === "parse")![1].json.error.data, { directions });
    // the same paragraph a success carries
    assert.equal((await a2a(env, sendV03())).json.result.parts[0].text, directions);
  } finally {
    d1.close();
  }
});

// ---------- hub review fixes ----------

test("T3h: a method named like an inherited Object member is an unknown method, -32601 with a message and the directions, in both versions", async () => {
  // Mutant: restore the bracket lookup REFUSALS[version][method] -> red (an error with no code and no message).
  const { d1, env } = fresh();
  try {
    const directions = directionsText(ORIGIN);
    for (const method of ["constructor", "toString", "__proto__", "hasOwnProperty", "valueOf", "isPrototypeOf"]) {
      for (const headers of [V1, {}] as const) {
        const r = await a2a(env, `{"jsonrpc":"2.0","id":1,"method":"${method}"}`, headers);
        assert.equal(r.json.error?.code, -32601, `${method} ${JSON.stringify(headers)}`);
        assert.equal(typeof r.json.error.message, "string");
        assert.ok(r.json.error.message.length > 0);
        assert.ok(JSON.stringify(r.json.error.data).includes(directions));
      }
    }
    assert.deepEqual(today(d1), {});
  } finally {
    d1.close();
  }
});

test("T3i: an envelope error from a caller that sent A2A-Version 1.0 carries the v1.0 error.data array (@type objects); with no header, the plain object", async () => {
  // Mutant: pass null instead of the negotiated version to the envelope errors -> red.
  const { d1, env } = fresh();
  try {
    const directions = directionsText(ORIGIN);
    const oversized = JSON.stringify(sendV1({ parts: [{ text: "x".repeat(A2A_BODY_LIMIT) }] }));
    for (const [name, body] of [["malformed", "{bad"], ["oversized", oversized], ["not an object", "[1]"], ["bad jsonrpc", '{"jsonrpc":"1.0","id":1,"method":"x"}']] as const) {
      const v1 = (await a2a(env, body, V1)).json.error.data;
      assert.ok(Array.isArray(v1) && v1.length > 0 && v1.every((o: any) => typeof o["@type"] === "string"), `${name} under 1.0`);
      assert.deepEqual(v1, [ourInfo(directions)], `${name}: domain, reason and metadata pinned (a standard code: the directions entry alone)`);
      assert.deepEqual((await a2a(env, body)).json.error.data, { directions }, `${name} with no header`);
    }
    // an unsupported version still gets the plain object (the shape is v1.0's only when 1.0 was negotiated)
    assert.deepEqual((await a2a(env, "{bad", { "A2A-Version": "9.9" })).json.error.data, { directions });
  } finally {
    d1.close();
  }
});

// ---------- round-1 review fixes ----------

test("T3j: optional string fields: an EMPTY taskId / contextId / referenceTaskIds is absent (accepted, counted); a non-string or malformed one is -32602 and uncounted; a non-empty referenceTaskIds stays -32001", async () => {
  // Mutants: treat an empty string as supplied -> red on the accepted sends; drop the type checks in validMessage -> red on the -32602 rows; treat a non-empty array as absent -> red.
  const { d1, env } = fresh();
  try {
    const ok: Array<Record<string, unknown>> = [{ taskId: "" }, { contextId: "" }, { taskId: "", contextId: "" }, { referenceTaskIds: [] }, { taskId: null, contextId: null, referenceTaskIds: null }];
    for (const over of ok) {
      assert.ok((await a2a(env, sendV1(over), V1)).json.result, `1.0 ${JSON.stringify(over)}`);
      assert.ok((await a2a(env, sendV03(over))).json.result, `0.3 ${JSON.stringify(over)}`);
    }
    assert.equal(today(d1).a2a_send, ok.length * 2);
    const before = today(d1).a2a_send;
    const bad: Array<Record<string, unknown>> = [{ taskId: 5 }, { taskId: {} }, { taskId: true }, { contextId: 7 }, { contextId: ["c"] }, { referenceTaskIds: "task-1" }, { referenceTaskIds: [1] }, { referenceTaskIds: ["a", null] }, { referenceTaskIds: {} }];
    for (const over of bad) {
      assert.equal((await a2a(env, sendV1(over), V1)).json.error?.code, -32602, `1.0 ${JSON.stringify(over)}`);
      assert.equal((await a2a(env, sendV03(over))).json.error?.code, -32602, `0.3 ${JSON.stringify(over)}`);
    }
    assert.equal((await a2a(env, sendV1({ referenceTaskIds: ["t"] }), V1)).json.error.code, -32001);
    assert.equal((await a2a(env, sendV03({ referenceTaskIds: ["t"] }))).json.error.code, -32001);
    assert.equal((await a2a(env, sendV1({ taskId: "t" }), V1)).json.error.code, -32001);
    assert.equal((await a2a(env, sendV1({ contextId: "c" }), V1)).json.error.code, -32004);
    assert.equal(today(d1).a2a_send, before, "no refusal counted");
  } finally {
    d1.close();
  }
});

test("T3k: version text is Major.Minor without leading zeros; the A2A-Version query parameter is honoured and the header wins over it", async () => {
  // Mutants: the old digit pattern (accepts 01.00) -> red; drop the query fallback -> red; let the query win over the header -> red.
  const { d1, env } = fresh();
  try {
    for (const v of ["01.00", "1.00", "00.3", "0.03", "01.0", "1.0.", ".3", "1..0"]) {
      assert.equal((await a2a(env, sendV1(), { "A2A-Version": v })).json.error?.code, -32009, `A2A-Version ${JSON.stringify(v)}`);
    }
    assert.ok((await a2a(env, sendV1(), { "A2A-Version": "1.0.10" })).json.result, "a patch number is ignored");
    const q = (query: string, body: unknown, headers: Record<string, string> = {}) => send(env, "POST", `/a2a${query}`, { body: JSON.stringify(body), headers });
    assert.ok((await q("?A2A-Version=1.0", sendV1())).json.result.message, "the query parameter alone selects 1.0");
    assert.equal((await q("?A2A-Version=9.9", sendV1())).json.error.code, -32009);
    assert.equal((await q("?A2A-Version=01.00", sendV1())).json.error.code, -32009);
    assert.equal((await q("?A2A-Version=1.0", sendV03(), { "A2A-Version": "0.3" })).json.result.kind, "message", "the header (0.3) wins over the query (1.0)");
    assert.ok((await q("?A2A-Version=0.3", sendV1(), { "A2A-Version": "1.0" })).json.result.message, "and the header (1.0) wins over the query (0.3)");
  } finally {
    d1.close();
  }
});

test("T3l: the served POST /a2a note says a notification gets 204 and no body and repeats the 64 KB bound; /api/doors' route description is built from the probe door list and cap", () => {
  // Mutants: drop the notification clause or the bound from the note -> red; type the probe count or cap as a literal that no longer matches -> red.
  const spec = ROUTES.find((r) => r.method === "POST" && r.path === "/a2a")!;
  assert.match(spec.note ?? "", /notification/);
  assert.match(spec.note ?? "", /204 and no body/);
  assert.match(spec.note ?? "", new RegExp(`${A2A_BODY_LIMIT / 1024} KB`));
  assert.match(spec.description, new RegExp(`${A2A_BODY_LIMIT / 1024} KB`));
  assert.equal(A2A_BODY_LIMIT, 64 * 1024);
  const doors = ROUTES.find((r) => r.method === "GET" && r.path === "/api/doors")!.description;
  assert.ok(doors.includes(`the ${PROBE_DOORS.length} probe doors are capped at ${PROBE_DOOR_DAILY_CAP} a day each`));
  for (const d of PROBE_DOORS) assert.ok(doors.includes(d), `the route description names ${d}`);
});
