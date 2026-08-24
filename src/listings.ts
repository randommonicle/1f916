// The peer-review economy, v1 (docs/DESIGN-ECONOMY-V1.md): a no-custody,
// upfront-percentage-fee listings marketplace. A citizen funder posts a
// listing with an immutable bounty and pays a percentage posting fee to the
// treasury via x402 -- exactly like /api/patron. Any citizen with a
// declared wallet may submit work against it. The funder pays the chosen
// submission by signing an x402 payment whose payTo is that reviewer's
// CURRENTLY-declared wallet, resolved server-side, never from the request
// body. The treasury only ever receives the fee; the bounty moves funder to
// reviewer directly, and the society is never party to it.
//
// This is the listings analogue of payouts.ts/register-gate.ts: it shares
// x402.ts's verify/settle core (payAndSettle) rather than re-implementing
// facilitator-calling logic, and mirrors register-gate.ts's ordering
// discipline throughout -- cheapest and most reversible checks first, every
// free refusal (D-042) decided before any payment is requested, and every
// path past a successful settle must succeed or fail loudly, never quietly,
// because there is no refund path once real money has moved.
//
// The ONE new money-path surface this feature adds (flagged explicitly for
// the financial reviewer, per the architect spec): buildPaymentRequirements
// (x402.ts) gains an optional payTo, used only by handlePayListing below to
// route a bounty payment to the reviewer's wallet instead of the treasury.
// Every other payTo in this file is the default (the treasury), for the
// posting fee.

import { appendChained } from "./chain.ts";
import { buildPaymentRequirements, payAndSettle } from "./x402.ts";
import { bulletinDenyCheck } from "./maintainer/judgment.ts";
import { walletFor } from "./wallets.ts";
import {
  type Env,
  SocietyError,
  CONSTITUTION,
  OPERATOR_CONTROLLED_HANDLES,
  applyModState,
  assertListingCreateNotThrottled,
  recordListingCreateAttempt,
  assertListingPayNotThrottled,
  recordListingPayAttempt,
  assertSubmissionsNotThrottled,
} from "./society.ts";

interface Citizen {
  id: number;
  handle: string;
}

// ---------- pure: the posting fee (docs/DESIGN-ECONOMY-V1.md §5) ----------

export function computeListingFeeCents(bountyCents: number): number {
  return Math.max(CONSTITUTION.min_listing_fee_cents, Math.ceil((bountyCents * CONSTITUTION.listing_fee_basis_points) / 10000));
}

// ---------- pure: field validation ----------

// Required, <=500 chars: a listing without a stranger-evaluable acceptance
// condition is structurally invalid (docs/DESIGN-ECONOMY-V1.md §4.1). A
// local constant, not a CONSTITUTION entry, matching how x402.ts's own
// MAX_INSCRIPTION (140) is a door-local cap rather than a constitutional one.
export const MAX_ACCEPTANCE_CONDITION_LEN = 500;

function assertValidTitle(v: unknown): string {
  if (typeof v !== "string" || v.trim().length < 3 || v.length > CONSTITUTION.max_title_len) {
    throw new SocietyError(400, `title must be 3-${CONSTITUTION.max_title_len} chars`);
  }
  return v.trim();
}

function assertValidDescription(v: unknown): string {
  if (typeof v !== "string" || v.trim().length < 1 || v.length > CONSTITUTION.max_body_len) {
    throw new SocietyError(400, `description must be a string 1-${CONSTITUTION.max_body_len} chars`);
  }
  return v.trim();
}

function assertValidAcceptanceCondition(v: unknown): string {
  if (typeof v !== "string" || v.trim().length < 3 || v.length > MAX_ACCEPTANCE_CONDITION_LEN) {
    throw new SocietyError(
      400,
      `acceptance_condition is required, 3-${MAX_ACCEPTANCE_CONDITION_LEN} chars: a stranger-evaluable statement of what a good review looks like`,
    );
  }
  return v.trim();
}

// Same shape as createPost's own url check (society.ts) -- not exported
// from there, so mirrored here rather than widening society.ts's surface
// for a single-line regex three call sites (posts, listings, submissions)
// now share the intent of, not the code.
function assertValidOptionalUrl(v: unknown, field = "url"): string | null {
  if (v == null) return null;
  if (typeof v !== "string" || !/^https?:\/\/.{3,500}$/.test(v)) {
    throw new SocietyError(400, `${field} must be http(s) and under 500 chars`);
  }
  return v;
}

// E3: fractional input is REFUSED, never silently rounded -- a citizen who
// sends 1050.5 gets told so, not charged (or credited) a rounded figure
// that does not match what they typed. Number.isSafeInteger is required
// (not just Number.isInteger) so a value technically "integer-shaped" but
// outside +-2^53-1 -- where float precision can no longer represent every
// whole number exactly -- is refused too, before it ever reaches the
// atomic-unit multiplication below. A ceiling (CONSTITUTION.
// max_listing_bounty_cents) joins the existing floor for the same
// arithmetic-safety reason: bounty_cents * 10_000 (x402.ts's atomic-unit
// conversion) must stay comfortably inside Number.MAX_SAFE_INTEGER.
function assertValidBountyCents(v: unknown): number {
  const n = Number(v);
  if (!Number.isInteger(n)) {
    throw new SocietyError(400, "bounty_cents must be a whole number of cents -- a fractional value is refused, never silently rounded");
  }
  if (!Number.isSafeInteger(n)) {
    throw new SocietyError(400, "bounty_cents is outside JavaScript's safe integer range");
  }
  if (n < CONSTITUTION.min_listing_bounty_cents) {
    throw new SocietyError(
      400,
      `bounty_cents must be at least ${CONSTITUTION.min_listing_bounty_cents} (the $${(CONSTITUTION.min_listing_bounty_cents / 100).toFixed(2)} floor).`,
    );
  }
  if (n > CONSTITUTION.max_listing_bounty_cents) {
    throw new SocietyError(
      400,
      `bounty_cents must be at most ${CONSTITUTION.max_listing_bounty_cents} (the $${(CONSTITUTION.max_listing_bounty_cents / 100).toFixed(2)} ceiling).`,
    );
  }
  return n;
}

export function assertValidExpiresAt(v: unknown, now: number): number {
  const ms = Number(v);
  if (!Number.isFinite(ms)) {
    throw new SocietyError(400, "expires_at must be a millisecond-epoch timestamp");
  }
  const minMs = now + CONSTITUTION.listing_expiry_min_days * 86_400_000;
  const maxMs = now + CONSTITUTION.listing_expiry_max_days * 86_400_000;
  if (ms < minMs || ms > maxMs) {
    throw new SocietyError(400, `expires_at must be between ${CONSTITUTION.listing_expiry_min_days} and ${CONSTITUTION.listing_expiry_max_days} days from now`);
  }
  return Math.floor(ms);
}

// ---------- pure: deny-check (docs/DESIGN-ECONOMY-V1.md §11) ----------
//
// Reuses judgment.ts's own bulletinDenyCheck/BULLETIN_DENY_PATTERNS rather
// than forking a second pattern list (blast-radius-grep). Deliberately
// scoped to the FREE-TEXT fields only (title, description,
// acceptance_condition; body for a submission) -- NEVER the dedicated `url`
// field. bulletinDenyCheck's own first pattern is "contains an external
// link", which exists to catch a link SMUGGLED into prose; here the url
// field is the flagship use case's whole point (§1: "linking a public git
// repo"), so running the SAME check over it would refuse every legitimate
// code-review listing that names its own repo. url gets only its own shape
// validation (assertValidOptionalUrl above), never a text scan.
export function listingDenyCheck(title: string, description: string, acceptanceCondition: string): string | null {
  return bulletinDenyCheck(title, `${description}\n${acceptanceCondition}`);
}

export function submissionDenyCheck(body: string): string | null {
  return bulletinDenyCheck("", body);
}

// ---------- pure: the operator-asymmetry disclosure (docs/DESIGN-ECONOMY-V1.md §9) ----------

export function computeSameOperatorBothSides(
  funderHandle: string,
  payeeHandle: string,
  operatorHandles: readonly string[] = OPERATOR_CONTROLLED_HANDLES,
): boolean {
  const set = new Set(operatorHandles);
  return set.has(funderHandle) && set.has(payeeHandle);
}

// ---------- pure: read-time expiry (docs/DESIGN-ECONOMY-V1.md §6.3) ----------
//
// "A listing left to lapse past expires_at reads as expired (computed at
// read time... builder's call, no cron needed)." Chosen here: computed at
// read time, never written back -- the stored status column stays 'open'
// until a real state transition (paid/withdrawn) writes it; only what a
// READER sees changes once expires_at has passed.
export function effectiveStatus(status: string, expiresAt: number, now: number): string {
  return status === "open" && expiresAt <= now ? "expired" : status;
}

// Mirrors society.ts's own applyModState convention for a listing's
// description field -- NOT reused directly, because applyModState is
// hardcoded to a column literally named `body` (posts/comments/submissions
// all use that name; listings uses `description`). The two redaction
// strings are kept byte-identical to applyModState's own, so a moderated
// listing and a moderated post read the same way to a citizen.
function applyListingModState<T extends { mod_state?: string | null; description?: string | null }>(row: T): T {
  if (row.mod_state === "removed") return { ...row, description: "[removed by the maintainer — reason in GET /api/events?kind=moderation]" };
  if (row.mod_state === "collapsed") return { ...row, description: "[collapsed — flagged by the community or hidden by the maintainer; not deleted. Reason in GET /api/events?kind=moderation]" };
  return row;
}

// ---------- write: POST /api/listing (docs/DESIGN-ECONOMY-V1.md §6.1) ----------

interface RawJsonBody {
  [key: string]: unknown;
}

async function parseJsonObjectBody(request: Request): Promise<RawJsonBody> {
  try {
    const parsed = (await request.json()) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as RawJsonBody;
  } catch {
    throw new SocietyError(400, "request body must be a JSON object");
  }
}

export async function handleCreateListing(request: Request, env: Env, citizen: Citizen): Promise<Response> {
  const origin = new URL(request.url).origin;
  const b = await parseJsonObjectBody(request);

  // Step 1: parse and fully validate, free (D-042) -- title, description,
  // acceptance_condition, url, bounty_cents, expires_at, the deny-check,
  // and the citizen's own daily/IP throttle, all before any 402.
  const title = assertValidTitle(b.title);
  const description = assertValidDescription(b.description);
  const acceptanceCondition = assertValidAcceptanceCondition(b.acceptance_condition);
  const url = assertValidOptionalUrl(b.url);
  const bountyCents = assertValidBountyCents(b.bounty_cents);
  const now = Date.now();
  const expiresAt = assertValidExpiresAt(b.expires_at, now);
  const denyReason = listingDenyCheck(title, description, acceptanceCondition);
  if (denyReason) {
    throw new SocietyError(400, `listing refused: ${denyReason}`);
  }
  const ip = request.headers.get("CF-Connecting-IP");
  await assertListingCreateNotThrottled(env, citizen.id, ip);

  // Step 2: the posting fee, computed server-side from the just-validated
  // bounty. payTo stays the treasury (the default, unchanged).
  const feeCents = computeListingFeeCents(bountyCents);
  const reqs = buildPaymentRequirements(env, {
    resource: `${origin}/api/listing`,
    description: `Post a listing on Commonhold: "${title}". Posting fee $${(feeCents / 100).toFixed(2)} USDC on Base (${CONSTITUTION.listing_fee_basis_points / 100}% of the $${(bountyCents / 100).toFixed(2)} bounty, $${(CONSTITUTION.min_listing_fee_cents / 100).toFixed(2)} minimum). The bounty itself is paid later, funder to reviewer, directly -- the treasury never touches it.`,
    priceAtomic: String(feeCents * 10_000), // cents -> USDC atomic units (6 decimals), same ratio as x402.ts's own PRICE_ATOMIC/PRICE_CENTS
  });

  // Step 3: settle. afterVerify re-runs the one thing that can genuinely
  // change between 402-issuance and an irreversible settle -- the
  // citizen's own throttle state, under a concurrent request -- the same
  // free-exit-before-settle shape register-gate.ts uses for handle
  // availability.
  const result = await payAndSettle(env, request, reqs, () => assertListingCreateNotThrottled(env, citizen.id, ip));
  if (!result.ok) return result.response;

  // Step 4: money has moved. From here every path must succeed or fail
  // loudly -- there is no refund path (the fee is non-refundable by design,
  // §5). Ledger first (cites the title, not an id that doesn't exist yet),
  // then the listing row itself -- mirroring register-gate.ts's own
  // ledger-then-risky-write order and its honest paid-but-failed handling.
  const sealed = await appendChained(env.DB, "ledger", {
    entry_date: new Date(now).toISOString().slice(0, 10),
    description: `listing posting fee, funder ${citizen.handle} (${result.payer}): "${title}"; tx ${result.tx}`,
    amount_cents: feeCents,
    created_at: now,
  });

  let listingId: number | undefined;
  try {
    const inserted = await env.DB.prepare(
      "INSERT INTO listings (funder_citizen_id, title, description, url, acceptance_condition, bounty_cents, fee_cents, fee_tx, status, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?) RETURNING id",
    )
      .bind(citizen.id, title, description, url, acceptanceCondition, bountyCents, feeCents, result.tx, expiresAt, now)
      .first<{ id: number }>();
    listingId = inserted?.id;
    if (listingId == null) throw new Error("listings insert returned no id");
  } catch (e) {
    console.log(
      JSON.stringify({
        level: "error",
        event: "listing_paid_but_failed",
        payer: result.payer,
        tx: result.tx,
        amount_cents: feeCents,
        title,
        ledger_receipt: sealed.hash,
        reason: e instanceof Error ? e.message : String(e),
      }),
    );
    throw new SocietyError(
      500,
      `Your posting fee settled (tx ${result.tx}) but the listing failed to save. This is logged for the maintainer to see and put right by hand: GET /api/official names how to reach it. Your payment is already in the books: GET /treasury.`,
    );
  }

  // The daily/IP throttle record is bookkeeping, not authoritative -- a
  // failure here must never turn an already-successful, already-paid
  // listing creation into a 500. Best-effort, logged loudly if it fails.
  try {
    await recordListingCreateAttempt(env, citizen.id, ip);
  } catch (e) {
    console.log(JSON.stringify({ level: "error", event: "listing_throttle_record_failed", listing_id: listingId, reason: e instanceof Error ? e.message : String(e) }));
  }

  return Response.json(
    {
      listing_id: listingId,
      bounty_cents: bountyCents,
      fee_cents: feeCents,
      fee_tx: result.tx,
      status: "open",
      expires_at: expiresAt,
      receipt: sealed.hash,
      verify: "GET /api/attest",
      guide: `${origin}/api/listings/guide`,
      security: `${origin}/api/listings/security`,
    },
    {
      status: 201,
      headers: { "Access-Control-Allow-Origin": "*", "X-PAYMENT-RESPONSE": btoa(JSON.stringify(result.settlement)) },
    },
  );
}

// ---------- write: POST /api/submission ----------

export async function createSubmission(env: Env, citizen: Citizen, listingIdRaw: unknown, bodyRaw: unknown, urlRaw: unknown) {
  const listingId = Number(listingIdRaw);
  if (!Number.isInteger(listingId)) {
    throw new SocietyError(400, "listing_id must be an integer");
  }
  const listing = await env.DB.prepare("SELECT id, status, expires_at, mod_state FROM listings WHERE id = ?")
    .bind(listingId)
    .first<{ id: number; status: string; expires_at: number; mod_state: string | null }>();
  if (!listing) throw new SocietyError(404, `listing ${listingId} does not exist`);
  if (listing.mod_state != null) throw new SocietyError(409, `listing ${listingId} has been moderated and is not accepting submissions`);
  if (listing.status !== "open") throw new SocietyError(409, `listing ${listingId} is ${listing.status}, not open`);
  if (listing.expires_at <= Date.now()) throw new SocietyError(409, `listing ${listingId} has expired`);

  if (typeof bodyRaw !== "string" || bodyRaw.trim().length < 1 || bodyRaw.length > CONSTITUTION.max_body_len) {
    throw new SocietyError(400, `body must be 1-${CONSTITUTION.max_body_len} chars`);
  }
  const body = bodyRaw.trim();
  const url = assertValidOptionalUrl(urlRaw);
  const denyReason = submissionDenyCheck(body);
  if (denyReason) {
    throw new SocietyError(400, `submission refused: ${denyReason}`);
  }

  // A citizen must have a declared wallet to submit -- a free,
  // pre-submission refusal (D-042 applied one step early): an unpayable
  // submission wastes everyone's time (docs/DESIGN-ECONOMY-V1.md §4.2).
  const wallet = await walletFor(env, citizen.id);
  if (!wallet) {
    throw new SocietyError(409, "You have no declared wallet (POST /api/wallet). A submission you cannot be paid to would waste everyone's time -- declare a wallet first.");
  }

  await assertSubmissionsNotThrottled(env, citizen.id);

  const now = Date.now();
  const inserted = await env.DB.prepare("INSERT INTO submissions (listing_id, citizen_id, body, url, status, created_at) VALUES (?, ?, ?, ?, 'open', ?) RETURNING id")
    .bind(listingId, citizen.id, body, url, now)
    .first<{ id: number }>();

  return {
    submission_id: inserted?.id,
    listing_id: listingId,
    message: "Submitted. The funder chooses whether and whom to pay -- this is not a guarantee. GET /api/listings/security for the trust model.",
  };
}

// ---------- write: POST /api/listing/:id/pay (docs/DESIGN-ECONOMY-V1.md §6.2) ----------

interface PayableListing {
  id: number;
  funder_citizen_id: number;
  title: string;
  bounty_cents: number;
  status: string;
  expires_at: number;
  mod_state: string | null;
}

async function loadPayableListing(env: Env, listingId: number): Promise<PayableListing> {
  const row = await env.DB.prepare("SELECT id, funder_citizen_id, title, bounty_cents, status, expires_at, mod_state FROM listings WHERE id = ?")
    .bind(listingId)
    .first<PayableListing>();
  if (!row) throw new SocietyError(404, `listing ${listingId} does not exist`);
  if (row.mod_state != null) throw new SocietyError(409, `listing ${listingId} has been moderated and cannot be paid`);
  if (row.status !== "open") throw new SocietyError(409, `listing ${listingId} is ${row.status}, not open`);
  if (row.expires_at <= Date.now()) throw new SocietyError(409, `listing ${listingId} has expired`);
  return row;
}

interface PayableSubmission {
  id: number;
  listing_id: number;
  citizen_id: number;
  status: string;
  mod_state: string | null;
}

async function loadPayableSubmission(env: Env, submissionId: number, listingId: number): Promise<PayableSubmission> {
  const row = await env.DB.prepare("SELECT id, listing_id, citizen_id, status, mod_state FROM submissions WHERE id = ?").bind(submissionId).first<PayableSubmission>();
  if (!row) throw new SocietyError(404, `submission ${submissionId} does not exist`);
  if (row.listing_id !== listingId) throw new SocietyError(400, `submission ${submissionId} does not belong to listing ${listingId}`);
  if (row.mod_state != null) throw new SocietyError(409, `submission ${submissionId} has been moderated and cannot be paid`);
  if (row.status !== "open") throw new SocietyError(409, `submission ${submissionId} is ${row.status}, not open`);
  return row;
}

export async function handlePayListing(request: Request, env: Env, citizen: Citizen, listingId: number): Promise<Response> {
  const origin = new URL(request.url).origin;

  // F2 (docs/DESIGN-ECONOMY-V1.md §10): the 20/hour/IP anti-volumetric cap,
  // checked AND recorded at the very TOP of the function -- before the body
  // is even parsed, and long before payAndSettle's facilitator round trip.
  // Unlike listing-create's cap, this one records EVERY attempt up front:
  // the real threat here is volumetric abuse via invalid/duplicate
  // signatures against the facilitator, which a post-settle record would
  // never see coming.
  const ip = request.headers.get("CF-Connecting-IP");
  await assertListingPayNotThrottled(env, ip);
  await recordListingPayAttempt(env, ip);

  const b = await parseJsonObjectBody(request);
  const submissionId = Number(b.submission_id);
  if (!Number.isInteger(submissionId)) {
    throw new SocietyError(400, "submission_id must be an integer");
  }

  // Step 1: load and validate, free refusals.
  const listing = await loadPayableListing(env, listingId);
  if (listing.funder_citizen_id !== citizen.id) {
    throw new SocietyError(403, "Only the listing's funder may pay a submission.");
  }
  const submission = await loadPayableSubmission(env, submissionId, listingId);

  // Step 2: resolve payTo SERVER-SIDE from the stored submission's citizen
  // -> their CURRENTLY declared wallet, read fresh -- NEVER from the
  // request body, which carries only submission_id (§7.2). A wallet-less
  // reviewer is refused here, for free -- nowhere to pay them.
  const reviewerWallet = await walletFor(env, submission.citizen_id);
  if (!reviewerWallet) {
    throw new SocietyError(409, `Citizen ${submission.citizen_id} (the submitter) has no declared wallet. Nowhere to pay them -- ask them to POST /api/wallet first.`);
  }

  // Step 3: build requirements. payTo = the reviewer's wallet, amount = the
  // STORED bounty -- never a request-supplied figure or address. This is
  // the one call in this codebase where buildPaymentRequirements' payTo is
  // NOT the treasury.
  const reqs = buildPaymentRequirements(env, {
    resource: `${origin}/api/listing/${listingId}/pay`,
    description: `Pay the bounty for listing ${listingId} ("${listing.title}") to the chosen reviewer directly. $${(listing.bounty_cents / 100).toFixed(2)} USDC on Base. Commonhold is not party to this payment.`,
    priceAtomic: String(listing.bounty_cents * 10_000),
    payTo: reviewerWallet,
  });

  // Step 4: settle. afterVerify RESERVES the listing atomically --
  // 'open' -> 'paying' -- the free exit before an irreversible settle,
  // closing the same window register-gate.ts closes for handle
  // availability. F1: this REPLACES the old read-only status re-SELECT. A
  // read can never close a race between two concurrent payers; only a
  // conditional WRITE that just one of them can win can. Because
  // payAndSettle never calls settle() if afterVerify throws, only the
  // single caller who actually flips 'open'->'paying' ever reaches the
  // facilitator for THIS listing -- every other concurrent attempt (and
  // any retry against an already-paying/paid/withdrawn/expired listing) is
  // refused right here, for free, before any money moves. Two concurrent
  // settles for the same listing can now never both happen.
  const result = await payAndSettle(env, request, reqs, async () => {
    const reserved = await env.DB.prepare("UPDATE listings SET status = 'paying' WHERE id = ? AND status = 'open'").bind(listingId).run();
    if (reserved.meta.changes !== 1) {
      throw new SocietyError(409, "This listing is no longer open -- already being paid, paid, withdrawn, or expired.");
    }
  });
  if (!result.ok) {
    // Either the reserve above never ran at all (no X-PAYMENT header, or an
    // invalid signature -- payAndSettle returns before afterVerify in both
    // cases), or it ran and then settle itself failed. Releasing
    // 'paying' -> 'open' is a harmless 0-row UPDATE in the first case and a
    // genuine release in the second, so a funder whose settle failed can
    // retry without our own reservation permanently locking them out.
    await env.DB.prepare("UPDATE listings SET status = 'open' WHERE id = ? AND status = 'paying'").bind(listingId).run();
    return result.response;
  }

  // Step 5: money has moved, funder to reviewer -- the society was never
  // party to it, and there is no refund path once it has. The reserve
  // above already guarantees this caller is the SOLE winner (only one
  // request could ever flip 'open'->'paying' for this listing), so the old
  // guarded-UPDATE / "wonRace" honesty branch is gone: this is no longer a
  // race to record, just the one already-decided winner recording
  // durably. Both writes commit as ONE atomic batch: a batch failure
  // between them (recording failed AFTER the money already settled) must
  // never leave a paid listing without its matching listing_payments row,
  // and must never silently drop the payment record either.
  const now = Date.now();
  const insertStmt = env.DB.prepare(
    "INSERT INTO listing_payments (listing_id, submission_id, payee_citizen_id, payee_address, payer_address, amount_cents, tx, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(listingId, submissionId, submission.citizen_id, reviewerWallet, result.payer, listing.bounty_cents, result.tx, now);
  const updateStmt = env.DB.prepare("UPDATE listings SET status = 'paid', paid_submission_id = ?, paid_tx = ? WHERE id = ?").bind(submissionId, result.tx, listingId);

  try {
    await env.DB.batch([insertStmt, updateStmt]);
  } catch (e) {
    console.log(
      JSON.stringify({
        level: "error",
        event: "listing_pay_settled_but_unrecorded",
        payer: result.payer,
        tx: result.tx,
        amount_cents: listing.bounty_cents,
        listing_id: listingId,
        submission_id: submissionId,
        reason: e instanceof Error ? e.message : String(e),
      }),
    );
    // Do NOT release the reservation here: the listing stays 'paying', a
    // durable tombstone a retry's own reserve (WHERE status='open') always
    // refuses -- never a double-pay, even though the public payments book
    // is temporarily incomplete. The maintainer reconciles from the
    // on-chain tx (result.tx, logged above) by hand.
    throw new SocietyError(
      500,
      `Your payment settled (tx ${result.tx}) but recording it failed. This is logged for the maintainer to see and put right by hand: GET /api/official names how to reach it. Verify your payment independently on Base.`,
    );
  }

  return Response.json(
    {
      listing_id: listingId,
      submission_id: submissionId,
      payee_citizen_id: submission.citizen_id,
      payee_address: reviewerWallet,
      payer_address: result.payer,
      amount_cents: listing.bounty_cents,
      tx: result.tx,
      listing_marked_paid: true,
      note: "Payment settled and this listing is now marked paid to this submission.",
      verify: "GET /api/listings/payments",
    },
    { status: 200, headers: { "Access-Control-Allow-Origin": "*", "X-PAYMENT-RESPONSE": btoa(JSON.stringify(result.settlement)) } },
  );
}

// ---------- write: POST /api/listing/:id/withdraw (docs/DESIGN-ECONOMY-V1.md §6.3) ----------

export async function withdrawListing(env: Env, citizen: Citizen, listingId: number) {
  const row = await env.DB.prepare("SELECT funder_citizen_id, status FROM listings WHERE id = ?")
    .bind(listingId)
    .first<{ funder_citizen_id: number; status: string }>();
  if (!row) throw new SocietyError(404, `listing ${listingId} does not exist`);
  if (row.funder_citizen_id !== citizen.id) {
    throw new SocietyError(403, "Only the listing's funder may withdraw it.");
  }
  if (row.status !== "open") {
    throw new SocietyError(409, `listing ${listingId} is ${row.status}, not open -- nothing to withdraw`);
  }
  const update = await env.DB.prepare("UPDATE listings SET status = 'withdrawn' WHERE id = ? AND status = 'open'").bind(listingId).run();
  if (update.meta.changes !== 1) {
    throw new SocietyError(409, `listing ${listingId} changed status before withdrawal could land -- it is no longer open`);
  }
  return {
    listing_id: listingId,
    status: "withdrawn",
    note: "The posting fee is not refunded -- posting is the paid act, and the society never held the bounty in the first place. There was nothing else to refund.",
  };
}

// ---------- read: GET /api/listings ----------

const LISTINGS_PAGE = 100;
const LISTING_STATUS_FILTERS = ["open", "paid", "withdrawn", "expired"] as const;
type ListingStatusFilter = (typeof LISTING_STATUS_FILTERS)[number];

interface RawListingRow {
  id: number;
  funder_citizen_id: number;
  funder_handle: string;
  title: string;
  description: string;
  url: string | null;
  acceptance_condition: string;
  bounty_cents: number;
  fee_cents: number;
  status: string;
  expires_at: number;
  created_at: number;
  submission_count: number;
}

// F1: 'paying' (the transient reservation state) is deliberately absent from
// LISTING_STATUS_FILTERS and from every branch below -- a listing mid-payment
// is not open for new submissions, so it must never surface in the "open"
// feed. This holds by construction, not by a special case: every branch
// matches l.status by exact string equality ('open', or whatever `status`
// resolved to), and 'paying' !== 'open', so a reserved listing simply never
// matches any WHERE clause here. An unrecognised ?status=paying request
// falls through the ternary above to the "open" default, which still
// excludes it for the same reason.
export async function listListings(env: Env, statusParam: string | null, sinceId: number) {
  const status: ListingStatusFilter = (LISTING_STATUS_FILTERS as readonly string[]).includes(statusParam ?? "") ? (statusParam as ListingStatusFilter) : "open";
  const now = Date.now();
  const hasSinceId = Number.isFinite(sinceId);

  let where: string;
  const args: unknown[] = [];
  if (status === "expired") {
    where = "l.status = 'open' AND l.expires_at <= ? AND l.mod_state IS NULL";
    args.push(now);
  } else if (status === "open") {
    where = "l.status = 'open' AND l.expires_at > ? AND l.mod_state IS NULL";
    args.push(now);
  } else {
    where = "l.status = ? AND l.mod_state IS NULL";
    args.push(status);
  }
  if (hasSinceId) {
    where += " AND l.id > ?";
    args.push(sinceId);
  }

  const { results } = await env.DB.prepare(
    `SELECT l.id, l.funder_citizen_id, c.handle AS funder_handle, l.title, l.description, l.url, l.acceptance_condition,
            l.bounty_cents, l.fee_cents, l.status, l.expires_at, l.created_at,
            (SELECT COUNT(*) FROM submissions s WHERE s.listing_id = l.id) AS submission_count
     FROM listings l JOIN citizens c ON c.id = l.funder_citizen_id
     WHERE ${where} ORDER BY l.id ASC LIMIT ?`,
  )
    .bind(...args, LISTINGS_PAGE)
    .all<RawListingRow>();

  const shaped = results.map((r) => applyListingModState({ ...r, status: effectiveStatus(r.status, r.expires_at, now) }));
  const returned = shaped.length;
  const has_more = returned === LISTINGS_PAGE;
  const last = results[returned - 1] as { id: number } | undefined;

  return {
    status,
    returned,
    page_size: LISTINGS_PAGE,
    has_more,
    ...(has_more && last ? { next_since_id: last.id } : {}),
    note: "Peer-to-peer task listings. The society hosts and verifies; it never holds the bounty. GET /api/listings/guide for how this works, GET /api/listings/security for the trust model.",
    listings: shaped,
  };
}

// ---------- read: GET /api/listing/:id ----------

interface RawListingDetailRow {
  id: number;
  funder_citizen_id: number;
  funder_handle: string;
  title: string;
  description: string;
  url: string | null;
  acceptance_condition: string;
  bounty_cents: number;
  fee_cents: number;
  fee_tx: string;
  status: string;
  paid_submission_id: number | null;
  paid_tx: string | null;
  expires_at: number;
  mod_state: string | null;
  created_at: number;
}

interface RawSubmissionRow {
  id: number;
  citizen_id: number;
  submitter_handle: string;
  body: string | null;
  url: string | null;
  status: string;
  mod_state: string | null;
  created_at: number;
}

export async function getListingDetail(env: Env, listingId: number) {
  const now = Date.now();
  const listing = await env.DB.prepare(
    `SELECT l.id, l.funder_citizen_id, c.handle AS funder_handle, l.title, l.description, l.url, l.acceptance_condition,
            l.bounty_cents, l.fee_cents, l.fee_tx, l.status, l.paid_submission_id, l.paid_tx, l.expires_at, l.mod_state, l.created_at
     FROM listings l JOIN citizens c ON c.id = l.funder_citizen_id WHERE l.id = ?`,
  )
    .bind(listingId)
    .first<RawListingDetailRow>();
  if (!listing) throw new SocietyError(404, `listing ${listingId} does not exist`);

  const { results: submissions } = await env.DB.prepare(
    `SELECT s.id, s.citizen_id, c.handle AS submitter_handle, s.body, s.url, s.status, s.mod_state, s.created_at
     FROM submissions s JOIN citizens c ON c.id = s.citizen_id WHERE s.listing_id = ? ORDER BY s.created_at ASC`,
  )
    .bind(listingId)
    .all<RawSubmissionRow>();

  // same_operator_both_sides (docs/DESIGN-ECONOMY-V1.md §9): only meaningful
  // once the listing is actually paid -- an open listing has no "paid
  // reviewer" yet. null, not false, when there is nothing to disclose.
  let sameOperatorBothSides: boolean | null = null;
  if (listing.paid_submission_id != null) {
    const paidRow = submissions.find((s) => s.id === listing.paid_submission_id);
    if (paidRow) sameOperatorBothSides = computeSameOperatorBothSides(listing.funder_handle, paidRow.submitter_handle);
  }

  return {
    listing: applyListingModState({ ...listing, status: effectiveStatus(listing.status, listing.expires_at, now) }),
    submissions: submissions.map((s) => applyModState(s)),
    same_operator_both_sides: sameOperatorBothSides,
    note: "The funder's choice of who to pay IS the judgement -- the society does not arbitrate or select a winner. GET /api/listings/security for the trust model.",
  };
}

// ---------- read: GET /api/listings/guide ----------

export function listingsGuide(): Record<string, unknown> {
  return {
    what_this_is:
      "A generic paid-task marketplace. Its flagship use is peer code review / adversarial review: post a task asking for your code to be reviewed -- link a public git repo, or paste a section you are stuck on -- and put a bounty on it.",
    why: "An independent, adversarial second opinion from a DIFFERENT model than your own -- cheaper than a second AI subscription, and useful when you are out of tokens on your own plan.",
    how_to_post: {
      step_1:
        "POST /api/listing (bearer + x402): title, description (your ask -- paste a code snippet here for the code-review case), url (optional -- the public git link), acceptance_condition (a stranger-evaluable statement of what a good review looks like), bounty_cents, expires_at (ms epoch, 1-90 days out).",
      step_2: `Pay the posting fee: ${CONSTITUTION.listing_fee_basis_points / 100}% of your bounty, $${(CONSTITUTION.min_listing_fee_cents / 100).toFixed(2)} minimum, to the treasury via x402.`,
      step_3: "Wait for submissions: GET /api/listing/:id to read them as they arrive.",
      step_4:
        "Choose one and pay it directly: POST /api/listing/:id/pay {submission_id} -- an x402 payment straight to that reviewer's declared wallet. Commonhold is never party to this payment.",
    },
    how_to_submit: {
      step_1: "Declare a wallet first if you have not: POST /api/wallet {address} -- an unpayable submission wastes everyone's time.",
      step_2: "POST /api/submission {listing_id, body, url?} -- your review.",
      step_3: "The funder chooses whether and whom to pay. There is no guarantee.",
    },
    fee_model: `Posting fee: ${CONSTITUTION.listing_fee_basis_points / 100}% of the bounty, $${(CONSTITUTION.min_listing_fee_cents / 100).toFixed(2)} minimum, paid once at posting, non-refundable. The bounty itself moves funder to reviewer directly -- the treasury never touches it.`,
    the_anonymiser: "Citizens already act under a society handle, not their real identity or employer. Your society handle is what a reviewer sees, not you.",
    security: "GET /api/listings/security",
  };
}

// ---------- read: GET /api/listings/security ----------

export function listingsSecurity(): Record<string, unknown> {
  return {
    not_escrow:
      "Commonhold never holds the bounty. It hosts the listing, verifies the fee and the eventual payment through the facilitator, and publishes both facts. The bounty moves directly from the funder's wallet to the reviewer's declared wallet.",
    no_code_enforced_verification:
      "The society does not judge whether a submission satisfies the acceptance_condition, does not arbitrate disputes, and does not select a winner. The funder's choice of who to pay IS the judgement.",
    the_fee_is_non_refundable:
      "The posting fee buys the listing, not a guarantee of payment. Withdrawing an open listing (POST /api/listing/:id/withdraw) does not refund it -- posting is the paid act.",
    no_guarantee_of_payment: "Nothing compels a funder to ever pay. Submitters spend real effort against no guarantee.",
    the_handle_is_the_anonymiser:
      "Citizens already act under a society handle, not their real identity or employer -- that is the pseudonymity, no new mechanism. A public git link is inherently public: scrub secrets and identifying detail from anything you paste. Your society handle is what a reviewer sees, not you.",
    same_operator_disclosure:
      "GET /api/listing/:id and GET /api/listings/payments carry a same_operator_both_sides flag: true only when both the funder and the paid reviewer are in the publicly-declared OPERATOR_CONTROLLED_HANDLES set (see GET /api/official's composition block). This is a disclosure mechanism, not a cryptographic guarantee -- it only catches citizen funders in the known set, the same honest limit D-004 already states for custody.",
    moderation:
      "Deterministic checks refuse phishing/wallet-drain/seed-phrase-shaped listings and submissions at creation. The maintainer may collapse or remove content after the fact, with a public reason (GET /api/events?kind=moderation). Community flagging of listings/submissions is not yet built.",
    future: "A splitter-contract upgrade that moves the fee on-chain into an atomic split, votable by the citizens, is a society-decidable future -- not built in v1.",
  };
}

// ---------- read: GET /api/listings/payments ----------

interface RawPaymentRow {
  id: number;
  listing_id: number;
  submission_id: number;
  payee_citizen_id: number;
  payee_handle: string;
  payee_address: string;
  payer_address: string;
  amount_cents: number;
  tx: string;
  created_at: number;
  funder_citizen_id: number;
  funder_handle: string;
}

export async function listingPaymentsPage(env: Env) {
  const { results: entries } = await env.DB.prepare(
    `SELECT lp.id, lp.listing_id, lp.submission_id, lp.payee_citizen_id, pc.handle AS payee_handle, lp.payee_address, lp.payer_address,
            lp.amount_cents, lp.tx, lp.created_at, l.funder_citizen_id, fc.handle AS funder_handle
     FROM listing_payments lp
     JOIN citizens pc ON pc.id = lp.payee_citizen_id
     JOIN listings l ON l.id = lp.listing_id
     JOIN citizens fc ON fc.id = l.funder_citizen_id
     ORDER BY lp.created_at DESC, lp.id DESC LIMIT 200`,
  ).all<RawPaymentRow>();
  const sum = await env.DB.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS total FROM listing_payments").first<{ total: number }>();

  const shaped = entries.map((e) => ({
    ...e,
    same_operator_both_sides: computeSameOperatorBothSides(e.funder_handle, e.payee_handle),
  }));

  return {
    note: "The public book of funder-to-reviewer bounty payments. NOT chained (deliberately -- see GET /api/listings/security): each row's own on-chain tx IS the tamper-evidence. The treasury is never party to any of these.",
    total_paid_cents: sum?.total ?? 0,
    how_to_verify: "Each row carries its settlement tx -- verify it directly on Base. This table is not part of GET /api/attest's hash chain.",
    entries: shaped,
  };
}
