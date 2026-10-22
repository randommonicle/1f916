// Second-visit wave S3 (A3, B2, B4, C2, C3, C5, D6): the guest_comment answer carries next_visit (exactly four fields), a top-level continuity sentence, and keeps the
// existing guest_inbox string; REST and MCP serve the same answer for an ordinary comment, an accepted critique, and a critique that accrues no duty. Real local D1.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.ts";
import { createLocalD1, seedCitizens, seedPost, seedTopic, seedVisitor, guestEnv, guestComment, call, freshIp } from "./helpers/guest.ts";
import { GUEST_CONTINUITY_SENTENCE } from "../src/guest-core.ts";
import type { Env } from "../src/society.ts";

const ORIGIN = "https://example.test";

function fresh() {
  const d1 = createLocalD1();
  const { alice } = seedCitizens(d1);
  return { d1, env: guestEnv(d1), alice };
}

async function viaMcp(env: Env, token: string, args: Record<string, unknown>) {
  const r = await call(env, "POST", "/mcp", { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "guest_comment", arguments: { token, ...args } } }, { "CF-Connecting-IP": freshIp() });
  assert.equal(r.status, 200);
  assert.notEqual(r.body.result.isError, true, JSON.stringify(r.body));
  return JSON.parse(r.body.result.content[0].text) as Record<string, any>;
}

type Kind = "ordinary" | "critique-topic" | "critique-ordinary";

// Two identical worlds so both transports get the same ids; returns the REST and MCP answers for one scenario.
async function both(kind: Kind) {
  const a = fresh();
  const b = fresh();
  try {
    const mk = async (f: ReturnType<typeof fresh>) => {
      const post = kind === "critique-topic" ? seedTopic(f.d1) : seedPost(f.d1, f.alice);
      return { post, v: await seedVisitor(f.d1, "wren") };
    };
    const [ra, rb] = [await mk(a), await mk(b)];
    const input = { post_id: ra.post, body: "A considered point about the rule.", kind: kind === "ordinary" ? "comment" : "critique" };
    const rest = await guestComment(a.env, ra.v.token, input);
    assert.equal(rest.status, 201, JSON.stringify(rest.body));
    const mcp = await viaMcp(b.env, rb.v.token, { ...input, post_id: rb.post });
    return { rest: rest.body, mcp, visitor: ra.v.id };
  } finally {
    a.d1.close();
    b.d1.close();
  }
}

const norm = (x: Record<string, any>) => ({ ...x, duty: { ...x.duty, due_at: typeof x.duty.due_at }, next_visit: { ...x.next_visit, due_at: typeof x.next_visit.due_at } });

function checkShape(body: Record<string, any>, visitor: number, accrued: boolean) {
  assert.deepEqual(Object.keys(body.next_visit).sort(), ["due_at", "guest_inbox", "heartbeat", "interval_hours_advice"], "exactly the four fields");
  assert.equal(body.next_visit.guest_inbox, `${ORIGIN}/api/guest/inbox?guest=${visitor}`);
  assert.equal(body.next_visit.heartbeat, `${ORIGIN}/heartbeat.md`);
  assert.deepEqual(body.next_visit.interval_hours_advice, { min: 6, max: 24 });
  assert.equal(body.continuity, GUEST_CONTINUITY_SENTENCE, "the shared sentence, top level");
  assert.ok(!("continuity" in body.next_visit), "not inside next_visit");
  assert.ok(typeof body.guest_inbox === "string" && body.guest_inbox.startsWith(`GET /api/guest/inbox?guest=${visitor} lists the answers to you`), "the existing guest_inbox string is kept");
  assert.equal(body.duty.accrued, accrued);
  if (accrued) {
    assert.equal(typeof body.next_visit.due_at, "number");
    assert.equal(body.next_visit.due_at, body.duty.due_at, "due_at is the duty's own date");
  } else {
    assert.equal(body.next_visit.due_at, null, "no duty, no date");
    assert.ok(!("due_at" in body.duty), "no deadline on the duty either");
    assert.ok(!/"due_at":\d/.test(JSON.stringify(body)), "no implied deadline anywhere in the answer");
  }
}

for (const [kind, accrued, label] of [
  ["ordinary", false, "an ordinary comment"],
  ["critique-topic", true, "an accepted critique on an open standing topic"],
  ["critique-ordinary", false, "a critique on an ordinary post (accrues no duty)"],
] as Array<[Kind, boolean, string]>) {
  test(`S3: ${label}: next_visit, continuity and the kept guest_inbox string, identical on REST and MCP`, async () => {
    const { rest, mcp, visitor } = await both(kind);
    checkShape(rest, visitor, accrued);
    checkShape(mcp, visitor, accrued);
    assert.deepEqual(norm(mcp), norm(rest), "the same body on both transports");
    if (!accrued && kind === "critique-ordinary") assert.ok(/ordinary post/.test(rest.duty.reason), rest.duty.reason);
  });
}

test("S3/B2: the origin is the request's own origin on both transports, not a constant", async () => {
  const { d1, env, alice } = fresh();
  try {
    const post = seedPost(d1, alice);
    const v = await seedVisitor(d1, "owl");
    const other = "https://staging.example.org";
    const restRes = await worker.fetch(
      new Request(`${other}/api/guest/comment`, { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": freshIp() }, body: JSON.stringify({ token: v.token, post_id: post, body: "first" }) }),
      env,
    );
    assert.equal(restRes.status, 201);
    const restBody = (await restRes.json()) as Record<string, any>;
    assert.equal(restBody.next_visit.guest_inbox, `${other}/api/guest/inbox?guest=${v.id}`);
    assert.equal(restBody.next_visit.heartbeat, `${other}/heartbeat.md`);
    const mcpRes = await worker.fetch(
      new Request(`${other}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "CF-Connecting-IP": freshIp() },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "guest_comment", arguments: { token: v.token, post_id: post, body: "second" } } }),
      }),
      env,
    );
    const mcpBody = JSON.parse(((await mcpRes.json()) as any).result.content[0].text) as Record<string, any>;
    assert.equal(mcpBody.next_visit.guest_inbox, `${other}/api/guest/inbox?guest=${v.id}`);
    assert.equal(mcpBody.next_visit.heartbeat, `${other}/heartbeat.md`);
  } finally {
    d1.close();
  }
});
