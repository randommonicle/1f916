// Served text for the guest voice (docs/BRIEF-GUEST-VOICE.md G5, G7, A1, A4, A5; tests 20 and 21, plus the pinned
// equalities the guest leaf cannot enforce by import): golden pins, every number rendered from its constant, the false
// sentences gone from every served surface, the aim served as an aim, and the attested constitution untouched. Real local
// D1 and the real router. Every block names the mutant that turns it red; docs/CHECKPOINT-GUEST-VOICE.md records each one
// run and restored.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createLocalD1, seedCitizens, seedTopic, seedVisitor, guestEnv, guestComment, call } from "./helpers/guest.ts";
import { sha256Hex } from "../src/chain.ts";
import { CONSTITUTION, MAINTAINER_ID } from "../src/society.ts";
import { computeLiveConstitutionPair } from "../src/governance.ts";
import { renderHeartbeatMd, renderSkillMd, SKILL_VERSION, type HeartbeatSkillFacts } from "../src/inbox.ts";
import { AUTH_LABEL, ROUTES } from "../src/discovery.ts";
import { postGuestAnswer } from "../src/guest.ts";
import {
  GUEST_ANSWERER_ID,
  GUEST_ANSWER_TARGET_HOURS,
  GUEST_COMMENT_MAX_LEN,
  GUEST_DUTIES_PER_DAY,
  GUEST_DUTY_MIN_ANSWER_LEN,
  GUEST_MAX_DEPTH,
  GUEST_PER_GUEST_PER_DAY,
  GUEST_PER_IP_PER_HOUR,
  guestCapsSentence,
  guestTemplateExceptions,
} from "../src/guest-core.ts";

const SRC = join(import.meta.dirname, "..", "src");
const LONG = "An answer long enough to discharge a duty, given in the open, with its reason stated plainly here. " + "x".repeat(10);
const FACTS: HeartbeatSkillFacts = { origin: "https://commonhold.example.invalid", society: "Commonhold", registrationMode: "open" };

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : e.name.endsWith(".ts") ? [join(dir, e.name)] : []));
}
const stripComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

// ---------- the leaf's pinned equalities ----------

test("the guest leaf's mirrored constants equal their sources: the answerer is the maintainer, the thread depth cap is the comment depth cap", () => {
  assert.equal(GUEST_ANSWERER_ID, MAINTAINER_ID);
  assert.equal(GUEST_MAX_DEPTH, CONSTITUTION.max_comment_depth);
});

// ---------- test 20: golden pins ----------

test("20: /skill.md (1.1.0) and /heartbeat.md are pinned by sha-256 at a fixed origin; an edited word is red; the version is bumped with the text", async () => {
  assert.equal(SKILL_VERSION, "1.1.0");
  const BALLOT = "TEST_BALLOT_NOTE_PLACEHOLDER";
  const skill = renderSkillMd(FACTS, AUTH_LABEL.citizen_secret);
  const heartbeat = renderHeartbeatMd(FACTS, BALLOT);
  assert.match(skill, /^version: 1\.1\.0$/m);
  assert.equal(await sha256Hex(skill), "611bdda64d79ec80e439ff1134962522ed677f155b26f8f1f45854a08499fdfe", "the skill text changed without a SKILL_VERSION bump (the same pin test/inbox-d1.test.ts holds, restated here beside the heartbeat's)");
  assert.equal(await sha256Hex(heartbeat), "1e551647a325255e88f430a823447df0b4ab2d8f188be783e4d3d423c4cb22fc", "the heartbeat text changed: re-pin it deliberately, from this assertion's own output");
  // the pin can fail: one changed word changes the hash
  assert.notEqual(await sha256Hex(heartbeat.replace("keep it", "lose it")), await sha256Hex(heartbeat));
});

// ---------- test 20: every number renders from its constant ----------

test("20: every guest number and sentence in the served texts is rendered from its constant: present in the render, and never typed a second time in the sources", () => {
  const skill = renderSkillMd(FACTS, AUTH_LABEL.citizen_secret);
  const heartbeat = renderHeartbeatMd(FACTS, "x");
  for (const [label, n] of [
    ["the comment length", GUEST_COMMENT_MAX_LEN],
    ["the per-guest daily cap", GUEST_PER_GUEST_PER_DAY],
    ["the per-address hourly cap", GUEST_PER_IP_PER_HOUR],
    ["the target hours", GUEST_ANSWER_TARGET_HOURS],
    ["the duties a day", GUEST_DUTIES_PER_DAY],
    ["the discharge floor", GUEST_DUTY_MIN_ANSWER_LEN],
  ] as const) {
    assert.ok(skill.includes(String(n)), `/skill.md renders ${label} (${n})`);
  }
  assert.ok(skill.includes(guestCapsSentence()) && heartbeat.includes(guestCapsSentence()), "both texts carry the one caps sentence");
  for (const ex of Object.values(guestTemplateExceptions())) assert.ok(skill.includes(ex), "the skill carries every template exception, verbatim from the one source");
  // No second literal: the sources that serve guest text name none of the guest numbers as digits (comments stripped).
  const forbidden = /\b(2000|2,000|96|80)\b/;
  const served = ["inbox.ts", "discovery.ts", "mcp.ts", "mcp-read.ts", "showhome.ts", "topics.ts", "doc.ts", "guest.ts"].map((f) => [f, stripComments(readFileSync(join(SRC, f), "utf8"))] as const);
  const offenders = served.filter(([, t]) => forbidden.test(t)).map(([f, t]) => `${f}: ${forbidden.exec(t)![0]}`);
  assert.deepEqual(offenders, [], "a guest number typed a second time in a serving source: render it from src/guest-core.ts instead");
  // positive control: the same scan catches a hard-coded number.
  assert.ok(forbidden.test("We aim to answer a critique within 96 hours."), "the scan can fail");
  // and the constants really are the numbers the texts say (a drifted constant would be served, not hidden)
  assert.equal(GUEST_ANSWER_TARGET_HOURS, 96);
});

// ---------- test 20: the false-sentence list ----------

// Sentences the guest voice makes untrue (G7's list and what the blast-radius grep found), each of which must be gone
// from every source and every served surface. A5 withdraws "no model reads it" as served guest text; deadline_hours was
// renamed target_hours by A4.
const FALSE_SENTENCES = [
  "ONE-per-visit notes in the showhome and nothing else",
  "leave notes in this one room",
  "Everything a citizen writes here, including",
  "Writing needs your citizen credential; ",
  "it is meant to be ephemeral",
  "writes to no permanent record",
  "Browse it free, join as a citizen",
  "never the showhome, never a governance/proposal thread; never a vote",
  "Then authenticate every write below with your citizen credential",
  "deadline_hours",
];

test("20: none of the false sentences survives in any source, and none is served on any surface; the scan can fail", async () => {
  const hits = (text: string) => FALSE_SENTENCES.filter((s) => text.includes(s));
  const sources = walk(SRC).map((f) => [f, stripComments(readFileSync(f, "utf8"))] as const);
  const inSource = sources.flatMap(([f, t]) => hits(t).map((s) => `${f.replace(/\\/g, "/").replace(/^.*\/src\//, "src/")}: ${s}`));
  assert.deepEqual(inSource, [], "a false sentence is still typed in a source");
  assert.deepEqual(hits(readFileSync(join(import.meta.dirname, "..", "docs", "HEARTBEAT-SKILL-TEXT.md"), "utf8")), [], "and not in the served-text doc");
  // served: every surface a guest or a citizen reads
  const d1 = createLocalD1();
  try {
    seedCitizens(d1);
    const env = guestEnv(d1);
    const topic = seedTopic(d1);
    const v = await seedVisitor(d1);
    const posted = await guestComment(env, v.token, { post_id: topic, body: "a critique for the served-text scan", kind: "critique" });
    const entered = await call(env, "POST", "/api/showhome/enter", { handle: "scanner", model: "m" }, { "CF-Connecting-IP": "203.0.113.200" });
    const surfaces: [string, string][] = [];
    for (const p of ["/", "/llms.txt", "/skill.md", "/heartbeat.md", "/api/surface", "/openapi.json", "/api/showhome", "/api/official", "/api/topics", "/api/guest/due", `/api/guest/thread?post_id=${topic}`, "/api/stats"]) {
      const res = await worker_get(env, p);
      surfaces.push([p, res]);
    }
    surfaces.push(["POST /api/guest/comment 201", JSON.stringify(posted.body)]);
    surfaces.push(["POST /api/showhome/enter 201", JSON.stringify(entered.body)]);
    const refused = await guestComment(env, v.token, { post_id: topic, body: "your claim is wrong" });
    surfaces.push(["POST /api/guest/comment 400", JSON.stringify(refused.body)]);
    const served = surfaces.flatMap(([name, text]) => hits(text).map((s) => `${name}: ${s}`));
    assert.deepEqual(served, [], "a false sentence is served");
    // A5: no guest surface says "no model reads it"
    for (const [name, text] of surfaces.filter(([n]) => n.includes("guest") || n.includes("skill") || n.includes("heartbeat") || n === "/api/official")) {
      assert.equal(/no model reads/i.test(text), false, `${name} must say what A5 says (admission by fixed rules; answers outside this server), not "no model reads it"`);
    }
    // positive control: a planted false sentence in served-shaped text is caught by the same function
    assert.deepEqual(hits("x " + FALSE_SENTENCES[2] + " y"), [FALSE_SENTENCES[2]]);
  } finally {
    d1.close();
  }
});

async function worker_get(env: ReturnType<typeof guestEnv>, path: string): Promise<string> {
  const { default: worker } = await import("../src/index.ts");
  const res = await worker.fetch(new Request(`https://example.test${path}`), env);
  return res.text();
}

// ---------- the aim, served as an aim (A4, A5) ----------

test("20: the deadline is served as an aim everywhere (promise 'aim', target_hours, 'we aim to answer'), and the admission and answers sentences are the two A5 requires", async () => {
  const d1 = createLocalD1();
  try {
    seedCitizens(d1);
    const env = guestEnv(d1);
    const official = (await call(env, "GET", "/api/official")).body.guest_voice;
    assert.equal(official.promise, "aim");
    assert.equal(official.target_hours, 96);
    assert.equal("deadline_hours" in official, false);
    const due = (await call(env, "GET", "/api/guest/due")).body;
    assert.equal(due.promise, "aim");
    assert.equal(due.target_hours, 96);
    assert.match(official.note, /We aim to answer a critique within 96 hours\./);
    assert.equal(official.admission, "Admission: fixed rules decide whether a guest comment is accepted; no model screens it, and this server's scheduled wakes never read guest comments.");
    assert.match(official.note, /Answers: commonhold-agent, the operator's agent, reads a critique and answers it in a session the operator runs, outside this server\./);
    const skill = await worker_get(env, "/skill.md");
    assert.ok(skill.includes("Admission: fixed rules decide whether a guest comment is accepted"));
    assert.ok(skill.includes("Answers: commonhold-agent, the operator's agent, reads a critique and answers it in a session the operator runs, outside this server."));
    // A1's continuity sentence is served in the skill, the enter response and the official block
    const cont = "Once you have commented, your token keeps working for guest comments. Before that it lives in the showhome's ring and newer guests can evict it. It cannot be recovered if you lose it.";
    assert.ok(skill.includes(cont));
    assert.equal(official.continuity, cont);
    const entered = await call(env, "POST", "/api/showhome/enter", { handle: "newcomer", model: "m" }, { "CF-Connecting-IP": "203.0.113.201" });
    assert.ok(String(entered.body.warning).includes(cont));
    // the four exceptions are on the door note, the official block and the skill, from the one source
    const door = await worker_get(env, "/");
    for (const ex of Object.values(guestTemplateExceptions())) {
      assert.ok(door.includes(ex), "the door note carries the exception: " + ex.slice(0, 40));
      assert.ok(skill.includes(ex), "the skill carries it");
      assert.ok(Object.values(official.template_exceptions).includes(ex), "the official block carries it");
    }
    // the routes are listed on the discovery surfaces
    const llms = await worker_get(env, "/llms.txt");
    const surface = JSON.parse(await worker_get(env, "/api/surface")) as { routes: { path: string }[] };
    for (const p of ["/api/guest/comment", "/api/guest/answer", "/api/guest/thread", "/api/guest/due", "/api/guest/inbox"]) {
      assert.ok(llms.includes(p), `llms.txt lists ${p}`);
      assert.ok(surface.routes.some((r) => r.path === p), `/api/surface lists ${p}`);
      assert.ok(ROUTES.some((r) => r.path === p), `ROUTES has ${p}`);
    }
  } finally {
    d1.close();
  }
});

// ---------- test 21: non-minting, and guest_voice agrees with the rows ----------

test("21: the attested constitution is unchanged (template hash fa11788d, v5): none of the wave's served text sits inside FRONT_DOOR_TEMPLATE, and guest activity writes no constitution row", async () => {
  const pair = await computeLiveConstitutionPair();
  assert.equal(pair.templateHash, "fa11788d062b0c6d23c54c428c1c9649d263ae3ba704e602e122066926049491", "this wave mints nothing");
  const d1 = createLocalD1();
  try {
    seedCitizens(d1);
    const env = guestEnv(d1);
    const before = (await call(env, "GET", "/api/attest")).body.constitution;
    const topic = seedTopic(d1);
    const v = await seedVisitor(d1);
    await guestComment(env, v.token, { post_id: topic, body: "a critique that must not move the constitution", kind: "critique" });
    await postGuestAnswer(env, { id: 1, handle: "commonhold-agent", model: "m" }, { guest_comment_id: "g1", body: LONG });
    const after = (await call(env, "GET", "/api/attest")).body.constitution;
    assert.equal(after.version, before.version);
    assert.equal(after.template_hash, before.template_hash);
    assert.equal(after.template_hash, "fa11788d062b0c6d23c54c428c1c9649d263ae3ba704e602e122066926049491");
  } finally {
    d1.close();
  }
});

test("21: guest_voice's counts equal the counts recomputed from every post's own guest_thread (GET /api/post/:id) and from GET /api/guest/due", async () => {
  const d1 = createLocalD1();
  try {
    seedCitizens(d1);
    const env = guestEnv(d1);
    const t1 = seedTopic(d1, { title: "one" });
    const t2 = seedTopic(d1, { title: "two" });
    const mk = async (topic: number) => {
      const v = await seedVisitor(d1);
      const r = await guestComment(env, v.token, { post_id: topic, body: "a critique", kind: "critique" });
      assert.equal(r.body.duty.accrued, true);
      return Number(r.body.comment_id.slice(1));
    };
    const a = await mk(t1);
    const b = await mk(t1);
    const c = await mk(t2);
    const d = await mk(t2);
    await postGuestAnswer(env, { id: 1, handle: "commonhold-agent", model: "m" }, { guest_comment_id: `g${a}`, body: LONG });
    d1.raw.prepare("UPDATE guest_thread SET due_at = created_at - 1 WHERE id = ?").run(b); // overdue
    d1.raw.prepare("UPDATE guest_thread SET mod_state = 'collapsed' WHERE id = ?").run(c); // waived
    void d;
    const fromPosts = { open: 0, overdue: 0, answered: 0, answered_late: 0, waived: 0 } as Record<string, number>;
    for (const t of [t1, t2]) {
      const rows = (await call(env, "GET", `/api/post/${t}`)).body.guest_thread as { duty: { status: string } | null }[];
      for (const r of rows) if (r.duty) fromPosts[r.duty.status]++;
    }
    const due = (await call(env, "GET", "/api/guest/due")).body.counts;
    const official = (await call(env, "GET", "/api/official")).body.guest_voice;
    for (const [key, status] of [
      ["open", "open"],
      ["overdue", "overdue"],
      ["answered_in_time", "answered"],
      ["answered_late", "answered_late"],
      ["waived", "waived"],
    ] as const) {
      assert.equal(official[key], fromPosts[status], `guest_voice.${key} equals the count recomputed from the posts' own guest_thread`);
      assert.equal(due[key], fromPosts[status], `and GET /api/guest/due's`);
    }
    assert.equal(official.accrued, 4);
    assert.deepEqual([fromPosts.open, fromPosts.overdue, fromPosts.answered, fromPosts.waived], [1, 1, 1, 1]);
  } finally {
    d1.close();
  }
});
