// T5 (drafts/BRIEF-OPERATORS-PAGE-2026-11-18.md): the executable paste fixture. The page's paste is served text an agent follows literally, so this runs its steps as a
// scripted agent against the REAL /mcp door on local D1 (the real router, real Ed25519 keys, nothing mocked): a first run, an interrupted first run, an evicted unpromoted visitor,
// a transient failure, a refused comment, later runs with a drained inbox, and token recovery. The scripted agent does not parse the English. A second test keeps it in step with the
// English: every tool(arguments) in the paste must be a tool on the full door with those argument names, and must match, name for name and argument for argument, what the agent called.
//
// Mutants that turn it red (run records in the builder's report): the paste names a tool or argument that src/mcp.ts does not have; the agent gains a call the paste does not
// describe; the paste's eviction rule is dropped from the agent (a second enter on a transient failure).

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import { createLocalD1, seedCitizens, seedPost, seedTopic, seedVisitor, guestEnv, call, count, freshIp } from "./helpers/guest.ts";
import { genKeypair, signBind, signRecover, type Keypair } from "./helpers/resident.ts";
import { TOOLS } from "../src/mcp.ts";
import { ROUTES } from "../src/discovery.ts";
import { operatorsPaste, renderOperators, figuresText } from "../src/operators.ts";
import { SHOWHOME_VISITORS_RING } from "../src/showhome.ts";
import type { Env } from "../src/society.ts";

const ORIGIN = "https://example.test";

// ---------- the scripted agent: the paste's steps, as code ----------

interface State {
  handle: string;
  visitor_id: number;
  token: string | null;
  cursor: string | null;
  comment_accepted: boolean;
  key_bound: boolean;
}
interface Disk {
  state: State | null; // commonhold-guest.json
  failed: State[]; // commonhold-guest.failed.json
  key: Keypair | null; // commonhold-guest.key
}
interface Call {
  tool: string;
  keys: string[];
}
class TransportFailure extends Error {}

function newAgent(env: Env, handle: string) {
  const disk: Disk = { state: null, failed: [], key: null };
  const calls: Call[] = [];
  const mcp = async (tool: string, args: Record<string, unknown>, failTool?: string) => {
    calls.push({ tool, keys: Object.keys(args).sort() });
    if (failTool === tool) throw new TransportFailure(`simulated timeout calling ${tool}`);
    const r = await call(env, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }, { "CF-Connecting-IP": freshIp() });
    assert.equal(r.status, 200, "tools/call answers 200 at the transport level, errors included");
    const body = JSON.parse(r.body.result.content[0].text) as Record<string, any>;
    return { isError: r.body.result.isError === true, body };
  };
  const unknownToken = (r: { isError: boolean; body: Record<string, any> }) => r.isError && typeof r.body.error === "string" && r.body.error.includes("Unknown guest token");

  // One run of the paste. Steps are numbered as in the paste.
  async function run(opts: { body?: string; kind?: "comment" | "critique"; stopAfterEnter?: boolean; failTool?: string; topicId?: number } = {}) {
    const log: string[] = [];
    try {
      const firstRun = disk.state === null;
      // 1-2. state; enter if there is no file
      let enteredTopics: Array<{ id: number }> = [];
      if (disk.state === null) {
        const e = await mcp("guest_enter", { handle, model: "scripted-test-agent" }, opts.failTool);
        if (e.isError) return { log: ["enter refused"], firstRun };
        enteredTopics = e.body.topics;
        disk.state = { handle, visitor_id: e.body.visitor_id, token: e.body.token, cursor: null, comment_accepted: false, key_bound: false };
        log.push("entered");
        if (opts.stopAfterEnter) return { log, firstRun };
      }
      const st = disk.state;
      // 7. a lost token with a bound key: recover, never enter again
      if (st.token === null) {
        if (!st.key_bound) {
          log.push("token lost, no key bound: stop and tell the operator");
          return { log, firstRun };
        }
        const kp = disk.key!;
        const { assertion } = await signRecover(kp, st.visitor_id, st.handle);
        const r = await mcp("resident_token", { number: st.visitor_id, assertion }, opts.failTool);
        if (r.isError) return { log: [...log, "recover refused"], firstRun };
        st.token = r.body.token;
        log.push("recovered");
      }
      // 3. the first accepted comment
      if (!st.comment_accepted) {
        const topicId = opts.topicId ?? enteredTopics[0]?.id ?? ((await call(env, "GET", "/api/topics")).body.open as Array<{ id: number }>)[0]!.id;
        await mcp("read_post", { post_id: topicId }, opts.failTool);
        const c = await mcp("guest_comment", { token: st.token, post_id: topicId, body: opts.body ?? "A first comment that adds something.", kind: opts.kind ?? "critique" }, opts.failTool);
        if (!c.isError) {
          st.comment_accepted = true;
          log.push("commented");
        } else if (unknownToken(c) && !st.comment_accepted) {
          // 4. eviction of an unused token: archive, enter once, save, stop for this run
          disk.failed.push({ ...st });
          disk.state = null;
          const e = await mcp("guest_enter", { handle, model: "scripted-test-agent" }, opts.failTool);
          if (!e.isError) disk.state = { handle, visitor_id: e.body.visitor_id, token: e.body.token, cursor: null, comment_accepted: false, key_bound: false };
          log.push("evicted: archived and entered once");
          return { log, firstRun };
        } else {
          log.push(`comment not accepted: ${String(c.body.error).slice(0, 60)}`);
          return { log, firstRun };
        }
      }
      // 5. bind a key, once a comment is accepted
      if (st.comment_accepted && !st.key_bound) {
        if (disk.key === null) disk.key = await genKeypair();
        const kp = disk.key;
        const { assertion } = await signBind(kp, st.visitor_id, st.handle);
        const b = await mcp("resident_bind", { token: st.token, public_key: kp.publicKey, assertion }, opts.failTool);
        if (!b.isError) {
          st.key_bound = true;
          log.push("bound");
        } else log.push("bind refused");
      }
      // 6. the inbox, on every run after the first
      if (!firstRun) {
        let more = true;
        let pages = 0;
        while (more) {
          assert.ok(++pages <= 5, "the inbox loop must make progress: a saved cursor moves it on");
          const args: Record<string, unknown> = { guest: st.visitor_id };
          if (st.cursor !== null) args.cursor = st.cursor;
          const i =await mcp("guest_inbox", args, opts.failTool);
          if (i.isError) break;
          st.cursor = i.body.next_cursor ?? st.cursor;
          more = i.body.has_more === true;
          log.push(`inbox ${more ? "(more)" : "(drained)"}`);
        }
      }
      return { log, firstRun };
    } catch (e) {
      if (e instanceof TransportFailure) return { log: ["transport failure: stopped, nothing retried"], firstRun: false };
      throw e;
    }
  }
  return { disk, calls, run, mcp };
}

function fresh() {
  const d1 = createLocalD1();
  const { alice } = seedCitizens(d1);
  const post = seedPost(d1, alice);
  const topic = seedTopic(d1);
  return { d1, env: guestEnv(d1), alice, post, topic };
}

const enters = (d1: ReturnType<typeof createLocalD1>) => count(d1, "SELECT COUNT(*) AS n FROM visitors") + count(d1, "SELECT COUNT(*) AS n FROM guests");
const allCalls = new Map<string, Set<string>>();
function recordUnion(calls: Call[]) {
  for (const c of calls) {
    const s = allCalls.get(c.tool) ?? new Set<string>();
    for (const k of c.keys) s.add(k);
    allCalls.set(c.tool, s);
  }
}
const names = (c: Call[], tool: string) => c.filter((x) => x.tool === tool).length;

// ---------- the scenarios ----------

test("T5 first run: enter, comment, bind, in order, state saved at each step; the first run reads no inbox", async () => {
  const { d1, env } = fresh();
  try {
    const a = newAgent(env, "scripted-one");
    const r = await a.run();
    assert.deepEqual(r.log, ["entered", "commented", "bound"]);
    assert.deepEqual(a.calls.map((c) => c.tool), ["guest_enter", "read_post", "guest_comment", "resident_bind"]);
    assert.deepEqual(a.disk.state && { c: a.disk.state.comment_accepted, k: a.disk.state.key_bound }, { c: true, k: true });
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM guests WHERE resident_at IS NOT NULL"), 1, "the agent really became a resident");
    recordUnion(a.calls);
  } finally {
    d1.close();
  }
});

test("T5 interrupted first run: it stops after enter; the next run resumes with no second enter and no new key, then comments and binds", async () => {
  const { d1, env } = fresh();
  try {
    const a = newAgent(env, "scripted-two");
    const r1 = await a.run({ stopAfterEnter: true });
    assert.deepEqual(r1.log, ["entered"]);
    const saved = { ...a.disk.state! };
    assert.equal(a.disk.key, null, "no key yet");
    const r2 = await a.run();
    assert.deepEqual(r2.log.slice(0, 2), ["commented", "bound"]);
    assert.equal(names(a.calls, "guest_enter"), 1, "one enter across both runs");
    assert.equal(a.disk.state!.visitor_id, saved.visitor_id, "the same visitor number");
    assert.equal(a.disk.state!.token, saved.token, "the same token");
    assert.equal(a.disk.failed.length, 0);
    recordUnion(a.calls);
  } finally {
    d1.close();
  }
});

test("T5 evicted unpromoted visitor: the ring is pushed past the saved row; the resumed run gets the MCP isError 'Unknown guest token', archives, enters once and does not loop; the next run comments", async () => {
  const { d1, env } = fresh();
  try {
    const a = newAgent(env, "scripted-three");
    await a.run({ stopAfterEnter: true });
    const firstNumber = a.disk.state!.visitor_id;
    // a full ring of newer visitors, then one real enter by someone else, which prunes the oldest rows
    for (let i = 0; i < SHOWHOME_VISITORS_RING; i++) await seedVisitor(d1, `filler${i}`);
    const other = await call(env, "POST", "/api/showhome/enter", { handle: "someone-else", model: "m" }, { "CF-Connecting-IP": freshIp() });
    assert.equal(other.status, 201);
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM visitors WHERE id = ?", firstNumber), 0, "the saved visitor row really is gone");
    const before = names(a.calls, "guest_enter");
    const r = await a.run();
    assert.deepEqual(r.log, ["evicted: archived and entered once"]);
    assert.equal(names(a.calls, "guest_enter") - before, 1, "exactly one enter in the resumed run");
    assert.equal(a.disk.failed.length, 1, "the failed attempt is archived, not deleted");
    assert.equal(a.disk.failed[0]!.visitor_id, firstNumber);
    assert.notEqual(a.disk.state!.visitor_id, firstNumber);
    const r2 = await a.run();
    assert.ok(r2.log.includes("commented"), "the next run comments with the new token");
    assert.equal(names(a.calls, "guest_enter") - before, 1, "and never entered again");
    recordUnion(a.calls);
  } finally {
    d1.close();
  }
});

test("T5 the text the paste keys on is really what the door returns for an evicted token: isError true, HTTP 200, 'Unknown guest token'", async () => {
  const { d1, env, topic } = fresh();
  try {
    const a = newAgent(env, "scripted-four");
    const r = await a.mcp("guest_comment", { token: "commonhold_visit_not_a_real_token", post_id: topic, body: "hello there" });
    assert.equal(r.isError, true);
    assert.match(r.body.error, /Unknown guest token/);
  } finally {
    d1.close();
  }
});

test("T5 transient failure and refusal: a timeout or a refused comment never triggers a new enter; a rephrased comment on a later run is accepted", async () => {
  const { d1, env } = fresh();
  try {
    const a = newAgent(env, "scripted-five");
    await a.run({ stopAfterEnter: true });
    const visitors = enters(d1);
    const t = await a.run({ failTool: "guest_comment" });
    assert.deepEqual(t.log, ["transport failure: stopped, nothing retried"]);
    const refused = await a.run({ body: "see http://example.invalid/page for more" });
    assert.ok(refused.log[0]!.startsWith("comment not accepted"), refused.log[0]);
    assert.equal(enters(d1), visitors, "no new visitor row after a timeout and a refusal");
    assert.equal(names(a.calls, "guest_enter"), 1);
    assert.equal(a.disk.failed.length, 0);
    const ok = await a.run({ body: "Here is the same point without a link." });
    assert.ok(ok.log.includes("commented") && ok.log.includes("bound"));
    recordUnion(a.calls);
  } finally {
    d1.close();
  }
});

test("T5 later runs: guest_inbox with the saved cursor, has_more drained, the new cursor saved; a run with nothing new keeps the cursor", async () => {
  const { d1, env, post, alice } = fresh();
  try {
    const a = newAgent(env, "scripted-six");
    await a.run(); // first run: enter, comment, bind
    const st = a.disk.state!;
    const label = `@resident:${st.handle}#${st.visitor_id}`;
    const ins = d1.raw.prepare("INSERT INTO comments (post_id, citizen_id, body, depth, created_at) VALUES (?, ?, ?, 0, ?)");
    for (let i = 0; i < 101; i++) ins.run(post, alice, `${label} addressed comment ${i}`, Date.now());
    const calls0 = a.calls.length;
    const r = await a.run();
    assert.deepEqual(r.log, ["inbox (more)", "inbox (drained)"], "101 mentions is two pages at a limit of 100: the second call follows has_more");
    const inboxCalls = a.calls.slice(calls0).filter((c) => c.tool === "guest_inbox");
    assert.deepEqual(inboxCalls.map((c) => c.keys), [["guest"], ["cursor", "guest"]], "no cursor the first time, the returned cursor after");
    assert.ok(typeof a.disk.state!.cursor === "string" && a.disk.state!.cursor.length > 0, "the final cursor is saved");
    const saved = a.disk.state!.cursor;
    const r2 = await a.run();
    assert.deepEqual(r2.log, ["inbox (drained)"]);
    assert.equal(a.disk.state!.cursor, saved, "nothing new: the cursor is unchanged");
    recordUnion(a.calls);
  } finally {
    d1.close();
  }
});

test("T5 recovery: the token is lost and a key is bound; the agent signs resident_token, saves the new token, never calls guest_enter, and the new token works", async () => {
  const { d1, env, topic } = fresh();
  try {
    const a = newAgent(env, "scripted-seven");
    await a.run();
    const oldToken = a.disk.state!.token!;
    a.disk.state!.token = null; // the token is lost
    const enterCalls = names(a.calls, "guest_enter");
    const r = await a.run();
    assert.ok(r.log.includes("recovered"));
    assert.equal(names(a.calls, "guest_enter"), enterCalls, "recovery never enters again");
    assert.notEqual(a.disk.state!.token, oldToken, "a new token was saved");
    const w = await a.mcp("guest_comment", { token: a.disk.state!.token, post_id: topic, body: "A comment with the recovered token." });
    assert.equal(w.isError, false);
    const dead = await a.mcp("guest_comment", { token: oldToken, post_id: topic, body: "A comment with the dead token." });
    assert.equal(dead.isError, true, "the old token died");
    recordUnion(a.calls);
  } finally {
    d1.close();
  }
});

// ---------- the paste and the agent stay in step ----------

function pasteCalls(paste: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const m of paste.matchAll(/\b([a-z]+_[a-z_]+)\(([a-z_, ]*)\)/g)) {
    const set = out.get(m[1]!) ?? new Set<string>();
    for (const a of m[2]!.split(",").map((x) => x.trim()).filter(Boolean)) set.add(a);
    out.set(m[1]!, set);
  }
  return out;
}

test("T5 the paste's tool(arguments) are exactly the tools and arguments the scripted agent called, and every one exists on the full /mcp door with those argument names (a required argument may not be missing)", () => {
  const paste = operatorsPaste(ORIGIN);
  const named = pasteCalls(paste);
  assert.deepEqual([...named.keys()].sort(), ["guest_comment", "guest_enter", "guest_inbox", "read_post", "resident_bind", "resident_token"]);
  // against src/mcp.ts
  for (const [tool, args] of named) {
    const def = TOOLS.find((t) => t.name === tool);
    assert.ok(def, `${tool} is a tool on the full door`);
    const props = Object.keys((def!.inputSchema.properties ?? {}) as Record<string, unknown>);
    for (const a of args) assert.ok(props.includes(a), `${tool} has an argument named ${a}`);
    for (const req of (def!.inputSchema.required ?? []) as string[]) assert.ok(args.has(req), `${tool} requires ${req} and the paste names it`);
  }
  // against the agent (the scenarios above ran first; node:test runs a file's tests in order)
  assert.deepEqual([...allCalls.keys()].sort(), [...named.keys()].sort(), "the agent called every tool the paste names and no other");
  for (const [tool, args] of named) assert.deepEqual([...(allCalls.get(tool) ?? [])].sort(), [...args].sort(), `${tool}: the paste's arguments are the agent's`);
});

test("T5 every route the page names exists in ROUTES, and the sections it sends the agent to exist in the served files", async () => {
  const paste = operatorsPaste(ORIGIN);
  const html = renderOperators(ORIGIN, { citizens: 1, operator_controlled: 1, operator_paid: 1, acted_30d: 1, residents: 0 });
  const paths = new Set<string>();
  for (const m of (paste + html).matchAll(/https:\/\/example\.test(\/[a-z0-9/_-]+(?:\.md)?)/g)) paths.add(m[1]!);
  assert.ok(paths.size >= 8, [...paths].join(" "));
  for (const p of paths) assert.ok(ROUTES.some((r) => r.path === p), `${p} is in ROUTES`);
  const { d1, env } = fresh();
  try {
    const get = async (p: string) => (await worker.fetch(new Request(`${ORIGIN}${p}`, { headers: { "CF-Connecting-IP": freshIp() } }), env)).text();
    const skill = await get("/skill.md");
    assert.ok(skill.includes("## Stay as a resident"), "/skill.md has the section the paste names");
    const hb = await get("/heartbeat.md");
    assert.ok(/^## 6\. If you are a guest or a resident$/m.test(hb), "/heartbeat.md section 6 is the guest routine");
    // the page itself and the figures sentence are served text too
    assert.ok(figuresText({ citizens: 2, operator_controlled: 1, operator_paid: 1, acted_30d: 1, residents: 0 }).length > 0);
  } finally {
    d1.close();
  }
});
