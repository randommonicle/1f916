// Shared harness for the settlement replay guard's route-level tests
// (test/settlement-replay-*-d1.test.ts): the real Worker router over real local D1, the
// facilitator (and, in the reconciler tests, the Base RPCs) stubbed through globalThis.fetch.
import assert from "node:assert/strict";
import { createLocalD1, type LocalD1 } from "./local-d1.ts";
import { paymentHeaderFor, TEST_PAYER } from "./x402-payload.ts";
import { encodeBase64Url } from "../../src/keyauth.ts";
import type { Env } from "../../src/society.ts";
import worker from "../../src/index.ts";

export { createLocalD1, paymentHeaderFor, TEST_PAYER };
export type { LocalD1, Env };

export const TREASURY_ADDRESS = "0xa7f7985eb19b8c44f12a0654df1ef89d1dd527c9";
export const FACILITATOR_URL = "https://facilitator.example.invalid";
export const TX = "0x" + "ab".repeat(32);

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} };
export function callWorker(request: Request, env: Env): Promise<Response> {
  return (worker.fetch as unknown as (r: Request, e: Env, c: unknown) => Promise<Response>)(request, env, ctx);
}
export const testEnv = (d1: LocalD1, extra: Record<string, unknown> = {}): Env =>
  ({ DB: d1.DB, TREASURY_ADDRESS, FACILITATOR_URL, REGISTRATION_MODE: "open", ...extra }) as unknown as Env;

// The facilitator. /verify is valid; /settle answers `settle(n)` for its nth call (default: a
// settled answer with TX). Delays let two requests be in flight at once. Every /settle body is
// kept, so a test can assert what was (and was not) put to the facilitator.
export interface StubOpts {
  settle?: (n: number) => Response | Promise<Response>;
  verifyDelayMs?: number;
  settleDelayMs?: number;
  onVerify?: () => void;
}
export function stubFacilitator(opts: StubOpts = {}) {
  const original = globalThis.fetch;
  const calls = { verify: 0, settle: 0 };
  const settleBodies: string[] = [];
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const href = String(url);
    if (href === `${FACILITATOR_URL}/verify`) {
      calls.verify++;
      opts.onVerify?.();
      if (opts.verifyDelayMs) await sleep(opts.verifyDelayMs);
      return new Response(JSON.stringify({ isValid: true }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (href === `${FACILITATOR_URL}/settle`) {
      const n = ++calls.settle;
      settleBodies.push(String(init?.body ?? ""));
      if (opts.settleDelayMs) await sleep(opts.settleDelayMs);
      if (opts.settle) return opts.settle(n);
      return new Response(JSON.stringify({ success: true, payer: TEST_PAYER, transaction: TX }), { status: 200, headers: { "content-type": "application/json" } });
    }
    throw new Error(`unexpected fetch in settlement-replay-routes-d1.test.ts: ${href}`);
  }) as typeof fetch;
  return { calls, settleBodies, restore: () => void (globalThis.fetch = original) };
}

export const count = (d1: LocalD1, fromWhere: string): number => (d1.raw.prepare(`SELECT COUNT(*) AS n FROM ${fromWhere}`).get() as { n: number }).n;
export const claimRows = (d1: LocalD1) => d1.raw.prepare("SELECT * FROM settlement_claims ORDER BY created_at, nonce").all() as Record<string, unknown>[];
export const oneClaim = (d1: LocalD1) => {
  const rows = claimRows(d1);
  assert.equal(rows.length, 1, "exactly one claim row");
  return rows[0] as { state: string; tx: string | null; rpc_body: string | null; booked_refs: string; route: string; lease_owner: string | null };
};

export function failInserts(d1: LocalD1, name: string, table: string, when: string | null, message: string): void {
  assert.equal(message.includes("'"), false, "the message is embedded in a SQL string literal");
  d1.raw.exec(`CREATE TRIGGER ${name} BEFORE INSERT ON ${table} ${when ? `WHEN ${when}` : ""} BEGIN SELECT RAISE(ABORT, '${message}'); END;`);
}
export const dropTrigger = (d1: LocalD1, name: string) => d1.raw.exec(`DROP TRIGGER ${name}`);

export async function captureLog<T>(fn: () => Promise<T>): Promise<{ value: T; lines: string[] }> {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => void lines.push(args.map(String).join(" "));
  try {
    return { value: await fn(), lines };
  } finally {
    console.log = originalLog;
  }
}
export const eventLines = (lines: string[], event: string) =>
  lines.flatMap((l) => {
    try {
      const o = JSON.parse(l) as Record<string, unknown>;
      return o.event === event ? [o] : [];
    } catch {
      return [];
    }
  });

export async function realPublicKey(): Promise<string> {
  const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  return encodeBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey)));
}

export const registerHeader = () => paymentHeaderFor(TREASURY_ADDRESS, "1000000");
export function registerReq(body: Record<string, unknown>, header: string): Request {
  return new Request("https://example.test/api/register", { method: "POST", headers: { "Content-Type": "application/json", "X-PAYMENT": header }, body: JSON.stringify(body) });
}
export function patronReq(message: string, header: string): Request {
  return new Request("https://example.test/api/patron", { method: "POST", headers: { "Content-Type": "application/json", "X-PAYMENT": header }, body: JSON.stringify({ message }) });
}
export async function json(res: Response): Promise<Record<string, any>> {
  return (await res.json()) as Record<string, any>;
}

