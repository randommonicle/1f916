// The state of the citizens' vote on naming the standing-topics power in Rule 7 (proposal 8), read live, and the ONE sentence that
// says it (drafts/BEN-ASKS-2026-10-09.md item 3; DECISIONS D-070). Three served surfaces used to promise that a vote on the amendment
// was still to come: GET /api/official (society.ts officialFacts().topics.note), GET /api/topics (topics.ts topicsRulesNote) and the door
// note on GET / (topics.ts topicsDoorNote). That went stale the moment the vote closed, whatever the result. Now each reads this.
//
// Why a module of its own, and why society.ts imports it at the call. officialFacts() lives in society.ts and must call this. Two static
// routes are closed: topics.ts reads society.ts exports at its own top level (`TOPIC_CAP = TOPICS.cap`), and governance.ts (which this
// module needs for the tally arithmetic, so the "with quorum" test is the sweep's own) reads society.ts's SETTING_KEY at ITS top level.
// So a static import of either from society.ts is a temporal-dead-zone error whenever society.ts is the first module entered (probed:
// "Cannot access 'SETTING_KEY' before initialization"). society.ts therefore reaches this module with `await import(...)` inside
// officialFacts, where every module is already loaded; topics.ts and index.ts import it statically (they sit above society.ts and
// governance.ts, never below). This module itself reads nothing from society.ts and takes the database as an argument.
// test/rule7-status-d1.test.ts enters society.ts, topics.ts, governance.ts and this file first, each in a fresh process, to prove the order
// does not matter.

import { classOf, tally, type ProposalKind } from "./governance.ts";

// The proposal the sentences read. A revote (a failed-without-quorum result is put to a vote again) would be a different proposal id:
// change this constant and nothing else, and the sentences follow the new one.
export const RULE7_PROPOSAL_ID = 8;

export type Rule7State = "open" | "counting" | "passed" | "failed_with_quorum" | "failed_without_quorum" | "absent" | "unreadable";

export interface Rule7Vote {
  state: Rule7State;
  // The proposal's own closes_at (epoch ms) in the states that name it (open, counting); null otherwise.
  closes_at: number | null;
}

interface ProposalRow {
  kind: string;
  status: string;
  closes_at: number;
  tally_yes: number | null;
  tally_no: number | null;
  tally_abstain: number | null;
  eligible_count: number | null;
}

// Reads proposal RULE7_PROPOSAL_ID and classifies it. Never throws: a read that fails (or a row that does not make sense) is
// `unreadable`, which the sentence says plainly and the open route treats as a refusal (fail closed on an operator-only route).
//   open       status 'open' and closes_at still ahead.
//   counting   status 'tallying', or status 'open' with closes_at already past: the window between the close and the sweep that claims it
//              (governance.ts claimTallyAndExecuteOne claims `status = 'open' AND closes_at <= now`), true before the claim and while it is held.
//   passed     'passed' or 'executed'.
//   failed_*   'failed', split by the tally's own recorded reason, recomputed here because the reason is not stored (governance.ts
//              TallyResult.reason, "proposals.status has no reason column"): the stored yes/no/abstain and eligible_count (snapshotted at
//              close "so a historical quorum check is always recomputable", schema.sql) go back through the SAME tally() the sweep ran.
//              Its reason 'margin' is quorum reached and not passed (the power retires); 'quorum' and 'floor' are both too few ballots to
//              decide anything (the class floor is a minimum presence, abstain counts), so nobody decided.
//   absent     no row with that id (a fresh fork, an older fixture).
export async function rule7VoteState(db: D1Database, now = Date.now()): Promise<Rule7Vote> {
  try {
    const row = await db
      .prepare("SELECT kind, status, closes_at, tally_yes, tally_no, tally_abstain, eligible_count FROM proposals WHERE id = ?")
      .bind(RULE7_PROPOSAL_ID)
      .first<ProposalRow>();
    if (!row) return { state: "absent", closes_at: null };
    if (row.status === "tallying" || (row.status === "open" && row.closes_at <= now)) return { state: "counting", closes_at: row.closes_at };
    if (row.status === "open") return { state: "open", closes_at: row.closes_at };
    if (row.status === "passed" || row.status === "executed") return { state: "passed", closes_at: null };
    if (row.status === "failed") {
      const { tally_yes: yes, tally_no: no, tally_abstain: abstain, eligible_count: eligible } = row;
      if (yes == null || no == null || abstain == null || eligible == null) return { state: "unreadable", closes_at: null };
      const result = tally(classOf(row.kind as ProposalKind), yes, no, abstain, eligible);
      if (result.status === "failed" && result.reason === "margin") return { state: "failed_with_quorum", closes_at: null };
      if (result.status === "failed") return { state: "failed_without_quorum", closes_at: null };
      // The row says failed and the stored numbers say passed: they disagree, so claim neither.
      return { state: "unreadable", closes_at: null };
    }
    return { state: "unreadable", closes_at: null };
  } catch {
    return { state: "unreadable", closes_at: null };
  }
}

// Why the topics route must not open a topic right now, or null if it may. Pure, from the same state the sentences read.
//   open       the proposal text's promise: "While this vote is open, the operator opens and closes no topic."
//   counting   the vote has closed and nobody has tallied it: opening now could pre-empt a result that retires the power.
//   failed_with_quorum   citizens retired the power: no new topic opens, and none is closed to make room for one.
//   unreadable a route only the operator can call fails closed when the vote it must respect cannot be read.
// passed, failed_without_quorum and absent open as before (absent keeps a fresh fork and every older fixture behaving as it did before the vote).
export function rule7OpenRefusal(v: Rule7Vote): string | null {
  const when = new Date(v.closes_at ?? 0).toISOString();
  switch (v.state) {
    case "open":
      return `Refused: the citizens' vote on naming this power in Rule 7 (proposal ${RULE7_PROPOSAL_ID}) is open until ${when}, and while it runs the operator opens and closes no topic. Nothing was written.`;
    case "counting":
      return `Refused: proposal ${RULE7_PROPOSAL_ID}, the citizens' vote on naming this power in Rule 7, closed at ${when} and has not yet been tallied; nothing opens until it is (POST /api/governance/sweep tallies it, and the 06:00 UTC wake does). Nothing was written.`;
    case "failed_with_quorum":
      return `Refused: citizens retired this power in proposal ${RULE7_PROPOSAL_ID} (quorum reached, not passed), so no new topic opens and none is closed to make room for one. Nothing was written.`;
    case "unreadable":
      return `Refused: proposal ${RULE7_PROPOSAL_ID}, the citizens' vote on naming this power in Rule 7, could not be read, and this route fails closed until it can be. Nothing was written.`;
    default:
      return null;
  }
}

// The clause every site appends, built here and nowhere else. It reads after "and" (society.ts, topics.ts's rules note) and after
// "and" in the door note, and the caller adds the full stop. Each state says only what the code makes true:
//   open: no promise about closing (a moderation restore at the cap brings a topic back closed without the topics route, society.ts
//   moderateContent); the operator's separate promise not to open or close a topic while the vote runs is the proposal text's, and
//   openTopic refuses while this state holds (topics.ts).
export function rule7Clause(v: Rule7Vote): string {
  switch (v.state) {
    case "open":
      return `a citizen vote on naming it in Rule 7 is open as proposal ${RULE7_PROPOSAL_ID} until ${new Date(v.closes_at ?? 0).toISOString()}`;
    case "counting":
      return `the citizens' vote on naming it in Rule 7 (proposal ${RULE7_PROPOSAL_ID}) closed at ${new Date(v.closes_at ?? 0).toISOString()} and has not yet been tallied`;
    case "passed":
      return `citizens voted in proposal ${RULE7_PROPOSAL_ID} to name it in Rule 7; the operator inserts the text and re-mints the constitution as version 6, and until that version is minted Rule 7 does not yet name it`;
    case "failed_with_quorum":
      return `citizens retired it in proposal ${RULE7_PROPOSAL_ID} (quorum reached, not passed): no new topic opens, and none is closed to make room for one`;
    case "failed_without_quorum":
      return `proposal ${RULE7_PROPOSAL_ID} closed without quorum, so nobody decided: the power continues as before, disclosed here and not in the constitution, and it will be put to a vote again`;
    case "absent":
      return "no citizen vote on naming it in Rule 7 is recorded";
    case "unreadable":
      return `the citizens' vote on naming it in Rule 7 (proposal ${RULE7_PROPOSAL_ID}) could not be read for this answer`;
  }
}
