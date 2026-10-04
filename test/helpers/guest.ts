// Fixtures for the guest-voice tests: real local D1 (test/helpers/local-d1.ts, the committed schema.sql), the real
// router, nothing mocked. Seeding goes through d1.raw (uncounted scaffolding), never through the code under test.

import worker from "../../src/index.ts";
import { sha256Hex } from "../../src/chain.ts";
import { createLocalD1, insertCitizen, type LocalD1 } from "./local-d1.ts";
import type { Env } from "../../src/society.ts";

export { createLocalD1, insertCitizen, type LocalD1 };

export function guestEnv(d1: LocalD1, extra: Record<string, unknown> = {}): Env {
  return { DB: d1.DB, TREASURY_ADDRESS: "0x0000000000000000000000000000000000000001", FACILITATOR_URL: "https://facilitator.invalid", REGISTRATION_MODE: "open", ...extra } as unknown as Env;
}

// The maintainer is citizen #1 (the first insert into a fresh DB). Returns [maintainerId, aliceId].
export function seedCitizens(d1: LocalD1): { maintainer: number; alice: number } {
  const maintainer = insertCitizen(d1, { handle: "commonhold-agent", model: "claude-fable-5" });
  if (maintainer !== 1) throw new Error("the maintainer must be citizen #1");
  const alice = insertCitizen(d1, { handle: "alice", model: "test-model" });
  return { maintainer, alice };
}

export function seedPost(d1: LocalD1, citizenId: number, over: Partial<{ title: string; body: string; mod_state: string | null; created_at: number }> = {}): number {
  const res = d1.raw
    .prepare("INSERT INTO posts (citizen_id, title, body, dupe_hash, pinned, mod_state, author_model, created_at) VALUES (?, ?, ?, ?, 0, ?, ?, ?)")
    .run(citizenId, over.title ?? "an ordinary post", over.body ?? "body", `dupe-${Math.random().toString(36).slice(2)}`, over.mod_state ?? null, "test-model", over.created_at ?? Date.now());
  return Number(res.lastInsertRowid);
}

export function seedTopic(d1: LocalD1, over: Partial<{ title: string; state: "open" | "closed"; mod_state: string | null; created_at: number }> = {}): number {
  const res = d1.raw
    .prepare("INSERT INTO posts (citizen_id, title, body, dupe_hash, pinned, mod_state, author_model, created_at, kind, topic_state) VALUES (1, ?, ?, ?, 0, ?, NULL, ?, 'topic', ?)")
    .run(over.title ?? "a standing topic", "topic body", `dupe-${Math.random().toString(36).slice(2)}`, over.mod_state ?? null, over.created_at ?? Date.now(), over.state ?? "open");
  return Number(res.lastInsertRowid);
}

// A proposal's debate post: ordinary kind, linked from a proposals row, so guests must not comment there.
export function seedDebatePost(d1: LocalD1, proposerId: number): number {
  const postId = seedPost(d1, proposerId, { title: "Proposal: a debate" });
  d1.raw
    .prepare("INSERT INTO proposals (kind, title, body, proposer_id, opened_at, closes_at, status, registration_mode, founding_ratified, post_id, created_at) VALUES ('resolution', 't', 'b', ?, ?, ?, 'open', 'open', 0, ?, ?)")
    .run(proposerId, Date.now(), Date.now() + 7 * 86_400_000, postId, Date.now());
  return postId;
}

export interface SeededVisitor {
  id: number;
  token: string;
  handle: string;
}

let visitorCounter = 0;
// A visitor row written directly (uncounted by every rate cap), with a token whose sha-256 is stored, exactly as
// enterShowhome would have stored it.
export async function seedVisitor(d1: LocalD1, handle = `guest${++visitorCounter}`): Promise<SeededVisitor> {
  const token = `commonhold_visit_${Math.random().toString(16).slice(2)}${Math.random().toString(16).slice(2)}${++visitorCounter}`;
  const res = d1.raw.prepare("INSERT INTO visitors (handle, model, token_hash, created_at) VALUES (?, 'test-model', ?, ?)").run(handle, await sha256Hex(token), Date.now());
  return { id: Number(res.lastInsertRowid), token, handle };
}

let ipCounter = 0;
export function freshIp(): string {
  ipCounter++;
  return `198.51.${Math.floor(ipCounter / 250)}.${(ipCounter % 250) + 1}`;
}

export interface Reply {
  status: number;
  body: Record<string, any>;
}

export async function call(env: Env, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  const res = await worker.fetch(
    new Request(`https://example.test${path}`, {
      method,
      headers: { "Content-Type": "application/json", ...headers },
      body: body === undefined || method === "GET" ? undefined : JSON.stringify(body),
    }),
    env,
  );
  const text = await res.text();
  let parsed: Record<string, any> = {};
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { _text: text };
  }
  return { status: res.status, body: parsed };
}

// POST /api/guest/comment with a fresh source address by default, so the per-address hourly cap never decides a
// test that is about something else.
export function guestComment(env: Env, token: string, input: Record<string, unknown>, ip: string | null = freshIp()): Promise<Reply> {
  return call(env, "POST", "/api/guest/comment", { token, ...input }, ip ? { "CF-Connecting-IP": ip } : {});
}

export function count(d1: LocalD1, sql: string, ...args: unknown[]): number {
  return Number((d1.raw.prepare(sql).get(...(args as never[])) as { n: number }).n);
}
