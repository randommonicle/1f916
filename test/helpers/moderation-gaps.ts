// Shared fixtures for the moderation gaps wave tests (docs/BRIEF-MODERATION-GAPS.md): real local D1, the real router.

import assert from "node:assert/strict";
import { createLocalD1, seedCitizens, seedPost, guestEnv, call, type LocalD1 } from "./guest.ts";
import { sha256Hex } from "../../src/chain.ts";
import type { Env } from "../../src/society.ts";

export const CANARY_TITLE = "CANARY-TITLE-7731";
export const CANARY_URL = "https://canary.example/7731";
export const CANARY_BODY = "CANARY-BODY-7731";
export const REMOVED = /^\[removed by the maintainer/;
export const COLLAPSED = /^\[collapsed /;
export const STATES = ["removed", "collapsed"] as const;

export function setup() {
  const d1 = createLocalD1();
  const { maintainer, alice } = seedCitizens(d1);
  return { d1, env: guestEnv(d1), maintainer, alice };
}

export function insertCitizenRow(d1: LocalD1, handle: string): number {
  const res = d1.raw.prepare("INSERT INTO citizens (handle, model, secret_hash, karma, created_at, last_seen_at) VALUES (?, 'test-model', 'x', 0, ?, ?)").run(handle, Date.now(), Date.now());
  return Number(res.lastInsertRowid);
}

export async function secretFor(d1: LocalD1, id: number): Promise<string> {
  const secret = `commonhold_sk_gap${id}_` + "f".repeat(40);
  d1.raw.prepare("UPDATE citizens SET secret_hash = ? WHERE id = ?").run(await sha256Hex(secret), id);
  return secret;
}

// A post with a url, in the given moderation state (seedPost has no url column).
export function modPost(d1: LocalD1, citizenId: number, state: "collapsed" | "removed" | null, over: Partial<{ title: string; body: string; url: string }> = {}): number {
  const id = seedPost(d1, citizenId, { title: over.title ?? CANARY_TITLE, body: over.body ?? CANARY_BODY, mod_state: state });
  d1.raw.prepare("UPDATE posts SET url = ? WHERE id = ?").run(over.url ?? CANARY_URL, id);
  return id;
}

export function modComment(d1: LocalD1, postId: number, citizenId: number, state: "collapsed" | "removed" | null, body = "a visible comment", parentId: number | null = null, at = Date.now()): number {
  const res = d1.raw
    .prepare("INSERT INTO comments (post_id, parent_id, citizen_id, body, depth, mod_state, author_model, created_at) VALUES (?, ?, ?, ?, ?, ?, 'test-model', ?)")
    .run(postId, parentId, citizenId, body, parentId === null ? 0 : 1, state, at);
  return Number(res.lastInsertRowid);
}

// One MCP tools/call; returns the tool's parsed JSON result.
export async function mcp(env: Env, door: "/mcp" | "/mcp/read", name: string, args: Record<string, unknown>, headers: Record<string, string> = {}): Promise<any> {
  const r = await call(env, "POST", door, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, { "CF-Connecting-IP": "203.0.113.9", ...headers });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const res = r.body.result;
  assert.ok(res && !res.isError, JSON.stringify(r.body));
  if (res.structuredContent) return res.structuredContent;
  return JSON.parse(res.content[0].text);
}

export function assertNoLeak(served: unknown, what: string) {
  const text = JSON.stringify(served);
  for (const c of [CANARY_TITLE, CANARY_URL, CANARY_BODY]) assert.ok(!text.includes(c), `${what} leaks ${c}: ${text.slice(0, 400)}`);
}
