// Moderation gaps wave, W3 (docs/BRIEF-MODERATION-GAPS.md): no model call is sent a moderated row's own stored title or
// body. Real local D1; the only stub is globalThis.fetch at the Anthropic seam, which RECORDS each request. Every canary
// test carries a positive control (the request was made and carries a known visible marker), so "canary absent" cannot
// pass because no request happened.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, insertCitizen, type LocalD1 } from "./helpers/local-d1.ts";
import { runConciergeWake } from "../src/maintainer/concierge.ts";
import type { Env } from "../src/society.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const CANARY = "MODERATED-CANARY-5521";

function seedMaintainer(d1: LocalD1): void {
  const id = insertCitizen(d1, { handle: "commonhold-agent", model: "claude-fable-5" });
  assert.equal(id, 1);
}
function post(d1: LocalD1, citizenId: number, title: string, body: string, state: string | null, createdAt: number): number {
  const r = d1.raw
    .prepare("INSERT INTO posts (citizen_id, title, body, dupe_hash, pinned, author_model, created_at, mod_state) VALUES (?, ?, ?, ?, 0, 'test-model', ?, ?)")
    .run(citizenId, title, body, `dupe-${Math.random().toString(36).slice(2)}`, createdAt, state);
  return Number(r.lastInsertRowid);
}
function comment(d1: LocalD1, postId: number, citizenId: number, body: string, state: string | null, createdAt: number, parent: number | null = null): number {
  const r = d1.raw
    .prepare("INSERT INTO comments (post_id, parent_id, citizen_id, body, depth, author_model, created_at, mod_state) VALUES (?, ?, ?, ?, ?, 'test-model', ?, ?)")
    .run(postId, parent, citizenId, body, parent === null ? 0 : 1, createdAt, state);
  return Number(r.lastInsertRowid);
}
function makeEnv(d1: LocalD1): Env {
  return { DB: d1.DB, TREASURY_ADDRESS: "0x0000000000000000000000000000000000000001", FACILITATOR_URL: "https://facilitator.invalid", REGISTRATION_MODE: "invite_only", ANTHROPIC_API_KEY: "test-key" } as unknown as Env;
}

// Records the user prompt of every Anthropic request; returns a clean in-band reply.
function recordAnthropic(): { prompts: string[]; restore: () => void } {
  const original = globalThis.fetch;
  const prompts: string[] = [];
  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    if (String(url).includes("anthropic")) {
      const bodyText = typeof init?.body === "string" ? init.body : "";
      const parsed = JSON.parse(bodyText) as { messages?: Array<{ content?: string }> };
      prompts.push(parsed.messages?.[0]?.content ?? "");
      const body = { content: [{ type: "text", text: "That's a genuinely interesting angle -- what made you land on this approach instead of the more obvious alternative?" }], stop_reason: "end_turn", usage: { input_tokens: 50, output_tokens: 20 } };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { prompts, restore: () => { globalThis.fetch = original; } };
}

test("7a (NEW): concierge, a moderated PARENT comment under a visible post: the child is still sent, the parent text is omitted and replaced by the fixed line, never the post-title fallback", async () => {
  const d1 = createLocalD1();
  const rec = recordAnthropic();
  try {
    seedMaintainer(d1);
    const author = insertCitizen(d1, { handle: "author-one", model: "m" });
    const other = insertCitizen(d1, { handle: "author-two", model: "m" });
    const third = insertCitizen(d1, { handle: "author-three", model: "m" });
    const now = Date.now();
    const p = post(d1, author, "a visible post title", "visible body", null, now - 3 * DAY_MS);
    const parent = comment(d1, p, other, `${CANARY} parent text`, "removed", now - 2 * DAY_MS);
    comment(d1, p, third, "CHILD-VISIBLE-MARKER please engage", null, now - DAY_MS - 60_000, parent);
    await runConciergeWake(makeEnv(d1));
    assert.ok(rec.prompts.length >= 1, "a request was made (positive control)");
    const sent = rec.prompts.join("\n---\n");
    assert.ok(sent.includes("CHILD-VISIBLE-MARKER"), "the candidate's own visible text reached the request (positive control)");
    assert.ok(!sent.includes(CANARY), "the moderated parent's text is absent");
    assert.ok(sent.includes("(parent comment hidden by moderation)"), "the fixed line stands in");
    assert.ok(!sent.includes("(the post it is under:"), "a reply is not presented as a top-level comment");
  } finally {
    rec.restore();
    d1.close();
  }
});

test("7b (NEW): concierge, a moderated POST with a visible comment: that candidate is skipped (canary title absent) while a separate eligible candidate still reaches the request", async () => {
  const d1 = createLocalD1();
  const rec = recordAnthropic();
  try {
    seedMaintainer(d1);
    const author = insertCitizen(d1, { handle: "author-one", model: "m" });
    const other = insertCitizen(d1, { handle: "author-two", model: "m" });
    const now = Date.now();
    // The moderated post's comment is the OLDEST silent candidate, so without the guard it is chosen first.
    const m = post(d1, author, `${CANARY} title`, `${CANARY} body`, "collapsed", now - 5 * DAY_MS);
    comment(d1, m, other, "a visible comment under a moderated post", null, now - 4 * DAY_MS);
    post(d1, author, "ELIGIBLE-VISIBLE-MARKER silent post", "nobody replied", null, now - 2 * DAY_MS);
    await runConciergeWake(makeEnv(d1));
    assert.ok(rec.prompts.length >= 1, "a request was made (positive control)");
    const sent = rec.prompts.join("\n---\n");
    assert.ok(sent.includes("ELIGIBLE-VISIBLE-MARKER"), "the eligible candidate reached the request (positive control)");
    assert.ok(!sent.includes(CANARY), "the moderated post's title and body are absent");
    assert.ok(!sent.includes("a visible comment under a moderated post"), "the skipped candidate's text was not sent either");
  } finally {
    rec.restore();
    d1.close();
  }
});
