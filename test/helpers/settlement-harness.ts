// Shared harness for the settlement replay guard's route-level tests
// (test/settlement-replay-*-d1.test.ts): the real Worker router over real local D1, the
// facilitator (and, in the reconciler tests, the Base RPCs) stubbed through globalThis.fetch.
//
// DEFERRED-CLAIM-ORDERING-FIXTURE (proposed in public by parallax, 1f3d9 notes 28208 and 28266, 4 Oct 2026): the claim
// tests here cover NAMED orderings (the CODEX r2/r4 and H2/H3 interleavings), not every ordering. The fixture would
// enumerate every permutation of a bounded event set (first /settle verdict, re-POST verdict, chain read used/unused/
// unreadable, clock past validBefore + margin, booking step, a second holder, duplicate delivery, stale replay) and check
// after EVERY prefix that once the society has observed settlement evidence (a facilitator success, or the chain reading
// the authorisation used), no later answer invites a fresh signature (a 402 with `accepts`). It would land on this harness.
// Known exception it must name rather than hide: DEFERRED-REFUSED-CHAIN-RECHECK (src/settlement-reconcile.ts).
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
  // Base RPC answers for the reconciler's authorizationState reads: called once per RPC fetch with the
  // URL, its 0-based index and the request (so a stub can tell eth_call from eth_getBlockByNumber); return null to make that RPC fail
  // (a rejected fetch). Unset: any RPC fetch throws.
  //
  // C6 (paid-path M3): the expiry decision now also reads each RPC's latest block (eth_getBlockByNumber) before its eth_call. A stub written for
  // eth_call alone (it returns an authorizationState word for EVERY request) is answered for the block read with a block stamped "now", which is past
  // every test's validBefore, so those tests keep meaning what they meant; a stub that returns an object result for the block read (blockAnswer, chainRpc) is used as is.
  rpc?: (url: string, n: number, init?: RequestInit) => Response | null | Promise<Response | null>;
}

// An eth_getBlockByNumber("latest") answer: the block's number and timestamp (unix seconds).
export function blockAnswer(timestamp: number, number = 0x1000): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { number: "0x" + number.toString(16), timestamp: "0x" + timestamp.toString(16) } }), { status: 200, headers: { "content-type": "application/json" } });
}
const rpcMethodOf = (init?: RequestInit): string | undefined => {
  try {
    return (JSON.parse(String(init?.body ?? "{}")) as { method?: string }).method;
  } catch {
    return undefined;
  }
};

// An eth_call answer for authorizationState: used (1) or unused (0).
export function authStateAnswer(used: boolean): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x" + (used ? "1" : "0").padStart(64, "0") }), { status: 200, headers: { "content-type": "application/json" } });
}
export function stubFacilitator(opts: StubOpts = {}) {
  const original = globalThis.fetch;
  const calls = { verify: 0, settle: 0 };
  const settleBodies: string[] = [];
  const rpcUrls: string[] = [];
  // Every RPC request the stub answered, with its JSON-RPC method and params.
  const rpcCalls: { url: string; method: string | undefined; params: unknown[] | undefined }[] = [];
  // How many /verify and /settle fetches the code under test ABORTED (its own timeout firing), as a real fetch would reject them.
  const aborts = { verify: 0, settle: 0 };
  // A delay a real facilitator would honour the caller's AbortSignal during: it rejects with an AbortError the moment the signal fires.
  const sleep = (ms: number, signal?: AbortSignal | null, which?: "verify" | "settle") =>
    new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        if (which) aborts[which]++;
        reject(Object.assign(new Error("This operation was aborted"), { name: "AbortError" }));
      });
    });
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    const href = String(url);
    if (href === `${FACILITATOR_URL}/verify`) {
      calls.verify++;
      opts.onVerify?.();
      if (opts.verifyDelayMs) await sleep(opts.verifyDelayMs, init?.signal, "verify");
      return new Response(JSON.stringify({ isValid: true }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (href === `${FACILITATOR_URL}/settle`) {
      const n = ++calls.settle;
      settleBodies.push(String(init?.body ?? ""));
      if (opts.settleDelayMs) await sleep(opts.settleDelayMs, init?.signal, "settle");
      if (opts.settle) return opts.settle(n);
      return new Response(JSON.stringify({ success: true, payer: TEST_PAYER, transaction: TX }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (opts.rpc) {
      const n = rpcUrls.length;
      rpcUrls.push(href);
      const method = rpcMethodOf(init);
      rpcCalls.push({ url: href, method, params: (() => { try { return (JSON.parse(String(init?.body ?? "{}")) as { params?: unknown[] }).params; } catch { return undefined; } })() });
      const answer = await opts.rpc(href, n, init);
      if (answer === null) throw new Error("rpc unreachable");
      if (method === "eth_getBlockByNumber") {
        const text = await answer.clone().text();
        if (/"result":"0x[0-9a-fA-F]{64}"/.test(text)) return blockAnswer(Math.floor(Date.now() / 1000));
      }
      return answer;
    }
    throw new Error(`unexpected fetch in a settlement replay test: ${href}`);
  }) as typeof fetch;
  return { calls, settleBodies, rpcUrls, rpcCalls, aborts, restore: () => void (globalThis.fetch = original) };
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


// An RPC stub answering BOTH reads the expiry decision makes: eth_call (authorizationState: used or not) and eth_getBlockByNumber (a block stamped `blockTime`, default now).
// `perUrl` lets a test make single RPCs lag or disagree: it is asked with the RPC's URL and its 0-based position in the list of distinct URLs seen so far.
export const chainRpc =
  (used: boolean | ((url: string) => boolean), blockTime: number | ((url: string) => number) = () => Math.floor(Date.now() / 1000)) =>
  (url: string, _n: number, init?: RequestInit): Response => {
    const method = rpcMethodOf(init);
    if (method === "eth_getBlockByNumber") return blockAnswer(typeof blockTime === "function" ? blockTime(url) : blockTime);
    return authStateAnswer(typeof used === "function" ? used(url) : used);
  };
