// Who has paid whom, served beside the treasury's address on GET /treasury and GET /api/official (Ben, 24 Nov 2026, option A). GET / says the treasury pays bounties and prizes;
// every bounty paid so far was paid by a listing's funder, and no code here can pay from the treasury. Served outside the attested template, so it mints nothing.
// A LEAF module: society.ts imports it, so it imports nothing from there at runtime; the operator's wallet is passed in.

// test/treasury-out-d1.test.ts pins this text, and reads src/ for the key's name and for signing calls: if either appears, the "published source" sentence has to change with it.
export const PAYMENTS_OUT_NOTE =
  "Listing bounties and the treasury are separate. A listing bounty is paid straight to the reviewer's declared wallet, by whoever signs the payment for the listing's funder, and no route here holds it in the treasury or forwards it from there (GET /api/listings/payments). A reviewer could declare the treasury's own address as theirs: POST /api/wallet does not refuse it. " +
  "paid_from_operator_wallet counts the payments whose payer_address is the wallet the operator states is its own; whose wallet it is cannot be checked from the public record. " +
  "This service's published source holds no code that sends money from the treasury address; a test searches it for the key's name and for signing calls, and a signer written under other names would pass that test. POST /api/payout records a transfer and does not make one. " +
  "The script that makes the treasury key (scripts/put-treasury-key.mjs) generates it in memory and stores it only as a Worker secret, which cannot be read back through Cloudflare's dashboard or API; by the operator's statement of 24 November 2026 the operator holds no copy of it anywhere else. That this is how the key was made, that no copy exists, and that the stored secret is still there and is the key to this address cannot be checked from outside. " +
  "So where GET / says the treasury pays bounties and prizes, or describes a dividend and a split, it describes powers and rules. If no other copy of the key exists, paying any of them from this address first needs payout code to be written and deployed by whoever deploys this Worker, today the operator; code deployed there can read a Worker secret. " +
  "The counts cover every row of the two books, read for this response; GET /payouts and GET /api/listings/payments each serve the newest 200. They say what was recorded: what moved is the treasury address's transfer history on Base, and each payment's tx.";

export interface PaymentsOut {
  from_treasury: { recorded_payouts: number; total_cents: number; code_can_pay: false; book: string };
  listing_bounties: { paid: number; total_cents: number; paid_from_operator_wallet: { paid: number; total_cents: number; wallet: string }; book: string };
  note: string;
}

// One statement, so the two books are one reading.
export async function paymentsOut(db: D1Database, operatorWallet: string): Promise<PaymentsOut> {
  const wallet = operatorWallet.toLowerCase();
  const row = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM payouts) AS payouts_n,
              (SELECT COALESCE(SUM(amount_cents), 0) FROM payouts) AS payouts_cents,
              COUNT(*) AS n,
              COALESCE(SUM(amount_cents), 0) AS cents,
              COALESCE(SUM(lower(payer_address) = ?), 0) AS op_n,
              COALESCE(SUM((lower(payer_address) = ?) * amount_cents), 0) AS op_cents
         FROM listing_payments`,
    )
    .bind(wallet, wallet)
    .first<{ payouts_n: number; payouts_cents: number; n: number; cents: number; op_n: number; op_cents: number }>();
  if (!row) throw new Error("payments_out: an aggregate query answered no row");
  return {
    from_treasury: { recorded_payouts: row.payouts_n, total_cents: row.payouts_cents, code_can_pay: false, book: "GET /payouts" },
    listing_bounties: {
      paid: row.n,
      total_cents: row.cents,
      paid_from_operator_wallet: { paid: row.op_n, total_cents: row.op_cents, wallet },
      book: "GET /api/listings/payments",
    },
    note: PAYMENTS_OUT_NOTE,
  };
}
