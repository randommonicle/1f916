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
import { createLocalD1, insertCitizen } from "./helpers/local-d1.ts";
import worker from "../src/index.ts";
import { enterShowhome, postShowhomeNote } from "../src/showhome.ts";
import { SocietyError, type Env } from "../src/society.ts";

const SHOWHOME_POINTER =
  "To add your own report, leave a free showhome note naming this tx: POST /api/showhome/enter (any label that is not a citizen handle), then POST /api/showhome/note.";
const CITIZEN_POINTER =
  "To add your own report, mention @commonhold-agent in a comment naming this tx (POST /api/comment); it is listed at GET /api/inbox?handle=commonhold-agent&since=0 (follow next_cursor while has_more is true).";

const src = (f: string) => readFileSync(new URL(`../src/${f}`, import.meta.url), "utf8");

test("M1: no served source still points a payer at GET /api/official for help", () => {
  for (const f of ["x402.ts", "register-gate.ts", "listings.ts"]) {
    assert.ok(!src(f).includes("names how to reach it"), `${f} still carries the false /api/official pointer`);
  }
});

test("M1: each post-payment message carries the pointer its payer can use", () => {
  const count = (hay: string, needle: string) => hay.split(needle).length - 1;
  // C1 (paid-path M3): the one literal moved to settlement-claims.ts (exported), because the contradiction answer served from claimAnswer needs it and that
  // module imports no route module. x402.ts's own messages (recordSettledPayment for registration and patron, the unrecorded-claim 500) interpolate it.
  assert.equal(count(src("settlement-claims.ts"), SHOWHOME_POINTER), 1, "the one literal lives in settlement-claims.ts");
  assert.equal(count(src("x402.ts"), SHOWHOME_POINTER), 0, "x402.ts carries no second copy");
  assert.ok(src("x402.ts").includes("${SHOWHOME_REPORT_POINTER}"), "recordSettledPayment (registration and patron) interpolates it, so it still names the showhome");
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

// Exchange round 1 (CODEX): the string checks above passed while the served inbox URL lacked
// since= and answered 400. These drive each pointer through the real code it names.

const ORIGIN = "https://commonhold.example.invalid";
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
const envOf = (d1: ReturnType<typeof createLocalD1>) =>
  ({ DB: d1.DB, TREASURY_ADDRESS: "0x0000000000000000000000000000000000000001", FACILITATOR_URL: "https://f.invalid", REGISTRATION_MODE: "open" }) as unknown as Env;
const TX = `0x${"ab".repeat(32)}`;

test("M1: the citizen pointer's exact inbox URL answers 200 and lists a mention naming the tx", async () => {
  const d1 = createLocalD1();
  try {
    const maintainer = insertCitizen(d1, { handle: "commonhold-agent" });
    const funder = insertCitizen(d1, { handle: "a-funder" });
    assert.equal(maintainer, 1, "the maintainer is citizen #1 in this fixture, as live");
    const post = Number(
      d1.raw
        .prepare("INSERT INTO posts (citizen_id, title, body, dupe_hash, pinned, author_model, created_at, kind) VALUES (?, 't', 'b', 'd1', 0, 'm', 1000, 'post')")
        .run(funder).lastInsertRowid,
    );
    const insertC = d1.raw.prepare("INSERT INTO comments (post_id, parent_id, citizen_id, body, depth, author_model, created_at) VALUES (?, NULL, ?, ?, 0, 'm', ?)");
    // Exchange round 2 (CODEX): more than one page of earlier mentions, so the report is NOT on page 1.
    for (let i = 0; i < 105; i++) insertC.run(post, funder, `@commonhold-agent earlier note ${i}`, 1500 + i);
    const comment = Number(
      d1.raw
        .prepare("INSERT INTO comments (post_id, parent_id, citizen_id, body, depth, author_model, created_at) VALUES (?, NULL, ?, ?, 0, 'm', 2000)")
        .run(post, funder, `@commonhold-agent my listing payment settled as tx ${TX} but was not recorded`).lastInsertRowid,
    );
    const url = /GET (\/api\/inbox\?\S+) \(follow next_cursor while has_more is true\)\.$/.exec(CITIZEN_POINTER)?.[1];
    assert.ok(url, "the pointer names a GET /api/inbox URL");
    const call = (u: string) => (worker.fetch as unknown as (r: Request, e: Env, c: unknown) => Promise<Response>)(new Request(`${ORIGIN}${u}`), envOf(d1), ctx);
    type Page = { mentions: { id: number }[]; has_more: boolean; next_cursor: string };
    const first = await call(url!);
    assert.equal(first.status, 200, `the served URL ${url} must answer 200`);
    let page = (await first.json()) as Page;
    assert.ok(!page.mentions.some((m) => m.id === comment), "page 1 is full of earlier mentions, so the report is not on it");
    assert.equal(page.has_more, true, "the served instruction to follow next_cursor is needed here");
    const seen = new Set(page.mentions.map((m) => m.id));
    for (let guard = 0; page.has_more && guard < 10; guard++) {
      const next = await call(`/api/inbox?handle=commonhold-agent&cursor=${encodeURIComponent(page.next_cursor)}`);
      assert.equal(next.status, 200);
      page = (await next.json()) as Page;
      for (const m of page.mentions) seen.add(m.id);
    }
    assert.ok(seen.has(comment), "following next_cursor from the served URL reaches the mention naming the tx");
  } finally {
    d1.close?.();
  }
});

test("M1: the showhome pointer works for a payer, including one whose citizen was created", async () => {
  const d1 = createLocalD1();
  try {
    insertCitizen(d1, { handle: "new-citizen" });
    const env = envOf(d1);
    await assert.rejects(() => enterShowhome(env, "new-citizen", "m", "198.51.100.40"), (e: unknown) => e instanceof SocietyError && e.status >= 400);
    const enter = await enterShowhome(env, "payer-report", "m", "198.51.100.40");
    const note = await postShowhomeNote(env, enter.token, `my registration settled as tx ${TX} but did not complete`, "198.51.100.40");
    assert.ok(note.note_id > 0, "a note naming a tx is accepted");
  } finally {
    d1.close?.();
  }
});
