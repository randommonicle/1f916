// The pure governance core: vote classes, payload validation, eligibility,
// and tally arithmetic (docs/DEMOCRACY-DESIGN.md). No D1 here by design,
// mirroring wallets.ts's own split (normalizeAddress/walletLogEntry vs.
// declareWallet/walletFor): everything below is a value in, a verdict or a
// thrown SocietyError out, so the arithmetic that decides a constitutional
// vote is testable without a database and without a live clock. The
// D1-touching orchestration (creating a proposal row, recording a ballot,
// running the sweep) is later work, per design doc §13 items 3-4.
//
// The maintainer votes like anyone else (design doc §4): nothing below
// reads or branches on citizen #1's special identifier, and
// test/governance.test.ts polices that directly, not just by inspection.

import { SocietyError } from "./society.ts";

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
// column; this is for a caller (commit 3) to build a human-readable
// message, not something persisted verbatim.
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
