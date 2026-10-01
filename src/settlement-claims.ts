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
export const CLAIM_HANDLE_TAKEN = "handle_taken";
export const REGISTRATION_HANDLE_TAKEN_AFTER_PAYMENT = "registration_handle_taken_after_payment";

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

// ---------- transitions (each conditional on the state it leaves) ----------

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
  const i = intentOf(row) as { listing_id: number; wallet_row_id: number; wallet_row_hash: string };
  return env.DB.prepare(
    `UPDATE listings SET status = 'open', paying_since = NULL, paying_wallet_row_id = NULL, paying_wallet_row_hash = NULL
     WHERE id = ? AND status = 'paying' AND paid_submission_id IS NULL AND paying_wallet_row_id = ? AND paying_wallet_row_hash = ?
       AND paying_since IS NOT NULL AND paying_since <= ? AND changes() = 1`,
  ).bind(i.listing_id, i.wallet_row_id, i.wallet_row_hash, row.created_at);
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
export async function markRefused(env: Env, key: ClaimKey, reason: string, owner: string, now: number, release?: ClaimRow): Promise<boolean> {
  return terminate(
    env,
    env.DB.prepare(
      `UPDATE settlement_claims SET state = 'refused', rpc_body = NULL, verdict_reason = ?, lease_owner = NULL, leased_until = NULL, updated_at = ? WHERE ${KEY_WHERE} AND state = 'pending' AND ${HOLDS_LEASE}`,
    ).bind(reason, now, ...keyArgs(key), ...holdsLeaseArgs(owner, now)),
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

// An unknown outcome leaves the row pending; this records the last thing the
// facilitator said (already served once, clipped) and lets go of the lease so an
// identical re-send can reconcile at once.
export async function noteUnknown(env: Env, key: ClaimKey, reason: string, owner: string, now: number): Promise<void> {
  await env.DB.prepare(
    `UPDATE settlement_claims SET verdict_reason = ?, updated_at = ?, lease_owner = NULL, leased_until = NULL WHERE ${KEY_WHERE} AND state = 'pending' AND ${HOLDS_LEASE}`,
  )
    .bind(reason.slice(0, 400), now, ...keyArgs(key), ...holdsLeaseArgs(owner, now))
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
export async function runBookingStep(env: Env, key: ClaimKey, step: BookingStep, owner: string, now: number): Promise<{ applied: boolean }> {
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
      return { applied: last.meta.changes === 1 };
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

export function claimIsSecretRegistration(row: ClaimRow): boolean {
  return row.route === "register" && intentOf(row).public_key == null;
}

export const SECRET_LOST_NOTE =
  "your seat exists; a response containing its secret was issued, but the secret cannot be recovered. Reach the maintainer with this tx (a free showhome note: POST /api/showhome/enter, then POST /api/showhome/note). For any future registration, send a public_key.";

// The answer for a request that matched (or collided with) an existing claim and
// that no route finisher took over. `reqs` is only for the 402 shapes that invite
// a fresh signature (refused, expired). B9: every answer names the tx when one is
// known and invites a second signature ONLY for refused and expired.
export function claimAnswer(row: ClaimRow, identical: boolean, reqs: unknown, opts: { leaseHeld?: boolean; detail?: string } = {}): ClaimAnswer {
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
      return {
        status: 402,
        body: { x402Version: 1, error: row.verdict_reason ?? "The facilitator recorded a refusal of this settlement. By its account no money moved.", accepts: [reqs] },
      };
    case "expired":
      return {
        status: 402,
        body: {
          x402Version: 1,
          error: "This authorisation expired unused: the chain shows its nonce was never spent, and it can no longer move money. Nothing was charged. Sign a fresh one.",
          accepts: [reqs],
        },
      };
    case "pending":
      return {
        status: 502,
        body: {
          error: `The outcome of this payment is still unknown${txPart(row)}: the settle request was sent and whether the money moved is not yet established. Do not sign again; this request changed nothing. ${
            opts.leaseHeld ? (row.route === "listing_pay" ? "Another attempt to resolve it is in progress. " : "Another attempt to resolve it is in progress; repeat this identical request in a few minutes. ") : ""
          }${opts.detail ? `${opts.detail} ` : ""}${reconcileTail(row.route)}`,
          code: SETTLEMENT_UNRESOLVED,
        },
      };
    case "settled_unbooked":
      if (isHandleTaken(row)) return { status: 409, body: { error: handleTakenMessage(row), code: REGISTRATION_HANDLE_TAKEN_AFTER_PAYMENT } };
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
