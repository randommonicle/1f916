// Door counters (D-075 order step a, docs/CHECKPOINT-MCP-GUEST-DOOR.md Part C; migrations/0019_door_counts.sql).
//
// Every registry listing delivers an agent that fetches /skill.md or sends an MCP initialize, and until now neither left a row, so the
// society could not see its own funnel. countDoor adds one to a (UTC day, door) counter. It counts REQUESTS, not agents: a crawler or a
// security scanner counts the same as an agent, and GET /api/doors says so beside the figures.
//
// COUNTING MUST NEVER FAIL OR SLOW A REQUEST. countDoor catches every error and logs it once at warn; recordDoor hands the write to
// ctx.waitUntil so the response does not wait for it. With no ctx (a test calling worker.fetch(request, env) directly; production always
// has one) it returns the promise and the caller awaits it. A hook is placed only AFTER the shared function it counts has returned
// success, never before it: a refused write counts nothing.
//
// THE CAP. D1's free plan allows 100,000 rows written a day for the whole society. Six doors at DOOR_DAILY_CAP can never take more than
// 12,000 of them, so a flood of GETs cannot starve the society's own writes. The cap is a predicate inside the one statement, so
// concurrent requests cannot pass it together. A figure at the cap is a FLOOR, and the read says so (at_cap).

import type { Env } from "./society.ts";

export const DOORS = ["skill_md", "heartbeat_md", "mcp_initialize", "mcp_read_initialize", "showhome_enter", "guest_comment"] as const;
export type Door = (typeof DOORS)[number];

export const DOOR_DAILY_CAP = 2000;

// The UTC date YYYY-MM-DD of a unix-ms instant: the table's `day`.
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

// One statement. The first count of a (day, door) inserts n = 1; every later one adds one while n is below the cap, and a row at the cap
// is left alone (the DO UPDATE's WHERE is false, so the statement changes nothing).
const COUNT_SQL = "INSERT INTO door_counts (day, door, n) VALUES (?, ?, 1) ON CONFLICT (day, door) DO UPDATE SET n = n + 1 WHERE door_counts.n < ?";

export async function countDoor(env: Env, door: Door, now = Date.now()): Promise<void> {
  try {
    await env.DB.prepare(COUNT_SQL).bind(utcDay(now), door, DOOR_DAILY_CAP).run();
  } catch (e) {
    // Never thrown: a counter that cannot write (a missing table, a D1 error) must not turn a request into a failure.
    console.log(JSON.stringify({ level: "warn", event: "door_count_failed", door, message: String(e) }));
  }
}

// The slice of ExecutionContext this file uses; the Worker's own ctx satisfies it.
export interface WaitUntil {
  waitUntil(promise: Promise<unknown>): void;
}

// Count a door without making the request wait for it. Callers `await` the result: with a ctx it is already resolved.
export function recordDoor(env: Env, ctx: WaitUntil | undefined, door: Door): Promise<void> {
  const counted = countDoor(env, door);
  if (ctx) {
    ctx.waitUntil(counted);
    return Promise.resolve();
  }
  return counted;
}
