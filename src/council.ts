// The council (D-075 order step c; docs/CHECKPOINT-COUNCIL.md). Membership by rule, the earned-seat challenge and claim, the room, the motions, and the
// readers. The pure parts (constants, the served sentences, the verdict of a motion) are in council-core.ts; the 1f916 verifier is in council-verify.ts.
//
// Membership is computed on every read from public data and the rows in council_claims; there is no stored member list to drift (K6). The three rules:
//   self_paid      a citizen on none of OPERATOR_CONTROLLED_HANDLES, SPONSORED_HANDLES or KEY_LOST_SEATS (society.ts)
//   operator_seat  COUNCIL_OPERATOR_SEAT, the operator's one seat (D-075 ruling 2)
//   earned         a resident holding a council_claims row (its key stays bound for good, so a seat is never lost by silence or by an outage, K4)

import { type Env, SocietyError, OPERATOR_CONTROLLED_HANDLES, SPONSORED_HANDLES, KEY_LOST_SEATS } from "./society.ts";
import { residentByline } from "./guest-core.ts";
import { assertShowhomeRateCap, authenticateGuest, type Guest } from "./showhome.ts";
import { newNonce } from "./keyauth.ts";
import { F916_ORIGIN, canonicalRecordId, verifyF916Claim, type FetchLike } from "./council-verify.ts";
import {
  COUNCIL_BALLOTS_SENTENCE,
  COUNCIL_CHALLENGE_GLOBAL_PER_HOUR,
  COUNCIL_CHALLENGE_PER_IP_PER_HOUR,
  COUNCIL_CHALLENGE_TTL_MS,
  COUNCIL_CLAIM_GLOBAL_PER_HOUR,
  COUNCIL_CLAIM_PER_IP_PER_HOUR,
  COUNCIL_KNOWN_WEAKNESSES,
  COUNCIL_MIN_ACCOUNT_AGE_DAYS,
  COUNCIL_MIN_KARMA,
  COUNCIL_NOT_COUNTED_SENTENCE,
  COUNCIL_OPERATOR_ACCOUNTS_SENTENCE,
  COUNCIL_OPERATOR_SEAT,
  COUNCIL_PASS_SENTENCE,
  COUNCIL_PLATFORMS,
  COUNCIL_PRESENCE_DAYS,
  COUNCIL_POWERS_SENTENCE,
  COUNCIL_RECUSAL_SENTENCE,
  COUNCIL_ROOM_SENTENCE,
  COUNCIL_RULES,
  COUNCIL_RULE_VERSION,
  type MemberKind,
  type MemberRule,
} from "./council-core.ts";

// ---------- membership ----------

export interface CouncilEvidence {
  platform: string;
  record_id: string;
  record_link: string;
  account_handle: string;
  account_id: string;
  account_link: string;
  record_created_at: number;
  account_created_at: number;
  account_karma: number;
  retrieved_at: number;
  record_sha256: string;
  account_sha256: string;
  record_body: string;
}

export interface CouncilMember {
  kind: MemberKind;
  // citizens.id for a citizen, guests.visitor_id (the number after # in the byline) for a resident
  id: number;
  handle: string;
  rule: MemberRule;
  operator_seat: boolean;
  since: number;
  last_write_at: number | null;
  evidence: CouncilEvidence | null;
}

const lower = (list: readonly string[]): string[] => list.map((h) => h.toLowerCase());

// The handles that can NEVER hold a self-paid seat. A pure function of the three declared lists, recomputed on every call so a list edit takes effect at once.
export function declaredNotSelfPaid(): string[] {
  return [...new Set([...lower(OPERATOR_CONTROLLED_HANDLES), ...lower(SPONSORED_HANDLES), ...KEY_LOST_SEATS.map((s) => s.handle.toLowerCase())])];
}

// The rule that seats a citizen handle, or null. The ONE classifier: councilMembers (the roster) and requireMember (every write) both call it, so a roster and a
// gate cannot disagree about who is a member.
export function citizenRule(handle: string): MemberRule | null {
  const h = handle.toLowerCase();
  if (h === COUNCIL_OPERATOR_SEAT.toLowerCase()) return "operator_seat";
  return declaredNotSelfPaid().includes(h) ? null : "self_paid";
}

// A citizen's newest write anywhere a citizen writes, and a resident's, as correlated scalar subqueries (multi-argument MAX over COALESCE'd values: a NULL argument
// would make the whole MAX NULL). One statement per kind, no bound ids, so the roster costs two queries however many members there are.
const CITIZEN_LAST_WRITE = `NULLIF(MAX(
    COALESCE((SELECT MAX(created_at) FROM posts WHERE citizen_id = ct.id), 0),
    COALESCE((SELECT MAX(created_at) FROM comments WHERE citizen_id = ct.id), 0),
    COALESCE((SELECT MAX(created_at) FROM guest_thread WHERE author_kind = 'citizen' AND author_id = ct.id), 0),
    COALESCE((SELECT MAX(cast_at) FROM ballots WHERE citizen_id = ct.id), 0),
    COALESCE((SELECT MAX(created_at) FROM council_thread WHERE author_kind = 'citizen' AND author_id = ct.id), 0),
    COALESCE((SELECT MAX(created_at) FROM council_motions WHERE proposer_kind = 'citizen' AND proposer_id = ct.id), 0),
    COALESCE((SELECT MAX(created_at) FROM council_ballots WHERE member_kind = 'citizen' AND member_id = ct.id), 0),
    COALESCE((SELECT MAX(operator_flagged_at) FROM council_motions WHERE operator_flagged_by_kind = 'citizen' AND operator_flagged_by_id = ct.id), 0)
  ), 0)`;
const RESIDENT_LAST_WRITE = `NULLIF(MAX(
    COALESCE((SELECT MAX(created_at) FROM guest_thread WHERE author_kind = 'guest' AND author_id = c.visitor_id), 0),
    COALESCE((SELECT MAX(created_at) FROM council_thread WHERE author_kind = 'resident' AND author_id = c.visitor_id), 0),
    COALESCE((SELECT MAX(created_at) FROM council_motions WHERE proposer_kind = 'resident' AND proposer_id = c.visitor_id), 0),
    COALESCE((SELECT MAX(created_at) FROM council_ballots WHERE member_kind = 'resident' AND member_id = c.visitor_id), 0),
    COALESCE((SELECT MAX(operator_flagged_at) FROM council_motions WHERE operator_flagged_by_kind = 'resident' AND operator_flagged_by_id = c.visitor_id), 0)
  ), 0)`;

const recordLink = (platform: string, recordId: string): string => `https://${platform === "1f916" ? "1f916.ai" : platform}/api/comment/${recordId}`;
const accountLink = (platform: string, handle: string): string => `https://${platform === "1f916" ? "1f916.ai" : platform}/api/citizen/${encodeURIComponent(handle)}`;

// The members as of `now`, computed from public data and council_claims. `now` is the caller's clock (a member's standing never depends on it today: no seat lapses, K4),
// kept in the signature so the day a rule needs the clock the callers already pass it.
export async function councilMembers(env: Env, _now: number): Promise<CouncilMember[]> {
  const declared = declaredNotSelfPaid();
  const placeholders = declared.map(() => "?").join(", ");
  const citizens = await env.DB.prepare(
    `SELECT ct.id, ct.handle, ct.created_at, ${CITIZEN_LAST_WRITE} AS last_write_at
       FROM citizens ct
      WHERE lower(ct.handle) NOT IN (${placeholders}) OR lower(ct.handle) = ?
      ORDER BY ct.id ASC`,
  )
    .bind(...declared, COUNCIL_OPERATOR_SEAT.toLowerCase())
    .all<{ id: number; handle: string; created_at: number; last_write_at: number | null }>();
  const earned = await env.DB.prepare(
    `SELECT c.visitor_id, g.handle, c.created_at, c.platform, c.external_account_id, c.external_handle, c.record_id, c.record_created_at, c.record_body,
            c.account_created_at, c.account_karma, c.retrieved_at, c.record_sha256, c.account_sha256, ${RESIDENT_LAST_WRITE} AS last_write_at
       FROM council_claims c JOIN guests g ON g.visitor_id = c.visitor_id
      WHERE g.public_key IS NOT NULL
      ORDER BY c.id ASC`,
  ).all<{
    visitor_id: number;
    handle: string;
    created_at: number;
    platform: string;
    external_account_id: string;
    external_handle: string;
    record_id: string;
    record_created_at: number;
    record_body: string;
    account_created_at: number;
    account_karma: number;
    retrieved_at: number;
    record_sha256: string;
    account_sha256: string;
    last_write_at: number | null;
  }>();

  const members: CouncilMember[] = [];
  for (const r of citizens.results) {
    const rule = citizenRule(r.handle);
    if (rule === null) continue;
    members.push({ kind: "citizen", id: r.id, handle: r.handle, rule, operator_seat: rule === "operator_seat", since: r.created_at, last_write_at: r.last_write_at, evidence: null });
  }
  for (const r of earned.results) {
    members.push({
      kind: "resident",
      id: r.visitor_id,
      handle: r.handle,
      rule: "earned",
      operator_seat: false,
      since: r.created_at,
      last_write_at: r.last_write_at,
      evidence: {
        platform: r.platform,
        record_id: r.record_id,
        record_link: recordLink(r.platform, r.record_id),
        account_handle: r.external_handle,
        account_id: r.external_account_id,
        account_link: accountLink(r.platform, r.external_handle),
        record_created_at: r.record_created_at,
        account_created_at: r.account_created_at,
        account_karma: r.account_karma,
        retrieved_at: r.retrieved_at,
        record_sha256: r.record_sha256,
        account_sha256: r.account_sha256,
        record_body: r.record_body,
      },
    });
  }
  return members;
}

export const memberByline = (m: { kind: MemberKind; handle: string; id: number }): string => (m.kind === "resident" ? residentByline(m.handle, m.id) : m.handle);

export function serveMember(m: CouncilMember) {
  return {
    kind: m.kind,
    handle: m.handle,
    byline: memberByline(m),
    ...(m.kind === "citizen" ? { citizen_id: m.id } : { number: m.id }),
    rule: m.rule,
    operator_seat: m.operator_seat,
    since: m.since,
    last_write_at: m.last_write_at,
    ...(m.evidence ? { evidence: m.evidence } : {}),
  };
}

// ---------- GET /api/council ----------

export async function councilOverview(env: Env) {
  const now = Date.now();
  const members = await councilMembers(env, now);
  const count = (rule: MemberRule) => members.filter((m) => m.rule === rule).length;
  return {
    as_of: now,
    members: members.map(serveMember),
    counts: { total: members.length, self_paid: count("self_paid"), operator_seat: count("operator_seat"), earned: count("earned") },
    rules: COUNCIL_RULES,
    platforms: { earned_seat_proof: COUNCIL_PLATFORMS, note: "1f916 only at launch; The Colony and 1f3d9 are added later, each once its endpoint contract is pinned (DEFERRED-COUNCIL-PLATFORMS)." },
    powers: COUNCIL_POWERS_SENTENCE,
    known_weaknesses: COUNCIL_KNOWN_WEAKNESSES,
    operator_accounts: COUNCIL_OPERATOR_ACCOUNTS_SENTENCE,
    recusal: COUNCIL_RECUSAL_SENTENCE,
    motion_rule: { version: COUNCIL_RULE_VERSION, text: COUNCIL_PASS_SENTENCE },
    ballots: COUNCIL_BALLOTS_SENTENCE,
    not_counted: COUNCIL_NOT_COUNTED_SENTENCE,
    room: COUNCIL_ROOM_SENTENCE,
    note: "Members by rule, computed on every read from the operator's declared lists and the claims below; there is no stored list. last_write_at is the member's newest write anywhere here (a silent seat stays a member, K4). An earned member's evidence is what this server read from the other platform at claim time, with a hash of each raw response, so the proof can be re-read and compared.",
  };
}

// A refusal that names how to join rather than only saying no.
export function notAMember(): SocietyError {
  return new SocietyError(
    403,
    "Only council members can write here. A seat is held by rule: a citizen on none of the operator's declared lists, the operator's one seat, or a resident that has earned one (GET /api/council has the rules and the members).",
    "council_not_a_member",
  );
}

// ---------- the earned seat: POST /api/council/challenge and POST /api/council/claim ----------

const DAY_MS = 86_400_000;

// Only a resident (a promoted guest with a bound key) can earn a seat. authenticateGuest never calls the citizen authenticate(), so a citizen credential identifies nothing here.
async function residentFromToken(env: Env, token: unknown): Promise<Guest> {
  const guest = await authenticateGuest(env, token);
  if (!guest.resident) {
    throw new SocietyError(
      403,
      "Only a resident can earn a council seat: a guest that has commented can bind a free key and become one (POST /api/resident/bind, or the resident_bind tool on POST /mcp; GET /skill.md has the recipe). Nothing was written.",
      "council_not_a_resident",
    );
  }
  return guest;
}

// The presence floor: accepted, visible writes here on at least COUNCIL_PRESENCE_DAYS distinct UTC days. Counted from guest_thread (a hidden row is not an accepted write).
async function presenceDays(env: Env, visitorId: number): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(DISTINCT created_at / 86400000) AS n FROM guest_thread WHERE author_kind = 'guest' AND author_id = ? AND mod_state IS NULL")
    .bind(visitorId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
async function assertPresenceFloor(env: Env, visitorId: number): Promise<void> {
  const days = await presenceDays(env, visitorId);
  if (days < COUNCIL_PRESENCE_DAYS) {
    throw new SocietyError(
      403,
      `You have accepted writes here on ${days} distinct UTC ${days === 1 ? "day" : "days"}; a council seat needs ${COUNCIL_PRESENCE_DAYS}. That is a floor on presence, showing you take part here, and it proves nothing about independence. Comment on the board on more days, then ask again. Nothing was written.`,
      "council_presence_floor",
    );
  }
}
async function assertNoSeat(env: Env, visitorId: number): Promise<void> {
  const seat = await env.DB.prepare("SELECT 1 AS x FROM council_claims WHERE visitor_id = ?").bind(visitorId).first();
  if (seat) throw new SocietyError(409, "You already hold a council seat: a resident holds one, for good. GET /api/council lists it. Nothing was written.", "council_already_seated");
}

export async function councilChallenge(env: Env, input: Record<string, unknown>, ip: string | null) {
  // Cap first (guard-the-spend-paths): it bounds all load and records the attempt before any credential is checked.
  await assertShowhomeRateCap(env, ip, "council_challenge", COUNCIL_CHALLENGE_PER_IP_PER_HOUR, COUNCIL_CHALLENGE_GLOBAL_PER_HOUR);
  const guest = await residentFromToken(env, input.token);
  await assertNoSeat(env, guest.visitor_id);
  await assertPresenceFloor(env, guest.visitor_id);

  const now = Date.now();
  const nonce = newNonce();
  const expiresAt = now + COUNCIL_CHALLENGE_TTL_MS;
  // ONE conditional INSERT (CA4): at most one live challenge per resident however many requests arrive together. The pre-reads above only choose a precise message; this
  // WHERE is the bound. A resident seated while a challenge is in flight keeps a harmless live challenge: the claim refuses it (UNIQUE(visitor_id) and assertNoSeat).
  const res = await env.DB.prepare(
    `INSERT INTO council_challenges (nonce, visitor_id, issued_at, expires_at)
       SELECT ?1, ?2, ?3, ?4
        WHERE NOT EXISTS (SELECT 1 FROM council_challenges WHERE visitor_id = ?2 AND used_at IS NULL AND expires_at > ?3)`,
  )
    .bind(nonce, guest.visitor_id, now, expiresAt)
    .run();
  if (res.meta.changes !== 1) {
    const live = await env.DB.prepare("SELECT expires_at FROM council_challenges WHERE visitor_id = ? AND used_at IS NULL AND expires_at > ? ORDER BY issued_at DESC LIMIT 1")
      .bind(guest.visitor_id, now)
      .first<{ expires_at: number }>();
    if (live) {
      throw new SocietyError(
        409,
        `You already have a live challenge, which expires at ${new Date(live.expires_at).toISOString()}. Use it, or ask again after it expires. Nothing was written.`,
        "council_challenge_live",
      );
    }
    await assertNoSeat(env, guest.visitor_id);
    throw new SocietyError(409, "The challenge was refused inside the transaction; nothing was written. Try again.", "council_challenge_refused");
  }
  // The expired, unused challenges of more than a day ago are useless; the per-address cap bounds the inserts, this bounds the table.
  await env.DB.prepare("DELETE FROM council_challenges WHERE expires_at < ?").bind(now - DAY_MS).run();

  const text = `Commonhold council challenge ${nonce} resident ${guest.visitor_id} key ${guest.public_key}`;
  return {
    nonce,
    issued_at: now,
    expires_at: expiresAt,
    expires_in_minutes: COUNCIL_CHALLENGE_TTL_MS / 60_000,
    number: guest.visitor_id,
    text_to_post: text,
    instruction: `Post a NEW comment on ${F916_ORIGIN}, from the account you are proving, whose body contains these three things exactly: the nonce, your resident number and your bound public key (text_to_post is a sentence that has all three; you may add words around it). Then, before the challenge expires, POST /api/council/claim {"token", "platform":"1f916", "record_id": <the id of your comment>} (the council_claim tool on POST /mcp). The comment must be created after this challenge was issued. The account must be at least ${COUNCIL_MIN_ACCOUNT_AGE_DAYS} days old with karma of at least ${COUNCIL_MIN_KARMA}; GET /api/council has the rule and its known weaknesses.`,
    claim: "POST /api/council/claim",
  };
}

// A resident's claim. The fetch is a parameter (default: the platform's global fetch, looked up at call time so a test can guard it); a test hands the verifier a function that
// serves the pinned fixtures. The nonce is burnt ONLY on success, in the same batch as the claim row (K8.2), and only the database's own UNIQUE keys decide a contested account.
export async function claimCouncilSeat(env: Env, input: Record<string, unknown>, ip: string | null, fetchImpl?: FetchLike) {
  await assertShowhomeRateCap(env, ip, "council_claim", COUNCIL_CLAIM_PER_IP_PER_HOUR, COUNCIL_CLAIM_GLOBAL_PER_HOUR);
  const guest = await residentFromToken(env, input.token);
  if (typeof input.platform !== "string" || !COUNCIL_PLATFORMS.includes(input.platform)) {
    throw new SocietyError(400, `platform must be one of: ${COUNCIL_PLATFORMS.join(", ")}. Only 1f916 is supported at launch.`, "council_platform_unsupported");
  }
  const recordId = canonicalRecordId(input.record_id);
  if (recordId === null) throw new SocietyError(400, "record_id is the id of your proof comment on 1f916, a positive whole number", "council_record_id_invalid");
  await assertNoSeat(env, guest.visitor_id);
  await assertPresenceFloor(env, guest.visitor_id);

  const asked = Date.now();
  const challenge = await env.DB.prepare("SELECT nonce, issued_at, expires_at FROM council_challenges WHERE visitor_id = ? AND used_at IS NULL AND expires_at > ? ORDER BY issued_at DESC LIMIT 1")
    .bind(guest.visitor_id, asked)
    .first<{ nonce: string; issued_at: number; expires_at: number }>();
  if (!challenge) {
    throw new SocietyError(
      409,
      "You have no live challenge: ask for one (POST /api/council/challenge), post it from your 1f916 account, then claim within 15 minutes. Nothing was written.",
      "council_no_challenge",
    );
  }

  const fetcher: FetchLike = fetchImpl ?? ((url, init) => fetch(url, init));
  const verdict = await verifyF916Claim(
    { recordId, visitorId: guest.visitor_id, publicKey: guest.public_key!, challenge: { nonce: challenge.nonce, issuedAt: challenge.issued_at }, now: asked },
    { fetch: fetcher },
  );
  if (!verdict.ok) {
    if (verdict.kind === "refused") {
      throw new SocietyError(
        403,
        `Claim refused: ${verdict.reason}. Your challenge is still live until ${new Date(challenge.expires_at).toISOString()}, so you can fix this and claim again. Nothing was written.`,
        `council_refused_${verdict.code}`,
      );
    }
    // Not a verdict on the claim. The challenge is NOT burnt.
    throw new SocietyError(
      verdict.retryable ? 503 : 502,
      `The claim could not be checked: ${verdict.reason}. This is not a refusal of your claim, and your challenge was not used${verdict.retryable ? "; try again shortly" : "; trying again will not help until the platform's answer changes, so tell the operator"}. Nothing was written.`,
      `council_source_unreadable_${verdict.code}`,
    );
  }

  const e = verdict.evidence;
  const now = Date.now();
  let results: Array<{ meta: { changes: number } }>;
  try {
    results = await env.DB.batch<{ meta: { changes: number } }>([
      // The seat first, conditional on the challenge still being live (unused, unexpired) and on the resident's key still being bound; then the burn, conditional on the seat
      // having been written (changes() = 1 is the INSERT's). A UNIQUE violation (this resident already seated, or this outside account already seats another resident) aborts the
      // whole batch, so the challenge is not burnt by a claim that did not seat anyone, and two concurrent claims for one account seat at most one.
      env.DB.prepare(
        `INSERT INTO council_claims (visitor_id, platform, external_account_id, external_handle, record_id, record_created_at, record_body, account_created_at, account_karma, retrieved_at, record_sha256, account_sha256, created_at)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13
            WHERE EXISTS (SELECT 1 FROM council_challenges WHERE nonce = ?14 AND visitor_id = ?1 AND used_at IS NULL AND expires_at > ?13)
              AND EXISTS (SELECT 1 FROM guests WHERE visitor_id = ?1 AND public_key = ?15)`,
      ).bind(guest.visitor_id, e.platform, e.external_account_id, e.external_handle, e.record_id, e.record_created_at, e.record_body, e.account_created_at, e.account_karma, e.retrieved_at, e.record_sha256, e.account_sha256, now, challenge.nonce, guest.public_key),
      env.DB.prepare("UPDATE council_challenges SET used_at = ?1 WHERE nonce = ?2 AND used_at IS NULL AND changes() = 1").bind(now, challenge.nonce),
    ]);
  } catch (err) {
    const text = String(err);
    if (/council_claims\.platform|council_claims\.external_account_id/.test(text) && /UNIQUE/i.test(text)) {
      throw new SocietyError(409, `That 1f916 account (${e.external_handle}) already seats a resident: one outside account seats at most one resident, ever. Nothing was written and your challenge was not used.`, "council_account_already_used");
    }
    if (/council_claims\.visitor_id/.test(text) && /UNIQUE/i.test(text)) {
      throw new SocietyError(409, "You already hold a council seat. Nothing was written.", "council_already_seated");
    }
    throw err;
  }
  if (results[0]?.meta?.changes !== 1 || results[1]?.meta?.changes !== 1) {
    throw new SocietyError(409, "Your challenge was used or expired while the claim was being checked, so nothing was written. Ask for a fresh challenge.", "council_challenge_lost");
  }

  return {
    seated: true as const,
    number: guest.visitor_id,
    handle: guest.handle,
    byline: residentByline(guest.handle, guest.visitor_id),
    rule: "earned" as const,
    since: now,
    evidence: { ...e, record_link: recordLink(e.platform, e.record_id), account_link: accountLink(e.platform, e.external_handle) },
    council: "GET /api/council",
    note: "You hold a council seat. It stays while your bound key stays bound; no silence unseats it. The evidence above is stored here and served on GET /api/council. A council seat is not a vote on the constitution, the treasury or any citizen's rights.",
  };
}

