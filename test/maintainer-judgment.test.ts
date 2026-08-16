// Tests for the judge's pure logic: bulletin splitting, decision parsing
// (the executor's own allowlist against a real batch), the batch-loop
// arithmetic (M3/M4), and the flag-review decision encoding wake-start
// reconciliation depends on. No network, no D1 here -- fetchPendingQueueBatch/
// countPendingQueue/stampQueueRow are accepted as manual/local-D1
// coverage only, same acceptance as the rest of this repo's D1-touching
// functions; runJudgmentWake/executeJudgmentDecisions/reconcileApprovedQueue
// DO have real local-D1 coverage now, in test/maintainer-judgment-d1.test.ts.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import {
  JUDGMENT_QUEUE_CAP,
  JUDGMENT_MAX_BATCHES,
  JUDGMENT_MAX_SCAN,
  JUDGMENT_REPLAY_CAP,
  TOTAL_PROMPT_REQUEST_MAX_BYTES,
  JUDGMENT_SYSTEM_PROMPT,
  splitBulletinDraft,
  bulletinDenyCheck,
  parseJudgmentDecisions,
  resolveExecution,
  shouldContinueBatchLoop,
  computeOverflowDropped,
  buildJudgmentPrompt,
  shapeTargetContent,
  encodeFlagReviewDecision,
  decodeFlagReviewDecision,
  type QueueRow,
  type JudgmentDecision,
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
    fidelity_evidence: null,
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

// ---------- bulletinDenyCheck: H2's post-approval, pre-createPost gate ----------

test("bulletinDenyCheck refuses an external URL (https)", () => {
  assert.match(bulletinDenyCheck("Weekly digest", "Read more at https://example.com/details") ?? "", /external link/);
});

test("bulletinDenyCheck refuses an external URL (bare www.)", () => {
  assert.match(bulletinDenyCheck("Weekly digest", "See www.example.com for details") ?? "", /external link/);
});

test("bulletinDenyCheck refuses 'claim' (and its conjugations)", () => {
  assert.match(bulletinDenyCheck("Reward available", "Citizens may claim a bonus this week") ?? "", /claim/);
  assert.match(bulletinDenyCheck("Reward available", "Citizens claiming the bonus should act fast") ?? "", /claim/);
});

test("bulletinDenyCheck refuses 'connect (a) wallet' phrasing", () => {
  assert.match(bulletinDenyCheck("Action needed", "Please connect your wallet to continue") ?? "", /wallet/);
  assert.match(bulletinDenyCheck("Action needed", "Connect a wallet before Friday") ?? "", /wallet/);
});

test("bulletinDenyCheck refuses 'sign here' / 'sign to' phrasing", () => {
  assert.match(bulletinDenyCheck("Action needed", "Sign here to receive your allocation") ?? "", /sign/);
  assert.match(bulletinDenyCheck("Action needed", "Sign to verify your identity") ?? "", /sign/);
});

test("bulletinDenyCheck refuses 'authenticate through a link' phrasing", () => {
  assert.match(bulletinDenyCheck("Action needed", "Authenticate through the link below") ?? "", /authenticate/);
});

test("bulletinDenyCheck refuses 'airdrop' (and its conjugations)", () => {
  assert.match(bulletinDenyCheck("Good news", "An airdrop is coming for active citizens") ?? "", /airdrop/);
});

test("bulletinDenyCheck refuses 'official token' phrasing", () => {
  assert.match(bulletinDenyCheck("Good news", "The official token launches this week") ?? "", /official token/);
});

test("bulletinDenyCheck refuses 'seed phrase' phrasing", () => {
  assert.match(bulletinDenyCheck("Security notice", "Never share your seed phrase with anyone") ?? "", /seed phrase/);
});

test("bulletinDenyCheck passes an ordinary bulletin clean", () => {
  assert.equal(bulletinDenyCheck("Weekly digest", "Three new citizens joined this week. The treasury grew by $4. No moderation actions were needed."), null);
});

test("bulletinDenyCheck checks the title as well as the body", () => {
  assert.notEqual(bulletinDenyCheck("Claim your reward now", "ordinary body text"), null);
});

// ---------- resolveExecution: what a decision actually does (H2's stamps-rejected-never-posts guarantee) ----------

function decision(over: Partial<JudgmentDecision> & { queue_id: number }): JudgmentDecision {
  return { decision: "approve", reason: "looks fine", action: null, ...over };
}

test("resolveExecution: an approved bulletin_draft that fails the deny-check resolves to rejected with execute null (never posts)", () => {
  const item = { kind: "bulletin_draft" as const, target_type: null, target_id: null, source_ref: null, note: "Claim your reward\nSign here to continue", target_content: null, target_mod_state: null, fidelity_evidence: null, id: 1 };
  const resolved = resolveExecution(item, decision({ queue_id: 1, reason: "seems like a fine bulletin" }));
  assert.equal(resolved.status, "rejected");
  assert.equal(resolved.execute, null);
  assert.match(resolved.reason, /^deny-check: /);
});

test("resolveExecution: an approved bulletin_draft that passes the deny-check resolves to approved with a bulletin to post", () => {
  const item = { kind: "bulletin_draft" as const, target_type: null, target_id: null, source_ref: null, note: "Weekly digest\nAll quiet this week.", target_content: null, target_mod_state: null, fidelity_evidence: null, id: 1 };
  const resolved = resolveExecution(item, decision({ queue_id: 1 }));
  assert.equal(resolved.status, "approved");
  assert.deepEqual(resolved.execute, { kind: "bulletin", title: "Weekly digest", body: "All quiet this week." });
});

test("resolveExecution: a rejected decision always executes nothing, regardless of kind", () => {
  const item = { kind: "bulletin_draft" as const, target_type: null, target_id: null, source_ref: null, note: "Weekly digest\nAll quiet.", target_content: null, target_mod_state: null, fidelity_evidence: null, id: 1 };
  const resolved = resolveExecution(item, decision({ queue_id: 1, decision: "reject", reason: "not newsworthy" }));
  assert.equal(resolved.status, "rejected");
  assert.equal(resolved.execute, null);
});

test("resolveExecution: an approved flag_review maps to a moderate execution with the decided action", () => {
  const item = { kind: "flag_review" as const, target_type: "post" as const, target_id: 42, source_ref: "flag on post 42", note: "spam", target_content: null, target_mod_state: null, fidelity_evidence: null, id: 1 };
  const resolved = resolveExecution(item, decision({ queue_id: 1, action: "remove", reason: "confirmed spam" }));
  assert.equal(resolved.status, "approved");
  assert.deepEqual(resolved.execute, { kind: "moderate", targetType: "post", targetId: 42, action: "remove" });
});

test("resolveExecution: an approved bookkeeping_note executes nothing but still reports approved", () => {
  const item = { kind: "bookkeeping_note" as const, target_type: null, target_id: null, source_ref: null, note: "drift observed", target_content: null, target_mod_state: null, fidelity_evidence: null, id: 1 };
  const resolved = resolveExecution(item, decision({ queue_id: 1 }));
  assert.equal(resolved.status, "approved");
  assert.equal(resolved.execute, null);
});

// docs/BRIEF-FIRST-LAWS.md commit 4: "the observational fallthrough in
// resolveExecution already gives non-flag, non-bulletin kinds the right
// execution semantics (verdict recorded, nothing executes) -- verify and
// test rather than re-derive." A constitution_fidelity item is exactly
// that shape (design doc §5: the judge's fidelity verdict is a recorded
// decision, never an executed action) -- these two tests are that
// verification, not a re-derivation of new behaviour.
test("resolveExecution: an approved constitution_fidelity item executes nothing but still reports approved -- the fidelity verdict is a recorded decision, never an executed action", () => {
  const item = {
    kind: "constitution_fidelity" as const,
    target_type: null,
    target_id: null,
    source_ref: "constitution_versions:2",
    note: "constitution changed to version 2...",
    target_content: null,
    target_mod_state: null,
    fidelity_evidence: null,
    id: 1,
  };
  const resolved = resolveExecution(item, decision({ queue_id: 1, reason: "matches its linked mandate exactly" }));
  assert.equal(resolved.status, "approved");
  assert.equal(resolved.execute, null);
  assert.equal(resolved.reason, "matches its linked mandate exactly");
});

test("resolveExecution: a rejected constitution_fidelity item executes nothing, same as any other rejected kind", () => {
  const item = {
    kind: "constitution_fidelity" as const,
    target_type: null,
    target_id: null,
    source_ref: "constitution_versions:2",
    note: "constitution changed to version 2...",
    target_content: null,
    target_mod_state: null,
    fidelity_evidence: null,
    id: 1,
  };
  const resolved = resolveExecution(item, decision({ queue_id: 1, decision: "reject", reason: "exceeds its linked mandate" }));
  assert.equal(resolved.status, "rejected");
  assert.equal(resolved.execute, null);
});

// ---------- shouldContinueBatchLoop / computeOverflowDropped: the batch loop (M3/M4, F7) ----------

test("JUDGMENT_QUEUE_CAP is 1 (D-037: the ruled decision-throughput cap -- at most four decisions per weekly wake, four batches x one item)", () => {
  assert.equal(JUDGMENT_QUEUE_CAP, 1);
});

test("JUDGMENT_MAX_BATCHES is 4", () => {
  assert.equal(JUDGMENT_MAX_BATCHES, 4);
});

test("JUDGMENT_MAX_SCAN is a real, finite row/memory ceiling (docs/BRIEF-JUDGMENT-QUERY-BUDGET.md §4: after the set-based work it is a row-read bound, NOT a per-cap query multiplier)", () => {
  // Post-§1/§2 the scan cost is fixed regardless of page composition, so this
  // is no longer "10x the cap" -- it is a standalone row/memory ceiling on
  // one scan. It must be a real bound (not effectively unlimited) and
  // comfortably above the throughput cap so a withheld head cohort never
  // starves ordinary rows behind it within a single scan.
  assert.equal(JUDGMENT_MAX_SCAN, 1000);
  assert.ok(JUDGMENT_MAX_SCAN > JUDGMENT_QUEUE_CAP, "the scan ceiling must exceed the per-batch decision cap");
  assert.ok(JUDGMENT_MAX_SCAN < 1_000_000, "a real row/memory bound, not effectively unlimited");
});

test("JUDGMENT_REPLAY_CAP is a small positive constant (§6: the stranded-approved replay cohort, bounded so a backlog cannot exhaust the invocation before the pending batch)", () => {
  assert.ok(JUDGMENT_REPLAY_CAP >= 1, "at least one stranded row heals per wake");
  assert.ok(JUDGMENT_REPLAY_CAP <= 5, "small enough that <=6 subrequests per replayed row keeps the non-sheddable floor under budget");
});

test("TOTAL_PROMPT_REQUEST_MAX_BYTES is generous against Fable's real input budget (verified: 1M-token context window) yet a real, finite bound", () => {
  assert.ok(TOTAL_PROMPT_REQUEST_MAX_BYTES > 0);
  assert.ok(TOTAL_PROMPT_REQUEST_MAX_BYTES < 10_000_000, "must be a real transport bound, not effectively unlimited");
});

// F7 (docs/BRIEF-FIRST-LAWS-REPAIR.md §8.5): replaces shouldFetchNextBatch.
// Continuation is now driven by the scanner's own two authoritative
// signals (drained, scanLimitHit), never by how many items ended up
// admissible in the last batch -- an admissible-short batch (interspersed
// withheld rows) can still have plenty more behind it.
test("shouldContinueBatchLoop: continues when the scan is neither drained nor scan-limited and the ceiling is not reached", () => {
  assert.equal(shouldContinueBatchLoop(false, false, 1, 4), true);
  assert.equal(shouldContinueBatchLoop(false, false, 3, 4), true);
});

test("shouldContinueBatchLoop: stops once the scan reports drained, regardless of batchesRun", () => {
  assert.equal(shouldContinueBatchLoop(true, false, 1, 4), false);
});

test("shouldContinueBatchLoop: stops once the scan reports scanLimitHit, regardless of batchesRun", () => {
  assert.equal(shouldContinueBatchLoop(false, true, 1, 4), false);
});

test("shouldContinueBatchLoop: stops at the hard batchesRun ceiling even when neither drained nor scan-limited", () => {
  assert.equal(shouldContinueBatchLoop(false, false, 4, 4), false);
});

test("shouldContinueBatchLoop: any one of the three stop conditions wins, not just the ceiling", () => {
  assert.equal(shouldContinueBatchLoop(true, true, 0, 4), false);
  assert.equal(shouldContinueBatchLoop(true, false, 0, 4), false);
  assert.equal(shouldContinueBatchLoop(false, true, 0, 4), false);
});

test("computeOverflowDropped: zero when this wake actioned everything that was pending at the start", () => {
  assert.equal(computeOverflowDropped(50, 50), 0);
});

test("computeOverflowDropped: reports the TRUE backlog left behind, not capped at 1 like the old LIMIT+1-read approach", () => {
  // The old capQueueBatch derived overflow from a single LIMIT-cap+1 read
  // sliced back to cap, so it could only ever report 0 or 1 regardless of
  // the real backlog. A 550-pending / 400-actioned week (the
  // JUDGMENT_MAX_BATCHES ceiling reached) must show the true 150 left
  // over, not 1.
  assert.equal(computeOverflowDropped(550, 400), 150);
});

test("computeOverflowDropped: never goes negative even if itemsActioned somehow exceeds the starting count", () => {
  // Defensive: pending can only grow between the initial count and a
  // batch fetch in the extremely unlikely case of concurrent writers, so
  // actioned should never exceed the start count in practice -- but the
  // arithmetic itself must not report a negative "overflow".
  assert.equal(computeOverflowDropped(10, 12), 0);
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

// F4 (docs/BRIEF-FIRST-LAWS-REPAIR.md §8.3 item 1): a constitution_fidelity
// row's assembled evidence must reach the prompt verbatim, delimited, the
// same way target_content does for flag_review.
test("buildJudgmentPrompt carries a constitution_fidelity item's fidelity_evidence block verbatim, delimited", () => {
  const evidence = [
    "<constitution_fidelity_evidence>",
    "  <previous_version>\nPREVIOUS FULL TEXT\n\nPREVIOUS PARAMS TEXT\n  </previous_version>",
    "  <new_version>\nNEW FULL TEXT\n\nNEW PARAMS TEXT\n  </new_version>",
    '  <linked_mandate id="7" status="passed">\n    <title>Rename the society</title>\n    <body>MANDATE BODY TEXT</body>\n  </linked_mandate>',
    "</constitution_fidelity_evidence>",
  ].join("\n");
  const prompt = buildJudgmentPrompt([
    row({ id: 1, kind: "constitution_fidelity", source_ref: "constitution_versions:2", note: "constitution changed to version 2", fidelity_evidence: evidence }),
  ]);
  assert.match(prompt, /<constitution_fidelity_evidence>/);
  assert.match(prompt, /PREVIOUS FULL TEXT/);
  assert.match(prompt, /PREVIOUS PARAMS TEXT/);
  assert.match(prompt, /NEW FULL TEXT/);
  assert.match(prompt, /NEW PARAMS TEXT/);
  assert.match(prompt, /MANDATE BODY TEXT/);
  assert.match(prompt, /<\/constitution_fidelity_evidence>/);
});

test("buildJudgmentPrompt omits the fidelity_evidence block entirely when it does not apply (null on every non-fidelity kind)", () => {
  const prompt = buildJudgmentPrompt([row({ id: 1, kind: "bookkeeping_note", note: "drift observed" })]);
  assert.doesNotMatch(prompt, /<constitution_fidelity_evidence>/);
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

test("bulletinDenyCheck: secret-harvesting shapes are refused (Opus re-review item 1)", () => {
  assert.notEqual(bulletinDenyCheck("Weekly note", "Send 0.1 ETH to 0xAbC1234 and receive 1000 COMMON"), null);
  assert.notEqual(bulletinDenyCheck("Weekly note", "verify their identity by replying with their citizen secret"), null);
  assert.notEqual(bulletinDenyCheck("Weekly note", "Rotate your key and send the new secret to citizen 4"), null);
});

test("bulletinDenyCheck: a raw 40-hex wallet address is refused", () => {
  assert.notEqual(bulletinDenyCheck("Note", "pay 0xD9E17995352EF13F9Ba467e2F36C7614A45e7011 directly"), null);
});

// ---------- encodeFlagReviewDecision / decodeFlagReviewDecision: wake-start reconciliation's only way to recover a stranded flag_review's action ----------
//
// mq1 namespace (fixes pass, exchange/REVIEW_wake-reconciliation_2026-08-11.md
// CLAUDE round 2): replaces the bare "<action>: <reason>" prefix this
// file's own immediate predecessor commit used, LOCAL and never deployed,
// so no legacy support for it -- Codex's round-1 pre-gate review proved
// the bare shape decodes (and EXECUTES) ordinary pre-encoding prose that
// merely happens to start with an action word.

test("encodeFlagReviewDecision/decodeFlagReviewDecision round-trip for all three actions (mq1 namespace)", () => {
  for (const action of ["collapse", "remove", "restore"] as const) {
    const encoded = encodeFlagReviewDecision(action, "confirmed spam, take it down");
    assert.equal(encoded, `mq1|${action}|confirmed spam, take it down`);
    assert.deepEqual(decodeFlagReviewDecision(encoded), { action, reason: "confirmed spam, take it down" });
  }
});

test("decodeFlagReviewDecision returns null for ordinary free text with no mq1 namespace (every pre-this-commit row) -- never guesses", () => {
  assert.equal(decodeFlagReviewDecision("confirmed spam, take it down"), null);
  assert.equal(decodeFlagReviewDecision("looked fine to the judge"), null);
});

test("decodeFlagReviewDecision returns null for null and empty decided_reason", () => {
  assert.equal(decodeFlagReviewDecision(null), null);
  assert.equal(decodeFlagReviewDecision(""), null);
});

test("decodeFlagReviewDecision refuses the dead bare '<action>: <reason>' shape entirely -- 9214511 never deployed, no legacy support (fixes-pass ruling 2)", () => {
  assert.equal(decodeFlagReviewDecision("remove: confirmed spam"), null);
  assert.equal(decodeFlagReviewDecision("collapse: borderline, needs review"), null);
  assert.equal(decodeFlagReviewDecision("restore: restored after appeal"), null);
});

test("decodeFlagReviewDecision refuses ordinary prose that mimics the action-prefix shape (Codex round-1 Ask 1.2 reproduction, verbatim)", () => {
  assert.equal(decodeFlagReviewDecision("collapse: prose written before action encoding existed"), null);
  assert.equal(decodeFlagReviewDecision("removed: already actioned by a human, FYI"), null);
});

test("decodeFlagReviewDecision rejects a verb that merely starts with a valid action but is not one (no false match on a prefix)", () => {
  assert.equal(decodeFlagReviewDecision("mq1|collapsed|already done, nothing to do"), null);
  assert.equal(decodeFlagReviewDecision("mq1|removedly|not a real action"), null);
});

test("decodeFlagReviewDecision refuses anything not EXACTLY the mq1 namespace, anchored at the very start", () => {
  assert.equal(decodeFlagReviewDecision("mq2|remove|wrong version tag"), null);
  assert.equal(decodeFlagReviewDecision("MQ1|remove|wrong case"), null);
  assert.equal(decodeFlagReviewDecision("xmq1|remove|not anchored at the start"), null);
  assert.equal(decodeFlagReviewDecision(" mq1|remove|leading whitespace"), null);
  assert.equal(decodeFlagReviewDecision("mq1remove|missing the first pipe"), null);
  assert.equal(decodeFlagReviewDecision("mq1|removeconfirmed spam"), null); // missing the second pipe entirely
});

test("encodeFlagReviewDecision preserves a reason containing its own colons or pipes -- only the namespace's own two pipes are structural", () => {
  const encoded = encodeFlagReviewDecision("remove", "spam: contains a promo link | reported twice");
  assert.equal(encoded, "mq1|remove|spam: contains a promo link | reported twice");
  assert.deepEqual(decodeFlagReviewDecision(encoded), { action: "remove", reason: "spam: contains a promo link | reported twice" });
});

test("bulletinDenyCheck: an ordinary bulletin still passes after the additions", () => {
  assert.equal(bulletinDenyCheck("This week in Commonhold", "Three new threads, one flag reviewed and restored. The books balance."), null);
});
