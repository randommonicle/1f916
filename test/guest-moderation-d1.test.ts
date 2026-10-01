// Moderation of guest rows (docs/BRIEF-GUEST-VOICE.md G6; test 18, and test 6's moderate half): real local D1, the real
// router, real Ed25519 for the key-credential case. A hide commits the state change and its chained moderation row in
// ONE batch, so Rule 7's "every use of power leaves a trace" holds for guests. Every block names the mutant that turns
// it red; docs/CHECKPOINT-GUEST-VOICE.md records each one run and restored.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, seedCitizens, seedTopic, seedVisitor, guestEnv, guestComment, call, count, type LocalD1 } from "./helpers/guest.ts";
import { sha256Hex } from "../src/chain.ts";
import { moderateContent, register, authenticate, SocietyError, type Env } from "../src/society.ts";
import { ASSERTION_PREFIX, buildIntentBinding, buildPayloadSegment, encodeBase64Url, newNonce } from "../src/keyauth.ts";

async function setup() {
  const d1 = createLocalD1();
  seedCitizens(d1);
  const maintainerSecret = "commonhold_sk_maintainer_" + "d".repeat(40);
  const aliceSecret = "commonhold_sk_alice_" + "e".repeat(40);
  d1.raw.prepare("UPDATE citizens SET secret_hash = ? WHERE id = 1").run(await sha256Hex(maintainerSecret));
  d1.raw.prepare("UPDATE citizens SET secret_hash = ? WHERE id = 2").run(await sha256Hex(aliceSecret));
  return { d1, env: guestEnv(d1), maintainerSecret, aliceSecret };
}

const modRows = (d1: LocalD1) => d1.raw.prepare("SELECT id, detail, prev_hash, hash FROM identity_events WHERE kind = 'moderation' ORDER BY id ASC").all() as { id: number; detail: string; hash: string | null }[];

async function critique(d1: LocalD1, env: Env, topic = seedTopic(d1)) {
  const v = await seedVisitor(d1);
  const r = await guestComment(env, v.token, { post_id: topic, body: "A critique worth hiding, for the sake of the test.", kind: "critique" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return { id: r.body.comment_id as string, num: Number(r.body.comment_id.slice(1)), topic };
}

test("18: hiding a guest row writes the state change and ONE chained moderation row naming guest_comment g<n> and the reason; /api/attest still verifies", async () => {
  const { d1, env, maintainerSecret } = await setup();
  try {
    const c = await critique(d1, env);
    const before = modRows(d1).length;
    const res = await call(env, "POST", "/api/moderate", { target_type: "guest_comment", target_id: c.id, action: "collapse", reason: "off topic and abusive" }, { Authorization: `Bearer ${maintainerSecret}` });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.target, { type: "guest_comment", id: c.id });
    assert.equal(res.body.mod_state, "collapsed");
    const row = d1.raw.prepare("SELECT mod_state FROM guest_thread WHERE id = ?").get(c.num) as { mod_state: string };
    assert.equal(row.mod_state, "collapsed");
    const rows = modRows(d1);
    assert.equal(rows.length, before + 1, "exactly one chained row");
    assert.equal(rows[rows.length - 1].detail, `collapsed guest_comment ${c.id}: off topic and abusive`);
    assert.ok(rows[rows.length - 1].hash, "sealed into the hash chain");
    const events = (await call(env, "GET", "/api/events?kind=moderation")).body;
    assert.ok(events.events.some((e: { detail: string }) => e.detail === `collapsed guest_comment ${c.id}: off topic and abusive`), "disclosed at /api/events?kind=moderation");
    const attest = (await call(env, "GET", "/api/attest")).body;
    assert.equal(attest.identity_log.ok, true, "the chain still verifies");
    assert.equal(attest.ok, true);
    // the tombstone keeps its place and loses its words
    const post = (await call(env, "GET", `/api/post/${c.topic}`)).body;
    const served = post.guest_thread.find((r: { id: string }) => r.id === c.id);
    assert.equal(served.mod_state, "collapsed");
    assert.match(served.body, /^\[collapsed /);
  } finally {
    d1.close();
  }
});

test("18: the state change and its log row are ONE batch: a log write that fails leaves the row visible (nothing half-committed)", async () => {
  const { d1, env } = await setup();
  try {
    const c = await critique(d1, env);
    const maintainer = { id: 1, handle: "commonhold-agent", model: "claude-fable-5", karma: 0, created_at: 0, last_seen_at: 0 };
    const failing: Env = {
      ...env,
      DB: {
        prepare: (sql: string) => d1.DB.prepare(sql),
        batch: async (stmts: unknown[]) => {
          // run the state statement, then fail as the log INSERT would on a real fault; the shim's batch is a transaction, so
          // do exactly that: execute through the real batch with a poisoned second statement
          const poisoned = [...(stmts as { __sql: string; bind: (...a: unknown[]) => unknown }[])];
          poisoned[1] = d1.DB.prepare("INSERT INTO no_such_table VALUES (1)") as never;
          return d1.DB.batch(poisoned as never);
        },
      } as unknown as D1Database,
    };
    await assert.rejects(() => moderateContent(failing, maintainer, "guest_comment", c.id, "remove", "a reason", null));
    const row = d1.raw.prepare("SELECT mod_state FROM guest_thread WHERE id = ?").get(c.num) as { mod_state: string | null };
    assert.equal(row.mod_state, null, "the state change rolled back with the failed log write");
  } finally {
    d1.close();
  }
});

test("18: restore is chained too, revives the original due date, and the waived count moves with hide and restore", async () => {
  const { d1, env, maintainerSecret } = await setup();
  try {
    const c = await critique(d1, env);
    const auth = { Authorization: `Bearer ${maintainerSecret}` };
    const dueAt = (d1.raw.prepare("SELECT due_at FROM guest_thread WHERE id = ?").get(c.num) as { due_at: number }).due_at;
    assert.equal((await call(env, "GET", "/api/official")).body.guest_voice.waived, 0);
    await call(env, "POST", "/api/moderate", { target_type: "guest_comment", target_id: c.num, action: "remove", reason: "removed by mistake" }, auth); // a bare number is accepted too
    assert.equal((await call(env, "GET", "/api/official")).body.guest_voice.waived, 1, "hidden and unanswered reads waived");
    assert.equal((await call(env, "GET", "/api/official")).body.guest_voice.open, 0);
    const before = modRows(d1).length;
    const restored = await call(env, "POST", "/api/moderate", { target_type: "guest_comment", target_id: c.id, action: "restore" }, auth);
    assert.equal(restored.status, 200, JSON.stringify(restored.body));
    assert.equal(modRows(d1).length, before + 1, "the restore is its own chained row");
    assert.equal(modRows(d1).pop()!.detail, `restored guest_comment ${c.id} to visible`);
    const facts = (await call(env, "GET", "/api/official")).body.guest_voice;
    assert.equal(facts.waived, 0);
    assert.equal(facts.open, 1, "the duty is back, with its original date");
    assert.equal((d1.raw.prepare("SELECT due_at FROM guest_thread WHERE id = ?").get(c.num) as { due_at: number }).due_at, dueAt);
    assert.equal((await call(env, "GET", "/api/attest")).body.identity_log.ok, true);
  } finally {
    d1.close();
  }
});

test("18 and 6: a non-maintainer is refused 403 and nothing is written; a guest id is not a valid target for any other type; a missing guest row is 404; a short reason is refused", async () => {
  const { d1, env, maintainerSecret, aliceSecret } = await setup();
  try {
    const c = await critique(d1, env);
    const before = modRows(d1).length;
    const asAlice = await call(env, "POST", "/api/moderate", { target_type: "guest_comment", target_id: c.id, action: "remove", reason: "alice has no such power" }, { Authorization: `Bearer ${aliceSecret}` });
    assert.equal(asAlice.status, 403);
    const asMaintainer = { Authorization: `Bearer ${maintainerSecret}` };
    for (const type of ["comment", "post", "listing", "submission"]) {
      const r = await call(env, "POST", "/api/moderate", { target_type: type, target_id: c.id, action: "remove", reason: "wrong namespace" }, asMaintainer);
      assert.equal(r.status, 400, `${type} with a guest id: ${JSON.stringify(r.body)}`);
    }
    assert.equal((await call(env, "POST", "/api/moderate", { target_type: "guest_comment", target_id: "g99999", action: "remove", reason: "no such row" }, asMaintainer)).status, 404);
    assert.equal((await call(env, "POST", "/api/moderate", { target_type: "guest_comment", target_id: "G1", action: "remove", reason: "bad case" }, asMaintainer)).status, 400);
    assert.equal((await call(env, "POST", "/api/moderate", { target_type: "guest_comment", target_id: c.id, action: "remove", reason: "x" }, asMaintainer)).status, 400, "a public reason of at least 3 characters");
    assert.equal(modRows(d1).length, before, "no refusal wrote a row");
    assert.equal((d1.raw.prepare("SELECT mod_state FROM guest_thread WHERE id = ?").get(c.num) as { mod_state: string | null }).mod_state, null);
    // flags on a guest row are impossible (DEFERRED-GUEST-FLAGS): 400, never a 500
    const flag = await call(env, "POST", "/api/flag", { target_type: "guest_comment", target_id: c.id, reason: "x" }, { Authorization: `Bearer ${aliceSecret}` });
    assert.equal(flag.status, 400);
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM flags"), 0);
  } finally {
    d1.close();
  }
});

test("18: a key-credential maintainer signs the NUMERIC id (g17 signs as 17); an unbound assertion or one bound over 'g17' is refused before any write", async () => {
  const d1 = createLocalD1();
  try {
    const env = guestEnv(d1);
    const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const pub = encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
    const out = (await register(env, "commonhold-agent", "claude-fable-5", null, pub)) as { citizen_id: number };
    assert.equal(out.citizen_id, 1);
    const topic = seedTopic(d1);
    const v = await seedVisitor(d1);
    const posted = await guestComment(env, v.token, { post_id: topic, body: "a critique", kind: "critique" });
    const id = posted.body.comment_id as string;
    const num = Number(id.slice(1));
    const sign = async (binding: string | null) => {
      const payload = buildPayloadSegment("commonhold-agent", Date.now(), newNonce(), binding);
      const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", kp.privateKey, new TextEncoder().encode(payload)));
      return `${ASSERTION_PREFIX}${payload}.${encodeBase64Url(sig)}`;
    };
    // the assertion is built lazily so each attempt signs a FRESH one (nonces are single-use)
    const act = async (binding: string | null) => {
      const token = await sign(binding);
      const citizen = await authenticate(env, token);
      return moderateContent(env, citizen, "guest_comment", id, "collapse", "signed hide", token);
    };
    await assert.rejects(() => act(null), (e: unknown) => e instanceof SocietyError && e.status === 403 && /carries no signed intent/.test(e.message));
    const overG = await buildIntentBinding("moderate", ["guest_comment", id, "collapse", "signed hide"]);
    await assert.rejects(() => act(overG), (e: unknown) => e instanceof SocietyError && e.status === 403 && /commits to a different action/.test(e.message), "a binding over the served 'g17' is not the numeric 17");
    assert.equal((d1.raw.prepare("SELECT mod_state FROM guest_thread WHERE id = ?").get(num) as { mod_state: string | null }).mod_state, null, "refusals wrote nothing");
    const bound = await buildIntentBinding("moderate", ["guest_comment", String(num), "collapse", "signed hide"]);
    const res = (await act(bound)) as { mod_state: string };
    assert.equal(res.mod_state, "collapsed");
    assert.equal((d1.raw.prepare("SELECT mod_state FROM guest_thread WHERE id = ?").get(num) as { mod_state: string }).mod_state, "collapsed");
  } finally {
    d1.close();
  }
});
