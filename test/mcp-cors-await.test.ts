// A1 (docs/BRIEF-MCP-LISTING-READY.md): CORS on both MCP doors, and the missing
// `await`. Before this wave, src/mcp.ts and src/mcp-read.ts built their own Response
// objects with bare Response.json()/new Response, so a POST to /mcp or /mcp/read
// carried no Access-Control-Allow-Origin -- every browser-based MCP client or
// inspector failed to read the answer. The same two dispatch lines in src/index.ts
// were also missing `await` (DEFERRED-MCP-DISPATCH-AWAIT): a non-SocietyError thrown
// by any tool call rejected fetch()'s own already-returned promise, escaping the
// router's try/catch (its JSON 500, and its log line) entirely.
//
// Round-trips through the real router (worker.fetch, via callFetch below), not
// handleMcp/handleMcpRead directly -- withCors lives in src/index.ts, so a test that
// called the door handlers directly would never exercise it at all.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, type LocalD1 } from "./helpers/local-d1.ts";
import type { Env } from "../src/society.ts";
import worker from "../src/index.ts";

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
async function callFetch(request: Request, env: Env): Promise<Response> {
  return (worker.fetch as unknown as (r: Request, e: Env, c: unknown) => Promise<Response>)(request, env, ctx);
}

function makeEnv(d1: LocalD1): Env {
  return {
    DB: d1.DB,
    TREASURY_ADDRESS: "0x0000000000000000000000000000000000000001",
    FACILITATOR_URL: "https://facilitator.invalid",
    REGISTRATION_MODE: "open",
  } as unknown as Env;
}

function rpc(method: string, params?: Record<string, unknown>, id: number | null = 1) {
  return JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
}

// ---------- CORS ----------

test("A1 CORS: /mcp and /mcp/read carry Access-Control-Allow-Origin: * on initialize, tools/list, the 405 GET, and the 202 notification", async () => {
  const d1 = createLocalD1();
  try {
    const env = makeEnv(d1);
    for (const path of ["/mcp", "/mcp/read"] as const) {
      const initRes = await callFetch(
        new Request(`https://example.invalid${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", Origin: "https://client.example.invalid" },
          body: rpc("initialize", {}),
        }),
        env,
      );
      assert.equal(initRes.status, 200, `${path} initialize must succeed`);
      assert.equal(initRes.headers.get("Access-Control-Allow-Origin"), "*", `${path} initialize must carry CORS`);

      const listRes = await callFetch(
        new Request(`https://example.invalid${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", Origin: "https://client.example.invalid" },
          body: rpc("tools/list"),
        }),
        env,
      );
      assert.equal(listRes.status, 200, `${path} tools/list must succeed`);
      assert.equal(listRes.headers.get("Access-Control-Allow-Origin"), "*", `${path} tools/list must carry CORS`);

      const getRes = await callFetch(new Request(`https://example.invalid${path}`, { method: "GET", headers: { Origin: "https://client.example.invalid" } }), env);
      assert.equal(getRes.status, 405, `${path} GET must still answer 405`);
      assert.equal(getRes.headers.get("Access-Control-Allow-Origin"), "*", `${path} GET 405 must carry CORS`);

      const notifyRes = await callFetch(
        new Request(`https://example.invalid${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", Origin: "https://client.example.invalid" },
          body: rpc("notifications/initialized", undefined, null),
        }),
        env,
      );
      assert.equal(notifyRes.status, 202, `${path} notification must still answer 202`);
      assert.equal(notifyRes.headers.get("Access-Control-Allow-Origin"), "*", `${path} 202 notification must carry CORS`);
    }
  } finally {
    d1.close();
  }
});

test("A1 CORS preflight: OPTIONS names Mcp-Protocol-Version and Mcp-Method in Access-Control-Allow-Headers", async () => {
  const d1 = createLocalD1();
  try {
    const env = makeEnv(d1);
    for (const path of ["/mcp", "/mcp/read"] as const) {
      const res = await callFetch(new Request(`https://example.invalid${path}`, { method: "OPTIONS" }), env);
      const allow = res.headers.get("Access-Control-Allow-Headers") ?? "";
      assert.match(allow, /Mcp-Protocol-Version/, `${path} preflight must name Mcp-Protocol-Version`);
      assert.match(allow, /Mcp-Method/, `${path} preflight must name Mcp-Method`);
      // Sanity: the pre-existing headers must still be present too (nothing dropped).
      assert.match(allow, /Content-Type/);
      assert.match(allow, /Authorization/);
      assert.match(allow, /X-PAYMENT/);
      assert.equal(res.headers.get("Access-Control-Allow-Methods"), "GET, POST, OPTIONS", "methods must be unchanged");
      assert.equal(res.headers.get("Access-Control-Expose-Headers"), "X-PAYMENT-RESPONSE", "expose-headers must be unchanged (the doors mint no session id)");
    }
  } finally {
    d1.close();
  }
});

// ---------- the missing await ----------

test("A1 await fix: a tool call whose handler throws a plain Error resolves to the router's own JSON 500, never a rejected fetch() promise (DEFERRED-MCP-DISPATCH-AWAIT)", async () => {
  // A D1 stub whose prepare() throws synchronously -- officialFacts() (the "official"
  // tool, available on both doors) calls topicCounts(env.DB), which calls
  // db.prepare(...) directly inside a Promise.all([...]) argument list, so this throw
  // happens before any query result exists: a clean stand-in for "a tool's handler
  // failed with something that is not a SocietyError".
  const dbStub = {
    prepare() {
      throw new Error("boom: D1 stub failure, not a SocietyError");
    },
  } as unknown as Env["DB"];
  const env = { DB: dbStub, TREASURY_ADDRESS: "0x0", FACILITATOR_URL: "https://facilitator.invalid", REGISTRATION_MODE: "open" } as unknown as Env;

  for (const path of ["/mcp", "/mcp/read"] as const) {
    const request = new Request(`https://example.invalid${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: rpc("tools/call", { name: "official", arguments: {} }),
    });
    const [outcome] = await Promise.allSettled([callFetch(request, env)]);
    assert.equal(outcome.status, "fulfilled", `${path}: fetch() must resolve even when a tool handler throws a plain Error, not reject (a rejected outcome here IS the pre-fix bug)`);
    const response = (outcome as PromiseFulfilledResult<Response>).value;
    assert.equal(response.status, 500, `${path}: the router's own catch block must answer 500`);
    const responseBody = (await response.json()) as { error: string };
    assert.equal(responseBody.error, "Internal error. The society apologizes.", `${path}: the router's own generic 500 body, proving the router's catch ran (not some other 500)`);
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), "*", `${path}: even the 500 path (json() helper) carries CORS`);
  }
});
