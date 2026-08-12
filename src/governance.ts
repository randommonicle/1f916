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

import { appendChainedStmt, appendChainedGated, classifyUniqueViolation, sha256Hex, ALREADY_VOTED_MESSAGE, type ChainGate } from "./chain.ts";
import {
  type Env,
  SocietyError,
  CONSTITUTION,
  createPost,
  DEFAULT_NAME,
  DEFAULT_CONTROL_FLOOR_PERCENT,
  DEFAULT_DIVIDEND_PERCENT,
  DEFAULT_SPLIT,
  MAINTAINER_ID,
  SETTING_KEY,
} from "./society.ts";
// doc.ts stays a pure, parameter-driven leaf module (no imports of its
// own) -- frontDoor is called here as a black box, never refactored to
// share internals, so I-007's hashing machinery carries zero regression
// risk to the door's own already-tested rendering (see
// buildConstitutionTemplate below for why calling it twice with the
// deployed defaults, rather than templating its source, is enough).
import { frontDoor } from "./doc.ts";

// Defined in society.ts, not here: officialFacts() (society.ts) needs
// them too, and society.ts is the base module every feature file already
// imports from -- the reverse import would be this codebase's first
// circular one. Re-exported so nothing that already imports these three
// from governance.ts (test/governance.test.ts included) needs to change.
export { DEFAULT_NAME, DEFAULT_CONTROL_FLOOR_PERCENT, SETTING_KEY };

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
  | "resolution"
  | "first_laws_ratify"
  | "first_laws_amendment";

// The closed list, in the same order as migrations/0007_first_laws.sql's
// rebuilt CHECK constraint on proposals.kind (superseding
// migrations/0005_governance.sql's original nine, mirrored the same way at
// schema.sql). test/governance.test.ts asserts all three stay identical, so
// the DB backstop and the application allowlist cannot drift apart the way
// GET /api/events's kinds list already has (DEMOCRACY-SURFACE.md §8 gotcha
// 10). The two First Laws kinds are appended at the end, not sorted in --
// matching how migration 0007 itself appends them to the CHECK constraint.
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
  "first_laws_ratify",
  "first_laws_amendment",
];

export function isProposalKind(x: unknown): x is ProposalKind {
  return typeof x === "string" && (PROPOSAL_KINDS as readonly string[]).includes(x);
}

export type Choice = "yes" | "no" | "abstain";

export function isChoice(x: unknown): x is Choice {
  return x === "yes" || x === "no" || x === "abstain";
}

export type VoteClass = "constitutional" | "parameter" | "advisory" | "entrenched";

// Class is derived from kind, never stored as a second column (design doc
// §3): one map, so the two cannot drift. handler_arrangement and
// buyout_terms sit at constitutional tier because both create or transfer
// standing claims on the society's money; set_dividend_uplift is parameter
// tier because it is bounded, time-limited, and reversible by expiry. The
// two First Laws kinds sit at entrenched -- a fourth tier above
// constitutional (docs/FIRST-LAWS-DESIGN.md §3): adopting or amending the
// laws themselves needs a stricter margin and quorum than an ordinary
// constitutional vote, D-025.
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
  first_laws_ratify: "entrenched",
  first_laws_amendment: "entrenched",
};

export function classOf(kind: ProposalKind): VoteClass {
  return KIND_CLASS[kind];
}

// ---------- maintainer_queue.kind (I-007 wake-side reconciliation) ----------
//
// The maintainer_queue.kind CHECK's own closed list (migrations/0007's
// rebuilt maintainer_queue, mirrored at schema.sql) -- a STRICT superset
// of clerk.ts's own ALLOWED_QUEUE_KINDS (the clerk's drafting cage,
// deliberately narrower: the clerk may never draft a constitution_fidelity
// item -- only wake-side reconciliation inserts one, bound to the wake's
// own run_id). Independently listed here, not spread from clerk.ts's own
// constant: this file must never import FROM src/maintainer/ (clerk.ts and
// judgment.ts both import the shared constitution-detection machinery FROM
// this file, so the reverse edge would be a cycle). test/governance.test.ts
// asserts the strict-subset relationship directly -- that test, not a
// shared import, is what keeps the two lists from drifting apart.
export const DB_QUEUE_KINDS = ["flag_review", "bookkeeping_note", "registration_check", "bulletin_draft", "constitution_fidelity"] as const;
export type DbQueueKind = (typeof DB_QUEUE_KINDS)[number];

// Fixed phase-0 voting window (design doc §5 point 3): 7 days for every
// class except entrenched, no proposer-chosen windows. 168 hours exactly.
export const VOTE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

// The entrenched class alone opens for 14 days (D-025 q4: "every
// once-daily runner sees it ~13 times"). Kept as its own constant rather
// than reshaping VOTE_WINDOW_MS into a per-class record -- every existing
// caller/test that reads VOTE_WINDOW_MS keeps meaning exactly "the
// non-entrenched window", unchanged.
export const ENTRENCHED_VOTE_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export function voteWindowMs(voteClass: VoteClass): number {
  return voteClass === "entrenched" ? ENTRENCHED_VOTE_WINDOW_MS : VOTE_WINDOW_MS;
}

// Minimum ballots cast before a class can pass at all (design doc §3's
// table; entrenched per D-025 q2/[G1-4]: 4, not 5 -- the Gemini debate
// round proved a floor of 5 is a 100%-participation trap at census 5, one
// lost key blocking ratification indefinitely). Abstain counts toward this
// floor -- presence, not consent.
export const CLASS_MIN_BALLOTS: Record<VoteClass, number> = {
  constitutional: 3,
  parameter: 2,
  advisory: 1,
  entrenched: 4,
};

// ---------- tally arithmetic ----------

// ceil(E/2), the quorum threshold for constitutional and parameter classes
// (design doc §6). Exposed on its own so the arithmetic itself -- not just
// its effect inside tally() below -- is directly testable: integer
// division only, no floats near a constitutional boundary.
export function quorumThreshold(eligible: number): number {
  return Math.ceil(eligible / 2);
}

// ceil(2E/3), the quorum threshold for the entrenched class alone (D-025
// q3) -- the ladder's top rung, stricter than constitutional/parameter's
// ceil(E/2). Exposed on its own for the identical reason quorumThreshold
// is: directly testable arithmetic, no float near a constitutional
// boundary. Crosses above the entrenched floor (4) at E=7 -- below that,
// the floor is what actually binds.
export function entrenchedQuorumThreshold(eligible: number): number {
  return Math.ceil((2 * eligible) / 3);
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
// class's own pass rule. Entrenched passes iff Y >= 3*N AND Y > 0 (D-025
// q1: the integer form of Y/(Y+N) >= 75%). Constitutional passes iff Y >=
// 2*N AND Y > 0 (the integer form of Y/(Y+N) >= 2/3, so no float sits near
// a constitutional boundary; the explicit Y>0 clause on both exists so an
// all-abstain ballot that clears quorum/floor on presence alone cannot
// pass on 0 >= 0). Parameter and advisory pass iff Y > N, which already
// implies Y > 0 whenever it passes, so no separate clause is needed there.
export function tally(voteClass: VoteClass, yes: number, no: number, abstain: number, eligible: number): TallyResult {
  const cast = yes + no + abstain;

  if (voteClass !== "advisory") {
    const threshold = voteClass === "entrenched" ? entrenchedQuorumThreshold(eligible) : quorumThreshold(eligible);
    if (cast < threshold) {
      return { status: "failed", cast, reason: "quorum" };
    }
  }
  if (cast < CLASS_MIN_BALLOTS[voteClass]) {
    return { status: "failed", cast, reason: "floor" };
  }
  const passed = voteClass === "entrenched" ? yes >= 3 * no && yes > 0 : voteClass === "constitutional" ? yes >= 2 * no && yes > 0 : yes > no;
  return passed ? { status: "passed", cast } : { status: "failed", cast, reason: "margin" };
}

// Calendar-accurate month arithmetic for a dividend uplift's expiry
// (§7: "months an integer 1-12"). A fixed 30-day approximation would
// drift up to two real days off "N months" for no reason -- this is
// cheap to get right with the platform's own calendar math instead.
//
// docs/REVIEW-DEMOCRACY.md L3: the naive `d.setUTCMonth(d.getUTCMonth() +
// months)` overshoots whenever the start day does not exist in the target
// month -- JS silently rolls the excess into the month after (31 Jan + 1
// -> 3 Mar, not the intended "one month later"; 31 Mar + 1 -> 1 May), up to
// ~3 days longer than the vote authorised, on the money path, always in
// the operator's favour. Fixed by computing the target month's real last
// day first (day 0 of the following month, a standard JS idiom) and
// clamping the original day-of-month to it, rather than letting the Date
// object overflow and normalise on its own. Time-of-day is preserved
// exactly; only the date can move.
export function monthsFromNow(now: number, months: number): number {
  const d = new Date(now);
  const year = d.getUTCFullYear();
  const targetMonth = d.getUTCMonth() + months; // may be outside 0-11; Date.UTC normalises the YEAR correctly for that, unlike the day-of-month overflow this fixes
  const lastDayOfTargetMonth = new Date(Date.UTC(year, targetMonth + 1, 0)).getUTCDate();
  const day = Math.min(d.getUTCDate(), lastDayOfTargetMonth);
  return new Date(Date.UTC(year, targetMonth, day, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds(), d.getUTCMilliseconds())).getTime();
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

// printable ASCII plus space, 3-40 chars, at least one non-space
// character (docs/REVIEW-DEMOCRACY.md L4: space is itself in the
// printable-ASCII range, so without the lookahead "   " -- three spaces
// -- passed this pattern, rendering as a blank title and a bare "—"
// signature).
const NAME_PATTERN = /^(?=.*\S)[\x20-\x7E]{3,40}$/;

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
    case "first_laws_ratify":
    case "first_laws_amendment":
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

// The FIRST LAWS section heading, matched literally (docs/FIRST-LAWS-DESIGN.md
// §3: "a body that targets the FIRST LAWS section must use
// first_laws_amendment ... detection is honest-best-effort on free text --
// the section heading's literal", and the constitution states the rule in
// prose so a disguised amendment is void ab initio regardless). A
// hardcoded literal, not imported from doc.ts: this validation lands in
// commit 2, before doc.ts's own FIRST LAWS section exists (commit 3) --
// test/doc.test.ts polices that the two stay in agreement once both do.
const FIRST_LAWS_HEADING = "FIRST LAWS";

// Pure. text_amendment is the general amendment path for the rest of the
// constitution; a body that targets the First Laws section specifically
// must go through first_laws_amendment instead, whose entrenched
// threshold this refusal exists to make impossible to route around by
// simply picking the lower-threshold kind. Best-effort by design (design
// doc §4): free text can always be disguised, so this is a courtesy
// refusal at creation, not the mechanism that actually holds -- §5's
// archive plus the judgment wake's fidelity review are what that is.
export function refusesDisguisedFirstLawsAmendment(kind: ProposalKind, body: string): string | null {
  if (kind !== "text_amendment") return null;
  if (!body.includes(FIRST_LAWS_HEADING)) return null;
  return "text_amendment may not target the FIRST LAWS section -- propose a first_laws_amendment instead (it carries the entrenched threshold the laws require).";
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
  entrenched: 14, // same as constitutional, ruled at brief time (D-025)
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

// How many citizens WOULD be eligible to ballot on a proposal of this
// shape right now (design doc §4: "eligible count is snapshotted onto
// the proposal at close ... so every historical quorum check remains
// recomputable"). Pure: the D1 reads (every citizen's id/created_at, the
// set of founder citizen ids) happen once in the caller (the sweep), not
// per-citizen -- this just runs assertEligible over the results and
// counts who does not throw, so the same rule balloting uses is the rule
// the census is measured against, with no second copy of it to drift.
export function countEligible(
  citizens: readonly { id: number; created_at: number }[],
  founderIds: ReadonlySet<number>,
  params: { kind: ProposalKind; voteClass: VoteClass; registrationMode: string; foundingRatified: boolean; proposalOpenedAt: number },
): number {
  let count = 0;
  for (const citizen of citizens) {
    try {
      assertEligible({
        citizenCreatedAt: citizen.created_at,
        isFounder: founderIds.has(citizen.id),
        registrationMode: params.registrationMode,
        foundingRatified: params.foundingRatified,
        kind: params.kind,
        voteClass: params.voteClass,
        proposalOpenedAt: params.proposalOpenedAt,
      });
      count++;
    } catch {
      // ineligible; not counted -- the specific reason does not matter here.
    }
  }
  return count;
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

// ---------- First Laws creation gates (D1-touching) ----------
//
// Two sequencing rules docs/FIRST-LAWS-DESIGN.md §7 states in prose,
// enforced here so an unconstitutional proposal cannot even open (the
// same "structural, not merely arithmetical" idiom control_floor_raise's
// may-only-rise check already uses). Neither is expressible inside
// validatePayload (pure, no D1 access) -- both need a fresh read of
// proposal/settings state createProposal already has env for.

// At least one set_name proposal must have reached a TERMINAL status
// (passed, failed, OR executed -- deciding the name at all counts; a kept
// name is still a decided name) before first_laws_ratify may even open.
// Deliberately distinct from isFoundingRatified above (which only counts
// passed/executed): this gate is about the cohort having VOTED on the
// name, not about which way the vote went.
async function hasDecidedProposalOfKind(env: Env, kind: ProposalKind): Promise<boolean> {
  const row = await env.DB.prepare("SELECT id FROM proposals WHERE kind = ? AND status IN ('passed', 'failed', 'executed') LIMIT 1")
    .bind(kind)
    .first();
  return row != null;
}

// Whether first_laws_ratify has already passed -- governance_settings key
// first_laws_ratified is set the moment it executes (settingsStatementForExecution
// below). D1-touching, so this lives here rather than in PayloadContext
// (read once per createProposal call regardless of kind; this is a
// First-Laws-specific extra read, only made for these two kinds).
async function isFirstLawsRatified(env: Env): Promise<boolean> {
  const row = await env.DB.prepare("SELECT 1 FROM governance_settings WHERE key = ?").bind(SETTING_KEY.firstLawsRatified).first();
  return row != null;
}

// docs/FIRST-LAWS-DESIGN.md §7: first_laws_ratify refuses to open until
// (a) the cohort has actually decided the name (passed or failed both
// count) and (b) the laws are not ALREADY ratified (nothing left to
// ratify). first_laws_amendment refuses to open until the laws exist to
// amend. Neither check applies to any other kind -- a no-op for them.
export async function assertFirstLawsCreationGates(env: Env, kind: ProposalKind): Promise<void> {
  if (kind === "first_laws_ratify") {
    if (!(await hasDecidedProposalOfKind(env, "set_name"))) {
      throw new SocietyError(
        403,
        "first_laws_ratify cannot open until a set_name proposal has reached a decision (passed or failed) -- the cohort must decide the name first.",
      );
    }
    if (await isFirstLawsRatified(env)) {
      throw new SocietyError(400, "the First Laws are already ratified -- nothing left to ratify. Propose a first_laws_amendment instead.");
    }
  } else if (kind === "first_laws_amendment") {
    if (!(await isFirstLawsRatified(env))) {
      throw new SocietyError(
        403,
        "first_laws_amendment cannot open until the First Laws are ratified -- there is nothing yet to amend. Propose first_laws_ratify first.",
      );
    }
  }
}

// ---------- proposal and ballot orchestration (D1-touching) ----------

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

// Check-then-act, the same shape and the same accepted window as
// castBallot's own pre-check further down (docs/REVIEW-DEMOCRACY.md L8):
// two concurrent POST /api/proposal from the same citizen can both pass
// both SELECTs below before either's INSERT lands, so both proposals
// open. Accepted at phase-0 scale, the same call register-gate.ts's
// invite-code race and wallets.ts's concurrent-declare race already
// make. Previously undocumented here specifically -- recorded now so the
// next reader does not have to re-derive it.
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

  const disguisedReason = refusesDisguisedFirstLawsAmendment(kind, body);
  if (disguisedReason) throw new SocietyError(400, disguisedReason);

  const now = Date.now();

  const ctx = await currentPayloadContext(env);
  const validatedPayload = validatePayload(kind, payloadInput, ctx);
  await assertFirstLawsCreationGates(env, kind);

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

  const closesAt = now + voteWindowMs(voteClass);
  const payloadText = validatedPayload === null ? null : JSON.stringify(validatedPayload);

  // Frozen at open, per docs/REVIEW-DEMOCRACY.md H2/M6 (migration 0006):
  // castBallot and the sweep's close-time census read these two columns
  // off THIS row from here on, never env.REGISTRATION_MODE and never a
  // live isFoundingRatified() re-query, so a REGISTRATION_MODE flip or a
  // different proposal's ratification mid-vote cannot change the rule
  // this proposal's own ballots were cast under.
  const inserted = await env.DB.prepare(
    `INSERT INTO proposals (kind, title, body, payload, proposer_id, opened_at, closes_at, status, registration_mode, founding_ratified, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?) RETURNING id`,
  )
    .bind(kind, title, body, payloadText, citizen.id, now, closesAt, env.REGISTRATION_MODE, foundingRatified ? 1 : 0, now)
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
    // clean, not a rewrite of history. Safe against a ballot landing in
    // this exact window (docs/REVIEW-DEMOCRACY.md M1, reproduced under
    // FK enforcement as a raw "FOREIGN KEY constraint failed" that
    // replaced this citizen's honest refusal): castBallot below now
    // refuses any proposal whose post_id is still NULL, so no ballot can
    // ever come to reference this row while it is deletable.
    try {
      await env.DB.prepare("DELETE FROM proposals WHERE id = ?").bind(proposalId).run();
    } catch (deleteError) {
      // If the delete itself throws anyway (defence in depth -- some
      // other reason, not the ballot window this commit closes), the
      // ORIGINAL createPost error is what the caller must see, never
      // the delete's: a citizen's honest "daily post spent" refusal
      // must not be replaced by a raw constraint error the delete
      // happened to hit. Logged loudly since a proposal row can now be
      // left behind with post_id NULL, which the maintainer should know
      // about even though no citizen-facing surface can act on it.
      console.log(
        JSON.stringify({
          level: "error",
          event: "proposal_compensating_delete_failed",
          proposal_id: proposalId,
          delete_error: String(deleteError),
          original_error: String(e),
        }),
      );
    }
    throw e;
  }

  // Runs after createPost has already committed and returned its id (the
  // debate post's title embeds this proposal's own id, so the order
  // cannot reverse). If THIS statement is what fails, the post exists
  // and the proposal survives with post_id NULL until whatever failed
  // here is retried -- castBallot's own gate above (M1) refuses any
  // ballot against it meanwhile, so this is a visibility gap, not a
  // safety one. Same shape as the logModeration divergence already
  // recorded (docs/recon/DEMOCRACY-SURFACE.md, "Divergences observed"
  // #2): a two-step commit whose second step cannot be rolled back into
  // the first. No new risk (docs/REVIEW-DEMOCRACY.md L9); worth the
  // comment so it is not mistaken for an oversight.
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

  const proposal = await env.DB.prepare(
    "SELECT id, kind, status, opened_at, closes_at, post_id, registration_mode, founding_ratified FROM proposals WHERE id = ?",
  )
    .bind(proposalId)
    .first<{
      id: number;
      kind: ProposalKind;
      status: string;
      opened_at: number;
      closes_at: number;
      post_id: number | null;
      registration_mode: string;
      founding_ratified: number;
    }>();
  if (!proposal) throw new SocietyError(404, `proposal ${proposalId} does not exist`);

  // docs/REVIEW-DEMOCRACY.md M1: the debate post is the one deliberation
  // chamber (design doc §5 point 2), and `post_id` starts NULL for the
  // brief span between the proposal row's insert and createProposal's
  // own post-creation step landing. Refusing here closes the window a
  // ballot could otherwise land in during that span (or, in the
  // pathological case, on a row `createProposal`'s compensating delete
  // failed to remove): a proposal with no debate post is never
  // ballotable, full stop, regardless of status or timing.
  if (proposal.post_id == null) {
    throw new SocietyError(409, "not yet open for balloting: the debate post is still being created");
  }

  const now = Date.now();
  if (proposal.status !== "open" || now >= proposal.closes_at) {
    throw new SocietyError(
      409,
      `proposal ${proposalId} is not open for balloting (status: ${proposal.status}${now >= proposal.closes_at ? ", voting window closed" : ""}).`,
    );
  }

  const voteClass = classOf(proposal.kind);
  const isFounder = await isFounderCitizen(env, citizen.id);

  // registration_mode and founding_ratified are read off THIS row, frozen
  // at open, never env.REGISTRATION_MODE and never a live
  // isFoundingRatified() re-query (docs/REVIEW-DEMOCRACY.md H2/M6): the
  // rule a ballot is cast under and the rule the close-time census is
  // measured under must be the identical snapshot, or a routine
  // REGISTRATION_MODE flip or an unrelated proposal's ratification can
  // silently change which ballots this one's outcome depends on.
  assertEligible({
    citizenCreatedAt: citizen.created_at,
    isFounder,
    registrationMode: proposal.registration_mode,
    foundingRatified: proposal.founding_ratified === 1,
    kind: proposal.kind,
    voteClass,
    proposalOpenedAt: proposal.opened_at,
  });

  // Pre-check: the common, sequential double-vote case gets a clean 409
  // here rather than surfacing as appendChained's generic 4-attempt
  // exhaustion error, which exists for a chain-head race, not a
  // (proposal_id, citizen_id) collision. A narrow window remains where two
  // concurrent requests from the SAME citizen both pass this check before
  // either INSERTs -- appendChainedGated's own UNIQUE-family classifier
  // (chain.ts, F4/hardening-2) closes that window with the identical 409,
  // zero wasted retries, rather than the four-attempt exhaustion this
  // pre-check alone once left as the fallback.
  if ((await hasExistingBallot(env, proposalId, citizen.id)) != null) {
    throw new SocietyError(409, ALREADY_VOTED_MESSAGE);
  }

  // Guarded, not a plain appendChained (docs/REVIEW-DEMOCRACY-RECHECK.md
  // N1, reproduced): the status/window check above reads the proposal
  // once, but appending is still ~3 more D1 round trips away (isFounder,
  // the existing-ballot check, the head read inside the append itself),
  // and POST /api/governance/sweep is permissionless and unrate-limited --
  // it can claim and fully tally this proposal inside that gap. An
  // unguarded append would still land on the chain, published and handed
  // a chain_head, yet excluded from the tally that already ran: three
  // ballots against a tally of two, an internally impossible public
  // record. The insert is conditioned on the proposal still being 'open'
  // at the moment it actually executes, the same WHERE EXISTS shape
  // upsertSettingStmt below already proves -- a guard refusal (outcome
  // null) is reported as an honest refusal, never a silently orphaned
  // ballot.
  const sealed = await appendChainedGated(
    env.DB,
    "ballots",
    { proposal_id: proposalId, citizen_id: citizen.id, choice, cast_at: now },
    { sql: "SELECT 1 FROM proposals WHERE id = ? AND status = 'open'", args: [proposalId] },
  );
  if (sealed === null) {
    // F5 (docs/REVIEW-CHAINGATE-2026-08-09.md, hardening-2): the gate can
    // refuse for a citizen who ALSO already holds a ballot on this
    // proposal -- a double-vote landing concurrently with the sweep's own
    // claim, where the WHERE EXISTS (status='open') gate is evaluated
    // before the UNIQUE index ever would be (chain.ts's own commentary on
    // appendChainedStmt: the gate wins silently, no insert is attempted,
    // so no constraint is evaluated). Pre-fix, the message named only the
    // closing, never the double vote -- accurate about the outcome, wrong
    // about the (also true) cause. One SELECT, on this refusal path only:
    // the common case (proposal genuinely just closed, no prior ballot)
    // pays nothing extra.
    // Gate finding 4 (docs/REVIEW-HARDENING2-GATE-2026-08-10.md): under
    // the F3 driver anomaly (`changes` absent while the write proceeds
    // underneath), the gate's null can coexist with a ballot row this
    // very call just wrote -- and the pre-fix clause then told the
    // citizen they had "already cast a ballot", citing the call's own
    // write as its own precedent. The row's cast stamp tells the cases
    // apart: only a ballot cast at a DIFFERENT millisecond than this
    // call's own `now` is genuinely prior. (A true prior ballot sharing
    // the exact millisecond merely drops the clause -- conservative, the
    // closure sentence stands either way.)
    const prior = await hasExistingBallot(env, proposalId, citizen.id);
    const genuinelyPrior = prior != null && prior.cast_at !== now;
    throw new SocietyError(
      409,
      `proposal ${proposalId} is no longer open for balloting: it was claimed for tallying while this ballot was in flight. Not recorded -- the tally already ran without it.${
        genuinelyPrior ? " You had also already cast a ballot on this proposal; only your original ballot counts." : ""
      }`,
    );
  }

  return { proposal_id: proposalId, choice, chain_head: sealed.hash };
}

// Shared by castBallot's pre-check (the common, sequential case) and its
// post-refusal check (F5, hardening-2: the gate-refused case where the
// citizen ALSO already voted) -- one SQL string, not two independently
// typed copies that could drift. Returns the ballot's own cast_at, not a
// bare boolean (gate finding 4, docs/REVIEW-HARDENING2-GATE-2026-08-10.md):
// the post-refusal caller needs to distinguish a genuinely PRIOR ballot
// from the row this very call just wrote under a driver-report anomaly,
// and the cast stamp is what tells them apart.
async function hasExistingBallot(env: Env, proposalId: number, citizenId: number): Promise<{ cast_at: number } | null> {
  const existing = await env.DB.prepare("SELECT cast_at FROM ballots WHERE proposal_id = ? AND citizen_id = ?")
    .bind(proposalId, citizenId)
    .first<{ cast_at: number }>();
  return existing;
}

// GET /api/proposals: public list, paginated in the citizens-census style
// (society.ts's citizenDirectory) with a real COUNT and has_more.
export const PROPOSAL_PAGE = 200;

// docs/REVIEW-DEMOCRACY.md L2: created_at alone is not a safe cursor --
// two proposals sharing a millisecond across a page boundary would lose
// one permanently (created_at > since excludes BOTH once either has been
// seen). Reproduced at 201+ proposals with a genuine collision, so out of
// phase-0 reach today, but the loss is silent and permanent, which is
// worth closing regardless of how rarely it fires. sinceId is optional
// and only takes effect alongside since: a caller that has not adopted it
// yet runs the exact same query it always has (unchanged behaviour), and
// one that walks both cursor fields the response now returns gets the
// real fix -- (created_at, id) is a total order with no ties, since id is
// a real primary key.
export async function listProposals(env: Env, since = NaN, sinceId = NaN) {
  const total = (await env.DB.prepare("SELECT COUNT(*) AS n FROM proposals").first<{ n: number }>())?.n ?? 0;
  const cols = `p.id, p.kind, p.title, p.status, p.proposer_id, c.handle AS proposer, p.post_id,
                p.opened_at, p.closes_at, p.tally_yes, p.tally_no, p.tally_abstain, p.eligible_count, p.tallied_at, p.created_at`;
  const hasSince = Number.isFinite(since);
  const hasSinceId = hasSince && Number.isFinite(sinceId);
  const where = hasSinceId ? "WHERE p.created_at > ? OR (p.created_at = ? AND p.id > ?)" : hasSince ? "WHERE p.created_at > ?" : "";
  const bindArgs = hasSinceId ? [since, since, sinceId] : hasSince ? [since] : [];
  const stmt = env.DB
    .prepare(
      `SELECT ${cols} FROM proposals p JOIN citizens c ON c.id = p.proposer_id
       ${where} ORDER BY p.created_at ASC, p.id ASC LIMIT ?`,
    )
    .bind(...bindArgs, PROPOSAL_PAGE);
  const { results } = await stmt.all<{ kind: ProposalKind; created_at: number; id: number }>();
  const returned = results.length;
  const has_more = returned === PROPOSAL_PAGE;
  const proposals = results.map((p) => ({ ...p, class: classOf(p.kind) }));
  const last = results[returned - 1];
  return {
    total,
    returned,
    page_size: PROPOSAL_PAGE,
    has_more,
    ...(has_more ? { next_since: last.created_at, next_since_id: last.id } : {}),
    note: "total is a real SELECT COUNT(*), independent of how many rows this page carries (returned). If has_more, fetch GET /api/proposals?since=<next_since>&since_id=<next_since_id> and keep going.",
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

// ---------- sweep: claim-then-tally-then-execute (D1-touching) ----------
//
// Design doc §5 points 5-6, §6, §8. Deterministic, idempotent,
// permissionless: POST /api/governance/sweep and both maintainer cron
// wakes (wired in before their own model-call gate, so a dry API key
// never blocks governance) call the same runGovernanceSweep. Two
// concurrent callers cannot double-execute the same proposal -- the claim
// UPDATE below is the same claim-then-act shape judgment.ts's
// stampQueueRow uses (DEMOCRACY-SURFACE.md §6): only the caller whose
// UPDATE actually changed a row proceeds past this point for that
// proposal; the other sees changes:0 and moves on.

const MACHINE_EXECUTABLE_KINDS: readonly ProposalKind[] = ["set_name", "set_dividend_uplift", "set_split", "control_floor_raise", "first_laws_ratify"];

// docs/REVIEW-DEMOCRACY.md H1's belt: a re-claim (below) can, in the
// narrow window it exists for, race a still-live-but-slow original
// claimant reaching this same statement. WHERE EXISTS guards the write
// on the proposal still being 'tallying' at the moment this statement
// actually executes -- verified directly against node:sqlite (not just
// reasoned about) that once a proposal's status has moved off
// 'tallying', a second attempt at this exact statement affects zero
// rows and leaves the existing setting value completely untouched,
// upsert path included. Paired with the same guard the final status
// UPDATE already carried since commit 4 (`AND status = 'tallying'`),
// both statements in the execution batch are now conditional, not just
// one of the two. `AND tallied_at = ?` binds the claimant's own claim
// stamp (the `now` this function already receives -- the same value the
// claim UPDATE wrote), completing F1's sibling-window fix (gate finding
// 1, see commitOutcome): all three gated statements in the outcome batch
// must ask the identical question, or a resumed stale claimant whose log
// and status statements no-op could still land this settings write alone.
function upsertSettingStmt(env: Env, key: string, value: string, expiresAt: number | null, proposalId: number, now: number) {
  return env.DB.prepare(
    `INSERT INTO governance_settings (key, value, expires_at, proposal_id, updated_at)
     SELECT ?, ?, ?, ?, ?
     WHERE EXISTS (SELECT 1 FROM proposals WHERE id = ? AND status = 'tallying' AND tallied_at = ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at, proposal_id = excluded.proposal_id, updated_at = excluded.updated_at`,
  ).bind(key, value, expiresAt, proposalId, now, proposalId, now);
}

// The governance_settings write for a passed machine-executable kind's
// payload -- one statement, added to the same atomic batch as the
// proposal status update and the chained outcome event (§8). Mandate
// kinds (handler_arrangement, buyout_terms, official_token,
// text_amendment, resolution, first_laws_amendment) never reach here; they
// set status passed with no settings write at all -- "their force is the
// public record" (§8).
function settingsStatementForExecution(env: Env, kind: ProposalKind, payload: Record<string, unknown> | null, proposalId: number, now: number) {
  // first_laws_ratify carries NO payload at all (docs/FIRST-LAWS-DESIGN.md
  // §7: its value IS the proposal id, not a structured field) -- checked
  // BEFORE the payload guard below, which would otherwise treat it as
  // "nothing to write" and silently flip the proposal to 'executed' with
  // no settings row at all [drift item 5]. Every OTHER machine-executable
  // kind still needs its own real payload, so this must not become a
  // blanket bypass of the guard.
  if (kind === "first_laws_ratify") {
    return upsertSettingStmt(env, SETTING_KEY.firstLawsRatified, String(proposalId), null, proposalId, now);
  }
  if (!payload) return null;
  switch (kind) {
    case "set_name":
      return upsertSettingStmt(env, SETTING_KEY.name, String(payload.name), null, proposalId, now);
    case "control_floor_raise":
      return upsertSettingStmt(env, SETTING_KEY.controlFloorPercent, String(payload.percent), null, proposalId, now);
    case "set_dividend_uplift":
      return upsertSettingStmt(
        env,
        SETTING_KEY.dividendUplift,
        JSON.stringify({ total_percent: payload.total_percent }),
        monthsFromNow(now, Number(payload.months)),
        proposalId,
        now,
      );
    case "set_split":
      return upsertSettingStmt(env, SETTING_KEY.split, JSON.stringify({ prize: payload.prize, bounty: payload.bounty }), null, proposalId, now);
    default:
      return null;
  }
}

// Atomic: the outcome event and whatever state change goes with it commit
// together or not at all -- the commitWithModLog precedent (society.ts),
// generalised to N state statements instead of exactly one.
//
// The chained log statement carries the identical `status = 'tallying'`
// gate the state statements already do (docs/REVIEW-DEMOCRACY-RECHECK.md
// N6): a stalled claimant that resumes after a second claimant has already
// re-claimed and fully committed can still reach this function with a
// stateStmts batch built from stale data. Pre-fix, its own retry (forced by
// a genuine UNIQUE collision against the second claimant's already-written
// row) would land the log entry unconditionally even though the state
// writes correctly no-op -- a duplicate proposal_decided event on a chain
// whose entire value is being auditable. With the gate, every statement in
// the batch is conditional on the same fact, so a resumed claimant's whole
// batch no-ops cleanly: no throw, no partial write, nothing to distinguish
// from an ordinary successful commit from the caller's point of view.
// F1/F2 (docs/REVIEW-CHAINGATE-2026-08-09.md, hardening-2): the log
// statement carries the identical `status = 'tallying'` gate stateStmts
// already do, so the log statement's OWN batch result is a reliable
// witness for whether this batch actually wrote anything at all -- a
// resumed stale claimant, whose batch lands after a second claimant has
// already re-claimed and fully committed, no-ops the log statement exactly
// as it no-ops stateStmts (same gate, same proposalId, one D1 batch is one
// transaction so every statement in it sees the identical proposals row).
// Pre-fix this function returned `{ hash: log.hash }` unconditionally --
// naming a row that, in that exact case, was never written (F2's phantom
// hash) -- and its only caller trusted that return to mean "I committed",
// publishing its own stale, possibly-wrong finalStatus as if it had (F1).
// Returning "claimed_elsewhere" instead means a caller can never assert an
// outcome it did not actually commit, and there is no longer any `{hash}`
// value this function could hand back for a row that does not exist.
// Gate closes F1's sibling window (docs/REVIEW-HARDENING2-GATE-2026-08-10.md
// finding 1): `status = 'tallying'` alone cannot distinguish "still
// tallying under MY claim" from "still tallying under someone else's
// re-claim" -- a resumed stale claimant racing a re-claimer that had not
// yet committed would pass a status-only gate and seal its stale tally
// into the permanent chain. The claim UPDATE stamps tallied_at with the
// claimant's own `now` (the exact value threaded down to this function),
// so binding `AND tallied_at = ?` makes the gate provably ours: a
// re-claim restamps tallied_at (re-claims are >= STALE_CLAIM_MS apart, so
// the stamps can never coincide), and the resumed claimant's whole batch
// no-ops through the claimed_elsewhere path that already exists. The
// identical stamp is bound into ALL the batch's gated statements -- this
// gate, upsertSettingStmt's WHERE EXISTS, and the final status UPDATE --
// because the lockstep property everything below leans on ("every
// statement in the batch is conditional on the same fact") only holds if
// every gate asks the same question; stamping two of the three would let
// a stale settings write land alone.
async function commitOutcome(
  env: Env,
  proposalId: number,
  stateStmts: D1PreparedStatement[],
  actorId: number,
  detail: string,
  now: number,
): Promise<{ hash: string } | "claimed_elsewhere"> {
  const gate: ChainGate = { sql: "SELECT 1 FROM proposals WHERE id = ? AND status = 'tallying' AND tallied_at = ?", args: [proposalId, now] };
  for (let attempt = 0; attempt < 4; attempt++) {
    const log = await appendChainedStmt(
      env.DB,
      "identity_events",
      {
        citizen_id: actorId,
        kind: "proposal_decided",
        detail,
        // F6: the caller's own `now` -- the exact value stateStmts already
        // stamp onto tallied_at in this identical batch -- not a fresh
        // Date.now() read on every attempt (which could disagree with
        // tallied_at by however long the retry took, inside one supposedly
        // atomic outcome). Safe under retry: appendChainedStmt builds the
        // hash and the row from the same object, and a UNIQUE retry here
        // only ever collides on identity_events' own prev_hash/hash, never
        // on created_at, so holding created_at fixed across attempts
        // cannot cause a loop.
        created_at: now,
      },
      gate,
    );
    try {
      // log.stmt first: it reads proposals only inside its own gate,
      // never writes it, so it must run before stateStmts' own final
      // status UPDATE flips status off 'tallying' -- statements in one
      // batch execute in order, inside one transaction, so a later
      // statement sees an earlier one's effects. The settings upsert (when
      // present) is already ordered ahead of the status UPDATE for the
      // identical reason; the log entry now follows the same rule.
      const [logRes] = await env.DB.batch([log.stmt, ...stateStmts]);
      // Optional chaining is load-bearing (gate finding 3,
      // docs/REVIEW-HARDENING2-GATE-2026-08-10.md): a driver returning an
      // EMPTY results array -- the sibling of Finding A's absent-changes
      // shape, one level up -- previously threw a raw TypeError HERE,
      // after the batch had already committed, and that unsanitised
      // message rode the sweep's public catch out of the unauthenticated
      // POST /api/governance/sweep. Landing it on claimed_elsewhere puts
      // the whole absent-report family on the one conservative path.
      if (logRes?.meta?.changes !== 1) {
        // changes === 0 is the gate refusing: some other claimant already
        // moved this proposal off 'tallying' between our claim and this
        // batch, and stateStmts share the identical gate, so the whole
        // batch no-opped in lockstep with the log statement. Anything
        // OTHER than exactly 1 -- including an ABSENT changes, the
        // ambient type's promise no runtime is held to -- is an
        // unconfirmable batch this function must not vouch for
        // (chain.ts's F3 principle, applied here by the fixes pass,
        // Finding A: the old === 0 read "not present" as "present and
        // nonzero", handing back the F2 phantom hash through exactly the
        // hole F3 closed next door). Under-claiming is safe in both
        // directions: if the batch did write, the row is terminal and
        // only this return value is conservative; if it did not, status
        // stays 'tallying' and H1's stale-claim recovery re-claims it on
        // a later sweep.
        return "claimed_elsewhere";
      }
      return { hash: log.hash };
    } catch (e) {
      if (!String(e).includes("UNIQUE")) throw e;
      // head moved between our read and the batch; re-prepare and retry.
    }
  }
  throw new SocietyError(500, "proposal-outcome chain head moved four times running; refusing to commit an outcome without its record");
}

export type SweepOutcome = "claimed_elsewhere" | "passed" | "executed" | "failed" | "invariant_violation";

// docs/REVIEW-DEMOCRACY.md H1, reproduced: a throw anywhere between the
// claim UPDATE below and commitOutcome's own commit (five-plus more D1
// round trips, plus the chained append and its own retry loop) left a
// proposal parked at status='tallying' forever -- the due query only
// ever looked for status='open', so nothing anywhere ever read it
// again. 15 minutes is comfortably beyond any real Worker request's
// lifetime, so a claim still legitimately in flight at that age is not
// a real possibility to plan around; a claim that old is abandoned.
const STALE_CLAIM_MS = 15 * 60 * 1000;

async function claimTallyAndExecuteOne(env: Env, proposalId: number, now: number): Promise<SweepOutcome> {
  // Claims from 'open' (the normal case) exactly as before, OR
  // re-claims a 'tallying' row whose own claim stamp (tallied_at,
  // reused rather than adding a fifth column) is older than
  // STALE_CLAIM_MS -- the identical claim-then-act shape, so a second,
  // bespoke recovery path is not needed. tallied_at is stamped with
  // THIS claim's own `now` regardless of which branch matched, which is
  // what lets a second stale check ever succeed again if this claimant
  // also stalls: the clock restarts on whoever holds the claim, not on
  // when the proposal first went stale.
  // docs/REVIEW-DEMOCRACY-RECHECK.md N5: `tallied_at <= ?` alone is
  // NULL-unsafe -- SQL comparisons against NULL are neither true nor
  // false, they are unknown, so a row at 'tallying' with tallied_at IS
  // NULL would never match either branch and sit stranded forever, no
  // matter how much time passed. No deployed path can create that state
  // (both this claim and the final status UPDATE below always stamp
  // tallied_at), so it can only happen via a hand-written UPDATE -- the
  // exact out-of-band write governance-policing.test.ts exists to
  // forbid -- but H1's whole point was that no 'tallying' sub-state
  // should be unrecoverable, so it is worth the two extra words.
  const claim = await env.DB.prepare(
    `UPDATE proposals SET status = 'tallying', tallied_at = ?
     WHERE id = ? AND ((status = 'open' AND closes_at <= ?) OR (status = 'tallying' AND (tallied_at IS NULL OR tallied_at <= ?)))`,
  )
    .bind(now, proposalId, now, now - STALE_CLAIM_MS)
    .run();
  if (claim.meta.changes === 0) return "claimed_elsewhere";

  const proposal = await env.DB.prepare(
    "SELECT id, kind, payload, proposer_id, opened_at, registration_mode, founding_ratified FROM proposals WHERE id = ?",
  )
    .bind(proposalId)
    .first<{
      id: number;
      kind: ProposalKind;
      payload: string | null;
      proposer_id: number;
      opened_at: number;
      registration_mode: string;
      founding_ratified: number;
    }>();
  if (!proposal) throw new SocietyError(500, `claimed proposal ${proposalId} vanished before it could be tallied`);

  const voteClass = classOf(proposal.kind);
  const { results: ballotCounts } = await env.DB.prepare("SELECT choice, COUNT(*) AS n FROM ballots WHERE proposal_id = ? GROUP BY choice")
    .bind(proposalId)
    .all<{ choice: Choice; n: number }>();
  const countOf = (c: Choice) => ballotCounts.find((b) => b.choice === c)?.n ?? 0;
  const yes = countOf("yes");
  const no = countOf("no");
  const abstain = countOf("abstain");

  // registration_mode and founding_ratified are read off THIS row, the
  // exact snapshot castBallot judged every ballot above against -- never
  // env.REGISTRATION_MODE and never a live isFoundingRatified() re-query
  // (docs/REVIEW-DEMOCRACY.md H2/M6). This is what makes cast-time and
  // close-time eligibility identical by construction rather than merely
  // usually agreeing.
  const [{ results: citizens }, { results: founderRows }] = await Promise.all([
    env.DB.prepare("SELECT id, created_at FROM citizens").all<{ id: number; created_at: number }>(),
    env.DB.prepare("SELECT DISTINCT citizen_id FROM identity_events WHERE kind = 'invite_redeemed'").all<{ citizen_id: number }>(),
  ]);
  const founderIds = new Set(founderRows.map((r) => r.citizen_id));
  const eligible = countEligible(citizens, founderIds, {
    kind: proposal.kind,
    voteClass,
    registrationMode: proposal.registration_mode,
    foundingRatified: proposal.founding_ratified === 1,
    proposalOpenedAt: proposal.opened_at,
  });

  const result = tally(voteClass, yes, no, abstain, eligible);

  // Belt (docs/REVIEW-DEMOCRACY.md H2 fix, part 2): cast ballots can never
  // legitimately exceed the eligible census once cast-time and close-time
  // rules are frozen identical above -- if this ever fires, something
  // else is wrong in a way this arc did not anticipate. Do not commit and
  // do not clamp: clamping would silently launder a real eligibility bug
  // into a plausible-looking outcome, exactly what this check exists to
  // refuse. The row is left exactly as the claim above left it
  // (status='tallying'), which is what makes it eligible for stale-claim
  // recovery rather than requiring a second, bespoke recovery path.
  //
  // docs/REVIEW-DEMOCRACY-RECHECK.md N7: the shape that recovery takes for
  // THIS outcome specifically, worth the operator knowing in advance. A
  // proposal that hits this belt is not resolved by stale-claim recovery,
  // it is perpetually RE-CLAIMED by it: every sweep past STALE_CLAIM_MS
  // reclaims the row, re-runs this exact check, re-violates, and re-stamps
  // tallied_at -- forever, with no expiry and no escalation. That is the
  // designed trade this belt makes on purpose (a wrong outcome would be
  // worse than an unterminating retry), and it is loud, not silent: every
  // sweep response names the row in both `results` (as this proposal's own
  // outcome) and `stranded`, so the condition is visible on every single
  // call, not something that has to be specifically queried for. It is not
  // reachable through any real path this arc could construct post-freeze
  // (isFounder is immutable, created_at is never updated, nothing deletes
  // citizens) -- documented so a future reader who does see it fire knows
  // this is the designed refusal working as intended, not a new bug on top
  // of the one it caught.
  if (result.cast > eligible) {
    return "invariant_violation";
  }

  const isExecutable = result.status === "passed" && MACHINE_EXECUTABLE_KINDS.includes(proposal.kind);
  const finalStatus: "passed" | "failed" | "executed" = result.status === "failed" ? "failed" : isExecutable ? "executed" : "passed";

  const stateStmts: D1PreparedStatement[] = [];
  if (isExecutable) {
    const parsedPayload = proposal.payload ? (JSON.parse(proposal.payload) as Record<string, unknown>) : null;
    const settingStmt = settingsStatementForExecution(env, proposal.kind, parsedPayload, proposalId, now);
    if (settingStmt) stateStmts.push(settingStmt);
  }
  // `AND tallied_at = ?` (this claimant's own claim stamp): the third of
  // the outcome batch's three gated statements, kept in lockstep with
  // commitOutcome's chain gate and upsertSettingStmt's WHERE EXISTS --
  // F1's sibling-window fix (gate finding 1), see commitOutcome's comment.
  stateStmts.push(
    env.DB
      .prepare(
        "UPDATE proposals SET status = ?, tally_yes = ?, tally_no = ?, tally_abstain = ?, eligible_count = ?, tallied_at = ? WHERE id = ? AND status = 'tallying' AND tallied_at = ?",
      )
      .bind(finalStatus, yes, no, abstain, eligible, now, proposalId, now),
  );

  const detail = `proposal ${proposalId} (${proposal.kind}) ${finalStatus}: yes=${yes} no=${no} abstain=${abstain} eligible=${eligible}`;
  const outcome = await commitOutcome(env, proposalId, stateStmts, proposal.proposer_id, detail, now);
  // F1: a resumed stale claimant whose batch just no-opped (see
  // commitOutcome above) must report that honestly -- never its own
  // precomputed finalStatus, which was frozen against a citizens/eligible
  // snapshot that may since have diverged from whatever the actual
  // committer saw.
  if (outcome === "claimed_elsewhere") return "claimed_elsewhere";

  return finalStatus;
}

// POST /api/governance/sweep, and both maintainer cron wakes before their
// own model-call gate. Permissionless by design (§5 point 5): closing and
// tallying a proposal is deterministic code, not a privileged act -- and
// idempotent: a due proposal already claimed (by an earlier call, or by a
// concurrent one) is reported "claimed_elsewhere", never reprocessed.
//
// Due is now two populations, matching claimTallyAndExecuteOne's own
// claim UPDATE exactly (docs/REVIEW-DEMOCRACY.md H1): freshly closed
// ('open', past closes_at) or abandoned ('tallying' for longer than
// STALE_CLAIM_MS). `reclaimed: true` on a result marks the second kind,
// so a caller reading the response can tell "just closed" from "was
// stuck and just got recovered" without a second query.
// `constitutionCache` defaults to this file's own shared per-isolate
// instance (PROCESS_CONSTITUTION_CACHE, below) for every real caller --
// the optional override exists purely for test injectability, same
// reason as `now`: two tests sharing one file's process (and so this
// module's one default cache instance) but exercising DIFFERENT local-D1
// databases would otherwise see the second test's detection silently
// short-circuit to the first test's already-cached answer.
export async function runGovernanceSweep(env: Env, now = Date.now(), constitutionCache?: ConstitutionCache) {
  // N5 (see claimTallyAndExecuteOne's claim UPDATE above): the same
  // NULL-unsafety, in the query that decides whether a stale row is even
  // attempted in the first place. Kept identical to the claim UPDATE's
  // own WHERE shape so "found as due" and "actually claimable" never
  // disagree about which rows qualify.
  const { results: due } = await env.DB.prepare(
    `SELECT id, status FROM proposals WHERE (status = 'open' AND closes_at <= ?) OR (status = 'tallying' AND (tallied_at IS NULL OR tallied_at <= ?))`,
  )
    .bind(now, now - STALE_CLAIM_MS)
    .all<{ id: number; status: string }>();

  const results: Array<{ proposal_id: number; outcome: SweepOutcome | "error"; reclaimed?: true; error?: string }> = [];
  for (const { id, status } of due) {
    const reclaimed = status === "tallying" ? ({ reclaimed: true } as const) : {};
    try {
      const outcome = await claimTallyAndExecuteOne(env, id, now);
      results.push({ proposal_id: id, outcome, ...reclaimed });
    } catch (e) {
      // Per-proposal isolation: one bad proposal must not block the rest
      // of the sweep from processing everything else that is due.
      results.push({ proposal_id: id, outcome: "error", ...reclaimed, error: e instanceof SocietyError ? e.message : String(e) });
    }
  }

  // Named separately from `results` (docs/REVIEW-DEMOCRACY.md H1: "report
  // strands... instead of them being visible only row by row"): every
  // proposal still at 'tallying' once this call is done, whether it was
  // too fresh to reclaim yet, or reclaimed here and still did not reach
  // a final state, or was never touched by this call at all. A citizen
  // or the operator reading POST /api/governance/sweep's response sees
  // a stuck proposal directly, not only by querying the row.
  const { results: strandedRows } = await env.DB.prepare("SELECT id FROM proposals WHERE status = 'tallying'").all<{ id: number }>();

  // I-007 (docs/FIRST-LAWS-DESIGN.md §5): the sweep is one of the four
  // call sites the shared detection function is reachable from
  // (commission notes flag 5) -- permissionless and idempotent, exactly
  // like the tallying above, so running it here too costs nothing extra
  // and only helps. A detection failure is never this endpoint's own
  // "error" result (tallying due proposals must not be blocked by it);
  // it degrades to the honest detection_stranded flag instead, per the
  // brief's own honest-failure-surface requirement.
  let detectionStranded = false;
  try {
    const detection = await detectConstitutionChange(env, now, constitutionCache);
    detectionStranded = detection.status === "exhausted" || detection.status === "invariant_violation";
  } catch (e) {
    console.log(JSON.stringify({ level: "error", event: "constitution_detection_threw_in_sweep", message: String(e) }));
    detectionStranded = true;
  }

  return {
    swept_at: now,
    due: due.length,
    processed: results.length,
    results,
    stranded: strandedRows.map((r) => r.id),
    detection_stranded: detectionStranded,
  };
}

// ---------- I-007: the attested constitution (docs/FIRST-LAWS-DESIGN.md §5) ----------
//
// Split template from values, per the design: interpolated values (name,
// dividend, split, control floor) already carry provenance through
// governance_settings' own proposal_id column and the chained outcome
// event every executed proposal produces (§8). What has no witness today
// is the TEMPLATE -- the prose itself, and the parameters that decide how
// a vote passes -- so this section attests those two things specifically,
// never the live interpolated values (which stay exactly as attested as
// they already were, through the mechanism that already exists for them).

// A stable placeholder, never a real deployment's own origin -- the
// worker's own URL is a human deploy detail (doc.ts's own honesty
// paragraph already says as much: "a separate, human deploy step,
// distinct from the society name this door serves"), not constitutional
// wording, so it must never move the template hash.
const CANONICAL_CONSTITUTION_ORIGIN = "https://commonhold.invalid";

// The constitution template (design doc §5, commission notes flag 6):
// built by calling frontDoor() itself -- never a parallel copy of its
// text -- twice, holding every governance_settings-backed value at its
// deployed DEFAULT (society.ts's DEFAULT_NAME/DEFAULT_CONTROL_FLOOR_PERCENT/
// DEFAULT_DIVIDEND_PERCENT/DEFAULT_SPLIT: each already independently
// attested through its own chained proposal_decided event the moment a
// vote executes it, so re-attesting the CURRENT live value here would be
// redundant with that existing mechanism, not a gap this section needs to
// close) and varying only the two boolean branches doc.ts's own template
// carries: nameRatified and firstLawsRatified. Two calls, not four,
// because the two conditionals are independent and the surrounding
// static text is identical either way -- (true, true) captures the
// ratified name sentence and the absent banner; (false, false) captures
// the unratified sentence and the full banner -- so both possible texts
// of BOTH conditionals are represented across the two calls without a
// redundant cartesian product. frontDoor() itself is never modified to
// serve this: calling it as a black box, with fixed inputs, adds zero
// regression risk to its own already-tested rendering.
export function buildConstitutionTemplate(): string {
  const base = {
    name: DEFAULT_NAME,
    controlFloorPercent: DEFAULT_CONTROL_FLOOR_PERCENT,
    dividendPercent: DEFAULT_DIVIDEND_PERCENT,
    split: DEFAULT_SPLIT,
  };
  const bothRatified = frontDoor(CANONICAL_CONSTITUTION_ORIGIN, { ...base, nameRatified: true, firstLawsRatified: true });
  const neitherRatified = frontDoor(CANONICAL_CONSTITUTION_ORIGIN, { ...base, nameRatified: false, firstLawsRatified: false });
  return `${bothRatified}\n\n----BOTH-BRANCHES----\n\n${neitherRatified}`;
}

// Normalise line endings, no other transformation (design doc §5,
// verbatim) -- a Windows checkout of this repo can carry CRLF in the raw
// template literal's own runtime string value; without this, the hash
// would depend on which OS/git config checked the file out, never a
// property of the wording itself.
export function canonicalizeTemplate(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

// Canonical JSON of the live vote-class table (design doc §5's
// "parameters_hash"), built FROM the same constants tally()/assertEligible
// actually execute -- CLASS_MIN_BALLOTS, TENURE_DAYS, VOTE_WINDOW_MS/
// ENTRENCHED_VOTE_WINDOW_MS via voteWindowMs(), and the quorum/passage
// RULES described alongside their current figures (so a rule-shape change
// -- e.g. swapping ceil for floor -- moves the hash even in the rare case
// its numeric output would coincide for some eligible count) -- plus the
// full KIND_CLASS map, so no parallel copy of "what class is this kind"
// can ever drift from what classOf() actually returns. [G1-1]: this is
// what makes a hostile deploy that edits the entrenched THRESHOLDS
// alongside their own invariant test still visible -- the test guards
// honest mistakes (§3), this hash is what a citizen can independently
// recompute and compare.
export function serializeConstitutionParameters(): string {
  const classes = (["entrenched", "constitutional", "parameter", "advisory"] as const).map((voteClass) => ({
    class: voteClass,
    min_ballots: CLASS_MIN_BALLOTS[voteClass],
    quorum_rule: voteClass === "advisory" ? "none" : voteClass === "entrenched" ? "ceil(2*eligible/3)" : "ceil(eligible/2)",
    passage_rule: voteClass === "entrenched" ? "yes>=3*no && yes>0" : voteClass === "constitutional" ? "yes>=2*no && yes>0" : "yes>no",
    window_ms: voteWindowMs(voteClass),
    tenure_days: TENURE_DAYS[voteClass],
  }));
  const kindClass = Object.fromEntries(PROPOSAL_KINDS.map((k) => [k, KIND_CLASS[k]]));
  return JSON.stringify({ classes, kind_class: kindClass });
}

export async function computeLiveConstitutionPair(): Promise<{ templateHash: string; parametersHash: string }> {
  const templateHash = await sha256Hex(canonicalizeTemplate(buildConstitutionTemplate()));
  const parametersHash = await sha256Hex(serializeConstitutionParameters());
  return { templateHash, parametersHash };
}

export interface ConstitutionVersionRow {
  id: number;
  first_seen_at: number;
  changed_by: "genesis" | "mandate_linked" | "operator";
}

// Per-isolate cache (design doc §5: "computed at serve time, cached per
// isolate"). The live (template, parameters) pair is 100% deploy-fixed --
// both hashes are pure functions of source-code constants, so neither can
// change within one running isolate's lifetime -- but the VERSION ROW
// that corresponds to that pair can still be "not yet detected" the first
// time any isolate anywhere asks, with detection (a write) landing
// moments later from this isolate's own call or another's. The cache
// stores the RESOLVED row only once found; a "not found" answer is never
// cached, so a stale null can never be served once the real row exists --
// the bug the tests cover directly (a first call before any detection has
// ever run anywhere, a version landing, then a second call that must see
// it, not a cached miss).
//
// A plain object, not a class, passed as an optional trailing parameter
// defaulting to one shared module-level instance -- the same testability
// idiom `now = Date.now()` already uses throughout this file: production
// call sites get the real shared cache for free, and tests construct a
// fresh `{ pairKey: null, versionRow: null }` so caching effects from one
// test never leak into another (module-level mutable state would
// otherwise persist for every test in the same file's process).
export interface ConstitutionCache {
  pairKey: string | null;
  versionRow: ConstitutionVersionRow | null;
}
const PROCESS_CONSTITUTION_CACHE: ConstitutionCache = { pairKey: null, versionRow: null };

async function lookupConstitutionVersion(
  env: Env,
  templateHash: string,
  parametersHash: string,
  cache: ConstitutionCache,
): Promise<ConstitutionVersionRow | null> {
  const pairKey = `${templateHash}:${parametersHash}`;
  // Compute the live pair FIRST (the caller already has, by this point),
  // and serve the cached row only when it matches -- the guard that keeps
  // this file safe against a future edit (or a mistaken second cache
  // instance) rather than trusting today's "the pair never changes
  // mid-isolate" fact to hold forever unchecked.
  if (cache.versionRow && cache.pairKey === pairKey) return cache.versionRow;
  const row = await env.DB.prepare(
    "SELECT id, first_seen_at, changed_by FROM constitution_versions WHERE template_hash = ? AND parameters_hash = ?",
  )
    .bind(templateHash, parametersHash)
    .first<ConstitutionVersionRow>();
  if (row) {
    cache.pairKey = pairKey;
    cache.versionRow = row;
  }
  return row ?? null;
}

// GET /api/attest's constitution block ([G1-1]): read-only, never writes.
// Detection (the write path) is a separate function every caller invokes
// for itself -- attest simply reports whatever the live pair currently
// resolves to, honestly null before anything has ever detected it (a
// narrow window: only reachable before the very first GET / or cron wake
// this deployment ever sees).
export async function getConstitutionAttestation(env: Env, cache: ConstitutionCache = PROCESS_CONSTITUTION_CACHE) {
  const { templateHash, parametersHash } = await computeLiveConstitutionPair();
  const row = await lookupConstitutionVersion(env, templateHash, parametersHash, cache);
  return {
    template_hash: templateHash,
    parameters_hash: parametersHash,
    version: row?.id ?? null,
    first_seen_at: row?.first_seen_at ?? null,
    changed_by: row?.changed_by ?? null,
  };
}

export type ConstitutionDetectionOutcome =
  | { status: "already_current"; versionId: number }
  | { status: "landed"; versionId: number; changedBy: "genesis" | "mandate_linked" | "operator"; mandateIds: number[] }
  | { status: "lost_claim" }
  | { status: "invariant_violation" }
  | { status: "exhausted" };

const CONSTITUTION_DETECTION_RETRIES = 4;

// The CONCURRENT-WINNER CONTRACT [amended 2026-08-11, drift item 7;
// rewritten same day after the Gemini attack round]. Reachable from every
// public serve (GET /) and both cron wakes, plus runGovernanceSweep
// above; idempotent, so a caller invoking it more than once (this file's
// own sweep alongside a wake that also calls it directly, in the same
// scheduled() invocation) is harmless -- the second call always resolves
// "already_current" the moment the first has landed.
//
// ONE env.DB.batch (a single D1 transaction), ordered so no statement
// sabotages a later statement's gate: (1) every mandate flip, gated NOT
// EXISTS a constitution_versions row for this exact (template_hash,
// parameters_hash) pair; (2) the chained constitution_changed
// identity_events INSERT, guarded by the SAME NOT-EXISTS gate (via
// appendChainedStmt's own `gate` parameter -- ChainGate always wraps its
// sql in `WHERE EXISTS (...)`, so `NOT EXISTS` is expressed by nesting:
// `EXISTS (SELECT 1 WHERE NOT EXISTS (...))` is true iff the inner
// NOT-EXISTS is true) -- so a lost-claim scenario cleanly no-ops here
// too, WITHOUT throwing, and the chain's own native UNIQUE prev_hash
// index remains what catches a genuinely concurrent, UNRELATED
// identity_events append (ordinary chain traffic, not another detection
// caller) racing the same head; (3) the version INSERT LAST, gated
// identically, with its own UNIQUE(template_hash, parameters_hash) as a
// backstop reachable only if the shared NOT-EXISTS gate were ever wrong.
// Genesis (the archive is currently empty) is a separate, simpler path:
// one gated INSERT, no batch, no chained event -- design doc §5: "genesis
// row changed_by 'genesis', no event".
export async function detectConstitutionChange(
  env: Env,
  now: number,
  cache: ConstitutionCache = PROCESS_CONSTITUTION_CACHE,
): Promise<ConstitutionDetectionOutcome> {
  const { templateHash, parametersHash } = await computeLiveConstitutionPair();
  const existing = await lookupConstitutionVersion(env, templateHash, parametersHash, cache);
  if (existing) return { status: "already_current", versionId: existing.id };

  const countRow = await env.DB.prepare("SELECT COUNT(*) AS n FROM constitution_versions").first<{ n: number }>();
  const isGenesis = (countRow?.n ?? 0) === 0;
  const fullText = buildConstitutionTemplate();
  const parametersText = serializeConstitutionParameters();

  if (isGenesis) {
    const res = await env.DB.prepare(
      `INSERT INTO constitution_versions (template_hash, parameters_hash, full_text, parameters_text, first_seen_at, changed_by, mandate_proposal_ids)
       SELECT ?, ?, ?, ?, ?, 'genesis', '[]'
       WHERE NOT EXISTS (SELECT 1 FROM constitution_versions WHERE template_hash = ? AND parameters_hash = ?)`,
    )
      .bind(templateHash, parametersHash, fullText, parametersText, now, templateHash, parametersHash)
      .run();
    if (res.meta.changes !== 1) {
      // Someone else's genesis INSERT landed first -- quiet, not an
      // error: the archive holds its one genesis row either way.
      return { status: "lost_claim" };
    }
    const row = await env.DB.prepare("SELECT id FROM constitution_versions WHERE template_hash = ? AND parameters_hash = ?")
      .bind(templateHash, parametersHash)
      .first<{ id: number }>();
    cache.pairKey = `${templateHash}:${parametersHash}`;
    cache.versionRow = { id: row!.id, first_seen_at: now, changed_by: "genesis" };
    return { status: "landed", versionId: row!.id, changedBy: "genesis", mandateIds: [] };
  }

  // design doc §5: the chained event's detail names "old_hash -> new_hash"
  // -- the most recently detected version before this one (there is
  // always at least the genesis row once isGenesis is false), read once,
  // best-effort annotation only: if a retry lands after some OTHER change
  // was ALSO detected mid-loop, the detail may lag by one hop, which is
  // harmless (the archive itself, not this prose, is the source of
  // truth -- every version's own full_text/parameters_text is always
  // exactly what its own row says, never described secondhand).
  const previousVersion = await env.DB.prepare("SELECT template_hash, parameters_hash FROM constitution_versions ORDER BY first_seen_at DESC, id DESC LIMIT 1").first<{
    template_hash: string;
    parameters_hash: string;
  }>();
  const oldHashSummary = previousVersion ? `${previousVersion.template_hash.slice(0, 12)}.../${previousVersion.parameters_hash.slice(0, 12)}...` : "(none)";

  for (let attempt = 0; attempt < CONSTITUTION_DETECTION_RETRIES; attempt++) {
    const { results: mandateRows } = await env.DB.prepare(
      "SELECT id FROM proposals WHERE status = 'passed' AND kind IN ('first_laws_amendment', 'text_amendment')",
    ).all<{ id: number }>();
    const mandateIds = mandateRows.map((r) => r.id);
    const changedBy: "mandate_linked" | "operator" = mandateIds.length > 0 ? "mandate_linked" : "operator";

    // Builder's own finding, recorded honestly rather than overclaiming
    // this gate's necessity: under D1/SQLite's single-writer transaction
    // model, a losing claimant's transaction cannot even BEGIN until the
    // winner's has fully committed or rolled back, so by the time this
    // statement executes, `AND status = 'passed'` ALONE already excludes
    // a mandate the winner already flipped -- verified directly by
    // removing the NOT-EXISTS clause below and re-running the
    // concurrent-race test, which stayed green. The clause stays anyway,
    // exactly as certified (docs/BRIEF-FIRST-LAWS.md commit 4): explicit
    // belt-and-braces, the same layered-redundancy idiom
    // migrations/0004's maintainer_queue kind CHECK already uses ("the
    // backstop against a bug in the parser"), and cheap insurance against
    // a future change to D1's own isolation guarantees this file cannot
    // predict. The chained event's OWN gate (below) is NOT redundant in
    // the same way -- removing IT was confirmed to reproduce a genuine
    // duplicate event, the positive half of this same red-proof pass.
    const flipStmts = mandateIds.map((id) =>
      env.DB.prepare(
        `UPDATE proposals SET status = 'executed' WHERE id = ? AND status = 'passed'
         AND NOT EXISTS (SELECT 1 FROM constitution_versions WHERE template_hash = ? AND parameters_hash = ?)`,
      ).bind(id, templateHash, parametersHash),
    );

    const newHashSummary = `${templateHash.slice(0, 12)}.../${parametersHash.slice(0, 12)}...`;
    const detail = `constitution changed ${oldHashSummary} -> ${newHashSummary} changed_by=${changedBy} mandates=[${mandateIds.join(",")}]`;
    const eventBuild = await appendChainedStmt(
      env.DB,
      "identity_events",
      { citizen_id: MAINTAINER_ID, kind: "constitution_changed", detail, created_at: now },
      {
        sql: "SELECT 1 WHERE NOT EXISTS (SELECT 1 FROM constitution_versions WHERE template_hash = ? AND parameters_hash = ?)",
        args: [templateHash, parametersHash],
      },
    );

    const versionStmt = env.DB
      .prepare(
        `INSERT INTO constitution_versions (template_hash, parameters_hash, full_text, parameters_text, first_seen_at, changed_by, mandate_proposal_ids)
         SELECT ?, ?, ?, ?, ?, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM constitution_versions WHERE template_hash = ? AND parameters_hash = ?)`,
      )
      .bind(templateHash, parametersHash, fullText, parametersText, now, changedBy, JSON.stringify(mandateIds), templateHash, parametersHash);

    try {
      const results = await env.DB.batch<{ meta: { changes: number } }>([...flipStmts, eventBuild.stmt, versionStmt]);
      const changesList = results.map((r) => r.meta?.changes);
      if (changesList.length === 0) {
        // Gate finding 3's own anomaly shape (docs/REVIEW-HARDENING2-GATE-2026-08-10.md),
        // reproduced defensively though never observed against this
        // specific batch: the write may have committed for real
        // underneath, but the driver's own report is empty. Under-claim,
        // never assert.
        return { status: "lost_claim" };
      }
      const allOnes = changesList.every((c) => c === 1);
      // Anything not exactly 1 -- including an absent/undefined report,
      // the F3 principle applied here -- counts toward "did not commit".
      const allNotOne = changesList.every((c) => c !== 1);

      if (allOnes) {
        const row = await env.DB.prepare("SELECT id FROM constitution_versions WHERE template_hash = ? AND parameters_hash = ?")
          .bind(templateHash, parametersHash)
          .first<{ id: number }>();
        cache.pairKey = `${templateHash}:${parametersHash}`;
        cache.versionRow = { id: row!.id, first_seen_at: now, changed_by: changedBy };
        return { status: "landed", versionId: row!.id, changedBy, mandateIds };
      }
      if (allNotOne) {
        // Lost claim: the row landed earlier (another caller, between our
        // own read above and this batch's own execution) -- quiet, not
        // an error.
        return { status: "lost_claim" };
      }
      // A genuine mix: some statements committed, others did not, despite
      // every one of them sharing the identical gate inside one
      // transaction -- 'passed' has no other exit-writer than this
      // linkage (docs/BRIEF-FIRST-LAWS.md commit 4), so this should be
      // structurally impossible. Log loud, do not retry: retrying cannot
      // fix a logic error.
      console.log(
        JSON.stringify({
          level: "error",
          event: "constitution_detection_invariant_violation",
          changes: changesList,
          template_hash: templateHash,
          parameters_hash: parametersHash,
        }),
      );
      return { status: "invariant_violation" };
    } catch (e) {
      const message = String(e);
      if (!message.includes("UNIQUE")) throw e;
      if (classifyUniqueViolation("identity_events", message) === "chain_head") {
        // An ordinary, unrelated identity_events append (ANY other
        // chained write -- a ballot, a key rotation, a payout) moved the
        // head between our read and our write, the same race every other
        // appendChainedStmt caller already retries against. Rebuild next
        // iteration -- eventBuild's own head-read happens fresh inside
        // appendChainedStmt, called again at the top of the loop.
        continue;
      }
      // Anything else UNIQUE-shaped in this batch can only be
      // constitution_versions' own UNIQUE(template_hash, parameters_hash)
      // backstop -- the only other constraint this batch's statements
      // could ever violate -- reached by ELIMINATION, not a second
      // bespoke parser: classifyUniqueViolation only recognises
      // identity_events' own two chain indexes and ballots' duplicate-
      // vote pair, neither of which this batch's statements could ever
      // name.
      return { status: "lost_claim" };
    }
  }
  return { status: "exhausted" };
}

export interface FidelityReconciliationResult {
  queued: number;
  error: string | null;
}

// Wake-side reconciliation [second-pass amendment, drift item 7's own
// follow-on]: fidelity queueing lives OUTSIDE the detection batch, since
// maintainer_queue.run_id is NOT NULL REFERENCES maintainer_runs and run
// kinds are closed to clerk/judgment -- a public serve (GET /) has no
// legal run_id to give a queued item, and this file must not fabricate
// one or loosen the column. Both cron wakes call this, after their own
// call to detectConstitutionChange, bound to THEIR OWN run_id (honest
// provenance). One non-genesis constitution_versions row queues at most
// one constitution_fidelity item, ever, gated NOT EXISTS a fidelity row
// already carrying that version's own source_ref -- idempotent, so a
// serve-detected change is queued at the next wake (<= a day) and judged
// at the next judgment wake, the cadence the queue always had.
export async function reconcileConstitutionFidelityQueue(env: Env, runId: number, now: number): Promise<FidelityReconciliationResult> {
  const { results: versions } = await env.DB.prepare(
    "SELECT id, template_hash, parameters_hash, changed_by, mandate_proposal_ids FROM constitution_versions WHERE changed_by != 'genesis'",
  ).all<{ id: number; template_hash: string; parameters_hash: string; changed_by: string; mandate_proposal_ids: string }>();

  let queued = 0;
  const errors: string[] = [];
  for (const v of versions) {
    const sourceRef = `constitution_versions:${v.id}`;
    const note = `Constitution changed to version ${v.id} (template ${v.template_hash.slice(0, 12)}..., parameters ${v.parameters_hash.slice(0, 12)}...), changed_by=${v.changed_by}, linked mandate proposal ids=${v.mandate_proposal_ids}. Judge the fidelity of this change: does it match its linked mandate(s), exceed them, or carry no mandate at all?`;
    try {
      const res = await env.DB.prepare(
        `INSERT INTO maintainer_queue (run_id, created_at, kind, target_type, target_id, source_ref, note, status)
         SELECT ?, ?, 'constitution_fidelity', NULL, NULL, ?, ?, 'pending'
         WHERE NOT EXISTS (SELECT 1 FROM maintainer_queue WHERE kind = 'constitution_fidelity' AND source_ref = ?)`,
      )
        .bind(runId, now, sourceRef, note, sourceRef)
        .run();
      if (res.meta.changes === 1) queued++;
    } catch (e) {
      errors.push(`version ${v.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { queued, error: errors.length > 0 ? errors.join("; ") : null };
}

// GET /api/constitution/versions: the full archive, paginated in the
// existing proposals/citizens (created_at, id) cursor style -- a
// first_seen_at-only cursor would silently drop one row of a genuinely
// simultaneous cross-isolate detection sharing a millisecond, the exact
// class of bug docs/REVIEW-DEMOCRACY.md L2 closed for listProposals.
export const CONSTITUTION_VERSIONS_PAGE = 200;

export async function listConstitutionVersions(env: Env, since = NaN, sinceId = NaN) {
  const total = (await env.DB.prepare("SELECT COUNT(*) AS n FROM constitution_versions").first<{ n: number }>())?.n ?? 0;
  const hasSince = Number.isFinite(since);
  const hasSinceId = hasSince && Number.isFinite(sinceId);
  const where = hasSinceId ? "WHERE first_seen_at > ? OR (first_seen_at = ? AND id > ?)" : hasSince ? "WHERE first_seen_at > ?" : "";
  const bindArgs = hasSinceId ? [since, since, sinceId] : hasSince ? [since] : [];
  const stmt = env.DB
    .prepare(
      `SELECT id, template_hash, parameters_hash, full_text, parameters_text, first_seen_at, changed_by, mandate_proposal_ids
       FROM constitution_versions ${where} ORDER BY first_seen_at ASC, id ASC LIMIT ?`,
    )
    .bind(...bindArgs, CONSTITUTION_VERSIONS_PAGE);
  const { results } = await stmt.all<{ id: number; first_seen_at: number; mandate_proposal_ids: string }>();
  const returned = results.length;
  const has_more = returned === CONSTITUTION_VERSIONS_PAGE;
  const versions = results.map((r) => ({ ...r, mandate_proposal_ids: JSON.parse(r.mandate_proposal_ids) as number[] }));
  const last = results[returned - 1];
  return {
    total,
    returned,
    page_size: CONSTITUTION_VERSIONS_PAGE,
    has_more,
    ...(has_more ? { next_since: last.first_seen_at, next_since_id: last.id } : {}),
    note: "Every version this deployment has ever served, full text alongside each hash -- diffable by anyone, no trust required. If has_more, fetch again with since=<next_since>&since_id=<next_since_id>.",
    versions,
  };
}
