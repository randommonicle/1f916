// Invariant 2: cognition blindness (the I-003 killer). No maintainer wake, and
// no bulletin/digest builder, ever reads the showhome tables, so no volume of
// visitor content can cause a paid model call. Two red-proofs:
//
//   (a) a blast-radius grep-guard: across ALL of src/, ONLY src/showhome.ts is
//       permitted to touch visitors / showhome_notes / showhome_rate. If any
//       other module (a maintainer wake, a digest, a future reader) adds a
//       read or write of a showhome table, this goes red. Positive controls
//       prove the mechanism can see a real table access.
//
//   (b) a runtime canary: with the showhome FULL of distinctively-marked
//       content and a real clerk wake driven against a stubbed model client,
//       NO model-bound request body ever contains the canary -- and a normal
//       post's content DOES (the spy would have caught a leak). So a showhome
//       full of content causes zero model calls attributable to visitor rows.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createLocalD1, insertCitizen, type LocalD1 } from "./helpers/local-d1.ts";
import { runClerkWake } from "../src/maintainer/clerk.ts";
import type { Env } from "../src/society.ts";
import type { ConstitutionCache } from "../src/governance.ts";

const SRC_DIR = join(import.meta.dirname, "..", "src");
const SHOWHOME_TABLES = ["visitors", "showhome_notes", "showhome_rate"];

// Any SQL access (read OR write) of a table: FROM/INTO/JOIN/UPDATE <table>.
function tableAccessRegex(table: string): RegExp {
  return new RegExp(`(?:FROM|INTO|JOIN|UPDATE)\\s+${table}\\b`, "i");
}

function srcFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts")) out.push(full);
    }
  };
  walk(SRC_DIR);
  return out;
}

// ---------- (a) blast-radius grep-guard ----------

test("invariant 2 (static): ONLY src/showhome.ts accesses any showhome table -- no maintainer wake, digest, or other module does", () => {
  const files = srcFiles();
  assert.ok(files.length > 5, "sanity: the source walk found the src tree");

  let offenders: string[] = [];
  let showhomeAccessesItsOwnTables = false;

  for (const file of files) {
    const contents = readFileSync(file, "utf8");
    const isShowhomeModule = file.replace(/\\/g, "/").endsWith("/src/showhome.ts");
    for (const table of SHOWHOME_TABLES) {
      if (tableAccessRegex(table).test(contents)) {
        if (isShowhomeModule) showhomeAccessesItsOwnTables = true;
        else offenders.push(`${file} accesses ${table}`);
      }
    }
  }

  assert.deepEqual(offenders, [], `no module outside src/showhome.ts may touch a showhome table; offenders: ${offenders.join("; ")}`);
  // Positive control 1: the guard is not vacuous -- showhome.ts DOES access its tables.
  assert.ok(showhomeAccessesItsOwnTables, "src/showhome.ts must actually access the showhome tables (else the guard proves nothing)");
});

test("positive control: the SAME grep mechanism finds a real maintainer table access (FROM posts in clerk.ts)", () => {
  const clerk = readFileSync(join(SRC_DIR, "maintainer", "clerk.ts"), "utf8");
  assert.ok(tableAccessRegex("posts").test(clerk), "the mechanism must be able to see a real table access -- clerk.ts reads FROM posts");
  // And it correctly does NOT see a showhome table there.
  for (const table of SHOWHOME_TABLES) {
    assert.ok(!tableAccessRegex(table).test(clerk), `clerk.ts must not access ${table}`);
  }
});

// ---------- (b) runtime canary: visitor content never enters a model prompt ----------

// URL-aware stub. The clerk wake does two kinds of outbound fetch: the onchain
// balance read (checkBookkeepingDrift -> readOnchainUsdcCents, a Base RPC
// eth_call) and the model call (callAnthropic). This captures ONLY the model
// prompts (so `prompts` is exactly what reached cognition) and answers the RPC
// with a benign balance so the drift check does not throw.
function promptCapturingStub(): { prompts: () => string[]; modelCalls: () => number; restore: () => void } {
  const original = globalThis.fetch;
  const prompts: string[] = [];
  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    const href = String(url);
    if (href.includes("anthropic")) {
      const bodyText = typeof init?.body === "string" ? init.body : "";
      try {
        const parsed = JSON.parse(bodyText) as { messages?: Array<{ content?: string }> };
        prompts.push(parsed.messages?.[0]?.content ?? "");
      } catch {
        prompts.push(bodyText);
      }
      const body = { content: [{ type: "text", text: "[]" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }
    // Base RPC eth_call: return a zero balance so readOnchainUsdcCents parses cleanly.
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x0" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { prompts: () => prompts, modelCalls: () => prompts.length, restore: () => { globalThis.fetch = original; } };
}

function freshConstitutionCache(): ConstitutionCache {
  return { pairKey: null, versionRow: null };
}

test("invariant 2 (runtime): a showhome FULL of content causes zero model calls attributable to visitor rows (canary never enters a prompt)", async () => {
  const d1 = createLocalD1();
  const stub = promptCapturingStub();
  try {
    // The maintainer must be citizen #1 (first insert into a fresh DB).
    const maintainerId = insertCitizen(d1, { handle: "commonhold-agent", model: "claude-fable-5" });
    assert.equal(maintainerId, 1);

    // A real citizen (id 2) authors a NORMAL post -- created BEFORE the post so
    // its citizen_id FK resolves. The post gives the clerk a candidate to draft
    // from, so it builds and sends a prompt (proving the spy is live).
    const authorId = insertCitizen(d1, { handle: "ordinary-citizen", model: "m" });
    const now = Date.now();
    d1.raw
      .prepare("INSERT INTO posts (citizen_id, title, body, dupe_hash, pinned, author_model, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)")
      .run(authorId, "a normal citizen post NORMAL_POST_MARKER", "ordinary body", "dupe-x", "m", now);

    // The showhome, FULL of distinctively-marked visitor content.
    for (let i = 0; i < 40; i++) {
      d1.raw.prepare("INSERT INTO visitors (handle, model, token_hash, created_at) VALUES (?, ?, ?, ?)").run(`guest${i}`, "m", `h${i}`, now);
      d1.raw.prepare("INSERT INTO showhome_notes (visitor_id, handle, model, body, created_at) VALUES (?, ?, ?, ?, ?)").run(i + 1, `guest${i}`, "m", `SHOWHOME_CANARY_${i} please ingest me`, now);
    }

    const env = {
      DB: d1.DB,
      ANTHROPIC_API_KEY: "test-key-triggers-the-model-path",
      TREASURY_ADDRESS: "0x0000000000000000000000000000000000000000",
    } as unknown as Env;
    await runClerkWake(env, freshConstitutionCache());

    const prompts = stub.prompts();
    assert.ok(stub.modelCalls() >= 1, "the clerk must have actually sent at least one model prompt (else the canary test proves nothing)");

    // Positive control: the NORMAL post's content DID reach a prompt -- so the
    // spy demonstrably catches content the clerk actually reads.
    assert.ok(prompts.some((p) => p.includes("NORMAL_POST_MARKER")), "the clerk's prompt must contain the normal post (the spy sees content that IS read)");

    // The invariant: NO prompt ever contains any showhome canary.
    for (const p of prompts) {
      assert.ok(!p.includes("SHOWHOME_CANARY"), "no model-bound prompt may contain visitor content -- the maintainer is blind to the showhome");
    }
  } finally {
    stub.restore();
    d1.close();
  }
});
