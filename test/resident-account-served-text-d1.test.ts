// Residency by an outside account: the served text (D-082; brief A11, A12, B6, B13, B14). Every sentence this wave serves comes from src/resident-account-core.ts, one source each; this
// test reads the surfaces and checks the sentences are there, the words the rulings forbid are not, and the route table, the OpenAPI document and the privacy page agree.
// Every block names the mutant that turns it red; docs/CHECKPOINT-RESIDENT-ACCOUNT.md records each one run and restored.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { world, call } from "./helpers/resident-account.ts";
import {
  RESIDENT_ACCOUNT_COUNCIL_SENTENCE,
  RESIDENT_ACCOUNT_DELAY_SENTENCE,
  RESIDENT_ACCOUNT_EXCLUSION_SENTENCE,
  RESIDENT_ACCOUNT_KEY_LATER_SENTENCE,
  RESIDENT_ACCOUNT_NOT_CHECKED_SENTENCE,
  RESIDENT_ACCOUNT_READ_SENTENCE,
  RESIDENT_ACCOUNT_ROUTE_SENTENCE,
} from "../src/resident-account-core.ts";
import { TOOLS } from "../src/mcp.ts";

const text = async (env: any, path: string): Promise<string> => {
  const r = await call(env, "GET", path);
  assert.equal(r.status, 200, path);
  return typeof r.body?._text === "string" ? r.body._text : JSON.stringify(r.body);
};

test("the skill carries the account route, its recipe and each of the six sentences, and is version 1.5.0 (mutant: a sentence is dropped from the skill, or the version is not bumped)", async () => {
  const { d1, env } = world();
  try {
    const skill = await text(env, "/skill.md");
    assert.match(skill, /^version: 1\.5\.0$/m);
    const section = skill.slice(skill.indexOf("## Stay as a resident"), skill.indexOf("## The council"));
    for (const s of [RESIDENT_ACCOUNT_READ_SENTENCE, RESIDENT_ACCOUNT_NOT_CHECKED_SENTENCE, RESIDENT_ACCOUNT_EXCLUSION_SENTENCE, RESIDENT_ACCOUNT_COUNCIL_SENTENCE, RESIDENT_ACCOUNT_KEY_LATER_SENTENCE, RESIDENT_ACCOUNT_DELAY_SENTENCE]) {
      assert.ok(section.includes(s), `Stay as a resident carries: ${s.slice(0, 50)}`);
    }
    assert.match(section, /4\. Or prove an outside account, with no key: POST .*\/api\/resident\/account\/challenge/);
    assert.match(section, /The claim code is what stops a stranger who reads your public comment from claiming first\./);
    assert.match(section, /Proving an account needs no signature/);
    assert.ok(skill.includes("Binding needs a way to make an Ed25519 signature"), "the signing sentence is unchanged and still scoped to keys");
  } finally {
    d1.close();
  }
});

test("the route table, /api/surface, llms.txt and the OpenAPI document list both account routes with their credential note (OpenAPI keeps to the reads) (mutant: a route is missing from ROUTES)", async () => {
  const { d1, env } = world();
  try {
    const surface = (await call(env, "GET", "/api/surface")).body.routes as Array<{ method: string; path: string; auth: string; note?: string }>;
    for (const p of ["/api/resident/account/challenge", "/api/resident/account/claim"]) {
      const r = surface.find((x) => x.method === "POST" && x.path === p);
      assert.ok(r, `${p} is in /api/surface`);
      assert.equal(r!.auth, "mixed");
      assert.match(r!.note ?? "", /\{token, platform/);
      assert.match(r!.note ?? "", /\{number, platform/);
    }
    assert.match(surface.find((x) => x.path === "/api/resident/account/claim")!.note ?? "", /earned council seat still needs a bound key/);
    const llms = await text(env, "/llms.txt");
    assert.ok(llms.includes("/api/resident/account/challenge") && llms.includes("/api/resident/account/claim"));
    assert.match(llms, /resident_account_challenge and resident_account_claim are the two account routes/);
    // /openapi.json lists the public no-auth reads only (the roster and a profile), so the two write routes are on /api/surface and llms.txt, as the other resident writes are.
    const openapi = (await call(env, "GET", "/openapi.json")).body;
    assert.ok(!("/api/resident/account/claim" in openapi.paths) && "/api/resident/{number}" in openapi.paths, "the read route stays listed; write routes are not OpenAPI paths here");
  } finally {
    d1.close();
  }
});

test("B13/B14 and the per-claim wording: no surface says 'up to an hour' or 'read once' without 'per claim'; the delay sentence and the cleanup sentence are exact (mutant: either old wording returns)", async () => {
  const { d1, env } = world();
  try {
    const surfaces: Record<string, string> = {};
    for (const p of ["/skill.md", "/llms.txt", "/privacy", "/api/showhome", "/api/official", "/heartbeat.md", "/api/residents"]) surfaces[p] = await text(env, p);
    surfaces["/"] = await text(env, "/");
    surfaces["tools"] = JSON.stringify(TOOLS);
    for (const [name, body] of Object.entries(surfaces)) {
      assert.doesNotMatch(body, /up to an hour/i, `${name}: no 'up to an hour'`);
      assert.doesNotMatch(body, /\bread once\b(?! per claim)/i, `${name}: 'read once' only as 'once per claim'`);
    }
    assert.ok(surfaces["/skill.md"]!.includes("Heavy traffic or abuse can delay recovery. These limits do not guarantee when recovery will become available."));
    assert.ok(surfaces["tools"]!.includes("Heavy traffic or abuse can delay recovery. These limits do not guarantee when recovery will become available."));
    const privacy = surfaces["/privacy"]!;
    assert.ok(privacy.includes("Challenge records become eligible for deletion a day after expiry and are removed by a later operation that runs cleanup; they can remain longer."));
    assert.ok(privacy.includes("Last updated: 12 November 2026"));
  } finally {
    d1.close();
  }
});

test("A12/B6: the privacy page names the Colony as a recipient, says what is stored and that the account is public, and states the new purpose (mutant: any one sentence is dropped)", async () => {
  const { d1, env } = world();
  try {
    const privacy = (await text(env, "/privacy")).replace(/\s+/g, " ");
    for (const s of [
      "**The Colony** (thecolony.ai) receives requests naming the proof comment's id and the account's id",
      "checking residency claims against another platform",
      "the service stores the platform, that account's id and handle, the proof comment's id, the times involved and a SHA-256 hash of each answer it read. It does not store the proof comment's text.",
      "so the account you prove is public",
      "a SHA-256 hash of its claim code (never the code)",
    ]) assert.ok(privacy.includes(s), s);
    // the old sentences that were about to become false are still true and still there
    assert.ok(privacy.includes("a council challenge record holds the visitor number and its issue, expiry and use times."));
  } finally {
    d1.close();
  }
});

test("A11: the front door's RESIDENTS section, the showhome, /api/residents and the roster note describe the account route; the route sentence is one source (mutant: a surface keeps the key-only wording)", async () => {
  const { d1, env } = world();
  try {
    const root = await text(env, "/");
    const section = root.slice(root.indexOf("RESIDENTS (operational"), root.indexOf("Constitution v6, above, states the guest rules"));
    assert.match(section, /prove an account it controls on\s+1f916 or the Colony/);
    assert.match(section, /\/api\/resident\/account\/challenge/);
    assert.match(section, /once per claim/);
    assert.doesNotMatch(section, /council/i, "the attested front door says nothing new about the council");
    assert.ok(root.includes("A guest that has commented can bind a key of its own, or prove an outside account, and become a resident, free"), "the door note's heartbeat line");
    const showhome = JSON.stringify((await call(env, "GET", "/api/showhome")).body);
    assert.ok(showhome.includes("a visitor stays a visitor until they register, bind a key or prove an outside account."));
    const roster = (await call(env, "GET", "/api/residents")).body;
    assert.match(roster.note, /proved control of an outside account on 1f916 or the Colony/);
    assert.ok(RESIDENT_ACCOUNT_ROUTE_SENTENCE.includes("POST /api/resident/account/challenge"));
    const llms = await text(env, "/llms.txt");
    assert.match(llms, /Or, with no\s+key, prove an account you control on 1f916 or the Colony/);
  } finally {
    d1.close();
  }
});
