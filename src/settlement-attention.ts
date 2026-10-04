// C7 (drafts/BRIEF-PAID-PATH-M3-2026-10-02.md, R2-3; Ben's 1 Oct note): the one public read of the settlement claims a PERSON must look at, GET /api/settlements/attention, and the count
// /api/official serves beside the payments book. A LEAF module on purpose: it imports nothing at runtime, so society.ts (officialFacts) and index.ts can both use it without a cycle with
// settlement-claims.ts (which imports society.ts). The marker strings the claim table carries in `verdict_reason` live HERE and settlement-claims.ts re-exports them, so the writers and
// this reader read one definition.
//
// What it serves is fixed: `route`, `state`, `marker` (ONLY a code from ATTENTION_MARKER_CODES, derived in SQL, so `verdict_reason` text never leaves the database in this query),
// `tx` when known, `created_at`, `updated_at` and `nonce` (the authorisation's own nonce, public on chain: a payer finds its row by tx or nonce). Never `rpc_body`, `intent_json`,
// `from_addr`, `payer`, `verdict_reason`. The `SELECT` names its columns; there is no `SELECT *` anywhere on this path.

// ---------- the markers the claim table carries (verdict_reason) ----------

// C5: a listing_pay claim that is settled_unbooked while its listing no longer holds its reservation.
export const CLAIM_LISTING_NOT_PAYING = "listing_not_paying";
// F1: a registration whose handle another seat took between settlement and the citizen write.
export const CLAIM_HANDLE_TAKEN = "handle_taken";
// C1: a refused or expired claim that met a settlement_contradiction, stamped `settlement_contradiction:<tx>|<original reason, clipped>`.
export const CONTRADICTION_MARKER = "settlement_contradiction:";
// C4, option B: a PENDING claim the chain reads used, stopped for a person, stamped `chain_spent_facilitator_refused:<reason, clipped>`.
export const CHAIN_SPENT_MARKER = "chain_spent_facilitator_refused:";

// ---------- the served allowlist ----------

// Rows older than this many days (from the claim's creation) in a state that should have moved on are listed too. Ben's note suggested three; the brief's choice 4 left it to the build.
export const ATTENTION_AGED_DAYS = 3;
// The PAGE size: the most rows one response carries. It is not a cap on the list. A response says whether more follow (`has_more`), where the next page starts (`next`, to be sent back as
// `?after=`) and how many rows are eligible in all (`total`); /api/official's count is that `total`, never the page's length, so no eligible row is hidden beyond the page size.
export const ATTENTION_LIMIT = 500;

export const ATTENTION_MARKER_CODES = [
  "settlement_contradiction",
  "chain_spent_facilitator_refused",
  "listing_not_paying",
  "registration_handle_taken",
  "settled_unbooked_aged",
  "pending_aged",
] as const;
export type AttentionMarker = (typeof ATTENTION_MARKER_CODES)[number];

export const ATTENTION_MARKER_MEANINGS: Record<AttentionMarker, string> = {
  settlement_contradiction:
    "The facilitator reported a settlement for a signed authorisation whose claim the society had already recorded as refused or expired. The money may have moved: whether it did is not established, and a person checks the chain by hand.",
  chain_spent_facilitator_refused:
    "The chain reads this signed authorisation as used (spent, or cancelled by its signer) while the society could not complete the payment: the facilitator reported a refusal of it, or the bounty's listing no longer holds the reservation the payment was made under. The society cannot tell which transaction used it, so it has stopped retrying automatically and a person checks the chain by hand.",
  listing_not_paying:
    "A bounty payment settled, but the listing it was made against no longer holds its reservation, so it cannot be recorded against that listing. The society has set it aside rather than retry it, and a person decides what to do with it.",
  registration_handle_taken:
    "A registration payment settled, but another seat took the handle before the seat could be written, so no seat was created. Re-sending the request cannot book it, and a person decides what to do with it.",
  settled_unbooked_aged: `A payment settled and the society's booking of it has not finished after ${ATTENTION_AGED_DAYS} days.`,
  pending_aged: `The outcome of a payment has not been established after ${ATTENTION_AGED_DAYS} days: the facilitator's answer was unknown and the chain has not settled the question. This also covers a claim admitted before the validBefore bound existed.`,
};

export interface AttentionEntry {
  route: string;
  state: string;
  marker: AttentionMarker;
  tx: string | null;
  created_at: number;
  updated_at: number;
  nonce: string;
}

// One marker per row, in this priority: a specific marker beats an age marker, so a row listed for two reasons appears once, under the more specific one. The marker is derived in
// SQL; `verdict_reason` is read only inside the query and never selected out of it. The list page and the total are two statements over THIS ONE marked selection (the same text, the same
// bindings), so what the total counts and what the pages serve cannot drift.
const MARKED = `(
  SELECT route, state, tx, created_at, updated_at, nonce,
    CASE
      WHEN state IN ('refused', 'expired') AND substr(COALESCE(verdict_reason, ''), 1, ?) = ? THEN 'settlement_contradiction'
      WHEN state = 'pending' AND substr(COALESCE(verdict_reason, ''), 1, ?) = ? THEN 'chain_spent_facilitator_refused'
      WHEN state = 'settled_unbooked' AND verdict_reason = ? THEN 'listing_not_paying'
      WHEN state = 'settled_unbooked' AND verdict_reason = ? THEN 'registration_handle_taken'
      WHEN state = 'settled_unbooked' AND created_at <= ? THEN 'settled_unbooked_aged'
      WHEN state = 'pending' AND created_at <= ? THEN 'pending_aged'
    END AS marker
  FROM settlement_claims
)`;
const markedBinds = (now: number): unknown[] => {
  const agedBefore = now - ATTENTION_AGED_DAYS * 86_400_000;
  return [CONTRADICTION_MARKER.length, CONTRADICTION_MARKER, CHAIN_SPENT_MARKER.length, CHAIN_SPENT_MARKER, CLAIM_LISTING_NOT_PAYING, CLAIM_HANDLE_TAKEN, agedBefore, agedBefore];
};

// The paging cursor: "<created_at>:<nonce>" of the last row of a page. Rows are served in (created_at, nonce) order and a cursor returns the rows STRICTLY after it. A string that is not exactly
// that shape is not a cursor (null); the route answers it with a 400. (Known limit: two claims by different signers with the very same created_at millisecond AND the very same nonce would
// tie on the cursor and the second could be skipped between pages; a nonce is 32 random bytes, so this needs a deliberate collision.)
export interface AttentionCursor {
  createdAt: number;
  nonce: string;
}
export function parseAttentionCursor(s: string): AttentionCursor | null {
  if (!/^[0-9]{1,16}:0x[0-9a-f]{64}$/.test(s)) return null;
  const createdAt = Number(s.slice(0, s.indexOf(":")));
  return Number.isSafeInteger(createdAt) ? { createdAt, nonce: s.slice(s.indexOf(":") + 1) } : null;
}
export const attentionCursorOf = (e: Pick<AttentionEntry, "created_at" | "nonce">): string => `${e.created_at}:${e.nonce}`;

// One page: up to ATTENTION_LIMIT rows strictly after `after` (if given), and whether another row follows (LIMIT + 1 is fetched to know).
export async function attentionPage(db: D1Database, now: number, after: AttentionCursor | null = null): Promise<{ entries: AttentionEntry[]; hasMore: boolean }> {
  const where = after === null ? "" : " AND (created_at > ? OR (created_at = ? AND nonce > ?))";
  const afterBinds = after === null ? [] : [after.createdAt, after.createdAt, after.nonce];
  const { results } = await db
    .prepare(`SELECT route, state, tx, created_at, updated_at, nonce, marker FROM ${MARKED} WHERE marker IS NOT NULL${where} ORDER BY created_at ASC, nonce ASC LIMIT ?`)
    .bind(...markedBinds(now), ...afterBinds, ATTENTION_LIMIT + 1)
    .all<{ route: string; state: string; tx: string | null; created_at: number; updated_at: number; nonce: string; marker: AttentionMarker }>();
  const hasMore = results.length > ATTENTION_LIMIT;
  const entries = results.slice(0, ATTENTION_LIMIT).map((r) => ({ route: r.route, state: r.state, marker: r.marker, tx: r.tx === null || r.tx === "" ? null : r.tx, created_at: r.created_at, updated_at: r.updated_at, nonce: r.nonce }));
  return { entries, hasMore };
}

// Every eligible row, whatever the page: the number /api/official serves beside the payments book.
export async function attentionTotal(db: D1Database, now: number): Promise<number> {
  const r = await db.prepare(`SELECT COUNT(*) AS n FROM ${MARKED} WHERE marker IS NOT NULL`).bind(...markedBinds(now)).first<{ n: number }>();
  return r?.n ?? 0;
}

export async function settlementsAttention(db: D1Database, after: AttentionCursor | null = null, now = Date.now()) {
  const { entries, hasMore } = await attentionPage(db, now, after);
  const total = await attentionTotal(db, now);
  return {
    note: "The settlement claims a person must look at: payments whose outcome the society's automatic steps could not settle. This list is the maintainer's queue, not a promise: no resolution time is promised for any row on it. Whoever paid finds their own row by its tx or its authorisation's nonce. Rows carry no wallet address and no request content; only the fields listed here are served. The list is paged, oldest first: count is the rows in this response (at most limit), total is every eligible row, has_more says whether more follow, and next, when has_more is true, is the value to send back as ?after= for the next page.",
    aged_after_days: ATTENTION_AGED_DAYS,
    limit: ATTENTION_LIMIT,
    markers: ATTENTION_MARKER_MEANINGS,
    count: entries.length,
    total,
    has_more: hasMore,
    next: hasMore ? attentionCursorOf(entries[entries.length - 1]) : null,
    entries,
  };
}
