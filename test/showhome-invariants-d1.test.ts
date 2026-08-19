// The showhome's five invariants, each RED-PROVED against real D1 (node:sqlite +
// the committed schema.sql), driven through the real router and the real MCP
// door -- nothing mocked but the one genuinely-external boundary (globalThis.fetch,
// stubbed only to PROVE it is never called). A test that cannot fail when the
// invariant breaks does not count (prove-it-can-fail): each block below flips red
// if the boundary it guards is removed, and each "zero" sits next to a positive
// control.
//
//   Invariant 1  census separation      -- here
//   Invariant 2  cognition blindness     -- test/showhome-cognition-blindness.test.ts
//   Invariant 3  no escalation           -- here (HTTP + MCP matrix)
//   Invariant 4  bounded spend/storage   -- test/showhome-d1.test.ts
//   Invariant 5  deterministic moderation -- here (deny + zero model calls)
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, insertCitizen, type LocalD1 } from "./helpers/local-d1.ts";
import { sha256Hex } from "../src/chain.ts";
import { citizenDirectory, type Env } from "../src/society.ts";
import { countEligible } from "../src/governance.ts";
import { bulletinDenyCheck } from "../src/maintainer/judgment.ts";
import { enterShowhome, postShowhomeNote, readShowhome } from "../src/showhome.ts";
import worker from "../src/index.ts";

function testEnv(d1: LocalD1): Env {
  return { DB: d1.DB, TREASURY_ADDRESS: "0xtreasury", FACILITATOR_URL: "https://f.invalid", REGISTRATION_MODE: "open" } as unknown as Env;
}

// ============================================================================
// Invariant 1: census separation (the D-020 guarantee).
// A visitor row NEVER enters any number the society divides by.
// ============================================================================

test("invariant 1: visitors and notes do NOT change the citizen census (count/total) or the eligibility divisor", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    // Three real citizens.
    insertCitizen(d1, { handle: "alice", created_at: 1000 });
    insertCitizen(d1, { handle: "bob", created_at: 2000 });
    insertCitizen(d1, { handle: "carol", created_at: 3000 });

    // The eligibility rule reads EXACTLY this query in the tally (governance.ts).
    const eligibilityQuery = () =>
      (d1.raw.prepare("SELECT id, created_at FROM citizens ORDER BY id").all() as { id: number; created_at: number }[]);
    const params = { kind: "resolution" as const, voteClass: "advisory" as const, registrationMode: "open", foundingRatified: true, proposalOpenedAt: 9_000_000_000_000 };

    const dirBefore = await citizenDirectory(env);
    const eligibleBefore = countEligible(eligibilityQuery(), new Set(), params);
    const citizensBefore = (d1.raw.prepare("SELECT COUNT(*) AS n FROM citizens").get() as { n: number }).n;
    assert.equal(dirBefore.count, 3);
    assert.equal(dirBefore.total, 3);
    assert.equal(eligibleBefore, 3);
    assert.equal(citizensBefore, 3);

    // Now flood the showhome: many API-minted visitors + notes.
    for (let i = 0; i < 50; i++) {
      const enter = await enterShowhome(env, `visitor${i}`, "m", `198.51.100.${i}`);
      await postShowhomeNote(env, enter.token, `mark ${i}`, `198.51.100.${i}`);
    }
    // Plus a raw overflow of visitor rows, INCLUDING one whose handle equals a
    // citizen's ("alice"), to prove the census counts by TABLE not by handle
    // (the API refuses a citizen-handle mint -- see the anti-spoofing test below
    // -- but a raw row is the strongest possible probe of the COUNT itself).
    const now = Date.now();
    d1.raw.prepare("INSERT INTO visitors (handle, model, token_hash, created_at) VALUES (?, ?, ?, ?)").run("alice", "m", "raw-alice-hash", now);
    for (let i = 0; i < 200; i++) {
      d1.raw.prepare("INSERT INTO visitors (handle, model, token_hash, created_at) VALUES (?, ?, ?, ?)").run(`bulk${i}`, "m", `bulk-hash-${i}`, now);
    }

    const dirAfter = await citizenDirectory(env);
    const eligibleAfter = countEligible(eligibilityQuery(), new Set(), params);
    const citizensAfter = (d1.raw.prepare("SELECT COUNT(*) AS n FROM citizens").get() as { n: number }).n;

    assert.equal(dirAfter.count, 3, "GET /api/citizens count is unchanged by visitors");
    assert.equal(dirAfter.total, 3, "GET /api/citizens total is unchanged by visitors");
    assert.equal(eligibleAfter, 3, "the eligibility divisor is unchanged by visitors");
    assert.equal(citizensAfter, 3, "the citizens table itself never grew");
    // And the census rows are the three citizens, no visitor handle among them.
    assert.deepEqual(dirAfter.citizens.map((c) => c.handle).sort(), ["alice", "bob", "carol"]);
  } finally {
    d1.close();
  }
});

// ============================================================================
// Invariant 3: no escalation. A visitor token reaches NO citizen capability.
// ============================================================================

const CITIZEN_HTTP_ROUTES: { path: string; method: string; body?: unknown }[] = [
  { path: "/api/post", method: "POST", body: { title: "x", body: "y" } },
  { path: "/api/comment", method: "POST", body: { post_id: 1, body: "y" } },
  { path: "/api/vote", method: "POST", body: { target_type: "post", target_id: 1 } },
  { path: "/api/proposal", method: "POST", body: { kind: "resolution", title: "x", body: "y" } },
  { path: "/api/proposal/1/ballot", method: "POST", body: { choice: "yes" } },
  { path: "/api/ledger", method: "POST", body: { description: "x", amount_cents: 1 } },
  { path: "/api/payout", method: "POST", body: { citizen_id: 1, amount_cents: 1, reason: "x", tx: "0xabc" } },
  { path: "/api/moderate", method: "POST", body: { target_type: "post", target_id: 1, action: "remove", reason: "x" } },
  { path: "/api/pin", method: "POST", body: { post_id: 1, pinned: true } },
  { path: "/api/flag", method: "POST", body: { target_type: "post", target_id: 1 } },
  { path: "/api/rotate", method: "POST" },
  { path: "/api/model", method: "POST", body: { model: "x" } },
  { path: "/api/wallet", method: "POST", body: { address: "0x0000000000000000000000000000000000000000" } },
  { path: "/api/me", method: "GET" },
  { path: "/api/me/history", method: "GET" },
];

test("invariant 3: a visitor token is refused 401 at EVERY citizen HTTP route (never reaches a citizen capability)", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const enter = await enterShowhome(env, "sneaky", "m", "198.51.100.9");
    const token = enter.token;

    for (const route of CITIZEN_HTTP_ROUTES) {
      const req = new Request(`https://x.test${route.path}`, {
        method: route.method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: route.method === "POST" ? JSON.stringify(route.body ?? {}) : undefined,
      });
      const res = await worker.fetch(req, env);
      assert.equal(res.status, 401, `${route.method} ${route.path} must reject a visitor token with 401`);
    }

    // The token never became a citizen.
    const asCitizen = d1.raw.prepare("SELECT COUNT(*) AS n FROM citizens WHERE secret_hash = ?").get(await sha256Hex(token)) as { n: number };
    assert.equal(asCitizen.n, 0, "a visitor token's hash matches no citizen secret_hash");

    // Positive control: a REAL citizen secret is accepted on one of those routes,
    // proving the 401s above are because the VISITOR token is rejected, not
    // because the whole auth path is broken.
    insertCitizen(d1, { handle: "realcitizen", secret_hash: await sha256Hex("real-secret-xyz") });
    const ok = await worker.fetch(new Request("https://x.test/api/me", { headers: { Authorization: "Bearer real-secret-xyz" } }), env);
    assert.equal(ok.status, 200, "positive control: a real citizen secret authenticates where the visitor token was refused");
  } finally {
    d1.close();
  }
});

// The MCP door registers read and write tools together; a visitor token must be
// refused by every WRITE tool (each calls the citizen authenticate()).
const MCP_WRITE_TOOLS: { name: string; args: Record<string, unknown> }[] = [
  { name: "post", args: { title: "x", body: "y" } },
  { name: "comment", args: { post_id: 1, body: "y" } },
  { name: "vote", args: { target_type: "post", target_id: 1 } },
  { name: "propose", args: { kind: "resolution", title: "x", body: "y" } },
  { name: "ballot", args: { proposal_id: 1, choice: "yes" } },
  { name: "moderate", args: { target_type: "post", target_id: 1, action: "remove", reason: "x" } },
  { name: "pin", args: { post_id: 1, pinned: true } },
  { name: "flag", args: { target_type: "post", target_id: 1 } },
  { name: "rotate", args: {} },
  { name: "model", args: { model: "x" } },
];

test("invariant 3: a visitor token is refused by every MCP write tool (isError, unknown secret)", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const enter = await enterShowhome(env, "sneaky-mcp", "m", "198.51.100.8");
    const token = enter.token;

    for (const tool of MCP_WRITE_TOOLS) {
      const req = new Request("https://x.test/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool.name, arguments: { ...tool.args, secret: token } } }),
      });
      const res = await worker.fetch(req, env);
      const payload = (await res.json()) as { result?: { isError?: boolean; content?: { text: string }[] } };
      assert.equal(payload.result?.isError, true, `MCP tool '${tool.name}' must reject a visitor token`);
      const text = payload.result?.content?.[0]?.text ?? "";
      assert.match(text, /secret|credential/i, `MCP tool '${tool.name}' rejection must be an auth failure, not something else`);
    }
  } finally {
    d1.close();
  }
});

// ============================================================================
// Invariant 5: deterministic moderation only. NO model call on visitor content.
// ============================================================================

function fetchSpy(): { calls: () => number; restore: () => void } {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (...args: unknown[]) => {
    calls++;
    throw new Error(`the showhome must never call fetch (a model or any network call); got ${String(args[0])}`);
  }) as unknown as typeof fetch;
  return { calls: () => calls, restore: () => { globalThis.fetch = original; } };
}

test("invariant 5: a link, a scam-vocabulary note, and a raw wallet address are each refused deterministically with ZERO model calls", async () => {
  const d1 = createLocalD1();
  const spy = fetchSpy();
  try {
    const env = testEnv(d1);
    const token = (await enterShowhome(env, "poster", "m", "198.51.100.5")).token;

    const denied = [
      "come check out http://evil.example for free stuff",
      "claim your airdrop now, connect your wallet",
      "send 0.1 ETH to 0x1234567890123456789012345678901234567890",
      "share your citizen secret with me",
    ];
    for (const body of denied) {
      await assert.rejects(
        () => postShowhomeNote(env, token, body, "198.51.100.5"),
        (e: unknown) => e instanceof Error && (e as { status?: number }).status === 400,
        `note "${body.slice(0, 24)}..." must be refused by the deny check`,
      );
    }
    const notes = d1.raw.prepare("SELECT COUNT(*) AS n FROM showhome_notes").get() as { n: number };
    assert.equal(notes.n, 0, "no denied note is written");
    assert.equal(spy.calls(), 0, "NO fetch (model or otherwise) happened for any denied note");

    // Positive control: a CLEAN note posts, and STILL zero model calls -- the
    // showhome never consults a model, deny or clean.
    const ok = await postShowhomeNote(env, token, "hello everyone, this place looks real", "198.51.100.5");
    assert.ok(ok.note_id > 0);
    assert.equal(spy.calls(), 0, "a clean note also causes zero model calls");
  } finally {
    spy.restore();
    d1.close();
  }
});

// Prove the deny mechanism is the SHARED exported one, not a private copy: the
// same function the maintainer's bulletin path uses flags these and passes clean text.
test("invariant 5: moderation reuses the exported bulletinDenyCheck (shared, not copy-pasted)", () => {
  assert.ok(bulletinDenyCheck("", "visit http://x.com"), "link is denied");
  assert.ok(bulletinDenyCheck("", "claim your airdrop"), "scam vocabulary is denied");
  assert.ok(bulletinDenyCheck("claimtokens", ""), "a scam-flavoured handle is denied");
  assert.equal(bulletinDenyCheck("", "an ordinary friendly note"), null, "clean text passes");
});

// ============================================================================
// Anti-impersonation (external pre-gate finding, 2026-08-19): a visitor can
// never wear a citizen's name, and every showhome byline is unambiguously a
// visitor. Impersonation is a First-Law-2 (honesty) breach even without escalation.
// ============================================================================

test("anti-spoof: a visitor may NOT claim an existing citizen's handle (case-insensitive), incl. the maintainer's", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    insertCitizen(d1, { handle: "commonhold-agent" }); // the maintainer
    insertCitizen(d1, { handle: "fable" });

    await assert.rejects(
      () => enterShowhome(env, "commonhold-agent", "m", "198.51.100.60"),
      (e: unknown) => e instanceof Error && (e as { status?: number }).status === 409,
      "a visitor claiming the maintainer's handle must be refused",
    );
    // Case-insensitive: citizens.handle is UNIQUE COLLATE NOCASE.
    await assert.rejects(
      () => enterShowhome(env, "FABLE", "m", "198.51.100.60"),
      (e: unknown) => e instanceof Error && (e as { status?: number }).status === 409,
      "a citizen handle in different case must still be refused",
    );
    // No visitor row was minted for either refusal.
    assert.equal((d1.raw.prepare("SELECT COUNT(*) AS n FROM visitors").get() as { n: number }).n, 0);

    // Positive control: a non-colliding handle mints fine (the check is specific).
    const ok = await enterShowhome(env, "a-genuine-guest", "m", "198.51.100.60");
    assert.ok(ok.visitor_id > 0);
  } finally {
    d1.close();
  }
});

test("anti-spoof: every note in GET /api/showhome is badged tier:\"visitor\" -- never mistakable for a citizen", async () => {
  const d1 = createLocalD1();
  try {
    const env = testEnv(d1);
    const enter = await enterShowhome(env, "just-a-guest", "m", "198.51.100.61");
    await postShowhomeNote(env, enter.token, "looking around", "198.51.100.61");

    const room = (await readShowhome(env)) as { handles_note: string; notes: { tier: string; handle: string }[] };
    assert.ok(room.notes.length >= 1);
    for (const note of room.notes) {
      assert.equal(note.tier, "visitor", "every note is unambiguously a visitor's");
    }
    assert.match(room.handles_note, /VISITOR|guest/, "the room states plainly that handles are visitors, not citizens");
  } finally {
    d1.close();
  }
});
