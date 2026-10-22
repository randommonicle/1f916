// The v6 mint through the real root route when a passed text_amendment proposal exists: the same flow records changed_by mandate_linked, names the proposal, and flips it to executed.
// Own file because the module's process-wide version cache would otherwise carry the previous test's row into this database (each test file runs in its own process).
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { createLocalD1, seedCitizens, guestEnv, call, count } from "./helpers/guest.ts";
import { computeLiveConstitutionPair } from "../src/governance.ts";

const V5_HASH = "fa11788d062b0c6d23c54c428c1c9649d263ae3ba704e602e122066926049491";

test("with a passed text_amendment row present, GET / on a v5 database records mandate_linked with that proposal id, and a second GET / writes nothing", async () => {
  const d1 = createLocalD1();
  const { maintainer } = seedCitizens(d1);
  try {
    const { parametersHash, templateHash } = await computeLiveConstitutionPair();
    d1.raw
      .prepare("INSERT INTO constitution_versions (template_hash, parameters_hash, full_text, parameters_text, first_seen_at, changed_by, mandate_proposal_ids) VALUES (?, ?, 'v5 text', 'params', 1000, 'genesis', '[]')")
      .run(V5_HASH, parametersHash);
    const p = d1.raw
      .prepare("INSERT INTO proposals (kind, title, body, proposer_id, opened_at, closes_at, created_at, status) VALUES ('text_amendment', 't', 'b', ?, 1, 2, 1, 'passed')")
      .run(maintainer);
    const pid = Number(p.lastInsertRowid);

    assert.equal((await call(guestEnv(d1), "GET", "/")).status, 200);
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM constitution_versions"), 2);
    const row = d1.raw.prepare("SELECT template_hash, changed_by, mandate_proposal_ids FROM constitution_versions ORDER BY id DESC LIMIT 1").get() as { template_hash: string; changed_by: string; mandate_proposal_ids: string };
    assert.equal(row.template_hash, templateHash);
    assert.equal(row.changed_by, "mandate_linked");
    assert.equal(row.mandate_proposal_ids, JSON.stringify([pid]));
    assert.equal((d1.raw.prepare("SELECT status FROM proposals WHERE id = ?").get(pid) as { status: string }).status, "executed", "the mandate is consumed");

    assert.equal((await call(guestEnv(d1), "GET", "/")).status, 200);
    assert.equal(count(d1, "SELECT COUNT(*) AS n FROM constitution_versions"), 2, "a second GET / writes nothing");
  } finally {
    d1.close();
  }
});
