// GET /privacy (21 Oct 2026): the privacy policy is served at its own route, assembled from the template plus ONE slots object, with no
// unfilled slot, listed in ROUTES with a grepFor that finds the router line, and linked from /skill.md and /llms.txt. Real local D1, the
// real router, nothing mocked. docs/CHECKPOINT-PRIVACY-PAGE.md records each mutant run and restored.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createLocalD1, guestEnv, call } from "./helpers/guest.ts";
import { PRIVACY_SLOTS, PRIVACY_TEMPLATE, renderPrivacy } from "../src/privacy.ts";
import { ROUTES } from "../src/discovery.ts";
import worker from "../src/index.ts";

const SRC = join(import.meta.dirname, "..", "src");

test("GET /privacy answers 200 text/markdown with exactly the template filled from the slots, and the route is not a counted door (mutant: the router line is dropped)", async () => {
  const d1 = createLocalD1();
  try {
    const env = guestEnv(d1);
    const raw = await worker.fetch(new Request("https://example.test/privacy"), env);
    assert.equal(raw.headers.get("content-type"), "text/markdown; charset=utf-8");
    const r = await call(env, "GET", "/privacy");
    assert.equal(r.status, 200);
    assert.equal(raw.status, 200);
    const expected = PRIVACY_TEMPLATE.replace(/\{\{([A-Z_]+)\}\}/g, (_m, k: string) => (PRIVACY_SLOTS as Record<string, string>)[k]!);
    assert.equal(r.body._text, expected);
    assert.ok((r.body._text as string).startsWith("# Commonhold privacy policy"));
    assert.ok((r.body._text as string).includes("Ben Graham"), "the controller slot is filled");
    const doors = (await call(env, "GET", "/api/doors")).body as any;
    assert.equal(JSON.stringify(doors).includes("privacy"), false, "not one of the recruitment doors");
  } finally {
    d1.close();
  }
});

test("no {{ survives in the served body, and renderPrivacy leaves a slot visible when its value is missing (mutant: a slot value removed from PRIVACY_SLOTS)", async () => {
  const d1 = createLocalD1();
  try {
    const body = (await call(guestEnv(d1), "GET", "/privacy")).body._text as string;
    assert.equal(body.includes("{{"), false);
    assert.equal(body.includes("}}"), false);
    for (const k of ["CONTROLLER", "CONTACT", "CLOUDFLARE_RETENTION", "LAWFUL_BASIS", "TRANSFERS", "RETENTION_REVIEW", "ERASURE_COMMITMENT"]) {
      assert.ok(typeof (PRIVACY_SLOTS as Record<string, string>)[k] === "string" && (PRIVACY_SLOTS as Record<string, string>)[k]!.length > 0, `slot ${k} is filled`);
      assert.ok(PRIVACY_TEMPLATE.includes(`{{${k}}}`), `the template uses ${k}`);
    }
    // the detector can fail: a missing slot leaves its marker in the output, which the assertion above would catch
    const { CONTROLLER: _drop, ...rest } = PRIVACY_SLOTS;
    assert.ok(renderPrivacy(rest as Record<string, string>).includes("{{CONTROLLER}}"));
  } finally {
    d1.close();
  }
});

test("ROUTES lists GET /privacy and its grepFor matches the router line in src/index.ts (mutant: the route entry is dropped, or the router line is reworded)", () => {
  const row = ROUTES.find((r) => r.method === "GET" && r.path === "/privacy");
  assert.ok(row, "ROUTES has GET /privacy");
  assert.equal(row!.auth, "none");
  assert.ok(row!.grepFor, "it names a grepFor");
  assert.ok(readFileSync(join(SRC, "index.ts"), "utf8").includes(row!.grepFor!), "src/index.ts contains the grepFor");
});

test("/skill.md and /llms.txt each carry the /privacy line, and /openapi.json and /api/surface list the route (mutant: either link line deleted)", async () => {
  const d1 = createLocalD1();
  try {
    const env = guestEnv(d1);
    const skill = (await call(env, "GET", "/skill.md")).body._text as string;
    const llms = (await call(env, "GET", "/llms.txt")).body._text as string;
    assert.match(skill, /- GET https:\/\/example\.test\/privacy : the privacy policy/);
    assert.match(llms, /^Privacy policy:  GET https:\/\/example\.test\/privacy$/m);
    const surface = JSON.stringify((await call(env, "GET", "/api/surface")).body);
    assert.ok(surface.includes('"/privacy"'), "/api/surface lists it");
  } finally {
    d1.close();
  }
});

test("the policy carries no upstream self-description (L-002): none of the parent's names or incident numbering", () => {
  assert.equal(/1f512|1f3d9|athena|\bincident\s+\d+/i.test(PRIVACY_TEMPLATE), false);
});

test("/openapi.json describes GET /privacy as text/markdown, and no other path's media type moved (mutant: the ROUTES contentType removed)", async () => {
  const d1 = createLocalD1();
  try {
    const spec = (await call(guestEnv(d1), "GET", "/openapi.json")).body as any;
    assert.deepEqual(Object.keys(spec.paths["/privacy"].get.responses["200"].content), ["text/markdown"]);
    assert.deepEqual(Object.keys(spec.paths["/skill.md"].get.responses["200"].content), ["text/markdown"]);
    assert.deepEqual(Object.keys(spec.paths["/llms.txt"].get.responses["200"].content), ["text/plain"]);
    assert.deepEqual(Object.keys(spec.paths["/api/official"].get.responses["200"].content), ["application/json"]);
  } finally {
    d1.close();
  }
});
