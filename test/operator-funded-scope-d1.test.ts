// operator_funded's scope, said wherever the flag is defined (13 Oct, Ben's option A on a Colony review by shejiao-daren).
// The five operator-controlled seats were paid from the same wallet as the sponsored seats and serve operator_funded:false; the
// definition never said the flag covers only seats outside the operator's list, so the rows looked like they contradicted it.
// These tests pin the scope sentence on every surface that defines or counts the flag, and pin the row behaviour it describes.
//
// Run just this file:
//   node --experimental-strip-types --test "test/operator-funded-scope-d1.test.ts"

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, guestEnv } from "./helpers/guest.ts";
import { insertCitizen } from "./helpers/local-d1.ts";
import { citizenDirectory, officialFacts, OPERATOR_FUNDED_SCOPE_SENTENCE, OPERATOR_CONTROLLED_HANDLES, SPONSORED_HANDLES } from "../src/society.ts";
import { renderLlmsTxt } from "../src/discovery.ts";
import { compositionDoorNote } from "../src/doc.ts";

function seeded() {
  const d1 = createLocalD1();
  insertCitizen(d1, { handle: OPERATOR_CONTROLLED_HANDLES[0]! });
  insertCitizen(d1, { handle: SPONSORED_HANDLES[0]! });
  insertCitizen(d1, { handle: "sisyphus" });
  return guestEnv(d1);
}

test("the scope sentence says the flag marks sponsored seats only and that the operator's own seats were paid from the same wallet", () => {
  assert.match(OPERATOR_FUNDED_SCOPE_SENTENCE, /sponsored seat only/);
  assert.match(OPERATOR_FUNDED_SCOPE_SENTENCE, /not on the operator's control list/);
  assert.match(OPERATOR_FUNDED_SCOPE_SENTENCE, /The operator's own seats were paid from that wallet too/);
  assert.match(OPERATOR_FUNDED_SCOPE_SENTENCE, /operator_funded:false/);
});

test("GET /api/official: the operator_funded provenance check and the composition note both carry the scope sentence", async () => {
  const facts: any = await officialFacts(seeded());
  assert.ok((facts.provenance ?? facts.composition.provenance).operator_funded.check.includes(OPERATOR_FUNDED_SCOPE_SENTENCE), "provenance.operator_funded.check must define the flag's scope");
  assert.equal(facts.composition.operator_funded, 1);
  assert.ok(facts.composition.note.includes(OPERATOR_FUNDED_SCOPE_SENTENCE), "the composition note must define the flag's scope where it counts funded seats");
});

test("GET /api/citizens: the directory note carries the scope sentence, and an operator-controlled row is operator_funded:false (the behaviour the sentence describes)", async () => {
  const dir: any = await citizenDirectory(seeded());
  assert.ok(String(dir.note).includes(OPERATOR_FUNDED_SCOPE_SENTENCE), "the citizens note must define the flag's scope");
  const op = dir.citizens.find((c: any) => c.handle === OPERATOR_CONTROLLED_HANDLES[0]);
  const sp = dir.citizens.find((c: any) => c.handle === SPONSORED_HANDLES[0]);
  const free = dir.citizens.find((c: any) => c.handle === "sisyphus");
  assert.deepEqual([op.operator_controlled, op.operator_funded], [true, false]);
  assert.deepEqual([sp.operator_controlled, sp.operator_funded], [false, true]);
  assert.deepEqual([free.operator_controlled, free.operator_funded], [false, false]);
});

test("/llms.txt: the funded clause carries the scope sentence", () => {
  const out = renderLlmsTxt({
    origin: "https://example.test",
    society: "Commonhold",
    composition: { citizens: 13, operator_controlled: 5, not_designated_operator_controlled: 8, operator_controlled_percent: 38, operator_funded: 7, operator_funded_handles: ["magnus-v2"] },
  } as any);
  assert.ok(out.replace(/\s+/g, " ").includes(OPERATOR_FUNDED_SCOPE_SENTENCE), "llms.txt must define the flag's scope where it counts funded seats");
});

test("GET / door note: the funded clause says the operator's own seats were paid from the same wallet and are not counted as operator-funded", () => {
  const note = compositionDoorNote(51, {
    citizens: 13,
    operator_controlled: 5,
    not_designated_operator_controlled: 8,
    operator_controlled_percent: 38,
    operator_controlled_handles: ["commonhold-agent"],
    operator_funded_handles: ["magnus-v2"],
  }).replace(/\s+/g, " ");
  assert.ok(note.includes("The operator's own seats were paid from that wallet too; they are counted as operator-controlled, never as operator-funded."));
});
