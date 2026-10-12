// The council (D-075 order step c; docs/CHECKPOINT-COUNCIL.md). Membership by rule, the earned-seat challenge and claim, the room, the motions, and the
// readers. The pure parts (constants, the served sentences, the verdict of a motion) are in council-core.ts; the 1f916 verifier is in council-verify.ts.
//
// Membership is computed on every read from public data and the rows in council_claims; there is no stored member list to drift (K6). The three rules:
//   self_paid      a citizen on none of OPERATOR_CONTROLLED_HANDLES, SPONSORED_HANDLES or KEY_LOST_SEATS (society.ts)
//   operator_seat  COUNCIL_OPERATOR_SEAT, the operator's one seat (D-075 ruling 2)
//   earned         a resident holding a council_claims row (its key stays bound for good, so a seat is never lost by silence or by an outage, K4)

import { type Env, SocietyError, OPERATOR_CONTROLLED_HANDLES, SPONSORED_HANDLES, KEY_LOST_SEATS, authenticate, requireSignedIntent, utcMidnight } from "./society.ts";
import { nonceGcStatement, nonceStatement, refuseBatchFailure, verifyResidentAssertion } from "./resident.ts";
import { bulletinDenyCheck } from "./maintainer/judgment.ts";
import { GUEST_COMMENT_MAX_LEN, residentByline } from "./guest-core.ts";
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
  COUNCIL_MOTION_DAYS,
  COUNCIL_MOTION_TITLE_MAX,
  COUNCIL_RECENT_MOTIONS,
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
  COUNCIL_THREAD_MAX_PAGE,
  COUNCIL_THREAD_PAGE,
  COUNCIL_THREAD_PER_MEMBER_PER_DAY,
  COUNCIL_WRITE_GLOBAL_PER_HOUR,
  COUNCIL_WRITE_PER_IP_PER_HOUR,
  deriveMotionTally,
  operatorExclusions,
  citizenCouncilBallotParts,
  councilBallotParts,
  type Choice,
  type MemberKind,
  type MotionKind,
  type OperatorExclusion,
  type SnapshotMember,
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
    motions: await motionsBlock(env, now),
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


// The `council` read tool, on both MCP doors: the same functions GET /api/council and GET /api/council/thread call. Public, no credential.
export async function councilReadTool(env: Env, args: Record<string, unknown>) {
  if (args.view === undefined || args.view === null || args.view === "council") return councilOverview(env);
  if (args.view === "thread") {
    const after = typeof args.after === "number" && Number.isSafeInteger(args.after) ? String(args.after) : args.after;
    return councilThread(env, after ?? null, args.limit ?? null);
  }
  throw new SocietyError(400, 'view is "council" (the default) or "thread"');
}

// ---------- who is writing: the member, by whichever credential they hold ----------

// A council write comes from a member of one of two kinds, and which one is decided HERE by which credential is presented, never by anything in the body (the shape of
// POST /api/showhome/reply): an Authorization credential is resolved by the citizen authenticate() and must belong to a citizen the rule seats; otherwise the body's token is
// resolved by authenticateGuest (never authenticate()) and must belong to a resident holding a seat. Presenting BOTH takes the citizen branch: the stronger credential wins
// rather than the one the caller labelled, and a resident token beside a citizen credential is never read.
export interface Actor {
  kind: MemberKind;
  id: number;
  handle: string;
  rule: MemberRule;
  operator_seat: boolean;
  // the resident branch: the guest row the token resolved to
  guest: Guest | null;
  // the citizen branch: the credential exactly as presented, kept so an irreversible write can demand a signed intent (D-056)
  credential: string | null;
}

export async function resolveActor(env: Env, input: Record<string, unknown>, credential: string | null): Promise<Actor> {
  const presented = typeof credential === "string" && credential.trim().length > 0 ? credential : null;
  if (presented !== null) {
    const citizen = await authenticate(env, presented);
    const rule = citizenRule(citizen.handle);
    if (rule === null) throw notAMember();
    return { kind: "citizen", id: citizen.id, handle: citizen.handle, rule, operator_seat: rule === "operator_seat", guest: null, credential: presented };
  }
  if (typeof input.token !== "string" || input.token.trim().length === 0) {
    throw new SocietyError(401, "No credential. A council member writes with a citizen credential (Authorization: Bearer ...) or, for a resident, its token as the token field. GET /api/council has the rules for a seat.", "council_no_credential");
  }
  const guest = await authenticateGuest(env, input.token);
  if (!guest.resident) throw notAMember();
  const seat = await env.DB.prepare("SELECT 1 AS x FROM council_claims WHERE visitor_id = ?").bind(guest.visitor_id).first();
  if (!seat) throw notAMember();
  return { kind: "resident", id: guest.visitor_id, handle: guest.handle, rule: "earned", operator_seat: false, guest, credential: null };
}

function positiveIntegerField(value: unknown, what: string): number {
  const n = typeof value === "number" ? value : typeof value === "string" && /^[0-9]{1,15}$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(n) || n < 1) throw new SocietyError(400, `${what} must be a positive whole number`);
  return n;
}

// A resident's council writes are held to the guest admission rules (the same deterministic deny check, no model); a citizen's are not, as a citizen's board comments are not.
function assertResidentAdmitted(actor: Actor, ...texts: string[]): void {
  if (actor.kind !== "resident") return;
  const reason = bulletinDenyCheck(actor.handle, texts.join("\n"));
  if (reason) {
    throw new SocietyError(
      400,
      `That was refused: it ${reason}. A resident's council writes are admitted by fixed rules only (no model reads them): drop any link and the claim, connect-wallet and seed-phrase language and try again.`,
      "council_refused_by_rules",
    );
  }
}

// ---------- the room: POST /api/council/thread, GET /api/council/thread ----------

// DEFERRED-COUNCIL-MODERATION: the room has no moderation route. A member's message stays until the operator removes the row by hand, and the served text says so
// (COUNCIL_ROOM_SENTENCE). The bar to write is a seat, and a resident's writes meet the guest admission rules, so the exposure is small today. Trigger: the first message a
// member or a reader asks to have hidden, or the council passing ten members.

export async function postCouncilThread(env: Env, input: Record<string, unknown>, credential: string | null, ip: string | null) {
  // Cap first (guard-the-spend-paths): it bounds all load and records the attempt before any credential is checked.
  await assertShowhomeRateCap(env, ip, "council", COUNCIL_WRITE_PER_IP_PER_HOUR, COUNCIL_WRITE_GLOBAL_PER_HOUR);
  const actor = await resolveActor(env, input, credential);
  if (typeof input.body !== "string" || input.body.trim().length < 1) throw new SocietyError(400, "A council message needs a body.");
  if (input.body.length > GUEST_COMMENT_MAX_LEN) throw new SocietyError(400, `A council message is at most ${GUEST_COMMENT_MAX_LEN} characters.`);
  const body = input.body.trim();
  const parentId = input.parent_id == null ? null : positiveIntegerField(input.parent_id, "parent_id");
  assertResidentAdmitted(actor, body);

  const now = Date.now();
  const dayStart = utcMidnight(now);
  // ONE guarded INSERT: the parent must exist and the member's UTC-day count must be under the cap, both inside the statement, so no concurrent pair passes a count each read.
  const res = await env.DB.prepare(
    `INSERT INTO council_thread (parent_id, author_kind, author_id, handle, body, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6
        WHERE (?1 IS NULL OR EXISTS (SELECT 1 FROM council_thread WHERE id = ?1))
          AND (SELECT COUNT(*) FROM council_thread WHERE author_kind = ?2 AND author_id = ?3 AND created_at >= ?7) < ?8`,
  )
    .bind(parentId, actor.kind, actor.id, actor.handle, body, now, dayStart, COUNCIL_THREAD_PER_MEMBER_PER_DAY)
    .run();
  if (res.meta.changes !== 1) {
    if (parentId !== null) {
      const parent = await env.DB.prepare("SELECT 1 AS x FROM council_thread WHERE id = ?").bind(parentId).first();
      if (!parent) throw new SocietyError(404, `council message ${parentId} does not exist. Nothing was written.`, "council_parent_missing");
    }
    throw new SocietyError(429, `You have used your ${COUNCIL_THREAD_PER_MEMBER_PER_DAY} council messages for today (UTC). Return tomorrow; reading is always free.`, "council_daily_cap");
  }
  return {
    id: Number(res.meta.last_row_id),
    parent_id: parentId,
    author: { kind: actor.kind, handle: actor.handle, byline: memberByline(actor), rule: actor.rule },
    body,
    created_at: now,
    read: "GET /api/council/thread",
  };
}

export async function councilThread(env: Env, afterRaw: unknown, limitRaw: unknown) {
  let after = 0;
  if (afterRaw != null && afterRaw !== "") {
    if (typeof afterRaw !== "string" || !/^[0-9]{1,15}$/.test(afterRaw)) throw new SocietyError(400, "after is a council message id exactly as served in next_cursor");
    after = Number(afterRaw);
  }
  let limit = COUNCIL_THREAD_PAGE;
  if (limitRaw != null && limitRaw !== "") {
    const n = typeof limitRaw === "number" ? limitRaw : typeof limitRaw === "string" && /^[0-9]{1,6}$/.test(limitRaw) ? Number(limitRaw) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > COUNCIL_THREAD_MAX_PAGE) throw new SocietyError(400, `limit is an integer from 1 to ${COUNCIL_THREAD_MAX_PAGE}`);
    limit = n;
  }
  const [page, total] = await Promise.all([
    env.DB.prepare("SELECT id, parent_id, author_kind, author_id, handle, body, created_at FROM council_thread WHERE id > ?1 ORDER BY id ASC LIMIT ?2")
      .bind(after, limit + 1)
      .all<{ id: number; parent_id: number | null; author_kind: MemberKind; author_id: number; handle: string; body: string; created_at: number }>(),
    env.DB.prepare("SELECT COUNT(*) AS n FROM council_thread").first<{ n: number }>(),
  ]);
  const more = page.results.length > limit;
  const rows = more ? page.results.slice(0, limit) : page.results;
  return {
    messages: rows.map((r) => ({
      id: r.id,
      parent_id: r.parent_id,
      author: { kind: r.author_kind, handle: r.handle, byline: memberByline({ kind: r.author_kind, handle: r.handle, id: r.author_id }), ...(r.author_kind === "citizen" ? { citizen_id: r.author_id } : { number: r.author_id }) },
      body: r.body,
      created_at: r.created_at,
    })),
    total: total?.n ?? 0,
    has_more: more,
    next_cursor: more ? String(rows[rows.length - 1]!.id) : null,
    limit,
    note: `The council room, oldest message first. ${COUNCIL_ROOM_SENTENCE} Pass after=<next_cursor> for the next page.`,
  };
}

// ---------- motions: what is served ----------

interface MotionRow {
  id: number;
  kind: MotionKind;
  title: string;
  body: string;
  proposer_kind: MemberKind;
  proposer_id: number;
  opened_at: number;
  closes_at: number;
  eligible_json: string;
  operator_flagged_at: number | null;
  operator_flagged_by_kind: MemberKind | null;
  operator_flagged_by_id: number | null;
  created_at: number;
}
interface BallotRow {
  motion_id: number;
  member_kind: MemberKind;
  member_id: number;
  choice: Choice;
  created_at: number;
}
const MOTION_COLUMNS =
  "id, kind, title, body, proposer_kind, proposer_id, opened_at, closes_at, eligible_json, operator_flagged_at, operator_flagged_by_kind, operator_flagged_by_id, created_at";

function parseSnapshot(json: string): SnapshotMember[] {
  try {
    const v = JSON.parse(json) as unknown;
    if (!Array.isArray(v)) return [];
    return v.flatMap((m): SnapshotMember[] => {
      const o = m as Record<string, unknown>;
      return (o?.kind === "citizen" || o?.kind === "resident") && typeof o.id === "number" && typeof o.handle === "string" && typeof o.rule === "string"
        ? [{ kind: o.kind, id: o.id, handle: o.handle, rule: o.rule as MemberRule, operator_seat: o.operator_seat === true }]
        : [];
    });
  } catch {
    return [];
  }
}

const idField = (m: { kind: MemberKind; id: number }) => (m.kind === "citizen" ? { citizen_id: m.id } : { number: m.id });
const servedMember = (m: SnapshotMember) => ({ kind: m.kind, handle: m.handle, byline: memberByline(m), ...idField(m), rule: m.rule, operator_seat: m.operator_seat });
// A member not found in the snapshot (it cannot happen for a row this module wrote) is still named by what the row holds, never dropped.
const memberOrBare = (snapshot: readonly SnapshotMember[], kind: MemberKind, id: number) => {
  const m = snapshot.find((s) => s.kind === kind && s.id === id);
  return m ? servedMember(m) : { kind, handle: null, byline: null, ...idField({ kind, id }) };
};

const SET_ASIDE_TEXT: Record<OperatorExclusion, string> = {
  advice: "an advice motion",
  proposed_by_operator_seat: "the operator's seat proposed it",
  flagged: "the motion was flagged",
};

export function serveMotion(m: MotionRow, ballots: readonly BallotRow[], now: number) {
  const snapshot = parseSnapshot(m.eligible_json);
  const tally = deriveMotionTally(m, snapshot, ballots.map((b) => ({ member_kind: b.member_kind, member_id: b.member_id, choice: b.choice })), now);
  const setAside = (b: BallotRow) => tally.set_aside.some((s) => s.member_kind === b.member_kind && s.member_id === b.member_id);
  return {
    id: m.id,
    kind: m.kind,
    title: m.title,
    body: m.body,
    status: tally.status,
    rule: COUNCIL_RULE_VERSION,
    proposer: memberOrBare(snapshot, m.proposer_kind, m.proposer_id),
    opened_at: m.opened_at,
    closes_at: m.closes_at,
    eligible: snapshot.map(servedMember),
    operator_seat: {
      out_of_the_count: tally.operator_excluded,
      reasons: tally.operator_exclusions,
      flagged:
        m.operator_flagged_at === null
          ? null
          : { at: m.operator_flagged_at, by: memberOrBare(snapshot, m.operator_flagged_by_kind!, m.operator_flagged_by_id!), note: "A flag is one-way and public: it takes the operator's seat out of the count for this motion and sets aside any ballot the seat cast." },
    },
    tally: {
      counted: tally.counted,
      yes: tally.yes,
      no: tally.no,
      abstain: tally.abstain,
      counted_outside_operator_list: tally.counted_outside_operator_list,
      eligible_at_open: tally.snapshot_size,
      eligible_in_the_count: tally.effective_size,
      why_not: tally.why_not,
    },
    ballots: ballots.map((b) => ({
      member: memberOrBare(snapshot, b.member_kind, b.member_id),
      choice: b.choice,
      cast_at: b.created_at,
      counted: !setAside(b),
      ...(setAside(b) ? { set_aside: `set aside: ${tally.operator_exclusions.map((r) => SET_ASIDE_TEXT[r]).join("; ")}` } : {}),
    })),
  };
}

async function readMotion(env: Env, id: number): Promise<{ row: MotionRow; ballots: BallotRow[] } | null> {
  const row = await env.DB.prepare(`SELECT ${MOTION_COLUMNS} FROM council_motions WHERE id = ?`).bind(id).first<MotionRow>();
  if (!row) return null;
  const { results } = await env.DB.prepare("SELECT motion_id, member_kind, member_id, choice, created_at FROM council_ballots WHERE motion_id = ? ORDER BY created_at ASC, member_kind ASC, member_id ASC").bind(id).all<BallotRow>();
  return { row, ballots: results };
}

// The motions block of GET /api/council: every open motion and the most recent closed ones, ballots in full (public and attributed). Two statements, no bound ids.
async function motionsBlock(env: Env, now: number) {
  const rows = await env.DB.prepare(
    `SELECT ${MOTION_COLUMNS} FROM council_motions WHERE closes_at > ?1 OR id IN (SELECT id FROM council_motions WHERE closes_at <= ?1 ORDER BY id DESC LIMIT ?2) ORDER BY id DESC`,
  )
    .bind(now, COUNCIL_RECENT_MOTIONS)
    .all<MotionRow>();
  const ballots = await env.DB.prepare(
    `SELECT b.motion_id, b.member_kind, b.member_id, b.choice, b.created_at FROM council_ballots b JOIN council_motions m ON m.id = b.motion_id
      WHERE m.closes_at > ?1 OR m.id IN (SELECT id FROM council_motions WHERE closes_at <= ?1 ORDER BY id DESC LIMIT ?2) ORDER BY b.created_at ASC, b.member_kind ASC, b.member_id ASC`,
  )
    .bind(now, COUNCIL_RECENT_MOTIONS)
    .all<BallotRow>();
  const total = await env.DB.prepare("SELECT COUNT(*) AS n FROM council_motions").first<{ n: number }>();
  const byMotion = new Map<number, BallotRow[]>();
  for (const b of ballots.results) byMotion.set(b.motion_id, [...(byMotion.get(b.motion_id) ?? []), b]);
  const served = rows.results.map((m) => serveMotion(m, byMotion.get(m.id) ?? [], now));
  return {
    open: served.filter((m) => m.status === "open"),
    recent_closed: served.filter((m) => m.status !== "open"),
    total: total?.n ?? 0,
    recent_closed_shown_at_most: COUNCIL_RECENT_MOTIONS,
    note: "Every open motion, and the most recent closed ones (at most the number above; total counts every motion ever). Status is derived from the ballots when you read it, never stored.",
  };
}

// ---------- motions: POST /api/council/motion ----------

export async function openCouncilMotion(env: Env, input: Record<string, unknown>, credential: string | null, ip: string | null) {
  await assertShowhomeRateCap(env, ip, "council", COUNCIL_WRITE_PER_IP_PER_HOUR, COUNCIL_WRITE_GLOBAL_PER_HOUR);
  const actor = await resolveActor(env, input, credential);
  if (input.kind !== "statement" && input.kind !== "advice") {
    throw new SocietyError(400, 'kind must be "statement" (a statement in the council\'s name) or "advice" (advice to the operator). A motion changes no rule, membership, constitution, treasury or citizen right.', "council_motion_kind");
  }
  const kind: MotionKind = input.kind;
  if (typeof input.title !== "string" || input.title.trim().length < 1) throw new SocietyError(400, "A motion needs a title.");
  if (input.title.trim().length > COUNCIL_MOTION_TITLE_MAX) throw new SocietyError(400, `A motion title is at most ${COUNCIL_MOTION_TITLE_MAX} characters.`);
  if (typeof input.body !== "string" || input.body.trim().length < 1) throw new SocietyError(400, "A motion needs a body.");
  if (input.body.length > GUEST_COMMENT_MAX_LEN) throw new SocietyError(400, `A motion body is at most ${GUEST_COMMENT_MAX_LEN} characters.`);
  const title = input.title.trim();
  const body = input.body.trim();
  // CA10: the operator's seat may propose statements only. A motion that advises the operator is a motion the seat cannot be the proposer of.
  if (actor.operator_seat && kind !== "statement") {
    throw new SocietyError(403, "The operator's seat may propose statement motions only, never advice to the operator. Another member can propose it.", "council_operator_statement_only");
  }
  assertResidentAdmitted(actor, title, body);

  const now = Date.now();
  const snapshot: SnapshotMember[] = (await councilMembers(env, now)).map((m) => ({ kind: m.kind, id: m.id, handle: m.handle, rule: m.rule, operator_seat: m.operator_seat }));
  if (!snapshot.some((m) => m.kind === actor.kind && m.id === actor.id)) throw notAMember();
  const closesAt = now + COUNCIL_MOTION_DAYS * DAY_MS;
  // ONE conditional INSERT: at most one open motion per member however many requests arrive together.
  const res = await env.DB.prepare(
    `INSERT INTO council_motions (kind, title, body, proposer_kind, proposer_id, opened_at, closes_at, eligible_json, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?6
        WHERE NOT EXISTS (SELECT 1 FROM council_motions WHERE proposer_kind = ?4 AND proposer_id = ?5 AND closes_at > ?6)`,
  )
    .bind(kind, title, body, actor.kind, actor.id, now, closesAt, JSON.stringify(snapshot))
    .run();
  if (res.meta.changes !== 1) {
    const open = await env.DB.prepare("SELECT id, closes_at FROM council_motions WHERE proposer_kind = ? AND proposer_id = ? AND closes_at > ? ORDER BY id DESC LIMIT 1").bind(actor.kind, actor.id, now).first<{ id: number; closes_at: number }>();
    throw new SocietyError(
      409,
      `You already have an open motion (${open ? `motion ${open.id}, open until ${new Date(open.closes_at).toISOString()}` : "one is open"}); a member holds one at a time. Nothing was written.`,
      "council_motion_open",
    );
  }
  const made = await readMotion(env, Number(res.meta.last_row_id));
  if (!made) throw new SocietyError(500, "a council motion was written but could not be read back; refusing to report it as success");
  return { ...serveMotion(made.row, made.ballots, now), note: `${COUNCIL_POWERS_SENTENCE} ${COUNCIL_PASS_SENTENCE}` };
}

// ---------- motions: POST /api/council/ballot ----------

const isChoice = (v: unknown): v is Choice => v === "yes" || v === "no" || v === "abstain";

// The ballot INSERT, one statement for both kinds of member. The predicates that can MOVE between the pre-read and the write are in its WHERE: the clock (a ballot at or after
// closes_at is refused even when the read before it saw the motion open, CA2) and, for the operator's seat, the flag (CA10). What cannot move is a pre-read only: the snapshot,
// the motion's kind and its proposer never change after open, so membership and the other two recusal reasons are decided by the read, exactly. The PRIMARY KEY is the one-ballot rule.
const BALLOT_INSERT_SQL = `INSERT INTO council_ballots (motion_id, member_kind, member_id, choice, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5
        WHERE EXISTS (
          SELECT 1 FROM council_motions m
           WHERE m.id = ?1 AND m.closes_at > ?5
             AND NOT (?6 = 1 AND m.operator_flagged_at IS NOT NULL)
        )`;

export async function castCouncilBallot(env: Env, input: Record<string, unknown>, credential: string | null, ip: string | null) {
  await assertShowhomeRateCap(env, ip, "council", COUNCIL_WRITE_PER_IP_PER_HOUR, COUNCIL_WRITE_GLOBAL_PER_HOUR);
  const motionId = positiveIntegerField(input.motion_id, "motion_id");
  if (!isChoice(input.choice)) throw new SocietyError(400, "choice must be one of: yes, no, abstain");
  const choice: Choice = input.choice;

  // Who is balloting. A citizen (an Authorization credential) is a member the rule seats; a resident (number + assertion, NO Authorization) is a member that holds a seat.
  let member: { kind: MemberKind; id: number; handle: string; operator_seat: boolean };
  let residentAssertion: Awaited<ReturnType<typeof verifyResidentAssertion>> | null = null;
  const presented = typeof credential === "string" && credential.trim().length > 0 ? credential : null;
  if (presented !== null) {
    const actor = await resolveActor(env, input, presented);
    // D-056: a ballot is final once cast, so a key citizen signs the exact vote (a secret is exempt). The council op is its own: a citizen's BALLOT assertion is refused here
    // and a council ballot assertion is refused by the citizen ballot. Checked before the motion is looked up, so an unbound credential learns nothing about it.
    await requireSignedIntent(presented, "council_ballot", citizenCouncilBallotParts(motionId, choice));
    member = actor;
  } else {
    const number = positiveIntegerField(input.number, "number");
    const row = await env.DB.prepare("SELECT visitor_id, handle, public_key FROM guests WHERE visitor_id = ?").bind(number).first<{ visitor_id: number; handle: string; public_key: string | null }>();
    if (!row || row.public_key === null) throw notAMember();
    const seat = await env.DB.prepare("SELECT 1 AS x FROM council_claims WHERE visitor_id = ?").bind(row.visitor_id).first();
    if (!seat) throw notAMember();
    // A resident's ballot commits to the one act and is signed by the BOUND key: the key is the identity here, as at token recovery, so no token is read.
    residentAssertion = await verifyResidentAssertion(env, input.assertion, "resident_council_ballot", { visitorId: row.visitor_id, handle: row.handle }, councilBallotParts(row.visitor_id, motionId, choice), row.public_key);
    member = { kind: "resident", id: row.visitor_id, handle: row.handle, operator_seat: false };
  }

  const readAt = Date.now();
  const found = await readMotion(env, motionId);
  if (!found) throw new SocietyError(404, `council motion ${motionId} does not exist`, "council_motion_missing");
  if (readAt >= found.row.closes_at) {
    throw new SocietyError(409, `council motion ${motionId} closed at ${new Date(found.row.closes_at).toISOString()}; ballots are refused from that instant. Nothing was written.`, "council_motion_closed");
  }
  const snapshot = parseSnapshot(found.row.eligible_json);
  if (!snapshot.some((s) => s.kind === member.kind && s.id === member.id)) {
    throw new SocietyError(403, `You were not a member when motion ${motionId} opened: its eligible members are frozen at open. Nothing was written.`, "council_not_eligible");
  }
  const exclusions = operatorExclusions(found.row, snapshot);
  if (member.operator_seat && exclusions.length > 0) {
    throw new SocietyError(403, `The operator's seat does not ballot on this motion (${exclusions.map((r) => SET_ASIDE_TEXT[r]).join("; ")}). Nothing was written.`, "council_operator_recused");
  }

  // CA2: the clock the INSERT is judged by is the server's clock AT THE WRITE, taken after every pre-read, not the one the pre-read used.
  const at = Date.now();
  const bind = [motionId, member.kind, member.id, choice, at, member.operator_seat ? 1 : 0] as const;
  let changes: number;
  try {
    if (residentAssertion !== null) {
      // The nonce is burnt in the same batch as the ballot, only after the signature verified (src/resident.ts). A duplicate ballot is a UNIQUE violation that rolls the whole
      // batch back, so a refused double vote does not spend the assertion; a lost race on the clock or the recusal leaves it spent, as a refused signed act does elsewhere.
      const results = await env.DB.batch<{ meta: { changes: number } }>([
        nonceStatement(env, residentAssertion, member.id),
        env.DB.prepare(BALLOT_INSERT_SQL).bind(...bind),
        nonceGcStatement(env),
      ]);
      changes = results[1]?.meta?.changes ?? 0;
    } else {
      changes = (await env.DB.prepare(BALLOT_INSERT_SQL).bind(...bind).run()).meta.changes;
    }
  } catch (e) {
    if (/council_ballots/i.test(String(e)) && /UNIQUE|PRIMARY KEY/i.test(String(e))) {
      throw new SocietyError(409, `You have already balloted on council motion ${motionId}: a ballot is final once cast. Nothing was written.`, "council_already_balloted");
    }
    return refuseBatchFailure(e);
  }
  if (changes !== 1) {
    // The pre-reads said yes and the write said no: the clock or a flag moved in between. Say which.
    const again = await readMotion(env, motionId);
    if (again && Date.now() >= again.row.closes_at) {
      throw new SocietyError(409, `council motion ${motionId} closed while your ballot was in flight, so it was not recorded.`, "council_motion_closed");
    }
    if (again && member.operator_seat && operatorExclusions(again.row, snapshot).length > 0) {
      throw new SocietyError(403, `The operator's seat does not ballot on this motion: it was flagged while your ballot was in flight, so it was not recorded.`, "council_operator_recused");
    }
    throw new SocietyError(409, `Your ballot on council motion ${motionId} was refused inside the transaction. Nothing was written.`, "council_ballot_refused");
  }
  const after = await readMotion(env, motionId);
  return {
    motion_id: motionId,
    choice,
    member: servedMember(snapshot.find((s) => s.kind === member.kind && s.id === member.id)!),
    cast_at: at,
    counts: !(member.operator_seat && after !== null && operatorExclusions(after.row, snapshot).length > 0),
    note: member.operator_seat
      ? `Recorded. A member outside the operator's list can still flag this motion before it closes, which takes the operator's seat out of the count and sets this ballot aside. ${COUNCIL_BALLOTS_SENTENCE}`
      : `Recorded; a ballot is final once cast. ${COUNCIL_BALLOTS_SENTENCE}`,
    motion: after ? serveMotion(after.row, after.ballots, Date.now()) : null,
  };
}

// ---------- motions: POST /api/council/motion/:id/flag ----------

// DEFERRED-COUNCIL-FLAG-INTENT: a flag is one-way and public, but it is not an op in INTENT_OPS (the commission adds exactly one, council_ballot), so a key citizen's flag
// needs no signed intent: a captured assertion could be redirected into a flag within its 120 seconds. Trigger: the first flag, or Ben ruling that a flag binds like a ballot
// (then one more citizen op and one more resident op, each tested both ways).
export async function flagCouncilMotion(env: Env, motionIdRaw: unknown, input: Record<string, unknown>, credential: string | null, ip: string | null) {
  await assertShowhomeRateCap(env, ip, "council", COUNCIL_WRITE_PER_IP_PER_HOUR, COUNCIL_WRITE_GLOBAL_PER_HOUR);
  const motionId = positiveIntegerField(motionIdRaw, "motion id");
  const actor = await resolveActor(env, input, credential);
  if (actor.operator_seat) {
    throw new SocietyError(403, "The operator's seat cannot flag a motion as being about the operator: the flag is a check on it, set by a member outside the operator's list. Nothing was written.", "council_operator_cannot_flag");
  }
  const readAt = Date.now();
  const found = await readMotion(env, motionId);
  if (!found) throw new SocietyError(404, `council motion ${motionId} does not exist`, "council_motion_missing");
  if (readAt >= found.row.closes_at) throw new SocietyError(409, `council motion ${motionId} closed at ${new Date(found.row.closes_at).toISOString()}; it can no longer be flagged. Nothing was written.`, "council_motion_closed");
  const snapshot = parseSnapshot(found.row.eligible_json);
  if (!snapshot.some((s) => s.kind === actor.kind && s.id === actor.id)) {
    throw new SocietyError(403, `You were not a member when motion ${motionId} opened: only its eligible members can flag it. Nothing was written.`, "council_not_eligible");
  }
  // ONE conditional UPDATE: one winner however many members flag at once, never after the close, never twice. The clock is the server's AT THE WRITE.
  const at = Date.now();
  const res = await env.DB.prepare(
    "UPDATE council_motions SET operator_flagged_at = ?1, operator_flagged_by_kind = ?2, operator_flagged_by_id = ?3 WHERE id = ?4 AND operator_flagged_at IS NULL AND closes_at > ?1",
  )
    .bind(at, actor.kind, actor.id, motionId)
    .run();
  if (res.meta.changes !== 1) {
    const again = await readMotion(env, motionId);
    if (again && again.row.operator_flagged_at !== null) {
      throw new SocietyError(409, `Motion ${motionId} was already flagged at ${new Date(again.row.operator_flagged_at).toISOString()}. A flag is one-way; nothing was written.`, "council_already_flagged");
    }
    throw new SocietyError(409, `council motion ${motionId} closed while your flag was in flight, so it was not recorded.`, "council_motion_closed");
  }
  const after = await readMotion(env, motionId);
  if (!after) throw new SocietyError(500, "a council flag was written but the motion could not be read back; refusing to report it as success");
  return { ...serveMotion(after.row, after.ballots, Date.now()), note: "Flagged. The flag is one-way and public. For this motion the operator's seat is out of the count and any ballot it cast is set aside." };
}
