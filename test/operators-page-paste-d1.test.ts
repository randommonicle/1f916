// T5 (drafts/BRIEF-OPERATORS-PAGE-2026-11-18.md): the executable paste fixture. The page's paste is served text an agent follows literally, so this runs its steps as a
// scripted agent against the REAL /mcp door and the real public GET routes on local D1 (the real router, real Ed25519 keys, nothing mocked). The scripted agent does not parse the English;
// it follows the paste's numbered steps IN THE PASTE'S ORDER (no hoisting) and records, for every branch it takes, the step id (1, 2a, 2b, 2c, 3a, 3b, 3c, 4a, 4b, 5a, 5b, 6) and the calls it makes there.
// The parity test then reads those ids and the tool(arguments) / GET paths out of the paste itself and requires: every id the agent took is in the paste; every paste id with a branch was taken;
// within a run the ids never go backwards; and, per step, the calls the agent made are exactly the calls the paste's text for that step names. It is self-contained: it runs the scenarios itself.
//
// Mutants that turn it red (run records in the builder's report): a paste tool or argument the door does not have; a step moved in the paste but not in the agent; a branch the paste drops;
// the agent hoisting a step; a literal the paste branches on removed or reworded.

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import { createLocalD1, seedCitizens, seedPost, seedTopic, seedVisitor, guestEnv, call, count, freshIp } from "./helpers/guest.ts";
import { genKeypair, signBind, signRecover, newResident, type Keypair } from "./helpers/resident.ts";
import { TOOLS } from "../src/mcp.ts";
import { ROUTES } from "../src/discovery.ts";
import { operatorsPaste, renderOperators } from "../src/operators.ts";
import { SHOWHOME_VISITORS_RING } from "../src/showhome.ts";
import type { Env } from "../src/society.ts";

const ORIGIN = "https://example.test";
const PASTE = operatorsPaste(ORIGIN);
// The only steps the agent may reach out of paste order: the two error-handling branches of step 3.
const SANCTIONED = ["3b", "3c"];

// The literals the paste branches on, each pinned to the paste AND (where the server says it) to the server's own words.
const LIT = {
  unknownToken: "Unknown guest token",
  noToken: "No guest token",
  alreadyByKey: "already a resident by key",
  boundElsewhere: "bound to another resident",
  files: ["commonhold-guest.json", "commonhold-guest.key", "commonhold-guest.failed.json"],
};

// ---------- the scripted agent: the paste's steps, as code, in the paste's order ----------

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
  step: string;
  tool: string; // a tool name, or "GET <path>" with the path normalised the way the paste writes it
  keys: string[];
}
class TransportFailure extends Error {}

interface RunOpts {
  body?: string;
  kind?: "comment" | "critique";
  stopAfterEnter?: boolean;
  failTool?: string; // the request never reaches the worker
  dropResponseOf?: string; // the request reaches the worker and commits; its response is then lost
  failGet?: { norm: string; nth: number }; // the nth GET of that (normalised) path never reaches the worker
  reply?: { post_id: number; body: string }; // step 6 answers something addressed to the agent with guest_comment
}
interface RunResult {
  trace: string[];
  log: string[];
}

function newAgent(env: Env, handle: string) {
  const disk: Disk = { state: null, failed: [], key: null };
  const calls: Call[] = [];
  let step = "";
  const mcp = async (tool: string, args: Record<string, unknown>, opts: RunOpts = {}, record = true) => {
    if (record) calls.push({ step, tool, keys: Object.keys(args).sort() });
    if (opts.failTool === tool) throw new TransportFailure(`simulated timeout before dispatch of ${tool}`);
    const r = await call(env, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }, { "CF-Connecting-IP": freshIp() });
    assert.equal(r.status, 200, "tools/call answers 200 at the transport level, errors included");
    if (opts.dropResponseOf === tool) throw new TransportFailure(`the response to ${tool} was lost after the worker handled it`);
    const body = JSON.parse(r.body.result.content[0].text) as Record<string, any>;
    return { isError: r.body.result.isError === true, body };
  };
  const getCounts = new Map<string, number>();
  const get = async (norm: string, path: string, opts: RunOpts = {}) => {
    calls.push({ step, tool: `GET ${norm}`, keys: [] });
    const nth = (getCounts.get(norm) ?? 0) + 1;
    getCounts.set(norm, nth);
    if (opts.failGet && opts.failGet.norm === norm && opts.failGet.nth === nth) throw new TransportFailure(`simulated timeout reading ${norm}`);
    return call(env, "GET", path);
  };
  const errText = (r: { isError: boolean; body: Record<string, any> }) => (r.isError ? String(r.body.error) : "");
  const isUnknownToken = (r: { isError: boolean; body: Record<string, any> }) => errText(r).includes(LIT.unknownToken);
  const isNoToken = (r: { isError: boolean; body: Record<string, any> }) => errText(r).includes(LIT.noToken);

  async function run(opts: RunOpts = {}): Promise<RunResult> {
    const trace: string[] = [];
    const log: string[] = [];
    const at = (id: string) => {
      step = id;
      trace.push(id);
    };
    try {
      const firstRun = disk.state === null && disk.key === null;
      at("1");
      let enteredTopics: Array<{ id: number }> = [];
      // 2. load or create the identity
      if (disk.state !== null) at("2a");
      else if (disk.key !== null) {
        at("2b");
        let path = "/api/residents";
        let found: { number: number; handle: string } | null = null;
        for (;;) {
          let r;
          try {
            r = await get("/api/residents", path, opts);
          } catch (e) {
            if (!(e instanceof TransportFailure)) throw e;
            return { trace, log: ["roster read failed: stop, try on the next run"] };
          }
          if (r.status !== 200) return { trace, log: [`roster read answered ${r.status}: stop, try on the next run`] };
          const row = (r.body.residents as Array<{ number: number; handle: string; public_key: string | null }>).find((x) => x.public_key === disk.key!.publicKey);
          if (row) {
            found = row;
            break;
          }
          if (r.body.next_cursor === null) break;
          path = `/api/residents?after=${r.body.next_cursor}`;
        }
        if (found) {
          disk.state = { handle: found.handle, visitor_id: found.number, token: null, cursor: null, comment_accepted: true, key_bound: true };
          log.push("rebuilt from the roster");
        }
      }
      if (disk.state === null) {
        at("2c");
        const e = await mcp("guest_enter", { handle, model: "scripted-test-agent" }, opts);
        if (e.isError) return { trace, log: [...log, "enter refused"] };
        enteredTopics = e.body.topics;
        disk.state = { handle, visitor_id: e.body.visitor_id, token: e.body.token, cursor: null, comment_accepted: false, key_bound: false };
        log.push("entered");
        if (opts.stopAfterEnter) return { trace, log };
      }
      const st = disk.state;
      // 3. the token. 3a upfront; 3b is the error-handling branch for a later call; 3c is the unbound rule.
      const recover = async () => {
        const { assertion } = await signRecover(disk.key!, st.visitor_id, st.handle);
        const r = await mcp("resident_token", { number: st.visitor_id, assertion }, opts);
        if (r.isError) return false;
        st.token = r.body.token;
        log.push("recovered");
        return true;
      };
      if (!st.token?.trim()) {
        if (st.key_bound) {
          at("3a");
          if (!(await recover())) return { trace, log: [...log, "recover refused"] };
        } else {
          at("3c");
          log.push("token missing or empty, no key bound: stop and tell the operator");
          return { trace, log };
        }
      }
      // 4. the first comment
      if (!st.comment_accepted) {
        at("4a");
        const topicId = enteredTopics[0]?.id ?? ((await get("/api/topics", "/api/topics")).body.open as Array<{ id: number }>)[0]!.id;
        await mcp("read_post", { post_id: topicId }, opts);
        const c = await mcp("guest_comment", { token: st.token, post_id: topicId, body: opts.body ?? "A first comment that adds something.", kind: opts.kind ?? "critique" }, opts);
        if (!c.isError) {
          st.comment_accepted = true;
          log.push("commented");
        } else if (isUnknownToken(c) && !st.comment_accepted) {
          at("4b");
          disk.failed.push({ ...st });
          disk.state = null;
          const e = await mcp("guest_enter", { handle, model: "scripted-test-agent" }, opts);
          if (!e.isError) disk.state = { handle, visitor_id: e.body.visitor_id, token: e.body.token, cursor: null, comment_accepted: false, key_bound: false };
          log.push("evicted: archived and entered once");
          return { trace, log };
        } else {
          log.push(`comment not accepted: ${String(c.body.error).slice(0, 60)}`);
          return { trace, log };
        }
      }
      // 5. the key
      if (st.comment_accepted && !st.key_bound) {
        at("5a");
        if (disk.key === null) disk.key = await genKeypair();
        const kp = disk.key;
        const { assertion } = await signBind(kp, st.visitor_id, st.handle);
        let cause: "" | "refusal" | "transport" = "";
        try {
          const b = await mcp("resident_bind", { token: st.token, public_key: kp.publicKey, assertion }, opts);
          if (!b.isError) {
            st.key_bound = true;
            log.push("bound");
          } else if (errText(b).includes(LIT.alreadyByKey)) cause = "refusal";
          else if (errText(b).includes(LIT.boundElsewhere)) {
            log.push("key bound to another resident: stop and tell the operator");
            return { trace, log };
          } else if (isUnknownToken(b) || isNoToken(b)) {
            at("3c");
            log.push("token refused and no key bound: stop and tell the operator");
            return { trace, log };
          } else log.push(`bind refused: ${errText(b).slice(0, 50)}`);
        } catch (e) {
          if (!(e instanceof TransportFailure)) throw e;
          cause = "transport";
        }
        if (cause !== "") {
          at("5b");
          let p;
          try {
            p = await get("/api/resident/NUMBER", `/api/resident/${st.visitor_id}`, opts);
          } catch (e) {
            if (!(e instanceof TransportFailure)) throw e;
            return { trace, log: [...log, "reconcile: the read failed: stop for this run, try on the next"] };
          }
          if (p.status === 200 && p.body.public_key === kp.publicKey) {
            st.key_bound = true;
            log.push("reconciled: bound");
          } else if (p.status === 200) {
            log.push("reconcile: the profile has a different key: stop and tell the operator");
            return { trace, log };
          } else if (p.status === 404 && cause === "refusal") {
            log.push("reconcile: 404 after the already-bound refusal: stop and tell the operator");
            return { trace, log };
          } else {
            log.push("reconcile: not confirmed: stop for this run, try on the next");
            return { trace, log };
          }
        }
      }
      // 6. the inbox, on every run after the first
      if (!firstRun) {
        at("6");
        let more = true;
        let pages = 0;
        while (more) {
          assert.ok(++pages <= 5, "the inbox loop must make progress: a saved cursor moves it on");
          const args: Record<string, unknown> = { guest: st.visitor_id };
          if (st.cursor !== null) args.cursor = st.cursor;
          const i = await mcp("guest_inbox", args, opts);
          if (i.isError) break;
          st.cursor = i.body.next_cursor ?? st.cursor;
          more = i.body.has_more === true;
          log.push(`inbox ${more ? "(more)" : "(drained)"}`);
        }
        if (opts.reply) {
          const reply = () => mcp("guest_comment", { token: st.token, post_id: opts.reply!.post_id, body: opts.reply!.body, kind: "comment" }, opts);
          let r = await reply();
          if (isUnknownToken(r) || isNoToken(r)) {
            if (!st.key_bound) {
              at("3c");
              log.push("token refused and no key bound: stop and tell the operator");
              return { trace, log };
            }
            // 3b: recover ONCE, repeat the failed call ONCE
            at("3b");
            if (!(await recover())) return { trace, log: [...log, "recover refused"] };
            at("6");
            r = await reply();
          }
          log.push(r.isError ? `reply failed: ${errText(r).slice(0, 50)}` : "replied");
        }
      }
      return { trace, log };
    } catch (e) {
      if (e instanceof TransportFailure) return { trace, log: ["transport failure: stopped, nothing retried"] };
      throw e;
    }
  }
  // a call the TEST makes to check the server (not a step of the paste): never recorded as the agent's
  const probe = (tool: string, args: Record<string, unknown>) => mcp(tool, args, {}, false);
  return { disk, calls, run, probe };
}

function fresh() {
  const d1 = createLocalD1();
  const { alice } = seedCitizens(d1);
  const post = seedPost(d1, alice);
  const topic = seedTopic(d1);
  return { d1, env: guestEnv(d1), alice, post, topic };
}
const visitorsAndGuests = (d1: ReturnType<typeof createLocalD1>) => count(d1, "SELECT COUNT(*) AS n FROM visitors") + count(d1, "SELECT COUNT(*) AS n FROM guests");
const enterCalls = (calls: Call[]) => calls.filter((c) => c.tool === "guest_enter").length;
const boundKeys = (d1: ReturnType<typeof createLocalD1>) => count(d1, "SELECT COUNT(*) AS n FROM guests WHERE public_key IS NOT NULL");

// ---------- the scenarios (each its own database; each returns what it ran, for the parity test) ----------

interface Ran {
  traces: string[][];
  calls: Call[];
}
type Scenario = () => Promise<Ran>;

const first: Scenario = async () => {
  const { d1, env } = fresh();
  try {
    const a = newAgent(env, "scripted-one");
    const r = await a.run();
    assert.deepEqual(r.log, ["entered", "commented", "bound"]);
    assert.deepEqual(r.trace, ["1", "2c", "4a", "5a"]);
    assert.deepEqual(a.calls.map((c) => c.tool), ["guest_enter", "read_post", "guest_comment", "resident_bind"]);
    assert.equal(boundKeys(d1), 1, "the agent really became a resident");
    return { traces: [r.trace], calls: a.calls };
  } finally {
    d1.close();
  }
};

const interrupted: Scenario = async () => {
  const { d1, env } = fresh();
  try {
    const a = newAgent(env, "scripted-two");
    const r1 = await a.run({ stopAfterEnter: true });
    assert.deepEqual(r1.trace, ["1", "2c"]);
    const saved = { ...a.disk.state! };
    assert.equal(a.disk.key, null, "no key yet");
    const r2 = await a.run();
    assert.deepEqual(r2.trace, ["1", "2a", "4a", "5a", "6"]);
    assert.equal(enterCalls(a.calls), 1, "one enter across both runs");
    assert.equal(a.disk.state!.visitor_id, saved.visitor_id);
    assert.equal(a.disk.state!.token, saved.token);
    assert.equal(a.disk.failed.length, 0);
    return { traces: [r1.trace, r2.trace], calls: a.calls };
  } finally {
    d1.close();
  }
};

const evicted: Scenario = async () => {
  const { d1, env } = fresh();
  try {
    const a = newAgent(env, "scripted-three");
    await a.run({ stopAfterEnter: true });
    const firstNumber = a.disk.state!.visitor_id;
    for (let i = 0; i < SHOWHOME_VISITORS_RING; i++) await seedVisitor(d1, `filler${i}`);
    const other = await call(env, "POST", "/api/showhome/enter", { handle: "someone-else", model: "m" }, { "CF-Connecting-IP": freshIp() });
    assert.equal(other.status, 201);
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM visitors WHERE id = ?", firstNumber), 0, "the saved visitor row really is gone");
    const before = enterCalls(a.calls);
    const r = await a.run();
    assert.deepEqual(r.log, ["evicted: archived and entered once"]);
    assert.deepEqual(r.trace, ["1", "2a", "4a", "4b"]);
    assert.equal(enterCalls(a.calls) - before, 1, "exactly one enter in the resumed run");
    assert.equal(a.disk.failed.length, 1);
    assert.equal(a.disk.failed[0]!.visitor_id, firstNumber);
    const r2 = await a.run();
    assert.ok(r2.log.includes("commented"), "the next run comments with the new token");
    assert.equal(enterCalls(a.calls) - before, 1, "and never entered again");
    return { traces: [r.trace, r2.trace], calls: a.calls };
  } finally {
    d1.close();
  }
};

const transient: Scenario = async () => {
  const { d1, env } = fresh();
  try {
    const a = newAgent(env, "scripted-five");
    await a.run({ stopAfterEnter: true });
    const visitors = visitorsAndGuests(d1);
    const t = await a.run({ failTool: "guest_comment" });
    assert.deepEqual(t.log, ["transport failure: stopped, nothing retried"]);
    const refused = await a.run({ body: "see http://example.invalid/page for more" });
    assert.ok(refused.log[0]!.startsWith("comment not accepted"), refused.log[0]);
    assert.equal(visitorsAndGuests(d1), visitors, "no new visitor row after a timeout and a refusal");
    assert.equal(enterCalls(a.calls), 1);
    assert.equal(a.disk.failed.length, 0);
    const ok = await a.run({ body: "Here is the same point without a link." });
    assert.ok(ok.log.includes("commented") && ok.log.includes("bound"));
    return { traces: [t.trace, refused.trace, ok.trace], calls: a.calls };
  } finally {
    d1.close();
  }
};

const inboxPaging: Scenario = async () => {
  const { d1, env, post, alice } = fresh();
  try {
    const a = newAgent(env, "scripted-six");
    await a.run();
    const st = a.disk.state!;
    const label = `@resident:${st.handle}#${st.visitor_id}`;
    const ins = d1.raw.prepare("INSERT INTO comments (post_id, citizen_id, body, depth, created_at) VALUES (?, ?, ?, 0, ?)");
    for (let i = 0; i < 101; i++) ins.run(post, alice, `${label} addressed comment ${i}`, Date.now());
    const calls0 = a.calls.length;
    const r = await a.run();
    assert.deepEqual(r.log, ["inbox (more)", "inbox (drained)"]);
    const inboxCalls = a.calls.slice(calls0).filter((c) => c.tool === "guest_inbox");
    assert.deepEqual(inboxCalls.map((c) => c.keys), [["guest"], ["cursor", "guest"]], "no cursor the first time, the returned cursor after");
    const saved = a.disk.state!.cursor;
    assert.ok(typeof saved === "string" && saved.length > 0);
    const r2 = await a.run();
    assert.deepEqual(r2.log, ["inbox (drained)"]);
    assert.equal(a.disk.state!.cursor, saved, "nothing new: the cursor is unchanged");
    return { traces: [r.trace, r2.trace], calls: a.calls };
  } finally {
    d1.close();
  }
};

const lostToken: Scenario = async () => {
  const { d1, env, topic } = fresh();
  try {
    const a = newAgent(env, "scripted-seven");
    await a.run();
    const oldToken = a.disk.state!.token!;
    // the server's own words for an empty token, which the paste's step 3 names
    const empty = await a.probe("guest_comment", { token: "", post_id: topic, body: "x" });
    assert.ok(empty.isError && String(empty.body.error).includes(LIT.noToken), String(empty.body.error));
    a.calls.length = 0;
    for (const lost of [null, ""]) {
      a.disk.state!.token = lost;
      const before = enterCalls(a.calls);
      const r = await a.run();
      assert.deepEqual(r.trace, ["1", "2a", "3a", "6"]);
      assert.equal(enterCalls(a.calls), before, "recovery never enters again");
      assert.notEqual(a.disk.state!.token, oldToken);
      const w = await a.probe("guest_comment", { token: a.disk.state!.token, post_id: topic, body: `A comment with the recovered token ${String(lost)}.` });
      assert.equal(w.isError, false);
    }
    const dead = await a.probe("guest_comment", { token: oldToken, post_id: topic, body: "A comment with the dead token." });
    assert.equal(dead.isError, true, "the old token died");
    assert.ok(String(dead.body.error).includes(LIT.unknownToken));
    return { traces: [["1", "2a", "3a", "6"]], calls: a.calls };
  } finally {
    d1.close();
  }
};

// The agent's json is lost and its key survives. It is resident number 51, so the roster's second page holds it.
const lostJsonFound: Scenario = async () => {
  const { d1, env, post, topic } = fresh();
  try {
    for (let i = 0; i < 50; i++) await newResident(env, post, `filler-res-${i}`);
    const a = newAgent(env, "scripted-eight");
    await a.run();
    const residentsBefore = count(d1, "SELECT COUNT(*) AS n FROM guests WHERE resident_at IS NOT NULL");
    assert.equal(residentsBefore, 51);
    const num = a.disk.state!.visitor_id;
    const handleBefore = a.disk.state!.handle;
    a.disk.state = null; // commonhold-guest.json is lost; the key file survives
    a.calls.length = 0;
    const before = visitorsAndGuests(d1);
    const r = await a.run();
    assert.deepEqual(r.trace, ["1", "2b", "3a", "6"]);
    assert.equal(enterCalls(a.calls), 0, "never entered");
    assert.equal(visitorsAndGuests(d1), before, "no second identity");
    assert.equal(boundKeys(d1), 51, "no second key bound");
    assert.equal(a.disk.state!.visitor_id, num);
    assert.equal(a.disk.state!.handle, handleBefore);
    assert.ok(a.calls.filter((c) => c.tool === "GET /api/residents").length >= 2, "it followed next_cursor to the second page");
    const w = await a.probe("guest_comment", { token: a.disk.state!.token, post_id: topic, body: "The rebuilt identity can comment." });
    assert.equal(w.isError, false);
    return { traces: [r.trace], calls: a.calls };
  } finally {
    d1.close();
  }
};

// The key was made but never bound, and the json is lost: the agent enters, and binds that same key later.
const lostJsonNeverBound: Scenario = async () => {
  const { d1, env } = fresh();
  try {
    const a = newAgent(env, "scripted-nine");
    a.disk.key = await genKeypair();
    const r = await a.run();
    assert.deepEqual(r.trace, ["1", "2b", "2c", "4a", "5a", "6"], "a saved key means this is not the first run, so the inbox is read");
    assert.equal(enterCalls(a.calls), 1);
    assert.equal(boundKeys(d1), 1);
    const row = d1.raw.prepare("SELECT public_key FROM guests").get() as { public_key: string };
    assert.equal(row.public_key, a.disk.key.publicKey, "the same saved key was bound, not a new one");
    return { traces: [r.trace], calls: a.calls };
  } finally {
    d1.close();
  }
};

// The bind commits and its response is lost AFTER the worker handled it (the request reached the worker; the answer never came back).
const lostBindResponse: Scenario = async () => {
  const { d1, env } = fresh();
  try {
    const a = newAgent(env, "scripted-ten");
    const r = await a.run({ dropResponseOf: "resident_bind" });
    assert.deepEqual(r.trace, ["1", "2c", "4a", "5a", "5b"]);
    assert.equal(boundKeys(d1), 1, "the server really committed the bind");
    assert.equal(a.calls.filter((c) => c.tool === "resident_bind").length, 1, "no retry of the bind");
    assert.equal(a.disk.state!.key_bound, true, "reconciled from the profile");
    assert.ok(r.log.includes("reconciled: bound"));
    // the run crashes before it can reconcile; the next run's bind meets the already-bound refusal and reconciles then
    const b = newAgent(env, "scripted-eleven");
    const r1 = await b.run({ dropResponseOf: "resident_bind", failGet: { norm: "/api/resident/NUMBER", nth: 1 } });
    assert.deepEqual(r1.trace, ["1", "2c", "4a", "5a", "5b"]);
    assert.equal(b.disk.state!.key_bound, false, "the flag is behind the server");
    const r2 = await b.run();
    assert.deepEqual(r2.trace, ["1", "2a", "5a", "5b", "6"]);
    assert.equal(b.calls.filter((c) => c.tool === "resident_bind").length, 2);
    assert.equal(b.disk.state!.key_bound, true);
    assert.equal(boundKeys(d1), 2, "no third key, no 409 loop");
    return { traces: [r.trace, r1.trace, r2.trace], calls: [...a.calls, ...b.calls] };
  } finally {
    d1.close();
  }
};

// The profile's key differs from the saved key (or the profile is absent): the agent stops, keeps key_bound false.
const reconcileMismatch: Scenario = async () => {
  const { d1, env } = fresh();
  try {
    const a = newAgent(env, "scripted-twelve");
    const other = await genKeypair();
    // after the bind commits, the server-side key is not the one the agent saved
    const r = await a.run({ dropResponseOf: "resident_bind" });
    assert.equal(a.disk.state!.key_bound, true);
    const b = newAgent(env, "scripted-thirteen");
    await b.run({ stopAfterEnter: true });
    await b.run({ dropResponseOf: "resident_bind", failGet: { norm: "/api/resident/NUMBER", nth: 1 } });
    d1.raw.prepare("UPDATE guests SET public_key = ? WHERE visitor_id = ?").run(other.publicKey, b.disk.state!.visitor_id);
    const r2 = await b.run();
    assert.deepEqual(r2.trace, ["1", "2a", "5a", "5b"], "the bind is refused, the profile differs: stop");
    assert.equal(b.disk.state!.key_bound, false);
    assert.ok(r2.log.includes("reconcile: the profile has a different key: stop and tell the operator"));
    return { traces: [r.trace, r2.trace], calls: [...a.calls, ...b.calls] };
  } finally {
    d1.close();
  }
};

// A bound resident holds a non-empty OBSOLETE token (a recovery elsewhere replaced it). A step-6 reply returns "Unknown guest token"; the agent recovers once via resident_token, repeats the reply once, and never enters.
const obsoleteToken: Scenario = async () => {
  const { d1, env, topic } = fresh();
  try {
    const a = newAgent(env, "scripted-obsolete");
    await a.run();
    const st = a.disk.state!;
    const staleToken = st.token!;
    const rec = await signRecover(a.disk.key!, st.visitor_id, st.handle);
    const replaced = await a.probe("resident_token", { number: st.visitor_id, assertion: rec.assertion });
    assert.equal(replaced.isError, false);
    assert.notEqual(replaced.body.token, staleToken);
    const writes = () => count(d1, "SELECT COUNT(*) AS n FROM guest_thread WHERE author_kind = 'guest' AND author_id = ?", st.visitor_id);
    const before = writes();
    a.calls.length = 0;
    const r = await a.run({ reply: { post_id: topic, body: "A reply written with a stale token." } });
    assert.deepEqual(r.trace, ["1", "2a", "6", "3b", "6"]);
    assert.equal(a.calls.filter((c) => c.tool === "resident_token").length, 1, "recovered once");
    assert.equal(a.calls.filter((c) => c.tool === "guest_comment").length, 2, "the failed call repeated once, no more");
    assert.equal(enterCalls(a.calls), 0, "no guest_enter");
    assert.notEqual(a.disk.state!.token, staleToken);
    assert.equal(writes() - before, 1, "the reply was written once");
    // bounded: when the recovery itself fails (the saved key is not the bound key), the agent stops after ONE attempt
    const rec2 = await signRecover(a.disk.key!, st.visitor_id, st.handle);
    await a.probe("resident_token", { number: st.visitor_id, assertion: rec2.assertion });
    a.disk.key = await genKeypair();
    a.calls.length = 0;
    const r2 = await a.run({ reply: { post_id: topic, body: "A reply that cannot recover." } });
    assert.deepEqual(r2.trace, ["1", "2a", "6", "3b"]);
    assert.equal(a.calls.filter((c) => c.tool === "resident_token").length, 1, "one recovery attempt");
    assert.equal(a.calls.filter((c) => c.tool === "guest_comment").length, 1, "no repeat after a failed recovery");
    return { traces: [r.trace, r2.trace], calls: a.calls };
  } finally {
    d1.close();
  }
};

// The unbound branches of step 3 stay distinct from 3b: an empty token, or a refused token, with no key bound, stops (3c); only an unused token that the ring evicted (comment_accepted false) re-enters (4b).
const unboundTokens: Scenario = async () => {
  const { d1, env, topic } = fresh();
  try {
    const a = newAgent(env, "scripted-unbound");
    await a.run({ stopAfterEnter: true });
    a.disk.state!.token = "  ";
    const r = await a.run();
    assert.deepEqual(r.trace, ["1", "2a", "3c"]);
    assert.equal(enterCalls(a.calls), 1, "a blank token with no key bound never re-enters");
    // comment accepted, no key bound, and the saved token is wrong: the bind's refusal stops the run
    const b = newAgent(env, "scripted-unbound-two");
    await b.run({ stopAfterEnter: true });
    const real = b.disk.state!.token!;
    await b.probe("guest_comment", { token: real, post_id: topic, body: "A first comment so this guest is promoted." });
    b.disk.state!.comment_accepted = true;
    b.disk.state!.token = "commonhold_visit_not_the_real_token";
    const r2 = await b.run();
    assert.deepEqual(r2.trace, ["1", "2a", "5a", "3c"]);
    assert.equal(enterCalls(b.calls), 1, "no second enter");
    assert.equal(b.calls.filter((c) => c.tool === "resident_token").length, 0, "and no recovery without a bound key");
    return { traces: [r.trace, r2.trace], calls: [...a.calls, ...b.calls] };
  } finally {
    d1.close();
  }
};

// 2b read errors: a timeout on the second roster page, then a 500 from the server, both stop WITHOUT guest_enter; the next healthy run rebuilds.
const rosterReadFails: Scenario = async () => {
  const { d1, env, post } = fresh();
  try {
    for (let i = 0; i < 50; i++) await newResident(env, post, `filler-ro-${i}`);
    const a = newAgent(env, "scripted-roster");
    await a.run();
    a.disk.state = null;
    a.calls.length = 0;
    const before = visitorsAndGuests(d1);
    const r1 = await a.run({ failGet: { norm: "/api/residents", nth: 2 } });
    assert.deepEqual(r1.trace, ["1", "2b"]);
    assert.ok(r1.log[0]!.startsWith("roster read failed"));
    d1.raw.exec("ALTER TABLE resident_accounts RENAME TO resident_accounts_broken");
    const r2 = await a.run();
    assert.deepEqual(r2.trace, ["1", "2b"]);
    assert.ok(r2.log[0]!.startsWith("roster read answered 500"), r2.log[0]);
    assert.equal(enterCalls(a.calls), 0, "never entered after a read error");
    assert.equal(visitorsAndGuests(d1), before, "no second identity");
    assert.equal(a.disk.state, null, "no json was invented");
    d1.raw.exec("ALTER TABLE resident_accounts_broken RENAME TO resident_accounts");
    const r3 = await a.run();
    assert.deepEqual(r3.trace, ["1", "2b", "3a", "6"], "the next healthy run rebuilds the identity");
    return { traces: [r1.trace, r2.trace, r3.trace], calls: a.calls };
  } finally {
    d1.close();
  }
};

// 5b outcomes: a pre-commit timeout then a 404 is no alarm (retry next run); a 404 after the already-bound refusal is an alarm.
const reconcileOutcomes: Scenario = async () => {
  const { d1, env } = fresh();
  try {
    const a = newAgent(env, "scripted-fourteen");
    const r1 = await a.run({ failTool: "resident_bind" });
    assert.deepEqual(r1.trace, ["1", "2c", "4a", "5a", "5b"]);
    assert.ok(r1.log.includes("reconcile: not confirmed: stop for this run, try on the next"), r1.log.join("|"));
    assert.equal(r1.log.some((l) => l.includes("tell the operator")), false, "a dropped request is not an alarm");
    assert.equal(a.disk.state!.key_bound, false);
    assert.equal(boundKeys(d1), 0, "the bind never reached the worker");
    const r2 = await a.run();
    assert.deepEqual(r2.trace, ["1", "2a", "5a", "6"]);
    assert.equal(a.disk.state!.key_bound, true);
    assert.equal(boundKeys(d1), 1);
    // a profile read that times out after an uncertain bind: also stop and try next run
    const b = newAgent(env, "scripted-fifteen");
    const b1 = await b.run({ dropResponseOf: "resident_bind", failGet: { norm: "/api/resident/NUMBER", nth: 1 } });
    assert.ok(b1.log.includes("reconcile: the read failed: stop for this run, try on the next"), b1.log.join("|"));
    // the refusal says already a resident by key, but the profile is 404: that is an alarm
    const c = newAgent(env, "scripted-sixteen");
    await c.run({ dropResponseOf: "resident_bind", failGet: { norm: "/api/resident/NUMBER", nth: 1 } });
    d1.raw.prepare("UPDATE guests SET resident_at = NULL WHERE visitor_id = ?").run(c.disk.state!.visitor_id);
    const c2 = await c.run();
    assert.deepEqual(c2.trace, ["1", "2a", "5a", "5b"]);
    assert.ok(c2.log.includes("reconcile: 404 after the already-bound refusal: stop and tell the operator"), c2.log.join("|"));
    assert.equal(c.disk.state!.key_bound, false);
    return { traces: [r1.trace, r2.trace, b1.trace, c2.trace], calls: [...a.calls, ...b.calls, ...c.calls] };
  } finally {
    d1.close();
  }
};

const SCENARIOS: Record<string, Scenario> = { first, interrupted, evicted, transient, inboxPaging, lostToken, lostJsonFound, lostJsonNeverBound, lostBindResponse, reconcileMismatch, obsoleteToken, unboundTokens, rosterReadFails, reconcileOutcomes };
const memo = new Map<string, Promise<Ran>>();
const scenario = (name: string): Promise<Ran> => {
  if (!memo.has(name)) memo.set(name, SCENARIOS[name]!());
  return memo.get(name)!;
};

for (const [name, title] of [
  ["first", "first run: enter, comment, bind, in the paste's order; the first run reads no inbox"],
  ["interrupted", "interrupted first run: it stops after enter; the next run resumes with no second enter and no new key"],
  ["evicted", "evicted unpromoted visitor: the MCP isError 'Unknown guest token', archive, enter once, stop; the next run comments"],
  ["transient", "transient failure and refusal never trigger a new enter; a rephrased comment on a later run is accepted"],
  ["inboxPaging", "later runs: guest_inbox with the saved cursor, has_more drained, the new cursor saved"],
  ["lostToken", "a bound resident's token is missing or empty: step 3 recovers it before any write, 'No guest token' and 'Unknown guest token' are the server's words, never a second enter"],
  ["lostJsonFound", "commonhold-guest.json lost, key survives and is on the roster (page 2): rebuilt from the roster, token recovered, no second identity, no 409"],
  ["lostJsonNeverBound", "commonhold-guest.json lost, key never bound: the agent enters once and binds the SAME saved key"],
  ["lostBindResponse", "a bind whose response is lost AFTER the server commits: reconciled from the profile in the same run, or by the already-bound refusal on the next"],
  ["reconcileMismatch", "a profile whose key differs from the saved key: the agent stops and does not set key_bound"],
  ["obsoleteToken", "a bound resident's non-empty obsolete token: a step-6 reply gets 'Unknown guest token', one recovery, one repeat, no enter; a failed recovery stops after one attempt"],
  ["unboundTokens", "no key bound: a blank token or a refused token stops (3c) and never recovers or re-enters, distinct from the evicted-unused-token branch 4b"],
  ["rosterReadFails", "2b read errors (a timeout, a 500) stop without guest_enter; the next healthy run rebuilds the identity"],
  ["reconcileOutcomes", "5b: a pre-commit timeout then 404 is retried next run with no alarm; a read timeout stops quietly; a 404 after the already-bound refusal is an alarm"],
] as const) {
  test(`T5 ${title}`, async () => {
    await scenario(name);
  });
}

// ---------- the paste and the agent stay in step ----------

interface PasteStep {
  id: string;
  text: string;
}
function pasteSteps(paste: string): PasteStep[] {
  const out: PasteStep[] = [];
  let top = "";
  for (const line of paste.split("\n")) {
    const t = /^(\d+)\. /.exec(line);
    const s = /^ {3}([a-z])\. /.exec(line);
    if (t) {
      top = t[1]!;
      out.push({ id: top, text: line });
    } else if (s) out.push({ id: top + s[1]!, text: line });
    else if (out.length > 0 && line.trim() !== "") out[out.length - 1]!.text += `\n${line}`;
  }
  return out;
}
// The calls a step's text names: tool(arguments) and GET <origin><path>, normalised the way the agent records them.
function stepCalls(text: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const m of text.matchAll(/\b([a-z]+_[a-z_]+)\(([a-z_, ]*)\)/g)) {
    const set = out.get(m[1]!) ?? new Set<string>();
    for (const a of m[2]!.split(",").map((x) => x.trim()).filter(Boolean)) set.add(a);
    out.set(m[1]!, set);
  }
  for (const m of text.matchAll(/GET https:\/\/example\.test(\/[A-Za-z0-9/_]+)/g)) {
    const path = m[1]!.replace(/\/$/, "");
    if (!out.has(`GET ${path}`)) out.set(`GET ${path}`, new Set());
  }
  return out;
}

test("T5 parity: the paste's numbered steps and the agent's branches correspond, in order, call for call; every tool exists on the full door with those argument names (self-contained)", async () => {
  const steps = pasteSteps(PASTE);
  const ids = steps.map((s) => s.id);
  assert.deepEqual(ids, ["1", "2", "2a", "2b", "2c", "3", "3a", "3b", "3c", "4", "4a", "4b", "5", "5a", "5b", "6", "7"]);
  const ran = await Promise.all(Object.keys(SCENARIOS).map((n) => scenario(n)));
  const taken = new Set<string>();
  for (const r of ran) {
    for (const trace of r.traces) {
      let last = -1;
      trace.forEach((id, i) => {
        const at = ids.indexOf(id);
        assert.ok(at >= 0, `the agent took step ${id}, which is not in the paste`);
        taken.add(id);
        if (SANCTIONED.includes(id)) {
          // an error-handling branch: it may be taken from a later step, but 3b must hand back to the very step that failed, once (the next id is that step again, or the run stops), and 3c ends the run
          if (id === "3b") assert.ok(i + 1 === trace.length || trace[i + 1] === trace[i - 1], `3b must return to the step that failed: ${trace.join(" ")}`);
          if (id === "3c") assert.equal(i + 1, trace.length, `3c ends the run: ${trace.join(" ")}`);
          assert.equal(trace.filter((x) => x === "3b").length <= 1, true, `3b is taken at most once per run: ${trace.join(" ")}`);
          return;
        }
        assert.ok(at >= last, `within a run the agent went backwards: ${trace.join(" ")}`);
        last = at;
      });
    }
  }
  // every paste step that does something was taken by some scenario (1 is the state note, 7 the custody note; 2, 3, 4 and 5 are headings of their lettered steps)
  for (const id of ids.filter((i) => !["1", "2", "3", "4", "5", "7"].includes(i))) assert.ok(taken.has(id), `no scenario took paste step ${id}`);
  // per step: the calls the agent made are exactly the calls the paste's text for that step names
  const agentCalls = new Map<string, Map<string, Set<string>>>();
  for (const c of ran.flatMap((r) => r.calls)) {
    const perStep = agentCalls.get(c.step) ?? new Map<string, Set<string>>();
    const keys = perStep.get(c.tool) ?? new Set<string>();
    for (const k of c.keys) keys.add(k);
    perStep.set(c.tool, keys);
    agentCalls.set(c.step, perStep);
  }
  const pasteByStep = new Map(steps.map((s) => [s.id, stepCalls(s.text)]));
  for (const id of ids) {
    const fromPaste = pasteByStep.get(id)!;
    const fromAgent = agentCalls.get(id) ?? new Map<string, Set<string>>();
    // a heading step (2, 4, 5) carries no calls of its own; its lettered steps do. Step 1 and 7 name guest_enter/none in prose without parentheses.
    assert.deepEqual([...fromAgent.keys()].sort(), [...fromPaste.keys()].sort(), `step ${id}: the calls the paste names are the calls the agent made`);
    for (const [tool, args] of fromPaste) assert.deepEqual([...(fromAgent.get(tool) ?? [])].sort(), [...args].sort(), `step ${id} ${tool}: the paste's arguments are the agent's`);
  }
  // every tool in the paste is on the full door with those argument names, and every required argument is named
  const all = stepCalls(PASTE);
  for (const [tool, args] of all) {
    if (tool.startsWith("GET ")) continue;
    const def = TOOLS.find((t) => t.name === tool);
    assert.ok(def, `${tool} is a tool on the full door`);
    const props = Object.keys((def!.inputSchema.properties ?? {}) as Record<string, unknown>);
    for (const a of args) assert.ok(props.includes(a), `${tool} has an argument named ${a}`);
    for (const req of (def!.inputSchema.required ?? []) as string[]) assert.ok(args.has(req) || [...pasteSteps(PASTE)].some((s) => stepCalls(s.text).get(tool)?.has(req)), `${tool} requires ${req} and the paste names it`);
  }
});

test("T5 the paste carries the literals it branches on: the three filenames, the server's error texts, critique, has_more, next_cursor", async () => {
  for (const f of LIT.files) assert.ok(PASTE.includes(f), `the paste names ${f}`);
  for (const l of [LIT.unknownToken, LIT.noToken, LIT.alreadyByKey, LIT.boundElsewhere]) assert.ok(PASTE.includes(`"${l}"`) || PASTE.includes(l), `the paste carries '${l}'`);
  for (const l of ['kind "critique"', "has_more", "next_cursor", "visitor_id", "comment_accepted", "key_bound", "public_key"]) assert.ok(PASTE.includes(l), `the paste carries ${l}`);
  // and the server really says them (the scenarios above ran against these texts): the refusal for a key already bound to another resident
  const { d1, env, post } = fresh();
  try {
    const { guest, kp } = await newResident(env, post, "first-owner");
    assert.ok(guest.number > 0);
    const second = newAgent(env, "second-owner");
    await second.run({ stopAfterEnter: true });
    await second.probe("guest_comment", { token: second.disk.state!.token, post_id: seedTopic(d1), body: "A comment so this guest can bind." });
    const { assertion } = await signBind(kp, second.disk.state!.visitor_id, second.disk.state!.handle);
    const r = await second.probe("resident_bind", { token: second.disk.state!.token, public_key: kp.publicKey, assertion });
    assert.ok(r.isError && String(r.body.error).includes(LIT.boundElsewhere), String(r.body.error));
    const again = await signBind(kp, guest.number, guest.handle);
    const b = await second.probe("resident_bind", { token: guest.token, public_key: kp.publicKey, assertion: again.assertion });
    assert.ok(b.isError && String(b.body.error).includes(LIT.alreadyByKey), String(b.body.error));
  } finally {
    d1.close();
  }
});

test("T5 every route the page names exists in ROUTES, and the sections it sends the agent to exist in the served files", async () => {
  const html = renderOperators(ORIGIN, { citizens: 1, operator_controlled: 1, operator_paid: 1, acted_30d: 1, residents: 0 });
  const paths = new Set<string>();
  for (const m of (PASTE + html).matchAll(/https:\/\/example\.test(\/[A-Za-z0-9/_-]+(?:\.md)?)/g)) paths.add(m[1]!.replace(/\/$/, "").replace(/\/NUMBER$/, "/:number"));
  assert.ok(paths.size >= 8, [...paths].join(" "));
  for (const p of paths) {
    const ok = ROUTES.some((r) => r.path === p);
    assert.ok(ok, `${p} is in ROUTES`);
  }
  const { d1, env } = fresh();
  try {
    const get = async (p: string) => (await worker.fetch(new Request(`${ORIGIN}${p}`, { headers: { "CF-Connecting-IP": freshIp() } }), env)).text();
    assert.ok((await get("/skill.md")).includes("## Stay as a resident"), "/skill.md has the section the paste names");
    assert.ok(/^## 6\. If you are a guest or a resident$/m.test(await get("/heartbeat.md")), "/heartbeat.md section 6 is the guest routine");
  } finally {
    d1.close();
  }
});

test("T5 the paste's rules are scoped as the agent runs them: the opening allows entry and recovery and forbids comment, bind and inbox; both step-3 recovery triggers need key_bound true; 2b and 5b name their stop-and-retry outcomes", () => {
  assert.equal(PASTE.includes("make no write"), false, "the opening must not forbid the writes steps 2 and 3 need");
  assert.ok(PASTE.includes("Steps 2 and 3 may call guest_enter and resident_token; until steps 1 to 3 are done, post no comment, bind no key and read no inbox."));
  const steps = pasteSteps(PASTE);
  const text = (id: string) => steps.find((s) => s.id === id)!.text;
  assert.ok(text("3a").includes("If key_bound is true and the token is missing or empty"));
  assert.ok(text("3b").includes("If key_bound is true and a later call returns an error"));
  assert.ok(text("3b").includes("once") && text("3b").includes("repeat the failed call once"), "one bounded retry");
  assert.ok(text("3c").includes("If key_bound is false") && text("3c").includes("goes to 4b") && text("3c").includes("stop and tell your operator"));
  assert.ok(text("2b").includes("If every page answered 200 and none matched") && text("2b").includes("If any read failed or timed out, stop and try on the next run"));
  assert.ok(text("5b").includes("200 with your saved public_key") && text("5b").includes("200 with a different public_key") && text("5b").includes("404 after the \"already a resident by key\" refusal"));
  assert.ok(text("5b").includes("404 after a timeout or an error, or the read itself fails, stop for this run and try on the next"));
  assert.ok(text("4b").includes('"Unknown guest token"') && !text("4b").includes("No guest token"), "eviction matches only Unknown guest token");
});
