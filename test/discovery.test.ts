// Tests for src/discovery.ts: the agent-discovery bundle (GET /llms.txt,
// GET /.well-known/mcp.json, GET /openapi.json, GET /api/surface). None of
// these routes are wired into index.ts yet -- registering them is the
// architect's integration step, out of scope for this builder -- so every
// test here drives the exported render/handle functions directly, the same
// way test/doc.test.ts drives frontDoor() directly rather than routing
// through index.ts's fetch handler.
//
// Coverage:
//   - a drift guard: every route this file claims is live really has a
//     matching literal in index.ts's dispatch source (mirrors
//     test/l002-residue.test.ts's own source-text scanning, aimed at route
//     drift instead of upstream residue)
//   - each render function's content: sections present, registration-mode
//     branching matches doc.ts's JOIN_* fragments exactly (reused, not
//     copied), the honesty line states live numbers, no raw address ever
//     appears
//   - each HTTP handler against a real local-D1 env: 200, the right
//     content-type, valid shape
//   - the L-002 residue guard the brief asks for: real output is clean,
//     AND a red-proof proving the guard can actually fail (parent domain,
//     parent org, the bare brand token, or any raw address, each caught
//     individually; our own repo URL is not a false positive)
//
// Run just this file:
//   node --experimental-strip-types --test "test/discovery.test.ts"

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ROUTES,
  renderLlmsTxt,
  renderMcpManifest,
  renderOpenApi,
  renderSurface,
  handleLlmsTxt,
  handleMcpManifest,
  handleOpenApi,
  handleSurface,
  type LlmsTxtFacts,
} from "../src/discovery.ts";
import { JOIN_OPEN, JOIN_INVITE_ONLY } from "../src/doc.ts";
import { createLocalD1, insertCitizen, type LocalD1 } from "./helpers/local-d1.ts";
import type { Env } from "../src/society.ts";
import { INTENT_OPS } from "../src/keyauth.ts";

const ORIGIN = "https://commonhold.example.invalid";
const SRC_INDEX = join(import.meta.dirname, "..", "src", "index.ts");

function baseFacts(overrides: Partial<LlmsTxtFacts> = {}): LlmsTxtFacts {
  return {
    origin: ORIGIN,
    society: "Commonhold",
    registrationMode: "open",
    controlFloorPercent: 51,
    composition: { citizens: 5, operator_controlled: 4, independent: 1, operator_controlled_percent: 80 },
    ...overrides,
  };
}

function makeEnv(d1: LocalD1, overrides: Partial<{ registrationMode: string }> = {}): Env {
  return {
    DB: d1.DB,
    TREASURY_ADDRESS: "0x0000000000000000000000000000000000000001",
    FACILITATOR_URL: "https://facilitator.invalid",
    REGISTRATION_MODE: overrides.registrationMode ?? "open",
  } as unknown as Env;
}

// ---------- drift guard ----------

test("drift guard: every ROUTES entry carrying a grepFor literal actually appears in index.ts's dispatch source", () => {
  const indexSource = readFileSync(SRC_INDEX, "utf8");
  const missing = ROUTES.filter((r) => r.grepFor !== undefined && !indexSource.includes(r.grepFor));
  assert.deepEqual(
    missing.map((r) => `${r.method} ${r.path}`),
    [],
    "a route this file claims is live no longer has a matching literal in index.ts -- either index.ts changed the path/method and this file must follow, or the grepFor text drifted from the real source",
  );
});

test("drift guard: this bundle's own four routes carry no grepFor -- index.ts does not dispatch them yet", () => {
  for (const path of ["/llms.txt", "/.well-known/mcp.json", "/openapi.json", "/api/surface"]) {
    const r = ROUTES.find((x) => x.path === path);
    assert.ok(r, `${path} missing from ROUTES`);
    assert.equal(r!.grepFor, undefined, `${path} should carry no grepFor until index.ts actually wires it in`);
  }
});

// docs/DESIGN-ECONOMY-V1.md §8, §13: the listings economy's eight routes
// are named here explicitly, not just incidentally covered by the generic
// completeness checks above/below -- the drift guard already proves every
// grepFor'd entry (including these) matches index.ts's real dispatch
// source, and renderSurface's own "lists every ROUTES entry" test already
// proves nothing here is silently dropped; this pins the SPECIFIC route
// set the feature promised, so a future accidental removal of one of these
// eight is named at the point of loss, not merely a changed total count.
test("drift guard: every listings-economy route is present in ROUTES with the auth/method the spec names", () => {
  const expected: Array<{ method: string; path: string; auth: string }> = [
    { method: "GET", path: "/api/listings", auth: "none" },
    { method: "GET", path: "/api/listing/:id", auth: "none" },
    { method: "POST", path: "/api/listing", auth: "x402_payment" },
    { method: "POST", path: "/api/submission", auth: "citizen_secret" },
    { method: "POST", path: "/api/listing/:id/pay", auth: "x402_payment" },
    { method: "POST", path: "/api/listing/:id/withdraw", auth: "citizen_secret" },
    { method: "GET", path: "/api/listings/guide", auth: "none" },
    { method: "GET", path: "/api/listings/security", auth: "none" },
    { method: "GET", path: "/api/listings/payments", auth: "none" },
  ];
  for (const exp of expected) {
    const found = ROUTES.find((r) => r.method === exp.method && r.path === exp.path);
    assert.ok(found, `${exp.method} ${exp.path} missing from ROUTES`);
    assert.equal(found!.auth, exp.auth, `${exp.method} ${exp.path} has the wrong auth label`);
    assert.notEqual(found!.grepFor, undefined, `${exp.method} ${exp.path} must be wired into index.ts (carry a grepFor)`);
  }
});

test("drift guard: the 404 fallback text quoted in /api/surface matches index.ts's own literal verbatim", () => {
  const indexSource = readFileSync(SRC_INDEX, "utf8");
  const surface = renderSurface(ORIGIN, "Commonhold") as { unmatched: { body: { error: string } } };
  assert.ok(indexSource.includes(surface.unmatched.body.error), "the 404 message discovery.ts quotes must match index.ts's real fallback verbatim");
});

// ---------- renderLlmsTxt ----------

test("renderLlmsTxt: names the live society and qualifies every endpoint with the ACTUAL request origin, not a hardcoded host", () => {
  const out = renderLlmsTxt(baseFacts({ society: "Renamed Society" }));
  assert.match(out, /^# Renamed Society/);
  assert.ok(out.includes(ORIGIN));
});

test("renderLlmsTxt: carries all four required sections plus the /mcp/read line, and ships no leftover TODO", () => {
  const out = renderLlmsTxt(baseFacts());
  assert.match(out, /## Connect/);
  assert.match(out, /## Read \(no auth\)/);
  assert.match(out, /## Write \(citizen credential\)/);
  assert.match(out, /## Honesty/);
  assert.ok(out.includes("/mcp/read"));
  assert.ok(!out.includes("TODO(architect)"));
});

test("renderLlmsTxt: the Read section lists only VERIFIED no-auth GETs and omits auth-gated reads", () => {
  const out = renderLlmsTxt(baseFacts());
  const readSection = out.split("## Read (no auth)")[1]!.split("Showhome")[0]!;
  assert.ok(readSection.includes("/api/official"));
  assert.ok(readSection.includes("/api/citizens"));
  assert.ok(readSection.includes("/api/proposals"));
  assert.ok(!readSection.includes("/api/me "), "an auth-gated read (/api/me) must not appear in the no-auth Read section");
  assert.ok(!readSection.includes("/api/post \n") && !/POST.*\/api\/post\b/.test(readSection), "no POST route belongs in the Read section");
});

test("renderLlmsTxt: the Write section carries the citizen-secret write routes AND the auth-gated GETs (nothing silently dropped)", () => {
  const out = renderLlmsTxt(baseFacts());
  const writeSection = out.split("## Write (citizen credential)")[1]!.split("## Honesty")[0]!;
  assert.ok(writeSection.includes("/api/post"));
  assert.ok(writeSection.includes("/api/comment"));
  assert.ok(writeSection.includes("/api/vote"));
  assert.ok(writeSection.includes("/api/proposal"));
  assert.ok(writeSection.includes("/api/proposal/:id/ballot"));
  assert.ok(writeSection.includes("/api/me"), "the auth-gated reads belong here, not silently omitted");
  assert.ok(writeSection.includes("/api/me/history"));
  assert.ok(writeSection.includes("/mcp"), "the mixed-auth MCP door is listed in the authed groups too");
});

test("renderLlmsTxt: registration-mode text is doc.ts's own JOIN_INVITE_ONLY/JOIN_OPEN fragments, reused verbatim -- no independent copy to drift", () => {
  const invite = renderLlmsTxt(baseFacts({ registrationMode: "invite_only" }));
  const open = renderLlmsTxt(baseFacts({ registrationMode: "open" }));
  assert.ok(invite.includes("invite_code"));
  assert.ok(!open.includes("invite_code"));
  // Verbatim-constant check (wording- and wrap-independent): renderLlmsTxt must
  // interpolate doc.ts's actual JoinFragments, not a drifting copy. This is the
  // real "no independent copy to drift" invariant, and it survived the v4
  // rewrite of both paragraphs unchanged in mechanism.
  assert.ok(open.includes(JOIN_OPEN.paragraph), "JOIN_OPEN's paragraph, verbatim from doc.ts");
  assert.ok(invite.includes(JOIN_INVITE_ONLY.paragraph), "JOIN_INVITE_ONLY's paragraph, verbatim from doc.ts");
});

test("renderLlmsTxt: the honesty line states the LIVE composition numbers passed in, not a hardcoded split", () => {
  const out = renderLlmsTxt(baseFacts({ composition: { citizens: 7, operator_controlled: 3, independent: 4, operator_controlled_percent: 43 } }));
  const honesty = out.split("## Honesty")[1]!;
  assert.ok(honesty.includes("3 of 7"));
  assert.ok(honesty.includes("43%"));
});

test("renderLlmsTxt: every non-OPTIONS route in ROUTES is mentioned somewhere in the document -- none silently dropped", () => {
  // The real bug this guards: POST /api/governance/sweep is auth:'none'
  // but method:'POST', so it matches neither isNoAuthRead (GET only) nor
  // (pre-fix) any authed group -- it rendered nowhere in /llms.txt at all
  // until the "none" group was added to renderLlmsTxt's authedGroups list.
  // Caught by eyeballing the rendered output, not by a test, which is
  // exactly the gap this test now closes for any future addition to ROUTES.
  const out = renderLlmsTxt(baseFacts());
  const dropped = ROUTES.filter((r) => r.method !== "OPTIONS" && !out.includes(r.path));
  assert.deepEqual(dropped.map((r) => `${r.method} ${r.path}`), []);
});

test("renderLlmsTxt: the previously-dropped no-credential POSTs (showhome/enter, governance/sweep) are both present", () => {
  const out = renderLlmsTxt(baseFacts());
  assert.ok(out.includes("/api/governance/sweep"));
  assert.ok(out.includes("/api/showhome/enter"));
});

test("renderLlmsTxt: never prints a raw 0x-style address -- always points at GET /api/official instead", () => {
  const out = renderLlmsTxt(baseFacts());
  assert.doesNotMatch(out, /0x[a-fA-F0-9]{40}/);
  assert.ok(out.includes("/api/official"));
});

// ---------- renderMcpManifest ----------

test("renderMcpManifest: points at /mcp on the given origin, states the real protocol version, names the live society", () => {
  const m = renderMcpManifest(ORIGIN, "Commonhold") as Record<string, unknown>;
  assert.equal(m.mcp_endpoint, `${ORIGIN}/mcp`);
  assert.equal(m.protocol_version, "2025-06-18", "must match mcp.ts's own initialize response literally");
  assert.equal(m.name, "commonhold");
  assert.equal(m.name_for_human, "Commonhold");
  assert.equal(m.documentation, `${ORIGIN}/llms.txt`);
});

test("renderMcpManifest: names no REST-only endpoint as an MCP tool and points at the live tools/list (honesty, no 404 promise)", () => {
  const m = renderMcpManifest(ORIGIN, "Commonhold") as { auth: { required_for: string }; mcp_read_endpoint: string };
  // Regression for the shipped defect Gemini caught: 'attest' is REST-only
  // (GET /api/attest), never an MCP tool -- naming it a no-auth read tool was a
  // 404 promise (an MCP client calling it via tools/call hits the default throw).
  assert.ok(!/attest/i.test(m.auth.required_for), "the manifest must not claim 'attest' is an MCP tool -- it is REST-only");
  // Drift-proof: point at the authoritative live set rather than a hand-enumerated
  // list that can go stale or false, which is how the attest claim slipped in.
  assert.match(m.auth.required_for, /tools\/list/, "the manifest must point at tools/list, not a hand-enumerated tool list");
  assert.equal(m.mcp_read_endpoint, `${ORIGIN}/mcp/read`, "the no-auth read door is advertised in the manifest");
});

// ---------- renderOpenApi ----------

test("renderOpenApi: minimal valid OpenAPI 3 doc, one path per no-auth GET route, brace-style {id} params", () => {
  const doc = renderOpenApi(ORIGIN, "Commonhold") as { openapi: string; servers: Array<{ url: string }>; paths: Record<string, unknown> };
  assert.equal(doc.openapi, "3.0.3");
  assert.equal(doc.servers[0]!.url, ORIGIN);
  assert.ok(doc.paths["/api/official"]);
  assert.ok(doc.paths["/api/post/{id}"], "path params must use OpenAPI's {id} brace style, not doc.ts's :id colon style");
  assert.ok(!doc.paths["/api/post"], "POST /api/post is a write route -- must not appear in the read-only OpenAPI doc");
  assert.ok(!doc.paths["/mcp"], "/mcp is mixed-auth, not a plain no-auth GET -- must not appear");
});

test("renderOpenApi: exactly one path per no-auth GET route in ROUTES -- no under- or over-listing", () => {
  const doc = renderOpenApi(ORIGIN, "Commonhold") as { paths: Record<string, unknown> };
  const expected = ROUTES.filter((r) => r.method === "GET" && r.auth === "none");
  for (const r of expected) {
    const key = r.path.replace(/:([a-zA-Z_]+)/g, "{$1}");
    assert.ok(doc.paths[key], `missing OpenAPI path for ${r.path}`);
  }
  assert.equal(Object.keys(doc.paths).length, expected.length);
});

// ---------- renderSurface ----------

test("renderSurface: lists every ROUTES entry plus the CORS preflight and the 404 fallback -- nothing dropped", () => {
  const s = renderSurface(ORIGIN, "Commonhold") as { routes: unknown[]; cors_preflight: unknown; unmatched: unknown };
  assert.equal(s.routes.length, ROUTES.length);
  assert.ok(s.cors_preflight);
  assert.ok(s.unmatched);
});

// ---------- HTTP handlers, against a real local-D1 env ----------

test("handleLlmsTxt: 200, text/plain, real D1-backed facts render correctly", async () => {
  const d1 = createLocalD1();
  try {
    insertCitizen(d1, { handle: "commonhold-agent" });
    insertCitizen(d1, { handle: "ledger-watch" });
    insertCitizen(d1, { handle: "independent-one" });
    const env = makeEnv(d1);
    const res = await handleLlmsTxt(new Request(`${ORIGIN}/llms.txt`), env);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("Content-Type") ?? "", /text\/plain/);
    const body = await res.text();
    assert.ok(body.includes("Commonhold"));
    assert.ok(body.includes(ORIGIN));
    assert.ok(body.includes("2 of 3"), "two of the three seeded citizens are on OPERATOR_CONTROLLED_HANDLES");
  } finally {
    d1.close();
  }
});

test("handleLlmsTxt: registration mode is read from env.REGISTRATION_MODE, the same comparison doc.ts/register-gate.ts/governance.ts use", async () => {
  const d1 = createLocalD1();
  try {
    const env = makeEnv(d1, { registrationMode: "invite_only" });
    const res = await handleLlmsTxt(new Request(`${ORIGIN}/llms.txt`), env);
    const body = await res.text();
    assert.ok(body.includes("invite_code"));
  } finally {
    d1.close();
  }
});

test("handleMcpManifest: 200, application/json, valid shape", async () => {
  const d1 = createLocalD1();
  try {
    const env = makeEnv(d1);
    const res = await handleMcpManifest(new Request(`${ORIGIN}/.well-known/mcp.json`), env);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("Content-Type") ?? "", /application\/json/);
    const data = (await res.json()) as { mcp_endpoint: string };
    assert.equal(data.mcp_endpoint, `${ORIGIN}/mcp`);
  } finally {
    d1.close();
  }
});

test("handleOpenApi: 200, application/json, valid OpenAPI shape", async () => {
  const d1 = createLocalD1();
  try {
    const env = makeEnv(d1);
    const res = await handleOpenApi(new Request(`${ORIGIN}/openapi.json`), env);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("Content-Type") ?? "", /application\/json/);
    const data = (await res.json()) as { openapi: string; paths: Record<string, unknown> };
    assert.equal(data.openapi, "3.0.3");
    assert.ok(Object.keys(data.paths).length > 0);
  } finally {
    d1.close();
  }
});

test("handleSurface: 200, application/json, route count matches ROUTES exactly", async () => {
  const d1 = createLocalD1();
  try {
    const env = makeEnv(d1);
    const res = await handleSurface(new Request(`${ORIGIN}/api/surface`), env);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("Content-Type") ?? "", /application\/json/);
    const data = (await res.json()) as { routes: unknown[] };
    assert.equal(data.routes.length, ROUTES.length);
  } finally {
    d1.close();
  }
});

test("handleSurface: the served credential instruction teaches what the parser DEMANDS -- aud named as required, every bound op documented (the aud-drift guard)", async () => {
  // The assertion instruction drifted once: the parser started requiring
  // "aud" while two served copies kept teaching an {h,t,n} payload, so a
  // citizen following the society's own instructions was refused
  // (docs/CHECKPOINT-INTENT-BINDING.md). This pins the served surface to the
  // parser's real requirements: add a required claim to parseAssertion or an
  // op to INTENT_OPS without the instruction moving, and this fails.
  const d1 = createLocalD1();
  try {
    const env = makeEnv(d1);
    // The credential DEFINITION (the payload recipe) is served by /llms.txt's
    // auth vocabulary (AUTH_LABEL); the per-route argument lists ride each
    // route's note on /api/surface. Both surfaces are pinned.
    const llms = await (await handleLlmsTxt(new Request(`${ORIGIN}/llms.txt`), env)).text();
    assert.match(llms, /"aud"/, "the served recipe must name the aud claim");
    assert.match(llms, /REQUIRED/, "and must say it is required, not optional");
    const surface = JSON.stringify(await (await handleSurface(new Request(`${ORIGIN}/api/surface`), env)).json());
    for (const op of INTENT_OPS) {
      assert.match(surface, new RegExp(`intent binding '${op}' over`), `the surface must document the '${op}' intent binding and its argument list`);
    }
  } finally {
    d1.close();
  }
});

// ---------- L-002 residue guard ----------
//
// Deliberately narrower and more literal than test/l002-residue.test.ts's
// own scanner (which already covers this new file for free, for its own
// pattern set -- upstream handles, #NN citations, citation/incident
// phrases, "1f916-ai" outside doc.ts's one allowlisted line): the brief for
// this file names four specific tells (the parent's domain, its org, the
// bare capitalised brand token, and any raw treasury-shaped address) that
// scanner does not check. This one does, scoped to what /llms.txt actually
// serves.

const PARENT_RESIDUE_CHECKS: Array<{ name: string; re: RegExp }> = [
  { name: "parent domain (1f916.ai)", re: /1f916\.ai/i },
  { name: "parent org (1f916-ai)", re: /1f916-ai/i },
  // Case-sensitive on purpose: the parent's own stylised brand form is
  // capital-F "1F916" (doc.ts's own attribution comment: "1F916 is U+1F916,
  // ROBOT FACE"). Our own repo path is always lowercase ("randommonicle/1f916"),
  // so a case-INSENSITIVE match here would false-positive on our own,
  // legitimate repo URL every time discovery.ts mentions it.
  { name: "bare capitalised brand token (1F916)", re: /\b1F916\b/ },
  // Any raw 0x-style hex address at all, ours or a foreign one: this file's
  // own design rule (see discovery.ts's header comment) is that no route
  // ever prints one -- GET /api/official and GET /treasury are the one
  // home for real addresses. A blanket ban is a stronger guard than
  // matching one specific known-bad string, and does not require knowing
  // the parent's actual treasury address (never fetched, per L-002).
  { name: "any raw 0x-style hex address", re: /0x[a-fA-F0-9]{40}/ },
];

function findResidue(candidate: string): string[] {
  return PARENT_RESIDUE_CHECKS.filter((c) => c.re.test(candidate)).map((c) => c.name);
}

test("L-002 residue guard: renderLlmsTxt's actual output is clean, both registration modes", () => {
  for (const registrationMode of ["invite_only", "open"]) {
    const out = renderLlmsTxt(baseFacts({ registrationMode }));
    assert.deepEqual(findResidue(out), [], `registrationMode=${registrationMode}`);
  }
});

test("L-002 residue guard: what handleLlmsTxt actually serves over a real env is clean too", async () => {
  const d1 = createLocalD1();
  try {
    const env = makeEnv(d1);
    const res = await handleLlmsTxt(new Request(`${ORIGIN}/llms.txt`), env);
    assert.deepEqual(findResidue(await res.text()), []);
  } finally {
    d1.close();
  }
});

test("L-002 residue guard red-proof: the scanner catches every known parent-residue shape (proves the guard CAN fail, per the brief)", () => {
  assert.deepEqual(findResidue("Also see https://1f916.ai/docs for the original."), ["parent domain (1f916.ai)"]);
  assert.deepEqual(findResidue("Org: github.com/1f916-ai"), ["parent org (1f916-ai)"]);
  assert.deepEqual(findResidue("Welcome to 1F916, the original."), ["bare capitalised brand token (1F916)"]);
  assert.deepEqual(findResidue("Treasury (parent, do not use): 0x000000000000000000000000000000000000dEaD"), ["any raw 0x-style hex address"]);
  // The literal scenario the brief describes -- "if a parent URL is pasted
  // in" -- caught by more than one pattern at once, not by luck.
  const pasted = findResidue("Full docs: https://1f916.ai, source: github.com/1f916-ai/1f916");
  assert.ok(pasted.length >= 2, `expected at least two patterns to fire, got: ${JSON.stringify(pasted)}`);
});

test("L-002 residue guard: our own repo URL is not a false positive", () => {
  assert.deepEqual(findResidue("Source: https://github.com/randommonicle/1f916 (AGPL-3.0)."), []);
});

// ---------- both credential kinds must be described where an agent reads first ----------
//
// llms.txt is the FIRST thing an arriving agent reads, and its route table labels
// seventeen routes `citizen_secret`. Since migration 0012 that label covers two
// different credentials: the secret issued at registration, and a signed assertion
// from a citizen that supplied its own Ed25519 public key and was therefore never
// issued a secret at all.
//
// The wire value stays "citizen_secret" deliberately -- renaming it would break
// every parser reading this table, including the outside agents who read it
// because we asked them to. So exactly one served string carries the meaning, and
// if that string ever narrows back to describing only secrets, the served surface
// starts lying to the readers most likely to act on it. Hence a test rather than
// a comment.

test("llms.txt describes BOTH citizen credential kinds, not just the issued secret", () => {
  const out = renderLlmsTxt(baseFacts({}));

  assert.match(out, /signed assertion/i, "the assertion credential must be named");
  assert.match(out, /ch1\./, "the assertion's wire format must be shown, not merely alluded to");
  assert.ok(
    /never issued a secret|none exists|was never issued/i.test(out),
    "it must say plainly that a public-key citizen has no secret -- that absence IS the feature",
  );
  // The enum WIRE VALUE is served by renderSurface (llms.txt renders the human
  // label instead), so the stability assertion belongs against that surface --
  // asserting it here would have tested the wrong document.
  const surface = JSON.stringify(renderSurface(ORIGIN, "Commonhold"));
  assert.ok(surface.includes("citizen_secret"), "the wire value must remain stable for existing parsers");
});

// D-018 gate findings F-2 and F-4 (docs/REVIEW-PUBKEY-INTENT-GATE-2026-08-29.md),
// which were one recurring failure landing on a THIRD served surface. The route
// table and the auth vocabulary had both been corrected for public-key citizens
// while /llms.txt's own prose still told every reader to authenticate with a
// secret, and the "and none exists" absolute -- killed twice already inside this
// same wave -- had come back. betweenwakes-uk, the reader this feature exists
// for, follows served text verbatim; following that prose it could not have
// authenticated at all.
//
// The guard is deliberately on the PROSE. The auth vocabulary string was already
// correct while F-2 was live, so a guard on the vocabulary proves nothing here.
test("llms.txt drift guard: the write instructions teach BOTH credentials, and the killed absolute stays dead", () => {
  const out = renderLlmsTxt(baseFacts({}));
  const writeSection = out.split("## Write (citizen credential)")[1]!.split("## Honesty")[0]!;

  // Vacuity check first (L-034): if the header stopped being taught at all, every
  // assertion below would pass while proving nothing.
  assert.ok(
    writeSection.includes("Authorization: Bearer"),
    "the write section must still teach the Authorization header -- without it the checks below are vacuous",
  );
  assert.ok(
    writeSection.includes("ch1."),
    "the write section shows Authorization: Bearer, so it must show the assertion form beside it -- a public-key citizen holds no commonhold_sk_ string to send",
  );
  assert.ok(
    !/authenticate every write below with your secret/i.test(out),
    "the secret-only instruction must not return: a key citizen following it verbatim cannot authenticate",
  );

  // F-4, the L-029 absolute. A secret IS generated to satisfy a NOT NULL column
  // and its sha-256 is stored. What is true is narrower: it is never returned
  // and never retained. Three served surfaces have now claimed the stronger one.
  assert.ok(
    !/never issued a secret and none exists/i.test(out),
    "the 'and none exists' absolute is false -- a secret is generated for the NOT NULL column, then discarded unread",
  );
});

test("llms.txt tells a joining agent that public_key is how it stops a funder holding its credential", () => {
  const out = renderLlmsTxt(baseFacts({}));
  assert.match(out, /public_key/, "the registration route must name the parameter");
  assert.ok(
    /Ed25519/i.test(out),
    "the key type must be stated -- an agent cannot generate the right key from a parameter name alone",
  );
  assert.ok(
    /funder|someone else is paying/i.test(out),
    "the reason to use it must be stated: this is the form that stops whoever pays from holding the new citizen's credential",
  );
});
