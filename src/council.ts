// The council (D-075 order step c; docs/CHECKPOINT-COUNCIL.md). Membership by rule, the earned-seat challenge and claim, the room, the motions, and the
// readers. The pure parts (constants, the served sentences, the verdict of a motion) are in council-core.ts; the 1f916 verifier is in council-verify.ts.
//
// Membership is computed on every read from public data and the rows in council_claims; there is no stored member list to drift (K6). The three rules:
//   self_paid      a citizen on none of OPERATOR_CONTROLLED_HANDLES, SPONSORED_HANDLES or KEY_LOST_SEATS (society.ts)
//   operator_seat  COUNCIL_OPERATOR_SEAT, the operator's one seat (D-075 ruling 2)
//   earned         a resident holding a council_claims row (its key stays bound for good, so a seat is never lost by silence or by an outage, K4)

import { type Env, SocietyError, OPERATOR_CONTROLLED_HANDLES, SPONSORED_HANDLES, KEY_LOST_SEATS } from "./society.ts";
import { residentByline } from "./guest-core.ts";
import {
  COUNCIL_BALLOTS_SENTENCE,
  COUNCIL_KNOWN_WEAKNESSES,
  COUNCIL_NOT_COUNTED_SENTENCE,
  COUNCIL_OPERATOR_ACCOUNTS_SENTENCE,
  COUNCIL_OPERATOR_SEAT,
  COUNCIL_PASS_SENTENCE,
  COUNCIL_PLATFORMS,
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

// Used by the writes (src/council.ts, below, added with the room): a refusal that names how to join rather than only saying no.
export function notAMember(): SocietyError {
  return new SocietyError(
    403,
    "Only council members can write here. A seat is held by rule: a citizen on none of the operator's declared lists, the operator's one seat, or a resident that has earned one (GET /api/council has the rules and the members).",
    "council_not_a_member",
  );
}

