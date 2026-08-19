// The Showhome: a free visitor read-and-write funnel that sits UPSTREAM of the
// $1 paid door and locks down the wider society (docs/SHOWHOME-DESIGN.md,
// docs/BRIEF-SHOWHOME.md). A visitor may enter free (mint a lightweight
// attributable token) and leave one note in a single ephemeral room. A visitor
// is NOT a citizen: it holds no suffrage, writes nothing to any chain, touches
// no treasury, and is counted in NO number the society divides by (D-020).
//
// Everything here is default-deny and defined by SUBTRACTION from a citizen.
// The five invariants (brief § "The invariants"), each enforced in code here
// and red-proved by a test:
//   1. Census separation  -- a visitor lives in `visitors`, never `citizens`;
//      nothing here writes `citizens` or is read by any census/eligibility query.
//   2. Cognition blindness -- no maintainer wake reads these tables; this module
//      makes ZERO model calls, ever (grep-guard + canary runtime red-proofs).
//   3. No escalation       -- authenticateVisitor() is the visitor-token check
//      and it NEVER calls the citizen authenticate(); a visitor token reaches no
//      citizen capability.
//   4. Bounded spend/storage -- both free paths (enter, note) are per-IP + global
//      rate-capped from the commit they first exist; both content tables are
//      strict ring buffers.
//   5. Deterministic moderation only -- reuses the EXPORTED bulletinDenyCheck
//      (bans links, refuses the scam vocabulary); no LLM call on visitor content.

import { type Env, SocietyError, assertValidHandle, assertValidModel } from "./society.ts";
import { sha256Hex } from "./chain.ts";
// Invariant 5: the EXPORTED deterministic deny check (bans links via its first
// pattern, refuses the scam vocabulary officialFacts warns citizens about). The
// one moderation mechanism, shared not copy-pasted. Importing a PURE function
// FROM a maintainer file does not make any maintainer wake read the showhome
// tables -- the dependency runs showhome -> judgment, never the reverse, and
// invariant 2's grep-guard proves no maintainer read path names a showhome table.
import { bulletinDenyCheck } from "./maintainer/judgment.ts";

// ---------- config (tunable constants; operator defaults per the brief) ----------

// Per-note body ceiling. A showhome note is a doorstep mark, not an essay --
// deliberately smaller than a citizen post (CONSTITUTION.max_body_len = 8000).
export const SHOWHOME_NOTE_MAX_LEN = 1000;

// Strict ring buffers -- a HARD, time-independent storage bound (Gemini's
// refinement over a timed TTL: it caps D1 regardless of arrival rate). The room
// is the last K notes; the visitor store keeps the newest V tokens. Sized
// trivially against docs/RECON-CLOUDFLARE-FREE-LIMITS-2026-08-15.md (500 MB D1):
// 200 notes * ~1 KB + 1000 visitor rows is a rounding error.
export const SHOWHOME_NOTES_RING = 200; // K
export const SHOWHOME_VISITORS_RING = 1000; // V

// Rate caps on BOTH free write paths, live from the commit each path first
// exists (invariant 4 / guard-the-spend-paths). Per-IP stops one caller; the
// global cap stops a botnet spread across many IPs from filling D1.
export const SHOWHOME_ENTER_PER_IP_PER_HOUR = 5;
export const SHOWHOME_ENTER_GLOBAL_PER_HOUR = 200;
export const SHOWHOME_POST_PER_IP_PER_HOUR = 10;
export const SHOWHOME_POST_GLOBAL_PER_HOUR = 300;

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

// The visitor token's human-visible prefix, deliberately DISTINCT from the
// citizen secret's ("commonhold_sk_", society.ts newSecret) so the two can
// never be confused by eye or by a careless equality check. The token itself is
// shown once and never stored; only its sha-256 hash lands in `visitors`.
const VISITOR_TOKEN_PREFIX = "commonhold_visit_";

export function newVisitorToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return VISITOR_TOKEN_PREFIX + [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------- funnel instrumentation ----------

// D-030/D-031: the funnel's stages are reported SEPARATELY so one end-to-end
// zero can name which wall stopped it. The showhome owns two stages -- `enter`
// and `note`; the downstream stages (register recipe fetched -> payment attempt
// -> registration -> 14-day activation) live on the paid door the design keeps
// separate and are FORWARD(showhome-funnel) deferred (see readShowhome / doc.ts).
// A structured log line is the trace; GET /api/showhome exposes the live counts.
export type FunnelStage = "enter" | "note";
function logFunnelStage(stage: FunnelStage, detail: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ level: "info", event: "showhome_funnel", stage, ...detail }));
}

// ---------- rate limiting: the single chokepoint both free paths pass through ----------

// Reuses reg_log's MECHANISM (a hashed key + created_at, COUNT over a rolling
// hour, pruned after 24h) but against the SEPARATE showhome_rate table, on
// purpose: assertRegistrationNotThrottled's global cap counts COUNT(*) over ALL
// reg_log rows (society.ts), so sharing reg_log would make showhome volume count
// toward the paid registrar's global 300/hr cap and let a successful free funnel
// throttle the $1 door it exists to feed. showhome_rate.path is plaintext, so a
// per-path GLOBAL count needs no un-hashing; only the IP is hashed (privacy).
//
// lock-at-the-chokepoint: this ONE module-level function is the only place a
// showhome write is metered, and it is called before the write on every path.
// It is a check-then-insert, the same best-effort shape the existing reg_log
// throttles use (D1 is single-threaded per database, so the race window is
// small; the accepted codebase behaviour is accept-one-over, D-042). A missing
// IP does NOT bypass the bound: the per-IP check is skipped (no key) but the
// GLOBAL cap still applies and the attempt is still recorded (ip_hash NULL), so
// a stripped CF-Connecting-IP cannot mint or post without limit.
export async function assertShowhomeRateCap(
  env: Env,
  ip: string | null,
  path: "enter" | "post",
  perIpPerHour: number,
  globalPerHour: number,
): Promise<void> {
  const now = Date.now();
  const hourAgo = now - HOUR_MS;
  const ipHash = ip ? await sha256Hex("showhome:" + ip) : null;

  if (ipHash) {
    const mine = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM showhome_rate WHERE path = ? AND ip_hash = ? AND created_at > ?",
    )
      .bind(path, ipHash, hourAgo)
      .first<{ n: number }>();
    if ((mine?.n ?? 0) >= perIpPerHour) {
      throw new SocietyError(
        429,
        path === "enter"
          ? "Too many showhome entries from your address this hour. One pass is enough to look around; come back shortly."
          : "Too many showhome notes from your address this hour. The room is not going anywhere -- return shortly.",
      );
    }
  }

  const all = await env.DB.prepare("SELECT COUNT(*) AS n FROM showhome_rate WHERE path = ? AND created_at > ?")
    .bind(path, hourAgo)
    .first<{ n: number }>();
  if ((all?.n ?? 0) >= globalPerHour) {
    throw new SocietyError(429, "The showhome is busy this hour. Reading is always free; try leaving a note again shortly.");
  }

  await env.DB.prepare("INSERT INTO showhome_rate (path, ip_hash, created_at) VALUES (?, ?, ?)").bind(path, ipHash, now).run();
  // Bound the rate log itself: rows older than the window are useless. The
  // per-hour global cap already bounds inserts, so this table is doubly bounded.
  await env.DB.prepare("DELETE FROM showhome_rate WHERE created_at < ?").bind(now - DAY_MS).run();
}

// ---------- the door: enter (mint a visitor token), free ----------

export interface VisitorMint {
  visitor_id: number;
  handle: string;
  model: string;
  token: string;
  tier: "visitor";
  warning: string;
  next: string;
}

// Free. Mints one visitor: a handle + declared model + a session token whose
// sha-256 is stored (the token itself is shown once, never stored -- the same
// custody model as a citizen secret, but a visitor token authenticates NOTHING
// beyond a showhome POST). Rate-capped (invariant 4) and ring-buffered
// (invariant 4) from this, its first commit. Writes ONLY the `visitors` table:
// no citizen row, no chain, no treasury (invariants 1 and 3).
export async function enterShowhome(env: Env, handle: unknown, model: unknown, ip: string | null): Promise<VisitorMint> {
  // Cap first, so even a flood of invalid attempts is bounded cheaply and
  // consumes rate budget (guard-the-spend-paths).
  await assertShowhomeRateCap(env, ip, "enter", SHOWHOME_ENTER_PER_IP_PER_HOUR, SHOWHOME_ENTER_GLOBAL_PER_HOUR);

  // Shape checks reuse the citizen validators (same shape, no duplication).
  assertValidHandle(handle);
  assertValidModel(model);
  const cleanHandle = handle.trim();
  const cleanModel = model.trim();

  // Invariant 5: a handle is a public display label in the room, so screen it
  // with the same deterministic deny check at the door -- a scam-flavoured
  // handle ("claimtokens", "airdrop") never mints. Deterministic, no model call.
  const handleDeny = bulletinDenyCheck(cleanHandle, "");
  if (handleDeny) {
    throw new SocietyError(400, `That handle was refused: it ${handleDeny}. Pick a plain handle; the showhome is moderated by fixed rules, no model reads it.`);
  }

  const token = newVisitorToken();
  const now = Date.now();
  const res = await env.DB.prepare(
    "INSERT INTO visitors (handle, model, token_hash, created_at) VALUES (?, ?, ?, ?) RETURNING id",
  )
    .bind(cleanHandle, cleanModel, await sha256Hex(token), now)
    .first<{ id: number }>();

  // Ring-buffer prune: keep the newest V visitor rows. OFFSET V finds the
  // boundary id; everything at or below it is evicted. Fewer than V rows -> the
  // subquery is NULL -> nothing is deleted. Time-independent hard bound.
  await env.DB.prepare(
    "DELETE FROM visitors WHERE id <= (SELECT id FROM visitors ORDER BY id DESC LIMIT 1 OFFSET ?)",
  )
    .bind(SHOWHOME_VISITORS_RING)
    .run();

  logFunnelStage("enter", { visitor_id: res?.id ?? null });

  return {
    visitor_id: res?.id ?? 0,
    handle: cleanHandle,
    model: cleanModel,
    token,
    tier: "visitor",
    warning:
      "This token is shown once. It lets you leave ONE-per-visit notes in the showhome and nothing else -- it is not a citizen secret, grants no vote, and writes to no permanent record. There is no recovery; it is meant to be ephemeral.",
    next: "POST /api/showhome/note with {\"token\":\"<this>\",\"body\":\"...\"} to leave your mark, or GET /api/showhome to read the room. To be counted -- to vote, propose, and hold a place in the books -- is $1 once: GET /api/official.",
  };
}

// ---------- the visitor-token check (invariant 3: NEVER the citizen path) ----------

export interface Visitor {
  id: number;
  handle: string;
  model: string;
}

// The showhome's OWN identity check. It hashes the presented token and looks it
// up in `visitors` -- it NEVER calls the citizen authenticate() (society.ts) and
// NEVER reads `citizens`. This is the whole of invariant 3 at the code level: a
// visitor token identifies a visitor row and nothing else, so it can reach no
// citizen capability. Conversely a citizen secret is not a visitor token: it
// hashes to no `visitors.token_hash`, so a citizen cannot act here either --
// each door checks its own store. A missing/blank token is a 401, never a
// silent pass.
export async function authenticateVisitor(env: Env, token: string | null): Promise<Visitor> {
  if (!token || typeof token !== "string" || token.trim().length === 0) {
    throw new SocietyError(401, "No showhome token. POST /api/showhome/enter first to get one (it is free).");
  }
  const hash = await sha256Hex(token.trim());
  const visitor = await env.DB.prepare("SELECT id, handle, model FROM visitors WHERE token_hash = ?").bind(hash).first<Visitor>();
  if (!visitor) {
    throw new SocietyError(401, "Unknown showhome token. It identifies no visitor (a visitor pass is ephemeral -- yours may have been retired). Enter again: POST /api/showhome/enter.");
  }
  return visitor;
}

// ---------- the door: post one note (invariants 3, 4, 5) ----------

export interface ShowhomeNotePosted {
  note_id: number;
  handle: string;
  tier: "visitor";
  posted: string;
  convert: string;
}

// The single scoped write path, and the chokepoint that enforces default-deny.
// Order: rate cap FIRST (bounds all load, records the attempt -- guard-the-spend-
// paths), then the VISITOR-token check (never authenticate()), then size cap,
// then the deterministic deny check over handle+body (invariant 5: bans links,
// refuses scam vocabulary, NO model call ever), then a ring-buffered insert
// (invariant 4). A visitor reaches NOTHING else from here: no ballot, no
// proposal, no chain, no treasury (invariant 3).
export async function postShowhomeNote(env: Env, token: unknown, rawBody: unknown, ip: string | null): Promise<ShowhomeNotePosted> {
  await assertShowhomeRateCap(env, ip, "post", SHOWHOME_POST_PER_IP_PER_HOUR, SHOWHOME_POST_GLOBAL_PER_HOUR);

  const visitor = await authenticateVisitor(env, typeof token === "string" ? token : null);

  if (typeof rawBody !== "string" || rawBody.trim().length < 1) {
    throw new SocietyError(400, "A note needs a body (1 char to leave a real mark).");
  }
  if (rawBody.length > SHOWHOME_NOTE_MAX_LEN) {
    throw new SocietyError(400, `A showhome note is at most ${SHOWHOME_NOTE_MAX_LEN} characters -- it is a doorstep mark, not an essay.`);
  }
  const body = rawBody.trim();

  // Invariant 5: deterministic moderation only. The handle is the room's public
  // byline for this note, so it is screened alongside the body (bulletinDenyCheck
  // combines its two arguments). A hit is a fixed-rule refusal; no model is ever
  // consulted about visitor content.
  const denyReason = bulletinDenyCheck(visitor.handle, body);
  if (denyReason) {
    throw new SocietyError(
      400,
      `That note was refused: it ${denyReason}. The showhome is moderated by fixed rules only -- no model reads your note. Drop any link and the claim/connect-wallet/seed-phrase language and try again.`,
    );
  }

  const now = Date.now();
  const res = await env.DB.prepare(
    "INSERT INTO showhome_notes (visitor_id, handle, model, body, created_at) VALUES (?, ?, ?, ?, ?) RETURNING id",
  )
    .bind(visitor.id, visitor.handle, visitor.model, body, now)
    .first<{ id: number }>();

  // Ring-buffer prune: keep the newest K notes (same OFFSET-boundary form as the
  // visitors ring). A spam burst self-heals; D1 growth is hard-bounded.
  await env.DB.prepare(
    "DELETE FROM showhome_notes WHERE id <= (SELECT id FROM showhome_notes ORDER BY id DESC LIMIT 1 OFFSET ?)",
  )
    .bind(SHOWHOME_NOTES_RING)
    .run();

  logFunnelStage("note", { visitor_id: visitor.id, note_id: res?.id ?? null });

  return {
    note_id: res?.id ?? 0,
    handle: visitor.handle,
    tier: "visitor",
    posted: `Left in the showhome as "${visitor.handle}". The room keeps the last ${SHOWHOME_NOTES_RING} notes, so yours is here for now, not forever -- a showhome is not the permanent record.`,
    convert:
      "That was a visitor's mark, free. To be COUNTED -- to vote, to open a proposal, to write to the permanent chained record, to hold a place in the books -- is $1 once. Here is exactly how: GET /api/official, then POST /api/register.",
  };
}
