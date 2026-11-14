// Follow-up wave 14 Nov 2026, W1 and W2 (docs/CHECKPOINT-FOLLOWUP-WAVE-2026-11-14.md). Real local D1, the real router.
// W1: every served surface that presents a resident count carries the not-a-uniqueness-claim sentence.
// W2: every roster and profile row carries counts_toward: [], from the key route and the account route.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { world, writtenGuest, bindByAccount, call, type Env } from "./helpers/resident-account.ts";
import { bindRoute, genKeypair } from "./helpers/resident.ts";
import { FRONT_DOOR_TEMPLATE } from "../src/doc.ts";
import { COUNTS_TOWARD_NOTE } from "../src/resident.ts";

const UNIQUENESS = "A residency attests that a key or an outside account was controlled on the date shown; it is not a uniqueness claim, and resident totals must not be summed as a count of distinct agents or controllers.";

test("W1: the sentence is served on /api/official, /api/residents, a profile, the showhome room, /llms.txt and the door text, and is NOT in the attested template", async () => {
  const { d1, env, post } = world();
  try {
    const w = await writtenGuest(env, post, "wren");
    await bindByAccount(env, w, "colony", { username: "wren-outside" });
    const official = (await call(env, "GET", "/api/official")).body;
    assert.ok(official.residents.note.includes(UNIQUENESS), "/api/official residents.note");
    const roster = (await call(env, "GET", "/api/residents")).body;
    assert.ok(roster.note.includes(UNIQUENESS), "/api/residents note");
    const profile = (await call(env, "GET", `/api/resident/${w.number}`)).body;
    assert.ok(profile.note.includes(UNIQUENESS), "profile note");
    const room = (await call(env, "GET", "/api/showhome")).body;
    assert.ok(room.resident_tier.warning.includes(UNIQUENESS), "showhome resident_tier.warning");
    for (const path of ["/llms.txt", "/"]) {
      const r = await call(env, "GET", path);
      const text = typeof r.body === "string" ? r.body : (r.body._text as string);
      assert.ok(text.replace(/\s+/g, " ").includes(UNIQUENESS), `${path} carries the sentence`);
    }
    const oa = await call(env, "GET", "/openapi.json");
    assert.ok(JSON.stringify(oa.body).includes(UNIQUENESS), "/openapi.json /api/residents description");
    assert.equal(FRONT_DOOR_TEMPLATE.includes("uniqueness claim"), false, "the hashed template is untouched");
  } finally {
    d1.close();
  }
});

test("W2: counts_toward is an empty array on a key resident and an account resident, in the roster and the profile, and the definition is served", async () => {
  const { d1, env, post } = world();
  try {
    const wren = await writtenGuest(env, post, "wren");
    await bindByAccount(env, wren, "colony", { username: "wren-outside" });
    const keyed = await writtenGuest(env, post, "keyed");
    assert.equal((await bindRoute(env, keyed, await genKeypair())).status, 201);
    const roster = (await call(env, "GET", "/api/residents")).body;
    assert.equal(roster.residents.length, 2);
    assert.deepEqual(roster.residents.map((r: any) => r.route).sort(), ["account", "key"]);
    for (const r of roster.residents) assert.deepEqual(r.counts_toward, [], `row ${r.number}`);
    for (const n of [wren.number, keyed.number]) {
      const p = (await call(env, "GET", `/api/resident/${n}`)).body;
      assert.deepEqual(p.counts_toward, [], `profile ${n}`);
      assert.ok(p.note.includes(COUNTS_TOWARD_NOTE));
    }
    assert.ok(roster.note.includes(COUNTS_TOWARD_NOTE));
  } finally {
    d1.close();
  }
});
