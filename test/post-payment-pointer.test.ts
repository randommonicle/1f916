// Gate M1 (docs/REVIEW-X402-SETTLE-HONESTY-GATE-2026-09-29.md): four messages served AFTER a
// payment settled told the payer "GET /api/official names how to reach it". It does not:
// /api/official's maintainer block is { handle, citizen, is } and names no route. A payer
// being told where to go to be made whole must be sent somewhere that exists and that the
// payer can use. Non-citizen payers (registration, patron) get the showhome, which anyone may
// enter free; citizen payers (listing create, pay listing) get a mention of the maintainer,
// which GET /api/inbox lists. This pins each pointer in its source and pins that every route
// a pointer names is a real route in ROUTES, so a renamed route turns this red.
//
// Run: npm test
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ROUTES } from "../src/discovery.ts";

const SHOWHOME_POINTER =
  "To add your own report, leave a free showhome note naming this tx: POST /api/showhome/enter, then POST /api/showhome/note.";
const CITIZEN_POINTER =
  "To add your own report, mention @commonhold-agent in a comment naming this tx (POST /api/comment); it is listed at GET /api/inbox?handle=commonhold-agent.";

const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");

test("M1: no served source still points a payer at GET /api/official for help", () => {
  for (const f of ["x402.ts", "register-gate.ts", "listings.ts"]) {
    assert.ok(!src(f).includes("names how to reach it"), `${f} still carries the false /api/official pointer`);
  }
});

test("M1: each post-payment message carries the pointer its payer can use", () => {
  const count = (hay: string, needle: string) => hay.split(needle).length - 1;
  assert.equal(count(src("x402.ts"), SHOWHOME_POINTER), 1, "recordSettledPayment (registration and patron) names the showhome");
  assert.equal(count(src("register-gate.ts"), SHOWHOME_POINTER), 1, "registration's settled-but-incomplete tail names the showhome");
  assert.equal(count(src("listings.ts"), CITIZEN_POINTER), 2, "listing create and pay listing name the maintainer mention");
});

test("M1: every route a pointer names is a real route", () => {
  const has = (method: string, path: string) => ROUTES.some((r) => r.method === method && r.path === path);
  assert.ok(has("POST", "/api/showhome/enter"));
  assert.ok(has("POST", "/api/showhome/note"));
  assert.ok(has("POST", "/api/comment"));
  assert.ok(has("GET", "/api/inbox"));
});
