// The settlement reconciler (docs/BRIEF-SETTLEMENT-REPLAY-GUARD.md B6, B6a, B6b): the BACKSTOP
// that resolves claims whose outcome the request path could not. It runs inside the existing
// 06:00 UTC scheduled handler (no schedule change), one leased attempt per row:
//
//   pending           -> attemptPending (x402.ts): the chain decides (authorizationState at a
//                        two-RPC quorum), then the stored body is re-POSTed to /settle as PayAI's
//                        documentation prescribes; a settled answer makes the row settled_unbooked;
//                        unused past validBefore (+ margin) makes it expired; a recorded refusal
//                        makes it refused; anything else changes nothing.
//   settled_unbooked  -> the route's own booking (the same code the paid request and the payer's
//                        re-send run), skipping whatever booked_refs already records.
//
// It is a backstop, not the fast path: a row can wait until the next 06:00 UTC run, every served
// message for such a state says so (RECONCILE_BACKSTOP), and the payer's identical re-send is the
// earlier route. A secret-mode registration it never books past settled_unbooked (B5/B6b): its
// secret leaves only in the payer's own 201, so the row waits for that re-send.
//
// BUDGET. scheduled() shares ONE 50-subrequest invocation with the governance sweep, the concierge and
// the clerk (src/maintainer/budget.ts), and a subrequest is any D1 statement or outbound fetch. The
// order is sweep -> concierge -> reconciler -> clerk (hub ruling F3, 2026-09-30): the concierge keeps first
// claim on a tight day, and the reconciler, a daily backstop that can wait, is handed only what is left after
// the sweep, the concierge's ACTUAL cost and the clerk's reserved minimum; with too little for one worst-case
// row it works none and logs `settlement_reconcile_deferred`. The reconciler works at most
// RECONCILE_BATCH_ROWS rows, oldest attempt first. It MEASURES what each row
// really spends (every D1 statement through a metered DB, every RPC and /settle fetch as the attempt
// reports them), starts a row only if the row's WORST case still fits under
// RECONCILE_SUBREQUEST_CEILING, and returns the measured total so the wake sheds against it. One
// row's worst case, itemised (a pending public-key registration through every step): lease 1,
// authorizationState at most 4 RPC fetches, /settle 1, markSettled 1, the treasury line 3 (head
// read + a 2-statement batch), the citizen 2 + 1 read-back, the key_registered line 3 = 16, which
// test/settlement-replay-reconcile-d1.test.ts measures through the real scheduled() handler (17 with
// the select). RECONCILE_ROW_WORST_CASE is that 16 plus 2 for one chain-head collision retry, the
// house posture (budget.ts FINALISE_RESERVE): a second concurrent collision is an accepted residual.

import { attemptPending, finishPatronBooking, clipReason } from "./x402.ts";
import { finishRegistration } from "./register-gate.ts";
import { finishListingCreateBooking, finishPayListingBooking } from "./listings.ts";
import { INVOCATION_SUBREQUEST_BUDGET, FINALISE_RESERVE } from "./maintainer/budget.ts";
import { acquireLease, keyOfRow, releaseLease, CLAIM_HANDLE_TAKEN, type ClaimRow } from "./settlement-claims.ts";
import type { Env } from "./society.ts";

// At most this many rows are worked in one run (a fixed batch).
export const RECONCILE_BATCH_ROWS = 2;
// The one SELECT of due rows, always paid.
export const RECONCILE_SELECT_COST = 1;
// One row's worst case (see the itemisation above). A row is started only if this still fits.
export const RECONCILE_ROW_WORST_CASE = 18;
// The most the reconciler may spend in one invocation (measured, not priced), however much is left: it lets a cheap
// first row (a failing or expired one) be followed by a second. On a given day it is also capped by what is LEFT after
// the sweep, the concierge's actual cost and the clerk's minimum (runReconciler's `reservedCost`, hub ruling F3).
export const RECONCILE_SUBREQUEST_CEILING = 26;

export interface ReconcileResult {
  // The subrequests this run spent, measured; scheduled() adds it to priorCost.
  actualCost: number;
  examined: number;
  booked: number;
  resolved: number;
  unchanged: number;
  failed: number;
}

const NOTHING: ReconcileResult = { actualCost: 0, examined: 0, booked: 0, resolved: 0, unchanged: 0, failed: 0 };

// An env whose DB counts every statement it is asked to run (a batch counts each of its statements,
// the conservative reading docs/RECON-CLOUDFLARE-FREE-LIMITS §1.2 and the test harness use).
function metered(env: Env, meter: { n: number }): Env {
  const real = env.DB;
  const inner = new WeakMap<object, D1PreparedStatement>();
  const wrap = (stmt: D1PreparedStatement): D1PreparedStatement => {
    const proxy = new Proxy(stmt, {
      get(target, prop) {
        if (prop === "bind") return (...args: unknown[]) => wrap((target.bind as (...a: unknown[]) => D1PreparedStatement).apply(target, args));
        if (prop === "first" || prop === "all" || prop === "run" || prop === "raw") {
          return (...args: unknown[]) => {
            meter.n++;
            return ((target as unknown as Record<string, (...a: unknown[]) => unknown>)[prop as string]).apply(target, args);
          };
        }
        const v = (target as unknown as Record<string | symbol, unknown>)[prop];
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    inner.set(proxy, stmt);
    return proxy;
  };
  const db = {
    prepare: (sql: string) => wrap(real.prepare(sql)),
    batch: (stmts: D1PreparedStatement[]) => {
      meter.n += stmts.length;
      return real.batch(stmts.map((s) => inner.get(s as unknown as object) ?? s));
    },
  } as unknown as D1Database;
  return { ...env, DB: db };
}

// Books a settled row through its route. Returns true when the row is now `booked`, false when this
// caller rightly left it (a secret-mode registration). Throws when the booking failed; the route's
// finisher has already logged its own failure line.
async function finishBooking(env: Env, row: ClaimRow, owner: string): Promise<boolean> {
  switch (row.route) {
    case "register":
      return (await finishRegistration(env, row, { ip: null, inviteCode: null, deliver: false, owner })).done;
    case "patron":
      await finishPatronBooking(env, row, owner);
      return true;
    case "listing_create":
      await finishListingCreateBooking(env, row, owner);
      return true;
    case "listing_pay":
      await finishPayListingBooking(env, row, owner);
      return true;
  }
}

// `reservedCost` is everything the invocation has already spent or has reserved for work that ranks ahead of this one: the
// governance sweep, the concierge's actual cost and the clerk's fixed minimum (scheduled(), hub ruling F3). The reconciler is
// handed only what is left of the 50 after that and FINALISE_RESERVE; if that cannot pay for the select and one worst-case
// row it works NONE this run and writes one `settlement_reconcile_deferred` line, and the rows wait a day.
export async function runReconciler(env: Env, reservedCost = 0): Promise<ReconcileResult> {
  const left = INVOCATION_SUBREQUEST_BUDGET - reservedCost - FINALISE_RESERVE;
  if (left < RECONCILE_SELECT_COST + RECONCILE_ROW_WORST_CASE) {
    console.log(JSON.stringify({ level: "warn", event: "settlement_reconcile_deferred", reserved_cost: reservedCost, budget_left: left, needed: RECONCILE_SELECT_COST + RECONCILE_ROW_WORST_CASE, reason: "no subrequest budget left for one worst-case row; unresolved payments wait for the next run" }));
    return NOTHING;
  }
  // Never more than the standing ceiling, and never more than is left today.
  const ceiling = Math.min(RECONCILE_SUBREQUEST_CEILING, left);
  const now = Date.now();
  // Oldest attempt first (acquiring a lease moves updated_at, so a row that keeps failing goes to the
  // back rather than starving the rest), skipping rows another holder is working and (F1) rows whose
  // handle another seat took after payment, which no retry can ever book.
  const { results } = await env.DB.prepare(
    `SELECT * FROM settlement_claims WHERE state IN ('pending', 'settled_unbooked') AND (leased_until IS NULL OR leased_until <= ?) AND (verdict_reason IS NULL OR verdict_reason <> ?) ORDER BY updated_at ASC, created_at ASC LIMIT ?`,
  )
    .bind(now, CLAIM_HANDLE_TAKEN, RECONCILE_BATCH_ROWS)
    .all<ClaimRow>();

  const out: ReconcileResult = { ...NOTHING, actualCost: RECONCILE_SELECT_COST };
  for (const due of results) {
    if (out.actualCost + RECONCILE_ROW_WORST_CASE > ceiling) {
      console.log(JSON.stringify({ level: "warn", event: "settlement_reconcile_shed", remaining_rows: results.length - out.examined, reason: "the next row's worst case would pass the ceiling; it waits for the next run" }));
      break;
    }
    out.examined++;
    const key = keyOfRow(due);
    const owner = `reconciler:${crypto.randomUUID()}`;
    const meter = { n: 0 };
    let fetches = 0;
    const rowEnv = metered(env, meter);
    let leased: ClaimRow | null = null;
    // A terminal write (booked, expired, refused) clears the lease in the same statement, so only
    // the other outcomes pay for a release.
    let needsRelease = true;
    let threw = false;
    try {
      leased = await acquireLease(rowEnv, key, owner, Date.now());
      if (!leased) {
        out.unchanged++;
        continue;
      }
      let working = leased;
      if (working.state === "pending") {
        const attempt = await attemptPending(rowEnv, working, owner);
        fetches += attempt.fetches;
        if (attempt.kind !== "settled") {
          if (attempt.kind === "expired" || attempt.kind === "refused") {
            out.resolved++;
            needsRelease = false;
          } else out.unchanged++;
          continue;
        }
        working = attempt.row;
      }
      if (await finishBooking(rowEnv, working, owner)) {
        out.booked++;
        needsRelease = false;
      } else out.unchanged++;
    } catch (e) {
      // One line per row failure, carrying the claim's public identity and the reason, never the
      // authorisation body (B7); a failing row never stops the rows after it (B6a).
      threw = true;
      out.failed++;
      console.log(
        JSON.stringify({
          level: "error",
          event: "settlement_reconcile_row_failed",
          route: due.route,
          state: due.state,
          tx: due.tx,
          claim_from: due.from_addr,
          claim_nonce: due.nonce,
          reason: clipReason(e instanceof Error ? e.message : String(e)),
        }),
      );
    } finally {
      if (leased && needsRelease) {
        try {
          await releaseLease(rowEnv, key, owner);
        } catch {
          /* the lease lapses by itself at its TTL */
        }
      }
      // A row that threw mid-attempt may have made fetches it could not report: price the failure at
      // the row's worst case for fetches (4 RPC + 1 settle), never below what was counted.
      if (threw && fetches === 0 && due.state === "pending") fetches = 5;
      out.actualCost += meter.n + fetches;
    }
  }
  return out;
}
