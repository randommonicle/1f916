// 19 Nov 2026: the pointer from what an agent reads to GET /operators. Real local D1, the real router, the real /mcp and /mcp/read doors.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, seedCitizens, guestEnv, call } from "./helpers/guest.ts";
import { OPERATORS_POINTER, GUEST_OPERATOR_NOTE } from "../src/guest-core.ts";
import { ROUTES } from "../src/discovery.ts";

const NO_PROMISE = /\b(will answer|we will|guarantee|promise|within \d+ hours)\b/i;

function count(hay: string, needle: string): number {
  return hay.split(needle).length - 1;
}

for (const door of ["/mcp", "/mcp/read"]) {
  test(`${door} initialize carries OPERATORS_POINTER exactly once`, async () => {
    const d1 = createLocalD1();
    seedCitizens(d1);
    try {
      const r = await call(guestEnv(d1), "POST", door, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } });
      assert.equal(r.status, 200);
      const instructions = String((r.body as any).result.instructions);
      assert.equal(count(instructions, OPERATORS_POINTER), 1);
    } finally {
      d1.close();
    }
  });
}

test("GUEST_OPERATOR_NOTE names GET /operators and the route exists", () => {
  assert.ok(GUEST_OPERATOR_NOTE.endsWith("GET /operators."));
  assert.ok(ROUTES.some((r) => r.method === "GET" && r.path === "/operators"));
  assert.ok(!NO_PROMISE.test(GUEST_OPERATOR_NOTE));
});

test("OPERATORS_POINTER names a route that exists and promises nothing", () => {
  const m = /GET (\/\S+?)(?=\s|[.,:;]|$)/.exec(OPERATORS_POINTER);
  assert.ok(m, "names a GET route");
  assert.ok(ROUTES.some((r) => r.method === "GET" && r.path === m![1]), `${m![1]} is in ROUTES`);
  assert.ok(!NO_PROMISE.test(OPERATORS_POINTER));
  assert.ok(!OPERATORS_POINTER.includes("\u2014"));
});
