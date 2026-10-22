// The v6 mint through the REAL root route (second-visit wave, CODEX round 1 fix pass): starting from a database whose newest constitution_versions row is the v5 pair and with
// no passed amendment proposal, one GET / writes exactly one new row (the current template hash, changed_by operator) and one identity-log event; a second GET / writes nothing.
// The module keeps a process-wide cache of the current version row, so the mandate_linked flow lives in its own file (test/constitution-v6-mint-mandate-d1.test.ts, its own process).
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, seedCitizens, guestEnv, call, count } from "./helpers/guest.ts";
import { computeLiveConstitutionPair } from "../src/governance.ts";

const V5_HASH = "fa11788d062b0c6d23c54c428c1c9649d263ae3ba704e602e122066926049491";

async function seedV5(d1: ReturnType<typeof createLocalD1>): Promise<void> {
  const { parametersHash } = await computeLiveConstitutionPair();
  d1.raw
    .prepare("INSERT INTO constitution_versions (template_hash, parameters_hash, full_text, parameters_text, first_seen_at, changed_by, mandate_proposal_ids) VALUES (?, ?, 'v5 text', 'params', ?, 'genesis', '[]')")
    .run(V5_HASH, parametersHash, 1000);
}

test("one GET / on a v5 database writes exactly one operator row with the current template hash and one constitution_changed event; a second GET / writes nothing", async () => {
  const d1 = createLocalD1();
  seedCitizens(d1);
  try {
    await seedV5(d1);
    const { templateHash } = await computeLiveConstitutionPair();
    assert.notEqual(templateHash, V5_HASH, "the code is no longer v5");
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM proposals WHERE status = 'passed'"), 0, "no passed amendment proposal");
    const rows = () => count(d1, "SELECT COUNT(*) AS n FROM constitution_versions");
    const events = () => count(d1, "SELECT COUNT(*) AS n FROM identity_events WHERE kind = 'constitution_changed'");
    assert.equal(rows(), 1);
    const eventsBefore = events();

    const first = await call(guestEnv(d1), "GET", "/");
    assert.equal(first.status, 200);
    assert.equal(rows(), 2, "exactly one new row");
    assert.equal(events() - eventsBefore, 1, "and exactly one identity-log event");
    const row = d1.raw.prepare("SELECT template_hash, changed_by, mandate_proposal_ids FROM constitution_versions ORDER BY id DESC LIMIT 1").get() as { template_hash: string; changed_by: string; mandate_proposal_ids: string };
    assert.equal(row.template_hash, templateHash);
    assert.equal(row.changed_by, "operator");
    assert.equal(row.mandate_proposal_ids, "[]");

    const att = (await call(guestEnv(d1), "GET", "/api/attest")).body.constitution;
    assert.equal(att.version, 2);
    assert.equal(att.changed_by, "operator");
    assert.equal(att.template_hash, templateHash);

    const second = await call(guestEnv(d1), "GET", "/");
    assert.equal(second.status, 200);
    assert.equal(rows(), 2, "a second GET / writes no row");
    assert.equal(events() - eventsBefore, 1, "and no second event");
  } finally {
    d1.close();
  }
});
