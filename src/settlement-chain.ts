// The on-chain half of settlement reconciliation: USDC's EIP-3009 authorizationState(from,
// nonce) on Base, the question "did this signed authorisation already move money?"
// (docs/BRIEF-SETTLEMENT-REPLAY-GUARD.md B6). Expiry alone never proves anything; this read
// decides. A leaf module: it imports only the Env type and the RPC list, so x402.ts (the
// re-send path) and the reconciler can both use it without a cycle.
//
// It copies the CHECKS of the operator script's quorum (scripts/pay-listing.mjs), not its
// process shape: a reader that cannot reach two DISTINCT RPCs that agree draws NO conclusion,
// and a conclusion drawn from one node is exactly the failure a disagreement exists to catch.

import { baseRpcUrls, type Env } from "./society.ts";

// authorizationState(address,bytes32)
const AUTH_STATE_SELECTOR = "0xe94a0102";
const RPC_TIMEOUT_MS = 4_000;

// `fetches` is how many RPC fetches the read made (the reconciler meters its subrequests).
export type AuthorizationState = ({ used: boolean } | { used: null; reason: string }) & { fetches: number };

function word(hexNo0x: string): string {
  return hexNo0x.padStart(64, "0");
}

// One RPC's answer, or null if it gave none (unreachable, non-2xx, an error object, or a
// result that is not exactly a 32-byte 0 or 1: anything else is not an answer).
async function askRpc(url: string, asset: string, from: string, nonce: string): Promise<boolean | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RPC_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_call",
        params: [{ to: asset, data: AUTH_STATE_SELECTOR + word(from.replace(/^0x/, "").toLowerCase()) + word(nonce.replace(/^0x/, "").toLowerCase()) }, "latest"],
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { result?: unknown; error?: unknown };
    if (body.error !== undefined || typeof body.result !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(body.result)) return null;
    const v = BigInt(body.result);
    return v === 0n ? false : v === 1n ? true : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// C6 (first-gate L5): one RPC's answer to "was this authorisation used?" asked AT a named block, with that block's own timestamp. The block is read first ("latest": its number and
// timestamp), then the eth_call is made at THAT block number on the same RPC, so the answer and the time it is an answer for are the same block. Expiry needs this: an
// authorisation read as unused at an older block could have been mined since, so only an unused answer at a block whose timestamp is already past validBefore (+ margin) proves
// it can never be mined (EIP-3009 refuses a transfer once block.timestamp reaches validBefore). `fetches` is how many fetches this RPC cost (1 if the block read failed, else 2).
const QUANTITY_RE = /^0x[0-9a-fA-F]{1,16}$/;

async function postRpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RPC_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: ctrl.signal });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { result?: unknown; error?: unknown };
    return body.error !== undefined ? undefined : body.result;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

async function askRpcAtLatestBlock(url: string, asset: string, from: string, nonce: string): Promise<{ answer: { used: boolean; blockTime: number } | null; fetches: number }> {
  const block = await postRpc(url, "eth_getBlockByNumber", ["latest", false]);
  if (block === null || typeof block !== "object") return { answer: null, fetches: 1 };
  const { number, timestamp } = block as { number?: unknown; timestamp?: unknown };
  if (typeof number !== "string" || !QUANTITY_RE.test(number) || typeof timestamp !== "string" || !QUANTITY_RE.test(timestamp)) return { answer: null, fetches: 1 };
  const blockTime = Number(BigInt(timestamp));
  if (!Number.isSafeInteger(blockTime)) return { answer: null, fetches: 1 };
  const result = await postRpc(url, "eth_call", [
    { to: asset, data: AUTH_STATE_SELECTOR + word(from.replace(/^0x/, "").toLowerCase()) + word(nonce.replace(/^0x/, "").toLowerCase()) },
    "0x" + BigInt(number).toString(16),
  ]);
  if (typeof result !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(result)) return { answer: null, fetches: 2 };
  const v = BigInt(result);
  return { answer: v === 0n ? { used: false, blockTime } : v === 1n ? { used: true, blockTime } : null, fetches: 2 };
}

// The state of one authorisation, read at a two-RPC quorum: the first TWO distinct RPCs (in the
// list's order) that answer must agree. Fewer than two answers, or two that disagree, is no
// answer. At most four fetches (one per distinct RPC); a disagreement stops at two.
//
// With `pastTimestamp` (C6; the caller is about to call the authorisation EXPIRED, an answer that invites a second signature) every RPC is asked at its own latest block
// and an RPC whose answer is "unused" from a block NOT YET past `pastTimestamp` (unix seconds) is lagging: it is no answer, and the next RPC is tried. "Used" is accepted from
// any block (a used authorisation stays used). At most two fetches per RPC, eight in all; only the expiry decision pays for it.
export async function readAuthorizationState(env: Env, asset: string, from: string, nonce: string, opts: { pastTimestamp?: number } = {}): Promise<AuthorizationState> {
  const answers: { url: string; used: boolean }[] = [];
  let fetches = 0;
  let lagging = 0;
  for (const url of [...new Set(baseRpcUrls(env))]) {
    if (opts.pastTimestamp === undefined) {
      fetches++;
      const used = await askRpc(url, asset, from, nonce);
      if (used !== null) answers.push({ url, used });
    } else {
      const r = await askRpcAtLatestBlock(url, asset, from, nonce);
      fetches += r.fetches;
      if (r.answer !== null) {
        if (r.answer.used === false && !(r.answer.blockTime > opts.pastTimestamp)) lagging++;
        else answers.push({ url, used: r.answer.used });
      }
    }
    if (answers.length === 2) break;
  }
  if (answers.length < 2) {
    return { used: null, reason: `${answers.length} of the required 2 distinct Base RPCs answered${lagging > 0 ? ` (${lagging} answered "unused" from a block whose timestamp is not yet past the authorisation's expiry)` : ""}`, fetches };
  }
  if (answers[0].used !== answers[1].used) return { used: null, reason: "two Base RPCs disagree about the authorisation's state", fetches };
  return { used: answers[0].used, fetches };
}
