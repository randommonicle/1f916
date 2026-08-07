// Tests for the judge's pure logic: bulletin splitting, decision parsing
// (the executor's own allowlist against a real batch), and the 100-item
// cap. No network, no D1 -- fetchPendingQueue/stampQueueRow/runJudgmentWake
// itself are accepted as manual/local-D1 coverage only, same acceptance as
// the rest of this repo's D1-touching functions.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import {
  JUDGMENT_QUEUE_CAP,
  JUDGMENT_SYSTEM_PROMPT,
  splitBulletinDraft,
  parseJudgmentDecisions,
  capQueueBatch,
  buildJudgmentPrompt,
  shapeTargetContent,
  type QueueRow,
} from "../src/maintainer/judgment.ts";

function row(over: Partial<QueueRow> & { id: number }): QueueRow {
  return {
    kind: "bookkeeping_note",
    target_type: null,
    target_id: null,
    source_ref: null,
    note: "a note",
    target_content: null,
    target_mod_state: null,
    ...over,
  };
}

// ---------- splitBulletinDraft ----------

test("splitBulletinDraft takes the first line as the title, the rest as the body", () => {
  const { title, body } = splitBulletinDraft("Weekly digest\nThree new citizens joined this week.");
  assert.equal(title, "Weekly digest");
  assert.equal(body, "Three new citizens joined this week.");
});

test("splitBulletinDraft with no newline: the whole thing is the title, body is empty", () => {
  const { title, body } = splitBulletinDraft("Just a title, no body");
  assert.equal(title, "Just a title, no body");
  assert.equal(body, "");
});

test("splitBulletinDraft trims whitespace from both title and body", () => {
  const { title, body } = splitBulletinDraft("  Title with space  \n  Body with space  ");
  assert.equal(title, "Title with space");
  assert.equal(body, "Body with space");
});

test("splitBulletinDraft moves title overflow into the body rather than cutting it (no-silent-data-drop)", () => {
  const longTitle = "T".repeat(150); // over CONSTITUTION.max_title_len (120)
  const { title, body } = splitBulletinDraft(`${longTitle}\nexisting body`);
  assert.equal(title.length, 120);
  assert.ok(body.startsWith("T".repeat(30))); // the 30 overflow chars
  assert.ok(body.endsWith("existing body"));
});

test("splitBulletinDraft pads a too-short title rather than letting createPost reject it silently", () => {
  const { title } = splitBulletinDraft("Hi\nbody");
  assert.ok(title.length >= 3);
});

// ---------- capQueueBatch: the 100-item cap ----------

test("capQueueBatch passes a small batch through untouched, zero overflow", () => {
  const pending = Array.from({ length: 10 }, (_, i) => row({ id: i }));
  const { batch, overflowDropped } = capQueueBatch(pending);
  assert.equal(batch.length, 10);
  assert.equal(overflowDropped, 0);
});

test("capQueueBatch caps at exactly 100, oldest-first, counting the rest as overflow", () => {
  const pending = Array.from({ length: 130 }, (_, i) => row({ id: i }));
  const { batch, overflowDropped } = capQueueBatch(pending);
  assert.equal(batch.length, 100);
  assert.equal(overflowDropped, 30);
  assert.equal(batch[0].id, 0); // oldest first, so index 0 is kept
  assert.equal(batch[99].id, 99);
});

test("JUDGMENT_QUEUE_CAP is 100", () => {
  assert.equal(JUDGMENT_QUEUE_CAP, 100);
});

// ---------- parseJudgmentDecisions ----------

test("parseJudgmentDecisions accepts a valid approve with an action for a flag_review item", () => {
  const item = row({ id: 1, kind: "flag_review", target_type: "post", target_id: 5 });
  const batch = new Map([[1, item]]);
  const raw = JSON.stringify([{ queue_id: 1, decision: "approve", reason: "spam, remove it", action: "remove" }]);
  const decisions = parseJudgmentDecisions(raw, batch);
  assert.equal(decisions.length, 1);
  assert.deepEqual(decisions[0], { queue_id: 1, decision: "approve", reason: "spam, remove it", action: "remove" });
});

test("parseJudgmentDecisions accepts a valid reject with no action required", () => {
  const item = row({ id: 1, kind: "flag_review", target_type: "post", target_id: 5 });
  const batch = new Map([[1, item]]);
  const raw = JSON.stringify([{ queue_id: 1, decision: "reject", reason: "looks fine on review" }]);
  const decisions = parseJudgmentDecisions(raw, batch);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].action, null);
});

test("parseJudgmentDecisions drops a decision referencing a queue_id outside the batch", () => {
  const batch = new Map([[1, row({ id: 1 })]]);
  const raw = JSON.stringify([{ queue_id: 999, decision: "approve", reason: "x", action: null }]);
  assert.deepEqual(parseJudgmentDecisions(raw, batch), []);
});

test("parseJudgmentDecisions drops an invalid decision enum value", () => {
  const batch = new Map([[1, row({ id: 1 })]]);
  const raw = JSON.stringify([{ queue_id: 1, decision: "maybe", reason: "x" }]);
  assert.deepEqual(parseJudgmentDecisions(raw, batch), []);
});

test("parseJudgmentDecisions drops an approved flag_review item with a missing action", () => {
  const item = row({ id: 1, kind: "flag_review", target_type: "post", target_id: 5 });
  const batch = new Map([[1, item]]);
  const raw = JSON.stringify([{ queue_id: 1, decision: "approve", reason: "spam" }]);
  assert.deepEqual(parseJudgmentDecisions(raw, batch), []);
});

test("parseJudgmentDecisions drops an approved flag_review item with an invalid action value", () => {
  const item = row({ id: 1, kind: "flag_review", target_type: "post", target_id: 5 });
  const batch = new Map([[1, item]]);
  const raw = JSON.stringify([{ queue_id: 1, decision: "approve", reason: "spam", action: "delete_forever" }]);
  assert.deepEqual(parseJudgmentDecisions(raw, batch), []);
});

test("parseJudgmentDecisions does not require action for an approved bookkeeping_note or registration_check", () => {
  const batch = new Map([
    [1, row({ id: 1, kind: "bookkeeping_note" })],
    [2, row({ id: 2, kind: "registration_check", target_type: "citizen", target_id: 9 })],
  ]);
  const raw = JSON.stringify([
    { queue_id: 1, decision: "approve", reason: "noted, dust from a routine deposit" },
    { queue_id: 2, decision: "approve", reason: "confirmed benign, just a similar name" },
  ]);
  const decisions = parseJudgmentDecisions(raw, batch);
  assert.equal(decisions.length, 2);
});

test("parseJudgmentDecisions drops a decision with a missing or empty reason", () => {
  const batch = new Map([[1, row({ id: 1 })]]);
  const raw = JSON.stringify([{ queue_id: 1, decision: "reject" }, { queue_id: 1, decision: "reject", reason: "   " }]);
  assert.deepEqual(parseJudgmentDecisions(raw, batch), []);
});

test("parseJudgmentDecisions keeps the first decision and drops later duplicates for the same queue_id", () => {
  const batch = new Map([[1, row({ id: 1 })]]);
  const raw = JSON.stringify([
    { queue_id: 1, decision: "approve", reason: "first" },
    { queue_id: 1, decision: "reject", reason: "second, contradicts the first" },
  ]);
  const decisions = parseJudgmentDecisions(raw, batch);
  assert.equal(decisions.length, 1);
  assert.equal(decisions[0].reason, "first");
});

test("parseJudgmentDecisions throws on non-JSON text, naming stop_reason context for the caller", () => {
  assert.throws(() => parseJudgmentDecisions("not json {", new Map()), /not valid JSON/);
});

test("parseJudgmentDecisions throws on valid JSON that is not a top-level array", () => {
  assert.throws(() => parseJudgmentDecisions('{"queue_id": 1}', new Map()), /not a top-level array/);
});

test("parseJudgmentDecisions on an empty array leaves everything pending -- a safe, valid answer", () => {
  const batch = new Map([[1, row({ id: 1 })]]);
  assert.deepEqual(parseJudgmentDecisions("[]", batch), []);
});

// ---------- buildJudgmentPrompt ----------

// H1: this test used to pin the gap the review found -- it asserted only
// ids/kinds/notes, with no way to tell from the prompt whether the judge
// could see the flagged content itself. Updated, not deleted: it now also
// asserts the target's own current content reaches the prompt, alongside
// the clerk's note about it.
test("buildJudgmentPrompt includes every item's id, kind, note, and the flagged target's own current content", () => {
  const items = [
    row({ id: 1, kind: "bookkeeping_note", note: "drift observed" }),
    row({
      id: 2,
      kind: "flag_review",
      target_type: "post",
      target_id: 9,
      note: "spam candidate",
      target_content: "Buy cheap watches now, click here",
      target_mod_state: null,
    }),
  ];
  const prompt = buildJudgmentPrompt(items);
  assert.match(prompt, /id="1"/);
  assert.match(prompt, /id="2"/);
  assert.match(prompt, /drift observed/);
  assert.match(prompt, /spam candidate/);
  assert.match(prompt, /kind="flag_review"/);
  assert.match(prompt, /<target_content[^>]*>[\s\S]*Buy cheap watches now, click here[\s\S]*<\/target_content>/);
});

test("buildJudgmentPrompt renders a null target/source as an explicit 'none', not blank", () => {
  const prompt = buildJudgmentPrompt([row({ id: 1 })]);
  assert.match(prompt, /target_type="none"/);
  assert.match(prompt, /source="none"/);
});

test("buildJudgmentPrompt carries the target's mod_state as an attribute on target_content", () => {
  const prompt = buildJudgmentPrompt([row({ id: 1, kind: "flag_review", target_content: "some flagged text", target_mod_state: "collapsed" })]);
  assert.match(prompt, /<target_content mod_state="collapsed">/);
});

test("buildJudgmentPrompt renders a null mod_state on present target_content as 'visible', not the literal word null", () => {
  const prompt = buildJudgmentPrompt([row({ id: 1, kind: "flag_review", target_content: "some flagged text", target_mod_state: null })]);
  assert.match(prompt, /<target_content mod_state="visible">/);
});

test("buildJudgmentPrompt omits the target_content block entirely when it does not apply (not a flag_review on a post/comment)", () => {
  const prompt = buildJudgmentPrompt([row({ id: 1, kind: "bookkeeping_note", note: "drift observed", target_content: null })]);
  assert.doesNotMatch(prompt, /<target_content/);
});

test("buildJudgmentPrompt renders the '(target no longer exists)' sentinel like any other target_content, not specially", () => {
  const prompt = buildJudgmentPrompt([row({ id: 1, kind: "flag_review", target_content: "(target no longer exists)", target_mod_state: null })]);
  assert.match(prompt, /<target_content mod_state="visible">\n\(target no longer exists\)\n<\/target_content>/);
});

test("JUDGMENT_SYSTEM_PROMPT tells the judge to decide against the target artefact, not the clerk's description of it", () => {
  assert.match(JUDGMENT_SYSTEM_PROMPT, /target_content/);
  assert.match(JUDGMENT_SYSTEM_PROMPT, /current content/i);
});

// ---------- shapeTargetContent: the pure logic behind fetchPendingQueue's H1 fetch ----------

test("shapeTargetContent returns a post's title+body, truncated at 1000 chars, plus its mod_state", () => {
  const { content, modState } = shapeTargetContent("post", { title: "Cheap watches", body: "Click here to buy", mod_state: null });
  assert.equal(content, "Cheap watches\nClick here to buy");
  assert.equal(modState, null);
});

test("shapeTargetContent returns a comment's body plus its mod_state, no title concatenation", () => {
  const { content, modState } = shapeTargetContent("comment", { body: "this is spam", mod_state: "collapsed" });
  assert.equal(content, "this is spam");
  assert.equal(modState, "collapsed");
});

test("shapeTargetContent truncates long content at 1000 chars with the standard marker", () => {
  const { content } = shapeTargetContent("comment", { body: "x".repeat(1500), mod_state: null });
  assert.ok(content.endsWith(" [truncated]"));
  assert.equal(content.length, 1000 + " [truncated]".length);
});

test("shapeTargetContent renders an explicit sentinel, never a blank or invented content, when the row is gone", () => {
  const { content, modState } = shapeTargetContent("post", null);
  assert.equal(content, "(target no longer exists)");
  assert.equal(modState, null);
});
