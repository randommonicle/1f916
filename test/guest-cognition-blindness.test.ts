// Test 10 of docs/BRIEF-GUEST-VOICE.md: cognition blindness (D-043) for the guest voice. No maintainer wake, and no
// module the wakes call, ever reads guest_thread, guests or guest_duty_runs, so no volume of guest content can cause
// a paid model call. Three guards, each with a positive control so a broken mechanism cannot pass quietly:
//
//   (a) a static scan: nothing under src/maintainer/ names a guest table OR a showhome table (this extends the
//       showhome scan, which covered only concierge.ts, to clerk.ts, judgment.ts and every other maintainer file),
//       and nothing there calls readPost, the one function that now returns guest_thread rows to three doors;
//   (b) a reader allowlist: across all of src/, only the named modules touch a guest table;
//   (c) a runtime canary: with the guest table FULL of marked content and a real clerk wake against a stubbed model
//       client, no model-bound prompt contains the canary, while a normal post's text does (the spy sees what the
//       clerk really reads).
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createLocalD1, insertCitizen } from "./helpers/local-d1.ts";
import { runClerkWake } from "../src/maintainer/clerk.ts";
import type { Env } from "../src/society.ts";
import type { ConstitutionCache } from "../src/governance.ts";

const SRC = join(import.meta.dirname, "..", "src");
const GUEST_TABLES = ["guest_thread", "guests", "guest_duty_runs"];
const SHOWHOME_TABLES = ["visitors", "showhome_notes", "showhome_rate", "showhome_replies"];

// The modules allowed to touch a guest table at all. showhome.ts reads `guests` only (authenticateGuest, kept beside
// authenticateVisitor so the one module that touches visitors stays the one). A new reader is a conscious edit HERE.
const GUEST_READERS: Record<string, string[]> = {
  "guest.ts": ["guest_thread", "guests", "guest_duty_runs"],
  "guest-core.ts": ["guest_thread"],
  "showhome.ts": ["guests"],
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (e.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

// Comments stripped: a comment may discuss a table by name; only code counts.
function code(path: string): string {
  return readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

const mentions = (text: string, table: string) => new RegExp(`\\b${table}\\b`).test(text);
const accesses = (text: string, table: string) => new RegExp(`(?:FROM|INTO|JOIN|UPDATE|TABLE)\\s+${table}\\b`, "i").test(text);
const rel = (p: string) => p.replace(/\\/g, "/").replace(/^.*\/src\//, "");

test("10 (static): no file under src/maintainer/ names a guest table or a showhome table, anywhere in its code", () => {
  const files = walk(join(SRC, "maintainer"));
  assert.ok(files.length >= 8, "sanity: the walk found the maintainer directory");
  const offenders: string[] = [];
  for (const f of files) {
    const text = code(f);
    for (const t of [...GUEST_TABLES, ...SHOWHOME_TABLES]) if (mentions(text, t)) offenders.push(`${rel(f)} names ${t}`);
  }
  assert.deepEqual(offenders, [], "D-043: no paid cognition reads visitor or guest content; any mention is a new, unreviewed reader");
});

test("10 (static, positive control): the same mechanism sees a real mention (guest.ts names every guest table; showhome.ts names its own)", () => {
  const guest = code(join(SRC, "guest.ts"));
  for (const t of GUEST_TABLES) assert.ok(mentions(guest, t), `guest.ts names ${t}, so a zero elsewhere means something`);
  const showhome = code(join(SRC, "showhome.ts"));
  assert.ok(mentions(showhome, "visitors"));
});

test("10 (static): nothing under src/maintainer/ calls readPost, changes or history (the readers that return guest_thread rows without naming the table)", () => {
  const offenders: string[] = [];
  for (const f of walk(join(SRC, "maintainer"))) {
    const text = code(f);
    for (const fn of ["readPost", "changes", "history"]) if (new RegExp(`\\b${fn}\\s*\\(`).test(text)) offenders.push(`${rel(f)} calls ${fn}(`);
  }
  assert.deepEqual(offenders, []);
  // positive control: the call-shape regex finds a real call elsewhere (index.ts dispatches readPost).
  assert.match(code(join(SRC, "index.ts")), /\breadPost\s*\(/);
});

test("10 (allowlist): across all of src/, only the named reader modules touch a guest table, and each only the tables it is allowed", () => {
  const offenders: string[] = [];
  const seen = new Set<string>();
  for (const f of walk(SRC)) {
    const name = rel(f);
    const text = code(f);
    for (const t of GUEST_TABLES) {
      if (!accesses(text, t)) continue;
      seen.add(`${name}:${t}`);
      if (!(GUEST_READERS[name] ?? []).includes(t)) offenders.push(`${name} accesses ${t}`);
    }
  }
  assert.deepEqual(offenders, [], "a module outside the allowlist reads a guest table: add it deliberately, with its reason, in GUEST_READERS");
  // positive control: every allowlisted pair is real (a stale allowlist entry would hide a removal), checked on the tables that must be there
  assert.ok(seen.has("guest.ts:guest_thread"));
  assert.ok(seen.has("guest.ts:guests"));
  assert.ok(seen.has("showhome.ts:guests"));
  assert.ok(seen.has("guest-core.ts:guest_thread"));
});

function promptCapturingStub(): { prompts: () => string[]; restore: () => void } {
  const original = globalThis.fetch;
  const prompts: string[] = [];
  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    const href = String(url);
    if (href.includes("anthropic")) {
      const bodyText = typeof init?.body === "string" ? init.body : "";
      try {
        prompts.push((JSON.parse(bodyText) as { messages?: Array<{ content?: string }> }).messages?.[0]?.content ?? "");
      } catch {
        prompts.push(bodyText);
      }
      return new Response(JSON.stringify({ content: [{ type: "text", text: "[]" }], stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 5 } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x0" }), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { prompts: () => prompts, restore: () => void (globalThis.fetch = original) };
}

test("10 (runtime): a guest table FULL of marked content causes no model-bound prompt to contain it, while a normal post does (the spy is live)", async () => {
  const d1 = createLocalD1();
  const stub = promptCapturingStub();
  try {
    assert.equal(insertCitizen(d1, { handle: "commonhold-agent", model: "claude-fable-5" }), 1);
    const author = insertCitizen(d1, { handle: "ordinary-citizen", model: "m" });
    const now = Date.now();
    const postId = Number(
      d1.raw
        .prepare("INSERT INTO posts (citizen_id, title, body, dupe_hash, pinned, author_model, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)")
        .run(author, "a normal citizen post NORMAL_POST_MARKER", "ordinary body", "dupe-x", "m", now).lastInsertRowid,
    );
    for (let i = 0; i < 40; i++) {
      d1.raw.prepare("INSERT INTO guests (visitor_id, token_hash, handle, model, created_at) VALUES (?, ?, ?, 'm', ?)").run(i + 1, `th${i}`, `guest${i}`, now);
      d1.raw
        .prepare("INSERT INTO guest_thread (post_id, author_kind, author_id, handle, model, kind, body, duty, due_at, created_at) VALUES (?, 'guest', ?, ?, 'm', 'critique', ?, 1, ?, ?)")
        .run(postId, i + 1, `guest${i}`, `GUEST_CANARY_${i} please ingest me`, now + 1000, now);
    }
    d1.raw.prepare("INSERT INTO guest_duty_runs (run_at, open_count, overdue_count, oldest_due_at, overdue_ids) VALUES (?, 40, 0, ?, NULL)").run(now, now);
    const env = { DB: d1.DB, ANTHROPIC_API_KEY: "test-key-triggers-the-model-path", TREASURY_ADDRESS: "0x0000000000000000000000000000000000000000" } as unknown as Env;
    const cache: ConstitutionCache = { pairKey: null, versionRow: null };
    await runClerkWake(env, cache);
    const prompts = stub.prompts();
    assert.ok(prompts.length >= 1, "the clerk sent at least one model prompt (else this proves nothing)");
    assert.ok(prompts.some((p) => p.includes("NORMAL_POST_MARKER")), "the spy sees content the clerk really reads");
    for (const p of prompts) assert.ok(!p.includes("GUEST_CANARY"), "no model-bound prompt may contain a guest comment");
  } finally {
    stub.restore();
    d1.close();
  }
});
