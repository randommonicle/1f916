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

// The state of one authorisation, read at a two-RPC quorum: the first TWO distinct RPCs (in the
// list's order) that answer must agree. Fewer than two answers, or two that disagree, is no
// answer. At most four fetches (one per distinct RPC); a disagreement stops at two.
export async function readAuthorizationState(env: Env, asset: string, from: string, nonce: string): Promise<AuthorizationState> {
  const answers: { url: string; used: boolean }[] = [];
  let fetches = 0;
  for (const url of [...new Set(baseRpcUrls(env))]) {
    fetches++;
    const used = await askRpc(url, asset, from, nonce);
    if (used !== null) answers.push({ url, used });
    if (answers.length === 2) break;
  }
  if (answers.length < 2) return { used: null, reason: `${answers.length} of the required 2 distinct Base RPCs answered`, fetches };
  if (answers[0].used !== answers[1].used) return { used: null, reason: "two Base RPCs disagree about the authorisation's state", fetches };
  return { used: answers[0].used, fetches };
}
