// Served code identity: the module that computes it (docs/BRIEF-SERVED-CODE-IDENTITY.md; T1, T2).
//
// Run: npm test

import test from "node:test";
import assert from "node:assert/strict";
import { ANSWERED_BY_NOTE, answeredBy, codeBlock, codeIdentity, COMMIT_PATTERN } from "../src/code-identity.ts";

const SHA = "69730d99c573b874f3acaecf34cf239fc90d252f";
const VERSION = { id: "a672490d-1b8b-4457-9e34-b23dfb5c6c4d", tag: "", timestamp: "2026-10-06T17:00:00.000Z" };

test("T1 identity: a valid 40-hex lower-case stamp is stamped and served", () => {
  const id = codeIdentity({ CODE_COMMIT: SHA });
  assert.equal(id.commit, SHA);
  assert.equal(id.commit_status, "stamped");
});

test("T1 identity: an absent stamp is not_stamped with a null commit (undefined and null alike)", () => {
  for (const env of [{}, { CODE_COMMIT: undefined }, { CODE_COMMIT: null }]) {
    const id = codeIdentity(env);
    assert.equal(id.commit, null, JSON.stringify(env));
    assert.equal(id.commit_status, "not_stamped", JSON.stringify(env));
  }
});

test("T1 identity: every present-but-invalid stamp is malformed_stamp with a null commit, and the bad value appears nowhere in anything served", () => {
  const bad: unknown[] = [
    SHA.toUpperCase(), // upper case
    SHA.slice(0, 39), // 39 chars
    SHA + "0", // 41 chars
    SHA + "\n", // trailing newline
    SHA + "\r\n",
    ` ${SHA}`, // leading space
    `${SHA} `, // trailing space
    `${SHA.slice(0, 20)} ${SHA.slice(21)}`, // internal whitespace, still 40 chars
    SHA.slice(0, 39) + "g", // not hex
    "", // present, empty
    "   ",
    "main", // a branch name is not an identifier
    12345, // a var that arrived as a number
    { sha: SHA }, // or an object
  ];
  for (const stamp of bad) {
    const env = { CODE_COMMIT: stamp };
    const id = codeIdentity(env);
    assert.equal(id.commit, null, JSON.stringify(stamp));
    assert.equal(id.commit_status, "malformed_stamp", JSON.stringify(stamp));
    const served = JSON.stringify([codeIdentity(env), answeredBy(codeIdentity(env)), codeBlock(env)]);
    if (typeof stamp === "string" && stamp.trim().length > 0) assert.ok(!served.includes(stamp.trim()), `the malformed value must not be served: ${JSON.stringify(stamp)}`);
  }
});

test("T1 identity: the pattern is the exact one the brief names (anchored, lower-case hex, 40 chars; no trim anywhere)", () => {
  assert.equal(COMMIT_PATTERN.source, "^[0-9a-f]{40}$");
  assert.equal(COMMIT_PATTERN.flags, "", "no m flag: with it, a stamp whose second line is a valid sha would pass");
  assert.equal(codeIdentity({ CODE_COMMIT: `${"a".repeat(40)}\n${SHA}` }).commit_status, "malformed_stamp");
});

test("T2 version: a present binding serves its id and upload timestamp", () => {
  const id = codeIdentity({ CF_VERSION_METADATA: VERSION });
  assert.equal(id.version_id, VERSION.id);
  assert.equal(id.version_timestamp, VERSION.timestamp);
  assert.equal(id.version_status, "available");
});

test("T2 version: an absent binding is unavailable with null id and timestamp, never a default", () => {
  for (const env of [{}, { CF_VERSION_METADATA: undefined }, { CF_VERSION_METADATA: null }]) {
    const id = codeIdentity(env);
    assert.equal(id.version_id, null);
    assert.equal(id.version_timestamp, null);
    assert.equal(id.version_status, "unavailable");
  }
});

test("T2 version: a binding that carries no usable id is unavailable (and a non-string timestamp is null, not served)", () => {
  for (const meta of [{}, { id: "" }, { id: 7, timestamp: "x" }, "not-an-object", 5]) {
    const id = codeIdentity({ CF_VERSION_METADATA: meta });
    assert.equal(id.version_id, null, JSON.stringify(meta));
    assert.equal(id.version_timestamp, null, JSON.stringify(meta));
    assert.equal(id.version_status, "unavailable", JSON.stringify(meta));
  }
  const noStamp = codeIdentity({ CF_VERSION_METADATA: { id: VERSION.id, timestamp: 12 } });
  assert.equal(noStamp.version_id, VERSION.id);
  assert.equal(noStamp.version_timestamp, null);
});

test("the two facts are independent: a commit with no binding, and a binding with no commit", () => {
  const a = codeIdentity({ CODE_COMMIT: SHA });
  assert.deepEqual([a.commit_status, a.version_status], ["stamped", "unavailable"]);
  const b = codeIdentity({ CF_VERSION_METADATA: VERSION });
  assert.deepEqual([b.commit_status, b.version_status], ["not_stamped", "available"]);
});

test("answeredBy is the narrow block: commit, commit_status, version_id, version_status (A9) and the pinned note, and nothing else", () => {
  const ab = answeredBy(codeIdentity({ CODE_COMMIT: SHA, CF_VERSION_METADATA: VERSION }));
  assert.deepEqual(ab, { commit: SHA, commit_status: "stamped", version_id: VERSION.id, version_status: "available", note: ANSWERED_BY_NOTE });
  assert.deepEqual(Object.keys(ab), ["commit", "commit_status", "version_id", "version_status", "note"], "version_status follows version_id; the note stays last");
  const none = answeredBy(codeIdentity({}));
  assert.deepEqual([none.version_id, none.version_status], [null, "unavailable"], "a missing binding is told apart from an id");
  assert.equal(answeredBy(codeIdentity({ CF_VERSION_METADATA: { id: "", timestamp: "t" } })).version_status, "unavailable", "an empty id is not an id");
});

test("codeBlock is the identity plus a provenance that labels the commit a commonhold_statement and the version id a platform_record", () => {
  const b = codeBlock({ CODE_COMMIT: SHA, CF_VERSION_METADATA: VERSION });
  assert.deepEqual(b.provenance.commit.source, ["commonhold_statement"]);
  assert.deepEqual(b.provenance.version_id.source, ["platform_record"]);
  assert.match(b.provenance.commit.check, /Nothing served here proves the running bytes were built from it/);
  assert.match(b.provenance.version_id.check, /names no source/);
  assert.equal(b.commit, SHA);
});
