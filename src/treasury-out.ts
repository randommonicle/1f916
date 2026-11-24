// Who has paid whom, served beside the treasury's address on GET /treasury and GET /api/official (Ben, 24 Nov 2026, option A). GET / says the treasury pays bounties and prizes;
// every bounty paid so far was paid by a listing's funder, and no code here can pay from the treasury. Served outside the attested template, so it mints nothing.
// A LEAF module: society.ts (officialFacts, treasury) imports it, so it imports nothing from there at runtime; the operator's handle list is passed in.

// Every sentence here that says what the code cannot do is tied to the code by test/treasury-out-d1.test.ts, which reads src/ for the key's name and for signing calls.
export const PAYMENTS_OUT_NOTE =
  "Listing bounties and the treasury are separate. A listing bounty is paid by the listing's funder straight to the reviewer's wallet and never enters or leaves the treasury (GET /api/listings/payments). " +
  "No code in this service can send money from the treasury address: POST /api/payout records a transfer and does not make one. " +
  "The script that makes the treasury key (scripts/put-treasury-key.mjs) generates it in memory and stores it only as a write-only Worker secret, and by the operator's statement of 24 November 2026 the operator holds no copy of it anywhere else; that this is how the key was made, and that no copy exists, cannot be checked from outside. " +
  "So where GET / says the treasury pays bounties and prizes, or describes a dividend and a split, it describes powers and rules: paying any of them from this address first needs payout code to be written and deployed, which whoever deploys this Worker could do. " +
  "The counts are read from the two books for this response. They say what was recorded; GET /treasury's onchain_cents and each payment's tx are where to check what moved.";

export interface PaymentsOut {
  from_treasury: { recorded_payouts: number; total_cents: number; code_can_pay: false; book: string };
  listing_bounties: { paid: number; total_cents: number; operator_controlled_funders: { paid: number; total_cents: number }; book: string };
  note: string;
}

export async function paymentsOut(db: D1Database, operatorHandles: readonly string[]): Promise<PaymentsOut> {
  // One statement, so the two books are one reading.
  const marks = operatorHandles.map(() => "?").join(", ");
  const isOperator = `CASE WHEN c.handle IN (${marks}) THEN 1 ELSE 0 END`;
  const row = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM payouts) AS payouts_n,
              (SELECT COALESCE(SUM(amount_cents), 0) FROM payouts) AS payouts_cents,
              COUNT(*) AS n,
              COALESCE(SUM(p.amount_cents), 0) AS cents,
              COALESCE(SUM(p.op), 0) AS op_n,
              COALESCE(SUM(p.op * p.amount_cents), 0) AS op_cents
         FROM (SELECT lp.amount_cents AS amount_cents, ${isOperator} AS op
                 FROM listing_payments lp LEFT JOIN listings l ON l.id = lp.listing_id LEFT JOIN citizens c ON c.id = l.funder_citizen_id) p`,
    )
    .bind(...operatorHandles)
    .first<{ payouts_n: number; payouts_cents: number; n: number; cents: number; op_n: number; op_cents: number }>();
  if (!row) throw new Error("payments_out: an aggregate query answered no row");
  return {
    from_treasury: { recorded_payouts: row.payouts_n, total_cents: row.payouts_cents, code_can_pay: false, book: "GET /payouts" },
    listing_bounties: {
      paid: row.n,
      total_cents: row.cents,
      operator_controlled_funders: { paid: row.op_n, total_cents: row.op_cents },
      book: "GET /api/listings/payments",
    },
    note: PAYMENTS_OUT_NOTE,
  };
}
