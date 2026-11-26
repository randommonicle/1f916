// The above-head cursor refusal carries a code, and both cursor notes say a refusal names the first failure only, parameters
// before cursor (soft-power and load-bearing-2, 1f916 post 9594, 25-26 Nov 2026: the combination probe showed a stray parameter
// hides an above-head cursor, and the above-head 400 was the one inbox 400 without a code). Real local D1, the real router.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createLocalD1, seedCitizens, seedTopic, seedVisitor, guestEnv, guestComment, call, type LocalD1 } from "./helpers/guest.ts";
import type { Env } from "../src/society.ts";

async function world(): Promise<{ d1: LocalD1; env: Env; visitor: number }> {
  const d1 = createLocalD1();
  seedCitizens(d1);
  const env = guestEnv(d1);
  const topic = seedTopic(d1);
  const v = await seedVisitor(d1, "wren");
  const g = await guestComment(env, v.token, { post_id: topic, body: "a critique", kind: "critique" });
  assert.equal(g.status, 201, JSON.stringify(g.body));
  return { d1, env, visitor: v.id };
}

const SENTENCE =
  "A part above the newest row of its table is refused with 400, code cursor_above_head. A refusal names the first failure only: the parameters are checked before the cursor, so a cursor refused with a parameter was not compared, and of several parts above their heads only the first, in this cursor's own order, is named.";

test("the above-head refusal carries code cursor_above_head on both routes, and nothing else changes in its body", async () => {
  // Mutations that redden this: drop the code argument in refuseAboveHead; give it another code.
  const w = await world();
  try {
    for (const path of [`/api/guest/inbox?guest=${w.visitor}&cursor=g900-c0-p0`, "/api/inbox?handle=alice&cursor=c900-p0-g0"]) {
      const res = await call(w.env, "GET", path);
      assert.equal(res.status, 400, `${path}: ${JSON.stringify(res.body)}`);
      assert.deepEqual(Object.keys(res.body).sort(), ["code", "error"], `${path}: ${JSON.stringify(res.body)}`);
      assert.equal(res.body.code, "cursor_above_head");
      assert.match(res.body.error, /, above the newest one here \(\d+\)\. Pass next_cursor exactly as a previous response served it, or /);
    }
  } finally {
    w.d1.close();
  }
});

test("a stray parameter is refused before the cursor is compared, in either order, on both routes: what the note now says", async () => {
  // Mutation that reddens this: run the parameter check after the pages are read (the above-head refusal then wins).
  const w = await world();
  try {
    for (const path of [
      `/api/guest/inbox?guest=${w.visitor}&cursor=g900-c0-p0&limit=1`,
      `/api/guest/inbox?limit=1&guest=${w.visitor}&cursor=g900-c0-p0`,
      "/api/inbox?handle=alice&cursor=c900-p0-g0&limit=1",
      "/api/inbox?limit=1&handle=alice&cursor=c900-p0-g0",
    ]) {
      const res = await call(w.env, "GET", path);
      assert.deepEqual([res.status, res.body.code], [400, "unknown_query_parameter"], `${path}: ${JSON.stringify(res.body)}`);
      assert.doesNotMatch(res.body.error, /above the newest/);
    }
  } finally {
    w.d1.close();
  }
});

test("docs/HEARTBEAT-SKILL-TEXT.md carries the same sentence in the citizen cursor_note", () => {
  // Mutation that reddens this: change a word of the sentence in the document only.
  const doc = readFileSync(join(import.meta.dirname, "..", "docs", "HEARTBEAT-SKILL-TEXT.md"), "utf8").replace(/\r\n/g, "\n");
  assert.ok(doc.includes(SENTENCE));
});

test("both cursor notes carry the code and the first-failure sentence", async () => {
  // Mutations that redden this: remove the sentence from either note; change its wording on one route only.
  const w = await world();
  try {
    const g = await call(w.env, "GET", `/api/guest/inbox?guest=${w.visitor}`);
    const c = await call(w.env, "GET", "/api/inbox?handle=alice&since=0");
    for (const [name, res] of [["guest", g], ["citizen", c]] as const) {
      assert.equal(res.status, 200, `${name}: ${JSON.stringify(res.body)}`);
      assert.ok(String(res.body.cursor_note).includes(SENTENCE), `${name} cursor_note: ${res.body.cursor_note}`);
    }
  } finally {
    w.d1.close();
  }
});
