// The verdict of a council motion (D-075 order step c; commission C5 and CA10; K3). deriveMotionTally is a PURE function of the frozen snapshot, the motion's own columns,
// its ballots and the clock, so every boundary is driven here with plain objects: no database, no clock but the argument. The routes' own tests prove the same verdict end to
// end (test/council-motion-d1.test.ts). Each block names the mutant that turns it red.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { deriveMotionTally, operatorExclusions, COUNCIL_RULE_VERSION, type SnapshotMember, type BallotFacts, type Choice } from "../src/council-core.ts";

const seat: SnapshotMember = { kind: "citizen", id: 2, handle: "ledger-watch", rule: "operator_seat", operator_seat: true };
const sis: SnapshotMember = { kind: "citizen", id: 3, handle: "sisyphus", rule: "self_paid", operator_seat: false };
const key: SnapshotMember = { kind: "citizen", id: 4, handle: "keyed-free", rule: "self_paid", operator_seat: false };
const wren: SnapshotMember = { kind: "resident", id: 3, handle: "wren", rule: "earned", operator_seat: false }; // the SAME number as sisyphus's citizen id: a different member
const FOUR = [seat, sis, key, wren];
const CLOSES = 1_000_000;
const CLOSED = CLOSES; // the instant of the close counts as closed
const b = (m: SnapshotMember, choice: Choice): BallotFacts => ({ member_kind: m.kind, member_id: m.id, choice });
const motion = (over: Partial<{ kind: "statement" | "advice"; proposer: SnapshotMember; flagged: boolean }> = {}) => ({
  kind: over.kind ?? "statement",
  proposer_kind: (over.proposer ?? sis).kind,
  proposer_id: (over.proposer ?? sis).id,
  operator_flagged_at: over.flagged ? 500_000 : null,
  closes_at: CLOSES,
});
const verdict = (m: ReturnType<typeof motion>, snapshot: SnapshotMember[], ballots: BallotFacts[], now = CLOSED) => deriveMotionTally(m, snapshot, ballots, now);

test("open until the close, whatever the ballots say: one millisecond before closes_at it is open even with a unanimous count; at closes_at it is decided (mutant: the comparison is <= instead of <)", () => {
  const all = [b(seat, "yes"), b(sis, "yes"), b(key, "yes"), b(wren, "yes")];
  assert.equal(verdict(motion(), FOUR, all, CLOSES - 1).status, "open");
  assert.equal(verdict(motion(), FOUR, all, CLOSES).status, "passed");
  assert.deepEqual(verdict(motion(), FOUR, all, CLOSES - 1).why_not, [], "an open motion has no failure reasons");
  assert.equal(verdict(motion(), FOUR, [], CLOSES - 1).rule, COUNCIL_RULE_VERSION);
});

test("one counted ballot fails; two exactly half of four fails; three more than half passes (K3: at least two ballots, more than half of the eligible members) (mutants: >= for >; the floor of two dropped)", () => {
  assert.equal(verdict(motion(), FOUR, [b(sis, "yes")]).status, "failed");
  assert.match(verdict(motion(), FOUR, [b(sis, "yes")]).why_not.join("; "), /fewer than 2 counted ballots \(1\)/);
  const two = verdict(motion(), FOUR, [b(sis, "yes"), b(wren, "yes")]);
  assert.equal(two.status, "failed", "two of four is exactly half, not more than half");
  assert.match(two.why_not.join("; "), /not more than half of the 4 eligible members/);
  assert.equal(verdict(motion(), FOUR, [b(sis, "yes"), b(wren, "yes"), b(key, "yes")]).status, "passed");
  assert.equal(verdict(motion(), FOUR, []).status, "failed", "no ballots at all");
});

test("yes must beat no: a tie fails, abstentions count towards the half but not towards the margin (mutants: >= for >; abstain counted as yes)", () => {
  assert.equal(verdict(motion(), FOUR, [b(sis, "yes"), b(wren, "no"), b(key, "abstain")]).status, "failed", "1 yes, 1 no, 1 abstain: a tie");
  assert.match(verdict(motion(), FOUR, [b(sis, "yes"), b(wren, "no"), b(key, "abstain")]).why_not.join("; "), /yes \(1\) is not more than no \(1\)/);
  assert.equal(verdict(motion(), FOUR, [b(sis, "yes"), b(wren, "yes"), b(key, "no")]).status, "passed");
  assert.equal(verdict(motion(), FOUR, [b(sis, "no"), b(wren, "no"), b(key, "yes")]).status, "failed");
  const abstainsOnly = verdict(motion(), FOUR, [b(sis, "abstain"), b(wren, "abstain"), b(key, "abstain")]);
  assert.equal(abstainsOnly.status, "failed", "three abstentions: counted, but yes 0 is not more than no 0");
  assert.equal(abstainsOnly.counted, 3);
});

test("a motion needs a counted ballot from a member outside the operator's list: the seat plus one other can pass, the seat alone never can; and that condition is IMPLIED by the other two (there is one seat), proved over every combination of four members' ballots and four kinds of motion", () => {
  const seatPlusOne = verdict(motion(), [seat, sis], [b(seat, "yes"), b(sis, "yes")]);
  assert.equal(seatPlusOne.status, "passed", "today's two members: both must say yes");
  assert.equal(seatPlusOne.counted_outside_operator_list, 1);
  assert.equal(verdict(motion(), [seat, sis], [b(seat, "yes")]).status, "failed");
  const choices: Array<Choice | null> = [null, "yes", "no", "abstain"];
  const kinds = [motion(), motion({ flagged: true }), motion({ kind: "advice" }), motion({ proposer: seat })];
  let checked = 0;
  for (const m of kinds) {
    for (const cs of choices) for (const ck of choices) for (const cw of choices) for (const cx of choices) {
      const ballots = [[seat, cs], [sis, ck], [key, cw], [wren, cx]].flatMap(([mem, c]) => (c ? [b(mem as SnapshotMember, c as Choice)] : []));
      const t = verdict(m, FOUR, ballots);
      checked++;
      if (t.counted >= 2) assert.ok(t.counted_outside_operator_list >= 1, "two counted ballots always include one from outside the operator's list");
      const bar = t.counted >= 2 && t.counted_outside_operator_list >= 1 && t.counted * 2 > t.effective_size && t.yes > t.no;
      assert.equal(t.status === "passed", bar, "passed exactly when every K3 condition holds");
      assert.equal(t.why_not.length === 0, bar, "and a failure always says why");
    }
  }
  assert.equal(checked, 4 * 256);
});

test("a flag, an advice motion and the seat's own motion each take the seat out of the count and set its ballot aside (CA10); the seat's ballot stays in the table and is served, never counted (mutants: a reason is dropped; the ballot is counted)", () => {
  const seatYes = b(seat, "yes");
  for (const [name, m] of [
    ["flagged", motion({ flagged: true })],
    ["advice", motion({ kind: "advice" })],
    ["proposed by the operator's seat", motion({ proposer: seat })],
  ] as const) {
    const t = verdict(m, FOUR, [seatYes, b(sis, "yes"), b(wren, "yes")]);
    assert.equal(t.operator_excluded, true, name);
    assert.equal(t.effective_size, 3, `${name}: the seat is out of the eligible count`);
    assert.equal(t.counted, 2, `${name}: its ballot is not counted`);
    assert.deepEqual(t.set_aside, [{ member_kind: "citizen", member_id: 2, choice: "yes" }], `${name}: kept and labelled`);
    assert.equal(t.status, "passed", `${name}: two of three outside the seat is more than half`);
  }
  // not excluded: the same ballots count
  const plain = verdict(motion(), FOUR, [seatYes, b(sis, "yes"), b(wren, "yes")]);
  assert.equal(plain.counted, 3);
  assert.deepEqual(plain.set_aside, []);
  assert.equal(plain.operator_excluded, false);
});

test("the operator exclusion shrinks the bar: with the seat out, two of three is more than half, but with the seat in two of four is not (the bar moves with the flag) (mutant: the effective size ignores the exclusion)", () => {
  const two = [b(sis, "yes"), b(wren, "yes")];
  assert.equal(verdict(motion(), FOUR, two).status, "failed");
  assert.equal(verdict(motion({ flagged: true }), FOUR, two).status, "passed");
  assert.equal(verdict(motion({ flagged: true }), FOUR, [b(sis, "yes")]).status, "failed");
  assert.equal(verdict(motion({ flagged: true }), FOUR, [b(seat, "yes"), b(sis, "yes")]).status, "failed", "the seat's ballot is set aside, so one counted ballot is not enough");
});

test("with today's two members a statement passes only on both yes, a flag or an advice motion can never pass, and an operator-proposed statement can never pass (the consequence of CA10 the checkpoint states)", () => {
  const today = [seat, sis];
  assert.equal(verdict(motion(), today, [b(seat, "yes"), b(sis, "yes")]).status, "passed");
  assert.equal(verdict(motion(), today, [b(seat, "yes"), b(sis, "no")]).status, "failed");
  assert.equal(verdict(motion({ flagged: true }), today, [b(seat, "yes"), b(sis, "yes")]).status, "failed");
  assert.equal(verdict(motion({ kind: "advice" }), today, [b(sis, "yes")]).status, "failed");
  assert.equal(verdict(motion({ proposer: seat }), today, [b(seat, "yes"), b(sis, "yes")]).status, "failed");
});

test("a ballot from outside the snapshot is never counted, and a citizen and a resident with the same number are different members (mutant: membership is matched on the id alone)", () => {
  const stranger: SnapshotMember = { kind: "citizen", id: 99, handle: "late", rule: "self_paid", operator_seat: false };
  const t = verdict(motion(), FOUR, [b(sis, "yes"), b(stranger, "yes"), b(stranger, "yes")]);
  assert.equal(t.counted, 1);
  // sisyphus is citizen 3 and wren is resident 3: only the one that balloted is counted
  const one = verdict(motion(), FOUR, [{ member_kind: "resident", member_id: 3, choice: "yes" }]);
  assert.equal(one.counted, 1);
  assert.equal(one.yes, 1);
  // and a ballot from a resident whose number equals a citizen member's id is not that citizen's ballot: here only citizen 3 is a member
  assert.equal(verdict(motion(), [seat, sis], [{ member_kind: "resident", member_id: 3, choice: "yes" }]).counted, 0);
  const both = verdict(motion(), FOUR, [{ member_kind: "resident", member_id: 3, choice: "yes" }, { member_kind: "citizen", member_id: 3, choice: "yes" }]);
  assert.equal(both.counted, 2);
});

test("operatorExclusions names every reason that applies, in a fixed order, and none for an ordinary statement; with no operator seat in the snapshot nothing is subtracted", () => {
  assert.deepEqual(operatorExclusions(motion(), FOUR), []);
  assert.deepEqual(operatorExclusions({ kind: "statement", proposer_kind: "resident", proposer_id: seat.id, operator_flagged_at: null }, FOUR), [], "a resident whose number equals the seat's citizen id did not propose as the seat");
  assert.deepEqual(operatorExclusions(motion({ kind: "advice", proposer: seat, flagged: true }), FOUR), ["advice", "proposed_by_operator_seat", "flagged"]);
  const noSeat = verdict(motion({ flagged: true }), [sis, key, wren], [b(sis, "yes"), b(key, "yes")]);
  assert.equal(noSeat.effective_size, 3, "no seat to subtract");
  assert.equal(noSeat.status, "passed");
});
