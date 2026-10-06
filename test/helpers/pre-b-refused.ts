// A claim row as it stood BEFORE option B (docs/BRIEF-REFUSED-CHAIN-RECHECK.md, ruled 5 Oct 2026).
//
// Until option B, payAndSettle's first /settle wrote `state = 'refused'` on a rule-7 recorded refusal (markRefused, since deleted). After B nothing writes that state: a first-attempt
// refusal keeps the claim pending (markFirstRefusal), and a row can read `refused` only as HISTORY, written by a worker that ran the earlier code (L-126: a state a test injects must be one
// production could produce; a pre-B refused row is production-reachable only as history). The code that still serves such rows is unchanged on purpose (claimAnswer's refused arm,
// markContradiction, isContradicted, holdSuccessAgainstTerminal, the attention list's contradiction marker), and it needs rows to be exercised on.
//
// This helper writes exactly what markRefused wrote (state, the cleared body, the reason, the cleared lease), with NO lease condition: a test uses it to model "a worker that ran the old
// code refused the claim at this moment". It returns whether the row moved, like the function it replaces. Never call it to build a row for a NEW first-attempt refusal: that is a route
// call, and its answer is the point of the test.

import { KEY_WHERE, keyArgs, type ClaimKey } from "../../src/settlement-claims.ts";
import type { LocalD1 } from "./local-d1.ts";

export function seedPreBRefused(d1: LocalD1, key: ClaimKey, reason: string, now = Date.now()): boolean {
  const r = d1.raw
    .prepare(`UPDATE settlement_claims SET state = 'refused', rpc_body = NULL, verdict_reason = ?, lease_owner = NULL, leased_until = NULL, updated_at = ? WHERE ${KEY_WHERE} AND state = 'pending'`)
    .run(reason, now, ...(keyArgs(key) as never[]));
  return Number(r.changes) === 1;
}
