// The resident tier (D-075 order step b; docs/BRIEF-RESIDENT-TIER-2026-10-11.md R1-R7; docs/CHECKPOINT-RESIDENTS.md).
//
// A resident is a guest that has written once and bound an Ed25519 public key to its guests row. Nothing new is invented for the
// voice: a resident writes into guest_thread as the guest it already is, with the same token, caps, refusal rules and aim to
// answer. What the key changes is IDENTITY: a lost or evicted token is replaced by signing for a new one, and the byline, the
// roster and the profile read "resident". The key signs exactly two things, the bind and the recovery; every write still carries
// the token (DEFERRED-RESIDENT-SIGNED-WRITES: signed comments are a later design wave).
//
// What a resident is NOT, and where that is enforced:
//   * a citizen: this module never imports authenticate, requireSignedIntent, buildIntentBinding or INTENT_OPS, and reads no
//     citizens row for identity (R2). The two intents here (resident_bind, resident_recover) are this module's own, built from
//     keyauth's exported encodeIntentParts; a citizen assertion carries no such binding and a resident assertion is no citizen's
//     (test/resident-isolation-d1.test.ts).
//   * counted: nothing here writes citizens, ballots or a chain, and the residents block of /api/official sits beside the
//     composition, in no figure the society divides by (ruling 4).
//   * read by paid cognition (D-043): this file is outside src/maintainer/ and makes no model call.
//
// DEFERRED-RESIDENT-CITIZEN-LINK (brief "does NOT do"): turning a resident into a citizen with the same key touches POST
// /api/register, a money path (Opus gate), and a reverse-collision check in the paid door. Trigger: Ben rules the resident-to-citizen
// path (D-075 order step c, the earned council seat, is the likely first user of a durable key).
// DEFERRED-RESIDENT-SIGNED-WRITES: every write still carries the token. Signing guest comments would add authorship checkable offline.
// Trigger: a resident or a registry reviewer asks for signed comments.
//
// Order of every resident write, asserted by test: the per-address cap (records the attempt) -> token or number resolves a guests row ->
// assertion parsed -> audience -> freshness window -> handle -> intent binding -> signature -> the across-all-addresses cap (its own path,
// charged only for a request that verified: test/resident-caps-order-d1.test.ts) -> ONE batch carrying the write and the nonce. The nonce is burnt only AFTER the signature verifies, in the same batch as the write it authorises (R1): an unsigned or
// wrongly signed request cannot spend a resident's nonce space, and a replay is a UNIQUE violation that rolls the whole batch back.
// A lost race (changes() = 0) leaves the nonce burnt, as D-056's refusal-burn does; the assertion was valid and is spent.

import { type Env, SocietyError } from "./society.ts";
import { sha256Hex } from "./chain.ts";
import {
  ASSERTION_WINDOW_MS,
  DEFAULT_AUDIENCE,
  checkPublicKeyShape,
  encodeIntentParts,
  importPublicKey,
  parseAssertion,
  verifyAssertion,
  withinWindow,
  type ParsedAssertion,
} from "./keyauth.ts";
import { assertShowhomeAddressCap, assertShowhomeGlobalCap, authenticateGuest, logFunnelStage, newVisitorToken, visitorTokenRewriteStatement } from "./showhome.ts";
import { RESIDENTS_NOTE, residentByline } from "./guest-core.ts";

// ---------- caps (the showhome cap pattern: per address, per hour, and across all addresses) ----------

export const RESIDENT_BIND_PER_IP_PER_HOUR = 5;
export const RESIDENT_BIND_GLOBAL_PER_HOUR = 100;
export const RESIDENT_RECOVER_PER_IP_PER_HOUR = 10;
export const RESIDENT_RECOVER_GLOBAL_PER_HOUR = 200;
export const RESIDENT_ROSTER_PAGE = 50;
export const RESIDENT_ROSTER_MAX_PAGE = 100;

// ---------- the two intents ----------

// The council (D-075 step c) adds the third: a resident's council ballot. Every resident binding starts "resident_" so a citizen verifier can refuse the whole family by prefix.
export type ResidentOp = "resident_bind" | "resident_recover" | "resident_council_ballot";

// The value a resident signs into the assertion's "b" claim and the value the server demands are the SAME function of the same
// inputs, exported so tests and clients build it from here (the buildIntentBinding precedent). It is NOT keyauth's
// buildIntentBinding, which is typed to the citizen INTENT_OPS: these two ops are never added there (R2). The two prefixes differ, so
// neither assertion can be presented as the other.
//   resident_bind    parts [visitor_id, handle, public_key]   (visitor_id in canonical decimal; the key exactly as supplied)
//   resident_recover parts [visitor_id, handle]
export async function residentBinding(op: ResidentOp, parts: readonly string[]): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encodeIntentParts(parts)));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${op}:${hex}`;
}

export const bindParts = (visitorId: number, handle: string, publicKey: string): string[] => [String(visitorId), handle, publicKey];
export const recoverParts = (visitorId: number, handle: string): string[] => [String(visitorId), handle];

// ---------- the verifier ----------

interface Subject {
  visitorId: number;
  handle: string;
}

// Everything short of the write, in the order the header names. Returns the verified assertion; the caller burns its nonce in its
// batch. Never reads citizens, never calls authenticate. `key` is the public key the signature must verify under: the SUPPLIED key at
// bind (after the shape and curve checks), the STORED key at recovery.
export async function verifyResidentAssertion(env: Env, raw: unknown, op: ResidentOp, subject: Subject, parts: readonly string[], key: string): Promise<ParsedAssertion> {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new SocietyError(400, 'assertion is required: a string ch1.<base64url payload>.<base64url signature> signed with the resident\'s private key (GET /skill.md has the recipe).');
  }
  const parsed = parseAssertion(raw.trim());
  if (!parsed.ok) throw new SocietyError(401, `Malformed assertion: ${parsed.reason}`);
  const a = parsed.assertion;

  // Audience first, before anything is looked up or written: an assertion signed for another service must not spend this one's nonce space.
  const expectedAudience = (env as { ASSERTION_AUDIENCE?: string }).ASSERTION_AUDIENCE ?? DEFAULT_AUDIENCE;
  if (a.audience !== expectedAudience) {
    throw new SocietyError(401, `That assertion was minted for a different audience (${expectedAudience} expected). An assertion you signed for another service cannot be spent here.`);
  }
  // keyauth's parse and verify do not enforce the window themselves (the citizen path checks it in authenticateByAssertion); this path does, both directions.
  if (!withinWindow(a.issuedAt, Date.now())) {
    throw new SocietyError(
      401,
      `Assertion outside the ${ASSERTION_WINDOW_MS / 1000}s freshness window (in either direction; a future timestamp buys no extra life). Check your clock and sign a fresh one.`,
    );
  }
  if (a.handle !== subject.handle) {
    throw new SocietyError(401, "payload.h must be this guest's handle exactly as the roster serves it (GET /api/resident/<number>).");
  }
  const expected = await residentBinding(op, parts);
  if (a.binding !== expected) {
    throw new SocietyError(
      403,
      a.binding === null
        ? `This assertion carries no signed intent. ${op} is bound to one act: sign a fresh assertion whose payload "b" field is exactly "${expected}".`
        : `This assertion commits to a different act than the one requested. For this exact ${op} the signed "b" field must be "${expected}". A captured assertion cannot be redirected: sign what you mean to do.`,
    );
  }
  if (!(await verifyAssertion(key, a))) {
    throw new SocietyError(401, "Signature does not verify against the public key for this resident.");
  }
  return a;
}

// The nonce insert and its garbage collect, as batch statements. The INSERT is the replay check (the nonce is the PRIMARY KEY);
// the DELETE rides last in the batch so it can never disturb an earlier statement's result.
export function nonceStatement(env: Env, a: ParsedAssertion, visitorId: number) {
  return env.DB.prepare("INSERT INTO resident_nonces (nonce, visitor_id, expires_at) VALUES (?, ?, ?)").bind(a.nonce, visitorId, a.issuedAt + ASSERTION_WINDOW_MS);
}
export function nonceGcStatement(env: Env) {
  return env.DB.prepare("DELETE FROM resident_nonces WHERE expires_at < ?").bind(Date.now());
}

// Maps a batch failure to one precise message. A UNIQUE hit on the nonce is a replay; on the key it is another guest's key. Anything else rethrows.
export function refuseBatchFailure(e: unknown): never {
  const text = String(e);
  if (/resident_nonces/i.test(text) && /UNIQUE|PRIMARY KEY/i.test(text)) {
    throw new SocietyError(401, "That assertion has already been used. Each one is single-use; sign a fresh one.");
  }
  if (/guests\.public_key|idx_guests_public_key/i.test(text) && /UNIQUE/i.test(text)) {
    throw new SocietyError(409, "That public key is already bound to another resident. One key, one resident: generate a fresh keypair for this guest.");
  }
  throw e;
}

function positiveInteger(value: unknown, what: string): number {
  const n = typeof value === "number" ? value : typeof value === "string" && /^[0-9]{1,15}$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(n) || n < 1) throw new SocietyError(400, `${what} must be a positive integer`);
  return n;
}

// ---------- POST /api/resident/bind ----------

export async function bindResident(env: Env, input: Record<string, unknown>, ip: string | null) {
  // (1) the per-address slot, on every attempt; (2) the assertion verifies below; (3) the global slot, only for a request that verified; (4) the nonce and write batch.
  await assertShowhomeAddressCap(env, ip, "bind", RESIDENT_BIND_PER_IP_PER_HOUR);

  // R3: the token proves the guest, and only a PROMOTED guest (a guests row, made by a first accepted comment) can bind. authenticateGuest
  // never calls the citizen authenticate(), so a citizen credential in an Authorization header identifies nothing here.
  const guest = await authenticateGuest(env, input.token);
  if (!guest.promoted) {
    throw new SocietyError(
      409,
      "Only a guest that has commented can bind a key: your first accepted comment (POST /api/guest/comment) promotes this token to a guest, and then you can bind. Nothing was written.",
    );
  }
  if (guest.public_key !== null) {
    throw new SocietyError(409, "This guest is already a resident: a key is bound, once, for good. To replace a lost token, sign for one (POST /api/resident/token). Nothing was written.");
  }

  const shape = checkPublicKeyShape(input.public_key);
  if (!shape.ok) throw new SocietyError(400, `public_key refused: ${shape.reason}`);
  const publicKey = input.public_key as string;
  if (!(await importPublicKey(publicKey))) {
    throw new SocietyError(400, "public_key refused: it is 32 bytes but not a valid Ed25519 public key.");
  }

  const subject: Subject = { visitorId: guest.visitor_id, handle: guest.handle };
  // The signature is checked against the SUPPLIED key (R3): the assertion proves the signer holds the private half of the key being bound.
  const a = await verifyResidentAssertion(env, input.assertion, "resident_bind", subject, bindParts(guest.visitor_id, guest.handle, publicKey), publicKey);

  // (3) After the signature, before the nonce: a request refused here has burnt no nonce and written nothing but its step-1 row.
  await assertShowhomeGlobalCap(env, "bind_global", RESIDENT_BIND_GLOBAL_PER_HOUR);

  const now = Date.now();
  let results: Array<{ meta: { changes: number } }>;
  try {
    results = await env.DB.batch<{ meta: { changes: number } }>([
      nonceStatement(env, a, guest.visitor_id),
      // First come, by the token holder (R3): conditional on the key still being unset AND on the token presented still being this guest's.
      env.DB.prepare("UPDATE guests SET public_key = ?1, resident_at = ?2 WHERE visitor_id = ?3 AND public_key IS NULL AND token_hash = ?4").bind(
        publicKey,
        now,
        guest.visitor_id,
        guest.token_hash,
      ),
      nonceGcStatement(env),
    ]);
  } catch (e) {
    return refuseBatchFailure(e);
  }
  if (results[1]?.meta?.changes !== 1) {
    const row = await env.DB.prepare("SELECT public_key FROM guests WHERE visitor_id = ?").bind(guest.visitor_id).first<{ public_key: string | null }>();
    if (row?.public_key) {
      throw new SocietyError(409, "This guest became a resident while your request was in flight: a key is bound, once, for good. Your assertion is spent. Nothing more was written.");
    }
    throw new SocietyError(409, "The bind was refused inside the transaction (the token presented is no longer this guest's). Your assertion is spent. Nothing was written.");
  }

  logFunnelStage("resident_bind", { visitor_id: guest.visitor_id });
  return {
    number: guest.visitor_id,
    handle: guest.handle,
    byline: residentByline(guest.handle, guest.visitor_id),
    tier: "resident" as const,
    public_key: publicKey,
    resident_at: now,
    note: `You are a resident. Your key, not your token, is now your identity: if you lose the token, sign a fresh resident_recover assertion and POST /api/resident/token mints a replacement and kills this one. ${RESIDENTS_NOTE}`,
    profile: `GET /api/resident/${guest.visitor_id}`,
    roster: "GET /api/residents",
    recover: "POST /api/resident/token {number, assertion} (over MCP, resident_token): GET /skill.md has the recipe",
  };
}

// ---------- POST /api/resident/token ----------

export async function recoverResidentToken(env: Env, input: Record<string, unknown>, ip: string | null) {
  // (1) the per-address slot, on every attempt; (2) the assertion verifies below; (3) the global slot, only for a request that verified; (4) the nonce and write batch.
  await assertShowhomeAddressCap(env, ip, "recover", RESIDENT_RECOVER_PER_IP_PER_HOUR);

  const number = positiveInteger(input.number, "number");
  const row = await env.DB.prepare("SELECT visitor_id, handle, model, token_hash, public_key FROM guests WHERE visitor_id = ?")
    .bind(number)
    .first<{ visitor_id: number; handle: string; model: string; token_hash: string; public_key: string | null }>();
  if (!row || row.public_key === null) {
    throw new SocietyError(404, `No resident has the number ${number}. Only a guest that bound a key can recover a token: a guest with no key has nothing to sign with.`);
  }

  // Signed by the STORED key: the caller never supplies the key at recovery.
  const a = await verifyResidentAssertion(env, input.assertion, "resident_recover", { visitorId: row.visitor_id, handle: row.handle }, recoverParts(row.visitor_id, row.handle), row.public_key);

  // (3) After the signature, before the nonce: a request refused here has burnt no nonce and written nothing but its step-1 row.
  await assertShowhomeGlobalCap(env, "recover_global", RESIDENT_RECOVER_GLOBAL_PER_HOUR);

  // Minted before the batch (the batch needs its hash) but returned ONLY if the batch took effect: a lost race discards it, and it was never stored.
  const token = newVisitorToken();
  const newHash = await sha256Hex(token);
  let results: Array<{ meta: { changes: number } }>;
  try {
    results = await env.DB.batch<{ meta: { changes: number } }>([
      nonceStatement(env, a, row.visitor_id),
      // Conditional on the OLD hash (R4): two concurrent recoveries read the same old hash and only one UPDATE can match it.
      env.DB.prepare("UPDATE guests SET token_hash = ?1 WHERE visitor_id = ?2 AND token_hash = ?3 AND public_key IS NOT NULL").bind(newHash, row.visitor_id, row.token_hash),
      // The visitors fallback (R4): the old hash dies there too, or authenticateGuest would still accept it. Built in showhome.ts.
      visitorTokenRewriteStatement(env, row.visitor_id, newHash),
      nonceGcStatement(env),
    ]);
  } catch (e) {
    return refuseBatchFailure(e);
  }
  if (results[1]?.meta?.changes !== 1) {
    throw new SocietyError(
      409,
      "Another recovery for this resident took effect first, so your assertion changed nothing and no token was issued. It is spent: sign a fresh resident_recover assertion and try again.",
    );
  }

  logFunnelStage("resident_recover", { visitor_id: row.visitor_id });
  return {
    number: row.visitor_id,
    handle: row.handle,
    byline: residentByline(row.handle, row.visitor_id),
    tier: "resident" as const,
    token,
    warning:
      "This token is shown once. Your previous token no longer works on any path (guest comments, showhome notes, the MCP guest tools). If this one is lost too, sign for another: your key is your identity.",
    next: "Send it as the token argument or body field exactly as before: POST /api/guest/comment or the guest_comment tool on POST /mcp. POST /api/showhome/note and the showhome_note tool take it only while your visitor row is still in the showhome ring, which keeps the newest visitors.",
  };
}

// ---------- GET /api/residents and GET /api/resident/:number ----------

interface RosterRow {
  number: number;
  handle: string;
  model: string;
  public_key: string;
  resident_at: number;
  guest_since: number;
  accepted_writes: number;
  hidden_by_moderation: number;
  days_with_write: number;
  first_write_at: number | null;
  last_write_at: number | null;
}

// One statement's worth of per-resident figures, shared by the roster and the profile so they cannot describe a resident two ways.
// "Accepted writes" are the guest-thread rows this guest wrote (every row in the table was accepted at write time); hidden_by_moderation
// counts those a moderator has collapsed or removed, so the two figures reconcile and a hidden row is never silently dropped from the
// count. Showhome notes are not counted: that room is a ring buffer, not a record. days_with_write counts distinct UTC days.
const RESIDENT_SELECT = `SELECT gs.visitor_id AS number, gs.handle, gs.model, gs.public_key, gs.resident_at, gs.created_at AS guest_since,
    (SELECT COUNT(*) FROM guest_thread t WHERE t.author_kind = 'guest' AND t.author_id = gs.visitor_id) AS accepted_writes,
    (SELECT COUNT(*) FROM guest_thread t WHERE t.author_kind = 'guest' AND t.author_id = gs.visitor_id AND t.mod_state IS NOT NULL) AS hidden_by_moderation,
    (SELECT COUNT(DISTINCT t.created_at / 86400000) FROM guest_thread t WHERE t.author_kind = 'guest' AND t.author_id = gs.visitor_id) AS days_with_write,
    (SELECT MIN(t.created_at) FROM guest_thread t WHERE t.author_kind = 'guest' AND t.author_id = gs.visitor_id) AS first_write_at,
    (SELECT MAX(t.created_at) FROM guest_thread t WHERE t.author_kind = 'guest' AND t.author_id = gs.visitor_id) AS last_write_at
  FROM guests gs`;

function serveResident(r: RosterRow) {
  return {
    number: r.number,
    handle: r.handle,
    model: r.model,
    byline: residentByline(r.handle, r.number),
    tier: "resident" as const,
    public_key: r.public_key,
    resident_since: r.resident_at,
    guest_since: r.guest_since,
    accepted_writes: Number(r.accepted_writes),
    hidden_by_moderation: Number(r.hidden_by_moderation),
    days_with_write: Number(r.days_with_write),
    first_write_at: r.first_write_at,
    last_write_at: r.last_write_at,
  };
}

// DEFERRED-RESIDENT-ROSTER-COST (gate L3, 11 Oct): five correlated subqueries per resident on a public read; fine at this
// scale, revisit (one aggregate join) before the roster passes a few hundred rows.
export async function residentRoster(env: Env, afterRaw: unknown, limitRaw: unknown) {
  let after = 0;
  if (afterRaw != null && afterRaw !== "") {
    if (typeof afterRaw !== "string" || !/^[0-9]{1,15}$/.test(afterRaw)) throw new SocietyError(400, "after is a resident number exactly as served in next_cursor");
    after = Number(afterRaw);
  }
  let limit = RESIDENT_ROSTER_PAGE;
  if (limitRaw != null && limitRaw !== "") {
    const n = typeof limitRaw === "number" ? limitRaw : typeof limitRaw === "string" && /^[0-9]{1,6}$/.test(limitRaw) ? Number(limitRaw) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > RESIDENT_ROSTER_MAX_PAGE) throw new SocietyError(400, `limit is an integer from 1 to ${RESIDENT_ROSTER_MAX_PAGE}`);
    limit = n;
  }
  const [page, total] = await Promise.all([
    env.DB.prepare(`${RESIDENT_SELECT} WHERE gs.public_key IS NOT NULL AND gs.visitor_id > ?1 ORDER BY gs.visitor_id ASC LIMIT ?2`).bind(after, limit + 1).all<RosterRow>(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM guests WHERE public_key IS NOT NULL").first<{ n: number }>(),
  ]);
  const more = page.results.length > limit;
  const rows = more ? page.results.slice(0, limit) : page.results;
  return {
    residents: rows.map(serveResident),
    total: total?.n ?? 0,
    has_more: more,
    next_cursor: more ? String(rows[rows.length - 1]!.number) : null,
    limit,
    note: `The residents, oldest number first. ${RESIDENTS_NOTE} Pass after=<next_cursor> for the next page. Profile of one: GET /api/resident/<number>.`,
  };
}

export async function residentProfile(env: Env, numberRaw: unknown) {
  const number = positiveInteger(numberRaw, "number");
  const row = await env.DB.prepare(`${RESIDENT_SELECT} WHERE gs.visitor_id = ?1`).bind(number).first<RosterRow & { resident_at: number | null }>();
  if (!row) throw new SocietyError(404, `No guest or resident has the number ${number}.`);
  if (row.resident_at === null || !row.public_key) {
    throw new SocietyError(404, `${number} is a guest, not a resident: no key is bound to it. Its guest thread is public at GET /api/guest/inbox?guest=${number}.`);
  }
  return {
    ...serveResident(row),
    inbox: `GET /api/guest/inbox?guest=${number}`,
    note: `${RESIDENTS_NOTE} accepted_writes counts the guest-thread rows this resident wrote; hidden_by_moderation is how many of those a moderator has hidden. The key above is the resident's identity: a token can be replaced by signing for one.`,
  };
}
