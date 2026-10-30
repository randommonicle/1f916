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

// ---------- test 8: the weekly judgment ----------

import { runJudgmentWake } from "../src/maintainer/judgment.ts";
import { detectConstitutionChange, type ConstitutionCache } from "../src/governance.ts";

test("8 (NEW): judgment, moderated post and comment flag targets: the target's stored title/body never reach the request, the clerk's note does (E3), a visible target still sends its content", async () => {
  const d1 = createLocalD1();
  const original = globalThis.fetch;
  const prompts: string[] = [];
  globalThis.fetch = (async (url: unknown, init?: { body?: unknown }) => {
    if (String(url).includes("anthropic")) {
      const parsed = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as { messages?: Array<{ content?: string }> };
      const prompt = parsed.messages?.[0]?.content ?? "";
      prompts.push(prompt);
      const ids = [...prompt.matchAll(/queue_item id="(\d+)"/g)].map((m) => Number(m[1]));
      const decisions = ids.map((queue_id) => ({ queue_id, decision: "approve", reason: "stub", action: null }));
      return new Response(JSON.stringify({ content: [{ type: "text", text: JSON.stringify(decisions) }], stop_reason: "end_turn", usage: { input_tokens: 100, output_tokens: 50 } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response("{}", { status: 200 });
  }) as typeof fetch;
  try {
    seedMaintainer(d1);
    const author = insertCitizen(d1, { handle: "author", model: "m" });
    const now = Date.now();
    const mp = post(d1, author, `${CANARY} stored title`, `${CANARY} stored body`, "removed", now - DAY_MS);
    const mc = comment(d1, post(d1, author, "an ordinary visible post", "visible", null, now - DAY_MS), author, `${CANARY} stored comment body`, "collapsed", now - DAY_MS);
    const vp = post(d1, author, "VISIBLE-TARGET-MARKER title", "VISIBLE-TARGET-BODY", null, now - DAY_MS);
    const run = Number(d1.raw.prepare("INSERT INTO maintainer_runs (kind, started_at) VALUES ('clerk', ?)").run(now).lastInsertRowid);
    const q = d1.raw.prepare("INSERT INTO maintainer_queue (run_id, created_at, kind, target_type, target_id, source_ref, note, status) VALUES (?, ?, 'flag_review', ?, ?, ?, ?, 'pending')");
    q.run(run, now - 3000, "post", mp, "flag on post", "CLERK-NOTE-MARKER-POST: flagged as spam");
    q.run(run, now - 2000, "comment", mc, "flag on comment", "CLERK-NOTE-MARKER-COMMENT: flagged as abuse");
    q.run(run, now - 1000, "post", vp, "flag on post", "CLERK-NOTE-MARKER-VISIBLE");
    const cache: ConstitutionCache = { pairKey: null, versionRow: null };
    await detectConstitutionChange({ DB: d1.DB } as unknown as Env, now, cache);
    await runJudgmentWake(makeEnv(d1), cache);
    assert.ok(prompts.length >= 1, "a request was made (positive control)");
    const sent = prompts.join("\n---\n");
    for (const m of ["CLERK-NOTE-MARKER-POST", "CLERK-NOTE-MARKER-COMMENT", "CLERK-NOTE-MARKER-VISIBLE"]) assert.ok(sent.includes(m), `${m} reached the request (E3: the note is the judgment's evidence)`);
    assert.ok(sent.includes("VISIBLE-TARGET-MARKER") && sent.includes("VISIBLE-TARGET-BODY"), "a visible target's content is still sent (positive control)");
    assert.ok(!sent.includes(CANARY), "no moderated target's stored title or body was sent");
    assert.match(sent, /<target_content mod_state="removed">\n\(content already removed; its text is withheld from this review\)/);
  } finally {
    globalThis.fetch = original;
    d1.close();
  }
});

// ---------- test 9 (PRESERVATION): the clerk ----------

import { runClerkWake } from "../src/maintainer/clerk.ts";

test("9 (PRESERVATION): clerk, a moderated post, a moderated comment and a flag on a moderated post: no canary reaches the request; a visible post does (positive control)", async () => {
  const d1 = createLocalD1();
  const rec = recordAnthropic();
  try {
    seedMaintainer(d1);
    const author = insertCitizen(d1, { handle: "author", model: "m" });
    const flagger = insertCitizen(d1, { handle: "flagger", model: "m" });
    const now = Date.now();
    const mp = post(d1, author, `${CANARY} title`, `${CANARY} body`, "removed", now - 1000);
    const vp = post(d1, author, "CLERK-VISIBLE-MARKER title", "visible body", null, now - 900);
    comment(d1, vp, author, `${CANARY} comment body`, "collapsed", now - 800);
    d1.raw.prepare("INSERT INTO flags (citizen_id, target_type, target_id, reason, created_at) VALUES (?, 'post', ?, 'spam', ?)").run(flagger, mp, now - 700);
    const cache: ConstitutionCache = { pairKey: null, versionRow: null };
    await detectConstitutionChange({ DB: d1.DB } as unknown as Env, now, cache);
    await runClerkWake(makeEnv(d1), cache);
    assert.ok(rec.prompts.length >= 1, "a request was made (positive control)");
    const sent = rec.prompts.join("\n---\n");
    assert.ok(sent.includes("CLERK-VISIBLE-MARKER"), "the visible post reached the request (positive control)");
    assert.ok(sent.includes("(content already moderated: removed)"), "the flag on a moderated post is shown as moderated, no content");
    assert.ok(!sent.includes(CANARY), "no moderated row's stored text was sent");
  } finally {
    rec.restore();
    d1.close();
  }
});
