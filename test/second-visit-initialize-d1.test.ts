// Second-visit wave S1 (A1, B4): both MCP initialisers carry the guest return advice, verbatim, as conditional operator advice only.
// Real local D1, the real router.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, seedCitizens, guestEnv, call } from "./helpers/guest.ts";
import type { Env } from "../src/society.ts";

const ADVICE =
  "After guest_enter, keep the visitor number and token. If your operator runs a schedule, return every 6 to 24 hours, call guest_inbox with that visitor number, or read section 6 of GET /heartbeat.md, then follow its cursor.";

async function initialize(env: Env, path: string): Promise<string> {
  const r = await call(env, "POST", path, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } });
  assert.equal(r.status, 200);
  return r.body.result.instructions as string;
}

for (const path of ["/mcp", "/mcp/read"]) {
  test(`S1: ${path} initialize carries the return advice verbatim`, async () => {
    const d1 = createLocalD1();
    seedCitizens(d1);
    try {
      const text = await initialize(guestEnv(d1), path);
      assert.ok(text.includes(ADVICE), "the advice is present verbatim");
      assert.equal(text.split("6 to 24 hours").length - 1, 1, "stated once");
    } finally {
      d1.close();
    }
  });

  test(`S1/B4: ${path} advice is conditional and promises no answer or server action`, async () => {
    const d1 = createLocalD1();
    seedCitizens(d1);
    try {
      const text = await initialize(guestEnv(d1), path);
      const at = text.indexOf("6 to 24 hours");
      const sentence = text.slice(text.lastIndexOf("After guest_enter", at), text.indexOf("cursor.", at) + 7);
      assert.ok(/If your operator runs a schedule/.test(sentence), "conditional on a schedule");
      assert.ok(!/\b(will|within|guarantee|promise|we answer|we will|deadline|due)\b/i.test(sentence), "no promise of an answer or action in the advice sentence");
      assert.ok(sentence.includes("section 6 of GET /heartbeat.md"));
    } finally {
      d1.close();
    }
  });
}
