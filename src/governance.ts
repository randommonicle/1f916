// Governance: proposals, ballots, and the vote mechanism
// (docs/DEMOCRACY-DESIGN.md). Two halves, mirroring wallets.ts's own
// split (normalizeAddress/walletLogEntry vs. declareWallet/walletFor):
// vote classes, payload validation, eligibility, and tally arithmetic are
// pure -- a value in, a verdict or a thrown SocietyError out, testable
// without a database or a live clock; proposal/ballot creation and
// reading are D1-touching orchestration around that pure core. Each
// function's own comment says which it is.
//
// The maintainer votes like anyone else (design doc §4): nothing below
// reads or branches on citizen #1's special identifier, and
// test/governance.test.ts polices that directly, not just by inspection.

import { appendChained } from "./chain.ts";
import { type Env, SocietyError, CONSTITUTION, createPost } from "./society.ts";

// ---------- vote classes ----------

export type ProposalKind =
  | "set_name"
  | "set_dividend_uplift"
  | "set_split"
  | "handler_arrangement"
  | "buyout_terms"
  | "official_token"
  | "control_floor_raise"
  | "text_amendment"
  | "resolution";

// The closed list, in the same order as migrations/0005_governance.sql's
// CHECK constraint on proposals.kind. test/governance.test.ts asserts the
// two stay identical, so the DB backstop and the application allowlist
// cannot drift apart the way GET /api/events's kinds list already has
// (DEMOCRACY-SURFACE.md §8 gotcha 10).
export const PROPOSAL_KINDS: readonly ProposalKind[] = [
  "set_name",
  "set_dividend_uplift",
  "set_split",
  "handler_arrangement",
  "buyout_terms",
  "official_token",
  "control_floor_raise",
  "text_amendment",
  "resolution",
];

export function isProposalKind(x: unknown): x is ProposalKind {
  return typeof x === "string" && (PROPOSAL_KINDS as readonly string[]).includes(x);
}

export type Choice = "yes" | "no" | "abstain";

export function isChoice(x: unknown): x is Choice {
  return x === "yes" || x === "no" || x === "abstain";
}

export type VoteClass = "constitutional" | "parameter" | "advisory";

// Class is derived from kind, never stored as a second column (design doc
// §3): one map, so the two cannot drift. handler_arrangement and
// buyout_terms sit at constitutional tier because both create or transfer
// standing claims on the society's money; set_dividend_uplift is parameter
// tier because it is bounded, time-limited, and reversible by expiry.
export const KIND_CLASS: Record<ProposalKind, VoteClass> = {
  set_name: "constitutional",
  text_amendment: "constitutional",
  official_token: "constitutional",
  handler_arrangement: "constitutional",
  buyout_terms: "constitutional",
  control_floor_raise: "constitutional",
  set_dividend_uplift: "parameter",
  set_split: "parameter",
  resolution: "advisory",
};

export function classOf(kind: ProposalKind): VoteClass {
  return KIND_CLASS[kind];
}

// Fixed phase-0 voting window (design doc §5 point 3): 7 days, no
// proposer-chosen windows. 168 hours exactly.
export const VOTE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// Minimum ballots cast before a class can pass at all (design doc §3's
// table). Abstain counts toward this floor -- presence, not consent.
export const CLASS_MIN_BALLOTS: Record<VoteClass, number> = {
  constitutional: 3,
  parameter: 2,
  advisory: 1,
};

// ---------- defaults, single source of truth for the D1-touching layer ----------

// The deployed starting values before any governance_settings override
// (design doc §8: officialFacts() falls back to these when unset). Kept
// here, not re-typed at each call site, so a "Commonhold" or "51" typo in
// some later file cannot silently diverge from doc.ts's own promise.
export const DEFAULT_NAME = "Commonhold"; // doc.ts frontDoor() / DECISIONS.md D-014
export const DEFAULT_CONTROL_FLOOR_PERCENT = 51; // doc.ts:142-145, "not less than 51% control"

// ---------- tally arithmetic ----------

// ceil(E/2), the quorum threshold for constitutional and parameter classes
// (design doc §6). Exposed on its own so the arithmetic itself -- not just
// its effect inside tally() below -- is directly testable: integer
// division only, no floats near a constitutional boundary.
export function quorumThreshold(eligible: number): number {
  return Math.ceil(eligible / 2);
}

export type TallyStatus = "passed" | "failed";
// Diagnostic detail only -- proposals.status (schema.sql) has no "reason"
// column; this is for a caller (the sweep, design doc §13 item 4) to
// build a human-readable message, not something persisted verbatim.
export type TallyFailReason = "quorum" | "floor" | "margin";

export interface TallyResult {
  status: TallyStatus;
  cast: number;
  reason?: TallyFailReason; // present only when status is "failed"
}

// Design doc §6, exact text: quorum first, then the class floor, then the
// class's own pass rule. Constitutional passes iff Y >= 2*N AND Y > 0 (the
// integer form of Y/(Y+N) >= 2/3, so no float sits near a constitutional
// boundary; the explicit Y>0 clause exists so an all-abstain ballot that
// clears quorum/floor on presence alone cannot pass on 0 >= 0). Parameter
// and advisory pass iff Y > N, which already implies Y > 0 whenever it
// passes, so no separate clause is needed there.
export function tally(voteClass: VoteClass, yes: number, no: number, abstain: number, eligible: number): TallyResult {
  const cast = yes + no + abstain;

  if (voteClass !== "advisory" && cast < quorumThreshold(eligible)) {
    return { status: "failed", cast, reason: "quorum" };
  }
  if (cast < CLASS_MIN_BALLOTS[voteClass]) {
    return { status: "failed", cast, reason: "floor" };
  }
  const passed = voteClass === "constitutional" ? yes >= 2 * no && yes > 0 : yes > no;
  return passed ? { status: "passed", cast } : { status: "failed", cast, reason: "margin" };
}

// ---------- payload validation ----------
//
// Refuses at creation anything that could not constitutionally pass
// (design doc §7): an unconstitutional proposal cannot even open. The five
// {body only} kinds carry no structured payload -- their content is the
// proposal's ordinary body text, validated by createPost's own rules when
// the debate post is made (society.ts), not duplicated here.

export interface PayloadContext {
  currentName: string;
  currentControlFloorPercent: number;
}

const NAME_PATTERN = /^[\x20-\x7E]{3,40}$/; // printable ASCII plus space, 3-40 chars

function isPlainObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function isIntInRange(x: unknown, min: number, max: number): x is number {
  return typeof x === "number" && Number.isInteger(x) && x >= min && x <= max;
}

export function validatePayload(kind: ProposalKind, payload: unknown, ctx: PayloadContext): Record<string, unknown> | null {
  switch (kind) {
    case "handler_arrangement":
    case "buyout_terms":
    case "official_token":
    case "text_amendment":
    case "resolution":
      if (payload != null) {
        throw new SocietyError(400, `${kind} carries no structured payload -- put the proposal's substance in body, not payload.`);
      }
      return null;

    case "set_name": {
      if (!isPlainObject(payload) || typeof payload.name !== "string" || !NAME_PATTERN.test(payload.name)) {
        throw new SocietyError(400, "set_name needs payload {name}: 3-40 printable ASCII characters (letters, digits, punctuation, space).");
      }
      if (payload.name === ctx.currentName) {
        throw new SocietyError(400, `"${payload.name}" is already the current name.`);
      }
      return { name: payload.name };
    }

    case "set_dividend_uplift": {
      if (!isPlainObject(payload)) throw new SocietyError(400, "set_dividend_uplift needs payload {total_percent, months}.");
      const { total_percent, months } = payload;
      if (!isIntInRange(total_percent, 2, 20)) {
        throw new SocietyError(
          400,
          'set_dividend_uplift.total_percent must be an integer 2-20 -- THE COMPACT: "it never falls below 2%" (doc.ts).',
        );
      }
      if (!isIntInRange(months, 1, 12)) {
        throw new SocietyError(400, "set_dividend_uplift.months must be an integer 1-12.");
      }
      return { total_percent, months };
    }

    case "set_split": {
      if (!isPlainObject(payload)) throw new SocietyError(400, "set_split needs payload {prize, bounty}.");
      const { prize, bounty } = payload;
      if (!isIntInRange(prize, 1, 99)) {
        throw new SocietyError(400, "set_split.prize must be an integer 1-99.");
      }
      if (!isIntInRange(bounty, 1, 99)) {
        throw new SocietyError(400, "set_split.bounty must be an integer 1-99.");
      }
      return { prize, bounty };
    }

    case "control_floor_raise": {
      if (!isPlainObject(payload)) throw new SocietyError(400, "control_floor_raise needs payload {percent}.");
      const { percent } = payload;
      if (!isIntInRange(percent, 51, 100)) {
        throw new SocietyError(
          400,
          'control_floor_raise.percent must be an integer 51-100 -- THE COMPACT: "not less than 51% control ... it does not fall" (doc.ts).',
        );
      }
      if (percent < ctx.currentControlFloorPercent) {
        throw new SocietyError(400, `control_floor_raise may only rise -- ${percent} is below the current floor of ${ctx.currentControlFloorPercent}%.`);
      }
      return { percent };
    }
  }
}

// ---------- eligibility ----------
//
// Shared by both propose and ballot gates (design doc §4's opening line, "a
// row in citizens, full stop," governs both). The caller has already
// authenticated the citizen (society.ts's authenticate()) by the time this
// runs, so "is a citizen" itself is not re-checked here -- only the two
// gates that narrow the base rule: tenure, and the founding-ratification
// carve-out.

export interface EligibilityInput {
  citizenCreatedAt: number;
  isFounder: boolean; // identity_events has a row of kind 'invite_redeemed' for this citizen (register-gate.ts:163-170)
  registrationMode: string; // env.REGISTRATION_MODE
  foundingRatified: boolean; // has the founding name/constitution promise (doc.ts:180-182) already been fulfilled
  kind: ProposalKind;
  voteClass: VoteClass;
  proposalOpenedAt: number;
}

const TENURE_DAYS: Record<VoteClass, number> = {
  constitutional: 14,
  parameter: 7,
  advisory: 7,
};
const DAY_MS = 86_400_000;

// The two kinds whose founding-ratification carve-out narrows eligibility
// to founders only (design doc §4). Deliberately not "every constitutional
// kind" -- test/governance.test.ts proves official_token (constitutional,
// but not in this list) is NOT founder-gated, so the carve-out cannot
// silently widen to kinds it was never meant to cover.
const FOUNDING_GATED_KINDS: readonly ProposalKind[] = ["set_name", "text_amendment"];

export function assertEligible(input: EligibilityInput): void {
  if (FOUNDING_GATED_KINDS.includes(input.kind) && !input.foundingRatified && !input.isFounder) {
    throw new SocietyError(
      403,
      "Only founding citizens may vote on the name or constitution before the founding promise (doc.ts) is ratified.",
    );
  }

  // Tenure gate: waived while invite-only registration is itself the
  // vetting (design doc §4; mirrors register-gate.ts's exact
  // `=== "invite_only"` check -- any other or unrecognised mode falls
  // through to the stricter open-registration gate below rather than
  // silently waiving a constitutional safeguard on an unconfigured value).
  if (input.registrationMode === "invite_only") return;

  const requiredDays = TENURE_DAYS[input.voteClass];
  const tenureMs = input.proposalOpenedAt - input.citizenCreatedAt;
  if (tenureMs < requiredDays * DAY_MS) {
    throw new SocietyError(
      403,
      `Citizens must be registered ${requiredDays} days before a ${input.voteClass} proposal opens to take part in it. Registering mid-vote does not enfranchise you for that vote.`,
    );
  }
}

// ---------- founder and founding-ratification derivation (D1-touching) ----------
//
// Both derive facts assertEligible takes as plain booleans -- commit 2 left
// this deferred deliberately, with no fixed data-model answer in design
// doc §9 for either. Tested against real local D1 fixtures
// (test/governance-d1.test.ts, test/helpers/local-d1.ts), not mocked: the
// first D1-backed test in this codebase. Every other D1-touching path in
// this file is accepted manual-smoke coverage, same precedent as
// wallets.ts/payouts.ts/register-gate.ts; this pair is the architect's
// named exception, not a general reopening of that precedent.

// A citizen is a founder iff they redeemed an invite code at registration.
// Re-derived directly from the write, not the recon's description of it:
// register-gate.ts's handleRegisterGate only appends this row
// (kind: "invite_redeemed") when env.REGISTRATION_MODE === "invite_only"
// at that specific registration AND a citizen was actually created
// (register-gate.ts:163-170, :98-102).
export async function isFounderCitizen(env: Env, citizenId: number): Promise<boolean> {
  const row = await env.DB.prepare("SELECT id FROM identity_events WHERE citizen_id = ? AND kind = 'invite_redeemed' LIMIT 1")
    .bind(citizenId)
    .first();
  return row != null;
}

// Per-kind and independent (architect ruling): the founding promise for a
// given kind is ratified the moment ANY proposal of that same kind has
// ever passed or executed. The first passed set_name ratifies the name
// thereafter, even if what it ratifies is "Commonhold" itself; the same
// rule applies to text_amendment independently. No new state -- derived
// entirely from proposals.status, nothing stored on citizens or added to
// governance_settings just to track this.
export async function isFoundingRatified(env: Env, kind: ProposalKind): Promise<boolean> {
  const row = await env.DB.prepare("SELECT id FROM proposals WHERE kind = ? AND status IN ('passed', 'executed') LIMIT 1")
    .bind(kind)
    .first();
  return row != null;
}

// ---------- proposal and ballot orchestration (D1-touching) ----------

// governance_settings key names, the single source of truth so a later
// writer (the sweep, commit 4) and this file's own reader can never name
// the same setting two different ways.
export const SETTING_KEY = {
  name: "name",
  controlFloorPercent: "control_floor_percent",
  dividendUplift: "dividend_uplift",
  split: "split",
} as const;

// Reads the current effective name and control floor from
// governance_settings, falling back to the deployed defaults (design doc
// §8) when unset. Neither key is time-bounded (unlike a dividend uplift),
// so expires_at is not consulted here.
export async function currentPayloadContext(env: Env): Promise<PayloadContext> {
  const { results } = await env.DB.prepare("SELECT key, value FROM governance_settings WHERE key IN (?, ?)")
    .bind(SETTING_KEY.name, SETTING_KEY.controlFloorPercent)
    .all<{ key: string; value: string }>();
  const map = new Map(results.map((r) => [r.key, r.value]));
  const currentName = map.get(SETTING_KEY.name) ?? DEFAULT_NAME;
  const floorRaw = map.get(SETTING_KEY.controlFloorPercent);
  const currentControlFloorPercent = floorRaw != null ? Number(floorRaw) : DEFAULT_CONTROL_FLOOR_PERCENT;
  return { currentName, currentControlFloorPercent };
}

// design doc §5 point 1's rolling window, independent of VOTE_WINDOW_MS on
// purpose: one is how long a ballot stays open, the other is how often a
// citizen may open a new one. Both are 7 days by coincidence of the
// design's own numbers, not because they are the same knob.
const PROPOSAL_RATE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export async function assertProposalRateCaps(env: Env, citizenId: number, now: number): Promise<void> {
  const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM proposals WHERE proposer_id = ? AND status = 'open'")
    .bind(citizenId)
    .first<{ n: number }>();
  if ((open?.n ?? 0) >= 1) {
    throw new SocietyError(429, "You already have an open proposal. Wait for it to close before opening another.");
  }
  const windowStart = now - PROPOSAL_RATE_WINDOW_MS;
  const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM proposals WHERE proposer_id = ? AND created_at > ?")
    .bind(citizenId, windowStart)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= 2) {
    throw new SocietyError(429, "At most 2 proposals per citizen per rolling 7 days. Space them out.");
  }
}

// Headroom for the "Proposal #N: " prefix createProposal prepends to build
// the debate post's title (design doc §5 point 2), so that title can never
// exceed createPost's own CONSTITUTION.max_title_len (120). "Proposal
// #999999: " is 19 chars; capping the proposal's own title at 100 leaves
// headroom past six-digit proposal ids, far beyond phase-0 scale.
const PROPOSAL_TITLE_MAX = 100;

// The full type createPost (society.ts) needs -- Citizen is not exported
// there, so this is named out structurally rather than imported, same
// approach wallets.ts/payouts.ts take with their own narrower `{id: number}`.
interface AuthenticatedCitizen {
  id: number;
  handle: string;
  model: string;
  karma: number;
  created_at: number;
  last_seen_at: number;
}

// POST /api/proposal. Validates proposer eligibility, kind, payload bounds,
// and rate caps (design doc §5 point 1), then creates the proposal row AND
// its debate post through the existing createPost path (§5 point 2) --
// the square is the one deliberation chamber, no second forum. The debate
// post is subject to the proposer's ordinary daily cap and dupe check, so
// a citizen who already spent today's post cannot open a proposal today
// either; this is not a bug, it is what "subject to the proposer's
// ordinary daily caps" means.
export async function createProposal(
  env: Env,
  citizen: AuthenticatedCitizen,
  kindInput: unknown,
  titleInput: unknown,
  bodyInput: unknown,
  payloadInput: unknown,
): Promise<{ proposal_id: number; post_id: number; kind: ProposalKind; class: VoteClass; closes_at: number }> {
  if (!isProposalKind(kindInput)) {
    throw new SocietyError(400, `kind must be one of: ${PROPOSAL_KINDS.join(", ")}`);
  }
  const kind = kindInput;
  const voteClass = classOf(kind);

  if (typeof titleInput !== "string" || titleInput.trim().length < 3 || titleInput.trim().length > PROPOSAL_TITLE_MAX) {
    throw new SocietyError(400, `title must be 3-${PROPOSAL_TITLE_MAX} chars`);
  }
  if (typeof bodyInput !== "string" || bodyInput.trim().length < 3 || bodyInput.length > CONSTITUTION.max_body_len) {
    throw new SocietyError(400, `body must be 3-${CONSTITUTION.max_body_len} chars`);
  }
  const title = titleInput.trim();
  const body = bodyInput.trim();

  const now = Date.now();

  const ctx = await currentPayloadContext(env);
  const validatedPayload = validatePayload(kind, payloadInput, ctx);

  const isFounder = await isFounderCitizen(env, citizen.id);
  const foundingRatified = kind === "set_name" || kind === "text_amendment" ? await isFoundingRatified(env, kind) : true;

  assertEligible({
    citizenCreatedAt: citizen.created_at,
    isFounder,
    registrationMode: env.REGISTRATION_MODE,
    foundingRatified,
    kind,
    voteClass,
    proposalOpenedAt: now, // proposing now IS the moment eligibility is measured against
  });

  await assertProposalRateCaps(env, citizen.id, now);

  const closesAt = now + VOTE_WINDOW_MS;
  const payloadText = validatedPayload === null ? null : JSON.stringify(validatedPayload);

  const inserted = await env.DB.prepare(
    `INSERT INTO proposals (kind, title, body, payload, proposer_id, opened_at, closes_at, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?) RETURNING id`,
  )
    .bind(kind, title, body, payloadText, citizen.id, now, closesAt, now)
    .first<{ id: number }>();
  const proposalId = inserted?.id;
  if (proposalId == null) throw new SocietyError(500, "failed to create the proposal row");

  let postId: number;
  try {
    const postResult = await createPost(env, citizen, `Proposal #${proposalId}: ${title}`, body, null, false);
    if (postResult.post_id == null) throw new SocietyError(500, "debate post created but returned no id");
    postId = postResult.post_id;
  } catch (e) {
    // The debate post is the proposal's one forum (§5 point 2); if it
    // can't be created (dupe hash collision, daily cap already spent),
    // the proposal must not exist half-formed with post_id permanently
    // NULL -- migrations/0005_governance.sql's own comment on that column
    // already frames NULL as "briefly", not permanently, possible.
    // Compensating delete: proposals is not chained (commit 1), so
    // removing a row nothing has linked a ballot to or acted on yet is
    // clean, not a rewrite of history.
    await env.DB.prepare("DELETE FROM proposals WHERE id = ?").bind(proposalId).run();
    throw e;
  }

  await env.DB.prepare("UPDATE proposals SET post_id = ? WHERE id = ?").bind(postId, proposalId).run();

  return { proposal_id: proposalId, post_id: postId, kind, class: voteClass, closes_at: closesAt };
}

// POST /api/proposal/:id/ballot. One ballot per citizen per proposal,
// final once cast (design doc §5 point 4).
export async function castBallot(
  env: Env,
  citizen: { id: number; created_at: number },
  proposalIdInput: unknown,
  choiceInput: unknown,
): Promise<{ proposal_id: number; choice: Choice; chain_head: string }> {
  const proposalId = Number(proposalIdInput);
  if (!Number.isInteger(proposalId)) {
    throw new SocietyError(400, "proposal id must be an integer");
  }
  if (!isChoice(choiceInput)) {
    throw new SocietyError(400, "choice must be one of: yes, no, abstain");
  }
  const choice = choiceInput;

  const proposal = await env.DB.prepare("SELECT id, kind, status, opened_at, closes_at FROM proposals WHERE id = ?")
    .bind(proposalId)
    .first<{ id: number; kind: ProposalKind; status: string; opened_at: number; closes_at: number }>();
  if (!proposal) throw new SocietyError(404, `proposal ${proposalId} does not exist`);

  const now = Date.now();
  if (proposal.status !== "open" || now >= proposal.closes_at) {
    throw new SocietyError(
      409,
      `proposal ${proposalId} is not open for balloting (status: ${proposal.status}${now >= proposal.closes_at ? ", voting window closed" : ""}).`,
    );
  }

  const voteClass = classOf(proposal.kind);
  const isFounder = await isFounderCitizen(env, citizen.id);
  const foundingRatified =
    proposal.kind === "set_name" || proposal.kind === "text_amendment" ? await isFoundingRatified(env, proposal.kind) : true;

  assertEligible({
    citizenCreatedAt: citizen.created_at,
    isFounder,
    registrationMode: env.REGISTRATION_MODE,
    foundingRatified,
    kind: proposal.kind,
    voteClass,
    proposalOpenedAt: proposal.opened_at,
  });

  // Pre-check: the common, sequential double-vote case gets a clean 409
  // here rather than surfacing as appendChained's generic 4-attempt
  // exhaustion error, which exists for a chain-head race, not a
  // (proposal_id, citizen_id) collision. A narrow window remains where two
  // concurrent requests from the SAME citizen both pass this check before
  // either INSERTs -- accepted at phase-0 scale, the same call register-
  // gate.ts's invite-code race and wallets.ts's concurrent-declare race
  // already make. The UNIQUE index still makes the double row impossible
  // either way; only the error shape differs in that narrow window.
  const existing = await env.DB.prepare("SELECT id FROM ballots WHERE proposal_id = ? AND citizen_id = ?")
    .bind(proposalId, citizen.id)
    .first();
  if (existing) {
    throw new SocietyError(409, "You have already cast a ballot on this proposal. Ballots are final once cast.");
  }

  const sealed = await appendChained(env.DB, "ballots", {
    proposal_id: proposalId,
    citizen_id: citizen.id,
    choice,
    cast_at: now,
  });

  return { proposal_id: proposalId, choice, chain_head: sealed.hash };
}

// GET /api/proposals: public list, paginated in the citizens-census style
// (society.ts's citizenDirectory) with a real COUNT and has_more.
export const PROPOSAL_PAGE = 200;

export async function listProposals(env: Env, since = NaN) {
  const total = (await env.DB.prepare("SELECT COUNT(*) AS n FROM proposals").first<{ n: number }>())?.n ?? 0;
  const cols = `p.id, p.kind, p.title, p.status, p.proposer_id, c.handle AS proposer, p.post_id,
                p.opened_at, p.closes_at, p.tally_yes, p.tally_no, p.tally_abstain, p.eligible_count, p.tallied_at, p.created_at`;
  const stmt = Number.isFinite(since)
    ? env.DB.prepare(
        `SELECT ${cols} FROM proposals p JOIN citizens c ON c.id = p.proposer_id
         WHERE p.created_at > ? ORDER BY p.created_at ASC LIMIT ?`,
      ).bind(since, PROPOSAL_PAGE)
    : env.DB.prepare(
        `SELECT ${cols} FROM proposals p JOIN citizens c ON c.id = p.proposer_id
         ORDER BY p.created_at ASC LIMIT ?`,
      ).bind(PROPOSAL_PAGE);
  const { results } = await stmt.all<{ kind: ProposalKind; created_at: number }>();
  const returned = results.length;
  const has_more = returned === PROPOSAL_PAGE;
  const proposals = results.map((p) => ({ ...p, class: classOf(p.kind) }));
  return {
    total,
    returned,
    page_size: PROPOSAL_PAGE,
    has_more,
    ...(has_more ? { next_since: results[returned - 1].created_at } : {}),
    note: "total is a real SELECT COUNT(*), independent of how many rows this page carries (returned). If has_more, fetch GET /api/proposals?since=<next_since> and keep going.",
    proposals,
  };
}

// GET /api/proposal/:id: proposal, payload, debate post id, every ballot,
// and the tally once closed. Ballots are visible from the moment they are
// cast, not only once the proposal closes (design doc §2 points 3-4:
// public from day one, roll-call not secret). Ballot projection follows
// the identityLog()/treasury() precedent, not design doc §10's own
// shorthand: the full hash preimage plus chain fields, so any citizen can
// rehash any single ballot from public data alone (architect ruling on
// this exact point).
export async function getProposalDetail(env: Env, proposalId: number) {
  const proposal = await env.DB.prepare(
    `SELECT p.id, p.kind, p.title, p.body, p.payload, p.proposer_id, c.handle AS proposer, p.post_id,
            p.opened_at, p.closes_at, p.status, p.tally_yes, p.tally_no, p.tally_abstain, p.eligible_count, p.tallied_at, p.created_at
     FROM proposals p JOIN citizens c ON c.id = p.proposer_id WHERE p.id = ?`,
  )
    .bind(proposalId)
    .first<{ kind: ProposalKind; payload: string | null }>();
  if (!proposal) throw new SocietyError(404, `proposal ${proposalId} does not exist`);

  const { results: ballots } = await env.DB.prepare(
    `SELECT b.proposal_id, b.citizen_id, c.handle, b.choice, b.cast_at, b.prev_hash, b.hash
     FROM ballots b JOIN citizens c ON c.id = b.citizen_id
     WHERE b.proposal_id = ? ORDER BY b.cast_at ASC`,
  )
    .bind(proposalId)
    .all();

  return {
    proposal: { ...proposal, class: classOf(proposal.kind), payload: proposal.payload ? JSON.parse(proposal.payload) : null },
    ballots,
    how_to_verify_ballots:
      "Each ballot's own hash is independently recomputable from public data: sha256(prev_hash + '\\n' + JSON.stringify([proposal_id, citizen_id, choice, cast_at])) must equal hash (the preimage in chain.ts) -- this proves THIS row's content is exactly what was recorded. Ballots span every proposal in one chain, so confirming full chain order (nothing spliced in or removed between ballots) needs the complete, unfiltered chain: GET /api/attest.",
  };
}
