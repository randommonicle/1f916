// Shared fixture for the option B tests (test/refused-option-b-d1.test.ts, test/refused-option-b-expiry-d1.test.ts): ONE way to drive each of the four paid doors with the
// identical request over and over (the same signed authorisation), on the real router or the real handlers over real local D1, with only `fetch` stubbed.

import { insertCitizen, insertListing, insertSubmission } from "./local-d1.ts";
import { declareTestWallet } from "./wallet-pin.ts";
import { atomicFromCents } from "./x402-payload.ts";
import {
  TEST_PAYER,
  TREASURY_ADDRESS,
  TX,
  callWorker,
  claimRows,
  json,
  patronReq,
  paymentHeaderFor,
  realPublicKey,
  registerReq,
  testEnv,
  type Env,
  type LocalD1,
} from "./settlement-harness.ts";
import assert from "node:assert/strict";
import { computeListingFeeCents, handleCreateListing, handlePayListing } from "../../src/listings.ts";
import type { ClaimRoute, ClaimRow } from "../../src/settlement-claims.ts";

export {
  TEST_PAYER,
  TREASURY_ADDRESS,
  TX,
  callWorker,
  captureLog,
  chainRpc,
  claimRows,
  count,
  createLocalD1,
  eventLines,
  json,
  paymentHeaderFor,
  stubFacilitator,
  testEnv,
} from "./settlement-harness.ts";
export type { Env, LocalD1 } from "./settlement-harness.ts";

const eq = (d1: LocalD1): Env => testEnv(d1);

export const jsonOk = (o: unknown): Response => new Response(JSON.stringify(o), { status: 200, headers: { "content-type": "application/json" } });
export const refusedAnswer = (reason = "insufficient_funds") => jsonOk({ success: false, errorReason: reason });
export const settledAnswer = () => jsonOk({ success: true, payer: TEST_PAYER, transaction: TX });
// The facilitator's words as classifySettle rule 7 builds them, typed here rather than imported, so a change to the served wording fails these tests instead of passing them.
export const hubRefusal = (status: number, reason: string) => `The facilitator reports that this settlement failed (HTTP ${status}, reason: ${reason}). By its account no money moved.`;

// ---------- one fixture for the four routes ----------

export const BOUNTY = 1200;
export const REVIEWER_WALLET = "0x" + "0a".repeat(20);
export const loadCitizen = (d1: LocalD1, id: number) =>
  d1.raw.prepare("SELECT id, handle, model, karma, created_at, last_seen_at FROM citizens WHERE id = ?").get(id) as { id: number; handle: string; model: string; karma: number; created_at: number; last_seen_at: number };

export interface Answer {
  status: number;
  body: Record<string, any>;
}
export interface RouteFx {
  route: ClaimRoute;
  header: string;
  // The identical request, over and over (the same signed authorisation).
  send: (env?: Env) => Promise<Answer>;
  // The listing a listing_pay request reserves (undefined on the other routes).
  listing?: () => { status: string; paying_since: number | null; paying_wallet_row_id: number | null };
}

// handlePayListing and handleCreateListing are called directly (no router), so a SocietyError surfaces as a throw; this reads either shape as { status, body }.
export async function answerOf(fn: () => Promise<Response>): Promise<Answer> {
  try {
    const res = await fn();
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  } catch (e) {
    const err = e as { status?: number; message?: string; code?: string };
    return { status: err.status ?? 0, body: { error: err.message ?? String(e), code: err.code } };
  }
}

export async function routeFx(d1: LocalD1, route: ClaimRoute, opts: { validBefore?: string; secretMode?: boolean } = {}): Promise<RouteFx> {
  const over = opts.validBefore ? { validBefore: opts.validBefore } : {};
  switch (route) {
    case "register": {
      const header = paymentHeaderFor(TREASURY_ADDRESS, "1000000", over);
      const publicKey = opts.secretMode ? undefined : await realPublicKey();
      const body = { handle: "refused-seat", model: "m", ...(publicKey ? { public_key: publicKey } : {}) };
      return { route, header, send: async (env = eq(d1)) => { const r = await callWorker(registerReq(body, header), env); return { status: r.status, body: await json(r) }; } };
    }
    case "patron": {
      const header = paymentHeaderFor(TREASURY_ADDRESS, "1000000", over);
      return { route, header, send: async (env = eq(d1)) => { const r = await callWorker(patronReq("rent", header), env); return { status: r.status, body: await json(r) }; } };
    }
    case "listing_create": {
      const funder = loadCitizen(d1, insertCitizen(d1));
      const body = {
        title: "Review my auth middleware",
        description: "Stuck on token refresh, please review for race conditions",
        acceptance_condition: "a reviewer identifies at least one real correctness issue or confirms none exist",
        bounty_cents: 1000,
        expires_at: Date.now() + 7 * 86_400_000,
      };
      const header = paymentHeaderFor(TREASURY_ADDRESS, atomicFromCents(computeListingFeeCents(1000)), over);
      return {
        route,
        header,
        send: (env = eq(d1)) => answerOf(() => handleCreateListing(new Request("https://example.test/api/listing", { method: "POST", headers: { "Content-Type": "application/json", "X-PAYMENT": header }, body: JSON.stringify(body) }), env, funder)),
      };
    }
    case "listing_pay": {
      const funderId = insertCitizen(d1);
      const reviewerId = insertCitizen(d1);
      const pin = await declareTestWallet(d1, reviewerId, REVIEWER_WALLET);
      const listingId = insertListing(d1, { funder_citizen_id: funderId, bounty_cents: BOUNTY });
      const submissionId = insertSubmission(d1, { listing_id: listingId, citizen_id: reviewerId });
      const funder = loadCitizen(d1, funderId);
      const header = paymentHeaderFor(REVIEWER_WALLET, atomicFromCents(BOUNTY), over);
      return {
        route,
        header,
        send: (env = eq(d1)) =>
          answerOf(() =>
            handlePayListing(
              new Request(`https://example.test/api/listing/${listingId}/pay`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "X-PAYMENT": header },
                body: JSON.stringify({ submission_id: submissionId, wallet_row_id: pin.id, wallet_row_hash: pin.hash }),
              }),
              env,
              funder,
              listingId,
            ),
          ),
        listing: () => d1.raw.prepare("SELECT status, paying_since, paying_wallet_row_id FROM listings WHERE id = ?").get(listingId) as { status: string; paying_since: number | null; paying_wallet_row_id: number | null },
      };
    }
  }
}

export const theClaim = (d1: LocalD1): ClaimRow => {
  const rows = claimRows(d1);
  assert.equal(rows.length, 1, "exactly one claim row");
  return rows[0] as unknown as ClaimRow;
};
export const ROUTES: ClaimRoute[] = ["register", "patron", "listing_create", "listing_pay"];
