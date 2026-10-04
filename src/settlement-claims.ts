// Settlement claims: one row per signed x402 authorisation the server has put to
// the facilitator (docs/BRIEF-SETTLEMENT-REPLAY-GUARD.md, option B as amended;
// migrations/0017_settlement_claims.sql carries the why). This module owns the
// claim's identity, its state machine, its lease, and the ONE way a paid act is
// booked: a step that commits the row it creates in the same D1 batch as the
// UPDATE recording it in the claim (B5a/B5c), gated on the claim still being
// settled_unbooked with that step unrecorded, so a crashed, repeated or
// concurrent finisher can never write a step twice.
//
// It imports no route module and no facilitator I/O: the facilitator answers
// (x402.ts) and the route-specific booking (register-gate.ts, x402.ts's patron,
// listings.ts) are built on top of it, which keeps the module graph acyclic.
// Nothing here ever returns, logs or serves `rpc_body`: it is an executable
// authorisation until valid_before (B7), and migration 0017's CHECK clears it on
// every terminal row.

import { classifyUniqueViolation, sha256Hex, chainHeadMovedError, type ChainGate, type ChainedTable } from "./chain.ts";
import { SocietyError, type Env } from "./society.ts";
import { CHAIN_SPENT_MARKER, CLAIM_HANDLE_TAKEN, CLAIM_LISTING_NOT_PAYING, CONTRADICTION_MARKER } from "./settlement-attention.ts";

// C7 (second build): the four markers the claim table carries in `verdict_reason` are DEFINED in settlement-attention.ts (a leaf module, so officialFacts can count the rows the attention list
// serves without an import cycle) and re-exported here, so every writer and the one public reader read a single definition. Their meanings are documented where they are used below.
export { CHAIN_SPENT_MARKER, CLAIM_HANDLE_TAKEN, CLAIM_LISTING_NOT_PAYING, CONTRADICTION_MARKER };

export type ClaimRoute = "register" | "patron" | "listing_create" | "listing_pay";
export type ClaimState = "pending" | "settled_unbooked" | "booked" | "refused" | "expired";

export interface ClaimKey {
  network: string;
  asset: string;
  from: string;
  nonce: string;
}

export interface ClaimRow {
  network: string;
  asset: string;
  from_addr: string;
  nonce: string;
  route: ClaimRoute;
  intent_json: string;
  intent_hash: string;
  rpc_body: string | null;
  rpc_body_hash: string;
  valid_before: number;
  state: ClaimState;
  tx: string | null;
  payer: string | null;
  verdict_reason: string | null;
  booked_refs: string;
  created_at: number;
  updated_at: number;
  lease_owner: string | null;
  leased_until: number | null;
}

// What booking has durably written. Every key is a row id.
export interface BookedRefs {
  ledger_id?: number;
  citizen_id?: number;
  key_event_id?: number;
  listing_id?: number;
  payment_id?: number;
}
export type RefName = keyof BookedRefs;

// A request or reconciler attempt holds the lease for at most this long. It must
// outlast PayAI's worst /settle wait (about 100 s, docs/REVIEW-X402-SETTLE-HONESTY-GATE-2026-09-29.md
// L5) plus booking; a crashed worker's row is takeable once it lapses (B6).
export const CLAIM_LEASE_TTL_MS = 180_000;

export const PAYMENT_AUTHORIZATION_MALFORMED = "payment_authorization_malformed";
export const SETTLEMENT_CLAIM_CONFLICT = "settlement_claim_conflict";
export const SETTLEMENT_ALREADY_BOOKED = "settlement_already_booked";
export const SETTLEMENT_UNRESOLVED = "settlement_unresolved";
// R2b (gate C2): the facilitator reported a settlement and the society's own claim for it is refused or expired.
export const SETTLEMENT_CONTRADICTION = "settlement_contradiction";
// F1 (hub ruling, 2026-09-30): a registration whose handle was taken by a DIFFERENT seat between settlement and the
// citizen write can never be booked by any retry. The claim stays settled_unbooked (B2 has no other transition) and
// carries this permanent reason; the reconciler skips such rows and every answer for one says so plainly.
export const REGISTRATION_HANDLE_TAKEN_AFTER_PAYMENT = "registration_handle_taken_after_payment";
// C5 (drafts/BRIEF-PAID-PATH-M3-2026-10-02.md, first-gate L4): a listing_pay claim that is settled_unbooked while its listing is no longer 'paying' can never be booked (the
// booking INSERT requires the listing to be 'paying'). The reconciler gives it this permanent reason the first time it meets it and never selects it again, so it stops taking
// one of the reconciler's two daily slots. The claim stays settled_unbooked (no new state); every answer for it says so plainly.

// C1 (docs: drafts/BRIEF-PAID-PATH-M3-2026-10-02.md, re-gate LOW-1(a), A1): a claim that met a settlement_contradiction (the facilitator reported a settlement
// for an authorisation whose claim another holder had made refused or expired) is stamped, in verdict_reason, with this prefix, the facilitator's tx, a bar
// and the original reason (clipped). No new state and no migration: the row stays refused or expired, and every later answer for it reads the marker.
const CONTRADICTION_ORIGINAL_CLIP = 300;

// How a payer whose money moved, and who is not a citizen, reaches the maintainer (gate M1). One literal: every settled-but-incomplete message interpolates it.
export const SHOWHOME_REPORT_POINTER =
  "To add your own report, leave a free showhome note naming this tx: POST /api/showhome/enter (any label that is not a citizen handle), then POST /api/showhome/note.";

// ---------- identity ----------

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const NONCE_RE = /^0x[0-9a-fA-F]{64}$/;

function malformed(what: string): never {
  throw new SocietyError(
    400,
    `X-PAYMENT's payload.authorization ${what}. Nothing was sent to the facilitator; sign an x402 'exact' transfer authorisation (from, to, value, validAfter, validBefore, nonce).`,
    PAYMENT_AUTHORIZATION_MALFORMED,
  );
}

// `validBefore` as the authorisation carries it: unix SECONDS, a decimal string
// on the wire (a safe-integer number is tolerated). Clamped to the largest safe
// integer: an authorisation valid for 10^60 seconds never expires, and the column
// is a JS-safe integer.
function parseValidBefore(v: unknown): number {
  if (typeof v === "number" && Number.isSafeInteger(v) && v >= 0) return v;
  if (typeof v === "string" && /^[0-9]{1,78}$/.test(v)) {
    const n = BigInt(v);
    return n > BigInt(Number.MAX_SAFE_INTEGER) ? Number.MAX_SAFE_INTEGER : Number(n);
  }
  return malformed("has no decimal validBefore");
}

// The claim key from the decoded payload. `from` and `nonce` are folded to lower
// case: EIP-55 checksum casing is presentation, not identity (x402.ts applies the
// same rule to `to`), so a replay that re-cases either must land on the same key.
// network and asset come from OUR requirements, never from the payload. A
// malformed authorisation is refused here, free, before anything is sent to the
// facilitator.
export function claimKeyFromPayload(paymentPayload: unknown, reqs: { network: string; asset: string }): { key: ClaimKey; validBefore: number } {
  const inner = paymentPayload !== null && typeof paymentPayload === "object" ? (paymentPayload as { payload?: unknown }).payload : undefined;
  const auth = inner !== null && typeof inner === "object" ? (inner as { authorization?: unknown }).authorization : undefined;
  if (auth === null || typeof auth !== "object" || Array.isArray(auth)) malformed("is missing");
  const { from, nonce, validBefore } = auth as { from?: unknown; nonce?: unknown; validBefore?: unknown };
  if (typeof from !== "string" || !ADDRESS_RE.test(from)) malformed("has no 20-byte hex `from` address");
  if (typeof nonce !== "string" || !NONCE_RE.test(nonce)) malformed("has no 32-byte hex `nonce`");
  return {
    key: { network: reqs.network.toLowerCase(), asset: reqs.asset.toLowerCase(), from: (from as string).toLowerCase(), nonce: (nonce as string).toLowerCase() },
    validBefore: parseValidBefore(validBefore),
  };
}

// Sorted-key JSON, so two intents that say the same thing hash the same whatever
// order their keys were built in.
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`)
    .join(",")}}`;
}

export const KEY_WHERE = "network = ? AND asset = ? AND from_addr = ? AND nonce = ?";
export const keyArgs = (k: ClaimKey): unknown[] => [k.network, k.asset, k.from, k.nonce];

export function refsOf(row: Pick<ClaimRow, "booked_refs">): BookedRefs {
  try {
    const parsed = JSON.parse(row.booked_refs) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as BookedRefs) : {};
  } catch {
    return {};
  }
}

export const intentOf = (row: Pick<ClaimRow, "intent_json">): Record<string, unknown> => JSON.parse(row.intent_json) as Record<string, unknown>;

export const keyOfRow = (row: ClaimRow): ClaimKey => ({ network: row.network, asset: row.asset, from: row.from_addr, nonce: row.nonce });

// ---------- taking a claim ----------

export async function getClaim(env: Env, key: ClaimKey): Promise<ClaimRow | null> {
  return env.DB.prepare(`SELECT * FROM settlement_claims WHERE ${KEY_WHERE}`).bind(...keyArgs(key)).first<ClaimRow>();
}

export interface ClaimSpec {
  route: ClaimRoute;
  // The business intent as it stands when claimed (B1): handle, model and public
  // key; the patron line; the listing fields; for pay listing the listing id,
  // submission id and the pinned wallet row. Booking reads it back, so a resumed
  // booking writes exactly what the paid request asked for.
  intent: Record<string, unknown>;
}

export interface ClaimIdentity {
  key: ClaimKey;
  validBefore: number;
  rpcBody: string;
  rpcBodyHash: string;
  intentHash: string;
}

export async function claimIdentity(key: ClaimKey, validBefore: number, rpcBody: unknown, spec: ClaimSpec): Promise<ClaimIdentity> {
  const text = JSON.stringify(rpcBody);
  return { key, validBefore, rpcBody: text, rpcBodyHash: await sha256Hex(text), intentHash: await sha256Hex(canonicalJson({ route: spec.route, intent: spec.intent })) };
}

// A request matches a claim only if BOTH its rpc_body and its intent match (B4a):
// the registration requirements omit the handle, so the same signed header with a
// different handle has a byte-identical rpc_body and must read as divergent. The
// row keeps both hashes after rpc_body is cleared, so this still works on a
// terminal row.
export const sameRequest = (row: ClaimRow, id: ClaimIdentity): boolean => row.rpc_body_hash === id.rpcBodyHash && row.intent_hash === id.intentHash;

export type TakeResult = { taken: true } | { taken: false; row: ClaimRow; identical: boolean };

// The INSERT is the claim: ON CONFLICT DO NOTHING on the primary key, never
// SELECT-then-INSERT (check-then-act loses the race under concurrency). The
// taker holds the lease from the first instant, so a second request or the
// reconciler cannot start a competing settle while this one is in flight.
export async function takeClaim(env: Env, id: ClaimIdentity, spec: ClaimSpec, owner: string, now: number): Promise<TakeResult> {
  const res = await env.DB.prepare(
    `INSERT INTO settlement_claims (network, asset, from_addr, nonce, route, intent_json, intent_hash, rpc_body, rpc_body_hash, valid_before, state, booked_refs, created_at, updated_at, lease_owner, leased_until)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', '{}', ?, ?, ?, ?)
     ON CONFLICT (network, asset, from_addr, nonce) DO NOTHING`,
  )
    .bind(...keyArgs(id.key), spec.route, canonicalJson(spec.intent), id.intentHash, id.rpcBody, id.rpcBodyHash, id.validBefore, now, now, owner, now + CLAIM_LEASE_TTL_MS)
    .run();
  if (res.meta.changes === 1) return { taken: true };
  const row = await getClaim(env, id.key);
  // A row that conflicted cannot have vanished (rows are never deleted); if it
  // somehow has, refuse rather than guess.
  if (!row) throw new SocietyError(503, "The payment claim could not be read back after a conflict. Nothing was sent to the facilitator.");
  return { taken: false, row, identical: row.route === spec.route && sameRequest(row, id) };
}

// ---------- the lease (B6) ----------

// A row is worked only by the holder of an unexpired lease. Returns the row as
// leased, or null if another holder's lease is live or the row is terminal.
// updated_at moves on every acquisition: the reconciler orders by it, so a row
// that keeps failing goes to the back of the queue rather than starving the rest.
export async function acquireLease(env: Env, key: ClaimKey, owner: string, now: number): Promise<ClaimRow | null> {
  return env.DB.prepare(
    `UPDATE settlement_claims SET lease_owner = ?, leased_until = ?, updated_at = ?
     WHERE ${KEY_WHERE} AND state IN ('pending', 'settled_unbooked') AND (leased_until IS NULL OR leased_until <= ?)
     RETURNING *`,
  )
    .bind(owner, now + CLAIM_LEASE_TTL_MS, now, ...keyArgs(key), now)
    .first<ClaimRow>();
}

export async function releaseLease(env: Env, key: ClaimKey, owner: string): Promise<void> {
  await env.DB.prepare(`UPDATE settlement_claims SET lease_owner = NULL, leased_until = NULL WHERE ${KEY_WHERE} AND lease_owner = ?`)
    .bind(...keyArgs(key), owner)
    .run();
}

// OWNERSHIP, ENFORCED INSIDE THE WRITE (docs/REVIEW-SETTLEMENT-REPLAY-GUARD-GATE-2026-09-30.md M1; CODEX r1 of
// exchange/REVIEW_settlement-replay-guard-build-2026-09-30.md). The lease bounds nothing by itself: a holder that is slow (a slow D1, a chain-head
// retry) can still be mid-write when its lease lapses and another worker takes it, and the transitions below used to check only the claim's state.
// Every write a lease holder makes therefore carries this condition, bound to (its owner id, now): it passes while THIS owner holds the lease, or
// while no live lease is held at all (none was ever taken, it was released, or it has lapsed with nobody picking it up: a merely slow holder is
// never locked out of finishing its own work). It fails only when ANOTHER owner holds an unexpired lease, and then the statement writes nothing.
// Because the booking gate subquery sits inside the same D1 batch as the row INSERTs and the UPDATE recording them, a holder whose lease was taken
// writes NOTHING in that batch. Per-step gates already stopped a double booking; this stops the stale holder's ANSWER being built from a write that
// the new holder, not it, made.
export const HOLDS_LEASE = "(lease_owner = ? OR lease_owner IS NULL OR leased_until IS NULL OR leased_until <= ?)";
export const holdsLeaseArgs = (owner: string, now: number): unknown[] => [owner, now];

// The same condition read back in TypeScript, for a finisher whose booking step did not apply: true when ANOTHER owner holds an unexpired lease on the
// claim, which is the one reason a step on a still-settled_unbooked claim can write nothing besides its own ref already being recorded.
export const leaseHeldByAnother = (row: Pick<ClaimRow, "lease_owner" | "leased_until"> | null, owner: string, now: number): boolean =>
  row !== null && row.lease_owner !== null && row.lease_owner !== owner && row.leased_until !== null && row.leased_until > now;

// C3 (re-gate LOW-2): the TypeScript read-back above is a RACE for a step whose gate is only state + ref + lease (the ledger line, the citizen, the key_registered line and
// listing creation): another holder's lease can lapse, or be released, between the batch and the re-read, so `leaseHeldByAnother` then says "nobody holds it" for a step
// that WAS gated out by that very lease. This does not read the lease at all. Called for a step whose own batch reported `applied: false`: the claim still
// settled_unbooked with that step's ref still unrecorded PROVES the lease condition failed when the batch ran, because the other two gate conditions (state, ref) held then
// (a ref is only ever added and the claim only ever moves forward) and still hold now. The caller answers from the claim, whatever the lease reads now. NOT for pay
// listing, whose INSERT also requires `listings.status = 'paying'`: a gated-out step there can mean the listing moved, so it keeps the lease read-back.
export const stepGatedOutByLease = (after: ClaimRow | null, ref: RefName): boolean => after !== null && after.state === "settled_unbooked" && refsOf(after)[ref] == null;

// ---------- transitions (each conditional on the state it leaves) ----------

// H3 + gate MEDIUM-1 + the booking-reservation-binding deferral (second build; discharged): THE RESERVATION A listing_pay CLAIM OWNS. The binding the code already had is the F2 release's: the listing is
// 'paying' and unpaid, the reservation records THIS claim's pinned wallet row (id and hash, from the claim's intent), and it was taken no later than the claim was created (a reservation is
// always taken before its claim in the same request, so a LATER paying_since is another payer's reservation, taken after a release). ONE fragment, on the listings table's own columns,
// used by everything that must act only on the claim's own reservation: the release (above), the booking INSERT and the listing UPDATE (listings.ts finishPayListing), C5's check
// (settlement-reconcile.ts) and the pre-re-POST check (x402.ts attemptPending), so they cannot drift. Binds, in order: wallet_row_id, wallet_row_hash, created_at (reservationArgs).
export const RESERVATION_BOUND =
  "status = 'paying' AND paid_submission_id IS NULL AND paying_wallet_row_id = ? AND paying_wallet_row_hash = ? AND paying_since IS NOT NULL AND paying_since <= ?";
export function reservationArgs(row: Pick<ClaimRow, "intent_json" | "created_at">): unknown[] {
  const i = intentOf(row) as { wallet_row_id: number; wallet_row_hash: string };
  return [i.wallet_row_id, i.wallet_row_hash, row.created_at];
}
// One read: the listing's status (null when there is no such listing) and whether it holds THIS claim's reservation.
export async function listingReservationState(env: Env, row: ClaimRow): Promise<{ status: string | null; bound: boolean }> {
  const i = intentOf(row) as { listing_id: number };
  const r = await env.DB.prepare(`SELECT status, CASE WHEN ${RESERVATION_BOUND} THEN 1 ELSE 0 END AS bound FROM listings WHERE id = ?`)
    .bind(...reservationArgs(row), i.listing_id)
    .first<{ status: string; bound: number }>();
  return { status: r?.status ?? null, bound: r?.bound === 1 };
}

// pending -> settled_unbooked: the facilitator said settled. False means another
// worker already moved it (or holds a live lease on it); the caller re-reads and
// answers from the row. A non-final write that passes RENEWS the lease in the same
// statement, so a holder that is still working keeps it (R1).
export async function markSettled(env: Env, key: ClaimKey, tx: string, payer: string, owner: string, now: number): Promise<boolean> {
  const r = await env.DB.prepare(
    `UPDATE settlement_claims SET state = 'settled_unbooked', tx = ?, payer = ?, verdict_reason = NULL, lease_owner = ?, leased_until = ?, updated_at = ? WHERE ${KEY_WHERE} AND state = 'pending' AND ${HOLDS_LEASE}`,
  )
    .bind(tx, payer, owner, now + CLAIM_LEASE_TTL_MS, now, ...keyArgs(key), ...holdsLeaseArgs(owner, now))
    .run();
  return r.meta.changes === 1;
}

// F2 (hub ruling, 2026-09-30): when the reconciler moves a listing_pay claim to a terminal state that proves no money moved
// (expired: the chain shows the authorisation unused after validBefore; refused: a recorded rule-7 refusal), the listing's
// reservation goes back to open IN THE SAME BATCH as the claim's terminal update. The release is one conditional UPDATE:
//   - changes() = 1 ties it to THIS batch's claim update, so a worker that lost the race to move the claim releases nothing;
//   - status = 'paying' and paid_submission_id IS NULL: a listing already paid (or withdrawn, or expired) is never touched;
//   - the pinned wallet row the reservation recorded (paying_wallet_row_id/hash) must be this claim's pin, and paying_since
//     must not be later than the claim's own creation: the reservation is taken before the claim in the same request, so a
//     LATER reservation (another payer, after a person released it) has a later paying_since and is never released.
// Never used on pending, on an unknown outcome, or when the chain says the authorisation was spent.
export function listingReleaseStatement(env: Env, row: ClaimRow): D1PreparedStatement | null {
  if (row.route !== "listing_pay") return null;
  const i = intentOf(row) as { listing_id: number };
  return env.DB.prepare(
    `UPDATE listings SET status = 'open', paying_since = NULL, paying_wallet_row_id = NULL, paying_wallet_row_hash = NULL
     WHERE id = ? AND ${RESERVATION_BOUND} AND changes() = 1`,
  ).bind(i.listing_id, ...reservationArgs(row));
}

// Runs the claim's terminal UPDATE, with the listing release (a pay-listing claim passed as `release`) as the second statement of
// the same batch. Returns whether THIS call moved the claim.
async function terminate(env: Env, claimUpdate: D1PreparedStatement, release?: ClaimRow): Promise<boolean> {
  const stmt = release ? listingReleaseStatement(env, release) : null;
  if (!stmt) return (await claimUpdate.run()).meta.changes === 1;
  const out = await env.DB.batch([claimUpdate, stmt]);
  return (out[0] as { meta: { changes: number } }).meta.changes === 1;
}

// pending -> refused (classifier rule 7 only): terminal, the authorisation body is cleared. Pass `release` (the claim row) from the
// reconciler and the re-send so a listing_pay reservation is released in the same batch (F2); the pay route's own request path
// releases its reservation itself and passes nothing.
//
// R2-1 (CODEX r2 HIGH, second build): `takenAt` binds the write to the claim's TAKE time. HOLDS_LEASE accepts a NULL or lapsed lease, so a first attempt whose refusal write is delayed past its
// lease could land after another holder (B) acquired the lapsed lease, re-POSTed, met an unknown outcome and cleared the lease again (noteUnknown): the 402 it then answers, with fresh
// `accepts`, invites a second signature while B's transfer can still mine. Every other holder's attempt MOVES updated_at (acquireLease and noteUnknown both set it, and acquireLease acts only
// after the lease lapsed), so `updated_at = takenAt` proves no other attempt started since this request took the claim. payAndSettle's first-attempt refusal passes it; a write that
// changes nothing is re-read and answered from the claim, never as a 402.
export async function markRefused(env: Env, key: ClaimKey, reason: string, owner: string, now: number, release?: ClaimRow, takenAt?: number): Promise<boolean> {
  return terminate(
    env,
    env.DB.prepare(
      `UPDATE settlement_claims SET state = 'refused', rpc_body = NULL, verdict_reason = ?, lease_owner = NULL, leased_until = NULL, updated_at = ? WHERE ${KEY_WHERE} AND state = 'pending' AND ${HOLDS_LEASE}${takenAt === undefined ? "" : " AND updated_at = ?"}`,
    ).bind(reason, now, ...keyArgs(key), ...holdsLeaseArgs(owner, now), ...(takenAt === undefined ? [] : [takenAt])),
    release,
  );
}

// pending -> expired: the chain proved the authorisation unused AFTER valid_before (plus the margin). See markRefused for `release`.
export async function markExpired(env: Env, key: ClaimKey, owner: string, now: number, release?: ClaimRow): Promise<boolean> {
  return terminate(
    env,
    env.DB.prepare(
      `UPDATE settlement_claims SET state = 'expired', rpc_body = NULL, verdict_reason = 'authorisation expired unused (on-chain authorizationState is unused after validBefore)', lease_owner = NULL, leased_until = NULL, updated_at = ? WHERE ${KEY_WHERE} AND state = 'pending' AND ${HOLDS_LEASE}`,
    ).bind(now, ...keyArgs(key), ...holdsLeaseArgs(owner, now)),
    release,
  );
}

// C1: stamps a TERMINAL claim (refused or expired) that met a settlement_contradiction. One conditional UPDATE: it matches only while the row is still in one of
// those two terminal states (never a pending or settled_unbooked row, whose state this must not touch) and is not already stamped, so the FIRST contradiction's
// tx is the one kept. It sets `tx` to the facilitator's tx (no CHECK forbids a tx on a terminal row) and keeps the original refusal text inside the marker: that
// text is the only record of what the facilitator said. No lease condition: a terminal row has no lease. True only for the call that stamped it.
export async function markContradiction(env: Env, key: ClaimKey, tx: string, now: number): Promise<boolean> {
  const r = await env.DB.prepare(
    `UPDATE settlement_claims SET tx = ?, verdict_reason = ? || ? || '|' || substr(COALESCE(verdict_reason, ''), 1, ?), updated_at = ?
     WHERE ${KEY_WHERE} AND state IN ('refused', 'expired') AND (verdict_reason IS NULL OR substr(verdict_reason, 1, ?) <> ?)`,
  )
    .bind(tx, CONTRADICTION_MARKER, tx, CONTRADICTION_ORIGINAL_CLIP, now, ...keyArgs(key), CONTRADICTION_MARKER.length, CONTRADICTION_MARKER)
    .run();
  return r.meta.changes === 1;
}

export const isContradicted = (row: Pick<ClaimRow, "state" | "verdict_reason">): boolean =>
  (row.state === "refused" || row.state === "expired") && typeof row.verdict_reason === "string" && row.verdict_reason.startsWith(CONTRADICTION_MARKER);

// The tx a stamped row names: the row's own `tx` (the stamp sets it), else the one inside the marker.
const contradictionTx = (row: Pick<ClaimRow, "tx" | "verdict_reason">): string => {
  if (row.tx) return row.tx;
  const inside = (row.verdict_reason ?? "").slice(CONTRADICTION_MARKER.length).split("|")[0];
  return inside;
};

// C4, option B (Ben's ruling of 4 Oct 2026; drafts/BRIEF-PAID-PATH-M3-2026-10-02.md "Ben's ruling ... option B", A3, M5): a PENDING claim whose authorisation the chain reads USED (spent, or
// cancelled by its signer: authorizationState answers true for both) while the facilitator answers a recorded refusal, or whose listing no longer holds the claim's own
// reservation, can neither be refused (the money may have moved) nor booked (nothing says which transaction used it). It is STAMPED, in verdict_reason, with this prefix and the
// facilitator's words (clipped), and STOPPED: no re-POST, no noteUnknown overwrite, no reconciler slot, every answer says a person will check it. No new state and no migration.
// DEFERRED-C4-OPTION-A-RECEIPT: option A (read the transaction's receipt and require the Transfer(from, payTo, value) log right after AuthorizationUsed, then book from chain
// evidence) is NOT built in this wave; it needs the two-RPC receipt quorum, the cancellation read and a re-priced reconciler budget (the brief's A2 and H1).
const CHAIN_SPENT_REASON_CLIP = 300;

export async function markChainSpent(env: Env, key: ClaimKey, reason: string, owner: string, now: number): Promise<boolean> {
  const r = await env.DB.prepare(
    `UPDATE settlement_claims SET verdict_reason = ? || substr(?, 1, ?), updated_at = ?, lease_owner = NULL, leased_until = NULL
     WHERE ${KEY_WHERE} AND state = 'pending' AND ${HOLDS_LEASE} AND (verdict_reason IS NULL OR substr(verdict_reason, 1, ?) <> ?)`,
  )
    .bind(CHAIN_SPENT_MARKER, reason, CHAIN_SPENT_REASON_CLIP, now, ...keyArgs(key), ...holdsLeaseArgs(owner, now), CHAIN_SPENT_MARKER.length, CHAIN_SPENT_MARKER)
    .run();
  return r.meta.changes === 1;
}

export const isChainSpent = (row: Pick<ClaimRow, "state" | "verdict_reason">): boolean =>
  row.state === "pending" && typeof row.verdict_reason === "string" && row.verdict_reason.startsWith(CHAIN_SPENT_MARKER);

// An unknown outcome leaves the row pending; this records the last thing the
// facilitator said (already served once, clipped) and lets go of the lease so an
// identical re-send can reconcile at once. It never overwrites a stopped row's marker (A3). STRICT holder-only (fix pass 4, H3, hub ruling): unlike the other holder
// writes it CLEARS the lease, so it must never run on a claim whose lease is named for someone else, lapsed or not.
// A holder whose lease was taken and then released by another worker (lease_owner NULL) writes nothing.
export async function noteUnknown(env: Env, key: ClaimKey, reason: string, owner: string, now: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE settlement_claims SET verdict_reason = ?, updated_at = ?, lease_owner = NULL, leased_until = NULL
     WHERE ${KEY_WHERE} AND state = 'pending' AND lease_owner = ? AND (verdict_reason IS NULL OR substr(verdict_reason, 1, ?) <> ?)`,
  )
    .bind(reason.slice(0, 400), now, ...keyArgs(key), owner, CHAIN_SPENT_MARKER.length, CHAIN_SPENT_MARKER)
    .run();
}

// settled_unbooked -> (same state, permanent reason): the citizen write met a handle another seat now holds. True only for
// the call that FIRST recorded the reason, so the one log line is written once. Clears the lease.
export async function markHandleTaken(env: Env, key: ClaimKey, owner: string, now: number): Promise<boolean> {
  const r = await env.DB.prepare(
    `UPDATE settlement_claims SET verdict_reason = ?, updated_at = ?, lease_owner = NULL, leased_until = NULL WHERE ${KEY_WHERE} AND state = 'settled_unbooked' AND verdict_reason IS NULL AND ${HOLDS_LEASE}`,
  )
    .bind(CLAIM_HANDLE_TAKEN, now, ...keyArgs(key), ...holdsLeaseArgs(owner, now))
    .run();
  return r.meta.changes === 1;
}

export const isHandleTaken = (row: Pick<ClaimRow, "state" | "verdict_reason">): boolean => row.state === "settled_unbooked" && row.verdict_reason === CLAIM_HANDLE_TAKEN;

// C5: settled_unbooked -> (same state, permanent reason): the reconciler found the listing this bounty payment was made against is no longer 'paying'. True only for the call
// that FIRST recorded the reason, so its one log line is written once. Same shape as markHandleTaken (holder-only, clears the lease).
export async function markListingNotPaying(env: Env, key: ClaimKey, owner: string, now: number): Promise<boolean> {
  const r = await env.DB.prepare(
    `UPDATE settlement_claims SET verdict_reason = ?, updated_at = ?, lease_owner = NULL, leased_until = NULL WHERE ${KEY_WHERE} AND state = 'settled_unbooked' AND verdict_reason IS NULL AND ${HOLDS_LEASE}`,
  )
    .bind(CLAIM_LISTING_NOT_PAYING, now, ...keyArgs(key), ...holdsLeaseArgs(owner, now))
    .run();
  return r.meta.changes === 1;
}

export const isListingNotPaying = (row: Pick<ClaimRow, "state" | "verdict_reason">): boolean => row.state === "settled_unbooked" && row.verdict_reason === CLAIM_LISTING_NOT_PAYING;

// ---------- booking: one step, one batch ----------

export interface BookingStep {
  // The booked_refs field this step records.
  ref: RefName;
  // True for the route's last step: the same batch also moves the claim to
  // `booked`, clears rpc_body and the lease, so "booked" is true exactly when
  // every write of the paid act is durable.
  final: boolean;
  // Set when the step's statements include a chained append: a UNIQUE conflict on
  // prev_hash/hash is a head race, so the step is rebuilt against the new head
  // and tried again (up to four times, as appendChained does).
  chain?: ChainedTable;
  // The row-writing statements for ONE attempt. `gate` is a boolean subquery body,
  // true only while this claim is settled_unbooked, this step's ref is
  // unrecorded and the calling owner holds the lease (or none is live: R1); every statement that creates a row must be conditional on it
  // (INSERT ... SELECT ... WHERE EXISTS (gate)), and the LAST row-creating
  // statement's row is the one whose id is recorded (last_insert_rowid()).
  statements: (gate: ChainGate) => Promise<D1PreparedStatement[]>;
}

// Runs one booking step for `owner`, the lease holder. Returns applied=true when this call's batch recorded the
// step; false when the gate was closed (someone else recorded it, the claim left settled_unbooked, or ANOTHER owner
// holds a live lease: R1), in which case NOTHING was written. A thrown error means the batch failed as a unit:
// neither the row nor the reference exists. The gate subquery AND the recording UPDATE both carry the lease-ownership
// condition (HOLDS_LEASE), so a finisher whose lease was taken by another holder writes nothing in this batch; a
// non-final step that passes RENEWS the lease in the same statement, a final one clears it with the move to `booked`.
//
// C8 (first-gate L7): when the step applied, `rowId` is the id the row-creating statement reported for itself (D1's `meta.last_row_id` on the LAST statement of the step's
// own list, the one whose row the claim records via last_insert_rowid()). A finisher whose step created the row it needs to answer with (the secret-mode citizen) takes the id
// from here instead of re-reading the claim: a read-back that fails AFTER the batch committed must not turn a delivered seat into a booking failure. Absent when the step did not
// apply, or when the platform reported no usable id (the caller then reads the claim back, as before).
export async function runBookingStep(env: Env, key: ClaimKey, step: BookingStep, owner: string, now: number): Promise<{ applied: boolean; rowId?: number }> {
  const gate: ChainGate = {
    sql: `SELECT 1 FROM settlement_claims WHERE ${KEY_WHERE} AND state = 'settled_unbooked' AND json_extract(booked_refs, '$.${step.ref}') IS NULL AND ${HOLDS_LEASE}`,
    args: [...keyArgs(key), ...holdsLeaseArgs(owner, now)],
  };
  const finalSet = step.final ? ", state = 'booked', rpc_body = NULL, lease_owner = NULL, leased_until = NULL" : ", lease_owner = ?, leased_until = ?";
  const finalArgs = step.final ? [] : [owner, now + CLAIM_LEASE_TTL_MS];
  // changes() is the row count of the statement that ran just before this one in
  // the batch: the gated INSERT (or, for pay listing, the listing UPDATE). Zero
  // means that statement was gated out, and the claim is left exactly as it was.
  const record = `UPDATE settlement_claims SET booked_refs = json_set(booked_refs, '$.${step.ref}', last_insert_rowid())${finalSet}, updated_at = ?
     WHERE ${KEY_WHERE} AND state = 'settled_unbooked' AND json_extract(booked_refs, '$.${step.ref}') IS NULL AND changes() = 1 AND ${HOLDS_LEASE}`;
  for (let attempt = 0; attempt < 4; attempt++) {
    const stmts = await step.statements(gate);
    const batch = [...stmts, env.DB.prepare(record).bind(...finalArgs, now, ...keyArgs(key), ...holdsLeaseArgs(owner, now))];
    try {
      const out = await env.DB.batch(batch);
      const last = out[out.length - 1] as { meta: { changes: number } };
      if (last.meta.changes !== 1) return { applied: false };
      const created = (out[stmts.length - 1] as { meta?: { last_row_id?: unknown } } | undefined)?.meta?.last_row_id;
      return typeof created === "number" && Number.isSafeInteger(created) && created > 0 ? { applied: true, rowId: created } : { applied: true };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      if (step.chain && message.includes("UNIQUE") && classifyUniqueViolation(step.chain, message) === "chain_head") continue;
      throw e;
    }
  }
  throw chainHeadMovedError(step.chain ?? "ledger");
}

// ---------- what a caller is told (B4, B9) ----------

export interface ClaimAnswer {
  status: number;
  body: Record<string, unknown>;
}

export const claimAmountCents = (row: ClaimRow): number => {
  const i = intentOf(row);
  if (row.route === "listing_create") return Number(i.fee_cents ?? 0);
  if (row.route === "listing_pay") return Number(i.amount_cents ?? 0);
  return 100;
};

export function describeClaim(row: ClaimRow): string {
  const i = intentOf(row);
  switch (row.route) {
    case "register":
      return `the registration of handle "${String(i.handle)}"`;
    case "patron":
      return "a patron inscription";
    case "listing_create":
      return `the posting fee for the listing "${String(i.title)}"`;
    case "listing_pay":
      return `the bounty payment for listing ${String(i.listing_id)}`;
  }
}

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;
const txPart = (row: ClaimRow) => (row.tx ? ` (tx ${row.tx})` : "");

// What the reconciler really does (B6a, hub ruling F4): ONE pass a day, at 06:00 UTC, and it works a limited number of unresolved payments per
// pass, oldest attempt first, and only what the concierge and the clerk leave room for that day (scheduled(), F3), so a payment can wait MORE than
// one day. It promises no deadline. A secret-mode registration that is settled_unbooked gets no deadline at all (B6b).
export const RECONCILE_BACKSTOP =
  "The society's reconciler makes one pass a day, at 06:00 UTC, and works a limited number of unresolved payments per pass, oldest attempt first, so a payment can wait more than one day.";

// Appended ONLY where an identical re-send really re-checks or finishes the claim (registration, the patron door, listing creation). NOT on a
// listing_pay answer (the pay route's reservation answers a re-send first, so repeating does nothing) and NOT on the handle-taken answer (F1:
// no retry can book it). Each place it is served has a test that follows it.
export const RECONCILE_REPEAT_CLAUSE = "Repeating this identical request re-checks it sooner.";

export function reconcileTail(route: ClaimRoute): string {
  return route === "listing_pay" ? RECONCILE_BACKSTOP : `${RECONCILE_BACKSTOP} ${RECONCILE_REPEAT_CLAUSE}`;
}

// F1: what a payer is told when the handle was lost after payment. It names the tx and the handle, says the payment
// settled, says plainly that re-sending cannot book it and is not needed, and invites no new signature: the way out
// is the maintainer, by a free showhome note.
export function handleTakenMessage(row: Pick<ClaimRow, "intent_json" | "tx" | "route">): string {
  const i = JSON.parse(row.intent_json) as { handle?: unknown };
  return `Your $1.00 payment settled (tx ${row.tx ?? "unknown"}), but the handle "${String(i.handle)}" was taken by another seat before this registration could be written, so no seat was created for you. Re-sending this request cannot book it and is not needed. Do not sign again: this payment has already moved. Reach the maintainer with this tx by a free showhome note: POST /api/showhome/enter (any label that is not a citizen handle), then POST /api/showhome/note.`;
}

// C5: what a funder is told when the reconciler set its bounty payment aside. It never says the reconciler will finish it (it will not) and invites no new signature: the
// money moved. The way out is the maintainer, by a mention (a pay-listing payer is a citizen).
//
// Gate LOW-2 (second build): the same words are served where the booking has just failed because the listing no longer holds the claim's reservation, BEFORE the reconciler has met the claim
// (`setAside: "will"`): the reconciler sets it aside when it next meets it, so the tense must not say it already has. A transient failure with the reservation intact keeps RECONCILE_BACKSTOP.
export function listingNotPayingMessage(row: Pick<ClaimRow, "intent_json" | "tx" | "route">, setAside: "has" | "will" = "has"): string {
  const i = JSON.parse(row.intent_json) as { listing_id?: unknown; amount_cents?: unknown };
  return `Your ${money(Number(i.amount_cents ?? 0))} payment settled${txPart(row as ClaimRow)}, but the listing it was paid against (listing ${String(i.listing_id)}) is no longer awaiting this payment, so the society cannot record it against that listing, and its reconciler ${setAside === "has" ? "has set it aside" : "will set it aside when it next meets it"} rather than retry it. Do not sign again: this payment has already moved. It is logged for the maintainer to look at by hand; no resolution time is promised. To add your own report, mention @commonhold-agent in a comment naming this tx (POST /api/comment).`;
}

// R2-3: what a payer is told about a STOPPED row (a pending claim carrying CHAIN_SPENT_MARKER). It claims only what is established: the chain reads the nonce used
// (authorizationState is true for a spent AND a cancelled authorisation), the society stopped retrying, and a person will look. It never says the reconciler will finish
// it, never says repeating the request does anything, never says nothing was charged, never invites a signature, and never quotes the facilitator.
export function stoppedMessage(row: ClaimRow): string {
  const pointer =
    row.route === "listing_pay"
      ? `To add your own report, mention @commonhold-agent in a comment naming this nonce (${row.nonce}) (POST /api/comment).`
      : `To add your own report, leave a free showhome note naming this nonce (${row.nonce}): POST /api/showhome/enter (any label that is not a citizen handle), then POST /api/showhome/note.`;
  return `The chain shows the signed authorisation for ${describeClaim(row)} was used (spent, or cancelled by its signer), so the money may have moved: whether it did is not established, and the society cannot tell which transaction used it. The society has stopped retrying this payment automatically. A person will check it against the chain by hand; no resolution time is promised. It is listed at GET /api/settlements/attention. Do not sign again. ${pointer}`;
}

export function claimIsSecretRegistration(row: ClaimRow): boolean {
  return row.route === "register" && intentOf(row).public_key == null;
}

// C8: true whether or not the 201 that carried the secret reached the payer. It claims only what the claim row proves (the seat exists; the registration is booked) and what the
// design guarantees (a secret is generated once, for the response to the request that registers the seat, and is stored only as a hash).
export const SECRET_LOST_NOTE =
  "your seat exists; its secret was generated once, for the response to the request that registered it, and cannot be recovered. If that response did not reach you, the secret is lost: reach the maintainer with this tx (a free showhome note: POST /api/showhome/enter, then POST /api/showhome/note). For any future registration, send a public_key.";

// The ONE contradiction answer (C1): the first request to meet the contradiction gets it from x402.ts, and every later identical replay of a stamped refused
// or expired row gets the same words from claimAnswer. Never `accepts`, never "nothing was charged", never an invitation to sign again.
export function contradictionAnswer(tx: string, state: string): ClaimAnswer {
  return {
    status: 500,
    body: {
      error: `The facilitator reported this payment settled (tx ${tx.length > 0 ? tx : "not reported"}), but the society's own record of the signed authorisation reads "${state}", which contradicts it. The money may have moved: whether it did is not established. Do not sign again. This is logged for the maintainer to check against the chain by hand. ${SHOWHOME_REPORT_POINTER}`,
      code: SETTLEMENT_CONTRADICTION,
    },
  };
}

// The answer for a request that matched (or collided with) an existing claim and
// that no route finisher took over. `reqs` is only for the 402 shapes that invite
// a fresh signature (refused, expired). B9: every answer names the tx when one is
// known and invites a second signature ONLY for refused and expired.
// `settledTx` (C2): the caller holds a facilitator SUCCESS verdict for this authorisation naming that tx, but could not write it to the claim because another
// holder holds the still-pending row. The answer then names the tx and says what the caller knows, instead of the generic "outcome unknown" answer.
export function claimAnswer(row: ClaimRow, identical: boolean, reqs: unknown, opts: { leaseHeld?: boolean; detail?: string; settledTx?: string } = {}): ClaimAnswer {
  if (!identical) {
    return {
      status: 409,
      body: {
        error: `This signed payment authorisation has already been used for a different request (${describeClaim(row)}, state ${row.state}${row.tx ? `, tx ${row.tx}` : ""}). It cannot be reused for this one. This request sent nothing to the facilitator, charged nothing and created nothing.`,
        code: SETTLEMENT_CLAIM_CONFLICT,
      },
    };
  }
  switch (row.state) {
    case "booked":
      if (claimIsSecretRegistration(row)) {
        return {
          status: 409,
          body: { error: `This payment${txPart(row)} was already used for ${describeClaim(row)}; nothing was charged again. The registration is complete: ${SECRET_LOST_NOTE}`, code: SETTLEMENT_ALREADY_BOOKED },
        };
      }
      return { status: 409, body: { error: `This payment${txPart(row)} was already used for ${describeClaim(row)}; nothing was charged again and nothing new was created.`, code: SETTLEMENT_ALREADY_BOOKED } };
    case "refused":
      // C1: a claim that met a settlement_contradiction is stamped, and its replays are answered with the contradiction, never this 402 with accepts.
      if (isContradicted(row)) return contradictionAnswer(contradictionTx(row), row.state);
      return {
        status: 402,
        body: { x402Version: 1, error: row.verdict_reason ?? "The facilitator recorded a refusal of this settlement. By its account no money moved.", accepts: [reqs] },
      };
    case "expired":
      if (isContradicted(row)) return contradictionAnswer(contradictionTx(row), row.state);
      return {
        status: 402,
        body: {
          x402Version: 1,
          error: "This authorisation expired unused: the chain shows its nonce was never spent, and it can no longer move money. Nothing was charged. Sign a fresh one.",
          accepts: [reqs],
        },
      };
    case "pending": {
      // R2-3: a STOPPED row (C4, option B) is answered with its own words, below the success-in-hand case (a caller that knows the tx says so) and never with the reconciler's tail.
      if (opts.settledTx === undefined && isChainSpent(row)) return { status: 500, body: { error: stoppedMessage(row), code: SETTLEMENT_UNRESOLVED } };
      const heldClause = opts.leaseHeld ? (row.route === "listing_pay" ? "Another attempt to resolve it is in progress. " : "Another attempt to resolve it is in progress; repeat this identical request in a few minutes. ") : "";
      const rest = `${heldClause}${opts.detail ? `${opts.detail} ` : ""}${reconcileTail(row.route)}`;
      // C2 (re-gate LOW-1(b)): this request holds a success verdict naming the tx. The claim is still pending because another attempt held it when this request
      // tried to write, so the payer is told what this request KNOWS (the facilitator's account, the tx) and what it does not (that the society has recorded it).
      // CODEX M3-build r1 MEDIUM: the success is the fact, the tx string is detail; a success reported with an empty tx is still a success.
      if (opts.settledTx !== undefined) {
        return {
          status: 502,
          body: {
            error: `The facilitator reported this payment settled (tx ${opts.settledTx || "not reported"}), but this request could not record that: the society's own record of it is still pending, and another attempt held it when this request tried to write. By the facilitator's account this payment has already moved. Do not sign again. ${rest}`,
            code: SETTLEMENT_UNRESOLVED,
          },
        };
      }
      return {
        status: 502,
        body: {
          error: `The outcome of this payment is still unknown${txPart(row)}: whether the money moved is not yet established. Do not sign again. ${rest}`,
          code: SETTLEMENT_UNRESOLVED,
        },
      };
    }
    case "settled_unbooked":
      if (isHandleTaken(row)) return { status: 409, body: { error: handleTakenMessage(row), code: REGISTRATION_HANDLE_TAKEN_AFTER_PAYMENT } };
      if (isListingNotPaying(row)) return { status: 500, body: { error: listingNotPayingMessage(row), code: SETTLEMENT_UNRESOLVED } };
      return {
        status: 500,
        body: {
          error: `Your ${money(claimAmountCents(row))} payment settled${txPart(row)} but its booking is not finished: ${describeClaim(row)} is not yet fully recorded. Do not sign again: this payment has already moved. ${
            claimIsSecretRegistration(row)
              ? "It waits for your identical re-send of this same request, which finishes it and delivers a fresh secret."
              : `${opts.detail ? `${opts.detail} ` : ""}${reconcileTail(row.route)}`
          }`,
          code: SETTLEMENT_UNRESOLVED,
        },
      };
  }
}

export function claimResponse(answer: ClaimAnswer): Response {
  return Response.json(answer.body, { status: answer.status, headers: { "Access-Control-Allow-Origin": "*" } });
}
