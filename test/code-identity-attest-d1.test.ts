// GET /api/attest serves a `code` block (docs/BRIEF-SERVED-CODE-IDENTITY.md; T3): the deploy-time commit stamp and Cloudflare's version id, with a provenance that says what each is and is not.
// Real local D1 and the real router. The attested constitution is untouched by it (v5, template hash fa11788d): the block sits outside FRONT_DOOR_TEMPLATE.
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { callWorker, count, createLocalD1, json, testEnv } from "./helpers/settlement-harness.ts";
import { computeLiveConstitutionPair } from "../src/governance.ts";
import { CODE_PROVENANCE } from "../src/code-identity.ts";

const SHA = "69730d99c573b874f3acaecf34cf239fc90d252f";
const VERSION = { id: "a672490d-1b8b-4457-9e34-b23dfb5c6c4d", tag: "", timestamp: "2026-10-06T17:00:00.000Z" };
const V5_TEMPLATE_HASH = "fa11788d062b0c6d23c54c428c1c9649d263ae3ba704e602e122066926049491";
// The keys /api/attest served before this wave: every one must still be there.
const PRIOR_KEYS = [
  "ok", "checked_at", "algorithm", "verified_from", "identity_from", "ledger_from", "payouts_from", "ballots_from", "page_size", "identity_log", "treasury", "payouts", "ballots",
  "coverage_note", "what_this_proves", "what_this_does_not_prove", "what_closes_the_gap", "standing_order", "unsealed_note", "constitution",
];

const attest = async (extra: Record<string, unknown>) => {
  const d1 = createLocalD1();
  try {
    const res = await callWorker(new Request("https://example.test/api/attest"), testEnv(d1, extra));
    return { status: res.status, body: await json(res), constitutionRows: count(d1, "constitution_versions") };
  } finally {
    d1.close();
  }
};

test("T3: a deploy that stamped the commit and has the binding serves both, labelled", async () => {
  const r = await attest({ CODE_COMMIT: SHA, CF_VERSION_METADATA: VERSION });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.code, {
    commit: SHA,
    commit_status: "stamped",
    version_id: VERSION.id,
    version_timestamp: VERSION.timestamp,
    version_status: "available",
    provenance: JSON.parse(JSON.stringify(CODE_PROVENANCE)),
  });
  assert.deepEqual(r.body.code.provenance.commit.source, ["commonhold_statement"]);
  assert.deepEqual(r.body.code.provenance.version_id.source, ["platform_record"]);
});

test("T3: a deploy that forgot the stamp and has no binding serves not_stamped and unavailable, with nulls, never a default", async () => {
  const r = await attest({});
  assert.equal(r.status, 200);
  assert.equal(r.body.code.commit, null);
  assert.equal(r.body.code.commit_status, "not_stamped");
  assert.equal(r.body.code.version_id, null);
  assert.equal(r.body.code.version_timestamp, null);
  assert.equal(r.body.code.version_status, "unavailable");
  assert.ok(r.body.code.provenance, "the provenance is served whatever the statuses");
});

test("T3: a malformed stamp serves commit null with malformed_stamp, and the bad value appears nowhere in the response", async () => {
  for (const bad of [SHA.toUpperCase(), `${SHA}\n`, SHA.slice(0, 39), "refs/heads/main-not-a-sha"]) {
    const r = await attest({ CODE_COMMIT: bad, CF_VERSION_METADATA: VERSION });
    assert.equal(r.body.code.commit, null);
    assert.equal(r.body.code.commit_status, "malformed_stamp");
    assert.equal(r.body.code.version_id, VERSION.id, "the version id is independent of the stamp");
    assert.ok(!JSON.stringify(r.body).includes(bad.trim()), `the bad stamp ${JSON.stringify(bad)} must not be served anywhere`);
  }
});

test("T3: the existing /api/attest keys are all still served, and `code` is a new top-level key", async () => {
  const r = await attest({ CODE_COMMIT: SHA });
  for (const k of PRIOR_KEYS) assert.ok(k in r.body, `${k} must still be served`);
  assert.ok("code" in r.body);
});

test("T3 non-minting: the constitution is v5 (template hash fa11788d), identical whatever the stamp, and serving `code` writes no constitution row", async () => {
  const pair = await computeLiveConstitutionPair();
  assert.equal(pair.templateHash, V5_TEMPLATE_HASH, "this wave mints nothing");
  const bare = await attest({});
  const stamped = await attest({ CODE_COMMIT: SHA, CF_VERSION_METADATA: VERSION });
  assert.equal(bare.body.constitution.template_hash, V5_TEMPLATE_HASH);
  assert.deepEqual(stamped.body.constitution, bare.body.constitution, "the attested constitution does not move with the deploy stamp");
  assert.equal(stamped.constitutionRows, bare.constitutionRows, "no constitution_versions row is written by serving the code block");
});
